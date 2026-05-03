# Level 3 · Architecture Patterns

> *"Code scales" — Đây là level thiết kế hệ thống lớn bằng Rust. Handle/Arena giải quyết lifetime hell trong graph structures. Blanket impl tạo behavior automatically. Error hierarchy structuring cho production systems.*

---

## 1. Handle / Arena Pattern — Escape Lifetime Hell

### Vấn Đề: Graph với Cyclic References

```
Node A trỏ đến Node B, Node B trỏ đến Node A
→ Rc<RefCell<Node>> + Weak<RefCell<Node>> = boilerplate nightmare
→ Lifetime annotations phức tạp khi có cycles
→ Arc<Mutex<Node>> cho multi-thread = lock contention
```

### Solution: Index as Handle

```rust
// ─── Core idea: store all nodes in Vec, reference by index ────────────────
//
//  Thay vì:                    Dùng:
//  Node { next: &Node }        Node { next: NodeId }
//  (lifetime hell)             (no lifetimes — just usize)

// ─── Arena: typed Vec wrapper ─────────────────────────────────────────────
use std::ops::{Index, IndexMut};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeId(usize);

#[derive(Debug)]
pub struct Arena<T> {
    nodes: Vec<T>,
}

impl<T> Arena<T> {
    pub fn new() -> Self { Arena { nodes: vec![] } }

    pub fn alloc(&mut self, value: T) -> NodeId {
        let id = NodeId(self.nodes.len());
        self.nodes.push(value);
        id
    }

    pub fn get(&self, id: NodeId) -> Option<&T>     { self.nodes.get(id.0) }
    pub fn get_mut(&mut self, id: NodeId) -> Option<&mut T> { self.nodes.get_mut(id.0) }
}

impl<T> Index<NodeId> for Arena<T> {
    type Output = T;
    fn index(&self, id: NodeId) -> &T { &self.nodes[id.0] }
}
impl<T> IndexMut<NodeId> for Arena<T> {
    fn index_mut(&mut self, id: NodeId) -> &mut T { &mut self.nodes[id.0] }
}

// ─── Use case 1: Workflow graph (PDMS) ────────────────────────────────────
#[derive(Debug, Clone)]
struct WorkflowNode {
    name:      String,
    node_type: NodeType,
    next:      Vec<NodeId>,   // edges by ID — no lifetime issues!
    prev:      Vec<NodeId>,   // can have cycles freely
}

#[derive(Debug, Clone)]
enum NodeType { Start, Task(String), Gateway, End }

struct WorkflowGraph {
    arena: Arena<WorkflowNode>,
    root:  NodeId,
}

impl WorkflowGraph {
    pub fn new(name: &str) -> Self {
        let mut arena = Arena::new();
        let root = arena.alloc(WorkflowNode {
            name:      name.to_string(),
            node_type: NodeType::Start,
            next: vec![],
            prev: vec![],
        });
        WorkflowGraph { arena, root }
    }

    pub fn add_task(&mut self, name: &str, after: NodeId) -> NodeId {
        let task = self.arena.alloc(WorkflowNode {
            name:      name.to_string(),
            node_type: NodeType::Task(name.to_string()),
            next: vec![],
            prev: vec![after],
        });
        self.arena[after].next.push(task);
        task
    }

    pub fn add_edge(&mut self, from: NodeId, to: NodeId) {
        self.arena[from].next.push(to);
        self.arena[to].prev.push(from);
    }

    pub fn dfs(&self, start: NodeId, visited: &mut Vec<NodeId>) {
        if visited.contains(&start) { return; } // handle cycles
        visited.push(start);
        let nexts: Vec<NodeId> = self.arena[start].next.clone();
        for next in nexts {
            self.dfs(next, visited);
        }
    }

    pub fn print_path(&self, start: NodeId) {
        let mut visited = vec![];
        self.dfs(start, &mut visited);
        for id in visited {
            println!("  → {}", self.arena[id].name);
        }
    }
}

fn main() {
    let mut wf = WorkflowGraph::new("Loan Approval");
    let submit   = wf.add_task("Submit Application",  wf.root);
    let validate = wf.add_task("Validate Documents",  submit);
    let review   = wf.add_task("Credit Review",       validate);
    let approve  = wf.add_task("Approve",              review);
    let reject   = wf.add_task("Reject",               review);

    // Cycle: reject → resubmit loop
    wf.add_edge(reject, submit);

    println!("Workflow path:");
    wf.print_path(wf.root);
}
```

```rust
// ─── Use case 2: Simple slot map (reusable slots) ─────────────────────────
// Cho phép "delete" node và reuse slot

#[derive(Debug)]
struct SlotMap<T> {
    slots:    Vec<Option<T>>,
    free:     Vec<usize>,
}

impl<T> SlotMap<T> {
    pub fn new() -> Self { SlotMap { slots: vec![], free: vec![] } }

    pub fn insert(&mut self, value: T) -> NodeId {
        if let Some(idx) = self.free.pop() {
            self.slots[idx] = Some(value);
            NodeId(idx)
        } else {
            let idx = self.slots.len();
            self.slots.push(Some(value));
            NodeId(idx)
        }
    }

    pub fn remove(&mut self, id: NodeId) -> Option<T> {
        let slot = self.slots.get_mut(id.0)?;
        let val  = slot.take();
        if val.is_some() { self.free.push(id.0); }
        val
    }

    pub fn get(&self, id: NodeId) -> Option<&T> {
        self.slots.get(id.0)?.as_ref()
    }
}
```

---

## 2. Type Erasure — dyn Trait vs impl Trait vs Enum Dispatch

### Ba Strategies, Ba Trade-offs

```
                  Binary Size  Heap Alloc  Runtime Dispatch  Heterogeneous
impl Trait        Larger       No          No (inlined)      No (1 type)
Box<dyn Trait>    Smaller      Yes (8B+)   Yes (vtable)      Yes
Enum dispatch     Medium       No          Yes (match)       Yes (known set)
```

### Prototype: Khi Nào Dùng Gì

```rust
// ─── impl Trait: khi caller không cần store/mix types ────────────────────
// Good: return type complex, but always same concrete type per call site
fn make_even_filter(threshold: i32) -> impl Fn(i32) -> bool {
    move |n| n % 2 == 0 && n > threshold
}
let filter = make_even_filter(10);
// filter type: [closure type] — not nameable, but zero-cost

// ─── Box<dyn Trait>: heterogeneous collection needed ─────────────────────
trait Plugin: Send + Sync {
    fn name(&self) -> &str;
    fn execute(&self, ctx: &Context) -> Result<(), PluginError>;
}

struct PluginRegistry {
    plugins: Vec<Box<dyn Plugin>>,  // different Plugin impls coexist
}

impl PluginRegistry {
    pub fn register(&mut self, plugin: Box<dyn Plugin>) {
        println!("Registered: {}", plugin.name());
        self.plugins.push(plugin);
    }
    pub fn run_all(&self, ctx: &Context) {
        for p in &self.plugins {
            if let Err(e) = p.execute(ctx) {
                eprintln!("[{}] Error: {:?}", p.name(), e);
            }
        }
    }
}

// ─── Enum dispatch: closed set, zero-cost, heterogeneous ─────────────────
// Better than Box<dyn> when set of types is known at compile time

#[derive(Debug, Clone)]
enum Notification {
    Email  { to: String, subject: String, body: String },
    Sms    { to: String, message: String },
    Push   { device_id: String, payload: String },
    Slack  { channel: String, text: String },
}

impl Notification {
    pub fn send(&self) -> Result<(), SendError> {
        match self {
            Notification::Email  { to, subject, body } => {
                println!("[EMAIL] {} | {}: {}", to, subject, body);
                Ok(())
            }
            Notification::Sms    { to, message } => {
                println!("[SMS] {}: {}", to, message);
                Ok(())
            }
            Notification::Push   { device_id, payload } => {
                println!("[PUSH] {}: {}", device_id, payload);
                Ok(())
            }
            Notification::Slack  { channel, text } => {
                println!("[SLACK] #{}: {}", channel, text);
                Ok(())
            }
        }
    }

    pub fn channel_name(&self) -> &str {
        match self {
            Notification::Email  { .. } => "email",
            Notification::Sms    { .. } => "sms",
            Notification::Push   { .. } => "push",
            Notification::Slack  { .. } => "slack",
        }
    }
}

// Vec<Notification> — no heap per item, homogeneous enum variants
let queue: Vec<Notification> = vec![
    Notification::Email { to: "a@b.com".into(), subject: "Hi".into(), body: "...".into() },
    Notification::Sms   { to: "+84xxx".into(), message: "Loan approved".into() },
];
```

---

## 3. Blanket Implementation — Generic Behavior for All

### Pattern

```rust
// impl<T: SomeTrait> AnotherTrait for T
// → Tất cả types impl SomeTrait sẽ auto-get AnotherTrait
```

### Prototype

```rust
// ─── Blanket impl: anything printable gets a log method ──────────────────
use std::fmt;

trait Loggable {
    fn log(&self, level: &str);
    fn info(&self)  { self.log("INFO"); }
    fn warn(&self)  { self.log("WARN"); }
    fn error(&self) { self.log("ERROR"); }
}

// Blanket: any Display type gets Loggable for free
impl<T: fmt::Display> Loggable for T {
    fn log(&self, level: &str) {
        println!("[{}] {}", level, self);
    }
}

// Now ALL Display types have .info() .warn() .error():
42_u32.info();                              // [INFO] 42
"connection refused".error();              // [ERROR] connection refused
"high memory usage".warn();                // [WARN] high memory usage

// ─── Blanket impl: Serializable gets storage methods ─────────────────────
use serde::{Serialize, Deserialize};

trait Persistable: Serialize {
    fn to_json(&self) -> String {
        serde_json::to_string(self).expect("serialize failed")
    }
    fn to_json_pretty(&self) -> String {
        serde_json::to_string_pretty(self).expect("serialize failed")
    }
    fn save_to_file(&self, path: &str) -> std::io::Result<()> {
        std::fs::write(path, self.to_json())
    }
}

// Blanket: anything Serialize gets Persistable
impl<T: Serialize> Persistable for T {}

#[derive(Serialize, Deserialize, Debug)]
struct LoanRecord { id: u64, amount: u64 }

let loan = LoanRecord { id: 1, amount: 50_000_000 };
println!("{}", loan.to_json()); // via blanket Persistable
loan.save_to_file("loan.json").unwrap();

// ─── std's famous blanket impl ────────────────────────────────────────────
// impl<T: Display> ToString for T  ← any Display type gets .to_string()
// impl<T, U: Into<T>> From<U> for T  ← reflexive: every type converts to itself
```

---

## 4. Error Hierarchy — Production Error Design

### Two-Layer Strategy

```
Library layer: thiserror — structured, matchable, typed
Application layer: anyhow — ergonomic, context-rich, no boilerplate

Rule: Libraries expose thiserror types
      Binaries (main.rs, handlers) use anyhow
```

### Prototype: PDMS Error System

```rust
// ─── Layer 1: Domain errors (thiserror) ──────────────────────────────────
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DocumentError {
    #[error("document {id} not found")]
    NotFound { id: String },

    #[error("document {id} is locked by user {locked_by}")]
    Locked { id: String, locked_by: String },

    #[error("invalid document format: {reason}")]
    InvalidFormat { reason: String },

    #[error("storage error")]
    Storage(#[from] StorageError),    // auto From<StorageError>

    #[error("permission denied: user {user} cannot {action} document {doc}")]
    PermissionDenied { user: String, action: String, doc: String },
}

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("connection pool exhausted")]
    PoolExhausted,
}

// ─── Layer 2: Service errors composing domain errors ─────────────────────
#[derive(Debug, Error)]
pub enum LoanServiceError {
    #[error("document error: {0}")]
    Document(#[from] DocumentError),

    #[error("cif service unavailable: {0}")]
    CifUnavailable(String),

    #[error("insufficient credit score: {score} < {required}")]
    InsufficientCredit { score: u32, required: u32 },

    #[error("duplicate loan application")]
    Duplicate,
}

// ─── Layer 3: Application handlers use anyhow ────────────────────────────
use anyhow::{Context, Result, bail, ensure};

async fn handle_approve_loan(loan_id: &str, approver: &str) -> Result<()> {
    // anyhow::Result = Result<T, anyhow::Error>
    // .context() adds human-readable context to any error

    let loan = loan_repo.find(loan_id)
        .await
        .context(format!("fetching loan {}", loan_id))?;

    ensure!(loan.status == LoanStatus::UnderReview,
        "loan {} is not in review status: {:?}", loan_id, loan.status);

    if loan.amount > 1_000_000_000 {
        bail!("loans over 1B VND require committee approval");
    }

    loan_service.approve(&loan, approver)
        .await
        .with_context(|| format!("approving loan {} by {}", loan_id, approver))?;

    Ok(())
}

// ─── Pattern: Error with metadata ─────────────────────────────────────────
#[derive(Debug, Error)]
pub struct HttpError {
    pub status:  u16,
    pub message: String,
    #[source]
    pub source:  Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "HTTP {} — {}", self.status, self.message)
    }
}

impl HttpError {
    pub fn not_found(msg: impl Into<String>) -> Self {
        HttpError { status: 404, message: msg.into(), source: None }
    }
    pub fn internal(msg: impl Into<String>, err: impl std::error::Error + Send + Sync + 'static) -> Self {
        HttpError { status: 500, message: msg.into(), source: Some(Box::new(err)) }
    }
}
```

---

## 5. Zero-Sized Types (ZST) — Markers and Tags

### ZST = 0 bytes at runtime, rich information at compile time

```rust
// ─── Marker structs ────────────────────────────────────────────────────────
struct Checked;     // 0 bytes — marks data has been validated
struct Unchecked;   // 0 bytes — marks data is raw input
struct Encrypted;   // 0 bytes — marks data is ciphertext
struct Plaintext;   // 0 bytes — marks data is readable

// PhantomData<State>: hold state type without storing it
use std::marker::PhantomData;

struct Data<State> {
    payload: Vec<u8>,
    _state:  PhantomData<State>,
}

impl Data<Unchecked> {
    pub fn new(raw: Vec<u8>) -> Self {
        Data { payload: raw, _state: PhantomData }
    }

    pub fn validate(self) -> Result<Data<Checked>, &'static str> {
        if self.payload.is_empty() {
            return Err("empty payload");
        }
        // ... more validation
        Ok(Data { payload: self.payload, _state: PhantomData })
    }
}

impl Data<Checked> {
    // Only Checked data can be encrypted
    pub fn encrypt(self, key: &[u8]) -> Data<Encrypted> {
        let encrypted = xor_encrypt(&self.payload, key); // simplified
        Data { payload: encrypted, _state: PhantomData }
    }
    pub fn payload(&self) -> &[u8] { &self.payload }
}

impl Data<Encrypted> {
    pub fn decrypt(self, key: &[u8]) -> Data<Plaintext> {
        let decrypted = xor_encrypt(&self.payload, key);
        Data { payload: decrypted, _state: PhantomData }
    }
}

fn xor_encrypt(data: &[u8], key: &[u8]) -> Vec<u8> {
    data.iter().zip(key.iter().cycle()).map(|(b, k)| b ^ k).collect()
}

fn process(data: Data<Checked>) {
    // Only callable with Checked data — type system enforces
    println!("Processing {} bytes", data.payload().len());
}

fn main() {
    let raw = Data::<Unchecked>::new(vec![1, 2, 3]);
    // process(raw); ← compile error: expected Checked, got Unchecked

    let checked = raw.validate().expect("valid");
    process(checked); // OK

    // ZST: size_of::<Data<Checked>>() == size_of::<Vec<u8>>() == 24 bytes
    // PhantomData<Checked> adds ZERO bytes!
}
```

---

## 6. Module Sealing — Internal API Boundary

### Pattern: pub(crate) + pub(super)

```rust
// ─── PDMS: Public API vs Internal ────────────────────────────────────────
pub mod loan {
    // Public: external consumers
    pub struct LoanApplication { /* ... */ }
    pub trait LoanRepository { /* ... */ }

    // pub(crate): internal to this crate, not in public API
    pub(crate) struct LoanValidator { /* ... */ }
    pub(crate) fn compute_score(cif: &str) -> u32 { /* ... */ }

    // pub(super): internal to parent module
    pub(super) struct InternalAuditLog { /* ... */ }

    mod scoring {
        // Private module — only accessible within loan module
        pub(super) fn credit_score(history: &[Payment]) -> u32 { /* ... */ }
    }
}

pub mod api {
    use super::loan::{LoanApplication, LoanRepository};
    // use super::loan::LoanValidator; ← compile error if external crate

    pub async fn handle_apply(/* ... */) { /* ... */ }
}
```

---

## Level 3 Checklist

```
□ Graph/tree với cycles → Arena + NodeId (không Rc<RefCell<...>>)
□ Closed type set → Enum dispatch (không Box<dyn Trait>)
□ Open type set → Box<dyn Trait> (plugin systems)
□ Blanket impl để auto-provide behavior cho trait family
□ thiserror cho library errors, anyhow cho application code
□ ZST PhantomData để encode state without runtime overhead
□ pub(crate) / pub(super) để modularize internal API
□ Error hierarchy: domain → service → handler layers
```

---

## 🔗 Links
- [[Design-Patterns-Rust/06-Level2-Idiomatic|← Level 2 · Idiomatic]]
- [[Design-Patterns-Rust/08-Level4-TypeSystem|Level 4 · Type System Mastery →]]

*Tags: #rust #patterns #level3 #architecture #arena #type-erasure #blanket-impl*
