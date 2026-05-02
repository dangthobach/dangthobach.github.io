---
tags: [database, postgresql, sql, optimization, performance, query-planning]
Created: 2026-04-12
MOC: "[[_moc/MOC-Database]]"
---

# ⚡ SQL Query Optimization — From Simple to Complex

> **Mục tiêu note này:** Không phải list các tip rời rạc, mà xây dựng mental model hoàn chỉnh: hiểu *tại sao* query chậm → biết *cách* PostgreSQL thực thi → áp dụng *đúng* kỹ thuật cho từng layer độ phức tạp.

---

## 🧠 Mental Model: Query Lifecycle

Trước khi optimize bất cứ thứ gì, phải hiểu query đi qua những gì:

```
SQL Text
   ↓
[Parser] → AST (Abstract Syntax Tree)
   ↓
[Rewriter] → Apply rules (views, RLS)
   ↓
[Planner/Optimizer] → Chọn execution plan tốt nhất
   ↓
[Executor] → Thực thi plan
   ↓
Result
```

**Insight quan trọng:** Optimizer không phải magic. Nó đưa ra quyết định dựa trên *statistics* (pg_statistic). Statistics sai → plan sai → query chậm. Đây là nguồn gốc của 80% "tại sao query đơn giản lại chậm vậy".

---

## 🔬 Công cụ chẩn đoán: EXPLAIN ANALYZE

Không optimize mà không đo. `EXPLAIN ANALYZE` là kính hiển vi.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT ...;
```

### Đọc output như thế nào

```
Nested Loop  (cost=0.84..8.86 rows=1 width=200)
             (actual time=0.123..0.456 rows=1 loops=3)
  Buffers: shared hit=12 read=3
```

| Field | Ý nghĩa |
|---|---|
| `cost=0.84..8.86` | Estimated: startup cost..total cost (arbitrary unit) |
| `rows=1` | Estimated rows — nếu lệch nhiều với actual → statistics problem |
| `actual time=0.123..0.456` | Thực tế: first row..last row (ms) |
| `loops=3` | Node này được execute 3 lần (nhân tất cả với loops) |
| `shared hit=12` | Pages đọc từ buffer cache (fast) |
| `shared read=3` | Pages đọc từ disk (slow) |

### Red flags khi đọc EXPLAIN

- `rows=1` vs `actual rows=100000` → Statistics outdated, chạy `ANALYZE table_name`
- `Seq Scan` trên table lớn với filter → Thiếu index
- `Hash Batches: 8` → Hash join spill to disk, work_mem quá nhỏ
- `Buffers: read=` số lớn → Cache miss nhiều, hot data không fit vào shared_buffers
- `Filter: (removed X rows)` sau một scan → Index không selective đủ

---

## 📊 Layer 1: Simple Queries — Những lỗi cơ bản nhưng tốn kém

### 1.1 Index selectivity trap

```sql
-- BAD: gender chỉ có 2 giá trị, index vô dụng
CREATE INDEX idx_gender ON users(gender);
SELECT * FROM users WHERE gender = 'M';  -- Seq scan vẫn rẻ hơn

-- GOOD: Partial index cho subset quan trọng
CREATE INDEX idx_active_users ON users(created_at)
WHERE status = 'ACTIVE';

SELECT * FROM users
WHERE status = 'ACTIVE' AND created_at > '2024-01-01';
-- Chỉ index ~10% table thay vì 100%
```

**Rule of thumb:** Index chỉ hiệu quả khi cardinality > 5% unique values, hoặc dùng partial index để đảm bảo selectivity.

### 1.2 Implicit type conversion — index killer

```sql
-- BAD: account_number là VARCHAR, so sánh với integer
SELECT * FROM accounts WHERE account_number = 1234567;
-- PostgreSQL cast toàn bộ column → Seq Scan

-- GOOD: Match type
SELECT * FROM accounts WHERE account_number = '1234567';

-- WORSE: Function trên indexed column
SELECT * FROM contracts WHERE DATE(created_at) = '2024-01-15';
-- Index trên created_at không được dùng

-- GOOD: Range thay vì function
SELECT * FROM contracts
WHERE created_at >= '2024-01-15' AND created_at < '2024-01-16';
```

**PostgreSQL-specific:** Nếu bắt buộc dùng function, tạo **functional index**:
```sql
CREATE INDEX idx_created_date ON contracts(DATE(created_at));
```

### 1.3 LIKE và text search

```sql
-- Chỉ index-able khi pattern không bắt đầu bằng wildcard
SELECT * FROM documents WHERE title LIKE 'Invoice%';  -- Dùng index B-tree ✓
SELECT * FROM documents WHERE title LIKE '%Invoice%'; -- Seq scan ✗

-- GOOD: Dùng pg_trgm cho full-text search với LIKE
CREATE EXTENSION pg_trgm;
CREATE INDEX idx_title_trgm ON documents USING GIN(title gin_trgm_ops);
SELECT * FROM documents WHERE title LIKE '%Invoice%';  -- Dùng GIN index ✓

-- BETTER: Full-text search với tsvector
ALTER TABLE documents ADD COLUMN search_vector tsvector;
CREATE INDEX idx_fts ON documents USING GIN(search_vector);
UPDATE documents SET search_vector = to_tsvector('english', title || ' ' || content);
SELECT * FROM documents WHERE search_vector @@ plainto_tsquery('invoice payment');
```

---

## 📊 Layer 2: JOIN Strategies — PostgreSQL chọn gì và tại sao

PostgreSQL có 3 join algorithms. Planner chọn dựa trên table size, available memory, và indexes.

| Algorithm | Khi nào dùng | Complexity |
|---|---|---|
| **Nested Loop** | Outer table nhỏ + inner có index | O(M × log N) |
| **Hash Join** | Cả hai table vừa, không có index phù hợp | O(M + N) |
| **Merge Join** | Cả hai table đã được sort theo join key | O(M log M + N log N) |

### 2.1 Nested Loop — force index lookup

```sql
-- Efficient khi contracts_count per customer nhỏ
SELECT c.name, COUNT(con.id)
FROM customers c
JOIN contracts con ON c.id = con.customer_id  -- Index trên customer_id cần thiết
WHERE c.region = 'HN'
GROUP BY c.name;

-- Nếu thấy Nested Loop nhưng không có index → tạo ngay:
CREATE INDEX idx_contracts_customer ON contracts(customer_id);
```

### 2.2 Hash Join — memory matters

```sql
-- Hash Join cần build hash table của smaller side trong memory
-- Nếu spill to disk → rất chậm

-- Check trong EXPLAIN:
-- Hash  (cost=...) (actual rows=50000 loops=1)
-- Batches: 4  Memory Usage: 4096kB  ← Spilling! Tăng work_mem

SET work_mem = '64MB';  -- Session level, không set global cao
-- Hoặc trong application:
-- connection.execute("SET work_mem = '64MB'")
```

### 2.3 JOIN order matters khi disable join reordering

PostgreSQL reorder joins tự động lên đến `join_collapse_limit` tables (default 8). Với nhiều table hơn:

```sql
-- Hint manual với explicit subquery:
SELECT *
FROM (
  SELECT id FROM large_table WHERE status = 'ACTIVE'  -- Filter trước
) filtered
JOIN another_table ON filtered.id = another_table.ref_id;
```

### 2.4 Anti-pattern: Implicit cross join

```sql
-- BUG: Quên điều kiện JOIN → Cartesian product
SELECT * FROM orders o, customers c
WHERE o.amount > 1000;
-- Nếu orders = 100K, customers = 50K → 5 billion rows!

-- ALWAYS dùng explicit JOIN syntax:
SELECT * FROM orders o
JOIN customers c ON o.customer_id = c.id
WHERE o.amount > 1000;
```

---

## 📊 Layer 3: Aggregation & Window Functions

### 3.1 Aggregation: Push filters down

```sql
-- BAD: Aggregate toàn bộ rồi filter
SELECT customer_id, SUM(amount)
FROM orders
GROUP BY customer_id
HAVING customer_id IN (SELECT id FROM customers WHERE region = 'HN');

-- GOOD: Filter trước, aggregate ít data hơn
SELECT o.customer_id, SUM(o.amount)
FROM orders o
JOIN customers c ON o.customer_id = c.id
WHERE c.region = 'HN'
GROUP BY o.customer_id;
```

### 3.2 Window Functions vs self-JOIN

```sql
-- BAD: Self-join để tính running total — O(N²)
SELECT o1.id, o1.amount,
       SUM(o2.amount) as running_total
FROM orders o1
JOIN orders o2 ON o2.created_at <= o1.created_at
GROUP BY o1.id, o1.amount, o1.created_at;

-- GOOD: Window function — single pass O(N log N)
SELECT id, amount,
       SUM(amount) OVER (ORDER BY created_at
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
       AS running_total
FROM orders;

-- Thêm PARTITION để running total per-customer:
SELECT id, customer_id, amount,
       SUM(amount) OVER (PARTITION BY customer_id
                         ORDER BY created_at
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
       AS customer_running_total
FROM orders;
```

### 3.3 DISTINCT vs GROUP BY

```sql
-- Functionally equivalent nhưng plan khác nhau
SELECT DISTINCT customer_id FROM orders;
SELECT customer_id FROM orders GROUP BY customer_id;

-- GROUP BY thường nhanh hơn vì có thể dùng HashAggregate
-- DISTINCT dùng Sort + Unique hoặc HashAggregate

-- BEST: Nếu chỉ cần existence → EXISTS thay vì DISTINCT JOIN
SELECT c.*
FROM customers c
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);
-- Thay vì:
SELECT DISTINCT c.*
FROM customers c
JOIN orders o ON c.id = o.customer_id;
```

---

## 📊 Layer 4: Subqueries vs CTEs vs Temp Tables

Đây là area có nhiều misconception nhất.

### 4.1 Correlated subquery — N+1 trong SQL

```sql
-- BAD: Correlated subquery chạy 1 lần per row của outer query
SELECT c.name,
       (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) as order_count
FROM customers c;
-- Nếu customers = 100K → 100K subquery executions

-- GOOD: JOIN + aggregation
SELECT c.name, COALESCE(agg.order_count, 0)
FROM customers c
LEFT JOIN (
  SELECT customer_id, COUNT(*) as order_count
  FROM orders
  GROUP BY customer_id
) agg ON c.id = agg.customer_id;
```

### 4.2 CTEs: Optimization fence (PostgreSQL < 12) vs inlined (≥ 12)

```sql
-- PostgreSQL 12+: CTE được inline vào main query mặc định
-- Planner có thể push predicates qua CTE

-- MATERIALIZED: Force CTE thành optimization fence (tính riêng 1 lần)
WITH expensive_calc AS MATERIALIZED (
  SELECT customer_id, SUM(amount) as total
  FROM orders
  WHERE EXTRACT(YEAR FROM created_at) = 2024
  GROUP BY customer_id
)
SELECT c.name, ec.total
FROM customers c
JOIN expensive_calc ec ON c.id = ec.customer_id
WHERE ec.total > 1000000;

-- NOT MATERIALIZED: Cho phép planner inline (default từ PG12)
WITH recent_orders AS NOT MATERIALIZED (
  SELECT * FROM orders WHERE created_at > NOW() - INTERVAL '30 days'
)
SELECT * FROM recent_orders WHERE amount > 5000;
-- Planner có thể combine cả 2 conditions vào 1 scan
```

**Rule của thumb:**
- Dùng `MATERIALIZED` khi CTE được reference nhiều lần và expensive
- Dùng `NOT MATERIALIZED` (hoặc default) khi CTE chỉ là code organization
- Dùng Temp Table khi data cần persist qua nhiều queries trong cùng session

### 4.3 Temporary Tables — workhorse của stored procedures

```sql
-- Pattern: Break complex query thành steps với temp tables
-- Cực kỳ hiệu quả cho PDMS batch validation

CREATE TEMP TABLE batch_candidates AS
SELECT contract_id, customer_id, amount
FROM contracts
WHERE status = 'PENDING'
  AND branch_code = ANY($1::varchar[]);

-- Analyze để planner biết temp table size
ANALYZE batch_candidates;

CREATE INDEX ON batch_candidates(customer_id);  -- Index trên temp table

-- Join với dimension tables
SELECT bc.contract_id,
       c.credit_limit,
       bc.amount / c.credit_limit AS utilization_ratio
FROM batch_candidates bc
JOIN customers c ON bc.customer_id = c.id
WHERE bc.amount > c.credit_limit * 0.8;
```

---

## 📊 Layer 5: Bulk Operations — PDMS Scale (10M+ records)

### 5.1 Batch INSERT: COPY vs multi-row INSERT

```sql
-- WORST: Single row insert trong loop
INSERT INTO staging_contracts VALUES (1, ...);
INSERT INTO staging_contracts VALUES (2, ...);
-- 1M inserts = 1M round trips

-- BETTER: Multi-row INSERT
INSERT INTO staging_contracts VALUES
  (1, ...), (2, ...), (3, ...);
-- Batch 1000-5000 rows per statement

-- BEST: COPY từ file/stdin — 10-20x nhanh hơn multi-row INSERT
COPY staging_contracts (col1, col2, col3)
FROM '/path/to/data.csv' CSV HEADER;

-- Từ Java (JDBC): CopyManager
CopyManager cm = ((PGConnection) conn).getCopyAPI();
cm.copyIn("COPY staging_contracts FROM STDIN WITH CSV", reader);
```

### 5.2 Bulk UPDATE: UPDATE FROM vs correlated

```sql
-- BAD: Correlated update
UPDATE contracts c
SET status = 'VALIDATED'
WHERE c.id IN (
  SELECT contract_id FROM validation_results WHERE result = 'PASS'
);

-- GOOD: UPDATE FROM (PostgreSQL-specific)
UPDATE contracts c
SET status = 'VALIDATED'
FROM validation_results vr
WHERE c.id = vr.contract_id
  AND vr.result = 'PASS';

-- BEST cho 10M rows: Batch với LIMIT-like pattern
DO $$
DECLARE
  batch_size INT := 10000;
  updated INT;
BEGIN
  LOOP
    WITH batch AS (
      SELECT contract_id FROM validation_results
      WHERE result = 'PASS' AND processed = FALSE
      LIMIT batch_size
      FOR UPDATE SKIP LOCKED
    )
    UPDATE contracts c
    SET status = 'VALIDATED'
    FROM batch
    WHERE c.id = batch.contract_id
    RETURNING c.id INTO updated;
    
    EXIT WHEN NOT FOUND;
    PERFORM pg_sleep(0.01);  -- Throttle để không lock quá lâu
  END LOOP;
END $$;
```

### 5.3 DELETE: Soft delete vs partition drop

```sql
-- Xóa 10M rows bằng DELETE: Rất chậm, WAL explosion
DELETE FROM old_contracts WHERE created_at < '2020-01-01';

-- MUCH BETTER: Dùng table partitioning + DROP PARTITION
-- Setup ban đầu:
CREATE TABLE contracts (
  id BIGINT,
  created_at TIMESTAMPTZ,
  ...
) PARTITION BY RANGE (created_at);

CREATE TABLE contracts_2020 PARTITION OF contracts
FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');

-- Xóa cả partition: Instant, không tạo WAL
DROP TABLE contracts_2020;
-- Hoặc detach rồi drop:
ALTER TABLE contracts DETACH PARTITION contracts_2020;
DROP TABLE contracts_2020;
```

---

## 🛠️ Advanced Tricks & PostgreSQL-Specific Features

### Trick 1: LATERAL JOIN — correlated subquery nhưng efficient

```sql
-- Lấy 3 orders gần nhất của mỗi customer
-- BAD: Window function + subquery phức tạp

-- GOOD: LATERAL JOIN
SELECT c.id, c.name, recent.order_id, recent.amount
FROM customers c
CROSS JOIN LATERAL (
  SELECT id as order_id, amount
  FROM orders
  WHERE customer_id = c.id
  ORDER BY created_at DESC
  LIMIT 3
) recent;
-- Mỗi row của customers → chạy subquery 1 lần với customer_id đó
-- Không phải O(N×M) vì có index trên (customer_id, created_at)
```

### Trick 2: FILTER clause trong aggregation

```sql
-- BAD: Multiple subqueries hoặc CASE WHEN
SELECT
  COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END) as active_count,
  COUNT(CASE WHEN status = 'CLOSED' THEN 1 END) as closed_count,
  SUM(CASE WHEN status = 'ACTIVE' THEN amount ELSE 0 END) as active_amount
FROM contracts;

-- GOOD: FILTER clause — cleaner, same performance
SELECT
  COUNT(*) FILTER (WHERE status = 'ACTIVE') as active_count,
  COUNT(*) FILTER (WHERE status = 'CLOSED') as closed_count,
  SUM(amount) FILTER (WHERE status = 'ACTIVE') as active_amount
FROM contracts;
```

### Trick 3: ON CONFLICT (UPSERT) — atomic insert-or-update

```sql
-- Pattern quan trọng cho ETL/migration
INSERT INTO contract_summary (customer_id, total_amount, contract_count)
SELECT customer_id, SUM(amount), COUNT(*)
FROM staging_contracts
GROUP BY customer_id
ON CONFLICT (customer_id) DO UPDATE
SET
  total_amount = EXCLUDED.total_amount,
  contract_count = EXCLUDED.contract_count,
  updated_at = NOW();
-- Atomic: không cần SELECT rồi INSERT/UPDATE riêng
```

### Trick 4: RETURNING — tránh round trip thêm

```sql
-- Thay vì INSERT rồi SELECT lại:
INSERT INTO audit_log (contract_id, action, created_at)
VALUES (123, 'VALIDATED', NOW())
RETURNING id, created_at;
-- Lấy generated values ngay trong INSERT

-- Với batch update, collect affected IDs:
WITH updated AS (
  UPDATE contracts SET status = 'PROCESSED'
  WHERE batch_id = $1
  RETURNING id, customer_id
)
INSERT INTO notification_queue (contract_id, customer_id, type)
SELECT id, customer_id, 'STATUS_CHANGE'
FROM updated;
-- Chaining CTE: update + insert trong 1 statement
```

### Trick 5: Index-Only Scan với covering index

```sql
-- Query chỉ cần columns trong index → không access table pages
-- Cực kỳ nhanh vì tránh heap fetch

-- Scenario: Frequently query contract list per customer
SELECT contract_id, status, amount
FROM contracts
WHERE customer_id = $1 AND created_at > $2;

-- Covering index: bao gồm cả columns trong SELECT
CREATE INDEX idx_contracts_covering ON contracts(customer_id, created_at)
INCLUDE (status, amount, contract_id);
-- INCLUDE: không dùng để sort/filter, chỉ để "cover" SELECT columns

-- EXPLAIN sẽ show: "Index Only Scan" thay vì "Index Scan"
-- Heap fetches = 0 → không đọc table pages
```

### Trick 6: Statistics target cho high-cardinality columns

```sql
-- Default statistics sample: 300 rows → đủ cho most cases
-- Nhưng với distributions phức tạp (JSONB, array, skewed data):

ALTER TABLE contracts ALTER COLUMN branch_code
SET STATISTICS 1000;  -- Sample nhiều hơn

ANALYZE contracts;

-- Check statistics:
SELECT attname, n_distinct, correlation
FROM pg_stats
WHERE tablename = 'contracts';

-- correlation gần 1 → data physically sorted → Index Scan hiệu quả
-- correlation gần 0 → random order → Seq Scan có thể rẻ hơn
```

### Trick 7: Parallel Query

```sql
-- PostgreSQL có thể parallelize Seq Scan, Aggregation, Hash Join
-- Check current settings:
SHOW max_parallel_workers_per_gather;  -- default: 2

-- Force parallel cho analytical query:
SET max_parallel_workers_per_gather = 4;
SET parallel_tuple_cost = 0;  -- Lower cost threshold

-- EXPLAIN sẽ show:
-- Gather  (cost=... rows=... width=...)
--   Workers Planned: 4
--   ->  Parallel Seq Scan on large_table

-- Disable cho OLTP queries (overhead không đáng):
SET max_parallel_workers_per_gather = 0;
```

---

## 🏗️ Triển khai trong PDMS Context

### Pattern: Batch validation pipeline

Áp dụng tất cả các tricks trên vào stored procedure batch validation:

```sql
CREATE OR REPLACE PROCEDURE pr_process_validation_batch(
  p_batch_ids BIGINT[],
  p_branch_code VARCHAR,
  OUT p_result JSON
)
LANGUAGE plpgsql AS $$
DECLARE
  v_start TIMESTAMPTZ := clock_timestamp();
BEGIN
  -- Step 1: Materialize batch vào temp table (tránh re-scan)
  CREATE TEMP TABLE t_batch ON COMMIT DROP AS
  SELECT
    c.id,
    c.customer_id,
    c.amount,
    c.contract_type
  FROM contracts c
  WHERE c.id = ANY(p_batch_ids)
    AND c.branch_code = p_branch_code
    AND c.status = 'PENDING';

  ANALYZE t_batch;  -- Critical: cho planner biết size

  -- Step 2: Enrich với dimension data (covering index trên customers)
  CREATE TEMP TABLE t_enriched ON COMMIT DROP AS
  SELECT
    b.id,
    b.amount,
    cust.credit_limit,
    cust.risk_tier,
    b.amount / NULLIF(cust.credit_limit, 0) AS utilization
  FROM t_batch b
  JOIN customers cust ON b.customer_id = cust.id;  -- Index Only Scan nếu covering

  CREATE INDEX ON t_enriched(id);

  -- Step 3: Validate rules (set-based, không loop)
  INSERT INTO validation_results (contract_id, rule_code, result, detail)
  SELECT
    id,
    'CREDIT_LIMIT' AS rule_code,
    CASE WHEN utilization > 1.0 THEN 'FAIL' ELSE 'PASS' END,
    jsonb_build_object('utilization', ROUND(utilization::numeric, 4))
  FROM t_enriched
  WHERE utilization IS NOT NULL

  UNION ALL

  SELECT
    id,
    'HIGH_RISK' AS rule_code,
    CASE WHEN risk_tier = 'HIGH' AND utilization > 0.8 THEN 'FAIL' ELSE 'PASS' END,
    jsonb_build_object('risk_tier', risk_tier, 'utilization', ROUND(utilization::numeric, 4))
  FROM t_enriched
  WHERE risk_tier IS NOT NULL;

  -- Step 4: Bulk update status (UPDATE FROM, không loop)
  UPDATE contracts c
  SET
    status = CASE
      WHEN vr.failed_count > 0 THEN 'REJECTED'
      ELSE 'VALIDATED'
    END,
    validated_at = clock_timestamp()
  FROM (
    SELECT contract_id,
           COUNT(*) FILTER (WHERE result = 'FAIL') as failed_count
    FROM validation_results
    WHERE contract_id = ANY(p_batch_ids)
    GROUP BY contract_id
  ) vr
  WHERE c.id = vr.contract_id;

  -- Return metrics
  p_result := jsonb_build_object(
    'processed', array_length(p_batch_ids, 1),
    'duration_ms', EXTRACT(MILLISECONDS FROM clock_timestamp() - v_start)
  );
END $$;
```

---

## 📋 Quick Reference: Decision Tree

```
Query chậm?
  ↓
EXPLAIN ANALYZE → Xem actual vs estimated rows
  ↓ (lệch nhiều?)
ANALYZE table → Update statistics → Chạy lại
  ↓ (vẫn chậm?)
Xem node type:
  ├── Seq Scan trên table lớn?
  │     → Thêm index (B-tree / partial / functional)
  │
  ├── Index Scan nhưng nhiều heap fetches?
  │     → Covering index với INCLUDE
  │
  ├── Hash Batches > 1?
  │     → Tăng work_mem (session level)
  │
  ├── Nested Loop với large outer?
  │     → Kiểm tra index trên inner table
  │
  ├── Slow aggregation?
  │     → Push WHERE clause xuống sớm hơn
  │     → Window function thay self-join
  │
  └── Bulk operation (>100K rows)?
        → Batch + temp table + COPY
        → UPDATE FROM thay correlated
        → Partition + DROP thay DELETE
```

---

## 🔗 Liên kết

- [[Notion Knowledge/Note/Database Index Internals- Understanding the Data Structures|Index Internals]] — B-tree, GIN, BRIN internals
- [[Notion Knowledge/Note/Database Performance Demystified- Essential Tips and Strategies|Database Performance Demystified]] — Connection pooling, N+1, vacuum
- [[Notion Knowledge/Note/A Guide to Database Transactions- From ACID to Concurrency Control|Transactions & ACID]] — Isolation levels, MVCC, locking
- [[_moc/MOC-PDMS]] — Context stored procedures PDMS
