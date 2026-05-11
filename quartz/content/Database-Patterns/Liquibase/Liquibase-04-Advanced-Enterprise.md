# Liquibase 04 — Advanced Enterprise: Multi-schema, Multi-tenant, Diff & generateChangeLog

> **Mục tiêu**: Các pattern nâng cao cho enterprise — đặc biệt là `diff` và `generateChangeLog` để giải quyết bài toán compare scripts trước golive.

**Series**: [[Liquibase-MOC]] | **Prev**: [[Liquibase-03-Changelog-Mastery]] | **Next**: [[Liquibase-05-CICD-Production-Workflow]]

---

## 1. Liquibase diff — Vũ khí so sánh schema

Đây là tính năng **quan trọng nhất** để giải quyết pain khi golive: so sánh schema giữa các môi trường chỉ bằng 1 lệnh.

### Cơ chế hoạt động

```
liquibase diff:
  ┌─────────────┐         ┌─────────────────┐
  │  Reference  │  diff   │    Target       │
  │  Database   │ ──────► │    Database     │
  │  (source)   │         │  (so sánh với)  │
  └─────────────┘         └─────────────────┘
                               ↓
                    Missing Tables, Extra Columns,
                    Different Indexes, Changed FKs...
```

### Chạy diff giữa 2 environments

```bash
liquibase diff \
  --url=jdbc:postgresql://staging-db:5432/pdms \
  --username=liquibase \
  --password=staging_pass \
  --referenceUrl=jdbc:postgresql://prod-db:5432/pdms \
  --referenceUsername=liquibase \
  --referencePassword=prod_pass
```

```
# Output ví dụ:
# Diff Results:
# Missing Table(s): NONE
# Unexpected Table(s): tsdb_metric (staging có, prod không có)
# Changed Table(s):
#   document:
#     Missing Column(s): priority (prod có, staging thiếu)
#     Changed Column(s):
#       status_id: prod=BIGINT, staging=INT (type khác!)
# Missing Index(es):
#   idx_document_tenant_status (prod có nhưng staging thiếu)
```

### diffTypes — Giới hạn scope

```bash
# Chỉ compare tables và columns
liquibase diff --diffTypes=tables,columns

# Compare tất cả (mặc định)
liquibase diff --diffTypes=tables,columns,indexes,foreignKeys,
                             primaryKeys,uniqueConstraints,sequences,views
```

---

## 2. diffChangeLog — Auto-generate migration script từ diff

```bash
# Generate changelog XML từ diff giữa staging và prod
liquibase diffChangeLog \
  --changeLogFile=diff-staging-to-prod.xml \
  --url=jdbc:postgresql://prod-db:5432/pdms \
  --referenceUrl=jdbc:postgresql://staging-db:5432/pdms
```

### Output ví dụ

```xml
<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog" ...>

    <!-- Staging có table mới chưa có trên prod -->
    <changeSet id="1" author="liquibase-diff">
        <createTable tableName="tsdb_metric">
            <column name="id" type="UUID"><constraints primaryKey="true"/></column>
            <column name="metric_name" type="VARCHAR(200)"/>
            <column name="tenant_code" type="VARCHAR(20)"/>
            <column name="recorded_at" type="TIMESTAMP WITH TIME ZONE"/>
        </createTable>
    </changeSet>

    <!-- Column bị thiếu -->
    <changeSet id="2" author="liquibase-diff">
        <addColumn tableName="document">
            <column name="priority" type="INT"/>
        </addColumn>
    </changeSet>

    <!-- Index bị thiếu -->
    <changeSet id="3" author="liquibase-diff">
        <createIndex indexName="idx_document_tenant_status" tableName="document">
            <column name="tenant_code"/>
            <column name="status_id"/>
        </createIndex>
    </changeSet>

</databaseChangeLog>
```

> ⚠️ **Quan trọng**: File này được generate tự động — phải **review trước khi apply**! Liquibase diff không biết business context, có thể generate `dropColumn` nếu prod có column mà staging không có.

---

## 3. generateChangeLog — Bootstrap từ DB có sẵn

Khi có DB đang chạy nhưng **chưa có changelog** — tình huống phổ biến khi mới áp dụng Liquibase:

```bash
liquibase generateChangeLog \
  --changeLogFile=initial-schema.xml \
  --url=jdbc:postgresql://existing-db:5432/pdms \
  --username=liquibase \
  --password=password \
  --diffTypes=tables,columns,indexes,foreignKeys,sequences,views
```

### Workflow áp dụng Liquibase cho project PDMS đang chạy

```
Bước 1: generateChangeLog từ Prod DB hiện tại
         → initial-changelog.xml (snapshot toàn bộ schema)

Bước 2: Review và rename changeset ID cho meaningful
         (Liquibase generate ID kiểu "1", "2", "3" — đổi lại cho rõ)

Bước 3: changelogSync trên CHÍNH Prod DB
         → Ghi toàn bộ changeset vào DATABASECHANGELOG như đã chạy
         → Liquibase KHÔNG chạy lại bất kỳ cái gì

Bước 4: Từ đây về sau, mọi thay đổi đều qua Liquibase
         → Tạo changeset mới cho mỗi ALTER TABLE, v.v.

Bước 5: Đồng bộ các env khác (staging, dev)
         → liquibase update ← chạy tất cả pending changeset
```

```bash
# Bước 3: changelogSync — "Pretend đã chạy"
liquibase changelogSync \
  --url=jdbc:postgresql://prod-db:5432/pdms_prod

# Verify — phải thấy 0 pending
liquibase status
# → "0 changesets have not been applied" ✅
```

---

## 4. Multi-Schema Strategy

### PDMS context: nhiều schema trên cùng 1 DB

```
pdms_db
├── public   ← Schema mặc định (document, case, warehouse...)
├── iam      ← pdms-iam-service tables (sau khi migrate AuthZ)
├── process  ← pdms-process-management tables
└── reporting← Reporting/analytics tables
```

### Tạo schema và cross-schema references

```xml
<changeSet id="create-iam-schema" author="bach" labels="v2.0.0">
    <sql>CREATE SCHEMA IF NOT EXISTS iam;</sql>
    <rollback><sql>DROP SCHEMA IF EXISTS iam CASCADE;</sql></rollback>
</changeSet>

<changeSet id="create-table-iam-user" author="bach" labels="v2.0.0">
    <createTable tableName="iam_user" schemaName="iam">
        <column name="id" type="UUID"><constraints primaryKey="true"/></column>
        <column name="username" type="VARCHAR(100)">
            <constraints nullable="false" unique="true"/>
        </column>
        <column name="email" type="VARCHAR(255)"/>
        <column name="is_active" type="BOOLEAN" defaultValueBoolean="true"/>
    </createTable>
</changeSet>

<!-- Cross-schema FK: public.document → iam.iam_user -->
<changeSet id="add-fk-document-created-by-iam-user" author="bach" labels="v2.0.0">
    <addForeignKeyConstraint
        constraintName="fk_document_created_by_iam_user"
        baseTableSchemaName="public"
        baseTableName="document"
        baseColumnNames="created_by_user_id"
        referencedTableSchemaName="iam"
        referencedTableName="iam_user"
        referencedColumnNames="id"/>
</changeSet>
```

---

## 5. Multi-Tenant Strategy

### Pattern 1: Tenant Column (PDMS approach)

```xml
<changeSet id="add-tenant-support-v2" author="bach" labels="v2.0.0">
    <preConditions onFail="MARK_RAN">
        <not><columnExists tableName="document" columnName="tenant_code"/></not>
    </preConditions>
    <addColumn tableName="document">
        <column name="tenant_code" type="VARCHAR(20)" defaultValue="VPBANK">
            <constraints nullable="false"/>
        </column>
    </addColumn>
</changeSet>

<!-- Index cho tenant queries — CONCURRENT để không lock production -->
<changeSet id="add-idx-document-tenant-v2" author="bach"
           labels="v2.0.0" runInTransaction="false">
    <sql>
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_document_tenant_code
        ON document(tenant_code) WHERE deleted = false;
    </sql>
    <rollback>DROP INDEX CONCURRENTLY IF EXISTS idx_document_tenant_code;</rollback>
</changeSet>
```

### Pattern 2: Batch fill data cho tenant migration

```xml
<!-- Batch UPDATE để tránh lock quá lâu trên table lớn -->
<changeSet id="fill-tenant-code-existing-data" author="bach" labels="v2.0.0">
    <sql>
        DO $$
        DECLARE
            batch_size INT := 10000;
            rows_updated INT;
        BEGIN
            LOOP
                UPDATE document
                SET tenant_code = 'VPBANK'
                WHERE tenant_code IS NULL
                  AND id IN (
                      SELECT id FROM document
                      WHERE tenant_code IS NULL
                      ORDER BY id
                      LIMIT batch_size
                  );

                GET DIAGNOSTICS rows_updated = ROW_COUNT;
                EXIT WHEN rows_updated = 0;

                PERFORM pg_sleep(0.1);  -- Nhường CPU cho queries khác
            END LOOP;
        END $$;
    </sql>
</changeSet>
```

---

## 6. Advanced Preconditions

### Custom SQL Precondition

```xml
<changeSet id="migrate-document-code-format" author="bach">
    <preConditions onFail="MARK_RAN" onError="HALT">
        <!-- Chỉ migrate nếu có data cũ format cần migrate -->
        <sqlCheck expectedResult="0">
            SELECT COUNT(*) FROM document
            WHERE document_code NOT LIKE 'DOC-%'
              AND document_code IS NOT NULL
        </sqlCheck>
    </preConditions>
    <sql>
        UPDATE document
        SET document_code = 'DOC-' || document_code
        WHERE document_code NOT LIKE 'DOC-%';
    </sql>
</changeSet>
```

### Nested preconditions AND/OR

```xml
<changeSet id="complex-migration" author="bach">
    <preConditions onFail="HALT">
        <and>
            <tableExists tableName="document"/>
            <or>
                <columnExists tableName="document" columnName="old_status"/>
                <sqlCheck expectedResult="0">
                    SELECT COUNT(*) FROM document WHERE status_id IS NULL
                </sqlCheck>
            </or>
        </and>
    </preConditions>
    <!-- ... -->
</changeSet>
```

---

## 7. Rollback Strategies

### Tag-based Rollback (recommended cho production)

```bash
# Trước khi golive: đánh tag
liquibase tag --tag v1.1.0-pre-deploy

# Xem SQL rollback sẽ chạy (dry run, an toàn)
liquibase rollbackSQL --tag v1.1.0-pre-deploy > rollback-preview.sql

# Nếu cần rollback thật:
liquibase rollback --tag v1.1.0-pre-deploy
```

### Auto-tag trong changelog

```xml
<!-- Đặt ở cuối mỗi version's changeset list -->
<changeSet id="tag-v1.1.0" author="bach" labels="v1.1.0">
    <tagDatabase tag="v1.1.0"/>
</changeSet>
```

### Date-based Rollback

```bash
liquibase rollbackToDate "2024-11-20 09:00:00"
```

---

## 8. Snapshot — Offline Diff

```bash
# Tạo snapshot của DB hiện tại
liquibase snapshot \
  --snapshotFormat=json \
  --outputFile=prod-snapshot-2024-11-20.json

# So sánh DB với snapshot cũ (offline, không cần kết nối prod)
liquibase diff \
  --url=offline:json?snapshot=prod-snapshot-2024-11-20.json \
  --referenceUrl=jdbc:postgresql://staging-db:5432/pdms
```

> 💡 Dùng snapshot khi cần compare với prod nhưng không muốn tạo live connection từ dev machine vào prod DB.

---

## 9. Handling Existing Database — Brownfield Migration PDMS

### Workflow đầy đủ khi onboard PDMS vào Liquibase

```bash
# === PHASE 1: Generate initial state ===

# 1. Tạo snapshot toàn bộ schema prod hiện tại
liquibase generateChangeLog \
  --changeLogFile=src/main/resources/db/changelog/migrations/v1.0.0/000-initial-schema.xml \
  --url=jdbc:postgresql://prod-db:5432/pdms_prod \
  --diffTypes=tables,columns,indexes,foreignKeys,primaryKeys,sequences,uniqueConstraints

# 2. Review file (đổi ID, thêm author, labels)
# vim 000-initial-schema.xml

# === PHASE 2: Bootstrap trên Prod ===

# 3. Sync — không chạy gì cả, chỉ ghi vào DATABASECHANGELOG
liquibase changelogSync \
  --url=jdbc:postgresql://prod-db:5432/pdms_prod \
  --username=$LIQUIBASE_USER \
  --password=$LIQUIBASE_PASS

# 4. Verify
liquibase status --url=jdbc:postgresql://prod-db:5432/pdms_prod
# → "0 changesets have not been applied" ✅

# === PHASE 3: Sync các env khác ===

# 5. Staging: Có thể thiếu một số objects → liquibase update
liquibase update \
  --url=jdbc:postgresql://staging-db:5432/pdms_staging \
  --contexts=staging

# 6. Dev: tương tự
liquibase update --url=jdbc:postgresql://localhost:5432/pdms_dev --contexts=dev
```

---

## Summary

```
Advanced patterns quan trọng nhất:

1. diff            → Phát hiện sự khác biệt giữa 2 DB (1 lệnh thay vì diff 200 file)
2. diffChangeLog   → Auto-generate migration script từ diff
3. generateChangeLog → Bootstrap Liquibase cho DB có sẵn (PDMS hiện tại)
4. changelogSync   → "Pretend đã chạy" khi onboard project cũ
5. snapshot        → Lưu state DB để compare offline
6. tag + rollback  → Exit plan rõ ràng cho mỗi golive
7. Multi-schema    → dùng schemaName attribute trong changeset
8. Multi-tenant    → tenant column + dedicated indexes + batch fill
```

**Next**: [[Liquibase-05-CICD-Production-Workflow]]

---

#liquibase #advanced #enterprise #diff #multi-schema #multi-tenant #rollback #postgresql
