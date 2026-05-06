# 15 — Transaction Isolation Levels: So Sánh Across Databases

> **Audience:** Senior engineers cần hiểu isolation levels ở mức chính xác, không phải "textbook definition".  
> **Scope:** SQL standard vs real implementations, anomalies matrix, concurrency problems thực tế, PostgreSQL/MySQL/Oracle/SQL Server.  
> **Liên kết:** [[01-ACID-Internals]] | [[08-MVCC-MySQL-PostgreSQL-Oracle]] | [[03-Concurrency-Patterns]]

---

## 📋 Mục lục

1. [SQL Standard — Baseline definitions](#1-sql-standard)
2. [Anomaly taxonomy — Exactly what each level prevents](#2-anomaly-taxonomy)
3. [PostgreSQL isolation — Stronger than standard](#3-postgresql)
4. [MySQL InnoDB — Default RR với Gap Locks](#4-mysql-innodb)
5. [Oracle — SI dưới tên Serializable](#5-oracle)
6. [SQL Server — All 4 levels + 2 bonus](#6-sql-server)
7. [Cross-database comparison matrix](#7-comparison-matrix)
8. [Common Concurrency Problems và Solutions](#8-common-problems)
9. [Choosing the right level](#9-choosing)

---

## 1. SQL Standard

SQL:1992 định nghĩa 4 isolation levels và 3 anomalies cần tránh:

```
┌──────────────────────────────────────────────────────────────────────┐
│                   SQL:1992 Standard                                   │
│                                                                      │
│  Isolation Level    │ Dirty Read │ Non-repeatable │ Phantom Read     │
│  ───────────────────┼────────────┼────────────────┼──────────────── │
│  Read Uncommitted   │ Allowed    │ Allowed        │ Allowed          │
│  Read Committed     │ Prevented  │ Allowed        │ Allowed          │
│  Repeatable Read    │ Prevented  │ Prevented      │ Allowed          │
│  Serializable       │ Prevented  │ Prevented      │ Prevented        │
│                                                                      │
│  Standard ONLY defines what's PREVENTED, not HOW to prevent it      │
│  → Each DB vendor implements differently!                            │
│  → Some DBs prevent MORE than required by their stated level        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. Anomaly taxonomy

```
┌──────────────────────────────────────────────────────────────────────┐
│                   Concurrency Anomaly Definitions                     │
│                                                                      │
│  DIRTY READ                                                          │
│  Tx A reads data written by Tx B (not yet committed)                 │
│  If B rolls back → A has read data that "never existed"              │
│  Example: A reads balance=500 from B's UPDATE; B rolls back → 1000  │
│                                                                      │
│  NON-REPEATABLE READ                                                 │
│  Tx A reads row; Tx B updates that row and commits;                  │
│  A reads again → different value                                     │
│  Example: A sees balance=1000; B commits UPDATE to 500;              │
│           A reads again → 500 (changed!)                             │
│                                                                      │
│  PHANTOM READ                                                        │
│  Tx A queries with predicate; Tx B inserts row matching predicate;   │
│  A re-queries → additional "phantom" row appears                     │
│  Example: A counts pending_docs=5; B inserts new pending doc;        │
│           A counts again → 6 (phantom appeared!)                     │
│                                                                      │
│  LOST UPDATE (not in SQL:1992, but critical in practice)             │
│  Tx A and B both read value, both update based on read value         │
│  Last writer wins, first writer's update is "lost"                   │
│  Example: both read stock=10; A writes 7; B writes 8 → stock=8      │
│           A's "order of 3" is lost!                                  │
│                                                                      │
│  WRITE SKEW (requires Serializable to prevent)                       │
│  Two Txs each read overlapping data, each writes to different rows   │
│  based on what they read, resulting in invariant violation           │
│  Example: Doctor on-call check (see [[03-Concurrency-Patterns]])     │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. PostgreSQL

**Key insight:** PostgreSQL Repeatable Read is stronger than SQL standard requires.

```
┌──────────────────────────────────────────────────────────────────────┐
│                 PostgreSQL Isolation Implementation                   │
│                                                                      │
│  Level              │ Mechanism              │ Notes                 │
│  ───────────────────┼────────────────────────┼─────────────────────│
│  Read Uncommitted   │ = Read Committed       │ Dirty reads NEVER    │
│                     │ (same code path)       │ happen in PostgreSQL  │
│  Read Committed     │ MVCC snapshot          │ New snapshot per      │
│                     │ per-statement          │ STATEMENT            │
│  Repeatable Read    │ MVCC snapshot          │ Snapshot at first     │
│                     │ per-transaction        │ statement of Tx      │
│  Serializable       │ SSI (Serializable      │ Detects write skew   │
│                     │ Snapshot Isolation)    │ cycles, no locking   │
└──────────────────────────────────────────────────────────────────────┘
```

### PostgreSQL Repeatable Read prevents PHANTOM READ

```sql
-- This is stronger than SQL standard (which allows phantoms at RR):
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;

SELECT COUNT(*) FROM documents WHERE status = 'PENDING';
-- returns: 50

-- Another session: INSERT INTO documents(status) VALUES('PENDING'); COMMIT;

SELECT COUNT(*) FROM documents WHERE status = 'PENDING';
-- returns: 50  ← still 50! Phantom prevented via MVCC snapshot
-- SQL standard would allow 51 at Repeatable Read level

COMMIT;
```

### PostgreSQL Serializable — SSI mechanics

```sql
-- SSI tracks read-write dependencies between transactions
-- If circular dependency detected → one tx aborts

BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;

-- SSI tracks: "Tx A read this data at this version"
SELECT SUM(balance) FROM accounts WHERE user_id = 100;  -- tracked

-- If another serializable tx modifies data we read AND we modify
-- data they read → cycle detected → serialization failure

UPDATE accounts SET balance = balance + 100 WHERE user_id = 200;
COMMIT;
-- → May get: ERROR: could not serialize access due to read/write dependencies
-- → Application must RETRY the transaction
```

```sql
-- Retry pattern for Serializable:
const MAX_RETRIES = 3;
for (int i = 0; i < MAX_RETRIES; i++) {
    try {
        BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
        // ... business logic ...
        COMMIT;
        break;
    } catch (SerializationException e) {
        ROLLBACK;
        if (i == MAX_RETRIES - 1) throw e;
        // exponential backoff before retry
    }
}
```

---

## 4. MySQL InnoDB

**Key insight:** MySQL default is Repeatable Read (not Read Committed like PostgreSQL/Oracle).

```
┌──────────────────────────────────────────────────────────────────────┐
│                   MySQL InnoDB Isolation                              │
│                                                                      │
│  Level              │ Mechanism                  │ Notes             │
│  ───────────────────┼────────────────────────────┼─────────────────│
│  Read Uncommitted   │ No locks, no version check │ Dirty reads OK   │
│                     │                            │ (dangerous!)     │
│  Read Committed     │ ReadView per statement     │ Statement-level  │
│                     │ Release row locks early    │ snapshot         │
│  Repeatable Read    │ ReadView per transaction   │ DEFAULT level    │
│  (DEFAULT)          │ + Gap Locks + Next-key     │ Phantom-safe via │
│                     │ Locks                      │ gap locks        │
│  Serializable       │ Converts all SELECTs to    │ 2PL locking,     │
│                     │ SELECT ... FOR SHARE       │ not SSI          │
└──────────────────────────────────────────────────────────────────────┘
```

### MySQL Gap Locks — Unique to InnoDB

```sql
-- MySQL Repeatable Read uses GAP LOCKS to prevent phantom inserts:
BEGIN;
SELECT * FROM orders WHERE amount BETWEEN 100 AND 200 FOR UPDATE;
-- InnoDB locks:
--   Row lock on existing rows where amount BETWEEN 100 AND 200
--   Gap lock on "space" between those rows (and beyond)
-- → Any INSERT with amount in [100,200] range from another session → BLOCKS!

-- This is why MySQL RR prevents phantoms (different mechanism from PG's MVCC)

-- Gap locks cause more deadlocks than PostgreSQL:
-- Session A: locks gap [100,200]
-- Session B: locks gap [150,250]
-- Session A: tries to extend lock → DEADLOCK!
-- → More deadlock potential than PostgreSQL's MVCC approach
```

### MySQL RC often better for OLTP

```sql
-- Many MySQL DBAs recommend READ COMMITTED for high-concurrency OLTP:
-- RC advantages over RR:
-- 1. No gap locks → fewer deadlocks
-- 2. Row locks released earlier (semi-consistent reads)
-- 3. Sufficient for most OLTP use cases

SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- Change default in my.cnf:
-- transaction-isolation = READ-COMMITTED
```

---

## 5. Oracle

**Key insight:** Oracle's "Serializable" is actually Snapshot Isolation — does NOT prevent write skew!

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Oracle Isolation                                   │
│                                                                      │
│  Level              │ Oracle Implementation    │ Notes               │
│  ───────────────────┼──────────────────────────┼─────────────────── │
│  Read Committed     │ SCN-based read snapshot  │ DEFAULT             │
│  (DEFAULT)          │ per-statement             │ Statement-level     │
│                     │                          │ consistent read     │
│  Read Only          │ Snapshot at tx start     │ No writes allowed   │
│                     │ = PG Repeatable Read     │ (not in SQL std)    │
│  Serializable       │ Snapshot at tx start     │ = Snapshot          │
│                     │                          │ Isolation!          │
│                     │                          │ Write skew ALLOWED! │
└──────────────────────────────────────────────────────────────────────┘
```

### Oracle Serializable ≠ True Serializable

```sql
-- Oracle "Serializable" = Snapshot Isolation (PG Repeatable Read equivalent)
-- DOES NOT prevent write skew!

-- Two concurrent Oracle SERIALIZABLE transactions:
-- Session A: reads 2 doctors on-call, removes Alice
-- Session B: reads 2 doctors on-call, removes Bob
-- Both COMMIT successfully → 0 doctors on call!

-- Oracle prevents: dirty read, non-repeatable read, phantom read
-- Oracle does NOT prevent: write skew, lost update (without FOR UPDATE)

-- ORA-08177: "can't serialize access for this transaction"
-- When: session tries to UPDATE a row modified since snapshot
-- Rarer than PG SSI failures (different trigger condition)
```

### Oracle-specific: SELECT FOR UPDATE NOWAIT / SKIP LOCKED

```sql
-- Oracle FOR UPDATE NOWAIT (similar to PostgreSQL):
SELECT * FROM accounts WHERE id = 1 FOR UPDATE NOWAIT;
-- ORA-00054: resource busy and acquire with NOWAIT specified

-- Oracle SKIP LOCKED (12c+):
SELECT * FROM job_queue
WHERE status = 'PENDING'
  AND ROWNUM <= 1
FOR UPDATE SKIP LOCKED;

-- Oracle uses ROW SHARE TABLE LOCK when using FOR UPDATE
-- (different lock level names than PostgreSQL)
```

---

## 6. SQL Server

SQL Server has all 4 standard levels PLUS 2 additional ones:

```
┌──────────────────────────────────────────────────────────────────────┐
│                  SQL Server Isolation Levels                          │
│                                                                      │
│  Level                  │ Mechanism       │ Notes                    │
│  ───────────────────────┼─────────────────┼────────────────────────│
│  Read Uncommitted       │ No locks        │ Dirty reads OK          │
│  Read Committed (DEF)   │ Shared lock     │ DEFAULT (lock-based)    │
│                         │ released ASAP   │                         │
│  Read Committed         │ MVCC-like       │ Requires RCSI enabled   │
│  Snapshot (RCSI)        │ row versioning  │ Good for OLTP           │
│  Repeatable Read        │ Shared locks    │ Holds locks til commit  │
│                         │ held til commit │                         │
│  Snapshot               │ Transaction-    │ Like PG Repeatable Read │
│                         │ level snapshot  │ Requires enabling       │
│  Serializable           │ Range locks     │ Like MySQL 2PL          │
└──────────────────────────────────────────────────────────────────────┘
```

```sql
-- Enable RCSI (Read Committed Snapshot Isolation) - recommended:
ALTER DATABASE MyDB SET READ_COMMITTED_SNAPSHOT ON;
-- After: Read Committed uses row versioning instead of locks
-- → Readers don't block writers, writers don't block readers
-- → Similar behavior to PostgreSQL Read Committed

-- Enable Snapshot level:
ALTER DATABASE MyDB SET ALLOW_SNAPSHOT_ISOLATION ON;
-- Then in session:
SET TRANSACTION ISOLATION LEVEL SNAPSHOT;
```

---

## 7. Cross-Database Comparison Matrix

```
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│                        Full Anomaly Prevention Matrix                                           │
│                                                                                                │
│  Anomaly          │ PG RC │ PG RR │ PG Ser │ My RC │ My RR │ My Ser │ Ora RC │ Ora Ser │ SS │
│  ─────────────────┼───────┼───────┼────────┼───────┼───────┼────────┼────────┼─────────┼───│
│  Dirty Read       │  ✓    │  ✓    │  ✓     │  ✓    │  ✓    │  ✓     │  ✓     │  ✓      │ ✓  │
│  Non-repeatable   │  ✗    │  ✓    │  ✓     │  ✗    │  ✓    │  ✓     │  ✗     │  ✓      │ ✓  │
│  Phantom Read     │  ✗    │  ✓*   │  ✓     │  ✗    │  ✓†   │  ✓     │  ✗     │  ✓*     │ ✓  │
│  Lost Update      │  ✗    │  ✗    │  ✓     │  ✗    │  ✗    │  ✓     │  ✗     │  ✗      │ ✓  │
│  Write Skew       │  ✗    │  ✗    │  ✓     │  ✗    │  ✗    │  ✓§    │  ✗     │  ✗      │ ?  │
│  Deadlock risk    │  Low  │  Low  │  Med   │  Low  │  High │  High  │  Low   │  Low    │ Med│
│                                                                                                │
│  Columns: PG=PostgreSQL, My=MySQL, Ora=Oracle, SS=SQL Server Snapshot                        │
│  ✓ = Prevented  ✗ = Possible  * = Via snapshot (stronger than SQL std) † = Via gap locks      │
│  § = Via 2PL (more deadlocks)  ? = SS Snapshot prevents most but not all write skew          │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Defaults comparison

```
Database        │ Default Isolation Level    │ Mechanism
────────────────┼────────────────────────────┼──────────────────────
PostgreSQL      │ Read Committed             │ MVCC snapshot/statement
MySQL InnoDB    │ Repeatable Read            │ MVCC + Gap Locks
Oracle          │ Read Committed             │ SCN snapshot/statement
SQL Server      │ Read Committed             │ Lock-based (or RCSI)
SQLite          │ Serializable               │ File-level locking
```

---

## 8. Common Concurrency Problems và Solutions

### Problem 1: Lost Update

```
Scenario: 2 users update same inventory

Session A: SELECT stock=10; stock = 10 - 3 = 7; UPDATE stock=7; COMMIT
Session B: SELECT stock=10; stock = 10 - 8 = 2; UPDATE stock=2; COMMIT ← OVERWRITES A!

Affected isolation levels: All RC-level databases (default for PG, Oracle, SS)
MySQL RR: ALSO affected (gap locks don't help here)
```

```sql
-- Solution 1: Atomic UPDATE (best)
UPDATE inventory SET stock = stock - :qty WHERE id = :id AND stock >= :qty;
-- Check affected_rows = 0 → insufficient stock (not a lost update issue)

-- Solution 2: SELECT FOR UPDATE (pessimistic)
BEGIN;
SELECT stock FROM inventory WHERE id = :id FOR UPDATE;
-- ... calculate ...
UPDATE inventory SET stock = :new_stock WHERE id = :id;
COMMIT;

-- Solution 3: Optimistic locking
UPDATE inventory SET stock = :new_val, version = version + 1
WHERE id = :id AND version = :expected_version;
-- affected_rows = 0 → retry
```

### Problem 2: Read-Modify-Write Race Condition

```
Status machine: PENDING → PROCESSING → DONE
Two workers pick the same PENDING document:

Worker A: SELECT status=PENDING; UPDATE status=PROCESSING; ← ok
Worker B: SELECT status=PENDING (same snapshot!); UPDATE status=PROCESSING; ← duplicate!
```

```sql
-- Solution: Atomic conditional UPDATE (all databases):
UPDATE documents
SET status = 'PROCESSING', worker_id = :worker_id
WHERE id = :id AND status = 'PENDING';   -- ← only succeeds if still PENDING
-- Check affected_rows: 0 = someone else got it first

-- Solution: SKIP LOCKED (PostgreSQL, Oracle 12c+, SQL Server 2005+):
SELECT id FROM documents
WHERE status = 'PENDING'
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

### Problem 3: Double-spend / Overdraft

```
Account balance: 1000
Two concurrent withdrawals of 900:
Both read balance=1000, both check 1000 >= 900, both write balance=100
Result: 2x withdrawal but only 1x deducted!
```

```sql
-- Solution: Constraint + atomic UPDATE:
UPDATE accounts
SET balance = balance - :amount
WHERE id = :id AND balance >= :amount;
-- If affected_rows = 0 → insufficient funds

-- Or: CHECK constraint in DB schema:
ALTER TABLE accounts ADD CONSTRAINT chk_balance_positive CHECK (balance >= 0);
-- DB will reject negative balance → error on violating UPDATE
```

### Problem 4: Phantom causing inventory over-allocation

```
Warehouse has 5 slots available
Two users concurrently allocate:
Both SELECT COUNT(*)=0 open orders → both decide to create order
Result: 2 orders but only 5 slots!
```

```sql
-- Solution: Serializable isolation (PostgreSQL):
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT COUNT(*) FROM allocations WHERE warehouse_id = :wid; -- SSI tracks this
INSERT INTO allocations(warehouse_id, amount) VALUES(:wid, :qty);
COMMIT;
-- If both run concurrently → one gets serialization error → retry

-- Solution: Row-level counter with constraint:
UPDATE warehouse SET available = available - :qty
WHERE id = :wid AND available >= :qty;
-- Atomic: if 0 affected → no slots → don't create order
```

### Problem 5: Write Skew (hardest to detect)

```
Hospital scheduling: must have >= 1 doctor on call
Both Dr. A and Dr. B see 2 doctors → both decide it's safe to go off call
Both UPDATE their own row → 0 doctors on call (invariant violated)
```

```sql
-- Solution 1: PostgreSQL Serializable (SSI detects the cycle):
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
-- SSI will abort one transaction when it detects the read-write dependency cycle

-- Solution 2: Explicit sentinel lock (works at any isolation level):
BEGIN;
SELECT 1 FROM on_call_config WHERE id = 1 FOR UPDATE; -- lock sentinel
SELECT COUNT(*) FROM doctors WHERE on_call = true;    -- check invariant
IF count > 1 THEN
    UPDATE doctors SET on_call = false WHERE id = :my_id;
END IF;
COMMIT;

-- Solution 3: Materialized constraint as counter:
ALTER TABLE on_call_tracking ADD CONSTRAINT min_one_doctor
    CHECK (active_count >= 1);
-- Any UPDATE that would violate → DB rejects
```

---

## 9. Choosing the right level

```
Decision Framework:
─────────────────────────────────────────────────────────────────────
Q1: Do you need to read uncommitted data? (almost never)
  YES → Read Uncommitted (logs, monitoring only)
  NO  → continue

Q2: Can you tolerate reading different values in same transaction?
  YES → Read Committed (PG/Oracle default; good for most OLTP)
  NO  → continue

Q3: Can you tolerate phantom rows appearing mid-transaction?
  With PG/MySQL: Repeatable Read prevents phantoms anyway (stronger impl)
  With Oracle: YES=RC, NO=Serializable
  NO  → continue

Q4: Do you have write skew concerns? (rare but serious)
  Example: decisions based on aggregate reads, multi-row invariants
  YES → Serializable (PG SSI; MySQL 2PL; Oracle=no true solution)

Q5: Performance vs Correctness trade-off?
  High throughput, low contention: Read Committed
  Data integrity critical, occasional retry OK: Serializable

Banking PDMS Recommendations:
─────────────────────────────────────────────────────────────────────
  Document status transitions:  Read Committed + FOR UPDATE SKIP LOCKED
  Financial calculations:        Serializable OR Read Committed + FOR UPDATE
  Reporting queries:             Read Committed (PG default) is sufficient
  Batch jobs:                    Read Committed (each statement gets fresh snapshot)
  Audit/compliance reads:        Read Committed (consistent per-statement)
```

---

## Related Notes

- [[01-ACID-Internals]] — PostgreSQL isolation implementation details
- [[08-MVCC-MySQL-PostgreSQL-Oracle]] — MVCC mechanisms comparison
- [[03-Concurrency-Patterns]] — FOR UPDATE, SKIP LOCKED, write skew solutions

---

*Tags: #isolation-levels #transactions #postgresql #mysql #oracle #concurrency*
*Created: 2026-05-07 | Difficulty: ⭐⭐⭐⭐*
