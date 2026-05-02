# Lộ trình Go Zero to Hero — Dành cho Java/Spring Boot Developer

> **Mục tiêu:** Thành thạo Go từ nền tảng đến production — microservices, frameworks hot nhất 2026, concurrency model, tooling ecosystem.

---

## 🧭 Tại sao Go? (Với background Java/Rust)

| Tiêu chí | Java Spring Boot | Rust Axum | **Go (Gin/Fiber/Echo)** |
|---|---|---|---|
| Startup time | 15–60 giây | <100ms | **<10ms** |
| Memory idle | 256–512 MB | 20–64 MB | **30–80 MB** |
| Throughput (HTTP) | ~50K req/s | ~150–250K req/s | **~100–200K req/s** |
| Concurrency model | Thread + lock | Ownership + async | **Goroutine + channel** |
| Learning curve | Medium | Steep | **Gentle** |
| Docker image | 250–600 MB | 15–50 MB | **10–30 MB** |
| GC | Stop-the-world | None (ownership) | **Tricolor incremental** |
| Build time | 30–120s | 60–300s | **<5s** |
| Deploy | JVM required | Native binary | **Native binary** |

**Go sweet spot:** Microservices cần deploy nhanh, scale horizontal, team lớn, DevOps-friendly.

---

## 🗺️ Lộ trình 4 Giai đoạn

```
┌─────────────────────────────────────────────────────────────────┐
│                  GO ZERO TO HERO — 22 BÀI                      │
├──────────────┬──────────────┬──────────────┬────────────────────┤
│  GIAI ĐOẠN 1 │  GIAI ĐOẠN 2 │  GIAI ĐOẠN 3 │   GIAI ĐOẠN 4     │
│   Foundation │ Intermediate │  Frameworks  │    Production      │
│   (Bài 1–5)  │  (Bài 6–10)  │  (Bài 11–16) │   (Bài 17–22)     │
├──────────────┼──────────────┼──────────────┼────────────────────┤
│ Go Mindset   │ Interfaces & │ Gin Core     │ Kafka + Sarama     │
│ Syntax/Types │ Generics     │ Gin Advanced │ gRPC               │
│ Goroutines & │ Context &    │ Fiber        │ Config/Log/Trace   │
│ Channels     │ Cancellation │ Echo         │ Redis Caching      │
│ Error/defer  │ Testing &    │ Chi + Clean  │ Docker & Deploy    │
│ Modules/Tool │ Benchmarking │ Architecture │ Microservices Arch │
│              │ net/http     │ Framework    │                    │
│              │ GORM + PgSQL │ Comparison   │                    │
└──────────────┴──────────────┴──────────────┴────────────────────┘
```

---

## 📚 Giai đoạn 1 — Foundation (Bài 1–5)

### Bài 1: [[Bai-1-Go-Mindset|Go Mindset — Chuyển tư duy từ Java/Rust sang Go]]
> Goroutine vs Thread, GC model, triết lý thiết kế Go, workspace setup

### Bài 2: [[Bai-2-Syntax-Types-Structs|Syntax, Types, Structs & Methods]]
> Variables, zero values, structs, methods, pointers, arrays/slices/maps

### Bài 3: [[Bai-3-Goroutines-Channels|Goroutines & Channels — Go Concurrency Model]]
> go keyword, channel, select, WaitGroup, Mutex, fan-out/fan-in patterns

### Bài 4: [[Bai-4-Error-Defer-Panic|Error Handling, defer, panic & recover]]
> error interface, custom errors, errors.Is/As, defer stack, panic recovery

### Bài 5: [[Bai-5-Modules-Tooling|Packages, Modules & Go Tooling]]
> go mod, go workspace, build tags, go generate, linting, formatting

---

## 📚 Giai đoạn 2 — Intermediate (Bài 6–10)

### Bài 6: [[Bai-6-Interfaces-Generics|Interfaces Deep Dive & Generics (Go 1.18+)]]
> Implicit interfaces, embedding, type assertions, generics constraints

### Bài 7: [[Bai-7-Context-Cancellation|Context Package & Cancellation Patterns]]
> context.Background, WithCancel, WithTimeout, WithValue, propagation

### Bài 8: [[Bai-8-Testing-Benchmarking|Testing, Table-driven Tests & Benchmarking]]
> testing package, testify, mock, benchmark, go test -race

### Bài 9: [[Bai-9-Net-Http-Deep|net/http Deep Dive — Standard Library]]
> Handler, ServeMux, middleware chaining, server config, HTTP/2

### Bài 10: [[Bai-10-GORM-PostgreSQL|GORM & PostgreSQL Integration]]
> GORM CRUD, migrations, associations, raw SQL, transactions, connection pool

---

## 📚 Giai đoạn 3 — Frameworks (Bài 11–16)

### Bài 11: [[Bai-11-Gin-Core|Gin Framework Core]]
> Routing, gin.Context, binding, validation, middleware, error handling

### Bài 12: [[Bai-12-Gin-Advanced|Gin Advanced — JWT, RBAC, File Upload, WebSocket]]
> JWT middleware, CORS, rate limiting, static files, graceful shutdown

### Bài 13: [[Bai-13-Fiber|Fiber Framework — Express-style, Zero Allocation]]
> Fasthttp core, fiber.Ctx, prefork mode, performance tuning

### Bài 14: [[Bai-14-Echo|Echo Framework — Clean & Balanced]]
> Echo router, standard context, group, auto-TLS, data binding

### Bài 15: [[Bai-15-Chi-Clean-Architecture|Chi + Clean Architecture]]
> Chi router, dependency injection, repository pattern, use case layer

### Bài 16: [[Bai-16-Framework-Comparison|Framework So Sánh & Decision Matrix]]
> Benchmark, ecosystem, khi nào dùng Gin/Fiber/Echo/Chi

---

## 📚 Giai đoạn 4 — Production (Bài 17–22)

### Bài 17: [[Bai-17-Kafka-Sarama|Kafka với Go — Sarama & confluent-kafka-go]]
> Producer/Consumer, consumer group, Kafka Streams alternative in Go

### Bài 18: [[Bai-18-gRPC|gRPC với Go — Protobuf, Unary & Streaming]]
> proto3, grpc-go, interceptors, server/client streaming, health check

### Bài 19: [[Bai-19-Config-Log-Trace|Config, Logging & Distributed Tracing]]
> Viper (config), Zap (structured log), OpenTelemetry, Jaeger

### Bài 20: [[Bai-20-Redis-Caching|Redis Caching & Distributed Locks]]
> go-redis, cache-aside, pub/sub, distributed lock (Redlock)

### Bài 21: [[Bai-21-Docker-Deploy|Docker & Deployment (Multi-stage Build)]]
> Dockerfile multi-stage, distroless, Kubernetes health check, env config

### Bài 22: [[Bai-22-Microservices-Patterns|Microservices Patterns trong Go]]
> Service discovery, circuit breaker, saga pattern, outbox pattern

---

## 🔧 Tech Stack của Series

```
┌─────────────────────────────────────────┐
│          GO TECH STACK 2026             │
├─────────────────────────────────────────┤
│  HTTP Frameworks                        │
│  ├── Gin      (★75K) — Most popular     │
│  ├── Fiber    (★35K) — Fastest          │
│  ├── Echo     (★30K) — Balanced         │
│  └── Chi      (★18K) — Clean arch       │
├─────────────────────────────────────────┤
│  ORM / Database                         │
│  ├── GORM     — Full-featured ORM       │
│  └── sqlx     — SQL + struct mapping    │
├─────────────────────────────────────────┤
│  Messaging                              │
│  └── Sarama   — Kafka client            │
├─────────────────────────────────────────┤
│  Observability                          │
│  ├── Zap      — Structured logging      │
│  ├── Viper    — Config management       │
│  └── OTEL     — OpenTelemetry           │
├─────────────────────────────────────────┤
│  Testing                                │
│  ├── testify  — Assertions & mocks      │
│  └── gomock   — Interface mocking       │
└─────────────────────────────────────────┘
```

---

## 📊 So sánh với Rust Series

| Aspect | Rust Zero-to-Hero | **Go Zero-to-Hero** |
|---|---|---|
| Core concept | Ownership & Borrowing | Goroutines & Channels |
| Main challenge | Borrow checker | Concurrency patterns |
| Web framework | Axum / Actix | Gin / Fiber / Echo / Chi |
| Database | SQLx / Diesel | GORM / sqlx |
| Async model | Tokio (explicit async) | Goroutines (implicit) |
| Error handling | Result<T,E> | (value, error) pair |
| Learning time | 6–12 tháng | **2–4 tháng** |

---

## 🎯 Curriculum đầy đủ
Xem [[Curriculum-Full]] để biết tất cả topics theo layer.

---

*Tip: Go có triết lý "less is more" — code đơn giản, rõ ràng hơn Java rất nhiều. Hãy resist the urge to over-engineer!*
