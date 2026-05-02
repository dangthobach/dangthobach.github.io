# Bài 5: Lifetimes — Khi Compiler Hỏi "Mượn Bao Lâu?"

Chào Chuyên gia Java. Đây là topic khiến nhiều người bỏ cuộc với Rust. Nhưng với background của bạn, có một cách nhìn rất thực tế: **Lifetime là cách compiler hỏi một câu hỏi mà Java runtime thường chỉ phát hiện lúc crash.**

---

## 1. Vấn đề Lifetime Giải Quyết

### Java: Vấn đề ẩn
```java
public String getDangerousRef() {
    StringBuilder sb = new StringBuilder("hello");
    return sb.toString(); // OK vì GC giữ object sống
}
// Trong Java, GC đảm bảo object không bị xóa khi còn reference.
// Nhưng cost: GC phải chạy liên tục để track.
```

### Rust: Tường minh hóa vấn đề
```rust
fn dangerous() -> &str {        // LỖI: trả về reference vào gì?
    let s = String::from("hello");
    &s                          // s bị drop ở đây → dangling reference
}
// Rust từ chối compile. Java runtime sẽ để nó qua, rồi GC xử lý.
```

**Lifetime annotation là cách bạn nói với compiler:** "Tôi đảm bảo reference này sống ít nhất bằng thời gian của X."

---

## 2. Syntax Cơ Bản

```rust
// 'a là lifetime parameter — đọc là "tick a"
fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() { x } else { y }
}
```

**Đọc như thế nào:** "Hàm `longest` nhận hai string slice có cùng lifetime `'a`, và trả về một string slice sống ít nhất bằng `'a`."

Compiler không quan tâm `'a` là bao lâu — nó chỉ cần biết **mối quan hệ** giữa các lifetimes.

```rust
fn main() {
    let string1 = String::from("long string");
    let result;
    {
        let string2 = String::from("xy");
        result = longest(string1.as_str(), string2.as_str());
        println!("{}", result); // OK: result dùng trong scope string2 còn sống
    }
    // println!("{}", result); // LỖI: string2 đã chết, result có thể trỏ vào rác
}
```

---

## 3. Lifetime Trong Struct

Khi struct giữ một reference, bạn phải khai báo lifetime:

```rust
// Struct này không sở hữu string — nó mượn từ đâu đó
struct Excerpt<'a> {
    content: &'a str,
}

impl<'a> Excerpt<'a> {
    fn level(&self) -> i32 { 3 }
    
    fn announce(&self, announcement: &str) -> &str {
        println!("Attention: {}", announcement);
        self.content // lifetime của output = lifetime của &self
    }
}

fn main() {
    let novel = String::from("Call me Ishmael. Some years ago...");
    let first_sentence = novel.split('.').next().unwrap();
    
    let excerpt = Excerpt { content: first_sentence };
    // excerpt không thể outlive novel
}
```

**Java analog:** Không có trực tiếp. Gần nhất là khi một inner class giữ reference đến outer object — nhưng Java không enforce điều này tại compile time.

---

## 4. Lifetime Elision — Khi Compiler Tự Suy

Trong nhiều trường hợp, bạn **không cần viết lifetime annotation** vì compiler áp dụng 3 rules tự động:

**Rule 1:** Mỗi input reference nhận một lifetime riêng.
```rust
fn foo(x: &str, y: &str) → foo<'a>(x: &'a str, y: &'b str)
```

**Rule 2:** Nếu chỉ có 1 input lifetime, output dùng lifetime đó.
```rust
fn first_word(s: &str) -> &str  // compiler hiểu: -> &'same str
```

**Rule 3:** Nếu có `&self` hoặc `&mut self`, output dùng lifetime của self.
```rust
impl Excerpt<'_> {
    fn content(&self) -> &str { self.content } // OK, rule 3 applies
}
```

**Khi nào phải viết explicit:** Khi compiler báo lỗi, hoặc khi function có nhiều input references và output có thể đến từ bất kỳ input nào.

---

## 5. `'static` Lifetime

```rust
let s: &'static str = "I live forever";
```

`'static` nghĩa là reference sống suốt thời gian chạy của chương trình. Hai nguồn chính:
- String literals (nằm trong binary)
- Data được `leak()` ra khỏi Heap

**Trong Axum web apps:** Bạn sẽ thấy `'static` trong trait bounds:
```rust
// Handler phải 'static vì Tokio có thể chạy nó trên bất kỳ thread nào
async fn handler() -> impl IntoResponse { ... }
// Axum yêu cầu Handler: 'static — đây là lý do không thể pass &local_var vào handler
```

---

## 6. Pattern Thực Tế Trong Web App

### Pattern 1: Luôn dùng owned types trong struct
```rust
// ❌ Tránh: phải mang lifetime annotation khắp nơi
struct Config<'a> {
    db_url: &'a str,
}

// ✅ Tốt hơn: owned String, không cần lifetime
struct Config {
    db_url: String,
}
```

### Pattern 2: Dùng `&str` trong function parameters, `String` khi return/store
```rust
fn greet(name: &str) -> String {         // input mượn, output sở hữu
    format!("Hello, {}!", name)
}
```

### Pattern 3: Trong Axum extractors, lifetime được handle bởi framework
```rust
async fn create_user(
    State(pool): State<PgPool>,          // Arc clone internally
    Json(payload): Json<CreateUserDto>,  // owned, deserialized
) -> impl IntoResponse { ... }
```

---

## 7. Mental Model Cuối Cùng

| Câu hỏi | Java trả lời | Rust trả lời |
|---|---|---|
| Reference này sống bao lâu? | GC tự quản lý runtime | Compiler verify tại compile time |
| Ai chịu trách nhiệm? | GC | Owner (qua lifetime) |
| Khi nào phát hiện lỗi? | Runtime (NullPtr, etc.) | Compile time |
| Cost? | GC overhead | Zero runtime cost |

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-1-Ownership-Mindset|Bài 1: Ownership]] — prerequisite
- [[Rust-Zero-To-Hero/Bai-6-Generics-Traits-Advanced|Bài 6: Generics nâng cao]] — dùng lifetime + generics cùng nhau
- [[MOC-Memory-Model]] — big picture

---
*Bài tập:*
1. Viết hàm `first_word(s: &str) -> &str` trả về từ đầu tiên trong chuỗi (split by space). Không cần annotation — tại sao?
2. Viết struct `StrSplit<'a>` giữ `&'a str` và implement iterator để split theo delimiter. Viết lifetime annotation đầy đủ.
