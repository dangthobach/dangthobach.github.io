---
tags: [concepts, cpu, memory, performance, hardware, evergreen]
created: 2026-05-02
difficulty: intermediate
estimated-read: 20 min
links: [io-models-deep-dive, os-process-thread-scheduling]
---

# 🧠 CPU Cache & Memory Hierarchy — Tại sao Data Locality quyết định Performance

> **Mục tiêu:** Hiểu tại sao code "đúng về mặt logic" vẫn chậm 100x — và cách viết code thân thiện với CPU cache.

---

## 🎯 Tại sao cần biết điều này?

```
Bạn optimize SQL query từ 2s xuống 200ms — nhưng trong Java code,
một vòng lặp đơn giản vẫn đang bỏ phí 90% CPU time vì cache miss.

Câu hỏi phỏng vấn Senior: "Tại sao HashMap nhanh hơn TreeMap trong
Java không phải chỉ vì O(1) vs O(log n), mà còn vì lý do gì khác?"
→ Câu trả lời: cache locality.
```

---

## 🏗️ Memory Hierarchy — Kim tự tháp tốc độ

```
                    ┌─────────────┐
                    │  Registers  │  ~0.25ns  | ~1 cycle
                    │   (bytes)   │  (CPU internal)
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   L1 Cache  │  ~1ns     | ~4 cycles
                    │   (32 KB)   │  per core
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   L2 Cache  │  ~4ns     | ~12 cycles
                    │  (256 KB)   │  per core
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   L3 Cache  │  ~15ns    | ~40 cycles
                    │   (8 MB)    │  shared across cores
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │    DRAM     │  ~100ns   | ~200 cycles
                    │   (GBs)     │  main memory
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │    NVMe     │  ~100µs   | 100,000 cycles
                    │    SSD      │
                    └─────────────┘

⚡ L1 cache hit = 1 ns  |  DRAM miss = 100 ns  →  100x slower!
```

**Quy tắc vàng:** CPU đang chờ DRAM **~70% thời gian** trong workloads thông thường. Đây là bottleneck thực sự.

---

## 📦 Cache Line — Đơn vị cơ bản của cache

Cache không load **từng byte** từ memory. Nó load theo **cache line = 64 bytes**.

```
Memory:
Addr:  0    8    16   24   32   40   48   56   64   72
       ├────┼────┼────┼────┼────┼────┼────┼────┼────┤
Data:  [a0] [a1] [a2] [a3] [a4] [a5] [a6] [a7] [b0] ...

                    ◄────── 64 bytes (1 cache line) ──────►
                              loaded together

Khi bạn access a[0]:
→ CPU load toàn bộ cache line 0-63 vào L1 cache
→ a[1]..a[7] đều đã trong L1 cache (cache warm)
→ Access a[1] → L1 hit → ~1ns
```

---

## ❌ False Sharing — Cạm bẫy đa luồng

**False Sharing xảy ra khi 2 threads write vào 2 variables KHÁC NHAU nhưng cùng cache line.**

```
Cache Line (64 bytes):
┌──────────────────────────────────────────────────────────┐
│  counter_A (8 bytes)  │  counter_B (8 bytes)  │  padding │
└──────────────────────────────────────────────────────────┘
         ▲                        ▲
    Thread 1 writes          Thread 2 writes

Vấn đề:
1. Thread 1 write counter_A → invalidates cache line trên Core 2
2. Thread 2 phải reload toàn bộ cache line từ L3/DRAM
3. Thread 2 write counter_B → invalidates cache line trên Core 1
4. Ping-pong không ngừng → performance disaster
```

```java
// ❌ BAD: False sharing
class Counter {
    volatile long a;  // Core 1 uses this
    volatile long b;  // Core 2 uses this — same cache line!
}

// ✅ GOOD: Padding to separate cache lines
class Counter {
    volatile long a;
    long p1, p2, p3, p4, p5, p6, p7; // 7 × 8 = 56 bytes padding
    volatile long b;
    // Now a and b are in different cache lines
}

// ✅ Java 8+: @Contended annotation (JVM handles padding)
@jdk.internal.vm.annotation.Contended
volatile long a;
@jdk.internal.vm.annotation.Contended
volatile long b;
```

**Real-world impact:** Disruptor (LMAX) giải quyết false sharing → **6 million messages/sec** thay vì ~500k với ArrayBlockingQueue.

---

## 🔀 NUMA — Non-Uniform Memory Access

Servers hiện đại có nhiều CPU socket, mỗi socket có DRAM riêng:

```
┌─────────────────────────────────────────────────────────┐
│                    Server Node                          │
│                                                         │
│  ┌──────────────────┐     ┌──────────────────────────┐  │
│  │   CPU Socket 0   │     │      CPU Socket 1        │  │
│  │  Core 0..7       │     │     Core 8..15           │  │
│  │  L1/L2/L3 Cache  │     │     L1/L2/L3 Cache       │  │
│  └────────┬─────────┘     └─────────────┬────────────┘  │
│           │                             │               │
│    ┌──────▼──────┐         ┌────────────▼──────┐        │
│    │   DRAM 0    │         │      DRAM 1        │        │
│    │  (local)    │◄───QPI──►    (remote)        │        │
│    │  ~60 GB/s   │  link   │    ~40 GB/s        │        │
│    └─────────────┘         └───────────────────┘        │
└─────────────────────────────────────────────────────────┘

Local memory access:  ~60ns
Remote memory access: ~120ns (cross-socket via QPI/UPI)
```

**NUMA gotchas:**
- JVM heap mặc định không NUMA-aware → cross-socket access thường xuyên
- `numactl --localalloc` để pin process vào 1 NUMA node
- PostgreSQL `numa_balancing`: check `/proc/sys/kernel/numa_balancing`

---

## 🚀 Cache-Friendly Patterns

### Pattern 1: Array vs Linked List

```
Array of ints:
Memory: [1][2][3][4][5][6][7][8] ← sequential, 1 cache line = 16 ints
Access pattern: prefetcher predicts next access ✅

Linked List:
[node1] → [node3] → [node7] → [node2] ...
           ↑            ↑
        far away    far away (cache miss each time)

Benchmark: array traversal vs linked list traversal
→ Array: 1ms for 1M elements
→ Linked list: 100ms for 1M elements (100x slower!)
```

### Pattern 2: Row-major vs Column-major Access

```java
int[][] matrix = new int[1000][1000];

// ✅ Row-major (cache friendly — Java stores row by row)
for (int i = 0; i < 1000; i++)
    for (int j = 0; j < 1000; j++)
        sum += matrix[i][j];  // sequential memory access

// ❌ Column-major (cache unfriendly)
for (int j = 0; j < 1000; j++)
    for (int i = 0; i < 1000; i++)
        sum += matrix[i][j];  // jumps 1000 ints = 4000 bytes per step

// Difference: 3-5x slower on column-major
```

### Pattern 3: Struct of Arrays vs Array of Structs

```java
// ❌ Array of Structs (AoS) — bad for SIMD/vectorization
class Particle { float x, y, z, mass; }
Particle[] particles = new Particle[1000];
// Only need x,y,z for physics → loading mass too (wasted bandwidth)

// ✅ Struct of Arrays (SoA) — cache friendly for specific field access
float[] xs = new float[1000];
float[] ys = new float[1000];
float[] zs = new float[1000];
float[] masses = new float[1000];
// Physics loop only touches xs, ys, zs → packed in cache
```

### Pattern 4: Hash Map Cache Locality

```
HashMap (chaining) — cache unfriendly:
[bucket] → [node] → [node] → null
                ↑ pointer chase, random memory

HashMap (open addressing, e.g., Rust HashMap / Java HashMap > Java 8):
[k1|v1][k2|v2][empty][k3|v3] — linear probing, cache friendly

Java HashMap actually uses chaining internally but:
→ Rust's HashMap (hashbrown): open addressing + SIMD metadata check
→ Cache-friendly probe sequence
```

---

## 🔧 Hardware Prefetcher

CPU không chờ cache miss — nó **predict** và load trước:

```
Sequential access: 0, 1, 2, 3, 4 → prefetcher sees pattern → loads 5, 6, 7 ahead
Strided access:    0, 8, 16, 24  → prefetcher detects stride → works
Random access:     0, 547, 23, 891 → prefetcher gives up → cache miss every time
```

**Implication:** Sorted data structures (B-Tree, sorted array) → prefetcher works → faster lookups than hash maps for range scans.

---

## 📊 Measuring Cache Behavior

```bash
# Linux perf — cache miss statistics
perf stat -e cache-references,cache-misses,L1-dcache-loads,L1-dcache-load-misses \
    java -jar myapp.jar

# Sample output:
#   1,234,567  cache-references
#     891,234  cache-misses          # 72% miss rate = very bad!
#  45,678,901  L1-dcache-loads
#   2,345,678  L1-dcache-load-misses # 5% = acceptable

# Valgrind cachegrind (simulation)
valgrind --tool=cachegrind java -jar myapp.jar
cg_annotate cachegrind.out.xxx
```

```rust
// Rust: criterion benchmark automatically measures with hardware counters
use criterion::{criterion_group, criterion_main, Criterion};
fn benchmark(c: &mut Criterion) {
    c.bench_function("array_traversal", |b| {
        let data: Vec<i64> = (0..1_000_000).collect();
        b.iter(|| data.iter().sum::<i64>())
    });
}
```

---

## 💡 Tips & Tricks

> **Tip 1 — HotSpot JIT & Cache**
> JVM JIT compiler có thể auto-vectorize loops nếu:
> - Array access sequential
> - Loop body simple (no branches)
> - `-XX:+UseAVX2` flag enabled
> Kiểm tra bằng `-XX:+PrintCompilation`

> **Tip 2 — Object Layout trong JVM**
> ```java
> // JVM object header: 16 bytes (8 mark word + 8 klass pointer)
> // boolean field: stored as 4 bytes (alignment)
> // Reorder fields: largest → smallest để tránh padding waste
> class Bad  { byte a; long b; byte c; } // 3 padding holes
> class Good { long b; byte a; byte c; } // packed
> // Tool: JOL (Java Object Layout)
> // System.out.println(ClassLayout.parseClass(Good.class).toPrintable());
> ```

> **Tip 3 — Off-heap Memory**
> `DirectByteBuffer` / `sun.misc.Unsafe` / Netty's `PooledByteBufAllocator` dùng off-heap:
> - Tránh GC pressure
> - Tránh heap copy khi gọi `write()` syscall (OS cần physical address)
> - Cache behavior tốt hơn (no GC compaction changes object address)

> **Tip 4 — PostgreSQL buffer pool**
> `shared_buffers = 25% RAM` — PostgreSQL cache data pages trong buffer pool
> Mỗi page = 8KB. Sequential scan = prefetch-friendly. Random access = scattered I/O.
> `enable_seqscan = off` trong EXPLAIN để force index (kiểm tra nếu index thực sự tốt hơn)

---

## 🔬 Case Studies

### Case Study 1: Redis Ziplist vs Hashtable
```
Redis small hash (<128 entries, values <64 bytes):
→ Encoded as ziplist (compact contiguous memory)
→ O(n) search nhưng blazing fast do cache locality

Redis large hash:
→ Switches to hashtable (O(1) but pointer chasing)

Lesson: O(1) không phải luôn faster than O(n) khi n nhỏ
```

### Case Study 2: Disruptor Ring Buffer
LMAX Disruptor — 6M messages/sec:
```
Ring buffer: pre-allocated array, fixed size, power of 2
┌──┬──┬──┬──┬──┬──┬──┬──┐
│  │  │  │  │  │  │  │  │  ← contiguous memory
└──┴──┴──┴──┴──┴──┴──┴──┘
  0  1  2  3  4  5  6  7

Producer/Consumer chỉ dùng sequence numbers → index = seq & (size-1)
→ No pointer chasing
→ Prefetcher loves sequential access
→ @Contended trên sequence counters → no false sharing
```

### Case Study 3: PDMS — Batch Insert Performance
```java
// PDMS ETL: insert 10M records
// ❌ Bad: insert 1 by 1 → 10M cache misses in entity manager
entityManager.persist(entity); // per row

// ✅ Good: batch insert với JDBC batch + flush every 200
// - Objects in contiguous memory (ArrayList)
// - JVM hot path: JIT optimizes tight loop
// - DB: batched network round trips
// Xem: Database-Patterns/Hibernate-Performance-Deep-Dive.md
```

---

## 📝 Key Takeaways

1. **Cache line = 64 bytes** — CPU load/evict theo đơn vị này, không phải byte
2. **L1 hit = 1ns, DRAM miss = 100ns** — 100x difference. Memory access pattern = performance
3. **False sharing** = 2 threads write khác nhau variables nhưng cùng cache line → ping-pong
4. **Array > Linked List** cho traversal vì sequential memory → prefetcher works
5. **SoA > AoS** khi chỉ cần subset fields → ít wasted bandwidth
6. **NUMA** — cross-socket memory access 2x slower, critical trên big servers
7. **Đo trước khi optimize** — `perf stat` để xem cache miss rate thực tế

---

## 🔗 Liên kết

- [[os-process-thread-scheduling]] — Context switch cost, cache flushing between threads
- [[io-models-deep-dive]] — I/O buffers và memory copy
- [[java-virtual-threads-deep-dive]] — Stack memory của virtual threads vs OS threads
- [[Performance-System-Programming/01-Database-Internals/05-Memtable-SkipList]] — Skip list cache behavior
