# SOLID Principles — Deep Dive

---
tags: [architecture, oop, design-principles, java, clean-code]
created: 2026-05-02
difficulty: intermediate
estimated-read: 20 min
links: [[clean-architecture-hexagonal]], [[ddd-tactical]], [[testing-strategy-pyramid]]

---

## 🎯 Learning Objectives

Sau bài này bạn sẽ:
- Hiểu **bản chất thực sự** của từng nguyên tắc SOLID — không chỉ định nghĩa thuộc lòng
- Nhận diện được **code vi phạm** và biết cách refactor
- Hiểu **mối quan hệ** giữa các nguyên tắc (chúng hỗ trợ nhau)
- Áp dụng vào Java/Spring Boot với ví dụ thực tế PDMS

---

## 🧭 Tổng quan — Tại sao SOLID tồn tại?

Code xấu không xuất hiện ngay từ đầu. Nó tích lũy dần qua các sprint:

```
Sprint 1:  DocumentService.java — 200 lines, clean ✓
Sprint 5:  DocumentService.java — 800 lines, "just add logic here" 
Sprint 10: DocumentService.java — 2000 lines, nobody dares touch it
Sprint 15: "We need to rewrite everything" 😱
```

**SOLID** là 5 nguyên tắc thiết kế giúp code:
- **Dễ thay đổi** — không sợ break chỗ khác
- **Dễ test** — unit test không cần mock cả universe
- **Dễ hiểu** — junior đọc được, không cần senior giải thích

> Tác giả: Robert C. Martin (Uncle Bob), ~2000. Không phải "quy tắc tuyệt đối" mà là **trade-off guide**.

---

## 1️⃣ S — Single Responsibility Principle (SRP)

### Định nghĩa thực sự

> "A class should have only **one reason to change**."

**Sai lầm phổ biến:** Nghĩ SRP = "mỗi class chỉ làm một việc". Thực ra ý là:

> **"Chỉ có một actor (người dùng/nhóm) có quyền yêu cầu thay đổi class này"**

```
┌─────────────────────────────────────────────────────────┐
│               DocumentService (vi phạm SRP)              │
├─────────────────────────────────────────────────────────┤
│ + validateDocument()     ← Business team yêu cầu thay   │
│ + saveDocument()         ← DBA yêu cầu thay đổi         │
│ + sendNotification()     ← Ops team yêu cầu thay đổi    │
│ + generatePdfReport()    ← Report team yêu cầu thay đổi │
│ + logAuditTrail()        ← Compliance team yêu cầu thay │
└─────────────────────────────────────────────────────────┘
          ↑ 5 actors = 5 reasons to change = SRP violation!
```

### Code vi phạm

```java
// ❌ Vi phạm SRP — DocumentService có quá nhiều responsibilities
@Service
public class DocumentService {
    
    public void processDocument(Document doc) {
        // 1. Business validation
        if (doc.getTitle() == null || doc.getTitle().isBlank()) {
            throw new ValidationException("Title required");
        }
        
        // 2. Persistence
        documentRepository.save(doc);
        
        // 3. Notification
        emailService.sendEmail(doc.getOwner().getEmail(), 
            "Document " + doc.getId() + " saved");
        
        // 4. Audit logging
        auditLog.log("DOCUMENT_SAVED", doc.getId(), currentUser());
        
        // 5. PDF generation
        pdfGenerator.generate(doc);
    }
}
```

**Vấn đề:** Khi business team muốn thay validation rule, bạn sửa file này. Khi email template thay đổi, bạn sửa file này. Khi audit format thay đổi... Mỗi thay đổi đều có nguy cơ break các chức năng khác.

### Code sau refactor

```java
// ✅ Tuân thủ SRP — mỗi class có 1 actor

@Component
public class DocumentValidator {           // Business team owns
    public void validate(Document doc) {
        if (doc.getTitle() == null || doc.getTitle().isBlank())
            throw new ValidationException("Title required");
    }
}

@Repository
public class DocumentRepository { ... }   // DBA/persistence team owns

@Component
public class DocumentNotifier {           // Ops team owns
    public void notifyOwner(Document doc) {
        emailService.sendEmail(doc.getOwner().getEmail(), ...);
    }
}

@Component
public class DocumentAuditLogger {        // Compliance team owns
    public void logSaved(Document doc) {
        auditLog.log("DOCUMENT_SAVED", doc.getId(), currentUser());
    }
}

@Service
public class DocumentService {            // Orchestrator — thin layer
    public void processDocument(Document doc) {
        validator.validate(doc);
        documentRepository.save(doc);
        notifier.notifyOwner(doc);
        auditLogger.logSaved(doc);
    }
}
```

> 💡 **Tip:** SRP không có nghĩa là "tiny class everywhere". Kéo phân tách quá mức cũng tệ. Hỏi: *"Ai sẽ yêu cầu thay đổi code này?"* — nếu câu trả lời là nhiều nhóm khác nhau → tách.

---

## 2️⃣ O — Open/Closed Principle (OCP)

### Định nghĩa

> "Software entities should be **open for extension**, but **closed for modification**."

Tức là: **thêm behavior mới bằng cách viết code mới**, không sửa code cũ.

```
┌─────────────────────────────────────────────────────────┐
│               TRƯỚC OCP (If-Else hell)                   │
│                                                          │
│  if (type == "PDF") { ... }                              │
│  else if (type == "WORD") { ... }                        │
│  else if (type == "EXCEL") { ... }                       │
│  // Mỗi lần thêm format → sửa file này → risk break     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│               SAU OCP (Strategy/Plugin pattern)          │
│                                                          │
│  interface DocumentExporter { export(doc); }             │
│       ▲              ▲              ▲                    │
│  PdfExporter   WordExporter   ExcelExporter             │
│                                                          │
│  // Thêm format mới → tạo class mới, không sửa code cũ  │
└─────────────────────────────────────────────────────────┘
```

### Code vi phạm

```java
// ❌ Vi phạm OCP — phải sửa method này mỗi khi thêm format
public class DocumentExportService {
    public byte[] export(Document doc, String format) {
        if ("PDF".equals(format)) {
            return exportToPdf(doc);
        } else if ("WORD".equals(format)) {
            return exportToWord(doc);
        } else if ("EXCEL".equals(format)) {  // added in sprint 5
            return exportToExcel(doc);
        } else if ("CSV".equals(format)) {    // added in sprint 8
            return exportToCsv(doc);
        }
        // Mỗi sprint thêm 1 else-if → technical debt
        throw new UnsupportedFormatException(format);
    }
}
```

### Code sau refactor

```java
// ✅ Tuân thủ OCP — thêm format mới = tạo class mới

public interface DocumentExporter {
    String getSupportedFormat();
    byte[] export(Document doc);
}

@Component
public class PdfDocumentExporter implements DocumentExporter {
    public String getSupportedFormat() { return "PDF"; }
    public byte[] export(Document doc) { /* PDF logic */ }
}

@Component  
public class WordDocumentExporter implements DocumentExporter {
    public String getSupportedFormat() { return "WORD"; }
    public byte[] export(Document doc) { /* Word logic */ }
}

@Service
public class DocumentExportService {
    private final Map<String, DocumentExporter> exporters;
    
    // Spring tự inject tất cả implementations vào List,
    // ta build Map để lookup O(1)
    public DocumentExportService(List<DocumentExporter> exporterList) {
        this.exporters = exporterList.stream()
            .collect(Collectors.toMap(
                DocumentExporter::getSupportedFormat,
                Function.identity()
            ));
    }
    
    public byte[] export(Document doc, String format) {
        DocumentExporter exporter = exporters.get(format);
        if (exporter == null) throw new UnsupportedFormatException(format);
        return exporter.export(doc);
    }
}

// Thêm format mới: chỉ tạo class mới, không sửa gì cả ✓
@Component
public class CsvDocumentExporter implements DocumentExporter {
    public String getSupportedFormat() { return "CSV"; }
    public byte[] export(Document doc) { /* CSV logic */ }
}
```

> 💡 **Tip:** OCP đặc biệt hữu ích khi có **nhiều variations** của cùng một behavior. Đừng over-engineer nếu chỉ có 2 loại — YAGNI (You Ain't Gonna Need It).

---

## 3️⃣ L — Liskov Substitution Principle (LSP)

### Định nghĩa

> "Objects of a subclass must be **substitutable** for objects of the superclass without altering program correctness."

Nói đơn giản: **Subclass không được "yếu hơn" superclass**. Code dùng superclass phải hoạt động đúng khi nhận subclass.

```
┌────────────────────────────────────────────────────────┐
│                    LSP Test                             │
│                                                         │
│  void processDocument(DocumentRepository repo) {        │
│      // Code này phải chạy đúng dù repo là:            │
│      // - PostgresDocumentRepository                    │
│      // - MongoDocumentRepository                       │
│      // - InMemoryDocumentRepository (test)             │
│  }                                                      │
│                                                         │
│  → Nếu InMemoryRepo throw Exception khi gọi findAll()  │
│    → Vi phạm LSP!                                       │
└────────────────────────────────────────────────────────┘
```

### Vi phạm LSP kinh điển

```java
// ❌ Vi phạm LSP — ReadOnlyDocumentRepo không thể thay thế DocumentRepo
public class DocumentRepository {
    public void save(Document doc) { /* save to DB */ }
    public void delete(Document doc) { /* delete from DB */ }
    public Document findById(Long id) { /* query */ }
}

public class ReadOnlyDocumentRepository extends DocumentRepository {
    @Override
    public void save(Document doc) {
        throw new UnsupportedOperationException("Read-only!"); // ❌
    }
    
    @Override
    public void delete(Document doc) {
        throw new UnsupportedOperationException("Read-only!"); // ❌
    }
}

// Code này sẽ fail nếu nhận ReadOnlyDocumentRepository:
public void archiveDocument(DocumentRepository repo, Long id) {
    Document doc = repo.findById(id);
    doc.setStatus(ARCHIVED);
    repo.save(doc); // 💥 UnsupportedOperationException!
}
```

### Refactor — tách interface đúng nghĩa

```java
// ✅ Tuân thủ LSP — thiết kế đúng hierarchy

public interface DocumentReader {
    Document findById(Long id);
    List<Document> findAll();
}

public interface DocumentWriter {
    void save(Document doc);
    void delete(Document doc);
}

public interface DocumentRepository extends DocumentReader, DocumentWriter {}

// ReadOnly chỉ implement DocumentReader — honest contract
public class ReadOnlyDocumentRepository implements DocumentReader {
    public Document findById(Long id) { /* query */ }
    public List<Document> findAll() { /* query */ }
    // Không có save/delete → không vi phạm gì!
}

// Archive function yêu cầu đúng interface
public void archiveDocument(DocumentRepository repo, Long id) {
    Document doc = repo.findById(id);
    doc.setStatus(ARCHIVED);
    repo.save(doc); // ✓ Guaranteed to work
}
```

> 💡 **Dấu hiệu vi phạm LSP:** Subclass override method bằng cách throw exception, hoặc bỏ trống (no-op) một method quan trọng.

---

## 4️⃣ I — Interface Segregation Principle (ISP)

### Định nghĩa

> "Clients should not be forced to depend on interfaces they do not use."

**Tránh "fat interfaces"** — interface có quá nhiều method khiến implementation phải implement những method mình không cần.

```
┌─────────────────────────────────────────────────────────┐
│               Fat Interface (vi phạm ISP)                │
│                                                          │
│  interface DocumentService {                             │
│    Document findById(Long id);    ← Reader needs this   │
│    void save(Document doc);       ← Writer needs this   │
│    byte[] exportPdf(Long id);     ← Reporter needs this │
│    void sendEmail(Long id);       ← Notifier needs this │
│    void validate(Document doc);   ← Validator needs this│
│  }                                                       │
│                                                          │
│  DocumentSearchService implements DocumentService {      │
│    // Phải implement save(), exportPdf(), sendEmail()... │
│    // ... mà không bao giờ dùng → method giả rỗng       │
│  }                                                       │
└─────────────────────────────────────────────────────────┘
```

### Refactor

```java
// ✅ Segregated interfaces — mỗi client chỉ depend vào những gì cần

public interface DocumentFinder {
    Document findById(Long id);
    List<Document> findByStatus(DocumentStatus status);
}

public interface DocumentPersistence {
    Document save(Document doc);
    void delete(Long id);
}

public interface DocumentExportPort {
    byte[] exportToPdf(Long documentId);
}

public interface DocumentNotificationPort {
    void notifyOwner(Long documentId, String message);
}

// Mỗi service chỉ inject interface nó thực sự cần:

@Service
public class DocumentSearchService {
    private final DocumentFinder finder;   // Only this!
    // Không bị phụ thuộc vào export/notification logic
}

@Service
public class DocumentApprovalService {
    private final DocumentFinder finder;
    private final DocumentPersistence persistence;
    private final DocumentNotificationPort notifier;
    // Không cần export logic
}
```

> 💡 **ISP và OCP liên quan chặt:** ISP giúp định nghĩa đúng "seam" để OCP hoạt động. Role Interface (nhỏ, purpose-driven) > Header Interface (fat, convenience-driven).

---

## 5️⃣ D — Dependency Inversion Principle (DIP)

### Định nghĩa

> "High-level modules should not depend on low-level modules. Both should depend on **abstractions**."
> "Abstractions should not depend on details. Details should depend on abstractions."

```
┌───────────────────────────────────────────────────────┐
│               Vi phạm DIP                              │
│                                                        │
│  DocumentApprovalService  ──depends──►  PostgresRepo  │
│       (High-level)                      (Low-level)   │
│                                                        │
│  Vấn đề: Muốn switch sang MongoDB?                    │
│  → Phải sửa DocumentApprovalService!                   │
└───────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────┐
│               Tuân thủ DIP                             │
│                                                        │
│  DocumentApprovalService  ──depends──►  DocumentRepo  │
│       (High-level)                      (Abstraction) │
│                                              ▲         │
│                                     PostgresRepoImpl  │
│                                     MongoRepoImpl     │
│                                     (Low-level detail)│
│                                                        │
│  → Switch DB: chỉ tạo implementation mới ✓            │
└───────────────────────────────────────────────────────┘
```

### Code thực tế — Spring Boot và DIP

Spring Boot thực hiện DIP tự nhiên thông qua **Dependency Injection**:

```java
// ✅ DIP trong Spring Boot

// Abstraction (Port) — defined by high-level domain
public interface DocumentRepository {
    Optional<Document> findById(Long id);
    Document save(Document document);
}

// Detail — infrastructure concern
@Repository
public class JpaDocumentRepository implements DocumentRepository {
    private final DocumentJpaRepository jpaRepo; // Spring Data JPA
    
    @Override
    public Optional<Document> findById(Long id) {
        return jpaRepo.findById(id);
    }
    
    @Override  
    public Document save(Document document) {
        return jpaRepo.save(document);
    }
}

// High-level service — depends ONLY on abstraction
@Service
public class DocumentApprovalService {
    private final DocumentRepository documentRepository; // Interface!
    
    public DocumentApprovalService(DocumentRepository documentRepository) {
        this.documentRepository = documentRepository;
    }
    
    public void approve(Long documentId, String approverId) {
        Document doc = documentRepository.findById(documentId)
            .orElseThrow(() -> new DocumentNotFoundException(documentId));
        doc.approve(approverId);
        documentRepository.save(doc);
    }
}

// Test — inject InMemory implementation thay thế DB!
class DocumentApprovalServiceTest {
    @Test
    void shouldApproveDocument() {
        // Dùng InMemory repo, không cần @SpringBootTest, không cần DB!
        DocumentRepository inMemoryRepo = new InMemoryDocumentRepository();
        DocumentApprovalService service = new DocumentApprovalService(inMemoryRepo);
        
        // ... test logic
    }
}
```

---

## 🔗 SOLID Hoạt Động Cùng Nhau

```
┌─────────────────────────────────────────────────────────────┐
│                  SOLID Synergy Map                           │
│                                                              │
│  SRP ──► định nghĩa rõ responsibility → dễ tách interface  │
│  ISP ──► tách interface nhỏ, cohesive → support DIP        │
│  DIP ──► abstraction tại boundary → enable OCP             │
│  OCP ──► extend via new class → không break LSP            │
│  LSP ──► substitutable subtype → DIP thực sự hoạt động    │
│                                                              │
│  Kết quả: Loose coupling + High cohesion                    │
└─────────────────────────────────────────────────────────────┘
```

---

## ⚠️ Anti-patterns & Khi SOLID bị lạm dụng

| Vấn đề | Dấu hiệu | Giải pháp |
|--------|-----------|-----------|
| Over-engineering | 10 interface cho CRUD đơn giản | YAGNI — đừng abstract trước khi cần |
| Premature abstraction | Interface chỉ có 1 implementation | Đợi đến lần thứ 2 cần implement |
| Class proliferation | 50 class chỉ để save 1 entity | Cân bằng — CRUD không cần Clean Arch |
| Dogmatic SRP | Tách quá mức, method 2 line | Cohesion quan trọng hơn size |

> 💡 **Golden Rule:** "Make it work → Make it right → Make it fast". SOLID ở bước "Make it right", không phải từ đầu.

---

## 📚 Case Study — PDMS Document Service Refactoring

### Tình huống thực tế:

```java
// ❌ DocumentService ban đầu tại PDMS — vi phạm nhiều SOLID
@Service
public class DocumentService {
    // 2000 lines
    // Validation + Persistence + Notification + Export + Audit
    // Mọi developer đều sợ sửa class này
}
```

### Áp dụng SOLID từng bước:

```
Bước 1 (SRP): Tách DocumentValidator, DocumentAuditLogger, DocumentNotifier
Bước 2 (OCP): Export logic → ExportPort + PdfExporter/WordExporter implementations  
Bước 3 (LSP): ReviewDocumentRepository không throw exception khi gọi save()
Bước 4 (ISP): Tách DocumentReader / DocumentWriter / DocumentExporter interfaces
Bước 5 (DIP): DocumentApprovalService depend on interface, không phải JpaRepository
```

### Kết quả:

```
Before: 1 file 2000 lines, 0% unit test coverage (cần SpringBootTest)
After:  15 files ~100 lines each, 85% unit test coverage (pure unit tests)
        Test build time: 45s → 8s
        Feature add time: 1 sprint → 2 days
```

---

## 🔑 Key Takeaways

1. **SRP** = "một reason to change" = một actor sở hữu class đó
2. **OCP** = dùng abstraction/strategy pattern, extension by addition not modification
3. **LSP** = subtype phải honest — không throw exception không mong đợi, không no-op
4. **ISP** = role interface > fat interface; client chỉ biết những gì nó cần
5. **DIP** = high-level → abstraction ← low-level; không bao giờ ngược lại
6. SOLID là **hướng dẫn, không phải luật** — cân bằng với YAGNI/KISS
7. Dấu hiệu cần SOLID: khó test, sợ thay đổi, nhiều merge conflict cùng file

---

## 🔗 Related Links

- [[clean-architecture-hexagonal]] — SOLID applied at architectural scale
- [[ddd-tactical]] — Aggregate, Entity design theo SOLID
- [[testing-strategy-pyramid]] — Tại sao DIP giúp testing dễ hơn
- [[caching-strategies-comprehensive]] — OCP trong cache strategy selection
