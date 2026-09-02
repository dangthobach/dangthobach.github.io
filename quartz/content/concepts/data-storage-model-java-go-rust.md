---
tags: [concepts, memory, storage, java, go, rust, jvm, runtime, evergreen]
created: 2026-09-02
difficulty: advanced
estimated-read: 40 min
links: [rust-java-go-comparison, gc-llvm-runtime-cpu-memory-internals, memory-hierarchy-cpu-cache, native-image-aot-jit, java-virtual-threads-deep-dive]
type: concept
domain: concepts
status: active
updated: 2026-09-02
---

# 🗄️ Mô Hình Lưu Trữ Dữ Liệu — Java vs Go vs Rust: Từ Tổng Quan Hệ Thống Đến Chi Tiết Bit-Level

> **Mục tiêu:** Hệ thống hóa toàn bộ cách 3 ngôn ngữ này biểu diễn dữ liệu trong bộ nhớ — không phải "GC vs không GC" (đã có ở [[rust-java-go-comparison]] §2), mà là câu hỏi sâu hơn: **metadata nằm ở đâu, ai trả phí cho nó, và trả lúc nào.**

---

## 🎯 Trục phân tích: không phải "có GC hay không"

Cách phân loại phổ biến "Java/Go có GC, Rust không có GC" đúng nhưng nông. Trục thực sự quyết định mọi thứ bên dưới là **3 câu hỏi**, áp dụng cho MỌI đơn vị dữ liệu (scalar, struct, string, collection, interface):

1. **Metadata có bị bắt buộc gắn liền với value không?** (header, type tag, vtable pointer...)
2. **Ai quyết định stack hay heap — và quyết định lúc nào?** (compile time tường minh / compile time suy luận / runtime GC)
3. **Chi phí đó trả cho MỌI value, hay chỉ trả khi thực sự cần (opt-in)?**

Toàn bộ bài này đi từ tầng tổng quát nhất (triết lý hệ thống) xuống tầng chi tiết nhất (byte layout), áp câu hỏi trên vào từng loại dữ liệu.

---

## 🏛️ Tầng 0 — Ba Triết Lý Lưu Trữ Tổng Quát

```
┌───────────────────────────┐  ┌───────────────────────────┐  ┌───────────────────────────┐
│          JAVA              │  │           GO               │  │          RUST              │
│   Managed Object Model      │  │   Value-type + GC          │  │  Value-type + Ownership     │
├───────────────────────────┤  ├───────────────────────────┤  ├───────────────────────────┤
│ Mọi non-primitive = object  │  │ struct = value trần,        │  │ struct = value trần,        │
│ → LUÔN ở heap                │  │ không header                │  │ không header                │
│ → LUÔN có header (12-16B)   │  │ stack/heap: compiler quyết  │  │ stack mặc định; heap CHỈ    │
│ GC quản lý toàn bộ vòng đời  │  │ định bằng escape analysis   │  │ khi gọi Box/Vec/String/Rc   │
│                              │  │ (cứng, xem được qua -gcflags)│  │ tường minh — không compiler │
│                              │  │ GC chỉ quản lý phần đã       │  │ nào tự ý heap-alloc hộ bạn  │
│                              │  │ escape lên heap              │  │ Ownership → free            │
│                              │  │                              │  │ deterministic, KHÔNG GC     │
└───────────────────────────┘  └───────────────────────────┘  └───────────────────────────┘
     Metadata: bắt buộc              Metadata: opt-in (chỉ khi        Metadata: opt-in (chỉ khi
     100% mọi object                 box vào interface)                coerce sang fat pointer)
```

**Hệ quả then chốt:** Java trả phí metadata cho MỌI object bất kể có dùng polymorphism hay không. Go và Rust chỉ trả phí khi bạn *chủ động* yêu cầu (interface conversion / `dyn Trait`) — phần còn lại của chương trình chạy như C.

---

## 🔢 Tầng 1 — Scalar / Primitive: đơn vị nhỏ nhất

| Kiểu | Java | Go | Rust |
|---|---|---|---|
| Số nguyên 32-bit | `int` — 4B, value | `int32` — 4B, value | `i32` — 4B, value |
| Số nguyên 64-bit | `long` — 8B, value | `int64` — 8B, value | `i64` — 8B, value |
| Số thực | `double` — 8B, value | `float64` — 8B, value | `f64` — 8B, value |
| Boolean | `boolean` — impl-defined (thường 1B trong array, 4B khi đứng lẻ do alignment) | `bool` — 1B | `bool` — 1B |
| Ký tự | `char` — **2B, UTF-16 code unit** (KHÔNG phải 1 code point đầy đủ — code point ngoài BMP cần surrogate pair 2×char) | `rune` (alias `int32`) — **4B, full Unicode scalar value** | `char` — **4B, full Unicode scalar value** |

**Điểm dễ nhầm nhất:** Java `char` không tương đương Go `rune` hay Rust `char` — Java `char` chỉ là nửa mảnh của một số code point (UTF-16 code unit), còn Go/Rust dùng biểu diễn 4-byte đủ cho mọi code point Unicode trong 1 giá trị.

**Boxing — chi phí ẩn khi scalar "biến thành object":**

```java
// Java: mọi lúc dùng generic (List<Integer>), int PHẢI box thành object
Integer boxed = 42;
// Bộ nhớ: 12-16B header + 4B int value → 16B total (padded), thay vì 4B thô
// Integer cache: -128..127 được cache sẵn, ngoài range → alloc mới mỗi lần
```

```go
// Go: value chỉ "box" (heap-escape + metadata) khi gán vào interface{}
var i interface{} = 42
// int 42 quá nhỏ để fit trực tiếp vào word của interface value trên phần lớn
// implementation hiện đại → có thể escape lên heap, kèm theo 1 word type descriptor
```

```rust
// Rust: KHÔNG BAO GIỜ tự động box. Muốn heap, phải viết tường minh:
let boxed: Box<i32> = Box::new(42); // chỉ heap khi bạn gọi Box::new
```

---

## 📦 Tầng 2 — Composite: Struct/Object Layout

### 2.1 Java — Header bắt buộc trên MỌI object

```
┌─────────────────────────────┐
│  Mark Word (8 byte)         │ ← hash code, GC age, lock state (biased/thin/fat lock)
├─────────────────────────────┤
│  Klass Pointer (4B nếu       │ ← trỏ tới class metadata (vtable + itable nằm ở đây)
│  compressed oops, mặc định   │
│  khi heap < 32GB; 8B nếu tắt)│
├─────────────────────────────┤
│  [padding tới bội số 8B]    │
├─────────────────────────────┤
│  field 1, field 2, ...      │ ← JVM TỰ SẮP THỨ TỰ (long/double → int/float →
└─────────────────────────────┘    short/char → byte/boolean → reference) để giảm padding
```

Chi tiết tính overhead header và field-reordering đã có ở [[memory-hierarchy-cpu-cache]] (Tip 2) — điểm bổ sung ở đây: **developer không kiểm soát được thứ tự vật lý field**, JVM tự tối ưu bất kể bạn khai báo thứ tự nào trong source code.

### 2.2 Go — Plain struct, field order do BẠN quyết định

Không header, nhưng khác Java: **compiler KHÔNG tự reorder field** — thứ tự khai báo = thứ tự vật lý trong bộ nhớ. Bạn tự chịu trách nhiệm tránh padding lãng phí:

```go
type Bad struct {   // 24 bytes: bool(1)+pad(7)+int64(8)+bool(1)+pad(7)
    A bool
    B int64
    C bool
}
type Good struct {  // 16 bytes: int64(8)+bool(1)+bool(1)+pad(6)
    B int64
    A bool
    C bool
}
```

### 2.3 Rust — Compiler tự reorder (mặc định), nhưng có `repr` để kiểm soát

```rust
struct Document {   // repr(Rust) mặc định: compiler ĐƯỢC PHÉP reorder field
    id: String,      // giống Java, developer không đảm bảo thứ tự vật lý
    size: u64,
    active: bool,
}

#[repr(C)]           // ép giữ đúng thứ tự khai báo — bắt buộc khi FFI với C/Go qua CGO
struct FfiDocument { id: u64, active: bool }
```

**Hai tối ưu chỉ Rust có:**
- **Zero-Sized Types (ZST):** `struct Marker;` chiếm **0 byte**. `Vec<Marker>` với 1 triệu phần tử **không cấp phát byte dữ liệu nào** (chỉ có len/cap).
- **Niche optimization:** `&T`/`Box<T>` không bao giờ null → compiler mượn chính giá trị `0x0` làm biểu diễn ẩn cho `None`, nên `Option<Box<T>>` có **kích thước bằng đúng** `Box<T>` — không tốn thêm byte nào cho "có giá trị hay không", khác hẳn wrapper nullable tốn thêm cờ boolean ở ngôn ngữ khác.

---

## 🧭 Tầng 3 — Ai Quyết Định Stack Hay Heap?

```
JAVA:  JIT escape analysis (runtime, "best-effort", KHÔNG đảm bảo)
       → nếu chứng minh object không escape method → "scalar replacement"
       → tách field ra biến cục bộ trên stack/register — ẩn, dev không kiểm soát

GO:    Compiler escape analysis (compile-time, CỨNG — quyết định 1 lần, xem được)
       $ go build -gcflags="-m"  → in ra "escapes to heap" / "does not escape"
       Value escape khi: trả về pointer, capture trong closure lưu lâu,
       gán vào interface{}, kích thước quá lớn cho stack

RUST:  Developer TƯỜNG MINH 100% — stack mặc định, heap CHỈ khi gọi
       Box::new / Vec::new / String::new / Rc::new / Arc::new
       → không có "compiler tự ý heap alloc" ẩn ở bất kỳ đâu
```

Đây là khác biệt triết lý sâu nhất: Java và Go đều có một "cơ chế thông minh" (JIT/escape analysis) quyết định thay bạn — tiện nhưng khó dự đoán 100%. Rust từ chối mọi allocation ẩn, đổi lấy việc bạn phải viết `Box`/`Vec` tường minh ở mọi nơi cần heap.

---

## 👉 Tầng 4 — Pointer/Reference: Thin vs Fat

| | Java (reference/oop) | Go (`*T`) | Rust (`&T`) |
|---|---|---|---|
| Kích thước cơ bản | 4B (compressed oops, heap<32GB) hoặc 8B | 8B (thin, luôn 1 word) | 8B nếu `T: Sized` (thin) |
| Khi nào "phình" ra | Không bao giờ — luôn trỏ tới object có header riêng | Không bao giờ | **Fat pointer (16B)** khi `T` unsized: `&[T]` slice → {ptr, len}; `&str` → {ptr, len}; `&dyn Trait` → {ptr, vtable} |
| Null | Có (`null`), mọi reference type | Có (`nil`) | **Không có null** — dùng `Option<&T>` (niche-optimized, vẫn 8B nhờ mục 2.3) |

---

## 🔤 Tầng 5 — String: Cùng Khái Niệm, 3 Cách Lưu Hoàn Toàn Khác

```
JAVA (từ Java 9, JEP 254 "Compact Strings"):
┌─────────────────────────────────────┐
│ header (12-16B)                      │
│ byte[] value    ← LATIN1 (1B/char)   │  chỉ dùng UTF16 (2B/char) nếu có
│                   HOẶC UTF16          │  ký tự ngoài Latin-1
│ byte coder      ← cờ chọn encoding    │
│ int hash        ← cache, lazy compute │  (an toàn vì String immutable)
└─────────────────────────────────────┘
+ String pool (intern): literal string dùng chung 1 bản trong pool

GO:
┌──────────┬──────────┐
│ pointer  │  len     │  ← 2-word header (16B), TRỎ tới mảng byte UTF-8 bất biến
└──────────┴──────────┘
Slicing string (s[2:5]) CHIA SẺ cùng backing array — copy header rẻ (16B),
không copy dữ liệu.

RUST:
String (owned, growable):        &str (borrow, view):
┌──────────┬─────┬──────┐        ┌──────────┬──────┐
│ pointer  │ len │ cap  │        │ pointer  │ len  │
└──────────┴─────┴──────┘        └──────────┴──────┘
   3-word (24B), thực chất            2-word fat pointer (16B)
   là Vec<u8> đã validate UTF-8       không có capacity vì immutable view
```

Không có string pool tự động trong Rust — trừ `&'static str` (literal) nằm sẵn trong `.rodata` của binary, không cần alloc runtime.

---

## 📚 Tầng 6 — Collection: ArrayList / Slice / Vec

| | Java `ArrayList<T>` | Go `[]T` (slice) | Rust `Vec<T>` |
|---|---|---|---|
| Header | `Object[] elementData` + `int size` — mỗi phần tử là 1 reference riêng (pointer chasing nếu T không phải primitive box sẵn) | 3-word `{ptr, len, cap}` trỏ backing array liên tục | 3-word `{ptr, len, cap}` — **giống hệt Go về cấu trúc** |
| Growth factor | ×1.5 (`oldCap + oldCap>>1`) | ~×2 cho slice nhỏ, giảm dần ~×1.25 khi lớn (thay đổi giữa các bản Go runtime) | ×2 (amortized doubling) |
| Generic | Type-erased → `Object[]`, primitive phải box | Monomorphized qua GC shape stenciling (Tầng 9) | Monomorphized hoàn toàn (Tầng 9) |
| **Pitfall aliasing** | Không có (copy-on-write không tồn tại, mỗi list độc lập) | ⚠️ 2 slice từ cùng backing array **CHIA SẺ** vùng nhớ — sửa qua slice này ảnh hưởng slice kia nếu vùng overlap (bug kinh điển khi `append`/truncate batch trong pipeline) | Không thể xảy ra ẩn — borrow checker buộc bạn tường minh hóa việc chia sẻ (`&[T]`), và cấm dùng slice sau khi `Vec` gốc bị resize/drop |

---

## 🎭 Tầng 7 — Enum / Sum Type / "Không Có Giá Trị"

```
JAVA — null là giá trị đặc biệt của MỌI reference type:
String s = null;      // hợp lệ với BẤT KỲ reference nào — không gì ngăn được
s.length();           // NullPointerException tại RUNTIME

GO — nil, và cạm bẫy "typed nil" nổi tiếng:
var p *MyType = nil
var i MyInterface = p     // interface value = {type: *MyType, data: nil}
i != nil                  // → TRUE! vì type descriptor KHÁC nil,
                           //   dù data logically nil — interface toàn phần
                           //   chỉ nil khi CẢ type VÀ data đều nil

RUST — không có null. Enum = tagged union thật sự:
enum Shape {
    Circle(f64),           // payload lớn nhất: 8B
    Rectangle(f64, f64),   // payload lớn nhất: 16B ← quyết định size union
    Empty,
}
┌────────────┬───────────────────────────┐
│  tag (8B)  │   payload (16B, DÙNG CHUNG) │  → tổng 24B, KHÔNG cộng dồn
└────────────┴───────────────────────────┘   từng variant như struct thường
```

`Option<T>` chính là enum 2 variant (`Some(T)` / `None`) — với niche optimization (mục 2.3), `Option<Box<T>>`/`Option<&T>` **free** về mặt kích thước so với kiểu gốc.

---

## 🧩 Tầng 8 — Interface / Trait Object: Vtable Bắt Buộc vs Opt-in

*(tóm tắt lại có hệ thống — chi tiết đầy đủ về cơ chế vtable/itable/itab đã build trong series thảo luận trước, đây là bản tổng hợp chuẩn hóa cho bài viết)*

| | Java | Go | Rust |
|---|---|---|---|
| Đơn vị dữ liệu | Object header ĐÃ CÓ SẴN klass pointer → tái dùng cho cả invokevirtual (vtable) và invokeinterface (itable) | **Interface value** — 2-word `{type ptr, data ptr}`, chỉ tồn tại khi convert | **Fat pointer** — 2-word `{data ptr, vtable ptr}`, chỉ tồn tại khi coerce `dyn Trait` |
| Bảng dựng lúc nào | Class-loading (linking) | **Runtime**, lần đầu gặp cặp (type, interface) → `itab` được cache lại | **Compile-time**, dữ liệu tĩnh trong binary — không có bước dựng lúc runtime |
| Trả phí khi nào | LUÔN LUÔN (mọi object) | Chỉ khi convert sang interface | Chỉ khi coerce sang `dyn Trait` |
| Tối ưu runtime | JIT inline caching — monomorphic call site gần như free | Compiler devirtualize rất hạn chế | Monomorphization loại bỏ dispatch cho generic; `dyn Trait` không devirtualize được (AOT) |

---

## 🧬 Tầng 9 — Generic: 3 Cách Giải Quyết "Cùng Code, Khác Type"

```
JAVA — Type Erasure:
List<Integer> list;   // runtime chỉ thấy "ArrayList", KHÔNG có <Integer>
                       // → primitive PHẢI box (Integer, không phải int)
                       // → pointer chasing khi duyệt list số nguyên

GO — GC Shape Stenciling (từ Go 1.18):
func Map[T, R any](s []T, f func(T) R) []R { ... }
// Các instantiation CÙNG "shape" (cùng kích thước/số con trỏ trong layout,
// ví dụ mọi T là pointer 8-byte) → GỘP CHUNG 1 bản code, truyền thêm
// "dictionary" (bảng type info) lúc runtime → ít code bloat hơn Rust,
// nhưng có 1 lớp indirection nhẹ, không hoàn toàn zero-cost

RUST — Full Monomorphization:
fn largest<T: PartialOrd>(list: &[T]) -> &T { ... }
// Mỗi type cụ thể dùng thực tế → 1 BẢN MÁY RIÊNG tại compile time
// largest::<i32>, largest::<String>, ... đều là hàm độc lập, inline được
// Zero runtime overhead, đổi lại: binary size lớn hơn + compile lâu hơn
```

---

## 📊 Bảng Tổng Hợp Toàn Diện

| Storage unit | Java | Go | Rust |
|---|---|---|---|
| Scalar | Value; box → object +12-16B overhead | Value trần; box chỉ khi vào `interface{}` | Value trần; box chỉ khi `Box<T>` tường minh |
| Header trên struct/object | **Luôn có** (12-16B) | Không có | Không có |
| Field reordering | JVM tự động | Không tự động (dev tự sắp) | Compiler tự động (`repr(Rust)`); tường minh nếu `repr(C)` |
| Stack/Heap | JIT escape analysis (runtime, best-effort) | Compiler escape analysis (compile-time, cứng) | Developer tường minh 100% |
| Reference | oop, có thể compressed 4B | Pointer trần 8B, luôn thin | Thin (Sized) hoặc fat 16B (unsized) |
| String | `byte[]`+coder (Compact Strings) + cached hash + pool | 2-word `{ptr,len}`, UTF-8 bất biến | `String` owned 3-word; `&str` fat 2-word |
| Array/List | `Object[]`+size, generic erased | slice 3-word, backing array **shareable** | `Vec` 3-word, `&[T]` fat 2-word, **ownership rõ ràng** |
| Nullable | `null` mọi reference, NPE runtime | `nil`, "typed nil" gotcha | Không null; `Option<T>` tagged union, niche-optimized |
| Interface/dyn | klass ptr sẵn có + vtable/itable, class-loading | interface value 2-word + `itab` cache runtime | fat pointer 2-word + vtable static compile-time |
| Generic | Type erasure + boxing | GC shape stenciling + dictionary | Monomorphization, zero-cost |

---

## 🏦 Case Study PDMS — Cùng 1 `Document`, 3 Cách Nằm Trong RAM

```
struct/class Document { id: String, status: String, size: u64 }

┌─ JAVA ────────────────────────────────────────────────────┐
│ header(16B) + ref→String id(4B) + ref→String status(4B)    │
│ + long size(8B) + padding(4B) = 36B CHO RIÊNG "vỏ" object,  │
│ CHƯA TÍNH 2 String con — mỗi String LẠI có header riêng     │
│ (16B) + byte[] payload riêng → tổng 1 Document "nhẹ" thực   │
│ tế tốn ~90-120B rải rác ở nhiều vùng heap khác nhau         │
└──────────────────────────────────────────────────────────┘

┌─ GO ──────────────────────────────────────────────────────┐
│ struct Document { ID string; Status string; Size uint64 }   │
│ = 16B(ID header) + 16B(Status header) + 8B(Size) = 40B      │
│ INLINE liền mạch trong 1 vùng nhớ (nếu Document trên stack/ │
│ trong slice) — 2 string CHỈ trỏ ra ngoài cho phần byte thật, │
│ bản thân struct không rải rác như Java                       │
└──────────────────────────────────────────────────────────┘

┌─ RUST ────────────────────────────────────────────────────┐
│ struct Document { id: String, status: String, size: u64 }   │
│ = 24B(id: ptr+len+cap) + 24B(status) + 8B(size) = 56B        │
│ CŨNG inline liền mạch; Vec<Document> → toàn bộ struct nằm    │
│ liên tục trong 1 buffer (cache-friendly khi duyệt hàng loạt) │
└──────────────────────────────────────────────────────────┘
```

Khi xử lý batch hàng triệu `Document` (đúng bối cảnh [[file-etl]] — engine validate/load Excel/CSV cho PDMS), khác biệt này quyết định trực tiếp: Java `List<Document>` = mảng con trỏ tới object rải rác (cache miss khi duyệt), còn Go/Rust nếu dùng `[]Document`/`Vec<Document>` (không phải slice/Vec con trỏ) thì cả mảng struct nằm liền mạch → duyệt tuần tự tận dụng prefetcher gần như tối đa (xem thêm [[memory-hierarchy-cpu-cache]] về cache line và prefetching).

---

## 📝 Key Takeaways

1. **Trục thật sự không phải "GC vs không GC"** — mà là: metadata bắt buộc hay opt-in, ai quyết định stack/heap, và trả phí lúc nào.
2. Java trả phí header (12-16B) cho **MỌI** object, bất kể có polymorphism hay không — bù lại JIT rất giỏi triệt tiêu chi phí virtual call ở call site monomorphic.
3. Go và Rust có struct **hoàn toàn trần** — chỉ phát sinh metadata khi bạn chủ động box vào `interface{}`/`dyn Trait`.
4. Escape analysis của Go là **compile-time, cứng, xem được** (`-gcflags="-m"`); của Java là **JIT runtime, best-effort, ẩn**. Rust **không có** escape analysis vì heap alloc luôn tường minh.
5. Fat pointer (2 word) xuất hiện ở Rust cho `&[T]`, `&str`, `&dyn Trait` — Go và Java không có khái niệm này vì reference của chúng luôn thin.
6. Niche optimization là thứ chỉ Rust có: `Option<&T>`/`Option<Box<T>>` **free** về size nhờ mượn giá trị null làm tag ẩn.
7. Go slice và Rust `Vec` có cấu trúc header giống hệt nhau (3-word `{ptr,len,cap}`) — khác biệt duy nhất là ownership: Go cho phép 2 slice âm thầm share backing array (pitfall), Rust bắt buộc tường minh hóa qua borrow checker.
8. 3 cách giải generic hoàn toàn khác triết lý: Java erasure+boxing (chậm nhất, cache-unfriendly), Go dictionary-passing qua shape stenciling (cân bằng), Rust monomorphization (nhanh nhất, đổi lấy binary size).

---

## 🔗 Liên kết

- [[rust-java-go-comparison]] — bức tranh tổng thể GC/ownership/concurrency/ecosystem (bài này đào sâu riêng phần storage layout)
- [[gc-llvm-runtime-cpu-memory-internals]] — cơ chế GC và runtime internals chi tiết hơn
- [[memory-hierarchy-cpu-cache]] — cache line, false sharing, tại sao layout liền mạch (Tầng 6, Case Study) quan trọng
- [[native-image-aot-jit]] — AOT vs JIT ảnh hưởng thế nào tới việc tối ưu storage
- [[java-virtual-threads-deep-dive]] — stack memory của virtual thread so với OS thread
- [[file-etl]] — nơi áp dụng thực tế: batch validate/load hàng triệu row, layout struct liền mạch quyết định throughput
