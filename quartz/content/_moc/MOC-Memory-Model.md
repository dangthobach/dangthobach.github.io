---
tags: [moc, memory, rust, java]
type: moc
domain: knowledge-management
status: active
created: 2026-04-12
updated: 2026-07-06
---

# 🧠 Memory Model MOC

Cross-language: GC (Java) vs Ownership (Rust).

---

## Java Memory Model
- **Heap** — tất cả objects, GC quản lý
- **Stack** — local variables, method frames
- **GC** — Mark-and-sweep, G1GC, ZGC (low-latency)
- **Stop-the-world** — GC pause, vấn đề với latency-sensitive systems

## Rust Memory Model
- **Ownership** — mỗi value có đúng 1 owner, drop khi owner ra scope
- **Borrowing** — mượn reference, compiler kiểm tra tại compile-time
- **Stack-first** — prefer stack, heap chỉ khi cần (`Box<T>`)
- **No GC** — zero runtime overhead, predictable latency

---

## 🔁 Key Differences

| | Java | Rust |
|---|---|---|
| Memory mgmt | GC (runtime) | Ownership (compile-time) |
| Null safety | `NullPointerException` | `Option<T>` — không có null |
| Sharing | Reference freely | `Arc<T>` + explicit ownership |
| Dangling ptr | GC prevents | Borrow checker prevents |
| Latency | GC pause possible | Predictable, no pause |

---

## Smart Pointers (Rust)

| Type | Use case | Java analog |
|---|---|---|
| `Box<T>` | Heap alloc, single owner | `new Object()` |
| `Rc<T>` | Ref count, single-thread | — |
| `Arc<T>` | Ref count, multi-thread | `AtomicReference` |
| `Cell<T>` | Interior mutability, Copy | — |
| `RefCell<T>` | Interior mutability, runtime check | — |

---

## 🔗 Links
- [[MOC-Rust]] — Rust memory concepts chi tiết
- [[MOC-Concurrency]] — memory safety trong concurrent context

- [[concepts/gc-llvm-runtime-cpu-memory-internals]] — cơ chế GC/LLVM/native code ở mức CPU, đo runtime overhead
- [[concepts/Rust-Java-Build-Compile-Deploy-Memory-Timeline]] — timeline build/compile/JIT warm-up theo giây + bộ nhớ thực tế khi deploy trên container/K8s (OOMKilled, resource sizing)
