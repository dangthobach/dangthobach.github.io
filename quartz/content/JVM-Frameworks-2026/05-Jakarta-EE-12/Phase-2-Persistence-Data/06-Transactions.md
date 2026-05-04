# 06 — Jakarta Transactions 2.1

> **Spec:** Jakarta Transactions 2.1 | **Profile:** Web Profile
> **Spring equivalent:** `@Transactional` (Spring Transaction Management)
> **Prototype runtime:** Quarkus + Hibernate ORM

---

## 1. Spec Says

Jakarta Transactions (JTA) định nghĩa distributed transaction API cho Java EE. Gồm 3 component:
- **UserTransaction** — app-managed transaction (low-level)
- **TransactionManager** — container-managed (internal)
- **`@Transactional`** — declarative (dùng nhiều nhất)

---

## 2. @Transactional Mapping

```java
// === SPRING ===
@Transactional(
    propagation = Propagation.REQUIRED,
    isolation = Isolation.READ_COMMITTED,
    rollbackFor = Exception.class,
    readOnly = false,
    timeout = 30
)
public void processDocument(String id) { ... }

// === JAKARTA TRANSACTIONS ===
@Transactional(
    value = TxType.REQUIRED,          // propagation
    rollbackOn = Exception.class,     // ⚠️ khác Spring: rollbackOn, không phải rollbackFor
    dontRollbackOn = BusinessException.class,
    // không có isolation, readOnly, timeout trong spec
    // → dùng Hibernate hints hoặc vendor-specific
)
public void processDocument(String id) { ... }
```

---

## 3. Transaction Types (Propagation)

| Jakarta `TxType` | Spring `Propagation` | Behavior |
|---|---|---|
| `REQUIRED` (default) | `REQUIRED` | Join existing hoặc tạo mới |
| `REQUIRES_NEW` | `REQUIRES_NEW` | Luôn tạo mới, suspend existing |
| `MANDATORY` | `MANDATORY` | Phải có existing, nếu không → exception |
| `NOT_SUPPORTED` | `NOT_SUPPORTED` | Suspend existing, chạy không có TX |
| `NEVER` | `NEVER` | Nếu có existing TX → exception |
| `SUPPORTS` | `SUPPORTS` | Dùng existing nếu có, không thì chạy không TX |

```java
@ApplicationScoped
public class OrderService {

    @Inject AuditService auditService;
    @Inject InventoryService inventoryService;

    @Transactional(TxType.REQUIRED)        // join hoặc tạo mới
    public void placeOrder(Order order) {
        saveOrder(order);
        inventoryService.reserve(order);   // cùng transaction
        auditService.logOrder(order);      // cùng transaction
    }
}

@ApplicationScoped
public class AuditService {

    @Transactional(TxType.REQUIRES_NEW)   // luôn tạo TX riêng
    public void logOrder(Order order) {
        // TX độc lập — fail ở đây không rollback placeOrder()
        saveAuditLog(order);
    }
}

@ApplicationScoped
public class InventoryService {

    @Transactional(TxType.MANDATORY)      // phải được gọi trong TX
    public void reserve(Order order) {
        // Throw TransactionRequiredException nếu không có TX
        decreaseStock(order);
    }
}
```

---

## 4. Rollback Control

```java
// === SPRING ===
@Transactional(rollbackFor = Exception.class)         // rollback khi bất kỳ Exception
@Transactional(noRollbackFor = BusinessException.class)

// === JAKARTA ===
@Transactional(rollbackOn = Exception.class)          // rollback khi Exception
@Transactional(dontRollbackOn = BusinessException.class)

// Rollback programmatic (manual mark)
@Inject
TransactionSynchronizationRegistry tsr;

@Transactional
public void processWithConditionalRollback(String id) {
    try {
        dangerousOperation(id);
    } catch (SoftException e) {
        // Không throw → transaction không tự rollback
        // Nhưng muốn rollback → mark manually
        tsr.setRollbackOnly();  // Jakarta way
        // Spring way: TransactionAspectSupport.currentTransactionStatus().setRollbackOnly()
    }
}
```

---

## 5. UserTransaction — Programmatic (Low-Level)

```java
// === SPRING ===
TransactionTemplate template = new TransactionTemplate(txManager);
template.execute(status -> {
    doWork();
    if (someCondition) status.setRollbackOnly();
    return result;
});

// === JAKARTA — UserTransaction ===
@Inject
UserTransaction utx;

public void manualTransaction() throws Exception {
    utx.begin();
    try {
        doWork1();
        doWork2();
        utx.commit();
    } catch (Exception e) {
        utx.rollback();
        throw e;
    }
}

// Với timeout
utx.setTransactionTimeout(60); // seconds
utx.begin();
```

---

## 6. Transaction Events (CDI Integration)

```java
// Jakarta TX + CDI Events — observe TX lifecycle

@ApplicationScoped
public class TransactionAwareAudit {

    // Chạy TRƯỚC khi commit
    public void onBeforeCompletion(@Observes(during = IN_PROGRESS)
                                   OrderCreated event) {
        // Vẫn trong TX, có thể đọc/ghi DB
        prepareAuditRecord(event);
    }

    // Chạy SAU KHI commit thành công
    public void onSuccess(@Observes(during = AFTER_SUCCESS)
                          OrderCreated event) {
        // TX đã commit → safe để send notification, publish event
        notificationService.sendEmail(event.customerId());
    }

    // Chạy SAU KHI rollback
    public void onFailure(@Observes(during = AFTER_FAILURE)
                          OrderCreated event) {
        // TX đã rollback → cleanup, alert
        alertService.notify("Order creation failed: " + event.orderId());
    }

    // Chạy BẤT KỂ commit hay rollback
    public void onCompletion(@Observes(during = AFTER_COMPLETION)
                             OrderCreated event) {
        metricsService.recordAttempt();
    }
}
```

**Tương đương Spring:**
- `AFTER_SUCCESS` ≈ `@TransactionalEventListener(phase = AFTER_COMMIT)`
- `AFTER_FAILURE` ≈ `@TransactionalEventListener(phase = AFTER_ROLLBACK)`

---

## 7. Distributed Transactions — 2PC

```java
// Jakarta Transactions hỗ trợ XA (2-Phase Commit) cho distributed TX
// Dùng khi cần atomic update trên nhiều datasource / message broker

// XA DataSource config (application.properties trong Quarkus)
// quarkus.datasource.jdbc.transactions=xa
// quarkus.datasource."audit-db".jdbc.transactions=xa

@Transactional
public void transferAndAudit(String fromId, String toId, BigDecimal amount) {
    // Cả hai DB trong cùng XA transaction
    mainRepo.debit(fromId, amount);    // datasource 1
    auditRepo.logTransfer(...);        // datasource 2 (XA)
    // Commit 2-Phase: nếu một bên fail → cả hai rollback
}
```

---

## 8. Prototype — Document Workflow với TX

```java
@ApplicationScoped
public class DocumentWorkflowService {

    @Inject DocumentRepository docRepo;
    @Inject AuditRepository auditRepo;
    @Inject Event<DocumentStatusChanged> statusChangedEvent;

    // REQUIRED: join existing TX hoặc tạo mới
    @Transactional
    public void submitForReview(String documentId, String submittedBy) {
        Document doc = docRepo.findById(documentId)
            .orElseThrow(() -> new NotFoundException("Document: " + documentId));

        if (doc.getStatus() != DocumentStatus.DRAFT) {
            throw new BusinessException("Only DRAFT documents can be submitted");
            // BusinessException không trigger rollback vì không khai báo trong rollbackOn
        }

        doc.setStatus(DocumentStatus.PENDING_REVIEW);
        doc.setSubmittedBy(submittedBy);
        doc.setSubmittedAt(Instant.now());
        docRepo.save(doc);

        // Fire event — observer AFTER_SUCCESS sẽ send notification
        statusChangedEvent.fire(new DocumentStatusChanged(
            documentId, DocumentStatus.DRAFT, DocumentStatus.PENDING_REVIEW, submittedBy
        ));
    }

    // REQUIRES_NEW: audit log luôn được lưu, kể cả khi TX cha rollback
    @Transactional(TxType.REQUIRES_NEW)
    public void logAction(String documentId, String action, String userId) {
        AuditLog log = new AuditLog(documentId, action, userId, Instant.now());
        auditRepo.save(log);
    }

    // Bulk approve với error isolation
    @Transactional
    public BulkResult bulkApprove(List<String> documentIds, String approverId) {
        int success = 0, failed = 0;

        for (String id : documentIds) {
            try {
                approveSingle(id, approverId); // REQUIRES_NEW per document
                success++;
            } catch (Exception e) {
                failed++;
                // TX của approveSingle đã rollback, TX cha vẫn tiếp tục
                logAction(id, "APPROVE_FAILED: " + e.getMessage(), approverId);
            }
        }
        return new BulkResult(success, failed);
    }

    @Transactional(TxType.REQUIRES_NEW) // TX riêng cho mỗi document
    public void approveSingle(String documentId, String approverId) {
        Document doc = docRepo.findById(documentId)
            .orElseThrow(() -> new NotFoundException(documentId));

        if (doc.getStatus() != DocumentStatus.PENDING_REVIEW) {
            throw new BusinessException("Document not in PENDING_REVIEW state");
        }

        doc.setStatus(DocumentStatus.APPROVED);
        doc.setApprovedBy(approverId);
        docRepo.save(doc);
        logAction(documentId, "APPROVED", approverId);
    }
}

// CDI Observer — TX-aware notifications
@ApplicationScoped
public class NotificationService {

    public void onStatusChanged(
            @Observes(during = AFTER_SUCCESS) DocumentStatusChanged event) {
        // Chỉ chạy sau khi TX commit thành công
        // An toàn để send email, call external API
        System.out.printf("[NOTIFY] Document %s: %s → %s by %s%n",
            event.documentId(), event.from(), event.to(), event.changedBy());
    }
}
```

---

## 9. Architect Notes

**Khác biệt cần nhớ:**
- `rollbackOn` (Jakarta) ≠ `rollbackFor` (Spring) — **tên attribute khác nhau**
- Jakarta `@Transactional` là CDI interceptor — phải được gọi qua CDI proxy (không gọi `this.method()` trực tiếp)
- Spring có proxy problem tương tự nhưng cách fix khác (AspectJ mode)
- REQUIRES_NEW trong cùng `@ApplicationScoped` bean: gọi qua CDI proxy (inject self) hoặc tách ra bean khác

**Self-invocation problem:**
```java
// ❌ SAI — gọi trực tiếp bỏ qua CDI proxy → REQUIRES_NEW không hoạt động
@Transactional
public void outer() { this.inner(); }

@Transactional(TxType.REQUIRES_NEW)
public void inner() { ... }

// ✅ ĐÚNG — tách ra bean riêng
@Inject InnerService innerService;
@Transactional
public void outer() { innerService.inner(); }
```

---

*[[05-JPA-Deep-Dive]] | [[00-Overview]] | Next: [[07-Jakarta-Data]]*
