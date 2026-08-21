---
type: course
domain: languages/rust
status: active
created: 2026-08-22
updated: 2026-08-22
tags: []
---

# Bài 3c: Standard Trait Ecosystem & Conversion Traits — Cái mà Java giấu trong `Object`

Chào Chuyên gia Java, bạn dùng `equals()`, `hashCode()`, `compareTo()`, `toString()` mỗi ngày mà không nghĩ nhiều — vì chúng nằm sẵn trong `Object` hoặc bạn override bằng IDE generate code. Rust không có class cha ẩn nào cả: **mọi hành vi "chuẩn" đều là một trait riêng biệt**, và bạn phải khai báo rõ struct của mình implement cái nào. Đây là lỗ hổng lớn nhất nếu bỏ qua — vì `?` operator ở Bài 4, hay code Axum/SQLx sau này, đều ngầm dựa vào các trait này.

## 1. `#[derive(...)]` — 6 trait nền tảng cần thuộc lòng

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
struct UserId(u64);
```

| Trait | Tương đương Java | Ý nghĩa | Tự động derive được khi nào |
|---|---|---|---|
| `Debug` | `toString()` (dạng debug) | in ra `{:?}` để debug | Luôn được nếu mọi field đều `Debug` |
| `Clone` | copy constructor thủ công | tạo bản sao độc lập (deep, tường minh) | Nếu mọi field đều `Clone` |
| `Copy` | (Java primitive tự copy) | copy bit-for-bit thay vì move | Chỉ khi type nhỏ, không có heap alloc (không `String`, `Vec`...) |
| `PartialEq`/`Eq` | `equals()` | so sánh `==` | `PartialEq` nếu field đều `PartialEq`; `Eq` thêm nếu không có `f32/f64` (vì `NaN != NaN`) |
| `PartialOrd`/`Ord` | `compareTo()` | so sánh `<`, `>`, sort | Tương tự, `Ord` cần field không chứa float |
| `Hash` | `hashCode()` | dùng làm key `HashMap`/`HashSet` | Nếu mọi field đều `Hash` — **bắt buộc nếu bạn muốn dùng struct làm key** |
| `Default` | constructor không tham số | giá trị mặc định | Nếu mọi field đều `Default` |

**Điểm khác biệt cốt lõi với Java:** `equals()`/`hashCode()` trong Java bạn có thể override sai (quên đồng bộ hashCode khi override equals → bug âm thầm trong HashMap). Rust buộc bạn derive/impl cả `PartialEq` VÀ `Hash` một cách tường minh, và compiler không cho bạn dùng struct làm `HashMap` key nếu thiếu `Hash` — lỗi này bắt ở compile-time, không phải runtime.

## 2. `Display` vs `Debug` — hai cách "in ra chuỗi", hai mục đích khác nhau

`Debug` (`{:?}`) là để dev đọc khi debug — có thể derive tự động. `Display` (`{}`) là để **người dùng cuối** đọc — không bao giờ derive được, bạn phải tự viết:

```rust
use std::fmt;

struct Money(u64); // cents

impl fmt::Display for Money {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}.{:02} VND", self.0 / 100, self.0 % 100)
    }
}
// So sánh Java: đây chính là việc bạn override toString()
```

## 3. `From` / `Into` — cơ chế thật sự đứng sau toán tử `?`

Ở Bài 4, bạn đã dùng `?` để propagate lỗi. Nhưng **tại sao** `fetch_from_db()?` trong một hàm trả `Result<T, MyError>` lại hoạt động dù `fetch_from_db` trả về `Result<T, DbError>` khác kiểu lỗi? Câu trả lời: `?` tự động gọi `MyError::from(db_error)` — và đây chính là `From` trait:

```rust
#[derive(Debug)]
enum AppError {
    Database(String),
    Validation(String),
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Database(e.to_string())
    }
}

fn get_user(id: i64) -> Result<String, AppError> {
    let row = fetch_from_db(id)?; // sqlx::Error tự convert sang AppError nhờ From
    Ok(row)
}
```

Implement `From<A> for B` thì bạn **được tặng miễn phí** `Into<B> for A` (do blanket impl trong std) — nên bạn chỉ cần viết `From`, hiếm khi cần viết `Into` tay.

## 4. `TryFrom` / `TryInto` — khi conversion có thể thất bại

`From` giả định convert luôn thành công. Khi không (ví dụ `i64` → `u8` có thể tràn số), dùng `TryFrom`:

```rust
use std::convert::TryFrom;

struct Percentage(u8);

impl TryFrom<i32> for Percentage {
    type Error = String;
    fn try_from(value: i32) -> Result<Self, Self::Error> {
        if (0..=100).contains(&value) {
            Ok(Percentage(value as u8))
        } else {
            Err(format!("{} không nằm trong khoảng 0-100", value))
        }
    }
}

let p = Percentage::try_from(150); // Err(...)
```

## 5. `AsRef` / `AsMut` — tại sao API Rust hay nhận `impl AsRef<str>`

Bạn sẽ thấy signature như `fn read_file(path: impl AsRef<Path>)` khắp chuẩn thư viện. `AsRef<T>` nghĩa là "tôi có thể mượn ra một `&T` từ chính mình" — cho phép hàm nhận cả `String`, `&str`, `&String` mà không cần overload:

```rust
fn print_len(s: impl AsRef<str>) {
    println!("{}", s.as_ref().len());
}
print_len("hello");           // &str
print_len(String::from("hi")); // String
```

So với Java: gần giống việc một method nhận `CharSequence` thay vì buộc `String` cụ thể — nhưng ở Rust cơ chế này zero-cost, resolve tại compile-time (static dispatch), không qua interface runtime.

## 6. `Borrow` / `BorrowMut` — anh em họ dễ nhầm với `AsRef`

`Borrow` gần giống `AsRef` nhưng có thêm ràng buộc: `Hash`/`Eq`/`Ord` của `T` và của `Borrowed` phải cho ra **kết quả giống nhau**. Đây là lý do `HashMap<String, V>` cho phép bạn `.get("key")` bằng `&str` thay vì phải tạo `String` mới — vì `String: Borrow<str>`.

```rust
use std::collections::HashMap;
let mut map: HashMap<String, i32> = HashMap::new();
map.insert(String::from("a"), 1);
map.get("a"); // &str, không cần String::from("a") — nhờ Borrow<str>
```

## 7. Cheat Sheet

| Rust | Java tương đương | Khi dùng |
|---|---|---|
| `#[derive(Debug)]` | `toString()` debug | luôn nên có trên mọi struct/enum |
| `Display` | `toString()` | khi cần in cho end-user |
| `From<A> for B` | constructor nhận A, hoặc converter static | convert không lỗi, dùng với `?` |
| `TryFrom<A> for B` | factory method ném exception | convert có thể lỗi |
| `AsRef<T>` | nhận interface `CharSequence`-style | hàm nhận nhiều kiểu string/path |
| `Borrow<T>` | — (không có tương đương trực tiếp) | lookup trong map bằng kiểu mượn |

---
**Bài tập nhỏ:**
1. Định nghĩa struct `Temperature(f64)` (đơn vị Celsius), derive `Debug`, và tự viết `Display` in ra dạng `"25.0°C"`.
2. Viết `impl From<io::Error> for AppError` (tự định nghĩa `AppError`) rồi dùng `?` trong một hàm đọc file để kiểm chứng conversion tự động hoạt động.
3. Viết `TryFrom<u32> for Age` sao cho `Age` chỉ nhận giá trị 0-150, trả lỗi nếu vượt.
