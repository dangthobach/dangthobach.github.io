# Creational Patterns in Go

```
╔══════════════════════════════════════════════════════════════╗
║  Creational = "Ai tạo object? Tạo như thế nào? Khi nào?"    ║
║  Go: không có constructor — dùng New...() function + iface   ║
╚══════════════════════════════════════════════════════════════╝
```

---

## 1. Singleton — `sync.Once`

### Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                     Singleton Flow                            │
│                                                              │
│  First call          Subsequent calls                        │
│  ──────────          ────────────────                        │
│  sync.Once.Do()  ──▶ initialize()    ▶ instance             │
│                                                              │
│  sync.Once.Do()  ──▶ [SKIPPED]       ▶ instance (same ptr)  │
│  sync.Once.Do()  ──▶ [SKIPPED]       ▶ instance (same ptr)  │
│                                                              │
│  Thread-safe: Do() uses atomic + mutex internally            │
│  Zero-cost after init: just read a pointer                   │
└──────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package config

import (
    "sync"
    "os"
)

type AppConfig struct {
    DatabaseURL string
    RedisAddr   string
    MaxWorkers  int
    Debug       bool
}

var (
    instance *AppConfig
    once     sync.Once
)

// GetConfig returns the singleton instance — thread-safe
func GetConfig() *AppConfig {
    once.Do(func() {
        instance = &AppConfig{
            DatabaseURL: getEnv("DATABASE_URL", "postgres://localhost/dev"),
            RedisAddr:   getEnv("REDIS_ADDR", "localhost:6379"),
            MaxWorkers:  20,
            Debug:       os.Getenv("DEBUG") == "true",
        }
    })
    return instance
}

func getEnv(key, fallback string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return fallback
}

// ─── Usage ────────────────────────────────────────────────────
// cfg := config.GetConfig()
// fmt.Println(cfg.DatabaseURL)
```

```go
// ─── Singleton với reset cho testing ──────────────────────────
// Pattern: expose reset func (test only)
type dbPool struct { /* ... */ }
var (
    pool     *dbPool
    poolOnce sync.Once
)

func GetPool() *dbPool {
    poolOnce.Do(func() { pool = initPool() })
    return pool
}

// ResetForTest — only call in tests
func ResetForTest() {
    pool = nil
    poolOnce = sync.Once{} // safe: reassign before parallel tests
}
```

### ✅ Anti-pattern Cảnh Báo
```
❌ var instance *Config — race condition!
❌ if instance == nil { instance = new } — double-checked locking sai cách
✅ sync.Once — Go stdlib, idiomatic, proven safe
✅ Hoặc: init() function + package-level var (simpler for read-only config)
```

---

## 2. Factory Method — Interface + `New()` Function

### Diagram

```
┌───────────────────────────────────────────────────────────────┐
│                   Factory Method Flow                          │
│                                                               │
│   Client                  Factory           Product           │
│   ──────                  ───────           ───────           │
│     │                        │                 │              │
│     │──── NewNotifier() ────▶│                 │              │
│     │      (type="email")    │──── &Email{} ──▶│              │
│     │                        │                 │              │
│     │──── notifier.Send() ───┼─────────────────▶             │
│     │                        │                               │
│   Client only knows Notifier interface — not Email/SMS impl   │
└───────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package notification

import "fmt"

// ─── Product interface ────────────────────────────────────────
type Notifier interface {
    Send(to, subject, body string) error
    Name() string
}

// ─── Concrete products ────────────────────────────────────────
type EmailNotifier struct {
    smtpHost string
    port     int
}
func (e *EmailNotifier) Send(to, subject, body string) error {
    fmt.Printf("[EMAIL via %s:%d] To:%s | %s\n", e.smtpHost, e.port, to, subject)
    return nil
}
func (e *EmailNotifier) Name() string { return "email" }

type SMSNotifier struct {
    apiKey string
    maxLen int
}
func (s *SMSNotifier) Send(to, subject, body string) error {
    msg := body
    if len(msg) > s.maxLen { msg = msg[:s.maxLen] }
    fmt.Printf("[SMS] To:%s | %s\n", to, msg)
    return nil
}
func (s *SMSNotifier) Name() string { return "sms" }

type SlackNotifier struct {
    webhook string
}
func (sl *SlackNotifier) Send(to, subject, body string) error {
    fmt.Printf("[SLACK] #%s | %s: %s\n", to, subject, body)
    return nil
}
func (sl *SlackNotifier) Name() string { return "slack" }

// ─── Factory function ─────────────────────────────────────────
func NewNotifier(kind string, opts ...string) (Notifier, error) {
    switch kind {
    case "email":
        host := "smtp.gmail.com"
        if len(opts) > 0 { host = opts[0] }
        return &EmailNotifier{smtpHost: host, port: 587}, nil
    case "sms":
        if len(opts) == 0 { return nil, fmt.Errorf("sms: api key required") }
        return &SMSNotifier{apiKey: opts[0], maxLen: 160}, nil
    case "slack":
        if len(opts) == 0 { return nil, fmt.Errorf("slack: webhook required") }
        return &SlackNotifier{webhook: opts[0]}, nil
    default:
        return nil, fmt.Errorf("unknown notifier type: %q", kind)
    }
}

// ─── Usage ────────────────────────────────────────────────────
func main() {
    notifier, err := NewNotifier("email", "smtp.vpbank.com")
    if err != nil { panic(err) }

    notifier.Send("bach@vpbank.com", "Loan Approved", "Your loan #001 is approved!")
}
```

---

## 3. Abstract Factory — Interface of Interfaces

### Diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                   Abstract Factory                                  │
│                                                                     │
│  UIFactory (interface)                                              │
│  ┌──────────────────────────────────┐                              │
│  │ CreateButton()  → Button (iface) │                              │
│  │ CreateInput()   → Input  (iface) │                              │
│  │ CreateModal()   → Modal  (iface) │                              │
│  └──────────────────────────────────┘                              │
│           △                    △                                   │
│           │                    │                                   │
│  LightFactory           DarkFactory                                │
│  (concrete)             (concrete)                                 │
│  ┌──────────────┐      ┌──────────────┐                           │
│  │LightButton   │      │DarkButton    │                           │
│  │LightInput    │      │DarkInput     │                           │
│  │LightModal    │      │DarkModal     │                           │
│  └──────────────┘      └──────────────┘                           │
│                                                                     │
│  Client code uses UIFactory only — theme is swappable at runtime   │
└────────────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package ui

import "fmt"

// ─── Abstract products ────────────────────────────────────────
type Button interface {
    Render() string
    OnClick(handler func())
}
type Input interface {
    Render() string
    Placeholder() string
}
type Modal interface {
    Show(title, content string)
}

// ─── Abstract factory ─────────────────────────────────────────
type UIFactory interface {
    CreateButton(label string)     Button
    CreateInput(placeholder string) Input
    CreateModal()                  Modal
    ThemeName()                    string
}

// ─── Light theme ──────────────────────────────────────────────
type LightButton struct{ label string }
func (b *LightButton) Render() string { return fmt.Sprintf("[ ☀ %s ]", b.label) }
func (b *LightButton) OnClick(h func()) { h() }

type LightInput struct{ ph string }
func (i *LightInput) Render() string      { return fmt.Sprintf("☀ [________] hint: %s", i.ph) }
func (i *LightInput) Placeholder() string { return i.ph }

type LightModal struct{}
func (m *LightModal) Show(title, content string) {
    fmt.Printf("╔══ ☀ %s ══╗\n  %s\n╚═══════════╝\n", title, content)
}

type LightFactory struct{}
func (f *LightFactory) CreateButton(label string) Button       { return &LightButton{label} }
func (f *LightFactory) CreateInput(ph string) Input            { return &LightInput{ph} }
func (f *LightFactory) CreateModal() Modal                     { return &LightModal{} }
func (f *LightFactory) ThemeName() string                      { return "Light" }

// ─── Dark theme ───────────────────────────────────────────────
type DarkButton struct{ label string }
func (b *DarkButton) Render() string { return fmt.Sprintf("【 🌙 %s 】", b.label) }
func (b *DarkButton) OnClick(h func()) { h() }

type DarkInput struct{ ph string }
func (i *DarkInput) Render() string      { return fmt.Sprintf("🌙 ▓▓▓▓▓▓▓▓ hint: %s", i.ph) }
func (i *DarkInput) Placeholder() string { return i.ph }

type DarkModal struct{}
func (m *DarkModal) Show(title, content string) {
    fmt.Printf("▓▓▓ 🌙 %s ▓▓▓\n  %s\n▓▓▓▓▓▓▓▓▓▓▓\n", title, content)
}

type DarkFactory struct{}
func (f *DarkFactory) CreateButton(label string) Button   { return &DarkButton{label} }
func (f *DarkFactory) CreateInput(ph string) Input        { return &DarkInput{ph} }
func (f *DarkFactory) CreateModal() Modal                 { return &DarkModal{} }
func (f *DarkFactory) ThemeName() string                  { return "Dark" }

// ─── Factory registry ─────────────────────────────────────────
func NewUIFactory(theme string) UIFactory {
    switch theme {
    case "dark":  return &DarkFactory{}
    default:      return &LightFactory{}
    }
}

// ─── Client code ──────────────────────────────────────────────
func RenderLoginForm(factory UIFactory) {
    fmt.Printf("\n=== Theme: %s ===\n", factory.ThemeName())

    emailInput  := factory.CreateInput("your@email.com")
    submitBtn   := factory.CreateButton("Login")
    confirmDlg  := factory.CreateModal()

    fmt.Println(emailInput.Render())
    fmt.Println(submitBtn.Render())
    submitBtn.OnClick(func() {
        confirmDlg.Show("Success", "Login successful!")
    })
}
```

---

## 4. Builder — Functional Options (Rob Pike Pattern) ⭐

### Diagram: Hai Dạng Builder Trong Go

```
┌─────────────────────────────────────────────────────────────┐
│  Dạng 1: Classic Builder (verbose, Java-like)               │
│                                                             │
│  b := NewServerBuilder()                                    │
│     .Host("localhost")                                      │
│     .Port(8080)                                             │
│     .Timeout(30*time.Second)                               │
│     .Build()                                                │
│                                                             │
│  Vấn đề: Builder struct riêng biệt, nhiều code              │
├─────────────────────────────────────────────────────────────┤
│  Dạng 2: Functional Options (Go idiomatic) ✅               │
│                                                             │
│  type Option func(*Server)                                  │
│       ↑                                                     │
│  WithHost("localhost")──┐                                   │
│  WithPort(8080)─────────┼──▶ NewServer(opt1, opt2, opt3)   │
│  WithTimeout(30s)───────┘         ↓                        │
│                                *Server (configured)         │
│                                                             │
│  Ưu điểm:                                                   │
│  ✓ Defaults handled internally                              │
│  ✓ Backward compatible (add options without breaking)       │
│  ✓ Self-documenting                                         │
└─────────────────────────────────────────────────────────────┘
```

### Prototype: Functional Options

```go
package server

import (
    "crypto/tls"
    "net/http"
    "time"
)

// ─── Server config ────────────────────────────────────────────
type Server struct {
    host        string
    port        int
    timeout     time.Duration
    maxConns    int
    tlsConfig   *tls.Config
    middlewares []func(http.Handler) http.Handler
    logger      Logger
}

// Option là function nhận *Server và modify nó
type Option func(*Server)

// ─── Option constructors (exported, discoverable) ─────────────
func WithHost(host string) Option {
    return func(s *Server) { s.host = host }
}
func WithPort(port int) Option {
    return func(s *Server) { s.port = port }
}
func WithTimeout(d time.Duration) Option {
    return func(s *Server) { s.timeout = d }
}
func WithMaxConns(n int) Option {
    return func(s *Server) { s.maxConns = n }
}
func WithTLS(cert, key string) Option {
    return func(s *Server) {
        cfg, err := tls.LoadX509KeyPair(cert, key)
        if err != nil { panic(err) }
        s.tlsConfig = &tls.Config{Certificates: []tls.Certificate{cfg}}
    }
}
func WithMiddleware(m func(http.Handler) http.Handler) Option {
    return func(s *Server) { s.middlewares = append(s.middlewares, m) }
}
func WithLogger(l Logger) Option {
    return func(s *Server) { s.logger = l }
}

// ─── Constructor với defaults + apply options ─────────────────
func NewServer(opts ...Option) *Server {
    s := &Server{
        host:     "0.0.0.0",
        port:     8080,
        timeout:  30 * time.Second,
        maxConns: 1000,
        logger:   defaultLogger{},
    }
    for _, opt := range opts {
        opt(s)  // apply each option
    }
    return s
}

func (s *Server) Addr() string {
    return fmt.Sprintf("%s:%d", s.host, s.port)
}

// ─── Usage ────────────────────────────────────────────────────
// Minimal (all defaults):
srv := server.NewServer()

// Custom:
srv := server.NewServer(
    server.WithHost("api.vpbank.com"),
    server.WithPort(443),
    server.WithTimeout(10 * time.Second),
    server.WithTLS("/certs/server.crt", "/certs/server.key"),
    server.WithMiddleware(authMiddleware),
    server.WithMiddleware(loggingMiddleware),
)

// Backward compatible: add new option without breaking existing callers
// Old: NewServer(WithHost("x"), WithPort(80))
// New: NewServer(WithHost("x"), WithPort(80), WithNewFeature(val))
// → Old callers don't need to change
```

---

## 5. Prototype — `Clone()` Interface

### Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    Prototype Pattern                          │
│                                                              │
│  Original ──Clone()──▶ Clone1                               │
│                  └────▶ Clone2 ──Modify──▶ Clone2-modified  │
│                  └────▶ Clone3                               │
│                                                              │
│  Shallow copy: field values copied (pointers shared)         │
│  Deep copy:   entire object tree duplicated                  │
│                                                              │
│  Go: No built-in clone — implement Clone() method           │
│  Or: encoding/json round-trip for deep copy (slow)          │
│  Or: copier library (reflect-based)                          │
└──────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package main

import (
    "encoding/json"
    "fmt"
)

// ─── Cloneable interface ──────────────────────────────────────
type Cloneable[T any] interface {
    Clone() T
}

// ─── Query template (shallow clone sufficient) ────────────────
type QueryTemplate struct {
    Table      string
    Conditions []string
    Fields     []string
    Limit      *int
    OrderBy    string
}

func NewQueryTemplate(table string) *QueryTemplate {
    return &QueryTemplate{
        Table:  table,
        Fields: []string{"*"},
    }
}

// Clone tạo deep copy — Conditions slice mới
func (q *QueryTemplate) Clone() *QueryTemplate {
    conds := make([]string, len(q.Conditions))
    copy(conds, q.Conditions)

    fields := make([]string, len(q.Fields))
    copy(fields, q.Fields)

    clone := *q // copy all fields (shallow)
    clone.Conditions = conds  // replace with deep copies
    clone.Fields = fields
    if q.Limit != nil {
        n := *q.Limit
        clone.Limit = &n
    }
    return &clone
}

func (q *QueryTemplate) Where(cond string) *QueryTemplate {
    q.Conditions = append(q.Conditions, cond)
    return q
}

func (q *QueryTemplate) WithLimit(n int) *QueryTemplate {
    q.Limit = &n
    return q
}

func (q *QueryTemplate) ToSQL() string {
    sql := fmt.Sprintf("SELECT %s FROM %s", 
        strings.Join(q.Fields, ", "), q.Table)
    if len(q.Conditions) > 0 {
        sql += " WHERE " + strings.Join(q.Conditions, " AND ")
    }
    if q.Limit != nil {
        sql += fmt.Sprintf(" LIMIT %d", *q.Limit)
    }
    return sql
}

// ─── JSON deep copy helper (generic, slow but simple) ─────────
func DeepCopy[T any](src T) (T, error) {
    var dst T
    data, err := json.Marshal(src)
    if err != nil { return dst, err }
    return dst, json.Unmarshal(data, &dst)
}

func main() {
    // Base template
    base := NewQueryTemplate("loans").
        Where("status = 'active'")

    // Clone và customize — không ảnh hưởng base
    adminQ := base.Clone().
        Where("user_role = 'admin'").
        WithLimit(50)

    recentQ := base.Clone().
        Where("created_at > NOW() - INTERVAL '7 days'")

    fmt.Println(base.ToSQL())
    // SELECT * FROM loans WHERE status = 'active'
    fmt.Println(adminQ.ToSQL())
    // SELECT * FROM loans WHERE status = 'active' AND user_role = 'admin' LIMIT 50
    fmt.Println(recentQ.ToSQL())
    // SELECT * FROM loans WHERE status = 'active' AND created_at > ...
}
```

---

## Creational Patterns — So Sánh Nhanh

```
┌────────────────┬──────────────────────────────────────────────────┐
│ Situation      │ Pattern + Go Idiom                               │
├────────────────┼──────────────────────────────────────────────────┤
│ 1 instance     │ Singleton → sync.Once + package var              │
│ Create by type │ Factory   → switch + interface return            │
│ Family types   │ AbsFctry  → interface of factories               │
│ Complex config │ Builder   → Functional Options (preferred)       │
│ Copy + tweak   │ Prototype → Clone() method with deep copy        │
└────────────────┴──────────────────────────────────────────────────┘
```

---

## 🔗 Links
- [[Design-Patterns-Go/00-Overview|Series Overview]]
- [[Design-Patterns-Go/02-Structural|02 · Structural Patterns →]]
- [[Go-Zero-To-Hero/Bai-6-Interfaces-Generics|Bài 6: Interfaces & Generics]]

*Tags: #go #design-patterns #creational #functional-options #singleton*
