---
tags: [java, concurrency, virtual-threads, loom, reactive, architecture-decision]
created: 2026-04-14
status: evergreen
links: [MOC-Concurrency, MOC-JVM-Frameworks, ADR-002-Project-Loom-vs-Reactive-for-PDMS]
---

# ⚡ Project Loom Deep Dive — Virtual Threads vs Reactive

> **Câu hỏi trung tâm:** Virtual Threads (Project Loom) có "giết chết" Reactive Programming (Mutiny/Reactor) không? Câu trả lời không phải yes/no — mà là **"phụ thuộc vào bài toán nào"**, và hiểu rõ cơ chế của cả hai mới ra được quyết định đúng.

---

## 🧠 Hai mô hình giải quyết cùng một vấn đề

**Vấn đề gốc:** Thread-per-request model không scale — OS thread tốn ~1MB RAM, context switch đắt, 10K concurrent requests = 10K threads = hệ thống chết.

```
Giải pháp A — Reactive (2013+):
  Giảm số thread bằng cách KHÔNG BLOCK thread
  → Event loop + async callbacks + non-blocking I/O
  → 8 threads xử lý 10K concurrent requests
  → Nhược điểm: code phức tạp, callback hell, stack trace vô nghĩa

Giải pháp B — Virtual Threads / Project Loom (Java 21, 2023):
  Giảm COST của thread thay vì giảm số thread
  → Virtual thread: ~KB overhead, mount/unmount khi block I/O
  → Viết code blocking như cũ, JVM lo phần còn lại
  → Nhược điểm: không có backpressure built-in, một số edge cases
```

---

## 1️⃣ Virtual Threads — Cơ chế hoạt động

### Stack Frame vs Heap Continuation

```
Platform Thread (OS Thread):
┌────────────────────────────────┐
│  OS Stack: ~1MB fixed          │  ← cấp phát ngay khi tạo
│  Call stack: cố định trên OS   │
│  Context switch: OS scheduler  │  ← expensive ~microseconds
└────────────────────────────────┘

Virtual Thread:
┌────────────────────────────────┐
│  Continuation object: ~KB      │  ← cấp phát trên JVM heap
│  Call stack: stored in heap    │  ← khi unmounted
│  Scheduler: JVM ForkJoinPool   │  ← cheap cooperative switch
│  Carrier thread: OS thread     │  ← thật sự chạy code
└────────────────────────────────┘
```

### Mount / Unmount lifecycle

```java
// Khi bạn viết code blocking "ngây thơ":
public UserProfile getProfile(Long userId) {
    User user = userRepo.findById(userId);    // JDBC blocking call
    return buildProfile(user);
}

// Điều gì xảy ra bên dưới với Virtual Thread:
// 1. Virtual Thread đang chạy trên Carrier Thread #1
// 2. JDBC call → I/O wait bắt đầu
// 3. JVM: UNMOUNT virtual thread (lưu stack vào heap)
// 4. Carrier Thread #1: FREE → pickup virtual thread khác
// 5. I/O response đến
// 6. JVM: MOUNT lại virtual thread lên một Carrier Thread (có thể là #2)
// 7. Resume từ đúng dòng code đang chờ
// 8. User thấy: code bình thường, không async, không callback
```

### Bật Virtual Threads trong Spring Boot 3.2+

```yaml
# application.yaml
spring:
  threads:
    virtual:
      enabled: true   # Tomcat + @Async + TaskExecutor đều dùng VT
```

```java
// Hoặc tự cấu hình executor
@Bean
public AsyncTaskExecutor applicationTaskExecutor() {
    return new TaskExecutorAdapter(
        Executors.newVirtualThreadPerTaskExecutor()
    );
}

// Tạo Virtual Thread manually
Thread.ofVirtual()
    .name("document-processor-", 0)
    .start(() -> processDocument(doc));

// Với Structured Concurrency (Java 21 preview, Java 23 stable):
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    Future<User>   userFuture   = scope.fork(() -> fetchUser(id));
    Future<Orders> ordersFuture = scope.fork(() -> fetchOrders(id));
    
    scope.join().throwIfFailed();  // chờ cả hai, fail fast nếu một cái fail
    
    return new UserProfile(userFuture.get(), ordersFuture.get());
}
// → scope đóng → tất cả child threads bị cancel → không leak
```

---

## 2️⃣ Reactive — Cơ chế hoạt động (recap)

```java
// Reactive: explicit async composition
public Mono<UserProfile> getProfile(Long userId) {
    return Mono.zip(
        userRepo.findById(userId),       // Mono<User>
        orderRepo.findByUser(userId)     // Mono<Orders>
    ).map(tuple -> buildProfile(tuple.getT1(), tuple.getT2()));
}

// Bên dưới:
// 1. subscribe() → trigger execution
// 2. findById() → non-blocking DB call trên event loop
// 3. findByUser() → chạy song song cùng lúc (Mono.zip)
// 4. Cả hai complete → map() → onNext(profile)
// 5. Không thread nào bị block
```

---

## 3️⃣ So sánh trực tiếp

### Performance

```
Benchmark: 10,000 concurrent requests, mỗi request làm 3 DB calls (50ms/call)

Platform Threads (cũ):
  - Cần: 10,000 threads × 1MB = ~10GB RAM
  - Thực tế: thread pool giới hạn 200 → queue up → high latency

Reactive (Reactor/Mutiny):
  - Threads: 8 (event loop = CPU cores)
  - RAM: < 100MB thread overhead
  - Throughput: Xuất sắc
  - Latency: Thấp
  - Code complexity: CAO

Virtual Threads (Loom):
  - Threads: 10,000 virtual threads, 8 carrier threads
  - RAM: ~KB per VT → tổng < 100MB
  - Throughput: Xuất sắc (gần bằng Reactive)
  - Latency: Thấp
  - Code complexity: THẤP (code như blocking)
```

| Tiêu chí | Platform Thread | Reactive | Virtual Thread |
|----------|----------------|----------|---------------|
| RAM per concurrent task | ~1MB | ~KB (event, không per task) | ~KB |
| Throughput (I/O-bound) | ❌ Thấp | ✅ Xuất sắc | ✅ Xuất sắc |
| Throughput (CPU-bound) | ✅ Tốt | ❌ Không giúp | ✅ Tốt |
| Code complexity | ✅ Đơn giản | ❌ Cao | ✅ Đơn giản |
| Stack trace readability | ✅ Rõ ràng | ❌ Operator chain | ✅ Rõ ràng |
| Backpressure | ❌ Không có | ✅ Built-in | ❌ Cần implement thủ công |
| Structured concurrency | ⚠️ Manual | ⚠️ Operator-based | ✅ `StructuredTaskScope` |
| Debug experience | ✅ | ❌ Khó | ✅ |
| ThreadLocal compatibility | ✅ | ❌ Không tương thích | ✅ (có ScopedValue thay thế) |
| Library compatibility | ✅ Mọi thứ | ❌ Cần reactive drivers | ✅ Mọi library blocking đều work |

### Code so sánh: Cùng một task

```java
// Task: Fetch user + orders song song, tạo report

// ── Reactive (Mutiny) ──────────────────────────────────────
public Uni<Report> generateReport(Long userId) {
    return Uni.combine().all()
        .unis(
            userRepo.findById(userId),      // Uni<User>
            orderRepo.findByUser(userId)    // Uni<List<Order>>
        )
        .asTuple()
        .flatMap(tuple -> {
            User user = tuple.getItem1();
            List<Order> orders = tuple.getItem2();
            return reportService.build(user, orders);  // Uni<Report>
        })
        .onFailure().recoverWithItem(err -> {
            log.error("Report failed for user {}", userId, err);
            return Report.empty();
        });
}
// Ưu điểm: backpressure, lazy execution, operator composition
// Nhược điểm: phải wrap mọi thứ trong Uni/Multi, khó đọc với người mới

// ── Virtual Threads + Structured Concurrency ──────────────
public Report generateReport(Long userId) throws Exception {
    try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
        Future<User>        userFuture   = scope.fork(() -> userRepo.findById(userId));
        Future<List<Order>> ordersFuture = scope.fork(() -> orderRepo.findByUser(userId));
        
        scope.join().throwIfFailed();
        
        return reportService.build(userFuture.get(), ordersFuture.get());
        
    } catch (Exception e) {
        log.error("Report failed for user {}", userId, e);
        return Report.empty();
    }
}
// Ưu điểm: code bình thường, stack trace rõ ràng, dễ debug
// Nhược điểm: không có backpressure, throwIfFailed() chỉ propagate first error
```

---

## 4️⃣ Khi nào Virtual Threads KHÔNG thay được Reactive

### Case 1: Backpressure — Consumer chậm hơn Producer

```java
// Kafka consumer: producer gửi 100K msg/s, consumer xử lý được 10K msg/s
// → Cần backpressure để không OOM

// ✅ Reactive tự xử lý:
@Incoming("document-events")
public Multi<Void> processDocumentEvent(Multi<DocumentEvent> events) {
    return events
        .select().first(1000)              // lấy batch
        .onItem().transformToUniAndMerge(  // parallel với giới hạn
            event -> processEvent(event),
            mergeDepth = 50                // max 50 concurrent
        );
}

// ❌ Virtual Threads: cần tự implement throttling
Semaphore semaphore = new Semaphore(50);
for (DocumentEvent event : kafkaConsumer.poll()) {
    Thread.ofVirtual().start(() -> {
        semaphore.acquire();
        try { processEvent(event); }
        finally { semaphore.release(); }
    });
}
// Hoặc dùng Executor với bounded queue — nhưng tự viết hết
```

### Case 2: Streaming data pipeline

```java
// Streaming 10M records từ DB → transform → export CSV
// Không load vào RAM, xử lý từng chunk

// ✅ Reactive — perfect fit:
Flux.fromStream(
    entityManager.createQuery("SELECT d FROM Document d", Document.class)
        .setHint(QueryHints.PASS_DISTINCT_THROUGH, false)
        .getResultStream()
)
.buffer(1000)                    // batch 1000
.flatMap(batch -> enrichBatch(batch), 5)  // 5 concurrent enrichments
.map(csvConverter::convert)
.subscribe(csvWriter::write);

// ✅ Virtual Threads — awkward, cần pull-based iteration:
try (Stream<Document> stream = getDocumentStream()) {
    stream.parallel()   // ForkJoinPool.commonPool — không control được
          .forEach(doc -> processSingle(doc));
}
// Không có fine-grained control như Reactive operators
```

### Case 3: Fan-out với rate limiting

```java
// Gửi notification đến 1M users, rate limit 10K/s

// ✅ Reactive — natural:
Flux.fromIterable(userIds)
    .delayElements(Duration.ofMicros(100))    // 10K/s rate
    .flatMap(id -> sendNotification(id), 100) // 100 concurrent
    .onErrorContinue((err, id) -> log.warn("Failed: {}", id))
    .subscribe();

// Virtual Threads: cần rate limiter library (Guava, Resilience4j)
RateLimiter limiter = RateLimiter.create(10_000);
userIds.stream()
    .forEach(id -> {
        limiter.acquire();   // ← blocking! tốt với VT nhưng không elegant
        Thread.ofVirtual().start(() -> sendNotification(id));
    });
```

---

## 5️⃣ Khi nào Virtual Threads THẮNG Reactive

### Case 1: Blocking third-party libraries

```java
// Legacy JDBC driver, không có R2DBC alternative
// Reactive bắt buộc phải wrap:
Mono.fromCallable(() -> jdbcTemplate.query(sql, rowMapper))
    .subscribeOn(Schedulers.boundedElastic())  // off-load sang thread pool
// → Bạn đang dùng thread pool trong reactive — lợi ích giảm đáng kể!

// Virtual Threads: JDBC blocking = fine, JVM lo unmount
userRepo.findById(userId);   // blocking, VT xử lý tự nhiên
```

### Case 2: Exception handling + debugging

```java
// Reactive stack trace:
java.lang.RuntimeException: User not found
    at reactor.core.publisher.Operators$MonoSubscriber.onError(...)
    at reactor.core.publisher.FluxMap$MapSubscriber.onError(...)
    at reactor.core.publisher.FluxFlatMap$FlatMapMain.onError(...)
    // ... 40 dòng reactor internals ...
    // Không thấy business code của bạn đâu cả

// Virtual Thread stack trace:
java.lang.RuntimeException: User not found
    at com.vpbank.pdms.UserService.findById(UserService.java:45)
    at com.vpbank.pdms.DocumentService.getDocumentDetail(DocumentService.java:78)
    at com.vpbank.pdms.DocumentController.getDetail(DocumentController.java:23)
    // ← Rõ ràng, actionable ngay
```

### Case 3: Mixed blocking/async codebase

```java
// Codebase có cả code blocking cũ và mới
// Reactive: phải wrap blocking code → complexity tăng
// Virtual Threads: blocking code cũ chạy tốt luôn, không cần migrate

// Ví dụ PDMS: Spring Batch ETL (blocking) + new Document API (VT)
// → Chạy chung trên VT executor, không cần reactive wrapper
```

---

## 6️⃣ Structured Concurrency — "tokio::join!" của Java

Java 21 giới thiệu `StructuredTaskScope` — tương đương `tokio::join!` và `tokio::select!` của Rust, nhưng cho Virtual Threads:

```java
// Parallel fetch, fail fast nếu một cái fail
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    Future<User>    user    = scope.fork(() -> userService.findById(id));
    Future<Account> account = scope.fork(() -> accountService.findById(id));
    Future<List<Document>> docs = scope.fork(() -> docService.findByUser(id));
    
    scope.join()           // đợi tất cả complete (hoặc một cái fail)
         .throwIfFailed(); // re-throw exception nếu có
    
    return new UserProfile(user.get(), account.get(), docs.get());
}
// Khi scope đóng: tất cả child threads bị cancel tự động
// Giống tokio::join! nhưng với familiar try-with-resources syntax

// ── Analog trong Rust Tokio ──────────────────────────────────
let (user, account, docs) = tokio::try_join!(
    user_service.find_by_id(id),
    account_service.find_by_id(id),
    doc_service.find_by_user(id),
)?;

// ── Analog trong Java Reactive ──────────────────────────────
Mono.zip(
    userService.findById(id),
    accountService.findById(id),
    docService.findByUser(id)
).map(tuple -> new UserProfile(...));
```

**ShutdownOnSuccess** — lấy kết quả đầu tiên thành công (như `tokio::select!`):

```java
// Race pattern: primary vs fallback
try (var scope = new StructuredTaskScope.ShutdownOnSuccess<CreditInfo>()) {
    scope.fork(() -> primaryCreditService.getInfo(id));    // thử primary
    scope.fork(() -> fallbackCreditService.getInfo(id));   // thử fallback song song
    
    scope.join();
    return scope.result(); // lấy cái nào done trước
}
```

---

## 7️⃣ Pinning — Cạm bẫy quan trọng nhất

Virtual Thread bị **pinned** (không thể unmount) trong hai trường hợp:

```java
// ❌ Case 1: synchronized block — gây carrier thread pinning
synchronized (this) {
    Thread.sleep(1000);  // VT không thể unmount! Carrier thread bị block!
}

// ❌ Case 2: Native method call
someJniMethod();  // JNI không support unmounting

// ✅ Fix: Dùng ReentrantLock thay synchronized
private final ReentrantLock lock = new ReentrantLock();

lock.lock();
try {
    Thread.sleep(1000);  // VT unmount bình thường, carrier thread free
} finally {
    lock.unlock();
}
```

**Detect pinning:**

```bash
# JVM flag để log pinning events
-Djdk.tracePinnedThreads=full

# Output khi bị pinned:
Thread[#31,ForkJoinPool-1-worker-1,5,CarrierThreads]
    com.vpbank.pdms.SomeService.synchronizedMethod(SomeService.java:45) <== monitors:1
```

**PDMS practical check:** Các thư viện hay gây pinning:
- `synchronized` trong Hibernate Session factory — cần check version (Hibernate 6.2+ đã fix)
- Jedis (Redis client) — dùng Lettuce thay thế (non-blocking)
- Cũ JDBC drivers — PostgreSQL JDBC driver hiện đại đã OK

---

## 8️⃣ Decision Framework — Chọn cái nào?

```
Bài toán của bạn là gì?
│
├── Stream xử lý 1M+ records với rate control?
│     → Reactive (Flux/Multi) — backpressure là must-have
│
├── Fan-out notification đến nhiều users?
│     → Reactive với Flux.flatMap(concurrency = N)
│
├── Kafka consumer cần backpressure?
│     → Reactive (SmallRye, Reactor Kafka)
│
├── Codebase Spring Boot, team quen Java, bài toán là CRUD + some parallel calls?
│     → Virtual Threads + Structured Concurrency — đơn giản hơn, debug dễ hơn
│
├── Greenfield Quarkus service với nhiều async I/O?
│     → Quarkus Reactive (Mutiny) nếu team OK với reactive
│     → Quarkus + Virtual Threads nếu muốn simplicity
│
├── Mixed: có blocking libraries (JDBC) và cần concurrency?
│     → Virtual Threads — blocking libraries "just work"
│
└── Cần performance tối đa cho event loop (WebSocket, SSE)?
      → Vert.x hoặc Quarkus Reactive — event loop natively
```

---

## 9️⃣ PDMS Recommendation (2026)

| PDMS Component | Recommendation | Lý do |
|---|---|---|
| Document API (REST CRUD) | **Virtual Threads** | JDBC, blocking ops, đơn giản |
| Kafka Event Processor | **Reactive (SmallRye)** | Backpressure cần thiết, 10K+ msg/s |
| Credit Migration ETL | **Virtual Threads + StructuredTaskScope** | Parallel DB calls, no backpressure need |
| Notification Service | **Reactive (Mutiny)** | Fan-out, rate limiting tự nhiên |
| Search/Query Service | **Virtual Threads** | Đọc từ PostgreSQL, CQRS read side |
| File Upload/Streaming | **Reactive** | Streaming multipart, memory efficient |

**Tổng quan:** Không phải "all-or-nothing". Dùng Virtual Threads làm default, chuyển sang Reactive **khi bài toán đòi hỏi backpressure hoặc streaming**.

---

## 🔗 Liên kết trong vault

- [[_moc/MOC-Concurrency]] — Threading model overview, Java vs Rust mapping
- [[_moc/MOC-JVM-Frameworks]] — Quarkus/Micronaut reactive support
- [[concepts/reactive-programming-fundamentals]] — Reactive deep dive (Mono/Flux/Uni/Multi)
- [[JVM-Frameworks-2026/ADR-001-Why-Quarkus-Over-Micronaut]] — Framework decision, reactive context
- [[JVM-Frameworks-2026/ADR-002-Project-Loom-vs-Reactive-for-PDMS]] *(cần viết)* — Formal decision record
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio]] — Tokio: Rust's answer to the same problem
- [[Rust-Zero-To-Hero/Bai-21-Async-Internals-Pin]] — Async state machine internals (compare với JVM VT continuation)
- [[Microservices-Patterns/04-Observability]] — Monitor VT vs Reactive performance trong production
