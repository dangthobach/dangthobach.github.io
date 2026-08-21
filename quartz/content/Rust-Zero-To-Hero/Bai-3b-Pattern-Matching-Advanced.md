---
type: course
domain: languages/rust
status: active
created: 2026-08-22
updated: 2026-08-22
tags: []
---

# Bài 3b: Pattern Matching nâng cao — Khi `switch-case` của Java chỉ là trò trẻ con

Chào Chuyên gia Java, ở Bài 3 bạn đã thấy `match` cơ bản với các variant của enum. Nhưng đó chỉ là bề nổi. `match` trong Rust là một **hệ thống suy luận đầy đủ** (exhaustive pattern matching), không chỉ là switch-case với `case` nhãn. Bài này lấp đầy phần "cơ bản nhưng sống còn" mà Bài 3 đã bỏ qua — và bạn sẽ chạm vào chúng ở mọi dòng code Rust idiomatic sau này.

## 1. Match Guards — thêm điều kiện `if` vào từng nhánh

Java's `switch` (kể cả pattern matching switch từ Java 21) không cho bạn thêm điều kiện tùy ý vào một `case`. Rust thì có:

```rust
fn classify(n: i32) -> &'static str {
    match n {
        x if x < 0 => "âm",
        0 => "không",
        x if x % 2 == 0 => "dương chẵn",
        _ => "dương lẻ",
    }
}
```

**Lưu ý quan trọng:** guard không tính vào exhaustiveness check — compiler vẫn bắt bạn phải có nhánh `_` dự phòng vì nó không biết guard có che phủ hết case hay không.

## 2. `@` Bindings — vừa match pattern vừa lấy giá trị

Đây là thứ Java hoàn toàn không có. Bạn vừa kiểm tra điều kiện vừa bind biến:

```rust
enum Message {
    Hello { id: i32 },
}

fn check(msg: Message) {
    match msg {
        Message::Hello { id: id_variable @ 3..=7 } => {
            println!("id nằm trong khoảng 3-7: {}", id_variable)
        }
        Message::Hello { id: 10..=12 } => {
            println!("id trong khoảng đặc biệt, nhưng không cần lấy giá trị ra")
        }
        Message::Hello { id } => println!("id khác: {}", id),
    }
}
```

`id_variable @ 3..=7` nghĩa là: "match nếu `id` nằm trong 3..=7, VÀ đồng thời gán giá trị đó vào `id_variable`".

## 3. Or-patterns (`|`) và Range Patterns

```rust
fn describe(c: char) -> &'static str {
    match c {
        'a' | 'e' | 'i' | 'o' | 'u' => "nguyên âm",
        'a'..='z' => "chữ thường",
        'A'..='Z' => "chữ hoa",
        '0'..='9' => "chữ số",
        _ => "ký tự khác",
    }
}
```

Or-pattern (`|`) tương đương `case 'a': case 'e':` fall-through liên tiếp trong Java — nhưng ở Rust bạn viết trên một dòng, không cần `break`.

## 4. `if let`, `while let`, và `let-else` — khi bạn chỉ quan tâm 1 nhánh

Có những lúc bạn chỉ muốn xử lý MỘT variant và bỏ qua phần còn lại. Viết cả `match` cho việc này là thừa:

```rust
// Thay vì match đầy đủ chỉ để xử lý Some(x)
let config: Option<i32> = Some(3);
if let Some(max) = config {
    println!("Max là {}", max);
}

// while let: lặp cho tới khi pattern không còn match
let mut stack = vec![1, 2, 3];
while let Some(top) = stack.pop() {
    println!("Pop: {}", top);
}
```

**`let-else` (Rust 1.65+)** — cực kỳ hữu ích để "early return" khi pattern không match, tránh nested `if let`:

```rust
fn get_count(s: &str) -> u32 {
    let Ok(count) = s.parse::<u32>() else {
        eprintln!("'{s}' không phải số hợp lệ, dùng 0");
        return 0;
    };
    count // ở đây count đã chắc chắn là u32, không còn nằm trong Result
}
```

So với Java: `let-else` giống việc bạn viết `if (!(obj instanceof Foo f)) { return default; }` rồi dùng thẳng `f` — nhưng built-in vào ngôn ngữ và bắt buộc nhánh else phải diverge (return/break/continue/panic).

## 5. `matches!` macro — khi bạn chỉ cần true/false

```rust
let x = 5;
if matches!(x, 1 | 2 | 3) {
    println!("x nhỏ");
}
```

Không cần viết cả block `match` chỉ để trả về `bool`.

## 6. Exhaustiveness & `#[non_exhaustive]`

Compiler Rust **bắt buộc** bạn xử lý hết mọi variant của enum — đây là lý do "tường minh" hơn Java rất nhiều (Java cho phép `switch` thiếu case, gây bug runtime). Nhưng khi thiết kế thư viện public, đôi khi bạn muốn cấm người dùng dựa vào exhaustiveness (để sau này thêm variant mới không phá vỡ code của họ):

```rust
#[non_exhaustive]
pub enum ApiError {
    NotFound,
    Timeout,
}
// Bên ngoài crate, match bắt buộc phải có nhánh `_`, dù đã liệt kê hết variant hiện tại
```

## 7. Destructuring nâng cao: struct, tuple, slice patterns

```rust
struct Point { x: i32, y: i32 }
let p = Point { x: 0, y: 7 };
let Point { x, y } = p; // destructure toàn bộ
let Point { x: 0, y } = p else { panic!() }; // kết hợp với let-else

// Slice pattern — rất hữu ích khi parse args, protocol, log lines
let arr = [1, 2, 3, 4, 5];
match arr {
    [first, .., last] => println!("Đầu {}, cuối {}", first, last),
}
if let [a, b, rest @ ..] = arr {
    println!("a={a}, b={b}, còn lại {:?}", rest);
}
```

## 8. Binding modes: `ref` và `ref mut`

Khi match trên một reference, đôi khi bạn cần bind theo reference thay vì move giá trị ra:

```rust
let maybe_name = Some(String::from("Alice"));
match &maybe_name {
    Some(name) => println!("Có tên: {}", name), // name: &String, không move
    None => println!("Không có tên"),
}
// maybe_name vẫn dùng được ở đây vì ta chỉ borrow, không move
```

Rust 2018+ có "match ergonomics" tự động suy ra `ref`/`ref mut` khi match trên `&T`/`&mut T`, nên bạn hiếm khi phải viết `ref` tường minh — nhưng hiểu cơ chế này giúp bạn đọc được lỗi compiler khi "move ra khỏi borrowed content".

## 9. Cheat Sheet so sánh Java

| Tính năng | Java (switch pattern, 21+) | Rust |
|---|---|---|
| Điều kiện thêm vào case | `case Foo f when f.x() > 0` | match guard `x if cond` |
| Bind + check cùng lúc | tương tự trên (pattern var) | `@` binding |
| Fall-through nhiều case | `case A, B, C ->` | or-pattern `A \| B \| C` |
| Chỉ xử lý 1 nhánh | `if (obj instanceof Foo f)` | `if let` / `let-else` |
| Bắt buộc xử lý hết case | Không (trước 21), có (sealed + 21) | Luôn luôn, mặc định |
| Destructure record | record pattern (Java 21) | struct/tuple/slice pattern |

---
**Bài tập nhỏ:**
1. Viết hàm `fn grade(score: u32) -> char` dùng match với range pattern: 90..=100 → 'A', 80..=89 → 'B', v.v., dùng guard để xử lý số > 100 là lỗi.
2. Viết một hàm dùng `let-else` để parse 3 số từ một `&str` dạng `"1,2,3"` (split rồi parse), trả về `(i32, i32, i32)`, in lỗi và trả về `(0,0,0)` nếu parse thất bại.
