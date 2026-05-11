# Liquibase 05 — CI/CD & Production Workflow: Golive Không Còn Đau

> **Mục tiêu**: Quy trình hoàn chỉnh từ dev đến production — giải quyết triệt để bài toán compare scripts, zero-downtime migration, và rollback plan cho hệ thống 200 bảng.

**Series**: [[Liquibase-MOC]] | **Prev**: [[Liquibase-04-Advanced-Enterprise]]

---

## 1. The Problem — Tại sao Golive lại đau?

```
TRƯỚC Liquibase:
─────────────────────────────────────────────────
Dev viết feature A  →  QA chạy script A.sql  →  Prod chạy script A.sql
Hotfix B            →  QA chạy hotfix_B.sql  →  ??? (quên chạy?)
Dev viết feature C  →  QA chạy C_final.sql   →  Prod chạy C_v2_final_FINAL.sql
                                                 (ai đó sửa thêm rồi không update git)

Kết quả: 3 environments, 3 schema khác nhau, không ai dám chắc cái gì đang chạy
⏱ Compare scripts: 2-4 giờ + stress + vẫn có thể miss

SAU Liquibase:
─────────────────────────────────────────────────
Dev viết changeset  →  liquibase update  →  liquibase update
(versioned in Git)     (tự động đúng)       (tự động đúng)

Kết quả: Tất cả environments chạy EXACTLY cùng changeset
         DATABASECHANGELOG chứng minh ai chạy gì lúc nào
⏱ Compare: liquibase diff (30 giây) + review SQL preview (5-10 phút)
```

---

## 2. CI/CD Pipeline Architecture

```
Git Push / PR
     │
     ▼
Stage 1: Validate (30s)
  ├── liquibase validate
  └── Fail fast nếu changelog có lỗi syntax
     │ Pass
     ▼
Stage 2: Test (2-5 phút)
  ├── Spin up PostgreSQL container (Testcontainers/Docker)
  ├── liquibase update (full migration từ zero)
  ├── liquibase updateTestingRollback (test rollback)
  ├── Run integration tests
  └── Teardown container
     │ Pass
     ▼
Stage 3: Deploy Staging
  ├── liquibase status (preview what will run)
  ├── liquibase tag --tag pre-{build-number}
  ├── liquibase update --contexts=staging --labels={version}
  └── Smoke tests
     │ Manual approval
     ▼
Stage 4: Deploy Production (zero-downtime)
  ├── liquibase updateSQL > migration-preview.sql (DBA review)
  ├── liquibase tag --tag v{version}-pre-deploy
  ├── liquibase update --contexts=prod --labels={version}
  └── Monitor + alert
```

### GitHub Actions Workflow

```yaml
# .github/workflows/database-migration.yml
name: Database Migration Pipeline

on:
  push:
    branches: [main, develop]
    paths:
      - 'src/main/resources/db/**'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Validate Changelog
        run: |
          liquibase validate \
            --changeLogFile=src/main/resources/db/changelog/db.changelog-master.xml \
            --url=offline:postgresql

  test-migration:
    needs: validate
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_DB: pdms_test
          POSTGRES_USER: pdms_user
          POSTGRES_PASSWORD: test_password
        ports: ["5432:5432"]
        options: --health-cmd pg_isready --health-interval 10s

    steps:
      - uses: actions/checkout@v4

      - name: Run Full Migration
        env:
          LIQUIBASE_URL: jdbc:postgresql://localhost:5432/pdms_test
          LIQUIBASE_USERNAME: pdms_user
          LIQUIBASE_PASSWORD: test_password
        run: |
          liquibase update --contexts=dev

      - name: Test Rollback
        run: |
          liquibase rollbackCount 5
          liquibase update   # Re-apply sau rollback

      - name: Generate Status Report
        run: liquibase history > migration-history.txt

      - uses: actions/upload-artifact@v4
        with:
          name: migration-report
          path: migration-history.txt

  deploy-staging:
    needs: test-migration
    if: github.ref == 'refs/heads/develop'
    environment: staging
    runs-on: ubuntu-latest
    steps:
      - name: Preview Migration
        run: |
          liquibase updateSQL \
            --contexts=staging \
            --url=${{ secrets.STAGING_DB_URL }} \
            --username=${{ secrets.STAGING_DB_USER }} \
            --password=${{ secrets.STAGING_DB_PASS }} \
            > pending-migration.sql
          cat pending-migration.sql

      - name: Tag Pre-Deploy
        run: |
          liquibase tag \
            --tag=staging-pre-${{ github.run_number }} \
            --url=${{ secrets.STAGING_DB_URL }}

      - name: Apply Migration
        run: |
          liquibase update \
            --contexts=staging \
            --labels=${{ vars.APP_VERSION }} \
            --url=${{ secrets.STAGING_DB_URL }}
```

---

## 3. Zero-Downtime Migration — Expand/Contract Pattern

Không phải mọi migration đều zero-downtime. Phải theo 3 phase:

```
Phase 1 — EXPAND (tương thích backward — deploy cùng code cũ)
  ✅ ADD COLUMN nullable
  ✅ ADD TABLE
  ✅ ADD INDEX CONCURRENTLY
  ✅ ADD FOREIGN KEY
  ❌ DROP COLUMN
  ❌ RENAME COLUMN
  ❌ CHANGE COLUMN TYPE (nếu breaking)

Phase 2 — MIGRATE CODE
  Deploy code mới dùng column/table mới
  Data migration script chạy trong background

Phase 3 — CONTRACT (sau khi confirm ổn định, 1-2 sprint sau)
  DROP old column / RENAME cleanup
```

### Ví dụ: Rename Column an toàn cho PDMS

```xml
<!-- ❌ NGUY HIỂM: App đang chạy sẽ lỗi ngay -->
<changeSet id="rename-col-DANGEROUS" author="bach">
    <renameColumn tableName="document"
                  oldColumnName="doc_code"
                  newColumnName="document_code"/>
</changeSet>

<!-- ✅ AN TOÀN: 3-phase approach -->

<!-- === PHASE 1 — Release 1.1.0 === -->
<changeSet id="add-column-document-code-new" author="bach" labels="v1.1.0">
    <addColumn tableName="document">
        <column name="document_code" type="VARCHAR(50)"/>
    </addColumn>
</changeSet>

<changeSet id="copy-doc-code-to-document-code" author="bach" labels="v1.1.0">
    <sql>UPDATE document SET document_code = doc_code WHERE document_code IS NULL;</sql>
    <rollback>UPDATE document SET document_code = NULL;</rollback>
</changeSet>

<!-- Trigger sync realtime trong giai đoạn transition -->
<changeSet id="create-trigger-sync-document-code" author="bach"
           labels="v1.1.0" runOnChange="true">
    <sql splitStatements="false">
        CREATE OR REPLACE FUNCTION sync_document_code()
        RETURNS TRIGGER AS $$
        BEGIN
            IF NEW.doc_code IS DISTINCT FROM OLD.doc_code THEN
                NEW.document_code := NEW.doc_code;
            END IF;
            IF NEW.document_code IS DISTINCT FROM OLD.document_code THEN
                NEW.doc_code := NEW.document_code;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_sync_document_code ON document;
        CREATE TRIGGER trg_sync_document_code
            BEFORE INSERT OR UPDATE ON document
            FOR EACH ROW EXECUTE FUNCTION sync_document_code();
    </sql>
    <rollback>DROP TRIGGER IF EXISTS trg_sync_document_code ON document;</rollback>
</changeSet>

<!-- === PHASE 3 — Release 1.3.0: Cleanup === -->
<changeSet id="drop-trigger-sync-document-code" author="bach" labels="v1.3.0">
    <sql>DROP TRIGGER IF EXISTS trg_sync_document_code ON document;</sql>
</changeSet>

<changeSet id="drop-column-doc-code-legacy" author="bach" labels="v1.3.0">
    <preConditions onFail="HALT">
        <!-- Đảm bảo không còn NULL trong column mới -->
        <sqlCheck expectedResult="0">
            SELECT COUNT(*) FROM document WHERE document_code IS NULL
        </sqlCheck>
    </preConditions>
    <dropColumn tableName="document" columnName="doc_code"/>
</changeSet>
```

---

## 4. Golive Checklist — PDMS Production

### Pre-deploy Script (T-1 ngày)

```bash
#!/bin/bash
# pre-deploy-check.sh

set -e

echo "=== PDMS Liquibase Pre-Deploy Checklist ==="

# 1. Validate changelog files
echo "[1/5] Validating changelog..."
liquibase validate \
  --changeLogFile=src/main/resources/db/changelog/db.changelog-master.xml \
  --url=$STAGING_DB_URL
echo "✅ Changelog valid"

# 2. Xem những gì sẽ chạy trên PROD
echo "[2/5] Pending changesets on PROD:"
liquibase status \
  --url=$PROD_DB_URL \
  --username=$LIQUIBASE_PROD_USER \
  --password=$LIQUIBASE_PROD_PASS \
  --verbose

# 3. Generate SQL để DBA review
echo "[3/5] Generating SQL preview..."
liquibase updateSQL \
  --url=$PROD_DB_URL \
  --username=$LIQUIBASE_PROD_USER \
  --password=$LIQUIBASE_PROD_PASS \
  --contexts=prod \
  --labels=$DEPLOY_VERSION \
  --outputFile=REVIEW-migration-$(date +%Y%m%d-%H%M).sql
echo "📋 SQL Preview generated. Gửi DBA review trước khi tiếp tục."

# 4. Diff staging vs prod (detect drift)
echo "[4/5] Comparing STAGING vs PROD schemas..."
liquibase diff \
  --url=$STAGING_DB_URL \
  --referenceUrl=$PROD_DB_URL \
  --referenceUsername=$LIQUIBASE_PROD_USER \
  --referencePassword=$LIQUIBASE_PROD_PASS

# 5. Check stale lock
echo "[5/5] Checking Liquibase lock status..."
psql $PROD_DB_URL -c \
  "SELECT LOCKED, LOCKEDBY, LOCKGRANTED FROM DATABASECHANGELOGLOCK WHERE ID = 1;"

echo "=== Pre-deploy check hoàn thành ==="
echo "Chạy deploy.sh sau khi DBA approve SQL preview."
```

### Deploy Script

```bash
#!/bin/bash
# deploy.sh

set -e
set -o pipefail

DEPLOY_VERSION=${1:?"Usage: ./deploy.sh <version>"}
TAG_NAME="${DEPLOY_VERSION}-$(date +%Y%m%d-%H%M%S)"

echo "=== PDMS Production Deployment: $DEPLOY_VERSION ==="

# 1. Tag pre-deploy (rollback point)
echo "[1/4] Creating rollback tag: $TAG_NAME"
liquibase tag \
  --tag=$TAG_NAME \
  --url=$PROD_DB_URL \
  --username=$LIQUIBASE_PROD_USER \
  --password=$LIQUIBASE_PROD_PASS
echo "✅ Rollback command: liquibase rollback --tag=$TAG_NAME"

# 2. Run migrations
echo "[2/4] Running migrations..."
liquibase update \
  --url=$PROD_DB_URL \
  --username=$LIQUIBASE_PROD_USER \
  --password=$LIQUIBASE_PROD_PASS \
  --contexts=prod \
  --labels=$DEPLOY_VERSION
echo "✅ Migrations applied"

# 3. Verify 0 pending
echo "[3/4] Verifying..."
liquibase status \
  --url=$PROD_DB_URL \
  --username=$LIQUIBASE_PROD_USER \
  --password=$LIQUIBASE_PROD_PASS

# 4. Final diff — confirm staging == prod
echo "[4/4] Final diff: STAGING vs PROD"
liquibase diff \
  --url=$STAGING_DB_URL \
  --referenceUrl=$PROD_DB_URL

echo ""
echo "=== Deployment Complete ==="
echo "⚠️  Save this rollback tag: $TAG_NAME"
```

### Rollback Script

```bash
#!/bin/bash
# rollback.sh

ROLLBACK_TAG=${1:?"Usage: ./rollback.sh <tag-name>"}

echo "=== ROLLBACK TO: $ROLLBACK_TAG ==="

# Preview trước
liquibase rollbackSQL \
  --tag=$ROLLBACK_TAG \
  --url=$PROD_DB_URL \
  --username=$LIQUIBASE_PROD_USER \
  --password=$LIQUIBASE_PROD_PASS \
  > rollback-preview-$(date +%Y%m%d-%H%M).sql

echo "Rollback SQL preview generated. Review trước khi execute."
cat rollback-preview-*.sql

read -p "Execute rollback? (yes/no): " confirm

if [ "$confirm" == "yes" ]; then
    liquibase rollback \
      --tag=$ROLLBACK_TAG \
      --url=$PROD_DB_URL \
      --username=$LIQUIBASE_PROD_USER \
      --password=$LIQUIBASE_PROD_PASS
    echo "✅ Rollback to $ROLLBACK_TAG complete"
fi
```

---

## 5. Developer Workflow — Ngày-to-ngày

```bash
# Bắt đầu feature mới
git pull origin develop

# Check DB local có gì pending không
liquibase status

# Apply pending migrations từ teammates
liquibase update --contexts=dev

# Viết changeset mới → test local
liquibase update

# Test rollback của changeset vừa viết
liquibase rollbackCount 1
liquibase update  # re-apply

# Commit cùng code
git add src/main/resources/db/
git commit -m "feat: add tenant_id column to document [PDMS-1234]"
```

### PR Convention

```
Mỗi PR có thay đổi DB phải bao gồm:
☐ Changelog file(s) mới trong đúng version folder
☐ liquibase updateSQL output attach vào PR description
☐ Confirm đã test rollback locally
☐ Confirm không sửa changeset đã tồn tại
```

---

## 6. Compare Scripts — Workflow Mới Hoàn Toàn

```
TRƯỚC (đau):                          SAU (Liquibase):
─────────────────────────────────     ─────────────────────────────────
1. Thu thập scripts từ mỗi dev        1. git pull
2. So sánh thủ công 200 file          2. liquibase status (1 lệnh, 5 giây)
3. Sắp xếp thứ tự chạy               3. liquibase updateSQL > review.sql
4. Chạy thử trên staging             4. DBA review review.sql (5-10 phút)
5. Fix lỗi, chạy lại                  5. liquibase update (tự động)
6. Pray khi chạy trên prod            6. liquibase diff để confirm

⏱ 2-4 giờ + stress                   ⏱ 15-30 phút, zero stress
```

### Weekly Schema Audit Script

```bash
#!/bin/bash
# weekly-schema-audit.sh — Phát hiện drift giữa environments

echo "=== Weekly Schema Audit: $(date) ==="

# So sánh staging vs prod
echo "--- staging vs prod ---"
liquibase diff \
  --url=$STAGING_DB_URL \
  --referenceUrl=$PROD_DB_URL \
  --referenceUsername=$LIQUIBASE_PROD_USER \
  --referencePassword=$LIQUIBASE_PROD_PASS \
  > diff-staging-vs-prod-$(date +%Y%m%d).txt

if grep -qE "Missing|Unexpected|Changed" diff-staging-vs-prod-*.txt; then
    echo "⚠️  DRIFT DETECTED between staging and prod!"
    cat diff-staging-vs-prod-*.txt
    # Gửi Slack/email alert
else
    echo "✅ staging schema matches prod"
fi

# So sánh dev vs prod (optional — dev thường ahead)
echo "--- dev vs prod ---"
liquibase status \
  --url=$PROD_DB_URL \
  --username=$LIQUIBASE_PROD_USER \
  --password=$LIQUIBASE_PROD_PASS
```

---

## 7. Troubleshooting — Production Issues

### Checksum Mismatch

```
Error: Validation Failed:
  1 change sets check sum is invalid.
```

```bash
# Option 1: Clear checksum (tính lại tất cả — cẩn thận trên prod)
liquibase clearCheckSums

# Option 2 (preferred): Thêm validCheckSum vào changeset trong XML
# <validCheckSum>8:OLD_CHECKSUM</validCheckSum>
# <validCheckSum>8:NEW_CHECKSUM</validCheckSum>
```

### Stale Lock

```
Waiting for changelog lock... (lặp mãi)
```

```bash
liquibase releaseLocks

# Hoặc SQL:
UPDATE DATABASECHANGELOGLOCK
SET LOCKED = FALSE, LOCKGRANTED = NULL, LOCKEDBY = NULL
WHERE ID = 1;
```

### Migration lock timeout trên table lớn

```xml
<!-- Vấn đề: ALTER TABLE với default value lock cả table -->
<!-- Solution: Tách thành 3 bước, dùng batch UPDATE -->

<!-- Step 1: Add column nullable (fast, không lock) -->
<changeSet id="add-col-step1" author="bach" runInTransaction="false">
    <sql>ALTER TABLE document ADD COLUMN IF NOT EXISTS tenant_code VARCHAR(20);</sql>
</changeSet>

<!-- Step 2: Batch fill (tránh lock lâu) -->
<changeSet id="add-col-step2-fill" author="bach">
    <sql>
        DO $$
        DECLARE rows_updated INT;
        BEGIN
            LOOP
                UPDATE document SET tenant_code = 'VPBANK'
                WHERE id IN (SELECT id FROM document WHERE tenant_code IS NULL LIMIT 10000);
                GET DIAGNOSTICS rows_updated = ROW_COUNT;
                EXIT WHEN rows_updated = 0;
                PERFORM pg_sleep(0.1);
            END LOOP;
        END $$;
    </sql>
</changeSet>

<!-- Step 3: Add NOT NULL (fast sau khi đã fill) -->
<changeSet id="add-col-step3-notnull" author="bach">
    <addNotNullConstraint tableName="document" columnName="tenant_code"/>
</changeSet>
```

---

## 8. Kubernetes Deployment Pattern

```yaml
# k8s/liquibase-migration-job.yaml
# Chạy migration tách biệt khỏi app pods — an toàn hơn

apiVersion: batch/v1
kind: Job
metadata:
  name: liquibase-migration-v1-1-0
spec:
  backoffLimit: 0   # Không retry nếu fail
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: liquibase
          image: liquibase/liquibase:4.25.0
          args:
            - update
            - --contexts=prod
            - --labels=v1.1.0
            - --changeLogFile=/liquibase/changelog/db.changelog-master.xml
          env:
            - name: LIQUIBASE_URL
              valueFrom:
                secretKeyRef:
                  name: liquibase-credentials
                  key: url
            - name: LIQUIBASE_USERNAME
              valueFrom:
                secretKeyRef:
                  name: liquibase-credentials
                  key: username
            - name: LIQUIBASE_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: liquibase-credentials
                  key: password
          volumeMounts:
            - name: changelog
              mountPath: /liquibase/changelog
      volumes:
        - name: changelog
          configMap:
            name: liquibase-changelog
```

```yaml
# Trong application.yml của app pod:
spring:
  liquibase:
    enabled: false   # App không tự chạy — K8s Job đảm nhiệm
```

---

## 9. Quick Command Reference Card

```bash
# === DEV DAILY ===
liquibase update                          # Apply pending
liquibase status                          # Xem pending
liquibase status --verbose               # Chi tiết
liquibase rollbackCount 1                 # Undo last changeset

# === PRE-GOLIVE ===
liquibase validate                        # Syntax check
liquibase updateSQL > preview.sql         # Dry run — generate SQL
liquibase diff > schema-diff.txt          # So sánh 2 environments
liquibase tag --tag pre-deploy-v1.1.0    # Tạo rollback checkpoint

# === GOLIVE ===
liquibase update --contexts=prod \
  --labels=v1.1.0                         # Apply production

# === POST-GOLIVE VERIFY ===
liquibase status                          # Verify 0 pending
liquibase history                         # Xem audit trail

# === EMERGENCY ROLLBACK ===
liquibase rollbackSQL --tag pre-deploy    # Preview rollback
liquibase rollback --tag pre-deploy       # Execute rollback

# === MAINTENANCE ===
liquibase releaseLocks                    # Fix stale lock
liquibase clearCheckSums                  # Reset checksums (cẩn thận!)
liquibase changelogSync                   # Mark all as ran (onboarding)
liquibase generateChangeLog               # Reverse-engineer từ DB
liquibase diffChangeLog                   # Generate migration từ diff
liquibase snapshot --snapshotFormat=json  # Lưu DB state
```

---

## 10. Final Summary — Complete Mental Model

```
┌────────────────────────────────────────────────────────────┐
│                  LIQUIBASE GOLIVE PLAYBOOK                 │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  Day-to-day:                                               │
│    Dev viết changeset → local test → PR → CI → merge      │
│                                                            │
│  Pre-golive (T-1):                                         │
│    1. liquibase status     → xem pending                   │
│    2. liquibase updateSQL  → SQL preview cho DBA review    │
│    3. liquibase diff       → detect environment drift      │
│    4. Prepare rollback plan                                │
│                                                            │
│  Golive:                                                   │
│    1. liquibase tag        → rollback checkpoint           │
│    2. liquibase update     → apply migrations              │
│    3. liquibase status     → verify 0 pending              │
│    4. Smoke tests          → confirm app healthy           │
│                                                            │
│  If something goes wrong:                                  │
│    1. liquibase rollback --tag <pre-deploy-tag>            │
│    2. Redeploy previous app version                        │
│    3. Post-mortem                                          │
│                                                            │
│  Weekly:                                                   │
│    - Schema audit: diff all envs vs prod                   │
│    - DATABASECHANGELOG review                              │
│    - Stale lock check                                      │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

#liquibase #cicd #production #zero-downtime #golive #enterprise #postgresql #devops #pdms
