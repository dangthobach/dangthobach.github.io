# Atlas Go Deep Dive — Schema-as-Code & Declarative Migrations

> **Atlas Go**: Công cụ migration thế hệ mới — triết lý **declarative** (khai báo trạng thái mong muốn, Atlas tự tính diff). Mạnh nhất ở auto-diff và CI/CD linting schema.

**Series**: [[DBMigration-MOC]] | **Prev**: [[DBMigration-01-Flyway-Deep-Dive]] | **Next**: [[DBMigration-03-Tool-Comparison]]

---

## 1. Triết lý — Declarative vs Imperative

```mermaid
graph TB
    subgraph "Imperative (Flyway/Liquibase)"
        A["Developer viết:<br/>ALTER TABLE document<br/>ADD COLUMN priority INT;"] --> B["Tool thực thi<br/>đúng như viết"]
        B --> C["DB State mới"]
    end
    
    subgraph "Declarative (Atlas)"
        D["Developer khai báo<br/>TRẠNG THÁI MUỐN ĐẾN:"] --> E["table 'document' {<br/>  column 'priority' {<br/>    type = int<br/>  }<br/>}"]
        F["DB State hiện tại"] --> G["Atlas Diff Engine"]
        E --> G
        G --> H["Auto-generate:<br/>ALTER TABLE ADD COLUMN..."]
        H --> C2["DB State mới"]
    end
    
    style G fill:#4CAF50,color:#fff
    style H fill:#2196F3,color:#fff
```

---

## 2. Atlas Architecture

```mermaid
graph LR
    subgraph "Input Sources"
        A[HCL Schema Files<br/>.hcl]
        B[SQL Schema Files<br/>.sql]
        C[Existing Database<br/>PostgreSQL/MySQL...]
        D[ORM Models<br/>GORM/Ent/Django]
    end
    
    subgraph "Atlas Core"
        E[Schema Loader]
        F[Diff Engine]
        G[Plan Generator]
        H[Linter & Validator]
    end
    
    subgraph "Output"
        I[Migration SQL Files]
        J[CI/CD Report]
        K[Applied to DB]
    end
    
    A & B & C & D --> E
    E --> F
    F --> G
    G --> H
    H --> I
    H --> J
    I --> K
    
    style F fill:#FF9800,color:#fff
    style H fill:#4CAF50,color:#fff
```

---

## 3. Installation & Setup

```bash
# === macOS / Linux ===
curl -sSf https://atlasgo.sh | sh

# === Homebrew ===
brew install ariga/tap/atlas

# === Docker ===
docker pull arigaio/atlas

# === Verify ===
atlas version
# atlas version v0.x.x

# === Login (Atlas Cloud — optional cho CI features) ===
atlas login
```

---

## 4. Schema Definition — HCL Format

Atlas dùng HCL (HashiCorp Configuration Language) — tương tự Terraform:

```hcl
-- schema.hcl

# Khai báo database
schema "public" {}

# Khai báo table
table "document" {
  schema = schema.public

  column "id" {
    type = uuid
    default = sql("gen_random_uuid()")
    null = false
  }

  column "document_code" {
    type = varchar(50)
    null = false
  }

  column "case_id" {
    type = uuid
    null = false
  }

  column "status_id" {
    type    = bigint
    null    = false
  }

  column "tenant_code" {
    type    = varchar(20)
    null    = false
    default = "VPBANK"
  }

  column "priority" {
    type    = int
    null    = false
    default = 0
  }

  # Audit columns
  column "created_by"  { type = varchar(100) }
  column "created_at"  { type = timestamptz; null = false; default = sql("NOW()") }
  column "updated_by"  { type = varchar(100) }
  column "updated_at"  { type = timestamptz }

  # Soft delete
  column "deleted"     { type = boolean; null = false; default = false }
  column "deleted_at"  { type = timestamptz }
  column "deleted_by"  { type = varchar(100) }

  primary_key {
    columns = [column.id]
  }

  unique "uq_document_code" {
    columns = [column.document_code]
  }

  foreign_key "fk_document_status" {
    columns     = [column.status_id]
    ref_columns = [table.document_status.column.id]
    on_delete   = RESTRICT
    on_update   = CASCADE
  }

  index "idx_document_status_tenant" {
    columns = [column.status_id, column.tenant_code, column.deleted]
  }

  index "idx_document_created_at" {
    columns = [column.created_at]
    type    = BRIN   # PostgreSQL BRIN index cho time-series data
  }
}

table "document_status" {
  schema = schema.public

  column "id"          { type = bigint; null = false; auto_increment = true }
  column "code"        { type = varchar(50); null = false }
  column "name"        { type = varchar(200); null = false }
  column "description" { type = text }
  column "is_active"   { type = boolean; default = true }
  column "sort_order"  { type = int; default = 0 }

  primary_key  { columns = [column.id] }
  unique "uq_document_status_code" { columns = [column.code] }
}
```

### Alternative: SQL Format (dễ hơn cho team đã quen SQL)

```sql
-- schema.sql (Atlas cũng đọc được SQL thuần)

CREATE TABLE document (
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    document_code   VARCHAR(50) NOT NULL,
    case_id         UUID        NOT NULL,
    status_id       BIGINT      NOT NULL,
    tenant_code     VARCHAR(20) NOT NULL DEFAULT 'VPBANK',
    priority        INT         NOT NULL DEFAULT 0,
    created_by      VARCHAR(100),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      VARCHAR(100),
    updated_at      TIMESTAMPTZ,
    deleted         BOOLEAN     NOT NULL DEFAULT FALSE,
    deleted_at      TIMESTAMPTZ,
    deleted_by      VARCHAR(100),
    PRIMARY KEY (id),
    UNIQUE (document_code)
);

CREATE INDEX idx_document_status_tenant
    ON document(status_id, tenant_code)
    WHERE deleted = false;
```

---

## 5. Core Workflow — Versioned Migration Mode

Atlas có 2 modes chính: **versioned** (giống Flyway) và **declarative** (unique to Atlas).

### Versioned Migration Mode (Recommended cho enterprise)

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant Atlas as Atlas CLI
    participant Desired as schema.hcl (desired state)
    participant DB as Dev Database
    participant Files as migrations/ folder

    Dev->>Desired: Sửa schema.hcl (thêm column, table...)
    Dev->>Atlas: atlas migrate diff "add_priority_column"
    Atlas->>DB: Inspect current state
    DB-->>Atlas: Current schema
    Atlas->>Desired: Load desired state
    Atlas->>Atlas: Calculate diff
    Atlas->>Files: Generate migrations/20241120_add_priority_column.sql
    Files-->>Dev: Review migration SQL
    Dev->>Atlas: atlas migrate apply
    Atlas->>DB: Apply migration
    Atlas->>DB: Record in atlas_schema_revisions
```

### Commands

```bash
# Bước 1: Khởi tạo project Atlas
atlas migrate init --dir "file://migrations" --format atlas

# Bước 2: Định nghĩa desired state trong schema.hcl
# (xem phần 4 ở trên)

# Bước 3: Generate migration từ diff
atlas migrate diff "add_tenant_support" \
  --dir "file://migrations" \
  --to "file://schema.hcl" \
  --dev-url "docker://postgres/15/pdms_dev"
# → Tạo file: migrations/20241120143052_add_tenant_support.sql

# Bước 4: Review migration vừa generate
cat migrations/20241120143052_add_tenant_support.sql

# Bước 5: Apply
atlas migrate apply \
  --dir "file://migrations" \
  --url "postgres://user:pass@localhost:5432/pdms_db?sslmode=disable"

# Xem status
atlas migrate status \
  --dir "file://migrations" \
  --url "postgres://user:pass@localhost:5432/pdms_db?sslmode=disable"
```

---

## 6. Auto-Diff — Killer Feature

```mermaid
graph TB
    subgraph "Tình huống: Staging vs Production drift"
        A[("STAGING DB<br/>Current state")] --> C[Atlas Diff Engine]
        B[("PRODUCTION DB<br/>Target state")] --> C
        C --> D["Diff Report:<br/>+ Missing: idx_document_tenant<br/>+ Extra column: debug_flag<br/>+ Changed type: status_id INT→BIGINT"]
        D --> E["Auto-generated SQL:<br/>CREATE INDEX...<br/>DROP COLUMN...<br/>ALTER TYPE..."]
    end
    
    style C fill:#4CAF50,color:#fff
    style D fill:#FF9800,color:#fff
    style E fill:#2196F3,color:#fff
```

```bash
# Compare 2 databases — giải quyết pain "diff bằng tay"
atlas schema diff \
  --from "postgres://user:pass@staging-db:5432/pdms" \
  --to   "postgres://user:pass@prod-db:5432/pdms"

# Output:
# -- Planned Changes:
# -- Create index "idx_document_tenant" on table "document"
# CREATE INDEX "idx_document_tenant" ON "document" ("tenant_code") WHERE (NOT deleted);
# 
# -- Modify "document" table
# ALTER TABLE "document" ALTER COLUMN "status_id" TYPE bigint;
#
# -- Drop column "debug_flag" from "document"
# ALTER TABLE "document" DROP COLUMN "debug_flag";

# Generate migration file từ diff giữa 2 DB
atlas migrate diff "sync_prod_schema" \
  --from "postgres://user@staging-db:5432/pdms" \
  --to   "postgres://user@prod-db:5432/pdms" \
  --dev-url "docker://postgres/15/temp"
```

---

## 7. CI/CD Linting — Schema Safety Checks

Đây là tính năng **độc đáo** của Atlas — tự động phát hiện destructive/dangerous changes:

```mermaid
graph LR
    A[PR/Push] --> B[atlas migrate lint]
    B --> C{Check Results}
    C -->|Safe| D[✅ Pass CI]
    C -->|Warning| E[⚠️ Warn + Allow]
    C -->|Dangerous| F[❌ Block PR]
    
    subgraph "Checks"
        G[DROP TABLE detect]
        H[DROP COLUMN detect]
        I[Non-backward-compat<br/>type change]
        J[Missing index<br/>for FK]
        K[Lock timeout risk<br/>on large table]
    end
    
    B --> G & H & I & J & K
    
    style D fill:#4CAF50,color:#fff
    style F fill:#F44336,color:#fff
```

### atlas.hcl — Project config

```hcl
# atlas.hcl
data "hcl_template" "vars" {
  path = "atlas.vars.hcl"  # Tách credentials ra file riêng (gitignore)
}

env "local" {
  src = "file://schema.hcl"
  url = "postgres://pdms_user:secret@localhost:5432/pdms_local?sslmode=disable"
  dev = "docker://postgres/15/pdms_dev"

  migration {
    dir = "file://migrations"
  }

  format {
    migrate {
      diff = "{{ sql . \"  \" }}"
    }
  }
}

env "staging" {
  src = "file://schema.hcl"
  url = var.staging_url
  dev = "docker://postgres/15/pdms_dev"

  migration {
    dir = "file://migrations"
  }
}

env "prod" {
  url = var.prod_url
  dev = "docker://postgres/15/pdms_dev"

  migration {
    dir    = "file://migrations"
    revisions-schema = "public"
  }
}

# Lint rules — cấu hình mức độ severity
lint {
  # Destructive changes
  destructive {
    error   = true   # Block CI nếu có DROP TABLE/COLUMN
  }
  
  # Non-backward compatible
  non_linear {
    error = false    # Warning thôi
  }

  # Data-dependent changes (thay đổi column type có data)
  data_depend {
    error = true
  }
}
```

### GitHub Actions CI

```yaml
# .github/workflows/atlas-lint.yml
name: Atlas Schema Lint

on:
  pull_request:
    paths:
      - 'schema.hcl'
      - 'migrations/**'

jobs:
  lint:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_DB: pdms_test
          POSTGRES_USER: pdms_user
          POSTGRES_PASSWORD: test_pass
        ports: ["5432:5432"]
        options: --health-cmd pg_isready

    steps:
      - uses: actions/checkout@v4

      - name: Setup Atlas
        uses: ariga/setup-atlas@v0

      - name: Atlas Lint
        env:
          DATABASE_URL: postgres://pdms_user:test_pass@localhost:5432/pdms_test
        run: |
          atlas migrate lint \
            --dir "file://migrations" \
            --dev-url "postgres://pdms_user:test_pass@localhost:5432/pdms_test" \
            --latest 1 \
            --format "{{ json . }}" | tee lint-result.json
          
          # Fail if any errors
          if cat lint-result.json | jq '.Files[].Reports[].Diagnostics[] | select(.Severity == "ERROR")' | grep -q .; then
            echo "❌ Schema lint failed — dangerous changes detected"
            cat lint-result.json | jq '.Files[].Reports[].Diagnostics[]'
            exit 1
          fi
          
          echo "✅ Schema lint passed"

      - name: Comment PR with lint results
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const lintResult = JSON.parse(fs.readFileSync('lint-result.json', 'utf8'));
            // Post formatted results as PR comment
```

---

## 8. Inspect — Reverse Engineer từ Database

```bash
# Inspect DB hiện tại → tạo schema.hcl (tương tự generateChangeLog của Liquibase)
atlas schema inspect \
  --url "postgres://user:pass@prod-db:5432/pdms?sslmode=disable" \
  --format "{{ hcl . }}" \
  > schema.hcl

# Inspect → SQL format
atlas schema inspect \
  --url "postgres://user:pass@prod-db:5432/pdms" \
  --format "{{ sql . }}" \
  > schema.sql

# Inspect chỉ specific schemas
atlas schema inspect \
  --url "postgres://user:pass@prod-db:5432/pdms" \
  --schema public,iam \
  > schema.hcl
```

---

## 9. Atlas với Stored Procedures — Limitation & Workaround

```mermaid
graph TB
    A[Stored Procedures<br/>Functions<br/>Triggers] --> B{Atlas hỗ trợ?}
    B -->|Hạn chế| C["Atlas chỉ track<br/>schema structure<br/>KHÔNG phải SP logic"]
    B -->|Workaround 1| D["Dùng atlas migrate diff<br/>với raw SQL files<br/>chứa SP definitions"]
    B -->|Workaround 2| E["Kết hợp với Flyway:<br/>Atlas → DDL<br/>Flyway Repeatable → SP"]
    
    style C fill:#FF5722,color:#fff
    style D fill:#FF9800,color:#fff
    style E fill:#4CAF50,color:#fff
```

### Workaround: Custom migration files cho SP

```bash
# Atlas generate migration cho DDL changes
atlas migrate diff "add_warehouse_table" \
  --dir "file://migrations" \
  --to "file://schema.hcl"

# Thêm tay stored procedure vào migration file vừa tạo
# HOẶC tạo separate migration file

# migrations/20241120_add_warehouse_table.sql (atlas generated)
-- Add new warehouse table
CREATE TABLE "warehouse" (...);

-- migrations/20241120_update_stored_procs.sql (manually added)
CREATE OR REPLACE FUNCTION sp_generate_warehouse_code(...)
...;
```

---

## 10. Atlas vs Schema Drift Detection

```bash
# Phát hiện drift: DB hiện tại vs schema.hcl (desired)
atlas schema diff \
  --from "postgres://user:pass@prod-db:5432/pdms" \
  --to   "file://schema.hcl" \
  --dev-url "docker://postgres/15/temp"

# Output khi prod bị drift:
# -- Missing objects in target schema:
# -- Add column "debug_temp" in table "document" (bị thêm tay trên prod!)
#
# -- Missing objects in source DB:
# -- Index "idx_document_priority" (trong schema.hcl nhưng quên apply lên prod)
#
# → Phát hiện drift ngay, không cần ngồi compare thủ công
```

---

## Summary

```
Atlas strengths:
✅ Auto-diff engine: không cần tự viết migration SQL
✅ CI/CD linting: phát hiện dangerous changes trước khi apply
✅ Schema-as-code (HCL): versioned, reviewable, diffable
✅ Drift detection: biết ngay khi DB và code lệch nhau
✅ Multi-database: PostgreSQL, MySQL, MariaDB, SQLite, SQL Server
✅ Inspect: reverse-engineer DB hiện có thành HCL

Atlas weaknesses:
❌ Stored Procedures: hỗ trợ hạn chế (cần workaround)
❌ Không integrate Spring Boot auto-run (cần manual/K8s job)
❌ Nhỏ ecosystem hơn Flyway/Liquibase
❌ Complex DML migration: phải tự viết
❌ Learning curve HCL cho team chưa biết Terraform syntax
```

**Next**: [[DBMigration-03-Tool-Comparison]]

---

#atlasgo #schema-as-code #database-migration #postgresql #cicd #declarative

---

## Deep Dive — Declarative thực sự nghĩa là gì?

### Imperative vs Declarative — Ví dụ bằng ngôn ngữ tự nhiên

Cách dễ nhất để hiểu sự khác biệt:

```
Tình huống: Bạn muốn đến nhà hàng

Imperative (Flyway style):
  "Đi thẳng 200m, rẽ trái, đi 100m, rẽ phải, đến số nhà 42"
  → Bạn mô tả từng BƯỚC để đến đó
  → Nếu có công trình đang sửa → lệnh "đi thẳng 200m" sẽ thất bại
  
Declarative (Atlas style):
  "Tôi muốn đến nhà hàng Phở Bắc, 42 Hàng Bông"
  → Bạn mô tả ĐÍCH ĐẾN, không quan tâm đường đi
  → GPS (Atlas) tự tìm đường tốt nhất từ vị trí hiện tại
```

Áp dụng vào database:

```
Imperative (Flyway):
  Bạn viết: ALTER TABLE document ADD COLUMN priority INT;
  Flyway thực thi chính xác câu SQL đó
  → Bạn phải biết DB đang ở đâu để viết đúng SQL

Declarative (Atlas):
  Bạn khai báo: table document { column priority { type = int } }
  Atlas nhìn vào DB hiện tại: "DB đang có gì?"
  Atlas tính diff: "Thiếu column priority"
  Atlas tự generate: ALTER TABLE document ADD COLUMN priority INT;
  → Bạn chỉ cần biết muốn DB trông như thế nào
```

---

### Atlas Dev Database — Tại sao cần?

Khi chạy `atlas migrate diff`, Atlas cần một **dev database** tạm thời để tính diff. Đây là điều nhiều người không hiểu tại sao.

```
Atlas diff process (chi tiết):
────────────────────────────────

Bước 1: Atlas tạo dev DB trống (dùng Docker)
         docker://postgres/15/pdms_dev → Atlas tự spin up container

Bước 2: Apply desired state vào dev DB
         Đọc schema.hcl → chạy SQL tương đương trên dev DB
         Dev DB bây giờ có schema mà BẠN MUỐN

Bước 3: Inspect dev DB → "Desired state thực tế trông như thế nào?"
         (Đôi khi HCL → SQL có edge cases)

Bước 4: Inspect target DB → "DB hiện tại có gì?"

Bước 5: Diff: Desired state - Current state = Changes needed

Bước 6: Generate migration SQL từ changes

Bước 7: Destroy dev DB (cleanup)
```

```
Tại sao không diff trực tiếp schema.hcl với target DB?
────────────────────────────────────────────────────────
Vì HCL là "ngôn ngữ khai báo" — cần compile ra SQL thực tế mới compare được
Giống như bạn không compare TypeScript source với compiled JS output trực tiếp
→ Dev DB là bước "compile HCL thành real schema" trước khi diff
```

---

### Atlas Versioned vs Declarative Mode — Khi nào dùng cái nào?

Atlas có hai chế độ hoàn toàn khác nhau, dễ nhầm:

```
Versioned Mode (atlas migrate):
────────────────────────────────
Atlas generate migration FILES (giống Flyway)
Bạn review file trước khi apply
Files được versioned trong Git
Apply bằng: atlas migrate apply

→ Dùng cho: production environments, cần review/approval
→ Dùng cho: team lớn, cần audit trail rõ ràng

Declarative Mode (atlas schema apply):
────────────────────────────────────────
Atlas tính diff và apply TRỰC TIẾP lên DB
KHÔNG tạo migration files
Mỗi lần chạy: Atlas sync DB về desired state

→ Dùng cho: development local (reset nhanh)
→ Dùng cho: CI ephemeral test databases
→ KHÔNG dùng cho: production (không có audit trail)
```

```bash
# Versioned mode — generate file rồi review
atlas migrate diff "add_priority_column" \
  --dir "file://migrations" \
  --to "file://schema.hcl" \
  --dev-url "docker://postgres/15/dev"

# → Tạo file: migrations/20241120_add_priority_column.sql
# → Bạn review file
# → atlas migrate apply

# Declarative mode — apply thẳng, không file
atlas schema apply \
  --url "postgres://user@localhost/pdms_local" \
  --to "file://schema.hcl" \
  --dev-url "docker://postgres/15/dev"

# → Atlas tính diff và apply luôn
# → Không có file nào được tạo
# → NGUY HIỂM trên prod vì không có cách review
```

---

### Atlas Lint — Hiểu từng loại check

Atlas phát hiện các loại thay đổi nguy hiểm khác nhau:

```
1. DESTRUCTIVE — Mất data ngay lập tức
───────────────────────────────────────
DROP TABLE          → Xóa cả bảng + data
DROP COLUMN         → Xóa column + data trong đó
TRUNCATE TABLE      → Xóa sạch data

Atlas: ERROR by default — block CI

2. DATA_DEPEND — Có thể mất data tùy vào data thực tế
──────────────────────────────────────────────────────
ALTER COLUMN type (INT → VARCHAR)   → Có thể fail nếu data không convert được
ADD CONSTRAINT NOT NULL             → Fail nếu có row có NULL
ADD UNIQUE CONSTRAINT               → Fail nếu có duplicate data

Atlas: ERROR by default — phải review

3. NON_LINEAR — Thứ tự migration không theo line thẳng
───────────────────────────────────────────────────────
Migration version thấp hơn xuất hiện sau version cao hơn đã chạy
(out-of-order như đã giải thích ở bài 01)

Atlas: WARNING — không block nhưng cảnh báo

4. CONCURRENT_INDEX — Index tạo không CONCURRENTLY trên large table
────────────────────────────────────────────────────────────────────
CREATE INDEX (không có CONCURRENTLY) → lock table khi tạo
Trên table lớn: lock hàng phút/giờ → outage

Atlas: WARNING — nhắc dùng CONCURRENTLY
```

```hcl
# atlas.hcl — Cấu hình severity level
lint {
  destructive {
    error = true    # Block CI khi có DROP TABLE/COLUMN
  }
  data_depend {
    error = true    # Block CI khi có thay đổi phụ thuộc data
  }
  non_linear {
    error = false   # Chỉ warn, không block
  }
}
```
