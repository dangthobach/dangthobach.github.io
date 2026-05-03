# Structural Patterns in Rust

> *Structural patterns giải quyết cách **kết hợp** objects và classes thành cấu trúc lớn hơn. Rust không có inheritance — chỉ có composition, traits, và generics. Điều này làm nhiều structural patterns trở nên rõ ràng và type-safe hơn.*

---

## 1. Adapter — Newtype Pattern

### Intent
Cho phép **interface incompatible** làm việc cùng nhau. Wrap một object trong adapter để expose interface mà client expect.

### Rust: Newtype + Trait Impl

```rust
// ─── Scenario: PDMS cần dùng legacy CIF API có interface khác ─────────────

// Legacy interface (không thể modify)
struct LegacyCifClient {
    base_url: String,
}
impl LegacyCifClient {
    pub fn fetch_customer_data(&self, cif_code: &str) -> Result<String, String> {
        // Returns raw CSV: "CIF001,Nguyen Van A,0901234567,ACTIVE"
        Ok(format!("{},Nguyen Van A,0901234567,ACTIVE", cif_code))
    }
}

// Modern interface mà PDMS muốn dùng
trait CustomerRepository {
    fn find_by_cif(&self, cif: &str) -> Result<Customer, AppError>;
    fn is_active(&self, cif: &str)   -> Result<bool, AppError>;
}

#[derive(Debug)]
struct Customer { cif: String, name: String, phone: String, status: String }

#[derive(Debug)]
enum AppError { NotFound, ParseError(String), NetworkError(String) }

// ─── Adapter: Newtype wrapping LegacyCifClient ─────────────────────────────
struct CifClientAdapter {
    inner: LegacyCifClient,  // owns the adaptee
}

impl CifClientAdapter {
    pub fn new(base_url: impl Into<String>) -> Self {
        CifClientAdapter {
            inner: LegacyCifClient { base_url: base_url.into() },
        }
    }

    fn parse_csv(raw: &str) -> Result<Customer, AppError> {
        let parts: Vec<&str> = raw.split(',').collect();
        if parts.len() != 4 {
            return Err(AppError::ParseError(format!("Invalid CSV: {}", raw)));
        }
        Ok(Customer {
            cif:    parts[0].to_string(),
            name:   parts[1].to_string(),
            phone:  parts[2].to_string(),
            status: parts[3].to_string(),
        })
    }
}

// Adapter implements the target interface
impl CustomerRepository for CifClientAdapter {
    fn find_by_cif(&self, cif: &str) -> Result<Customer, AppError> {
        self.inner
            .fetch_customer_data(cif)
            .map_err(|e| AppError::NetworkError(e))
            .and_then(|raw| Self::parse_csv(&raw))
    }

    fn is_active(&self, cif: &str) -> Result<bool, AppError> {
        self.find_by_cif(cif).map(|c| c.status == "ACTIVE")
    }
}

// ─── Client code chỉ biết CustomerRepository ──────────────────────────────
fn process_loan_application(repo: &dyn CustomerRepository, cif: &str) {
    match repo.is_active(cif) {
        Ok(true)  => println!("Customer {} is active — proceed", cif),
        Ok(false) => println!("Customer {} inactive — reject", cif),
        Err(e)    => println!("Error: {:?}", e),
    }
}

fn main() {
    let adapter = CifClientAdapter::new("http://legacy-cif.internal");
    process_loan_application(&adapter, "CIF001");
}
```

```rust
// ─── Bonus: Adapter để implement foreign trait cho foreign type ────────────
// Rust orphan rule: không thể impl ForeignTrait cho ForeignType
// Newtype giải quyết:

use std::fmt;
struct Wrapper(Vec<String>);  // newtype

impl fmt::Display for Wrapper {   // now we can implement Display
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "[{}]", self.0.join(", "))
    }
}
```

---

## 2. Bridge — Separate Abstraction from Implementation

### Intent
Tách **abstraction** khỏi **implementation** để cả hai có thể thay đổi độc lập. Tránh class explosion.

```
Problem: N shapes × M renderers = N×M classes
Bridge:  N shapes + M renderers = N+M components
```

### Prototype: Notification System

```rust
// ─── Implementation (platform): HOW to send ──────────────────────────────
trait NotificationSender {
    fn send(&self, recipient: &str, message: &str) -> Result<(), String>;
    fn name(&self) -> &str;
}

struct EmailSender   { smtp_host: String }
struct SmsSender     { api_key:   String }
struct SlackSender   { webhook:   String }

impl NotificationSender for EmailSender {
    fn send(&self, recipient: &str, msg: &str) -> Result<(), String> {
        println!("[EMAIL via {}] To: {} | {}", self.smtp_host, recipient, msg);
        Ok(())
    }
    fn name(&self) -> &str { "Email" }
}
impl NotificationSender for SmsSender {
    fn send(&self, recipient: &str, msg: &str) -> Result<(), String> {
        println!("[SMS] To: {} | {}", recipient, &msg[..msg.len().min(160)]);
        Ok(())
    }
    fn name(&self) -> &str { "SMS" }
}
impl NotificationSender for SlackSender {
    fn send(&self, recipient: &str, msg: &str) -> Result<(), String> {
        println!("[SLACK] Channel: {} | {}", recipient, msg);
        Ok(())
    }
    fn name(&self) -> &str { "Slack" }
}

// ─── Abstraction: WHAT to notify ──────────────────────────────────────────
// Bridge field: sender: Box<dyn NotificationSender>
struct AlertNotification {
    sender:   Box<dyn NotificationSender>,
    severity: String,
}
struct ReportNotification {
    sender:   Box<dyn NotificationSender>,
    schedule: String,
}

impl AlertNotification {
    pub fn new(sender: Box<dyn NotificationSender>, severity: impl Into<String>) -> Self {
        Self { sender, severity: severity.into() }
    }

    pub fn send_alert(&self, to: &str, detail: &str) {
        let msg = format!("[{}] ALERT: {}", self.severity, detail);
        match self.sender.send(to, &msg) {
            Ok(_)  => println!("  ✓ Sent via {}", self.sender.name()),
            Err(e) => println!("  ✗ Failed: {}", e),
        }
    }
}

impl ReportNotification {
    pub fn new(sender: Box<dyn NotificationSender>, schedule: impl Into<String>) -> Self {
        Self { sender, schedule: schedule.into() }
    }

    pub fn send_report(&self, to: &str, data: &str) {
        let msg = format!("[Report @ {}]\n{}", self.schedule, data);
        self.sender.send(to, &msg).ok();
    }
}

fn main() {
    // Kết hợp bất kỳ abstraction × implementation:
    let critical_alert = AlertNotification::new(
        Box::new(SmsSender { api_key: "sk_xxx".into() }),
        "CRITICAL",
    );
    critical_alert.send_alert("+84901234567", "DB connection pool exhausted");

    let weekly_report = ReportNotification::new(
        Box::new(SlackSender { webhook: "https://hooks.slack.com/xxx".into() }),
        "Every Monday 09:00",
    );
    weekly_report.send_report("#engineering", "Uptime: 99.95%, Errors: 42");
}
```

---

## 3. Composite — Enum Tree

### Intent
Compose objects thành **tree structures** để represent part-whole hierarchies. Client treat individual objects và compositions uniformly.

### Rust: Enum thay thế class hierarchy

```rust
// ─── File system tree (classic Composite example) ─────────────────────────
#[derive(Debug, Clone)]
enum FileNode {
    File {
        name: String,
        size: u64,    // bytes
    },
    Directory {
        name:     String,
        children: Vec<FileNode>,
    },
}

impl FileNode {
    // Cùng interface cho cả File và Directory
    pub fn name(&self) -> &str {
        match self {
            FileNode::File { name, .. }      => name,
            FileNode::Directory { name, .. } => name,
        }
    }

    pub fn total_size(&self) -> u64 {
        match self {
            FileNode::File { size, .. } => *size,
            FileNode::Directory { children, .. } => {
                children.iter().map(|c| c.total_size()).sum()
            }
        }
    }

    pub fn file_count(&self) -> usize {
        match self {
            FileNode::File { .. } => 1,
            FileNode::Directory { children, .. } => {
                children.iter().map(|c| c.file_count()).sum()
            }
        }
    }

    pub fn print_tree(&self, indent: usize) {
        let pad = " ".repeat(indent * 2);
        match self {
            FileNode::File { name, size } => {
                println!("{}📄 {} ({} KB)", pad, name, size / 1024);
            }
            FileNode::Directory { name, children } => {
                println!("{}📁 {} ({} files, {} KB total)",
                    pad, name, self.file_count(), self.total_size() / 1024);
                for child in children {
                    child.print_tree(indent + 1);
                }
            }
        }
    }
}

fn main() {
    let fs = FileNode::Directory {
        name: "pdms-project".into(),
        children: vec![
            FileNode::Directory {
                name: "src".into(),
                children: vec![
                    FileNode::File { name: "main.rs".into(),   size: 4_096 },
                    FileNode::File { name: "config.rs".into(), size: 2_048 },
                    FileNode::Directory {
                        name: "handlers".into(),
                        children: vec![
                            FileNode::File { name: "loan.rs".into(),     size: 8_192 },
                            FileNode::File { name: "document.rs".into(), size: 6_144 },
                        ],
                    },
                ],
            },
            FileNode::File { name: "Cargo.toml".into(), size: 512 },
            FileNode::File { name: "README.md".into(),  size: 1_024 },
        ],
    };

    fs.print_tree(0);
    println!("\nTotal: {} files, {} KB", fs.file_count(), fs.total_size() / 1024);
}
```

```
📁 pdms-project (5 files, 21 KB total)
  📁 src (4 files, 20 KB total)
    📄 main.rs (4 KB)
    📄 config.rs (2 KB)
    📁 handlers (2 files, 14 KB total)
      📄 loan.rs (8 KB)
      📄 document.rs (6 KB)
  📄 Cargo.toml (0 KB)
  📄 README.md (1 KB)
```

---

## 4. Decorator — Newtype Wrapping Trait

### Intent
Attach **additional responsibilities** to object dynamically. Alternative to subclassing.

### Rust: Wrapping + impl same trait

```rust
// ─── Layered middleware/logging — Decorator cho DataStore ─────────────────
trait DataStore {
    fn get(&self, key: &str)         -> Option<String>;
    fn set(&mut self, key: &str, val: String);
    fn delete(&mut self, key: &str)  -> bool;
}

// Base implementation
use std::collections::HashMap;
struct InMemoryStore { data: HashMap<String, String> }

impl DataStore for InMemoryStore {
    fn get(&self, key: &str)              -> Option<String> { self.data.get(key).cloned() }
    fn set(&mut self, key: &str, val: String)               { self.data.insert(key.to_string(), val); }
    fn delete(&mut self, key: &str)       -> bool           { self.data.remove(key).is_some() }
}

// ─── Decorator 1: Logging ──────────────────────────────────────────────────
struct LoggingStore<S: DataStore> {
    inner: S,
    prefix: String,
}

impl<S: DataStore> LoggingStore<S> {
    pub fn new(inner: S, prefix: impl Into<String>) -> Self {
        LoggingStore { inner, prefix: prefix.into() }
    }
}

impl<S: DataStore> DataStore for LoggingStore<S> {
    fn get(&self, key: &str) -> Option<String> {
        let result = self.inner.get(key);
        println!("[{}][GET] key={} → {:?}", self.prefix, key, result);
        result
    }
    fn set(&mut self, key: &str, val: String) {
        println!("[{}][SET] key={} val={}", self.prefix, key, val);
        self.inner.set(key, val);
    }
    fn delete(&mut self, key: &str) -> bool {
        let ok = self.inner.delete(key);
        println!("[{}][DEL] key={} → {}", self.prefix, key, ok);
        ok
    }
}

// ─── Decorator 2: Metrics ──────────────────────────────────────────────────
struct MetricsStore<S: DataStore> {
    inner:      S,
    read_count: u64,
    write_count: u64,
}

impl<S: DataStore> MetricsStore<S> {
    pub fn new(inner: S) -> Self {
        MetricsStore { inner, read_count: 0, write_count: 0 }
    }
    pub fn stats(&self) -> (u64, u64) { (self.read_count, self.write_count) }
}

impl<S: DataStore> DataStore for MetricsStore<S> {
    fn get(&self, key: &str) -> Option<String> {
        // Note: &self không cho phép mutate — dùng Cell/RefCell nếu cần interior mutability
        self.inner.get(key)
    }
    fn set(&mut self, key: &str, val: String) {
        self.write_count += 1;
        self.inner.set(key, val);
    }
    fn delete(&mut self, key: &str) -> bool {
        self.write_count += 1;
        self.inner.delete(key)
    }
}

fn main() {
    // Stack decorators: MetricsStore(LoggingStore(InMemoryStore))
    let base    = InMemoryStore { data: HashMap::new() };
    let logged  = LoggingStore::new(base, "STORE");
    let mut store = MetricsStore::new(logged);

    store.set("user:1", "Nguyen Van Bach".into());
    store.get("user:1");
    store.delete("user:99");

    let (reads, writes) = store.stats();
    println!("Stats — reads: {}, writes: {}", reads, writes);
}
```

---

## 5. Facade — Module với Public API

### Intent
Provide **simple interface** cho complex subsystem.

### Rust: Module system làm Facade tự nhiên

```rust
// ─── Complex notification subsystem ───────────────────────────────────────
mod notification {
    // Internal complexity (private)
    mod email    { pub fn send(to: &str, subject: &str, body: &str) { println!("[EMAIL] {}: {} - {}", to, subject, body); } }
    mod sms      { pub fn send(to: &str, msg: &str) { println!("[SMS] {}: {}", to, msg); } }
    mod template { pub fn render(name: &str, vars: &[(&str, &str)]) -> String {
        let mut s = name.to_string();
        for (k, v) in vars { s = s.replace(&format!("{{{}}}", k), v); }
        s
    }}
    mod rate_limit { pub fn check(channel: &str, user_id: &str) -> bool { true } }
    mod audit      { pub fn log(event: &str, user_id: &str) { println!("[AUDIT] {}: {}", event, user_id); } }

    // ─── FACADE: simple public interface ──────────────────────────────────
    pub struct NotificationService;

    impl NotificationService {
        pub fn notify_loan_approved(user_email: &str, phone: &str, user_id: &str, amount: u64) {
            if !rate_limit::check("email", user_id) { return; }

            let body = template::render(
                "Loan of {amount} VND approved. Login to view details.",
                &[("amount", &amount.to_string())],
            );
            email::send(user_email, "Loan Approved", &body);
            sms::send(phone, &format!("Loan {}VND approved!", amount));
            audit::log("loan_approved_notification", user_id);
        }

        pub fn notify_document_rejected(user_email: &str, user_id: &str, reason: &str) {
            let body = template::render(
                "Document rejected: {reason}. Please resubmit.",
                &[("reason", reason)],
            );
            email::send(user_email, "Document Rejected", &body);
            audit::log("document_rejected_notification", user_id);
        }
    }
}

// Client sees only Facade:
use notification::NotificationService;

fn approve_loan(user_id: &str, amount: u64) {
    // Business logic...
    NotificationService::notify_loan_approved(
        "bach@example.com", "+84901234567", user_id, amount,
    );
}
```

---

## 6. Flyweight — `Arc<T>` Shared Immutable Data

### Intent
Share **common state** giữa nhiều objects để reduce memory. Separate intrinsic (shared) vs extrinsic (unique) state.

```rust
// ─── Document rendering: Font được share ──────────────────────────────────
use std::sync::Arc;
use std::collections::HashMap;

// Intrinsic state — immutable, shared
#[derive(Debug, Clone)]
struct FontData {
    family: String,
    size:   u32,
    bold:   bool,
    data:   Vec<u8>,  // binary font data: 50-200KB per font
}

// Flyweight factory: cache và share FontData
struct FontFactory {
    cache: HashMap<String, Arc<FontData>>,
}

impl FontFactory {
    pub fn new() -> Self { FontFactory { cache: HashMap::new() } }

    pub fn get_font(&mut self, family: &str, size: u32, bold: bool) -> Arc<FontData> {
        let key = format!("{}-{}-{}", family, size, bold);
        self.cache
            .entry(key)
            .or_insert_with(|| {
                println!("Loading font: {} {}pt bold={}", family, size, bold);
                Arc::new(FontData {
                    family: family.into(),
                    size,
                    bold,
                    data: vec![0u8; 50_000], // simulate 50KB font file
                })
            })
            .clone() // Arc::clone = ptr copy, không copy 50KB data!
    }

    pub fn cache_size(&self) -> usize { self.cache.len() }
}

// Extrinsic state — unique per text span
struct TextSpan {
    text:     String,
    position: (f32, f32),
    color:    (u8, u8, u8),
    font:     Arc<FontData>, // shared — không duplicate 50KB data
}

fn main() {
    let mut factory = FontFactory::new();

    // 1000 text spans, nhưng chỉ 2 fonts unique
    let spans: Vec<TextSpan> = (0..1000).map(|i| {
        let font = if i % 2 == 0 {
            factory.get_font("Roboto", 12, false)
        } else {
            factory.get_font("Roboto", 14, true)
        };
        TextSpan {
            text: format!("Span {}", i),
            position: (i as f32 * 10.0, 0.0),
            color: (0, 0, 0),
            font,  // Arc pointer: 8 bytes, not 50KB!
        }
    }).collect();

    println!("Spans: {}", spans.len());
    println!("Font cache size: {} (only unique fonts loaded)", factory.cache_size());
    // Memory: 2 × 50KB = 100KB vs 1000 × 50KB = 50MB without flyweight
}
```

---

## 7. Proxy — `Deref` + Wrapper Struct

### Intent
Provide **surrogate** cho object. Control access, add lazy loading, caching, access control.

### Rust: 3 Proxy Variants

```rust
// ─── Proxy 1: Virtual Proxy (Lazy Loading) ────────────────────────────────
struct LazyImageProxy {
    path:       String,
    loaded_img: Option<Vec<u8>>,  // None = not loaded yet
}

impl LazyImageProxy {
    pub fn new(path: impl Into<String>) -> Self {
        LazyImageProxy { path: path.into(), loaded_img: None }
    }

    fn load_if_needed(&mut self) {
        if self.loaded_img.is_none() {
            println!("Loading image from disk: {}", self.path);
            self.loaded_img = Some(vec![0xFF; 1024]); // simulate disk read
        }
    }

    pub fn dimensions(&mut self) -> (u32, u32) {
        self.load_if_needed();
        (1920, 1080) // from loaded data
    }

    pub fn pixel_at(&mut self, x: u32, y: u32) -> u8 {
        self.load_if_needed();
        self.loaded_img.as_ref().unwrap()[0]
    }
}

// ─── Proxy 2: Protection Proxy (Access Control) ───────────────────────────
trait LoanService {
    fn approve_loan(&self, cif: &str, amount: u64) -> Result<String, String>;
    fn reject_loan (&self, cif: &str, reason: &str)  -> Result<(), String>;
}

struct LoanServiceImpl;
impl LoanService for LoanServiceImpl {
    fn approve_loan(&self, cif: &str, amount: u64) -> Result<String, String> {
        Ok(format!("LOAN-{}-{}", cif, amount))
    }
    fn reject_loan(&self, cif: &str, _: &str) -> Result<(), String> { Ok(()) }
}

struct AuthLoanProxy {
    inner:    LoanServiceImpl,
    user_role: String,
}
impl AuthLoanProxy {
    pub fn new(role: impl Into<String>) -> Self {
        AuthLoanProxy { inner: LoanServiceImpl, user_role: role.into() }
    }
}
impl LoanService for AuthLoanProxy {
    fn approve_loan(&self, cif: &str, amount: u64) -> Result<String, String> {
        if self.user_role != "LOAN_OFFICER" && self.user_role != "MANAGER" {
            return Err(format!("Role '{}' cannot approve loans", self.user_role));
        }
        if amount > 500_000_000 && self.user_role != "MANAGER" {
            return Err("Loans > 500M require MANAGER approval".into());
        }
        self.inner.approve_loan(cif, amount)
    }
    fn reject_loan(&self, cif: &str, reason: &str) -> Result<(), String> {
        if self.user_role == "VIEWER" {
            return Err("Viewers cannot reject loans".into());
        }
        self.inner.reject_loan(cif, reason)
    }
}

// ─── Proxy 3: Caching Proxy ────────────────────────────────────────────────
use std::cell::RefCell;

struct CachingCustomerProxy {
    inner: CifClientAdapter,  // từ Adapter example
    cache: RefCell<HashMap<String, Customer>>,
}
impl CachingCustomerProxy {
    pub fn new(inner: CifClientAdapter) -> Self {
        CachingCustomerProxy { inner, cache: RefCell::new(HashMap::new()) }
    }
}
impl CustomerRepository for CachingCustomerProxy {
    fn find_by_cif(&self, cif: &str) -> Result<Customer, AppError> {
        if let Some(cached) = self.cache.borrow().get(cif) {
            println!("Cache HIT for {}", cif);
            return Ok(cached.clone());
        }
        println!("Cache MISS for {} — fetching...", cif);
        let customer = self.inner.find_by_cif(cif)?;
        self.cache.borrow_mut().insert(cif.to_string(), customer.clone());
        Ok(customer)
    }
    fn is_active(&self, cif: &str) -> Result<bool, AppError> {
        self.find_by_cif(cif).map(|c| c.status == "ACTIVE")
    }
}
```

---

## Structural Patterns — Cheat Sheet

| Pattern | Problem | Rust Idiom | Key Concept |
|---------|---------|-----------|-------------|
| Adapter | Incompatible interfaces | Newtype + impl target trait | Orphan rule workaround |
| Bridge | Abstraction × Implementation | `Box<dyn Impl>` field | Composition over inheritance |
| Composite | Tree structures | `enum` với recursive variants | `Box<T>` breaks recursion |
| Decorator | Add behavior dynamically | Generic wrapper `S: Trait` | Monomorphized, zero-cost |
| Facade | Simplify complex subsystem | `mod` with `pub` API surface | Rust module system |
| Flyweight | Share common data | `Arc<T>` for shared immutable | Clone pointer, not data |
| Proxy | Control access | Wrapper + same trait impl | `Deref` for transparency |

---

## 🔗 Links
- [[Design-Patterns-Rust/00-Overview|Series Overview]]
- [[Design-Patterns-Rust/01-Creational|← 01 · Creational Patterns]]
- [[Design-Patterns-Rust/03-Behavioral|03 · Behavioral Patterns →]]
- [[Rust-Zero-To-Hero/Bai-8-Smart-Pointers-Error-Design|Bài 8: Smart Pointers]]

*Tags: #rust #design-patterns #structural #gof*
