---
tags: [micronaut, spring, cheatsheet, migration, reference, evergreen]
aliases: [spring-micronaut-mapping, micronaut-cheatsheet]
created: 2026-04-13
status: evergreen
---

# Spring Boot → Micronaut Cheatsheet

> Quick reference: Micronaut là framework gần Spring nhất — nhiều annotations tương đồng nhưng cơ chế bên dưới (compile-time) khác hoàn toàn.

---

## 1. Dependency Injection

| Spring Boot | Micronaut | Ghi chú |
|-------------|-----------|---------|
| `@Component` | `@Singleton` | Default singleton scope |
| `@Service` | `@Singleton` | Không có @Service semantic |
| `@Repository` | `@Singleton` | Micronaut Data tự handle |
| `@Controller` (MVC) | `@Controller` | Giống nhau ✅ nhưng khác import |
| `@Autowired` | `@Inject` hoặc constructor | Constructor preferred |
| `@Bean` + `@Configuration` | `@Bean` + `@Factory` | @Factory thay @Configuration |
| `@Scope("prototype")` | `@Prototype` | |
| `@RequestScope` | `@RequestScope` | Giống nhau ✅ |
| `@Qualifier("name")` | `@Named("name")` | Đơn giản hơn Spring |
| `@Primary` | `@Primary` | Giống nhau ✅ |
| `@ConditionalOnProperty` | `@Requires(property="k", value="v")` | |
| `@ConditionalOnClass` | `@Requires(classes=Foo.class)` | |
| `@ConditionalOnMissingBean` | `@Requires(missingBeans=Foo.class)` | |
| `@PostConstruct` | `@PostConstruct` | Giống nhau ✅ |
| `@PreDestroy` | `@PreDestroy` | Giống nhau ✅ |
| `ApplicationContext` | `ApplicationContext` | Micronaut có interface riêng |

```java
// Spring
@Configuration
public class AppConfig {
    @Bean
    public PaymentClient paymentClient() {
        return new PaymentClientImpl();
    }
}

// Micronaut
@Factory                                  // @Factory thay @Configuration
public class AppConfig {
    @Bean
    @Singleton
    public PaymentClient paymentClient() {
        return new PaymentClientImpl();
    }
}
```

---

## 2. REST / HTTP Layer

| Spring Boot | Micronaut | Ghi chú |
|-------------|-----------|---------|
| `@RestController` | `@Controller` | Micronaut @Controller đã include response body |
| `@RequestMapping("/path")` | `@Controller("/path")` | Path ở constructor annotation |
| `@GetMapping("/sub")` | `@Get("/sub")` | Ngắn hơn Spring |
| `@PostMapping` | `@Post` | |
| `@PutMapping` | `@Put` | |
| `@PatchMapping` | `@Patch` | |
| `@DeleteMapping` | `@Delete` | |
| `@PathVariable("id")` | `@PathVariable("id")` | Giống nhau ✅ |
| `@RequestParam("q")` | `@QueryValue("q")` | Tên khác |
| `@RequestHeader("X-Key")` | `@Header("X-Key")` | Tên khác |
| `@RequestBody` | `@Body` | Tên khác |
| `ResponseEntity<T>` | `HttpResponse<T>` | |
| `ResponseEntity.ok(body)` | `HttpResponse.ok(body)` | |
| `ResponseEntity.created(uri)` | `HttpResponse.created(body)` | |
| `@ResponseStatus(CREATED)` | `@Status(HttpStatus.CREATED)` | |
| `@RestControllerAdvice` | `@Error` method hoặc `ExceptionHandler` | |
| `@CrossOrigin` | `@ExecuteOn(IO)` | CORS qua config |
| `@Valid` | `@Valid` | Giống nhau ✅ |

```java
// Spring
@RestController
@RequestMapping("/api/docs")
public class DocController {
    @GetMapping("/{id}")
    public ResponseEntity<Doc> get(@PathVariable Long id,
                                   @RequestParam(required=false) String format) {
        return ResponseEntity.ok(service.find(id));
    }
}

// Micronaut — rất giống!
@Controller("/api/docs")
public class DocController {
    @Get("/{id}")
    public HttpResponse<Doc> get(@PathVariable Long id,
                                  @QueryValue @Nullable String format) {
        return HttpResponse.ok(service.find(id));
    }
}
```

---

## 3. Configuration

| Spring Boot | Micronaut | Ghi chú |
|-------------|-----------|---------|
| `application.yml` | `application.yml` | Micronaut ưu tiên YAML ✅ |
| `@Value("${key}")` | `@Value("${key}")` | Giống nhau ✅ |
| `@Value("${key:default}")` | `@Value("${key:default}")` | Giống nhau ✅ |
| `@ConfigurationProperties(prefix="app")` | `@ConfigurationProperties("app")` | Tương tự, nhưng là interface |
| `spring.profiles.active=dev` | `micronaut.environments=dev` | |
| `application-dev.yml` (file riêng) | `application-dev.yml` (file riêng) | Giống nhau ✅ |
| `@Profile("dev")` | `@Requires(env="dev")` | |

```yaml
# Spring application.yml
spring:
  datasource:
    url: jdbc:postgresql://localhost/db
app:
  payment:
    url: https://payment.api.com
    timeout: 30

# Micronaut application.yml — rất giống!
datasources:
  default:
    url: jdbc:postgresql://localhost/db
app:
  payment:
    url: https://payment.api.com
    timeout: 30
```

```java
// Spring
@ConfigurationProperties(prefix = "app.payment")
public class PaymentConfig {
    private String url;
    private int timeout;
    // getters + setters
}

// Micronaut — interface, không phải class!
@ConfigurationProperties("app.payment")
public interface PaymentConfig {
    String getUrl();        // hoặc url() với record-style
    int getTimeout();
}
```

---

## 4. HTTP Client — OpenFeign → @Client

Đây là điểm **Micronaut vượt trội hơn** Spring Cloud Feign rõ rệt.

| Spring Cloud Feign | Micronaut @Client | Ghi chú |
|-------------------|------------------|---------|
| `@FeignClient(name="svc")` | `@Client("https://svc.com")` hoặc `@Client(id="svc")` | Compile-time vs runtime proxy |
| `@GetMapping("/path")` | `@Get("/path")` | |
| `@PostMapping` | `@Post` | |
| `@RequestBody` | `@Body` | |
| `@PathVariable` | `@PathVariable` | Giống nhau ✅ |
| `@RequestParam` | `@QueryValue` | |
| `@RequestHeader` | `@Header` | |
| `FeignException` | `HttpClientResponseException` | |
| `@RetryableTopic` | `@Retryable(attempts="3")` | |
| Runtime proxy (reflection) | Compile-time bytecode | **Key difference** |
| Startup: chậm (proxy creation) | Startup: instant | |

```java
// Spring Feign
@FeignClient(name = "payment-service", url = "${payment.url}")
public interface PaymentClient {
    @PostMapping("/v1/charge")
    PaymentResponse charge(@RequestBody ChargeRequest req);

    @GetMapping("/v1/status/{id}")
    PaymentStatus getStatus(@PathVariable String id);
}

// Micronaut @Client — cú pháp gần như giống!
@Client("https://payment.api.vpbank.com")
@Retryable(attempts = "3", delay = "500ms")
public interface PaymentClient {
    @Post("/v1/charge")
    Single<PaymentResponse> charge(@Body ChargeRequest req);

    @Get("/v1/status/{id}")
    Maybe<PaymentStatus> getStatus(@PathVariable String id);
}
```

---

## 5. Data Access — Spring Data → Micronaut Data

| Spring Data JPA | Micronaut Data JPA | Ghi chú |
|-----------------|-------------------|---------|
| `extends JpaRepository<T,ID>` | `extends CrudRepository<T,ID>` | |
| `extends JpaRepository<T,ID>` | `extends JpaRepository<T,ID>` | Micronaut Data cũng có JpaRepository |
| Method name queries | Method name queries | Giống nhau ✅ (compile-time!) |
| `@Query("JPQL...")` | `@Query("JPQL...")` | Giống nhau ✅ |
| `@Transactional` | `@Transactional` | Giống nhau ✅ |
| Runtime proxy generation | Compile-time bytecode | **Key difference** |
| `Pageable` | `Pageable` | Giống nhau ✅ |
| `Page<T>` | `Page<T>` | Giống nhau ✅ |
| `@EntityGraph` | Không có | Dùng `@Join` |
| `@Modifying` + `@Query` | `@Query` với update | |

```java
// Spring Data
@Repository
public interface DocRepository extends JpaRepository<Document, Long> {
    List<Document> findByStatusAndTenantId(String status, Long tenantId);
    @Query("SELECT d FROM Document d WHERE d.createdAt > :date")
    List<Document> findRecentDocs(@Param("date") LocalDate date);
}

// Micronaut Data — gần như giống!
@Repository
public interface DocRepository extends CrudRepository<Document, Long> {
    List<Document> findByStatusAndTenantId(String status, Long tenantId);
    @Query("SELECT d FROM Document d WHERE d.createdAt > :date")
    List<Document> findRecentDocs(LocalDate date);   // @Param không cần
}
```

---

## 6. Kafka — Spring Kafka → Micronaut Kafka

| Spring Kafka | Micronaut Kafka | Ghi chú |
|-------------|----------------|---------|
| `@KafkaListener(topics="t")` | `@KafkaListener(groupId="g")` + `@Topic("t")` | Tách groupId và topic |
| `KafkaTemplate<K,V>.send()` | `@KafkaClient` interface | Declarative producer |
| `@Payload` | Không cần | Auto |
| `@Header` | `@KafkaKey` / `@Header` | |
| `Acknowledgment.acknowledge()` | Không cần với auto-ack | |
| `spring.kafka.*` | `kafka.*` | Property prefix khác |

```java
// Spring Kafka
@KafkaListener(topics = "doc-events", groupId = "pdms")
public void consume(@Payload DocEvent event) {
    process(event);
}

// Micronaut Kafka
@KafkaListener(groupId = "pdms")
public class DocEventListener {
    @Topic("doc-events")
    public void consume(DocEvent event) {
        process(event);
    }
}

// Producer: Spring
@Autowired KafkaTemplate<String, DocEvent> template;
template.send("doc-events", event);

// Producer: Micronaut — declarative!
@KafkaClient
public interface DocEventProducer {
    @Topic("doc-events")
    void send(@KafkaKey String key, DocEvent event);
}
```

---

## 7. Testing

| Spring | Micronaut | Ghi chú |
|--------|-----------|---------|
| `@SpringBootTest` | `@MicronautTest` | Micronaut khởi động < 1s |
| `@MockBean` | `@MockBean` | Giống nhau ✅ (Mockito) |
| `@Autowired` trong test | `@Inject` | |
| `TestRestTemplate` | `HttpClient` inject | |
| `MockMvc` | `HttpClient` + fluent API | |
| `@ActiveProfiles("test")` | `@MicronautTest(environments="test")` | |
| `@Transactional` (auto-rollback) | `@Transactional` | Giống nhau ✅ |

```java
// Spring
@SpringBootTest
class DocServiceTest {
    @Autowired DocService service;
    @MockBean DocRepository repo;
}

// Micronaut
@MicronautTest
class DocServiceTest {
    @Inject DocService service;
    @MockBean(DocRepository.class)
    DocRepository mockRepo() { return mock(DocRepository.class); }
}
```

---

## 8. application.yml — Key Mappings

```yaml
# ── DATASOURCE ────────────────────────────────────
# Spring
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/db
    username: user
    password: pass
  jpa:
    hibernate:
      ddl-auto: validate

# Micronaut
datasources:
  default:
    url: jdbc:postgresql://localhost:5432/db
    username: user
    password: pass
jpa:
  default:
    properties:
      hibernate:
        hbm2ddl:
          auto: validate

# ── SERVER ────────────────────────────────────────
# Spring
server:
  port: 8080

# Micronaut
micronaut:
  server:
    port: 8080

# ── KAFKA ─────────────────────────────────────────
# Spring
spring:
  kafka:
    bootstrap-servers: localhost:9092

# Micronaut
kafka:
  bootstrap:
    servers: localhost:9092
```

---

## 🔗 Liên quan
- [[Framework-Decision-Matrix]] — khi nào dùng Micronaut
- [[Spring-to-Quarkus-Cheatsheet]] — mapping sang Quarkus
- [[02-Micronaut/P1-Core/01 Compile-time DI vs Runtime DI|Micronaut: Compile-time DI]] — deep dive
- [[02-Micronaut/P2-Data/02 Declarative HTTP Client|Declarative HTTP Client]] — @Client deep dive
- [[concepts/compile-time-vs-runtime-di|Compile-time vs Runtime DI]] — concept note
