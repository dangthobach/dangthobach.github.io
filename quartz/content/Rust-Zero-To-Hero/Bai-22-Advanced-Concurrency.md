# Bài 22: Advanced Concurrency — Atomics, Lock-free & Rayon

> **Java dev context:** Java concurrent package có `AtomicLong`, `ConcurrentHashMap`, `ForkJoinPool`. Rust có equivalents nhưng với ownership model rõ ràng hơn và không có GC interference. Bài này cover: memory ordering, lock-free patterns, và CPU-bound parallelism với rayon.

---

## 1. Memory Ordering — Điều Java Ẩn Khỏi Bạn

**Java `volatile` và `synchronized` ẩn đi memory ordering complexity. Rust buộc bạn explicit.**

```
CPU modern không execute instructions theo thứ tự bạn viết.
Cả compiler và CPU reorder instructions để optimize.
Memory ordering constraints tell compiler/CPU: "đừng reorder qua đây"

Java:
  volatile    → Sequential Consistency (strong, mọi thread thấy cùng order)
  synchronized → Sequential Consistency
  Java hide complexity phía sau

Rust Ordering enum:
  Relaxed    → Không constraint, chỉ atomic operation
  Acquire    → Load: thấy mọi write xảy ra trước Release ở thread khác
  Release    → Store: mọi write trước đây visible cho Acquire sau này
  AcqRel     → Acquire + Release (cho read-modify-write: compare_exchange)
  SeqCst     → Strongest: global total order — giống Java volatile
```

```rust
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};

// Counter thread-safe KHÔNG dùng Mutex
static COUNTER: AtomicI64 = AtomicI64::new(0);

fn increment() {
    COUNTER.fetch_add(1, Ordering::Relaxed);
    // Relaxed OK cho counter vì:
    // - Chỉ cần atomicity (không thể lost update)
    // - Không cần ordering với other data
}

fn get_count() -> i64 {
    COUNTER.load(Ordering::Relaxed)
}

// Spinlock đơn giản với Acquire/Release
struct SpinLock {
    locked: AtomicBool,
}

impl SpinLock {
    fn lock(&self) {
        while self.locked.compare_exchange(
            false, true,
            Ordering::Acquire,   // success: acquire — thấy writes của unlocker
            Ordering::Relaxed    // failure: không cần ordering
        ).is_err() {
            std::hint::spin_loop(); // CPU hint: đang spinning, có thể relax
        }
    }
    
    fn unlock(&self) {
        self.locked.store(false, Ordering::Release); // release — visible to next acquirer
    }
}
```

---

## 2. Ordering Decision Guide

```
Chọn Ordering theo use case:

INCREMENT COUNTER (không cần sync với other data):
  fetch_add(1, Relaxed) ✅

FLAG để signal thread khác đã ready data:
  Sender:   data_ptr.store(ptr, Release)     // "data is ready"
  Receiver: while data_ptr.load(Acquire) == null {} // "wait for data"

COMPARE-AND-SWAP (CAS loop):
  compare_exchange(old, new, AcqRel, Acquire)

SEQUENTIAL CONSISTENCY (expensive, cần global order):
  SeqCst — chỉ khi multiple atomics cần coordinated order
  Giống Java volatile, ~3-5x chậm hơn Relaxed

Rule of thumb:
  Relaxed → single counter/flag với no dependencies
  Acquire/Release → producer-consumer, flag → data dependency
  SeqCst → khi bạn không chắc (safe default, rồi optimize sau)
```

---

## 3. Lock-free Data Structures

### MPSC queue đơn giản (educational)

```rust
use std::sync::atomic::{AtomicPtr, Ordering};
use std::ptr;

struct Node<T> {
    data: T,
    next: AtomicPtr<Node<T>>,
}

struct LockFreeStack<T> {
    head: AtomicPtr<Node<T>>,
}

impl<T> LockFreeStack<T> {
    fn push(&self, data: T) {
        let node = Box::into_raw(Box::new(Node {
            data,
            next: AtomicPtr::new(ptr::null_mut()),
        }));
        
        loop {
            let current_head = self.head.load(Ordering::Relaxed);
            unsafe { (*node).next.store(current_head, Ordering::Relaxed); }
            
            // CAS: nếu head vẫn là current_head → set to node
            // Nếu CAS thất bại (racing thread thay đổi head) → retry
            if self.head.compare_exchange(
                current_head, node,
                Ordering::Release,
                Ordering::Relaxed
            ).is_ok() {
                break;
            }
        }
    }
}
// Lock-free: không có Mutex, không có blocking
// Wait-free khó hơn: không có retry loop (mọi operation hoàn thành trong bounded steps)
```

### Trong production — dùng `crossbeam`

```toml
[dependencies]
crossbeam = "0.8"
```

```rust
use crossbeam::channel;
use crossbeam::queue::SegQueue;

// SegQueue: lock-free, multi-producer multi-consumer
let queue: SegQueue<i32> = SegQueue::new();
queue.push(1);
queue.push(2);
let item = queue.pop(); // Some(1)

// crossbeam::channel: mpmc, more ergonomic than std mpsc
let (tx, rx) = channel::bounded(100);
// vs tokio channel cho async code
// crossbeam = sync (blocking), tokio = async (non-blocking)
```

---

## 4. Rayon — Data Parallelism cho CPU-bound

**Java analog: `ForkJoinPool` + `parallelStream()`**

```toml
[dependencies]
rayon = "1.10"
```

```rust
use rayon::prelude::*;

// Parallel iterator — chỉ thêm .par_iter()!
let sum: i64 = large_vec.par_iter()
    .filter(|&&x| x % 2 == 0)
    .map(|&x| x as i64 * x as i64)
    .sum();

// Rayon tự phân chia data thành chunks → spawn ForkJoin tasks
// Work-stealing: idle threads steal từ busy threads
// Tự động tune số threads = số CPU cores

// So sánh performance (10M elements):
// Sequential:        ~50ms
// Rayon parallel:    ~8ms  (6-7x speedup trên 8-core)
// Tokio async:       KHÔNG DÙNG CHO CPU-BOUND (blocked executor threads)
```

### Khi nào Rayon vs Tokio

```
CPU-bound (compute): rayon
  - Matrix multiplication
  - Image processing
  - Data transformation (ETL)
  - Sorting large datasets
  - Crypto operations

I/O-bound (waiting): tokio
  - HTTP requests
  - Database queries
  - File I/O
  - Network operations

Kết hợp cả hai:
async fn handler(data: Vec<i32>) -> Json<i64> {
    // Offload CPU work từ tokio thread sang rayon pool
    let result = tokio::task::spawn_blocking(|| {
        data.par_iter().map(|&x| x as i64 * x as i64).sum::<i64>()
    }).await.unwrap();
    
    Json(result)
}
```

### Rayon parallel sort và collect

```rust
use rayon::prelude::*;

let mut data: Vec<i32> = (0..1_000_000).collect();

// Parallel sort — tự động dùng merge sort variants
data.par_sort();
data.par_sort_unstable(); // nhanh hơn, không stable

// Parallel map + collect
let squared: Vec<i64> = data.par_iter()
    .map(|&x| x as i64 * x as i64)
    .collect();

// Parallel partition
let (evens, odds): (Vec<i32>, Vec<i32>) = data.par_iter()
    .partition(|&&x| x % 2 == 0);

// Custom thread count
let pool = rayon::ThreadPoolBuilder::new()
    .num_threads(4)
    .build()
    .unwrap();

pool.install(|| {
    data.par_sort(); // chạy trên pool 4 threads
});
```

---

## 5. Actor Model — Message-passing Concurrency

**Java analog: Akka actors**

```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
```

```rust
// Implement actor pattern với tokio channels — không cần external crate
enum CounterMessage {
    Increment,
    Decrement,
    Get { reply: tokio::sync::oneshot::Sender<i64> },
    Shutdown,
}

struct CounterActor {
    receiver: tokio::sync::mpsc::Receiver<CounterMessage>,
    count: i64,
}

impl CounterActor {
    async fn run(mut self) {
        while let Some(msg) = self.receiver.recv().await {
            match msg {
                CounterMessage::Increment => self.count += 1,
                CounterMessage::Decrement => self.count -= 1,
                CounterMessage::Get { reply } => {
                    let _ = reply.send(self.count);
                }
                CounterMessage::Shutdown => break,
            }
        }
    }
}

// Handle — interface cho actor
#[derive(Clone)]
struct CounterHandle {
    sender: tokio::sync::mpsc::Sender<CounterMessage>,
}

impl CounterHandle {
    fn new() -> Self {
        let (tx, rx) = tokio::sync::mpsc::channel(100);
        let actor = CounterActor { receiver: rx, count: 0 };
        tokio::spawn(actor.run());
        CounterHandle { sender: tx }
    }
    
    async fn increment(&self) {
        self.sender.send(CounterMessage::Increment).await.unwrap();
    }
    
    async fn get(&self) -> i64 {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.sender.send(CounterMessage::Get { reply: tx }).await.unwrap();
        rx.await.unwrap()
    }
}

// Ưu điểm actor pattern:
// - Không có shared mutable state → không cần Mutex
// - Actor process messages sequentially → safe
// - Clone Handle → có thể dùng từ nhiều tasks
```

---

## 6. Thread-local Storage

```rust
use std::cell::RefCell;

thread_local! {
    static BUFFER: RefCell<Vec<u8>> = RefCell::new(Vec::with_capacity(4096));
}

fn process_request(data: &[u8]) {
    BUFFER.with(|buf| {
        let mut buf = buf.borrow_mut();
        buf.clear();
        buf.extend_from_slice(data);
        // process buf...
    });
}
// Mỗi thread có BUFFER riêng → không cần sync
// Java analog: ThreadLocal<ArrayList<Byte>>
// Rust: không cần unsafe vì RefCell enforce borrow rules
```

---

## 7. Concurrency Patterns Summary

| Pattern | Khi nào dùng | Rust implementation |
|---|---|---|
| Shared immutable | Read-heavy, static data | `Arc<T>` |
| Shared mutable (sync) | Rare writes | `Arc<RwLock<T>>` |
| Shared mutable (async) | Hold lock across .await | `Arc<tokio::sync::Mutex<T>>` |
| Message passing | Decouple producers/consumers | `tokio::sync::mpsc` |
| Actor pattern | Encapsulate state + behavior | mpsc + task |
| CPU parallelism | CPU-bound data transforms | `rayon::par_iter()` |
| Lock-free counter | High-freq increment | `AtomicI64` + Relaxed |
| Lock-free flag | Signal between threads | `AtomicBool` + Acq/Rel |

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9: Tokio channels]]
- [[Rust-Zero-To-Hero/Bai-21-Async-Internals-Pin|Bài 21: Waker & scheduling]]
- [[Rust-Zero-To-Hero/Bai-23-Workspace-Architecture|Bài 23: Workspace]] → tiếp theo
- [[MOC-Concurrency]]

---
*Bài tập:*
1. Implement `AtomicCounter` với `fetch_add(Relaxed)`. Benchmark vs `Mutex<i64>` với 8 threads × 1M increments.
2. Dùng `rayon::par_iter()` để process 10M records (filter + map + sum). Compare với sequential iterator. Đo speedup.
3. Implement `CacheActor` — actor giữ `HashMap<String, String>` với messages: `Get`, `Set`, `Delete`. Verify concurrent access từ 10 tasks không cần Mutex.
