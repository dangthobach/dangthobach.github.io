# 🐘 PostgreSQL — Hub

> **Entry point duy nhất** cho mọi thứ liên quan PostgreSQL trong vault này.  
> Từ lý thuyết engine internals → production patterns → PDMS-specific war stories.

---

## 🗺️ Bản đồ kiến thức

```
                        PostgreSQL Engine
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
    ACID & Durability    Concurrency         Storage Engine
    [[01-ACID-Internals]]  [[02-MVCC-Concurrency]]  [[04-Index-Internals]]
          │                   │                   │
          └───────────────────┼───────────────────┘
                              │
               ┌──────────────┴──────────────┐
               │                             │
        SQL Techniques               Performance & Ops
    [[14-CTE-Recursive]]           [[05-Performance-Tuning]]
    [[13-Grouping-Aggregation]]    [[06-Query-Planner]]
    [[12-UNION-LIKE]]              [[04-Index-Internals]]
               │
        Advanced Topics
    [[15]] [[16]] [[17]] [[10]] [[11]]
```

---

## 📚 Series Articles

### 🔬 Engine Internals

| # | Bài viết | Nội dung chính | Độ khó |
|---|----------|---------------|--------|
| 01 | [[01-ACID-Internals]] | WAL, fsync, crash recovery, isolation levels thật sự | ⭐⭐⭐ |
| 02 | [[02-MVCC-Concurrency]] | Tuple versioning, snapshot model, dead tuples, vacuum | ⭐⭐⭐⭐ |
| 08 | [[08-MVCC-MySQL-PostgreSQL-Oracle]] | MVCC cơ chế: PG heap vs MySQL undo log vs Oracle undo TBS | ⭐⭐⭐⭐ |
| 15 | [[15-Transaction-Isolation-Levels-Compared]] | Isolation levels across PG/MySQL/Oracle/SQL Server — không giống nhau! | ⭐⭐⭐⭐ |

### 🛠️ SQL Techniques

| # | Bài viết | Nội dung chính | Độ khó |
|---|----------|---------------|--------|
| 13 | [[13-Grouping-and-Aggregation]] | GROUP BY internals, GROUPING SETS, ROLLUP, CUBE, window functions, FILTER | ⭐⭐⭐ |
| 14 | [[14-CTE-Recursive-Advanced-SQL]] | CTE materialization, recursive CTE, INTERSECT, EXCEPT, LATERAL | ⭐⭐⭐⭐ |
| 12 | [[12-UNION-and-LIKE-Optimization]] | UNION ALL vs UNION, pg_trgm, Full-Text Search, LIKE strategies | ⭐⭐⭐ |

### ⚡ Performance & Operations

| # | Bài viết | Nội dung chính | Độ khó |
|---|----------|---------------|--------|
| 03 | [[03-Concurrency-Patterns]] | Lost update, write skew, FOR UPDATE, SKIP LOCKED, advisory locks | ⭐⭐⭐⭐ |
| 04 | [[04-Index-Internals]] | B-Tree, GIN, GiST, BRIN, partial/covering index, EXPLAIN | ⭐⭐⭐ |
| 05 | [[05-Performance-Tuning]] | Memory config, vacuum, partitioning, anti-patterns, monitoring | ⭐⭐⭐ |
| 06 | [[06-Query-Planner]] | Cost model, statistics, join algorithms, plan caching | ⭐⭐⭐⭐ |
| 07 | [[07-Count-Star-vs-Count-Column]] | COUNT(*) vs COUNT(col): semantic, performance, MVCC impact | ⭐⭐ |

### 🏗️ Design & Data Modeling

| # | Bài viết | Nội dung chính | Độ khó |
|---|----------|---------------|--------|
| 09 | [[09-Temporal-Data-Types]] | TIMESTAMP vs TIMESTAMPTZ, timezone gotchas, indexing temporal data | ⭐⭐ |
| 10 | [[10-Sharding-When-Why-Pitfalls]] | Khi nào shard, pain points, giải pháp, alternatives | ⭐⭐⭐⭐ |
| 16 | [[16-JSON-JSONB-Complete-Guide]] | JSON vs JSONB, operators, JSONPath, updating, GIN index, real-world patterns | ⭐⭐⭐ |
| 17 | [[17-Time-Series-Complete-Guide]] | Schema, partitioning, resampling, gap-filling, BRIN, TimescaleDB, Oracle | ⭐⭐⭐⭐ |

### 🔗 Patterns & Integration

| # | Bài viết | Nội dung chính | Độ khó |
|---|----------|---------------|--------|
| 11 | [[11-PostgreSQL-Redis-Consistency]] | Cache-Aside, Write-Through, CDC invalidation, thundering herd | ⭐⭐⭐ |

---

## 🎯 Learning Paths

### Path A — Engine mastery (Senior/Staff level)
```
01-ACID → 02-MVCC → 08-MVCC-Comparison → 15-Isolation → 03-Concurrency
```

### Path B — SQL power user
```
13-Aggregation → 14-CTE-Recursive → 12-UNION-LIKE → 16-JSONB → 17-TimeSeries
```

### Path C — Production troubleshooting
```
05-Performance → 04-Index → 06-Query-Planner → 07-Count → 03-Concurrency
```

### Path D — System Design / Banking
```
10-Sharding → 15-Isolation → 11-PG-Redis → 17-TimeSeries → 09-Temporal
```

### Path E — Interview preparation
```
01-ACID → 08-MVCC-Comparison → 15-Isolation → 10-Sharding → 03-Concurrency
```

---

## 🔗 Connections sang các cluster khác

- [[Database-Patterns/Hibernate-Performance-Deep-Dive]] — ORM layer trên PostgreSQL
- [[Database-Patterns/JDBC-vs-R2DBC-vs-VirtualThreads]] — Connection model
- [[Microservices-Patterns/Transactional-Outbox]] — Pattern tận dụng PostgreSQL ACID
- [[Microservices-Patterns/Debezium-CDC-Deep-Dive]] — PostgreSQL WAL → CDC
- [[Microservices-Patterns/Cross-Service-Join-AuthZ-Fine-Grained-Filter]] — CDC + cache
- [[_moc/MOC-Database]] — Database tổng quan (schema, sharding, replication)
- [[_moc/MOC-Database-Internals]] — Storage engine level (LSM, B-Tree từ scratch)

---

*Tags: #postgresql #database #hub #moc*
*Updated: 2026-05-07 | Articles: 17*
