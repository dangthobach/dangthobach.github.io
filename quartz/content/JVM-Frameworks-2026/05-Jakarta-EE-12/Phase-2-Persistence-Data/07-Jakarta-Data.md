# 07 — Jakarta Data 1.1 ⭐ New in EE 12

> **Spec:** Jakarta Data 1.1 | **Profile:** Web Profile
> **Spring equivalent:** Spring Data Repositories
> **Tại sao quan trọng:** Đây là spec MỚI nhất, thay đổi cách làm data access trong Jakarta EE
> **Prototype runtime:** Quarkus 3.x + Hibernate ORM

---

## 1. Spec Says

Jakarta Data được introduce ở EE 11 (2024), update lên 1.1 ở EE 12 (2026). Mục tiêu: mang repository pattern (quen thuộc từ Spring Data) vào Jakarta EE ecosystem theo cách **spec-chuẩn, vendor-neutral**.

Điểm khác biệt với Spring Data:
- Dùng **annotation-based query** thay vì method name derivation
- Query language là **JDQL** (Jakarta Data Query Language) — subset của JPQL
- Interface **không extends** CrudRepository bắt buộc — có thể dùng annotation-only
- Tích hợp với **Jakarta Query 1.0** (spec mới EE 12)

---

## 2. Repository Mapping

```java
// === SPRING DATA ===
@Repository
public interface DocumentRepository extends JpaRepository<Document, String> {
    List<Document> findByStatus(String status);
    List<Document> findByTitleContaining(String keyword);
    Page<Document> findByType(String type, Pageable pageable);

    @Query("SELECT d FROM Document d WHERE d.status = :status AND d.type = :type")
    List<Document> findByStatusAndType(
        @Param("status") String status,
        @Param("type") String type
    );

    @Modifying
    @Query("UPDATE Document d SET d.status = :status WHERE d.id = :id")
    int updateStatus(@Param("id") String id, @Param("status") String status);
}

// === JAKARTA DATA 1.1 ===
@Repository
public interface DocumentRepository {

    // Basic CRUD — không cần extend CrudRepository
    @Find
    Optional<Document> findById(String id);

    @Save
    Document save(Document doc);

    @Delete
    void deleteById(String id);

    @Find
    List<Document> findByStatus(String status);     // parameter name matching

    // Explicit query với JDQL
    @Query("WHERE d.status = :status AND d.type = :type")
    List<Document> findByStatusAndType(String status, String type);

    // Pagination
    @Find
    Page<Document> findByType(String type, PageRequest pageRequest);

    // Count
    @Find
    long countByStatus(String status);

    // Update
    @Query("UPDATE Document d SET d.status = :newStatus WHERE d.id = :id")
    int updateStatus(String id, String newStatus);

    // Delete by criteria
    @Delete
    void deleteByStatus(String status);

    // Sorting
    @Find
    List<Document> findAll(Order<Document> order);
}
```

---

## 3. Pagination & Sorting

```java
// === SPRING DATA ===
Pageable pageable = PageRequest.of(0, 20, Sort.by("createdAt").descending());
Page<Document> page = repo.findByType("CONTRACT", pageable);
List<Document> content = page.getContent();
long total = page.getTotalElements();

// === JAKARTA DATA 1.1 ===
PageRequest pageRequest = PageRequest.ofPage(1)  // 1-based
    .size(20)
    .sortBy(Sort.desc("createdAt"));

Page<Document> page = repo.findByType("CONTRACT", pageRequest);
List<Document> content = page.content();
long total = page.totalElements();

// Cursor-based pagination (keyset) — built-in trong Jakarta Data
CursoredPage<Document> cursorPage = repo.findByType("CONTRACT",
    PageRequest.ofPage(1).size(20).afterCursor(cursor));
```

Cursor-based pagination là **built-in** trong Jakarta Data spec — Spring Data phải implement custom.

---

## 4. Custom Ordering

```java
// === SPRING DATA ===
repo.findByStatus("ACTIVE", Sort.by(
    Sort.Order.desc("priority"),
    Sort.Order.asc("createdAt")
));

// === JAKARTA DATA 1.1 ===
Order<Document> order = Order.by(
    Sort.desc("priority"),
    Sort.asc("createdAt")
);
repo.findAll(order);
```

---

## 5. Lifecycle Events & Validation

```java
// Entity với Jakarta Data lifecycle annotations
@Entity
@Table(name = "documents")
public class Document {

    @Id
    private String id;

    @Column(nullable = false)
    @NotBlank  // Jakarta Validation
    private String title;

    @Column(nullable = false)
    @NotBlank
    private String type;

    private String status;

    @Column(name = "created_at")
    private Instant createdAt;

    @Column(name = "updated_at")
    private Instant updatedAt;

    // Jakarta Data / JPA lifecycle
    @PrePersist
    void onPrePersist() {
        this.id = UUID.randomUUID().toString();
        this.createdAt = Instant.now();
        this.updatedAt = Instant.now();
    }

    @PreUpdate
    void onPreUpdate() {
        this.updatedAt = Instant.now();
    }
}
```

---

## 6. Stateless Repository vs Stateful

Jakarta Data có concept **stateless** repository (default) — khác với Spring Data:

```java
// Stateless (default — khuyến khích)
@Repository
public interface DocumentRepository { ... }

// Nếu cần transaction phức tạp hơn, inject EntityManager trực tiếp:
@ApplicationScoped
public class DocumentRepositoryCustom {

    @PersistenceContext
    EntityManager em;

    public List<Document> complexQuery(String tenantId, List<String> statuses) {
        return em.createQuery(
            "SELECT d FROM Document d WHERE d.tenantId = :tid AND d.status IN :statuses",
            Document.class)
            .setParameter("tid", tenantId)
            .setParameter("statuses", statuses)
            .getResultList();
    }
}
```

---

## 7. Prototype — PDMS-Style Document Repository

```bash
mvn io.quarkus.platform:quarkus-maven-plugin:3.x.x:create \
    -DprojectArtifactId=jakarta-data-lab \
    -Dextensions="rest,rest-jackson,hibernate-orm,hibernate-orm-panache,jdbc-h2,data"
```

```java
// === Entity ===
@Entity
@Table(name = "documents")
public class Document {

    @Id
    public String id;

    @Column(nullable = false)
    public String title;

    @Column(nullable = false)
    public String type;  // CONTRACT, REPORT, INVOICE

    public String status = "PENDING"; // PENDING, ACTIVE, ARCHIVED

    @Column(name = "tenant_id")
    public String tenantId;

    @Column(name = "created_at")
    public Instant createdAt;

    @Column(name = "updated_at")
    public Instant updatedAt;

    @PrePersist
    void prePersist() {
        this.id = UUID.randomUUID().toString();
        this.createdAt = Instant.now();
        this.updatedAt = Instant.now();
    }

    @PreUpdate
    void preUpdate() {
        this.updatedAt = Instant.now();
    }
}

// === Jakarta Data Repository ===
@Repository
public interface DocumentRepository {

    @Find
    Optional<Document> findById(String id);

    @Save
    Document save(Document doc);

    @Delete
    void deleteById(String id);

    @Find
    List<Document> findByStatus(String status);

    @Find
    List<Document> findByTenantId(String tenantId);

    @Find
    Page<Document> findByTenantId(String tenantId, PageRequest pageRequest);

    @Query("WHERE d.tenantId = :tenantId AND d.status = :status")
    List<Document> findByTenantAndStatus(String tenantId, String status);

    @Query("WHERE d.title LIKE :keyword")
    List<Document> searchByTitle(String keyword);  // pass "%keyword%"

    @Query("UPDATE Document d SET d.status = :status WHERE d.id = :id")
    int updateStatus(String id, String status);

    @Find
    long countByTenantId(String tenantId);
}

// === Service ===
@ApplicationScoped
public class DocumentService {

    @Inject
    DocumentRepository repo;

    @Transactional
    public Document create(String title, String type, String tenantId) {
        Document doc = new Document();
        doc.title = title;
        doc.type = type;
        doc.tenantId = tenantId;
        return repo.save(doc);
    }

    public Page<Document> listByTenant(String tenantId, int page, int size) {
        PageRequest pr = PageRequest.ofPage(page + 1) // Jakarta Data: 1-based
            .size(size)
            .sortBy(Sort.desc("createdAt"));
        return repo.findByTenantId(tenantId, pr);
    }

    @Transactional
    public boolean activate(String id) {
        return repo.updateStatus(id, "ACTIVE") > 0;
    }

    public List<Document> search(String tenantId, String keyword) {
        return repo.searchByTitle("%" + keyword + "%")
            .stream()
            .filter(d -> d.tenantId.equals(tenantId))
            .toList();
    }
}

// === REST Resource ===
@Path("/api/v1/documents")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class DocumentResource {

    @Inject DocumentService service;

    public record CreateRequest(
        @NotBlank String title,
        @NotBlank String type
    ) {}

    @POST
    public Response create(
            @HeaderParam("X-Tenant-Id") @NotBlank String tenantId,
            @Valid CreateRequest req) {
        Document doc = service.create(req.title(), req.type(), tenantId);
        return Response.status(201).entity(doc).build();
    }

    @GET
    public Response list(
            @HeaderParam("X-Tenant-Id") String tenantId,
            @QueryParam("page") @DefaultValue("0") int page,
            @QueryParam("size") @DefaultValue("20") int size) {
        Page<Document> result = service.listByTenant(tenantId, page, size);
        return Response.ok(Map.of(
            "content", result.content(),
            "totalElements", result.totalElements(),
            "page", page,
            "size", size
        )).build();
    }

    @PUT
    @Path("/{id}/activate")
    public Response activate(@PathParam("id") String id) {
        boolean updated = service.activate(id);
        return updated
            ? Response.ok(Map.of("status", "ACTIVE")).build()
            : Response.status(404).build();
    }
}
```

```yaml
# src/main/resources/application.properties
quarkus.datasource.db-kind=h2
quarkus.datasource.jdbc.url=jdbc:h2:mem:docstore
quarkus.hibernate-orm.database.generation=drop-and-create

# Seed data
quarkus.hibernate-orm.sql-load-script=import.sql
```

```sql
-- src/main/resources/import.sql
INSERT INTO documents (id, title, type, status, tenant_id, created_at, updated_at)
VALUES ('doc-001', 'Contract ABC', 'CONTRACT', 'PENDING', 'tenant-vpbank', NOW(), NOW());
INSERT INTO documents (id, title, type, status, tenant_id, created_at, updated_at)
VALUES ('doc-002', 'Report Q1', 'REPORT', 'ACTIVE', 'tenant-vpbank', NOW(), NOW());
```

```bash
# Test
./mvnw quarkus:dev

# Create document
curl -X POST http://localhost:8080/api/v1/documents \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: tenant-vpbank" \
  -d '{"title":"New Contract","type":"CONTRACT"}'

# List with pagination
curl "http://localhost:8080/api/v1/documents?page=0&size=10" \
  -H "X-Tenant-Id: tenant-vpbank"

# Activate
curl -X PUT http://localhost:8080/api/v1/documents/doc-001/activate
```

---

## 8. Jakarta Data vs Spring Data — So Sánh Chi Tiết

| Tính năng | Spring Data | Jakarta Data 1.1 |
|---|---|---|
| Method name derivation | ✅ `findByTitleContaining` | ❌ Dùng `@Query` |
| `@Query` annotation | ✅ JPQL/SQL | ✅ JDQL |
| Pagination | `Pageable` (0-based) | `PageRequest` (1-based) |
| Cursor pagination | ❌ Custom | ✅ Built-in `CursoredPage` |
| Extend interface | `extends JpaRepository` | Optional — `@Repository` đủ |
| `@Save` (upsert) | ❌ `save()` is upsert impl | ✅ Spec-defined |
| Sorting | `Sort` object | `Order<T>` object |
| `@Find` | ❌ | ✅ Annotation-driven find |
| Vendor neutral | ❌ Spring-specific | ✅ Spec standard |

---

## 9. Architect Notes

**Khi nào Jakarta Data tốt hơn Spring Data:**
- Hệ thống cần chạy trên nhiều runtime (Quarkus, WildFly, Open Liberty)
- Cần cursor-based pagination built-in (PDMS với 10M+ records!)
- Team design theo spec, không theo vendor

**Khi nào Spring Data tốt hơn:**
- Method name derivation giảm boilerplate đáng kể
- Spring Data MongoDB/Redis/Elasticsearch ecosystem rộng hơn
- `@Modifying` + `@Transactional` pattern quen thuộc

**PDMS Application:** Jakarta Data cursor pagination rất phù hợp với pattern keyset pagination đang dùng trong stored procedures — có thể serve làm native Java layer thay thế OFFSET-based.

---

*[[06-Transactions]] | [[00-Overview]] | Next: [[08-Jakarta-Query]]*
