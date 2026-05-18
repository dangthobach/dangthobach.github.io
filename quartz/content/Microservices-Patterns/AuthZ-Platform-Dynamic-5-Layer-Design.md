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
