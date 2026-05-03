# Level 4 · Architecture Patterns

```
╔══════════════════════════════════════════════════════════════════╗
║  Principal Gopher level: distributed, resilient, observable     ║
╚══════════════════════════════════════════════════════════════════╝
```

---

## 1. Circuit Breaker — Fail Fast, Recover Gracefully

### Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                   Circuit Breaker State Machine                   │
│                                                                  │
│    ┌─────────────────────────────────────────────────────┐      │
│    │                                                      │      │
│    ▼    failures >= threshold                             │      │
│  CLOSED ────────────────────────────▶ OPEN               │      │
│  (normal)                            (fail fast)         │      │
│                                          │               │      │
│                                   after timeout          │      │
│                                          │               │      │
│                                          ▼               │      │
│                                    HALF-OPEN  ───success──┘      │
│                                    (try 1 req)                   │
│                                          │                       │
│                                       failure                    │
│                                          │                       │
│                                          ▼                       │
│                                        OPEN again                │
│                                                                  │
│  Benefit: stop calling dead service → fail fast → faster error   │
│           protect downstream from cascade failure                │
└──────────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package circuitbreaker

import (
    "errors"
    "fmt"
    "sync"
    "time"
)

type State int

const (
    StateClosed   State = iota // Normal operation
    StateOpen                  // Failing fast
    StateHalfOpen              // Testing recovery
)

func (s State) String() string {
    return [...]string{"CLOSED", "OPEN", "HALF-OPEN"}[s]
}

var ErrCircuitOpen = errors.New("circuit breaker: open — service unavailable")

type CircuitBreaker struct {
    mu             sync.Mutex
    state          State
    failureCount   int
    successCount   int
    lastFailure    time.Time

    maxFailures    int           // threshold to OPEN
    timeout        time.Duration // OPEN → HALF-OPEN wait
    halfOpenLimit  int           // max probes in HALF-OPEN
}

func New(maxFailures int, timeout time.Duration) *CircuitBreaker {
    return &CircuitBreaker{
        maxFailures:   maxFailures,
        timeout:       timeout,
        halfOpenLimit: 1,
    }
}

func (cb *CircuitBreaker) Execute(fn func() error) error {
    cb.mu.Lock()
    state := cb.currentState()
    
    if state == StateOpen {
        cb.mu.Unlock()
        return ErrCircuitOpen // fail fast — no call made
    }
    cb.mu.Unlock()

    err := fn() // execute the operation

    cb.mu.Lock()
    defer cb.mu.Unlock()

    if err != nil {
        cb.recordFailure()
        return err
    }
    cb.recordSuccess()
    return nil
}

func (cb *CircuitBreaker) currentState() State {
    if cb.state == StateOpen {
        if time.Since(cb.lastFailure) >= cb.timeout {
            cb.state = StateHalfOpen
            cb.successCount = 0
            fmt.Printf("[CB] %s → HALF-OPEN (testing recovery)\n", StateOpen)
        }
    }
    return cb.state
}

func (cb *CircuitBreaker) recordFailure() {
    cb.failureCount++
    cb.lastFailure = time.Now()

    switch cb.state {
    case StateClosed:
        if cb.failureCount >= cb.maxFailures {
            cb.state = StateOpen
            fmt.Printf("[CB] CLOSED → OPEN (failures: %d/%d)\n",
                cb.failureCount, cb.maxFailures)
        }
    case StateHalfOpen:
        cb.state = StateOpen
        fmt.Println("[CB] HALF-OPEN → OPEN (probe failed)")
    }
}

func (cb *CircuitBreaker) recordSuccess() {
    cb.failureCount = 0
    if cb.state == StateHalfOpen {
        cb.successCount++
        if cb.successCount >= cb.halfOpenLimit {
            cb.state = StateClosed
            fmt.Println("[CB] HALF-OPEN → CLOSED (recovered!)")
        }
    }
}

func (cb *CircuitBreaker) State() State {
    cb.mu.Lock(); defer cb.mu.Unlock()
    return cb.state
}

// ─── Usage in HTTP client ─────────────────────────────────────
type ResilientCIFClient struct {
    cb      *CircuitBreaker
    client  *http.Client
    baseURL string
}

func NewResilientCIFClient(baseURL string) *ResilientCIFClient {
    return &ResilientCIFClient{
        cb:      New(5, 30*time.Second), // open after 5 failures, retry after 30s
        client:  &http.Client{Timeout: 5 * time.Second},
        baseURL: baseURL,
    }
}

func (c *ResilientCIFClient) Fetch(ctx context.Context, cif string) (*Customer, error) {
    var result *Customer
    err := c.cb.Execute(func() error {
        resp, err := c.client.Get(fmt.Sprintf("%s/cif/%s", c.baseURL, cif))
        if err != nil { return err }
        defer resp.Body.Close()
        if resp.StatusCode >= 500 { return fmt.Errorf("server error: %d", resp.StatusCode) }
        return json.NewDecoder(resp.Body).Decode(&result)
    })
    if errors.Is(err, ErrCircuitOpen) {
        return nil, fmt.Errorf("CIF service unavailable (circuit open)")
    }
    return result, err
}
```

---

## 2. Rate Limiter — Token Bucket

### Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    Token Bucket Algorithm                         │
│                                                                  │
│  Bucket capacity = 100 tokens                                    │
│  Refill rate     = 10 tokens/second                              │
│                                                                  │
│  t=0:  [████████████] 100 tokens                                 │
│  t=0:  Request  → consume 1 → 99 tokens  ✓                      │
│  t=0:  Request  → consume 1 → 98 tokens  ✓                      │
│        ... (100 rapid requests)                                  │
│  t=0:  Request  → 0 tokens   → WAIT/REJECT  ✗                   │
│  t=0.1: refill  +1 token                                         │
│  t=1:  [██] +10 tokens refilled                                  │
│                                                                  │
│  Go stdlib: golang.org/x/time/rate.Limiter                       │
│  rate.NewLimiter(rate.Every(100ms), 10)   10 req/s, burst 10    │
└──────────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package ratelimiter

import (
    "context"
    "fmt"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

// ─── Simple rate limiter using golang.org/x/time/rate ─────────
type RateLimiter struct {
    limiter *rate.Limiter
}

func NewRateLimiter(rps int, burst int) *RateLimiter {
    return &RateLimiter{
        limiter: rate.NewLimiter(rate.Limit(rps), burst),
    }
}

func (rl *RateLimiter) Allow() bool {
    return rl.limiter.Allow()
}

func (rl *RateLimiter) Wait(ctx context.Context) error {
    return rl.limiter.Wait(ctx) // blocks until token available or ctx cancelled
}

// ─── Per-user rate limiter ────────────────────────────────────
type PerUserLimiter struct {
    mu       sync.Mutex
    limiters map[string]*rate.Limiter
    rps      rate.Limit
    burst    int
}

func NewPerUserLimiter(rps float64, burst int) *PerUserLimiter {
    return &PerUserLimiter{
        limiters: make(map[string]*rate.Limiter),
        rps:      rate.Limit(rps),
        burst:    burst,
    }
}

func (pl *PerUserLimiter) getLimiter(userID string) *rate.Limiter {
    pl.mu.Lock(); defer pl.mu.Unlock()
    l, ok := pl.limiters[userID]
    if !ok {
        l = rate.NewLimiter(pl.rps, pl.burst)
        pl.limiters[userID] = l
    }
    return l
}

func (pl *PerUserLimiter) Allow(userID string) bool {
    return pl.getLimiter(userID).Allow()
}

// ─── Middleware integration ────────────────────────────────────
func RateLimitMiddleware(limiter *PerUserLimiter) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            userID, _ := UserIDFrom(r.Context())
            if !limiter.Allow(userID) {
                w.Header().Set("Retry-After", "1")
                http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

---

## 3. Graceful Shutdown Pattern

### Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                   Graceful Shutdown Flow                          │
│                                                                  │
│  SIGTERM/SIGINT received                                         │
│       │                                                          │
│       ▼                                                          │
│  1. Stop accepting new connections                               │
│       │                                                          │
│       ▼                                                          │
│  2. Signal all goroutines: cancel context                        │
│       │                                                          │
│       ▼                                                          │
│  3. Wait for in-flight requests to complete (timeout: 30s)       │
│       │                                                          │
│       ▼                                                          │
│  4. Flush buffers / finish writes                                │
│       │                                                          │
│       ▼                                                          │
│  5. Close DB connections, message queues                         │
│       │                                                          │
│       ▼                                                          │
│  6. Exit 0                                                       │
└──────────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package main

import (
    "context"
    "fmt"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func main() {
    // ─── Setup ────────────────────────────────────────────────
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    db, err := db.New(ctx, dbConfig)
    if err != nil { panic(err) }
    defer db.Close()

    kafka, err := kafka.NewConsumer(ctx, kafkaConfig)
    if err != nil { panic(err) }

    mux := setupRoutes(db)
    srv := &http.Server{
        Addr:    ":8080",
        Handler: mux,
    }

    // ─── Start services in goroutines ─────────────────────────
    go func() {
        fmt.Println("HTTP server starting on :8080")
        if err := srv.ListenAndServe(); err != http.ErrServerClosed {
            fmt.Println("HTTP server error:", err)
            cancel() // trigger shutdown on unexpected error
        }
    }()

    go func() {
        if err := kafka.Consume(ctx, handleMessage); err != nil {
            fmt.Println("Kafka consumer error:", err)
        }
    }()

    // ─── Wait for shutdown signal ─────────────────────────────
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

    select {
    case sig := <-sigCh:
        fmt.Printf("\nReceived signal: %s — initiating graceful shutdown\n", sig)
    case <-ctx.Done():
        fmt.Println("Context cancelled — shutting down")
    }

    // ─── Graceful shutdown ────────────────────────────────────
    shutdownCtx, shutdownCancel := context.WithTimeout(
        context.Background(), 30*time.Second,
    )
    defer shutdownCancel()

    // 1. Stop HTTP server (drains in-flight requests)
    fmt.Println("Stopping HTTP server...")
    if err := srv.Shutdown(shutdownCtx); err != nil {
        fmt.Println("HTTP shutdown error:", err)
    }

    // 2. Cancel context → stops Kafka consumer + workers
    cancel()

    // 3. Wait for consumers to finish
    fmt.Println("Waiting for consumers...")
    kafka.WaitStop()

    // 4. DB closes via defer db.Close()
    fmt.Println("Shutdown complete")
}
```

---

## 4. Health Check Pattern

```go
// ─── Health check aggregator ──────────────────────────────────
package health

import (
    "context"
    "net/http"
    "sync"
    "time"
)

type Status string
const (
    StatusUp   Status = "UP"
    StatusDown Status = "DOWN"
)

type CheckResult struct {
    Name    string        `json:"name"`
    Status  Status        `json:"status"`
    Message string        `json:"message,omitempty"`
    Latency time.Duration `json:"latency_ms"`
}

type Checker interface {
    Name() string
    Check(ctx context.Context) error
}

type HealthHandler struct {
    checkers []Checker
}

func New(checkers ...Checker) *HealthHandler {
    return &HealthHandler{checkers: checkers}
}

func (h *HealthHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    results := make([]CheckResult, len(h.checkers))
    var wg sync.WaitGroup
    overallUp := true

    for i, checker := range h.checkers {
        i, checker := i, checker
        wg.Add(1)
        go func() {
            defer wg.Done()
            start := time.Now()
            err := checker.Check(ctx)
            latency := time.Since(start)

            if err != nil {
                overallUp = false
                results[i] = CheckResult{
                    Name: checker.Name(), Status: StatusDown,
                    Message: err.Error(), Latency: latency,
                }
            } else {
                results[i] = CheckResult{
                    Name: checker.Name(), Status: StatusUp, Latency: latency,
                }
            }
        }()
    }
    wg.Wait()

    status := http.StatusOK
    if !overallUp { status = http.StatusServiceUnavailable }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(map[string]any{
        "status":  map[bool]Status{true: StatusUp, false: StatusDown}[overallUp],
        "checks": results,
    })
}

// ─── Concrete checkers ────────────────────────────────────────
type DBChecker struct{ pool *db.Pool }
func (c *DBChecker) Name() string { return "database" }
func (c *DBChecker) Check(ctx context.Context) error {
    return c.pool.Ping(ctx)
}

type RedisChecker struct{ client *redis.Client }
func (c *RedisChecker) Name() string { return "redis" }
func (c *RedisChecker) Check(ctx context.Context) error {
    return c.client.Ping(ctx).Err()
}

// Setup:
// mux.Handle("/health", health.New(
//     &DBChecker{pool: db},
//     &RedisChecker{client: redis},
// ))
```

---

## 5. Retry with Exponential Backoff

### Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                Exponential Backoff                                │
│                                                                  │
│  Attempt 1: call()  → fail  → wait 100ms                        │
│  Attempt 2: call()  → fail  → wait 200ms                        │
│  Attempt 3: call()  → fail  → wait 400ms + jitter               │
│  Attempt 4: call()  → fail  → wait 800ms + jitter               │
│  ...until maxAttempts or success                                 │
│                                                                  │
│  Jitter: random ±20% → prevent thundering herd                  │
│  (all retrying at same time → even more load on struggling srv)  │
└──────────────────────────────────────────────────────────────────┘
```

### Prototype

```go
package retry

import (
    "context"
    "errors"
    "math"
    "math/rand"
    "time"
)

type RetryConfig struct {
    MaxAttempts int
    InitialWait time.Duration
    MaxWait     time.Duration
    Multiplier  float64
    Jitter      float64 // 0.0-1.0: fraction of wait to randomize
}

var DefaultConfig = RetryConfig{
    MaxAttempts: 3,
    InitialWait: 100 * time.Millisecond,
    MaxWait:     30 * time.Second,
    Multiplier:  2.0,
    Jitter:      0.2,
}

// IsRetryable: func determines if error should trigger retry
type IsRetryable func(error) bool

func AlwaysRetry(err error) bool { return err != nil }
func RetryOnServerError(err error) bool {
    var httpErr *HTTPError
    if errors.As(err, &httpErr) {
        return httpErr.StatusCode >= 500
    }
    return true
}

func Do(ctx context.Context, cfg RetryConfig, retryable IsRetryable, fn func() error) error {
    var lastErr error
    wait := cfg.InitialWait

    for attempt := 0; attempt < cfg.MaxAttempts; attempt++ {
        if attempt > 0 {
            // Apply jitter: wait ± jitter fraction
            jitter := time.Duration(float64(wait) * cfg.Jitter * (rand.Float64()*2 - 1))
            sleepFor := wait + jitter
            if sleepFor < 0 { sleepFor = 0 }

            select {
            case <-time.After(sleepFor):
            case <-ctx.Done():
                return fmt.Errorf("retry cancelled: %w", ctx.Err())
            }

            // Exponential backoff
            wait = time.Duration(float64(wait) * cfg.Multiplier)
            if wait > cfg.MaxWait { wait = cfg.MaxWait }
        }

        lastErr = fn()
        if lastErr == nil { return nil }
        if !retryable(lastErr) { return lastErr } // non-retryable: fail fast

        fmt.Printf("[RETRY] attempt %d/%d failed: %v\n",
            attempt+1, cfg.MaxAttempts, lastErr)
    }

    return fmt.Errorf("all %d attempts failed: %w", cfg.MaxAttempts, lastErr)
}

// ─── Usage ────────────────────────────────────────────────────
func fetchWithRetry(ctx context.Context, url string) ([]byte, error) {
    var result []byte
    err := retry.Do(ctx, retry.DefaultConfig, retry.AlwaysRetry, func() error {
        resp, err := http.Get(url)
        if err != nil { return err }
        defer resp.Body.Close()
        result, err = io.ReadAll(resp.Body)
        return err
    })
    return result, err
}
```

---

## Level 4 Checklist

```
□ Circuit Breaker bảo vệ outbound calls (CIF service, payment gateway)
□ Rate limiter tại API gateway và per-user
□ Graceful shutdown: SIGTERM → drain → close resources → exit 0
□ Health endpoint aggregates all dependencies với timeout
□ Retry với exponential backoff + jitter (không retry on 4xx)
□ Metrics exposed: Prometheus /metrics endpoint
□ Distributed tracing: OpenTelemetry spans qua context
□ Config management: environment variables với validation at startup
□ Structured logging với correlation IDs từ context
□ Dead letter queue cho messages cannot be processed after N retries
```

---

## Full Go Design Patterns Series

```
GoF Patterns:
  [[Design-Patterns-Go/01-Creational]]   5 patterns
  [[Design-Patterns-Go/02-Structural]]   7 patterns
  [[Design-Patterns-Go/03-Behavioral]]   11 patterns

Idiomatic Patterns:
  [[Design-Patterns-Go/05-Level1-Foundations]]  Functional Options · Errors · Tests
  [[Design-Patterns-Go/06-Level2-Level3]]        Embedding · Context · Worker Pool · Pipeline
  [[Design-Patterns-Go/08-Level4-Architecture]]  Circuit Breaker · Rate Limit · Shutdown
```

---

## 🔗 Links
- [[Design-Patterns-Go/06-Level2-Level3|← Level 2 & 3]]
- [[Design-Patterns-Go/00-Overview|Series Overview]]
- [[Go-Zero-To-Hero/Bai-3-Goroutines-Channels|Bài 3: Goroutines & Channels]]
- [[Go-Zero-To-Hero/Bai-7-Context-Cancellation|Bài 7: Context & Cancellation]]
- [[Go-Zero-To-Hero/Bai-22-Microservices-Patterns|Bài 22: Microservices Patterns]]

*Tags: #go #patterns #level4 #circuit-breaker #rate-limiter #graceful-shutdown*
