---
tags: [pdms, vpbank, architecture, microservices, system-design]
up: "[[MOC-PDMS]]"
related: "[[Cross-Service-Join-AuthZ-Fine-Grained-Filter]], [[Transactional-Outbox]], [[CQRS-Materialized-View]]"
created: 2026-04-14
updated: 2026-04-15
---

# 🏗️ PDMS Architecture Overview

> **TL;DR:** Kiến trúc microservices cho Physical Document Management System tại VPBank. 7 services chính, phân quyền fine-grained qua IAM service, cross-service data consistency qua Kafka Domain Events (không dùng Debezium CDC), xuất Excel hàng triệu bản ghi qua SAX streaming.

---

## 🗺️ Service Map

```
portal-service (React SPA)
        │ HTTPS + JWT (Keycloak)
        ▼
gateway-service (Spring Cloud Gateway + Resilience4J)
        │  forward X-User-Sub (keycloak sub UUID)
   ┌────┴──────────────────────┬──────────────────┐
   ▼                           ▼                  ▼
iam-service              pdms-service        integration-service
(AuthZ, Dept, Role)      (Core domain)       (Third-party)
   │                           │
   │ Kafka domain events        │ Kafka events
   └──────────┬────────────────┘
              │
     ┌────────┴────────┐
     ▼                 ▼
warehouse-service   report-service
(Kho master)        (Báo cáo, Excel)
```

**Databases — hoàn toàn độc lập:**
- `iam_db` — PostgreSQL riêng của IAM service
- `pdms_db` — PostgreSQL riêng của PDMS service
- `warehouse_db` — PostgreSQL riêng của Warehouse service
- `report_db` — PostgreSQL riêng của Report service
- `keycloak_db` — Database của Keycloak (external SSO, enterprise-wide, không thuộc PDMS)

---

## 📦 Service Responsibilities

### gateway-service
- Tiếp nhận toàn bộ traffic, route đến service phù hợp
- JWT validation qua Keycloak JWKS endpoint (verify signature only — stateless)
- Resilience4J: Circuit Breaker + TimeLimiter per route
- Rate limiting per user (Redis-backed)
- **Header propagation:** chỉ forward `X-User-Sub` (Keycloak `sub` UUID) và `X-Roles` (nếu nhỏ)
- **Không forward `X-Dept-Id`** — dept list quá lớn (1000 depts, user có thể có access nhiều dept) và đây là authorization logic thuộc về service, không thuộc gateway

> **Tại sao không forward dept IDs?** Xem [[#Gateway — Tại sao không forward dept IDs]]

### iam-service
- **Single source of truth** cho phân quyền toàn hệ thống PDMS
- Mapping `keycloak_sub` (UUID) → internal `user_id` + permission data
- Entity chính: `user` (keycloak mapping), `department`, `role`, `team`, `permission`, `user_dept_access`, `user_kho_access`, `kho_snapshot`
- `kho_snapshot` là bản copy từ warehouse-service (sync qua Kafka)
- Publish Kafka events khi permission thay đổi: `iam.permission-changed`
- Expose API: `/authz/permissions/{keycloakSub}` (batch load toàn bộ permission)

### pdms-service
- Domain core: `case_pdm`, `de_nghi_ban_giao`, `muon_tra`, `thung`, `tap`, `gia_han`
- Cần `department`, `kho`, `team` để filter data + kiểm tra phân quyền
- Authorization strategy: **local `authz_local` table** được sync từ IAM qua Kafka events
- Không dùng Debezium/CDC — IAM service chủ động publish khi có thay đổi
- Permission check khi write → query `authz_local` table (luôn fresh nhờ event-driven)
- Transactional Outbox pattern cho mọi domain event ra Kafka

### warehouse-service
- Quản lý kho vật lý (địa điểm, sức chứa, trạng thái)
- Database riêng `warehouse_db`, không share với IAM
- Publish `warehouse.kho-changed` khi có thay đổi kho
- IAM service consume event, cập nhật `kho_snapshot` trong `iam_db`

### report-service
- Subscribe Kafka events từ pdms-service, build read model local trong `report_db`
- Xuất Excel hàng triệu bản ghi qua Apache POI SAX streaming
- Filter theo phân quyền: query `authz_local` table (cũng được sync từ IAM events)
- Streaming response qua `StreamingResponseBody` + keyset pagination

### integration-service
- Outbound integration với third-party (CoreBanking, DMS external)
- Adapter pattern, retry + DLQ qua Kafka

### portal-service
- React SPA, giao tiếp duy nhất qua gateway-service
- Login qua Keycloak SSO → nhận JWT → mọi request kèm Bearer token
- Gateway validate JWT, forward `X-User-Sub` xuống services

---

## 🔑 Keycloak — External SSO

Keycloak là hệ thống **enterprise-wide**, dùng chung cho nhiều app, có database riêng hoàn toàn tách biệt khỏi PDMS.

```
┌─────────────────────────────────────────────────┐
│  Enterprise Keycloak (external)                  │
│  keycloak_db — database riêng                    │
│  Quản lý: users, credentials, sessions, realms  │
│  Không thuộc PDMS — nhiều app khác cũng dùng    │
└──────────────────┬──────────────────────────────┘
                   │ JWKS endpoint (public keys)
                   │ OIDC discovery
                   ▼
          gateway-service
          (verify JWT signature — stateless)
                   │
                   │ X-User-Sub: "a1b2c3d4-..." (Keycloak UUID)
                   ▼
          iam-service
          (lookup internal user by keycloak_sub)
          iam_db.users: { keycloak_sub, internal_user_id, ... }
```

**IAM service là bridge giữa Keycloak identity và PDMS authorization:**
- Keycloak cấp JWT với `sub` (UUID) + basic roles
- IAM service giữ mapping `keycloak_sub → internal_user_id → dept/kho/team permissions`
- Services downstream dùng `keycloak_sub` làm lookup key vào `authz_local` table

---

## 🔐 Gateway — Tại sao không forward dept IDs

### Vấn đề với X-Dept-Id header

```
Scenario: User quản lý 150 departments trong 1000 dept system
→ Header value: "10,23,45,67,89,102,..." (150 IDs)
→ HTTP header size: ~1KB — về mặt kỹ thuật ok
→ Nhưng sai về mặt thiết kế:
```

**3 lý do không forward dept IDs từ gateway:**

1. **Gateway không có ngữ nghĩa authorization** — Gateway không biết dept nào applicable cho resource nào. Một request `GET /de-nghi?khoId=5` — gateway không biết đây cần check dept hay kho. Đó là logic của service.

2. **Stale data risk** — JWT được issue lúc login, có thể TTL 15 phút đến 1 giờ. Nếu permission bị revoke trong thời gian đó, header vẫn chứa dept cũ → security gap.

3. **Coupling gateway với IAM schema** — Mỗi khi thay đổi permission model (thêm resource type mới), gateway cần update. Vi phạm single responsibility.

**Giải pháp đúng:**

```
Gateway chỉ forward:
  X-User-Sub: "a1b2c3d4-uuid"     ← Keycloak subject (immutable)
  X-Token-Exp: "1713000000"       ← Token expiry (optional, debugging)

Services tự resolve permission:
  authz_local table (event-driven sync từ IAM)
  → SELECT dept_id FROM authz_local.user_dept_access
    WHERE user_sub = 'a1b2c3d4-uuid' AND is_active = true
  → join với business data → filter kết quả
```

---

## 🔐 Authorization Architecture

### Dept split — 1000 departments

```
iam_db.department (1000 records):
  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
  │ ~800 SHARED     │  │ ~100 CHUNG_TU   │  │ ~100 TSDB       │
  │ Dùng chung cả   │  │ Riêng Chứng từ  │  │ Riêng TSDB +    │
  │ PDMS + TSDB     │  │ (PDMS domain)   │  │ Warehouse       │
  └─────────────────┘  └─────────────────┘  └─────────────────┘

Filter trong PDMS query:
  dept_type IN ('SHARED', 'CHUNG_TU')

Filter trong TSDB/Warehouse query:
  dept_type IN ('SHARED', 'TSDB')
```

### Luồng xác thực + phân quyền (corrected)

```
1. User login → Keycloak → JWT { sub: "uuid", roles: ["PDMS_MAKER"] }
2. Client gửi request kèm Bearer token
3. Gateway:
   a. Verify JWT signature (Keycloak JWKS) — stateless, không call Keycloak
   b. Extract sub, forward X-User-Sub: "uuid"
   c. Route đến service
4. PDMS Service nhận request:
   a. keycloakSub = header["X-User-Sub"]
   b. Query authz_local (local table, no network):
      SELECT dept_id FROM authz_local.user_dept_access
      WHERE user_sub = :keycloakSub AND is_active = true
        AND dept_type IN ('SHARED', 'CHUNG_TU')
   c. JOIN với business data → filtered result
```

---

## 🔄 Cross-Service AuthZ Sync — Lựa chọn tối ưu cho PDMS

> Chi tiết phân tích tại [[PDMS-AuthZ-Sync-Strategy-Comparison]]

PDMS không dùng Debezium CDC. Lý do và lựa chọn thay thế:

### Strategy được chọn: Kafka Domain Events (không cần Debezium)

```
IAM Service:
  Khi permission thay đổi (admin gán dept cho user):
  → BEGIN TRANSACTION:
      UPDATE user_dept_access SET ...
      INSERT INTO outbox { event_type: 'USER_DEPT_ACCESS_CHANGED', payload: {...} }
     COMMIT
  → Outbox publisher → Kafka: iam.permission-changed

PDMS Service:
  @KafkaListener("iam.permission-changed")
  → UPSERT authz_local.user_dept_access

Initial sync khi deploy:
  IAM expose: GET /internal/authz/bulk-export
  → PDMS gọi 1 lần khi startup để populate authz_local
```

**Tại sao không Debezium:**
- Không cần Kafka Connect cluster
- IAM service kiểm soát event format (không expose raw DB schema)
- Đơn giản hơn để maintain và debug

---

## 🔄 Data Flow

### 1. Write flow

```
Client → Gateway (verify JWT, forward X-User-Sub)
       → PDMS Service:
           keycloakSub = header["X-User-Sub"]
           allowedDepts = SELECT dept_id FROM authz_local WHERE user_sub = keycloakSub
           → Check deptId ∈ allowedDepts → 403 nếu không
           → Business logic
           → BEGIN TX: INSERT de_nghi + INSERT outbox COMMIT
           → Outbox publisher → Kafka: pdms.de-nghi-created
```

### 2. Read/filter flow

```
Client → Gateway → PDMS Service:
  SELECT dn.* FROM pdms.de_nghi dn
  JOIN authz_local.user_dept_access r
       ON r.dept_id = dn.dept_id
       AND r.user_sub = :keycloakSub
       AND r.is_active = true
       AND r.dept_type IN ('SHARED', 'CHUNG_TU')
  WHERE dn.status = 'ACTIVE'
  -- local JOIN, zero network call
```

### 3. Export Excel

```
Client → Report Service:
  → Keyset cursor pagination + local authz JOIN
  → SXSSFWorkbook streaming (window 100 rows)
  → HTTP chunked response
  Heap: ~50-100MB để export 10M rows
```

### 4. Authz sync flow

```
IAM Service → Kafka: iam.permission-changed
  → PDMS Service consumer: UPSERT authz_local
  → Report Service consumer: UPSERT authz_local

IAM Service → Kafka: warehouse.kho-changed (từ Warehouse)
  → IAM consumer: UPDATE kho_snapshot
  → IAM → Kafka: iam.kho-snapshot-changed
  → PDMS/Report consumer: UPSERT authz_local.kho
```

---

## ⚡ Performance

### Cross-service authz: local JOIN strategy

```java
// PDMS Service — bulk query với local authz JOIN
@Query(nativeQuery = true, value = """
    SELECT dn.*
    FROM pdms.de_nghi dn
    WHERE EXISTS (
        SELECT 1 FROM authz_local.user_dept_access r
        WHERE r.dept_id = dn.dept_id
          AND r.user_sub = :keycloakSub
          AND r.is_active = true
          AND r.dept_type IN ('SHARED', 'CHUNG_TU')
    )
    AND dn.status = :status
    AND dn.id > :lastId
    ORDER BY dn.id ASC
    LIMIT :pageSize
    """)
List<DeNghi> findNextPage(
    @Param("keycloakSub") String keycloakSub,
    @Param("status") String status,
    @Param("lastId") Long lastId,
    @Param("pageSize") int pageSize
);
```

### Export Excel — memory-safe

```java
StreamingResponseBody body = outputStream -> {
    try (SXSSFWorkbook wb = new SXSSFWorkbook(100)) {
        Sheet sheet = wb.createSheet("Báo cáo");
        Long lastId = 0L;
        List<ReportRow> batch;
        do {
            batch = reportRepository.findNextPage(keycloakSub, filter, lastId, 5000);
            batch.forEach(row -> writeRow(sheet, row));
            lastId = batch.isEmpty() ? null : batch.getLast().getId();
            ((SXSSFSheet) sheet).flushRows(100);
        } while (lastId != null);
        wb.write(outputStream);
    }
};
```

---

## 🔗 Links

- [[PDMS-AuthZ-Sync-Strategy-Comparison]] — So sánh 4 strategy sync authz (CDC vs Kafka Events vs Scheduled Pull vs Permission Token)
- [[PDMS-Workflow-Optimal-Communication]] — Workflow chi tiết 5 luồng chính
- [[PDMS-AuthZ-Fine-Grained-Design]] — IAM schema, permission model
- [[Cross-Service-Join-AuthZ-Fine-Grained-Filter]] — 5 pattern lý thuyết
- [[Transactional-Outbox]] — at-least-once Kafka delivery
- [[MOC-PDMS]] — project hub
