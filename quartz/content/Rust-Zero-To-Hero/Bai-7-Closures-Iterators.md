# Bài 7: Closures & Iterators — Functional Core của Rust

Chào Chuyên gia Java. Nếu bạn đã quen với Java `Stream<T>` và `Function<T,R>`, bài này sẽ rất familiar — nhưng Rust version không bị boxing overhead và lazy hơn thật sự.

---

## 1. Closures — Ba Loại, Một Quyết Định

Trong Java có `Function<T,R>`, `Consumer<T>`, `Supplier<T>`. Rust đơn giản hơn: mọi closure đều là một trong 3 trait.

### Ba Fn Traits

```rust
// FnOnce — có thể gọi đúng 1 lần (vì nó consume captured value)
let s = String::from("hello");
let consume = move || { drop(s); }; // s moved vào closure
consume(); // OK
// consume(); // LỖI: s đã bị consume

// FnMut — có thể gọi nhiều lần, mutate captured value
let mut count = 0;
let mut increment = || { count += 1; count };
println!("{}", increment()); // 1
println!("{}", increment()); // 2

// Fn — có thể gọi nhiều lần, chỉ read captured value
let name = String::from("Bach");
let greet = || format!("Hello, {}!", name);
println!("{}", greet()); // Hello, Bach!
println!("{}", greet()); // Hello, Bach! — name vẫn còn
```

**Hierarchy:** `Fn` ⊂ `FnMut` ⊂ `FnOnce`
- Mọi `Fn` cũng implement `FnMut` và `FnOnce`
- Khi viết bounds, prefer `FnOnce` nếu chỉ gọi một lần, `Fn` nếu cần gọi nhiều lần

### `move` Keyword — Force Ownership Capture

```rust
// Quan trọng khi spawn threads / async tasks
let data = vec![1, 2, 3];
let handle = std::thread::spawn(move || {
    // data moved vào closure — thread sở hữu nó
    println!("{:?}", data);
});
// data không còn dùng được ở đây
```

**Java analog:** `() -> System.out.println(data)` — Java capture by reference, nhưng yêu cầu effectively final. Rust capture by move (với `move`) hoặc by reference (mặc định).

---

## 2. Closures Trong Function Signatures

```rust
// Nhận closure là argument
fn apply<F: Fn(i32) -> i32>(f: F, x: i32) -> i32 {
    f(x)
}

// Trả về closure — phải dùng Box<dyn Fn> hoặc impl Fn
fn make_adder(n: i32) -> impl Fn(i32) -> i32 {
    move |x| x + n  // n được capture bởi move
}

let add5 = make_adder(5);
println!("{}", add5(3)); // 8
```

**Trong Axum** — closure xuất hiện liên tục:
```rust
Router::new()
    .route("/users", get(list_users))
    .layer(from_fn(|req, next| async move {  // ← closure làm middleware
        // auth logic
        next.run(req).await
    }));
```

---

## 3. Iterator Trait

```rust
pub trait Iterator {
    type Item;
    fn next(&mut self) -> Option<Self::Item>;
    // + ~70 default methods được build trên next()
}
```

**Lazy evaluation:** Iterator không làm gì cho đến khi được consumed. Đây là điểm khác biệt lớn với Java Stream.

```rust
let v = vec![1, 2, 3, 4, 5];

// KHÔNG có gì chạy ở đây — chỉ build pipeline
let pipeline = v.iter()
    .filter(|&&x| x % 2 == 0)
    .map(|&x| x * 10);

// CHỈ chạy khi collect/for/sum/etc
let result: Vec<i32> = pipeline.collect(); // [20, 40]
```

---

## 4. Các Adapter Quan Trọng Nhất

```rust
let nums = vec![1, 2, 3, 4, 5, 6];

// map — transform từng element
let doubled: Vec<i32> = nums.iter().map(|&x| x * 2).collect();

// filter — giữ lại element thỏa điều kiện
let evens: Vec<&i32> = nums.iter().filter(|&&x| x % 2 == 0).collect();

// filter_map — filter + transform cùng lúc (rất phổ biến)
let parsed: Vec<i32> = vec!["1", "two", "3", "four"]
    .iter()
    .filter_map(|s| s.parse().ok()) // None cho "two", "four" → bị loại
    .collect(); // [1, 3]

// flat_map — map rồi flatten
let words = vec!["hello world", "foo bar"];
let letters: Vec<&str> = words.iter()
    .flat_map(|s| s.split_whitespace())
    .collect(); // ["hello", "world", "foo", "bar"]

// fold — reduce / accumulate
let sum = nums.iter().fold(0, |acc, &x| acc + x); // 21

// enumerate — (index, value)
for (i, val) in nums.iter().enumerate() {
    println!("{}: {}", i, val);
}

// zip — merge hai iterators
let names = vec!["Alice", "Bob"];
let scores = vec![100, 95];
let pairs: Vec<_> = names.iter().zip(scores.iter()).collect();
// [("Alice", 100), ("Bob", 95)]

// chain — nối hai iterators
let a = vec![1, 2];
let b = vec![3, 4];
let chained: Vec<_> = a.iter().chain(b.iter()).collect(); // [1,2,3,4]

// take / skip — pagination
let page: Vec<_> = nums.iter().skip(2).take(3).collect(); // [3,4,5]

// any / all — short-circuit boolean
let has_even = nums.iter().any(|&x| x % 2 == 0);   // true
let all_pos  = nums.iter().all(|&x| x > 0);         // true
```

---

## 5. Consuming Adapters (Terminal Operations)

```rust
// collect — thành Vec, HashMap, String, etc.
let set: std::collections::HashSet<i32> = nums.iter().copied().collect();

// sum / product
let total: i32 = nums.iter().sum();

// count
let n = nums.iter().filter(|&&x| x > 3).count();

// min / max — trả về Option
let biggest = nums.iter().max(); // Some(6)

// find — trả về Option<&T>
let first_even = nums.iter().find(|&&x| x % 2 == 0); // Some(2)

// position — trả về Option<usize>
let idx = nums.iter().position(|&x| x == 3); // Some(2)
```

---

## 6. Implementing Iterator cho Custom Type

```rust
struct Counter {
    count: u32,
    max: u32,
}

impl Counter {
    fn new(max: u32) -> Counter { Counter { count: 0, max } }
}

impl Iterator for Counter {
    type Item = u32;
    fn next(&mut self) -> Option<Self::Item> {
        if self.count < self.max {
            self.count += 1;
            Some(self.count)
        } else {
            None
        }
    }
}

// Miễn phí: tất cả 70+ adapter methods
let sum: u32 = Counter::new(5).zip(Counter::new(5).skip(1))
    .map(|(a, b)| a * b)
    .filter(|x| x % 3 == 0)
    .sum(); // 6
```

---

## 7. Pattern Thực Tế Trong Web App

```rust
// Validate và transform request payload
async fn create_users(Json(payloads): Json<Vec<CreateUserDto>>) {
    let (valid, invalid): (Vec<_>, Vec<_>) = payloads
        .into_iter()
        .partition(|dto| dto.email.contains('@'));
    
    // valid → insert to DB
    // invalid → collect errors
}

// Map DB rows → response DTOs
let users: Vec<UserResponse> = rows
    .into_iter()
    .map(UserResponse::from)
    .collect();

// Group by field
use std::collections::HashMap;
let by_role: HashMap<String, Vec<User>> = users
    .into_iter()
    .fold(HashMap::new(), |mut map, user| {
        map.entry(user.role.clone()).or_default().push(user);
        map
    });
```

---

## 8. Cheat Sheet: Java Stream → Rust Iterator

| Java Stream | Rust Iterator | Note |
|---|---|---|
| `.map(f)` | `.map(f)` | Tương đương |
| `.filter(p)` | `.filter(p)` | Tương đương |
| `.flatMap(f)` | `.flat_map(f)` | Tương đương |
| `.collect(toList())` | `.collect::<Vec<_>>()` | Type inference thường tự suy |
| `.reduce(id, f)` | `.fold(init, f)` | Tương đương |
| `.findFirst()` | `.next()` hoặc `.find(p)` | |
| `.anyMatch(p)` | `.any(p)` | |
| `.allMatch(p)` | `.all(p)` | |
| `Stream.of(a,b)` | `[a,b].into_iter()` | |
| `.sorted()` | `.sorted()` (cần Itertools) | std: `.collect` rồi `.sort()` |
| `.distinct()` | Collect vào HashSet | |
| `.limit(n)` | `.take(n)` | |
| `.skip(n)` | `.skip(n)` | |

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-6-Generics-Traits-Advanced|Bài 6: Generics]] — Fn traits là generic bounds
- [[Rust-Zero-To-Hero/Bai-8-Smart-Pointers-Error-Design|Bài 8: Smart Pointers & Error Design]]

---
*Bài tập:*
1. Viết `fn word_count(text: &str) -> HashMap<&str, usize>` dùng thuần iterator pipeline (không dùng vòng lặp).
2. Implement `Iterator` cho struct `Fibonacci` trả về dãy Fibonacci. Dùng `.take(10).sum::<u64>()` để test.
3. Viết `fn paginate<T>(items: Vec<T>, page: usize, size: usize) -> Vec<T>` dùng `.skip().take()`.
