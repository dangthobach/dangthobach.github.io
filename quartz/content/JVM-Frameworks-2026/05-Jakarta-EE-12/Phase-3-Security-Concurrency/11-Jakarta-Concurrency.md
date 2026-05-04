# 11 — Jakarta Concurrency 3.x

> **Spec:** Jakarta Concurrency 3.x | **Profile:** Web Profile
> **Spring equivalent:** `@Async`, `ThreadPoolTaskExecutor`, `@Scheduled`, Virtual Threads
> **Prototype runtime:** Quarkus + Virtual Threads (Loom)

---

## 1. Spec Says

Jakarta Concurrency định nghĩa **managed concurrency** cho Java EE — tức là threads được tạo và quản lý bởi container, không phải ứng dụng trực tiếp. Lý do: thread tự tạo (raw `new Thread()`) trong Java EE **mất container context** (transaction, security, JNDI...).

Jakarta Concurrency 3.x thêm: Virtual Thread support, Context propagation cải tiến.

---

## 2. Managed Executors — Thread Pool

```java
// === SPRING ===
@Configuration
public class AsyncConfig {
    @Bean("documentExecutor")
    public Executor documentExecutor() {
        ThreadPoolTaskExecutor exec = new ThreadPoolTaskExecutor();
        exec.setCorePoolSize(5);
        exec.setMaxPoolSize(20);
        exec.setQueueCapacity(100);
        exec.setThreadNamePrefix("doc-");
        exec.initialize();
        return exec;
    }
}

@Async("documentExecutor")
public CompletableFuture<Void> processAsync(String docId) {
    doWork(docId);
    return CompletableFuture.completedFuture(null);
}

// === JAKARTA CONCURRENCY ===
// Inject managed executor — container quản lý
@Resource(name = "java:comp/DefaultManagedExecutorService")
ManagedExecutorService executor;

// Hoặc via CDI trong Quarkus
@Inject
ManagedExecutorService executor;

// Submit task
Future<String> future = executor.submit(() -> {
    // Transaction context từ caller được propagate!
    return processDocument(docId);
});

// CompletableFuture async
CompletableFuture<String> cf = executor.supplyAsync(() -> processDocument(docId));
cf.thenAccept(result -> log.info("Done: {}", result));
```

---

## 3. Context Propagation — Điểm Khác Biệt Quan Trọng

```java
// Raw thread — MẤT context
new Thread(() -> {
    // ❌ SecurityContext: null
    // ❌ Transaction: không có
    // ❌ JNDI lookup: fail
    em.find(Document.class, id); // fail
}).start();

// ManagedExecutorService — GIỮ context
executor.submit(() -> {
    // ✅ SecurityContext: propagated từ caller
    // ✅ Transaction: propagated (nếu caller có TX)
    // ✅ JNDI: available
    em.find(Document.class, id); // ok
});
```

---

## 4. @Asynchronous — CDI Annotation

```java
// === JAKARTA CDI @Asynchronous ===
// (khác với Jakarta Concurrency, nhưng liên quan)
@ApplicationScoped
public class NotificationService {

    @Asynchronous          // CDI interceptor → chạy trên managed thread
    public CompletionStage<Void> sendEmail(String to, String subject, String body) {
        // Chạy trên separate managed thread
        emailClient.send(to, subject, body);
        return CompletableFuture.completedFuture(null);
    }

    @Asynchronous
    public CompletionStage<DocumentDTO> processDocument(String id) {
        var result = heavyProcessing(id);
        return CompletableFuture.completedFuture(result);
    }
}

// Caller
@Inject NotificationService notifSvc;

// Non-blocking call
CompletionStage<Void> stage = notifSvc.sendEmail("user@bank.com", "Alert", "Body");
stage.exceptionally(ex -> { log.error("Email failed", ex); return null; });
```

---

## 5. ManagedScheduledExecutorService — Scheduled Tasks

```java
// === SPRING ===
@Scheduled(fixedDelay = 60000)              // mỗi 60s
@Scheduled(cron = "0 0 * * * *")           // mỗi giờ
public void cleanup() { doCleanup(); }

// === JAKARTA CONCURRENCY ===
@ApplicationScoped
public class SchedulerSetup {

    @Resource
    ManagedScheduledExecutorService scheduler;

    @PostConstruct
    void init() {
        // Mỗi 60 giây
        scheduler.scheduleAtFixedRate(
            this::cleanupExpired,
            0,              // initial delay
            60,             // period
            TimeUnit.SECONDS
        );

        // Với cron-like (delay sau mỗi lần chạy)
        scheduler.scheduleWithFixedDelay(
            this::processOutbox,
            10,
            30,
            TimeUnit.SECONDS
        );
    }

    @PreDestroy
    void shutdown() {
        scheduler.shutdownNow();
    }

    void cleanupExpired() {
        log.info("Running cleanup...");
        // context được propagate
    }

    void processOutbox() {
        log.info("Processing outbox...");
    }
}
```

---

## 6. Virtual Threads (Loom) Integration

```java
// Jakarta Concurrency 3.x thêm Virtual Thread support
// ContextService dùng để wrap task với context

@Resource
ContextService contextService;

// Tạo Virtual Thread Factory với context
ThreadFactory vtFactory = contextService.createContextualProxy(
    Thread.ofVirtual().factory(),
    ThreadFactory.class
);

ExecutorService vtExecutor = Executors.newThreadPerTaskExecutor(vtFactory);

// Mỗi task chạy trên virtual thread riêng — scale cao
for (String docId : docIds) {
    vtExecutor.submit(() -> processDocument(docId)); // mỗi cái 1 VT
}

// === Quarkus đơn giản hơn ===
// application.properties:
// quarkus.thread-pool.type=virtual   — enable virtual threads globally
// Hoặc per-method:

@RunOnVirtualThread    // Quarkus annotation
@GET
@Path("/heavy/{id}")
public DocumentDTO heavyProcess(@PathParam("id") String id) {
    // Chạy trên virtual thread — blocking I/O OK
    return expensiveBlockingOperation(id);
}
```

---

## 7. ContextService — Manual Context Copy

```java
// Dùng khi cần copy context sang thread không phải managed
@Resource
ContextService contextService;

@Transactional
public void processWithCallback(String docId, Runnable callback) {
    // Capture current context
    Runnable contextualCallback = contextService.createContextualProxy(
        callback,
        Runnable.class
    );

    // Chạy callback trên thread khác với context đầy đủ
    CompletableFuture.runAsync(contextualCallback, executor);
}
```

---

## 8. Prototype — Batch Document Processor

```java
@ApplicationScoped
public class BatchDocumentProcessor {

    @Inject ManagedExecutorService executor;
    @Inject DocumentRepository repo;
    @Inject NotificationService notifSvc;

    // Xử lý nhiều document song song, collect kết quả
    @Transactional
    public BatchResult processBatch(List<String> documentIds) throws Exception {
        List<CompletableFuture<ProcessResult>> futures = documentIds.stream()
            .map(id -> executor.supplyAsync(() -> processOne(id)))
            .toList();

        // Chờ tất cả — với timeout
        CompletableFuture<Void> allDone = CompletableFuture.allOf(
            futures.toArray(new CompletableFuture[0])
        );

        try {
            allDone.get(30, TimeUnit.SECONDS);
        } catch (TimeoutException e) {
            futures.forEach(f -> f.cancel(true));
            throw new BatchTimeoutException("Batch timed out after 30s");
        }

        // Collect results
        List<ProcessResult> results = futures.stream()
            .map(f -> {
                try { return f.get(); }
                catch (Exception e) { return ProcessResult.failed(e.getMessage()); }
            }).toList();

        long success = results.stream().filter(ProcessResult::success).count();
        long failed  = results.size() - success;

        return new BatchResult(success, failed, results);
    }

    private ProcessResult processOne(String docId) {
        try {
            Document doc = repo.findById(docId)
                .orElseThrow(() -> new NotFoundException(docId));
            // Simulate work
            Thread.sleep(100);
            repo.updateStatus(docId, "PROCESSED");
            return ProcessResult.ok(docId);
        } catch (Exception e) {
            return ProcessResult.failed(docId, e.getMessage());
        }
    }
}

// === Scheduled cleanup ===
@ApplicationScoped
public class MaintenanceScheduler {

    @Inject ManagedScheduledExecutorService scheduler;
    @Inject DocumentRepository repo;

    private ScheduledFuture<?> cleanupTask;

    @PostConstruct
    void start() {
        cleanupTask = scheduler.scheduleWithFixedDelay(
            this::cleanupArchived,
            60, 3600,    // start sau 1 phút, lặp mỗi 1 giờ
            TimeUnit.SECONDS
        );
    }

    @PreDestroy
    void stop() {
        if (cleanupTask != null) cleanupTask.cancel(false);
    }

    void cleanupArchived() {
        Instant cutoff = Instant.now().minus(90, ChronoUnit.DAYS);
        int deleted = repo.deleteOldArchived("*", cutoff);
        log.infof("Cleaned up %d archived documents", deleted);
    }
}

// === REST Resource ===
@Path("/api/batch")
@Produces(MediaType.APPLICATION_JSON)
public class BatchResource {

    @Inject BatchDocumentProcessor processor;

    @POST
    @Path("/process")
    public Response process(List<String> documentIds) throws Exception {
        if (documentIds.size() > 100) {
            return Response.status(400)
                .entity(Map.of("error", "Max 100 documents per batch"))
                .build();
        }
        var result = processor.processBatch(documentIds);
        return Response.ok(result).build();
    }
}

// Records
public record ProcessResult(String docId, boolean success, String error) {
    static ProcessResult ok(String id) { return new ProcessResult(id, true, null); }
    static ProcessResult failed(String msg) { return new ProcessResult(null, false, msg); }
    static ProcessResult failed(String id, String msg) { return new ProcessResult(id, false, msg); }
}
public record BatchResult(long success, long failed, List<ProcessResult> details) {}
```

```bash
./mvnw quarkus:dev

# Test batch
curl -X POST http://localhost:8080/api/batch/process \
  -H "Content-Type: application/json" \
  -d '["doc-001","doc-002","doc-003","doc-invalid"]'
```

---

## 9. Spring vs Jakarta Concurrency

| Tính năng | Spring | Jakarta Concurrency |
|---|---|---|
| Thread pool | `ThreadPoolTaskExecutor` | `ManagedExecutorService` |
| Async method | `@Async("beanName")` | `@Asynchronous` (CDI) |
| Return type | `CompletableFuture<T>` | `CompletionStage<T>` |
| Scheduled | `@Scheduled(cron=...)` | `ManagedScheduledExecutorService` |
| Virtual threads | Spring Boot 3.2+ config | `Thread.ofVirtual()` + ContextService |
| Context propagation | Spring Security propagation | Built-in via container |
| Custom executor | `@Async("myExec")` | `@Resource(name="...")` |

---

*[[10-Jakarta-Security]] | [[00-Overview]] | Next: [[12-Jakarta-Messaging]]*
