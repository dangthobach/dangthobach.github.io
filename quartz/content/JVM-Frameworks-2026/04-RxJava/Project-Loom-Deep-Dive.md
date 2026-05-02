---
tags: [project-loom, virtual-threads, java21, concurrency, structured-concurrency, scoped-values, jep444, jep453, jep446]
created: 2026-04-13
status: active
week: 21-24
framework: jvm-core
---

# 🪢 Project Loom — Deep Dive Toàn Diện

> **Một câu:** Project Loom đưa **Virtual Threads** vào JVM — threads cực nhẹ do JVM quản lý, cho phép viết code blocking bình thường mà vẫn đạt throughput của reactive programming.

---

## 🗺️ Roadmap học Loom

```
JEP 444 (Java 21)        JEP 453 (Java 21)        JEP 446 (Java 21)
Virtual Threads    →    Structured Concurrency  →   Scoped Values
    [Nền tảng]               [Lifecycle mgmt]         [ThreadLocal replacement]
```

---

## PHẦN 1 · Virtual Threads — Cơ chế hoạt động

### 1.1 · Vấn đề với Platform Threads

```
Mô hình cũ (Thread-per-request):
┌─────────────────────────────────────┐
│  Request 1 → Thread 1 ──── BLOCKED (đợi DB 50ms) ────→ done
│  Request 2 → Thread 2 ──── BLOCKED (đợi HTTP 80ms) ──→ done
│  Request 3 → [WAIT] (không còn thread)
│  ...
│  Thread pool: 200 threads tối đa
│  → Tại 200 concurrent requests: system bị nghẹt
└─────────────────────────────────────┘

Chi phí mỗi Platform Thread:
  - Stack size: ~1MB (fixed, reserved upfront)
  - OS thread: 1-1 mapping
  - Context switch: OS kernel involvement (~microseconds)
  - Creation: slow (OS syscall)
  - Practical limit: vài nghìn threads/JVM
```

### 1.2 · Virtual Thread Architecture — M:N Threading

```
Virtual Threads (VT):
┌──────────────────────────────────────────────────────────┐
│  VT-1 [RUNNABLE]   VT-2 [PARKED]   VT-3 [RUNNABLE]     │
│  VT-4 [PARKED]     VT-5 [RUNNING]  VT-6 [RUNNING]      │
│  VT-7 [PARKED]     VT-8 [RUNNABLE] VT-9 [PARKED]       │
│  ...potentially millions...                              │
└──────────────────────────────────────────────────────────┘
          ↓ scheduled by JVM scheduler ↓
┌─────────────────────────────┐
│  Carrier Thread 1           │   (ForkJoinPool worker)
│  Carrier Thread 2           │   Số lượng = CPU cores (default)
│  Carrier Thread 3           │
│  Carrier Thread N           │
└─────────────────────────────┘
          ↓ mapped to ↓
┌─────────────────────────────┐
│  OS Thread 1 → CPU Core 1   │
│  OS Thread 2 → CPU Core 2   │
│  OS Thread N → CPU Core N   │
└─────────────────────────────┘
```

**Key insight:** Carrier threads KHÔNG BAO GIỜ bị block. Khi VT gặp blocking op → JVM unmount VT khỏi carrier → carrier free để chạy VT khác.

### 1.3 · Mounting / Unmounting — Cơ chế cốt lõi

```java
// Ví dụ: VT thực hiện DB query

// Step 1: VT-1 được mount lên Carrier-A
[VT-1] → [Carrier-A] → [OS-Thread-A] → CPU

// Step 2: VT-1 gọi JDBC (blocking call)
userRepository.findById(id);  // blocking!

// Step 3: JVM phát hiện blocking op → UNMOUNT
//   - Lưu stack của VT-1 lên HEAP (không phải OS stack)
//   - Carrier-A được FREE ngay lập tức
[VT-1: stack in HEAP] [Carrier-A: FREE]

// Step 4: Carrier-A ngay lập tức chạy VT-2
[VT-2] → [Carrier-A] → [OS-Thread-A] → CPU

// Step 5: Khi DB response về → VT-1 được re-mount
[VT-1] → [Carrier-B] → [OS-Thread-B] → CPU
//   (không nhất thiết cùng carrier cũ)
```

**Chi phí mounting/unmounting:**
- Stack lưu trên heap: vài KB, dynamic growing
- Unmount: copy stack ra heap → rất nhanh (~microseconds)
- Mount: restore stack từ heap → rất nhanh
- Không có OS involvement → rẻ hơn context switch hàng chục lần

### 1.4 · Virtual Thread Lifecycle

```
States của Virtual Thread:

   NEW ──── start() ──→ RUNNABLE
                            │
              ┌─────────────┘
              ↓
           RUNNING ← mount ← JVM Scheduler
              │
   ┌──────────┼────────────────┐
   ↓          ↓                ↓
 yield()  blocking I/O    synchronized
   │      (unmount!)       (PINNED!)
   ↓          ↓                ↓
RUNNABLE   PARKED          PINNED
              │         (carrier blocked!)
              ↓
         I/O completes
              ↓
          RUNNABLE ──→ RUNNING (re-mount)
              
   TERMINATED (run() returns hoặc throws)
```

---

## PHẦN 2 · API — Tạo và Quản lý Virtual Threads

### 2.1 · Cách tạo Virtual Thread

```java
// ── Cách 1: Thread.ofVirtual() ──────────────────────────
Thread vt = Thread.ofVirtual()
    .name("order-processor")
    .start(() -> processOrder(orderId));

// Check xem thread có phải virtual không
System.out.println(vt.isVirtual()); // true

// ── Cách 2: Thread.startVirtualThread() ─────────────────
Thread vt = Thread.startVirtualThread(() -> {
    System.out.println("Running in: " + Thread.currentThread());
});
// Output: Running in: VirtualThread[#21]/runnable@ForkJoinPool...

// ── Cách 3: ExecutorService (khuyến nghị cho production) ─
try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
    // Mỗi task → 1 virtual thread riêng
    // executor.close() ở cuối try-with-resources sẽ await completion
    
    List<Future<User>> futures = userIds.stream()
        .map(id -> executor.submit(() -> fetchUser(id)))
        .toList();
    
    List<User> users = futures.stream()
        .map(f -> f.get())  // không block OS thread!
        .toList();
}

// ── Cách 4: ThreadFactory ────────────────────────────────
ThreadFactory vtFactory = Thread.ofVirtual().factory();
ExecutorService executor = Executors.newThreadPerTaskExecutor(vtFactory);
```

### 2.2 · Spring Boot Integration — Chỉ 1 Property

```yaml
# application.yml — Spring Boot 3.2+
spring:
  threads:
    virtual:
      enabled: true
```

```java
// Hoặc explicit configuration
@Configuration
@ConditionalOnProperty("spring.threads.virtual.enabled")
public class VirtualThreadConfig {
    
    @Bean
    public TomcatProtocolHandlerCustomizer<?> virtualThreadTomcat() {
        return handler -> handler.setExecutor(
            Executors.newVirtualThreadPerTaskExecutor()
        );
    }
    
    // Scheduling cũng dùng VT
    @Bean
    public AsyncTaskExecutor applicationTaskExecutor() {
        return new TaskExecutorAdapter(
            Executors.newVirtualThreadPerTaskExecutor()
        );
    }
}
```

```java
// Controller bình thường — không có reactive, không có async annotation
@RestController
public class OrderController {
    
    @GetMapping("/orders/{id}")
    public Order getOrder(@PathVariable Long id) {
        // Blocking call — nhưng KHÔNG block OS thread!
        Order order = orderRepository.findById(id).orElseThrow();
        User user = userService.getUser(order.getUserId());   // HTTP call
        Payment payment = paymentService.getLatest(id);       // HTTP call
        
        return order.enrich(user, payment);
    }
}
// Với 10,000 concurrent requests → 10,000 VTs, vài chục carrier threads
```

### 2.3 · Virtual Thread Properties

```java
Thread vt = Thread.ofVirtual().name("worker-", 0).start(() -> {});

// Identity
vt.isVirtual();           // true
vt.getName();             // "worker-0"
vt.getId();               // long, unique
vt.getState();            // RUNNABLE/PARKED/etc

// Không có priority (ignored)
vt.setPriority(10);       // no-op, VT luôn NORM_PRIORITY
vt.getPriority();         // 5 (NORM_PRIORITY) always

// Không có daemon flag (always daemon)
vt.isDaemon();            // true always
vt.setDaemon(false);      // throws IllegalArgumentException

// ThreadGroup (deprecated concept với VT)
vt.getThreadGroup();      // virtual threads group
```

---

## PHẦN 3 · Pinning Problem — Hiểm Họa Lớn Nhất

### 3.1 · Tại sao `synchronized` gây Pinning

```java
// ❌ PINNING — VT bị PIN xuống carrier thread
public class BadService {
    private final Object lock = new Object();
    
    public synchronized Order processOrder(Long id) {
        // VT bị PIN tại đây → carrier bị BLOCK!
        Order order = db.findOrder(id);    // blocking I/O
        Payment pay = api.charge(order);   // blocking HTTP
        return order.complete(pay);
    }
    
    public Order processOrder2(Long id) {
        synchronized(lock) {
            // ❌ Tương tự — synchronized block cũng pin
            return db.findOrder(id);
        }
    }
}

// Hậu quả:
// Carrier thread pool = 8 (= số CPU cores)
// 8 VTs đang trong synchronized block + blocking I/O
// → TẤT CẢ 8 carrier threads bị block
// → 0 VTs có thể chạy → system DEADLOCK-LIKE
```

### 3.2 · Fix — Dùng ReentrantLock

```java
// ✅ CORRECT — ReentrantLock KHÔNG gây pinning
public class GoodService {
    private final ReentrantLock lock = new ReentrantLock();
    
    public Order processOrder(Long id) {
        lock.lock();
        try {
            // VT có thể UNMOUNT khi gặp blocking I/O!
            Order order = db.findOrder(id);    // VT unmounts, carrier free
            Payment pay = api.charge(order);   // VT unmounts, carrier free
            return order.complete(pay);
        } finally {
            lock.unlock();
        }
    }
}

// So sánh các lock options:
// ReentrantLock     → ✅ VT-friendly, no pinning
// StampedLock       → ✅ VT-friendly, no pinning  
// synchronized      → ❌ PINS VT to carrier
// Object.wait()     → ❌ PINS VT to carrier (trong synchronized)
// Condition.await() → ✅ VT-friendly (dùng với ReentrantLock)
```

### 3.3 · Detect Pinning — JVM Flag

```bash
# Run với flag để log pinning events
java -Djdk.tracePinnedThreads=full -jar app.jar

# Output khi pinning xảy ra:
# Thread[#21,ForkJoinPool-1-worker-1,5,CarrierThreads]
#     com.example.BadService.processOrder(BadService.java:15)
#         <== monitors:1

# Hoặc short format:
java -Djdk.tracePinnedThreads=short -jar app.jar
```

```java
// Programmatic detection (Java 21+)
public void monitorPinning() {
    // Không có official API, nhưng có thể dùng JFR
    // JFR Event: jdk.VirtualThreadPinned
}
```

### 3.4 · Các nguồn Pinning khác

```java
// ❌ Native methods (JNI) — luôn pin
Runtime.getRuntime().exec("cmd");  // native internally

// ❌ ClassLoading (lần đầu) — có synchronized internally
// → Warm up class loading trước khi VT intensive code

// ❌ Some third-party libraries dùng synchronized:
// - Older JDBC drivers (check driver docs)
// - Some older Apache libraries
// ✅ Các JDBC drivers hiện đại đã fix: HikariCP, PgJDBC 42.5+
```

---

## PHẦN 4 · ThreadLocal và Scoped Values

### 4.1 · ThreadLocal — Vẫn hoạt động nhưng có risks

```java
// ThreadLocal vẫn hoạt động với VT
private static final ThreadLocal<RequestContext> CTX = new ThreadLocal<>();

// Risk: Memory leak
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    for (int i = 0; i < 1_000_000; i++) {
        executor.submit(() -> {
            CTX.set(new RequestContext(heavyData));  // 1M instances!
            // ... work ...
            CTX.remove();  // ← PHẢI remove! Không thì memory leak
        });
    }
}
// Nếu quên remove() → 1 triệu RequestContext objects in memory!

// MDC Logging với VT — cần cấu hình:
// SLF4J MDC dùng ThreadLocal → hoạt động OK với VT
// nhưng nhớ clear MDC sau mỗi request
```

### 4.2 · Scoped Values (JEP 446) — ThreadLocal Replacement

```java
// Scoped Values: immutable, inherit-safe, auto-cleanup
public class RequestHandler {
    
    // Declare ScopedValue — immutable, không set/get như ThreadLocal
    static final ScopedValue<RequestContext> CONTEXT = ScopedValue.newInstance();
    static final ScopedValue<User> CURRENT_USER = ScopedValue.newInstance();
    
    public void handleRequest(HttpRequest req) {
        RequestContext ctx = buildContext(req);
        User user = authenticate(req);
        
        // Bind values cho scope — auto-cleanup khi scope kết thúc
        ScopedValue.where(CONTEXT, ctx)
                   .where(CURRENT_USER, user)
                   .run(() -> {
                       // Trong scope này — mọi code có thể đọc values
                       processRequest();
                       // Child VTs cũng inherit values tự động!
                   });
        // ctx và user đã được cleanup, không cần remove() thủ công
    }
    
    private void processRequest() {
        RequestContext ctx = CONTEXT.get();  // không cần pass qua parameter
        User user = CURRENT_USER.get();
        // ...
    }
}
```

**So sánh ThreadLocal vs ScopedValue:**

| | ThreadLocal | ScopedValue |
|--|-------------|-------------|
| Mutability | Mutable (set bất cứ lúc nào) | Immutable (chỉ set 1 lần khi bind) |
| Cleanup | Phải gọi `remove()` thủ công | Auto-cleanup khi scope ends |
| Child threads | Không inherit | Inherit tự động |
| Memory | Risk leak nếu quên remove | Safe, bounded to scope |
| Performance | Fast | Faster (no per-thread map) |
| Use case | Mutable per-thread state | Request context, auth, tracing |

---

## PHẦN 5 · Structured Concurrency (JEP 453)

### 5.1 · Vấn đề với unstructured concurrency

```java
// ❌ Unstructured — khó manage lifecycle
ExecutorService exec = Executors.newVirtualThreadPerTaskExecutor();
Future<User> userF = exec.submit(() -> fetchUser(id));
Future<Order> orderF = exec.submit(() -> fetchOrder(id));

User user = userF.get();    // nếu fetchOrder throw → userF.cancel() không được gọi!
Order order = orderF.get(); // memory/resource leak
// Nếu main thread bị interrupt → cả 2 tasks vẫn chạy không ai cancel
```

### 5.2 · StructuredTaskScope — Structured Solution

```java
// ✅ ShutdownOnFailure — fail-fast: 1 fail → cancel tất cả
public UserDashboard loadDashboard(Long userId) throws Exception {
    try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
        
        Subtask<User>    userTask    = scope.fork(() -> userService.fetch(userId));
        Subtask<List<Order>> ordersTask = scope.fork(() -> orderService.fetch(userId));
        Subtask<List<Notif>> notifTask  = scope.fork(() -> notifService.fetch(userId));
        
        scope.join()           // wait for all forks
             .throwIfFailed(); // throw nếu bất kỳ task nào fail
        
        // Tất cả thành công — lấy results
        return new UserDashboard(
            userTask.get(),
            ordersTask.get(),
            notifTask.get()
        );
    }
    // scope.close() tự cancel các tasks chưa xong + cleanup
}
```

```java
// ✅ ShutdownOnSuccess — race: lấy kết quả nhanh nhất
public String findFastest(Long id) throws Exception {
    try (var scope = new StructuredTaskScope.ShutdownOnSuccess<String>()) {
        
        scope.fork(() -> primaryDB.find(id));    // race các data sources
        scope.fork(() -> replicaDB.find(id));
        scope.fork(() -> cache.find(id));
        
        scope.join(); // wait until 1 success hoặc all fail
        
        return scope.result(); // kết quả từ winner
    }
}
```

### 5.3 · Custom StructuredTaskScope

```java
// Custom scope — collect tất cả results, không fail fast
public class CollectingScope<T> extends StructuredTaskScope<T> {
    private final List<T> results = new CopyOnWriteArrayList<>();
    private final List<Throwable> failures = new CopyOnWriteArrayList<>();
    
    @Override
    protected void handleComplete(Subtask<? extends T> subtask) {
        switch (subtask.state()) {
            case SUCCESS -> results.add(subtask.get());
            case FAILED  -> failures.add(subtask.exception());
            case UNAVAILABLE -> { /* cancelled */ }
        }
    }
    
    public List<T> results() {
        super.ensureOwnerAndJoined();  // check scope đã join
        return Collections.unmodifiableList(results);
    }
}

// Dùng:
try (var scope = new CollectingScope<Order>()) {
    orderIds.forEach(id -> scope.fork(() -> fetchOrder(id)));
    scope.join();
    List<Order> orders = scope.results(); // tất cả orders thành công
}
```

---

## PHẦN 6 · Performance — Số Liệu Thực Tế

### 6.1 · Throughput Benchmark

```
Scenario: HTTP API → DB query (50ms latency) + HTTP call (80ms latency)
Hardware: 8-core server, 16GB RAM

Platform Threads (pool=200):
  - Max concurrent: ~200 requests
  - At 1000 RPS: queue builds up → latency spikes
  - Memory: 200 threads × ~1MB stack = 200MB

Virtual Threads:
  - Max concurrent: hundreds of thousands
  - At 1000 RPS: handled easily
  - Memory: 1000 VTs × ~few KB stack = ~few MB
  - Carrier threads: 8 (= CPU cores)
  - CPU: carrier threads never idle (always processing)
```

### 6.2 · Khi nào VT KHÔNG giúp ích

```java
// ❌ CPU-bound tasks — VT không cải thiện
for (Long id : ids) {
    Thread.startVirtualThread(() -> {
        computeRiskScore(id);  // pure computation, 100ms
        // VT không tăng tốc CPU work!
        // Thực ra hơi chậm hơn do overhead JVM scheduler
    });
}
// FIX: Dùng ForkJoinPool hoặc parallel streams cho CPU-bound

// ❌ Quá nhiều pinning — counterproductive
// ❌ ThreadLocal abuse với millions VTs — memory pressure
```

### 6.3 · Memory Profile

```
Platform Thread:
  - OS Thread: ~1MB stack (fixed)
  - JVM Thread object: ~500 bytes
  - Total: ~1MB per thread

Virtual Thread:
  - VT object (heap): ~200-300 bytes
  - Stack (heap, grows dynamically): starts ~1KB, grows as needed
  - Typical I/O-bound task: 4-8KB stack
  - Heavy computation: up to ~512KB (but rare)

Tính toán:
  1,000,000 VTs (1M) = 1M × 300 bytes (object) + stack
                     ≈ 300MB + stack (nếu 4KB/VT = 4GB) -- nhưng thực tế
  Thực tế: chỉ ~1-10% VTs đang active tại một thời điểm
           99% đang PARKED (stack nhỏ khi parked)
```

---

## PHẦN 7 · Interop — Làm việc với các frameworks

### 7.1 · Spring Boot 3.2+ Full Setup

```java
@Configuration
public class LoomConfig {
    
    // Tomcat dùng VT cho request handling
    @Bean
    public TomcatProtocolHandlerCustomizer<?> protocolHandlerVirtualThreadExecutorCustomizer() {
        return handler -> handler.setExecutor(
            Executors.newVirtualThreadPerTaskExecutor()
        );
    }
    
    // Spring @Async dùng VT
    @Bean(TaskExecutionAutoConfiguration.APPLICATION_TASK_EXECUTOR_BEAN_NAME)
    public AsyncTaskExecutor asyncTaskExecutor() {
        return new TaskExecutorAdapter(Executors.newVirtualThreadPerTaskExecutor());
    }
    
    // Spring @Scheduled dùng VT
    @Bean
    public ScheduledExecutorService scheduledExecutorService() {
        return Executors.newScheduledThreadPool(1, Thread.ofVirtual().factory());
    }
}
```

```java
// Service code — hoàn toàn bình thường, không cần reactive
@Service
public class OrderService {
    
    @Async  // chạy trên VT
    public CompletableFuture<Order> processAsync(Long id) {
        Order order = orderRepo.findById(id).orElseThrow();  // JDBC blocking
        return CompletableFuture.completedFuture(order);
    }
    
    // Parallel calls với StructuredTaskScope
    public OrderSummary getOrderSummary(Long id) throws Exception {
        try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
            var order   = scope.fork(() -> orderRepo.findById(id).orElseThrow());
            var items   = scope.fork(() -> itemRepo.findByOrderId(id));
            var payment = scope.fork(() -> paymentClient.getStatus(id));  // HTTP
            
            scope.join().throwIfFailed();
            
            return new OrderSummary(order.get(), items.get(), payment.get());
        }
    }
}
```

### 7.2 · JDBC Connection Pool Sizing

```yaml
# ❌ SAI — pool quá nhỏ với VT
spring:
  datasource:
    hikari:
      maximum-pool-size: 10  # Với VT, bottleneck sẽ ở đây!

# ✅ Đúng — tăng pool size tương xứng với throughput mong muốn
spring:
  datasource:
    hikari:
      maximum-pool-size: 100  # hoặc hơn, tùy DB capacity
      # VT sẽ queue khi hết connections, nhưng không block OS thread
```

```java
// Lý do: Với VT, bạn có thể có hàng nghìn concurrent requests
// mỗi request cần 1 DB connection → connection pool phải đủ lớn
// Ngược lại với reactive (R2DBC dùng ít connections hơn nhiều)
```

### 7.3 · Kotlin Coroutines + Loom Interop

```kotlin
// Kotlin Coroutines chạy trên VT dispatcher
val vtDispatcher = Executors.newVirtualThreadPerTaskExecutor()
    .asCoroutineDispatcher()

// Coroutine scope dùng VT
val scope = CoroutineScope(vtDispatcher)

scope.launch {
    val user = userService.fetchUser(id)   // suspend function
    // Internally có thể chạy trên VT
}

// Spring Boot + Kotlin + Loom: không cần thay đổi gì nhiều
// spring.threads.virtual.enabled=true là đủ
```

---

## PHẦN 8 · Debugging và Observability

### 8.1 · JVM Flags hữu ích

```bash
# Log pinning events (quan trọng nhất)
-Djdk.tracePinnedThreads=full   # full stack trace khi pin
-Djdk.tracePinnedThreads=short  # chỉ method name

# Virtual thread scheduler
-Djdk.virtualThreadScheduler.parallelism=16  # số carrier threads (default = cores)
-Djdk.virtualThreadScheduler.maxPoolSize=256 # max carriers khi saturated

# Debug VT names
Thread.ofVirtual().name("order-handler-", 0).start(() -> {});
# → thread name: "order-handler-0", "order-handler-1", ...
```

### 8.2 · JFR (Java Flight Recorder) Events

```java
// VT-specific JFR events (Java 21+):
// jdk.VirtualThreadStart      — VT started
// jdk.VirtualThreadEnd        — VT terminated  
// jdk.VirtualThreadPinned     — Pinning detected!
// jdk.VirtualThreadSubmitFailed — Task submission failed

// JFR recording:
jcmd <pid> JFR.start duration=60s filename=loom-profile.jfr
jcmd <pid> JFR.stop

// Sau đó mở với JDK Mission Control để xem VT lifecycle
```

### 8.3 · Thread Dump với Virtual Threads

```bash
# jstack với VT — Java 21+
jstack -l <pid>

# Output sẽ show:
# "order-handler-42" virtual
#    java.lang.VirtualThread (PARKED)
#    ...
#    Locked ownable synchronizers: none

# Hoặc dùng jcmd
jcmd <pid> Thread.print -l
```

---

## PHẦN 9 · Anti-patterns và Gotchas

### 9.1 · Không dùng ThreadLocal với VT (thận trọng)

```java
// ❌ Memory leak potential
static final ThreadLocal<HeavyObject> HEAVY = new ThreadLocal<>();

try (var exec = Executors.newVirtualThreadPerTaskExecutor()) {
    for (int i = 0; i < 1_000_000; i++) {
        exec.submit(() -> {
            HEAVY.set(new HeavyObject());  // 1M HeavyObjects!
            process();
            // HEAVY.remove()  ← quên remove = leak!
        });
    }
}

// ✅ Dùng ScopedValue hoặc đảm bảo remove trong finally
```

### 9.2 · VT không phải Silver Bullet cho CPU-bound

```java
// ❌ VT không giúp ích
try (var exec = Executors.newVirtualThreadPerTaskExecutor()) {
    exec.submit(() -> computePrimeNumbers(1_000_000));  // CPU bound
    exec.submit(() -> encryptLargeFile(path));          // CPU bound
    exec.submit(() -> imageResize(imgData));            // CPU bound
}
// VT sẽ pin carrier threads → performance kém

// ✅ CPU-bound → ForkJoinPool hoặc parallel streams
ForkJoinPool.commonPool().submit(() -> computePrimeNumbers(1_000_000));
```

### 9.3 · Semaphore để kiểm soát VT

```java
// Vấn đề: VT tạo quá nhiều concurrent requests → overwhelm downstream
// Solution: Semaphore để rate-limit

Semaphore semaphore = new Semaphore(100);  // max 100 concurrent DB ops

try (var exec = Executors.newVirtualThreadPerTaskExecutor()) {
    for (Long id : millionIds) {
        exec.submit(() -> {
            semaphore.acquire();  // VT parked khi không có slot — OK!
            try {
                return db.findUser(id);
            } finally {
                semaphore.release();
            }
        });
    }
}
// Semaphore.acquire() dùng AbstractQueuedSynchronizer → VT-friendly (không pin)
```

### 9.4 · Connection Pool Exhaustion

```java
// Với VT: hàng nghìn VTs có thể request DB connection đồng thời
// HikariCP với pool-size=10 → 10 connections → hàng nghìn VTs WAITING

// Monitor:
hikaricp_pending_threads  // metric để watch
// Nếu cao → tăng maximum-pool-size
// Hoặc thêm Semaphore để limit concurrent DB ops
```

---

## PHẦN 10 · So Sánh Nhanh vs Reactive

| Scenario | Project Loom | Reactor/RxJava |
|----------|-------------|----------------|
| **Code style** | Sequential, blocking-look | Functional chain |
| **Debug** | Normal stack trace | Chain stack trace (khó) |
| **JDBC** | Hoạt động native | Cần R2DBC |
| **Backpressure** | Không có | Built-in |
| **Streaming** | Không tự nhiên | Native |
| **Learning curve** | Thấp | Cao |
| **Memory (1M tasks)** | ~GB (stack) | ~MB (no stack) |
| **CPU overhead** | JVM scheduling | Operator overhead |
| **Ecosystem** | All existing libs | Reactive-only libs |
| **Migration cost** | Thấp | Cao |

---

## 🔗 Liên quan trong Vault

- [[Reactive-Libraries-Comparison]] — So sánh với Reactor, RxJava, Coroutines
- [[MOC-Concurrency]] — Threading model tổng quan
- [[Framework-Decision-Matrix]] — Framework-level decision

## 📖 JEPs & Nguồn

- [JEP 444](https://openjdk.org/jeps/444) — Virtual Threads (Java 21 GA)
- [JEP 453](https://openjdk.org/jeps/453) — Structured Concurrency (Java 21 Preview)
- [JEP 446](https://openjdk.org/jeps/446) — Scoped Values (Java 21 Preview)
- [JEP 462](https://openjdk.org/jeps/462) — Structured Concurrency (Java 22 Second Preview)
- https://inside.java/tag/loom — Inside Java blog
- https://spring.io/blog/2022/10/11/embracing-virtual-threads — Spring + Loom
