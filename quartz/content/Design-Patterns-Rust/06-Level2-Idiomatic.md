# Level 2 · Idiomatic Patterns

> *"Code compiles" → "Code is Rusty". Level này là sự khác biệt giữa developer viết Java-with-Rust-syntax và Rustacean thực thụ. Mỗi pattern ở đây giải quyết friction phổ biến khi làm việc với ownership + type system.*

---

## 1. Extension Trait — Add Methods to Foreign Types

### Vấn Đề

Orphan rule: Không thể impl `ForeignTrait` cho `ForeignType`. Nhưng đôi khi cần add method tiện lợi vào type từ thư viện khác.

### Pattern

```rust
// ─── Define extension trait với default impl ──────────────────────────────
// "Trait bổ trợ" — chứa methods ta muốn add

trait StrExt {
    fn to_snake_case(&self) -> String;
    fn truncate_with_ellipsis(&self, max_len: usize) -> String;
    fn is_valid_cif(&self) -> bool;
}

impl StrExt for str {  // impl cho &str (primitive) ← OK vì StrExt là OUR trait
    fn to_snake_case(&self) -> String {
        self.chars().enumerate().fold(String::new(), |mut acc, (i, c)| {
            if c.is_uppercase() && i > 0 { acc.push('_'); }
            acc.push(c.to_ascii_lowercase());
            acc
        })
    }

    fn truncate_with_ellipsis(&self, max_len: usize) -> String {
        if self.len() <= max_len { return self.to_string(); }
        format!("{}…", &self[..max_len.saturating_sub(1)])
    }

    fn is_valid_cif(&self) -> bool {
        self.len() >= 7 && self.chars().all(|c| c.is_alphanumeric())
    }
}

// Usage — gọi như method tự nhiên trên &str
fn main() {
    println!("{}", "CamelCaseString".to_snake_case()); // camel_case_string
    println!("{}", "Hello World".truncate_with_ellipsis(8)); // Hello W…
    println!("{}", "CIF00142".is_valid_cif()); // true
}
```

```rust
// ─── Extension Trait cho Result/Option ────────────────────────────────────
trait ResultExt<T> {
    fn log_err(self, context: &str) -> Self;
    fn or_default_log(self, default: T, context: &str) -> T where T: std::fmt::Debug;
}

impl<T, E: std::fmt::Display> ResultExt<T> for Result<T, E> {
    fn log_err(self, context: &str) -> Self {
        if let Err(ref e) = self {
            eprintln!("[ERROR] {}: {}", context, e);
        }
        self
    }

    fn or_default_log(self, default: T, context: &str) -> T where T: std::fmt::Debug {
        self.unwrap_or_else(|e| {
            eprintln!("[WARN] {}: {} — using default", context, e);
            default
        })
    }
}

// Usage:
let config = load_config("config.toml")
    .log_err("Failed to load config")
    .or_default_log(Config::default(), "Using defaults");
```

```rust
// ─── Extension cho Iterator ────────────────────────────────────────────────
trait IterExt: Iterator + Sized {
    // Chunk iterator into Vec<Vec<T>> by size
    fn chunks_vec(self, size: usize) -> Vec<Vec<Self::Item>> {
        let mut result = vec![];
        let mut chunk  = vec![];
        for item in self {
            chunk.push(item);
            if chunk.len() == size {
                result.push(std::mem::take(&mut chunk));
            }
        }
        if !chunk.is_empty() { result.push(chunk); }
        result
    }
}
impl<I: Iterator> IterExt for I {}  // Blanket impl — available on ALL iterators

let batches = (0..10).chunks_vec(3);
// [[0,1,2], [3,4,5], [6,7,8], [9]]
```

---

## 2. Interior Mutability — Controlled Shared Mutation

### Bốn Tools Và Khi Nào Dùng

```
Cell<T>:     single-threaded, Copy types, no borrowing, just get/set
RefCell<T>:  single-threaded, runtime borrow check, dynamic dispatch
Mutex<T>:    multi-threaded, blocking lock, exclusive access
RwLock<T>:   multi-threaded, many readers OR one writer
```

### Prototype: Chọn Đúng Tool

```rust
use std::cell::{Cell, RefCell};
use std::sync::{Arc, Mutex, RwLock};

// ─── Cell<T>: Copy types, NO references to inner value ────────────────────
struct Widget {
    label:      String,
    click_count: Cell<u32>,  // mutable through &self
}

impl Widget {
    pub fn on_click(&self) {                    // &self (not &mut self!)
        self.click_count.set(self.click_count.get() + 1);
        println!("Clicked {} times", self.click_count.get());
    }
}

// ─── RefCell<T>: dynamic borrow, panics on double-mut-borrow ──────────────
struct Config {
    data:  RefCell<std::collections::HashMap<String, String>>,
    dirty: Cell<bool>,
}

impl Config {
    pub fn set(&self, key: &str, val: &str) {
        self.data.borrow_mut().insert(key.into(), val.into()); // runtime check
        self.dirty.set(true);
    }
    pub fn get(&self, key: &str) -> Option<String> {
        self.data.borrow().get(key).cloned()  // immutable borrow
    }
}

// ─── RefCell trong Rc — shared ownership + mutation ───────────────────────
use std::rc::Rc;
type SharedNode = Rc<RefCell<TreeNode>>;

struct TreeNode {
    value:    i32,
    children: Vec<SharedNode>,
}

fn add_child(parent: &SharedNode, child: SharedNode) {
    parent.borrow_mut().children.push(child);
}

// ─── Arc<Mutex<T>>: the workhorse for async/multi-thread ──────────────────
#[derive(Clone)]
struct AppState {
    cache: Arc<Mutex<std::collections::HashMap<String, Vec<u8>>>>,
    stats: Arc<RwLock<Stats>>,
}

#[derive(Default)]
struct Stats { requests: u64, errors: u64 }

impl AppState {
    pub fn cache_get(&self, key: &str) -> Option<Vec<u8>> {
        self.cache.lock().unwrap().get(key).cloned()
    }
    pub fn cache_set(&self, key: String, val: Vec<u8>) {
        self.cache.lock().unwrap().insert(key, val);
    }
    pub fn record_request(&self) {
        self.stats.write().unwrap().requests += 1;  // exclusive
    }
    pub fn get_stats(&self) -> (u64, u64) {
        let s = self.stats.read().unwrap();          // shared
        (s.requests, s.errors)
    }
}
```

```rust
// ─── DANGER: RefCell panic patterns ──────────────────────────────────────
let v = RefCell::new(vec![1, 2, 3]);
let borrow1 = v.borrow();         // OK: shared borrow
// let borrow2 = v.borrow_mut(); // ← PANIC at runtime! already borrowed

// ─── SAFE pattern: limit borrow scope ────────────────────────────────────
{
    let sum: i32 = v.borrow().iter().sum(); // borrow + drop in same scope
} // borrow dropped here
let mut m = v.borrow_mut(); // OK now
m.push(4);
```

---

## 3. Cow<'a, T> — Clone On Write

### Mental Model

```
Cow = smart pointer với 2 modes:
  Borrowed(&'a T):  zero-copy, borrow from somewhere
  Owned(T):         owns data, can modify

Decision delayed to runtime:
  "Nếu không cần modify → return reference (zero alloc)
   Nếu cần modify → clone on first write, then modify"
```

### Prototype: Các Use Cases Thực Tế

```rust
use std::borrow::Cow;

// ─── Use case 1: Optional transformation ──────────────────────────────────
fn normalize_name<'a>(input: &'a str) -> Cow<'a, str> {
    let trimmed = input.trim();
    if trimmed == input && !input.chars().any(|c| c.is_uppercase()) {
        Cow::Borrowed(input)      // already normalized — zero alloc
    } else {
        Cow::Owned(trimmed.to_lowercase()) // needs modification — 1 alloc
    }
}

println!("{}", normalize_name("  Bach "));    // Owned("bach")
println!("{}", normalize_name("bach"));       // Borrowed("bach") — no alloc!

// ─── Use case 2: Config with defaults ────────────────────────────────────
struct AppConfig<'a> {
    app_name:    Cow<'a, str>,
    description: Cow<'a, str>,
    max_retries: u32,
}

impl<'a> AppConfig<'a> {
    pub fn new(name: &'a str) -> Self {
        AppConfig {
            app_name:    Cow::Borrowed(name),
            description: Cow::Borrowed("No description"),  // static default
            max_retries: 3,
        }
    }

    // Customize — only allocates if actually customized
    pub fn with_description(mut self, desc: impl Into<Cow<'a, str>>) -> Self {
        self.description = desc.into();
        self
    }
}

// ─── Use case 3: API that accepts both &str and String ───────────────────
// Instead of two overloads, accept Cow<str>
fn save_record(data: Cow<str>) {
    println!("Saving: {}", data);
}

save_record(Cow::Borrowed("static string"));   // no alloc
save_record(Cow::Owned(format!("dynamic {}", 42))); // from owned

// Or via Into<Cow<str>>:
fn save<'a>(data: impl Into<Cow<'a, str>>) {
    let cow = data.into();
    println!("Saving: {}", cow);
}
save("literal");          // Borrowed
save("dynamic".to_string()); // Owned
```

---

## 4. Parse, Don't Validate — Make Invalid States Unrepresentable

### The Pattern

```
❌ Validate then use:
   fn process(email: &str) {
       assert!(is_valid_email(email)); // runtime check — can forget
       ...
   }

✅ Parse into type that CANNOT be invalid:
   fn process(email: Email) { // already valid — type guarantees it
       ...
   }
```

### Prototype: Smart Constructors

```rust
// ─── Email — invalid email impossible to represent ────────────────────────
#[derive(Debug, Clone, PartialEq)]
pub struct Email(String);  // private field!

impl Email {
    pub fn new(raw: impl Into<String>) -> Result<Self, EmailError> {
        let s = raw.into();
        let s = s.trim().to_lowercase();
        if !s.contains('@') {
            return Err(EmailError::MissingAtSign);
        }
        let parts: Vec<&str> = s.splitn(2, '@').collect();
        if parts[0].is_empty() {
            return Err(EmailError::EmptyLocalPart);
        }
        if !parts[1].contains('.') {
            return Err(EmailError::InvalidDomain);
        }
        Ok(Email(s))
    }

    // Only way to get inner value: controlled access
    pub fn as_str(&self) -> &str { &self.0 }
    pub fn domain(&self) -> &str {
        self.0.split('@').nth(1).unwrap() // safe: guaranteed by constructor
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EmailError {
    #[error("missing @ sign")]
    MissingAtSign,
    #[error("empty local part")]
    EmptyLocalPart,
    #[error("invalid domain")]
    InvalidDomain,
}

// ─── NonEmpty<T> — generic non-empty collection ───────────────────────────
#[derive(Debug, Clone)]
pub struct NonEmpty<T>(Vec<T>);

impl<T> NonEmpty<T> {
    pub fn new(first: T, rest: Vec<T>) -> Self {
        let mut v = vec![first];
        v.extend(rest);
        NonEmpty(v)
    }

    pub fn from_vec(v: Vec<T>) -> Option<Self> {
        if v.is_empty() { None } else { Some(NonEmpty(v)) }
    }

    pub fn first(&self) -> &T { &self.0[0] }  // SAFE: cannot be empty
    pub fn len(&self) -> usize { self.0.len() } // always >= 1
    pub fn iter(&self) -> impl Iterator<Item = &T> { self.0.iter() }
}

// ─── Bounded integer ──────────────────────────────────────────────────────
#[derive(Debug, Clone, Copy)]
pub struct Percentage(u8); // invariant: 0 <= value <= 100

impl Percentage {
    pub fn new(value: u8) -> Result<Self, &'static str> {
        if value > 100 { Err("percentage must be 0-100") }
        else { Ok(Percentage(value)) }
    }
    pub fn value(self) -> u8 { self.0 }
    pub fn as_fraction(self) -> f64 { self.0 as f64 / 100.0 }
}

// ─── Usage: validation happens once, at boundary ──────────────────────────
fn apply_discount(price: u64, discount: Percentage) -> u64 {
    price - (price as f64 * discount.as_fraction()) as u64
    // No need to validate discount — type guarantees it's 0-100
}
```

---

## 5. Sealed Trait — Control Who Can Implement

### Vấn Đề

Đôi khi cần trait là "closed" — chỉ cho phép specific types implement. Ví dụ: database driver trait chỉ library implement, không cho user extend.

### Pattern: Private Supertrait

```rust
// ─── Sealed trait pattern ─────────────────────────────────────────────────
mod private {
    // Private module — không ai ngoài crate biết sealed::Sealed
    pub trait Sealed {}
}

// DatabaseBackend: chỉ types impl Sealed mới có thể impl DatabaseBackend
// Sealed là private → external code không thể impl Sealed → không impl DatabaseBackend
pub trait DatabaseBackend: private::Sealed {
    fn connect(&self, url: &str) -> Result<Connection, DbError>;
    fn execute(&self, sql: &str) -> Result<u64, DbError>;
}

pub struct PostgresBackend;
pub struct SqliteBackend;

// Chúng ta implement Sealed cho chính mình:
impl private::Sealed for PostgresBackend {}
impl private::Sealed for SqliteBackend {}

impl DatabaseBackend for PostgresBackend {
    fn connect(&self, url: &str) -> Result<Connection, DbError> { todo!() }
    fn execute(&self, sql: &str) -> Result<u64, DbError> { todo!() }
}
impl DatabaseBackend for SqliteBackend {
    fn connect(&self, url: &str) -> Result<Connection, DbError> { todo!() }
    fn execute(&self, sql: &str) -> Result<u64, DbError> { todo!() }
}

// External code (outside crate):
// struct MyCustomDb;
// impl crate::private::Sealed for MyCustomDb {} ← compile error: module private
// impl DatabaseBackend for MyCustomDb {}         ← compile error: Sealed not impl
```

```rust
// ─── Sealed trait cho type family ────────────────────────────────────────
// Pattern: chỉ cho phép specific variants trong generic

mod sealed { pub trait SqlType {} }

pub trait SqlType: sealed::SqlType {
    fn sql_name() -> &'static str;
}

pub struct VarChar<const N: usize>;
pub struct Integer;
pub struct Boolean;

impl sealed::SqlType for VarChar<255> {}
impl sealed::SqlType for Integer {}
impl sealed::SqlType for Boolean {}

impl<const N: usize> SqlType for VarChar<N> {
    fn sql_name() -> &'static str { "VARCHAR" }
}
impl SqlType for Integer { fn sql_name() -> &'static str { "INTEGER" } }
impl SqlType for Boolean { fn sql_name() -> &'static str { "BOOLEAN" } }
```

---

## 6. Newtype Index — Type-Safe IDs

### Tại Sao Cần

```rust
// ❌ u64 IDs everywhere — easy to mix up
fn transfer(from_user: u64, to_user: u64, loan_id: u64, amount: u64) { ... }
// transfer(loan_id, user_id, account_id, 1000) ← compile OK, logic wrong!

// ✅ Newtype IDs — distinct types
fn transfer(from: UserId, to: UserId, loan: LoanId, amount: MoneyVnd) { ... }
// transfer(loan_id, user_id, account_id, ...) ← COMPILE ERROR
```

### Pattern: ID Type với Common Derives

```rust
use std::fmt;

// ─── Macro để generate ID types (DRY) ────────────────────────────────────
macro_rules! newtype_id {
    ($name:ident, $inner:ty) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name($inner);

        impl $name {
            pub fn new(v: $inner) -> Self { $name(v) }
            pub fn value(self) -> $inner { self.0 }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
                write!(f, "{}", self.0)
            }
        }

        impl From<$inner> for $name {
            fn from(v: $inner) -> Self { $name(v) }
        }

        // serde support if needed:
        // impl serde::Serialize for $name { ... }
    };
}

newtype_id!(UserId,     u64);
newtype_id!(LoanId,     u64);
newtype_id!(AccountId,  u64);
newtype_id!(DocumentId, u64);

#[derive(Debug, Clone, Copy)]
struct MoneyVnd(i64); // signed for transactions

impl MoneyVnd {
    pub fn from_vnd(amount: i64) -> Self { MoneyVnd(amount) }
    pub fn vnd(self) -> i64 { self.0 }
}

// ─── Type-safe database queries ───────────────────────────────────────────
struct LoanRepository;

impl LoanRepository {
    // Cannot accidentally pass UserId where LoanId expected:
    pub async fn find(&self, id: LoanId) -> Option<Loan> { todo!() }
    pub async fn find_by_user(&self, user: UserId) -> Vec<Loan> { todo!() }

    // Vec indexed by position — prevent "off by 1 index" in wrong collection
    pub fn bulk_update(&self, ids: &[LoanId]) { todo!() }
}

struct Loan { id: LoanId, user_id: UserId, amount: MoneyVnd }
```

---

## 7. Fallible Builder (with Validation)

### Pattern: Validator tích hợp vào build()

```rust
// ─── HTTP Client Builder với validation ───────────────────────────────────
#[derive(Debug)]
pub struct HttpClientConfig {
    base_url:    String,
    timeout_ms:  u64,
    max_retries: u8,
    api_key:     String,
}

#[derive(Debug, Default)]
pub struct HttpClientBuilder {
    base_url:    Option<String>,
    timeout_ms:  Option<u64>,
    max_retries: Option<u8>,
    api_key:     Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    #[error("base_url is required")]
    MissingBaseUrl,
    #[error("api_key is required")]
    MissingApiKey,
    #[error("base_url must start with https://: got '{0}'")]
    InsecureUrl(String),
    #[error("timeout must be 100-30000ms, got {0}")]
    InvalidTimeout(u64),
}

impl HttpClientBuilder {
    pub fn new() -> Self { Default::default() }

    pub fn base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = Some(url.into()); self
    }
    pub fn timeout_ms(mut self, ms: u64) -> Self {
        self.timeout_ms = Some(ms); self
    }
    pub fn max_retries(mut self, n: u8) -> Self {
        self.max_retries = Some(n); self
    }
    pub fn api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = Some(key.into()); self
    }

    pub fn build(self) -> Result<HttpClientConfig, BuildError> {
        let base_url = self.base_url.ok_or(BuildError::MissingBaseUrl)?;
        let api_key  = self.api_key.ok_or(BuildError::MissingApiKey)?;

        if !base_url.starts_with("https://") {
            return Err(BuildError::InsecureUrl(base_url));
        }

        let timeout_ms = self.timeout_ms.unwrap_or(5000);
        if !(100..=30_000).contains(&timeout_ms) {
            return Err(BuildError::InvalidTimeout(timeout_ms));
        }

        Ok(HttpClientConfig {
            base_url,
            timeout_ms,
            max_retries: self.max_retries.unwrap_or(3),
            api_key,
        })
    }
}

fn main() -> Result<(), BuildError> {
    let config = HttpClientBuilder::new()
        .base_url("https://api.vpbank.com")
        .api_key("sk_live_xxx")
        .timeout_ms(10_000)
        .build()?;

    println!("{:#?}", config);
    Ok(())
}
```

---

## Level 2 Checklist

```
□ Extension trait để add methods vào foreign types (không dùng free functions)
□ Chọn đúng interior mutability: Cell (Copy) / RefCell (single-thread) / Mutex (multi)
□ Cow<str> khi function output có thể borrowed hoặc owned
□ Smart constructor cho tất cả domain types có invariants
□ Sealed trait khi cần close a trait family
□ Newtype IDs cho mọi domain ID type — không raw u64/String làm IDs
□ Builder build() trả về Result<T, E> với validation
□ Biết khi nào dyn Trait vs impl Trait (dyn = runtime vary, impl = static)
```

---

## 🔗 Links
- [[Design-Patterns-Rust/05-Level1-Foundations|← Level 1 · Foundations]]
- [[Design-Patterns-Rust/07-Level3-Architecture|Level 3 · Architecture →]]

*Tags: #rust #patterns #level2 #idiomatic #cow #interior-mutability*
