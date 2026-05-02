---
tags: [vertx, router, http-server, rest]
created: 2026-04-12
status: active
week: 17
phase: P2-HTTP
framework: vertx
---

# Router và Route Handlers

## 📌 One-liner
> Vert.x HTTP routing là **code-based** (không phải annotation-based như Spring MVC) — bạn build `Router` bằng Java code, đăng ký handlers cho từng route. Verbose hơn nhưng control hoàn toàn.

---

## 🆚 Spring MVC vs Vert.x Router

```java
// Spring MVC — annotation-driven
@RestController
@RequestMapping("/api/users")
public class UserController {
    @GetMapping("/{id}")
    public ResponseEntity<User> get(@PathVariable Long id) { ... }
}

// Vert.x — code-driven
Router router = Router.router(vertx);
router.get("/api/users/:id")
    .handler(ctx -> {
        String id = ctx.pathParam("id");
        // handle...
    });
```

---

## 💻 Full HTTP Server & Router Setup

```java
@ApplicationScoped
public class HttpServerVerticle extends AbstractVerticle {

    @Override
    public void start(Promise<Void> startPromise) {
        Router router = buildRouter();

        vertx.createHttpServer()
            .requestHandler(router)
            .listen(8080)
            .onSuccess(server -> {
                log.info("HTTP Server started on port {}", server.actualPort());
                startPromise.complete();
            })
            .onFailure(startPromise::fail);
    }

    private Router buildRouter() {
        Router router = Router.router(vertx);

        // Global middleware
        router.route().handler(BodyHandler.create());         // parse body
        router.route().handler(LoggerHandler.create());       // access log
        router.route().handler(CorsHandler.create()
            .allowedMethod(HttpMethod.GET)
            .allowedMethod(HttpMethod.POST)
            .allowedHeader("Content-Type")
            .allowedHeader("Authorization"));

        // JWT Auth (apply to specific routes)
        JWTAuthOptions jwtConfig = new JWTAuthOptions()
            .addPubSecKey(new PubSecKeyOptions().setAlgorithm("RS256")...);
        JWTAuth jwtAuth = JWTAuth.create(vertx, jwtConfig);
        JWTAuthHandler authHandler = JWTAuthHandler.create(jwtAuth);

        // Sub-router cho modularity
        router.mountSubRouter("/api/v1/users", userRouter());
        router.mountSubRouter("/api/v1/documents", documentRouter(authHandler));

        // Health check (no auth)
        router.get("/health").handler(ctx ->
            ctx.response().end(new JsonObject().put("status", "UP").encode()));

        // 404 handler
        router.errorHandler(404, ctx ->
            ctx.response().setStatusCode(404)
               .end(new JsonObject().put("error", "Not found").encode()));

        // Global error handler
        router.errorHandler(500, ctx -> {
            log.error("Unhandled error", ctx.failure());
            ctx.response().setStatusCode(500)
               .end(new JsonObject().put("error", "Internal server error").encode());
        });

        return router;
    }

    private Router userRouter() {
        Router router = Router.router(vertx);

        router.get("/").handler(this::getAllUsers);
        router.get("/:id").handler(this::getUserById);
        router.post("/").handler(this::createUser);
        router.put("/:id").handler(this::updateUser);
        router.delete("/:id").handler(this::deleteUser);

        return router;
    }

    private Router documentRouter(AuthenticationHandler auth) {
        Router router = Router.router(vertx);

        // Auth required for all document routes
        router.route().handler(auth);

        router.get("/").handler(this::getAllDocuments);
        router.post("/").handler(this::createDocument);

        return router;
    }
}
```

---

## 💻 Route Handlers — Request & Response

```java
// Handler đọc path param, query param, body
private void createDocument(RoutingContext ctx) {
    // Path param: /documents/:id
    String docId = ctx.pathParam("id");

    // Query param: ?status=active&page=0
    String status = ctx.queryParam("status").stream()
        .findFirst().orElse("all");
    int page = Integer.parseInt(ctx.queryParam("page")
        .stream().findFirst().orElse("0"));

    // Request headers
    String tenantId = ctx.request().getHeader("X-Tenant-ID");
    String bearerToken = ctx.request().getHeader("Authorization");

    // Request body (cần BodyHandler đã được mount)
    JsonObject body = ctx.body().asJsonObject();
    String title = body.getString("title");

    // === Response ===
    documentService.create(title, tenantId)
        .onSuccess(doc -> {
            ctx.response()
               .setStatusCode(201)
               .putHeader("Content-Type", "application/json")
               .end(JsonObject.mapFrom(doc).encode());
        })
        .onFailure(err -> {
            ctx.response()
               .setStatusCode(500)
               .end(new JsonObject()
                   .put("error", err.getMessage())
                   .encode());
        });
}
```

---

## 🔧 Middleware Chain

```java
// Handler chain: mỗi handler gọi ctx.next() để pass sang handler tiếp
router.route("/api/*")
    .handler(this::validateTenant)    // 1st: check tenant
    .handler(this::rateLimit)         // 2nd: rate limit
    .handler(this::authenticate)      // 3rd: JWT check
    .handler(this::handleRequest);    // 4th: actual logic

private void validateTenant(RoutingContext ctx) {
    String tenantId = ctx.request().getHeader("X-Tenant-ID");
    if (tenantId == null) {
        ctx.response().setStatusCode(400)
           .end("Missing X-Tenant-ID header");
        return;  // KHÔNG gọi ctx.next() → chain dừng
    }
    ctx.put("tenantId", tenantId);  // pass data sang handler tiếp
    ctx.next();  // ← tiếp tục chain
}

private void handleRequest(RoutingContext ctx) {
    String tenantId = ctx.get("tenantId");  // lấy từ handler trước
    // ...
}
```

---

## 🔧 Validation với Schema

```java
// Dùng Vert.x Web validation
SchemaRepository repo = SchemaRepository.create(new JsonSchemaOptions());
JsonSchema createUserSchema = JsonSchema.of(new JsonObject("""
    {
        "type": "object",
        "required": ["name", "email"],
        "properties": {
            "name": {"type": "string", "minLength": 1},
            "email": {"type": "string", "format": "email"}
        }
    }
    """));

router.post("/api/users")
    .handler(BodyHandler.create())
    .handler(ValidationHandler.builder(schemaRepo)
        .body(Bodies.json(createUserSchema))
        .build())
    .handler(this::createUser);
```

---

## ✅ Practice Checklist
- [ ] Tạo HTTP server với Router (không dùng annotation!)
- [ ] Implement CRUD handlers với path params, query params
- [ ] Chain middleware: logging → auth → rate limit → handler
- [ ] Mount sub-routers cho từng resource
- [ ] Implement global error handlers (404, 500)

## 🔗 Liên quan
- [[01 Event Loop và Verticles]]
- [[02 WebClient]]
- [[../../01-Quarkus/P1-Foundation/02 JAX-RS vs Spring MVC]]

## 📖 Nguồn
- https://vertx.io/docs/vertx-web/java/
