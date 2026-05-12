---
tags: [moc, architecture, design-patterns, clean-architecture, ddd]
---

# 🏛️ MOC — Architecture & Design Patterns

> **Mục tiêu:** Nắm vững các architectural patterns và design principles để đưa ra quyết định thiết kế đúng đắn — không phải học thuộc lý thuyết mà là biết *khi nào* apply pattern nào.

---

## 🧱 Architecture Styles

- [[Notion Knowledge/Note/Software Architecture Patterns|Software Architecture Patterns]]
  → Layered, Event-driven, Microservices, Serverless, Space-based. Trade-off matrix. Khi nào monolith vẫn đúng.
- [[Notion Knowledge/Note/Monolith vs Microservices vs Modular Monoliths- What's the Right Choice|Monolith vs Microservices vs Modular Monolith]]
  → Không phải "microservices luôn tốt hơn". Sam Newman's heuristics. Migration path.
- [[Notion Knowledge/Note/Clean Architecture 101- Building Software That Lasts|Clean Architecture 101]]
  → Dependency inversion, Ports & Adapters (Hexagonal). Domain layer không depend vào infrastructure. **Áp dụng trực tiếp vào PDMS service structure.**
- [[Notion Knowledge/Note/A Crash Course on Domain-Driven Design|DDD Crash Course]]
  → Bounded Context, Aggregate, Entity, Value Object, Domain Event. Strategic vs Tactical DDD.
- [[Notion Knowledge/Note/Domain-Driven Design (DDD) Demystified|DDD Demystified]]
  → Context Map, Ubiquitous Language, Anti-Corruption Layer. Khi nào DDD phù hợp (complex domain).
- [[Notion Knowledge/Note/A Crash Course on Cell-based Architecture|Cell-based Architecture]]
  → Horizontal isolation units. Each cell = self-contained stack. Blast radius isolation.

---

## 🔧 Design Principles

- [[Notion Knowledge/Note/What is the SOLID Principle|What is the SOLID Principle]]
  → SRP, OCP, LSP, ISP, DIP — với ví dụ Java/Spring cụ thể. Mỗi principle giải quyết vấn đề gì.
- [[Notion Knowledge/Note/Mastering OOP Fundamentals with SOLID Principles|Mastering OOP with SOLID]]
  → Refactoring examples. Khi nào SOLID dẫn đến over-engineering. Pragmatic approach.
- [[Notion Knowledge/Note/Coupling and Cohesion- The Two Principles for Effective Architecture]]
  → High cohesion + Low coupling = good architecture. Measuring coupling: afferent vs efferent. Package-level design.
- [[Notion Knowledge/Note/OOP Design Patterns and Anti-Patterns- What Works and What Fails|OOP Design Patterns & Anti-Patterns]]
  → GoF patterns trong Spring context. Anti-patterns: God Object, Anemic Domain Model, Service Locator.
- [[Notion Knowledge/Note/Tidying Code|Tidying Code]]
  → Kent Beck's approach: tidying vs refactoring. When to tidy, when to refactor. Small safe steps.

---

## ⚙️ Microservice Patterns (Catalog)

- [[Notion Knowledge/Note/A Crash Course on Microservices Design Patterns|Microservices Design Patterns Catalog]]
  → API Gateway, Sidecar, Service Mesh, Saga, CQRS, Event Sourcing, Outbox, Circuit Breaker, Bulkhead, Strangler Fig.
- [[Notion Knowledge/Note/A Pattern Every Modern Developer Should Know- CQRS|CQRS — Must-know Pattern]]
  → Command side (write) vs Query side (read). Event-driven CQRS. Eventual consistency trade-off.
- [[Notion Knowledge/Note/The Saga Pattern|The Saga Pattern]]
  → Choreography vs Orchestration. Compensating transactions. Saga state machine. **PDMS payment flow use case.**
- [[Notion Knowledge/Note/The Sidecar Pattern Explained- Decoupling Operational Features|Sidecar Pattern]]
  → Service Mesh sidecar (Envoy). Cross-cutting concerns: logging, tracing, auth. Istio architecture.
- [[Notion Knowledge/Note/Error Handling Patterns|Error Handling Patterns]]
  → Retry, Fallback, Circuit Breaker, Timeout, Bulkhead, Dead Letter Queue. Combining patterns.
- [[Notion Knowledge/Note/Event-Driven Architectural Patterns|Event-Driven Architectural Patterns]]
  → Event notification, Event-carried state transfer, Event sourcing, CQRS. Choreography vs Orchestration Saga.

---

## 🔐 Auth Patterns

- [[Notion Knowledge/Note/Mastering Modern Authentication- Cookies, Sessions, JWT, and PASETO|Modern Authentication Patterns]]
  → Cookie/Session (stateful) vs JWT (stateless). Refresh token rotation. PASETO advantages over JWT.
- [[Notion Knowledge/Note/JWT vs PASETO- The Two Players of Token-Based Authentication|JWT vs PASETO]]
  → JWT pitfalls (alg:none, key confusion). PASETO local vs public tokens. Migration strategy.
- [[Notion Knowledge/Note/EP176- How Does SSO Work|How SSO Works]]
  → SAML vs OAuth2+OIDC. SP-initiated vs IdP-initiated flow. Token exchange.
- [[Notion Knowledge/Note/Oauth2|OAuth2]]
  → Authorization Code Flow, PKCE, Client Credentials, Device Flow. Scope management. Refresh token.

---

## 📊 Case Studies — Architecture Decisions

- [[Notion Knowledge/Note/How Dropbox Built an AI Product Dash with RAG and AI Agents|Dropbox: RAG + AI Agents]]
  → Vector search, retrieval pipeline, agent orchestration. AI system design.
- [[Notion Knowledge/Note/How Grab Built An Authentication System for 180+ Million Users|Grab: Auth at 180M Users]]
  → Distributed session store, token revocation at scale, multi-region auth.
- [[Notion Knowledge/Note/How to avoid crawling duplicate URLs at Google scale|Google: URL Dedup at Scale]]
  → Bloom filters, consistent hashing, distributed crawl frontier. Probabilistic data structures.
- [[Notion Knowledge/Note/How Uber Eats Deduplicates Hundreds of Millions of Product Images|Uber Eats: Image Dedup]]
  → Perceptual hashing, LSH (Locality Sensitive Hashing), distributed pipeline.
- [[Notion Knowledge/Note/Why is a solid-state drive (SSD) fast|Why SSDs Are Fast]]
  → NAND flash, wear leveling, FTL (Flash Translation Layer). I/O model implications cho DB design.
- [[Notion Knowledge/Note/Why Executives Seem Out of Touch, and How to Reach Them|Why Executives Seem Out of Touch]]
  → Communication patterns với management. Translating technical decisions into business impact.

---

## 🔗 Liên kết

- [[MOC-Distributed-Systems]] — Patterns trong distributed context
- [[MOC-Database]] — Data architecture patterns
- [[MOC-Java]] — Spring implementation của các patterns
- [[MOC-PDMS]] — Applied patterns trong PDMS project

---

## 🆕 Microservice Patterns — Deep Knowledge Base
> Tổ chức 12/04/2026 — full code examples + PDMS context.

- [[Microservices-Patterns/00-Hub-Microservices-Patterns|🏗️ Hub — Tổng index]]
- [[Microservices-Patterns/Cheat-Sheet|⚡ Cheat Sheet — Quick Reference]]
- [[Microservices-Patterns/01-Data-Consistency|📦 Data & Consistency]] — DB-per-Service, Saga, CQRS, Event Sourcing
- [[Microservices-Patterns/02-Communication|📡 Communication]] — Outbox, API Gateway, Idempotent Consumer
- [[Microservices-Patterns/03-Reliability|🛡️ Reliability]] — Circuit Breaker, Service Discovery
- [[Microservices-Patterns/04-Observability|🔭 Observability]] — Distributed Tracing, Metrics, Logs
- [[Microservices-Patterns/05-Decomposition|✂️ Decomposition & Deployment]] — DDD, Strangler Fig, Container

---

## 🖥️ Frontend Architecture

- [[concepts/Frontend-Project-Architecture-2026|🏗️ Frontend Project Architecture 2026]]
  → So sánh FSD, Vertical Slice, Micro-Frontends, Layered. Decision tree chọn kiến trúc. Áp dụng cho React, Angular, SolidJS. Tooling và migration path.
