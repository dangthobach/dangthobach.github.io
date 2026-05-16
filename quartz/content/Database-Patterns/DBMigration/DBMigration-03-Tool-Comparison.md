# Tool Comparison: Liquibase vs Flyway vs Atlas Go

> **Mục tiêu**: So sánh khoa học 3 công cụ migration — use cases, điểm mạnh/yếu, cách kết hợp, và những misuse phổ biến cần tránh.

**Series**: [[DBMigration-MOC]] | **Prev**: [[DBMigration-02-AtlasGo-Deep-Dive]] | **Next**: [[DBMigration-04-Enterprise-Patterns]]

---

## 1. Architecture Philosophy — 3 Trường phái khác nhau

```mermaid
graph TB
    subgraph "Flyway — Imperative SQL"
        FA["Developer<br/>viết SQL"] --> FB["Flyway<br/>thực thi đúng như viết"]
        FB --> FC["DB thay đổi"]
        FP["Triết lý:<br/>Bạn viết gì<br/>→ DB làm đúng vậy"]
    end
    
    subgraph "Liquibase — Structured Changesets"
        LA["Developer<br/>viết Changeset<br/>(XML/YAML/SQL)"] --> LB["Liquibase<br/>parse + track<br/>+ execute"]
        LB --> LC["DB thay đổi"]
        LP["Triết lý:<br/>Audit trail + control<br/>mọi thứ phải tracked"]
    end
    
    subgraph "Atlas — Declarative State"
        AA["Developer<br/>khai báo<br/>Desired State"] --> AB["Atlas<br/>calculate diff<br/>auto-generate SQL"]
        AB --> AC["DB thay đổi"]
        AP["Triết lý:<br/>Bạn nói muốn gì<br/>→ Atlas tự tính cách đến"]
    end
    
    style FP fill:#FF9800,color:#fff
    style LP fill:#2196F3,color:#fff
    style AP fill:#4CAF50,color:#fff
```

---

## 2. Feature Matrix — Chi tiết

```mermaid
xychart-beta
    title "Tool Capability Scores (1-10)"
    x-axis ["Ease of Use", "SQL Native", "Auto Diff", "SP Support", "Rollback", "CI/CD", "Spring Boot", "Audit Trail"]
    y-axis "Score" 0 --> 10
    bar [8, 9, 3, 8, 4, 5, 9, 6]
    bar [5, 7, 5, 8, 9, 6, 9, 10]
    bar [7, 8, 10, 4, 8, 10, 4, 7]
```

| Feature | Flyway | Liquibase | Atlas Go |
|---------|:------:|:---------:|:--------:|
| **Ease of adoption** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| **SQL-first** | ✅ Native | ⚠️ Có thể dùng SQL | ✅ Native |
| **Auto-generate migration** | ❌ | ⚠️ diffChangeLog (phức tạp) | ✅ Atlas's core feature |
| **Schema drift detection** | ❌ | ⚠️ Có nhưng cần setup | ✅ Native |
| **Stored Procedures** | ✅ Repeatable migrations | ✅ runOnChange | ⚠️ Hạn chế |
| **Rollback** | ❌ Community / ✅ Teams | ✅ Built-in | ✅ Auto-gen |
| **Preconditions / Guards** | ❌ | ✅ Phong phú | ⚠️ Hạn chế |
| **Audit trail** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **CI/CD linting** | ❌ | ❌ | ✅ Native |
| **Spring Boot auto** | ✅ | ✅ | ❌ |
| **Multi-schema** | ⚠️ Manual | ✅ | ✅ |
| **Multi-tenant** | ⚠️ Manual | ✅ | ✅ |
| **License** | Apache 2.0 (Community) | Apache 2.0 | Apache 2.0 |
| **Paid features** | Teams: Undo, Dry-run | Pro: Enterprise features | Cloud: CI dashboard |

---

## 3. Use Case Map — Khi nào dùng cái nào?

```mermaid
flowchart TD
    START([Chọn Migration Tool]) --> Q1{Team có<br/>SQL background<br/>mạnh không?}
    
    Q1 -->|Yes| Q2{Cần auto-diff<br/>schema không?}
    Q1 -->|No| Q3{Cần audit trail<br/>phức tạp không?}
    
    Q2 -->|Yes| Q4{Có nhiều<br/>Stored Procs?}
    Q2 -->|No| FLYWAY[🟠 Flyway<br/>SQL-first, simple]
    
    Q4 -->|Yes| COMBO1[🟣 Atlas + Flyway<br/>Atlas cho DDL<br/>Flyway Repeatable cho SP]
    Q4 -->|No| ATLAS[🟢 Atlas Go<br/>Declarative, auto-diff]
    
    Q3 -->|Yes| LIQUIBASE[🔵 Liquibase<br/>Rich audit, preconditions]
    Q3 -->|No| Q5{Cần CI/CD<br/>schema linting?}
    
    Q5 -->|Yes| ATLAS
    Q5 -->|No| FLYWAY
    
    style FLYWAY fill:#FF9800,color:#fff
    style LIQUIBASE fill:#2196F3,color:#fff
    style ATLAS fill:#4CAF50,color:#fff
    style COMBO1 fill:#9C27B0,color:#fff
```

### Use Cases cụ thể

#### Dùng Flyway khi:
- Team dev quen SQL, không muốn học XML/HCL
- Project nhỏ-medium, ít phức tạp
- **Nhiều Stored Procedures** (Flyway Repeatable migration tốt nhất)
- Cần Spring Boot integration zero-config
- Muốn đơn giản, không over-engineer

#### Dùng Liquibase khi:
- Cần audit trail chi tiết (enterprise compliance, banking)
- Cần preconditions phức tạp (guard conditions)
- Multi-schema, multi-tenant phức tạp
- Team đã quen XML/YAML workflow
- Cần built-in rollback (không muốn trả tiền Teams Flyway)
- **PDMS context**: banking → audit trail quan trọng → Liquibase fit tốt

#### Dùng Atlas Go khi:
- Muốn schema-as-code (Terraform-style)
- Cần CI/CD linting để phát hiện dangerous changes
- Auto-generate migration từ schema definition
- Đội ngũ infrastructure-heavy (quen HCL)
- Cần drift detection giữa environments

#### Kết hợp Atlas + Flyway khi:
- Cần cả auto-diff (Atlas) và stored proc management (Flyway)
- Atlas validate schema + Flyway apply migrations

---

## 4. Combination Patterns — Kết hợp công cụ

### Pattern 1: Atlas Lint + Flyway Apply

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant Git as Git / PR
    participant Atlas as Atlas CLI (CI)
    participant Flyway as Flyway (Deploy)
    participant DB as PostgreSQL

    Dev->>Git: Push migration files (V2__*.sql, R__*.sql)
    Git->>Atlas: Trigger CI lint job
    Atlas->>Atlas: atlas migrate lint --latest 1
    
    alt Dangerous changes detected
        Atlas->>Git: ❌ Block PR (DROP TABLE, etc.)
    else Safe changes
        Atlas->>Git: ✅ Approve
    end
    
    Git->>Flyway: Merge → trigger deploy
    Flyway->>DB: Apply versioned migrations (V__.sql)
    Flyway->>DB: Apply repeatable migrations (R__.sql stored procs)
    DB-->>Flyway: ✅ Success
```

```yaml
# CI: Atlas lint
- name: Atlas Schema Lint
  run: |
    atlas migrate lint \
      --dir "file://src/main/resources/db/migration" \
      --dev-url "docker://postgres/15/test" \
      --latest 1

# CD: Flyway apply
- name: Flyway Migrate
  run: |
    flyway migrate \
      -url=${PROD_DB_URL} \
      -user=${FLYWAY_USER} \
      -password=${FLYWAY_PASS}
```

### Pattern 2: Atlas Schema Drift Detection + Liquibase Migration

```bash
# Weekly drift check với Atlas
atlas schema diff \
  --from "postgres://user@staging-db:5432/pdms" \
  --to   "postgres://user@prod-db:5432/pdms"

# Nếu có drift → generate migration với Liquibase diffChangeLog
liquibase diffChangeLog \
  --changeLogFile=emergency-sync.xml \
  --url=postgres://prod-db:5432/pdms \
  --referenceUrl=postgres://staging-db:5432/pdms
```

### Pattern 3: Atlas inspect → Bootstrap Flyway

```bash
# Bước 1: Atlas inspect DB hiện có → SQL schema dump
atlas schema inspect \
  --url "postgres://user@prod-db:5432/pdms" \
  --format "{{ sql . }}" \
  > V1__Baseline_existing_schema.sql

# Bước 2: Flyway baseline
flyway baseline \
  -baselineVersion=1 \
  -baselineDescription="Existing PDMS schema"

# Bước 3: Từ đây dùng Flyway cho migrations
# Atlas chỉ dùng để lint CI và drift detection
```

---

## 5. ⚠️ Misuse — Những lỗi sai phổ biến

### Misuse 1: Sửa migration file đã chạy

```
❌ SAI với tất cả 3 tools:
   Ai đó sửa V1_2__Create_tables.sql sau khi đã chạy trên staging/prod
   
Hậu quả:
   Flyway:     FlywayException: Validate failed — checksum mismatch
   Liquibase:  ValidationFailedException: Checksum mismatch
   Atlas:      Migration hash mismatch error

✅ ĐÚNG: Luôn tạo file migration mới
   V1_2_1__Fix_table_definition.sql  ← file mới
```

### Misuse 2: Dùng `clean` trên production

```
❌ NGUY HIỂM:
   flyway.cleanDisabled = false  (trên prod)
   flyway clean  ← DROP tất cả objects trong DB!
   
   spring.jpa.hibernate.ddl-auto = create-drop  ← tương tự
   
✅ LUÔN:
   flyway.cleanDisabled = true  (trên staging và prod)
   spring.jpa.hibernate.ddl-auto = none  (trên mọi env, dùng Flyway/Liquibase thay thế)
```

### Misuse 3: Dùng hibernate.ddl-auto song song với migration tool

```
❌ SAI: Dùng cả 2 cùng lúc
   spring.jpa.hibernate.ddl-auto = update  ← Hibernate tự ALTER TABLE
   spring.flyway.enabled = true            ← Flyway cũng ALTER TABLE
   → Conflict, race condition, không biết ai thay đổi gì

✅ ĐÚNG: Chọn 1 hoặc tách biệt rõ ràng
   spring.jpa.hibernate.ddl-auto = validate  ← Hibernate CHỈ validate
   spring.flyway.enabled = true              ← Flyway quản lý schema
```

### Misuse 4: Version number không nhất quán

```
❌ SAI:
   V1__init.sql
   V10__add_feature.sql
   V2__second_feature.sql   ← Sort string: V1 < V10 < V2 !
   
✅ ĐÚNG: Dùng timestamp hoặc zero-padded
   V20241101__init.sql
   V20241115__add_feature.sql
   V20241120__second_feature.sql
   
   HOẶC:
   V001__init.sql
   V002__add_feature.sql
   V010__another_feature.sql
```

### Misuse 5: Không test rollback

```
❌ Phổ biến: Viết migration nhưng không bao giờ test rollback
   → Khi production lỗi, muốn rollback nhưng không có plan

✅ ĐÚNG: Mỗi migration phải có rollback plan
   Flyway Community: tạo rollback script thủ công
   Liquibase: <rollback> tag trong changeset
   Atlas: auto-gen rollback từ diff
```

### Misuse 6: Stored Procedures không dùng Repeatable migration

```
❌ SAI (với Flyway):
   V5__Create_sp_validate.sql   ← Versioned
   Khi sửa SP, tạo V6__Update_sp_validate.sql → V7__Fix_sp_validate.sql...
   → 20+ migration chỉ để update 1 stored proc
   
✅ ĐÚNG:
   R__SP_validate_document.sql  ← Repeatable
   → Flyway tự detect khi file thay đổi và re-run
   → Chỉ 1 file cho mỗi stored proc, sạch sẽ
```

### Misuse 7: Migration quá lớn

```
❌ SAI:
   V1__Everything.sql  ← 5000 dòng, tạo 200 tables trong 1 file
   → Khó debug khi lỗi, không thể retry từng phần
   → Transaction timeout trên large table
   
✅ ĐÚNG: Mỗi migration nhỏ, focused
   V1_01__Create_lookup_tables.sql    ← 20 lookup tables
   V1_02__Create_core_tables.sql      ← Core tables
   V1_03__Create_indexes.sql          ← Indexes
   V1_04__Add_foreign_keys.sql        ← FKs
   V1_05__Seed_initial_data.sql       ← Data
```

### Misuse 8: Không có dedicated migration user

```
❌ SAI:
   Dùng app user (chỉ có SELECT/INSERT/UPDATE/DELETE)
   để chạy migration (cần CREATE/ALTER/DROP)
   → Phải grant excess permissions cho app user
   → Security risk: app có thể DROP TABLE nếu bị compromise

✅ ĐÚNG:
   flyway_user:  quyền DDL (chỉ dùng lúc migrate)
   pdms_app_user: chỉ DML (app thường ngày)
```

---

## 6. Performance Comparison

```mermaid
gantt
    title Migration Performance (200 tables, 50 stored procs)
    dateFormat  mm:ss
    section Flyway
    Parse + Validate     :00:00, 5s
    Apply DDL migrations :00:05, 45s
    Apply Stored Procs   :00:50, 15s
    Total                :00:00, 70s

    section Liquibase
    Parse XML Changelogs :00:00, 12s
    Apply DDL migrations :00:12, 50s
    Apply Stored Procs   :01:02, 15s
    Total                :00:00, 80s

    section Atlas
    Load schema state    :00:00, 8s
    Diff calculation     :00:08, 15s
    Apply migrations     :00:23, 40s
    Total                :00:00, 63s
```

> ⚠️ Con số trên là ước tính minh họa — thực tế phụ thuộc vào network latency, DB size, và số lượng pending migrations.

---

## 7. Decision cho PDMS Context

```mermaid
graph TD
    PDMS[PDMS Requirements] --> R1[200 bảng]
    PDMS --> R2[50 stored procs/functions]
    PDMS --> R3[Banking: audit trail quan trọng]
    PDMS --> R4[Mid-project: cần adopt nhanh]
    PDMS --> R5[Spring Boot ecosystem]
    PDMS --> R6[PostgreSQL]
    PDMS --> R7[Golive pain: diff + thiếu scripts]
    
    R1 --> C1[Flyway ✅ / Liquibase ✅ / Atlas ✅]
    R2 --> C2[Flyway Repeatable ⭐ / Liquibase runOnChange ✅]
    R3 --> C3[Liquibase ⭐ / Flyway OK]
    R4 --> C4[Flyway ⭐ dễ adopt / Atlas OK]
    R5 --> C5[Flyway ⭐ / Liquibase ⭐ / Atlas ❌]
    R6 --> C6[Tất cả đều tốt]
    R7 --> C7[Flyway info ✅ / Liquibase diff ✅ / Atlas diff ⭐]
    
    C2 & C4 & C5 --> REC1[🟠 Flyway làm core tool]
    C3 & C7 --> REC2[+ Atlas CI linting]
    
    REC1 & REC2 --> FINAL[🏆 Khuyến nghị: Flyway + Atlas CI<br/>Hoặc Liquibase standalone<br/>nếu audit trail là priority]
    
    style FINAL fill:#4CAF50,color:#fff
    style REC1 fill:#FF9800,color:#fff
    style REC2 fill:#2196F3,color:#fff
```

---

## 8. Summary Comparison Card

```
┌──────────────────────────────────────────────────────────────┐
│                    TOOL SELECTION GUIDE                      │
├─────────────────┬────────────┬────────────┬──────────────────┤
│                 │  FLYWAY    │ LIQUIBASE  │   ATLAS GO       │
├─────────────────┼────────────┼────────────┼──────────────────┤
│ Learn in 1 day  │     ✅     │     ❌     │      ⚠️          │
│ Stored Procs    │ ⭐ Best    │     ✅     │      ❌          │
│ Auto-diff       │     ❌     │     ⚠️     │   ⭐ Best        │
│ Spring Boot     │ ⭐ Native  │ ⭐ Native  │      ❌          │
│ Rollback free   │     ❌     │     ✅     │      ✅          │
│ CI Linting      │     ❌     │     ❌     │   ⭐ Best        │
│ Audit trail     │     ⚠️     │ ⭐ Best    │      ⚠️          │
│ PDMS fit score  │    8/10    │    9/10    │     7/10         │
└─────────────────┴────────────┴────────────┴──────────────────┘

Best combinations:
  Option A: Flyway (migration) + Atlas (CI lint)         → Fast to adopt
  Option B: Liquibase standalone                          → Best audit trail
  Option C: Flyway + Liquibase diff (periodic compare)   → Belt & suspenders
```

**Next**: [[DBMigration-04-Enterprise-Patterns]]

---

#comparison #flyway #liquibase #atlasgo #enterprise #misuse #best-practices

---

## Deep Dive — Những điều bảng so sánh không nói

### Tại sao Flyway Community không có rollback?

Đây là câu hỏi hay. Câu trả lời thực sự không phải "Flyway muốn bán Teams".

```
Lý do kỹ thuật — SQL DDL không rollback được dễ dàng:
──────────────────────────────────────────────────────

Migration tiến (forward):
  V3: ALTER TABLE document ADD COLUMN priority INT;
  → Đơn giản, rõ ràng

Rollback "ngược lại" V3:
  ALTER TABLE document DROP COLUMN priority;
  → Ổn nếu column còn trống

Nhưng nếu sau khi V3 chạy, app đã INSERT 1 triệu rows với priority data?
  DROP COLUMN priority → DATA MẤT VĨNH VIỄN
  Đây không phải "rollback" — đây là "xóa data"

Flyway Teams "Undo migrations":
  Bạn phải tự viết undo SQL — Flyway không auto-generate
  Và undo SQL chỉ an toàn khi CHƯA có data change
  Với DDL change có data change → không có undo thực sự
```

**Kết luận thực tế:** Với hầu hết production scenarios, rollback database không phải "chạy SQL ngược lại" — mà là "deploy version app cũ và accept data state hiện tại". Đây là lý do backup trước golive quan trọng hơn có undo migration.

---

### Liquibase changesets vs Flyway files — Sự khác biệt triết học

```
Flyway: 1 file = 1 migration unit
──────────────────────────────────
V3__add_tenant.sql:
  ALTER TABLE document ADD COLUMN tenant_code VARCHAR(20);
  ALTER TABLE credit_case ADD COLUMN tenant_code VARCHAR(20);
  ALTER TABLE warehouse ADD COLUMN tenant_code VARCHAR(20);
  
→ Cả 3 ALTER chạy trong 1 transaction
→ Một trong 3 fail → tất cả rollback
→ Không thể retry từng ALTER riêng lẻ

Liquibase: 1 changeset = 1 thay đổi nhỏ nhất
──────────────────────────────────────────────
<changeSet id="add-tenant-document" author="bach">
  <addColumn tableName="document">
    <column name="tenant_code" type="VARCHAR(20)"/>
  </addColumn>
</changeSet>

<changeSet id="add-tenant-credit-case" author="bach">
  <addColumn tableName="credit_case">
    <column name="tenant_code" type="VARCHAR(20)"/>
  </addColumn>
</changeSet>

→ Mỗi changeSet là 1 transaction riêng
→ changeSet 1 thành công, changeSet 2 fail
  → Document có tenant_code, credit_case chưa có
  → Retry: chỉ chạy lại từ changeSet 2
→ Granular control hơn

Khi nào granular control quan trọng?
  Migration lớn chạy hàng giờ, lỗi ở bước thứ 50/100
  Flyway: phải chạy lại từ đầu 100 bước
  Liquibase: chỉ chạy lại từ bước 50
```

---

### Misuse 3 (Hibernate ddl-auto) — Tại sao nguy hiểm hơn bạn nghĩ

```
spring.jpa.hibernate.ddl-auto = update
```

Nhiều dev nghĩ `update` là "an toàn" vì nó chỉ thêm, không xóa. Nhưng:

```
Hibernate ddl-auto = update thực sự làm gì:
────────────────────────────────────────────
1. Đọc tất cả @Entity classes
2. Inspect DB schema hiện tại
3. Tạo SQL để sync entity → DB
4. Chạy SQL đó

Vấn đề 1: Hibernate KHÔNG track changes
  Hibernate không biết "change nào đã chạy rồi"
  Mỗi lần restart: Hibernate scan lại toàn bộ entities
  → Có thể add column duplicate nếu logic không hoàn hảo

Vấn đề 2: Hibernate không bao giờ DROP
  Bạn rename cột Java: oldColumn → newColumn
  Hibernate tạo: newColumn (mới), giữ nguyên oldColumn (cũ)
  Kết quả: DB tích lũy rác — các column cũ không bao giờ bị xóa
  Sau 2 năm: table có 30 cột cũ không dùng nữa

Vấn đề 3: Không có audit trail
  Ai đã thêm column này? Khi nào? Tại sao?
  Không biết → production bị "schema drift" âm thầm
  
Vấn đề 4: Race condition khi multi-instance
  App chạy 3 instances, tất cả start cùng lúc
  3 instances đều cố "create index" → 2 cái fail
  → Startup error không nhất quán, khó debug
  
✅ Rule: Luôn dùng validate hoặc none trên staging/prod
         Chỉ dùng create-drop trên unit test (in-memory H2)
```

---

### Misuse 4 — Version number strategy thực tế tại PDMS

```
Convention nào tốt nhất cho PDMS?
───────────────────────────────────

Option 1: Sequential (V1, V2, V3...)
  Ưu: Đơn giản
  Nhược: Conflict khi nhiều dev làm song song
         Dev A tạo V5, Dev B tạo V5 → Merge conflict

Option 2: Timestamp (V20241120143052)
  Ưu: Không bao giờ conflict (timestamp unique)
  Nhược: Số dài, khó đọc
  
Option 3: Sprint-based (V2024S47_01, V2024S47_02)
  Ưu: Biết ngay migration thuộc sprint nào
  Nhược: Convention phức tạp

Khuyến nghị cho PDMS: Timestamp 14 chữ số
  V20241120143052__add_priority_column.sql
  
  Cách tạo nhanh trên terminal:
  date +V%Y%m%d%H%M%S
  → V20241120143052
  
  Hoặc script:
  alias new-migration='echo "V$(date +%Y%m%d%H%M%S)__"'
```
