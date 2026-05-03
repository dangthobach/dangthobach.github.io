# Go Design Patterns — Series Overview

```
╔══════════════════════════════════════════════════════════════════════╗
║          GO vs OOP: Triết Lý Nền Tảng Khác Hoàn Toàn               ║
╠══════════════════════════════════════════════════════════════════════╣
║  Java/C++              →         Go                                 ║
║  ─────────────────────────────────────────────────────────────────  ║
║  class + inheritance   →   struct + interface + embedding           ║
║  abstract class        →   interface with default via embedding     ║
║  interface (explicit)  →   interface (IMPLICIT — duck typing)       ║
║  constructor           →   New...() function convention             ║
║  try/catch             →   (value, error) tuple return              ║
║  generics (complex)    →   generics since 1.18 (simpler)            ║
║  thread pool           →   goroutines (lightweight, M:N)            ║
║  callback hell         →   channel-based CSP                        ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

## Go Interface: Duck Typing Thay Đổi Mọi Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                   Implicit Interface (Go)                        │
│                                                                  │
│   type Writer interface {          struct File {                 │
│       Write([]byte) (int, error)       // ...                   │
│   }                                }                            │
│                                    func (f *File) Write(        │
│                                        p []byte,                │
│                                    ) (int, error) { ... }       │
│                                                                  │
│   File automatically satisfies Writer — no "implements" needed! │
│                                                                  │
│   Consequence: ANY type with matching methods = satisfies iface  │
│   → Patterns designed differently — looser coupling by default  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 23 GoF Patterns — Go Transformation Map

### 🏗️ Creational
```
┌────────────────┬─────────────────────────────────┬─────────────┐
│ Pattern        │ Go Idiom                         │ Difficulty  │
├────────────────┼─────────────────────────────────┼─────────────┤
│ Singleton      │ sync.Once + package-level var    │ ⭐⭐         │
│ Factory Method │ New...() + interface return      │ ⭐⭐         │
│ Abstract Fctry │ Interface of interfaces          │ ⭐⭐⭐        │
│ Builder        │ Functional Options (Rob Pike)    │ ⭐⭐⭐        │
│ Prototype      │ Clone() method / deep copy util  │ ⭐⭐         │
└────────────────┴─────────────────────────────────┴─────────────┘
```

### 🔧 Structural
```
┌────────────────┬─────────────────────────────────┬─────────────┐
│ Pattern        │ Go Idiom                         │ Difficulty  │
├────────────────┼─────────────────────────────────┼─────────────┤
│ Adapter        │ Wrapper struct + interface impl  │ ⭐⭐         │
│ Bridge         │ Interface field in struct        │ ⭐⭐⭐        │
│ Composite      │ Recursive interface              │ ⭐⭐⭐        │
│ Decorator      │ Middleware wrapping interface    │ ⭐⭐         │
│ Facade         │ Package with clean public API    │ ⭐           │
│ Flyweight      │ sync.Map cache + shared structs  │ ⭐⭐         │
│ Proxy          │ Interface wrapper + embedding    │ ⭐⭐⭐        │
└────────────────┴─────────────────────────────────┴─────────────┘
```

### 🎭 Behavioral
```
┌──────────────────┬───────────────────────────────┬─────────────┐
│ Pattern          │ Go Idiom                       │ Difficulty  │
├──────────────────┼───────────────────────────────┼─────────────┤
│ Chain of Resp    │ Middleware []Handler           │ ⭐⭐         │
│ Command          │ func() / interface Execute()  │ ⭐⭐         │
│ Iterator         │ range + channel stream         │ ⭐           │
│ Mediator         │ chan-based event bus           │ ⭐⭐⭐        │
│ Memento          │ JSON snapshot / deep copy      │ ⭐⭐         │
│ Observer         │ channel pub/sub                │ ⭐⭐⭐        │
│ State            │ State interface + context      │ ⭐⭐⭐        │
│ Strategy         │ func type / interface          │ ⭐⭐         │
│ Template Method  │ Embedding + override           │ ⭐⭐         │
│ Visitor          │ interface Accept/Visit         │ ⭐⭐⭐        │
│ Interpreter      │ Recursive struct + Eval()      │ ⭐⭐⭐        │
└──────────────────┴───────────────────────────────┴─────────────┘
```

---

## Go-Idiomatic Patterns (Beyond GoF)

```
┌────────────────────────────────────────────────────────────────────┐
│  LEVEL 1 · FOUNDATIONS          Target: Junior Gopher              │
│  ──────────────────────────────────────────────────────────────    │
│  Functional Options · Init Guard · Error Wrapping                  │
│  Table-Driven · Variadic Config · Package Constructor              │
├────────────────────────────────────────────────────────────────────┤
│  LEVEL 2 · IDIOMATIC            Target: Mid Gopher                 │
│  ──────────────────────────────────────────────────────────────    │
│  Middleware Chain · Context Propagation · Options Pattern Adv.     │
│  Embed Composition · Interface Segregation · Generator             │
├────────────────────────────────────────────────────────────────────┤
│  LEVEL 3 · CONCURRENCY          Target: Senior Gopher              │
│  ──────────────────────────────────────────────────────────────    │
│  Worker Pool · Pipeline · Fan-out/Fan-in                           │
│  Semaphore · Pub/Sub · Done Channel · Timeout/Retry                │
├────────────────────────────────────────────────────────────────────┤
│  LEVEL 4 · ARCHITECTURE         Target: Principal Gopher           │
│  ──────────────────────────────────────────────────────────────    │
│  Circuit Breaker · Rate Limiter · Saga (Outbox)                    │
│  CQRS Read Model · Event Sourcing · Backpressure                   │
└────────────────────────────────────────────────────────────────────┘
```

---

## Patterns Unique to Go's Concurrency Model

```
┌──────────────────────────────────────────────────────────────────┐
│  CSP: Communicating Sequential Processes                          │
│                                                                  │
│  Goroutine A ──chan──▶ Goroutine B ──chan──▶ Goroutine C         │
│                                                                  │
│  "Do not communicate by sharing memory;                          │
│   share memory by communicating." — Go Proverb                   │
│                                                                  │
│  → Pipeline Pattern    (chaining channels)                       │
│  → Fan-out Pattern     (one channel → many goroutines)           │
│  → Fan-in Pattern      (many channels → one)                     │
│  → Done Channel        (cancellation propagation)                │
│  → Semaphore Pattern   (buffered channel as semaphore)           │
└──────────────────────────────────────────────────────────────────┘
```

---

## 🔗 Series Articles — GoF

- [[Design-Patterns-Go/01-Creational|01 · Creational Patterns]]
- [[Design-Patterns-Go/02-Structural|02 · Structural Patterns]]
- [[Design-Patterns-Go/03-Behavioral|03 · Behavioral Patterns]]

## 🔗 Series Articles — Go Idiomatic

- [[Design-Patterns-Go/05-Level1-Foundations|Level 1 · Foundations]]
- [[Design-Patterns-Go/06-Level2-Idiomatic|Level 2 · Idiomatic]]
- [[Design-Patterns-Go/07-Level3-Concurrency|Level 3 · Concurrency]]
- [[Design-Patterns-Go/08-Level4-Architecture|Level 4 · Architecture]]

*Tags: #go #design-patterns #gof #concurrency #architecture*
