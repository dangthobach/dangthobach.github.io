# Rust Idiomatic Patterns — Beyond GoF

> GoF patterns giải quyết vấn đề OOP phổ quát. Nhưng Rust có **ownership model, type system, và zero-cost abstraction** tạo ra một tập patterns riêng — một số không tồn tại ở ngôn ngữ khác, một số thay thế hoàn toàn GoF patterns.

---

## Tại Sao Cần Học Rust-Specific Patterns?

```
Java dev viết Rust = Java code với Rust syntax
  → clone() everywhere (borrow checker problems)
  → unwrap() everywhere (không handle error properly)
  → Box<dyn Trait> everywhere (không cần thiết)

Rustacean thực thụ:
  → Leverage type system để make invalid states unrepresentable
  → Zero-cost abstractions — zero overhead khi trừu tượng hóa
  → Compiler là ally, không phải enemy
```

---

## Skill Level Map

```
┌─────────────────────────────────────────────────────────────────┐
│  Level 1 · FOUNDATIONS          "Code compiles"                 │
│  ─────────────────────────────────────────────────────────────  │
│  RAII/ScopeGuard · Newtype · Result/Option Chains               │
│  impl Trait Return · From/Into · Derive Macros                  │
├─────────────────────────────────────────────────────────────────┤
│  Level 2 · IDIOMATIC            "Code is Rusty"                 │
│  ─────────────────────────────────────────────────────────────  │
│  Extension Trait · Interior Mutability · Cow<T>                 │
│  Parse Don't Validate · Sealed Trait · Newtype Index            │
├─────────────────────────────────────────────────────────────────┤
│  Level 3 · ARCHITECTURE         "Design scales"                 │
│  ─────────────────────────────────────────────────────────────  │
│  Handle/Arena · Type Erasure · Blanket Impl                     │
│  Error Hierarchy · Zero-Sized Types · Module Sealing            │
├─────────────────────────────────────────────────────────────────┤
│  Level 4 · TYPE SYSTEM MASTERY  "Compiler proves correctness"   │
│  ─────────────────────────────────────────────────────────────  │
│  GATs · HRTB · Const Generics · PhantomData Variance            │
│  Typestate Advanced · Type-Level Computation                    │
├─────────────────────────────────────────────────────────────────┤
│  Level 5 · UNSAFE & SYSTEMS     "Full control"                  │
│  ─────────────────────────────────────────────────────────────  │
│  Safe Unsafe Abstraction · Custom Allocator                     │
│  Pin Projection · proc-macro Derive                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Full Pattern Catalogue

### Level 1 — Foundations

| Pattern | Problem Solved | Rust Mechanism |
|---------|---------------|----------------|
| **RAII / ScopeGuard** | Resource cleanup guaranteed | `Drop` trait |
| **Newtype** | Type safety, wrap primitives | `struct Meters(f64)` |
| **Result Chaining** | Ergonomic error propagation | `?`, `map_err`, `and_then` |
| **Option Combinators** | Avoid nested match | `map`, `filter`, `or_else` |
| **From / Into** | Ergonomic type conversion | `impl From<A> for B` |
| **impl Trait Return** | Return abstract type | `fn foo() -> impl Trait` |

### Level 2 — Idiomatic

| Pattern | Problem Solved | Rust Mechanism |
|---------|---------------|----------------|
| **Extension Trait** | Add methods to foreign types | Orphan rule workaround |
| **Interior Mutability** | Shared mutable state | `Cell`, `RefCell`, `Mutex` |
| **Cow\<'a, T\>** | Lazy clone: borrow until needed | `Cow::Borrowed / Owned` |
| **Parse, Don't Validate** | Validity guaranteed by type | Smart constructors |
| **Sealed Trait** | Prevent external impl | Private supertrait |
| **Newtype Index** | Type-safe IDs, no confusion | `struct UserId(u32)` |
| **Fallible Builder** | Builder with validated build() | `Result<T, E>` from build |

### Level 3 — Architecture

| Pattern | Problem Solved | Rust Mechanism |
|---------|---------------|----------------|
| **Handle / Arena** | Avoid lifetime hell in graphs | `Vec<T>` + index as handle |
| **Type Erasure** | Hide concrete type from caller | `Box<dyn Trait>` / `impl Trait` |
| **Blanket Implementation** | Generic behavior for trait impls | `impl<T: Trait> Other for T` |
| **Error Hierarchy** | Layered error types | `thiserror` + `anyhow` |
| **Marker Trait** | Constrain type behavior | `unsafe trait Send` |
| **Module Sealing** | Internal API boundary | `pub(crate)` patterns |
| **Free Function over Method** | Avoid receiver confusion | Functional style |

### Level 4 — Type System Mastery

| Pattern | Problem Solved | Rust Mechanism |
|---------|---------------|----------------|
| **GATs** | Associated types with parameters | `type Item<'a>` |
| **HRTB** | Lifetime-polymorphic closures | `for<'a> Fn(&'a T)` |
| **Const Generics** | Array size as type param | `struct Matrix<const N: usize>` |
| **PhantomData Variance** | Encode variance in types | `PhantomData<fn(T)>` |
| **Typestate Advanced** | Multi-dimension state | Multiple PhantomData params |
| **Type-Level Boolean** | Compile-time flags | ZST markers + sealed traits |

### Level 5 — Unsafe & Systems

| Pattern | Problem Solved | Rust Mechanism |
|---------|---------------|----------------|
| **Safe Unsafe Abstraction** | Safe API over unsafe impl | `unsafe` block + public safe fn |
| **Custom Allocator** | Control memory layout | `GlobalAlloc` / `Allocator` trait |
| **Pin Projection** | Safely access pinned fields | `pin-project` crate |
| **proc-macro Derive** | Code generation | `proc_macro_derive` |
| **FFI Wrapper** | Safe Rust API for C libs | `bindgen` + safety invariants |

---

## Patterns Unique to Rust (không có ngôn ngữ nào khác)

```
★ Typestate Pattern         — invalid states = compile error
★ PhantomData Variance      — variance encoded in types
★ HRTB (for<'a>)           — quantify over all lifetimes
★ Sealed Trait              — trait với tập impl cố định
★ RAII (deterministic)      — không phải C++ GC mà là ownership
★ Blanket impl              — impl cho bất kỳ T thỏa điều kiện
★ GATs                      — associated types có thể parameterized
```

---

## Transition Checklist: Am I Thinking in Rust?

```
Level 1 → 2:
  ✓ Không còn dùng .clone() để fix borrow checker
  ✓ Biết sự khác nhau &str vs String, &[T] vs Vec<T>
  ✓ Result chain với ? thay vì unwrap() trong production
  ✓ Hiểu lifetime annotation cơ bản

Level 2 → 3:
  ✓ Dùng Extension Trait khi cần add method vào foreign type
  ✓ Interior Mutability đúng chỗ (không RefCell tràn lan)
  ✓ Thiết kế error hierarchy thay vì Box<dyn Error>
  ✓ Newtype Index cho mọi ID type

Level 3 → 4:
  ✓ Hiểu khi nào dùng dyn Trait vs impl Trait vs generic
  ✓ Arena/Handle khi cần graph/tree phức tạp
  ✓ Blanket impl để extend behavior generic
  ✓ Viết được trait bound phức tạp

Level 4 → 5:
  ✓ GATs + HRTB thành thạo
  ✓ Const generics cho compile-time computation
  ✓ Hiểu variance và khi nào PhantomData cần fn(T) vs *const T
  ✓ Viết được proc-macro derive đơn giản

Level 5:
  ✓ Unsafe code có invariant document rõ ràng
  ✓ Pin/Unpin internals, futures self-referential
  ✓ Custom allocator strategy
  ✓ FFI safe abstraction layer
```

---

## 🔗 Series Articles

- [[Design-Patterns-Rust/05-Level1-Foundations|Level 1 · Foundations]]
- [[Design-Patterns-Rust/06-Level2-Idiomatic|Level 2 · Idiomatic]]
- [[Design-Patterns-Rust/07-Level3-Architecture|Level 3 · Architecture]]
- [[Design-Patterns-Rust/08-Level4-TypeSystem|Level 4 · Type System Mastery]]

---

*Tags: #rust #patterns #idiomatic #type-system #advanced*
