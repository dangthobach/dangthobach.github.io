---
tags: [vertx, reactive-sql, postgresql, database]
created: 2026-04-12
status: active
week: 19
phase: P3-Data
framework: vertx
---

# Reactive SQL Client

## 📌 One-liner
> Vert.x Reactive SQL Client là JDBC-killer — non-blocking DB queries hoàn toàn, không block event loop thread. Không có ORM, viết SQL thuần, kết quả trả về `Future<RowSet<Row>>`.

---

## 🆚 JDBC/JPA vs Vert.x Reactive SQL

| | JDBC / Spring Data JPA | Vert.x Reactive SQL |
|--|------------------------|---------------------|
| Blocking | ❌ Block thread | ✅ Non-blocking |
| ORM | Hibernate entity mapping | Thủ công: `row.getString("name")` |
| Connection pool | HikariCP (thread-based) | Reactive pool (event-loop-friendly) |
| Transaction | `@Transactional` | Programmatic |
| Query result | `List<Entity>` | `Future<RowSet<Row>>` |
| Learning curve | Thấp (ORM lo) | Cao (SQL thuần) |
| Performance | Tốt | Tốt hơn ở high concurrency |

---

## 🔧 Setup

```java
// Tạo pool (1 lần khi startup)
PgConnectOptions connectOptions = new PgConnectOptions()
    .setPort(5432)
    .setHost("localhost")
    .setDatabase("pdms_db")
    .setUser("pdms_user")
    .setPassword("secret");

PoolOptions poolOptions = new PoolOptions().setMaxSize(20);

Pool client = PgBuilder.pool()
    .with(poolOptions)
    .connectingTo(connectOptions)
    .using(vertx)
    .build();
```

---

## 💻 Basic Queries

```java
@ApplicationScoped
public class DocumentRepository {

    @Inject
    Pool client;  // Inject Vert.x PgPool

    // === SELECT ===
    public Future<List<Document>> findAll() {
        return client.query("SELECT id, title, status, created_at FROM documents")
            .execute()
            .map(rows -> {
                List<Document> docs = new ArrayList<>();
                for (Row row : rows) {
                    docs.add(mapRow(row));
                }
                return docs;
            });
    }

    // === SELECT với parameters (dùng $1, $2... cho PostgreSQL) ===
    public Future<Optional<Document>> findById(Long id) {
        return client.preparedQuery("SELECT * FROM documents WHERE id = $1")
            .execute(Tuple.of(id))
            .map(rows -> {
                if (rows.rowCount() == 0) return Optional.empty();
                return Optional.of(mapRow(rows.iterator().next()));
            });
    }

    // === INSERT ===
    public Future<Document> create(CreateDocRequest req) {
        return client.preparedQuery("""
            INSERT INTO documents (title, status, tenant_id, created_at)
            VALUES ($1, $2, $3, NOW())
            RETURNING id, title, status, created_at
            """)
            .execute(Tuple.of(req.title(), "DRAFT", req.tenantId()))
            .map(rows -> mapRow(rows.iterator().next()));
    }

    // === UPDATE ===
    public Future<Boolean> updateStatus(Long id, String status) {
        return client.preparedQuery(
            "UPDATE documents SET status = $1, updated_at = NOW() WHERE id = $2")
            .execute(Tuple.of(status, id))
            .map(rows -> rows.rowCount() > 0);
    }

    // === Row mapping (manual — không có ORM magic) ===
    private Document mapRow(Row row) {
        Document doc = new Document();
        doc.setId(row.getLong("id"));
        doc.setTitle(row.getString("title"));
        doc.setStatus(row.getString("status"));
        doc.setCreatedAt(row.getLocalDateTime("created_at"));
        return doc;
    }
}
```

---

## 🔧 Transactions

```java
public Future<Void> transferDocument(Long docId, Long fromUser, Long toUser) {
    return client.withTransaction(conn -> {
        // Tất cả queries trong lambda dùng cùng connection/transaction

        Future<Document> fetchDoc = conn.preparedQuery(
            "SELECT * FROM documents WHERE id = $1 FOR UPDATE")
            .execute(Tuple.of(docId))
            .map(rows -> mapRow(rows.iterator().next()));

        return fetchDoc.compose(doc -> {
            if (!doc.getOwnerId().equals(fromUser)) {
                return Future.failedFuture(new UnauthorizedException());
            }

            return conn.preparedQuery(
                "UPDATE documents SET owner_id = $1 WHERE id = $2")
                .execute(Tuple.of(toUser, docId))
                .compose(v -> conn.preparedQuery(
                    "INSERT INTO audit_log (doc_id, action, from_user, to_user) VALUES ($1,$2,$3,$4)")
                    .execute(Tuple.of(docId, "TRANSFER", fromUser, toUser)))
                .mapEmpty();
        });
        // Auto commit nếu không có exception, auto rollback nếu có
    });
}
```

---

## 🔧 Batch Operations

```java
public Future<Void> createBatch(List<CreateDocRequest> requests) {
    // Prepare batch tuples
    List<Tuple> batch = requests.stream()
        .map(req -> Tuple.of(req.title(), "DRAFT", req.tenantId()))
        .collect(Collectors.toList());

    return client.preparedQuery("""
        INSERT INTO documents (title, status, tenant_id, created_at)
        VALUES ($1, $2, $3, NOW())
        """)
        .executeBatch(batch)
        .mapEmpty();
}
```

---

## 🔧 Vert.x với Quarkus (Best of Both Worlds)

```java
// Trong Quarkus project, inject Vert.x instance
@ApplicationScoped
public class ReactiveDocumentRepo {

    @Inject
    io.vertx.mutiny.pgclient.PgPool client;  // Mutiny variant!

    public Uni<List<Document>> findAll() {
        return client.query("SELECT * FROM documents")
            .execute()
            .map(rows -> StreamSupport.stream(rows.spliterator(), false)
                .map(this::mapRow)
                .collect(Collectors.toList()));
    }
}
```

> [!tip] Quarkus + Vert.x = Best combo
> Quarkus dùng Vert.x làm engine nền. Inject `io.vertx.mutiny.pgclient.PgPool` để có Reactive SQL Client với Mutiny API (Uni/Multi). Không cần JDBC blocking nữa!

---

## ✅ Practice Checklist
- [ ] Setup PgPool, chạy SELECT query non-blocking
- [ ] Implement CRUD với prepared statements
- [ ] Thực hiện transaction với `withTransaction()`
- [ ] Batch insert 1000 records, so sánh với JDBC batch
- [ ] Inject Vert.x PgPool vào Quarkus project

## 🔗 Liên quan
- [[01 Event Loop và Verticles]]
- [[02 Vertx với Quarkus]]
- [[../../01-Quarkus/P2-Data/01 Panache Active Record]]

## 📖 Nguồn
- https://vertx.io/docs/vertx-pg-client/java/
