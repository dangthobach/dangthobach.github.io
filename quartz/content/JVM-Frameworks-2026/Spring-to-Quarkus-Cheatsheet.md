---
tags: [quarkus, spring, cheatsheet, migration, reference, evergreen]
aliases: [spring-quarkus-mapping, quarkus-cheatsheet]
created: 2026-04-13
status: evergreen
---

# Spring Boot → Quarkus Cheatsheet

> Quick reference: đổi annotation / class / config nào khi migrate từ Spring Boot sang Quarkus. Organized theo layer.

---

## 1. Dependency Injection

| Spring Boot | Quarkus (CDI / ArC) | Ghi chú |
|-------------|---------------------|---------|
| `@Component` | `@ApplicationScoped` | Proxy-backed, thread-safe |
| `@Service` | `@ApplicationScoped` | Không có @Service trong CDI |
| `@Repository` | `@ApplicationScoped` | Panache repo tự handle |
| `@Controller` | `@ApplicationScoped` | Logic tách khỏi @Path resource |
| `@Autowired` | `@Inject` | Constructor inject không cần annotation |
| `@Bean` (trong @Configuration) | `@Produces` | CDI producer method |
| `@Configuration` | Không cần | Dùng `@Produces` trực tiếp |
| `@Scope("prototype")` | `@Dependent` | Mỗi inject point = instance mới |
| `@RequestScope` | `@RequestScoped` | Jakarta EE annotation |
| `@SessionScope` | `@SessionScoped` | Jakarta EE annotation |
| `@Lazy` | `Instance<T>` inject | `instance.get()` khi cần |
| `@Primary` | `@Default` | Default bean khi có nhiều impl |
| `@Qualifier("name")` | Custom `@Qualifier` annotation | Phải tạo annotation riêng |
| `@ConditionalOnProperty` | `@IfBuildProperty` | Điều kiện tại build time |
| `@ConditionalOnClass` | `@IfBuildProperty` / `@Requires` | Quarkus dùng build profiles |
| `@PostConstruct` | `@PostConstruct` | Giống nhau ✅ |
| `@PreDestroy` | `@PreDestroy` | Giống nhau ✅ |

```java
// Spring
@Service
public class DocService {
    @Autowired private DocRepo repo;
}

// Quarkus
@ApplicationScoped
public class DocService {
    @Inject DocRepo repo;           // field inject
    // hoặc constructor inject (recommended, không cần @Inject)
}
```

---

## 2. REST / HTTP Layer

| Spring Boot | Quarkus (JAX-RS / RESTEasy) | Ghi chú |
|-------------|----------------------------|---------|
| `@RestController` | `@Path("/base")` trên class | JAX-RS standard |
| `@RequestMapping("/path")` | `@Path("/path")` | Đặt trên class |
| `@GetMapping("/sub")` | `@GET` + `@Path("/sub")` | Method-level |
| `@PostMapping` | `@POST` | |
| `@PutMapping` | `@PUT` | |
| `@PatchMapping` | `@PATCH` | |
| `@DeleteMapping` | `@DELETE` | |
| `@PathVariable("id")` | `@PathParam("id")` | |
| `@RequestParam("q")` | `@QueryParam("q")` | |
| `@RequestHeader("X-Key")` | `@HeaderParam("X-Key")` | |
| `@RequestBody` | Không cần annotation | Auto từ Content-Type |
| `@ResponseStatus(CREATED)` | `Response.status(201).build()` | Hoặc `RestResponse.created()` |
| `@ResponseBody` | Default trong JAX-RS | Không cần |
| `@CrossOrigin` | `quarkus.http.cors=true` + config | Trong application.properties |
| `ResponseEntity<T>` | `Response` hoặc `RestResponse<T>` | |
| `@RestControllerAdvice` | `@ServerExceptionMapper` | Đặt trên method hoặc class |
| `@ExceptionHandler(Ex.class)` | `@ServerExceptionMapper` method | JAX-RS ExceptionMapper |
| `@Valid` | `@Valid` | Giống nhau ✅ (Hibernate Validator) |

```java
// Spring
@RestController
@RequestMapping("/api/docs")
public class DocController {
    @GetMapping("/{id}")
    public ResponseEntity<Doc> get(@PathVariable Long id) {
        return ResponseEntity.ok(service.find(id));
    }
}

// Quarkus
@Path("/api/docs")
@Produces(MediaType.APPLICATION_JSON)
public class DocResource {
    @GET
    @Path("/{id}")
    public Response get(@PathParam("id") Long id) {
        return Response.ok(service.find(id)).build();
        // Hoặc return Doc trực tiếp — Quarkus tự 200 OK
    }
}
```

---

## 3. Configuration

| Spring Boot | Quarkus | Ghi chú |
|-------------|---------|---------|
| `application.yml` / `.properties` | `application.properties` | YAML cần extension |
| `@Value("${key}")` | `@ConfigProperty(name="key")` | |
| `@Value("${key:default}")` | `@ConfigProperty(name="key", defaultValue="val")` | |
| `@ConfigurationProperties(prefix="app")` | `@ConfigMapping(prefix="app")` | Interface, không phải class |
| `spring.profiles.active=dev` | `quarkus.profile=dev` hoặc `%dev.` prefix | |
| `application-dev.yml` (file riêng) | `%dev.key=value` (cùng file) | Gọn hơn Spring |
| `@Profile("dev")` | `@IfBuildProfile("dev")` | Build-time condition |
| `@PropertySource` | Không cần | Quarkus tự load theo convention |

```properties
# Spring: application-dev.properties (file riêng)
spring.datasource.url=jdbc:postgresql://localhost/dev_db

# Quarkus: application.properties (cùng một file, dùng prefix)
%dev.quarkus.datasource.jdbc.url=jdbc:postgresql://localhost/dev_db
%prod.quarkus.datasource.jdbc.url=${DATABASE_URL}
```

```java
// Spring
@Value("${app.payment.url}")
private String paymentUrl;

// Quarkus
@ConfigProperty(name = "app.payment.url")
String paymentUrl;

// Quarkus — Optional field
@ConfigProperty(name = "app.payment.timeout", defaultValue = "30")
int timeout;
```

---

## 4. Data Access — Spring Data JPA → Panache

| Spring Data JPA | Quarkus Panache | Ghi chú |
|-----------------|----------------|---------|
| `@Entity` | `@Entity` | Giống nhau ✅ |
| `@Table`, `@Column` | `@Table`, `@Column` | Giống nhau ✅ |
| `@Id`, `@GeneratedValue` | `@Id`, `@GeneratedValue` | Giống nhau ✅ |
| `@OneToMany`, `@ManyToOne` | `@OneToMany`, `@ManyToOne` | Giống nhau ✅ |
| `extends JpaRepository<T,ID>` | `implements PanacheRepository<T>` | Repository pattern |
| `extends JpaRepository<T,ID>` | `extends PanacheEntity` | Active Record pattern |
| `findById(id)` | `findById(id)` | Giống nhau ✅ |
| `findAll()` | `listAll()` | Tên khác |
| `save(entity)` | `entity.persist()` hoặc `repo.persist(e)` | |
| `delete(entity)` | `entity.delete()` hoặc `repo.delete(e)` | |
| `count()` | `count()` | Giống nhau ✅ |
| `findByEmail(String)` | `find("email", email).firstResult()` | Không dùng method name magic |
| `@Query("JPQL...")` | `find("... WHERE ...")` | Panache simplified HQL |
| `Pageable` | `query.page(index, size)` | |
| `Page<T>` | `PanacheQuery<T>` | |
| `@Transactional` | `@Transactional` (jakarta) | Package khác |

```java
// Spring Data
public interface DocRepo extends JpaRepository<Document, Long> {
    List<Document> findByStatusAndTenantId(String status, Long tenantId);
}

// Panache Repository
@ApplicationScoped
public class DocRepo implements PanacheRepository<Document> {
    public List<Document> findByStatusAndTenant(String status, Long tenantId) {
        return list("status = ?1 AND tenantId = ?2", status, tenantId);
    }
}

// Panache Active Record (Entity tự query)
@Entity
public class Document extends PanacheEntity {
    public String status;
    public Long tenantId;

    public static List<Document> findByStatusAndTenant(String status, Long tenantId) {
        return list("status = ?1 AND tenantId = ?2", status, tenantId);
    }
}
```

---

## 5. Transactions

| Spring | Quarkus | Ghi chú |
|--------|---------|---------|
| `@Transactional` (spring) | `@Transactional` (jakarta) | Import package khác! |
| `Propagation.REQUIRED` | `TxType.REQUIRED` | Default — giống nhau |
| `Propagation.REQUIRES_NEW` | `TxType.REQUIRES_NEW` | |
| `Propagation.SUPPORTS` | `TxType.SUPPORTS` | |
| `readOnly = true` | `TxType.SUPPORTS` | Không có readOnly trực tiếp |
| `rollbackFor = Exception.class` | `rollbackOn = Exception.class` | |
| `noRollbackFor = BizEx.class` | `dontRollbackOn = BizEx.class` | |
| `@Transactional` trên test | `@TestTransaction` | Auto-rollback sau mỗi test |

```java
// Spring
import org.springframework.transaction.annotation.Transactional;
@Transactional(propagation = Propagation.REQUIRES_NEW, rollbackFor = Exception.class)

// Quarkus
import jakarta.transaction.Transactional;
@Transactional(value = TxType.REQUIRES_NEW, rollbackOn = Exception.class)
```

---

## 6. Messaging — Spring Kafka → SmallRye

| Spring Kafka | Quarkus SmallRye | Ghi chú |
|-------------|------------------|---------|
| `@KafkaListener(topics="t")` | `@Incoming("channel-name")` | Channel → topic mapping trong config |
| `KafkaTemplate.send(topic, value)` | `@Inject @Channel("ch") Emitter<T>` | Declarative producer |
| `@EnableKafka` | Không cần | Auto-config |
| `spring.kafka.bootstrap-servers` | `kafka.bootstrap.servers` | |
| `spring.kafka.consumer.group-id` | `mp.messaging.incoming.ch.group.id` | Per-channel config |
| `@Payload` | Không cần | Auto |
| `Acknowledgment.acknowledge()` | `message.ack()` | Manual ack |
| `@RetryableTopic` | Failure strategy config | `mp.messaging.incoming.ch.failure-strategy` |
| `@DltHandler` | Dead letter queue config | `mp.messaging.incoming.ch.dead-letter-queue.topic` |

```java
// Spring Kafka
@KafkaListener(topics = "document-events", groupId = "pdms-group")
public void consume(@Payload DocumentEvent event,
                    Acknowledgment ack) {
    process(event);
    ack.acknowledge();
}

@Autowired KafkaTemplate<String, DocumentEvent> template;
template.send("document-events", event);

// Quarkus SmallRye
@Incoming("document-events")                    // channel name
public Uni<Void> consume(Message<DocumentEvent> msg) {
    return process(msg.getPayload())
        .onItem().transformToUni(v -> msg.ack());
}

@Inject @Channel("document-events-out")
Emitter<DocumentEvent> emitter;
emitter.send(event);
```

---

## 7. Validation

| Spring | Quarkus | Ghi chú |
|--------|---------|---------|
| `@Valid` | `@Valid` | Giống nhau ✅ |
| `@NotNull`, `@NotBlank` | `@NotNull`, `@NotBlank` | Giống nhau ✅ (Hibernate Validator) |
| `@Size`, `@Min`, `@Max` | `@Size`, `@Min`, `@Max` | Giống nhau ✅ |
| `@Pattern` | `@Pattern` | Giống nhau ✅ |
| `@Email` | `@Email` | Giống nhau ✅ |
| `BindingResult` | Không dùng — exception thrown tự động | JAX-RS throw `ConstraintViolationException` |
| `@Validated` trên class | `@Validated` | Giống nhau ✅ |

---

## 8. Security

| Spring Security | Quarkus Security | Ghi chú |
|----------------|-----------------|---------|
| `@EnableWebSecurity` | Không cần | Auto |
| `SecurityFilterChain` | `HttpAuthenticationMechanism` | Khác paradigm |
| `@PreAuthorize("hasRole('ADMIN')")` | `@RolesAllowed("ADMIN")` | Jakarta EE annotation |
| `@Secured("ROLE_USER")` | `@RolesAllowed("User")` | |
| `@AuthenticationPrincipal` | `@Context SecurityIdentity identity` | |
| `JwtAuthenticationConverter` | `@Claim` inject | MicroProfile JWT |
| `application.security.oauth2.*` | `quarkus.oidc.*` | |
| `UserDetails` | `SecurityIdentity` | Quarkus interface |

```java
// Spring Security
@PreAuthorize("hasRole('ADMIN')")
@GetMapping("/admin/users")
public List<User> adminGetAll() { ... }

// Quarkus
@GET
@Path("/admin/users")
@RolesAllowed("ADMIN")           // Jakarta Security
public List<User> adminGetAll() { ... }

// Inject current user
@Inject
SecurityIdentity identity;
String username = identity.getPrincipal().getName();
```

---

## 9. Testing

| Spring | Quarkus | Ghi chú |
|--------|---------|---------|
| `@SpringBootTest` | `@QuarkusTest` | Quarkus khởi động nhanh hơn ~5× |
| `@WebMvcTest` | `@QuarkusTest` + `@TestHTTPEndpoint` | |
| `@DataJpaTest` | `@QuarkusTest` (Dev Services lo DB) | |
| `@MockBean` | `@InjectMock` | `quarkus-junit5-mockito` |
| `MockMvc` | `RestAssured` (built-in) | |
| `@Transactional` trên test | `@TestTransaction` | Auto-rollback |
| `@ActiveProfiles("test")` | `%test.` prefix trong properties | |
| `TestRestTemplate` | `@TestHTTPResource` | Quarkus inject URL |
| `@AutoConfigureWireMock` | `@WireMockEndpoint` | Quarkus WireMock extension |

```java
// Spring
@SpringBootTest
class DocServiceTest {
    @Autowired DocService service;
    @MockBean DocRepo repo;

    @Test void shouldCreate() {
        when(repo.save(any())).thenReturn(new Document());
        assertNotNull(service.create(new CreateRequest()));
    }
}

// Quarkus
@QuarkusTest
class DocServiceTest {
    @Inject DocService service;
    @InjectMock DocRepo repo;

    @Test void shouldCreate() {
        when(repo.findById(any())).thenReturn(new Document());
        given().body(new CreateRequest()).contentType(JSON)
               .when().post("/api/docs")
               .then().statusCode(201);
    }
}
```

---

## 10. Observability

| Spring Boot Actuator | Quarkus | Path |
|---------------------|---------|------|
| `/actuator/health` | `/q/health` | Thêm `quarkus-smallrye-health` |
| `/actuator/health/liveness` | `/q/health/live` | |
| `/actuator/health/readiness` | `/q/health/ready` | |
| `/actuator/metrics` | `/q/metrics` | Thêm `quarkus-micrometer` |
| `/actuator/info` | `/q/info` | |
| `@HealthIndicator` | `implements HealthCheck` | `@Liveness` / `@Readiness` |
| `management.endpoints.web.*` | `quarkus.smallrye-health.*` | |
| Springdoc OpenAPI `/swagger-ui` | `/q/swagger-ui` | Thêm `quarkus-smallrye-openapi` |
| `@Operation`, `@Schema` | `@Operation`, `@Schema` | Giống nhau ✅ (SmallRye OpenAPI) |

---

## 11. Reactive — Spring WebFlux → Quarkus Mutiny

| Project Reactor | Mutiny (Quarkus) | Ghi chú |
|----------------|-----------------|---------|
| `Mono<T>` | `Uni<T>` | 0–1 async item |
| `Flux<T>` | `Multi<T>` | 0–N async stream |
| `.map()` | `.onItem().transform()` | |
| `.flatMap()` | `.onItem().transformToUni()` | |
| `.flatMapMany()` | `.onItem().transformToMulti()` | |
| `.filter()` | `.select().where()` | trên Multi |
| `.onErrorReturn(val)` | `.onFailure().recoverWithItem(val)` | |
| `.onErrorResume(fn)` | `.onFailure().recoverWithUni(fn)` | |
| `.retry(3)` | `.onFailure().retry().atMost(3)` | |
| `.subscribeOn(scheduler)` | `.runSubscriptionOn(executor)` | |
| `.publishOn(scheduler)` | `.emitOn(executor)` | |
| `Mono.zip(a, b)` | `Uni.combine().all().unis(a, b)` | |
| `Flux.merge(a, b)` | `Multi.createBy().merging().streams(a, b)` | |
| `.doOnNext()` | `.onItem().invoke()` | Side effect |
| `.doOnError()` | `.onFailure().invoke()` | Side effect |
| `.log()` | `.log()` | Giống nhau ✅ |
| `@Blocking` annotation | `@Blocking` | Giống nhau ✅ trong Quarkus |

---

## 12. application.properties — Key Mappings

```properties
# ── DATASOURCE ──────────────────────────────────────────
# Spring
spring.datasource.url=jdbc:postgresql://localhost:5432/db
spring.datasource.username=user
spring.datasource.password=pass
spring.jpa.hibernate.ddl-auto=validate

# Quarkus
quarkus.datasource.db-kind=postgresql
quarkus.datasource.jdbc.url=jdbc:postgresql://localhost:5432/db
quarkus.datasource.username=user
quarkus.datasource.password=pass
quarkus.hibernate-orm.database.generation=validate

# ── SERVER ───────────────────────────────────────────────
# Spring
server.port=8080
server.servlet.context-path=/api

# Quarkus
quarkus.http.port=8080
quarkus.http.root-path=/api

# ── LOGGING ──────────────────────────────────────────────
# Spring
logging.level.root=INFO
logging.level.com.example=DEBUG

# Quarkus
quarkus.log.level=INFO
quarkus.log.category."com.example".level=DEBUG

# ── KAFKA ────────────────────────────────────────────────
# Spring
spring.kafka.bootstrap-servers=localhost:9092
spring.kafka.consumer.group-id=my-group

# Quarkus
kafka.bootstrap.servers=localhost:9092
mp.messaging.incoming.my-channel.group.id=my-group

# ── FLYWAY ───────────────────────────────────────────────
# Spring
spring.flyway.enabled=true
spring.flyway.locations=classpath:db/migration

# Quarkus
quarkus.flyway.migrate-at-start=true
quarkus.flyway.locations=db/migration
```

---

## 🔗 Liên quan
- [[Framework-Decision-Matrix]] — khi nào dùng Quarkus
- [[Spring-to-Micronaut-Cheatsheet]] — mapping sang Micronaut
- [[01-Quarkus/P1-Foundation/01 CDI vs Spring IoC|CDI vs Spring IoC]] — DI deep dive
- [[01-Quarkus/P1-Foundation/02 JAX-RS vs Spring MVC|JAX-RS vs Spring MVC]] — HTTP deep dive
- [[01-Quarkus/P2-Data/01 Panache Active Record|Panache]] — Data deep dive
