---
type: course
domain: languages/go
status: active
created: 2026-08-01
updated: 2026-08-01
tags: [go, data-structures, algorithms, generics, zero-to-hero]
---

# Bài 32: Cấu Trúc Dữ Liệu & Giải Thuật trong Go — Generics, Cú Pháp Rút Gọn & Pitfalls Triển Khai

> **Mục tiêu:** Tự viết được các cấu trúc dữ liệu core (Stack, Queue, Linked List, BST, Heap, Hash Table, Graph, Trie) bằng Go generics đúng idiom, thành thạo các cú pháp rút gọn Go dùng để viết giải thuật gọn — và quan trọng nhất: biết những **lưu ý triển khai** mà dev từ Java hay bỏ sót (escape analysis, slice aliasing, thiếu tail-call optimization, generic zero value).
>
> **Level:** Advanced (bonus lesson — đọc sau [[Bai-2-Syntax-Types-Structs|Bài 2]] và [[Bai-23-Pointers-Deep-Dive|Bài 23]])

---

## 0. Vì sao cần bài riêng cho DS&A?

Bài 2 đã có `Stack[T]` cơ bản dùng slice. Nhưng thực chiến ở PDMS (document indexing, priority processing queue, cache layer, hierarchical folder structure) đòi hỏi nhiều hơn thế — và Go có một đặc điểm khác hẳn Java:

```
┌───────────────────────────────────────────────────────────────┐
│  Java: có java.util.* đầy đủ         │  Go: KHÔNG có Collections │
│  (ArrayList, LinkedList, TreeMap,    │  Framework. Bạn tự viết   │
│  PriorityQueue, HashSet...)          │  hoặc dùng vài package    │
│                                       │  chuẩn rời rạc:            │
│                                       │  container/list (DLL)      │
│                                       │  container/heap (interface)│
│                                       │  container/ring (circular) │
│                                       │  slices/maps (Go 1.21+)     │
└───────────────────────────────────────────────────────────────┘
```

**Insight quan trọng nhất:** Go buộc bạn hiểu cấu trúc dữ liệu ở tầng cơ chế, vì thư viện chuẩn cố tình tối giản. Đây là cơ hội để hiểu sâu thay vì chỉ gọi `new ArrayList<>()`.

---

## 1. Nền tảng: Generic Constraints cho DS Library

Từ Go 1.18, generics cho phép viết cấu trúc dữ liệu type-safe không cần `interface{}` + type assertion. Nhưng có vài constraint cần nắm trước khi viết code:

```go
// "any" — không ràng buộc gì, tương đương interface{}
type Stack[T any] struct { items []T }

// "comparable" — bắt buộc hỗ trợ == và != (dùng cho map key, Set, HashMap tự viết)
func Contains[T comparable](s []T, target T) bool {
    for _, v := range s {
        if v == target {
            return true
        }
    }
    return false
}

// Constraint tuỳ chỉnh cho phép so sánh thứ tự (<, >, <=, >=)
// Từ Go 1.21: dùng thẳng package "cmp" thay vì tự định nghĩa
import "cmp"

func Max[T cmp.Ordered](a, b T) T {
    if a > b {
        return a
    }
    return b
}
```

```
┌─────────────────────────────────────────────────────────┐
│  cmp.Ordered = tất cả kiểu số (int, float...) + string   │
│  KHÔNG bao gồm struct — muốn sort struct theo field phải  │
│  dùng hàm so sánh custom (xem mục Sorting bên dưới)        │
└─────────────────────────────────────────────────────────┘
```

> [!tip] Go 1.21+ đã có sẵn `slices` và `maps` package trong std lib với các hàm generic: `slices.Sort`, `slices.BinarySearch`, `slices.Contains`, `maps.Keys`, `maps.Clone`... **Luôn kiểm tra `slices`/`maps` trước khi tự viết** — bài này tự triển khai lại để dạy cơ chế bên trong, không phải để bạn bỏ qua std lib trong code production.

---

## 2. Cú Pháp Rút Gọn Go Dùng Trong Giải Thuật

Đây là phần bạn sẽ dùng liên tục khi viết DS&A. Nắm chắc mục này trước khi đọc code bên dưới.

### 2.1. Short variable declaration & multiple return

```go
// Thay vì
var i int = 0
var found bool = false

// Rút gọn
i, found := 0, false

// Multiple return — cực kỳ phổ biến trong DS&A (value, ok)
val, ok := myMap[key]        // map lookup
item, err := stack.Pop()     // custom Pop trả (T, error) hoặc (T, bool)
```

### 2.2. Swap không cần biến tạm

```go
// Java cần biến tạm
// int tmp = a; a = b; b = tmp;

// Go — tuple assignment, KHÔNG cần tmp
a, b = b, a

// Dùng trong thuật toán swap của quicksort/bubble sort:
arr[i], arr[j] = arr[j], arr[i]
```

### 2.3. Blank identifier `_`

```go
for _, v := range arr {        // bỏ qua index, chỉ lấy value
    fmt.Println(v)
}
for i := range arr {           // bỏ qua value, chỉ lấy index
    fmt.Println(i)
}
_, ok := set[key]              // chỉ cần biết tồn tại hay không, bỏ giá trị
```

### 2.4. Variadic functions — hữu ích cho constructor của DS

```go
func NewStack[T any](items ...T) *Stack[T] {
    return &Stack[T]{items: items}
}

s := NewStack(1, 2, 3)          // truyền trực tiếp
nums := []int{4, 5, 6}
s2 := NewStack(nums...)         // "spread" slice ra variadic — dấu ... bắt buộc
```

### 2.5. `append` shorthand để nối 2 slice (spread)

```go
merged := append(s1, s2...)     // nối s2 vào s1 — dùng trong merge sort, BFS frontier
```

⚠ Xem mục 5 (Lưu ý triển khai) — `append` kiểu này có thể mutate `s1` gốc nếu còn capacity, đây là trap kinh điển.

### 2.6. Labeled break/continue — bắt buộc phải biết khi viết BFS/DFS lồng nhau

```go
// Java: break với label giống hệt Go
outer:
for i := 0; i < len(grid); i++ {
    for j := 0; j < len(grid[i]); j++ {
        if grid[i][j] == target {
            break outer    // thoát CẢ HAI vòng lặp — không có label sẽ chỉ break vòng trong
        }
    }
}
```

Đây là điểm khác Java-dev hay quên: Go **không có** `break` không label thoát nhiều tầng — bạn buộc phải dùng label, không thể "break 2" như vài ngôn ngữ khác.

### 2.7. Type switch shorthand

```go
func describe(v any) string {
    switch x := v.(type) {
    case int:
        return fmt.Sprintf("int: %d", x)
    case string:
        return fmt.Sprintf("string: %s", x)
    case []int:
        return fmt.Sprintf("slice len=%d", len(x))
    default:
        return "unknown"
    }
}
```

### 2.8. Anonymous struct — dùng cho test case table-driven khi test giải thuật

```go
tests := []struct {
    input    []int
    expected int
}{
    {[]int{1, 2, 3}, 6},
    {[]int{}, 0},
}
for _, tt := range tests {
    if got := Sum(tt.input); got != tt.expected {
        t.Errorf("got %d, want %d", got, tt.expected)
    }
}
```

### 2.9. Closures làm generator / comparator rút gọn

```go
// Comparator dạng closure — dùng cho sort tuỳ biến
byAge := func(a, b Person) int { return cmp.Compare(a.Age, b.Age) }
slices.SortFunc(people, byAge)

// Closure làm "stateful iterator" đơn giản trước khi có range-over-func
func counter() func() int {
    n := 0
    return func() int { n++; return n }
}
```

### 2.10. Range-over-func iterator (Go 1.23+) — cú pháp rút gọn mới nhất cho traversal

Từ Go 1.23, bạn có thể viết hàm trả về `iter.Seq[T]` và duyệt bằng `for range` trực tiếp — rất hợp để expose traversal của cây/graph mà không cần build slice trung gian:

```go
import "iter"

func (t *BST[T]) InOrder() iter.Seq[T] {
    return func(yield func(T) bool) {
        var walk func(n *bstNode[T]) bool
        walk = func(n *bstNode[T]) bool {
            if n == nil {
                return true
            }
            if !walk(n.left) {
                return false
            }
            if !yield(n.val) {
                return false // caller đã break — dừng traversal sớm
            }
            return walk(n.right)
        }
        walk(t.root)
    }
}

// Dùng:
for v := range tree.InOrder() {
    fmt.Println(v)
    if v > 100 {
        break // break ở đây tự động gọi yield trả false, dừng đúng chỗ
    }
}
```

Đây là nâng cấp lớn so với cách cũ (trả `[]T` rồi range, hoặc dùng channel làm generator — cách dùng channel tốn 1 goroutine + có risk leak nếu caller không đọc hết).

### 2.11. `min`/`max` builtin (Go 1.21+) — khỏi viết hàm riêng cho type số cơ bản

```go
smaller := min(a, b, c)   // builtin, generic ngầm, không cần import
larger := max(a, b)
```

### 2.12. iota — rút gọn định nghĩa enum trạng thái cho giải thuật (ví dụ màu node trong graph coloring / DFS)

```go
type NodeState int
const (
    White NodeState = iota // chưa thăm — 0
    Gray                   // đang thăm (on stack) — 1
    Black                  // đã thăm xong — 2
)
```

---

## 3. Cấu Trúc Tuyến Tính: Stack, Queue, Deque, Linked List

### 3.1. Stack — dùng slice, O(1) amortized push/pop

```go
type Stack[T any] struct {
    items []T
}

func (s *Stack[T]) Push(v T) {
    s.items = append(s.items, v)
}

func (s *Stack[T]) Pop() (T, bool) {
    var zero T
    if len(s.items) == 0 {
        return zero, false
    }
    n := len(s.items) - 1
    v := s.items[n]
    s.items[n] = zero        // ⚠ quan trọng — xem mục 5.4 (tránh memory leak)
    s.items = s.items[:n]
    return v, true
}

func (s *Stack[T]) Peek() (T, bool) {
    var zero T
    if len(s.items) == 0 {
        return zero, false
    }
    return s.items[len(s.items)-1], true
}

func (s *Stack[T]) Len() int { return len(s.items) }
```

### 3.2. Queue — TRAP: dequeue từ đầu slice là O(n), không phải O(1)

```
┌────────────────────────────────────────────────────────────┐
│  s = s[1:]  → chỉ dịch con trỏ đầu, KHÔNG copy → nhìn tưởng │
│  O(1), nhưng backing array vẫn giữ toàn bộ phần tử cũ →     │
│  memory không được giải phóng, và append sau này có thể      │
│  phải copy toàn bộ phần còn lại khi cap hết.                 │
│  → Với queue dùng nhiều (BFS trên graph lớn), dùng ring      │
│  buffer hoặc container/list, ĐỪNG dùng s[1:] liên tục.       │
└────────────────────────────────────────────────────────────┘
```

```go
// Queue hiệu quả — ring buffer (circular buffer) tự viết
type Queue[T any] struct {
    items      []T
    head, tail int
    size       int
}

func NewQueue[T any](capacity int) *Queue[T] {
    return &Queue[T]{items: make([]T, capacity)}
}

func (q *Queue[T]) Enqueue(v T) {
    if q.size == len(q.items) {
        q.grow()
    }
    q.items[q.tail] = v
    q.tail = (q.tail + 1) % len(q.items)
    q.size++
}

func (q *Queue[T]) Dequeue() (T, bool) {
    var zero T
    if q.size == 0 {
        return zero, false
    }
    v := q.items[q.head]
    q.items[q.head] = zero
    q.head = (q.head + 1) % len(q.items)
    q.size--
    return v, true
}

func (q *Queue[T]) grow() {
    newCap := len(q.items) * 2
    if newCap == 0 {
        newCap = 4
    }
    newItems := make([]T, newCap)
    for i := 0; i < q.size; i++ {
        newItems[i] = q.items[(q.head+i)%len(q.items)]
    }
    q.items, q.head, q.tail = newItems, 0, q.size
}
```

> Nếu không cần tối ưu tuyệt đối, `container/list` (doubly linked list chuẩn) là lựa chọn hợp lý cho queue/deque mà không cần tự viết ring buffer — trade-off là mỗi node cấp phát heap riêng (nhiều pointer hơn → xem lại [[Bai-23-Pointers-Deep-Dive|Bài 23 mục 4]] về GC scan cost).

### 3.3. Singly Linked List — tự viết để hiểu cơ chế (production thường dùng slice hoặc `container/list`)

```go
type node[T any] struct {
    val  T
    next *node[T]
}

type LinkedList[T any] struct {
    head, tail *node[T]
    length     int
}

func (l *LinkedList[T]) PushBack(v T) {
    n := &node[T]{val: v}
    if l.tail == nil {
        l.head, l.tail = n, n
    } else {
        l.tail.next = n
        l.tail = n
    }
    l.length++
}

func (l *LinkedList[T]) PushFront(v T) {
    n := &node[T]{val: v, next: l.head}
    l.head = n
    if l.tail == nil {
        l.tail = n
    }
    l.length++
}

func (l *LinkedList[T]) PopFront() (T, bool) {
    var zero T
    if l.head == nil {
        return zero, false
    }
    v := l.head.val
    l.head = l.head.next
    if l.head == nil {
        l.tail = nil
    }
    l.length--
    return v, true
}
```

```
┌──────────────────────────────────────────────────────────┐
│  Khi nào chọn Linked List thay vì Slice trong Go?         │
│  → Gần như KHÔNG BAO GIỜ cho general-purpose use case.    │
│  Slice có cache locality tốt hơn hẳn (contiguous memory), │
│  linked list mỗi node là 1 heap allocation riêng → GC     │
│  phải scan nhiều pointer, cache miss nhiều hơn khi        │
│  traverse. Chỉ dùng linked list khi cần O(1) insert/      │
│  delete ở giữa với iterator giữ được (invalidation-safe), │
│  ví dụ LRU cache (xem Capstone mục 8).                    │
└──────────────────────────────────────────────────────────┘
```

---

## 4. Cấu Trúc Cây: Binary Search Tree

```go
type bstNode[T cmp.Ordered] struct {
    val         T
    left, right *bstNode[T]
}

type BST[T cmp.Ordered] struct {
    root *bstNode[T]
    size int
}

func (t *BST[T]) Insert(v T) {
    t.root = insert(t.root, v)
    t.size++
}

func insert[T cmp.Ordered](n *bstNode[T], v T) *bstNode[T] {
    if n == nil {
        return &bstNode[T]{val: v}
    }
    switch {
    case v < n.val:
        n.left = insert(n.left, v)
    case v > n.val:
        n.right = insert(n.right, v)
        // v == n.val: bỏ qua (không cho phép trùng) — tuỳ policy
    }
    return n
}

func (t *BST[T]) Search(v T) bool {
    n := t.root
    for n != nil {
        switch {
        case v == n.val:
            return true
        case v < n.val:
            n = n.left
        default:
            n = n.right
        }
    }
    return false
}

// Delete — trường hợp phức tạp nhất trong BST: node có 2 con
func (t *BST[T]) Delete(v T) {
    t.root = deleteNode(t.root, v)
}

func deleteNode[T cmp.Ordered](n *bstNode[T], v T) *bstNode[T] {
    if n == nil {
        return nil
    }
    switch {
    case v < n.val:
        n.left = deleteNode(n.left, v)
    case v > n.val:
        n.right = deleteNode(n.right, v)
    default:
        // Tìm thấy node cần xoá
        if n.left == nil {
            return n.right
        }
        if n.right == nil {
            return n.left
        }
        // 2 con: thay bằng successor (nhỏ nhất bên phải)
        successor := n.right
        for successor.left != nil {
            successor = successor.left
        }
        n.val = successor.val
        n.right = deleteNode(n.right, successor.val)
    }
    return n
}
```

⚠ **Lưu ý:** BST đệ quy thuần (không tự cân bằng) có thể suy biến thành linked list O(n) nếu insert theo thứ tự tăng dần — production cần AVL/Red-Black hoặc dùng B-Tree (PostgreSQL index dùng B-Tree — liên hệ [[postgresql-index-internals]]).

---

## 5. Heap / Priority Queue — dùng `container/heap`

Đây là điểm đặc biệt: **`container/heap` predate generics** và vẫn dựa trên interface `heap.Interface`, không có phiên bản generic thuần trong std lib. Bạn implement 5 method bắt buộc:

```go
import "container/heap"

type Item struct {
    Value    string
    Priority int
}

type PriorityQueue []*Item // phải là slice của pointer để heap.Fix hoạt động đúng

func (pq PriorityQueue) Len() int { return len(pq) }

func (pq PriorityQueue) Less(i, j int) bool {
    return pq[i].Priority > pq[j].Priority // ">" = max-heap, "<" = min-heap
}

func (pq PriorityQueue) Swap(i, j int) {
    pq[i], pq[j] = pq[j], pq[i]
}

func (pq *PriorityQueue) Push(x any) {
    item := x.(*Item)
    *pq = append(*pq, item)
}

func (pq *PriorityQueue) Pop() any {
    old := *pq
    n := len(old)
    item := old[n-1]
    old[n-1] = nil // tránh memory leak (giữ pointer chết)
    *pq = old[:n-1]
    return item
}

// Sử dụng
pq := &PriorityQueue{}
heap.Init(pq)
heap.Push(pq, &Item{Value: "urgent-doc", Priority: 10})
heap.Push(pq, &Item{Value: "normal-doc", Priority: 1})
top := heap.Pop(pq).(*Item) // lấy priority cao nhất
```

> Nếu muốn generic wrapper gọn hơn, bạn có thể bọc `PriorityQueue[T any]` với field `less func(a, b T) bool` truyền vào constructor — nhưng vẫn phải implement 5 method của `heap.Interface` bên dưới, generics ở đây chỉ giảm boilerplate ở tầng gọi, không thay thế được interface contract của package.

Ứng dụng PDMS: hàng đợi xử lý document theo độ ưu tiên (SLA khẩn cấp trước) — chính là mô hình `PriorityQueue` này kết hợp với worker pool.

---

## 6. Hash Table Tự Viết — Hiểu Cơ Chế Đằng Sau `map`

Go's built-in `map` dùng hash table với **separate chaining** (thực ra Go runtime dùng buckets 8-slot + overflow bucket, phức tạp hơn), nhưng để hiểu cơ chế, ta viết bản đơn giản:

```go
type entry[K comparable, V any] struct {
    key K
    val V
    next *entry[K, V]
}

type HashMap[K comparable, V any] struct {
    buckets []*entry[K, V]
    hashFn  func(K) uint64
    size    int
}

func NewHashMap[K comparable, V any](hashFn func(K) uint64) *HashMap[K, V] {
    return &HashMap[K, V]{
        buckets: make([]*entry[K, V], 16),
        hashFn:  hashFn,
    }
}

func (h *HashMap[K, V]) Put(key K, val V) {
    if float64(h.size)/float64(len(h.buckets)) > 0.75 {
        h.resize()
    }
    idx := h.hashFn(key) % uint64(len(h.buckets))
    for e := h.buckets[idx]; e != nil; e = e.next {
        if e.key == key { // đòi hỏi K là "comparable"
            e.val = val
            return
        }
    }
    h.buckets[idx] = &entry[K, V]{key: key, val: val, next: h.buckets[idx]}
    h.size++
}

func (h *HashMap[K, V]) Get(key K) (V, bool) {
    var zero V
    idx := h.hashFn(key) % uint64(len(h.buckets))
    for e := h.buckets[idx]; e != nil; e = e.next {
        if e.key == key {
            return e.val, true
        }
    }
    return zero, false
}

func (h *HashMap[K, V]) resize() {
    old := h.buckets
    h.buckets = make([]*entry[K, V], len(old)*2)
    h.size = 0
    for _, head := range old {
        for e := head; e != nil; e = e.next {
            h.Put(e.key, e.val) // rehash toàn bộ — O(n), amortized O(1) per insert
        }
    }
}
```

```
┌───────────────────────────────────────────────────────────┐
│  Vì sao Go map iteration order RANDOM có chủ đích?         │
│  → Go runtime CỐ TÌNH randomize thứ tự duyệt map (khác     │
│  Java HashMap vốn cũng không đảm bảo order nhưng không     │
│  cố tình random hoá) để dev KHÔNG BAO GIỜ viết code phụ    │
│  thuộc vào thứ tự lặp map — tránh bug ẩn khi runtime nội   │
│  bộ thay đổi cách bố trí bucket.                            │
│  → Cần thứ tự ổn định? Lấy keys ra, sort bằng slices.Sort. │
└───────────────────────────────────────────────────────────┘
```

---

## 7. Graph: Adjacency List + BFS/DFS

```go
type Graph[T comparable] struct {
    adjacency map[T][]T
}

func NewGraph[T comparable]() *Graph[T] {
    return &Graph[T]{adjacency: make(map[T][]T)}
}

func (g *Graph[T]) AddEdge(from, to T) {
    g.adjacency[from] = append(g.adjacency[from], to)
    g.adjacency[to] = append(g.adjacency[to], from) // undirected; bỏ dòng này nếu directed
}

// BFS — dùng Queue tự viết ở mục 3.2, trả thứ tự thăm
func (g *Graph[T]) BFS(start T) []T {
    visited := make(map[T]bool)
    order := make([]T, 0)
    queue := NewQueue[T](16)

    visited[start] = true
    queue.Enqueue(start)

    for queue.size > 0 {
        node, _ := queue.Dequeue()
        order = append(order, node)
        for _, neighbor := range g.adjacency[node] {
            if !visited[neighbor] {
                visited[neighbor] = true // đánh dấu NGAY khi enqueue, không phải khi dequeue
                queue.Enqueue(neighbor)
            }
        }
    }
    return order
}

// DFS — đệ quy (đơn giản, nhưng xem mục 8.1 về giới hạn stack depth)
func (g *Graph[T]) DFS(start T) []T {
    visited := make(map[T]bool)
    order := make([]T, 0)
    var walk func(node T)
    walk = func(node T) {
        visited[node] = true
        order = append(order, node)
        for _, neighbor := range g.adjacency[node] {
            if !visited[neighbor] {
                walk(neighbor)
            }
        }
    }
    walk(start)
    return order
}

// DFS iterative — dùng explicit stack, an toàn cho graph sâu (xem mục 8.1)
func (g *Graph[T]) DFSIterative(start T) []T {
    visited := make(map[T]bool)
    order := make([]T, 0)
    stack := &Stack[T]{}
    stack.Push(start)

    for stack.Len() > 0 {
        node, _ := stack.Pop()
        if visited[node] {
            continue
        }
        visited[node] = true
        order = append(order, node)
        for _, neighbor := range g.adjacency[node] {
            if !visited[neighbor] {
                stack.Push(neighbor)
            }
        }
    }
    return order
}
```

⚠ **Trap kinh điển:** đánh dấu `visited` ở BFS phải làm **ngay khi enqueue**, không phải khi dequeue — nếu đánh dấu muộn, cùng một node có thể bị enqueue nhiều lần trước khi được xử lý lần đầu, làm sai kết quả và tốn thêm bộ nhớ queue.

---

## 8. Trie (Prefix Tree) — Ứng Dụng Trực Tiếp Cho PDMS Document Search

```go
type trieNode struct {
    children map[rune]*trieNode
    isEnd    bool
}

type Trie struct {
    root *trieNode
}

func NewTrie() *Trie {
    return &Trie{root: &trieNode{children: make(map[rune]*trieNode)}}
}

func (t *Trie) Insert(word string) {
    node := t.root
    for _, ch := range word {
        if node.children[ch] == nil {
            node.children[ch] = &trieNode{children: make(map[rune]*trieNode)}
        }
        node = node.children[ch]
    }
    node.isEnd = true
}

func (t *Trie) Search(word string) bool {
    node := t.findNode(word)
    return node != nil && node.isEnd
}

// StartsWith — dùng cho autocomplete mã số hồ sơ (document code prefix search)
func (t *Trie) StartsWith(prefix string) bool {
    return t.findNode(prefix) != nil
}

func (t *Trie) findNode(s string) *trieNode {
    node := t.root
    for _, ch := range s {
        next, ok := node.children[ch]
        if !ok {
            return nil
        }
        node = next
    }
    return node
}
```

Ứng dụng thực tế PDMS: index mã số hồ sơ (document reference code) theo prefix để hỗ trợ autocomplete tìm kiếm nhanh trong UI, thay vì query `LIKE 'DOC-2026%'` trên PostgreSQL mỗi lần gõ phím (tốn round-trip DB) — Trie có thể cache trong memory cho tập mã số hot.

---

## 9. Sorting Algorithms

### 9.1. Quicksort (in-place, giáo dục — production nên dùng `slices.Sort`)

```go
func QuickSort[T cmp.Ordered](arr []T) {
    quickSort(arr, 0, len(arr)-1)
}

func quickSort[T cmp.Ordered](arr []T, low, high int) {
    if low < high {
        p := partition(arr, low, high)
        quickSort(arr, low, p-1)
        quickSort(arr, p+1, high)
    }
}

func partition[T cmp.Ordered](arr []T, low, high int) int {
    pivot := arr[high]
    i := low - 1
    for j := low; j < high; j++ {
        if arr[j] < pivot {
            i++
            arr[i], arr[j] = arr[j], arr[i] // swap rút gọn — mục 2.2
        }
    }
    arr[i+1], arr[high] = arr[high], arr[i+1]
    return i + 1
}
```

### 9.2. Merge Sort (stable, O(n log n) đảm bảo — quicksort worst-case O(n²))

```go
func MergeSort[T cmp.Ordered](arr []T) []T {
    if len(arr) <= 1 {
        return arr
    }
    mid := len(arr) / 2
    left := MergeSort(arr[:mid])
    right := MergeSort(arr[mid:])
    return merge(left, right)
}

func merge[T cmp.Ordered](left, right []T) []T {
    result := make([]T, 0, len(left)+len(right))
    i, j := 0, 0
    for i < len(left) && j < len(right) {
        if left[i] <= right[j] {
            result = append(result, left[i])
            i++
        } else {
            result = append(result, right[j])
            j++
        }
    }
    result = append(result, left[i:]...)  // append spread — mục 2.5
    result = append(result, right[j:]...)
    return result
}
```

### 9.3. Production reality: dùng `slices.Sort` / `slices.SortFunc` (Go 1.21+)

```go
import "slices"

nums := []int{5, 2, 8, 1}
slices.Sort(nums) // dùng pattern-defeating quicksort tối ưu sẵn của std lib

type Doc struct {
    Code     string
    Priority int
}
docs := []Doc{{"D1", 3}, {"D2", 1}}
slices.SortFunc(docs, func(a, b Doc) int {
    return cmp.Compare(a.Priority, b.Priority)
})
```

> **Nguyên tắc thực chiến:** viết quicksort/mergesort tay để hiểu độ phức tạp và trade-off — nhưng **không** dùng bản tự viết trong code PDMS production. `slices.Sort` đã tối ưu (introsort — hybrid quicksort/heapsort/insertion sort tuỳ kích thước) và được test kỹ hơn bất kỳ implementation tự viết nào.

---

## 10. Binary Search

```go
func BinarySearch[T cmp.Ordered](arr []T, target T) int {
    low, high := 0, len(arr)-1
    for low <= high {
        mid := low + (high-low)/2 // ⚠ không viết (low+high)/2 — có thể overflow với slice cực lớn
        switch {
        case arr[mid] == target:
            return mid
        case arr[mid] < target:
            low = mid + 1
        default:
            high = mid - 1
        }
    }
    return -1 // không tìm thấy
}

// Production: dùng slices.BinarySearch — yêu cầu slice đã sort
import "slices"
idx, found := slices.BinarySearch(sortedNums, 42)
```

⚠ **Lưu ý kinh điển:** `mid := (low + high) / 2` có thể tràn số (integer overflow) nếu `low + high` vượt giới hạn `int` — dùng `low + (high-low)/2` an toàn hơn. Với Go trên hệ 64-bit thực tế rất khó chạm ngưỡng này, nhưng đây là thói quen đúng cần giữ.

---

## 11. Lưu Ý Khi Triển Khai Logic — Pitfalls Thực Chiến

### 11.1. Go KHÔNG có tail-call optimization

```
┌────────────────────────────────────────────────────────────┐
│  Java/C++ compiler cũng thường KHÔNG tối ưu tail call theo  │
│  chuẩn, nhưng Go rõ ràng: mỗi lời gọi đệ quy = 1 stack frame│
│  mới, không có cơ chế "biến đệ quy đuôi thành vòng lặp".    │
│  Goroutine stack tự grow (bắt đầu ~2KB, tăng dần đến giới   │
│  hạn ~1GB mặc định) — nhưng đệ quy quá sâu (ví dụ DFS trên  │
│  cây/graph hàng triệu node dạng chain) VẪN có thể           │
│  stack overflow (panic: goroutine stack exceeds ...).       │
└────────────────────────────────────────────────────────────┘
```

**Hệ quả thực chiến:** `DFS` đệ quy ở mục 7 chỉ an toàn khi độ sâu graph có giới hạn hợp lý (ví dụ cây thư mục PDMS thường không sâu quá vài chục cấp). Với dữ liệu không kiểm soát được độ sâu (ví dụ traversal cấu trúc do người dùng tự tạo), **luôn ưu tiên bản iterative dùng explicit stack** (`DFSIterative` ở mục 7).

### 11.2. Slice aliasing — trap khi implement DS dùng chung backing array

```go
func BadMerge(s1, s2 []int) []int {
    return append(s1, s2...) // NGUY HIỂM nếu s1 còn cap thừa!
}

s1 := make([]int, 3, 10) // len=3, cap=10 — còn dư 7 chỗ
s2 := []int{1, 2, 3}
merged := BadMerge(s1, s2) // append GHI ĐÈ lên vùng nhớ mà s1 "tưởng" là của riêng nó
// Nếu có biến khác đang giữ s1[3:10] (dù chưa dùng), dữ liệu của nó vừa bị merged ghi đè
```

Trong toàn bộ code DS&A ở bài này (merge sort, queue grow, BFS order), luôn kiểm tra: slice trả về có share backing array với slice đầu vào không? Nếu không chắc, dùng `make` + `copy` tường minh thay vì tin vào `append`.

### 11.3. Generic zero value — pattern bắt buộc cho Pop/Dequeue

```go
func (s *Stack[T]) Pop() (T, bool) {
    var zero T          // KHÔNG thể viết "return nil, false" cho generic T
    if len(s.items) == 0 {
        return zero, false
    }
    // ...
}
```

Khác Java (nơi bạn có thể return `null` cho bất kỳ generic reference type nào), Go generic `T` có thể là value type (int, struct) — `var zero T` là cách duy nhất lấy zero value đúng cho MỌI T, dùng nhất quán trong toàn bộ DS library.

### 11.4. Giữ pointer chết trong slice sau khi Pop = memory leak tiềm ẩn

```go
// Nếu KHÔNG set s.items[n] = zero trước khi cắt slice:
s.items = s.items[:n] // phần tử ở index n vẫn nằm trong backing array,
                       // GC KHÔNG thu hồi được nếu T là pointer/struct chứa pointer,
                       // vì backing array vẫn "reachable" qua slice header cũ
```

Đây là lý do `Pop()` và `heap.Pop()` ở mục 5 đều gán zero/`nil` cho ô vừa bỏ trước khi cắt slice — thói quen bắt buộc khi struct chứa pointer, slice, map, hoặc string lớn.

### 11.5. `comparable` không cho phép so sánh thứ tự (`<`, `>`)

```go
func Contains[T comparable](s []T, v T) bool { ... } // == OK
func Max[T comparable](a, b T) T {
    return a > b ? a : b // ❌ compile error — comparable không có >
}
// Phải dùng cmp.Ordered (chỉ áp dụng cho kiểu số + string) hoặc constraint custom
```

### 11.6. Copy struct chứa slice/map = shallow copy, không phải deep copy

```go
type TreeNode[T any] struct {
    Val      T
    Children []*TreeNode[T]
}

original := TreeNode[string]{Val: "root", Children: []*TreeNode[string]{{Val: "child"}}}
cloned := original // copy struct, NHƯNG Children (slice of pointer) vẫn trỏ chung
cloned.Children[0].Val = "modified" // original.Children[0].Val CŨNG bị đổi!
```

Muốn clone thật sự cây/graph, phải viết hàm `DeepClone` đệ quy tường minh — Go không có cơ chế deep copy tự động (khác Java's tuỳ chọn `clone()` hay serialization-based deep copy).

### 11.7. Benchmark trước khi chọn giải thuật, đừng tin Big-O suông

```go
func BenchmarkQuickSort(b *testing.B) {
    for i := 0; i < b.N; i++ {
        data := generateRandomSlice(1000)
        QuickSort(data)
    }
}
```

Với slice nhỏ (< 20-30 phần tử), insertion sort O(n²) thường **nhanh hơn** quicksort O(n log n) trong thực tế vì overhead của đệ quy + branch prediction — đây chính là lý do `slices.Sort` của std lib dùng **hybrid algorithm** (chuyển sang insertion sort khi partition đủ nhỏ). Đừng tự đánh giá giải thuật chỉ bằng độ phức tạp lý thuyết — luôn benchmark (`testing.B` + `go test -bench=. -benchmem`) trên kích thước dữ liệu thật của PDMS.

---

## 12. Capstone: LRU Cache — HashMap + Doubly Linked List

Bài toán DS&A kinh điển nhất và cũng thực chiến nhất — kết hợp mọi kỹ thuật ở trên, liên hệ trực tiếp [[Bai-20-Redis-Caching|Bài 20: Redis Caching]] (LRU là chính sách eviction phổ biến của Redis, nhưng đây là bản in-memory tự viết cho local cache layer):

```go
type lruNode[K comparable, V any] struct {
    key        K
    val        V
    prev, next *lruNode[K, V]
}

type LRUCache[K comparable, V any] struct {
    capacity   int
    items      map[K]*lruNode[K, V]
    head, tail *lruNode[K, V] // head = most recently used, tail = least recently used
}

func NewLRUCache[K comparable, V any](capacity int) *LRUCache[K, V] {
    head := &lruNode[K, V]{}
    tail := &lruNode[K, V]{}
    head.next = tail
    tail.prev = head
    return &LRUCache[K, V]{
        capacity: capacity,
        items:    make(map[K]*lruNode[K, V]),
        head:     head,
        tail:     tail,
    }
}

func (c *LRUCache[K, V]) Get(key K) (V, bool) {
    var zero V
    node, ok := c.items[key]
    if !ok {
        return zero, false
    }
    c.moveToFront(node)
    return node.val, true
}

func (c *LRUCache[K, V]) Put(key K, val V) {
    if node, ok := c.items[key]; ok {
        node.val = val
        c.moveToFront(node)
        return
    }
    if len(c.items) >= c.capacity {
        c.evictLRU()
    }
    node := &lruNode[K, V]{key: key, val: val}
    c.items[key] = node
    c.addToFront(node)
}

func (c *LRUCache[K, V]) moveToFront(n *lruNode[K, V]) {
    c.remove(n)
    c.addToFront(n)
}

func (c *LRUCache[K, V]) addToFront(n *lruNode[K, V]) {
    n.next = c.head.next
    n.prev = c.head
    c.head.next.prev = n
    c.head.next = n
}

func (c *LRUCache[K, V]) remove(n *lruNode[K, V]) {
    n.prev.next = n.next
    n.next.prev = n.prev
}

func (c *LRUCache[K, V]) evictLRU() {
    lru := c.tail.prev
    c.remove(lru)
    delete(c.items, lru.key)
}
```

```
┌──────────────────────────────────────────────────────────┐
│  Vì sao phải kết hợp Map + Doubly Linked List?             │
│  Map: Get/Put theo key trong O(1)                          │
│  Doubly Linked List: move-to-front và evict-tail O(1)      │
│  → Chỉ dùng riêng 1 trong 2 sẽ không đạt O(1) cho cả 2 thao │
│  tác (chỉ slice → O(n) tìm vị trí; chỉ map → không có thứ  │
│  tự "recently used" để evict đúng)                          │
└──────────────────────────────────────────────────────────┘
```

⚠ Lưu ý concurrency: implementation trên **không thread-safe**. Dùng trong PDMS đa goroutine cần bọc `sync.Mutex` (xem lại [[Bai-23-Pointers-Deep-Dive|Bài 23 mục 5]] — struct chứa mutex luôn dùng pointer receiver, không bao giờ copy).

---

## 13. Complexity Cheat Sheet

```
┌────────────────────┬───────────┬───────────┬───────────┬─────────────┐
│  Cấu trúc           │  Access   │  Search   │  Insert   │  Delete     │
├────────────────────┼───────────┼───────────┼───────────┼─────────────┤
│  Slice (unsorted)   │  O(1)     │  O(n)     │  O(1)*    │  O(n)       │
│  Sorted slice       │  O(1)     │  O(log n) │  O(n)     │  O(n)       │
│  Linked List        │  O(n)     │  O(n)     │  O(1)†    │  O(1)†      │
│  Hash Map           │  —        │  O(1) avg │  O(1) avg │  O(1) avg   │
│  BST (không cân bằng)│  —       │  O(n) worst/O(log n) avg│           │
│  Heap               │  —        │  O(n)     │  O(log n) │  O(log n)   │
│  Trie               │  —        │  O(m)‡    │  O(m)‡    │  O(m)‡      │
└────────────────────┴───────────┴───────────┴───────────┴─────────────┘
* amortized, có thể trigger resize O(n) occasionally
† nếu đã có con trỏ tới node, không tính thời gian tìm node
‡ m = độ dài chuỗi, không phụ thuộc số lượng entry

┌────────────────────┬─────────────┬───────────┬─────────────────────┐
│  Sort               │  Best       │  Worst    │  Ghi chú             │
├────────────────────┼─────────────┼───────────┼─────────────────────┤
│  Quicksort          │  O(n log n) │  O(n²)    │  In-place, unstable  │
│  Merge sort         │  O(n log n) │  O(n log n)│ Stable, O(n) space  │
│  slices.Sort (1.21+)│  —          │  O(n log n)│ Hybrid, tối ưu sẵn  │
└────────────────────┴─────────────┴───────────┴─────────────────────┘
```

---

## 14. Tổng Kết Bài 32

```
┌───────────────────────────────────────────────────────────┐
│                    KEY TAKEAWAYS                            │
├───────────────────────────────────────────────────────────┤
│  ✅ Go không có Collections Framework — bạn tự viết DS hoặc │
│     dùng container/list, container/heap, slices/maps        │
│  ✅ cmp.Ordered (Go 1.21+) thay thế constraint tự định nghĩa │
│     cho phép so sánh thứ tự trong generic function           │
│  ✅ Cú pháp rút gọn (tuple assign, blank identifier,         │
│     labeled break, range-over-func) giúp code DS&A gọn hơn   │
│     hẳn so với style Java tương đương                         │
│  ✅ container/heap vẫn dựa trên interface, KHÔNG generic —   │
│     một trong số ít chỗ generics chưa "phủ" hết std lib       │
│  ✅ Không có tail-call optimization — đệ quy sâu không kiểm  │
│     soát được độ sâu PHẢI viết lại dạng iterative             │
│  ✅ Slice aliasing (append, sub-slice) là nguồn bug tinh vi   │
│     nhất khi implement DS — luôn xác định slice có share      │
│     backing array hay không                                   │
│  ✅ var zero T là pattern bắt buộc cho generic Pop/Dequeue —  │
│     Go không có "return nil" chung cho mọi generic type        │
│  ✅ LRU Cache (Map + Doubly Linked List) là bài tổng hợp kinh  │
│     điển nhất, áp dụng trực tiếp được cho cache layer PDMS     │
│  ✅ Luôn benchmark trước khi chọn giải thuật — Big-O lý thuyết │
│     không phản ánh đầy đủ chi phí thực (GC, cache locality,    │
│     escape analysis)                                            │
└───────────────────────────────────────────────────────────┘
```

**Xem lại:** [[Bai-2-Syntax-Types-Structs|Bài 2 mục 6]] (Generics cơ bản), [[Bai-23-Pointers-Deep-Dive|Bài 23]] (pointer, escape analysis, GC scan cost — nền tảng để hiểu trade-off Linked List vs Slice)
**Liên quan:** [[Bai-20-Redis-Caching|Bài 20: Redis Caching]] (LRU policy thực tế ở tầng distributed cache), [[postgresql-index-internals]] (B-Tree — họ hàng của BST trong bài này), [[probabilistic-data-structures]] (Bloom Filter, HyperLogLog — DS xác suất, hướng đi tiếp theo sau bài này)
**Bài tiếp theo gợi ý:** Viết Bloom Filter tự implement cho PDMS (kiểm tra nhanh "mã hồ sơ có khả năng đã tồn tại" trước khi query PostgreSQL — giảm tải DB cho check trùng lặp tần suất cao).

---

**Bài tập:**

1. Viết `Deque[T]` (double-ended queue) hỗ trợ `PushFront`, `PushBack`, `PopFront`, `PopBack` đều O(1) — dùng ring buffer như `Queue[T]` ở mục 3.2.
2. Chuyển `BST[T]` ở mục 4 thành AVL Tree (tự cân bằng) — thêm rotation logic, so sánh thời gian Search giữa BST thường và AVL trên dữ liệu insert theo thứ tự tăng dần (worst case cho BST thường).
3. Viết benchmark so sánh `Queue[T]` (ring buffer tự viết ở mục 3.2) vs dùng slice với `s = s[1:]` liên tục — đo cả throughput và memory allocation (`go test -bench=. -benchmem`) trên 100k phần tử.
4. Thêm `sync.RWMutex` vào `LRUCache[K,V]` ở mục 12 để thread-safe, viết test với nhiều goroutine gọi `Get`/`Put` đồng thời (`go test -race`).
5. Implement `Graph[T].TopologicalSort()` dùng DFS — xử lý use case: thứ tự phê duyệt hồ sơ khi có dependency giữa các loại tài liệu trong PDMS.

---
*Tags: #go #data-structures #algorithms #generics #zero-to-hero*
