---
tags: [microservices, data, consistency, patterns]
up: "[[00-Hub-Microservices-Patterns]]"
---

# 📦 01 — Data & Consistency Patterns

> **Core problem:** Trong microservices, data bị phân tán. Không có "one big database" để join. Làm sao đảm bảo consistency mà không tạo coupling?

---

## 🧭 Mental model

```
Monolith:  [Service A] ──┐
           [Service B] ──┼──► [Single DB] ← dễ, nhưng tight coupling
           [Service C] ──┘

Microservices: [Service A] → [DB_A]
               [Service B] → [DB_B]   ← mỗi service làm chủ data của mình
               [Service C] → [DB_C]
```

**Trade-off cốt lõi:** Strong consistency ↔ Availability/Performance. Trong microservices, ta chọn **eventual consistency** + patterns để handle nó đúng cách.

---

## 🗂️ Patterns trong nhóm này

### [[Database-per-Service]]
Nền tảng của toàn bộ nhóm. Không có pattern này, các pattern khác vô nghĩa.

**Một câu:** Mỗi service sở hữu schema riêng, không service nào query trực tiếp DB của service khác.

**Tại sao bắt buộc:**
- Shared DB = shared coupling. Thay schema của Service A → break Service B.
- Không thể deploy độc lập nếu share DB.
- Không thể chọn DB engine phù hợp (SQL vs NoSQL vs Graph).

**Implementation choices:**
| Cách | Khi nào dùng |
|---|---|
| Schema per service (cùng DB instance) | Dev/staging, tiết kiệm infra |
| Database per service (instance riêng) | Production, strong isolation |
| DB engine khác nhau | Khi service cần đặc thù (Elasticsearch cho search) |

**⚠️ Hệ quả tất yếu:** Không thể JOIN cross-service → phải dùng CQRS hoặc API Composition.

---

### [[Saga-Pattern]]
Distributed transaction không cần 2PC (Two-Phase Commit).

**Một câu:** Thay vì distributed transaction, dùng chuỗi local transactions + compensating transactions nếu fail.

```
Order Saga:
  1. Order Service: createOrder()          [local tx]
     → emit OrderCreated
  2. Payment Service: reservePayment()     [local tx]  
     → emit PaymentReserved  (hoặc PaymentFailed → compensate)
  3. Inventory Service: reserveStock()     [local tx]
     → emit StockReserved    (hoặc StockFailed → compensate)
```

**Choreography vs Orchestration:**

| | Choreography | Orchestration |
|---|---|---|
| Ai điều phối | Không ai — services tự react với events | Saga Orchestrator trung tâm |
| Coupling | Low (event-based) | Orchestrator biết tất cả steps |
| Debug | Khó (flow phân tán) | Dễ hơn (logic tập trung) |
| Dùng khi | Flow đơn giản, ≤3 services | Flow phức tạp, cần visibility |

**PDMS use case:** Credit document migration — nếu bước validate fail, rollback document creation.

---

### [[CQRS-Materialized-View]]
Giải pháp cho "cần data của service khác mà không thể JOIN".

**Một câu:** Tách Write model (Command) và Read model (Query) — read side có thể là materialized view được build từ events.

```
Write side:                    Read side:
[Command] → [Service A]  →  Kafka event  →  [Read DB (materialized view)]
             [DB_A]                                    ↑
                                              Consumer builds view
```

**Điểm mấu chốt:** Read DB có thể join data từ nhiều services vì nó là replica được denormalize.

**Implementation steps:**
1. Service A publish `DomainEvent` khi data thay đổi
2. Read service consume event, update materialized view
3. Query API đọc từ materialized view — không cần gọi Service A

**Đây là giải pháp cho N+1 query problem cross-service boundaries** — vấn đề bạn đã giải quyết trong PDMS.

---

### [[Event-Sourcing]]
Persistence strategy: lưu events thay vì state.

**Một câu:** Thay vì UPDATE row trong DB, APPEND event vào event log — state hiện tại = replay tất cả events.

```
Traditional:  accounts table: { id: 1, balance: 850 }

Event Sourcing: event_log:
  { type: AccountOpened,  amount: 1000 }
  { type: MoneyDeposited, amount: 200  }
  { type: MoneyWithdrawn, amount: 350  }
  → Current balance = 1000 + 200 - 350 = 850
```

**Khi nào dùng:**
- ✅ Audit trail bắt buộc (banking, compliance)
- ✅ Cần time-travel queries ("balance vào ngày X là bao nhiêu?")
- ✅ Kết hợp với CQRS — events drive multiple projections

**Khi KHÔNG nên dùng:**
- ❌ Simple CRUD domain không cần audit
- ❌ Team chưa quen eventual consistency
- ❌ Query phức tạp mà không có CQRS projection đi kèm

---

## 🔗 Pattern relationships

```
Database-per-Service
    └─ tạo ra vấn đề cross-service data
         ├─ Saga ──── cho write operations (distributed transaction)
         └─ CQRS ─── cho read operations (materialized views)
              └─ Event Sourcing ─── storage strategy cho CQRS write side
```
# Event Sourcing

- [[Event-Sourcing]] — Deep dive: aggregate, event store, snapshot, upcasting
