# 01 — ACID Internals: Bản Chất Thật Sự của PostgreSQL

> **Audience:** Senior engineers đã biết định nghĩa ACID, muốn hiểu **cơ chế thật sự** bên dưới.  
> **Scope:** WAL, fsync, crash recovery, isolation implementation — không phải textbook definition.  
> **Liên kết:** [[02-MVCC-Concurrency]] | [[03-Concurrency-Patterns]] | [[00-PostgreSQL-Hub]]

---

## 📋 Mục lục

1. [ACID — Nhìn lại từ góc độ implementation](#acid--nhìn-lại-từ-góc-độ-implementation)
2. [Atomicity — WAL là trái tim](#atomicity--wal-là-trái-tim)
3. [Durability — fsync và the disk lie](#durability--fsync-và-the-disk-lie)
4. [Consistency — Ai enforce?](#consistency--ai-enforce)
5. [Isolation — Spectrum và trade-offs](#isolation--spectrum-và-trade-offs)
6. [Crash Recovery — PostgreSQL sống lại như thế nào](#crash-recovery--postgresql-sống-lại-như-thế-nào)
7. [Thực hành: Chọn đúng Isolation Level](#thực-hành-chọn-đúng-isolation-level)

---

## ACID — Nhìn lại từ góc độ implementation

Khi phỏng vấn, ai cũng trả lời được: *"ACID là Atomicity, Consistency, Isolation, Durability."* Nhưng câu hỏi thú vị hơn là: **PostgreSQL implement từng tính chất này bằng cơ chế gì?**

```
┌─────────────────────────────────────────────────────────────┐
│  ACID Property     │  Cơ chế PostgreSQL implement           │
├────────────────────┼────────────────────────────────────────┤
│  Atomicity         │  WAL (Write-Ahead Log) + rollback log  │
│  Consistency       │  Constraints + triggers + application  │
│  Isolation         │  MVCC (Multi-Version Concurrency Ctrl) │
│  Durability        │  WAL + fsync + checkpoint              │
└─────────────────────────────────────────────────────────────┘
```

Bốn chữ cái nhưng ba cơ chế hoàn toàn khác nhau. Hãy đi vào từng cái.

---

## Atomicity — WAL là trái tim

### Vấn đề cần giải quyết

Giả sử bạn chuyển tiền: trừ tài khoản A, cộng tài khoản B. Nếu server crash sau khi trừ A nhưng trước khi cộng B → tiền biến mất. Atomicity đảm bảo: **tất cả hoặc không có gì**.

### Write-Ahead Log (WAL)

PostgreSQL giải quyết bằng **WAL** — một journal tuần tự ghi lại **ý định thay đổi** trước khi thực sự thay đổi data pages.

```
┌────────────────────────────────────────────────────────────────────┐
│                    WAL Write Flow                                   │
│                                                                    │
│  1. BEGIN TRANSACTION                                              │
│     └─► Transaction ID (XID) được cấp                             │
│                                                                    │
│  2. UPDATE accounts SET balance = balance - 500 WHERE id = 'A'    │
│     ├─► WAL record ghi vào WAL buffer:                            │
│     │     [LSN=1001][XID=421][REL=accounts][BLK=3][TYPE=UPDATE]   │
│     │     [before: balance=1000][after: balance=500]              │
│     └─► Data page trong shared_buffers được sửa (dirty page)     │
│                                                                    │
│  3. UPDATE accounts SET balance = balance + 500 WHERE id = 'B'    │
│     └─► WAL record tương tự                                       │
│                                                                    │
│  4. COMMIT                                                         │
│     ├─► WAL commit record ghi: [LSN=1003][XID=421][TYPE=COMMIT]   │
│     ├─► WAL buffer flush to disk (fsync WAL file) ← CRITICAL      │
│     └─► Client nhận "OK" — data pages CÓ THỂ chưa flush to disk  │
│                                                                    │
│  5. Checkpoint (async, later)                                      │
│     └─► Dirty data pages flush to disk                            │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

LSN = Log Sequence Number (monotonically increasing)
```

**Key insight:** Client nhận được `COMMIT OK` khi WAL đã flush to disk, **không phải** khi data pages flush. WAL record là đủ để recover — nếu crash, PostgreSQL replay WAL từ last checkpoint.

### Rollback cũng nhờ WAL

```
BEGIN;
UPDATE documents SET status = 'DELETED' WHERE id = 123;
-- Quyết định không xóa
ROLLBACK;

← PostgreSQL dùng WAL "before image" để undo changes trong memory
← ROLLBACK KHÔNG cần disk I/O (vì data page chưa chắc đã flush)
← WAL ghi ABORT record để các transaction khác biết XID này đã abort
```

---

## Durability — fsync và the disk lie

### Vấn đề: OS có thể nói dối

```
PostgreSQL: "fsync() thành công, tôi gọi write() rồi"
OS:         "OK, data đã vào page cache của tôi"
Disk:       "Tôi đã nhận data vào write buffer nội bộ"
Reality:    Data vẫn trong DRAM, chưa chạm đến platters/NAND

→ Server mất điện → data GONE mặc dù fsync() return success
```

Đây là vấn đề thật. Năm 2018, một số cloud provider bị phát hiện trả về `fsync()` success giả — PostgreSQL community đã phải thay đổi cách handle fsync error.

### PostgreSQL WAL Durability Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                    Durability Pipeline                           │
│                                                                  │
│  COMMIT                                                          │
│    │                                                             │
│    ▼                                                             │
│  WAL Buffer (shared memory)                                      │
│    │                                                             │
│    ▼  wal_writer process hoặc backend tự flush                  │
│  WAL segment file (pg_wal/)          ← trên filesystem           │
│    │                                                             │
│    ▼  fsync() / fdatasync()                                     │
│  Storage controller write buffer                                 │
│    │                                                             │
│    ▼  (nếu storage honest)                                       │
│  Actual persistent storage (SSD/HDD)  ← DURABLE                │
│                                                                  │
│  ──────── Checkpoint boundary ────────                          │
│    │                                                             │
│    ▼  Sau này (async)                                            │
│  Data page files (base/)              ← flush dirty pages        │
└─────────────────────────────────────────────────────────────────┘
```

### Cấu hình ảnh hưởng Durability

```ini
# postgresql.conf

# synchronous_commit — Trade-off durability vs latency
synchronous_commit = on       # Default: WAL flush TRƯỚC KHI trả lời client (safe)
synchronous_commit = off      # WAL flush async: ~200ms window có thể mất data nếu crash
                              # Nhưng: không mất consistency (transaction vẫn atomic)
                              # Use case: bulk import, session data, cache warming

synchronous_commit = remote_write   # Cho streaming replication: WAL gửi đến standby
synchronous_commit = remote_apply   # Standby phải apply WAL trước khi commit confirm

# wal_sync_method — cách PostgreSQL gọi fsync
wal_sync_method = fdatasync   # Linux default (khuyến nghị)
wal_sync_method = fsync       # Full fsync including metadata
wal_sync_method = open_sync   # O_SYNC flag khi open file

# fsync — ĐỪNG BAO GIỜ tắt trong production
fsync = on  # Default và bắt buộc
# fsync = off  # Chỉ cho testing/benchmarking. Data loss guaranteed on crash!
```

### Checkpoint — Đồng bộ định kỳ

```
WAL replay sau crash rất chậm nếu phải replay từ đầu.
→ Checkpoint: flush dirty data pages + ghi "checkpoint record" vào WAL
→ Sau crash: chỉ cần replay WAL từ last checkpoint

Timeline:
─────────────────────────────────────────────────────────────────►
 Checkpoint₁     [transactions...]     Checkpoint₂    [transactions...]   CRASH
     │                                     │                               │
     │◄──── data pages synced ────────────►│                               │
                                           │◄──── replay từ đây ──────────►│
```

```ini
# Checkpoint tuning
checkpoint_timeout = 5min           # Tối đa 5 phút giữa 2 checkpoints
max_wal_size = 4GB                  # Trigger checkpoint sớm nếu WAL vượt 4GB
checkpoint_completion_target = 0.9  # Spread writes ra 90% interval → tránh I/O spike
```

---

## Consistency — Ai enforce?

Consistency trong ACID thường bị hiểu nhầm nhất. **PostgreSQL chỉ enforce một phần.**

```
┌──────────────────────────────────────────────────────────────┐
│  Consistency = "Database luôn ở trạng thái hợp lệ"           │
│                                                              │
│  PostgreSQL enforce:                                         │
│  ✓ PRIMARY KEY, UNIQUE constraints                           │
│  ✓ FOREIGN KEY constraints                                   │
│  ✓ CHECK constraints                                         │
│  ✓ NOT NULL                                                  │
│  ✓ Trigger-based business rules                              │
│                                                              │
│  Application phải enforce:                                   │
│  ✗ "Số dư tài khoản không được âm" (trừ khi có CHECK)        │
│  ✗ "Một hợp đồng phải có ít nhất 1 bên ký"                   │
│  ✗ Business logic phức tạp                                   │
│                                                              │
│  → Consistency = Atomicity + Isolation + app correctness     │
└──────────────────────────────────────────────────────────────┘
```

**Thực tế trong banking (PDMS):** Constraint KHÔNG đủ. Bạn cần application logic + transaction design đúng + isolation level phù hợp.

---

## Isolation — Spectrum và trade-offs

Isolation là tính chất **phức tạp nhất** và hay gây bug nhất. Đây không phải on/off — đây là **spectrum** với trade-off rõ ràng.

### Các vấn đề Isolation giải quyết

```
┌─────────────────────────────────────────────────────────────────────┐
│  Anomaly              │ Mô tả                │ Isolation level fix   │
├───────────────────────┼──────────────────────┼───────────────────────┤
│  Dirty Read           │ Đọc uncommitted data │ Read Committed+        │
│  Non-repeatable Read  │ Đọc 2 lần khác nhau │ Repeatable Read+       │
│  Phantom Read         │ Range query thay đổi │ Serializable           │
│  Lost Update          │ 2 tx cùng update     │ FOR UPDATE / Ser.      │
│  Write Skew           │ Decision based on    │ Serializable only      │
│                       │ stale read           │                        │
└─────────────────────────────────────────────────────────────────────┘
```

### Isolation Levels trong PostgreSQL

PostgreSQL implement **4 isolation levels** theo SQL standard, nhưng thực tế chỉ có **3 cơ chế khác nhau**:

```
SQL Standard Level    │ PostgreSQL thực tế    │ Cơ chế
──────────────────────┼───────────────────────┼──────────────────────
Read Uncommitted      │ = Read Committed      │ MVCC snapshot mỗi stmt
Read Committed        │ Read Committed ✓      │ MVCC snapshot mỗi stmt
Repeatable Read       │ Repeatable Read ✓     │ MVCC snapshot mỗi tx
Serializable          │ Serializable ✓        │ SSI (Serializable SI)
```

> PostgreSQL không implement Read Uncommitted thật — dirty reads không tồn tại.

### Read Committed (default) — Snapshot per statement

```sql
-- Session A
BEGIN;
SELECT balance FROM accounts WHERE id = 'A';  -- thấy: 1000

-- Session B (concurrent)
BEGIN;
UPDATE accounts SET balance = 500 WHERE id = 'A';
COMMIT;

-- Session A (tiếp tục)
SELECT balance FROM accounts WHERE id = 'A';  -- thấy: 500  ← non-repeatable read!
COMMIT;
```

```
Timeline:
  Tx A                    Tx B
  │                       │
  BEGIN                   BEGIN
  │                       │
  SELECT → snapshot₁      │
  reads: 1000             │
  │                       UPDATE balance=500
  │                       COMMIT
  │                       │
  SELECT → snapshot₂      (Tx B đã committed)
  reads: 500 ←── mới!     
  │
  COMMIT
```

**Khi nào Read Committed là đủ?** Cho hầu hết read-heavy queries. Không phù hợp nếu bạn cần consistent view xuyên suốt transaction.

### Repeatable Read — Snapshot per transaction

```sql
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
BEGIN;

SELECT balance FROM accounts WHERE id = 'A';  -- 1000

-- Session B commit UPDATE balance=500 trong lúc này

SELECT balance FROM accounts WHERE id = 'A';  -- vẫn 1000! (snapshot cũ)
COMMIT;
```

```
┌─────────────────────────────────────────────────────────────────┐
│  Repeatable Read Snapshot Model                                  │
│                                                                  │
│  Tx A BEGIN → lấy snapshot tại XID=500                          │
│                                                                  │
│  Mọi SELECT trong Tx A đều thấy:                                │
│  → Rows với xmin <= 500 (created before snapshot)               │
│  → Rows với xmax > 500 hoặc xmax = 0 (not deleted before snap)  │
│                                                                  │
│  Tx B (XID=501) commit UPDATE → rows mới có xmin=501            │
│  Tx A không thấy vì 501 > 500 (sau snapshot của A)              │
└─────────────────────────────────────────────────────────────────┘
```

**Phantom read trong PostgreSQL RR:** PostgreSQL RR thực sự ngăn phantom read (khác SQL standard). Đây là bonus của MVCC.

### Serializable — SSI (Serializable Snapshot Isolation)

PostgreSQL implement **SSI** — không dùng locks như traditional RDBMS, dùng **dependency tracking** để phát hiện conflicts.

```sql
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;

-- Nếu 2 transactions có circular dependency → một cái bị rollback
-- ERROR: could not serialize access due to read/write dependencies among transactions
-- DETAIL: Process 12345 waits for SerializationConflictOut;
--         blocked by process 67890.
-- HINT:   The transaction might succeed if retried.
```

```
Write Skew example (classic):
  Tx A: reads doctors on call → sees [Alice, Bob] → removes Alice
  Tx B: reads doctors on call → sees [Alice, Bob] → removes Bob
  Result: 0 doctors on call! (violated constraint: at least 1)

  Với Serializable: một trong hai sẽ bị abort → retry → safe result
  Với Repeatable Read: cả hai commit → bug!
```

**Cost của Serializable:** ~10-20% overhead. Dùng khi correctness quan trọng hơn throughput (financial transactions, inventory, scheduling).

---

## Crash Recovery — PostgreSQL sống lại như thế nào

Đây là lúc WAL + Checkpoint phát huy toàn bộ giá trị.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Crash Recovery Process                        │
│                                                                  │
│  1. PostgreSQL khởi động, phát hiện crash (pg_control file)      │
│                                                                  │
│  2. Tìm last valid Checkpoint record trong WAL                   │
│                                                                  │
│  3. REDO Phase — replay từ checkpoint forward:                   │
│     └─► Apply tất cả WAL records (kể cả uncommitted transactions)│
│         → Khôi phục data pages về state ngay trước crash        │
│                                                                  │
│  4. UNDO Phase — rollback uncommitted transactions:              │
│     └─► Tìm XID có COMMIT record → keep                         │
│         Tìm XID không có COMMIT record → rollback (ABORT)       │
│         (PostgreSQL dùng pg_xact/ files để track commit status) │
│                                                                  │
│  5. Database ready — consistent state restored                   │
└─────────────────────────────────────────────────────────────────┘
```

### Timeline minh họa

```
─────────────────────────────────────────────────────► time
    │              │                  │
 Checkpoint₁   Checkpoint₂         CRASH
    │              │
    │◄─── WAL ────►│◄──────── WAL replay needed ──────►│
    │              │
    │              └── Data pages synced here
                   ↑
                   Recovery starts here
```

### Point-In-Time Recovery (PITR)

```bash
# Restore đến một thời điểm cụ thể — tận dụng WAL archives
# recovery.conf (PG < 12) hoặc postgresql.conf (PG >= 12)

restore_command = 'cp /mnt/wal-archive/%f %p'
recovery_target_time = '2026-05-06 14:30:00'
recovery_target_action = 'promote'  # Sau khi đạt target, promote thành primary
```

---

## Thực hành: Chọn đúng Isolation Level

### Decision Framework

```
Câu hỏi 1: Transaction có đọc rồi quyết định dựa trên kết quả đọc không?
  └─ Không → Read Committed đủ
  └─ Có → tiếp tục

Câu hỏi 2: Quyết định đó có phải consistent xuyên suốt transaction?
  └─ Chỉ cần giá trị không thay đổi khi đọc lại → Repeatable Read
  └─ Cần toàn bộ kết quả consistent (including phantom) → Serializable

Câu hỏi 3: Có nhiều transactions cùng đọc-rồi-ghi vào cùng rows?
  └─ Có → dùng SELECT FOR UPDATE để tránh lost update
  └─ Không → isolation level là đủ
```

### Ví dụ PDMS banking context

```sql
-- ❌ SAI: Lost update risk với Read Committed
BEGIN; -- default isolation
SELECT remaining_quota FROM branch_config WHERE branch_id = 'HN01'; -- 100
-- ... application logic: tính toán ...
UPDATE branch_config SET remaining_quota = 95 WHERE branch_id = 'HN01';
COMMIT;
-- Nếu 2 sessions làm đồng thời → cả hai đọc 100 → một cái bị lost!

-- ✅ ĐÚNG: Lock với FOR UPDATE
BEGIN;
SELECT remaining_quota FROM branch_config 
WHERE branch_id = 'HN01'
FOR UPDATE;  -- Lock row, session khác phải chờ
-- ... application logic ...
UPDATE branch_config SET remaining_quota = 95 WHERE branch_id = 'HN01';
COMMIT;

-- ✅ CŨNG ĐÚNG: Optimistic locking với version column
UPDATE branch_config 
SET remaining_quota = 95, version = version + 1
WHERE branch_id = 'HN01' AND version = :expected_version;
-- Nếu affected rows = 0 → conflict → retry
```

---

## Tóm tắt — Mental Model

```
┌─────────────────────────────────────────────────────────────────┐
│                    ACID Implementation Map                       │
│                                                                  │
│  ATOMICITY                                                       │
│    WAL records intent → COMMIT flushes WAL → ROLLBACK undoes    │
│    "All or nothing" guaranteed by WAL + rollback log            │
│                                                                  │
│  DURABILITY                                                      │
│    WAL flushed before client gets OK                            │
│    Checkpoint periodically syncs data pages                     │
│    Crash recovery replays WAL from last checkpoint              │
│                                                                  │
│  CONSISTENCY                                                     │
│    PostgreSQL: constraints, FK, CHECK, triggers                 │
│    Application: business logic, correct transaction design      │
│                                                                  │
│  ISOLATION                                                       │
│    MVCC: readers never block writers, writers never block readers│
│    Snapshot: each transaction sees consistent point-in-time view│
│    SSI (Serializable): dependency tracking, not locking         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Related Notes

- [[02-MVCC-Concurrency]] — MVCC engine chi tiết: snapshot, visibility, xmin/xmax
- [[03-Concurrency-Patterns]] — Bài toán thực tế: lost update, FOR UPDATE, SKIP LOCKED
- [[04-Index-Internals]] — Index và WAL interaction
- [[Microservices-Patterns/Transactional-Outbox]] — Tận dụng ACID cho distributed patterns
- [[Microservices-Patterns/Debezium-CDC-Deep-Dive]] — WAL → CDC pipeline

---

*Tags: #postgresql #acid #wal #durability #isolation #internals*  
*Created: 2026-05-06 | Difficulty: ⭐⭐⭐*
