# 🔄 Kafka — Multi-Consumer Sync Completion Guarantee

> **Bài toán:** Source-of-truth service publish snapshot event lên Kafka. N downstream services phải consume + apply thành công. Làm sao đảm bảo **tất cả** đã sync xong trước khi coi business operation là hoàn thành?

**Related:**
- [[Source-Of-Truth-Snapshot-Strategy]] — event-driven sync, lazy fetch, bootstrap patterns
- [[PDMS-AuthZ-Sync-Strategy-Comparison]] — lựa chọn Debezium vs domain events
- [[Transactional-Outbox]] — đảm bảo atomic publish từ source

---

## 🧠 Vấn đề cốt lõi

Kafka đảm bảo **at-least-once delivery** đến từng consumer group độc lập. Nhưng:

```
Producer nhận RecordMetadata (partition + offset đã ghi vào broker)
→ Không biết consumer group nào đã xử lý xong
→ Offset commit của group A hoàn toàn độc lập với group B
→ Không có built-in "all consumers done" signal
```

Bài toán cần giải: *Sau khi source publish snapshot event với `correlation_id = X`, làm sao biết khi nào tất cả N services đã apply thành công?*

```
warehouse-service ──[KhoSyncEvent]──► Kafka ──► iam-service       (group: iam-kho-sync)
                                              ──► pdms-service     (group: pdms-kho-sync)
                                              ──► report-service   (group: report-kho-sync)

❓ Ai biết khi nào tất cả 3 services đã xong?
   Kafka KHÔNG cung cấp cơ chế này natively.
```

---

## 🏗️ Pattern 1 — Completion Topic (Recommended cho PDMS)

Mỗi consumer sau khi xử lý xong publish **acknowledgment event** vào topic riêng. Coordinator aggregate các ACKs.

```
① warehouse-service publish KhoSyncEvent (correlationId=X) → warehouse.kho-updated
② Fan-out → iam, pdms, report consume và apply snapshot
③ Mỗi service publish SyncAckEvent(correlationId=X, serviceId, SUCCESS) → sync.completion-ack
④ Coordinator consume ACKs, track count → khi đủ N: emit SyncCompleted
```

### Topic configuration

```yaml
# Source topic — key = entity_id để đảm bảo ordering per entity
warehouse.kho-updated:
  partitions: 6
  replication-factor: 3

# Completion ACK topic — key = correlation_id → cùng partition với các ACK của cùng 1 sync
sync.completion-ack:
  partitions: 6
  replication-factor: 3
  retention.ms: 86400000  # 24h — đủ để coordinator process
```

### Event schemas

```java
// Source publish
public record KhoSyncEvent(
    String correlationId,           // UUID — dùng để track completion
    long   version,
    String khoId,
    String code,
    String name,
    boolean isActive,
    Set<String> expectedConsumers   // {"iam-service", "pdms-service", "report-service"}
) {}

// Consumer publish sau khi xử lý xong
public record SyncAckEvent(
    String correlationId,
    String serviceId,               // "iam-service"
    SyncStatus status,              // SUCCESS | FAILED
    String errorMsg,
    Instant processedAt
) {}
```

### Consumer implementation

```java
@KafkaListener(topics = "warehouse.kho-updated", groupId = "iam-kho-sync")
@Transactional
public void onKhoUpdated(KhoSyncEvent event, Acknowledgment ack) {
    try {
        khoSnapshotRepo.upsertIfNewer(event);

        kafkaTemplate.send("sync.completion-ack", event.correlationId(),
            new SyncAckEvent(event.correlationId(), "iam-service", SUCCESS, null, Instant.now()));

        ack.acknowledge();  // Commit offset CHỈ sau khi ACK đã sent
    } catch (Exception e) {
        log.error("Sync failed correlationId={}", event.correlationId(), e);
        kafkaTemplate.send("sync.completion-ack", event.correlationId(),
            new SyncAckEvent(event.correlationId(), "iam-service", FAILED, e.getMessage(), Instant.now()));
        ack.acknowledge();  // Vẫn commit để không bị replay loop
    }
}
```

### Coordinator — aggregate ACKs với Redis

```java
@KafkaListener(topics = "sync.completion-ack", groupId = "sync-coordinator")
public void onSyncAck(SyncAckEvent ack) {
    syncTracker.recordAck(ack.correlationId(), ack.serviceId(), ack.status());

    SyncState state = syncTracker.getState(ack.correlationId());
    if (state.isComplete()) {
        if (state.allSucceeded()) {
            publishSyncCompleted(ack.correlationId());
        } else {
            publishSyncFailed(ack.correlationId(), state.failures());
        }
    }
}

@Service
public class SyncTracker {
    public void recordAck(String correlationId, String serviceId, SyncStatus status) {
        String key = "sync:" + correlationId;
        redisTemplate.opsForHash().put(key, serviceId, status.name());
        redisTemplate.expire(key, Duration.ofHours(1));
    }

    public SyncState getState(String correlationId) {
        Map<Object, Object> acks = redisTemplate.opsForHash().entries("sync:" + correlationId);
        Set<String> expected = getExpectedConsumers(correlationId);
        return SyncState.from(acks, expected);
    }
}
```

---

## 🏗️ Pattern 2 — Saga + PostgreSQL State Machine

Phù hợp khi sync completion có **business consequence** quan trọng, cần audit trail.

### State transitions

```
PENDING → (publish event) → IN_PROGRESS
IN_PROGRESS → (nhận đủ N ACKs) → COMPLETED
IN_PROGRESS → (timeout / NACK) → FAILED → (retry < 3) → IN_PROGRESS
FAILED (retry exhausted) → alert ops
```

### Schema

```sql
CREATE TABLE sync_saga (
    correlation_id   UUID PRIMARY KEY,
    entity_type      VARCHAR(50) NOT NULL,
    entity_id        BIGINT NOT NULL,
    state            VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    -- Một cột boolean per consumer — flexible hơn JSONB cho query
    iam_acked        BOOLEAN NOT NULL DEFAULT FALSE,
    pdms_acked       BOOLEAN NOT NULL DEFAULT FALSE,
    report_acked     BOOLEAN NOT NULL DEFAULT FALSE,
    retry_count      INT NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMPTZ NOT NULL,
    completed_at     TIMESTAMPTZ,
    CONSTRAINT chk_state CHECK (state IN ('PENDING','IN_PROGRESS','COMPLETED','FAILED'))
);

CREATE INDEX idx_sync_saga_expires ON sync_saga(expires_at) WHERE state = 'IN_PROGRESS';
```

### ACK handler — atomic conditional update

```java
@Modifying
@Query("""
    UPDATE sync_saga
    SET iam_acked    = CASE WHEN :serviceId = 'iam'    THEN :success ELSE iam_acked END,
        pdms_acked   = CASE WHEN :serviceId = 'pdms'   THEN :success ELSE pdms_acked END,
        report_acked = CASE WHEN :serviceId = 'report' THEN :success ELSE report_acked END,
        state = 'IN_PROGRESS'
    WHERE correlation_id = :corrId
    AND state IN ('PENDING', 'IN_PROGRESS')
    """)
int updateAck(String corrId, String serviceId, boolean success);
```

### Timeout-based retry scheduler

```java
@Scheduled(fixedDelay = 60_000)
@Transactional
public void retryExpiredSagas() {
    List<SyncSaga> stuck = syncSagaRepo.findStuckSagas(Instant.now(), 3);

    for (SyncSaga saga : stuck) {
        if (saga.getRetryCount() >= 3) {
            saga.setState("FAILED");
            alertService.sendAlert("Sync saga failed: " + saga.getCorrelationId());
        } else {
            saga.setRetryCount(saga.getRetryCount() + 1);
            saga.setExpiresAt(Instant.now().plus(Duration.ofMinutes(10)));
            republishSyncEvent(saga);
        }
        syncSagaRepo.save(saga);
    }
}
```

---

## 🏗️ Pattern 3 — Kafka Streams Aggregation

Nếu đã dùng Kafka Streams — aggregate ACKs với KTable, không cần external state store.

```java
KTable<String, SyncCompletionState> completionTable = acks
    .groupByKey()
    .aggregate(
        SyncCompletionState::empty,
        (corrId, ack, state) -> state.recordAck(ack.serviceId(), ack.status()),
        Materialized.as("sync-completion-store")
    );

completionTable
    .toStream()
    .filter((corrId, state) -> state.isFullyComplete())
    .to("sync.completed");
```

**Trade-off:** Không cần Redis/PostgreSQL cho state, nhưng operational complexity cao hơn.

---

## ⚠️ Pattern KHÔNG nên dùng — Consumer Lag Polling

```java
// ❌ SAI — Lag = 0 chỉ nghĩa là consumer đã POLL, không phải đã xử lý xong và commit DB
boolean allCaughtUp = groups.stream().allMatch(g -> consumerLag(g, topic) == 0);
```

Offset được commit trước khi DB write hoàn thành trong nhiều config. **Không đảm bảo data consistency.**

---

## ⚙️ Kafka Configuration Quan Trọng

### Producer config — đảm bảo ACK không bị mất

```yaml
spring:
  kafka:
    producer:
      acks: all                                    # Xác nhận từ tất cả ISR replicas
      retries: 2147483647                          # Retry vô hạn
      enable-idempotence: true                     # No duplicate ACKs on broker retry
      max-in-flight-requests-per-connection: 5     # Safe với idempotence
      delivery-timeout-ms: 120000
      request-timeout-ms: 30000
```

### Consumer config — tránh CommitFailedException khi processing lâu

```yaml
spring:
  kafka:
    consumer:
      enable-auto-commit: false       # QUAN TRỌNG: manual commit
      auto-offset-reset: earliest
      isolation-level: read_committed # Chỉ đọc message từ committed transactions
      max-poll-records: 10            # Nhỏ — tránh timeout trong poll interval
      max-poll-interval-ms: 300000    # 5 phút — đủ cho heavy processing
      session-timeout-ms: 45000
      heartbeat-interval-ms: 15000
    listener:
      ack-mode: MANUAL_IMMEDIATE
```

---

## 🔥 Failure Scenarios & Fixes

| Case | Vấn đề | Fix |
|---|---|---|
| Consumer crash mid-process | Offset chưa commit → replay on restart | `enable-auto-commit=false` + idempotent upsert |
| ACK event lost (broker down) | Coordinator không nhận ACK | `acks=all` + `retries=MAX` + timeout-based retry scheduler |
| One consumer always fails | Sync stuck IN_PROGRESS mãi | `expires_at` + alert ops sau SLA + mark FAILED |
| Coordinator crash | Mất in-memory ACK state | Persist state vào Redis/Postgres; Kafka offset auto-reloads |
| Duplicate ACK events | Consumer gửi ACK 2 lần (retry) | Idempotent handler: skip nếu serviceId đã có trong set |
| New consumer added | `expectedConsumers` thay đổi mid-operation | Embed `expectedConsumers` set trong sync event; coordinator check against event's set |

---

## 🗺️ Khi Nào Dùng Pattern Nào

| Pattern | Dùng khi | Trade-off |
|---|---|---|
| **Completion Topic + Redis** | Đã có Kafka infra, cần loose coupling | Thêm 1 topic, cần Redis |
| **Saga + PostgreSQL** | Business consequence quan trọng, cần audit trail | Thêm table, scheduler |
| **Kafka Streams** | Đã dùng Kafka Streams ecosystem | Operational complexity cao hơn |

**Recommendation cho PDMS:** Pattern 1 (Completion Topic + Redis) — đơn giản, Kafka-native, scale tốt, phù hợp infra hiện tại.

---

## 💡 Core Principles

1. **Consumer idempotency là bắt buộc** — mọi message có thể bị replay; `upsertIfNewer` với version check
2. **Persistent coordinator state** — không bao giờ giữ ACK state chỉ trong memory
3. **Commit offset AFTER ACK sent** — đảm bảo không mất ACK khi consumer crash giữa chừng
4. **Embed expectedConsumers trong event** — tránh coupling với dynamic service registry
5. **Always have a timeout + alert** — saga không bao giờ stuck mãi; ops phải biết
6. **Never use lag polling for completion guarantee** — lag = 0 ≠ processing done
