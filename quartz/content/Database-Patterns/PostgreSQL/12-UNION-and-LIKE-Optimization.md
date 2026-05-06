# 12 — Tối Ưu UNION và LIKE Search

> **Audience:** Backend engineers cần tối ưu queries dùng UNION và LIKE trong production.  
> **Scope:** UNION vs UNION ALL, khi nào dùng mỗi loại, full-text search, trigram, tối ưu LIKE pattern.  
> **Liên kết:** [[04-Index-Internals]] | [[06-Query-Planner]] | [[00-PostgreSQL-Hub]]

---

## 📋 Mục lục

**Phần A — UNION Optimization**
1. [UNION vs UNION ALL — Sự khác biệt tốn kém](#a1-union-vs-union-all)
2. [Khi nào UNION, khi nào UNION ALL](#a2-khi-nào-dùng-gì)
3. [Anti-patterns và rewrites](#a3-anti-patterns-và-rewrites)
4. [UNION vs OR — Planner implications](#a4-union-vs-or)

**Phần B — LIKE Search Optimization**
5. [Tại sao LIKE chậm và index không giúp được](#b1-tại-sao-like-chậm)
6. [pg_trgm — Trigram index cho LIKE](#b2-pgtrgm)
7. [Full-Text Search — Powerful nhưng khác ngữ nghĩa](#b3-full-text-search)
8. [Strategy chọn loại search](#b4-strategy)

---

# PHẦN A — UNION OPTIMIZATION

## A1. UNION vs UNION ALL

```
┌──────────────────────────────────────────────────────────────────────┐
│                    UNION vs UNION ALL                                 │
│                                                                      │
│  UNION:                                                              │
│  ┌──────────┐    ┌──────────┐                                        │
│  │ Result A │    │ Result B │                                        │
│  │ {1,2,3}  │ ++ │ {2,3,4}  │ → SORT + DEDUP → {1,2,3,4}           │
│  └──────────┘    └──────────┘                                        │
│  Steps:                                                              │
│  1. Execute query A                                                  │
│  2. Execute query B                                                  │
│  3. COMBINE results                                                  │
│  4. SORT (to find duplicates)                                        │
│  5. REMOVE DUPLICATES (HashAggregate or Sort)                        │
│  Cost: O(N log N) + I/O cho sort                                     │
│                                                                      │
│  UNION ALL:                                                          │
│  ┌──────────┐    ┌──────────┐                                        │
│  │ Result A │    │ Result B │                                        │
│  │ {1,2,3}  │ ++ │ {2,3,4}  │ → CONCATENATE → {1,2,3,2,3,4}        │
│  └──────────┘    └──────────┘                                        │
│  Steps:                                                              │
│  1. Execute query A                                                  │
│  2. Execute query B                                                  │
│  3. CONCATENATE (no sort, no dedup)                                  │
│  Cost: O(N) — just stream results                                    │
└──────────────────────────────────────────────────────────────────────┘
```

### Benchmark

```sql
-- Setup: 2 tables, 1M rows each, ~20% overlap
CREATE TABLE docs_active AS SELECT id FROM generate_series(1, 1000000) id;
CREATE TABLE docs_archive AS SELECT id FROM generate_series(800001, 1800000) id;

-- UNION (with dedup)
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM docs_active
UNION
SELECT id FROM docs_archive;
-- Sort (cost=...) Memory: 89MB  ← sort to dedup!
-- Execution Time: 2340ms

-- UNION ALL (no dedup)
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM docs_active
UNION ALL
SELECT id FROM docs_archive;
-- Append (cost=...) ← just append, no sort!
-- Execution Time: 189ms  ← 12x faster!
```

---

## A2. Khi nào dùng gì

```
Dùng UNION ALL khi:
  ✓ Bạn BIẾT hai queries không có duplicates
    (ví dụ: partition by date range, by status)
  ✓ Bạn muốn giữ duplicates (ví dụ: log entries)
  ✓ Bạn sẽ aggregate anyway (COUNT, SUM, GROUP BY)
    → Dedup ở UNION level là waste nếu aggregate sau đó
  ✓ Performance quan trọng

Dùng UNION khi:
  ✓ Bạn cần distinct results và không chắc có duplicates
  ✓ Business logic yêu cầu unique results
  ✓ Two sources có thể overlap (ví dụ: search by name OR email)

Rules of thumb:
  → Mặc định nên dùng UNION ALL
  → Chỉ đổi sang UNION khi cần dedup theo business requirement
  → Nếu dùng UNION rồi GROUP BY → luôn đổi sang UNION ALL
```

### Ví dụ điển hình — Partition queries

```sql
-- ✅ UNION ALL đúng: partitions không overlap
SELECT id, title, created_at FROM documents_2024
WHERE branch_id = 'HN01'
UNION ALL
SELECT id, title, created_at FROM documents_2025
WHERE branch_id = 'HN01'
ORDER BY created_at DESC
LIMIT 20;

-- ✓ Safe vì documents_2024 và documents_2025 không thể có cùng row
-- ✓ Nếu dùng native partitioning → PostgreSQL tự handle, không cần UNION
```

---

## A3. Anti-patterns và rewrites

### Anti-pattern 1: UNION để thay thế OR (thường sai)

```sql
-- ❌ Dùng UNION khi OR đơn giản hơn và tốt hơn
SELECT * FROM documents WHERE status = 'PENDING'
UNION
SELECT * FROM documents WHERE branch_id = 'HN01';
-- → Sort + Dedup trên potentially large result set

-- ✅ Rewrite với OR + DISTINCT (nếu cần dedup)
SELECT DISTINCT * FROM documents
WHERE status = 'PENDING' OR branch_id = 'HN01';

-- ✅ Hoặc nếu indexes khác nhau → UNION ALL rõ ràng hơn:
SELECT * FROM documents WHERE status = 'PENDING'
UNION ALL
SELECT * FROM documents WHERE branch_id = 'HN01'
  AND status != 'PENDING';  -- exclude duplicates manually
-- → Dedup bằng logic, không phải expensive SORT
```

### Anti-pattern 2: UNION trước GROUP BY

```sql
-- ❌ UNION dedup tốn kém rồi bị GROUP BY aggregate anyway
SELECT branch_id, COUNT(*) FROM (
    SELECT branch_id, id FROM active_docs
    UNION  -- ← expensive dedup!
    SELECT branch_id, id FROM pending_docs
) combined
GROUP BY branch_id;

-- ✅ UNION ALL → GROUP BY handles duplicates anyway via aggregation
SELECT branch_id, COUNT(*) FROM (
    SELECT branch_id, id FROM active_docs
    UNION ALL  -- ← cheap concatenation
    SELECT branch_id, id FROM pending_docs
) combined
GROUP BY branch_id;
-- Nếu id thực sự unique across both tables → COUNT(*) vẫn đúng
-- Nếu không unique → COUNT(DISTINCT id) nếu cần
```

### Anti-pattern 3: UNION trong subquery lặp

```sql
-- ❌ UNION chạy nhiều lần trong correlated subquery
SELECT d.id, d.title,
  (SELECT COUNT(*) FROM (
      SELECT id FROM active_docs WHERE doc_ref = d.id
      UNION
      SELECT id FROM archive_docs WHERE doc_ref = d.id
   ) sub) AS ref_count
FROM documents d;

-- ✅ Rewrite với LEFT JOIN + aggregation (single pass)
SELECT d.id, d.title,
  COUNT(DISTINCT COALESCE(a.id, ar.id)) AS ref_count
FROM documents d
LEFT JOIN active_docs a ON a.doc_ref = d.id
LEFT JOIN archive_docs ar ON ar.doc_ref = d.id
GROUP BY d.id, d.title;
```

---

## A4. UNION vs OR — Planner implications

```sql
-- OR trong WHERE: planner có thể không dùng indexes hiệu quả
SELECT * FROM documents
WHERE status = 'PENDING' OR reviewer_id = 456;
-- → BitmapOr (nếu cả hai indexed) hoặc Seq Scan

-- UNION ALL: mỗi branch dùng index riêng → hiệu quả hơn với selective conditions
SELECT * FROM documents WHERE status = 'PENDING'
UNION ALL
SELECT * FROM documents WHERE reviewer_id = 456
  AND status != 'PENDING';  -- tránh duplicate

-- Khi nào UNION ALL tốt hơn OR?
-- → Khi hai conditions rất selective và có separate indexes
-- → EXPLAIN ANALYZE để verify
```

---

# PHẦN B — LIKE SEARCH OPTIMIZATION

## B1. Tại sao LIKE chậm

```
┌──────────────────────────────────────────────────────────────────────┐
│                    LIKE Pattern Types                                 │
│                                                                      │
│  Pattern          │ Index usable? │ Reason                           │
│  ─────────────────┼───────────────┼────────────────────────────── │
│  'abc%'           │ ✓ Yes (B-Tree)│ Prefix search: sort order helps  │
│  'abc%def'        │ ✓ Partial     │ Prefix part uses index            │
│  '%abc'           │ ✗ No          │ No prefix → can't use B-Tree sort │
│  '%abc%'          │ ✗ No          │ No prefix → full scan             │
│  'a_c'            │ ✓ Partial     │ Prefix 'a' uses index            │
│                                                                      │
│  B-Tree index: lưu data SORTED                                       │
│  'hợp đồng%' → find first 'hợp đồng' → scan forward               │
│  '%hợp đồng' → unknown start → must scan ALL entries                │
└──────────────────────────────────────────────────────────────────────┘
```

### Prefix LIKE — An toàn với B-Tree

```sql
-- ✓ B-Tree index ĐƯỢC dùng:
CREATE INDEX idx_docs_number ON documents(doc_number);

SELECT * FROM documents WHERE doc_number LIKE 'HN2026%';
-- EXPLAIN: Index Scan using idx_docs_number
-- → Efficient! B-Tree tìm 'HN2026' rồi scan forward

-- ⚠️ Cần phải là C locale hoặc COLLATE "C":
-- Nếu database dùng UTF-8 locale → planner có thể không dùng index!
CREATE INDEX idx_docs_number_c ON documents(doc_number COLLATE "C");
-- Hoặc: CREATE INDEX idx_docs_number ON documents(doc_number text_pattern_ops);
-- text_pattern_ops: enables LIKE/ILIKE with B-Tree
```

### Leading wildcard — Không tránh được full scan với B-Tree

```sql
-- ✗ Full table scan:
SELECT * FROM documents WHERE title LIKE '%hợp đồng%';
-- EXPLAIN: Seq Scan → Filter → Rows Removed by Filter: 4.9M
-- Execution: 8000ms trên 5M rows
```

---

## B2. pg_trgm — Trigram Index

**Trigram:** Chia text thành các chuỗi 3 ký tự liên tiếp.

```
"hợp đồng" → trigrams:
  "  h", " hợ", "hợp", "ợp ", "p đ", " đồ", "đồn", "ồng", "ng "

Inverted index:
  "hợp" → [doc_id: 1, 5, 23, 45, ...]
  "đồng" → [doc_id: 1, 8, 23, 67, ...]

Query "hợp đồng" → intersect posting lists → {1, 23, ...}
→ Chỉ fetch những docs có cả hai trigrams
```

```sql
-- Setup
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Index cho LIKE/ILIKE với leading wildcard
CREATE INDEX idx_docs_title_trgm ON documents USING GIN(title gin_trgm_ops);

-- Tương tự cho doc_number, full content
CREATE INDEX idx_docs_number_trgm ON documents USING GIN(doc_number gin_trgm_ops);

-- Queries được hỗ trợ:
SELECT * FROM documents WHERE title LIKE '%hợp đồng%';
SELECT * FROM documents WHERE title ILIKE '%HỢP ĐỒNG%';  -- case-insensitive
SELECT * FROM documents WHERE title SIMILAR TO '%(hợp|thuê)%';
SELECT * FROM documents WHERE title ~ 'hợp.đồng';  -- regex

-- EXPLAIN: Bitmap Heap Scan → Bitmap Index Scan using idx_docs_title_trgm
-- → Từ 8000ms xuống 45ms! (giảm 99%)
```

### Giới hạn của trigram

```
✓ Tốt cho: tiếng Anh, chuỗi alphanumeric
✓ Hoạt động: tiếng Việt (utf8)
✗ Kém hiệu quả khi: pattern ngắn (< 3 ký tự)
  WHERE title LIKE '%AB%' → chỉ 1 trigram 'AB ' → kém selective → slow
  WHERE title LIKE '%A%'  → 0 trigrams → full scan

✗ Không biết "word boundaries": 'hợp' match trong 'chuyển hợp đồng'
  nhưng cũng match trong 'họp mặt nhóm' (nếu có trigram overlap)

Minimum useful pattern: ~4+ ký tự
```

### Similarity search với trigram

```sql
-- Tìm documents "tương tự" về title (fuzzy match)
SELECT title, similarity(title, 'hợp đồng vay') AS sim
FROM documents
WHERE similarity(title, 'hợp đồng vay') > 0.3
ORDER BY sim DESC
LIMIT 10;

-- Index để tăng tốc:
SET pg_trgm.similarity_threshold = 0.3;
SELECT * FROM documents WHERE title % 'hợp đồng vay';  -- % operator

-- Use case: typo tolerance, fuzzy search
```

---

## B3. Full-Text Search

Full-Text Search (FTS) khác với LIKE về **ngữ nghĩa**:
- LIKE: pattern match trên raw string
- FTS: tokenize, stemming, stop words, ranking

```
┌──────────────────────────────────────────────────────────────────────┐
│                 FTS vs LIKE/Trigram Comparison                        │
│                                                                      │
│  Feature              │ LIKE + Trigram  │ Full-Text Search           │
│  ─────────────────────┼─────────────────┼─────────────────────────  │
│  Exact substring      │ ✓ Yes           │ ✗ No (tokenized)           │
│  Stemming             │ ✗ No            │ ✓ Yes (run=running=ran)    │
│  Stop words           │ ✗ No            │ ✓ Yes ('the','a' ignored)  │
│  Ranking/relevance    │ ✗ No            │ ✓ Yes (ts_rank)            │
│  Vietnamese support   │ ✓ Works         │ ⚠️ Limited (no dictionaries)│
│  Exact phrase         │ ✓ Yes           │ ✓ With <-> operator        │
│  Speed                │ Fast (index)    │ Faster (specialized index) │
└──────────────────────────────────────────────────────────────────────┘
```

### FTS implementation

```sql
-- Tạo tsvector column (generated):
ALTER TABLE documents ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', COALESCE(doc_number, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(title, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(description, '')), 'C')
    ) STORED;
-- Dùng 'simple' dict (không stemming) → tốt hơn cho tiếng Việt

CREATE INDEX idx_docs_fts ON documents USING GIN(search_vector);

-- Query:
SELECT id, title, ts_rank(search_vector, query) AS rank
FROM documents,
     to_tsquery('simple', 'hợp & đồng') query
WHERE search_vector @@ query
ORDER BY rank DESC
LIMIT 20;

-- Cú pháp tsquery:
-- 'hợp & đồng'      → AND: cả hai từ
-- 'hợp | đồng'      → OR: ít nhất một từ
-- '!hợp'            → NOT
-- 'hợp <-> đồng'    → phrase: hợp ngay trước đồng
-- 'hợp <2> đồng'    → hợp cách đồng 2 từ
-- 'hợp:*'           → prefix match
```

### Weighting với setweight

```sql
-- A = highest weight (doc_number matches → most relevant)
-- B = title matches
-- C = description matches
-- D = lowest (content)

SELECT id, title, ts_rank(search_vector, query, 32) AS rank
FROM documents,
     to_tsquery('simple', 'HN2026:*') query  -- prefix match on doc_number
WHERE search_vector @@ query
ORDER BY rank DESC;
-- → Documents với HN2026 trong doc_number sẽ rank cao nhất (weight A)
```

### Vietnamese FTS challenge

```
Tiếng Việt không có dictionary trong PostgreSQL built-in:
  - Không có stemming (chạy/chạys/running → cùng stem)
  - Dùng 'simple' dictionary: tách theo whitespace, lowercase, no stemming
  - Vẫn hoạt động tốt cho exact word search

Options cho tiếng Việt tốt hơn:
  1. Preprocess trong application: tokenize bằng underthesea/pyvi
  2. Zhparser extension (Chinese/CJK characters, kém cho VN)
  3. Elasticsearch/Meilisearch cho search requirements phức tạp
```

---

## B4. Strategy — Chọn loại search

```
Bài toán search của bạn là gì?
│
├─► Tìm kiếm theo prefix (doc_number LIKE 'HN2026%')
│     → B-Tree index với text_pattern_ops
│     → Hiệu quả nhất, không cần extension
│
├─► Tìm kiếm substring (title LIKE '%hợp đồng%')
│     ├─ Pattern > 4 ký tự?
│     │     → pg_trgm GIN index ✓
│     └─ Pattern ngắn < 4 ký tự?
│           → Không có index solution → xem xét Full-Text Search
│             hoặc chấp nhận full scan với LIMIT + offset
│
├─► Search nhiều fields (title, number, description cùng lúc)
│     → Full-Text Search với tsvector combining multiple columns
│     → ts_rank cho relevance scoring
│
├─► Fuzzy/typo-tolerant search ("hợp đồngg" → "hợp đồng")
│     → pg_trgm similarity search (similarity > threshold)
│
├─► Real-time search với high throughput và complex requirements
│     → Elasticsearch / Meilisearch / Typesense
│     → CDC sync từ PostgreSQL → search engine
│     → PostgreSQL vẫn là source of truth
│
└─► PDMS document search recommendation:
      1. Doc number exact: B-Tree (doc_number = '...')
      2. Doc number prefix: B-Tree text_pattern_ops
      3. Title contains: pg_trgm GIN
      4. Combined multi-field: tsvector với setweight
      5. Complex search UX: Elasticsearch với Debezium sync
```

### Combined approach cho PDMS

```sql
-- Hybrid: tận dụng index nào hiệu quả nhất tùy query type

-- Case 1: User nhập doc number (exact/prefix)
SELECT id, title, doc_number, status
FROM documents
WHERE doc_number LIKE 'HN2026%'  -- B-Tree index
  AND branch_id = 'HN01'         -- composite index
  AND deleted_at IS NULL
ORDER BY created_at DESC LIMIT 20;

-- Case 2: User nhập keywords tự do
SELECT id, title, doc_number, status,
       ts_rank(search_vector, query) AS relevance
FROM documents,
     plainto_tsquery('simple', :search_term) query  -- parses naturally
WHERE search_vector @@ query
  AND branch_id = 'HN01'
  AND deleted_at IS NULL
ORDER BY relevance DESC, created_at DESC
LIMIT 20;

-- Case 3: Mixed (ưu tiên exact match, fallback to FTS)
-- Application logic:
-- 1. Nếu input matches doc_number pattern → query 1
-- 2. Nếu không → query 2
-- 3. Kết hợp kết quả nếu cần
```

---

## Quick Reference

```sql
-- UNION: chọn đúng loại
UNION ALL  ← Default choice (cheap concatenation)
UNION      ← Only when dedup is semantically required

-- LIKE patterns:
'prefix%'       → B-Tree index OK
'%suffix'       → No B-Tree index → use pg_trgm
'%contains%'    → No B-Tree index → use pg_trgm
'exact'         → B-Tree index OK (use = instead)

-- pg_trgm setup:
CREATE EXTENSION pg_trgm;
CREATE INDEX ON table USING GIN(column gin_trgm_ops);

-- FTS setup:
ALTER TABLE t ADD COLUMN sv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', col)) STORED;
CREATE INDEX ON t USING GIN(sv);
SELECT * FROM t WHERE sv @@ to_tsquery('simple', 'term1 & term2');

-- ILIKE → always use pg_trgm (no native case-insensitive B-Tree index)
-- Unless: create index on LOWER(col) + query with LOWER(input)
```

---

## Related Notes

- [[04-Index-Internals]] — GIN index internals cho pg_trgm và FTS
- [[06-Query-Planner]] — Planner behavior với UNION, OR, bitmap scans
- [[05-Performance-Tuning]] — EXPLAIN ANALYZE cho query optimization

---

*Tags: #postgresql #union #like #search #full-text #trigram #optimization*  
*Created: 2026-05-06 | Difficulty: ⭐⭐⭐*
