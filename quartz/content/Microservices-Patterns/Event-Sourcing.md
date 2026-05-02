---
tags: [microservices, patterns, event-sourcing, cqrs, audit, banking]
up: "[[01-Data-Consistency]]"
related: "[[CQRS-Materialized-View]], [[Transactional-Outbox]], [[Saga-Pattern]]"
---

# 📜 Event Sourcing

> **TL;DR:** Thay vì lưu *current state* của entity, lưu toàn bộ *chuỗi events* đã xảy ra. State hiện tại = replay tất cả events theo thứ tự. Không có UPDATE, không có DELETE — chỉ có APPEND.

---

## 🎯 Problem với traditional CRUD

```sql
-- Traditional: chỉ biết state hiện tại
accounts: { id: ACC-001, balance: 850, updated_at: 2026-04-12 }

Câu hỏi không thể trả lời:
  ❓ "Balance lúc 2026-01-15 là bao nhiêu?"
  ❓ "Ai đã thay đổi balance lần cuối?"
  ❓ "Có bao nhiêu lần rút tiền trong tháng 3?"
  ❓ "Tại sao balance là 850 chứ không phải 1000?"
```

Trong banking/fintech, những câu hỏi này là **yêu cầu bắt buộc** — audit trail, compliance, dispute resolution.

---

## ✅ Solution: Append-only Event Log

```
event_store table:
┌─────────┬──────────────────────┬───────────────────┬────────────────────────────┐
│ seq     │ aggregate_id         │ event_type        │ payload                    │
├─────────┼──────────────────────┼───────────────────┼────────────────────────────┤
│ 1       │ ACC-001              │ AccountOpened     │ {initialDeposit: 1000}     │
│ 2       │ ACC-001              │ MoneyDeposited    │ {amount: 200, by: "U001"}  │
│ 3       │ ACC-001              │ MoneyWithdrawn    │ {amount: 150, atm: "ATM5"} │
│ 4       │ ACC-001              │ MoneyWithdrawn    │ {amount: 200, by: "U002"}  │
└─────────┴──────────────────────┴───────────────────┴────────────────────────────┘

Current state = replay:
  start: 0
  + AccountOpened(1000)   → 1000
  + MoneyDeposited(200)   → 1200
  + MoneyWithdrawn(150)   → 1050
  + MoneyWithdrawn(200)   → 850  ← balance hiện tại
```

**Mọi câu hỏi đều có thể trả lời** vì toàn bộ lịch sử được giữ nguyên.

---

## 🏗️ Implementation

### Domain Model — Aggregate với Event Sourcing

```java
public class CreditAccount {
    private String accountId;
    private String customerId;
    private BigDecimal balance;
    private AccountStatus status;
    
    // List events chưa được persist (pending)
    private final List<DomainEvent> pendingEvents = new ArrayList<>();
    private long version = 0;
    
    // ── Factory: tạo từ command ──────────────────────────────────
    public static CreditAccount open(String accountId, String customerId,
                                     BigDecimal initialDeposit) {
        CreditAccount account = new CreditAccount();
        account.applyEvent(new AccountOpenedEvent(accountId, customerId, initialDeposit));
        return account;
    }
    
    // ── Command handlers: validate + raise event ─────────────────
    public void deposit(BigDecimal amount, String initiatedBy) {
        if (amount.compareTo(BigDecimal.ZERO) <= 0)
            throw new InvalidAmountException("Deposit amount must be positive");
        if (status != AccountStatus.ACTIVE)
            throw new AccountNotActiveException(accountId);
        
        applyEvent(new MoneyDepositedEvent(accountId, amount, initiatedBy, Instant.now()));
    }
    
    public void withdraw(BigDecimal amount, String initiatedBy) {
        if (balance.compareTo(amount) < 0)
            throw new InsufficientFundsException(accountId, balance, amount);
        
        applyEvent(new MoneyWithdrawnEvent(accountId, amount, initiatedBy, Instant.now()));
    }
    
    // ── Event handlers: apply state change (NO validation here) ──
    // Được gọi khi: (1) raise event mới, (2) reconstruct từ event log
    private void applyEvent(DomainEvent event) {
        switch (event) {
            case AccountOpenedEvent e -> {
                this.accountId = e.accountId();
                this.customerId = e.customerId();
                this.balance = e.initialDeposit();
                this.status = AccountStatus.ACTIVE;
            }
            case MoneyDepositedEvent e -> this.balance = this.balance.add(e.amount());
            case MoneyWithdrawnEvent e -> this.balance = this.balance.subtract(e.amount());
            case AccountClosedEvent e -> this.status = AccountStatus.CLOSED;
            default -> throw new UnknownEventException(event.getClass());
        }
        this.version++;
        this.pendingEvents.add(event);
    }
    
    // ── Reconstruct từ event history ─────────────────────────────
    public static CreditAccount reconstitute(List<DomainEvent> events) {
        CreditAccount account = new CreditAccount();
        events.forEach(account::applyEvent);
        account.pendingEvents.clear(); // Không phải pending events
        return account;
    }
    
    public List<DomainEvent> getPendingEvents() {
        return Collections.unmodifiableList(pendingEvents);
    }
    
    public void clearPendingEvents() { pendingEvents.clear(); }
}
```

### Event Store Repository

```java
@Repository
@RequiredArgsConstructor
public class EventStoreRepository {
    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;
    
    // ── Save pending events ──────────────────────────────────────
    public void save(CreditAccount aggregate) {
        List<DomainEvent> events = aggregate.getPendingEvents();
        if (events.isEmpty()) return;
        
        // Optimistic locking: đảm bảo không conflict version
        long expectedVersion = aggregate.getVersion() - events.size();
        
        jdbc.batchUpdate("""
            INSERT INTO event_store
              (aggregate_id, aggregate_type, event_type, payload, version, occurred_at)
            VALUES (?, 'CreditAccount', ?, ?::jsonb, ?, ?)
            """,
            events.stream().map(event -> new Object[]{
                aggregate.getAccountId(),
                event.getClass().getSimpleName(),
                serializeEvent(event),
                ++expectedVersion,
                Instant.now()
            }).collect(Collectors.toList())
        );
        
        aggregate.clearPendingEvents();
    }
    
    // ── Load và reconstruct aggregate ───────────────────────────
    public Optional<CreditAccount> findById(String accountId) {
        List<DomainEvent> events = jdbc.query("""
            SELECT event_type, payload, version
            FROM event_store
            WHERE aggregate_id = ?
            ORDER BY version ASC
            """,
            (rs, rowNum) -> deserializeEvent(
                rs.getString("event_type"),
                rs.getString("payload")
            ),
            accountId
        );
        
        if (events.isEmpty()) return Optional.empty();
        return Optional.of(CreditAccount.reconstitute(events));
    }
    
    // ── Load từ snapshot + events sau đó (optimization) ─────────
    public Optional<CreditAccount> findByIdWithSnapshot(String accountId) {
        // 1. Tìm snapshot gần nhất
        Optional<Snapshot> snapshot = findLatestSnapshot(accountId);
        
        long fromVersion = snapshot.map(Snapshot::version).orElse(0L);
        
        // 2. Chỉ load events sau snapshot
        List<DomainEvent> events = jdbc.query("""
            SELECT event_type, payload
            FROM event_store
            WHERE aggregate_id = ? AND version > ?
            ORDER BY version ASC
            """,
            (rs, rowNum) -> deserializeEvent(rs.getString("event_type"), rs.getString("payload")),
            accountId, fromVersion
        );
        
        // 3. Reconstruct từ snapshot + delta events
        CreditAccount account = snapshot
            .map(s -> deserializeSnapshot(s.payload()))
            .orElse(new CreditAccount());
        events.forEach(account::applyReplayEvent);
        return Optional.of(account);
    }
}
```

### Event Store Schema

```sql
CREATE TABLE event_store (
    id            BIGSERIAL PRIMARY KEY,
    aggregate_id  VARCHAR(255)  NOT NULL,
    aggregate_type VARCHAR(100) NOT NULL,
    event_type    VARCHAR(100)  NOT NULL,
    payload       JSONB         NOT NULL,
    version       BIGINT        NOT NULL,
    occurred_at   TIMESTAMP     NOT NULL DEFAULT NOW(),
    
    -- Optimistic locking: không cho 2 writers cùng version
    UNIQUE (aggregate_id, version)
);

CREATE INDEX idx_es_aggregate ON event_store (aggregate_id, version);
CREATE INDEX idx_es_occurred ON event_store (occurred_at);  -- time-range queries

-- Snapshots: tránh replay toàn bộ history khi aggregate có nhiều events
CREATE TABLE event_store_snapshots (
    aggregate_id   VARCHAR(255) PRIMARY KEY,
    aggregate_type VARCHAR(100) NOT NULL,
    payload        JSONB        NOT NULL,  -- serialized state
    version        BIGINT       NOT NULL,
    created_at     TIMESTAMP    NOT NULL DEFAULT NOW()
);
```

---

## 📸 Snapshots — tối ưu performance

Aggregate có 10,000 events → replay tốn thời gian. Giải pháp: tạo snapshot định kỳ.

```java
@Scheduled(cron = "0 2 * * * *")  // mỗi ngày 2am
public void createSnapshots() {
    // Tìm aggregates có > 500 events kể từ snapshot cuối
    List<String> candidates = jdbc.queryForList("""
        SELECT e.aggregate_id
        FROM event_store e
        LEFT JOIN event_store_snapshots s ON e.aggregate_id = s.aggregate_id
        WHERE e.version > COALESCE(s.version, 0)
        GROUP BY e.aggregate_id, s.version
        HAVING COUNT(*) > 500
        """, String.class);
    
    candidates.forEach(aggregateId -> {
        CreditAccount account = repository.findById(aggregateId).orElseThrow();
        snapshotRepository.save(new Snapshot(
            aggregateId,
            account.getVersion(),
            objectMapper.writeValueAsString(account)  // serialize current state
        ));
    });
}
```

---

## ⚖️ Trade-offs

| ✅ Lợi | ⚠️ Chi phí |
|---|---|
| Audit trail hoàn hảo — bắt buộc trong banking | Query phức tạp hơn (phải dùng CQRS projection) |
| Time-travel: "balance ngày X là bao nhiêu?" | Event schema evolution khó — không xóa fields cũ |
| Debug: biết chính xác tại sao state hiện tại là vậy | Replay chậm nếu nhiều events (giải bằng snapshot) |
| Tự nhiên kết hợp với CQRS | Team cần mindset shift — khác CRUD hoàn toàn |
| Không mất data — có thể rebuild bất kỳ projection nào | Storage tăng liên tục (event log không bao giờ shrink) |

---

## 🔄 Event Schema Evolution

Event đã lưu trong DB không thể thay đổi. Khi cần thêm fields:

```java
// Version 1 (đã lưu trong DB)
public record MoneyWithdrawnEvent(String accountId, BigDecimal amount) {}

// Version 2 (thêm field mới)
// ❌ KHÔNG làm: thay đổi existing event
// ✅ Làm: tạo event mới hoặc dùng upcasting

// Upcaster: convert V1 → V2 khi deserialize
@Component
public class MoneyWithdrawnUpcaster {
    public MoneyWithdrawnEventV2 upcast(MoneyWithdrawnEvent v1) {
        return new MoneyWithdrawnEventV2(
            v1.accountId(),
            v1.amount(),
            "UNKNOWN"  // default cho initiatedBy — field mới
        );
    }
}
```

---

## 🏦 PDMS Application

```
CreditAccount aggregate (Event Sourced):

Events:
  CreditAccountCreated    → tạo khi migration từ legacy
  DocumentLinked          → liên kết hợp đồng vào tài khoản
  DocumentUnlinked        → gỡ liên kết
  AccountStatusChanged    → active/frozen/closed
  AuditNoteAdded          → ghi chú kiểm toán

Lợi ích với compliance banking:
  ✅ Biết chính xác ai link document nào vào account nào lúc nào
  ✅ Dispute: "Tại sao account này bị frozen?" → replay events
  ✅ Regulatory audit: export toàn bộ events theo time range

CQRS Projections từ events:
  → account_summary_view   (current state, fast read)
  → account_timeline_view  (lịch sử, paginated)
  → document_link_report   (compliance report)
```

---

## 🔗 Liên kết
- [[01-Data-Consistency]] — Group overview
- [[CQRS-Materialized-View]] — Event Sourcing + CQRS là combo tự nhiên
- [[Transactional-Outbox]] — Events trong event store cũng cần publish ra Kafka
- [[Saga-Pattern]] — Events từ Saga có thể persist vào event store
