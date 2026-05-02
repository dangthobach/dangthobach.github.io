---
tags: [moc, api, rest, graphql, grpc, design]
---

# 📡 MOC — API Design & Protocols

> **Mục tiêu:** Hiểu toàn bộ API landscape — từ protocol selection đến design principles đến security. Áp dụng trực tiếp vào Spring Boot controllers và Axum handlers.

---

## 🔌 Protocol Selection

- [[Notion Knowledge/Note/API Protocols 101- A Guide to Choose the Right One|API Protocols 101]]
  → REST vs gRPC vs GraphQL vs WebSocket vs SSE. Decision matrix theo latency, payload size, streaming needs.
- [[Notion Knowledge/Note/SOAP vs REST vs GraphQL vs RPC|SOAP vs REST vs GraphQL vs RPC]]
  → Historical context + khi nào mỗi protocol phù hợp. gRPC = Protobuf + HTTP/2 = typed + streaming.
- [[Notion Knowledge/Note/Synchronous vs Asynchronous Communication- When to Use What|Sync vs Async Communication]]
  → REST/gRPC (sync) vs Kafka/AMQP (async). Khi nào mỗi loại. Timeout implications.

### REST
- [[Notion Knowledge/Note/Best Practices in API Design|API Design Best Practices]]
  → Resource naming, HTTP verbs semantics, status codes, versioning, pagination, filtering.
- [[Notion Knowledge/Note/Mastering the Art of API Design|Mastering API Design]]
  → Contract-first design. OpenAPI spec. Backward compatibility. Breaking vs non-breaking changes.
- [[Notion Knowledge/Note/The Art of REST API Design- Idempotency, Pagination, and Security|REST API Design: Idempotency, Pagination, Security]]
  → Idempotency keys cho POST. Cursor-based vs offset pagination. HTTPS, CORS, rate limiting.
- [[Notion Knowledge/Note/Mastering Idempotency- Building Reliable APIs|Mastering Idempotency]]
  → Implementation patterns: idempotency key header, database upsert, Redis dedup. **Critical cho payment APIs.**

### GraphQL
- [[Notion Knowledge/Note/A Crash Course in GraphQL|GraphQL Crash Course]]
  → Schema, Query, Mutation, Subscription. N+1 problem và DataLoader solution. SDL syntax.
- [[Notion Knowledge/Note/GraphQL 101- API Approach Beyond REST|GraphQL 101 — Beyond REST]]
  → Over-fetching vs under-fetching problem. Federation cho microservices. Khi nào GraphQL không phù hợp.

---

## 🔢 Versioning

- [[Notion Knowledge/Note/A Crash Course in API Versioning Strategies|API Versioning Strategies]]
  → URL versioning (`/v1/`), Header versioning, Query param versioning. Pros/cons. Sunset strategy.

---

## 🚪 API Gateway

- [[Notion Knowledge/Note/API Gateway|API Gateway — Fundamentals]]
  → Routing, authentication, rate limiting, SSL termination, request transformation. Kong, AWS API GW.
- [[Notion Knowledge/Note/API Gateway vs Service Mesh - Which One Do You Need|API Gateway vs Service Mesh]]
  → API Gateway = North-South (client→service). Service Mesh = East-West (service→service). Istio vs Kong.
- [[Notion Knowledge/Note/A Crash Course on Scaling the API Layer|Scaling the API Layer]]
  → Horizontal scaling, caching at gateway, request coalescing, response compression.

---

## 🔐 Security

- [[Notion Knowledge/Note/API Security Best Practices|API Security Best Practices]]
  → Auth (OAuth2/JWT/API Keys), authorization (RBAC/ABAC), input validation, rate limiting, HTTPS everywhere, secrets management.
- [[Notion Knowledge/Note/A Guide to Rate Limiting Strategies|Rate Limiting Strategies]]
  → Fixed window, Sliding window, Token bucket, Leaky bucket. Redis implementation. Per-user vs per-IP.

---

## 🔗 Liên kết

- [[MOC-Java]] — Spring MVC controllers, `@RestController`, Spring Security
- [[MOC-Distributed-Systems]] — Service communication patterns
- [[MOC-System-Design]] — API layer trong system architecture
- [[Rust-Zero-To-Hero/Bai-10-Axum-Core|Bài 10: Axum Core]] — Rust API implementation
- [[Rust-Zero-To-Hero/Bai-13-Serde-Reqwest-JWT|Bài 13: JWT]] — Rust auth implementation
