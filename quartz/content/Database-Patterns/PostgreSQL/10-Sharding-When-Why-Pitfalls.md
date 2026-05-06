# 10 — Sharding: Khi Nào, Vấn Đề Phiền Toái, và Giải Pháp

> **Audience:** Senior engineers đang scale database lên hàng chục/trăm triệu records hoặc evaluating sharding.  
> **Scope:** Sharding decision framework, các chiến lược, pain points thực tế, và alternatives.  
> **Liên kết:** [[05-Performance-Tuning]] | [[00-PostgreSQL-Hub]] | [[_moc/MOC-Database]]

---

## 📋 Mục lục

1. [Sharding là gì và không phải gì](#1-sharding-là-gì-và-không-phải-gì)
2. [Khi nào CẦN sharding — Decision ladder](#2-khi-nào-cần-sharding)
3. [Các chiến lược sharding](#3-các-chiến-lược-sharding)
4. [Pain points — Những vấn đề phiền toái nhất](#4-pain-points)
5. [Giải pháp cho từng pain point](#5-giải-pháp)
6. [PostgreSQL-specific: Table Partitioning vs Sharding](#6-postgresql-partitioning-vs-sharding)
7. [Alternatives trước khi shard](#7-alternatives-trước-khi-shard)
8. [PDMS Banking Context](#8-pdms-banking-context)

---

## 1. Sharding là gì và không phải gì

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Sharding Definition                                │
│                                                                      │
│  Sharding = Horizontal partitioning ACROSS MULTIPLE DATABASE NODES   │
│                                                                      │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐          │
│  │Shard 0  │    │Shard 1  │    │Shard 2  │    │Shard 3  │          │
│  │node:    │    │node:    │    │node:    │    │node:    │          │
│  │db-0.svc │    │db-1.svc │    │db-2.svc │    │db-3.svc │          │
│  │         │    │         │    │         │    │         │          │
│  │users    │    │users    │    │users    │    │users    │          │
│  │id 0-24% │    │id 25-49%│    │id 50-74%│    │id 75-99%│          │
│  └─────────┘    └─────────┘    └─────────┘    └─────────┘          │
│                                                                      │
│  NOT Sharding:                                                       │
│  - Read replicas (replication) — same data, multiple nodes          │
│  - Table partitioning — different tables, SAME database node        │
│  - Vertical scaling — bigger machine                                │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. Khi nào CẦN sharding

**Sharding là giải pháp CUỐI CÙNG** — đừng shard sớm. Trước khi shard, hãy leo qua từng bậc thang:

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Scaling Decision Ladder                           │
│                                                                      │
│  Bậc 1: Optimize queries + indexes                                   │
│  → EXPLAIN ANALYZE, partial index, covering index                    │
│  → Chi phí: 0, thời gian: hours-days                                 │
│  → Nên đạt: query < 100ms cho 99th percentile                       │
│                                                                      │
│  Bậc 2: Connection pooling (PgBouncer)                               │
│  → Xử lý nhiều concurrent connections với ít DB connections          │
│  → Nên đạt: 10K+ concurrent clients                                  │
│                                                                      │
│  Bậc 3: Read replicas                                                │
│  → Offload read queries (analytics, reports)                         │
│  → Nên đạt: xử lý 80% reads từ replicas                             │
│                                                                      │
│  Bậc 4: Vertical scaling (bigger machine)                            │
│  → Tăng RAM (shared_buffers, cache hit), CPU (parallel query)        │
│  → Nên đạt: 256GB-1TB RAM, 64+ cores trên cloud                    │
│                                                                      │
│  Bậc 5: Table partitioning (SAME node)                               │
│  → Partition pruning, parallel partition scan                        │
│  → Nên đạt: tables 100GB-10TB                                       │
│                                                                      │
│  Bậc 6: Caching layer (Redis/Memcached)                              │
│  → Hot data trong memory, bypass DB cho repeated reads              │
│                                                                      │
│  Bậc 7: SHARDING ← Chỉ đến đây khi tất cả trên không đủ            │
│  → Khi single node không thể handle write throughput                │
│  → Khi data > 10TB và partitioning không đủ                         │
└──────────────────────────────────────────────────────────────────────┘
```

### Signals cho thấy cần sharding

```
✓ Write throughput bão hòa: ~10K-50K writes/sec trên single powerful node
✓ Data size > 5-10TB và tiếp tục tăng nhanh
✓ Vertical scaling không còn cost-effective
✓ Replication lag tăng cao (replicas không catch up)
✓ Single point of failure không chấp nhận được (geography, compliance)

✗ "Bảng có 10M rows" → KHÔNG cần shard
✗ "Query chậm" → optimize trước
✗ "Muốn scale" → replicas + partitioning trước
```

---

## 3. Các chiến lược sharding

### Strategy 1: Range Sharding

```
Shard key: user_id hoặc created_at

Shard 0: user_id 0 → 999,999
Shard 1: user_id 1,000,000 → 1,999,999
Shard 2: user_id 2,000,000 → 2,999,999

┌────────────────────────────────────────────────────────────┐
│  Pros:                                                      │
│  ✓ Simple routing: shard = (id / shard_size)                │
│  ✓ Range queries efficient (same shard)                    │
│  ✓ Easy to add new shards (append range)                   │
│                                                            │
│  Cons:                                                     │
│  ✗ Hotspot: new users → always last shard                  │
│  ✗ Uneven distribution nếu data không uniform              │
│                                                            │
│  Best for: Time-series, append-only data, archive          │
└────────────────────────────────────────────────────────────┘
```

### Strategy 2: Hash Sharding

```
Shard key: user_id (hoặc tenant_id)

shard_number = hash(user_id) % num_shards

user_id=1001 → hash → shard 2
user_id=1002 → hash → shard 0
user_id=1003 → hash → shard 3
user_id=1004 → hash → shard 2

┌────────────────────────────────────────────────────────────┐
│  Pros:                                                     │
│  ✓ Even distribution (no hotspot)                          │
│  ✓ Simple routing formula                                  │
│                                                            │
│  Cons:                                                     │
│  ✗ Range queries → scatter-gather (hit all shards)         │
│  ✗ Resharding rất khó (% num_shards đổi → re-route all)   │
│                                                            │
│  Best for: Random access patterns, no range queries        │
└────────────────────────────────────────────────────────────┘
```

### Strategy 3: Consistent Hashing

```
Virtual ring (0 → 2^32):

         0 (= 2^32)
         │
    Shard D ●──────────────● Shard A
             \            /
              \          /
       Shard C ●────────● Shard B

Data key → hash → position trên ring → nearest shard

┌────────────────────────────────────────────────────────────┐
│  Pros:                                                     │
│  ✓ Add/remove shard: chỉ re-route ~1/N data                │
│  ✓ Gradual rebalancing                                     │
│  ✓ Virtual nodes giúp even distribution                    │
│                                                            │
│  Cons:                                                     │
│  ✗ Complex implementation                                  │
│  ✗ Vẫn khó cho cross-shard queries                         │
│                                                            │
│  Best for: Elastic scaling, Cassandra/DynamoDB style       │
└────────────────────────────────────────────────────────────┘
```

### Strategy 4: Directory (Lookup) Sharding

```
Shard routing table (separate lookup service):

┌────────────────────────────────────────┐
│  Routing Table (in Redis/DB):          │
│  tenant_id=VPB → shard 0              │
│  tenant_id=TCB → shard 1              │
│  tenant_id=ACB → shard 0              │
│  tenant_id=MBB → shard 2              │
└────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│  Pros:                                                     │
│  ✓ Flexible: move any entity to any shard                  │
│  ✓ Good for multi-tenant (bank → shard)                    │
│  ✓ Hot tenants có thể có shard riêng                       │
│                                                            │
│  Cons:                                                     │
│  ✗ Routing table là single point of failure                │
│  ✗ Extra lookup per request                                │
│  ✗ Routing table cần highly available                      │
│                                                            │
│  Best for: Multi-tenant SaaS, B2B                          │
└────────────────────────────────────────────────────────────┘
```

---

## 4. Pain Points

### Pain Point 1: Cross-shard queries — Kẻ thù số 1

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Cross-Shard Query Problem                          │
│                                                                      │
│  Bảng orders sharded by user_id (hash):                              │
│  Shard 0: user 1001's orders                                         │
│  Shard 1: user 1002's orders                                         │
│  Shard 2: user 1003's orders                                         │
│                                                                      │
│  Query: "Tổng revenue hôm nay across all users"                      │
│  SELECT SUM(amount) FROM orders WHERE created_at = TODAY             │
│                                                                      │
│  → Phải query TẤT CẢ shards → scatter-gather                        │
│  → Aggregation ở application layer                                   │
│  → Latency = max(latency_shard_0, latency_shard_1, ...) + agg time  │
│                                                                      │
│  Nếu 100 shards → 100 parallel queries → coordination overhead       │
└──────────────────────────────────────────────────────────────────────┘
```

### Pain Point 2: Cross-shard JOINs — Gần như không thể

```sql
-- ❌ Không thể JOIN giữa shards ở DB level:
-- orders.user_id trên Shard 0
-- users.id trên Shard 2

SELECT u.name, o.amount
FROM users u JOIN orders o ON u.id = o.user_id
WHERE o.status = 'PENDING';

-- → Phải làm ở application:
-- 1. Query orders trên all order shards
-- 2. Collect unique user_ids
-- 3. Query users trên all user shards
-- 4. Join trong application memory
-- → N+1 problem tệ hơn nhiều
```

### Pain Point 3: Resharding — Nightmare

```
Bắt đầu với 4 shards (hash % 4):
  user_id=1001 → 1001 % 4 = 1 → Shard 1

Cần scale lên 8 shards (hash % 8):
  user_id=1001 → 1001 % 8 = 1 → Shard 1 (OK, không cần move)
  user_id=1003 → 1003 % 4 = 3 → Shard 3 (cũ)
               → 1003 % 8 = 3 → Shard 3 (trùng, OK)
  user_id=1002 → 1002 % 4 = 2 → Shard 2 (cũ)
               → 1002 % 8 = 2 → Shard 2 (trùng, OK)
  user_id=1000 → 1000 % 4 = 0 → Shard 0 (cũ)
               → 1000 % 8 = 0 → Shard 0 (trùng, OK)

  Nhưng: user_id=1006 → 1006 % 4 = 2 (cũ: Shard 2)
                       → 1006 % 8 = 6 (mới: Shard 6) ← PHẢI MOVE!

  → 50% data phải di chuyển khi nhân đôi số shards
  → Trong quá trình di chuyển: write cũ hay mới?
  → Consistency nightmare
```

### Pain Point 4: Distributed transactions

```
Transfer tiền giữa 2 users khác shard:
  user_A → Shard 0
  user_B → Shard 3

  Atomic transfer cần:
  1. BEGIN TRANSACTION ← không thể native across shards
  2. Deduct from user_A (Shard 0)
  3. Add to user_B (Shard 3)
  4. COMMIT

  → Phải dùng 2-Phase Commit (2PC) hoặc Saga pattern
  → 2PC: blocking, performance overhead, coordinator SPOF
  → Saga: complex compensation logic, eventual consistency
```

### Pain Point 5: Auto-increment ID phá vỡ

```sql
-- BIGSERIAL/SERIAL không work across shards → duplicate IDs!

Shard 0: INSERT → id=1, 2, 3, 4...
Shard 1: INSERT → id=1, 2, 3, 4... ← CONFLICT!

-- Solutions:
-- 1. Snowflake ID (Twitter): timestamp + datacenter + sequence
-- 2. UUID v4: globally unique, không sortable (index fragmentation)
-- 3. UUID v7: time-ordered, globally unique (PG 17+)
-- 4. Centralized ID service (bottleneck!)
```

---

## 5. Giải pháp

### Giải pháp cho Cross-shard queries

```
Pattern 1: Denormalization — pre-aggregate tại write time
  → Khi write order: cũng update shard của user với running total
  → Trade: write complexity vs read simplicity

Pattern 2: CQRS + Materialized aggregation
  → Write path: shard by user_id
  → Read path: separate analytics DB tổng hợp từ CDC events
  → Debezium → Kafka → ClickHouse/BigQuery cho analytics
  → Trade: eventual consistency, infrastructure complexity

Pattern 3: Choose shard key aligned với query patterns
  → Shard by tenant_id nếu hầu hết queries filter by tenant
  → Queries within tenant = single shard = fast
  → Cross-tenant queries = scatter-gather (ít phổ biến hơn)
```

### Giải pháp cho Resharding

```
Consistent Hashing:
  → Add new shard → chỉ 1/N data cần move
  → Virtual nodes giúp smooth rebalancing
  → Libraries: Apache Cassandra token ring, libketama

Gradual migration:
  Phase 1: Setup new shards, start dual-writing
  Phase 2: Background backfill old data to new distribution
  Phase 3: Verify consistency
  Phase 4: Switch reads to new distribution
  Phase 5: Remove old shards
```

### Giải pháp cho Distributed transactions

```
Option A: Saga Pattern (choreography/orchestration)
  → Split transaction thành local transactions + compensating transactions
  → Eventual consistency, không phải strong consistency
  → Xem: [[Microservices-Patterns/Saga-Pattern]]

Option B: 2-Phase Commit (2PC)
  → Strong consistency nhưng blocking
  → PostgreSQL postgres_fdw hỗ trợ limited 2PC
  → Dùng khi consistency quan trọng hơn availability

Option C: Avoid cross-shard writes by design
  → Shard key chọn sao cho related entities cùng shard
  → user + user's orders + user's payments cùng shard
  → Denormalize để tránh cross-shard dependency
```

### Giải pháp cho ID generation

```java
// Snowflake ID (giải pháp phổ biến nhất)
// Format: 41-bit timestamp | 10-bit node_id | 12-bit sequence
// ~4096 IDs/ms per node, sortable, 69 years

// Spring Boot implementation (Twitter Snowflake):
@Component
public class SnowflakeIdGenerator {
    private final long nodeId;
    private long lastTimestamp = -1L;
    private long sequence = 0L;

    public synchronized long nextId() {
        long timestamp = System.currentTimeMillis();
        if (timestamp == lastTimestamp) {
            sequence = (sequence + 1) & 0xFFF;  // 12 bits
            if (sequence == 0) {
                // sequence overflow → wait next millisecond
                while (timestamp <= lastTimestamp)
                    timestamp = System.currentTimeMillis();
            }
        } else {
            sequence = 0L;
        }
        lastTimestamp = timestamp;
        return ((timestamp - EPOCH) << 22) | (nodeId << 12) | sequence;
    }
}

// PostgreSQL 17+: UUID v7 (built-in)
SELECT gen_random_uuid();         -- UUID v4 (random)
-- UUID v7 requires PG17+ or extension
```

---

## 6. PostgreSQL: Table Partitioning vs Sharding

Trước khi shard, hãy dùng PostgreSQL native partitioning — nhẹ hơn nhiều:

```
┌──────────────────────────────────────────────────────────────────────┐
│            Partitioning vs Sharding Comparison                        │
│                                                                      │
│  Aspect              │ Table Partitioning     │ Sharding             │
│  ────────────────────┼─────────────────────── ┼───────────────────── │
│  Physical location   │ Same PostgreSQL node   │ Multiple DB nodes    │
│  JOIN                │ Native SQL JOIN ✓       │ Application-level ✗  │
│  Transactions        │ ACID native ✓           │ Distributed txn ✗    │
│  Cross-part queries  │ Parallel scans ✓        │ Scatter-gather ✗     │
│  Complexity          │ Low                    │ Very High            │
│  Max scale           │ Single node            │ Unlimited (theory)   │
│  DETACH partition    │ Move to another table  │ N/A                  │
│  Setup               │ Minutes                │ Weeks-months         │
│                                                                      │
│  Partitioning handles: 100GB-10TB on a powerful node                 │
│  Sharding needed: > 10TB OR write throughput > node capacity         │
└──────────────────────────────────────────────────────────────────────┘
```

```sql
-- PostgreSQL Partitioning (đủ cho hầu hết use cases):
CREATE TABLE documents (
    id          BIGSERIAL,
    branch_id   TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL,
    ...
) PARTITION BY RANGE (created_at);

CREATE TABLE documents_2024 PARTITION OF documents
    FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

CREATE TABLE documents_2025 PARTITION OF documents
    FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');

-- Pruning: WHERE created_at > '2025-01-01' → chỉ scan documents_2025
-- JOIN: vẫn là SQL JOIN thường — transparent!
```

---

## 7. Alternatives trước khi shard

```
Thay vì shard, hãy thử theo thứ tự:

1. Read replicas + smart routing
   → 80% queries thường là reads → replicas giảm load chính
   → PgBouncer với read/write split

2. Table partitioning (range by date)
   → Partition pruning cho time-series queries
   → DETACH old partitions sang archive storage
   → Parallel partition scan cho analytics

3. Caching layer (Redis)
   → Hot documents, session data, computed aggregates
   → Write-through với TTL
   → Giảm 60-90% DB reads trong nhiều use cases

4. Vertical scaling
   → Cloud: r6g.16xlarge (512GB RAM) đủ cho hầu hết workloads
   → M series Mac Pro có 192GB RAM!
   → shared_buffers lớn → almost everything in memory

5. Dedicated analytics database
   → OLTP: PostgreSQL (normalized, low latency)
   → OLAP: ClickHouse / BigQuery / Redshift (columnar, analytics)
   → CDC (Debezium) sync từ PG → analytics DB
   → Xem: [[Microservices-Patterns/Debezium-CDC-Deep-Dive]]

6. Citus (PostgreSQL extension)
   → Sharding native trong PostgreSQL ecosystem
   → SQL interface vẫn như PostgreSQL
   → Transparent sharding, không cần rewrite app
   → Good middle ground trước khi custom shard
```

---

## 8. PDMS Banking Context

```
PDMS hiện tại và tương lai gần:
  Scale: ~10-50M documents (VPBank)
  Write: vài nghìn documents/day
  Read: search + reporting

  → KHÔNG cần sharding
  → Table partitioning by created_at (range, yearly/quarterly)
  → Read replicas cho reporting
  → PgBouncer cho connection pooling
  → Redis cache cho hot documents

Khi nào PDMS có thể cần sharding:
  Scale đến hàng tỷ documents (toàn hệ thống banking)
  Write throughput > 100K/day sustained
  Multi-tenancy với isolation requirements
  Data sovereignty (chi nhánh nước ngoài)

Recommended approach nếu cần scale:
  1. Partition by (branch_region, year)
  2. Separate PostgreSQL nodes per region (directory sharding by region)
  3. Citus extension nếu cần transparent sharding
  4. Cross-region queries → analytics DB (Debezium → ClickHouse)
```

---

## Related Notes

- [[05-Performance-Tuning]] — Partitioning chi tiết trong PostgreSQL
- [[_moc/MOC-Database]] — Database scaling tổng quan (replication, sharding)
- [[Microservices-Patterns/Debezium-CDC-Deep-Dive]] — CDC cho analytics shard
- [[Microservices-Patterns/Saga-Pattern]] — Distributed transactions across shards

---

*Tags: #postgresql #sharding #scaling #partitioning #distributed-systems*  
*Created: 2026-05-06 | Difficulty: ⭐⭐⭐⭐*
