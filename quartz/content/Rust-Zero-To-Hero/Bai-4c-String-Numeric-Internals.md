---
type: course
domain: languages/rust
status: active
created: 2026-08-22
updated: 2026-08-22
tags: []
---

# Bài 4c: String & Numeric Internals — Vì sao `s[0]` không compile và `i32 + 1` có thể panic

Chào Chuyên gia Java, `String` trong Java là UTF-16, index bằng `charAt(i)` luôn O(1) và không bao giờ panic. Số nguyên Java overflow âm thầm (`Integer.MAX_VALUE + 1` = số âm, không lỗi, không cảnh báo). Rust ngược lại hoàn toàn ở cả hai điểm — và hiểu tại sao sẽ cứu bạn khỏi rất nhiều giờ debug sau này.

## 1. UTF-8 Internals — tại sao `s[0]` không compile

`String`/`&str` trong Rust là UTF-8 **byte sequence**, không phải mảng ký tự cố định độ rộng. Một ký tự Unicode có thể chiếm 1-4 byte, nên "ký tự thứ i" không map 1-1 với "byte thứ i":

```rust
let s = String::from("chào");
// s[0] // LỖI COMPILE: `String` không implement `Index<usize>` — cố tình cấm!

let bytes = s.as_bytes();      // &[u8] — byte thô
let chars: Vec<char> = s.chars().collect(); // ['c','h','à','o'] — 4 char, nhưng 'à' chiếm 2 byte

println!("byte len: {}", s.len());        // 5 (byte), không phải 4
println!("char count: {}", s.chars().count()); // 4
```

Rust **cố tình không cho** `s[i]` compile vì phép đó dễ ngộ nhận là O(1) trong khi thực chất phải duyệt byte để tìm char boundary, hoặc tệ hơn — cắt giữa 1 ký tự multi-byte gây UB/panic. Muốn lấy substring theo byte range, dùng slice — nhưng **phải cắt đúng char boundary**:

```rust
let s = "chào bạn";
let slice = &s[0..4]; // OK: "chào" kết thúc đúng byte 4? cẩn thận, "chào" có 'à' 2 byte
// nếu cắt giữa byte của 'à' -> panic runtime: "byte index is not a char boundary"
```

**Quy tắc an toàn:** dùng `.chars()`, `.char_indices()`, hoặc crate `unicode-segmentation` (cho grapheme cluster — 1 "ký tự nhìn thấy" có thể là nhiều `char` ghép, ví dụ emoji ghép) thay vì tự tính byte index.

## 2. `Cow<str>` — Clone-on-Write, tránh alloc thừa

`Cow<'a, str>` (Clone on Write) là enum `Borrowed(&'a str)` hoặc `Owned(String)` — cho phép một hàm trả về **hoặc** borrow (không alloc) **hoặc** owned string (khi thực sự cần sửa), tùy runtime:

```rust
use std::borrow::Cow;

fn normalize(input: &str) -> Cow<str> {
    if input.contains(' ') {
        Cow::Owned(input.replace(' ', "_")) // cần alloc mới vì phải sửa
    } else {
        Cow::Borrowed(input) // không cần alloc, trả thẳng borrow
    }
}
```

Dùng khi viết hàm xử lý string mà **đa số trường hợp không cần sửa gì** — tránh alloc `String` mới một cách lãng phí ở "happy path".

## 3. `OsString` / `CString` — khi chạm biên giới OS/FFI (liên hệ Bài 19)

`String` của Rust luôn valid UTF-8 — nhưng đường dẫn file trên Linux, hay tham số dòng lệnh, không đảm bảo là UTF-8 hợp lệ. Đó là lý do có `OsString`/`OsStr` (path, env var, args) và `CString`/`CStr` (chuỗi C, kết thúc bằng byte `\0`, dùng khi gọi FFI). Bài 19 (Unsafe/FFI) sẽ dùng `CString` khi truyền string qua `extern "C"` — ở đây chỉ cần nhớ: **không phải mọi "chuỗi" trong hệ thống đều là `String` Rust chuẩn**, có 3-4 kiểu string khác nhau cho 3-4 ngữ cảnh khác nhau.

## 4. Integer Overflow — khác biệt sống còn với Java

Java: `Integer.MAX_VALUE + 1` luôn = `Integer.MIN_VALUE`, im lặng, mọi lúc. Rust: hành vi **khác nhau giữa debug và release build** — đây là điểm gây bất ngờ lớn nhất cho người mới:

```rust
let x: u8 = 255;
let y = x + 1;
// debug build: PANIC "attempt to add with overflow"
// release build (--release): wrap về 0, KHÔNG panic, KHÔNG cảnh báo
```

Vì hành vi implicit này nguy hiểm (đúng ở debug, sai âm thầm ở release), Rust cung cấp 4 họ method tường minh — **nên dùng chúng thay vì `+` trần trong code liên quan tới tiền, index, hay input từ bên ngoài:**

```rust
let x: u8 = 250;

x.wrapping_add(10);    // Some kiểu Java: wrap vòng, luôn trả giá trị, = 4
x.checked_add(10);     // None nếu overflow, Some(x) nếu không — dùng với `?` hoặc match
x.saturating_add(10);  // ghim ở biên: = 255 (u8::MAX), không wrap, không panic
x.overflowing_add(10); // (4, true) — trả cả giá trị wrap VÀ cờ báo có overflow không
```

**Quy tắc thực dụng:** dùng `checked_*` khi bạn cần biết và xử lý lỗi (ví dụ cộng tiền), `saturating_*` khi muốn "ghim ở giới hạn hợp lý" (ví dụ tuổi, phần trăm), `wrapping_*` chỉ khi bạn CHỦ ĐỘNG muốn hành vi vòng (hash function, checksum).

## 5. Cast `as` — con dao hai lưỡi

```rust
let big: i64 = 300;
let small = big as u8; // = 44 (300 % 256), KHÔNG panic, KHÔNG cảnh báo — truncation âm thầm!

let negative: i32 = -1;
let unsigned = negative as u32; // = 4294967295 — bit pattern giữ nguyên, ý nghĩa đổi hoàn toàn

let f = 3.99_f64;
let i = f as i32; // = 3, truncate về 0 (không round)
```

`as` **không bao giờ panic** — nó luôn "cố cast bằng được" theo quy tắc bit-level, kể cả khi kết quả vô nghĩa. Muốn cast an toàn có kiểm tra, dùng `TryFrom`/`TryInto` (đã học ở Bài 3c):

```rust
use std::convert::TryFrom;
let big: i64 = 300;
let small: Result<u8, _> = u8::try_from(big); // Err — báo lỗi thay vì âm thầm sai
```

## 6. Cheat Sheet

| Vấn đề | Java | Rust |
|---|---|---|
| Index string theo "ký tự" | `charAt(i)`, luôn O(1) | Không cho phép trực tiếp; dùng `.chars()` |
| Overflow số nguyên | luôn wrap âm thầm | panic (debug) / wrap (release) — dùng `checked_*` để an toàn |
| Cast kiểu số | tự động hoặc ép kiểu, có thể mất dữ liệu âm thầm | `as` (âm thầm) hoặc `TryFrom` (an toàn, có Result) |
| Tránh alloc thừa khi return string | khó, thường alloc bừa | `Cow<str>` |

---
**Bài tập nhỏ:**
1. Viết hàm `fn safe_add(a: u32, b: u32) -> Option<u32>` dùng `checked_add`, rồi viết bản `fn clamp_add(a: u32, b: u32) -> u32` dùng `saturating_add`.
2. Thử cắt slice một chuỗi tiếng Việt có dấu ở vị trí byte lẻ (giữa 1 ký tự) và quan sát panic "not a char boundary" để hiểu rõ UTF-8 boundary.
3. Viết hàm `normalize_currency` trả về `Cow<str>` — chỉ alloc `Owned` khi input chứa dấu phẩy ngăn cách hàng nghìn cần loại bỏ.
