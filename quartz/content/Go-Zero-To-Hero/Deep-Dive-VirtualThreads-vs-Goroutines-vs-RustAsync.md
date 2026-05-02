# Java Virtual Threads vs Go Goroutines vs Rust Async — Deep Dive 2026

> **Bài viết phân tích:** Kể từ Java 21 (LTS), Virtual Threads (Project Loom) chính thức GA. Liệu rằng Java đã "bắt kịp" Go và Rust trong concurrency? Câu trả lời phức tạp hơn nhiều người nghĩ.

---

## 1. Bối cảnh — Tại sao so sánh này quan trọng?

```
┌──────────────────────────────────────────────────────────────┐
│          CONCURRENCY MODELS EVOLUTION TIMELINE               │
│                                                              │
│  1990s: OS Threads (C/C++)                                  │
│         → 1 request = 1 thread = expensive                  │
│                                                              │
│  2000s: Thread pools (Java EE)                              │
│         → Reuse threads, nhưng vẫn blocking I/O            │
│                                                              │
│  2009:  Go Goroutines (Google)                              │
│         → M:N scheduler, 8KB stack, 1M goroutines/server   │
│                                                              │
│  2014:  Rust async traits (niche)                           │
│  2019:  Tokio stable — Zero-cost async                      │
│                                                              │
│  2018:  Java reactive (Spring WebFlux/Project Reactor)      │
│         → Callback hell, complex code                        │
│                                                              │
│  2023:  Java 21 — Virtual Threads GA (Project Loom)         │
│         → Write blocking code, runs non-blocking            │
│         → "Like goroutines?" — Not exactly...               │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Cơ chế hoạt động — Bên dưới lớp trừu tượng

### 2.1 Go Goroutine — GMP Scheduler

```
┌──────────────────────────────────────────────────────────────┐
│                    GMP MODEL                                 │
│                                                              │
│  G = Goroutine  (unit of work, 2-8KB stack, growable)       │
│  M = Machine    (OS Thread — thường = CPU cores)            │
│  P = Processor  (logical processor, owns local run queue)   │
│                                                              │
│  ┌─────────┐   ┌─────────┐   ┌─────────┐                    │
│  │    P1   │   │    P2   │   │    P3   │                    │
│  │ [G][G][G]   │ [G][G]  │   │ [G][G][G][G]                │
│  └────┬────┘   └────┬────┘   └────┬────┘                    │
│       │             │             │                          │
│      M1            M2            M3  (OS Threads)            │
│                                                              │
│  Work stealing: P1 idle → steal from P3's queue            │
│                                                              │
│  I/O blocking:                                               │
│  G blocks on I/O → Go runtime: detach M from P              │
│  → P continues running other Gs on new M                   │
│  → I/O done → G re-queued on P's run queue                 │
│                                                              │
│  Stack growth: 2KB → 8KB → ... → 1GB (gradual, automatic)  │
│  Tất cả transparent — developer KHÔNG cần biết điều này    │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Java Virtual Thread — Continuation-based

```
┌──────────────────────────────────────────────────────────────┐
│              JAVA VIRTUAL THREAD INTERNALS                   │
│                                                              │
│  Virtual Thread = Continuation + Scheduler                   │
│                                                              │
│  ForkJoinPool (carrier threads = CPU cores)                 │
│  ├── Carrier Thread 1                                        │
│  │   Currently running: Virtual Thread A                     │
│  │   Parked: Virtual Thread B, C (mounted/unmounted)        │
│  └── Carrier Thread 2                                        │
│      Currently running: Virtual Thread D                    │
│                                                              │
│  VT blocks on I/O:                                           │
│  1. VT A calls socket.read() [blocking]                     │
│  2. JVM intercepts → saves continuation state               │
│  3. Unmounts VT A from carrier thread                       │
│  4. Carrier runs VT B instead                               │
│  5. I/O ready → remount VT A → continues                    │
│                                                              │
│  Stack: Continuation stored on HEAP (không phải OS stack)   │
│  → VT stack có thể grow tương tự goroutine                 │
│  → NHƯNG: heap allocation → GC pressure                     │
└──────────────────────────────────────────────────────────────┘
```

### 2.3 Rust Async — State Machine, Zero-cost

```
┌──────────────────────────────────────────────────────────────┐
│                  RUST ASYNC INTERNALS                        │
│                                                              │
│  async fn → compile-time state machine (NOT heap alloc)     │
│                                                              │
│  async fn fetch(url: &str) -> Result<String> {              │
│      let resp = client.get(url).send().await;  // Point A   │
│      let text = resp.text().await;             // Point B   │
│      Ok(text)                                               │
│  }                                                           │
│                                                              │
│  Compiled to:                                               │
│  enum FetchStateMachine {                                    │
│      Start { url: &str },                                   │
│      WaitingForResponse { future: HttpFuture },  // At A   │
│      WaitingForBody { future: TextFuture },      // At B   │
│      Done,                                                  │
│  }                                                           │
│                                                              │
│  → ZERO heap allocation cho state machine itself            │
│  → Nhỏ hơn goroutine (stack-less)                          │
│  → NHƯNG: phải explicit async/await everywhere             │
│  → Viral: 1 async fn → mọi caller cũng phải async          │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Benchmark So Sánh Thực Tế

```
┌──────────────────────────────────────────────────────────────┐
│         MEMORY: 1 MILLION CONCURRENT "TASKS"                 │
├──────────────────────────┬───────────────────────────────────┤
│  Runtime                 │  Memory Usage                    │
├──────────────────────────┼───────────────────────────────────┤
│  Java OS Thread          │  ~1–2 TB (không thể!)            │
│  Java Virtual Thread     │  ~1–4 GB (heap, depends on stack)│
│  Go Goroutine            │  ~2–8 GB (2–8KB mỗi goroutine)  │
│  Rust Tokio Task         │  ~0.5–2 GB (smallest footprint)  │
└──────────────────────────┴───────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│         THROUGHPUT: Simple HTTP "Hello World"                │
│         (TechEmpower Framework Benchmark Round 22)           │
├──────────────────────────┬───────────────────────────────────┤
│  Framework               │  req/s (higher = better)         │
├──────────────────────────┼───────────────────────────────────┤
│  Rust (actix-web)        │  ~7,000,000                      │
│  Go (net/http/fasthttp)  │  ~2,000,000                      │
│  Java (Vertx VT)         │  ~1,800,000                      │
│  Java (Spring Boot 3 VT) │  ~800,000 – 1,200,000           │
│  Java (Spring WebFlux)   │  ~900,000 – 1,400,000           │
│  Java (Spring Boot MVC)  │  ~150,000 – 300,000             │
└──────────────────────────┴───────────────────────────────────┘
```

> **Nhận xét:** Virtual Thread + Spring Boot 3 gần bằng Go cho throughput. Nhưng Rust vẫn xa hơn cả.

---

## 4. Phân tích Chi Tiết — Điểm Mạnh/Yếu

### 4.1 Java Virtual Threads

```
┌──────────────────────────────────────────────────────────────┐
│              JAVA VIRTUAL THREADS                            │
│                                                              │
│  ✅ ĐIỂM MẠNH:                                               │
│  ─────────────                                               │
│  1. ZERO code change (blocking code = non-blocking behavior) │
│     ExecutorService ex = Executors.newVirtualThreadPerTask..│
│     // Tất cả JDBC, existing libs works UNCHANGED!          │
│                                                              │
│  2. Ecosystem: Spring Boot 3.2+, Quarkus, Micronaut hỗ trợ  │
│     spring.threads.virtual.enabled=true ← 1 dòng config!   │
│                                                              │
│  3. Familiar: Java developer không cần học concept mới      │
│     Viết code như Thread nhưng scale như async               │
│                                                              │
│  4. Debuggability: Stack trace đầy đủ (vs reactive gibberish)│
│     Exception in thread "virtual-x" at Service.java:45     │
│     → Dễ đọc hơn reactive stack traces RẤT NHIỀU           │
│                                                              │
│  ⚠ ĐIỂM YẾU:                                                │
│  ──────────────                                              │
│  1. Pinning problem (CRITICAL):                              │
│     synchronized block → pins VT to carrier thread          │
│     → Carrier bị block → deadlock potential!                │
│                                                              │
│     synchronized (lock) {                                   │
│         db.query(...) // ← PINS carrier! BAD!               │
│     }                                                        │
│     → Phải migrate từ synchronized → ReentrantLock          │
│                                                              │
│  2. JVM overhead: heap continuation + GC pressure           │
│     Mỗi VT stack trên heap → GC phải collect                │
│     Go: goroutine stack trên Go heap được managed tốt hơn   │
│                                                              │
│  3. CPU-bound tasks: Virtual Thread KHÔNG giúp ích!         │
│     VT giải quyết I/O-bound, không phải CPU-bound           │
│     (giống goroutine — đây là hiểu lầm phổ biến)           │
│                                                              │
│  4. Third-party libs: JDBC drivers cũ, native libs có thể  │
│     không tương thích (blocking native calls pin carrier)   │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Go Goroutines

```
┌──────────────────────────────────────────────────────────────┐
│              GO GOROUTINES                                   │
│                                                              │
│  ✅ ĐIỂM MẠNH:                                               │
│  ─────────────                                               │
│  1. Simplest model — go func() { ... }()                    │
│     Không có async/await, không có virtual keyword           │
│                                                              │
│  2. Mature scheduler: 15+ năm battle-tested                 │
│     Work stealing, preemptive (Go 1.14+), netpoller          │
│                                                              │
│  3. No pinning problem: Go scheduler handle I/O natively    │
│     Khi goroutine block I/O → scheduler detach transparent  │
│                                                              │
│  4. Channel: safe communication primitive built-in          │
│     Java cần concurrent collections phức tạp hơn            │
│                                                              │
│  5. Binary size: Go binary nhỏ hơn JVM runtime              │
│                                                              │
│  ⚠ ĐIỂM YẾU:                                                │
│  ──────────────                                              │
│  1. Goroutine leak dễ xảy ra:                               │
│     go func() { <-ch }() → nếu ch không bao giờ send       │
│     → goroutine stuck mãi → memory leak                     │
│                                                              │
│  2. GC pause: dù < 1ms, vẫn có GC interference             │
│     Rust: không có GC — predictable latency hoàn toàn       │
│                                                              │
│  3. Không có generics-friendly channel (trước Go 1.18)      │
│     Đã cải thiện với generics nhưng ecosystem còn mới        │
│                                                              │
│  4. Memory: 2-8KB per goroutine × 1M = 2-8GB               │
│     Rust task: nhỏ hơn đáng kể (stack-less futures)         │
└──────────────────────────────────────────────────────────────┘
```

### 4.3 Rust Async/Tokio

```
┌──────────────────────────────────────────────────────────────┐
│              RUST ASYNC / TOKIO                              │
│                                                              │
│  ✅ ĐIỂM MẠNH:                                               │
│  ─────────────                                               │
│  1. Zero-cost abstraction: compile-time state machine        │
│     Runtime overhead gần bằng 0 — tốt nhất hiện nay        │
│                                                              │
│  2. No GC: predictable latency, không có stop-the-world     │
│     Ideal cho real-time systems, game servers, HFT           │
│                                                              │
│  3. Memory safety at compile time: không có data race       │
│     Send + Sync bounds prevent races without runtime check  │
│                                                              │
│  4. Smallest memory footprint per task                       │
│                                                              │
│  ⚠ ĐIỂM YẾU:                                                │
│  ──────────────                                              │
│  1. Async virality: 1 async fn → mọi caller phải async      │
│     Sync vs Async boundary = friction                        │
│                                                              │
│  2. Complexity: Pin, Waker, Future trait, async traits       │
│     Learning curve cao nhất trong 3 languages               │
│                                                              │
│  3. async in traits: stable Go 1.22, vẫn còn quirks         │
│     (trait objects + async = dyn Future = complex)          │
│                                                              │
│  4. Compile time: dài hơn Go đáng kể                        │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. Vấn đề Pinning — "Gót Achilles" của Virtual Threads

```java
// ⚠ PINNING — Virtual Thread bị "dán" vào carrier thread
public class PinningExample {
    private final Object lock = new Object();
    
    public void problematic() {
        synchronized (lock) {
            // Bên trong synchronized block:
            // VT KHÔNG thể được unmount khỏi carrier!
            String result = database.query("SELECT ..."); // blocking I/O
            // → Carrier thread BỊ BLOCK → lãng phí
            // → Nếu tất cả carriers bị pin → starvation!
        }
    }
    
    // ✅ Fix: Dùng ReentrantLock thay synchronized
    private final ReentrantLock reentrantLock = new ReentrantLock();
    
    public void correct() {
        reentrantLock.lock();
        try {
            String result = database.query("SELECT ..."); // VT có thể unmount
        } finally {
            reentrantLock.unlock();
        }
    }
}
```

```
┌──────────────────────────────────────────────────────────────┐
│              PINNING TRONG PRODUCTION                        │
│                                                              │
│  Các thư viện Java phổ biến gây pinning (cần cập nhật):     │
│                                                              │
│  JDBC (không async-aware):                                   │
│  ├── PostgreSQL JDBC 42.7+: ✅ không pin (natively)         │
│  ├── MySQL Connector/J 8.2+: ✅ fixed                       │
│  └── Cũ hơn: ⚠ có thể pin carrier                          │
│                                                              │
│  synchronized blocks trong:                                  │
│  ├── java.util.Hashtable: ⚠ pin                            │
│  ├── Collections.synchronizedXxx(): ⚠ pin                  │
│  └── Nhiều legacy Apache Commons libs: ⚠ pin               │
│                                                              │
│  JVM flag để detect:                                         │
│  -Djdk.tracePinnedThreads=full                              │
│  → Log khi VT bị pinned — dùng trong testing               │
└──────────────────────────────────────────────────────────────┘
```

> **Go không có vấn đề này:** Go scheduler tự xử lý I/O blocking trong runtime, không có "synchronized equivalent" gây pinning.

---

## 6. Benchmark Thực Nghiệm — PDMS-like Workload

```
Scenario: 10,000 concurrent requests, mỗi request:
- 1 DB query (PostgreSQL, 5ms latency)
- 1 Redis read (0.5ms latency)
- 1 JSON response

Test machine: 16-core CPU, 32GB RAM
```

```
┌──────────────────────────────────────────────────────────────┐
│              BENCHMARK RESULTS (approximation)               │
├──────────────────────────┬────────┬──────────┬──────────────┤
│  Runtime/Framework       │req/s   │ p99 lat  │ Memory       │
├──────────────────────────┼────────┼──────────┼──────────────┤
│  Rust (actix + sqlx)     │ 85,000 │  8ms     │ 180 MB       │
│  Go (Fiber)              │ 72,000 │ 12ms     │ 320 MB       │
│  Go (Gin)                │ 65,000 │ 14ms     │ 380 MB       │
│  Java 21 VT (Vertx)      │ 60,000 │ 15ms     │ 620 MB       │
│  Java 21 VT (Spring Boot)│ 45,000 │ 20ms     │ 750 MB       │
│  Java (Spring WebFlux)   │ 48,000 │ 18ms     │ 680 MB       │
│  Java (Spring MVC+pool)  │ 18,000 │ 55ms     │ 1.2 GB       │
├──────────────────────────┴────────┴──────────┴──────────────┤
│  NOTE: Numbers are illustrative order-of-magnitude estimates │
│  Real results vary significantly with config + workload      │
└──────────────────────────────────────────────────────────────┘
```

---

## 7. Khi nào Virtual Threads "Wins"?

```
┌──────────────────────────────────────────────────────────────┐
│           VIRTUAL THREADS SHINES HERE                        │
│                                                              │
│  ✅ Legacy Java codebase migration:                          │
│     Spring Boot 3.2 + spring.threads.virtual.enabled=true   │
│     → 3-5x throughput improvement với ZERO code change!     │
│     Đây là use case KILLER của Virtual Threads              │
│                                                              │
│  ✅ JDBC-heavy applications:                                 │
│     Traditional database apps với nhiều blocking queries     │
│     → VT perfect fit — JPA/Hibernate hoạt động ngay       │
│                                                              │
│  ✅ Team Java-only, không muốn đổi ngôn ngữ:               │
│     VT cho phép scale mà không học Go/Rust                  │
│                                                              │
│  ✅ Greenfield Java microservices (2024+):                   │
│     Quarkus 3 / Micronaut 4 + VT = modern Java stack       │
└──────────────────────────────────────────────────────────────┘
```

---

## 8. Khi nào VT KHÔNG phải lựa chọn tốt?

```
┌──────────────────────────────────────────────────────────────┐
│           VIRTUAL THREADS STRUGGLES HERE                     │
│                                                              │
│  ❌ CPU-intensive workloads:                                 │
│     ML inference, image processing, crypto                  │
│     → VT = no benefit (dùng ForkJoinPool thay thế)         │
│     → Rust/Go native parallelism tốt hơn                   │
│                                                              │
│  ❌ Extreme performance requirements:                        │
│     JVM warmup time (JIT), GC pauses, heap overhead         │
│     → Rust no-GC, Go GC < 1ms vẫn tốt hơn                 │
│                                                              │
│  ❌ Embedded / small memory footprint:                       │
│     JVM minimum ~50-100MB overhead                          │
│     Go binary: 5-15MB, Rust: 1-5MB                         │
│                                                              │
│  ❌ Containerized với strict memory limits:                  │
│     100MB container → JVM không boot được!                  │
│     Go binary: runs comfortably in 20MB container          │
│                                                              │
│  ❌ WebAssembly / Edge computing:                            │
│     JVM không compile to WASM                               │
│     Go: tinygo for WASM. Rust: first-class WASM support     │
└──────────────────────────────────────────────────────────────┘
```

---

## 9. Verdict — Bảng So Sánh Tổng Hợp

```
┌──────────────────────────────────────────────────────────────┐
│              FINAL COMPARISON MATRIX (2026)                  │
├─────────────────────────┬────────┬──────────┬───────────────┤
│  Criterion              │  Go    │  Java VT │  Rust async   │
├─────────────────────────┼────────┼──────────┼───────────────┤
│  Throughput             │ ★★★★   │  ★★★☆   │  ★★★★★       │
│  Latency (p99)          │ ★★★★   │  ★★★     │  ★★★★★       │
│  Memory efficiency      │ ★★★★   │  ★★★     │  ★★★★★       │
│  Code simplicity        │ ★★★★★  │  ★★★★    │  ★★           │
│  Learning curve         │ ★★★★   │  ★★★★★   │  ★★           │
│  Ecosystem/libs         │ ★★★    │  ★★★★★   │  ★★★          │
│  Legacy migration       │ ★★     │  ★★★★★   │  ★            │
│  Pinning risks          │ None   │  ⚠ Real  │  None         │
│  Container efficiency   │ ★★★★★  │  ★★★     │  ★★★★★       │
│  Startup time           │ ★★★★★  │  ★★★     │  ★★★★★       │
│  Tooling maturity       │ ★★★★   │  ★★★★★   │  ★★★★        │
│  Production @ scale     │ ★★★★★  │  ★★★★★   │  ★★★★        │
└─────────────────────────┴────────┴──────────┴───────────────┘
```

---

## 10. Khuyến nghị theo Use Case

```
Tôi có dự án Java cũ cần scale nhanh?
→ VIRTUAL THREADS ✅ — spring.threads.virtual.enabled=true
   3-5x improvement, zero code change. BEST ROI.

Tôi xây microservice mới, team Java?
→ VIRTUAL THREADS + Spring Boot 3 / Quarkus 3 ✅
   Hoặc học Go nếu muốn ecosystem hiệu năng/container tốt hơn.

Tôi xây microservice mới, team đa ngôn ngữ?
→ GO ✅ — simplicity, great tooling, excellent container story.

Tôi cần absolute maximum performance?
→ RUST ✅ — không GC, zero-cost, nhưng cần đội senior Rust.

Tôi xây PDMS-like banking system?
→ GIN/GO hoặc SPRING BOOT 3 + VT, tùy team preference.
   Performance đủ dùng, ecosystem phong phú, compliance easier.

Tôi xây trading engine / game server / embedded?
→ RUST — không compromise.
```

---

## 11. Câu hỏi "Java VT có better hơn Go không?" — Trả lời thẳng

```
┌──────────────────────────────────────────────────────────────┐
│                   HONEST VERDICT                             │
│                                                              │
│  Virtual Threads KHÔNG "better" hơn Go Goroutines           │
│  — chúng giải quyết vấn đề KHÁC NHAU với tradeoff khác      │
│                                                              │
│  VT "better" trong:                                         │
│  → Migrate legacy Java code (zero-change scaling)           │
│  → Java ecosystem (Spring, Hibernate, Apache libs)          │
│  → Team chỉ biết Java                                       │
│                                                              │
│  Goroutines "better" trong:                                  │
│  → Memory efficiency (no JVM overhead)                      │
│  → Container-native (10-20MB vs 200-500MB)                  │
│  → Startup time (<100ms vs 2-10s)                           │
│  → No pinning risks                                         │
│  → Simpler model (go func() vs executor frameworks)         │
│                                                              │
│  Rust Async "better" trong:                                  │
│  → Absolute latency + throughput                            │
│  → No GC predictable behavior                               │
│  → Smallest memory footprint                               │
│                                                              │
│  BOTTOM LINE:                                               │
│  Java VT đã thu hẹp khoảng cách với Go/Rust đáng kể.       │
│  Nhưng với dự án mới không ràng buộc Java:                  │
│  Go vẫn là lựa chọn tốt hơn về: container efficiency,       │
│  simplicity, deployment story, và không có pinning risk.    │
└──────────────────────────────────────────────────────────────┘
```

---

## 12. Code Comparison — Cùng 1 task

```java
// Java 21 Virtual Threads
// Fetch 1000 URLs concurrently
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<Future<String>> futures = urls.stream()
        .map(url -> executor.submit(() -> fetch(url)))  // blocking, fine!
        .toList();
    
    for (var f : futures) {
        System.out.println(f.get()); // blocks VT, not carrier
    }
}
// fetch() là blocking java.net.http.HttpClient call
// Virtual Threads handle blocking transparently → simple code!
```

```go
// Go Goroutines
// Fetch 1000 URLs concurrently
results := make(chan string, len(urls))
var wg sync.WaitGroup

for _, url := range urls {
    wg.Add(1)
    go func(u string) {
        defer wg.Done()
        resp, err := http.Get(u)  // blocking, goroutine suspended → scheduler runs other G
        if err == nil {
            body, _ := io.ReadAll(resp.Body)
            results <- string(body)
        }
    }(url)
}

go func() { wg.Wait(); close(results) }()
for r := range results { fmt.Println(r) }
```

```rust
// Rust Tokio
// Fetch 1000 URLs concurrently
let handles: Vec<_> = urls.iter()
    .map(|url| {
        let url = url.clone();
        tokio::spawn(async move {  // MUST be async
            let resp = client.get(&url).send().await?;  // MUST await
            resp.text().await  // MUST await
        })
    })
    .collect();

for handle in handles {
    println!("{}", handle.await??);  // MUST await
}
// async virality: fetch function phải async, caller phải async, etc.
```

---
*Tags: #java #virtual-threads #goroutines #rust-async #concurrency #deep-dive #loom #tokio*
*Related: [[Bai-1-Go-Mindset]] | [[concepts/]] | [[JVM-Frameworks-2026/]]*
