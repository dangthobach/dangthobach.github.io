---
tags: [moc, pdms, vpbank, project]
---

# 📁 PDMS Project MOC

Physical Document Management System @ VPBank.

---

## 🏗️ Architecture
- Microservices với Spring Boot + Spring Cloud
- API Gateway — Spring Cloud Gateway + Resilience4J
- Service Discovery — Eureka
- Messaging — Kafka

## 🔑 Key Challenges & Solutions

### Cross-service N+1
- **Problem:** N+1 queries khi aggregate data từ nhiều service
- **Solutions explored:**
  - CQRS + Kafka → query service subscribe và build local read model
  - API Composition + batch fetching
  - CDC-based replication (Debezium)

### Gateway 503
- **Root cause:** Resilience4J `TimeLimiter` misconfiguration với async routes
- **Fix:** timeout > upstream response time, align với WebClient timeout

### Inter-service Consistency
- **Pattern:** Transactional Outbox + Kafka
- **Guarantee:** at-least-once delivery, idempotent consumers

---

## 📊 Data & Migration
- Credit migration system — batch validation stored procedures
- `pr_process_validation_hopdong_batch`
- `pr_process_validation_tap_batch`
- `pr_process_validation_cif_batch`
- ETL pipeline — Excel → PostgreSQL (200K–10M+ records)
- Apache POI SAX parsing + parallel batch ingestion

---

## 🔐 Authorization
- jCasbin — RBAC/ABAC model
- Spring AOP proxy cho policy enforcement

---

## 🔗 Links
- [[MOC-Java]] — Spring stack
- [[MOC-Distributed-Systems]] — patterns applied
- [[MOC-Database]] — PostgreSQL optimization
- [[MOC-Concurrency]] — high-concurrency considerations

---

## 📐 Architecture Design (2026-04-14)

### Core documents
- [[PDMS-Architecture-Overview]] — Service map, data flow, database schema strategy
- [[PDMS-Workflow-Optimal-Communication]] — 5 workflow tối ưu: query, write, export, kho sync, CDC
- [[PDMS-AuthZ-Fine-Grained-Design]] — IAM schema, permission model, 80/10/10 dept split, cache strategy

### Key decisions
- **Cross-service join**: CDC Replica local JOIN (zero RTT) + Caffeine cache fallback
- **Export Excel**: SAX streaming (SXSSFWorkbook) + keyset pagination + local authz JOIN
- **Consistency**: Transactional Outbox (at-least-once) + Saga pattern
- **Permission check**: Caffeine L1 (5min TTL) + Kafka invalidation (near real-time revoke)
- **High-stakes actions** (approve, transfer): sync call IAM bypass cache
- **Dept split**: `dept_type` enum SHARED/CHUNG_TU/TSDB denormalized vào authz_replica

---

## 🔄 Architecture Corrections (2026-04-15)

**3 corrections quan trọng từ review:**

1. **Keycloak là external SSO** — database riêng, enterprise-wide. IAM service là bridge (keycloak_sub → PDMS authorization). Gateway chỉ verify JWT signature (stateless JWKS), không call Keycloak per request.

2. **Không forward `X-Dept-Id` từ gateway** — 1000 depts, user có thể quản lý nhiều dept → header quá lớn và sai về thiết kế. Gateway chỉ forward `X-User-Sub` (Keycloak UUID). Services tự resolve từ `authz_local` table.

3. **Không dùng CDC/Debezium** — Kafka Domain Events (IAM chủ động publish qua Outbox) thay thế. Ít operational overhead, không expose raw DB schema, IAM tự do refactor schema. Xem so sánh đầy đủ tại [[PDMS-AuthZ-Sync-Strategy-Comparison]].

**File mới:**
- [[PDMS-AuthZ-Sync-Strategy-Comparison]] — So sánh 4 strategy: CDC vs Kafka Events vs Scheduled Pull vs Permission Token

---

## 🏛️ Multi-Domain IAM Design (2026-04-15)

**Context:** IAM phục vụ nhiều domain nghiệp vụ (PDMS, Warehouse/TSDB, tương lai thêm LEGAL, CREDIT...). Authorization logic giữa các domain khác hoàn toàn. Cần mở rộng cả chiều ngang (thêm domain) lẫn chiều dọc (ABAC phức tạp hơn).

**Document:** [[PDMS-IAM-Multi-Domain-Design]]

**3 vấn đề với schema cũ đã fix:**
1. `dept_type IN ('SHARED','CHUNG_TU','TSDB')` hardcode → thay bằng `domains` table (INSERT để thêm domain mới)
2. `user_dept_access + user_kho_access` flat tables → thay bằng `user_resource_scope(domain, resource_type, resource_id)` generic
3. Permission rule hardcode trong Java → thay bằng `domain_policies` JSON config per domain

**Key decisions:**
- `user_resource_scope` thay thế toàn bộ flat access tables — 1 bảng cho tất cả resource types
- `domain_policies` là ABAC rule engine per domain — PDMS có workflow rules, Warehouse có custody/value-limit rules
- authz_local isolation tại consumer layer — PDMS consumer chỉ subscribe `domainCode=PDMS`, không thấy WAREHOUSE data
- Thêm domain mới = INSERT vào `domains` + `resource_types` + define roles/permissions — **không ALTER TABLE, không redeploy IAM**
