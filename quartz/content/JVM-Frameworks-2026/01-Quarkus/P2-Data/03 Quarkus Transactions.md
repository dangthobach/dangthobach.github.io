---
tags: [quarkus, transactions, transactional, cdi]
created: 2026-04-12
status: active
week: 4
phase: P2-Data
framework: quarkus
---

# Quarkus Transactions

## 📌 One-liner
> `@Transactional` trong Quarkus hoạt động tương tự Spring — nhưng backed bởi CDI interceptor thay vì Spring AOP proxy. Ngoài ra Quarkus hỗ trợ `@TestTransaction` để auto-rollback trong test.

---

## 🆚 Spring vs Quarkus @Transactional

| | Spring | Quarkus |
|--|--------|---------|
| Annotation | `@Transactional` | `@Transactional` (Jakarta) |
| Package | `org.springframework.transaction.annotation` | `jakarta.transaction.Transactional` |
| Propagation | `Propagation.REQUIRED` (default) | `TxType.REQUIRED` (default) |
| Rollback | `rollbackFor = Exception.class` | `rollbackOn = Exception.class` |
| Read-only | `@Transactional(readOnly = true)` | `@Transactional(value = TxType.REQUIRED)` + `@ReadOnly` |
| Test rollback | `@Transactional` trên test | `@TestTransaction` |
| CDI Scope issue | CGLIB proxy | CDI interceptor — cùng vấn đề self-invocation! |

---

## 💻 Basic Usage

```java
@ApplicationScoped
public class DocumentService {

    @Inject
    DocumentRepository docRepo;

    @Inject
    AuditRepository auditRepo;

    // === REQUIRED (default) — join existing hoặc tạo mới ===
    @Transactional
    public Document create(CreateDocRequest req) {
        Document doc = new Document();
        doc.setTitle(req.title());
        docRepo.persist(doc);            // trong transaction

        auditRepo.log("CREATE", doc.getId()); // cùng transaction
        return doc;
    }

    // === READ-ONLY — chỉ SELECT ===
    @Transactional(value = TxType.SUPPORTS)
    public List<Document> findAll() {
        return docRepo.listAll();
    }

    // === REQUIRES_NEW — luôn tạo transaction mới ===
    @Transactional(value = TxType.REQUIRES_NEW)
    public void logAudit(String action, Long docId) {
        // Chạy trong transaction riêng — không bị rollback bởi caller
        auditRepo.log(action, docId);
    }

    // === Rollback control ===
    @Transactional(rollbackOn = Exception.class,
                   dontRollbackOn = ValidationException.class)
    public void processDocument(Long id) throws Exception {
        // Rollback với mọi Exception, TRỪ ValidationException
    }
}
```

---

## 🔧 Transaction Propagation Types

```java
// TxType.REQUIRED (default)
// - Có tx hiện tại → join vào
// - Không có → tạo mới
@Transactional(value = TxType.REQUIRED)

// TxType.REQUIRES_NEW
// - Luôn tạo tx mới, suspend tx hiện tại
// - Dùng cho: audit log, notification (không muốn bị rollback cùng)
@Transactional(value = TxType.REQUIRES_NEW)

// TxType.SUPPORTS
// - Có tx → join, không có → chạy không có tx
// - Dùng cho: read-only operations
@Transactional(value = TxType.SUPPORTS)

// TxType.NOT_SUPPORTED
// - Suspend tx hiện tại, chạy không có tx
@Transactional(value = TxType.NOT_SUPPORTED)

// TxType.NEVER
// - Phải không có tx — nếu có thì throw exception
@Transactional(value = TxType.NEVER)

// TxType.MANDATORY
// - Phải có tx hiện tại — nếu không có thì throw exception
@Transactional(value = TxType.MANDATORY)
```

---

## ⚠️ Self-invocation Problem — Giống Spring!

```java
@ApplicationScoped
public class OrderService {

    @Transactional
    public void processOrder(Long id) {
        // ✅ OK — gọi method khác trong service NÀY
        // Nhưng transaction interceptor sẽ KHÔNG kích hoạt!
        this.sendNotification(id);  // ❌ @Transactional bị ignore!
    }

    @Transactional(value = TxType.REQUIRES_NEW)
    public void sendNotification(Long id) {
        // ← CDI interceptor không trigger vì gọi qua 'this'
        // (không qua CDI proxy)
    }
}

// Fix: inject bản thân (CDI proxy) hoặc tách thành service riêng
@ApplicationScoped
public class OrderService {

    @Inject
    NotificationService notificationService; // service riêng!

    @Transactional
    public void processOrder(Long id) {
        notificationService.send(id); // ✅ qua CDI proxy → @Transactional hoạt động
    }
}
```

---

## 🔧 @TestTransaction — Auto Rollback trong Test

```java
@QuarkusTest
@TestTransaction  // ← Auto rollback sau mỗi test method
class DocumentServiceTest {

    @Inject
    DocumentService documentService;

    @Test
    void createDocument_shouldPersist() {
        CreateDocRequest req = new CreateDocRequest("Test Doc");
        Document doc = documentService.create(req);

        assertNotNull(doc.getId());
        assertEquals("Test Doc", doc.getTitle());
        // Sau test này → AUTO ROLLBACK, DB sạch cho test tiếp theo
    }
}
```

---

## 🔧 Programmatic Transaction (UserTransaction)

```java
@ApplicationScoped
public class BatchService {

    @Inject
    UserTransaction tx;  // Programmatic control

    public void processBatch(List<Long> ids) throws Exception {
        tx.begin();
        try {
            for (Long id : ids) {
                processItem(id);
            }
            tx.commit();
        } catch (Exception e) {
            tx.rollback();
            throw e;
        }
    }
}
```

---

## ✅ Practice Checklist
- [ ] Tạo service với `@Transactional` cho create/update/delete
- [ ] Test propagation: `REQUIRES_NEW` cho audit log
- [ ] Reproduce self-invocation bug và fix bằng service tách
- [ ] Dùng `@TestTransaction` trong `@QuarkusTest`

## 🔗 Liên quan
- [[01 Panache Active Record]]
- [[02 Panache Repository Pattern]]

## 📖 Nguồn
- https://quarkus.io/guides/transaction
