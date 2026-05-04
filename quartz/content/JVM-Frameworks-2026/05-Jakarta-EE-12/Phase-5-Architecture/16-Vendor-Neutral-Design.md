# 16 — Vendor-Neutral System Design

> **Topic:** Thiết kế hệ thống không bị lock-in vào vendor/framework
> **Phase:** Architect Synthesis
> **Áp dụng:** PDMS multi-runtime strategy, banking compliance

---

## 1. Tại Sao Vendor-Neutral Quan Trọng

```
Rủi ro vendor lock-in:
├── Framework thay đổi license (Spring → Broadcom acquisition)
├── Runtime EOL (GlassFish từng bị Oracle bỏ)
├── Cloud vendor thay đổi pricing (AWS, GCP)
├── Compliance yêu cầu certified implementation (TCK)
└── M&A thay đổi ownership (VMware → Broadcom)

Jakarta EE TCK certification = vendor phải pass test suite
→ Chuyển từ WildFly sang Open Liberty: code không đổi, chỉ đổi runtime
→ Spring không có TCK equivalent
```

---

## 2. Hexagonal Architecture + Jakarta EE

```
                    ┌─────────────────────────┐
                    │     DOMAIN CORE          │
                    │  (Pure Java, no deps)    │
                    │                          │
                    │  Document, Contract,     │
                    │  BusinessRules, Events   │
                    └─────────┬───────────────┘
                              │ interfaces only
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
    ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
    │  REST Port  │  │  DB Port    │  │  MSG Port   │
    │  (Jakarta   │  │  (Jakarta   │  │  (Jakarta   │
    │   REST)     │  │   Data/JPA) │  │   Msg/MCP)  │
    └─────────────┘  └─────────────┘  └─────────────┘
         ▲                 ▲                ▲
         │   Jakarta EE    │   spec only    │
         ▼                 ▼                ▼
    ┌─────────────────────────────────────────────┐
    │              RUNTIME LAYER                  │
    │  Quarkus / WildFly / Open Liberty / Helidon │
    │  (swap without touching domain code)        │
    └─────────────────────────────────────────────┘
```

---

## 3. Domain Layer — Zero Dependencies

```java
// Domain: không import BATT từ framework

// Entity — pure Java
public class Document {
    private final String id;
    private final String tenantId;
    private String title;
    private DocumentStatus status;
    private Instant createdAt;

    // Business logic thuần Java
    public void submit(String submittedBy) {
        if (status != DocumentStatus.DRAFT) {
            throw new DocumentException("Only DRAFT can be submitted");
        }
        this.status = DocumentStatus.PENDING_REVIEW;
    }

    public boolean isExpired() {
        return expiryDate != null && expiryDate.isBefore(LocalDate.now());
    }

    public boolean canBeApprovedBy(String userId, Set<String> roles) {
        return roles.contains("APPROVER") && !submittedBy.equals(userId);
        // Maker-checker: không tự approve
    }
}

// Domain events — pure Java records
public record DocumentSubmitted(
    String documentId, String tenantId,
    String submittedBy, Instant occurredAt
) {}

// Repository interface — domain layer định nghĩa
public interface DocumentRepository {
    Optional<Document> findById(String id);
    Document save(Document doc);
    List<Document> findByTenantAndStatus(String tenantId, DocumentStatus status);
    long countByTenant(String tenantId);
}

// Use case — orchestrate domain objects
public class SubmitDocumentUseCase {
    private final DocumentRepository repo;
    private final DocumentEvents events;

    public SubmitDocumentUseCase(DocumentRepository repo, DocumentEvents events) {
        this.repo = repo;
        this.events = events;
    }

    public void execute(String documentId, String submittedBy) {
        Document doc = repo.findById(documentId)
            .orElseThrow(() -> new DocumentNotFoundException(documentId));

        doc.submit(submittedBy);
        repo.save(doc);

        events.publish(new DocumentSubmitted(
            documentId, doc.getTenantId(), submittedBy, Instant.now()
        ));
    }
}
```

---

## 4. Port/Adapter — Jakarta Spec Implementation

```java
// === JPA Adapter (implements domain Repository interface) ===
@ApplicationScoped
public class JpaDocumentRepository implements DocumentRepository {

    @PersistenceContext EntityManager em;

    @Override
    public Optional<Document> findById(String id) {
        return Optional.ofNullable(em.find(DocumentJpaEntity.class, id))
            .map(DocumentJpaEntity::toDomain);
    }

    @Override
    @Transactional
    public Document save(Document doc) {
        DocumentJpaEntity entity = DocumentJpaEntity.from(doc);
        if (em.contains(entity)) em.merge(entity);
        else em.persist(entity);
        return entity.toDomain();
    }

    @Override
    public List<Document> findByTenantAndStatus(String tid, DocumentStatus status) {
        return em.createQuery(
            "SELECT d FROM DocumentJpaEntity d WHERE d.tenantId = :tid AND d.status = :s",
            DocumentJpaEntity.class)
            .setParameter("tid", tid)
            .setParameter("s", status.name())
            .getResultList()
            .stream().map(DocumentJpaEntity::toDomain).toList();
    }
}

// JPA Entity — chỉ ở infrastructure layer, không phải domain
@Entity(name = "DocumentJpaEntity")
@Table(name = "documents")
class DocumentJpaEntity {
    @Id String id;
    @Column("tenant_id") String tenantId;
    String title;
    String status;
    @Column("created_at") Instant createdAt;

    static DocumentJpaEntity from(Document domain) {
        var e = new DocumentJpaEntity();
        e.id = domain.getId();
        e.tenantId = domain.getTenantId();
        e.title = domain.getTitle();
        e.status = domain.getStatus().name();
        e.createdAt = domain.getCreatedAt();
        return e;
    }

    Document toDomain() {
        return Document.reconstitute(id, tenantId, title,
            DocumentStatus.valueOf(status), createdAt);
    }
}

// === REST Adapter ===
@Path("/api/documents")
@Produces(MediaType.APPLICATION_JSON)
@ApplicationScoped
public class DocumentRestAdapter {

    @Inject SubmitDocumentUseCase submitUseCase;
    @Inject DocumentRepository repo;

    @POST
    @Path("/{id}/submit")
    public Response submit(@PathParam("id") String id,
                           @HeaderParam("X-User-Id") String userId) {
        submitUseCase.execute(id, userId);
        return Response.ok(Map.of("status", "SUBMITTED")).build();
    }
}

// === CDI Event Adapter ===
@ApplicationScoped
public class CdiDocumentEvents implements DocumentEvents {

    @Inject Event<DocumentSubmitted> submittedEvent;

    @Override
    public void publish(DocumentSubmitted event) {
        submittedEvent.fireAsync(event);
    }
}

// === CDI Wiring — compose use cases ===
@ApplicationScoped
public class UseCaseFactory {

    @Inject JpaDocumentRepository repo;
    @Inject CdiDocumentEvents events;

    @Produces
    @ApplicationScoped
    public SubmitDocumentUseCase submitDocumentUseCase() {
        return new SubmitDocumentUseCase(repo, events);
    }
}
```

---

## 5. Runtime Swap — Proof of Portability

```
Same domain code → different runtimes:

Quarkus deployment:
  src/main/java/domain/     ← unchanged
  src/main/java/adapters/   ← unchanged (Jakarta spec)
  pom.xml                   ← quarkus BOM
  quarkus properties        ← runtime config

WildFly deployment:
  src/main/java/domain/     ← unchanged
  src/main/java/adapters/   ← unchanged (Jakarta spec)
  pom.xml                   ← jakarta.ee-web-api provided
  web.xml + persistence.xml ← deployment descriptors

Open Liberty deployment:
  src/main/java/domain/     ← unchanged
  src/main/java/adapters/   ← unchanged (Jakarta spec)
  server.xml                ← Open Liberty config
```

---

## 6. Anti-Patterns — Tránh Lock-In

```java
// ❌ ANTI-PATTERN 1: Import vendor class trong domain
import io.quarkus.panache.common.Page;     // Quarkus-specific
import org.springframework.data.domain.Pageable; // Spring-specific
// → Domain phụ thuộc vào vendor → không portable

// ✅ FIX: Dùng custom value objects
public record DocumentPage(List<Document> content, long total, int page, int size) {}

// ❌ ANTI-PATTERN 2: Quarkus annotation trong domain
@io.quarkus.logging.Log    // Quarkus-specific
static volatile Logger log;

// ✅ FIX: Dùng SLF4J (vendor-neutral logging)
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
private static final Logger log = LoggerFactory.getLogger(DocumentService.class);

// ❌ ANTI-PATTERN 3: Config annotation từ vendor trong domain
@io.smallrye.config.ConfigMapping  // Quarkus-specific
interface AppConfig { ... }

// ✅ FIX: Inject config values vào constructor, không đặt trong domain
// Domain nhận primitive values, không nhận config object

// ❌ ANTI-PATTERN 4: Transaction annotation từ Spring trong use case
import org.springframework.transaction.annotation.Transactional;
@Transactional
public class SubmitDocumentUseCase { ... }

// ✅ FIX: @Transactional trong adapter layer (Jakarta spec)
// Use case không biết về transactions
```

---

## 7. TCK Compliance — Tại Sao Quan Trọng Với Banking

```
Banking compliance thường yêu cầu:
- "Certified compatible implementation"
- Audit trail cho software components
- Vendor support agreement (không phải community only)

Jakarta EE TCK (Technology Compatibility Kit):
- Runtime phải pass TCK để được gọi là "Jakarta EE compatible"
- GlassFish (Reference Implementation): ✅ TCK certified
- WildFly / JBoss EAP: ✅ TCK certified
- Open Liberty (IBM): ✅ TCK certified
- Payara: ✅ TCK certified
- Quarkus: ✅ TCK certified (subset — Core Profile)

Spring: ❌ Không có TCK — không phải Jakarta EE implementation
→ Spring là alternative ecosystem, không phải implementation của spec
```

---

*[[15-Profile-Design]] | [[00-Overview]] | Next: [[17-Spring-to-Jakarta-Migration]]*
