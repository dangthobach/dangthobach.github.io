---
tags: [concepts, security, oauth2, oidc, jwt, keycloak, banking, evergreen]
created: 2026-05-02
difficulty: advanced
estimated-read: 25 min
links: [clean-architecture-hexagonal, ddd-strategic]
---

# 🔐 OAuth 2.0 & OIDC Deep Dive — Từ Protocol đến Keycloak Production

> **Mục tiêu:** Hiểu đúng OAuth2 không phải authentication (!) mà là authorization framework — và OIDC là layer authentication bên trên. Áp dụng trực tiếp vào PDMS IAM/Keycloak.

---

## 🎯 OAuth 2.0 vs OIDC — Nhầm lẫn phổ biến nhất

```
Câu hỏi: "Chúng tôi dùng OAuth2 để authenticate users"
→ SAI! OAuth2 là Authorization framework, không phải Authentication

OAuth 2.0:  "App X được phép làm GÌ thay mặt User Y?"
            → Trả về: Access Token (opaque or JWT)
            → Token mang: scopes (permissions)

OIDC:       "User Y là AI?"
            → Extension của OAuth2
            → Trả về: ID Token (always JWT)
            → Token mang: user identity (sub, email, name)

Analogy:
OAuth2 = Key card to enter building (authorization)
OIDC   = ID badge with photo (who you are)
```

---

## 🔄 OAuth 2.0 Flows — Chọn đúng flow cho đúng use case

### Flow 1: Authorization Code + PKCE (Browser Apps)

```
User Browser          App (Frontend)         Auth Server (Keycloak)   Resource Server
     │                      │                        │                       │
     │─── Click Login ──────►│                        │                       │
     │                       │                        │                       │
     │     1. Generate code_verifier (random string)  │                       │
     │     2. code_challenge = SHA256(code_verifier)  │                       │
     │                       │                        │                       │
     │                       │─── GET /authorize ─────►│                       │
     │                       │    ?response_type=code  │                       │
     │                       │    &client_id=pdms-web  │                       │
     │                       │    &redirect_uri=...    │                       │
     │                       │    &scope=openid profile│                       │
     │                       │    &code_challenge=...  │                       │
     │                       │    &state=random_csrf   │                       │
     │                       │                         │                       │
     │◄── Redirect to Login ─│◄── 302 Login Page ──────│                       │
     │─── Enter Credentials ─►─── POST /login ─────────►                      │
     │                        ◄── 302 + code=abc123 ───│                       │
     │                       │                         │                       │
     │                       │─── POST /token ─────────►│                       │
     │                       │    code=abc123           │                       │
     │                       │    code_verifier=...     │                       │
     │                       │◄── access_token+id_token─│                       │
     │                       │                         │                       │
     │                       │─── GET /api/documents ──────────────────────────►│
     │                       │    Authorization: Bearer access_token            │
     │                       │◄── 200 OK ─────────────────────────────────────│

PKCE (Proof Key for Code Exchange) prevents:
→ Authorization code interception attack
→ Man-in-the-middle stealing code in redirect URI
→ Required for public clients (SPAs, mobile apps) — no client secret!
```

### Flow 2: Client Credentials (Service-to-Service)

```
Service A                    Auth Server (Keycloak)        Service B
    │                              │                            │
    │─── POST /token ─────────────►│                            │
    │    grant_type=client_credentials                          │
    │    client_id=pdms-service-a                               │
    │    client_secret=secret123                                │
    │◄── access_token ────────────│                            │
    │                              │                            │
    │─── GET /api/documents ───────────────────────────────────►│
    │    Authorization: Bearer access_token                      │
    │◄── 200 OK ──────────────────────────────────────────────│

Use case: Microservice-to-microservice calls
No user involved!
Token cached and reused until expiry
```

```java
// Spring Boot: Client Credentials with webclient
@Bean
public WebClient serviceAWebClient(OAuth2AuthorizedClientManager manager) {
    return WebClient.builder()
        .apply(oauth2Client(manager))
        .baseUrl("http://pdms-service-b")
        .build();
}

// In Spring Security config:
@Bean
SecurityFilterChain clientSecurityConfig(HttpSecurity http) throws Exception {
    http.oauth2Client(oauth2 -> oauth2
        .clientRegistrationRepository(clientRegistrations())
    );
    return http.build();
}

// Usage: automatic token management
@Service
public class DocumentServiceClient {
    public Document getDocument(Long id) {
        return webClient.get()
            .uri("/documents/{id}", id)
            // Spring auto-adds Bearer token via filter
            .attributes(clientRegistrationId("pdms-service-a"))
            .retrieve()
            .bodyToMono(Document.class)
            .block();
    }
}
```

### Flow 3: Device Code (TV/CLI)

```
Use case: CLI tools, smart TVs (no browser redirect possible)
1. Device requests device_code + user_code from Auth Server
2. User goes to https://auth.example.com/device on another device
3. User enters user_code "ABCD-EFGH"
4. Device polls /token until user completes login
5. Device gets access_token
```

---

## 🎟️ JWT — Access Token Internals

```
JWT = Header.Payload.Signature (Base64URL encoded, dot-separated)

Header:
{
  "alg": "RS256",      // RSA signature (asymmetric)
  "typ": "JWT",
  "kid": "key-id-123"  // Key ID for rotation
}

Payload (Claims):
{
  "sub": "user-12345",              // Subject (user ID)
  "iss": "https://auth.vpbank.vn",  // Issuer
  "aud": "pdms-api",               // Audience (which API)
  "exp": 1746528000,               // Expiry (Unix timestamp)
  "iat": 1746524400,               // Issued at
  "jti": "unique-token-id",        // JWT ID (for revocation)

  // Custom claims (OIDC standard)
  "preferred_username": "nguyen.van.a",
  "email": "nguyen.van.a@vpbank.vn",

  // Keycloak-specific claims
  "realm_access": {
    "roles": ["employee", "document-approver"]
  },
  "resource_access": {
    "pdms-api": {
      "roles": ["ROLE_DOC_APPROVE", "ROLE_DOC_VIEW"]
    }
  },
  "branch_id": "HN001"             // Custom claim
}

Signature = RSSign(base64(header) + "." + base64(payload), privateKey)

Verification:
→ Download Keycloak's public key from /.well-known/jwks.json
→ Verify signature with public key (NO round-trip to auth server!)
→ Check exp, iss, aud claims
→ Extract roles from payload
```

### JWT Security Pitfalls

```java
// ❌ Pitfall 1: Not validating signature
String payload = new String(Base64.decode(jwt.split("\\.")[1]));
JSONObject claims = new JSONObject(payload);
// Anyone can forge claims without signature validation!

// ✅ Correct: Spring Security + JWKS
@Bean
JwtDecoder jwtDecoder() {
    return NimbusJwtDecoder
        .withJwkSetUri("https://auth.vpbank.vn/realms/vpbank/protocol/openid-connect/certs")
        .build();
    // Auto-downloads public keys, caches, validates signature + exp + iss
}

// ❌ Pitfall 2: Not checking audience
// Attacker has token for service-A, replays to service-B
// ✅ Always validate aud claim
http.oauth2ResourceServer(oauth2 -> oauth2
    .jwt(jwt -> jwt.jwtAuthenticationConverter(
        jwtConverter() // converts roles, validates aud
    ))
);

// ❌ Pitfall 3: Long expiry tokens
// access_token: exp = 7 days
// If token stolen: attacker has 7 days access, no revocation possible
// ✅ Short access token: 15-30 minutes
// ✅ Long refresh token: 8 hours (server-side revocable)
```

---

## 🔑 Token Refresh Flow

```
Client                          Auth Server
  │                                  │
  │─── API call with access_token ───►│
  │◄── 401 Unauthorized ─────────────│ (access_token expired)
  │                                  │
  │─── POST /token ──────────────────►│
  │    grant_type=refresh_token       │
  │    refresh_token=old_refresh      │
  │    client_id=pdms-web             │
  │                                  │
  │◄── new_access_token ─────────────│
  │    new_refresh_token (rotated!)   │
  │                                  │
  │─── Retry API call ───────────────►│

Refresh Token Rotation:
→ Each use of refresh_token → invalidate old, issue new
→ If old refresh_token used again → DETECT THEFT → revoke all tokens!
```

---

## 🏗️ Keycloak — PDMS Production Setup

### Realm & Client Configuration

```
VPBank Realm:
├── Clients
│   ├── pdms-web (public, browser flows)
│   │   ├── Access Type: public (no secret)
│   │   ├── Valid Redirect URIs: https://pdms.vpbank.vn/*
│   │   ├── Web Origins: https://pdms.vpbank.vn (CORS)
│   │   └── PKCE: required (S256)
│   │
│   ├── pdms-api (bearer-only resource server)
│   │   ├── Access Type: bearer-only
│   │   └── No redirect, just validates tokens
│   │
│   └── pdms-service (confidential, service-to-service)
│       ├── Access Type: confidential (has secret)
│       ├── Service Accounts: enabled
│       └── Client Credentials grant: enabled
│
├── Roles
│   ├── Realm Roles: employee, manager, admin
│   └── Client Roles (pdms-api):
│       ├── DOC_VIEW
│       ├── DOC_CREATE
│       ├── DOC_APPROVE
│       └── DOC_ARCHIVE
│
└── Users
    └── Attributes: branch_id, department_code (custom claims via Mapper)
```

### Spring Boot Resource Server Config

```java
// application.yml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://auth.vpbank.vn/realms/vpbank
          # Spring auto-discovers JWKS URI from issuer/.well-known/openid-configuration

// SecurityConfig.java
@Configuration
@EnableMethodSecurity
public class SecurityConfig {

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .sessionManagement(s -> s.sessionCreationPolicy(STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/actuator/health").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/documents/**")
                    .hasAuthority("SCOPE_pdms:read")
                .requestMatchers(HttpMethod.POST, "/api/documents/*/approve")
                    .hasRole("DOC_APPROVE")
                .anyRequest().authenticated()
            )
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt.jwtAuthenticationConverter(keycloakRoleConverter()))
            );
        return http.build();
    }

    @Bean
    JwtAuthenticationConverter keycloakRoleConverter() {
        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(jwt -> {
            // Extract Keycloak client roles from token
            Map<String, Object> resourceAccess =
                jwt.getClaimAsMap("resource_access");
            Map<String, Object> pdmsApi =
                (Map<String, Object>) resourceAccess.get("pdms-api");
            List<String> roles = (List<String>) pdmsApi.get("roles");

            return roles.stream()
                .map(r -> new SimpleGrantedAuthority("ROLE_" + r))
                .collect(Collectors.toList());
        });
        return converter;
    }
}

// Method-level security
@RestController
public class DocumentController {
    @PostMapping("/documents/{id}/approve")
    @PreAuthorize("hasRole('DOC_APPROVE') and @branchGuard.canApprove(#id, authentication)")
    public void approveDocument(@PathVariable Long id) { ... }
}
```

---

## 🔒 Token Validation — Offline vs Online

```
OFFLINE VALIDATION (JWT default):
→ Service validates JWT signature using public key (from JWKS)
→ No round-trip to Keycloak
→ Fast: just crypto operations
→ Problem: cannot revoke immediately (must wait for exp)

ONLINE VALIDATION (Token Introspection):
POST /realms/vpbank/protocol/openid-connect/token/introspect
Body: token=xxx, client_id=pdms-api, client_secret=xxx

Response: { "active": true/false, "scope": "...", "username": "..." }

→ Always fresh: revocation immediate
→ Slow: network round-trip per request
→ Use for: high-security operations (payment, admin actions)

HYBRID APPROACH (Recommended for PDMS):
→ Normal APIs: offline JWT validation (fast)
→ Critical APIs (approve, archive): online introspection or short JWT TTL (5min)
```

---

## 💡 Tips & Tricks

> **Tip 1 — JWKS caching**
> ```java
> // Spring auto-caches JWKS keys
> // But if Keycloak rotates keys → 401s until cache refreshes
> // Configure: jwks-cache-lifespan (default 5 minutes)
> spring.security.oauth2.resourceserver.jwt.jwk-set-cache-lifespan=5m
>
> // Monitor: key rotation in Keycloak should have overlap period
> // New key generated → old key still valid for 5 minutes → smooth rotation
> ```

> **Tip 2 — Avoid storing tokens in localStorage**
> ```
> ❌ localStorage: XSS vulnerable (JS can read it)
> ✅ httpOnly cookie: JS cannot access, CSRF protection needed
> ✅ Memory: lost on refresh, most secure but worse UX
>
> For PDMS internal tool: httpOnly cookie + CSRF token acceptable
> For mobile app: secure device storage (Keychain iOS, Keystore Android)
> ```

> **Tip 3 — Keycloak Performance**
> ```
> Keycloak DB (PostgreSQL) performance tips:
> - Tune connection pool: db.pool.min-size=20, max-size=100
> - Enable clustering for HA: Infinispan distributed cache
> - Separate Keycloak DB from app DB
> - JVM tuning: -Xms512m -Xmx2g for Keycloak JVM
> ```

> **Tip 4 — Scope vs Role**
> ```
> Scope: WHAT the client application can access (client-level)
>   "openid profile email" — standard OIDC scopes
>   "pdms:read pdms:write" — custom API scopes
>
> Role: WHO the user is (user-level)
>   "DOC_APPROVE", "BRANCH_MANAGER"
>
> Use scope for: API permissions, client capabilities
> Use role for: business authorization (who can do what)
> ```

---

## 🔬 Case Studies

### Case Study 1: PDMS Multi-Tenant IAM
```
PDMS serves multiple banks/branches:
Option A: Single Realm, different groups → simpler but coupled
Option B: Realm per organization → full isolation but more Keycloak management

PDMS approach (documented in PDMS-IAM-Multi-Domain-Design.md):
→ Single realm with tenant claim (branch_id) in token
→ Resource-level authorization checks branch_id in service
→ Keycloak User Attribute: branch_id = "HN001"
→ Token Mapper: branch_id → JWT claim
→ Service: @PreAuthorize("@tenantGuard.sameOrg(#docId, authentication)")
```

### Case Study 2: Zero-Downtime Token Key Rotation
```
Problem: Need to rotate JWT signing key without 401 errors

Keycloak key rotation (built-in):
1. Generate new RSA keypair in Keycloak (new kid)
2. Set new key as "Active" (signs new tokens)
3. Old key remains "Standby" (validates old tokens)
4. Old tokens expire naturally (based on access_token TTL)
5. After TTL period: old key can be removed safely

Services: download JWKS → finds both keys by kid → validates with correct key
→ Zero downtime key rotation
→ JWKS caching: services pick up new key within cache TTL (5min)
```

### Case Study 3: Service Account for PDMS Batch
```
PDMS batch job: ETL processing runs nightly
→ Not a user request → use Client Credentials flow

Setup in Keycloak:
1. Create client: pdms-batch-job (confidential)
2. Enable service accounts
3. Assign roles: DOC_BATCH_READ, DOC_BATCH_WRITE

Spring Batch job:
@Scheduled(cron = "0 0 2 * * *")
public void nightly() {
    // Fetch token using client credentials
    String token = oauth2Client.getToken("pdms-batch-job", "secret");
    // Use token for API calls
    documentApi.processBatch(token);
}

// Token caching: reuse until expiry - 30s buffer
// Token refresh: handled by OAuth2AuthorizedClientManager
```

---

## 📝 Key Takeaways

1. **OAuth2 = Authorization** (what you can do), **OIDC = Authentication** (who you are)
2. **Authorization Code + PKCE** = browser/mobile apps (no client secret)
3. **Client Credentials** = service-to-service (no user)
4. **JWT claims** = sub, iss, aud, exp, custom roles/attributes
5. **NEVER skip signature validation** — always use JWKS endpoint
6. **Short access token TTL** (15-30 min), **longer refresh token** (hours)
7. **Refresh Token Rotation** = detect token theft via reuse detection
8. **Offline validation** = fast (JWT), **Online introspection** = always fresh
9. **Keycloak roles** = in `resource_access.{client-id}.roles` claim
10. **httpOnly cookie** safer than localStorage for browser token storage

---

## 🔗 Liên kết

- [[Microservices-Patterns/PDMS-IAM-Multi-Domain-Design]] — PDMS multi-tenant IAM design
- [[Microservices-Patterns/PDMS-AuthZ-Fine-Grained-Design]] — Fine-grained authorization
- [[Microservices-Patterns/PDMS-AuthZ-Sync-Strategy-Comparison]] — AuthZ strategies
- [[concepts/zero-trust-architecture]] — Zero Trust with mTLS + JWT
- [[MOC-Auth-Security]] — Security overview
