# 04 — Index Internals: B-Tree, GIN, BRIN và Hơn Thế Nữa

> Moved & consolidated từ `concepts/postgresql-index-internals.md`.  
> **Liên kết:** [[00-PostgreSQL-Hub]] | [[05-Performance-Tuning]] | [[06-Query-Planner]]

---

> Xem nội dung đầy đủ tại: [[concepts/postgresql-index-internals]]

## Nội dung chính

- **B-Tree internals**: Leaf node structure, branching factor, linked list của leaf pages
- **Index types**: B-Tree, Hash, GIN (full-text, JSONB, arrays), GiST (geometry, ranges), BRIN (append-only huge tables)
- **Partial index**: `WHERE` clause để index chỉ rows quan trọng
- **Covering index** (`INCLUDE`): Index-Only Scan, skip heap fetch
- **EXPLAIN ANALYZE**: Đọc `Index Cond` vs `Filter`, `Rows Removed by Filter`
- **Pitfalls**: Function on column, leading wildcard, too many indexes, NULL behavior
- **PDMS case study**: 8423ms → 23ms với 3-layer indexing strategy

## Quick Reference

```sql
-- B-Tree composite: equality columns trước, range cuối
CREATE INDEX ON docs(tenant_id, status, created_at);

-- GIN cho JSONB
CREATE INDEX ON docs USING GIN(metadata);

-- Partial index (nhỏ hơn, nhanh hơn)
CREATE INDEX ON docs(tenant_id, created_at) WHERE deleted_at IS NULL;

-- Covering index (Index-Only Scan)
CREATE INDEX ON docs(tenant_id, status) INCLUDE (title, created_at);

-- Trigram cho LIKE '%substring%'
CREATE EXTENSION pg_trgm;
CREATE INDEX ON docs USING GIN(title gin_trgm_ops);
```

---

*Tags: #postgresql #index #b-tree #gin #internals*
