# 09 — Jakarta NoSQL 1.1 ⭐ New in EE 12

> **Spec:** Jakarta NoSQL 1.1 | **Profile:** Full Platform (EE 12 addition)
> **Spring equivalent:** Spring Data MongoDB / Spring Data Redis
> **Prototype runtime:** Quarkus + MongoDB

---

## 1. Spec Says

Jakarta NoSQL 1.1 định nghĩa standard API để Java applications tương tác với NoSQL databases. Được thiết kế theo 4 NoSQL category: **Document, Key-Value, Column, Graph**.

Trước EE 12: mỗi NoSQL DB có driver riêng (MongoDB driver, Redis Jedis...) — không có chuẩn chung. Jakarta NoSQL chuẩn hóa annotation và repository pattern, tương tự JPA cho relational databases.

---

## 2. NoSQL Entity Mapping

```java
// === SPRING DATA MONGODB ===
@Document(collection = "documents")
public class Document {
    @Id
    private String id;

    @Field("tenant_id")
    private String tenantId;

    private String title;
    private String status;

    @DBRef
    private List<Tag> tags;
}

// === JAKARTA NOSQL ===
@Entity(name = "documents")          // collection/table name
public class Document {

    @Id                               // Jakarta NoSQL @Id
    private String id;

    @Column("tenant_id")              // field mapping
    private String tenantId;

    @Column                           // same name as field
    private String title;

    @Column
    private String status;

    // Embedded
    @Column
    private List<String> tags;
}
```

| Spring Data MongoDB | Jakarta NoSQL |
|---|---|
| `@Document(collection="name")` | `@Entity(name="name")` |
| `@Id` | `@Id` |
| `@Field("name")` | `@Column("name")` |
| `@DBRef` | Embedded / `@Column` |
| `@Indexed` | Vendor-specific |
| `@TextIndexed` | Vendor-specific |

---

## 3. Repository API

```java
// === SPRING DATA MONGODB ===
@Repository
public interface DocumentRepository extends MongoRepository<Document, String> {
    List<Document> findByTenantId(String tenantId);
    List<Document> findByTenantIdAndStatus(String tenantId, String status);
    long countByTenantId(String tenantId);

    @Query("{'tenantId': ?0, 'title': {$regex: ?1, $options: 'i'}}")
    List<Document> searchByTitle(String tenantId, String keyword);
}

// === JAKARTA NOSQL (1.1) ===
@Repository
public interface DocumentNoSQLRepository {

    @Insert
    Document save(Document doc);

    @Update
    Document update(Document doc);

    @Delete
    void delete(Document doc);

    @Find
    Optional<Document> findById(String id);

    @Find
    List<Document> findByTenantId(String tenantId);

    @Find
    List<Document> findByTenantIdAndStatus(String tenantId, String status);

    // Jakarta Query via @Query (cross-store)
    @Query("WHERE tenantId = :tid AND LOWER(title) LIKE LOWER(CONCAT('%',:kw,'%'))")
    List<Document> searchByTitle(String tid, String kw);

    @Find
    long countByTenantId(String tenantId);

    // Pagination
    @Find
    Page<Document> findByTenantId(String tenantId, PageRequest pageRequest);
}
```

---

## 4. DocumentTemplate — Low-Level API

```java
// Tương đương MongoTemplate trong Spring Data
@ApplicationScoped
public class DocumentQueryService {

    @Inject
    DocumentTemplate template;   // Jakarta NoSQL low-level

    // Custom query với MongoDB-specific
    public List<Document> complexQuery(String tenantId, DocumentFilter filter) {
        // Jakarta NoSQL SelectQuery
        var query = select().from("documents")
            .where("tenantId").eq(tenantId)
            .and("status").in(filter.statuses())
            .orderBy("createdAt").desc()
            .skip(filter.page() * filter.size())
            .limit(filter.size())
            .build();

        return template.select(query, Document.class).toList();
    }

    // Insert
    public Document insert(Document doc) {
        return template.insert(doc);
    }

    // Update specific field
    public void updateStatus(String id, String newStatus) {
        template.update(
            update("documents")
                .set("status", newStatus)
                .set("updatedAt", Instant.now())
                .where("id").eq(id)
                .build()
        );
    }

    // Delete
    public void delete(String tenantId, String status) {
        template.delete(
            delete().from("documents")
                .where("tenantId").eq(tenantId)
                .and("status").eq(status)
                .build()
        );
    }
}
```

---

## 5. Key-Value Store

```java
// Redis / Hazelcast / DynamoDB via Jakarta NoSQL Key-Value
@Entity
public class SessionCache {
    @Id String sessionId;
    @Column String userId;
    @Column Instant expiresAt;
    @Column Map<String, Object> attributes;
}

@Repository
public interface SessionRepository {

    @Put
    SessionCache put(SessionCache session);

    @Get
    Optional<SessionCache> get(String sessionId);

    @Delete
    void delete(String sessionId);
}

@ApplicationScoped
public class SessionService {

    @Inject SessionRepository repo;

    public void createSession(String userId, Map<String, Object> data) {
        var session = new SessionCache();
        session.sessionId = UUID.randomUUID().toString();
        session.userId = userId;
        session.expiresAt = Instant.now().plus(30, ChronoUnit.MINUTES);
        session.attributes = data;
        repo.put(session);
    }

    public Optional<String> getUserId(String sessionId) {
        return repo.get(sessionId)
            .filter(s -> s.expiresAt.isAfter(Instant.now()))
            .map(s -> s.userId);
    }
}
```

---

## 6. Prototype — Document Store với MongoDB

```bash
mvn io.quarkus.platform:quarkus-maven-plugin:3.x.x:create \
    -DprojectArtifactId=jakarta-nosql-lab \
    -Dextensions="rest,rest-jackson,mongodb-client,mongodb-panache"

# Dev mode tự start MongoDB container
./mvnw quarkus:dev
```

```java
// application.properties
// quarkus.mongodb.connection-string=mongodb://localhost:27017
// quarkus.mongodb.database=pdms_nosql
// %dev.quarkus.devservices.enabled=true (auto start MongoDB)

// === Entity ===
@Entity(name = "audit_logs")
public class AuditLog {

    @Id
    private String id;

    @Column("tenant_id")
    private String tenantId;

    @Column("document_id")
    private String documentId;

    @Column
    private String action;    // CREATED, UPDATED, SUBMITTED, APPROVED

    @Column("performed_by")
    private String performedBy;

    @Column("occurred_at")
    private Instant occurredAt;

    @Column
    private Map<String, Object> metadata;

    // Constructors, getters, builder
    public static AuditLog of(String tenantId, String documentId,
                               String action, String userId) {
        var log = new AuditLog();
        log.id = UUID.randomUUID().toString();
        log.tenantId = tenantId;
        log.documentId = documentId;
        log.action = action;
        log.performedBy = userId;
        log.occurredAt = Instant.now();
        log.metadata = new HashMap<>();
        return log;
    }
}

// === Repository ===
@Repository
public interface AuditLogRepository {

    @Insert
    AuditLog save(AuditLog log);

    @Find
    List<AuditLog> findByDocumentId(String documentId);

    @Find
    List<AuditLog> findByTenantId(String tenantId);

    @Query("WHERE documentId = :docId ORDER BY occurredAt DESC")
    Page<AuditLog> findByDocumentId(String docId, PageRequest pageRequest);

    @Query("WHERE tenantId = :tid AND action = :action AND occurredAt > :since")
    List<AuditLog> findActionsSince(String tid, String action, Instant since);

    @Find
    long countByTenantIdAndAction(String tenantId, String action);
}

// === Service ===
@ApplicationScoped
public class AuditService {

    @Inject AuditLogRepository repo;

    public AuditLog log(String tenantId, String documentId,
                        String action, String userId,
                        Map<String, Object> extra) {
        AuditLog entry = AuditLog.of(tenantId, documentId, action, userId);
        entry.setMetadata(extra != null ? extra : Map.of());
        return repo.save(entry);
    }

    public List<AuditLog> getHistory(String documentId) {
        return repo.findByDocumentId(documentId);
    }

    public Page<AuditLog> getHistoryPaged(String documentId, int page, int size) {
        return repo.findByDocumentId(documentId,
            PageRequest.ofPage(page + 1).size(size)
                .sortBy(Sort.desc("occurredAt")));
    }

    public Map<String, Long> getActionCounts(String tenantId) {
        var actions = List.of("CREATED", "SUBMITTED", "APPROVED", "REJECTED");
        return actions.stream().collect(Collectors.toMap(
            a -> a,
            a -> repo.countByTenantIdAndAction(tenantId, a)
        ));
    }
}

// === REST Resource ===
@Path("/api/audit")
@Produces(MediaType.APPLICATION_JSON)
public class AuditResource {

    @Inject AuditService svc;

    @GET
    @Path("/document/{docId}")
    public Response getHistory(@PathParam("docId") String docId,
            @QueryParam("page") @DefaultValue("0") int page,
            @QueryParam("size") @DefaultValue("20") int size) {
        var result = svc.getHistoryPaged(docId, page, size);
        return Response.ok(Map.of(
            "content", result.content(),
            "total", result.totalElements()
        )).build();
    }

    @GET
    @Path("/stats")
    public Response stats(@HeaderParam("X-Tenant-Id") String tid) {
        return Response.ok(svc.getActionCounts(tid)).build();
    }

    // Seed test data
    @POST
    @Path("/seed")
    public Response seed(@HeaderParam("X-Tenant-Id") String tid) {
        var actions = List.of("CREATED", "SUBMITTED", "APPROVED");
        for (int i = 0; i < 10; i++) {
            String docId = "DOC-" + String.format("%03d", i);
            for (String action : actions) {
                svc.log(tid, docId, action, "user-alice", null);
            }
        }
        return Response.ok(Map.of("seeded", 30)).build();
    }
}
```

```bash
# Seed data
curl -X POST http://localhost:8080/api/audit/seed \
  -H "X-Tenant-Id: vpbank"

# Get history
curl http://localhost:8080/api/audit/document/DOC-001

# Stats
curl http://localhost:8080/api/audit/stats \
  -H "X-Tenant-Id: vpbank"
# → {"CREATED":10,"SUBMITTED":10,"APPROVED":10,"REJECTED":0}
```

---

## 7. Architect Notes

**Jakarta NoSQL use case phù hợp với PDMS:**
- **Audit log** — append-only, cần query theo documentId/tenantId → MongoDB
- **Session/cache** — key-value → Redis
- **Full-text search metadata** → Elasticsearch (nếu có ext)

**Không phù hợp:**
- Transactional document management core → vẫn cần PostgreSQL/JPA
- Relational data với complex JOIN → NoSQL không support well

**Adoption:** Jakarta NoSQL 1.1 vẫn đang trong giai đoạn EE 12 ratification. Thực tế vẫn dùng Spring Data MongoDB trực tiếp hoặc Quarkus MongoDB Panache — spec này quan trọng hơn về long-term portability.

---

*[[08-Jakarta-Query]] | [[00-Overview]] | Next: [[10-Jakarta-Security]]*
