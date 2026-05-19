# AuthZ Platform — Dynamic 5-Layer Design

> **Context:** Thiết kế nền tảng phân quyền động cho enterprise system, áp dụng cho PDMS (Physical Document Management System) tại VPBank và mọi bài toán doanh nghiệp quy mô lớn. Toàn bộ policy, role, permission, field/row filter, relation tuple đều cấu hình xuống database — không hardcode logic trong code.

---

## Tổng quan 5 lớp phân quyền

| Layer | Câu hỏi | Cơ chế |
|-------|---------|--------|
| A — Identity | Mày là ai? Token hợp lệ không? | JWT / OAuth2 / OIDC / mTLS |
| B — RBAC | Role của mày có permission gì? | Hierarchical role → permission |
| C — Resource | Mày có quyền trên object cụ thể này không? | Type-level policy + Instance ACL |
| D — ABAC + ReBAC | Context + quan hệ có cho phép không? | JSON AST eval + graph traversal |
| E — Data filter | Response trả về field/row nào? | Field masking + Row filter (multi-backend) |

> **Rule:** Layer A–B xử lý ở Gateway (Keycloak + Spring Cloud Gateway). Layer C–D delegate sang `pdms-iam-service` (control plane) hoặc local sidecar (data plane). Layer E xử lý ở service layer + PostgreSQL RLS.

---

## Data Model — Full Schema

### Layer A — Identity & Multi-tenancy

```sql
CREATE TABLE tenant (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code    VARCHAR(50)  UNIQUE NOT NULL,
    name    VARCHAR(200) NOT NULL,
    config  JSONB        DEFAULT '{}'
);

CREATE TABLE user_account (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID         NOT NULL REFERENCES tenant(id),
    username            VARCHAR(100) NOT NULL,
    external_id         VARCHAR(200),              -- Keycloak subject
    attributes          JSONB        DEFAULT '{}', -- {"branch_code":"HN01","level":3}
    attributes_version  BIGINT       DEFAULT 0,    -- monotonic version, tăng mỗi lần sync
    is_active           BOOLEAN      DEFAULT true,
    UNIQUE(tenant_id, username)
);

-- Audit trail cho mọi thay đổi attribute — dùng cho G2 (out-of-sync)
CREATE TABLE user_attribute_history (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID         NOT NULL REFERENCES user_account(id),
    attribute    VARCHAR(100) NOT NULL,
    old_value    TEXT,
    new_value    TEXT,
    changed_at   TIMESTAMPTZ  DEFAULT now(),
    changed_by   UUID                             -- admin hoặc system sync job
);
CREATE INDEX idx_attr_history_user ON user_attribute_history(user_id, changed_at DESC);
```

`user_account.attributes_version` là monotonic counter — tăng mỗi khi sync từ Keycloak. Cache key mang version này → stale cache bị reject ngay mà không cần TTL dài.

---

### Layer B — Role & Permission (hierarchical)

```sql
CREATE TABLE role (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID         NOT NULL REFERENCES tenant(id),
    code           VARCHAR(100) NOT NULL,
    name           VARCHAR(200) NOT NULL,
    parent_role_id UUID REFERENCES role(id),   -- self-reference: role hierarchy
    priority       INT          DEFAULT 0,
    UNIQUE(tenant_id, code)
);

CREATE TABLE permission (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID         NOT NULL REFERENCES tenant(id),
    code          VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100) NOT NULL,        -- 'document', 'contract', 'cif'
    action        VARCHAR(50)  NOT NULL,        -- 'read', 'write', 'approve', 'archive'
    scope         VARCHAR(50)  NOT NULL,        -- 'own', 'branch', 'all'
    UNIQUE(tenant_id, code)
);

CREATE TABLE role_permission (
    role_id       UUID NOT NULL REFERENCES role(id),
    permission_id UUID NOT NULL REFERENCES permission(id),
    conditions    JSONB DEFAULT NULL,            -- optional extra ABAC conditions
    PRIMARY KEY(role_id, permission_id)
);

CREATE TABLE user_role (
    user_id           UUID        NOT NULL REFERENCES user_account(id),
    role_id           UUID        NOT NULL REFERENCES role(id),
    resource_scope_id UUID REFERENCES resource_instance(id), -- scoped role (instance-level)
    expires_at        TIMESTAMPTZ DEFAULT NULL,               -- temporary permission
    PRIMARY KEY(user_id, role_id)
);
```

**Design decisions:**
- `role.parent_role_id` self-reference → role hierarchy. Engine traverse lên cây khi evaluate bằng `WITH RECURSIVE`.
- `permission.scope`: `own` = chỉ resource mình tạo, `branch` = cả branch, `all` = toàn hệ thống.
- `user_role.resource_scope_id`: gán role scoped theo resource instance cụ thể — VD: user A là `REVIEWER` chỉ trên contract batch `#456`.
- `user_role.expires_at`: temporary permission, tự hết hạn không cần cleanup job.

---

### Layer C — Resource Registry (G1: Type-level vs Instance-level)

**Nguyên tắc phân loại:** 90% use case dùng type-level policy (policy áp dụng cho cả loại resource, không cần lưu instance). Chỉ dùng instance-level cho các object đặc biệt cần ACL riêng ngoài luồng thường.

```sql
-- Type-level: mô tả cấu trúc và actions hợp lệ của một loại resource
CREATE TABLE resource_type (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID         NOT NULL REFERENCES tenant(id),
    code       VARCHAR(100) NOT NULL,
    name       VARCHAR(200) NOT NULL,
    schema_def JSONB        NOT NULL,   -- {"attributes":["branch_code","status"],"actions":["read","approve"]}
    UNIQUE(tenant_id, code)
);

-- Instance-level: CHỈ tạo khi resource cần ACL đặc biệt ngoài type-level policy
-- Với PDMS 100M records: KHÔNG lưu mọi document — chỉ lưu ~1% có ACL đặc biệt
CREATE TABLE resource_instance (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_type_id UUID NOT NULL REFERENCES resource_type(id),
    external_ref     VARCHAR(300),              -- ID trong domain service
    owner_id         UUID REFERENCES user_account(id),
    attributes       JSONB DEFAULT '{}',
    created_at       TIMESTAMPTZ DEFAULT now()
);

-- ACL cho instance cụ thể — chỉ tồn tại khi có instance
CREATE TABLE resource_acl (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_instance_id UUID        NOT NULL REFERENCES resource_instance(id),
    subject_id           UUID        NOT NULL,
    subject_type         VARCHAR(20) NOT NULL,  -- 'USER', 'ROLE', 'GROUP'
    actions              VARCHAR(50)[] NOT NULL,
    conditions           JSONB DEFAULT NULL
);

CREATE INDEX idx_acl_instance ON resource_acl(resource_instance_id, subject_type, subject_id);
```

Evaluation order: **Type-level policy (row_filter + ABAC) → Instance ACL override**. Instance ACL chỉ được check nếu resource có `external_ref` tồn tại trong `resource_instance`. Điều này tránh full scan 100M rows.

---

### Layer D — Policy Engine: ABAC + ReBAC (G3: Relationship-based)

#### ABAC — JSON AST Policy

```sql
CREATE TABLE policy (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID         NOT NULL REFERENCES tenant(id),
    name      VARCHAR(200) NOT NULL,
    effect    VARCHAR(10)  NOT NULL CHECK (effect IN ('ALLOW', 'DENY')),
    priority  INT          NOT NULL DEFAULT 0,   -- DENY higher priority → deny-override
    is_active BOOLEAN      DEFAULT true
);

CREATE TABLE policy_rule (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id      UUID         NOT NULL REFERENCES policy(id),
    subject_type   VARCHAR(50)  NOT NULL,        -- 'ROLE', 'USER', 'GROUP'
    resource_type  VARCHAR(100) NOT NULL,
    action         VARCHAR(50)  NOT NULL,
    condition_expr JSONB        NOT NULL          -- JSON AST
);
```

**`condition_expr` — JSON AST format:**

```json
{
  "operator": "AND",
  "conditions": [
    {
      "left":  { "type": "user_attr",    "key": "branch_code" },
      "op":    "eq",
      "right": { "type": "resource_col", "key": "branch_code" }
    },
    {
      "left":  { "type": "resource_col", "key": "status" },
      "op":    "in",
      "right": { "type": "literal",      "value": ["PENDING", "DRAFT"] }
    },
    {
      "left":  { "type": "relation",     "key": "delegate_of", "target": "resource.owner_id" },
      "op":    "exists"
    }
  ]
}
```

Allowed node types: `user_attr`, `resource_col`, `literal`, `env` (`now()`, `current_date`, `request_ip`), `relation` (trigger ReBAC graph check — xem bên dưới).
Allowed operators: `eq`, `neq`, `in`, `not_in`, `gte`, `lte`, `like`, `is_null`, `exists` (dùng với `relation` node).

#### ReBAC — Relation Tuple (G3: Zanzibar-style)

```sql
-- Bảng quan hệ bộ ba: (subject) --[relation]--> (object)
CREATE TABLE relation_tuple (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID         NOT NULL REFERENCES tenant(id),
    subject    VARCHAR(300) NOT NULL,  -- 'user:uuid-A', 'group:uuid-G'
    relation   VARCHAR(100) NOT NULL,  -- 'delegate_of', 'member_of', 'owner_of', 'reviewer_of'
    object     VARCHAR(300) NOT NULL,  -- 'user:uuid-B', 'branch:HN01', 'contract:uuid-C'
    created_at TIMESTAMPTZ  DEFAULT now(),
    expires_at TIMESTAMPTZ  DEFAULT NULL
);

-- Index cho graph traversal cả chiều forward và backward
CREATE INDEX idx_tuple_subject ON relation_tuple(tenant_id, subject, relation);
CREATE INDEX idx_tuple_object  ON relation_tuple(tenant_id, object,  relation);
CREATE INDEX idx_tuple_active  ON relation_tuple(tenant_id, subject, relation, object)
    WHERE expires_at IS NULL OR expires_at > NOW();
```

Ví dụ PDMS — ủy quyền 3 cấp:

```
(user:A) --[delegate_of]--> (user:B)   -- A ủy quyền cho B
(user:B) --[delegate_of]--> (user:C)   -- B ủy quyền cho C
(user:B) --[reviewer_of]--> (contract:456)
```

Graph traversal query — tìm tất cả subject có quan hệ `delegate_of` đến user X (bắc cầu):

```sql
WITH RECURSIVE delegate_chain AS (
    -- Base: các user trực tiếp ủy quyền cho X
    SELECT subject FROM relation_tuple
    WHERE tenant_id = :tenantId
      AND relation  = 'delegate_of'
      AND object    = 'user:' || :targetUserId
      AND (expires_at IS NULL OR expires_at > NOW())
    UNION
    -- Recursive: đi ngược chuỗi ủy quyền
    SELECT rt.subject FROM relation_tuple rt
    JOIN delegate_chain dc ON rt.object = dc.subject
    WHERE rt.tenant_id = :tenantId
      AND rt.relation  = 'delegate_of'
      AND (rt.expires_at IS NULL OR rt.expires_at > NOW())
)
SELECT subject FROM delegate_chain;
```

**Khi nào dùng ABAC vs ReBAC:**
- ABAC: quyền dựa trên attribute phẳng — `user.branch_code == resource.branch_code`. 90% use case.
- ReBAC: quyền dựa trên quan hệ bắc cầu — "người được ủy quyền của chủ hợp đồng", "thành viên của nhóm reviewer". Dùng khi ABAC phải denormalize quan hệ thành attribute → không scale.

Trong `condition_expr`, node `{ "type": "relation", "key": "delegate_of", "target": "resource.owner_id" }` trigger engine gọi graph traversal thay vì flat attribute comparison.

---

### Layer E — Data Filter (field & row, multi-backend)

#### G5: Backend-agnostic AST → Multi-backend translator

```sql
CREATE TABLE field_filter (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    permission_id  UUID         NOT NULL REFERENCES permission(id),
    resource_type  VARCHAR(100) NOT NULL,
    allowed_fields VARCHAR(100)[],   -- whitelist fields được trả về
    masked_fields  VARCHAR(100)[],   -- fields bị mask, không block
    mask_pattern   VARCHAR(50)       -- '****', '***-***-####'
);

CREATE TABLE row_filter (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    permission_id UUID         NOT NULL REFERENCES permission(id),
    resource_type VARCHAR(100) NOT NULL,
    filter_expr   JSONB        NOT NULL,  -- backend-agnostic AST
    -- Escape hatch per backend (DBA-defined, trusted, chỉ dùng khi AST không đủ)
    sql_fragment  TEXT,
    es_fragment   JSONB,                  -- Elasticsearch raw filter
    mongo_fragment JSONB,                 -- MongoDB raw $match
    priority      INT     DEFAULT 0,
    is_active     BOOLEAN DEFAULT true
);

CREATE INDEX idx_row_filter_permission ON row_filter(permission_id, resource_type)
    WHERE is_active = true;
```

**Backend-agnostic IR (Intermediate Representation):**

AST hiện tại được redesign với node `resource_field` thay vì `resource_col` để không bind với SQL column:

```json
{
  "operator": "AND",
  "conditions": [
    {
      "left":  { "type": "user_attr",     "key": "branch_code" },
      "op":    "eq",
      "right": { "type": "resource_field","key": "branchCode" }
    },
    {
      "left":  { "type": "resource_field","key": "status" },
      "op":    "in",
      "right": { "type": "literal",       "value": ["ACTIVE","PENDING"] }
    }
  ]
}
```

`resource_field` map sang tên field trong từng backend qua `resource_type.schema_def`:

```json
{
  "field_mappings": {
    "branchCode": { "sql": "branch_code", "es": "branch_code", "mongo": "branchCode" },
    "status":     { "sql": "status",      "es": "status",      "mongo": "status" }
  }
}
```

Multi-backend translator:

```java
public interface FilterTranslator<T> {
    T translate(JsonNode ast, AuthzContext ctx, ResourceType resourceType);
}

// SQL translator → WHERE clause string + params
@Component("sql")
public class SqlFilterTranslator implements FilterTranslator<FilterResult> { ... }

// Elasticsearch translator → Map<String,Object> ES filter DSL
@Component("elasticsearch")
public class EsFilterTranslator implements FilterTranslator<Map<String, Object>> {
    @Override
    public Map<String, Object> translate(JsonNode ast, AuthzContext ctx, ResourceType rt) {
        return switch (ast.get("operator").asText("")) {
            case "AND" -> Map.of("bool", Map.of("must",
                StreamSupport.stream(ast.get("conditions").spliterator(), false)
                    .map(c -> translate(c, ctx, rt)).toList()));
            case "OR"  -> Map.of("bool", Map.of("should",
                StreamSupport.stream(ast.get("conditions").spliterator(), false)
                    .map(c -> translate(c, ctx, rt)).toList()));
            default    -> translateLeaf(ast, ctx, rt);
        };
    }
    private Map<String, Object> translateLeaf(JsonNode node, AuthzContext ctx, ResourceType rt) {
        String field = rt.mapField(node.get("left").get("key").asText(), "es");
        Object value = resolveValue(node.get("right"), ctx);
        return switch (node.get("op").asText()) {
            case "eq"   -> Map.of("term",  Map.of(field, value));
            case "in"   -> Map.of("terms", Map.of(field, value));
            case "gte"  -> Map.of("range", Map.of(field, Map.of("gte", value)));
            case "lte"  -> Map.of("range", Map.of(field, Map.of("lte", value)));
            case "like" -> Map.of("wildcard", Map.of(field, value));
            default     -> throw new IllegalArgumentException("Unsupported op for ES: " + node.get("op").asText());
        };
    }
}

// MongoDB translator → Document $match expression
@Component("mongodb")
public class MongoFilterTranslator implements FilterTranslator<Document> { ... }
```

Một policy duy nhất được áp dụng đồng nhất trên PostgreSQL, Elasticsearch, và MongoDB — không viết filter logic riêng cho từng backend.

---

### Audit & Decision Log

```sql
CREATE TABLE authz_decision_log (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID         NOT NULL,
    user_id           UUID         NOT NULL,
    resource_type     VARCHAR(100) NOT NULL,
    resource_ref      VARCHAR(300),
    action            VARCHAR(50)  NOT NULL,
    decision          VARCHAR(10)  NOT NULL CHECK (decision IN ('ALLOW', 'DENY')),
    matched_policy_id UUID REFERENCES policy(id),
    policy_version_id UUID REFERENCES policy_version(id), -- G6: link to version
    eval_trace        JSONB        NOT NULL,   -- AST node-by-node trace (G7)
    context           JSONB        NOT NULL,   -- snapshot: user attrs + resource attrs
    decided_at        TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX idx_authz_log_user     ON authz_decision_log(user_id, decided_at DESC);
CREATE INDEX idx_authz_log_resource ON authz_decision_log(resource_type, resource_ref, decided_at DESC);
CREATE INDEX idx_authz_log_diverged ON authz_decision_log(policy_version_id, decided_at DESC)
    WHERE eval_trace->>'shadow_diverged' = 'true';  -- nhanh chóng tìm diverged cases
```

`eval_trace` lưu kết quả từng node trong AST khi evaluate — xem G7 để biết format.

---

## G2 — Attribute Out-of-Sync: Keycloak Event Sync

**Vấn đề:** User chuyển branch → Keycloak cập nhật ngay nhưng `user_account.attributes` trong IAM DB + Redis cache vẫn còn giá trị cũ. Với banking, đây là security risk — user vẫn thấy data của branch cũ trong suốt TTL.

**Giải pháp: Push-based sync với version vector**

Keycloak Event Listener → Kafka topic `iam.user.attribute.changed` → IAM service update `user_account` + invalidate cache ngay:

```java
// Keycloak SPI: EventListenerProvider
public class KeycloakAttributeSyncListener implements EventListenerProvider {

    @Override
    public void onEvent(AdminEvent event, boolean includeRepresentation) {
        if (event.getResourceType() == ResourceType.USER
                && (event.getOperationType() == OperationType.UPDATE
                    || event.getOperationType() == OperationType.ACTION)) {
            kafkaProducer.send("iam.user.attribute.changed", UserAttributeChangedEvent.from(event));
        }
    }
}

// IAM service Kafka consumer
@KafkaListener(topics = "iam.user.attribute.changed")
@Transactional
public void onAttributeChanged(UserAttributeChangedEvent event) {
    userAccountRepo.updateAttributes(
        event.getUserId(),
        event.getNewAttributes(),
        event.getVersion()              // Keycloak entity version — optimistic lock
    );
    // Ghi audit trail
    attributeHistoryRepo.save(UserAttributeHistory.of(event));
    // Invalidate ngay — không đợi TTL
    invalidateUserCache(event.getUserId());
}
```

```sql
-- Optimistic lock: chỉ update nếu version mới hơn version hiện tại
UPDATE user_account
SET attributes         = :newAttributes,
    attributes_version = :newVersion
WHERE id                  = :userId
  AND attributes_version  < :newVersion;  -- idempotent, ignore stale events
```

Cache key mang `attributes_version`: `authz:ctx:{userId}:{version}`. Khi service nhận token JWT, extract `attr_version` claim → lookup cache với version đó → miss nếu version cũ → reload từ DB. Không cần global invalidate, chỉ cần version mismatch là đủ.

---

## G4 — Centralized Bottleneck: Control Plane / Data Plane Split

**Vấn đề:** Mọi AuthZ check gọi về IAM service → network latency + single point of failure.

**Giải pháp: Control Plane / Data Plane tách biệt**

```
┌─────────────────────────────────────┐
│  IAM Service (Control Plane)        │
│  - Quản lý policy, role, permission │
│  - Expose Policy Bundle API         │
│  - Nhận policy change events        │
└────────────────┬────────────────────┘
                 │ Push policy bundle (Kafka / gRPC stream)
    ┌────────────┴──────────┬───────────────────┐
    ▼                       ▼                   ▼
┌──────────┐         ┌──────────┐         ┌──────────┐
│ pdms-svc │         │ tsdb-svc │         │ proc-svc │
│ sidecar  │         │ sidecar  │         │ sidecar  │
│ (local)  │         │ (local)  │         │ (local)  │
└──────────┘         └──────────┘         └──────────┘
```

**Policy Bundle — được sync xuống local:**

```java
@Component
public class LocalPolicyEngine {

    // In-memory store — được refresh khi nhận push từ control plane
    private volatile PolicyBundle bundle;
    private volatile long bundleVersion;

    @KafkaListener(topics = "iam.policy.bundle.updated")
    public void onBundleUpdate(PolicyBundleEvent event) {
        if (event.getVersion() <= this.bundleVersion) return;  // idempotent
        this.bundle = event.getBundle();
        this.bundleVersion = event.getVersion();
        log.info("Policy bundle updated to version {}", event.getVersion());
    }

    // AuthZ check: in-memory, 0ms network latency
    public AuthzDecision evaluate(AuthzRequest req) {
        if (bundle == null) return fallback(req);   // xem Emergency Revoke
        return bundle.evaluate(req);
    }
}
```

**Emergency Revoke — consistency window:**

Vấn đề: khi admin revoke quyền user khẩn cấp (VD: phát hiện tài khoản bị compromise), sidecar vẫn có policy cũ trong consistency window (thời gian push đến khi nhận).

Giải pháp: **short-circuit revoke list** — IAM service maintain một Redis Set chứa các `userId` bị revoke khẩn cấp. Sidecar check list này trước khi dùng local bundle:

```java
public AuthzDecision evaluate(AuthzRequest req) {
    // Check emergency revoke list trước — O(1) Redis lookup
    if (emergencyRevokeCache.isRevoked(req.getUserId())) {
        return AuthzDecision.DENY_EMERGENCY;
    }
    if (bundle == null) return fallback(req);
    return bundle.evaluate(req);
}
```

```java
// IAM service — khi admin revoke khẩn cấp
public void emergencyRevoke(UUID userId) {
    redisTemplate.opsForSet().add("authz:revoked", userId.toString());
    redisTemplate.expire("authz:revoked", 24, HOURS);
    // Đồng thời push bundle update — revoke list chỉ là safety net trong window
    kafkaProducer.send("iam.policy.bundle.updated", buildBundle());
}
```

**Fallback khi sidecar mất kết nối với control plane:**

```java
private AuthzDecision fallback(AuthzRequest req) {
    // Fail-open vs fail-closed — cấu hình per tenant
    String mode = tenantConfig.getFailMode(req.getTenantId());
    return switch (mode) {
        case "CLOSED" -> AuthzDecision.DENY;    // banking: deny khi không chắc
        case "OPEN"   -> AuthzDecision.ALLOW;   // internal tool: allow khi không chắc
        default       -> AuthzDecision.DENY;
    };
}
```

---

## G6 — Policy Versioning & Shadow Mode

**Vấn đề:** Deploy policy mới trong banking cần kiểm chứng tác động trước khi áp dụng thật.

### Schema

```sql
-- Snapshot đầy đủ của policy tại thời điểm publish
CREATE TABLE policy_version (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id     UUID         NOT NULL REFERENCES policy(id),
    version_num   INT          NOT NULL,
    snapshot      JSONB        NOT NULL,   -- full policy + all rules tại thời điểm publish
    status        VARCHAR(20)  NOT NULL CHECK (status IN ('DRAFT','SHADOW','ACTIVE','ARCHIVED')),
    published_by  UUID,
    published_at  TIMESTAMPTZ,
    notes         TEXT,
    UNIQUE(policy_id, version_num)
);

-- Shadow mode: ghi lại divergence giữa policy đang active và policy đang shadow
CREATE TABLE policy_shadow_log (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_version_id UUID         NOT NULL REFERENCES policy_version(id),
    user_id           UUID,
    resource_ref      VARCHAR(300),
    action            VARCHAR(50),
    shadow_decision   VARCHAR(10)  NOT NULL,   -- ALLOW/DENY theo policy SHADOW
    active_decision   VARCHAR(10)  NOT NULL,   -- ALLOW/DENY theo policy ACTIVE
    diverged          BOOLEAN GENERATED ALWAYS AS (shadow_decision != active_decision) STORED,
    context_snapshot  JSONB,                   -- để replay và debug
    logged_at         TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX idx_shadow_diverged  ON policy_shadow_log(policy_version_id, diverged, logged_at DESC);
CREATE INDEX idx_shadow_version   ON policy_shadow_log(policy_version_id, logged_at DESC);
```

### Lifecycle: Draft → Shadow → Active → Archived

```
DRAFT ──publish──> SHADOW ──(review divergence)──> ACTIVE ──(superseded)──> ARCHIVED
         (song song với ACTIVE)       (rollback nếu divergence cao)
```

### Shadow mode evaluation

```java
@Service
public class PolicyVersionEngine {

    public AuthzDecision evaluate(AuthzRequest req) {
        PolicyVersion active = policyVersionRepo.findActive(req.getTenantId(), req.getResourceType());
        AuthzDecision decision = evaluateVersion(active, req);

        // Evaluate shadow policy song song (async, không ảnh hưởng latency)
        policyVersionRepo.findShadow(req.getTenantId(), req.getResourceType())
            .ifPresent(shadow -> CompletableFuture.runAsync(() -> {
                AuthzDecision shadowDecision = evaluateVersion(shadow, req);
                if (shadowDecision != decision) {
                    shadowLogRepo.save(PolicyShadowLog.builder()
                        .policyVersionId(shadow.getId())
                        .userId(req.getUserId())
                        .resourceRef(req.getResourceRef())
                        .action(req.getAction())
                        .shadowDecision(shadowDecision.name())
                        .activeDecision(decision.name())
                        .contextSnapshot(req.toJson())
                        .build());
                }
            }));

        return decision;
    }
}
```

**Divergence report** — trước khi promote SHADOW → ACTIVE:

```sql
SELECT
    COUNT(*) FILTER (WHERE diverged)                                  AS diverged_count,
    COUNT(*)                                                          AS total_count,
    ROUND(100.0 * COUNT(*) FILTER (WHERE diverged) / COUNT(*), 2)    AS diverge_pct,
    COUNT(*) FILTER (WHERE shadow_decision='DENY' AND active_decision='ALLOW') AS new_denials,
    COUNT(*) FILTER (WHERE shadow_decision='ALLOW' AND active_decision='DENY') AS new_allows
FROM policy_shadow_log
WHERE policy_version_id = :shadowVersionId
  AND logged_at > NOW() - INTERVAL '7 days';
```

Nếu `diverge_pct` > ngưỡng cho phép (VD: 5%) → block promote, yêu cầu review.

---

## G7 — Policy Debugger: Explain & Trace API

**Vấn đề:** Khi user bị DENY, cần biết chính xác node nào trong AST đã fail.

### AST Eval Trace format

`authz_decision_log.eval_trace` lưu kết quả từng node:

```json
{
  "decision": "DENY",
  "matched_policy": "branch-isolation-v2",
  "shadow_diverged": false,
  "trace": [
    {
      "node": "AND",
      "result": false,
      "children": [
        {
          "node": "user_attr[branch_code] eq resource_field[branch_code]",
          "left_value": "HN01",
          "right_value": "HCM01",
          "result": false,
          "reason": "HN01 != HCM01"
        },
        {
          "node": "resource_field[status] in [PENDING, DRAFT]",
          "left_value": "ACTIVE",
          "result": false,
          "reason": "ACTIVE not in allowed set"
        }
      ]
    }
  ]
}
```

### Explain API

```java
// GET /authz/explain?userId={}&resourceRef={}&action={}
@GetMapping("/authz/explain")
public ExplainResponse explain(@RequestParam UUID userId,
                                @RequestParam String resourceRef,
                                @RequestParam String action) {
    // Tìm decision log gần nhất
    AuthzDecisionLog log = decisionLogRepo
        .findLatest(userId, resourceRef, action)
        .orElseThrow(() -> new NotFoundException("No decision found"));

    return ExplainResponse.builder()
        .decision(log.getDecision())
        .decidedAt(log.getDecidedAt())
        .matchedPolicy(log.getMatchedPolicyId())
        .policyVersion(log.getPolicyVersionId())
        .trace(log.getEvalTrace())               // full AST trace
        .userAttributeSnapshot(log.getContext().get("user"))
        .resourceAttributeSnapshot(log.getContext().get("resource"))
        .build();
}

// POST /authz/replay — evaluate lại decision cũ với policy hiện tại
@PostMapping("/authz/replay")
public ReplayResponse replay(@RequestBody ReplayRequest req) {
    AuthzDecisionLog original = decisionLogRepo.findById(req.getDecisionId());
    AuthzContext replayCtx    = AuthzContext.fromSnapshot(original.getContext());
    AuthzDecision newDecision = policyEngine.evaluate(replayCtx);
    return ReplayResponse.builder()
        .originalDecision(original.getDecision())
        .replayDecision(newDecision)
        .changed(original.getDecision() != newDecision.name())
        .build();
}
```

Replay API cho phép trace "nếu policy hiện tại được áp dụng cho request cũ thì kết quả có khác không?" — cực kỳ hữu ích khi audit sau incident.

---

## Row Filter — Evaluation Engine (Spring Boot)

### Expression Evaluator (naive — xem phần Performance để optimize)

```java
@Service
public class RowFilterEvaluator {

    @Autowired private RowFilterRepository rowFilterRepo;

    public FilterResult evaluate(UUID permissionId, String resourceType,
                                  AuthzContext ctx, String backend) {
        List<RowFilter> filters = rowFilterRepo
            .findActiveByPermissionAndResource(permissionId, resourceType);
        if (filters.isEmpty()) return FilterResult.noFilter();

        List<String> predicates = new ArrayList<>();
        Map<String, Object> params = new LinkedHashMap<>();

        for (RowFilter filter : filters) {
            // Escape hatch per backend
            String fragment = switch (backend) {
                case "sql"   -> filter.getSqlFragment();
                case "es"    -> filter.getEsFragment() != null ? filter.getEsFragment().toString() : null;
                case "mongo" -> filter.getMongoFragment() != null ? filter.getMongoFragment().toString() : null;
                default      -> null;
            };
            if (fragment != null) { predicates.add(fragment); continue; }

            // Translate AST per backend
            FilterTranslator<?> translator = translatorRegistry.get(backend);
            predicates.add(translator.translate(filter.getFilterExpr(), ctx, resourceTypeRepo.findByCode(resourceType)).toString());
        }
        return new FilterResult(String.join(" AND ", predicates), params);
    }
}
```

---

## PostgreSQL RLS — Safety Net Layer

```sql
ALTER TABLE document ENABLE ROW LEVEL SECURITY;
ALTER TABLE document FORCE ROW LEVEL SECURITY;

-- Safety net: branch isolation — rule đơn giản nhất
CREATE POLICY doc_branch_isolation ON document
    AS PERMISSIVE FOR ALL TO pdms_app_role
    USING (
        branch_code = current_setting('app.branch_code', true)
        OR current_setting('app.bypass_rls', true) = 'true'
    );

-- Reviewer access — dùng pre-computed array từ service (G5: tránh correlated subquery)
CREATE POLICY doc_reviewer_access ON document
    FOR SELECT TO pdms_reviewer_role
    USING (
        status = 'PENDING_REVIEW'
        AND id = ANY(
            string_to_array(current_setting('app.reviewable_doc_ids', true), ',')::uuid[]
        )
    );

CREATE INDEX idx_reviewer_assignment_lookup
    ON document_reviewer_assignment(document_id, reviewer_id);
```

```java
// set_config(..., false) = transaction-scoped → safe với HikariCP pool
// KHÔNG dùng true → session leak giữa pooled connections
String query = """
    WITH ctx AS (
        SELECT set_config('app.branch_code',       :branchCode, false),
               set_config('app.user_id',            :userId,     false),
               set_config('app.bypass_rls',         :bypass,     false),
               set_config('app.reviewable_doc_ids', :reviewIds,  false)
    )
    SELECT d.* FROM document d, ctx
    WHERE d.tenant_id = :tenantId AND {rowFilterPredicate}
    """;
```

---

## Performance — 5 điểm nghẽn và cách fix

> **Nguyên tắc:** Business logic không đổi — chỉ thay đổi cách evaluate và cache. Priority: logic đúng trước, optimize sau.

### P1 — Gộp N+1 query thành 1 JOIN duy nhất (High impact)

```sql
SELECT
    p.id              AS permission_id,
    p.action,
    p.scope,
    rf.filter_expr    AS row_filter_expr,
    rf.sql_fragment   AS row_filter_sql,
    ff.allowed_fields,
    ff.masked_fields,
    ff.mask_pattern,
    pr.condition_expr AS policy_condition,
    pol.effect        AS policy_effect,
    pol.priority      AS policy_priority
FROM user_role ur
JOIN LATERAL (
    WITH RECURSIVE role_tree AS (
        SELECT id, parent_role_id FROM role WHERE id = ur.role_id
        UNION ALL
        SELECT r2.id, r2.parent_role_id FROM role r2
        JOIN role_tree rt ON r2.id = rt.parent_role_id
    )
    SELECT id FROM role_tree
) r_hier ON true
JOIN role r ON r.id = r_hier.id
JOIN role_permission rp ON rp.role_id = r.id
JOIN permission p ON p.id = rp.permission_id AND p.resource_type = :resourceType
LEFT JOIN row_filter  rf ON rf.permission_id = p.id AND rf.resource_type = :resourceType AND rf.is_active = true
LEFT JOIN field_filter ff ON ff.permission_id = p.id AND ff.resource_type = :resourceType
LEFT JOIN policy_rule pr ON pr.resource_type = :resourceType AND pr.action = p.action
JOIN policy pol ON pol.id = pr.policy_id AND pol.is_active = true
WHERE ur.user_id = :userId AND ur.tenant_id = :tenantId
  AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
ORDER BY pol.priority DESC;
```

Cache kết quả vào Redis TTL 5 phút với key mang `attributes_version` — stale nếu version không khớp.

---

### P2 — Compiled predicate cache (High impact)

```java
@Component
public class CompiledFilterCache {

    private final Cache<String, CompiledPredicate> cache = Caffeine.newBuilder()
        .maximumSize(10_000).expireAfterWrite(10, MINUTES).recordStats().build();

    public CompiledPredicate getOrCompile(UUID permissionId, String resourceType, JsonNode filterExpr) {
        return cache.get(permissionId + ":" + resourceType, k -> compile(filterExpr));
    }
}

public FilterResult bind(CompiledPredicate compiled, AuthzContext ctx) {
    Map<String, Object> params = new LinkedHashMap<>();
    for (var binding : compiled.bindings()) {
        params.put(binding.placeholder(), switch (binding.source()) {
            case USER_ATTR -> ctx.getUserAttr(binding.key());
            case LITERAL   -> binding.value();
            case ENV_NOW   -> Instant.now();
        });
    }
    return new FilterResult(compiled.sqlTemplate(), params);
}
```

---

### P3 — Piggyback SET + P4 — Redis SMEMBERS index + P5 — EXISTS rewrite

```java
// P3: CTE piggyback — 1 round-trip thay vì 2
String query = "WITH ctx AS (SELECT set_config(...)) SELECT d.* FROM document d, ctx WHERE ...";

// P4: Redis Set làm index — không dùng KEYS pattern scan
redisTemplate.executePipelined(conn -> {
    conn.setEx(cacheKey, 300, data);
    conn.sAdd(indexKey, cacheKey);    // O(1) add
    conn.expire(indexKey, 600);
    return null;
});
// Invalidate: SMEMBERS → DELETE — không block Redis event loop
Set<String> keys = redisTemplate.opsForSet().members(indexKey);
redisTemplate.delete(keys);
```

```sql
-- P5: EXISTS + index thay vì correlated subquery per row
CREATE INDEX idx_reviewer_assignment_lookup ON document_reviewer_assignment(document_id, reviewer_id);
-- Hoặc dùng pre-computed array trong session (xem RLS section)
```

```sql
-- CDC: bắt buộc cho Debezium capture
ALTER TABLE row_filter      REPLICA IDENTITY FULL;
ALTER TABLE policy          REPLICA IDENTITY FULL;
ALTER TABLE role_permission REPLICA IDENTITY FULL;
ALTER TABLE user_account    REPLICA IDENTITY FULL;  -- thêm cho G2 attribute sync
```

---

## Tổng hợp — Gap Resolution Matrix

| Gap | Vấn đề | Giải pháp | Status |
|-----|---------|-----------|--------|
| G1 — Resource explosion | 100M instance rows | Type-level vs Instance-level phân loại; instance chỉ tạo khi cần ACL đặc biệt | ✅ Triệt để |
| G2 — Attribute out-of-sync | Stale cache sau khi đổi branch | Keycloak event → Kafka → push sync + `attributes_version` trong cache key | ✅ Triệt để |
| G3 — ReBAC thiếu | Quan hệ bắc cầu không express được bằng ABAC | `relation_tuple` + recursive graph traversal + `relation` node type trong AST | ✅ Triệt để |
| G4 — Centralized bottleneck | Network latency + SPOF | Control Plane / Data Plane split + emergency revoke list + fail-open/closed config | ✅ Triệt để |
| G5 — Single-backend AST | AST bind với SQL column name | Backend-agnostic IR + field mapping trong `schema_def` + multi-backend translator | ✅ Triệt để |
| G6 — Policy versioning | Không có rollback, không có shadow test | `policy_version` + `policy_shadow_log` + lifecycle DRAFT→SHADOW→ACTIVE→ARCHIVED + divergence report | ✅ Triệt để |
| G7 — Policy debugger | Không trace được tại sao DENY | `eval_trace` JSONB per node + Explain API + Replay API | ✅ Triệt để |

---

## Mapping vào PDMS Architecture

```
Request từ client
    │
    ▼
Spring Cloud Gateway
    ├── Layer A: Keycloak validate JWT (extract attributes_version claim)
    └── Layer B: Check coarse-grained role (RBAC)
    │
    ▼
pdms-service (local sidecar data plane)
    ├── Check emergency revoke list (Redis, O(1))
    ├── Layer C: Resource-level — type-level policy first, instance ACL nếu có
    ├── Layer D: ABAC eval (local bundle) + ReBAC graph traversal nếu relation node
    └── Backend: SQL/ES/Mongo → dùng đúng translator
    │
    ▼
IAM Service (control plane) — chỉ nhận khi local bundle miss/outdated
    ├── Evaluate với policy version active
    ├── Shadow eval song song nếu có version SHADOW
    └── Ghi authz_decision_log với eval_trace
    │
    ▼
PostgreSQL
    ├── Layer E-1: row_filter predicate (SQL translator)
    └── Layer E-2: RLS branch isolation (safety net)
    │
    ▼
pdms-service
    └── Layer E-3: field_filter — strip/mask sensitive fields
```

---

## Related Notes

- [[PDMS-AuthZ-Fine-Grained-Design]]
- [[PDMS-AuthZ-Sync-Strategy-Comparison]]
- [[PDMS-IAM-Multi-Domain-Design]]
- [[Cross-Service-Join-AuthZ-Fine-Grained-Filter]]
- [[Debezium-CDC-Deep-Dive]]

## Tags

#authz #security #pdms #postgresql #rls #spring-boot #microservices #data-model #performance #rebac #abac #policy-versioning

---

## Advanced Edge Cases — Giải pháp Triệt để

> Bốn vấn đề dưới đây không phải "nice to have" — chúng là những điểm gãy thực sự khi hệ thống gặp bài toán doanh nghiệp phức tạp. Mỗi giải pháp được thiết kế để không phá vỡ kiến trúc hiện tại.

---

### EC-1 — Complex Temporal Context (Ngữ cảnh thời gian & môi trường động)

**Vấn đề gốc rễ:** Các điều kiện như "chỉ trong giờ hành chính", "chỉ từ IP nội bộ", "chỉ khi đang trong ca trực" không thể cache được nếu nhúng thẳng vào `condition_expr` — mỗi request có `env.now()` khác nhau, compiled predicate cache (P2) sẽ miss liên tục. Nhưng nếu không xử lý, policy thiếu chiều temporal là lỗ hổng nghiêm trọng với banking.

**Giải pháp: Tách temporal conditions ra khỏi compiled cache path**

Nguyên tắc: phân loại condition thành 2 nhóm với vòng đời cache khác nhau:

| Loại | Ví dụ | Cache strategy |
|------|-------|----------------|
| **Static predicate** | `user.branch_code eq resource.branchCode` | Compile 1 lần, cache đến khi policy thay đổi |
| **Temporal gate** | `env.now gte 09:00 AND env.now lte 17:00` | Evaluate tại runtime, KHÔNG cache, không sinh SQL |

**Schema bổ sung — temporal policy:**

```sql
-- Tách temporal condition ra thành bảng riêng, không nhúng vào filter_expr
CREATE TABLE temporal_policy (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    permission_id   UUID         NOT NULL REFERENCES permission(id),
    name            VARCHAR(200) NOT NULL,
    allowed_days    SMALLINT[]   DEFAULT '{1,2,3,4,5}',  -- 1=Mon..7=Sun (ISO)
    allowed_from    TIME         NOT NULL DEFAULT '08:00',
    allowed_until   TIME         NOT NULL DEFAULT '17:30',
    timezone        VARCHAR(50)  NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    allowed_cidr    INET[]       DEFAULT NULL,            -- NULL = không giới hạn IP
    require_shift   BOOLEAN      DEFAULT false,
    shift_table_ref VARCHAR(300) DEFAULT NULL,            -- 'shift_schedule:user_id'
    is_active       BOOLEAN      DEFAULT true
);

CREATE INDEX idx_temporal_permission ON temporal_policy(permission_id)
    WHERE is_active = true;
```

**Evaluation flow — temporal gate trước, compiled predicate sau:**

```java
@Service
public class AuthzEvaluationPipeline {

    public AuthzDecision evaluate(AuthzRequest req) {
        // Bước 1: Temporal gate — pure in-memory arithmetic, KHÔNG cache
        // Fail → DENY ngay, không đánh giá ABAC/ReBAC
        TemporalCheckResult temporal = temporalEngine.check(
            req.getPermissionId(), req.getEnvContext());
        if (!temporal.isAllowed())
            return AuthzDecision.deny("TEMPORAL_GATE: " + temporal.getReason());

        // Bước 2: Static predicate — dùng compiled cache bình thường
        CompiledPredicate compiled = compiledFilterCache.getOrCompile(
            req.getPermissionId(), req.getResourceType(), req.getFilterExpr());
        FilterResult filter = compiledFilterCache.bind(compiled, req.getAuthzContext());

        // Bước 3: ReBAC graph (nếu AST có relation node)
        if (req.hasRelationNodes()) {
            boolean relationAllowed = reBacEngine.check(req);
            if (!relationAllowed) return AuthzDecision.deny("REBAC_GRAPH");
        }

        return AuthzDecision.allow(filter);
    }
}

@Service
public class TemporalEngine {

    public TemporalCheckResult check(UUID permissionId, EnvContext env) {
        List<TemporalPolicy> policies = temporalPolicyRepo.findActive(permissionId);
        if (policies.isEmpty()) return TemporalCheckResult.allowed();

        for (TemporalPolicy tp : policies) {
            ZonedDateTime now = env.getRequestTime().atZone(ZoneId.of(tp.getTimezone()));
            DayOfWeek day     = now.getDayOfWeek();
            LocalTime  time   = now.toLocalTime();

            if (!tp.getAllowedDays().contains(day.getValue()))
                return TemporalCheckResult.denied("Not allowed on " + day);

            if (time.isBefore(tp.getAllowedFrom()) || time.isAfter(tp.getAllowedUntil()))
                return TemporalCheckResult.denied("Outside working hours: " + time);

            if (tp.getAllowedCidr() != null
                    && !matchesCidr(env.getClientIp(), tp.getAllowedCidr()))
                return TemporalCheckResult.denied("IP not in allowlist: " + env.getClientIp());

            if (tp.isRequireShift()
                    && !hasActiveShift(permissionId, env.getUserId(), now))
                return TemporalCheckResult.denied("No active shift for user");
        }
        return TemporalCheckResult.allowed();
    }
}
```

**Tại sao tách bảng thay vì nhúng vào AST:**
- `temporal_policy` được load và check trước mọi cache operation — không làm ô nhiễm compiled predicate.
- Temporal check là pure in-memory arithmetic — không cần DB round-trip sau lần load đầu (cache local bundle).
- Policy quản lý temporal rule riêng biệt với policy quản lý data filter → SRP rõ ràng.
- Shift-based condition (`require_shift`) check qua JIT Attribute Fetching (xem EC-4).

---

### EC-2 — ReBAC Performance: Cycle Detection & Materialized Graph

**Vấn đề gốc rễ:** `WITH RECURSIVE` trên PostgreSQL có 2 điểm yếu thực tế:
1. **Cycle:** Nếu graph có cycle (`A → B → A`) — query loop vô hạn hoặc timeout.
2. **Deep graph:** Tập đoàn với 1000 công ty con, chain ủy quyền 5 cấp → traverse 5000 nodes per request → DB chết ở high throughput.

**Giải pháp 3 lớp:**

#### Lớp 1 — Cycle detection tại write time

```sql
CREATE OR REPLACE FUNCTION check_relation_cycle()
RETURNS TRIGGER AS $$
DECLARE cycle_exists BOOLEAN;
BEGIN
    -- Nếu insert A → B, kiểm tra B có path nào về A không
    WITH RECURSIVE reachable AS (
        SELECT object AS node FROM relation_tuple
        WHERE tenant_id = NEW.tenant_id
          AND subject   = NEW.object
          AND relation  = NEW.relation
        UNION
        SELECT rt.object FROM relation_tuple rt
        JOIN reachable r ON rt.subject = r.node
        WHERE rt.tenant_id = NEW.tenant_id AND rt.relation = NEW.relation
    )
    SELECT EXISTS (SELECT 1 FROM reachable WHERE node = NEW.subject)
    INTO cycle_exists;

    IF cycle_exists THEN
        RAISE EXCEPTION 'Cycle detected: (%) -[%]-> (%) would create a cycle',
            NEW.subject, NEW.relation, NEW.object;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_relation_cycle
    BEFORE INSERT ON relation_tuple
    FOR EACH ROW EXECUTE FUNCTION check_relation_cycle();
```

#### Lớp 2 — Materialized reachability với incremental update

```sql
-- Pre-computed reachability — maintained bởi CDC trigger
CREATE TABLE relation_reachability (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID         NOT NULL,
    subject     VARCHAR(300) NOT NULL,
    relation    VARCHAR(100) NOT NULL,
    object      VARCHAR(300) NOT NULL,  -- mọi object reachable từ subject
    depth       INT          NOT NULL,  -- số hop
    path        TEXT[]       NOT NULL,  -- ['user:A','user:B','user:C'] để debug
    computed_at TIMESTAMPTZ  DEFAULT now()
);

CREATE UNIQUE INDEX idx_reachability_unique  ON relation_reachability(tenant_id, subject, relation, object);
CREATE INDEX        idx_reachability_lookup  ON relation_reachability(tenant_id, object, relation);
```

```java
// Incremental recompute khi relation_tuple thay đổi
@KafkaListener(topics = "pdms.public.relation_tuple")
public void onRelationTupleChange(RelationTupleCdcEvent event) {
    // Chỉ recompute subgraph bị ảnh hưởng — không recompute toàn bộ
    reachabilityService.recomputeSubgraph(
        event.getTenantId(), event.getRelation(), event.getSubject());
}

// Query: O(1) lookup thay vì O(depth) recursive traversal
public boolean canReach(String tenantId, String subject, String relation, String object) {
    return reachabilityRepo.exists(tenantId, subject, relation, object);
}
```

#### Lớp 3 — Circuit Breaker với depth limit

```java
@Service
public class ReBacEngine {

    private static final int  MAX_DEPTH   = 10;  // đủ cho mọi tổ chức thực tế
    private static final long MAX_TIMEOUT = 50;  // ms

    public boolean check(AuthzRequest req) {
        // Thử lookup materialized table trước — O(1)
        if (reachabilityRepo.exists(req.getTenantId(), req.getSubject(),
                req.getRelation(), req.getObject())) return true;

        // Fallback: live traversal với circuit breaker
        try {
            return withCircuitBreaker(() -> liveTraversal(
                req.getTenantId(), req.getSubject(),
                req.getRelation(), req.getObject(), 0));
        } catch (CircuitBreakerOpenException e) {
            log.warn("ReBAC circuit open for tenant={}", req.getTenantId());
            auditLog.record(req, "REBAC_CIRCUIT_OPEN", "DENY");
            return false;  // fail-closed
        }
    }

    private boolean liveTraversal(String tenantId, String subject,
                                   String relation, String target, int depth) {
        if (depth > MAX_DEPTH) throw new ReBacDepthExceededException(depth);
        List<String> next = relationTupleRepo.findObjects(tenantId, subject, relation);
        if (next.contains(target)) return true;
        return next.stream().anyMatch(n ->
            liveTraversal(tenantId, n, relation, target, depth + 1));
    }
}
```

**Quy tắc vận hành:**
- `MAX_DEPTH = 10` đủ cho mọi tổ chức doanh nghiệp thực tế.
- Khi circuit open → ghi `REBAC_CIRCUIT_OPEN` vào audit log → alert on-call → không để request treo.
- Materialized table cần rebuild full sau khi restore DB từ backup (`authz-cli rebuild-reachability`).

---

### EC-3 — Audit Log Durability trong Data Plane (Sidecar)

**Vấn đề gốc rễ:** Sidecar thực hiện AuthZ cục bộ → quyết định ALLOW/DENY xảy ra in-process → nếu push audit log về IAM Service qua Kafka mà sidecar crash trước khi commit → mất log. Với banking, mất 1 dòng "who denied what" là vi phạm tuân thủ.

**Giải pháp: Local WAL buffer → guaranteed delivery**

Nguyên tắc: ghi log vào local disk-persisted store trước khi return response (đồng bộ), sau đó async relay về IAM — tương tự Outbox Pattern.

```java
@Service
public class DurableAuditLogger {

    // Chronicle Queue: off-heap, persisted to disk, ~1μs write latency, zero GC pressure
    private final ChronicleQueue localWal;
    private final KafkaTemplate<String, AuditEvent> kafkaTemplate;

    /**
     * Ghi ĐỒNG BỘ vào local WAL TRƯỚC KHI return AuthzDecision.
     * Chronicle Queue write ~1μs — không ảnh hưởng latency AuthZ đáng kể.
     */
    public void record(AuthzRequest req, AuthzDecision decision) {
        AuditEvent event = AuditEvent.builder()
            .id(UUID.randomUUID())
            .tenantId(req.getTenantId())
            .userId(req.getUserId())
            .resourceType(req.getResourceType())
            .resourceRef(req.getResourceRef())
            .action(req.getAction())
            .decision(decision.name())
            .evalTrace(decision.getTrace())
            .context(req.toContextSnapshot())
            .decidedAt(Instant.now())
            .sidecardId(System.getenv("POD_NAME"))
            .build();

        // Ghi vào local WAL trước — atomic, không mất khi crash
        try (ExcerptAppender appender = localWal.acquireAppender()) {
            appender.writeDocument(w -> w.getValueOut().object(event));
        }

        // Async forward — best effort, WAL là source of truth
        kafkaTemplate.send("authz.decision.log", event.getId().toString(), event)
            .whenComplete((result, ex) -> {
                if (ex != null)
                    log.warn("Kafka send failed, event {} will be retried from WAL", event.getId());
            });
    }
}
```

**WAL relay agent — chạy song song trong cùng pod:**

```java
@Component
public class WalRelayAgent {

    @Scheduled(fixedDelay = 5_000)
    public void relay() {
        try (ExcerptTailer tailer = localWal.createTailer("iam-relay")) {
            while (tailer.nextIndex()) {
                AuditEvent event = tailer.readDocument(
                    r -> r.getValueIn().object(AuditEvent.class));
                if (event == null) break;

                boolean sent = iamAuditClient.submitWithRetry(event, 3);
                if (sent) tailer.moveToIndex(tailer.index() + 1);
                // Nếu không sent → giữ lại, retry ở lần sau
            }
        }
    }
}
```

**IAM Service — idempotent ingestion:**

```sql
-- Dedup bằng event.id — safe khi WAL relay gửi lại nhiều lần
INSERT INTO authz_decision_log (id, tenant_id, user_id, resource_type,
    resource_ref, action, decision, eval_trace, context, sidecar_id, decided_at)
VALUES (:id, :tenantId, :userId, :resourceType,
    :resourceRef, :action, :decision, :evalTrace, :context, :sidecarId, :decidedAt)
ON CONFLICT (id) DO NOTHING;  -- idempotent: duplicate từ retry bị bỏ qua
```

**Kubernetes preStop hook — flush WAL trước khi terminate:**

```yaml
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c",
        "curl -X POST localhost:8080/actuator/wal-flush && sleep 5"]
```

`/actuator/wal-flush` trigger `WalRelayAgent.relay()` synchronously, block đến khi toàn bộ WAL entries được IAM confirm — sau đó K8s mới terminate pod. Kết hợp `terminationGracePeriodSeconds: 30` để đủ thời gian flush.

---

### EC-4 — JIT Attribute Fetching & Cross-Domain Data Join

**Vấn đề gốc rễ:** Hai bài toán có cùng root cause — AuthZ cần attribute hoặc dữ liệu từ service khác tại evaluation time:

1. **JIT Attribute:** Policy cần `user.shift_status` nhưng attribute này sống ở `shift-service`, không có trong `user_account.attributes`. Pre-replicate tất cả về IAM → coupling cao, schema phình.
2. **Cross-domain join:** "Filter document của những người có cùng level với tôi" — level ở `hr-service`, document ở `pdms-service`. AST translator không thể tự sinh JOIN xuyên service.

**Phân loại và chiến lược xử lý:**

| Loại data | Tần suất thay đổi | Chiến lược |
|-----------|-------------------|------------|
| Shift status, session state | Cao (theo phút) | JIT fetch + cache 30s + circuit breaker |
| Level, department, position | Thấp (theo tuần) | Pre-materialize vào `relation_tuple` qua event |

#### Schema — external attribute source registry

```sql
CREATE TABLE external_attribute_source (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID         NOT NULL REFERENCES tenant(id),
    code            VARCHAR(100) NOT NULL,         -- 'shift_service', 'hr_service'
    base_url        VARCHAR(500) NOT NULL,
    attribute_path  VARCHAR(200) NOT NULL,         -- '/internal/users/{userId}/attributes'
    cacheable       BOOLEAN      DEFAULT true,
    cache_ttl_sec   INT          DEFAULT 30,       -- ngắn: data động
    timeout_ms      INT          DEFAULT 200,      -- phải nhanh: không block AuthZ
    fallback_value  JSONB        DEFAULT NULL,
    UNIQUE(tenant_id, code)
);
```

**AST node type mới — `external_attr`:**

```json
{
  "left":  {
    "type":   "external_attr",
    "source": "shift_service",
    "key":    "current_shift_status"
  },
  "op":    "eq",
  "right": { "type": "literal", "value": "ON_DUTY" }
}
```

**JIT Attribute Fetcher:**

```java
@Service
public class JitAttributeFetcher {

    // 30s cache — đủ giảm tải, đủ ngắn để reflect thực tế
    private final Cache<String, JsonNode> shortCache = Caffeine.newBuilder()
        .maximumSize(50_000).expireAfterWrite(30, SECONDS).build();

    @CircuitBreaker(name = "jit-attr", fallbackMethod = "fetchFallback")
    @TimeLimiter(name = "jit-attr")   // timeout 200ms
    public JsonNode fetch(String sourceCode, UUID userId,
                          String attributeKey, String tenantId) {
        String cacheKey = sourceCode + ":" + userId + ":" + attributeKey;
        return shortCache.get(cacheKey, k -> {
            ExternalAttributeSource src = sourceRegistry.get(tenantId, sourceCode);
            String url = src.getBaseUrl()
                + src.getAttributePath().replace("{userId}", userId.toString());
            return webClient.get().uri(url)
                .header("X-Internal-Token", internalTokenProvider.get())
                .retrieve().bodyToMono(JsonNode.class)
                .map(body -> body.get(attributeKey))
                .block(Duration.ofMillis(src.getTimeoutMs()));
        });
    }

    public JsonNode fetchFallback(String sourceCode, UUID userId, String key,
                                   String tenantId, Throwable ex) {
        ExternalAttributeSource src = sourceRegistry.get(tenantId, sourceCode);
        if (src.getFallbackValue() != null) {
            log.warn("JIT fetch failed for source={}, key={}, using fallback", sourceCode, key);
            return src.getFallbackValue().get(key);
        }
        throw new JitAttributeUnavailableException(sourceCode, key);
    }
}
```

**Cross-domain join — Pre-materialization vào `relation_tuple`:**

```java
// hr-service: khi user thay đổi level → publish event → pre-materialize
@KafkaListener(topics = "hr.user.level.changed")
public void onLevelChanged(UserLevelChangedEvent event) {
    // Xóa quan hệ same_level_as cũ của user này
    relationTupleRepo.deleteBySubjectAndRelation(
        "user:" + event.getUserId(), "same_level_as");

    // Tìm tất cả user cùng level mới → insert relation_tuple 2 chiều
    List<UUID> sameLevel = hrUserRepo.findByLevel(
        event.getTenantId(), event.getNewLevel());
    List<RelationTuple> tuples = sameLevel.stream()
        .filter(uid -> !uid.equals(event.getUserId()))
        .flatMap(uid -> Stream.of(
            RelationTuple.of(event.getTenantId(),
                "user:" + event.getUserId(), "same_level_as", "user:" + uid),
            RelationTuple.of(event.getTenantId(),
                "user:" + uid, "same_level_as", "user:" + event.getUserId())
        )).toList();
    relationTupleRepo.saveAll(tuples);
}
```

Sau đó AST dùng `relation` node bình thường — không cần cross-service call tại evaluation time:

```json
{
  "left":  { "type": "relation", "key": "same_level_as", "target": "resource.created_by_user" },
  "op":    "exists"
}
```

**Quy tắc vận hành:**
- Không bao giờ để AuthZ engine tự HTTP call xuyên service mà không có circuit breaker + timeout cứng.
- Nếu JIT fetch fail và không có fallback → `deny` với lý do `JIT_UNAVAILABLE` — fail-closed.
- Pre-materialization chỉ dùng cho data thay đổi chậm — data thay đổi nhanh dùng JIT.

---

### EC-5 — AuthZ Governance: Policy-as-Code & Schema Standardization

**Vấn đề gốc rễ:** Hai rủi ro kỹ thuật dài hạn mà thuần kỹ thuật không giải quyết:

1. **Escape hatch abuse:** `sql_fragment`, `es_fragment` được thiết kế cho edge case nhưng nếu developer dùng vì "viết SQL dễ hơn viết AST" → policy phân tán về SQL, mất khả năng audit qua AST debugger, mất Universal tính.
2. **Field naming chaos:** `branch_id` vs `branchCode` vs `branch_code` trên các service khác nhau → `schema_def.field_mappings` trở thành đống mapping thủ công không scale.

#### Policy-as-Code: Git → CI/CD → Control Plane

```yaml
# policies/pdms/branch-isolation.yaml — lưu trong Git, review qua PR
apiVersion: authz.enterprise/v1
kind: Policy
metadata:
  name: branch-isolation
  tenant: pdms
  version: "3"
spec:
  effect: ALLOW
  priority: 100
  rules:
    - subjectType: ROLE
      resourceType: document
      action: read
      condition:
        operator: AND
        conditions:
          - left:  { type: user_attr,      key: branchCode }
            op:    eq
            right: { type: resource_field, key: branchCode }
          - left:  { type: resource_field, key: status }
            op:    in
            right: { type: literal, value: [ACTIVE, PENDING_REVIEW] }
  temporalPolicy:
    allowedDays: [1,2,3,4,5]
    allowedFrom: "08:00"
    allowedUntil: "17:30"
    timezone: Asia/Ho_Chi_Minh
```

```yaml
# .github/workflows/policy-deploy.yml
steps:
  - name: Validate policy schema & AST
    run: authz-cli validate policies/**/*.yaml
    # Kiểm tra: không có escape hatch, field names tồn tại trong schema registry

  - name: Deploy to Shadow mode
    run: authz-cli shadow-deploy --policy branch-isolation --duration 24h

  - name: Check divergence threshold
    run: authz-cli check-divergence --policy branch-isolation --max-pct 5
    # Block promote nếu diverge > 5%

  - name: Promote to ACTIVE
    if: steps.divergence.outcome == 'success'
    run: authz-cli promote --policy branch-isolation
```

```java
// Policy validator — chạy trong CI, reject nếu vi phạm
public class PolicyValidator {
    public ValidationResult validate(PolicyYaml policy) {
        // Rule 1: không cho escape hatch trong policy file
        if (containsEscapeHatch(policy))
            return ValidationResult.fail(
                "Policy contains escape hatch — use AST instead. " +
                "If unavoidable, submit PR to row_filter with approval.");

        // Rule 2: tất cả resource_field phải có trong schema registry
        for (var rule : policy.getSpec().getRules()) {
            Set<String> declared = schemaRegistry.getFields(rule.getResourceType());
            Set<String> used     = extractResourceFields(rule.getCondition());
            Set<String> unknown  = Sets.difference(used, declared);
            if (!unknown.isEmpty())
                return ValidationResult.fail(
                    "Unknown fields: " + unknown + " not in schema_field_registry for " + rule.getResourceType());
        }
        return ValidationResult.ok();
    }
}
```

#### Schema Registry — single source of truth cho field naming

```sql
CREATE TABLE schema_field_registry (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID         NOT NULL REFERENCES tenant(id),
    resource_type  VARCHAR(100) NOT NULL,
    canonical_name VARCHAR(100) NOT NULL,  -- tên chuẩn trong AST: 'branchCode'
    sql_name       VARCHAR(100) NOT NULL,  -- PostgreSQL: 'branch_code'
    es_name        VARCHAR(100),           -- Elasticsearch: 'branch_code'
    mongo_name     VARCHAR(100),           -- MongoDB: 'branchCode'
    data_type      VARCHAR(50)  NOT NULL,  -- 'string', 'uuid', 'timestamp', 'enum'
    enum_values    TEXT[]       DEFAULT NULL,
    description    TEXT,
    UNIQUE(tenant_id, resource_type, canonical_name)
);
```

`schema_def.field_mappings` trong `resource_type` được **generate tự động** từ bảng này — không nhập tay. Mỗi service mới onboard phải đăng ký field của mình vào `schema_field_registry` trước khi viết policy.

#### Escape hatch governance — khi nào được phép dùng

Escape hatch không bị xóa — có những edge case hợp lý mà AST chưa model được. Nhưng cần approval workflow:

```sql
-- Mọi escape hatch phải được document và approve
ALTER TABLE row_filter ADD COLUMN escape_hatch_reason      TEXT;
ALTER TABLE row_filter ADD COLUMN escape_hatch_approved_by UUID;
ALTER TABLE row_filter ADD COLUMN escape_hatch_approved_at TIMESTAMPTZ;
ALTER TABLE row_filter ADD COLUMN escape_hatch_ticket_ref  VARCHAR(100);  -- Jira/Linear ref

-- Trigger: block insert escape hatch mà không có approval
CREATE OR REPLACE FUNCTION enforce_escape_hatch_approval()
RETURNS TRIGGER AS $$
BEGIN
    IF (NEW.sql_fragment IS NOT NULL
        OR NEW.es_fragment IS NOT NULL
        OR NEW.mongo_fragment IS NOT NULL)
       AND NEW.escape_hatch_approved_by IS NULL THEN
        RAISE EXCEPTION
            'Escape hatch requires approval: set escape_hatch_approved_by, '
            'escape_hatch_reason, and escape_hatch_ticket_ref';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_escape_hatch_approval
    BEFORE INSERT OR UPDATE ON row_filter
    FOR EACH ROW EXECUTE FUNCTION enforce_escape_hatch_approval();
```

---

## Gap Resolution Matrix — Final (v2)

| Gap | Vấn đề | Giải pháp | Status |
|-----|---------|-----------|--------|
| G1 — Resource explosion | 100M instance rows | Type-level vs Instance-level; instance chỉ tạo khi cần ACL đặc biệt | ✅ |
| G2 — Attribute out-of-sync | Stale cache sau khi đổi branch | Keycloak SPI → Kafka push sync + `attributes_version` trong cache key | ✅ |
| G3 — ReBAC thiếu | Quan hệ bắc cầu không express bằng ABAC | `relation_tuple` + cycle detection trigger + materialized reachability + circuit breaker | ✅ |
| G4 — Centralized bottleneck | Network latency + SPOF | Control Plane / Data Plane split + emergency revoke + fail-open/closed | ✅ |
| G5 — Single-backend AST | AST bind với SQL column | Backend-agnostic IR + `schema_field_registry` + multi-backend translator | ✅ |
| G6 — Policy versioning | Không có rollback, không có shadow | `policy_version` + `policy_shadow_log` + DRAFT→SHADOW→ACTIVE lifecycle + divergence gate | ✅ |
| G7 — Policy debugger | Không trace được tại sao DENY | `eval_trace` per AST node + Explain API + Replay API | ✅ |
| EC-1 — Temporal context | Cache miss liên tục với env.now() | `temporal_policy` bảng riêng + evaluate trước compiled cache, không cache temporal gate | ✅ |
| EC-2 — ReBAC performance | Cycle + deep graph + SQL recursive limit | Cycle detection trigger + `relation_reachability` materialized + circuit breaker depth=10 | ✅ |
| EC-3 — Audit durability | Mất log khi sidecar crash | Local WAL (Chronicle Queue) → async relay → IAM idempotent ingestion + K8s preStop flush | ✅ |
| EC-4 — Cross-domain join | Attribute ở service khác | JIT fetch + 30s cache + circuit breaker (data động); pre-materialize vào `relation_tuple` (data chậm) | ✅ |
| EC-5 — Governance | Escape hatch abuse + field naming chaos | Policy-as-Code GitOps + CI/CD validation + `schema_field_registry` + escape hatch approval trigger | ✅ |

---

## Advanced Edge Cases — Batch 2

> Tiếp nối Batch 1. Các gap dưới đây liên quan đến hiệu năng tài nguyên, đa dạng backend, quản trị vận hành và edge case multi-tenancy cực đoan.

---

### Gap 4 — "Big Node" trong ReBAC Graph: Sub-graph Partitioning & Max Fan-out

**Vấn đề gốc rễ:** Group `ALL_EMPLOYEES` có 20,000 members. Khi insert 1 member mới → trigger recompute materialized graph cho toàn bộ subgraph của node này → 20,000 rows UPDATE trong `relation_reachability` → CDC pipeline bị nghẽn → các downstream consumer (cache invalidation, audit) bị delay hàng chục giây.

Worse case: xóa node `ALL_EMPLOYEES` → cascade delete 20,000 × số relation types rows.

**Giải pháp 3 lớp:**

#### Lớp 1 — Max Fan-out constraint tại write time

```sql
-- Giới hạn số lượng object mà 1 subject có thể có với cùng 1 relation
ALTER TABLE relation_type ADD COLUMN max_fanout INT DEFAULT NULL;  -- NULL = không giới hạn

-- Ví dụ: relation 'member_of' giới hạn 10,000 members per group
INSERT INTO relation_type (tenant_id, relation, max_fanout)
VALUES (:tenantId, 'member_of', 10000);

CREATE OR REPLACE FUNCTION enforce_fanout_limit()
RETURNS TRIGGER AS $$
DECLARE
    current_count INT;
    max_allowed   INT;
BEGIN
    SELECT max_fanout INTO max_allowed
    FROM relation_type
    WHERE tenant_id = NEW.tenant_id AND relation = NEW.relation;

    IF max_allowed IS NOT NULL THEN
        SELECT COUNT(*) INTO current_count
        FROM relation_tuple
        WHERE tenant_id = NEW.tenant_id
          AND subject   = NEW.subject
          AND relation  = NEW.relation;

        IF current_count >= max_allowed THEN
            RAISE EXCEPTION 'Fan-out limit exceeded: subject=% relation=% limit=%',
                NEW.subject, NEW.relation, max_allowed;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_fanout
    BEFORE INSERT ON relation_tuple
    FOR EACH ROW EXECUTE FUNCTION enforce_fanout_limit();
```

#### Lớp 2 — Sub-graph Partitioning: phân rã Big Node thành Virtual Groups

Khi group thực sự cần >10,000 members, thay vì 1 node to, phân rã thành cây node nhỏ:

```
ALL_EMPLOYEES (virtual root)
├── ALL_EMPLOYEES_HN  (max 5,000)
├── ALL_EMPLOYEES_HCM (max 5,000)
└── ALL_EMPLOYEES_DN  (max 5,000)
```

Policy engine traverse cây này thay vì 1 flat node. Mỗi sub-group khi thay đổi chỉ recompute subgraph nhỏ, không ảnh hưởng toàn bộ.

```sql
-- Bảng virtual group hierarchy
CREATE TABLE group_partition (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID         NOT NULL,
    parent_group   VARCHAR(300) NOT NULL,  -- 'group:ALL_EMPLOYEES'
    child_group    VARCHAR(300) NOT NULL,  -- 'group:ALL_EMPLOYEES_HN'
    partition_key  VARCHAR(100),           -- 'branch_code=HN' — để biết rule phân chia
    max_size       INT          NOT NULL DEFAULT 5000
);
```

#### Lớp 3 — Async batch recompute với rate limiting

Khi Big Node thay đổi, không recompute ngay trong CDC consumer thread — đẩy vào async queue với rate limit:

```java
@KafkaListener(topics = "pdms.public.relation_tuple")
public void onRelationTupleChange(RelationTupleCdcEvent event) {
    int fanout = relationTupleRepo.countBySubjectAndRelation(
        event.getTenantId(), event.getSubject(), event.getRelation());

    if (fanout > BIG_NODE_THRESHOLD) {  // VD: 1000
        // Big node → async queue với rate limit, không block CDC thread
        recomputeQueue.enqueue(RecomputeTask.of(event), Priority.LOW);
        log.info("Big node detected subject={} fanout={}, queued async recompute",
            event.getSubject(), fanout);
    } else {
        // Small node → recompute ngay, inline
        reachabilityService.recomputeSubgraph(
            event.getTenantId(), event.getRelation(), event.getSubject());
    }
}

@Component
public class RecomputeWorker {

    // Rate limit: tối đa 100 recompute tasks/giây để không làm chết DB
    private final RateLimiter rateLimiter = RateLimiter.create(100);

    @Scheduled(fixedDelay = 100)
    public void processQueue() {
        while (recomputeQueue.hasNext()) {
            rateLimiter.acquire();
            RecomputeTask task = recomputeQueue.poll();
            reachabilityService.recomputeSubgraph(
                task.getTenantId(), task.getRelation(), task.getSubject());
        }
    }
}
```

**Hệ quả:** CDC pipeline không bao giờ bị nghẽn vì Big Node. Materialized table có thể lag vài giây với Big Node — acceptable vì ReBacEngine luôn có live traversal làm fallback (EC-2 Lớp 3).

---

### Gap 5 — ReBAC in Row Filter cho NoSQL Backend (ES & MongoDB)

**Vấn đề gốc rễ:** SQL translator có thể sinh `EXISTS (SELECT 1 FROM relation_reachability ...)` vào WHERE clause. Elasticsearch và MongoDB không hỗ trợ subquery/JOIN — không thể dịch node `{ "type": "relation", ... }` sang ES DSL hay MongoDB `$match` theo cùng cơ chế.

Hậu quả nếu không xử lý: row filter với relation node sẽ bị bỏ qua hoặc throw error khi backend là ES/Mongo → security hole hoặc service crash.

**Giải pháp: Query-time ID Enrichment — IAM engine pre-fetch IDs trước, inject `terms` filter**

```
AuthZ Request (backend=elasticsearch)
    │
    ▼
IAM Engine detect: filter_expr chứa relation node
    │
    ▼
ReBacEngine.resolveIds(subject, relation, tenantId)
    → query relation_reachability: SELECT object WHERE subject=X AND relation=Y
    → trả về: ['contract:uuid-1', 'contract:uuid-3', 'contract:uuid-7']
    │
    ▼
Extract IDs: ['uuid-1', 'uuid-3', 'uuid-7']
    │
    ▼
Inject vào ES filter: { "terms": { "id": ["uuid-1","uuid-3","uuid-7"] } }
    │
    ▼
Combine với các filter khác (branch, status) bằng bool.must
```

```java
@Component("elasticsearch")
public class EsFilterTranslator implements FilterTranslator<Map<String, Object>> {

    @Autowired private ReBacEngine reBacEngine;

    @Override
    public Map<String, Object> translate(JsonNode ast, AuthzContext ctx, ResourceType rt) {
        if (isRelationNode(ast)) {
            return translateRelationNode(ast, ctx, rt);
        }
        // ... existing translation logic
    }

    private Map<String, Object> translateRelationNode(JsonNode node, AuthzContext ctx, ResourceType rt) {
        String relation   = node.get("left").get("key").asText();
        String targetField = node.get("left").get("target").asText(); // "resource.created_by_user"

        // Pre-fetch: tất cả object mà subject có quan hệ 'relation' với
        List<String> reachableObjects = reBacEngine.resolveObjects(
            ctx.getTenantId(),
            "user:" + ctx.getUserId(),
            relation
        );

        if (reachableObjects.isEmpty()) {
            // Không có quan hệ nào → DENY toàn bộ: dùng match_none
            return Map.of("match_none", Map.of());
        }

        // Extract raw IDs từ "user:uuid-X" → "uuid-X"
        List<String> ids = reachableObjects.stream()
            .map(obj -> obj.substring(obj.lastIndexOf(':') + 1))
            .toList();

        // Giới hạn size để tránh ES terms query quá lớn (ES limit: 65,536 terms)
        if (ids.size() > MAX_TERMS_FILTER_SIZE) {
            log.warn("ReBAC terms filter truncated: {} > {}, consider pre-materialization",
                ids.size(), MAX_TERMS_FILTER_SIZE);
            // Truncate + flag trong eval_trace để audit
            ids = ids.subList(0, MAX_TERMS_FILTER_SIZE);
        }

        // targetField "resource.created_by_user" → ES field name qua schema registry
        String esFieldName = rt.mapField(
            targetField.replace("resource.", ""), "es");

        return Map.of("terms", Map.of(esFieldName, ids));
    }
}
```

**MongoDB translator — tương tự với `$in`:**

```java
@Component("mongodb")
public class MongoFilterTranslator implements FilterTranslator<Document> {

    private Document translateRelationNode(JsonNode node, AuthzContext ctx, ResourceType rt) {
        String relation = node.get("left").get("key").asText();
        List<String> reachableObjects = reBacEngine.resolveObjects(
            ctx.getTenantId(), "user:" + ctx.getUserId(), relation);

        if (reachableObjects.isEmpty())
            return new Document("$expr", new Document("$eq", List.of(1, 0)));  // always false

        List<String> ids = reachableObjects.stream()
            .map(obj -> obj.substring(obj.lastIndexOf(':') + 1))
            .toList();

        String mongoField = rt.mapField(
            node.get("left").get("target").asText().replace("resource.", ""), "mongo");

        return new Document(mongoField, new Document("$in", ids));
    }
}
```

**Cache pre-fetched IDs — tránh call ReBacEngine lặp lại:**

```java
// Cache key: tenantId:userId:relation — TTL ngắn vì relation có thể thay đổi
private final Cache<String, List<String>> resolvedIdsCache = Caffeine.newBuilder()
    .maximumSize(100_000)
    .expireAfterWrite(60, SECONDS)   // 60s: đủ ngắn để phản ánh thay đổi delegation
    .build();

public List<String> resolveObjects(String tenantId, String subject, String relation) {
    String key = tenantId + ":" + subject + ":" + relation;
    return resolvedIdsCache.get(key, k ->
        reachabilityRepo.findAllObjects(tenantId, subject, relation));
}
```

**Giới hạn và trade-off:**
- ES `terms` filter giới hạn 65,536 items — nếu vượt quá → cần pre-materialization (xem Gap 4).
- Đây là lý do MAX_FANOUT phải được enforce ở Gap 4 — Big Node với 20,000 members sẽ sinh 20,000-item terms filter → ES reject.
- Relation thay đổi → resolved IDs cache invalid sau 60s → có consistency window nhỏ. Acceptable với ReBAC vì relation không thay đổi tức thời.

---

### Gap 6 — Policy Conflict Resolution: Explicit Strategy per Resource Type

**Vấn đề gốc rễ:** Khi 2 policy cùng priority, cùng match một request nhưng có effect khác nhau (1 ALLOW, 1 DENY) → behavior hiện tại không xác định (undefined). Trong banking, undefined behavior trong AuthZ là không chấp nhận được.

**Giải pháp: Explicit Conflict Resolution Strategy per resource type**

```sql
-- Thêm conflict_strategy vào resource_type — định nghĩa cách resolve khi conflict
ALTER TABLE resource_type ADD COLUMN conflict_strategy VARCHAR(30)
    NOT NULL DEFAULT 'DENY_OVERRIDES'
    CHECK (conflict_strategy IN (
        'DENY_OVERRIDES',     -- bất kỳ DENY nào → DENY (banking default, most restrictive)
        'PERMIT_OVERRIDES',   -- bất kỳ ALLOW nào → ALLOW (internal tool, most permissive)
        'FIRST_MATCH_WINS',   -- policy có priority cao nhất → win (order matters)
        'UNANIMOUS_PERMIT'    -- tất cả ALLOW mới → ALLOW (extra sensitive resource)
    ));

-- Ví dụ:
-- document: DENY_OVERRIDES (banking default)
-- internal_report: PERMIT_OVERRIDES (low sensitivity)
-- secret_contract: UNANIMOUS_PERMIT (extra sensitive)
```

**Conflict resolution engine:**

```java
@Service
public class ConflictResolutionEngine {

    public AuthzDecision resolve(List<PolicyMatch> matches, ResourceType resourceType) {
        if (matches.isEmpty()) return AuthzDecision.DENY;  // default deny

        return switch (resourceType.getConflictStrategy()) {
            case DENY_OVERRIDES -> resolveDenyOverrides(matches);
            case PERMIT_OVERRIDES -> resolvePermitOverrides(matches);
            case FIRST_MATCH_WINS -> resolveFirstMatchWins(matches);
            case UNANIMOUS_PERMIT -> resolveUnanimousPermit(matches);
        };
    }

    private AuthzDecision resolveDenyOverrides(List<PolicyMatch> matches) {
        // Bất kỳ DENY nào → DENY toàn bộ, không cần check ALLOW
        boolean anyDeny = matches.stream()
            .anyMatch(m -> m.getEffect() == PolicyEffect.DENY);
        return anyDeny ? AuthzDecision.DENY : AuthzDecision.ALLOW;
    }

    private AuthzDecision resolvePermitOverrides(List<PolicyMatch> matches) {
        // Bất kỳ ALLOW nào → ALLOW, chỉ DENY khi tất cả đều DENY
        boolean anyAllow = matches.stream()
            .anyMatch(m -> m.getEffect() == PolicyEffect.ALLOW);
        return anyAllow ? AuthzDecision.ALLOW : AuthzDecision.DENY;
    }

    private AuthzDecision resolveFirstMatchWins(List<PolicyMatch> matches) {
        // Sắp xếp theo priority DESC → lấy match đầu tiên
        return matches.stream()
            .sorted(Comparator.comparingInt(PolicyMatch::getPriority).reversed())
            .findFirst()
            .map(m -> m.getEffect() == PolicyEffect.ALLOW
                ? AuthzDecision.ALLOW : AuthzDecision.DENY)
            .orElse(AuthzDecision.DENY);
    }

    private AuthzDecision resolveUnanimousPermit(List<PolicyMatch> matches) {
        // Tất cả phải ALLOW — 1 DENY hoặc không match → DENY
        boolean allAllow = matches.stream()
            .allMatch(m -> m.getEffect() == PolicyEffect.ALLOW);
        return allAllow ? AuthzDecision.ALLOW : AuthzDecision.DENY;
    }
}
```

**Tie-breaking khi cùng priority trong FIRST_MATCH_WINS:**

```sql
-- Nếu 2 policy cùng priority → dùng created_at hoặc name để deterministic
ALTER TABLE policy ADD COLUMN tiebreak_order INT DEFAULT 0;
-- Admin set tiebreak_order thủ công khi biết có conflict tiềm năng
-- policy_validator CI check cảnh báo khi có 2 policy cùng priority + resource_type + action
```

**Policy conflict detection trong CI:**

```java
// authz-cli validate — cảnh báo potential conflict khi upload policy
public List<ConflictWarning> detectConflicts(PolicyYaml newPolicy, List<PolicyYaml> existing) {
    List<ConflictWarning> warnings = new ArrayList<>();
    for (PolicyYaml existingPolicy : existing) {
        for (var newRule : newPolicy.getSpec().getRules()) {
            for (var existingRule : existingPolicy.getSpec().getRules()) {
                if (rulesOverlap(newRule, existingRule)
                        && newPolicy.getSpec().getPriority() == existingPolicy.getSpec().getPriority()
                        && newPolicy.getSpec().getEffect() != existingPolicy.getSpec().getEffect()) {
                    warnings.add(ConflictWarning.of(
                        "Potential conflict: " + newPolicy.getMetadata().getName()
                        + " vs " + existingPolicy.getMetadata().getName()
                        + " — same priority, opposite effect on "
                        + newRule.getResourceType() + "." + newRule.getAction()
                        + " — ensure conflict_strategy is explicitly set on resource_type"
                    ));
                }
            }
        }
    }
    return warnings;
}
```

---

### Gap 7 — Decision Log Explosion: Sampling + Partitioning + Cold Storage

**Vấn đề gốc rễ:** 100M+ requests/ngày × 1 row/request × ~2KB JSONB (eval_trace + context) = ~200GB/ngày → `authz_decision_log` phình TB trong vài ngày → query chậm, storage cost khổng lồ, backup không feasible.

**Giải pháp 3 tầng:**

#### Tầng 1 — Intelligent Sampling

```sql
-- Thêm sampling config per resource_type + decision
ALTER TABLE resource_type ADD COLUMN log_sampling JSONB NOT NULL DEFAULT '{
    "DENY":  1.0,
    "ALLOW": 0.01
}';
-- DENY: log 100% (audit requirement)
-- ALLOW: log 1% sample (performance monitoring)
-- Có thể customize per resource_type:
-- secret_contract: {"DENY": 1.0, "ALLOW": 0.1}   -- sensitive: log 10% ALLOW
-- internal_report: {"DENY": 1.0, "ALLOW": 0.001}  -- low sensitivity: log 0.1% ALLOW
```

```java
@Service
public class SampledAuditLogger {

    public void maybeRecord(AuthzRequest req, AuthzDecision decision, ResourceType rt) {
        JsonNode sampling    = rt.getLogSampling();
        double sampleRate    = sampling.get(decision.name()).asDouble(1.0);
        boolean shouldLog    = decision.isDeny()           // DENY: always
            || ThreadLocalRandom.current().nextDouble() < sampleRate;

        if (shouldLog) {
            // Ghi đầy đủ eval_trace chỉ cho DENY và sampled ALLOW
            durableAuditLogger.record(req, decision);
        } else {
            // ALLOW không được sample → ghi metric counter thay vì full log
            metricsRegistry.counter("authz.allow",
                "resource_type", req.getResourceType(),
                "action", req.getAction(),
                "tenant", req.getTenantId().toString()
            ).increment();
        }
    }
}
```

#### Tầng 2 — Table Partitioning

```sql
-- Partition by tenant_id + month → mỗi partition ~few GB, manageable
CREATE TABLE authz_decision_log (
    id                UUID         NOT NULL,
    tenant_id         UUID         NOT NULL,
    user_id           UUID         NOT NULL,
    resource_type     VARCHAR(100) NOT NULL,
    resource_ref      VARCHAR(300),
    action            VARCHAR(50)  NOT NULL,
    decision          VARCHAR(10)  NOT NULL,
    matched_policy_id UUID,
    policy_version_id UUID,
    eval_trace        JSONB        NOT NULL,
    context           JSONB        NOT NULL,
    is_sampled        BOOLEAN      NOT NULL DEFAULT false,  -- flag cho ALLOW samples
    decided_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (id, decided_at)   -- decided_at phải có trong PK để partition
) PARTITION BY RANGE (decided_at);

-- Tạo partition theo tháng (auto-create bằng pg_partman hoặc scheduled job)
CREATE TABLE authz_decision_log_2025_01
    PARTITION OF authz_decision_log
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

CREATE TABLE authz_decision_log_2025_02
    PARTITION OF authz_decision_log
    FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');

-- Index chỉ cần trên hot partitions (last 30 days)
CREATE INDEX idx_log_user_2025_01     ON authz_decision_log_2025_01(user_id, decided_at DESC);
CREATE INDEX idx_log_resource_2025_01 ON authz_decision_log_2025_01(resource_type, resource_ref);
CREATE INDEX idx_log_deny_2025_01     ON authz_decision_log_2025_01(tenant_id, decided_at DESC)
    WHERE decision = 'DENY';
```

#### Tầng 3 — Cold Storage Tiering

```java
@Component
public class AuditLogArchiver {

    @Scheduled(cron = "0 2 1 * *")  // chạy đầu mỗi tháng lúc 2am
    public void archiveOldPartitions() {
        // Xác định partition cần archive (> 30 ngày)
        String partitionName = resolvePartitionName(LocalDate.now().minusMonths(1));

        // Export sang Parquet → S3 (hoặc ClickHouse cho query analytics)
        s3Exporter.exportPartition(partitionName,
            "s3://authz-audit-archive/" + partitionName + ".parquet");

        // Verify export thành công
        long s3Count = s3Exporter.countRows(partitionName);
        long pgCount  = jdbc.queryForObject(
            "SELECT COUNT(*) FROM " + partitionName, Long.class);
        if (!s3Count.equals(pgCount))
            throw new ArchiveVerificationException(partitionName, pgCount, s3Count);

        // Drop partition khỏi PostgreSQL sau khi verify
        jdbc.execute("DROP TABLE IF EXISTS " + partitionName);
        log.info("Archived and dropped partition {} ({} rows)", partitionName, pgCount);
    }
}
```

**Query API cho cold data (audit team):**

```java
// GET /authz/audit?userId={}&from={}&to={}&decision=DENY
@GetMapping("/authz/audit")
public AuditQueryResponse query(@RequestParam UUID userId,
                                 @RequestParam Instant from,
                                 @RequestParam Instant to,
                                 @RequestParam(required=false) String decision) {
    // Hot data (< 30 ngày): query PostgreSQL partition
    if (from.isAfter(Instant.now().minus(30, DAYS))) {
        return AuditQueryResponse.from(
            decisionLogRepo.query(userId, from, to, decision));
    }
    // Cold data: query S3 via Athena hoặc ClickHouse
    return AuditQueryResponse.from(
        coldStorageClient.query(userId, from, to, decision));
}
```

**Tổng hợp hiệu quả:**
- Sampling: giảm 99% write volume cho ALLOW (từ 100M → ~1M rows/ngày).
- Partitioning: mỗi tháng partition ~30M rows DENY + 1M ALLOW sample = ~31M rows ~= 62GB → manageable.
- Cold storage: sau 30 ngày drop partition → PostgreSQL chỉ giữ 30 ngày hot data (~62GB), phần còn lại trên S3/ClickHouse.

---

### EC-7 — Cross-Tenant Shared Resources: Parent-Child Tenant & Shared Visibility

**Vấn đề gốc rễ:** Multi-tenancy strict (`tenant_id` isolation) không đủ cho enterprise thực tế:
- **Tập đoàn (parent)** có Master Data dùng chung cho các **công ty con (child tenant)** — VD: danh mục sản phẩm, bảng phí.
- **Shared services** (VD: template hợp đồng chuẩn) cần visible với nhiều tenant nhưng không phải mọi tenant.
- Cơ chế hiện tại check `tenant_id = :tenantId` — quá cứng, block mọi cross-tenant access.

**Giải pháp: Parent-Child Tenant Hierarchy + Shared Visibility Policy**

#### Schema

```sql
-- Hierarchy: tenant có thể có parent
ALTER TABLE tenant ADD COLUMN parent_tenant_id UUID REFERENCES tenant(id);
ALTER TABLE tenant ADD COLUMN tenant_type VARCHAR(20) NOT NULL DEFAULT 'STANDALONE'
    CHECK (tenant_type IN ('ROOT', 'PARENT', 'CHILD', 'STANDALONE'));

CREATE INDEX idx_tenant_parent ON tenant(parent_tenant_id) WHERE parent_tenant_id IS NOT NULL;

-- Shared resource visibility: resource_instance có thể shared với tenant khác
CREATE TABLE resource_visibility (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_instance_id UUID        NOT NULL REFERENCES resource_instance(id),
    visible_to_tenant_id UUID        NOT NULL REFERENCES tenant(id),
    visibility_type      VARCHAR(20) NOT NULL CHECK (visibility_type IN (
        'READ_ONLY',    -- child tenant chỉ đọc được
        'FULL',         -- child tenant đọc + sử dụng
        'INHERITED'     -- auto-inherited từ parent tenant
    )),
    granted_by           UUID,
    granted_at           TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_visibility_unique ON resource_visibility(resource_instance_id, visible_to_tenant_id);
```

#### Tenant-aware AuthZ evaluation

```java
@Service
public class TenantAwareAuthzEngine {

    public AuthzDecision evaluate(AuthzRequest req) {
        // Bước 1: Check trong tenant hiện tại (standard path)
        AuthzDecision localDecision = standardEngine.evaluate(req);
        if (localDecision.isAllow()) return localDecision;

        // Bước 2: Check shared visibility từ parent tenant
        Tenant currentTenant = tenantRepo.findById(req.getTenantId());
        if (currentTenant.getParentTenantId() == null) return localDecision;  // DENY, no parent

        // Resource có được share từ parent không?
        boolean sharedFromParent = resourceVisibilityRepo.exists(
            req.getResourceRef(), req.getTenantId());

        if (sharedFromParent) {
            // Evaluate policy của parent tenant với resource đó
            AuthzRequest parentReq = req.toBuilder()
                .tenantId(currentTenant.getParentTenantId())
                .build();
            AuthzDecision parentDecision = standardEngine.evaluate(parentReq);
            if (parentDecision.isAllow()) {
                // Downgrade permission: child tenant chỉ được READ_ONLY từ parent
                ResourceVisibility visibility = resourceVisibilityRepo.find(
                    req.getResourceRef(), req.getTenantId());
                if (visibility.getType() == READ_ONLY
                        && !req.getAction().equals("read")) {
                    return AuthzDecision.deny("CROSS_TENANT_READ_ONLY: action "
                        + req.getAction() + " not allowed on shared resource");
                }
                return parentDecision.withTag("cross_tenant_shared");
            }
        }
        return localDecision;  // DENY
    }
}
```

**Row filter cho shared resource:** Khi trả về list resource, cần include cả shared resources:

```sql
-- row_filter cho shared visibility: chỉ include resource mà tenant có visibility
-- Bổ sung vào filter_expr của permission 'read_shared_master_data':
-- SQL fragment (approved escape hatch, vì logic phức tạp):
-- (tenant_id = :currentTenantId)
-- OR EXISTS (
--     SELECT 1 FROM resource_visibility rv
--     JOIN resource_instance ri ON ri.id = rv.resource_instance_id
--     WHERE rv.visible_to_tenant_id = :currentTenantId
--       AND ri.external_ref = document.id::text
-- )
```

---

### EC-8 — Circular Delegation với Temporal Context

**Vấn đề gốc rễ:** EC-2 đã xử lý cycle detection cho quan hệ tĩnh. Nhưng delegation thường có `valid_until` — một cycle "temporal" có thể hình thành không phải trong đồ thị tĩnh mà trong đồ thị tại một thời điểm cụ thể:

- `A → B` valid từ 01/01 đến 31/01
- `B → C` valid từ 15/01 đến 28/02
- `C → A` valid từ 20/01 đến 10/02

Trong khoảng 20/01–28/01: cả 3 relation đều active → cycle tồn tại tại runtime dù không cycle trong đồ thị tĩnh.

EC-2 trigger kiểm tra cycle cho relation không có `expires_at` hoặc `expires_at IS NULL`. Với temporal relation, trigger cần check cycle trong time window giao nhau.

**Giải pháp: Temporal Cycle Detection**

```sql
CREATE OR REPLACE FUNCTION check_temporal_relation_cycle()
RETURNS TRIGGER AS $$
DECLARE
    cycle_exists BOOLEAN;
    effective_from TIMESTAMPTZ;
    effective_until TIMESTAMPTZ;
BEGIN
    -- Xác định time window của relation mới
    effective_from  := COALESCE(NEW.created_at, NOW());
    effective_until := COALESCE(NEW.expires_at, 'infinity'::TIMESTAMPTZ);

    -- Check cycle trong time window giao nhau
    WITH RECURSIVE temporal_reachable AS (
        SELECT
            object          AS node,
            created_at      AS rel_from,
            COALESCE(expires_at, 'infinity'::TIMESTAMPTZ) AS rel_until
        FROM relation_tuple
        WHERE tenant_id = NEW.tenant_id
          AND subject   = NEW.object
          AND relation  = NEW.relation
          -- Chỉ lấy relation active trong window giao nhau với NEW
          AND created_at < effective_until
          AND COALESCE(expires_at, 'infinity'::TIMESTAMPTZ) > effective_from

        UNION

        SELECT
            rt.object,
            GREATEST(tr.rel_from,  rt.created_at)                              AS rel_from,
            LEAST   (tr.rel_until, COALESCE(rt.expires_at, 'infinity'::TIMESTAMPTZ)) AS rel_until
        FROM relation_tuple rt
        JOIN temporal_reachable tr ON rt.subject = tr.node
        WHERE rt.tenant_id = NEW.tenant_id
          AND rt.relation  = NEW.relation
          -- Window giao nhau phải hợp lệ (from < until)
          AND GREATEST(tr.rel_from, rt.created_at)
              < LEAST(tr.rel_until, COALESCE(rt.expires_at, 'infinity'::TIMESTAMPTZ))
    )
    SELECT EXISTS (
        SELECT 1 FROM temporal_reachable
        WHERE node      = NEW.subject
          AND rel_from  < effective_until
          AND rel_until > effective_from
    ) INTO cycle_exists;

    IF cycle_exists THEN
        RAISE EXCEPTION
            'Temporal cycle detected: inserting (%) -[%]-> (%) valid [% → %] would create a cycle in overlapping time window',
            NEW.subject, NEW.relation, NEW.object, effective_from, effective_until;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Thay thế trigger cũ (EC-2) bằng trigger temporal-aware
DROP TRIGGER IF EXISTS trg_check_relation_cycle ON relation_tuple;

CREATE TRIGGER trg_check_temporal_relation_cycle
    BEFORE INSERT ON relation_tuple
    FOR EACH ROW EXECUTE FUNCTION check_temporal_relation_cycle();
```

**Live traversal temporal-aware trong ReBacEngine:**

```java
private boolean liveTemporalTraversal(String tenantId, String subject,
                                       String relation, String target,
                                       Instant atTime, int depth) {
    if (depth > MAX_DEPTH) throw new ReBacDepthExceededException(depth);

    // Chỉ traverse relation active tại thời điểm atTime
    List<String> next = relationTupleRepo.findActiveObjectsAt(
        tenantId, subject, relation, atTime);  // WHERE created_at <= atTime AND (expires_at IS NULL OR expires_at > atTime)

    if (next.contains(target)) return true;
    return next.stream().anyMatch(n ->
        liveTemporalTraversal(tenantId, n, relation, target, atTime, depth + 1));
}
```

**Materialized reachability phân tách theo time bucket:**

Với temporal delegation, `relation_reachability` không thể là snapshot tĩnh — cần thêm time dimension:

```sql
-- Extend relation_reachability với temporal validity
ALTER TABLE relation_reachability ADD COLUMN valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE relation_reachability ADD COLUMN valid_until TIMESTAMPTZ NOT NULL DEFAULT 'infinity';

CREATE INDEX idx_reachability_temporal ON relation_reachability
    (tenant_id, subject, relation, object, valid_from, valid_until);

-- Query: check reachability tại thời điểm cụ thể
SELECT EXISTS (
    SELECT 1 FROM relation_reachability
    WHERE tenant_id   = :tenantId
      AND subject     = :subject
      AND relation    = :relation
      AND object      = :object
      AND valid_from  <= :atTime
      AND valid_until >  :atTime
);
```

---

## Gap Resolution Matrix — Final (v3)

| Gap | Vấn đề | Giải pháp | Status |
|-----|---------|-----------|--------|
| G1 — Resource explosion | 100M instance rows | Type-level vs Instance-level; instance chỉ tạo khi cần ACL đặc biệt | ✅ |
| G2 — Attribute out-of-sync | Stale cache sau khi đổi branch | Keycloak SPI → Kafka push sync + `attributes_version` trong cache key | ✅ |
| G3 — ReBAC thiếu | Quan hệ bắc cầu không express bằng ABAC | `relation_tuple` + cycle detection + materialized reachability + circuit breaker | ✅ |
| G4 — Centralized bottleneck | Network latency + SPOF | Control Plane / Data Plane split + emergency revoke + fail-open/closed | ✅ |
| G5 — Single-backend AST | AST bind với SQL column | Backend-agnostic IR + `schema_field_registry` + multi-backend translator | ✅ |
| G6 — Policy versioning | Không có rollback, không có shadow | `policy_version` + `policy_shadow_log` + lifecycle + divergence gate | ✅ |
| G7 — Policy debugger | Không trace được tại sao DENY | `eval_trace` per AST node + Explain API + Replay API | ✅ |
| EC-1 — Temporal context | Cache miss liên tục với env.now() | `temporal_policy` bảng riêng + gate trước compiled cache | ✅ |
| EC-2 — ReBAC performance | Cycle + deep graph | Cycle detection trigger + materialized reachability + circuit breaker | ✅ |
| EC-3 — Audit durability | Mất log khi sidecar crash | Chronicle Queue WAL → relay → IAM idempotent + K8s preStop flush | ✅ |
| EC-4 — Cross-domain join | Attribute ở service khác | JIT fetch + CB (data động); pre-materialize relation_tuple (data chậm) | ✅ |
| EC-5 — Governance | Escape hatch abuse + field naming chaos | Policy-as-Code GitOps + CI/CD + schema_field_registry + approval trigger | ✅ |
| **Gap 4 — Big Node** | Fan-out 20K+ → CDC nghẽn | Max fan-out constraint + sub-graph partitioning + async rate-limited recompute | ✅ |
| **Gap 5 — ReBAC in NoSQL** | relation node không translate sang ES/Mongo | Query-time ID enrichment: pre-fetch IDs → inject terms/`$in` filter | ✅ |
| **Gap 6 — Policy conflict** | 2 policy cùng priority, effect khác → undefined | `conflict_strategy` per resource_type + ConflictResolutionEngine + CI conflict detection | ✅ |
| **Gap 7 — Log explosion** | 100M req/ngày → TB/ngày | Sampling (100% DENY, 1% ALLOW) + monthly partitioning + cold storage S3/ClickHouse | ✅ |
| **EC-7 — Cross-tenant** | Master data dùng chung, tenant isolation quá cứng | Parent-Child tenant hierarchy + `resource_visibility` + TenantAwareAuthzEngine | ✅ |
| **EC-8 — Circular delegation** | Temporal cycle không bị detect bởi static trigger | Temporal cycle detection trigger + time-windowed traversal + temporal reachability table | ✅ |
