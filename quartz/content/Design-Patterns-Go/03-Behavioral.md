# Behavioral Patterns in Go

```
╔══════════════════════════════════════════════════════════════════╗
║  Behavioral = "Objects communicate như thế nào?"                 ║
║  Go: channels + goroutines thay đổi nhiều patterns triệt để     ║
╚══════════════════════════════════════════════════════════════════╝
```

---

## 1. Strategy — `func` Type (Go's Killer Feature)

### Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    Strategy Pattern                           │
│                                                              │
│  Context                 Strategy (interface or func type)   │
│  ───────                 ──────────────────────────────────  │
│                                                              │
│  Sorter ──────────▶  type SortFn func(a, b Item) bool       │
│  {strategy: fn}             ↑              ↑                 │
│                       BySalary()     ByName()               │
│                                                              │
│  Go advantage: func types ARE strategies — no interface needed │
│  → closures capture context → stateful strategies for free   │
└──────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package strategy

import (
    "fmt"
    "sort"
)

type Employee struct {
    Name   string
    Salary int64
    Dept   string
    Level  int
}

// ─── Strategy as function type ────────────────────────────────
type SortStrategy func(a, b Employee) bool

// Concrete strategies
func BySalaryAsc(a, b Employee) bool  { return a.Salary < b.Salary }
func BySalaryDesc(a, b Employee) bool { return a.Salary > b.Salary }
func ByName(a, b Employee) bool       { return a.Name < b.Name }
func ByDeptThenSalary(a, b Employee) bool {
    if a.Dept != b.Dept { return a.Dept < b.Dept }
    return a.Salary < b.Salary
}

// Stateful strategy via closure
func BySalaryAbove(threshold int64) SortStrategy {
    return func(a, b Employee) bool {
        aAbove := a.Salary > threshold
        bAbove := b.Salary > threshold
        if aAbove != bAbove { return aAbove } // above threshold first
        return a.Salary > b.Salary
    }
}

// ─── Context ──────────────────────────────────────────────────
type EmployeeList struct {
    employees []Employee
    strategy  SortStrategy
}

func NewEmployeeList(employees []Employee) *EmployeeList {
    return &EmployeeList{employees: employees}
}

func (l *EmployeeList) SetStrategy(s SortStrategy) {
    l.strategy = s
}

func (l *EmployeeList) Sort() {
    if l.strategy == nil { return }
    sort.Slice(l.employees, func(i, j int) bool {
        return l.strategy(l.employees[i], l.employees[j])
    })
}

func (l *EmployeeList) Print() {
    for _, e := range l.employees {
        fmt.Printf("  %-15s Dept:%-10s Salary:%d\n", e.Name, e.Dept, e.Salary)
    }
}

// ─── Strategy as interface (khi strategy có state) ────────────
type PricingStrategy interface {
    Calculate(basePrice int64, qty int) int64
    Name() string
}

type BulkDiscount struct {
    Threshold   int
    DiscountPct int
}
func (b *BulkDiscount) Calculate(price int64, qty int) int64 {
    total := price * int64(qty)
    if qty >= b.Threshold {
        return total * int64(100-b.DiscountPct) / 100
    }
    return total
}
func (b *BulkDiscount) Name() string {
    return fmt.Sprintf("BulkDiscount(≥%d, -%d%%)", b.Threshold, b.DiscountPct)
}

func main() {
    employees := []Employee{
        {Name: "Bach",  Salary: 15_000_000, Dept: "Tech"},
        {Name: "Lan",   Salary: 20_000_000, Dept: "Risk"},
        {Name: "Minh",  Salary: 12_000_000, Dept: "Tech"},
        {Name: "Hoa",   Salary: 25_000_000, Dept: "Risk"},
    }

    list := NewEmployeeList(employees)

    list.SetStrategy(BySalaryDesc)
    list.Sort()
    fmt.Println("By Salary Desc:"); list.Print()

    list.SetStrategy(ByDeptThenSalary)
    list.Sort()
    fmt.Println("By Dept → Salary:"); list.Print()
}
```

---

## 2. Observer — Channel-based Pub/Sub

### Diagram

```
┌──────────────────────────────────────────────────────────────┐
│               Channel-based Event Bus                         │
│                                                              │
│  Publisher              EventBus            Subscribers      │
│  ─────────              ────────            ───────────      │
│                                                              │
│  LoanService ──Publish(event)──▶ EventBus                   │
│                                  │                          │
│                         ┌────────┼────────┐                 │
│                         ▼        ▼        ▼                 │
│                      AuditLog  Notify   Risk                 │
│                      chan<-E   chan<-E  chan<-E               │
│                         │        │        │                  │
│                      goroutine  goroutine  goroutine         │
│                                                              │
│  Vs Java Observer:                                           │
│  ✓ No circular refs — channels own communication             │
│  ✓ Async by default — publishers never block                 │
│  ✓ Backpressure built-in — buffered channels                 │
└──────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package observer

import (
    "context"
    "fmt"
    "sync"
)

// ─── Event types ──────────────────────────────────────────────
type EventType string

const (
    LoanSubmitted EventType = "loan.submitted"
    LoanApproved  EventType = "loan.approved"
    LoanRejected  EventType = "loan.rejected"
    LoanDisbursed EventType = "loan.disbursed"
)

type Event struct {
    Type    EventType
    Payload map[string]any
}

// ─── EventBus ─────────────────────────────────────────────────
type EventBus struct {
    mu          sync.RWMutex
    subscribers map[EventType][]chan Event
}

func NewEventBus() *EventBus {
    return &EventBus{
        subscribers: make(map[EventType][]chan Event),
    }
}

func (b *EventBus) Subscribe(eventType EventType, bufSize int) <-chan Event {
    b.mu.Lock(); defer b.mu.Unlock()
    ch := make(chan Event, bufSize)
    b.subscribers[eventType] = append(b.subscribers[eventType], ch)
    return ch
}

func (b *EventBus) Publish(event Event) {
    b.mu.RLock(); defer b.mu.RUnlock()
    for _, ch := range b.subscribers[event.Type] {
        select {
        case ch <- event: // non-blocking send
        default:
            fmt.Printf("[EventBus] WARN: subscriber slow for %s\n", event.Type)
        }
    }
}

func (b *EventBus) Close() {
    b.mu.Lock(); defer b.mu.Unlock()
    for _, subs := range b.subscribers {
        for _, ch := range subs { close(ch) }
    }
}

// ─── Subscribers ──────────────────────────────────────────────
func RunAuditObserver(ctx context.Context, events <-chan Event) {
    go func() {
        for {
            select {
            case e, ok := <-events:
                if !ok { return }
                fmt.Printf("[AUDIT] %s: %v\n", e.Type, e.Payload)
            case <-ctx.Done():
                return
            }
        }
    }()
}

func RunNotificationObserver(ctx context.Context, events <-chan Event) {
    go func() {
        for {
            select {
            case e, ok := <-events:
                if !ok { return }
                switch e.Type {
                case LoanApproved:
                    fmt.Printf("[NOTIFY] 🎉 Loan %v approved!\n", e.Payload["loan_id"])
                case LoanDisbursed:
                    fmt.Printf("[NOTIFY] 💰 %vVND disbursed to %v\n",
                        e.Payload["amount"], e.Payload["account"])
                }
            case <-ctx.Done():
                return
            }
        }
    }()
}

func main() {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    bus := NewEventBus()

    // Subscribe
    RunAuditObserver(ctx, bus.Subscribe(LoanApproved, 100))
    RunAuditObserver(ctx, bus.Subscribe(LoanDisbursed, 100))
    RunNotificationObserver(ctx, bus.Subscribe(LoanApproved, 100))
    RunNotificationObserver(ctx, bus.Subscribe(LoanDisbursed, 100))

    // Publish
    bus.Publish(Event{
        Type: LoanApproved,
        Payload: map[string]any{"loan_id": "LOAN-001", "approver": "NVBach"},
    })
    bus.Publish(Event{
        Type: LoanDisbursed,
        Payload: map[string]any{"amount": 50_000_000, "account": "ACC-999"},
    })
}
```

---

## 3. State — Interface-Based State Machine

### Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│               State Machine: Loan Workflow                        │
│                                                                  │
│  ┌─────────┐   Submit   ┌───────────┐   StartReview             │
│  │  Draft  │──────────▶ │ Submitted │──────────────▶ ...        │
│  └─────────┘            └───────────┘                            │
│                                                                  │
│  Go implementation:                                              │
│                                                                  │
│  type LoanState interface {                                      │
│      Submit()      (LoanState, error)                            │
│      StartReview() (LoanState, error)                            │
│      Approve()     (LoanState, error)                            │
│      Status()      string                                        │
│  }                                                               │
│                                                                  │
│  type LoanContext struct { state LoanState }                     │
│  func (c *LoanContext) Submit() error {                          │
│      next, err := c.state.Submit()                               │
│      if err == nil { c.state = next }                            │
│      return err                                                  │
│  }                                                               │
└──────────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package state

import (
    "errors"
    "fmt"
)

var (
    ErrInvalidTransition = errors.New("invalid state transition")
)

// ─── State interface ──────────────────────────────────────────
type LoanState interface {
    Submit()      (LoanState, error)
    StartReview() (LoanState, error)
    Approve(approver string) (LoanState, error)
    Reject(reason string)  (LoanState, error)
    Disburse(account string) (LoanState, error)
    Status() string
}

// ─── Concrete states ──────────────────────────────────────────
type baseState struct{}
func (b *baseState) Submit() (LoanState, error)                    { return nil, ErrInvalidTransition }
func (b *baseState) StartReview() (LoanState, error)               { return nil, ErrInvalidTransition }
func (b *baseState) Approve(string) (LoanState, error)             { return nil, ErrInvalidTransition }
func (b *baseState) Reject(string) (LoanState, error)              { return nil, ErrInvalidTransition }
func (b *baseState) Disburse(string) (LoanState, error)            { return nil, ErrInvalidTransition }

type DraftState struct{ baseState }
func (s *DraftState) Submit() (LoanState, error) {
    fmt.Println("  → Submitted")
    return &SubmittedState{}, nil
}
func (s *DraftState) Status() string { return "DRAFT" }

type SubmittedState struct{ baseState }
func (s *SubmittedState) StartReview() (LoanState, error) {
    fmt.Println("  → UnderReview")
    return &UnderReviewState{}, nil
}
func (s *SubmittedState) Status() string { return "SUBMITTED" }

type UnderReviewState struct{ baseState }
func (s *UnderReviewState) Approve(approver string) (LoanState, error) {
    fmt.Printf("  → Approved by %s\n", approver)
    return &ApprovedState{Approver: approver}, nil
}
func (s *UnderReviewState) Reject(reason string) (LoanState, error) {
    fmt.Printf("  → Rejected: %s\n", reason)
    return &RejectedState{Reason: reason}, nil
}
func (s *UnderReviewState) Status() string { return "UNDER_REVIEW" }

type ApprovedState struct{ baseState; Approver string }
func (s *ApprovedState) Disburse(account string) (LoanState, error) {
    fmt.Printf("  → Disbursed to %s\n", account)
    return &DisbursedState{Account: account}, nil
}
func (s *ApprovedState) Status() string { return "APPROVED" }

type RejectedState struct{ baseState; Reason string }
func (s *RejectedState) Status() string { return "REJECTED" }

type DisbursedState struct{ baseState; Account string }
func (s *DisbursedState) Status() string { return "DISBURSED" }

// ─── Context ──────────────────────────────────────────────────
type LoanContext struct {
    ID      string
    state   LoanState
    History []string
}

func NewLoan(id string) *LoanContext {
    return &LoanContext{ID: id, state: &DraftState{}}
}

func (c *LoanContext) transition(next LoanState, err error) error {
    if err != nil {
        return fmt.Errorf("loan %s [%s]: %w", c.ID, c.state.Status(), err)
    }
    c.History = append(c.History, fmt.Sprintf("%s → %s", c.state.Status(), next.Status()))
    c.state = next
    return nil
}

func (c *LoanContext) Submit() error {
    next, err := c.state.Submit()
    return c.transition(next, err)
}
func (c *LoanContext) StartReview() error {
    next, err := c.state.StartReview()
    return c.transition(next, err)
}
func (c *LoanContext) Approve(approver string) error {
    next, err := c.state.Approve(approver)
    return c.transition(next, err)
}
func (c *LoanContext) Disburse(account string) error {
    next, err := c.state.Disburse(account)
    return c.transition(next, err)
}
func (c *LoanContext) Status() string { return c.state.Status() }

func main() {
    loan := NewLoan("LOAN-001")
    fmt.Printf("Status: %s\n", loan.Status())

    steps := []func() error{
        loan.Submit,
        loan.StartReview,
        func() error { return loan.Approve("NVBach") },
        func() error { return loan.Disburse("ACC-123") },
    }
    for _, step := range steps {
        if err := step(); err != nil {
            fmt.Println("Error:", err); break
        }
        fmt.Printf("Status: %s\n", loan.Status())
    }

    // Invalid transition:
    err := loan.Submit() // DisbursedState → Submit → ErrInvalidTransition
    fmt.Println("Expected error:", err)
}
```

---

## 4. Command — Function Type + Undo Queue

### Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                 Command Pattern with Undo                     │
│                                                              │
│  Invoker (Editor)                                            │
│  ┌───────────────────────────────────┐                       │
│  │ history: []Command                │                       │
│  │ redo:    []Command                │                       │
│  │                                   │                       │
│  │ Execute(cmd) ──▶ cmd.Do()         │                       │
│  │                  history.push(cmd)│                       │
│  │ Undo()   ──────▶ cmd = pop        │                       │
│  │                  cmd.Undo()       │                       │
│  │                  redo.push(cmd)   │                       │
│  └───────────────────────────────────┘                       │
│                                                              │
│  Command interface:                                          │
│  type Command interface { Do() error; Undo() error }         │
└──────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package command

import (
    "fmt"
    "sync"
)

// ─── Command interface ────────────────────────────────────────
type Command interface {
    Do() error
    Undo() error
    Name() string
}

// ─── Receiver (document store) ───────────────────────────────
type DocumentStore struct {
    mu   sync.Mutex
    docs map[string]string
}

func NewDocumentStore() *DocumentStore {
    return &DocumentStore{docs: make(map[string]string)}
}
func (s *DocumentStore) Insert(id, content string) {
    s.mu.Lock(); defer s.mu.Unlock()
    s.docs[id] = content
}
func (s *DocumentStore) Delete(id string) string {
    s.mu.Lock(); defer s.mu.Unlock()
    content := s.docs[id]
    delete(s.docs, id)
    return content
}
func (s *DocumentStore) Update(id, content string) (old string) {
    s.mu.Lock(); defer s.mu.Unlock()
    old = s.docs[id]
    s.docs[id] = content
    return old
}

// ─── Concrete commands ────────────────────────────────────────
type InsertDocCmd struct {
    store   *DocumentStore
    id, content string
}
func (c *InsertDocCmd) Do() error {
    fmt.Printf("[CMD] INSERT doc:%s\n", c.id)
    c.store.Insert(c.id, c.content); return nil
}
func (c *InsertDocCmd) Undo() error {
    fmt.Printf("[UNDO] DELETE doc:%s\n", c.id)
    c.store.Delete(c.id); return nil
}
func (c *InsertDocCmd) Name() string { return "InsertDoc:" + c.id }

type UpdateDocCmd struct {
    store    *DocumentStore
    id, newContent, oldContent string
}
func (c *UpdateDocCmd) Do() error {
    fmt.Printf("[CMD] UPDATE doc:%s\n", c.id)
    c.oldContent = c.store.Update(c.id, c.newContent); return nil
}
func (c *UpdateDocCmd) Undo() error {
    fmt.Printf("[UNDO] RESTORE doc:%s\n", c.id)
    c.store.Update(c.id, c.oldContent); return nil
}
func (c *UpdateDocCmd) Name() string { return "UpdateDoc:" + c.id }

// ─── Invoker: editor with undo/redo ───────────────────────────
type DocumentEditor struct {
    history []Command
    future  []Command
}

func (e *DocumentEditor) Execute(cmd Command) error {
    if err := cmd.Do(); err != nil { return err }
    e.history = append(e.history, cmd)
    e.future = nil // clear redo on new command
    return nil
}

func (e *DocumentEditor) Undo() error {
    if len(e.history) == 0 { return fmt.Errorf("nothing to undo") }
    cmd := e.history[len(e.history)-1]
    e.history = e.history[:len(e.history)-1]
    if err := cmd.Undo(); err != nil { return err }
    e.future = append(e.future, cmd)
    return nil
}

func (e *DocumentEditor) Redo() error {
    if len(e.future) == 0 { return fmt.Errorf("nothing to redo") }
    cmd := e.future[len(e.future)-1]
    e.future = e.future[:len(e.future)-1]
    if err := cmd.Do(); err != nil { return err }
    e.history = append(e.history, cmd)
    return nil
}

func main() {
    store  := NewDocumentStore()
    editor := &DocumentEditor{}

    editor.Execute(&InsertDocCmd{store: store, id: "DOC-1", content: "Initial content"})
    editor.Execute(&UpdateDocCmd{store: store, id: "DOC-1", newContent: "Updated content"})
    fmt.Println("After 2 commands")

    editor.Undo()
    fmt.Println("After undo")

    editor.Redo()
    fmt.Println("After redo")
}
```

---

## 5. Template Method — Embedding + Hook Methods

### Diagram

```
┌──────────────────────────────────────────────────────────────┐
│              Template Method in Go                            │
│                                                              │
│  BaseImporter (struct with algorithm skeleton)               │
│  ┌────────────────────────────────────────────────────┐     │
│  │  func (b *BaseImporter) Import(source string) {    │     │
│  │      raw    := b.impl.Fetch(source)      ← hook   │     │
│  │      valid  := b.impl.Validate(raw)      ← hook   │     │
│  │      parsed := b.impl.Parse(valid)       ← hook   │     │
│  │      b.impl.Persist(parsed)              ← hook   │     │
│  │  }                                                 │     │
│  └────────────────────────────────────────────────────┘     │
│                    ↑ implemented by ↑                        │
│          CSVImporter           JSONAPIImporter               │
│          (override hooks)      (override hooks)              │
└──────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package template

import "fmt"

// ─── Hook interface ────────────────────────────────────────────
type ImportHooks interface {
    Fetch(source string) ([]byte, error)
    Parse(raw []byte) ([]Record, error)
    Persist(records []Record) (int, error)
    // Optional hook — has default
    Validate(raw []byte) ([]byte, error)
    Transform(records []Record) []Record
}

type Record struct{ ID, Value string }

// ─── Template (algorithm skeleton) ────────────────────────────
type DataImporter struct {
    hooks ImportHooks
}

func NewDataImporter(hooks ImportHooks) *DataImporter {
    return &DataImporter{hooks: hooks}
}

func (d *DataImporter) Import(source string) (*ImportReport, error) {
    raw, err := d.hooks.Fetch(source)
    if err != nil { return nil, fmt.Errorf("fetch: %w", err) }

    raw, err = d.hooks.Validate(raw)
    if err != nil { return nil, fmt.Errorf("validate: %w", err) }

    records, err := d.hooks.Parse(raw)
    if err != nil { return nil, fmt.Errorf("parse: %w", err) }

    records = d.hooks.Transform(records)

    count, err := d.hooks.Persist(records)
    if err != nil { return nil, fmt.Errorf("persist: %w", err) }

    return &ImportReport{Source: source, Records: count}, nil
}

type ImportReport struct{ Source string; Records int }

// ─── Base hooks with defaults ─────────────────────────────────
type BaseHooks struct{}
func (b *BaseHooks) Validate(raw []byte) ([]byte, error) {
    if len(raw) == 0 { return nil, fmt.Errorf("empty data") }
    return raw, nil
}
func (b *BaseHooks) Transform(records []Record) []Record { return records }

// ─── CSV Importer ─────────────────────────────────────────────
type CSVImporter struct {
    BaseHooks
    dbURL string
}
func (c *CSVImporter) Fetch(source string) ([]byte, error) {
    fmt.Println("  Reading CSV:", source)
    return []byte("id,value\n1,alpha\n2,beta"), nil
}
func (c *CSVImporter) Parse(raw []byte) ([]Record, error) {
    lines := strings.Split(string(raw), "\n")[1:] // skip header
    var records []Record
    for _, line := range lines {
        if line == "" { continue }
        parts := strings.Split(line, ",")
        records = append(records, Record{ID: parts[0], Value: parts[1]})
    }
    return records, nil
}
func (c *CSVImporter) Persist(records []Record) (int, error) {
    fmt.Printf("  Saving %d records to %s\n", len(records), c.dbURL)
    return len(records), nil
}
// Override Validate for CSV-specific check:
func (c *CSVImporter) Validate(raw []byte) ([]byte, error) {
    if !strings.HasPrefix(string(raw), "id,") {
        return nil, fmt.Errorf("invalid CSV: missing header")
    }
    return raw, nil
}

func main() {
    csvImporter := NewDataImporter(&CSVImporter{dbURL: "postgres://localhost/pdms"})
    report, err := csvImporter.Import("data/loans.csv")
    if err != nil { fmt.Println("Error:", err); return }
    fmt.Printf("✓ Imported %d records from %s\n", report.Records, report.Source)
}
```

---

## 6. Chain of Responsibility — Middleware Pipeline

### Diagram

```
┌───────────────────────────────────────────────────────────────┐
│              HTTP Middleware Chain                             │
│                                                               │
│  Request                                                      │
│    │                                                          │
│    ▼                                                          │
│  ┌──────────┐   next()   ┌──────────┐   next()              │
│  │ Logger   │──────────▶ │  Auth    │──────────▶ ...        │
│  └──────────┘            └──────────┘                        │
│       │                       │                              │
│       │ (after next returns)  │ (if auth fails: return)      │
│       ▼                       ▼                              │
│  Response                 401 Error                          │
│                                                              │
│  Each middleware:                                            │
│  type Middleware func(HandlerFunc) HandlerFunc               │
└───────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package chain

import (
    "fmt"
    "net/http"
    "time"
)

// ─── Middleware type ──────────────────────────────────────────
type Middleware func(http.Handler) http.Handler

// ─── Concrete middlewares ─────────────────────────────────────
func LoggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        fmt.Printf("[LOG] %s %s\n", r.Method, r.URL.Path)
        next.ServeHTTP(w, r)
        fmt.Printf("[LOG] %s %s → %v\n", r.Method, r.URL.Path, time.Since(start))
    })
}

func AuthMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token := r.Header.Get("Authorization")
        if token == "" || !strings.HasPrefix(token, "Bearer ") {
            http.Error(w, "Unauthorized", http.StatusUnauthorized)
            return
        }
        next.ServeHTTP(w, r)
    })
}

func RateLimitMiddleware(rps int) Middleware {
    return func(next http.Handler) http.Handler {
        limiter := time.NewTicker(time.Second / time.Duration(rps))
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            select {
            case <-limiter.C:
                next.ServeHTTP(w, r)
            default:
                http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
            }
        })
    }
}

// ─── Chain builder ────────────────────────────────────────────
func Chain(middlewares ...Middleware) Middleware {
    return func(final http.Handler) http.Handler {
        for i := len(middlewares) - 1; i >= 0; i-- {
            final = middlewares[i](final)
        }
        return final
    }
}

// ─── Usage ────────────────────────────────────────────────────
func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/api/loans", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintln(w, `{"status":"ok"}`)
    })

    chain := Chain(
        LoggingMiddleware,
        AuthMiddleware,
        RateLimitMiddleware(100),
    )

    http.ListenAndServe(":8080", chain(mux))
}
```

---

## 7. Iterator — `range` + Channel Generator

```go
package iterator

// ─── Channel-based Iterator (lazy, cancellable) ───────────────
func FibonacciStream(ctx context.Context) <-chan uint64 {
    ch := make(chan uint64)
    go func() {
        defer close(ch)
        a, b := uint64(0), uint64(1)
        for {
            select {
            case <-ctx.Done(): return
            case ch <- a:
                a, b = b, a+b
            }
        }
    }()
    return ch
}

func main() {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    for n := range FibonacciStream(ctx) {
        if n > 1_000_000 { break }
        fmt.Println(n)
    }
}

// ─── Generic Iterator with Go 1.18+ ──────────────────────────
type Iterator[T any] interface {
    HasNext() bool
    Next() T
}

type SliceIterator[T any] struct {
    data []T
    pos  int
}

func NewSliceIterator[T any](data []T) Iterator[T] {
    return &SliceIterator[T]{data: data}
}
func (it *SliceIterator[T]) HasNext() bool { return it.pos < len(it.data) }
func (it *SliceIterator[T]) Next() T {
    v := it.data[it.pos]; it.pos++; return v
}
```

---

## Behavioral Patterns — Summary

```
┌────────────────────┬──────────────────────────────────────────┐
│ Pattern            │ Go Idiom + Key Insight                   │
├────────────────────┼──────────────────────────────────────────┤
│ Strategy           │ func type / interface — closures are free │
│ Observer           │ channel pub/sub — no circular refs        │
│ State              │ interface per state + context struct      │
│ Command            │ interface{Do,Undo} + history slice        │
│ Template Method    │ embedding + hook interface                │
│ Chain of Resp      │ func(Handler)Handler — middleware         │
│ Iterator           │ range + channel generator                 │
│ Mediator           │ EventBus with channels                    │
│ Visitor            │ interface{Accept} + double dispatch       │
│ Memento            │ JSON snapshot + deep copy                 │
│ Interpreter        │ recursive AST structs + Eval()           │
└────────────────────┴──────────────────────────────────────────┘
```

---

## 🔗 Links
- [[Design-Patterns-Go/02-Structural|← 02 · Structural]]
- [[Design-Patterns-Go/05-Level1-Foundations|Level 1 · Foundations →]]

*Tags: #go #design-patterns #behavioral #observer #state #strategy*
