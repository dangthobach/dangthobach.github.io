---
type: guide
domain: database
status: active
created: 2026-06-01
updated: 2026-06-01
tags: []
---

# Flyway cho Technical Leader — Quản trị DDL ở hệ thống 100+ bảng

> **Góc nhìn**: Bài này không dạy Flyway basics. Bài này dạy cách **làm chủ** Flyway khi bạn chịu trách nhiệm toàn bộ schema của một hệ thống production nghiêm túc — nơi một migration sai có thể làm sập service lúc 2AM.

**Series**: [[DBMigration-MOC]] | **Prerequisite**: [[DBMigration-01-Flyway-Deep-Dive]]

---

## 1. Mental Model của Technical Leader

Developer dùng Flyway để "apply SQL". Technical Leader dùng Flyway để **kiểm soát drift** — khoảng cách giữa những gì code expect và những gì DB thực sự có.

```
Developer's mental model:
  "Tôi thêm column → tôi viết migration → merge → xong"

TechLead's mental model:
  Schema = Shared contract giữa tất cả services
  Migration = Immutable append-only ledger của contract changes
  flyway_schema_history = Source of truth cho mọi thay đổi đã xảy ra
  
  Câu hỏi không phải "migration này có chạy không?"
  Câu hỏi là "migration này có SAFE không ở mọi môi trường?"
               "ai có thể review nó?"
               "nếu nó fail ở production, chúng ta làm gì?"
               "6 tháng nữa đọc lại có hiểu không?"
```

Triết lý cốt lõi:

```
DDL changes are permanent.
Code có thể rollback qua git revert.
Schema changes không có git revert.
```

---

## 2. The Golden Rules — 10 Nguyên tắc Bất di bất dịch

Đây là các nguyên tắc mà bất kỳ ai trong team vi phạm đều cần được đặt câu hỏi ngay:

### Rule 1: Không bao giờ sửa file migration đã merge

```
WRONG:
  V3__add_status_column.sql đã merge và chạy trên staging
  → Dev sửa typo trong comment của file này

IMPACT:
  Checksum mismatch trên mọi môi trường chưa repair
  Mất tính nhất quán lịch sử migration
  
RIGHT:
  Nếu cần sửa behavior → tạo V4__fix_status_column.sql
  Nếu là comment/whitespace sai và chưa push lên main → revert + fix
  Nếu đã merge → flyway repair + document lý do
```

### Rule 2: Một migration = Một đơn vị công việc có thể rollback logic

```sql
-- WRONG: V5__mixed_changes.sql
CREATE TABLE new_feature (...);
ALTER TABLE document ADD COLUMN feature_flag BOOLEAN;
DROP TABLE old_cache;
UPDATE config SET value = 'new' WHERE key = 'mode';

-- Nếu fail ở giữa → không biết rollback cái gì
-- Không biết SQL nào đã chạy

-- RIGHT: Tách ra
-- V5__add_new_feature_table.sql
-- V5_1__add_feature_flag_to_document.sql
-- V5_2__drop_old_cache_table.sql
-- V5_3__update_config_mode.sql
-- Mỗi file atomic. Fail file nào → biết chính xác cần xử lý gì
```

### Rule 3: Mọi DDL đều phải backward-compatible trước khi deploy code

```
Expand-Contract Pattern (bắt buộc):

Phase 1 — Expand (DB migration trước):
  - Add column nullable
  - Add new table
  - Add index
  → Deploy DB migration: production đang chạy old code + new schema
  → old code không biết column mới → không sao, column nullable

Phase 2 — Contract (code sau):
  - Code mới dùng column mới
  → Deploy code: production dùng new schema + new code
  → Không có downtime, không có incompatibility

Phase 3 — Cleanup (sau khi code stable, optional):
  - Set NOT NULL nếu cần (sau khi data đã fill)
  - Drop column không còn dùng
  - Drop old table
```

Nguyên tắc cụ thể:

```
SAFE to do anytime:
  ✅ ADD column (nullable)
  ✅ ADD table
  ✅ ADD index (CONCURRENT)
  ✅ ADD constraint (không restrict existing data)
  ✅ CREATE stored procedure (CREATE OR REPLACE)

MUST use Expand-Contract:
  ⚠️ RENAME column → add new column + migrate data + drop old
  ⚠️ RENAME table → add view + migrate + drop view
  ⚠️ CHANGE column type → add new column + migrate + drop old
  ⚠️ ADD NOT NULL constraint → fill data first + add constraint

NEVER do in same deploy as code change:
  ❌ DROP column being used by current code
  ❌ DROP table being read by current code
  ❌ RENAME anything code refers to
  ❌ CHANGE column type breaking serialization
```

### Rule 4: Production migration phải được test trên staging với production data volume

```
Sai lầm phổ biến:
  - Test trên staging với 1000 rows
  - ALTER TABLE document ADD COLUMN... → chạy trong 0.1s
  - Deploy production với 50 triệu rows → table lock 45 phút
  - Service timeout toàn bộ

Checklist trước khi merge migration vào main:

[ ] Đã test trên staging với volume tương đương production?
[ ] EXPLAIN ANALYZE trên query performance sau migration?
[ ] Ước tính execution time ở production data volume?
[ ] Nếu > 30 giây → có kế hoạch minimize lock không?
[ ] Migration có idempotent không? (IF NOT EXISTS, OR REPLACE)
```

### Rule 5: Không bao giờ đặt business logic trong migration

```sql
-- WRONG: Migration làm business logic
-- V8__migrate_old_status_to_new.sql
UPDATE document
SET status_id = (
    SELECT id FROM status WHERE code =
    CASE old_status
        WHEN 'PENDING' THEN 'IN_REVIEW'
        WHEN 'DONE' THEN 'COMPLETED'
        ELSE 'UNKNOWN'
    END
);

-- VẤN ĐỀ:
-- Logic này không được unit test
-- Không audit được ai chạy, khi nào
-- Không rollback được nếu logic sai
-- Khó debug khi status_id bị sai sau này

-- RIGHT: Migration chỉ đổi schema
-- V8__add_new_status_column.sql
ALTER TABLE document ADD COLUMN new_status_id BIGINT;
ALTER TABLE document ADD CONSTRAINT fk_doc_new_status
    FOREIGN KEY (new_status_id) REFERENCES status(id);

-- Logic business: viết code Java (có unit test, có audit, có rollback)
-- DataMigrationService.migrateDocumentStatuses()
-- Chạy qua admin endpoint, có progress tracking, có error reporting
```

### Rule 6: Index migration không được dùng CREATE INDEX thông thường trên bảng lớn

```sql
-- WRONG trên production (bảng 50M rows):
-- V9__add_indexes.sql
CREATE INDEX idx_document_tenant ON document(tenant_code);
-- → Exclusive lock trên toàn bộ bảng trong thời gian build index
-- → Service không thể read/write document trong thời gian đó

-- RIGHT: Tách index ra khỏi app startup

-- Option A: Chạy index migration TRƯỚC deploy, manual trên prod:
-- Psql session:
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_document_tenant
    ON document(tenant_code);
-- CONCURRENTLY: không lock table, chỉ chậm hơn, chạy background

-- Option B: Flyway non-transactional migration (Flyway 9+)
-- Tạo file với prefix đặc biệt và configure nonTransactionalMigrations
-- Hoặc dùng migration wrapper

-- Rule của team:
-- Index trên bảng < 1M rows: OK trong migration file bình thường
-- Index trên bảng > 1M rows: PHẢI chạy CONCURRENTLY, không trong Flyway
-- Flyway chỉ lưu record "index creation script" để audit
```

### Rule 7: Migration phải self-documenting

```sql
-- WRONG:
-- V12__update_tables.sql
ALTER TABLE a ADD COLUMN x INT;
ALTER TABLE b ALTER COLUMN y TYPE BIGINT;

-- Đọc lại 6 tháng sau: không biết tại sao, context là gì

-- RIGHT:
-- V12__expand_document_id_to_bigint_for_volume.sql

-- =============================================================
-- Migration: Expand document.id từ INT → BIGINT
-- Reason: Document count dự kiến vượt 2.1B vào Q3 2025
-- Ticket: PDMS-1234
-- Author: nguyenvana@vpbank.com
-- Reviewed by: tranthib@vpbank.com
-- Risk: MEDIUM — bảng lớn, cần chạy ngoài giờ cao điểm
-- Estimated execution time on prod: ~15 phút (CONCURRENTLY)
-- Rollback plan: Không rollback được sau khi ALTER; phải test kỹ staging
-- =============================================================

-- Step 1: Add new BIGINT column (nullable, immediate)
ALTER TABLE document ADD COLUMN id_new BIGINT;

-- Step 2: Create sequence (sẽ được dùng sau khi migrate)
CREATE SEQUENCE IF NOT EXISTS document_id_bigint_seq;

-- ... (tiếp theo các step)
```

### Rule 8: Có migration "rollback" plan kể cả khi không có Undo

Flyway Community không có Undo. Nhưng TechLead phải có plan:

```
Trước mỗi migration phức tạp, document trong file:

1. FORWARD plan: migration làm gì, theo thứ tự nào
2. VERIFICATION: sau khi chạy, check gì để biết thành công
3. BACKWARD plan: nếu fail, làm gì

Các loại backward plan:
a) No rollback needed: column mới nullable, không break gì
   → Có thể revert code, DB ổn

b) Manual rollback script: chuẩn bị sẵn
   -- rollback_V12.sql (KHÔNG đặt trong db/migration/)
   ALTER TABLE document DROP COLUMN IF EXISTS new_feature_flag;
   
c) Feature flag rollback: code cũ bypass column mới
   → Code có thể disable feature, không cần touch DB

d) Smoke and mirrors: không rollback được
   → Document rõ ràng: "Once applied, this is permanent"
   → Đảm bảo test kỹ hơn trước khi apply production
```

### Rule 9: Migration version = Timestamp cho team nhiều người

```
Version số (V1, V2, V3) → CONFLICT khi nhiều branch song song:
  Branch A: viết V5__feature_a.sql
  Branch B: viết V5__feature_b.sql (cùng lúc)
  Merge → hai V5 conflict → chaos

Giải pháp: Version = Timestamp (recommended cho team > 3 người)
  V20250115_1030__add_tenant_support.sql
  V20250116_0900__add_credit_module_tables.sql
  V20250116_1400__add_audit_indexes.sql

Hoặc: Prefix bằng sprint/ticket:
  V2025S01_001__baseline.sql     ← Sprint 1, migration 001
  V2025S01_002__add_lookups.sql
  V2025S02_001__tenant_support.sql

Rule cho PDMS team:
  Format: V{YYYYMMDD}{HH24MI}__{description}.sql
  Author tự chọn timestamp khi tạo file
  Nếu timestamp trùng: người tạo sau thêm _1, _2...
  Không dùng version số tuyến tính nữa
```

### Rule 10: flyway_schema_history không được touch bằng tay

```
TUYỆT ĐỐI KHÔNG:
  DELETE FROM flyway_schema_history WHERE version = '5';
  UPDATE flyway_schema_history SET success = true WHERE success = false;

Luôn dùng:
  flyway repair    (lệnh chính thức để fix issues)
  flyway validate  (xem trạng thái trước khi action)
  flyway info      (xem tất cả migrations và state)

Nếu ai trong team nói "tôi cần xóa row trong flyway_schema_history":
  → Đó là dấu hiệu có vấn đề lớn hơn cần giải quyết đúng cách
  → Dừng lại, hiểu root cause, dùng flyway repair đúng cách
```

---

## 3. DDL Governance Model — Quy trình kiểm soát thay đổi

### Pipeline bắt buộc cho mọi migration

```
Developer                 Tech Lead              CI/CD                  Production DB
    |                         |                    |                         |
    |-- Viết migration ------->|                    |                         |
    |   (draft branch)        |                    |                         |
    |                         |                    |                         |
    |<-- Review + feedback ----|                    |                         |
    |   (naming, safety,       |                    |                         |
    |    backward compat,      |                    |                         |
    |    risk assessment)      |                    |                         |
    |                         |                    |                         |
    |-- Fix + re-submit ------>|                    |                         |
    |                         |                    |                         |
    |<-- Approved + merge -----|                    |                         |
    |                         |                    |                         |
    |                         |--- CI: flyway validate ------------------>   |
    |                         |--- CI: flyway info (dry run check) ----->   |
    |                         |--- CI: apply to staging ----------------->  |
    |                         |                    |                         |
    |                         |<-- Staging smoke test --------------------|  |
    |                         |                    |                         |
    |                         |--- Manual approval (for prod) ----------->  |
    |                         |                    |                         |
    |                         |--- Deploy to production ------------------>  |
    |                         |                    |                         |
    |                         |<-- Monitor: slow query, locks, errors ----|  |
```

### Migration Review Checklist (cho Tech Lead)

```
NAMING:
[ ] File name theo convention? (V{timestamp}__{verb}_{subject}.sql)
[ ] Description đủ descriptive? Đọc tên file có hiểu không?
[ ] Mô tả đúng những gì file làm?

CONTENT — HEADER:
[ ] Có comment header không? (reason, ticket, author, risk, estimated time)
[ ] Risk level có realistic không? (LOW/MEDIUM/HIGH/CRITICAL)

CONTENT — SAFETY:
[ ] Có IF NOT EXISTS / IF EXISTS ở mọi DDL statement?
[ ] Có CREATE OR REPLACE cho functions/views?
[ ] Không có DROP CASCADE bừa bãi?
[ ] Không có TRUNCATE không cần thiết?

BACKWARD COMPATIBILITY:
[ ] New columns có nullable hoặc có DEFAULT không?
[ ] Không RENAME gì mà code đang dùng?
[ ] Không DROP gì mà code đang dùng?
[ ] Không CHANGE TYPE theo cách không backward-compatible?

PERFORMANCE:
[ ] ALTER TABLE trên bảng lớn: có minimize lock không?
[ ] CREATE INDEX: có dùng CONCURRENTLY không (nếu bảng > 1M rows)?
[ ] UPDATE large table: có batch không?
[ ] Không có Cartesian join hoặc nested select không có index?

TRANSACTIONS:
[ ] File có thể run trong single transaction không?
[ ] Nếu dùng CREATE INDEX CONCURRENTLY → cần non-transactional approach?

IDEMPOTENCY:
[ ] Có thể chạy lại (sau repair) mà không fail?
[ ] IF NOT EXISTS / IF EXISTS ở mọi nơi cần thiết?

ROLLBACK:
[ ] Backward plan được document không?
[ ] Nếu "no rollback possible" → đã test kỹ trên staging chưa?
```

---

## 4. Schema Design Patterns cho 100+ Tables

### Phân nhóm migration theo module

```
db/
└── migration/
    ├── v1_foundation/               ← Toàn bộ schema baseline
    │   ├── V20250101_0000__bootstrap_extensions.sql
    │   ├── V20250101_0001__create_lookup_tables.sql
    │   ├── V20250101_0002__create_iam_tables.sql
    │   ├── V20250101_0003__create_document_tables.sql
    │   ├── V20250101_0004__create_credit_tables.sql
    │   ├── V20250101_0005__create_warehouse_tables.sql
    │   ├── V20250101_0006__create_audit_tables.sql
    │   ├── V20250101_0007__add_foreign_keys_foundation.sql
    │   └── V20250101_0008__create_foundation_indexes.sql
    │
    ├── v2_features/                 ← Feature increments
    │   ├── V20250201_0900__expand_tenant_support.sql
    │   └── V20250215_1400__add_notification_tables.sql
    │
    └── v3_performance/              ← Performance tuning schema
        └── V20250301_1000__add_composite_indexes.sql
```

Flyway không cần subfolder structure đặc biệt — nó scan đệ quy. Nhưng việc phân nhóm giúp onboarding và audit dễ hơn nhiều.

### Bảng audit toàn hệ thống — Template chuẩn

```sql
-- V20250101_0006__create_audit_tables.sql
-- Mọi bảng business đều inherit pattern này

-- Audit log centralized
CREATE TABLE system_audit_log (
    id              BIGSERIAL       PRIMARY KEY,
    entity_type     VARCHAR(100)    NOT NULL,   -- 'DOCUMENT', 'CREDIT_CASE'
    entity_id       VARCHAR(100)    NOT NULL,   -- UUID hoặc business key
    action          VARCHAR(50)     NOT NULL,   -- 'CREATE', 'UPDATE', 'DELETE'
    old_data        JSONB,                      -- Snapshot trước thay đổi
    new_data        JSONB,                      -- Snapshot sau thay đổi
    changed_fields  TEXT[],                     -- ["status_id", "updated_by"]
    performed_by    VARCHAR(100)    NOT NULL,   -- User ID
    performed_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    tenant_code     VARCHAR(20)     NOT NULL,
    correlation_id  UUID,                       -- Trace ID từ request
    source_service  VARCHAR(100)                -- 'process-management', 'iam'
);

-- Partitioning theo tháng (cần thiết cho 100M+ audit rows)
-- Partition sẽ được tạo dynamic bởi pg_partman hoặc manual

CREATE INDEX idx_audit_entity ON system_audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_performed_at ON system_audit_log(performed_at DESC);
CREATE INDEX idx_audit_tenant ON system_audit_log(tenant_code, performed_at DESC);
```

### Soft delete pattern nhất quán

```sql
-- Pattern áp dụng cho mọi bảng có business data
-- V20250101_0003__create_document_tables.sql (excerpt)

CREATE TABLE document (
    -- === IDENTITY ===
    id              UUID            NOT NULL DEFAULT gen_random_uuid(),
    document_code   VARCHAR(50)     NOT NULL,   -- Business key

    -- === BUSINESS FIELDS ===
    case_id         UUID            NOT NULL,
    warehouse_id    UUID            NOT NULL,
    status_id       BIGINT          NOT NULL,
    tenant_code     VARCHAR(20)     NOT NULL,

    -- === LIFECYCLE TIMESTAMPS ===
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    created_by      VARCHAR(100)    NOT NULL,
    updated_at      TIMESTAMPTZ,
    updated_by      VARCHAR(100),

    -- === SOFT DELETE (bắt buộc cho mọi bảng business) ===
    is_deleted      BOOLEAN         NOT NULL DEFAULT FALSE,
    deleted_at      TIMESTAMPTZ,
    deleted_by      VARCHAR(100),

    -- === VERSION (Optimistic Locking) ===
    version         INT             NOT NULL DEFAULT 0,

    CONSTRAINT pk_document PRIMARY KEY (id),
    CONSTRAINT uq_document_code UNIQUE (document_code)
);

-- Partial index cho common queries (chỉ non-deleted)
CREATE INDEX idx_document_active ON document(tenant_code, status_id)
    WHERE is_deleted = FALSE;

-- Comment bắt buộc
COMMENT ON TABLE document IS 'Hồ sơ vật lý tín dụng — core entity PDMS';
COMMENT ON COLUMN document.version IS 'Optimistic locking version — tăng mỗi UPDATE';
COMMENT ON COLUMN document.is_deleted IS 'Soft delete flag — không bao giờ DELETE vật lý';
```

### Lookup tables pattern

```sql
-- V20250101_0001__create_lookup_tables.sql
-- Mọi "master data" đều theo pattern này

-- Generic lookup (cho các danh mục nhỏ)
CREATE TABLE lookup_category (
    id          BIGSERIAL   PRIMARY KEY,
    code        VARCHAR(50) NOT NULL,
    name        VARCHAR(200) NOT NULL,
    description TEXT,
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    sort_order  INT         NOT NULL DEFAULT 0,
    parent_id   BIGINT      REFERENCES lookup_category(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_lookup_code UNIQUE (code)
);

-- Specific lookup (cho danh mục có nhiều thuộc tính riêng)
CREATE TABLE document_status (
    id              BIGSERIAL   PRIMARY KEY,
    code            VARCHAR(50) NOT NULL,
    name_vi         VARCHAR(200) NOT NULL,
    name_en         VARCHAR(200),
    is_terminal     BOOLEAN     NOT NULL DEFAULT FALSE,  -- trạng thái cuối
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    allowed_transitions BIGINT[],  -- Array of status IDs có thể chuyển sang
    CONSTRAINT uq_doc_status_code UNIQUE (code)
);

COMMENT ON COLUMN document_status.is_terminal IS
    'TRUE = không thể chuyển sang status khác (ARCHIVED, COMPLETED)';
COMMENT ON COLUMN document_status.allowed_transitions IS
    'Array of document_status.id mà status này có thể transition sang';
```

---

## 5. Xử lý Tình huống Khó

### Tình huống 1: Onboard DB có sẵn (không từ đầu)

```
Bài toán: PDMS đang chạy, có 80 bảng, chưa có Flyway.
Làm sao integrate Flyway mà không phá gì?

Bước 1: Dump schema hiện tại KHÔNG có data
pg_dump --schema-only --no-owner --no-acl \
  -d pdms_db -f V1__Baseline_existing_schema.sql

Bước 2: Chỉnh sửa file dump
  - Remove DROP statements (nếu có)
  - Add IF NOT EXISTS ở mọi CREATE
  - Remove sequence reset nếu không cần
  - Chia nhỏ nếu quá lớn (tuỳ chọn)

Bước 3: Configure Flyway baseline
spring:
  flyway:
    baseline-on-migrate: true
    baseline-version: "1"
    baseline-description: "Existing PDMS schema before Flyway"

Bước 4: Chạy baseline (CHỈ làm trên mọi môi trường chưa có flyway_schema_history)
flyway baseline

Kết quả: flyway_schema_history có 1 row:
  version=1, type=BASELINE, success=true

Bước 5: Mọi migration sau đó (V2 trở đi) hoạt động bình thường

QUAN TRỌNG:
  - baseline-on-migrate: true CHỈ để true trong lần đầu onboard
  - Sau khi tất cả môi trường đã có baseline → đổi lại false
  - File V1 (baseline) không cần run thực sự — chỉ là dấu mốc
```

### Tình huống 2: Migration fail ở production giữa chừng

```
Timeline:
  14:00 - Deploy V15__add_credit_scoring_tables.sql lên production
  14:03 - Flyway bắt đầu chạy migration
  14:07 - ERROR: null value in column "score_type_id" violates not-null constraint

Tình trạng:
  - flyway_schema_history: V15, success=false
  - DB: một phần schema đã tạo, một phần chưa
  - App: không thể start (Flyway fail → Spring context fail)

Xử lý:

Step 1 — Assess damage (không làm gì vội)
  psql production
  SELECT installed_rank, version, description, success
  FROM flyway_schema_history ORDER BY installed_rank;
  
  -- Xem exactly cái gì đã chạy trong transaction
  -- PostgreSQL: nếu migration chạy trong 1 transaction và fail
  --   → toàn bộ bị rollback automatically (PostgreSQL DDL là transactional)
  -- Kiểm tra: bảng mới có tồn tại không?
  \dt credit_scoring*

Step 2 — Fix the migration
  -- Option A: Migration fail và PostgreSQL đã rollback toàn bộ
  --   → Fix SQL trong file V15 → flyway repair → redeploy
  
  -- Option B: Migration fail và đã chạy PARTIAL (có statement DML, non-transactional)
  --   → Cần manual cleanup trước khi repair
  --   → DROP những gì đã tạo → flyway repair → fix → redeploy

Step 3 — flyway repair
  flyway repair
  -- Xóa row failed khỏi history
  -- Cập nhật checksum nếu đã sửa file

Step 4 — Verify
  flyway info
  -- V15 không còn trong history
  -- V15 status: Pending

Step 5 — Redeploy với file đã fix
  -- Rollout → Flyway chạy lại V15 từ đầu

LESSON LEARNED:
  - Luôn test migration trên staging với data tương tự prod
  - Sử dụng IF NOT EXISTS để migration có thể retry an toàn
  - Với PostgreSQL: DDL trong 1 transaction → rollback tự động nếu fail
  - Đây là lý do tại sao "1 file = 1 atomic unit" là quan trọng
```

### Tình huống 3: Hai branch tạo migration cùng version

```
Bài toán:
  Branch A (developer Hùng): V20250115_1000__add_notification.sql
  Branch B (developer Lan): V20250115_1000__add_reporting.sql (cùng timestamp!)
  Cả hai merge vào main → conflict

Cách phòng tránh:
  1. Convention: Timestamp tính theo giờ thực tế TẠO FILE (không phải giờ merge)
  2. CI/CD check: validate không có 2 files cùng version trong migration folder
  3. Developer thêm suffix nếu conflict: V20250115_1000_A và V20250115_1000_B

Cách xử lý khi đã conflict:
  - Người merge chịu trách nhiệm resolve
  - Rename một trong hai: V20250115_1001__add_reporting.sql
  - Nếu một trong hai đã deploy lên staging: cái đó giữ nguyên, cái kia đổi
  - Nếu chưa deploy đâu cả: đổi cái nào cũng được, ưu tiên cái "ít quan trọng hơn" đổi

Script CI check:
  #!/bin/bash
  # Chạy trong CI để detect duplicate versions
  duplicates=$(find db/migration -name "V*.sql" | \
    sed 's/.*\(V[0-9_]*\)__.*/\1/' | sort | uniq -d)
  if [ -n "$duplicates" ]; then
    echo "ERROR: Duplicate migration versions detected: $duplicates"
    exit 1
  fi
```

### Tình huống 4: Cần thêm NOT NULL column vào bảng 50M rows

```sql
-- WRONG (downtime):
ALTER TABLE document ADD COLUMN priority_score INT NOT NULL DEFAULT 0;
-- Trên PostgreSQL < 11: rewrite toàn bộ table → lock hàng giờ
-- Trên PostgreSQL >= 11: với constant DEFAULT, no rewrite (fast)
-- Nhưng nếu DEFAULT là expression (NOW(), gen_random_uuid()): vẫn rewrite

-- Quy trình an toàn cho bất kỳ trường hợp nào:

-- Migration 1: V20250201_0900__add_priority_score_nullable.sql
ALTER TABLE document
    ADD COLUMN IF NOT EXISTS priority_score INT;
-- Nullable, không có DEFAULT → immediate, không lock

-- (Deploy code v1: đọc/ghi priority_score nếu có, dùng null-safe logic)

-- Migration 2: V20250205_1000__backfill_priority_score.sql
-- Chạy trong giờ thấp điểm, outside of deployment
DO $$
DECLARE
    batch_size  INT := 10000;
    last_id     UUID := '00000000-0000-0000-0000-000000000000';
    batch_count INT := 0;
BEGIN
    LOOP
        WITH batch AS (
            SELECT id FROM document
            WHERE priority_score IS NULL
              AND id > last_id
            ORDER BY id
            LIMIT batch_size
        )
        UPDATE document d
        SET priority_score = 0
        FROM batch b
        WHERE d.id = b.id;

        GET DIAGNOSTICS batch_count = ROW_COUNT;
        EXIT WHEN batch_count = 0;

        SELECT MAX(id) INTO last_id
        FROM document WHERE priority_score IS NULL RETURNING id;
        -- Actually: track last processed id

        PERFORM pg_sleep(0.1); -- Breathing room cho production queries
    END LOOP;
END $$;

-- Migration 3: V20250210_0900__set_priority_score_not_null.sql
-- Chạy sau khi đã verify toàn bộ data đã fill
ALTER TABLE document
    ALTER COLUMN priority_score SET NOT NULL,
    ALTER COLUMN priority_score SET DEFAULT 0;
-- Fast trên PostgreSQL nếu không cần rewrite (constraint check fast khi data đã fill)
```

---

## 6. CI/CD Integration — Production-grade Pipeline

### GitHub Actions workflow

```yaml
# .github/workflows/db-migration.yml
name: Database Migration

on:
  push:
    paths:
      - 'src/main/resources/db/**'
    branches: [main, staging]

jobs:
  validate-migrations:
    name: Validate Migration Files
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check duplicate versions
        run: |
          duplicates=$(find src/main/resources/db/migration -name "V*.sql" | \
            sed 's/.*\(V[0-9_]*\)__.*/\1/' | sort | uniq -d)
          if [ -n "$duplicates" ]; then
            echo "❌ Duplicate migration versions: $duplicates"
            exit 1
          fi
          echo "✅ No duplicate versions"

      - name: Check naming convention
        run: |
          find src/main/resources/db/migration -name "*.sql" | while read f; do
            basename "$f" | grep -qE '^(V[0-9]{8}_[0-9]{4}__|R__[0-9]{3}_).+\.sql$' || \
              { echo "❌ Invalid naming: $f"; exit 1; }
          done
          echo "✅ Naming convention OK"

      - name: Flyway validate against staging
        run: |
          flyway validate \
            -url=${{ secrets.STAGING_DB_URL }} \
            -user=${{ secrets.STAGING_FLYWAY_USER }} \
            -password=${{ secrets.STAGING_FLYWAY_PASSWORD }} \
            -locations=filesystem:src/main/resources/db/migration
        env:
          FLYWAY_EDITION: community

      - name: Flyway info (check pending)
        run: |
          flyway info \
            -url=${{ secrets.STAGING_DB_URL }} \
            -user=${{ secrets.STAGING_FLYWAY_USER }} \
            -password=${{ secrets.STAGING_FLYWAY_PASSWORD }} \
            -locations=filesystem:src/main/resources/db/migration

  apply-staging:
    name: Apply to Staging
    needs: validate-migrations
    runs-on: ubuntu-latest
    environment: staging
    if: github.ref == 'refs/heads/staging'
    steps:
      - name: Flyway migrate staging
        run: |
          flyway migrate \
            -url=${{ secrets.STAGING_DB_URL }} \
            -user=${{ secrets.STAGING_FLYWAY_USER }} \
            -password=${{ secrets.STAGING_FLYWAY_PASSWORD }} \
            -locations=filesystem:src/main/resources/db/migration \
            -outOfOrder=false \
            -validateOnMigrate=true

  apply-production:
    name: Apply to Production (Manual Approval)
    needs: apply-staging
    runs-on: ubuntu-latest
    environment: production  # GitHub environment với required reviewers
    if: github.ref == 'refs/heads/main'
    steps:
      - name: Pre-migration info
        run: flyway info -url=${{ secrets.PROD_DB_URL }} ...

      - name: Apply production migration
        run: |
          flyway migrate \
            -url=${{ secrets.PROD_DB_URL }} \
            -user=${{ secrets.PROD_FLYWAY_USER }} \
            -password=${{ secrets.PROD_FLYWAY_PASSWORD }} \
            -cleanDisabled=true \
            -outOfOrder=false \
            -validateOnMigrate=true

      - name: Post-migration verification
        run: |
          # Chạy smoke test queries
          psql ${{ secrets.PROD_DB_URL }} -c "
            SELECT COUNT(*) as pending_migrations
            FROM flyway_schema_history
            WHERE success = false;
          "
```

### Dedicated Flyway DB User (bắt buộc)

```sql
-- Chạy một lần, bằng DB admin
-- Flyway user chỉ có quyền DDL, không có quyền DML production data

CREATE USER flyway_user WITH PASSWORD 'strong_password_here';

-- Quyền cơ bản
GRANT CONNECT ON DATABASE pdms_db TO flyway_user;
GRANT USAGE ON SCHEMA public TO flyway_user;
GRANT CREATE ON SCHEMA public TO flyway_user;

-- Flyway cần CREATE TABLE (cho flyway_schema_history)
GRANT CREATE ON SCHEMA public TO flyway_user;

-- Quyền trên existing tables (nếu migration cần ALTER existing)
GRANT ALL ON ALL TABLES IN SCHEMA public TO flyway_user;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO flyway_user;

-- Future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON TABLES TO flyway_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON SEQUENCES TO flyway_user;

-- KHÔNG grant: DELETE, TRUNCATE trên production data tables
-- KHÔNG grant: Superuser, REPLICATION

COMMENT ON ROLE flyway_user IS
    'Dedicated user cho Flyway migration — chỉ dùng trong CI/CD pipeline';
```

---

## 7. Monitoring và Alerting

### Dashboard queries cho Tech Lead

```sql
-- Query 1: Trạng thái migration giữa các môi trường
-- (Chạy trên từng môi trường, so sánh kết quả)
SELECT
    version,
    description,
    type,
    installed_on,
    execution_time || 'ms' AS exec_time,
    CASE success WHEN true THEN '✅' ELSE '❌' END AS status
FROM flyway_schema_history
ORDER BY installed_rank DESC
LIMIT 20;

-- Query 2: Migrations chạy lâu bất thường (> 30 giây)
SELECT
    version,
    description,
    script,
    execution_time,
    installed_on,
    installed_by
FROM flyway_schema_history
WHERE execution_time > 30000  -- 30 giây
ORDER BY execution_time DESC;

-- Query 3: History migrations trong 7 ngày qua
SELECT
    DATE(installed_on) AS migration_date,
    COUNT(*) AS migrations_applied,
    SUM(execution_time) AS total_time_ms,
    MAX(CASE success WHEN false THEN 1 ELSE 0 END) AS had_failures
FROM flyway_schema_history
WHERE installed_on > NOW() - INTERVAL '7 days'
GROUP BY DATE(installed_on)
ORDER BY migration_date DESC;

-- Query 4: Repeatable migrations cần re-run (bị outdated)
-- Không thể query trực tiếp vì Flyway manage này
-- Dùng: flyway info | grep Outdated
```

### Alert nên có

```
1. Alert: flyway_schema_history có row success=false
   → PagerDuty severity HIGH
   → Nghĩa là có migration fail, app có thể không start

2. Alert: Execution time migration > 60 seconds
   → Slack warning
   → Cần review xem có lock table không

3. Alert: flyway_schema_history không có thêm row trong 30 ngày
   → Slack info: "Reminder: DB migration stale, đã có update nào chưa?"

4. Alert: flyway_schema_history count khác nhau giữa staging và prod
   → Slack warning: schema drift detected
```

---

## 8. Schema Documentation — Bắt buộc cho 100+ Tables

### Tự động generate schema documentation

```sql
-- Query xuất documentation cho tất cả tables
SELECT
    t.table_name,
    obj_description(pc.oid, 'pg_class') AS table_comment,
    c.column_name,
    c.data_type,
    c.character_maximum_length,
    c.is_nullable,
    c.column_default,
    pgd.description AS column_comment
FROM
    information_schema.tables t
    JOIN pg_class pc ON pc.relname = t.table_name
    JOIN information_schema.columns c
        ON c.table_name = t.table_name AND c.table_schema = t.table_schema
    LEFT JOIN pg_catalog.pg_statio_all_tables st
        ON st.relname = t.table_name
    LEFT JOIN pg_catalog.pg_description pgd
        ON pgd.objoid = pc.oid AND pgd.objsubid = c.ordinal_position
WHERE
    t.table_schema = 'public'
    AND t.table_type = 'BASE TABLE'
ORDER BY
    t.table_name, c.ordinal_position;
```

```sql
-- Flyway migration để enforce table comments
-- V20250101_0099__add_table_comments.sql

DO $$
DECLARE
    tables_without_comment RECORD;
BEGIN
    FOR tables_without_comment IN
        SELECT t.table_name
        FROM information_schema.tables t
        LEFT JOIN pg_class pc ON pc.relname = t.table_name
        WHERE t.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND obj_description(pc.oid, 'pg_class') IS NULL
          AND t.table_name NOT LIKE 'flyway_%'
    LOOP
        RAISE WARNING 'Table % has no comment', tables_without_comment.table_name;
    END LOOP;
END $$;
```

---

## 9. Quick Reference — Lệnh thường dùng hàng ngày

```bash
# === THƯỜNG DÙNG NHẤT ===

# Xem trạng thái tất cả migrations
flyway info

# Apply pending migrations (staging/dev)
flyway migrate

# Validate files vs DB history
flyway validate

# Fix failed migration (sau khi đã sửa file)
flyway repair

# === DEBUG ===

# Xem migration nào đang pending
flyway info | grep Pending

# Xem migration nào outdated (repeatable)
flyway info | grep Outdated

# Dry run (Teams only, nhưng có thể simulate với validate)
flyway validate -ignorePendingMigrations=false

# === KHI CÓ VẤN ĐỀ ===

# Check checksum của file hiện tại vs database
flyway validate 2>&1 | grep -A5 "checksum mismatch"

# Xem chi tiết execution history
psql -c "SELECT * FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 10;"

# === NEVER ON PRODUCTION ===
# flyway clean     ← DROP toàn bộ DB
# flyway undo      ← Chỉ có Teams edition
# Manual DELETE FROM flyway_schema_history
```

---

## 10. Kinh nghiệm Thực Tế từ Production

### Top 5 sai lầm phổ biến nhất

```
1. ALTER TABLE ADD COLUMN NOT NULL không có DEFAULT
   → Table lock hoặc error trên data có sẵn
   → FIX: Luôn thêm DEFAULT hoặc dùng Expand-Contract

2. CREATE INDEX không có CONCURRENTLY trên bảng lớn
   → Exclusive lock, service timeout
   → FIX: CONCURRENTLY cho bảng > 1M rows, chạy ngoài deploy window

3. Sửa file migration đã chạy để fix typo
   → Checksum mismatch trên production
   → FIX: Tạo migration mới; dùng flyway repair chỉ khi hiểu rõ consequences

4. Migration có data transformation phức tạp không có batch
   → Table lock lâu, connection pool exhausted
   → FIX: Batch + pg_sleep + separate migration cho data vs schema

5. out-of-order migration xuất hiện ở production
   → Schema dependency violation, ứng dụng crash
   → FIX: Version = timestamp, conflict detection trong CI
```

### Checklist khi deploy migration lên Production

```
T-24h (ngày hôm trước):
[ ] Migration đã test trên staging với production data volume
[ ] Execution time đã đo: _____ giây
[ ] Backward-compatible: code cũ chạy được với schema mới
[ ] Rollback plan được document

T-1h (trước deploy):
[ ] Notify stakeholders nếu migration > 30 giây
[ ] DB backup chạy thành công
[ ] Monitoring dashboard mở sẵn
[ ] Rollback script prepare (nếu có)

T-0 (deploy):
[ ] flyway info để xác nhận pending
[ ] Deploy
[ ] Watch logs: flyway migration bắt đầu
[ ] Confirm: flyway_schema_history có row mới, success=true
[ ] Smoke test: các endpoint chính hoạt động

T+15m (sau deploy):
[ ] Slow query log: không có query mới chạy chậm
[ ] Error rate: không tăng
[ ] Connection pool: stable
[ ] Sign off
```

---

## Summary — TechLead Flyway Mindset

```
Schema là contract, không phải implementation detail.
Migration là lịch sử không thể xóa.
Mọi thay đổi phải backward-compatible.
Performance test trước khi production.
Automation (CI/CD) là safety net, không thay thế discipline.

Công cụ mạnh nhất của TechLead không phải là Flyway features —
mà là culture: team hiểu WHY mỗi rule tồn tại,
không chỉ follow như checklist mù.
```

---

**Related**: [[DBMigration-01-Flyway-Deep-Dive]] | [[DBMigration-04-Enterprise-Patterns]] | [[DBMigration-05-Adoption-Roadmap]]

#flyway #tech-lead #database-governance #ddl #migration #production #postgresql #pdms
