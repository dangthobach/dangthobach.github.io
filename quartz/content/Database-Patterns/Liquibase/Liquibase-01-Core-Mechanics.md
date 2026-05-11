# Liquibase 01 — Core Mechanics: Cơ chế hoạt động nội tại

> **Mục tiêu**: Hiểu sâu cách Liquibase hoạt động bên trong — để khi gặp vấn đề production, bạn biết chính xác điều gì đang xảy ra.

**Series**: [[Liquibase-MOC]] | **Next**: [[Liquibase-02-Configuration-SpringBoot]]

---

## 1. Kiến trúc tổng quan

```
┌─────────────────────────────────────────────────────────┐
│                   Application Startup                   │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│              Liquibase Engine                           │
│                                                         │
│  1. Parse Changelog files (XML/YAML/SQL)                │
│  2. Acquire DATABASECHANGELOGLOCK                       │
│  3. Read DATABASECHANGELOG (đã chạy gì)                 │
│  4. Calculate pending changesets                        │
│  5. Execute pending changesets (theo thứ tự)            │
│  6. Record vào DATABASECHANGELOG                        │
│  7. Release DATABASECHANGELOGLOCK                       │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                   PostgreSQL                            │
│  - DATABASECHANGELOG (audit table)                      │
│  - DATABASECHANGELOGLOCK (distributed lock)             │
│  - Your 200 tables...                                   │
└─────────────────────────────────────────────────────────┘
```

---

## 2. DATABASECHANGELOG — Trái tim của Liquibase

Đây là bảng quan trọng nhất. Liquibase tự tạo khi chạy lần đầu:

```sql
CREATE TABLE DATABASECHANGELOG (
    ID                  VARCHAR(255) NOT NULL,
    AUTHOR              VARCHAR(255) NOT NULL,
    FILENAME            VARCHAR(255) NOT NULL,
    DATEEXECUTED        TIMESTAMP    NOT NULL,
    ORDEREXECUTED       INT          NOT NULL,  -- thứ tự tuyệt đối
    EXECTYPE            VARCHAR(10)  NOT NULL,  -- EXECUTED, FAILED, SKIPPED, RERAN, MARK_RAN
    MD5SUM              VARCHAR(35),            -- checksum của changeset
    DESCRIPTION         VARCHAR(255),
    COMMENTS            VARCHAR(255),
    TAG                 VARCHAR(255),           -- dùng cho rollback
    LIQUIBASE           VARCHAR(20),            -- version Liquibase đã chạy
    CONTEXTS            VARCHAR(255),
    LABELS              VARCHAR(255),
    DEPLOYMENT_ID       VARCHAR(10)             -- group các changeset cùng 1 lần update
);
```

### Cách Liquibase quyết định "chạy hay không"

```
Với mỗi changeset trong changelog file:
  1. Tạo key = ID + AUTHOR + FILENAME
  2. Tìm key này trong DATABASECHANGELOG
  3. Nếu KHÔNG tìm thấy → CHẠY changeset
  4. Nếu TÌM THẤY:
     a. Tính MD5 của changeset hiện tại
     b. So sánh với MD5SUM trong bảng
     c. Nếu khớp   → SKIP (đã chạy rồi, bình thường)
     d. Nếu không khớp → LỖI! "Checksum mismatch"
        (ai đó đã sửa changeset đã chạy — nguy hiểm!)
```

> ⚠️ **Rule vàng**: Không bao giờ sửa nội dung changeset đã chạy trên bất kỳ môi trường nào. Nếu cần sửa, tạo changeset mới.

---

## 3. Checksum Mechanism

### Xử lý khi bắt buộc phải thay đổi checksum

```xml
<!-- Option 1: validCheckSum — chấp nhận cả 2 checksum -->
<changeSet id="add-status-column" author="bach">
    <validCheckSum>8:abc123oldchecksum</validCheckSum>
    <validCheckSum>8:xyz789newchecksum</validCheckSum>
    <addColumn tableName="document">
        <column name="status" type="VARCHAR(100)"/>
    </addColumn>
</changeSet>

<!-- Option 2: runOnChange="true" — luôn rerun khi content thay đổi -->
<!-- Dùng cho stored procedures, views, functions -->
<changeSet id="create-view-document-summary" author="bach" runOnChange="true">
    <createView viewName="v_document_summary">
        SELECT d.id, d.code, s.name as status_name
        FROM document d JOIN document_status s ON d.status_id = s.id
    </createView>
</changeSet>
```

---

## 4. DATABASECHANGELOGLOCK — Distributed Lock

```sql
CREATE TABLE DATABASECHANGELOGLOCK (
    ID          INT          NOT NULL PRIMARY KEY,
    LOCKED      BOOLEAN      NOT NULL,
    LOCKGRANTED TIMESTAMP,
    LOCKEDBY    VARCHAR(255)  -- hostname:port của instance đang lock
);
-- Chỉ có 1 row với ID = 1
```

### Vấn đề: Stale Lock

Khi app crash giữa chừng khi đang migrate, lock không được release:

```
Waiting for changelog lock...
Waiting for changelog lock...
```

**Cách fix**:

```bash
# Option 1: Liquibase CLI
liquibase releaseLocks

# Option 2: SQL trực tiếp
UPDATE DATABASECHANGELOGLOCK
SET LOCKED = FALSE, LOCKGRANTED = NULL, LOCKEDBY = NULL
WHERE ID = 1;
```

> 💡 **Production tip**: Luôn set `spring.liquibase.lock-wait-time` hợp lý. Với 200 bảng và data migration phức tạp, có thể cần tăng lên 30-60 phút.

---

## 5. Changeset Lifecycle

### Các trạng thái EXECTYPE

| EXECTYPE | Ý nghĩa | Khi nào xảy ra |
|----------|---------|----------------|
| `EXECUTED` | Chạy thành công | Normal case |
| `FAILED` | Chạy thất bại | Exception trong SQL/changeset |
| `SKIPPED` | Bỏ qua | Precondition không thỏa mãn + `onFail="MARK_RAN"` |
| `RERAN` | Chạy lại | `runAlways="true"` hoặc `runOnChange="true"` |
| `MARK_RAN` | Đánh dấu đã chạy nhưng không thực sự chạy | `markNextChangeSetRan` command |

### Changeset attributes quan trọng

```xml
<changeSet
    id="create-document-table"
    author="bach"
    runAlways="false"        <!-- default: false — chỉ chạy 1 lần -->
    runOnChange="false"      <!-- default: false — rerun khi content đổi -->
    failOnError="true"       <!-- default: true — stop nếu lỗi -->
    runInTransaction="true"  <!-- default: true — wrap trong transaction -->
    context="!prod"          <!-- chỉ chạy khi KHÔNG phải prod -->
    labels="v1.0.0"          <!-- filter bằng label khi deploy -->
>
```

---

## 6. Transaction Model

```
Mỗi changeset chạy trong 1 transaction riêng:

BEGIN TRANSACTION
  ALTER TABLE document ADD COLUMN status VARCHAR(50);
  INSERT INTO DATABASECHANGELOG (...) VALUES (...);
COMMIT

Nếu lỗi → ROLLBACK cả changeset + record vào changelog
```

### runInTransaction="false" — PostgreSQL CONCURRENTLY

```xml
<!-- CREATE INDEX CONCURRENTLY phải nằm ngoài transaction -->
<changeSet id="create-idx-document-status" author="bach" runInTransaction="false">
    <sql>
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_document_status
        ON document(status_id)
        WHERE deleted = false;
    </sql>
</changeSet>
```

> ⚠️ Khi `runInTransaction="false"`, nếu changeset fail ở giữa, **không có rollback tự động**.

---

## 7. Execution Order

```xml
<!-- db.changelog-master.xml -->
<databaseChangeLog>
    <!-- File 1 chạy trước, file 2 chạy sau -->
    <include file="migrations/v1.0.0/001-create-tables.xml"/>
    <include file="migrations/v1.0.0/002-create-indexes.xml"/>

    <!-- includeAll: tự động load tất cả file trong folder, sort theo tên -->
    <includeAll path="migrations/v1.1.0/" relativeToChangelogFile="true"/>
</databaseChangeLog>
```

> 💡 Dùng prefix số `001-`, `002-` để đảm bảo sort order đúng khi dùng `includeAll`.

---

## 8. Preconditions — Guard trước khi chạy

```xml
<changeSet id="add-tenant-id-column" author="bach">
    <preConditions onFail="MARK_RAN" onError="HALT">
        <not>
            <columnExists tableName="document" columnName="tenant_id"/>
        </not>
    </preConditions>
    <addColumn tableName="document">
        <column name="tenant_id" type="UUID"/>
    </addColumn>
</changeSet>
```

### onFail / onError options

| Value | Behavior |
|-------|----------|
| `HALT` | Stop toàn bộ migration (default) |
| `CONTINUE` | Bỏ qua changeset, tiếp tục cái khác |
| `MARK_RAN` | Ghi vào DATABASECHANGELOG là đã chạy, thực ra không chạy |
| `WARN` | Log warning, vẫn tiếp tục |

### Các precondition phổ biến

```xml
<preConditions>
    <tableExists tableName="document"/>
    <columnExists tableName="document" columnName="status"/>
    <indexExists indexName="idx_document_status"/>
    <sqlCheck expectedResult="0">
        SELECT COUNT(*) FROM document WHERE status IS NULL
    </sqlCheck>
    <dbms type="postgresql"/>
    <changeSetExecuted id="create-document-table" author="bach"
                       changeLogFile="migrations/v1.0.0/001.xml"/>
</preConditions>
```

---

## 9. Rollback Mechanism

### Auto-generated rollback

```xml
<changeSet id="add-column-example" author="bach">
    <addColumn tableName="document">
        <column name="priority" type="INT" defaultValue="0"/>
    </addColumn>
    <!-- Liquibase tự generate: DROP COLUMN priority -->
</changeSet>
```

Operations có auto-rollback: `createTable`, `addColumn`, `createIndex`, `addPrimaryKey`, `addForeignKey`, `createSequence`...

### Custom rollback

```xml
<changeSet id="update-status-values" author="bach">
    <sql>UPDATE document SET status = 'ACTIVE' WHERE status = 'NEW';</sql>
    <rollback>
        UPDATE document SET status = 'NEW' WHERE status = 'ACTIVE';
    </rollback>
</changeSet>
```

---

## 10. Key Liquibase Commands Reference

```bash
# === MIGRATION ===
liquibase update                    # Chạy tất cả pending changesets
liquibase update --count 5          # Chỉ chạy 5 changeset tiếp theo
liquibase updateSQL                 # In ra SQL sẽ chạy, KHÔNG thực thi (dry run)

# === STATUS & AUDIT ===
liquibase status                    # Xem changeset nào chưa chạy
liquibase status --verbose
liquibase history                   # Xem lịch sử đã chạy gì

# === ROLLBACK ===
liquibase rollbackCount 3           # Rollback 3 changeset gần nhất
liquibase rollback --tag v1.0.0     # Rollback về tag v1.0.0
liquibase rollbackSQL --tag v1.0.0  # In SQL rollback (dry run)

# === COMPARE & GENERATE ===
liquibase diff                      # So sánh 2 DB schemas
liquibase generateChangeLog         # Generate changelog từ DB hiện tại
liquibase diffChangeLog             # Generate changelog của sự khác biệt

# === MAINTENANCE ===
liquibase validate                  # Validate changelog files
liquibase clearCheckSums            # Reset tất cả checksum (cẩn thận!)
liquibase releaseLocks              # Release stale lock
liquibase tag --tag v1.0.0         # Đánh tag checkpoint
liquibase changelogSync             # Mark tất cả changeset là đã chạy
```

---

## Summary

```
Liquibase hoạt động theo pipeline:
Parse → Lock → Compare → Execute → Record → Unlock

Hai bảng cốt lõi:
- DATABASECHANGELOG: lịch sử, không sửa thủ công
- DATABASECHANGELOGLOCK: distributed lock, tự release khi xong

Hai rule vàng:
1. Không bao giờ sửa changeset đã chạy
2. Mỗi changeset phải idempotent (dùng precondition nếu cần)
```

**Next**: [[Liquibase-02-Configuration-SpringBoot]]

---

#liquibase #database-migration #core-mechanics #postgresql #enterprise
