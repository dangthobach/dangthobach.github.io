# JDBC vs R2DBC vs Virtual Threads — Bức Tranh Thực Tế 2025/2026

> **Câu hỏi cốt lõi:** R2DBC non-blocking có thực sự là xu hướng tất yếu, hay Virtual Threads (Project Loom) đã thay đổi cuộc chơi?
> **Verdict ngắn:** Phức tạp hơn marketing rất nhiều. Đọc hết để hiểu *khi nào* chọn cái nào.

---

## 🧠 Hiểu Đúng Vấn Đề Trước — 2 Loại "Waiting" Khác Nhau

Đây là điểm **hầu hết blog về R2DBC giải thích sai hoặc bỏ qua**. Cần phân biệt hai loại chờ đợi hoàn toàn khác bản chất:

### Loại 1: I/O Blocking Wait — R2DBC giải quyết cái này

```
JDBC Thread Model (platform thread):

Thread A: ──[gửi SQL qua TCP]──────────[đợi network + DB xử lý]──────────[nhận result]──►
           ← đây là blocking I/O →     ↑ OS thread bị GIỮ CHẾT ở đây
                                         không làm được gì khác
                                         không serve request khác
                                         chỉ ngồi chờ bytes về qua socket
```

```
R2DBC Event Loop Model:

Event Loop: ──[gửi SQL]──[đăng ký callback]──[xử lý request khác]──[xử lý request khác]──►
                          └── khi bytes về: callback được invoke, tiếp tục xử lý result
```

### Loại 2: Transaction State Wait — KHÔNG AI giải quyết được

```
Một transaction, dù JDBC hay R2DBC, đều phải:

BEGIN
  ├── query 1 (chờ DB)
  ├── business logic (tính toán)
  ├── query 2 (chờ DB)
  ├── query 3 (chờ DB)
  └── COMMIT / ROLLBACK

Transaction PHẢI giữ state (locks, visibility) từ BEGIN đến COMMIT.
Đây là bản chất của ACID — không thể thay đổi.
R2DBC không làm cho transaction nhanh hơn hay "nhẹ" hơn về mặt DB locks.
```

**Kết luận quan trọng:** R2DBC giải quyết **thread utilization trên application server**, không giải quyết **transaction overhead trên database**. Đây là hai tầng vấn đề khác nhau hoàn toàn.

---

## 🔧 Cơ Chế Hoạt Động Chi Tiết

### JDBC — Synchronous Blocking

```
Application                    HikariCP Pool              PostgreSQL
    │                              │                           │
    │  getConnection()             │                           │
    ├─────────────────────────────►│                           │
    │  connection (thread pinned)  │                           │
    │◄─────────────────────────────┤                           │
    │                              │                           │
    │  executeQuery("SELECT...")   │                           │
    ├──────────────────────────────┼──────────────────────────►│
    │                              │                           │
    │  [THREAD BLOCKED]            │     [DB processes]        │
    │  [OS thread làm gì?]         │     [disk I/O]            │
    │  [NOTHING — ngủ ở đây]       │     [CPU chạy SQL]        │
    │                              │                           │
    │◄─────────────────────────────┼───────────────────────────┤
    │  ResultSet                   │                           │
    │                              │                           │
    │  connection.close()          │                           │
    ├─────────────────────────────►│  trả connection về pool   │
```

**Memory model của JDBC thread:**

```
Platform Thread stack:
┌─────────────────────────────────────────┐
│  executeQuery() stack frame             │ ←── đang chờ
│  HTTP handler stack frame               │
│  Tomcat worker thread stack frame       │
│  ...                                    │
└─────────────────────────────────────────┘
Size: ~1MB per thread (OS stack)
Trạng thái: BLOCKED — OS thread thực sự bị suspend
OS phải context switch ra ngoài → lãng phí CPU
```

**Thread pool sizing với JDBC:**

```
maxConnections (PostgreSQL) = 100
maxPoolSize (HikariCP)      = 100  ← phải ≤ maxConnections
maxThreads (Tomcat)         = 200  ← phải > poolSize (overhead)

→ Tối đa ~100 requests đồng thời đang chờ DB
→ ~100 OS threads bị block trong khi chờ
→ Mỗi thread ~1MB stack → 100MB RAM chỉ cho threads đang idle chờ DB
```

---

### R2DBC — Non-blocking Reactive

```
Application (WebFlux)          R2DBC Driver (Netty)       PostgreSQL
    │                              │                           │
    │  Flux<Row> = conn            │                           │
    │    .createStatement(sql)     │                           │
    │    .execute()                │                           │
    ├─────────────────────────────►│  ghi bytes vào socket     │
    │                              ├──────────────────────────►│
    │                              │                           │
    │  subscribe(callback)         │  [DB processes]           │
    │  ← thread trả về ngay!       │  [event loop free]        │
    │                              │                           │
    │  [Thread xử lý               │                   bytes   │
    │   request KHÁC]              │◄──────────────────────────┤
    │                              │                           │
    │  callback.onNext(row)        │                           │
    │◄─────────────────────────────┤                           │
    │  [xử lý result]              │                           │
```

**Event Loop model:**

```
Netty Event Loop (số lượng = số CPU cores, thường 8-16):

Core 0 Event Loop:
  ─────[req A: gửi SQL]──[req B: gửi SQL]──[req A: nhận result]──[req C: gửi SQL]──►
                                             ↑ callback được gọi khi socket readable

Không có thread bị block.
N requests đồng thời chạy trên M event loop threads (N >> M).
Memory: event loop threads nhỏ, state request nằm trên heap (không phải stack)
```

**Memory model của R2DBC:**

```
Thay vì stack frame per thread:

Heap:
┌─────────────────────────────────────────────────────┐
│  Subscriber state cho request A: ~200 bytes         │
│  Subscriber state cho request B: ~200 bytes         │
│  Subscriber state cho request C: ~200 bytes         │
│  ... 10,000 concurrent requests: ~2MB               │
└─────────────────────────────────────────────────────┘

vs JDBC:
10,000 threads × 1MB stack = 10GB RAM chỉ cho thread stacks
```

---

### Virtual Threads (Project Loom, Java 21+) — Con Đường Thứ Ba

Đây là **game changer thực sự** mà R2DBC không ngờ tới.

```
Virtual Thread model:

JVM Scheduler
├── Carrier thread (OS thread) #1: CPU core 0
│     ├── Virtual Thread A: đang chạy
│     ├── Virtual Thread B: parked (chờ I/O) → được swap ra heap
│     └── Virtual Thread C: đang chạy (swap vào thay B)
│
├── Carrier thread (OS thread) #2: CPU core 1
│     ├── Virtual Thread D: đang chạy
│     └── Virtual Thread E: parked (chờ I/O)
│
└── Heap: [VT B state] [VT E state] [VT F state] ...
          stack frames của virtual thread parked được serialize vào heap
```

**Điều kỳ diệu:** Khi Virtual Thread gặp blocking I/O (kể cả JDBC):

```
Virtual Thread A gọi jdbcTemplate.query(...)
    │
    ▼
JDBC driver gửi bytes qua TCP socket
    │
    ▼
JVM phát hiện: thread sắp block trên socket read
    │
    ▼
JVM PARK virtual thread A:
  - serialize stack frames của A vào heap (~vài KB)
  - giải phóng carrier thread để chạy virtual thread khác
    │
    ▼
Carrier thread chạy Virtual Thread B, C, D...
    │
    ▼
Khi socket readable (DB trả kết quả):
  JVM UNPARK virtual thread A:
  - deserialize stack frames từ heap
  - schedule A lên carrier thread
  - A tiếp tục từ đúng dòng code đang chờ
```

**Với Java 24 (JEP 491):** Virtual threads có thể unmount ngay cả trong `synchronized` blocks — vấn đề "thread pinning" với JDBC drivers cuối cùng đã được fix ở JVM level.

**Memory của Virtual Threads:**

```
10,000 concurrent requests với Virtual Threads:
  - 8-16 carrier threads (OS): ~16MB stack
  - 10,000 virtual thread stacks trên heap: ~10-50MB
    (stack nhỏ hơn nhiều, chỉ giữ frames đang active)
  
vs JDBC với platform threads:
  - 10,000 OS threads × 1MB = 10GB

vs R2DBC:
  - ~8-16 event loop threads + subscriber state trên heap
  - Comparable memory với virtual threads
  - Nhưng code phức tạp hơn nhiều
```

---

## 📊 So Sánh Trực Tiếp — Thực Tế 2025/2026

| Tiêu chí | JDBC + Platform Threads | R2DBC + WebFlux | JDBC + Virtual Threads |
|----------|------------------------|-----------------|----------------------|
| **Thread model** | 1 OS thread/request | Event loop + callbacks | 1 VT/request, N OS threads |
| **Memory/10K CCU** | ~10GB (threads) | ~50-200MB | ~50-500MB |
| **Code complexity** | Simple ✅ | Rất cao ❌ | Simple ✅ |
| **Debugging** | Stack trace rõ ✅ | Operator chain khó ❌ | Stack trace rõ ✅ |
| **Hibernate/JPA** | Full support ✅ | Không tương thích ❌ | Full support ✅ |
| **Transaction support** | Full ACID ✅ | Có nhưng tricky ⚠️ | Full ACID ✅ |
| **Lazy loading** | ✅ | Không có ORM tương đương ❌ | ✅ (cẩn thận pinning) |
| **Throughput (50K+ CCU)** | Giới hạn bởi threads ❌ | Cao nhất ✅ | Comparable với R2DBC ✅ |
| **Throughput (< 10K CCU)** | Đủ dùng ✅ | Overhead reactive ⚠️ | Tốt nhất ✅ |
| **Ecosystem maturity** | 25+ năm ✅ | ~5 năm, gaps còn nhiều ⚠️ | Java 21+ (2023) ✅ |
| **Learning curve** | Thấp ✅ | Rất cao ❌ | Thấp ✅ |
| **Spring Boot support** | spring.mvc ✅ | spring.webflux (khác stack) ⚠️ | spring.mvc + flag ✅ |

---

## ⚡ R2DBC Thực Sự Nhanh Hơn Không?

Benchmark thực tế cho thấy bức tranh phức tạp hơn marketing:

```
Benchmark thực tế (wrk, PostgreSQL, realistic network):

Low concurrency (< 50 users):
  JDBC + platform threads: ████████████ baseline
  R2DBC + WebFlux:         ████████░░░░ ~20-40% chậm hơn (overhead reactive)
  JDBC + Virtual Threads:  █████████████ tương đương hoặc nhỉnh hơn

High concurrency (1000+ users, query lớn):
  JDBC + platform threads: ████░░░░░░░░ threads cạn kiệt
  R2DBC + WebFlux:         ████████████ scales tốt
  JDBC + Virtual Threads:  ████████████ scales tốt (comparable)

Real-world enterprise (< 500 concurrent, mix queries):
  JDBC + Virtual Threads:  ████████████ winner (simple + fast)
  R2DBC + WebFlux:         ████████░░░░ phức tạp mà không nhiều lợi
  JDBC + platform threads: ████████░░░░ đủ dùng cho 90% trường hợp
```

**Gotcha quan trọng từ TechEmpower Benchmarks:**

```
Single query benchmark rankings (higher = worse):
  spring-webflux-rxjdbc:  rank ~326   ← R2DBC
  spring-webflux-jdbc:    rank ~205   ← JDBC trong WebFlux
  spring-mvc-jdbc:        rank ~150   ← JDBC thuần

R2DBC không tự động nhanh hơn JDBC.
Overhead của reactive programming có cost thực sự.
```

---

## 🤔 Vậy Khi Nào Nên Dùng Cái Gì?

### Decision Tree

```
Bạn đang build gì?
    │
    ├── [Enterprise CRUD, microservices thông thường]
    │       │
    │       ├── Java 21+? → JDBC + Virtual Threads ✅ (recommended 2025+)
    │       └── Java 8-17? → JDBC + Platform Threads (đủ dùng)
    │
    ├── [Streaming, WebSocket, SSE — long-lived connections]
    │       │
    │       └── R2DBC + WebFlux ✅ (đây mới là use case đúng)
    │
    ├── [50,000+ CCU, extreme throughput]
    │       │
    │       ├── Team có reactive expertise? → WebFlux + R2DBC ✅
    │       └── Team ít kinh nghiệm reactive? → Virtual Threads + JDBC ✅
    │
    └── [Banking/Document system như PDMS]
            │
            └── JDBC + Virtual Threads ✅
                Lý do: cần full Hibernate (lazy loading, dirty checking,
                        audit, optimistic lock), transaction phức tạp,
                        R2DBC không có ORM tương đương, team quen JDBC
```

### Use case thực tế để chọn R2DBC

```java
// ✅ R2DBC phù hợp: non-blocking pipeline, không cần full ORM
@GetMapping(value = "/stream/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public Flux<ServerSentEvent<Event>> streamEvents() {
    return r2dbcTemplate
        .select(Event.class)
        .matching(query(where("created_at").greaterThan(Instant.now().minusSeconds(60))))
        .all()
        .map(e -> ServerSentEvent.builder(e).build())
        .delayElements(Duration.ofMillis(100));  // streaming với backpressure
}

// ✅ R2DBC phù hợp: high-fan-out parallel queries không cần transaction
public Mono<DashboardData> getDashboard(Long userId) {
    return Mono.zip(
        r2dbcRepo.countByUserId(userId),
        r2dbcRepo.sumAmountByUserId(userId),
        r2dbcRepo.findRecentByUserId(userId, 10)
    ).map(tuple -> new DashboardData(tuple.getT1(), tuple.getT2(), tuple.getT3()));
}
```

### Use case để chọn Virtual Threads + JDBC

```java
// ✅ Virtual Threads + JDBC: standard CRUD với high concurrency
// application.yml:
spring:
  threads:
    virtual:
      enabled: true  # bật virtual threads cho Tomcat

@Service
public class DocumentService {
    @Transactional  // full ACID, full Hibernate, full lazy loading
    public DocumentDto processDocument(Long docId) {
        Document doc = repo.findByIdWithFiles(docId);  // JOIN FETCH
        doc.getMetadata().forEach(m -> m.validate());  // lazy load trong tx
        doc.setStatus(Status.PROCESSED);
        // auto flush khi tx kết thúc
        return toDto(doc);
    }
    // Virtual thread park khi JDBC chờ DB
    // Carrier thread serve requests khác trong lúc đó
    // Code giống hệt JDBC truyền thống — không cần thay đổi gì!
}
```

---

## 💡 Vì Sao Transaction Vẫn Là Bottleneck Dù Dùng R2DBC

Đây là câu hỏi quan trọng mà bạn đặt ra, và câu trả lời cần rõ ràng:

```
R2DBC Transaction:

┌─ BEGIN ─────────────────────────────────────────────────────────┐
│                                                                  │
│  query 1 → non-blocking send → callback khi result về          │
│  query 2 → non-blocking send → callback khi result về          │
│  query 3 → non-blocking send → callback khi result về          │
│                                                                  │
│  PostgreSQL giữ:                                                 │
│  ├── Row locks cho rows đang update                              │
│  ├── Transaction snapshot (MVCC)                                 │
│  └── WAL buffer chờ flush khi commit                            │
│                                                                  │
└─ COMMIT ────────────────────────────────────────────────────────┘

R2DBC không giúp DB xử lý transaction nhanh hơn.
R2DBC không giảm lock contention.
R2DBC không giảm thời gian commit (WAL flush).
R2DBC không giúp transaction ngắn lại.

R2DBC CHỈ giúp: thread trên application server không bị block
trong lúc chờ mỗi query trả về kết quả.
```

**Analogy:**

```
JDBC: Bồi bàn đứng chờ bếp nấu xong món → không phục vụ bàn khác
R2DBC: Bồi bàn đặt order rồi phục vụ bàn khác, khi có chuông thì quay lại

Nhưng: Bếp vẫn mất cùng một lượng thời gian nấu.
        Kitchen resources (DB) không thay đổi.
        Số lượng món có thể nấu đồng thời không tăng.
```

---

## 🏦 Lời Khuyên Cụ Thể Cho PDMS / Banking System

Với hệ thống như PDMS (tens of millions records, microservices, Spring Boot):

**Không nên chuyển sang R2DBC vì:**

1. **Hibernate là bắt buộc** — dirty checking, lazy loading, @Version optimistic lock, audit fields — R2DBC không có ORM tương đương. Spring Data R2DBC chỉ làm CRUD đơn giản, không có session state.

2. **Transaction phức tạp** — banking cần full ACID với nhiều query trong một transaction. R2DBC transaction reactive khó debug và error-prone hơn.

3. **Không có lazy loading** — R2DBC không có proxy mechanism, không có Persistence Context. Mọi relationship phải load explicit — đây là regression lớn so với JPA.

4. **ROI thấp** — PDMS không phải WebSocket/SSE/streaming service. Throughput hiện tại với JDBC + connection pool thường là đủ.

**Nên làm thay vào đó:**

```yaml
# Spring Boot 3.2+ — bật Virtual Threads
spring:
  threads:
    virtual:
      enabled: true

# Giữ HikariCP pool size hợp lý
# Rule of thumb: maxPoolSize = maxDBConnections / numAppInstances
# VD: PostgreSQL 200 connections, 4 instances → maxPoolSize = 50
spring:
  datasource:
    hikari:
      maximum-pool-size: 50      # KHÔNG để mặc định 10 hoặc set quá cao
      minimum-idle: 10
      connection-timeout: 3000
      idle-timeout: 600000
```

Chỉ xem xét R2DBC nếu có service cụ thể cần:
- Server-Sent Events cho real-time notification
- WebSocket long-lived connections
- Streaming large dataset ra client không qua buffer

---

## 🗓️ Timeline Xu Hướng Thực Tế

```
2018-2020: R2DBC ra đời → hứa hẹn thay thế JDBC
2021-2022: Adoption chậm — ecosystem thiếu, ORM gap quá lớn
2023:      Java 21 release → Virtual Threads stable (JEP 444)
2024:      Production adoption virtual threads tăng mạnh
           Nhiều team từ WebFlux migrate về MVC + virtual threads
2025:      Java 24 (JEP 491) → fix thread pinning trong synchronized
           Virtual threads + JDBC trở thành recommended path
           Production reports: 35% code reduction khi migrate từ WebFlux
2026:      Consensus rõ ràng hơn:
           ├── Virtual Threads + JDBC: default choice cho enterprise
           ├── R2DBC: vẫn relevant cho streaming/WebSocket use case
           └── R2DBC làm "JDBC replacement": KHÔNG còn được advocate
```

---

## 📋 Tóm Tắt Quyết Định

| Bạn cần... | Chọn |
|-----------|------|
| CRUD API thông thường, Java 21+ | JDBC + Virtual Threads |
| CRUD API thông thường, Java < 21 | JDBC + Platform Threads |
| Streaming / SSE / WebSocket | R2DBC + WebFlux |
| Full ORM (lazy loading, dirty check, audit) | JDBC (bất kỳ thread model nào) |
| Extreme throughput (>50K CCU) không cần ORM | R2DBC + WebFlux hoặc Vert.x |
| Banking / Document Management (như PDMS) | JDBC + Virtual Threads (Java 21+) |
| Migrate từ WebFlux sang đơn giản hơn | Virtual Threads + JDBC |

> **Bottom line:** R2DBC không phải xu hướng tất yếu năm 2026. Virtual Threads đã làm cho JDBC+blocking code scale tốt mà không cần đánh đổi sự đơn giản của code. R2DBC vẫn có chỗ đứng, nhưng là niche use case (streaming, WebSocket) chứ không phải replacement cho JDBC.

---

## 🔗 Liên Quan

- [[Hibernate-Performance-Deep-Dive]] — ORM internals, dirty checking, Persistence Context
- [[Cross-Service-Join-AuthZ-Fine-Grained-Filter]] — microservices query patterns
- [[Kafka-Configuration-Deep-Dive]] — async messaging nếu cần decouple

---

*Tags: #jdbc #r2dbc #virtual-threads #project-loom #webflux #spring-boot #concurrency #performance #2025 #2026*
