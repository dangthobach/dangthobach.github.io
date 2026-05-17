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
    user_id           UUID NOT NULL REFERENCES user_account(id),
    role_id           UUID NOT NULL REFERENCES role(id),
    resource_scope_id UUID REFERENCES resource_instance(id),  -- scoped role
    expires_at        TIMESTAMPTZ DEFAULT NULL,                -- temporary permission
    PRIMARY KEY(user_id, role_id)
);
```

**Design decisions:**
- `role.parent_role_id` self-reference → role hierarchy. `BRANCH_MANAGER` kế thừa toàn bộ permission của `STAFF` — engine traverse lên cây khi evaluate.
- `permission.scope`: `own` = chỉ resource mình tạo, `branch` = cả branch, `all` = toàn hệ thống.
- `user_role.resource_scope_id`: gán role scoped theo resource cụ thể — VD: user A là `REVIEWER` chỉ trên contract batch `#456`.
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
    external_ref     VARCHAR(300),      -- ID trong service domain (doc ID, contract ID)
    owner_id         UUID REFERENCES user_account(id),
    attributes       JSONB DEFAULT '{}'  -- {"branch_code":"HN01","status":"PENDING","contract_type":"MORTGAGE"}
);

CREATE TABLE resource_acl (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_instance_id UUID NOT NULL REFERENCES resource_instance(id),
    subject_id           UUID NOT NULL,
    subject_type         VARCHAR(20) NOT NULL, -- 'USER', 'ROLE', 'GROUP'
    actions              VARCHAR(50)[] NOT NULL,
    conditions           JSONB DEFAULT NULL
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
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID        NOT NULL,
    user_id           UUID        NOT NULL,
    resource_type     VARCHAR(100) NOT NULL,
    resource_ref      VARCHAR(300),
    action            VARCHAR(50)  NOT NULL,
    decision          VARCHAR(10)  NOT NULL CHECK (decision IN ('ALLOW', 'DENY')),
    matched_policy_id UUID REFERENCES policy(id),
    context           JSONB        NOT NULL,  -- toàn bộ evaluation context tại thời điểm quyết định
    decided_at        TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX idx_authz_log_user ON authz_decision_log(user_id, decided_at DESC);
CREATE INDEX idx_authz_log_resource ON authz_decision_log(resource_type, resource_ref, decided_at DESC);
```

`context` lưu snapshot đầy đủ: user attrs, resource attrs, matched rules — dùng để audit "tại sao user X không xem được doc Y" và replay quyết định khi incident.

---

## Row Filter — Evaluation Engine (Spring Boot)

### Expression Evaluator (naive — xem phần Performance để optimize)

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
            List<String> parts = new ArrayList<>();
            for (JsonNode child : node.get("conditions"))
                parts.add(evalNode(child, ctx, params).sql());
            String joiner = op.equals("OR") ? " OR " : " AND ";
            return new SqlPredicate("(" + String.join(joiner, parts) + ")");
        }

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

RLS là tầng bảo vệ tại DB level, hoàn toàn độc lập với application code. Không thể bypass kể cả khi dùng raw JDBC.

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

-- Policy cho REVIEWER (naive version — xem Performance P5 để optimize)
CREATE POLICY doc_reviewer_access ON document
    FOR SELECT TO pdms_reviewer_role
    USING (
        status = 'PENDING_REVIEW'
        AND current_setting('app.user_id', true) = ANY(
            SELECT reviewer_id::text FROM document_reviewer_assignment
            WHERE document_id = document.id
        )
    );
```

### Set context per-request trong Spring Boot

```java
@Component
public class RlsContextSetter {

    @Autowired
    private DataSource dataSource;

    /**
     * set_config(..., false) = transaction-scoped → safe với HikariCP pool
     * KHÔNG dùng set_config(..., true) vì connection được reuse giữa các request
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

> ⚠️ **Critical:** `set_config('key', value, false)` = transaction-scoped. `set_config('key', value, true)` = session-scoped. Chỉ dùng `false` với connection pool để tránh context leak sang request tiếp theo.

---

## So sánh 2 tầng bảo vệ

| | `row_filter` (service layer) | PostgreSQL RLS (DB layer) |
|---|---|---|
| **Vị trí** | Application layer | Database engine |
| **Cấu hình** | DB-driven, fully dynamic | SQL DDL, cần migration |
| **Flexibility** | Cao — JSON AST, bất kỳ logic | Trung bình — SQL expression |
| **Performance** | Thêm 1 query load filter + eval | Zero overhead (tích hợp vào query plan) |
| **Bypass** | Có thể nếu developer quên inject | Không thể bypass (kể cả superuser nếu FORCE) |
| **Debug** | Dễ — log predicate generated | Khó hơn — dùng `EXPLAIN` với RLS context |
| **Vai trò** | Primary filter logic | Safety net / defense in depth |

---

## Performance — 5 điểm nghẽn và cách fix

> **Nguyên tắc:** Business logic không đổi — chỉ thay đổi cách evaluate và cache. Priority: logic đúng trước, optimize sau.

### P1 — Gộp N+1 query thành 1 JOIN duy nhất (High impact)

Vấn đề: mỗi request load tuần tự user_role → role_permission → row_filter → policy_rule = 4–6 DB round-trips × 1000 RPS = DB bottleneck.

Giải pháp: gộp thành 1 query với role hierarchy dùng `WITH RECURSIVE`, cache kết quả:

```sql
SELECT
    p.id              AS permission_id,
    p.code            AS permission_code,
    p.resource_type,
    p.action,
    p.scope,
    r.id              AS role_id,
    r.code            AS role_code,
    rf.filter_expr    AS row_filter_expr,
    rf.sql_fragment   AS row_filter_sql,
    ff.allowed_fields,
    ff.masked_fields,
    ff.mask_pattern,
    pr.condition_expr AS policy_condition,
    pol.effect        AS policy_effect,
    pol.priority      AS policy_priority
FROM user_role ur
-- Role hierarchy: traverse parent roles
JOIN LATERAL (
    WITH RECURSIVE role_tree AS (
        SELECT id, parent_role_id FROM role WHERE id = ur.role_id
        UNION ALL
        SELECT r2.id, r2.parent_role_id
        FROM role r2
        JOIN role_tree rt ON r2.id = rt.parent_role_id
    )
    SELECT id FROM role_tree
) r_hier ON true
JOIN role r ON r.id = r_hier.id
JOIN role_permission rp ON rp.role_id = r.id
JOIN permission p ON p.id = rp.permission_id
    AND p.resource_type = :resourceType
LEFT JOIN row_filter rf ON rf.permission_id = p.id
    AND rf.resource_type = :resourceType
    AND rf.is_active = true
LEFT JOIN field_filter ff ON ff.permission_id = p.id
    AND ff.resource_type = :resourceType
LEFT JOIN policy_rule pr ON pr.resource_type = :resourceType
    AND pr.action = p.action
JOIN policy pol ON pol.id = pr.policy_id
    AND pol.is_active = true
WHERE ur.user_id   = :userId
  AND ur.tenant_id = :tenantId
  AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
ORDER BY pol.priority DESC;
```

Kết quả query này cache vào Redis TTL 5 phút — 1 request đầu trả về full context, các request sau đọc từ cache.

---

### P2 — Compiled predicate cache thay vì eval AST mỗi lần (High impact)

Vấn đề: `filter_expr` JSONB được deserialize và traverse lại mỗi request. 1000 RPS × cùng 1 permission = eval AST 1000 lần cho cùng 1 expression.

Giải pháp: cache kết quả compile (SQL template + param names), chỉ bind user attribute value tại runtime:

```java
@Component
public class CompiledFilterCache {

    // Cache compiled predicate — key: permissionId:resourceType
    private final Cache<String, CompiledPredicate> cache = Caffeine.newBuilder()
        .maximumSize(10_000)
        .expireAfterWrite(10, MINUTES)
        .recordStats()   // expose qua Micrometer
        .build();

    public CompiledPredicate getOrCompile(UUID permissionId, String resourceType,
                                           JsonNode filterExpr) {
        String key = permissionId + ":" + resourceType;
        return cache.get(key, k -> compile(filterExpr));
    }

    private CompiledPredicate compile(JsonNode expr) {
        // Traverse AST 1 lần → SQL template với named placeholders
        // VD: "branch_code = :user_branch_code AND status = ANY(:allowed_statuses)"
        // Lưu mapping: placeholder → user attribute key
        var builder = new PredicateBuilder();
        traverseNode(expr, builder);
        return builder.build();
    }
}

// Runtime: chỉ bind values, không traverse AST
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

Compile xảy ra đúng 1 lần per permission, sau đó chỉ bind. Business logic không đổi.

---

### P3 — Piggyback SET vào query đầu tiên thay vì round-trip riêng (Medium impact)

Vấn đề: mỗi request chạy thêm 1 PreparedStatement chỉ để set RLS session variable — thêm 1 DB round-trip.

Giải pháp: dùng CTE để set context và query trong cùng 1 statement:

```java
String query = """
    WITH ctx AS (
        SELECT
            set_config('app.branch_code', :branchCode, false),
            set_config('app.user_id',     :userId,     false),
            set_config('app.bypass_rls',  :bypass,     false)
    )
    SELECT d.*
    FROM document d, ctx
    WHERE d.tenant_id = :tenantId
      AND {rowFilterPredicate}
    """;
```

Hoặc dùng AOP interceptor set context ngay khi `@Transactional` bắt đầu — cùng connection, không thêm round-trip:

```java
@Around("@annotation(RequiresAuthzContext)")
public Object setRlsContext(ProceedingJoinPoint pjp) throws Throwable {
    AuthzContext ctx = AuthzContextHolder.current();
    jdbcTemplate.execute(
        "SELECT set_config('app.branch_code',:b,false), set_config('app.user_id',:u,false)",
        (PreparedStatementCallback<Void>) ps -> {
            ps.setString(1, ctx.getBranchCode());
            ps.setString(2, ctx.getUserId().toString());
            ps.execute(); return null;
        });
    return pjp.proceed();
}
```

---

### P4 — Thay `KEYS` pattern scan bằng `SMEMBERS` + secondary index set (Medium impact)

Vấn đề: `redisTemplate.keys("authz:rowfilter:*")` là O(N) scan, block toàn bộ Redis event loop. Production Redis với 100k+ keys → latency spike >100ms.

Giải pháp: dùng Redis Set làm index — mỗi permission có 1 Set chứa tất cả cache key của nó:

```java
@Service
public class AuthzCacheManager {

    private static final String KEY_PREFIX   = "authz:rf:";
    private static final String INDEX_PREFIX = "authz:idx:perm:";

    public void put(UUID permissionId, String resourceType, String userId,
                    CompiledPredicate predicate) {
        String cacheKey = KEY_PREFIX + permissionId + ":" + resourceType + ":" + userId;
        String indexKey = INDEX_PREFIX + permissionId;

        redisTemplate.executePipelined((RedisCallback<?>) conn -> {
            conn.setEx(cacheKey.getBytes(), 300, serialize(predicate));  // TTL 5 phút
            conn.sAdd(indexKey.getBytes(), cacheKey.getBytes());         // đăng ký vào index
            conn.expire(indexKey.getBytes(), 600);                       // index TTL 10 phút
            return null;
        });
    }

    // Invalidate: SMEMBERS → DELETE tất cả — không block Redis
    @KafkaListener(topics = "pdms.public.row_filter")
    public void onRowFilterChange(RowFilterCdcEvent event) {
        String indexKey = INDEX_PREFIX + event.getPermissionId();
        Set<String> cacheKeys = redisTemplate.opsForSet().members(indexKey);
        if (cacheKeys != null && !cacheKeys.isEmpty()) {
            List<String> toDelete = new ArrayList<>(cacheKeys);
            toDelete.add(indexKey);
            redisTemplate.delete(toDelete);
            log.info("Invalidated {} cache entries for permission {}",
                cacheKeys.size(), event.getPermissionId());
        }
    }
}
```

```sql
-- Bắt buộc để Debezium capture full row data khi UPDATE/DELETE
ALTER TABLE row_filter      REPLICA IDENTITY FULL;
ALTER TABLE policy          REPLICA IDENTITY FULL;
ALTER TABLE role_permission REPLICA IDENTITY FULL;
```

---

### P5 — Rewrite RLS correlated subquery thành EXISTS + index (Medium impact)

Vấn đề: policy `USING` clause dùng correlated subquery chạy lại với mỗi row của result set. 1000-row result → 1000 subquery executions.

Giải pháp A — `EXISTS` với proper index:

```sql
-- Tạo index trước
CREATE INDEX idx_reviewer_assignment_lookup
    ON document_reviewer_assignment(document_id, reviewer_id);

-- Rewrite policy
CREATE POLICY doc_reviewer_access ON document
    FOR SELECT TO pdms_reviewer_role
    USING (
        status = 'PENDING_REVIEW'
        AND EXISTS (
            SELECT 1 FROM document_reviewer_assignment dra
            WHERE dra.document_id = document.id
              AND dra.reviewer_id = current_setting('app.user_id', true)::uuid
        )
    );
```

Giải pháp B (tốt hơn với PDMS) — service pre-compute list rồi pass vào session:

```sql
-- set_config('app.reviewable_doc_ids', 'uuid1,uuid2,...', false) từ service layer

CREATE POLICY doc_reviewer_access ON document
    FOR SELECT TO pdms_reviewer_role
    USING (
        status = 'PENDING_REVIEW'
        AND id = ANY(
            string_to_array(
                current_setting('app.reviewable_doc_ids', true), ','
            )::uuid[]
        )
    );
-- ANY(small array) nhanh hơn nhiều so với correlated subquery
```

---

### Tổng hợp — business logic không đổi ở đâu

| Điểm nghẽn | Thay đổi | Business logic ảnh hưởng? |
|---|---|---|
| P1 — N+1 query | Gộp thành 1 JOIN + cache AuthZ context | Không — cùng data, khác query shape |
| P2 — AST eval lặp | Compile 1 lần, cache SQL template | Không — cùng logic, khác execution path |
| P3 — set_config round-trip | Piggyback vào CTE hoặc AOP | Không — cùng RLS behavior |
| P4 — KEYS scan | SMEMBERS + Redis Set index | Không — invalidation đúng như cũ |
| P5 — Correlated subquery | Rewrite EXISTS + index | Không — cùng security semantic |

**Priority cho PDMS:** P1 + P2 là critical — giải quyết xong 2 cái này sẽ cảm nhận được ngay ở production scale. P3–P5 là polish tier, giải quyết khi hệ thống đã stable.

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
    ├── Evaluate policy_rule + condition_expr (compiled cache)
    ├── Build row_filter SQL predicate (compiled cache)
    └── Return: decision (ALLOW/DENY) + predicate string
    │
    ▼
PostgreSQL
    ├── Layer E-1: row_filter predicate injected vào WHERE clause
    └── Layer E-2: RLS policy tự động apply (safety net, branch isolation only)
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
- PostgreSQL RLS chỉ làm một rule đơn giản — `branch_code isolation` — như safety net.
- Tránh để business logic phức tạp trong RLS vì debug rất khó khi production incident.

---

---

## Hạn chế & Gaps hiện tại

Mặc dù thiết kế 5 lớp bao phủ hầu hết các kịch bản enterprise, vẫn còn một số điểm cần lưu ý khi scale:

1.  **Resource Instance Explosion:** Lưu mọi instance vào bảng `resource_instance` (Layer C) cho các hệ thống có hàng trăm triệu bản ghi sẽ gây áp lực cực lớn lên storage và performance của bảng ACL.
2.  **Data Consistency:** Việc duy trì attribute của user/resource tại `iam-service` song song với domain service dễ dẫn đến tình trạng "lệch dữ liệu" (out-of-sync) nếu cơ chế đồng bộ (CDC/Kafka) bị delay.
3.  **Thiếu ReBAC (Relationship-based):** Hiện tại tập trung vào ABAC. Các quan hệ phức tạp (VD: "người được ủy quyền của chủ hợp đồng") phải được transform thành attributes, gây khó khăn khi quản lý các quan hệ bắc cầu hoặc dạng đồ thị.
4.  **Centralized Bottleneck:** Toàn bộ service gọi về IAM để check quyền tạo ra độ trễ mạng (Network Latency) và Single Point of Failure nếu không có cơ chế Local Execution.

---

## Đề xuất cải tiến & Tầm nhìn Universal AuthZ

Để biến mô hình này thành một nền tảng AuthZ linh động cho mọi yêu cầu, cần thực hiện các cải tiến sau:

### 1. Hybrid ReBAC + ABAC (Zanzibar style)
Bổ sung bảng quan hệ dạng bộ ba (tuple): `(subject) --[relation]--> (object)`.
- Ví dụ: `(User:A) --[manager]--> (Branch:HN)`.
- Quyền "Manager xem được tài liệu của Branch" sẽ được giải quyết bằng Graph Traversal thay vì chỉ so khớp attributes phẳng.

### 2. Local Policy Execution (Sidecar Pattern)
Thay vì request-response tới IAM service:
- **IAM Service** đóng vai trò **Control Plane** (quản lý policy).
- **Domain Services** tích hợp **Data Plane** (như OPA - Open Policy Agent).
- Policy được sync xuống local của từng service. Việc check quyền diễn ra in-memory (0ms network latency).

### 3. Cross-Platform Filter Engine
Mở rộng AST Evaluator (Layer E) để không chỉ sinh SQL WHERE clause mà còn sinh ra:
- **Elasticsearch Filter Query** cho tìm kiếm hồ sơ.
- **MongoDB Match Expression** cho các hệ thống NoSQL.
Điều này đảm bảo một Policy duy nhất được áp dụng đồng nhất trên mọi loại database.

### 4. Policy-as-Code & Versioning
Bổ sung quy trình quản lý policy chuyên nghiệp:
- `Draft` -> `Test` -> `Peer Review` -> `Publish`.
- Hỗ trợ **Dry-run mode (Shadow mode)**: Log lại quyết định của policy mới mà không thực sự áp dụng để đánh giá tác động trước khi Go-live.

### 5. Policy Debugger (Explainability)
Xây dựng công cụ "Explain" chi tiết: Khi một request bị DENY, hệ thống phải chỉ rõ được:
- Rule nào đã khớp?
- Attribute nào bị thiếu hoặc sai lệch?
- Trace-log của quá trình evaluate AST.

---

## Related Notes

- [[PDMS-AuthZ-Fine-Grained-Design]]
- [[PDMS-AuthZ-Sync-Strategy-Comparison]]
- [[PDMS-IAM-Multi-Domain-Design]]
- [[Cross-Service-Join-AuthZ-Fine-Grained-Filter]]
- [[Debezium-CDC-Deep-Dive]]

## Tags

#authz #security #pdms #postgresql #rls #spring-boot #microservices #data-model #performance
