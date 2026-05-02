# Bài 9c: Tokio — Cơ Chế Nội Tại (Mental Models & Diagrams)

> Mục tiêu: thấy được cái gì đang xảy ra bên trong, không chỉ biết API.
> Prerequisites: [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9]] + [[Rust-Zero-To-Hero/Bai-9b-Tokio-Advanced|Bài 9b]]

---

## 1. Polling Model — Future không tự chạy

Khái niệm cốt lõi nhất và khó "thấy" nhất. Future trong Rust là **lazy** — không có gì xảy ra cho đến khi Executor poll. Poll không block thread, nó chỉ hỏi "xong chưa?".

```
Executor          Future              IO Driver (epoll/kqueue)
    |                 |                       |
    |--- poll(cx) --->|                       |
    |                 |--- register Waker --->|
    |<-- Pending -----|                       |
    |                 |             [OS: TCP packet arrives]
    |                 |<-- Waker.wake() ------|
    |  [re-schedule]  |                       |
    |--- poll(cx) --->|                       |
    |<-- Ready(v) ----|                       |

Worker thread KHÔNG block trong suốt — nó chạy task khác
```

**Tại sao không phải callback?**
- Callback hell: composability kém, error handling phức tạp
- Polling: Executor kiểm soát hoàn toàn scheduling, zero allocation per wakeup
- Waker chỉ là function pointer — cực kỳ nhẹ

**Thread timeline thực tế:**
```
Thread 0: [poll Task A → Pending] [poll Task B → Pending] [poll Task C → Ready] [poll Task A → Ready]
           |                        |                        |                     |
           Task A yield khi await   Task B yield khi await   Task C xong          A được wake bởi IO
```

---

## 2. `async fn` là State Machine trong Memory

Khi compiler thấy `async fn`, nó tạo ra một `enum` với mỗi `.await` là một variant. Đây là thứ thực sự sống trên heap.

```rust
// Bạn viết:
async fn load(id: u32) -> Result<User> {
    let url = build(id);            // state 0: Init
    let res = http::get(url).await; // state 1: AwaitHttp { id, url }
    let body = res.text().await;    // state 2: AwaitText { id, res }
    parse(body)                     // state 3: Done
}

// Compiler sinh ra (conceptually):
enum LoadFuture {
    Init { id: u32 },
    AwaitHttp { id: u32, url: String },   // url phải được giữ!
    AwaitText { id: u32, res: Response }, // res phải được giữ!
    Done,
}

// Trên heap: tokio::Task { waker, state: LoadFuture, next_ptr, vtable }
```

**Tại sao cần `Pin<&mut Self>`?**
`AwaitHttp` giữ tham chiếu đến `url` — nhưng `url` nằm **trong** state machine đó (self-referential struct). Nếu Future bị `move` sang địa chỉ memory khác → pointer trỏ vào địa chỉ cũ → dangling reference → UB. `Pin` ngăn Future bị move sau khi pinned.

**Size của Task = size của largest variant**, không phải tổng. Compiler tính sao cho union đủ chứa variant lớn nhất.

---

## 3. Work-Stealing Scheduler

```
Các task được spawn:
tokio::spawn(A), spawn(B), spawn(C), spawn(D), spawn(E), spawn(F)
→ push vào local queue của Worker 0 (LIFO: F ở đầu)

Worker 0 queue: [F, E, D, C, B, A]
Worker 1 queue: []
Worker 2 queue: []
Worker 3 queue: []

↓ Workers 1,2 rảnh → steal từ đuôi queue của W0 (FIFO steal)

Worker 0 queue: [F, E, D, C]   ← poll F
Worker 1 queue: [A]            ← stolen
Worker 2 queue: [B]            ← stolen
Worker 3 queue: []             ← chờ

↓ Task F gặp .await → yield

Worker 0: poll D (F suspended, đang ở IO driver)
Worker 1: poll A
Worker 2: poll B
Worker 3: idle (hoặc steal từ ai đó)

Thread KHÔNG bao giờ block — chỉ task bị suspend
```

**Cooperative = bạn phải yield**. Nếu một task loop không có `.await`:
```rust
// ❌ STARVATION: chiếm cả worker thread
async fn bad() {
    loop { i += 1; } // không yield bao giờ → starve các task khác
}

// ✅ Yield thủ công nếu cần compute lâu
async fn ok() {
    loop {
        i += 1;
        if i % 10_000 == 0 { tokio::task::yield_now().await; }
    }
}

// ✅ Tốt nhất: CPU-bound → spawn_blocking
async fn best() {
    tokio::task::spawn_blocking(|| { /* heavy */ }).await.unwrap();
}
```

**Spawn_blocking là thread pool riêng** — không ảnh hưởng worker threads. Default size: 512 threads.

---

## 4. Tokio Mutex vs std Mutex — Bản Chất Deadlock

```
❌ std::sync::Mutex trong async:

Thread 0:
  Task A: guard = std_mutex.lock()   ← OS mutex acquired (kernel)
  Task A: fetch_db().await           ← yield, thread 0 rảnh
  Task B chạy trên Thread 0
  Task B: std_mutex.lock()           ← BLOCK THREAD (OS syscall futex)
  Thread 0 bị freeze → Task A không bao giờ drop guard → DEADLOCK

Vấn đề: std::sync::Mutex block OS thread, không biết về async runtime.

✅ tokio::sync::Mutex:

Thread 0:
  Task A: guard = tokio_mutex.lock().await  ← async acquire
  Task A: fetch_db().await                  ← yield (giữ guard OK)
  Task B cần lock → lock().await → SUSPEND TASK B (không phải thread)
  Thread 0 tự do chạy Task C, Task D...
  Task A drop guard → Waker của Task B được gọi → B được schedule lại
  Task B chạy, acquire lock thành công
```

**Memory difference:**
- `std::MutexGuard` — giữ OS mutex (futex), blocking
- `tokio::MutexGuard` — giữ atomic flag + Waker list, non-blocking

**Rule thực tế:**
```
Guard không qua .await → std::sync::Mutex  (7-10ns overhead)
Guard qua .await       → tokio::sync::Mutex (bắt buộc)
State không cần share  → message passing với channel (tốt nhất)
```

---

## 5. Channel Memory Layout

### mpsc — Ring Buffer với Backpressure

```
Arc<Shared> trên heap:
┌─────────────────────────────────────────────┐
│ ring_buffer: ["A", "B", empty, empty]        │
│ head: 0 (receiver pop từ đây)                │
│ tail: 2 (sender push vào đây)                │
│ receiver_waker: Option<Waker>               │
│ sender_waiters: VecDeque<Waker>             │
└─────────────────────────────────────────────┘
     ↑              ↑
  Sender (clone)  Receiver (unique)
  Arc::clone      Arc::clone

Sender.send() khi buffer đầy:
  → push Waker vào sender_waiters → suspend task
  → khi receiver pop → wake một sender
  → backpressure tự nhiên
```

### oneshot — Single Slot

```
Arc<Inner>:
┌──────────────────────────────────┐
│ slot: Option<T> = None           │
│ is_complete: AtomicBool = false  │
│ receiver_waker: Option<Waker>    │
└──────────────────────────────────┘
    ↑              ↑
  Sender         Receiver
  (consumed khi send)  (consumed khi await)

Sender.send(v) → slot = Some(v), is_complete = true, wake receiver
Receiver.await → poll → Pending (đăng ký waker) → sau đó Ready(v)
```

### broadcast — Ring Buffer với Per-Subscriber Cursor

```
Arc<Shared>:
┌───────────────────────────────────────────┐
│ ring: [msg1, msg2, empty, empty]           │
│ tail: 2 (next write position)             │
│                                           │
│ Ref counts per slot (không xoá khi 1 sub đọc)│
└───────────────────────────────────────────┘

Receiver A: cursor = 0  → chưa đọc msg1
Receiver B: cursor = 1  → đọc msg1 rồi, chờ msg3

Slot bị overwrite khi ring đầy → Receiver chậm nhận LaggingError
```

### watch — Single Slot + Version

```
Arc<RwLock<Inner>>:
┌──────────────────────────────────────────┐
│ value: Config { timeout: 30 }            │
│ version: u64 = 7                         │
│ waiters: Vec<Waker>                      │
└──────────────────────────────────────────┘

Receiver A: last_seen = 6 → có update mới (7 > 6) → wake
Receiver B: last_seen = 7 → up to date, tiếp tục chờ

rx.borrow() → read lock (zero-copy access)
tx.send()   → write lock, version++, wake all waiters
```

**Chọn channel theo access pattern:**

| Pattern | Channel |
|---|---|
| Queue có backpressure | `mpsc` |
| Request → Response một lần | `oneshot` |
| Event → N subscribers (tất cả nhận) | `broadcast` |
| State → N subscribers (chỉ cần latest) | `watch` |

---

## 6. select! — Race Trong Memory

```rust
tokio::select! {
    result = future_A => { ... }
    result = future_B => { ... }
    _ = sleep(timeout) => { ... }
}
```

Được compile thành:
```
1. Pin cả 3 futures trên stack (không heap — zero alloc!)
2. Poll future_A → Pending → register Waker A
3. Poll future_B → Pending → register Waker B
4. Poll sleep   → Pending → register Waker C
5. Suspend

Khi bất kỳ Waker nào fire:
6. Poll lại future tương ứng
7. Nếu Ready → execute branch đó, DROP các futures còn lại
   (Drop = cancel tự động — Rust ownership làm điều này free)
```

**Cancellation-safe issue:** Nếu `future_A` bị drop giữa chừng mà nó đang giữ một lock hay đã gửi một request HTTP — cleanup không xảy ra trừ khi implement `Drop`. Đây là lý do cần `CancellationToken` cho complex tasks.

---

## 7. Reactor Architecture — Toàn Cảnh

```
                    ┌─────────────────────────────────────────┐
                    │              Tokio Runtime                │
                    │                                          │
  tokio::spawn() ──>│  Global Injection Queue                  │
                    │         │                                │
                    │   ┌─────▼──────────────────────┐        │
                    │   │    Work-Stealing Scheduler   │        │
                    │   └─────┬──────┬──────┬─────────┘        │
                    │         │      │      │                   │
                    │      [W0]   [W1]   [W2]   [W3]           │
                    │   local  local  local  local              │
                    │   queue  queue  queue  queue              │
                    │         │                                │
                    │   ┌─────▼──────────────────────┐        │
                    │   │        IO Driver (mio)       │        │
                    │   │  epoll/kqueue/IOCP           │        │
                    │   │  Waker registry              │        │
                    │   └─────────────────────────────┘        │
                    │                                          │
                    │   ┌─────────────────────────────┐        │
                    │   │   Blocking Thread Pool       │        │
                    │   │   (spawn_blocking tasks)     │        │
                    │   │   default: 512 threads       │        │
                    │   └─────────────────────────────┘        │
                    └─────────────────────────────────────────┘

Java Spring WebFlux analog:
  Reactor Netty ↔ Tokio + mio
  EventLoop     ↔ Worker Thread
  Mono/Flux     ↔ Future/Stream
  Scheduler     ↔ tokio Runtime
```

---

## 8. Spawn vs Await — Khi Nào Dùng Gì

```
Situation                          Solution
─────────────────────────────────────────────────────────
2 async calls, cần cả 2 kết quả   tokio::join!(a, b)
2 async calls, lấy cái nào xong   tokio::select!(a, b)
Fire and forget (không cần kết quả) tokio::spawn(task)
Cần kết quả nhưng chạy độc lập    let h = tokio::spawn(); h.await
CPU-bound work (>10µs)             spawn_blocking(|| work)
Sequential (đơn giản nhất)         let a = f1().await; let b = f2().await

Memory:
  join!     → poll cả hai futures trên STACK (zero alloc)
  spawn()   → allocate task trên HEAP, JoinHandle là pointer đến nó
  select!   → pin futures trên stack, drop losers khi winner ready
```

---

## 9. Waker — Cầu Nối Giữa IO Driver và Executor

```
Waker là gì? Một fat pointer:
  data: *const ()   // context của executor (pointer đến task)
  vtable: &WakerVTable {
    wake:       fn(*const ()),  // push task vào run queue
    wake_by_ref fn(*const ()),
    clone:      fn(*const ()) -> RawWaker,
    drop:       fn(*const ()),
  }

Flow khi register Waker với epoll:
1. Future gọi cx.waker().clone() → clone Waker (ref count task++)
2. Gửi Waker xuống mio/epoll interest list (fd → Waker mapping)
3. Future return Poll::Pending

Flow khi IO event xảy ra:
1. epoll_wait() return → mio lookup Waker cho fd này
2. Waker.wake() → executor.push_task(task_ptr)
3. Worker thread poll task → Poll::Ready
4. Waker dropped → task ref count--
```

Toàn bộ cơ chế này là **zero syscall** sau khi đã register. epoll wait ở background, không consume CPU.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9: Async cơ bản]]
- [[Rust-Zero-To-Hero/Bai-9b-Tokio-Advanced|Bài 9b: Tokio Advanced — API & Patterns]]
- [[Rust-Zero-To-Hero/Bai-10-Axum-Core|Bài 10: Axum — áp dụng thực tế]]
