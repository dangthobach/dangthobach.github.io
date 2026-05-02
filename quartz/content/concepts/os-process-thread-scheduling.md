---
tags: [concepts, os, concurrency, scheduling, threads, evergreen]
created: 2026-05-02
difficulty: intermediate
estimated-read: 20 min
links: [io-models-deep-dive, memory-hierarchy-cpu-cache, java-virtual-threads-deep-dive]
---

# 🔧 OS Process, Thread & Scheduling — Nền tảng của mọi Concurrency Model

> **Mục tiêu:** Hiểu tại sao Goroutine rẻ hơn OS Thread 100x, tại sao Virtual Thread là game changer, và tại sao context switch làm chậm server.

---

## 🎯 Tại sao cần học bài này?

```
Câu hỏi: Tại sao Nginx config worker_processes = num_cores thay vì 1000?
Câu hỏi: Tại sao Java cần Virtual Threads nếu đã có thread pool?
Câu hỏi: Tại sao Go có thể spawn 1 triệu goroutines nhưng không nên spawn
         1 triệu OS threads?

→ Câu trả lời đều nằm ở OS scheduler và context switch cost.
```

---

## 🏗️ Process vs Thread vs Green Thread

```
┌──────────────────────────────────────────────────────────────┐
│                        PROCESS                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                   Virtual Address Space                │  │
│  │  Code Segment │ Data Segment │ Heap │ Stack (per thread)│  │
│  └────────────────────────────────────────────────────────┘  │
│  File Descriptors │ Signal Handlers │ PID │ Memory Maps      │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐             │
│  │  Thread 1  │  │  Thread 2  │  │  Thread 3  │             │
│  │  (kernel   │  │  (kernel   │  │  (kernel   │             │
│  │  scheduled)│  │  scheduled)│  │  scheduled)│             │
│  │  ~2MB stack│  │  ~2MB stack│  │  ~2MB stack│             │
│  └────────────┘  └────────────┘  └────────────┘             │
└──────────────────────────────────────────────────────────────┘
```

| | Process | OS Thread | Green Thread (Goroutine/VThread) |
|---|---|---|---|
| Memory | ~10-100MB | ~2-8MB stack | ~2-8KB stack |
| Creation time | ~1ms | ~100µs | ~1µs |
| Max count | ~1000 | ~10,000 | ~millions |
| Scheduling | OS kernel | OS kernel | User-space scheduler |
| Context switch | ~10µs | ~5µs | ~0.1µs |
| Preemptive? | ✅ | ✅ | ✅ (Go) / Cooperative (some) |

---

## ⚙️ OS Scheduler — Cơ chế bên trong

### CFS — Completely Fair Scheduler (Linux)

```
┌─────────────────────────────────────────────────────────────┐
│                    Run Queue (per CPU core)                  │
│                    Red-Black Tree (sorted by vruntime)       │
│                                                             │
│       vruntime:  10   15   20   28   35   47                │
│                  [T1] [T4] [T2] [T5] [T3] [T6]              │
│                   ▲                                         │
│              next to run                                    │
│              (leftmost node)                                │
└─────────────────────────────────────────────────────────────┘

vruntime = actual_runtime × (1024 / weight)
→ Lower vruntime = ran less recently = higher priority to run next
→ Higher weight (nice -20) = lower vruntime growth = more CPU time
```

**Time slice (quantum):** Default ~4ms-8ms. Thread runs, then **preempted** → back to queue.

### Context Switch — Chi phí thực sự

```
Thread A running on Core 0:
┌─────────────────────────────────────────────────────────────┐
│ CPU Registers: RAX, RBX, RSP, RIP, RFLAGS, XMM0..XMM15... │
│ Cache lines: ~100KB L1 cache "warm" for Thread A            │
│ TLB: Translation Lookaside Buffer filled with A's pages     │
└─────────────────────────────────────────────────────────────┘

Context Switch to Thread B:
1. Save A's registers to A's kernel stack           ~200ns
2. Save A's FPU/SIMD state (if used)               ~100ns
3. Load B's registers from B's kernel stack         ~200ns
4. Switch page table (if different process)         ~500ns
5. TLB flush (or ASID tag if available)            ~1000ns
6. L1/L2 cache "cold" for B — cache misses         ~5000ns!!
                                          Total: ~1-10 µs
```

**Key insight:** Phần tốn kém nhất không phải register save/restore mà là **cache cold start** sau switch.

---

## 🟢 Green Threads & M:N Threading

```
                    ┌──────────────────────────────────┐
                    │         User Space                │
                    │   ┌────┐ ┌────┐ ┌────┐ ┌────┐   │
                    │   │ G1 │ │ G2 │ │ G3 │ │ G4 │   │  Goroutines / Tasks
                    │   └─┬──┘ └─┬──┘ └─┬──┘ └─┬──┘   │  (lightweight)
                    │     └──────┴──┬───┴──────┘        │
                    │   ┌───────────▼────────────────┐  │
                    │   │   User-Space Scheduler     │  │  Go runtime / Tokio / JVM
                    │   │   (Work-stealing, M:N)     │  │
                    │   └───────────┬────────────────┘  │
                    └──────────────-┼───────────────────┘
                                    │ (syscalls only when needed)
                    ┌───────────────▼───────────────────┐
                    │         Kernel Space               │
                    │   ┌────────┐  ┌────────┐          │
                    │   │OS Thr 1│  │OS Thr 2│          │  M OS Threads (M = num_cpus)
                    │   └────────┘  └────────┘          │
                    └───────────────────────────────────┘
```

**M:N model:** N goroutines/tasks → M OS threads (M << N)

---

## 🔵 Go — G-M-P Scheduler

```
G = Goroutine (user-space task, 2KB initial stack)
M = Machine (OS Thread)
P = Processor (logical CPU, has local run queue)

┌─────────────────────────────────────────────────────────────┐
│                    Go Runtime                               │
│                                                             │
│  P0 ──── M0 (OS Thread)     P1 ──── M1 (OS Thread)         │
│   │                          │                             │
│   │  Local Queue             │  Local Queue                │
│  [G1][G2][G3]               [G4][G5]                       │
│                                                             │
│  Global Queue: [G6][G7][G8][G9]                             │
│                                                             │
│  Work Stealing: P0 idle → steal half of P1's local queue   │
└─────────────────────────────────────────────────────────────┘
```

**Goroutine scheduling:**
- Stack starts at **2KB** (vs 2MB OS thread)
- **Growable stack**: auto-expand up to 1GB if needed (stack copy)
- **Preemptive** (Go 1.14+): goroutines preempted at safe points, no more long-running G blocking others
- **Syscall**: M detaches from P, P picks another M/creates new M → G blocks without blocking P

```go
// 1 million goroutines = ~2GB RAM (2KB each)
// 1 million OS threads = ~2TB RAM (2MB each)
for i := 0; i < 1_000_000; i++ {
    go func() {
        // tiny goroutine
        time.Sleep(time.Second)
    }()
}
```

---

## 🟠 Java — Virtual Threads (Project Loom)

```
Traditional Java (before Java 21):
┌──────────────────────────────────────────────────────────────┐
│  Virtual Thread = OS Thread  (1:1 mapping)                   │
│  thread.execute(task) → OS creates new thread → 2MB stack   │
│  thread.block(I/O)   → OS thread blocked → CPU idle         │
└──────────────────────────────────────────────────────────────┘

Java 21+ Virtual Threads:
┌──────────────────────────────────────────────────────────────┐
│  Virtual Thread (VT) — managed by JVM                        │
│  Initial stack: ~1KB heap-allocated                          │
│                                                              │
│  VT1, VT2, VT3, ... VT1_000_000                             │
│         │                                                    │
│         ▼ (scheduled onto)                                   │
│  Carrier Thread Pool (ForkJoinPool, default = num_cpus)      │
│  CT1, CT2, CT3, CT4  (OS Threads — always running)          │
└──────────────────────────────────────────────────────────────┘

When VT calls blocking I/O:
1. JVM intercepts (via java.io rewiring)
2. VT unmounts from carrier thread (saves stack to heap)
3. Carrier thread free → runs another VT
4. I/O completes → VT remounts on any available carrier thread
5. VT continues from saved state
```

```java
// Java 21: spawn 1M virtual threads safely
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    IntStream.range(0, 1_000_000)
        .forEach(i -> executor.submit(() -> {
            Thread.sleep(Duration.ofSeconds(1)); // blocks VT, not carrier!
            return i;
        }));
}
// Total carrier threads: ~num_cpus (e.g., 8)
// Total virtual threads: 1,000,000
// Memory: ~1GB (vs ~2TB with OS threads)
```

**Pinning vấn đề (phải tránh):**
```java
// ❌ Pinning: carrier thread bị pin khi VT inside synchronized block + blocking
synchronized (lock) {
    Thread.sleep(1000); // pins carrier thread! Other VTs can't use it
}

// ✅ Use ReentrantLock instead
ReentrantLock lock = new ReentrantLock();
lock.lock();
try {
    Thread.sleep(1000); // VT unmounts properly
} finally {
    lock.unlock();
}
```

---

## ⚡ Rust — Tokio's Work-Stealing Executor

```
Tokio Runtime:
┌─────────────────────────────────────────────────────────────┐
│  Worker Thread 0    Worker Thread 1    Worker Thread 2       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Local Queue  │  │ Local Queue  │  │ Local Queue  │      │
│  │ [T1][T2][T3] │  │ [T4][T5]    │  │ [T6]         │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │ steal ◄──────── │ steal ──────────►│              │
│         │                 │                  │              │
│  ┌──────▼─────────────────▼──────────────────▼───────────┐  │
│  │              Injection Queue (global)                   │  │
│  │              New tasks spawned here first               │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

Task lifecycle:
async fn my_task() {               // Future (state machine)
    let data = fetch_data().await; // suspend point: registers with epoll
    process(data);                 // resumed when epoll fires
}
```

**Tokio task = pure state machine** compiled by Rust compiler. No stack allocation. Context switch = swap task pointer. ~0.1µs vs ~5µs for OS thread.

---

## 📊 Concurrency Model Comparison

```
┌──────────────────────────────────────────────────────────────┐
│                   10,000 Concurrent Connections              │
├─────────────────┬────────────┬────────────┬──────────────────┤
│   Model         │ Memory     │ CPU (ctx)  │ Suitable for     │
├─────────────────┼────────────┼────────────┼──────────────────┤
│ 1 Thread/conn   │ 20 GB!!    │ High       │ Never at scale   │
│ Thread Pool     │ Fixed      │ Medium     │ CPU-bound tasks  │
│ Async/epoll     │ ~MB        │ Very Low   │ I/O-bound (high) │
│ Virtual Threads │ ~1GB/1M    │ Low        │ Mixed I/O+CPU    │
│ Goroutines      │ ~2GB/1M    │ Very Low   │ I/O + services   │
│ Tokio Tasks     │ ~MB/1M     │ Lowest     │ High-perf I/O    │
└─────────────────┴────────────┴────────────┴──────────────────┘
```

---

## 💡 Tips & Tricks

> **Tip 1 — Đo context switch**
> ```bash
> vmstat 1 5          # cs column = context switches/sec
> pidstat -w 1        # cswch/s = voluntary, nvcswch/s = involuntary
> # >100K ctx/sec = warning sign
> ```

> **Tip 2 — Thread pool sizing**
> ```
> CPU-bound:  pool_size = num_cores (no benefit > cores)
> I/O-bound (blocking): pool_size = num_cores × (1 + wait_time/compute_time)
>   Example: 80% wait, 20% compute → 4 cores → pool = 4 × (1 + 4) = 20
> I/O-bound (async): pool_size = num_cores (event loop, no blocking)
> ```

> **Tip 3 — Go goroutine leak detection**
> ```go
> import "runtime"
> // Check goroutine count
> fmt.Println(runtime.NumGoroutine())
> // Tool: goleak for unit tests
> defer goleak.VerifyNone(t)
> ```

> **Tip 4 — Java VThread + JDBC = still blocking**
> JDBC drivers are blocking by nature. VThread will pin carrier thread if not careful.
> Use: `--add-opens java.base/java.lang=ALL-UNNAMED` + Spring Boot 3.2 JDBC virtualthreads support.

---

## 🔬 Case Studies

### Case Study 1: Apache → Nginx migration
```
Apache: prefork MPM = 1 process per request
→ 10,000 requests = 10,000 processes × 10MB = 100GB RAM

Nginx: event-driven + epoll
→ 10,000 requests = 4 worker processes × 8MB = 32MB RAM

Context: same hardware → Nginx served 10x more traffic
```

### Case Study 2: Go's Goroutine vs Java Thread (pre-Loom)
```
Benchmark: HTTP server, 10,000 concurrent requests

Java (thread-per-request):
- Thread pool: 200 threads max
- Queue builds up: 9800 requests waiting
- Throughput: limited by thread pool size

Go:
- 10,000 goroutines spawned (trivially)
- G-M-P scheduler maps to 8 OS threads
- Throughput: limited by CPU/network, not concurrency model
```

### Case Study 3: PDMS Recommendation
```
PDMS: Spring Boot, JDBC, banking CRUD operations
→ I/O-bound (PostgreSQL queries, file system)
→ Current: thread-per-request (Tomcat default 200 threads)

Recommended upgrade path:
1. Java 21+ Virtual Threads:
   spring.threads.virtual.enabled=true
   → Instant benefit: 10x more concurrent requests
   → No code change needed
   → JDBC works naturally (blocking = unmount VT, not carrier)

2. Watch for: @Transactional + synchronized → pinning risk
   → Replace synchronized with ReentrantLock
```

---

## 📝 Key Takeaways

1. **OS Thread = ~2MB stack + kernel metadata** — expensive to create/switch
2. **Context switch cost = 1-10µs** — mostly from cache cold start, not register save
3. **Go Goroutine = 2KB + G-M-P scheduler** — work-stealing, preemptive Go 1.14+
4. **Java VThread = heap-allocated stack, unmounts on blocking** — solves thread-per-request bottleneck
5. **Tokio task = state machine, no stack** — cheapest possible context switch
6. **Avoid blocking on event loop/carrier threads** — always biggest mistake
7. **Thread pool sizing**: CPU-bound = num_cores, I/O blocking = Little's Law formula

---

## 🔗 Liên kết

- [[io-models-deep-dive]] — epoll underneath async runtimes
- [[memory-hierarchy-cpu-cache]] — Cache cold start during context switch
- [[java-virtual-threads-deep-dive]] — Java Loom deep dive
- [[Go-Zero-To-Hero/Bai-3-Goroutines-Channels]] — Go concurrency in practice
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio]] — Tokio executor
- [[Go-Zero-To-Hero/Deep-Dive-VirtualThreads-vs-Goroutines-vs-RustAsync]] — Comparison
