# Bài 18: Type System Nâng Cao — Phantom Types, Typestate, HRTB, GAT

> **Java dev insight:** Java type system giải quyết OOP. Rust type system giải quyết *correctness* — encode invariants vào types để compiler bắt lỗi logic thay vì để lọt vào runtime. Đây là điểm Rust vượt xa Java generics.

---

## 1. Phantom Types — Type Parameter Không Có Trong Data

**Vấn đề:** Bạn muốn 2 ID types khác nhau nhưng cùng underlying type, và muốn compiler ngăn nhầm lẫn.

```java
// Java: dễ nhầm vì cùng type Long
Long userId = getUserId();
Long orderId = getOrderId();
deleteOrder(userId);  // BUG: compiler không catch — cùng type Long!
```

```rust
use std::marker::PhantomData;

// PhantomData<T> không chiếm space — size = 0
// Nhưng compiler track T như thật
struct Id<T> {
    value: i64,
    _marker: PhantomData<T>,  // 0 bytes, chỉ để carry type info
}

// Marker types — không có data, chỉ dùng làm type tag
struct UserMarker;
struct OrderMarker;

type UserId  = Id<UserMarker>;
type OrderId = Id<OrderMarker>;

fn delete_order(id: OrderId) { /* ... */ }

let user_id:  UserId  = Id { value: 1, _marker: PhantomData };
let order_id: OrderId = Id { value: 1, _marker: PhantomData };

delete_order(order_id);  // ✅ OK
delete_order(user_id);   // ❌ COMPILE ERROR: expected Id<OrderMarker>, got Id<UserMarker>
```

**Ứng dụng thực tế:**

```rust
// Type-safe units — tránh nhầm meter và foot
struct Meters;
struct Feet;

struct Distance<Unit> {
    value: f64,
    _unit: PhantomData<Unit>,
}

impl Distance<Meters> {
    fn to_feet(self) -> Distance<Feet> {
        Distance { value: self.value * 3.281, _unit: PhantomData }
    }
}

// Mars Climate Orbiter crash (1999) = Meters vs Feet bug
// Rust type system ngăn điều này tại compile time
```

---

## 2. Typestate Pattern — State Machine Tại Compile Time

**Vấn đề:** State machine thường được implement bằng enum + runtime check trong Java. Rust encode state vào type — invalid transition = compile error.

```rust
// Marker structs cho mỗi state (zero size)
struct Disconnected;
struct Connected;
struct Authenticated;

// Connection generic trên State
struct TcpConnection<State> {
    stream: Option<TcpStream>,
    _state: PhantomData<State>,
}

// Methods chỉ available ở đúng state
impl TcpConnection<Disconnected> {
    pub fn new() -> Self {
        TcpConnection { stream: None, _state: PhantomData }
    }
    
    // connect() consume Self, trả về new type
    pub fn connect(self, addr: &str) -> Result<TcpConnection<Connected>, Error> {
        let stream = TcpStream::connect(addr)?;
        Ok(TcpConnection { stream: Some(stream), _state: PhantomData })
    }
}

impl TcpConnection<Connected> {
    pub fn authenticate(self, token: &str) -> Result<TcpConnection<Authenticated>, Error> {
        // gửi auth request...
        Ok(TcpConnection { stream: self.stream, _state: PhantomData })
    }
    
    // send() KHÔNG available ở Connected — phải authenticate trước
}

impl TcpConnection<Authenticated> {
    pub fn send(&mut self, data: &[u8]) -> Result<(), Error> {
        self.stream.as_mut().unwrap().write_all(data)?;
        Ok(())
    }
    
    pub fn disconnect(self) -> TcpConnection<Disconnected> {
        TcpConnection { stream: None, _state: PhantomData }
    }
}

// Usage — state transitions enforce by type system
fn main() -> Result<(), Error> {
    let conn = TcpConnection::new();                    // Disconnected
    let conn = conn.connect("127.0.0.1:8080")?;        // Connected
    let mut conn = conn.authenticate("secret-token")?; // Authenticated
    conn.send(b"hello")?;                               // ✅ OK
    
    // conn_disconnected.send()  // ❌ COMPILE ERROR: no method send on Disconnected
    // conn_connected.send()     // ❌ COMPILE ERROR: no method send on Connected
    Ok(())
}
```

**So sánh Java — phải dùng runtime check:**

```java
class TcpConnection {
    enum State { DISCONNECTED, CONNECTED, AUTHENTICATED }
    private State state = State.DISCONNECTED;
    
    public void send(byte[] data) {
        if (state != State.AUTHENTICATED)           // runtime check!
            throw new IllegalStateException();      // discovered in prod
        // ...
    }
}
```

---

## 3. Newtype Pattern — Type Safety Cho Primitives

```rust
// Vấn đề: String, f64 quá generic — không encode meaning
fn set_timeout(ms: u64) { /* ... */ }
fn set_temperature(celsius: f64) { /* ... */ }

set_timeout(500.0 as u64);      // ??? milliseconds hay seconds?
set_temperature(37.0);           // ??? Celsius hay Fahrenheit?

// Newtype: wrap primitive, zero runtime cost
#[derive(Debug, Clone, Copy)]
struct Milliseconds(u64);

#[derive(Debug, Clone, Copy)]
struct Celsius(f64);

#[derive(Debug, Clone, Copy)]
struct Fahrenheit(f64);

impl Celsius {
    fn to_fahrenheit(self) -> Fahrenheit {
        Fahrenheit(self.0 * 9.0/5.0 + 32.0)
    }
}

fn set_timeout(duration: Milliseconds) { /* ... */ }
fn set_temperature(temp: Celsius)      { /* ... */ }

set_timeout(Milliseconds(500));          // rõ ràng
set_temperature(Fahrenheit(98.6).into()); // ❌ COMPILE ERROR

// Orphan rule workaround
// Cannot: impl Display for Vec<String>  // LỖI: cả hai là external types
struct Wrapper(Vec<String>);             // newtype solve orphan rule
impl Display for Wrapper { /* ... */ }
```

---

## 4. HRTB — Higher-Ranked Trait Bounds (`for<'a>`)

**Vấn đề:** Khi bạn cần bound một closure/function làm việc với **bất kỳ** lifetime nào.

```rust
// Thông thường:
fn apply<'a, F>(f: F, s: &'a str) -> &'a str
where F: Fn(&'a str) -> &'a str
{
    f(s)
}
// Vấn đề: F bị tied với một lifetime cụ thể 'a

// HRTB: F phải work với ANY lifetime
fn apply_any<F>(f: F, s: &str) -> &str
where F: for<'a> Fn(&'a str) -> &'a str
//       ^^^^^^^^ "for any lifetime 'a"
{
    f(s)
}

// Dùng khi nào:
// - Closure nhận reference và trả về reference
// - Bạn muốn closure work với references của nhiều lifetimes khác nhau
// - Thường gặp trong: parser combinators, async traits (trước async_trait)

// Ví dụ thực tế:
fn parse_all<'input, F>(inputs: &[&'input str], parser: F) -> Vec<i32>
where
    F: for<'a> Fn(&'a str) -> Option<i32>,
{
    inputs.iter().filter_map(|s| parser(s)).collect()
}
```

---

## 5. GAT — Generic Associated Types

**GAT (stable từ Rust 1.65) cho phép associated type của trait có generic parameters.**

```rust
// Vấn đề: muốn trait Iterator có thể yield references với lifetime
// Không có GAT:
trait MyIterator {
    type Item;
    fn next(&mut self) -> Option<Self::Item>;
    // Không thể: type Item<'a>;  ← GAT
}

// Với GAT:
trait LendingIterator {
    type Item<'a> where Self: 'a;   // Item có thể borrow từ Self
    fn next<'a>(&'a mut self) -> Option<Self::Item<'a>>;
}

// Implement cho window iterator (yield slices mà không copy)
struct Windows<'data, T> {
    data: &'data [T],
    size: usize,
    pos: usize,
}

impl<'data, T> LendingIterator for Windows<'data, T> {
    type Item<'a> = &'a [T] where Self: 'a;
    
    fn next<'a>(&'a mut self) -> Option<&'a [T]> {
        if self.pos + self.size > self.data.len() {
            return None;
        }
        let window = &self.data[self.pos..self.pos + self.size];
        self.pos += 1;
        Some(window)
    }
}
// Không cần copy data — yield references trực tiếp vào slice
```

---

## 6. Const Generics — Compile-time Constants

```rust
// Mảng có size là generic parameter
struct Matrix<const ROWS: usize, const COLS: usize> {
    data: [[f64; COLS]; ROWS],
}

impl<const R: usize, const C: usize> Matrix<R, C> {
    fn new() -> Self {
        Matrix { data: [[0.0; C]; R] }
    }
    
    fn transpose(&self) -> Matrix<C, R> {
        let mut result = Matrix::new();
        for i in 0..R {
            for j in 0..C {
                result.data[j][i] = self.data[i][j];
            }
        }
        result
    }
}

// Type-level dimension check
impl<const N: usize, const M: usize, const K: usize> Matrix<N, M> {
    fn multiply(&self, rhs: &Matrix<M, K>) -> Matrix<N, K> {
        // Chỉ compile nếu inner dimensions match
        // Matrix<3,4>.multiply(Matrix<4,5>) → OK
        // Matrix<3,4>.multiply(Matrix<5,4>) → COMPILE ERROR
        // ...
    }
}

// Stack-allocated, zero heap — compiler biết kích thước tại compile time
let m: Matrix<3, 4> = Matrix::new();
// size_of::<Matrix<3,4>>() = 3 * 4 * 8 = 96 bytes, trên stack
```

---

## 7. Type-level Programming — Builder Pattern với Types

```rust
// Request builder — enforce required fields tại compile time
struct Missing;
struct Present<T>(T);

struct RequestBuilder<Url, Body> {
    url: Url,
    body: Body,
    timeout_ms: u64,
}

impl RequestBuilder<Missing, Missing> {
    pub fn new() -> Self {
        RequestBuilder { url: Missing, body: Missing, timeout_ms: 5000 }
    }
}

impl<B> RequestBuilder<Missing, B> {
    pub fn url(self, url: &str) -> RequestBuilder<Present<String>, B> {
        RequestBuilder {
            url: Present(url.to_owned()),
            body: self.body,
            timeout_ms: self.timeout_ms,
        }
    }
}

impl<U> RequestBuilder<U, Missing> {
    pub fn body(self, body: Vec<u8>) -> RequestBuilder<U, Present<Vec<u8>>> {
        RequestBuilder {
            url: self.url,
            body: Present(body),
            timeout_ms: self.timeout_ms,
        }
    }
}

// send() chỉ available khi CẢ HAI url và body đều được set
impl RequestBuilder<Present<String>, Present<Vec<u8>>> {
    pub fn send(self) -> Result<Response, Error> {
        // url và body guaranteed present at compile time
        http_send(&self.url.0, &self.body.0)
    }
}

// Usage:
RequestBuilder::new().send();                    // ❌ COMPILE ERROR: missing url + body
RequestBuilder::new().url("...").send();         // ❌ COMPILE ERROR: missing body
RequestBuilder::new().url("...").body(vec![]).send(); // ✅ OK
```

---

## 8. So sánh Type System: Java vs Rust

| Feature | Java | Rust |
|---|---|---|
| Generics | Type erasure, bounded | Monomorphized, bounded |
| State validation | Runtime exception | Compile-time (Typestate) |
| Unit type safety | Không có | Phantom Types |
| Null safety | Optional (Optional<T>) | `Option<T>` built-in |
| Dimension check | Runtime | Const Generics |
| Builder required fields | Runtime/annotation | Type-level |
| Associated types | — | Associated Types + GAT |
| HRTB | Không có | `for<'a>` |

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-6-Generics-Traits-Advanced|Bài 6: Generics & Traits cơ bản]]
- [[Rust-Zero-To-Hero/Bai-5-Lifetimes|Bài 5: Lifetimes]] — prerequisite cho HRTB
- [[Rust-Zero-To-Hero/Bai-19-Unsafe-FFI|Bài 19: Unsafe & FFI]] → tiếp theo

---
*Bài tập:*
1. Implement `EmailAddress(String)` newtype với validation trong constructor. Implement `Display` và `FromStr`. Đảm bảo compiler ngăn truyền raw `String` vào nơi cần `EmailAddress`.
2. Implement Typestate cho `DatabaseTransaction<State>` với states: `Active`, `Committed`, `RolledBack`. `query()` và `commit()`/`rollback()` chỉ available ở `Active`.
3. Viết `Matrix<const R: usize, const C: usize>` với `multiply()` — verify dimension mismatch là COMPILE ERROR chứ không phải runtime panic.
