# Creational Patterns in Rust

> *Creational patterns giải quyết vấn đề "tạo object như thế nào". Trong Rust, ownership model thay đổi căn bản cách tiếp cận — không có `new` keyword, không có constructor, không có garbage collector.*

---

## 1. Singleton — `OnceLock<T>`

### Intent
Đảm bảo chỉ có **một instance** duy nhất, global access point.

### Tại Sao Rust Khác

Trong Java: `static volatile + double-checked locking` — verbose và dễ sai.
Trong Rust: `static mut` = `unsafe`. Rust stdlib cung cấp `OnceLock<T>` — thread-safe, zero-overhead sau lần init đầu.

```rust
use std::sync::OnceLock;
use std::collections::HashMap;

// ─── Pattern 1: OnceLock cho lazy initialization ───────────────────────────
static CONFIG: OnceLock<AppConfig> = OnceLock::new();

#[derive(Debug)]
struct AppConfig {
    db_url:   String,
    max_conn: u32,
}

impl AppConfig {
    pub fn global() -> &'static AppConfig {
        CONFIG.get_or_init(|| {
            AppConfig {
                db_url:   std::env::var("DATABASE_URL")
                              .unwrap_or_else(|_| "postgres://localhost/dev".into()),
                max_conn: 20,
            }
        })
    }
}

// Usage — thread-safe, no locks after init:
fn main() {
    let cfg = AppConfig::global();
    println!("DB: {}", cfg.db_url);

    // Gọi nhiều lần → cùng instance
    assert!(std::ptr::eq(AppConfig::global(), AppConfig::global()));
}
```

```rust
// ─── Pattern 2: LazyLock (Rust 1.80+) — ergonomic ─────────────────────────
use std::sync::LazyLock;

static REGEX_EMAIL: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^[^@]+@[^@]+\.[^@]+$").unwrap()
});

// Tự động init lần đầu access — giống once_cell::sync::Lazy
fn validate(email: &str) -> bool {
    REGEX_EMAIL.is_match(email)
}
```

```rust
// ─── Pattern 3: Singleton với mutable state ────────────────────────────────
use std::sync::{OnceLock, Mutex};

static COUNTER: OnceLock<Mutex<u64>> = OnceLock::new();

fn get_counter() -> &'static Mutex<u64> {
    COUNTER.get_or_init(|| Mutex::new(0))
}

fn increment() -> u64 {
    let mut c = get_counter().lock().unwrap();
    *c += 1;
    *c
}
```

### ✅ Khi Dùng / ❌ Khi Tránh
```
✅ Config toàn application
✅ Regex compiled patterns
✅ Database connection pool
❌ Không dùng static mut — UB trong multi-thread
❌ Tránh quá nhiều global state → khó test
   → prefer dependency injection: AppConfig as param
```

---

## 2. Factory Method — Trait + Associated Type

### Intent
Định nghĩa interface tạo object, để subclass quyết định class nào được instantiated.

### Rust: `trait` thay thế `abstract class`

```rust
// ─── Domain: Document processing system ───────────────────────────────────
trait Document {
    fn render(&self) -> String;
    fn word_count(&self) -> usize;
}

// Concrete products
struct PdfDocument  { content: String }
struct HtmlDocument { content: String }
struct MarkdownDocument { content: String }

impl Document for PdfDocument {
    fn render(&self)      -> String { format!("[PDF] {}", self.content) }
    fn word_count(&self)  -> usize  { self.content.split_whitespace().count() }
}
impl Document for HtmlDocument {
    fn render(&self)     -> String { format!("<p>{}</p>", self.content) }
    fn word_count(&self) -> usize  { self.content.split_whitespace().count() }
}
impl Document for MarkdownDocument {
    fn render(&self)     -> String { format!("**{}**", self.content) }
    fn word_count(&self) -> usize  { self.content.split_whitespace().count() }
}

// ─── Factory Method: Trait ─────────────────────────────────────────────────
trait DocumentFactory {
    type Output: Document;           // associated type = Rust's way
    fn create(&self, content: &str) -> Self::Output;
}

struct PdfFactory;
struct HtmlFactory;

impl DocumentFactory for PdfFactory {
    type Output = PdfDocument;
    fn create(&self, content: &str) -> PdfDocument {
        PdfDocument { content: content.to_string() }
    }
}
impl DocumentFactory for HtmlFactory {
    type Output = HtmlDocument;
    fn create(&self, content: &str) -> HtmlDocument {
        HtmlDocument { content: content.to_string() }
    }
}

// Generic function — zero-cost, monomorphized
fn process<F: DocumentFactory>(factory: &F, text: &str) {
    let doc = factory.create(text);
    println!("Rendered: {}", doc.render());
    println!("Words: {}", doc.word_count());
}

fn main() {
    process(&PdfFactory,  "Hello World from PDF");
    process(&HtmlFactory, "Hello World from HTML");
}
```

```rust
// ─── Alternative: Function pointer / closure factory ──────────────────────
// Khi không cần static dispatch, dùng Box<dyn Document>

fn make_factory(format: &str) -> Box<dyn Fn(&str) -> Box<dyn Document>> {
    match format {
        "pdf"  => Box::new(|c| Box::new(PdfDocument  { content: c.to_string() })),
        "html" => Box::new(|c| Box::new(HtmlDocument { content: c.to_string() })),
        _      => Box::new(|c| Box::new(MarkdownDocument { content: c.to_string() })),
    }
}

fn main() {
    let factory = make_factory("pdf");
    let doc = factory("Content here");
    println!("{}", doc.render());
}
```

---

## 3. Abstract Factory — Trait of Traits

### Intent
Tạo **families of related objects** mà không chỉ định concrete classes.

### Prototype: UI Theme System

```rust
// ─── Products ──────────────────────────────────────────────────────────────
trait Button {
    fn render(&self) -> String;
    fn on_click(&self);
}
trait Checkbox {
    fn render(&self) -> String;
    fn toggle(&mut self);
}

// Light theme products
struct LightButton  { label: String }
struct LightCheckbox { checked: bool }

impl Button for LightButton {
    fn render(&self) -> String { format!("[☀ BUTTON: {}]", self.label) }
    fn on_click(&self) { println!("Light button '{}' clicked", self.label); }
}
impl Checkbox for LightCheckbox {
    fn render(&self) -> String {
        if self.checked { "[☀ ✓]".into() } else { "[☀ □]".into() }
    }
    fn toggle(&mut self) { self.checked = !self.checked; }
}

// Dark theme products
struct DarkButton   { label: String }
struct DarkCheckbox { checked: bool }

impl Button for DarkButton {
    fn render(&self) -> String { format!("[🌙 BUTTON: {}]", self.label) }
    fn on_click(&self) { println!("Dark button '{}' clicked", self.label); }
}
impl Checkbox for DarkCheckbox {
    fn render(&self) -> String {
        if self.checked { "[🌙 ✓]".into() } else { "[🌙 □]".into() }
    }
    fn toggle(&mut self) { self.checked = !self.checked; }
}

// ─── Abstract Factory trait ────────────────────────────────────────────────
trait UIFactory {
    fn create_button  (&self, label: &str) -> Box<dyn Button>;
    fn create_checkbox(&self)              -> Box<dyn Checkbox>;
}

struct LightThemeFactory;
struct DarkThemeFactory;

impl UIFactory for LightThemeFactory {
    fn create_button  (&self, label: &str) -> Box<dyn Button>   {
        Box::new(LightButton { label: label.to_string() })
    }
    fn create_checkbox(&self) -> Box<dyn Checkbox> {
        Box::new(LightCheckbox { checked: false })
    }
}
impl UIFactory for DarkThemeFactory {
    fn create_button  (&self, label: &str) -> Box<dyn Button>   {
        Box::new(DarkButton { label: label.to_string() })
    }
    fn create_checkbox(&self) -> Box<dyn Checkbox> {
        Box::new(DarkCheckbox { checked: false })
    }
}

// ─── Client code — chỉ biết UIFactory, không biết concrete types ──────────
fn render_login_screen(factory: &dyn UIFactory) {
    let submit_btn  = factory.create_button("Login");
    let remember_cb = factory.create_checkbox();

    println!("{}", submit_btn.render());
    println!("{}", remember_cb.render());
    submit_btn.on_click();
}

fn main() {
    let theme: &str = "dark"; // có thể từ config/env
    let factory: Box<dyn UIFactory> = match theme {
        "dark" => Box::new(DarkThemeFactory),
        _      => Box::new(LightThemeFactory),
    };

    render_login_screen(factory.as_ref());
}
```

---

## 4. Builder — Typestate Builder (Rust's Killer Pattern)

### Intent
Xây dựng object phức tạp step-by-step. Tách construction từ representation.

### Rust: Hai Dạng Builder

#### Dạng 1: Runtime Builder (simple, phổ biến)

```rust
// ─── HTTP Request Builder (giống reqwest API) ──────────────────────────────
#[derive(Debug)]
struct HttpRequest {
    url:     String,
    method:  String,
    headers: Vec<(String, String)>,
    body:    Option<String>,
    timeout: std::time::Duration,
}

#[derive(Default)]
struct HttpRequestBuilder {
    url:     String,
    method:  String,
    headers: Vec<(String, String)>,
    body:    Option<String>,
    timeout: Option<std::time::Duration>,
}

impl HttpRequestBuilder {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url:    url.into(),
            method: "GET".to_string(),
            ..Default::default()
        }
    }

    // Builder methods trả về `Self` → method chaining
    pub fn method(mut self, m: impl Into<String>) -> Self {
        self.method = m.into(); self
    }
    pub fn header(mut self, key: impl Into<String>, val: impl Into<String>) -> Self {
        self.headers.push((key.into(), val.into())); self
    }
    pub fn body(mut self, b: impl Into<String>) -> Self {
        self.body = Some(b.into()); self
    }
    pub fn timeout(mut self, t: std::time::Duration) -> Self {
        self.timeout = Some(t); self
    }

    // Validation tại build time
    pub fn build(self) -> Result<HttpRequest, String> {
        if self.url.is_empty() {
            return Err("URL is required".into());
        }
        Ok(HttpRequest {
            url:     self.url,
            method:  self.method,
            headers: self.headers,
            body:    self.body,
            timeout: self.timeout.unwrap_or(std::time::Duration::from_secs(30)),
        })
    }
}

fn main() {
    let req = HttpRequestBuilder::new("https://api.vpbank.com/v1/loans")
        .method("POST")
        .header("Authorization", "Bearer token123")
        .header("Content-Type", "application/json")
        .body(r#"{"amount": 10000}"#)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("Valid request");

    println!("{:#?}", req);
}
```

#### Dạng 2: Typestate Builder — Compile-Time Validation ⭐

```rust
// ─── Typestate Builder: Required fields enforced by TYPE SYSTEM ────────────
// Không thể gọi .build() nếu thiếu required fields — compiler error!

use std::marker::PhantomData;

// Type-level state markers
struct NoUrl;
struct HasUrl;
struct NoMethod;
struct HasMethod;

struct RequestBuilder<U, M> {
    url:     Option<String>,
    method:  Option<String>,
    headers: Vec<(String, String)>,
    _url:    PhantomData<U>,
    _method: PhantomData<M>,
}

// Constructor: bắt đầu với NoUrl + NoMethod
impl RequestBuilder<NoUrl, NoMethod> {
    pub fn new() -> Self {
        RequestBuilder {
            url: None, method: None, headers: vec![],
            _url: PhantomData, _method: PhantomData,
        }
    }
}

// set_url chuyển type state U: NoUrl → HasUrl
impl<M> RequestBuilder<NoUrl, M> {
    pub fn url(self, url: impl Into<String>) -> RequestBuilder<HasUrl, M> {
        RequestBuilder {
            url:     Some(url.into()),
            method:  self.method,
            headers: self.headers,
            _url:    PhantomData,
            _method: PhantomData,
        }
    }
}

// set_method chuyển type state M: NoMethod → HasMethod
impl<U> RequestBuilder<U, NoMethod> {
    pub fn method(self, m: impl Into<String>) -> RequestBuilder<U, HasMethod> {
        RequestBuilder {
            url:     self.url,
            method:  Some(m.into()),
            headers: self.headers,
            _url:    PhantomData,
            _method: PhantomData,
        }
    }
}

// headers available ở mọi state
impl<U, M> RequestBuilder<U, M> {
    pub fn header(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        self.headers.push((k.into(), v.into())); self
    }
}

// build() CHỈ available khi CẢ HAI HasUrl VÀ HasMethod
impl RequestBuilder<HasUrl, HasMethod> {
    pub fn build(self) -> HttpRequest {
        HttpRequest {
            url:     self.url.unwrap(),
            method:  self.method.unwrap(),
            headers: self.headers,
            body:    None,
            timeout: std::time::Duration::from_secs(30),
        }
    }
}

fn main() {
    // ✅ Compiles:
    let req = RequestBuilder::new()
        .url("https://api.example.com")
        .method("GET")
        .header("Auth", "Bearer token")
        .build();

    // ❌ Compile error: "no method `build` found for `RequestBuilder<NoUrl, HasMethod>`"
    // let bad = RequestBuilder::new().method("GET").build();
    //                                                ^^^^^ compiler catches this!
}
```

### ✅ Khi Dùng Builder
```
✅ Objects với nhiều optional fields (HTTP client, DB query)
✅ Validation logic tại construction time
✅ Public API cần ergonomic interface
✅ Typestate khi required fields cần enforce statically

❌ Simple structs (2-3 fields) — dùng struct literal trực tiếp
❌ Khi performance critical — builder có move overhead
```

---

## 5. Prototype — `Clone` Trait

### Intent
Tạo object mới bằng cách copy object hiện có.

### Rust: Built Into Language

```rust
// ─── Prototype = #[derive(Clone)] hoặc impl Clone ─────────────────────────
#[derive(Debug, Clone)]
struct QueryTemplate {
    table:      String,
    conditions: Vec<String>,
    limit:      Option<usize>,
    fields:     Vec<String>,
}

impl QueryTemplate {
    pub fn new(table: impl Into<String>) -> Self {
        QueryTemplate {
            table: table.into(),
            conditions: vec![],
            limit: None,
            fields: vec!["*".into()],
        }
    }

    // Clone + customize = Prototype pattern
    pub fn with_condition(mut self, cond: impl Into<String>) -> Self {
        self.conditions.push(cond.into()); self
    }
    pub fn with_limit(mut self, n: usize) -> Self {
        self.limit = Some(n); self
    }

    pub fn to_sql(&self) -> String {
        let fields = self.fields.join(", ");
        let where_clause = if self.conditions.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", self.conditions.join(" AND "))
        };
        let limit_clause = self.limit
            .map(|n| format!(" LIMIT {}", n))
            .unwrap_or_default();
        format!("SELECT {} FROM {}{}{}", fields, self.table, where_clause, limit_clause)
    }
}

fn main() {
    // Base prototype — active users query template
    let base_query = QueryTemplate::new("users")
        .with_condition("status = 'active'");

    // Clone prototype và customize — không ảnh hưởng original
    let admin_query = base_query.clone()
        .with_condition("role = 'admin'")
        .with_limit(10);

    let recent_query = base_query.clone()
        .with_condition("created_at > NOW() - INTERVAL '7 days'");

    println!("{}", base_query.to_sql());
    // SELECT * FROM users WHERE status = 'active'

    println!("{}", admin_query.to_sql());
    // SELECT * FROM users WHERE status = 'active' AND role = 'admin' LIMIT 10

    println!("{}", recent_query.to_sql());
    // SELECT * FROM users WHERE status = 'active' AND created_at > NOW() - INTERVAL '7 days'
}
```

```rust
// ─── Deep Clone vs Shallow Clone ──────────────────────────────────────────
// derive(Clone) = deep clone (recurse qua tất cả fields)
// Custom Clone để lazy-clone shared data:

use std::sync::Arc;

#[derive(Clone, Debug)]
struct DocumentTemplate {
    title:    String,
    metadata: Arc<Metadata>, // Arc: clone = increment refcount, không copy data
    content:  String,
}
// document.clone() → new String cho title/content, shared Arc cho metadata
// Đây là "shallow" clone của Arc — metadata không bị duplicate trên heap
```

### Cheat Sheet: Creational Patterns

| Situation | Pattern | Rust Idiom |
|-----------|---------|-----------|
| Global unique instance | Singleton | `static OnceLock<T>` |
| "Give me one of these" | Factory Method | `trait Factory { type Output }` |
| "Give me a family" | Abstract Factory | `trait UIFactory` returning `Box<dyn>` |
| "Build complex step by step" | Builder | Chaining `mut self` methods + `build()` |
| "Copy and customize" | Prototype | `#[derive(Clone)]` + clone + modify |

---

## 🔗 Links
- [[Design-Patterns-Rust/00-Overview|Series Overview]]
- [[Design-Patterns-Rust/02-Structural|02 · Structural Patterns →]]
- [[Rust-Zero-To-Hero/Bai-3-Struct-Enum-Trait|Bài 3: Struct, Enum, Trait cơ bản]]
- [[Rust-Zero-To-Hero/Bai-6-Generics-Traits-Advanced|Bài 6: Generics & Traits nâng cao]]

*Tags: #rust #design-patterns #creational #gof*
