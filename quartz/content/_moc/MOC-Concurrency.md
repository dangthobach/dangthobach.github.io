---
tags: [moc, concurrency, threading, async, cross-language]
---

# ⚡ MOC — Concurrency

> **Mục tiêu:** Cross-language mapping — Java threading model ↔ Rust async model. Hiểu tại sao cùng một concept lại được implement khác nhau và trade-off của từng approach.

---

## 🧠 Nền tảng khái niệm

- [[Notion Knowledge/Note/Concurrency is NOT Parallelism|Concurrency ≠ Parallelism]]
  → Rob Pike's definition. Concurrency = cấu trúc chương trình. Parallelism = thực thi đồng thời. Goroutine model vs thread model.

---

## ☕ Java Side

### Threading Model
| Concept | Chi tiết |
|---|---|
| Platform Thread | OS thread, 1:1 mapping, ~1MB stack, expensive context switch |
| Virtual Thread (Loom) | Mounted lên carrier thread, unmount khi block, ~KB overhead |
| Deep Dive Loom | [[concepts/java-virtual-threads-deep-dive\|Java Virtual Threads: Bản chất & Cơ chế]] |
| `CompletableFuture` | Async composition, callback chain, không block thread |
| `ExecutorService` | Thread pool management, `ForkJoinPool` work-stealing |

### Shared State
| Type | Use Case |
|---|---|
| `AtomicReference<T>` | Lock-free shared reference — Rust analog: `Arc<T>` |
| `synchronized` / `ReentrantLock` | Mutual exclusion — Rust analog: `Mutex<T>` |
| `ReadWriteLock` | Multiple readers OR one writer — Rust analog: `RwLock<T>` |
| `volatile` | Visibility guarantee, no atomicity — Rust analog: `Atomic*` types |
| `BlockingQueue` | Producer-consumer — Rust analog: `tokio::sync::mpsc` |

### Spring Context
- `@Async` → Thread pool executor, cần `@EnableAsync`
- Reactive (`WebFlux`) → Project Reactor, Mono/Flux, backpressure
- Virtual Threads → `spring.threads.virtual.enabled=true` (Spring Boot 3.2+)

---

## 🦀 Rust Side

### Async Model
| Concept | Chi tiết |
|---|---|
| `Future` trait | Polling model, cooperative scheduling |
| `async/await` | Syntactic sugar, compiles to state machine |
| Tokio task | ~8KB, cooperative yield tại `.await` |
| `tokio::spawn` | Spawn task lên runtime, parallel execution |
| `tokio::join!` | Concurrent futures, wait all |
| `tokio::select!` | Race futures, take first result |

### Shared State (Multi-thread safe)
| Type | Use Case | Java Analog |
|---|---|---|
| `Arc<T>` | Shared ownership, read-only | `AtomicReference<T>` |
| `Arc<Mutex<T>>` | Shared mutable, exclusive | `synchronized` / `Lock` |
| `Arc<RwLock<T>>` | Shared mutable, readers/writer | `ReadWriteLock` |
| `tokio::sync::mpsc` | Message passing | `BlockingQueue` |
| `tokio::sync::broadcast` | Fan-out | Pub-Sub |
| `tokio::sync::watch` | Latest-value sharing | Spring `@Value` + refresh |
| `tokio::sync::Semaphore` | Concurrency limiting | `Semaphore` |

---

## 🔁 Cross-language Mapping Table

| Scenario | Java | Rust |
|---|---|---|
| Run code async | `CompletableFuture.supplyAsync(fn)` | `tokio::spawn(async { fn().await })` |
| Wait multiple | `CompletableFuture.allOf(a, b)` | `tokio::join!(a, b)` |
| Race / timeout | — | `tokio::select!` |
| Shared counter | `AtomicLong` | `Arc<Mutex<i64>>` hoặc `AtomicI64` |
| Shared map | `ConcurrentHashMap` | `Arc<RwLock<HashMap>>` |
| Channel | `LinkedBlockingQueue` | `tokio::sync::mpsc::channel` |
| CPU-bound work | `ForkJoinPool` | `tokio::task::spawn_blocking` |
| Lightweight threads | Virtual Threads | Tokio tasks |
| Memory/task (idle) | ~500KB–2MB (VT) | ~8KB–64KB (Task) |

---

## ⚠️ Common Pitfalls

### Java
- Virtual Thread + `synchronized` block → thread pinning (carrier thread blocked)
- `CompletableFuture` exception swallowing nếu không `.exceptionally()`
- ThreadLocal bị mất khi Virtual Thread migrates

### Rust
- `std::sync::Mutex` trong async context → deadlock khi lock held across `.await`
- Sử dụng `tokio::sync::Mutex` khi cần hold lock qua `.await`
- `std::thread::sleep` trong async fn → blocks executor thread

---

## 📚 Reference Notes

- [[Notion Knowledge/Note/Concurrency is NOT Parallelism|Concurrency ≠ Parallelism]] — conceptual foundation
- [[Rust-Zero-To-Hero/Bai-2-Borrowing-Multi-threading|Bài 2: Borrowing & Multithreading]] — Rust basics
- [[Rust-Zero-To-Hero/Bai-8-Smart-Pointers-Error-Design|Bài 8: Arc/Mutex patterns]] — Rust shared state
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9: Tokio Runtime]] — Rust async deep dive

---

## 🔗 Liên kết

- [[MOC-Rust]] — Rust concurrency chi tiết
- [[MOC-Java]] — Java threading chi tiết
- [[MOC-Memory-Model]] — Memory safety trong concurrent context
- [[MOC-PDMS]] — High-concurrency challenges tại PDMS

---

## ⚡ Reactive Concepts (Atomic Notes)
- [[concepts/reactive-programming-fundamentals|Reactive Programming Fundamentals]]
- [[concepts/event-loop-model|Event Loop Model]]
- [[concepts/backpressure-explained|Backpressure Explained]]

---

## 📌 Thực hành — Rust Concurrency: Lộ trình đọc theo bài

> Các bài trong `Rust-Zero-To-Hero` ánh xạ 1:1 sang các section trong MOC này — đọc theo thứ tự sau:

| Thứ tự | Bài | Nội dung | Liên quan tới section |
|--------|-----|---------|----------------------|
| 1 | [[Rust-Zero-To-Hero/Bai-2-Borrowing-Multi-threading\|Bài 2: Borrowing & Multi-threading]] | `Send`/`Sync` traits, data race prevention at **compile time** — điều Java không có | Shared State — Rust side |
| 2 | [[Rust-Zero-To-Hero/Bai-8-Smart-Pointers-Error-Design\|Bài 8: Smart Pointers]] | `Arc<Mutex<T>>` pattern đầy đủ, khi nào `Rc` vs `Arc`, interior mutability | Cross-language Mapping Table |
| 3 | [[Rust-Zero-To-Hero/Bai-9-Async-Tokio\|Bài 9: Async/Tokio]] | Runtime, `join!`, `select!`, tất cả channel types (`mpsc`, `broadcast`, `watch`, `oneshot`) | Async Model table — **đọc trước Bài 21** |
| 4 | [[Rust-Zero-To-Hero/Bai-21-Async-Internals-Pin\|Bài 21: Async Internals & Pin]] | State machine compiler-generated, `Pin<P>` tại sao cần, Waker mechanism, `JoinSet` structured concurrency | Tại sao task chỉ ~8KB thay vì ~1MB |
| 5 | [[Rust-Zero-To-Hero/Bai-22-Advanced-Concurrency\|Bài 22: Advanced Concurrency]] | `rayon` parallelism, lock-free `DashMap`, crossbeam channels, `AtomicUsize` | Beyond async — CPU-bound work |

---

## 📌 Thực hành — Rust Concurrency: Lộ trình đọc theo bài

> Các bài trong `Rust-Zero-To-Hero` ánh xạ 1:1 sang các section trong MOC này — đọc theo thứ tự sau:

| Thứ tự | Bài | Nội dung | Liên quan tới |
|--------|-----|---------|--------------|
| 1 | [[Rust-Zero-To-Hero/Bai-2-Borrowing-Multi-threading\|Bài 2: Borrowing & Multi-threading]] | `Send`/`Sync` traits, data race prevention at **compile time** | Shared State — Rust side |
| 2 | [[Rust-Zero-To-Hero/Bai-8-Smart-Pointers-Error-Design\|Bài 8: Smart Pointers]] | `Arc<Mutex<T>>` pattern, `Rc` vs `Arc`, interior mutability | Cross-language Mapping Table |
| 3 | [[Rust-Zero-To-Hero/Bai-9-Async-Tokio\|Bài 9: Async/Tokio]] | Runtime, `join!`, `select!`, tất cả channel types | Async Model table — **đọc trước Bài 21** |
| 4 | [[Rust-Zero-To-Hero/Bai-21-Async-Internals-Pin\|Bài 21: Async Internals & Pin]] | State machine compiler-generated, `Pin<P>`, Waker, `JoinSet` | Tại sao Tokio task chỉ ~8KB vs ~1MB thread |
| 5 | [[Rust-Zero-To-Hero/Bai-22-Advanced-Concurrency\|Bài 22: Advanced Concurrency]] | `rayon` parallelism, lock-free `DashMap`, crossbeam, `AtomicUsize` | CPU-bound work — beyond async |
