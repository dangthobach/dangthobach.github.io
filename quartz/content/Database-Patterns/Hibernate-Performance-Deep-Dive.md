# Hibernate Performance Deep Dive — Từ Cơ Bản Đến Nâng Cao

> **Audience:** Senior engineer, quen RDBMS, muốn hiểu *tại sao* Hibernate hoạt động thế — không chỉ *cách dùng*.
> **Stack:** Spring Boot + Spring Data JPA + PostgreSQL (phần lớn áp dụng cho MySQL/Oracle tương tự)

---

## 📐 Mental Model — Hibernate Là Gì Thực Sự?

Trước khi tối ưu, cần hiểu Hibernate là một **stateful object graph manager**, không đơn giản là "query builder".

```
┌─────────────────────────────────────────────────────────┐
│                  Application Code                        │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│              JPA EntityManager (Session)                 │
│  ┌─────────────────────────────────────────────────┐    │
│  │          First-Level Cache (Identity Map)        │    │
│  │   Entity A (MANAGED) ──► dirty tracking         │    │
│  │   Entity B (MANAGED) ──► dirty tracking         │    │
│  └─────────────────────────────────────────────────┘    │
└────────────────────────┬────────────────────────────────┘
                         │ flush
┌────────────────────────▼────────────────────────────────┐
│              JDBC Connection / Connection Pool           │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                    PostgreSQL                            │
└─────────────────────────────────────────────────────────┘
```

**3 trạng thái entity cần nắm lòng:**

| State         | Ý nghĩa                                     | Hibernate tracking? |
| ------------- | ------------------------------------------- | ------------------- |
| **Transient** | `new Entity()` chưa gọi `persist()`         | ❌                   |
| **Managed**   | Đang trong Session, mọi thay đổi được track | ✅                   |
| **Detached**  | Session đóng, entity không còn được track   | ❌                   |

> **Key insight:** Mọi vấn đề hiệu năng Hibernate đều bắt nguồn từ việc không hiểu cơ chế này — dirty checking, flush timing, session scope.

---

## 🗄️ Cache Architecture — Tại Sao Nhanh?

### L1 Cache — First-Level Cache (Session / Identity Map)

**Luôn bật, không tắt được.** Đây là HashMap trong Session, map `(EntityType, id) → instance`.

```java
// Chỉ hit DB 1 lần dù gọi 2 lần
User u1 = em.find(User.class, 1L);  // → SELECT
User u2 = em.find(User.class, 1L);  // → L1 cache hit
assert u1 == u2;                    // SAME instance!
```

**Hệ quả quan trọng:**

```java
// Batch delete trong loop — L1 cache phình to!
for (Long id : tenThousandIds) {
    Entity e = em.find(Entity.class, id);  // load vào L1
    em.remove(e);
}
// → L1 cache giữ 10,000 entities trong RAM
// → Phải em.flush() + em.clear() định kỳ
```

**Pattern đúng cho bulk operation:**

```java
int batchSize = 100;
for (int i = 0; i < ids.size(); i++) {
    Entity e = em.find(Entity.class, ids.get(i));
    em.remove(e);
    if (i % batchSize == 0) {
        em.flush();
        em.clear();  // giải phóng L1 cache
    }
}
```

---

### L2 Cache — Second-Level Cache (SessionFactory-wide)

**Shared across tất cả sessions**, phải bật thủ công. Thường dùng **Ehcache**, **Caffeine**, hoặc **Redis** làm provider.

```
Session A ──► L1 miss ──► L2 hit ──► trả về (không hit DB)
Session B ──► L1 miss ──► L2 hit ──► trả về (không hit DB)
Session C ──► L1 miss ──► L2 miss ──► DB ──► populate L2
```

**Cấu hình L2 Cache với Caffeine:**

```yaml
# application.yml
spring:
  jpa:
    properties:
      hibernate:
        cache:
          use_second_level_cache: true
          use_query_cache: true
          region:
            factory_class: org.hibernate.cache.jcache.JCacheRegionFactory
        javax:
          cache:
            provider: com.github.benmanes.caffeine.jcache.spi.CaffeineCachingProvider
```

```java
@Entity
@Cache(usage = CacheConcurrencyStrategy.READ_WRITE)  // hoặc NONSTRICT_READ_WRITE
@Table(name = "products")
public class Product {
    // ...
}
```

**Chiến lược concurrency — chọn đúng:**

| Strategy | Khi nào dùng | Trade-off |
|----------|-------------|-----------|
| `READ_ONLY` | Data không bao giờ update (config, enum-like) | Nhanh nhất, không lock |
| `NONSTRICT_READ_WRITE` | Update ít, chấp nhận stale ngắn | Không lock, đọc có thể stale |
| `READ_WRITE` | Update thường, cần consistency | Soft lock khi update |
| `TRANSACTIONAL` | JTA transaction, consistency cao nhất | Nặng nhất |

---

### Query Cache

Lưu **kết quả query** (list of IDs), phối hợp với L2 cache để resolve entity.

```java
@QueryHints(@QueryHint(name = "org.hibernate.cacheable", value = "true"))
List<Product> findByCategory(String category);
```

> ⚠️ **Gotcha:** Query cache lưu list of IDs. Khi bất kỳ entity nào trong result set thay đổi → **toàn bộ query cache region bị invalidate**. Dùng cho query có dataset ổn định, ít write.

---

## 🔥 Vấn Đề Phổ Biến & Cách Fix

### 1. N+1 Select Problem — Kẻ Thù Số 1

**Ví dụ kinh điển:**

```java
// Entity
@Entity
public class Order {
    @OneToMany(fetch = FetchType.LAZY)
    private List<OrderItem> items;
}

// Code
List<Order> orders = orderRepo.findAll();  // 1 query
for (Order o : orders) {
    o.getItems().size();  // N queries! Mỗi order 1 query
}
// 100 orders → 101 queries
```

**Cách phát hiện:** Bật log SQL + đếm

```yaml
spring:
  jpa:
    show-sql: true
    properties:
      hibernate:
        format_sql: true

logging:
  level:
    org.hibernate.SQL: DEBUG
    org.hibernate.orm.jdbc.bind: TRACE
```

Hoặc dùng **datasource-proxy** / **p6spy** để đếm query tự động trong test.

**Fix 1 — JOIN FETCH (JPQL):**

```java
@Query("SELECT DISTINCT o FROM Order o JOIN FETCH o.items WHERE o.status = :status")
List<Order> findWithItems(@Param("status") String status);
```

> `DISTINCT` cần thiết vì JOIN sẽ duplicate Order rows.

**Fix 2 — @EntityGraph:**

```java
@EntityGraph(attributePaths = {"items", "items.product"})
List<Order> findByStatus(String status);
```

**Fix 3 — @BatchSize (tradeoff tốt cho collection lớn):**

```java
@OneToMany(fetch = FetchType.LAZY)
@BatchSize(size = 25)
private List<OrderItem> items;
// N+1 → ceil(N/25)+1 queries
```

**Fix 4 — Hibernate Subselect:**

```java
@OneToMany(fetch = FetchType.LAZY)
@Fetch(FetchMode.SUBSELECT)
private List<OrderItem> items;
// Luôn 2 queries: 1 cho parent, 1 subselect cho tất cả children
```

---

### 2. Eager Fetch — Luôn Tải Dù Không Cần

```java
// ❌ Anti-pattern
@ManyToOne(fetch = FetchType.EAGER)  // default của @ManyToOne là EAGER
private Category category;
```

```java
// Chỉ cần Order nhưng luôn JOIN Category
List<Order> orders = orderRepo.findAll();
```

**Rule của thumb:** Luôn dùng `LAZY` cho mọi relationship. Load explicit khi cần.

```java
// ✅ Đúng
@ManyToOne(fetch = FetchType.LAZY)
private Category category;
```

---

### 3. Dirty Checking Overhead

Hibernate so sánh snapshot vs current state của **mọi managed entity** khi flush. Với session giữ nhiều entity → tốn CPU.

```java
// ❌ Load entity chỉ để đọc — vẫn bị dirty check!
List<Product> products = productRepo.findAll();
products.forEach(p -> System.out.println(p.getName()));
// Hibernate vẫn giữ snapshot của 10,000 products để dirty check
```

**Fix — Read-only hint:**

```java
@QueryHints(@QueryHint(name = "org.hibernate.readOnly", value = "true"))
List<Product> findAllReadOnly();
```

Hoặc trong Transaction:

```java
@Transactional(readOnly = true)
public List<ProductDto> getProducts() {
    // Hibernate bỏ qua dirty checking cho read-only transaction
}
```

**Spring Data JPA tự động set `readOnly` hint** khi bạn dùng `@Transactional(readOnly = true)`.

---

### 4. Projection Thay Vì Load Entity

Khi chỉ cần một vài field, đừng load cả entity.

```java
// ❌ Load 20 columns chỉ để hiện 2
List<Product> all = productRepo.findAll();
all.stream().map(p -> new ProductDto(p.getId(), p.getName())).toList();

// ✅ Interface projection
public interface ProductSummary {
    Long getId();
    String getName();
    BigDecimal getPrice();
}
List<ProductSummary> findBy();  // Spring Data tự generate query SELECT id, name, price

// ✅ DTO projection với JPQL
@Query("SELECT new com.example.ProductDto(p.id, p.name) FROM Product p")
List<ProductDto> findProductSummaries();
```

---

### 5. Open Session In View (OSIV) — Con Dao Hai Lưỡi

**OSIV** giữ Session mở suốt HTTP request → lazy loading hoạt động trong View/Controller layer.

```
Request ──► Filter (open session) ──► Controller ──► Service ──► Repo ──► DB
                                                    ──► View (lazy load!)
                                  ──► Filter (close session)
```

**Vấn đề:** Session mở lâu → giữ DB connection lâu → pool exhaustion dưới tải cao.

```yaml
# Tắt OSIV trong production (Spring Boot default = true!)
spring:
  jpa:
    open-in-view: false
```

Khi tắt OSIV, phải load data trong `@Transactional` boundary — lazy load ngoài transaction sẽ throw `LazyInitializationException`. Đây là điều **nên làm**, vì nó buộc bạn explicit về data fetching.

---

### 6. Hibernate Statistics — Đo Trước Khi Tối Ưu

```yaml
spring:
  jpa:
    properties:
      hibernate:
        generate_statistics: true
```

```java
@Autowired
SessionFactory sessionFactory;

// Sau một operation
Statistics stats = sessionFactory.getStatistics();
log.info("Queries: {}", stats.getQueryExecutionCount());
log.info("L2 hit ratio: {}", stats.getSecondLevelCacheHitCount() /
    (double)(stats.getSecondLevelCacheHitCount() + stats.getSecondLevelCacheMissCount()));
log.info("Collections loaded: {}", stats.getCollectionLoadCount());
```

---

## ⚡ Batch Insert/Update — JDBC Batching

Mặc định Hibernate gửi từng INSERT/UPDATE riêng lẻ.

```java
// ❌ 1000 INSERTs riêng lẻ
for (int i = 0; i < 1000; i++) {
    em.persist(new Product(...));
}
```

**Bật JDBC batching:**

```yaml
spring:
  jpa:
    properties:
      hibernate:
        jdbc:
          batch_size: 50        # số statement gom vào 1 batch
          batch_versioned_data: true
        order_inserts: true     # group INSERT cùng loại lại
        order_updates: true     # group UPDATE cùng loại lại
```

**Với PostgreSQL, cần thêm `reWriteBatchedInserts`:**

```yaml
spring:
  datasource:
    url: jdbc:postgresql://host/db?reWriteBatchedInserts=true
```

**Pattern flush + clear để tránh L1 cache phình:**

```java
@Transactional
public void bulkInsert(List<ProductDto> dtos) {
    int batchSize = 50;
    for (int i = 0; i < dtos.size(); i++) {
        em.persist(new Product(dtos.get(i)));
        if ((i + 1) % batchSize == 0) {
            em.flush();
            em.clear();
        }
    }
}
```

> ⚠️ `@GeneratedValue(strategy = IDENTITY)` (auto-increment) **vô hiệu hóa batching** vì Hibernate cần ID ngay sau INSERT để tracking. Dùng **SEQUENCE** strategy thay thế:

```java
@Id
@GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "product_seq")
@SequenceGenerator(name = "product_seq", sequenceName = "product_id_seq", allocationSize = 50)
private Long id;
```

`allocationSize = 50` → Hibernate lấy 50 IDs một lần từ sequence → ít round-trip.

---

## 🔍 Query Optimization Tips

### Pagination Đúng Cách

```java
// ❌ Hibernate warning: "HHH90003004: firstResult/maxResults specified with collection fetch"
// Hibernate phải load toàn bộ kết quả vào RAM rồi mới page!
@Query("SELECT o FROM Order o JOIN FETCH o.items")
Page<Order> findAll(Pageable pageable);
```

**Fix — 2-query approach:**

```java
// Query 1: Lấy IDs với pagination
@Query(value = "SELECT o.id FROM Order o",
       countQuery = "SELECT COUNT(o) FROM Order o")
Page<Long> findIds(Pageable pageable);

// Query 2: Load đầy đủ với FETCH
@Query("SELECT DISTINCT o FROM Order o JOIN FETCH o.items WHERE o.id IN :ids")
List<Order> findByIds(@Param("ids") List<Long> ids);
```

---

### Native Query Khi JPQL Không Đủ Mạnh

```java
@Query(value = """
    SELECT p.*, 
           COUNT(oi.id) as order_count,
           COALESCE(SUM(oi.quantity), 0) as total_sold
    FROM products p
    LEFT JOIN order_items oi ON oi.product_id = p.id
    WHERE p.category_id = :categoryId
    GROUP BY p.id
    HAVING COUNT(oi.id) > :minOrders
    ORDER BY total_sold DESC
    LIMIT :limit
    """, nativeQuery = true)
List<Object[]> findTopSellingProducts(Long categoryId, int minOrders, int limit);
```

---

### Criteria API Cho Dynamic Query

```java
public List<Product> search(ProductFilter filter) {
    CriteriaBuilder cb = em.getCriteriaBuilder();
    CriteriaQuery<Product> cq = cb.createQuery(Product.class);
    Root<Product> root = cq.from(Product.class);
    
    List<Predicate> predicates = new ArrayList<>();
    
    if (filter.getName() != null) {
        predicates.add(cb.like(root.get("name"), "%" + filter.getName() + "%"));
    }
    if (filter.getMinPrice() != null) {
        predicates.add(cb.ge(root.get("price"), filter.getMinPrice()));
    }
    if (filter.getCategoryId() != null) {
        predicates.add(cb.equal(root.get("category").get("id"), filter.getCategoryId()));
    }
    
    cq.where(predicates.toArray(new Predicate[0]));
    return em.createQuery(cq).getResultList();
}
```

---

### Stateless Session Cho Bulk Operations

`StatelessSession` bỏ qua L1 cache và dirty checking — lý tưởng cho ETL/migration:

```java
SessionFactory sf = em.unwrap(SessionFactory.class);
try (StatelessSession session = sf.openStatelessSession()) {
    Transaction tx = session.beginTransaction();
    
    ScrollableResults<Product> results = session
        .createQuery("FROM Product WHERE needsMigration = true", Product.class)
        .setFetchSize(100)
        .scroll(ScrollMode.FORWARD_ONLY);
    
    while (results.next()) {
        Product p = results.get();
        p.migrate();
        session.update(p);  // direct update, no dirty check overhead
    }
    tx.commit();
}
```

---

## 💾 Memory Optimization

### Stream Kết Quả Thay Vì Load Toàn Bộ

```java
// ❌ Load hết vào memory
List<Product> all = productRepo.findAll();  // 1 triệu records → OutOfMemory

// ✅ Stream — Hibernate dùng FORWARD_ONLY cursor
@Transactional(readOnly = true)
@Query("SELECT p FROM Product p")
Stream<Product> streamAll();

// Usage
try (Stream<Product> stream = productRepo.streamAll()) {
    stream.map(this::toDto)
          .forEach(this::process);
}
```

### Fetch Size Cho JDBC Cursor

```yaml
spring:
  jpa:
    properties:
      hibernate:
        jdbc:
          fetch_size: 100  # số rows fetch một lần từ DB cursor
```

Mặc định `fetch_size = 0` → driver tự quyết (thường là toàn bộ result set vào memory). Set `100-1000` tùy usecase.

---

## 🏗️ Schema & Index Tips Từ Góc Nhìn JPA

### Composite Index Cho Query Pattern

```java
@Entity
@Table(name = "documents", indexes = {
    @Index(name = "idx_doc_status_created", columnList = "status, created_at DESC"),
    @Index(name = "idx_doc_owner_type", columnList = "owner_id, document_type")
})
public class Document { ... }
```

### Column Definition Chính Xác

```java
// Tránh Hibernate tự sinh column type sai
@Column(name = "amount", precision = 19, scale = 4)
private BigDecimal amount;

@Column(name = "status", length = 20, nullable = false)
@Enumerated(EnumType.STRING)  // luôn dùng STRING, không dùng ORDINAL
private Status status;

@Column(name = "metadata", columnDefinition = "jsonb")
private String metadata;  // PostgreSQL JSONB
```

---

## 🚨 Anti-Pattern Checklist

```
❌ FetchType.EAGER trên @OneToMany / @ManyToMany
❌ open-in-view = true trong production
❌ GenerationType.IDENTITY với batch insert
❌ Không có index trên foreign key columns
❌ @Transactional trên public method cùng class (Spring proxy bypass)
❌ Load full entity chỉ để update 1 field (dùng @Modifying + @Query)
❌ Session scope quá rộng (transaction-scoped session là đúng)
❌ Không flush/clear trong batch loop
❌ Query cache cho data write-heavy
❌ @OneToMany không có @JoinColumn → extra join table được tạo
❌ equals/hashCode dựa vào id chưa được generate (gây bug với Set)
```

---

## ✅ Quick Wins Summary

| Vấn đề | Fix nhanh |
|--------|-----------|
| N+1 | `JOIN FETCH` hoặc `@BatchSize` |
| Đọc nhiều không cần write | `@Transactional(readOnly = true)` |
| Chỉ cần vài field | Interface projection hoặc DTO query |
| Bulk insert chậm | Bật `batch_size`, dùng SEQUENCE, `reWriteBatchedInserts` |
| Memory với dataset lớn | `Stream<Entity>` + `fetch_size` |
| Session giữ quá lâu | Tắt OSIV, dùng transaction-scoped session |
| Update 1 field của entity lớn | `@Modifying @Query("UPDATE ...")` |
| L2 cache stale | Chọn đúng `CacheConcurrencyStrategy` |

---

## 🔗 Liên Quan

- [[Cross-Service-Join-AuthZ-Fine-Grained-Filter]] — vấn đề cross-service query
- [[CQRS-Materialized-View]] — khi RDBMS query quá phức tạp
- [[Transactional-Outbox]] — transactional boundary với event publishing

---

*Tags: #hibernate #jpa #performance #spring-boot #postgresql #database #optimization*

---

## 💥 Hibernate Exceptions — Chẩn Đoán & Xử Lý

> Mỗi exception Hibernate đều có một câu chuyện đằng sau. Hiểu *tại sao* nó xảy ra quan trọng hơn chỉ biết cách tắt lỗi.

---

### EX-01 · `LazyInitializationException`

**Thông báo lỗi điển hình:**
```
org.hibernate.LazyInitializationException:
  failed to lazily initialize a collection of role:
  com.example.Order.items: could not initialize proxy - no Session
```

**Giải thích — tại sao xảy ra:**

```
┌─ HTTP Request ──────────────────────────────────────────────────┐
│                                                                  │
│  Service (có @Transactional)          Controller / View         │
│  ┌───────────────────────┐            ┌────────────────────┐    │
│  │ tx bắt đầu            │            │                    │    │
│  │ order = repo.find(1L) │            │                    │    │
│  │ // items là LAZY      │            │                    │    │
│  │ tx kết thúc ──────────┼──────────► │ order.getItems()   │    │
│  │ Session ĐÓNG          │            │   ══► 💥 BOOM!     │    │
│  └───────────────────────┘            └────────────────────┘    │
│                                                                  │
│  Entity đã thành DETACHED, Session không còn → không thể lazy   │
└──────────────────────────────────────────────────────────────────┘
```

**5 cách xử lý — từ đúng đến sai:**

```java
// ✅ Cách 1 — ĐÚNG NHẤT: Load trong transaction boundary
@Transactional(readOnly = true)
public OrderDto getOrder(Long id) {
    Order order = repo.findById(id).orElseThrow();
    // Truy cập items TRONG transaction → session vẫn mở
    return new OrderDto(order, order.getItems());
}

// ✅ Cách 2 — Dùng JOIN FETCH / EntityGraph
@Query("SELECT o FROM Order o JOIN FETCH o.items WHERE o.id = :id")
Optional<Order> findWithItems(Long id);

// ✅ Cách 3 — Hibernate.initialize() trước khi transaction đóng
@Transactional(readOnly = true)
public Order getOrderInitialized(Long id) {
    Order order = repo.findById(id).orElseThrow();
    Hibernate.initialize(order.getItems());  // force load
    return order;
}

// ⚠️ Cách 4 — Bật OSIV (che vấn đề, không fix root cause)
// spring.jpa.open-in-view=true → giữ session đến hết request
// → connection pool exhaustion dưới tải cao

// ❌ Cách 5 — SAI: Đổi sang EAGER fetch
@OneToMany(fetch = FetchType.EAGER)  // fix lazy nhưng gây N+1 / over-fetch
private List<OrderItem> items;
```

> **Kinh nghiệm thực tế:** `LazyInitializationException` thường xuất hiện khi entity được trả từ Service sang Controller rồi serialize JSON (Jackson). Fix chuẩn: trả DTO thay vì entity, hoặc dùng `@JsonIgnore` + load explicit trong service layer.

---

### EX-02 · `NonUniqueObjectException` / "Multiple representations of the same entity"

**Thông báo lỗi điển hình:**
```
org.hibernate.NonUniqueObjectException:
  A different object with the same identifier value was already associated
  with the session: [com.example.User#42]

// hoặc Hibernate 6+:
org.hibernate.HibernateException:
  Multiple representations of the same entity [com.example.User#42]
  are being merged
```

**Giải thích — tại sao xảy ra:**

```
Session (L1 Cache)
┌──────────────────────────────────────────────────────────────────┐
│                                                                   │
│  Step 1: user_managed = repo.findById(42L)                       │
│          L1: { User#42 → instance_A }  ← MANAGED                │
│                                                                   │
│  Step 2: user_detached (từ nơi khác, cùng id = 42, là instance_B)│
│                                                                   │
│  Step 3: em.merge(user_detached)  ← OK, copy B's state vào A    │
│          Hoặc: em.saveOrUpdate(user_detached) ← 💥 CONFLICT!    │
│          → Hibernate thấy instance_B ≠ instance_A, cùng id=42   │
└───────────────────────────────────────────────────────────────────┘
```

**Nguyên nhân phổ biến nhất — pattern sai:**

```java
// ❌ Tình huống 1: Load rồi lại save detached object cùng session
@Transactional
public void update(User incoming) {                       // incoming là DETACHED
    User existing = userRepo.findById(incoming.getId());  // → MANAGED, vào L1
    // L1 đã có User#42 = existing (instance_A)
    userRepo.save(incoming);  // 💥 incoming (instance_B) ≠ existing (instance_A)
}

// ❌ Tình huống 2: Nhận @RequestBody entity rồi save trực tiếp
@PostMapping
public void update(@RequestBody User user) {  // user là DETACHED object
    service.update(user);                     // nếu service load lại → conflict
}

// ❌ Tình huống 3: Dùng saveOrUpdate thay vì merge
session.saveOrUpdate(detachedEntity);  // không handle L1 conflict
```

**Cách fix:**

```java
// ✅ Fix 1 — CHUẨN NHẤT: Không nhận entity từ ngoài, nhận DTO
@Transactional
public void update(Long id, UserUpdateRequest req) {
    User user = userRepo.findById(id).orElseThrow();  // MANAGED
    user.setName(req.getName());  // dirty check → auto UPDATE khi flush
    // Không cần save() vì đã MANAGED trong @Transactional
}

// ✅ Fix 2: Nếu buộc phải dùng merge()
@Transactional
public void mergeDetached(User detached) {
    User managed = em.merge(detached);  // Hibernate copy state, trả về managed
    // Chỉ dùng 'managed' từ đây, bỏ 'detached'
}

// ✅ Fix 3: Evict trước khi re-associate (hiếm khi cần)
@Transactional
public void forceOverwrite(User detached) {
    User inL1 = em.find(User.class, detached.getId());
    if (inL1 != null) em.detach(inL1);  // đuổi instance cũ khỏi L1
    em.merge(detached);
}
```

> **Kinh nghiệm thực tế:** Lỗi này thường xuất hiện khi nhận `@RequestBody User user` trực tiếp rồi pass xuống service có `@Transactional`. Rule vàng: **luôn nhận DTO, không nhận entity từ HTTP layer**. Entity chỉ sống trong persistence layer.

---

### EX-03 · `StaleObjectStateException` / `OptimisticLockException`

**Thông báo lỗi điển hình:**
```
org.hibernate.StaleObjectStateException:
  Row was updated or deleted by another transaction
  (or unsaved-value mapping was incorrect): [com.example.Product#15]
```

**Giải thích — Optimistic Locking conflict:**

```
         T=0          T=1           T=2          T=3
          │            │             │             │
Thread A: load(v=1) ─► modify    ──────────────► save ✅ (version 1→2)
          │            │                          │
Thread B: load(v=1) ─────────────► modify      ► save 💥
                                              DB có v=2, B mang v=1
                                              → WHERE version=1 → 0 rows affected
                                              → StaleObjectStateException
```

**Setup Optimistic Locking:**

```java
@Entity
public class Product {
    @Id
    private Long id;

    @Version  // Hibernate tự quản lý, increment mỗi UPDATE
    private Integer version;

    private BigDecimal price;
}
// Hibernate sinh: UPDATE products SET price=?, version=2 WHERE id=15 AND version=1
```

**Xử lý exception — retry pattern:**

```java
// ✅ Retry tự động với Spring Retry
@Retryable(
    retryFor = OptimisticLockingFailureException.class,
    maxAttempts = 3,
    backoff = @Backoff(delay = 100, multiplier = 2)  // 100ms, 200ms, 400ms
)
@Transactional
public void updateStock(Long productId, int delta) {
    Product p = productRepo.findById(productId).orElseThrow();
    p.setStock(p.getStock() + delta);
}
// Mỗi retry là một transaction mới → load version mới nhất từ DB

// ✅ Xử lý manual, trả conflict về caller
@Transactional
public UpdateResult tryUpdatePrice(Long id, BigDecimal newPrice) {
    try {
        Product p = productRepo.findById(id).orElseThrow();
        p.setPrice(newPrice);
        productRepo.flush();
        return UpdateResult.SUCCESS;
    } catch (OptimisticLockingFailureException e) {
        return UpdateResult.CONFLICT;
    }
}
```

> **Kinh nghiệm thực tế:** Với hệ thống banking như PDMS, Optimistic Locking phù hợp cho document metadata (ít conflict). Với dữ liệu highly-contended (số dư, slot count), nên dùng Pessimistic Lock (`@Lock(PESSIMISTIC_WRITE)`) hoặc queue-based serialization để tránh retry storm.

---

### EX-04 · `ConstraintViolationException`

**Thông báo lỗi điển hình:**
```
org.hibernate.exception.ConstraintViolationException:
  ERROR: duplicate key value violates unique constraint "uk_users_email"
  Detail: Key (email)=(bach@vpbank.com) already exists.
```

**Luồng xử lý khi exception xảy ra:**

```
em.persist(entity)
    │
    ▼
Bean Validation (@NotNull, @Size...) ── fail ──► javax.validation.ConstraintViolationException
    │ pass
    ▼
SQL INSERT/UPDATE gửi đến PostgreSQL
    │
    ▼
PostgreSQL check DB constraints (UNIQUE, FK, CHECK...)
    │ fail
    ▼
SQLException
    │
    ▼
Hibernate wrap ──► org.hibernate.exception.ConstraintViolationException
    │
    ▼
Spring wrap ──► DataIntegrityViolationException (cái bạn hay catch)
```

**Xử lý đúng cách:**

```java
// ✅ Check trước để báo lỗi rõ ràng
@Transactional
public User createUser(CreateUserRequest req) {
    if (userRepo.existsByEmail(req.getEmail())) {
        throw new BusinessException("Email đã tồn tại: " + req.getEmail());
    }
    return userRepo.save(new User(req));
}

// ✅ Global handler parse constraint name thành message thân thiện
@ExceptionHandler(DataIntegrityViolationException.class)
public ResponseEntity<ErrorResponse> handleConstraint(DataIntegrityViolationException ex) {
    String dbMsg = ex.getMostSpecificCause().getMessage();
    String userMsg = parseConstraintMessage(dbMsg);
    return ResponseEntity.status(409).body(new ErrorResponse(userMsg));
}

private String parseConstraintMessage(String dbMsg) {
    if (dbMsg.contains("uk_users_email"))    return "Email đã được sử dụng";
    if (dbMsg.contains("uk_users_phone"))    return "Số điện thoại đã được sử dụng";
    if (dbMsg.contains("fk_orders_user_id")) return "User không tồn tại";
    return "Dữ liệu vi phạm ràng buộc hệ thống";
}
```

> **Tip:** Đặt tên constraint có ý nghĩa trong migration SQL: `CONSTRAINT uk_users_email UNIQUE (email)` thay để tên DB tự đặt kiểu `users_email_key`. Dễ parse error message, dễ debug.

---

### EX-05 · `TransactionRequiredException`

**Thông báo lỗi điển hình:**
```
javax.persistence.TransactionRequiredException:
  Executing an update/delete query
  No EntityManager with actual transaction available for current thread
```

**3 nguyên nhân phổ biến nhất:**

```java
// ❌ Nguyên nhân 1: @Modifying không có @Transactional bao ngoài
@Modifying
@Query("UPDATE Product p SET p.price = :price WHERE p.id = :id")
void updatePrice(Long id, BigDecimal price);
// Gọi thẳng mà không có @Transactional → TransactionRequiredException

// ❌ Nguyên nhân 2: @Transactional trên private method — Spring AOP bypass
@Service
public class ProductService {
    public void doSomething() {
        this.updateInternal();  // gọi qua 'this' → bypass proxy
    }

    @Transactional              // VÔ DỤNG khi gọi qua this
    private void updateInternal() {
        repo.save(...);         // → TransactionRequiredException
    }
}

// ❌ Nguyên nhân 3: Gọi write op trong @PostConstruct hoặc @Scheduled
// mà không có @Transactional
@PostConstruct
public void init() {
    repo.save(new Config(...));  // Chưa chắc có transaction context
}
```

**Fix từng nguyên nhân:**

```java
// ✅ Fix 1: @Transactional ở caller
@Transactional
public void updatePrice(Long id, BigDecimal price) {
    productRepo.updatePrice(id, price);
}

// ✅ Fix 2a: Tách ra bean riêng để proxy hoạt động
@Service
@RequiredArgsConstructor
public class ProductService {
    private final ProductInternalService internal;

    public void doSomething() {
        internal.updateInternal();  // qua bean khác → proxy intercept được
    }
}

@Service
public class ProductInternalService {
    @Transactional
    public void updateInternal() { ... }
}

// ✅ Fix 2b: Self-inject qua ApplicationContext
@Service
public class ProductService {
    @Autowired
    private ApplicationContext ctx;

    public void doSomething() {
        ctx.getBean(ProductService.class).updateInternal();
    }

    @Transactional
    public void updateInternal() { ... }
}

// ✅ Fix 3: Thêm @Transactional vào @Scheduled
@Scheduled(cron = "0 0 * * * *")
@Transactional
public void scheduledJob() {
    repo.save(...);
}
```

---

### EX-06 · `EntityNotFoundException` — Proxy Trap

**Thông báo lỗi điển hình:**
```
javax.persistence.EntityNotFoundException:
  Unable to find com.example.User with id 999
```

**Sự khác biệt then chốt giữa `findById()` và `getReference()`:**

```
findById(999L)
  │
  ▼
SELECT * FROM users WHERE id = 999
  │
  ├── có kết quả → trả về Optional.of(user)
  └── không có  → trả về Optional.empty()  ← SAFE


getReference(999L)
  │
  ▼
Trả về PROXY ngay (KHÔNG SELECT)
  │
  ▼
Lần đầu tiên truy cập field của proxy (vd: user.getName())
  │
  ▼
SELECT * FROM users WHERE id = 999
  │
  ├── có kết quả → trả về dữ liệu
  └── không có  → 💥 EntityNotFoundException  ← SURPRISE!
```

**Dùng đúng từng loại:**

```java
// ✅ getReference() khi: chắc chắn FK tồn tại, chỉ cần set relationship
@Transactional
public Order createOrder(Long userId, OrderRequest req) {
    // userId đến từ JWT token, đã authenticated → chắc chắn tồn tại
    User userRef = em.getReference(User.class, userId);  // không SELECT
    Order order = new Order(userRef, req);
    return orderRepo.save(order);  // chỉ cần FK, tiết kiệm 1 SELECT
}

// ✅ findById() khi: không chắc tồn tại, hoặc cần đọc data từ entity
@Transactional
public void assignManager(Long deptId, Long managerId) {
    Department dept = deptRepo.findById(deptId)
        .orElseThrow(() -> new NotFoundException("Department not found"));
    User manager = userRepo.findById(managerId)
        .orElseThrow(() -> new NotFoundException("Manager not found"));
    dept.setManager(manager);
}
```

> **Rule:** Nếu bạn chỉ cần set FK (foreign key association) và ID đã được validate → `getReference()`. Nếu cần đọc bất kỳ field nào của entity hoặc không chắc ID valid → `findById()`.

---

### EX-07 · `QueryException` — JPQL Field Name Sai

**Thông báo lỗi điển hình:**
```
org.hibernate.QueryException:
  could not resolve property: user_id of: com.example.Order
```

**Nguyên nhân — nhầm tên column DB với field Java:**

```java
// ❌ Dùng tên column DB trong JPQL
@Query("SELECT o FROM Order o WHERE o.user_id = :userId")
//                                        ^^^^^^^ tên column → QueryException

// ✅ Dùng tên field Java
@Query("SELECT o FROM Order o WHERE o.user.id = :userId")

// ❌ Truy cập collection trực tiếp trong WHERE
@Query("SELECT o FROM Order o WHERE o.items.productId = :pid")
//                                        ^^^^^ List không dot-access được

// ✅ JOIN rồi mới filter
@Query("SELECT DISTINCT o FROM Order o JOIN o.items i WHERE i.productId = :pid")

// ❌ Tên field typo (case-sensitive trong JPQL)
@Query("SELECT o FROM Order o WHERE o.Status = :status")
//                                      ^^^^^^ Java field là 'status' (lowercase)

// ✅
@Query("SELECT o FROM Order o WHERE o.status = :status")
```

**Các lỗi mapping khác hay gặp:**

```java
// ❌ Quên @Enumerated → MappingException
@Column(name = "status")
private Status status;  // Hibernate không biết map String/Int thành enum

// ✅
@Enumerated(EnumType.STRING)
@Column(name = "status")
private Status status;

// ❌ Kiểu dữ liệu Java không match DB column → ClassCastException lúc runtime
// DB: BIGINT, Java: Integer → overflow với số lớn
private Integer documentCount;  // nên dùng Long

// ✅
private Long documentCount;
```

---

### EX-08 · `PessimisticLockingFailureException` — Lock Timeout & Deadlock

**Thông báo lỗi điển hình:**
```
org.springframework.dao.PessimisticLockingFailureException:
  could not obtain pessimistic lock; SQL [select ... for update]

// Deadlock:
org.hibernate.PessimisticLockException:
  ERROR: deadlock detected
  Detail: Process 123 waits for ShareLock on transaction 456
```

**Deadlock diagram — hay gặp khi update nhiều rows:**

```
Thread A (tx1):                   Thread B (tx2):
  LOCK row#1 ✅                     LOCK row#2 ✅
  waiting for row#2... ──────────── waiting for row#1...
                          💀 DEADLOCK
```

**Fix deadlock — luôn lock theo thứ tự nhất quán:**

```java
// ❌ Lock thứ tự không nhất quán → deadlock tiềm tàng
public void transfer(Long fromId, Long toId, BigDecimal amount) {
    Account from = accountRepo.findByIdForUpdate(fromId);  // lock fromId trước
    Account to   = accountRepo.findByIdForUpdate(toId);    // lock toId sau
    // Thread khác lock toId trước → deadlock!
}

// ✅ Luôn lock theo ID tăng dần → thứ tự nhất quán
public void transfer(Long fromId, Long toId, BigDecimal amount) {
    Long firstId  = Math.min(fromId, toId);
    Long secondId = Math.max(fromId, toId);
    Account first  = accountRepo.findByIdForUpdate(firstId);
    Account second = accountRepo.findByIdForUpdate(secondId);
    // Mọi thread đều lock theo thứ tự: nhỏ trước lớn sau → không deadlock
    Account from = first.getId().equals(fromId) ? first : second;
    Account to   = first.getId().equals(toId)   ? first : second;
    from.debit(amount);
    to.credit(amount);
}

// ✅ Thêm lock timeout tránh chờ mãi
@Lock(LockModeType.PESSIMISTIC_WRITE)
@QueryHints(@QueryHint(name = "javax.persistence.lock.timeout", value = "3000"))
Optional<Account> findByIdForUpdate(Long id);
// → LockTimeoutException sau 3s thay vì chờ vô tận
```

---

### EX-09 · `DataIntegrityViolationException` — FK Delete Violation

**Thông báo lỗi điển hình:**
```
org.springframework.dao.DataIntegrityViolationException:
  ERROR: update or delete on table "users" violates foreign key constraint
  "fk_orders_user_id" on table "orders"
  Detail: Key (id)=(42) is still referenced from table "orders"
```

**3 chiến lược xử lý:**

```java
// ✅ Chiến lược 1 — Soft delete (khuyến nghị cho banking/document system)
@Entity
public class User {
    @Column(name = "deleted_at")
    private LocalDateTime deletedAt;

    public boolean isDeleted() { return deletedAt != null; }
    public void softDelete() { this.deletedAt = LocalDateTime.now(); }
}
// Không xóa row → không vi phạm FK → audit trail còn nguyên

// ✅ Chiến lược 2 — Validate trước khi delete
@Transactional
public void deleteUser(Long userId) {
    long activeOrders = orderRepo.countByUserIdAndDeletedAtIsNull(userId);
    if (activeOrders > 0) {
        throw new BusinessException(
            "Không thể xóa user đang có " + activeOrders + " đơn hàng active");
    }
    userRepo.deleteById(userId);
}

// ✅ Chiến lược 3 — Cascade xóa với bulk delete (KHÔNG dùng cascade = REMOVE)
@Transactional
public void hardDeleteUser(Long userId) {
    // Xóa children trước bằng bulk DELETE (không load vào memory)
    orderItemRepo.deleteByOrderUserId(userId);  // @Modifying
    orderRepo.deleteByUserId(userId);           // @Modifying
    userRepo.deleteById(userId);
}

// ❌ Tránh cascade = CascadeType.REMOVE trên collection lớn
// Hibernate load TẤT CẢ children vào memory để xóa từng cái
@OneToMany(cascade = CascadeType.REMOVE)  // 100k orders → 100k entities trong RAM!
private List<Order> orders;
```

---

### 📋 Exception Quick Reference

| Exception | Nguyên nhân gốc | Fix |
|-----------|----------------|-----|
| `LazyInitializationException` | Lazy proxy truy cập ngoài Session | Load trong `@Transactional`, dùng JOIN FETCH |
| `NonUniqueObjectException` | 2 instance cùng id trong 1 Session | Nhận DTO từ HTTP, không nhận entity |
| `StaleObjectStateException` | Optimistic lock version conflict | Retry pattern hoặc `PESSIMISTIC_WRITE` |
| `ConstraintViolationException` | UNIQUE/FK/CHECK DB bị vi phạm | Check trước + parse error thành message rõ |
| `TransactionRequiredException` | Write op ngoài transaction boundary | `@Transactional` đúng chỗ, tránh self-invocation |
| `EntityNotFoundException` | `getReference()` với ID không tồn tại | `findById()` khi không chắc, `getReference()` khi chắc FK valid |
| `QueryException` | Dùng tên column DB trong JPQL | Dùng Java field name, JOIN cho collection |
| `PessimisticLockingFailureException` | Lock timeout hoặc deadlock | Lock theo thứ tự nhất quán + timeout |
| `DataIntegrityViolationException` (FK) | Delete entity còn được reference | Soft delete hoặc bulk delete children trước |


---

## 🧠 Stateful Object Graph Manager — Cơ Chế Nội Tại

> Đây là phần quan trọng nhất để hiểu *mọi* hành vi của Hibernate. Tất cả vấn đề hiệu năng, exception, và behavior kỳ lạ đều có thể giải thích từ đây.

---

### Persistence Context — "Bộ Não" Của Hibernate

**Persistence Context** (hay Session trong Hibernate thuần) là một **unit of work** — một không gian làm việc có trạng thái, tồn tại trong một khoảng thời gian nhất định, và quản lý toàn bộ vòng đời của entity bên trong nó.

Hãy hình dung nó như một **bàn làm việc**:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PERSISTENCE CONTEXT (Session)                     │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                   Identity Map (L1 Cache)                     │   │
│  │                                                              │   │
│  │   Key: (User.class, 1L)   → instance_A  [snapshot_A]        │   │
│  │   Key: (Order.class, 5L)  → instance_B  [snapshot_B]        │   │
│  │   Key: (Product.class,9L) → instance_C  [snapshot_C]        │   │
│  │                                                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                 Action Queue (Write-behind)                   │   │
│  │                                                              │   │
│  │   [INSERT Product]  [UPDATE User]  [DELETE Order]            │   │
│  │                                                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  FlushMode: AUTO | COMMIT | MANUAL | ALWAYS                         │
└─────────────────────────────────────────────────────────────────────┘
```

**Persistence Context KHÔNG phải là Connection.** Đây là điểm nhiều người nhầm:

```
Persistence Context (Session)          JDBC Connection
┌───────────────────────────┐          ┌──────────────────┐
│ - Identity Map            │          │ - TCP socket đến │
│ - Snapshots               │◄────────►│   PostgreSQL      │
│ - Action Queue            │  mượn    │ - Active query   │
│ - FlushMode               │  khi cần │ - TX state       │
└───────────────────────────┘          └──────────────────┘
          │                                     │
          │ 1 Session có thể                    │ Connection được
          │ dùng nhiều connection               │ trả về pool
          │ khác nhau trong                     │ sau mỗi statement
          │ vòng đời của nó                     │ (connection pooling)
```

---

### Identity Map — Trái Tim Của L1 Cache

Identity Map là một **HashMap** bên trong Session, map từ `(EntityType, primaryKey)` → `entity instance`.

```java
// Hibernate internal (simplified):
Map<EntityKey, Object> identityMap = new HashMap<>();

// EntityKey = (class=User.class, id=1L)
// Value     = instance của User với id=1
```

**Tại sao cần Identity Map?**

Đảm bảo **object identity** — cùng một DB row luôn được đại diện bởi **đúng một Java object** trong cùng Session:

```java
// Không có Identity Map:
User u1 = repo.findById(1L);  // tạo instance_A
User u2 = repo.findById(1L);  // tạo instance_B
u1 == u2;       // false! 2 object khác nhau
u1.equals(u2);  // true (nếu equals() dựa vào id)

// Với Identity Map (Hibernate):
User u1 = repo.findById(1L);  // tạo instance_A, lưu vào map
User u2 = repo.findById(1L);  // tìm thấy trong map, trả về instance_A
u1 == u2;  // TRUE! Cùng object reference
```

**Hệ quả quan trọng:**

```java
@Transactional
public void demo() {
    User u1 = repo.findById(1L);
    u1.setName("Alice");

    User u2 = repo.findById(1L);  // trả về CÙNG instance với u1
    System.out.println(u2.getName());  // "Alice" — không phải tên cũ trong DB!
    // u2 thấy thay đổi của u1 vì chúng là cùng object
}
```

---

### Snapshot — Cơ Chế Dirty Checking

Khi một entity được load vào Persistence Context (trở thành **MANAGED**), Hibernate tạo ra một **snapshot** — bản sao sâu (deep copy) của trạng thái entity tại thời điểm load.

```
em.find(User.class, 1L)
        │
        ▼
  SELECT từ DB:
  { id: 1, name: "Bach", email: "bach@vpbank.com", age: 28 }
        │
        ▼
  ┌─────────────────────────────────────────────────────┐
  │               Persistence Context                    │
  │                                                     │
  │  MANAGED instance:          SNAPSHOT (deep copy):   │
  │  user.id    = 1             snap.id    = 1          │
  │  user.name  = "Bach"   ←── snap.name  = "Bach"     │
  │  user.email = "bach@…"      snap.email = "bach@…"  │
  │  user.age   = 28            snap.age   = 28         │
  │                                                     │
  │  (user và snap là 2 object Java riêng biệt)         │
  └─────────────────────────────────────────────────────┘
```

**Snapshot được lưu ở đâu trong memory?**

```java
// Simplified Hibernate internal structure:
class StatefulPersistenceContext {
    // Entity instances (Identity Map)
    Map<EntityKey, Object> entitiesByKey;

    // Snapshots — parallel structure
    Map<EntityKey, Object[]> entitySnapshotsByKey;
    //                        ^^^^^^^^
    //                        mảng giá trị từng field theo thứ tự
    //                        VD: Object[] { 1L, "Bach", "bach@…", 28 }
}
```

Snapshot lưu dưới dạng `Object[]` — mảng các giá trị primitive/reference của từng column được map, **không phải** một entity instance đầy đủ. Điều này tiết kiệm memory hơn so với giữ 2 entity instance.

---

### Dirty Checking — Thuật Toán So Sánh

Khi Hibernate cần **flush** (đồng bộ state với DB), nó chạy thuật toán dirty checking cho **mọi entity MANAGED** trong session:

```
FOR EACH entity trong Identity Map:
    snapshot = entitySnapshotsByKey[entity.key]
    currentState = extractState(entity)  // đọc giá trị hiện tại qua reflection

    IF currentState != snapshot:
        → entity là "dirty" → thêm UPDATE vào Action Queue
    ELSE:
        → entity sạch → bỏ qua
```

**Chi tiết so sánh từng field:**

```
snapshot:     Object[] { 1L,   "Bach",   "bach@vpbank.com",  28  }
currentState: Object[] { 1L,   "Alice",  "bach@vpbank.com",  28  }
                               ^^^^^^^ khác! → dirty
                         
→ Hibernate sinh: UPDATE users SET name='Alice' WHERE id=1
  (chỉ update field thay đổi nếu dùng @DynamicUpdate)
```

**Mặc định Hibernate UPDATE tất cả columns** dù chỉ 1 field thay đổi:

```sql
-- Mặc định (không @DynamicUpdate):
UPDATE users SET name='Alice', email='bach@vpbank.com', age=28 WHERE id=1

-- Với @DynamicUpdate (chỉ update field thay đổi):
UPDATE users SET name='Alice' WHERE id=1
```

```java
@Entity
@DynamicUpdate  // chỉ UPDATE column thực sự thay đổi
public class User { ... }
// Hữu ích khi entity có nhiều column và thường chỉ update 1-2 field
// Trade-off: Hibernate phải so sánh chi tiết hơn, SQL khác nhau → không cache được prepared statement
```

---

### Flush — Khi Nào Snapshot Được Dùng?

**Flush** là quá trình Hibernate đồng bộ state trong Persistence Context với database. Đây là lúc dirty checking được thực thi và Action Queue được xả.

```
Persistence Context State          Database State
┌───────────────────────┐          ┌──────────────────┐
│ User#1: name="Alice"  │          │ users: name="Bach"│
│ snapshot: name="Bach" │          │                  │
│                       │  FLUSH   │                  │
│ dirty check: DIRTY ───┼─────────►│ UPDATE users     │
│                       │          │ SET name='Alice' │
│ Order#5: DELETED ─────┼─────────►│ DELETE orders    │
│                       │          │ WHERE id=5       │
│ Product#9: new INSERT─┼─────────►│ INSERT INTO...   │
└───────────────────────┘          └──────────────────┘
  Sau flush: snapshots được cập nhật theo state mới
```

**4 FlushMode và khi nào trigger:**

```
FlushMode.AUTO (default trong Spring @Transactional):
├── Trước khi thực thi JPQL/HQL query
│   (đảm bảo query thấy state mới nhất)
└── Khi commit transaction

FlushMode.COMMIT:
└── Chỉ khi commit transaction
    (query có thể thấy state cũ → nguy hiểm nhưng nhanh hơn)

FlushMode.MANUAL:
└── Chỉ khi gọi em.flush() explicit
    (toàn quyền kiểm soát, dùng cho batch processing)

FlushMode.ALWAYS:
└── Trước MỌI query
    (safe nhất nhưng chậm nhất)
```

**Ví dụ FlushMode.AUTO hoạt động:**

```java
@Transactional
public void demo() {
    User user = repo.findById(1L);    // load + snapshot
    user.setName("Alice");            // dirty, chưa flush

    // Hibernate thấy sắp query Users → AUTO flush trước
    // để query thấy được "Alice"
    List<User> users = em.createQuery(
        "FROM User WHERE name = 'Alice'", User.class
    ).getResultList();
    // → Hibernate flush UPDATE trước → rồi mới SELECT
    // → "Alice" được tìm thấy ✅
}
```

---

### Entity Lifecycle — Vòng Đời Đầy Đủ

```
                    new User()
                        │
                        ▼
              ┌──────────────────┐
              │    TRANSIENT     │  ← Không có ID, không trong PC
              │  (chưa persist)  │
              └──────────────────┘
                  │          ▲
        persist() │          │ delete() (nếu chưa flush)
                  ▼          │
              ┌──────────────────┐
              │     MANAGED      │  ← Trong Persistence Context
              │  (được tracking) │    có snapshot, dirty checked
              └──────────────────┘
               │    ▲    │    ▲
     session   │    │    │    │  merge()
     close /   │    │    │    │  (copy state vào managed instance)
     evict()   │    │    │    │
               ▼    │    ▼    │
              ┌──────────────────┐
              │    DETACHED      │  ← Không trong PC
              │  (không track)   │    ID còn, nhưng thay đổi
              └──────────────────┘    không được track
                        │
              remove() sau khi merge
                        │
                        ▼
              ┌──────────────────┐
              │     REMOVED      │  ← Đã đánh dấu xóa
              │  (sẽ DELETE)     │    DELETE khi flush
              └──────────────────┘
                        │
                   flush/commit
                        │
                        ▼
                  Row bị xóa khỏi DB
```

**Code minh họa từng transition:**

```java
// TRANSIENT
User user = new User();
user.setName("Bach");
// user.id = null, không trong PC

// TRANSIENT → MANAGED
em.persist(user);
// user.id = generated (nếu SEQUENCE), vào PC, snapshot tạo
// Action Queue: [INSERT User]

// MANAGED — đang được track
user.setEmail("bach@vpbank.com");
// snapshot khác currentState → dirty

// MANAGED → DETACHED
em.detach(user);         // explicit detach
// hoặc: session.close()  // close session → tất cả entity thành DETACHED
// hoặc: em.clear()       // xóa toàn bộ PC → tất cả thành DETACHED

// DETACHED → MANAGED (merge)
user.setName("New Name");  // thay đổi trong detached state
User managed = em.merge(user);
// Hibernate: load User từ DB (hoặc L1 nếu có)
//            copy state từ 'user' vào managed instance
//            trả về managed instance
// 'user' vẫn DETACHED, 'managed' là MANAGED

// MANAGED → REMOVED
em.remove(managed);
// Action Queue: [DELETE User]
// Sau flush: row bị xóa, instance trở thành TRANSIENT
```

---

### Memory Layout — Hibernate Lưu Gì Trong RAM?

Đây là cái giá phải trả cho stateful management. Với mỗi entity MANAGED:

```
Cho 1 entity User với 10 fields:
┌────────────────────────────────────────────────────────────────┐
│ MANAGED INSTANCE (User object)                                 │
│  - Object header: ~16 bytes                                    │
│  - 10 fields: ~80-200 bytes tùy kiểu                          │
│  - Hibernate proxy overhead (nếu lazy): ~200 bytes thêm       │
├────────────────────────────────────────────────────────────────┤
│ SNAPSHOT (Object[] của 10 fields)                              │
│  - Array header: ~16 bytes                                     │
│  - 10 object references/values: ~80 bytes                      │
│  - Đối với String fields: String objects được share (interned) │
├────────────────────────────────────────────────────────────────┤
│ IDENTITY MAP ENTRY                                             │
│  - EntityKey object: ~40 bytes                                 │
│  - HashMap entry: ~32 bytes                                    │
└────────────────────────────────────────────────────────────────┘
Tổng ~ 400-600 bytes / entity managed
```

**Hệ quả với 10,000 entities trong session:**

```
10,000 entities × 500 bytes = ~5 MB chỉ cho PC overhead
+ data thực tế của entities
+ collection proxies nếu lazy
→ Dễ dàng đạt 50-200 MB cho một session "bừa bãi"
```

---

### Khi Nào Hibernate Giải Phóng Bộ Nhớ?

```
Bộ nhớ PC được giải phóng khi:

1. session.close() / EntityManager.close()
   → Toàn bộ Identity Map + Snapshots bị GC
   → Entities trở thành DETACHED (vẫn còn trong heap nếu có reference)
   → Connection trả về pool

2. em.clear()
   → Xóa toàn bộ PC (Identity Map + Snapshots + Action Queue)
   → Tất cả entity trở thành DETACHED
   → GC có thể thu hồi nếu không còn reference

3. em.detach(entity)
   → Chỉ xóa 1 entity khỏi Identity Map và Snapshot
   → Entity trở thành DETACHED

4. flush() KHÔNG giải phóng bộ nhớ
   → Chỉ đồng bộ với DB, PC vẫn giữ nguyên
   → Snapshot được update theo state sau flush

5. Transaction commit / rollback
   → KHÔNG tự động clear PC
   → Phụ thuộc vào Session scope config
```

**Timeline memory trong Spring @Transactional:**

```
HTTP Request bắt đầu
        │
        ▼
@Transactional method được gọi
        │
        ▼
Spring tạo/lấy Session từ pool ──────┐
        │                            │  Persistence Context mở
        ▼                            │  (Identity Map trống)
repo.findById(1L)  ← SELECT          │
  → Entity vào Identity Map          │
  → Snapshot tạo                     │  Memory tăng
        │                            │
repo.findAll()  ← SELECT             │
  → N entities vào Identity Map      │  Memory tăng
  → N snapshots tạo                  │
        │                            │
  [business logic]                   │
        │                            │
Transaction commit                   │
  → flush() chạy (dirty check)       │
  → SQL gửi đến DB                   │
  → Connection trả về pool           │
        │                            │
@Transactional method kết thúc ──────┘
        │
        ▼
Session scope kết thúc → PC cleared
  → Identity Map xóa
  → Snapshots xóa ──────────────────── Memory giải phóng (GC eligible)
  → Entities trở thành DETACHED
        │
        ▼
HTTP Response trả về
```

**Với OSIV (Open Session In View = true):**

```
HTTP Request bắt đầu → Session mở ──────────────────────────────┐
        │                                                         │
@Transactional service ──── tx start/commit                      │
        │                                                         │
Controller nhận entity (STILL MANAGED do OSIV)                   │  Session
        │                                                         │  MỞ ĐẾN
JSON serialization (lazy load xảy ra ở đây)                      │  TẬN ĐÂY
        │                                                         │
HTTP Response trả về → Session đóng ────────────────────────────┘
Memory giải phóng muộn hơn nhiều + giữ connection lâu hơn
```

---

### Proxy — Lazy Loading Hoạt Động Thế Nào?

Khi bạn khai báo `FetchType.LAZY` trên một relationship, Hibernate không load dữ liệu ngay. Thay vào đó, nó tạo ra một **Proxy object** — một subclass được sinh ra lúc runtime (dùng ByteBuddy hoặc Javassist):

```java
@Entity
public class Order {
    @ManyToOne(fetch = FetchType.LAZY)
    private User user;  // ← Hibernate sẽ tạo proxy cho field này
}
```

```
em.find(Order.class, 5L)
        │
        ▼
SELECT * FROM orders WHERE id = 5
Result: { id:5, user_id:42, total:100.0 }
        │
        ▼
Tạo Order instance:
  order.id     = 5
  order.total  = 100.0
  order.user   = UserProxy { id: 42, initialized: false }
                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                 KHÔNG phải User thật, chỉ là proxy giữ id=42
```

**Proxy là subclass động của User:**

```java
// Hibernate sinh ra (simplified):
class User$HibernateProxyXXXX extends User {
    private Long id;
    private boolean initialized = false;
    private Session session;  // giữ reference đến session để load khi cần

    @Override
    public String getName() {
        if (!initialized) {
            // Trigger lazy load!
            realUser = session.get(User.class, this.id);
            initialized = true;
        }
        return realUser.getName();
    }
    // ... override mọi getter
}
```

**Vì vậy proxy cần Session còn mở để load:**

```
order.getUser().getName()
        │
        ▼
UserProxy.getName() được gọi
        │
        ▼
initialized = false → cần load
        │
        ▼
session.get(User.class, 42L)
        │
        ├── Session còn mở → SELECT → trả về User ✅
        └── Session đã đóng → 💥 LazyInitializationException
```

**Proxy và `instanceof` check:**

```java
User user = em.getReference(User.class, 42L);  // trả về proxy

// Cẩn thận với instanceof:
user instanceof User;  // TRUE (proxy extends User)

// Cẩn thận với getClass():
user.getClass();       // User$HibernateProxyXXXX, KHÔNG phải User.class!
user.getClass() == User.class;  // FALSE!

// Cách đúng để check type:
Hibernate.getClass(user) == User.class;  // TRUE ✅

// Unwrap proxy nếu cần:
User realUser = Hibernate.unproxy(user, User.class);
```

---

### Collection Proxy — List và Set Lazy

Tương tự với lazy collection, Hibernate wrap list/set trong một `PersistentBag`/`PersistentSet`:

```java
@OneToMany(fetch = FetchType.LAZY)
private List<OrderItem> items;
// → Sau load: items = PersistentBag { owner: order, initialized: false }
```

```
order.getItems()
        │
        ▼
PersistentBag.get() / size() / iterator() ...
        │
        ▼
initialized = false → trigger load
        │
        ▼
SELECT * FROM order_items WHERE order_id = 5
        │
        ▼
initialized = true, data loaded vào bag
        │
        ▼
Các lần gọi sau: trả về data từ bag (không SELECT nữa)
```

**Nguy hiểm của việc replace collection:**

```java
@Transactional
public void update(Long orderId, List<OrderItem> newItems) {
    Order order = repo.findById(orderId).orElseThrow();

    // ❌ NGUY HIỂM: Replace collection reference
    order.setItems(newItems);
    // Hibernate mất track collection cũ
    // orphanRemoval sẽ không hoạt động đúng
    // Có thể gây duplicate entries hoặc không xóa items cũ

    // ✅ ĐÚNG: Modify collection in-place
    order.getItems().clear();        // Hibernate track việc clear
    order.getItems().addAll(newItems); // Hibernate track việc add
}
```

---

### Action Queue — Write-Behind Buffer

Hibernate không gửi SQL ngay khi bạn gọi `persist()`, `remove()`, hay thay đổi entity. Thay vào đó, nó queue các action lại và thực thi theo thứ tự tối ưu khi flush:

```
Thứ tự thực thi trong Action Queue khi flush:

1. OrphanRemoval (xóa orphan)
2. INSERT mới (theo dependency order — parent trước child)
3. UPDATE (dirty entities)
4. Collection removes
5. Collection recreates  
6. DELETE (theo dependency order ngược — child trước parent)
```

**Tại sao thứ tự này quan trọng:**

```java
@Transactional
public void demo() {
    // Code chạy theo thứ tự này:
    Department dept = new Department("Engineering");
    em.persist(dept);                    // → queue: INSERT dept

    User user = new User("Bach", dept);
    em.persist(user);                    // → queue: INSERT user

    Order order = new Order(user);
    em.persist(order);                   // → queue: INSERT order

    em.remove(oldOrder);                 // → queue: DELETE oldOrder

    // flush() thực thi theo dependency:
    // 1. INSERT dept (không phụ thuộc gì)
    // 2. INSERT user (cần dept.id)
    // 3. INSERT order (cần user.id)
    // 4. DELETE oldOrder
    // Nếu Hibernate đảo thứ tự → FK violation!
}
```

**`order_inserts = true` và `order_updates = true` trong JDBC batching** chính là để group các INSERT/UPDATE cùng loại lại, giúp JDBC batch chúng hiệu quả hơn.

---

### Thực Hành: Đọc Hiểu Session Internals

```java
@Transactional
public void inspectSessionState() {
    // Load một số entities
    User u1 = userRepo.findById(1L).orElseThrow();
    User u2 = userRepo.findById(2L).orElseThrow();

    // Thay đổi u1
    u1.setName("Modified");

    // Inspect Persistence Context
    Session session = em.unwrap(Session.class);
    SessionImplementor si = (SessionImplementor) session;
    StatefulPersistenceContext pc =
        (StatefulPersistenceContext) si.getPersistenceContext();

    // Số entity trong Identity Map
    int size = pc.getNumberOfManagedEntities();
    System.out.println("Entities in PC: " + size);  // 2

    // Check dirty entities (cần flush trước để Hibernate tính)
    int[] tableSpace = new int[1];
    boolean dirty = si.isDirty();
    System.out.println("Session is dirty: " + dirty);  // true vì u1 bị sửa

    // Xem action queue (qua Statistics)
    Statistics stats = sessionFactory.getStatistics();
    stats.clear();
    em.flush();
    System.out.println("Updates executed: " + stats.getEntityUpdateCount());  // 1
}
```

---

### Tổng Kết — Mental Model Hoàn Chỉnh

```
Khi @Transactional method chạy:

  em.find(User.class, 1L)
          │
          ├─ L1 Cache hit? ──► trả về instance có sẵn (không SELECT)
          │
          └─ L1 Cache miss?
                  │
                  ├─ L2 Cache hit? ──► hydrate entity từ L2, thêm vào L1
                  │
                  └─ L2 Cache miss?
                          │
                          ▼
                  SELECT từ DB
                          │
                          ▼
                  Tạo entity instance
                  Tạo snapshot (deep copy)
                  Thêm vào Identity Map
                  Lazy fields → tạo Proxy
                  Lazy collections → tạo PersistentBag/Set
                          │
                          ▼
                  entity ở trạng thái MANAGED

  Khi entity thay đổi:
  → currentState != snapshot → dirty → queue UPDATE khi flush

  Khi flush:
  → Dirty check toàn bộ Identity Map
  → Gửi Action Queue đến DB theo thứ tự
  → Update snapshots theo state mới

  Khi transaction kết thúc:
  → flush() (nếu FlushMode.AUTO/COMMIT)
  → commit/rollback JDBC connection
  → connection trả về pool
  → Session scope kết thúc → PC cleared → GC
```

---

*Tags: #hibernate #jpa #internals #persistence-context #dirty-checking #snapshot #proxy #memory*
