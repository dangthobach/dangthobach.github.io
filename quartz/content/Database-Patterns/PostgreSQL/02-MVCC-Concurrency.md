# 02 — MVCC & Concurrency Engine: Bên Trong PostgreSQL

> **Audience:** Senior engineers muốn hiểu tại sao PostgreSQL scale tốt cho concurrent workloads.  
> **Scope:** MVCC mechanics, snapshot model, visibility rules, dead tuples, vacuum lifecycle.  
> **Liên kết:** [[01-ACID-Internals]] | [[03-Concurrency-Patterns]] | [[00-PostgreSQL-Hub]]

---

## 📋 Mục lục

1. [Tại sao cần MVCC?](#tại-sao-cần-mvcc)
2. [Tuple Versioning — mỗi row có nhiều phiên bản](#tuple-versioning--mỗi-row-có-nhiều-phiên-bản)
3. [Transaction ID (XID) và Snapshot](#transaction-id-xid-và-snapshot)
4. [Visibility Rules — PostgreSQL thấy gì?](#visibility-rules--postgresql-thấy-gì)
5. [Dead Tuples và Vacuum](#dead-tuples-và-vacuum)
6. [HOT Update — Optimization quan trọng](#hot-update--optimization-quan-trọng)
7. [MVCC và Index — Complication](#mvcc-và-index--complication)
8. [Transaction ID Wraparound — Kịch bản nguy hiểm](#transaction-id-wraparound--kịch-bản-nguy-hiểm)

---

## Tại sao cần MVCC?

Traditional locking approach có vấn đề:

```
Traditional 2PL (Two-Phase Locking):
  ┌──────────────────────────────────────────────────┐
  │  Reader phải chờ Writer (shared/exclusive lock)  │
  │  Writer phải chờ Reader                          │
  │                                                  │
  │  → High contention → low throughput              │
  │  → Deadlock risk                                 │
  └──────────────────────────────────────────────────┘

MVCC (Multi-Version Concurrency Control):
  ┌──────────────────────────────────────────────────┐
  │  Reader KHÔNG block Writer                       │
  │  Writer KHÔNG block Reader                       │
  │                                                  │
  │  → Concurrent reads/writes không conflict        │
  │  → "Time travel" — mỗi transaction thấy         │
  │    consistent snapshot của quá khứ               │
  └──────────────────────────────────────────────────┘
```

Đây là lý do PostgreSQL handle concurrent workloads tốt hơn MySQL MyISAM (table-level locking) và comparable với InnoDB (row-level locking + MVCC).

---

## Tuple Versioning — mỗi row có nhiều phiên bản

PostgreSQL không update-in-place. Mỗi UPDATE tạo ra **row version mới (tuple)** và mark row cũ là "deleted".

### Anatomy of a Tuple

```
┌──────────────────────────────────────────────────────────────────┐
│                    PostgreSQL Tuple (Row)                         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    Tuple Header (23 bytes)                  │  │
│  │                                                            │  │
│  │  xmin:  TransactionID — XID của transaction tạo tuple này  │  │
│  │  xmax:  TransactionID — XID của transaction xóa/update     │  │
│  │                         (0 nếu tuple còn "live")           │  │
│  │  ctid:  ItemPointer — trỏ tới version mới nhất của tuple   │  │
│  │  infomask: flags (committed, aborted, frozen, v.v.)        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    Tuple Data                              │  │
│  │  col1 | col2 | col3 | ...                                  │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### UPDATE = INSERT mới + Mark cũ là dead

```sql
-- Ban đầu
INSERT INTO accounts(id, balance) VALUES ('A', 1000);
-- Tạo tuple: (xmin=100, xmax=0, id='A', balance=1000)

-- Session B (XID=200) update
UPDATE accounts SET balance = 800 WHERE id = 'A';
-- Tuple cũ: (xmin=100, xmax=200, id='A', balance=1000)  ← dead sau khi Tx200 commit
-- Tuple mới: (xmin=200, xmax=0,   id='A', balance=800)  ← live
```

```
Physical layout sau UPDATE:
┌──────────────────────────────────────────────────────────────┐
│                     Page (8KB)                               │
│                                                              │
│  Slot 1: [xmin=100][xmax=200][ctid=(0,2)][balance=1000]     │
│           ← Dead tuple (sẽ bị vacuum dọn)                   │
│                                                              │
│  Slot 2: [xmin=200][xmax=0  ][ctid=(0,2)][balance=800]      │
│           ← Live tuple                                       │
│                                                              │
│  Slot 1's ctid → (page 0, slot 2) = chỉ tới version mới     │
└──────────────────────────────────────────────────────────────┘
```

---

## Transaction ID (XID) và Snapshot

### XID — Transaction Identity

```
XID là unsigned 32-bit integer, monotonically increasing
Range: 1 → 4,294,967,295 (~4.3 tỷ)
Wrap-around sau ~4.3 tỷ transactions (nguy hiểm nếu không vacuum!)

Đặc biệt:
  XID = 0 → Invalid
  XID = 1 → Bootstrap (system catalog initialization)
  XID = 2 → Frozen (visible to everyone, bất kể snapshot)
```

### Snapshot — "Tôi thấy gì vào thời điểm này"

Khi transaction bắt đầu, PostgreSQL tạo **snapshot** mô tả:

```
Snapshot = {
  xmin: XID nhỏ nhất đang active (mọi XID < xmin đều committed/aborted)
  xmax: XID lớn nhất tiếp theo sẽ được assign (mọi XID >= xmax đều chưa bắt đầu)
  xip:  Danh sách các XID đang in-progress (active transactions)
}
```

```
Ví dụ:
  Active transactions: [300, 305, 310]
  Next XID: 315

  Snapshot = {xmin=300, xmax=315, xip=[300, 305, 310]}

  Tuple với xmin=295 → committed trước snapshot → VISIBLE
  Tuple với xmin=300 → in xip → KHÔNG VISIBLE (uncommitted)
  Tuple với xmin=307 → not in xip, 300 <= 307 < 315 → COMMITTED → VISIBLE
  Tuple với xmin=315 → >= xmax → KHÔNG VISIBLE (chưa bắt đầu)
```

---

## Visibility Rules — PostgreSQL thấy gì?

Đây là **logic cốt lõi của MVCC**. PostgreSQL check visibility của mỗi tuple:

```
Một tuple (xmin, xmax) có visible với snapshot S không?

RULE 1: Tuple phải được tạo bởi committed transaction
  → xmin phải committed TRƯỚC snapshot S
  → Nếu xmin in S.xip → UNCOMMITTED → NOT VISIBLE
  → Nếu xmin aborted → NOT VISIBLE

RULE 2: Tuple không được bị xóa bởi committed transaction (visible to us)
  → xmax = 0 → chưa bị xóa → VISIBLE (nếu Rule 1 pass)
  → xmax committed TRƯỚC snapshot S → bị xóa → NOT VISIBLE
  → xmax committed SAU snapshot S → chúng ta không thấy việc xóa → VISIBLE
  → xmax aborted → việc xóa không xảy ra → VISIBLE
```

### Minh họa cụ thể

```
┌─────────────────────────────────────────────────────────────────────┐
│  Timeline:                                                           │
│                                                                      │
│  XID=100: INSERT row A (balance=1000) → commit                       │
│  XID=200: SELECT (snapshot: xmin=200, xmax=201, xip=[])             │
│  XID=150: UPDATE row A (balance=800) → commit (XID < 200)           │
│  XID=200: Transaction vẫn đang chạy...                               │
│                                                                      │
│  Tuples trên disk:                                                   │
│  Tuple 1: (xmin=100, xmax=150, balance=1000) ← dead                 │
│  Tuple 2: (xmin=150, xmax=0,   balance=800)  ← live                 │
│                                                                      │
│  Tx 200 (Read Committed) thấy gì?                                    │
│  → Tuple 1: xmin=100 committed ✓, xmax=150 committed trước 200 → NOT VISIBLE │
│  → Tuple 2: xmin=150 committed ✓, xmax=0 → VISIBLE → balance=800    │
│                                                                      │
│  Nếu Tx 200 là Repeatable Read và snapshot lấy trước XID=150 commit: │
│  Snapshot = {xmin=150, xmax=151, xip=[150]}                          │
│  → Tuple 2: xmin=150 IN xip → UNCOMMITTED khi snapshot được tạo      │
│  → Tx 200 thấy Tuple 1! balance=1000                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### infomask — Cache visibility hints

Checking commit status mỗi tuple sẽ rất chậm nếu phải tra `pg_xact` mỗi lần. PostgreSQL dùng **hint bits** trong `infomask`:

```
infomask flags:
  HEAP_XMIN_COMMITTED (0x0100) — xmin đã committed (cached)
  HEAP_XMIN_INVALID   (0x0200) — xmin đã aborted
  HEAP_XMAX_COMMITTED (0x0400) — xmax đã committed
  HEAP_XMAX_INVALID   (0x0800) — xmax đã aborted (hoặc xmax=0)

Lần đầu check: tra pg_xact, set hint bit
Lần sau: chỉ cần check hint bit → không cần I/O
```

---

## Dead Tuples và Vacuum

MVCC tạo ra dead tuples — không ai cần nữa nhưng vẫn chiếm space. **Vacuum** là process dọn dẹp.

### Dead Tuple Lifecycle

```
┌──────────────────────────────────────────────────────────────────┐
│                    Dead Tuple Lifecycle                           │
│                                                                  │
│  INSERT → tuple (xmin=T, xmax=0)      LIVE                       │
│     │                                                            │
│     ▼                                                            │
│  UPDATE → tuple cũ (xmin=T, xmax=T')                            │
│         → tuple mới (xmin=T', xmax=0)                           │
│     │                                                            │
│     ▼  Khi nào tuple cũ là "dead"?                               │
│  Tất cả active transactions đều thấy xmax=T' committed            │
│  = Không còn snapshot nào cần thấy tuple cũ                     │
│     │                                                            │
│     ▼                                                            │
│  VACUUM chạy → tìm dead tuples → mark slots là "free"            │
│  (Không reclaim disk space ngay — page vẫn giữ size)             │
│     │                                                            │
│     ▼                                                            │
│  INSERT/UPDATE sau → tái sử dụng free slots                      │
│     │                                                            │
│     ▼  Nếu page quá nhiều bloat                                  │
│  VACUUM FULL / pg_repack → compact pages → reclaim disk          │
└──────────────────────────────────────────────────────────────────┘
```

### Khi nào VACUUM cần thiết nhất?

```sql
-- Bảng có UPDATE nhiều → dead tuples tích lũy nhanh
-- Kiểm tra:
SELECT 
    relname,
    n_live_tup,
    n_dead_tup,
    ROUND(n_dead_tup::numeric / NULLIF(n_live_tup + n_dead_tup, 0) * 100, 2) AS dead_pct,
    last_autovacuum,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY dead_pct DESC;

-- dead_pct > 10% → autovacuum nên đã chạy
-- dead_pct > 30% → vấn đề (autovacuum bị throttle hoặc disabled?)
```

### Autovacuum triggers

```
Autovacuum chạy VACUUM khi:
  n_dead_tup > autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × n_live_tup
  Default:      50             +              0.2                       × n_live_tup

Ví dụ: table 1M rows → trigger khi dead_tup > 50 + 0.2×1M = 200,050

Autovacuum chạy ANALYZE khi:
  n_mod_since_analyze > autovacuum_analyze_threshold + autovacuum_analyze_scale_factor × n_live_tup
```

```ini
# Tuning cho bảng hot (nhiều updates như documents, transactions)
ALTER TABLE documents SET (
    autovacuum_vacuum_scale_factor = 0.02,    -- 2% thay vì 20%
    autovacuum_vacuum_threshold = 100,
    autovacuum_analyze_scale_factor = 0.01,
    autovacuum_vacuum_cost_delay = 2           -- ms, giảm throttle
);
```

---

## HOT Update — Optimization quan trọng

Mỗi UPDATE bình thường phải update cả heap tuple **và** tất cả indexes pointing to it. Với table nhiều indexes, UPDATE rất tốn kém.

**HOT = Heap-Only Tuple** — optimization cho UPDATE không thay đổi indexed columns.

```
Normal UPDATE (balance thay đổi, balance là indexed):
  ┌─────────────────────────────────────────────┐
  │  Heap page: mark old dead, insert new       │
  │  Index₁ (balance): delete old entry,        │
  │                     insert new entry        │
  │  Index₂ (status):  delete old entry,        │
  │                     insert new entry        │
  └─────────────────────────────────────────────┘
  → N index updates = expensive

HOT UPDATE (chỉ balance thay đổi, nhưng balance NOT indexed):
  ┌─────────────────────────────────────────────┐
  │  Heap page: mark old dead, insert new       │
  │  → old tuple's ctid points to new tuple     │
  │  Indexes: NO CHANGES! (chỉ trỏ vào page,   │
  │            follow ctid chain tại runtime)   │
  └─────────────────────────────────────────────┘
  → 0 index updates = much cheaper
```

```
HOT chain:
  Index → Slot 1 (dead, ctid→Slot 2) → Slot 2 (dead, ctid→Slot 3) → Slot 3 (live)
  VACUUM prunes HOT chains: Index → Slot 3 (live)
```

**Điều kiện HOT update:**
1. UPDATE column không phải indexed column
2. New tuple fit vào cùng page với old tuple (`fillfactor` ảnh hưởng điều này)

```ini
-- Để HOT update có space để hoạt động:
CREATE TABLE hot_heavy_table (...) WITH (fillfactor = 70);
-- 30% space dành cho HOT updates trên cùng page
```

---

## MVCC và Index — Complication

Index entries KHÔNG có xmin/xmax. Điều này tạo ra một số phức tạp.

### Index-Only Scan và Visibility Map

```
Index entry: (key=500, TID=(page 3, slot 2))
Index không biết tuple này có visible không!

Khi Index-Only Scan:
  1. Tìm key trong index → TID
  2. Check Visibility Map — page này có ALL tuples visible không?
     └─ YES (VM bit set) → return data FROM INDEX (no heap fetch!)
     └─ NO  → heap fetch → check tuple visibility → return if visible
```

```
Visibility Map (VM):
  1 bit per page
  Set khi ALL tuples trên page đều visible to all active transactions
  VACUUM sets VM bits
  UPDATE/DELETE clears VM bits cho affected pages
```

---

## Transaction ID Wraparound — Kịch bản nguy hiểm

XID là 32-bit integer → wrap around sau ~4.3 tỷ transactions.

```
Vấn đề:
  XID dùng modular arithmetic để so sánh "trước/sau"
  Convention: XID trong range [XID-2^31, XID+2^31) là "sau" current XID

  Sau wraparound:
  Old tuple xmin=100 → current XID=2^32+50
  PostgreSQL nghĩ xmin=100 là "trong tương lai" → tuple INVISIBLE!
  → Toàn bộ data cũ có thể mất visibility → DATABASE KHÔNG ĐỌC ĐƯỢC!
```

### Cách PostgreSQL phòng ngừa

```
FREEZE: mark tuples với xmin=2 (FrozenTransactionId)
  → XID=2 visible to EVERYONE, không phụ thuộc XID comparison
  → VACUUM FREEZE thực hiện freezing

autovacuum_freeze_max_age = 200000000  (200M transactions)
  → Autovacuum sẽ freeze tuples trước khi XID wrap around
```

```sql
-- Monitor XID age — CRITICAL metric
SELECT 
    relname,
    age(relfrozenxid) AS xid_age,
    pg_size_pretty(pg_relation_size(oid)) AS size
FROM pg_class
WHERE relkind = 'r' AND age(relfrozenxid) > 100000000  -- > 100M
ORDER BY age(relfrozenxid) DESC;

-- age > 1.5B → URGENT: manual VACUUM FREEZE
-- age > 2B   → PostgreSQL will STOP ACCEPTING TRANSACTIONS to protect data!
```

---

## Tóm tắt — MVCC Mental Model

```
┌──────────────────────────────────────────────────────────────────┐
│                    MVCC Core Concepts                             │
│                                                                  │
│  1. Each tuple has (xmin, xmax):                                 │
│     xmin = transaction that created it                           │
│     xmax = transaction that deleted/updated it (0 if live)       │
│                                                                  │
│  2. Each transaction has a snapshot:                             │
│     {xmin, xmax, xip} — defines what's "visible"               │
│                                                                  │
│  3. Visibility = xmin committed AND (xmax=0 OR xmax not visible) │
│                                                                  │
│  4. UPDATE = new tuple + mark old as dead                        │
│     → dead tuples accumulate → VACUUM cleans up                  │
│                                                                  │
│  5. HOT optimization: avoid index updates when possible          │
│                                                                  │
│  6. XID is 32-bit → VACUUM FREEZE prevents wraparound disaster   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Related Notes

- [[01-ACID-Internals]] — WAL và Isolation levels
- [[03-Concurrency-Patterns]] — Áp dụng MVCC: FOR UPDATE, SKIP LOCKED, edge cases
- [[05-Performance-Tuning]] — Vacuum configuration chi tiết
- [[_moc/MOC-Database-Internals]] — Storage engine level (LSM, B-Tree)

---

*Tags: #postgresql #mvcc #concurrency #vacuum #internals*  
*Created: 2026-05-06 | Difficulty: ⭐⭐⭐⭐*
