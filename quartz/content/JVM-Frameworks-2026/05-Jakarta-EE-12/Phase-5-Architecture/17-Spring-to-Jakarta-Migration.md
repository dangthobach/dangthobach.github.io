# 17 — Spring → Jakarta EE Migration Path

> **Topic:** Lộ trình thực tế migrate từ Spring Boot → Jakarta EE runtime
> **Phase:** Architect Synthesis
> **Audience:** Spring Boot expert muốn evaluate Quarkus/Jakarta EE cho new service

---

## 1. Migration Strategy — Strangler Fig

```
KHÔNG nên: "Big bang" rewrite toàn bộ PDMS sang Jakarta EE
NÊN: Strangler Fig — từng service mới dùng Jakarta EE, service cũ giữ nguyên

Legacy Spring Boot services ──────────────────────────────┐
                                                          │
New Jakarta EE services (Quarkus) ────────────────────────┤
                                                          ▼
                                               API Gateway (Spring Cloud Gateway)
                                               ← nhận request, route đến đúng service
```

---

## 2. Annotation Migration — Quick Wins

### 2.1 Dependency Injection

```java
// BEFORE (Spring)
@Service
@RequiredArgsConstructor
public class DocumentService {
    private final DocumentRepository repo;
    private final AuditService auditService;
    private final ApplicationEventPublisher events;
}

// AFTER (Jakarta EE / Quarkus)
@ApplicationScoped
public class DocumentService {
    @Inject DocumentRepository repo;
    @Inject AuditService auditService;
    @Inject Event<DocumentCreated> events;
    // Hoặc constructor injection (preferred):
    // @Inject
    // public DocumentService(DocumentRepository repo, ...) { }
}
```

### 2.2 REST Controller

```java
// BEFORE (Spring MVC)
@RestController
@RequestMapping("/api/documents")
@RequiredArgsConstructor
public class DocumentController {
    private final DocumentService svc;

    @GetMapping("/{id}")
    public ResponseEntity<DocumentDTO> get(@PathVariable String id) {
        return ResponseEntity.ok(svc.find(id));
    }

    @PostMapping
    @ResponseStatus(CREATED)
    public DocumentDTO create(@Valid @RequestBody CreateDocumentRequest req) {
        return svc.create(req);
    }

    @ExceptionHandler(NotFoundException.class)
    @ResponseStatus(NOT_FOUND)
    public ErrorResponse handleNotFound(NotFoundException e) {
        return new ErrorResponse(e.getMessage());
    }
}

// AFTER (Jakarta REST)
@Path("/api/documents")
@Produces(APPLICATION_JSON)
@Consumes(APPLICATION_JSON)
@ApplicationScoped
public class DocumentResource {

    @Inject DocumentService svc;

    @GET @Path("/{id}")
    public Response get(@PathParam("id") String id) {
        return Response.ok(svc.find(id)).build();
    }

    @POST
    public Response create(@Valid CreateDocumentRequest req) {
        DocumentDTO dto = svc.create(req);
        URI uri = UriBuilder.fromResource(DocumentResource.class)
            .path("/{id}").build(dto.id());
        return Response.created(uri).entity(dto).build();
    }
}

@Provider
public class NotFoundMapper implements ExceptionMapper<NotFoundException> {
    @Override
    public Response toResponse(NotFoundException ex) {
        return Response.status(404)
            .entity(new ErrorResponse(ex.getMessage())).build();
    }
}
```

### 2.3 Repository

```java
// BEFORE (Spring Data JPA)
@Repository
public interface DocumentRepository extends JpaRepository<Document, String> {
    List<Document> findByTenantIdAndStatus(String tenantId, String status);
    Page<Document> findByTenantId(String tenantId, Pageable pageable);

    @Modifying
    @Query("UPDATE Document d SET d.status = :s WHERE d.id = :id")
    int updateStatus(@Param("id") String id, @Param("s") String s);
}

// AFTER (Jakarta Data 1.1)
@Repository
public interface DocumentRepository {
    @Find Optional<Document> findById(String id);
    @Save Document save(Document doc);
    @Delete void deleteById(String id);

    @Find List<Document> findByTenantIdAndStatus(String tenantId, String status);
    @Find Page<Document> findByTenantId(String tenantId, PageRequest pageRequest);

    @Query("UPDATE Document SET status = :s WHERE id = :id")
    int updateStatus(String id, String s);
}

// ⚠️ MIGRATION GOTCHA: Pageable (0-based) → PageRequest (1-based)
// Spring:  PageRequest.of(0, 20)  → first page
// Jakarta: PageRequest.ofPage(1).size(20) → first page
```

### 2.4 Configuration

```java
// BEFORE (Spring Boot)
@ConfigurationProperties(prefix = "pdms")
@Validated
public class PdmsConfig {
    @NotNull private String tenantId;
    private int batchSize = 100;
    private Duration timeout = Duration.ofSeconds(30);
}

// AFTER (MicroProfile Config via Quarkus)
@ApplicationScoped
public class PdmsConfig {
    @Inject
    @ConfigProperty(name = "pdms.tenant-id")
    String tenantId;

    @Inject
    @ConfigProperty(name = "pdms.batch-size", defaultValue = "100")
    int batchSize;

    @Inject
    @ConfigProperty(name = "pdms.timeout", defaultValue = "PT30S")
    Duration timeout;
}

// application.properties (same format as Spring Boot)
pdms.tenant-id=vpbank
pdms.batch-size=200
pdms.timeout=PT60S
```

### 2.5 Security

```java
// BEFORE (Spring Security)
@PreAuthorize("hasRole('DOCUMENT_READ')")
public DocumentDTO getDocument(String id) { ... }

@PreAuthorize("hasRole('DOCUMENT_WRITE') and #tenantId == authentication.name")
public DocumentDTO createDocument(CreateRequest req, String tenantId) { ... }

// AFTER (Jakarta Security + Quarkus OIDC)
@RolesAllowed("DOCUMENT_READ")
public DocumentDTO getDocument(String id) { ... }

// Complex authorization → business logic trong method
@RolesAllowed({"DOCUMENT_WRITE"})
public DocumentDTO createDocument(CreateRequest req, String tenantId) {
    // Tenant check in code (Jakarta không có SpEL)
    if (!securityContext.getCallerPrincipal().getName().equals(tenantId)) {
        throw new ForbiddenException("Cannot create for other tenant");
    }
    return svc.create(req, tenantId);
}
```

---

## 3. pom.xml Migration

```xml
<!-- BEFORE: Spring Boot -->
<parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.4.0</version>
</parent>

<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-security</artifactId>
    </dependency>
</dependencies>

<!-- AFTER: Quarkus -->
<properties>
    <quarkus.platform.version>3.x.x</quarkus.platform.version>
</properties>

<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>io.quarkus.platform</groupId>
            <artifactId>quarkus-bom</artifactId>
            <version>${quarkus.platform.version}</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>

<dependencies>
    <!-- REST = spring-boot-starter-web -->
    <dependency>
        <groupId>io.quarkus</groupId>
        <artifactId>quarkus-rest</artifactId>
    </dependency>
    <dependency>
        <groupId>io.quarkus</groupId>
        <artifactId>quarkus-rest-jackson</artifactId>
    </dependency>

    <!-- JPA = spring-boot-starter-data-jpa -->
    <dependency>
        <groupId>io.quarkus</groupId>
        <artifactId>quarkus-hibernate-orm</artifactId>
    </dependency>
    <dependency>
        <groupId>io.quarkus</groupId>
        <artifactId>quarkus-jdbc-postgresql</artifactId>
    </dependency>

    <!-- Security = spring-boot-starter-security + oauth2 -->
    <dependency>
        <groupId>io.quarkus</groupId>
        <artifactId>quarkus-oidc</artifactId>
    </dependency>

    <!-- Resilience = Resilience4J -->
    <dependency>
        <groupId>io.quarkus</groupId>
        <artifactId>quarkus-smallrye-fault-tolerance</artifactId>
    </dependency>

    <!-- Health = Spring Actuator -->
    <dependency>
        <groupId>io.quarkus</groupId>
        <artifactId>quarkus-smallrye-health</artifactId>
    </dependency>

    <!-- Metrics = Micrometer/Actuator -->
    <dependency>
        <groupId>io.quarkus</groupId>
        <artifactId>quarkus-micrometer</artifactId>
    </dependency>
</dependencies>
```

---

## 4. Application Properties Mapping

```properties
# === SPRING BOOT → QUARKUS property mapping ===

# Server
server.port=8080                          → quarkus.http.port=8080
server.servlet.context-path=/api          → quarkus.http.root-path=/api

# Datasource
spring.datasource.url=jdbc:postgresql:... → quarkus.datasource.jdbc.url=jdbc:postgresql:...
spring.datasource.username=user           → quarkus.datasource.username=user
spring.datasource.password=pass           → quarkus.datasource.password=pass
spring.datasource.driver-class-name=...  → quarkus.datasource.db-kind=postgresql

# JPA / Hibernate
spring.jpa.hibernate.ddl-auto=none        → quarkus.hibernate-orm.database.generation=none
spring.jpa.show-sql=true                  → quarkus.hibernate-orm.log.sql=true
spring.jpa.properties.hibernate.dialect=  → (auto-detected in Quarkus)

# Security / Keycloak
spring.security.oauth2.resourceserver...  → quarkus.oidc.auth-server-url=http://keycloak/realms/pdms
                                             quarkus.oidc.client-id=pdms-service

# Logging
logging.level.root=INFO                   → quarkus.log.level=INFO
logging.level.com.vpbank=DEBUG            → quarkus.log.category."com.vpbank".level=DEBUG

# Actuator → Health
management.endpoints.web.exposure.include → quarkus.smallrye-health.ui.enable=true
# /actuator/health → /q/health

# Profiles
spring.profiles.active=dev                → quarkus.profile=dev
# application-dev.properties             → application-dev.properties (same!)
```

---

## 5. Migration Checklist

```
Phase 1 — Preparation
□ Audit tất cả Spring-specific annotations đang dùng
□ Tách domain logic khỏi Spring annotations
□ Viết integration tests trước khi migrate
□ Quyết định target runtime: Quarkus / WildFly / Open Liberty

Phase 2 — Core Migration
□ Replace @Service → @ApplicationScoped
□ Replace @Autowired → @Inject
□ Replace @RestController + @RequestMapping → @Path + @GET/@POST...
□ Replace @PathVariable → @PathParam
□ Replace @RequestParam → @QueryParam
□ Replace @RequestBody → method parameter
□ Replace ResponseEntity → Response builder
□ Replace @ControllerAdvice → @Provider ExceptionMapper<E>

Phase 3 — Data Layer
□ Replace JpaRepository → Jakarta Data @Repository
□ Update Pageable → PageRequest (1-based!)
□ Replace @Modifying @Query → @Query (Jakarta Data)
□ Update @Transactional import từ Spring → Jakarta

Phase 4 — Security
□ Replace @PreAuthorize → @RolesAllowed
□ Replace SecurityContextHolder → @Inject SecurityContext
□ Replace Spring OIDC → quarkus-oidc extension
□ Complex authorization → extract vào service method

Phase 5 — Configuration & Infrastructure
□ Replace @ConfigurationProperties → @ConfigProperty
□ Replace @Scheduled → ManagedScheduledExecutorService
□ Replace @Async → @Asynchronous (CDI) hoặc executor
□ Replace Spring Actuator → SmallRye Health + Micrometer
□ Update properties file keys

Phase 6 — Validation
□ Chạy integration tests
□ Performance benchmarks
□ Security penetration test
□ Load test với production-like data
```

---

## 6. Không Nên Migrate Khi

```
❌ Hệ thống đang chạy ổn định, không cần cloud-native optimization
❌ Team chưa có Jakarta EE experience
❌ Timeline quá gấp
❌ Dùng nhiều Spring ecosystem (Spring Batch, Spring Integration,
   Spring Cloud Config, Spring Cloud Bus...)
❌ Cần Spring Data MongoDB / Redis ecosystem đặc thù

✅ Nên migrate khi:
- New service được build mới
- Cần startup time < 100ms (serverless)
- Cần memory footprint thấp (container cost)
- Team muốn vendor portability
- Compliance yêu cầu TCK-certified runtime
```

---

*[[16-Vendor-Neutral-Design]] | [[00-Overview]] | Series Complete ✅*
