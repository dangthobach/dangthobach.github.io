# 13 — Grouping & Aggregation: Từ Cơ Bản Đến Advanced

> **Audience:** Senior engineers cần master aggregation cho reporting, analytics, và banking calculations.  
> **Scope:** GROUP BY internals, window functions, GROUPING SETS, ROLLUP, CUBE, Oracle-specific, common mistakes.  
> **Liên kết:** [[06-Query-Planner]] | [[07-Count-Star-vs-Count-Column]] | [[00-PostgreSQL-Hub]]

---

## 📋 Mục lục

1. [GROUP BY internals — Planner chọn HashAggregate hay Sort+Group?](#1-group-by-internals)
2. [Aggregate functions — Full arsenal](#2-aggregate-functions)
3. [FILTER clause — Conditional aggregation](#3-filter-clause)
4. [GROUPING SETS, ROLLUP, CUBE — Multi-level aggregation](#4-grouping-sets-rollup-cube)
5. [Window Functions — Per-row aggregation không GROUP BY](#5-window-functions)
6. [Oracle-specific aggregation features](#6-oracle-specific)
7. [Common Mistakes](#7-common-mistakes)
8. [Performance Tips](#8-performance-tips)

---

## 1. GROUP BY internals

Khi bạn viết GROUP BY, PostgreSQL chọn một trong hai strategy:

```
┌──────────────────────────────────────────────────────────────────────┐
│              GROUP BY Execution Strategies                            │
│                                                                      │
│  Strategy 1: HashAggregate                                           │
│                                                                      │
│  Input rows                                                          │
│  ┌──────────────────────────────────────────┐                        │
│  │ branch=HN, amt=100                       │                        │
│  │ branch=SG, amt=200  ──► Hash Table ◄──  │                        │
│  │ branch=HN, amt=150  ──► {HN: 250}        │                        │
│  │ branch=SG, amt=300  ──► {SG: 500}        │                        │
│  └──────────────────────────────────────────┘                        │
│  • Build hash table in memory (work_mem)                             │
│  • O(N), but needs memory for all groups                             │
│  • Spills to disk if groups > work_mem → Batches > 1                │
│  • EXPLAIN: "HashAggregate ... Batches: 4" ← cần tăng work_mem      │
│                                                                      │
│  Strategy 2: GroupAggregate (Sort + Group)                           │
│                                                                      │
│  Sort input by group key first:                                      │
│  HN,100 → HN,150 → SG,200 → SG,300                                  │
│  Then scan: identical keys adjacent → accumulate                     │
│  • O(N log N) for sort, O(1) memory during aggregation               │
│  • Chosen when: sorted index exists, or N is large vs work_mem      │
│                                                                      │
│  Planner chooses based on:                                           │
│  - Number of estimated groups                                        │
│  - Available work_mem                                                │
│  - Whether sorted order already available (index)                    │
└──────────────────────────────────────────────────────────────────────┘
```

```sql
-- Force in-memory aggregation (avoid disk spill):
SET work_mem = '256MB';

-- Check if spilling:
EXPLAIN (ANALYZE, BUFFERS)
SELECT branch_id, COUNT(*), SUM(amount)
FROM documents GROUP BY branch_id;
-- Look for: "Batches: 4" → spilled 4 times to disk → increase work_mem
-- Good: "Batches: 1" → entirely in memory
```

---

## 2. Aggregate functions

### Standard aggregates

```sql
SELECT
    branch_id,

    -- Counting
    COUNT(*)                        AS total_rows,
    COUNT(reviewer_id)              AS reviewed_count,      -- excludes NULL
    COUNT(DISTINCT reviewer_id)     AS unique_reviewers,

    -- Numeric
    SUM(amount)                     AS total_amount,
    AVG(amount)                     AS avg_amount,
    MIN(amount)                     AS min_amount,
    MAX(amount)                     AS max_amount,

    -- Statistical
    STDDEV(amount)                  AS std_dev,
    VARIANCE(amount)                AS variance,
    PERCENTILE_CONT(0.5)
        WITHIN GROUP (ORDER BY amount) AS median,          -- exact median
    PERCENTILE_CONT(0.95)
        WITHIN GROUP (ORDER BY amount) AS p95,             -- 95th percentile
    PERCENTILE_DISC(0.5)
        WITHIN GROUP (ORDER BY amount) AS median_disc,     -- discrete (actual value)

    -- Boolean
    BOOL_AND(is_active)             AS all_active,
    BOOL_OR(is_urgent)              AS any_urgent,

    -- Array/String
    ARRAY_AGG(id ORDER BY created_at) AS id_list,          -- array of ids
    STRING_AGG(doc_number, ', '
        ORDER BY created_at)        AS doc_numbers,        -- comma-separated

    -- JSON
    JSON_AGG(jsonb_build_object(
        'id', id,
        'status', status
    ) ORDER BY created_at)          AS docs_json

FROM documents
WHERE deleted_at IS NULL
GROUP BY branch_id;
```

### Ordered-set aggregates (PostgreSQL)

```sql
-- WITHIN GROUP — aggregate with explicit ORDER
SELECT
    branch_id,
    -- Median salary:
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY amount) AS median,

    -- Most common status (mode):
    MODE() WITHIN GROUP (ORDER BY status) AS most_common_status,

    -- First value after ordering:
    FIRST_VALUE(doc_number) WITHIN GROUP (ORDER BY created_at) AS oldest_doc

FROM documents GROUP BY branch_id;
```

---

## 3. FILTER clause

**FILTER** cho phép conditional aggregation trong một lần scan — thay thế nhiều subqueries:

```sql
-- ❌ Multiple subqueries (N passes over data):
SELECT
    b.branch_id,
    (SELECT COUNT(*) FROM docs WHERE branch_id = b.branch_id AND status='PENDING') AS pending,
    (SELECT COUNT(*) FROM docs WHERE branch_id = b.branch_id AND status='ACTIVE') AS active,
    (SELECT SUM(amount) FROM docs WHERE branch_id = b.branch_id AND status='ACTIVE') AS active_amt
FROM branches b;

-- ✅ FILTER — single pass, dramatically faster:
SELECT
    branch_id,
    COUNT(*)                                        AS total,
    COUNT(*) FILTER (WHERE status = 'PENDING')      AS pending,
    COUNT(*) FILTER (WHERE status = 'ACTIVE')       AS active,
    COUNT(*) FILTER (WHERE status = 'DONE')         AS done,
    SUM(amount) FILTER (WHERE status = 'ACTIVE')    AS active_amount,
    AVG(amount) FILTER (WHERE amount > 0)           AS avg_positive,
    MAX(created_at) FILTER (WHERE status = 'DONE')  AS last_completed

FROM documents
WHERE deleted_at IS NULL
GROUP BY branch_id;
```

```
Performance comparison (1M rows, 20 branches):
  Multiple subqueries:  ~2400ms  (20 × 3 subqueries = 60 passes)
  FILTER aggregation:   ~180ms   (1 pass)
  → 13x faster!
```

---

## 4. GROUPING SETS, ROLLUP, CUBE

Tính aggregate trên nhiều levels trong một query — tránh UNION ALL nhiều GROUP BY:

### GROUPING SETS — Custom combinations

```sql
-- ❌ Verbose UNION ALL approach:
SELECT branch_id, status,  COUNT(*) FROM docs GROUP BY branch_id, status
UNION ALL
SELECT branch_id, NULL,    COUNT(*) FROM docs GROUP BY branch_id
UNION ALL
SELECT NULL,      status,  COUNT(*) FROM docs GROUP BY status
UNION ALL
SELECT NULL,      NULL,    COUNT(*) FROM docs;

-- ✅ GROUPING SETS — declarative, single pass:
SELECT
    branch_id,
    status,
    COUNT(*) AS cnt,
    GROUPING(branch_id) AS is_branch_total,   -- 1 if this row is a "branch total"
    GROUPING(status)    AS is_status_total    -- 1 if this row is a "status total"
FROM documents
WHERE deleted_at IS NULL
GROUP BY GROUPING SETS (
    (branch_id, status),   -- detail level
    (branch_id),           -- subtotal per branch
    (status),              -- subtotal per status
    ()                     -- grand total
);
```

```
Output visualization:
┌───────────┬──────────┬───────┬──────────────────┐
│ branch_id │ status   │ cnt   │ row type         │
├───────────┼──────────┼───────┼──────────────────┤
│ HN01      │ PENDING  │  150  │ detail           │
│ HN01      │ ACTIVE   │  320  │ detail           │
│ HN01      │ NULL     │  470  │ branch subtotal  │
│ SG01      │ PENDING  │  200  │ detail           │
│ SG01      │ ACTIVE   │  280  │ detail           │
│ SG01      │ NULL     │  480  │ branch subtotal  │
│ NULL      │ PENDING  │  350  │ status subtotal  │
│ NULL      │ ACTIVE   │  600  │ status subtotal  │
│ NULL      │ NULL     │  950  │ GRAND TOTAL      │
└───────────┴──────────┴───────┴──────────────────┘
NULL trong branch_id = subtotal cho tất cả branches
Dùng GROUPING() function để phân biệt NULL data vs NULL subtotal
```

### ROLLUP — Hierarchical subtotals

```sql
-- ROLLUP(a, b, c) = GROUPING SETS ((a,b,c), (a,b), (a), ())
-- Perfect for hierarchical data: region → branch → department

SELECT
    region,
    branch_id,
    department,
    SUM(amount) AS total,
    GROUPING(region, branch_id, department) AS level
FROM transactions
GROUP BY ROLLUP(region, branch_id, department)
ORDER BY region NULLS LAST, branch_id NULLS LAST, department NULLS LAST;
```

```
ROLLUP output structure:
  region=HN, branch=HN01, dept=IT    → 150,000  (leaf)
  region=HN, branch=HN01, dept=OPS   → 200,000  (leaf)
  region=HN, branch=HN01, dept=NULL  → 350,000  (branch subtotal)
  region=HN, branch=HN02, dept=...
  region=HN, branch=NULL, dept=NULL  → 800,000  (region subtotal)
  region=NULL, branch=NULL, dept=NULL → 2,100,000 (GRAND TOTAL)
```

### CUBE — All combinations

```sql
-- CUBE(a, b, c) = GROUPING SETS of ALL 2^N combinations
-- 3 dimensions → 8 grouping sets

SELECT
    year,
    quarter,
    product_category,
    SUM(revenue) AS total_revenue
FROM sales
GROUP BY CUBE(year, quarter, product_category);

-- Output: 2^3 = 8 different aggregation levels
-- Useful for: OLAP pivot tables, cross-dimensional analysis
-- Warning: số rows = N_distinct_combos × 2^N → có thể rất lớn!
```

---

## 5. Window Functions

Window functions compute across related rows **without collapsing** them into groups. Đây là một trong những features mạnh nhất của SQL.

```
┌──────────────────────────────────────────────────────────────────────┐
│              GROUP BY vs Window Function                              │
│                                                                      │
│  GROUP BY:                         Window Function:                  │
│  id│branch│amt  →  branch│sum      id│branch│amt│running_sum        │
│  1 │  HN  │100  →  HN   │350       1│  HN  │100│  100              │
│  2 │  HN  │150      SG  │200       2│  HN  │150│  250              │
│  3 │  SG  │200                     3│  HN  │100│  350              │
│  4 │  HN  │100                     4│  SG  │200│  200              │
│                                                                      │
│  GROUP BY: collapses rows          Window: keeps all rows            │
│            → lose individual data  → per-row calculation over set    │
└──────────────────────────────────────────────────────────────────────┘
```

### Anatomy of a window function

```sql
function_name() OVER (
    PARTITION BY col1, col2   -- define the "window" (group)
    ORDER BY col3 DESC        -- ordering within window
    ROWS BETWEEN ... AND ...  -- frame specification (optional)
)
```

### Ranking functions

```sql
SELECT
    id, branch_id, amount, created_at,

    -- Ranking (trong mỗi branch):
    ROW_NUMBER() OVER (PARTITION BY branch_id ORDER BY amount DESC)
        AS row_num,           -- unique, no ties: 1,2,3,4

    RANK() OVER (PARTITION BY branch_id ORDER BY amount DESC)
        AS rank_num,          -- ties get same rank, gaps: 1,1,3,4

    DENSE_RANK() OVER (PARTITION BY branch_id ORDER BY amount DESC)
        AS dense_rank,        -- ties same rank, no gaps: 1,1,2,3

    PERCENT_RANK() OVER (PARTITION BY branch_id ORDER BY amount DESC)
        AS pct_rank,          -- 0.0 to 1.0

    NTILE(4) OVER (PARTITION BY branch_id ORDER BY amount DESC)
        AS quartile           -- bucket into N groups (1,2,3,4)

FROM documents;
```

### Value functions (navigation)

```sql
SELECT
    id, branch_id, amount, created_at,

    -- Previous / next row:
    LAG(amount, 1, 0) OVER (PARTITION BY branch_id ORDER BY created_at)
        AS prev_amount,       -- previous row's amount (default 0 if none)

    LEAD(amount, 1, 0) OVER (PARTITION BY branch_id ORDER BY created_at)
        AS next_amount,       -- next row's amount

    -- First / last in window:
    FIRST_VALUE(amount) OVER (PARTITION BY branch_id ORDER BY created_at
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
        AS first_amount,

    LAST_VALUE(amount) OVER (PARTITION BY branch_id ORDER BY created_at
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
        AS last_amount,

    -- Nth value:
    NTH_VALUE(amount, 3) OVER (PARTITION BY branch_id ORDER BY created_at)
        AS third_amount

FROM documents;
```

### Aggregate as window (running totals, moving averages)

```sql
SELECT
    id, branch_id, amount, created_at,

    -- Running total (cumulative sum):
    SUM(amount) OVER (
        PARTITION BY branch_id
        ORDER BY created_at
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS running_total,

    -- 7-day moving average:
    AVG(amount) OVER (
        PARTITION BY branch_id
        ORDER BY created_at
        ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ) AS moving_avg_7d,

    -- Percentage of branch total:
    ROUND(
        amount * 100.0 /
        SUM(amount) OVER (PARTITION BY branch_id),
    2) AS pct_of_branch,

    -- Running count:
    COUNT(*) OVER (
        PARTITION BY branch_id
        ORDER BY created_at
    ) AS running_count

FROM documents
WHERE deleted_at IS NULL
ORDER BY branch_id, created_at;
```

### Frame specification

```
ROWS vs RANGE:
┌─────────────────────────────────────────────────────────────────┐
│  ROWS BETWEEN:  physical row offsets                             │
│  RANGE BETWEEN: logical value ranges (based on ORDER BY value)  │
│                                                                 │
│  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW               │
│      = từ đầu window đến row hiện tại                           │
│                                                                 │
│  ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING                       │
│      = 5-row sliding window (row-2 to row+2)                    │
│                                                                 │
│  RANGE BETWEEN INTERVAL '7 days' PRECEDING AND CURRENT ROW      │
│      = rows trong 7 ngày qua (theo ORDER BY timestamp)          │
│      Useful cho time-series với gaps!                            │
└─────────────────────────────────────────────────────────────────┘
```

```sql
-- Rolling 7-day sum by DATE (handles missing days correctly):
SELECT
    date_trunc('day', created_at) AS day,
    SUM(amount) AS daily_total,
    SUM(SUM(amount)) OVER (
        ORDER BY date_trunc('day', created_at)
        RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW
    ) AS rolling_7d_sum   -- RANGE: date-based, not row-based
FROM documents
GROUP BY date_trunc('day', created_at);
```

---

## 6. Oracle-specific

### LISTAGG — Oracle's STRING_AGG

```sql
-- Oracle: LISTAGG (equivalent to PostgreSQL STRING_AGG)
SELECT
    branch_id,
    LISTAGG(doc_number, ', ')
        WITHIN GROUP (ORDER BY created_at) AS doc_list
FROM documents
GROUP BY branch_id;

-- Oracle 19c+: LISTAGG DISTINCT (PostgreSQL STRING_AGG không có DISTINCT)
SELECT
    branch_id,
    LISTAGG(DISTINCT status, ', ')
        WITHIN GROUP (ORDER BY status) AS statuses
FROM documents
GROUP BY branch_id;
```

### RATIO_TO_REPORT — Oracle window function

```sql
-- Oracle only: percentage without manual division
SELECT
    branch_id,
    amount,
    RATIO_TO_REPORT(amount) OVER (PARTITION BY year) AS pct_of_year
    -- Equivalent PG: amount / SUM(amount) OVER (PARTITION BY year)
FROM sales;
```

### MODEL clause — Oracle spreadsheet-like

```sql
-- Oracle-only powerful feature for cross-row calculations
SELECT branch_id, year, revenue
FROM sales
MODEL
    PARTITION BY (branch_id)
    DIMENSION BY (year)
    MEASURES (revenue)
    RULES (
        revenue[2026] = revenue[2025] * 1.10,        -- project 10% growth
        revenue[2027] = revenue[2026] * 1.10
    );
-- No PostgreSQL equivalent — use recursive CTE or window functions instead
```

### MATCH_RECOGNIZE — Pattern matching (Oracle 12c+)

```sql
-- Find sequences of rows matching a pattern (financial patterns, state machines)
SELECT *
FROM transactions
MATCH_RECOGNIZE (
    PARTITION BY account_id
    ORDER BY txn_date
    MEASURES
        FIRST(txn_date) AS start_date,
        LAST(txn_date)  AS end_date,
        COUNT(*)        AS streak_length
    PATTERN (UP+ DOWN)              -- one or more increases followed by decrease
    DEFINE
        UP   AS amount > PREV(amount),
        DOWN AS amount < PREV(amount)
);
-- PostgreSQL alternative: complex window functions or application-level
```

---

## 7. Common Mistakes

### Mistake 1: SELECT column không có trong GROUP BY

```sql
-- ❌ ERROR hoặc wrong result:
SELECT branch_id, status, doc_number, COUNT(*)
FROM documents
GROUP BY branch_id;
-- Error: column "status" must appear in GROUP BY or be used in aggregate
-- (PostgreSQL strict — MySQL với ONLY_FULL_GROUP_BY OFF cho phép nhưng cho kết quả sai!)

-- ✅ Explicit về ý định:
SELECT branch_id, status, COUNT(*)
FROM documents
GROUP BY branch_id, status;

-- ✅ Nếu muốn "bất kỳ doc_number nào trong group":
SELECT branch_id, MIN(doc_number) AS sample_doc, COUNT(*)
FROM documents
GROUP BY branch_id;
```

### Mistake 2: HAVING vs WHERE

```sql
-- ❌ Dùng HAVING khi WHERE đủ dùng (HAVING chạy SAU aggregation):
SELECT branch_id, COUNT(*)
FROM documents
HAVING branch_id = 'HN01'  -- ← này filter trên toàn bộ data sau group!
GROUP BY branch_id;

-- ✅ WHERE lọc TRƯỚC aggregation (much faster):
SELECT branch_id, COUNT(*)
FROM documents
WHERE branch_id = 'HN01'   -- ← filter early, reduce rows aggregated
GROUP BY branch_id;

-- ✅ HAVING đúng use case: filter sau aggregate
SELECT branch_id, COUNT(*) AS cnt
FROM documents
GROUP BY branch_id
HAVING COUNT(*) > 100;  -- ← chỉ branches có > 100 documents
-- Không thể làm điều này với WHERE (COUNT chưa tính)
```

### Mistake 3: NULL trong GROUP BY

```sql
-- NULL trong GROUP key → NULL group (tất cả NULLs vào cùng group):
SELECT reviewer_id, COUNT(*)
FROM documents
GROUP BY reviewer_id;
-- reviewer_id = NULL → một group riêng với COUNT = số unreviewed docs

-- Thường unexpected — filter nếu không muốn:
WHERE reviewer_id IS NOT NULL

-- Hoặc COALESCE để nhóm NULL vào "N/A":
GROUP BY COALESCE(reviewer_id, -1)
```

### Mistake 4: Window function trong WHERE

```sql
-- ❌ Window functions không thể dùng trong WHERE (chạy sau):
SELECT id, branch_id, amount,
       RANK() OVER (PARTITION BY branch_id ORDER BY amount DESC) AS rnk
FROM documents
WHERE rnk <= 3;  -- ERROR: column "rnk" does not exist

-- ✅ Wrap in CTE hoặc subquery:
WITH ranked AS (
    SELECT id, branch_id, amount,
           RANK() OVER (PARTITION BY branch_id ORDER BY amount DESC) AS rnk
    FROM documents
)
SELECT * FROM ranked WHERE rnk <= 3;
```

### Mistake 5: LAST_VALUE frame mặc định

```sql
-- ❌ LAST_VALUE thường cho kết quả không expected:
SELECT id, amount,
    LAST_VALUE(amount) OVER (ORDER BY id) AS last_val
FROM docs;
-- → LAST_VALUE trả về chính amount của row hiện tại!
-- Vì frame mặc định là: RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
-- → "last" trong frame hiện tại = current row!

-- ✅ Specify full frame:
SELECT id, amount,
    LAST_VALUE(amount) OVER (
        ORDER BY id
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS last_val  -- ← now truly last value in entire partition
FROM docs;
```

---

## 8. Performance Tips

```sql
-- Tip 1: Pre-filter với WHERE trước GROUP BY
-- Bad:
SELECT branch_id, year, SUM(amount)
FROM documents
GROUP BY branch_id, year
HAVING year = 2026;  -- filter sau aggregate

-- Good:
SELECT branch_id, year, SUM(amount)
FROM documents
WHERE year = 2026       -- filter BEFORE aggregate
GROUP BY branch_id, year;

-- Tip 2: Partial aggregation với index
-- Nếu hay query COUNT per branch → partial index
CREATE INDEX idx_docs_branch_active ON documents(branch_id)
WHERE deleted_at IS NULL;
-- COUNT(*) WHERE deleted_at IS NULL GROUP BY branch_id → Index-Only Scan!

-- Tip 3: Increase work_mem để avoid disk spill
-- Check: EXPLAIN ANALYZE → "Batches: N" (N>1 = spilling)
SET work_mem = '128MB';  -- per-session

-- Tip 4: Materialized views cho expensive aggregations
CREATE MATERIALIZED VIEW mv_branch_daily_stats AS
SELECT
    branch_id,
    date_trunc('day', created_at) AS day,
    COUNT(*) AS doc_count,
    SUM(amount) AS total_amount,
    COUNT(*) FILTER (WHERE status='PENDING') AS pending_count
FROM documents
GROUP BY branch_id, date_trunc('day', created_at);

CREATE UNIQUE INDEX ON mv_branch_daily_stats(branch_id, day);
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_branch_daily_stats;

-- Tip 5: Avoid DISTINCT in aggregates (expensive hashing)
-- Nếu cần COUNT(DISTINCT reviewer_id) per branch trên 10M rows:
-- → Consider pre-aggregating or using HyperLogLog (pg_hll extension)
SELECT COUNT(DISTINCT reviewer_id) FROM docs WHERE branch_id='HN01';
-- → Exact but slow; approximate alternative:
-- SELECT hll_cardinality(hll_add_agg(hll_hash_bigint(reviewer_id)))
```

---

## Quick Reference

```sql
-- GROUP BY variants:
GROUP BY a, b                      -- standard
GROUP BY GROUPING SETS ((a,b),(a),(b),()) -- custom combinations
GROUP BY ROLLUP(a, b, c)           -- hierarchical: all prefixes
GROUP BY CUBE(a, b, c)             -- all 2^N combinations

-- Conditional aggregate:
COUNT(*) FILTER (WHERE condition)   -- PostgreSQL 9.4+

-- Percentile:
PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY col) -- median
PERCENTILE_CONT(ARRAY[0.25,0.5,0.75]) WITHIN GROUP (ORDER BY col) -- multiple

-- Window function frame:
ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW   -- cumulative
ROWS BETWEEN 6 PRECEDING AND CURRENT ROW           -- sliding N rows
RANGE BETWEEN INTERVAL '7 days' PRECEDING AND CURRENT ROW -- date-based

-- Top-N per group:
WITH ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY group_col ORDER BY val DESC) AS rn
    FROM table
)
SELECT * FROM ranked WHERE rn <= 3;
```

---

## Related Notes

- [[06-Query-Planner]] — HashAggregate và Sort strategies
- [[07-Count-Star-vs-Count-Column]] — COUNT internals và optimization
- [[14-CTE-Recursive-Advanced-SQL]] — CTE kết hợp với aggregation

---

*Tags: #postgresql #oracle #aggregation #groupby #window-functions #analytics*
*Created: 2026-05-07 | Difficulty: ⭐⭐⭐*
