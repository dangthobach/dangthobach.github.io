---
tags: [microservices, patterns, database, coupling, architecture]
up: "[[01-Data-Consistency]]"
related: "[[Saga-Pattern]], [[CQRS-Materialized-View]]"
---

# 🗄️ Database per Service

> **TL;DR:** Mỗi microservice sở hữu database riêng. Không service nào được truy cập trực tiếp database của service khác. Đây là nền tảng của microservices — không có rule này, mọi thứ còn lại vô nghĩa.

---

## 🎯 Problem

Trong monolith, tất cả modules share một DB → tiện nhưng ẩn coupling nguy hiểm:

```sql
-- Service A query trực tiếp bảng của Service B
SELECT c.name, o.total
FROM customers c          -- owned by Customer Service
JOIN orders o ON ...      -- owned by Order Service  
WHERE c.region = 'VN'
```

Hệ quả:
- Thay đổi schema `orders` → phải kiểm tra tất cả nơi dùng
- Deploy Order Service → risk break Customer Service
- Không thể scale riêng từng service
- Không thể chọn DB engine phù hợp (Customer cần Graph DB, Order cần RDBMS)

---

## ✅ Solution

Mỗi service có **private database**. Cross-service data access chỉ qua **API** hoặc **Events**.

```
❌ WRONG:
[Customer Service] ──────────┐
[Order Service]    ──────────┼──► [Shared DB]
[Payment Service]  ──────────┘

✅ RIGHT:
[Customer Service] → [Customer DB (PostgreSQL)]
[Order Service]    → [Order DB (PostgreSQL)]
[Payment Service]  → [Payment DB (PostgreSQL)]
         ↕                ↕                ↕
         └────── chỉ giao tiếp qua API/Events ──────┘
```

---

## 🏗️ Implementation Options

### Option 1: Schema per Service (cùng DB instance)
```sql
-- PostgreSQL với nhiều schemas
CREATE SCHEMA customer_svc;
CREATE SCHEMA order_svc;
CREATE SCHEMA payment_svc;

-- Mỗi service chỉ có quyền trên schema của mình
GRANT ALL ON SCHEMA customer_svc TO customer_service_user;
GRANT ALL ON SCHEMA order_svc TO order_service_user;
```
**Dùng khi:** Dev/Staging, tiết kiệm infra, team nhỏ.
**Risk:** DBA vẫn có thể cross-query — cần discipline.

### Option 2: Database per Service (instance riêng)
```yaml
# docker-compose.yml
services:
  customer-db:
    image: postgres:16
    environment:
      POSTGRES_DB: customer_db
  
  order-db:
    image: postgres:16
    environment:
      POSTGRES_DB: order_db
```
**Dùng khi:** Production, cần strong isolation, compliance.

### Option 3: Polyglot Persistence
```
[Document Service] → PostgreSQL (structured data + JSONB)
[Search Service]   → Elasticsearch (full-text search)
[Session Service]  → Redis (TTL-based, fast read)
[Graph Service]    → Neo4j (relationship queries)
```
**Dùng khi:** Mỗi service có access pattern đặc thù rất khác nhau.

---

## ⚖️ Trade-offs

| ✅ Lợi | ⚠️ Chi phí |
|---|---|
| Deploy độc lập, zero-downtime | Không thể JOIN cross-service |
| Scale riêng từng service | Eventual consistency thay vì strong consistency |
| Chọn DB engine phù hợp | Quản lý nhiều DB instances phức tạp hơn |
| Fault isolation — DB của A chết không ảnh hưởng B | Distributed transactions cần Saga pattern |
| Schema evolution tự do | Data duplication (denormalization) |

---

## 🔥 Hệ quả cần handle

**1. Cross-service queries** → Dùng [[CQRS-Materialized-View]] hoặc API Composition

**2. Distributed transactions** → Dùng [[Saga-Pattern]]

**3. Referential integrity** → Không còn FK cross-service. Phải handle ở application layer:
```java
// Thay vì FK constraint trong DB:
// FOREIGN KEY (customer_id) REFERENCES customers(id)

// Phải validate tại application:
@Service
public class OrderService {
    public Order createOrder(CreateOrderCommand cmd) {
        // Gọi Customer Service để verify customer tồn tại
        customerServiceClient.verifyCustomerExists(cmd.getCustomerId());
        // Rồi mới tạo order
        return orderRepository.save(new Order(cmd));
    }
}
```

---

## 🏦 Áp dụng vào PDMS

```
pdms_document_db  → Document Service (lưu metadata hợp đồng)
pdms_credit_db    → Credit Service  (dữ liệu tín dụng, migration)
pdms_workflow_db  → Workflow Service (trạng thái xử lý)
pdms_search_db    → Elasticsearch   (full-text search documents)
```

Validation procedure `pr_process_validation_hopdong_batch` chỉ chạy trong `pdms_credit_db` — đúng pattern này.

---

## 🔗 Liên kết
- [[01-Data-Consistency]] — Group overview
- [[Saga-Pattern]] — Xử lý distributed transaction
- [[CQRS-Materialized-View]] — Xử lý cross-service queries
- [[Transactional-Outbox]] — Đảm bảo event publish atomic
