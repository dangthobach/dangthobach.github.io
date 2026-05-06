# 03 — Concurrency Patterns: Edge Cases & Bài Toán Thực Tế

> **Audience:** Senior engineers cần giải quyết concurrency bugs trong production.  
> **Scope:** Lost update, phantom read, write skew, FOR UPDATE, SKIP LOCKED, advisory locks — với PostgreSQL cụ thể.  
> **Liên kết:** [[01-ACID-Internals]] | [[02-MVCC-Concurrency]] | [[00-PostgreSQL-Hub]]

---

## 📋 Mục lục

1. [Taxonomy of Concurrency Anomalies](#taxonomy-of-concurrency-anomalies)
2. [Lost Update — Bug phổ biến nhất](#lost-update--bug-phổ-biến-nhất)
3. [Read-Modify-Write Pattern](#read-modify-write-pattern)
4. [Phantom Read & Range Locking](#phantom-read--range-locking)
5. [Write Skew — Subtle và nguy hiểm](#write-skew--subtle-và-nguy-hiểm)
6. [SELECT FOR UPDATE & FOR SHARE](#select-for-update--for-share)
7. [SKIP LOCKED — Queue Pattern](#skip-locked--queue-pattern)
8. [Advisory Locks — Application-level coordination](#advisory-locks--application-level-coordination)
9. [Deadlock — Phát hiện và phòng ngừa](#deadlock--phát-hiện-và-phòng-ngừa)
10. [Optimistic vs Pessimistic Locking](#optimistic-vs-pessimistic-locking)
11. [PDMS Case Studies](#pdms-case-studies)

---

## Taxonomy of Concurrency Anomalies

```
┌─────────────────────────────────────────────────────────────────────┐
│           Concurrency Anomaly Map                                    │
│                                                                      │
│  Anomaly           │ Isolation Level Fix      │ PostgreSQL Default   │
│  ─────────────────┼──────────────────────────┼─────────────────────│
│  Dirty Read        │ Read Committed+           │ ✓ Prevented          │
│  Non-repeatable    │ Repeatable Read+          │ ✗ Can happen (RC)    │
│  Phantom Read      │ Serializable (SQL std)    │ ✓ Prevented (PG RR)  │
│  Lost Update       │ FOR UPDATE / Serializable │ ✗ Can happen (RC)    │
│  Write Skew        │ Serializable only         │ ✗ Can happen (RR)    │
│  Read Skew         │ Repeatable Read+           │ ✓ Prevented (PG RR)  │
└─────────────────────────────────────────────────────────────────────┘

Ghi chú: PostgreSQL Repeatable Read mạnh hơn SQL standard —
         ngăn được cả Phantom Read (vốn chỉ cần Serializable theo chuẩn)
```

---

## Lost Update — Bug phổ biến nhất

### Kịch bản

Hai users cùng đặt hàng, kho chỉ còn 10 sản phẩm.

```
Session A                          Session B
─────────────────────────────────────────────────────────────
BEGIN;                             BEGIN;
SELECT stock FROM items            SELECT stock FROM items
  WHERE id=1;                        WHERE id=1;
→ 10                               → 10

-- A quyết định mua 3              -- B quyết định mua 8

UPDATE items                       UPDATE items
  SET stock = 10 - 3 = 7             SET stock = 10 - 8 = 2
  WHERE id = 1;                       WHERE id = 1;

COMMIT;                            COMMIT;

-- Final state: stock = 2
-- A mua 3 + B mua 8 = 11, nhưng kho chỉ có 10!
-- A's update bị LOST!
```

### Tại sao xảy ra với Read Committed?

```
MVCC snapshot được lấy PER STATEMENT (Read Committed):
  A reads stock=10, B reads stock=10 (same committed value)
  A updates: old tuple xmin=X,xmax=A, new tuple xmin=A, stock=7
  B's UPDATE sees A's committed change but its calculation was already done:
    SET stock = 10 - 8 = 2  ← dùng giá trị CŨ 10!
```

### Fix 1: Atomic UPDATE (tốt nhất khi có thể)

```sql
-- ❌ Read-Modify-Write pattern (nguy hiểm)
SELECT stock FROM items WHERE id = 1;   -- application đọc
-- application tính: new_stock = old_stock - quantity
UPDATE items SET stock = :new_stock WHERE id = 1;

-- ✅ Atomic update — database tự calculate
UPDATE items 
SET stock = stock - :quantity
WHERE id = 1 AND stock >= :quantity;
-- Nếu affected_rows = 0 → không đủ hàng

-- Tại sao safe? PostgreSQL thực hiện read-modify-write TRONG CÙNG một operation
-- Không có window cho concurrent modification giữa read và write
```

### Fix 2: SELECT FOR UPDATE (pessimistic lock)

```sql
BEGIN;
SELECT stock FROM items WHERE id = 1 FOR UPDATE;
-- Row bị lock, Session B phải chờ
-- Application tính toán
UPDATE items SET stock = stock - 3 WHERE id = 1;
COMMIT;
-- Lock release, Session B tiếp tục với giá trị mới nhất
```

### Fix 3: Optimistic Locking với version column

```sql
-- Schema
ALTER TABLE items ADD COLUMN version INTEGER DEFAULT 0;

-- Application
BEGIN;
SELECT stock, version FROM items WHERE id = 1;
-- stock=10, version=5

-- Tính toán...

UPDATE items 
SET stock = 7, version = version + 1
WHERE id = 1 AND version = 5;  -- ← compare-and-swap

GET DIAGNOSTICS affected = ROW_COUNT;
IF affected = 0 THEN
    ROLLBACK;
    -- retry với dữ liệu mới
END IF;
COMMIT;
```

---

## Read-Modify-Write Pattern

**Đây là pattern nguy hiểm nhất trong concurrent systems.** Bất cứ khi nào bạn:
1. Đọc giá trị
2. Modify trong application
3. Write lại

Bạn có window cho race condition.

### Phân loại và fix

```
┌──────────────────────────────────────────────────────────────────────┐
│  Case 1: Counter increment                                            │
│                                                                      │
│  ❌  SELECT count FROM stats; -- 100                                  │
│      UPDATE stats SET count = 101;                                    │
│                                                                      │
│  ✅  UPDATE stats SET count = count + 1;                              │
│      -- Hoặc: INSERT ... ON CONFLICT DO UPDATE SET count = count + 1  │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  Case 2: Conditional update (check-then-act)                         │
│                                                                      │
│  ❌  SELECT status FROM docs WHERE id=1; -- 'PENDING'                 │
│      IF status == 'PENDING':                                          │
│          UPDATE docs SET status = 'PROCESSING';                       │
│                                                                      │
│  ✅  UPDATE docs SET status = 'PROCESSING'                            │
│      WHERE id = 1 AND status = 'PENDING';                            │
│      -- Check affected rows: 0 = already processed by another worker  │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  Case 3: Complex business logic requires reading first               │
│                                                                      │
│  → FOR UPDATE + transaction                                           │
│  → Serializable isolation                                             │
│  → Optimistic locking with version                                    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Phantom Read & Range Locking

### Phantom Read — rows xuất hiện/biến mất trong range

```
Session A (Repeatable Read):
  SELECT COUNT(*) FROM doctors WHERE on_call = true;
  → 5

Session B:
  INSERT INTO doctors(name, on_call) VALUES ('Dr. New', true);
  COMMIT;

Session A (vẫn trong cùng transaction):
  SELECT COUNT(*) FROM doctors WHERE on_call = true;
  → 6  ← Phantom! Row mới xuất hiện

--- PostgreSQL behavior ---
Với PostgreSQL Repeatable Read: COUNT vẫn = 5! (Snapshot cũ)
Với Read Committed: COUNT = 6 (phantom visible)
Với Serializable: = 5, và nếu A đã write gì dựa trên count này → serialization error
```

### Khi Phantom Read thật sự là vấn đề

PostgreSQL Repeatable Read ngăn được phần lớn phantom reads qua MVCC. Nhưng có edge case:

```sql
-- Với FOR UPDATE range query:
BEGIN; -- Repeatable Read
SELECT * FROM seats WHERE flight_id = 100 AND status = 'AVAILABLE'
FOR UPDATE;
-- → Lock các rows EXISTING với status='AVAILABLE'
-- → KHÔNG lock against INSERT of new AVAILABLE seats!

-- Session B có thể INSERT new available seat trong lúc này
-- A's lock không cover the "gap"

-- Solution: Application logic + Serializable isolation
-- Hoặc: Lock the flight record thay vì individual seats
BEGIN; -- Serializable
SELECT * FROM flights WHERE id = 100 FOR UPDATE;  -- lock parent
SELECT * FROM seats WHERE flight_id = 100 AND status = 'AVAILABLE';
-- ...
```

---

## Write Skew — Subtle và nguy hiểm

Write Skew xảy ra khi hai transactions đọc overlapping data, quyết định dựa trên những gì thấy, và write vào **different** rows (không phải cùng row).

### Ví dụ cổ điển: Bác sĩ trực

```
Constraint: Phải có ít nhất 1 bác sĩ on_call

Session A (Dr. Alice):                 Session B (Dr. Bob):
─────────────────────────────────────────────────────────────
BEGIN;                                 BEGIN;
SELECT COUNT(*) FROM doctors           SELECT COUNT(*) FROM doctors
  WHERE on_call = true;                  WHERE on_call = true;
→ 2                                    → 2

-- Thấy đủ 2 người, quyết định về     -- Thấy đủ 2 người, quyết định về

UPDATE doctors                         UPDATE doctors
  SET on_call = false                    SET on_call = false
  WHERE name = 'Alice';                  WHERE name = 'Bob';

COMMIT;                                COMMIT;

-- Result: 0 bác sĩ on call! Constraint violated!
-- Cả hai đều update DIFFERENT rows → không trigger lock conflict
```

### Tại sao Repeatable Read không đủ?

```
RR ngăn được: Tx A thấy committed changes của Tx B trong cùng transaction
RR KHÔNG ngăn được: Hai transactions dựa trên shared read, write vào different rows

Write Skew requires: Serializable Snapshot Isolation (SSI)
```

### Fix với Serializable

```sql
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT COUNT(*) FROM doctors WHERE on_call = true;
-- SSI track: Tx A đã đọc "set of doctors on call"

UPDATE doctors SET on_call = false WHERE name = 'Alice';
COMMIT;
-- SSI detect: Tx B cũng đọc cùng set AND đã committed
-- → Nếu cả hai concurrent và commit → serialization failure
-- ERROR: could not serialize access due to read/write dependencies
-- HINT: The transaction might succeed if retried.
```

### Fix thực tế nếu không muốn Serializable overhead

```sql
-- Lock a "sentinel" row để tạo artificial conflict
BEGIN;
SELECT id FROM on_call_constraints WHERE id = 1 FOR UPDATE;  -- Lock sentinel
SELECT COUNT(*) FROM doctors WHERE on_call = true;
IF count > 1 THEN
    UPDATE doctors SET on_call = false WHERE name = 'Alice';
END IF;
COMMIT;

-- Session B cũng lock cùng sentinel row → phải chờ A → sequential execution
```

---

## SELECT FOR UPDATE & FOR SHARE

### Các loại row lock trong PostgreSQL

```
FOR KEY SHARE   — đọc và cho biết sẽ dựa trên key value
                  Block: FOR UPDATE, FOR NO KEY UPDATE
                  Use: FK reference checks

FOR SHARE       — shared read lock
                  Block: FOR UPDATE, FOR NO KEY UPDATE
                  Allow: multiple FOR SHARE concurrent

FOR NO KEY UPDATE — update nhưng không thay đổi key
                    Block: FOR SHARE, FOR KEY SHARE, FOR UPDATE
                    Use: UPDATE non-PK columns

FOR UPDATE      — exclusive lock
                  Block: tất cả các loại trên
                  Use: read-modify-write patterns
```

```sql
-- Phổ biến nhất:
SELECT * FROM orders WHERE id = 1 FOR UPDATE;
-- → Lock row, writer phải chờ cho đến khi transaction kết thúc

-- FOR UPDATE với NOWAIT — fail immediately thay vì wait
SELECT * FROM inventory WHERE product_id = 100 FOR UPDATE NOWAIT;
-- → ERROR: could not obtain lock on row in relation "inventory"
-- Use case: retry logic, không muốn block

-- FOR UPDATE với SKIP LOCKED — bỏ qua locked rows
SELECT * FROM job_queue WHERE status = 'PENDING' FOR UPDATE SKIP LOCKED LIMIT 1;
```

### Lock Granularity

```
Khi bạn dùng FOR UPDATE, PostgreSQL lock:
  1. Row-level lock trên specific tuple(s)
  2. Table-level lock: RowShareLock (nhẹ, không conflict với normal DML)

PostgreSQL KHÔNG lock:
  × Gap locks (MySQL InnoDB có, PostgreSQL không)
  × Predicate locks (chỉ Serializable mới dùng)

Implication:
  FOR UPDATE trên rows hiện tại KHÔNG ngăn INSERT new rows thỏa condition
  → Phantom insert vẫn có thể xảy ra với FOR UPDATE!
```

---

## SKIP LOCKED — Queue Pattern

**SKIP LOCKED** là pattern cực kỳ hữu ích cho job queue trong PostgreSQL.

### Vấn đề với naive queue

```sql
-- ❌ Naive: nhiều workers cùng lấy cùng 1 job
SELECT id FROM jobs WHERE status = 'PENDING' LIMIT 1 FOR UPDATE;
-- Worker 2 phải chờ Worker 1 release lock → serialized, không scale
```

### SKIP LOCKED solution

```sql
-- ✅ Mỗi worker lấy job khác nhau, không ai chờ ai
SELECT id, payload
FROM jobs
WHERE status = 'PENDING'
ORDER BY priority DESC, created_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

```
Timeline với 3 workers:
  Worker 1: locks Job A, Worker 2 sees Job A locked → skip → locks Job B
  Worker 2: locks Job B, Worker 3 sees A,B locked → skip → locks Job C
  → 3 jobs xử lý song song, không contention!
```

### Complete Queue Implementation

```sql
-- Schema
CREATE TABLE job_queue (
    id          BIGSERIAL PRIMARY KEY,
    payload     JSONB NOT NULL,
    status      TEXT NOT NULL DEFAULT 'PENDING',
    priority    INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    error_msg   TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jobqueue_pickup ON job_queue(status, priority DESC, scheduled_at)
WHERE status IN ('PENDING', 'RETRY');

-- Worker: pickup job
WITH picked AS (
    SELECT id FROM job_queue
    WHERE status IN ('PENDING', 'RETRY')
      AND scheduled_at <= NOW()
    ORDER BY priority DESC, scheduled_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
UPDATE job_queue
SET status = 'PROCESSING', updated_at = NOW()
WHERE id = (SELECT id FROM picked)
RETURNING *;

-- Worker: complete job
UPDATE job_queue
SET status = 'DONE', updated_at = NOW()
WHERE id = :job_id;

-- Worker: fail job (với retry logic)
UPDATE job_queue
SET 
    status = CASE WHEN retry_count + 1 >= max_retries THEN 'FAILED' ELSE 'RETRY' END,
    retry_count = retry_count + 1,
    error_msg = :error,
    scheduled_at = NOW() + INTERVAL '1 minute' * POW(2, retry_count),  -- exponential backoff
    updated_at = NOW()
WHERE id = :job_id;
```

---

## Advisory Locks — Application-level coordination

Advisory locks là **application-controlled** locks — PostgreSQL không tự động acquire hay release. Bạn tự quản lý, nhưng chúng tự release khi connection đóng.

### Session vs Transaction scope

```sql
-- SESSION-LEVEL: tồn tại cho đến khi explicitly unlock hoặc connection đóng
SELECT pg_try_advisory_lock(12345);  -- Returns: true nếu acquired, false nếu contention
-- ... do work ...
SELECT pg_advisory_unlock(12345);

-- TRANSACTION-LEVEL: auto-release khi transaction kết thúc
BEGIN;
SELECT pg_try_advisory_xact_lock(12345);  -- Trong transaction
-- ... do work ...
COMMIT;  -- Lock tự release
```

### Use cases

```sql
-- 1. Distributed cron job — chỉ 1 node chạy tại một thời điểm
DO $$
DECLARE
    lock_acquired BOOLEAN;
BEGIN
    SELECT pg_try_advisory_lock(hashtext('daily_report_job')) INTO lock_acquired;
    
    IF lock_acquired THEN
        -- Chạy job
        CALL generate_daily_report();
        PERFORM pg_advisory_unlock(hashtext('daily_report_job'));
    ELSE
        RAISE NOTICE 'Another node is running this job, skipping';
    END IF;
END $$;

-- 2. Per-entity locking (thay thế SELECT FOR UPDATE khi không cần đọc row)
SELECT pg_try_advisory_xact_lock(123);  -- Lock entity ID=123
-- Nếu false → entity đang được xử lý bởi transaction khác

-- 3. Rate limiting (rough)
SELECT pg_try_advisory_lock(user_id);  -- Chỉ 1 concurrent operation per user
```

### Advisory Lock vs SELECT FOR UPDATE

```
┌──────────────────────────────────────────────────────────────────┐
│  Advisory Lock                  │  SELECT FOR UPDATE              │
│  ─────────────────────────────────────────────────────────────── │
│  Application defines lock ID    │  Lock tied to specific row      │
│  No actual table/row required   │  Requires table access          │
│  Lighter weight                 │  Heavier (table lock + row lock)│
│  Manual release (session)       │  Auto release on txn end        │
│  Cross-transaction possible     │  Within transaction only        │
│                                 │                                 │
│  Use: cron coordination,        │  Use: read-modify-write on      │
│  distributed singleton,         │  specific rows                   │
│  application-level mutex        │                                 │
└──────────────────────────────────────────────────────────────────┘
```

---

## Deadlock — Phát hiện và phòng ngừa

PostgreSQL **tự động detect deadlock** và abort một trong các transactions.

### Deadlock scenario

```
Session A                          Session B
─────────────────────────────────────────────────────────────
BEGIN;                             BEGIN;
UPDATE accounts                    UPDATE accounts
  SET balance = balance - 100        SET balance = balance + 50
  WHERE id = 1;                       WHERE id = 2;
-- Lock row 1                       -- Lock row 2

UPDATE accounts                    UPDATE accounts
  SET balance = balance + 100        SET balance = balance - 50
  WHERE id = 2;                       WHERE id = 1;
-- Chờ Session B release row 2    -- Chờ Session A release row 1

-- DEADLOCK DETECTED!
-- PostgreSQL chọn 1 victim và abort
-- ERROR: deadlock detected
-- DETAIL: Process A waits for ShareLock on transaction B;
--         blocked by process B.
--         Process B waits for ShareLock on transaction A;
--         blocked by process A.
```

### Phòng ngừa deadlock

```sql
-- Rule: Luôn lock resources theo thứ tự cố định
-- ❌ A locks (1, 2), B locks (2, 1) → deadlock
-- ✅ Cả A và B lock theo thứ tự (min_id, max_id)

BEGIN;
-- Sort IDs trước khi lock
SELECT * FROM accounts 
WHERE id IN (1, 2) 
ORDER BY id  -- Quan trọng! Consistent ordering
FOR UPDATE;
-- ...
```

```sql
-- Detect deadlock situations
SELECT 
    pid,
    usename,
    pg_blocking_pids(pid) AS blocked_by,
    query,
    state,
    wait_event_type,
    wait_event
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0;
```

### Lock timeout để tránh hung

```sql
-- Set lock timeout — fail fast thay vì chờ indefinitely
SET lock_timeout = '5s';
BEGIN;
SELECT * FROM accounts WHERE id = 1 FOR UPDATE;
-- Nếu không acquire được lock trong 5s:
-- ERROR: canceling statement due to lock timeout

-- Statement timeout — total time limit
SET statement_timeout = '30s';
```

---

## Optimistic vs Pessimistic Locking

### Decision framework

```
┌──────────────────────────────────────────────────────────────────┐
│  Chọn Pessimistic (FOR UPDATE) khi:                              │
│  ✓ Conflict rate cao (> 20% operations gặp conflict)             │
│  ✓ Retry cost cao (expensive operations)                         │
│  ✓ Cần guaranteed progress (không thể chấp nhận retry loop)      │
│  ✓ Critical sections ngắn                                        │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  Chọn Optimistic (version column) khi:                           │
│  ✓ Conflict rate thấp (< 5% operations gặp conflict)             │
│  ✓ Read-heavy workload                                           │
│  ✓ Long-lived operations (không muốn hold lock lâu)              │
│  ✓ Retry là acceptable và cheap                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Optimistic locking implementation

```sql
-- Version-based optimistic locking
CREATE TABLE documents (
    id         BIGSERIAL PRIMARY KEY,
    content    TEXT,
    version    BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Read (no lock)
SELECT id, content, version FROM documents WHERE id = :id;

-- Write (compare-and-swap)
UPDATE documents
SET 
    content = :new_content,
    version = version + 1,
    updated_at = NOW()
WHERE 
    id = :id 
    AND version = :expected_version;

-- Application check
IF affected_rows == 0:
    raise OptimisticLockException("Concurrent modification detected, please retry")
```

---

## PDMS Case Studies

### Case 1: Concurrent document status transition

**Vấn đề:** Nhiều workflow workers có thể cùng pick document để process.

```sql
-- ✅ Safe document pickup với SKIP LOCKED
BEGIN;

WITH candidate AS (
    SELECT id FROM documents
    WHERE status = 'PENDING_REVIEW'
      AND branch_id = :branch_id
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
UPDATE documents
SET 
    status = 'IN_REVIEW',
    reviewer_id = :reviewer_id,
    review_started_at = NOW()
WHERE id = (SELECT id FROM candidate)
RETURNING id, doc_number, status;

COMMIT;
-- Nếu không có document → empty result (không phải error)
```

### Case 2: Warehouse code generation (no duplicate)

**Vấn đề:** Concurrent requests tạo document phải có unique sequential code.

```sql
-- ✅ Atomic counter với advisory lock
CREATE TABLE doc_counters (
    branch_id   TEXT PRIMARY KEY,
    year        INTEGER,
    counter     BIGINT DEFAULT 0
);

-- Function: get next sequence (thread-safe)
CREATE OR REPLACE FUNCTION next_doc_sequence(p_branch_id TEXT, p_year INTEGER)
RETURNS BIGINT AS $$
DECLARE
    v_next BIGINT;
BEGIN
    INSERT INTO doc_counters(branch_id, year, counter)
    VALUES (p_branch_id, p_year, 1)
    ON CONFLICT (branch_id, year) DO UPDATE
        SET counter = doc_counters.counter + 1
    RETURNING counter INTO v_next;
    
    RETURN v_next;
END;
$$ LANGUAGE plpgsql;

-- Usage: generates unique, gapless sequences per branch per year
SELECT next_doc_sequence('HN01', 2026);
-- → 1, 2, 3, ... (never duplicate even under high concurrency)
```

### Case 3: Batch validation với race condition

**Vấn đề:** Batch validation jobs có thể chạy concurrent cho cùng dataset.

```sql
-- ✅ Advisory lock per batch job
CREATE OR REPLACE PROCEDURE run_batch_validation(p_batch_id BIGINT)
AS $$
DECLARE
    v_lock_acquired BOOLEAN;
    v_lock_key BIGINT;
BEGIN
    -- Tạo unique lock key từ batch_id
    v_lock_key := hashtext('batch_validation_' || p_batch_id::text);
    
    -- Try acquire lock (non-blocking)
    SELECT pg_try_advisory_xact_lock(v_lock_key) INTO v_lock_acquired;
    
    IF NOT v_lock_acquired THEN
        RAISE NOTICE 'Batch % đang được xử lý bởi process khác, skip', p_batch_id;
        RETURN;
    END IF;
    
    -- Lock acquired, tiến hành validation
    -- Lock tự động release khi transaction kết thúc
    CALL do_validation_work(p_batch_id);
    
EXCEPTION WHEN OTHERS THEN
    -- Lock vẫn tự release qua transaction rollback
    RAISE;
END;
$$ LANGUAGE plpgsql;
```

### Case 4: Balance check với write skew risk

**Vấn đề:** Transfer tiền — cả hai bên phải check balance trước khi transfer.

```sql
-- ❌ Write skew risk với Repeatable Read
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
-- Hai transactions cùng check balance → cùng transfer → overdraft!

-- ✅ Option 1: Serializable
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT balance FROM accounts WHERE id = :from_id;  -- SSI tracks this read
-- Check balance...
UPDATE accounts SET balance = balance - :amount WHERE id = :from_id;
UPDATE accounts SET balance = balance + :amount WHERE id = :to_id;
COMMIT;

-- ✅ Option 2: Pessimistic lock (simpler, lower overhead than Serializable)
BEGIN;
SELECT balance FROM accounts 
WHERE id IN (:from_id, :to_id) 
ORDER BY id  -- consistent ordering!
FOR UPDATE;

-- Now safe to check and transfer
IF balance_from >= amount THEN
    UPDATE accounts SET balance = balance - :amount WHERE id = :from_id;
    UPDATE accounts SET balance = balance + :amount WHERE id = :to_id;
    COMMIT;
ELSE
    ROLLBACK;
END IF;
```

---

## Quick Reference

```
Bài toán                          │ Solution
──────────────────────────────────┼─────────────────────────────────
Counter increment                 │ Atomic UPDATE (col = col + 1)
Check-then-act                    │ Conditional UPDATE, check rows_affected
Read-modify-write (simple)        │ FOR UPDATE + transaction
Read-modify-write (low conflict)  │ Optimistic locking (version col)
Job queue / worker pool           │ SKIP LOCKED
Singleton job                     │ Advisory lock (pg_try_advisory_lock)
Write skew                        │ Serializable OR lock sentinel row
Deadlock prevention               │ Consistent lock ordering
Long operation coordination       │ Advisory lock (session-level)
```

---

## Related Notes

- [[01-ACID-Internals]] — Isolation levels chi tiết
- [[02-MVCC-Concurrency]] — Tại sao MVCC không ngăn được lost update mặc định
- [[05-Performance-Tuning]] — Lock monitoring, long-running transaction detection
- [[Microservices-Patterns/Transactional-Outbox]] — Pattern tận dụng ACID + queue

---

*Tags: #postgresql #concurrency #locking #mvcc #patterns*  
*Created: 2026-05-06 | Difficulty: ⭐⭐⭐⭐*
