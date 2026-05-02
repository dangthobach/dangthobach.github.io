# Go Zero-to-Hero — Curriculum Full (22 Bài)

> Series hoàn chỉnh dành cho Java/Spring Boot developer muốn master Go trong môi trường production.

---

## Tổng quan

| Metric | Giá trị |
|---|---|
| Tổng số bài | 22 bài |
| Phases | 4 phases |
| Thời lượng ước tính | ~11 tuần (2 bài/tuần) |
| Level | Intermediate → Advanced |
| Target | Java/Spring Boot developer → Go production |

---

## Phase 1 — Foundation (Bài 1–5)

> **Goal:** Hiểu tư duy Go, type system, concurrency primitives

| Bài | Tên | Thời lượng | Status |
|---|---|---|---|
| [[Bai-1-Go-Mindset\|Bài 1]] | Go Mindset & Setup | 3h | ✅ Done |
| [[Bai-2-Syntax-Types-Structs\|Bài 2]] | Syntax, Types & Structs | 4h | ✅ Done |
| [[Bai-3-Goroutines-Channels\|Bài 3]] | Goroutines & Channels | 5h | ✅ Done |
| [[Bai-4-Error-Defer-Panic\|Bài 4]] | Error Handling, defer & panic | 3h | ✅ Done |
| [[Bai-5-Modules-Tooling\|Bài 5]] | Packages, Modules & Tooling | 2h | ✅ Done |

**Phase 1 Total:** ~17h

---

## Phase 2 — Intermediate (Bài 6–10)

> **Goal:** Interface system, context, testing, HTTP & database

| Bài | Tên | Thời lượng | Status |
|---|---|---|---|
| [[Bai-6-Interfaces-Generics\|Bài 6]] | Interfaces Deep Dive & Generics | 4h | ✅ Done |
| [[Bai-7-Context-Cancellation\|Bài 7]] | Context Package & Cancellation | 3h | ✅ Done |
| [[Bai-8-Testing-Benchmarking\|Bài 8]] | Testing, Table-driven & Benchmark | 4h | ✅ Done |
| [[Bai-9-Net-Http-Deep\|Bài 9]] | net/http Deep Dive | 3h | ✅ Done |
| [[Bai-10-GORM-PostgreSQL\|Bài 10]] | GORM & PostgreSQL | 4h | ✅ Done |

**Phase 2 Total:** ~18h

---

## Phase 3 — Frameworks (Bài 11–16)

> **Goal:** Gin, Fiber, Echo, Chi — pick the right framework

| Bài | Tên | Thời lượng | Status |
|---|---|---|---|
| [[Bai-11-Gin-Core\|Bài 11]] | Gin Core — Routing, Binding, Middleware | 4h | ✅ Done |
| [[Bai-12-Gin-Advanced\|Bài 12]] | Gin Advanced — JWT, CORS, Rate Limit, WS | 4h | ✅ Done |
| [[Bai-13-Fiber\|Bài 13]] | Fiber — Zero-allocation, Prefork | 3h | ✅ Done |
| [[Bai-14-Echo\|Bài 14]] | Echo — Standard Context, Auto-TLS | 3h | ✅ Done |
| [[Bai-15-Chi-Clean-Architecture\|Bài 15]] | Chi + Clean Architecture | 5h | ✅ Done |
| [[Bai-16-Framework-Comparison\|Bài 16]] | Framework So Sánh & Decision Matrix | 2h | ✅ Done |

**Phase 3 Total:** ~21h

---

## Phase 4 — Production (Bài 17–22)

> **Goal:** Kafka, gRPC, Observability, Redis, Docker, Microservices Patterns

| Bài | Tên | Thời lượng | Status |
|---|---|---|---|
| [[Bai-17-Kafka-Sarama\|Bài 17]] | Kafka với Sarama — Producer, Consumer Group, DLQ | 5h | ✅ Done |
| [[Bai-18-gRPC\|Bài 18]] | gRPC — Protobuf, Streaming, Interceptors | 5h | ✅ Done |
| [[Bai-19-Config-Log-Trace\|Bài 19]] | Config (Viper), Logging (Zap), Tracing (OTEL) | 4h | ✅ Done |
| [[Bai-20-Redis-Caching\|Bài 20]] | Redis — Cache-aside, Distributed Lock, Pub/Sub | 3h | ✅ Done |
| [[Bai-21-Docker-Deploy\|Bài 21]] | Docker Multi-stage, CI/CD, Kubernetes | 5h | ✅ Done |
| [[Bai-22-Microservices-Patterns\|Bài 22]] | Saga, Outbox, Circuit Breaker, Service Discovery | 5h | ✅ Done |

**Phase 4 Total:** ~27h

---

## Tổng thời lượng: ~83 giờ học

---

## Framework Decision Cheatsheet

```
Gin   → General REST API, biggest community (★75K)
Fiber → Max throughput, Linux prefork
Echo  → Auto-TLS, standard context
Chi   → Clean Architecture, net/http compatible
```

---

## Stack Reference cho PDMS Project

```
HTTP Framework:  Gin (★75K, Keycloak OAuth compat)
ORM:            GORM + PostgreSQL
Messaging:      Kafka (Sarama)
Cache:          Redis (go-redis)
Config:         Viper
Logging:        Zap (structured JSON)
Tracing:        OpenTelemetry → Jaeger
Metrics:        Prometheus + Grafana
Auth:           JWT (golang-jwt) + Keycloak
gRPC:           protoc-gen-go + google.golang.org/grpc
Testing:        testify + gomock + testcontainers
Linter:         golangci-lint
Deploy:         Docker multi-stage → distroless → K8s
```

---

## Học Path Gợi ý

```
Tuần 1:  Bài 1, 2
Tuần 2:  Bài 3, 4
Tuần 3:  Bài 5, 6
Tuần 4:  Bài 7, 8
Tuần 5:  Bài 9, 10
Tuần 6:  Bài 11, 12
Tuần 7:  Bài 13, 14
Tuần 8:  Bài 15, 16
Tuần 9:  Bài 17, 18
Tuần 10: Bài 19, 20
Tuần 11: Bài 21, 22
```

---

## Related Series trong Vault

- [[Rust-Zero-To-Hero/|Rust Zero-to-Hero]] — Systems programming
- [[JVM-Frameworks-2026/|JVM Frameworks 2026]] — Quarkus, Micronaut, Vert.x
- [[Microservices-Patterns/|Microservices Patterns]] — Architecture deep dive
- [[concepts/|Concepts]] — Foundational CS concepts

---
*Tags: #go #zero-to-hero #curriculum #roadmap*
