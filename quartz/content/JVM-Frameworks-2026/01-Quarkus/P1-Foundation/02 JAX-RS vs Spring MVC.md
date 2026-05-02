---
tags: [quarkus, jax-rs, rest, spring-comparison]
created: 2026-04-12
status: active
week: 1
phase: P1-Foundation
framework: quarkus
---

# JAX-RS vs Spring MVC

## 📌 One-liner
> JAX-RS là **Java standard** cho REST API (không phải Spring invention). Quarkus dùng RESTEasy Reactive implement JAX-RS — rất giống Spring MVC nhưng annotation names khác.

---

## 🆚 Annotation Mapping Nhanh

| Spring MVC | JAX-RS (Quarkus) | Ghi chú |
|------------|------------------|---------|
| `@RestController` | `@Path` | Kết hợp class-level path |
| `@GetMapping` | `@GET` | HTTP method annotation |
| `@PostMapping` | `@POST` | |
| `@PutMapping` | `@PUT` | |
| `@DeleteMapping` | `@DELETE` | |
| `@RequestBody` | `@RequestBody` (không cần!) | Auto-detect từ Content-Type |
| `@PathVariable` | `@PathParam` | |
| `@RequestParam` | `@QueryParam` | |
| `@RequestHeader` | `@HeaderParam` | |
| `@ResponseStatus` | Dùng `Response.status()` | |
| `@Produces` | `@Produces` | Giống nhau! |
| `@Consumes` | `@Consumes` | Giống nhau! |

---

## 💻 Code Side-by-Side

### Spring Boot Controller
```java
@RestController
@RequestMapping("/api/users")
public class UserController {

    @Autowired
    private UserService userService;

    @GetMapping
    public List<User> getAll() {
        return userService.findAll();
    }

    @GetMapping("/{id}")
    public ResponseEntity<User> getById(@PathVariable Long id) {
        return userService.findById(id)
            .map(ResponseEntity::ok)
            .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public User create(@RequestBody @Valid CreateUserRequest req) {
        return userService.create(req);
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        userService.delete(id);
    }
}
```

### Quarkus Resource (JAX-RS)
```java
@Path("/api/users")          // ← class-level path
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class UserResource {

    @Inject
    UserService userService;

    @GET                     // ← method-level HTTP verb
    public List<User> getAll() {
        return userService.findAll();
    }

    @GET
    @Path("/{id}")           // ← sub-path
    public Response getById(@PathParam("id") Long id) {
        return userService.findById(id)
            .map(user -> Response.ok(user).build())
            .orElse(Response.status(404).build());
    }

    @POST
    public Response create(@Valid CreateUserRequest req) {
        User created = userService.create(req);
        return Response.status(201).entity(created).build();
    }

    @DELETE
    @Path("/{id}")
    public Response delete(@PathParam("id") Long id) {
        userService.delete(id);
        return Response.noContent().build();
    }
}
```

---

## 🔧 Exception Handling

### Spring Boot
```java
@RestControllerAdvice
public class GlobalExceptionHandler {
    @ExceptionHandler(NotFoundException.class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    public ErrorResponse handleNotFound(NotFoundException ex) {
        return new ErrorResponse(ex.getMessage());
    }
}
```

### Quarkus
```java
// Option 1: @ServerExceptionMapper (JAX-RS standard)
public class GlobalExceptionMapper 
    implements ExceptionMapper<NotFoundException> {
    
    @Override
    public Response toResponse(NotFoundException ex) {
        return Response.status(404)
            .entity(new ErrorResponse(ex.getMessage()))
            .build();
    }
}

// Option 2: RESTEasy Reactive style (Quarkus-specific, cleaner)
public class ExceptionMappers {
    @ServerExceptionMapper
    public RestResponse<ErrorResponse> mapNotFound(NotFoundException ex) {
        return RestResponse.status(Response.Status.NOT_FOUND,
            new ErrorResponse(ex.getMessage()));
    }
}
```

---

## 🔧 Query Parameters & Filtering

```java
@GET
@Path("/search")
public List<User> search(
    @QueryParam("name") String name,           // ?name=Bach
    @QueryParam("page") @DefaultValue("0") int page,
    @QueryParam("size") @DefaultValue("20") int size,
    @HeaderParam("X-Tenant-ID") String tenantId  // Header
) {
    return userService.search(name, page, size, tenantId);
}
```

---

## 🧩 RESTEasy Reactive vs RESTEasy Classic

> [!info] Quarkus có 2 variants REST
> ```xml
> <!-- Classic (blocking) - giống Spring MVC blocking -->
> <dependency>
>     <groupId>io.quarkus</groupId>
>     <artifactId>quarkus-resteasy</artifactId>
> </dependency>
> 
> <!-- Reactive (recommended 2026) - non-blocking -->
> <dependency>
>     <groupId>io.quarkus</groupId>
>     <artifactId>quarkus-resteasy-reactive</artifactId>
> </dependency>
> ```
> **Recommendation**: Dùng `resteasy-reactive` cho project mới. Return `Uni<T>` cho endpoints cần async.

---

## ✅ Practice Checklist
- [ ] Tạo UserResource với đầy đủ CRUD endpoints
- [ ] Test bằng Dev UI (`/q/swagger-ui`)
- [ ] Thêm validation với `@Valid`
- [ ] Implement GlobalExceptionMapper
- [ ] So sánh response time blocking vs reactive endpoint

## 🔗 Liên quan
- [[01 CDI vs Spring IoC]] — DI layer
- [[03 Config & Dev Mode]] — tiếp theo
- [[P3-Reactive/02 RESTEasy Reactive]] — reactive version

## 📖 Nguồn
- https://quarkus.io/guides/rest
- https://quarkus.io/guides/resteasy-reactive
