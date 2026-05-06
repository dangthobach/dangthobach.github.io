# 08 — MVCC So Sánh: MySQL vs PostgreSQL vs Oracle

> **Audience:** Senior engineers cần hiểu sâu concurrency control để thiết kế hệ thống đúng, hoặc chuẩn bị phỏng vấn system design.  
> **Scope:** Cơ chế MVCC của 3 RDBMS lớn — khác nhau ở đâu, tại sao, và implication thực tế.  
> **Liên kết:** [[02-MVCC-Concurrency]] | [[01-ACID-Internals]] | [[00-PostgreSQL-Hub]]

---

## 📋 Mục lục

1. [Tổng quan — Tại sao cần MVCC?](#1-tổng-quan--tại-sao-cần-mvcc)
2. [PostgreSQL MVCC — Tuple versioning trong heap](#2-postgresql-mvcc)
3. [MySQL InnoDB MVCC — Undo log chain](#3-mysql-innodb-mvcc)
4. [Oracle MVCC — Undo tablespace](#4-oracle-mvcc)
5. [So sánh trực tiếp — Bảng tổng hợp](#5-so-sánh-trực-tiếp)
6. [Anomaly behavior — Database nào phòng ngừa gì?](#6-anomaly-behavior)
7. [Performance implications](#7-performance-implications)
8. [Chọn database theo concurrency requirements](#8-chọn-database-theo-concurrency-requirements)

---

## 1. Tổng quan — Tại sao cần MVCC?

Trước MVCC, databases dùng **lock-based concurrency control**:

```
┌──────────────────────────────────────────────────────────────────┐
│              Lock-based (Pre-MVCC)                                │
│                                                                  │
│  Reader ──── acquire SHARED LOCK ────► Block nếu Writer đang giữ │
│  Writer ──── acquire EXCLUSIVE LOCK ─► Block Reader và Writer    │
│                                                                  │
│  Result: Reader blocks Writer, Writer blocks Reader              │
│  → Low concurrency, high contention                              │
│                                                                  │
│              MVCC — Core Idea                                     │
│                                                                  │
│  Thay vì lock row → giữ MULTIPLE VERSIONS của row                │
│  Reader thấy phiên bản phù hợp với snapshot của nó              │
│  Writer tạo phiên bản mới → không conflict với Reader            │
│                                                                  │
│  Result: Readers never block Writers, Writers never block Readers│
└──────────────────────────────────────────────────────────────────┘
```

Ba database implement MVCC theo **ba kiến trúc khác nhau hoàn toàn**:

```
PostgreSQL     MySQL InnoDB          Oracle
───────────    ────────────────      ──────────────────
Versions IN    Versions in           Versions in
heap table     UNDO LOG SEGMENT      UNDO TABLESPACE
(tuple chain)  (rollback segment)    (separate area)

Old versions   Old versions          Old versions
trong cùng     trong UNDO file       trong UNDO TBS
heap pages     (separate from data)  (separate from data)
```

---

## 2. PostgreSQL MVCC

*Xem chi tiết: [[02-MVCC-Concurrency]]*

### Cơ chế: Tuple versioning trong heap

```
┌──────────────────────────────────────────────────────────────────┐
│                  PostgreSQL Heap Page                             │
│                                                                  │
│  Sau 3 lần UPDATE row (id=1):                                    │
│                                                                  │
│  ┌──────────────────────────────────────────────┐               │
│  │ Slot 1: [xmin=100][xmax=200] balance=1000    │ ← dead tuple  │
│  │ Slot 2: [xmin=200][xmax=300] balance=800     │ ← dead tuple  │
│  │ Slot 3: [xmin=300][xmax=0  ] balance=950     │ ← live tuple  │
│  └──────────────────────────────────────────────┘               │
│                                                                  │
│  Index → Slot 1 → ctid → Slot 2 → ctid → Slot 3                │
│  (HOT chain nếu không đổi indexed column)                        │
│                                                                  │
│  VACUUM dọn: Slot 1, Slot 2 → reclaim space                     │
└──────────────────────────────────────────────────────────────────┘
```

### Snapshot mechanism

```sql
-- Mỗi transaction nhận snapshot = {xmin, xmax, xip[]}
-- Tuple visible nếu: xmin committed AND (xmax=0 OR xmax not visible)

-- Read Committed: snapshot per STATEMENT
-- Repeatable Read: snapshot per TRANSACTION
-- Serializable: snapshot + dependency tracking (SSI)
```

### PostgreSQL-specific traits

```
✓ Readers và Writers không block nhau hoàn toàn
✓ Repeatable Read ngăn phantom reads (stronger than SQL standard)
✓ Serializable dùng SSI (Serializable Snapshot Isolation) — không dùng locks
✗ Dead tuples tích lũy trong heap → cần VACUUM (overhead)
✗ COUNT(*) phải scan tuples (không cache row count)
✗ XID wraparound risk nếu không vacuum đủ
```

---

## 3. MySQL InnoDB MVCC

### Cơ chế: Undo Log Chain

MySQL InnoDB KHÔNG lưu old versions trong data pages. Thay vào đó, data page luôn chứa **phiên bản mới nhất**, còn old versions được lưu trong **undo log**.

```
┌──────────────────────────────────────────────────────────────────┐
│                  MySQL InnoDB Architecture                        │
│                                                                  │
│  Data Page (clustered index, B-Tree leaf):                       │
│  ┌────────────────────────────────────────────┐                  │
│  │ Row: id=1, balance=950 (LATEST VERSION)     │                  │
│  │      DB_TRX_ID = 300   (transaction id)    │                  │
│  │      DB_ROLL_PTR ──────────────────────────┼──┐              │
│  └────────────────────────────────────────────┘  │              │
│                                                   ▼              │
│  Undo Log Segment:                                               │
│  ┌────────────────────────────────────────────┐                  │
│  │ Undo record (TRX=300): balance was 800     │                  │
│  │      prev_roll_ptr ────────────────────────┼──┐              │
│  └────────────────────────────────────────────┘  │              │
│                                                   ▼              │
│  ┌────────────────────────────────────────────┐                  │
│  │ Undo record (TRX=200): balance was 1000    │                  │
│  │      prev_roll_ptr = NULL                  │                  │
│  └────────────────────────────────────────────┘                  │
│                                                                  │
│  Reader muốn thấy version tại TRX=150?                           │
│  → Đọc data page (balance=950, TRX=300)                          │
│  → 300 > 150? → apply undo (→ 800)                               │
│  → 200 > 150? → apply undo (→ 1000)                               │
│  → 100 <= 150? → STOP → return 1000 ✓                            │
└──────────────────────────────────────────────────────────────────┘
```

### Hidden columns trong InnoDB row

```
Mỗi InnoDB row có thêm 3 hidden columns (không phải data columns):
  DB_TRX_ID    (6 bytes) — ID của transaction cuối cùng modify row
  DB_ROLL_PTR  (7 bytes) — con trỏ đến undo log record
  DB_ROW_ID    (6 bytes) — row ID nếu không có primary key
```

### ReadView — InnoDB snapshot equivalent

```sql
-- InnoDB dùng "ReadView" thay vì snapshot:
-- ReadView = {trx_ids: [], low_limit_id, up_limit_id, creator_trx_id}
-- trx_ids: list of active transactions khi ReadView được tạo
-- low_limit_id: max TRX_ID + 1 (tuples với ID >= này → invisible)
-- up_limit_id: min TRX_ID trong active list (tuples với ID < này → visible)

-- Read Committed: ReadView per statement (same as PG RC)
-- Repeatable Read: ReadView per transaction (first statement)
-- ← InnoDB DEFAULT là REPEATABLE READ (PG default là READ COMMITTED)
```

### MySQL InnoDB-specific traits

```
✓ Data pages luôn có latest version → không cần VACUUM để reclaim data pages
✓ Undo log purge tự động, ít dramatic hơn PG VACUUM
✓ Default isolation = Repeatable Read (PG default = Read Committed)
✓ Gap locks + Next-key locks ngăn phantom insert trong RR
✗ Long transactions giữ undo log lâu → undo log grow → performance giảm
✗ Undo log traversal overhead khi cần old versions nhiều
✗ Không có SSI → Serializable dùng 2PL (locking), không phải SSI
```

### MySQL Gap Locks — InnoDB specific

MySQL InnoDB có **Gap Locks** mà PostgreSQL không có:

```sql
-- MySQL InnoDB Repeatable Read:
-- Lock không chỉ trên rows hiện tại mà còn "gap" giữa các rows
-- → Ngăn phantom INSERT

-- Ví dụ:
SELECT * FROM products WHERE price BETWEEN 10 AND 20 FOR UPDATE;
-- InnoDB lock: gap trước 10, rows 10-20, gap sau 20
-- → INSERT products(price=15) từ session khác → BLOCK!

-- PostgreSQL Repeatable Read:
-- KHÔNG có gap locks
-- → INSERT vào range có thể xảy ra (nhưng PG RR dùng snapshot nên không bị phantom)
-- → FOR UPDATE trên range KHÔNG ngăn INSERT vào range đó
```

---

## 4. Oracle MVCC

### Cơ chế: Undo Tablespace (Rollback Segments)

Oracle dùng kiến trúc tương tự MySQL (separate undo storage), nhưng chi tiết khác nhau đáng kể.

```
┌──────────────────────────────────────────────────────────────────┐
│                    Oracle Architecture                            │
│                                                                  │
│  Data Block (table segment):                                     │
│  ┌────────────────────────────────────────────┐                  │
│  │ Row: id=1, balance=950                     │                  │
│  │      ITL entry: SCN=3000, XID=...          │                  │ ← Interested Transaction List
│  │      row lock flag (byte in row header)    │                  │
│  └────────────────────────────────────────────┘                  │
│                          │ SCN pointer                           │
│                          ▼                                       │
│  Undo Tablespace (UNDO$):                                        │
│  ┌────────────────────────────────────────────┐                  │
│  │ Rollback Segment:                          │                  │
│  │   SCN=3000: balance was 800                │                  │
│  │   SCN=2000: balance was 1000               │                  │
│  └────────────────────────────────────────────┘                  │
│                                                                  │
│  SCN = System Change Number — global monotonic counter           │
│        tăng mỗi khi có committed change                          │
│        Oracle equivalent của PG's transaction snapshot           │
└──────────────────────────────────────────────────────────────────┘
```

### SCN — System Change Number

```
Oracle dùng SCN thay vì Transaction ID để track versions:
  SCN là global sequence number, không phải per-transaction
  Mỗi COMMIT tạo ra SCN mới

  Advantages:
  + Consistent read across distributed nodes (RAC)
  + FLASHBACK QUERY dễ implement
  + Point-in-time recovery chính xác

  Disadvantages:
  + SCN exhaustion (giới hạn ~281 trillion)
  + SCN sync overhead trong RAC environment
```

### Consistent Read trong Oracle

```sql
-- Oracle SELECT luôn là CONSISTENT READ tại SCN của lúc query bắt đầu
-- Đây là READ COMMITTED behavior theo SQL standard
-- Nhưng Oracle's Read Committed mạnh hơn standard:
-- → Statement-level consistency (không thấy uncommitted data TRONG statement)

-- Oracle Serializable = Snapshot Isolation (không phải true Serializable!)
-- → Giống PostgreSQL Repeatable Read về anomaly prevention
-- → Không có SSI, không detect write skew cycles

-- FOR UPDATE trong Oracle: row-level locking, không có gap locks
SELECT balance FROM accounts WHERE id = 1 FOR UPDATE;
```

### Flashback Query — Oracle superpower

```sql
-- Oracle-specific: query dữ liệu tại thời điểm trong quá khứ
-- Tận dụng undo tablespace

-- Xem dữ liệu như 1 giờ trước:
SELECT * FROM documents AS OF TIMESTAMP (SYSTIMESTAMP - INTERVAL '1' HOUR);

-- Xem dữ liệu tại SCN cụ thể:
SELECT * FROM documents AS OF SCN 12345678;

-- Không có equivalent trong PostgreSQL hay MySQL
-- (PostgreSQL có PITR nhưng yêu cầu restore, không phải inline query)
```

### Oracle-specific traits

```
✓ SCN-based consistent read → excellent cho distributed/RAC environments
✓ Flashback Query / Flashback Table / Flashback Database
✓ Automatic Undo Management (AUM) — dễ quản lý hơn PG vacuum
✓ Serializable = SI (không phải true Ser.) → ít serialization failures hơn PG
✗ Undo retention limit → ORA-01555 "snapshot too old" khi undo bị overwritten
✗ Không có SSI → write skew có thể xảy ra ở Serializable level
✗ Read Committed default — cẩn thận với long queries
```

---

## 5. So sánh trực tiếp

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                    MVCC Implementation Comparison                                 │
│                                                                                  │
│  Aspect              │ PostgreSQL        │ MySQL InnoDB      │ Oracle             │
│  ────────────────────┼───────────────────┼───────────────────┼────────────────── │
│  Version storage     │ Heap (data pages) │ Undo log segment  │ Undo tablespace    │
│  Version access      │ Direct (in page)  │ Undo traversal    │ Undo traversal     │
│  Cleanup             │ VACUUM (manual+   │ Purge thread      │ Automatic (AUM)    │
│                      │ autovacuum)       │ (mostly auto)     │                    │
│  Default isolation   │ Read Committed    │ Repeatable Read   │ Read Committed     │
│  Max isolation       │ Serializable(SSI) │ Serializable(2PL) │ Serializable(SI)   │
│  Phantom prevention  │ RR (via snapshot) │ RR (gap locks)    │ Serializable only  │
│  Write skew prevent  │ Serializable only │ Serializable(2PL) │ Not prevented!     │
│  Gap locks           │ ✗ No              │ ✓ Yes (RR+)       │ ✗ No               │
│  Dirty read          │ ✗ Never           │ RC+ prevents      │ RC+ prevents       │
│  Flashback/time travel│ ✗ No (PITR only) │ ✗ No              │ ✓ AS OF SCN/TIME  │
│  Long tx impact      │ Dead tuple bloat  │ Undo log growth   │ Undo retention     │
│  Long tx error       │ (none, just bloat)│ (performance deg.)│ ORA-01555          │
│  COUNT(*) cost       │ O(N) always       │ O(1) for MyISAM   │ O(N)               │
│                      │                   │ O(N) for InnoDB   │                    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Anomaly behavior

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                 Anomaly Prevention Matrix                                         │
│                                                                                  │
│  Anomaly           │ PG RC │ PG RR │ PG Ser │ My RC │ My RR │ My Ser │ Ora RC │ Ora Ser │
│  ──────────────────┼───────┼───────┼────────┼───────┼───────┼────────┼────────┼────────│
│  Dirty Read        │  ✓    │  ✓    │  ✓     │  ✓    │  ✓    │  ✓     │  ✓     │  ✓     │
│  Non-repeatable Rd │  ✗    │  ✓    │  ✓     │  ✗    │  ✓    │  ✓     │  ✗     │  ✓     │
│  Phantom Read      │  ✗    │  ✓*   │  ✓     │  ✗    │  ✓†   │  ✓     │  ✗     │  ✓*    │
│  Lost Update       │  ✗    │  ✗‡   │  ✓     │  ✗    │  ✗‡   │  ✓     │  ✗     │  ✗‡    │
│  Write Skew        │  ✗    │  ✗    │  ✓     │  ✗    │  ✗    │  ✓§    │  ✗     │  ✗     │
│                                                                                  │
│  ✓ Prevented  ✗ Not prevented                                                    │
│  * Via snapshot (stronger than SQL standard requirement)                         │
│  † Via gap locks (different mechanism, same result)                              │
│  ‡ FOR UPDATE needed (both prevent with proper locking)                          │
│  § Via 2PL locking (blocks concurrency more than SSI)                           │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Write Skew — Oracle Serializable không bảo vệ!

```sql
-- Oracle Serializable = Snapshot Isolation (không phải true Serializable)
-- Write skew CÓ THỂ XẢY RA:

-- Session A (Oracle Serializable):
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT COUNT(*) FROM doctors WHERE on_call = true; -- 2
UPDATE doctors SET on_call = false WHERE name = 'Alice';
COMMIT; -- SUCCESS!

-- Session B (concurrent):
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT COUNT(*) FROM doctors WHERE on_call = true; -- 2 (snapshot)
UPDATE doctors SET on_call = false WHERE name = 'Bob';
COMMIT; -- ALSO SUCCESS! → 0 doctors on call → constraint violated

-- PostgreSQL Serializable (SSI) sẽ abort một trong hai!
```

---

## 7. Performance implications

### Đọc old version: PostgreSQL vs MySQL

```
PostgreSQL:
  Old version nằm TRONG heap pages
  → Read old version: không cần extra I/O nếu page vẫn trong buffer
  → Hot data → old versions likely in cache
  → Cold data với nhiều updates → page chứa dead tuples, waste I/O

MySQL InnoDB:
  Old version trong UNDO log (separate storage)
  → Read old version: phải traverse undo chain (extra I/O nếu cache miss)
  → Long transactions + frequently updated rows → long undo chain → slow read
  → Nhưng: data pages sạch hơn (không có dead tuples mixed in)
```

### Write performance

```
PostgreSQL UPDATE:
  INSERT new tuple vào heap (có thể HOT)
  Mark old tuple dead (in-place xmax update)
  Update index (if not HOT)
  → Write amplification: 1 update = 1 index update (hoặc 0 nếu HOT)

MySQL InnoDB UPDATE:
  Modify data page in-place (clustered index)
  Write undo log record
  Update secondary indexes
  → Write amplification: 1 update = 1 undo + N secondary index updates

Oracle UPDATE:
  Modify data block in-place
  Write undo segment
  Update indexes
  Write redo log (WAL equivalent)
  → Highest write amplification but most durable
```

### Impact of long transactions

```
┌──────────────────────────────────────────────────────────────────┐
│              Long Transaction Impact Comparison                   │
│                                                                  │
│  PostgreSQL:                                                     │
│  Tx starts at XID=1000                                           │
│  1 hour later: 500K updates by other transactions                │
│  → 500K dead tuples still visible to Tx (can't vacuum)           │
│  → Table bloat increases                                         │
│  → Queries scan more pages (including dead tuples)               │
│  → Performance degrades gradually                                │
│                                                                  │
│  MySQL InnoDB:                                                   │
│  Tx starts, holds ReadView                                       │
│  1 hour later: 500K updates by other transactions                │
│  → 500K undo log records must be retained                        │
│  → Undo log grows large                                          │
│  → Read of any updated row needs undo traversal                  │
│  → Performance degrades, especially for read queries             │
│                                                                  │
│  Oracle:                                                         │
│  Tx starts, reads data at SCN snapshot                           │
│  1 hour later: undo segments may be overwritten (retention limit)│
│  → ORA-01555: snapshot too old                                   │
│  → Query FAILS! (not just slow — errors out)                     │
│  → Must configure undo_retention large enough                    │
└──────────────────────────────────────────────────────────────────┘
```

---

## 8. Chọn database theo concurrency requirements

```
Yêu cầu                                → Database phù hợp
─────────────────────────────────────────────────────────────────
True Serializable (write skew safe)     → PostgreSQL (SSI)
High write throughput + MVCC            → MySQL InnoDB hoặc PostgreSQL
Time-travel queries (AS OF)             → Oracle
Distributed RAC consistency             → Oracle (SCN)
OLAP + MVCC (no vacuum concern)         → MySQL InnoDB (undo log approach)
Simple ops, maximal isolation           → MySQL InnoDB (RR default + gap locks)
Banking/financial (write skew matters)  → PostgreSQL Serializable
Long-running reports (hours)            → Chú ý: Oracle có ORA-01555 risk
                                          MySQL: undo log bloat
                                          PostgreSQL: vacuum bloat
```

---

## Related Notes

- [[02-MVCC-Concurrency]] — PostgreSQL MVCC chi tiết
- [[01-ACID-Internals]] — WAL và isolation trong PostgreSQL
- [[03-Concurrency-Patterns]] — Bài toán thực tế: write skew, FOR UPDATE

---

*Tags: #mvcc #postgresql #mysql #oracle #concurrency #database-internals*  
*Created: 2026-05-06 | Difficulty: ⭐⭐⭐⭐*
