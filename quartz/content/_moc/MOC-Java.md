---
tags: [moc, java, spring]
---

# ☕ Java MOC

Map of Content cho Java/Spring ecosystem knowledge.

---

## 🌱 Spring Ecosystem
### Spring Boot / MVC
- `@RestController`, `@Service`, `@Repository` — layered architecture
- `Spring AOP` — proxy mechanism, `@Around`, `@Before`
- `Spring Security` — filter chain, JWT, jCasbin RBAC/ABAC

### Spring Cloud
- `Spring Cloud Gateway` — API Gateway, routing, filters
- `Resilience4J` — Circuit Breaker, TimeLimiter, Retry
- `Eureka` / Service Discovery

### Spring Data
- `JPA/Hibernate` — ORM, entity lifecycle, session management
- `N+1 Query Problem` — và cách giải quyết
- `@Transactional` — propagation, isolation levels

---

## ⚡ Concurrency
- [[java-virtual-threads-deep-dive|Virtual Threads (Java 21) Deep Dive]] — Project Loom, cơ chế Mount/Unmount
- `CompletableFuture` — async composition
- `AtomicReference` — lock-free shared state ≈ [[Arc<T>]] Rust
- `ExecutorService`, `ThreadPoolExecutor`

---

## 🏗️ Architecture Patterns
- `CQRS` — Command Query Responsibility Segregation
- `Event Sourcing` — base repository pattern
- `Transactional Outbox` — đảm bảo at-least-once với Kafka
- `Saga Pattern` — distributed transactions

---

## 🔗 Cross-language Links
- [[MOC-Rust]] — Java concepts ↔ Rust equivalents
- [[MOC-Concurrency]] — threading model comparison
- [[MOC-Distributed-Systems]] — patterns dùng trong Spring microservices


---

## 🚀 Modern JVM Frameworks 2026
- [[MOC-JVM-Frameworks|MOC-JVM-Frameworks]] — Master roadmap 24 tuần
- [[00 Weekly Study Log|📅 Weekly Study Log]] — Ghi chép tiến độ
- [[00 Quarkus Overview|⬡ Quarkus]] — Tuần 1–8
- [[00 Micronaut Overview|◈ Micronaut]] — Tuần 9–14
- [[00 Vertx Overview|△ Vert.x]] — Tuần 15–20
- [[00 RxJava Overview|◎ RxJava]] — Tuần 21–24


---

## 🧠 Atomic Concepts
- [[compile-time-vs-runtime-di|Compile-time vs Runtime DI]] — Spring vs Quarkus vs Micronaut
- [[native-image-aot-jit|Native Image, AOT vs JIT]] — GraalVM, production tradeoffs
- [[reactive-programming-fundamentals|Reactive Programming Fundamentals]]
- [[event-loop-model|Event Loop Model]]
- [[backpressure-explained|Backpressure Explained]]
