---
tags: [moc, audit, roadmap, architecture, meta]
created: 2026-05-02
status: living-document
---

# 🔍 Vault Audit — Software Architecture & Engineering Knowledge Map
> *Đánh giá toàn bộ knowledge đã có, gap analysis, và roadmap bổ sung cho mục tiêu: hiểu đúng bản chất của một hệ thống.*

---

## 📊 Tổng quan hiện trạng

| Domain | Coverage | Chất lượng | Ưu tiên bổ sung |
|--------|----------|------------|-----------------|
| Microservices Patterns | ████████░░ 80% | ⭐⭐⭐⭐⭐ | Medium |
| Database Patterns (ORM/Driver) | ███████░░░ 70% | ⭐⭐⭐⭐⭐ | Medium |
| Database Internals | ███░░░░░░░ 30% | ⭐⭐⭐⭐ | **High** |
| Distributed Systems Theory | ████░░░░░░ 40% | ⭐⭐⭐ (Notion links) | **High** |
| Architecture Patterns (DDD/Clean) | ██░░░░░░░░ 20% | ⭐⭐ (Notion only) | **Critical** |
| CS Fundamentals (OS/Network/CPU) | █░░░░░░░░░ 10% | ⭐⭐ | **Critical** |
| Security & Auth | ██░░░░░░░░ 20% | ⭐⭐ (Notion only) | **High** |
| Infrastructure / Platform | █░░░░░░░░░ 10% | ⭐ | Medium |
| Software Engineering Principles | ██░░░░░░░░ 20% | ⭐⭐ (Notion only) | **High** |
| Performance Engineering | ████░░░░░░ 40% | ⭐⭐⭐⭐ (scattered) | Medium |
| Language Mastery (Rust/Go/Java) | ████████░░ 80% | ⭐⭐⭐⭐⭐ | Low |

---

## ✅ Điểm mạnh — Những gì đã làm tốt

### 1. Microservices-Patterns/ — Xuất sắc
- Catalog đầy đủ: Data Consistency, Communication, Reliability, Observability, Decomposition
- Deep dives chất lượng cao: Debezium CDC, Kafka internals, CQRS/Event Sourcing, Saga, Outbox
- Có PDMS context cụ thể (áp dụng được ngay)
- BPMN/CMMN/DMN với Camunda integration

### 2. Language Curricula — Rất tốt
- Rust: 35+ bài, từ ownership đến unsafe/FFI, Tokio internals, production patterns
- Go: 22 bài, goroutines, gRPC, microservices patterns
- JVM Frameworks: Quarkus, Micronaut, Vert.x, RxJava với ADR

### 3. Database-Patterns/ — Tốt cho application layer
- Hibernate N+1, OSIV, L1/L2 cache
- JDBC vs R2DBC vs Virtual Threads — quyết định rõ ràng
- PostgreSQL performance deep dive

### 4. MOC Structure — Tốt
- 17 MOCs phủ đủ domain
- Link sang Notion Knowledge (nhưng đây là điểm yếu — xem bên dưới)

---

## 🚨 Critical Gaps — Phải bổ sung ngay

### GAP 1: Architecture Patterns chỉ tồn tại dưới dạng Notion links
> **Vấn đề:** Clean Architecture, DDD, SOLID, Design Patterns đều chỉ là links sang Notion. Không có bài riêng trong vault → không search được, không có code examples, không có PDMS context.

**Cần tạo (Priority 1):**
- [ ] `concepts/clean-architecture-hexagonal.md` — Ports & Adapters, Dependency Rule, tại sao Domain layer không depend infrastructure
- [ ] `concepts/ddd-strategic.md` — Bounded Context, Context Map, Ubiquitous Language, Anti-Corruption Layer
- [ ] `concepts/ddd-tactical.md` — Aggregate, Entity, Value Object, Domain Event, Repository pattern
- [ ] `concepts/solid-principles-deep-dive.md` — Không phải định nghĩa thuộc lòng, mà là *khi nào vi phạm gây ra vấn đề gì*
- [ ] `concepts/design-patterns-systems.md` — GoF patterns nhưng nhìn từ góc độ distributed systems context

### GAP 2: CS Fundamentals — Bản chất của hệ thống
> **Vấn đề:** Vault nói nhiều về *what* (pattern là gì) nhưng thiếu *why it works* ở tầng thấp hơn. Một architect cần biết tại sao `epoll` nhanh hơn `select`, tại sao cache line matters, tại sao zero-copy giảm latency.

**Cần tạo (Priority 1):**
- [ ] `concepts/io-models-deep-dive.md` — Blocking → Non-blocking → Select/Poll → **epoll** → **io_uring**. Tại sao async runtime (Tokio, Vert.x, Netty) hoạt động được.
- [ ] `concepts/memory-hierarchy-cpu-cache.md` — L1/L2/L3 cache, cache line (64 bytes), false sharing, NUMA topology. Tại sao data locality quan trọng.
- [ ] `concepts/os-process-thread-scheduling.md` — Process vs Thread vs Green Thread vs Fiber. Context switch cost. Work-stealing scheduler. Nền tảng để hiểu Goroutines, Virtual Threads, Tokio.
- [ ] `concepts/network-tcp-deep-dive.md` — TCP 3-way handshake, congestion control, TIME_WAIT, Nagle's algorithm, zero-copy (`sendfile`/`splice`). Tại sao HTTP/2 multiplexing giải quyết HOL blocking.

### GAP 3: Distributed Systems Theory — Chỉ có MOC links, không có bài sâu
> **Vấn đề:** MOC-Distributed-Systems.md toàn là Notion links. Cần bài riêng với depth thực sự.

**Cần tạo (Priority 1):**
- [ ] `concepts/consensus-raft-paxos.md` — Raft leader election, log replication, safety guarantees. Tại sao etcd/ZooKeeper dùng consensus. **Liên quan trực tiếp: tại sao Kafka ISR hoạt động được.**
- [ ] `concepts/distributed-clocks-ordering.md` — Logical clocks (Lamport), Vector clocks, Hybrid Logical Clocks. Tại sao "distributed time" là vấn đề khó. CockroachDB TrueTime.
- [ ] `concepts/consistency-models-spectrum.md` — Linearizability → Sequential → Causal → Eventual. Không phải chỉ CAP. *Jepsen test* sử dụng model nào để test? Strong consistency trong PostgreSQL vs Cassandra.
- [ ] `concepts/cap-pacelc-deep-dive.md` — Di chuyển từ Notion link sang bài riêng với ví dụ cụ thể: MongoDB, Cassandra, CockroachDB xếp vào đâu và tại sao.

---

## ⚠️ High Priority Gaps

### GAP 4: Database Internals — Còn nửa vời
> `Performance-System-Programming/01-Database-Internals/` có Bitcask, SSTable, Memtable nhưng thiếu B-Tree và query layer.

**Cần tạo:**
- [ ] `Performance-System-Programming/01-Database-Internals/03-BTree-vs-LSM.md` — So sánh toàn diện: B-Tree (PostgreSQL, MySQL InnoDB) vs LSM-Tree (RocksDB, Cassandra, LevelDB). Write amplification vs Read amplification. Khi nào dùng cái nào.
- [ ] `concepts/postgresql-index-internals.md` — B-Tree index mechanics, HOT updates, index bloat, GIN/GiST/BRIN khi nào dùng. Tại sao `EXPLAIN ANALYZE` đọc được. **Cực kỳ relevant với PDMS 10M+ records.**
- [ ] `concepts/query-planner-optimizer.md` — Statistics (`pg_statistic`), cost model, join strategies (Hash Join, Nested Loop, Merge Join), partition pruning. Tại sao `ANALYZE` quan trọng.
- [ ] `concepts/connection-pooling-pgbouncer.md` — PgBouncer transaction mode vs session mode. Max connections tại sao limited. Why `max_connections=100` is not 100 concurrent queries.

### GAP 5: Security — Rất thiếu
> MOC-Auth-Security.md toàn là Notion links. Đây là domain critical cho banking context.

**Cần tạo:**
- [ ] `concepts/oauth2-oidc-deep-dive.md` — Authorization Code + PKCE (browser apps), Client Credentials (service-to-service), Token introspection vs JWT validation. Refresh token rotation. Keycloak internals. **Liên quan trực tiếp PDMS IAM.**
- [ ] `concepts/zero-trust-architecture.md` — Never trust, always verify. mTLS between services. SPIFFE/SPIRE. BeyondCorp model. Tại sao VPN không phải zero trust.
- [ ] `concepts/secret-management.md` — HashiCorp Vault dynamic secrets, Kubernetes secrets encryption, secret rotation. Anti-patterns: hardcoded secrets, `.env` in git.
- [ ] `concepts/api-security-patterns.md` — Rate limiting (token bucket vs sliding window), HMAC request signing, API key management, OWASP API Security Top 10.

### GAP 6: Caching Strategy — Phân tán khắp nơi, thiếu bài tổng hợp
> Caching được nhắc đến trong Hibernate L2 cache, Redis bài trong Go/Rust, Cross-Service AuthZ nhưng chưa có bài tổng hợp.

**Cần tạo:**
- [ ] `concepts/caching-strategies-comprehensive.md` — Cache-aside vs Read-through vs Write-through vs Write-behind vs Refresh-ahead. Cache stampede & solutions. Distributed cache (Redis Cluster) vs local cache (Caffeine). Cold start. TTL strategy. **Tích hợp PDMS Caffeine + Redis hybrid pattern.**

### GAP 7: Software Engineering Practices — Hoàn toàn thiếu
**Cần tạo:**
- [ ] `concepts/testing-strategy-pyramid.md` — Unit → Integration → Contract (Pact) → E2E → Chaos. Consumer-Driven Contract testing trong microservices. Test doubles (Mock vs Stub vs Fake vs Spy).
- [ ] `concepts/adr-framework.md` — Architecture Decision Record: format, lifecycle, khi nào viết ADR. Liên kết sang `JVM-Frameworks-2026/ADR-001-Why-Quarkus-Over-Micronaut.md` như ví dụ.
- [ ] `concepts/technical-debt-management.md` — Debt quadrant (Martin Fowler). Đo lường bằng code metrics. Refactoring vs Rewrite decision. Strangler Fig connection.

---

## 📋 Medium Priority Gaps

### GAP 8: Probabilistic Data Structures
- [ ] `concepts/probabilistic-data-structures.md` — Bloom Filter (false positive, no false negative), HyperLogLog (cardinality estimation), Count-Min Sketch (frequency). Ứng dụng: Redis `BF.ADD`, Cassandra tombstone, Google Bigtable.

### GAP 9: Infrastructure & Platform
- [ ] `concepts/kubernetes-architecture.md` — Control Plane (API Server, etcd, Scheduler, Controller Manager) vs Data Plane (kubelet, kube-proxy, CNI). Pod lifecycle. Tại sao etcd là bottleneck. **Liên quan: tại sao PDMS hiện dùng Docker Compose hợp lý hơn K8s.**
- [ ] `concepts/container-internals.md` — Linux namespaces (PID, net, mount, user), cgroups v2, overlay filesystem. Tại sao container "nhẹ" hơn VM nhưng không isolation bằng.
- [ ] `concepts/gitops-cicd-patterns.md` — GitOps (ArgoCD), trunk-based development, feature flags, blue-green vs canary vs rolling deploy. **Liên quan PDMS additive schema strategy.**

### GAP 10: API Design (deep dive)
- [ ] `concepts/rest-api-design-advanced.md` — HATEOAS, versioning strategies (URI vs header vs content-negotiation), pagination (cursor-based vs offset), idempotency keys, ETag/conditional updates.
- [ ] `concepts/grpc-protobuf-deep-dive.md` — Bài riêng independent (hiện tại chỉ có trong Go/Rust curriculum): HTTP/2 multiplexing, proto3 field rules, backward compatibility, streaming (unary/server/client/bidi).
- [ ] `concepts/graphql-architecture.md` — N+1 problem & DataLoader, schema federation, subscriptions. Khi nào GraphQL phù hợp hơn REST.

### GAP 11: Observability — Có bài nhưng thiếu implementation depth
> Có `04-Observability.md` trong Microservices-Patterns nhưng thiếu hands-on.
- [ ] `concepts/opentelemetry-deep-dive.md` — Traces → Spans → Baggage. Metrics (Counter/Gauge/Histogram). Logs correlation. OTLP protocol. Collector architecture. **Java agent vs manual instrumentation.**
- [ ] `concepts/slo-sla-error-budget.md` — SLI → SLO → SLA → Error Budget. Burn rate alerts. Toil reduction. Google SRE model.

---

## 🔄 Cải tiến các bài đã có

### Cần nâng cấp:
1. **`Microservices-Patterns/05-Decomposition.md`** — Thêm section về **Modular Monolith** như bước trung gian trước microservices. Liên kết với DDD Bounded Context.
2. **`Database-Patterns/00-Hub-Database-Persistence.md`** — Thêm section về **Sharding patterns** (horizontal partitioning, shard key selection, cross-shard queries).
3. **`concepts/postgresql-performance-deep-dive.md`** — Thêm section về **VACUUM internals**, `autovacuum` tuning cho high-write workload (liên quan PDMS ETL).
4. **`Microservices-Patterns/BPMN-CMMN-DMN-Enterprise-Process-Modeling.md`** — Thêm so sánh **Temporal vs Camunda** rõ ràng hơn với decision matrix (đây là open question trong vault).
5. **`_moc/MOC-Distributed-Systems.md`** — Chuyển Notion links thành vault links khi bài được tạo.

---

## 🗺️ Knowledge Map — Bản chất của một hệ thống

```
                    ┌─────────────────────────────────┐
                    │        BUSINESS LOGIC           │
                    │    DDD / Clean Architecture     │  ← GAP 1 (Critical)
                    └────────────────┬────────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
   ┌──────────▼─────────┐ ┌─────────▼──────────┐ ┌────────▼─────────┐
   │   DATA LAYER        │ │  COMMUNICATION     │ │   SECURITY       │
   │ DB Internals ✅     │ │ Sync/Async ✅      │ │ OAuth2/OIDC ⚠️  │
   │ Index Internals ⚠️ │ │ gRPC deep ⚠️      │ │ Zero Trust ❌    │
   │ Connection Pool ⚠️ │ │ API Design ⚠️     │ │ mTLS ❌          │
   └──────────┬──────────┘ └─────────┬──────────┘ └────────┬─────────┘
              │                      │                      │
   ┌──────────▼──────────────────────▼──────────────────────▼─────────┐
   │                    DISTRIBUTED SYSTEMS                            │
   │  Consensus ⚠️  |  Clocks ⚠️  |  Consistency Models ⚠️          │
   │  CAP/PACELC ✅ (Notion)  |  Replication ✅ (Notion)              │
   └─────────────────────────────────┬─────────────────────────────────┘
                                     │
   ┌─────────────────────────────────▼─────────────────────────────────┐
   │                    CS FUNDAMENTALS                                │
   │  I/O Models ❌  |  CPU Cache ❌  |  OS Scheduling ❌              │
   │  TCP Internals ❌  |  Memory Allocators ❌                        │
   └────────────────────────────────────────────────────────────────────┘

Legend: ✅ Có bài riêng trong vault | ⚠️ Chỉ có Notion link / thiếu depth | ❌ Hoàn toàn chưa có
```

---

## 📅 Roadmap bổ sung — Đề xuất thứ tự

### Phase 1 — Nền tảng bản chất (Tháng 5-6/2026)
> *Những gì giải thích TẠI SAO các pattern hoạt động*

1. `concepts/io-models-deep-dive.md` — Giải thích Tokio, Netty, epoll
2. `concepts/memory-hierarchy-cpu-cache.md` — Giải thích false sharing, cache-oblivious algorithms
3. `concepts/os-process-thread-scheduling.md` — Nền tảng cho Virtual Threads / Goroutines
4. `concepts/consensus-raft-paxos.md` — Tại sao Kafka ISR, etcd, ZooKeeper hoạt động được
5. `concepts/consistency-models-spectrum.md` — Linearizability tới Eventual, đo bằng Jepsen
6. `concepts/distributed-clocks-ordering.md` — Tại sao timestamp ordering không đủ

### Phase 2 — Architecture Foundation (Tháng 6-7/2026)
> *Vũ khí thiết kế hệ thống*

7. `concepts/clean-architecture-hexagonal.md` — Với Java/Spring code example
8. `concepts/ddd-strategic.md` — Context Map, Bounded Context với PDMS example
9. `concepts/ddd-tactical.md` — Aggregate, Domain Event với code
10. `concepts/caching-strategies-comprehensive.md` — Consolidate scattered cache knowledge
11. `concepts/testing-strategy-pyramid.md` — Contract testing cho microservices
12. `concepts/adr-framework.md`

### Phase 3 — Database & Security Depth (Tháng 7-8/2026)

13. `Performance-System-Programming/01-Database-Internals/03-BTree-vs-LSM.md`
14. `concepts/postgresql-index-internals.md`
15. `concepts/query-planner-optimizer.md`
16. `concepts/oauth2-oidc-deep-dive.md` — Keycloak internals
17. `concepts/zero-trust-architecture.md`
18. `concepts/api-security-patterns.md`

### Phase 4 — Observability & Platform (Tháng 8-9/2026)

19. `concepts/opentelemetry-deep-dive.md`
20. `concepts/slo-sla-error-budget.md`
21. `concepts/kubernetes-architecture.md`
22. `concepts/container-internals.md`
23. `concepts/grpc-protobuf-deep-dive.md`
24. `concepts/probabilistic-data-structures.md`

---

## 🧩 Liên kết nội bộ

- [[MOC-System-Design]] — Architecture patterns
- [[MOC-Distributed-Systems]] — Theory
- [[MOC-Database]] — Data layer
- [[MOC-Auth-Security]] — Security domain
- [[MOC-Observability]] — SLO/SLA
- [[Microservices-Patterns/00-Hub-Microservices-Patterns]] — Applied patterns
- [[Database-Patterns/00-Hub-Database-Persistence]] — Applied DB knowledge
