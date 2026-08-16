---
type: course
domain: languages/go
status: active
created: 2026-08-17
updated: 2026-08-17
tags: []
---

# Bài 41: Timers, Tickers, Atomic Counters & Stateful Goroutines — Nhóm 3 Bổ Sung

> **Mục tiêu:** Rà soát Nhóm 3 (Concurrency) so với gobyexample.com cho thấy [[Bai-3-Goroutines-Channels|Bài 3]] đã cover đầy đủ: Goroutines, Channels, Buffering, Directions, Select, Worker Pool, WaitGroup, Mutex. Bài này lấp 5 mảnh còn thiếu: **Timers/Tickers** (chưa có lesson riêng), **Atomic Counters** (`sync/atomic` chưa nhắc tới), **Stateful Goroutines** (pattern "share memory by communicating" thay vì mutex), **Rate Limiting** đúng chuẩn (mới chỉ là bài tập gợi ý), và làm rõ thêm nuance của **Closing Channels**/**Non-Blocking Operations**.
>
> **Level:** Foundation → Intermediate (đọc sau Bài 3)

---

## 1. Timers — Chạy 1 Lần Sau N Thời Gian

```go
timer := time.NewTimer(2 * time.Second)
<-timer.C // block cho tới khi timer nổ, C là channel nhận 1 giá trị time.Time

// Timer.Stop() — HUỶ timer trước khi nổ (nếu chưa nổ)
timer2 := time.NewTimer(5 * time.Second)
stopped := timer2.Stop()
if stopped {
    fmt.Println("hủy thành công trước khi nổ")
}
```

⚠ **Trap khi dùng chung `select` với `context`:** nếu `Stop()` trả `false` (timer đã nổ hoặc đã bị stop trước đó), channel `timer.C` **có thể đã có giá trị nằm sẵn trong buffer** (channel cap=1) — code drain sai cách có thể đọc nhầm giá trị cũ ở lần dùng lại timer. Từ **Go 1.23+**, `Timer`/`Ticker` được garbage-collect đúng cách ngay cả khi không gọi `Stop()` (trước đó phải tự `Stop()` để tránh leak) — nhưng **vẫn nên `Stop()` tường minh** để giải phóng resource sớm và tránh nhận nhầm giá trị channel cũ.

### 1.1 Advanced — `Timer.Reset()` cho pattern "debounce" (rất hay dùng cho auto-save draft hồ sơ)

```go
type Debouncer struct {
    timer *time.Timer
    mu    sync.Mutex
}

func (d *Debouncer) Trigger(delay time.Duration, fn func()) {
    d.mu.Lock()
    defer d.mu.Unlock()
    if d.timer != nil {
        d.timer.Stop() // hủy lần trigger trước nếu chưa chạy
    }
    d.timer = time.AfterFunc(delay, fn) // chạy fn SAU delay, trên goroutine riêng
}

// PDMS: user gõ note trong ô comment, chỉ auto-save sau 800ms KHÔNG gõ tiếp
// thay vì gọi API mỗi keystroke
var debouncer Debouncer
onKeystroke := func() {
    debouncer.Trigger(800*time.Millisecond, func() {
        saveDraft(currentNote)
    })
}
```

---

## 2. Tickers — Chạy Lặp Lại Định Kỳ

```go
ticker := time.NewTicker(1 * time.Second)
defer ticker.Stop() // ⚠ BẮT BUỘC — Ticker KHÔNG tự dừng, khác Timer (chạy 1 lần)

done := make(chan bool)
go func() {
    for {
        select {
        case <-done:
            return
        case t := <-ticker.C:
            fmt.Println("tick tại", t)
        }
    }
}()
```

```
┌────────────────────────────────────────────────────────────┐
│  Timer   → nổ ĐÚNG 1 LẦN, channel C nhận đúng 1 giá trị      │
│  Ticker  → nổ LẶP LẠI mãi mãi cho tới khi Stop(), PHẢI luôn   │
│            defer ticker.Stop() — quên là goroutine leak +     │
│            ticker vẫn chạy nền tốn CPU dù không ai cần nữa     │
└────────────────────────────────────────────────────────────┘
```

⚠ **Trap kinh điển:** `time.Tick()` (hàm free function, không phải `NewTicker`) **KHÔNG BAO GIỜ có cách nào Stop()** — dùng nó trong function gọi lặp lại (không phải `main()` chạy vĩnh viễn) chắc chắn leak ticker. Golang doc khuyến cáo `time.Tick` chỉ nên dùng ở chương trình chạy vĩnh viễn (long-running daemon ở top-level), **production code nên luôn dùng `time.NewTicker` + `defer Stop()` tường minh**.

---

## 3. Atomic Counters — `sync/atomic`, Nhẹ Hơn Mutex Cho Counter Đơn Giản

```go
import "sync/atomic"

var counter atomic.Int64 // Go 1.19+ — type-safe wrapper, KHÔNG cần &counter thủ công

func handleRequest() {
    counter.Add(1)
}

fmt.Println(counter.Load())
```

```go
// Trước Go 1.19 — API cũ dùng con trỏ trực tiếp, dễ nhầm giữa
// atomic access và non-atomic access trên cùng biến (bug tinh vi)
var counterOld int64
atomic.AddInt64(&counterOld, 1)
v := atomic.LoadInt64(&counterOld)
// ⚠ Nếu 1 chỗ code lỡ đọc "counterOld" trực tiếp thay vì atomic.LoadInt64(&counterOld),
// compiler KHÔNG báo lỗi — data race âm thầm. Type atomic.Int64 (1.19+) hạn chế
// lỗi này vì method Load()/Add() là API DUY NHẤT để truy cập giá trị.
```

```
┌────────────────────────────────────────────────────────────┐
│  Mutex                          │  atomic (sync/atomic)       │
├───────────────────────────────────┼──────────────────────────┤
│  Bảo vệ ĐOẠN CODE (critical      │  Bảo vệ 1 THAO TÁC đơn lẻ  │
│  section) — nhiều dòng, nhiều    │  trên 1 giá trị (increment, │
│  biến, logic phức tạp             │  compare-and-swap, load)     │
│  Có overhead lock/unlock (dù     │  Dùng CPU instruction đặc    │
│  nhỏ), có thể contention nếu     │  biệt (CAS) — nhanh hơn      │
│  giữ lock lâu                     │  mutex cho counter đơn giản  │
│  Dùng khi: sửa nhiều field cùng  │  Dùng khi: CHỈ 1 con số/con  │
│  lúc, logic điều kiện phức tạp    │  trỏ cần tăng/giảm/so sánh    │
└───────────────────────────────────┴──────────────────────────┘
```

### 3.1 Advanced — `CompareAndSwap` cho lock-free state transition

```go
// Đảm bảo chỉ 1 goroutine trong N goroutine được "thắng" chạy 1 tác vụ
// (ví dụ: chỉ 1 goroutine trong cluster được trigger cleanup job)
var jobStarted atomic.Bool

func tryStartCleanupJob() bool {
    return jobStarted.CompareAndSwap(false, true) // atomic: đọc + so sánh + ghi trong 1 bước không thể chen ngang
}

if tryStartCleanupJob() {
    go runCleanup()
} else {
    fmt.Println("job đã được goroutine khác start rồi")
}
```

⚠ **Vì sao không thể làm điều này an toàn bằng if/else thường:** `if !jobStarted.Load() { jobStarted.Store(true); go runCleanup() }` có **race window** giữa `Load()` và `Store()` — 2 goroutine có thể cùng đọc `false` trước khi goroutine nào kịp ghi `true`, dẫn tới cleanup job chạy 2 lần. `CompareAndSwap` gộp đọc-so sánh-ghi thành 1 thao tác nguyên tử (atomic), loại bỏ hoàn toàn race window này.

---

## 4. Stateful Goroutines — "Share Memory By Communicating", Không Dùng Mutex

Đây là idiom đặc trưng nhất của Go, đối lập triết lý với Java (`synchronized`) — thay vì nhiều goroutine tranh nhau lock 1 vùng nhớ chung, **1 goroutine duy nhất SỞ HỮU state**, các goroutine khác gửi request qua channel để đọc/ghi.

```go
type readRequest struct {
    key  string
    resp chan int
}
type writeRequest struct {
    key string
    val int
}

type StatefulCounter struct {
    reads  chan readRequest
    writes chan writeRequest
}

func NewStatefulCounter() *StatefulCounter {
    c := &StatefulCounter{
        reads:  make(chan readRequest),
        writes: make(chan writeRequest),
    }
    go c.run() // GOROUTINE DUY NHẤT sở hữu map — không ai khác đụng vào trực tiếp
    return c
}

func (c *StatefulCounter) run() {
    state := make(map[string]int) // KHÔNG cần mutex — chỉ 1 goroutine truy cập state này
    for {
        select {
        case r := <-c.reads:
            r.resp <- state[r.key]
        case w := <-c.writes:
            state[w.key]++
        }
    }
}

func (c *StatefulCounter) Get(key string) int {
    resp := make(chan int)
    c.reads <- readRequest{key: key, resp: resp}
    return <-resp
}

func (c *StatefulCounter) Increment(key string) {
    c.writes <- writeRequest{key: key}
}
```

```
┌────────────────────────────────────────────────────────────┐
│         MUTEX APPROACH           │  STATEFUL GOROUTINE       │
│                                   │  APPROACH                 │
├─────────────────────────────────────┼──────────────────────────┤
│  N goroutine ──lock──► shared map │  N goroutine ──channel──► │
│  (nhiều goroutine CÙNG chạm vào    │  1 goroutine sở hữu map    │
│  vùng nhớ, mutex ngăn race)        │  (chỉ 1 nơi chạm vào map,  │
│                                     │  không cần đồng bộ hoá gì  │
│                                     │  vì không ai khác truy cập) │
│  Dễ deadlock nếu lock nhiều mutex │  Không thể deadlock kiểu    │
│  chồng chéo sai thứ tự             │  "lock order" (không có     │
│                                     │  nhiều lock để lồng nhau)   │
│  Nhanh hơn cho workload đơn giản, │  Rõ ràng hơn cho state phức │
│  đọc/ghi tần suất rất cao          │  tạp, dễ audit "ai được đọc/│
│                                     │  ghi state" qua API channel  │
└─────────────────────────────────────┴──────────────────────────┘
```

⚠ **Khi nào chọn cách nào:** Go proverb nổi tiếng "Do not communicate by sharing memory; instead, share memory by communicating" — nhưng **không phải lúc nào channel cũng thắng mutex**. Với counter đơn giản tần suất cực cao, `sync.Mutex` hoặc `atomic` (mục 3) thường **nhanh hơn** stateful-goroutine (mỗi request phải qua 2 lần channel send/receive, tốn context switch). Stateful goroutine hợp lý khi **logic quản lý state phức tạp** (nhiều bước, cần validate trước khi ghi, cần trả về kết quả khác nhau tuỳ điều kiện) — lúc đó code đọc rõ ràng hơn hẳn so với 1 đống mutex lock rải rác.

---

## 5. Rate Limiting — Ticker-based & Token Bucket

### 5.1 Rate limiting đơn giản — dùng ticker làm nhịp

```go
requests := make(chan int, 5)
for i := 1; i <= 5; i++ {
    requests <- i
}
close(requests)

limiter := time.NewTicker(200 * time.Millisecond) // tối đa 5 request/giây
defer limiter.Stop()

for req := range requests {
    <-limiter.C // block tới nhịp ticker tiếp theo — tự nhiên giới hạn tốc độ
    processRequest(req)
}
```

### 5.2 Advanced — Token Bucket cho phép "burst" (production-grade, dùng `golang.org/x/time/rate`)

```go
import "golang.org/x/time/rate"

// 10 request/giây trung bình, cho phép burst tối đa 20 request liền
limiter := rate.NewLimiter(rate.Limit(10), 20)

func handleAPIRequest(ctx context.Context) error {
    if err := limiter.Wait(ctx); err != nil { // block tới khi có token, hoặc trả lỗi nếu ctx cancel
        return fmt.Errorf("rate limit: %w", err)
    }
    return doActualWork()
}

// Non-blocking check — dùng cho middleware từ chối request ngay thay vì chờ
func middleware(w http.ResponseWriter, r *http.Request) {
    if !limiter.Allow() {
        http.Error(w, "too many requests", http.StatusTooManyRequests)
        return
    }
    // ... xử lý tiếp
}
```

```
┌────────────────────────────────────────────────────────────┐
│  Ticker-based (mục 5.1)   │  Token Bucket (rate.Limiter)     │
├──────────────────────────────┼──────────────────────────────┤
│  Tốc độ CỐ ĐỊNH tuyệt đối,   │  Cho phép BURST tới giới hạn    │
│  không cho phép burst — nếu  │  (vd: cho phép 20 request dồn   │
│  không có request nào tới    │  dập tức thời) trong khi vẫn giữ│
│  trong 1 khoảng, "slot"       │  trung bình dài hạn ổn định       │
│  trống đó MẤT LUÔN            │  (giống rate limiter thật của API │
│                                │  gateway production)               │
│  Đơn giản, tự viết dễ         │  Cần thư viện x/time/rate, nhưng   │
│                                │  đúng chuẩn dùng cho production API│
└──────────────────────────────┴──────────────────────────────┘
```

Ứng dụng PDMS: giới hạn số lần gọi API core banking (thường có SLA/quota tính phí) khi PDMS đồng bộ trạng thái hồ sơ hàng loạt — token bucket cho phép burst khi cần đồng bộ gấp mà không vượt trần quota trung bình.

---

## 6. Bổ sung: Closing Channels & Non-Blocking Operations — Nuance Chưa Nói Ở Bài 3

```go
// ⚠ RULE 1: chỉ SENDER được close channel, KHÔNG BAO GIỜ để receiver close
// ⚠ RULE 2: close 1 channel ĐÃ closed → panic ngay lập tức
// ⚠ RULE 3: gửi giá trị vào channel đã closed → panic ngay lập tức
// ⚠ RULE 4: nhận từ channel đã closed → trả về ZERO VALUE ngay, KHÔNG block
//    (khác với channel rỗng nhưng CHƯA closed — trường hợp đó block chờ)

ch := make(chan int)
close(ch)
v, ok := <-ch // v = 0, ok = false — báo hiệu channel đã đóng, không phải "có giá trị 0 thật"

// Non-blocking send/receive — dùng default trong select
select {
case v := <-ch:
    fmt.Println("nhận được:", v)
default:
    fmt.Println("không có gì sẵn sàng, không block") // chạy NGAY nếu ch rỗng
}

select {
case ch <- 42:
    fmt.Println("gửi thành công")
default:
    fmt.Println("channel đầy/không ai nhận, bỏ qua thay vì block")
}
```

⚠ **Trap "close nil channel":** gửi/nhận trên `nil` channel (channel chưa `make()`) **block MÃI MÃI** (không panic, chỉ deadlock) — thường xảy ra khi struct có field channel quên khởi tạo. `close(nilChan)` thì **panic ngay**, khác với send/receive (chỉ block). Ba hành vi (nil channel, closed channel, channel rỗng chưa đóng) rất dễ nhầm lẫn — bảng dưới tổng hợp lại cho rõ:

```
┌──────────────┬────────────────────┬────────────────────┬──────────────┐
│  Trạng thái   │  Send              │  Receive            │  close()      │
├──────────────┼────────────────────┼────────────────────┼──────────────┤
│  nil channel  │  block mãi mãi     │  block mãi mãi      │  panic        │
│  channel mở,  │  block tới khi có  │  block tới khi có   │  OK           │
│  rỗng          │  người nhận/buffer│  giá trị            │              │
│  channel đã   │  panic ngay        │  trả zero value NGAY│  panic (đóng  │
│  closed        │                    │  (ok=false)          │  2 lần)       │
└──────────────┴────────────────────┴────────────────────┴──────────────┘
```

---

## 7. Tổng kết Bài 41

```
┌─────────────────────────────────────────────────────────┐
│                   KEY TAKEAWAYS                          │
├─────────────────────────────────────────────────────────┤
│  ✅ Timer nổ 1 lần, Ticker nổ lặp lại — Ticker BẮT BUỘC    │
│     defer Stop(), tránh dùng time.Tick() trong function     │
│     ngắn hạn (leak, không thể Stop)                          │
│  ✅ time.AfterFunc + Timer.Reset() = pattern debounce chuẩn  │
│  ✅ atomic.Int64/Bool (Go 1.19+ API) nhẹ hơn mutex cho       │
│     counter/flag đơn giản; CompareAndSwap loại bỏ race       │
│     window mà if/else thường không tránh được                │
│  ✅ Stateful goroutine: 1 goroutine sở hữu state, giao tiếp   │
│     qua channel — thay thế mutex khi logic state phức tạp,    │
│     nhưng KHÔNG nhanh hơn mutex/atomic cho case đơn giản      │
│  ✅ Rate limiting production dùng token bucket                │
│     (golang.org/x/time/rate) để cho phép burst, không dùng    │
│     ticker cứng nhắc cho production API                        │
│  ✅ Chỉ sender được close channel; close channel đã đóng hoặc │
│     gửi vào channel đã đóng đều panic; nhận từ channel đã     │
│     đóng trả zero value ngay (không block); nil channel block  │
│     mãi mãi cả send lẫn receive                                 │
└─────────────────────────────────────────────────────────┘
```

**Hoàn thành rà soát Nhóm 2 (bổ sung nhỏ vào [[Bai-4-Error-Defer-Panic|Bài 4]]) và Nhóm 3 (bổ sung qua bài này).**

**Liên quan trong vault:** [[Bai-3-Goroutines-Channels|Bài 3]] · [[Bai-36-Scheduler-GMP-Internals|Bài 36]] (sysmon dùng chính cơ chế timer nội bộ tương tự) · [[Bai-4-Error-Defer-Panic|Bài 4 mục 8.5]] (errors.Join, re-panic)

---

**Bài tập:**
1. Viết `Debouncer` generic (mục 1.1) nhận `func()` bất kỳ, viết test verify chỉ lần gọi CUỐI CÙNG trong chuỗi trigger liên tiếp thực sự chạy
2. So sánh benchmark `sync.Mutex` counter vs `atomic.Int64` counter với 8 goroutine tăng 1 triệu lần — đo throughput bằng `go test -bench=. -benchmem`
3. Viết `StatefulCache[K,V]` (nối tiếp pattern mục 4) hỗ trợ `Get`, `Set`, `Delete`, `Len` — so sánh code với bản dùng `sync.RWMutex` map, đánh giá code nào dễ đọc hơn cho trường hợp cụ thể này
4. Dùng `golang.org/x/time/rate` giới hạn số lần gọi 1 API bên thứ 3 (core banking mock) xuống tối đa 5 req/giây, burst 10 — test bằng cách bắn 50 request đồng thời và đo thời gian hoàn thành

---
*Tags: #go #timers #tickers #atomic #concurrency #rate-limiting #stateful-goroutines #zero-to-hero*
