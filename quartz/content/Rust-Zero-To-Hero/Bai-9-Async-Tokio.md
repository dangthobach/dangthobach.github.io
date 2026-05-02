# Bài 9: Async/Await & Tokio — Engine Của Web App

Chào Chuyên gia Java. Đây là bài quan trọng nhất trước khi bước vào Axum. Tokio là Spring WebFlux Reactor của Rust — nhưng được bake vào language thay vì là library add-on.

---

## 1. Tại Sao Async? — Vấn Đề Của Thread-Per-Request

```
Java truyền thống (Tomcat):
Request → Thread → [block chờ DB 50ms] → Response
                   ↑ Thread nằm ngủ, không làm gì
1000 concurrent requests = 1000 threads = ~1GB RAM

Java Virtual Threads (Loom):
Request → VThread → [mount, unmount khi block] → Response
Tốt hơn, nhưng vẫn là preemptive scheduling

Rust Tokio:
Request → Task → [yield khi .await] → Response
Task siêu nhẹ (~KB), cooperative scheduling, M:N model
```

---

## 2. `Future` Trait — Polling Model

```rust
pub trait Future {
    type Output;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output>;
}

pub enum Poll<T> {
    Ready(T),   // computation complete
    Pending,    // not ready yet, will notify via Waker
}
```

**Tại sao Polling?** Không cần thread per task. Runtime poll Future → Pending → suspend → khi I/O ready, Waker thức dậy task → poll lại → Ready.

**Bạn không cần implement `Future` manually.** `async fn` tự biên dịch thành state machine implement `Future`.

```rust
// Bạn viết:
async fn fetch_user(id: i64) -> User { ... }

// Compiler tạo ra (tương đương):
fn fetch_user(id: i64) -> impl Future<Output = User> {
    FetchUserFuture { id, state: State::Init }
}
```

---

## 3. `async/await` — Syntax Chính

```rust
// async fn → trả về Future, KHÔNG chạy ngay
async fn fetch_data() -> Result<String, AppError> {
    let response = reqwest::get("https://api.example.com/data")
        .await?;  // yield point — task suspended cho đến khi response ready
    let text = response.text().await?;
    Ok(text)
}

// .await "unwrap" Future → chờ completion, nhưng không block thread
async fn process() {
    let data = fetch_data().await; // cooperative yield, không block OS thread
}
```

**`.await` chỉ hoạt động trong `async` context.** Đây là lý do async "lây lan" — async fn chỉ có thể gọi từ async fn khác hoặc từ runtime.

---

## 4. Tokio Runtime

```rust
// Cách 1: macro — dùng cho main và tests
#[tokio::main]
async fn main() {
    // async context bắt đầu từ đây
    let result = do_something().await;
}

// Cách 2: explicit runtime — cho advanced control
let rt = tokio::runtime::Builder::new_multi_thread()
    .worker_threads(4)
    .enable_all()
    .build()
    .unwrap();

rt.block_on(async { do_something().await });
```

**Multi-thread vs Current-thread:**
- `#[tokio::main]` → multi-thread runtime (default, dùng N CPU cores)
- `#[tokio::test]` → current-thread runtime (single-thread cho tests)

---

## 5. `tokio::spawn` — Concurrent Tasks

```rust
// spawn tạo independent task — chạy concurrent với current task
async fn handle_request() {
    // Parallel execution:
    let task1 = tokio::spawn(fetch_user(1));
    let task2 = tokio::spawn(fetch_orders(1));
    
    // Await cả hai — chạy song song không phải tuần tự
    let (user, orders) = tokio::join!(task1, task2);
    // Tổng thời gian = max(t_user, t_orders), không phải t_user + t_orders
}

// JoinHandle — await kết quả
let handle: JoinHandle<String> = tokio::spawn(async {
    "result".to_string()
});
let result = handle.await.unwrap(); // JoinError nếu task panicked
```

**`tokio::join!` vs sequential await:**
```rust
// Sequential — 200ms total (100 + 100)
let a = fetch_a().await; // 100ms
let b = fetch_b().await; // 100ms

// Concurrent — 100ms total
let (a, b) = tokio::join!(fetch_a(), fetch_b());

// Đây là pattern cực kỳ phổ biến trong web handlers
```

---

## 6. `tokio::spawn_blocking` — CPU-bound Work

```rust
// Đừng bao giờ block trong async context:
async fn bad_handler() {
    let result = heavy_cpu_computation(); // BLOCKS executor thread!
    // Các requests khác bị queue trong lúc này
}

// Đúng: offload sang blocking thread pool
async fn good_handler() {
    let result = tokio::task::spawn_blocking(|| {
        heavy_cpu_computation() // chạy trên separate blocking thread
    }).await.unwrap();
}
```

**Quy tắc:** Bất kỳ operation nào > vài microseconds mà không dùng `.await` → `spawn_blocking`.

---

## 7. Tokio Channels

### `mpsc` — Multi-Producer Single-Consumer
```rust
use tokio::sync::mpsc;

let (tx, mut rx) = mpsc::channel::<String>(100); // buffer size 100

// Producer (có thể clone tx cho nhiều task)
let tx2 = tx.clone();
tokio::spawn(async move {
    tx.send("message 1".to_string()).await.unwrap();
});
tokio::spawn(async move {
    tx2.send("message 2".to_string()).await.unwrap();
});

// Consumer
while let Some(msg) = rx.recv().await {
    println!("Received: {}", msg);
}
```

### `oneshot` — Single Response
```rust
use tokio::sync::oneshot;

// Dùng cho request-response pattern trong nội bộ
let (tx, rx) = oneshot::channel::<Result<User, AppError>>();

tokio::spawn(async move {
    let user = db_fetch_user(id).await;
    tx.send(user).ok();
});

let result = rx.await.unwrap();
```

### `broadcast` — Fan-out
```rust
use tokio::sync::broadcast;

let (tx, _) = broadcast::channel::<Event>(100);

// Mỗi subscriber tự clone receiver
let mut rx1 = tx.subscribe();
let mut rx2 = tx.subscribe();

tx.send(Event::UserCreated(user_id)).unwrap();

// rx1 và rx2 đều nhận được message
```

### `watch` — State Sharing (Config, Feature Flags)
```rust
use tokio::sync::watch;

let (tx, rx) = watch::channel(Config::default());

// Chỉ giá trị mới nhất được giữ — perfect cho config
tokio::spawn(async move {
    loop {
        let new_config = reload_config().await;
        tx.send(new_config).unwrap();
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
});

// Consumers
let config = rx.borrow().clone();
```

---

## 8. `tokio::select!` — Race Multiple Futures

```rust
use tokio::time::{sleep, Duration};

// Chạy và lấy kết quả của future nào complete trước
tokio::select! {
    result = fetch_from_primary() => {
        println!("Primary responded: {:?}", result);
    }
    result = fetch_from_secondary() => {
        println!("Fallback responded: {:?}", result);
    }
    _ = sleep(Duration::from_millis(500)) => {
        println!("Timeout!");
    }
}
```

**Pattern phổ biến: Graceful shutdown**
```rust
loop {
    tokio::select! {
        Some(request) = incoming.recv() => {
            handle(request).await;
        }
        _ = shutdown_signal() => {
            println!("Shutting down...");
            break;
        }
    }
}
```

---

## 9. Timeout Pattern

```rust
use tokio::time::{timeout, Duration};

// Wrap bất kỳ future nào với timeout
match timeout(Duration::from_secs(5), fetch_user(id)).await {
    Ok(Ok(user)) => Ok(Json(user)),
    Ok(Err(e)) => Err(AppError::Database(e)),
    Err(_elapsed) => Err(AppError::Timeout("fetch_user".to_string())),
}
```

---

## 10. Common Mistakes (Từ Java Background)

```rust
// ❌ Sai: std::thread::sleep trong async
async fn bad() {
    std::thread::sleep(Duration::from_secs(1)); // blocks executor thread!
}

// ✅ Đúng: tokio::time::sleep
async fn good() {
    tokio::time::sleep(Duration::from_secs(1)).await; // yield, không block
}

// ❌ Sai: Blocking IO trong async
async fn bad_io() {
    let content = std::fs::read_to_string("file.txt").unwrap(); // blocks!
}

// ✅ Đúng: Tokio async IO
async fn good_io() {
    let content = tokio::fs::read_to_string("file.txt").await.unwrap();
}

// ❌ Sai: Tạo runtime trong async context
async fn bad_nested() {
    let rt = tokio::runtime::Runtime::new().unwrap(); // panic!
    rt.block_on(some_future());
}
```

---

## 11. Mental Model: Tokio ↔ Java

| Concept | Java | Tokio/Rust |
|---|---|---|
| Task scheduling | JVM thread scheduler | Tokio work-stealing scheduler |
| Lightweight task | Virtual Thread (~1KB) | Tokio Task (~KB) |
| Async primitive | `CompletableFuture` | `Future` + `async/await` |
| Parallel tasks | `CompletableFuture.allOf()` | `tokio::join!()` |
| Race tasks | — | `tokio::select!()` |
| Thread pool (blocking) | `Executors.newFixedThreadPool()` | `spawn_blocking` thread pool |
| Channel | `BlockingQueue` | `mpsc::channel` |
| Pub/sub | — | `broadcast::channel` |
| Config sharing | `@Value` / `Environment` | `watch::channel` |

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-8-Smart-Pointers-Error-Design|Bài 8: Smart Pointers]] — `Arc` trong async context
- [[Rust-Zero-To-Hero/Bai-10-Axum-Core|Bài 10: Axum Core]] — build trên tokio
- [[MOC-Concurrency]]

---
*Bài tập:*
1. Viết hàm `fetch_parallel(ids: Vec<i64>) -> Vec<User>` spawn một task per ID, collect tất cả kết quả. Handle task failures gracefully.
2. Implement simple rate limiter dùng `tokio::sync::Semaphore` — chỉ cho phép 10 concurrent requests.
3. Viết producer-consumer pipeline: producer gửi 100 items qua `mpsc` channel, consumer xử lý với `timeout` per item, track failed items.

> 📖 **Tiếp theo:** [[Rust-Zero-To-Hero/Bai-9b-Tokio-Advanced|Bài 9b: Tokio Advanced]] — Mutex, Semaphore, Streams, Cancellation, Actor pattern, Graceful Shutdown
