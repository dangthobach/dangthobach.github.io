---
tags: [pdms, vpbank, iam, multi-tenant, domain-isolation, rbac, abac, architecture-decision]
up: "[[PDMS-Architecture-Overview]]"
related: "[[PDMS-AuthZ-Fine-Grained-Design]], [[PDMS-AuthZ-Sync-Strategy-Comparison]], [[MOC-Auth-Security]]"
created: 2026-04-15
updated: 2026-04-15
---

# 🏛️ IAM Multi-Domain Authorization — Thiết Kế Mở Rộng

> **Context:** IAM service phục vụ nhiều domain nghiệp vụ trong VPBank (PDMS, Warehouse/TSDB, và tương lai thêm domain mới). Authorization logic giữa các domain **khác hoàn toàn** — resource types, actions, permission rules đều khác. Cần thiết kế để mở rộng cả theo chiều ngang (thêm domain mới) lẫn chiều dọc (ABAC phức tạp hơn) mà **không cần ALTER TABLE hay deploy lại IAM**.

---

## 🔴 Vấn đề với Schema Hiện Tại

Schema cũ hardcode domain vào schema — không mở rộng được:

```sql
-- Vấn đề 1: Domain hardcode vào CHECK constraint
dept_type VARCHAR(20) CHECK (dept_type IN ('SHARED', 'CHUNG_TU', 'TSDB'))
role.domain VARCHAR(50) CHECK (domain IN ('PDMS', 'TSDB', 'SHARED'))
-- → Thêm domain LEGAL: phải ALTER TABLE, deploy lại IAM

-- Vấn đề 2: Resource type hardcode thành bảng riêng
user_dept_access (user_id, dept_id)
user_kho_access  (user_id, kho_id)
-- → Warehouse thêm resource "tai_san": phải thêm bảng user_tsan_access

-- Vấn đề 3: Permission rule không thể express cross-domain
-- PDMS: MAKER → CHECKER → APPROVER workflow
-- Warehouse: custody_holder → verifier → custodian — rule khác hoàn toàn
-- Không có chỗ để model hai rule set độc lập
```

---

## 🎯 Design Principles

1. **Domain là first-class citizen** — mọi thứ scoped theo domain
2. **Resource scope generic** — không hardcode resource type thành bảng riêng
3. **Permission model per-domain** — PDMS và Warehouse có policy engine riêng
4. **Shared identity layer** — user identity dùng chung, authorization isolated
5. **Open/Closed** — thêm domain mới không cần sửa schema core, chỉ thêm data

---

## 🏗️ Architecture: 3 Tầng IAM

```
┌─────────────────────────────────────────────────────────────────┐
│  Tầng 1: Identity (shared across all domains)                   │
│  iam.users — mapping keycloak_sub → internal user               │
│  Không thay đổi khi thêm domain mới                             │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│  Tầng 2: Domain Registry (data-driven, không cần ALTER TABLE)   │
│  iam.domains          — PDMS, WAREHOUSE, LEGAL...               │
│  iam.resource_types   — DEPARTMENT, KHO, TAI_SAN, HOP_DONG...  │
│  iam.actions          — CREATE, READ, APPROVE, TRANSFER...      │
│  iam.roles            — scoped per domain                       │
│  iam.permissions      — (domain, resource_type, action) tuple   │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│  Tầng 3: Assignment & Policy (domain-isolated)                  │
│  iam.user_domain_roles       — user có role gì trong domain nào │
│  iam.user_resource_scope     — user được phép xem resource nào  │
│  iam.domain_policies         — ABAC rule engine per domain      │
│  iam.resource_catalog        — registry các resource instance   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🗄️ Schema Đầy Đủ (`iam_db`)

### Tầng 1 — Identity

```sql
CREATE TABLE iam.users (
    id           BIGSERIAL PRIMARY KEY,
    keycloak_sub VARCHAR(36) UNIQUE NOT NULL,
    username     VARCHAR(100) NOT NULL,
    email        VARCHAR(200),
    is_active    BOOLEAN DEFAULT true,
    synced_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_users_ksub ON iam.users(keycloak_sub);
```

### Tầng 2 — Domain Registry

```sql
-- ============ DOMAIN ============
-- Thêm domain mới = INSERT, không cần ALTER TABLE
CREATE TABLE iam.domains (
    id          BIGSERIAL PRIMARY KEY,
    code        VARCHAR(50) UNIQUE NOT NULL,
    name        VARCHAR(200) NOT NULL,
    description TEXT,
    is_active   BOOLEAN DEFAULT true,
    created_at  TIMESTAMP DEFAULT NOW()
);

INSERT INTO iam.domains (code, name) VALUES
    ('PDMS',      'Quản lý chứng từ vật lý'),
    ('WAREHOUSE', 'Quản lý tài sản bảo đảm & kho');
-- Tương lai: ('LEGAL', 'Pháp chế'), ('CREDIT', 'Tín dụng')

-- ============ RESOURCE TYPES (per domain) ============
CREATE TABLE iam.resource_types (
    id              BIGSERIAL PRIMARY KEY,
    domain_id       BIGINT NOT NULL REFERENCES iam.domains(id),
    code            VARCHAR(100) NOT NULL,
    name            VARCHAR(200) NOT NULL,
    is_hierarchical BOOLEAN DEFAULT false,
    UNIQUE (domain_id, code)
);

INSERT INTO iam.resource_types (domain_id, code, name, is_hierarchical) VALUES
    (1, 'DEPARTMENT', 'Phòng ban',             true),
    (1, 'KHO',        'Kho vật lý',            false),
    (1, 'TEAM',       'Team nghiệp vụ',         false);

INSERT INTO iam.resource_types (domain_id, code, name) VALUES
    (2, 'KHO',      'Kho tài sản bảo đảm'),
    (2, 'TAI_SAN',  'Tài sản bảo đảm'),
    (2, 'HOP_DONG', 'Hợp đồng thế chấp');
-- KHO trong PDMS (id=2) và KHO trong WAREHOUSE (id=5) là 2 resource type khác nhau
-- Cùng tên, domain_id khác → access rule hoàn toàn độc lập

-- ============ ACTIONS ============
CREATE TABLE iam.actions (
    id        BIGSERIAL PRIMARY KEY,
    domain_id BIGINT REFERENCES iam.domains(id),  -- NULL = shared
    code      VARCHAR(100) NOT NULL,
    name      VARCHAR(200) NOT NULL,
    UNIQUE (COALESCE(domain_id, 0), code)
);

-- Shared
INSERT INTO iam.actions (domain_id, code, name) VALUES
    (NULL, 'READ',   'Xem'),
    (NULL, 'CREATE', 'Tạo mới'),
    (NULL, 'UPDATE', 'Chỉnh sửa'),
    (NULL, 'DELETE', 'Xoá');

-- PDMS-specific
INSERT INTO iam.actions (domain_id, code, name) VALUES
    (1, 'APPROVE',  'Duyệt đề nghị'),
    (1, 'REJECT',   'Từ chối'),
    (1, 'TRANSFER', 'Bàn giao chứng từ'),
    (1, 'BORROW',   'Mượn chứng từ'),
    (1, 'RETURN',   'Trả chứng từ'),
    (1, 'EXTEND',   'Gia hạn mượn');

-- WAREHOUSE-specific
INSERT INTO iam.actions (domain_id, code, name) VALUES
    (2, 'TAKE_CUSTODY',    'Nhận tài sản vào kho'),
    (2, 'RELEASE_CUSTODY', 'Xuất tài sản khỏi kho'),
    (2, 'VERIFY',          'Xác minh tài sản'),
    (2, 'REVALUE',         'Định giá lại');

-- ============ ROLES (per domain) ============
CREATE TABLE iam.roles (
    id          BIGSERIAL PRIMARY KEY,
    domain_id   BIGINT NOT NULL REFERENCES iam.domains(id),
    code        VARCHAR(100) NOT NULL,
    name        VARCHAR(200) NOT NULL,
    description TEXT,
    is_active   BOOLEAN DEFAULT true,
    UNIQUE (domain_id, code)
);

INSERT INTO iam.roles (domain_id, code, name) VALUES
    (1, 'MAKER',    'Người tạo đề nghị'),
    (1, 'CHECKER',  'Người kiểm tra'),
    (1, 'APPROVER', 'Người phê duyệt'),
    (1, 'ADMIN',    'Quản trị viên PDMS'),
    (1, 'VIEWER',   'Người xem');

INSERT INTO iam.roles (domain_id, code, name) VALUES
    (2, 'CUSTODY_HOLDER', 'Người giữ tài sản'),
    (2, 'VERIFIER',       'Người xác minh'),
    (2, 'CUSTODIAN',      'Thủ kho'),
    (2, 'KHO_ADMIN',      'Quản trị viên kho'),
    (2, 'APPRAISER',      'Người định giá');

-- ============ PERMISSIONS ============
CREATE TABLE iam.permissions (
    id               BIGSERIAL PRIMARY KEY,
    domain_id        BIGINT NOT NULL REFERENCES iam.domains(id),
    resource_type_id BIGINT NOT NULL REFERENCES iam.resource_types(id),
    action_id        BIGINT NOT NULL REFERENCES iam.actions(id),
    code             VARCHAR(200) UNIQUE NOT NULL,  -- 'PDMS.DEPARTMENT.READ'
    UNIQUE (domain_id, resource_type_id, action_id)
);

CREATE TABLE iam.role_permissions (
    role_id       BIGINT NOT NULL REFERENCES iam.roles(id),
    permission_id BIGINT NOT NULL REFERENCES iam.permissions(id),
    PRIMARY KEY (role_id, permission_id)
);
```

### Tầng 3 — Assignment & Policy

```sql
-- ============ USER-DOMAIN-ROLE ============
CREATE TABLE iam.user_domain_roles (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES iam.users(id),
    domain_id  BIGINT NOT NULL REFERENCES iam.domains(id),
    role_id    BIGINT NOT NULL REFERENCES iam.roles(id),
    scope_type VARCHAR(50),   -- 'DEPARTMENT', 'KHO', NULL = global trong domain
    scope_id   BIGINT,
    granted_by BIGINT REFERENCES iam.users(id),
    granted_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    is_active  BOOLEAN DEFAULT true,
    UNIQUE (user_id, domain_id, role_id, COALESCE(scope_id, 0))
);
CREATE INDEX idx_udr_user_domain ON iam.user_domain_roles(user_id, domain_id, is_active);

-- ============ USER-RESOURCE-SCOPE ============
-- Generic: thay thế hoàn toàn user_dept_access + user_kho_access
-- Chi tiết thiết kế: xem section 🔬 bên dưới
CREATE TABLE iam.user_resource_scope (
    id               BIGSERIAL PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES iam.users(id),
    domain_id        BIGINT NOT NULL REFERENCES iam.domains(id),
    resource_type_id BIGINT NOT NULL REFERENCES iam.resource_types(id),
    resource_id      BIGINT NOT NULL,
    -- resource_id không có FK constraint — resource nằm ở service gốc
    -- Integrity đảm bảo qua resource_catalog + event validation
    access_level     VARCHAR(50) NOT NULL DEFAULT 'FULL',
    -- FULL = toàn quyền, READ_ONLY = chỉ đọc, RESTRICTED = đọc + mask sensitive fields
    granted_by       BIGINT REFERENCES iam.users(id),
    granted_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMP,        -- NULL = không hết hạn
    is_active        BOOLEAN NOT NULL DEFAULT true,
    grant_reason     TEXT,
    _last_event_id   UUID,             -- idempotency key
    UNIQUE (user_id, domain_id, resource_type_id, resource_id)
);

-- Index chính: lookup "user X có scope resource type Y nào trong domain Z?"
CREATE INDEX idx_urs_lookup
    ON iam.user_resource_scope(user_id, domain_id, resource_type_id, is_active)
    WHERE is_active = true;

-- Index phụ: revoke hàng loạt khi resource bị deactivate
CREATE INDEX idx_urs_resource
    ON iam.user_resource_scope(domain_id, resource_type_id, resource_id)
    WHERE is_active = true;

-- ============ RESOURCE CATALOG ============
-- Shadow copy metadata của resources từ các service
-- Không chứa business data — đủ để validate và display trong IAM admin UI
CREATE TABLE iam.resource_catalog (
    id               BIGSERIAL PRIMARY KEY,
    domain_id        BIGINT NOT NULL REFERENCES iam.domains(id),
    resource_type_id BIGINT NOT NULL REFERENCES iam.resource_types(id),
    external_id      BIGINT NOT NULL,   -- ID trong service gốc
    code             VARCHAR(100),
    name             VARCHAR(300) NOT NULL,
    parent_id        BIGINT REFERENCES iam.resource_catalog(id),
    metadata         JSONB,
    is_active        BOOLEAN NOT NULL DEFAULT true,
    synced_at        TIMESTAMP DEFAULT NOW(),
    UNIQUE (domain_id, resource_type_id, external_id)
);
CREATE INDEX idx_rc_domain_type ON iam.resource_catalog(domain_id, resource_type_id, is_active);
CREATE INDEX idx_rc_external    ON iam.resource_catalog(domain_id, resource_type_id, external_id);

-- ============ DOMAIN POLICIES ============
CREATE TABLE iam.domain_policies (
    id          BIGSERIAL PRIMARY KEY,
    domain_id   BIGINT NOT NULL REFERENCES iam.domains(id),
    name        VARCHAR(200) NOT NULL,
    rule_type   VARCHAR(50) NOT NULL,
    rule_config JSONB NOT NULL,
    effect      VARCHAR(10) DEFAULT 'ALLOW' CHECK (effect IN ('ALLOW', 'DENY')),
    priority    INT DEFAULT 0,
    is_active   BOOLEAN DEFAULT true
);

-- ============ KHO SNAPSHOT ============
CREATE TABLE iam.kho_snapshot (
    id              BIGINT PRIMARY KEY,
    catalog_id      BIGINT REFERENCES iam.resource_catalog(id),
    code            VARCHAR(50),
    name            VARCHAR(200) NOT NULL,
    location        VARCHAR(500),
    capacity        INT,
    domain_id       BIGINT NOT NULL REFERENCES iam.domains(id),
    is_active       BOOLEAN DEFAULT true,
    _synced_at      TIMESTAMP DEFAULT NOW(),
    _source_version BIGINT
);

-- ============ OUTBOX ============
CREATE TABLE iam.outbox_events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id    BIGINT REFERENCES iam.domains(id),
    event_type   VARCHAR(100) NOT NULL,
    keycloak_sub VARCHAR(36),
    payload      JSONB NOT NULL,
    status       VARCHAR(20) DEFAULT 'PENDING',
    created_at   TIMESTAMP DEFAULT NOW(),
    processed_at TIMESTAMP,
    retry_count  INT DEFAULT 0
);
CREATE INDEX idx_outbox_pending ON iam.outbox_events(status, created_at)
    WHERE status = 'PENDING';
```

---

## 🔬 Deep Dive: `user_resource_scope` — Generic Resource Access

### Tại sao generic thay vì flat tables

Schema cũ tạo một bảng mới cho mỗi resource type mới:

```
user_dept_access  (user_id, dept_id)
user_kho_access   (user_id, kho_id)
user_tsan_access  (user_id, tai_san_id)   ← phải thêm khi Warehouse mở rộng
user_hdtc_access  (user_id, hop_dong_id)  ← phải thêm tiếp
```

Mỗi lần thêm resource type: `CREATE TABLE`, migration, code IAM, event format mới, consumer mới. Với `user_resource_scope` generic, tất cả resource type dùng chung một bảng — thêm resource type mới chỉ là `INSERT INTO resource_types`.

### Trade-off thực tế

| | Flat tables | Generic `user_resource_scope` |
|---|---|---|
| Query đơn giản | `WHERE user_id=X AND dept_id=Y` | Cần filter `resource_type_id` |
| Type safety tại DB | FK constraint rõ ràng | `resource_id` là BIGINT không FK |
| Index efficiency | Index trực tiếp trên column | Index composite 4 columns |
| Thêm resource type | CREATE TABLE + migration | INSERT vào `resource_types` |
| Schema drift | Phình theo features | Ổn định |
| Debuggability | Dễ query trực tiếp | Cần biết `resource_type_id` |

**Generic table hợp lý khi:** số resource type còn tăng và muốn tránh schema migration thường xuyên. Bù lại cần thiết kế index và ID caching cẩn thận.

### Application-level ID caching — loại bỏ JOIN overhead

Điểm mấu chốt để generic table không chậm hơn flat table: **cache `domain_id` và `resource_type_id` tại application startup**, không query mỗi request.

```java
@Component
public class IamDomainRegistry {

    // Immutable sau startup — safe to read without lock
    private final Map<String, Long> domainIds        = new ConcurrentHashMap<>();
    private final Map<String, Long> resourceTypeIds  = new ConcurrentHashMap<>();

    @EventListener(ApplicationReadyEvent.class)
    public void loadRegistry() {
        domainRepository.findAll().forEach(d ->
            domainIds.put(d.getCode(), d.getId())
        );
        resourceTypeRepository.findAll().forEach(rt ->
            // key = "PDMS.DEPARTMENT", "WAREHOUSE.KHO", ...
            resourceTypeIds.put(rt.getDomainCode() + "." + rt.getCode(), rt.getId())
        );
        // Kết quả:
        // domainIds:       { "PDMS"→1, "WAREHOUSE"→2 }
        // resourceTypeIds: { "PDMS.DEPARTMENT"→3, "PDMS.KHO"→4, "WAREHOUSE.KHO"→7 }
    }

    public long domainId(String code) {
        return domainIds.computeIfAbsent(code,
            k -> domainRepository.findByCode(k).getId());
    }

    public long resourceTypeId(String domainCode, String typeCode) {
        return resourceTypeIds.computeIfAbsent(
            domainCode + "." + typeCode,
            k -> resourceTypeRepository.findByDomainAndCode(domainCode, typeCode).getId()
        );
    }
}
```

Query tại service layer — không có JOIN nào:

```java
public Set<Long> getAllowedDeptIds(Long userId) {
    return userResourceScopeRepository.findResourceIds(
        userId,
        registry.domainId("PDMS"),                    // = 1, từ cache
        registry.resourceTypeId("PDMS", "DEPARTMENT") // = 3, từ cache
    );
    // SQL: WHERE user_id=? AND domain_id=1 AND resource_type_id=3 AND is_active=true
    // → Chỉ index scan trên idx_urs_lookup, không JOIN
}
```

### Query patterns

```sql
-- Pattern 1: Lấy tất cả dept IDs user được phép
SELECT resource_id
FROM iam.user_resource_scope
WHERE user_id          = :userId
  AND domain_id        = 1   -- PDMS, từ app cache
  AND resource_type_id = 3   -- DEPARTMENT, từ app cache
  AND is_active        = true;
-- → idx_urs_lookup (partial index) — sub-ms

-- Pattern 2: Check một resource cụ thể
SELECT 1
FROM iam.user_resource_scope
WHERE user_id          = :userId
  AND domain_id        = 1
  AND resource_type_id = 3
  AND resource_id      = :deptId
  AND is_active        = true
LIMIT 1;

-- Pattern 3: Revoke hàng loạt khi dept bị deactivate
UPDATE iam.user_resource_scope
SET    is_active = false, _last_event_id = :eventId
WHERE  domain_id        = 1
  AND  resource_type_id = 3
  AND  resource_id      = :deactivatedDeptId
  AND  is_active        = true;
-- → idx_urs_resource — sau đó IAM publish event cascade revoke xuống services
```

### Cascade revoke khi resource bị deactivate

```java
@Transactional
public void deactivateDepartment(Long deptId) {
    // 1. Deactivate trong resource_catalog
    resourceCatalogRepo.deactivate(deptId, "PDMS", "DEPARTMENT");

    // 2. Revoke tất cả user scope tới dept này
    List<String> affectedSubs = userResourceScopeRepo
        .findAffectedUsers(domainId("PDMS"), resourceTypeId("PDMS","DEPARTMENT"), deptId);

    userResourceScopeRepo.deactivateByResource(
        domainId("PDMS"), resourceTypeId("PDMS","DEPARTMENT"), deptId
    );

    // 3. Publish event — PDMS/Report consumer update authz_local
    outboxRepo.save(new OutboxEvent("USER_RESOURCE_SCOPE_CHANGED",
        buildRevokeAllEvent("PDMS", "DEPARTMENT", deptId, affectedSubs)
    ));
}
```

### `resource_catalog` — giải quyết vấn đề integrity

Vì `resource_id` không có FK constraint (resource nằm ở service khác), `resource_catalog` là registry trung gian để validate:

```java
// Khi admin gán scope, validate trước khi insert
public void grantResourceScope(String targetSub, String domainCode,
                                String resourceTypeCode, Long resourceId) {
    // Validate resource tồn tại và đang active
    boolean exists = resourceCatalogRepo.exists(
        domainId(domainCode),
        resourceTypeId(domainCode, resourceTypeCode),
        resourceId
    );
    if (!exists) throw new ResourceNotFoundException(
        "Resource %s/%s/%d not found or inactive"
            .formatted(domainCode, resourceTypeCode, resourceId)
    );
    // proceed with grant...
}
```

`resource_catalog` được populate bởi services publish events khi resource thay đổi — `pdms-service` publish khi tạo department, `warehouse-service` publish khi tạo kho.

---

## 🧠 Domain-Scoped Permission Resolution

### Cách cũ (hardcode, không mở rộng được)

```sql
SELECT dept_id FROM authz_local.user_dept_access
WHERE user_sub = :sub
  AND dept_type IN ('SHARED', 'CHUNG_TU')  -- hardcode domain logic
  AND is_active = true
```

### Cách mới tại IAM service (với JOIN — dùng cho admin UI, audit)

```sql
-- Lấy tất cả departments user được phép trong domain PDMS
SELECT urs.resource_id AS dept_id, urs.access_level
FROM   iam.user_resource_scope urs
WHERE  urs.user_id          = (SELECT id FROM iam.users WHERE keycloak_sub = :sub)
  AND  urs.domain_id        = 1   -- app cache: PDMS = 1
  AND  urs.resource_type_id = 3   -- app cache: PDMS.DEPARTMENT = 3
  AND  urs.is_active        = true;
```

### Cách mới tại `authz_local` trong pdms_db (zero RTT — dùng cho business queries)

```sql
-- authz_local dùng string codes thay vì numeric IDs — dễ đọc, không cần cache mapping
SELECT resource_id AS dept_id
FROM   authz_local.user_resource_scope
WHERE  user_sub      = :keycloakSub
  AND  resource_type = 'DEPARTMENT'
  AND  is_active     = true;
```

**Thêm domain LEGAL mới:** `INSERT INTO domains` + `INSERT INTO resource_types` + define roles/permissions. Schema core không đổi, không redeploy IAM.

---

## 🏗️ `authz_local` trong pdms_db

Consumer tại `pdms-service` maintain bảng local — zero-RTT query, isolation hoàn toàn:

```sql
CREATE SCHEMA authz_local;

-- Dùng string code thay vì numeric ID của IAM — pdms-service không cần biết IAM internal IDs
CREATE TABLE authz_local.user_resource_scope (
    id            BIGSERIAL PRIMARY KEY,
    user_sub      VARCHAR(36) NOT NULL,
    resource_type VARCHAR(50) NOT NULL,   -- 'DEPARTMENT', 'KHO', 'TEAM'
    resource_id   BIGINT NOT NULL,
    access_level  VARCHAR(50) NOT NULL DEFAULT 'FULL',
    is_active     BOOLEAN NOT NULL DEFAULT true,
    _event_id     UUID,
    _synced_at    TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_sub, resource_type, resource_id)
);

CREATE TABLE authz_local.user_roles (
    id         BIGSERIAL PRIMARY KEY,
    user_sub   VARCHAR(36) NOT NULL,
    role_code  VARCHAR(100) NOT NULL,   -- 'MAKER', 'CHECKER', 'APPROVER'
    scope_type VARCHAR(50),
    scope_id   BIGINT,
    is_active  BOOLEAN NOT NULL DEFAULT true,
    _synced_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_sub, role_code, COALESCE(scope_id, 0))
);

CREATE INDEX idx_al_urs_lookup
    ON authz_local.user_resource_scope(user_sub, resource_type, is_active)
    WHERE is_active = true;

CREATE INDEX idx_al_urs_resource
    ON authz_local.user_resource_scope(resource_type, resource_id)
    WHERE is_active = true;

CREATE INDEX idx_al_roles_sub
    ON authz_local.user_roles(user_sub, is_active)
    WHERE is_active = true;
```

**pdms-service chỉ nhận events `domainCode = "PDMS"`** → `authz_local` chỉ chứa data PDMS domain. `warehouse-service` có `authz_local` riêng chứa WAREHOUSE domain data.

### Business query với authz_local

```sql
-- List đề nghị — zero RTT, zero JOIN ngoài pdms_db
SELECT dn.*
FROM   pdms.de_nghi dn
WHERE  dn.dept_id IN (
           SELECT resource_id
           FROM   authz_local.user_resource_scope
           WHERE  user_sub      = :keycloakSub
             AND  resource_type = 'DEPARTMENT'
             AND  is_active     = true
       )
  AND  dn.kho_id IN (
           SELECT resource_id
           FROM   authz_local.user_resource_scope
           WHERE  user_sub      = :keycloakSub
             AND  resource_type = 'KHO'
             AND  is_active     = true
       )
  AND  dn.status = :status
  AND  dn.id > :lastId
ORDER BY dn.id ASC
LIMIT 5000;
```

### Consumer — domain filter + idempotency

```java
@KafkaListener(topics = "iam.permission-changed", groupId = "pdms-authz-sync")
@Transactional
public void onPermissionChanged(UserResourceScopeChangedEvent event) {
    // Isolation: chỉ xử lý PDMS events
    if (!"PDMS".equals(event.domainCode())) return;

    // Idempotency
    if (authzLocalRepo.eventProcessed(event.id())) return;

    for (ResourceScopeChange change : event.changes()) {
        switch (change.action()) {
            case "GRANTED" -> authzLocalRepo.upsert(
                event.keycloakSub(),
                change.resourceTypeCode(),  // "DEPARTMENT", "KHO" — string, readable
                change.resourceId(),
                change.accessLevel(),
                event.id()
            );
            case "REVOKED" -> authzLocalRepo.deactivate(
                event.keycloakSub(),
                change.resourceTypeCode(),
                change.resourceId()
            );
        }
    }
}
```

---

## 📤 Kafka Event Format

```json
{
  "id": "550e8400-e29b-uuid",
  "eventType": "USER_RESOURCE_SCOPE_CHANGED",
  "domainCode": "PDMS",
  "keycloakSub": "a1b2c3d4-uuid",
  "changes": [
    {
      "resourceTypeCode": "DEPARTMENT",
      "resourceId": 10,
      "action": "GRANTED",
      "accessLevel": "FULL"
    },
    {
      "resourceTypeCode": "KHO",
      "resourceId": 5,
      "action": "REVOKED"
    },
    {
      "resourceTypeCode": "DEPARTMENT",
      "resourceId": 20,
      "action": "GRANTED",
      "accessLevel": "READ_ONLY"
    }
  ],
  "changedAt": "2026-04-15T10:00:00Z",
  "changedBy": "admin-keycloak-sub"
}
```

Event mang `domainCode` → consumer tự filter, không cần topic riêng per domain.

---

## 🔐 Domain Policy Engine (ABAC)

### PDMS Policies

```json
[
  {
    "name": "Maker chỉ tạo đề nghị trong dept của mình",
    "ruleType": "SAME_DEPT_REQUIRED",
    "ruleConfig": { "applies_to_action": "DE_NGHI.CREATE", "requires_scope": "DEPARTMENT" },
    "effect": "ALLOW"
  },
  {
    "name": "Checker không tự approve đề nghị do mình tạo",
    "ruleType": "SELF_EXCLUSION",
    "ruleConfig": { "applies_to_action": "DE_NGHI.APPROVE", "exclude_if": "resource.creator_id == user.id" },
    "effect": "DENY"
  }
]
```

### WAREHOUSE Policies (khác hoàn toàn)

```json
[
  {
    "name": "Appraiser chỉ định giá tài sản dưới 10 tỷ",
    "ruleType": "VALUE_LIMIT",
    "ruleConfig": { "applies_to_action": "TAI_SAN.REVALUE", "condition": "asset.current_value < 10000000000" },
    "effect": "ALLOW"
  },
  {
    "name": "Custodian chỉ nhận tài sản vào kho mình quản lý",
    "ruleType": "SCOPE_REQUIRED",
    "ruleConfig": { "applies_to_action": "TAI_SAN.TAKE_CUSTODY", "scope_type": "KHO" },
    "effect": "ALLOW"
  }
]
```

### Policy evaluator

```java
@Service
public class DomainPolicyEvaluator {

    // Chỉ gọi cho high-stakes operations (approve, transfer)
    public boolean evaluate(String keycloakSub, String domainCode,
                            String action, Map<String, Object> context) {
        List<DomainPolicy> policies = policyRepo
            .findActiveByDomainAndAction(domainCode, action);

        for (DomainPolicy policy : policies) {
            if (evaluatePolicy(policy, keycloakSub, context) == PolicyResult.DENY)
                return false;  // DENY wins
        }
        return policies.stream().anyMatch(p -> "ALLOW".equals(p.getEffect()));
    }

    private PolicyResult evaluatePolicy(DomainPolicy p, String sub, Map<String, Object> ctx) {
        return switch (p.getRuleType()) {
            case "SAME_DEPT_REQUIRED" -> evaluateSameDept(p, sub, ctx);
            case "SELF_EXCLUSION"     -> evaluateSelfExclusion(p, sub, ctx);
            case "VALUE_LIMIT"        -> evaluateValueLimit(p, sub, ctx);
            case "SCOPE_REQUIRED"     -> evaluateScopeRequired(p, sub, ctx);
            default -> throw new UnsupportedRuleTypeException(p.getRuleType());
            // Thêm rule type mới: chỉ thêm case, không ALTER TABLE
        };
    }
}
```

---

## 🔄 Migration từ Schema Cũ

```
Phase 1 — Dual write:
  Giữ schema cũ (dept_type hardcode) tiếp tục chạy
  IAM service ghi song song vào cả schema cũ và schema mới
  Services vẫn đọc từ authz_local cũ

Phase 2 — Shadow validation:
  Services đọc từ authz_local mới (resource_type generic)
  So sánh kết quả với schema cũ — alert nếu diff
  Chạy ít nhất 1 tuần để đảm bảo không mất data

Phase 3 — Cutover:
  Drop schema cũ (user_dept_access, user_kho_access)
  Remove dept_type hardcode khỏi tất cả queries
  Remove dual-write khỏi IAM service
```

---

## 📊 So Sánh: Cũ vs Mới

| Khía cạnh | Schema cũ | Schema mới |
|---|---|---|
| Thêm domain LEGAL | ALTER TABLE + redeploy | INSERT vào `domains` + `resource_types` |
| Thêm resource type TAI_SAN | CREATE TABLE `user_tsan_access` | INSERT vào `resource_types` |
| Rule ABAC per domain | Hardcode trong Java | JSON config trong `domain_policies` |
| User có nhiều domain | Role prefix `'PDMS_MAKER'` | `user_domain_roles.domain_id` scoped |
| authz_local isolation | `dept_type` filter (coupling) | Consumer filter theo `domainCode` |
| Cross-domain resource sharing | `dept_type='SHARED'` hardcode | `resource_catalog.metadata` flexible |
| Type safety resource_id | FK constraint | resource_catalog validation |
| Query performance | Flat table, đơn giản | Partial index + app-level ID cache |

---

## 🔗 Links

- [[PDMS-Architecture-Overview]] — toàn cảnh
- [[PDMS-AuthZ-Fine-Grained-Design]] — schema v1 (trước refactor)
- [[PDMS-AuthZ-Sync-Strategy-Comparison]] — Kafka Events vs CDC
- [[PDMS-Workflow-Optimal-Communication]] — 5 workflow chi tiết
- [[MOC-Auth-Security]] — auth patterns hub
- [[MOC-PDMS]] — project hub
