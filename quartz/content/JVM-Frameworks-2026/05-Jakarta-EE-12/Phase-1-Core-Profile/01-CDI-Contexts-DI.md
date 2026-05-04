# 01 — CDI 5.0: Contexts & Dependency Injection

> **Spec:** Jakarta CDI 5.0 | **Profile:** Core
> **Spring equivalent:** Spring DI (`@Component`, `@Autowired`, `@Bean`, Spring AOP)
> **Prototype runtime:** Quarkus

---

## 1. Spec Says

CDI định nghĩa **bean lifecycle** và **injection** theo cách type-safe, loosely-coupled. Khác với Spring, CDI là **spec chuẩn** — implementation có thể là Weld (WildFly/GlassFish), ArC (Quarkus), Micronaut CDI-compatible layer.

Core concept:
- **Bean** = managed object với lifecycle
- **Scope** = quyết định khi nào bean được tạo/destroyed
- **Injection Point** = nơi bean được inject vào
- **Qualifier** = phân biệt nhiều implementation cùng type
- **Interceptor** = cross-cutting concern (AOP)
- **Event** = loosely-coupled communication

---

## 2. Scope Mapping

| CDI Annotation | Lifecycle | Spring Equivalent |
|---|---|---|
| `@ApplicationScoped` | Tạo 1 lần, sống suốt app | `@Singleton` / default `@Component` |
| `@RequestScoped` | Tạo mỗi HTTP request | `@RequestScope` |
| `@SessionScoped` | Sống theo HTTP session | `@SessionScope` |
| `@Dependent` | Lifecycle theo owner (default) | `@Prototype` scope |
| `@ConversationScoped` | Explicit begin/end | Không có equivalent trực tiếp |
| `@Singleton` (CDI) | True singleton, không proxy | Không khuyến khích dùng trong CDI |

### ⚠️ Khác biệt quan trọng: Proxy

```
Spring:     @Component → instance thật, inject trực tiếp
CDI:        @ApplicationScoped → proxy object, delegate đến instance thật

Lý do: CDI cần proxy để support scope switching và lazy init
```

```java
// CDI — @ApplicationScoped bean là proxy
@ApplicationScoped
public class OrderService {
    // CDI tạo subclass proxy, không phải instance này
    // → class phải không phải final, method không phải final
}

// Spring — @Component là instance thật
@Service
public class OrderService {
    // Instance thật, không qua proxy (trừ khi có AOP)
}
```

---

## 3. Injection Mapping

```java
// === SPRING ===
@Service
public class PaymentService {
    @Autowired
    private OrderRepository orderRepo; // field injection

    @Autowired
    public PaymentService(OrderRepository repo) { // constructor injection (preferred)
        this.orderRepo = repo;
    }
}

// === CDI 5.0 ===
@ApplicationScoped
public class PaymentService {
    @Inject
    private OrderRepository orderRepo; // field injection (OK in CDI)

    @Inject
    public PaymentService(OrderRepository repo) { // constructor injection
        this.orderRepo = repo;
    }

    // CDI cũng hỗ trợ initializer method injection
    @Inject
    public void setRepo(OrderRepository repo) {
        this.orderRepo = repo;
    }
}
```

---

## 4. Qualifier — Phân biệt Implementation

```java
// === SPRING ===
@Component("primaryPayment")
public class StripePayment implements PaymentGateway {}

@Component("backupPayment")
public class VNPayPayment implements PaymentGateway {}

@Autowired
@Qualifier("primaryPayment")
private PaymentGateway gateway;

// === CDI 5.0 ===
// Bước 1: Define qualifier annotation
@Qualifier
@Retention(RUNTIME)
@Target({TYPE, METHOD, FIELD, PARAMETER})
public @interface Primary {}

@Qualifier
@Retention(RUNTIME)
@Target({TYPE, METHOD, FIELD, PARAMETER})
public @interface Backup {}

// Bước 2: Annotate implementations
@ApplicationScoped @Primary
public class StripePayment implements PaymentGateway {}

@ApplicationScoped @Backup
public class VNPayPayment implements PaymentGateway {}

// Bước 3: Inject với qualifier
@Inject @Primary
private PaymentGateway gateway;
```

CDI qualifier mạnh hơn Spring `@Qualifier` vì:
- Type-safe (annotation, không phải string)
- Có thể có attributes: `@PaymentType(value = "STRIPE")`
- Compiler check — typo bị catch lúc compile

---

## 5. Producer — Tạo Bean Từ Factory

```java
// === SPRING ===
@Configuration
public class AppConfig {
    @Bean
    public DataSource dataSource() {
        return DataSourceBuilder.create().build();
    }
}

// === CDI 5.0 ===
@ApplicationScoped
public class DataSourceProducer {

    @Produces
    @ApplicationScoped
    public DataSource produceDataSource() {
        // Tạo và return DataSource
        return createDataSource();
    }

    // Cleanup khi bean bị destroyed
    public void disposeDataSource(@Disposes DataSource ds) {
        ds.close();
    }
}
```

`@Disposes` là tính năng không có trong Spring — CDI tự gọi cleanup method khi scope kết thúc.

---

## 6. Interceptor — AOP

```java
// === SPRING AOP ===
@Aspect
@Component
public class LoggingAspect {
    @Around("@annotation(Logged)")
    public Object log(ProceedingJoinPoint pjp) throws Throwable {
        log.info("Calling {}", pjp.getSignature());
        return pjp.proceed();
    }
}

// === CDI Interceptor ===
// Bước 1: Define binding annotation
@InterceptorBinding
@Retention(RUNTIME)
@Target({TYPE, METHOD})
public @interface Logged {}

// Bước 2: Implement interceptor
@Logged
@Interceptor
@Priority(Interceptor.Priority.APPLICATION)  // thứ tự ưu tiên
public class LoggingInterceptor {

    @AroundInvoke
    public Object log(InvocationContext ctx) throws Exception {
        System.out.println("Calling: " + ctx.getMethod().getName());
        try {
            return ctx.proceed();
        } finally {
            System.out.println("Done: " + ctx.getMethod().getName());
        }
    }
}

// Bước 3: Apply
@ApplicationScoped
@Logged  // áp dụng cho toàn class
public class OrderService {
    @Logged  // hoặc method-level
    public void processOrder(Order order) { ... }
}
```

---

## 7. Event — Loose Coupling

```java
// === SPRING ===
// Publisher
@Autowired
private ApplicationEventPublisher publisher;
publisher.publishEvent(new OrderCreatedEvent(order));

// Listener
@EventListener
public void onOrderCreated(OrderCreatedEvent event) { ... }

// === CDI Event ===
// Publisher
@Inject
private Event<OrderCreated> orderCreatedEvent;

orderCreatedEvent.fire(new OrderCreated(order.getId())); // sync
// hoặc async:
orderCreatedEvent.fireAsync(new OrderCreated(order.getId()));

// Listener
public void onOrderCreated(@Observes OrderCreated event) {
    // sync observer
}

public void onOrderCreatedAsync(@ObservesAsync OrderCreated event) {
    // async observer (CDI 2.0+)
}

// Conditional observation
public void onActiveOrder(@Observes @Priority(100) OrderCreated event,
                          OrderRepository repo) {
    // CDI inject thêm bean vào observer method — Spring không làm được
}
```

---

## 8. CDI 5.0 — Cái Mới So Với 4.x

- **Build-compatible extensions** — extension chạy lúc build time (Quarkus ArC dùng cái này)
- **Configurator API** cải tiến
- Record support làm bean (constructor injection tự động)
- Loại bỏ SecurityManager dependency

---

## 9. Prototype — Chạy Được Trên Quarkus

```bash
# Tạo project
mvn io.quarkus.platform:quarkus-maven-plugin:3.x.x:create \
    -DprojectArtifactId=cdi-lab \
    -Dextensions="rest,rest-jackson"
```

```java
// src/main/java/com/lab/cdi/

// === Model ===
public record Order(String id, String product, double amount) {}

// === Qualifier ===
@Qualifier @Retention(RUNTIME) @Target({TYPE, METHOD, FIELD, PARAMETER})
public @interface Premium {}

@Qualifier @Retention(RUNTIME) @Target({TYPE, METHOD, FIELD, PARAMETER})
public @interface Standard {}

// === Interface ===
public interface PricingStrategy {
    double calculate(Order order);
}

// === Implementations ===
@ApplicationScoped @Premium
public class PremiumPricing implements PricingStrategy {
    @Override
    public double calculate(Order order) {
        return order.amount() * 1.1; // 10% premium markup
    }
}

@ApplicationScoped @Standard
public class StandardPricing implements PricingStrategy {
    @Override
    public double calculate(Order order) {
        return order.amount();
    }
}

// === Event ===
public record OrderProcessed(String orderId, double finalAmount) {}

// === Service ===
@ApplicationScoped
public class OrderService {

    @Inject @Premium
    PricingStrategy premiumPricing;

    @Inject @Standard
    PricingStrategy standardPricing;

    @Inject
    Event<OrderProcessed> orderProcessedEvent;

    @Logged
    public double process(Order order, boolean isPremium) {
        PricingStrategy strategy = isPremium ? premiumPricing : standardPricing;
        double finalAmount = strategy.calculate(order);
        orderProcessedEvent.fireAsync(new OrderProcessed(order.id(), finalAmount));
        return finalAmount;
    }
}

// === Observer ===
@ApplicationScoped
public class AuditService {
    public void onOrderProcessed(@ObservesAsync OrderProcessed event) {
        System.out.printf("[AUDIT] Order %s → %.2f%n",
            event.orderId(), event.finalAmount());
    }
}

// === Interceptor ===
@Logged @Interceptor @Priority(Interceptor.Priority.APPLICATION)
public class LoggingInterceptor {
    @AroundInvoke
    public Object log(InvocationContext ctx) throws Exception {
        System.out.println(">> " + ctx.getMethod().getName());
        Object result = ctx.proceed();
        System.out.println("<< " + ctx.getMethod().getName() + " = " + result);
        return result;
    }
}

// === REST Endpoint để test ===
@Path("/orders")
@Produces(MediaType.APPLICATION_JSON)
public class OrderResource {

    @Inject
    OrderService orderService;

    @POST
    @Path("/{id}/process")
    public Response processOrder(
            @PathParam("id") String id,
            @QueryParam("premium") @DefaultValue("false") boolean premium) {

        Order order = new Order(id, "Product-X", 100.0);
        double amount = orderService.process(order, premium);
        return Response.ok(Map.of("orderId", id, "amount", amount)).build();
    }
}
```

```bash
# Chạy và test
./mvnw quarkus:dev

# Standard pricing
curl -X POST "http://localhost:8080/orders/ORD-001/process?premium=false"
# → {"orderId":"ORD-001","amount":100.0}

# Premium pricing
curl -X POST "http://localhost:8080/orders/ORD-001/process?premium=true"
# → {"orderId":"ORD-001","amount":110.0}

# Kiểm tra log để thấy interceptor + async event
```

---

## 10. Architect Notes

**Dùng CDI khi:**
- Cần vendor portability (chạy trên bất kỳ Jakarta EE runtime)
- Design framework/library cần chạy trên nhiều runtime
- Team đã quen với Quarkus/Helidon

**Giữ Spring DI khi:**
- Spring ecosystem sâu (Spring Data, Spring Security, Spring Cloud)
- Team lớn, cần ecosystem phong phú hơn

**CDI mạnh hơn Spring ở:**
- `@Disposes` — lifecycle cleanup tự động
- Observer injection thêm param
- Build-time extension model (Quarkus ArC)
- Qualifier type-safety

**Spring mạnh hơn CDI ở:**
- `@ConditionalOn*` — conditional bean registration
- `@Profile` — environment-based beans  
- Auto-configuration ecosystem
- Actuator, test support phong phú hơn

---

*[[00-Overview]] | Next: [[02-Jakarta-REST]]*
