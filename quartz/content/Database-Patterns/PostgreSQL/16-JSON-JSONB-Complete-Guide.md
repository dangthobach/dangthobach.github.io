# 16 — JSON & JSONB: Storing, Querying, Indexing, Real-World Patterns

> **Audience:** Engineers lưu semi-structured data trong PostgreSQL, cần biết khi nào dùng JSON/JSONB và tối ưu như thế nào.  
> **Scope:** JSON vs JSONB internals, operators, JSONPath, updating, indexing, real-world patterns, common mistakes.  
> **Liên kết:** [[04-Index-Internals]] | [[06-Query-Planner]] | [[00-PostgreSQL-Hub]]

---

## 📋 Mục lục

1. [JSON vs JSONB — Khác nhau thật sự là gì?](#1-json-vs-jsonb)
2. [Storing và data model decisions](#2-storing-và-data-model)
3. [Query operators — Đầy đủ arsenal](#3-query-operators)
4. [JSONPath — Powerful path expressions](#4-jsonpath)
5. [Updating JSONB — Patterns và pitfalls](#5-updating-jsonb)
6. [Indexing JSONB — GIN, expression, partial](#6-indexing-jsonb)
7. [Real-world patterns](#7-real-world-patterns)
8. [Common Mistakes](#8-common-mistakes)
9. [Performance guide](#9-performance-guide)

---

## 1. JSON vs JSONB

```
┌──────────────────────────────────────────────────────────────────────┐
│                      JSON vs JSONB                                    │
│                                                                      │
│  JSON (text storage):                                                │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │ Stores raw JSON text as-is                                  │     │
│  │ '{"b": 2, "a": 1, "a": 99}'                                │     │
│  │      ↑ preserves order, preserves duplicate keys           │     │
│  │ Validates JSON syntax on INSERT                             │     │
│  │ Processing: parse on every query (re-parses each time)     │     │
│  └────────────────────────────────────────────────────────────┘     │
│                                                                      │
│  JSONB (binary storage):                                             │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │ Decomposes and stores in binary format                     │     │
│  │ '{"b": 2, "a": 1, "a": 99}' → {a:99, b:2}                │     │
│  │      ↑ sorts keys, deduplicates (last value wins)          │     │
│  │ Validates + parses on INSERT (slight write overhead)       │     │
│  │ Processing: already parsed → faster reads                  │     │
│  │ Supports GIN indexing, operators @>, ?, etc.               │     │
│  └────────────────────────────────────────────────────────────┘     │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────┐        │
│  │ Dimension      │ JSON          │ JSONB                  │        │
│  │ ───────────────┼───────────────┼───────────────────── │        │
│  │ Write speed    │ Faster        │ Slightly slower        │        │
│  │ Read speed     │ Slower        │ Faster                 │        │
│  │ Storage size   │ Smaller       │ Larger (+20-30%)       │        │
│  │ Key ordering   │ Preserved     │ Sorted                 │        │
│  │ Dup keys       │ Preserved     │ Deduped (last wins)    │        │
│  │ Indexing (GIN) │ ✗ No          │ ✓ Yes                  │        │
│  │ Containment @> │ ✗ No          │ ✓ Yes                  │        │
│  │ Key exists ?   │ ✗ No          │ ✓ Yes                  │        │
│  └─────────────────────────────────────────────────────────┘        │
│                                                                      │
│  RECOMMENDATION: 99% of time → use JSONB                            │
│  JSON only when: must preserve key order OR audit raw input          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. Storing và data model

### Schema design decision

```
When to use JSONB column:
✓ Attributes vary per record (product specs, form answers, custom fields)
✓ Schema evolves frequently (no ALTER TABLE migrations)
✓ External API responses (preserve structure, may query later)
✓ Sparse attributes (most records have nulls for most fields)

When to use regular columns (NOT JSONB):
✗ Frequently queried fields → normalize into columns + index
✗ Fields used in JOINs → must be column
✗ Aggregate-heavy fields (SUM, AVG) → column is faster
✗ All records have same structure → use columns

Hybrid approach (PDMS documents):
CREATE TABLE documents (
    id          BIGSERIAL PRIMARY KEY,
    -- Core fields: column (indexed, queryable, joinable)
    branch_id   TEXT NOT NULL,
    status      TEXT NOT NULL,
    doc_number  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    amount      NUMERIC(15,2),
    -- Semi-structured: JSONB (custom metadata per doc type)
    metadata    JSONB,
    -- Audit trail: preserve raw external data
    raw_input   JSON   -- preserve as-is for debugging
);
```

### JSONB storage format (internal)

```
JSONB binary format stores:
  - Type header (object/array/string/number/bool/null)
  - For objects: sorted key array + value array
  - Numbers: variable-length binary
  - Strings: UTF-8 bytes

Access pattern:
  metadata->'field'  → navigate without full parse (binary skip)
  Row size: JSONB overhead ≈ 20-30% vs equivalent columns
  TOAST: JSONB > 2KB stored in TOAST table (compression + detoast on access)
```

---

## 3. Query operators

### Navigation operators

```sql
-- Sample data:
INSERT INTO documents(metadata) VALUES ('{
    "type": "contract",
    "parties": ["VPBank", "Nguyen Van A"],
    "value": 500000000,
    "signed": true,
    "details": {
        "duration_months": 24,
        "interest_rate": 0.085,
        "collateral": {"type": "real_estate", "value": 2000000000}
    },
    "tags": ["urgent", "vip"]
}');

-- -> : get JSON value (returns JSON)
SELECT metadata->'type' FROM documents;
-- → "contract"  (JSON string with quotes)

-- ->> : get TEXT value (returns text, no quotes)
SELECT metadata->>'type' FROM documents;
-- → contract  (plain text)

-- Chain navigation:
SELECT metadata->'details'->>'interest_rate' FROM documents;
-- → 0.085

SELECT metadata->'details'->'collateral'->>'type' FROM documents;
-- → real_estate

-- Array access by index (0-based):
SELECT metadata->'parties'->0 FROM documents;
-- → "VPBank"

SELECT metadata->'parties'->>1 FROM documents;
-- → Nguyen Van A
```

### Containment operators

```sql
-- @> : left contains right (does JSON contain this sub-document?)
SELECT * FROM documents
WHERE metadata @> '{"type": "contract"}';
-- → rows where type=contract

SELECT * FROM documents
WHERE metadata @> '{"details": {"duration_months": 24}}';
-- → nested containment

SELECT * FROM documents
WHERE metadata @> '{"tags": ["urgent"]}';
-- → docs with "urgent" in tags array (array containment)

-- <@ : right contains left (is this a subset of the column?)
SELECT * FROM documents
WHERE '{"type": "contract", "signed": true}' <@ metadata;
-- → same as above but reversed

-- ? : does key exist?
SELECT * FROM documents WHERE metadata ? 'type';
-- → rows where metadata has 'type' key

-- ?| : does ANY key exist?
SELECT * FROM documents WHERE metadata ?| ARRAY['type', 'category'];
-- → rows with 'type' OR 'category' key

-- ?& : do ALL keys exist?
SELECT * FROM documents WHERE metadata ?& ARRAY['type', 'value', 'signed'];
-- → rows with ALL three keys

-- #> : get value at path (array of keys):
SELECT metadata #> '{details,collateral,type}' FROM documents;
-- → "real_estate"

-- #>> : same but returns text:
SELECT metadata #>> '{details,collateral,type}' FROM documents;
-- → real_estate
```

### Aggregation with JSONB

```sql
-- jsonb_agg: aggregate rows into JSON array
SELECT branch_id,
       jsonb_agg(
           jsonb_build_object('id', id, 'status', status, 'amount', amount)
           ORDER BY created_at DESC
       ) AS documents
FROM documents
WHERE deleted_at IS NULL
GROUP BY branch_id;

-- jsonb_object_agg: aggregate key-value pairs into JSON object
SELECT jsonb_object_agg(branch_id, doc_count)
FROM (
    SELECT branch_id, COUNT(*) AS doc_count
    FROM documents GROUP BY branch_id
) stats;
-- → {"HN01": 150, "SG01": 200, "HN02": 75}

-- jsonb_array_elements: expand JSON array → rows
SELECT doc_id, elem
FROM documents, jsonb_array_elements(metadata->'tags') AS elem
WHERE metadata ? 'tags';
-- → One row per tag per document

-- jsonb_each: expand JSON object → key-value rows
SELECT doc_id, key, value
FROM documents, jsonb_each(metadata)
WHERE id = 123;
-- → One row per top-level key in metadata
```

---

## 4. JSONPath

JSONPath (PostgreSQL 12+) — XPath for JSON, powerful for complex queries:

```sql
-- Basic JSONPath syntax:
-- $              → root element
-- .key           → access key
-- [*]            → all array elements
-- [0]            → first array element
-- [0,2]          → first and third
-- [0 to 3]       → range
-- ?()            → filter expression
-- @              → current element in filter

-- jsonb_path_query: returns matching values
SELECT jsonb_path_query(metadata, '$.details.interest_rate')
FROM documents;
-- → 0.085

-- All elements of array:
SELECT jsonb_path_query(metadata, '$.parties[*]')
FROM documents;
-- → "VPBank", "Nguyen Van A" (separate rows)

-- Filter with condition:
SELECT * FROM documents
WHERE jsonb_path_exists(metadata, '$.value ? (@ > 100000000)');
-- → docs where metadata.value > 100M

-- Complex filter:
SELECT jsonb_path_query_array(
    metadata,
    '$.parties[*] ? (@ starts with "Nguyen")'
)
FROM documents;
-- → ["Nguyen Van A"]

-- Nested filter:
SELECT * FROM documents
WHERE jsonb_path_match(
    metadata,
    '$.details.interest_rate < 0.1 && $.signed == true'
);

-- Date operations in JSONPath (PG 12+):
SELECT * FROM documents
WHERE jsonb_path_exists(
    metadata,
    '$.created_date.datetime() > "2026-01-01".datetime()'
);
```

### @? operator — JSONPath existence check

```sql
-- @? : does JSONPath return any result?
SELECT * FROM documents
WHERE metadata @? '$.tags[*] ? (@ == "urgent")';
-- → docs with "urgent" in tags

-- Faster than jsonb_path_exists() (same result, shorter syntax)

-- Combine with index:
CREATE INDEX idx_docs_jsonpath ON documents USING GIN(metadata);
-- @? can use this GIN index!
```

---

## 5. Updating JSONB

JSONB columns are immutable — you must replace the whole value or use functions:

```sql
-- Full replacement (simple but loses other fields):
UPDATE documents
SET metadata = '{"type": "updated", "value": 999}'
WHERE id = 123;
-- ← Loses all other fields!

-- ✅ jsonb_set — update specific path:
UPDATE documents
SET metadata = jsonb_set(
    metadata,
    '{details,interest_rate}',   -- path as text array
    '0.09',                       -- new value (must be valid JSON)
    true                          -- create_missing: true = create if not exists
)
WHERE id = 123;

-- ✅ jsonb_set nested:
UPDATE documents
SET metadata = jsonb_set(
    jsonb_set(metadata, '{type}', '"amended"'),
    '{details,duration_months}', '36'
)
WHERE id = 123;

-- ✅ || operator — merge/overwrite top-level keys:
UPDATE documents
SET metadata = metadata || '{"status": "approved", "approved_at": "2026-05-07"}'
WHERE id = 123;
-- Keeps all existing keys, overwrites 'status' and 'approved_at'
-- ⚠️ Only works for top-level keys (not nested)!

-- ✅ #- operator — remove key/path:
UPDATE documents
SET metadata = metadata #- '{details,temp_notes}'   -- remove nested key
WHERE id = 123;

UPDATE documents
SET metadata = metadata - 'draft_field'   -- remove top-level key
WHERE id = 123;

UPDATE documents
SET metadata = metadata - ARRAY['field1', 'field2']   -- remove multiple
WHERE id = 123;
```

### Updating JSONB array elements

```sql
-- Append to array:
UPDATE documents
SET metadata = jsonb_set(
    metadata,
    '{tags}',
    (metadata->'tags') || '"new_tag"'::jsonb
)
WHERE id = 123;

-- Remove element from array (by value, not index):
UPDATE documents
SET metadata = jsonb_set(
    metadata,
    '{tags}',
    (SELECT jsonb_agg(elem)
     FROM jsonb_array_elements(metadata->'tags') elem
     WHERE elem != '"urgent"'::jsonb)
)
WHERE id = 123 AND metadata->'tags' ? 'urgent';
```

---

## 6. Indexing JSONB

### GIN index — Whole column (containment + key exists)

```sql
-- Index the entire JSONB column:
CREATE INDEX idx_docs_metadata_gin ON documents USING GIN(metadata);

-- Supports these operators:
-- @>   (containment)
-- ?    (key exists)
-- ?|   (any key exists)
-- ?&   (all keys exist)
-- @?   (JSONPath existence)

-- Example query using GIN:
SELECT * FROM documents WHERE metadata @> '{"type": "contract"}';
-- EXPLAIN: Bitmap Index Scan using idx_docs_metadata_gin ✓
```

### GIN with jsonb_path_ops — Smaller, faster for @>

```sql
-- jsonb_path_ops: optimized for @> containment only
-- Smaller index (~30% less space), faster for @>
-- Cannot index ? and ?| operators

CREATE INDEX idx_docs_metadata_path ON documents
USING GIN(metadata jsonb_path_ops);

-- Use when: only need @> queries (most common pattern)
-- Don't use when: need ? key existence queries
```

### Expression index — Specific path (B-Tree)

```sql
-- Index a specific JSONB path → small, efficient B-Tree:
CREATE INDEX idx_docs_type ON documents
    ((metadata->>'type'));

-- Index on nested path:
CREATE INDEX idx_docs_interest_rate ON documents
    (((metadata->'details'->>'interest_rate')::NUMERIC));

-- Query MUST match expression exactly:
SELECT * FROM documents WHERE metadata->>'type' = 'contract';
-- EXPLAIN: Index Scan using idx_docs_type ✓

-- Partial expression index (most selective):
CREATE INDEX idx_docs_contract_value ON documents
    (((metadata->>'value')::NUMERIC))
WHERE metadata->>'type' = 'contract';
-- → Only indexes contracts, very small and fast
```

### Index strategy selection

```
┌──────────────────────────────────────────────────────────────────────┐
│               JSONB Index Selection Guide                             │
│                                                                      │
│  Query Pattern              │ Best Index                            │
│  ───────────────────────────┼───────────────────────────────────── │
│  metadata @> '{"key":"val"}'│ GIN(metadata jsonb_path_ops)          │
│  metadata ? 'key'           │ GIN(metadata) [default ops]           │
│  metadata->>'key' = 'val'   │ Expression B-Tree on (metadata->>'k') │
│  metadata->'key' = complex  │ Expression B-Tree + CAST              │
│  Full JSONPath search       │ GIN(metadata) + @? operator           │
│  Range on JSONB number      │ Expression B-Tree with ::NUMERIC cast  │
│  Multiple paths needed      │ Multiple expression indexes            │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 7. Real-world patterns

### Pattern 1: EAV replacement (Entity-Attribute-Value)

```sql
-- Old EAV pattern (terrible performance):
CREATE TABLE attributes (entity_id INT, attr_name TEXT, attr_value TEXT);
-- → Needs pivot queries, hard to index, schema nightmare

-- ✅ JSONB replacement:
CREATE TABLE products (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    -- Type-specific attributes in JSONB:
    attributes  JSONB
);

-- Electronics:
INSERT INTO products(name, category, attributes) VALUES
('iPhone 15', 'phone', '{"storage_gb": 256, "ram_gb": 8, "5g": true, "color": "black"}');

-- Clothing:
INSERT INTO products(name, category, attributes) VALUES
('T-Shirt', 'clothing', '{"size": "XL", "material": "cotton", "gender": "male"}');

-- Query electronics with 5G and > 128GB storage:
SELECT * FROM products
WHERE category = 'phone'
  AND attributes @> '{"5g": true}'
  AND (attributes->>'storage_gb')::INT > 128;
```

### Pattern 2: Audit log / Change history

```sql
CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id   BIGINT NOT NULL,
    action      TEXT NOT NULL,   -- INSERT, UPDATE, DELETE
    changes     JSONB,           -- {field: {old: val, new: val}}
    performed_by BIGINT,
    performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Record changes:
INSERT INTO audit_log(entity_type, entity_id, action, changes, performed_by)
VALUES (
    'document', 123, 'UPDATE',
    '{
        "status": {"old": "PENDING", "new": "APPROVED"},
        "reviewer_id": {"old": null, "new": 456}
    }',
    789
);

-- Query: what changed in a document?
SELECT
    performed_at,
    action,
    jsonb_each_text(changes) AS field_change
FROM audit_log
WHERE entity_type = 'document' AND entity_id = 123
ORDER BY performed_at DESC;

-- Query: find all documents where status changed to APPROVED today:
SELECT DISTINCT entity_id
FROM audit_log
WHERE entity_type = 'document'
  AND performed_at::DATE = CURRENT_DATE
  AND changes @> '{"status": {"new": "APPROVED"}}';
```

### Pattern 3: Feature flags / Configuration

```sql
CREATE TABLE feature_flags (
    service_name TEXT PRIMARY KEY,
    flags        JSONB NOT NULL DEFAULT '{}'
);

INSERT INTO feature_flags VALUES ('pdms-service', '{
    "new_approval_flow": true,
    "max_file_size_mb": 50,
    "allowed_types": ["pdf", "docx", "xlsx"],
    "maintenance_mode": false
}');

-- Read flag:
SELECT (flags->>'new_approval_flow')::BOOLEAN
FROM feature_flags WHERE service_name = 'pdms-service';

-- Update single flag (safe, preserves others):
UPDATE feature_flags
SET flags = flags || '{"maintenance_mode": true}'
WHERE service_name = 'pdms-service';
```

### Pattern 4: API response caching

```sql
CREATE TABLE api_cache (
    cache_key   TEXT PRIMARY KEY,
    response    JSONB NOT NULL,
    cached_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    metadata    JSONB   -- request params for debugging
);

-- Store:
INSERT INTO api_cache(cache_key, response, expires_at)
VALUES (
    'external_api_user_123',
    '{"id": 123, "credit_score": 750, "verified": true}',
    NOW() + INTERVAL '1 hour'
)
ON CONFLICT (cache_key) DO UPDATE
    SET response = EXCLUDED.response,
        cached_at = NOW(),
        expires_at = EXCLUDED.expires_at;

-- Fetch (checking expiry):
SELECT response FROM api_cache
WHERE cache_key = 'external_api_user_123'
  AND expires_at > NOW();

-- Cleanup expired:
DELETE FROM api_cache WHERE expires_at < NOW();
```

---

## 8. Common Mistakes

### Mistake 1: Using JSON instead of JSONB

```sql
-- ❌ JSON for queryable data:
CREATE TABLE docs (metadata JSON);
-- Cannot use @>, ?, GIN index → always sequential scan

-- ✅ JSONB for almost everything:
CREATE TABLE docs (metadata JSONB);
```

### Mistake 2: Storing everything in JSONB

```sql
-- ❌ Frequently queried fields in JSONB:
SELECT * FROM docs WHERE metadata->>'branch_id' = 'HN01';
-- → Seq scan even with GIN index (GIN doesn't help for equality on text extraction)
-- → Expression index needed, but then why not just a column?

-- ✅ Frequently queried fields as columns:
ALTER TABLE docs ADD COLUMN branch_id TEXT;
CREATE INDEX ON docs(branch_id);
SELECT * FROM docs WHERE branch_id = 'HN01';
-- → Fast index scan!
```

### Mistake 3: Casting without index

```sql
-- ❌ Cast without expression index → seq scan:
SELECT * FROM docs WHERE (metadata->>'amount')::NUMERIC > 1000000;
-- → Can't use GIN for this, no expression index → slow!

-- ✅ Create expression index:
CREATE INDEX idx_docs_amount ON docs (((metadata->>'amount')::NUMERIC));
SELECT * FROM docs WHERE (metadata->>'amount')::NUMERIC > 1000000;
-- → Index Scan on idx_docs_amount ✓
```

### Mistake 4: jsonb_set with wrong path

```sql
-- ❌ Wrong: trying to set nested path when parent doesn't exist:
UPDATE docs SET metadata = jsonb_set(metadata, '{new_parent, child}', '"value"', false);
-- false = don't create missing → silently does nothing if new_parent doesn't exist!

-- ✅ Always use true for create_missing, or check first:
UPDATE docs SET metadata = jsonb_set(metadata, '{new_parent, child}', '"value"', true);
```

### Mistake 5: Updating JSONB in loop (N queries)

```sql
-- ❌ N individual UPDATE queries (terrible):
for doc_id in doc_ids:
    UPDATE docs SET metadata = jsonb_set(metadata, '{processed}', 'true') WHERE id = doc_id;

-- ✅ Single UPDATE with array:
UPDATE docs
SET metadata = jsonb_set(metadata, '{processed}', 'true')
WHERE id = ANY(ARRAY[1,2,3,...]);

-- ✅ Or use CASE for different values:
UPDATE docs
SET metadata = jsonb_set(metadata, '{result}', to_jsonb(result_value))
FROM (VALUES (1, 'passed'), (2, 'failed'), (3, 'pending')) AS updates(doc_id, result_value)
WHERE docs.id = updates.doc_id;
```

---

## 9. Performance guide

```sql
-- CHECK: Is JSONB column being queried without index?
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM documents WHERE metadata @> '{"type": "contract"}';
-- "Seq Scan" → need GIN index
-- "Bitmap Index Scan" → GIN index working!

-- CHECK: Expression index being used?
EXPLAIN
SELECT * FROM documents WHERE metadata->>'type' = 'contract';
-- "Seq Scan ... Filter: (metadata->>'type' = 'contract')" → add expression index
-- "Index Scan using idx_docs_type" → working!

-- CHECK: JSONB column size (TOAST impact):
SELECT
    id,
    pg_column_size(metadata) AS jsonb_bytes,
    length(metadata::TEXT) AS text_length
FROM documents
ORDER BY pg_column_size(metadata) DESC LIMIT 10;
-- Very large JSONB → consider normalizing or splitting

-- MONITOR: TOAST table access:
SELECT * FROM pg_statio_user_tables
WHERE relname LIKE 'pg_toast%';
-- High toast reads → JSONB columns accessed frequently, large blobs

-- BENCHMARK: jsonb_path_ops vs default ops:
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM docs WHERE metadata @> '{"type": "contract"}';
-- Compare index sizes:
SELECT pg_size_pretty(pg_relation_size('idx_docs_metadata_gin')) AS gin_size,
       pg_size_pretty(pg_relation_size('idx_docs_metadata_path')) AS path_ops_size;
```

---

## Quick Reference

```sql
-- Navigation:
metadata->'key'          → JSON value
metadata->>'key'         → TEXT value
metadata#>'{a,b}'        → nested JSON
metadata#>>'{a,b}'       → nested TEXT

-- Containment / existence:
metadata @> '{"k":"v"}'  → contains
metadata ? 'key'         → key exists
metadata ?| ARRAY[...]   → any key exists
metadata ?& ARRAY[...]   → all keys exist

-- Path:
metadata @? '$.k ? (@ > 5)'   → JSONPath exists
jsonb_path_query(col, '$.k')   → path query

-- Modify:
jsonb_set(col, '{path}', 'val', create:bool)  → set nested
col || '{"k":"v"}'              → merge top-level
col - 'key'                     → remove key
col #- '{path}'                 → remove nested

-- Aggregate:
jsonb_agg(expr)                → array of rows
jsonb_object_agg(k, v)        → object from key-values
jsonb_array_elements(arr)      → expand array

-- Index:
GIN(col)                → @>, ?, ?|, ?&, @?
GIN(col jsonb_path_ops) → @> only, faster/smaller
B-Tree on (col->>'k')   → equality on specific path
```

---

## Related Notes

- [[04-Index-Internals]] — GIN index internals
- [[06-Query-Planner]] — Planner behavior with JSONB queries
- [[05-Performance-Tuning]] — TOAST và large column impact

---

*Tags: #postgresql #json #jsonb #semi-structured #indexing #querying*
*Created: 2026-05-07 | Difficulty: ⭐⭐⭐*
