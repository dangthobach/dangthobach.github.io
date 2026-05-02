# Bài 21: Async Internals — Pin, Waker & Custom Futures

> **Bài 9 dạy cách dùng async/await. Bài này giải thích tại sao nó hoạt động.** Hiểu cơ chế bên trong giúp bạn debug async issues, viết custom executors, và hiểu tại sao `Pin<P>` tồn tại.

---

## 1. Future State Machine — Compiler Làm Gì Với `async fn`

```rust
// Bạn viết:
async fn fetch_two_things() -> (String, String) {
    let a = fetch_a().await;  // yield point 1
    let b = fetch_b().await;  // yield point 2
    (a, b)
}

// Compiler THỰC SỰ tạo ra (simplified):
enum FetchTwoThings {
    // State 0: chưa bắt đầu
    Start,
    
    // State 1: đang đợi fetch_a, cần giữ future của nó
    WaitingForA {
        future_a: FetchAFuture,
    },
    
    // State 2: fetch_a xong, đang đợi fetch_b
    // PHẢI giữ kết quả của a vì b chưa xong
    WaitingForB {
        a: String,              // ← giá trị từ yield point 1
        future_b: FetchBFuture,
    },
    
    // State 3: done
    Done,
}

impl Future for FetchTwoThings {
    type Output = (String, String);
    
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        loop {
            match *self {
                Self::Start => {
                    *self = Self::WaitingForA { future_a: fetch_a() };
                }
                Self::WaitingForA { ref mut future_a } => {
                    match Pin::new(future_a).poll(cx) {
                        Poll::Ready(a) => {
                            *self = Self::WaitingForB { a, future_b: fetch_b() };
                        }
                        Poll::Pending => return Poll::Pending,
                    }
                }
                Self::WaitingForB { ref a, ref mut future_b } => {
                    match Pin::new(future_b).poll(cx) {
                        Poll::Ready(b) => {
                            let result = (a.clone(), b);
                            *self = Self::Done;
                            return Poll::Ready(result);
                        }
                        Poll::Pending => return Poll::Pending,
                    }
                }
                Self::Done => panic!("polled after completion"),
            }
        }
    }
}
```

**Key insight:** Mỗi `await` point = một state trong state machine. State machine giữ mọi thứ cần thiết để resume tại đúng điểm. Đây là lý do async task chỉ ~8KB thay vì ~1MB stack của thread.

---

## 2. `Pin<P>` — Tại Sao Cần Thiết

**Vấn đề: Self-referential structs**

```rust
// Vấn đề lý thuyết — state machine có thể self-reference:
struct MyFuture {
    data: String,
    ptr_into_data: *const u8,  // trỏ vào data!
}

// Nếu MyFuture bị move:
let f1 = MyFuture { ... };
let f2 = f1;  // move! f1's memory bị copy sang f2's address
// f2.ptr_into_data vẫn trỏ vào f1's OLD address → dangling pointer!

// Đây là vấn đề của async state machine:
async fn example() {
    let data = String::from("hello");
    let reference = &data;   // reference vào local variable
    some_io().await;          // yield point — state machine giữ cả data và reference
    println!("{}", reference); // resume — reference phải vẫn valid
}
// State machine generated: giữ String + &String trỏ vào String đó = self-referential
```

**`Pin<P>` là giải pháp:**

```rust
// Pin<P> đảm bảo: nếu T không implement Unpin, nó KHÔNG được move
// P thường là: Pin<&mut T> hoặc Pin<Box<T>>

use std::pin::Pin;
use std::marker::PhantomPinned;

struct SelfReferential {
    data: String,
    self_ref: *const String,  // trỏ vào data
    _pin: PhantomPinned,      // opt-out Unpin — không thể move
}

impl SelfReferential {
    fn new(data: String) -> Pin<Box<Self>> {
        let mut s = Box::pin(SelfReferential {
            data,
            self_ref: std::ptr::null(),
            _pin: PhantomPinned,
        });
        
        // Safe vì chúng ta đang init và biết địa chỉ không thay đổi
        let ptr: *const String = &s.data;
        unsafe { s.as_mut().get_unchecked_mut().self_ref = ptr; }
        
        s
    }
    
    fn get_ref(self: Pin<&Self>) -> &str {
        // SAFETY: self_ref was set to point to self.data which is pinned
        unsafe { &*self.self_ref }
    }
}
```

### Unpin — Hầu Hết Types Đều Implement Unpin

```rust
// Unpin nghĩa là: "an toàn để move kể cả khi đang pinned"
// Hầu hết types: i32, String, Vec, struct bình thường → implement Unpin

// Chỉ async state machines và types có PhantomPinned → !Unpin (không implement)

// Với Unpin types, Pin<&mut T> = &mut T thực tế
fn move_out_of_pin<T: Unpin>(p: Pin<&mut T>) -> &mut T {
    Pin::into_inner(p)  // safe vì T: Unpin
}
```

---

## 3. Waker — Cơ Chế Thức Dậy

```rust
// Khi poll() trả về Pending, ai sẽ poll lại?
// → Waker được truyền vào qua Context
// → Khi I/O ready, epoll/kqueue notify → Waker::wake() được gọi
// → Runtime đưa Future trở lại run queue → poll() lại

pub trait Future {
    type Output;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output>;
    //                                    ^^^^^^^^^^^
    //                             Context chứa Waker
}

// Simplified Waker internals:
struct Waker {
    data: *const (),
    vtable: &'static RawWakerVTable,  // wake(), clone(), drop()
}

impl Waker {
    pub fn wake(self) {
        // gọi vtable.wake(data)
        // → thông báo runtime: Future này ready để poll
    }
}
```

### Custom Future với Waker

```rust
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

// Future đơn giản: resolve sau N polls
struct CountdownFuture {
    remaining: u32,
    waker: Option<Waker>,
}

impl Future for CountdownFuture {
    type Output = ();
    
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.remaining == 0 {
            return Poll::Ready(());
        }
        
        // Save waker — cần gọi khi ready
        self.waker = Some(cx.waker().clone());
        self.remaining -= 1;
        
        // Schedule wakeup (trong real impl: I/O event, timer, etc.)
        // Ở đây chúng ta schedule immediate re-poll để demo:
        cx.waker().wake_by_ref();
        
        Poll::Pending
    }
}

// Dùng:
async fn demo() {
    CountdownFuture { remaining: 5, waker: None }.await;
    println!("Counted down!");
}
```

---

## 4. Tokio Internals — Work-Stealing Scheduler

```
Tokio runtime (multi-thread):
┌─────────────────────────────────────────────────────────┐
│  Thread 1          Thread 2          Thread 3           │
│  ┌────────┐        ┌────────┐        ┌────────┐         │
│  │ Local  │        │ Local  │        │ Local  │         │
│  │ Queue  │        │ Queue  │        │ Queue  │         │
│  │[t1,t2] │        │[t3]    │        │[]      │         │
│  └────────┘        └────────┘        └────────┘         │
│       ↓                 ↑ steal!                        │
│  ┌─────────────────────────────────────────────────┐   │
│  │            Global Injection Queue               │   │
│  │  [new_task_1, new_task_2, new_task_3, ...]      │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  epoll/io_uring thread: → events → wake tasks → push   │
└─────────────────────────────────────────────────────────┘

Work-stealing: Thread 3 (rảnh) steal tasks từ Thread 1 (bận)
→ Load balancing tự động, không có central mutex
```

```rust
// Tại sao không dùng std::thread::sleep trong async:
async fn bad() {
    std::thread::sleep(Duration::from_secs(1));
    // Thread bị block → thread pool thread không thể poll tasks khác
    // 1000 requests đang chờ → tất cả block!
}

// Đúng: tokio's timer → Waker mechanism
async fn good() {
    tokio::time::sleep(Duration::from_secs(1)).await;
    // poll() → Poll::Pending → thread free
    // Timer epoll → Waker::wake() sau 1s → poll lại
}
```

---

## 5. Structured Concurrency với `JoinSet`

```rust
use tokio::task::JoinSet;

// JoinSet: quản lý nhóm tasks với structured concurrency
// Khi JoinSet dropped → tất cả tasks bị cancelled
async fn process_batch(ids: Vec<i64>, pool: &PgPool) -> Vec<Result<User, AppError>> {
    let mut set = JoinSet::new();
    
    for id in ids {
        let pool = pool.clone();
        set.spawn(async move {
            fetch_user(&pool, id).await
        });
    }
    
    let mut results = Vec::new();
    while let Some(result) = set.join_next().await {
        results.push(result.unwrap_or_else(|e| Err(AppError::Internal(e.into()))));
    }
    results
}

// So sánh với CompletableFuture.allOf() trong Java:
// Java: nếu một future panic → khó cleanup các future khác
// Rust JoinSet: drop JoinSet → tất cả tasks nhận cancellation signal
```

---

## 6. `tokio::pin!` Macro — Pin Stack Values

```rust
// Khi cần pin một Future trên stack (thay vì Box<>)
async fn race_with_timeout<F: Future>(future: F, timeout: Duration) -> Option<F::Output> {
    tokio::pin!(future);  // pin future onto stack
    
    tokio::select! {
        result = &mut future => Some(result),  // &mut future: Pin<&mut F>
        _ = tokio::time::sleep(timeout) => None,
    }
}

// Tại sao cần pin ở đây:
// select! poll future nhiều lần → future không được move giữa các polls
// tokio::pin! wrap future trong Pin<&mut F>

// Box::pin vs tokio::pin!:
// Box::pin    → heap allocation, ownership transferred
// tokio::pin! → stack pinned, không allocate, nhưng phải trong same scope
```

---

## 7. Async Trait — Vấn Đề và Giải Pháp

```rust
// Vấn đề: async fn trong trait không directly supported trước Rust 1.75
// (vì return type của async fn là impl Future, size không biết)

// Giải pháp 1: async_trait crate (cũ, vẫn phổ biến)
use async_trait::async_trait;

#[async_trait]
trait Repository {
    async fn find_by_id(&self, id: i64) -> Result<User, Error>;
    async fn save(&self, user: User) -> Result<User, Error>;
}
// async_trait: boxing return type → Box<dyn Future + Send>
// → small overhead: 1 heap alloc per call

// Giải pháp 2: Stable async fn in trait (Rust 1.75+)
trait Repository {
    fn find_by_id(&self, id: i64) -> impl Future<Output = Result<User, Error>> + Send;
    fn save(&self, user: User) -> impl Future<Output = Result<User, Error>> + Send;
}
// Không cần crate, không có boxing overhead
// Nhưng: có limitations với dyn dispatch
```

---

## 8. Debugging Async — Common Pitfalls

```rust
// Pitfall 1: Future không được poll (không có .await)
let f = some_async_fn();  // f là Future, CHƯA chạy gì!
// cần: let result = some_async_fn().await;

// Pitfall 2: Blocking trong async
async fn bad_handler(pool: &PgPool) -> Json<Vec<User>> {
    let users = pool.fetch_all().await.unwrap();
    let report = generate_pdf(&users);  // CPU-bound, blocks executor!
    Json(users)
}
// Fix:
async fn good_handler(pool: &PgPool) -> Json<Vec<User>> {
    let users = pool.fetch_all().await.unwrap();
    let report = tokio::task::spawn_blocking(move || generate_pdf(&users))
        .await.unwrap();
    Json(users)
}

// Pitfall 3: Holding lock across await
async fn bad() {
    let guard = mutex.lock().await;
    http_call().await;  // lock held during await → potential deadlock
    drop(guard);
}
// Fix: giải phóng lock trước khi await
async fn good() {
    let data = {
        let guard = mutex.lock().await;
        guard.clone()  // copy data, drop guard
    };
    http_call_with(data).await;
}

// Tool: tokio-console — real-time async debugger
// cargo add tokio-console
// Hiển thị: tasks, polls, waketime, stalls
```

---

## 9. Mental Model: Java vs Rust Async

| Concept | Java CompletableFuture | Rust Future + Tokio |
|---|---|---|
| Execution model | Callback chain on thread pool | Polling state machine |
| Task size | Platform thread (~1MB) | Async task (~8KB) |
| Scheduling | ForkJoinPool | Work-stealing (Tokio) |
| Cancellation | `future.cancel()` | Drop Future |
| Composition | `thenCompose`, `allOf` | `.await`, `join!`, `select!` |
| Error handling | `exceptionally()` | `?` operator |
| Self-referential | Not possible (GC handles) | `Pin<P>` required |
| Blocking detection | No tool | `tokio-console`, `spawn_blocking` |

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9: Tokio usage]] — prerequisite
- [[Rust-Zero-To-Hero/Bai-22-Advanced-Concurrency|Bài 22: Advanced Concurrency]] → tiếp theo
- [[MOC-Concurrency]]

---
*Bài tập:*
1. Implement `TimerFuture` trả về `Poll::Ready` sau N milliseconds. Dùng `std::thread::spawn` + `thread::sleep` + `Waker::wake()` để trigger. Test với `block_on(TimerFuture::new(100))`.
2. Dùng `JoinSet` để fetch 10 users parallel. Handle partial failures (một vài IDs không tồn tại) và collect cả successes và errors.
3. Viết async function có thể bị cancelled: dùng `tokio::select!` + `CancellationToken`. Verify task cleanup khi cancelled.
