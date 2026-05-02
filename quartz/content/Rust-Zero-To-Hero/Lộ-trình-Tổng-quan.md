# Lộ trình Rust Zero to Hero cho Chuyên gia Java/Spring Boot

Lộ trình này tập trung vào việc chuyển đổi tư duy từ **Managed Memory (GC)** sang **Ownership/Borrowing** và xây dựng Web Backend hiệu năng cao.

---

## ✅ Giai đoạn 1–2: Nền tảng
- [[Bai-1-Ownership-Mindset|Bài 1: Ownership Mindset]]
- [[Bai-2-Borrowing-Multi-threading|Bài 2: Borrowing & Multi-threading]]
- [[Bai-3-Struct-Enum-Trait|Bài 3: Struct, Enum & Trait]]
- [[Bai-4-Error-Handling-Collections|Bài 4: Error Handling & Collections]]

## ✅ Giai đoạn 3: Language Deep Dive
- [[Bai-5-Lifetimes|Bài 5: Lifetimes]]
- [[Bai-6-Generics-Traits-Advanced|Bài 6: Generics & Trait Objects]]
- [[Bai-7-Closures-Iterators|Bài 7: Closures & Iterators]]
- [[Bai-8-Smart-Pointers-Error-Design|Bài 8: Smart Pointers & Error Design]]

## ✅ Giai đoạn 4–5: Async & Web
- [[Bai-9-Async-Tokio|Bài 9: Async/Await & Tokio]]
- [[Bai-10-Axum-Core|Bài 10: Axum Core]]
- [[Bai-11-Axum-Middleware-Error|Bài 11: Axum Middleware]]

## ✅ Giai đoạn 6–7: Integration & Production
- [[Bai-12-SQLx-Database|Bài 12: SQLx]]
- [[Bai-13-Serde-Reqwest-JWT|Bài 13: Serde + reqwest + JWT]]
- [[Bai-14-Kafka-rdkafka|Bài 14: Kafka]]
- [[Bai-15-Config-Tracing-Testing|Bài 15: Config + Tracing + Testing]]
- [[Bai-16-Deployment|Bài 16: Deployment]]

## ✅ Giai đoạn 8: Advanced — Kỹ thuật & Tối ưu
- [[Bai-17-Zero-Cost-Performance|Bài 17: Zero-cost Abstractions & Performance Optimization]]
- [[Bai-18-Type-System-Advanced|Bài 18: Type System nâng cao — Phantom Types, Typestate, GAT]]
- [[Bai-19-Unsafe-FFI|Bài 19: Unsafe Rust & FFI]]
- [[Bai-20-Macro-System|Bài 20: Macro System — macro_rules! & proc-macro]]
- [[Bai-21-Async-Internals-Pin|Bài 21: Async Internals — Pin, Waker & Custom Futures]]
- [[Bai-22-Advanced-Concurrency|Bài 22: Advanced Concurrency — Atomics, Lock-free & Rayon]]
- [[Bai-23-Workspace-Architecture|Bài 23: Workspace Architecture & Crate Design]]

---

## 🗺️ Curriculum đầy đủ
Xem [[Curriculum-Full]] để biết tất cả topics theo layer.

---

## 📊 Java vs Rust — Tổng kết

| Khía cạnh | Java Spring Boot | Rust Axum |
|---|---|---|
| Memory model | GC (runtime) | Ownership (compile-time) |
| State validation | Runtime exception | Typestate (compile-time) |
| Serialization | Jackson reflection ~2-5µs | Serde codegen ~0.3-0.8µs |
| HTTP throughput | ~50K req/s | ~150-250K req/s |
| Kafka consumer | Thread/partition (~1MB) | Task/message (~8KB) |
| Docker image | 250-600MB | 15-50MB |
| Startup time | 15-60 giây | <100ms |
| Memory idle | 256-512MB | 20-64MB |
| CPU parallelism | ForkJoinPool + Stream | Rayon par_iter() |
| Metaprogramming | APT + reflection | proc-macro + zero overhead |
| Concurrency model | Thread + lock | Ownership + async + atomics |

---
*Lưu ý: Dùng `cargo check` thường xuyên, `cargo clippy -- -D warnings` trước commit.*
