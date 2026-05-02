---
tags: [moc, database, postgresql, sql, nosql]
---

# 🗄️ MOC — Database

> **Mục tiêu:** Từ lý thuyết schema design → index internals → query optimization → scaling strategy. Kết nối trực tiếp với công việc PostgreSQL stored procedures trong PDMS.

---

## 🏗️ Schema Design

- [[Notion Knowledge/Note/A Crash Course on Relational Database Design|Relational Database Design Crash Course]]
  → ER model, normalization 1NF→3NF, keys, constraints. Nền tảng trước khi đi vào advanced topics.
- [[Notion Knowledge/Note/Database Schema Design Simplified- Normalization vs Denormalization|Normalization vs Denormalization]]
  → Khi nào normalize (OLTP), khi nào denormalize (analytics, read-heavy). Trade-off cụ thể với ví dụ.
- [[Notion Knowledge/Note/SQL vs NoSQL- Choosing the Right Database for An Application|SQL vs NoSQL]]
  → Không phải "NoSQL tốt hơn" hay ngược lại. Framework ra quyết định dựa trên data model, consistency, query patterns.
- [[Notion Knowledge/Note/Understanding Database Types|Understanding Database Types]]
  → Relational, Document, Key-Value, Column-family, Graph, Time-series, Search. Use case của từng loại.
- [[Notion Knowledge/Note/Key Steps in the Database Selection Process|Database Selection Process]]
  → Step-by-step: workload analysis → consistency requirements → query patterns → operational overhead → final decision.

---

## 📊 Indexing

- [[Notion Knowledge/Note/Database Index Internals- Understanding the Data Structures|Index Internals — Data Structures]]
  → B-tree (sorted, range queries), Hash (equality only), LSM-tree (write-optimized), GIN (full-text, array), BRIN (time-series). Cơ chế hoạt động bên trong.
- [[Notion Knowledge/Note/Database Indexing Demystified- Index Types and Use-Cases|Indexing Demystified — Types & Use-Cases]]
  → Clustered vs Non-clustered, Covering index, Partial index, Composite index. Khi nào index gây hại.
- [[Notion Knowledge/Note/Unlocking the Power of SQL Queries for Improved Performance|SQL Query Performance]]
  → EXPLAIN ANALYZE, index scan vs seq scan, join strategies (Hash Join, Merge Join, Nested Loop). Query rewriting patterns.

---

## ⚡ Performance & Optimization

- [[Notion Knowledge/Note/Database Performance Demystified- Essential Tips and Strategies|Database Performance Demystified]]
  → Connection pooling, N+1 queries, query plan analysis, vacuum strategy (PostgreSQL), statistics update.
- [[Notion Knowledge/Note/Material view|Materialized Views]]
  → Khi nào dùng materialized view vs regular view vs application-level cache. Refresh strategies: full vs incremental.
- [[Notion Knowledge/Note/A Guide to Database Transactions- From ACID to Concurrency Control|Database Transactions: ACID to Concurrency Control]]
  → ACID properties chi tiết. Isolation levels: Read Uncommitted → Serializable. Phantom reads, dirty reads. Row-level locking vs MVCC. **Cực kỳ relevant với stored procedures PDMS.**

---

## 📈 Scaling

### Sharding
- [[Notion Knowledge/Note/A Crash Course in Database Scaling Strategies|DB Scaling Strategies Crash Course]]
  → Vertical vs Horizontal scaling. Read replicas. Sharding. Connection pooling (PgBouncer).
- [[Notion Knowledge/Note/A Crash Course in Database Sharding|DB Sharding Crash Course]]
  → Range vs Hash vs Directory-based sharding. Hotspot problem. Cross-shard queries.
- [[Notion Knowledge/Note/A Guide to Database Sharding- Key Strategies|DB Sharding Guide — Key Strategies]]
  → Shard key selection, resharding, consistent hashing cho sharding. Trade-offs mỗi strategy.

### Replication
- [[Notion Knowledge/Note/A Guide to Database Replication- Key Concepts and Strategies|DB Replication Guide]]
  → Master-slave, synchronous vs asynchronous, replication lag, read-after-write consistency.
- [[Notion Knowledge/Note/How to Choose a Replication Strategy|Replication Strategy Decision]]
  → RPO (Recovery Point Objective) và RTO (Recovery Time Objective) → chọn strategy phù hợp.

### Caching Layer
- [[Notion Knowledge/Note/A Guide to Top Caching Strategies|Top Caching Strategies]]
  → Cache-aside, Read-through, Write-through, Write-behind. Eviction policies: LRU, LFU, TTL.
- [[Notion Knowledge/Note/Distributed Caching- The Secret to High-Performance Applications|Distributed Caching]]
  → Redis vs Memcached. Consistent hashing trong caching. Cache stampede, thundering herd prevention.

---

## 🔄 Case Studies

- [[Notion Knowledge/Note/How Atlassian Migrated 4 Million Jira Databases to AWS Aurora|Atlassian: 4M Jira DBs → Aurora]]
  → Large-scale migration strategy. Zero-downtime migration. Schema compatibility. **Relevant với PDMS migration.**

---

## 🔗 Liên kết

- [[MOC-Distributed-Systems]] — Replication, consistency trong distributed context
- [[MOC-System-Design]] — DB là một layer trong system design
- [[MOC-PDMS]] — PostgreSQL stored procedures, batch validation, ETL pipeline
- [[Rust-Zero-To-Hero/Bai-12-SQLx-Database|Bài 12: SQLx]] — Rust database layer

---

## ⚡ Query Optimization (Deep Dive)

- [[Notion Knowledge/Note/SQL Query Optimization — From Simple to Complex|⭐ SQL Query Optimization — From Simple to Complex]]
  → Mental model hoàn chỉnh: query lifecycle → EXPLAIN ANALYZE → Layer 1-5 từ simple đến bulk ops 10M+ records. PostgreSQL tricks: LATERAL, FILTER, covering index, UPSERT chaining, parallel query. Pattern áp dụng trực tiếp vào PDMS batch validation.
