---
type: course
domain: languages/rust
status: active
created: 2026-08-22
updated: 2026-08-22
tags: []
---

# Bài 4b: Collections đầy đủ — Vượt qua "bộ ba" Vec/HashMap/String

Chào Chuyên gia Java, Bài 4 mới cho bạn `Vec` (≈ `ArrayList`) và `HashMap`. Nhưng `java.util` có cả `LinkedList`, `TreeMap`, `TreeSet`, `PriorityQueue`, `ArrayDeque` — và Rust cũng có bộ tương đương trong `std::collections`, mỗi loại giải quyết một bài toán khác nhau. Chọn sai collection là một trong những lỗi hiệu năng phổ biến nhất của người mới.

## 1. `VecDeque<T>` — Deque hai đầu, thay cho `ArrayDeque`

```rust
use std::collections::VecDeque;

let mut queue: VecDeque<i32> = VecDeque::new();
queue.push_back(1);   // thêm cuối — O(1) amortized
queue.push_front(0);  // thêm đầu — O(1), Vec thường KHÔNG làm được việc này hiệu quả
let front = queue.pop_front(); // Some(0)
```

Dùng khi: cần queue (FIFO), sliding window, BFS. `Vec::remove(0)` là O(n) — nếu bạn thấy code push/pop ở đầu Vec liên tục, đó là dấu hiệu cần đổi sang `VecDeque`.

## 2. `BTreeMap<K, V>` / `BTreeSet<T>` — khi cần thứ tự, thay `TreeMap`/`TreeSet`

```rust
use std::collections::BTreeMap;

let mut scores: BTreeMap<String, i32> = BTreeMap::new();
scores.insert("Bob".into(), 80);
scores.insert("Alice".into(), 90);
for (name, score) in &scores {
    println!("{name}: {score}"); // luôn in theo thứ tự key: Alice, Bob (sorted)
}

let range = scores.range("A".to_string().."C".to_string()); // range query — HashMap không làm được
```

`HashMap` không đảm bảo thứ tự (và thứ tự có thể đổi giữa các lần chạy vì hash randomization chống DoS). Dùng `BTreeMap` khi: cần duyệt theo thứ tự key, cần range query (`.range()`), hoặc key không implement `Hash` tốt nhưng có `Ord`.

**Đánh đổi:** `BTreeMap` là O(log n) cho insert/lookup, `HashMap` là O(1) trung bình — mặc định nên dùng `HashMap` trừ khi bạn thực sự cần thứ tự.

## 3. `HashSet<T>` / `BTreeSet<T>` — tập hợp không trùng lặp

```rust
use std::collections::HashSet;

let mut seen: HashSet<u32> = HashSet::new();
seen.insert(1);
let is_new = seen.insert(1); // false — đã tồn tại

let a: HashSet<i32> = [1, 2, 3].into_iter().collect();
let b: HashSet<i32> = [2, 3, 4].into_iter().collect();
let common: HashSet<_> = a.intersection(&b).collect(); // {2, 3}
```

Tương đương `HashSet`/`TreeSet` của Java, kèm sẵn các phép toán tập hợp (`union`, `intersection`, `difference`).

## 4. `BinaryHeap<T>` — Priority Queue, thay `PriorityQueue`

```rust
use std::collections::BinaryHeap;

let mut heap = BinaryHeap::new();
heap.push(3);
heap.push(1);
heap.push(5);
while let Some(max) = heap.pop() {
    println!("{max}"); // 5, 3, 1 — max-heap mặc định
}
```

Mặc định là **max-heap**. Muốn min-heap: bọc giá trị bằng `std::cmp::Reverse`.

```rust
use std::cmp::Reverse;
let mut min_heap = BinaryHeap::new();
min_heap.push(Reverse(3));
min_heap.push(Reverse(1));
// pop() ra Reverse(1) trước — nhỏ nhất trước
```

## 5. Entry API — pattern "upsert" quan trọng nhất của `HashMap`

Đây là thứ bạn sẽ dùng liên tục nhưng Bài 4 chưa nhắc tới. Thay vì check-rồi-insert (2 lần lookup, và dễ sai với borrow checker):

```rust
use std::collections::HashMap;
let mut word_count: HashMap<String, i32> = HashMap::new();

for word in "the quick brown fox the lazy dog the".split_whitespace() {
    // Cách sai/dài dòng (Java-style check-then-act):
    // if word_count.contains_key(word) { *word_count.get_mut(word).unwrap() += 1; }
    // else { word_count.insert(word.to_string(), 1); }

    // Cách đúng, idiomatic — 1 lần lookup duy nhất:
    *word_count.entry(word.to_string()).or_insert(0) += 1;
}

// or_insert_with khi giá trị mặc định cần tính toán (lazy, tránh alloc thừa)
word_count.entry("new".into()).or_insert_with(|| compute_default());

// and_modify để tách rõ "nếu có thì sửa, nếu không thì tạo mới"
word_count.entry("the".into())
    .and_modify(|c| *c += 10)
    .or_insert(1);
```

`entry()` giải quyết đúng vấn đề mà Java dev hay gặp: check-then-act trên map không atomic và tốn 2 lần hash lookup. Rust cho bạn 1 API vừa an toàn với borrow checker, vừa chỉ 1 lần lookup.

## 6. Bảng so sánh chọn Collection

| Cần gì | Collection | Big-O insert/lookup | Java tương đương |
|---|---|---|---|
| Danh sách, index truy cập | `Vec<T>` | O(1) amortized push / O(1) index | `ArrayList` |
| Thêm/xóa cả 2 đầu | `VecDeque<T>` | O(1) amortized | `ArrayDeque` |
| Key-value, không cần thứ tự | `HashMap<K,V>` | O(1) trung bình | `HashMap` |
| Key-value, cần thứ tự/range | `BTreeMap<K,V>` | O(log n) | `TreeMap` |
| Tập hợp, không trùng | `HashSet<T>` | O(1) trung bình | `HashSet` |
| Tập hợp, cần thứ tự | `BTreeSet<T>` | O(log n) | `TreeSet` |
| Lấy max/min liên tục | `BinaryHeap<T>` | O(log n) push/pop | `PriorityQueue` |

---
**Bài tập nhỏ:**
1. Dùng `entry().or_insert_with(Vec::new)` để group một `Vec<(String, i32)>` (tên, điểm) thành `HashMap<String, Vec<i32>>` (gom điểm theo tên).
2. Viết hàm dùng `BinaryHeap<Reverse<i32>>` để tìm k số nhỏ nhất trong một `Vec<i32>`.
3. So sánh: dùng `BTreeMap` in ra bảng xếp hạng theo alphabet tên, rồi thử thay bằng `HashMap` xem thứ tự output có ổn định giữa 2 lần chạy không.
