# 11 — Consistency: PostgreSQL + Redis Song Hành

> **Audience:** Senior engineers xây dựng caching layer và gặp vấn đề cache inconsistency.  
> **Scope:** Các pattern đảm bảo consistency khi dùng PostgreSQL + Redis, trade-offs cụ thể.  
> **Liên kết:** [[01-ACID-Internals]] | [[03-Concurrency-Patterns]] | [[00-PostgreSQL-Hub]]

---

## 📋 Mục lục

1. [Vấn đề cốt lõi — Tại sao consistency khó](#1-vấn-đề-cốt-lõi)
2. [Cache-Aside (Lazy Loading) — Pattern phổ biến nhất](#2-cache-aside)
3. [Write-Through — Ghi đồng thời](#3-write-through)
4. [Write-Behind (Write-Back) — Async writes](#4-write-behind)
5. [Cache Invalidation Strategies](#5-cache-invalidation)
6. [CDC-based Cache Invalidation — The robust way](#6-cdc-based-invalidation)
7. [Distributed Lock — Ngăn thundering herd](#7-distributed-lock--thundering-herd)
8. [Pattern Selection Guide](#8-pattern-selection-guide)
9. [PDMS Implementation Blueprint](#9-pdms-implementation-blueprint)

---

## 1. Vấn đề cốt lõi

```
┌──────────────────────────────────────────────────────────────────────┐
│              The Dual-Write Problem                                   │
│                                                                      │
│  Bạn muốn:                                                           │
│  1. Ghi vào PostgreSQL (source of truth)                             │
│  2. Ghi vào Redis (fast cache)                                       │
│                                                                      │
│  Scenario A: Write PG first, then Redis                              │
│  ┌─────┐   Write OK   ┌────┐              ┌───────┐                 │
│  │ App │─────────────►│ PG │   CRASH!     │ Redis │ ← STALE!        │
│  └─────┘              └────┘   ↑          └───────┘                 │
│                        success  didn't reach Redis                   │
│                                                                      │
│  Scenario B: Write Redis first, then PG                              │
│  ┌─────┐   Write OK   ┌───────┐   CRASH!   ┌────┐                  │
│  │ App │─────────────►│ Redis │   ↑         │ PG │ ← MISSING!       │
│  └─────┘              └───────┘  didn't     └────┘                  │
│                                  reach PG                            │
│                                                                      │
│  → Không có distributed transaction giữa PG và Redis                 │
│  → Consistency requires careful pattern selection                    │
│  → Chấp nhận trade-off: consistency vs performance vs complexity     │
└──────────────────────────────────────────────────────────────────────┘
```

### CAP Theorem implication

```
PostgreSQL: CP (Consistency + Partition tolerance)
Redis:      AP (Availability + Partition tolerance) trong cluster mode
            CP trong single node

PG + Redis combined system:
  → Chỉ có EVENTUAL CONSISTENCY (không phải strong consistency)
  → Có window của inconsistency (milliseconds đến seconds)
  → Thiết kế phải accept điều này
```

---

## 2. Cache-Aside (Lazy Loading)

Pattern phổ biến nhất, đơn giản nhất.

### Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Cache-Aside Read Flow                              │
│                                                                      │
│  App                  Redis              PostgreSQL                  │
│   │                     │                    │                       │
│   │  GET doc:123        │                    │                       │
│   │────────────────────►│                    │                       │
│   │                     │                    │                       │
│   │    CACHE MISS       │                    │                       │
│   │◄────────────────────│                    │                       │
│   │                     │                    │                       │
│   │  SELECT * FROM docs WHERE id=123          │                       │
│   │────────────────────────────────────────► │                       │
│   │                     │                    │                       │
│   │◄─── row data ───────────────────────────│                       │
│   │                     │                    │                       │
│   │  SET doc:123 <data> EX 300              │                       │
│   │────────────────────►│                    │                       │
│   │                     │                    │                       │
│   │  return data        │                    │                       │
│                                                                      │
│  Next request:                                                       │
│   │  GET doc:123 → CACHE HIT → return immediately                    │
└──────────────────────────────────────────────────────────────────────┘

Write flow (invalidation):
  App writes to PostgreSQL → DELETE key from Redis
  Next read: cache miss → fetch fresh from PG → repopulate cache
```

### Implementation

```java
@Service
public class DocumentService {
    private static final String CACHE_KEY = "doc:";
    private static final Duration TTL = Duration.ofMinutes(5);

    public DocumentDTO getDocument(Long id) {
        String key = CACHE_KEY + id;

        // 1. Try cache first
        String cached = redisTemplate.opsForValue().get(key);
        if (cached != null) {
            return objectMapper.readValue(cached, DocumentDTO.class);
        }

        // 2. Cache miss → fetch from DB
        Document doc = documentRepository.findById(id)
            .orElseThrow(() -> new NotFoundException(id));
        DocumentDTO dto = mapper.toDTO(doc);

        // 3. Populate cache
        redisTemplate.opsForValue().set(key,
            objectMapper.writeValueAsString(dto),
            TTL);

        return dto;
    }

    @Transactional
    public DocumentDTO updateDocument(Long id, UpdateRequest req) {
        // 1. Update PostgreSQL (source of truth)
        Document doc = documentRepository.findById(id)
            .orElseThrow(() -> new NotFoundException(id));
        doc.setStatus(req.getStatus());
        documentRepository.save(doc);

        // 2. Invalidate cache (NOT update — invalidate is safer!)
        redisTemplate.delete(CACHE_KEY + id);
        // → Next read will fetch fresh data from PG

        return mapper.toDTO(doc);
    }
}
```

### Giải thích tại sao INVALIDATE thay vì UPDATE

```
Khi update: "write to DB, then write to Redis"
─────────────────────────────────────────────
Thread A: update doc → write PG → write Redis(v2)
Thread B: update doc → write PG → write Redis(v3)

Nếu Thread B write PG sau A, nhưng Redis sau A lại:
  PG: version v3 (B's update)
  Redis: version v2 (A's update) ← STALE!

Khi invalidate: "write to DB, then delete from Redis"
─────────────────────────────────────────────────────
Thread A: update doc → write PG → DELETE Redis
Thread B: update doc → write PG → DELETE Redis
Next read: cache miss → fetch from PG → fresh data
→ No stale writes, always fetch fresh
```

### Trade-offs

```
Pros:
✓ Simple to implement
✓ Resilient: if Redis down, falls back to PG
✓ Cache only what's needed (lazy)
✓ No stale write problem (invalidation)

Cons:
✗ Cache miss penalty on first access (cold start)
✗ "Cache stampede" khi nhiều requests hit cùng lúc (xem phần 7)
✗ Inconsistency window: between DB write and cache invalidation
```

---

## 3. Write-Through

Cache luôn được update đồng bộ với database write.

```
┌──────────────────────────────────────────────────────────────────────┐
│                   Write-Through Flow                                  │
│                                                                      │
│  App              Redis              PostgreSQL                      │
│   │                 │                    │                           │
│   │  Write request  │                    │                           │
│   │                 │                    │                           │
│   │  1. SET doc:123 <new_data> EX 300    │                           │
│   │────────────────►│                    │                           │
│   │    OK           │                    │                           │
│   │                 │                    │                           │
│   │  2. UPDATE docs SET ... WHERE id=123 │                           │
│   │────────────────────────────────────►│                           │
│   │    OK           │                    │                           │
│   │                 │                    │                           │
│   │  return success │                    │                           │
└──────────────────────────────────────────────────────────────────────┘
```

### Vấn đề với Write-Through

```
Problem 1: PG write fails after Redis write
  → Redis has new data, PG has old data
  → Must rollback Redis write (another write operation, can also fail!)

Problem 2: Redis write fails
  → Don't proceed to PG write?
  → Service degraded just because cache is down?

Problem 3: Race condition (same as before)
  → Two concurrent writes → Redis and PG can have different orders

Best practice: Nếu dùng Write-Through, Redis write AFTER PG transaction commits
  → Nếu Redis fails → OK, cache sẽ stale nhưng PG là truth
  → Next read: cache miss hoặc stale → refresh
```

---

## 4. Write-Behind (Write-Back)

Ghi vào Redis trước, async flush sang PostgreSQL — ngược lại hoàn toàn.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Write-Behind Flow                                  │
│                                                                      │
│  App → Redis (immediately) → return success to client                │
│                                                                      │
│  Background worker (async):                                          │
│  Redis dirty queue → batch write → PostgreSQL                        │
│                                                                      │
│  Pros:                                                               │
│  ✓ Extremely low write latency (Redis only)                          │
│  ✓ Batch writes to PG (efficient)                                    │
│                                                                      │
│  Cons:                                                               │
│  ✗ DATA LOSS RISK: If Redis crashes before flush → data lost!        │
│  ✗ Complex async worker with retry logic                             │
│  ✗ Cannot use for financial transactions                             │
│                                                                      │
│  Use case:                                                           │
│  ✓ View counts, like counts, analytics (loss acceptable)             │
│  ✗ Financial transactions, document status (NEVER!)                  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 5. Cache Invalidation Strategies

### Strategy 1: TTL-based (Simplest)

```java
// Set TTL khi cache, let it expire
redisTemplate.opsForValue().set(key, data, Duration.ofMinutes(5));

// Pros: Simple, no invalidation logic needed
// Cons: Stale window up to TTL duration

// Chọn TTL dựa theo:
// - Frequency of updates
// - Tolerance for stale data
// Banking: 30-60 seconds (low tolerance)
// User profile: 5-10 minutes (medium tolerance)
// Reference data (branches, categories): 1-24 hours
```

### Strategy 2: Event-driven invalidation

```java
// Sau mỗi write, publish event để invalidate
@Service
public class DocumentEventPublisher {
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onDocumentUpdated(DocumentUpdatedEvent event) {
        // Chỉ chạy SAU KHI transaction commit thành công
        redisTemplate.delete("doc:" + event.getDocumentId());

        // Invalidate related caches
        redisTemplate.delete("branch:docs:" + event.getBranchId());
        redisTemplate.delete("pending:count:" + event.getBranchId());
    }
}
```

```
Tại sao dùng @TransactionalEventListener thay vì gọi trực tiếp?
  → Nếu transaction rollback → event KHÔNG được publish
  → Cache không bị invalidate cho data chưa commit
  → Tránh: cache miss → fetch stale (rolled-back) data từ PG
```

### Strategy 3: Versioned cache keys

```java
// Thay vì invalidate, thay đổi key khi data thay đổi
// Version stored trong DB

// Read:
String cacheKey = "doc:" + id + ":v" + doc.getVersion();
String cached = redis.get(cacheKey);

// Write:
doc.setVersion(doc.getVersion() + 1);  // tăng version
documentRepo.save(doc);
// Old key tự expire theo TTL, new key populated on next read

// Pros: No race condition giữa delete và populate
// Cons: Old versions linger until TTL → memory waste
//       Cần fetch version từ DB trước khi biết cache key
```

---

## 6. CDC-based Cache Invalidation — The Robust Way

Pattern mạnh nhất: dùng Debezium để watch PostgreSQL WAL → trigger cache invalidation.

```
┌──────────────────────────────────────────────────────────────────────┐
│              CDC-based Cache Invalidation Architecture                │
│                                                                      │
│  Application                                                         │
│       │                                                              │
│       ▼ write                                                        │
│  PostgreSQL ──── WAL ────► Debezium ────► Kafka ────► Cache Worker  │
│  (source of truth)         (CDC)          (events)       │           │
│                                                          │           │
│                                                    DELETE from Redis │
│                                                                      │
│  Advantages:                                                         │
│  ✓ Guaranteed: mọi write đến PG đều trigger invalidation            │
│  ✓ Decoupled: application không cần gọi Redis explicitly             │
│  ✓ Handles bulk updates, stored procedures, direct DB writes         │
│  ✓ Works for all writers (multiple services, migration scripts)      │
│                                                                      │
│  Timeline:                                                           │
│  PG commit → WAL → Debezium → Kafka → Worker → Redis delete         │
│  Latency: ~50-200ms typical (acceptable for most use cases)         │
└──────────────────────────────────────────────────────────────────────┘
```

```java
// Kafka consumer xử lý CDC events để invalidate cache
@KafkaListener(topics = "pdms.public.documents")
public void handleDocumentChange(DebeziumEvent event) {
    String operation = event.getOperation();  // c=create, u=update, d=delete
    Long docId = event.getAfter().getId();    // null cho delete
    if (docId == null) docId = event.getBefore().getId();

    // Invalidate caches
    redisTemplate.delete("doc:" + docId);

    // Invalidate collection caches if status changed
    if ("u".equals(operation)) {
        String oldStatus = event.getBefore().getStatus();
        String newStatus = event.getAfter().getStatus();
        if (!oldStatus.equals(newStatus)) {
            String branchId = event.getAfter().getBranchId();
            redisTemplate.delete("branch:docs:pending:" + branchId);
        }
    }
}
```

---

## 7. Distributed Lock — Thundering Herd

**Cache stampede / Thundering herd:** Khi cache key expire, hàng trăm requests cùng lúc hit DB.

```
┌──────────────────────────────────────────────────────────────────────┐
│              Cache Stampede Problem                                   │
│                                                                      │
│  T=0: Cache miss for "branch:HN01:stats"                             │
│  T=0: 500 concurrent requests all see cache miss                     │
│  T=0: All 500 requests hit PostgreSQL simultaneously!                │
│  T=1: 500 DB queries running → DB overwhelmed → slow → timeout      │
│                                                                      │
│              Solution: Probabilistic Early Expiry                    │
│                                                                      │
│  // Refresh cache slightly before it expires, only by one thread    │
│  remaining_ttl = redis.ttl(key);                                     │
│  if (remaining_ttl < THRESHOLD && shouldRefresh(remaining_ttl)):     │
│      // One thread refreshes, others use slightly stale data         │
└──────────────────────────────────────────────────────────────────────┘
```

### Mutex/Lock pattern

```java
@Service
public class CacheService {
    private static final String LOCK_PREFIX = "lock:";
    private static final Duration LOCK_TTL = Duration.ofSeconds(10);

    public String getWithLock(String cacheKey, Supplier<String> dbFetcher) {
        // 1. Try cache
        String cached = redis.get(cacheKey);
        if (cached != null) return cached;

        // 2. Cache miss — try acquire lock
        String lockKey = LOCK_PREFIX + cacheKey;
        Boolean locked = redis.opsForValue().setIfAbsent(lockKey, "1", LOCK_TTL);

        if (Boolean.TRUE.equals(locked)) {
            try {
                // 3. Lock acquired — fetch from DB
                String data = dbFetcher.get();
                redis.opsForValue().set(cacheKey, data, Duration.ofMinutes(5));
                return data;
            } finally {
                redis.delete(lockKey);
            }
        } else {
            // 4. Another thread is fetching — wait and retry
            // (Simple approach: sleep + retry)
            int retries = 0;
            while (retries < 10) {
                Thread.sleep(50);
                cached = redis.get(cacheKey);
                if (cached != null) return cached;
                retries++;
            }
            // Fallback: fetch from DB without cache (better than timeout)
            return dbFetcher.get();
        }
    }
}
```

### Probabilistic early expiry

```java
// Refresh cache before it expires to prevent stampede
// PER (Probabilistic Early Recomputation):

public String getWithEarlyExpiry(String key, Supplier<String> fetcher, Duration ttl) {
    ValueWithExpiry<String> cached = getWithTTL(key);
    if (cached == null) {
        // Cache miss — populate
        String data = fetcher.get();
        setWithTTL(key, data, ttl);
        return data;
    }

    // Check if should refresh early (XFetch algorithm)
    double beta = 1.0;  // tuning parameter
    double delta = measureFetchTime();  // estimated DB fetch time in ms
    double remaining = cached.getRemainingTTLMs();
    double noise = -beta * delta * Math.log(Math.random());

    if (remaining - noise <= 0) {
        // Probabilistically refresh early (only ~1/concurrency threads will do this)
        String fresh = fetcher.get();
        setWithTTL(key, fresh, ttl);
        return fresh;
    }

    return cached.getValue();
}
```

---

## 8. Pattern Selection Guide

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Pattern Selection Matrix                           │
│                                                                      │
│  Tiêu chí                    │ Cache-Aside │ Write-Through │ CDC    │
│  ────────────────────────────┼─────────────┼───────────────┼────── │
│  Implementation complexity   │ Low         │ Medium        │ High   │
│  Consistency guarantee       │ Eventual    │ Near-real-time│ ~200ms │
│  Write performance           │ Fast        │ 2x writes     │ Fast   │
│  Cache always populated      │ No (lazy)   │ Yes           │ No     │
│  Works with direct DB writes │ No ✗        │ No ✗          │ Yes ✓  │
│  Cache down impact           │ Fallback PG │ Write fails   │ OK     │
│                                                                      │
│  Khi nào dùng gì:                                                    │
│                                                                      │
│  Cache-Aside:                                                        │
│    → Hầu hết use cases, starting point                               │
│    → Read-heavy workload                                             │
│    → Chấp nhận cold start penalty                                    │
│    → Simple services với một writer                                  │
│                                                                      │
│  Write-Through:                                                      │
│    → Low read latency requirement                                    │
│    → Cache always warm needed                                        │
│    → Single application writer                                       │
│                                                                      │
│  CDC-based:                                                          │
│    → Multiple services write to same DB                              │
│    → Direct DB writes (migration, admin)                             │
│    → Need guaranteed invalidation                                    │
│    → Complex cache invalidation logic (many keys per entity)         │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 9. PDMS Implementation Blueprint

```java
// Application.properties
spring.cache.type=redis
spring.data.redis.host=redis.pdms.internal
spring.data.redis.port=6379
spring.data.redis.timeout=500ms  // fail fast if Redis down

// Cache Configuration
@Configuration
@EnableCaching
public class CacheConfig {
    @Bean
    public RedisCacheConfiguration documentCacheConfig() {
        return RedisCacheConfiguration.defaultCacheConfig()
            .entryTtl(Duration.ofMinutes(5))
            .serializeValuesWith(
                RedisSerializationContext.SerializationPair
                    .fromSerializer(new GenericJackson2JsonRedisSerializer()));
    }
}

// Service layer
@Service
public class DocumentService {

    // 1. Document detail — Cache-Aside với TTL 5 phút
    @Cacheable(value = "documents", key = "#id",
               unless = "#result == null")
    public DocumentDTO getDocument(Long id) {
        return documentRepository.findById(id)
            .map(mapper::toDTO)
            .orElse(null);
    }

    // 2. Invalidate sau update
    @CacheEvict(value = "documents", key = "#id")
    @Transactional
    public DocumentDTO updateDocument(Long id, UpdateRequest req) {
        Document doc = documentRepository.findById(id)
            .orElseThrow();
        // ... update logic
        return mapper.toDTO(documentRepository.save(doc));
        // @CacheEvict runs AFTER method (default)
        // @TransactionalEventListener ensures only on commit success
    }

    // 3. Branch stats — TTL ngắn hơn (1 phút) vì thay đổi thường xuyên
    @Cacheable(value = "branch-stats", key = "#branchId")
    public BranchStatsDTO getBranchStats(String branchId) {
        return statisticsRepository.getByBranch(branchId);
    }

    // 4. Reference data — TTL dài (1 giờ) vì thay đổi ít
    @Cacheable(value = "branch-config", key = "#branchId")
    public BranchConfigDTO getBranchConfig(String branchId) {
        return branchRepository.findById(branchId)
            .map(mapper::toConfigDTO)
            .orElseThrow();
    }
}
```

```
Cache Key Convention (PDMS):
  doc:{id}                    → Document detail
  branch:stats:{branchId}     → Branch statistics
  branch:config:{branchId}    → Branch configuration
  pending:count:{branchId}    → Pending document count
  user:docs:{userId}:page:{p} → User's document list (page p)

TTL Strategy:
  Document detail:    5 phút (có thể thay đổi bởi workflow)
  Branch stats:       1 phút (aggregate, changes frequently)
  Branch config:      1 giờ (reference data, rare changes)
  Pending count:      30 giây (critical for UX, must be fresh-ish)
  Search results:     1 phút (frequent queries, acceptable stale)
```

---

## Related Notes

- [[01-ACID-Internals]] — PostgreSQL transaction semantics
- [[03-Concurrency-Patterns]] — Concurrent access patterns
- [[Microservices-Patterns/Debezium-CDC-Deep-Dive]] — CDC cho cache invalidation
- [[Microservices-Patterns/Cross-Service-Join-AuthZ-Fine-Grained-Filter]] — CDC + Caffeine cache pattern

---

*Tags: #postgresql #redis #caching #consistency #patterns*  
*Created: 2026-05-06 | Difficulty: ⭐⭐⭐*
