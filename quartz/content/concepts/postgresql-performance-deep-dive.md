# PostgreSQL Performance Deep Dive

> **Audience**: Senior engineers với nền tảng RDBMS vững, đã hiểu SQL cơ bản.  
> **Scope**: Query optimization, memory tuning, anti-patterns phổ biến, và các kỹ thuật nâng cao.  
> **Context**: Áp dụng trực tiếp cho hệ thống xử lý hàng chục triệu records như PDMS.

---

## Table of Contents

1. [[#Hiểu Query Planner — Nền tảng của mọi tối ưu]]
2. [[#Index Strategy — Dùng đúng, dùng đủ]]
3. [[#Query Optimization — Viết SQL như Planner nghĩ]]
4. [[#Memory Configuration — Tinh chỉnh bộ nhớ]]
5. [[#Vacuum & Bloat — Kẻ thù thầm lặng]]
6. [[#Partitioning — Chia để trị ở scale lớn]]
7. [[#Anti-patterns Phổ Biến — Những gì KHÔNG nên làm]]
8. [[#Monitoring & Diagnostics — Đo trước, tối ưu sau]]
9. [[#Advanced Techniques — Vũ khí của senior]]

---

## Hiểu Query Planner — Nền tảng của mọi tối ưu

PostgreSQL sử dụng **cost-based optimizer (CBO)**. Planner ước tính cost của từng plan dựa trên statistics, chọn plan có cost thấp nhất. Nếu statistics sai → plan sai → performance thảm họa.

### EXPLAIN và EXPLAIN ANALYZE

```sql
-- Chỉ xem plan, KHÔNG thực thi
EXPLAIN SELECT * FROM documents WHERE status = 'ACTIVE';

-- Thực thi thật, đo thời gian thực tế
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) 
SELECT * FROM documents WHERE status = 'ACTIVE';
```

**Đọc output EXPLAIN:**

```
Seq Scan on documents  (cost=0.00..45231.00 rows=1823456 width=284)
                        ^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^
                        estimated cost    estimated rows & row width (bytes)

Actual vs Estimated — khoảng cách lớn = statistics lỗi thời
```

Key metrics cần nhìn:
- **cost**: `startup_cost..total_cost` — đơn vị tương đối (page I/O = 1.0)
- **rows**: estimate của planner — nếu lệch xa actual rows > 10x → cần `ANALYZE`
- **Buffers**: `hit` (từ shared_buffers/cache) vs `read` (từ disk) → ratio cao = tốt
- **actual time**: thời gian thực tế mỗi node

### Statistics & Planner Configuration

```sql
-- Xem statistics của một column
SELECT * FROM pg_stats WHERE tablename = 'documents' AND attname = 'status';

-- Tăng statistics target cho column có nhiều distinct values
ALTER TABLE documents ALTER COLUMN branch_code SET STATISTICS 500; -- default 100
ANALYZE documents;

-- Kiểm tra planner estimates cho một điều kiện
SELECT * FROM pg_stats 
WHERE tablename = 'documents' AND attname = 'created_date';
-- Xem n_distinct, correlation, most_common_vals, histogram_bounds
```

**`correlation`**: Giá trị từ -1 đến 1. Gần 1 = physical order khớp logical order → Index Scan hiệu quả. Gần 0 = scatter → Index Scan có thể tệ hơn Seq Scan.

```sql
-- Buộc planner dùng/tránh specific join strategies (chỉ dùng để debug)
SET enable_hashjoin = off;
SET enable_nestloop = off;
SET enable_mergejoin = off;
```

---

## Index Strategy — Dùng đúng, dùng đủ

### B-tree — Default, không phải lúc nào cũng tối ưu

```sql
-- Standard index
CREATE INDEX idx_documents_status ON documents(status);

-- Composite index — thứ tự CỰC KỲ quan trọng
-- Rule: equality columns trước, range column cuối
CREATE INDEX idx_docs_branch_status_date 
ON documents(branch_code, status, created_date);
-- Query này dùng được: WHERE branch_code = 'HN01' AND status = 'ACTIVE' AND created_date > '2024-01-01'
-- Query này không dùng được: WHERE status = 'ACTIVE' (thiếu branch_code ở đầu)
```

### Partial Index — Index thông minh, nhỏ gọn hơn

```sql
-- Chỉ index rows "hot" — thường chỉ 10-20% data nhưng 80% queries
CREATE INDEX idx_docs_pending ON documents(created_date) 
WHERE status = 'PENDING';

-- Index chỉ cho non-null values
CREATE INDEX idx_docs_archived_at ON documents(archived_at)
WHERE archived_at IS NOT NULL;

-- Kết quả: index nhỏ hơn nhiều → fit vào RAM → cache hit rate cao hơn
```

### Covering Index (INCLUDE) — Loại bỏ heap fetch

```sql
-- Nếu query chỉ cần các columns này, không cần đọc heap table
CREATE INDEX idx_docs_search_covering 
ON documents(branch_code, status) 
INCLUDE (id, doc_number, created_date);
-- → Index Only Scan thay vì Index Scan + Heap Fetch
```

### Index cho JSON/JSONB

```sql
-- GIN index cho toàn bộ JSONB document
CREATE INDEX idx_docs_metadata ON documents USING GIN(metadata);

-- Expression index cho path cụ thể — nhỏ hơn, nhanh hơn GIN
CREATE INDEX idx_docs_metadata_type 
ON documents((metadata->>'document_type'));

-- Query phải match expression chính xác để dùng index
SELECT * FROM documents WHERE metadata->>'document_type' = 'CONTRACT';
```

### Expression Index — Index kết quả của function

```sql
-- Tìm kiếm case-insensitive
CREATE INDEX idx_docs_name_lower ON documents(LOWER(doc_name));
-- Query phải dùng: WHERE LOWER(doc_name) = 'contract a'

-- Index năm từ timestamp
CREATE INDEX idx_docs_year ON documents(EXTRACT(YEAR FROM created_date));
```

### Chẩn đoán Index

```sql
-- Index nào đang được dùng / không được dùng
SELECT 
    schemaname, tablename, indexname,
    idx_scan,      -- số lần index được dùng
    idx_tup_read,  -- tuples đọc qua index
    idx_tup_fetch  -- tuples fetch từ heap
FROM pg_stat_user_indexes
ORDER BY idx_scan ASC; -- idx_scan = 0 → xem xét DROP

-- Kích thước indexes
SELECT 
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE tablename = 'documents'
ORDER BY pg_relation_size(indexrelid) DESC;

-- Index bị bloat
SELECT 
    nspname, relname, indexrelname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_scan
FROM pg_stat_user_indexes
JOIN pg_index USING(indexrelid)
JOIN pg_class ON pg_class.oid = indexrelid
JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
WHERE NOT indisvalid; -- index đang bị invalid (rebuild đang chạy)
```

---

## Query Optimization — Viết SQL như Planner nghĩ

### SARGable Predicates — Điều kiện planner có thể dùng index

```sql
-- ❌ NOT SARGable — wrap column trong function → index useless
WHERE YEAR(created_date) = 2024
WHERE UPPER(branch_code) = 'HN01'
WHERE doc_number || '-suffix' = 'DOC001-suffix'

-- ✅ SARGable — column naked, function trên constant
WHERE created_date >= '2024-01-01' AND created_date < '2025-01-01'
WHERE branch_code = 'HN01'  -- đã store lowercase từ đầu
WHERE doc_number = 'DOC001' -- tách suffix logic ra application layer
```

### JOIN Optimization

```sql
-- ❌ Implicit cross join rồi filter — optimizer thường handle được nhưng confusing
SELECT * FROM documents d, contracts c WHERE d.id = c.document_id;

-- ✅ Explicit JOIN — clearer, cùng performance
SELECT * FROM documents d
INNER JOIN contracts c ON d.id = c.document_id;

-- Thứ tự JOIN: bắt đầu từ bảng filter nhiều nhất (selective nhất)
-- Planner thường tự optimize, nhưng với nhiều bảng có thể dùng:
SET join_collapse_limit = 1; -- buộc giữ thứ tự bạn viết (chỉ để debug)
```

### EXISTS vs IN vs JOIN

```sql
-- ❌ IN với subquery lớn — subquery chạy trước, load toàn bộ vào memory
SELECT * FROM documents 
WHERE id IN (SELECT document_id FROM contracts WHERE amount > 1000000);

-- ✅ EXISTS — short-circuit, dừng khi tìm thấy match đầu tiên
SELECT * FROM documents d
WHERE EXISTS (
    SELECT 1 FROM contracts c 
    WHERE c.document_id = d.id AND c.amount > 1000000
);

-- ✅ Semi-join (optimizer thường rewrite IN thành semi-join anyway)
-- Kiểm tra EXPLAIN để xem planner có rewrite không
```

### CTE — Không phải lúc nào cũng là optimization fence

```sql
-- PostgreSQL < 12: CTE luôn là optimization fence (materialized)
-- PostgreSQL >= 12: Planner có thể inline CTE nếu non-recursive & referenced once

-- ✅ Inline CTE (default >= PG12 nếu không recursive, không có side effects)
WITH active_docs AS (
    SELECT id, branch_code FROM documents WHERE status = 'ACTIVE'
)
SELECT * FROM active_docs WHERE branch_code = 'HN01';

-- ⚠️ MATERIALIZED — force fence, tạo temp result set
WITH active_docs AS MATERIALIZED (
    SELECT id, branch_code FROM documents WHERE status = 'ACTIVE'
)
SELECT * FROM active_docs WHERE branch_code = 'HN01';
-- Dùng khi CTE được reference nhiều lần và subquery expensive

-- ⚠️ NOT MATERIALIZED — force inline (PG12+)
WITH active_docs AS NOT MATERIALIZED (...)
```

### Window Functions thay vì Self-Join

```sql
-- ❌ Self-join để lấy previous row — O(n²) với data lớn
SELECT a.id, a.amount, b.amount AS prev_amount
FROM transactions a
LEFT JOIN transactions b ON b.id = (
    SELECT MAX(id) FROM transactions WHERE id < a.id AND account_id = a.account_id
);

-- ✅ Window function — single pass
SELECT 
    id, amount,
    LAG(amount) OVER (PARTITION BY account_id ORDER BY created_at) AS prev_amount
FROM transactions;
```

### Pagination — Offset vs Keyset

```sql
-- ❌ OFFSET pagination — performance giảm tuyến tính với page số lớn
-- OFFSET 1000000 → PostgreSQL vẫn phải đọc 1M rows rồi discard
SELECT * FROM documents 
ORDER BY created_date DESC 
LIMIT 20 OFFSET 1000000;

-- ✅ Keyset pagination (cursor-based) — O(log n) với index
SELECT * FROM documents
WHERE created_date < :last_seen_date  -- từ page trước
   OR (created_date = :last_seen_date AND id < :last_seen_id)
ORDER BY created_date DESC, id DESC
LIMIT 20;
-- Cần composite index: (created_date DESC, id DESC)
```

### Batch Operations

```sql
-- ❌ Row-by-row insert trong loop
INSERT INTO archive_docs SELECT * FROM documents WHERE id = 1;
INSERT INTO archive_docs SELECT * FROM documents WHERE id = 2;
...

-- ✅ Bulk insert
INSERT INTO archive_docs 
SELECT * FROM documents 
WHERE status = 'ARCHIVED' AND created_date < '2023-01-01';

-- ✅ COPY cho data volume cực lớn (10x nhanh hơn INSERT)
COPY documents FROM '/tmp/docs.csv' WITH (FORMAT csv, HEADER true);

-- ✅ Unnest cho bulk insert từ application
INSERT INTO documents (id, branch_code, status)
SELECT * FROM UNNEST(
    ARRAY[1,2,3]::bigint[],
    ARRAY['HN01','HN02','HN03']::text[],
    ARRAY['ACTIVE','ACTIVE','PENDING']::text[]
);
```

---

## Memory Configuration — Tinh chỉnh bộ nhớ

### Các tham số quan trọng

```ini
# postgresql.conf

# ===== SHARED MEMORY =====
shared_buffers = 25% RAM         # Cache pages trong PostgreSQL process
                                  # 8GB RAM → 2GB. Tăng thêm ít lợi hơn (OS cache làm phần còn lại)

effective_cache_size = 75% RAM   # Hint cho planner về tổng cache (PostgreSQL + OS)
                                  # Không allocate thực tế, chỉ ảnh hưởng cost estimation
                                  # Giá trị cao → planner prefer Index Scan hơn Seq Scan

# ===== WORK MEMORY (per operation, per sort/hash) =====
work_mem = 64MB                  # Memory cho sort, hash join, hash aggregate
                                  # NGUY HIỂM: max_connections=200 × work_mem=64MB = 12.8GB potential
                                  # → Set thấp globally, tăng per-session khi cần:
                                  --  SET work_mem = '256MB';

# ===== MAINTENANCE =====
maintenance_work_mem = 512MB     # Cho VACUUM, CREATE INDEX, ALTER TABLE ADD FOREIGN KEY
                                  # Tăng cao để index build nhanh hơn

# ===== WAL & CHECKPOINT =====
wal_buffers = 16MB               # Buffer cho WAL writes (auto-tune từ shared_buffers)
checkpoint_completion_target = 0.9  # Spread checkpoint I/O ra 90% interval
max_wal_size = 4GB               # Tăng để giảm checkpoint frequency

# ===== PARALLEL QUERY =====
max_parallel_workers_per_gather = 4  # Workers cho parallel scan/join
max_parallel_workers = 8             # Total parallel workers
parallel_tuple_cost = 0.1
parallel_setup_cost = 1000
```

### Tuning work_mem thực tế

```sql
-- Kiểm tra query có đang spill to disk không
EXPLAIN (ANALYZE, BUFFERS)
SELECT branch_code, COUNT(*), SUM(amount)
FROM transactions
GROUP BY branch_code;
-- Tìm: "Batches: 4" trong Hash node → spilled 4 batches to disk → tăng work_mem

-- Set per-session cho heavy analytics queries
BEGIN;
SET LOCAL work_mem = '512MB';
-- chạy heavy query
COMMIT; -- work_mem reset về default
```

### Shared Buffers & Buffer Hit Rate

```sql
-- Kiểm tra buffer hit rate (target > 99% cho OLTP)
SELECT 
    sum(heap_blks_read) AS heap_read,
    sum(heap_blks_hit)  AS heap_hit,
    ROUND(sum(heap_blks_hit)::numeric / 
          NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0) * 100, 2) AS hit_rate_pct
FROM pg_statio_user_tables;

-- Per-table cache hit rate
SELECT 
    relname,
    heap_blks_read,
    heap_blks_hit,
    ROUND(heap_blks_hit::numeric / NULLIF(heap_blks_hit + heap_blks_read, 0) * 100, 2) AS hit_pct
FROM pg_statio_user_tables
ORDER BY heap_blks_read DESC;
```

---

## Vacuum & Bloat — Kẻ thù thầm lặng

PostgreSQL dùng **MVCC** (Multi-Version Concurrency Control): UPDATE không overwrite row cũ, INSERT row mới với version mới. Row cũ (dead tuple) nằm đó cho đến khi VACUUM dọn.

### Dead Tuples & Table Bloat

```sql
-- Bảng nào đang có nhiều dead tuples nhất
SELECT 
    relname,
    n_live_tup,
    n_dead_tup,
    ROUND(n_dead_tup::numeric / NULLIF(n_live_tup + n_dead_tup, 0) * 100, 2) AS dead_pct,
    last_vacuum,
    last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC;

-- Ước tính table bloat
SELECT 
    tablename,
    pg_size_pretty(pg_total_relation_size(tablename::regclass)) AS total_size,
    pg_size_pretty(pg_relation_size(tablename::regclass)) AS table_size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(tablename::regclass) DESC;
```

### Autovacuum Tuning

```ini
# postgresql.conf — global settings
autovacuum_vacuum_scale_factor = 0.05   # Trigger khi 5% rows là dead (default 0.2)
autovacuum_analyze_scale_factor = 0.02  # Trigger ANALYZE khi 2% rows thay đổi
autovacuum_vacuum_cost_delay = 2ms      # Throttle I/O (default 20ms — quá chậm!)
autovacuum_max_workers = 5              # Tăng nếu nhiều bảng cần vacuum đồng thời
```

```sql
-- Per-table autovacuum settings (cho bảng hot với nhiều updates)
ALTER TABLE transactions SET (
    autovacuum_vacuum_scale_factor = 0.01,   -- Vacuum khi 1% dead
    autovacuum_vacuum_cost_delay = 2,
    autovacuum_analyze_scale_factor = 0.005
);

-- Manual VACUUM ANALYZE sau bulk operations
VACUUM ANALYZE documents;

-- VACUUM FULL — reclaim disk space, nhưng TABLE LOCK toàn bộ! 
-- Dùng pg_repack thay thế để avoid lock
-- $ pg_repack -t documents -d mydb
```

### Transaction ID Wraparound — Emergency situation

```sql
-- Kiểm tra age của các bảng (> 1.5 tỷ → nguy hiểm, > 2 tỷ → PostgreSQL tự shutdown)
SELECT 
    relname,
    age(relfrozenxid) AS xid_age,
    pg_size_pretty(pg_relation_size(oid)) AS table_size
FROM pg_class
WHERE relkind = 'r'
ORDER BY age(relfrozenxid) DESC
LIMIT 20;

-- Nếu emergency: tắt autovacuum_freeze_max_age thấp xuống
-- VACUUM FREEZE; -- aggressive freeze, cần maintenance window
```

---

## Partitioning — Chia để trị ở scale lớn

### Range Partitioning (phổ biến nhất cho time-series data)

```sql
-- Tạo partitioned table
CREATE TABLE transactions (
    id          BIGSERIAL,
    account_id  BIGINT NOT NULL,
    amount      NUMERIC(15,2) NOT NULL,
    txn_date    DATE NOT NULL,
    status      TEXT NOT NULL
) PARTITION BY RANGE (txn_date);

-- Tạo partitions
CREATE TABLE transactions_2024_q1 PARTITION OF transactions
    FOR VALUES FROM ('2024-01-01') TO ('2024-04-01');

CREATE TABLE transactions_2024_q2 PARTITION OF transactions
    FOR VALUES FROM ('2024-04-01') TO ('2024-07-01');

-- Index trên partition key → partition pruning hoạt động
CREATE INDEX ON transactions(txn_date);

-- Tự động tạo partition (cần pg_partman extension hoặc cron job)
```

### Partition Pruning

```sql
-- PostgreSQL tự động bỏ qua partitions không match
EXPLAIN SELECT * FROM transactions WHERE txn_date = '2024-03-15';
-- → Chỉ scan transactions_2024_q1, bỏ qua tất cả partitions còn lại

-- Kiểm tra partition pruning có hoạt động không
SET enable_partition_pruning = on; -- default on
```

### Detach & Archive Partitions

```sql
-- Archive cold data — không xóa, chỉ detach
ALTER TABLE transactions DETACH PARTITION transactions_2022;
-- Partition vẫn tồn tại như standalone table, không ảnh hưởng query chính

-- Reattach nếu cần query lịch sử
ALTER TABLE transactions ATTACH PARTITION transactions_2022
    FOR VALUES FROM ('2022-01-01') TO ('2023-01-01');
```

---

## Anti-patterns Phổ Biến — Những gì KHÔNG nên làm

### ❌ SELECT * trong production queries

```sql
-- ❌ Fetch toàn bộ columns kể cả BYTEA, JSONB lớn
SELECT * FROM documents WHERE branch_code = 'HN01';

-- ✅ Chỉ fetch những gì cần — giảm bandwidth, tăng cache efficiency
SELECT id, doc_number, status, created_date 
FROM documents WHERE branch_code = 'HN01';
```

### ❌ N+1 Query trong ORM

```java
// ❌ Hibernate/JPA lazy loading → 1 + N queries
List<Document> docs = documentRepo.findAll(); // 1 query
for (Document doc : docs) {
    doc.getContracts().size(); // N queries (1 per document)
}

// ✅ Explicit JOIN FETCH hoặc EntityGraph
@Query("SELECT d FROM Document d LEFT JOIN FETCH d.contracts WHERE d.branchCode = :branch")
List<Document> findWithContracts(@Param("branch") String branch);

// ✅ Hoặc @BatchSize để giảm N queries xuống N/batch queries
@BatchSize(size = 50)
@OneToMany(mappedBy = "document")
private List<Contract> contracts;
```

### ❌ Implicit Type Casting phá Index

```sql
-- ❌ branch_code là TEXT nhưng truyền vào integer → implicit cast → index unusable
WHERE branch_code = 12345;  -- branch_code text, literal là integer

-- ❌ Timestamp comparison với string → implicit cast
WHERE created_date = '2024-01-15'; -- Đôi khi ok, đôi khi không tùy timezone

-- ✅ Explicit cast hoặc dùng đúng type
WHERE branch_code = '12345';
WHERE created_date = '2024-01-15'::date;
```

### ❌ UPDATE/DELETE không có index trên WHERE clause

```sql
-- ❌ Full table scan để update — với 50M rows là thảm họa
UPDATE documents SET status = 'ARCHIVED' 
WHERE created_date < '2022-01-01';

-- ✅ Đảm bảo có index, hoặc batch update
DO $$
DECLARE
    batch_size INT := 10000;
    rows_affected INT;
BEGIN
    LOOP
        UPDATE documents SET status = 'ARCHIVED'
        WHERE id IN (
            SELECT id FROM documents 
            WHERE created_date < '2022-01-01' AND status != 'ARCHIVED'
            LIMIT batch_size
        );
        GET DIAGNOSTICS rows_affected = ROW_COUNT;
        EXIT WHEN rows_affected < batch_size;
        PERFORM pg_sleep(0.1); -- throttle I/O
    END LOOP;
END $$;
```

### ❌ Long-running Transactions

```sql
-- ❌ Transaction giữ lock lâu → block autovacuum → bloat tăng → performance giảm
BEGIN;
-- ... 30 phút xử lý logic ...
UPDATE documents SET status = 'PROCESSED' WHERE id = 123;
COMMIT;

-- Kiểm tra long-running transactions
SELECT 
    pid,
    now() - pg_stat_activity.query_start AS duration,
    query,
    state
FROM pg_stat_activity
WHERE state != 'idle' 
  AND query_start < now() - interval '5 minutes'
ORDER BY duration DESC;

-- Kill nếu cần (hỏi trước khi làm ở production)
SELECT pg_cancel_backend(pid);  -- graceful
SELECT pg_terminate_backend(pid); -- force
```

### ❌ OR trên nhiều columns khác nhau

```sql
-- ❌ OR ngăn planner dùng index hiệu quả
SELECT * FROM documents 
WHERE branch_code = 'HN01' OR doc_owner_id = 456;

-- ✅ UNION ALL — mỗi branch có thể dùng index riêng
SELECT * FROM documents WHERE branch_code = 'HN01'
UNION ALL
SELECT * FROM documents WHERE doc_owner_id = 456 AND branch_code != 'HN01';
```

### ❌ LIKE với leading wildcard

```sql
-- ❌ Leading wildcard → không dùng được B-tree index
WHERE doc_name LIKE '%contract%';

-- ✅ Dùng Full-Text Search hoặc pg_trgm
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_docs_name_trgm ON documents USING GIN(doc_name gin_trgm_ops);
-- Bây giờ LIKE với leading wildcard và ILIKE đều có thể dùng index
WHERE doc_name ILIKE '%contract%';
```

### ❌ NOT IN với NULL values

```sql
-- ❌ NOT IN với subquery có thể chứa NULL → trả về 0 rows (logic trap!)
SELECT * FROM documents
WHERE id NOT IN (SELECT document_id FROM archived_docs);
-- Nếu archived_docs có 1 row với document_id = NULL → kết quả RỖNG!

-- ✅ NOT EXISTS — safe với NULL
SELECT * FROM documents d
WHERE NOT EXISTS (
    SELECT 1 FROM archived_docs a WHERE a.document_id = d.id
);

-- ✅ LEFT JOIN ... WHERE IS NULL
SELECT d.* FROM documents d
LEFT JOIN archived_docs a ON a.document_id = d.id
WHERE a.document_id IS NULL;
```

---

## Monitoring & Diagnostics — Đo trước, tối ưu sau

### pg_stat_statements — Query performance tracking

```sql
-- Enable extension (cần restart)
-- postgresql.conf: shared_preload_libraries = 'pg_stat_statements'
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Top 10 queries tốn thời gian nhất (tổng)
SELECT 
    ROUND(total_exec_time::numeric, 2) AS total_ms,
    calls,
    ROUND(mean_exec_time::numeric, 2) AS mean_ms,
    ROUND(stddev_exec_time::numeric, 2) AS stddev_ms,
    rows,
    LEFT(query, 100) AS query_snippet
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;

-- Queries với mean time cao nhất (latency outliers)
SELECT 
    calls,
    ROUND(mean_exec_time::numeric, 2) AS mean_ms,
    ROUND(max_exec_time::numeric, 2) AS max_ms,
    LEFT(query, 120) AS query_snippet
FROM pg_stat_statements
WHERE calls > 10  -- loại bỏ one-off queries
ORDER BY mean_exec_time DESC
LIMIT 10;

-- Reset statistics
SELECT pg_stat_statements_reset();
```

### Lock Monitoring

```sql
-- Queries đang bị block
SELECT 
    blocked_locks.pid AS blocked_pid,
    blocked_activity.usename AS blocked_user,
    blocking_locks.pid AS blocking_pid,
    blocking_activity.usename AS blocking_user,
    blocked_activity.query AS blocked_statement,
    blocking_activity.query AS current_statement_in_blocking_process
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity  ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks 
    ON blocking_locks.locktype = blocked_locks.locktype
    AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
    AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
    AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
    AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
    AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
    AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
    AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
    AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
    AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
    AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

### Table & Index Size

```sql
-- Top 20 tables by total size (including indexes, toast)
SELECT 
    tablename,
    pg_size_pretty(pg_total_relation_size(tablename::regclass)) AS total_size,
    pg_size_pretty(pg_relation_size(tablename::regclass)) AS table_size,
    pg_size_pretty(pg_total_relation_size(tablename::regclass) - pg_relation_size(tablename::regclass)) AS index_toast_size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(tablename::regclass) DESC
LIMIT 20;
```

---

## Advanced Techniques — Vũ khí của senior

### Materialized Views — Cache kết quả query phức tạp

```sql
-- Tạo materialized view cho aggregation report tốn kém
CREATE MATERIALIZED VIEW mv_branch_stats AS
SELECT 
    branch_code,
    DATE_TRUNC('month', created_date) AS month,
    COUNT(*) AS doc_count,
    SUM(amount) AS total_amount,
    AVG(processing_days) AS avg_processing_days
FROM documents d
LEFT JOIN contracts c ON c.document_id = d.id
WHERE d.status = 'COMPLETED'
GROUP BY branch_code, DATE_TRUNC('month', created_date);

CREATE UNIQUE INDEX ON mv_branch_stats(branch_code, month);

-- Refresh (concurrent = không lock, cần unique index)
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_branch_stats;

-- Schedule refresh với pg_cron
SELECT cron.schedule('0 2 * * *', 'REFRESH MATERIALIZED VIEW CONCURRENTLY mv_branch_stats');
```

### Advisory Locks — Application-level locking

```sql
-- Distributed lock thay thế Redis cho các tác vụ cần coordination
-- Tốt hơn SELECT FOR UPDATE cho long-running jobs

-- Session-level lock (tự động release khi connection đóng)
SELECT pg_try_advisory_lock(12345); -- returns true nếu acquire được
-- ... do work ...
SELECT pg_advisory_unlock(12345);

-- Transaction-level lock (tự release khi transaction kết thúc)
SELECT pg_try_advisory_xact_lock(12345);

-- Dùng trong stored procedure / cron job
DO $$
BEGIN
    IF pg_try_advisory_lock(hashtext('batch_archive_job')) THEN
        -- chạy job
        PERFORM pg_advisory_unlock(hashtext('batch_archive_job'));
    ELSE
        RAISE NOTICE 'Job already running, skipping';
    END IF;
END $$;
```

### SKIP LOCKED — Queue pattern trong PostgreSQL

```sql
-- Pattern xử lý job queue không bị contention
-- Mỗi worker lấy 1 job khác nhau, không chờ nhau

SELECT id, payload FROM job_queue
WHERE status = 'PENDING'
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;
-- Worker thứ hai sẽ tự động bỏ qua row mà worker thứ nhất đang lock
```

### GENERATED COLUMNS — Computed columns trong table

```sql
-- Lưu kết quả tính toán, tự update khi source columns thay đổi
ALTER TABLE documents ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
        to_tsvector('simple', COALESCE(doc_name, '') || ' ' || COALESCE(doc_number, ''))
    ) STORED;

CREATE INDEX idx_docs_fts ON documents USING GIN(search_vector);

-- Query full-text search
SELECT * FROM documents WHERE search_vector @@ plainto_tsquery('simple', 'hop dong 2024');
```

### Connection Pooling — PgBouncer

```ini
# pgbouncer.ini — critical settings
pool_mode = transaction     # Transaction pooling: connection trả về pool sau mỗi transaction
                             # Session pooling: giữ connection cả session (kém hiệu quả hơn)
max_client_conn = 1000      # Tối đa clients kết nối đến PgBouncer
default_pool_size = 20      # Actual connections đến PostgreSQL per database/user pair
min_pool_size = 5
reserve_pool_size = 5
server_lifetime = 3600      # Recycle connections sau 1 giờ
server_idle_timeout = 600   # Close idle connections sau 10 phút
```

> **Lưu ý với Spring Boot**: Transaction pooling không tương thích với `SET LOCAL`, prepared statements (dùng `server_reset_query`), hoặc session-level advisory locks.

### UNLOGGED Tables — Tốc độ tối đa cho temporary data

```sql
-- UNLOGGED: không ghi WAL → 5-10x nhanh hơn cho bulk insert
-- Đánh đổi: mất data nếu crash, không replicate đến standby
CREATE UNLOGGED TABLE staging_import (
    id BIGSERIAL PRIMARY KEY,
    raw_data JSONB,
    processed BOOLEAN DEFAULT false
);

-- Dùng cho: ETL staging, session data, temporary calculations
-- Chuyển về LOGGED khi done nếu cần đưa vào permanent table
ALTER TABLE staging_import SET LOGGED;
```

### Statistics Extension — Tương quan giữa nhiều columns

```sql
-- Khi planner estimate sai vì 2 columns có correlation (data skew)
-- Ví dụ: city và zip_code có strong correlation

CREATE STATISTICS stat_branch_status ON branch_code, status FROM documents;
ANALYZE documents;

-- PostgreSQL giờ sẽ estimate better cho queries filter trên cả 2 columns
-- Kiểm tra
SELECT * FROM pg_statistic_ext WHERE stxname = 'stat_branch_status';
```

---

## Quick Reference Checklist

### Trước khi deploy một query mới
- [ ] `EXPLAIN ANALYZE BUFFERS` — hiểu plan, check actual vs estimated rows
- [ ] Index có được dùng không? Có bị filter bởi function wrap không?
- [ ] Có returning đúng columns cần thiết không (không `SELECT *`)?
- [ ] Pagination dùng keyset thay vì OFFSET?

### Khi query chậm đột ngột
- [ ] Check `pg_stat_statements` — compare với baseline
- [ ] `ANALYZE tablename` — statistics có stale không?
- [ ] Check bloat: `n_dead_tup / n_live_tup`
- [ ] Check locks: có query nào đang block không?
- [ ] `EXPLAIN` lại — planner có đổi plan không?

### Tuning checklist mới setup server
- [ ] `shared_buffers` = 25% RAM
- [ ] `effective_cache_size` = 75% RAM  
- [ ] `work_mem` đủ để tránh spill (check "Batches:" trong EXPLAIN)
- [ ] `autovacuum_vacuum_cost_delay` ≤ 2ms
- [ ] `pg_stat_statements` enabled
- [ ] PgBouncer trước PostgreSQL nếu có nhiều connections

---

## Related Notes

- [[Microservices-Patterns/Cross-Service-Join-AuthZ-Fine-Grained-Filter]] — Query patterns cho cross-service data
- [[Microservices-Patterns/Transactional-Outbox]] — Write patterns tránh tạo bloat
- [[concepts/project-loom-deep-dive]] — Virtual threads và connection pooling implications

---

*Last updated: 2026-04-14*  
*Tags: #postgresql #performance #database #rdbms #optimization*
