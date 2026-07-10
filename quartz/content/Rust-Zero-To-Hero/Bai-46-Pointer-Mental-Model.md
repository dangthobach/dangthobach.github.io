# Bài 46: Pointer — Bản Chất, Phân Loại & Tư Duy Tối Ưu

> Chào Chuyên gia Java. Bài 8 và Bài 19 đã cho bạn *API* của smart pointer và raw pointer. Bài này cho bạn *mental model* — thứ khiến bạn từ "biết dùng `Box`, `Rc`, `&`" chuyển sang "biết tại sao, khi nào, và trả giá gì". Đây là bài bạn cần đọc chậm, vì nó là nền móng cho toàn bộ hiểu biết hệ thống (systems-level understanding) sau này.

---

## 0. Vì sao Java không dạy bạn điều này

Trong Java, mọi object đều nằm trên heap, mọi biến object là một reference (về bản chất là một con trỏ), và GC đảm bảo con trỏ đó luôn valid. Bạn chưa từng phải nghĩ:
- Con trỏ này trỏ vào đâu, còn sống không?
- Có bao nhiêu con trỏ đang cùng trỏ vào đây, ai được sửa?
- Con trỏ này nằm ở đâu trong bộ nhớ — stack hay heap?

Rust bắt bạn trả lời cả ba câu hỏi trên **tại compile time**, cho mọi loại con trỏ. Đó là lý do "pointer" trong Rust không phải một khái niệm — nó là một **họ khái niệm** với luật chơi khác nhau. Hiểu đúng bản chất nghĩa là hiểu được sự khác biệt giữa các loại này, không phải học thuộc cú pháp.

---

## 1. Bản chất tuyệt đối: Pointer là gì?

Bỏ qua Rust, C, Java — về phần cứng, **con trỏ chỉ là một số nguyên** lưu địa chỉ byte đầu tiên của một vùng nhớ. Không hơn không kém.

```
Bộ nhớ (đơn giản hóa):
Địa chỉ:   0x1000  0x1004  0x1008  0x100C
Giá trị:   [ 42  ][      ][      ][      ]

let x = 42i32;       // x nằm ở địa chỉ 0x1000, chiếm 4 byte
let p = &x;           // p là một số nguyên có giá trị "0x1000"
```

Tất cả những gì ngôn ngữ lập trình thêm vào là **ngữ nghĩa xoay quanh con số đó**:
- **Kiểu dữ liệu** để biết đọc bao nhiêu byte và diễn giải thế nào (`*i32` đọc 4 byte, diễn giải là số nguyên).
- **Luật sở hữu / tuổi thọ** để biết con số đó còn trỏ vào vùng nhớ hợp lệ hay không.
- **Luật truy cập đồng thời** để biết ai được đọc, ai được ghi, tại một thời điểm.

Java giải quyết 2 luật sau bằng GC + runtime check. Rust giải quyết bằng **compiler** — và cái giá phải trả là bạn phải khai báo tường minh loại con trỏ nào tuân theo luật nào. Đây chính là lý do Rust có nhiều "loại pointer" đến vậy — mỗi loại là một bộ luật khác nhau, được compiler enforce khác nhau.

---

## 2. Bản đồ toàn cảnh: 4 tầng pointer trong Rust

```
┌──────────────────────────────────────────────────────────────────┐
│ TẦNG 1 — Reference (&T, &mut T)                                  │
│ Compiler-checked, zero runtime cost, luôn valid, không thể null  │
├──────────────────────────────────────────────────────────────────┤
│ TẦNG 2 — Smart Pointer (Box, Rc, Arc, RefCell, Cell)             │
│ Runtime-managed ownership/mutability, vẫn safe, có chi phí nhỏ   │
├──────────────────────────────────────────────────────────────────┤
│ TẦNG 3 — Fat Pointer (&[T], &str, &dyn Trait)                    │
│ Con trỏ + metadata (length hoặc vtable), vẫn an toàn             │
├──────────────────────────────────────────────────────────────────┤
│ TẦNG 4 — Raw Pointer (*const T, *mut T)                          │
│ Không luật gì cả — bạn tự chịu trách nhiệm 100% (unsafe)         │
└──────────────────────────────────────────────────────────────────┘
```

Java chỉ có tương đương Tầng 2 (reference luôn là "smart pointer" managed bởi GC) và không hề có Tầng 1, 3 (một phần), 4. Đây là điểm khác biệt cốt lõi bạn cần khắc cốt: **Rust buộc bạn chọn tầng phù hợp cho từng tình huống**, còn Java chỉ có một tầng cho tất cả — tiện nhưng trả giá bằng GC pause và ít kiểm soát.

---

## 3. Tầng 1 — Reference: "con trỏ có hợp đồng"

`&T` và `&mut T` **là con trỏ** (một địa chỉ bộ nhớ) nhưng đi kèm hợp đồng compiler enforce:

```rust
let mut x = 10;
let r1 = &x;        // con trỏ tới x, chỉ đọc
let r2 = &mut x;    // LỖI compile nếu r1 vẫn còn sống — vi phạm aliasing rule
```

**Bản chất luật (aliasing XOR mutability):** tại một thời điểm, một vùng nhớ chỉ được:
- Có N con trỏ `&T` đọc cùng lúc, HOẶC
- Có đúng 1 con trỏ `&mut T` ghi.

Không bao giờ cả hai cùng lúc. Đây không phải luật tùy tiện — nó là điều kiện toán học để compiler chứng minh **không có data race, không có use-after-free, không có iterator invalidation** — tất cả tại compile time, chi phí runtime = 0.

**So với Java:** hai thread cùng giữ reference tới một object và cùng gọi setter — Java compile được, chạy được, và có thể race condition âm thầm (bạn phải tự dùng `synchronized`/`volatile`). Rust literally không compile được nếu bạn cố làm điều tương tự mà không dùng cơ chế đồng bộ hóa tường minh (`Mutex`, `RwLock`, `Atomic`). Đây là lý do người ta nói Rust "biến bug runtime thành lỗi compile time".

**Sự thật quan trọng cho newbie:** `&T` không phải optional — nó **luôn valid** trong suốt lifetime của nó, được compiler chứng minh bằng borrow checker (Bài 5). Không có null reference trong Rust (đó là việc của `Option<&T>`).

---

## 4. Tầng 2 — Smart Pointer: khi bạn cần luật khác vào runtime

Reference là compile-time-only vì lifetime của dữ liệu phải biết trước, tại compile time. Nhưng thực tế có 3 tình huống compiler không thể biết trước:

### 4.1 "Tôi không biết dữ liệu này sống bao lâu, chỉ biết nó cần sống trên heap"
→ `Box<T>`: con trỏ trỏ tới heap, sở hữu duy nhất (unique ownership), tự động `drop` khi ra khỏi scope.

```rust
let boxed: Box<i32> = Box::new(42);
// Bản chất: Box<T> là một *mut T + Drop impl để tự động free
// Java analog: mọi object Java = Box<T> tự động + GC thay vì Drop tường minh
```

### 4.2 "Tôi không biết ai sẽ là người cuối cùng dùng xong dữ liệu này"
→ `Rc<T>` (single-thread) / `Arc<T>` (multi-thread): reference counting — nhiều chủ sở hữu, dữ liệu chỉ bị free khi **count về 0**.

```rust
let a = Rc::new(String::from("shared"));
let b = Rc::clone(&a);  // không copy dữ liệu, chỉ tăng count
// Bản chất: Rc<T> = con trỏ tới (count, data) trên heap
// drop(a) → count-- ; count == 0 → free data
```

Đây chính là cách Java GC hoạt động phía dưới (một trong các thuật toán) — nhưng Java làm điều này cho MỌI object tự động và có background thread quét. Rust để bạn **chọn** dùng ref-counting khi cần, và bạn trả chi phí đó một cách tường minh, không phải trả cho toàn bộ chương trình.

### 4.3 "Tôi có `&T` nhưng vẫn cần sửa được bên trong"
→ `Cell<T>` / `RefCell<T>`: interior mutability — dịch chuyển kiểm tra aliasing từ compile-time sang **runtime**.

```rust
let cell = RefCell::new(5);
*cell.borrow_mut() += 1;  // panic tại runtime nếu đang có borrow khác conflict
```

**Bản chất quan trọng nhất của mục này:** `RefCell` không "phá luật" aliasing XOR mutability — nó chỉ **dời việc kiểm tra luật đó từ compiler sang runtime**, và nếu bạn vi phạm, chương trình `panic!` thay vì không compile. Đây là điểm newbie hay hiểu lầm — RefCell không kém an toàn hơn, nó chỉ an toàn ở thời điểm khác.

### Bảng quyết định — chọn smart pointer nào

| Tình huống | Dùng | Lý do |
|---|---|---|
| Dữ liệu chỉ có 1 chủ, cần trên heap (VD: recursive type, trait object) | `Box<T>` | Rẻ nhất, ownership rõ ràng |
| Nhiều nơi cùng đọc, 1 thread | `Rc<T>` | Không cần atomic, rẻ hơn Arc |
| Nhiều nơi cùng đọc, nhiều thread | `Arc<T>` | Atomic refcount, thread-safe |
| Cần sửa qua `&T`, 1 thread | `RefCell<T>` | Runtime borrow check |
| Cần sửa qua `&T`, nhiều thread | `Mutex<T>` / `RwLock<T>` | Blocking, thread-safe |
| Nhiều nơi + cùng sửa, nhiều thread | `Arc<Mutex<T>>` | Tổ hợp phổ biến nhất production |

---

## 5. Tầng 3 — Fat Pointer: khi 1 địa chỉ không đủ thông tin

Đây là khái niệm Java **hoàn toàn không có tương đương trực tiếp**, và là nơi nhiều người tưởng mình hiểu pointer nhưng thực ra chưa.

Một con trỏ "mỏng" (thin pointer) như `&i32` chỉ là 1 word (8 byte trên 64-bit) — địa chỉ. Nhưng một số kiểu dữ liệu cần **thêm metadata** để dùng được, nên con trỏ tới chúng phải "béo" hơn:

```rust
let arr = [1, 2, 3, 4, 5];
let slice: &[i32] = &arr[1..4];
// slice KHÔNG chỉ là địa chỉ — nó là (địa chỉ, độ dài) = 2 word = 16 byte

let s: &str = "hello";
// &str cũng vậy: (con trỏ tới byte đầu, độ dài byte) = 16 byte

trait Shape { fn area(&self) -> f64; }
let shape: &dyn Shape = &circle;
// &dyn Trait là (con trỏ tới data, con trỏ tới vtable) = 16 byte
```

```
Thin pointer (&i32):           [ địa chỉ ]                     8 byte
Fat pointer (&[T] / &str):     [ địa chỉ | độ dài ]            16 byte
Fat pointer (&dyn Trait):      [ địa chỉ data | địa chỉ vtable ] 16 byte
```

**vtable là gì, bản chất:** một bảng con trỏ hàm — Rust tạo tại compile time cho mỗi cặp (kiểu cụ thể, trait), chứa địa chỉ thực thi của từng method. Khi bạn gọi `shape.area()` qua `&dyn Shape`, runtime nhảy qua vtable để tìm đúng hàm — đây chính là **dynamic dispatch**, và nó có 1 lần indirection extra so với `impl Trait` (static dispatch, monomorphized, zero-cost — xem Bài 6).

**Tại sao quan trọng cho tối ưu:** nếu bạn dùng `Vec<Box<dyn Trait>>` ở hot path, mỗi lần gọi method là 2 lần indirection (Box → data, vtable → function). Nếu performance quan trọng và số kiểu cụ thể biết trước, cân nhắc enum thay vì `dyn Trait` để tránh cả 2 chi phí này (static dispatch qua `match`).

---

## 6. Tầng 4 — Raw Pointer: khi bạn tháo hết luật

`*const T` / `*mut T` (chi tiết cú pháp xem Bài 19) — về bản chất chúng chính là con trỏ "trần" như C: chỉ là địa chỉ, compiler **không** đảm bảo:
- Không null
- Không dangling (trỏ vào vùng đã free)
- Không có 2 `*mut T` cùng ghi một lúc

Bạn cần raw pointer khi: viết cấu trúc dữ liệu cấp thấp (Vec tự chế, linked list, arena allocator), FFI với C, hoặc tối ưu cực hạn mà borrow checker quá bảo thủ để chứng minh an toàn (dù bạn biết rõ code của mình đúng).

Nguyên tắc newbie **phải nhớ**: raw pointer không phải "pointer nhanh hơn" — về mặt CPU nó y hệt reference (cũng chỉ là một địa chỉ, cùng 1 instruction để dereference). Sự khác biệt duy nhất là **compiler không kiểm tra hộ bạn nữa**. Dùng raw pointer không giúp code chạy nhanh hơn nếu bạn không đang giải quyết một giới hạn cụ thể của borrow checker.

---

## 7. Pointer Provenance — lớp bản chất sâu nhất, ít người biết

Đây là phần khiến bạn thực sự vượt qua "biết dùng" để "hiểu compiler nghĩ gì". Kể cả trong C, một con trỏ không chỉ là con số địa chỉ — nó còn mang theo **provenance**: thông tin "con trỏ này được sinh ra từ allocation nào".

```rust
let a = Box::new(5i32);
let b = Box::new(5i32);
// Giả sử tình cờ &*a và &*b có CÙNG giá trị địa chỉ (không thực tế nhưng minh họa)
// Compiler VẪN coi chúng là 2 con trỏ khác nhau, vì provenance khác nhau
// Bạn KHÔNG được phép dùng con trỏ của a để truy cập vùng nhớ của b,
// dù giá trị số học có trùng nhau
```

Rust dùng mô hình gọi là **Stacked Borrows / Tree Borrows** (đang được hình thức hóa, dùng bởi Miri để phát hiện undefined behavior) để mô tả: mỗi lần bạn tạo `&` hoặc `&mut` từ một con trỏ khác, một "tag" mới được sinh ra, và có luật về tag nào còn "sống", tag nào bị "vô hiệu hóa" khi có borrow khác chen vào.

**Tại sao bạn cần biết điều này ngay cả khi không viết `unsafe`:** nó giải thích tại sao một số pattern "trông có vẻ đúng" với raw pointer lại là **undefined behavior** dù không bao giờ crash khi bạn test:

```rust
unsafe {
    let mut x = 10;
    let r1: *mut i32 = &mut x;
    let r2: *mut i32 = &mut x;   // 2 con trỏ mut cùng vùng nhớ — provenance conflict
    *r1 = 1;
    *r2 = 2;   // UB thực sự, dù compile, dù chạy "đúng" trên máy bạn
}
```

Đây là lý do "code chạy được" trong `unsafe` Rust **không có nghĩa là đúng** — UB có thể im lặng cho tới khi optimizer thay đổi (compiler được phép giả định UB không xảy ra, và tối ưu hóa dựa trên giả định đó, kết quả là hành vi thay đổi giữa các bản build). Nếu bạn viết `unsafe`, công cụ bắt buộc phải chạy là **Miri** (`cargo +nightly miri test`) — nó mô phỏng đúng mô hình provenance này và bắt được UB mà test thường không bắt được.

---

## 8. Layout bộ nhớ: Stack vs Heap — nơi con trỏ trỏ tới

```
STACK (mỗi thread một stack, kích thước cố định, LIFO)     HEAP (shared, cấp phát động)
┌─────────────────────┐                                    ┌─────────────────────┐
│ main() frame         │                                    │                     │
│  x: i32       [ptr]──┼───────────────────────────────────▶│  Box<i32> data      │
│  b: Box<i32>         │                                    │                     │
│  r: &i32      [ptr]──┼──┐                                 │  Rc<T> { count, T } │
└─────────────────────┘  │                                  │                     │
                          └────────────────▶ x (trên stack)  └─────────────────────┘

Đặc điểm STACK:              Đặc điểm HEAP:
- Cấp phát/giải phóng: 1 lệnh dịch con trỏ  - Cấp phát: gọi allocator, chậm hơn
- Kích thước biết tại compile time          - Kích thước có thể biết tại runtime
- Cache-friendly, locality cao              - Có thể phân mảnh, cache-miss cao hơn
```

**Bản chất tối ưu bạn cần khắc cốt:** mọi `Box`, `Rc`, `Arc`, `Vec`, `String` đều **có phần header nằm trên stack (chính là con trỏ + metadata) nhưng dữ liệu thật nằm trên heap**. Chi phí không nằm ở "có pointer hay không" — chi phí nằm ở:
1. **Chi phí cấp phát** (heap allocation là syscall/allocator call, đắt hơn stack hàng chục-hàng trăm lần).
2. **Chi phí indirection khi truy cập** (CPU phải load địa chỉ, rồi load dữ liệu tại địa chỉ đó — 2 lần truy cập bộ nhớ thay vì 1, có thể gây cache miss).
3. **Chi phí đồng bộ** nếu là `Arc`/`Mutex` (atomic operations có chi phí CPU cycle thật, dù nhỏ).

Đây là lý do trong Rust production code, một nguyên tắc tối ưu quan trọng là: **giữ dữ liệu trên stack càng nhiều càng tốt, chỉ đưa lên heap khi thực sự cần** (kích thước không biết trước, cần sống lâu hơn scope hiện tại, hoặc cần chia sẻ). Java không cho bạn lựa chọn này — mọi object luôn heap, luôn có ít nhất 1 lần indirection, đó là một phần lý do Rust có thể nhanh hơn Java ở workload thiên về data structure nhỏ, truy cập nhiều.

---

## 9. So sánh trực diện: Java reference vs Rust pointer taxonomy

| Khía cạnh | Java reference | Rust `&T`/`&mut T` | Rust `Box`/`Rc`/`Arc` | Rust raw pointer |
|---|---|---|---|---|
| Có thể null | Có (`NullPointerException`) | Không (dùng `Option<&T>`) | Không (dùng `Option<Box<T>>`) | Có |
| Vị trí dữ liệu | Luôn heap | Bất kỳ (thường stack) | Luôn heap | Bất kỳ |
| Ai giải phóng | GC (không xác định thời điểm) | Compiler tự sinh code tại scope end | `Drop` tại refcount = 0 hoặc scope end | Bạn, thủ công |
| Kiểm tra alias | Không kiểm tra (bạn tự lo race condition) | Compile-time, miễn phí | Runtime (RefCell) hoặc atomic (Arc) | Không kiểm tra gì |
| Con trỏ tới local variable | Không thể (mọi thứ đã là heap ref) | Có (`&x` với `x` trên stack) | N/A | Có |
| Chi phí runtime | GC pause định kỳ, write barrier | Zero | Refcount inc/dec, atomic nếu Arc | Zero, nhưng zero an toàn |

Điểm mấu chốt: Java cho bạn **một loại pointer, luôn an toàn, cái giá là GC và luôn heap**. Rust cho bạn **bốn loại pointer, bạn chọn mức an toàn/hiệu năng phù hợp cho từng biến, cái giá là bạn phải hiểu rõ luật của từng loại**.

---

## 10. Case study: áp dụng vào PDMS

Giả sử bạn xử lý batch validate 5.000 record hợp đồng (bối cảnh bạn đang làm):

```rust
// KHÔNG tối ưu: mỗi record clone toàn bộ dữ liệu để đưa vào task riêng
struct HopDong { id: i64, so_tien: Decimal, dieu_khoan: String /* có thể vài KB */ }

async fn validate_all_bad(records: Vec<HopDong>) {
    for r in records {
        tokio::spawn(async move { validate(r).await }); // move toàn bộ struct, clone dieu_khoan mỗi lần
    }
}

// TỐI ƯU: chia sẻ phần dữ liệu chỉ-đọc qua Arc, tránh clone String lớn
async fn validate_all_good(records: Vec<HopDong>) {
    let shared: Vec<Arc<HopDong>> = records.into_iter().map(Arc::new).collect();
    for r in shared {
        let r = Arc::clone(&r);  // chỉ tăng refcount, không copy dieu_khoan
        tokio::spawn(async move { validate(&r).await });
    }
}
```

Đây chính là bài toán Tầng 2 áp dụng thực tế: bạn nhận ra dữ liệu chỉ cần đọc, được share giữa nhiều task đồng thời → `Arc<T>` là lựa chọn đúng, tránh chi phí clone String/Vec lớn lặp lại 5.000 lần.

---

## 11. Checklist tư duy — trước khi viết một pointer bất kỳ

1. **Dữ liệu này ai sở hữu, sống bao lâu?** → Nếu 1 chủ, biết trước lifetime → `&T`/`&mut T`. Nếu không biết trước, cần heap → `Box`.
2. **Có nhiều nơi cùng cần đọc không?** → Có → `Rc`/`Arc`. Không → giữ ownership đơn giản.
3. **Có cần sửa qua reference chia sẻ không?** → Có, 1 thread → `RefCell`. Nhiều thread → `Mutex`/`RwLock`.
4. **Có phải hot path, nhạy cảm hiệu năng không?** → Cân nhắc tránh `dyn Trait` (dynamic dispatch), tránh heap alloc không cần thiết, ưu tiên stack + generic (static dispatch).
5. **Có đang viết `unsafe`/raw pointer không?** → Bắt buộc chạy qua Miri, và tự hỏi: "provenance của con trỏ này từ đâu, có ai khác đang có quyền ghi vùng nhớ này không?"

---

## 🔗 Links
- [[Bai-1-Ownership-Mindset|Bài 1: Ownership]] — nền tảng của mọi luật pointer
- [[Bai-2-Borrowing-Multi-threading|Bài 2: Borrowing]] — luật aliasing XOR mutability
- [[Bai-5-Lifetimes|Bài 5: Lifetimes]] — cách compiler chứng minh reference luôn valid
- [[Bai-8-Smart-Pointers-Error-Design|Bài 8: Smart Pointers]] — API chi tiết Box/Rc/Arc/RefCell
- [[Bai-19-Unsafe-FFI|Bài 19: Unsafe & FFI]] — API chi tiết raw pointer, so sánh JNI
- [[Bai-17-Zero-Cost-Performance|Bài 17: Zero-Cost Performance]] — static vs dynamic dispatch sâu hơn
- [[MOC-Rust]]

---
*Bài tập:*
1. Viết một struct `Node` cho linked list dùng `Box<Node>` cho next pointer. Giải thích tại sao không thể dùng `&Node` (gợi ý: lifetime của ai?).
2. Cho một `Vec<Arc<Mutex<Counter>>>` chia sẻ giữa 10 task tokio, mỗi task tăng counter 1000 lần. Đo thời gian, so sánh với việc dùng `Arc<AtomicI64>` thay vì `Mutex`. Giải thích chênh lệch bằng khái niệm indirection + lock contention.
3. Chạy `cargo +nightly miri test` trên đoạn code Bài 19 dùng raw pointer, quan sát Miri báo lỗi gì nếu bạn cố tình tạo 2 `*mut T` cùng ghi một vùng nhớ.
4. Với `dyn Shape` trong ví dụ vtable ở mục 5, viết lại bằng `enum Shape { Circle(f64), Square(f64) }` + `match`. So sánh code size và benchmark gọi `area()` 10 triệu lần giữa 2 cách.
