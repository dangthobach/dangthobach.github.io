# Database Persistence in Java — Bức Tranh Tổng Quan

> **Mục tiêu:** Trả lời câu hỏi "Dùng cái gì?" trước khi đi vào từng thứ. Mỗi implementation có một chỗ đứng — không có cái nào "tốt nhất" vô điều kiện.

---

## 🗺️ Toàn Cảnh Ecosystem

```
                    Java Database Persistence
                              │
              ┌───────────────┼───────────────┐
              │               │               │
         BLOCKING          REACTIVE      HYBRID / MỚI
         (JDBC-based)    (Non-blocking)  (Virtual Threads)
              │               │               │
    ┌─────────┴──────┐  ┌─────┴──────┐  ┌────┴─────────────┐
    │                │  │            │  │                   │
  Plain           ORM  R2DBC     Hibernate   JDBC +          
  JDBC          (JPA/  Drivers   Reactive    Virtual         
    │          Hibernate)  │     (Vert.x)   Threads         
    │              │       │        │           │            
  Spring        Spring  Spring   Quarkus    Spring Boot      
  JDBC           Data   Data     Panache    3.2+ (MVC)       
  Template        JPA   R2DBC    Reactive                    
                  │                                          
              Hibernate                                      
              ORM Core                                       
```

---

## 📦 Các Implementation Chính — Một Dòng Mỗi Cái

| Implementation | Blocking? | ORM? | Best For |
|---------------|-----------|------|----------|
| **Plain JDBC** | ✅ Blocking | ❌ | Full SQL control, stored proc, batch ETL |
| **Spring JdbcTemplate** | ✅ Blocking | ❌ | JDBC nhưng bỏ boilerplate |
| **Spring Data JDBC** | ✅ Blocking | Partial (DDD aggregate) | Simple mapping, không cần lazy load |
| **Hibernate ORM + JPA** | ✅ Blocking | ✅ Full | Enterprise CRUD, phức tạp, cần full ORM |
| **Spring Data JPA** | ✅ Blocking | ✅ Full | Hibernate + repository abstraction |
| **jOOQ** | ✅ Blocking | ❌ (type-safe SQL) | Complex query, type safety, DB-first |
| **R2DBC Drivers** | ❌ Non-blocking | ❌ | Low-level reactive DB access |
| **Spring Data R2DBC** | ❌ Non-blocking | Partial | Reactive CRUD, không có lazy load |
| **Hibernate Reactive** | ❌ Non-blocking | ✅ Full | Full ORM + reactive (dùng Vert.x) |
| **Vert.x SQL Client** | ❌ Non-blocking | ❌ | Reactive low-level, high perf |
| **JDBC + Virtual Threads** | ✅ Blocking code | ✅ Full | **Recommended 2025+** — simplicity + scale |

---

## 🧭 Decision Map — Chọn Theo Nhu Cầu

```
Bạn cần gì?
    │
    ├─► Lazy loading / Dirty checking / Full ORM?
    │       │
    │       ├─ YES → Hibernate ORM (JPA)
    │       │           ├─ Java 21+?   → + Virtual Threads (recommended)
    │       │           └─ Reactive?   → Hibernate Reactive (Vert.x)
    │       │
    │       └─ NO → tiếp tục
    │
    ├─► Cần kiểm soát SQL tuyệt đối / Complex query / DB-first?
    │       └─ YES → jOOQ hoặc Spring Data JDBC
    │
    ├─► Reactive pipeline / Streaming / WebSocket / SSE?
    │       └─ YES → Spring Data R2DBC hoặc Vert.x SQL Client
    │
    ├─► Simple CRUD + DDD aggregate pattern?
    │       └─ YES → Spring Data JDBC
    │
    └─► Standard enterprise microservice (2025+)?
            └─ Spring Data JPA + Hibernate + Virtual Threads ✅
```

---

## 🔗 Articles Trong Series Này

### Blocking Stack (JDBC-based)

- [[Hibernate-Performance-Deep-Dive]] — **START HERE nếu dùng Spring Boot + JPA**
  - Persistence Context, Dirty Checking, Snapshot
  - L1/L2 Cache, Query Cache
  - N+1, Batch Insert, Projection
  - Exception phổ biến và cách xử lý

- [[JDBC-vs-R2DBC-vs-VirtualThreads]] — So sánh 3 concurrency model
  - Cơ chế blocking vs non-blocking vs virtual threads
  - Memory model của từng approach
  - Benchmark thực tế 2025/2026
  - Decision framework

### Reactive Stack

- [[Hibernate-Reactive-Deep-Dive]] — Hibernate ORM + Vert.x (Full ORM, non-blocking)
  - Tại sao Hibernate chọn Vert.x thay vì R2DBC
  - Mutiny API (Uni/Multi)
  - Session management trong reactive context
  - Quarkus Panache integration

- [[Spring-Data-R2DBC-Deep-Dive]] — Spring Data R2DBC (Không có ORM)
  - R2DBC vs Hibernate Reactive — chọn cái nào?
  - DatabaseClient vs R2dbcEntityTemplate vs Repository
  - Transaction reactive
  - Những gì R2DBC KHÔNG có (và tại sao)
  - Khi nào đây là lựa chọn đúng

---

## ⚡ TL;DR — Năm 2025/2026 Nên Dùng Gì?

```
Đại đa số Spring Boot enterprise services (banking, document, CRUD):
→ Spring Data JPA + Hibernate + Virtual Threads
  (spring.threads.virtual.enabled=true, Java 21+)
  Lý do: full ORM, đơn giản, scale tốt, không migration cost

Streaming / SSE / WebSocket service:
→ Spring Data R2DBC + WebFlux
  Lý do: non-blocking pipeline, backpressure native

Cần reactive NHƯNG vẫn muốn full ORM (lazy load, dirty check):
→ Hibernate Reactive trên Quarkus
  Lý do: duy nhất stack có cả hai

Legacy service cần throughput cao, không muốn rewrite:
→ Bật Virtual Threads (1 dòng config)
  Lý do: zero code change, throughput tăng đáng kể
```

---

*Tags: #database #jdbc #jpa #hibernate #r2dbc #virtual-threads #spring-boot #index*
