# PostgreSQL Query Planner & Optimizer — Deep Dive

---
tags: [postgresql, database, performance, query-planner, explain]
created: 2026-05-02
difficulty: advanced
estimated-read: 20 min
links: [[postgresql-index-internals]], [[connection-pooling-pgbouncer]], [[postgresql-performance-deep-dive]]

---

## 🎯 Learning Objectives

Sau bài này bạn sẽ:
- Hiểu query planner làm gì **trước khi** thực thi SQL
- Đọc được `EXPLAIN ANALYZE` output một cách tự tin
- Biết tại sao planner chọn Seq Scan thay vì Index Scan
- Tune statistics và planner settings để cải thiện query performance

---

## 🏗️ Kiến Trúc Query Processing

```
┌─────────────────────────────────────────────────────────────────┐
│                   SQL Query Processing Pipeline                  │
│                                                                  │
│  SQL Text                                                        │
│     │                                                            │
│     ▼                                                            │
│  ┌────────┐    Kiểm tra syntax                                   │
│  │ Parser │ ──────────────────────► Parse Tree                  │
│  └────────┘                                                      │
│     │                                                            │
│     ▼                                                            │
│  ┌──────────┐  Resolve names, types, permissions                 │
│  │ Analyzer │ ────────────────────────► Query Tree               │
│  └──────────┘                                                    │
│     │                                                            │
│     ▼                                                            │
│  ┌──────────┐  Logical rewrites (subquery flattening,           │
│  │ Rewriter │  view expansion, rule application)                 │
│  └──────────┘                                                    │
│     │                                                            │
│     ▼                                                            │
│  ┌──────────┐  ← CORE TOPIC: Chọn execution plan tốt nhất      │
│  │ Planner  │  Cost-based optimization với table statistics      │
│  │Optimizer │ ──────────────────────► Execution Plan             │
│  └──────────┘                                                    │
│     │                                                            │
│     ▼                                                            │
│  ┌──────────┐  Thực thi plan, trả về rows                       │
│  │ Executor │                                                    │
│  └──────────┘                                                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📊 Statistics — Nền Tảng Của Planner

### pg_statistic — Planner "nhìn" table như thế nào

```sql
-- Planner dùng statistics để ước tính row counts
-- Statistics được cập nhật bởi ANALYZE (tự động hoặc manual)

SELECT 
    attname AS column_name,
    n_distinct,      -- negative = fraction of total rows
    correlation      -- -1 to 1: physical order vs logical order
FROM pg_stats
WHERE tablename = 'documents' AND attname IN ('tenant_id', 'status', 'created_at');
```

```
column_name │ n_distinct │ correlation
────────────┼────────────┼────────────
tenant_id   │        -12 │       0.02  ← 12% unique, random physical order
status      │          5 │      -0.45  ← 5 distinct values
created_at  │    -0.9998 │       0.98  ← nearly unique, highly correlated (sequential insert)
```

**n_distinct:**
- Số dương = số distinct values tuyệt đối
- Số âm = fraction of total rows (ví dụ -0.5 = 50% distinct)

**correlation:**
- `1.0` = physical order = logical order → BRIN và Index Scan hiệu quả
- `0.0` = hoàn toàn random → Seq Scan có thể tốt hơn Index Scan!
- Tại sao? Random Index Scan gây **nhiều disk I/O** hơn Seq Scan (poor locality)

### Statistics Target

```sql
-- Default statistics target = 100 (100 histogram buckets)
-- Tăng cho columns quan trọng → planner ước tính chính xác hơn

ALTER TABLE documents 
ALTER COLUMN status SET STATISTICS 500;  -- 500 histogram buckets

-- Analyze sau khi thay đổi:
ANALYZE documents;
```

---

## 🧮 Cost Model — Planner Tính Giá Như Thế Nào

### Cost Units

```sql
-- PostgreSQL costs được tính bằng "cost units" (không phải ms)
-- Base costs (có thể tune trong postgresql.conf):

SHOW seq_page_cost;        -- 1.0  (sequential disk I/O)
SHOW random_page_cost;     -- 4.0  (random disk I/O — 4x more expensive)
SHOW cpu_tuple_cost;       -- 0.01 (process 1 tuple)
SHOW cpu_index_tuple_cost; -- 0.005
SHOW cpu_operator_cost;    -- 0.0025
```

### Ước tính cost — ví dụ cụ thể

```sql
-- Table: documents, 1M rows, 10000 pages (8KB each)
-- Query: SELECT * FROM documents WHERE status = 'PENDING'

-- Option 1: Sequential Scan
-- Cost = pages * seq_page_cost + rows * cpu_tuple_cost
-- Cost = 10000 * 1.0 + 1000000 * 0.01 = 20000 cost units

-- Option 2: Index Scan (status selectivity = 10%)
-- Index pages: ~100, matching rows: 100000
-- Cost = 100 * random_page_cost         (index traversal)
--      + 100000 * random_page_cost      (heap fetches — RANDOM!)
--      + 100000 * cpu_tuple_cost
-- Cost = 100*4 + 100000*4 + 100000*0.01 = 401400 cost units

-- Planner chọn: Sequential Scan! (20000 < 401400)
-- Mặc dù status có index, index scan còn tệ hơn với 10% selectivity!
```

> 💡 **Rule of thumb:** Index Scan chỉ win khi trả về **< 5-15%** số rows của table. Trên ngưỡng đó, Seq Scan thường hiệu quả hơn về I/O.

### random_page_cost trên SSD

```sql
-- Với SSD, random I/O gần bằng sequential I/O
-- Giảm random_page_cost để planner chọn Index Scan nhiều hơn:

-- postgresql.conf hoặc per-session:
SET random_page_cost = 1.1;  -- SSD (default 4.0 cho HDD)

-- Hoặc per-tablespace:
ALTER TABLESPACE pg_default SET (random_page_cost = 1.1);
```

---

## 🔍 Đọc EXPLAIN Output — Từng Node

### Node types chính

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT d.id, d.title, w.code, w.location
FROM documents d
JOIN warehouses w ON d.warehouse_id = w.id
WHERE d.tenant_id = 'VPB-HN'
  AND d.status = 'ACTIVE'
  AND w.floor = 3
ORDER BY d.created_at DESC
LIMIT 50;
```

```
Limit  (cost=1234.56..1234.89 rows=50 width=156)
       (actual time=12.345..12.456 rows=50 loops=1)
  ->  Sort  (cost=1234.56..1245.67 rows=4444 width=156)
            (actual time=12.340..12.390 rows=50 loops=1)
        Sort Key: d.created_at DESC
        Sort Method: top-N heapsort  Memory: 47kB
        ->  Hash Join  (cost=234.56..1012.34 rows=4444 width=156)
                       (actual time=3.456..11.234 rows=4567 loops=1)
              Hash Cond: (d.warehouse_id = w.id)
              Buffers: shared hit=234 read=56
              ->  Index Scan using idx_docs_tenant_status on documents d
                    (cost=0.43..678.90 rows=44444 width=120)
                    (actual time=0.123..8.456 rows=45678 loops=1)
                    Index Cond: ((tenant_id = 'VPB-HN') AND (status = 'ACTIVE'))
                    Buffers: shared hit=189 read=45
              ->  Hash  (cost=123.45..123.45 rows=89 width=36)
                        (actual time=1.234..1.234 rows=89 loops=1)
                    Buckets: 1024  Batches: 1  Memory Usage: 15kB
                    ->  Seq Scan on warehouses w
                          (cost=0.00..123.45 rows=89 width=36)
                          (actual time=0.045..1.189 rows=89 loops=1)
                          Filter: (floor = 3)
                          Rows Removed by Filter: 211
Planning Time: 0.345 ms
Execution Time: 12.567 ms
```

### Phân tích từng phần

```
cost=1234.56..1234.89
  ^^^^^^^^^^^  ^^^^^^^^
  startup cost total cost
  (khi nào     (khi nào trả
  row đầu      row cuối)
  được trả)

actual time=12.345..12.456 rows=50 loops=1
                              ^^^^^^^^^ ^^^^^^^
                              thực tế   số lần node này chạy
                              số rows   (nested loop: > 1)
```

**Dấu hiệu vấn đề:**
```
cost=100..200  actual=100..5000  ← Planner underestimate!
rows=50        actual rows=5000   ← Row estimate sai → bad plan

→ Fix: ANALYZE, tăng statistics target, hoặc dùng pg_hint_plan
```

---

## 🔗 Join Algorithms — Planner Chọn Như Thế Nào

```
┌─────────────────────────────────────────────────────────────┐
│                  Join Algorithm Selection                    │
│                                                             │
│  Nested Loop Join:                                          │
│  FOR each row in outer:                                     │
│    FOR each matching row in inner:  ← O(N*M) worst case    │
│  Best khi: inner table small, hoặc có index                 │
│                                                             │
│  Hash Join:                                                 │
│  Build hash table from smaller table (build side)           │
│  Probe hash table with larger table (probe side)            │
│  Best khi: memory đủ cho hash table, no index              │
│  Complexity: O(N+M)                                         │
│                                                             │
│  Merge Join:                                                 │
│  Require both sides SORTED on join key                      │
│  Merge sorted streams: O(N+M) with O(1) memory              │
│  Best khi: data đã sorted (index exists on join key)        │
└─────────────────────────────────────────────────────────────┘
```

```sql
-- Hash Join cần memory:
-- work_mem = bao nhiêu memory cho 1 sort/hash operation
-- Tăng work_mem → Hash Join có thể in-memory → nhanh hơn

SET work_mem = '64MB';  -- default 4MB, thường quá nhỏ

-- Xem batches trong Hash Join:
-- Batches: 1  → in-memory (tốt!)
-- Batches: 4  → spill to disk (cần tăng work_mem)
```

---

## ⚙️ Planner Settings & Hints

### Disable/Enable planner options (debugging)

```sql
-- Tắt một loại scan để test:
SET enable_seqscan = OFF;  -- Force index scan
SET enable_hashjoin = OFF; -- Force merge/nested loop
SET enable_nestloop = OFF; -- Force hash join

-- NGUY HIỂM: Đừng dùng trong production!
-- Chỉ dùng để debug/test planner behavior
```

### pg_hint_plan — production-safe hints

```sql
-- Extension: pg_hint_plan
-- Gợi ý cho planner mà không disable hoàn toàn

/*+ IndexScan(d idx_docs_tenant_status) */
SELECT d.id FROM documents d WHERE d.tenant_id = 'VPB-HN';

/*+ HashJoin(d w) Leading(d w) */  
SELECT d.id, w.code 
FROM documents d JOIN warehouses w ON d.warehouse_id = w.id;
```

---

## 🔄 Plan Caching — Prepared Statements

```sql
-- PostgreSQL cache execution plan cho prepared statements
-- Vấn đề: plan được tạo với generic statistics → có thể suboptimal

PREPARE get_docs(TEXT, TEXT) AS
SELECT * FROM documents WHERE tenant_id = $1 AND status = $2;

-- Lần 1: planner dùng generic plan (không biết actual values)
-- Lần 6+: PostgreSQL có thể dùng custom plan (với actual values)

-- Check: plan invalidation khi statistics thay đổi
-- ANALYZE → cached plans bị invalidate → replanned

-- Spring Boot/JDBC: Prepared statements mặc định được cache
-- HikariCP + PostgreSQL driver: serverPreparedStatementCacheQueries=256
```

---

## 📚 Case Study — PDMS Slow Report Query

### Query ban đầu (45 seconds!)

```sql
EXPLAIN ANALYZE
SELECT 
    w.code, w.location, w.floor,
    COUNT(d.id) AS document_count,
    SUM(d.file_size) AS total_size
FROM warehouses w
LEFT JOIN documents d ON w.id = d.warehouse_id
WHERE w.branch_id = 'HN-01'
  AND d.created_at >= '2025-01-01'
  AND d.status != 'DELETED'
GROUP BY w.id, w.code, w.location, w.floor
ORDER BY document_count DESC;
```

### EXPLAIN cho thấy

```
HashAggregate  (actual time=44123.456..44234.567 rows=234 loops=1)
               Memory Usage: 892kB  Batches: 4  ← Spilling to disk!
  ->  Hash Left Join  (actual time=234.567..43890.123 rows=4567890)
        Buffers: shared hit=2345 read=45678  ← Nhiều disk read
        ->  Seq Scan on warehouses  (rows=234)
              Filter: (branch_id = 'HN-01')
        ->  Seq Scan on documents  (rows=4567890)  ← 4.5M rows!
              Filter: ((created_at >= '2025-01-01') AND (status != 'DELETED'))
              Rows Removed by Filter: 432111
```

### Root causes

1. `status != 'DELETED'` → không dùng index (NOT EQUAL không hiệu quả với B-Tree selectivity)
2. HashAggregate spilling to disk (`Batches: 4`)
3. Seq Scan 4.5M documents vì `created_at` filter không có index kết hợp với `warehouse_id`

### Fixes

```sql
-- Fix 1: Partial index cho non-deleted + composite với warehouse
CREATE INDEX idx_docs_warehouse_created 
ON documents(warehouse_id, created_at)
WHERE status != 'DELETED';

-- Fix 2: Tăng work_mem cho session này
SET work_mem = '256MB';

-- Fix 3: Rewrite query — dùng IN thay vì !=
WHERE w.branch_id = 'HN-01'
  AND d.created_at >= '2025-01-01'
  AND d.status IN ('ACTIVE', 'ARCHIVED', 'PENDING')  -- explicit enum

-- Kết quả: 45s → 0.8s
```

---

## 🔑 Key Takeaways

1. **Planner là cost-based** — ước tính cost dựa trên statistics, không phải rule
2. **Index Scan không phải luôn tốt hơn Seq Scan** — phụ thuộc selectivity và correlation
3. **random_page_cost = 1.1 cho SSD** — giúp planner chọn index nhiều hơn
4. **work_mem** — tăng để tránh Hash Join/Sort spill to disk
5. **ANALYZE thường xuyên** — stale statistics → bad plan → slow query
6. Tăng **statistics target** cho high-cardinality columns quan trọng
7. `EXPLAIN (ANALYZE, BUFFERS)` — luôn xem `actual rows` vs estimated rows để phát hiện estimate lỗi
8. **`Rows Removed by Filter`** lớn → cần cải thiện index để đẩy filter vào index level

---

## 🔗 Related Links

- [[postgresql-index-internals]] — Loại index và khi nào dùng
- [[connection-pooling-pgbouncer]] — Pool sizing ảnh hưởng query throughput
- [[postgresql-performance-deep-dive]] — VACUUM, autovacuum, monitoring
- [[Performance-System-Programming/01-Database-Internals/03-BTree-vs-LSM]] — Storage engine comparison
