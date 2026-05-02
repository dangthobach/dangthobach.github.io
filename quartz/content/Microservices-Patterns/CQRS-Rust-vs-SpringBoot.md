---
tags: [cqrs, rust, spring-boot, architecture, comparison, axum, tokio, ddd]
up: "[[CQRS-Materialized-View]]"
related: "[[Event-Sourcing]], [[Bai-9-Async-Tokio]], [[Bai-23-Workspace-Architecture]]"
created: 2026-04-15
---

# CQRS: Rust (Axum/Tokio) vs Spring Boot — So sánh chuyên sâu

> **TL;DR:** Cả hai đều implement CQRS nhưng theo hai triết lý hoàn toàn khác nhau. Spring dùng **magic tại runtime** (reflection, auto-scan, DI container). Rust dùng **contract tại compile time** (trait system, zero-cost abstractions). Kết quả: Spring nhanh hơn để viết, Rust nhanh hơn để chạy và bắt lỗi.

---

## 1. Bức tranh toàn cảnh — Ai làm gì?

```
┌─────────────────────────────────────────────────────────────┐
│                    CQRS FLOW TỔNG QUÁT                      │
│                                                             │
│  HTTP Request                                               │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────┐    Command/Query    ┌──────────────┐          │
│  │   API   │ ──────────────────► │     Bus      │          │
│  │ Handler │                     │  (Dispatch)  │          │
│  └─────────┘                     └──────┬───────┘          │
│                                         │                   │
│                          ┌──────────────┘                   │
│                          ▼                                   │
│                   ┌─────────────┐                           │
│                   │   Handler   │  (validate + execute)     │
│                   └──────┬──────┘                           │
│                          │                                   │
│              ┌───────────┴───────────┐                      │
│              ▼                       ▼                       │
│         [Write DB]            [Event Bus]                    │
│              │                       │                       │
│              │               [Read Model /                   │
│              │               Projection]                     │
└─────────────────────────────────────────────────────────────┘
```

**Cả Rust và Spring đều theo sơ đồ trên.** Sự khác nhau nằm ở cơ chế bên trong mỗi ô.

---

## 2. Cơ chế Bus — "Ai tìm Handler?"

Đây là **sự khác biệt cốt lõi nhất**.

### Spring Boot — Auto-discovery qua Reflection

```
┌─────────────────────────────────────────────────────────────┐
│                  SPRING RUNTIME WIRING                      │
│                                                             │
│  @SpringBootApplication                                     │
│       │                                                     │
│       ▼  startup                                            │
│  ┌─────────────────────────┐                               │
│  │   Component Scan        │  ← quét toàn bộ classpath     │
│  │   (reflection)          │    tìm @Component, @Service   │
│  └──────────┬──────────────┘                               │
│             │ tìm thấy                                      │
│             ▼                                               │
│  ┌─────────────────────────┐                               │
│  │   ApplicationContext    │  ← registry tất cả beans      │
│  │   (IoC Container)       │                               │
│  └──────────┬──────────────┘                               │
│             │ inject                                        │
│             ▼                                               │
│  ┌─────────────────────────┐                               │
│  │  CommandBus / MediatR   │  ← biết handler nào           │
│  │  (axon, spring-modulith)│    xử lý command nào          │
│  └─────────────────────────┘    nhờ Map<Type, Handler>     │
│                                                             │
│  Lỗi chỉ phát hiện lúc: RUNTIME (NoHandlerFoundException) │
└─────────────────────────────────────────────────────────────┘
```

```java
// Spring: Bus tự tìm handler — developer không cần wire tay
@Component
public class CreateClientHandler 
    implements CommandHandler<CreateClientCommand, Client> {

    @Override
    public Client handle(CreateClientCommand cmd) {
        // Spring biết class này handle CreateClientCommand
        // vì generic type được đọc qua reflection khi startup
        return clientRepository.save(Client.from(cmd));
    }
}

// Khi dispatch — Spring tự resolve handler
@Service
public class CommandBus {
    @Autowired
    private Map<Class<?>, CommandHandler<?, ?>> handlers; // auto-injected
    
    public <R> R dispatch(Command<R> command) {
        var handler = handlers.get(command.getClass()); // runtime lookup
        if (handler == null) throw new NoHandlerFoundException(...); // runtime error!
        return ((CommandHandler<Command<R>, R>) handler).handle(command); // unchecked cast
    }
}
```

### Rust — Explicit wiring qua Trait System

```
┌─────────────────────────────────────────────────────────────┐
│                   RUST COMPILE-TIME WIRING                  │
│                                                             │
│  fn main() / app_state.rs                                  │
│       │                                                     │
│       │  developer TỰ kết nối                              │
│       ▼                                                     │
│  ┌─────────────────────────┐                               │
│  │  Arc<CreateClientHandler│  ← tạo handler thủ công      │
│  │     { repo: Arc<Repo> } │                               │
│  └──────────┬──────────────┘                               │
│             │ truyền vào                                    │
│             ▼                                               │
│  command_bus                                                │
│    .dispatch_with_handler(cmd, handler)                     │
│                   │                                         │
│                   ▼                                         │
│  ┌─────────────────────────┐                               │
│  │  Compiler kiểm tra:     │                               │
│  │  handler impl            │                               │
│  │  CommandHandler<         │                               │
│  │    CreateClientCommand>? │  ← type error = compile fail │
│  └─────────────────────────┘                               │
│                                                             │
│  Lỗi phát hiện lúc: COMPILE TIME (0 surprise ở production) │
└─────────────────────────────────────────────────────────────┘
```

```rust
// Rust: Traits định nghĩa contract, compiler kiểm tra

// 1. Define interface
#[async_trait]
pub trait CommandHandler<C: Command>: Send + Sync {
    async fn handle(&self, command: C) -> Result<C::Response, AppError>;
}

// 2. Implement cho handler cụ thể
pub struct CreateClientHandler {
    repo: Arc<dyn ClientRepository>,
    event_bus: Arc<dyn EventBus>,
}

#[async_trait]
impl CommandHandler<CreateClientCommand> for CreateClientHandler {
    async fn handle(&self, cmd: CreateClientCommand) -> Result<Client, AppError> {
        let client = self.repo.create(cmd).await?;
        // publish event...
        Ok(client)
    }
}

// 3. Dispatch — compiler verify ngay lúc compile
let handler = Arc::new(CreateClientHandler { repo, event_bus });
command_bus
    .dispatch_with_handler(create_cmd, handler)  // ← compile error nếu sai type
    .await?;
```

**Tóm tắt bus mechanism:**

| Aspect | Spring Boot | Rust |
|---|---|---|
| Handler discovery | Auto-scan (reflection) | Explicit (manual wire) |
| Type check | Runtime | Compile time |
| Error khi thiếu handler | `NoHandlerFoundException` lúc request | Compiler error lúc build |
| Overhead dispatch | HashMap lookup + cast | Monomorphization (zero-cost) |
| Code boilerplate | Ít (framework lo) | Nhiều hơn (developer lo) |

---

## 3. Validation — "Dữ liệu hợp lệ được kiểm tra ở đâu?"

### Spring Boot — Annotation + AOP

```java
// Spring: @Valid tích hợp với Bean Validation (Hibernate Validator)
public record CreateClientCommand(
    @NotBlank String name,
    @Email String email,
    @Min(0) @Max(100) Integer age
) {}

@RestController
public class ClientController {
    @PostMapping("/clients")
    public ResponseEntity<?> create(
        @Valid @RequestBody CreateClientCommand cmd  // ← @Valid trigger validation
    ) {
        // Nếu invalid → Spring interceptor throw MethodArgumentNotValidException
        // Developer không cần gọi validate() thủ công
        return ResponseEntity.ok(commandBus.dispatch(cmd));
    }
}
```

```
Spring Validation Flow:
  HTTP Body 
    → JSON Deserialization (Jackson)
    → @Valid trigger → Hibernate Validator → ConstraintViolations?
        ├── Yes → MethodArgumentNotValidException → 400 Bad Request
        └── No  → Controller method body
```

### Rust — Trait bound + explicit call

```rust
// Rust: validator crate, Command trait require Validate
use validator::Validate;

#[derive(Validate, Deserialize)]
pub struct CreateClientCommand {
    #[validate(length(min = 1, max = 100))]
    pub name: String,
    #[validate(email)]
    pub email: String,
    #[validate(range(min = 0, max = 100))]
    pub age: Option<i32>,
}

// Command trait yêu cầu Validate bound
pub trait Command: Validate + Send + Sync {
    type Response;
}

// CommandBus gọi validate() TRƯỚC khi execute
impl CommandBus {
    pub async fn dispatch_with_handler<C, H>(
        &self,
        command: C,
        handler: Arc<H>,
    ) -> Result<C::Response, AppError>
    where
        C: Command,       // ← bound này đảm bảo có validate()
        H: CommandHandler<C>,
    {
        command.validate()                    // ← explicit call
            .map_err(|e| AppError::ValidationError(e.to_string()))?;
        
        handler.handle(command).await
    }
}
```

```
Rust Validation Flow:
  HTTP Body
    → JSON Deserialization (serde)
    → CommandBus.dispatch_with_handler()
        → command.validate() ← explicit, trong bus
            ├── Err → AppError::ValidationError → 400 Bad Request
            └── Ok  → handler.handle(command)
```

**Validation: Spring đặt ở layer API (controller), Rust đặt ở layer Bus (application core). Rust approach đảm bảo validate bất kể command đến từ đâu (HTTP, queue, job...).**

---

## 4. Async Model — "Concurrency trông như thế nào?"

Đây là sự khác biệt **kiến trúc hệ thống** lớn nhất.

### Spring Boot — Thread-per-request (MVC) hoặc Reactive (WebFlux)

```
┌─────────────────────────────────────────────────────────────┐
│           SPRING MVC (Traditional)                          │
│                                                             │
│  Request 1 ──► Thread-1 ──► DB call (blocking) ──► Thread-1│
│  Request 2 ──► Thread-2 ──► DB call (blocking) ──► Thread-2│
│  Request 3 ──► Thread-3 ──► DB call (blocking) ──► Thread-3│
│     ...              ...                                    │
│  Request N ──► Thread-N                                     │
│                                                             │
│  Thread pool: default 200 threads                           │
│  RAM: ~1MB per thread = 200 requests × 1MB = 200MB chỉ     │
│       cho thread overhead                                   │
│                                                             │
│  Request N+1 → WAIT (thread pool exhausted)                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│           SPRING WEBFLUX (Reactive)                         │
│                                                             │
│  Request 1 ──┐                                             │
│  Request 2 ──┤──► Event Loop ──► Non-blocking I/O          │
│  Request 3 ──┘    (small thread pool = CPU cores)           │
│                                                             │
│  Tốt hơn về throughput nhưng:                              │
│  - Code phức tạp (Mono/Flux/reactive chains)               │
│  - Không phải mọi thư viện support                         │
│  - Debug khó (stacktrace rỗng)                              │
└─────────────────────────────────────────────────────────────┘
```

```java
// Spring WebFlux CQRS — Reactive style
@Component
public class CreateClientHandler 
    implements CommandHandler<CreateClientCommand, Mono<Client>> {
    
    @Override
    public Mono<Client> handle(CreateClientCommand cmd) {
        return clientRepository.save(Client.from(cmd))  // reactive repository
            .flatMap(client -> 
                eventBus.publish(new ClientCreatedEvent(client.getId()))
                    .thenReturn(client)
            );
            // Phải "chain" mọi thứ — nếu quên thì event không được publish!
    }
}
```

### Rust — async/await trên Tokio (green threads)

```
┌─────────────────────────────────────────────────────────────┐
│              RUST TOKIO MODEL                               │
│                                                             │
│  Request 1 ──┐                                             │
│  Request 2 ──┤                                             │
│  Request N ──┤──► Tokio Runtime (4 OS threads = 4 cores)  │
│              │        │                                     │
│              │   thousands of                               │
│              │   async Tasks (futures)                      │
│              │        │                                     │
│              │   khi I/O wait → yield → run task khác      │
│              │   không block OS thread                      │
│              └─────────────────────────────────────────────│
│                                                             │
│  RAM per "task": ~few KB (vs 1MB per thread)               │
│  Throughput: 10-100x so với thread-per-request             │
│  Code style: async/await (dễ đọc như sync)                 │
└─────────────────────────────────────────────────────────────┘
```

```rust
// Rust Tokio CQRS — async/await style (đọc gần như sync code)
#[async_trait]
impl CommandHandler<CreateClientCommand> for CreateClientHandler {
    async fn handle(&self, cmd: CreateClientCommand) -> Result<Client, AppError> {
        // Tất cả await point = yield point cho tokio scheduler
        let client = self.repo.create(&cmd).await?;  // ← non-blocking I/O
        
        // tokio::spawn tạo task độc lập — không block response
        let event_bus = self.event_bus.clone();
        let client_id = client.id;
        tokio::spawn(async move {
            event_bus.publish(ClientCreatedEvent { id: client_id }).await;
        });
        
        Ok(client)  // response trả về ngay, event publish async
    }
}
```

**Async model comparison:**

| Aspect | Spring MVC | Spring WebFlux | Rust Tokio |
|---|---|---|---|
| Model | Thread-per-request | Reactive (Mono/Flux) | Async/await (green threads) |
| Code style | Imperative (dễ đọc) | Functional chains (khó đọc) | Async/await (dễ đọc như sync) |
| RAM overhead | ~1MB/request | ~KB/request | ~KB/request |
| Max concurrency | ~200 (thread pool) | Very high | Very high |
| Learning curve | Easy | Hard | Medium |
| Ecosystem | Mature | Partial | Growing |

---

## 5. Type Safety — "Lỗi được bắt ở đâu?"

```
┌─────────────────────────────────────────────────────────────────────┐
│              KHI NÀO LỖI BỊ PHÁT HIỆN?                            │
│                                                                     │
│  SPRING BOOT:                                                       │
│  ──────────────────────────────────────────────────────────────    │
│  Code written ──► Compile ──► Unit Test ──► Integration ──► PROD   │
│                      ✗           ✗              ✗          ← lỗi   │
│                                                                     │
│  (Nhiều lỗi chỉ xuất hiện runtime vì reflection + generic erasure) │
│                                                                     │
│  RUST:                                                              │
│  ──────────────────────────────────────────────────────────────    │
│  Code written ──► COMPILE ──► Unit Test ──► Integration ──► PROD   │
│                     ✓ ← lỗi bắt ở đây (compiler)                   │
│                                                                     │
│  (Compiler enforce: type, lifetime, thread safety, ownership)       │
└─────────────────────────────────────────────────────────────────────┘
```

**Ví dụ: Quên handler**

```java
// Spring Boot — runtime error
// Nếu quên đăng ký CreateInvoiceHandler:
commandBus.dispatch(new CreateInvoiceCommand(...));
// → NoHandlerFoundException lúc request tới production
//   (unit test có thể miss nếu không mock đúng)
```

```rust
// Rust — compile error
let handler = Arc::new(CreateInvoiceHandler { ... }); // nếu quên dòng này
command_bus
    .dispatch_with_handler(cmd, handler)  // ← handler không có trong scope
    .await?;
// error[E0425]: cannot find value `handler` in this scope
// Build fail → không thể deploy
```

**Ví dụ: Wrong handler type**

```java
// Spring — ClassCastException lúc runtime
@Component
public class BadHandler implements CommandHandler<CreateInvoiceCommand, String> {
    // implement sai return type
}
// CommandBus cast sang CommandHandler<?, Integer> → ClassCastException
```

```rust
// Rust — compile error
impl CommandHandler<CreateInvoiceCommand> for BadHandler {
    async fn handle(&self, cmd: CreateInvoiceCommand) -> Result<String, AppError> {
        // ^ CreateInvoiceCommand::Response = InvoiceId, không phải String
        // error[E0053]: method `handle` has an incompatible type
    }
}
```

---

## 6. Event Publishing — "Sau khi write, event đi đâu?"

### Spring Boot — ApplicationEvent + @TransactionalEventListener

```java
// Spring: event trong same JVM, có thể bounded bởi transaction
@Service
@Transactional
public class CreateClientHandler {
    
    @Autowired
    private ApplicationEventPublisher eventPublisher;
    
    public Client handle(CreateClientCommand cmd) {
        Client client = clientRepository.save(Client.from(cmd));
        
        // @TransactionalEventListener — chỉ publish SAU khi transaction commit
        eventPublisher.publishEvent(new ClientCreatedEvent(client.getId()));
        
        return client;
    }
}

@Component
public class ClientEventListener {
    @TransactionalEventListener(phase = AFTER_COMMIT)
    public void on(ClientCreatedEvent event) {
        // Guaranteed: chỉ chạy nếu transaction commit thành công
        kafkaTemplate.send("client-events", event);
    }
}
```

### Rust — tokio::spawn + EventBus (Redis Streams)

```rust
// Rust: event publish qua EventBus, non-blocking bằng tokio::spawn
#[async_trait]
impl CommandHandler<CreateClientCommand> for CreateClientHandler {
    async fn handle(&self, cmd: CreateClientCommand) -> Result<Client, AppError> {
        // Write to DB
        let client = self.repo.save(Client::from(&cmd)).await?;
        
        // Publish event — detach vào background task
        let event_bus = Arc::clone(&self.event_bus);
        let event = ClientCreatedEvent {
            id: client.id,
            name: client.name.clone(),
            occurred_at: Utc::now(),
        };
        tokio::spawn(async move {
            if let Err(e) = event_bus.publish(event).await {
                tracing::error!("Failed to publish event: {}", e);
            }
        });
        
        Ok(client)
    }
}

// EventBus: Redis Streams (production) hoặc InMemory (dev/test)
impl RedisEventBus {
    async fn publish<E: DomainEvent>(&self, event: E) -> Result<(), AppError> {
        let payload = serde_json::to_string(&event)?;
        self.redis
            .xadd(E::STREAM_NAME, "*", &[("data", &payload)])
            .await?;
        Ok(())
    }
}
```

**Điểm quan trọng:** Trong Rust không có `@TransactionalEventListener`. Để đảm bảo atomicity (DB write + event publish), cần implement **Transactional Outbox pattern** tương tự Spring.

---

## 7. DI Container — "Dependency được inject như thế nào?"

```
┌─────────────────────────────────────────────────────────────┐
│                SPRING DI CONTAINER                          │
│                                                             │
│  @Component          @Service         @Repository          │
│      │                   │                 │               │
│      └─────────────┬─────┘                 │               │
│                    ▼                        │               │
│           ApplicationContext               │               │
│           (Runtime registry)               │               │
│                    │                        │               │
│                    │ @Autowired inject      │               │
│                    ▼                        │               │
│           CreateClientHandler ◄────────────┘               │
│           { clientRepository: ClientRepository }           │
│                                                             │
│  Spring tự tạo objects, tự inject — developer chỉ cần     │
│  annotate đúng chỗ                                          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                 RUST MANUAL DI (AppState)                   │
│                                                             │
│  async fn main() {                                          │
│      // Developer tự tạo và wire dependencies               │
│      let db = PgPool::connect(&config.db_url).await?;      │
│      let repo = Arc::new(PgClientRepository::new(db));     │
│      let event_bus = Arc::new(RedisEventBus::new(...));    │
│                                                             │
│      let app_state = AppState {                             │
│          client_repo: repo,        // ← explicit           │
│          event_bus,                // ← explicit           │
│          command_bus: CommandBus::new(),                    │
│          ...                                                │
│      };                                                     │
│                                                             │
│      // Handler được tạo khi cần, truyền vào bus           │
│      let handler = Arc::new(CreateClientHandler {          │
│          repo: Arc::clone(&app_state.client_repo),         │
│          event_bus: Arc::clone(&app_state.event_bus),      │
│      });                                                    │
│  }                                                          │
│                                                             │
│  Rust không có DI framework — AppState là "manual IoC"     │
│  Verbose hơn nhưng không có "magic", dễ trace              │
└─────────────────────────────────────────────────────────────┘
```

---

## 8. Performance Characteristics — Con số thực tế

```
┌─────────────────────────────────────────────────────────────────────┐
│              BENCHMARK: Simple CRUD Command (write + event)        │
│              (Typical web service, PostgreSQL, single node)        │
│                                                                     │
│  Spring Boot MVC (Tomcat):                                          │
│  ┌──────────────────────────────────────────────┐                  │
│  │ Throughput: ~10,000 req/s                     │                  │
│  │ Latency p99: ~50ms                            │                  │
│  │ RAM: ~400MB (JVM + thread pool)               │                  │
│  │ Startup time: ~3-8 seconds                    │                  │
│  └──────────────────────────────────────────────┘                  │
│                                                                     │
│  Spring Boot WebFlux (Netty):                                       │
│  ┌──────────────────────────────────────────────┐                  │
│  │ Throughput: ~25,000 req/s                     │                  │
│  │ Latency p99: ~20ms                            │                  │
│  │ RAM: ~200MB                                   │                  │
│  │ Startup time: ~2-5 seconds                    │                  │
│  └──────────────────────────────────────────────┘                  │
│                                                                     │
│  Rust (Axum + Tokio):                                               │
│  ┌──────────────────────────────────────────────┐                  │
│  │ Throughput: ~100,000+ req/s                   │                  │
│  │ Latency p99: ~5ms                             │                  │
│  │ RAM: ~20-50MB                                 │                  │
│  │ Startup time: <100ms                          │                  │
│  └──────────────────────────────────────────────┘                  │
│                                                                     │
│  * Số liệu approximate, phụ thuộc hardware và workload             │
│  * Bottleneck thực tế thường là DB, không phải framework           │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 9. Kiến trúc repo hiện tại (rust-system) — Đánh giá

### Những gì đã verify

| Claim | Kết quả | Chi tiết |
|---|---|---|
| CQRS CommandBus/QueryBus | ✅ Đúng | `core/cqrs/command.rs`, `query.rs` |
| DDD Entities/Aggregates/Repos | ✅ Đúng | `core/domain/entity.rs`, `aggregate.rs`, `repository.rs` |
| EventBus Redis + fallback in-memory | ✅ Đúng | `core/events/event_bus.rs` — RedisEventBus + InMemoryEventBus |
| EventStore PostgreSQL | ✅ Đúng | `core/events/event_store.rs` + migration 008 |
| Projection + projection_positions | ✅ Đúng | `core/events/projection.rs` + `file_system/projections.rs` |
| RabbitMQ Workers | ✅ Đúng | `workers/thumbnail_worker.rs`, `report_worker.rs` |
| CommandBus validate trước handle | ✅ Đúng | `command.rs:48` — `command.validate()` |
| Không có cron/scheduler | ✅ Đúng | Không có trong Cargo.toml và source |
| `rebuild()` còn `todo!()` | ✅ Đúng | `file_system/projections.rs:195` |
| Workers start qua `start_workers()` | ✅ Đúng | `main.rs:65-70` |

**Kết quả: 10/10 đúng.** Phân tích kiến trúc chính xác hoàn toàn.

### Điểm mạnh của thiết kế

```
✅ CommandBus validate AT APPLICATION LAYER (không chỉ HTTP layer)
   → Validation chạy dù command đến từ HTTP, queue hay job

✅ EventBus có graceful degradation (Redis → InMemory)
   → Dev local không cần Redis, production tự dùng Redis

✅ AggregateRoot với version-based optimistic locking
   → Tránh lost update race condition

✅ Worker spawn pattern (tokio::spawn trong start_workers)
   → Worker lỗi không crash cả application
```

### Điểm cần hoàn thiện

```
⚠️  Transactional Outbox chưa có
    → DB write + event publish CHƯA atomic
    → Nếu app crash sau DB write nhưng trước event publish → event lost
    → Fix: implement outbox table hoặc dùng CDC (Debezium)

⚠️  Projection runner chưa hoàn chỉnh
    → rebuild() là todo!()
    → Không có background task quét events để cập nhật read model
    → Fix: thêm projection runner task trong start_workers()

⚠️  Không có cron/scheduled jobs
    → Nếu cần jobs theo lịch (daily report, cleanup...) phải thêm
    → Option: tokio-cron-scheduler, apalis (Rust job queue)
```

---

## 10. Khi nào chọn gì?

```
┌─────────────────────────────────────────────────────────────┐
│                  DECISION FLOWCHART                         │
│                                                             │
│  Cần CQRS cho dự án mới?                                   │
│          │                                                  │
│          ▼                                                  │
│  Team background?                                           │
│  ├── Java/JVM team → Spring Boot (productivity cao hơn)    │
│  └── Rust/systems team → Rust + Axum                       │
│                                                             │
│  Performance requirements?                                  │
│  ├── >50k req/s hoặc RAM critical → Rust                   │
│  └── <20k req/s, RAM không lo → Spring Boot OK             │
│                                                             │
│  Time to market?                                            │
│  ├── Nhanh (startup, prototype) → Spring Boot              │
│  └── Long-term, performance-critical → Rust                │
│                                                             │
│  Domain complexity?                                         │
│  ├── Complex DDD với event sourcing → Cả hai đều làm được  │
│  └── Simple CRUD → Cả hai đều overkill, bỏ CQRS đi        │
└─────────────────────────────────────────────────────────────┘
```

---

## 11. Summary — "Một câu tổng kết"

> **Spring Boot CQRS:** Framework lo hết — developer khai báo intent, framework wiring. Ưu điểm là tốc độ phát triển. Nhược điểm là "magic" có thể hide lỗi đến runtime.

> **Rust CQRS:** Developer kiểm soát tất cả — traits định nghĩa contract, compiler enforce. Ưu điểm là safety tuyệt đối và performance vượt trội. Nhược điểm là verbose và learning curve cao.

> **Cả hai implement cùng một pattern** (Command, Query, Handler, Bus, EventBus) nhưng với triết lý khác nhau: **Spring = convention over configuration**, **Rust = explicitness over magic**.

---

## Liên kết
- [[CQRS-Materialized-View]] — CQRS tổng quan + read model
- [[Event-Sourcing]] — Event store + projection
- [[Transactional-Outbox]] — Đảm bảo atomicity write + event
- [[Bai-9-Async-Tokio]] — Tokio async model deep dive
- [[Bai-23-Workspace-Architecture]] — Rust workspace & module structure
