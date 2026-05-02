# Probabilistic Data Structures — Deep Dive

---
tags: [data-structures, algorithms, performance, bloom-filter, hyperloglog, caching]
created: 2026-05-02
difficulty: advanced
estimated-read: 20 min
links: [[caching-strategies-comprehensive]], [[Performance-System-Programming/01-Database-Internals/03-BTree-vs-LSM]], [[memory-hierarchy-cpu-cache]]

---

## 🎯 Learning Objectives

Sau bài này bạn sẽ:
- Hiểu **trade-off** giữa chính xác tuyệt đối và hiệu suất cao
- Nắm **cơ chế toán học** của Bloom Filter, HyperLogLog, Count-Min Sketch, Skip List
- Biết khi nào và cách áp dụng vào real systems (database, caching, rate limiting)
- Implement Bloom Filter trong Java

---

## 🤔 Tại Sao Cần Probabilistic Data Structures?

```
Bài toán: Hệ thống có 1 tỷ URL đã crawled
          Kiểm tra: URL mới có được crawled chưa?

Option 1: HashSet<String>
  - 1 tỷ URL × 100 bytes = 100GB RAM
  - Exact answer: YES
  - Cost: $$$$$

Option 2: Bloom Filter
  - 1 tỷ URL × 1.2 bytes = 1.2GB RAM (83x nhỏ hơn!)
  - Answer: "DEFINITELY NOT crawled" hoặc "PROBABLY crawled"
  - False positive rate: ~1%
  - Cost: $

Trade-off: Chấp nhận một chút uncertainty để tiết kiệm 80x memory
```

```
Probabilistic DS: đánh đổi accuracy lấy space/time efficiency

Rule:
  "Definitely NOT" → always correct (no false negatives*)
  "PROBABLY YES"   → might be wrong (false positives exist)
  
  *Bloom Filter có false positives, không có false negatives
```

---

## 🌸 Bloom Filter

### Cơ chế hoạt động

```
Bloom Filter = Bit array + Multiple hash functions

Setup: m = 100 bits, k = 3 hash functions

Insert "pdms-doc-12345":
  h1("pdms-doc-12345") % 100 = 23 → set bit[23] = 1
  h2("pdms-doc-12345") % 100 = 67 → set bit[67] = 1
  h3("pdms-doc-12345") % 100 = 41 → set bit[41] = 1

Query "pdms-doc-12345":
  Check bit[23] = 1 ✓
  Check bit[67] = 1 ✓
  Check bit[41] = 1 ✓
  → "PROBABLY IN SET"

Query "pdms-doc-99999" (never inserted):
  h1("pdms-doc-99999") % 100 = 23 → bit[23] = 1 (collision!)
  h2("pdms-doc-99999") % 100 = 15 → bit[15] = 0 ✗
  → "DEFINITELY NOT IN SET"

┌─────────────────────────────────────────────────────────────┐
│ Bit Array (100 bits, showing first 70):                     │
│ 0000000000000000000000010000000000000000010000000000000000000│
│                       ^23             ^41                   │
│ 000000001000000000000000000000000000000000000000000000000000 │
│         ^67 (in range 60-70)                                │
└─────────────────────────────────────────────────────────────┘
```

### False Positive Rate

```
False positive probability:
  p = (1 - e^(-k*n/m))^k

Where:
  k = number of hash functions
  n = number of elements inserted
  m = number of bits in array

Optimal k = (m/n) * ln(2)

Example:
  n = 1,000,000 elements
  Target p = 1% false positive rate
  → m ≈ 9.585 * n = 9,585,000 bits ≈ 1.2 MB
  → k ≈ 6.6 ≈ 7 hash functions
  
  Memory: 1.2MB for 1M elements!
  vs HashSet: ~80MB for 1M String URLs
```

### Java Implementation — Guava BloomFilter

```java
import com.google.common.hash.BloomFilter;
import com.google.common.hash.Funnels;

// Create Bloom Filter
BloomFilter<String> bloomFilter = BloomFilter.create(
    Funnels.stringFunnel(StandardCharsets.UTF_8),
    10_000_000,  // Expected insertions (10M)
    0.01         // 1% false positive rate
);

// Insert
bloomFilter.put("pdms-warehouse-WH-2025-00001");
bloomFilter.put("pdms-warehouse-WH-2025-00002");

// Query
if (!bloomFilter.mightContain(warehouseCode)) {
    // DEFINITELY doesn't exist → skip expensive DB lookup!
    throw new WarehouseNotFoundException(warehouseCode);
}
// mightContain = true → do actual DB lookup to confirm
return warehouseRepository.findByCode(warehouseCode);
```

### Real-world usage

```
PostgreSQL: pg_bloom extension — Bloom Filter index
  → Saves space for multi-column equality queries

Cassandra: Bloom Filter per SSTable
  → Check nếu SSTable có thể chứa key trước khi đọc từ disk

Redis: RedisBloom module
  → Distributed Bloom Filter across cluster

Kafka: Kafka Connect
  → Exactly-once deduplication với Bloom Filter trước DB check
```

---

## 📊 HyperLogLog — Đếm Phần Tử Distinct

### Vấn đề: Count Distinct Users

```
"Hôm nay có bao nhiêu unique users truy cập PDMS?"

Option 1: SELECT COUNT(DISTINCT user_id) FROM access_log
  → Full table scan, chậm với 100M rows
  
Option 2: HashSet<Long>
  → Exact, nhưng cần O(n) memory với n distinct users

Option 3: HyperLogLog
  → 12KB memory cho bất kỳ số distinct elements nào!
  → Accuracy: ±0.81% error
  → "Approximately 1,847,293 unique users today"
```

### Cơ chế HyperLogLog

```
Intuition: Leading zeros trong hash value

If hash("user-12345") = 0000100110...
  → Có 4 leading zeros → rất hiếm → tập hợp phải lớn!

If maximum leading zeros seen = k
  → Estimated cardinality ≈ 2^k

HyperLogLog cải thiện:
  - Chia thành m = 2^b buckets (b bits prefix của hash)
  - Mỗi bucket track max leading zeros
  - Estimate = harmonic mean của tất cả bucket estimates
  - Error = 1.04 / √m

Standard error thực tế:
  m = 1024 buckets (10 bits) → error ≈ 3.25%
  m = 4096 buckets (12 bits) → error ≈ 1.625%  
  m = 16384 buckets (14 bits) → error ≈ 0.8%   ← Redis default
```

### Redis HyperLogLog

```java
// Redis HyperLogLog — 12KB cho bất kỳ n nào!
@Service
public class UniqueVisitorService {
    
    private final RedisTemplate<String, String> redis;
    
    public void recordVisit(String userId, LocalDate date) {
        String key = "hll:visitors:" + date.toString();
        redis.opsForHyperLogLog().add(key, userId);
        redis.expire(key, 90, TimeUnit.DAYS);
    }
    
    public long countUniqueVisitors(LocalDate date) {
        String key = "hll:visitors:" + date.toString();
        return redis.opsForHyperLogLog().size(key);  // ±0.81% error
    }
    
    // Merge: count unique visitors across multiple days
    public long countUniqueVisitorsForPeriod(LocalDate start, LocalDate end) {
        String[] keys = start.datesUntil(end.plusDays(1))
            .map(d -> "hll:visitors:" + d.toString())
            .toArray(String[]::new);
        
        String mergedKey = "hll:visitors:merged:" + start + ":" + end;
        redis.opsForHyperLogLog().union(mergedKey, keys);
        return redis.opsForHyperLogLog().size(mergedKey);
    }
}
```

---

## 📈 Count-Min Sketch — Frequency Estimation

### Vấn đề: Top-K Frequent Items

```
"Warehouse nào được truy cập nhiều nhất?"
"API endpoint nào được gọi nhiều nhất?"
"Document nào hot nhất hôm nay?"

Option 1: Map<String, Long> count
  → Chính xác, nhưng O(n) memory với n distinct items

Option 2: Count-Min Sketch
  → O(ε * δ) memory (fixed, không phụ thuộc vào n)
  → Trả về upper bound estimate với error ≤ ε
```

### Cơ chế

```
Count-Min Sketch = 2D array + multiple hash functions

Setup: d rows (depth), w columns (width)
  Each row uses different hash function

Update "warehouse-WH-001" count += 1:
  row0: h0("WH-001") % w = 15 → table[0][15]++
  row1: h1("WH-001") % w = 42 → table[1][42]++
  row2: h2("WH-001") % w = 7  → table[2][7]++

Query "warehouse-WH-001":
  estimate = min(table[0][15], table[1][42], table[2][7])
  → Return minimum (overcount do hash collision, min giảm thiểu error)
```

```java
// Rate limiting với Count-Min Sketch (Redis)
// Đếm requests per user trong sliding window

public class RateLimiter {
    // Approximate counting — tiết kiệm memory vs exact HashMap
    private final RedissonClient redisson;
    
    public boolean allowRequest(String userId) {
        String key = "rate:" + userId + ":" + currentWindow();
        
        // Count-Min Sketch trong Redis:
        RCountMinSketch<String> sketch = redisson.getCountMinSketch("request-counter");
        sketch.tryInit(0.001, 0.99);  // error=0.1%, confidence=99%
        sketch.add(userId, 1);
        
        long count = sketch.count(userId);
        return count <= 1000;  // 1000 requests per window
    }
}
```

---

## ⏩ Skip List — Ordered Probabilistic DS

### So sánh với Balanced BST

```
Skip List vs Red-Black Tree:
  Both: O(log n) search, insert, delete
  
  Red-Black Tree: Complex rotation logic, hard to implement correctly
  Skip List: Simple "coin flip" algorithm, lock-free concurrent easy
  
Sử dụng thực tế:
  Redis ZSET (Sorted Set) → Skip List implementation
  LevelDB/RocksDB MemTable → Skip List
  Java ConcurrentSkipListMap → thread-safe, no locking
```

### Cơ chế

```
Skip List = Linked list + Express lanes (multiple levels)

Level 3: ────────────────────────────► [50] ────────────────►
Level 2: ────────────► [25] ─────────► [50] ──► [75] ──────►
Level 1: ──► [10] ──► [25] ──► [40] ──► [50] ──► [75] ──► [90] ──►
Level 0: [1]─[5]─[10]─[20]─[25]─[30]─[40]─[45]─[50]─[60]─[75]─[80]─[90]

Search 60:
  Level 3: 60 > 50? → go right... end → go down
  Level 2: 60 > 75? → NO → go down  
  Level 1: 60 > 50? YES → go right. 60 > 75? NO → go down
  Level 0: 60 > 50? YES → 60 = 60? ✓ FOUND

Probabilistic leveling:
  Each node promoted to level i+1 with probability p = 0.5
  Average levels: log(1/p)(n) = log₂(n)
```

```java
// Java ConcurrentSkipListMap — PDMS ordered document index
ConcurrentSkipListMap<DocumentKey, Document> orderByDate = 
    new ConcurrentSkipListMap<>();

// Insert
orderByDate.put(new DocumentKey(doc.getCreatedAt(), doc.getId()), doc);

// Range query — O(log n + k) where k = result size
SortedMap<DocumentKey, Document> lastWeek = orderByDate.subMap(
    new DocumentKey(LocalDateTime.now().minusWeeks(1), Long.MIN_VALUE),
    new DocumentKey(LocalDateTime.now(), Long.MAX_VALUE)
);

// Thread-safe — no explicit synchronization needed!
```

---

## 📊 Comparison Summary

```
┌───────────────────────────────────────────────────────────────────┐
│             Probabilistic Data Structures — At a Glance           │
│                                                                    │
│  Structure    │ Use Case          │ Space    │ Error Type          │
│  ─────────────┼───────────────────┼──────────┼──────────────────  │
│  Bloom Filter │ Membership test   │ O(n×1.2B)│ False positive      │
│               │ "Is X in set?"    │ 1.2MB/1M │ rate configurable  │
│  ─────────────┼───────────────────┼──────────┼──────────────────  │
│  HyperLogLog  │ Cardinality count │ 12KB     │ ±0.81% error       │
│               │ Count distinct    │ fixed!   │                    │
│  ─────────────┼───────────────────┼──────────┼──────────────────  │
│  Count-Min    │ Frequency count   │ O(w×d)   │ Over-estimate      │
│  Sketch       │ Top-K, rate limit │ fixed!   │ (never under)      │
│  ─────────────┼───────────────────┼──────────┼──────────────────  │
│  Skip List    │ Ordered data      │ O(n)     │ None (exact)       │
│               │ Concurrent access │ avg+50%  │ Probabilistic only │
│               │                   │ overhead │ in structure       │
└───────────────────────────────────────────────────────────────────┘
```

---

## 📚 Case Study — PDMS Applications

### 1. Bloom Filter — Deduplication

```java
// Problem: Batch import 100K documents — skip duplicates efficiently
// Without BF: 100K DB queries to check existence

@Service
public class DocumentBatchImporter {
    
    private BloomFilter<String> existingDocsBF;
    
    @PostConstruct
    public void loadBloomFilter() {
        // Load all existing external_ids into Bloom Filter at startup
        existingDocsBF = BloomFilter.create(Funnels.stringFunnel(UTF_8), 
            10_000_000, 0.001);  // 0.1% false positive
        
        documentRepository.streamAllExternalIds()
            .forEach(existingDocsBF::put);
    }
    
    public BatchImportResult importDocuments(List<DocumentImportRow> rows) {
        int skipped = 0, imported = 0;
        
        for (DocumentImportRow row : rows) {
            if (!existingDocsBF.mightContain(row.getExternalId())) {
                // Definitely new → import
                documentRepository.save(toDocument(row));
                existingDocsBF.put(row.getExternalId());
                imported++;
            } else {
                // Might exist → verify with DB (0.1% false positives)
                if (documentRepository.existsByExternalId(row.getExternalId())) {
                    skipped++;
                } else {
                    // False positive case
                    documentRepository.save(toDocument(row));
                    imported++;
                }
            }
        }
        return new BatchImportResult(imported, skipped);
    }
}
// Result: 99.9% of DB lookups eliminated!
```

### 2. HyperLogLog — Usage Analytics

```java
// Daily unique document viewers per tenant
// Exact: Map<tenantId, Set<userId>> → too much memory
// HLL: Map<tenantId, HLL> → fixed 12KB per tenant

public void recordDocumentView(Long documentId, String userId, String tenantId) {
    String hllKey = "hll:doc-views:" + tenantId + ":" + LocalDate.now();
    redis.opsForHyperLogLog().add(hllKey, userId + ":" + documentId);
}

public long getApproxUniqueViewers(String tenantId, LocalDate date) {
    return redis.opsForHyperLogLog()
        .size("hll:doc-views:" + tenantId + ":" + date);
    // ±0.81% error — acceptable for analytics dashboard
}
```

---

## 🔑 Key Takeaways

1. **Probabilistic DS** = trade accuracy for space/time — không phải compromise, đây là engineering decision
2. **Bloom Filter:** `mightContain=false` → guaranteed not in set (no false negatives)
3. **HyperLogLog:** 12KB cố định đếm distinct elements với ±0.81% error — Redis `PFADD/PFCOUNT`
4. **Count-Min Sketch:** frequency estimation, always over-estimates (never under)
5. **Skip List:** ordered data + lock-free concurrent → Redis ZSET, Java `ConcurrentSkipListMap`
6. Bloom Filter sizing: `m ≈ -n*ln(p) / (ln2)²` — dùng Guava `BloomFilter.create()` tự tính
7. Use cases phổ biến: cache pre-filter, deduplication, analytics cardinality, rate limiting
8. Database internals: RocksDB/LevelDB dùng Bloom Filter per SSTable — reduce disk reads

---

## 🔗 Related Links

- [[Performance-System-Programming/01-Database-Internals/03-BTree-vs-LSM]] — LSM-Tree dùng Bloom Filter
- [[caching-strategies-comprehensive]] — Bloom Filter như pre-cache filter
- [[memory-hierarchy-cpu-cache]] — Space efficiency liên quan đến cache efficiency
- [[connection-pooling-pgbouncer]] — Count-Min Sketch cho rate limiting
