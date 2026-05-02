# Rust Web Application — Full Curriculum

Mục tiêu: Đủ năng lực triển khai production-grade web application bằng Rust.
Stack target: **Axum + SQLx + Tokio + Tower + Serde**

---

## ✅ Đã có (Bài 1–4)
- Ownership, Move semantics
- Borrowing (`&T`, `&mut T`)
- Structs, Enums (ADT), Traits
- `Option<T>`, `Result<T,E>`, toán tử `?`
- `Vec`, `HashMap`, `String` vs `&str`
- `Arc<Mutex<T>>`, thread-based concurrency cơ bản

---

## 🗺️ Toàn bộ Topics Cần Nắm — Chia theo Layer

```
┌─────────────────────────────────────────────────────┐
│  LAYER 5 — PRODUCTION                               │
│  Observability, Error Design, Config, Deployment    │
├─────────────────────────────────────────────────────┤
│  LAYER 4 — INTEGRATION                              │
│  Kafka (rdkafka), HTTP client (reqwest), Auth (JWT) │
├─────────────────────────────────────────────────────┤
│  LAYER 3 — WEB FRAMEWORK                            │
│  Axum routing, Extractors, Middleware (Tower)       │
├─────────────────────────────────────────────────────┤
│  LAYER 2 — ASYNC RUNTIME                            │
│  Tokio tasks, channels, select!, timeout            │
├─────────────────────────────────────────────────────┤
│  LAYER 1 — LANGUAGE DEEP DIVE                       │
│  Lifetimes, Generics, Trait Objects, Closures,      │
│  Iterators, Smart Pointers, async/await internals   │
├─────────────────────────────────────────────────────┤
│  LAYER 0 — ĐÃ CÓ ✅                                │
│  Ownership, Borrowing, Structs/Enums/Traits,        │
│  Error Handling, Collections                        │
└─────────────────────────────────────────────────────┘
```

---

## 📋 Curriculum Chi Tiết

### LAYER 1 — Language Deep Dive

#### 1.1 Lifetimes
- Tại sao cần lifetime annotation (`'a`)
- Lifetime trong struct fields
- `'static` lifetime — khi nào dùng, khi nào tránh
- Lifetime elision rules (khi nào compiler tự suy)
- → Java analog: không có tương đương, đây là Rust-unique

#### 1.2 Generics & Trait Bounds
- Generic functions, structs, enums
- Trait bounds: `fn foo<T: Display + Clone>(x: T)`
- `where` clause khi bounds phức tạp
- Monomorphization — zero-cost generics hoạt động như thế nào
- → Java analog: `<T extends Comparable<T>>`

#### 1.3 Trait Objects & Dynamic Dispatch
- `dyn Trait` vs `impl Trait` — khi nào dùng cái nào
- Object safety rules
- `Box<dyn Error>` — pattern phổ biến nhất trong web apps
- → Java analog: `interface` + runtime polymorphism

#### 1.4 Closures & Iterators
- `Fn`, `FnMut`, `FnOnce` — ba loại closure
- Iterator trait, lazy evaluation
- `.map()`, `.filter()`, `.flat_map()`, `.collect()`
- Closure capture: move vs borrow
- → Java analog: `Function<T,R>`, `Stream<T>`

#### 1.5 Smart Pointers (đầy đủ)
- `Box<T>` — heap alloc, recursive types
- `Rc<T>` / `Arc<T>` — ref counting
- `Cell<T>` / `RefCell<T>` — interior mutability (single-thread)
- `Mutex<T>` / `RwLock<T>` — interior mutability (multi-thread)
- Deref coercions — tại sao `&Box<T>` hoạt động như `&T`

#### 1.6 Error Design
- Custom error types với `thiserror`
- Error wrapping và `anyhow` cho application code
- `From` trait để convert errors tự động
- → Spring analog: `@ControllerAdvice` + `GlobalExceptionHandler`

#### 1.7 Modules & Workspace
- `mod`, `pub`, `use`, `super`, `crate`
- Cargo workspace — monorepo multi-crate
- Feature flags trong `Cargo.toml`

---

### LAYER 2 — Tokio Async Runtime

#### 2.1 async/await Internals
- `Future` trait — polling model vs callback/coroutine
- `async fn` desugaring
- `.await` — yield point, không block OS thread
- → Java analog: `CompletableFuture` chain, nhưng baked into language

#### 2.2 Tokio Tasks
- `tokio::spawn` — spawn task lên runtime
- `JoinHandle` — await kết quả
- `tokio::task::spawn_blocking` — CPU-bound code
- Task vs Thread — khi nào dùng cái nào
- → Java analog: `CompletableFuture.supplyAsync()`, Virtual Threads

#### 2.3 Tokio Channels
- `mpsc` — multi producer single consumer
- `oneshot` — single-use response channel
- `broadcast` — fan-out
- `watch` — state sharing (config, feature flags)
- → Java analog: `BlockingQueue`, `CompletableFuture`

#### 2.4 Tokio Utilities
- `tokio::select!` — race multiple futures
- `tokio::time::timeout` — deadline enforcement
- `tokio::time::interval` — periodic tasks
- `tokio::sync::Semaphore` — concurrency limiting

---

### LAYER 3 — Axum Web Framework

#### 3.1 Routing
- `Router::new().route(path, method_handler)`
- Path params, query params
- Nested routers — tương tự `@RequestMapping` group
- Method routing: `get()`, `post()`, `put()`, `delete()`

#### 3.2 Extractors
- `Path<T>` — path params
- `Query<T>` — query string deserialized vào struct
- `Json<T>` — request body
- `State<T>` — shared app state (thay `@Autowired`)
- `Extension<T>` — middleware-injected data
- Custom extractors — implement `FromRequestParts`
- → Spring analog: `@PathVariable`, `@RequestParam`, `@RequestBody`

#### 3.3 Responses
- `impl IntoResponse` — bất kỳ type nào có thể là response
- `(StatusCode, Json<T>)` tuple response
- Custom error response type
- Response headers

#### 3.4 Tower Middleware
- `ServiceBuilder` — compose middleware layers
- Built-in: `TraceLayer`, `CorsLayer`, `CompressionLayer`, `TimeoutLayer`
- Custom middleware với `from_fn`
- → Spring analog: `OncePerRequestFilter`, `HandlerInterceptor`

#### 3.5 App State & Dependency Injection
- `Arc<AppState>` pattern — toàn bộ app share một state
- Nested state — database pool, config, clients
- → Spring analog: `@Bean` + `ApplicationContext`

#### 3.6 Request Lifecycle
- Extractor → Handler → Response flow
- Middleware execution order
- Error propagation qua layers

---

### LAYER 4 — Integration

#### 4.1 SQLx (Database)
- `PgPool` — connection pool setup
- `sqlx::query!` / `sqlx::query_as!` — compile-time SQL check
- Transactions — `pool.begin()`, commit/rollback
- Migrations — `sqlx migrate`
- `FromRow` derive — map row → struct
- → JPA analog: typed queries nhưng explicit, không magic

#### 4.2 Serde (Serialization)
- `Serialize`, `Deserialize` derive
- Field renaming: `#[serde(rename_all = "camelCase")]`
- Skip fields, default values, flatten
- Custom serializer/deserializer
- `serde_json::Value` — dynamic JSON

#### 4.3 HTTP Client (reqwest)
- Async client setup
- Request builder pattern
- Response deserialization
- Retry / timeout patterns
- → Java analog: `WebClient` (Spring WebFlux)

#### 4.4 Auth — JWT
- `jsonwebtoken` crate
- Claims struct, encode/decode
- Axum middleware cho auth guard
- → Spring analog: `JwtAuthenticationFilter`

#### 4.5 Kafka (rdkafka)
- Producer — fire-and-forget vs delivery callback
- Consumer — consumer group, offset management
- Async consumer với tokio
- → Spring analog: `@KafkaListener`, `KafkaTemplate`

#### 4.6 Config Management
- `config` crate — layered config (file + env)
- `dotenvy` — `.env` loading
- → Spring analog: `application.yml` + `@ConfigurationProperties`

---

### LAYER 5 — Production

#### 5.1 Structured Logging & Tracing
- `tracing` crate — spans, events
- `tracing-subscriber` — format, filter
- Correlation ID qua middleware
- → Spring analog: `Slf4j` + MDC

#### 5.2 Metrics
- `metrics` crate — counter, gauge, histogram
- Prometheus exporter

#### 5.3 Graceful Shutdown
- `tokio::signal` — SIGTERM handling
- `CancellationToken` — propagate shutdown
- Drain in-flight requests

#### 5.4 Testing
- Unit test trong Rust (`#[cfg(test)]`)
- Integration test với `axum::test` — `TestClient`
- Database test — `sqlx::test` với transaction rollback
- Mocking với `mockall`

#### 5.5 Deployment
- Multi-stage Dockerfile — builder + distroless
- Static linking — `MUSL` target
- Binary size optimization — `strip`, `opt-level`
- Health check endpoint pattern

---

## 📅 Thứ tự học đề xuất

```
Bài 1-4 (done) 
    ↓
[5] Lifetimes + Generics + Trait Objects  ← unlock mọi thứ phía sau
    ↓
[6] Closures + Iterators                  ← dùng liên tục trong web code
    ↓
[7] Smart Pointers đầy đủ + Error Design  ← foundation cho app state
    ↓
[8] async/await internals + Tokio tasks   ← core của web runtime
    ↓
[9] Tokio channels + select! + timeout    ← concurrency patterns
    ↓
[10] Axum: Routing + Extractors + State   ← hands-on web
    ↓
[11] Axum: Middleware + Error Response    ← production patterns
    ↓
[12] SQLx — database integration          ← persistence layer
    ↓
[13] Serde + reqwest + JWT                ← typical web integrations
    ↓
[14] Kafka (rdkafka)                      ← messaging (PDMS-relevant)
    ↓
[15] Tracing + Graceful Shutdown + Testing
    ↓
[16] Deployment
```

---

## 🔗 Links
- [[MOC-Rust]]
- [[MOC-Concurrency]]
- [[MOC-Java]] — cross-reference khi so sánh
