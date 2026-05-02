---
tags: [concepts, distributed-systems, consensus, raft, paxos, evergreen]
created: 2026-05-02
difficulty: advanced
estimated-read: 25 min
links: [distributed-clocks-ordering, consistency-models-spectrum, cap-pacelc-deep-dive]
---

# 🗳️ Consensus — Raft & Paxos: Tại sao Distributed Agreement là vấn đề khó

> **Mục tiêu:** Hiểu tại sao etcd/ZooKeeper/Kafka ISR hoạt động được và tại sao "distributed transaction" lại phức tạp đến vậy.

---

## 🎯 Vấn đề cần giải quyết

**Consensus Problem:** Làm thế nào để N nodes trong mạng lưới không tin cậy **đồng ý** trên một giá trị duy nhất, ngay cả khi một số nodes fail?

```
Tình huống thực tế:
- 3 database replicas — đâu là "source of truth"?
- Leader Kafka broker crash — ai thay thế?
- Distributed config (etcd) — tất cả apps phải thấy giống nhau
- Distributed lock — chỉ 1 node được giữ lock

Nếu không có consensus → split brain:
Node A: "Tôi là leader!"
Node B: "Không, tôi là leader!"
→ 2 nodes đồng thời write → data corruption
```

---

## ☠️ FLP Impossibility — Giới hạn lý thuyết

**Fisher-Lynch-Paterson (1985):** Trong một hệ thống **async** với **ít nhất 1 faulty node**, không thể đảm bảo **safety + liveness + termination** đồng thời.

```
Safety:    Tất cả nodes phải agree on same value
Liveness:  Thuật toán phải terminate (không block mãi)
Fault-tol: Chịu được ít nhất 1 node fail

→ Không thể có cả 3 trong async network!
```

**Cách thực tế giải quyết:** Trade off một chút liveness (timeout-based) để đổi lấy safety + fault tolerance. Đây là nền tảng thiết kế của Raft.

---

## 📜 Paxos — Thuật toán gốc (Lamport, 1989)

### Các vai (Roles)
```
Proposer  — đề xuất giá trị
Acceptor  — vote để chấp nhận giá trị
Learner   — học kết quả cuối cùng
(Một node có thể đóng nhiều vai)
```

### Phase 1: Prepare

```
Proposer                    Acceptors (A1, A2, A3)
   │                              │
   │──── Prepare(n=5) ───────────►│
   │                              │  A1, A2, A3 check:
   │                              │  n > highest_n_seen?
   │◄─── Promise(n=5, ∅) ─────────│  Yes → Promise to not accept
   │     (no previous value)      │       any proposal < n=5
   │
   │  (receives majority: A1+A2 = quorum)
```

### Phase 2: Accept

```
Proposer                    Acceptors
   │                              │
   │──── Accept(n=5, v="X") ─────►│
   │                              │  A1, A2, A3 check:
   │                              │  n >= promised_n? → Accept
   │◄─── Accepted(n=5, v="X") ────│
   │
   │  (majority accepted → value "X" is chosen!)
```

**Vấn đề Paxos:** Dueling proposers (livelock), single-value only (Multi-Paxos phức tạp hơn), khó implement đúng.

---

## 🚀 Raft — Understandable Consensus (Ongaro, 2013)

Raft được thiết kế để **dễ hiểu hơn Paxos** mà vẫn đảm bảo safety.

### 3 vai trong Raft

```
                    ┌────────────────────────────────────┐
                    │            FOLLOWER                │
                    │  - Nhận heartbeat từ Leader        │
                    │  - Redirect client reads/writes    │
                    │    về Leader                       │
                    └────────────┬───────────────────────┘
                                 │ timeout (no heartbeat)
                                 ▼
                    ┌────────────────────────────────────┐
                    │           CANDIDATE                │
                    │  - Starts election                 │
                    │  - Votes for itself                │
                    │  - Requests votes from peers       │
                    └────────────┬───────────────────────┘
                                 │ receives majority votes
                                 ▼
                    ┌────────────────────────────────────┐
                    │             LEADER                 │
                    │  - Accepts client writes           │
                    │  - Sends heartbeats (AppendEntries)│
                    │  - Replicates log to followers     │
                    └────────────────────────────────────┘
```

### Raft Log Replication

```
Client → Leader
         │
         ▼
Leader Log:
Term: [1][1][1][2][2][2][2][3]
Idx:  [1][2][3][4][5][6][7][8]
Val:  [x=1][y=2][x=3][z=1]...
         │
         │──── AppendEntries RPC ────►  Follower 1 Log:
         │                             [1][1][1][2][2][2][2]...
         │──── AppendEntries RPC ────►  Follower 2 Log:
         │                             [1][1][1][2][2][2][2]...
         │
         ▼ (majority acknowledged = committed)
         Apply to State Machine
         │
         ▼
Client Response: "OK"
```

### Leader Election

```
Initial state: 3 followers, election timeout random (150-300ms)

t=0ms:   [F1: 180ms] [F2: 250ms] [F3: 300ms]
t=180ms: F1 timeout → becomes Candidate, term=2
         F1 sends RequestVote to F2, F3

         F2 receives: "vote for me, term=2"
         F2 check: term 2 > my term 1? Yes
                   F1's log up-to-date? Yes
         F2 grants vote

         F1 gets majority (self + F2) → becomes Leader term=2
         F3 receives heartbeat → updates term → remains Follower
```

**Safety guarantee:** Chỉ 1 leader tại mỗi term. Một node chỉ vote cho 1 candidate mỗi term.

### Split Vote (no majority)

```
5 nodes, 3 candidates simultaneously:
- C1 gets vote từ F1 → 2 votes (cần 3)
- C2 gets vote từ F2 → 2 votes (cần 3)
- C3 → 1 vote (itself)
→ Không ai win → timeout → new election với higher term
→ Random timeout → eventually 1 wins
```

---

## 🔧 Raft trong thực tế

### etcd (Kubernetes' brain)
```
etcd cluster: 3 hoặc 5 nodes (odd number)
Quorum = ⌊N/2⌋ + 1
- 3 nodes: tolerate 1 failure (quorum = 2)
- 5 nodes: tolerate 2 failures (quorum = 3)

Kubernetes stores ALL state in etcd:
- Pod specs, Service configs, ConfigMaps, Secrets
- etcd leader handles all writes (linearizable)
- Followers can serve reads (configurable)
```

### ZooKeeper (Kafka's old coordinator)
```
ZooKeeper uses ZAB (ZooKeeper Atomic Broadcast) — similar to Raft
Used for: Kafka broker metadata (Kafka < 2.8)

Kafka 2.8+ KRaft mode:
→ Built-in Raft in Kafka, no ZooKeeper dependency
→ __cluster_metadata topic stores Raft log
→ Controller broker = Raft leader
```

### Kafka ISR — Raft-inspired

```
ISR (In-Sync Replicas) — không phải Raft thuần nhưng concepts tương tự:

Partition: topic-0
Leader:    Broker 1 (writes here first)
ISR:       [Broker 1, Broker 2, Broker 3]

Write flow:
Client ──► Leader (Broker 1) ──► Broker 2 (replicate)
                              ──► Broker 3 (replicate)

acks=all: Leader waits for ALL ISR to acknowledge
acks=1:   Leader only (risk: data loss if leader crashes before replication)

ISR shrinks when follower lags > replica.lag.time.max.ms (10s default)
→ If ISR = [Broker 1] only: still accepts writes but no fault tolerance
```

---

## 🧮 Quorum Math

```
N = total nodes
f = tolerated failures
Quorum W (write) + Quorum R (read) > N  (for strong consistency)

Common configurations:
┌────────────────────────────────────────────────────────┐
│  N=3, W=2, R=2: tolerate 1 failure, strong consistency │
│  N=5, W=3, R=3: tolerate 2 failures                   │
│  N=5, W=3, R=1: fast reads, strong writes              │
│  N=3, W=1, R=1: fastest, but no consistency guarantee  │
└────────────────────────────────────────────────────────┘

Why odd numbers?
- 4 nodes: tolerate 1 failure (need 3/4) — same as 3 nodes!
- 4 nodes partition 2+2: can't form quorum on either side
- 5 nodes partition 3+2: 3-side can form quorum → continues
```

---

## 💡 Tips & Tricks

> **Tip 1 — Election timeout tuning**
> etcd default: `heartbeat-interval=100ms`, `election-timeout=1000ms`
> Quy tắc: `election-timeout = 10× heartbeat-interval`
> Nếu election-timeout quá nhỏ → frequent unnecessary elections
> Nếu quá lớn → slow failover

> **Tip 2 — Linearizability vs Quorum reads**
> etcd mặc định linearizable reads → phải contact leader (slow but correct)
> `etcdctl get --consistency=s` → serializable (may read stale, but faster)

> **Tip 3 — Don't implement consensus yourself**
> Use etcd, ZooKeeper, Consul for distributed coordination.
> Sai lầm phổ biến: "tôi sẽ dùng Redis với SETNX làm distributed lock"
> → Redis Sentinel không đảm bảo consensus → Redlock vẫn có race conditions
> → Dùng etcd lease hoặc ZooKeeper ephemeral nodes thay thế

> **Tip 4 — Raft trong databases**
> CockroachDB: mỗi range (64MB chunk) có Raft group riêng
> TiKV: 3-replica Raft per region
> Ảnh hưởng: write latency = 2 × network RTT minimum (Prepare + Commit)

---

## 🔬 Case Studies

### Case Study 1: etcd Split Brain Prevention
```
Scenario: 3-node etcd cluster, network partition 1+2

╔════════╗      network        ╔════════╗ ╔════════╗
║ etcd-1 ║  ════ partition ══  ║ etcd-2 ║ ║ etcd-3 ║
║(Leader)║                     ║(Follow)║ ║(Follow)║
╚════════╝                     ╚════════╝ ╚════════╝

What happens:
- etcd-1: alone, cannot get quorum (needs 2/3) → stops accepting writes
- etcd-2 + etcd-3: form quorum → elect new leader
- Kubernetes continues working with etcd-2 or etcd-3 as new leader
- etcd-1 reconnects → discovers new term → becomes follower, syncs log

Safety: etcd-1 NEVER accepts writes alone → no split brain!
```

### Case Study 2: Kafka Controller Failover
```
KRaft mode (Kafka 3.x):
- 3 controller nodes run Raft (dedicated or combined with brokers)
- Active Controller = Raft leader

Controller crash:
1. Followers detect missing heartbeat (election timeout: 2s default)
2. Candidate sends RequestVote to peers
3. Majority votes → new Controller elected
4. New Controller reads __cluster_metadata → recovers full state
5. Total failover: ~2-5 seconds

Impact on producers/consumers: brief pause, auto-reconnect
```

### Case Study 3: PDMS Config Distribution
```
PDMS dùng Spring Cloud Config Server:
- Single point of failure nếu không cluster
- Alternative: etcd-backed config
  → 3-node etcd cluster → tolerate 1 failure
  → Raft guarantees: app không bao giờ thấy partial updates
  → Atomicity: key-value write là single Raft log entry

Current PDMS: ConfigMap-based (Kubernetes etcd) → đã có consensus!
```

---

## 📝 Key Takeaways

1. **Consensus = agreement despite failures** — không trivial vì FLP impossibility
2. **Paxos = correct but complex** — Raft là implementation-friendly alternative
3. **Raft = leader election + log replication** — 3 states: Leader, Candidate, Follower
4. **Quorum = ⌊N/2⌋ + 1** — majority needed to commit; odd N preferred
5. **etcd uses Raft** — mọi Kubernetes state được bảo vệ bởi consensus
6. **Kafka KRaft** — eliminating ZooKeeper dependency bằng cách build Raft in
7. **Đừng dùng Redis làm distributed lock** — không đảm bảo consensus

---

## 🔗 Liên kết

- [[distributed-clocks-ordering]] — Ordering events mà không cần consensus
- [[consistency-models-spectrum]] — Linearizability requires consensus
- [[cap-pacelc-deep-dive]] — Consensus nodes là CA trong CAP taxonomy
- [[Microservices-Patterns/Kafka-Partition-and-Offset-Internals]] — Kafka ISR
- [[MOC-Distributed-Systems]] — Distributed systems overview
