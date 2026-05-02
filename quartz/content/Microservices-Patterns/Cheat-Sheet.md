---
tags: [microservices, cheatsheet, quick-reference]
up: "[[00-Hub-Microservices-Patterns]]"
---

# ⚡ Microservices Patterns — Cheat Sheet

> Copy-paste reference. Khi gặp tình huống → tìm pattern → link deep dive.

---

## 🚦 Pattern Decision Tree

```
Có business operation cần gì?
│
├── Cần data của service khác?
│   ├── Để READ → [[CQRS-Materialized-View]] (build read replica từ events)
│   └── Để WRITE (cần transaction) → [[Saga-Pattern]] (choreography/orchestration)
│
├── Cần publish event + save DB đồng thời?
│   └── [[Transactional-Outbox]] — lưu event vào outbox table trong cùng TX
│
├── Consumer nhận Kafka message có thể duplicate?
│   └── [[Idempotent-Consumer]] — check idempotency_key trước khi xử lý
│
├── Service downstream chậm/fail?
│   └── [[Circuit-Breaker]] — fail fast, return fallback
│
├── Cần trace request qua nhiều services?
│   └── [[04-Observability]] — OpenTelemetry + Jaeger
│
└── Đang migrate từ monolith?
    └── [[05-Decomposition]] — Strangler Fig + Anti-Corruption Layer
```

---

## 📋 Pattern Summary Table

| Pattern | Problem | Solution | Trade-off |
|---|---|---|---|
| Database per Service | Shared DB = coupling | Mỗi service DB riêng | Không JOIN cross-service |
| Saga | Distributed transaction | Chuỗi local TX + compensate | Eventual consistency |
| CQRS | N+1 cross-service query | Tách read/write model | Complexity, eventual read |
| Event Sourcing | Audit trail, time-travel | Lưu events không lưu state | Query phức tạp hơn |
| Transactional Outbox | Dual write problem | Event trong cùng DB TX | Cần poller hoặc CDC |
| Idempotent Consumer | Kafka at-least-once | idempotency_key check | Thêm processed_events table |
| API Gateway | Cross-cutting cho external | Single entry point | Single point of failure |
| Circuit Breaker | Cascade failure | Fail fast khi threshold | Cần tune thresholds |
| Strangler Fig | Big bang rewrite risk | Migrate từng feature | Thời gian dài, dual maintenance |

---

## 🔥 Combo Patterns Thực Tế

### Combo 1: Event-driven data sync (PDMS cần)
```
Write:   Service A → [Outbox Table] ← cùng DB TX
Publish: Debezium CDC → Kafka
Read:    Service B consumer → update Materialized View
Query:   Client → Service B Read API (không call Service A)
```
Patterns: `Transactional Outbox` + `CQRS` + `Idempotent Consumer`

### Combo 2: Long-running business process
```
Trigger:  API call → Saga Orchestrator starts
Step 1:   Command → Service A → Success event
Step 2:   Command → Service B → Fail event
Rollback: Compensating command → Service A undo
```
Patterns: `Saga (Orchestration)` + `Transactional Outbox` + `Idempotent Consumer`

### Combo 3: Resilient API calls
```
Client → API Gateway (rate limit + auth)
       → Circuit Breaker (fail fast)
       → Service (timeout configured)
       → Fallback response nếu open
```
Patterns: `API Gateway` + `Circuit Breaker` + `TimeLimiter`

---

## ⚙️ Spring Boot Config Snippets

### Circuit Breaker + TimeLimiter
```yaml
resilience4j:
  circuitbreaker:
    instances:
      myService:
        slidingWindowSize: 10
        failureRateThreshold: 50
        waitDurationInOpenState: 30s
        slowCallDurationThreshold: 3s
  timelimiter:
    instances:
      myService:
        timeoutDuration: 5s  # PHẢI > P99 của downstream service
```

### Kafka Consumer Idempotency
```java
@KafkaListener(topics = "my-topic")
@Transactional
public void handle(MyEvent event) {
    if (processedEventRepo.existsById(event.getEventId())) return;
    // business logic
    processedEventRepo.save(new ProcessedEvent(event.getEventId()));
}
```

### Outbox Table
```sql
CREATE TABLE outbox_events (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    aggregate_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    published_at TIMESTAMP
);
CREATE INDEX idx_outbox_pending ON outbox_events(created_at) 
    WHERE published_at IS NULL;
```

---

## 🏦 PDMS Patterns Map

```
pdms_document_db ←── Document Service ──→ outbox_events
                                                │ Debezium CDC
pdms_credit_db ←─── Credit Service             ▼
                                           Kafka topics
pdms_workflow_db ←── Workflow Service      │
                                           ▼
                        Contract Read DB (denormalized)
                           ← CQRS Projector consumes events
```

---

## 🔗 Deep Dives
- [[00-Hub-Microservices-Patterns]] — Full index
- [[01-Data-Consistency]] — DB-per-Service, Saga, CQRS, Event Sourcing
- [[02-Communication]] — Outbox, API Gateway, Idempotent Consumer
- [[03-Reliability]] — Circuit Breaker, Service Discovery
- [[04-Observability]] — Tracing, Metrics, Logs
- [[05-Decomposition]] — DDD, Strangler Fig, Container
