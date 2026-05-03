# Level 1 · Foundation Patterns

> *Mục tiêu: Code không chỉ compile — mà đúng idiom. Đây là baseline mọi Rustacean cần thuần thục trước khi đụng đến advanced patterns.*

---

## 1. RAII / ScopeGuard — Ownership = Automatic Cleanup

### Tại Sao Quan Trọng

RAII (Resource Acquisition Is Initialization) không phải concept mới — C++ đã có. Nhưng Rust làm nó **compiler-enforced** thay vì programmer-discipline. Không có cách nào quên cleanup vì Drop chạy tự động khi scope kết thúc.

```
┌──────────────────────────────────────────────────────┐
│  Scope starts → resource acquired                    │
│  ...code...                                          │
│  Scope ends → Drop::drop() called AUTOMATICALLY      │
│    → file closed, lock released, connection returned │
└──────────────────────────────────────────────────────┘
Không thể bypass — ngay cả khi panic, return sớm, ?
```

### Prototype: Custom Drop Guard

```rust
use std::sync::{Arc, Mutex};
use std::time::Instant;

// ─── Ví dụ 1: Timer Guard ─────────────────────────────────────────────────
struct TimerGuard {
    label: &'static str,
    start: Instant,
}

impl TimerGuard {
    pub fn new(label: &'static str) -> Self {
        println!("[TIMER] '{}' started", label);
        TimerGuard { label, start: Instant::now() }
    }
}

impl Drop for TimerGuard {
    fn drop(&mut self) {
        println!("[TIMER] '{}' elapsed: {:?}", self.label, self.start.elapsed());
    }
}

// ─── Ví dụ 2: Database Transaction Guard ────────────────────────────────
struct Transaction<'a> {
    db:        &'a mut FakeDb,
    committed: bool,
}

struct FakeDb { log: Vec<String> }

impl<'a> Transaction<'a> {
    pub fn begin(db: &'a mut FakeDb) -> Self {
        db.log.push("BEGIN".into());
        Transaction { db, committed: false }
    }

    pub fn execute(&mut self, sql: &str) {
        self.db.log.push(format!("EXEC: {}", sql));
    }

    pub fn commit(mut self) {  // moves self → drops at end of this fn
        self.db.log.push("COMMIT".into());
        self.committed = true; // prevent rollback in drop
    }
}

impl<'a> Drop for Transaction<'a> {
    fn drop(&mut self) {
        if !self.committed {
            self.db.log.push("ROLLBACK".into()); // auto rollback!
            println!("[TX] Rolled back — not committed");
        }
    }
}

fn main() {
    let _timer = TimerGuard::new("process_loan"); // starts measuring

    let mut db = FakeDb { log: vec![] };
    {
        let mut tx = Transaction::begin(&mut db);
        tx.execute("INSERT INTO loans ...");
        tx.execute("UPDATE balance ...");
        // tx.commit();  // ← nếu bỏ comment này → commit
        // Không commit → drop → auto ROLLBACK
    }
    println!("DB log: {:?}", db.log);
    // ["BEGIN", "EXEC: INSERT...", "EXEC: UPDATE...", "ROLLBACK"]

    // _timer dropped ở đây → prints elapsed time
}
```

```rust
// ─── Ví dụ 3: ScopeGuard pattern (manual với closure) ─────────────────────
// Dùng khi Drop logic quá đơn giản để tạo struct

struct ScopeGuard<F: FnOnce()> {
    f: Option<F>,
}

impl<F: FnOnce()> ScopeGuard<F> {
    pub fn new(f: F) -> Self { ScopeGuard { f: Some(f) } }
    pub fn disarm(mut self) { self.f = None; } // cancel cleanup
}

impl<F: FnOnce()> Drop for ScopeGuard<F> {
    fn drop(&mut self) {
        if let Some(f) = self.f.take() { f(); }
    }
}

macro_rules! defer {
    ($expr:expr) => {
        let _guard = ScopeGuard::new(|| { $expr; });
    };
}

fn process_file(path: &str) -> Result<(), String> {
    let file = open_file(path)?;
    defer!(println!("File '{}' closed", path)); // runs on exit, even on error

    do_work(&file)?;
    // ← defer fires here
    Ok(())
}
// Dùng scopeguard crate trong production: `scopeguard::defer!`
```

### ✅ Key Takeaways
```
✓ Implement Drop khi resource cần explicit cleanup
✓ Bất kỳ return/panic/? → Drop vẫn chạy
✓ Nếu không muốn drop: std::mem::forget(val) (rare, unsafe territory)
✓ Drop order: local variables dropped in REVERSE declaration order
```

---

## 2. Newtype — Type Safety Without Runtime Cost

### Tại Sao Cần Newtype

```rust
// ❌ Stringly-typed / int-typed — dễ nhầm parameter
fn transfer(from_account: u64, to_account: u64, amount: u64) { ... }
transfer(recipient_id, sender_id, 1000); // oops! params swapped — compiles fine!

// ✅ Newtype: compiler catches swap
struct AccountId(u64);
struct Amount(u64);
fn transfer(from: AccountId, to: AccountId, amount: Amount) { ... }
// transfer(recipient, sender, Amount(1000)) ← đúng thứ tự, hoặc compile error
```

### Prototype: Newtype Gallery

```rust
// ─── Basic Newtype ─────────────────────────────────────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct UserId(u64);

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
struct Meters(f64);

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
struct Kilograms(f64);

// Type safety: không thể mix meters và kilograms
fn speed(distance: Meters, time_s: f64) -> f64 {
    distance.0 / time_s
}
// speed(Kilograms(70.0), 10.0) ← compile error: mismatched types

// ─── Newtype với custom operations ────────────────────────────────────────
use std::ops::{Add, Sub, Mul};

impl Add for Meters {
    type Output = Meters;
    fn add(self, rhs: Meters) -> Meters { Meters(self.0 + rhs.0) }
}
impl Sub for Meters {
    type Output = Meters;
    fn sub(self, rhs: Meters) -> Meters { Meters(self.0 - rhs.0) }
}
impl Mul<f64> for Meters {
    type Output = Meters;
    fn mul(self, scalar: f64) -> Meters { Meters(self.0 * scalar) }
}

// ─── Newtype để implement foreign trait ───────────────────────────────────
// Orphan rule: không thể impl Display cho Vec<String> (cả hai foreign)
use std::fmt;
struct CommaSeparated(Vec<String>);

impl fmt::Display for CommaSeparated {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}", self.0.join(", "))
    }
}

// ─── Zero-overhead: Newtype is just compile-time wrapper ──────────────────
// size_of::<UserId>() == size_of::<u64>() == 8 bytes
// No vtable, no boxing, no runtime overhead

// ─── Deref để access inner value ──────────────────────────────────────────
use std::ops::Deref;

struct Validated<T>(T); // invariant: T has been validated

impl<T> Deref for Validated<T> {
    type Target = T;
    fn deref(&self) -> &T { &self.0 }
}

impl Validated<String> {
    pub fn new(s: String) -> Result<Self, &'static str> {
        if s.is_empty() { Err("cannot be empty") }
        else { Ok(Validated(s)) }
    }
}

let name = Validated::new("Bach".into()).unwrap();
let len = name.len(); // Deref → calls String::len() transparently
```

---

## 3. Result & Option Chaining — Monadic Error Handling

### Mental Model: Railway-Oriented Programming

```
Happy path:  Ok(val1) ──map──▶ Ok(val2) ──and_then──▶ Ok(val3) ──▶ result
Error path:  Ok(val1) ──map──▶ Err(e)   ─────────────────────────▶ Err(e)
                                         (skips remaining steps)
```

### Prototype: Full Error Chain

```rust
use std::num::ParseIntError;

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("parse error: {0}")]
    Parse(#[from] ParseIntError),
    #[error("value {0} out of range [1, 100]")]
    OutOfRange(i32),
    #[error("database error: {0}")]
    Database(String),
}

// ─── The ? operator ────────────────────────────────────────────────────────
// Desugars to: match result { Ok(v) => v, Err(e) => return Err(e.into()) }
fn parse_age(s: &str) -> Result<i32, AppError> {
    let n: i32 = s.parse()?;        // ParseIntError → AppError::Parse via From
    if n < 1 || n > 100 {
        return Err(AppError::OutOfRange(n));
    }
    Ok(n)
}

// ─── Combinators ──────────────────────────────────────────────────────────
fn process_age(input: &str) -> String {
    input.trim()
         .parse::<i32>()
         .map_err(|_| "not a number")           // transform error
         .and_then(|n| {                          // chain on success
             if n > 0 { Ok(n) } else { Err("must be positive") }
         })
         .map(|n| format!("Age: {}", n))         // transform success
         .unwrap_or_else(|e| format!("Error: {}", e)) // fallback
}

// ─── Option combinators ────────────────────────────────────────────────────
fn find_user_email(db: &Db, user_id: u64) -> Option<String> {
    db.find_user(user_id)           // Option<User>
      .filter(|u| u.is_active)      // None if not active
      .map(|u| u.email.clone())     // Option<String>
      .filter(|e| !e.is_empty())    // None if empty email
}

// ─── ok_or / ok_or_else: Option → Result ─────────────────────────────────
fn get_config(key: &str) -> Result<String, AppError> {
    std::env::var(key)                           // Result<String, VarError>
        .ok()                                    // Option<String>
        .ok_or_else(|| AppError::Database(       // Option → Result
            format!("env var {} not set", key)
        ))
}

// ─── Collecting Results ────────────────────────────────────────────────────
fn parse_all(inputs: &[&str]) -> Result<Vec<i32>, AppError> {
    // Stop at first error:
    inputs.iter()
          .map(|s| s.parse::<i32>().map_err(AppError::from))
          .collect::<Result<Vec<i32>, _>>()  // fails fast on first Err
}

fn parse_all_best_effort(inputs: &[&str]) -> (Vec<i32>, Vec<String>) {
    inputs.iter()
          .map(|s| s.parse::<i32>())
          .partition_map(|r| match r {        // from itertools
              Ok(n)  => itertools::Either::Left(n),
              Err(e) => itertools::Either::Right(e.to_string()),
          })
}

// ─── ? trong main ─────────────────────────────────────────────────────────
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let age = parse_age("25")?;
    println!("Parsed age: {}", age);
    Ok(())
}
```

---

## 4. From / Into — Ergonomic Conversion

### Rules

```
impl From<A> for B → compiler auto-generates impl Into<A> for B
→ Chỉ implement From, không cần implement Into
→ ? operator dùng From để convert errors: Err(e.into())
```

### Prototype

```rust
// ─── Domain: VPBank Error conversions ─────────────────────────────────────
#[derive(Debug, thiserror::Error)]
enum PdmsError {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),                // #[from] = impl From<sqlx::Error>

    #[error("not found: {0}")]
    NotFound(String),

    #[error("validation: {0}")]
    Validation(String),
}

// ─── Custom From implementations ──────────────────────────────────────────
#[derive(Debug)]
struct Email(String);

impl TryFrom<String> for Email {       // fallible conversion
    type Error = &'static str;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        if s.contains('@') { Ok(Email(s)) }
        else { Err("invalid email: missing @") }
    }
}

let email: Result<Email, _> = "user@example.com".to_string().try_into();

// ─── From for ergonomic API ────────────────────────────────────────────────
#[derive(Debug)]
struct Color { r: u8, g: u8, b: u8 }

impl From<(u8, u8, u8)> for Color {
    fn from((r, g, b): (u8, u8, u8)) -> Color { Color { r, g, b } }
}
impl From<u32> for Color {
    fn from(hex: u32) -> Color {
        Color {
            r: ((hex >> 16) & 0xFF) as u8,
            g: ((hex >> 8)  & 0xFF) as u8,
            b: (hex         & 0xFF) as u8,
        }
    }
}

fn set_background(color: impl Into<Color>) {
    let c = color.into(); // accept anything: tuple, u32, Color
    println!("Background: rgb({}, {}, {})", c.r, c.g, c.b);
}

set_background((255u8, 128, 0));   // from tuple
set_background(0xFF8000u32);       // from hex
set_background(Color { r: 255, g: 128, b: 0 }); // from Color directly
```

---

## 5. impl Trait Return — Opaque Types

### Tại Sao Dùng

```rust
// Vấn đề: Iterator adapters có type cực phức tạp
// Map<Filter<std::slice::Iter<'_, i32>, {closure}>, {closure}>
// Không thể viết tường minh — dùng impl Trait!

// ✅ Return "something that is Iterator<Item = i32>", hide concrete type
fn even_squares(v: &[i32]) -> impl Iterator<Item = i32> + '_ {
    v.iter()
     .filter(|&&x| x % 2 == 0)
     .map(|&x| x * x)
    // Compiler infers the exact type — caller chỉ thấy Iterator interface
}

// ─── impl Trait vs Box<dyn Trait> ─────────────────────────────────────────
// impl Trait: zero-cost, compile-time, single concrete type
// Box<dyn>:   heap alloc, runtime dispatch, can vary type per call

// impl Trait: caller không thể store result chung nếu fn gọi nhiều lần
//             vì mỗi call site tạo ra concrete type khác nhau
fn make_adder(n: i32) -> impl Fn(i32) -> i32 {
    move |x| x + n  // returns closure — type hidden, zero-cost
}

let add5  = make_adder(5);
let add10 = make_adder(10);
// add5 và add10 CÓ THỂ different types! (two closures = two types)
// Cannot store in Vec<impl Fn(i32)->i32> — dùng Vec<Box<dyn Fn(i32)->i32>>

// ─── Return Position impl Trait trong trait (RPITIT, Rust 1.75+) ──────────
trait Transformer {
    fn transform(&self, data: &[u8]) -> impl Iterator<Item = u8>; // ✅ Rust 1.75+
}
```

---

## 6. Derive Macros — DRY Với Compile-Time Code Gen

```rust
// ─── Common derives và khi nào dùng ──────────────────────────────────────
#[derive(
    Debug,        // {:?} formatting — luôn derive cho dev/test
    Clone,        // explicit copy — derive nếu tất cả fields Clone
    PartialEq,    // == operator — cần để test assertions
    Eq,           // == is total (no NaN etc) — derive nếu PartialEq
    Hash,         // dùng trong HashMap key
    PartialOrd,   // < > operators (partial: NaN unordered)
    Ord,          // total ordering — cần để sort
    Default,      // Default::default() → zero values
    serde::Serialize,    // JSON serialize
    serde::Deserialize,  // JSON deserialize
)]
struct LoanRecord {
    id:     u64,
    amount: u64,
    status: String,
}

// ─── Custom Default ────────────────────────────────────────────────────────
#[derive(Debug)]
struct AppConfig {
    host:    String,
    port:    u16,
    workers: usize,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            host:    "127.0.0.1".into(),
            port:    8080,
            workers: num_cpus::get(),
        }
    }
}

// Pattern: Config override từ env
let config = AppConfig {
    port: std::env::var("PORT")
              .ok()
              .and_then(|p| p.parse().ok())
              .unwrap_or(8080),
    ..AppConfig::default()  // fill rest with defaults
};
```

---

## Level 1 Checklist

```
□ Implement Drop để cleanup resources — không dùng manual drop() calls
□ Newtype cho mọi domain primitive (ID, Amount, Email...)
□ Không có unwrap() trong production — luôn ? hoặc proper error handling
□ Result chains: map / and_then / ok_or / collect::<Result<Vec<_>,_>>()
□ impl From<E> cho error types thay vì manual conversion
□ impl Trait return thay vì viết type phức tạp hoặc Box<dyn>
□ #[derive] trước khi implement manually
□ Đọc được: "error[E0502]: cannot borrow `x` as mutable because it is also borrowed as immutable"
```

---

## 🔗 Links
- [[Design-Patterns-Rust/04-Rust-Idiomatic-Overview|Overview — All Levels]]
- [[Design-Patterns-Rust/06-Level2-Idiomatic|Level 2 · Idiomatic →]]

*Tags: #rust #patterns #level1 #foundations #raii #newtype*
