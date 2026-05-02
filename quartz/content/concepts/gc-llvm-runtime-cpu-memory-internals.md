---
title: "GC · LLVM · Native Code · Runtime Overhead — Bản Chất CPU & Memory"
tags: [systems, rust, go, java, gc, llvm, runtime, memory, cpu, performance]
related:
  - "[[concepts/rust-java-go-comparison]]"
  - "[[Rust-Zero-To-Hero/ownership-borrowing]]"
created: 2026-05-02
status: permanent
---

# GC · LLVM · Native Code · Runtime Overhead — Bản Chất CPU & Memory

> Article này đi sâu vào **cơ chế vật lý** bên dưới: GC thực sự làm gì với RAM và CPU, LLVM pipeline hoạt động từng bước ra sao, native code khác bytecode ở mức instruction nào, và runtime overhead được đo lường như thế nào. Đây là nền tảng để hiểu *tại sao* Rust > Go > Java về tốc độ.

---

## 1. Bộ nhớ máy tính nhìn từ góc độ chương trình

Trước khi nói về GC hay runtime, cần hiểu **CPU nhìn thấy gì** khi chạy code.

```
Physical RAM
┌─────────────────────────────────────────────────────┐
│  OS Kernel Space  (không chạm được từ userspace)    │
├─────────────────────────────────────────────────────┤
│  Process Virtual Address Space                       │
│  ┌──────────────┬──────────────┬──────────────────┐ │
│  │   TEXT       │   DATA/BSS   │  STACK  │  HEAP  │ │
│  │ (code)       │ (globals)    │  ↓  ↑   │        │ │
│  └──────────────┴──────────────┴──────────────────┘ │
│   0x0000...                           0xFFFF...      │
└─────────────────────────────────────────────────────┘
```

- **TEXT segment**: Machine instructions (compiled code) — read-only
- **STACK**: Function call frames, local variables — LIFO, cực nhanh (chỉ move stack pointer)
- **HEAP**: Dynamic allocation (`malloc`, `new`, `Box::new`) — linh hoạt nhưng cần quản lý
- **CPU registers**: ~16-32 ô nhớ trực tiếp trong chip — nhanh nhất, không qua RAM

**Key insight**: Stack allocation = 1 instruction (`SUB RSP, N`). Heap allocation = nhiều bước (tìm free block, update metadata, return pointer) → chậm hơn 10-100x.

---

## 2. LLVM — Cỗ Máy Biến Source Code Thành Machine Code

### 2.1 LLVM là gì về mặt vật lý

LLVM (Low Level Virtual Machine) là một **compiler infrastructure** — một tập hợp các thư viện và tools để biến code thành machine instructions tối ưu. Nó **không phải** là runtime hay VM.

```
Rust Source (.rs)
        │
        ▼
  [rustc frontend]
  - Lexing, Parsing
  - Type checking
  - Borrow checking
  - HIR → MIR (Mid-level IR)
        │
        ▼
   LLVM IR (.ll)          ← Ngôn ngữ trung gian dạng text/binary
        │
        ▼
  [LLVM Optimizer]        ← ~70+ optimization passes chạy tuần tự
        │
        ▼
  [LLVM Backend]          ← Target-specific code gen (x86, ARM, RISC-V...)
        │
        ▼
  Machine Code (.o)
        │
        ▼
  [Linker]
        │
        ▼
  Native Binary (ELF/PE/Mach-O)
```

### 2.2 LLVM IR trông như thế nào

LLVM IR là "assembly ngôn ngữ cao cấp" — typed, SSA form (Static Single Assignment):

```llvm
; Rust code: fn add(a: i32, b: i32) -> i32 { a + b }
; LLVM IR tương ứng:

define i32 @add(i32 %a, i32 %b) {
entry:
  %result = add i32 %a, %b   ; typed addition
  ret i32 %result
}

; Sau optimizer → x86-64 assembly:
; add:
;   lea eax, [rdi + rsi]   ; 1 instruction!
;   ret
```

### 2.3 Các optimization passes quan trọng trong LLVM

| Pass | Làm gì | Impact |
|---|---|---|
| **Inlining** | Copy body hàm nhỏ vào caller, bỏ call overhead | Rất lớn |
| **Dead Code Elimination** | Xóa code không bao giờ chạy | Medium |
| **Loop Unrolling** | Expand vòng lặp → ít branch overhead | Lớn cho số học |
| **Vectorization (SIMD)** | Gộp nhiều phép tính thành 1 AVX/SSE instruction | Rất lớn cho data |
| **Escape Analysis** | Xác định object không "escape" ra heap → để trên stack | Lớn |
| **Constant Folding** | Tính toán constant expression tại compile time | Medium |
| **Alias Analysis** | Xác định pointers không overlap → optimize memory ops | Lớn |

### 2.4 Tại sao Go compiler không dùng LLVM (và hệ quả)

Go dùng compiler riêng (gc toolchain) với backend SSA đơn giản hơn:

```
Lý do Go không dùng LLVM:
✓ Build time cực nhanh (LLVM chậm vì nhiều passes)
✓ Compiler đơn giản, dễ maintain
✓ Cross-compilation dễ hơn

Hệ quả về performance:
✗ Inlining heuristic đơn giản hơn (Go: chỉ inline hàm nhỏ)
✗ Không có auto-vectorization
✗ Loop optimization kém hơn
✗ Escape analysis ít aggressive hơn → nhiều heap allocation hơn cần thiết
```

**Concrete example — escape analysis:**

```go
// Go code
func makePoint() *Point {
    p := Point{x: 1, y: 2}  // Go escape analysis: "p escapes to heap"
    return &p                 // → heap alloc vì GC cần track
}
// Go compiler thường cho p lên heap do conservative escape analysis

// Rust equivalent
fn make_point() -> Point {
    Point { x: 1, y: 2 }    // Move semantics: caller owns it
}                             // → stack, không có heap alloc
```

---

## 3. Garbage Collector — Bản Chất Vật Lý

### 3.1 Vấn đề GC giải quyết

```
Không có GC (C/C++):
  char* buf = malloc(1024);
  process(buf);
  // Nếu quên free(buf) → memory leak
  // Nếu free rồi dùng tiếp → use-after-free (crash/security hole)
  // Nếu free 2 lần → double-free (undefined behavior)

Với GC (Java/Go):
  byte[] buf = new byte[1024];
  process(buf);
  // GC tự biết khi nào buf không còn được reference
  // → tự giải phóng → developer không lo
```

### 3.2 GC hoạt động như thế nào ở mức CPU/RAM

#### Bước 1: Mark phase — Tracing reachability

GC bắt đầu từ **GC Roots** (stack variables, global variables, CPU registers) và duyệt toàn bộ object graph:

```
GC Roots (luôn reachable):
  ├── Stack frames của tất cả goroutines/threads
  ├── Global/static variables
  └── CPU registers

Heap trước GC:
  [ObjA] → [ObjB] → [ObjC]
  [ObjD] (không có ai reference → garbage)
  [ObjE] → [ObjF]

Tricolor marking (Go):
  WHITE = chưa visited (ban đầu tất cả là white)
  GRAY  = đang process children
  BLACK = đã process xong (reachable, sẽ KHÔNG bị collect)

  1. GC Roots → mark reachable objects GRAY
  2. Pick một GRAY object, mark nó BLACK, mark children GRAY
  3. Lặp đến hết GRAY set
  4. WHITE còn lại = garbage → collect
```

#### Bước 2: Sweep phase — Reclaim memory

```
Sau mark:
  [ObjA-BLACK] → [ObjB-BLACK] → [ObjC-BLACK]
  [ObjD-WHITE]  ← GARBAGE → free memory
  [ObjE-BLACK] → [ObjF-BLACK]

Sweep:
  Duyệt toàn bộ heap, free các WHITE objects
  → Trả về memory pool để tái sử dụng
```

#### Bước 3: Chi phí thực tế trên CPU

```
Mỗi lần GC chạy (Go, ví dụ):
  - Mark phase: ~1-5ms CPU time (concurrent với app)
  - Sweep phase: ~0.1-0.5ms
  - STW (Stop-The-World) pause: ~0.1-1ms (tất cả goroutines dừng)

Mỗi heap allocation:
  - Tìm free slot trong size class → ~20-50ns
  - Write barrier (update GC metadata) → ~2-5ns extra PER POINTER WRITE

Tổng throughput loss: ~10-20% CPU cho GC activities
```

### 3.3 Write Barriers — Overhead ẩn nhất

Đây là phần ít biết nhất nhưng quan trọng nhất:

```
Khi GC đang chạy concurrent, có thể xảy ra:
  1. GC đang mark ObjA (BLACK)
  2. App thread đột ngột: objA.child = objD  (objD là WHITE = garbage?)
  3. GC không biết → objD bị collect sai!

Write barrier ngăn điều này:
  Mỗi lần bạn assign một pointer, compiler chèn thêm code:
```

```asm
; Go code: obj.field = newValue
; Assembly thực tế được generate:

MOV RAX, [newValue]
; --- WRITE BARRIER BEGIN (compiler-inserted) ---
CALL runtime.gcWriteBarrier
; gcWriteBarrier:
;   if gcphase == _GCmark:
;     shade(old_value)   ; mark old value gray nếu GC đang chạy
;     shade(new_value)   ; mark new value gray
; --- WRITE BARRIER END ---
MOV [obj+offset], RAX

; Rust không có điều này:
MOV [obj+offset], RAX   ; 1 instruction, xong
```

**Hệ quả**: Code có nhiều pointer mutations (trees, graphs, linked lists) bị ảnh hưởng nặng — mỗi pointer write trong Go tốn ~4-8 instructions thay vì 1.

### 3.4 Java GC vs Go GC — Tại sao Java phức tạp hơn

```
Go GC:
  - Simple tricolor concurrent mark-sweep
  - Tuned cho low latency (< 1ms STW)
  - Trade-off: higher CPU usage, không compact heap
  - Heap fragmentation có thể xảy ra theo thời gian

Java G1 GC:
  - Generational (Young Gen / Old Gen / Metaspace)
  - Concurrent marking + incremental compaction
  - Region-based heap (1-32MB regions)
  - STW: evacuation pauses (~5-200ms tùy heap size)

Java ZGC (Java 15+):
  - Fully concurrent (mark + relocate không stop-the-world)
  - Load barriers thay vì write barriers
  - STW: < 1ms (tương đương Go)
  - Trade-off: higher memory bandwidth

Lý do Java cần generational GC:
  - Java object model: MỌI object đều là heap pointer
  - int x = 5  → Integer x = new Integer(5) (autoboxing)
  - Allocation rate cực cao → cần Eden/Survivor để handle short-lived objects
  - Go struct được value type → nhiều thứ hơn ở stack
```

---

## 4. Native Code vs Runtime — Sự Khác Biệt Vật Lý

### 4.1 Native Code là gì

Native code = **machine instructions chạy thẳng trên CPU**, không qua bất kỳ layer trung gian nào.

```
CPU instruction set (x86-64):
  MOV RAX, 42        ; load 42 vào register RAX
  ADD RBX, RAX       ; cộng RAX vào RBX
  CMP RBX, 100       ; so sánh RBX với 100
  JGE .label         ; nhảy nếu >=
  RET                ; return

CPU pipeline:
  Fetch → Decode → Execute → Write-back
  Modern CPUs: out-of-order execution, branch prediction,
  superscalar (nhiều instructions/cycle), speculative execution
```

Native binary (Rust/Go) chứa trực tiếp những instructions này. CPU đọc và chạy ngay.

### 4.2 Bytecode + JVM — Thêm 1 lớp

Java không compile thẳng ra x86. Nó compile ra **JVM bytecode** — một instruction set ảo:

```
Java source:
  int sum = a + b;

Bytecode (.class):
  iload_1    ; push local var 1 (a) onto operand stack
  iload_2    ; push local var 2 (b)
  iadd       ; pop 2, add, push result
  istore_3   ; store result in local var 3

JVM interprets this → converts to real x86:
  ; First few hundred calls: interpreter
  MOV EAX, [rbp-4]    ; load a
  ADD EAX, [rbp-8]    ; add b
  MOV [rbp-12], EAX   ; store

  ; After JIT: compiled to optimized native
  LEA EAX, [rdi+rsi]  ; 1 instruction (compiler sees pattern)
```

**Chi phí của bytecode interpretation** (trước JIT):
- Mỗi bytecode instruction cần nhiều native instructions để decode + dispatch
- Virtual dispatch overhead (~10-20ns per call)
- Interpreter loop overhead

**JIT cứu vãn nhưng có latency**:
- Interpreter → detect hot methods → JIT compile → native
- JIT compilation tốn CPU và thời gian (vài giây đến vài chục giây)
- Trong thời gian warm-up, performance thấp

### 4.3 Go runtime — Nhỏ nhưng có thật

Go compile ra native code, nhưng **embed runtime vào binary**:

```
Go binary anatomy:
  ┌────────────────────────────────┐
  │  Your application code         │ ← What you wrote
  ├────────────────────────────────┤
  │  Go Runtime (~2MB embedded)    │
  │  ├── Goroutine scheduler (GMP) │
  │  ├── GC engine                 │
  │  ├── Stack management          │
  │  ├── Channel operations        │
  │  └── Memory allocator          │
  └────────────────────────────────┘
```

Khi binary khởi động:
```
1. OS loads binary → TEXT segment vào RAM
2. Go runtime.main() chạy trước main() của bạn:
   - Khởi tạo heap allocator
   - Start GC goroutine (background)
   - Start goroutine scheduler
   - Detect CPU count → create M (OS threads)
3. main() của bạn bắt đầu chạy
```

### 4.4 Rust runtime — Gần như không tồn tại

```
Rust binary anatomy:
  ┌────────────────────────────────┐
  │  Your application code         │
  ├────────────────────────────────┤
  │  Minimal runtime (~few KB)     │
  │  ├── panic handler             │
  │  └── allocator (jemalloc/sys)  │
  └────────────────────────────────┘
```

Không có GC. Không có scheduler (trừ khi bạn dùng Tokio/Rayon). Memory được free theo RAII — compiler chèn `drop()` calls vào đúng chỗ tại compile time:

```rust
fn process() {
    let data = Vec::new();    // Heap alloc
    fill(&mut data);
    compute(&data);
}   // ← Compiler chèn: drop(data) = free(ptr) tại đây
    // Không cần GC trace. Biết trước 100%.
```

---

## 5. Runtime Overhead — Đo Lường Thực Tế

### 5.1 CPU overhead

```
Workload: 10 triệu iterations xử lý data structure

Rust:   ~100% CPU → application logic
        ~0%  CPU → runtime
        Throughput: 10M ops/sec

Go:     ~85% CPU → application logic
        ~10% CPU → GC (mark, sweep, write barriers)
        ~5%  CPU → scheduler overhead
        Throughput: ~8.5M ops/sec

Java (warmed):  ~80% CPU → application logic (JIT compiled)
                ~12% CPU → GC (G1)
                ~8%  CPU → JVM internals
                Throughput: ~8M ops/sec (but JIT may optimize further)

Java (cold):    ~40% CPU → interpreter overhead
                Throughput: ~4M ops/sec (first few seconds)
```

### 5.2 Memory overhead

```
Chương trình đơn giản — "Hello, World" server:

Rust (Axum):     RSS ~5MB   = application data only
Go (net/http):   RSS ~20MB  = app + runtime + GC bookkeeping
Java (Spring):   RSS ~200MB = app + JVM heap + Metaspace + JIT code cache

Object header overhead:
  Rust struct Point { x: f64, y: f64 }  → 16 bytes (chỉ data)
  Go   struct Point { X, Y float64 }    → 16 bytes (stack) / +GC metadata (heap)
  Java class Point { double x, y; }    → 16 bytes data + 16 bytes header = 32 bytes
     (Java object header: mark word 8B + class pointer 8B)
```

### 5.3 Latency spikes — Vấn đề thực tế nhất với banking

```
Request latency timeline (1000 requests):

Rust:
  ─────────────────────────────────────────── 1-3ms consistent
  
Go:
  ──────────┼──────────┼──────────┼─────── 1-2ms
            ↑          ↑          ↑
           GC(0.5ms)  GC(0.3ms)  GC(0.8ms)  ← predictable, nhỏ
  
Java (G1):
  ──────────────────┼──────────────────┼───
                    ↑                  ↑
                   GC pause           GC pause
                  (5-50ms!)          (10-30ms)  ← unpredictable với default config

Java (ZGC):
  ──────────┼──────────┼────────────────── 1-3ms
            ↑          ↑
           <1ms       <1ms  ← ZGC ổn định hơn nhiều
```

**Tại sao latency spikes quan trọng với PDMS/banking:**
- SLA thường là P99 < 100ms hoặc P999 < 500ms
- GC pause của G1 có thể vi phạm SLA nếu không tune kỹ
- ZGC + Loom cho Java 21 đã giải quyết phần lớn vấn đề này
- Rust hoàn toàn deterministic — P50 ≈ P99.99

---

## 6. Tổng Hợp — Tại Sao Rust > Go > Java

```
Performance hierarchy xuất phát từ accumulated overhead:

RUST:
  Source → LLVM (heavy optimize) → Native binary
  Runtime: RAII (compile-time memory mgmt)
  CPU per op: 1x (baseline)
  Latency: deterministic

GO:
  Source → Go compiler (light optimize) → Native + embedded runtime
  Runtime: GC (tricolor concurrent) + goroutine scheduler
  CPU per op: ~1.15-1.25x (GC + write barriers + scheduler)
  Latency: mostly predictable, occasional < 1ms spikes

JAVA:
  Source → javac → Bytecode → JVM → JIT → Native (eventually)
  Runtime: JVM + generational GC + JIT compilation
  CPU per op: 1.2-2x (cold: 2x, warmed: 1.2x)
  Latency: variable (GC pauses, JIT deoptimization, class loading)

Overhead accumulates:
  Java = bytecode interpretation + GC + JVM metadata + object headers
  Go   = GC + write barriers + stack growth checks
  Rust = (nearly nothing — compiler handled it all)
```

---

## 7. Practical Implications cho PDMS

### Khi nào overhead thực sự quan trọng

```
PDMS workload profile:
  - CRUD operations: Java ZGC overhead negligible (I/O bound anyway)
  - Batch ETL (10M records): GC pressure cao → Go hoặc Rust sẽ tốt hơn
  - Stored procedures: Xử lý trong PostgreSQL → ngôn ngữ không quan trọng
  - Excel parsing (200K rows): CPU-bound → Rust/Go ~30% nhanh hơn Java

Kết luận cho PDMS stack hiện tại (Java 21 + ZGC + Loom):
  ✓ I/O-bound CRUD: overhead không đáng kể
  ✓ ZGC: latency < 1ms, không khác Go nhiều
  ✓ Virtual Threads: concurrency overhead tương đương goroutines
  ✗ CPU-intensive batch: Java vẫn ~20-30% chậm hơn Go dù đã tuned
  → Hybrid: Java cho service layer, Go/Rust cho batch worker nếu cần
```

---

## 8. References

- [LLVM Language Reference Manual](https://llvm.org/docs/LangRef.html)
- [Go GC Guide](https://tip.golang.org/doc/gc-guide)
- [Java ZGC](https://wiki.openjdk.org/display/zgc/Main)
- [Rustonomicon — Memory layout](https://doc.rust-lang.org/nomicon/repr-rust.html)
- [Write barriers in Go](https://go.googlesource.com/proposal/+/refs/heads/master/design/17503-eliminate-rescan.md)
- `[[concepts/rust-java-go-comparison]]`
