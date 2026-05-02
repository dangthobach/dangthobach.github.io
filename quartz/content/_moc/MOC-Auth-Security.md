---
tags: [moc, auth, security, oauth, jwt, sso]
---

# 🔐 MOC — Auth & Security

> **Mục tiêu:** Hiểu toàn bộ auth landscape từ protocol tới implementation — áp dụng trực tiếp vào Spring Security và Axum middleware.

---

## 🎫 Token-based Authentication

- [[Notion Knowledge/Note/Mastering Modern Authentication- Cookies, Sessions, JWT, and PASETO|Modern Auth: Cookies → Sessions → JWT → PASETO]]
  → Evolution của auth. Stateful (session) vs Stateless (JWT). Refresh token rotation pattern. Khi nào dùng cái nào.
- [[Notion Knowledge/Note/JWT vs PASETO- The Two Players of Token-Based Authentication|JWT vs PASETO]]
  → JWT pitfalls: `alg:none` attack, weak HMAC vs RSA confusion. PASETO: algorithm agility removed by design. Migration path.

---

## 🔑 OAuth2 & SSO

- [[Notion Knowledge/Note/Oauth2|OAuth2 — Flows & Implementation]]
  → Authorization Code + PKCE (browser apps), Client Credentials (service-to-service), Device Flow (CLI). Token introspection. Revocation.
- [[Notion Knowledge/Note/EP176- How Does SSO Work|How SSO Works]]
  → SAML 2.0 vs OIDC. SP-initiated vs IdP-initiated. Token exchange. Enterprise SSO (Okta, Keycloak). **Relevant nếu PDMS cần SSO với VPBank IAM.**

---

## 🛡️ API Security

- [[Notion Knowledge/Note/API Security Best Practices|API Security Best Practices]]
  → Authentication (who are you?), Authorization (what can you do?), Input validation, Rate limiting, HTTPS, secrets rotation, OWASP API Top 10.
- [[Notion Knowledge/Note/A Guide to Rate Limiting Strategies|Rate Limiting Strategies]]
  → Fixed window (simple, burst problem), Sliding window (smoother), Token bucket (burst-friendly), Leaky bucket (smooth output). Redis implementation.

---

## 🔍 Fine-Grained Authorization & Cross-Service Filtering

- [[Microservices-Patterns/Cross-Service-Join-AuthZ-Fine-Grained-Filter|Cross-Service Join — AuthZ & Fine-Grained Filter at Scale]]
  → Khi AuthZ service giữ permission tables nhưng nhiều services cần JOIN để filter data (row-level security). 5 pattern: **CDC Replication**, **Permission Token**, **Local Cache+Kafka invalidation**, **Batch API Composition**, **Shared Read Replica**. Decision framework + PDMS hybrid architecture.

---

## 🗺️ Java/Spring Implementation Map

| Concept | Spring Security |
|---|---|
| JWT validation | `JwtAuthenticationFilter extends OncePerRequestFilter` |
| RBAC | `@PreAuthorize("hasRole('ADMIN')")` |
| ABAC | jCasbin, `@PreAuthorize("@permissionEvaluator.check(#id)")` |
| OAuth2 Resource Server | `http.oauth2ResourceServer(oauth2 -> oauth2.jwt(...))` |
| Rate limiting | Bucket4j + Spring, hoặc Spring Cloud Gateway RateLimiter |

## 🦀 Rust Implementation Map

| Concept | Axum |
|---|---|
| JWT validation | `from_fn(require_auth)` middleware, `jsonwebtoken` crate |
| RBAC | Custom extractor `AuthenticatedUser { role }` |
| Rate limiting | `tower_governor` crate hoặc custom middleware + Redis |

---

## 🔗 Liên kết

- [[MOC-Java]] — Spring Security configuration
- [[MOC-API-Design]] — Auth trong API design context
- [[MOC-PDMS]] — jCasbin RBAC/ABAC implementation
- [[MOC-Distributed-Systems]] — Cross-service authz propagation patterns
- [[Rust-Zero-To-Hero/Bai-13-Serde-Reqwest-JWT|Bài 13: JWT trong Rust]]
- [[Rust-Zero-To-Hero/Bai-11-Axum-Middleware-Error|Bài 11: Auth middleware Axum]]
