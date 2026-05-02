---
tags: [moc, case-studies, real-systems, engineering]
---

# 🏢 MOC — Case Studies (Real Systems)

> **Cách dùng MOC này:** Mỗi case study là **evidence** cho một architecture decision. Khi cần justify một pattern, tìm trong đây xem ai đã làm rồi và kết quả thế nào.

---

## 🗄️ Database & Data at Scale

| Company | Bài toán | Pattern dùng |
|---|---|---|
| Atlassian | Migrate 4M Jira DBs | Zero-downtime migration, Aurora |
| LinkedIn | 5M QPS restriction system | Consistent hashing, distributed cache |
| Uber Eats | Dedup 100M+ product images | Perceptual hashing, LSH |
| Google | URL dedup at crawler scale | Bloom filters, distributed frontier |

- [[Notion Knowledge/Note/How Atlassian Migrated 4 Million Jira Databases to AWS Aurora|Atlassian: 4M Jira DBs → Aurora]]
  → **Key insight:** Schema-first migration, dual-write period, cutover strategy. Relevant với PDMS data migration.
- [[Notion Knowledge/Note/How LinkedIn Scaled User Restriction System to 5 Million Queries Per Second|LinkedIn: 5M QPS Restriction]]
  → **Key insight:** Read path optimization via cache layers. Async invalidation. Eventual consistency acceptable cho restriction check.
- [[Notion Knowledge/Note/How Uber Eats Deduplicates Hundreds of Millions of Product Images|Uber Eats: Image Dedup]]
  → **Key insight:** Perceptual hash (pHash) + MinHash LSH. Approximate matching pipeline.
- [[Notion Knowledge/Note/How to avoid crawling duplicate URLs at Google scale|Google: URL Dedup at Crawler Scale]]
  → **Key insight:** Bloom filter (probabilistic, space-efficient). Fingerprinting. Distributed crawl frontier với consistent hashing.

---

## 📨 Messaging & Notifications at Scale

| Company | Scale | Approach |
|---|---|---|
| Slack | Billions of messages/day | Channel-based sharding, message fanout |
| Reddit | Tens of millions of users | Fan-out on write vs on read |

- [[Notion Knowledge/Note/How Slack Supports Billions of Daily Messages|Slack: Billions of Daily Messages]]
  → **Key insight:** Channel sharding. Presence system complexity. Message search với Elasticsearch. Workspace isolation.
- [[Notion Knowledge/Note/How Reddit Delivers Notifications to Tens of Millions of Users|Reddit: Notifications at Scale]]
  → **Key insight:** Fan-out on write (pre-compute) vs fan-out on read (compute on demand). Celebrity problem. Push vs pull notifications.

---

## 🔐 Auth & API at Scale

| Company | Scale | Approach |
|---|---|---|
| Grab | 180M users | Distributed session, multi-region |
| Tinder | 1B swipes/day | API Gateway, recommendation cache |

- [[Notion Knowledge/Note/How Grab Built An Authentication System for 180+ Million Users|Grab: Auth at 180M Users]]
  → **Key insight:** Token revocation at scale (distributed blacklist vs short-lived tokens). Multi-region auth failover.
- [[Notion Knowledge/Note/How Tinder's API Gateway Handles A Billion Swipes Per Day|Tinder: 1B Swipes/Day]]
  → **Key insight:** Recommendation pre-computation, gateway-level caching, request deduplication.

---

## 🤖 AI Systems

- [[Notion Knowledge/Note/How Dropbox Built an AI Product Dash with RAG and AI Agents|Dropbox: AI Dash — RAG + Agents]]
  → **Key insight:** RAG pipeline (embed → store → retrieve → augment → generate). Agent orchestration. Latency vs quality trade-off.

---

## 🛠️ Tech Stacks

- [[Notion Knowledge/Note/Shopify Tech Stack|Shopify Tech Stack]]
  → Rails monolith at massive scale, Kafka for async, Kubernetes, Cell-based architecture. **Counter-example: monolith works if well-structured.**
- [[Notion Knowledge/Note/EP177- The Modern Software Stack|The Modern Software Stack (2024)]]
  → Snapshot của tooling landscape: observability (Datadog/Grafana), data (dbt/Snowflake), deployment (K8s + ArgoCD), messaging (Kafka).

---

## 📐 Pattern → Case Study Map

| Pattern | Ai dùng |
|---|---|
| Consistent Hashing | LinkedIn (restriction), Google (URL frontier) |
| Bloom Filter | Google (URL dedup) |
| Fan-out on Write | Reddit (notifications) |
| Cell-based Architecture | Shopify |
| RAG | Dropbox |
| Zero-downtime Migration | Atlassian |
| Gateway-level Caching | Tinder |

---

## 🔗 Liên kết

- [[MOC-Distributed-Systems]] — Patterns được dùng trong case studies
- [[MOC-Database]] — DB patterns từ case studies
- [[MOC-Scalability]] — Scaling patterns từ case studies
- [[MOC-PDMS]] — Lessons applicable to PDMS

---

## 🔀 Cross-link: Case Study → Pattern (Microservices-Patterns)

> Mỗi case study là **evidence** cho một hoặc nhiều patterns. Dùng bảng này để đi từ "ai đã làm thế nào" sang "pattern nào áp dụng cho PDMS".

| Case Study | Pattern áp dụng | File trong Microservices-Patterns |
|---|---|---|
| **Atlassian** — Migrate 4M Jira DBs zero-downtime | Strangler Fig, dual-write, schema migration | [[Microservices-Patterns/Strangler-Fig\|Strangler Fig]] |
| **LinkedIn** — 5M QPS restriction, cache invalidation | CQRS read model, event-driven cache | [[Microservices-Patterns/CQRS-Materialized-View\|CQRS + Materialized View]] |
| **Slack** — Billions of messages, workspace sharding | Database per Service, Kafka fan-out | [[Microservices-Patterns/Database-per-Service\|Database per Service]] |
| **Reddit** — Notification fan-out, celebrity problem | Event-driven (fan-out on write vs read), Pub-Sub | [[Microservices-Patterns/01-Data-Consistency\|Data Consistency Patterns]] |
| **Grab** — Auth 180M users, token revocation at scale | Distributed cache invalidation, short-lived JWT | [[Microservices-Patterns/02-Communication\|Communication Patterns]] |
| **Tinder** — 1B swipes, gateway-level caching | API Gateway + circuit breaker, request dedup | [[Microservices-Patterns/Circuit-Breaker\|Circuit Breaker]], [[Microservices-Patterns/02-Communication\|API Gateway]] |
| **Dropbox AI Dash** — RAG pipeline, agent orchestration | Saga (orchestration-based), Event Sourcing cho audit | [[Microservices-Patterns/Saga-Pattern\|Saga Pattern]], [[Microservices-Patterns/Event-Sourcing\|Event Sourcing]] |
| **Shopify** — Monolith at scale, Cell-based arch | Modular decomposition, DB per domain | [[Microservices-Patterns/05-Decomposition\|Decomposition Patterns]] |
| **Google** — URL dedup at crawler scale | Idempotent consumer (bloom filter = idempotency check) | [[Microservices-Patterns/02-Communication\|Idempotent Consumer]] |

### Pattern → Observability

Mọi pattern production-grade đều cần instrumentation — xem:
- [[Microservices-Patterns/Distributed-Tracing\|Distributed Tracing]] — trace request xuyên services như Grab, Tinder
- [[Microservices-Patterns/Metrics-and-Alerting\|Metrics & Alerting]] — monitor circuit breaker state, Saga progress
- [[Microservices-Patterns/Log-Aggregation\|Log Aggregation]] — correlate logs từ Slack-style fan-out systems
