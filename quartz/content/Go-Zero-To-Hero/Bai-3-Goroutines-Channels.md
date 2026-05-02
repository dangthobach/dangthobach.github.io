# Bài 3: Goroutines & Channels — Go Concurrency Model

> **Mục tiêu:** Hiểu sâu GMP scheduler, channel patterns, common concurrency patterns — so sánh với Java và Rust.

---

## 1. GMP Model — Trái tim của Go Scheduler

```
┌──────────────────────────────────────────────────────────────┐
│                    GMP SCHEDULER                             │
│                                                              │
│  G = Goroutine    M = Machine (OS Thread)    P = Processor  │
│                                                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │  P1 (Local Queue)     P2 (Local Queue)             │     │
│  │  ┌──┬──┬──┐          ┌──┬──┬──┐                   │     │
│  │  │G3│G4│G5│          │G6│G7│G8│                   │     │
│  │  └──┴──┴──┘          └──┴──┴──┘                   │     │
│  │       ▼                   ▼                        │     │
│  │  ┌────────┐          ┌────────┐                   │     │
│  │  │  M1    │          │  M2    │                   │     │
│  │  │running │          │running │                   │     │
│  │  │  G1    │          │  G2    │                   │     │
│  │  └────────┘          └────────┘                   │     │
│  └────────────────────────────────────────────────────┘     │
│                                                              │
│  Global Queue: [G9][G10][G11] ← khi local queue đầy        │
│                                                              │
│  Work Stealing: P2 rảnh → steal từ P1's local queue ✅     │
└──────────────────────────────────────────────────────────────┘

GOMAXPROCS = số P = số CPU cores (default)
```

### Goroutine Life Cycle
```
             go func()
                │
                ▼
          ┌──────────┐
          │ Runnable │◄──────────────────────┐
          └──────────┘                       │
                │ P picks up                 │
                ▼                            │
          ┌──────────┐   I/O or syscall      │
          │ Running  │──────────────────► ┌──┴─────┐
          └──────────┘                    │Waiting │
                │ preempted               └────────┘
                │ (every 10ms)                │
                ▼                            │ I/O done
          ┌──────────┐                       │
          │ Runnable │◄──────────────────────┘
          └──────────┘
                │ goroutine done
                ▼
          ┌──────────┐
          │   Dead   │
          └──────────┘
```

---

## 2. Channel — Giao tiếp giữa Goroutines

### Anatomy của Channel
```
┌──────────────────────────────────────────────────────────────┐
│                   BUFFERED CHANNEL (cap=3)                   │
│                                                              │
│  Producer ──► [  10  |  20  |  30  ] ──► Consumer           │
│                ← ─ ─ ─ ─ ─ ─ ─ ─ ─►                        │
│                  circular buffer                             │
│                                                              │
│  send: ch <- val   (blocks if full)                          │
│  recv: val := <-ch (blocks if empty)                         │
│  close: close(ch)  (signals no more values)                  │
└──────────────────────────────────────────────────────────────┘

UNBUFFERED CHANNEL (cap=0):
  Sender blocks until Receiver is ready — SYNCHRONIZATION point
  ┌──────────┐  handshake  ┌──────────┐
  │ Sender   │◄───────────►│ Receiver │
  └──────────┘             └──────────┘
```

```go
// Unbuffered — synchronous
ch := make(chan int)

// Buffered — async up to capacity
ch2 := make(chan int, 100)

// Direction-typed channels
func producer(ch chan<- int) { ch <- 42 }  // send-only
func consumer(ch <-chan int) { v := <-ch } // receive-only

// Range over channel (until closed)
for val := range ch {
    fmt.Println(val)
}

// Check if channel closed
val, ok := <-ch
if !ok {
    fmt.Println("channel closed")
}
```

---

## 3. Select — Multiplex giữa nhiều Channels

```go
// select giống switch nhưng cho channels
select {
case msg := <-ch1:
    fmt.Println("from ch1:", msg)
case msg := <-ch2:
    fmt.Println("from ch2:", msg)
case ch3 <- "hello":
    fmt.Println("sent to ch3")
case <-time.After(5 * time.Second):
    fmt.Println("timeout!")
default:
    fmt.Println("non-blocking: nothing ready")
}
```

```
SELECT Flow Diagram:
                ┌─────────────────────┐
                │       select        │
                │   ┌──┬──┬──┬──┐    │
                │   │c1│c2│c3│c4│    │
                │   └──┴──┴──┴──┘    │
                └──────────┬──────────┘
                           │
              ┌────────────┴────────────┐
              │  Which channel ready?   │
              └────────────────────────┘
         ┌────────┴────┬─────┴────┐
     c1 ready      c3 ready    none ready
         │             │             │
     execute c1    execute c3    execute default
     case           case          (or block if no default)
```

---

## 4. Common Concurrency Patterns

### 4.1 Fan-Out / Fan-In
```
Fan-Out: 1 producer → N workers
Fan-In: N producers → 1 consumer

┌──────────────────────────────────────────────────────┐
│                    FAN-OUT / FAN-IN                  │
│                                                      │
│    jobs                   results                    │
│  ┌──────┐  ┌──────────┐  ┌──────┐                   │
│  │      │─►│ Worker 1 │─►│      │                   │
│  │ Job  │  ├──────────┤  │Result│                   │
│  │Channel├►│ Worker 2 │─►│Channel│                   │
│  │      │  ├──────────┤  │      │                   │
│  └──────┘─►│ Worker 3 │─►└──────┘                   │
│            └──────────┘                              │
└──────────────────────────────────────────────────────┘
```

```go
func fanOut(jobs <-chan int, numWorkers int) <-chan int {
    results := make(chan int, numWorkers)
    var wg sync.WaitGroup
    
    for i := 0; i < numWorkers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for job := range jobs {
                results <- process(job)
            }
        }()
    }
    
    // Close results khi tất cả workers xong
    go func() {
        wg.Wait()
        close(results)
    }()
    
    return results
}
```

### 4.2 Worker Pool (Giống ThreadPoolExecutor của Java)
```go
type Pool struct {
    jobs    chan func()
    workers int
}

func NewPool(workers, bufferSize int) *Pool {
    p := &Pool{
        jobs:    make(chan func(), bufferSize),
        workers: workers,
    }
    for i := 0; i < workers; i++ {
        go func() {
            for job := range p.jobs {
                job()
            }
        }()
    }
    return p
}

func (p *Pool) Submit(job func()) {
    p.jobs <- job
}
```

### 4.3 Context Cancellation (Preview Bài 7)
```go
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()

go func() {
    select {
    case <-ctx.Done():
        fmt.Println("cancelled:", ctx.Err())
    case result := <-doWork():
        fmt.Println("result:", result)
    }
}()
```

### 4.4 Mutex — Khi Channel không phù hợp
```go
// Channel: tốt cho "passing data between goroutines"
// Mutex: tốt cho "protecting shared state"

type SafeCounter struct {
    mu    sync.RWMutex
    count map[string]int
}

func (c *SafeCounter) Inc(key string) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.count[key]++
}

func (c *SafeCounter) Get(key string) int {
    c.mu.RLock()          // Read lock — nhiều readers OK
    defer c.mu.RUnlock()
    return c.count[key]
}
```

---

## 5. Pitfalls — Những lỗi phổ biến

### 5.1 Goroutine Leak
```go
// ❌ Goroutine leak — goroutine block mãi mãi
func leak() {
    ch := make(chan int)
    go func() {
        val := <-ch // block vĩnh viễn nếu không ai send
        fmt.Println(val)
    }()
    // function return, goroutine vẫn chạy ngầm!
}

// ✅ Dùng context để cancel
func noLeak(ctx context.Context) {
    ch := make(chan int)
    go func() {
        select {
        case val := <-ch:
            fmt.Println(val)
        case <-ctx.Done():
            return // goroutine thoát clean
        }
    }()
}
```

### 5.2 Closure capture trong loop
```go
// ❌ Classic bug — tất cả goroutine dùng cùng i
for i := 0; i < 5; i++ {
    go func() {
        fmt.Println(i) // thường in ra 5,5,5,5,5
    }()
}

// ✅ Pass i như argument
for i := 0; i < 5; i++ {
    go func(i int) {
        fmt.Println(i) // in ra 0,1,2,3,4 (không theo thứ tự)
    }(i)
}
```

### 5.3 Deadlock
```go
// ❌ Deadlock — goroutine đợi nhau
ch := make(chan int)
ch <- 1  // block! không ai nhận
v := <-ch

// ✅ Goroutine để send/receive
go func() { ch <- 1 }()
v := <-ch
```

---

## 6. Race Detector — Công cụ không thể thiếu

```bash
go test -race ./...
go run -race main.go

# Nếu có data race, output:
# WARNING: DATA RACE
# Write at 0x... by goroutine N:
# ...
# Read at 0x... by goroutine M:
# ...
```

---

## 7. So sánh: Go Channels vs Java vs Rust

```
┌──────────────────────────────────────────────────────────────┐
│  USE CASE: Process 1000 items concurrently                   │
├──────────────────────────────────────────────────────────────┤
│  Java (ExecutorService)                                      │
│    ExecutorService pool = Executors.newFixedThreadPool(10);  │
│    List<Future<Result>> futures = items.stream()             │
│        .map(item -> pool.submit(() -> process(item)))        │
│        .collect(toList());                                   │
│    // collect results...                                     │
│    pool.shutdown();                                          │
├──────────────────────────────────────────────────────────────┤
│  Rust (Rayon parallel iterator)                              │
│    let results: Vec<_> = items.par_iter()                   │
│        .map(|item| process(item))                            │
│        .collect();                                           │
├──────────────────────────────────────────────────────────────┤
│  Go (Goroutines + WaitGroup)                                 │
│    var wg sync.WaitGroup                                     │
│    results := make(chan Result, len(items))                  │
│    for _, item := range items {                              │
│        wg.Add(1)                                             │
│        go func(item Item) {                                  │
│            defer wg.Done()                                   │
│            results <- process(item)                          │
│        }(item)                                               │
│    }                                                         │
│    go func() { wg.Wait(); close(results) }()                │
└──────────────────────────────────────────────────────────────┘
```

---

## 8. Tổng kết Bài 3

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ GMP: G=goroutine, M=OS thread, P=processor      │
│  ✅ GOMAXPROCS = số P = số CPU cores (default)      │
│  ✅ Unbuffered channel = synchronization point      │
│  ✅ select = multiplex multiple channels            │
│  ✅ sync.WaitGroup cho "wait for all goroutines"    │
│  ✅ sync.RWMutex cho "protect shared state"         │
│  ✅ -race flag để detect data races                 │
│  ✅ Luôn nghĩ đến goroutine leak khi dùng channel  │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-4-Error-Defer-Panic|Bài 4: Error Handling, defer, panic & recover]]

---

**Bài tập:**
1. Implement pipeline: `generate → square → print` dùng 3 goroutines + 2 channels
2. Implement rate-limiter dùng ticker channel
3. Chạy `go test -race` trên code có shared map không dùng mutex — quan sát output

---
*Tags: #go #goroutines #channels #concurrency #gmp #zero-to-hero*
