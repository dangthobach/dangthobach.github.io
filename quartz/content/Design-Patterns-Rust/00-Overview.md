# GoF Design Patterns in Rust — Series Overview

> **Tại sao Rust thay đổi Design Patterns?**
> GoF patterns được viết cho ngôn ngữ OOP với GC và class-based inheritance (C++, Java, Smalltalk). Rust không có inheritance, không có null, không có GC, không có runtime reflection. Nhiều patterns được implement khác hoàn toàn — thậm chí một số patterns trở nên **tự nhiên hơn** hoặc **không cần thiết** trong Rust.

---

## Rust vs OOP: Khác Biệt Nền Tảng

```
Java/C++ OOP                    Rust
─────────────────────────────────────────────────────
class + inheritance        →    struct + trait + composition
virtual dispatch           →    dyn Trait (explicit) hoặc generics
null reference             →    Option<T> (no null)
GC / RAII                  →    Ownership + Drop (deterministic)
shared mutable state       →    Arc<Mutex<T>> (explicit)
runtime reflection         →    Traits + macros (compile-time)
abstract class             →    Trait với default methods
interface                  →    Trait
```

---

## 23 Patterns — Rust Difficulty & Transformation

### 🏗️ Creational (5 patterns)
→ *Tạo objects. Rust: ownership thay đổi cách "create & transfer"*

| Pattern | Rust Transformation | Difficulty |
|---------|---------------------|------------|
| [[Design-Patterns-Rust/01-Creational\|Singleton]] | `OnceLock<T>` / `LazyLock<T>` — không dùng static mut | ⭐⭐ |
| [[Design-Patterns-Rust/01-Creational\|Factory Method]] | Trait với associated type, hoặc `fn() -> impl Trait` | ⭐⭐ |
| [[Design-Patterns-Rust/01-Creational\|Abstract Factory]] | Trait returning trait objects / generic factory | ⭐⭐⭐ |
| [[Design-Patterns-Rust/01-Creational\|Builder]] | **Idiomatic Rust** — typestate builder với compile-time validation | ⭐⭐⭐ |
| [[Design-Patterns-Rust/01-Creational\|Prototype]] | `Clone` trait — built into language | ⭐ |

### 🔧 Structural (7 patterns)
→ *Kết hợp objects/classes. Rust: composition over inheritance*

| Pattern | Rust Transformation | Difficulty |
|---------|---------------------|------------|
| [[Design-Patterns-Rust/02-Structural\|Adapter]] | Newtype wrapper + trait impl | ⭐⭐ |
| [[Design-Patterns-Rust/02-Structural\|Bridge]] | Generics + trait separation | ⭐⭐⭐ |
| [[Design-Patterns-Rust/02-Structural\|Composite]] | Enum recursion hoặc `Box<dyn Trait>` tree | ⭐⭐⭐ |
| [[Design-Patterns-Rust/02-Structural\|Decorator]] | Newtype wrapping trait — tự nhiên với ownership | ⭐⭐ |
| [[Design-Patterns-Rust/02-Structural\|Facade]] | Module với re-exported public API | ⭐ |
| [[Design-Patterns-Rust/02-Structural\|Flyweight]] | `Arc<T>` shared immutable data | ⭐⭐ |
| [[Design-Patterns-Rust/02-Structural\|Proxy]] | `Deref` trait + wrapper struct | ⭐⭐⭐ |

### 🎭 Behavioral (11 patterns)
→ *Communication giữa objects. Rust: ownership makes some patterns hard, some trivial*

| Pattern | Rust Transformation | Difficulty |
|---------|---------------------|------------|
| [[Design-Patterns-Rust/03-Behavioral\|Chain of Responsibility]] | `Vec<Box<dyn Handler>>` hoặc function chaining | ⭐⭐ |
| [[Design-Patterns-Rust/03-Behavioral\|Command]] | Closure hoặc trait object — Rust closures = first-class | ⭐⭐ |
| [[Design-Patterns-Rust/03-Behavioral\|Iterator]] | **Built-in** `Iterator` trait — richest in any language | ⭐ |
| [[Design-Patterns-Rust/03-Behavioral\|Mediator]] | Channel-based (Tokio mpsc) — async-native | ⭐⭐⭐ |
| [[Design-Patterns-Rust/03-Behavioral\|Memento]] | Serialize/Clone state — serde integration | ⭐⭐ |
| [[Design-Patterns-Rust/03-Behavioral\|Observer]] | Channel pub/sub hoặc callback Vec | ⭐⭐⭐ |
| [[Design-Patterns-Rust/03-Behavioral\|State]] | **Typestate pattern** — state encoded in type system | ⭐⭐⭐⭐ |
| [[Design-Patterns-Rust/03-Behavioral\|Strategy]] | Trait objects hoặc closures — ergonomic | ⭐⭐ |
| [[Design-Patterns-Rust/03-Behavioral\|Template Method]] | Trait với default method hooks | ⭐⭐ |
| [[Design-Patterns-Rust/03-Behavioral\|Visitor]] | Enum + match hoặc `trait Visitor` | ⭐⭐⭐ |
| [[Design-Patterns-Rust/03-Behavioral\|Interpreter]] | Recursive enum AST + eval | ⭐⭐⭐ |

---

## Patterns "Biến Mất" Hoặc Đơn Giản Hóa Trong Rust

```
❌ Không cần nữa:
  - Null Object Pattern  → Option<T> thay thế hoàn toàn
  - RAII (không phải GoF nhưng C++ pattern) → Ownership tự động

✅ Built-in vào language:
  - Iterator Pattern    → std::iter::Iterator trait với 80+ combinators
  - Prototype Pattern   → #[derive(Clone)]
  - Template Method     → Trait default methods

⚠️ Khó hơn trong Rust:
  - Observer (circular refs problem với Rc/RefCell)
  - Mediator (multiple ownership → cần Arc)
  - Command (lifetime complexity với borrowed data)
```

---

## Reading Order

```
Beginner → Intermediate → Advanced

1. Prototype (Clone)
2. Iterator (built-in)
3. Singleton (OnceLock)
4. Factory Method (Trait)
5. Adapter (Newtype)
6. Facade (Module)
7. Strategy (Trait/Closure)
8. Template Method (Default method)
9. Builder (Typestate) ← Rust's killer pattern
10. Decorator (Newtype wrap)
11. Composite (Enum tree)
12. Command (Closure/Trait)
13. Observer (Channel)
14. State (Typestate advanced) ← Mind-blowing
15. Visitor (Enum + match)
... rest
```

---

## 🔗 Series Articles

- [[Design-Patterns-Rust/01-Creational|01 · Creational Patterns]]
- [[Design-Patterns-Rust/02-Structural|02 · Structural Patterns]]
- [[Design-Patterns-Rust/03-Behavioral|03 · Behavioral Patterns]]

---

*Tags: #rust #design-patterns #gof #architecture*
