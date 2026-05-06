# 14 — CTE, Recursive, INTERSECT, EXCEPT, Subquery: Powerful SQL Techniques

> **Audience:** Senior engineers muốn viết SQL elegant, maintainable, và performant.  
> **Scope:** CTE internals, recursive CTE, WITH, INTERSECT, EXCEPT, subquery patterns — PostgreSQL & Oracle.  
> **Liên kết:** [[06-Query-Planner]] | [[13-Grouping-and-Aggregation]] | [[00-PostgreSQL-Hub]]

---

## 📋 Mục lục

1. [CTE — Common Table Expressions](#1-cte--common-table-expressions)
2. [Materialization: Khi CTE là barrier, khi không](#2-materialization)
3. [Recursive CTE — Traversing hierarchies](#3-recursive-cte)
4. [INTERSECT và EXCEPT](#4-intersect-và-except)
5. [Subquery patterns — Correlated, Lateral, Scalar](#5-subquery-patterns)
6. [Oracle-specific features](#6-oracle-specific)
7. [Common Mistakes](#7-common-mistakes)
8. [Best Practices](#8-best-practices)

---

## 1. CTE — Common Table Expressions

CTE (WITH clause) là named subquery có thể tham chiếu nhiều lần, làm code readable hơn và đôi khi performant hơn.

```sql
-- Basic CTE syntax:
WITH cte_name AS (
    SELECT ...
),
another_cte AS (           -- multiple CTEs, can reference previous ones
    SELECT ... FROM cte_name
)
SELECT * FROM another_cte;
```

### CTE vs Subquery vs Temp Table

```
┌──────────────────────────────────────────────────────────────────────┐
│                    CTE vs Subquery vs Temp Table                      │
│                                                                      │
│  CTE (WITH):                                                         │
│  ✓ Named → readable, reusable in same query                          │
│  ✓ PG 12+: may be inlined by planner (performance benefit)           │
│  ✓ Can be recursive                                                  │
│  ✗ PG < 12: always materialized (optimization barrier)               │
│  ✗ Cannot index a CTE result                                         │
│                                                                      │
│  Subquery (inline):                                                  │
│  ✓ Always inlined → planner can optimize across                      │
│  ✓ No materialization overhead                                       │
│  ✗ Hard to read when nested > 2 levels                               │
│  ✗ Cannot reuse (would be repeated)                                  │
│                                                                      │
│  Temp Table:                                                         │
│  ✓ Can CREATE INDEX on temp table → optimize joins                   │
│  ✓ Reuse across multiple queries in session                          │
│  ✗ DDL overhead (CREATE, DROP)                                       │
│  ✗ Not composable in single statement                                │
└──────────────────────────────────────────────────────────────────────┘
```

### Real-world CTE example — PDMS document pipeline

```sql
-- Find documents that need escalation (pending > 3 days, no reviewer)
WITH overdue_docs AS (
    SELECT id, branch_id, doc_number, created_at, amount
    FROM documents
    WHERE status = 'PENDING'
      AND created_at < NOW() - INTERVAL '3 days'
      AND deleted_at IS NULL
),
branch_managers AS (
    SELECT branch_id, user_id AS manager_id, email
    FROM branch_staff
    WHERE role = 'MANAGER' AND is_active = TRUE
),
escalation_needed AS (
    SELECT
        od.id,
        od.branch_id,
        od.doc_number,
        od.created_at,
        od.amount,
        bm.manager_id,
        bm.email,
        EXTRACT(DAY FROM NOW() - od.created_at) AS days_pending
    FROM overdue_docs od
    LEFT JOIN branch_managers bm ON bm.branch_id = od.branch_id
)
SELECT *
FROM escalation_needed
WHERE manager_id IS NOT NULL   -- has someone to escalate to
ORDER BY days_pending DESC, amount DESC;
```

### Writable CTE (WITH ... INSERT/UPDATE/DELETE)

```sql
-- CTE có thể chứa data-modifying statements!
WITH
moved_docs AS (
    DELETE FROM active_documents
    WHERE created_at < NOW() - INTERVAL '2 years'
    RETURNING *    -- capture deleted rows
),
archived AS (
    INSERT INTO archive_documents
    SELECT * FROM moved_docs
    RETURNING id
)
SELECT COUNT(*) AS archived_count FROM archived;
-- → Atomic: move + archive in single transaction
```

---

## 2. Materialization

Đây là điều **quan trọng nhất** cần hiểu về CTE performance:

```
┌──────────────────────────────────────────────────────────────────────┐
│              CTE Materialization Behavior                             │
│                                                                      │
│  PostgreSQL < 12:                                                    │
│    CTE luôn là "optimization fence" → ALWAYS materialized            │
│    → Planner không thể push predicates INTO CTE                      │
│    → CTE result stored in memory → then outer query filters          │
│                                                                      │
│  PostgreSQL >= 12:                                                   │
│    CTE có thể được INLINED (not materialized) nếu:                   │
│    1. Non-recursive                                                  │
│    2. No side effects (no INSERT/UPDATE/DELETE/RETURNING)            │
│    3. Referenced exactly once in query                               │
│                                                                      │
│  Explicit control (PG 12+):                                          │
│    WITH cte AS MATERIALIZED (...)     ← force materialization        │
│    WITH cte AS NOT MATERIALIZED (...)  ← force inline                │
└──────────────────────────────────────────────────────────────────────┘
```

```sql
-- Example: predicate pushdown bị block bởi materialization
WITH active_docs AS MATERIALIZED (
    SELECT * FROM documents WHERE deleted_at IS NULL
    -- CTE materializes ALL active docs: 5M rows
)
SELECT * FROM active_docs WHERE branch_id = 'HN01';
-- → Filter branch_id='HN01' applied AFTER materializing 5M rows!
-- Execution: 3000ms

WITH active_docs AS NOT MATERIALIZED (
    SELECT * FROM documents WHERE deleted_at IS NULL
)
SELECT * FROM active_docs WHERE branch_id = 'HN01';
-- → Planner combines: WHERE deleted_at IS NULL AND branch_id='HN01'
-- → Uses index on branch_id → 200ms
```

### Khi nào nên MATERIALIZED?

```sql
-- ✅ Dùng MATERIALIZED khi CTE referenced nhiều lần:
WITH expensive_calc AS MATERIALIZED (
    SELECT user_id, SUM(amount) AS total,
           COUNT(*) AS count,
           MAX(created_at) AS last_activity
    FROM transactions
    WHERE created_at > NOW() - INTERVAL '1 year'
    GROUP BY user_id   -- expensive aggregation
)
SELECT u.name, ec.total, ec.count
FROM users u
JOIN expensive_calc ec ON u.id = ec.user_id
WHERE ec.total > 10000
-- + another reference
UNION ALL
SELECT 'summary', SUM(ec2.total), SUM(ec2.count)
FROM expensive_calc ec2;  -- referenced 2nd time → materialized only ONCE!
-- Without MATERIALIZED: aggregation would run TWICE!
```

---

## 3. Recursive CTE

Recursive CTE là cách SQL xử lý **hierarchical data** — org charts, folder trees, bill of materials, graph traversal.

### Structure

```sql
WITH RECURSIVE cte_name AS (
    -- Anchor member (base case, non-recursive):
    SELECT ...

    UNION ALL  -- (UNION ALL is almost always correct; UNION adds dedup overhead)

    -- Recursive member (references cte_name):
    SELECT ... FROM source_table JOIN cte_name ON ...
    -- ⚠️ MUST have a termination condition or PostgreSQL will loop forever!
)
SELECT * FROM cte_name;
```

### Use case 1: Org chart / Hierarchy traversal

```sql
-- Table: employees(id, name, manager_id, department)
-- Find all reports under a given manager (any depth):

WITH RECURSIVE org_chart AS (
    -- Anchor: start with target manager
    SELECT id, name, manager_id, department, 0 AS depth, name AS path
    FROM employees
    WHERE id = :manager_id

    UNION ALL

    -- Recursive: find their direct reports
    SELECT e.id, e.name, e.manager_id, e.department,
           oc.depth + 1,
           oc.path || ' → ' || e.name    -- build path string
    FROM employees e
    JOIN org_chart oc ON e.manager_id = oc.id
    WHERE oc.depth < 10   -- safety guard against cycles!
)
SELECT id, name, department, depth, path
FROM org_chart
ORDER BY depth, name;
```

```
Output visualization:
depth=0: Alice (Manager)
depth=1:   Bob (reports to Alice)
depth=1:   Carol (reports to Alice)
depth=2:     Dave (reports to Bob)
depth=2:     Eve (reports to Carol)
```

### Use case 2: Document folder tree (PDMS)

```sql
-- Table: folders(id, name, parent_id, branch_id)
-- Get full path of a folder:

WITH RECURSIVE folder_path AS (
    SELECT id, name, parent_id, 1 AS level,
           ARRAY[name] AS path_array
    FROM folders WHERE id = :target_folder_id

    UNION ALL

    SELECT f.id, f.name, f.parent_id, fp.level + 1,
           ARRAY[f.name] || fp.path_array    -- prepend parent
    FROM folders f
    JOIN folder_path fp ON f.id = fp.parent_id
)
SELECT
    array_to_string(path_array, ' / ') AS full_path,
    level AS depth
FROM folder_path
ORDER BY level DESC LIMIT 1;   -- deepest = full path from root
```

### Use case 3: Graph traversal (shortest path sketch)

```sql
-- Find all routes between two cities up to 3 hops:
WITH RECURSIVE routes AS (
    SELECT from_city, to_city, distance,
           ARRAY[from_city, to_city] AS visited,
           1 AS hops
    FROM connections
    WHERE from_city = 'Hanoi'

    UNION ALL

    SELECT c.from_city, c.to_city, r.distance + c.distance,
           r.visited || c.to_city,
           r.hops + 1
    FROM connections c
    JOIN routes r ON c.from_city = r.to_city
    WHERE c.to_city != ALL(r.visited)  -- prevent cycles!
      AND r.hops < 3
)
SELECT * FROM routes
WHERE to_city = 'Ho Chi Minh City'
ORDER BY distance;
```

### Use case 4: Generate series / Date spine

```sql
-- Generate a series of dates (no gaps for reporting):
WITH RECURSIVE date_series AS (
    SELECT '2026-01-01'::DATE AS dt
    UNION ALL
    SELECT dt + 1 FROM date_series WHERE dt < '2026-12-31'
)
SELECT ds.dt, COALESCE(d.doc_count, 0) AS doc_count
FROM date_series ds
LEFT JOIN (
    SELECT DATE(created_at) AS day, COUNT(*) AS doc_count
    FROM documents GROUP BY DATE(created_at)
) d ON d.day = ds.dt;
-- → Fills gaps with 0 (no missing dates in report)

-- Alternative: PostgreSQL built-in generate_series (faster):
SELECT
    gs.day,
    COALESCE(d.doc_count, 0) AS doc_count
FROM generate_series('2026-01-01'::DATE, '2026-12-31', '1 day') AS gs(day)
LEFT JOIN (...) d ON d.day = gs.day;
```

### Cycle detection

```sql
-- PostgreSQL 14+: built-in cycle detection
WITH RECURSIVE tree AS (
    SELECT id, parent_id, name, FALSE AS is_cycle,
           ARRAY[id] AS path
    FROM nodes WHERE parent_id IS NULL

    UNION ALL

    SELECT n.id, n.parent_id, n.name,
           n.id = ANY(t.path),   -- cycle if id already in path
           t.path || n.id
    FROM nodes n
    JOIN tree t ON n.parent_id = t.id
    WHERE NOT t.is_cycle
)
CYCLE id SET is_cycle USING path  -- PG14+ syntax (cleaner)
SELECT * FROM tree WHERE NOT is_cycle;
```

---

## 4. INTERSECT và EXCEPT

### INTERSECT — Rows present in BOTH results

```sql
-- Find users who BOTH placed orders AND wrote reviews:
SELECT user_id FROM orders
INTERSECT
SELECT user_id FROM reviews;

-- vs JOIN approach (often same performance):
SELECT DISTINCT o.user_id
FROM orders o
JOIN reviews r ON o.user_id = r.user_id;

-- INTERSECT ALL — keep duplicates (rare use case):
SELECT product_id FROM orders_2025
INTERSECT ALL
SELECT product_id FROM orders_2026;
```

```
Visual:
Orders:   {1, 2, 3, 4, 5}
Reviews:  {3, 4, 5, 6, 7}
INTERSECT: {3, 4, 5}       ← both sets
```

### EXCEPT — Rows in first but NOT in second (set difference)

```sql
-- Find users who ordered but NEVER reviewed:
SELECT user_id FROM orders
EXCEPT
SELECT user_id FROM reviews;

-- EXCEPT is powerful for:
-- 1. Finding "missing" records:
SELECT expected_id FROM expected_documents
EXCEPT
SELECT id FROM actual_documents;
-- → Documents that should exist but don't!

-- 2. Comparing table contents (data diff):
SELECT * FROM documents_v1
EXCEPT
SELECT * FROM documents_v2;
-- Rows in v1 but changed/removed in v2
```

```
Visual:
Orders:   {1, 2, 3, 4, 5}
Reviews:  {3, 4, 5, 6, 7}
EXCEPT:    {1, 2}           ← in Orders but not Reviews
```

### EXCEPT vs NOT IN vs NOT EXISTS

```sql
-- Three ways to express "not in":
-- (1) EXCEPT:
SELECT user_id FROM orders
EXCEPT
SELECT user_id FROM reviews;

-- (2) NOT IN (DANGEROUS with NULLs!):
SELECT DISTINCT user_id FROM orders
WHERE user_id NOT IN (SELECT user_id FROM reviews);
-- ⚠️ If reviews has any NULL user_id → returns 0 rows! (SQL NULL logic)

-- (3) NOT EXISTS (safe, often fastest):
SELECT DISTINCT o.user_id FROM orders o
WHERE NOT EXISTS (
    SELECT 1 FROM reviews r WHERE r.user_id = o.user_id
);

-- Performance comparison:
-- EXCEPT:     dedup + hash match → O(N+M), uses hash table
-- NOT EXISTS: one index lookup per outer row → fast with index
-- NOT IN:     AVOID (NULL trap, may plan poorly)
```

---

## 5. Subquery patterns

### Scalar subquery

```sql
-- Returns single value, used anywhere an expression is expected:
SELECT
    id,
    doc_number,
    amount,
    (SELECT AVG(amount) FROM documents WHERE branch_id = d.branch_id)
        AS branch_avg,         -- correlated scalar subquery
    amount - (SELECT AVG(amount) FROM documents WHERE branch_id = d.branch_id)
        AS deviation_from_avg
FROM documents d;

-- ⚠️ Correlated scalar subquery = O(N) executions → often slow!
-- ✅ Better with window function:
SELECT
    id, doc_number, amount,
    AVG(amount) OVER (PARTITION BY branch_id) AS branch_avg,
    amount - AVG(amount) OVER (PARTITION BY branch_id) AS deviation
FROM documents;
```

### LATERAL subquery (PostgreSQL / Oracle 12c+)

LATERAL cho phép subquery tham chiếu columns từ outer query — như correlated subquery nhưng trong FROM clause:

```sql
-- Get top 3 most recent documents per branch:
SELECT b.branch_id, b.name, d.id, d.doc_number, d.created_at
FROM branches b
CROSS JOIN LATERAL (
    SELECT id, doc_number, created_at
    FROM documents
    WHERE branch_id = b.branch_id    -- ← references outer table!
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 3
) d;

-- Without LATERAL: would need ROW_NUMBER() window function
-- LATERAL is cleaner when: limit-per-group, function per row, unnest
```

```sql
-- LATERAL with function (expand each row's array):
SELECT u.id, u.name, tag
FROM users u
CROSS JOIN LATERAL UNNEST(u.tags) AS tag;
-- → One row per tag per user

-- LATERAL for running stats:
SELECT d.branch_id, d.id, d.amount, stats.cumulative_sum
FROM documents d
CROSS JOIN LATERAL (
    SELECT SUM(amount) AS cumulative_sum
    FROM documents
    WHERE branch_id = d.branch_id
      AND created_at <= d.created_at
) stats;
```

### EXISTS vs IN — When to use which

```sql
-- EXISTS: semi-join, short-circuits, index-friendly
SELECT * FROM documents d
WHERE EXISTS (
    SELECT 1 FROM comments c WHERE c.doc_id = d.id
);
-- → Stops at first match, uses index on comments(doc_id)

-- IN: good for small static lists or non-correlated subquery
SELECT * FROM documents
WHERE branch_id IN ('HN01', 'SG01', 'HN02');  -- static list → fine

SELECT * FROM documents
WHERE branch_id IN (SELECT branch_id FROM active_branches);
-- → PostgreSQL may convert to semi-join (check EXPLAIN)

-- ❌ IN with nullable column in subquery:
WHERE id NOT IN (SELECT nullable_col FROM other_table);
-- If nullable_col has ANY NULL → returns empty set! Always use NOT EXISTS
```

---

## 6. Oracle-specific

### CONNECT BY — Oracle's recursive query (pre-SQL:1999)

```sql
-- Oracle proprietary (older than CTE RECURSIVE):
SELECT
    id, name, manager_id,
    LEVEL,
    SYS_CONNECT_BY_PATH(name, ' → ') AS path,
    CONNECT_BY_ISLEAF AS is_leaf,
    CONNECT_BY_ISCYCLE AS is_cycle
FROM employees
START WITH manager_id IS NULL    -- root condition
CONNECT BY NOCYCLE PRIOR id = manager_id   -- traversal condition
ORDER SIBLINGS BY name;

-- CONNECT BY still used in Oracle, but RECURSIVE CTE is portable
-- PostgreSQL: use RECURSIVE CTE (shown in section 3)
```

### Oracle PIVOT / UNPIVOT

```sql
-- Oracle built-in PIVOT (PostgreSQL needs crosstab extension):
SELECT * FROM (
    SELECT branch_id, status, COUNT(*) AS cnt FROM documents
    GROUP BY branch_id, status
)
PIVOT (
    SUM(cnt)
    FOR status IN ('PENDING' AS pending, 'ACTIVE' AS active, 'DONE' AS done)
);
-- → Columns: branch_id | pending | active | done

-- PostgreSQL equivalent using FILTER:
SELECT
    branch_id,
    COUNT(*) FILTER (WHERE status='PENDING') AS pending,
    COUNT(*) FILTER (WHERE status='ACTIVE') AS active,
    COUNT(*) FILTER (WHERE status='DONE') AS done
FROM documents
GROUP BY branch_id;
```

### Oracle UNPIVOT

```sql
-- Oracle UNPIVOT: turn columns → rows
SELECT branch_id, metric_name, metric_value
FROM branch_stats
UNPIVOT (
    metric_value
    FOR metric_name IN (pending AS 'PENDING', active AS 'ACTIVE', done AS 'DONE')
);

-- PostgreSQL equivalent using UNION ALL or VALUES:
SELECT branch_id, 'PENDING' AS metric, pending AS value FROM branch_stats
UNION ALL
SELECT branch_id, 'ACTIVE', active FROM branch_stats
UNION ALL
SELECT branch_id, 'DONE', done FROM branch_stats;
```

---

## 7. Common Mistakes

### Mistake 1: Recursive CTE without depth limit → infinite loop

```sql
-- ❌ Sẽ loop mãi nếu có cycle trong data:
WITH RECURSIVE tree AS (
    SELECT id, parent_id FROM categories WHERE parent_id IS NULL
    UNION ALL
    SELECT c.id, c.parent_id FROM categories c
    JOIN tree t ON c.parent_id = t.id
    -- No cycle check!
)
SELECT * FROM tree;  -- hang forever nếu có cycle!

-- ✅ Always add depth guard:
WHERE oc.depth < 50   -- max depth
-- AND id != ALL(path)  -- cycle detection
```

### Mistake 2: CTE as performance fix (PG < 12)

```sql
-- ❌ Dùng CTE thinking it optimizes (PG < 12: CTE always materialized):
-- Old advice: "wrap in CTE to help planner"
-- PG < 12: CTE is optimization BARRIER, not help!

-- ✅ PG 12+: default inline unless has side effects or referenced > 1 time
-- Use EXPLAIN to verify planner's choice
```

### Mistake 3: EXCEPT semantics misunderstood

```sql
-- EXCEPT removes ALL duplicates, not just matched ones:
SELECT 1 UNION ALL SELECT 1    -- returns: 1, 1 (two rows)
EXCEPT
SELECT 2;                       -- removes nothing? No!
-- Returns: 1 (deduplicated! EXCEPT implies DISTINCT)

-- EXCEPT ALL (preserves duplicates minus matched count):
SELECT 1 UNION ALL SELECT 1
EXCEPT ALL
SELECT 1;  -- Returns: 1 (one copy remains)
```

### Mistake 4: Lateral vs Cross Join confusion

```sql
-- LATERAL: subquery per outer row → correct
-- CROSS JOIN (non-LATERAL): subquery runs once → wrong for per-row logic

-- ❌ Wrong: subquery doesn't see outer row
SELECT b.branch_id, d.*
FROM branches b
CROSS JOIN (
    SELECT * FROM documents WHERE branch_id = b.branch_id LIMIT 3
    -- ↑ ERROR: b.branch_id not visible here
) d;

-- ✅ Correct with LATERAL:
SELECT b.branch_id, d.*
FROM branches b
CROSS JOIN LATERAL (
    SELECT * FROM documents WHERE branch_id = b.branch_id LIMIT 3
) d;
```

---

## 8. Best Practices

```
CTE Best Practices:
1. Use CTE for readability when query has > 3 logical steps
2. Use MATERIALIZED explicitly when CTE referenced > 1 time
3. Use NOT MATERIALIZED when predicate pushdown matters (PG 12+)
4. Prefer generate_series() over recursive CTE for number/date series
5. Always add depth limit to recursive CTEs

INTERSECT/EXCEPT:
6. Prefer NOT EXISTS over NOT IN (NULL safety)
7. Use EXCEPT for data comparison/diff (powerful and readable)
8. INTERSECT/EXCEPT imply DISTINCT → use ALL variants if duplicates needed

Subquery:
9. Replace correlated scalar subqueries with window functions
10. Use LATERAL for top-N-per-group (cleaner than ROW_NUMBER approach)
11. EXISTS is generally faster than IN for correlated checks

General:
12. Always EXPLAIN your CTEs — check if materialized when you don't want
13. Recursive CTE: test with small data, add cycle guards from day 1
```

---

## Related Notes

- [[06-Query-Planner]] — How planner handles CTE materialization
- [[13-Grouping-and-Aggregation]] — Window functions và aggregation patterns
- [[03-Concurrency-Patterns]] — CTE trong context của transactions

---

*Tags: #postgresql #oracle #cte #recursive #intersect #except #subquery #lateral*
*Created: 2026-05-07 | Difficulty: ⭐⭐⭐⭐*
