# Bài 17: Zero-cost Abstractions & Performance Optimization

> **Java dev mindset shift:** Trong Java bạn viết code đẹp rồi JIT tự optimize. Trong Rust, compiler optimize tại compile time — bạn phải **biết compiler nghĩ gì** để tận dụng. Không có GC pause, không có JIT warmup — nhưng bạn phải explicit hơn về allocation.

---

## 1. Zero-cost Abstraction là gì

**Định nghĩa:** "What you don't use, you don't pay for. What you do use, you couldn't hand-code any better." — Stroustrup

```
Java Stream<Integer>:
  → boxing Integer overhead (16 bytes/element trên heap)
  → virtual dispatch cho mỗi lambda
  → intermediate object allocation
  → JIT có thể optimize, nhưng không guaranteed

Rust Iterator<Item = i32>:
  → monomorphized tại compile time — KHÔNG virtual dispatch
  → KHÔNG boxing (i32 = 4 bytes trên stack)
  → compiler inline toàn bộ pipeline → 1 loop duy nhất
  → assembly output = bạn tự viết vòng lặp thủ công
```

```rust
// Code này trông trừu tượng:
fn sum_even_squares(v: &[i32]) -> i32 {
    v.iter()
     .filter(|&&x| x % 2 == 0)
     .map(|&x| x * x)
     .sum()
}

// Compiler tạo ra assembly TƯƠNG ĐƯƠNG với:
fn sum_even_squares_manual(v: &[i32]) -> i32 {
    let mut sum = 0;
    for &x in v {
        if x % 2 == 0 { sum += x * x; }
    }
    sum
}
// Không có wrapper, không có vtable lookup — CÙNG assembly
```

---

## 2. Stack vs Heap — Quyết Định Quan Trọng Nhất

```
Stack alloc:  push rsp, N  → ~0.1ns (1 CPU instruction)
Heap alloc:   call malloc   → ~50-100ns (system call + TLB miss)
Ratio: heap ~500-1000x chậm hơn stack
```

```rust
// ✅ Stack — size known at compile time, ZERO heap alloc
struct Point { x: f64, y: f64 }   // 16 bytes trên stack
let buffer = [0u8; 1024];          // 1KB trên stack

// ❌ Heap — size dynamic, hoặc data lớn, hoặc shared
let name = String::from("Bach");   // heap data, ptr trên stack
let v: Vec<i32> = Vec::new();      // heap buffer

// Struct padding — sắp xếp field từ lớn đến nhỏ
struct BadLayout  { a: u8, b: u64, c: u8 }  // 24 bytes (padding!)
struct GoodLayout { b: u64, a: u8, c: u8 }  // 16 bytes

println!("{}", std::mem::size_of::<BadLayout>());  // 24
println!("{}", std::mem::size_of::<GoodLayout>()); // 16
```

---

## 3. Clone vs Copy vs Move — Cost Analysis

```rust
// Move — zero cost, chỉ transfer ownership
let s = String::from("hello");
let s2 = s;          // copy 24-byte stack header, s invalid — không copy heap

// Copy — stack types nhỏ, bitwise copy
let x: i32 = 42;
let y = x;           // 4 bytes copied, x vẫn valid

// Clone — EXPLICIT, có thể expensive
let s3 = String::from("hello world");
let s4 = s3.clone(); // NEW heap allocation + copy 11 bytes

// Anti-pattern trong loop:
for item in &big_vec {
    expensive_fn(&item.name.clone()); // N heap allocations!
}
// Fix:
for item in &big_vec {
    expensive_fn(&item.name); // borrow, zero cost
}
```

---

## 4. String Optimization

```rust
// Java dev thường viết:
fn query(table: String, id: String) -> String {
    format!("SELECT * FROM {} WHERE id={}", table, id)
} // 3 allocations: 2 to_string() + 1 format!()

// Rust way:
fn query(table: &str, id: &str) -> String {
    format!("SELECT * FROM {} WHERE id={}", table, id)
} // 1 allocation: chỉ format!() output

// Còn tốt hơn — pre-allocate với capacity:
fn query_fast(table: &str, id: &str) -> String {
    let mut s = String::with_capacity(28 + table.len() + id.len());
    s.push_str("SELECT * FROM ");
    s.push_str(table);
    s.push_str(" WHERE id=");
    s.push_str(id);
    s
} // 1 allocation, đúng size, không realloc

// Cow — Clone On Write
use std::borrow::Cow;
fn normalize(input: &str) -> Cow<str> {
    if input.chars().all(|c| c.is_lowercase()) {
        Cow::Borrowed(input)         // zero alloc
    } else {
        Cow::Owned(input.to_lowercase()) // alloc chỉ khi cần
    }
}
```

---

## 5. Iterator Fusion — Compiler Merge Adapters

```rust
// Bạn viết 3 passes:
v.iter().map(|x| x * 2).filter(|x| *x > 10).map(|x| x + 1).sum()

// Compiler sinh ra 1 loop duy nhất (loop fusion):
let mut sum = 0;
for x in &v {
    let a = x * 2;
    if a > 10 { sum += a + 1; }
}
// Không intermediate Vec, không multiple passes

// iter() vs iter_mut() vs into_iter()
let v = vec![1, 2, 3];
v.iter()       // &i32   — borrow, v vẫn dùng được
v.iter_mut()   // &mut i32 — mutable borrow
v.into_iter()  // i32    — consume v (move semantics)
```

---

## 6. Profiling với cargo-flamegraph

```bash
# Install
cargo install flamegraph
# Linux: sudo apt install linux-perf

# Cargo.toml — giữ symbols cho profiling:
[profile.profiling]
inherits = "release"
debug = 1
strip = false

# Chạy:
cargo flamegraph --profile profiling --bin myapp
# Tạo flamegraph.svg — mở bằng browser

# Đọc flamegraph:
# Width block = % CPU time
# Bottom = root (main), Top = leaf (bottleneck thực sự)
# Tìm: "malloc"/"memcpy" blocks → quá nhiều allocation
```

### Benchmark với criterion

```toml
[dev-dependencies]
criterion = { version = "0.5", features = ["html_reports"] }

[[bench]]
name = "perf_bench"
harness = false
```

```rust
// benches/perf_bench.rs
use criterion::{black_box, criterion_group, criterion_main, Criterion};

fn bench_sum(c: &mut Criterion) {
    let v: Vec<i32> = (0..10_000).collect();
    
    c.bench_function("iter sum", |b| {
        b.iter(|| v.iter().sum::<i32>())
    });
    c.bench_function("loop sum", |b| {
        b.iter(|| {
            let mut s = 0i32;
            for &x in &v { s += x; }
            black_box(s) // ngăn compiler optimize away
        })
    });
}

criterion_group!(benches, bench_sum);
criterion_main!(benches);
```

```bash
cargo bench
# Output: iter sum  time: [4.2µs 4.3µs 4.4µs]
#         loop sum  time: [4.1µs 4.2µs 4.3µs]
# → Tương đương! Iterator = zero overhead
```

---

## 7. SIMD — Vectorization

```rust
// Auto-vectorization: compiler tự SIMD nhiều patterns
fn sum_f32(arr: &[f32]) -> f32 {
    arr.iter().sum()
    // LLVM → AVX2: xử lý 8 f32 cùng lúc → 8x throughput
}

// Unlock native CPU instructions:
// RUSTFLAGS="-C target-cpu=native" cargo build --release
// Hoặc .cargo/config.toml:
// [target.x86_64-unknown-linux-gnu]
// rustflags = ["-C", "target-cpu=native"]

// Verify có SIMD không:
// cargo rustc --release -- --emit=asm | grep ymm   (AVX2 registers)
```

---

## 8. Release Profile Checklist

```toml
[profile.release]
opt-level = 3        # Max optimization
lto = "thin"         # Link-time optimization — inlining cross-crate
codegen-units = 1    # Compiler thấy toàn bộ code → inline tốt hơn
panic = "abort"      # Nhỏ hơn + nhanh hơn khi panic
strip = true         # Binary nhỏ hơn ~50%
```

---

## 9. Common Anti-patterns

```rust
// ❌ Clone thay vì borrow
fn print(name: String) { println!("{}", name); }
// ✅ Borrow
fn print(name: &str) { println!("{}", name); }

// ❌ Collect trung gian rồi iterate lại
let v: Vec<_> = items.iter().map(f).collect();
for x in &v { use(x); }
// ✅ Không collect trung gian
items.iter().map(f).for_each(|x| use(&x));

// ❌ Vec::contains trong loop — O(n²)
for item in &items {
    if known.contains(item) { ... }
}
// ✅ HashSet — O(1)
let set: HashSet<_> = known.iter().collect();
for item in &items {
    if set.contains(item) { ... }
}

// ❌ Vec không có capacity hint
let mut v = Vec::new();
for _ in 0..1000 { v.push(...); } // ~10 reallocations
// ✅ Pre-allocate
let mut v = Vec::with_capacity(1000);
for _ in 0..1000 { v.push(...); } // 1 allocation
```

---

## 10. Performance Cheat Sheet: Java vs Rust

| Tình huống | Java | Rust |
|---|---|---|
| Object creation | Always heap + GC | Stack khi biết size |
| String passing | New String (heap) | `&str` borrow (zero cost) |
| Generic dispatch | Type erasure + boxing | Monomorphized = zero cost |
| Interface call | Virtual (vtable) | Static với `impl Trait` |
| Iterator/Stream | Virtual + boxing | Inlined, fused, no alloc |
| Error handling | Exception (stack unwind) | `Result` = zero cost enum |
| Thread | ~1MB stack | Tokio task ~8KB |

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-7-Closures-Iterators|Bài 7: Iterator internals]]
- [[Rust-Zero-To-Hero/Bai-18-Type-System-Advanced|Bài 18: Type System nâng cao → tiếp theo]]
- [[MOC-Memory-Model]]

---
*Bài tập:*
1. Benchmark `String::clone()` vs `&str` borrow qua 1M iterations với criterion. Đo và ghi kết quả.
2. Viết `sum_even_squares(&[i64]) -> i64` 3 cách: for loop / iterator / dùng `chunks_exact(8)`. Benchmark cả 3.
3. Tìm struct trong code có padding. Dùng `mem::size_of` trước và sau khi reorder fields.
4. Chạy `cargo flamegraph` trên một function. Screenshot và identify top 1 bottleneck.
