# Level 4 · Type System Mastery

> *"Compiler proves correctness". Level này là nơi Rust không có đối thủ — encode invariants vào types để errors impossible tại runtime. GATs, HRTB, Const Generics, Variance là tools của senior Rustacean.*

---

## 1. GATs — Generic Associated Types

### Vấn Đề GATs Giải Quyết

Trước GATs (Rust 1.65), associated types không thể có lifetime/type parameters:

```rust
// ❌ TRƯỚC GATs: không thể express "Iterator trả về reference vào self"
trait Container {
    type Item;
    fn iter(&self) -> ???; // không thể return &self items
}
```

### Prototype: GATs Thực Tế

```rust
// ─── GAT: Lending Iterator (không thể làm trước Rust 1.65) ──────────────
// Iterator thông thường: Item không gắn với lifetime của self
// Lending Iterator: Item có thể là reference vào self

trait LendingIterator {
    type Item<'this> where Self: 'this; // <-- GAT: Item parameterized by lifetime

    fn next<'this>(&'this mut self) -> Option<Self::Item<'this>>;
}

// Concrete impl: yields references into internal buffer
struct WindowSlider<'data> {
    data:   &'data [u8],
    pos:    usize,
    window: usize,
}

impl<'data> LendingIterator for WindowSlider<'data> {
    type Item<'this> = &'this [u8] where Self: 'this;

    fn next<'this>(&'this mut self) -> Option<&'this [u8]> {
        if self.pos + self.window > self.data.len() { return None; }
        let slice = &self.data[self.pos..self.pos + self.window];
        self.pos += 1;
        Some(slice)
    }
}

// ─── GAT: Generic Monad-like trait ───────────────────────────────────────
trait Functor {
    type Mapped<B>; // Associated type WITH type parameter — GAT

    fn fmap<A, B, F>(self, f: F) -> Self::Mapped<B>
    where
        F: FnOnce(A) -> B;
}

// ─── GAT: Repository trait with different return container per method ─────
trait AsyncRepository {
    type Entity;
    type Error;
    type FindAll<'a>: std::future::Future<Output = Result<Vec<Self::Entity>, Self::Error>> + 'a
    where
        Self: 'a;

    fn find_all<'a>(&'a self) -> Self::FindAll<'a>;
}

// This pattern allows zero-allocation futures as associated type
struct PostgresLoanRepo { pool: sqlx::PgPool }

impl AsyncRepository for PostgresLoanRepo {
    type Entity = Loan;
    type Error  = sqlx::Error;

    type FindAll<'a> = impl std::future::Future<Output = Result<Vec<Loan>, sqlx::Error>> + 'a;

    fn find_all<'a>(&'a self) -> Self::FindAll<'a> {
        async move {
            sqlx::query_as!(Loan, "SELECT * FROM loans")
                .fetch_all(&self.pool)
                .await
        }
    }
}
```

---

## 2. HRTB — Higher-Ranked Trait Bounds (`for<'a>`)

### Ý Nghĩa

```rust
// for<'a> F: Fn(&'a T) → U
// "F implements Fn for ALL lifetimes 'a"
// = F có thể nhận reference với bất kỳ lifetime nào

// Khác với:
// F: Fn(&'specific T) → U
// "F implements Fn for ONE specific lifetime"
```

### Prototype

```rust
// ─── HRTB: function works for any lifetime ────────────────────────────────
// Without HRTB — thường gặp khi store closure nhận reference

// ❌ Không work: lifetime 'a tied to specific lifetime
fn apply_to_each<'a, T, F>(items: &'a [T], f: F) -> Vec<String>
where
    F: Fn(&'a T) -> String,  // 'a fixed — f ONLY works with 'a references
{
    items.iter().map(|item| f(item)).collect()
}

// ✅ HRTB: f works for ANY reference lifetime
fn apply_to_each<T, F>(items: &[T], f: F) -> Vec<String>
where
    F: for<'a> Fn(&'a T) -> String,  // f works with ANY &T lifetime
{
    items.iter().map(|item| f(item)).collect()
}

let names = vec!["Alice", "Bob", "Charlie"];
let upper = apply_to_each(&names, |s| s.to_uppercase()); // ✅ compiles

// ─── HRTB in Trait Objects ────────────────────────────────────────────────
// Box<dyn for<'a> Fn(&'a str) -> bool>
// = closure that accepts &str of any lifetime

type Predicate = Box<dyn for<'a> Fn(&'a str) -> bool>;

fn make_predicate(min_len: usize) -> Predicate {
    Box::new(move |s: &str| s.len() >= min_len)
    // Works with any &str — doesn't capture specific lifetime
}

fn filter_strings<'s>(strings: &[&'s str], pred: &Predicate) -> Vec<&'s str> {
    strings.iter().copied().filter(|s| pred(s)).collect()
}

// ─── HRTB: callback stored in struct ────────────────────────────────────
struct EventHandler {
    // Store handler that works with any &Event lifetime
    callback: Box<dyn for<'a> Fn(&'a Event) -> Result<(), String>>,
}

impl EventHandler {
    pub fn new<F>(f: F) -> Self
    where
        F: for<'a> Fn(&'a Event) -> Result<(), String> + 'static,
    {
        EventHandler { callback: Box::new(f) }
    }

    pub fn handle(&self, event: &Event) -> Result<(), String> {
        (self.callback)(event)
    }
}

#[derive(Debug)]
struct Event { kind: String, payload: String }

fn main() {
    let handler = EventHandler::new(|e: &Event| {
        println!("Handling {:?}", e);
        Ok(())
    });

    let event = Event { kind: "loan_approved".into(), payload: "{}".into() };
    handler.handle(&event).unwrap();
}
```

---

## 3. Const Generics — Compile-Time Parameterization

### Ý Nghĩa

```rust
// Parameterize types by VALUE (constant), not just TYPE
// Vec<T> — parameterized by T (type)
// [T; N] — parameterized by N (const usize) — built-in const generic
// Matrix<T, const ROWS: usize, const COLS: usize> — custom
```

### Prototype

```rust
// ─── Fixed-size ring buffer ────────────────────────────────────────────────
struct RingBuffer<T, const N: usize> {
    data:  [Option<T>; N],
    head:  usize,
    tail:  usize,
    count: usize,
}

impl<T: Copy, const N: usize> RingBuffer<T, N> {
    pub fn new() -> Self {
        RingBuffer {
            data:  [None; N],  // const generic makes array size compile-time
            head:  0,
            tail:  0,
            count: 0,
        }
    }

    pub fn push(&mut self, val: T) -> bool {
        if self.count == N { return false; } // full
        self.data[self.tail] = Some(val);
        self.tail = (self.tail + 1) % N;
        self.count += 1;
        true
    }

    pub fn pop(&mut self) -> Option<T> {
        if self.count == 0 { return None; }
        let val = self.data[self.head].take();
        self.head = (self.head + 1) % N;
        self.count -= 1;
        val
    }

    pub fn is_full(&self)  -> bool { self.count == N }
    pub fn is_empty(&self) -> bool { self.count == 0 }
    pub fn capacity(&self) -> usize { N } // compile-time constant!
}

// Stack allocation — no heap!
let mut buf: RingBuffer<u32, 8> = RingBuffer::new(); // 8 slots on stack
let mut buf2: RingBuffer<u32, 1024> = RingBuffer::new(); // 1024 slots on stack

// ─── Type-safe matrix ─────────────────────────────────────────────────────
use std::ops::Mul;

#[derive(Debug, Clone, Copy)]
struct Matrix<T, const R: usize, const C: usize> {
    data: [[T; C]; R],
}

impl<T: Default + Copy, const R: usize, const C: usize> Matrix<T, R, C> {
    pub fn new() -> Self {
        Matrix { data: [[T::default(); C]; R] }
    }
    pub fn set(&mut self, r: usize, c: usize, val: T) { self.data[r][c] = val; }
    pub fn get(&self, r: usize, c: usize) -> T { self.data[r][c] }
}

// Matrix multiply: (R×K) * (K×C) = (R×C) — K must match at compile time!
impl<T, const R: usize, const K: usize, const C: usize> Mul<Matrix<T, K, C>> for Matrix<T, R, K>
where
    T: Default + Copy + std::ops::AddAssign + Mul<Output = T>,
{
    type Output = Matrix<T, R, C>;

    fn mul(self, rhs: Matrix<T, K, C>) -> Matrix<T, R, C> {
        let mut result = Matrix::new();
        for r in 0..R {
            for c in 0..C {
                for k in 0..K {
                    result.data[r][c] += self.data[r][k] * rhs.data[k][c];
                }
            }
        }
        result
    }
}

// Matrix<f64, 2, 3> * Matrix<f64, 3, 4> = Matrix<f64, 2, 4> — type-safe!
// Matrix<f64, 2, 3> * Matrix<f64, 4, 4> ← COMPILE ERROR: K mismatch

// ─── Const generic bounds ─────────────────────────────────────────────────
struct FixedStr<const N: usize> {
    data: [u8; N],
    len:  usize,
}

impl<const N: usize> FixedStr<N> {
    pub fn new(s: &str) -> Option<Self> {
        if s.len() > N { return None; }
        let mut data = [0u8; N];
        data[..s.len()].copy_from_slice(s.as_bytes());
        Some(FixedStr { data, len: s.len() })
    }
    pub fn as_str(&self) -> &str {
        std::str::from_utf8(&self.data[..self.len]).unwrap()
    }
}

// No heap: FixedStr<32> is 33 bytes on stack
let s = FixedStr::<32>::new("hello world").unwrap();
```

---

## 4. PhantomData Variance — Encode Type Relationships

### Variance: Covariant, Contravariant, Invariant

```
Covariant (T → U implies F<T> → F<U>):
  If Dog is Animal, then &Dog is &Animal — covariant in T
  PhantomData<T>, PhantomData<*const T>, PhantomData<fn() -> T>

Contravariant (T → U implies F<U> → F<T>):
  If Dog is Animal, then fn(Animal) is fn(Dog) — contravariant in T
  PhantomData<fn(T)>  (function input position)

Invariant (no subtyping):
  &mut T is invariant — cannot coerce &mut Dog to &mut Animal
  PhantomData<*mut T>, PhantomData<Cell<T>>
```

### Prototype: Variance Matters

```rust
use std::marker::PhantomData;

// ─── Producer<T>: produces T → should be COVARIANT in T ──────────────────
// (can use Producer<Dog> where Producer<Animal> expected)
struct Producer<T> {
    produce_fn: fn() -> T,
    _t: PhantomData<fn() -> T>,  // covariant: output position
}

// ─── Consumer<T>: consumes T → should be CONTRAVARIANT in T ──────────────
// (can use Consumer<Animal> where Consumer<Dog> expected)
struct Consumer<T> {
    consume_fn: fn(T),
    _t: PhantomData<fn(T)>,     // contravariant: input position
}

// ─── Invariant<T>: mut reference semantics ────────────────────────────────
struct Invariant<T> {
    value: T,
    _t:    PhantomData<*mut T>,  // invariant (like &mut T)
}

// ─── Practical: Cursor with lifetime + variance ────────────────────────────
struct Cursor<'buf, T> {
    ptr:  *const T,
    end:  *const T,
    _buf: PhantomData<&'buf [T]>,  // covariant in 'buf, covariant in T
}

impl<'buf, T> Cursor<'buf, T> {
    pub fn new(slice: &'buf [T]) -> Self {
        let ptr = slice.as_ptr();
        let end = unsafe { ptr.add(slice.len()) };
        Cursor { ptr, end, _buf: PhantomData }
    }

    pub fn next(&mut self) -> Option<&'buf T> {
        if self.ptr == self.end { return None; }
        let val = unsafe { &*self.ptr };
        self.ptr = unsafe { self.ptr.add(1) };
        Some(val)
    }
}

// Without PhantomData<&'buf [T]>, compiler can't verify cursor doesn't
// outlive the buffer — PhantomData encodes the "borrows from buffer" relationship
```

---

## 5. Advanced Typestate — Multi-Dimension State

### Typestate với nhiều Dimensions độc lập

```rust
// ─── Connection với 2 dimensions: Auth state × TLS state ─────────────────
use std::marker::PhantomData;

struct NoAuth;
struct Authenticated { user: String }
struct NoTls;
struct TlsEnabled;

struct Connection<Auth, Tls> {
    host:  String,
    port:  u16,
    _auth: PhantomData<Auth>,
    _tls:  PhantomData<Tls>,
}

// Initial state: NoAuth + NoTls
impl Connection<NoAuth, NoTls> {
    pub fn new(host: &str, port: u16) -> Self {
        Connection { host: host.into(), port, _auth: PhantomData, _tls: PhantomData }
    }
}

// Enable TLS (independent of auth state)
impl<Auth> Connection<Auth, NoTls> {
    pub fn with_tls(self) -> Connection<Auth, TlsEnabled> {
        println!("TLS enabled for {}:{}", self.host, self.port);
        Connection { host: self.host, port: self.port, _auth: PhantomData, _tls: PhantomData }
    }
}

// Authenticate (independent of TLS state)
impl<Tls> Connection<NoAuth, Tls> {
    pub fn authenticate(self, user: &str, _pass: &str) -> Connection<Authenticated, Tls> {
        println!("Authenticated as {}", user);
        Connection { host: self.host, port: self.port, _auth: PhantomData, _tls: PhantomData }
    }
}

// ONLY available when BOTH authenticated AND TLS enabled
impl Connection<Authenticated, TlsEnabled> {
    pub fn send_sensitive(&self, data: &[u8]) {
        println!("Sending {} bytes securely", data.len());
    }
}

// Available for any state — just get metadata
impl<A, T> Connection<A, T> {
    pub fn host(&self) -> &str { &self.host }
}

fn main() {
    let conn = Connection::<NoAuth, NoTls>::new("db.vpbank.internal", 5432);

    // Can chain in any order:
    let secure_conn = conn
        .with_tls()
        .authenticate("pdms_service", "secret");

    secure_conn.send_sensitive(b"sensitive data"); // ✅ only possible here

    // ❌ Compile errors:
    // Connection::new("host", 5432).send_sensitive(&[]); // not auth, not tls
    // Connection::new("host", 5432).with_tls().send_sensitive(&[]); // not auth
}
```

---

## 6. Type-Level Boolean — Compile-Time Feature Flags

```rust
// ─── Type-level true/false ────────────────────────────────────────────────
mod sealed { pub trait Bool {} }

pub struct True;
pub struct False;
impl sealed::Bool for True {}
impl sealed::Bool for False {}

pub trait Bool: sealed::Bool {
    const VALUE: bool;
}
impl Bool for True  { const VALUE: bool = true; }
impl Bool for False { const VALUE: bool = false; }

// Conditional behavior based on type-level flag
trait IfThen<B: Bool> {
    type Output;
}

// ─── Feature-flagged service ──────────────────────────────────────────────
struct Service<LoggingEnabled: Bool = False> {
    endpoint: String,
    _log: PhantomData<LoggingEnabled>,
}

impl Service<False> {
    pub fn new(endpoint: &str) -> Self {
        Service { endpoint: endpoint.into(), _log: PhantomData }
    }
    pub fn with_logging(self) -> Service<True> {
        Service { endpoint: self.endpoint, _log: PhantomData }
    }
}

// Generic method available to both:
impl<L: Bool> Service<L> {
    pub fn endpoint(&self) -> &str { &self.endpoint }
}

// Specific behavior for logging enabled:
impl Service<True> {
    pub fn request(&self, path: &str) -> String {
        println!("[LOG] GET {}{}", self.endpoint, path);
        format!("response from {}", path)
    }
}

impl Service<False> {
    pub fn request(&self, path: &str) -> String {
        format!("response from {}", path)
    }
}

fn main() {
    let svc = Service::new("https://api.example.com");
    let _ = svc.request("/health"); // no logging

    let logged_svc = Service::new("https://api.example.com").with_logging();
    let _ = logged_svc.request("/health"); // prints log
}
```

---

## Level 4 Checklist

```
□ GATs: biết khi nào associated type cần lifetime/type parameter
□ HRTB: hiểu for<'a> và khi nào cần (closures stored in structs)
□ Const generics: fixed-size collections, matrix math, compile-time N
□ PhantomData variance: output position = covariant, input = contravariant
□ Multi-dimension typestate: combine PhantomData dimensions
□ Có thể đọc complex trait bounds như:
    F: for<'a> Fn(&'a mut Vec<T>) -> impl Future<Output = Result<(), E>> + 'a
□ Type-level booleans cho compile-time feature flags
□ Hiểu why variance matters với &T vs &mut T vs *mut T
```

---

## 🔗 Links
- [[Design-Patterns-Rust/07-Level3-Architecture|← Level 3 · Architecture]]
- [[Design-Patterns-Rust/04-Rust-Idiomatic-Overview|Overview — All Levels]]
- [[Rust-Zero-To-Hero/Bai-5-Lifetimes|Bài 5: Lifetimes]]
- [[Rust-Zero-To-Hero/Bai-6-Generics-Traits-Advanced|Bài 6: Generics & Traits Advanced]]
- [[Rust-Zero-To-Hero/Bai-18-Type-System-Advanced|Bài 18: Type System Advanced]]

*Tags: #rust #patterns #level4 #gats #hrtb #const-generics #variance #typestate*
