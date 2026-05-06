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
                    Practical Application
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
   Concurrency Patterns  Performance          Query Planning
   [[03-Concurrency-Patterns]] [[05-Performance-Tuning]] [[06-Query-Planner]]
```

---

## 📚 Series Articles

### 🔬 Engine Internals

| # | Bài viết | Nội dung chính | Độ khó |
|---|----------|---------------|--------|
| 01 | [[01-ACID-Internals]] | ACID không chỉ là lý thuyết — cơ chế WAL, fsync, crash recovery, isolation level thật sự hoạt động như thế nào | ⭐⭐⭐ |
| 02 | [[02-MVCC-Concurrency]] | MVCC engine: snapshot isolation, visibility rules, dead tuples, vacuum — tại sao PostgreSQL không dùng lock để read | ⭐⭐⭐⭐ |
| 03 | [[03-Concurrency-Patterns]] | Edge cases & bài toán thực tế: lost update, phantom read, serialization failure, FOR UPDATE, SKIP LOCKED, advisory locks | ⭐⭐⭐⭐ |

### ⚡ Performance & Operations

| # | Bài viết | Nội dung chính | Độ khó |
|---|----------|---------------|--------|
| 04 | [[04-Index-Internals]] | B-Tree mechanics, GIN, GiST, BRIN, partial index, covering index, EXPLAIN ANALYZE | ⭐⭐⭐ |
| 05 | [[05-Performance-Tuning]] | Memory config, vacuum, partitioning, anti-patterns, monitoring | ⭐⭐⭐ |
| 06 | [[06-Query-Planner]] | Cost-based optimizer, statistics, join strategies, planner hints | ⭐⭐⭐⭐ |

---

## 🎯 Learning Paths

### Path A — Hiểu engine từ gốc (recommended cho Senior)
```
01-ACID → 02-MVCC → 03-Concurrency → 04-Index → 05-Performance
```

### Path B — Giải quyết vấn đề ngay (Production troubleshooting)
```
05-Performance → 04-Index → 06-Query-Planner → 02-MVCC → 03-Concurrency
```

### Path C — Banking/PDMS context
```
01-ACID (isolation levels) → 03-Concurrency (lost update, FOR UPDATE) → 05-Performance (vacuum, bloat)
```

---

## 🔗 Connections sang các cluster khác

- [[Database-Patterns/Hibernate-Performance-Deep-Dive]] — ORM layer trên PostgreSQL
- [[Database-Patterns/JDBC-vs-R2DBC-vs-VirtualThreads]] — Connection model
- [[Microservices-Patterns/Transactional-Outbox]] — Pattern tận dụng PostgreSQL ACID
- [[Microservices-Patterns/Debezium-CDC-Deep-Dive]] — PostgreSQL WAL → CDC
- [[_moc/MOC-Database]] — Database tổng quan (schema, sharding, replication)
- [[_moc/MOC-Database-Internals]] — Storage engine level (LSM, B-Tree từ scratch)

---

*Tags: #postgresql #database #hub #moc*  
*Created: 2026-05-06*
