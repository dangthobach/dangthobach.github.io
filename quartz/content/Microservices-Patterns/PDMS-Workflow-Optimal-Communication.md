---
tags: [pdms, vpbank, workflow, cross-service, kafka, authz, performance, consistency]
up: "[[PDMS-Architecture-Overview]]"
related: "[[Cross-Service-Join-AuthZ-Fine-Grained-Filter]], [[Transactional-Outbox]], [[CQRS-Materialized-View]], [[PDMS-AuthZ-Sync-Strategy-Comparison]]"
created: 2026-04-15
---

# 🔄 PDMS — Workflow Tối Ưu Giao Tiếp Giữa Các Service

> **TL;DR:** 5 workflow chính của PDMS. AuthZ sync qua Kafka Domain Events (không cần CDC/Debezium). Gateway chỉ forward `X-User-Sub` (Keycloak UUID), không forward dept IDs. Services dùng `authz_local` table để filter data mà không có round-trip.

---

## 🎯 Vấn đề & Giải pháp

| Vấn đề | Root cause | Giải pháp | Trade-off |
|---|---|---|---|
| Cross-service authz JOIN | Database-per-service (3 DBs riêng) | `authz_local` table — Kafka event-driven sync | Eventual consistency (~giây khi có thay đổi) |
| User quản lý nhiều dept (1000 depts) | Gateway không thể forward list dept | Services query `authz_local` local | Không còn header bloat |
| Permission check cho write ops | Cần near-real-time revoke | Query `authz_local` trực tiếp (luôn fresh) | Tăng nhẹ query complexity |
| Export Excel 10M rows | Memory + N×RTT per page | SAX streaming + Keyset pagination | Setup phức tạp hơn |
| Warehouse → IAM kho sync | Shared master data | Kafka event + `kho_snapshot` | Stale ~giây |
| Consistency across writes | Distributed transaction | Transactional Outbox + idempotent consumers | At-least-once |

---

## 📋 Workflow 1: Query List Đề Nghị (read-heavy, zero RTT)

**Pattern:** `authz_local` local JOIN — không network call

```
1. Client: GET /api/de-nghi?status=PENDING
2. Gateway:
   - Verify JWT signature (Keycloak JWKS, stateless)
   - Extract: X-User-Sub: "a1b2c3d4-uuid"
   - Route → pdms-service
3. PDMS Service:
   keycloakSub = header["X-User-Sub"]
   Query LOCAL (zero RTT):
     SELECT dn.*
     FROM pdms.de_nghi dn
     WHERE dn.dept_id IN (
         SELECT dept_id FROM authz_local.user_dept_access
         WHERE user_sub = 'a1b2c3d4-uuid'
           AND is_active = true
           AND dept_type IN ('SHARED', 'CHUNG_TU')
     )
     AND dn.kho_id IN (
         SELECT kho_id FROM authz_local.user_kho_access
         WHERE user_sub = 'a1b2c3d4-uuid'
           AND is_active = true
     )
     AND dn.status = 'PENDING'
     AND dn.id > :lastId       ← keyset cursor
     ORDER BY dn.id ASC
     LIMIT 50;
4. Trả kết quả
```

**Latency budget:**
- Index lookup `authz_local` + subquery: 2–8ms
- Business data query: 5–15ms
- Gateway overhead: 2–5ms
- **Total: ~10–30ms** (vs 80–200ms nếu gọi IAM mỗi request)

**Fallback khi Kafka sync lag > threshold:**

```java
@Service
public class DeNghiQueryService {

    public Page<DeNghiDTO> getDeNghi(String keycloakSub, DeNghiFilter filter, Pageable pg) {
        if (authzSyncHealth.isHealthy()) {
            // Fast path: local authz_local JOIN
            return deNghiRepository.findForUser(keycloakSub, filter, pg);
        } else {
            // Fallback: 1 batch call IAM → get allowed depts → query
            log.warn("authz_local sync lag detected, fallback to IAM batch call");
            Set<Long> allowedDepts = iamClient.getBatchDeptPermissions(keycloakSub);
            Set<Long> allowedKhos  = iamClient.getBatchKhoPermissions(keycloakSub);
            return deNghiRepository.findByDeptAndKho(allowedDepts, allowedKhos, filter, pg);
        }
    }
}
```

---

## 📋 Workflow 2: Tạo Đề Nghị (write + authz check + consistency)

**Pattern:** authz_local check → Transactional Outbox

```
1. Client: POST /api/de-nghi { deptId: 10, khoId: 5, ... }
2. Gateway: verify JWT → X-User-Sub: "uuid"
3. PDMS Service:
   a. AuthZ check (query authz_local — local, no RTT):
      - SELECT 1 FROM authz_local.user_dept_access
        WHERE user_sub='uuid' AND dept_id=10 AND is_active=true
        AND dept_type IN ('SHARED','CHUNG_TU')  → không có → 403
      - SELECT 1 FROM authz_local.user_kho_access
        WHERE user_sub='uuid' AND kho_id=5 AND is_active=true  → không có → 403
   b. Business validation
   c. BEGIN TRANSACTION:
        INSERT INTO pdms.de_nghi (...)           → business record
        INSERT INTO pdms.outbox_events {         → event (same TX)
            event_type: 'DE_NGHI_CREATED',
            payload: { deNghiId, deptId, khoId, ... }
        }
      COMMIT;
4. Outbox Polling Publisher (background, 100ms):
   → Kafka: pdms.de-nghi-created
5. Consumers:
   → report-service: INSERT into report read model
   → integration-service: notify CoreBanking
```

**Tại sao write cũng dùng authz_local thay vì gọi IAM?**

```
Option cũ: Caffeine cache + Kafka invalidation
  → Cần maintain in-memory cache state
  → Cache miss vẫn cần RTT đến IAM
  → TTL làm phức tạp revoke logic

Option mới: query authz_local trực tiếp
  → authz_local luôn được update qua Kafka events (real-time khi có thay đổi)
  → Không cần cache riêng
  → Code đơn giản hơn: 1 source of truth cho authz data tại PDMS

authz_local được update:
  - Ngay khi IAM publish iam.permission-changed (lag ~ms–giây)
  - Permission thay đổi rất ít trong ngày (vài lần/ngày tối đa)
  → Eventual consistency hoàn toàn acceptable
```

**Cho high-stakes operations (approve, transfer):** sync call IAM để đảm bảo strong consistency:

```java
@PostMapping("/de-nghi/{id}/approve")
public void approve(@PathVariable Long id,
                    @RequestHeader("X-User-Sub") String keycloakSub) {
    // High-stakes: bypass authz_local, call IAM sync
    boolean allowed = iamClient.checkPermissionSync(
        keycloakSub, "DE_NGHI.APPROVE", id, "DE_NGHI"
    );
    if (!allowed) throw new ForbiddenException();
    // business logic...
}
```

---

## 📋 Workflow 3: Export Excel Hàng Triệu Bản Ghi

**Pattern:** SAX Streaming + Keyset Cursor + authz_local filter

```
Vấn đề naive:
  SELECT * WHERE dept_id IN (10,20,...) LIMIT 10M → OOM
  OFFSET-based pagination → O(N²) tại scale

Giải pháp:
  Keyset cursor (WHERE id > lastId) + SXSSFWorkbook streaming
```

```
1. Client: GET /api/reports/export?from=2024-01-01&to=2024-12-31
   (Gateway route: response-timeout = 10 phút)
2. Report Service:
   - Khởi tạo SXSSFWorkbook(rowAccessWindowSize=100)
   - Set Transfer-Encoding: chunked
   - lastId = 0
   LOOP:
     SELECT r.*
     FROM report_db.read_model r
     WHERE r.dept_id IN (
         SELECT dept_id FROM authz_local.user_dept_access
         WHERE user_sub = :keycloakSub AND is_active = true
           AND dept_type IN ('SHARED', 'CHUNG_TU')
     )
     AND r.id > :lastId
     AND r.created_date BETWEEN :from AND :to
     ORDER BY r.id ASC
     LIMIT 5000;

     → Write 5000 rows vào SXSSFWorkbook
     → sheet.flushRows(100)    ← release memory (chỉ giữ 100 rows in heap)
     → lastId = batch.last().id
   UNTIL batch.size() < 5000
   → wb.write(outputStream)
```

**Memory footprint:**
```
SXSSFWorkbook giữ 100 rows × ~50 cols × 200 bytes ≈ ~1MB in heap
Batch query 5000 rows × ~50 cols × 200 bytes ≈ 50MB
Total heap: ~50–80MB để stream 10M rows
```

**Java implementation:**

```java
@GetMapping(value = "/export", produces = MediaType.APPLICATION_OCTET_STREAM_VALUE)
public ResponseEntity<StreamingResponseBody> exportExcel(
        @RequestHeader("X-User-Sub") String keycloakSub,
        ExportRequest request) {

    StreamingResponseBody body = out -> {
        try (SXSSFWorkbook wb = new SXSSFWorkbook(100)) {
            Sheet sheet = wb.createSheet("Report");
            writeHeaders(sheet);
            Long lastId = 0L;
            List<ReportRow> batch;
            do {
                batch = reportRepo.findNextBatch(keycloakSub, request, lastId, 5_000);
                for (ReportRow row : batch) writeRow(sheet, row);
                if (!batch.isEmpty()) lastId = batch.getLast().getId();
                ((SXSSFSheet) sheet).flushRows(100);
            } while (batch.size() == 5_000);
            wb.write(out);
        }
    };

    return ResponseEntity.ok()
        .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=report.xlsx")
        .body(body);
}
```

---

## 📋 Workflow 4: Warehouse → IAM Kho Sync

**Constraint:** `warehouse_db` và `iam_db` là 2 databases riêng biệt, không share.

```
Warehouse Service (warehouse_db):
  Admin tạo kho mới
  → BEGIN TX:
      INSERT INTO warehouse.kho (...)
      INSERT INTO warehouse.outbox { event_type:'KHO_CREATED', payload:{khoId, code, name,...} }
    COMMIT
  → Outbox publisher → Kafka: warehouse.kho-changed

IAM Service (iam_db):
  @KafkaListener("warehouse.kho-changed")
  public void onKhoChanged(KhoChangedEvent e) {
      switch (e.type()) {
          case KHO_CREATED    → khoSnapshotRepo.insert(e)
          case KHO_UPDATED    → khoSnapshotRepo.update(e)
          case KHO_DEACTIVATED:
              khoSnapshotRepo.deactivate(e.khoId())
              // Kho bị deactivate → users có access kho này cần biết
              // Publish thêm event để PDMS có thể block access
              outbox.save(IamEvent.khoDeactivated(e.khoId()))
      }
  }

PDMS/Report Service:
  @KafkaListener("iam.kho-snapshot-changed")
  → UPDATE authz_local.user_kho_access SET is_active=false WHERE kho_id=X
```

**Data flow hoàn chỉnh:**

```
warehouse_db → Kafka: warehouse.kho-changed
                → iam_db: kho_snapshot updated
                  → Kafka: iam.kho-snapshot-changed (chỉ khi cần cascade)
                    → pdms_db: authz_local.user_kho_access updated
                    → report_db: authz_local.user_kho_access updated
```

---

## 📋 Workflow 5: IAM Permission Sync Setup (Kafka Events)

**Không dùng Debezium.** IAM service chủ động publish.

```
IAM Service — khi admin thay đổi permission:
  BEGIN TX (iam_db):
    UPDATE user_dept_access SET ...
    INSERT INTO iam.permission_change_log (...)
    INSERT INTO iam.outbox_events {
        event_type: 'USER_DEPT_ACCESS_CHANGED',
        payload: {
            keycloakSub: "uuid",
            changes: [
                { deptId: 10, deptType: "SHARED", action: "GRANTED" },
                { deptId: 20, action: "REVOKED" }
            ]
        }
    }
  COMMIT
  → Outbox publisher → Kafka: iam.permission-changed

PDMS Service — consumer:
  @KafkaListener("iam.permission-changed")
  → UPSERT/DELETE authz_local.user_dept_access (idempotent, dùng event UUID)
```

**Bootstrap khi deploy:**

```
PDMS startup:
  IF authz_local.count() == 0:
    GET /internal/authz/bulk-export (IAM internal API, stream NDJSON)
    → BULK INSERT authz_local
    → log "Bootstrap complete: N records"
  ELSE:
    proceed (Kafka events đã keep authz_local up-to-date)
```

**Monitoring sync health:**

```java
@Scheduled(fixedDelay = 30_000)
public void monitorSyncHealth() {
    Instant lastSync = authzLocalRepo.findLastSyncedAt();
    Duration lag = Duration.between(lastSync, Instant.now());

    meterRegistry.gauge("authz.local.sync_lag_seconds", lag.toSeconds());

    // Alert nếu không nhận event > 10 phút VÀ biết IAM có thay đổi
    // (permission thay đổi ít nên không alert chỉ vì không có event)
    boolean knownPendingChanges = iamClient.hasRecentChanges(lastSync);
    if (lag.toMinutes() > 10 && knownPendingChanges) {
        log.warn("authz_local lag {}min with pending IAM changes", lag.toMinutes());
        authzSyncHealth.markUnhealthy();
        alerting.fire("AUTHZ_SYNC_LAG_WITH_CHANGES");
    } else {
        authzSyncHealth.markHealthy();
    }
}
```

---

## ⚖️ Consistency Guarantees

| Scenario | Level | Lag | Acceptable? |
|---|---|---|---|
| List đề nghị (read) | Eventual | authz lag ~ms–giây | ✅ Dept permission thay đổi ít |
| Tạo đề nghị (write authz check) | Eventual | authz lag ~ms–giây | ✅ Acceptable |
| Approve/transfer (high-stakes) | Strong | 0 (sync IAM call) | ✅ Required |
| Export Excel filter | Eventual | authz lag ~ms–giây | ✅ Batch context |
| Kho deactivated effect | Eventual | Kafka lag ~giây | ✅ Kho thay đổi rất ít |
| Domain event (đề nghị created) | At-least-once | Outbox lag ~100ms | ✅ Idempotent consumers |

---

## 🔗 Links

- [[PDMS-Architecture-Overview]] — toàn cảnh kiến trúc
- [[PDMS-AuthZ-Fine-Grained-Design]] — IAM schema, authz_local design
- [[PDMS-AuthZ-Sync-Strategy-Comparison]] — CDC vs Kafka Events vs Pull vs Token
- [[Cross-Service-Join-AuthZ-Fine-Grained-Filter]] — 5 pattern lý thuyết
- [[Transactional-Outbox]] — at-least-once delivery
- [[MOC-PDMS]] — project hub
