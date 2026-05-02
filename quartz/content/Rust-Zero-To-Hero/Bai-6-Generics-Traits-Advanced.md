# Bài 6: Generics, Trait Bounds & Trait Objects — Polymorphism Kiểu Rust

Chào Chuyên gia Java. Bài này giải quyết câu hỏi: "Nếu Rust không có inheritance, làm sao tôi viết code tổng quát và polymorphic?" Câu trả lời là **Generics + Traits** — và thực ra mạnh hơn Java Generics nhiều.

---

## 1. Generics Cơ Bản

### Java
```java
public <T extends Comparable<T>> T max(T a, T b) {
    return a.compareTo(b) >= 0 ? a : b;
}
```

### Rust
```rust
fn max<T: PartialOrd>(a: T, b: T) -> T {
    if a >= b { a } else { b }
}
```

**Điểm khác biệt quan trọng: Monomorphization**

Java Generics dùng **type erasure** — runtime chỉ thấy `Object`. Rust dùng **monomorphization** — compiler tạo ra một phiên bản riêng cho mỗi type cụ thể:

```rust
max(1i32, 2i32)    // → compiler tạo max_i32()
max(1.0f64, 2.0f64) // → compiler tạo max_f64()
```

**Kết quả:** Zero runtime overhead cho generics (zero-cost abstraction). Nhưng binary size lớn hơn nếu dùng nhiều type.

---

## 2. Trait Bounds — Bộ lọc Type

```rust
use std::fmt::Display;

// Cách 1: inline bounds
fn print_largest<T: PartialOrd + Display>(list: &[T]) {
    let mut largest = &list[0];
    for item in list {
        if item > largest { largest = item; }
    }
    println!("Largest: {}", largest);
}

// Cách 2: where clause — khi bounds phức tạp
fn complex_function<T, U>(t: &T, u: &U)
where
    T: Display + Clone,
    U: Clone + Debug,
{ ... }
```

**`impl Trait` syntax — shorthand phổ biến trong web code:**
```rust
// Thay vì generic parameter, dùng impl Trait trực tiếp
fn make_greeting(name: impl Display) -> String {
    format!("Hello, {}!", name)
}

// Trong return position — "trả về một type nào đó implement Iterator"
fn evens_under_100() -> impl Iterator<Item = u32> {
    (0..100).filter(|x| x % 2 == 0)
}
```

---

## 3. Trait Objects — Dynamic Dispatch (`dyn Trait`)

Đây là điểm khác biệt quan trọng nhất so với Java.

### Generics = Static Dispatch (compile time)
```rust
fn notify(item: &impl Summary) {      // compiler biết type tại compile time
    println!("{}", item.summarize()); // gọi hàm trực tiếp, no overhead
}
```

### `dyn Trait` = Dynamic Dispatch (runtime, như Java Interface)
```rust
fn notify(item: &dyn Summary) {       // type unknown at compile time
    println!("{}", item.summarize()); // vtable lookup — slight overhead
}

// Thường gặp với Box để store trên heap
fn make_formatter() -> Box<dyn Formatter> {
    if some_condition { Box::new(JsonFormatter) }
    else { Box::new(XmlFormatter) }
}
```

### Khi nào dùng cái nào?

| | `impl Trait` / Generics | `dyn Trait` |
|---|---|---|
| Type biết lúc | Compile time | Runtime |
| Performance | Tốt hơn (direct call) | Chậm hơn chút (vtable) |
| Binary size | Lớn hơn (monomorphized) | Nhỏ hơn |
| Heterogeneous collection | ❌ Không thể | ✅ `Vec<Box<dyn Trait>>` |
| Return từ if/else | ❌ | ✅ |

**Java analog:** Java Interface luôn là dynamic dispatch. Rust cho bạn chọn.

---

## 4. Object Safety — Tại Sao Không Phải Trait Nào Cũng Làm `dyn` Được

```rust
// Object-SAFE — có thể dùng dyn
trait Summary {
    fn summarize(&self) -> String;
}

// NOT object-safe — không thể dùng dyn
trait Clone {
    fn clone(&self) -> Self; // Self trong return type → size unknown at runtime
}
```

**Rule của thumb:** Nếu method có `Self` trong signature (không phải `&self`), trait đó không object-safe.

---

## 5. Pattern Thực Tế: `Box<dyn Error>`

Đây là pattern bạn sẽ thấy **mọi nơi** trong web app code:

```rust
use std::error::Error;

// Thay vì khai báo cụ thể error type, dùng Box<dyn Error>
async fn run() -> Result<(), Box<dyn Error>> {
    let config = load_config()?;   // có thể fail với IoError
    let pool = connect_db(&config).await?; // có thể fail với DbError
    start_server(pool).await?;     // có thể fail với ServerError
    Ok(())
}
```

**Tại sao `Box`?** Vì `dyn Error` là unsized (compiler không biết size), phải wrap trong `Box` để để trên heap với known pointer size.

---

## 6. Newtype Pattern — Wrapper Type

Pattern quan trọng trong Rust web apps để add behavior cho external types:

```rust
// Không thể implement trait cho type ngoài crate của mình
// impl Display for Vec<String> { ... } // LỖI: orphan rule

// Solution: Newtype
struct Wrapper(Vec<String>);

impl std::fmt::Display for Wrapper {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "[{}]", self.0.join(", "))
    }
}
```

**Trong Axum:** Newtype pattern dùng để create custom extractors:
```rust
struct UserId(i64); // wrap primitive để add semantic meaning + validation
```

---

## 7. Associated Types vs Generic Parameters

```rust
// Associated type — một implementation chỉ có một Output
trait Iterator {
    type Item;  // associated type
    fn next(&mut self) -> Option<Self::Item>;
}

// Dùng: không cần specify type mỗi lần
fn sum_iter(iter: impl Iterator<Item = i32>) -> i32 { ... }

// Generic parameter — có thể implement nhiều lần với các types khác nhau
trait From<T> {
    fn from(value: T) -> Self;
}
// i32 có thể From<u8>, From<i8>, From<u16>, ...
```

---

## 8. Trong Web App — Các Trait Quan Trọng Nhất

```rust
// Axum: Handler trait — bất kỳ async function nào đúng signature
// Axum: IntoResponse — bất kỳ type nào có thể là HTTP response
// Axum: FromRequest / FromRequestParts — custom extractors
// Serde: Serialize / Deserialize — JSON in/out
// SQLx: FromRow — DB row → struct
// Tower: Service / Layer — middleware
```

Tất cả những cái này đều là Trait — hiểu Generics + Trait Objects = unlock toàn bộ framework ecosystem.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-5-Lifetimes|Bài 5: Lifetimes]] — thường dùng cùng generics
- [[Rust-Zero-To-Hero/Bai-7-Closures-Iterators|Bài 7: Closures & Iterators]] — dùng trait bounds liên tục
- [[Rust-Zero-To-Hero/Bai-3-Struct-Enum-Trait|Bài 3: Traits cơ bản]]

---
*Bài tập:*
1. Viết struct `Cache<K, V>` generic wrap `HashMap<K, V>` với method `get_or_insert(key: K, f: impl FnOnce() -> V) -> &V`.
2. Tạo `trait Validator { fn validate(&self) -> Result<(), String>; }`. Implement cho `Email(String)` và `PhoneNumber(String)`. Viết `fn validate_all(items: &[&dyn Validator])` nhận heterogeneous list.
