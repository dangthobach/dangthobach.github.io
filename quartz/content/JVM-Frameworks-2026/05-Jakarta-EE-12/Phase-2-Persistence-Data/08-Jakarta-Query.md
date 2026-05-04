# 08 — Jakarta Query 1.0 ⭐ Brand New in EE 12

> **Spec:** Jakarta Query 1.0 | **Profile:** Web Profile (via Jakarta Data)
> **Spring equivalent:** JPQL / Spring Data `@Query` — nhưng unified hơn
> **Tại sao quan trọng:** Đây là spec mới nhất EE 12, unify query language cho Persistence + Data + NoSQL

---

## 1. Spec Says

Jakarta Query 1.0 định nghĩa **Jakarta Query Language (JQL)** — object-oriented query language được thiết kế để hoạt động trên:
- Jakarta Persistence (JPA) — thay cho JPQL
- Jakarta Data — thay cho JDQL
- Jakarta NoSQL — query trên document stores

Mục tiêu: **một query language duy nhất** cho mọi persistence technology trong Jakarta EE.

```
JPQL (JPA 1.0, 2003)  ─────────────────────────────┐
JDQL (Jakarta Data 1.0, 2024) ──────────────────────┼── Jakarta Query (JQL) 1.0 (2026)
NOSQL queries (vendor-specific) ────────────────────┘
```

---

## 2. JQL vs JPQL — Sự Khác Biệt

JQL là **superset** của JPQL với cú pháp rõ ràng hơn và tính năng mới:

```sql
-- JPQL (cũ)
SELECT d FROM Document d
WHERE d.status = :status
  AND d.tenantId = :tid
ORDER BY d.createdAt DESC

-- JQL (mới) — cú pháp giống nhau, thêm tính năng mới
SELECT d FROM Document d
WHERE d.status = :status
  AND d.tenantId = :tid
ORDER BY d.createdAt DESC

-- JQL: WHERE clause ngắn gọn (implicit FROM)
-- Trong @Query annotation của Jakarta Data:
WHERE status = :status AND tenantId = :tid
-- (Entity được suy ra từ return type của repository method)
```

---

## 3. Sử Dụng Trong Jakarta Data Repository

```java
@Repository
public interface DocumentRepository {

    // Implicit entity — JQL chỉ cần WHERE clause
    @Query("WHERE tenantId = :tid AND status = :status ORDER BY createdAt DESC")
    List<Document> findByTenantAndStatus(String tid, String status);

    // Full JQL với explicit SELECT
    @Query("SELECT d FROM Document d WHERE d.tenantId = :tid " +
           "AND LOWER(d.title) LIKE LOWER(CONCAT('%', :keyword, '%'))")
    List<Document> searchByTitle(String tid, String keyword);

    // JQL aggregation
    @Query("SELECT d.type, COUNT(d), SUM(d.amount) FROM Document d " +
           "WHERE d.tenantId = :tid GROUP BY d.type")
    List<Object[]> aggregateByType(String tid);

    // JQL với subquery
    @Query("SELECT d FROM Document d WHERE d.id IN " +
           "(SELECT r.documentId FROM Review r WHERE r.approverId = :uid)")
    List<Document> findReviewedBy(String uid);

    // JQL UPDATE
    @Query("UPDATE Document SET status = :newStatus, updatedAt = :now " +
           "WHERE tenantId = :tid AND status = :oldStatus")
    int bulkUpdateStatus(String tid, String oldStatus, String newStatus, Instant now);

    // JQL DELETE
    @Query("DELETE FROM Document WHERE tenantId = :tid AND status = 'ARCHIVED' " +
           "AND updatedAt < :cutoff")
    int deleteOldArchived(String tid, Instant cutoff);
}
```

---

## 4. JQL Functions Mới

```sql
-- EXTRACT (chuẩn SQL, trước đây vendor-specific)
SELECT EXTRACT(YEAR FROM d.createdAt),
       EXTRACT(MONTH FROM d.createdAt),
       COUNT(d)
FROM Document d
GROUP BY EXTRACT(YEAR FROM d.createdAt), EXTRACT(MONTH FROM d.createdAt)

-- CAST
SELECT CAST(d.amount AS String) FROM Document d

-- LOCAL DATE/TIME (không cần :now parameter)
WHERE d.expiryDate < LOCAL DATE
WHERE d.createdAt > LOCAL DATETIME

-- COALESCE / NULLIF
SELECT COALESCE(d.description, 'N/A') FROM Document d

-- CASE WHEN
SELECT
  CASE d.status
    WHEN 'APPROVED' THEN 'green'
    WHEN 'REJECTED' THEN 'red'
    ELSE 'yellow'
  END
FROM Document d
```

---

## 5. JQL với EntityManager (JPA Direct)

```java
@ApplicationScoped
public class AdvancedDocumentQuery {

    @PersistenceContext EntityManager em;

    // Monthly statistics
    public List<MonthlyStats> getMonthlyStats(String tenantId, int year) {
        return em.createQuery("""
            SELECT EXTRACT(MONTH FROM d.createdAt) AS month,
                   d.type AS docType,
                   COUNT(d) AS total,
                   SUM(d.amount) AS totalAmount
            FROM Document d
            WHERE d.tenantId = :tid
              AND EXTRACT(YEAR FROM d.createdAt) = :year
            GROUP BY EXTRACT(MONTH FROM d.createdAt), d.type
            ORDER BY month
            """, Object[].class)
            .setParameter("tid", tenantId)
            .setParameter("year", year)
            .getResultStream()
            .map(row -> new MonthlyStats(
                ((Number) row[0]).intValue(),
                (String) row[1],
                ((Number) row[2]).longValue(),
                (BigDecimal) row[3]
            ))
            .toList();
    }

    // Expiry check dùng LOCAL DATE
    public List<Document> findExpiringSoon(String tenantId, int daysAhead) {
        return em.createQuery("""
            SELECT d FROM Document d
            WHERE d.tenantId = :tid
              AND d.expiryDate BETWEEN LOCAL DATE AND (LOCAL DATE + :days DAY)
            ORDER BY d.expiryDate
            """, Document.class)
            .setParameter("tid", tenantId)
            .setParameter("days", daysAhead)
            .getResultList();
    }

    // Status distribution
    public Map<String, Long> statusDistribution(String tenantId) {
        List<Object[]> rows = em.createQuery("""
            SELECT d.status, COUNT(d)
            FROM Document d
            WHERE d.tenantId = :tid
            GROUP BY d.status
            """, Object[].class)
            .setParameter("tid", tenantId)
            .getResultList();

        return rows.stream().collect(Collectors.toMap(
            r -> (String) r[0],
            r -> (Long) r[1]
        ));
    }
}

public record MonthlyStats(int month, String docType, long total, BigDecimal totalAmount) {}
```

---

## 6. JQL trong Jakarta NoSQL (Cross-Store)

```java
// Cùng query syntax trên MongoDB (thông qua Jakarta NoSQL + Jakarta Query)
@Repository
public interface DocumentNoSQLRepository {

    // Chạy trên MongoDB collection "documents"
    @Query("WHERE tenantId = :tid AND status = :status")
    List<DocumentDocument> findByTenantAndStatus(String tid, String status);

    // Text search (NoSQL specific — JQL extension)
    @Query("WHERE tenantId = :tid AND title LIKE :keyword")
    List<DocumentDocument> textSearch(String tid, String keyword);
}
```

Đây là điểm mạnh nhất của Jakarta Query: **cùng query syntax** cho relational và NoSQL.

---

## 7. Prototype — Analytics Dashboard Query

```java
@Path("/api/analytics")
@Produces(MediaType.APPLICATION_JSON)
public class AnalyticsResource {

    @Inject AdvancedDocumentQuery queryService;
    @Inject DocumentRepository repo;

    @GET
    @Path("/monthly/{year}")
    public Response monthlyStats(
            @HeaderParam("X-Tenant-Id") String tenantId,
            @PathParam("year") int year) {
        var stats = queryService.getMonthlyStats(tenantId, year);
        return Response.ok(stats).build();
    }

    @GET
    @Path("/expiring")
    public Response expiringSoon(
            @HeaderParam("X-Tenant-Id") String tenantId,
            @QueryParam("days") @DefaultValue("30") int days) {
        var docs = queryService.findExpiringSoon(tenantId, days);
        return Response.ok(Map.of(
            "count", docs.size(),
            "documents", docs
        )).build();
    }

    @GET
    @Path("/distribution")
    public Response statusDistribution(
            @HeaderParam("X-Tenant-Id") String tenantId) {
        return Response.ok(queryService.statusDistribution(tenantId)).build();
    }

    @POST
    @Path("/bulk-archive")
    @Transactional
    public Response bulkArchive(
            @HeaderParam("X-Tenant-Id") String tenantId,
            @QueryParam("cutoffDays") @DefaultValue("365") int days) {
        Instant cutoff = Instant.now().minus(days, ChronoUnit.DAYS);
        int count = repo.deleteOldArchived(tenantId, cutoff);
        return Response.ok(Map.of("archived", count)).build();
    }
}
```

```bash
./mvnw quarkus:dev

# Monthly stats
curl http://localhost:8080/api/analytics/monthly/2026 \
  -H "X-Tenant-Id: vpbank"

# Documents expiring in next 30 days
curl "http://localhost:8080/api/analytics/expiring?days=30" \
  -H "X-Tenant-Id: vpbank"

# Status distribution
curl http://localhost:8080/api/analytics/distribution \
  -H "X-Tenant-Id: vpbank"
```

---

## 8. Architect Notes

**JQL vs JPQL — khi nào quan trọng:**
- Hiện tại Quarkus/Hibernate vẫn chủ yếu dùng JPQL — JQL là evolution
- `LOCAL DATE` / `EXTRACT` — dùng ngay được với Hibernate 6.x
- Implicit WHERE clause (trong Jakarta Data `@Query`) — clean code hơn đáng kể
- Cross-store uniformity — quan trọng nếu PDMS sau này cần NoSQL layer

**Với PDMS stored procedure hiện tại:** JQL analytics queries có thể replace một số proc đơn giản — nhưng complex ETL với keyset pagination vẫn nên giữ PostgreSQL native.

---

*[[07-Jakarta-Data]] | [[00-Overview]] | Next: [[09-Jakarta-NoSQL]]*
