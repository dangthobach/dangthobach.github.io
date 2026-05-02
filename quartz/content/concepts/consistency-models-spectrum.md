---
tags: [concepts, distributed-systems, consistency, linearizability, cap, evergreen]
created: 2026-05-02
difficulty: advanced
estimated-read: 25 min
links: [consensus-raft-paxos, distributed-clocks-ordering, cap-pacelc-deep-dive]
---

# 🔄 Consistency Models Spectrum — Từ Linearizability đến Eventual Consistency

> **Mục tiêu:** Hiểu đúng consistency không phải là binary (có/không) mà là một spectrum. Biết database/system bạn dùng đang ở đâu trên spectrum này.

---

## 🎯 Tại sao quan trọng?

```
Câu hỏi senior engineer thường sai:
"PostgreSQL có ACID không? → Có"
"MongoDB có ACID không? → Tùy version"
"Cassandra có consistent không? → Tunable"

Câu hỏi đúng hơn:
"PostgreSQL cho single-node: Serializable isolation → Linearizable reads?"
"PostgreSQL replication (async): Strong vs eventual cho reads on replica?"
"Cassandra với QUORUM read/write: nào có strong consistency?"

→ Consistency là spectrum, không phải toggle.
```

---

## 🗺️ Consistency Hierarchy

```
Strongest                                                    Weakest
    │                                                            │
    ▼                                                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  STRICT SERIALIZABILITY (Linearizable + Serializable)           │
│  = Spanner, CockroachDB, etcd, PostgreSQL SERIALIZABLE (single) │
├──────────────────────────────────────────────────────────────────┤
│  LINEARIZABILITY (Single-Object Strong Consistency)             │
│  = etcd, ZooKeeper, Raft consensus                              │
├──────────────────────────────────────────────────────────────────┤
│  SEQUENTIAL CONSISTENCY                                         │
│  = All processes see same order, but maybe not real-time order  │
├──────────────────────────────────────────────────────────────────┤
│  CAUSAL CONSISTENCY                                             │
│  = Causally related ops are seen in order, concurrent ops not   │
│  = MongoDB causal sessions (4.0+), COPS system                  │
├──────────────────────────────────────────────────────────────────┤
│  MONOTONIC READ CONSISTENCY                                     │
│  = Once you read X=5, you never read X=3 later                  │
├──────────────────────────────────────────────────────────────────┤
│  READ-YOUR-WRITES (Session Consistency)                         │
│  = You always see your own writes                               │
│  = Sticky sessions, primary read preference                     │
├──────────────────────────────────────────────────────────────────┤
│  EVENTUAL CONSISTENCY                                           │
│  = If no new writes, all replicas converge eventually           │
│  = DynamoDB default, Cassandra ONE, MongoDB async replica reads │
└──────────────────────────────────────────────────────────────────┘
```

---

## 🔬 Linearizability — Hiểu đúng

**Định nghĩa:** Mỗi operation xuất hiện atomic tại một thời điểm giữa invocation và response. Toàn bộ hệ thống hành xử như một single node.

```
Linearizability Test:

Timeline:
Client A: ─── write(x=1) ────────────────────────
Client B: ─────────────── read(x) ───────────────

Nếu write(x=1) hoàn thành TRƯỚC khi read(x) bắt đầu:
→ read(x) PHẢI return 1
→ Nếu return 0: NOT linearizable!

Client A: ─── write(x=1) ───────────────────────────
Client B: ──────────────────── read(x) ─────────────
              (write completes)   (read starts after)

Must return 1. Non-negotiable.
```

### Linearizability Test - Concurrent operations

```
Client A: ─── write(x=1) ──────
Client B: ─── write(x=2) ──────   (concurrent with A)
Client C: ───────────────── read(x) ───

Linearizable results: read returns 1 OR 2 (either write happened first)
NOT linearizable: read returns 0 (old value, neither write took effect)
```

**Systems that guarantee linearizability:**
- Single-node database (within transaction)
- etcd, ZooKeeper (for their own operations)
- Raft leader reads (not follower reads!)
- PostgreSQL SELECT for a single row (READ COMMITTED+)

---

## 📊 Serializability vs Linearizability

Đây là 2 concepts thường bị nhầm lẫn:

```
SERIALIZABILITY (transactions, multiple objects):
→ Concurrent transactions appear to execute serially
→ Serial order doesn't have to match real time
→ SQL databases: SERIALIZABLE isolation level
→ About: WHAT can be seen, not WHEN

LINEARIZABILITY (single operations, real-time):
→ Operations appear atomic, in real-time order
→ About: WHEN operations take effect
→ Distributed systems: Raft, ZooKeeper

STRICT SERIALIZABILITY = SERIALIZABLE + LINEARIZABLE
→ Gold standard: Spanner, CockroachDB
→ Most expensive in terms of latency
```

```sql
-- PostgreSQL: SERIALIZABLE isolation
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT balance FROM accounts WHERE id = 1;
-- Transaction sees snapshot from transaction start
-- Another transaction commits writes after my snapshot
-- I do NOT see those writes (repeatable read)
-- At commit: check for conflicts → serialization failure if conflict
COMMIT;
```

---

## 🌊 Causal Consistency — Practical Middle Ground

```
Causal consistency guarantees:
1. If A → B (A causally precedes B): everyone sees A before B
2. Concurrent events (A ∥ C): may be seen in different orders by different nodes

Example:

Alice posts: "Hello!"          (event A)
Bob replies: "Hi Alice!"       (event B, caused by A)

Causal consistency guarantees:
→ Everyone who sees B must have seen A first
→ B cannot appear before A to any node

Without causal consistency:
→ Carol sees Bob's reply before Alice's post → confused!

Without causality (eventual consistency only):
Carol's feed: "Hi Alice!" ← makes no sense without seeing Alice's post
```

**Practical implementation:**
```
MongoDB Causal Sessions (4.0+):
- Client sends operationTime + clusterTime with each read
- Server promises: reply will be from state ≥ operationTime
- Causal chain: write → read after write guaranteed to see write

Cassandra Lightweight Transactions (LWT):
- IF NOT EXISTS / IF condition
- Uses Paxos for conditional writes
- Single-key linearizability, not full table
```

---

## 📈 Eventual Consistency — Đúng bản chất

**Định nghĩa chính xác (Werner Vogels, Amazon CTO):**
"If no new updates are made to a given data item, eventually all accesses to that item will return the last updated value."

**Không có nghĩa là:** data sẽ sai mãi mãi
**Có nghĩa là:** trong thời gian replication lag, readers MAY see stale data

```
Write:  Node A gets write (x=100) at T=0
Replication: Async to Node B and C

T=0ms:   A: x=100   B: x=50   C: x=50  (stale!)
T=50ms:  A: x=100   B: x=100  C: x=50  (B caught up)
T=100ms: A: x=100   B: x=100  C: x=100 (all converged)

During T=0 to T=100ms: reads from B or C may return stale x=50
After T=100ms: all return x=100 (converged)
```

### Eventual Consistency Flavors

```
STRONG EVENTUAL CONSISTENCY (SEC):
→ Nodes that receive same set of updates have same state
→ CRDTs (Conflict-free Replicated Data Types)
→ No coordination needed!

CRDT Examples:
- G-Counter: grow-only counter (each node has own slot, sum = total)
- LWW-Register: Last-Writer-Wins register (uses timestamp)
- OR-Set: Observed-Remove Set (add/remove with unique tags)

USE CASE: Shopping cart, collaborative text editing, distributed counters
```

---

## 🗄️ Database Consistency Placement

```
                STRONG ◄─────────────────► WEAK
                                                
PostgreSQL      ████████████░░░░░░░░░░░░░░░░
(SERIALIZABLE)  Strong within single node

PostgreSQL      ████████░░░░░░░░░░░░░░░░░░░░
Streaming       Strong on primary, eventual on replica
Replication

MySQL           ███████░░░░░░░░░░░░░░░░░░░░░
Group Replication (with sync replication)

MongoDB         ██████░░░░░░░░░░░░░░░░░░░░░░
(writeConcern=  Strong with majority write + linearizable read
majority + 
linearizable)

MongoDB         ████░░░░░░░░░░░░░░░░░░░░░░░░
(default)       Read-your-writes within session

CockroachDB     █████████████░░░░░░░░░░░░░░░
                Serializable globally (distributed)

Cassandra       ██░░░░░░░░░░░░░░░░░░░░░░░░░░
(ONE)           Very weak (fastest)

Cassandra       ██████░░░░░░░░░░░░░░░░░░░░░░
(QUORUM)        Tunable strong consistency

DynamoDB        ████░░░░░░░░░░░░░░░░░░░░░░░░
(default)       Eventual (fast)

DynamoDB        ████████░░░░░░░░░░░░░░░░░░░░
(strong read)   Linearizable reads (2x cost)
```

---

## 💡 Tips & Tricks

> **Tip 1 — PostgreSQL replica reads**
> ```sql
> -- Replica reads = eventual consistency!
> -- Read from replica: may see stale data by replication_lag seconds
> SELECT * FROM orders WHERE id = 123;
> -- On replica: could return old data if master committed recently
>
> -- Fix: always read from master for critical paths
> -- Or: use synchronous_commit = on + synchronous_standby_names
> -- But: sync replication adds write latency
> ```

> **Tip 2 — Cassandra QUORUM formula**
> ```
> QUORUM = ⌊Replication Factor/2⌋ + 1
> RF=3: QUORUM = 2
> If write QUORUM + read QUORUM > RF → strong consistency
> 2 + 2 = 4 > 3 → QUORUM + QUORUM = strong
> But: 1(ONE) + 1(ONE) = 2 ≤ 3 → not strong, eventual!
> ```

> **Tip 3 — Stale reads are OK for many use cases**
> ```
> - Product catalog: 1s stale? Users won't notice
> - Session data: need fresh (read-your-writes minimum)
> - Account balance: need strong (linearizable)
> - Analytics dashboards: 1min stale? Often acceptable
>
> Design principle: choose consistency per use case, not globally
> ```

> **Tip 4 — Jepsen Tests**
> Jepsen (aphyr) tests databases for consistency violations:
> - Runs concurrent clients, injects network partitions
> - Verifies histories against consistency model
> - Famous: exposed bugs in Cassandra, MongoDB, Redis, etcd
> - Always check if your DB has a Jepsen report!

---

## 🔬 Case Studies

### Case Study 1: Amazon Shopping Cart — CRDT
```
Problem: Shopping cart must always be available (AP in CAP)
User adds item in region A, reads in region B (replication lag):
→ Eventual consistency acceptable (not financial transaction)

Solution: CRDT-based cart
- Each add = grow-only (G-Set element)
- Deletes tracked separately
- Merge = union of all adds - confirmed deletes
- No conflicts possible
- "Items may appear duplicated briefly" — acceptable UX

vs Banking:
- Balance transfer must be ACID
- CP in CAP → write to leader, wait for replication
```

### Case Study 2: Google Photos — Eventual Consistency
```
You upload a photo:
→ Immediately visible to you (read-your-writes)
→ Shared album: friend may see 2s delay (eventual)
→ Face detection processing: minutes later (eventual)

3 different consistency requirements for same system:
1. Your own uploads: read-your-writes (session consistency)
2. Shared with others: eventual (seconds)
3. Metadata/analysis: eventual (minutes)
```

### Case Study 3: PDMS Banking Context
```
PDMS xử lý hồ sơ tín dụng — consistency requirements:

Document status update (APPROVED/REJECTED):
→ STRONG CONSISTENCY required
→ Cannot show different status to different services
→ Use: single PostgreSQL master, no replica reads for critical path

Document search/listing:
→ EVENTUAL CONSISTENCY acceptable
→ Read from replica, 100-500ms lag OK
→ Use: read replica + cache

Audit log (immutable):
→ EVENTUAL CONSISTENCY fine
→ Write to Kafka, consume async into audit DB
→ Display: "May take a few seconds to appear"

Rule: Strong consistency = cost (latency, availability)
      Use it only where business requires it
```

---

## 📝 Key Takeaways

1. **Consistency là spectrum**, không phải binary
2. **Linearizability** = strongest, real-time, single-object ordering
3. **Serializability** = transaction-level, không cần real-time order
4. **Strict Serializability** = both → Spanner/CockroachDB gold standard
5. **Causal Consistency** = practical middle ground, MongoDB causal sessions
6. **Eventual Consistency** = highest availability, lowest latency, convergence guaranteed
7. **CRDT** = eventual consistency without conflicts (shopping carts, counters)
8. **Database replicas = eventual consistency** — đừng quên khi đọc từ replica!
9. **Cassandra QUORUM = strong consistency** nếu W+R > RF
10. **Jepsen** là tool kiểm tra thực tế — check report trước khi chọn DB

---

## 🔗 Liên kết

- [[consensus-raft-paxos]] — Raft cung cấp linearizability cho etcd
- [[distributed-clocks-ordering]] — Ordering cần thiết cho linearizability
- [[cap-pacelc-deep-dive]] — CAP trade-offs
- [[Microservices-Patterns/01-Data-Consistency]] — Practical consistency patterns
- [[Database-Patterns/00-Hub-Database-Persistence]] — Database consistency in practice
- [[MOC-Distributed-Systems]] — Distributed systems overview
