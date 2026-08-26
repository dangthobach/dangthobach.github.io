---
type: course
domain: languages/rust
status: active
created: 2026-04-10
updated: 2026-08-27
tags: [depth-pass]
---

# Bài 1: Ownership - Chìa khóa Tối ưu Bộ nhớ (Deep Dive)

Chào Chuyên gia Java, hãy quên Garbage Collector (GC) trong chốc lát. Trong Java, bạn tạo Object và mặc kệ JVM lo phần dọn dẹp. Trong Rust, mọi vùng nhớ phải có một "chủ sở hữu" duy nhất — và điều này được **enforce tại compile-time**, không tốn một cycle CPU nào ở runtime.

## 1. Cơ chế bên dưới: Layout bộ nhớ thực tế

`String` trong Rust không phải một "hộp đen" — nó là một struct cụ thể nằm trên stack:

```text
struct String {
    ptr: *mut u8,   // con trỏ tới buffer trên heap
    len: usize,     // độ dài hiện tại (bytes)
    cap: usize,     // dung lượng đã cấp phát
}
// Trên máy 64-bit: 3 word = 24 bytes, nằm trên STACK
```

```text
STACK                          HEAP
+----------------+
| s1: String      |
|  ptr  ─────────────────────► [h][e][l][l][o]
|  len  = 5        |
|  cap  = 5        |
+----------------+
```

So với Java: `String s1 = new String("hello")` — biến `s1` trên stack (hoặc trong frame local) chỉ là một **reference** (con trỏ) tới object nằm trên heap, object đó có header (mark word, class pointer) + mảng `char[]`/`byte[]` + cached hash. JVM theo dõi ai còn giữ reference tới object này thông qua **GC roots**, rồi định kỳ chạy mark-sweep (hoặc G1/ZGC tùy collector) để dọn — đây là chi phí runtime thực sự (stop-the-world hoặc concurrent marking).

## 2. Bảng so sánh cơ chế quản lý bộ nhớ

| | Java (GC) | Go (GC) | Rust (Ownership) |
|---|---|---|---|
| Khi nào giải phóng | GC quét định kỳ, không xác định thời điểm | GC concurrent, có STW ngắn | Ngay khi owner ra khỏi scope — xác định 100% tại compile-time |
| Chi phí runtime | Có (pause, CPU cho GC thread) | Có (thấp hơn Java) | **Zero** — logic ownership bị xóa hoàn toàn sau khi compile |
| Cơ chế | Tracing (mark-sweep/G1/ZGC) | Tracing (tricolor) | Compile-time static analysis (borrow checker) |
| Tên gọi kỹ thuật | Garbage Collection | Garbage Collection | RAII (Resource Acquisition Is Initialization — vay mượn từ C++) |

**Insight quan trọng:** Rust không "nhanh hơn Java vì không có GC" một cách mơ hồ — nó nhanh hơn vì toàn bộ bài toán "ai giữ reference, khi nào free" được giải quyết **tĩnh** bởi trình biên dịch, sinh ra code tương đương với việc bạn tự viết `free()` đúng chỗ bằng tay trong C, nhưng được compiler chứng minh là an toàn.

## 3. Move Semantics ở mức bit

```rust
let s1 = String::from("hello");
let s2 = s1;
// println!("{}", s1); // error[E0382]: borrow of moved value: `s1`
```

Điều gì thực sự xảy ra khi `let s2 = s1`:

1. Compiler thực hiện **memcpy 24 bytes** (ptr, len, cap) từ vị trí stack của `s1` sang `s2`. Đây là copy nông (shallow) — buffer trên heap **không** bị đụng tới, không tốn allocation mới.
2. Compiler đánh dấu `s1` là "moved-out" trong bảng ký hiệu tĩnh (static analysis), **không có bất kỳ thao tác runtime nào** (không set null, không zero-out như một số ngôn ngữ khác làm với move constructor).
3. Từ điểm này, mọi truy cập `s1` là lỗi compile-time — không phải lỗi runtime như NullPointerException.

→ Đây chính là lý do Rust "move" là **O(1) tuyệt đối**, không phụ thuộc kích thước dữ liệu trong heap — khác hẳn với việc `clone()` phải copy toàn bộ buffer.

## 4. Copy trait — khi nào ownership KHÔNG bị move

Không phải type nào cũng bị move. `i32`, `bool`, `char`, tuple/array của các type Copy sẽ tự động implement `Copy`:

```rust
let x: i32 = 5;
let y = x; // COPY, không phải move
println!("{}", x); // OK — x vẫn dùng được
```

**Quy tắc:** một type được phép là `Copy` nếu việc nhân bản bit-for-bit của nó **an toàn tuyệt đối** — tức là nó không sở hữu tài nguyên bên ngoài (heap buffer, file handle, network socket...). `String`/`Vec`/`Box` không thể là `Copy` vì nếu memcpy đơn giản, hai biến sẽ cùng trỏ vào một buffer heap → khi cả hai ra khỏi scope, buffer đó bị `free()` **hai lần** → **double-free**, một trong những lỗi bảo mật nghiêm trọng nhất trong C/C++ (CWE-415). Rust triệt tiêu hoàn toàn class lỗi này tại compile-time.

## 5. Drop trait và RAII

```rust
struct Connection { id: u32 }

impl Drop for Connection {
    fn drop(&mut self) {
        println!("Đóng connection #{}", self.id);
    }
}

fn main() {
    let a = Connection { id: 1 };
    let b = Connection { id: 2 };
} // b.drop() chạy trước, rồi a.drop() — thứ tự NGƯỢC với khai báo
```

Đây là RAII thuần túy: tài nguyên được gắn với lifetime của một binding, destructor (`drop`) chạy tự động, **đảm bảo 100%** kể cả khi có early return hay panic (unwind). So với Java: bạn phải tự nhớ gọi `.close()` hoặc dùng `try-with-resources` — một cơ chế được thêm vào ngôn ngữ để giả lập một phần RAII, chứ không phải default behavior như Rust.

Muốn giải phóng sớm, chủ động: `std::mem::drop(a);` — thực chất chỉ là một hàm nhận ownership `by value` rồi không làm gì, khiến giá trị bị drop ngay khi hàm kết thúc.

## 6. Borrowing và Non-Lexical Lifetimes (NLL)

```rust
let mut s = String::from("hello");
let r1 = &s;
let r2 = &s;
println!("{} {}", r1, r2);
// r1, r2 đã "hết hạn" tại đây (last use), dù scope { } chưa đóng

let r3 = &mut s; // HỢP LỆ — nhờ NLL, không cần đợi scope kết thúc
r3.push_str(" world");
```

Borrow checker hiện đại phân tích theo **luồng sử dụng thực tế (last use)**, không phải theo scope từ vựng (lexical scope) như phiên bản Rust cũ (2015 edition). Đây là lý do code Rust hiện tại "thoáng" hơn nhiều so với ấn tượng "borrow checker khó tính" mà nhiều Java dev nghe đồn.

**Quy tắc mượn cốt lõi:** nhiều `&T` (đọc) HOẶC một `&mut T` (sửa) tại một thời điểm — không bao giờ cả hai. Đây là cách Rust loại bỏ **data race** tại compile-time, một lớp bug mà Java chỉ phát hiện được lúc runtime (hoặc không phát hiện được, dẫn tới heisenbug production).

## 7. Pitfalls thường gặp (từ góc nhìn Java dev)

- **Use-after-move**: gọi lại biến sau khi đã move — compiler báo `error[E0382]`, chỉ thẳng dòng move.
- **Move ra khỏi shared reference**: `fn f(x: &Vec<String>) { let y = x[0]; }` → lỗi vì bạn không sở hữu `*x`, không thể move field ra khỏi nó qua `&`. Fix: dùng `.clone()` có chủ đích hoặc đổi sang `&x[0]`.
- **Partial move**: move một field ra khỏi struct khiến cả struct không còn dùng được nguyên vẹn (trừ khi destructure).
- **Anti-pattern "clone để né lỗi"**: nhiều dev mới thấy borrow checker báo lỗi thì phản xạ thêm `.clone()` khắp nơi để "cho qua". Đây là code smell — mỗi `.clone()` trên `String`/`Vec` là một heap allocation + copy thật sự. Nên tự hỏi: "mình có thực sự cần một bản sao độc lập, hay chỉ cần đọc/mượn tạm?"

## 8. Ví dụ thực tế: pipeline xử lý batch hồ sơ (PDMS context)

```rust
// Cách viết "clone-heavy" — smell thường gặp khi mới quen Rust
fn process_naive(records: Vec<DocumentRecord>) -> Vec<DocumentRecord> {
    let validated = validate(records.clone());   // clone #1
    let transformed = transform(validated.clone()); // clone #2
    persist(transformed)
}

// Cách viết move-based — không allocation thừa
fn process_optimized(records: Vec<DocumentRecord>) -> Vec<DocumentRecord> {
    let validated = validate(records);      // move, O(1)
    let transformed = transform(validated); // move, O(1)
    persist(transformed)
}
```

Với batch 100,000 hồ sơ, mỗi hồ sơ có vài field `String` cỡ vài trăm bytes — bản `naive` tạo ra hai lần allocation + copy toàn bộ tập dữ liệu trên heap ở mỗi bước pipeline, trong khi bản `optimized` chỉ copy 3 con số (ptr/len/cap) mỗi lần chuyền tay, bất kể dữ liệu bên trong lớn cỡ nào.

## 9. Tự đo hiệu năng (khuyến nghị dùng criterion.rs)

```rust
fn bench_clone(c: &mut Criterion) {
    c.bench_function("clone_pipeline", |b| b.iter(|| process_naive(sample_records())));
}
fn bench_move(c: &mut Criterion) {
    c.bench_function("move_pipeline", |b| b.iter(|| process_optimized(sample_records())));
}
```

Chạy thử với `cargo bench` trên chính dataset PDMS-like của bạn — kỳ vọng: thời gian chạy bản `clone` sẽ **tỉ lệ thuận** với kích thước dữ liệu mỗi record, còn bản `move` gần như hằng số bất kể payload lớn nhỏ. Số liệu cụ thể phụ thuộc máy/dataset nên tự đo sẽ chính xác hơn số đưa ra ở đây.

## 10. Bài tập

1. (Gốc) Viết hàm nhận vào một `String`, trả về độ dài của nó **mà không làm mất quyền sở hữu** của biến truyền vào.
2. Viết một struct có 2 field `String`, thực hiện partial move một field, rồi giải thích chính xác compiler error nhận được.
3. Tạo 3 struct implement `Drop`, khai báo lồng nhau trong một scope, dự đoán thứ tự `drop()` chạy trước khi biên dịch — rồi kiểm chứng lại.
