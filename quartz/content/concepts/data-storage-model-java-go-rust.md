---
tags: [concepts, memory, storage, allocator, gc, scheduler, memory-model, ffi, java, go, rust, jvm, runtime, evergreen]
aliases: [Java Go Rust Memory Model, Storage Allocator Dispatch GC Scheduling Comparison, Go Java Rust Runtime Internals]
created: 2026-09-02
difficulty: advanced
estimated-read: 55 min
links: [rust-java-go-comparison, gc-llvm-runtime-cpu-memory-internals, memory-hierarchy-cpu-cache, native-image-aot-jit, java-virtual-threads-deep-dive, project-loom-deep-dive]
type: concept
domain: concepts
status: active
updated: 2026-09-02
---

# 🗄️ Java vs Go vs Rust — Toàn Chuỗi Runtime: Storage, Allocator, Vtable, GC, Context Switch, Memory Model

> [!abstract] Mental model xuyên suốt bài
> Một chuỗi câu hỏi áp dụng cho MỌI value trong cả 3 ngôn ngữ:
> **representation → ai sở hữu/tham chiếu nó? → stack/register hay heap? → nếu heap thì allocator nào phát? → dynamic dispatch cần metadata gì? → cái gì giữ nó sống? → ai thu hồi, và khi nào? → nếu task bị suspend, execution state nằm ở đâu? → thread khác thấy write theo rule ordering nào?**
>
> Bài viết trước ([[data-storage-model-java-go-rust]] — chính là bài này) chỉ đi tới câu hỏi "dynamic dispatch cần metadata gì". Bản cập nhật này nối tiếp toàn bộ chuỗi tới allocator, GC, context switch, memory ordering, unsafe/FFI và diagnostics — đối chiếu với một research pass riêng để tách rõ **spec/language guarantee** khỏi **compiler/runtime implementation detail** (JVMS ≠ HotSpot; Go spec ≠ `gc` toolchain runtime; Rust Reference ≠ rustc internal).

> [!warning] Quy tắc đọc bài này
> Bất cứ chỗ nào bài nói về **kích thước byte cụ thể** (header 12-16B, itab 2-word...), đó là **mô tả khái niệm ở một thời điểm/cấu hình phổ biến**, KHÔNG phải cam kết ABI vĩnh viễn. HotSpot Compact Object Headers, các thay đổi trong Go runtime giữa các release, và việc rustc vtable layout chưa từng là stable ABI đều là lý do để luôn hedge câu này khi đọc lại sau vài năm.

---

## 🎯 Trục phân tích: không phải "có GC hay không"

3 câu hỏi áp dụng cho mọi đơn vị dữ liệu:

1. **Metadata có bị bắt buộc gắn liền với value không?** (header, type tag, vtable pointer...)
2. **Ai quyết định stack hay heap — và quyết định lúc nào?** (compile time tường minh / compiler heuristic / JIT runtime speculative)
3. **Chi phí đó trả cho MỌI value, hay chỉ khi thực sự cần (opt-in)?**

---

## 🏛️ Tầng 0 — Ba Triết Lý Lưu Trữ Tổng Quát

```
┌───────────────────────────┐  ┌───────────────────────────┐  ┌───────────────────────────┐
│          JAVA               │  │           GO               │  │          RUST              │
│   Managed Object Model      │  │   Value-type + GC          │  │  Value-type + Ownership     │
├───────────────────────────┤  ├───────────────────────────┤  ├───────────────────────────┤
│ Object/array semantically    │  │ struct = value trần,        │  │ struct = value trần,        │
│ đến từ heap theo JVMS        │  │ không header bắt buộc       │  │ không header bắt buộc       │
│ nhưng JIT có thể loại bỏ     │  │ stack/heap: compiler quyết  │  │ heap CHỈ khi gọi Box/Vec/   │
│ allocation vật lý (scalar    │  │ định bằng escape analysis   │  │ String/Rc tường minh —      │
│ replacement) nếu identity    │  │ (compile-time, có thể đổi   │  │ không compiler nào tự ý     │
│ không bị quan sát            │  │ giữa các bản Go)            │  │ heap-alloc hộ bạn            │
│ GC quản lý phần vật lý hóa   │  │ GC quản lý phần đã escape   │  │ Ownership → Drop khi ra     │
│                              │  │ lên heap                    │  │ khỏi scope, KHÔNG tracing GC │
└───────────────────────────┘  └───────────────────────────┘  └───────────────────────────┘
```

> [!important] Spec vs implementation
> JVM Specification chỉ nói heap là nơi chứa class instance/array và có automatic storage management — nó **không** bắt buộc physical object layout hay GC algorithm. Mọi chi tiết về header, TLAB, G1 ở bài này là **HotSpot implementation**, không phải điều JVMS yêu cầu.

**Hệ quả then chốt:** Java trả phí metadata (header) cho MỌI object bất kể có polymorphism hay không. Go và Rust chỉ trả phí khi bạn *chủ động* box vào interface/`dyn Trait` — phần còn lại chạy gần như C.

---

## 🔢 Tầng 1 — Scalar / Primitive

| Kiểu | Java | Go | Rust |
|---|---|---|---|
| Số nguyên 32-bit | `int` — 4B, value | `int32` — 4B, value | `i32` — 4B, value |
| Số nguyên 64-bit | `long` — 8B, value | `int64` — 8B, value | `i64` — 8B, value |
| Boolean | `boolean` — impl-defined | `bool` — 1B | `bool` — 1B |
| Ký tự | `char` — **2B, UTF-16 code unit** (không phải 1 code point đầy đủ) | `rune` (alias `int32`) — **4B, Unicode scalar value** | `char` — **4B, Unicode scalar value** |

```java
Integer boxed = 42;  // box: header (~12-16B, xem cảnh báo Tầng 2) + 4B int
```
```go
var i interface{} = 42  // box chỉ khi vào interface{} — có thể escape lên heap
```
```rust
let boxed: Box<i32> = Box::new(42);  // KHÔNG BAO GIỜ tự động — luôn tường minh
```

---

## 📦 Tầng 2 — Composite: Struct/Object Layout

### 2.1 Java/HotSpot — Header bắt buộc trên MỌI object

```
┌─────────────────────────────┐
│  Mark word                  │ ← hash, GC age, lock state
├─────────────────────────────┤
│  Klass pointer (compressed   │ ← trỏ tới HotSpot Klass metadata
│  hoặc full tùy config)       │   (chứa C++-style vtable, xem Tầng 8)
├─────────────────────────────┤
│  field 1, field 2, ...      │ ← HotSpot tự sắp field để giảm padding
└─────────────────────────────┘
```

> [!warning] Đừng hard-code "12-16 byte header"
> HotSpot glossary mô tả mark word + Klass pointer là 2 phần đầu object header, nhưng **JEP Compact Object Headers đã thay đổi cách HotSpot mã hóa header** ở các JDK/config mới, làm kích thước thay đổi. Con số 12-16B chỉ đúng ở một số cấu hình phổ biến trước đó — không dùng làm hằng số vĩnh viễn.

### 2.2 Go — Plain struct, KHÔNG có universal header

> [!note] Implementation detail
> Go struct không có class inheritance và không cần vptr/header kiểu Java trên mọi value. Runtime giữ allocation/GC metadata ở **side structures** riêng (span/size-class) thay vì gắn vào từng object. Chi tiết phụ trợ này có thể đổi giữa các release — không nên giả định "Go object luôn 0 byte overhead tuyệt đối trong mọi ngữ cảnh runtime", chỉ nên nói **không có per-object class header kiểu Java**.

Field order do bạn quyết định (compiler KHÔNG tự reorder):
```go
type Bad struct { A bool; B int64; C bool }   // 24B: padding lãng phí
type Good struct { B int64; A bool; C bool }  // 16B: tự sắp lớn→nhỏ
```

### 2.3 Rust — Compiler tự reorder mặc định, nhưng có `repr` để kiểm soát

```rust
struct Document { id: String, size: u64, active: bool } // repr(Rust): compiler ĐƯỢC PHÉP reorder
#[repr(C)] struct FfiDocument { id: u64, active: bool }  // ép giữ thứ tự — bắt buộc khi FFI
```

> [!important] Spec vs implementation
> Rust Reference nói rõ `repr(Rust)` mặc định **không phải stable FFI layout**; compiler có toàn quyền sắp xếp/pad. Đây là lý do mọi sơ đồ byte-layout Rust trong bài này là "khái niệm", không phải ABI cam kết.

**Hai tối ưu chỉ Rust có:** Zero-Sized Types (0 byte) và niche optimization (`Option<Box<T>>` cùng size với `Box<T>` vì null làm tag ẩn cho `None`).

---

## 🧭 Tầng 3 — Ai Quyết Định Stack Hay Heap?

```
JAVA:  JIT escape analysis (runtime, best-effort) → NẾU chứng minh object
       không escape VÀ identity không bị quan sát → SCALAR REPLACEMENT
       (phân rã field thành biến/register) — KHÔNG phải "object xuống stack"

GO:    Compiler escape analysis (compile-time, quyết định 1 lần khi build,
       KHÔNG phải JIT speculative runtime) → `go build -gcflags=-m=3` xem được
       Escape có tính LAN TRUYỀN: object chứa pointer tới object khác cần
       sống dài hơn → object bị trỏ tới cũng escape theo

RUST:  Developer TƯỜNG MINH 100% qua Box/Vec/String/Rc/Arc — compiler
       KHÔNG có "escape-analysis phase" để tự động promote borrowed local
       lên heap. Trả về reference tới local đã chết → COMPILE ERROR
       (borrow checker), không phải runtime tự sửa giúp bạn.
```

> [!warning] 2 misconception phổ biến nhất trong toàn bộ chủ đề này
> 1. **"Escape analysis nghĩa là Java/Go object được chuyển xuống stack."** Với Java, mô tả đúng là *scalar replacement / allocation elimination* — object không "chuyển chỗ", nó bị compiler chứng minh là không cần tồn tại như object quan sát được. Với Go, storage location vẫn có thể là stack thật, nhưng đây là compiler optimization decision, không phải cú pháp `&`/`new` quyết định.
> 2. **"Dùng `&x` hay `new` ở Go/Java luôn tạo heap allocation."** Sai — compiler quyết định, không phải cú pháp. Luôn kiểm chứng bằng escape output/profiler thay vì đoán từ source.

```go
func local(x int) int { p := Point{x, x+1}; return p.X+p.Y }   // p có thể ở lại stack/register
func escapes(x int) *Point { p := Point{x, x+1}; return &p }    // p thường phải escape lên heap
```

Rust từ chối ví dụ tương đương ngay lúc compile thay vì "tự cứu" bằng cách heap-promote:
```rust
fn bad() -> &'static i32 { let x = 42; &x }  // COMPILE ERROR — không có bước "escape nên đưa x lên heap"
```

---

## 👉 Tầng 4 — Pointer/Reference: Thin vs Fat (Wide)

| | Java (reference/oop) | Go (`*T`) | Rust (`&T`) |
|---|---|---|---|
| Kích thước cơ bản | 4B (compressed, tùy config) hoặc 8B | 8B, luôn thin | 8B nếu `T: Sized` |
| Khi nào "phình" ra | Không bao giờ | Không bao giờ | **Wide/fat pointer (16B)** khi `T` unsized: `&[T]`→{ptr,len}; `&str`→{ptr,len}; `&dyn Trait`→{ptr, vtable} |
| Null | Có (`null`) | Có (`nil`) | Không có null — `Option<&T>` (niche-optimized, vẫn 8B) |

---

## 🔤 Tầng 5 — String Storage

```
JAVA (Compact Strings, JEP 254): header + byte[] value (LATIN1 hoặc UTF16)
                                  + byte coder + int hash (cache lazy)
                                  + String pool cho literal
GO:   {pointer, len} — 2-word, trỏ mảng byte UTF-8 bất biến; slicing CHIA SẺ backing array
RUST: String (owned) = {ptr,len,cap} 3-word, thực chất là Vec<u8> đã validate UTF-8
      &str (borrow)  = {ptr,len} 2-word fat pointer, không có capacity
```

---

## 📚 Tầng 6 — Collection: ArrayList / Slice / Vec

| | Java `ArrayList<T>` | Go `[]T` | Rust `Vec<T>` |
|---|---|---|---|
| Header | `Object[]`+`size`, mỗi phần tử 1 reference riêng | 3-word `{ptr,len,cap}` | 3-word `{ptr,len,cap}` — **giống hệt Go về cấu trúc** |
| Growth | ×1.5 | ~×2 rồi giảm dần (đổi giữa các bản Go) | ×2 |
| **Pitfall aliasing** | Không có | ⚠️ 2 slice cùng backing array **chia sẻ vùng nhớ** — sửa qua slice này ảnh hưởng slice kia | Không thể xảy ra ẩn — borrow checker buộc tường minh hóa việc chia sẻ |

---

## 🎭 Tầng 7 — Enum / Nullable / "Không Có Giá Trị"

```
JAVA: null là giá trị đặc biệt của MỌI reference type → NullPointerException RUNTIME

GO:   nil, và "typed nil" nổi tiếng:
      var p *T = nil; var i Interface = p
      i != nil  // TRUE! vì type descriptor khác nil dù data logically nil

RUST: enum = tagged union thật sự — payload các variant DÙNG CHUNG vùng nhớ
      (size = tag + max(payload các variant), không cộng dồn)
      Option<Box<T>> FREE về size nhờ niche optimization
```

---

## 🧩 Tầng 8 — Vtable/Dynamic Dispatch: 3 Cơ Chế Khác Hẳn Nhau

> [!important] Thuật ngữ chính xác (khác với bản trước của bài này)
> - **Go:** interface value CÓ METHOD dùng `ITab* + data` (2-word); interface RỖNG (`any`/`interface{}`) dùng `*_type + data` — KHÔNG có method table vì không cần dispatch. `ITab` chứa: interface type, concrete type, hash, và mảng `Fun[]` (function pointer theo thứ tự method). `ITab` gắn với **cặp (interface type, concrete type)**, không phải vptr nhúng trong object.
> - **Java/HotSpot:** object **không có vptr riêng** như C++. Đường dẫn là object → header (Klass pointer) → **Klass metadata** (chứa C++-style vtable) → method code. JIT có thể devirtualize/inline nếu profiling đủ tin cậy — `invokevirtual` ở bytecode KHÔNG đồng nghĩa runtime luôn có 1 indirect load.
> - **Rust:** `&dyn Trait`/`Box<dyn Trait>` là **wide pointer** {data ptr, vtable ptr}. Vtable (rustc hiện hành) có header entries `drop_in_place`, `size`, `align`, rồi tới method pointers theo thứ tự khai báo, có thể kèm supertrait vtable pointers phục vụ trait upcasting. **Đây là compiler implementation detail, KHÔNG phải stable Rust ABI** — không hard-code offset.

```
Go:    interface value {ITab*, data} ──► ITab{InterType, ConcreteType, Hash, Fun[]} ──► code
Java:  reference ──► object{mark,Klass*,fields} ──► Klass{...vtable...} ──► code
Rust:  &dyn Trait {data*, vtable*} ──► vtable{drop_in_place,size,align,methods[...]} ──► code
```

**Static dispatch không cần vtable ở đâu cả:** Rust generic monomorphized biết target method tại compile time — vtable chỉ tồn tại cho `dyn Trait`, không phải overhead mặc định của mọi trait.

| | Java | Go | Rust |
|---|---|---|---|
| Bảng dựng lúc nào | Class-loading (linking) | **Runtime**, lần đầu gặp cặp (type,interface) → cache | **Compile-time**, dữ liệu tĩnh trong binary |
| Trả phí khi nào | LUÔN LUÔN | Chỉ khi convert sang interface | Chỉ khi coerce `dyn Trait` |
| Tối ưu runtime | JIT inline caching, devirtualize monomorphic site | Compiler devirtualize rất hạn chế | Monomorphization loại bỏ dispatch cho generic; `dyn Trait` không devirtualize (AOT) |

---

## 🧬 Tầng 9 — Generic: 3 Cách Giải Quyết "Cùng Code, Khác Type"

```
JAVA — Type Erasure: List<Integer> runtime chỉ thấy "ArrayList" → primitive PHẢI box
GO    — GC Shape Stenciling (1.18+): instantiation CÙNG shape (cùng size/số pointer)
         gộp chung 1 bản code + "dictionary" type info truyền lúc runtime
RUST  — Full Monomorphization: mỗi type cụ thể → 1 bản máy riêng, zero overhead,
         đổi lấy binary size lớn hơn + compile lâu hơn
```

---

## 🏗️ Tầng 10 — Allocator Nội Bộ: Ai Thực Sự Phát Ra Địa Chỉ Heap?

> [!abstract] Mental model
> "Heap allocation" không đồng nghĩa "gọi kernel mỗi lần". Cả 3 runtime đều có hierarchy giảm tranh chấp lock/syscall.

```
GO — small allocation:
size class → mcache (P-local, fast path, không lock)
           → mcentral (khi mcache rỗng, refill)
           → mheap / spans / pages → OS virtual memory
large allocation: bypass phần lớn fast path, đi thẳng gần hơn về mheap → OS

JAVA/HOTSPOT:
bytecode `new` → JIT chứng minh không cần? → scalar replacement (elimination)
              → materialize → TLAB (Thread-Local Allocation Buffer) bump pointer
                (không cần đồng bộ hóa liên-thread cho fast path)
              → TLAB hết chỗ → refill / đi slow path của collector

RUST:
Box::new(T)/Vec::new() → GlobalAlloc trait (allocation/deallocation là
UNSAFE CONTRACT) → allocator toàn cục (mặc định hệ thống, hoặc đăng ký
custom allocator qua #[global_allocator])
```

> [!warning] Common misconception
> "Go GC concurrent nên allocation miễn phí" — sai, allocation vẫn làm tăng GC work (xem Tầng 11). "Java heap allocation luôn đắt vì phải lock" — sai với fast path TLAB, đây là mental model lỗi thời. "`Box::new` là probe đáng tin cậy để đếm allocation vật lý" — cũng không hẳn: compiler Rust được phép optimize/elide allocation nếu không đổi observable semantics.

---

## ♻️ Tầng 11 — Lifetime & Reclamation: GC Mechanics Chi Tiết

```
GO — collector: concurrent mark-and-sweep, NON-GENERATIONAL, NON-COMPACTING
  roots (stacks, globals) → concurrent mark (song song mutator, có write
  barrier để không bỏ sót object trở thành reachable qua mutation giữa chừng)
  → khi allocation rate cao, mutator phải làm "mark assist" (trả CPU work
  cho GC) → sweep tái sử dụng span không còn live
  ⚠️ Live object GIỮ NGUYÊN địa chỉ (non-moving) — không compaction toàn cục,
     locality dựa vào span/size-class allocator, không dựa GC

JAVA/HOTSPOT — "Java GC" không phải MỘT thuật toán, mà là POLICY CHỌN ĐƯỢC:
  G1 (mặc định server phổ biến): chia heap thành region đều nhau, generational
    (young/old), EVACUATE (copy) live object sang region khác khi collect
    → hiệu ứng COMPACTION + giảm fragmentation; concurrent marking cho old-gen
  ZGC: đã chuyển sang mô hình GENERATIONAL, tối ưu latency cực thấp
  Parallel GC: tối ưu throughput bằng parallel stop-the-world collection
  ⚠️ Khác biệt kiến trúc rõ với Go: G1 evacuation DI CHUYỂN object (địa chỉ
     đổi), Go thì KHÔNG BAO GIỜ di chuyển object đang sống.

RUST — không có tracing collector chuẩn:
  owner ra khỏi drop scope → gọi Drop/drop glue theo type → deallocate
  Reference counting (Rc/Arc) là construct THƯ VIỆN, không phải GC ngôn ngữ:
  counter về 0 → reclaim; nhưng CYCLE giữa các strong reference có thể khiến
  counter KHÔNG BAO GIỜ về 0 → memory-safe LEAK (không phải use-after-free,
  nhưng vẫn là leak thật) — dùng Weak để phá cycle.
```

| | Go | Java (G1) | Rust |
|---|---|---|---|
| Tracing GC | Có | Có | Không |
| Generational | Không | Có | N/A |
| Compaction | Không | Có (evacuation) | N/A |
| Object địa chỉ | Cố định | Có thể đổi (evacuate) | Cố định (không moving GC) |
| "Không bao giờ leak"? | Vẫn có thể leak qua giữ reference dư thừa | Tương tự | Có thể leak qua `Rc` cycle dù memory-safe |

---

## 🔀 Tầng 12 — Context Switching & Scheduling

```
GO — G-M-P scheduler (user-space, TRÊN kernel scheduling):
  G (goroutine) đang chạy → cần park/block/preempt → SAVE state (SP, PC...)
  vào g.sched/gobuf → CHUYỂN sang g0 (system stack của M) → scheduler tìm
  G runnable khác (findRunnable) → RESTORE context của G mới
  ⚠️ Đây là switch trong USER-SPACE; bên dưới nó, kernel vẫn có thể context-
     switch các OS thread (M) mà Go runtime dùng — 2 tầng scheduling riêng biệt

JAVA — 2 tầng thread hoàn toàn khác nhau:
  Platform thread: wrapper mỏng quanh OS thread → context switch = OS-level
    thread scheduling thông thường, CPU context/stack thuộc native model
  Virtual thread (Project Loom/JEP 444): JVM MOUNT một virtual thread lên
    platform carrier thread; khi gặp blocking op hỗ trợ unmount → UNMOUNT,
    carrier được giải phóng chạy virtual thread khác
  🤯 Điểm đảo ngược trực giác quan trọng nhất bài: STACK CỦA VIRTUAL THREAD
     ĐƯỢC LƯU TRONG GC HEAP dưới dạng "stack-chunk objects", có thể grow/
     shrink — "logical stack" ở đây KHÔNG đồng nghĩa native stack region
  ⚠️ Pinning: một số blocking operation (native method, foreign-function
     call) khiến virtual thread KHÔNG unmount được — không sai correctness
     nhưng giảm scalability vì carrier bị giữ

RUST — 2 mô hình tách biệt hoàn toàn:
  std::thread: NATIVE OS thread thật — context switch là OS-level, không có
    Go-style scheduler chen giữa
  async: KHÔNG CÓ executor/runtime mặc định trong std. Future tiến triển
    khi được executor poll(); trả Pending → tiếp tục sau khi wake+poll lại.
    "Switch task" trong async nghĩa là EXECUTOR ĐỔI FUTURE ĐƯỢC POLL —
    KHÔNG NHẤT THIẾT lưu toàn bộ register set + đổi native stack như OS
    context switch thật (vì async fn lowering thành state machine, không
    phải native stack riêng)
```

| | Go | Java | Rust |
|---|---|---|---|
| Đơn vị lightweight | Goroutine (built-in) | Virtual thread (built-in, JEP 444) | Task/Future (ecosystem chọn runtime, không có trong std) |
| Ai schedule | Go runtime (G-M-P) | JVM (mount/unmount lên carrier) | Executor do bạn chọn (Tokio, async-std...) |
| Stack nằm ở đâu | Runtime-managed goroutine stack | **Stack chunk trong GC heap** khi unmounted | Suspended state = state machine field, không phải OS stack |
| OS thread bên dưới | Có (M), kernel vẫn schedule nó | Platform thread = trực tiếp OS thread | `std::thread` = trực tiếp OS thread |

---

## ⚡ Tầng 13 — Memory Model & Ordering

```
GO:    sync/atomic công khai hành xử như SEQUENTIALLY CONSISTENT — cố ý đơn
       giản hơn C++/Rust. Channel, Mutex, Once, atomics tạo "happens-before
       edges" tường minh trong Go Memory Model. Chia sẻ ordinary memory mà
       thiếu synchronization VẪN LÀ BUG dù atomics "dễ" hơn — dùng `-race`.

JAVA:  Java Memory Model (JLS) dùng happens-before:
       unlock monitor → happens-before → subsequent lock cùng monitor
       write volatile → happens-before → subsequent read volatile field đó
       Thread.start() / join() cũng tạo happens-before edge
       Chương trình correctly-synchronized (data-race-free) → execution
       quan sát được TƯƠNG ĐƯƠNG sequentially consistent (không cấm compiler/
       CPU reorder nội bộ, chỉ giới hạn kết quả quan sát được).

RUST:  Đầy đủ phổ ordering kiểu C++11: Relaxed / Acquire / Release / AcqRel /
       SeqCst — linh hoạt nhất nhưng cũng dễ sai nhất trong 3 ngôn ngữ. Data
       race ở tầng low-level Rust có thể dẫn tới UNDEFINED BEHAVIOR, không
       chỉ "bug logic" như Go/Java.
```

---

## ☠️ Tầng 14 — Unsafe & FFI: Nơi Mọi Invariant Có Thể Bị Phá

> [!danger] Ranh giới nguy hiểm nhất trong cả 3 ngôn ngữ

```
GO:    unsafe.Pointer + cgo có thể phá assumption mà GC/stack management
       dựa vào. Ví dụ kinh điển: giấu Go pointer dưới dạng integer đủ lâu
       khiến runtime KHÔNG còn nhận nó là pointer root → GC bỏ sót.
       runtime/cgo.Handle tồn tại CHÍNH ĐỂ truyền giá trị chứa Go pointer
       qua C dưới dạng handle thay vì vi phạm pointer-passing rules.

JAVA:  JNI/native memory nằm NGOÀI phần lớn managed assumptions. Native
       Memory Tracking (NMT) chỉ theo dõi memory do HotSpot SUBSYSTEM quản
       lý — KHÔNG thấy allocation của native code bên thứ 3 (JNI leak điều
       tra sai công cụ sẽ mất dấu).

RUST:  unsafe không tắt "memory rules" — nó chuyển trách nhiệm CHỨNG MINH
       invariant (pointer hợp lệ, không alias vi phạm, layout đúng, lifetime
       đúng) từ compiler sang PROGRAMMER. Vi phạm vẫn là Undefined Behavior
       dù code compile và "có vẻ chạy đúng".
```

---

## 🔬 Tầng 15 — Diagnostics: Đo Thay Vì Đoán

| | Go | Java | Rust |
|---|---|---|---|
| Công cụ chính | `pprof` (heap, cpu, goroutine, threadcreate, block, mutex profiles) | JFR/JDK Mission Control, `jcmd` (heap dump, class histogram, thread dump), NMT | Không có profiler GC managed-heap tương đương (vì không có tracing GC) — dùng allocator/OS-level tool (`valgrind`, `heaptrack`, `perf`) |
| Giới hạn cần nhớ | Escape output (`-gcflags=-m`) bổ sung cho pprof để hiểu allocation pressure | **NMT không thấy native leak ngoài JVM** | Benchmark phải đo allocation thật (`criterion` + hardware counters), vì compiler có thể elide allocation |

> [!tip] Nguyên tắc đo lường chung cho cả 3 ngôn ngữ
> Đo **allocation rate, retained/live memory, GC CPU/pause, thread/task behavior, dispatch profile** — KHÔNG đếm số dòng có `new`/`&`/`Box::new`/interface call trong source. Mọi runtime ở đây đều có optimization khiến source-level construct không ánh xạ 1-1 sang physical allocation/code path.

---

## 📊 Bảng Tổng Hợp Toàn Diện

| Trục | Java/HotSpot | Go | Rust |
|---|---|---|---|
| Header trên object | Luôn có (mark word + Klass ptr) | Không có universal header | Không có universal header |
| Stack/Heap quyết định bởi | JIT escape analysis (runtime, best-effort) | Compiler escape analysis (compile-time, cứng nhưng có thể đổi giữa version) | Developer tường minh 100% |
| Allocator fast path | TLAB bump pointer | `mcache`(P-local)→`mcentral`→`mheap` | `GlobalAlloc` (mặc định hệ thống hoặc custom) |
| Dispatch metadata | object→Klass→vtable, LUÔN gắn với object | `ITab*+data` (interface có method) hoặc `type*+data` (empty interface), chỉ khi box | wide pointer `{data,vtable}`, chỉ khi `dyn Trait` |
| Dispatch bảng dựng lúc | class-loading | runtime, cache theo cặp (type,interface) | compile-time, tĩnh |
| Tracing GC | Có (nhiều collector: G1/ZGC/Parallel...) | Có (1 collector: concurrent mark-sweep) | Không |
| Generational/Compacting | G1: cả hai | Không cả hai | N/A |
| Lightweight concurrency | Virtual thread (JEP 444), stack **trong GC heap** khi unmounted | Goroutine (built-in) | Async task (ecosystem chọn runtime) |
| Atomic ordering | JMM happens-before + `volatile` | SC atomics (đơn giản nhất) | Relaxed/Acquire/Release/AcqRel/SeqCst (linh hoạt nhất) |
| FFI hazard chính | NMT không thấy native leak bên thứ 3 | Go pointer giấu trong integer khiến GC bỏ sót | `unsafe` chuyển trách nhiệm invariant sang programmer |
| Rủi ro "leak dù an toàn" | Giữ reference dư thừa | Giữ reference dư thừa | `Rc`/`Arc` cycle |

---

## 🏦 Case Study PDMS — Cùng 1 `Document`, 3 Cách Nằm Trong RAM Và 3 Cách Bị Thu Hồi

```
┌─ JAVA ────────────────────────────────────────────────────┐
│ header + 2 ref→String + long size = ~36B "vỏ" object,      │
│ CHƯA TÍNH 2 String con (mỗi String lại có header riêng)     │
│ → 1 Document "nhẹ" thực tế rải rác ~90-120B ở nhiều vùng    │
│ heap khác nhau. Khi hết reachable: G1 evacuate nó (nếu còn  │
│ trẻ) sang survivor/old region — ĐỊA CHỈ CÓ THỂ ĐỔI.         │
└──────────────────────────────────────────────────────────┘

┌─ GO ──────────────────────────────────────────────────────┐
│ struct inline liền mạch (nếu trong []Document, không phải   │
│ []*Document) — 2 string CHỈ trỏ ra ngoài cho phần byte thật. │
│ Khi hết reachable: mark-sweep đánh dấu rồi trả span về pool  │
│ — ĐỊA CHỈ KHÔNG ĐỔI, không có bước evacuate.                │
└──────────────────────────────────────────────────────────┘

┌─ RUST ────────────────────────────────────────────────────┐
│ struct inline liền mạch trong Vec<Document> — cache-friendly│
│ khi duyệt hàng loạt. Khi Vec (hoặc owner) ra khỏi scope: mỗi │
│ Document bị Drop TƯỜNG MINH ngay lập tức, không chờ collector│
│ cycle nào — deterministic, dự đoán được thời điểm chính xác. │
└──────────────────────────────────────────────────────────┘
```

Trong bối cảnh [[file-etl]] (batch validate/load hàng triệu row Excel/CSV), 3 khác biệt này cộng dồn: Java trả giá GC evacuation + reference rải rác; Go tránh evacuation nhưng vẫn trả GC mark-work theo allocation rate; Rust không trả giá tracing GC nào nhưng đòi hỏi ownership graph được thiết kế đúng để free đúng lúc, đúng chỗ.

---

## 📝 Pitfalls Nhanh — Tra Cứu Khi Review Code

**Go**

| Sai lầm | Đúng |
|---|---|
| "`&x`/`new` chắc chắn heap" | Compiler quyết định; xem escape output |
| "GC concurrent nên allocation free" | Vẫn tốn GC work, mark assist, write barrier |
| "Interface giống Java object có vptr" | Interface value mang `ITab+data`; concrete object không có vptr đó |
| "Goroutine switch = OS context switch" | User-space scheduling trên M/P, tầng khác OS scheduling |

**Java**

| Sai lầm | Đúng |
|---|---|
| "Mỗi `new` là physical allocation" | JIT có thể scalar-replace/eliminate |
| "Escape analysis = object xuống stack" | Scalar replacement/allocation elimination là mô tả đúng |
| "Mọi object header cố định X byte" | JVMS không mandate; Compact Object Headers thay đổi layout |
| "Java chỉ 1 thuật toán GC" | HotSpot có nhiều collector (G1/ZGC/Parallel...), là policy chọn được |
| "Virtual thread là OS thread nhỏ" | JVM mount/unmount lên carrier; stack nằm trong GC heap |
| "NMT thấy mọi native leak" | Chỉ thấy JVM-internal, không thấy native code bên thứ 3 |

**Rust**

| Sai lầm | Đúng |
|---|---|
| "Không GC = không có heap" | `Box`/`Vec`/`String`/`Rc` vẫn dùng heap, khác ở cách quản lý lifetime |
| "Borrow checker tự đưa local lên heap khi cần" | Compile fail; phải chọn ownership representation khác |
| "Mọi trait có vtable overhead" | Chỉ `dyn Trait`; static/generic monomorphized không cần |
| "Rust vtable layout là ABI ổn định" | Chỉ là rustc implementation detail |
| "Memory-safe Rust không leak" | `Rc` cycle vẫn leak được (memory-safe nhưng không zero-leak) |

---

## 📝 Key Takeaways

1. Trục thật sự không phải "GC vs không GC" — mà là ai giữ metadata, ai quyết định stack/heap, và trả phí lúc nào.
2. **"Escape analysis = stack allocation"** là misconception phổ biến nhất — với Java, mô tả đúng là scalar replacement/allocation elimination; với Go, đó vẫn là compiler heuristic có thể đổi giữa version, không phải cú pháp quyết định.
3. 3 cơ chế vtable dùng thuật ngữ và vòng đời dựng bảng khác hẳn nhau: Go `ITab` (runtime-cached theo cặp type/interface), Java Klass metadata (class-loading, luôn gắn với object), Rust vtable (compile-time static, chỉ khi `dyn Trait`).
4. GC không phải một thuật toán — Go là 1 collector cố định (concurrent mark-sweep, non-generational, non-compacting); Java/HotSpot là NHIỀU collector chọn được (G1 mặc định, generational, có evacuation/compaction); Rust không có tracing GC nhưng vẫn có heap và vẫn có thể leak qua `Rc` cycle.
5. Điểm đảo ngược trực giác lớn nhất: **stack của Java virtual thread nằm TRONG GC heap** dưới dạng stack-chunk object khi unmounted — "logical stack" không đồng nghĩa native stack region.
6. Rust không có Go-style escape promotion cho correctness: reference tới local chết bị compile-error, không có bước runtime "cứu" bằng cách heap-promote.
7. Memory ordering đơn giản dần từ Rust (đầy đủ phổ C++11) → Java (happens-before/JMM) → Go (SC atomics, cố ý đơn giản nhất).
8. `unsafe`/FFI là nơi mọi runtime đều có thể bị phá invariant: Go pointer giấu trong integer khiến GC bỏ sót, Java NMT không thấy native leak bên thứ 3, Rust unsafe chuyển trách nhiệm chứng minh sang programmer nhưng UB vẫn là UB.

---

## 🔗 Liên kết

- [[rust-java-go-comparison]] — bức tranh tổng thể GC/ownership/concurrency/ecosystem ở mức tổng quan hơn
- [[gc-llvm-runtime-cpu-memory-internals]] — bổ sung góc nhìn compiler backend (LLVM vs Go compiler) ảnh hưởng tới hiệu năng cuối
- [[memory-hierarchy-cpu-cache]] — vì sao layout liền mạch (Case Study Tầng cuối) quyết định throughput qua cache locality
- [[native-image-aot-jit]] — AOT vs JIT ảnh hưởng thế nào tới việc scalar-replace/devirtualize
- [[java-virtual-threads-deep-dive]], [[project-loom-deep-dive]] — đào sâu riêng cơ chế mount/unmount và stack chunk
- [[file-etl]] — nơi áp dụng thực tế: batch validate/load hàng triệu row, khác biệt GC/allocator giữa 3 ngôn ngữ ảnh hưởng trực tiếp throughput

> [!note] Ý tưởng mở rộng tiếp theo (chưa làm)
> Research gốc đề xuất tách bài này thành một MOC (`Memory-Management-Go-Java-Rust.md`) cộng ~15 note chuyên sâu riêng từng chủ đề (`Go-Interface-ITab.md`, `HotSpot-VTable-and-Klass.md`, `Rust-Trait-Object-VTable.md`, `Context-Switching.md`, `Memory-Models-and-Ordering.md`...) để cập nhật từng mảnh (vd. "HotSpot compact header mới") mà không sửa toàn bộ bài. Đây là việc đáng làm nếu bài này tiếp tục phình to — nói khi nào muốn tách.
