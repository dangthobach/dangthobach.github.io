---
tags: [microservices, patterns, cqrs, kafka, read-model, n+1]
up: "[[01-Data-Consistency]]"
related: "[[Database-per-Service]], [[Event-Sourcing]], [[Transactional-Outbox]]"
---

# 📊 CQRS — Command Query Responsibility Segregation

> **TL;DR:** Tách write model (Commands) và read model (Queries) thành hai path riêng biệt. Read side dùng materialized views được build từ events — có thể denormalize data từ nhiều services mà không cần JOIN cross-service.

---

## 🎯 Problem: N+1 và cross-service queries

```java
// Bài toán: Hiển thị danh sách contracts với tên khách hàng
// Service A có contracts, Service B có customer names

// ❌ Naive solution — N+1 problem
List<Contract> contracts = contractService.findAll();  // 1 query
for (Contract c : contracts) {
    String name = customerService.getCustomerName(c.getCustomerId()); // N HTTP calls!
    // 1000 contracts = 1000 HTTP calls
}

// ❌ Cũng sai — cross-service JOIN không được phép
// SELECT c.*, cust.name FROM contracts c JOIN customers cust... 
// → Vi phạm Database-per-Service
```

**Root cause:** Mỗi service có DB riêng (đúng) nhưng query lại cần data của nhiều services (thực tế).

---

## ✅ Solution: CQRS với Materialized View

```
Write side (Command):
[API] → [Command Handler] → [Service DB] → publish [Domain Event] via Kafka

Read side (Query):
[Kafka Consumer] → build/update [Read DB (Materialized View)]
[API] ← query ← [Read DB]  ← denormalized, JOIN-ready
```

**Read DB có thể chứa data từ nhiều services** vì nó được build từ events — không phải query cross-service trực tiếp.

---

## 🏗️ Implementation

### Bước 1: Define Domain Events

```java
// Contract Service publish event khi contract thay đổi
public record ContractCreatedEvent(
    String contractId,
    String customerId,
    String contractType,
    LocalDate signedDate,
    BigDecimal value
) {}

public record ContractUpdatedEvent(
    String contractId,
    ContractStatus newStatus,
    LocalDateTime updatedAt
) {}
```

### Bước 2: Write side — publish event sau mỗi state change

```java
@Service
public class ContractCommandService {
    
    @Transactional
    public Contract createContract(CreateContractCommand cmd) {
        Contract contract = contractRepository.save(Contract.from(cmd));
        
        // Dùng Transactional Outbox để đảm bảo atomic publish
        outboxRepository.save(OutboxEvent.of(
            "contract-events",
            new ContractCreatedEvent(contract.getId(), cmd.getCustomerId(), ...)
        ));
        
        return contract;
    }
}
```

### Bước 3: Read side — Consumer build materialized view

```java
@Component
public class ContractReadModelProjector {
    
    @KafkaListener(topics = "contract-events")
    @Transactional
    public void on(ContractCreatedEvent event) {
        // Khi contract được tạo, call Customer Service một lần để lấy tên
        String customerName = customerServiceClient.getName(event.customerId());
        
        // Lưu vào read DB — đã denormalize sẵn
        contractReadRepository.save(ContractReadModel.builder()
            .contractId(event.contractId())
            .customerId(event.customerId())
            .customerName(customerName)      // ← denormalized từ Customer Service
            .contractType(event.contractType())
            .value(event.value())
            .build());
    }
    
    @KafkaListener(topics = "customer-events")
    @Transactional
    public void on(CustomerNameUpdatedEvent event) {
        // Khi customer đổi tên, update tất cả contracts của customer đó
        contractReadRepository.updateCustomerName(
            event.customerId(), event.newName()
        );
    }
}
```

### Bước 4: Query side — đơn giản, fast

```java
@RestController
public class ContractQueryController {
    
    @GetMapping("/contracts")
    public Page<ContractDTO> getContracts(Pageable pageable) {
        // Query trực tiếp từ read DB — không gọi service khác
        return contractReadRepository.findAll(pageable)
            .map(ContractDTO::from);
    }
    
    @GetMapping("/contracts/search")
    public List<ContractDTO> search(@RequestParam String customerName) {
        // Full-text search nếu read DB là Elasticsearch
        return searchRepository.searchByCustomerName(customerName);
    }
}
```

---

## 📐 Schema Design: Read Model vs Write Model

```sql
-- Write model (normalized, optimized for writes)
CREATE TABLE contracts (
    id UUID PRIMARY KEY,
    customer_id UUID NOT NULL,  -- chỉ lưu FK
    type VARCHAR(50),
    value DECIMAL(20, 2),
    status VARCHAR(20),
    created_at TIMESTAMP
);

-- Read model (denormalized, optimized for reads)
CREATE TABLE contracts_read (
    contract_id UUID PRIMARY KEY,
    customer_id UUID,
    customer_name VARCHAR(255),     -- ← denormalized
    customer_segment VARCHAR(50),   -- ← denormalized
    contract_type VARCHAR(50),
    value DECIMAL(20, 2),
    status VARCHAR(20),
    -- Thêm bất kỳ field nào cần cho UI
    days_since_signed INTEGER,      -- ← computed
    is_high_value BOOLEAN           -- ← computed
);
```

---

## ⚖️ Trade-offs

| ✅ Lợi | ⚠️ Chi phí |
|---|---|
| Giải quyết N+1 hoàn toàn | Eventual consistency — read lag sau write |
| Query cực nhanh (denormalized) | Code nhiều hơn: 2 models, 2 APIs, consumers |
| Scale read/write độc lập | Read model có thể stale (phải handle) |
| Mỗi use case có read model riêng | Event schema phải backward-compatible |
| Dễ thêm read model mới không ảnh hưởng write | Debugging phức tạp hơn |

---

## 🔑 Eventual Consistency — cách handle

```java
// Client gửi command, nhận acknowledgment
// Sau đó query read model — có thể chưa update

// Option 1: Optimistic UI — show expected state ngay
// Option 2: Return version number, client poll đến khi version match
// Option 3: Command returns ID, client kiểm tra status endpoint

@PostMapping("/contracts")
public ResponseEntity<CreateContractResponse> createContract(...) {
    String contractId = commandService.createContract(cmd);
    return ResponseEntity
        .accepted()
        .body(new CreateContractResponse(contractId, "PROCESSING"));
        // Client sau đó GET /contracts/{id} để check status
}
```

---

## 🏦 PDMS Application

```
Write side:
  DocumentService → lưu vào pdms_document_db → publish DocumentEvents

Read side (Elasticsearch hoặc PostgreSQL read DB):
  ContractSearchProjector → consume DocumentEvents + CreditEvents
  → build contract_search_view với:
     - document metadata
     - customer info (denormalized)  
     - credit account info (denormalized)
     - full-text searchable fields
  
Query:
  GET /documents/search?customerId=...&type=HOPDONG → instant, no N+1
```

---

## 🔗 Liên kết
- [[01-Data-Consistency]] — Group overview  
- [[Event-Sourcing]] — CQRS write side có thể dùng Event Sourcing
- [[Transactional-Outbox]] — Đảm bảo event publish atomic
- [[Database-per-Service]] — Vấn đề mà CQRS giải quyết
