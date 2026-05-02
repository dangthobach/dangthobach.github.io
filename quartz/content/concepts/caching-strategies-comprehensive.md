---
tags: [concepts, caching, redis, caffeine, performance, distributed, evergreen]
created: 2026-05-02
difficulty: intermediate
estimated-read: 25 min
links: [consistency-models-spectrum, clean-architecture-hexagonal]
---

# ⚡ Caching Strategies — Toàn cảnh từ L1 đến Distributed Cache

> **Mục tiêu:** Biết đúng cache strategy cho từng use case — không phải "thêm cache vào là nhanh hơn", mà là biết loại cache nào, ở đâu, TTL bao lâu, và xử lý invalidation thế nào.

---

## 🎯 Tại sao caching phức tạp?

```
"Cache invalidation is one of the two hard problems in Computer Science."
— Phil Karlton

Các vấn đề thực tế:
1. Stale data: cache shows old value, user sees inconsistency
2. Cache stampede: cache expires → 10,000 requests hit DB simultaneously
3. Cache poisoning: wrong data cached → persists until TTL
4. Memory pressure: too much cache → GC pressure, OOM
5. Cold start: cache empty → first batch of requests → DB overload
```

---

## 🗺️ Cache Taxonomy

```
┌─────────────────────────────────────────────────────────────────┐
│                      CACHE LAYERS                               │
├─────────────────────────────────────────────────────────────────┤
│  L1 — CPU Cache (hardware)                                      │
│       Size: KB  | Speed: ns  | Managed: CPU automatically       │
├─────────────────────────────────────────────────────────────────┤
│  L2 — In-process Cache (JVM Heap / Rust HashMap)                │
│       Size: MB  | Speed: µs  | Libraries: Caffeine, Guava       │
│       Scope: single JVM instance                                │
├─────────────────────────────────────────────────────────────────┤
│  L3 — Distributed Cache (Remote)                                │
│       Size: GB  | Speed: ms  | Libraries: Redis, Memcached      │
│       Scope: all service instances share                        │
├─────────────────────────────────────────────────────────────────┤
│  L4 — CDN / Edge Cache                                          │
│       Size: TB  | Speed: ms  | Providers: CloudFront, Cloudflare│
│       Scope: global, nearest PoP                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📘 Cache-Aside (Lazy Loading) — Most Common

```
Read flow:
┌─────────┐   1. Read(key)   ┌────────┐
│ Client  │ ─────────────── ► │ Cache  │
│         │ ◄── Cache Miss ── │        │
│         │                   └────────┘
│         │   2. Query DB     ┌────────┐
│         │ ──────────────── ► │   DB   │
│         │ ◄─── Data ──────── │        │
│         │                   └────────┘
│         │   3. Write to Cache
│         │ ──────────────── ► Cache
└─────────┘

Write flow:
Client ──► DB (write) ──► Client invalidates/updates cache (optional)
```

```java
// Spring Boot: Cache-Aside with Caffeine + Redis
@Service
public class DocumentService {

    private final LoadingCache<Long, Document> localCache = Caffeine.newBuilder()
        .maximumSize(1_000)
        .expireAfterWrite(Duration.ofMinutes(5))
        .build(id -> loadFromRedisOrDb(id));

    public Document getDocument(Long id) {
        return localCache.get(id);  // auto loads if miss
    }

    private Document loadFromRedisOrDb(Long id) {
        // Try Redis first
        String cached = redisTemplate.opsForValue().get("doc:" + id);
        if (cached != null) return deserialize(cached);

        // Fallback to DB
        Document doc = documentRepository.findById(id).orElseThrow();

        // Store in Redis for other instances
        redisTemplate.opsForValue().set(
            "doc:" + id,
            serialize(doc),
            Duration.ofMinutes(30)
        );
        return doc;
    }

    @CacheEvict(cacheNames = "documents", key = "#id")
    public void invalidateDocument(Long id) {
        redisTemplate.delete("doc:" + id);
    }
}
```

**When to use:**
- ✅ Read-heavy workloads
- ✅ Tolerate slightly stale data
- ❌ Write-heavy (cache often invalid)

---

## 📗 Read-Through — Cache manages DB reads

```
Client ──► Cache ──► (on miss) DB ──► Cache stores ──► Client
                                  ↑
                            Cache handles the DB read
                            (not the application)
```

```java
// Spring @Cacheable = Read-Through pattern
@Cacheable(cacheNames = "documents", key = "#id",
           unless = "#result == null")
public Document getDocument(Long id) {
    return documentRepository.findById(id).orElse(null);
}
// First call: miss → loads from DB → stores in cache
// Subsequent calls: hit → return cached value
```

**Difference from Cache-Aside:** Application doesn't know if data came from cache or DB.

---

## 📙 Write-Through — Write to cache AND DB simultaneously

```
Client ──► Cache (write) ──► DB (write synchronously)
              └──────────────────────────────────────►
              Both updated before returning to client
```

```java
@CachePut(cacheNames = "documents", key = "#document.id")
@Transactional
public Document updateDocument(Document document) {
    Document saved = documentRepository.save(document);
    // @CachePut: ALWAYS updates cache with return value
    return saved;
}
```

**When to use:**
- ✅ Strong consistency between cache and DB
- ✅ Write frequency matches read frequency
- ❌ High write volume (cache update adds latency to writes)

---

## 📕 Write-Behind (Write-Back) — Async DB write

```
Client ──► Cache (write immediately) ──► Client returns fast!
              │
              │ (async, batched)
              └──► DB (write later)

Risk: Cache failure before DB write = DATA LOSS
```

```java
// Caffeine Write-Behind example
LoadingCache<Long, Document> cache = Caffeine.newBuilder()
    .writer(new CacheWriter<Long, Document>() {
        @Override
        public void write(Long key, Document value) {
            // Called on every cache write
            asyncWriteQueue.offer(value); // async DB write
        }
        @Override
        public void delete(Long key, Document value, RemovalCause cause) {
            asyncDeleteQueue.offer(key);
        }
    })
    .build(id -> documentRepository.findById(id).orElseThrow());
```

**When to use:**
- ✅ Very high write throughput (user activity logging)
- ✅ Writes can be batched (time-series data)
- ❌ Financial data (risk of data loss)

---

## 📔 Refresh-Ahead — Pre-fetch before expiry

```
TTL = 30 min
At 25 min (83% TTL elapsed): proactively refresh in background
At 30 min: new value already in cache (no miss for user)
```

```java
// Caffeine: refreshAfterWrite
LoadingCache<Long, Document> cache = Caffeine.newBuilder()
    .expireAfterWrite(Duration.ofMinutes(30))
    .refreshAfterWrite(Duration.ofMinutes(25))  // refresh before expiry
    .build(id -> documentRepository.findById(id).orElseThrow());
// Users always get fast response
// Background refresh handles the DB call
```

**When to use:**
- ✅ Hot data that must always be fast (config, user preferences)
- ❌ Low-cardinality access (wastes refresh on rarely-accessed keys)

---

## 💥 Cache Stampede — Và cách giải quyết

```
Problem:
Cache TTL expires at T=0:
→ 10,000 requests arrive simultaneously
→ ALL miss cache
→ ALL hit DB with same query
→ DB gets 10,000 concurrent queries → overload → crash

Timeline:
T=0: cache expires for key "popular_document"
T=0: 10K requests → all miss → all query DB
T=0: DB dies
```

### Solution 1: Mutex / Locking (Cache Lock)

```java
public Document getDocument(Long id) {
    String key = "doc:" + id;
    Document cached = cache.get(key);
    if (cached != null) return cached;

    // Only ONE thread fetches from DB
    String lockKey = "lock:doc:" + id;
    boolean locked = redis.setIfAbsent(lockKey, "1", Duration.ofSeconds(10));
    if (locked) {
        try {
            Document doc = db.findById(id);
            cache.set(key, doc, Duration.ofMinutes(30));
            return doc;
        } finally {
            redis.delete(lockKey);
        }
    } else {
        // Wait and retry (another thread is loading)
        Thread.sleep(100);
        return getDocument(id); // recursive retry
    }
}
```

### Solution 2: Probabilistic Early Expiration

```java
// XFetch algorithm: random early expiration
// Simulate "cache expiry" slightly early with probability
double beta = 1.0;
double delta = computeTime; // time to recompute
double ttl = getRemainingTTL(key);
double random = -beta * Math.log(Math.random());

if (random * delta > ttl) {
    // Probabilistically recompute BEFORE actual expiry
    // Prevents stampede by spreading refresh timing
    refreshCache(key);
}
```

### Solution 3: Background Refresh (Refresh-Ahead)

```java
// Refresh in background, serve stale while refreshing
cache.refreshAfterWrite(Duration.ofMinutes(25)); // before 30 min TTL
// Old value served until new value ready — NO stampede
```

---

## 🏗️ Local + Distributed Cache (Two-Level)

```
┌─────────────────────────────────────────────────────────────┐
│                    Service Instance A                       │
│                                                             │
│   Request ──► Caffeine L1 ──── miss ──► Redis L2           │
│               (in-process)              │    │              │
│               5K entries                │    └── miss ──► DB│
│               5 min TTL                 │                   │
│                                         └── hit (30 min TTL)│
└─────────────────────────────────────────────────────────────┘
                                         ▲
┌─────────────────────────────────────────────────────────────┐
│                    Service Instance B                       │
│                                                             │
│   Request ──► Caffeine L1 ──── miss ──► Redis L2 (shared)  │
└─────────────────────────────────────────────────────────────┘

Benefits: L1 = sub-ms (no network), L2 = shared across instances
Problem: L1 staleness when another instance updates
Fix: Redis Pub/Sub invalidation signal → other instances evict L1
```

```java
// PDMS Caffeine + Redis hybrid (documented in Cross-Service-Join article)
@Component
public class TwoLevelDocumentCache {

    @Autowired private RedisTemplate<String, String> redis;

    private final Cache<Long, Document> localCache = Caffeine.newBuilder()
        .maximumSize(5_000)
        .expireAfterWrite(Duration.ofMinutes(5))
        .build();

    @PostConstruct
    public void subscribeToInvalidations() {
        // When another service instance updates Redis, it publishes invalidation
        redis.getConnectionFactory().getConnection()
            .subscribe((message, pattern) -> {
                Long docId = Long.parseLong(new String(message.getBody()));
                localCache.invalidate(docId);
            }, "cache:invalidate:doc".getBytes());
    }

    public Document get(Long id) {
        return localCache.get(id, k -> fetchFromRedisOrDb(k));
    }

    public void invalidate(Long id) {
        localCache.invalidate(id);
        redis.delete("doc:" + id);
        redis.convertAndSend("cache:invalidate:doc", id.toString()); // notify others
    }
}
```

---

## 🔢 TTL Strategy

```
Rule: TTL = f(data freshness requirement, recomputation cost)

Data type               | Recommended TTL    | Strategy
------------------------|--------------------|-----------
Static config/metadata  | 24h - 7d           | Refresh-ahead
User permissions/roles  | 5-15 min           | Cache-aside + explicit invalidate
Product catalog         | 1h - 24h           | Write-through on update
Session data            | 30 min (sliding)   | Extend on access
Search results          | 5-10 min           | Cache-aside
Financial balances      | No cache OR 1-5s   | Very short TTL
One-time tokens         | Exact expiry       | TTL = token expiry time
```

---

## 💡 Tips & Tricks

> **Tip 1 — Cache Key Namespacing**
> ```
> // Always namespace cache keys to avoid collisions
> "doc:{id}"               → documents
> "user:{id}:permissions"  → user permissions
> "search:{hash(query)}"   → search results
> "branch:{id}:docs"       → documents per branch
>
> // Versioning for schema changes
> "v2:doc:{id}"            → after changing Document schema
> // Old v1 keys expire naturally, no migration needed
> ```

> **Tip 2 — Never cache exceptions**
> ```java
> // ❌ Bad: caches "not found" exception → masks real DB issues
> @Cacheable("documents")
> public Document get(Long id) {
>     return repo.findById(id).orElseThrow(); // exception gets cached!
> }
>
> // ✅ Good: cache null explicitly or use Optional
> @Cacheable(value = "documents", unless = "#result == null")
> public Document get(Long id) {
>     return repo.findById(id).orElse(null);
> }
> ```

> **Tip 3 — Redis memory eviction policies**
> ```
> maxmemory-policy:
>   noeviction      → return error when full (default, BAD for cache)
>   allkeys-lru     → evict least-recently-used (BEST for general cache)
>   volatile-lru    → LRU only on keys WITH TTL
>   allkeys-lfu     → evict least-frequently-used (best for skewed access)
>
> Always set: maxmemory 2gb (or appropriate limit)
> Always set: maxmemory-policy allkeys-lru
> ```

> **Tip 4 — Cache size estimation**
> ```
> entries_in_cache = requests_per_second × avg_ttl_seconds
> memory = entries × avg_object_size_bytes
>
> Example: 1000 req/s, TTL=300s, avg object=2KB
> entries = 1000 × 300 = 300,000
> memory  = 300,000 × 2KB = 600MB
> Redis overhead: ~50 bytes/key + value size
> ```

---

## 🔬 Case Studies

### Case Study 1: Stack Overflow — Cache Architecture
```
Stack Overflow serves 1.5B pages/month with ~9 servers:
L1: Redis (in-datacenter) — primary cache
L2: CDN — for static assets
L3: Browser cache — HTTP cache headers

Key patterns:
- Questions: cache with 60s TTL
- User profiles: cache with 5min TTL, invalidate on update
- Hot questions: permanent cache with manual invalidation
- No cache: reputation score (always fresh)

Result: 99% of SQL queries never hit production DB
```

### Case Study 2: PDMS Document Search
```
Problem: Document search with multi-level filters
(branch, date range, status, customer) — complex SQL, ~200ms

Solution:
1. Cache individual documents: "doc:{id}" — 30min TTL
2. Cache search results: "search:{hash(filters)}" — 5min TTL
3. Invalidate search cache on any document change in that branch:
   "search:branch:123:*" → KEYS pattern delete (careful with large keyspaces!)
   Better: use cache tag "branch:123" → associate with all branch searches

Implementation:
- Spring Cache + Redis
- Cache-aside for individual documents
- Write-through for critical status updates
- Short TTL (5min) for search results (acceptable staleness)
```

### Case Study 3: Banking Balance — NO Cache
```
PDMS liên quan đến account balances → DO NOT CACHE
Reason:
- User makes transfer → balance changes
- Cache shows old balance → user confused or double-spends
- Even 1 second stale = unacceptable for financial data

Solution:
- Always read from DB master (no replica reads)
- Use DB query cache at PostgreSQL level (shared_buffers)
- Optimize query: index on account_id, partial index for active accounts
- No application-level cache

Rule: "If being wrong has financial/legal consequences → no application cache"
```

---

## 📝 Key Takeaways

1. **Cache-Aside** = most common, application controls cache logic
2. **Read-Through** = cache handles DB reads transparently
3. **Write-Through** = consistency: always update cache + DB together
4. **Write-Behind** = performance: async DB write, risk of data loss
5. **Refresh-Ahead** = eliminate cold misses for hot data
6. **Two-Level Cache** = Caffeine (L1, sub-ms) + Redis (L2, shared)
7. **Cache Stampede** = solve with lock, probabilistic expiry, or refresh-ahead
8. **TTL strategy** = balance freshness vs DB load
9. **Never cache financial data** with long TTL
10. **Redis eviction policy** = `allkeys-lru` for general caches

---

## 🔗 Liên kết

- [[consistency-models-spectrum]] — Cache consistency models (eventual vs strong)
- [[Microservices-Patterns/Cross-Service-Join-AuthZ-Fine-Grained-Filter]] — PDMS Caffeine+Redis hybrid pattern
- [[Database-Patterns/Hibernate-Performance-Deep-Dive]] — Hibernate L2 Cache (Ehcache/Redis)
- [[Go-Zero-To-Hero/Bai-20-Redis-Caching]] — Redis patterns in Go
- [[Rust-Zero-To-Hero/Bai-31-Redis-Caching]] — Redis patterns in Rust
