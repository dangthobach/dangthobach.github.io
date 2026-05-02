---
tags: [concepts, distributed-systems, clocks, ordering, causality, evergreen]
created: 2026-05-02
difficulty: advanced
estimated-read: 20 min
links: [consensus-raft-paxos, consistency-models-spectrum]
---

# ⏰ Distributed Clocks & Event Ordering — Tại sao "Thời gian" là vấn đề khó trong Distributed Systems

> **Mục tiêu:** Hiểu tại sao `System.currentTimeMillis()` không đủ để ordering events trong distributed system, và các công cụ thay thế.

---

## 🎯 Vấn đề thực tế

```
Scenario: Banking system — 2 services ghi transaction

Service A (Server Hà Nội):    12:00:00.100  "Transfer $100 to B"
Service B (Server TP.HCM):    12:00:00.099  "Account balance: $50"

Câu hỏi: Transfer xảy ra TRƯỚC hay SAU khi check balance?
→ Theo wall clock: Transfer sau (100ms > 99ms)
→ Nhưng nếu clock drift: không thể chắc chắn!

NTP (Network Time Protocol) accuracy: ±1-10ms thông thường
                                       ±100ms nếu mạng bất ổn
→ 2 events trong vòng 10ms = không thể xác định order bằng wall clock!
```

**Đây là vấn đề cốt lõi của distributed systems.**

---

## 🕐 Wall Clock vs Monotonic Clock

```
Wall Clock (System.currentTimeMillis() / time.Now()):
→ Absolute time (UTC)
→ Có thể bị điều chỉnh (NTP sync, leap seconds, sysadmin)
→ Có thể backward (NTP step adjustment)
→ KHÔNG dùng để measure duration hay ordering events

Monotonic Clock (System.nanoTime() / time.Since()):
→ Chỉ tiến về phía trước (không backward)
→ Relative time from some point
→ Dùng để measure elapsed time, timeouts
→ KHÔNG so sánh được giữa 2 machines!
```

```java
// ❌ Wrong: dùng wall clock cho elapsed time
long start = System.currentTimeMillis();
// ... some work ...
// NTP sync happens here, clock jumps back!
long elapsed = System.currentTimeMillis() - start; // NEGATIVE!

// ✅ Correct: monotonic clock
long start = System.nanoTime();
// ... some work ...
long elapsed = System.nanoTime() - start; // always positive
```

---

## 📐 Lamport Logical Clock

**Leslie Lamport (1978):** "Happens-before" relationship để ordering events.

### Happens-Before (→) Relation

```
Rule 1: Same process — if a comes before b → a → b
Rule 2: Message send/receive — if a = send(m), b = receive(m) → a → b
Rule 3: Transitivity — if a → b and b → c → a → c

Concurrent events: a ∥ b  (neither a → b nor b → a)
```

### Lamport Timestamp Algorithm

```
Each process maintains counter C, initialized to 0.

Rule: Before each event, C++
Rule: On send(m): include C in message
Rule: On receive(m): C = max(C, m.C) + 1

Example:

Process P1:          Process P2:          Process P3:
C=1: local event     C=1: local event
C=2: send m1 ──────► C=2: max(1,2)+1=3
                      C=3: send m2 ──────► C=3: max(0,3)+1=4
C=5: max(2,4)+1=5 ◄── ────── send m3 ──────C=4: send m3

Timestamps:
P1: {1, 2, 5}
P2: {1, 3}
P3: {4}

Ordering: 1(P1) || 1(P2) || 2(P1) → 3(P2) → 4(P3) → 5(P1)
```

**Vấn đề:** Lamport timestamp chỉ cho phép: `C(a) < C(b) → a → b`
Không thể kết luận ngược: `C(a) < C(b)` KHÔNG PHẢI là `a → b`

---

## 🔢 Vector Clocks

**Colin Fidge & Friedemann Mattern (1988):** Fix vấn đề của Lamport clock.

### Algorithm

```
N processes → mỗi process có vector V[N], initialized to [0,0,...,0]

Rule: On local event: V[self]++
Rule: On send(m): V[self]++, include V in message
Rule: On receive(m): V[self]++, V[i] = max(V[i], m.V[i]) for all i

Example với 3 processes: P1, P2, P3

Step-by-step:
                P1              P2              P3
Start:         [0,0,0]         [0,0,0]         [0,0,0]
P1 local:      [1,0,0]
P1 sends m1:   [2,0,0] ──────► [2,1,0]   (max + P2 increments)
P2 local:                      [2,2,0]
P2 sends m2:                   [2,3,0] ──────► [2,3,1]
P1 local:      [3,0,0]
P3 sends m3:                               [2,3,2] ──────► P1
P1 receives:   [4,3,2]   (max(3,2)+1, max(0,3), max(0,2))
```

### Comparing Vector Clocks

```
V(a) < V(b):  a → b  (a happened before b)
V(a) > V(b):  b → a
V(a) || V(b): concurrent events (incomparable)

a = [2,2,0]   vs   b = [2,3,2]
a[0]=2 ≤ b[0]=2 ✓
a[1]=2 ≤ b[1]=3 ✓
a[2]=0 ≤ b[2]=2 ✓
→ V(a) ≤ V(b) and ≠ → a → b  ✓

a = [3,0,0]   vs   b = [2,3,2]
a[0]=3 > b[0]=2 → NOT a → b
b[1]=3 > a[1]=0 → NOT b → a
→ a ∥ b (concurrent!)
```

---

## ⚡ Hybrid Logical Clocks (HLC)

**Best of both worlds:** Wall clock time + logical ordering.

```
HLC = (WallTime, Logical)

Rule: 
  l.e = max(l.e, PT.e)  // PT = Physical Time
  c.e = 0 if l.e > max(l.e-1, m.l)
        else if l.e == m.l: max(c.e-1, m.c) + 1
             else: c.e-1 + 1

Properties:
1. Captures happens-before (like Lamport)
2. Close to physical time (PT drift bounded by ε)
3. Comparable across nodes (unlike pure Lamport)
```

**Used by:** CockroachDB, Yugabyte

```
CockroachDB HLC:
- Read timestamp: HLC at start of transaction
- Guarantees: if transaction A commits before B starts
  → B sees A's writes
- Clock uncertainty: B waits for A's HLC + max_clock_drift (500ms)
  to be safe
```

---

## 🌐 Google Spanner — TrueTime

```
TrueTime API: not a single timestamp, but an interval [earliest, latest]

TrueTime.now() → {earliest, latest}  // GPS + atomic clocks
Uncertainty: ε ≈ 1-7ms (vs NTP's 1-10ms, but guaranteed!)

Commit Wait protocol:
1. Server commits transaction at time T_commit
2. Server WAITS until TrueTime.now().earliest > T_commit
   (waits for ε = ~7ms)
3. Then releases to clients
→ Guarantees: if T1 commits before T2 starts → T1.commit < T2.start

This gives external consistency (stronger than linearizability!)
at cost of ~7ms commit latency per transaction
```

---

## 🔑 Event Sourcing & Timestamps

**Trong Event Sourcing (như Kafka):**
```
Kafka partition: total order guaranteed (single partition)
  → Use partition offset as logical clock ✓
  → offset 100 always before offset 101

Across partitions: NO order guarantee
  → Use application-level timestamp + vector clock
  → Kafka Streams: uses event time + watermarks

Best practice:
event.metadata.timestamp = wall_clock  // for human readability
event.metadata.sequence  = vector_clock or Lamport  // for ordering
```

---

## 💡 Tips & Tricks

> **Tip 1 — Đừng dùng database auto-increment làm event ordering**
> ```sql
> -- ❌ Nguy hiểm trong distributed setup
> CREATE SEQUENCE event_seq;
> -- Gap in sequence không có nghĩa gap in time
> -- Multiple nodes → sequence collision
>
> -- ✅ Dùng UUIDv7 (time-ordered UUID)
> -- UUIDv7 = 48-bit timestamp + 12-bit seq + random
> -- Sortable, globally unique, includes time
> SELECT gen_random_uuid();          -- UUIDv4 (no order)
> SELECT uuid_generate_v7();         -- UUIDv7 (time-ordered)
> ```

> **Tip 2 — NTP sync check**
> ```bash
> timedatectl status          # Check NTP sync status
> chronyc tracking            # Check clock offset and drift
> # offset should be < 10ms
> # If offset > 100ms: investigate network/NTP server
> ```

> **Tip 3 — Kafka consumer ordering**
> ```java
> // Kafka guarantees order within partition
> // If you need global order across partitions:
> // → Use single partition (but limited throughput)
> // → Or use application-level sequence numbers
> // → Kafka Streams with event-time processing + watermarks
> ```

> **Tip 4 — PostgreSQL MVCC và timestamps**
> ```sql
> -- PostgreSQL uses transaction ID (XID), not timestamps for MVCC
> -- xmin/xmax = transaction IDs (logical clock)
> -- pg_current_xact_id() returns current transaction ID
> SELECT xmin, xmax, * FROM my_table;
> -- Not wall clock! This is why PostgreSQL is MVCC-correct
> ```

---

## 🔬 Case Studies

### Case Study 1: Amazon DynamoDB — Last-Writer-Wins
```
DynamoDB default: Last-Writer-Wins (LWW) dùng wall clock timestamp
Problem:
- Node A writes key="balance" value=100 at T=100ms
- Node B writes key="balance" value=50  at T=99ms (clock drift!)
- Replication: B's write (T=99) loses to A's write (T=100) → OK
- But if B's clock is 200ms ahead:
  B writes at T=300ms → B WINS over A's T=100ms
  → Incorrect result!

Fix: DynamoDB Transactions (2018) using optimistic locking
with version numbers (logical clock) instead of timestamps
```

### Case Study 2: Git — Distributed Version Control
```
Git không dùng timestamps cho ordering commits.
Git dùng: SHA-1 hash của (parent_hash + content + author + message)

Merge = explicit causality:
merge commit.parents = [commit_A, commit_B]
→ Vector clock concept: merge has both parents in its "history"
→ git log --graph shows the DAG (Directed Acyclic Graph)

This is why git is correct even with offline commits
and clocks out of sync
```

### Case Study 3: PDMS Event Log
```
PDMS Transactional Outbox: sự kiện được ghi với created_at timestamp
Potential issue:
- Service A ở container 1 ghi event T=100ms
- Service B ở container 2 ghi event T=99ms (drift 1ms)
- Kafka consumer đọc theo offset → thứ tự đúng (offset đúng)
- Nhưng nếu consumer cần biết "event nào xảy ra trước":
  → Timestamp không đáng tin
  → Cần dùng aggregate_version (application-level sequence)

Recommendation: Mỗi aggregate có version counter
  UPDATE orders SET version = version + 1 WHERE id = ?
  → Optimistic locking + ordering trong single aggregate
```

---

## 📝 Key Takeaways

1. **Wall clock không đủ** để order events trong distributed system — NTP drift ±10ms
2. **Monotonic clock** tốt cho local duration, KHÔNG so sánh được cross-machine
3. **Lamport clock** = logical counter, capture happens-before nhưng không reversible
4. **Vector clock** = N-dimensional counter, detect concurrent events chính xác
5. **HLC** = wall clock + logical, dùng trong CockroachDB, Yugabyte
6. **TrueTime** = Google's GPS + atomic clock API, ε ≈ 7ms uncertainty
7. **Kafka offset** = logical clock trong partition, KHÔNG cross-partition
8. **UUIDv7** = time-ordered UUID, tốt hơn UUIDv4 cho sortable IDs

---

## 🔗 Liên kết

- [[consensus-raft-paxos]] — Consensus cần ordering guarantees
- [[consistency-models-spectrum]] — Linearizability requires global ordering
- [[Microservices-Patterns/Event-Sourcing]] — Events cần ordering
- [[Microservices-Patterns/Kafka-Partition-and-Offset-Internals]] — Kafka offset as clock
- [[MOC-Distributed-Systems]] — Distributed systems overview
