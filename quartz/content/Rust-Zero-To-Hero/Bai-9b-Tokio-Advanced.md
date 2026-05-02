# Bài 9b: Tokio Advanced — Những Gì Bài 9 Chưa Đủ

> Prerequisites: [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9]] — nắm Future model, spawn, channels, select!

---

## 1. Tokio Scheduler Internals — Work-Stealing

Hiểu scheduler giúp bạn tránh các anti-pattern gây performance regression.

```
Multi-thread runtime (default):

Worker 0: [Task A] → [Task C] → [Task E] ← steal từ Worker 1
Worker 1: [Task B] → [Task D] → idle
Worker 2: [Task F] → idle

Work-stealing: Worker rảnh sẽ "ăn cắp" task từ queue của Worker bận.
→ Tự động load-balance, không cần config.
```

**Cooperative scheduling** — quan trọng:
- Task chỉ bị suspend tại `.await` points
- Không có preemption — nếu bạn loop không có `.await`, task chiếm thread mãi

```rust
// ❌ Anti-pattern: starvation — task này block 1 worker thread
async fn compute_intensive() {
    let mut i = 0u64;
    loop {
        i = i.wrapping_add(1); // không có .await → không yield bao giờ
        if i == u64::MAX { break; }
    }
}

// ✅ Yield định kỳ để cho task khác chạy
async fn compute_friendly() {
    let mut i = 0u64;
    loop {
        i = i.wrapping_add(1);
        if i % 10_000 == 0 {
            tokio::task::yield_now().await; // yield point thủ công
        }
        if i == u64::MAX { break; }
    }
}

// ✅ Hoặc tốt hơn: đưa CPU-bound sang blocking pool
async fn compute_correct() {
    tokio::task::spawn_blocking(|| {
        // heavy computation — không cần yield
    }).await.unwrap();
}
```

**Task lifecycle:**
```
Created → Scheduled (push vào run queue)
        → Running (worker poll future)
        → Pending (.await trả Poll::Pending, Waker đăng ký)
        → Scheduled lại (Waker.wake() được gọi khi IO ready)
        → Running → Ready (Poll::Ready)
```

---

## 2. Tokio Mutex & RwLock — Async-Safe Locking

### Vấn đề với `std::sync::Mutex` trong async

```rust
use std::sync::Mutex;

// ❌ Nguy hiểm: giữ MutexGuard qua .await point
async fn bad_lock(state: Arc<Mutex<Vec<String>>>) {
    let mut guard = state.lock().unwrap(); // acquire lock
    
    let data = fetch_from_db().await;  // .await ở đây!
    // Guard vẫn được giữ trong khi task suspended
    // Nếu task bị schedule sang thread khác → UB / deadlock
    
    guard.push(data);
} // guard drop ở đây

// Compiler KHÔNG catch được lỗi này trong nhiều trường hợp
```

**Tại sao lại deadlock?**
```
Thread 0: Task A acquire lock → .await (yield) → Task B chạy trên Thread 0
Thread 0: Task B cố acquire cùng lock → DEADLOCK (std::sync::Mutex không async-aware)
```

### `tokio::sync::Mutex` — giải pháp đúng

```rust
use tokio::sync::Mutex;
use std::sync::Arc;

struct AppState {
    cache: Mutex<HashMap<String, String>>,
}

async fn handler(state: Arc<AppState>) {
    // .lock().await — async-aware, suspend task (không block thread) khi chờ
    let mut cache = state.cache.lock().await;
    
    let value = fetch_from_db("key").await; // ✅ OK — Mutex được held qua .await
    cache.insert("key".to_string(), value);
} // guard drop, lock released
```

**Quy tắc chọn Mutex:**

| Tình huống | Dùng |
|---|---|
| Guard KHÔNG qua `.await` | `std::sync::Mutex` (nhanh hơn) |
| Guard qua `.await` | `tokio::sync::Mutex` |
| Read-heavy, write-rare | `tokio::sync::RwLock` |
| Không cần share state | Tái thiết kế dùng message passing |

### `tokio::sync::RwLock`

```rust
use tokio::sync::RwLock;

let lock = Arc::new(RwLock::new(HashMap::<String, User>::new()));

// Multiple concurrent readers
async fn read_user(lock: Arc<RwLock<HashMap<String, User>>>, id: &str) -> Option<User> {
    let guard = lock.read().await; // nhiều task có thể read đồng thời
    guard.get(id).cloned()
}

// Exclusive writer
async fn update_user(lock: Arc<RwLock<HashMap<String, User>>>, user: User) {
    let mut guard = lock.write().await; // exclusive access
    guard.insert(user.id.clone(), user);
}
```

⚠️ **Writer starvation**: nếu readers liên tục, writers có thể đợi lâu.

### Pattern: Minimize Lock Scope

```rust
// ❌ Lock scope quá rộng — giữ lock trong lúc await
async fn bad(state: Arc<Mutex<Cache>>) -> Result<String, Error> {
    let mut cache = state.lock().await;
    let result = expensive_io_call().await; // lock held!
    cache.set("key", &result);
    Ok(result)
}

// ✅ Clone data ra, release lock, rồi mới await
async fn good(state: Arc<Mutex<Cache>>) -> Result<String, Error> {
    // Check cache trước
    let cached = {
        let cache = state.lock().await;
        cache.get("key").cloned()
    }; // lock released sau block này
    
    if let Some(value) = cached {
        return Ok(value);
    }
    
    // Await bên ngoài lock
    let result = expensive_io_call().await?;
    
    // Re-acquire để write
    state.lock().await.set("key", &result);
    Ok(result)
}
```

---

## 3. Semaphore — Rate Limiting & Resource Control

```rust
use tokio::sync::Semaphore;
use std::sync::Arc;

// Giới hạn concurrent DB connections
struct DbPool {
    semaphore: Arc<Semaphore>,
    // ... actual pool
}

impl DbPool {
    fn new(max_connections: usize) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(max_connections)),
        }
    }
    
    async fn acquire(&self) -> DbConnection {
        // Acquire permit — suspend nếu đã đạt max
        let _permit = self.semaphore.acquire().await.unwrap();
        // _permit dropped khi connection returned → slot freed
        DbConnection::new()
    }
}

// Pattern: rate limiter
async fn rate_limited_fetch(
    sem: Arc<Semaphore>,
    urls: Vec<String>,
) -> Vec<Result<String, reqwest::Error>> {
    let tasks: Vec<_> = urls.into_iter().map(|url| {
        let sem = sem.clone();
        tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            // Chỉ max N concurrent requests tại một thời điểm
            reqwest::get(&url).await?.text().await
        })
    }).collect();
    
    futures::future::join_all(tasks)
        .await
        .into_iter()
        .map(|r| r.unwrap())
        .collect()
}

// Dùng: giới hạn 10 concurrent HTTP calls
let sem = Arc::new(Semaphore::new(10));
let results = rate_limited_fetch(sem, urls).await;
```

### `acquire_owned` — permit sống qua task boundary

```rust
// Permit cần sống qua spawn boundary → dùng acquire_owned
let permit = semaphore.clone().acquire_owned().await.unwrap();

tokio::spawn(async move {
    do_work().await;
    drop(permit); // explicit release
});
```

---

## 4. Notify & Barrier

### `Notify` — Event-based Wakeup

Nhẹ hơn channel khi chỉ cần signal "có gì đó xảy ra":

```rust
use tokio::sync::Notify;
use std::sync::Arc;

let notify = Arc::new(Notify::new());

// Waiter task
let n = notify.clone();
tokio::spawn(async move {
    n.notified().await; // suspend cho đến khi notify
    println!("Event received!");
});

// Trigger
tokio::time::sleep(Duration::from_secs(1)).await;
notify.notify_one(); // wake 1 waiter
// hoặc notify.notify_waiters(); // wake tất cả

// Use case: cache invalidation signal
// Use case: "work available" signal trong worker pool
```

**Notify vs mpsc channel:**
- `Notify`: "có event" — không truyền data
- `mpsc`: truyền data từ producer sang consumer

### `Barrier` — Đồng bộ Nhiều Task

```rust
use tokio::sync::Barrier;

let barrier = Arc::new(Barrier::new(3)); // đợi 3 task

for i in 0..3 {
    let b = barrier.clone();
    tokio::spawn(async move {
        println!("Task {} đang chuẩn bị...", i);
        // Simulate prep work
        tokio::time::sleep(Duration::from_millis(i as u64 * 100)).await;
        
        b.wait().await; // tất cả 3 task phải đến đây mới tiếp tục
        println!("Task {} bắt đầu đồng thời!", i);
    });
}
```

---

## 5. Interval — Periodic Tasks

```rust
use tokio::time::{interval, interval_at, Duration, Instant, MissedTickBehavior};

// Basic interval
async fn heartbeat_loop() {
    let mut ticker = interval(Duration::from_secs(5));
    
    loop {
        ticker.tick().await; // first tick ngay lập tức
        send_heartbeat().await;
    }
}

// Xử lý trường hợp tick bị miss (task chậm hơn interval)
async fn scheduled_job() {
    let mut ticker = interval(Duration::from_secs(1));
    
    // Default: Burst — chạy ngay tất cả missed ticks
    // Skip: bỏ qua missed ticks
    // Delay: delay đến next interval
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    
    loop {
        ticker.tick().await;
        
        if let Err(e) = do_scheduled_work().await {
            eprintln!("Job failed: {}", e);
            // Tick tiếp theo vẫn đúng schedule
        }
    }
}

// interval_at — bắt đầu sau delay
async fn delayed_start() {
    let start = Instant::now() + Duration::from_secs(10);
    let mut ticker = interval_at(start, Duration::from_secs(60));
    
    loop {
        ticker.tick().await;
        cleanup_old_records().await;
    }
}
```

---

## 6. Streams — Async Iteration

### Stream là gì?

```rust
// Iterator (sync):
trait Iterator {
    type Item;
    fn next(&mut self) -> Option<Self::Item>;
}

// Stream (async) — Iterator nhưng next() là async:
trait Stream {
    type Item;
    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>>;
}
```

### Dùng Stream với `tokio_stream`

```rust
use tokio_stream::{self, StreamExt};

// Convert từ Vec
let mut stream = tokio_stream::iter(vec![1, 2, 3]);
while let Some(item) = stream.next().await {
    println!("{}", item);
}

// Stream adapters (giống Iterator adapters)
let result: Vec<_> = tokio_stream::iter(0..100)
    .filter(|x| x % 2 == 0)
    .map(|x| x * 2)
    .take(10)
    .collect()
    .await;
```

### Stream từ Channel (real-world pattern)

```rust
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

let (tx, rx) = mpsc::channel(100);

// Wrap receiver thành Stream
let mut stream = ReceiverStream::new(rx);

// Producer
tokio::spawn(async move {
    for i in 0..100 {
        tx.send(i).await.unwrap();
    }
});

// Process stream
while let Some(item) = stream.next().await {
    process(item).await;
}
```

### Backpressure với Stream

```rust
use tokio_stream::StreamExt;

// Stream tự nhiên là pull-based → backpressure có sẵn
// Consumer chỉ nhận khi gọi .next() → producer không bị overwhelm

async fn process_with_concurrency_limit<S>(
    mut stream: S,
    concurrency: usize,
) where S: Stream<Item = Task> + Unpin {
    // Xử lý tối đa `concurrency` items đồng thời
    stream
        .map(|task| async move { process_task(task).await })
        .buffer_unordered(concurrency) // concurrent processing với backpressure
        .for_each(|result| async move {
            handle_result(result);
        })
        .await;
}
```

---

## 7. Async IO — TCP, UDP, Files

### TCP Server

```rust
use tokio::net::{TcpListener, TcpStream};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn run_server() -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("0.0.0.0:8080").await?;
    println!("Listening on :8080");
    
    loop {
        let (socket, addr) = listener.accept().await?;
        println!("New connection: {}", addr);
        
        // Spawn task per connection — không block accept loop
        tokio::spawn(async move {
            handle_connection(socket).await;
        });
    }
}

async fn handle_connection(mut socket: TcpStream) {
    let mut buf = vec![0u8; 1024];
    
    loop {
        let n = match socket.read(&mut buf).await {
            Ok(0) => return, // connection closed
            Ok(n) => n,
            Err(e) => {
                eprintln!("Read error: {}", e);
                return;
            }
        };
        
        // Echo back
        if let Err(e) = socket.write_all(&buf[..n]).await {
            eprintln!("Write error: {}", e);
            return;
        }
    }
}
```

### `AsyncRead` / `AsyncWrite` — Traits

```rust
use tokio::io::{AsyncRead, AsyncWrite, AsyncBufReadExt, BufReader};

// BufReader wrap bất kỳ AsyncRead
async fn read_lines<R: AsyncRead + Unpin>(reader: R) {
    let mut lines = BufReader::new(reader).lines();
    
    while let Some(line) = lines.next_line().await.unwrap() {
        println!("{}", line);
    }
}

// tokio::io::copy — stream data từ reader sang writer
async fn proxy(from: TcpStream, to: TcpStream) {
    let (mut r_from, mut w_from) = tokio::io::split(from);
    let (mut r_to, mut w_to) = tokio::io::split(to);
    
    tokio::join!(
        tokio::io::copy(&mut r_from, &mut w_to),
        tokio::io::copy(&mut r_to, &mut w_from),
    );
}
```

---

## 8. Cancellation — Structured Concurrency

### Cancellation bằng `select!` + signal

```rust
use tokio::sync::oneshot;

async fn cancellable_work(cancel: oneshot::Receiver<()>) {
    tokio::select! {
        result = do_long_work() => {
            println!("Work completed: {:?}", result);
        }
        _ = cancel => {
            println!("Cancelled!");
            // cleanup...
        }
    }
}

let (cancel_tx, cancel_rx) = oneshot::channel();

let handle = tokio::spawn(cancellable_work(cancel_rx));

// Cancel từ bên ngoài
cancel_tx.send(()).ok();
handle.await.unwrap();
```

### `CancellationToken` — Production Pattern

```rust
use tokio_util::sync::CancellationToken;

async fn run_workers() {
    let token = CancellationToken::new();
    
    // Spawn nhiều workers share cùng token
    let mut handles = vec![];
    for i in 0..5 {
        let child_token = token.child_token(); // child inherit cancellation
        handles.push(tokio::spawn(async move {
            worker(i, child_token).await;
        }));
    }
    
    // Cancel tất cả workers cùng lúc
    token.cancel();
    
    for handle in handles {
        handle.await.unwrap();
    }
}

async fn worker(id: usize, token: CancellationToken) {
    loop {
        tokio::select! {
            _ = token.cancelled() => {
                println!("Worker {} shutting down", id);
                return;
            }
            _ = do_unit_of_work() => {
                // continue
            }
        }
    }
}
```

### Drop = Cancel

```rust
// Future bị drop → tự động cancelled
// Đây là Rust's ownership model làm cancellation tự nhiên

async fn example() {
    let task = async {
        // ... work
        tokio::time::sleep(Duration::from_secs(10)).await;
        "done"
    };
    
    // Drop future sau 1s
    tokio::time::timeout(Duration::from_secs(1), task).await.ok();
    // task bị drop → cancelled (không có cleanup!)
}

// ⚠️ Vấn đề: intermediate state có thể bị leak
// Nếu cần cleanup → dùng Drop trait hoặc CancellationToken
```

---

## 9. Graceful Shutdown — Production Pattern

```rust
use tokio::signal;
use tokio::sync::broadcast;

#[tokio::main]
async fn main() {
    let (shutdown_tx, _) = broadcast::channel::<()>(1);
    
    // Spawn workers
    let mut handles = vec![];
    for i in 0..4 {
        let mut shutdown_rx = shutdown_tx.subscribe();
        handles.push(tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown_rx.recv() => {
                        println!("Worker {} gracefully shutting down", i);
                        // finish current work, cleanup
                        return;
                    }
                    _ = process_next_item() => {}
                }
            }
        }));
    }
    
    // Wait for Ctrl+C
    signal::ctrl_c().await.expect("Failed to listen for ctrl_c");
    println!("Shutdown signal received");
    
    // Signal all workers
    shutdown_tx.send(()).ok();
    
    // Wait for all workers to finish
    for handle in handles {
        handle.await.unwrap();
    }
    
    println!("All workers stopped. Goodbye.");
}
```

---

## 10. Performance Tuning — Deep Dive

### Avoid Allocations in Hot Path

```rust
use bytes::{Bytes, BytesMut};

// ❌ Nhiều allocation
async fn bad_read(socket: &mut TcpStream) -> Vec<u8> {
    let mut result = Vec::new();
    let mut buf = vec![0u8; 4096]; // allocation mỗi call
    // ...
    result
}

// ✅ Reuse buffer — zero-copy với Bytes crate
async fn good_read(socket: &mut TcpStream, buf: &mut BytesMut) -> Bytes {
    buf.clear();
    socket.read_buf(buf).await.unwrap();
    buf.split().freeze() // zero-copy slice
}
```

### Bounded vs Unbounded Channels

```rust
// ❌ Unbounded: producer có thể overwhelm consumer → OOM
let (tx, rx) = mpsc::unbounded_channel::<LargePayload>();

// ✅ Bounded: backpressure tự động
let (tx, rx) = mpsc::channel::<LargePayload>(100);

// tx.send().await → suspend producer nếu buffer đầy
// → natural flow control
```

### Task Granularity

```rust
// ❌ Quá nhiều tiny tasks — overhead scheduling
for item in millions_of_items {
    tokio::spawn(async move {
        tiny_work(item).await; // microseconds
    });
}

// ✅ Batch thành chunks
for chunk in millions_of_items.chunks(1000) {
    let chunk = chunk.to_vec();
    tokio::spawn(async move {
        for item in chunk {
            tiny_work(item).await;
        }
    });
}
```

### Worker threads tuning

```rust
// Default: số CPU cores
// CPU-bound: giữ = số cores (không oversub)
// IO-bound: có thể tăng, nhưng thường default đủ tốt
// Mixed: profile trước, đừng guess

let rt = tokio::runtime::Builder::new_multi_thread()
    .worker_threads(num_cpus::get()) // CPU cores cho IO
    .max_blocking_threads(512)        // blocking thread pool size
    .enable_all()
    .build()
    .unwrap();
```

---

## 11. Actor Pattern với Tokio

Actor model = mỗi "actor" có private state + xử lý messages qua channel. Tránh shared state hoàn toàn.

```rust
// Actor: owns its state, processes messages sequentially
struct CounterActor {
    count: u64,
}

enum CounterMessage {
    Increment,
    Get { respond_to: oneshot::Sender<u64> },
    Reset,
}

impl CounterActor {
    async fn run(mut self, mut rx: mpsc::Receiver<CounterMessage>) {
        while let Some(msg) = rx.recv().await {
            match msg {
                CounterMessage::Increment => self.count += 1,
                CounterMessage::Get { respond_to } => {
                    respond_to.send(self.count).ok();
                }
                CounterMessage::Reset => self.count = 0,
            }
        }
    }
}

// Handle để giao tiếp với actor
#[derive(Clone)]
struct CounterHandle {
    tx: mpsc::Sender<CounterMessage>,
}

impl CounterHandle {
    fn new() -> Self {
        let (tx, rx) = mpsc::channel(100);
        let actor = CounterActor { count: 0 };
        tokio::spawn(actor.run(rx));
        Self { tx }
    }
    
    async fn increment(&self) {
        self.tx.send(CounterMessage::Increment).await.ok();
    }
    
    async fn get(&self) -> u64 {
        let (tx, rx) = oneshot::channel();
        self.tx.send(CounterMessage::Get { respond_to: tx }).await.ok();
        rx.await.unwrap_or(0)
    }
}

// Usage — không cần Arc<Mutex<Counter>>!
let counter = CounterHandle::new();
counter.increment().await;
counter.increment().await;
let value = counter.get().await; // 2
```

**Actor vs Mutex:**
- Actor: sequential processing, zero contention, dễ reason
- Mutex: shared access, cần careful scoping
- Actor phù hợp khi state phức tạp + nhiều thao tác liên quan

---

## 12. Tokio Console — Observability

```toml
# Cargo.toml
[dependencies]
console-subscriber = "0.4"
```

```rust
// main.rs
fn main() {
    console_subscriber::init(); // thay thế tracing_subscriber
    
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async_main());
}
```

```bash
# Terminal 1: chạy app
RUST_LOG=info cargo run

# Terminal 2: mở console
cargo install tokio-console
tokio-console
```

Console hiển thị:
- Tasks đang chạy / pending / đã xong
- Task nào chiếm thời gian nhiều nhất
- Waker statistics
- Phát hiện tasks bị "stuck"

---

## 📊 Summary: Khi Nào Dùng Gì

| Cần gì | Tool |
|---|---|
| Share state đơn giản, không await khi giữ lock | `std::sync::Mutex` |
| Share state, có await khi giữ lock | `tokio::sync::Mutex` |
| Read-heavy shared state | `tokio::sync::RwLock` |
| Giới hạn concurrency | `tokio::sync::Semaphore` |
| Notify event (không data) | `tokio::sync::Notify` |
| Sync N tasks tại checkpoint | `tokio::sync::Barrier` |
| Periodic task | `tokio::time::interval` |
| Async iteration / stream processing | `tokio_stream::StreamExt` |
| Cancel nhiều tasks | `tokio_util::sync::CancellationToken` |
| State không share, process sequentially | Actor pattern (mpsc) |

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9: Async/Await & Tokio — Phần cơ bản]]
- [[Rust-Zero-To-Hero/Bai-10-Axum-Core|Bài 10: Axum]] — áp dụng tất cả vào web framework
- [[_moc/MOC-Rust|MOC Rust]]

---
*Bài tập nâng cao:*
1. Implement connection pool đơn giản dùng `Semaphore` + `VecDeque<Connection>` trong `Mutex`.
2. Viết Actor cho `SessionManager`: lưu sessions, expire sau TTL, cleanup định kỳ bằng `interval`.
3. Build rate-limited HTTP client: tối đa 10 req/s globally, dùng `Semaphore` + `interval` để refill permits.
4. Implement graceful shutdown cho Axum server: stop nhận request mới, chờ in-flight requests xong, cleanup.
