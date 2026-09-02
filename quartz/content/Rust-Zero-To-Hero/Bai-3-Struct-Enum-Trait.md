---
type: course
domain: languages/rust
status: active
created: 2026-04-10
updated: 2026-08-27
tags: [depth-pass]
---

# Bài 3: Structs, Enums & Traits - "Class" kiểu mới trong Rust (Deep Dive)

Không có Class, không có Inheritance — vậy Rust đóng gói (encapsulate) và trừu tượng hóa (abstract) dữ liệu bằng cơ chế gì? Câu trả lời nằm ở bộ ba: `struct` (dữ liệu), `enum` (dữ liệu có nhiều hình dạng — tagged union), `trait` (hành vi chung, không kế thừa).

## 1. Struct: Memory layout thực tế

```rust
struct User { name: String, age: u8 }
```

Rust **không đảm bảo** thứ tự field trên bộ nhớ giống thứ tự khai báo — compiler có quyền sắp xếp lại để tối ưu alignment/padding (giảm khoảng trống lãng phí giữa các field). Muốn ép layout cố định (bắt buộc khi làm FFI với C), phải dùng `#[repr(C)]`.

So với Java: JVM cũng làm điều tương tự — HotSpot có thể sắp xếp lại field trong object header + field area để tối ưu cache line, bạn cũng không kiểm soát được thứ tự thật trên heap (chỉ thấy thứ tự khai báo trong source). Điểm khác biệt: Rust **cho bạn quyền override** bằng `#[repr(C)]`/`#[repr(packed)]` khi cần layout xác định (interop với C, network protocol, memory-mapped file) — Java không có cơ chế tương đương ở mức ngôn ngữ.

## 2. Enum: Tagged Union và Niche Optimization

```rust
enum OrderStatus {
    Pending,
    Shipped(String),
    Delivered { warehouse: String, time: u32 },
    Cancelled(String),
}
```

Về bộ nhớ, enum Rust là một **tagged union**: một số nguyên nhỏ (discriminant/tag) đánh dấu variant nào đang active, cộng với vùng nhớ đủ lớn để chứa payload của variant "nặng" nhất.

```text
[ tag: u8 ][ payload: max(size của mọi variant) ]
```

**Niche optimization** — một trong những tối ưu tinh vi nhất của Rust: `Option<&T>` có kích thước **bằng đúng** `&T` (8 bytes trên 64-bit), không tốn thêm byte nào cho tag! Vì `&T` không bao giờ là null (Rust reference luôn valid), compiler dùng chính giá trị bit `0x0` (vốn không hợp lệ cho một con trỏ thật) làm sentinel cho `None`. Kiểm chứng bằng chính công cụ trong Rust:

```rust
assert_eq!(std::mem::size_of::<Option<&i32>>(), std::mem::size_of::<&i32>());
```

Đây là ví dụ cụ thể nhất cho khái niệm "zero-cost abstraction": `Option` không hề tốn thêm chi phí bộ nhớ so với raw pointer, trong khi Java `Optional<T>` là một **object wrapper thật sự** trên heap (có header, có field bên trong) — tốn allocation và một tầng indirection.

## 3. Trait: static dispatch vs dynamic dispatch — điểm khác biệt lớn nhất với Java Interface

```rust
trait Summary {
    fn summarize(&self) -> String;
    fn author(&self) -> String { String::from("Unknown") } // default method
}
```

Trait trông giống Interface Java (kể cả default method, có từ Java 8) nhưng cách gọi hàm khác hẳn ở tầng compiler:

- **Generic + trait bound (`fn f<T: Summary>(x: T)`)**: compiler tạo ra **một bản copy code riêng cho mỗi type cụ thể** tại compile-time — gọi là **monomorphization**. Lời gọi hàm được inline trực tiếp, **không có indirection nào ở runtime** — CPU không cần tra vtable.
- **`dyn Trait` (`fn f(x: &dyn Summary)`)**: chỉ MỘT bản code được sinh ra, gọi hàm qua **vtable** (bảng con trỏ hàm) — giống hệt cách Java luôn gọi method của interface (virtual dispatch qua method table trong class metadata).

**Khác biệt cốt lõi:** Java **luôn luôn** trả chi phí vtable indirection cho interface/virtual method call (JIT có thể inline nếu profiling thấy chỉ có 1 loại target thực tế — gọi là monomorphic call site, nhưng đây là tối ưu speculative, có thể bị "deoptimize" nếu giả định sai). Rust **cho bạn lựa chọn tường minh**: dùng generic khi cần tốc độ tối đa (đổi lại binary lớn hơn do code bị nhân bản), dùng `dyn Trait` khi cần một collection chứa nhiều type khác nhau (`Vec<Box<dyn Summary>>`) — đánh đổi một phép tra vtable để lấy tính linh hoạt.

## 4. Option/Result thay thế null và Exception

```rust
fn find_user(id: u64) -> Option<User> { /* ... */ }
fn parse_config(s: &str) -> Result<Config, ParseError> { /* ... */ }
```

`Option<T>`/`Result<T, E>` là enum thường, được compiler **buộc bạn xử lý cả hai nhánh** tại nơi gọi (không unwrap tường minh thì không lấy được giá trị bên trong) — loại bỏ hoàn toàn NullPointerException. Khác với Java checked exception (`throws IOException`) — vốn có thể bị lách bằng cách bọc thành unchecked exception — Rust không có "cửa sau" nào để né việc xử lý `Result`.

## 5. Ví dụ thực tế: vòng đời hồ sơ trong PDMS

```rust
enum DocumentStatus {
    Draft,
    PendingApproval { approver: String },
    Approved { by: String, at: u64 },
    Rejected { reason: String },
}

trait Auditable {
    fn audit_log(&self) -> String;
    fn requires_notification(&self) -> bool { false } // default
}

impl Auditable for DocumentStatus {
    fn audit_log(&self) -> String {
        match self {
            DocumentStatus::Draft => "Hồ sơ nháp".into(),
            DocumentStatus::PendingApproval { approver } => format!("Chờ {} duyệt", approver),
            DocumentStatus::Approved { by, at } => format!("Đã duyệt bởi {} lúc {}", by, at),
            DocumentStatus::Rejected { reason } => format!("Bị từ chối: {}", reason),
        }
    }
    fn requires_notification(&self) -> bool {
        matches!(self, DocumentStatus::Approved { .. } | DocumentStatus::Rejected { .. })
    }
}

// Static dispatch — zero overhead, dùng khi biết trước type cụ thể
fn print_audit<T: Auditable>(item: &T) { println!("{}", item.audit_log()); }

// Dynamic dispatch — cần khi xử lý danh sách nhiều loại record khác nhau
fn print_all_audits(items: &[Box<dyn Auditable>]) {
    for item in items { println!("{}", item.audit_log()); }
}
```

## 6. So sánh với Java 21 (sealed interfaces + pattern matching)

Đáng chú ý: Java 21 (đúng phiên bản bạn đang dùng) đã thêm **sealed interfaces** + **pattern matching for switch** — gần như là câu trả lời trực tiếp của Java cho enum/match của Rust, sau nhiều năm chỉ có enum hằng số đơn giản. Điểm khác: Rust `match` bắt buộc exhaustive từ đầu (từ bản 1.0), còn Java cần khai báo `sealed` tường minh + trình biên dịch mới enforce exhaustiveness — nếu bạn quen Java 21 pattern matching, tư duy match Rust sẽ rất tự nhiên.

## 7. Pitfalls thường gặp

- **Lạm dụng `dyn Trait` theo phản xạ OOP**: dev quen Java hay mặc định dùng `Box<dyn Trait>` mọi nơi vì đó là cách duy nhất họ biết (Java luôn dynamic dispatch). Đây là performance smell nếu tại điểm gọi bạn đã biết rõ concrete type — generic sẽ nhanh hơn và cho phép inline.
- **Object safety**: không phải trait nào cũng làm `dyn Trait` được — trait có method generic, hoặc method trả về `Self`, vi phạm "object safety", compiler sẽ báo lỗi rõ ràng khi bạn cố `Box<dyn ThatTrait>`.
- **Wildcard `_ =>` che mất lỗi thiếu variant**: dùng `_ => {}` bừa bãi trong `match` sẽ khiến bạn **không còn được compiler cảnh báo** khi thêm variant mới sau này — mất đi lợi thế lớn nhất của exhaustive matching. Nên liệt kê tường minh từng variant khi có thể.
- **Struct update syntax `..` gây move ẩn**: `let u2 = User { age: 30, ..u1 };` sẽ move các field không phải `Copy` ra khỏi `u1` — nếu `u1` có field `String`, `u1` sau đó không dùng lại được nguyên vẹn.

## 8. Hiệu năng: monomorphization vs vtable

Generic sinh nhiều bản code (code bloat) nhưng cho phép inline hoàn toàn — tốt cho hot path gọi hàng triệu lần. `dyn Trait` giữ binary nhỏ gọn nhưng mỗi lời gọi tốn một lần tra bảng con trỏ hàm (một cache miss tiềm năng). Với PDMS, nếu bạn có một hàm validate chạy trong vòng lặp hot loop xử lý hàng triệu record, ưu tiên generic; nếu chỉ là danh sách handler đăng ký một lần khi khởi động service, `dyn Trait` hoàn toàn ổn và code gọn hơn.

## 9. Bài tập

1. (Gốc, mở rộng) Tạo `enum Shape { Circle(f64), Rectangle(f64, f64) }`, trait `Area` với `calculate_area(&self) -> f64`, viết cả hai phiên bản: một hàm generic `fn print_area<T: Area>(s: &T)` và một hàm nhận `&dyn Area` — so sánh.
2. Dùng `std::mem::size_of` kiểm chứng niche optimization: so sánh `size_of::<Option<&i32>>()` và `size_of::<&i32>()`, sau đó thử với `Option<i32>` (không có niche, sẽ lớn hơn `i32`) — giải thích tại sao khác nhau.
3. Viết một trait có method generic, thử biến nó thành `dyn Trait` để tận mắt thấy lỗi "not object safe" và đọc hiểu compiler message.
4. Xóa một nhánh `match` cố ý (bỏ variant `Rejected`), quan sát compiler báo lỗi thiếu — rồi thử thêm `_ => {}` để so sánh trải nghiệm mất cảnh báo.
