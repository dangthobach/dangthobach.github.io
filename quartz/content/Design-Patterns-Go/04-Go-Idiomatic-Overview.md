# Go Idiomatic Patterns — Beyond GoF

```
╔═══════════════════════════════════════════════════════════════════╗
║   "A little copying is better than a little dependency"           ║
║   "Clear is better than clever"  — Go Proverbs                   ║
╚═══════════════════════════════════════════════════════════════════╝
```

---

## Tại Sao Go Có Patterns Riêng?

```
┌──────────────────────────────────────────────────────────────────┐
│  Go thiết kế cho:                                                 │
│                                                                   │
│  1. Large teams → explicit > implicit → simple patterns          │
│  2. Network services → goroutines first-class                    │
│  3. Operational simplicity → single binary, minimal deps         │
│  4. Readability at scale → patterns must be scannable            │
│                                                                   │
│  Điều này tạo ra patterns đặc trưng:                              │
│  ✓ Functional Options (không có Builder class riêng)             │
│  ✓ Embedding (không có inheritance)                              │
│  ✓ Error as value (không có exception hierarchy)                 │
│  ✓ Goroutine patterns (unique to CSP model)                      │
└──────────────────────────────────────────────────────────────────┘
```

---

## Skill Level Map

```
┌──────────────────────────────────────────────────────────────────┐
│  LEVEL 1 · FOUNDATIONS                                           │
│  Functional Options · Error Wrapping · Table-Driven              │
│  Init Guard · Variadic Config · Package Constructor              │
│                                           Target: Junior Gopher  │
├──────────────────────────────────────────────────────────────────┤
│  LEVEL 2 · IDIOMATIC                                             │
│  Middleware Chain · Context Propagation · Embedding              │
│  Generator · Interface Segregation · Retry/Timeout              │
│                                           Target: Mid Gopher     │
├──────────────────────────────────────────────────────────────────┤
│  LEVEL 3 · CONCURRENCY                                           │
│  Worker Pool · Pipeline · Fan-out/Fan-in                         │
│  Semaphore · Done Channel · Pub/Sub · Backpressure               │
│                                           Target: Senior Gopher  │
├──────────────────────────────────────────────────────────────────┤
│  LEVEL 4 · ARCHITECTURE                                          │
│  Circuit Breaker · Rate Limiter · Saga/Outbox                   │
│  CQRS · Event Sourcing · Health Check · Graceful Shutdown        │
│                                           Target: Principal      │
└──────────────────────────────────────────────────────────────────┘
```

---

## Patterns Unique to Go (không thấy ở Java/Rust)

```
★ Functional Options     — Rob Pike pattern, backward-compatible config
★ Error Wrapping (%w)    — fmt.Errorf với tracing, errors.Is/As
★ Table-Driven Tests     — pattern test idiom của Go community
★ Done Channel           — cancellation signal pattern
★ Pipeline (chan-based)  — stage processing via channels
★ Fan-out/Fan-in         — Go scheduler exploitation
★ Embedding Promotion    — composition that "feels like" inheritance
★ Error Sentinel         — var ErrNotFound = errors.New(...)
★ Blank Identifier       — _ for side effects, interface check
```

---

## 🔗 Series Articles

- [[Design-Patterns-Go/05-Level1-Foundations|Level 1 · Foundations]]
- [[Design-Patterns-Go/06-Level2-Idiomatic|Level 2 · Idiomatic]]
- [[Design-Patterns-Go/07-Level3-Concurrency|Level 3 · Concurrency]]
- [[Design-Patterns-Go/08-Level4-Architecture|Level 4 · Architecture]]

*Tags: #go #patterns #idiomatic #concurrency*
