# Connection Pooling & PgBouncer — Deep Dive

---
tags: [postgresql, connection-pooling, pgbouncer, performance, spring-boot]
created: 2026-05-02
difficulty: intermediate
estimated-read: 18 min
links: [[postgresql-index-internals]], [[query-planner-optimizer]], [[postgresql-performance-deep-dive]]

---

## 🎯 Learning Objectives

Sau bài này bạn sẽ:
- Hiểu **tại sao** PostgreSQL connections tốn kém
- Phân biệt được HikariCP vs PgBouncer — hai lớp pooling khác nhau
- Config đúng pool size dựa trên công thức khoa học
- Debug connection exhaustion và pool starvation

---

## 🤔 Tại Sao Connection Tốn Kém?

### PostgreSQL connection model

```
┌─────────────────────────────────────────────────────────────┐
│              PostgreSQL Connection = OS Process              │
│                                                             │
│  Client connects                                            │
│       │                                                     │
│       ▼                                                     │
│  Postmaster (listener)                                      │
│       │ fork()                                              │
│       ▼                                                     │
│  Backend Process (per connection)                           │
│  ├── Private memory: ~5-10MB per connection                │
│  ├── Shared buffer access (shm)                            │
│  ├── Lock manager entry                                     │
│  └── WAL sender slot (if replication)                      │
│                                                             │
│  100 connections = 100 OS processes = 500MB-1GB RAM!       │
└─────────────────────────────────────────────────────────────┘
```

**Connection overhead breakdown:**

| Component | Cost |
|-----------|------|
| Process fork | ~1-3ms |
| Memory per connection | ~5-10MB |
| SSL handshake | +5-10ms |
| Authentication | +1-5ms |
| **Total "cold" connection** | **~10-20ms overhead** |

> **Kết luận:** Tạo new connection cho mỗi query là thảm họa. Connection pool tái sử dụng connections → amortize overhead.

---

## 🏗️ Two-Tier Pooling Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                  Connection Pooling Architecture               │
│                                                               │
│  App Instances (10x pods)        PostgreSQL Server            │
│  ┌─────────────────────┐         ┌───────────────────────┐    │
│  │ Pod 1               │         │                       │    │
│  │ ┌─────────────────┐ │         │  max_connections=200  │    │
│  │ │HikariCP Pool    │ │         │  (OS process limit)   │    │
│  │ │ 10 connections  │◄├──┐      │                       │    │
│  │ └─────────────────┘ │  │      │                       │    │
│  └─────────────────────┘  │      │                       │    │
│                            │      │                       │    │
│  ┌─────────────────────┐  │      │                       │    │
│  │ Pod 2               │  │  ┌───┤─────────────────────┐ │    │
│  │ ┌─────────────────┐ │  └─►│   │  PgBouncer          │ │    │
│  │ │HikariCP Pool    │◄├────►│   │  Pool: 50 conns     │◄├──┐ │
│  │ │ 10 connections  │ │    │   │  to PostgreSQL       │ │  │ │
│  │ └─────────────────┘ │    └───┤─────────────────────┘ │  │ │
│  └─────────────────────┘        │                       │  │ │
│                                  └───────────────────────┘  │ │
│  Problem without PgBouncer:                                  │ │
│  10 pods × 10 HikariCP = 100 connections → fine             │ │
│  50 pods × 10 HikariCP = 500 connections → CRASH!           │ │
│                                                               │
│  With PgBouncer: 50 pods × 10 = 500 app-side connections    │
│  But only 50 real PostgreSQL connections!                    │
└───────────────────────────────────────────────────────────────┘
```

---

## ⚙️ HikariCP — Application-Level Pool

### Tại sao HikariCP?

```
Pool benchmarks (connections/sec):
┌──────────────┬─────────────────┐
│ Pool         │ Throughput      │
├──────────────┼─────────────────┤
│ HikariCP     │ 1,000,000 ops/s │ ← Default Spring Boot
│ c3p0         │    50,000 ops/s │
│ DBCP2        │    80,000 ops/s │
│ Tomcat JDBC  │   100,000 ops/s │
└──────────────┴─────────────────┘
```

HikariCP dùng:
- **Lock-free ConcurrentBag** thay vì synchronized queue
- **Connection validation** bằng `isValid()` hoặc `testQuery` (timeout 5s)
- **Keep-alive** query để duy trì idle connections

### Spring Boot Configuration

```yaml
# application.yml
spring:
  datasource:
    url: jdbc:postgresql://pgbouncer:5432/pdms_db
    username: ${DB_USER}
    password: ${DB_PASS}
    hikari:
      # Core settings
      pool-name: PDMS-HikariPool
      maximum-pool-size: 10        # See formula below!
      minimum-idle: 5              # Warm connections always ready
      connection-timeout: 30000    # 30s wait for connection from pool
      idle-timeout: 600000         # 10min: remove idle connection
      max-lifetime: 1800000        # 30min: force connection replacement
      
      # Validation
      connection-test-query: SELECT 1  # For non-JDBC4 drivers
      validation-timeout: 5000         # 5s max for validation
      
      # Performance
      data-source-properties:
        cachePrepStmts: true
        prepStmtCacheSize: 250
        prepStmtCacheSqlLimit: 2048
        useServerPrepStmts: true
```

### Pool Size Formula

```
Optimal pool size = Tn * (Cm - 1) + 1

Where:
  Tn = số threads tối đa có thể query DB đồng thời
  Cm = số queries tối đa mà 1 transaction cần

Ví dụ PDMS:
  - 10 request threads đồng thời query DB
  - Mỗi transaction cần tối đa 2 queries (1 select + 1 update)
  Optimal = 10 * (2-1) + 1 = 11 connections

PostgreSQL formula (Neil Conway):
  connections = (num_cores * 2) + num_effective_spindle_disks
  
  PDMS server: 8 cores, SSD
  connections = (8 * 2) + 1 = 17 ≈ 20 connections
```

> ⚠️ **Sai lầm phổ biến:** "Nhiều connection = nhanh hơn". Sai! Quá nhiều connections gây context switching overhead, lock contention, và memory pressure.

---

## 🔄 PgBouncer — Proxy-Level Pool

### 3 Pooling Modes

```
┌──────────────────────────────────────────────────────────────┐
│                    PgBouncer Pool Modes                       │
│                                                              │
│  1. SESSION Pooling                                          │
│     App connection → PgBouncer assigns PostgreSQL conn       │
│     Connection held for ENTIRE session duration              │
│     Use case: legacy apps that set session variables         │
│     Drawback: 1:1 ratio, no real multiplexing               │
│                                                              │
│  2. TRANSACTION Pooling (recommended!)                       │
│     PostgreSQL conn assigned per TRANSACTION only           │
│     After COMMIT/ROLLBACK → conn returned to pool           │
│     Best multiplexing! Many app conns → few PG conns        │
│     Drawback: cannot use SET session vars, LISTEN/NOTIFY    │
│                                                              │
│  3. STATEMENT Pooling                                        │
│     PostgreSQL conn assigned per STATEMENT                  │
│     Cannot use multi-statement transactions!                 │
│     Very aggressive, rarely used                            │
└──────────────────────────────────────────────────────────────┘
```

### PgBouncer Configuration

```ini
# pgbouncer.ini
[databases]
pdms_db = host=postgres-primary port=5432 dbname=pdms_db

[pgbouncer]
# Network
listen_addr = 0.0.0.0
listen_port = 5432
auth_file = /etc/pgbouncer/userlist.txt
auth_type = scram-sha-256  # PostgreSQL 14+

# Pool settings — TRANSACTION mode for microservices
pool_mode = transaction

# Connection limits
max_client_conn = 1000         # Max clients connecting to PgBouncer
default_pool_size = 50         # PostgreSQL connections per database/user pair
min_pool_size = 10             # Keep minimum connections alive
reserve_pool_size = 5          # Emergency reserve
reserve_pool_timeout = 5       # Seconds before using reserve

# Timeouts
client_idle_timeout = 60       # Close idle client connections
server_idle_timeout = 600      # Close idle server connections
query_timeout = 0              # 0 = disabled (rely on app timeout)
transaction_timeout = 0        # 0 = disabled

# Logging
log_connections = 0            # Don't log every connection (noisy)
log_disconnections = 0
stats_period = 60
```

### Transaction Mode Limitations

```java
// ⚠️ Không dùng được với PgBouncer transaction mode:

// 1. SET session variables
connection.execute("SET application_name = 'PDMS'");  // ❌ Lost after transaction

// 2. Advisory locks
connection.execute("SELECT pg_advisory_lock(1)");  // ❌ Session-scoped, dangerous

// 3. LISTEN/NOTIFY
connection.execute("LISTEN document_events");  // ❌ Session-scoped

// 4. Temporary tables
connection.execute("CREATE TEMP TABLE ...");  // ❌ Session-scoped

// ✅ Workarounds:
// For session vars: set trong BEGIN của transaction
// For advisory locks: pg_advisory_xact_lock() (transaction-scoped version)
// For LISTEN: use direct connection bypassing PgBouncer
```

---

## 📊 Monitoring Pool Health

### HikariCP Metrics (Micrometer)

```java
// application.yml
management:
  metrics:
    enable:
      hikaricp: true

// Prometheus metrics exposed:
// hikaricp_connections_total{pool="PDMS-HikariPool"}
// hikaricp_connections_active{pool="PDMS-HikariPool"}
// hikaricp_connections_idle{pool="PDMS-HikariPool"}
// hikaricp_connections_pending{pool="PDMS-HikariPool"}
// hikaricp_connections_acquire_seconds{...}  ← KEY metric!
```

**Alert rules (Grafana/Prometheus):**

```yaml
# ALERT: Connection pool nearly exhausted
- alert: HikariPoolExhausted
  expr: hikaricp_connections_pending > 5
  for: 1m
  annotations:
    summary: "HikariCP pool has >5 threads waiting for connection"

# ALERT: Slow connection acquisition
- alert: HikariSlowAcquire
  expr: histogram_quantile(0.95, hikaricp_connections_acquire_seconds) > 0.5
  annotations:
    summary: "P95 connection acquisition >500ms"
```

### PgBouncer Monitoring

```bash
# Connect to PgBouncer admin console
psql -h pgbouncer -p 5432 -U pgbouncer pgbouncer

# Pool stats
SHOW POOLS;
# database | user | cl_active | cl_waiting | sv_active | sv_idle | sv_used | maxwait
# pdms_db  | app  | 45        | 3          | 48        | 2       | 0       | 0

# cl_waiting > 0 → clients waiting → pool too small!
# maxwait > 0    → seconds clients waited → bad!

SHOW STATS;
# total_requests, total_query_time, avg_query_time

SHOW CLIENTS;
SHOW SERVERS;
```

---

## 🔥 Connection Exhaustion — Debug & Fix

### Symptoms

```
# Log khi pool exhausted:
HikariPool-1 - Connection is not available, request timed out after 30000ms

# Stack trace:
java.sql.SQLTransientConnectionException: PDMS-HikariPool - Connection is not available
    at com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:213)
```

### Root causes & fixes

```
┌─────────────────────────────────────────────────────────────┐
│           Connection Exhaustion Diagnosis Tree               │
│                                                             │
│  cl_waiting > 0?                                            │
│       │                                                     │
│  YES  ▼                                                     │
│  sv_idle > 0? ──YES──► App pool không trả connection về    │
│       │                (connection leak, long transaction)  │
│       │                Fix: findLeaks(), transaction timeout │
│  NO   ▼                                                     │
│  All sv_active? ──YES──► PostgreSQL overloaded             │
│                           Fix: tăng PgBouncer pool_size    │
│                           hoặc scale read replicas         │
└─────────────────────────────────────────────────────────────┘
```

### Connection Leak Detection

```java
// HikariCP leak detection
spring:
  datasource:
    hikari:
      leak-detection-threshold: 60000  # 60s: warn về connections held >60s

// Log output khi leak detected:
// WARN  com.zaxxer.hikari - Connection leak detection triggered for...
// Stack trace sẽ show code nào đang hold connection
```

### Long Transactions — PDMS context

```java
// ❌ Anti-pattern: HTTP call trong transaction
@Transactional
public DocumentDTO approveDocument(Long id) {
    Document doc = repo.findById(id).orElseThrow();
    
    // HTTP call đến external service — có thể mất 5-10 seconds!
    ExternalValidationResult result = externalService.validate(doc); // ❌
    
    doc.approve(result.getApprover());
    return repo.save(doc);
    // Connection held cho toàn bộ HTTP call duration!
}

// ✅ Pattern đúng: HTTP call ngoài transaction
public DocumentDTO approveDocument(Long id) {
    // HTTP call TRƯỚC transaction
    ExternalValidationResult result = externalService.validate(id);
    
    return approveDocumentInTransaction(id, result);
}

@Transactional
protected DocumentDTO approveDocumentInTransaction(Long id, ExternalValidationResult result) {
    Document doc = repo.findById(id).orElseThrow();
    doc.approve(result.getApprover());
    return repo.save(doc);
    // Connection chỉ held trong ~5ms!
}
```

---

## 🏗️ PDMS Production Setup

```
Architecture:
  10 pods × HikariCP(max=10) → PgBouncer(pool=50) → PostgreSQL(max_connections=100)

Rationale:
  - 10 pods × 10 = 100 HikariCP connections (app side) — adequate queue
  - PgBouncer: 50 real PG connections (transaction mode)
  - 50 connections ÷ 10 pods = 5 concurrent PG queries/pod average
  - Peak: 10 pods × 10 = 100 concurrent → PgBouncer queues excess
  - PostgreSQL max_connections=100 (headroom for admin connections)
  
Scaling:
  - Add pods → PgBouncer absorbs pressure
  - PgBouncer max_client_conn=1000 → up to 100 pods fine
  - Only increase pool_size when sv_active consistently = pool_size
```

---

## 🔑 Key Takeaways

1. **PostgreSQL connection = OS process** = ~5-10MB RAM → pool bắt buộc
2. **Two-tier pooling:** HikariCP (app-level) + PgBouncer (proxy-level)
3. **Pool size formula:** không phải "càng nhiều càng tốt" — quá nhiều gây overhead
4. **PgBouncer transaction mode** là best choice cho microservices — chú ý limitations
5. **Connection leak** thường là nguyên nhân #1 của pool exhaustion
6. **Long transactions** giữ connections lâu → HTTP calls NGOÀI @Transactional
7. Monitor `cl_waiting` và `hikaricp_connections_pending` — alert khi > 0 kéo dài
8. **`leak-detection-threshold`** trong HikariCP — bật trong dev/staging

---

## 🔗 Related Links

- [[postgresql-index-internals]] — Index giúp queries nhanh → giải phóng connection nhanh hơn
- [[query-planner-optimizer]] — Slow query = connection held lâu = pool pressure
- [[postgresql-performance-deep-dive]] — VACUUM, autovacuum, monitoring tổng hợp
- [[opentelemetry-deep-dive]] — Trace connection wait time với OTel
