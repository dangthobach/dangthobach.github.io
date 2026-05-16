# Adoption Roadmap — Triển khai Migration Tool cho Dự án Đang Giữa Chừng

> **Tình huống thực tế**: Dự án PDMS đang giữa phase với 200 bảng, 50 stored procedures, scripts lưu rải rác, golive bị thiếu scripts. Cần triển khai **nhanh**, **an toàn**, **song song** với feature development.

**Series**: [[DBMigration-MOC]] | **Prev**: [[DBMigration-04-Enterprise-Patterns]]

---

## 1. Phân tích tình huống hiện tại

```mermaid
graph TB
    subgraph "Hiện trạng PDMS"
        A[200 tables<br/>trên Production] --> PAIN
        B[50 stored procs/<br/>functions] --> PAIN
        C[Scripts lưu rải rác<br/>Google Drive / local] --> PAIN
        D[Dev tự quản lý<br/>scripts cá nhân] --> PAIN
        PAIN[💥 GOLIVE PAIN<br/>• Thiếu scripts<br/>• Thiếu constraints<br/>• Thiếu seed data<br/>• Diff thủ công 2-4 giờ]
    end
    
    subgraph "Yêu cầu"
        R1[Triển khai nhanh]
        R2[Song song feature dev]
        R3[Không dừng delivery]
        R4[Giải quyết triệt để]
    end
    
    PAIN --> SOLUTION[Cần lộ trình<br/>triển khai migration tool]
    R1 & R2 & R3 & R4 --> SOLUTION
    
    style PAIN fill:#F44336,color:#fff
    style SOLUTION fill:#4CAF50,color:#fff
```

---

## 2. Lựa chọn Tool cho PDMS

```mermaid
flowchart TD
    Q1{Ưu tiên<br/>hàng đầu?} --> A1[Adopt nhanh<br/>ít học mới]
    Q1 --> A2[Audit trail<br/>ngân hàng]
    Q1 --> A3[Auto-diff<br/>schema]
    
    A1 --> FLYWAY[🟠 Flyway<br/>+ Atlas CI lint]
    A2 --> LIQUIBASE[🔵 Liquibase<br/>standalone]
    A3 --> ATLAS[🟢 Atlas<br/>+ Flyway SP]
    
    FLYWAY --> C1["✅ SQL-first<br/>✅ Dev đã biết SQL<br/>✅ Spring Boot native<br/>✅ Repeatable cho SP<br/>⚠️ Rollback cần plan thủ công"]
    LIQUIBASE --> C2["✅ Audit trail đầy đủ<br/>✅ Built-in rollback<br/>✅ Preconditions<br/>⚠️ Learning curve cao hơn<br/>⚠️ XML overhead"]
    ATLAS --> C3["✅ Auto-diff tốt nhất<br/>✅ CI linting<br/>⚠️ SP support kém<br/>⚠️ Không Spring Boot auto"]
    
    C1 --> REC[🏆 Khuyến nghị cho PDMS<br/>Flyway làm core + Atlas cho CI lint<br/>Khi team quen → consider Liquibase nếu cần audit sâu hơn]
    
    style REC fill:#4CAF50,color:#fff
    style FLYWAY fill:#FF9800,color:#fff
```

**Kết luận: Flyway + Atlas CI** vì:
- Dev team quen SQL → zero learning curve
- 50 SPs → Flyway Repeatable migration là lý tưởng
- Spring Boot native → không cần thêm infrastructure
- Atlas CI → giải quyết drift detection và safety check

---

## 3. Lộ trình triển khai — 6 tuần

```mermaid
gantt
    title PDMS Migration Tool Adoption Roadmap
    dateFormat  YYYY-MM-DD
    axisFormat  Week %W

    section 🔴 Phase 0 (Tuần 1)
    Audit toàn bộ scripts hiện tại       :active, p0a, 2024-11-25, 2d
    Generate baseline từ Prod DB          :p0b, after p0a, 2d
    Setup Flyway + test local             :p0c, after p0b, 1d

    section 🟡 Phase 1 (Tuần 2-3)
    Flyway baseline trên tất cả envs      :p1a, 2024-12-02, 3d
    Collect + version toàn bộ SPs hiện có :p1b, after p1a, 4d
    Team training + PR template           :p1c, after p1b, 2d

    section 🟢 Phase 2 (Tuần 4-5)
    CI/CD pipeline Flyway validate        :p2a, 2024-12-16, 3d
    Atlas CI lint setup                   :p2b, after p2a, 2d
    First golive với Flyway               :p2c, after p2b, 2d
    Monitoring + troubleshooting          :p2d, after p2c, 3d

    section 🔵 Phase 3 (Tuần 6+)
    Weekly schema audit automation        :p3a, 2024-12-30, 3d
    Rollback plan documentation           :p3b, after p3a, 2d
    Team retrospective + optimize         :p3c, after p3b, 2d
```

---

## 4. Phase 0 — Tuần 1: Audit & Baseline (Critical)

### Bước 0.1: Audit scripts hiện có

```bash
#!/bin/bash
# audit-scripts.sh — Kiểm kê toàn bộ scripts hiện có

echo "=== Script Audit Report - $(date) ==="

# Thu thập từ các nguồn khác nhau
# (Điều chỉnh paths theo thực tế dự án)
SCRIPT_DIRS=(
    "./scripts"
    "./database"
    "./sql"
    "$HOME/Downloads"  # Scripts dev lưu local
    "./docs/database"
)

for dir in "${SCRIPT_DIRS[@]}"; do
    if [ -d "$dir" ]; then
        echo ""
        echo "📁 $dir:"
        find "$dir" -name "*.sql" -o -name "*.ddl" | sort | while read f; do
            lines=$(wc -l < "$f")
            modified=$(stat -c "%y" "$f" 2>/dev/null || stat -f "%Sm" "$f")
            echo "   $f ($lines lines, modified: $modified)"
        done
    fi
done

echo ""
echo "=== Stored Procedures in PROD DB ==="
psql "$PROD_DB_URL" << 'ENDSQL'
SELECT
    routine_name,
    routine_type,
    data_type,
    pg_size_pretty(pg_proc_size(p.oid)) as code_size
FROM information_schema.routines r
JOIN pg_proc p ON p.proname = r.routine_name
WHERE r.routine_schema = 'public'
ORDER BY routine_type, routine_name;
ENDSQL

echo ""
echo "=== Tables in PROD DB ==="
psql "$PROD_DB_URL" << 'ENDSQL'
SELECT
    table_name,
    pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) as total_size,
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = t.table_name AND table_schema = 'public') as col_count
FROM information_schema.tables t
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY pg_total_relation_size(quote_ident(table_name)) DESC;
ENDSQL
```

### Bước 0.2: Generate Baseline từ Production DB

```bash
#!/bin/bash
# generate-baseline.sh

echo "=== Generating Flyway Baseline from Production DB ==="

mkdir -p src/main/resources/db/migration/baseline
mkdir -p src/main/resources/db/stored_procedures

# Option A: Dùng pg_dump để dump schema (đơn giản nhất)
pg_dump \
  --schema-only \
  --no-owner \
  --no-privileges \
  --schema=public \
  --exclude-table=flyway_schema_history \
  "$PROD_DB_URL" \
  > src/main/resources/db/migration/baseline/V1__Baseline_existing_schema.sql

echo "✅ Generated: V1__Baseline_existing_schema.sql"

# Option B: Dùng Atlas inspect (output cleaner)
atlas schema inspect \
  --url "$PROD_DB_URL" \
  --format "{{ sql . }}" \
  --exclude "flyway_schema_history" \
  > /tmp/atlas-schema.sql

echo "✅ Generated Atlas schema dump"

# Extract stored procedures separately
psql "$PROD_DB_URL" << 'ENDSQL' > /tmp/extract-procs.sql
SELECT
    'CREATE OR REPLACE ' || routine_type || ' ' || routine_name ||
    '(' ||
    string_agg(
        parameter_name || ' ' || data_type,
        ', ' ORDER BY ordinal_position
    ) ||
    ')' || E'\n' ||
    'RETURNS ' || type_udt_name || E'\n' ||
    'LANGUAGE ' || external_language || E'\n' ||
    'AS $$ ' || routine_definition || ' $$;' as full_definition
FROM information_schema.routines
LEFT JOIN information_schema.parameters USING (specific_name)
WHERE routine_schema = 'public'
GROUP BY routine_type, routine_name, type_udt_name, external_language, routine_definition;
ENDSQL

echo "✅ Extracted stored procedures"
echo ""
echo "Next steps:"
echo "  1. Review V1__Baseline_existing_schema.sql"
echo "  2. Split stored procs into R__*.sql files"
echo "  3. Run: flyway baseline"
```

### Bước 0.3: Tổ chức stored procedures thành Repeatable migrations

```bash
#!/bin/bash
# organize-stored-procs.sh
# Tách từng stored proc thành file R__ riêng

SP_DIR="src/main/resources/db/stored_procedures"
mkdir -p "$SP_DIR/functions" "$SP_DIR/procedures" "$SP_DIR/views" "$SP_DIR/triggers"

# Lấy danh sách functions từ DB
psql "$PROD_DB_URL" -t -c \
  "SELECT routine_name, routine_type FROM information_schema.routines
   WHERE routine_schema = 'public' ORDER BY routine_type, routine_name;" | \
while IFS='|' read -r name type; do
    name=$(echo "$name" | xargs)
    type=$(echo "$type" | xargs)
    
    case "$type" in
        "FUNCTION")
            # Extract function definition
            psql "$PROD_DB_URL" -t -c \
              "SELECT pg_get_functiondef(oid) FROM pg_proc
               WHERE proname = '$name' AND pronamespace = 'public'::regnamespace;" \
              > "$SP_DIR/functions/R__010_FN_${name}.sql"
            echo "✅ Extracted: FN_${name}"
            ;;
        "PROCEDURE")
            psql "$PROD_DB_URL" -t -c \
              "SELECT pg_get_functiondef(oid) FROM pg_proc
               WHERE proname = '$name' AND pronamespace = 'public'::regnamespace;" \
              > "$SP_DIR/procedures/R__020_SP_${name}.sql"
            echo "✅ Extracted: SP_${name}"
            ;;
    esac
done

echo ""
echo "Files created in $SP_DIR"
echo "⚠️  IMPORTANT: Review each file and add CREATE OR REPLACE if missing"
```

### Bước 0.4: Flyway Baseline — Mark DB hiện tại là đã "migrate xong"

```bash
# Cực kỳ quan trọng — làm sai là mất toàn bộ công

# Setup Flyway properties
cat > flyway.conf << 'EOF'
flyway.url=jdbc:postgresql://prod-db:5432/pdms_prod
flyway.user=flyway_user
flyway.password=${FLYWAY_PROD_PASS}
flyway.locations=classpath:db/migration,classpath:db/stored_procedures
flyway.baselineVersion=1
flyway.baselineDescription=Existing PDMS schema before Flyway adoption
EOF

# QUAN TRỌNG: Baseline chỉ chạy 1 lần trên mỗi DB
# Sau khi baseline, flyway_schema_history sẽ có record với type = 'BASELINE'
flyway baseline -configFiles=flyway.conf

# Verify
flyway info -configFiles=flyway.conf

# Expected output:
# +-----------+---------+-----------------------------------+----------+
# | Category  | Version | Description                       | State    |
# +-----------+---------+-----------------------------------+----------+
# | Versioned | 1       | Existing PDMS schema before...    | Baseline |
# +-----------+---------+-----------------------------------+----------+
# (No Pending migrations — baseline thành công!)
```

---

## 5. Phase 1 — Tuần 2-3: Rollout & Team Onboarding

### Bước 1.1: Apply Baseline trên tất cả environments

```mermaid
sequenceDiagram
    participant DBA as DBA/Lead Dev
    participant Prod as Production
    participant Stage as Staging
    participant Dev as Development

    DBA->>Prod: flyway baseline (đã làm Phase 0)
    DBA->>Stage: pg_dump prod → restore staging
    DBA->>Stage: flyway baseline (trên staging snapshot)
    DBA->>Dev: flyway baseline (trên dev DB)
    
    Note over Prod,Dev: Tất cả environments bây giờ đều<br/>có flyway_schema_history với Baseline record
    
    DBA->>DBA: Từ đây mọi thay đổi qua Flyway!
```

### Bước 1.2: Git Repository Structure Setup

```bash
# Khởi tạo cấu trúc thư mục
mkdir -p src/main/resources/db/{migration,stored_procedures/{functions,procedures,views,triggers},seed}

# .gitignore additions
cat >> .gitignore << 'EOF'
# Flyway
flyway.conf
flyway-*.conf
# Atlas
.atlas/
atlas.vars.hcl
EOF

# pom.xml — add Flyway dependency
# (thêm vào pom.xml thủ công)

# application.yml — cấu hình Flyway
cat >> src/main/resources/application.yml << 'EOF'
spring:
  flyway:
    enabled: true
    locations:
      - classpath:db/migration
      - classpath:db/stored_procedures
    baseline-on-migrate: false   # Đã baseline rồi, không cần
    validate-on-migrate: true
    clean-disabled: true
EOF
```

### Bước 1.3: PR Template & Team Conventions

```markdown
<!-- .github/pull_request_template.md -->

## DB Changes Checklist

### Nếu PR có thay đổi database:

- [ ] Migration file đặt đúng folder và đúng naming convention
  - Versioned: `V{version}__{description}.sql` trong `db/migration/`
  - Repeatable (SP/Function/View): `R__{prefix}_{name}.sql` trong `db/stored_procedures/`
  
- [ ] Version number theo sau version cao nhất hiện có
  - Check: `flyway info` hoặc xem file cuối trong `db/migration/`
  
- [ ] Migration đã test trên local DB
  - [ ] `flyway migrate` chạy thành công
  - [ ] App khởi động không lỗi
  
- [ ] Nếu ALTER TABLE trên bảng lớn: dùng 3-bước pattern (nullable → fill → NOT NULL)

- [ ] INSERT data dùng `ON CONFLICT DO NOTHING` hoặc `ON CONFLICT DO UPDATE`

- [ ] Stored Procedure dùng `CREATE OR REPLACE` (không DROP trước)

- [ ] Đã nghĩ đến rollback plan?

### Script tự kiểm tra:
```bash
flyway validate -url=$LOCAL_DB_URL
flyway info -url=$LOCAL_DB_URL | grep -E "Pending|Outdated"
```
```

### Bước 1.4: Developer Training — Cheat Sheet

```
📋 FLYWAY CHEAT SHEET CHO DEV

1. VIẾT MIGRATION MỚI:
   a. Tìm version hiện tại cao nhất: flyway info | grep Success | tail -1
   b. Tạo file: V{next}__{mô tả}.sql trong db/migration/
   c. Test local: flyway migrate
   d. Check: flyway info

2. SỬA STORED PROCEDURE:
   a. Sửa file R__XXX_SP_name.sql (ĐỪNG tạo file mới)
   b. Dùng CREATE OR REPLACE FUNCTION (không DROP)
   c. flyway migrate → tự detect và re-run file đã thay đổi

3. QUY TẮC VÀNG:
   ❌ Không sửa file V__ đã chạy (checksum mismatch!)
   ❌ Không dùng DROP trong SP files (dùng CREATE OR REPLACE)
   ✅ INSERT data luôn có ON CONFLICT
   ✅ ALTER TABLE lớn: nullable trước, fill sau, constraint cuối

4. COMMANDS THƯỜNG DÙNG:
   flyway info       → Xem status
   flyway migrate    → Apply pending
   flyway validate   → Check trước khi commit
   flyway repair     → Fix failed migration record
```

---

## 6. Phase 2 — Tuần 4-5: CI/CD & First Golive

### CI Pipeline Setup

```yaml
# .github/workflows/db-migration.yml

name: Database Migration CI

on:
  pull_request:
    paths:
      - 'src/main/resources/db/**'
      - 'pom.xml'

jobs:
  flyway-validate:
    name: Validate Migrations
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_DB: pdms_ci
          POSTGRES_USER: pdms_user
          POSTGRES_PASSWORD: ci_pass
        ports: ["5432:5432"]
        options: --health-cmd pg_isready --health-interval 5s

    steps:
      - uses: actions/checkout@v4

      - name: Setup Java
        uses: actions/setup-java@v4
        with:
          java-version: '17'
          distribution: 'temurin'

      - name: Flyway Baseline (fresh DB, simulate starting from scratch)
        run: |
          # Simulate: apply baseline migration trước
          psql postgres://pdms_user:ci_pass@localhost:5432/pdms_ci \
            -f src/main/resources/db/migration/V1__Baseline_existing_schema.sql

      - name: Flyway Validate + Migrate
        env:
          FLYWAY_URL: jdbc:postgresql://localhost:5432/pdms_ci
          FLYWAY_USER: pdms_user
          FLYWAY_PASSWORD: ci_pass
        run: |
          mvn flyway:validate flyway:migrate \
            -Dflyway.url=$FLYWAY_URL \
            -Dflyway.user=$FLYWAY_USER \
            -Dflyway.password=$FLYWAY_PASSWORD \
            -Dflyway.locations=classpath:db/migration,classpath:db/stored_procedures

      - name: Check Status
        run: |
          mvn flyway:info \
            -Dflyway.url=$FLYWAY_URL \
            -Dflyway.user=$FLYWAY_USER \
            -Dflyway.password=$FLYWAY_PASSWORD

  atlas-lint:
    name: Atlas Schema Lint
    runs-on: ubuntu-latest
    needs: flyway-validate
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_DB: pdms_lint
          POSTGRES_USER: pdms_user
          POSTGRES_PASSWORD: lint_pass
        ports: ["5432:5432"]
        options: --health-cmd pg_isready

    steps:
      - uses: actions/checkout@v4

      - name: Setup Atlas
        uses: ariga/setup-atlas@v0

      - name: Apply baseline to lint DB
        run: |
          psql postgres://pdms_user:lint_pass@localhost:5432/pdms_lint \
            -f src/main/resources/db/migration/V1__Baseline_existing_schema.sql

      - name: Atlas Lint — detect dangerous changes
        run: |
          atlas migrate lint \
            --dir "file://src/main/resources/db/migration" \
            --dev-url "postgres://pdms_user:lint_pass@localhost:5432/pdms_lint" \
            --latest 5 \
            --format '{{ range .Files }}{{ range .Reports }}{{ range .Diagnostics }}{{ .Text }}{{ "\n" }}{{ end }}{{ end }}{{ end }}'
```

### First Golive Procedure

```bash
#!/bin/bash
# first-golive-with-flyway.sh
# Lần đầu golive với Flyway — cẩn thận nhất

set -e

echo "╔══════════════════════════════════════════╗"
echo "║  FIRST GOLIVE WITH FLYWAY — PDMS PROD   ║"
echo "╚══════════════════════════════════════════╝"

# Pre-flight checks
echo ""
echo "Step 1: Pre-flight checks"
echo "─────────────────────────"

# Check DB connectivity
psql "$PROD_DB_URL" -c "SELECT version();" > /dev/null
echo "✅ DB connection OK"

# Check flyway history table exists
TABLE_EXISTS=$(psql "$PROD_DB_URL" -t -c \
  "SELECT COUNT(*) FROM information_schema.tables
   WHERE table_name = 'flyway_schema_history';")
[ "$TABLE_EXISTS" -gt 0 ] && echo "✅ flyway_schema_history exists" || \
  echo "⚠️  flyway_schema_history missing — run baseline first!"

# Show pending migrations
echo ""
echo "Step 2: Preview pending migrations"
echo "────────────────────────────────────"
flyway info \
  -url="$PROD_DB_URL" \
  -user="$FLYWAY_PROD_USER" \
  -password="$FLYWAY_PROD_PASS" \
  -locations="classpath:db/migration,classpath:db/stored_procedures"

echo ""
read -p "Continue with golive? (yes/no): " confirm
[ "$confirm" = "yes" ] || exit 0

# Take DB backup
echo ""
echo "Step 3: Taking DB backup..."
pg_dump "$PROD_DB_URL" \
  --schema-only \
  --file="backup-schema-$(date +%Y%m%d-%H%M%S).sql"
echo "✅ Schema backup created"

# Apply migrations
echo ""
echo "Step 4: Applying migrations..."
flyway migrate \
  -url="$PROD_DB_URL" \
  -user="$FLYWAY_PROD_USER" \
  -password="$FLYWAY_PROD_PASS" \
  -locations="classpath:db/migration,classpath:db/stored_procedures"

echo "✅ Migrations applied"

# Verify
echo ""
echo "Step 5: Post-golive verification..."
flyway info \
  -url="$PROD_DB_URL" \
  -user="$FLYWAY_PROD_USER" \
  -password="$FLYWAY_PROD_PASS"

PENDING=$(flyway info -url="$PROD_DB_URL" -outputType=json \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for m in d.get('migrations',[]) if m.get('state') in ['Pending','Outdated']))")

[ "$PENDING" -eq 0 ] && echo "✅ 0 pending migrations — golive SUCCESS!" || \
  echo "❌ Still $PENDING pending migrations!"

echo ""
echo "╔══════════════════════════════╗"
echo "║  GOLIVE COMPLETE ✅          ║"
echo "╚══════════════════════════════╝"
```

---

## 7. Phase 3 — Tuần 6+: Steady State Operations

### Weekly Schema Audit Automation

```bash
#!/bin/bash
# weekly-audit.sh — Chạy mỗi thứ Hai sáng qua cron

REPORT_FILE="schema-audit-$(date +%Y%m%d).txt"

echo "=== Weekly Schema Audit: $(date) ===" > "$REPORT_FILE"

# 1. Flyway status all environments
for ENV in staging prod; do
    eval DB_URL=\$${ENV^^}_DB_URL
    echo "" >> "$REPORT_FILE"
    echo "--- $ENV: Pending migrations ---" >> "$REPORT_FILE"
    flyway info \
      -url="$DB_URL" \
      -user="$FLYWAY_USER" \
      -password="$FLYWAY_PASS" \
      -outputType=json | \
      python3 -c "
import sys, json
d = json.load(sys.stdin)
pending = [m for m in d.get('migrations', []) if m.get('state') in ['Pending', 'Outdated']]
if pending:
    print(f'⚠️  {len(pending)} pending/outdated migrations!')
    for m in pending: print(f'  - {m[\"script\"]} ({m[\"state\"]})')
else:
    print('✅ All up to date')
" >> "$REPORT_FILE"
done

# 2. Atlas drift check: staging vs prod
echo "" >> "$REPORT_FILE"
echo "--- Schema Drift: Staging vs Prod ---" >> "$REPORT_FILE"
atlas schema diff \
  --from "$STAGING_DB_URL" \
  --to   "$PROD_DB_URL" \
  >> "$REPORT_FILE" 2>&1 || echo "⚠️  Drift detected (see above)" >> "$REPORT_FILE"

# 3. Send report via Slack/email
cat "$REPORT_FILE"
# curl -X POST $SLACK_WEBHOOK -d "{\"text\": \"$(cat $REPORT_FILE)\"}"
```

---

## 8. Rollback Plan — Từng Scenario

```mermaid
flowchart TD
    FAIL[🚨 Golive thất bại] --> Q1{Flyway apply<br/>thành công chưa?}
    
    Q1 -->|Không - Flyway failed| R1["flyway repair<br/>→ Fix SQL trong file<br/>→ flyway migrate lại"]
    
    Q1 -->|Có - App lỗi sau migrate| Q2{Migration đã<br/>thay đổi data không?}
    
    Q2 -->|Không - chỉ DDL| R2["Viết reverse migration:<br/>V{next}__Rollback_feature.sql<br/>VD: DROP COLUMN thêm vào"]
    
    Q2 -->|Có - đã UPDATE data| R3{Có backup<br/>trước golive không?}
    
    R3 -->|Có| R4["Restore từ backup<br/>(nếu data quan trọng hơn)<br/>Hoặc viết reverse UPDATE"]
    
    R3 -->|Không| R5["⚠️ Viết reverse UPDATE<br/>VD: UPDATE SET old_value<br/>Accept data loss nếu cần"]
    
    style FAIL fill:#F44336,color:#fff
    style R2 fill:#FF9800,color:#fff
    style R4 fill:#4CAF50,color:#fff
    style R5 fill:#F44336,color:#fff
```

### Rollback SQL Template

```sql
-- V{next}__Rollback_{feature_name}.sql
-- Created: {date}
-- Reason: Rollback {original migration} due to {reason}
-- Original migration: V{X}__{feature}

BEGIN;

-- Reverse của từng change trong original migration (theo thứ tự ngược)

-- VD: Original đã ADD COLUMN → Rollback DROP COLUMN
ALTER TABLE document DROP COLUMN IF EXISTS priority;

-- VD: Original đã UPDATE data → Rollback UPDATE
-- UPDATE document SET status = old_value WHERE condition;
-- ⚠️ Chỉ làm được nếu có cách xác định records nào đã bị đổi

-- VD: Original đã CREATE TABLE → Rollback DROP TABLE
DROP TABLE IF EXISTS new_feature_table;

-- VD: Original đã CREATE INDEX → Rollback DROP INDEX
DROP INDEX IF EXISTS idx_new_feature;

COMMIT;
```

---

## 9. Success Metrics — Đo lường hiệu quả

```mermaid
xychart-beta
    title "Golive Pain Score (trước vs sau)"
    x-axis ["Thời gian compare scripts", "Số lần thiếu scripts", "Stress level", "Rollback time", "Audit clarity"]
    y-axis "Pain Score (10=worst)" 0 --> 10
    bar [9, 8, 9, 10, 9]
    bar [2, 1, 2, 3, 1]
```

| Metric | Trước | Sau 6 tuần |
|--------|-------|------------|
| Thời gian compare scripts | 2-4 giờ | 5 phút (`flyway info`) |
| Số lần thiếu scripts/golive | 3-5 lần | 0 (versioned in Git) |
| Rollback time | Không có plan | < 30 phút (reverse migration) |
| Ai đang chạy gì | Không biết | `flyway_schema_history` |
| Dev viết script trùng nhau | Thường xuyên | Không (version conflict detected) |
| Golive stress level | 🔴 Cao | 🟢 Thấp |

---

## 10. Final Checklist — Sẵn sàng Go!

```
PHASE 0 CHECKLIST (Tuần 1):
  ☐ Audit tất cả scripts hiện có
  ☐ Generate V1__Baseline_existing_schema.sql từ prod
  ☐ Extract 50 SPs thành R__*.sql files riêng
  ☐ Add Flyway dependency vào pom.xml
  ☐ Configure application.yml cho mỗi env
  ☐ flyway baseline trên PROD ← quan trọng nhất!
  ☐ flyway baseline trên STAGING
  ☐ flyway baseline trên DEV
  ☐ flyway info → confirm 0 pending

PHASE 1 CHECKLIST (Tuần 2-3):
  ☐ Git repo structure setup
  ☐ PR template với DB checklist
  ☐ Team training session (1 giờ)
  ☐ Dev cheat sheet distributed
  ☐ First feature migration được merge

PHASE 2 CHECKLIST (Tuần 4-5):
  ☐ CI pipeline validate migrations on PR
  ☐ Atlas lint setup
  ☐ First golive với Flyway thành công
  ☐ pre-golive-check.sh chạy trước golive

PHASE 3 CHECKLIST (Tuần 6+):
  ☐ Weekly audit cron job setup
  ☐ Rollback plan documented
  ☐ Team retrospective done
  ☐ 0 missing scripts trong 2 golives liên tiếp → SUCCESS 🏆
```

---

#adoption-roadmap #flyway #atlasgo #enterprise #pdms #migration #golive #postgresql

---

## Deep Dive — Những câu hỏi thực tế khi adopt

### Baseline thực sự làm gì với flyway_schema_history?

```
Khi chạy: flyway baseline -baselineVersion=1
────────────────────────────────────────────

Flyway INSERT 1 row vào flyway_schema_history:
  installed_rank = 1
  version        = "1"
  description    = "Existing PDMS schema before Flyway adoption"
  type           = "BASELINE"    ← không phải SQL hay JDBC
  script         = "<< Flyway Baseline >>"
  checksum       = NULL          ← không có checksum
  installed_by   = "flyway_user"
  installed_on   = NOW()
  execution_time = 0
  success        = true

Khi Flyway chạy tiếp theo:
  Đọc history → thấy version 1 đã "chạy" (thực ra là baseline)
  Scan migration files → tìm tất cả files có version > 1
  Chạy V2, V3, V4... nhưng BỎ QUA V1
  
Điều quan trọng: Flyway baseline KHÔNG chạy bất kỳ SQL nào
                 Nó chỉ INSERT 1 row vào tracking table
                 DB schema không thay đổi chút nào
```

**Tại sao phải generate V1__Baseline_existing_schema.sql nếu Flyway không chạy nó?**

```
Câu hỏi hay! Có 2 lý do:

1. Cho dev mới setup local:
   Dev mới join team → clone repo → chưa có DB
   Flyway cần file V1 để tạo schema từ đầu (không có DB sẵn)
   Flyway chạy V1__Baseline.sql → tạo 200 tables → rồi chạy V2, V3...
   
   Staging/Prod: đã có DB sẵn → flyway baseline → bỏ qua V1
   Dev mới:     DB trống → flyway migrate → chạy V1 để tạo schema

2. Disaster recovery:
   Nếu prod DB bị mất hoàn toàn → cần tạo lại từ đầu
   V1__Baseline.sql là "bản snapshot" toàn bộ schema ban đầu
   Chạy từ V1 → ... → Vn để recover hoàn toàn
```

---

### Khi nào nên dùng 1 migration file vs nhiều files?

```
Rule of thumb: "1 business change = 1 migration file"

Ví dụ 1: Thêm tính năng tenant support
  ✅ ĐÚNG: 3 files riêng biệt
    V2_01__Add_tenant_columns_nullable.sql
    V2_02__Fill_tenant_data.sql
    V2_03__Add_tenant_constraints_indexes.sql
  
  Lý do: Bước 2 (fill data) có thể chạy lâu và cần retry độc lập
          Nếu gộp vào 1 file → fail ở bước fill → rollback cả add column

Ví dụ 2: Add 1 column nhỏ trên bảng ít data
  ✅ ĐỦ: 1 file
    V3__Add_priority_to_small_table.sql
    
    ALTER TABLE config ADD COLUMN priority INT NOT NULL DEFAULT 0;
    -- Table nhỏ → 1-bước an toàn, không cần chia

Ví dụ 3: Create nhiều lookup tables liên quan
  ✅ ĐÚNG: 1 file (cùng 1 unit của change)
    V4__Create_lookup_tables.sql
    
    CREATE TABLE document_type (...);
    CREATE TABLE document_status (...);
    CREATE TABLE warehouse_type (...);
    -- Các table này liên quan nhau, failure một cái → nên rollback tất cả
```

---

### "flyway repair" có an toàn không?

```
flyway repair làm 2 việc:

Việc 1: Xóa FAILED migration records
  FAILED record trong history → Flyway từ chối chạy tiếp
  repair xóa record failed → Flyway có thể thử lại
  
  AN TOÀN nếu: SQL trong migration đã thực sự rollback hết
  (Flyway tự rollback nếu migration chạy trong transaction)
  
  NGUY HIỂM nếu: migration là canExecuteInTransaction=false
  Khi đó SQL đã chạy một phần mà không rollback được
  repair xóa record → Flyway thử lại → SQL chạy lại → DUPLICATE ERROR

Việc 2: Cập nhật checksum
  Khi file V__ bị sửa → checksum mismatch
  repair update checksum trong history = checksum file hiện tại
  
  AN TOÀN nếu: thay đổi trong file là cosmetic (comment, whitespace)
               và bạn chắc chắn DB đang ở đúng state
  
  NGUY HIỂM nếu: bạn sửa SQL logic → DB state giữa environments có thể lệch
  Staging đã chạy SQL cũ, repair trên prod → prod sẽ chạy SQL mới
  → Staging và prod có schema khác nhau

Nguyên tắc: repair chỉ dùng như "emergency fix" trên dev/staging
             Production: tạo file migration mới để fix, không repair
```

---

### Sau khi baseline thành công — Workflow hàng ngày của team

```
Từ đây về sau, mọi thứ phải qua Flyway:
─────────────────────────────────────────

Developer muốn thêm column:
  1. git pull (lấy code mới nhất)
  2. flyway info → xem version cao nhất hiện tại (VD: 20241120143052)
  3. Tạo file: V20241121090000__add_priority_column.sql
  4. Viết SQL:
       ALTER TABLE document ADD COLUMN priority INT;
  5. flyway migrate (local) → verify OK
  6. flyway validate → verify checksum OK
  7. git add + git commit + git push
  8. PR → CI pipeline chạy flyway validate + atlas lint
  9. Merge → Deploy → Flyway tự migrate trên staging/prod

Developer muốn sửa stored procedure:
  1. Mở file R__020_SP_validate_document.sql
  2. Sửa logic trực tiếp trong file
  3. flyway migrate (local) → Flyway detect checksum thay đổi → re-run SP
  4. Test SP
  5. Commit → PR → Deploy → flyway migrate trên staging/prod tự re-run SP
  
Không cần tạo file migration mới cho stored proc!
Không cần viết DROP + CREATE!
Flyway tự detect và re-run khi file thay đổi.
```

---

### Troubleshooting checklist khi Flyway fail trên production

```
Step 1: Đọc error message đầy đủ
  flyway info để xem trạng thái

Step 2: Phân loại error:
  
  "Validate failed: checksum mismatch"
  → Ai đó sửa file migration đã chạy
  → Tìm ai, tìm sự thay đổi
  → Production: KHÔNG repair, tạo file mới để fix
  → Staging/Dev: repair OK nếu thay đổi không ảnh hưởng
  
  "Migration V{x} failed!"
  → SQL trong migration bị lỗi
  → Flyway đã rollback transaction (nếu transactional migration)
  → Fix SQL trong file
  → flyway repair → flyway migrate
  
  "Out-of-order migration detected"
  → File version thấp hơn xuất hiện sau version cao hơn đã chạy
  → Production: KHÔNG bật out-of-order=true
  → Rename file về version mới nhất + review SQL logic
  
  "Unable to acquire Flyway advisory lock"
  → Có instance khác đang chạy flyway migrate
  → Hoặc: instance trước bị kill giữa chừng, lock không được release
  → Chờ hoặc manually release lock:
     SELECT pg_advisory_unlock_all();
     -- Sau đó chạy flyway repair để đảm bảo history sạch

Step 3: Sau khi fix, verify:
  flyway validate → OK?
  flyway info → trạng thái hợp lý?
  flyway migrate → chạy thành công?
```
