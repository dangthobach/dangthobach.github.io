# Rust Performance Pitfalls: Sai Lầm Phổ Biến & Cách Tối Ưu

> **Mục tiêu:** Hiểu *tại sao* code Rust chậm/tốn memory — dựa trên ownership model, allocator, LLVM IR, async runtime (Tokio). Mỗi pitfall có prototype minh hoạ, số liệu benchmark thực tế, và fix chuẩn. Đây là nội dung **khác** Bài 17 (zero-cost abstractions) — tập trung vào sai lầm mà ngay cả Rust developer kinh nghiệm vẫn hay mắc.

---

## Mental Model: Rust Memory Layout

```
┌─────────────────────────────────────────────────────────────┐
│                     Rust Memory                             │
│                                                             │
│  Stack                    Heap (jemalloc / system malloc)   │
│  ┌──────────────┐         ┌────────────────────────────┐   │
│  │ local vars   │         │ String/Vec data             │   │
│  │ fn params    │──ptr──▶ │ Box<T> contents             │   │
│  │ return addr  │         │ Arc<T> + ref count          │   │
│  │ ~2MB limit   │         │ async Future state machine  │   │
│  └──────────────┘         └────────────────────────────┘   │
│                                                             │
│  NO GC: Drop trait = deterministic destructor               │
│  Ownership: compiler tracks lifetime → no runtime cost      │
│  Zero-cost: abstraction compile away → C-equivalent         │
└─────────────────────────────────────────────────────────────┘
```

**Key insight:** Rust không có GC — nhưng vẫn có allocator. Heap allocation vẫn tốn ~50-100ns. Clone vẫn copy bytes. Trait objects vẫn có vtable. Arc vẫn có atomic. Async futures vẫn có state machine overhead. Đây là những "hidden costs" phổ biến nhất.

---

## Pitfall 1: Clone Thay Vì Borrow — Expensive & Unnecessary

### Tại sao xảy ra

Khi gặp borrow checker error, developer mới thường `.clone()` để "giải quyết nhanh". Clone = full deep copy lên heap.

```
String::clone() với "hello world":
  1. malloc(11 bytes) → heap allocation
  2. memcpy(11 bytes) → copy data
  3. Đến khi drop: dealloc(ptr) → heap deallocation
  
Cost: 50-100ns per clone vs 0ns for &str borrow
```

### Prototype: Các Dạng Clone Không Cần Thiết

```rust
#[derive(Clone)]
struct User {
    name: String,
    email: String,
}

// ❌ CASE 1: Clone để pass vào function
fn greet(name: String) {  // takes owned String
    println!("Hello, {}", name);
}

fn bad_usage(user: &User) {
    greet(user.name.clone()); // allocation! chỉ để println
}

// ✅ FIX: Nhận &str
fn greet_fixed(name: &str) {  // borrows str slice
    println!("Hello, {}", name);
}

fn good_usage(user: &User) {
    greet_fixed(&user.name); // zero-cost borrow
}

// ❌ CASE 2: Clone trong closure capture
fn process_users(users: Vec<User>) {
    let prefix = String::from("user_"); // expensive prefix
    users.iter().for_each(|u| {
        let key = prefix.clone() + &u.name; // N clones của prefix!
        cache.insert(key, u);
    });
}

// ✅ FIX: Move hay borrow hợp lý
fn process_users_fixed(users: Vec<User>) {
    let prefix = "user_"; // &str, zero alloc
    users.iter().for_each(|u| {
        let key = format!("{}{}", prefix, u.name); // 1 alloc cho kết quả
        cache.insert(key, u);
    });
}

// ❌ CASE 3: Clone toàn bộ struct để mutate 1 field
fn update_email(user: &User, new_email: &str) -> User {
    let mut updated = user.clone(); // clone toàn bộ User!
    updated.email = new_email.to_string();
    updated
}

// ✅ FIX: Tạo struct mới chỉ với field cần thiết
// hoặc dùng builder pattern / &mut receiver
fn update_email_fixed(user: &mut User, new_email: &str) {
    user.email = new_email.to_string(); // in-place mutation
}
```

### Benchmark

```rust
use criterion::{criterion_group, criterion_main, Criterion};

fn bench_clone(c: &mut Criterion) {
    let user = User { name: "Nguyen Van Bach".into(), email: "bach@vpbank.com".into() };

    c.bench_function("clone + pass", |b| {
        b.iter(|| greet(user.name.clone()))
    });
    c.bench_function("borrow &str", |b| {
        b.iter(|| greet_fixed(&user.name))
    });
}
/*
clone + pass  time: [87.3 ns 88.1 ns 89.0 ns]   ← heap alloc + copy
borrow &str   time: [ 1.2 ns  1.3 ns  1.4 ns]   ← register/pointer
→ 68x slower khi clone không cần thiết
*/
```

---

## Pitfall 2: String Allocation Patterns — &str vs String vs Cow

### Anatomy của String vs &str

```
&str:  fat pointer (ptr, len) — 16 bytes trên stack
       ↓ trỏ vào
       string data (không owned — có thể ở stack/heap/bss)

String: (ptr, len, capacity) — 24 bytes trên stack
        ↓ trỏ vào
        heap allocated UTF-8 data
```

### Prototype: Sai Lầm Phổ Biến

```rust
// ❌ BAD: Function nhận String khi chỉ cần đọc
fn is_valid_email(email: String) -> bool {  // caller phải clone hoặc move
    email.contains('@')
}

// ✅ GOOD: &str cho read-only string operations
fn is_valid_email(email: &str) -> bool {  // works với &String, &str, literals
    email.contains('@')
}

// ❌ BAD: Tạo String từ literal (unnecessary allocation)
fn get_default_role() -> String {
    String::from("viewer")  // heap alloc cho static string
}

// ✅ GOOD: &'static str cho static/literal strings
fn get_default_role() -> &'static str {
    "viewer"  // zero allocation, lives in binary .rodata
}

// ❌ BAD: format! thừa
fn build_path(dir: &str, file: &str) -> String {
    format!("{}/{}", dir, file)  // 1 alloc — OK thực ra
}

// Khi cần nhiều nối:
// ❌ BAD: Multi-step allocation
let s = format!("{}", a) + &format!("{}", b) + &format!("{}", c);

// ✅ GOOD: Single format với tất cả args
let s = format!("{}{}{}", a, b, c);

// ✅ BEST: write! vào buffer pre-allocated
use std::fmt::Write;
let mut s = String::with_capacity(64);
write!(s, "{}{}{}", a, b, c).unwrap(); // zero realloc nếu capacity đủ
```

### Cow<str> — Clone Chỉ Khi Cần Thiết

```rust
use std::borrow::Cow;

// Smart enum: Borrowed (zero-cost) hoặc Owned (heap alloc khi cần)
fn sanitize(input: &str) -> Cow<str> {
    if input.chars().all(|c| c.is_alphanumeric() || c == '_') {
        Cow::Borrowed(input)      // không cần modify → borrow, zero alloc
    } else {
        // Chỉ allocate khi thực sự cần escape
        Cow::Owned(
            input.chars()
                 .filter(|c| c.is_alphanumeric() || *c == '_')
                 .collect()
        )
    }
}

// Caller: Cow<str> derefs thành &str tự động
let clean = sanitize("hello_world");  // Cow::Borrowed — 0 alloc
let clean = sanitize("hello world!"); // Cow::Owned — 1 alloc

// Pattern phổ biến: config value có thể default hoặc override
fn get_config_val<'a>(key: &str, defaults: &'a HashMap<String, String>) -> Cow<'a, str> {
    match defaults.get(key) {
        Some(v) => Cow::Borrowed(v.as_str()),
        None    => Cow::Owned(compute_default(key)),
    }
}
```

---

## Pitfall 3: Box, Rc, Arc Overuse

### Chi Phí Của Mỗi Smart Pointer

```
T (stack):           0 overhead — fastest
&T / &mut T:         0 overhead — fat pointer nếu unsized
Box<T>:              heap alloc(size_of::<T>) — pointer trên stack
Rc<T>:               heap alloc(size_of::<T> + 2*usize) — ref count (non-atomic)
Arc<T>:              heap alloc(size_of::<T> + 2*usize) — ATOMIC ref count
                     → CAS operation trên mỗi clone/drop (~10ns vs ~1ns)
Mutex<T>:            OS futex, uncontended ~20ns, contended ~microseconds
```

### Prototype: Arc Overuse

```rust
use std::sync::Arc;

// ❌ BAD: Arc khi không cần shared ownership
fn process_config(config: Arc<Config>) {
    // Chỉ 1 goroutine dùng config này
    // Arc clone atomic increment mỗi khi pass vào function
    do_work(config.clone()); // atomic op + heap pressure
}

// ✅ GOOD: &Config — borrow, zero cost
fn process_config(config: &Config) {
    do_work(config);
}

// ❌ BAD: Arc<Vec<T>> cho read-only data
fn spawn_workers(data: Vec<Item>) {
    let shared = Arc::new(data);
    for _ in 0..8 {
        let d = shared.clone(); // atomic increment × 8
        tokio::spawn(async move {
            process(&d);
        });
    }
}

// ✅ GOOD: Arc<[T]> hay Arc<Vec<T>> là OK cho cross-thread share
// NHƯNG nếu data immutable và lifetime đủ → prefer &'static hay scoped threads
fn spawn_workers_fixed(data: &'static [Item]) {
    for _ in 0..8 {
        tokio::spawn(async move {
            process(data); // borrow từ static, zero overhead
        });
    }
}

// ❌ BAD: Rc trong tree khi Box đủ
// Nếu không cần shared ownership, Box<T> cheaper hơn Rc<T>
enum Tree {
    Leaf(i32),
    Node(Rc<Tree>, Rc<Tree>),  // Rc = alloc + ref count
}

// ✅ GOOD: Box khi parent owns children exclusively
enum Tree {
    Leaf(i32),
    Node(Box<Tree>, Box<Tree>), // simpler, faster
}
```

### Khi Nào Thực Sự Cần Arc

```rust
// ✅ Legitimate Arc use: shared mutable state across async tasks
use tokio::sync::RwLock;

struct AppState {
    cache: Arc<RwLock<HashMap<String, Value>>>,
    config: Arc<Config>, // immutable shared
}

// Arc<RwLock<T>>: pattern chuẩn cho shared mutable state trong async
// Arc<Mutex<T>>: khi cần exclusive access
// Arc<T>: khi T immutable và cần share across threads
```

---

## Pitfall 4: Trait Objects vs Generics — Dynamic vs Static Dispatch

### Tại Sao Quan Trọng

```
Static dispatch (impl Trait / generics):
  → Monomorphization tại compile time
  → Compiler inline function calls
  → Không vtable lookup
  → Cost: larger binary (duplicate code per type)

Dynamic dispatch (dyn Trait):
  → Vtable pointer stored với object
  → Indirect call qua pointer → branch misprediction
  → Compiler KHÔNG thể inline
  → Cost: ~3-5ns per call (vs ~1ns static)
```

### Prototype

```rust
trait Processor {
    fn process(&self, data: &[u8]) -> Vec<u8>;
}

struct GzipProcessor;
struct AesProcessor;
impl Processor for GzipProcessor { ... }
impl Processor for AesProcessor { ... }

// ❌ BAD: dyn Trait trong hot path → virtual dispatch mọi call
fn compress_all(items: &[Vec<u8>], proc: &dyn Processor) -> Vec<Vec<u8>> {
    items.iter().map(|item| proc.process(item)).collect()
    //                         ^^^^^ vtable lookup mỗi iteration
}

// ✅ GOOD: Generic — monomorphized → static dispatch + inlining
fn compress_all<P: Processor>(items: &[Vec<u8>], proc: &P) -> Vec<Vec<u8>> {
    items.iter().map(|item| proc.process(item)).collect()
    // Compiler tạo separate function cho GzipProcessor và AesProcessor
    // Mỗi call được inlined → có thể SIMD optimize
}

// Khi nào dùng dyn Trait?
// ✅ Khi list processors khác type cần store cùng nhau:
let processors: Vec<Box<dyn Processor>> = vec![
    Box::new(GzipProcessor),
    Box::new(AesProcessor),
];
// ✅ Khi return type cần erasure (trait object in return position)
fn make_processor(kind: &str) -> Box<dyn Processor> {
    match kind {
        "gzip" => Box::new(GzipProcessor),
        "aes"  => Box::new(AesProcessor),
        _      => panic!("unknown"),
    }
}

// Enum dispatch — zero-cost alternative to dyn Trait khi types known:
enum ProcessorKind {
    Gzip(GzipProcessor),
    Aes(AesProcessor),
}
impl Processor for ProcessorKind {
    fn process(&self, data: &[u8]) -> Vec<u8> {
        match self {
            ProcessorKind::Gzip(p) => p.process(data),
            ProcessorKind::Aes(p)  => p.process(data),
        }
    }
}
// Enum dispatch = static dispatch + no heap alloc cho wrapper
```

---

## Pitfall 5: HashMap Default Hasher — SipHash Quá An Toàn

### Tại Sao SipHash Chậm

Go và Rust cả hai dùng SipHash mặc định — được thiết kế để chống HashDoS attack (adversarial inputs làm hash degenerate). Nhưng SipHash có overhead:

```
SipHash-1-3:  ~10-15 cycles per hash
FxHash:        ~2-3  cycles per hash
AHash:         ~4-6  cycles per hash (hardware AES)
→ SipHash 2-5x chậm hơn cho numeric keys, string keys ngắn
```

### Prototype

```rust
use std::collections::HashMap;

// ❌ Default: SipHash (secure nhưng chậm)
let mut map: HashMap<u64, Record> = HashMap::new();
// HashDoS protection không cần thiết khi keys từ trusted source

// ✅ FxHashMap — cực nhanh, non-cryptographic
use rustc_hash::FxHashMap;  // cargo add rustc-hash
let mut map: FxHashMap<u64, Record> = FxHashMap::default();

// ✅ AHashMap — hardware AES, fast + HashDoS resistant
use ahash::AHashMap;  // cargo add ahash
let mut map: AHashMap<String, Record> = AHashMap::new();

// Type alias pattern cho dễ swap:
type FastMap<K, V> = ahash::HashMap<K, V>;
// Sau đó dùng FastMap<K, V> thay vì HashMap<K, V> toàn codebase

/*
HashMap (SipHash):  insert 1M i64 keys  → 890ms
FxHashMap:          insert 1M i64 keys  → 280ms  (3.2x faster)
AHashMap:           insert 1M i64 keys  → 320ms  (2.8x faster, safer)

Khi nào giữ SipHash:
  - Key từ user input / external (HashDoS risk)
  - String keys dài (SipHash amortize tốt hơn)
  - Security-critical code
*/
```

---

## Pitfall 6: Async Pitfalls — Blocking Trong Async Context

### Tại Sao Blocking Là Thảm Họa Trong Tokio

```
Tokio runtime: N worker threads (default = CPU count)
Mỗi thread chạy event loop — không block

Khi 1 task block thread OS:
  → Thread không thể chạy bất kỳ task nào khác
  → Nếu tất cả N threads bị block → entire runtime stalled
  → Requests pending mãi mãi
```

### Prototype

```rust
// ❌ CASE 1: Synchronous I/O trong async function
async fn load_user(id: u64) -> Result<User> {
    let content = std::fs::read_to_string("users.json")?;  // BLOCKS thread!
    // Tokio worker thread bị block trong lúc disk I/O
    parse_user(&content, id)
}

// ✅ FIX: Tokio async I/O
async fn load_user(id: u64) -> Result<User> {
    let content = tokio::fs::read_to_string("users.json").await?;  // async!
    parse_user(&content, id)
}

// ❌ CASE 2: std::sync::Mutex trong async function
async fn update_cache(key: String, val: Value) {
    let mut cache = GLOBAL_CACHE.lock().unwrap();  // blocks if contended!
    cache.insert(key, val);
    // Giữ lock trong suốt await? Deadlock risk + thread starvation
}

// ✅ FIX: tokio::sync::Mutex cho async context
use tokio::sync::Mutex;
async fn update_cache(key: String, val: Value) {
    let mut cache = GLOBAL_CACHE.lock().await;  // yields task, không block thread
    cache.insert(key, val);
}

// ❌ CASE 3: CPU-intensive work trong async
async fn process_image(data: Vec<u8>) -> Vec<u8> {
    compress_image(&data)  // 200ms CPU work — blocks entire runtime!
}

// ✅ FIX: spawn_blocking để chạy trên dedicated thread pool
async fn process_image(data: Vec<u8>) -> Vec<u8> {
    tokio::task::spawn_blocking(move || {
        compress_image(&data)  // runs on blocking thread pool (rayon-like)
    })
    .await
    .unwrap()
}

// ❌ CASE 4: thread::sleep trong async
async fn retry_with_delay() {
    std::thread::sleep(Duration::from_secs(1));  // blocks thread!
}

// ✅ FIX: tokio::time::sleep
async fn retry_with_delay() {
    tokio::time::sleep(Duration::from_secs(1)).await;  // yields task
}
```

### Pitfall: Giữ Lock/MutexGuard Qua .await

```rust
// ❌ BAD: MutexGuard chứa .await → future size = lock size, potential deadlock
async fn bad_pattern(state: Arc<Mutex<State>>) {
    let guard = state.lock().await;     // lock acquired
    let result = fetch_data().await;    // await với lock held!
    guard.data = result;                // finally release
    // Vấn đề: nếu fetch_data slow → lock giữ cả thời gian → contention
}

// ✅ GOOD: Drop lock trước khi await
async fn good_pattern(state: Arc<Mutex<State>>) {
    let result = fetch_data().await;    // await TRƯỚC khi acquire lock
    let mut guard = state.lock().await; // acquire lock ngắn nhất có thể
    guard.data = result;
}  // guard dropped here

// ✅ GOOD: Scope nhỏ nhất cho lock
async fn best_pattern(state: Arc<Mutex<State>>) {
    let result = fetch_data().await;
    {
        let mut guard = state.lock().await;
        guard.data = result;
    } // lock released ngay tại đây
    // Có thể tiếp tục làm việc khác không cần lock
}
```

---

## Pitfall 7: Memory Layout — Padding & Cache Efficiency

### Cache Line & False Sharing

```
CPU cache line = 64 bytes
Cache miss penalty: L1 hit ~4 cycles, L2 ~12 cycles, RAM ~200 cycles

False sharing: 2 threads write to different fields TRONG CÙNG cache line
→ Cache coherence protocol → cacheline bouncing → performance degradation
```

### Prototype

```rust
// ❌ BAD: Struct padding waste
#[repr(C)]  // hoặc default Rust repr
struct BadLayout {
    a: u8,    // 1 byte
              // 7 bytes padding
    b: u64,   // 8 bytes
    c: u8,    // 1 byte
              // 7 bytes padding
}             // = 24 bytes total!

// ✅ GOOD: Fields lớn trước nhỏ sau (Rust default repr đã tối ưu)
struct GoodLayout {
    b: u64,   // 8 bytes
    a: u8,    // 1 byte
    c: u8,    // 1 byte
              // 6 bytes padding
}             // = 16 bytes total

// Verify với:
println!("{}", std::mem::size_of::<BadLayout>());  // 24
println!("{}", std::mem::size_of::<GoodLayout>()); // 16

// ❌ BAD: False sharing trong multi-threaded counter
struct SharedCounters {
    reads:  AtomicU64,  // bytes 0-7
    writes: AtomicU64,  // bytes 8-15    ← CÙNG cache line!
}
// Thread 1 update reads, Thread 2 update writes
// → cache line bouncing giữa L1 caches

// ✅ GOOD: Cache line padding
#[repr(C)]
struct AlignedCounter {
    reads:   AtomicU64,
    _pad1:   [u8; 56], // pad to 64 bytes (1 cache line)
    writes:  AtomicU64,
    _pad2:   [u8; 56], // pad writes to own cache line
}
// Dùng thư viện crossbeam::CachePadded<T> cho tiện:
use crossbeam::utils::CachePadded;
struct BetterCounters {
    reads:  CachePadded<AtomicU64>,
    writes: CachePadded<AtomicU64>,
}
```

### Data-Oriented Design: AoS vs SoA

```rust
// Array of Structs (AoS) — OOP natural, cache-unfriendly khi process 1 field
struct Particle { x: f32, y: f32, z: f32, vx: f32, vy: f32, vz: f32, mass: f32 }
let particles: Vec<Particle> = vec![...];

// Cập nhật vị trí theo vận tốc — chỉ cần x,y,z,vx,vy,vz
// Nhưng load toàn bộ struct 28 bytes (chứa mass không cần)
for p in &mut particles {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
}

// ✅ Struct of Arrays (SoA) — cache-friendly khi batch processing
struct Particles {
    x:  Vec<f32>,   // contiguous x positions → 1 cache line = 16 particles
    y:  Vec<f32>,
    z:  Vec<f32>,
    vx: Vec<f32>,
    vy: Vec<f32>,
    vz: Vec<f32>,
    mass: Vec<f32>,
}

// Cập nhật x: iterate qua x và vx arrays liên tục → SIMD auto-vectorize
for i in 0..n {
    particles.x[i] += particles.vx[i] * dt;
}
// LLVM → AVX2: cập nhật 8 particles/cycle thay vì 1!
```

---

## Pitfall 8: Vec & Iterator Anti-patterns

### 8a. Collect Trung Gian Không Cần Thiết

```rust
// ❌ BAD: Collect vào Vec trung gian rồi iterate lại
fn process(items: &[Item]) -> Vec<Result> {
    let filtered: Vec<_> = items.iter()
        .filter(|i| i.is_active())
        .collect();      // heap alloc — chứa tất cả filtered items
    
    filtered.iter()
        .map(|i| transform(i))
        .collect()       // heap alloc thứ 2
}

// ✅ GOOD: Iterator fusion — compiler merge thành 1 pass, 1 alloc
fn process(items: &[Item]) -> Vec<Result> {
    items.iter()
        .filter(|i| i.is_active())
        .map(|i| transform(i))
        .collect()       // 1 alloc, 1 pass over data
}

// ❌ BAD: collect để đếm
let count = items.iter().filter(|i| i.is_active()).collect::<Vec<_>>().len();

// ✅ GOOD: count() adapter — O(1) space
let count = items.iter().filter(|i| i.is_active()).count();
```

### 8b. Vec Resize Liên Tục

```rust
// ❌ BAD: Không biết size trước → nhiều lần realloc
fn build_result(n: usize) -> Vec<u64> {
    let mut v = Vec::new();  // capacity=0
    for i in 0..n {
        v.push(compute(i)); // realloc tại 1, 2, 4, 8, 16... n
    }
    // Total reallocations: log2(n) ≈ 20 lần cho n=1M
    v
}

// ✅ GOOD: Pre-allocate với capacity
fn build_result_fast(n: usize) -> Vec<u64> {
    let mut v = Vec::with_capacity(n); // 1 alloc, no realloc
    for i in 0..n {
        v.push(compute(i));
    }
    v
}

// ✅ BEST: Nếu có thể dùng (0..n).map().collect() — compiler biết size
fn build_result_best(n: usize) -> Vec<u64> {
    (0..n).map(compute).collect() // ExactSizeIterator → with_capacity internally
}
```

### 8c. Retain vs Filter Into New Vec

```rust
// Khi cần modify existing Vec in-place:
// ❌ BAD: Filter + collect = new allocation
let v = v.iter().filter(|&&x| x > 0).cloned().collect::<Vec<_>>();

// ✅ GOOD: retain() — in-place filter, 0 extra allocation
v.retain(|&x| x > 0);  // O(n) time, O(1) extra space
```

---

## Pitfall 9: Regex & Pattern Matching Trong Hot Path

```rust
use regex::Regex;

// ❌ BAD: Compile regex mỗi lần gọi hàm
fn validate_email(email: &str) -> bool {
    let re = Regex::new(r"^[^@]+@[^@]+\.[^@]+$").unwrap(); // ~1ms compile!
    re.is_match(email)
}
// Nếu gọi 10,000 lần → 10 giây overhead

// ✅ GOOD: Lazy static hoặc OnceLock để compile 1 lần
use std::sync::OnceLock;

fn email_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[^@]+@[^@]+\.[^@]+$").unwrap())
}

fn validate_email(email: &str) -> bool {
    email_regex().is_match(email)  // compile xảy ra 1 lần duy nhất
}

// ✅ EVEN BETTER: Dùng once_cell::sync::Lazy (ergonomic)
use once_cell::sync::Lazy;
static EMAIL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^[^@]+@[^@]+\.[^@]+$").unwrap()
});
```

---

## Pitfall 10: Unnecessary Boxing & Indirection

### Box<dyn Error> Trong Hot Path

```rust
// ❌ BAD: Box<dyn Error> = heap alloc cho mỗi error path
fn parse_id(s: &str) -> Result<u64, Box<dyn std::error::Error>> {
    let id: u64 = s.parse()?;  // error boxed → heap alloc
    Ok(id)
}

// ✅ GOOD: Concrete error type hoặc thiserror
use thiserror::Error;
#[derive(Error, Debug)]
enum ParseError {
    #[error("invalid id: {0}")]
    InvalidId(#[from] std::num::ParseIntError),
}

fn parse_id(s: &str) -> Result<u64, ParseError> {
    Ok(s.parse()?)  // zero-cost error conversion, no boxing
}

// anyhow::Error — ergonomic nhưng có boxing cost
// ✅ OK cho application code (main.rs, handlers)
// ❌ Avoid trong library code hoặc hot path
```

### Recursive Types phải dùng Box

```rust
// Compiler cần biết size của type tại compile time
// ❌ Infinite size:
enum List {
    Cons(i32, List),  // compile error: recursive type has infinite size
    Nil,
}

// ✅ Box breaks the recursion — known size (pointer):
enum List {
    Cons(i32, Box<List>),  // Box<List> = 8 bytes (pointer)
    Nil,
}

// ✅ Nhiều trường hợp thực tế hơn — dùng enum variants để avoid Box:
// Thay vì linked list → dùng Vec<i32> — cache-friendly, no Box overhead
```

---

## Pitfall 11: Locks vs Atomics vs Lock-Free

```rust
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

// ❌ Mutex cho counter đơn giản — overkill
struct Counter {
    val: Mutex<u64>,
}
impl Counter {
    fn increment(&self) { *self.val.lock().unwrap() += 1; }
    fn get(&self) -> u64 { *self.val.lock().unwrap() }
}
// Uncontended Mutex: ~20-30ns (OS syscall overhead)

// ✅ Atomic cho single value — lock-free
struct Counter {
    val: AtomicU64,
}
impl Counter {
    fn increment(&self) { self.val.fetch_add(1, Ordering::Relaxed); }
    fn get(&self) -> u64 { self.val.load(Ordering::Relaxed) }
}
// AtomicU64 fetch_add: ~5-10ns (hardware CAS instruction)

// Ordering guide:
// Relaxed:  Fastest, no cross-thread synchronization guarantees
//           OK cho counter/stats (không quan trọng thứ tự)
// Acquire:  Read-side barrier — đảm bảo thấy tất cả writes trước corresponding Release
// Release:  Write-side barrier — đảm bảo tất cả writes trước đây visible
// AcqRel:   Cả Acquire và Release
// SeqCst:   Strongest, đắt nhất — global total order

// Rule of thumb:
// Counter/metrics:        Relaxed
// Flag để communicate:    Acquire/Release pair
// Nếu không chắc:         SeqCst (safe nhưng không optimal)
```

---

## Profiling Rust: Công Cụ Thực Chiến

```bash
# 1. cargo-flamegraph — nhìn thấy CPU hotspot
cargo install flamegraph
CARGO_PROFILE_RELEASE_DEBUG=true cargo flamegraph --bin myapp
# → flamegraph.svg: fat stack = nhiều time

# 2. cargo-instruments (macOS — Xcode Instruments integration)
cargo install cargo-instruments
cargo instruments -t time   # CPU Time Profiler
cargo instruments -t alloc  # Allocation Profiler

# 3. heaptrack — track tất cả heap allocations
# Linux only:
sudo apt install heaptrack
heaptrack target/release/myapp
heaptrack_gui heaptrack.myapp.*.gz

# 4. dhat — Rust allocator profiler (heap allocations)
# Cargo.toml:
# [profile.release]
# debug = 1
# dhat = "0.3"

# 5. criterion — micro-benchmark với statistical analysis
cargo bench -- --save-baseline before
# ... optimize ...
cargo bench -- --baseline before  # so sánh before vs after

# 6. Memory: Valgrind massif
valgrind --tool=massif target/debug/myapp
ms_print massif.out.* | head -50

# 7. Kiểm tra allocations nhanh:
# Thêm vào test:
#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;
fn main() {
    let _profiler = dhat::Profiler::new_heap();
    // run code
}
```

---

## Tips & Tricks Tổng Hợp

```rust
// 1. Prefer stack arrays khi size known, nhỏ
let buf = [0u8; 256];    // stack — zero alloc
// vs
let buf = vec![0u8; 256]; // heap — 1 alloc

// 2. SmallVec — stack cho nhỏ, heap khi overflow
use smallvec::SmallVec;
let mut v: SmallVec<[u8; 32]> = SmallVec::new();
// Stack nếu ≤ 32 bytes, tự động spill to heap khi cần

// 3. ArrayVec — fixed-capacity, không bao giờ heap
use arrayvec::ArrayVec;
let mut v: ArrayVec<u8, 32> = ArrayVec::new();
// Fail với CapacityError nếu full — phù hợp embedded/no_std

// 4. Tiered hashing với indexmap khi cần ordered
use indexmap::IndexMap;
let map: IndexMap<String, u32> = IndexMap::new(); // preserve insertion order

// 5. Tránh unwrap() trong production — prefer expect() với message
let val = opt.expect("config.database.url must be set");

// 6. Prefer is_empty() hơn len() == 0
if v.is_empty() { ... }  // Some collections O(1) is_empty, O(n) len

// 7. Drain thay vì clone-then-clear
let items: Vec<_> = buffer.drain(..).collect(); // move out, không clone
buffer.clear(); // buffer is now empty — không cần

// 8. Implement Display thay vì to_string repeatedly
impl fmt::Display for MyType { ... }
// Dùng {} trong format! sẽ call Display trực tiếp, không temp String

// 9. Tránh chained into() không cần thiết
let s: String = "hello".to_string();    // explicit — 1 alloc
let s: String = "hello".into();         // tương đương
let s = String::from("hello");          // tương đương, most explicit
// Dùng &str khi có thể — tất cả 3 cách trên đều alloc!

// 10. Profile trước khi optimize
// "Premature optimization is the root of all evil" — Knuth
// Measure: cargo bench, flamegraph
// Optimize: target dựa trên data
// Measure lại: verify improvement
```

---

## Quick Reference: Performance Checklist

| Category | ❌ Anti-Pattern | ✅ Fix | Impact |
|----------|----------------|--------|--------|
| Clone | `.clone()` để bypass borrow checker | Refactor lifetime, use `&T` | 50-100ns per clone |
| String | `String` param khi chỉ đọc | `&str` param | 0 alloc vs 1 alloc |
| String | `format!()` nhiều lần | `write!()` vào pre-allocated buffer | Nhiều alloc → 1 |
| Cow | String có thể borrowed | `Cow<str>` | Conditional alloc |
| Arc | Arc khi không cross-thread | `&T` hay `Rc<T>` | No atomic CAS |
| Dispatch | `dyn Trait` trong hot loop | `impl Trait` generic | vtable → inline |
| Dispatch | `dyn Trait` với known types | Enum dispatch | heap → stack |
| HashMap | SipHash cho trusted keys | AHash/FxHash | 2-5x faster |
| Async | `std::thread::sleep` | `tokio::time::sleep` | Thread starvation |
| Async | Blocking I/O trong async | `tokio::fs` / `spawn_blocking` | Runtime stall |
| Async | Mutex held across `.await` | Drop before await | Deadlock / contention |
| Layout | Unordered struct fields | Large → small ordering | 25-50% size reduction |
| Layout | AoS for batch processing | SoA → SIMD auto-vectorize | 8x throughput |
| Vec | `Vec::new()` + push in loop | `Vec::with_capacity(n)` | log2(n) reallocations |
| Iterator | Intermediate `.collect()` | Chain adapters | 2 allocs → 1 |
| Regex | Compile in function | `OnceLock` / `Lazy` | ~1ms → 0ns |
| Error | `Box<dyn Error>` hot path | `thiserror` concrete type | 1 alloc per error |
| Atomic | `Mutex` for single counter | `AtomicU64` | 30ns → 5ns |
| Atomic | `SeqCst` mặc định | Correct ordering | Memory fence overhead |

---

## 🔗 Links

- [[Rust-Zero-To-Hero/Bai-17-Zero-Cost-Performance|Bài 17: Zero-cost Abstractions cơ bản]]
- [[Rust-Zero-To-Hero/Bai-21-Async-Internals-Pin|Bài 21: Async Internals & Pin]]
- [[Rust-Zero-To-Hero/Bai-22-Advanced-Concurrency|Bài 22: Advanced Concurrency]]
- [[Go-Zero-To-Hero/Performance-Pitfalls-Go|Go: Performance Pitfalls (so sánh)]]

---

*Thực hành:*
1. Chạy `cargo build --release -Z timings` — xem thời gian compile từng crate (crate nào blocking parallel build?)
2. Thêm `dhat` allocator profiler vào project. Chạy một handler và đếm số allocations.
3. Tìm 1 function dùng `clone()`. Refactor sang `&str` hay lifetime. Benchmark trước/sau.
4. So sánh `HashMap::new()` vs `AHashMap::new()` trong benchmark với 100K string keys.
5. Tìm 1 `dyn Trait` trong hot path. Chuyển sang generic hoặc enum dispatch. Measure.
