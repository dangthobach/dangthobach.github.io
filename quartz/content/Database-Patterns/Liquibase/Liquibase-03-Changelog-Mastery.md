# Liquibase 03 — Changelog Mastery: Viết Changelog chuẩn cho hệ thống 200 bảng

> **Mục tiêu**: Nắm vững cách viết changelog XML/SQL đúng cách, strategies tổ chức cho dự án lớn, và các patterns tránh lỗi production.

**Series**: [[Liquibase-MOC]] | **Prev**: [[Liquibase-02-Configuration-SpringBoot]] | **Next**: [[Liquibase-04-Advanced-Enterprise]]

---

## 1. Changelog Formats — Chọn gì?

| Format | Ưu điểm | Nhược điểm | Dùng khi |
|--------|---------|------------|----------|
| **XML** | Type-safe, IDE autocomplete, Liquibase native | Verbose | DDL thay đổi cấu trúc |
| **SQL** | Dev quen thuộc, paste từ DB tool trực tiếp | Không có auto-rollback | Stored procedures, complex DML |
| **YAML** | Ngắn gọn hơn XML | Dễ lỗi indent | Personal preference |

> 💡 **Khuyến nghị cho PDMS**: Dùng **XML cho DDL** (type-safe, refactor-safe) và **SQL thuần cho stored procedures + complex data migration**

---

## 2. XML Changelog — Anatomy đầy đủ

```xml
<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog
    xmlns="http://www.liquibase.org/xml/ns/dbchangelog"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.liquibase.org/xml/ns/dbchangelog
                        http://www.liquibase.org/xml/ns/dbchangelog/dbchangelog-4.20.xsd">

    <!--
        Naming convention cho changeset ID:
        {action}-{object_type}-{object_name}

        Examples:
        - create-table-document
        - add-column-document-tenant-id
        - create-index-document-status
        - add-fk-document-to-case
    -->

    <changeSet id="create-table-document" author="bach" labels="v1.0.0" context="dev,staging,prod">

        <comment>Bảng lưu thông tin hồ sơ vật lý — core table của PDMS</comment>

        <createTable tableName="document">
            <column name="id" type="UUID">
                <constraints primaryKey="true" nullable="false"/>
            </column>
            <column name="document_code" type="VARCHAR(50)">
                <constraints nullable="false" unique="true"/>
            </column>
            <column name="case_id" type="UUID">
                <constraints nullable="false"/>
            </column>
            <column name="warehouse_id" type="UUID">
                <constraints nullable="false"/>
            </column>
            <column name="status_id" type="BIGINT">
                <constraints nullable="false"/>
            </column>
            <column name="tenant_code" type="VARCHAR(20)">
                <constraints nullable="false"/>
            </column>
            <!-- Audit columns -->
            <column name="created_by" type="VARCHAR(100)"/>
            <column name="created_at" type="TIMESTAMP WITH TIME ZONE" defaultValueComputed="NOW()">
                <constraints nullable="false"/>
            </column>
            <column name="updated_by" type="VARCHAR(100)"/>
            <column name="updated_at" type="TIMESTAMP WITH TIME ZONE"/>
            <!-- Soft delete -->
            <column name="deleted" type="BOOLEAN" defaultValueBoolean="false">
                <constraints nullable="false"/>
            </column>
            <column name="deleted_at" type="TIMESTAMP WITH TIME ZONE"/>
            <column name="deleted_by" type="VARCHAR(100)"/>
        </createTable>

    </changeSet>

</databaseChangeLog>
```

---

## 3. Patterns cho Từng Loại Thao Tác

### 3.1 CREATE TABLE với lookup data

```xml
<changeSet id="create-table-document-status" author="bach" labels="v1.0.0">
    <createTable tableName="document_status">
        <column name="id" type="BIGINT" autoIncrement="true">
            <constraints primaryKey="true"/>
        </column>
        <column name="code" type="VARCHAR(50)">
            <constraints nullable="false" unique="true"/>
        </column>
        <column name="name" type="VARCHAR(200)">
            <constraints nullable="false"/>
        </column>
        <column name="description" type="TEXT"/>
        <column name="is_active" type="BOOLEAN" defaultValueBoolean="true"/>
        <column name="sort_order" type="INT" defaultValueNumeric="0"/>
    </createTable>
    <setTableRemarks tableName="document_status"
                     remarks="Lookup table: trạng thái hồ sơ vật lý"/>
</changeSet>
```

### 3.2 ADD FOREIGN KEY (tách riêng để kiểm soát)

```xml
<!-- Tách FK ra changeset riêng — dễ debug khi có lỗi -->
<changeSet id="add-fk-document-status" author="bach" labels="v1.0.0">
    <addForeignKeyConstraint
        constraintName="fk_document_status_id"
        baseTableName="document"
        baseColumnNames="status_id"
        referencedTableName="document_status"
        referencedColumnNames="id"
        onDelete="RESTRICT"
        onUpdate="CASCADE"/>
</changeSet>
```

### 3.3 CREATE INDEX — Regular vs CONCURRENT

```xml
<!-- Index thường — trong transaction -->
<changeSet id="create-idx-document-status-tenant" author="bach" labels="v1.0.0">
    <createIndex indexName="idx_document_status_tenant"
                 tableName="document">
        <column name="status_id"/>
        <column name="tenant_code"/>
        <column name="deleted"/>
    </createIndex>
</changeSet>

<!-- CONCURRENT INDEX — phải ngoài transaction, PostgreSQL specific -->
<changeSet id="create-idx-document-code-search" author="bach"
           labels="v1.0.0" runInTransaction="false">
    <sql>
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_document_code_search
        ON document USING gin(to_tsvector('simple', document_code))
        WHERE deleted = false;
    </sql>
    <rollback>
        DROP INDEX CONCURRENTLY IF EXISTS idx_document_code_search;
    </rollback>
</changeSet>
```

### 3.4 ALTER TABLE — thêm column an toàn (3 bước)

```xml
<!-- Step 1: Thêm column nullable trước (fast, không lock) -->
<changeSet id="add-column-document-priority-step1" author="bach" labels="v1.1.0">
    <preConditions onFail="MARK_RAN">
        <not><columnExists tableName="document" columnName="priority"/></not>
    </preConditions>
    <addColumn tableName="document">
        <column name="priority" type="INT"/>
    </addColumn>
</changeSet>

<!-- Step 2: Fill default data (tách ra để có thể resume nếu lỗi) -->
<changeSet id="add-column-document-priority-step2" author="bach" labels="v1.1.0">
    <sql>UPDATE document SET priority = 0 WHERE priority IS NULL;</sql>
    <rollback><!-- Không cần rollback UPDATE --></rollback>
</changeSet>

<!-- Step 3: Thêm NOT NULL constraint sau khi đã fill data -->
<changeSet id="add-column-document-priority-step3" author="bach" labels="v1.1.0">
    <addNotNullConstraint tableName="document" columnName="priority"
                          defaultNullValue="0"/>
</changeSet>
```

### 3.5 Data Seeding — Idempotent với ON CONFLICT

```xml
<changeSet id="seed-document-status" author="bach" labels="v1.0.0" context="dev,staging,prod">
    <sql>
        INSERT INTO document_status (id, code, name, description, is_active, sort_order)
        VALUES
            (1, 'DRAFT',     N'Nháp',         N'Hồ sơ đang soạn thảo',    true, 1),
            (2, 'SUBMITTED', N'Đã nộp',        N'Hồ sơ đã nộp vào kho',    true, 2),
            (3, 'REVIEWING', N'Đang kiểm tra', N'Hồ sơ đang được kiểm tra', true, 3),
            (4, 'APPROVED',  N'Đã duyệt',      N'Hồ sơ đã được duyệt',      true, 4),
            (5, 'REJECTED',  N'Bị từ chối',    N'Hồ sơ bị từ chối',         true, 5),
            (6, 'ARCHIVED',  N'Đã lưu trữ',    N'Hồ sơ đã chuyển lưu trữ',  true, 6)
        ON CONFLICT (id) DO UPDATE SET
            code = EXCLUDED.code,
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            sort_order = EXCLUDED.sort_order;
    </sql>
    <rollback>
        DELETE FROM document_status WHERE id IN (1, 2, 3, 4, 5, 6);
    </rollback>
</changeSet>
```

### 3.6 Context-specific seed data

```xml
<!-- Chỉ insert test data ở dev/staging -->
<changeSet id="seed-test-documents" author="bach" labels="v1.0.0" context="dev,staging">
    <loadData tableName="document"
              file="db/data/dev/sample-documents.csv"
              separator=","
              encoding="UTF-8">
        <column name="id" type="UUID"/>
        <column name="document_code" type="STRING"/>
        <column name="tenant_code" type="STRING"/>
        <column name="status_id" type="NUMERIC"/>
        <column name="created_at" type="DATE"/>
    </loadData>
</changeSet>
```

### 3.7 Stored Procedures — runOnChange

```xml
<!-- runOnChange: mỗi khi sửa file SQL, Liquibase sẽ re-execute -->
<changeSet id="sp-process-document-validation" author="bach"
           runOnChange="true" labels="v1.0.0">
    <comment>Stored procedure validate document batch</comment>
    <sqlFile path="db/procedures/pr_process_document_validation.sql"
             relativeToChangelogFile="false"
             encoding="UTF-8"
             splitStatements="false"/>
    <rollback>
        DROP FUNCTION IF EXISTS pr_process_document_validation(UUID, INT);
    </rollback>
</changeSet>
```

### 3.8 Views — runOnChange

```xml
<changeSet id="view-document-summary" author="bach" runOnChange="true">
    <createView viewName="v_document_summary" replaceIfExists="true">
        SELECT
            d.id,
            d.document_code,
            d.tenant_code,
            ds.code  AS status_code,
            ds.name  AS status_name,
            w.code   AS warehouse_code,
            d.created_at,
            d.created_by
        FROM document d
        JOIN document_status ds ON ds.id = d.status_id
        JOIN warehouse w ON w.id = d.warehouse_id
        WHERE d.deleted = false
    </createView>
</changeSet>
```

---

## 4. SQL Format Changelog

```sql
-- migrations/v1.0.0/009-create-sequences.sql
-- liquibase formatted sql

-- changeset bach:create-sequence-warehouse-code labels:v1.0.0
-- comment: Sequence tạo mã warehouse
CREATE SEQUENCE IF NOT EXISTS seq_warehouse_code
    START WITH 1
    INCREMENT BY 1
    CACHE 1;

-- rollback DROP SEQUENCE IF EXISTS seq_warehouse_code;

-- changeset bach:create-sequence-document-code labels:v1.0.0
CREATE SEQUENCE IF NOT EXISTS seq_document_code
    START WITH 100000
    INCREMENT BY 1
    CACHE 100;

-- rollback DROP SEQUENCE IF EXISTS seq_document_code;
```

### Stored Procedure (splitStatements=false)

```sql
-- db/procedures/pr_generate_warehouse_code.sql
-- liquibase formatted sql

-- changeset bach:create-fn-generate-warehouse-code labels:v1.0.0 runOnChange:true
-- splitStatements:false

CREATE OR REPLACE FUNCTION fn_generate_warehouse_code(
    p_warehouse_type_code VARCHAR,
    p_province_code       VARCHAR
)
RETURNS VARCHAR AS $$
DECLARE
    v_seq_val    BIGINT;
    v_year_month VARCHAR(6);
    v_code       VARCHAR;
BEGIN
    SELECT NEXTVAL('seq_warehouse_code') INTO v_seq_val;
    v_year_month := TO_CHAR(NOW(), 'YYYYMM');
    v_code := p_warehouse_type_code || '-' || p_province_code
              || '-' || v_year_month
              || '-' || LPAD(v_seq_val::TEXT, 5, '0');
    RETURN v_code;
END;
$$ LANGUAGE plpgsql;

-- rollback DROP FUNCTION IF EXISTS fn_generate_warehouse_code(VARCHAR, VARCHAR);
```

---

## 5. File Tổ chức cho 200 Tables

### Naming Convention cứng nhắc

```
Format: {NNN}-{verb}-{noun}.xml
NNN: 001, 002, 003... (3 chữ số)

Verbs: create, add, alter, drop, rename, seed, migrate
Nouns: table-{name}, column-{table}-{col}, index-{name}, fk-{name}

Examples:
001-create-lookup-tables.xml
002-create-core-tables.xml
003-create-junction-tables.xml
004-add-foreign-keys.xml
005-create-indexes.xml
006-seed-lookup-data.xml
```

### Grouping strategy — PDMS context

```
migrations/
├── v1.0.0/   ← Initial release — toàn bộ 200 tables
│   ├── 001-create-schema-extensions.xml    # Enable uuid-ossp, pgcrypto
│   ├── 002-create-lookup-tables.xml        # ~20 bảng lookup
│   ├── 003-create-core-document-tables.xml # document, case, warehouse
│   ├── 004-create-credit-tables.xml        # credit_case, collateral
│   ├── 005-create-iam-tables.xml           # user, role, permission
│   ├── 006-create-audit-tables.xml         # audit_log, change_history
│   ├── 007-add-foreign-keys.xml            # TẤT CẢ FK sau khi tạo xong tables
│   ├── 008-create-indexes.xml              # Tất cả indexes
│   ├── 009-create-sequences.xml            # Warehouse code sequences
│   ├── 010-seed-lookup-data.xml            # Master data cố định
│   └── 011-seed-warehouse-config.xml       # Config data
│
├── v1.1.0/
│   ├── 001-add-tenant-support-columns.xml
│   ├── 002-add-tsdb-module-tables.xml
│   └── 003-seed-tenant-config.xml
│
└── v2.0.0/
    ├── 001-iam-service-migration.xml        # AuthZ migration (pdms-iam-service)
    └── 002-process-management-tables.xml   # pdms-process-management service
```

---

## 6. Changelog Parameterization

```xml
<!-- db.changelog-master.xml -->
<databaseChangeLog>
    <property name="now" value="now()" dbms="postgresql"/>
    <property name="uuid_function" value="gen_random_uuid()" dbms="postgresql"/>
</databaseChangeLog>
```

```xml
<!-- Dùng trong changeset -->
<changeSet id="create-table-warehouse" author="bach">
    <createTable tableName="warehouse">
        <column name="id" type="UUID" defaultValueComputed="${uuid_function}">
            <constraints primaryKey="true"/>
        </column>
        <column name="tenant_code" type="VARCHAR(20)" defaultValue="${default_tenant}">
            <constraints nullable="false"/>
        </column>
        <column name="created_at" type="TIMESTAMP WITH TIME ZONE"
                defaultValueComputed="${now}"/>
    </createTable>
</changeSet>
```

---

## 7. Anti-patterns cần tránh

### ❌ Sửa changeset đã chạy

```xml
<!-- ĐỪNG: Đổi type sau khi changeset đã chạy → CHECKSUM MISMATCH! -->
<changeSet id="create-table-document" author="bach">
    <createTable tableName="document">
        <column name="status" type="VARCHAR(100)"/>  <!-- đổi từ 50 → 100 -->
    </createTable>
</changeSet>

<!-- ✅ Đúng: Tạo changeset mới -->
<changeSet id="alter-document-status-column-size" author="bach">
    <modifyDataType tableName="document" columnName="status" newDataType="VARCHAR(100)"/>
</changeSet>
```

### ❌ Thiếu precondition cho SQL thuần

```xml
<!-- ĐỪNG: Chạy 2 lần sẽ lỗi "Table already exists" -->
<changeSet id="create-table-document" author="bach">
    <sql>CREATE TABLE document (id UUID PRIMARY KEY);</sql>
</changeSet>

<!-- ✅ Đúng: Dùng IF NOT EXISTS hoặc precondition -->
<changeSet id="create-table-document" author="bach">
    <preConditions onFail="MARK_RAN">
        <not><tableExists tableName="document"/></not>
    </preConditions>
    <createTable tableName="document">
        <column name="id" type="UUID"><constraints primaryKey="true"/></column>
    </createTable>
</changeSet>
```

### ❌ Không có rollback cho DML

```xml
<!-- ĐỪNG: UPDATE/DELETE không có rollback → không thể undo -->
<changeSet id="migrate-status-values" author="bach">
    <sql>UPDATE document SET status_id = 2 WHERE status_id = 1;</sql>
</changeSet>

<!-- ✅ Đúng -->
<changeSet id="migrate-status-values" author="bach">
    <sql>UPDATE document SET status_id = 2 WHERE status_id = 1;</sql>
    <rollback>
        UPDATE document SET status_id = 1 WHERE status_id = 2;
    </rollback>
</changeSet>
```

---

## 8. Validate & Dry-run

```bash
# Validate syntax và logic (không chạy migration)
liquibase validate

# Dry-run: in SQL sẽ chạy, KHÔNG thực thi
liquibase updateSQL > pending-migrations.sql

# Test rollback sau khi chạy (staging only!)
liquibase updateTestingRollback

# Xem status chi tiết
liquibase status --verbose
```

---

## Summary

```
Changelog best practices cho 200-table project:
1. XML cho DDL, SQL thuần cho stored procedures
2. Mỗi table = 1 changeset
3. Tách FK và Index thành file riêng
4. Naming convention nhất quán: NNN-verb-noun
5. Luôn có precondition cho safety
6. Luôn có rollback cho DML
7. runOnChange cho views, stored procedures
8. Dùng context để kiểm soát env-specific data
9. Không bao giờ sửa changeset đã commit
10. Test bằng updateSQL trước khi chạy thật
```

**Next**: [[Liquibase-04-Advanced-Enterprise]]

---

#liquibase #changelog #xml #sql #best-practices #enterprise #200-tables
