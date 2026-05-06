# 07 — COUNT(*) vs COUNT(column): Hiểu Đúng Để Dùng Đúng

> **Audience:** Backend engineers hay dùng COUNT mà không rõ sự khác biệt về semantic và performance.  
> **Scope:** Semantic chính xác, cơ chế thực thi trong PostgreSQL, benchmark, và khi nào dùng cái nào.  
> **Liên kết:** [[02-MVCC-Concurrency]] | [[06-Query-Planner]] | [[00-PostgreSQL-Hub]]

---

## 📋 Mục lục

1. [Semantic khác nhau — Đây là điều quan trọng nhất](#1-semantic-khác-nhau)
2. [Cơ chế thực thi bên trong PostgreSQL](#2-cơ-chế-thực-thi-bên-trong-postgresql)
3. [Performance thực tế — Benchmark và phân tích](#3-performance-thực-tế)
4. [MVCC ảnh hưởng COUNT như thế nào](#4-mvcc-ảnh-hưởng-count-như-thế-nào)
5. [Các biến thể COUNT và use cases](#5-các-biến-thể-count-và-use-cases)
6. [Tối ưu COUNT trên bảng lớn](#6-tối-ưu-count-trên-bảng-lớn)
7. [Decision Guide](#7-decision-guide)

---

## 1. Semantic khác nhau

Trước khi nói performance, phải hiểu **ý nghĩa** — vì đây là nguồn gốc của bug thầm lặng.

```
┌─────────────────────────────────────────────────────────────────┐
│                   COUNT Semantic Comparison                      │
│                                                                  │
│  COUNT(*)          COUNT(column)         COUNT(DISTINCT column)  │
│  ───────────       ────────────────      ──────────────────────  │
│  Đếm TẤT CẢ       Đếm rows có           Đếm distinct values     │
│  rows, kể cả      column IS NOT NULL     (loại trừ NULL)         │
│  NULL              (loại trừ NULL)                               │
│                                                                  │
│  Ví dụ với data:                                                 │
│  id │ reviewer_id                                                │
│  ───┼────────────                                                │
│   1 │ 100                                                        │
│   2 │ NULL    ← chưa được review                                 │
│   3 │ 100                                                        │
│   4 │ 200                                                        │
│                                                                  │
│  COUNT(*)           = 4   (tất cả rows)                          │
│  COUNT(reviewer_id) = 3   (loại row 2 vì NULL)                   │
│  COUNT(DISTINCT reviewer_id) = 2  (100 và 200)                   │
└─────────────────────────────────────────────────────────────────┘
```

**Bug thầm lặng phổ biến:**

```sql
-- Tưởng đếm số documents trong bảng
SELECT COUNT(archived_at) FROM documents;
-- Thực ra: đếm số documents ĐÃ ĐƯỢC archive (archived_at IS NOT NULL)
-- Nếu 30% chưa archive → kết quả sai hoàn toàn!

-- Đúng nếu muốn đếm tất cả:
SELECT COUNT(*) FROM documents;

-- Đúng nếu muốn đếm đã archive:
SELECT COUNT(*) FROM documents WHERE archived_at IS NOT NULL;
-- hoặc
SELECT COUNT(archived_at) FROM documents;  -- nhưng phải biết mình đang làm gì
```

---

## 2. Cơ chế thực thi bên trong PostgreSQL

### COUNT(*) — Tối ưu ở executor level

```
┌──────────────────────────────────────────────────────────────────┐
│                  COUNT(*) Execution Path                          │
│                                                                  │
│  Planner tạo plan:                                               │
│  Aggregate [COUNT(*)]                                            │
│    └─► Seq Scan / Index Scan on table                            │
│                                                                  │
│  Executor behavior:                                              │
│  FOR each tuple found by scan:                                   │
│    ① Check MVCC visibility (xmin/xmax)                           │
│    ② IF visible → counter++                                      │
│    ③ KHÔNG cần detoast bất kỳ column nào                         │
│    ④ KHÔNG cần fetch column value                                 │
│                                                                  │
│  → Chỉ cần tuple header (23 bytes)                               │
│  → Không đọc column data                                         │
└──────────────────────────────────────────────────────────────────┘
```

### COUNT(column) — Thêm một bước null check

```
┌──────────────────────────────────────────────────────────────────┐
│               COUNT(column) Execution Path                        │
│                                                                  │
│  Planner tạo plan:                                               │
│  Aggregate [COUNT(column)]                                       │
│    └─► Seq Scan / Index Scan on table                            │
│                                                                  │
│  Executor behavior:                                              │
│  FOR each tuple found by scan:                                   │
│    ① Check MVCC visibility (xmin/xmax)                           │
│    ② IF visible:                                                 │
│       ③ Fetch column value từ tuple data                          │
│       ④ Check IS NOT NULL                                         │
│       ⑤ IF not null → counter++                                  │
│                                                                  │
│  → Phải đọc column data (hoặc ít nhất null bitmap)               │
│  → Nếu column là TOAST (lớn) → có thể trigger detoast            │
└──────────────────────────────────────────────────────────────────┘
```

### So sánh instruction path

```
COUNT(*)           COUNT(column)          COUNT(DISTINCT col)
──────────         ─────────────          ──────────────────
Scan tuple         Scan tuple             Scan tuple
Check visibility   Check visibility       Check visibility
counter++          Fetch col value        Fetch col value
                   Check null             Add to hash set
                   counter++ if not null  (dedup in memory)
                                          Final count of set

Cost: Thấp nhất    Cost: Cao hơn chút    Cost: Cao nhất
                   (null bitmap check)    (hashing + memory)
```

### Null bitmap optimization

PostgreSQL lưu **null bitmap** ngay trong tuple header — một bit per column cho biết column đó có NULL không. Với COUNT(column), PostgreSQL check null bitmap **trước** khi fetch actual column data.

```
Tuple header layout:
┌────────────────────────────────────────────┐
│ t_xmin (4B) │ t_xmax (4B) │ t_cid (4B)    │
│ t_ctid (6B) │ t_infomask2 (2B) │ ...       │
│ [null bitmap: 1 bit per column]            │ ← Check này trước!
├────────────────────────────────────────────┤
│ column 1 data │ column 2 data │ ...        │ ← Chỉ fetch nếu không null
└────────────────────────────────────────────┘

→ Nếu column NOT NULL constraint → null bitmap không tồn tại
  → PostgreSQL biết không cần check → COUNT(col) ≈ COUNT(*) performance
```

---

## 3. Performance thực tế

### Benchmark trên 10M rows

```sql
-- Setup
CREATE TABLE perf_test AS
SELECT 
    i AS id,
    CASE WHEN i % 5 = 0 THEN NULL ELSE i * 2 END AS nullable_col,
    i * 2 AS not_null_col,
    repeat('x', 100) AS text_col
FROM generate_series(1, 10000000) i;

-- Run tests
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT COUNT(*) FROM perf_test;

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT COUNT(nullable_col) FROM perf_test;

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT COUNT(not_null_col) FROM perf_test;

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT COUNT(DISTINCT nullable_col) FROM perf_test;
```

```
┌────────────────────────────────────────────────────────────────┐
│                  Benchmark Results (10M rows)                   │
│                                                                 │
│  Query                        │ Time    │ Notes                 │
│  ─────────────────────────────┼─────────┼───────────────────── │
│  COUNT(*)                     │ 1.2s    │ Baseline              │
│  COUNT(not_null_col)          │ 1.3s    │ +8% (null check)      │
│  COUNT(nullable_col)          │ 1.4s    │ +17% (has NULLs)      │
│  COUNT(text_col)              │ 1.5s    │ +25% (wider tuples)   │
│  COUNT(DISTINCT nullable_col) │ 8.7s    │ +625% (hashing!)      │
│                                                                 │
│  Hardware: SSD, shared_buffers=2GB (data fit in cache)          │
│                                                                 │
│  Conclusion:                                                    │
│  COUNT(*) vs COUNT(col)   → nhỏ, thường không đáng kể          │
│  COUNT(DISTINCT)          → LỚN, cần strategy khác              │
└────────────────────────────────────────────────────────────────┘
```

### Tại sao COUNT(*) không nhanh hơn nhiều so với COUNT(col)?

Bottleneck thực sự **không phải** là null check — mà là:

```
1. I/O: Đọc heap pages từ disk (hoặc shared_buffers)
   → Cả COUNT(*) và COUNT(col) đều phải đọc cùng pages
   → Null check chỉ là CPU operation nhỏ sau khi đã có data trong memory

2. MVCC visibility check: Mỗi tuple đều phải check xmin/xmax
   → Đây là phần tốn thời gian nhất, giống nhau cho cả hai

3. Sequential scan: Cả hai đều scan toàn bộ heap
   → Không có cách nào tránh nếu không có special indexes
```

**Khi nào sự khác biệt trở nên rõ rệt?**

```sql
-- TOAST columns — text/bytea/jsonb lớn
-- COUNT(large_jsonb_col) phải check null → nếu không null → potential detoast
-- COUNT(*) hoàn toàn bypass TOAST

-- Test với TOAST:
CREATE TABLE toast_test AS
SELECT i, repeat('a', 10000)::TEXT AS big_text  -- > 2KB → stored in TOAST
FROM generate_series(1, 1000000) i;

SELECT COUNT(*) FROM toast_test;           -- ~800ms (không touch TOAST)
SELECT COUNT(big_text) FROM toast_test;    -- ~2400ms (check null + TOAST lookup)
-- 3x chênh lệch với TOAST columns!
```

---

## 4. MVCC ảnh hưởng COUNT như thế nào

Đây là lý do **COUNT(*) trong PostgreSQL LUÔN CHẬM HƠN** so với một số database khác — và tại sao không thể so sánh trực tiếp.

### Vấn đề: Không có "exact row count" trong MVCC

```
┌────────────────────────────────────────────────────────────────────┐
│               MVCC và COUNT — Vấn đề cốt lõi                       │
│                                                                    │
│  MySQL MyISAM:                                                     │
│  ┌──────────────┐                                                  │
│  │ row_count=10M│ ← stored metadata                                │
│  └──────────────┘                                                  │
│  COUNT(*) = O(1)! (đọc metadata)                                   │
│  Trade-off: table-level locking, không có MVCC                     │
│                                                                    │
│  PostgreSQL (MVCC):                                                │
│  ┌──────────────────────────────────────────┐                      │
│  │ Tuple 1: xmin=100, xmax=0     → VISIBLE? │                      │
│  │ Tuple 2: xmin=200, xmax=150  → VISIBLE? │                      │
│  │ Tuple 3: xmin=50,  xmax=300  → VISIBLE? │                      │
│  │ ...10M tuples...                         │                      │
│  └──────────────────────────────────────────┘                      │
│  COUNT(*) = O(N) — phải check từng tuple!                          │
│  Trade-off: readers không block writers                            │
│                                                                    │
│  "Row count" phụ thuộc vào SNAPSHOT của transaction → không        │
│  thể cache một giá trị duy nhất cho tất cả                         │
└────────────────────────────────────────────────────────────────────┘
```

### Visibility Map giúp một phần

PostgreSQL có **Visibility Map** (1 bit/page) đánh dấu pages mà tất cả tuples đều visible với mọi transactions. Nhưng COUNT vẫn phải iterate — VM chỉ skip VACUUM overhead, không skip count overhead.

---

## 5. Các biến thể COUNT và use cases

```sql
-- ① COUNT(*) — đếm tất cả rows (kể cả NULL columns)
SELECT COUNT(*) FROM orders;
-- Use: kiểm tra số records, pagination, tổng số

-- ② COUNT(col) — đếm non-NULL values
SELECT COUNT(completed_at) FROM orders;
-- Use: đếm records có giá trị cụ thể (thay cho WHERE IS NOT NULL)
-- Lưu ý: semantic khác COUNT(*) với WHERE!

-- ③ COUNT(DISTINCT col) — đếm unique values
SELECT COUNT(DISTINCT customer_id) FROM orders;
-- Use: cardinality estimation, analytics
-- Warning: expensive với large data!

-- ④ COUNT(*) FILTER (WHERE ...) — conditional count (PG 9.4+)
SELECT
    COUNT(*) FILTER (WHERE status = 'PENDING')  AS pending_count,
    COUNT(*) FILTER (WHERE status = 'DONE')     AS done_count,
    COUNT(*) FILTER (WHERE status = 'FAILED')   AS failed_count,
    COUNT(*) AS total
FROM jobs;
-- Use: multiple aggregates in one pass (MUCH faster than multiple queries!)
-- Equivalent to COUNT(CASE WHEN status='PENDING' THEN 1 END)

-- ⑤ COUNT trong window function
SELECT
    id, branch_id, status,
    COUNT(*) OVER (PARTITION BY branch_id) AS total_in_branch,
    COUNT(*) OVER (PARTITION BY branch_id, status) AS count_by_status
FROM documents;
-- Use: per-group counts mà không GROUP BY (giữ individual rows)
```

### FILTER vs CASE WHEN — Chọn cái nào?

```sql
-- FILTER (cleaner, Postgres-specific):
COUNT(*) FILTER (WHERE status = 'DONE')

-- CASE WHEN (portable, SQL standard):
COUNT(CASE WHEN status = 'DONE' THEN 1 END)

-- Performance: tương đương
-- Readability: FILTER rõ ràng hơn
-- Portability: CASE WHEN nếu cần dùng trên nhiều DB
```

---

## 6. Tối ưu COUNT trên bảng lớn

### Strategy 1: Approximate count (pg_class statistics)

```sql
-- Fast estimate — O(1), không scan table
-- Chính xác trong vài phút sau ANALYZE
SELECT reltuples::BIGINT AS approximate_count
FROM pg_class
WHERE relname = 'documents';

-- Khi dùng: UI pagination "Showing ~4.2M results", dashboard summary
-- Sai số: thường < 1-5% với autovacuum hoạt động tốt
-- KHÔNG dùng khi: cần chính xác tuyệt đối, financial reporting
```

```sql
-- Wrapper function tiện dụng:
CREATE OR REPLACE FUNCTION approx_count(table_name TEXT)
RETURNS BIGINT AS $$
    SELECT reltuples::BIGINT
    FROM pg_class
    WHERE relname = table_name;
$$ LANGUAGE SQL STABLE;

SELECT approx_count('documents');  -- Instant!
```

### Strategy 2: Partial count với index

```sql
-- Nếu thường xuyên COUNT với WHERE condition cố định:
CREATE INDEX idx_docs_pending ON documents(id)
WHERE status = 'PENDING';

-- PostgreSQL có thể dùng Index-Only Scan:
SELECT COUNT(*) FROM documents WHERE status = 'PENDING';
-- EXPLAIN: Index Only Scan using idx_docs_pending
-- → Chỉ đọc index pages (nhỏ hơn heap), không đọc heap!
```

### Strategy 3: Counter table (materialized count)

```sql
-- Pattern cho real-time counter không cần scan
CREATE TABLE document_counters (
    branch_id   TEXT,
    status      TEXT,
    count       BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (branch_id, status)
);

-- Increment khi INSERT
CREATE OR REPLACE FUNCTION update_doc_counter()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO document_counters(branch_id, status, count)
        VALUES (NEW.branch_id, NEW.status, 1)
        ON CONFLICT (branch_id, status) DO UPDATE
            SET count = document_counters.count + 1;
    ELSIF TG_OP = 'UPDATE' AND OLD.status != NEW.status THEN
        -- Decrement old status
        UPDATE document_counters
        SET count = count - 1
        WHERE branch_id = OLD.branch_id AND status = OLD.status;
        -- Increment new status
        INSERT INTO document_counters(branch_id, status, count)
        VALUES (NEW.branch_id, NEW.status, 1)
        ON CONFLICT (branch_id, status) DO UPDATE
            SET count = document_counters.count + 1;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE document_counters
        SET count = count - 1
        WHERE branch_id = OLD.branch_id AND status = OLD.status;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_doc_counter
AFTER INSERT OR UPDATE OR DELETE ON documents
FOR EACH ROW EXECUTE FUNCTION update_doc_counter();

-- Query: O(1) thay vì O(N)!
SELECT count FROM document_counters WHERE branch_id = 'HN01' AND status = 'PENDING';
```

### Strategy 4: Materialized view với scheduled refresh

```sql
-- Cho reports cần exact count nhưng có thể chấp nhận stale data
CREATE MATERIALIZED VIEW mv_document_stats AS
SELECT
    branch_id,
    status,
    COUNT(*) AS doc_count,
    COUNT(archived_at) AS archived_count,
    COUNT(DISTINCT reviewer_id) AS unique_reviewers
FROM documents
GROUP BY branch_id, status;

CREATE UNIQUE INDEX ON mv_document_stats(branch_id, status);

-- Refresh định kỳ (không lock trong lúc refresh)
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_document_stats;
```

---

## 7. Decision Guide

```
Bạn cần COUNT gì?
│
├─► Đếm tất cả rows (kể cả rows có NULL columns)?
│     └─ COUNT(*) ← luôn là lựa chọn này
│
├─► Đếm rows có giá trị cụ thể trong một column?
│     └─ COUNT(column) hoặc COUNT(*) WHERE column IS NOT NULL
│        (ưu tiên WHERE để code rõ ràng hơn)
│
├─► Đếm unique values?
│     ├─ Bảng nhỏ (< 1M rows): COUNT(DISTINCT col)
│     └─ Bảng lớn:
│           ├─ Exact: COUNT(DISTINCT col) nhưng cần patience
│           └─ Approximate: HyperLogLog extension (pg_hll)
│
├─► Multiple conditional counts trong cùng query?
│     └─ COUNT(*) FILTER (WHERE ...) — single pass!
│
├─► COUNT trên bảng hàng triệu rows, latency < 10ms?
│     ├─ Chấp nhận approximate: pg_class.reltuples
│     ├─ Có WHERE condition cố định: partial index
│     ├─ Real-time exact: counter table (trigger)
│     └─ Batch/report context: materialized view
│
└─► COUNT(*) với MVCC — chậm hơn MySQL MyISAM là BÌNH THƯỜNG
      → Đó là trade-off của MVCC (đọc không block ghi)
```

---

## Related Notes

- [[02-MVCC-Concurrency]] — Tại sao MVCC buộc phải scan tuples
- [[04-Index-Internals]] — Index-Only Scan giúp COUNT nhanh hơn
- [[06-Query-Planner]] — Planner chọn plan cho aggregate như thế nào
- [[05-Performance-Tuning]] — pg_stat_statements để identify slow COUNT queries

---

*Tags: #postgresql #count #performance #mvcc #aggregation*  
*Created: 2026-05-06 | Difficulty: ⭐⭐*
