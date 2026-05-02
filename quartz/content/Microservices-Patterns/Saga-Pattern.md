---
tags: [microservices, patterns, saga, distributed-transaction, consistency]
up: "[[01-Data-Consistency]]"
related: "[[Database-per-Service]], [[Transactional-Outbox]]"
---

# 🔄 Saga Pattern

> **TL;DR:** Thay thế distributed transaction (2PC) bằng chuỗi local transactions. Mỗi bước thành công thì emit event trigger bước tiếp. Nếu một bước fail, chạy **compensating transactions** ngược lại để rollback.

---

## 🎯 Problem

Một business operation cần update data ở nhiều services:

```
"Tạo đơn hàng" cần:
  1. Tạo Order record (Order Service)
  2. Trừ tiền khách hàng (Payment Service)  
  3. Giảm tồn kho (Inventory Service)
```

**2PC (Two-Phase Commit) là giải pháp cũ — sai trong microservices vì:**
- Đòi hỏi tất cả participants lock resource trong suốt quá trình
- Network partition → deadlock toàn hệ thống
- Tight coupling: tất cả services phải support 2PC protocol

---

## ✅ Solution: Saga

Chia thành N local transactions. Mỗi transaction thành công → emit event. Nếu transaction T_k fail → chạy compensating transactions từ T_{k-1} ngược về T_1.

```
Order Saga (happy path):
┌─────────────────────────────────────────────────────┐
│ 1. createOrder()    → OrderCreated event             │
│ 2. reservePayment() → PaymentReserved event          │
│ 3. reserveStock()   → StockReserved event            │
│ 4. confirmOrder()   → OrderConfirmed ✅              │
└─────────────────────────────────────────────────────┘

Order Saga (payment fail):
┌─────────────────────────────────────────────────────┐
│ 1. createOrder()    → OrderCreated                   │
│ 2. reservePayment() → PaymentFailed ❌               │
│    → compensate: cancelOrder() ← rollback bước 1    │
└─────────────────────────────────────────────────────┘
```

---

## 🏗️ Hai kiểu implement

### Choreography (Event-driven)
Không có coordinator trung tâm. Mỗi service lắng nghe event và tự quyết định bước tiếp.

```
Order Service    Payment Service    Inventory Service
     │                 │                   │
     │ OrderCreated ──►│                   │
     │                 │ PaymentReserved──►│
     │                 │                   │ StockReserved
     │◄────────────────┼───────────────────┘
     │ confirmOrder    │
```

**Code example (Spring + Kafka):**
```java
// Order Service — publish event sau khi tạo order
@Service
public class OrderService {
    @Transactional
    public Order createOrder(CreateOrderCommand cmd) {
        Order order = orderRepository.save(Order.pending(cmd));
        eventPublisher.publish(new OrderCreatedEvent(order.getId(), cmd.getAmount()));
        return order;
    }
}

// Payment Service — lắng nghe và xử lý
@KafkaListener(topics = "order-events")
public void handleOrderCreated(OrderCreatedEvent event) {
    try {
        paymentService.reserve(event.getOrderId(), event.getAmount());
        eventPublisher.publish(new PaymentReservedEvent(event.getOrderId()));
    } catch (InsufficientFundsException e) {
        eventPublisher.publish(new PaymentFailedEvent(event.getOrderId()));
    }
}

// Order Service — lắng nghe compensate event
@KafkaListener(topics = "payment-events")
public void handlePaymentFailed(PaymentFailedEvent event) {
    orderService.cancel(event.getOrderId()); // compensating transaction
}
```

**✅ Dùng khi:** Flow đơn giản, ≤3-4 services, team đã quen event-driven.
**⚠️ Nhược điểm:** Khó debug (flow phân tán), khó visualize toàn bộ workflow.

---

### Orchestration (Saga Orchestrator)
Một Orchestrator trung tâm gửi command đến từng service theo thứ tự.

```
                  ┌─ Saga Orchestrator ─┐
                  │  1. OrderCreated    │
                  │  2. reservePayment ─┼──► Payment Service
                  │  3. reserveStock  ──┼──► Inventory Service
                  │  4. confirmOrder  ──┼──► Order Service
                  └─────────────────────┘
```

**Code example (Spring State Machine hoặc Temporal):**
```java
@Component
public class CreateOrderSaga {
    
    @SagaEventHandler(associationProperty = "orderId")
    public void handle(OrderCreatedEvent event) {
        // Gửi command đến Payment Service
        commandGateway.send(new ReservePaymentCommand(
            event.getOrderId(), event.getAmount()
        ));
    }
    
    @SagaEventHandler(associationProperty = "orderId")
    public void handle(PaymentReservedEvent event) {
        commandGateway.send(new ReserveStockCommand(event.getOrderId()));
    }
    
    @SagaEventHandler(associationProperty = "orderId")
    public void handle(PaymentFailedEvent event) {
        // Compensate
        commandGateway.send(new CancelOrderCommand(event.getOrderId()));
        SagaLifecycle.end();
    }
}
```

**✅ Dùng khi:** Flow phức tạp (>4 steps), cần visibility, business logic phức tạp.
**⚠️ Nhược điểm:** Orchestrator có thể trở thành God Object nếu không cẩn thận.

---

## ⚖️ So sánh

| | Choreography | Orchestration |
|---|---|---|
| Coupling | Loose (event-based) | Orchestrator phụ thuộc tất cả services |
| Debug | Khó — phải trace events | Dễ — xem trạng thái Saga |
| Scalability | Tốt — không single point | Orchestrator có thể bottleneck |
| Business logic | Phân tán | Tập trung → dễ maintain |
| Dùng khi | Simple flows | Complex, long-running flows |

---

## 🔑 Compensating Transaction — nguyên tắc thiết kế

Không phải mọi operation đều có thể undo thật sự. Có hai loại:
- **Rollback thật:** Hủy reservation trước khi confirmed → đơn giản
- **Compensating:** Đã confirmed → phải tạo reverse operation (refund, restock)

```java
// Không phải "undo", mà là "semantic reverse"
public void compensatePayment(String orderId) {
    // Không delete payment record
    // Tạo refund transaction mới
    paymentRepository.save(Payment.refund(orderId));
}
```

---

## 🏦 PDMS Use Case

**Credit document migration saga:**
```
1. ImportExcelService: parse + validate batch         → BatchValidated
2. DocumentService: create document records           → DocumentsCreated
3. CreditService: link to credit accounts             → CreditLinked
4. AuditService: log migration event                  → AuditLogged ✅

Nếu CreditService fail:
→ compensate DocumentService: markDocumentsAsFailed()
→ compensate ImportExcelService: logFailedBatch()
```

---

## 🔗 Liên kết
- [[01-Data-Consistency]] — Group overview
- [[Transactional-Outbox]] — Đảm bảo event publish trong Saga là atomic
- [[Idempotent-Consumer]] — Consumer phải idempotent vì Kafka at-least-once
- [[CQRS-Materialized-View]] — Kết hợp Saga + CQRS cho write+read
