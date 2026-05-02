---
tags: [pdms, vpbank, authz, cross-service, cdc, kafka, sync, comparison, architecture-decision]
up: "[[PDMS-Architecture-Overview]]"
related: "[[Cross-Service-Join-AuthZ-Fine-Grained-Filter]], [[PDMS-AuthZ-Fine-Grained-Design]]"
created: 2026-04-15
---

# ⚖️ PDMS — AuthZ Sync Strategy: So Sánh 4 Lựa Chọn

> **Context:** PDMS-service cần biết user được phép thao tác trên dept/kho nào. IAM-service giữ permission data trong `iam_db` (database riêng). Câu hỏi: làm sao để pdms-service access được data này mà không tạo round-trip đến IAM mỗi request?

---

## 🎯 Yêu cầu thực tế của PDMS

Trước khi so sánh, cần xác định rõ constraints:

| Constraint | Giá trị |
|---|---|
| Số departments | ~1000 |
| Số users active | vài nghìn |
| Tần suất thay đổi permission | Thấp (vài lần/ngày, không realtime) |
| Query volume bulk | Cao (list đề nghị, báo cáo) |
| Export rows | Hàng triệu |
| Thời gian revoke có hiệu lực | Vài giây – vài phút là acceptable |
| Debezium/Kafka Connect available | Chưa rõ — cần đánh giá |
| Team size | Nhỏ – vừa |

---

## 📊 4 Strategy — Bảng tổng quan

| | **A. CDC (Debezium)** | **B. Kafka Domain Events** | **C. Scheduled Pull** | **D. Permission Token** |
|---|---|---|---|---|
| **Cơ chế** | WAL tailing → Kafka → local table | IAM publish event → local table | PDMS gọi IAM định kỳ | Embed dept IDs vào signed token |
| **Latency sync** | ms (near real-time) | ms–giây (event-driven) | TTL interval (1–15 phút) | Token TTL (15–60 phút) |
| **Revoke hiệu lực** | Gần ngay lập tức | Gần ngay lập tức | Tối đa TTL interval | Tối đa token TTL |
| **Operational cost** | **Cao** (Kafka Connect, connector, replication slot) | **Trung bình** (chỉ cần Kafka + consumer) | **Thấp** (scheduler + REST) | **Thấp nhất** |
| **Coupling** | Loose (event) nhưng expose DB schema | Loose (domain event) | Tight (REST contract) | Loose |
| **Scale với số depts** | Tốt | Tốt | Trung bình (bulk API) | **Giới hạn** (token size) |
| **Phù hợp PDMS** | Overkill trừ khi đã có Connect | **Recommended** | Backup/fallback | Không phù hợp (1000 depts) |

---

## 🔴 Strategy A: CDC với Debezium

### Cơ chế

```
iam_db (PostgreSQL WAL)
  → Debezium Connector (Kafka Connect)
  → Kafka topic: authz.public.user_dept_access
  → PDMS Consumer → UPSERT authz_local table
```

### Ưu điểm

- Sync gần real-time (lag ms–vài giây)
- Transparent với IAM service — không cần IAM code thêm gì
- Không bỏ sót event (WAL đảm bảo)
- Local JOIN performance tốt nhất (same DB query)

### Nhược điểm

```
Operational overhead:
  ✗ Cần deploy Kafka Connect cluster (thêm infra)
  ✗ Cần monitor replication slot (WAL accumulation nếu connector lag)
  ✗ PostgreSQL phải enable wal_level = logical
  ✗ Schema migration phức tạp — thay đổi column IAM DB cần coordinate với connector

Coupling ngầm:
  ✗ Expose raw DB schema của IAM ra Kafka topic
  ✗ Consumer phụ thuộc vào table structure của IAM DB
  ✗ Khó refactor IAM internal schema sau này
  
Security:
  ✗ Debezium user cần REPLICATION privilege trên IAM DB
  ✗ Raw DB events chứa tất cả columns (cả sensitive fields)
```

### Verdict cho PDMS

```
Nên dùng nếu:
  ✓ Đã có Kafka Connect cluster trong infra
  ✓ Team có kinh nghiệm vận hành Debezium
  ✓ Cần sync nhiều loại data (không chỉ authz)
  ✓ IAM schema ổn định

Không nên dùng nếu:
  ✗ Team nhỏ, chưa có Kafka Connect
  ✗ IAM schema còn thay đổi nhiều
  ✗ Đây là use case duy nhất cần sync
```

---

## 🟢 Strategy B: Kafka Domain Events (Recommended cho PDMS)

### Cơ chế

```
IAM Service (event producer):
  Khi admin thay đổi permission:
  BEGIN TRANSACTION:
    UPDATE iam_db.user_dept_access SET ...
    INSERT INTO iam_db.outbox {
      event_type: 'USER_DEPT_ACCESS_CHANGED',
      payload: {
        keycloak_sub: "uuid",
        changes: [
          { dept_id: 10, action: "GRANTED", dept_type: "SHARED" },
          { dept_id: 20, action: "REVOKED" }
        ]
      }
    }
  COMMIT
  → Outbox publisher → Kafka: iam.permission-changed

PDMS Service (consumer):
  @KafkaListener("iam.permission-changed")
  → UPSERT/DELETE authz_local.user_dept_access
```

### Tại sao không dùng Debezium ở đây

- IAM service chủ động publish event — **không expose DB schema**
- Event chứa **business-meaningful payload** (keycloak_sub, dept_type) thay vì raw DB row
- Không cần Kafka Connect
- IAM có thể refactor DB schema tùy ý, miễn là event contract không đổi

### Initial snapshot khi deploy

CDC tự động sync toàn bộ history. Với Kafka events, cần bootstrap:

```java
// IAM Service expose bulk export (chỉ dùng khi PDMS deploy lần đầu hoặc rebuild)
@GetMapping("/internal/authz/bulk-export")
@PreAuthorize("hasRole('INTERNAL_SERVICE')")
public void bulkExport(HttpServletResponse response) {
    // Stream tất cả active user_dept_access ra JSON
    response.setContentType("application/x-ndjson");
    userDeptAccessRepository.streamAllActive().forEach(record -> {
        writeNdjsonLine(response.getOutputStream(), record);
    });
}

// PDMS Service — chạy khi startup nếu authz_local trống
@EventListener(ApplicationReadyEvent.class)
public void bootstrapAuthzLocal() {
    if (authzLocalRepository.count() == 0) {
        log.info("authz_local empty, bootstrapping from IAM bulk export...");
        iamClient.streamBulkExport().forEach(record ->
            authzLocalRepository.upsert(record)
        );
        log.info("Bootstrap complete");
    }
}
```

### Idempotency — tránh duplicate apply

```java
@KafkaListener(topics = "iam.permission-changed", groupId = "pdms-authz-sync")
@Transactional
public void onPermissionChanged(PermissionChangedEvent event) {
    // Idempotency: event có id UUID
    if (processedEvents.contains(event.id())) return;

    for (PermissionChange change : event.changes()) {
        switch (change.action()) {
            case "GRANTED" -> authzLocalRepo.upsert(
                event.keycloakSub(), change.deptId(), change.deptType()
            );
            case "REVOKED" -> authzLocalRepo.deactivate(
                event.keycloakSub(), change.deptId()
            );
        }
    }
    processedEvents.add(event.id());
}
```

### authz_local schema trong pdms_db

```sql
CREATE SCHEMA authz_local;

-- Populated by IAM Kafka events (không phải raw DB replica)
CREATE TABLE authz_local.user_dept_access (
    id              BIGSERIAL PRIMARY KEY,
    user_sub        VARCHAR(36) NOT NULL,   -- Keycloak subject UUID (không dùng internal ID)
    dept_id         BIGINT NOT NULL,
    dept_type       VARCHAR(20) NOT NULL,   -- SHARED, CHUNG_TU, TSDB (denormalized)
    access_type     VARCHAR(50) DEFAULT 'FULL',
    is_active       BOOLEAN DEFAULT true,
    _event_id       UUID,                   -- idempotency key
    _synced_at      TIMESTAMP DEFAULT NOW(),
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

-- Indexes tối ưu cho query pattern: filter by user_sub + is_active + dept_type
CREATE INDEX idx_al_uda_sub_active ON authz_local.user_dept_access(user_sub, is_active, dept_type);
CREATE INDEX idx_al_uka_sub_active ON authz_local.user_kho_access(user_sub, is_active);
```

**Dùng `user_sub` (Keycloak UUID) thay vì internal `user_id`:**
- Tránh phải maintain mapping table trong pdms_db
- Gateway chỉ cần forward `X-User-Sub` — không cần IAM lookup tại gateway
- authz_local dùng `user_sub` làm join key trực tiếp

### Query pattern

```sql
-- List đề nghị với phân quyền (zero RTT)
SELECT dn.*
FROM pdms.de_nghi dn
WHERE dn.dept_id IN (
    SELECT dept_id FROM authz_local.user_dept_access
    WHERE user_sub = :keycloakSub
      AND is_active = true
      AND dept_type IN ('SHARED', 'CHUNG_TU')
)
AND dn.status = :status
AND dn.id > :lastId     -- keyset cursor
ORDER BY dn.id ASC
LIMIT 5000;
```

### Monitoring

```java
// Track sync health
@Scheduled(fixedDelay = 30_000)
public void checkSyncHealth() {
    Instant lastSynced = authzLocalRepo.findLastSyncedAt();
    Duration lag = Duration.between(lastSynced, Instant.now());

    // Alert nếu không nhận event trong > 10 phút (bình thường là vài giây khi có thay đổi)
    if (lag.toMinutes() > 10 && hasPendingPermissionChanges()) {
        log.warn("AuthZ sync lag {}min — possible Kafka consumer issue", lag.toMinutes());
        alerting.fire("AUTHZ_SYNC_LAG");
    }

    meterRegistry.gauge("authz.local.last_synced_lag_seconds", lag.toSeconds());
}
```

---

## 🟡 Strategy C: Scheduled Pull (Fallback/Simple)

### Cơ chế

```
PDMS Service — cron job mỗi N phút:
  GET /api/v1/internal/authz/changes?since={lastSyncedAt}
  → IAM trả danh sách thay đổi từ lastSyncedAt
  → PDMS UPSERT vào authz_local
```

### Ưu điểm

- **Đơn giản nhất** — chỉ cần REST + scheduler
- Không cần Kafka cho authz sync (nếu chưa có Kafka)
- Dễ debug (HTTP logs rõ ràng)
- IAM kiểm soát hoàn toàn data expose

### Nhược điểm

```
✗ Polling interval = revoke lag: 5 phút poll → revoke có hiệu lực sau tối đa 5 phút
✗ Wasted traffic khi không có thay đổi (heartbeat polling)
✗ IAM cần maintain change log table (thêm complexity phía IAM)
✗ Network dependency — nếu IAM down, PDMS không sync được
```

### Khi nào dùng

- Team chưa có Kafka
- Permission thay đổi rất ít (vài lần/tuần)
- Revoke lag vài phút là acceptable với business
- Là bước đầu trước khi migrate sang Option B

### Implementation

```java
// IAM Service — change feed endpoint
@GetMapping("/internal/authz/changes")
public List<PermissionChange> getChangesSince(
        @RequestParam Instant since,
        @RequestParam(defaultValue = "1000") int limit) {
    return permissionChangeLogRepo.findBySinceTimestamp(since, limit);
}

// IAM DB — change log table
CREATE TABLE iam.permission_change_log (
    id          BIGSERIAL PRIMARY KEY,
    keycloak_sub VARCHAR(36) NOT NULL,
    dept_id     BIGINT,
    kho_id      BIGINT,
    action      VARCHAR(20) NOT NULL, -- DEPT_GRANTED, DEPT_REVOKED, KHO_GRANTED
    dept_type   VARCHAR(20),
    changed_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_pcl_changed_at ON iam.permission_change_log(changed_at);

// PDMS Service — scheduled sync
@Scheduled(fixedDelay = 60_000) // mỗi 1 phút
public void syncAuthzLocal() {
    Instant lastSync = syncStateRepo.getLastSyncedAt();
    List<PermissionChange> changes = iamClient.getChangesSince(lastSync, 5000);

    if (!changes.isEmpty()) {
        changes.forEach(c -> authzLocalRepo.apply(c));
        syncStateRepo.updateLastSyncedAt(changes.getLast().changedAt());
        log.info("Synced {} permission changes from IAM", changes.size());
    }
}
```

---

## 🔵 Strategy D: Permission Token (Không phù hợp cho PDMS)

### Cơ chế

IAM embed toàn bộ dept IDs vào JWT claim hoặc short-lived token riêng.

### Tại sao không phù hợp với PDMS

```
PDMS có ~1000 departments
User có thể có access vào nhiều dept (ví dụ: manager cấp cao → 200+ depts)

Token size:
  200 dept IDs × 4 bytes (int) = 800 bytes minimum
  + overhead JSON/JWT = 1-2KB per token
  → HTTP header "Authorization" sẽ rất lớn
  → Mỗi request đều mang token lớn → network overhead

Giới hạn về revoke:
  Token có TTL 15-60 phút
  Nếu revoke dept access của user, phải đợi token expire
  → Banking context: không acceptable
```

**Permission Token chỉ phù hợp khi:** User có rất ít allowed items (< 50-100 IDs) và business chấp nhận revoke lag bằng token TTL. PDMS không thỏa mãn cả hai.

---

## 🏆 Quyết định cho PDMS

### Recommended: Strategy B (Kafka Domain Events) + Strategy C (fallback)

```
Production path:
  IAM Service (Transactional Outbox)
    → Kafka: iam.permission-changed
      → PDMS consumer → authz_local (pdms_db)
      → Report consumer → authz_local (report_db)

Startup bootstrap:
  PDMS startup → check authz_local empty?
    → Yes: call IAM bulk export API → populate
    → No: proceed normally

Fallback khi Kafka lag:
  Monitor: authz.local.last_synced_lag_seconds > threshold
    → Switch to Scheduled Pull (every 30s) until Kafka healthy
    → Alert team

Future (nếu có Kafka Connect):
  Migrate sang Strategy A (CDC) cho các use case khác
  Authz sync vẫn giữ Strategy B (đơn giản hơn)
```

### Tại sao không CDC cho PDMS hiện tại

```
1. Debezium/Kafka Connect chưa có trong infra → thêm infra mới chỉ cho authz sync là overkill
2. Kafka Domain Events đủ đáp ứng: lag ~giây khi có thay đổi (permission thay đổi ít)
3. Không expose raw DB schema IAM ra Kafka — IAM có thể refactor tự do
4. Dễ maintain hơn đáng kể: chỉ cần thêm Outbox vào IAM + consumer vào PDMS
5. Khi team lớn hơn và có ops capacity → có thể migrate sang CDC (cơ chế authz_local không đổi)
```

---

## 🔗 Links

- [[PDMS-Architecture-Overview]] — context đầy đủ
- [[PDMS-AuthZ-Fine-Grained-Design]] — IAM schema
- [[Cross-Service-Join-AuthZ-Fine-Grained-Filter]] — 5 pattern gốc
- [[Transactional-Outbox]] — pattern dùng cho IAM outbox
- [[MOC-PDMS]] — project hub
