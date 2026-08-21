---
type: course
domain: languages/rust
status: active
created: 2026-08-22
updated: 2026-08-22
tags: []
---

# Bài 3d: Operator Overloading (`std::ops`) — Thứ Java chỉ cho phép với `String +`

Chào Chuyên gia Java, Java gần như cấm operator overloading (ngoại lệ duy nhất: `+` cho `String`). Rust thì cho phép bạn định nghĩa lại `+`, `-`, `[]`, thậm chí cả "toán tử mượn" `*obj` — tất cả thông qua các trait trong `std::ops`. Đây là mảnh ghép còn thiếu để hiểu trọn vẹn Bài 8 (Smart Pointers) — vì `Box<T>`/`Rc<T>` "tự động" cư xử như `T` chính là nhờ implement `Deref`.

## 1. Arithmetic: `Add`, `Sub`, `Mul`, `Neg`...

```rust
use std::ops::Add;

#[derive(Debug, Clone, Copy, PartialEq)]
struct Vector2D { x: f64, y: f64 }

impl Add for Vector2D {
    type Output = Vector2D;
    fn add(self, other: Vector2D) -> Vector2D {
        Vector2D { x: self.x + other.x, y: self.y + other.y }
    }
}

let a = Vector2D { x: 1.0, y: 2.0 };
let b = Vector2D { x: 3.0, y: 4.0 };
let c = a + b; // gọi Add::add(a, b) — compiler tự desugar
```

`Output` là associated type — cho phép `a + b` trả về kiểu khác kiểu của `a`/`b` nếu cần (ví dụ `Meters + Meters -> Meters`, nhưng `Meters * Meters -> SquareMeters`).

## 2. `Index` / `IndexMut` — cho phép `obj[i]`

```rust
use std::ops::Index;

struct Matrix {
    data: Vec<f64>,
    cols: usize,
}

impl Index<(usize, usize)> for Matrix {
    type Output = f64;
    fn index(&self, (row, col): (usize, usize)) -> &f64 {
        &self.data[row * self.cols + col]
    }
}

let m = Matrix { data: vec![1.0, 2.0, 3.0, 4.0], cols: 2 };
let val = m[(1, 0)]; // gọi Index::index — không cần method .get()
```

Java không có cách nào để `myObject[i]` hoạt động trên custom class — bạn buộc phải viết `.get(i)`.

## 3. `Deref` / `DerefMut` — cơ chế thật của Smart Pointer "tàng hình"

Đây là trait quan trọng nhất trong nhóm này, vì nó giải thích một câu hỏi ở Bài 8: **tại sao `Box<String>` gọi được thẳng `.len()` của `String` mà không cần `.deref()` tường minh?**

```rust
use std::ops::Deref;

struct MyBox<T>(T);

impl<T> Deref for MyBox<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

let b = MyBox(String::from("hello"));
println!("{}", b.len()); // compiler tự chèn (*b).len(), tức b.deref().len()
```

Cơ chế này gọi là **Deref coercion**: khi bạn gọi method không tồn tại trên `MyBox<T>`, compiler tự động "bóc" qua `deref()` để tìm method trên `T`, và làm liên tục nhiều tầng nếu cần (`&MyBox<String>` → `&String` → `&str`). Đây chính xác là lý do `Box<T>`, `Rc<T>`, `Arc<T>` "cảm giác như" chính `T` dù chúng là wrapper.

**Cảnh báo:** không tự implement `Deref` cho type không thực sự là "con trỏ thông minh" — lạm dụng nó để "giả kế thừa" là anti-pattern nổi tiếng trong Rust (được gọi là "Deref polymorphism", bị cộng đồng khuyến cáo tránh).

## 4. Khi nào NÊN và KHÔNG NÊN overload operator

**Nên:** khi type của bạn có ngữ nghĩa toán học/tập hợp tự nhiên — vector, matrix, tiền tệ, khoảng thời gian (`Duration + Duration`), smart pointer.

**Không nên:** overload `+` để làm việc gì đó không liên quan đến "cộng" theo trực giác (nguyên tắc *principle of least surprise* — người đọc code thấy `a + b` phải đoán đúng nó làm gì mà không cần xem implementation).

## 5. Liên hệ với `PartialEq`/`PartialOrd` (đã học ở Bài 3c)

`==`, `<`, `>` cũng là operator overloading — nhưng qua `PartialEq`/`PartialOrd` chứ không phải `std::ops::Add`-style. Điểm chung: tất cả operator trong Rust, không ngoại lệ, đều là **cú pháp đường (syntax sugar) cho một trait method cụ thể** — không có operator nào "built-in" theo nghĩa đặc biệt hóa ở compiler.

## 6. Cheat Sheet

| Operator | Trait | Method |
|---|---|---|
| `a + b` | `Add` | `add` |
| `a - b` | `Sub` | `sub` |
| `-a` | `Neg` | `neg` |
| `a[i]` | `Index` | `index` |
| `a[i] = x` | `IndexMut` | `index_mut` |
| `*a` | `Deref` | `deref` |
| `a == b` | `PartialEq` | `eq` |
| `a < b` | `PartialOrd` | `partial_cmp` |

---
**Bài tập nhỏ:**
1. Implement `Sub` và `Mul<f64>` (scalar multiplication) cho `Vector2D` ở trên.
2. Viết một wrapper `struct Meters(f64)` và implement `Add` sao cho `Meters(1.0) + Meters(2.0) == Meters(3.0)`, rồi thử implement `Mul<Meters> for Meters` trả về một `struct SquareMeters(f64)` để thấy `Output` khác kiểu input.
