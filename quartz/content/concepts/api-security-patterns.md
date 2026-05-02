# API Security Patterns — Deep Dive

---
tags: [security, api, authentication, authorization, spring-boot, owasp]
created: 2026-05-02
difficulty: intermediate
estimated-read: 20 min
links: [[oauth2-oidc-deep-dive]], [[zero-trust-architecture]], [[opentelemetry-deep-dive]]

---

## 🎯 Learning Objectives

Sau bài này bạn sẽ:
- Nắm vững **OWASP API Security Top 10** và cách phòng thủ
- Implement **rate limiting**, **input validation**, **API versioning** đúng cách
- Thiết kế **secure API** cho banking context (PDMS)
- Biết cách **audit** và **monitor** API security events

---

## 🚨 OWASP API Security Top 10 (2023)

### API1: Broken Object Level Authorization (BOLA)

**Đây là #1 vì sao?** Rất phổ biến, dễ khai thác, hậu quả nghiêm trọng.

```
Attack:
  GET /api/documents/12345   ← User A's document
  GET /api/documents/12346   ← User B's document (A shouldn't see!)
  
  Attacker increment ID → access other users' data!
```

```java
// ❌ Vi phạm BOLA — chỉ check auth, không check ownership
@GetMapping("/documents/{id}")
public DocumentDTO getDocument(@PathVariable Long id,
                                @AuthenticationPrincipal JwtUser user) {
    return documentService.findById(id);  // Bất kỳ ai cũng lấy được!
}

// ✅ Enforce object-level authorization
@GetMapping("/documents/{id}")
public DocumentDTO getDocument(@PathVariable Long id,
                                @AuthenticationPrincipal JwtUser user) {
    Document doc = documentService.findById(id)
        .orElseThrow(() -> new ResourceNotFoundException("Document", id));
    
    // Check: user thuộc cùng tenant VÀ có permission
    if (!doc.getTenantId().equals(user.getTenantId())) {
        throw new AccessDeniedException("Access denied");
    }
    if (!permissionChecker.canRead(user, doc)) {
        throw new AccessDeniedException("Insufficient permissions");
    }
    
    return documentMapper.toDto(doc);
}

// Tốt hơn: tích hợp filter vào query
@Repository
public interface DocumentRepository extends JpaRepository<Document, Long> {
    // Query automatically filters by tenantId
    Optional<Document> findByIdAndTenantId(Long id, String tenantId);
}
```

---

### API2: Broken Authentication

```java
// ❌ Anti-patterns:
// - JWT secret = "secret123" hoặc hard-coded
// - Token không có expiry
// - Refresh token không rotate
// - Không validate issuer, audience

// ✅ Spring Security JWT Config
@Configuration
@EnableWebSecurity
public class SecurityConfig {
    
    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        return http
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt
                    .decoder(jwtDecoder())
                    .jwtAuthenticationConverter(jwtAuthConverter())
                )
            )
            .sessionManagement(session -> 
                session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .csrf(csrf -> csrf.disable())  // OK for stateless JWT API
            .build();
    }
    
    @Bean
    public JwtDecoder jwtDecoder() {
        // Validate với Keycloak JWKS endpoint — auto key rotation!
        return JwtDecoders.fromIssuerLocation("https://keycloak/realms/pdms");
        // Auto validates: signature, expiry, issuer ✓
    }
    
    @Bean
    public JwtAuthenticationConverter jwtAuthConverter() {
        JwtGrantedAuthoritiesConverter conv = new JwtGrantedAuthoritiesConverter();
        conv.setAuthoritiesClaimName("realm_access.roles");
        conv.setAuthorityPrefix("ROLE_");
        
        JwtAuthenticationConverter jwtConv = new JwtAuthenticationConverter();
        jwtConv.setJwtGrantedAuthoritiesConverter(conv);
        return jwtConv;
    }
}
```

---

### API3: Broken Object Property Level Authorization (Mass Assignment)

```java
// ❌ Mass Assignment attack
// Request body: {"title": "New", "approved": true, "tenantId": "OTHER"}
@PutMapping("/documents/{id}")
public DocumentDTO updateDocument(@PathVariable Long id,
                                   @RequestBody Document document) {  // ❌ Direct entity!
    document.setId(id);
    return documentRepository.save(document);  // Attacker changed tenantId!
}

// ✅ Use DTOs — only expose what clients should modify
public record UpdateDocumentRequest(
    @NotBlank @Size(max=500) String title,
    @Size(max=2000) String description,
    String category
    // Note: NO tenantId, status, approvedBy, approvedAt!
) {}

@PutMapping("/documents/{id}")
public DocumentDTO updateDocument(@PathVariable Long id,
                                   @Valid @RequestBody UpdateDocumentRequest request,
                                   @AuthenticationPrincipal JwtUser user) {
    return documentService.update(id, request, user.getTenantId());
}
```

---

### API4: Unrestricted Resource Consumption (Rate Limiting)

```java
// ✅ Rate limiting với Spring + Bucket4j (Redis-backed)

@Configuration
public class RateLimitConfig {
    
    @Bean
    public Filter rateLimitFilter(RedissonClient redisson) {
        return (req, res, chain) -> {
            HttpServletRequest request = (HttpServletRequest) req;
            
            String key = extractRateLimitKey(request);
            RBucket<RateLimitState> bucket = redisson.getBucket("ratelimit:" + key);
            
            // 100 requests per minute per user
            RateLimiter rateLimiter = RateLimiter.of(key,
                Bandwidth.classic(100, Refill.greedy(100, Duration.ofMinutes(1))));
            
            if (!rateLimiter.tryConsume(1)) {
                HttpServletResponse response = (HttpServletResponse) res;
                response.setStatus(429);  // Too Many Requests
                response.setHeader("Retry-After", "60");
                response.setHeader("X-RateLimit-Limit", "100");
                response.setHeader("X-RateLimit-Remaining", "0");
                return;
            }
            
            chain.doFilter(req, res);
        };
    }
    
    private String extractRateLimitKey(HttpServletRequest request) {
        // Rate limit by user ID (authenticated) or IP (unauthenticated)
        String userId = extractUserId(request);
        return userId != null ? "user:" + userId : "ip:" + getClientIp(request);
    }
}
```

**Rate limit tiers cho PDMS:**

```
Endpoint                    | Limit         | Window
────────────────────────────┼───────────────┼────────
GET /documents              | 1000/user     | 1 min
POST /documents             | 100/user      | 1 min
POST /documents/bulk-import | 10/user       | 1 hour
GET /reports/*              | 20/user       | 1 min
POST /auth/token            | 10/IP         | 1 min  ← Brute force protection
```

---

### API5: Broken Function Level Authorization (BFLA)

```java
// Admin endpoints phải được bảo vệ tốt

// ✅ Method-level security
@RestController
@RequestMapping("/api/v1/admin")
@PreAuthorize("hasRole('ADMIN')")  // Class-level default
public class AdminController {
    
    @GetMapping("/users")
    // Inherits class-level ADMIN requirement
    public List<UserDTO> listUsers() { ... }
    
    @DeleteMapping("/users/{id}")
    @PreAuthorize("hasRole('SUPER_ADMIN')")  // Override with stricter role
    @AuditLog(action = "DELETE_USER", sensitivity = HIGH)
    public void deleteUser(@PathVariable Long id) { ... }
    
    // Never expose internal admin APIs to internet!
    // Use NetworkPolicy to restrict to internal network only
}
```

---

### API8: Security Misconfiguration

```java
// ✅ Security headers

@Configuration
public class SecurityHeadersConfig {
    
    @Bean
    public SecurityFilterChain configure(HttpSecurity http) throws Exception {
        http.headers(headers -> headers
            // Prevent MIME type sniffing
            .contentTypeOptions(Customizer.withDefaults())
            // XSS protection
            .xssProtection(xss -> xss.headerValue(
                XXssProtectionHeaderWriter.HeaderValue.ENABLED_MODE_BLOCK))
            // Prevent clickjacking
            .frameOptions(frame -> frame.deny())
            // HSTS — HTTPS only
            .httpStrictTransportSecurity(hsts -> hsts
                .maxAgeInSeconds(31536000)
                .includeSubDomains(true)
            )
            // CSP
            .contentSecurityPolicy(csp -> csp
                .policyDirectives("default-src 'self'; script-src 'self'")
            )
        );
        return http.build();
    }
}
```

```yaml
# application.yml — không expose sensitive info
server:
  error:
    include-message: never         # Don't expose stack traces
    include-binding-errors: never
    include-stacktrace: never
    include-exception: false
    
management:
  endpoints:
    web:
      exposure:
        include: health, info, metrics  # Không include env, beans, mappings
  endpoint:
    health:
      show-details: when-authorized  # Chỉ show khi authenticated
```

---

## 🛡️ Input Validation — Defense in Depth

```java
// ✅ Comprehensive validation

public record CreateDocumentRequest(
    @NotBlank(message = "Title is required")
    @Size(min = 3, max = 500, message = "Title must be 3-500 chars")
    @Pattern(regexp = "^[\\p{L}\\p{N}\\s\\-_.,()]+$", 
             message = "Title contains invalid characters")
    String title,
    
    @Size(max = 5000)
    String description,
    
    @NotNull
    @Valid  // Cascade validation
    DocumentMetadata metadata,
    
    @NotNull
    DocumentType type
) {}

// Custom validator cho business rules
@Component
public class DocumentTypeValidator implements ConstraintValidator<ValidDocumentType, String> {
    private static final Set<String> VALID_TYPES = Set.of(
        "CONTRACT", "INVOICE", "REPORT", "MEMO", "LEGAL"
    );
    
    @Override
    public boolean isValid(String value, ConstraintValidatorContext context) {
        return value != null && VALID_TYPES.contains(value.toUpperCase());
    }
}

// Global exception handler — không leak nội tại
@RestControllerAdvice
public class SecurityAwareExceptionHandler {
    
    @ExceptionHandler(MethodArgumentNotValidException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public ErrorResponse handleValidation(MethodArgumentNotValidException ex) {
        List<String> errors = ex.getBindingResult().getFieldErrors().stream()
            .map(e -> e.getField() + ": " + e.getDefaultMessage())
            .collect(Collectors.toList());
        return new ErrorResponse("VALIDATION_ERROR", errors);
        // Note: không include stack trace, không include internal details
    }
    
    @ExceptionHandler(AccessDeniedException.class)
    @ResponseStatus(HttpStatus.FORBIDDEN)
    public ErrorResponse handleAccessDenied(AccessDeniedException ex) {
        // Log internally but return generic message to client
        log.warn("Access denied attempt - {}", SecurityContextHolder.getContext().getAuthentication());
        return new ErrorResponse("ACCESS_DENIED", "You don't have permission to perform this action");
    }
}
```

---

## 📊 API Audit Logging

```java
// Security-relevant events phải được audit log

@Aspect
@Component
@Slf4j
public class ApiAuditAspect {
    
    private final AuditEventRepository auditRepo;
    
    @AfterReturning(
        pointcut = "@annotation(auditLog)",
        returning = "result"
    )
    public void logApiAccess(JoinPoint joinPoint, AuditLog auditLog, Object result) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        
        AuditEvent event = AuditEvent.builder()
            .timestamp(Instant.now())
            .actor(auth.getName())
            .action(auditLog.action())
            .resource(extractResource(joinPoint))
            .outcome("SUCCESS")
            .ipAddress(getCurrentIp())
            .traceId(MDC.get("traceId"))  // OTel correlation
            .sensitivity(auditLog.sensitivity())
            .build();
        
        auditRepo.save(event);
        
        // High-sensitivity actions → immediate alert
        if (auditLog.sensitivity() == HIGH) {
            securityEventPublisher.publish(SecurityEvent.from(event));
        }
    }
}

// Usage:
@DeleteMapping("/documents/{id}")
@AuditLog(action = "DOCUMENT_DELETE", sensitivity = HIGH)
@PreAuthorize("hasRole('ADMIN')")
public void deleteDocument(@PathVariable Long id) { ... }
```

---

## 🔄 API Versioning — Security Transition

```java
// Versioning strategy quan trọng cho security migration

// URL versioning (recommended for breaking changes):
// /api/v1/documents — legacy
// /api/v2/documents — new security model

// Deprecation headers
@GetMapping("/api/v1/documents")
@Deprecated
public ResponseEntity<List<DocumentDTOv1>> listDocumentsV1() {
    return ResponseEntity.ok()
        .header("Deprecation", "true")
        .header("Sunset", "2026-06-01")  // When v1 will be removed
        .header("Link", "</api/v2/documents>; rel=\"successor-version\"")
        .body(documentService.findAllV1());
}
```

---

## 📚 Case Study — PDMS API Security Hardening

### Security Review Findings

```
Critical:
  [C1] /api/documents/{id} không check tenant isolation
  [C2] /api/admin/* exposed to internet (no network restriction)

High:
  [H1] No rate limiting → brute force possible
  [H2] Error messages expose table names và stack traces

Medium:  
  [M1] No security headers (missing HSTS, CSP, X-Frame-Options)
  [M2] JWT expiry = 8 hours (too long for banking)
  [M3] No audit log cho sensitive operations

Low:
  [L1] API không có versioning strategy
```

### Remediation Priority

```
Week 1 (Critical): 
  - Implement tenant isolation filter trong query layer
  - NetworkPolicy block admin endpoints từ internet
  
Week 2 (High):
  - Redis-backed rate limiting cho auth + write endpoints
  - Global exception handler → generic error messages
  
Week 3 (Medium):
  - Security headers configuration
  - JWT expiry = 1 hour + refresh token rotation
  - Audit log @Aspect cho document operations
  
Week 4 (Low):
  - API versioning framework
  - Deprecation notices cho v1 endpoints
```

---

## 🔑 Key Takeaways

1. **BOLA là #1 threat** — luôn check object ownership, không chỉ authentication
2. **DTOs, không entities** — ngăn mass assignment attacks
3. **Rate limiting** là must-have — bảo vệ cả brute force lẫn DDoS
4. **Validate sớm, fail fast** — input validation ở controller layer
5. **Generic error messages** cho client, detailed logs cho server
6. **Security headers** — HSTS, CSP, X-Frame-Options, X-Content-Type-Options
7. **Audit log** mọi sensitive operation với user identity và trace ID
8. **JWT expiry ngắn** (1h) + refresh token rotation cho banking context

---

## 🔗 Related Links

- [[oauth2-oidc-deep-dive]] — AuthN/AuthZ foundation
- [[zero-trust-architecture]] — System-level security posture
- [[opentelemetry-deep-dive]] — Trace ID correlation trong audit logs
- [OWASP API Security Top 10](https://owasp.org/API-Security/editions/2023/en/0x00-header/)
