---
tags: [microservices, patterns, kafka, outbox, cdc, atomicity, messaging]
up: "[[02-Communication]]"
related: "[[Idempotent-Consumer]], [[Saga-Pattern]], [[CQRS-Materialized-View]]"
---

# 📬 Transactional Outbox Pattern

> **TL;DR:** Lưu message/event vào bảng `outbox` trong cùng DB transaction với business data. Một poller hoặc CDC (Debezium) đọc outbox và publish lên message broker. Đảm bảo "database write và message publish là atomic".

---

## 🎯 Problem: The Dual Write Problem

```
Tình huống: Order paid → phải update DB và publish event lên Kafka

❌ Option 1: Update DB trước, publish sau
  BEGIN TX → UPDATE orders SET paid=true → COMMIT
  kafka.send(OrderPaidEvent)
  
  Failure case: COMMIT thành công nhưng kafka.send() fail
  → DB: paid=true, Kafka: không có event → INCONSISTENT

❌ Option 2: Publish trước, update DB sau  
  kafka.send(OrderPaidEvent)
  BEGIN TX → UPDATE orders SET paid=true → COMMIT
  
  Failure case: kafka.send() thành công nhưng COMMIT fail
  → DB: paid=false, Kafka: có event → INCONSISTENT

❌ Option 3: Distributed transaction (XA)
  → Performance thảm họa, không scale, DB phải support XA
```

**Root cause:** DB transaction và Kafka publish là hai hệ thống khác nhau — không có single atomic unit.

---

## ✅ Solution: Outbox Table

```
┌─────────────────── Single DB Transaction ───────────────────┐
│  UPDATE orders SET status = 'PAID'                          │
│  INSERT INTO outbox (event_type, payload, created_at) ...   │
└─────────────────────────────────────────────────────────────┘
                              │
                    Commit thành công
                              │
              ┌───────────────▼────────────────┐
              │   Outbox Poller / CDC Reader   │
              │   (chạy ngoài transaction)     │
              └───────────────┬────────────────┘
                              │
                    kafka.send(event)
                              │
                    UPDATE outbox SET published=true
```

**Key insight:** Nếu service crash sau COMMIT nhưng trước khi publish → outbox record vẫn còn đó → poller sẽ retry. Không mất event.

---

## 🏗️ Implementation: Polling Publisher

### Schema

```sql
CREATE TABLE outbox_events (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    aggregate_id  VARCHAR(255) NOT NULL,   -- ID của entity (orderId, contractId)
    aggregate_type VARCHAR(100) NOT NULL,  -- "Order", "Contract"
    event_type    VARCHAR(100) NOT NULL,   -- "OrderPaid", "ContractCreated"
    payload       JSONB NOT NULL,          -- Event data
    created_at    TIMESTAMP DEFAULT NOW(),
    published_at  TIMESTAMP,               -- NULL = chưa publish
    retry_count   INTEGER DEFAULT 0
);

CREATE INDEX idx_outbox_unpublished ON outbox_events(created_at) 
    WHERE published_at IS NULL;
```

### Business code — lưu vào outbox cùng TX

```java
@Service
@RequiredArgsConstructor
public class OrderService {
    private final OrderRepository orderRepository;
    private final OutboxRepository outboxRepository;
    
    @Transactional  // ← một transaction duy nhất
    public Order payOrder(String orderId) {
        Order order = orderRepository.findById(orderId)
            .orElseThrow(() -> new OrderNotFoundException(orderId));
        
        order.markAsPaid();
        orderRepository.save(order);
        
        // Lưu event vào outbox — cùng transaction
        outboxRepository.save(OutboxEvent.builder()
            .aggregateId(orderId)
            .aggregateType("Order")
            .eventType("OrderPaid")
            .payload(objectMapper.writeValueAsString(
                new OrderPaidEvent(orderId, order.getTotalAmount(), Instant.now())
            ))
            .build());
        
        return order;
    }
}
```

### Outbox Poller

```java
@Component
@RequiredArgsConstructor
public class OutboxPoller {
    private final OutboxRepository outboxRepository;
    private final KafkaTemplate<String, String> kafkaTemplate;
    
    @Scheduled(fixedDelay = 100)  // chạy mỗi 100ms
    @Transactional
    public void publishPendingEvents() {
        List<OutboxEvent> events = outboxRepository
            .findTop100ByPublishedAtIsNullOrderByCreatedAtAsc();
        
        for (OutboxEvent event : events) {
            try {
                kafkaTemplate.send(
                    topicFor(event.getEventType()),
                    event.getAggregateId(),  // partition key
                    event.getPayload()
                ).get(5, TimeUnit.SECONDS);
                
                event.markAsPublished();
                outboxRepository.save(event);
            } catch (Exception e) {
                event.incrementRetry();
                outboxRepository.save(event);
            }
        }
    }
}
```

---

## 🏗️ Implementation: CDC với Debezium (tốt hơn)

Debezium đọc PostgreSQL WAL (Write-Ahead Log) → automatically publish thay đổi lên Kafka. Không cần polling, real-time.

```yaml
# Debezium connector config
{
  "name": "pdms-outbox-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "postgres",
    "database.dbname": "pdms_db",
    "table.include.list": "public.outbox_events",
    "transforms": "outbox",
    "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter",
    "transforms.outbox.table.field.event.id": "id",
    "transforms.outbox.table.field.event.key": "aggregate_id",
    "transforms.outbox.table.field.event.type": "event_type",
    "transforms.outbox.table.field.event.payload": "payload",
    "transforms.outbox.route.by.field": "aggregate_type",
    "transforms.outbox.route.topic.replacement": "pdms.${routedByValue}.events"
  }
}
```

**Kết quả:** 
- `aggregate_type=Order` → publish tới topic `pdms.Order.events`
- `aggregate_type=Contract` → publish tới topic `pdms.Contract.events`
- Debezium tự handle retry, at-least-once delivery

---

## ⚖️ Polling vs CDC

| | Polling Publisher | CDC (Debezium) |
|---|---|---|
| Latency | 100ms+ (polling interval) | Near real-time (ms) |
| Complexity | Đơn giản | Cần setup Debezium + Kafka Connect |
| DB load | Polling tạo load | Đọc WAL — minimal overhead |
| Ordering | Phải handle manually | Guaranteed per partition |
| Dùng khi | Đơn giản, low throughput | Production, high throughput |

---

## 🏦 PDMS Application

```
Khi DocumentService nhận batch migration request:

BEGIN TX
  INSERT INTO documents (...) VALUES (...)       -- 10K records
  INSERT INTO outbox_events VALUES
    ('BatchCreated', {batchId, count: 10000, ...})
COMMIT

Debezium reads WAL → Kafka topic: pdms.Document.events
CreditService consumes → links credit accounts
WorkflowService consumes → creates workflow instances
```

---

## 🔗 Liên kết
- [[02-Communication]] — Communication patterns overview
- [[Idempotent-Consumer]] — Consumer phải xử lý duplicate events từ outbox
- [[Saga-Pattern]] — Outbox là foundation của event-driven Saga
- [[CQRS-Materialized-View]] — Outbox publish events mà CQRS consumer dùng
