# Bài 20: Redis Caching & Distributed Locks

> **Mục tiêu:** Implement caching patterns, pub/sub, và distributed locks với go-redis trong Go.

---

## 1. Setup go-redis

```go
// go get github.com/redis/go-redis/v9

import "github.com/redis/go-redis/v9"

func NewRedisClient(cfg RedisConfig) (*redis.Client, error) {
    rdb := redis.NewClient(&redis.Options{
        Addr:         fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
        Password:     cfg.Password,
        DB:           cfg.DB,
        
        // Connection pool
        PoolSize:     10,
        MinIdleConns: 5,
        PoolTimeout:  30 * time.Second,
        
        // Timeouts
        DialTimeout:  5 * time.Second,
        ReadTimeout:  3 * time.Second,
        WriteTimeout: 3 * time.Second,
    })
    
    // Test connection
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    
    if err := rdb.Ping(ctx).Err(); err != nil {
        return nil, fmt.Errorf("redis ping: %w", err)
    }
    
    return rdb, nil
}
```

---

## 2. Cache-Aside Pattern

```
┌──────────────────────────────────────────────────────────────┐
│                  CACHE-ASIDE PATTERN                         │
│                                                              │
│  GET /documents/:id                                          │
│  │                                                           │
│  ├── Check Redis cache                                       │
│  │   ├── HIT  → Return cached value (fast path ~0.1ms)      │
│  │   └── MISS → Continue                                    │
│  │               │                                           │
│  │               ├── Query PostgreSQL (~5-20ms)              │
│  │               ├── Store in Redis with TTL                 │
│  │               └── Return result                           │
│                                                              │
│  Cache Invalidation:                                         │
│  PUT /documents/:id                                          │
│  ├── Update PostgreSQL                                       │
│  └── Delete Redis key → Next GET will re-populate           │
└──────────────────────────────────────────────────────────────┘
```

```go
type DocumentCache struct {
    rdb    *redis.Client
    repo   DocumentRepository
    ttl    time.Duration
}

const docKeyPrefix = "doc:v1:"

func docKey(id string) string {
    return docKeyPrefix + id
}

func (c *DocumentCache) GetDocument(ctx context.Context, id string) (*Document, error) {
    key := docKey(id)
    
    // Try cache first
    data, err := c.rdb.Get(ctx, key).Bytes()
    if err == nil {
        // Cache HIT
        var doc Document
        if err := json.Unmarshal(data, &doc); err == nil {
            return &doc, nil
        }
    }
    
    if !errors.Is(err, redis.Nil) {
        // Redis error (không phải cache miss) — log but continue
        log.Printf("redis get error: %v", err)
    }
    
    // Cache MISS — query database
    doc, err := c.repo.FindByID(ctx, id)
    if err != nil {
        return nil, err
    }
    
    // Populate cache
    data, _ = json.Marshal(doc)
    c.rdb.Set(ctx, key, data, c.ttl) // Fire-and-forget, ignore error
    
    return doc, nil
}

func (c *DocumentCache) InvalidateDocument(ctx context.Context, id string) {
    c.rdb.Del(ctx, docKey(id))
}

// Cache stampede prevention — setnx pattern
func (c *DocumentCache) GetDocumentSafe(ctx context.Context, id string) (*Document, error) {
    key := docKey(id)
    lockKey := "lock:" + key
    
    // Try cache
    if data, err := c.rdb.Get(ctx, key).Bytes(); err == nil {
        var doc Document
        json.Unmarshal(data, &doc)
        return &doc, nil
    }
    
    // Acquire lock — only one goroutine fetches from DB
    locked, err := c.rdb.SetNX(ctx, lockKey, "1", 10*time.Second).Result()
    if err != nil || !locked {
        // Another goroutine is fetching — wait and retry
        time.Sleep(100 * time.Millisecond)
        return c.GetDocumentSafe(ctx, id)
    }
    defer c.rdb.Del(ctx, lockKey)
    
    // Fetch and cache
    doc, err := c.repo.FindByID(ctx, id)
    if err != nil {
        return nil, err
    }
    data, _ := json.Marshal(doc)
    c.rdb.Set(ctx, key, data, c.ttl)
    return doc, nil
}
```

---

## 3. Distributed Lock (Redlock)

```
┌──────────────────────────────────────────────────────────────┐
│              DISTRIBUTED LOCK USE CASE                       │
│                                                              │
│  Problem: 2 PDMS instances muốn cùng generate warehouse code │
│                                                              │
│  Instance A                    Instance B                    │
│  │ acquire lock "wh:code"      │                            │
│  │ ← OK (got lock)             │ acquire lock "wh:code"     │
│  │                             │ ← FAIL (lock held by A)    │
│  │ generate code = "WH-0001"   │ → wait or fail             │
│  │ save to DB                  │                            │
│  │ release lock ──────────────►│ acquire lock               │
│  │                             │ ← OK (got lock)            │
│  │                             │ generate code = "WH-0002"  │
└──────────────────────────────────────────────────────────────┘
```

```go
// go get github.com/bsm/redislock

import "github.com/bsm/redislock"

type DistributedLocker struct {
    locker *redislock.Client
}

func NewDistributedLocker(rdb *redis.Client) *DistributedLocker {
    return &DistributedLocker{locker: redislock.New(rdb)}
}

func (l *DistributedLocker) WithLock(ctx context.Context, key string, ttl time.Duration, fn func() error) error {
    lock, err := l.locker.Obtain(ctx, key, ttl, &redislock.Options{
        RetryStrategy: redislock.LimitRetry(redislock.LinearBackoff(100*time.Millisecond), 5),
    })
    if err != nil {
        if errors.Is(err, redislock.ErrNotObtained) {
            return fmt.Errorf("lock contention on %s: %w", key, err)
        }
        return fmt.Errorf("obtain lock: %w", err)
    }
    defer lock.Release(ctx)
    
    return fn()
}

// Usage — generate warehouse code
func (s *WarehouseService) GenerateCode(ctx context.Context, warehouseID string) (string, error) {
    var code string
    
    err := s.locker.WithLock(ctx, "lock:wh:code:"+warehouseID, 30*time.Second, func() error {
        // Critical section — only one goroutine executes
        next, err := s.repo.IncrementCounter(ctx, warehouseID)
        if err != nil {
            return err
        }
        code = fmt.Sprintf("WH-%05d", next)
        return s.repo.SaveCode(ctx, warehouseID, code)
    })
    
    return code, err
}
```

---

## 4. Pub/Sub

```go
// Publisher
func (p *EventPublisher) PublishDocumentEvent(ctx context.Context, event DocumentEvent) error {
    data, _ := json.Marshal(event)
    return p.rdb.Publish(ctx, "pdms:document:events", data).Err()
}

// Subscriber — real-time notifications
func (s *NotificationService) Subscribe(ctx context.Context) {
    pubsub := s.rdb.Subscribe(ctx, "pdms:document:events")
    defer pubsub.Close()
    
    ch := pubsub.Channel()
    
    for {
        select {
        case msg := <-ch:
            var event DocumentEvent
            if err := json.Unmarshal([]byte(msg.Payload), &event); err != nil {
                continue
            }
            s.processEvent(ctx, event)
            
        case <-ctx.Done():
            return
        }
    }
}
```

---

## 5. Caching Patterns Summary

```
┌──────────────────────────────────────────────────────────────┐
│                  REDIS KEY NAMING CONVENTION                  │
│                                                              │
│  {service}:{entity}:{id}:{version}                          │
│  pdms:doc:abc123:v1           → Document by ID              │
│  pdms:user:usr123:docs:v1     → User's document list        │
│  pdms:search:hash(query):v1   → Search results              │
│                                                              │
│  Lock keys:                                                  │
│  lock:pdms:wh-code:wh001      → Warehouse code lock         │
│  lock:pdms:doc:abc123         → Document mutation lock       │
│                                                              │
│  TTL strategy:                                               │
│  Hot data (user profile)    → 5 minutes                     │
│  Warm data (document)       → 15 minutes                    │
│  Cold data (search results) → 1 minute                      │
│  Session                    → 24 hours                      │
└──────────────────────────────────────────────────────────────┘
```

---

## 6. Tips & Tricks

```
💡 TIP 1: Versioned cache keys
   "doc:v1:abc123" → khi schema thay đổi, bump lên v2
   → Không cần flush all cache khi deploy

💡 TIP 2: Cache null values
   Nếu query DB trả về nil → cache "null" với short TTL (1min)
   → Tránh DB hits cho non-existent keys (cache penetration)

💡 TIP 3: Local in-process cache + Redis (two-tier)
   ristretto/freecache cho L1 (nanosecond)
   Redis cho L2 (microsecond)
   → Best for read-heavy, rarely-changing data

💡 TIP 4: Pipeline multiple Redis commands
   pipe := rdb.Pipeline()
   pipe.Get(ctx, key1)
   pipe.Get(ctx, key2)
   pipe.Exec(ctx)  // 1 round trip thay vì 2

💡 TIP 5: Monitor cache hit rate
   Thêm metrics: cache_hit_total, cache_miss_total
   Nếu hit rate < 80% → TTL quá ngắn hoặc key space quá lớn
```

---

## 7. Tổng kết Bài 20

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ Cache-aside: read from cache, write-through DB  │
│  ✅ redis.Nil distinguish "miss" vs "error"         │
│  ✅ SetNX + lock để tránh cache stampede            │
│  ✅ redislock cho distributed lock với retry         │
│  ✅ Versioned keys → zero-downtime schema migration │
│  ✅ Cache null để tránh cache penetration           │
│  ✅ Pipeline để batch multiple commands              │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-21-Docker-Deploy|Bài 21: Docker & Deployment]]

---
*Tags: #go #redis #caching #distributed-lock #pub-sub #zero-to-hero*
