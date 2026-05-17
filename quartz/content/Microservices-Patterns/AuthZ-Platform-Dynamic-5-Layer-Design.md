# AuthZ Platform — Dynamic 5-Layer Design

> **Context:** Thiết kế nền tảng phân quyền động cho enterprise system, đặc biệt áp dụng cho PDMS (Physical Document Management System) tại VPBank. Toàn bộ policy, role, permission, field/row filter được cấu hình xuống database — không hardcode logic trong code.

---

## Tổng quan 5 lớp phân quyền

Một enterprise AuthZ system cần giải quyết 5 câu hỏi khác nhau, mỗi câu hỏi là một layer riêng:

| Layer | Câu hỏi | Cơ chế |
|-------|---------|--------|
| A — Identity | Mày là ai? Token hợp lệ không? | JWT / OAuth2 / OIDC / mTLS |
| B — RBAC | Role của mày có permission gì? | role → permission mapping |
| C — Resource | Mày có quyền trên object cụ thể này không? | ACL per resource instance |
| D — ABAC | Context hiện tại có cho phép không? | Policy engine, JSON AST eval |
| E — Data filter | Response trả về field/row nào? | Field masking + Row filter |

> **Rule:** Layer 1–2 xử lý ở Gateway (Keycloak + Spring Cloud Gateway). Layer 3–4 delegate sang `pdms-iam-service`. Layer 5 xử lý ở service layer hoặc DB (PostgreSQL RLS).

---

## Data Model — 5 nhóm bảng

### Layer A — Identity & Multi-tenancy

```sql
CREATE TABLE tenant (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code    VARCHAR(50)  UNIQUE NOT NULL,
    name    VARCHAR(200) NOT NULL,
    config  JSONB        DEFAULT '{}'
);

CREATE TABLE user_account (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL REFERENCES tenant(id),
    username    VARCHAR(100) NOT NULL,
    external_id VARCHAR(200),          -- Keycloak subject
    attributes  JSONB DEFAULT '{}',    -- {"branch_code":"HN01","level":3,"department":"credit"}
    is_active   BOOLEAN DEFAULT true,
    UNIQUE(tenant_id, username)
);
```

`user_account.attributes` là JSONB — lưu attribute động của user dùng làm input cho ABAC engine (Layer D).

---

### Layer B — Role & Permission (hierarchical)

```sql
CREATE TABLE role (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID        NOT NULL REFERENCES tenant(id),
    code           VARCHAR(100) NOT NULL,
    name           VARCHAR(200) NOT NULL,
    parent_role_id UUID REFERENCES role(id),  -- self-reference: role hierarchy
    priority       INT DEFAULT 0,
    UNIQUE(tenant_id, code)
);

CREATE TABLE permission (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID        NOT NULL REFERENCES tenant(id),
    code          VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100) NOT NULL,  -- 'document', 'contract', 'cif'
    action        VARCHAR(50)  NOT NULL,  -- 'read', 'write', 'approve', 'archive'
    scope         VARCHAR(50)  NOT NULL,  -- 'own', 'branch', 'all'
    UNIQUE(tenant_id, code)
);

CREATE TABLE role_permission (
    role_id       UUID NOT NULL REFERENCES role(id),
    permission_id UUID NOT NULL REFERENCES permission(id),
    conditions    JSONB DEFAULT NULL,     -- optional extra ABAC conditions
    PRIMARY KEY(role_id, permission_id)
);

CREATE TABLE user_role (
    user_id          UUID NOT NULL REFERENCES user_account(id),
    role_id          UUID NOT NULL REFERENCES role(id),
    resource_scope_id UUID REFERENCES resource_instance(id),  -- scoped role
    expires_at       TIMESTAMPTZ DEFAULT NULL,                 -- temporary permission
    PRIMARY KEY(user_id, role_id)
);
```

**Design decisions:**
- `role.parent_role_id` self-reference → role hierarchy. `BRANCH_MANAGER` kế thừa toàn bộ permission của `STAFF` — engine traverse lên cây khi evaluate.
- `permission.scope`: `own` = chỉ resource mình tạo, `branch` = cả branch, `all` = toàn hệ thống.
- `user_role.resource_scope_id`: gán role **scoped theo resource cụ thể** — VD: user A là `REVIEWER` chỉ trên contract batch `#456`.
- `user_role.expires_at`: temporary permission, tự hết hạn không cần cleanup job.

---

### Layer C — Resource Registry

```sql
CREATE TABLE resource_type (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID        NOT NULL REFERENCES tenant(id),
    code       VARCHAR(100) NOT NULL,
    name       VARCHAR(200) NOT NULL,
    schema_def JSONB NOT NULL,    -- định nghĩa attributes + actions hợp lệ
    UNIQUE(tenant_id, code)
);

CREATE TABLE resource_instance (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_type_id UUID NOT NULL REFERENCES resource_type(id),
    external_ref     VARCHAR(300),     -- ID trong service domain (doc ID, contract ID)
    owner_id         UUID REFERENCES user_account(id),
    attributes       JSONB DEFAULT '{}' -- {"branch_code":"HN01","status":"PENDING","contract_type":"MORTGAGE"}
);

CREATE TABLE resource_acl (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_instance_id UUID NOT NULL REFERENCES resource_instance(id),
    subject_id          UUID NOT NULL,
    subject_type        VARCHAR(20) NOT NULL, -- 'USER', 'ROLE', 'GROUP'
    actions             VARCHAR(50)[] NOT NULL,
    conditions          JSONB DEFAULT NULL
);
```

`resource_type.schema_def` ví dụ:

```json
{
  "attributes": ["branch_code", "status", "created_by", "contract_type"],
  "actions": ["read", "write", "approve", "archive"]
}
```

`resource_instance.attributes` là context phía resource cho ABAC — combined với `user_account.attributes` để evaluate policy.

---

### Layer D — Policy Engine (ABAC)

```sql
CREATE TABLE policy (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID        NOT NULL REFERENCES tenant(id),
    name      VARCHAR(200) NOT NULL,
    effect    VARCHAR(10)  NOT NULL CHECK (effect IN ('ALLOW', 'DENY')),
    priority  INT          NOT NULL DEFAULT 0,  -- DENY higher priority → deny-override
    is_active BOOLEAN      DEFAULT true
);

CREATE TABLE policy_rule (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id      UUID        NOT NULL REFERENCES policy(id),
    subject_type   VARCHAR(50) NOT NULL,   -- 'ROLE', 'USER', 'GROUP'
    resource_type  VARCHAR(100) NOT NULL,
    action         VARCHAR(50)  NOT NULL,
    condition_expr JSONB        NOT NULL   -- JSON AST
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
      "left":  { "type": "user_attr",    "key": "level" },
      "op":    "gte",
      "right": { "type": "literal",      "value": 3 }
    }
  ]
}
```

**Allowed node types:** `user_attr`, `resource_col`, `literal`, `env` (`now()`, `current_date`, `request_ip`).
**Allowed operators:** `eq`, `neq`, `in`, `not_in`, `gte`, `lte`, `like`, `is_null`.

`policy.effect + priority` cho phép **deny-override**: DENY với priority cao hơn sẽ block dù có ALLOW phía dưới — quan trọng với banking (VD: block ngoài giờ hành chính).

---

### Layer E — Data Filter (field & row)

```sql
CREATE TABLE field_filter (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    permission_id  UUID        NOT NULL REFERENCES permission(id),
    resource_type  VARCHAR(100) NOT NULL,
    allowed_fields VARCHAR(100)[],   -- whitelist fields được trả về
    masked_fields  VARCHAR(100)[],   -- fields bị mask (không block, nhưng che giá trị)
    mask_pattern   VARCHAR(50)       -- '****', '***-***-####'
);

CREATE TABLE row_filter (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    permission_id UUID        NOT NULL REFERENCES permission(id),
    resource_type VARCHAR(100) NOT NULL,
    filter_expr   JSONB        NOT NULL,  -- JSON AST → translate sang SQL WHERE
    sql_fragment  TEXT,                   -- escape hatch cho DBA, trusted
    priority      INT DEFAULT 0,          -- nhiều filter cùng permission → AND tất cả
    is_active     BOOLEAN DEFAULT true
);

CREATE INDEX idx_row_filter_permission ON row_filter(permission_id, resource_type)
    WHERE is_active = true;
```

**Phân biệt `allowed_fields` vs `masked_fields`:**
- `allowed_fields`: field không có trong list → bị strip khỏi response hoàn toàn.
- `masked_fields`: field có trong response nhưng value bị thay bằng `mask_pattern`. Dùng khi cần biết field tồn tại nhưng không thấy nội dung (VD: hiển thị `****` để user biết có CCCD nhưng không đọc được).

---

### Audit & Decision Log

```sql
CREATE TABLE authz_decision_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID        NOT NULL,
    user_id       UUID        NOT NULL,
    resource_type VARCHAR(100) NOT NULL,
    resource_ref  VARCHAR(300),
    action        VARCHAR(50)  NOT NULL,
    decision      VARCHAR(10)  NOT NULL CHECK (decision IN ('ALLOW', 'DENY')),
    matched_policy_id UUID REFERENCES policy(id),
    context       JSONB        NOT NULL,  -- toàn bộ evaluation context tại thời điểm quyết định
    decided_at    TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX idx_authz_log_user ON authz_decision_log(user_id, decided_at DESC);
CREATE INDEX idx_authz_log_resource ON authz_decision_log(resource_type, resource_ref, decided_at DESC);
```

`context` lưu snapshot đầy đủ: user attrs, resource attrs, matched rules — dùng để audit "tại sao user X không xem được doc Y" và replay quyết định khi incident.

---

## Row Filter — Evaluation Engine (Spring Boot)

### Expression Evaluator

```java
@Service
public class RowFilterEvaluator {

    @Autowired
    private RowFilterRepository rowFilterRepo;

    public FilterResult evaluate(UUID permissionId, String resourceType, AuthzContext ctx) {
        List<RowFilter> filters = rowFilterRepo
            .findActiveByPermissionAndResource(permissionId, resourceType);

        if (filters.isEmpty()) return FilterResult.noFilter();

        List<String> predicates = new ArrayList<>();
        Map<String, Object> params = new LinkedHashMap<>();

        for (RowFilter filter : filters) {
            if (filter.getSqlFragment() != null) {
                // Escape hatch: DBA-defined, trusted
                predicates.add(filter.getSqlFragment());
                continue;
            }
            SqlPredicate pred = evalNode(filter.getFilterExpr(), ctx, params);
            predicates.add(pred.sql());
        }

        return new FilterResult(String.join(" AND ", predicates), params);
    }

    private SqlPredicate evalNode(JsonNode node, AuthzContext ctx,
                                  Map<String, Object> params) {
        String op = node.get("operator").asText(null);
        if (op != null) {
            // Compound: AND / OR
            List<String> parts = new ArrayList<>();
            for (JsonNode child : node.get("conditions"))
                parts.add(evalNode(child, ctx, params).sql());
            String joiner = op.equals("OR") ? " OR " : " AND ";
            return new SqlPredicate("(" + String.join(joiner, parts) + ")");
        }

        // Leaf condition
        String left  = resolveRef(node.get("left"),  ctx, params);
        String right = resolveRef(node.get("right"), ctx, params);
        String sqlOp = switch (node.get("op").asText()) {
            case "eq"     -> "=";
            case "neq"    -> "!=";
            case "gte"    -> ">=";
            case "lte"    -> "<=";
            case "in"     -> "= ANY(?)";
            case "not_in" -> "!= ALL(?)";
            case "like"   -> "LIKE ?";
            default       -> throw new IllegalArgumentException("Unknown op: " + node.get("op").asText());
        };
        return new SqlPredicate(left + " " + sqlOp + " " + right);
    }

    // Column whitelist — bắt buộc để tránh SQL injection qua JSON
    private static final Set<String> ALLOWED_COLUMNS = Set.of(
        "branch_code", "status", "created_by", "department_code",
        "contract_type", "owner_id", "tenant_id"
    );

    private String resolveRef(JsonNode ref, AuthzContext ctx, Map<String, Object> params) {
        return switch (ref.get("type").asText()) {
            case "resource_col" -> {
                String col = ref.get("key").asText();
                if (!ALLOWED_COLUMNS.contains(col))
                    throw new SecurityException("Column not allowed in filter: " + col);
                yield col;
            }
            case "user_attr" -> {
                String paramKey = "p_" + params.size();
                params.put(paramKey, ctx.getUserAttr(ref.get("key").asText()));
                yield ":" + paramKey;
            }
            case "literal" -> {
                String paramKey = "p_" + params.size();
                params.put(paramKey, extractLiteral(ref.get("value")));
                yield ":" + paramKey;
            }
            case "env" -> switch (ref.get("key").asText()) {
                case "now"          -> "NOW()";
                case "current_date" -> "CURRENT_DATE";
                default -> throw new IllegalArgumentException("Unknown env key");
            };
            default -> throw new IllegalArgumentException("Unknown ref type: " + ref.get("type").asText());
        };
    }
}
```

---

## PostgreSQL RLS — Safety Net Layer

RLS là tầng bảo vệ **tại DB level**, hoàn toàn độc lập với application code. Không thể bypass kể cả khi dùng raw JDBC.

### Enable và tạo policy

```sql
ALTER TABLE document ENABLE ROW LEVEL SECURITY;
ALTER TABLE document FORCE ROW LEVEL SECURITY;  -- bắt buộc cả table owner

-- Policy cơ bản: branch isolation
CREATE POLICY doc_branch_isolation ON document
    AS PERMISSIVE
    FOR ALL
    TO pdms_app_role
    USING (
        branch_code = current_setting('app.branch_code', true)
        OR current_setting('app.bypass_rls', true) = 'true'
    );

-- Policy cho REVIEWER: thấy doc cần review bất kể branch
CREATE POLICY doc_reviewer_access ON document
    FOR SELECT TO pdms_reviewer_role
    USING (
        status = 'PENDING_REVIEW'
        AND current_setting('app.user_id', true) = ANY(
            SELECT reviewer_id::text FROM document_reviewer_assignment
            WHERE document_id = document.id
        )
    );

-- PERMISSIVE policies được OR với nhau tự động
-- → user có nhiều role thấy union của tất cả policies match
```

### Set context per-request trong Spring Boot

```java
@Component
public class RlsContextSetter {

    @Autowired
    private DataSource dataSource;

    /**
     * Wrap query execution với RLS context.
     * set_config(..., false) = chỉ apply cho transaction hiện tại → safe với HikariCP pool
     * KHÔNG dùng set_config(..., true) với connection pool vì connection được reuse
     */
    public <T> T withRlsContext(AuthzContext ctx, Callable<T> action) throws Exception {
        try (Connection conn = dataSource.getConnection()) {
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT set_config('app.branch_code', ?, false), " +
                           "set_config('app.user_id', ?, false),     " +
                           "set_config('app.bypass_rls', ?, false)")) {
                ps.setString(1, ctx.getBranchCode());
                ps.setString(2, ctx.getUserId().toString());
                ps.setString(3, String.valueOf(ctx.isAdmin()));
                ps.execute();
            }
            return action.call();
        }
    }
}
```

> ⚠️ **Critical:** `set_config('key', value, false)` = transaction-scoped. `set_config('key', value, true)` = session-scoped. **Chỉ dùng `false` với connection pool** để tránh context leak sang request tiếp theo.

---

## So sánh 2 tầng bảo vệ

| | `row_filter` (service layer) | PostgreSQL RLS (DB layer) |
|---|---|---|
| **Vị trí** | Application layer | Database engine |
| **Cấu hình** | DB-driven, fully dynamic | SQL DDL, cần migration |
| **Flexibility** | Cao — JSON AST, bất kỳ logic | Trung bình — SQL expression |
| **Performance** | Thêm 1 query load filter + eval | Zero overhead (tích hợp vào query plan) |
| **Bypass** | Có thể nếu developer quên inject | **Không thể bypass** (kể cả superuser nếu FORCE) |
| **Debug** | Dễ — log predicate generated | Khó hơn — dùng `EXPLAIN` với RLS context |
| **Vai trò** | Primary filter logic | Safety net / defense in depth |

---

## Cache Strategy — Redis + CDC Invalidation

```java
// Cache key format
private String cacheKey(UUID permissionId, String resourceType, String userId) {
    return String.format("authz:rowfilter:%s:%s:%s", permissionId, resourceType, userId);
}

// Debezium CDC consumer — invalidate khi row_filter thay đổi
@KafkaListener(topics = "pdms.public.row_filter")
public void onRowFilterChange(RowFilterCdcEvent event) {
    String pattern = "authz:rowfilter:" + event.getPermissionId() + ":*";
    Set<String> keys = redisTemplate.keys(pattern);
    if (!keys.isEmpty()) redisTemplate.delete(keys);
    log.info("Invalidated {} row_filter cache entries for permission {}",
        keys.size(), event.getPermissionId());
}
```

```sql
-- Bắt buộc để Debezium capture full row data khi UPDATE/DELETE
ALTER TABLE row_filter REPLICA IDENTITY FULL;
ALTER TABLE policy      REPLICA IDENTITY FULL;
ALTER TABLE role_permission REPLICA IDENTITY FULL;
```

---

## Mapping vào PDMS Architecture

```
Request từ client
    │
    ▼
Spring Cloud Gateway
    ├── Layer A: Keycloak validate JWT
    └── Layer B: Check coarse-grained role (RBAC)
    │
    ▼
pdms-service
    ├── Layer C: Resource-level ACL check → call pdms-iam-service
    └── Layer D: ABAC policy eval → call pdms-iam-service
    │
    ▼
pdms-iam-service
    ├── Evaluate policy_rule + condition_expr
    ├── Build row_filter SQL predicate
    └── Return: decision (ALLOW/DENY) + predicate string
    │
    ▼
PostgreSQL
    ├── Layer E-1: row_filter predicate injected vào WHERE clause
    └── Layer E-2: RLS policy tự động apply (safety net)
    │
    ▼
Filtered resultset
    │
    ▼
pdms-service
    └── Layer E-3: field_filter — strip/mask sensitive fields trước khi response
```

**Recommendation cho PDMS:**
- `row_filter` handle toàn bộ business logic về phân quyền data.
- PostgreSQL RLS chỉ làm **một rule đơn giản** — `branch_code isolation` — như safety net.
- Tránh để business logic phức tạp trong RLS vì debug rất khó khi production incident.

---

## Related Notes

- [[PDMS-AuthZ-Fine-Grained-Design]]
- [[PDMS-AuthZ-Sync-Strategy-Comparison]]
- [[PDMS-IAM-Multi-Domain-Design]]
- [[Cross-Service-Join-AuthZ-Fine-Grained-Filter]]
- [[Debezium-CDC-Deep-Dive]]

## Tags

#authz #security #pdms #postgresql #rls #spring-boot #microservices #data-model
