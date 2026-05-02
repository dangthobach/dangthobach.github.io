---
tags: [moc, microservices, patterns, architecture, system-design]
aliases: [Microservices Hub, MS Patterns]
created: 2026-04-12
---

# 🏗️ Microservices Patterns — Hub

> **Triết lý:** Patterns không phải để học thuộc. Mỗi pattern giải quyết **một vấn đề cụ thể** — hiểu vấn đề trước, pattern là hệ quả tất yếu.

---

## 🗺️ Toàn cảnh

```
Microservices Challenges
├── Data bị phân tán → [01] Data & Consistency Patterns
├── Services cần giao tiếp → [02] Communication Patterns  
├── Lỗi lan rộng cascade → [03] Reliability Patterns
├── Hệ thống như hộp đen → [04] Observability Patterns
└── Cắt boundaries & deploy → [05] Decomposition & Deployment
```

---

## 📦 Nhóm patterns

| Nhóm | Vấn đề giải quyết | Patterns chính |
|---|---|---|
| [[01-Data-Consistency]] | Data phân tán, consistency | DB-per-Service, Saga, CQRS, Event Sourcing |
| [[02-Communication]] | Giao tiếp tin cậy giữa services | Outbox, API Gateway, Idempotent Consumer |
| [[03-Reliability]] | Cascade failure, service down | Circuit Breaker, Service Discovery |
| [[04-Observability]] | Debug distributed systems | Tracing, Metrics, Log Aggregation |
| [[05-Decomposition]] | Cắt service boundaries đúng | DDD Subdomain, Strangler Fig, Container |

---

## ⚡ Quick Reference — Khi nào dùng gì?

| Tình huống | Pattern nên dùng |
|---|---|
| "Service A cần data của Service B" | [[CQRS-Materialized-View]] — replica read-optimized |
| "Payment span 3 services, cần rollback" | [[Saga-Pattern]] — compensating transactions |
| "Publish event + save DB phải đồng thời" | [[Transactional-Outbox]] — atomicity trick |
| "Service B chậm làm chết Service A" | [[Circuit-Breaker]] — fail fast |
| "Kafka có thể deliver duplicate message" | [[Idempotent-Consumer]] — xử lý an toàn |
| "Migrate monolith từng bước" | [[Strangler-Fig]] — không big bang |
| "Trace request xuyên 10 services" | [[Distributed-Tracing]] — correlation ID |

---

## 🔗 Áp dụng vào PDMS

- **Database per Service** → Tách schema: `pdms_document`, `pdms_credit`, `pdms_workflow`
- **CQRS + Kafka** → Giải quyết N+1 query cross-service boundaries
- **Transactional Outbox** → Publish Kafka event trong cùng DB transaction
- **Circuit Breaker (Resilience4J)** → Bảo vệ Spring Cloud Gateway khỏi cascade failure
- **Strangler Fig** → Migrate từng module từ legacy credit system

---

## 🔗 Liên kết vault

- [[MOC-System-Design]] — Architecture context rộng hơn
- [[MOC-Distributed-Systems]] — CAP theorem, consistency models
- [[MOC-Database]] — PostgreSQL, sharding, replication
- [[MOC-PDMS]] — Applied context


---

## 📚 All Deep-dive Notes

| Pattern | Nhóm | File |
|---|---|---|
| Database per Service | Data | [[Database-per-Service]] |
| Saga (Choreography + Orchestration) | Data | [[Saga-Pattern]] |
| CQRS + Materialized View | Data | [[CQRS-Materialized-View]] |
| Event Sourcing | Data | [[Event-Sourcing]] |
| Transactional Outbox | Communication | [[Transactional-Outbox]] |
| Circuit Breaker + Bulkhead | Reliability | [[Circuit-Breaker]] |
| Strangler Fig + ACL | Decomposition | [[Strangler-Fig]] |
| Distributed Tracing (OpenTelemetry) | Observability | [[Distributed-Tracing]] |
| Metrics & Alerting (Prometheus) | Observability | [[Metrics-and-Alerting]] |
| Log Aggregation (PLG/ELK) | Observability | [[Log-Aggregation]] |

---

## 🔄 CDC & Streaming

| Pattern | Nhóm | File |
|---|---|---|
| Debezium & CDC (full deep dive) | Data Streaming | [[Debezium-CDC-Deep-Dive]] |
