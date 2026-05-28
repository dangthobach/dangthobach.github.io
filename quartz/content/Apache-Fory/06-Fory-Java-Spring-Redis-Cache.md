# 06 — Fory + Spring Boot + Redis: Production-Grade Cache

> **Series:** [[00-MOC-Apache-Fory-Series]]  
> **Tags:** #apache-fory #spring-boot #redis #cache #production  
> **Level:** Intermediate-Advanced  
> **Prerequisite:** [[05-Fory-Java-Modes]]

---

## 🎯 Bạn sẽ học được gì?

- Production-grade Spring Boot + Redis + Fory config
- Migration strategy từ Jackson sang Fory (zero-downtime)
- Multi-level cache: L1 Caffeine (JVM) + L2 Redis (Fory)
- Cache warming, TTL strategy, eviction policy
- Monitoring: hit rate, payload size, latency metrics
- Tích hợp vào PDMS document cache

---

## 🏗️ Phần 1 — Architecture Tổng Thể

```
┌──────────────────────────────────────────────────────────────────┐
│                  PDMS CACHE ARCHITECTURE                         │
│                                                                  │
│  Request                                                         │
│     │                                                            │
│     ▼                                                            │
│  ┌──────────────────────────────────┐                           │
│  │  DocumentService                 │                           │
│  │                                  │                           │
│  │  1. Check L1 (Caffeine, JVM)     │ ← 0ms, pure memory       │
│  │     └── HIT → return ✅          │   ~10K entries, 5min TTL  │
│  │                                  │                           │
│  │  2. Check L2 (Redis + Fory)      │ ← 1-3ms, network         │
│  │     └── HIT → populate L1, return│   unlimited entries, 2h   │
│  │                                  │                           │
│  │  3. DB query                     │ ← 10-50ms                │
│  │     └── populate L2 then L1      │                           │
│  └──────────────────────────────────┘                           │
│                                                                  │
│  Fory role: L2 Redis serialization                              │
│  Replaces: Jackson JSON (~920 bytes → ~165 bytes per object)    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 📦 Phần 2 — Maven Dependencies

```xml
<dependencies>
    <!-- Fory -->
    <dependency>
        <groupId>org.apache.fory</groupId>
        <artifactId>fory-core</artifactId>
        <version>0.11.2</version>
    </dependency>

    <!-- Spring Boot Redis -->
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-data-redis</artifactId>
    </dependency>

    <!-- Caffeine (L1 cache) -->
    <dependency>
        <groupId>com.github.ben-manes.caffeine</groupId>
        <artifactId>caffeine</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-cache</artifactId>
    </dependency>

    <!-- Micrometer (metrics) -->
    <dependency>
        <groupId>io.micrometer</groupId>
        <artifactId>micrometer-core</artifactId>
    </dependency>
</dependencies>
```

---

## ⚙️ Phần 3 — Configuration Classes

### 3.1 Fory Bean

```java
@Configuration
public class ForyConfiguration {

    @Bean
    @Primary
    public ThreadSafeFory fory(ForyRegistrationProperties props) {
        ThreadSafeFory fory = Fory.builder()
            .withLanguage(Language.JAVA)
            .withCompatibleMode(CompatibleMode.SCHEMA_CONSISTENT)
            // Đổi sang COMPATIBLE nếu cần rolling deploy
            .withAsyncCompilation(true)
            .withRefTracking(true)
            .requireClassRegistration(true)
            .build();

        props.getClasses().forEach((id, className) -> {
            try {
                fory.register(Class.forName(className), id);
            } catch (ClassNotFoundException e) {
                throw new IllegalStateException("Cannot register Fory class: " + className, e);
            }
        });

        return fory;
    }
}
```

### 3.2 Registration via properties (maintainable)

```yaml
# application.yml
fory:
  classes:
    100: com.vpbank.pdms.domain.CreditDocument
    101: com.vpbank.pdms.domain.DocumentMetadata
    102: com.vpbank.pdms.domain.CreditProfile
    103: com.vpbank.pdms.domain.CollateralInfo
    104: com.vpbank.pdms.domain.WarehouseCode
    110: com.vpbank.pdms.domain.DocumentStatus
    111: com.vpbank.pdms.domain.CreditType
    120: java.util.ArrayList
    121: java.util.HashMap
    122: java.util.HashSet
    123: java.math.BigDecimal
```

```java
@ConfigurationProperties(prefix = "fory")
@Component
@Getter @Setter
public class ForyRegistrationProperties {
    private Map<Integer, String> classes = new LinkedHashMap<>();
}
```

### 3.3 Fory Redis Serializer

```java
@Component
@RequiredArgsConstructor
public class ForyRedisSerializer implements RedisSerializer<Object> {

    private final ThreadSafeFory fory;

    // Magic prefix để phân biệt Fory binary vs JSON legacy data
    private static final byte[] FORY_MAGIC = {0x46, 0x4F, 0x52, 0x59}; // "FORY"

    @Override
    public byte[] serialize(@Nullable Object obj) throws SerializationException {
        if (obj == null) return SerializationUtils.EMPTY_ARRAY;
        try {
            byte[] data = fory.serialize(obj);
            // Prefix với magic bytes để detect during migration
            byte[] result = new byte[FORY_MAGIC.length + data.length];
            System.arraycopy(FORY_MAGIC, 0, result, 0, FORY_MAGIC.length);
            System.arraycopy(data, 0, result, FORY_MAGIC.length, data.length);
            return result;
        } catch (Exception e) {
            throw new SerializationException("Fory serialize failed", e);
        }
    }

    @Override
    public Object deserialize(@Nullable byte[] bytes) throws SerializationException {
        if (bytes == null || bytes.length == 0) return null;
        try {
            // Check magic prefix
            if (hasForyMagic(bytes)) {
                byte[] data = Arrays.copyOfRange(bytes, FORY_MAGIC.length, bytes.length);
                return fory.deserialize(data);
            }
            // Fallback: try JSON (migration period)
            return fallbackJsonDeserialize(bytes);
        } catch (Exception e) {
            throw new SerializationException("Fory deserialize failed", e);
        }
    }

    private boolean hasForyMagic(byte[] bytes) {
        if (bytes.length < FORY_MAGIC.length) return false;
        for (int i = 0; i < FORY_MAGIC.length; i++) {
            if (bytes[i] != FORY_MAGIC[i]) return false;
        }
        return true;
    }

    private Object fallbackJsonDeserialize(byte[] bytes) {
        // Gọi Jackson cho legacy data trong migration period
        // Xóa sau khi migration hoàn thành
        return legacyObjectMapper.readValue(bytes, Object.class);
    }
}
```

### 3.4 Redis Cache Configuration

```java
@Configuration
@EnableCaching
@RequiredArgsConstructor
public class CacheConfiguration {

    private final ForyRedisSerializer foryRedisSerializer;

    // L2: Redis với Fory serialization
    @Bean
    public RedisCacheManager redisCacheManager(RedisConnectionFactory factory) {
        RedisCacheConfiguration defaultConfig = RedisCacheConfiguration
            .defaultCacheConfig()
            .serializeKeysWith(
                RedisSerializationContext.SerializationPair
                    .fromSerializer(new StringRedisSerializer())
            )
            .serializeValuesWith(
                RedisSerializationContext.SerializationPair
                    .fromSerializer(foryRedisSerializer)
            )
            .entryTtl(Duration.ofHours(2))
            .disableCachingNullValues();

        // Per-cache TTL configuration
        Map<String, RedisCacheConfiguration> cacheConfigs = Map.of(
            "documents",
            defaultConfig.entryTtl(Duration.ofHours(2)),

            "documentMetadata",
            defaultConfig.entryTtl(Duration.ofHours(4)),

            "creditProfiles",
            defaultConfig.entryTtl(Duration.ofHours(1)),

            "authorizationCache",
            defaultConfig.entryTtl(Duration.ofMinutes(15))
        );

        return RedisCacheManager.builder(factory)
            .cacheDefaults(defaultConfig)
            .withInitialCacheConfigurations(cacheConfigs)
            .build();
    }

    // L1: Caffeine in-JVM cache
    @Bean
    public CaffeineCacheManager caffeineCacheManager() {
        CaffeineCacheManager manager = new CaffeineCacheManager();
        manager.setCaffeine(Caffeine.newBuilder()
            .maximumSize(10_000)
            .expireAfterWrite(Duration.ofMinutes(5))
            .recordStats() // for Micrometer
        );
        return manager;
    }
}
```

---

## 🚀 Phần 4 — Two-Level Cache Implementation

### 4.1 Multi-level cache service

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class DocumentCacheService {

    private final CaffeineCacheManager l1CacheManager;
    private final RedisCacheManager l2CacheManager;
    private final MeterRegistry meterRegistry;

    public Optional<CreditDocument> get(String docId) {
        // L1 lookup
        Cache l1 = l1CacheManager.getCache("documents");
        Cache.ValueWrapper l1Result = l1.get(docId);
        if (l1Result != null) {
            meterRegistry.counter("cache.hit", "level", "l1").increment();
            return Optional.ofNullable((CreditDocument) l1Result.get());
        }

        // L2 lookup
        Cache l2 = l2CacheManager.getCache("documents");
        Cache.ValueWrapper l2Result = l2.get(docId);
        if (l2Result != null) {
            CreditDocument doc = (CreditDocument) l2Result.get();
            // Populate L1
            l1.put(docId, doc);
            meterRegistry.counter("cache.hit", "level", "l2").increment();
            return Optional.ofNullable(doc);
        }

        meterRegistry.counter("cache.miss").increment();
        return Optional.empty();
    }

    public void put(String docId, CreditDocument document) {
        Cache l1 = l1CacheManager.getCache("documents");
        Cache l2 = l2CacheManager.getCache("documents");
        l1.put(docId, document);
        l2.put(docId, document);
    }

    public void evict(String docId) {
        l1CacheManager.getCache("documents").evict(docId);
        l2CacheManager.getCache("documents").evict(docId);
    }
}
```

### 4.2 Service layer với cache

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class DocumentService {

    private final DocumentRepository repository;
    private final DocumentCacheService cache;

    public CreditDocument getDocument(String docId) {
        return cache.get(docId)
            .orElseGet(() -> {
                CreditDocument doc = repository.findById(docId)
                    .orElseThrow(() -> new DocumentNotFoundException(docId));
                cache.put(docId, doc);
                return doc;
            });
    }

    @Transactional
    public CreditDocument updateDocument(String docId, DocumentUpdateRequest req) {
        CreditDocument doc = repository.findById(docId)
            .orElseThrow(() -> new DocumentNotFoundException(docId));
        // update...
        CreditDocument saved = repository.save(doc);
        cache.evict(docId); // invalidate cache
        cache.put(docId, saved); // repopulate immediately
        return saved;
    }
}
```

---

## 📈 Phần 5 — Monitoring & Metrics

### 5.1 Fory-specific metrics

```java
@Component
@RequiredArgsConstructor
public class ForyMetricsCollector {

    private final ThreadSafeFory fory;
    private final MeterRegistry registry;

    // Track serialization payload size
    public byte[] serializeWithMetrics(String cacheName, Object obj) {
        long start = System.nanoTime();
        byte[] bytes = fory.serialize(obj);
        long duration = System.nanoTime() - start;

        registry.timer("fory.serialize", "cache", cacheName)
            .record(duration, TimeUnit.NANOSECONDS);
        registry.summary("fory.payload.bytes", "cache", cacheName)
            .record(bytes.length);

        return bytes;
    }

    public Object deserializeWithMetrics(String cacheName, byte[] bytes) {
        long start = System.nanoTime();
        Object obj = fory.deserialize(bytes);
        long duration = System.nanoTime() - start;

        registry.timer("fory.deserialize", "cache", cacheName)
            .record(duration, TimeUnit.NANOSECONDS);

        return obj;
    }
}
```

### 5.2 Grafana dashboard queries

```
# Cache hit rate by level
rate(cache_hit_total{level="l1"}[5m]) / rate(cache_requests_total[5m])

# Fory serialization latency p99
histogram_quantile(0.99, fory_serialize_seconds_bucket)

# Payload size distribution
histogram_quantile(0.95, fory_payload_bytes_bucket)

# Redis memory saved vs JSON baseline
# (Manually computed: track before/after migration)
```

---

## 🔄 Phần 6 — Zero-Downtime Migration Từ Jackson

### Migration strategy

```
PHASE 1: Dual-write (2 tuần)
─────────────────────────────
Writer: vẫn write JSON vào Redis (unchanged)
Reader: đọc JSON như bình thường
→ Chạy thêm metrics để baseline payload size

PHASE 2: Fory write, JSON fallback read (2 tuần)
──────────────────────────────────────────────────
Writer: write Fory binary (có magic prefix)
Reader: detect magic → Fory deserialize
        no magic → JSON fallback (legacy entries)
→ Redis tự nhiên expire JSON entries qua TTL
→ Monitor error rate

PHASE 3: Fory only (sau khi tất cả JSON entries expire)
─────────────────────────────────────────────────────────
Writer: Fory binary
Reader: Fory binary only (remove JSON fallback)
→ Complete
```

### Phase 2 implementation đã có ở ForyRedisSerializer trên (magic prefix + fallback).

### Kiểm tra migration progress

```java
@Scheduled(fixedDelay = 60_000)
public void reportMigrationProgress() {
    // Đếm key trong Redis — check type
    Long totalKeys = redisTemplate.keys("pdms:doc:*").size();
    // Trong thực tế dùng SCAN thay KEYS cho production
    log.info("Migration progress: {}/{} keys migrated to Fory",
        foryKeyCount, totalKeys);
}
```

---

## ⚠️ Phần 7 — Production Checklist

```
✅ TRƯỚC KHI DEPLOY
──────────────────────────────────────────────────────────────────
□ Tất cả domain classes đã register với explicit ID
□ Unit test serialize/deserialize từng class
□ Test null fields, empty collections
□ Test với @Cacheable annotation (Spring proxy)
□ Kiểm tra class không có non-static inner class
□ Verify ThreadSafeFory (không dùng Fory base class)

✅ KHI DEPLOY
──────────────────────────────────────────────────────────────────
□ Enable magic prefix cho migration period
□ Monitor Redis memory (nên giảm 40-60%)
□ Monitor cache hit rate (không được giảm)
□ Monitor deserialize error rate (phải = 0)
□ Monitor Fory serialize latency (nên < 200μs p99)

✅ SAU MIGRATION HOÀN THÀNH
──────────────────────────────────────────────────────────────────
□ Xóa JSON fallback code
□ Xóa Jackson dependency nếu không dùng chỗ khác
□ Document class ID registry vào Confluence
□ Thêm test ngăn chặn duplicate/conflict ID
```

---

## ✅ Key Takeaways

- [ ] Multi-level cache: L1 Caffeine (JVM) + L2 Redis (Fory) = optimal latency + size
- [ ] Fory magic prefix = safe migration từ JSON không cần downtime
- [ ] Registration via properties file = maintainable, explicit ID registry
- [ ] Luôn monitor payload size trước/sau migration để validate benefit
- [ ] SCHEMA_CONSISTENT cho cache (writer/reader luôn cùng version)

---

## 🔜 Bài tiếp theo

[[07-Fory-Java-Kafka-Internal-Events]] — Serialize Kafka internal events với Fory: producer/consumer config, compatible mode, error handling

---

## 📖 Tham khảo

- [Spring Cache Abstraction](https://docs.spring.io/spring-framework/docs/current/reference/html/integration.html#cache)
- [Fory RedisSerializer Pattern](https://fory.apache.org/docs/guide/java_object_graph_guide)
- [[Kafka-Configuration-Deep-Dive]]
- [[05-Fory-Java-Modes]]
