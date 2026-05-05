# MicroProfile 2026 — Status & Relevance

> **Cập nhật:** 2026-05
> **Tags:** microprofile, quarkus, helidon, open-liberty, fault-tolerance, config, health

---

## 1. MicroProfile Là Gì?

MicroProfile là **specification** (không phải framework), sinh ra năm 2016 khi Oracle bỏ bê Java EE. Mục tiêu: chuẩn hóa các concern mà Java EE không cover cho microservices.

```
Java EE (2016):  Không có Config, Fault Tolerance, Health, JWT, Tracing...
                 → Oracle bỏ bê → community tạo MicroProfile

MicroProfile:    = "Java EE extension cho microservices"
                 → Spec, không phải implementation
                 → Eclipse Foundation quản lý
```

**Implementations:** Quarkus, Helidon MP, Open Liberty (IBM), WildFly, Payara, TomEE.

---

## 2. Triết Lý — "No Backward Compatibility"

```
Nguyên tắc cốt lõi:
  "experiment and innovate"
  "no backward compatibility guarantee"

→ Đây là FEATURE, không phải bug
→ MicroProfile = incubator cho Jakarta EE
→ Nếu spec thành công → merge vào Jakarta EE
→ Nếu có alternative tốt hơn → deprecated
```

---

## 3. Spec Status 2026

### Đang Mạnh ✅

| Spec | Version | Spring Equivalent | Note |
|---|---|---|---|
| MP Config | 3.x | `@ConfigurationProperties` | Chưa có thay thế tốt hơn |
| MP Fault Tolerance | 4.x | Resilience4J | Annotation-based, clean |
| MP Health | 4.x | Spring Actuator `/health` | Kubernetes standard |
| MP JWT Auth | 2.x | Spring Security OAuth2 | Banking auth flow |
| MP OpenAPI | 4.x | Springdoc/Swagger | API documentation |
| MP Rest Client | 4.x | RestClient / WebClient | Type-safe REST client |

### Đang Bị Thay Thế ⚠

| Spec | Status | Thay thế bởi |
|---|---|---|
| MP OpenTracing | ❌ Deprecated | **OpenTelemetry** (CNCF standard) |
| MP Metrics | ⚠ Thu nhỏ → MP Telemetry | **Micrometer + OTEL** |
| MP GraphQL | ⚠ Ít adoption | GraphQL Java trực tiếp |

**MicroProfile 7.1 (6/2025):** Update MP Telemetry 2.0 + MP OpenAPI.

---

## 4. Các Spec Quan Trọng — Chi Tiết

### MP Config

```java
// Inject config từ nhiều source: properties, env vars, K8s ConfigMap
@ApplicationScoped
public class PdmsConfig {

    @Inject @ConfigProperty(name = "pdms.tenant-id")
    String tenantId;

    @Inject @ConfigProperty(name = "pdms.batch-size", defaultValue = "100")
    int batchSize;

    @Inject @ConfigProperty(name = "pdms.timeout", defaultValue = "PT30S")
    Duration timeout;
}

// application.properties (cùng format với Spring Boot!)
pdms.tenant-id=vpbank
pdms.batch-size=200
```

### MP Fault Tolerance — So Sánh Với Resilience4J

```java
// === MicroProfile Fault Tolerance ===
@ApplicationScoped
public class DocumentClient {

    @Retry(maxRetries = 3,
           delay = 200, delayUnit = ChronoUnit.MILLIS,
           retryOn = {TimeoutException.class, ConnectException.class})
    @Timeout(5000)
    @CircuitBreaker(
        requestVolumeThreshold = 20,
        failureRatio = 0.5,
        delay = 10_000
    )
    @Bulkhead(value = 10, waitingTaskQueue = 100)
    @Fallback(fallbackMethod = "fallbackDocument")
    public DocumentDTO fetchDocument(String id) {
        return externalService.get(id);
    }

    public DocumentDTO fallbackDocument(String id) {
        return DocumentDTO.placeholder(id);
    }
}

// === Spring Boot / Resilience4J equivalent ===
@Service
public class DocumentClient {

    @Autowired Resilience4JCircuitBreakerFactory cbFactory;

    public DocumentDTO fetchDocument(String id) {
        CircuitBreaker cb = cbFactory.create("documentClient");
        return cb.run(
            () -> externalService.get(id),
            throwable -> DocumentDTO.placeholder(id)
        );
    }
}
```

**MP Fault Tolerance ưu điểm:** Annotation-based, khai báo ý định rõ ràng hơn, vendor-neutral.
**Resilience4J ưu điểm:** Programmatic control, metrics richer, Spring ecosystem.

### MP Health

```java
// MicroProfile Health → /health/live, /health/ready
@Liveness
@ApplicationScoped
public class AppLivenessCheck implements HealthCheck {
    @Override
    public HealthCheckResponse call() {
        return HealthCheckResponse.up("application");
    }
}

@Readiness
@ApplicationScoped
public class DatabaseReadinessCheck implements HealthCheck {
    @Inject DataSource ds;

    @Override
    public HealthCheckResponse call() {
        try (Connection c = ds.getConnection()) {
            boolean valid = c.isValid(2);
            return valid
                ? HealthCheckResponse.up("database")
                : HealthCheckResponse.down("database");
        } catch (Exception e) {
            return HealthCheckResponse.named("database")
                .down().withData("error", e.getMessage()).build();
        }
    }
}

// Spring Boot Actuator equivalent:
// management.endpoints.web.base-path=/health
// Implement HealthIndicator interface
```

### MP JWT Auth — Banking Relevant

```java
// Validate JWT từ Keycloak tự động
@Path("/documents")
@ApplicationScoped
@RolesAllowed("document:read")   // claim trong JWT
public class DocumentResource {

    @Inject JsonWebToken jwt;     // inject JWT token
    @Inject @Claim("tenant_id") String tenantId; // inject specific claim

    @GET @Path("/{id}")
    public Response get(@PathParam("id") String id) {
        // JWT đã được validate bởi MP JWT runtime
        String userId = jwt.getSubject();
        String issuer = jwt.getIssuer();
        Set<String> groups = jwt.getGroups(); // roles

        return service.findById(id, tenantId)
            .map(doc -> Response.ok(doc).build())
            .orElse(Response.status(404).build());
    }
}

// application.properties
// mp.jwt.verify.publickey.location=http://keycloak/realms/pdms/protocol/openid-connect/certs
// mp.jwt.verify.issuer=http://keycloak/realms/pdms
```

### MP OpenAPI

```java
// API Documentation tự động từ annotations
@Path("/documents")
@Tag(name = "Documents", description = "PDMS Document Management")
@SecurityRequirement(name = "bearerAuth")
public class DocumentResource {

    @GET @Path("/{id}")
    @Operation(summary = "Get document by ID")
    @APIResponse(responseCode = "200", description = "Document found",
        content = @Content(schema = @Schema(implementation = DocumentDTO.class)))
    @APIResponse(responseCode = "404", description = "Document not found")
    public Response getById(@PathParam("id") @Parameter(description = "Document ID") String id) {
        ...
    }
}
// → /openapi endpoint tự động sinh
// → /swagger-ui để view
```

---

## 5. MP Telemetry 2.0 — Thay MP Metrics

```java
// MP Metrics (cũ) — deprecated
@Counted(name = "documents.created", description = "...")
@Timed(name = "documents.create.time")
public DocumentDTO createDocument(CreateRequest req) { ... }

// MP Telemetry 2.0 (mới) — dùng OTEL API
@ApplicationScoped
public class DocumentService {

    private final Meter meter = GlobalOpenTelemetry.getMeter("pdms-document");
    private final Counter createCounter = meter
        .counterBuilder("documents.created").build();
    private final LongHistogram createTimer = meter
        .histogramBuilder("documents.create.duration")
        .ofLongs().setUnit("ms").build();

    public DocumentDTO createDocument(CreateRequest req) {
        long start = System.currentTimeMillis();
        try {
            DocumentDTO doc = doCreate(req);
            createCounter.add(1, Attributes.of(KEY_TENANT, req.tenantId()));
            return doc;
        } finally {
            createTimer.record(System.currentTimeMillis() - start);
        }
    }
}
```

---

## 6. Quarkus và MicroProfile

Quarkus implement MicroProfile nhưng có quan điểm diverge ở một số chỗ:

```
Quarkus theo MicroProfile:
  ✅ MP Config → quarkus-config
  ✅ MP Fault Tolerance → quarkus-smallrye-fault-tolerance
  ✅ MP Health → quarkus-smallrye-health
  ✅ MP JWT → quarkus-smallrye-jwt
  ✅ MP OpenAPI → quarkus-smallrye-openapi

Quarkus diverge từ MicroProfile:
  ⚠ MP Metrics → dùng Micrometer thay vì MP Metrics
     (Quarkus: "Micrometer + OTEL là approach tốt hơn")
  ⚠ MP OpenTracing → dùng OTEL trực tiếp (MP OpenTracing deprecated)
  ⚠ MP Rest Client → có REST Client riêng (better DX)
```

---

## 7. Với PDMS — Cần Học Sâu Không?

**Không cần** nếu stack là Spring Boot:
- Spring Boot đã có tương đương cho mọi MP spec
- Resilience4J > MP Fault Tolerance về tunability
- Spring Actuator > MP Health về features
- Spring Security OAuth2 > MP JWT về ecosystem

**Nên biết** để:
- Đọc Quarkus documentation (dùng MP annotations)
- Hiểu khi evaluate Quarkus cho service mới
- Biết `@Retry`, `@CircuitBreaker` để compare với Resilience4J
- Understand MP JWT để debug Keycloak integration trên Quarkus

**Học sâu** chỉ khi:
- Migrate sang Quarkus hoặc Helidon
- Compliance yêu cầu MicroProfile TCK certified implementation
- Cần cross-vendor portability (Spring → Quarkus → Open Liberty)

---

## 8. Spec Map — MicroProfile vs Spring Boot

| MicroProfile Spec | Spring Boot Equivalent |
|---|---|
| MP Config (`@ConfigProperty`) | `@ConfigurationProperties`, `@Value` |
| MP Fault Tolerance (`@Retry`, `@CircuitBreaker`) | Resilience4J annotations |
| MP Health (`@Liveness`, `@Readiness`) | Spring Actuator HealthIndicator |
| MP Metrics → MP Telemetry | Micrometer + Actuator |
| MP JWT (`@RolesAllowed`, `JsonWebToken`) | Spring Security OAuth2 Resource Server |
| MP OpenAPI (`@Operation`, `@Tag`) | Springdoc OpenAPI (`@Operation`, `@Tag`) |
| MP Rest Client (`@RegisterRestClient`) | `RestClient`, `WebClient` |
| MP OpenTracing | Spring + OpenTelemetry |

---

*Track: JVM-Frameworks-2026 | Related: [[Framework-Landscape-2026]], [[Helidon-2026]]*
*Xem Jakarta EE 12 series: [[05-Jakarta-EE-12/00-Overview]]*
