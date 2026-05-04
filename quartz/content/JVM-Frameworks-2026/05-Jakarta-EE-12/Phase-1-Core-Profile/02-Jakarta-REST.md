# 02 — Jakarta REST 5.0 (JAX-RS)

> **Spec:** Jakarta RESTful Web Services 5.0 | **Profile:** Core
> **Spring equivalent:** Spring MVC (`@RestController`, `@RequestMapping`)
> **Prototype runtime:** Quarkus + RESTEasy Reactive

---

## 1. Spec Says

Jakarta REST định nghĩa annotation-based API để build RESTful web services trên Java. Implementation phổ biến: **RESTEasy** (Quarkus/WildFly), **Jersey** (GlassFish/Helidon MP), **Apache CXF**.

Khác biệt triết lý với Spring MVC:
- JAX-RS: **resource class = POJO thuần**, framework tạo instance
- Spring MVC: **controller = Spring bean**, framework inject

---

## 2. Endpoint Mapping

```java
// === SPRING MVC ===
@RestController
@RequestMapping("/api/documents")
public class DocumentController {

    @GetMapping("/{id}")
    public ResponseEntity<DocumentDTO> getById(@PathVariable String id) {
        return ResponseEntity.ok(service.find(id));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public DocumentDTO create(@RequestBody @Valid CreateDocumentRequest req) {
        return service.create(req);
    }

    @GetMapping
    public Page<DocumentDTO> list(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        return service.findAll(PageRequest.of(page, size));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable String id) {
        service.delete(id);
    }
}

// === JAKARTA REST 5.0 ===
@Path("/api/documents")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class DocumentResource {

    @Inject
    DocumentService service;

    @GET
    @Path("/{id}")
    public Response getById(@PathParam("id") String id) {
        return Response.ok(service.find(id)).build();
    }

    @POST
    public Response create(@Valid CreateDocumentRequest req) {
        DocumentDTO doc = service.create(req);
        URI location = UriBuilder.fromResource(DocumentResource.class)
            .path("/{id}").build(doc.id());
        return Response.created(location).entity(doc).build();
    }

    @GET
    public Response list(
            @QueryParam("page") @DefaultValue("0") int page,
            @QueryParam("size") @DefaultValue("20") int size) {
        return Response.ok(service.findAll(page, size)).build();
    }

    @DELETE
    @Path("/{id}")
    public Response delete(@PathParam("id") String id) {
        service.delete(id);
        return Response.noContent().build();
    }
}
```

### Annotation Map

| Spring MVC | Jakarta REST |
|---|---|
| `@RestController` | `@Path` (class level) |
| `@RequestMapping("/path")` | `@Path("/path")` |
| `@GetMapping` | `@GET` |
| `@PostMapping` | `@POST` |
| `@PutMapping` | `@PUT` |
| `@DeleteMapping` | `@DELETE` |
| `@PatchMapping` | `@PATCH` |
| `@PathVariable` | `@PathParam` |
| `@RequestParam` | `@QueryParam` |
| `@RequestBody` | Method parameter (tự động) |
| `@RequestHeader` | `@HeaderParam` |
| `@CookieValue` | `@CookieParam` |
| `ResponseEntity<T>` | `Response` |
| `@ResponseStatus(CREATED)` | `Response.created(uri)` |
| `produces/consumes` | `@Produces/@Consumes` |

---

## 3. Response Building

```java
// === SPRING ===
return ResponseEntity
    .status(HttpStatus.PARTIAL_CONTENT)
    .header("X-Total-Count", "1000")
    .body(data);

// === JAKARTA REST ===
return Response
    .status(Response.Status.PARTIAL_CONTENT)
    .header("X-Total-Count", "1000")
    .entity(data)
    .build();

// Custom status code
return Response.status(206).entity(data).build();
```

---

## 4. Exception Handling

```java
// === SPRING ===
@ControllerAdvice
public class GlobalExceptionHandler {
    @ExceptionHandler(DocumentNotFoundException.class)
    public ResponseEntity<ErrorResponse> handleNotFound(DocumentNotFoundException ex) {
        return ResponseEntity.status(404)
            .body(new ErrorResponse(ex.getMessage()));
    }
}

// === JAKARTA REST ===
// Option 1: ExceptionMapper<T> — equivalent @ControllerAdvice
@Provider
public class DocumentNotFoundMapper
        implements ExceptionMapper<DocumentNotFoundException> {

    @Override
    public Response toResponse(DocumentNotFoundException ex) {
        return Response
            .status(Response.Status.NOT_FOUND)
            .entity(new ErrorResponse(ex.getMessage()))
            .build();
    }
}

// Option 2: Throw WebApplicationException trực tiếp
throw new WebApplicationException("Document not found", 404);
throw new NotFoundException("Document " + id + " not found");
```

---

## 5. Request Filter — Interceptor Chain

```java
// === SPRING ===
@Component
public class AuthFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest req,
            HttpServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        // pre-processing
        chain.doFilter(req, res);
        // post-processing
    }
}

// === JAKARTA REST ===
// ContainerRequestFilter — chạy TRƯỚC khi resource method được invoke
@Provider
@Priority(Priorities.AUTHENTICATION)
public class AuthFilter implements ContainerRequestFilter {

    @Override
    public void filter(ContainerRequestContext ctx) throws IOException {
        String token = ctx.getHeaderString("Authorization");
        if (token == null) {
            ctx.abortWith(Response.status(401).build()); // short-circuit
        }
    }
}

// ContainerResponseFilter — chạy SAU khi resource method trả về
@Provider
public class CorsFilter implements ContainerResponseFilter {

    @Override
    public void filter(ContainerRequestContext req,
                       ContainerResponseContext res) throws IOException {
        res.getHeaders().add("Access-Control-Allow-Origin", "*");
    }
}

// NameBinding — filter chỉ áp dụng cho endpoint có @Secured
@NameBinding
@Retention(RUNTIME)
@Target({TYPE, METHOD})
public @interface Secured {}

@Secured @Provider @Priority(Priorities.AUTHENTICATION)
public class SecuredFilter implements ContainerRequestFilter { ... }

@Path("/admin")
@Secured  // chỉ endpoint này mới chạy SecuredFilter
public class AdminResource { ... }
```

---

## 6. Client API — Gọi REST từ Java

```java
// === SPRING ===
// RestClient (Spring 6.1+)
RestClient client = RestClient.create();
DocumentDTO doc = client.get()
    .uri("http://service/documents/{id}", id)
    .retrieve()
    .body(DocumentDTO.class);

// === JAKARTA REST Client API ===
Client client = ClientBuilder.newClient();
WebTarget target = client.target("http://service")
    .path("/documents/{id}")
    .resolveTemplate("id", id);

DocumentDTO doc = target
    .request(MediaType.APPLICATION_JSON)
    .get(DocumentDTO.class);

// Với timeout
Client client = ClientBuilder.newBuilder()
    .connectTimeout(5, TimeUnit.SECONDS)
    .readTimeout(10, TimeUnit.SECONDS)
    .build();

// Cleanup
client.close(); // phải đóng
```

---

## 7. Jakarta REST 5.0 — Cái Mới

- **Server-Sent Events (SSE)** cải tiến
- **Multipart support** standardized (không còn provider-specific)
- Loại bỏ SecurityManager
- Cải thiện `@BeanParam` — gom nhiều param vào object

```java
// @BeanParam — gom param (JAX-RS 2.0+, phổ biến từ 5.0)
public class DocumentFilter {
    @QueryParam("status") String status;
    @QueryParam("page") @DefaultValue("0") int page;
    @QueryParam("size") @DefaultValue("20") int size;
    @HeaderParam("X-Tenant-Id") String tenantId;
}

@GET
public Response list(@BeanParam DocumentFilter filter) {
    // thay vì 4 @QueryParam riêng lẻ
    return Response.ok(service.find(filter)).build();
}
```

---

## 8. Prototype — Document API

```bash
mvn io.quarkus.platform:quarkus-maven-plugin:3.x.x:create \
    -DprojectArtifactId=jakarta-rest-lab \
    -Dextensions="rest,rest-jackson,hibernate-validator"
```

```java
// === Model ===
public record CreateDocumentRequest(
    @NotBlank String title,
    @NotBlank String type,
    @Size(max = 1000) String description
) {}

public record DocumentDTO(
    String id,
    String title,
    String type,
    String status,
    Instant createdAt
) {}

// === In-memory store để demo ===
@ApplicationScoped
public class DocumentStore {
    private final Map<String, DocumentDTO> store = new ConcurrentHashMap<>();

    public DocumentDTO save(CreateDocumentRequest req) {
        String id = UUID.randomUUID().toString();
        var doc = new DocumentDTO(id, req.title(), req.type(),
                                  "PENDING", Instant.now());
        store.put(id, doc);
        return doc;
    }

    public Optional<DocumentDTO> findById(String id) {
        return Optional.ofNullable(store.get(id));
    }

    public List<DocumentDTO> findAll(int page, int size) {
        return store.values().stream()
            .skip((long) page * size)
            .limit(size)
            .toList();
    }

    public void delete(String id) {
        store.remove(id);
    }
}

// === Resource ===
@Path("/api/documents")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class DocumentResource {

    @Inject DocumentStore store;

    @GET
    @Path("/{id}")
    public Response getById(@PathParam("id") String id) {
        return store.findById(id)
            .map(doc -> Response.ok(doc).build())
            .orElse(Response.status(404)
                .entity(Map.of("error", "Document not found: " + id))
                .build());
    }

    @POST
    public Response create(@Valid CreateDocumentRequest req) {
        DocumentDTO doc = store.save(req);
        URI location = UriBuilder.fromResource(DocumentResource.class)
            .path("/{id}").build(doc.id());
        return Response.created(location).entity(doc).build();
    }

    @GET
    public Response list(
            @QueryParam("page") @DefaultValue("0") int page,
            @QueryParam("size") @DefaultValue("20") int size) {
        List<DocumentDTO> docs = store.findAll(page, size);
        return Response.ok(docs)
            .header("X-Total-Count", store.findAll(0, Integer.MAX_VALUE).size())
            .build();
    }

    @DELETE
    @Path("/{id}")
    public Response delete(@PathParam("id") String id) {
        if (store.findById(id).isEmpty()) {
            return Response.status(404).build();
        }
        store.delete(id);
        return Response.noContent().build();
    }
}

// === Exception Mapper ===
@Provider
public class ValidationExceptionMapper
        implements ExceptionMapper<ConstraintViolationException> {

    @Override
    public Response toResponse(ConstraintViolationException ex) {
        List<Map<String, String>> errors = ex.getConstraintViolations()
            .stream()
            .map(v -> Map.of(
                "field", v.getPropertyPath().toString(),
                "message", v.getMessage()
            ))
            .toList();
        return Response.status(400)
            .entity(Map.of("errors", errors))
            .build();
    }
}

// === Logging Filter ===
@Provider @Priority(1)
public class RequestLoggingFilter implements ContainerRequestFilter {
    @Override
    public void filter(ContainerRequestContext ctx) {
        System.out.printf("[%s] %s%n",
            ctx.getMethod(), ctx.getUriInfo().getRequestUri());
    }
}
```

```bash
# Chạy
./mvnw quarkus:dev

# Test
curl -X POST http://localhost:8080/api/documents \
  -H "Content-Type: application/json" \
  -d '{"title":"PDMS Contract","type":"CONTRACT","description":"Test doc"}'

curl http://localhost:8080/api/documents

curl -X DELETE http://localhost:8080/api/documents/{id}

# Test validation error
curl -X POST http://localhost:8080/api/documents \
  -H "Content-Type: application/json" \
  -d '{"title":"","type":"CONTRACT"}'
```

---

## 9. Architect Notes

**JAX-RS mạnh hơn Spring MVC ở:**
- `ExceptionMapper<T>` clean hơn `@ControllerAdvice` (type-safe mapping)
- `@NameBinding` — filter targeting cụ thể endpoint
- `Response.created(uri)` — built-in URI builder
- `@BeanParam` — parameter grouping sạch hơn

**Spring MVC mạnh hơn JAX-RS ở:**
- `@RequestMapping` linh hoạt hơn (điều kiện phức tạp)
- `HttpMessageConverter` ecosystem phong phú
- `MockMvc` testing support tốt hơn
- `@MatrixVariable`, `@ModelAttribute` không có trong JAX-RS

---

*[[01-CDI-Contexts-DI]] | [[00-Overview]] | Next: [[03-JSON-P-JSON-B]]*
