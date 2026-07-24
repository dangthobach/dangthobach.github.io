---
tags: [moc, rust]
type: moc
domain: knowledge-management
status: active
created: 2026-04-12
updated: 2026-04-12
---

# 🦀 Rust MOC

Map of Content cho toàn bộ Rust knowledge. Đây là entry point — không phải nơi lưu kiến thức.

---

## 📖 Learning Series
- [[Lộ-trình-Tổng-quan|Lộ trình tổng quan]] — Giai đoạn 1→5
- [[Bai-1-Ownership-Mindset|Bài 1: Ownership Mindset]]
- [[Bai-2-Borrowing-Multi-threading|Bài 2: Borrowing & Multi-threading]]
- [[Bai-3-Struct-Enum-Trait|Bài 3: Struct, Enum & Trait]]
- [[Bai-4-Error-Handling-Collections|Bài 4: Error Handling & Collections]]

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
- `Arc<T>` — atomic ref count, multi-thread ≈ AtomicReference *(planned)* Java
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
- `tokio::spawn` ≈ CompletableFuture *(planned)* / Virtual Threads Java
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

## 🔄 Technology Updates

- [[Bai-48-Rust-1.97-Technology-Update|Rust 1.97 — Technology Update]]
- [[Bai-49-Rust-Framework-Radar-2026|Rust Framework Radar 2026]]
- [[Bai-50-Tokio-1.52-Runtime-Update|Tokio 1.52 Runtime Update]]
- [[Bai-51-Axum-0.8.9-Production-Update|Axum 0.8.9 Production Update]]
- [[Bai-52-Actix-Web-2026-Update|Actix Web 2026 Update]]
- [[Bai-53-SQLx-0.8-Diesel-2.3-Update|SQLx 0.8 & Diesel 2.3]]
- [[Bai-54-Tonic-0.14-Production-gRPC|Tonic 0.14 Production gRPC]]
- [[Bai-55-Leptos-0.8-Migration|Leptos 0.8 Migration]]
- [[Bai-56-Dioxus-0.7-to-0.8-Watchlist|Dioxus 0.7/0.8 Watchlist]]
