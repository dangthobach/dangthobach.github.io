---
type: course
domain: languages/rust
status: active
created: 2026-08-22
updated: 2026-08-22
tags: []
---

# Bài 15b: Testing & Documentation chuyên sâu — Vượt qua `#[test]` cơ bản

Chào Chuyên gia Java, Bài 15 đã gộp chung Config/Tracing/Testing khá nhanh. Nếu bạn quen JUnit + Mockito + JavaDoc, phần này lấp đầy các mảnh tương đương ở Rust mà một dự án production-grade (như PDMS) cần: doctest, property-based testing, snapshot testing, và rustdoc.

## 1. Doctest — code trong doc comment TỰ ĐỘNG là test

Đây là thứ Java hoàn toàn không có (JavaDoc chỉ là văn bản, không chạy được). Trong Rust, code block trong `///` **được compile và chạy thật** mỗi khi `cargo test`:

```rust
/// Cộng hai số nguyên.
///
/// # Examples
///
/// ```
/// let result = my_crate::add(2, 3);
/// assert_eq!(result, 5);
/// ```
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
```

Nếu bạn sửa `add` mà quên update doc example, `cargo test` sẽ **fail** — documentation không bao giờ "nói dối" so với code thật. Đây là lý do docs.rs của các crate chất lượng cao luôn có example chạy được.

## 2. Property-based Testing — `proptest`

Unit test (Bài 15) kiểm tra input cụ thể bạn tự nghĩ ra. Property-based testing để **framework tự sinh hàng nghìn input ngẫu nhiên** và kiểm tra một "tính chất" (property) luôn đúng — hữu ích để tìm edge case bạn không nghĩ tới:

```rust
// Cargo.toml: proptest = "1"
use proptest::prelude::*;

proptest! {
    #[test]
    fn reverse_twice_is_identity(v: Vec<i32>) {
        let mut v2 = v.clone();
        v2.reverse();
        v2.reverse();
        prop_assert_eq!(v, v2); // đúng với MỌI Vec<i32>, không chỉ vài ví dụ tay
    }
}
```

Khi test fail, `proptest` tự động "shrink" input về trường hợp nhỏ nhất còn gây lỗi — cực kỳ hữu ích để debug thay vì nhìn một `Vec` ngẫu nhiên 500 phần tử.

## 3. Snapshot Testing — `insta`

Dùng khi output phức tạp (JSON response, struct lớn, HTML render) mà viết `assert_eq!` tay quá dài dòng — bạn "chụp ảnh" output lần đầu, các lần sau tự so sánh:

```rust
// Cargo.toml: insta = "1"
#[test]
fn test_user_serialization() {
    let user = User { id: 1, name: "Alice".into() };
    insta::assert_json_snapshot!(user);
    // Lần đầu: insta tạo file .snap chứa JSON output để bạn review & approve
    // Lần sau: tự so sánh output mới với file .snap đã approve, fail nếu khác
}
```

Rất hợp với API response testing trong PDMS — thay vì assert từng field, snapshot cả response.

## 4. Tổ chức Test — Unit vs Integration

```
src/
  lib.rs
  parser.rs
tests/              <- Integration tests, biên dịch thành crate riêng
  api_tests.rs      <- chỉ test qua public API, giống black-box test
```

```rust
// Trong src/parser.rs — unit test, được quyền truy cập private item
#[cfg(test)]
mod tests {
    use super::*; // truy cập được cả hàm private trong cùng module

    #[test]
    fn parses_valid_input() {
        assert_eq!(parse("42"), Some(42));
    }
}
```

`#[cfg(test)]` nghĩa là module này **chỉ compile khi chạy `cargo test`** — không lẫn vào binary production, khác hẳn cách JUnit tách project `src/test/java` hoàn toàn riêng thư mục maven/gradle.

## 5. Mocking — `mockall`

Java có Mockito tạo mock qua reflection/bytecode. Rust không có reflection, nên `mockall` dùng **procedural macro** để generate mock struct tại compile-time từ một trait:

```rust
// Cargo.toml: mockall = "0.13"
use mockall::automock;

#[automock]
trait UserRepository {
    fn find_by_id(&self, id: i64) -> Option<String>;
}

#[test]
fn test_with_mock() {
    let mut mock = MockUserRepository::new();
    mock.expect_find_by_id()
        .with(mockall::predicate::eq(1))
        .returning(|_| Some("Alice".to_string()));

    assert_eq!(mock.find_by_id(1), Some("Alice".to_string()));
}
```

Điểm khác biệt triết lý quan trọng: vì `mockall` cần một `trait` để mock, code Rust production-grade (kể cả PDMS) thường **thiết kế theo trait từ đầu** (dependency injection qua `dyn Trait` hoặc generic) — không phải "viết class cụ thể rồi mock nó" như Mockito làm được với Java.

## 6. Rustdoc Conventions

```rust
//! # My Crate
//! Đây là doc cho CẢ module/crate (chú ý `//!`, không phải `///`)

/// Doc cho item ngay bên dưới (function, struct...)
///
/// # Panics
/// Hàm này panic nếu `divisor` bằng 0.
///
/// # Errors
/// Trả về `Err` nếu input âm.
///
/// [`add`]: crate::add
pub fn divide(a: i32, divisor: i32) -> Result<i32, String> {
    if divisor == 0 { panic!("chia cho 0"); }
    // ...
    Ok(a / divisor)
}

#[doc(hidden)] // ẩn khỏi rustdoc output — dùng cho internal API không muốn public docs.rs
pub fn internal_helper() {}
```

`//!` (inner doc) mô tả module/crate chứa nó; `///` (outer doc) mô tả item ngay sau nó. `[text]: path` là intra-doc link — rustdoc tự resolve và tạo hyperlink, tự fail build nếu link chết (`#![deny(rustdoc::broken_intra_doc_links)]`).

## 7. Cheat Sheet

| Nhu cầu | Java | Rust |
|---|---|---|
| Unit test | JUnit `@Test` | `#[test]` |
| Doc có example chạy được | không có (JavaDoc tĩnh) | doctest (tự động) |
| Sinh input ngẫu nhiên test property | jqwik | `proptest` |
| So sánh output phức tạp | tự viết, hoặc AssertJ | `insta` snapshot |
| Mock interface | Mockito (reflection) | `mockall` (macro, cần trait) |
| Doc cho cả module | package-info.java | `//!` |
| Doc cho 1 item | JavaDoc `/** */` | `///` |

---
**Bài tập nhỏ:**
1. Viết một hàm `fn is_palindrome(s: &str) -> bool` kèm 1 doctest chứng minh `is_palindrome("racecar") == true`.
2. Viết một `proptest` kiểm tra tính chất: `sort` một `Vec<i32>` rồi `sort` lại lần nữa phải cho kết quả giống hệt lần đầu (idempotent).
3. Định nghĩa trait `PaymentGateway` với method `charge(&self, amount: u64) -> Result<(), String>`, dùng `#[automock]` để tạo mock và viết test cho một hàm nghiệp vụ gọi `PaymentGateway`.
