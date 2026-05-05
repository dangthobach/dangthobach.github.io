# Helidon 2026 — Oracle's Strategic Framework

> **Cập nhật:** 2026-05 | **Backed by:** Oracle
> **Tags:** helidon, oracle, jakarta-ee, microprofile, JVP, cloud-native

---

## 1. Helidon Là Gì?

Helidon là Java microservice framework do Oracle phát triển, implement **Jakarta EE MicroProfile**. Có hai flavor:

```
Helidon SE  = Reactive, functional style
              → Không dùng CDI
              → Maximum control, minimum magic
              → Dùng Vert.x-like WebServer API

Helidon MP  = MicroProfile implementation
              → Dùng CDI, JAX-RS, JPA...
              → Familiar với Quarkus/WildFly developers
              → Production-grade enterprise
```

---

## 2. Helidon 4.4 (3/2026) — Chiến Lược Thay Đổi

### Java Verified Portfolio (JVP)

Oracle announce **JVP** — bộ JDK-related tools được Oracle validate và support chính thức. Helidon là một trong 3 thành phần launch đầu tiên (cùng JavaFX và Java Platform Extension for VS Code).

**Ý nghĩa:**
- Oracle commercial support cho Helidon
- Miễn phí cho Java SE Subscription customers và OCI customers
- Align release cadence với JDK roadmap
- Đề xuất Helidon trở thành **OpenJDK project**

### Versioning Model Thay Đổi

Từ JDK 27 (9/2026):
```
Cũ:  Helidon 4.4 (semantic versioning)
Mới: Helidon 27  (theo JDK version — "Tip and Tail" model)
```

### Features 4.4

- **Declarative APIs** — ít boilerplate hơn
- **Helidon JSON** — custom JSON processing
- **OpenTelemetry** metrics & logs
- **Rate limiting** built-in
- **AI / Agentic support:**
  - LangChain4j integration enhanced
  - MCP (Model Context Protocol) spec support
  - Agentic workflow support

---

## 3. So Sánh Helidon vs Quarkus

| Feature | Helidon MP | Quarkus |
|---|---|---|
| Backed by | Oracle | Red Hat (IBM) |
| Spec compliance | Jakarta EE + MicroProfile | Jakarta EE Core + MicroProfile |
| Dev Mode | Không có | ✅ Live reload, Dev UI |
| Native image | ✅ GraalVM | ✅ GraalVM (tốt hơn) |
| Community | Nhỏ | Lớn hơn nhiều |
| Extensions ecosystem | Hạn chế | 700+ extensions |
| Commercial support | Oracle JVP | Red Hat subscription |
| Cloud target | OCI (Oracle Cloud) | Multi-cloud |
| Build-time CDI | Không | ✅ ArC (mature) |
| Startup (JVM) | ~0.9s | ~0.8s |

---

## 4. Helidon Trong Bức Tranh Oracle Stack

```
Oracle Full Stack (cloud-native):
  JDK (OpenJDK)          ← Oracle develops
       ↓
  Helidon (framework)    ← Oracle develops, JVP certified
       ↓
  OCI (Oracle Cloud)     ← Oracle cloud platform
       ↓
  Oracle DB / MySQL      ← Oracle database

→ Helidon là "Spring Boot của Oracle Stack"
→ Cạnh tranh trực tiếp với Red Hat (Quarkus + OpenShift)
```

---

## 5. Helidon SE — Reactive Style

```java
// Helidon SE — không dùng CDI, functional style
WebServer server = WebServer.builder()
    .routing(r -> r
        .get("/documents/{id}", (req, res) -> {
            String id = req.path().pathParameters().get("id");
            res.send(fetchDocument(id));
        })
        .post("/documents", (req, res) -> {
            req.content().as(CreateDocumentRequest.class)
                .thenAccept(dto -> {
                    Document doc = service.create(dto);
                    res.status(Http.Status.CREATED_201).send(doc);
                });
        })
    )
    .build();

server.start().await();
```

---

## 6. Helidon MP — Jakarta EE Style

```java
// Helidon MP — familiar với Quarkus/Spring developers
@Path("/documents")
@ApplicationScoped
@Produces(MediaType.APPLICATION_JSON)
public class DocumentResource {

    @Inject DocumentService service;

    @GET @Path("/{id}")
    public Response getById(@PathParam("id") String id) {
        return service.findById(id)
            .map(doc -> Response.ok(doc).build())
            .orElse(Response.status(404).build());
    }

    @POST
    @Transactional
    public Response create(@Valid CreateDocumentRequest req) {
        Document doc = service.create(req);
        return Response.created(URI.create("/documents/" + doc.getId()))
            .entity(doc).build();
    }
}

// MicroProfile Config
@ApplicationScoped
public class PdmsConfig {
    @Inject @ConfigProperty(name = "pdms.tenant-id")
    private String tenantId;

    @Inject @ConfigProperty(name = "pdms.batch-size", defaultValue = "100")
    private int batchSize;
}

// MicroProfile Fault Tolerance
@ApplicationScoped
public class ExternalServiceClient {

    @Retry(maxRetries = 3, delay = 200, delayUnit = ChronoUnit.MILLIS)
    @Timeout(5000)
    @CircuitBreaker(requestVolumeThreshold = 10, failureRatio = 0.5)
    @Fallback(fallbackMethod = "fallbackResponse")
    public DocumentDTO fetchFromExternal(String id) {
        return externalClient.get(id);
    }

    public DocumentDTO fallbackResponse(String id) {
        return DocumentDTO.placeholder(id);
    }
}

// MicroProfile Health
@Liveness
@ApplicationScoped
public class DatabaseHealthCheck implements HealthCheck {
    @Inject DataSource ds;

    @Override
    public HealthCheckResponse call() {
        try (Connection c = ds.getConnection()) {
            c.isValid(1);
            return HealthCheckResponse.up("database");
        } catch (Exception e) {
            return HealthCheckResponse.down("database");
        }
    }
}
```

---

## 7. Khi Nào Nên Xem Xét Helidon?

**Nên theo dõi:**
- Team đang trên **Oracle Cloud Infrastructure (OCI)**
- Muốn Oracle commercial support + SLA
- Cần JVP certification cho procurement
- Dùng Oracle Database + Helidon → native integration tốt hơn

**Chưa cần:**
- Stack on-prem hoặc AWS/GCP → Quarkus có community tốt hơn nhiều
- Không có Oracle relationship → Red Hat Quarkus pragmatic hơn
- Greenfield project không đặc thù OCI → Spring Boot hoặc Quarkus

---

## 8. Verdict Cho PDMS Context

Helidon **không phải ưu tiên** cho PDMS hiện tại:
- Spring Boot stack đang ổn định
- VPBank không rõ ràng trên OCI
- Quarkus có ecosystem tốt hơn nếu muốn Jakarta EE runtime
- Helidon community quá nhỏ cho banking corner cases

**Watch list 2026:** Nếu Oracle đẩy Helidon thành OpenJDK project và community grow, re-evaluate năm 2027.

---

*Track: JVM-Frameworks-2026 | Related: [[Framework-Landscape-2026]], [[05-Jakarta-EE-12/00-Overview]]*
