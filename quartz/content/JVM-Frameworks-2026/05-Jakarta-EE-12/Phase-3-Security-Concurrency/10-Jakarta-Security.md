# 10 — Jakarta Security 4.x

> **Spec:** Jakarta Security 4.x | **Profile:** Web Profile
> **Spring equivalent:** Spring Security
> **Prototype runtime:** Quarkus + Keycloak (OIDC)

---

## 1. Spec Says

Jakarta Security định nghĩa authentication và authorization API cho Java EE web applications. Gồm 3 lớp:
- **Authentication** — xác thực identity (`HttpAuthenticationMechanism`)
- **Identity Store** — nơi lưu user/credential (`IdentityStore`)
- **Authorization** — kiểm tra quyền (`@RolesAllowed`, `SecurityContext`)

Quan trọng: Jakarta Security spec **không thay thế** Spring Security hay Keycloak — nó định nghĩa standard Java EE interface. Các implementation bên dưới vẫn có thể tích hợp Keycloak/OIDC.

---

## 2. Authorization Annotation Mapping

```java
// === SPRING SECURITY ===
@RestController
@RequestMapping("/api/admin")
@PreAuthorize("hasRole('ADMIN')")
public class AdminController {

    @GetMapping("/users")
    @PreAuthorize("hasRole('ADMIN') and hasAuthority('READ_USERS')")
    public List<UserDTO> getUsers() { ... }

    @PostMapping("/users")
    @PreAuthorize("hasRole('SUPER_ADMIN')")
    public UserDTO createUser(@RequestBody UserDTO dto) { ... }

    @GetMapping("/public")
    @PermitAll
    public String publicEndpoint() { return "Public"; }
}

// === JAKARTA SECURITY ===
@Path("/api/admin")
@RolesAllowed("ADMIN")      // class-level — tất cả method yêu cầu ADMIN
public class AdminResource {

    @GET
    @Path("/users")
    @RolesAllowed({"ADMIN", "MANAGER"})  // override class-level
    public List<UserDTO> getUsers() { ... }

    @POST
    @Path("/users")
    @RolesAllowed("SUPER_ADMIN")
    public Response createUser(UserDTO dto) { ... }

    @GET
    @Path("/public")
    @PermitAll              // tất cả đều access được
    public Response publicEndpoint() {
        return Response.ok("Public").build();
    }

    @DELETE
    @Path("/users/{id}")
    @DenyAll                // không ai access được (disabled)
    public Response deleteLocked(@PathParam("id") String id) { ... }
}
```

---

## 3. SecurityContext — Lấy Thông Tin User

```java
// === SPRING SECURITY ===
Authentication auth = SecurityContextHolder.getContext().getAuthentication();
String username = auth.getName();
boolean isAdmin = auth.getAuthorities().stream()
    .anyMatch(a -> a.getAuthority().equals("ROLE_ADMIN"));

// Inject trực tiếp
public ResponseEntity<?> getProfile(@AuthenticationPrincipal UserDetails user) {
    return ResponseEntity.ok(user.getUsername());
}

// === JAKARTA SECURITY ===
@Inject
SecurityContext securityContext;

// Trong resource method
public Response getProfile() {
    Principal principal = securityContext.getCallerPrincipal();
    String username = principal.getName();
    boolean isAdmin = securityContext.isCallerInRole("ADMIN");

    return Response.ok(Map.of("user", username, "isAdmin", isAdmin)).build();
}
```

---

## 4. HttpAuthenticationMechanism — Custom Auth

```java
// === SPRING SECURITY ===
@Component
public class CustomAuthFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest req,
            HttpServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        String token = req.getHeader("Authorization");
        // validate token, set SecurityContext
        SecurityContextHolder.getContext().setAuthentication(auth);
        chain.doFilter(req, res);
    }
}

// === JAKARTA SECURITY — HttpAuthenticationMechanism ===
@ApplicationScoped
public class JwtAuthMechanism implements HttpAuthenticationMechanism {

    @Inject
    IdentityStoreHandler identityStoreHandler;

    @Override
    public AuthenticationStatus validateRequest(
            HttpServletRequest req,
            HttpServletResponse res,
            HttpMessageContext ctx) throws AuthenticationException {

        String authHeader = req.getHeader("Authorization");

        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            return ctx.doNothing(); // tiếp tục filter chain
        }

        String token = authHeader.substring(7);

        try {
            // Validate JWT và extract claims
            Credential credential = new JwtTokenCredential(token);
            CredentialValidationResult result =
                identityStoreHandler.validate(credential);

            if (result.getStatus() == VALID) {
                return ctx.notifyContainerAboutLogin(
                    result.getCallerPrincipal(),
                    result.getCallerGroups()
                );
            }
        } catch (Exception e) {
            // invalid token
        }

        return ctx.responseUnauthorized();
    }
}
```

---

## 5. IdentityStore — User Store

```java
// === JAKARTA SECURITY IdentityStore ===
// Database-backed identity store
@ApplicationScoped
public class DatabaseIdentityStore implements IdentityStore {

    @Inject
    UserRepository userRepo;

    @Override
    public CredentialValidationResult validate(Credential credential) {
        if (!(credential instanceof UsernamePasswordCredential upc)) {
            return NOT_VALIDATED_RESULT;
        }

        return userRepo.findByUsername(upc.getCaller())
            .filter(user -> passwordMatches(upc.getPasswordAsString(), user.passwordHash()))
            .map(user -> new CredentialValidationResult(
                user.username(),
                new HashSet<>(user.roles())
            ))
            .orElse(INVALID_RESULT);
    }

    private boolean passwordMatches(String raw, String hash) {
        // BCrypt check
        return BCrypt.checkpw(raw, hash);
    }
}

// Built-in mechanism annotations — không cần code
@BasicAuthenticationMechanismDefinition(realmName = "pdms-realm")
@DatabaseIdentityStoreDefinition(
    dataSourceLookup = "java:comp/env/jdbc/pdms",
    callerQuery = "SELECT password FROM users WHERE username = ?",
    groupsQuery = "SELECT role FROM user_roles WHERE username = ?"
)
@ApplicationScoped
public class AppConfig { }
```

---

## 6. OIDC Integration (Keycloak) — Thực Tế Nhất

Trong thực tế enterprise (như PDMS với Keycloak), thường dùng OIDC implementation:

```java
// Quarkus với Keycloak OIDC
// application.properties:
// quarkus.oidc.auth-server-url=http://keycloak:8080/realms/pdms
// quarkus.oidc.client-id=pdms-service
// quarkus.oidc.credentials.secret=secret

@Path("/api/documents")
@Authenticated  // Quarkus annotation — yêu cầu OIDC token valid
public class DocumentResource {

    @Inject
    @IdToken
    JsonWebToken idToken;  // Quarkus inject JWT

    @Inject
    SecurityIdentity securityIdentity; // Quarkus SecurityIdentity

    @GET
    @Path("/my")
    public Response myDocuments() {
        String userId = idToken.getSubject();
        Set<String> roles = securityIdentity.getRoles();

        return Response.ok(Map.of(
            "userId", userId,
            "roles", roles
        )).build();
    }

    @GET
    @RolesAllowed("document:read") // Keycloak role
    public Response listAll() { ... }

    @POST
    @RolesAllowed({"document:write", "admin"})
    public Response create() { ... }
}
```

---

## 7. Prototype — Multi-Role API với In-Memory Auth

```bash
mvn io.quarkus.platform:quarkus-maven-plugin:3.x.x:create \
    -DprojectArtifactId=jakarta-security-lab \
    -Dextensions="rest,rest-jackson,security"
```

```java
// application.properties
// quarkus.http.auth.basic=true
// quarkus.security.users.embedded.enabled=true
// quarkus.security.users.embedded.plain-text=true
// quarkus.security.users.embedded.users.alice=alice123
// quarkus.security.users.embedded.users.bob=bob123
// quarkus.security.users.embedded.roles.alice=user,admin
// quarkus.security.users.embedded.roles.bob=user

@Path("/api")
@Produces(MediaType.APPLICATION_JSON)
public class SecuredResource {

    @Inject
    SecurityIdentity identity;

    @GET
    @Path("/public")
    @PermitAll
    public Map<String, String> publicEndpoint() {
        return Map.of("message", "Anyone can access this");
    }

    @GET
    @Path("/profile")
    @Authenticated
    public Map<String, Object> profile() {
        return Map.of(
            "user", identity.getPrincipal().getName(),
            "roles", identity.getRoles(),
            "isAdmin", identity.hasRole("admin")
        );
    }

    @GET
    @Path("/admin")
    @RolesAllowed("admin")
    public Map<String, String> adminOnly() {
        return Map.of(
            "message", "Admin area",
            "adminUser", identity.getPrincipal().getName()
        );
    }

    @GET
    @Path("/users-only")
    @RolesAllowed("user")
    public Map<String, String> usersOnly() {
        return Map.of("message", "For users");
    }
}
```

```bash
./mvnw quarkus:dev

# Public — no auth
curl http://localhost:8080/api/public

# Authenticated as alice (admin + user)
curl -u alice:alice123 http://localhost:8080/api/profile
curl -u alice:alice123 http://localhost:8080/api/admin   # ✅
curl -u alice:alice123 http://localhost:8080/api/users-only # ✅

# Authenticated as bob (user only)
curl -u bob:bob123 http://localhost:8080/api/admin      # 403 Forbidden
curl -u bob:bob123 http://localhost:8080/api/users-only  # ✅
```

---

## 8. Spring Security vs Jakarta Security

| Tính năng | Spring Security | Jakarta Security |
|---|---|---|
| Authorization annotation | `@PreAuthorize(SpEL)` | `@RolesAllowed(String[])` |
| Expression power | ✅ Full SpEL | ❌ String roles only |
| Method security | `@PreAuthorize`, `@PostFilter` | `@RolesAllowed` only |
| Custom auth mechanism | `AbstractAuthFilter` | `HttpAuthenticationMechanism` |
| Identity store | `UserDetailsService` | `IdentityStore` |
| Secure by default | ✅ Deny all | ❌ Permit all (phải annotate) |
| CSRF | ✅ Built-in | ❌ Manual |
| OAuth2/OIDC | ✅ Spring Security OAuth2 | ❌ MicroProfile JWT / vendor |
| WebFlux reactive | ✅ | ❌ |

**Kết luận:** Jakarta Security đơn giản và chuẩn hơn cho role-based basic auth. Spring Security mạnh hơn nhiều cho complex security scenarios.

---

## 9. Architect Notes

Với PDMS đang dùng Keycloak + Spring Security:
- `@RolesAllowed` tương đương `@PreAuthorize("hasRole('X')")` nhưng kém flexible hơn
- Nếu migrate sang Quarkus, dùng Quarkus OIDC extension — map `@RolesAllowed` với Keycloak roles dễ dàng
- jCasbin ABAC layer vẫn cần maintain riêng vì Jakarta Security không có ABAC spec

---

*[[09-Jakarta-NoSQL]] | [[00-Overview]] | Next: [[11-Jakarta-Concurrency]]*
