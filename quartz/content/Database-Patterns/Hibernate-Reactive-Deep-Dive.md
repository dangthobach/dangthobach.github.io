# Hibernate Reactive Deep Dive

> **Định nghĩa nhanh:** Hibernate Reactive = toàn bộ Hibernate ORM (Persistence Context, dirty checking, lazy loading, L1/L2 cache) — nhưng thay JDBC driver bằng **Vert.x SQL Client** để non-blocking I/O.
> **Không nhầm với:** Spring Data R2DBC — đây là stack hoàn toàn khác, không có ORM.

---

## 🏗️ Kiến Trúc Tổng Quan

```
                    Hibernate Reactive Stack
┌────────────────────────────────────────────────────────────────┐
│                   Application Code                              │
│              (Mutiny: Uni<T> / Multi<T>)                       │
└───────────────────────────┬────────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────────┐
│              Hibernate Reactive ORM                             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Persistence Context (vẫn giống Hibernate thuần)         │  │
│  │  ├── Identity Map (L1 Cache)                             │  │
│  │  ├── Snapshots (dirty checking)                          │  │
│  │  ├── Action Queue (write-behind)                         │  │
│  │  └── Proxy (lazy loading)                                │  │
│  └──────────────────────────────────────────────────────────┘  │
└───────────────────────────┬────────────────────────────────────┘
                            │ NON-BLOCKING
┌───────────────────────────▼────────────────────────────────────┐
│              Vert.x SQL Client                                  │
│  (reactive driver — không phải R2DBC spec)                     │
│  ├── PostgreSQL client: io.vertx:vertx-pg-client               │
│  ├── MySQL client: io.vertx:vertx-mysql-client                  │
│  └── Connection pool: Vert.x pool (không phải HikariCP)        │
└───────────────────────────┬────────────────────────────────────┘
                            │ TCP (non-blocking Netty)
┌───────────────────────────▼────────────────────────────────────┐
│                        PostgreSQL                               │
└────────────────────────────────────────────────────────────────┘

So sánh với Hibernate ORM thường:
  Hibernate ORM + JDBC:     [ORM] → [JDBC Driver] → [TCP blocking]
  Hibernate Reactive:       [ORM] → [Vert.x SQL]  → [TCP non-blocking]
  Spring Data R2DBC:        [Thin mapping] → [R2DBC Driver] → [TCP non-blocking]
                            ↑ KHÔNG có full ORM ở đây
```

**Tại sao Hibernate chọn Vert.x thay vì R2DBC?**

Đây là quyết định có chủ đích của Hibernate team: Vert.x SQL client trưởng thành hơn, performant hơn, và có feature set đầy đủ hơn hầu hết R2DBC implementations ở thời điểm Hibernate Reactive ra đời. Hai stack này **không interop** — Hibernate Reactive không dùng được R2DBC driver và ngược lại.

---

## 📦 Dependencies & Setup

### Quarkus (Recommended Path)

```xml
<!-- pom.xml -->
<dependency>
    <groupId>io.quarkus</groupId>
    <artifactId>quarkus-hibernate-reactive-panache</artifactId>
</dependency>
<dependency>
    <groupId>io.quarkus</groupId>
    <artifactId>quarkus-reactive-pg-client</artifactId>
</dependency>
```

```properties
# application.properties
quarkus.datasource.db-kind=postgresql
quarkus.datasource.username=postgres
quarkus.datasource.password=secret
quarkus.datasource.reactive.url=vertx-reactive:postgresql://localhost:5432/mydb

quarkus.hibernate-orm.database.generation=validate
quarkus.hibernate-orm.log.sql=true
```

### Spring Boot (Ít phổ biến hơn — có caveats)

```xml
<!-- Hibernate Reactive không có Spring Boot starter chính thức -->
<!-- Phải wire thủ công, không tích hợp native với Spring TX -->
<dependency>
    <groupId>org.hibernate.reactive</groupId>
    <artifactId>hibernate-reactive-core</artifactId>
    <version>2.4.x</version>
</dependency>
<dependency>
    <groupId>io.vertx</groupId>
    <artifactId>vertx-pg-client</artifactId>
</dependency>
```

> **Thực tế:** Hibernate Reactive được design cho Quarkus. Dùng với Spring Boot cần nhiều manual wiring và không được Spring Transaction Management support native. Nếu dùng Spring Boot và muốn reactive, Spring Data R2DBC phù hợp hơn.

---

## 🔑 Mutiny API — Uni và Multi

Hibernate Reactive trả về **Mutiny types** thay vì giá trị trực tiếp:

```
Uni<T>   = 0 hoặc 1 kết quả (tương đương Mono<T> trong Reactor)
Multi<T> = 0 đến N kết quả  (tương đương Flux<T> trong Reactor)
```

```java
// Thay vì (Hibernate ORM thuần):
User user = session.find(User.class, 1L);  // blocking, trả về trực tiếp

// Hibernate Reactive dùng:
Uni<User> userUni = session.find(User.class, 1L);  // non-blocking, trả về Uni
userUni.subscribe().with(
    user -> System.out.println(user.getName()),
    failure -> failure.printStackTrace()
);

// Hoặc chain:
Uni<String> name = session
    .find(User.class, 1L)
    .map(User::getName);
```

---

## 🧩 Session Management — Khác Biệt Quan Trọng

Trong Hibernate ORM thuần, Session được bound với thread (ThreadLocal). Trong Hibernate Reactive, **không có ThreadLocal** — session phải được explicit pass qua reactive chain:

```java
// ❌ Sẽ KHÔNG hoạt động trong Hibernate Reactive:
// Session gắn vào thread → reactive chain chạy trên nhiều thread
Session session = sessionFactory.getCurrentSession();

// ✅ Đúng: mở session explicit, pass qua chain
Mutiny.SessionFactory sf = entityManagerFactory
    .unwrap(Mutiny.SessionFactory.class);

sf.withSession(session ->
    session.find(User.class, 1L)
        .chain(user -> {
            user.setName("Updated");
            return session.flush();  // explicit flush
        })
).subscribe().with(
    v -> log.info("Done"),
    e -> log.error("Failed", e)
);
```

### withSession vs withTransaction

```java
// withSession: mở session, KHÔNG tự bắt đầu transaction
sf.withSession(session ->
    session.find(User.class, 1L)  // read-only, không cần transaction
);

// withTransaction: mở session + bắt đầu transaction + tự commit/rollback
sf.withTransaction((session, tx) ->
    session.find(User.class, 1L)
        .chain(user -> {
            user.setName("New Name");
            return Uni.createFrom().voidItem();
            // flush tự động khi transaction commit
        })
);
```

---

## 🦴 Panache — Hibernate Reactive Với DX Tốt Hơn

Quarkus Panache là layer abstraction trên Hibernate Reactive, giảm boilerplate đáng kể:

### Active Record Pattern

```java
@Entity
public class User extends PanacheEntityBase {
    @Id
    @GeneratedValue
    public Long id;

    public String name;
    public String email;

    // Static finder methods — Panache inject implementation
    public static Uni<User> findByEmail(String email) {
        return find("email", email).firstResult();
    }

    public static Uni<List<User>> findActiveUsers() {
        return list("status", Status.ACTIVE);
    }
}

// Usage:
User.findByEmail("bach@vpbank.com")
    .onItem().ifNull().failWith(() -> new NotFoundException("User not found"))
    .chain(user -> {
        user.name = "Bach Updated";
        return user.persist();  // persist() là non-blocking Uni<Void>
    });
```

### Repository Pattern

```java
@ApplicationScoped
public class UserRepository implements PanacheRepositoryBase<User, Long> {
    public Uni<User> findByEmail(String email) {
        return find("email", email).firstResult();
    }

    public Uni<Long> countActiveUsers() {
        return count("status", Status.ACTIVE);
    }
}

// Inject và dùng:
@Inject
UserRepository userRepo;

userRepo.findByEmail("bach@vpbank.com")
    .chain(user -> userRepo.persist(user));
```

---

## 🔁 Lazy Loading Trong Reactive Context

Lazy loading vẫn hoạt động — nhưng phải explicit trong reactive chain:

```java
// ❌ Trigger lazy load ngoài session context → LazyInitializationException
sf.withSession(session -> session.find(Order.class, 1L))
    .subscribe().with(order -> {
        // Session đã đóng!
        order.getItems().size();  // 💥 LazyInitializationException
    });

// ✅ Load trong session context
sf.withSession(session ->
    session.find(Order.class, 1L)
        .chain(order ->
            // fetch() là cách Hibernate Reactive trigger lazy load
            Mutiny.fetch(order.getItems())
                .map(items -> {
                    // items đã loaded
                    return new OrderDto(order, items);
                })
        )
);

// ✅ Hoặc dùng JOIN FETCH trong query
sf.withSession(session ->
    session.createQuery(
        "SELECT DISTINCT o FROM Order o JOIN FETCH o.items WHERE o.id = :id",
        Order.class
    )
    .setParameter("id", 1L)
    .getSingleResult()
);
```

---

## ⚡ Transaction Reactive — Cơ Chế

```java
sf.withTransaction((session, transaction) -> {
    // transaction bắt đầu
    return session.find(Product.class, productId)
        .chain(product -> {
            product.setStock(product.getStock() - quantity);
            // Hibernate Reactive dirty check vẫn hoạt động!
            return Uni.createFrom().voidItem();
        });
    // transaction tự commit khi Uni complete
    // transaction tự rollback nếu Uni fail
});
```

**Rollback explicit:**

```java
sf.withTransaction((session, tx) ->
    session.find(Product.class, productId)
        .chain(product -> {
            if (product.getStock() < quantity) {
                return tx.markForRollback()  // đánh dấu rollback
                    .replaceWithVoid()
                    .replaceWith(Uni.createFrom()
                        .failure(new InsufficientStockException()));
            }
            product.setStock(product.getStock() - quantity);
            return Uni.createFrom().voidItem();
        })
);
```

---

## 🔍 Query — JPQL và Native

```java
// JPQL — giống Hibernate ORM thuần
sf.withSession(session ->
    session.createQuery(
        "FROM Product p WHERE p.category = :cat AND p.price < :maxPrice",
        Product.class
    )
    .setParameter("cat", "Electronics")
    .setParameter("maxPrice", BigDecimal.valueOf(1000))
    .getResultList()  // trả về Uni<List<Product>>
);

// Native SQL
sf.withSession(session ->
    session.createNativeQuery(
        "SELECT * FROM products WHERE tsv @@ to_tsquery(:query)",
        Product.class
    )
    .setParameter("query", "laptop & gaming")
    .getResultList()
);

// Mutiny chain sau query
sf.withSession(session ->
    session.createQuery("FROM User WHERE active = true", User.class)
        .getResultList()
)
.onItem().transform(users ->
    users.stream().map(UserDto::from).toList()
)
.subscribe().with(
    dtos -> response.complete(dtos),
    failure -> response.fail(failure)
);
```

---

## 📊 L1 Cache Và Dirty Checking Trong Reactive

Persistence Context vẫn hoạt động đầy đủ — identity map, snapshot, dirty check — chỉ khác là không bind vào thread mà bind vào session object:

```java
sf.withSession(session ->
    session.find(User.class, 1L)
        .chain(u1 ->
            session.find(User.class, 1L)  // L1 cache hit! Không query DB
                .map(u2 -> {
                    assert u1 == u2;  // SAME instance (identity map)
                    return u2;
                })
        )
        .chain(user -> {
            user.setName("Changed");  // dirty — snapshot khác currentState
            return session.flush();   // dirty check chạy → UPDATE
        })
);
```

---

## ⚠️ Limitations & Gotchas

```
1. Spring integration không native
   → Không dùng được @Transactional của Spring
   → Phải dùng withTransaction() explicit

2. Chỉ mature trên Quarkus
   → Quarkus có CDI integration, health check, metrics
   → Spring Boot cần manual wiring

3. Không dùng được với Spring Data JPA repositories
   → Phải dùng Panache hoặc raw session API

4. Debug khó hơn Hibernate ORM thuần
   → Mutiny chain không có stack trace rõ ràng như blocking code

5. Ít community resources hơn
   → Hibernate Reactive ~2020, còn non-mainstream
   → Stackoverflow answers ít hơn nhiều so với Hibernate ORM

6. Driver limitation
   → Dùng Vert.x driver, không phải standard JDBC
   → Một số JDBC feature/dialect không available
```

---

## 🆚 So Sánh Với Spring Data R2DBC

| Tiêu chí | Hibernate Reactive | Spring Data R2DBC |
|----------|-------------------|-------------------|
| **ORM** | ✅ Full (PC, dirty check, lazy) | ❌ Chỉ simple mapping |
| **Lazy Loading** | ✅ `Mutiny.fetch()` | ❌ Không có |
| **Dirty Checking** | ✅ Tự động | ❌ Phải save() explicit |
| **L1/L2 Cache** | ✅ | ❌ |
| **Spring Integration** | ⚠️ Không native | ✅ Native |
| **Spring TX** | ❌ Không dùng được | ✅ `@Transactional` reactive |
| **Repository support** | Panache (Quarkus) | ✅ Spring Data style |
| **Driver** | Vert.x SQL Client | R2DBC Drivers |
| **Best with** | Quarkus | Spring Boot WebFlux |
| **Learning curve** | Cao (ORM + Reactive + Mutiny) | Cao (Reactive, nhưng ít ORM) |

---

## 🎯 Khi Nào Nên Dùng Hibernate Reactive

```
✅ Dùng Hibernate Reactive khi:
  - Đang dùng Quarkus (native integration)
  - Cần full ORM features (lazy loading, dirty checking, L2 cache)
  - Ứng dụng đã có nhiều Hibernate entities, muốn reactive mà không rewrite
  - Team quen Hibernate, không muốn học Spring Data R2DBC

❌ Không nên dùng khi:
  - Đang dùng Spring Boot (dùng Spring Data R2DBC thay)
  - Team chưa quen cả ORM lẫn reactive (quá nhiều thứ học cùng lúc)
  - Simple CRUD không cần lazy loading (Spring Data R2DBC đơn giản hơn)
  - Production system cần stability và community support rộng
```

---

## 🔗 Liên Quan

- [[00-Hub-Database-Persistence]] — Tổng quan ecosystem
- [[Spring-Data-R2DBC-Deep-Dive]] — Alternative reactive không có ORM
- [[JDBC-vs-R2DBC-vs-VirtualThreads]] — So sánh 3 concurrency model
- [[Hibernate-Performance-Deep-Dive]] — Hibernate ORM internals (blocking)

---

*Tags: #hibernate-reactive #reactive #mutiny #quarkus #panache #vert-x #non-blocking #orm*
