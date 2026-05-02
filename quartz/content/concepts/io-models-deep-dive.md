---
tags: [concepts, os, io, async, networking, evergreen]
created: 2026-05-02
difficulty: intermediate
estimated-read: 25 min
links: [event-loop-model, os-process-thread-scheduling, backpressure-explained]
---

# ⚡ I/O Models Deep Dive — Từ Blocking đến io_uring

> **Mục tiêu:** Hiểu TẠI SAO Tokio, Netty, Vert.x hoạt động được ở tốc độ cao — không phải "magic", mà là kernel I/O mechanics rất cụ thể.

---

## 🎯 Tại sao cần học bài này?

Khi bạn viết `await someAsyncCall()` trong Rust/Java, hay config `event-loop-threads` trong Vert.x — bạn đang dựa vào một stack I/O model cụ thể của kernel. Không hiểu stack này dẫn đến:

- Config sai `worker threads` → CPU starve hoặc context switch storm
- Dùng blocking call trong async context → thread pinning, throughput sập
- Không giải thích được tại sao 1 Nginx thread serve được 10,000 concurrent connections

---

## 🧱 Nền tảng: Kernel vs Userspace

Mọi I/O operation đều đi qua kernel. Ứng dụng của bạn chạy ở **userspace**, không được trực tiếp đọc network card hay disk.

```
┌─────────────────────────────────────────────────────────┐
│                    USERSPACE                            │
│   Application Code   ←→   Standard Library (libc)      │
├─────────────────────────────────────────────────────────┤
│              SYSTEM CALL BOUNDARY                       │
│         (context switch: ~1-10 microseconds)            │
├─────────────────────────────────────────────────────────┤
│                    KERNEL SPACE                         │
│   VFS → Socket Buffer → Network Stack → Driver          │
└─────────────────────────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Hardware (NIC,    │
                    │   Disk, etc.)      │
                    └───────────────────┘
```

**Mỗi syscall** (`read()`, `write()`, `accept()`) là một context switch tốn kém. Đây là lý do tại sao tối thiểu số lượng syscall và tận dụng batching là quan trọng.

---

## 📖 5 I/O Models — Từ Cổ điển đến Hiện đại

### Model 1: Blocking I/O (BIO)

```
Thread          Kernel          Hardware
  │                │                │
  │─── read() ────►│                │
  │   (BLOCKED)    │──── DMA ──────►│
  │                │    wait...     │
  │                │◄─── data ──────│
  │◄── return ─────│                │
  │  (unblocked)   │                │
```

**Cơ chế:**
1. Thread gọi `read()` → kernel nhận syscall
2. Kernel đặt thread vào **wait queue** → thread bị preempt
3. Data đến → kernel copy vào socket buffer → wake up thread
4. Thread resume và copy data từ kernel buffer → userspace buffer

```java
// Java BIO — 1 thread per connection
ServerSocket server = new ServerSocket(8080);
while (true) {
    Socket client = server.accept();          // blocks
    new Thread(() -> {
        InputStream in = client.getInputStream();
        byte[] buf = new byte[1024];
        int n = in.read(buf);                 // blocks
        // process...
    }).start();
}
```

**Vấn đề:** 10,000 connections = 10,000 threads = ~10GB RAM + context switch hell.

---

### Model 2: Non-Blocking I/O (NIO poll-based)

```
Thread          Kernel          Hardware
  │                │                │
  │─── read() ────►│  (no data yet) │
  │◄── EAGAIN ─────│                │
  │   (spin...)    │                │
  │─── read() ────►│  (no data yet) │
  │◄── EAGAIN ─────│                │
  │   (spin...)    │                │
  │─── read() ────►│  data ready!   │
  │◄── data ───────│                │
```

**Cơ chế:** `O_NONBLOCK` flag trên socket. Kernel return `EAGAIN` ngay nếu không có data thay vì block.

**Vấn đề:** Busy-waiting = 100% CPU usage. Thực tế không dùng trực tiếp.

---

### Model 3: Multiplexing — select() / poll()

**Đây là nền tảng của "I/O Multiplexing"** — 1 thread theo dõi nhiều file descriptors.

```
Thread                    Kernel
  │                          │
  │─── select(fd1,fd2,fd3) ─►│  (kernel checks all fds)
  │        (BLOCKED)         │
  │                          │  ← data arrives on fd2
  │◄─── {fd2 is ready} ──────│
  │                          │
  │─── read(fd2) ───────────►│
  │◄─── data ────────────────│
  │                          │
  │─── select(fd1,fd2,fd3) ─►│  (next iteration)
  │                          │
```

```c
// C: select() example
fd_set readfds;
FD_SET(fd1, &readfds);
FD_SET(fd2, &readfds);
FD_SET(fd3, &readfds);

int ready = select(maxfd+1, &readfds, NULL, NULL, &timeout);
// Now check which fds are ready
```

**Vấn đề với select/poll:**
- `select`: max 1024 fds (FD_SETSIZE limit)
- `poll`: không giới hạn fd, nhưng O(n) scan mỗi lần — 10,000 fds = scan 10,000 entries mỗi syscall
- Copy toàn bộ fd set từ userspace → kernel mỗi lần gọi

---

### Model 4: epoll — Game Changer (Linux 2.6+)

```
                ┌─────────────────────────┐
                │   epoll instance (fd)   │
                │  ┌───────────────────┐  │
                │  │  Interest List    │  │
                │  │  fd1: EPOLLIN     │  │
                │  │  fd2: EPOLLIN     │  │
                │  │  fd3: EPOLLOUT    │  │
                │  └───────────────────┘  │
                │  ┌───────────────────┐  │
                │  │   Ready List      │  │
                │  │  (events fired)   │  │
                │  └───────────────────┘  │
                └─────────────────────────┘

Flow:
Thread                              Kernel
  │                                    │
  │─── epoll_create() ────────────────►│ (create epoll instance)
  │─── epoll_ctl(ADD fd1) ────────────►│ (register interest)
  │─── epoll_ctl(ADD fd2) ────────────►│
  │─── epoll_wait() ──────────────────►│ (BLOCK — efficient)
  │         ...                        │ ← fd2 gets data
  │                                    │ kernel adds fd2 to ready list
  │◄── [{fd2, EPOLLIN}] ───────────────│
  │                                    │
  │─── read(fd2) ─────────────────────►│ (only read ready fd)
```

**Tại sao epoll O(1) thay vì O(n):**

| | select/poll | epoll |
|---|---|---|
| Copy fd list mỗi lần | ✅ (O(n)) | ❌ (register once) |
| Scan all fds | ✅ (O(n)) | ❌ |
| Callback khi fd ready | ❌ | ✅ (kernel callback) |
| Max fds | 1024 / unlimited | ~millions |

**epoll là nền tảng của Nginx, Redis, Node.js, Netty, Tokio (trên Linux).**

```rust
// Tokio internally uses epoll via mio crate
// When you write:
let data = tokio::net::TcpStream::connect(addr).await;
// Tokio registers the socket with epoll,
// suspends the task (NOT the thread),
// resumes when epoll_wait returns the event
```

---

### Model 5: io_uring — The Future (Linux 5.1+, 2019)

**Vấn đề còn lại của epoll:**
- `epoll_wait` báo "fd ready" → bạn vẫn phải gọi `read()` → 2 syscalls
- Kernel copy data → userspace buffer: memory copy
- Nhiều small operations = nhiều syscalls

**io_uring giải quyết bằng shared ring buffers:**

```
┌──────────────────────────────────────────────────────────┐
│              SHARED MEMORY (Userspace + Kernel)           │
│                                                          │
│  ┌─────────────────────┐    ┌─────────────────────────┐  │
│  │  Submission Queue   │    │   Completion Queue      │  │
│  │  (SQ) — App writes  │    │   (CQ) — Kernel writes  │  │
│  │                     │    │                         │  │
│  │  [read fd1]         │    │  [read fd1: 1024 bytes] │  │
│  │  [write fd2]        │    │  [write fd2: done]      │  │
│  │  [accept fd3]       │    │  [accept fd3: new conn] │  │
│  └─────────────────────┘    └─────────────────────────┘  │
│           │                           ▲                  │
└───────────┼───────────────────────────┼──────────────────┘
            │    io_uring_enter()       │
            └───────── Kernel ──────────┘
                    (batch process)
```

**Ưu điểm:**
- **Zero syscall** cho nhiều operations (kernel polls SQ)
- **Zero copy** với registered buffers
- **Batch submissions**: 100 ops → 1 `io_uring_enter()` call
- Hỗ trợ cả disk I/O (epoll chỉ tốt cho network/pipe)

```rust
// tokio-uring (experimental)
use tokio_uring::fs::File;
let file = File::open("hello.txt").await.unwrap();
let buf = vec![0u8; 4096];
let (res, buf) = file.read_at(buf, 0).await; // zero-copy
```

---

## 🔄 Async I/O = epoll + State Machine + Scheduler

**Hiểu sai phổ biến:** "Async = non-blocking = faster"

**Thực tế:**

```
┌──────────────────────────────────────────────────────────┐
│              ASYNC RUNTIME (Tokio / Netty / Vert.x)      │
│                                                          │
│  ┌───────────┐    ┌───────────┐    ┌───────────────────┐ │
│  │  Task 1   │    │  Task 2   │    │      Reactor      │ │
│  │ (Future)  │    │ (Future)  │    │  (epoll_wait)     │ │
│  └─────┬─────┘    └─────┬─────┘    └────────┬──────────┘ │
│        │                │                   │            │
│        └────────────────┴─────── Scheduler ─┘            │
│                      (work-stealing)                     │
└──────────────────────────────────────────────────────────┘
```

**Flow khi `await` một network call:**
1. Task gọi `socket.read().await`
2. Scheduler kiểm tra: socket có data không? → Không
3. Scheduler register socket với epoll (`EPOLLIN`)
4. Scheduler **suspend task** (not thread!) → lưu state machine
5. Thread free → execute Task 2
6. epoll_wait returns: socket ready
7. Scheduler resume Task 1 → chạy tiếp từ chỗ suspended

**Key insight:** Thread không block. Task suspend. Thread vẫn chạy task khác.

---

## 📊 Comparison Table

| Model | Concurrency | CPU Usage | Complexity | Use Case |
|-------|------------|-----------|------------|----------|
| Blocking (BIO) | 1:1 thread | Low (sleep) | Simple | Internal tools, low traffic |
| Non-blocking poll | 1:N | 100% (spin) | Medium | — (deprecated) |
| select/poll | 1:N | Low | Medium | Simple servers, <1024 conns |
| **epoll** | **1:millions** | **Very Low** | **Medium** | **Nginx, Redis, Node.js** |
| **io_uring** | **1:millions** | **Lowest** | **Complex** | **High-perf disk+net I/O** |
| IOCP (Windows) | 1:millions | Very Low | Complex | Windows services |

---

## 💡 Tips & Tricks

> **Tip 1 — Đừng block event loop**
> Trong Tokio/Vert.x, 1 blocking call (`Thread.sleep()`, JDBC query, file read sync) trên event loop thread = freeze toàn bộ event loop. Dùng `tokio::task::spawn_blocking()` hoặc Vert.x `executeBlocking()`.

> **Tip 2 — Thread count tuning**
> - Tokio mặc định: `num_cpus` worker threads (CPU-bound tasks)
> - Blocking thread pool: up to 512 threads (I/O blocking tasks)
> - `TOKIO_WORKER_THREADS=8` env var để override

> **Tip 3 — epoll edge-triggered vs level-triggered**
> - Level-triggered (default): epoll_wait returns mỗi lần socket có data
> - Edge-triggered (EPOLLET): chỉ báo khi state change (ready → not ready)
> - Edge-triggered: phải read until EAGAIN, ít syscall hơn nhưng dễ miss events

> **Tip 4 — Kiểm tra io_uring support**
> ```bash
> cat /boot/config-$(uname -r) | grep CONFIG_IO_URING
> # CONFIG_IO_URING=y → supported
> ```

---

## 🔬 Case Studies

### Case Study 1: Nginx vs Apache
- **Apache**: BIO model, 1 process per connection → C10K problem
- **Nginx**: epoll-based event loop, 1 worker process per CPU → C10K solved

Nginx config:
```nginx
worker_processes auto;          # = num CPU cores
events {
    worker_connections 10240;   # per worker
    use epoll;                  # explicit epoll
    multi_accept on;            # accept() multiple conns per epoll event
}
```

### Case Study 2: Redis Single Thread
Redis dùng **1 single-threaded event loop + epoll** mà vẫn handle 1M ops/sec:
```
1 thread + epoll = sufficient vì:
- Operations are in-memory (nanoseconds)
- No CPU contention → no lock overhead
- epoll handles 10K+ connections với O(1)
```

Redis 6.0 thêm I/O threads nhưng vẫn single-threaded for commands.

### Case Study 3: Java NIO → Virtual Threads
```java
// Pre-Java 21: NIO với Selector (epoll wrapper)
Selector selector = Selector.open();
channel.register(selector, SelectionKey.OP_READ);
selector.select(); // epoll_wait under the hood

// Java 21+: Virtual Threads (Project Loom)
// Blocking code NHƯNG không block OS thread
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    executor.submit(() -> {
        // This looks blocking but underneath:
        // JVM suspends virtual thread, OS thread free
        InputStream data = socket.getInputStream().read(); 
    });
}
```

Virtual Threads của Java 21 = async ergonomics của blocking code + epoll performance.

### Case Study 4: PDMS Context
```
PDMS hiện dùng Spring Boot + JDBC (blocking):
- OK cho current load vì Virtual Threads available (Java 21+)
- Nếu migrate sang reactive (R2DBC): phải hiểu epoll model
- Recommendation: JDBC + Virtual Threads (đã documented trong vault)
  → đây là lý do recommendation đó đúng!
```

---

## 🔗 Liên kết

- [[event-loop-model]] — Vert.x / WebFlux event loop implementation
- [[os-process-thread-scheduling]] — Context switch cost, why threads are expensive
- [[java-virtual-threads-deep-dive]] — Virtual Threads = blocking code + epoll
- [[backpressure-explained]] — Khi async pipeline bị overwhelmed
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio]] — Tokio implementation
- [[Rust-Zero-To-Hero/Bai-9c-Tokio-Internals-Visual]] — Tokio reactor visual

---

## 📝 Key Takeaways

1. **Mọi I/O đều qua kernel** — syscall boundary là context switch tốn kém
2. **epoll O(1)** thay vì select/poll O(n) — nền tảng của high-concurrency servers
3. **Async ≠ faster** — async giảm thread count, giảm context switches, giảm RAM
4. **Event loop = epoll + scheduler + state machines** — không magic
5. **io_uring** = next level: zero syscall, zero copy, batch operations
6. **Blocking trong async context = chết** — luôn dùng blocking thread pool
