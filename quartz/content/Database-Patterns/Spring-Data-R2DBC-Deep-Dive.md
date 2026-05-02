# Spring Data R2DBC Deep Dive

> **Định nghĩa nhanh:** Spring Data R2DBC = Spring Data repository pattern + R2DBC reactive driver — **KHÔNG có ORM**, không có Persistence Context, không có lazy loading, không có dirty checking.
> **Đây là tư tưởng thiết kế có chủ đích** — R2DBC chọn simplicity over magic.

---

## 🏗️ Kiến Trúc Tổng Quan

```
                    Spring Data R2DBC Stack
┌────────────────────────────────────────────────────────────────┐
│                   Application Code                              │
│        (Reactor: Mono<T> / Flux<T>)                            │
└───────────────────────────┬────────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────────┐
│             Spring Data R2DBC                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  R2dbcEntityTemplate (low-level API)                     │  │
│  │  ReactiveCrudRepository (repository abstraction)         │  │
│  │  DatabaseClient (raw SQL reactive)                       │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ⚠️ KHÔNG CÓ:                                                  │
│  ✗ Persistence Context / Identity Map                           │
│  ✗ Dirty Checking / Snapshot                                    │
│  ✗ Lazy Loading / Proxy                                         │
│  ✗ L1 / L2 Cache                                               │
│  ✗ Cascade                                                      │
│  ✗ @OneToMany / @ManyToOne relationship loading                 │
└───────────────────────────┬────────────────────────────────────┘
                            │ NON-BLOCKING
┌───────────────────────────▼────────────────────────────────────┐
│              R2DBC Driver (theo DB)                             │
│  ├── PostgreSQL: r2dbc-postgresql                               │
│  ├── MySQL:      r2dbc-mysql                                    │
│  ├── MSSQL:      r2dbc-mssql                                    │
│  └── H2:         r2dbc-h2 (testing)                            │
└───────────────────────────┬────────────────────────────────────┘
                            │ TCP (Netty non-blocking)
┌───────────────────────────▼────────────────────────────────────┐
│                        Database                                  │
└────────────────────────────────────────────────────────────────┘
```

**Triết lý thiết kế của R2DBC:**

```
Hibernate ORM:  "Tôi quản lý object graph cho bạn.
                 Thay đổi entity → tôi biết → tôi sync với DB."
                 → Stateful, magic, powerful

Spring Data R2DBC: "Tôi chỉ map SQL result thành object.
                    Bạn muốn save? Gọi save() explicit.
                    Bạn muốn load relationship? Viết query rõ ràng."
                   → Stateless, explicit, predictable
```

---

## 📦 Dependencies & Setup

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-r2dbc</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-webflux</artifactId>
</dependency>

<!-- PostgreSQL R2DBC driver -->
<dependency>
    <groupId>org.postgresql</groupId>
    <artifactId>r2dbc-postgresql</artifactId>
</dependency>

<!-- Connection pooling -->
<dependency>
    <groupId>io.r2dbc</groupId>
    <artifactId>r2dbc-pool</artifactId>
</dependency>
```

```yaml
# application.yml
spring:
  r2dbc:
    url: r2dbc:postgresql://localhost:5432/mydb
    username: postgres
    password: secret
    pool:
      initial-size: 5
      max-size: 20
      max-idle-time: 10m
      validation-query: SELECT 1

  # Quan trọng: tắt JDBC DataSource autoconfigure
  autoconfigure:
    exclude:
      - org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration
```

---

## 🗃️ Entity Mapping — Đơn Giản Hơn JPA

```java
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Column;
import org.springframework.data.relational.core.mapping.Table;

@Table("products")  // Spring Data R2DBC annotation, KHÔNG phải JPA
public class Product {
    @Id  // Spring Data annotation (org.springframework.data.annotation.Id)
    private Long id;

    @Column("product_name")
    private String name;

    private BigDecimal price;

    @Column("category_id")
    private Long categoryId;  // ← Chỉ lưu FK, KHÔNG phải @ManyToOne Category

    // Không có @OneToMany, @ManyToOne, @FetchType, @Cascade
    // Không có @Version (optimistic lock khác cách)
    // Không có @Transient, @Embedded (support hạn chế)
}
```

**Vấn đề relationship — R2DBC không auto-load:**

```java
// ❌ R2DBC KHÔNG hỗ trợ:
@OneToMany  // annotation này không tồn tại trong Spring Data R2DBC
private List<OrderItem> items;

// ✅ Phải handle manually:
public class Order {
    @Id
    private Long id;
    private String status;
    // items KHÔNG có ở đây — phải query riêng
}

// Load order + items:
public Mono<OrderWithItems> getOrderWithItems(Long orderId) {
    return orderRepo.findById(orderId)
        .zipWith(
            orderItemRepo.findByOrderId(orderId).collectList()
        )
        .map(tuple -> new OrderWithItems(tuple.getT1(), tuple.getT2()));
}
```

---

## 📚 3 Lớp API — Từ Cao Đến Thấp

### Lớp 1: ReactiveCrudRepository (Cao nhất — Nên dùng đầu tiên)

```java
@Repository
public interface ProductRepository extends ReactiveCrudRepository<Product, Long> {
    // Spring Data tự generate query từ method name
    Flux<Product> findByCategory(String category);
    Mono<Long> countByCategory(String category);
    Flux<Product> findByPriceLessThanOrderByPriceAsc(BigDecimal maxPrice);

    // Custom JPQL-like query
    @Query("SELECT * FROM products WHERE price BETWEEN :min AND :max AND category = :cat")
    Flux<Product> findInPriceRange(BigDecimal min, BigDecimal max, String cat);

    // Modifying query
    @Modifying
    @Query("UPDATE products SET stock = stock - :qty WHERE id = :id AND stock >= :qty")
    Mono<Integer> decrementStock(Long id, int qty);
    // Trả về Mono<Integer> = số rows affected
}
```

```java
// Sử dụng:
@Service
@RequiredArgsConstructor
public class ProductService {
    private final ProductRepository productRepo;

    public Flux<Product> getByCategory(String category) {
        return productRepo.findByCategory(category);
    }

    public Mono<Product> create(CreateProductRequest req) {
        Product p = new Product(req.getName(), req.getPrice());
        return productRepo.save(p);
        // save() = INSERT nếu id null, UPDATE nếu id có giá trị
    }

    public Mono<Product> update(Long id, UpdateProductRequest req) {
        return productRepo.findById(id)
            .switchIfEmpty(Mono.error(new NotFoundException("Product " + id)))
            .flatMap(product -> {
                product.setName(req.getName());
                product.setPrice(req.getPrice());
                return productRepo.save(product);  // explicit save — không có dirty check!
            });
    }
}
```

---

### Lớp 2: R2dbcEntityTemplate (Middle — Khi cần query linh hoạt hơn)

```java
@Service
@RequiredArgsConstructor
public class ProductSearchService {
    private final R2dbcEntityTemplate template;

    public Flux<Product> search(ProductFilter filter) {
        Criteria criteria = Criteria.empty();

        if (filter.getName() != null) {
            criteria = criteria.and("name").like("%" + filter.getName() + "%");
        }
        if (filter.getMinPrice() != null) {
            criteria = criteria.and("price").greaterThanOrEquals(filter.getMinPrice());
        }
        if (filter.getCategoryId() != null) {
            criteria = criteria.and("category_id").is(filter.getCategoryId());
        }

        return template.select(Product.class)
            .matching(Query.query(criteria).limit(filter.getLimit()))
            .all();
    }

    public Mono<Long> countByCriteria(Criteria criteria) {
        return template.count(Query.query(criteria), Product.class);
    }

    // Insert, update, delete:
    public Mono<Product> upsert(Product product) {
        return template.insert(product);  // hoặc template.update(product)
    }
}
```

---

### Lớp 3: DatabaseClient (Thấp nhất — Raw SQL reactive)

```java
@Service
@RequiredArgsConstructor
public class ReportService {
    private final DatabaseClient dbClient;

    // Complex query không thể express qua repository
    public Flux<SalesReport> getMonthlySalesReport(int year) {
        return dbClient.sql("""
                SELECT
                    DATE_TRUNC('month', o.created_at) AS month,
                    COUNT(o.id)                        AS order_count,
                    SUM(o.total_amount)                AS total_revenue,
                    AVG(o.total_amount)                AS avg_order_value,
                    COUNT(DISTINCT o.user_id)          AS unique_customers
                FROM orders o
                WHERE EXTRACT(YEAR FROM o.created_at) = :year
                  AND o.status = 'COMPLETED'
                GROUP BY DATE_TRUNC('month', o.created_at)
                ORDER BY month ASC
                """)
            .bind("year", year)
            .map((row, metadata) -> SalesReport.builder()
                .month(row.get("month", LocalDate.class))
                .orderCount(row.get("order_count", Long.class))
                .totalRevenue(row.get("total_revenue", BigDecimal.class))
                .avgOrderValue(row.get("avg_order_value", BigDecimal.class))
                .uniqueCustomers(row.get("unique_customers", Long.class))
                .build()
            )
            .all();
    }

    // Stored procedure
    public Mono<Void> callMigrationProc(Long batchId) {
        return dbClient.sql("CALL run_migration_batch(:batchId)")
            .bind("batchId", batchId)
            .then();
    }
}
```

---

## 🔄 Transaction Reactive — Cách Dùng Đúng

### @Transactional Với WebFlux

```java
@Service
public class OrderService {

    // ✅ @Transactional hoạt động với Spring WebFlux + R2DBC
    @Transactional
    public Mono<Order> placeOrder(PlaceOrderRequest req) {
        return productRepo.findById(req.getProductId())
            .switchIfEmpty(Mono.error(new NotFoundException("Product not found")))
            .flatMap(product -> {
                if (product.getStock() < req.getQuantity()) {
                    return Mono.error(new InsufficientStockException());
                    // exception → transaction tự rollback
                }
                product.setStock(product.getStock() - req.getQuantity());
                return productRepo.save(product)  // explicit save!
                    .flatMap(savedProduct -> {
                        Order order = new Order(req.getUserId(), savedProduct.getId(), req.getQuantity());
                        return orderRepo.save(order);
                    });
            });
    }
}
```

**Cơ chế transaction reactive:**

```
R2DBC Transaction = connection-scoped

subscribe() trigger:
    │
    ▼
Spring intercept @Transactional
    │
    ▼
R2DBC connection.beginTransaction()  ← async
    │
    ▼
Reactive chain chạy (Mono/Flux operations)
    │
    ├── chain complete → connection.commitTransaction()  ← async
    └── chain error   → connection.rollbackTransaction() ← async

Connection context được lưu trong Reactor Context
(không dùng ThreadLocal như Spring MVC)
```

**Reactor Context — cách Spring propagate transaction:**

```java
// Spring tự động inject transaction connection vào Reactor Context
// Không cần làm gì thêm nếu dùng @Transactional đúng cách

// ⚠️ Gotcha: đừng switch sang thread khác trong transaction chain
@Transactional
public Mono<Order> placeOrder(PlaceOrderRequest req) {
    return productRepo.findById(req.getProductId())
        .publishOn(Schedulers.boundedElastic())  // ❌ NGUY HIỂM!
        // publishOn switch thread → mất Reactor Context → mất transaction
        .flatMap(product -> orderRepo.save(new Order()));
}
```

### TransactionalOperator — Transaction Programmatic

```java
@Service
@RequiredArgsConstructor
public class BulkOrderService {
    private final TransactionalOperator txOperator;
    private final OrderRepository orderRepo;

    public Flux<Order> processBulkOrders(List<OrderRequest> requests) {
        return Flux.fromIterable(requests)
            .flatMap(req -> orderRepo.save(new Order(req)))
            .as(txOperator::transactional);  // wrap toàn bộ Flux trong 1 transaction
    }
}
```

---

## 📡 Streaming Data — Use Case Thực Sự Của R2DBC

Đây là nơi R2DBC tỏa sáng — stream lượng lớn data mà không load tất cả vào memory:

```java
@GetMapping(value = "/export/orders", produces = MediaType.APPLICATION_NDJSON_VALUE)
public Flux<Order> exportOrders(@RequestParam String status) {
    return orderRepo.findByStatus(status);
    // R2DBC stream từng row lên client qua HTTP
    // Không load tất cả vào memory
    // Backpressure: client đọc chậm → DB fetch chậm → không OOM
}

// Server-Sent Events
@GetMapping(value = "/stream/new-orders", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public Flux<ServerSentEvent<Order>> streamNewOrders() {
    return orderRepo
        .findByStatusAndCreatedAtAfter(Status.NEW, Instant.now())
        .map(order -> ServerSentEvent.builder(order).build())
        .delayElements(Duration.ofSeconds(1));
}
```

---

## 🏎️ Performance Tips Cho R2DBC

### Connection Pool Sizing

```yaml
spring:
  r2dbc:
    pool:
      initial-size: 5
      max-size: 20           # KHÔNG set quá cao — DB có connection limit
      max-idle-time: 10m
      max-acquire-time: 3s   # timeout khi pool exhausted
      max-create-connection-time: 5s
      validation-query: SELECT 1
```

```
Rule of thumb cho max-size:
  max-size ≤ DB_max_connections / num_app_instances
  VD: PostgreSQL 100 connections, 4 instances → max-size = 25

Không set hàng nghìn dù "R2DBC không block thread"
→ DB vẫn có connection limit
→ Mỗi connection vẫn dùng memory trên PostgreSQL (~10MB/connection)
```

### Batch Insert Không Có ORM

```java
// ❌ Chậm: lần lượt insert từng record
Flux.fromIterable(products)
    .flatMap(p -> productRepo.save(p))  // sequential saves
    .subscribe();

// ✅ Batch insert với DatabaseClient
public Mono<Void> batchInsert(List<Product> products) {
    return dbClient.inConnectionMany(connection -> {
        Batch batch = connection.createBatch();
        products.forEach(p ->
            batch.add("INSERT INTO products(name, price, category_id) VALUES ($1, $2, $3)")
        );
        // Bind parameters
        return Flux.fromIterable(products)
            .index()
            .flatMap(indexed -> {
                // bind parameters per statement
                return Flux.from(batch.execute());
            });
    }).then();
}

// ✅ Hoặc dùng saveAll() — Spring Data batch internally
productRepo.saveAll(products)  // Spring Data R2DBC gom thành batch
    .then()
    .subscribe();
```

### Fetch Size

```java
// DatabaseClient hỗ trợ fetchSize để streaming:
dbClient.sql("SELECT * FROM large_table")
    .filter(statement -> statement.fetchSize(100))  // fetch 100 rows at a time
    .map(...)
    .all();
```

---

## ⚠️ Những Gì R2DBC KHÔNG Có — Và Phải Tự Xử Lý

### 1. Không Có Dirty Checking → Phải Explicit Save

```java
// ❌ Pattern sai (quen từ JPA):
@Transactional
public Mono<Void> update(Long id, String newName) {
    return productRepo.findById(id)
        .doOnNext(p -> p.setName(newName))
        .then();  // Không save → KHÔNG có gì được update!
}

// ✅ Đúng với R2DBC:
@Transactional
public Mono<Product> update(Long id, String newName) {
    return productRepo.findById(id)
        .flatMap(p -> {
            p.setName(newName);
            return productRepo.save(p);  // Bắt buộc phải save explicit
        });
}
```

### 2. Không Có Cascade → Phải Handle Manually

```java
// ❌ Không có:
@Cascade(CascadeType.ALL)
// Không tồn tại trong Spring Data R2DBC

// ✅ Phải xử lý thủ công:
@Transactional
public Mono<Void> deleteOrderWithItems(Long orderId) {
    return orderItemRepo.deleteByOrderId(orderId)  // xóa items trước
        .then(orderRepo.deleteById(orderId));        // rồi mới xóa order
}
```

### 3. Không Có Lazy Loading → Phải Load Explicit

```java
// ❌ Không thể:
order.getItems()  // không có lazy proxy

// ✅ Phải load từng cái một hoặc dùng JOIN query:
public Mono<OrderWithItems> getOrderWithItems(Long orderId) {
    return Mono.zip(
        orderRepo.findById(orderId),
        orderItemRepo.findByOrderId(orderId).collectList()
    ).map(tuple -> new OrderWithItems(tuple.getT1(), tuple.getT2()));
}

// Hoặc native JOIN query:
public Mono<OrderWithItems> getOrderWithItemsJoin(Long orderId) {
    return dbClient.sql("""
        SELECT o.*, i.id as item_id, i.product_id, i.quantity
        FROM orders o
        LEFT JOIN order_items i ON i.order_id = o.id
        WHERE o.id = :orderId
        """)
        .bind("orderId", orderId)
        .map(this::mapToOrderWithItems)
        .all()
        .collectList()
        .map(this::aggregateRows);
}
```

### 4. Không Có L1 Cache → Mỗi findById Là Một Query

```java
// Cùng session Hibernate ORM:
product1 = repo.findById(1L);  // SELECT
product2 = repo.findById(1L);  // L1 cache hit — không SELECT
product1 == product2;  // true

// Spring Data R2DBC:
productRepo.findById(1L)  // SELECT
productRepo.findById(1L)  // SELECT lại! Không có cache
// → Kết quả là 2 object khác nhau
```

### 5. Optimistic Locking — Khác Cách

```java
// JPA dùng @Version (Hibernate tự quản lý)
// R2DBC phải dùng @Version của Spring Data:

import org.springframework.data.annotation.Version;

public class Product {
    @Id
    private Long id;

    @Version  // Spring Data R2DBC annotation — tự increment khi update
    private Long version;

    private String name;
}

// Spring Data R2DBC tự sinh:
// UPDATE products SET name=?, version=2 WHERE id=? AND version=1
// Nếu 0 rows → throw OptimisticLockingFailureException
```

---

## 🎯 Khi Nào Nên Dùng Spring Data R2DBC

```
✅ Dùng Spring Data R2DBC khi:
  - Đang build với Spring WebFlux stack
  - Service cần streaming / SSE / WebSocket
  - High throughput read service, không cần complex ORM
  - Simple domain — không cần lazy loading, cascade, dirty check
  - Team đã quen reactive programming
  - Muốn keep Spring ecosystem (Spring Security, Spring Cloud)

❌ Không nên dùng khi:
  - Cần lazy loading của related entities
  - Domain phức tạp với nhiều relationships cần navigate
  - Team chưa quen reactive — learning curve rất cao
  - Service chủ yếu là CRUD đơn giản — overkill, Virtual Threads đơn giản hơn
  - Cần full audit (dirty checking rất tiện cho audit)
  - Banking/Finance domain — transaction tracing khó hơn với reactive stack
```

---

## 🆚 Chọn Giữa Spring Data R2DBC và Hibernate Reactive

```
Dùng Spring Data R2DBC khi:
  → Spring Boot ecosystem
  → Không cần lazy loading
  → Simple domain model
  → Đã quen Spring Data pattern
  → WebFlux native integration quan trọng

Dùng Hibernate Reactive khi:
  → Quarkus ecosystem
  → Cần full ORM (lazy load, dirty check, L2 cache)
  → Đã có nhiều Hibernate entities, muốn giữ nguyên
  → Cần Panache DX
```

---

## 🔗 Liên Quan

- [[00-Hub-Database-Persistence]] — Tổng quan ecosystem
- [[Hibernate-Reactive-Deep-Dive]] — Alternative reactive có full ORM
- [[JDBC-vs-R2DBC-vs-VirtualThreads]] — So sánh 3 concurrency model
- [[Hibernate-Performance-Deep-Dive]] — Hibernate ORM internals (blocking)

---

*Tags: #r2dbc #spring-data-r2dbc #reactive #webflux #non-blocking #database #mono #flux*
