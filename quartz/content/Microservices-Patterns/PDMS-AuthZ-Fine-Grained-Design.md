---
tags: [pdms, vpbank, authz, iam, fine-grained, department, permission, rbac, abac, keycloak]
up: "[[PDMS-Architecture-Overview]]"
related: "[[Cross-Service-Join-AuthZ-Fine-Grained-Filter]], [[MOC-Auth-Security]], [[PDMS-AuthZ-Sync-Strategy-Comparison]]"
created: 2026-04-15
---

# 🔐 PDMS — IAM Service & Fine-Grained Authorization Design

> **TL;DR:** IAM service là single source of truth cho phân quyền PDMS. Keycloak là external SSO enterprise-wide với database riêng — IAM bridge Keycloak identity sang PDMS authorization. Services dùng `keycloak_sub` (UUID) làm lookup key vào `authz_local` table được sync từ IAM qua Kafka events (không dùng CDC/Debezium).

---

## 🔑 Keycloak vs IAM — Phân tách rõ vai trò

```
┌─────────────────────────────────────────────────────────────┐
│  Keycloak (external, enterprise-wide)                        │
│  keycloak_db — database riêng, không thuộc PDMS infra       │
│                                                              │
│  Quản lý: identity, credentials, sessions, MFA              │
│  Cấp: JWT { sub: "uuid", email, basic_roles, exp }          │
│  KHÔNG biết: dept của user, kho access, PDMS permission      │
└──────────────────────────────┬──────────────────────────────┘
                               │ JWT (sub = Keycloak UUID)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  IAM Service (internal, thuộc PDMS)                          │
│  iam_db — database riêng của IAM service                     │
│                                                              │
│  Quản lý: authorization (WHAT + WHERE)                       │
│  Bridge: keycloak_sub → dept/kho/role/permission             │
│  Publish: Kafka events khi permission thay đổi              │
└─────────────────────────────────────────────────────────────┘
```

**Keycloak chỉ được dùng để:**
1. User authentication (login, session, MFA)
2. JWT issuance
3. Gateway verify JWT signature (JWKS endpoint — stateless)

**IAM service chịu trách nhiệm toàn bộ authorization của PDMS.**

---

## 🗄️ IAM Database Schema (`iam_db`)

```sql
-- ============ USER MAPPING (Bridge Keycloak → IAM) ============
-- IAM không quản lý credentials, chỉ quản lý authorization mapping
CREATE TABLE iam.users (
    id              BIGSERIAL PRIMARY KEY,
    keycloak_sub    VARCHAR(36) UNIQUE NOT NULL,  -- Keycloak JWT 'sub' claim (UUID)
    username        VARCHAR(100) NOT NULL,
    email           VARCHAR(200),
    is_active       BOOLEAN DEFAULT true,
    synced_at       TIMESTAMP DEFAULT NOW()       -- last sync từ Keycloak user event
);
-- Index quan trọng: gateway forward keycloak_sub, services dùng để lookup
CREATE INDEX idx_users_keycloak_sub ON iam.users(keycloak_sub);

-- ============ DEPARTMENT ============
-- 1000 departments, phân loại theo domain
CREATE TABLE iam.department (
    id          BIGSERIAL PRIMARY KEY,
    code        VARCHAR(50) UNIQUE NOT NULL,
    name        VARCHAR(200) NOT NULL,
    dept_type   VARCHAR(20) NOT NULL
                CHECK (dept_type IN ('SHARED', 'CHUNG_TU', 'TSDB')),
    parent_id   BIGINT REFERENCES iam.department(id),
    is_active   BOOLEAN DEFAULT true
);
CREATE INDEX idx_dept_type_active ON iam.department(dept_type, is_active);

-- ============ ROLE ============
CREATE TABLE iam.role (
    id          BIGSERIAL PRIMARY KEY,
    code        VARCHAR(100) UNIQUE NOT NULL,
    -- Ví dụ: 'PDMS_MAKER', 'PDMS_CHECKER', 'KHO_ADMIN', 'TSDB_MAKER'
    name        VARCHAR(200) NOT NULL,
    domain      VARCHAR(50) NOT NULL CHECK (domain IN ('PDMS', 'TSDB', 'SHARED')),
    description TEXT
);

-- ============ TEAM ============
CREATE TABLE iam.team (
    id      BIGSERIAL PRIMARY KEY,
    code    VARCHAR(100) UNIQUE NOT NULL,
    name    VARCHAR(200) NOT NULL,
    dept_id BIGINT NOT NULL REFERENCES iam.department(id),
    is_active BOOLEAN DEFAULT true
);

-- ============ PERMISSION (fine-grained actions) ============
CREATE TABLE iam.permission (
    id       BIGSERIAL PRIMARY KEY,
    code     VARCHAR(200) UNIQUE NOT NULL,
    -- 'DE_NGHI.CREATE', 'DE_NGHI.APPROVE', 'MUON_TRA.CREATE', 'KHO.READ'
    resource VARCHAR(100) NOT NULL,   -- 'DE_NGHI', 'CASE_PDM', 'KHO'
    action   VARCHAR(50) NOT NULL,    -- 'CREATE', 'READ', 'APPROVE', 'TRANSFER'
    domain   VARCHAR(50) NOT NULL
);

-- ============ USER-DEPT-ACCESS (row-level data scope) ============
CREATE TABLE iam.user_dept_access (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES iam.users(id),
    dept_id     BIGINT NOT NULL REFERENCES iam.department(id),
    access_type VARCHAR(50) DEFAULT 'FULL',  -- FULL, READ_ONLY
    granted_by  BIGINT REFERENCES iam.users(id),
    granted_at  TIMESTAMP DEFAULT NOW(),
    is_active   BOOLEAN DEFAULT true,
    UNIQUE (user_id, dept_id)
);
CREATE INDEX idx_uda_user_active ON iam.user_dept_access(user_id, is_active);

-- ============ USER-KHO-ACCESS ============
CREATE TABLE iam.user_kho_access (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES iam.users(id),
    kho_id      BIGINT NOT NULL,  -- reference sang kho_snapshot.id (no FK constraint)
    access_type VARCHAR(50) DEFAULT 'FULL',
    is_active   BOOLEAN DEFAULT true,
    UNIQUE (user_id, kho_id)
);
CREATE INDEX idx_uka_user_active ON iam.user_kho_access(user_id, is_active);

-- ============ USER-ROLE ============
CREATE TABLE iam.user_role (
    user_id    BIGINT NOT NULL REFERENCES iam.users(id),
    role_id    BIGINT NOT NULL REFERENCES iam.role(id),
    dept_id    BIGINT REFERENCES iam.department(id),  -- optional scope
    is_active  BOOLEAN DEFAULT true,
    PRIMARY KEY (user_id, role_id, COALESCE(dept_id, 0))
);

-- ============ ROLE-PERMISSION ============
CREATE TABLE iam.role_permission (
    role_id       BIGINT NOT NULL REFERENCES iam.role(id),
    permission_id BIGINT NOT NULL REFERENCES iam.permission(id),
    PRIMARY KEY (role_id, permission_id)
);

-- ============ PERMISSION CHANGE LOG (dùng cho Scheduled Pull fallback) ============
-- Cũng là source of truth để bootstrap khi Kafka unavailable
CREATE TABLE iam.permission_change_log (
    id              BIGSERIAL PRIMARY KEY,
    keycloak_sub    VARCHAR(36) NOT NULL,  -- publish sub, không internal ID
    change_type     VARCHAR(50) NOT NULL,  -- 'DEPT_GRANTED', 'DEPT_REVOKED', 'KHO_GRANTED'
    dept_id         BIGINT,
    kho_id          BIGINT,
    dept_type       VARCHAR(20),           -- denormalized để consumer không cần join
    action_type     VARCHAR(50),           -- FULL, READ_ONLY
    changed_at      TIMESTAMP DEFAULT NOW(),
    changed_by      VARCHAR(36)            -- admin keycloak_sub
);
CREATE INDEX idx_pcl_changed_at ON iam.permission_change_log(changed_at DESC);
CREATE INDEX idx_pcl_sub ON iam.permission_change_log(keycloak_sub, changed_at DESC);

-- ============ KHO SNAPSHOT (sync từ warehouse-service qua Kafka) ============
CREATE TABLE iam.kho_snapshot (
    id              BIGINT PRIMARY KEY,   -- kho_id gốc từ warehouse_db
    code            VARCHAR(50) NOT NULL,
    name            VARCHAR(200) NOT NULL,
    location        VARCHAR(500),
    capacity        INT,
    is_active       BOOLEAN DEFAULT true,
    _synced_at      TIMESTAMP DEFAULT NOW(),
    _source_version BIGINT                -- version từ warehouse để detect stale update
);

-- ============ OUTBOX (Transactional Outbox cho IAM events) ============
CREATE TABLE iam.outbox_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      VARCHAR(100) NOT NULL,
    keycloak_sub    VARCHAR(36),
    payload         JSONB NOT NULL,
    status          VARCHAR(20) DEFAULT 'PENDING',
    created_at      TIMESTAMP DEFAULT NOW(),
    processed_at    TIMESTAMP,
    retry_count     INT DEFAULT 0
);
CREATE INDEX idx_iam_outbox_pending ON iam.outbox_events(status, created_at)
    WHERE status = 'PENDING';
```

---

## 🎯 Permission Model: RBAC + ABAC

```
Authorization = WHAT (RBAC: role → permission) + WHERE (ABAC: data scope)

WHAT: User A có role PDMS_MAKER
      → PDMS_MAKER có permission DE_NGHI.CREATE
      → User A được tạo đề nghị

WHERE: Đề nghị thuộc dept_id=10, kho_id=5
       → user_dept_access: A có access dept_id=10?
       → user_kho_access: A có access kho_id=5?
       → Cả hai YES → ALLOWED
```

### Permission matrix

| Role | Permissions |
|---|---|
| `PDMS_MAKER` | `DE_NGHI.CREATE`, `DE_NGHI.READ`, `MUON_TRA.CREATE`, `CASE_PDM.READ` |
| `PDMS_CHECKER` | `DE_NGHI.READ`, `DE_NGHI.APPROVE`, `DE_NGHI.REJECT`, `MUON_TRA.APPROVE` |
| `PDMS_ADMIN` | `DE_NGHI.*`, `CASE_PDM.*`, `KHO.READ`, `THUNG.MANAGE`, `TAP.MANAGE` |
| `KHO_ADMIN` | `KHO.*`, `DE_NGHI.READ` |
| `TSDB_MAKER` | `TSDB_DE_NGHI.CREATE`, `TSDB_CASE.READ` |

---

## 📤 IAM Kafka Events (Outbox pattern)

### Event format: `iam.permission-changed`

```json
{
  "id": "550e8400-uuid",
  "eventType": "USER_DEPT_ACCESS_CHANGED",
  "keycloakSub": "a1b2c3d4-uuid",
  "changes": [
    {
      "deptId": 10,
      "deptType": "SHARED",
      "action": "GRANTED",
      "accessType": "FULL"
    },
    {
      "deptId": 20,
      "action": "REVOKED"
    }
  ],
  "changedAt": "2026-04-15T10:00:00Z",
  "changedBy": "admin-keycloak-sub"
}
```

**Key design decisions trong event:**
- Dùng `keycloakSub` thay vì internal `user_id` → consumer không cần mapping table
- Embed `deptType` → consumer không cần join thêm với department table
- Dùng UUID event ID → idempotency tại consumer side

### IAM Service — publish khi permission thay đổi

```java
@Service
@Transactional
public class PermissionManagementService {

    public void grantDeptAccess(String adminSub, String targetSub,
                                 Long deptId, String accessType) {
        // 1. Lookup user
        User user = userRepository.findByKeycloakSub(targetSub)
            .orElseThrow(() -> new NotFoundException("User not found: " + targetSub));
        Department dept = departmentRepository.findById(deptId)
            .orElseThrow();

        // 2. Update permission
        userDeptAccessRepository.upsert(user.getId(), deptId, accessType);
        permissionChangeLogRepository.save(new PermissionChangeLog(
            targetSub, "DEPT_GRANTED", deptId, dept.getDeptType(), accessType
        ));

        // 3. Outbox event (same transaction — atomic)
        PermissionChangedEvent event = PermissionChangedEvent.builder()
            .keycloakSub(targetSub)
            .change(PermissionChange.granted(deptId, dept.getDeptType(), accessType))
            .build();
        outboxRepository.save(new OutboxEvent("USER_DEPT_ACCESS_CHANGED", event));

        // Transaction commit → outbox publisher sẽ pick up và publish Kafka
    }
}
```

---

## 🏗️ authz_local trong pdms_db (được populate từ IAM events)

```sql
-- Schema riêng, không share với pdms domain tables
CREATE SCHEMA authz_local;

-- Dùng keycloak_sub làm key — không cần IAM internal user_id
CREATE TABLE authz_local.user_dept_access (
    id          BIGSERIAL PRIMARY KEY,
    user_sub    VARCHAR(36) NOT NULL,   -- Keycloak subject UUID
    dept_id     BIGINT NOT NULL,
    dept_type   VARCHAR(20) NOT NULL,   -- SHARED, CHUNG_TU, TSDB (denormalized)
    access_type VARCHAR(50) DEFAULT 'FULL',
    is_active   BOOLEAN DEFAULT true,
    _event_id   UUID,                   -- idempotency: event UUID
    _synced_at  TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_sub, dept_id)
);

CREATE TABLE authz_local.user_kho_access (
    id          BIGSERIAL PRIMARY KEY,
    user_sub    VARCHAR(36) NOT NULL,
    kho_id      BIGINT NOT NULL,
    access_type VARCHAR(50) DEFAULT 'FULL',
    is_active   BOOLEAN DEFAULT true,
    _synced_at  TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_sub, kho_id)
);

-- Index cho query pattern chính: WHERE user_sub = ? AND dept_type IN (...)
CREATE INDEX idx_al_uda_sub ON authz_local.user_dept_access(user_sub, is_active, dept_type);
CREATE INDEX idx_al_uda_dept ON authz_local.user_dept_access(dept_id);
CREATE INDEX idx_al_uka_sub ON authz_local.user_kho_access(user_sub, is_active);
```

### Consumer trong pdms-service

```java
@Component
@Slf4j
public class AuthzLocalSyncConsumer {

    @KafkaListener(
        topics = "iam.permission-changed",
        groupId = "pdms-service-authz-sync"
    )
    @Transactional
    public void onPermissionChanged(PermissionChangedEvent event) {
        // Idempotency check
        if (authzLocalRepo.eventAlreadyProcessed(event.id())) {
            log.debug("Duplicate event {}, skip", event.id());
            return;
        }

        for (PermissionChange change : event.changes()) {
            switch (change.action()) {
                case "GRANTED" -> authzLocalRepo.upsertDeptAccess(
                    event.keycloakSub(),
                    change.deptId(),
                    change.deptType(),    // đã có trong event, không cần join
                    change.accessType(),
                    event.id()
                );
                case "REVOKED" -> authzLocalRepo.deactivateDeptAccess(
                    event.keycloakSub(), change.deptId()
                );
            }
        }
        log.info("Synced {} permission changes for user {}", event.changes().size(), event.keycloakSub());
    }
}
```

### Bootstrap khi deploy lần đầu

```java
@Component
public class AuthzLocalBootstrap {

    @EventListener(ApplicationReadyEvent.class)
    public void bootstrap() {
        long count = authzLocalRepo.count();
        if (count > 0) {
            log.info("authz_local has {} records, skip bootstrap", count);
            return;
        }

        log.info("authz_local empty, bootstrapping from IAM...");
        try (var stream = iamClient.streamBulkExport()) {
            stream.forEach(record -> authzLocalRepo.upsert(record));
        }
        log.info("Bootstrap complete");
    }
}
```

---

## ⚡ Permission check trong write path

```java
@Component
public class DeNghiPermissionGuard {

    // Write operations: query authz_local (local, no RTT)
    public void assertCanCreate(String keycloakSub, Long deptId, Long khoId) {
        // Kiểm tra action permission (roles → permissions)
        // Roles có thể embed trong JWT claim (từ Keycloak) → extract từ SecurityContext
        // Hoặc query authz_local.user_roles nếu cần fine-grained
        boolean hasRole = securityContext.hasRole("PDMS_MAKER");
        if (!hasRole) throw new ForbiddenException("Cần role PDMS_MAKER");

        // Kiểm tra data scope (ABAC) — query authz_local local
        boolean deptAllowed = authzLocalRepo.hasDeptAccess(
            keycloakSub, deptId, List.of("SHARED", "CHUNG_TU")
        );
        if (!deptAllowed) throw new ForbiddenException("Không có quyền trên phòng ban " + deptId);

        boolean khoAllowed = authzLocalRepo.hasKhoAccess(keycloakSub, khoId);
        if (!khoAllowed) throw new ForbiddenException("Không có quyền trên kho " + khoId);
    }

    // High-stakes operations (approve, transfer): sync call IAM
    public void assertCanApprove(String keycloakSub, Long deNghiId) {
        boolean allowed = iamClient.checkPermissionSync(
            keycloakSub, "DE_NGHI.APPROVE", deNghiId, "DE_NGHI"
        );
        if (!allowed) throw new ForbiddenException("Không có quyền duyệt");
    }
}
```

---

## 🔄 Dept Split — 80/10/10

```
1000 departments:
  dept_type = 'SHARED'    → ~800 depts — cả PDMS và TSDB đều thấy
  dept_type = 'CHUNG_TU'  → ~100 depts — chỉ PDMS service filter ra
  dept_type = 'TSDB'      → ~100 depts — chỉ TSDB/Warehouse service filter ra

PDMS query filter:
  dept_type IN ('SHARED', 'CHUNG_TU')

TSDB/Warehouse query filter:
  dept_type IN ('SHARED', 'TSDB')
```

`dept_type` được **denormalized vào `authz_local.user_dept_access`** và vào **Kafka event payload** → consumer không cần join thêm với department table.

---

## 📊 Monitoring

```yaml
# Key metrics
iam.outbox.pending_count          # alert nếu > 100 (publisher stuck)
authz.local.last_synced_lag_sec   # alert nếu > 300s (5 phút)
authz.local.record_count          # sanity check vs IAM record count
pdms.authz_check.latency_p99      # target < 2ms (local query)
```

---

## 🔗 Links

- [[PDMS-Architecture-Overview]] — toàn cảnh
- [[PDMS-AuthZ-Sync-Strategy-Comparison]] — so sánh CDC vs Kafka Events vs Pull vs Token
- [[PDMS-Workflow-Optimal-Communication]] — 5 workflow chi tiết
- [[Cross-Service-Join-AuthZ-Fine-Grained-Filter]] — pattern lý thuyết
- [[MOC-Auth-Security]] — auth patterns hub
- [[MOC-PDMS]] — project hub
