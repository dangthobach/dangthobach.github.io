---
tags: [microservices, patterns, communication, kafka, messaging, outbox]
up: "[[00-Hub-Microservices-Patterns]]"
---

# 📡 02 — Communication Patterns

> **Core problem:** Services cần giao tiếp — nhưng giao tiếp đúng cách để không tạo tight coupling, không mất messages, không xử lý duplicate.

---

## 🧭 Sync vs Async — lựa chọn đầu tiên

```
Synchronous (RPI):
  [Service A] ──HTTP/gRPC──► [Service B]
  A chờ B trả lời
  → Simple, nhưng A phụ thuộc availability của B

Asynchronous (Messaging):
  [Service A] ──event──► [Kafka] ──► [Service B]
  A không chờ
  → Resilient, loose coupling, nhưng eventual consistency
```

**Rule of thumb:**
- **Sync** khi cần response ngay để tiếp tục (user-facing, validation)
- **Async** khi là side effect, background processing, hoặc cross-service state change

---

## 🗂️ Patterns trong nhóm này

### [[Transactional-Outbox]]
**Vấn đề cốt lõi nhất khi dùng Kafka + DB.**

Một câu: Lưu event vào bảng `outbox` trong cùng DB transaction với business data → đảm bảo "either both succeed or both fail".

```
❌ Sai — không atomic:
  BEGIN TX
    UPDATE orders SET status = 'PAID'
  COMMIT
  kafka.publish(OrderPaidEvent)  ← nếu crash ở đây → event mất!

✅ Đúng — Transactional Outbox:
  BEGIN TX
    UPDATE orders SET status = 'PAID'
    INSERT INTO outbox (event_type, payload) VALUES ('OrderPaid', {...})
  COMMIT
  -- Outbox poller/CDC đọc từ outbox và publish lên Kafka
```

**Implementation options:**
- **Polling publisher:** Background job query `SELECT * FROM outbox WHERE published = false`
- **CDC (Change Data Capture):** Debezium đọc PostgreSQL WAL log, publish tới Kafka

**CDC tốt hơn polling vì:** Real-time, không cần polling interval, không miss events.

---

### [[API-Gateway]]
Một câu: Single entry point cho tất cả external clients — xử lý routing, auth, rate limiting, SSL termination tập trung.

```
External Client
      │
      ▼
[API Gateway]  ← auth, rate limit, routing
  │    │    │
  ▼    ▼    ▼
[Svc A][Svc B][Svc C]
```

**Spring Cloud Gateway config:**
```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: document-service
          uri: lb://document-service
          predicates:
            - Path=/api/documents/**
          filters:
            - StripPrefix=1
            - name: CircuitBreaker
              args:
                name: documentCB
                fallbackUri: forward:/fallback
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 10
                redis-rate-limiter.burstCapacity: 20
```

**⚠️ TimeLimiter gotcha (bạn đã gặp):**
```yaml
resilience4j:
  timelimiter:
    instances:
      documentCB:
        timeoutDuration: 3s  # phải > connection timeout của service downstream
```
Nếu `timeoutDuration` < thời gian service cần để response → 503 liên tục dù service đang hoạt động.

---

### [[Idempotent-Consumer]]
Một câu: Kafka đảm bảo at-least-once delivery — consumer PHẢI xử lý duplicate messages an toàn.

```
Kafka delivery semantics:
  at-most-once:   có thể mất message
  at-least-once:  có thể duplicate  ← Kafka default
  exactly-once:   phức tạp, có overhead
```

**Implementation với idempotency key:**
```java
@KafkaListener(topics = "payment-events")
@Transactional
public void handlePaymentReserved(PaymentReservedEvent event) {
    String idempotencyKey = event.getEventId(); // unique event ID
    
    // Check đã xử lý chưa
    if (processedEventRepository.existsById(idempotencyKey)) {
        log.info("Duplicate event {}, skipping", idempotencyKey);
        return;
    }
    
    // Xử lý business logic
    orderService.confirmPayment(event.getOrderId());
    
    // Mark as processed trong cùng transaction
    processedEventRepository.save(new ProcessedEvent(idempotencyKey, Instant.now()));
}
```

**Schema:**
```sql
CREATE TABLE processed_events (
    event_id    VARCHAR(255) PRIMARY KEY,
    processed_at TIMESTAMP NOT NULL,
    event_type  VARCHAR(100)
);

-- Clean up old records để tránh table bloat
CREATE INDEX idx_processed_at ON processed_events(processed_at);
-- Job: DELETE FROM processed_events WHERE processed_at < NOW() - INTERVAL '7 days'
```

---

## 🔑 Pattern Combo: Outbox + Idempotent Consumer

Đây là cặp đôi bắt buộc khi dùng Kafka:

```
Producer side:    Transactional Outbox → đảm bảo at-least-once publish
Consumer side:    Idempotent Consumer  → đảm bảo xử lý duplicate an toàn
Result:           Effectively exactly-once behavior
```

---

## 🔗 Liên kết
- [[Transactional-Outbox]] — Deep dive
- [[API-Gateway]] — Deep dive  
- [[Idempotent-Consumer]] — Deep dive
- [[Circuit-Breaker]] — Tích hợp vào API Gateway
- [[Saga-Pattern]] — Outbox là prerequisite của Saga qua Kafka
