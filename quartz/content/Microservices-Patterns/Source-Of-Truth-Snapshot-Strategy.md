---
type: guide
domain: architecture/microservices
status: active
created: 2026-05-31
updated: 2026-05-31
tags: []
---

# 🗄️ Source of Truth & Snapshot Strategy — Quản Lý Dữ Liệu Chia Sẻ Trong Microservices

> **TL;DR:** Khi 1 service owns domain data (source of truth) và các service khác cần dùng, đừng share database — hãy snapshot đúng cách. Rule cốt lõi: **snapshot chỉ những gì bạn thực sự cần, không clone toàn bộ entity, và luôn rõ ràng field nào là "owned" vs "cached".**

---

## 🧩 Vấn Đề Cốt Lõi

```
Scenario: warehouse-service owns Kho entity
         iam-service cần biết kho nào active để check quyền access
         pdms-service cần display tên kho trong list đề nghị

Cách naive (sai):
  Option A: iam-service và pdms-service gọi warehouse-service mỗi request
            → Tight coupling, latency, cascade failure
  Option B: Copy toàn bộ Kho entity vào mỗi service
            → Rác data, schema diverge, không rõ ai là source of truth

Cách đúng:
  → Mỗi consumer service snapshot chỉ fields họ thực sự cần
  → Sync via events (Kafka) từ source of truth
  → Phân biệt rõ "owned fields" vs "snapshot fields" trong schema
```

---

## 🏛️ Nguyên Tắc Nền Tảng

### 1. Chỉ Có 1 Service Được Write

```
Source of Truth Service
│
├── Owns full entity lifecycle (CREATE, UPDATE, DELETE)
├── Single writer — không service nào khác được mutate data này
├── Publish domain events khi state thay đổi
└── Expose API để read nếu cần real-time accuracy
```

**Anti-pattern:** Nhiều services cùng write vào cùng một domain entity. Dù có distributed lock hay saga, đây là dấu hiệu domain boundary bị vẽ sai.

### 2. Consumer Service Snapshot — Không Phải Clone

```
Consumer Service chỉ snapshot fields phục vụ use case của mình:

warehouse-service (Source of Truth):
  Kho {
    id, code, name, address, location_gps,
    capacity, current_usage, temperature_range,
    manager_user_id, created_by, last_audit_date,
    insurance_policy_number, fire_safety_cert,
    is_active, created_at, updated_at
  }

iam-service (Snapshot — chỉ cần gì?):
  kho_snapshot {
    id,          ← FK reference, PK
    code,        ← hiển thị trong permission UI
    name,        ← hiển thị trong permission UI
    is_active,   ← để filter inactive khỏi permission grant
    _synced_at   ← metadata, không phải business field
  }
  → 4 fields thay vì 15+ fields

pdms-service (Snapshot — chỉ cần gì?):
  kho_ref {
    kho_id,      ← reference ID (FK logic, không có constraint)
    kho_code,    ← display trong list, không cần join
    kho_name,    ← display trong list, không cần join
    _synced_at
  }
  → Embed vào bảng chứa entity chính (de-normalized)
```

### 3. Phân Biệt Owned Fields vs Snapshot Fields

```sql
-- ✅ CLEAR CONVENTION: prefix _ cho sync metadata
CREATE TABLE iam.kho_snapshot (
    -- Business fields (snapshot từ source of truth)
    id              BIGINT PRIMARY KEY,  -- same ID như warehouse
    code            VARCHAR(50) NOT NULL,
    name            VARCHAR(200) NOT NULL,
    is_active       BOOLEAN DEFAULT true,

    -- Sync metadata (KHÔNG phải business data)
    _synced_at      TIMESTAMP DEFAULT NOW(),
    _source_version BIGINT,              -- version/updated_at từ source
    _sync_status    VARCHAR(20) DEFAULT 'OK'  -- OK | STALE | PENDING
);

-- ✅ CLEAR CONVENTION: embed snapshot fields với prefix trong parent entity
CREATE TABLE pdms.de_nghi (
    id              BIGSERIAL PRIMARY KEY,
    -- ... owned business fields ...

    -- Snapshot từ warehouse-service
    kho_id          BIGINT NOT NULL,      -- FK logic (no constraint)
    kho_code        VARCHAR(50),          -- snapshot for display
    kho_name        VARCHAR(200),         -- snapshot for display

    -- Snapshot từ iam-service (dept info at time of creation)
    dept_id         BIGINT NOT NULL,
    dept_code       VARCHAR(50),
    dept_name       VARCHAR(200),

    created_at      TIMESTAMP DEFAULT NOW()
);
```

---

## 🔄 Sync Strategies

### Strategy 1: Event-Driven Sync (Recommended — Default)

```
warehouse-service ──[KhoUpdated event]──► Kafka ──► iam-service (consumer)
                                                  ──► pdms-service (consumer)
```

**Khi nào dùng:**
- Source of truth thay đổi không quá frequent (< 1000 events/sec)
- Consumer chấp nhận eventual consistency (lag ~vài giây)
- Đây là default choice cho hầu hết use case

**Implementation pattern:**

```java
// SOURCE OF TRUTH SERVICE (warehouse-service)
@Service
@Transactional
public class KhoService {

    public Kho updateKho(Long id, KhoUpdateRequest req) {
        Kho kho = khoRepository.findById(id).orElseThrow();
        kho.update(req);
        khoRepository.save(kho);

        // Outbox pattern — atomic với business transaction
        outboxRepository.save(OutboxEvent.of(
            "warehouse.kho-updated",
            KhoUpdatedEvent.from(kho)  // Chỉ publish fields mà consumers cần
        ));

        return kho;
    }
}

// Event chỉ chứa projected fields — không dump toàn bộ entity
public record KhoUpdatedEvent(
    Long id,
    String code,
    String name,
    boolean isActive,
    long version         // optimistic concurrency cho consumers
) {
    public static KhoUpdatedEvent from(Kho kho) {
        return new KhoUpdatedEvent(
            kho.getId(), kho.getCode(), kho.getName(),
            kho.isActive(), kho.getVersion()
        );
    }
}
```

```java
// CONSUMER SERVICE (iam-service)
@KafkaListener(topics = "warehouse.kho-updated", groupId = "iam-kho-sync")
@Transactional
public void onKhoUpdated(KhoUpdatedEvent event) {
    // Idempotency: skip nếu version cũ hơn hoặc bằng hiện tại
    khoSnapshotRepo.upsertIfNewer(
        event.id(), event.code(), event.name(), event.isActive(), event.version()
    );
}

// SQL với optimistic skip
@Query("""
    INSERT INTO iam.kho_snapshot (id, code, name, is_active, _source_version, _synced_at)
    VALUES (:id, :code, :name, :isActive, :version, NOW())
    ON CONFLICT (id) DO UPDATE
        SET code = EXCLUDED.code,
            name = EXCLUDED.name,
            is_active = EXCLUDED.is_active,
            _source_version = EXCLUDED._source_version,
            _synced_at = NOW()
        WHERE iam.kho_snapshot._source_version < EXCLUDED._source_version
    """)
void upsertIfNewer(Long id, String code, String name, boolean isActive, long version);
```

### Strategy 2: Lazy Fetch + Cache (Cho Read-Heavy, Low-Change Data)

```
Consumer service không sync upfront.
Khi cần: check local cache → miss → gọi source of truth API → cache với TTL.
```

```java
@Service
public class KhoReferenceService {

    @Cacheable(value = "kho-ref", key = "#khoId", unless = "#result == null")
    public KhoRef getKhoRef(Long khoId) {
        // Hit source of truth API
        return warehouseApiClient.getKhoRef(khoId);
    }

    // Cache evict khi nhận event (hybrid: lazy fetch + event invalidation)
    @KafkaListener(topics = "warehouse.kho-updated")
    public void onKhoUpdated(KhoUpdatedEvent event) {
        cacheManager.getCache("kho-ref").evict(event.id());
    }
}
```

**Khi nào dùng:**
- Data rất ít thay đổi (master data: danh mục, config)
- Consumer không cần guarantee eventual consistency chặt
- Không muốn maintain snapshot table riêng

**Trade-off:** Phụ thuộc source of truth service available. Nếu warehouse-service down, cache miss không recover được.

### Strategy 3: Bulk Bootstrap + Incremental Sync

```
Lần đầu deploy (hoặc rebuild): bulk load toàn bộ snapshot
Sau đó: chỉ sync incremental qua events
```

```java
@Component
public class KhoSnapshotBootstrap {

    @EventListener(ApplicationReadyEvent.class)
    public void bootstrap() {
        long count = khoSnapshotRepo.count();
        if (count > 0) {
            log.info("kho_snapshot has {} records, skip bootstrap", count);
            return;
        }

        log.info("Bootstrap kho_snapshot from warehouse-service...");
        int page = 0;
        Page<KhoRef> batch;
        do {
            batch = warehouseApiClient.getAllKhos(PageRequest.of(page++, 500));
            khoSnapshotRepo.saveAll(batch.map(KhoSnapshot::from).toList());
        } while (batch.hasNext());
        log.info("Bootstrap complete: {} khos synced", khoSnapshotRepo.count());
    }
}
```

**Kết hợp với event-driven sync:** Bootstrap lần đầu, sau đó Kafka consumer handle incremental. Đây là pattern production-ready nhất.

---

## ⚠️ Cạm Bẫy Phổ Biến

### Cạm Bẫy 1: Snapshot Quá Nhiều Fields

```sql
-- ❌ WRONG: Clone gần như toàn bộ entity
CREATE TABLE iam.kho_snapshot (
    id, code, name, address, location_gps,
    capacity, current_usage, temperature_range,
    manager_user_id, created_by, last_audit_date,  -- iam-service không cần
    is_active, ...
);

-- ✅ RIGHT: Chỉ những gì iam-service thực sự cần cho use case của mình
CREATE TABLE iam.kho_snapshot (
    id, code, name, is_active, _synced_at, _source_version
);
```

**Test:** Với mỗi field trong snapshot, hỏi: "Nếu thiếu field này, có use case nào trong service này bị broken không?" Nếu không → đừng snapshot.

### Cạm Bẫy 2: Không Có Idempotency

```java
// ❌ WRONG: Simple INSERT → duplicate khi replay events
khoSnapshotRepo.save(new KhoSnapshot(event.id(), ...));

// ✅ RIGHT: Upsert với version check
khoSnapshotRepo.upsertIfNewer(event.id(), ..., event.version());
```

Kafka at-least-once delivery → consumer sẽ nhận duplicate events. Luôn phải idempotent.

### Cạm Bẫy 3: Sync Cascading Updates Không Cần Thiết

```
Scenario: warehouse-service cập nhật field insurance_policy_number
          → publish KhoUpdatedEvent (vì Kho entity changed)
          → iam-service nhận event
          → update kho_snapshot (nhưng field này không có trong snapshot!)
          → Wasted work, nhưng OK

Scenario tệ hơn: warehouse-service cập nhật current_usage mỗi 5 phút
                 → Kafka bị flood với events
                 → Consumer phải xử lý hàng triệu updates không cần thiết
```

**Fix:** Source of truth chỉ publish events khi **projected fields** thay đổi, không phải mỗi lần entity update:

```java
public class KhoService {
    public void updateCurrentUsage(Long id, int usage) {
        kho.setCurrentUsage(usage);
        khoRepository.save(kho);
        // KHÔNG publish event — consumer không care field này
    }

    public void deactivateKho(Long id) {
        kho.setIsActive(false);
        khoRepository.save(kho);
        // CÓ publish event — is_active là projected field
        outboxRepository.save(OutboxEvent.of("warehouse.kho-updated",
            KhoUpdatedEvent.from(kho)));
    }
}
```

### Cạm Bẫy 4: Stale Snapshot Gây Ra Wrong Business Decision

```
Scenario:
  1. warehouse-service deactivate kho_id=5 (is_active=false)
  2. Event publish → lag 3 giây
  3. Trong 3 giây, iam-service vẫn thấy kho_id=5 là active
  4. Admin grant user access vào kho đã inactive
  5. Event arrive → iam-service update → nhưng grant đã tồn tại

Hậu quả: User có access vào kho inactive → data inconsistency
```

**Fix:** Với critical operations, verify với source of truth synchronously:

```java
public void grantKhoAccess(String userSub, Long khoId) {
    // ❌ WRONG: Dùng snapshot (có thể stale)
    KhoSnapshot kho = khoSnapshotRepo.findById(khoId).orElseThrow();
    if (!kho.isActive()) throw new BusinessException("Kho inactive");

    // ✅ RIGHT: Verify với source of truth cho critical operation
    KhoStatus status = warehouseApiClient.getKhoStatus(khoId);  // sync call
    if (!status.isActive()) throw new BusinessException("Kho inactive");

    // Grant access sau khi verify
    userKhoAccessRepo.grant(userSub, khoId);
}
```

**Rule of thumb:**
- Read operations, display, filtering → dùng snapshot (fast, no RTT)
- Write operations với business consequence → verify với source of truth

---

## 🏗️ Schema Design Pattern

### Pattern A: Dedicated Snapshot Table

```sql
-- Dùng khi: nhiều records cần sync, cần query/filter trên snapshot fields
CREATE TABLE iam.kho_snapshot (
    id              BIGINT PRIMARY KEY,
    code            VARCHAR(50) NOT NULL,
    name            VARCHAR(200) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    _synced_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    _source_version BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_kho_snapshot_active ON iam.kho_snapshot(is_active)
    WHERE is_active = true;
```

**Dùng khi:** Service cần JOIN với snapshot table để filter, aggregate, hoặc show list.

### Pattern B: Embedded Snapshot Fields (Denormalized)

```sql
-- Dùng khi: chỉ cần display name, không cần query trên snapshot fields
CREATE TABLE pdms.de_nghi (
    id          BIGSERIAL PRIMARY KEY,
    -- ... business fields ...

    -- Snapshot tại thời điểm tạo (historical record — intentional)
    kho_id      BIGINT NOT NULL,
    kho_code    VARCHAR(50),
    kho_name    VARCHAR(200),
    dept_id     BIGINT NOT NULL,
    dept_name   VARCHAR(200)
    -- KHÔNG có _synced_at vì đây là snapshot at-time-of-creation, không update
);
```

**Dùng khi:** Đây là historical snapshot — muốn giữ giá trị tại thời điểm event xảy ra. Ví dụ: order history giữ tên sản phẩm tại thời điểm mua dù sản phẩm sau này đổi tên.

**Quan trọng:** Embedded snapshot thường KHÔNG được update sau khi entity cha tạo. Đây là intentional design — audit trail.

### Pattern C: Reference + Lazy Resolve

```sql
-- Dùng khi: chỉ cần reference ID, tên sẽ fetch khi display
CREATE TABLE pdms.muon_tra (
    id          BIGSERIAL PRIMARY KEY,
    kho_id      BIGINT NOT NULL,    -- reference only, no FK constraint
    -- kho_name sẽ được resolve ở application layer từ cache/snapshot
);
```

**Dùng khi:** Data không cần cho business logic, chỉ cần cho display. Application layer resolve từ in-memory cache.

---

## 📊 So Sánh Strategies

| | Event-Driven Sync | Lazy Fetch + Cache | Embed at Creation |
|---|---|---|---|
| **Consistency** | Eventual (~giây) | Eventual (TTL-based) | Point-in-time (immutable) |
| **Performance** | ✅ No RTT | ⚠️ RTT on miss | ✅ No RTT |
| **Freshness** | ✅ Gần real-time | ⚠️ TTL lag | ❌ Never updates |
| **Storage** | ⚠️ Snapshot table | Minimal | Inline với parent |
| **Complexity** | Medium (Kafka + consumer) | Low | Low |
| **Use case** | Auth data, shared master | Config, low-change data | Historical records |

---

## 🔗 Áp Dụng Trong PDMS

| Consumer | Source of Truth | Snapshot Strategy | Fields Snapshotted |
|---|---|---|---|
| `iam-service` | `warehouse-service` | Event-driven (Kafka) + Dedicated table | `id, code, name, is_active` |
| `pdms-service` (authz_local) | `iam-service` | Event-driven (Kafka) + Schema riêng | `user_sub, dept_id, dept_type, kho_id, access_type` |
| `pdms-service` (de_nghi) | `iam-service` (dept) | Embed at creation | `dept_id, dept_name` |
| `pdms-service` (de_nghi) | `warehouse-service` (kho) | Embed at creation | `kho_id, kho_code, kho_name` |
| `report-service` | Multiple services | CQRS Materialized View | Aggregate view for reporting |

---

## ✅ Checklist Trước Khi Implement

**Design:**
- [ ] Xác định rõ service nào là source of truth cho mỗi entity
- [ ] List fields cần snapshot — loại bỏ mọi field không có use case cụ thể
- [ ] Quyết định snapshot strategy: event-driven / lazy cache / embed at creation
- [ ] Phân biệt: snapshot cần update theo thời gian hay là historical record?

**Implementation:**
- [ ] Prefix metadata fields: `_synced_at`, `_source_version`, `_sync_status`
- [ ] Implement idempotency trong consumer (upsert với version check)
- [ ] Bootstrap procedure cho fresh deploy
- [ ] Dead Letter Queue (DLQ) cho failed events

**Operations:**
- [ ] Monitor sync lag: `_synced_at` vs current time
- [ ] Alert nếu lag > threshold (vd: 5 phút)
- [ ] Reconciliation job chạy định kỳ để detect và fix drift
- [ ] Procedure để force re-sync khi phát hiện inconsistency

---

## 🔗 Links

- [[Microservices-Patterns/01-Data-Consistency]] — consistency patterns tổng quan
- [[Microservices-Patterns/Transactional-Outbox]] — đảm bảo reliable event publishing
- [[Microservices-Patterns/Debezium-CDC-Deep-Dive]] — alternative: CDC thay vì outbox
- [[Microservices-Patterns/CQRS-Materialized-View]] — pattern liên quan cho read models
- [[Microservices-Patterns/PDMS-AuthZ-Fine-Grained-Design]] — áp dụng thực tế (kho_snapshot, authz_local)
- [[Microservices-Patterns/PDMS-Architecture-Overview]] — toàn cảnh PDMS service responsibilities
- [[concepts/ddd-strategic]] — Bounded Context: tại sao OK khi có "redundant" data
