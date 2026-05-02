# PostgreSQL Index Internals — Deep Dive

---
tags: [postgresql, database, performance, indexing, internals]
created: 2026-05-02
difficulty: advanced
estimated-read: 25 min
links: [[Performance-System-Programming/01-Database-Internals/03-BTree-vs-LSM]], [[query-planner-optimizer]], [[connection-pooling-pgbouncer]]

---

## 🎯 Learning Objectives

Sau bài này bạn sẽ:
- Hiểu **bên trong** B-Tree index của PostgreSQL hoạt động như thế nào
- Biết khi nào dùng loại index nào (B-Tree, Hash, GIN, GiST, BRIN)
- Tránh được các **index pitfalls** phổ biến
- Đọc được `EXPLAIN ANALYZE` output để debug query chậm

---

## 🏗️ PostgreSQL Index Architecture

### Heap vs Index — Mối quan hệ cơ bản

```
┌──────────────────────────────────────────────────────────────┐
│                    PostgreSQL Storage                         │
│                                                              │
│  Table (Heap)                   B-Tree Index                 │
│  ┌─────────────┐               ┌─────────────────────┐       │
│  │ Page 0      │               │     Root Node        │       │
│  │ (id=5, ...) │               │  [15 | 25 | 40]     │       │
│  │ (id=12, ..) │               └──────┬──────┬────────┘       │
│  │ (id=3, ..)  │                      │      │                │
│  ├─────────────┤               ┌──────┘      └──────┐         │
│  │ Page 1      │               ▼                    ▼         │
│  │ (id=8, ...) │         [5|12|14]             [25|31|38]    │
│  │ (id=25,..)  │          Leaf Node             Leaf Node    │
│  └─────────────┘               │                    │        │
│                                │ TID                │ TID    │
│  TID = (page_number, slot)     │ (0,2) ─────────────┘        │
│  Tuple Identifier              └─► table page 0, slot 2      │
└──────────────────────────────────────────────────────────────┘
```

**Index lookup flow:**
1. Traverse B-Tree từ root → leaf node để tìm key
2. Leaf node chứa **TID** (Tuple ID = page + slot)
3. Fetch heap page từ TID → get actual row
4. **Visibility check** (MVCC) — đảm bảo row visible với transaction này

> 💡 **Index-Only Scan:** Nếu tất cả columns cần đều có trong index → skip heap fetch! Dùng `INCLUDE` clause hoặc covering index.

---

## 🌳 B-Tree Index — Cơ chế hoạt động chi tiết

### Structure

```
Page size: 8KB (default)
Branching factor: ~400 keys/node (int8 key)

Depth của B-Tree:
  1M rows  → depth = log₄₀₀(1M)  ≈ 3.3 → 4 levels
  1B rows  → depth = log₄₀₀(1B)  ≈ 5   → 5 levels

Để tìm 1 row trong 1 billion rows: chỉ cần 5 disk reads!
```

### Leaf node structure

```
┌──────────────────────────────────────────┐
│            B-Tree Leaf Page              │
├──────────────────────────────────────────┤
│ Page header (24 bytes)                   │
│ ItemIds (array of pointers)              │
├──────────────────────────────────────────┤
│ IndexTuple 1: [key=3  | TID=(0,3)]      │
│ IndexTuple 2: [key=5  | TID=(0,1)]      │
│ IndexTuple 3: [key=12 | TID=(0,2)]      │
│ ...                                      │
│ IndexTuple N: [key=14 | TID=(1,4)]      │
├──────────────────────────────────────────┤
│ Left sibling ptr ◄──────────────────────│──► Right sibling ptr
│ (linked list of leaf pages)              │
└──────────────────────────────────────────┘
```

Leaf pages được **link list** với nhau → range scan không cần go back to root!

---

## 📊 Các Loại Index PostgreSQL

### 1. B-Tree (Default) — dùng 90% trường hợp

```sql
-- Default index type
CREATE INDEX idx_documents_status ON documents(status);
CREATE INDEX idx_documents_created ON documents(created_at);

-- Composite index — ORDER MATTERS!
CREATE INDEX idx_docs_tenant_status ON documents(tenant_id, status);
-- ✓ Supports: WHERE tenant_id=? AND status=?
-- ✓ Supports: WHERE tenant_id=?  (leftmost prefix rule)
-- ✗ Does NOT support: WHERE status=?  (missing leftmost)
```

**Hỗ trợ operators:** `=`, `<`, `>`, `<=`, `>=`, `BETWEEN`, `IN`, `IS NULL`, `LIKE 'prefix%'`

**Không hỗ trợ:** `LIKE '%suffix'`, `LIKE '%middle%'`

---

### 2. Hash Index — chỉ equality

```sql
-- Hash index: O(1) lookup, chỉ cho = operator
CREATE INDEX idx_docs_hash_id ON documents USING HASH (external_id);

-- Khi nào dùng: key rất lớn (UUID, long strings) mà chỉ cần =
-- PostgreSQL 10+: WAL-logged → production safe
```

```
Hash lookup: O(1) vs B-Tree: O(log N)
Nhưng Hash không support range queries, ORDER BY → B-Tree vẫn versatile hơn
```

---

### 3. GIN (Generalized Inverted Index) — full-text, arrays, JSONB

```sql
-- Full-text search
CREATE INDEX idx_docs_content_fts ON documents 
USING GIN(to_tsvector('english', content));

-- Query:
SELECT * FROM documents 
WHERE to_tsvector('english', content) @@ to_tsquery('approval & pending');

-- JSONB indexing — tất cả keys trong JSONB column
CREATE INDEX idx_docs_metadata_gin ON documents USING GIN(metadata);
-- Supports: metadata @> '{"status": "active"}'
-- Supports: metadata ? 'field_name'

-- Array contains
CREATE INDEX idx_docs_tags ON documents USING GIN(tags);
-- Supports: tags @> ARRAY['urgent', 'legal']
```

**GIN internals:**
```
GIN = Inverted Index:
  "approval" → [doc_id: 3, 7, 15, 22]
  "pending"  → [doc_id: 3, 8, 15, 31]
  
  Query "approval AND pending" → intersect posting lists → [3, 15]
```

---

### 4. GiST (Generalized Search Tree) — geometry, ranges, nearest-neighbor

```sql
-- Range types
CREATE INDEX idx_reservations_range ON reservations 
USING GIST(during);  -- tsrange

-- Nearest neighbor (PostGIS)
CREATE INDEX idx_locations_geo ON locations 
USING GIST(coordinates);

SELECT * FROM locations 
ORDER BY coordinates <-> ST_MakePoint(105.85, 21.03)  -- Hanoi
LIMIT 10;
```

---

### 5. BRIN (Block Range Index) — huge tables với correlation

```sql
-- BRIN: tiny index, works for naturally ordered data
-- Example: log tables where id/timestamp correlates with physical storage

CREATE INDEX idx_audit_log_created_brin ON audit_log 
USING BRIN(created_at);

-- BRIN stores min/max per 128-page block (1MB)
-- Index size: ~1/10000 of B-Tree!
-- Trade-off: false positives → heap pages phải check
```

```
Khi nào dùng BRIN:
✓ Append-only tables (log, events, timeseries)
✓ Huge tables (>100GB) với sequential insert pattern
✗ Random insert → poor correlation → BRIN useless
```

---

## 🎯 Partial Index — Index Thông Minh

```sql
-- Chỉ index rows thỏa condition
-- Nhỏ hơn full index, query nhanh hơn

-- Chỉ index documents chưa processed
CREATE INDEX idx_docs_pending ON documents(created_at)
WHERE status = 'PENDING';

-- Chỉ index non-deleted records
CREATE INDEX idx_docs_active ON documents(tenant_id, created_at)
WHERE deleted_at IS NULL;

-- Index scan sẽ tự động dùng partial index khi query có matching WHERE
SELECT * FROM documents 
WHERE tenant_id = 1 AND deleted_at IS NULL
ORDER BY created_at DESC;
-- → Sử dụng idx_docs_active ✓
```

---

## 📦 Covering Index (Index Include)

```sql
-- Thêm columns vào leaf node của index → Index-Only Scan!
CREATE INDEX idx_docs_covering ON documents(tenant_id, status)
INCLUDE (title, created_at, file_size);

-- Query này sẽ KHÔNG cần touch heap table:
SELECT title, created_at, file_size
FROM documents
WHERE tenant_id = 1 AND status = 'ACTIVE';

-- EXPLAIN output:
-- Index Only Scan using idx_docs_covering on documents
-- (không có "Heap Fetches" hoặc rất ít)
```

---

## 🔍 Đọc EXPLAIN ANALYZE

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT d.id, d.title, d.status
FROM documents d
WHERE d.tenant_id = 1 AND d.status = 'PENDING'
ORDER BY d.created_at DESC
LIMIT 20;
```

```
┌─────────────────────────────────────────────────────────────────────┐
│ Output:                                                              │
│                                                                      │
│ Limit  (cost=0.43..45.23 rows=20 width=120)                         │
│         (actual time=0.123..0.987 rows=20 loops=1)                  │
│   ->  Index Scan Backward using idx_docs_tenant_created             │
│         on documents  (cost=0.43..2234.12 rows=991 width=120)       │
│         (actual time=0.119..0.981 rows=20 loops=1)                  │
│       Index Cond: (tenant_id = 1)                                   │
│       Filter: (status = 'PENDING')                                  │  ← ⚠️ Filter AFTER index!
│       Rows Removed by Filter: 143                                   │  ← 143 wasted reads
│       Buffers: shared hit=52 read=8                                 │
│ Planning Time: 0.234 ms                                             │
│ Execution Time: 1.045 ms                                            │
└─────────────────────────────────────────────────────────────────────┘
```

**Phân tích:**
- `Index Cond` → điều kiện được đánh giá TẠI index level ✓
- `Filter` → điều kiện được đánh giá SAU KHI fetch từ heap ⚠️
- `Rows Removed by Filter: 143` → 143 rows fetch thừa → thêm `status` vào index!
- `Buffers: shared hit=52 read=8` → 52 từ cache, 8 từ disk

**Fix:**
```sql
-- Thêm status vào composite index
CREATE INDEX idx_docs_tenant_status_created 
ON documents(tenant_id, status, created_at DESC);

-- Hoặc partial index:
CREATE INDEX idx_docs_pending_tenant 
ON documents(tenant_id, created_at DESC)
WHERE status = 'PENDING';
```

---

## ⚠️ Index Pitfalls — Những Lỗi Phổ Biến

### 1. Function on indexed column

```sql
-- ❌ Index KHÔNG được dùng!
SELECT * FROM documents WHERE LOWER(title) = 'annual report';
SELECT * FROM documents WHERE DATE(created_at) = '2025-01-01';
SELECT * FROM documents WHERE tenant_id::text = '1';

-- ✅ Fix 1: Functional index
CREATE INDEX idx_docs_title_lower ON documents(LOWER(title));

-- ✅ Fix 2: Rewrite query
SELECT * FROM documents 
WHERE created_at >= '2025-01-01' AND created_at < '2025-01-02';

-- ✅ Fix 3: Store preprocessed value
ALTER TABLE documents ADD COLUMN title_lower TEXT 
  GENERATED ALWAYS AS (LOWER(title)) STORED;
CREATE INDEX ON documents(title_lower);
```

### 2. Leading wildcard

```sql
-- ❌ B-Tree không support leading wildcard
SELECT * FROM documents WHERE title LIKE '%report%';

-- ✅ Fix 1: pg_trgm + GIN (trigram index)
CREATE EXTENSION pg_trgm;
CREATE INDEX idx_docs_title_trgm ON documents USING GIN(title gin_trgm_ops);
SELECT * FROM documents WHERE title LIKE '%report%';  -- Sử dụng trigram index ✓

-- ✅ Fix 2: Full-text search
SELECT * FROM documents 
WHERE to_tsvector('english', title) @@ to_tsquery('report');
```

### 3. NULL và index

```sql
-- B-Tree INDEX bao gồm NULL values!
-- IS NULL, IS NOT NULL được dùng với index ✓

-- Nhưng: UNIQUE index cho phép nhiều NULL (NULL ≠ NULL trong SQL)
CREATE UNIQUE INDEX ON documents(external_id) WHERE external_id IS NOT NULL;
```

### 4. Too many indexes

```sql
-- ❌ Over-indexing — mỗi INSERT/UPDATE phải update tất cả indexes
-- Table với 10 indexes: write operation chậm hơn ~2-3x

-- Kiểm tra unused indexes:
SELECT schemaname, tablename, indexname, idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0  -- Chưa bao giờ được dùng
ORDER BY schemaname, tablename;

-- Kiểm tra duplicate indexes:
SELECT * FROM pg_indexes WHERE tablename = 'documents';
```

---

## 📈 Index Maintenance

```sql
-- Index bloat sau nhiều UPDATE/DELETE
-- VACUUM reclaims dead tuples, cho phép index reuse pages

-- Check index bloat:
SELECT 
    relname AS table_name,
    indexrelname AS index_name,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_blks_read, idx_blks_hit,
    ROUND(100.0 * idx_blks_hit / NULLIF(idx_blks_read + idx_blks_hit, 0), 2) AS cache_hit_pct
FROM pg_stat_user_indexes
JOIN pg_statio_user_indexes USING(indexrelid)
ORDER BY pg_relation_size(indexrelid) DESC;

-- Rebuild index online (PostgreSQL 12+):
REINDEX INDEX CONCURRENTLY idx_documents_status;
```

---

## 📚 Case Study — PDMS Document Search Optimization

### Vấn đề ban đầu

```sql
-- Query chậm 8-12 seconds với 5M documents
SELECT id, title, status, created_at
FROM documents
WHERE tenant_id = 'VPB-HN'
  AND deleted_at IS NULL
  AND (title ILIKE '%hợp đồng%' OR metadata->>'document_type' = 'CONTRACT')
ORDER BY created_at DESC
LIMIT 20;
```

### EXPLAIN ANALYZE cho thấy

```
Seq Scan on documents  (cost=0.00..245000.00 rows=12 width=256)
  Filter: ((tenant_id = 'VPB-HN') AND (deleted_at IS NULL) AND ...)
  Rows Removed by Filter: 4999988
Execution Time: 8423 ms  ← Sequential scan toàn bộ 5M rows!
```

### Solution — 3-layer indexing strategy

```sql
-- Layer 1: Partial B-Tree cho tenant + soft delete filter
CREATE INDEX idx_docs_active_tenant 
ON documents(tenant_id, created_at DESC)
WHERE deleted_at IS NULL;

-- Layer 2: GIN trigram cho ILIKE search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_docs_title_trgm 
ON documents USING GIN(title gin_trgm_ops)
WHERE deleted_at IS NULL;

-- Layer 3: GIN cho JSONB metadata
CREATE INDEX idx_docs_metadata_gin 
ON documents USING GIN(metadata jsonb_path_ops)
WHERE deleted_at IS NULL;
```

### Kết quả

```
Index Scan using idx_docs_active_tenant on documents
  Index Cond: (tenant_id = 'VPB-HN')
  Filter: ((title ILIKE '%hợp đồng%') OR (metadata->>'document_type' = 'CONTRACT'))
  Rows Removed by Filter: 847
Execution Time: 23 ms  ← Từ 8423ms xuống 23ms (366x faster!)
```

---

## 🔑 Key Takeaways

1. **B-Tree** là default — range queries, ORDER BY, LIKE 'prefix%'
2. **GIN** cho full-text search, arrays, JSONB, trigram (LIKE '%substring%')
3. **BRIN** cho append-only huge tables — index size 1/10000 của B-Tree
4. **Partial index** = index thông minh, nhỏ hơn, nhanh hơn — dùng khi có consistent WHERE clause
5. **Covering index** với `INCLUDE` → Index-Only Scan → skip heap fetch
6. **Composite index:** column selectivity cao nhất đặt đầu, trừ khi có range query (đặt range column cuối)
7. `EXPLAIN (ANALYZE, BUFFERS)` là công cụ số 1 để diagnose slow query
8. Monitor `pg_stat_user_indexes` — xóa index không dùng để giảm write overhead

---

## 🔗 Related Links

- [[Performance-System-Programming/01-Database-Internals/03-BTree-vs-LSM]] — B-Tree mechanics
- [[query-planner-optimizer]] — Query planner chọn index như thế nào
- [[connection-pooling-pgbouncer]] — Index tốt nhưng connection pool kém cũng chậm
- [[postgresql-performance-deep-dive]] — Tổng quan performance tuning
