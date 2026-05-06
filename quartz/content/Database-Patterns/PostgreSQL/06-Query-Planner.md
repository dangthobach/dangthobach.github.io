# 06 — Query Planner & Optimizer

> Moved & consolidated từ `concepts/query-planner-optimizer.md`.  
> **Liên kết:** [[00-PostgreSQL-Hub]] | [[04-Index-Internals]] | [[05-Performance-Tuning]]

---

> Xem nội dung đầy đủ tại: [[concepts/query-planner-optimizer]]

## Nội dung chính

- **Pipeline**: Parser → Analyzer → Rewriter → Planner/Optimizer → Executor
- **Statistics**: `pg_stats`, `n_distinct`, `correlation`, statistics target tuning
- **Cost model**: `seq_page_cost`, `random_page_cost`, cpu costs — tại sao Index Scan không phải lúc nào cũng win
- **Join algorithms**: Nested Loop, Hash Join, Merge Join — khi nào chọn cái nào
- **EXPLAIN ANALYZE**: Đọc startup/total cost, actual rows vs estimated rows, Buffers
- **Plan caching**: Prepared statements, plan invalidation
- **Planner hints**: `pg_hint_plan`, disable/enable operators cho debugging
- **PDMS case study**: 45s → 0.8s report query optimization

## Quick Reference

```sql
-- SSD: giảm random_page_cost để index được ưu tiên hơn
SET random_page_cost = 1.1;

-- Tránh Hash Join spill to disk
SET work_mem = '256MB';  -- per-session khi cần

-- Statistics cho high-cardinality columns
ALTER TABLE documents ALTER COLUMN status SET STATISTICS 500;
ANALYZE documents;

-- Xem row estimate accuracy
EXPLAIN (ANALYZE, BUFFERS) <your-query>;
-- Tìm: actual rows vs rows estimate — lệch > 10x → ANALYZE cần thiết

-- Tại sao planner chọn Seq Scan?
-- → Index Scan chỉ win khi trả về < 5-15% rows (selectivity phải cao)
-- → correlation gần 0 → random heap access → Seq Scan tốt hơn

-- Multi-column correlation (skewed data)
CREATE STATISTICS stat_tenant_status ON tenant_id, status FROM documents;
ANALYZE documents;
```

---

*Tags: #postgresql #query-planner #explain #optimization*
