---
tags: [moc, distributed-systems, fundamentals]
---

# 🌐 MOC — Distributed Systems

> **Mục tiêu của MOC này:** Hiểu cơ chế hoạt động của hệ thống phân tán — không phải để thuộc, mà để apply vào architecture decisions hàng ngày (PDMS, VPBank systems).

---

## 📐 Nền tảng lý thuyết

### Định nghĩa & Tư duy
- [[A Crash Course on Distributed Systems|A Crash Course on Distributed Systems]]
  → Communication (TCP/TLS/DNS), Coordination (Raft, vector clocks), Scalability patterns, Resiliency patterns. **Đây là note nền tảng — đọc đầu tiên.**

### CAP / PACELC / ACID / BASE
- [[CAP, PACELC, ACID, BASE - Essential Concepts for an Architect's Toolkit|CAP, PACELC, ACID, BASE]]
  → Bộ tứ khái niệm architect phải thuộc lòng. CAP: chỉ được 2 trong 3. PACELC: mở rộng khi không có partition.
- [[Consistency and Partition Tolerance- Understanding CAP vs PACELC|CAP vs PACELC — So sánh chi tiết]]
  → Tại sao PACELC thực tế hơn CAP. Latency vs Consistency trade-off khi mạng ổn định.
- [[Engineering Trade-offs- Eventual Consistency in Practice|Eventual Consistency in Practice]]
  → Khi nào chấp nhận eventual consistency, khi nào cần strong consistency. Trade-off thực tế.

### Thời gian & Thứ tự sự kiện
- [[Dark Side of Distributed Systems- Latency and Partition Tolerance|Dark Side: Latency and Partition Tolerance]]
  → Network partition là gì, tại sao latency không tránh được, fallacies of distributed computing.
- [[Top Leader Election Algorithms in Distributed Databases|Leader Election Algorithms]]
  → Raft, Paxos, Bully algorithm. Khi nào dùng cái nào. ZooKeeper vs etcd.

---

## 📡 Data Replication

- [[Data Replication- A Key Component for Building Large-Scale Distributed Systems|Data Replication — Key Component]]
  → Single-leader, Multi-leader, Leaderless. Sync vs Async replication. Conflict resolution.
- [[A Guide to Database Replication- Key Concepts and Strategies|Database Replication Guide]]
  → PostgreSQL replication slots, logical vs physical replication. Replication lag measurement.
- [[How to Choose a Replication Strategy|Choosing Replication Strategy]]
  → Decision tree: RPO/RTO requirements → replication choice. Strong vs eventual.
- [[Consistent Hashing 101- How Modern Systems Handle Growth and Failure|Consistent Hashing 101]]
  → Virtual nodes, ring topology. Tại sao consistent hashing quan trọng khi add/remove nodes. DynamoDB, Cassandra dùng cách này.

---

## 🏗️ Microservices & Service Communication

- [[Monolith vs Microservices vs Modular Monoliths- What's the Right Choice|Monolith vs Microservices vs Modular Monolith]]
  → Framework ra quyết định khi nào migrate. Modular monolith như bước trung gian. PDMS context: hiện đang ở đâu?
- [[A Crash Course on Microservices Design Patterns|Microservices Design Patterns]]
  → Database per service, Saga, CQRS, API Gateway, Sidecar, Strangler Fig. Pattern catalog đầy đủ.
- [[A Crash Course on Microservice Communication Patterns|Microservice Communication Patterns]]
  → Sync (REST, gRPC) vs Async (Kafka, RabbitMQ). Request-reply vs Event-driven. Trade-off.
- [[Data Sharing Between Microservices|Data Sharing Between Microservices]]
  → Anti-patterns: shared DB, direct DB access. Patterns: API composition, event sourcing, CQRS read model.
- [[Synchronous vs Asynchronous Communication- When to Use What|Sync vs Async — When to Use What]]
  → Decision framework. Latency budget, consistency requirements, failure modes của từng cách.
- [[Mastering Data Consistency Across Microservices|Data Consistency Across Microservices]]
  → 2PC vs Saga vs Outbox. Idempotency keys. Compensating transactions.
- [[Cross-Service-Join-AuthZ-Fine-Grained-Filter|Cross-Service Join — AuthZ & Fine-Grained Filter at Scale]]
  → 5 pattern khi AuthZ tables cần filter data ở nhiều services: **CDC Replication** (Debezium), **Permission Token**, **Local Cache+Kafka**, **Batch API**, **Shared Read Replica**. Decision framework + PDMS hybrid approach cho 10M+ records.

---

## 📨 Messaging & Event-Driven

- [[Messaging Patterns Explained- Pub-Sub, Queues, and Event Streams|Messaging Patterns: Pub-Sub, Queues, Event Streams]]
  → Point-to-point vs Pub-Sub vs Log (Kafka). At-least-once vs exactly-once delivery. Consumer groups.
- [[Event-Driven Architectural Patterns|Event-Driven Architectural Patterns]]
  → Event notification vs Event-carried state transfer vs Event sourcing. Choreography vs Orchestration.
- [[Understanding Message Queues|Understanding Message Queues]]
  → Queue depth, backpressure, DLQ (Dead Letter Queue). RabbitMQ vs Kafka trade-off.
- [[Apache arvo, Protobuf|Apache Avro, Protobuf]]
  → Schema evolution, backward/forward compatibility. Tại sao Avro với Kafka, Protobuf với gRPC.
- [[The Saga Pattern|The Saga Pattern]]
  → Choreography-based vs Orchestration-based Saga. Compensating transactions. PDMS use case: credit migration workflow.

---

## 🔄 CQRS & Event Sourcing

- [[A Pattern Every Modern Developer Should Know- CQRS|CQRS — Must-know Pattern]]
  → Command side (write) vs Query side (read). Eventual consistency giữa hai sides. Khi nào CQRS over-engineering.
- [[Mastering Idempotency- Building Reliable APIs|Mastering Idempotency]]
  → Idempotency keys, conditional updates. Retry-safe APIs. Kafka consumer idempotency.

---

## 🛡️ Resiliency

- [[Top Strategies to Improve Reliability in Distributed Systems|Top Strategies for Reliability]]
  → Redundancy, circuit breaker, bulkhead, timeout, retry with backoff, health checks. Priority order.
- [[Embracing Chaos to Improve System Resilience- Chaos Engineering|Chaos Engineering]]
  → Chaos Monkey, Gremlin. Failure injection. Game days. Netflix's approach. Khi nào áp dụng.

---

## 🔗 Liên kết trong vault

- [[MOC-Java]] — Spring Circuit Breaker, Resilience4J implementation
- [[MOC-Database]] — Replication, sharding tại tầng DB
- [[MOC-System-Design]] — Scalability patterns tổng quan
- [[MOC-PDMS]] — Applied context: PDMS inter-service challenges
- [[MOC-Concurrency]] — Concurrency trong distributed context
