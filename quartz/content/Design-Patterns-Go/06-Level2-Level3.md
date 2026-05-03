# Level 2 · Idiomatic + Level 3 · Concurrency Patterns

```
╔══════════════════════════════════════════════════════════════════╗
║  Level 2: "Code is Rusty Go-ish" → Level 3: Goroutines master   ║
╚══════════════════════════════════════════════════════════════════╝
```

---

# ══ LEVEL 2 · IDIOMATIC ══════════════════════════════════════════

## 1. Embedding Composition — Go's "Inheritance"

### Diagram

```
┌───────────────────────────────────────────────────────────────────┐
│                    Embedding vs Inheritance                        │
│                                                                   │
│  Java (inheritance):      Go (embedding):                         │
│  class Animal {           type Animal struct { Name string }      │
│    String name;           func (a *Animal) Speak() string { ... } │
│    void speak() {...}                                             │
│  }                        type Dog struct {                       │
│  class Dog extends        Animal           ← promoted fields      │
│    Animal { ... }             Breed string                        │
│                           }                                       │
│                           d := Dog{Animal: Animal{Name: "Rex"}}   │
│                           d.Speak()  ← promoted method!          │
│                           d.Name     ← promoted field!           │
│                                                                   │
│  Key difference:                                                  │
│  ✓ Dog "has-a" Animal (not "is-a" in type system)               │
│  ✓ Dog can override Speak() by defining own method               │
│  ✓ Embedding multiple structs possible (no diamond problem)       │
└───────────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package embedding

import "fmt"

// ─── Base behaviors (embeddable) ──────────────────────────────
type Timestamped struct {
    CreatedAt time.Time
    UpdatedAt time.Time
}

func (t *Timestamped) Touch() { t.UpdatedAt = time.Now() }
func (t *Timestamped) Age() time.Duration { return time.Since(t.CreatedAt) }

type SoftDeletable struct {
    DeletedAt *time.Time
}

func (s *SoftDeletable) Delete() {
    now := time.Now()
    s.DeletedAt = &now
}
func (s *SoftDeletable) IsDeleted() bool { return s.DeletedAt != nil }

type Auditable struct {
    CreatedBy string
    UpdatedBy string
}

func (a *Auditable) SetUpdater(user string) { a.UpdatedBy = user }

// ─── Domain struct with multiple embeddings ───────────────────
type LoanRecord struct {
    Timestamped   // promoted: CreatedAt, UpdatedAt, Touch(), Age()
    SoftDeletable // promoted: DeletedAt, Delete(), IsDeleted()
    Auditable     // promoted: CreatedBy, UpdatedBy, SetUpdater()

    ID     string
    Amount int64
    Status string
}

// ─── Embedding interfaces for composition ─────────────────────
type Logger interface {
    Log(msg string)
}

type MetricsRecorder interface {
    Record(event string, value float64)
}

// Service embeds both — gets both methods promoted
type LoanService struct {
    Logger          // any Logger implementation
    MetricsRecorder // any MetricsRecorder implementation
    repo LoanRepository
}

func NewLoanService(log Logger, metrics MetricsRecorder, repo LoanRepository) *LoanService {
    return &LoanService{Logger: log, MetricsRecorder: metrics, repo: repo}
}

func (s *LoanService) Approve(id string) error {
    s.Log(fmt.Sprintf("approving loan %s", id))    // via Logger
    s.Record("loan.approve", 1)                    // via MetricsRecorder
    return s.repo.UpdateStatus(id, "APPROVED")
}

// ─── Override promoted method ─────────────────────────────────
type RateLimitedLogger struct {
    Logger      // embedded
    lastLog time.Time
    minGap  time.Duration
}

func (r *RateLimitedLogger) Log(msg string) {
    if time.Since(r.lastLog) < r.minGap { return } // rate limit
    r.Logger.Log(msg)                               // delegate to inner
    r.lastLog = time.Now()
}
```

---

## 2. Context Propagation Pattern

### Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                  Context Flow in Go                               │
│                                                                  │
│  HTTP Handler                                                    │
│  func Handle(w, r) {                                            │
│      ctx := r.Context()    ← client request context             │
│      ctx, cancel := context.WithTimeout(ctx, 5*time.Second)     │
│      defer cancel()                                              │
│         │                                                        │
│         ▼                                                        │
│      result, err := service.GetLoan(ctx, id)                    │
│         │  (ctx passed ALL the way down)                        │
│         ▼                                                        │
│      func (s) GetLoan(ctx, id) {                                │
│          return repo.Find(ctx, id)     ← ctx to DB query        │
│      }                                                           │
│         ▼                                                        │
│      DB query cancelled when context deadline exceeded           │
│                                                                  │
│  context.WithValue(ctx, key, val)  → request-scoped values      │
│  context.WithCancel(ctx)          → cancellation signal          │
│  context.WithTimeout(ctx, d)      → time-bounded operation       │
│  context.WithDeadline(ctx, t)     → absolute deadline           │
└──────────────────────────────────────────────────────────────────┘
```

### Prototype: Request-Scoped Values + Cancellation

```go
package context_pattern

import (
    "context"
    "fmt"
    "time"
)

// ─── Type-safe context keys (avoid key collisions) ────────────
type contextKey string

const (
    requestIDKey  contextKey = "request_id"
    userIDKey     contextKey = "user_id"
    tenantIDKey   contextKey = "tenant_id"
)

// Helper functions — avoid raw context.Value(string)
func WithRequestID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, requestIDKey, id)
}
func RequestIDFrom(ctx context.Context) (string, bool) {
    id, ok := ctx.Value(requestIDKey).(string)
    return id, ok
}
func WithUserID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, userIDKey, id)
}
func UserIDFrom(ctx context.Context) (string, bool) {
    id, ok := ctx.Value(userIDKey).(string)
    return id, ok
}

// ─── Middleware adds request-scoped values ────────────────────
func RequestIDMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        id := r.Header.Get("X-Request-ID")
        if id == "" { id = generateID() }
        ctx := WithRequestID(r.Context(), id)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

func AuthMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        userID := parseToken(r.Header.Get("Authorization"))
        ctx := WithUserID(r.Context(), userID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// ─── Service uses ctx naturally ───────────────────────────────
func (s *LoanService) Create(ctx context.Context, req CreateLoanReq) (*Loan, error) {
    userID, ok := UserIDFrom(ctx)
    if !ok { return nil, fmt.Errorf("no user in context") }

    reqID, _ := RequestIDFrom(ctx)
    s.log.Info("creating loan", "user", userID, "request_id", reqID)

    // ctx propagated to DB — query cancelled if ctx cancelled
    loan, err := s.repo.Insert(ctx, &Loan{
        UserID: userID,
        Amount: req.Amount,
    })
    return loan, err
}

// ─── Timeout pattern ──────────────────────────────────────────
func callExternalAPI(parentCtx context.Context, url string) ([]byte, error) {
    ctx, cancel := context.WithTimeout(parentCtx, 3*time.Second)
    defer cancel() // always cancel to release resources

    req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        if ctx.Err() == context.DeadlineExceeded {
            return nil, fmt.Errorf("API call timeout after 3s: %w", err)
        }
        return nil, fmt.Errorf("API call failed: %w", err)
    }
    defer resp.Body.Close()
    return io.ReadAll(resp.Body)
}
```

---

# ══ LEVEL 3 · CONCURRENCY PATTERNS ════════════════════════════════

## 3. Worker Pool — Bounded Goroutines

### Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                     Worker Pool Pattern                           │
│                                                                  │
│  jobs := make(chan Job, 100)     ← buffered job queue            │
│  results := make(chan Result, 100)                                │
│                                                                  │
│         ┌──────┐   ┌──────┐   ┌──────┐   ┌──────┐             │
│  jobs──▶│Work-1│   │Work-2│   │Work-3│   │Work-N│──▶results   │
│         │gorout│   │gorout│   │gorout│   │gorout│             │
│         └──────┘   └──────┘   └──────┘   └──────┘             │
│             │_____________|_____________|_____|                  │
│                         reading from jobs chan                   │
│                                                                  │
│  N workers = GOMAXPROCS (CPU-bound) or 2-4× (I/O-bound)         │
│  Bounded: no goroutine explosion, controlled memory              │
└──────────────────────────────────────────────────────────────────┘
```

### Prototype: Generic Worker Pool

```go
package workerpool

import (
    "context"
    "sync"
)

// ─── Generic worker pool (Go 1.18+ generics) ─────────────────
type Job[I, O any] struct {
    Input I
    idx   int
}

type Result[O any] struct {
    Output O
    Err    error
    idx    int
}

type WorkerPool[I, O any] struct {
    workers int
    fn      func(context.Context, I) (O, error)
}

func NewPool[I, O any](workers int, fn func(context.Context, I) (O, error)) *WorkerPool[I, O] {
    return &WorkerPool[I, O]{workers: workers, fn: fn}
}

// Process: submit all inputs, collect results in order
func (p *WorkerPool[I, O]) Process(ctx context.Context, inputs []I) ([]O, []error) {
    jobs    := make(chan Job[I, O], len(inputs))
    results := make(chan Result[O], len(inputs))

    // Launch workers
    var wg sync.WaitGroup
    for w := 0; w < p.workers; w++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for job := range jobs {
                out, err := p.fn(ctx, job.Input)
                results <- Result[O]{Output: out, Err: err, idx: job.idx}
            }
        }()
    }

    // Send jobs
    for i, input := range inputs {
        select {
        case jobs <- Job[I, O]{Input: input, idx: i}:
        case <-ctx.Done():
            break
        }
    }
    close(jobs)

    // Wait and close results
    go func() { wg.Wait(); close(results) }()

    // Collect ordered results
    outputs := make([]O, len(inputs))
    errs    := make([]error, len(inputs))
    for r := range results {
        outputs[r.idx] = r.Output
        errs[r.idx]    = r.Err
    }
    return outputs, errs
}

// ─── Usage: validate 1000 CIFs in parallel ────────────────────
func validateCIFs(ctx context.Context, cifs []string) {
    pool := NewPool[string, bool](
        runtime.GOMAXPROCS(0), // CPU count workers
        func(ctx context.Context, cif string) (bool, error) {
            return cifService.Validate(ctx, cif)
        },
    )
    results, errs := pool.Process(ctx, cifs)
    for i, cif := range cifs {
        if errs[i] != nil {
            fmt.Printf("CIF %s: error: %v\n", cif, errs[i])
        } else {
            fmt.Printf("CIF %s: valid=%v\n", cif, results[i])
        }
    }
}
```

---

## 4. Pipeline — Chaining Channels

### Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                   Pipeline Pattern                                │
│                                                                  │
│  Source ──▶ Stage1 ──▶ Stage2 ──▶ Stage3 ──▶ Sink              │
│  (chan)     (gorout)   (gorout)   (gorout)   (collect)           │
│                                                                  │
│  func generate(nums ...int) <-chan int {                         │
│      out := make(chan int)                                       │
│      go func() {                                                 │
│          for _, n := range nums { out <- n }                    │
│          close(out)                                              │
│      }()                                                         │
│      return out                                                  │
│  }                                                               │
│                                                                  │
│  Each stage: in <-chan T → out <-chan U                          │
│  Backpressure: buffered channels control flow                    │
│  Cancellation: done/ctx channel propagates to all stages         │
└──────────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package pipeline

import "context"

// ─── Stage function type ──────────────────────────────────────
type Stage[I, O any] func(ctx context.Context, in <-chan I) <-chan O

// ─── Generic pipeline runner ──────────────────────────────────
func Source[T any](ctx context.Context, items []T) <-chan T {
    out := make(chan T, len(items))
    go func() {
        defer close(out)
        for _, item := range items {
            select {
            case out <- item:
            case <-ctx.Done(): return
            }
        }
    }()
    return out
}

// ─── Example: Document processing pipeline ────────────────────
type RawDoc   struct{ ID, Path string }
type ParsedDoc struct{ ID, Content string }
type IndexedDoc struct{ ID, Content string; Keywords []string }

func ParseStage(ctx context.Context, in <-chan RawDoc) <-chan ParsedDoc {
    out := make(chan ParsedDoc, 10)
    go func() {
        defer close(out)
        for raw := range in {
            content, err := readFile(raw.Path)
            if err != nil { continue }
            select {
            case out <- ParsedDoc{ID: raw.ID, Content: content}:
            case <-ctx.Done(): return
            }
        }
    }()
    return out
}

func IndexStage(ctx context.Context, in <-chan ParsedDoc) <-chan IndexedDoc {
    out := make(chan IndexedDoc, 10)
    go func() {
        defer close(out)
        for doc := range in {
            keywords := extractKeywords(doc.Content)
            select {
            case out <- IndexedDoc{ID: doc.ID, Content: doc.Content, Keywords: keywords}:
            case <-ctx.Done(): return
            }
        }
    }()
    return out
}

func Sink[T any](ctx context.Context, in <-chan T) []T {
    var results []T
    for item := range in {
        results = append(results, item)
    }
    return results
}

// Usage:
func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    docs := []RawDoc{
        {ID: "1", Path: "doc1.pdf"},
        {ID: "2", Path: "doc2.pdf"},
    }

    // Wire pipeline
    raw     := Source(ctx, docs)
    parsed  := ParseStage(ctx, raw)
    indexed := IndexStage(ctx, parsed)
    results := Sink(ctx, indexed)

    fmt.Printf("Indexed %d documents\n", len(results))
}
```

---

## 5. Fan-out / Fan-in

### Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    Fan-out / Fan-in                               │
│                                                                  │
│  Fan-out (1 channel → N goroutines):                             │
│                  ┌──▶ Worker 1 ──┐                               │
│  input chan ─────┼──▶ Worker 2 ──┼──▶ merged output chan         │
│                  └──▶ Worker N ──┘                               │
│                                                                  │
│  Use case:                                                       │
│  - CPU-intensive task that can be parallelized                   │
│  - Multiple API calls that can be concurrent                     │
│                                                                  │
│  Fan-in (N channels → 1 channel):                                │
│  chan A ──┐                                                      │
│  chan B ──┼──▶ merged chan                                       │
│  chan C ──┘                                                      │
│                                                                  │
│  Use case: aggregate results from multiple sources               │
└──────────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package fanout

import (
    "context"
    "sync"
)

// ─── Fan-out: distribute work to N workers ────────────────────
func FanOut[T any](ctx context.Context, in <-chan T, n int) []<-chan T {
    channels := make([]<-chan T, n)
    for i := range channels {
        ch := make(chan T, 10)
        channels[i] = ch
        go func(out chan<- T) {
            defer close(out)
            for item := range in {
                select {
                case out <- item:
                case <-ctx.Done(): return
                }
            }
        }(ch)
    }
    return channels
}

// ─── Fan-in: merge N channels into 1 ─────────────────────────
func FanIn[T any](ctx context.Context, channels ...<-chan T) <-chan T {
    merged := make(chan T, 10)
    var wg sync.WaitGroup

    forward := func(ch <-chan T) {
        defer wg.Done()
        for item := range ch {
            select {
            case merged <- item:
            case <-ctx.Done(): return
            }
        }
    }

    wg.Add(len(channels))
    for _, ch := range channels { go forward(ch) }

    go func() { wg.Wait(); close(merged) }()
    return merged
}

// ─── Usage: parallel CIF validation ──────────────────────────
func validateAllCIFs(ctx context.Context, cifs []string) []bool {
    // Source
    input := Source(ctx, cifs)

    // Fan-out to 4 parallel validators
    workerChans := FanOut(ctx, input, 4)

    // Each worker validates:
    resultChans := make([]<-chan bool, len(workerChans))
    for i, wch := range workerChans {
        wch := wch
        out := make(chan bool, 10)
        resultChans[i] = out
        go func() {
            defer close(out)
            for cif := range wch {
                valid, _ := cifService.Validate(ctx, cif)
                out <- valid
            }
        }()
    }

    // Fan-in results
    merged := FanIn(ctx, resultChans...)
    return Sink(ctx, merged)
}
```

---

## 6. Done Channel & Semaphore

### Done Channel (Cancellation)

```go
// ─── Done channel: propagate cancellation signal ──────────────
func generator(done <-chan struct{}, nums ...int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for _, n := range nums {
            select {
            case out <- n:
            case <-done:   // cancelled: stop immediately
                return
            }
        }
    }()
    return out
}

// Modern Go: prefer context.Context over done chan:
func generatorCtx(ctx context.Context, nums ...int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for _, n := range nums {
            select {
            case out <- n:
            case <-ctx.Done(): return
            }
        }
    }()
    return out
}
```

### Semaphore Pattern

```go
// ─── Buffered channel as semaphore ────────────────────────────
// Diagram:
// sem = make(chan struct{}, N)   ← N "slots"
// sem <- struct{}{}              ← acquire (blocks if full)
// defer func() { <-sem }()      ← release on exit

func processWithSemaphore(ctx context.Context, urls []string, maxConcurrent int) []Result {
    sem := make(chan struct{}, maxConcurrent)  // semaphore
    results := make([]Result, len(urls))
    var wg sync.WaitGroup

    for i, url := range urls {
        i, url := i, url
        wg.Add(1)
        go func() {
            defer wg.Done()

            // Acquire
            select {
            case sem <- struct{}{}: // got a slot
            case <-ctx.Done():
                results[i] = Result{Err: ctx.Err()}
                return
            }
            defer func() { <-sem }() // release

            resp, err := fetchURL(ctx, url)
            results[i] = Result{Data: resp, Err: err}
        }()
    }

    wg.Wait()
    return results
}
```

---

## Level 2 & 3 Checklist

```
Level 2:
□ Embedding để compose behaviors (không "extend" struct)
□ context.Context là tham số đầu tiên trong mọi blocking call
□ context keys dùng typed constants (không string)
□ Retry logic với exponential backoff trong service calls

Level 3:
□ Worker pool thay vì spawn goroutines unbounded
□ workers = GOMAXPROCS cho CPU-bound, N×GOMAXPROCS cho I/O-bound
□ Pipeline stages: mỗi stage 1 goroutine, communicate via channels
□ Fan-out khi có thể parallelize, fan-in để merge results
□ Context cancellation propagates qua tất cả stages
□ Buffered channels cho backpressure control
□ defer cancel() LUÔN LUÔN sau context.WithTimeout/Cancel
```

---

## 🔗 Links
- [[Design-Patterns-Go/05-Level1-Foundations|← Level 1 · Foundations]]
- [[Design-Patterns-Go/08-Level4-Architecture|Level 4 · Architecture →]]

*Tags: #go #patterns #level2 #level3 #embedding #context #worker-pool #pipeline*
