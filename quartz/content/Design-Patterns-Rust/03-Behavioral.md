# Behavioral Patterns in Rust

> *Behavioral patterns định nghĩa cách objects **communicate** và phân chia responsibilities. Đây là nhóm phức tạp nhất trong Rust vì ownership model làm một số patterns (Observer, Mediator) khó hơn đáng kể, nhưng một số patterns khác (Iterator, Strategy) lại trở nên mạnh hơn.*

---

## 1. Strategy — Closure hoặc Trait Object

### Intent
Định nghĩa family of algorithms, đóng gói chúng, và làm chúng interchangeable.

### Rust: Closures là First-Class Strategy

```rust
// ─── Sorting strategy ─────────────────────────────────────────────────────

// Dạng 1: Closure (ergonomic, lightweight)
fn sort_with<T, F>(data: &mut Vec<T>, strategy: F)
where
    F: Fn(&T, &T) -> std::cmp::Ordering,
{
    data.sort_by(strategy);
}

#[derive(Debug, Clone)]
struct Employee { name: String, salary: u64, dept: String }

fn main() {
    let mut employees = vec![
        Employee { name: "Bach".into(),  salary: 15_000_000, dept: "Tech".into() },
        Employee { name: "Lan".into(),   salary: 20_000_000, dept: "Risk".into() },
        Employee { name: "Minh".into(),  salary: 12_000_000, dept: "Tech".into() },
    ];

    // Swap strategies at runtime via closure
    sort_with(&mut employees, |a, b| a.salary.cmp(&b.salary));
    println!("By salary:  {:?}", employees.iter().map(|e| &e.name).collect::<Vec<_>>());

    sort_with(&mut employees, |a, b| a.name.cmp(&b.name));
    println!("By name:    {:?}", employees.iter().map(|e| &e.name).collect::<Vec<_>>());

    sort_with(&mut employees, |a, b| a.dept.cmp(&b.dept).then(a.salary.cmp(&b.salary)));
    println!("By dept+pay:{:?}", employees.iter().map(|e| &e.name).collect::<Vec<_>>());
}
```

```rust
// Dạng 2: Trait Strategy — khi strategy có state hoặc cần store
trait PricingStrategy {
    fn calculate(&self, base_price: u64, quantity: u32) -> u64;
    fn name(&self) -> &str;
}

struct RegularPricing;
struct BulkDiscount    { threshold: u32, discount_pct: u32 }
struct MemberPricing   { member_level: String }

impl PricingStrategy for RegularPricing {
    fn calculate(&self, base: u64, qty: u32) -> u64 { base * qty as u64 }
    fn name(&self) -> &str { "Regular" }
}
impl PricingStrategy for BulkDiscount {
    fn calculate(&self, base: u64, qty: u32) -> u64 {
        let total = base * qty as u64;
        if qty >= self.threshold {
            total * (100 - self.discount_pct as u64) / 100
        } else { total }
    }
    fn name(&self) -> &str { "Bulk Discount" }
}
impl PricingStrategy for MemberPricing {
    fn calculate(&self, base: u64, qty: u32) -> u64 {
        let discount = match self.member_level.as_str() {
            "GOLD"     => 20,
            "SILVER"   => 10,
            _          =>  5,
        };
        base * qty as u64 * (100 - discount) / 100
    }
    fn name(&self) -> &str { "Member Pricing" }
}

struct ShoppingCart {
    items:    Vec<(String, u64, u32)>,  // (name, unit_price, qty)
    strategy: Box<dyn PricingStrategy>,
}

impl ShoppingCart {
    pub fn new(strategy: Box<dyn PricingStrategy>) -> Self {
        ShoppingCart { items: vec![], strategy }
    }
    pub fn add(&mut self, name: &str, price: u64, qty: u32) {
        self.items.push((name.to_string(), price, qty));
    }
    pub fn checkout(&self) -> u64 {
        let total: u64 = self.items.iter()
            .map(|(_, price, qty)| self.strategy.calculate(*price, *qty))
            .sum();
        println!("Strategy: {} | Total: {} VND", self.strategy.name(), total);
        total
    }
    // Swap strategy at runtime
    pub fn set_strategy(&mut self, s: Box<dyn PricingStrategy>) { self.strategy = s; }
}
```

---

## 2. Observer — Channel-Based (Async-Native)

### Intent
Define one-to-many dependency: khi subject thay đổi, tất cả observers được notify tự động.

### Tại Sao Observer Khó Trong Rust

```
Java:   Subject giữ List<Observer> (mutable refs) — đơn giản
Rust:   Subject giữ &mut Observer → borrow checker conflict
        Circular reference: Observer giữ ref Subject → RefCell/Rc chaos
```

### Rust: Channel Pattern (Clean & Async-Safe)

```rust
use tokio::sync::broadcast;
use std::sync::Arc;

// ─── Event types ──────────────────────────────────────────────────────────
#[derive(Debug, Clone)]
enum LoanEvent {
    Submitted { loan_id: String, cif: String, amount: u64 },
    Approved  { loan_id: String, approver: String },
    Rejected  { loan_id: String, reason: String },
    Disbursed { loan_id: String, account: String, amount: u64 },
}

// ─── Subject: broadcasts events ───────────────────────────────────────────
struct LoanEventBus {
    sender: broadcast::Sender<LoanEvent>,
}

impl LoanEventBus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        LoanEventBus { sender: tx }
    }
    pub fn subscribe(&self) -> broadcast::Receiver<LoanEvent> {
        self.sender.subscribe()
    }
    pub fn publish(&self, event: LoanEvent) {
        let _ = self.sender.send(event); // ignore if no subscribers
    }
}

// ─── Observers: each spawned as async task ────────────────────────────────
async fn audit_log_observer(mut rx: broadcast::Receiver<LoanEvent>) {
    while let Ok(event) = rx.recv().await {
        match &event {
            LoanEvent::Approved { loan_id, approver } =>
                println!("[AUDIT] Loan {} approved by {}", loan_id, approver),
            LoanEvent::Rejected { loan_id, reason } =>
                println!("[AUDIT] Loan {} rejected: {}", loan_id, reason),
            _ => {}
        }
    }
}

async fn notification_observer(mut rx: broadcast::Receiver<LoanEvent>) {
    while let Ok(event) = rx.recv().await {
        match &event {
            LoanEvent::Submitted { cif, amount, .. } =>
                println!("[NOTIFY] SMS to {}: Loan {}VND received", cif, amount),
            LoanEvent::Approved  { loan_id, .. } =>
                println!("[NOTIFY] Email: Loan {} APPROVED! 🎉", loan_id),
            LoanEvent::Disbursed { account, amount, .. } =>
                println!("[NOTIFY] Push: {}VND deposited to {}", amount, account),
            _ => {}
        }
    }
}

async fn risk_scoring_observer(mut rx: broadcast::Receiver<LoanEvent>) {
    while let Ok(event) = rx.recv().await {
        if let LoanEvent::Submitted { loan_id, cif, amount } = event {
            println!("[RISK] Scoring loan {} for {} — amount {}", loan_id, cif, amount);
            // async risk scoring logic...
        }
    }
}

#[tokio::main]
async fn main() {
    let bus = Arc::new(LoanEventBus::new(100));

    // Subscribe observers
    tokio::spawn(audit_log_observer(bus.subscribe()));
    tokio::spawn(notification_observer(bus.subscribe()));
    tokio::spawn(risk_scoring_observer(bus.subscribe()));

    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    // Publish events — observers receive concurrently
    bus.publish(LoanEvent::Submitted {
        loan_id: "LOAN-001".into(),
        cif: "CIF0042".into(),
        amount: 50_000_000,
    });
    bus.publish(LoanEvent::Approved {
        loan_id: "LOAN-001".into(),
        approver: "NVBach".into(),
    });

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
}
```

```rust
// ─── Alternative: Callback vec (sync, simpler) ───────────────────────────
type EventHandler<E> = Box<dyn Fn(&E) + Send + Sync>;

struct EventEmitter<E> {
    handlers: Vec<EventHandler<E>>,
}
impl<E> EventEmitter<E> {
    pub fn new() -> Self { EventEmitter { handlers: vec![] } }
    pub fn on(&mut self, handler: impl Fn(&E) + Send + Sync + 'static) {
        self.handlers.push(Box::new(handler));
    }
    pub fn emit(&self, event: &E) {
        for h in &self.handlers { h(event); }
    }
}
```

---

## 3. State — Typestate Pattern ⭐ (Rust's Unique Superpower)

### Intent
Cho phép object thay đổi behavior khi internal state thay đổi.

### Dạng 1: Runtime State (Enum)

```rust
// ─── Loan workflow state machine ──────────────────────────────────────────
#[derive(Debug, Clone, PartialEq)]
enum LoanStatus { Draft, Submitted, UnderReview, Approved, Rejected, Disbursed }

#[derive(Debug)]
struct LoanApplication {
    id:      String,
    amount:  u64,
    status:  LoanStatus,
    history: Vec<String>,
}

#[derive(Debug)]
enum StateError { InvalidTransition(String) }

impl LoanApplication {
    pub fn new(id: String, amount: u64) -> Self {
        LoanApplication { id, amount, status: LoanStatus::Draft, history: vec![] }
    }

    pub fn submit(&mut self) -> Result<(), StateError> {
        match self.status {
            LoanStatus::Draft => {
                self.status = LoanStatus::Submitted;
                self.history.push("Submitted by customer".into());
                Ok(())
            }
            _ => Err(StateError::InvalidTransition(
                format!("Cannot submit from {:?}", self.status)
            ))
        }
    }

    pub fn start_review(&mut self) -> Result<(), StateError> {
        match self.status {
            LoanStatus::Submitted => {
                self.status = LoanStatus::UnderReview;
                self.history.push("Review started".into());
                Ok(())
            }
            _ => Err(StateError::InvalidTransition(
                format!("Cannot review from {:?}", self.status)
            ))
        }
    }

    pub fn approve(&mut self, approver: &str) -> Result<(), StateError> {
        match self.status {
            LoanStatus::UnderReview => {
                self.status = LoanStatus::Approved;
                self.history.push(format!("Approved by {}", approver));
                Ok(())
            }
            _ => Err(StateError::InvalidTransition(
                format!("Cannot approve from {:?}", self.status)
            ))
        }
    }
}
```

### Dạng 2: Typestate — Invalid Transitions = Compile Error 🔥

```rust
// ─── State encoded IN THE TYPE — impossible to call wrong method ──────────
use std::marker::PhantomData;

// State markers (zero-size types)
struct Draft;
struct Submitted;
struct UnderReview;
struct Approved;
struct Rejected;

struct Loan<State> {
    id:      String,
    amount:  u64,
    history: Vec<String>,
    _state:  PhantomData<State>,
}

// Only Draft loans can be submitted
impl Loan<Draft> {
    pub fn new(id: String, amount: u64) -> Self {
        Loan { id, amount, history: vec!["Created".into()], _state: PhantomData }
    }

    pub fn submit(mut self) -> Loan<Submitted> {
        self.history.push("Submitted".into());
        Loan { id: self.id, amount: self.amount, history: self.history, _state: PhantomData }
    }
}

// Only Submitted loans can start review
impl Loan<Submitted> {
    pub fn start_review(mut self) -> Loan<UnderReview> {
        self.history.push("Review started".into());
        Loan { id: self.id, amount: self.amount, history: self.history, _state: PhantomData }
    }
}

// Only UnderReview loans can be approved or rejected
impl Loan<UnderReview> {
    pub fn approve(mut self, approver: &str) -> Loan<Approved> {
        self.history.push(format!("Approved by {}", approver));
        Loan { id: self.id, amount: self.amount, history: self.history, _state: PhantomData }
    }
    pub fn reject(mut self, reason: &str) -> Loan<Rejected> {
        self.history.push(format!("Rejected: {}", reason));
        Loan { id: self.id, amount: self.amount, history: self.history, _state: PhantomData }
    }
}

// Only Approved loans can be disbursed
impl Loan<Approved> {
    pub fn disburse(mut self, account: &str) -> String {
        self.history.push(format!("Disbursed to {}", account));
        format!("TXN-{}", self.id)
    }
}

fn main() {
    let loan = Loan::<Draft>::new("LOAN-001".into(), 50_000_000);
    let loan = loan.submit();          // Loan<Submitted>
    let loan = loan.start_review();    // Loan<UnderReview>
    let loan = loan.approve("NVBach"); // Loan<Approved>
    let txn  = loan.disburse("ACC-999");
    println!("Transaction: {}", txn);

    // ❌ Compile error — cannot call start_review on Draft:
    // let bad = Loan::<Draft>::new("X".into(), 0).start_review();
    //                                             ^^^^^^^^^^^^ no method found!

    // ❌ Compile error — cannot disburse a Submitted loan:
    // let bad2 = Loan::<Draft>::new("X".into(), 0).submit().disburse("ACC");
    //                                                       ^^^^^^^^ method not found!
}
```

---

## 4. Command — Closure / Trait Object với Undo

### Intent
Encapsulate request as object. Support undoable operations, queuing, logging.

```rust
// ─── Command pattern với undo/redo ────────────────────────────────────────
trait Command {
    fn execute(&mut self) -> Result<(), String>;
    fn undo(&mut self)    -> Result<(), String>;
    fn name(&self)        -> &str;
}

// ─── Concrete Commands ────────────────────────────────────────────────────
use std::collections::HashMap;

struct InsertDocumentCommand {
    store: std::sync::Arc<std::sync::Mutex<HashMap<String, String>>>,
    id:    String,
    data:  String,
}
impl Command for InsertDocumentCommand {
    fn execute(&mut self) -> Result<(), String> {
        self.store.lock().unwrap().insert(self.id.clone(), self.data.clone());
        println!("INSERT doc {}", self.id);
        Ok(())
    }
    fn undo(&mut self) -> Result<(), String> {
        self.store.lock().unwrap().remove(&self.id);
        println!("UNDO INSERT doc {}", self.id);
        Ok(())
    }
    fn name(&self) -> &str { "InsertDocument" }
}

struct UpdateFieldCommand {
    store:     std::sync::Arc<std::sync::Mutex<HashMap<String, String>>>,
    id:        String,
    new_value: String,
    old_value: Option<String>, // saved for undo
}
impl Command for UpdateFieldCommand {
    fn execute(&mut self) -> Result<(), String> {
        let mut store = self.store.lock().unwrap();
        self.old_value = store.get(&self.id).cloned();
        store.insert(self.id.clone(), self.new_value.clone());
        println!("UPDATE doc {} → {}", self.id, self.new_value);
        Ok(())
    }
    fn undo(&mut self) -> Result<(), String> {
        let mut store = self.store.lock().unwrap();
        match &self.old_value {
            Some(v) => { store.insert(self.id.clone(), v.clone()); }
            None    => { store.remove(&self.id); }
        }
        println!("UNDO UPDATE doc {}", self.id);
        Ok(())
    }
    fn name(&self) -> &str { "UpdateField" }
}

// ─── Invoker: command history ─────────────────────────────────────────────
struct DocumentEditor {
    history:   Vec<Box<dyn Command>>,
    redo_stack: Vec<Box<dyn Command>>,
}

impl DocumentEditor {
    pub fn new() -> Self {
        DocumentEditor { history: vec![], redo_stack: vec![] }
    }

    pub fn execute(&mut self, mut cmd: Box<dyn Command>) -> Result<(), String> {
        cmd.execute()?;
        self.history.push(cmd);
        self.redo_stack.clear(); // clear redo after new command
        Ok(())
    }

    pub fn undo(&mut self) -> Result<(), String> {
        match self.history.pop() {
            Some(mut cmd) => {
                cmd.undo()?;
                self.redo_stack.push(cmd);
                Ok(())
            }
            None => Err("Nothing to undo".into()),
        }
    }

    pub fn redo(&mut self) -> Result<(), String> {
        match self.redo_stack.pop() {
            Some(mut cmd) => {
                cmd.execute()?;
                self.history.push(cmd);
                Ok(())
            }
            None => Err("Nothing to redo".into()),
        }
    }
}

// ─── Closure-based Command (lightweight alternative) ──────────────────────
struct SimpleCommand {
    name:    &'static str,
    execute: Box<dyn FnMut() -> Result<(), String>>,
    undo:    Box<dyn FnMut() -> Result<(), String>>,
}
```

---

## 5. Template Method — Trait với Default Methods

### Intent
Define skeleton of algorithm in base class, defer some steps to subclasses.

### Rust: Trait Default Methods = Template Method

```rust
// ─── Data import pipeline (ETL template) ──────────────────────────────────
trait DataImporter {
    // TEMPLATE METHOD — final algorithm skeleton
    fn import(&self, source: &str) -> Result<ImportReport, String> {
        let raw    = self.fetch_data(source)?;
        let valid  = self.validate(&raw)?;
        let parsed = self.parse(&valid)?;
        self.transform(&parsed)?;
        let count  = self.persist(&parsed)?;
        Ok(ImportReport { source: source.to_string(), records: count })
    }

    // ABSTRACT steps — must implement
    fn fetch_data(&self, source: &str) -> Result<Vec<u8>, String>;
    fn parse(&self, raw: &[u8])        -> Result<Vec<Record>, String>;
    fn persist(&self, data: &[Record]) -> Result<usize, String>;

    // HOOK steps — optional override (have defaults)
    fn validate(&self, raw: &[u8]) -> Result<Vec<u8>, String> {
        if raw.is_empty() { Err("Empty data".into()) }
        else { Ok(raw.to_vec()) }
    }
    fn transform(&self, records: &[Record]) -> Result<(), String> {
        println!("  [default transform] {} records", records.len());
        Ok(())
    }
}

#[derive(Debug)]
struct Record { id: String, value: String }

#[derive(Debug)]
struct ImportReport { source: String, records: usize }

// ─── Concrete importer: CSV from file ─────────────────────────────────────
struct CsvFileImporter { db_url: String }

impl DataImporter for CsvFileImporter {
    fn fetch_data(&self, path: &str) -> Result<Vec<u8>, String> {
        println!("  Reading CSV: {}", path);
        Ok(b"id,value\n1,foo\n2,bar".to_vec()) // simulate
    }
    fn parse(&self, raw: &[u8]) -> Result<Vec<Record>, String> {
        let s = std::str::from_utf8(raw).map_err(|e| e.to_string())?;
        let records = s.lines().skip(1)
            .filter_map(|line| {
                let mut parts = line.split(',');
                Some(Record { id: parts.next()?.to_string(), value: parts.next()?.to_string() })
            })
            .collect();
        Ok(records)
    }
    fn persist(&self, data: &[Record]) -> Result<usize, String> {
        println!("  Persisting {} records to {}", data.len(), self.db_url);
        Ok(data.len())
    }
    // Override hook — extra CSV validation
    fn validate(&self, raw: &[u8]) -> Result<Vec<u8>, String> {
        let s = std::str::from_utf8(raw).map_err(|e| e.to_string())?;
        if !s.starts_with("id,") { return Err("Invalid CSV header".into()); }
        Ok(raw.to_vec())
    }
}

// ─── Concrete importer: JSON from API ─────────────────────────────────────
struct JsonApiImporter { api_key: String }

impl DataImporter for JsonApiImporter {
    fn fetch_data(&self, url: &str) -> Result<Vec<u8>, String> {
        println!("  Calling API: {} (key: {}...)", url, &self.api_key[..4]);
        Ok(br#"[{"id":"1","value":"alpha"}]"#.to_vec())
    }
    fn parse(&self, raw: &[u8]) -> Result<Vec<Record>, String> {
        // simplified JSON parse
        Ok(vec![Record { id: "1".into(), value: "alpha".into() }])
    }
    fn persist(&self, data: &[Record]) -> Result<usize, String> {
        println!("  Upsert {} records", data.len());
        Ok(data.len())
    }
    // Uses default validate() and transform()
}

fn run_import(importer: &dyn DataImporter, source: &str) {
    match importer.import(source) {
        Ok(r)  => println!("✓ Imported {} records from {}", r.records, r.source),
        Err(e) => println!("✗ Import failed: {}", e),
    }
}
```

---

## 6. Iterator — Built Into Language (Richest in Any Language)

### Rust's Iterator: 80+ Adapters, Zero-Cost

```rust
// Iterator pattern = std::iter::Iterator trait
// Không cần implement pattern này — nó ĐÃ LÀ CORE của Rust

// ─── Custom Iterator ───────────────────────────────────────────────────────
struct Fibonacci { a: u64, b: u64 }

impl Fibonacci {
    pub fn new() -> Self { Fibonacci { a: 0, b: 1 } }
}

impl Iterator for Fibonacci {
    type Item = u64;
    fn next(&mut self) -> Option<u64> {
        let next = self.a + self.b;
        self.a = self.b;
        self.b = next;
        Some(self.a) // infinite iterator
    }
}

fn main() {
    // Composing adapters — all lazy, fused into 1 loop:
    let sum: u64 = Fibonacci::new()
        .take_while(|&n| n < 1_000_000)    // stop condition
        .filter(|n| n % 2 == 0)            // even only
        .map(|n| n * n)                    // square
        .sum();                            // aggregate

    println!("Sum of even Fibonacci squares < 1M: {}", sum);

    // Chaining iterators:
    let all = (1..=3).chain(10..=12).collect::<Vec<_>>();
    // [1, 2, 3, 10, 11, 12]

    // zip two iterators:
    let pairs: Vec<_> = "abc".chars().zip(1..=3).collect();
    // [('a', 1), ('b', 2), ('c', 3)]

    // flat_map — flatten one level:
    let words = vec!["hello world", "foo bar"];
    let all_words: Vec<_> = words.iter().flat_map(|s| s.split(' ')).collect();
    // ["hello", "world", "foo", "bar"]

    // scan — stateful map (like fold but yields each step):
    let running_sum: Vec<u32> = (1..=5).scan(0, |acc, x| { *acc += x; Some(*acc) }).collect();
    // [1, 3, 6, 10, 15]
}
```

---

## 7. Chain of Responsibility — Middleware Pipeline

### Intent
Pass request along chain of handlers. Each handler decides to process or pass forward.

```rust
// ─── HTTP middleware chain (Axum-inspired) ────────────────────────────────
#[derive(Debug, Clone)]
struct Request {
    path:    String,
    method:  String,
    headers: std::collections::HashMap<String, String>,
    user_id: Option<String>,
}

#[derive(Debug)]
struct Response {
    status: u16,
    body:   String,
}

trait Middleware: Send + Sync {
    fn handle(&self, req: &mut Request, next: &dyn Fn(&mut Request) -> Response) -> Response;
    fn name(&self) -> &str;
}

// ─── Concrete Middlewares ─────────────────────────────────────────────────
struct LoggingMiddleware;
impl Middleware for LoggingMiddleware {
    fn handle(&self, req: &mut Request, next: &dyn Fn(&mut Request) -> Response) -> Response {
        println!("[LOG] {} {}", req.method, req.path);
        let start = std::time::Instant::now();
        let res = next(req);
        println!("[LOG] {} {} → {} ({:?})", req.method, req.path, res.status, start.elapsed());
        res
    }
    fn name(&self) -> &str { "Logging" }
}

struct AuthMiddleware { secret: String }
impl Middleware for AuthMiddleware {
    fn handle(&self, req: &mut Request, next: &dyn Fn(&mut Request) -> Response) -> Response {
        match req.headers.get("Authorization") {
            Some(token) if token.starts_with("Bearer ") => {
                req.user_id = Some("user_42".to_string()); // in real life: validate JWT
                next(req)
            }
            _ => Response { status: 401, body: "Unauthorized".into() },
        }
    }
    fn name(&self) -> &str { "Auth" }
}

struct RateLimitMiddleware { max_rps: u32 }
impl Middleware for RateLimitMiddleware {
    fn handle(&self, req: &mut Request, next: &dyn Fn(&mut Request) -> Response) -> Response {
        // simplified: always pass (in real: check Redis counter)
        next(req)
    }
    fn name(&self) -> &str { "RateLimit" }
}

// ─── Pipeline runner ──────────────────────────────────────────────────────
struct Pipeline {
    middlewares: Vec<Box<dyn Middleware>>,
}

impl Pipeline {
    pub fn new() -> Self { Pipeline { middlewares: vec![] } }

    pub fn use_middleware(mut self, m: impl Middleware + 'static) -> Self {
        self.middlewares.push(Box::new(m));
        self
    }

    pub fn run(&self, req: &mut Request, handler: impl Fn(&mut Request) -> Response) -> Response {
        self.run_at(req, 0, &handler)
    }

    fn run_at(&self, req: &mut Request, idx: usize, handler: &dyn Fn(&mut Request) -> Response) -> Response {
        if idx >= self.middlewares.len() {
            return handler(req);
        }
        let next_idx = idx + 1;
        self.middlewares[idx].handle(req, &|req| self.run_at(req, next_idx, handler))
    }
}

fn main() {
    let pipeline = Pipeline::new()
        .use_middleware(LoggingMiddleware)
        .use_middleware(RateLimitMiddleware { max_rps: 100 })
        .use_middleware(AuthMiddleware { secret: "secret".into() });

    let mut req = Request {
        path: "/api/loans".into(),
        method: "GET".into(),
        headers: [("Authorization".into(), "Bearer valid_token".into())].into(),
        user_id: None,
    };

    let res = pipeline.run(&mut req, |r| {
        Response { status: 200, body: format!("Hello, user {:?}", r.user_id) }
    });
    println!("Response: {} — {}", res.status, res.body);
}
```

---

## 8. Visitor — Enum + Match (Rust's Idiomatic Way)

### Intent
Define new operation on elements of object structure without changing element classes.

```rust
// ─── AST Visitor (expression evaluator) ───────────────────────────────────
#[derive(Debug, Clone)]
enum Expr {
    Num(f64),
    Var(String),
    Add(Box<Expr>, Box<Expr>),
    Mul(Box<Expr>, Box<Expr>),
    Neg(Box<Expr>),
}

// ─── Visitor trait ────────────────────────────────────────────────────────
trait ExprVisitor {
    type Output;
    fn visit(&self, expr: &Expr) -> Self::Output;
}

// ─── Visitor 1: Evaluator ─────────────────────────────────────────────────
use std::collections::HashMap;

struct Evaluator<'a> {
    vars: &'a HashMap<String, f64>,
}
impl<'a> ExprVisitor for Evaluator<'a> {
    type Output = Result<f64, String>;
    fn visit(&self, expr: &Expr) -> Result<f64, String> {
        match expr {
            Expr::Num(n)    => Ok(*n),
            Expr::Var(name) => self.vars.get(name)
                .copied()
                .ok_or_else(|| format!("Undefined variable: {}", name)),
            Expr::Add(l, r) => Ok(self.visit(l)? + self.visit(r)?),
            Expr::Mul(l, r) => Ok(self.visit(l)? * self.visit(r)?),
            Expr::Neg(e)    => Ok(-self.visit(e)?),
        }
    }
}

// ─── Visitor 2: Pretty Printer ────────────────────────────────────────────
struct PrettyPrinter;
impl ExprVisitor for PrettyPrinter {
    type Output = String;
    fn visit(&self, expr: &Expr) -> String {
        match expr {
            Expr::Num(n)    => n.to_string(),
            Expr::Var(name) => name.clone(),
            Expr::Add(l, r) => format!("({} + {})", self.visit(l), self.visit(r)),
            Expr::Mul(l, r) => format!("({} × {})", self.visit(l), self.visit(r)),
            Expr::Neg(e)    => format!("(-{})", self.visit(e)),
        }
    }
}

// ─── Visitor 3: Optimizer ─────────────────────────────────────────────────
struct ConstantFolder;
impl ExprVisitor for ConstantFolder {
    type Output = Expr;
    fn visit(&self, expr: &Expr) -> Expr {
        match expr {
            // Fold: 0 + x = x, x + 0 = x
            Expr::Add(l, r) => {
                let l = self.visit(l); let r = self.visit(r);
                match (&l, &r) {
                    (Expr::Num(0.0), _) => r,
                    (_, Expr::Num(0.0)) => l,
                    (Expr::Num(a), Expr::Num(b)) => Expr::Num(a + b), // constant fold
                    _ => Expr::Add(Box::new(l), Box::new(r)),
                }
            }
            // Fold: 1 × x = x, x × 0 = 0
            Expr::Mul(l, r) => {
                let l = self.visit(l); let r = self.visit(r);
                match (&l, &r) {
                    (Expr::Num(n), _) if *n == 1.0 => r,
                    (_, Expr::Num(n)) if *n == 1.0 => l,
                    (Expr::Num(n), _) if *n == 0.0 => Expr::Num(0.0),
                    (Expr::Num(a), Expr::Num(b))   => Expr::Num(a * b),
                    _ => Expr::Mul(Box::new(l), Box::new(r)),
                }
            }
            Expr::Neg(e) => Expr::Neg(Box::new(self.visit(e))),
            other        => other.clone(),
        }
    }
}

fn main() {
    // Expression: (x + 0) × (2 + 3)
    let expr = Expr::Mul(
        Box::new(Expr::Add(
            Box::new(Expr::Var("x".into())),
            Box::new(Expr::Num(0.0)),
        )),
        Box::new(Expr::Add(
            Box::new(Expr::Num(2.0)),
            Box::new(Expr::Num(3.0)),
        )),
    );

    println!("Original: {}", PrettyPrinter.visit(&expr));
    // (x + 0) × (2 + 3)

    let optimized = ConstantFolder.visit(&expr);
    println!("Optimized: {}", PrettyPrinter.visit(&optimized));
    // (x × 5) — after folding 0+x=x and 2+3=5

    let mut vars = HashMap::new();
    vars.insert("x".to_string(), 10.0);
    println!("Evaluated: {:?}", Evaluator { vars: &vars }.visit(&optimized));
    // Ok(50.0)
}
```

---

## 9. Mediator — `tokio::sync::mpsc` Channel Hub

```rust
// ─── Chat room mediator ────────────────────────────────────────────────────
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
struct Message { from: String, content: String }

// Mediator: broadcast to all participants
struct ChatRoom {
    participants: Vec<(String, mpsc::Sender<Message>)>,
}

impl ChatRoom {
    pub fn new() -> Self { ChatRoom { participants: vec![] } }

    pub fn join(&mut self, name: &str) -> mpsc::Receiver<Message> {
        let (tx, rx) = mpsc::channel(100);
        self.participants.push((name.to_string(), tx));
        rx
    }

    pub async fn broadcast(&self, msg: Message) {
        for (name, tx) in &self.participants {
            if name != &msg.from {
                let _ = tx.send(msg.clone()).await;
            }
        }
    }
}
```

---

## 10. Memento — Serde Snapshot

```rust
// ─── Undo với serde snapshot ───────────────────────────────────────────────
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EditorState {
    content:  String,
    cursor:   usize,
    modified: bool,
}

struct Editor {
    state:   EditorState,
    history: Vec<String>, // JSON snapshots
}

impl Editor {
    pub fn save_snapshot(&mut self) {
        let json = serde_json::to_string(&self.state).unwrap();
        self.history.push(json);
    }

    pub fn restore_snapshot(&mut self) -> bool {
        match self.history.pop() {
            Some(json) => {
                self.state = serde_json::from_str(&json).unwrap();
                true
            }
            None => false,
        }
    }

    pub fn type_text(&mut self, text: &str) {
        self.save_snapshot();
        self.state.content.push_str(text);
        self.state.modified = true;
    }
}
```

---

## Behavioral Patterns — Cheat Sheet

| Pattern | Rust Approach | Key Insight |
|---------|--------------|-------------|
| Strategy | Closure `Fn` hoặc `Box<dyn Trait>` | Closures = first-class strategy |
| Observer | `broadcast::channel` (Tokio) | Channels solve ownership problem |
| State (runtime) | `enum` + `match` | Exhaustive match = safe transitions |
| State (compile) | Typestate + `PhantomData` | Invalid states = compile error 🔥 |
| Command | `Box<dyn Command>` + history Vec | Closure for simple, trait for undo |
| Template Method | Trait với default methods | Hooks = optional override |
| Iterator | `impl Iterator for T` | 80+ adapters, zero-cost fusion |
| Chain of Resp | `Vec<Box<dyn Middleware>>` | Recursive pipeline runner |
| Visitor | `match` on enum (idiomatic) | Enum + match > visitor class hierarchy |
| Mediator | `mpsc::channel` | Channel = natural mediator |
| Memento | `#[derive(Serialize)]` + snapshot Vec | Serde = free memento |
| Interpreter | Recursive `enum Expr` | AST = Rust enum, eval = recursion |

---

## 🔗 Links
- [[Design-Patterns-Rust/00-Overview|Series Overview]]
- [[Design-Patterns-Rust/02-Structural|← 02 · Structural Patterns]]
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9: Tokio Async]]
- [[Rust-Zero-To-Hero/Bai-22-Advanced-Concurrency|Bài 22: Advanced Concurrency]]

*Tags: #rust #design-patterns #behavioral #gof #typestate*
