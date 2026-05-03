# Structural Patterns in Go

```
╔══════════════════════════════════════════════════════════════════╗
║  Structural = "Kết hợp objects thành cấu trúc lớn hơn"          ║
║  Go: embedding thay inheritance, interface implicit              ║
╚══════════════════════════════════════════════════════════════════╝
```

---

## 1. Adapter — Wrapper Struct

### Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Adapter Pattern                              │
│                                                                  │
│  Client             Adapter                 Adaptee              │
│  ──────             ───────                 ───────              │
│                                                                  │
│  ┌────────┐   ┌─────────────────────┐   ┌──────────────┐       │
│  │        │   │ LegacyCifAdapter    │   │LegacyCIF     │       │
│  │ PDMS   ├──▶│ implements          │──▶│.FetchData()  │       │
│  │ Core   │   │ CustomerRepository  │   │(incompatible)│       │
│  │        │   │ .FindByCIF()        │   └──────────────┘       │
│  └────────┘   └─────────────────────┘                           │
│                                                                  │
│  Interface: CustomerRepository (target — Go interface)           │
│  Adapter: wraps LegacyCIF, converts data format                  │
│  Adaptee: LegacyCIF (legacy, can't modify)                       │
└─────────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package adapter

import (
    "fmt"
    "strings"
)

// ─── Target interface (what PDMS wants) ──────────────────────
type CustomerRepository interface {
    FindByCIF(cif string) (*Customer, error)
    IsActive(cif string) (bool, error)
}

type Customer struct {
    CIF    string
    Name   string
    Phone  string
    Status string
}

// ─── Adaptee (legacy, can't touch) ───────────────────────────
type LegacyCIFClient struct {
    BaseURL string
}

// Returns raw CSV: "CIF001,Nguyen Van A,0901234567,ACTIVE"
func (c *LegacyCIFClient) FetchCustomerData(cifCode string) (string, error) {
    // simulate legacy API
    return fmt.Sprintf("%s,Nguyen Van Bach,0901234567,ACTIVE", cifCode), nil
}

// ─── Adapter ──────────────────────────────────────────────────
type LegacyCIFAdapter struct {
    legacy *LegacyCIFClient
}

func NewLegacyCIFAdapter(baseURL string) CustomerRepository {
    return &LegacyCIFAdapter{
        legacy: &LegacyCIFClient{BaseURL: baseURL},
    }
}

func (a *LegacyCIFAdapter) FindByCIF(cif string) (*Customer, error) {
    raw, err := a.legacy.FetchCustomerData(cif)
    if err != nil {
        return nil, fmt.Errorf("legacy CIF fetch: %w", err)
    }
    return parseCSV(raw)
}

func (a *LegacyCIFAdapter) IsActive(cif string) (bool, error) {
    customer, err := a.FindByCIF(cif)
    if err != nil { return false, err }
    return customer.Status == "ACTIVE", nil
}

func parseCSV(raw string) (*Customer, error) {
    parts := strings.Split(raw, ",")
    if len(parts) != 4 {
        return nil, fmt.Errorf("invalid CSV format: %q", raw)
    }
    return &Customer{
        CIF: parts[0], Name: parts[1],
        Phone: parts[2], Status: parts[3],
    }, nil
}

// ─── Client code ──────────────────────────────────────────────
func ProcessLoan(repo CustomerRepository, cif string) {
    active, err := repo.IsActive(cif)
    if err != nil {
        fmt.Println("Error:", err)
        return
    }
    if active {
        fmt.Printf("Customer %s is active — proceed with loan\n", cif)
    } else {
        fmt.Printf("Customer %s is inactive — reject\n", cif)
    }
}
```

---

## 2. Bridge — Interface Field (Separate Abstraction from Impl)

### Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                      Bridge Pattern                               │
│                                                                   │
│   Abstraction                    Implementation                   │
│   ────────────                   ────────────────                 │
│                                                                   │
│  Notification ◀────────────── MessageSender (interface)          │
│  (has sender)  ╔═════════════╗      △              △             │
│       △        ║   Bridge:   ║      │              │             │
│       │        ║  sender     ║ EmailSender    SlackSender        │
│  AlertNotif    ║  field      ║                                   │
│  ReportNotif   ╚═════════════╝                                   │
│                                                                   │
│  N Notifications × M Senders = N+M (not N×M classes)             │
└──────────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package bridge

import "fmt"

// ─── Implementation side (HOW to send) ───────────────────────
type MessageSender interface {
    Send(recipient, message string) error
    SenderName() string
}

type EmailSender  struct{ SMTPHost string }
type SMSSender    struct{ APIKey string }
type SlackSender  struct{ Webhook string }

func (e *EmailSender) Send(to, msg string) error {
    fmt.Printf("[EMAIL→%s] %s\n", to, msg); return nil
}
func (e *EmailSender) SenderName() string { return "Email" }

func (s *SMSSender) Send(to, msg string) error {
    fmt.Printf("[SMS→%s] %s\n", to, msg[:min(len(msg), 160)]); return nil
}
func (s *SMSSender) SenderName() string { return "SMS" }

func (sl *SlackSender) Send(channel, msg string) error {
    fmt.Printf("[SLACK #%s] %s\n", channel, msg); return nil
}
func (sl *SlackSender) SenderName() string { return "Slack" }

// ─── Abstraction side (WHAT to notify) ───────────────────────
// Bridge: sender field của type MessageSender
type Notification struct {
    sender MessageSender
}

func (n *Notification) Notify(recipient, content string) error {
    return n.sender.Send(recipient, content)
}

// Specialized notifications embed Notification (has bridge)
type AlertNotification struct {
    Notification
    Severity string
}

func NewAlertNotification(sender MessageSender, severity string) *AlertNotification {
    return &AlertNotification{
        Notification: Notification{sender: sender},
        Severity:     severity,
    }
}

func (a *AlertNotification) SendAlert(to, detail string) error {
    msg := fmt.Sprintf("[%s] ALERT: %s", a.Severity, detail)
    return a.Notify(to, msg)
}

type ReportNotification struct {
    Notification
    Schedule string
}

func NewReportNotification(sender MessageSender, schedule string) *ReportNotification {
    return &ReportNotification{
        Notification: Notification{sender: sender},
        Schedule:     schedule,
    }
}

func (r *ReportNotification) SendReport(to, data string) error {
    msg := fmt.Sprintf("[Report @ %s]\n%s", r.Schedule, data)
    return r.Notify(to, msg)
}

func min(a, b int) int {
    if a < b { return a }
    return b
}

// ─── Usage ────────────────────────────────────────────────────
func main() {
    // Mix bất kỳ notification × sender:
    critAlert := NewAlertNotification(
        &SMSSender{APIKey: "sk_xxx"}, "CRITICAL",
    )
    critAlert.SendAlert("+84901234567", "DB pool exhausted")

    weeklyReport := NewReportNotification(
        &SlackSender{Webhook: "https://hooks.slack.com/xxx"},
        "Monday 09:00",
    )
    weeklyReport.SendReport("#engineering", "Uptime: 99.95%")
}
```

---

## 3. Composite — Recursive Interface

### Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                   Composite Tree                              │
│                                                              │
│          Component (interface)                               │
│         ┌──────────────────┐                                 │
│         │ Name() string    │                                 │
│         │ Size() int64     │                                 │
│         │ Print(depth int) │                                 │
│         └────────┬─────────┘                                │
│                  │ implements                                │
│         ┌────────┴────────┐                                 │
│         │                 │                                 │
│      File             Directory                             │
│    (Leaf)           (Composite)                             │
│                   ┌──────────────┐                          │
│                   │children      │                          │
│                   │[]Component   │ ← can hold File OR Dir   │
│                   └──────────────┘                          │
│                                                              │
│  Client treats File and Directory IDENTICALLY                │
└──────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package composite

import "fmt"

// ─── Component interface ──────────────────────────────────────
type FileNode interface {
    Name()  string
    Size()  int64
    Files() int
    Print(depth int)
}

// ─── Leaf ─────────────────────────────────────────────────────
type File struct {
    name string
    size int64
}

func NewFile(name string, size int64) FileNode {
    return &File{name: name, size: size}
}

func (f *File) Name()  string { return f.name }
func (f *File) Size()  int64  { return f.size }
func (f *File) Files() int    { return 1 }
func (f *File) Print(depth int) {
    pad := spaces(depth)
    fmt.Printf("%s📄 %s (%d KB)\n", pad, f.name, f.size/1024)
}

// ─── Composite ────────────────────────────────────────────────
type Directory struct {
    name     string
    children []FileNode
}

func NewDirectory(name string) *Directory {
    return &Directory{name: name}
}

func (d *Directory) Add(node FileNode) {
    d.children = append(d.children, node)
}

func (d *Directory) Name()  string { return d.name }
func (d *Directory) Size()  int64 {
    var total int64
    for _, c := range d.children { total += c.Size() }
    return total
}
func (d *Directory) Files() int {
    total := 0
    for _, c := range d.children { total += c.Files() }
    return total
}
func (d *Directory) Print(depth int) {
    pad := spaces(depth)
    fmt.Printf("%s📁 %s (%d files, %d KB)\n",
        pad, d.name, d.Files(), d.Size()/1024)
    for _, c := range d.children {
        c.Print(depth + 1)
    }
}

func spaces(n int) string {
    s := ""
    for i := 0; i < n*2; i++ { s += " " }
    return s
}

func main() {
    root := NewDirectory("pdms-service")

    src := NewDirectory("src")
    src.Add(NewFile("main.go",   4_096))
    src.Add(NewFile("config.go", 2_048))

    handlers := NewDirectory("handlers")
    handlers.Add(NewFile("loan.go",     8_192))
    handlers.Add(NewFile("document.go", 6_144))
    src.Add(handlers)

    root.Add(src)
    root.Add(NewFile("go.mod",     512))
    root.Add(NewFile("Makefile",   1_024))

    root.Print(0)
    fmt.Printf("\nTotal: %d files, %d KB\n", root.Files(), root.Size()/1024)
}
```

```
📁 pdms-service (5 files, 21 KB)
  📁 src (4 files, 20 KB)
    📄 main.go (4 KB)
    📄 config.go (2 KB)
    📁 handlers (2 files, 14 KB)
      📄 loan.go (8 KB)
      📄 document.go (6 KB)
  📄 go.mod (0 KB)
  📄 Makefile (1 KB)
```

---

## 4. Decorator — Middleware Wrapping Interface

### Diagram

```
┌──────────────────────────────────────────────────────────────┐
│             Decorator Stack (Middleware Pattern)              │
│                                                              │
│  Request ──▶ [Metrics] ──▶ [Logging] ──▶ [Cache] ──▶ Base  │
│                                                              │
│  Each decorator:                                             │
│  - Implements same interface as Base                         │
│  - Holds reference to "next" handler                         │
│  - Can add behavior before/after next.Handle()              │
│                                                              │
│  Onion model:                                                │
│  ┌─ Metrics ─────────────────────────────┐                  │
│  │  ┌─ Logging ──────────────────────┐   │                  │
│  │  │  ┌─ Cache ─────────────────┐   │   │                  │
│  │  │  │   Base Handler          │   │   │                  │
│  │  │  └─────────────────────────┘   │   │                  │
│  │  └───────────────────────────────-┘   │                  │
│  └───────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package decorator

import (
    "fmt"
    "sync"
    "time"
)

// ─── Component interface ──────────────────────────────────────
type DataStore interface {
    Get(key string) (string, error)
    Set(key, value string) error
    Delete(key string) error
}

// ─── Base implementation ──────────────────────────────────────
type InMemoryStore struct {
    mu   sync.RWMutex
    data map[string]string
}

func NewInMemoryStore() DataStore {
    return &InMemoryStore{data: make(map[string]string)}
}

func (s *InMemoryStore) Get(key string) (string, error) {
    s.mu.RLock(); defer s.mu.RUnlock()
    v, ok := s.data[key]
    if !ok { return "", fmt.Errorf("key %q not found", key) }
    return v, nil
}
func (s *InMemoryStore) Set(key, value string) error {
    s.mu.Lock(); defer s.mu.Unlock()
    s.data[key] = value; return nil
}
func (s *InMemoryStore) Delete(key string) error {
    s.mu.Lock(); defer s.mu.Unlock()
    delete(s.data, key); return nil
}

// ─── Decorator 1: Logging ─────────────────────────────────────
type LoggingStore struct {
    inner  DataStore
    prefix string
}

func WithLogging(inner DataStore, prefix string) DataStore {
    return &LoggingStore{inner: inner, prefix: prefix}
}

func (s *LoggingStore) Get(key string) (string, error) {
    v, err := s.inner.Get(key)
    if err != nil {
        fmt.Printf("[%s][GET] key=%s → ERR: %v\n", s.prefix, key, err)
    } else {
        fmt.Printf("[%s][GET] key=%s → %q\n", s.prefix, key, v)
    }
    return v, err
}
func (s *LoggingStore) Set(key, val string) error {
    fmt.Printf("[%s][SET] key=%s val=%q\n", s.prefix, key, val)
    return s.inner.Set(key, val)
}
func (s *LoggingStore) Delete(key string) error {
    fmt.Printf("[%s][DEL] key=%s\n", s.prefix, key)
    return s.inner.Delete(key)
}

// ─── Decorator 2: Metrics ─────────────────────────────────────
type MetricsStore struct {
    inner  DataStore
    reads  int64
    writes int64
    mu     sync.Mutex
}

func WithMetrics(inner DataStore) *MetricsStore {
    return &MetricsStore{inner: inner}
}

func (s *MetricsStore) Get(key string) (string, error) {
    s.mu.Lock(); s.reads++; s.mu.Unlock()
    return s.inner.Get(key)
}
func (s *MetricsStore) Set(key, val string) error {
    s.mu.Lock(); s.writes++; s.mu.Unlock()
    return s.inner.Set(key, val)
}
func (s *MetricsStore) Delete(key string) error {
    s.mu.Lock(); s.writes++; s.mu.Unlock()
    return s.inner.Delete(key)
}
func (s *MetricsStore) Stats() (reads, writes int64) {
    s.mu.Lock(); defer s.mu.Unlock()
    return s.reads, s.writes
}

// ─── Decorator 3: TTL Cache ───────────────────────────────────
type ttlEntry struct{ value string; expiry time.Time }
type CachedStore struct {
    inner DataStore
    cache map[string]ttlEntry
    ttl   time.Duration
    mu    sync.Mutex
}

func WithCache(inner DataStore, ttl time.Duration) DataStore {
    return &CachedStore{
        inner: inner,
        cache: make(map[string]ttlEntry),
        ttl:   ttl,
    }
}

func (s *CachedStore) Get(key string) (string, error) {
    s.mu.Lock()
    if e, ok := s.cache[key]; ok && time.Now().Before(e.expiry) {
        s.mu.Unlock()
        fmt.Printf("[CACHE HIT] %s\n", key)
        return e.value, nil
    }
    s.mu.Unlock()
    v, err := s.inner.Get(key)
    if err == nil {
        s.mu.Lock()
        s.cache[key] = ttlEntry{value: v, expiry: time.Now().Add(s.ttl)}
        s.mu.Unlock()
    }
    return v, err
}
func (s *CachedStore) Set(key, val string) error {
    s.mu.Lock()
    delete(s.cache, key) // invalidate on write
    s.mu.Unlock()
    return s.inner.Set(key, val)
}
func (s *CachedStore) Delete(key string) error {
    s.mu.Lock(); delete(s.cache, key); s.mu.Unlock()
    return s.inner.Delete(key)
}

// ─── Usage: stack decorators ──────────────────────────────────
func main() {
    base := NewInMemoryStore()
    cached  := WithCache(base, 5*time.Minute)
    logged  := WithLogging(cached, "STORE")
    metrics := WithMetrics(logged)

    metrics.Set("user:1", "Nguyen Van Bach")
    metrics.Get("user:1") // cache miss → fetches → caches
    metrics.Get("user:1") // cache hit

    r, w := metrics.Stats()
    fmt.Printf("Reads: %d, Writes: %d\n", r, w)
}
```

---

## 5. Facade — Package Public API

### Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                      Facade Pattern                           │
│                                                              │
│  External code          Facade Package          Subsystems   │
│  ─────────────          ──────────────          ──────────── │
│                         ┌────────────┐                       │
│  import "notify"        │ notify     │──▶ email.Send()       │
│                         │            │──▶ sms.Send()         │
│  notify.LoanApproved()  │ (public    │──▶ template.Render()  │
│  notify.DocRejected()   │  API only) │──▶ ratelimit.Check()  │
│                         │            │──▶ audit.Log()        │
│                         └────────────┘                       │
│                                                              │
│  Client sees 2 clean functions — not 5 subsystems            │
└──────────────────────────────────────────────────────────────┘
```

### Prototype

```go
// Package notify — Facade over notification subsystems
package notify

// internal subsystems (unexported)
import (
    "notify/internal/email"
    "notify/internal/sms"
    "notify/internal/template"
    "notify/internal/ratelimit"
    "notify/internal/audit"
)

// ─── Public Facade API ────────────────────────────────────────
func LoanApproved(userEmail, phone, userID string, amount int64) error {
    if !ratelimit.Check("loan_approved", userID) {
        return nil // silently rate-limit
    }
    body := template.Render("loan_approved",
        map[string]any{"amount": amount})

    if err := email.Send(userEmail, "Loan Approved 🎉", body); err != nil {
        return fmt.Errorf("notify.LoanApproved email: %w", err)
    }
    sms.Send(phone, fmt.Sprintf("VPBank: Loan %dVND approved!", amount))
    audit.Log("loan_approved_notification", userID)
    return nil
}

func DocumentRejected(userEmail, userID, reason string) error {
    body := template.Render("doc_rejected",
        map[string]any{"reason": reason})
    if err := email.Send(userEmail, "Document Rejected", body); err != nil {
        return fmt.Errorf("notify.DocumentRejected: %w", err)
    }
    audit.Log("doc_rejected_notification", userID)
    return nil
}
```

---

## 6. Flyweight — `sync.Map` Shared Cache

### Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    Flyweight Pattern                           │
│                                                              │
│  Without Flyweight:        With Flyweight:                   │
│  1000 spans × 50KB font   1000 spans × 8B pointer           │
│  = 50MB                   + 2 fonts × 50KB = ~100KB          │
│                                                              │
│  FontFactory (sync.Map cache)                                │
│  ┌──────────────────────────────────────────────────┐        │
│  │  "Roboto-12-false" → *FontData (50KB, shared)   │        │
│  │  "Roboto-14-true"  → *FontData (50KB, shared)   │        │
│  └──────────────────────────────────────────────────┘        │
│                    ↑                ↑                        │
│              500 spans        500 spans                      │
│          point to same ptr  point to same ptr                │
└──────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package flyweight

import (
    "fmt"
    "sync"
)

// ─── Intrinsic state — shared, immutable ─────────────────────
type FontData struct {
    Family string
    Size   int
    Bold   bool
    Data   []byte // 50KB binary font
}

// ─── Flyweight Factory with sync.Map ─────────────────────────
type FontFactory struct {
    cache sync.Map // key: "Family-Size-Bold" → *FontData
}

func (f *FontFactory) GetFont(family string, size int, bold bool) *FontData {
    key := fmt.Sprintf("%s-%d-%v", family, size, bold)

    if cached, ok := f.cache.Load(key); ok {
        return cached.(*FontData)
    }

    font := &FontData{
        Family: family,
        Size:   size,
        Bold:   bold,
        Data:   make([]byte, 50_000), // simulate 50KB load
    }
    fmt.Printf("[FontFactory] Loading: %s\n", key)
    actual, _ := f.cache.LoadOrStore(key, font)
    return actual.(*FontData)
}

// ─── Extrinsic state — unique per text span ───────────────────
type TextSpan struct {
    Text     string
    X, Y     float64
    Color    [3]byte
    Font     *FontData // pointer — 8 bytes, not 50KB!
}

func main() {
    factory := &FontFactory{}
    spans := make([]TextSpan, 1000)

    for i := range spans {
        var font *FontData
        if i%2 == 0 {
            font = factory.GetFont("Roboto", 12, false)
        } else {
            font = factory.GetFont("Roboto", 14, true)
        }
        spans[i] = TextSpan{
            Text:  fmt.Sprintf("Span %d", i),
            X:     float64(i) * 10,
            Font:  font,
        }
    }

    fmt.Printf("Total spans: %d\n", len(spans))
    fmt.Println("Fonts loaded: 2 (not 1000)")
    // Memory: 2×50KB vs 1000×50KB without flyweight
}
```

---

## 7. Proxy — Interface Wrapper

### Diagram: 3 Proxy Variants

```
┌──────────────────────────────────────────────────────────────┐
│                  3 Types of Proxy                             │
│                                                              │
│  Virtual Proxy (Lazy Load):                                  │
│  Client ──▶ Proxy.Method() ──[first call]──▶ load() + exec  │
│                             ──[later calls]──▶ cached + exec │
│                                                              │
│  Protection Proxy (Auth):                                    │
│  Client ──▶ Proxy.Method() ──[check role]──▶ Real.Method()  │
│                             ──[denied]────▶ ErrForbidden     │
│                                                              │
│  Cache Proxy:                                                │
│  Client ──▶ Proxy.Get(k) ──[cache hit]──▶ return cached     │
│                           ──[cache miss]─▶ Real.Get(k)       │
│                                       └──▶ store in cache    │
└──────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package proxy

import (
    "fmt"
    "sync"
    "time"
)

// ─── Subject interface ────────────────────────────────────────
type LoanService interface {
    GetLoan(id string) (*Loan, error)
    ApproveLoan(id, approver string) error
}

type Loan struct { ID, Status, ApproverRole string; Amount int64 }

// ─── Real subject ─────────────────────────────────────────────
type RealLoanService struct{}
func (s *RealLoanService) GetLoan(id string) (*Loan, error) {
    return &Loan{ID: id, Status: "PENDING", Amount: 50_000_000}, nil
}
func (s *RealLoanService) ApproveLoan(id, approver string) error {
    fmt.Printf("Loan %s approved by %s\n", id, approver); return nil
}

// ─── Protection Proxy ─────────────────────────────────────────
type AuthLoanProxy struct {
    inner    LoanService
    userRole string
}

func NewAuthProxy(svc LoanService, role string) LoanService {
    return &AuthLoanProxy{inner: svc, userRole: role}
}

func (p *AuthLoanProxy) GetLoan(id string) (*Loan, error) {
    // Everyone can read
    return p.inner.GetLoan(id)
}
func (p *AuthLoanProxy) ApproveLoan(id, approver string) error {
    if p.userRole != "LOAN_OFFICER" && p.userRole != "MANAGER" {
        return fmt.Errorf("role %q cannot approve loans", p.userRole)
    }
    loan, err := p.inner.GetLoan(id)
    if err != nil { return err }
    if loan.Amount > 500_000_000 && p.userRole != "MANAGER" {
        return fmt.Errorf("loans > 500M require MANAGER role")
    }
    return p.inner.ApproveLoan(id, approver)
}

// ─── Cache Proxy ──────────────────────────────────────────────
type CachedLoanProxy struct {
    inner LoanService
    cache map[string]*cacheEntry
    ttl   time.Duration
    mu    sync.Mutex
}

type cacheEntry struct { loan *Loan; expiry time.Time }

func NewCachedProxy(svc LoanService, ttl time.Duration) LoanService {
    return &CachedLoanProxy{inner: svc, cache: make(map[string]*cacheEntry), ttl: ttl}
}

func (p *CachedLoanProxy) GetLoan(id string) (*Loan, error) {
    p.mu.Lock()
    if e, ok := p.cache[id]; ok && time.Now().Before(e.expiry) {
        p.mu.Unlock()
        fmt.Printf("[CACHE HIT] loan:%s\n", id)
        return e.loan, nil
    }
    p.mu.Unlock()

    loan, err := p.inner.GetLoan(id)
    if err == nil {
        p.mu.Lock()
        p.cache[id] = &cacheEntry{loan: loan, expiry: time.Now().Add(p.ttl)}
        p.mu.Unlock()
    }
    return loan, err
}

func (p *CachedLoanProxy) ApproveLoan(id, approver string) error {
    p.mu.Lock(); delete(p.cache, id); p.mu.Unlock() // invalidate
    return p.inner.ApproveLoan(id, approver)
}

// ─── Compose proxies ──────────────────────────────────────────
func main() {
    real    := &RealLoanService{}
    cached  := NewCachedProxy(real, 5*time.Minute)
    authed  := NewAuthProxy(cached, "LOAN_OFFICER")

    loan, _ := authed.GetLoan("LOAN-001")
    fmt.Println(loan)

    err := authed.ApproveLoan("LOAN-001", "NVBach")
    fmt.Println(err)
}
```

---

## 🔗 Links
- [[Design-Patterns-Go/01-Creational|← 01 · Creational]]
- [[Design-Patterns-Go/03-Behavioral|03 · Behavioral →]]

*Tags: #go #design-patterns #structural #adapter #decorator #proxy*
