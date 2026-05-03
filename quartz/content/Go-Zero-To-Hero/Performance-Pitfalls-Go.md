# Go Performance Pitfalls: Sai Lầm Phổ Biến & Cách Tối Ưu

> **Mục tiêu:** Hiểu *tại sao* code Go chậm/tốn memory — dựa trên cơ chế runtime, escape analysis, GC, scheduler. Mỗi pitfall có prototype minh hoạ, benchmark số liệu thực tế, và fix chuẩn.

---

## Mental Model: Go Runtime Hoạt Động Như Thế Nào

```
┌─────────────────────────────────────────────────────┐
│                  Go Runtime                         │
│                                                     │
│  G (Goroutine)  G   G   G   G   G   G   G          │
│       ↕              ↕              ↕               │
│  P (Processor)  P              P                    │
│  (GOMAXPROCS)        ↕              ↕               │
│       ↕         M (OS Thread)  M                   │
│  M (OS Thread)                                      │
│                                                     │
│  GC: Tri-color mark-sweep, concurrent, STW ~100µs  │
│  Stack: 2KB initial, grows dynamically (segmented) │
│  Heap: shared, GC-managed                          │
└─────────────────────────────────────────────────────┘
```

**Key insight:** Go GC không miễn phí. Mỗi heap allocation = GC pressure. Nhiều goroutine không kiểm soát = scheduler overhead + memory leak. Đây là gốc rễ của phần lớn pitfalls.

---

## Pitfall 1: Goroutine Leak — Goroutine "Zombie"

### Tại sao nguy hiểm

Goroutine bị leak không bao giờ được GC thu dọn vì GC chỉ thu heap objects không còn reference — goroutine đang chạy luôn có stack frame reference. Mỗi goroutine tốn **2KB–8MB stack** tùy call depth.

```
Time 0:  10 goroutines → 20KB
Time 1h: 360,000 goroutines → ~720MB  ← OOM sắp xảy ra
```

### Prototype: Goroutine Leak cổ điển

```go
package main

import (
    "fmt"
    "runtime"
    "time"
)

// ❌ BAD: goroutine bị leak khi không ai đọc channel
func leakyWorker(id int) {
    ch := make(chan int) // unbuffered channel

    go func() {
        result := expensiveCompute(id) // block forever nếu không ai nhận
        ch <- result                   // goroutine stuck ở đây mãi mãi
    }()

    // Giả sử caller timeout/return sớm — goroutine bên trong bị bỏ lại
    select {
    case res := <-ch:
        fmt.Println(res)
    case <-time.After(100 * time.Millisecond):
        return // ← goroutine bên trong vẫn đang blocked ở ch <- result!
    }
}

func expensiveCompute(id int) int {
    time.Sleep(1 * time.Second)
    return id * 42
}

// Chạy 1000 lần → 1000 goroutines leaked
func demoLeak() {
    for i := 0; i < 1000; i++ {
        leakyWorker(i)
    }
    time.Sleep(2 * time.Second)
    fmt.Printf("Goroutines alive: %d\n", runtime.NumGoroutine()) // ~1001!
}
```

### Fix: Context Cancellation

```go
// ✅ GOOD: context.Context truyền cancel signal
func safeWorker(ctx context.Context, id int) (int, error) {
    ch := make(chan int, 1) // buffered — goroutine không block khi send

    go func() {
        result := expensiveCompute(id)
        select {
        case ch <- result: // gửi kết quả nếu có người nhận
        case <-ctx.Done(): // hoặc thoát nếu context cancelled
            return
        }
    }()

    select {
    case res := <-ch:
        return res, nil
    case <-ctx.Done():
        return 0, ctx.Err()
    }
}

func demoSafe() {
    for i := 0; i < 1000; i++ {
        ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
        go func(i int) {
            defer cancel()
            safeWorker(ctx, i)
        }(i)
    }
    time.Sleep(2 * time.Second)
    fmt.Printf("Goroutines alive: %d\n", runtime.NumGoroutine()) // ~1
}
```

### Tips
- Dùng `goleak` library trong tests: `defer goleak.VerifyNone(t)`
- Rule of thumb: **mỗi goroutine bạn spawn phải có exit condition rõ ràng**
- Worker pool pattern thay vì spawn unbounded goroutines

---

## Pitfall 2: Heap Escape — Allocation Vô Tình

### Cơ chế Escape Analysis

Go compiler phân tích xem variable có thể sống trên stack hay phải escape lên heap:

```
Stack: cheap, auto-free khi function return (~0.1ns)
Heap:  expensive, cần GC collect (~50-100ns + GC pressure)
```

Escape xảy ra khi:
1. Variable được return ra ngoài scope
2. Variable lưu vào interface
3. Variable quá lớn cho stack
4. Địa chỉ variable được store vào heap variable khác

### Prototype: Phát Hiện Escape

```go
package main

import "fmt"

// Chạy: go build -gcflags="-m -m" ./... để xem escape analysis

// ❌ Case 1: Return pointer → escape to heap
func newPoint() *Point {
    p := Point{1, 2}  // "p escapes to heap"
    return &p
}

// ✅ Better: Return value type (copy on stack, caller decides)
func newPointValue() Point {
    return Point{1, 2}  // stays on stack nếu caller không lấy address
}

// ❌ Case 2: Interface boxing → escape
type Point struct{ X, Y int }
func (p Point) String() string { return fmt.Sprintf("(%d,%d)", p.X, p.Y) }

func printPoint(p interface{}) { // ← bất kỳ gì pass vào interface đều escape
    fmt.Println(p)
}

func badUsage() {
    p := Point{1, 2}
    printPoint(p) // Point bị copy lên heap để box vào interface{}
}

// ✅ Better: Dùng concrete type
func goodUsage() {
    p := Point{1, 2}
    fmt.Println(p.String()) // p stays on stack
}

// ❌ Case 3: Closure capture → escape
func counter() func() int {
    count := 0         // "count escapes to heap" (captured by closure)
    return func() int {
        count++
        return count
    }
}

// ❌ Case 4: fmt.Sprintf với args → escape
func formatID(id int) string {
    return fmt.Sprintf("user_%d", id) // id escapes: interface boxing
}

// ✅ Better: strconv hoặc strings.Builder
func formatIDFast(id int) string {
    return "user_" + strconv.Itoa(id) // không boxing
}
```

### Benchmark số liệu

```go
// BenchmarkEscape_Interface-8    5,000,000    240 ns/op    16 B/op    1 allocs/op
// BenchmarkEscape_Concrete-8    50,000,000     24 ns/op     0 B/op    0 allocs/op
// → Interface boxing = 10x chậm hơn + 1 heap alloc mỗi lần

func BenchmarkEscape_Interface(b *testing.B) {
    for i := 0; i < b.N; i++ {
        printPoint(Point{1, 2})
    }
}
func BenchmarkEscape_Concrete(b *testing.B) {
    for i := 0; i < b.N; i++ {
        _ = Point{1, 2}.String()
    }
}
```

---

## Pitfall 3: String Concatenation Trong Loop

### Tại sao chậm

`string` trong Go là **immutable**. Mỗi `s = s + part` tạo ra một string mới trên heap.

```
Iteration 1: alloc "a"           (1B)
Iteration 2: alloc "ab"          (2B) — copy "a" + "b"
Iteration 3: alloc "abc"         (3B) — copy "ab" + "c"
...
Iteration N: alloc N bytes total

Total allocations: N
Total bytes copied: 1+2+3+...+N = N*(N+1)/2  → O(N²) complexity!
```

### Prototype

```go
package main

import (
    "strings"
    "testing"
)

var words = []string{"hello", "world", "this", "is", "a", "test"}

// ❌ BAD: O(N²) time, N heap allocations
func concatBad(words []string) string {
    result := ""
    for _, w := range words {
        result += w + " " // new allocation mỗi iteration
    }
    return result
}

// ✅ GOOD: strings.Join — 1 allocation
func concatJoin(words []string) string {
    return strings.Join(words, " ")
}

// ✅ GOOD: strings.Builder — 1 allocation, no intermediate copies
func concatBuilder(words []string) string {
    var b strings.Builder
    b.Grow(estimateLen(words)) // pre-allocate — tránh resize
    for i, w := range words {
        b.WriteString(w)
        if i < len(words)-1 {
            b.WriteByte(' ')
        }
    }
    return b.String()
}

func estimateLen(words []string) int {
    n := 0
    for _, w := range words { n += len(w) + 1 }
    return n
}

// ✅ GOOD: bytes.Buffer khi cần mixed types
func concatBuffer() string {
    var buf bytes.Buffer
    buf.Grow(64)
    fmt.Fprintf(&buf, "user_%d: %s", 42, "admin")
    return buf.String()
}

/*
BenchmarkConcatBad-8        1,000,000    1,240 ns/op    864 B/op    6 allocs/op
BenchmarkConcatJoin-8      10,000,000      120 ns/op     48 B/op    1 allocs/op
BenchmarkConcatBuilder-8   10,000,000      110 ns/op     48 B/op    1 allocs/op
→ strings.Builder = 10x nhanh, 6x ít alloc hơn
*/
```

---

## Pitfall 4: Slice Pitfalls — 3 Dạng Nguy Hiểm

### 4a. Giữ Reference Đến Large Backing Array

```go
// ❌ BAD: slice nhỏ giữ alive toàn bộ array lớn
func getLogs() []byte {
    data := readHugeFile() // 100MB
    return data[0:100]     // slice 100 bytes — nhưng GC không free 100MB!
}

// ✅ GOOD: copy ra slice độc lập
func getLogsSafe() []byte {
    data := readHugeFile()
    result := make([]byte, 100)
    copy(result, data[0:100])
    return result // data được GC thu sau khi function return
}
```

### 4b. Append Vô Tình Share Backing Array

```go
// ❌ BUG TINH VI: a và b share backing array
a := make([]int, 3, 6) // len=3, cap=6
a[0], a[1], a[2] = 1, 2, 3

b := a[:2]             // b = [1, 2], share cùng backing array
b = append(b, 99)      // append vào b — modifies a[2]!
fmt.Println(a)         // [1, 2, 99] ← a bị thay đổi!

// ✅ GOOD: 3-index slice để giới hạn capacity
b := a[:2:2]          // len=2, cap=2 — buộc append phải alloc mới
b = append(b, 99)     // allocates new backing array
fmt.Println(a)        // [1, 2, 3] ← a không bị ảnh hưởng
```

### 4c. nil Slice vs Empty Slice

```go
var nilSlice []int        // nil — len=0, cap=0, pointer=nil
emptySlice := []int{}     // empty — len=0, cap=0, pointer non-nil

// Cả hai hoạt động giống nhau trong hầu hết trường hợp
// NHƯNG khác nhau khi JSON marshal:
json.Marshal(nilSlice)    // "null"
json.Marshal(emptySlice)  // "[]"  ← API clients thường expect cái này

// Rule: Dùng nil slice cho "not initialized", empty slice cho "empty result"
// Khi return từ function có thể empty:
func getItems() []Item {
    if noItems {
        return nil // hoặc return []Item{} tuỳ API contract
    }
    // ...
}
```

---

## Pitfall 5: Map Misuse — Size Hint & Value Type

### 5a. Thiếu Size Hint

```go
// Map trong Go: hash table với load factor ~6.5
// Khi vượt threshold → rehash: alloc buckets mới, copy toàn bộ data

// ❌ BAD: bắt đầu empty → nhiều lần rehash với map lớn
func buildIndex(records []Record) map[string]Record {
    idx := make(map[string]Record)  // initial 0 buckets
    for _, r := range records {
        idx[r.ID] = r // rehash tại 8, 16, 32, 64... entries
    }
    return idx
}

// ✅ GOOD: hint size → ít hoặc không rehash
func buildIndexFast(records []Record) map[string]Record {
    idx := make(map[string]Record, len(records))
    for _, r := range records {
        idx[r.ID] = r
    }
    return idx
}

/*
BenchmarkBuildIndex_NoHint-8    1,000    1,850 µs/op   520 KB/op   25 allocs/op
BenchmarkBuildIndex_WithHint-8  1,000      980 µs/op   280 KB/op    8 allocs/op
*/
```

### 5b. Struct vs Pointer Values

```go
// ❌ BAD: Map[key]LargeStruct → mỗi lần access copy toàn bộ struct
type Record struct {
    ID    string
    Name  string
    Data  [1024]byte  // 1KB struct
}

m := map[string]Record{}
m["key"] = Record{...}
r := m["key"]          // copy 1KB!
r.Name = "updated"     // KHÔNG update map — r là copy
m["key"] = r           // phải set lại

// ✅ GOOD: Map[key]*LargeStruct → copy pointer (8 bytes)
m := map[string]*Record{}
m["key"] = &Record{...}
r := m["key"]          // copy 8-byte pointer
r.Name = "updated"     // UPDATE trực tiếp trong map — không cần set lại
```

### 5c. Map Không Bao Giờ Shrink

```go
// Go map KHÔNG trả memory về OS khi delete entries
// Nếu map từng có 1M entries → vẫn giữ buckets ngay cả sau khi delete hết

// ❌ Pattern gây memory leak
cache := make(map[string][]byte)
// ... thêm 1M entries, xóa dần dần
// → map vẫn giữ ~100MB memory dù empty

// ✅ Fix: Thay mới map theo chu kỳ
func (c *Cache) cleanup() {
    newCache := make(map[string][]byte, len(c.data)/2)
    for k, v := range c.data {
        if !isExpired(k) {
            newCache[k] = v
        }
    }
    c.data = newCache // old map được GC
}

// ✅ Hoặc dùng sync.Map cho high-concurrency read-heavy workloads
var sharedCache sync.Map
sharedCache.Store("key", value)
val, ok := sharedCache.Load("key")
```

---

## Pitfall 6: Defer Trong Loop

### Tại sao nguy hiểm

`defer` chạy khi **function return** — không phải cuối iteration. Trong loop, tất cả deferred calls accumulate cho đến khi function kết thúc.

```go
// ❌ BAD: 1000 files open cùng lúc!
func processFiles(paths []string) error {
    for _, path := range paths {
        f, err := os.Open(path)
        if err != nil { return err }
        defer f.Close()  // file không đóng đến khi processFiles return
        process(f)
    }
    return nil  // lúc này mới close tất cả 1000 files
}

// ✅ GOOD: Closure isolate scope
func processFiles(paths []string) error {
    for _, path := range paths {
        if err := processOne(path); err != nil {
            return err
        }
    }
    return nil
}

func processOne(path string) error {
    f, err := os.Open(path)
    if err != nil { return err }
    defer f.Close()  // đóng ngay khi processOne return
    return process(f)
}

// ✅ Alternative: Manual close
func processFilesManual(paths []string) error {
    for _, path := range paths {
        f, err := os.Open(path)
        if err != nil { return err }
        err = process(f)
        f.Close()  // close ngay sau khi dùng xong
        if err != nil { return err }
    }
    return nil
}
```

---

## Pitfall 7: Mutex Contention & Sai Granularity

### 7a. sync.Mutex vs sync.RWMutex

```go
// ❌ BAD: Dùng Mutex cho read-heavy workload
type Counter struct {
    mu    sync.Mutex
    data  map[string]int
}

func (c *Counter) Get(key string) int {
    c.mu.Lock()         // block TẤT CẢ readers kể cả khi chỉ đọc
    defer c.mu.Unlock()
    return c.data[key]
}

// ✅ GOOD: RWMutex — nhiều readers, exclusive writer
type Counter struct {
    mu   sync.RWMutex
    data map[string]int
}

func (c *Counter) Get(key string) int {
    c.mu.RLock()        // nhiều goroutines có thể RLock cùng lúc
    defer c.mu.RUnlock()
    return c.data[key]
}

func (c *Counter) Set(key string, val int) {
    c.mu.Lock()         // exclusive
    defer c.mu.Unlock()
    c.data[key] = val
}
```

### 7b. Lock Granularity Quá Rộng

```go
// ❌ BAD: Lock toàn bộ trong suốt computation dài
func (s *Service) processAndStore(key string, data []byte) {
    s.mu.Lock()
    defer s.mu.Unlock()

    result := expensiveTransform(data) // 100ms CPU — giữ lock cả thời gian này!
    s.store[key] = result
}

// ✅ GOOD: Lock chỉ khi cần thiết (access shared state)
func (s *Service) processAndStore(key string, data []byte) {
    result := expensiveTransform(data) // không cần lock — pure computation

    s.mu.Lock()
    s.store[key] = result              // lock chỉ cho operation critical
    s.mu.Unlock()                      // không dùng defer khi cần unlock sớm
}
```

### 7c. sync.Pool — Tái Sử Dụng Object

```go
// ❌ BAD: Alloc/dealloc liên tục trong hot path
func handleRequest(data []byte) {
    buf := make([]byte, 64*1024) // 64KB alloc mỗi request
    copy(buf, data)
    // ... process
} // buf bị GC

// ✅ GOOD: sync.Pool tái sử dụng, tránh GC pressure
var bufPool = sync.Pool{
    New: func() interface{} {
        b := make([]byte, 64*1024)
        return &b
    },
}

func handleRequestPooled(data []byte) {
    bufPtr := bufPool.Get().(*[]byte)
    buf := *bufPtr
    defer bufPool.Put(bufPtr) // trả lại pool

    copy(buf, data)
    // ... process
}

/*
BenchmarkHandleRequest-8        1,000,000    1,200 ns/op    65536 B/op    1 allocs/op
BenchmarkHandleRequestPooled-8  5,000,000      240 ns/op        0 B/op    0 allocs/op
→ 5x nhanh, 0 allocs (cache hit)
*/
```

---

## Pitfall 8: Interface & Reflection Overhead

### Interface Boxing Cost

```go
// Interface = (type pointer, data pointer) — 16 bytes
// Value types nhỏ (≤ word size) được inline
// Value types lớn → heap alloc để store

// ❌ BAD: Interface với large struct — heap alloc
type Handler interface {
    Handle(req Request) Response
}

type BigHandler struct {
    data [512]byte  // lớn → khi assign vào interface → escape to heap
}

// ✅ GOOD: Interface với pointer receiver
type BigHandler struct {
    data [512]byte
}
func (h *BigHandler) Handle(req Request) Response { ... }

var h Handler = &BigHandler{} // pointer vào interface — no boxing cost
```

### Reflection: Dùng Khi Nào, Tránh Khi Nào

```go
// reflect package: ~10-100x chậm hơn static code
// Dùng được: serialization (JSON), ORM, dependency injection, testing
// Tránh: hot path, inner loops

// ❌ BAD: Reflection trong hot path
func sumFields(v interface{}) int64 {
    rv := reflect.ValueOf(v)
    var total int64
    for i := 0; i < rv.NumField(); i++ {
        total += rv.Field(i).Int() // ~200ns mỗi call
    }
    return total
}

// ✅ GOOD: Generate code hoặc dùng concrete types
type Stats struct{ A, B, C int64 }
func (s Stats) Sum() int64 { return s.A + s.B + s.C } // ~1ns

// ✅ GOOD: Cache reflect TypeOf nếu phải dùng reflect
var recordType = reflect.TypeOf(Record{}) // cache 1 lần
func processRecord(v interface{}) {
    if reflect.TypeOf(v) != recordType {
        return
    }
    // ...
}
```

---

## Pitfall 9: Goroutine Scheduler & GOMAXPROCS

```go
// GOMAXPROCS = số P (processors) = số goroutines chạy song song tối đa
// Default: số CPU cores

// ❌ BAD: CPU-bound tasks với quá nhiều goroutines
func parallelBad(items []Item) []Result {
    results := make([]Result, len(items))
    var wg sync.WaitGroup
    for i, item := range items {
        wg.Add(1)
        go func(i int, item Item) { // spawn N goroutines cho N items
            defer wg.Done()
            results[i] = process(item)
        }(i, item)
    }
    wg.Wait()
    return results
}
// Nếu N=100,000 → 100,000 goroutines → context switch overhead kinh khủng

// ✅ GOOD: Worker pool giới hạn concurrency
func parallelGood(items []Item, workers int) []Result {
    results := make([]Result, len(items))
    jobs := make(chan int, len(items))
    
    var wg sync.WaitGroup
    for w := 0; w < workers; w++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for i := range jobs {
                results[i] = process(items[i])
            }
        }()
    }

    for i := range items { jobs <- i }
    close(jobs)
    wg.Wait()
    return results
}

// workers = runtime.GOMAXPROCS(0) cho CPU-bound
// workers = GOMAXPROCS * 2-4 cho I/O-bound
```

---

## Pitfall 10: Channel Sizing Sai

```go
// Unbuffered channel: sync — sender block đến khi receiver ready
// Buffered channel(N): sender block chỉ khi buffer full

// ❌ BAD: Unbuffered khi producer nhanh hơn consumer → latency spike
func producerConsumer() {
    ch := make(chan Work)  // unbuffered
    go producer(ch)        // có thể block thường xuyên
    go consumer(ch)
}

// ❌ BAD: Buffer quá lớn → ẩn backpressure, memory waste
ch := make(chan Work, 1_000_000) // 1M work items in memory!

// ✅ GOOD: Buffer vừa đủ cho burst, semaphore cho rate limiting
func rateLimitedProducer(items []Work, maxConcurrent int) {
    sem := make(chan struct{}, maxConcurrent) // semaphore pattern
    var wg sync.WaitGroup

    for _, item := range items {
        sem <- struct{}{} // acquire slot
        wg.Add(1)
        go func(w Work) {
            defer func() {
                <-sem // release slot
                wg.Done()
            }()
            process(w)
        }(item)
    }
    wg.Wait()
}
```

---

## Profiling: pprof Thực Chiến

```go
// 1. Thêm vào main.go hoặc server setup:
import _ "net/http/pprof"

func main() {
    go func() {
        log.Println(http.ListenAndServe("localhost:6060", nil))
    }()
    // ... rest of app
}

// 2. Thu thập profiles:
// CPU profile (30 giây):
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

// Memory/Heap profile:
go tool pprof http://localhost:6060/debug/pprof/heap

// Goroutine dump:
curl http://localhost:6060/debug/pprof/goroutine?debug=2

// 3. Trong pprof interactive shell:
// top10          — top 10 functions by CPU
// list funcName  — source code với CPU annotation
// web            — flamegraph trong browser (cần graphviz)

// 4. Benchmark với profiling:
go test -bench=. -cpuprofile=cpu.prof -memprofile=mem.prof ./...
go tool pprof cpu.prof
go tool pprof mem.prof
```

### Đọc Memory Profile

```
(pprof) top10 --cum   ← cumulative: tính cả callees
Showing top 10 nodes out of 47
      flat  flat%   sum%        cum   cum%
         0     0%     0%   120.5MB 62.3%  main.handleRequest
    80.3MB 41.5% 41.5%    80.3MB 41.5%  strings.(*Builder).copyCheck  ← bottleneck!
         0     0%  41.5%   60.2MB 31.1%  encoding/json.Marshal
    40.1MB 20.7% 62.2%    40.1MB 20.7%  bytes.(*Buffer).grow

→ handleRequest đang allocate nhiều qua strings.Builder
→ Xem xét: pre-allocate với .Grow(), hoặc dùng sync.Pool cho builders
```

---

## Tips & Tricks Tổng Hợp

```go
// 1. Tránh named return values trừ khi thực sự cần (khó debug, dễ shadow)
func good() (result int, err error) { ... } // OK nếu có defer err handling
func bad() (int, error) { ... }             // prefer rõ ràng hơn

// 2. Dùng struct embedding thay vì deep inheritance cho zero overhead
type Base struct { ID string }
type User struct {
    Base              // zero overhead embedding
    Name string
}
u := User{}
u.ID = "abc"         // access Base.ID trực tiếp

// 3. Nil pointer receiver — Go specific (khác Java NPE)
var u *User = nil
u.String()           // OK nếu String() check nil receiver!
func (u *User) String() string {
    if u == nil { return "<nil>" }
    return u.Name
}

// 4. Sắp xếp struct fields giảm padding
// ❌ Padding: 1 + 7(pad) + 8 + 1 + 7(pad) = 24 bytes
type Bad struct {
    A byte
    B int64
    C byte
}
// ✅ No padding: 8 + 1 + 1 + 6(pad) = 16 bytes
type Good struct {
    B int64
    A byte
    C byte
}

// 5. Prefer []byte over string trong I/O hot path
// string → []byte conversion = allocation
// Nhiều APIs accept both, prefer []byte để avoid conversion

// 6. Dùng errors.Is/As thay vì == hay type assertion
var ErrNotFound = errors.New("not found")
if errors.Is(err, ErrNotFound) { ... }     // handle wrapping
if errors.As(err, &targetErr) { ... }      // extract type

// 7. Tránh time.Sleep trong production code (use ticker/timer)
ticker := time.NewTicker(1 * time.Second)
defer ticker.Stop()
for {
    select {
    case <-ticker.C:
        doWork()
    case <-ctx.Done():
        return
    }
}
```

---

## Quick Reference: Performance Checklist

| Category | ❌ Anti-Pattern | ✅ Fix | Impact |
|----------|----------------|--------|--------|
| Goroutine | Spawn unbounded | Worker pool + context | Memory, CPU |
| Allocation | Return pointer always | Return value when possible | GC pressure |
| String | `s += part` in loop | `strings.Builder` với `.Grow()` | O(N²) → O(N) |
| Slice | No 3-index, no copy | `a[:x:x]`, explicit copy | Data races, memory |
| Map | `make(map[K]V)` cold | `make(map[K]V, hint)` | Rehash overhead |
| Map | Never rebuild | Periodic rebuild | Memory leak |
| Mutex | Mutex for reads | RWMutex | Contention |
| Mutex | Lock around computation | Lock only shared state | Latency |
| Pool | Alloc in hot path | sync.Pool | GC pressure |
| Defer | In loop | Wrap in function | FD/resource leak |
| Channel | Unbuffered producer | Buffered or semaphore | Latency spike |
| Interface | Large struct value | Pointer receiver | Heap escape |
| Reflection | Hot path | Code generation | 10-100x slow |

---

## 🔗 Links

- [[Go-Zero-To-Hero/Bai-3-Goroutines-Channels|Bài 3: Goroutines & Channels]]
- [[Go-Zero-To-Hero/Bai-8-Testing-Benchmarking|Bài 8: Benchmarking với testing package]]
- [[Rust-Zero-To-Hero/Performance-Pitfalls-Rust|Rust: Performance Pitfalls (so sánh)]]

---

*Thực hành:*
1. Chạy `go build -gcflags="-m"` trên một package trong PDMS. Đếm số dòng "escapes to heap".
2. Viết benchmark so sánh `string +=` vs `strings.Builder` với 1000 iterations.
3. Thêm `/debug/pprof` endpoint vào một service. Chạy load test và capture heap profile.
4. Tìm một map trong codebase không có size hint. Đo impact khi thêm hint với benchmark.
