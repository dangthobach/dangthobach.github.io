---
tags: [concepts, database, btree, lsm, storage, internals, evergreen]
created: 2026-05-02
difficulty: advanced
estimated-read: 25 min
links: [postgresql-index-internals, query-planner-optimizer]
---

# 🌳 B-Tree vs LSM-Tree — Hai Triết lý Storage Engine

> **Mục tiêu:** Hiểu tại sao PostgreSQL/MySQL dùng B-Tree, còn Cassandra/RocksDB/LevelDB dùng LSM-Tree — và khi nào chọn cái nào.

---

## 🎯 Core Trade-off

```
B-Tree:  Optimize for READS
         Writes update in-place → reads fast (predictable path)
         Write amplification: moderate

LSM-Tree: Optimize for WRITES
          Writes always sequential (append-only) → writes fast
          Read amplification: higher (must check multiple levels)
          Write amplification: higher (compaction rewrites data)
```

---

## 🌳 B-Tree — In-Place Update

### Cấu trúc

```
B-Tree (Balanced Tree):
                    ┌───────────────────┐
                    │  ROOT NODE        │
                    │ [10 | 20 | 30]   │
                    └───┬───────┬───────┘
                        │       │
          ┌─────────────┘       └─────────────┐
          ▼                                   ▼
    ┌──────────────┐                   ┌──────────────┐
    │ INTERNAL     │                   │ INTERNAL     │
    │ [5 | 8]      │                   │ [25 | 28]    │
    └──┬──────┬────┘                   └──┬──────┬────┘
       │      │                          │      │
       ▼      ▼                          ▼      ▼
   ┌──────┐ ┌──────┐                 ┌──────┐ ┌──────┐
   │ LEAF │ │ LEAF │                 │ LEAF │ │ LEAF │
   │[1,3] │ │[6,7] │                 │[22,24│ │[26,29│
   │      │ │      │                 │      │ │      │
   └──────┘ └──────┘                 └──────┘ └──────┘
                 ↑ Leaf nodes linked (doubly linked list)
                   → range scans efficient

Page size: typically 8KB (PostgreSQL), 16KB (MySQL InnoDB)
Branching factor: up to hundreds of keys per node
Depth: 3-4 levels for millions of records (log_B(N))
```

### Write Operation — In-Place Update

```
Write key=15, value="data":

1. Find leaf page containing key range [10-20]
2. Load page from disk (8KB) into buffer pool
3. Modify page in-place (insert key=15)
4. Write WAL (Write-Ahead Log) first
5. Mark page as dirty
6. Eventually flush dirty page to disk (8KB write)

Problem: RANDOM WRITE
→ Key=15 goes to page at address 0x0A200
→ Key=16 might go to page at address 0x3F100 (different location!)
→ Disk seeks (especially HDD): expensive
→ SSD: write amplification due to 4KB page boundaries

Page split when full:
[1|5|8|10|12|15|17] (full)
→ split into [1|5|8] and [10|12|15|17]
→ Update parent node
→ 3 page writes instead of 1 → write amplification
```

### B-Tree in PostgreSQL

```
PostgreSQL uses B-Tree for default indexes:
- Page = 8KB block (called "heap page")
- Index = B-Tree pointing to (page, offset) tuples
- MVCC: multiple versions of same row exist simultaneously

PostgreSQL specific:
- HOT (Heap Only Tuple): update without index change if key unchanged
- Dead tuples: VACUUM needed to reclaim space
- Index bloat: deleted/updated tuples leave dead index entries
```

---

## 📚 LSM-Tree — Log-Structured Merge Tree

### Cấu trúc

```
LSM-Tree Architecture:

MEMORY LEVEL (fast, volatile):
┌─────────────────────────────────────────────────────────────┐
│   MemTable (Active — in memory, sorted)                     │
│   {k=15, v="new"}, {k=3, v="data"}, {k=42, v="val"}        │
│   Write here → O(log n) insert into sorted structure        │
└──────────────────────────┬──────────────────────────────────┘
                           │ Flush when full (~64MB)
                           ▼
DISK LEVELS (immutable, sorted):
Level 0 (L0): Small SSTables, overlapping key ranges
┌──────────┐ ┌──────────┐ ┌──────────┐
│SSTable 1 │ │SSTable 2 │ │SSTable 3 │  (written sequentially!)
│{3,7,15}  │ │{2,8,15}  │ │{1,6,20}  │  (may overlap)
└──────────┘ └──────────┘ └──────────┘
                    │ Compaction (merge + sort)
                    ▼
Level 1 (L1): Larger SSTables, NO overlapping key ranges
┌────────────────────────────────────────────────────────────┐
│              {1,2,3,4,5,6,7,8,10,12,15,18,20}             │
└────────────────────────────────────────────────────────────┘
                    │ Compaction
                    ▼
Level 2 (L2): Even larger, no overlap...
Level 3 (L3): ...
Level N:      Coldest, largest data
```

### SSTable (Sorted String Table)

```
SSTable file (immutable once written):
┌────────────────────────────────────────────────────────────┐
│  DATA BLOCKS                                               │
│  [key=1, val="..."][key=3, val="..."][key=7, val="..."]    │
│  [key=15, val=".."][key=20, val=".."]                      │
├────────────────────────────────────────────────────────────┤
│  INDEX BLOCK (sparse, every N keys)                        │
│  [key=1 → offset=0][key=15 → offset=4096]                  │
├────────────────────────────────────────────────────────────┤
│  BLOOM FILTER                                              │
│  "Is key=42 in this SSTable?" → NO (no false negatives)    │
│  (Probabilistic: may have false positives, never false neg)│
├────────────────────────────────────────────────────────────┤
│  METADATA                                                  │
│  min_key=1, max_key=20, level=1, sequence=102              │
└────────────────────────────────────────────────────────────┘
```

### Write Operation — Sequential Append

```
Write key=15, value="data":
1. Write to WAL (sequential append) — for crash recovery
2. Insert into MemTable (sorted in-memory, e.g., SkipList) — O(log n)
3. Return immediately to client!

ALWAYS sequential writes:
→ WAL = append to file
→ MemTable flush = sequential file write
→ Compaction = read + sort + sequential write
→ HDD/SSD: optimal sequential I/O

No random writes → No seek overhead → Extremely fast writes
```

### Read Operation — Multiple Levels

```
Read key=15:
1. Check MemTable first (most recent)       → miss
2. Check L0 SSTables (check Bloom Filter first!)
   SSTable-1 Bloom: "15 present?" → Yes (check SSTable)
   SSTable-1 Index: find offset for key=15
   SSTable-1 Data: read key=15 value         → HIT! Return.
   
   If miss in L0:
3. Check L1 (no overlap → binary search on SSTable index)
4. Check L2...
5. Check L3... (worst case: O(level_count) reads)

Read Amplification: 1 logical read = N physical reads (across levels)
→ Bloom Filters critical: avoid reading SSTables that don't have key
```

---

## ⚖️ Amplification Factors

```
Read Amplification:
B-Tree:   1-3 page reads (O(log_B N)) → very predictable, fast
LSM-Tree: L0 count + 1 per level → 5-10+ reads → slower for point reads

Write Amplification:
B-Tree:   ~2-4x (page write + WAL + potential page split)
LSM-Tree: ~10-30x (WAL + memtable + multiple compaction levels)
          Data written once → rewritten in compaction N times

Space Amplification:
B-Tree:   ~1.2-2x (free space in pages for future inserts)
LSM-Tree: ~1.1-1.5x in theory, but compaction-in-progress can be 2x

                B-Tree      LSM-Tree
Read (point):   FAST        SLOWER (but Bloom Filter helps)
Read (range):   FAST        FAST (data sorted within SSTable)
Write:          SLOWER      VERY FAST
Space:          Moderate    Moderate (depends on compaction)
Delete:         Tombstone   Tombstone (compaction removes eventually)
```

---

## 🗄️ Real-World Systems

| System | Storage Engine | Reason |
|--------|---------------|--------|
| PostgreSQL | B-Tree (heap) | ACID, random reads/writes |
| MySQL InnoDB | B-Tree | ACID, wide compatibility |
| SQLite | B-Tree | Embedded, ACID |
| RocksDB | LSM-Tree | Write-heavy, key-value |
| Cassandra | LSM-Tree | Write-heavy, time-series |
| LevelDB | LSM-Tree | Embedded key-value |
| HBase | LSM-Tree (HDFS) | Write-heavy, Big Data |
| ScyllaDB | LSM-Tree | High-throughput writes |
| MongoDB | WiredTiger (B-Tree) | Mixed workload |
| CockroachDB | RocksDB (LSM) | Distributed, key-value layer |

---

## 🔬 Compaction Strategies (LSM)

```
LEVELED COMPACTION (RocksDB default, Cassandra):
→ Each level has a size limit
→ When L(n) exceeds limit: pick SSTable, merge with L(n+1)
→ L(n+1) always sorted, no overlap within level
→ Read: check 1 SSTable per level max
→ Space amplification: low
→ Write amplification: HIGH (re-merge at every level)

TIERED COMPACTION (Cassandra default, size-tiered):
→ Group SSTables of similar size
→ When N similar-size SSTables: merge into 1 larger
→ Read: may need to check multiple same-size SSTables
→ Space amplification: HIGH (temporary during compaction)
→ Write amplification: LOW

TWCS (Time-Window Compaction Strategy, Cassandra):
→ Designed for time-series data
→ Group SSTables by time window (e.g., 1 day)
→ Old time windows: rarely compacted (data doesn't change)
→ Best for: IoT, logs, metrics (append-only by time)
```

---

## 💡 Tips & Tricks

> **Tip 1 — PostgreSQL VACUUM và B-Tree bloat**
> ```sql
> -- Check index bloat
> SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename))
> FROM pg_tables WHERE schemaname = 'public' ORDER BY pg_total_relation_size DESC;
>
> -- Manual vacuum (full rewrite)
> VACUUM FULL documents; -- locks table!
>
> -- Non-locking alternative: pg_repack extension
> pg_repack --table documents my_database
>
> -- Auto-vacuum tuning for high-update tables:
> ALTER TABLE documents SET (
>   autovacuum_vacuum_scale_factor = 0.01, -- vacuum at 1% dead tuples
>   autovacuum_analyze_scale_factor = 0.005
> );
> ```

> **Tip 2 — RocksDB tuning for write-heavy**
> ```
> # Key RocksDB parameters
> write_buffer_size = 256MB   # MemTable size before flush
> max_write_buffer_number = 3  # Max MemTables in memory
> level0_file_num_compaction_trigger = 4  # L0 SSTable count to trigger compaction
> target_file_size_base = 64MB  # SSTable target size
>
> # For extreme write performance:
> # Increase write_buffer_size → flush less frequently
> # Increase max_write_buffer_number → more in-memory before flush
> ```

> **Tip 3 — PostgreSQL vs Cassandra decision**
> ```
> Choose PostgreSQL (B-Tree) when:
> - ACID transactions required
> - Complex SQL queries (JOINs, aggregations)
> - Read/write balance
> - < 10TB data
>
> Choose Cassandra (LSM) when:
> - Write-heavy (> 80% writes)
> - Time-series, IoT, logs
> - Need massive horizontal scale
> - Geo-distributed writes
> - Tolerate eventual consistency
> ```

---

## 🔬 Case Studies

### Case Study 1: Discord — PostgreSQL → Cassandra
```
Discord message storage:
- 2016: PostgreSQL → 100M messages total → OK
- 2017: 100M messages/day → PostgreSQL random writes lagging
- Problem: Messages table → random writes to B-Tree pages
  As table grows: more page splits, more WAL, more VACUUM

Migration to Cassandra:
- Messages partitioned by (channel_id, bucket_time)
- LSM writes: sequential → fast regardless of table size
- Trade-off: message read requires knowing channel + time range
- Result: 1 billion messages/day without write bottleneck

Lesson: Write-heavy, time-ordered data → LSM wins
```

### Case Study 2: PDMS — Document Metadata Storage
```
PDMS document metadata:
- Pattern: Write once (create), update rarely (status change), read often
- Access pattern: by ID, by customer, by date range
- Size: ~10M records

Decision: PostgreSQL (B-Tree) ✅
Reasons:
- Complex queries: JOIN with customers, branch, approval history
- ACID required: document status changes are financial operations
- Read-heavy: document retrieval >> document creation
- Write pattern: not time-series, not hyper-write

If PDMS had audit logs (100M events/day):
→ Consider Cassandra/TimescaleDB for audit log table
→ PostgreSQL for main document metadata
→ Hybrid architecture
```

### Case Study 3: Bloom Filters in Practice
```
Cassandra read path:
Query: "Get document with id=12345"

L0 SSTables (5 files):
→ Bloom filter for file 1: "12345?" → NO (skip file entirely!)
→ Bloom filter for file 2: "12345?" → YES (possible hit)
   → Check index, read data block → FOUND!
→ Files 3,4,5: skipped by Bloom filter

Without Bloom filter: 5 SSTable reads
With Bloom filter: 1-2 SSTable reads
FPR (False Positive Rate): ~1% default → 1% unnecessary reads
Memory cost: ~10 bits/key → 10M keys = 12.5MB

Huge performance win for read path of LSM systems
```

---

## 📝 Key Takeaways

1. **B-Tree** = in-place update, balanced tree, great for reads + ACID
2. **LSM-Tree** = append-only writes, sequential I/O, great for high write throughput
3. **MemTable** = in-memory sorted buffer (LSM) — writes go here first
4. **SSTable** = immutable sorted file on disk (LSM) — flushed from MemTable
5. **Compaction** = merge SSTables, remove duplicates/tombstones
6. **Bloom Filter** = probabilistic filter to skip SSTable reads (LSM)
7. **B-Tree page split** = write amplification → VACUUM needed for PostgreSQL
8. **Read amplification** = LSM weakness, mitigated by Bloom Filters + caching
9. **Choose B-Tree** for ACID, complex queries, read-heavy workloads
10. **Choose LSM** for write-heavy, time-series, horizontal scale

---

## 🔗 Liên kết

- [[postgresql-index-internals]] — PostgreSQL B-Tree index mechanics
- [[Performance-System-Programming/01-Database-Internals/04-SSTable-Format]] — SSTable format deep dive
- [[Performance-System-Programming/01-Database-Internals/05-Memtable-SkipList]] — MemTable implementation
- [[Performance-System-Programming/01-Database-Internals/01-Bitcask-Architecture]] — Simple LSM-like engine
- [[concepts/postgresql-performance-deep-dive]] — PostgreSQL performance in practice
