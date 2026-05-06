# 05 — Performance Tuning: Memory, Vacuum, Monitoring

> Moved & consolidated từ `concepts/postgresql-performance-deep-dive.md`.  
> **Liên kết:** [[00-PostgreSQL-Hub]] | [[04-Index-Internals]] | [[06-Query-Planner]]

---

> Xem nội dung đầy đủ tại: [[concepts/postgresql-performance-deep-dive]]

## Nội dung chính

- **Memory config**: `shared_buffers`, `work_mem`, `maintenance_work_mem`, `effective_cache_size`
- **Vacuum & Bloat**: Dead tuples lifecycle, autovacuum triggers, per-table tuning, VACUUM FULL vs pg_repack
- **Partitioning**: Range partitioning, partition pruning, DETACH/ATTACH
- **Anti-patterns**: SELECT *, N+1, implicit type cast, NOT IN với NULL, long transactions
- **Monitoring**: `pg_stat_statements`, lock monitoring, buffer hit rate
- **Advanced**: Materialized views, SKIP LOCKED queue, UNLOGGED tables, advisory locks, statistics extension

## Quick Reference Checklist

```sql
-- Slow query identification
SELECT total_exec_time, calls, mean_exec_time, query
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;

-- Dead tuple check
SELECT relname, n_dead_tup, ROUND(n_dead_tup*100.0/NULLIF(n_live_tup+n_dead_tup,0),2) AS dead_pct
FROM pg_stat_user_tables ORDER BY n_dead_tup DESC;

-- Buffer hit rate (target > 99%)
SELECT ROUND(sum(heap_blks_hit)*100.0/NULLIF(sum(heap_blks_hit)+sum(heap_blks_read),0),2) AS hit_pct
FROM pg_statio_user_tables;

-- Lock blocking
SELECT pid, pg_blocking_pids(pid) AS blocked_by, query
FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0;

-- XID age (wraparound risk)
SELECT relname, age(relfrozenxid) AS xid_age
FROM pg_class WHERE relkind='r' ORDER BY xid_age DESC LIMIT 10;
```

```ini
# Key postgresql.conf settings
shared_buffers = 25%RAM
effective_cache_size = 75%RAM
work_mem = 64MB              # per sort/hash operation
maintenance_work_mem = 512MB
autovacuum_vacuum_cost_delay = 2ms
autovacuum_vacuum_scale_factor = 0.05
checkpoint_completion_target = 0.9
```

---

*Tags: #postgresql #performance #vacuum #monitoring #tuning*
