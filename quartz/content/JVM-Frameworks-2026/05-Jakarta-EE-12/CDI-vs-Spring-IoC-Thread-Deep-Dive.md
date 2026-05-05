# CDI vs Spring IoC — Deep Dive + Thread Management

> **Mục tiêu:** Hiểu rõ sự khác biệt kiến trúc giữa CDI Container và Spring IoC, cùng cơ chế quản lý thread
> **Visual reference:** Xem widget trong Claude conversation để thấy sơ đồ tương tác

---

## Phần 1 — IoC Container: Triết Lý Khác Nhau

```
Spring IoC:  "Quản lý object graph — inject trực tiếp instance"
CDI:         "Quản lý contextual instances theo scope — inject qua proxy"
```

### Bean Discovery

| | Spring IoC | CDI |
|---|---|---|
| Cơ chế | Classpath scan + `@ComponentScan` | Annotation-based + `beans.xml` mode |
| Trigger | `@Component`, `@Service`, `@Bean` | Scope annotation (`@ApplicationScoped`…) |
| Build-time | Spring AOT (Spring 6+, limited) | Quarkus ArC (mature, full) |
| Default scope | Singleton | `@Dependent` |

### Proxy Model — Điểm Khác Biệt Cốt Lõi

```
Spring (không AOP):
  [Caller] ──→ [Bean instance]           ← direct reference, no proxy

Spring (với @Transactional):
  [Caller] ──→ [CGLIB Proxy] ──→ [Bean]  ← created on demand

CDI (luôn luôn):
  [Caller] ──→ [Client Proxy] ──→ [Context] ──→ [Scoped Instance]
                                     ↑
                               resolve đúng instance theo scope
```

**Tại sao CDI luôn dùng proxy:**
1. **Scope bridging tự động** — @ApplicationScoped inject @RequestScoped → proxy tìm instance đúng per request
2. **Lazy initialization** — instance chỉ tạo khi gọi lần đầu
3. **Self-invocation OK** — gọi `self.method()` qua `@Inject self` vẫn đi qua proxy

**Constraint CDI class:**
- KHÔNG được là `final`
- Method KHÔNG được là `final`
- Phải có no-arg constructor (hoặc @Inject constructor)

### Scope Resolution — Spring vs CDI

```java
// Spring — CẦN khai báo proxyMode thủ công
@Component  // singleton
public class OrderController {
    @Autowired
    @Scope(value = "request", proxyMode = ScopedProxyMode.TARGET_CLASS)
    RequestContext reqCtx; // phải explicit proxyMode
}

// CDI — TỰ ĐỘNG
@ApplicationScoped  // singleton
public class OrderService {
    @Inject
    RequestContext reqCtx; // CDI tự tạo proxy, không cần config gì
}
```

### Self-Invocation Problem

```java
// Spring — self-invocation BYPASS proxy → @Transactional không hoạt động
@Service
public class OrderService {
    @Transactional
    public void outer() {
        this.inner(); // ❌ gọi trực tiếp, không qua proxy
    }
    @Transactional(REQUIRES_NEW)
    public void inner() { ... } // TX mới KHÔNG được tạo
}

// CDI — self-invocation qua @Inject self → OK
@ApplicationScoped
public class OrderService {
    @Inject private OrderService self; // inject chính mình qua proxy

    @Transactional
    public void outer() {
        self.inner(); // ✅ qua CDI proxy
    }
    @Transactional(TxType.REQUIRES_NEW)
    public void inner() { ... } // TX mới được tạo đúng
}
```

---

## Pros & Cons — IoC Container

### Spring IoC ✅
- Ecosystem khổng lồ: Boot, Data, Security, Cloud, Batch
- `@ConditionalOn*` — conditional bean registration rất mạnh
- Auto-configuration giảm boilerplate
- `BeanPostProcessor` — wrap bean instance linh hoạt
- Test support: `@MockBean`, `@SpyBean`, TestContext framework

### Spring IoC ❌
- Self-invocation problem — @Transactional bị bypass
- Scope mismatch cần `proxyMode` thủ công
- Không có TCK certification → vendor lock-in
- Startup chậm hơn (reflection-heavy)
- Broadcom ownership — license risk dài hạn

### CDI ✅
- TCK certified → portable WildFly, Open Liberty, Payara, Quarkus
- Self-invocation OK qua proxy
- Scope mismatch tự động giải quyết
- Build-time extension (Quarkus ArC) → startup sub-second
- `@Disposes` — lifecycle cleanup theo scope
- Type-safe qualifier — compile-time check

### CDI ❌
- Không có `@ConditionalOnProperty` built-in
- Scoped bean phải non-final
- Ecosystem nhỏ hơn Spring
- Ít tài liệu hơn

---

## Phần 2 — Thread Management

### Mô Hình Thread Cơ Bản

```
Spring Boot (Tomcat):
  HTTP Request → Platform Thread Pool (default 200) → Controller → Service → DB
  VT từ 3.2: spring.threads.virtual.enabled=true

Quarkus (Vert.x):
  HTTP Request → Event Loop (non-blocking) → fan-out:
                    └→ Worker Thread Pool    (@Blocking)
                    └→ Virtual Thread        (@RunOnVirtualThread)
                    └→ ManagedExecutorService (context-aware)
```

### Context Propagation — Điểm Khác Biệt Lớn Nhất

```
Spring @Async (DEFAULT):
  Request Thread:    ✓ SecurityContext | ✓ Transaction | ✓ RequestScope | ✓ MDC
       ↓ fork
  @Async Thread:     ✗ SecurityContext | ✗ Transaction | ✗ RequestScope | ✗ MDC

CDI ManagedExecutorService:
  Request Thread:    ✓ SecurityContext | ✓ Transaction | ✓ RequestScope | ✓ MDC
       ↓ fork
  Managed Thread:    ✓ SecurityContext | ✓ Transaction | ✓ RequestScope | ✓ MDC
```

### Spring — Fix Context Propagation (Thủ Công)

```java
// Fix 1: DelegatingSecurityContextExecutor
Executor executor = new DelegatingSecurityContextExecutor(
    Executors.newFixedThreadPool(5),
    SecurityContextHolder.getContext()
);

// Fix 2: TaskDecorator (copy tất cả context)
@Bean
public ThreadPoolTaskExecutor executor() {
    ThreadPoolTaskExecutor exec = new ThreadPoolTaskExecutor();
    exec.setTaskDecorator(runnable -> {
        SecurityContext secCtx = SecurityContextHolder.getContext();
        RequestAttributes reqAttrs = RequestContextHolder.getRequestAttributes();
        Map<String, String> mdc = MDC.getCopyOfContextMap();
        return () -> {
            try {
                SecurityContextHolder.setContext(secCtx);
                RequestContextHolder.setRequestAttributes(reqAttrs);
                if (mdc != null) MDC.setContextMap(mdc);
                runnable.run();
            } finally {
                SecurityContextHolder.clearContext();
                RequestContextHolder.resetRequestAttributes();
                MDC.clear();
            }
        };
    });
    return exec;
}
```

### CDI — Context Propagation Tự Động

```java
@ApplicationScoped
public class DocumentService {

    @Inject ManagedExecutorService executor; // Container-managed!
    @Inject SecurityContext secCtx;          // CDI proxy — auto-resolves

    @Transactional
    public CompletionStage<Void> processAsync(String id) {
        return executor.supplyAsync(() -> {
            // ✅ Tất cả context được propagate automatically
            String user = secCtx.getCallerPrincipal().getName();
            doWork(id, user);
            return null;
        });
    }
}
```

### @Async vs @Asynchronous

```java
// === SPRING @Async ===
@Configuration @EnableAsync
public class AsyncConfig {
    @Bean("docExec")
    public Executor executor() {
        ThreadPoolTaskExecutor e = new ThreadPoolTaskExecutor();
        e.setCorePoolSize(5); e.setMaxPoolSize(20);
        e.setTaskDecorator(new ContextCopyDecorator()); // context copy thủ công
        e.initialize(); return e;
    }
}

@Async("docExec")
public CompletableFuture<String> processAsync(String id) {
    return CompletableFuture.completedFuture(heavyWork(id));
}
// ⚠ Context KHÔNG propagate mặc định
// ⚠ Không gọi từ cùng class (self-invocation)

// === CDI @Asynchronous ===
@ApplicationScoped
public class DocumentService {
    @Asynchronous // CDI interceptor
    public CompletionStage<String> processAsync(String id) {
        // ✅ Context propagated automatically
        return CompletableFuture.completedFuture(heavyWork(id));
    }
}
```

### Virtual Threads

```java
// === SPRING BOOT 3.2+ ===
// application.properties:
// spring.threads.virtual.enabled=true
// → Tomcat dùng VT per request

@Async
public CompletableFuture<String> asyncOnVT(String id) {
    return CompletableFuture.completedFuture(blockingWork(id));
}
// Cần config: executor = Executors.newVirtualThreadPerTaskExecutor()

// === QUARKUS ===
@GET @Path("/heavy/{id}")
@RunOnVirtualThread // Quarkus annotation
public DocumentDTO heavyBlocking(@PathParam("id") String id) {
    return expensiveBlockingQuery(id); // blocking I/O OK trên VT
}

@Asynchronous
@RunOnVirtualThread
public CompletionStage<String> asyncOnVT(String id) {
    return CompletableFuture.completedFuture(blockingWork(id));
}
```

---

## Pros & Cons — Thread Management

### Spring @Async ✅
- Đơn giản, ít boilerplate — chỉ cần `@Async`
- `@Scheduled` dễ dùng với cron expression
- Actuator metrics cho thread pool monitoring
- Tuning chi tiết per executor
- VT support từ Spring Boot 3.2 không cần refactor lớn

### Spring @Async ❌
- SecurityContext không tự propagate → cần `DelegatingSecurityContextExecutor`
- RequestScope mất trong async thread → `IllegalStateException`
- MDC không propagate → audit log mất tenant context
- Transaction không join được từ `@Async` thread
- `TaskDecorator` boilerplate phức tạp

### CDI ManagedExecutorService ✅
- Context tự động propagate: Security, TX, RequestScope, MDC
- `@Transactional` propagation configurable (có thể join parent TX)
- `ContextService` — manual control khi cần chọn lọc
- `@RunOnVirtualThread` (Quarkus) clean và đơn giản
- Tích hợp với CDI Event → `AFTER_SUCCESS` observer chỉ chạy sau commit

### CDI ManagedExecutorService ❌
- Config executor phức tạp hơn (quarkus config hoặc server.xml)
- Ít `@annotation` sugar hơn Spring
- Vert.x model cần hiểu blocking vs non-blocking
- `@Asynchronous` CDI ít quen thuộc hơn `@Async`

---

## Summary Table

| Feature | Spring IoC/@Async | CDI/ManagedExecutor |
|---|---|---|
| Proxy | Chỉ khi AOP | Luôn luôn (scoped) |
| Scope mismatch | Manual `proxyMode` | Tự động |
| Self-invocation | Problem | OK via @Inject self |
| Context propagation | Manual decorator | Automatic |
| Security in async | Cần DelegatingExec | Auto propagated |
| TX in async | New TX default | Configurable join |
| RequestScope async | Không available | Available |
| Virtual Threads | Spring Boot 3.2+ | @RunOnVirtualThread |
| Portability | Spring only | Jakarta EE TCK |
| Ecosystem | Massive | Growing (via Quarkus) |

---

*Xem diagram tương tác trong Claude conversation*
*[[01-CDI-Contexts-DI]] | [[11-Jakarta-Concurrency]] | [[00-Overview]]*
