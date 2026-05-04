# CDI vs Spring IoC Container — Deep Dive

> **Chủ đề:** So sánh kiến trúc CDI container với Spring IoC Container + Thread Management
> **Level:** Advanced
> **Tags:** CDI, Spring, IoC, DI, Threading, Virtual Threads, Context Propagation

---

## Phần 1 — IoC Container Architecture

### 1.1 Triết lý thiết kế khác nhau từ gốc

```
Spring IoC Container:
  "Chúng tôi quản lý object graph của bạn"
  → Container giữ bean instances
  → Inject trực tiếp reference đến instance
  → Framework-centric: Spring định nghĩa mọi thứ

CDI Container:
  "Chúng tôi quản lý contextual instances theo scope"
  → Container quản lý context, không phải instance trực tiếp
  → Inject proxy → proxy delegate đến instance đúng scope
  → Spec-centric: JCP/Eclipse định nghĩa, vendor implement
```

---

### 1.2 Bean Discovery — Cách tìm beans

```
Spring IoC:
─────────────────────────────────────────────────
Component Scan:
  @SpringBootApplication
      └── @ComponentScan("com.vpbank")
              └── Scan classpath, tìm:
                      @Component, @Service, @Repository,
                      @Controller, @Configuration + @Bean

  Explicit:
  @Bean trong @Configuration class

  Auto-configuration:
  spring.factories / AutoConfiguration.imports
  → Framework tự register beans

CDI:
─────────────────────────────────────────────────
Bean Discovery Mode (beans.xml):
  annotated (default EE 8+):
    → Chỉ class có bean-defining annotation mới là bean
    → @ApplicationScoped, @RequestScoped, @Dependent...

  all:
    → Mọi POJO đều là bean (@Dependent implicit)

  none:
    → Không scan, chỉ programmatic

  Không có beans.xml:
    → annotated mode (CDI 4.0+)

Build-time Discovery (Quarkus ArC):
    → Scan lúc build, không lúc runtime
    → Không cần beans.xml
    → Faster startup
```

```java
// Spring: nhiều cách declare bean
@Component          // generic
@Service            // service layer
@Repository         // data layer (+ exception translation)
@Controller         // web layer
@Bean               // explicit factory method
@Import(Foo.class)  // import other config

// CDI: chỉ cần scope annotation
@ApplicationScoped  // bean
@RequestScoped      // bean
@SessionScoped      // bean
@Dependent          // bean (default, không cần annotate)
// Không cần đặt tên class — scope IS the bean-defining annotation
```

---

### 1.3 Proxy Architecture — Điểm Khác Biệt Cốt Lõi

#### Spring Proxy

```
Spring tạo proxy CHỈ KHI CẦN (AOP, @Transactional, @Async):

Normal bean (không AOP):
  @Autowired OrderService svc;
  svc → [OrderService instance trực tiếp]
                    ↑
               không có proxy

Bean có @Transactional (JDK Dynamic Proxy hoặc CGLIB):
  @Autowired OrderService svc;
  svc → [CGLIB Proxy] → [OrderService instance]
           ↑
     proxy chỉ được tạo khi có AOP concern

Spring dùng 2 loại proxy:
  JDK Dynamic Proxy: nếu class implement interface
  CGLIB:            nếu class không implement interface (subclassing)
```

```java
// Spring proxy limitations:
@Service
public class OrderService {
    @Transactional
    public void placeOrder() {
        this.validateOrder(); // ❌ SELF-INVOCATION — bỏ qua proxy!
    }

    @Transactional(REQUIRES_NEW)
    public void validateOrder() {
        // Transaction không được tạo — gọi trực tiếp, không qua proxy
    }
}
// Fix: inject self, hoặc dùng AspectJ weaving
```

#### CDI Proxy

```
CDI tạo proxy cho MỌI scoped bean (trừ @Dependent):

@ApplicationScoped OrderService:
  @Inject OrderService svc;
  svc → [CDI Client Proxy] → [Context] → [OrderService instance]
              ↑                   ↑
        luôn là proxy      tìm instance theo scope hiện tại

Tại sao CDI luôn dùng proxy?
  1. Scope Resolution: proxy hỏi context "instance nào đang active?"
  2. Lazy Initialization: instance chỉ tạo khi dùng lần đầu
  3. Scope Bridging: @RequestScoped bean inject vào @ApplicationScoped
     → proxy giải quyết scope mismatch tại runtime
```

```java
// CDI proxy — KHÔNG có self-invocation problem với scope:
@ApplicationScoped
public class OrderService {
    @Inject private OrderService self; // inject chính mình qua proxy

    @Transactional
    public void placeOrder() {
        self.validateOrder(); // ✅ qua CDI proxy → @Transactional hoạt động
    }

    @Transactional(TxType.REQUIRES_NEW)
    public void validateOrder() { ... }
}

// Nhưng CDI class PHẢI:
// ❌ không final (proxy cần subclass)
// ❌ method không final
// ❌ phải có constructor không-arg (hoặc @Inject constructor)
```

#### Proxy Comparison

```
┌─────────────────────────────────────────────────────────┐
│                     PROXY COMPARISON                    │
├─────────────────┬───────────────────────────────────────┤
│ Aspect          │ Spring             CDI                 │
├─────────────────┼───────────────────────────────────────┤
│ When created    │ Only with AOP      Always (scoped)     │
│ Type            │ JDK/CGLIB          Subclass (always)   │
│ Self-invocation │ Problem!           OK qua @Inject self │
│ final class     │ CGLIB fails        Always fails        │
│ Scope bridge    │ Manual config      Automatic           │
│ Lazy init       │ @Lazy annotation   Default behavior    │
└─────────────────┴───────────────────────────────────────┘
```

---

### 1.4 Scope Resolution — Scope Mismatch Handling

```java
// === Vấn đề: inject narrow scope vào wider scope ===

// Spring — KHÔNG tự handle:
@Component  // singleton
public class OrderController {
    @Autowired
    HttpSession session; // ❌ Error hoặc dùng session của thread đầu tiên

    @Autowired
    @Scope(value = "request", proxyMode = ScopedProxyMode.TARGET_CLASS)
    RequestContext reqCtx; // ✅ phải khai báo proxyMode explicit
}

// CDI — TỰ ĐỘNG handle:
@ApplicationScoped  // singleton
public class OrderService {
    @Inject
    RequestContext reqCtx; // ✅ CDI tự tạo proxy, resolve đúng instance per request
    // Không cần config gì thêm
}
```

```
Scope hierarchy (wide → narrow):
  @ApplicationScoped (1 instance per app)
         ↓ inject OK (narrowing — CDI tự proxy)
  @SessionScoped (1 per HTTP session)
         ↓ inject OK
  @RequestScoped (1 per HTTP request)
         ↓ inject OK
  @Dependent (1 per injection point)

Inject WIDER vào NARROW (wide-into-narrow): always OK
Inject NARROW vào WIDER (narrow-into-wide): 
  Spring → fail hoặc cần proxyMode
  CDI    → proxy tự xử lý
```

---

### 1.5 Bean Lifecycle — So Sánh

```java
// === SPRING LIFECYCLE ===
@Component
public class OrderService implements InitializingBean, DisposableBean {

    // 1. Constructor
    public OrderService() { }

    // 2. Dependency injection
    @Autowired
    private OrderRepository repo;

    // 3a. @PostConstruct
    @PostConstruct
    void postConstruct() { /* sau injection */ }

    // 3b. InitializingBean.afterPropertiesSet()
    @Override
    public void afterPropertiesSet() { /* alternative */ }

    // 4. Bean ready — được dùng

    // 5a. @PreDestroy
    @PreDestroy
    void preDestroy() { /* trước khi destroy */ }

    // 5b. DisposableBean.destroy()
    @Override
    public void destroy() { /* alternative */ }
}

// === CDI LIFECYCLE ===
@ApplicationScoped
public class OrderService {

    // 1. No-arg constructor (CDI tạo proxy dùng cái này)
    public OrderService() { }

    // 2. @Inject constructor (CDI preferred)
    @Inject
    public OrderService(OrderRepository repo) {
        this.repo = repo;
    }

    // 3. Field/method injection
    @Inject
    private AuditService auditSvc;

    // 4. @PostConstruct (same annotation, same semantic)
    @PostConstruct
    void init() { /* after all injection done */ }

    // 5. Bean in use

    // 6. @PreDestroy (when scope ends)
    @PreDestroy
    void cleanup() { /* ApplicationScoped: khi app shutdown */ }
}
// CDI: @PreDestroy gắn với scope lifetime!
// @RequestScoped → PreDestroy khi request kết thúc
// @ApplicationScoped → PreDestroy khi app shutdown
```

---

### 1.6 Extension Model — Mở Rộng Container

```java
// === SPRING Extension ===
// BeanFactoryPostProcessor — modify bean definitions
@Component
public class CustomBeanProcessor implements BeanFactoryPostProcessor {
    @Override
    public void postProcessBeanFactory(ConfigurableListableBeanFactory bf) {
        // Modify bean definitions trước khi instantiate
    }
}

// BeanPostProcessor — wrap bean instances
@Component
public class LoggingBeanPostProcessor implements BeanPostProcessor {
    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        return Proxy.newProxyInstance(...); // wrap với proxy
    }
}

// ApplicationContextInitializer — hook sớm nhất
// EnvironmentPostProcessor — modify environment
// AutoConfiguration — conditional bean registration

// === CDI Extension (Portable Extension) ===
public class AuditExtension implements Extension {

    // Hook vào CDI bootstrap process
    void afterBeanDiscovery(@Observes AfterBeanDiscovery abd,
                             BeanManager bm) {
        // Thêm custom bean vào container
        abd.addBean()
           .types(AuditService.class)
           .scope(ApplicationScoped.class)
           .produceWith(ctx -> new AuditServiceImpl());
    }

    <T> void processAnnotatedType(@Observes ProcessAnnotatedType<T> pat) {
        // Modify/veto class trước khi trở thành bean
        if (pat.getAnnotatedType().isAnnotationPresent(Legacy.class)) {
            pat.veto(); // loại bỏ khỏi container
        }
    }

    void processInjectionPoint(@Observes ProcessInjectionPoint<?, ?> pip) {
        // Inspect và modify injection points
    }
}

// Đăng ký extension (META-INF/services/jakarta.enterprise.inject.spi.Extension):
// com.example.AuditExtension

// Build-time Extension (CDI 4.0 / Quarkus ArC):
public class AuditBuildExtension implements BuildCompatibleExtension {
    @Enhancement(types = AuditService.class)
    public void enhance(ClassConfig<AuditService> cls) {
        cls.addAnnotation(ApplicationScoped.class);
    }
}
```

---

### 1.7 Qualifier & Condition — Advanced Selection

```java
// === SPRING: Conditional Bean Selection ===
@Configuration
public class PaymentConfig {
    @Bean
    @ConditionalOnProperty(name = "payment.provider", havingValue = "stripe")
    public PaymentGateway stripeGateway() { return new StripeGateway(); }

    @Bean
    @ConditionalOnProperty(name = "payment.provider", havingValue = "vnpay")
    public PaymentGateway vnpayGateway() { return new VNPayGateway(); }

    @Bean
    @Primary  // default khi không có điều kiện khác
    @ConditionalOnMissingBean
    public PaymentGateway defaultGateway() { return new MockGateway(); }
}

// Inject — Spring chọn @Primary hoặc @Qualifier
@Autowired
@Qualifier("stripeGateway")
private PaymentGateway gateway;

// === CDI: Type-Safe Qualifier ===
// Không có @ConditionalOnProperty built-in
// Build-time condition (Quarkus):
@IfBuildProperty(name = "payment.provider", stringValue = "stripe")
@ApplicationScoped
public class StripeGateway implements PaymentGateway { }

@IfBuildProperty(name = "payment.provider", stringValue = "vnpay")
@ApplicationScoped
public class VNPayGateway implements PaymentGateway { }

// Custom Qualifier (type-safe):
@Qualifier @Retention(RUNTIME) @Target({TYPE, FIELD, PARAMETER})
public @interface PaymentProvider {
    String value();  // "stripe", "vnpay"
}

@ApplicationScoped @PaymentProvider("stripe")
public class StripeGateway implements PaymentGateway { }

@Inject @PaymentProvider("stripe")
private PaymentGateway gateway;

// Programmatic selection với Instance<T>:
@Inject @Any
Instance<PaymentGateway> gateways;

public PaymentGateway selectGateway(String provider) {
    return gateways.select(new PaymentProviderLiteral(provider)).get();
}
```

---

### 1.8 Summary — Container Comparison

```
┌──────────────────────┬──────────────────────────┬─────────────────────────┐
│ Feature              │ Spring IoC               │ CDI Container           │
├──────────────────────┼──────────────────────────┼─────────────────────────┤
│ Spec vs Framework    │ Framework (Spring)        │ Spec (Jakarta EE)       │
│ Bean discovery       │ @ComponentScan + @Bean    │ annotated/all/none mode │
│ Default proxy        │ Only with AOP             │ Always (scoped beans)   │
│ Proxy type           │ JDK / CGLIB               │ Subclass (always)       │
│ Scope mismatch       │ Manual proxyMode config   │ Auto via client proxy   │
│ Self-invocation      │ Problem (bypass proxy)    │ OK với @Inject self     │
│ Conditional beans    │ @ConditionalOn* (rich)    │ @IfBuildProperty (basic)│
│ Extension model      │ BeanPostProcessor etc     │ Portable Extension/BCE  │
│ Build-time opt       │ Spring AOT (Spring 6+)    │ Quarkus ArC (mature)    │
│ Qualifier type       │ String-based + @Primary   │ Annotation-based        │
│ TCK certified        │ No                        │ Yes (Weld, ArC...)      │
│ Ecosystem            │ Massive                   │ Growing (via Quarkus)   │
└──────────────────────┴──────────────────────────┴─────────────────────────┘
```

---

## Phần 2 — Thread Management

### 2.1 Mô Hình Thread Cơ Bản

```
SPRING BOOT (Tomcat/Jetty):
──────────────────────────────────────────────────────
HTTP Request → Thread Pool (Tomcat) → Controller → Service → DB
                    │
              BIO: 1 thread per connection (cũ)
              NIO: 1 thread per active request
              Virtual Threads (3.2+): 1 VT per request

CDI RUNTIME (WildFly/Quarkus):
──────────────────────────────────────────────────────
HTTP Request → Vert.x Event Loop (Quarkus) → Worker Thread
                    │
              Event Loop Thread: non-blocking ops
              Worker Thread Pool: blocking ops (@Blocking)
              Virtual Threads: @RunOnVirtualThread
```

---

### 2.2 Context Propagation — Vấn Đề Cốt Lõi

```java
// === SPRING: Context KHÔNG tự propagate sang thread mới ===

@Service
public class DocumentService {
    @Autowired SecurityContextHolder sch; // không inject được trực tiếp

    @Transactional
    public void process(String id) {
        // Trên request thread:
        // ✅ SecurityContext available
        // ✅ Transaction active

        CompletableFuture.runAsync(() -> {
            // Trên thread mới từ ForkJoinPool:
            // ❌ SecurityContext: null (không propagate mặc định)
            // ❌ Transaction: không có
            // ❌ RequestScope beans: unavailable

            Authentication auth = SecurityContextHolder.getContext().getAuthentication();
            // auth == null!
        });
    }
}

// Spring FIX: Manual context copy
SecurityContext context = SecurityContextHolder.getContext();
CompletableFuture.runAsync(() -> {
    SecurityContextHolder.setContext(context); // copy thủ công
    try {
        doWork();
    } finally {
        SecurityContextHolder.clearContext();
    }
});

// Spring FIX 2: DelegatingSecurityContextExecutor
Executor executor = new DelegatingSecurityContextExecutor(
    Executors.newFixedThreadPool(5),
    SecurityContextHolder.getContext()
);

// Spring FIX 3: TaskDecorator
@Bean
public ThreadPoolTaskExecutor executor() {
    ThreadPoolTaskExecutor exec = new ThreadPoolTaskExecutor();
    exec.setTaskDecorator(runnable -> {
        SecurityContext ctx = SecurityContextHolder.getContext();
        RequestAttributes attrs = RequestContextHolder.getRequestAttributes();
        return () -> {
            try {
                SecurityContextHolder.setContext(ctx);
                RequestContextHolder.setRequestAttributes(attrs);
                runnable.run();
            } finally {
                SecurityContextHolder.clearContext();
                RequestContextHolder.resetRequestAttributes();
            }
        };
    });
    return exec;
}
```

```java
// === CDI: Context TỰ ĐỘNG propagate qua ManagedExecutorService ===

@ApplicationScoped
public class DocumentService {

    @Inject
    ManagedExecutorService executor; // Container-managed!

    @Inject
    SecurityContext securityCtx; // CDI proxy — resolve tại point of call

    @Transactional
    public void process(String id) {
        // Trên request thread
        String currentUser = securityCtx.getCallerPrincipal().getName();

        executor.submit(() -> {
            // Trên managed thread — CDI propagate context:
            // ✅ SecurityContext: propagated
            // ✅ Transaction context: propagated (nếu config)
            // ✅ CDI Request context: propagated (nếu config)

            String user = securityCtx.getCallerPrincipal().getName();
            // user == currentUser ✅
        });
    }
}
```

---

### 2.3 Context Types — Những Gì Được Propagate

```
CDI ManagedExecutorService propagates:
┌─────────────────────────────────────────────────────────┐
│ Context Type        │ Propagate  │ Notes                │
├─────────────────────┼────────────┼──────────────────────┤
│ Security Context    │ ✅ Yes      │ Principal, roles      │
│ Transaction Context │ ✅ Yes      │ nếu PROPAGATED mode  │
│ CDI Context         │ ✅ Yes      │ @RequestScoped beans  │
│ JNDI Context        │ ✅ Yes      │ java:comp lookup      │
│ ClassLoader         │ ✅ Yes      │ same as caller        │
│ Application Context │ ✅ Yes      │ shared                │
└─────────────────────────────────────────────────────────┘

Spring @Async propagates:
┌─────────────────────────────────────────────────────────┐
│ Context Type        │ Propagate  │ Notes                │
├─────────────────────┼────────────┼──────────────────────┤
│ SecurityContext     │ ❌ Default  │ cần DelegatingSecCtx │
│ TransactionContext  │ ❌ No       │ new TX hoặc none      │
│ RequestAttributes   │ ❌ Default  │ cần TaskDecorator    │
│ MDC (Logging)       │ ❌ Default  │ cần custom copy       │
│ ApplicationContext  │ ✅ Yes      │ shared singleton      │
└─────────────────────────────────────────────────────────┘
```

---

### 2.4 @Async vs @Asynchronous — Deep Comparison

```java
// ==================== SPRING @Async ====================

@Configuration
@EnableAsync
public class AsyncConfig {
    @Bean("docExecutor")
    public Executor docExecutor() {
        ThreadPoolTaskExecutor exec = new ThreadPoolTaskExecutor();
        exec.setCorePoolSize(5);
        exec.setMaxPoolSize(20);
        exec.setQueueCapacity(100);
        exec.setThreadNamePrefix("doc-async-");
        exec.setRejectionPolicy(new CallerRunsPolicy());
        exec.setTaskDecorator(new ContextCopyDecorator()); // context copy
        exec.initialize();
        return exec;
    }
}

@Service
public class DocumentAsyncService {

    @Async("docExecutor")               // chỉ định executor
    public CompletableFuture<String> processAsync(String id) {
        // Chạy trên "doc-async-X" thread
        String result = heavyWork(id);
        return CompletableFuture.completedFuture(result);
    }

    @Async                              // dùng default executor
    public Future<Void> sendNotificationAsync(String email) {
        emailClient.send(email);
        return CompletableFuture.completedFuture(null);
    }

    // ❌ Spring @Async limitations:
    // 1. Phải return CompletableFuture/Future (hoặc void)
    // 2. Không gọi từ cùng class (self-invocation problem)
    // 3. SecurityContext không tự propagate
    // 4. Transaction bắt đầu mới (không join caller TX)
}

// ==================== CDI @Asynchronous ====================

@ApplicationScoped
public class DocumentAsyncService {

    @Asynchronous                       // CDI interceptor
    public CompletionStage<String> processAsync(String id) {
        // Chạy trên ManagedExecutorService thread
        // Context automatically propagated!
        String result = heavyWork(id);
        return CompletableFuture.completedFuture(result);
    }

    @Asynchronous
    public CompletionStage<Void> sendNotificationAsync(String email) {
        emailClient.send(email);
        return CompletableFuture.completedFuture(null);
    }

    // CDI @Asynchronous advantages:
    // ✅ Context propagated automatically
    // ✅ Return type: CompletionStage<T> (không phải CompletableFuture)
    // ✅ Exception handling qua CompletionStage.exceptionally()
    // ✅ Không cần @EnableAsync hay config executor manually
}

// === Caller Code ===
// Spring
CompletableFuture<String> future = svc.processAsync("DOC-001");
future.thenAccept(r -> log.info("Done: {}", r))
      .exceptionally(ex -> { log.error("Failed", ex); return null; });

// CDI
CompletionStage<String> stage = svc.processAsync("DOC-001");
stage.thenAccept(r -> log.info("Done: {}", r))
     .exceptionally(ex -> { log.error("Failed", ex); return null; });
```

---

### 2.5 Thread Pool — Quản Lý Thủ Công vs Container

```java
// ==================== SPRING: Developer quản lý ====================

// Phải tự define, tune, monitor từng pool
@Bean("ioExecutor")
public Executor ioExecutor() {
    return new ThreadPoolTaskExecutor() {{
        setCorePoolSize(10); setMaxPoolSize(50); setQueueCapacity(200);
        setThreadNamePrefix("io-"); initialize();
    }};
}

@Bean("cpuExecutor")
public Executor cpuExecutor() {
    int cores = Runtime.getRuntime().availableProcessors();
    return new ThreadPoolTaskExecutor() {{
        setCorePoolSize(cores); setMaxPoolSize(cores * 2); setQueueCapacity(50);
        setThreadNamePrefix("cpu-"); initialize();
    }};
}

@Bean("emailExecutor")
public Executor emailExecutor() { ... }

// Monitoring qua Actuator:
// management.endpoints.web.exposure.include=metrics
// → metrics/executor.pool.size, executor.queue.size ...

// ==================== CDI: Container quản lý ====================

// Standard executors — inject và dùng
@Resource(name = "java:comp/DefaultManagedExecutorService")
ManagedExecutorService defaultExecutor;

// Custom executor (config trong server.xml / application config)
@Resource(name = "java:app/concurrent/IOExecutor")
ManagedExecutorService ioExecutor;

// Quarkus config:
// quarkus.thread-pool.core-threads=10
// quarkus.thread-pool.max-threads=50
// quarkus.thread-pool.queue-size=200
// → Container quản lý, developer chỉ config

// CDI ManagedExecutorService có sẵn monitoring qua:
// - MicroProfile Metrics
// - Quarkus Dev UI
// - JMX MBeans
```

---

### 2.6 Virtual Threads — Spring vs CDI/Quarkus

```java
// ==================== SPRING BOOT 3.2+ Virtual Threads ====================

// application.properties
// spring.threads.virtual.enabled=true
// → Tomcat dùng Virtual Thread per request

// @Async với Virtual Thread
@Bean
public Executor virtualThreadExecutor() {
    return Executors.newVirtualThreadPerTaskExecutor();
}

@Async("virtualThreadExecutor")
public CompletableFuture<String> processOnVirtualThread(String id) {
    // Chạy trên Virtual Thread
    return CompletableFuture.completedFuture(heavyBlockingWork(id));
}

// Spring Boot tự động dùng VT cho:
// - Tomcat request handling (spring.threads.virtual.enabled=true)
// - @Async (nếu config executor dùng VT)
// - Scheduling (spring.task.scheduling.virtual-threads.enabled=true)

// ==================== QUARKUS Virtual Threads ====================

// application.properties
// quarkus.virtual-threads.name-prefix=quarkus-vt-
// quarkus.virtual-threads.enabled=true

// Per-endpoint Virtual Thread
@GET @Path("/heavy/{id}")
@RunOnVirtualThread          // Quarkus annotation
public DocumentDTO heavyBlocking(@PathParam("id") String id) {
    // Quarkus chạy endpoint này trên Virtual Thread
    // Blocking I/O (JDBC, files) an toàn ở đây
    return expensiveBlockingQuery(id);
}

// ManagedExecutorService với VT backend
@Resource
ManagedExecutorService executor;
// Quarkus config:
// quarkus.thread-pool.type=virtual-thread
// → executor tự động dùng VT

// @Asynchronous trên VT:
@Asynchronous
@RunOnVirtualThread
public CompletionStage<String> asyncOnVT(String id) {
    return CompletableFuture.completedFuture(blockingWork(id));
}
```

```
Virtual Thread Architecture:
──────────────────────────────────────────────────────────

Platform Thread (OS Thread):  ████████ ████████ ████████
                                   │        │        │
                              Mount/Unmount automatically
                                   │        │        │
Virtual Thread 1:             ██░░░░░░░████░░░░░░░░█
Virtual Thread 2:             ░░██░░░░░░░░░████░░░░░
Virtual Thread 3:             ░░░░████░░░░░░░░░░████
(░ = blocked on I/O, waiting; █ = computing)

Spring Boot 3.2+:
  Per-request: Virtual Thread (via spring.threads.virtual.enabled)
  @Async: Platform Thread (default) hoặc VT (nếu config)

Quarkus:
  Default: Vert.x Event Loop (non-blocking) + Worker Thread Pool
  @Blocking: Worker Thread (blocking code)
  @RunOnVirtualThread: Virtual Thread per call
```

---

### 2.7 Request Scope Across Threads

```java
// ==================== SPRING: RequestScope vấn đề ====================

@Component
@RequestScope
public class TenantContext {
    private String tenantId;
    // ... setters/getters
}

@Service
public class DocumentService {
    @Autowired TenantContext tenantCtx; // @RequestScope → CGLIB proxy

    @Async
    public CompletableFuture<Void> processAsync() {
        // ❌ RequestScope KHÔNG available trong @Async thread
        String tid = tenantCtx.getTenantId(); // IllegalStateException!
        // "No thread-bound request found"
        return CompletableFuture.completedFuture(null);
    }

    // Spring FIX: copy value trước khi async
    public CompletableFuture<Void> processAsyncFixed() {
        String tid = tenantCtx.getTenantId(); // copy trên request thread
        return CompletableFuture.supplyAsync(() -> {
            // dùng tid (primitive) thay vì tenantCtx (scoped bean)
            doWork(tid);
            return null;
        }, executor);
    }
}

// ==================== CDI: RequestScope propagation ====================

@RequestScoped
public class TenantContext {
    @Inject @HttpParam("X-Tenant-Id")
    private String tenantId;
}

@ApplicationScoped
public class DocumentService {
    @Inject TenantContext tenantCtx; // CDI proxy

    @Inject ManagedExecutorService executor;

    public CompletionStage<Void> processAsync() {
        // CDI option 1: ManagedExecutorService propagates RequestScope
        return executor.supplyAsync(() -> {
            // ✅ tenantCtx available (CDI propagates context)
            String tid = tenantCtx.getTenantId();
            doWork(tid);
            return null;
        });
    }

    // CDI option 2: ContextService để control what to propagate
    @Inject ContextService ctxService;

    public void manualContextPropagation() {
        Runnable task = () -> doWork(tenantCtx.getTenantId());
        // Specify which contexts to propagate
        Runnable contextual = ctxService.createContextualProxy(
            task,
            Runnable.class
        );
        new Thread(contextual).start(); // even raw thread gets context!
    }
}
```

---

### 2.8 Transaction Across Threads

```java
// ==================== SPRING ====================

@Transactional
public void parentTx() {
    String data = loadData();

    // @Async → NEW transaction (không join parent)
    asyncService.processAsync(data); // TX boundary ENDED here for child

    // Nếu muốn pass data sang async thread:
    // → Pass object, không pass entity (detached)
}

@Async
@Transactional(Propagation.REQUIRES_NEW)
public CompletableFuture<Void> processAsync(String data) {
    // New transaction, independent of parent
    repo.save(new Result(data));
    return CompletableFuture.completedFuture(null);
}

// ==================== CDI ====================

@Transactional
public void parentTx() {
    String data = loadData();

    // ManagedExecutorService + PROPAGATED transaction context
    executor.submit(() -> {
        // Option A: Joined parent TX (nếu executor config PROPAGATED)
        repo.save(new Result(data)); // trong TX của parent!
    });

    // Option B: REQUIRES_NEW trong executor
    // → executor tạo TX mới, không join parent
}

// CDI Transaction Propagation cho executor:
// server.xml / Quarkus config:
// propagated: ["Transaction"] → join parent TX
// cleared: ["Transaction"]   → no TX trong thread
// unchanged: ["Transaction"] → giữ nguyên (nếu executor inherit)
```

---

### 2.9 Scheduled Tasks — So Sánh

```java
// ==================== SPRING ====================

@Configuration
@EnableScheduling
public class ScheduleConfig {
    @Bean
    public TaskScheduler scheduler() {
        ThreadPoolTaskScheduler s = new ThreadPoolTaskScheduler();
        s.setPoolSize(5);
        s.setThreadNamePrefix("scheduled-");
        // Virtual threads:
        s.setVirtualThreads(true); // Spring Boot 3.2+
        return s;
    }
}

@Component
public class DocumentScheduler {

    @Scheduled(fixedDelay = 60_000)
    public void cleanup() { ... }

    @Scheduled(cron = "0 0 2 * * *")  // 2am daily
    public void dailyArchive() { ... }

    @Scheduled(initialDelay = 10_000, fixedRate = 30_000)
    public void healthCheck() { ... }
}

// ==================== CDI (Jakarta Concurrency) ====================

@ApplicationScoped
public class DocumentScheduler {

    @Inject
    ManagedScheduledExecutorService scheduler;

    @PostConstruct
    void init() {
        scheduler.scheduleWithFixedDelay(
            this::cleanup, 0, 60, SECONDS
        );

        // Calendar-based (cron equivalent)
        ScheduleExpression expr = new ScheduleExpression()
            .hour("2").minute("0").second("0");
        scheduler.schedule(this::dailyArchive, expr); // via TimerService

        scheduler.scheduleAtFixedRate(
            this::healthCheck, 10, 30, SECONDS
        );
    }

    @PreDestroy
    void stop() { scheduler.shutdownNow(); }

    void cleanup() { ... }
    void dailyArchive() { ... }
    void healthCheck() { ... }
}

// Quarkus: @Scheduled annotation (simpler)
@ApplicationScoped
public class QuarkusScheduler {
    @Scheduled(every = "60s")              // Quarkus-specific
    void cleanup() { ... }

    @Scheduled(cron = "0 0 2 * * ?")
    void dailyArchive() { ... }
}
```

---

## 3. Summary — Thread Model Comparison

```
┌─────────────────────────────┬───────────────────────┬───────────────────────┐
│ Feature                     │ Spring Boot            │ CDI / Quarkus         │
├─────────────────────────────┼───────────────────────┼───────────────────────┤
│ Default HTTP threading      │ Thread-per-request     │ Event Loop + Workers  │
│                             │ (Tomcat NIO)           │ (Vert.x)              │
│ Async method                │ @Async                 │ @Asynchronous         │
│ Async executor type         │ ThreadPoolTaskExecutor │ ManagedExecutorService│
│ Context propagation         │ Manual (decorator)     │ Automatic (container) │
│ Security across threads     │ DelegatingSecCtxExec   │ Auto via managed exec │
│ TX across threads           │ New TX (default)       │ Configurable propagate│
│ Request scope in async      │ ❌ Not available        │ ✅ With managed exec  │
│ Virtual Threads             │ ✅ Spring Boot 3.2+     │ ✅ @RunOnVirtualThread│
│ Scheduled tasks             │ @Scheduled (easy)      │ ManagedScheduledExec  │
│ Custom executor              │ @Bean Executor         │ @Resource / config    │
│ Thread pool config          │ Developer-defined       │ Container-configured  │
│ Observability               │ Actuator metrics        │ MicroProfile Metrics  │
└─────────────────────────────┴───────────────────────┴───────────────────────┘
```

---

## 4. Kết Luận — Khi Nào Dùng Cái Nào

```
Spring @Async — Chọn khi:
✅ Spring ecosystem sâu (Spring Security, Spring Data...)
✅ Team quen Spring, không muốn học CDI
✅ Cần @ConditionalOn* cho dynamic executor selection
✅ Cần Spring Actuator metrics cho executor monitoring

CDI ManagedExecutorService — Chọn khi:
✅ Cần automatic context propagation (ít boilerplate)
✅ Cần transactional async (join parent TX)
✅ Muốn vendor-neutral code (chạy WildFly, Quarkus, Liberty)
✅ Cần request scope trong async thread

Quarkus @RunOnVirtualThread — Chọn khi:
✅ Blocking I/O intensive (JDBC, file, REST call)
✅ Muốn simplicity của thread-per-request + performance VT
✅ Serverless / container cost optimization

Spring Boot 3.2 Virtual Threads — Chọn khi:
✅ Đang dùng Spring, muốn VT performance
✅ spring.threads.virtual.enabled=true là đủ
✅ Không muốn refactor sang reactive/async
```

---

*[[01-CDI-Contexts-DI]] | [[11-Jakarta-Concurrency]] | [[00-Overview]]*
*Related: [[concepts/rust-java-go-comparison]]*
