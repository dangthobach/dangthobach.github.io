# Level 1 · Foundations

```
╔══════════════════════════════════════════════════════════════╗
║  Target: Junior Gopher — code compiles AND is Go-idiomatic  ║
╚══════════════════════════════════════════════════════════════╝
```

---

## 1. Functional Options — Rob Pike's Pattern ⭐

### Diagram

```
┌──────────────────────────────────────────────────────────────┐
│              Functional Options: How It Works                 │
│                                                              │
│  type Option func(*Server)  ← Option is just a function      │
│                                                              │
│  WithPort(8080) ──────▶ func(s *Server) { s.port = 8080 }   │
│  WithTimeout(10s) ────▶ func(s *Server) { s.timeout = 10s } │
│  WithTLS(cert,key) ───▶ func(s *Server) { s.tls = ... }     │
│                                           │                  │
│                                           ▼                  │
│  NewServer(opts...) {                                        │
│      s := &Server{/*defaults*/}                              │
│      for _, opt := range opts { opt(s) }  ← apply each      │
│      return s                                                │
│  }                                                           │
│                                                              │
│  Benefits:                                                   │
│  ✓ Defaults hidden inside NewServer                          │
│  ✓ Add new option = no breaking change                       │
│  ✓ Self-documenting: WithTimeout > timeout param             │
│  ✓ Options are functions = testable independently            │
└──────────────────────────────────────────────────────────────┘
```

### Prototype: Full Implementation

```go
package httpserver

import (
    "crypto/tls"
    "fmt"
    "net/http"
    "time"
)

// ─── Config struct (unexported fields = options control access) ─
type Server struct {
    host        string
    port        int
    readTimeout time.Duration
    writeTimeout time.Duration
    maxConns    int
    tlsConfig   *tls.Config
    logger      Logger
    middlewares []func(http.Handler) http.Handler
}

// ─── Option type ──────────────────────────────────────────────
type Option func(*Server) error  // use error variant for validation

// ─── Option constructors ──────────────────────────────────────
func WithHost(host string) Option {
    return func(s *Server) error {
        if host == "" { return fmt.Errorf("host cannot be empty") }
        s.host = host
        return nil
    }
}

func WithPort(port int) Option {
    return func(s *Server) error {
        if port < 1 || port > 65535 {
            return fmt.Errorf("port %d out of range [1-65535]", port)
        }
        s.port = port
        return nil
    }
}

func WithTimeout(read, write time.Duration) Option {
    return func(s *Server) error {
        s.readTimeout = read
        s.writeTimeout = write
        return nil
    }
}

func WithMaxConns(n int) Option {
    return func(s *Server) error {
        if n <= 0 { return fmt.Errorf("maxConns must be > 0") }
        s.maxConns = n
        return nil
    }
}

func WithTLS(certFile, keyFile string) Option {
    return func(s *Server) error {
        cert, err := tls.LoadX509KeyPair(certFile, keyFile)
        if err != nil { return fmt.Errorf("tls: %w", err) }
        s.tlsConfig = &tls.Config{
            Certificates: []tls.Certificate{cert},
            MinVersion:   tls.VersionTLS13,
        }
        return nil
    }
}

func WithMiddleware(m func(http.Handler) http.Handler) Option {
    return func(s *Server) error {
        s.middlewares = append(s.middlewares, m)
        return nil
    }
}

// ─── Constructor with defaults ────────────────────────────────
func NewServer(opts ...Option) (*Server, error) {
    s := &Server{
        host:         "0.0.0.0",
        port:         8080,
        readTimeout:  30 * time.Second,
        writeTimeout: 30 * time.Second,
        maxConns:     1000,
        logger:       &defaultLogger{},
    }
    for _, opt := range opts {
        if err := opt(s); err != nil {
            return nil, fmt.Errorf("server config: %w", err)
        }
    }
    return s, nil
}

func (s *Server) Addr() string { return fmt.Sprintf("%s:%d", s.host, s.port) }

// ─── Usage ────────────────────────────────────────────────────
// Minimal — all defaults:
srv, _ := httpserver.NewServer()

// Production:
srv, err := httpserver.NewServer(
    httpserver.WithHost("0.0.0.0"),
    httpserver.WithPort(443),
    httpserver.WithTimeout(10*time.Second, 30*time.Second),
    httpserver.WithTLS("/etc/certs/server.crt", "/etc/certs/server.key"),
    httpserver.WithMaxConns(5000),
    httpserver.WithMiddleware(authMiddleware),
)
```

---

## 2. Error Wrapping & Sentinel Errors

### Diagram

```
┌──────────────────────────────────────────────────────────────┐
│              Error Chain (fmt.Errorf %w)                      │
│                                                              │
│  Low level:  sqlx.Error{"connection refused"}                │
│       ▲                                                      │
│       │ wrapped by                                           │
│  Mid level:  "loan repo: find by id: connection refused"     │
│       ▲                                                      │
│       │ wrapped by                                           │
│  Top level:  "handle get loan: loan repo: find by id: ..."   │
│                                                              │
│  errors.Is(err, sql.ErrNoRows)  → unwrap chain to check      │
│  errors.As(err, &myErrType)     → unwrap chain to extract    │
│                                                              │
│  Sentinel errors:                                            │
│  var ErrNotFound = errors.New("not found")  ← package-level │
│  if errors.Is(err, ErrNotFound) { ... }     ← type-safe      │
└──────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package errors_pattern

import (
    "database/sql"
    "errors"
    "fmt"
)

// ─── Sentinel errors (package-level, comparable) ──────────────
var (
    ErrNotFound     = errors.New("not found")
    ErrUnauthorized = errors.New("unauthorized")
    ErrConflict     = errors.New("conflict: resource already exists")
)

// ─── Typed errors (with context) ──────────────────────────────
type ValidationError struct {
    Field   string
    Message string
}
func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation: field %q: %s", e.Field, e.Message)
}

type NotFoundError struct {
    Resource string
    ID       string
}
func (e *NotFoundError) Error() string {
    return fmt.Sprintf("%s %q not found", e.Resource, e.ID)
}
func (e *NotFoundError) Is(target error) bool {
    return target == ErrNotFound // allow errors.Is(err, ErrNotFound)
}

// ─── Error wrapping in layers ─────────────────────────────────
func findLoanInDB(id string) (*Loan, error) {
    row := db.QueryRow("SELECT * FROM loans WHERE id = $1", id)
    var loan Loan
    if err := row.Scan(&loan.ID, &loan.Amount); err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, &NotFoundError{Resource: "loan", ID: id}
        }
        return nil, fmt.Errorf("db scan: %w", err) // wrap with context
    }
    return &loan, nil
}

func getLoan(id string) (*Loan, error) {
    loan, err := findLoanInDB(id)
    if err != nil {
        return nil, fmt.Errorf("loan repo: %w", err) // add layer context
    }
    return loan, nil
}

func handleGetLoan(id string) {
    loan, err := getLoan(id)
    if err != nil {
        // Check specific error type:
        if errors.Is(err, ErrNotFound) {
            fmt.Println("404:", err)
            return
        }
        var ve *ValidationError
        if errors.As(err, &ve) {
            fmt.Println("400:", ve.Field, ve.Message)
            return
        }
        fmt.Println("500:", err)
        return
    }
    fmt.Println("Found:", loan)
}
```

---

## 3. Table-Driven Tests — Go's Testing Superpower

### Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                  Table-Driven Test                            │
│                                                              │
│  tests := []struct {                                         │
│      name    string     ← test case name (t.Run)            │
│      input   SomeType   ← input to function                  │
│      want    SomeType   ← expected output                    │
│      wantErr bool       ← expect error?                      │
│  }{                                                          │
│      {name: "happy path", input: ..., want: ...},            │
│      {name: "error case", input: ..., wantErr: true},        │
│      {name: "edge: zero", input: 0, want: 0},               │
│  }                                                           │
│                                                              │
│  for _, tt := range tests {                                  │
│      t.Run(tt.name, func(t *testing.T) {                     │
│          got, err := fn(tt.input)                            │
│          if (err != nil) != tt.wantErr { t.Error(...) }      │
│          if got != tt.want { t.Errorf(...) }                 │
│      })                                                      │
│  }                                                           │
│                                                              │
│  go test -run TestFoo/happy_path -v  ← filter specific case │
└──────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package patterns_test

import (
    "testing"
    "errors"
)

func TestParseAge(t *testing.T) {
    tests := []struct {
        name    string
        input   string
        want    int
        wantErr bool
    }{
        {name: "valid age",      input: "25",   want: 25,  wantErr: false},
        {name: "minimum",        input: "1",    want: 1,   wantErr: false},
        {name: "maximum",        input: "100",  want: 100, wantErr: false},
        {name: "zero",           input: "0",    want: 0,   wantErr: true},
        {name: "negative",       input: "-1",   want: 0,   wantErr: true},
        {name: "over max",       input: "101",  want: 0,   wantErr: true},
        {name: "not a number",   input: "abc",  want: 0,   wantErr: true},
        {name: "empty string",   input: "",     want: 0,   wantErr: true},
        {name: "whitespace",     input: " 25 ", want: 25,  wantErr: false},
    }

    for _, tt := range tests {
        tt := tt // capture range var (pre-Go 1.22)
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel() // run in parallel

            got, err := ParseAge(tt.input)
            if (err != nil) != tt.wantErr {
                t.Errorf("ParseAge(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
                return
            }
            if got != tt.want {
                t.Errorf("ParseAge(%q) = %d, want %d", tt.input, got, tt.want)
            }
        })
    }
}

// ─── Table-driven with subtests + mock ───────────────────────
func TestLoanService_Approve(t *testing.T) {
    tests := []struct {
        name      string
        loanID    string
        approver  string
        setupMock func(*MockLoanRepo)
        wantErr   error
    }{
        {
            name: "success",
            loanID: "LOAN-1", approver: "Bach",
            setupMock: func(m *MockLoanRepo) {
                m.On("Find", "LOAN-1").Return(&Loan{ID: "LOAN-1", Status: "REVIEW"}, nil)
                m.On("Update", mock.AnythingOfType("*Loan")).Return(nil)
            },
        },
        {
            name: "loan not found",
            loanID: "LOAN-X", approver: "Bach",
            setupMock: func(m *MockLoanRepo) {
                m.On("Find", "LOAN-X").Return(nil, ErrNotFound)
            },
            wantErr: ErrNotFound,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            repo := &MockLoanRepo{}
            tt.setupMock(repo)
            svc := NewLoanService(repo)

            err := svc.Approve(context.Background(), tt.loanID, tt.approver)
            if !errors.Is(err, tt.wantErr) {
                t.Errorf("Approve() error = %v, wantErr %v", err, tt.wantErr)
            }
            repo.AssertExpectations(t)
        })
    }
}
```

---

## 4. Package Constructor & Init Guard

### Diagram

```
┌──────────────────────────────────────────────────────────────┐
│          Package Constructor Pattern                          │
│                                                              │
│  package db                                                  │
│                                                              │
│  type Pool struct {                                          │
│      conn *pgxpool.Pool  ← unexported: encapsulated         │
│  }                                                           │
│                                                              │
│  func New(ctx context.Context, cfg Config) (*Pool, error) {  │
│      // validate config                                      │
│      // connect                                              │
│      // ping                                                 │
│      return &Pool{conn: pool}, nil                           │
│  }                                                           │
│                                                              │
│  Convention:                                                 │
│  New()     → single constructor                              │
│  NewXxx()  → multiple constructors                           │
│  MustNew() → panics on error (use only in main/init)        │
└──────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package db

import (
    "context"
    "fmt"
    "time"
)

// ─── Unexported struct ────────────────────────────────────────
type Pool struct {
    pool    *pgxpool.Pool
    metrics *dbMetrics
}

type Config struct {
    Host     string
    Port     int
    Database string
    User     string
    Password string
    MaxConns int32
    MinConns int32
}

// ─── Constructor ──────────────────────────────────────────────
func New(ctx context.Context, cfg Config) (*Pool, error) {
    if cfg.Host == "" { return nil, fmt.Errorf("db: host required") }
    if cfg.Database == "" { return nil, fmt.Errorf("db: database required") }

    dsn := fmt.Sprintf("postgres://%s:%s@%s:%d/%s",
        cfg.User, cfg.Password, cfg.Host, cfg.Port, cfg.Database)

    poolCfg, err := pgxpool.ParseConfig(dsn)
    if err != nil { return nil, fmt.Errorf("db: parse config: %w", err) }

    poolCfg.MaxConns = cfg.MaxConns
    poolCfg.MinConns = cfg.MinConns
    poolCfg.MaxConnLifetime = 1 * time.Hour

    pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
    if err != nil { return nil, fmt.Errorf("db: create pool: %w", err) }

    // Verify connection
    if err := pool.Ping(ctx); err != nil {
        pool.Close()
        return nil, fmt.Errorf("db: ping failed: %w", err)
    }

    return &Pool{pool: pool, metrics: newMetrics()}, nil
}

// MustNew — panics on error, use only in main()
func MustNew(ctx context.Context, cfg Config) *Pool {
    p, err := New(ctx, cfg)
    if err != nil { panic(err) }
    return p
}

func (p *Pool) Close() { p.pool.Close() }
func (p *Pool) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
    return p.pool.Query(ctx, sql, args...)
}
```

---

## 5. Blank Identifier Patterns

```go
// ─── Pattern 1: Interface compliance check at compile time ───
var _ io.Writer    = (*MyWriter)(nil)    // compile error if not implemented
var _ http.Handler = (*MyHandler)(nil)
var _ LoanService  = (*LoanServiceImpl)(nil) // ensures impl stays in sync

// ─── Pattern 2: Side-effect import ───────────────────────────
import _ "github.com/lib/pq"              // register postgres driver
import _ "net/http/pprof"                 // register pprof handlers

// ─── Pattern 3: Ignore specific return values ─────────────────
n, _ := fmt.Println("hello")   // ignore error
_, ok := myMap["key"]           // ignore value, check existence
for _, v := range slice { ... } // ignore index
```

---

## Level 1 Checklist

```
□ Functional Options cho mọi configurable struct (không bare config struct)
□ error wrapping với fmt.Errorf("context: %w", err) luôn add context
□ Sentinel errors: var ErrXxx = errors.New(...) cho package-level errors
□ errors.Is / errors.As thay vì == và type assertion trực tiếp
□ Table-driven tests với t.Run và t.Parallel
□ Constructor: New() returns (*Type, error) — không panic
□ MustNew() chỉ dùng trong main() hoặc TestMain
□ var _ Interface = (*Impl)(nil) để verify compile-time
□ Hiểu khi nào dùng pointer receiver vs value receiver
```

---

## 🔗 Links
- [[Design-Patterns-Go/04-Go-Idiomatic-Overview|Overview]]
- [[Design-Patterns-Go/06-Level2-Idiomatic|Level 2 · Idiomatic →]]

*Tags: #go #patterns #level1 #functional-options #errors #testing*
