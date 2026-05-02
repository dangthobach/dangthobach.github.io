---
tags: [moc, rust]
---

# 🦀 Rust MOC

Map of Content cho toàn bộ Rust knowledge. Đây là entry point — không phải nơi lưu kiến thức.

---

## 📖 Learning Series
- [[Rust-Zero-To-Hero/Lộ-trình-Tổng-quan|Lộ trình tổng quan]] — Giai đoạn 1→5
- [[Rust-Zero-To-Hero/Bai-1-Ownership-Mindset|Bài 1: Ownership Mindset]]
- [[Rust-Zero-To-Hero/Bai-2-Borrowing-Multi-threading|Bài 2: Borrowing & Multi-threading]]
- [[Rust-Zero-To-Hero/Bai-3-Struct-Enum-Trait|Bài 3: Struct, Enum & Trait]]
- [[Rust-Zero-To-Hero/Bai-4-Error-Handling-Collections|Bài 4: Error Handling & Collections]]

---

## 🧱 Core Concepts
### Memory & Ownership
- `Ownership` — 1 owner, drop khi ra khỏi scope
- `Borrowing` — `&T` immutable, `&mut T` mutable, không đồng thời
- `Lifetimes` — compiler đảm bảo không dangling pointer
- `Stack vs Heap` — tường minh hơn Java

### Smart Pointers
- `Box<T>` — heap allocation, single owner
- `Rc<T>` — reference counting, single-thread
- `Arc<T>` — atomic ref count, multi-thread ≈ [[AtomicReference]] Java
- `Mutex<T>` / `RwLock<T>` — interior mutability

### Type System
- `Struct` — thay Class, không có inheritance
- `Enum` — Algebraic Data Types, mạnh hơn Java enum nhiều
- `Trait` — thay Interface, hỗ trợ ad-hoc polymorphism
- `Option<T>` — thay null
- `Result<T, E>` — thay Exception

---

## ⚡ Async & Concurrency
- `async/await` — zero-cost abstraction trên futures
- `tokio` — async runtime, tương tự Spring WebFlux reactor
- `tokio::spawn` ≈ [[CompletableFuture]] / Virtual Threads Java
- `Arc<Mutex<T>>` — shared state across tasks

---

## 🌐 Web Backend (Axum)
- `axum` — web framework trên tokio, tương tự Spring MVC
- `tower` — middleware ecosystem
- `serde` — serialization/deserialization
- `sqlx` — compile-time checked SQL ≈ JPA nhưng explicit hơn

---

## 📦 Ecosystem
- `rdkafka` — Kafka client
- `lapin` — RabbitMQ client
- `reqwest` — HTTP client
- `tokio-cron-scheduler` — scheduled tasks

---

## 🔗 Cross-language Links
- [[MOC-Concurrency]] — Rust async ↔ Java threads ↔ Virtual Threads
- [[MOC-Memory-Model]] — Ownership ↔ GC mental model
- [[MOC-Java]] — mapping concepts sang Java tương đương
