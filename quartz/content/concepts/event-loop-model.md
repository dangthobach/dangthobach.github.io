---
tags: [java, concurrency, reactive, vertx, evergreen]
aliases: [event-loop, non-blocking-io, nio, event-driven]
created: 2026-04-13
status: evergreen
---

# Event Loop Model

## 📌 One-liner
> Event loop là vòng lặp **single-threaded** liên tục poll và xử lý events — mỗi handler phải chạy nhanh và không block, để thread luôn sẵn sàng xử lý event tiếp theo.

---

## 🧠 Core Idea

### Thread-per-Request vs Event Loop

```
THREAD-PER-REQUEST (Spring MVC mặc định):

Request 1 ──→ Thread 1 ──[DB call: 50ms BLOCKED]──→ respond
Request 2 ──→ Thread 2 ──[HTTP call: 200ms BLOCKED]──→ respond
Request 3 ──→ Thread 3 ──[DB call: 50ms BLOCKED]──→ respond
...
Request 1000 ──→ Thread 1000 ──[waiting…]──→ respond
                 ↑
         1000 OS threads × ~1MB stack = ~1GB RAM chỉ để "đợi"

──────────────────────────────────────────────────────────────

EVENT LOOP (Vert.x, Netty, Node.js):

                 ┌─────────────────────────┐
Request 1 ──→   │                         │──→ DB call (async, không block)
Request 2 ──→   │    Event Loop Thread    │──→ HTTP call (async, không block)
Request 3 ──→   │    (2–4 threads total)  │──→ process result khi có
Request 1000 ──→│                         │──→ respond
                 └─────────────────────────┘
                 ↑
         4 threads × ~1MB = 4MB RAM để xử lý 1000 requests
```

### Vòng lặp Event Loop

```
while (running) {
    events = poll_event_queue()      // lấy events sẵn có
    for (event in events) {
        handler = lookup(event)      // tìm handler đã đăng ký
        handler.run(event)           // PHẢI chạy nhanh, KHÔNG BLOCK!
    }
}
```

---

## 🔁 Analog

| | Java Blocking (Spring MVC) | Event Loop (Vert.x / Netty) | Node.js |
|---|---|---|---|
| Thread model | 1 thread / request | 1 loop / CPU core | 1 loop total |
| I/O | Blocking (JDBC, HttpClient) | Non-blocking (async callbacks) | Non-blocking |
| Concurrency | OS thread switching | Single-threaded per loop | Single-threaded |
| State sharing | ThreadLocal | Context object | Closure / module scope |
| CPU cores | N threads dùng N cores | N loops = N cores | 1 loop, dùng worker_threads |

---

## 💻 Event Loop trong Vert.x

```java
// Vert.x tạo N event loop threads (mặc định = 2 × CPU cores)
// Mỗi Verticle được "pinned" vào 1 event loop thread

public class ApiVerticle extends AbstractVerticle {

    @Override
    public void start(Promise<Void> startPromise) {
        // Code này chạy trên Event Loop Thread — KHÔNG BLOCK!

        Router router = Router.router(vertx);

        router.get("/users/:id").handler(ctx -> {
            String id = ctx.pathParam("id");

            // ✅ Async DB call — không block event loop
            userClient.findById(id)
                .onSuccess(user -> ctx.json(user))
                .onFailure(err  -> ctx.fail(500));
            // Handler return ngay, event loop tiếp tục xử lý request khác
        });

        vertx.createHttpServer()
            .requestHandler(router)
            .listen(8080)
            .onSuccess(s -> startPromise.complete());
    }
}
```

### Blocking Code → Worker Thread Pool

```java
router.get("/report").handler(ctx -> {

    // ❌ SAI: JDBC call block event loop
    // List<Data> data = jdbcTemplate.query(…); // BLOCK!

    // ✅ ĐÚNG: chuyển sang worker thread
    vertx.executeBlocking(() -> {
            return jdbcTemplate.query(…);  // block OK ở đây
        })
        .onSuccess(data -> ctx.json(data))
        .onFailure(ctx::fail);
});
```

---

## 💻 Event Loop trong Spring WebFlux (Netty)

```java
// Spring WebFlux cũng dùng event loop (Netty) bên dưới
@GetMapping("/users/{id}")
public Mono<User> getUser(@PathVariable Long id) {
    // Chạy trên Netty event loop thread
    return userRepository.findById(id)   // R2DBC — non-blocking
        .switchIfEmpty(Mono.error(new NotFoundException()));
    // Không dùng @Blocking → không được block ở đây
}

// Nếu cần blocking code trong WebFlux
@GetMapping("/report")
public Mono<Report> getReport() {
    return Mono.fromCallable(() -> generateReport())  // blocking operation
               .subscribeOn(Schedulers.boundedElastic()); // chạy trên elastic thread pool
}
```

---

## 🔍 Event Loop trong Quarkus

Quarkus dùng Vert.x làm engine nền — toàn bộ request processing đi qua Vert.x event loop.

```java
// RESTEasy Reactive — chạy trên event loop by default
@GET
@Path("/users/{id}")
public Uni<User> getUser(@PathParam Long id) {
    // Chạy trên event loop — phải non-blocking!
    return userRepo.findById(id);  // Reactive Panache — non-blocking
}

// Nếu method blocking → thêm @Blocking annotation
@GET
@Path("/report")
@Blocking  // ← Quarkus tự chuyển sang worker thread pool
public Report getReport() {
    return reportService.generate();  // JDBC blocking — OK vì @Blocking
}
```

---

## ⚠️ Pitfalls

> [!danger] Rule số 1: KHÔNG BAO GIỜ block event loop thread
> Blocking event loop = toàn bộ server "đóng băng" với tất cả requests đang xử lý
> ```java
> // ❌ Những thứ TUYỆT ĐỐI không làm trong event loop handler:
> Thread.sleep(1000);          // block
> socket.read();               // blocking I/O
> jdbcConnection.query(sql);   // blocking DB call
> new URL(url).openStream();   // blocking HTTP
> synchronized (lock) { }      // có thể block nếu lock bị hold
> ```

> [!warning] Vert.x có "blocked thread checker"
> Vert.x tự động log WARNING nếu handler chạy > 2 giây:
> `"Thread vertx-eventloop-thread-0 has been blocked for 3456ms"`
> Đây là early warning — đừng ignore.

> [!tip] Cách kiểm tra đang trên thread nào
> ```java
> log.info("Thread: {}", Thread.currentThread().getName());
> // Event loop: "vert.x-eventloop-thread-N"
> // Worker pool: "vert.x-worker-thread-N"
> // Quarkus executor: "executor-thread-N"
> ```

---

## 💡 Khi nào Event Loop phát huy tốt nhất

✅ **Phù hợp:**
- I/O-bound workloads: nhiều DB/HTTP/Kafka calls đồng thời
- High concurrency với ít RAM (K8s, serverless, microservices)
- Proxy / gateway / reverse proxy (hầu hết là I/O)
- Real-time: WebSocket, SSE, streaming

❌ **Không phù hợp:**
- CPU-bound: image processing, encryption, AI inference → dùng thread pool
- Heavy blocking libraries không thể async → phải isolate sang worker
- Throughput nhỏ, latency không phải vấn đề → overkill, thêm complexity

---

## 🔗 Liên quan
- [[JVM-Frameworks-2026/03-Vertx/P1-Core/01 Event Loop và Verticles|Vert.x: Event Loop và Verticles]] — implementation cụ thể
- [[JVM-Frameworks-2026/03-Vertx/P2-HTTP/01 Router và Route Handlers|Vert.x: Router & Handlers]] — viết handler đúng cách
- [[reactive-programming-fundamentals]] — paradigm bên trên event loop
- [[backpressure-explained]] — khi event loop bị overwhelm
- [[_moc/MOC-Concurrency|MOC-Concurrency]] — so sánh với threading model

## 📖 Nguồn
- https://vertx.io/docs/vertx-core/java/#_the_golden_rule — Vert.x golden rule
- https://netty.io/wiki/thread-model.html — Netty thread model
- https://quarkus.io/blog/resteasy-reactive-smart-dispatch — Quarkus dispatch model
