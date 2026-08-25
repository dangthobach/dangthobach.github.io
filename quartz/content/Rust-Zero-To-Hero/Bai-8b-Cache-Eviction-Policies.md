---
type: course
domain: languages/rust
status: active
created: 2026-08-25
updated: 2026-08-25
tags: []
---

# Bài 8b: Cache Eviction Policies — Từ `HashMap` trần tới LRU thật sự

Chào Chuyên gia Java, ở Bài 8 bạn đã có cache dạng `Arc<RwLock<HashMap<K, V>>>` — nhưng đó là cache **không bao giờ xóa gì**, sẽ phình vô hạn (OOM trong production). Java có `LinkedHashMap` với `removeEldestEntry()` cho LRU built-in gần miễn phí; Rust không có sẵn — bạn phải tự ráp hoặc dùng crate `lru`. Bài này lấp đúng phần "eviction" mà Bài 8 còn thiếu.

## 1. Vì sao `HashMap` trần không đủ

`HashMap` không giữ thứ tự truy cập/chèn — không có cách nào biết "entry nào cũ nhất/ít dùng nhất" để xóa khi đầy. Cần một cấu trúc phụ theo dõi thứ tự.

## 2. Tự implement LRU: `HashMap` + Doubly Linked List (ý tưởng)

Cách kinh điển (LeetCode "LRU Cache") dùng `HashMap<K, *mut Node>` + doubly linked list để có O(1) cho cả get/put/evict. Ở Rust, linked list chứa con trỏ qua lại là bài toán aliasing khó (đây là lý do `std::collections::LinkedList` gần như không ai dùng thực tế) — nên bản thủ công thường cần `unsafe` hoặc index-based arena thay vì raw pointer:

```rust
use std::collections::HashMap;

struct LruCache<K, V> {
    map: HashMap<K, (V, u64)>, // value + "last used" timestamp/tick
    capacity: usize,
    tick: u64,
}

impl<K: std::hash::Hash + Eq + Clone, V> LruCache<K, V> {
    fn new(capacity: usize) -> Self {
        Self { map: HashMap::new(), capacity, tick: 0 }
    }

    fn get(&mut self, key: &K) -> Option<&V> {
        self.tick += 1;
        let tick = self.tick;
        if let Some(entry) = self.map.get_mut(key) {
            entry.1 = tick; // cập nhật "last used"
            Some(&entry.0)
        } else {
            None
        }
    }

    fn put(&mut self, key: K, value: V) {
        if self.map.len() >= self.capacity && !self.map.contains_key(&key) {
            // Tìm entry có tick nhỏ nhất để evict — O(n), chấp nhận được ở cache nhỏ/vừa
            if let Some(oldest_key) = self.map.iter().min_by_key(|(_, (_, t))| *t).map(|(k, _)| k.clone()) {
                self.map.remove(&oldest_key);
            }
        }
        self.tick += 1;
        self.map.insert(key, (value, self.tick));
    }
}
```

Bản này O(n) khi evict — đủ dùng cho cache vài nghìn entry, nhưng **không phù hợp** cho cache hàng triệu entry cần O(1) tuyệt đối.

## 3. Production-grade: dùng crate `lru`

Trong code thật (kể cả PDMS), không tự viết linked-list unsafe — dùng crate `lru`, đã giải quyết bài toán aliasing bằng index-based slab thay vì raw pointer:

```rust
// Cargo.toml: lru = "0.12"
use lru::LruCache;
use std::num::NonZeroUsize;

let mut cache: LruCache<String, String> = LruCache::new(NonZeroUsize::new(100).unwrap());
cache.put("key1".to_string(), "value1".to_string());
cache.get("key1"); // đưa key1 lên "mới nhất", O(1)

if cache.len() == cache.cap().get() {
    // cache.put() tự động evict LRU khi đầy — không cần code tay
}
```

Kết hợp với `Mutex`/`RwLock` (Bài 8) để dùng đa luồng: `Arc<Mutex<LruCache<K, V>>>`.

## 4. TTL-based Eviction — xóa theo thời gian, không theo dung lượng

Khác hoàn toàn LRU (xóa khi ĐẦY): TTL xóa khi entry **quá hạn**, dù cache còn chỗ — cần thiết cho cache dữ liệu "hết hạn" như session token, JWT cache, kết quả API có thời hạn:

```rust
use std::collections::HashMap;
use std::time::{Duration, Instant};

struct TtlCache<K, V> {
    map: HashMap<K, (V, Instant)>,
    ttl: Duration,
}

impl<K: std::hash::Hash + Eq, V: Clone> TtlCache<K, V> {
    fn get(&mut self, key: &K) -> Option<V> {
        match self.map.get(key) {
            Some((value, inserted_at)) if inserted_at.elapsed() < self.ttl => Some(value.clone()),
            Some(_) => { self.map.remove(key); None } // hết hạn — xóa lazy khi truy cập
            None => None,
        }
    }

    fn put(&mut self, key: K, value: V) {
        self.map.insert(key, (value, Instant::now()));
    }

    // Active eviction — chạy định kỳ bằng 1 tokio task riêng (liên hệ Bài 9)
    fn purge_expired(&mut self) {
        self.map.retain(|_, (_, t)| t.elapsed() < self.ttl);
    }
}
```

**Lazy vs Active eviction:** lazy (xóa khi `get()` phát hiện hết hạn) tiết kiệm CPU nhưng entry chết vẫn chiếm RAM tới khi có ai đọc; active (task nền gọi `purge_expired()` định kỳ qua `tokio::time::interval`) tốn CPU đều đặn nhưng kiểm soát bộ nhớ chặt hơn — production thường dùng CẢ HAI kết hợp.

## 5. LFU (Least Frequently Used) — khi tần suất quan trọng hơn thời gian

LRU đôi khi evict nhầm entry "hot" nhưng vừa mới không được hỏi tới trong khoảnh khắc ngắn. LFU đếm số lần truy cập, evict entry có count thấp nhất — phù hợp khi pattern truy cập có "hotspot" ổn định (ví dụ cache config ít thay đổi nhưng được đọc rất thường xuyên bởi 1 nhóm request, ít bởi nhóm khác).

```rust
struct LfuEntry<V> { value: V, freq: u32 }
// Cấu trúc: HashMap<K, LfuEntry<V>> + BinaryHeap (Bài 4b) theo freq để tìm min nhanh
```

Thực tế: LFU phức tạp hơn nhiều để làm đúng O(1) (cần bucket theo tần suất) — nếu không có yêu cầu đặc biệt, LRU (crate `lru`) hoặc TTL đã đủ cho tuyệt đại đa số service.

## 6. Bảng chọn chiến lược

| Tình huống | Chiến lược | Công cụ |
|---|---|---|
| Cache RAM có giới hạn dung lượng cố định | LRU | crate `lru` |
| Dữ liệu có hạn dùng rõ ràng (session, token) | TTL | `HashMap` + `Instant`, hoặc crate `moka` |
| Pattern truy cập có hotspot ổn định, ít thay đổi | LFU | tự implement hoặc `moka` |
| Cần cả LRU + TTL + async + thống kê | — | crate `moka` (production-grade, dùng rộng rãi) |

## 7. Cheat Sheet so với Java

| Java | Rust |
|---|---|
| `LinkedHashMap` + `removeEldestEntry` (LRU thủ công) | crate `lru` |
| Guava `CacheBuilder.expireAfterWrite()` | TTL tự viết, hoặc crate `moka` |
| Caffeine cache (LRU+LFU hybrid, async) | crate `moka` (tương đương gần nhất) |

---
**Bài tập nhỏ:**
1. Dùng crate `lru`, viết một `Arc<Mutex<LruCache<String, Vec<u8>>>>` mô phỏng cache kết quả query PDMS, capacity 1000, viết test chứng minh entry cũ nhất bị evict khi vượt capacity.
2. Viết `TtlCache` với TTL 5 giây, kèm 1 `tokio::spawn` chạy `purge_expired()` mỗi 1 giây, log số entry bị xóa mỗi lần purge.
3. Giải thích (bằng comment code): tại sao tự viết doubly-linked-list LRU bằng raw pointer trong Rust khó hơn Java, liên hệ lại kiến thức aliasing ở Bài 19 (Unsafe).
