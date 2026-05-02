# Bài 6: Interfaces Deep Dive & Generics

> **Mục tiêu:** Hiểu interface implicit của Go, composition pattern, type system, và Generics từ Go 1.18+. Đây là tính năng QUAN TRỌNG NHẤT của Go type system.

---

## 1. Interface Implicit — Khác hoàn toàn Java

```
┌──────────────────────────────────────────────────────────────┐
│           JAVA vs GO INTERFACE                               │
├──────────────────────────────────────────────────────────────┤
│  JAVA (Explicit/Nominal typing):                             │
│  class Dog implements Animal { ... }  ← phải khai báo       │
│                                                              │
│  → Vấn đề: Library code phải biết về interface của bạn     │
│  → Coupling giữa implementation và interface definition     │
│                                                              │
│  GO (Implicit/Structural typing):                            │
│  type Dog struct { ... }                                     │
│  func (d Dog) Sound() string { return "Woof" }               │
│  // Dog TỰ ĐỘNG implements Animal nếu có Sound() method     │
│                                                              │
│  → Library code KHÔNG cần biết interface của bạn           │
│  → Duck typing với compile-time safety                      │
│  → "If it walks like a duck and quacks like a duck..."      │
└──────────────────────────────────────────────────────────────┘
```

```go
// Interface definition
type Writer interface {
    Write(p []byte) (n int, err error)
}

// ALL of these implement Writer WITHOUT saying so:
// - os.File (writes to filesystem)
// - bytes.Buffer (writes to memory)
// - net.Conn (writes to network)
// - http.ResponseWriter (writes HTTP response)

// Bạn có thể viết function nhận Writer từ thư viện chuẩn
func writeJSON(w Writer, data interface{}) error {
    return json.NewEncoder(w).Encode(data)
}

// Gọi với bất kỳ Writer nào
writeJSON(os.Stdout, user)          // print to console
writeJSON(bytes.NewBuffer(nil), user) // write to memory
writeJSON(httpResponseWriter, user) // write HTTP response
```

---

## 2. Interface Composition

```go
// Nhỏ và focused — Go style
type Reader interface { Read(p []byte) (n int, err error) }
type Writer interface { Write(p []byte) (n int, err error) }
type Closer interface { Close() error }

// Compose thành interface lớn hơn
type ReadWriter interface {
    Reader
    Writer
}

type ReadWriteCloser interface {
    Reader
    Writer
    Closer
}

// Real example: Repository pattern
type DocumentReader interface {
    FindByID(ctx context.Context, id string) (*Document, error)
    FindAll(ctx context.Context, filter Filter) ([]*Document, error)
}

type DocumentWriter interface {
    Create(ctx context.Context, doc *Document) error
    Update(ctx context.Context, doc *Document) error
    Delete(ctx context.Context, id string) error
}

type DocumentRepository interface {
    DocumentReader
    DocumentWriter
}

// Service chỉ cần ReadOnly?
type DocumentQueryService struct {
    repo DocumentReader // Chỉ nhận reader — narrow interface!
}
```

---

## 3. Interface Anatomy — Bên trong

```
┌──────────────────────────────────────────────────────────────┐
│             INTERFACE VALUE INTERNALS (16 bytes)             │
│                                                              │
│  ┌──────────────┬──────────────────────────────────┐        │
│  │   type ptr   │          data ptr                │        │
│  │  (itab/type) │       (concrete value)           │        │
│  └──────────────┴──────────────────────────────────┘        │
│         │                      │                            │
│         ▼                      ▼                            │
│  ┌────────────┐      ┌───────────────────┐                  │
│  │ Type info  │      │  Concrete struct   │                  │
│  │ *Dog       │      │  Dog{Name:"Rex"}  │                  │
│  │ method set │      └───────────────────┘                  │
│  └────────────┘                                             │
│                                                              │
│  nil interface: BOTH type and data are nil                   │
│  (*Dog)(nil) stored in interface: type!=nil, data==nil       │
│  → Interface != nil even though Dog pointer is nil!          │
└──────────────────────────────────────────────────────────────┘
```

```go
// ⚠ Classic nil interface trap
func getError() error {
    var p *MyError = nil
    return p  // DANGER! Returns non-nil interface with nil data
}

err := getError()
fmt.Println(err == nil) // false! Mặc dù *MyError là nil

// ✅ Fix: trả nil trực tiếp
func getError() error {
    // ...
    return nil // interface nil — both type and data are nil
}
```

---

## 4. Type Assertion & Type Switch

```go
var r io.Reader = os.Stdin

// Type assertion — unsafe (panics nếu sai type)
f := r.(*os.File)

// Type assertion — safe (comma ok idiom)
f, ok := r.(*os.File)
if ok {
    // r là *os.File
    fmt.Println("Is file:", f.Name())
}

// Type switch — handle nhiều types
func describe(i interface{}) string {
    switch v := i.(type) {
    case int:
        return fmt.Sprintf("int: %d", v)
    case string:
        return fmt.Sprintf("string: %q", v)
    case []byte:
        return fmt.Sprintf("bytes: len=%d", len(v))
    case nil:
        return "nil"
    default:
        return fmt.Sprintf("unknown: %T", v)
    }
}
```

---

## 5. Generics (Go 1.18+) — Type Parameters

```
┌──────────────────────────────────────────────────────────────┐
│                   GENERICS EVOLUTION                         │
│                                                              │
│  Pre-1.18 — 3 ways to handle "any type":                    │
│  1. interface{} → runtime type checks, no compile safety    │
│  2. Code generation → boilerplate hell                       │
│  3. Separate functions per type → duplicate code            │
│                                                              │
│  Go 1.18+ — Generics:                                       │
│  func Map[T, U any](s []T, f func(T) U) []U { ... }        │
│  → Type-safe at compile time                                │
│  → No runtime overhead                                      │
│  → No code generation needed                                │
└──────────────────────────────────────────────────────────────┘
```

```go
// Constraints — giới hạn type parameter
type Number interface {
    int | int8 | int16 | int32 | int64 |
    float32 | float64
}

// Hàm generic với constraint
func Sum[T Number](nums []T) T {
    var total T
    for _, n := range nums {
        total += n
    }
    return total
}

fmt.Println(Sum([]int{1, 2, 3}))     // 6
fmt.Println(Sum([]float64{1.1, 2.2})) // 3.3

// Generic struct — Repository pattern
type Repository[T any, ID comparable] interface {
    FindByID(ctx context.Context, id ID) (*T, error)
    FindAll(ctx context.Context) ([]*T, error)
    Create(ctx context.Context, entity *T) error
    Update(ctx context.Context, entity *T) error
    Delete(ctx context.Context, id ID) error
}

// Concrete implementation
type PostgresRepo[T any, ID comparable] struct {
    db    *gorm.DB
    table string
}

func (r *PostgresRepo[T, ID]) FindByID(ctx context.Context, id ID) (*T, error) {
    var entity T
    result := r.db.WithContext(ctx).First(&entity, "id = ?", id)
    return &entity, result.Error
}

// Usage — no code duplication!
type UserRepo = PostgresRepo[User, string]
type DocRepo  = PostgresRepo[Document, string]
```

---

## 6. Functional Patterns với Generics

```go
// Map, Filter, Reduce — type-safe
func Map[T, U any](slice []T, f func(T) U) []U {
    result := make([]U, len(slice))
    for i, v := range slice {
        result[i] = f(v)
    }
    return result
}

func Filter[T any](slice []T, pred func(T) bool) []T {
    var result []T
    for _, v := range slice {
        if pred(v) {
            result = append(result, v)
        }
    }
    return result
}

func Reduce[T, U any](slice []T, init U, f func(U, T) U) U {
    result := init
    for _, v := range slice {
        result = f(result, v)
    }
    return result
}

// Real usage
users := []User{{Age: 25}, {Age: 17}, {Age: 30}}

adults := Filter(users, func(u User) bool { return u.Age >= 18 })
names  := Map(adults, func(u User) string { return u.Name })
total  := Reduce(adults, 0, func(sum int, u User) int { return sum + u.Age })
```

---

## 7. Case Study: Event Bus với Generics

```go
// Generic Event Bus — type-safe pub/sub
type Handler[T any] func(event T)

type EventBus[T any] struct {
    mu       sync.RWMutex
    handlers []Handler[T]
}

func (b *EventBus[T]) Subscribe(h Handler[T]) {
    b.mu.Lock()
    defer b.mu.Unlock()
    b.handlers = append(b.handlers, h)
}

func (b *EventBus[T]) Publish(event T) {
    b.mu.RLock()
    defer b.mu.RUnlock()
    for _, h := range b.handlers {
        go h(event) // async dispatch
    }
}

// Usage
type DocumentCreatedEvent struct {
    DocID   string
    OwnerID string
    At      time.Time
}

bus := &EventBus[DocumentCreatedEvent]{}

bus.Subscribe(func(e DocumentCreatedEvent) {
    notifyUser(e.OwnerID, "Document created: "+e.DocID)
})

bus.Subscribe(func(e DocumentCreatedEvent) {
    auditLog.Record(e.DocID, "CREATED")
})

bus.Publish(DocumentCreatedEvent{DocID: "doc-123", OwnerID: "user-1", At: time.Now()})
```

---

## 8. Tips & Tricks

```
💡 TIP 1: Accept interfaces, return structs
   ✅ func NewService(repo DocumentRepository) *DocumentService
   ❌ func NewService(repo *PostgresRepository) *DocumentService
   → Nhận interface để dễ test mock, trả struct để caller biết type

💡 TIP 2: Interface nhỏ tốt hơn interface lớn
   ✅ io.Reader (1 method), io.Writer (1 method)
   ❌ interface với 20 methods → khó implement, khó mock

💡 TIP 3: Đừng export interface nếu không cần
   Interface không cần thiết phải exported từ package của nó
   Consumer package tự define interface mình cần (PDMS pattern)

💡 TIP 4: any = interface{} (Go 1.18+)
   ✅ func Log(v any) — readable
   ❌ func Log(v interface{}) — old style

💡 TIP 5: comparable constraint cho map keys
   func Contains[T comparable](slice []T, item T) bool
   → Dùng == operator an toàn
```

---

## 9. Tổng kết Bài 6

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ Interface là structural/implicit — không cần    │
│     "implements" keyword                            │
│  ✅ Interface nhỏ (1-3 methods) > interface lớn    │
│  ✅ Interface value = type ptr + data ptr (16B)     │
│  ✅ nil *T inside interface ≠ nil interface         │
│  ✅ Generics: [T Constraint] cho type-safe code    │
│  ✅ any = interface{}, comparable = map key safe   │
│  ✅ Accept interfaces, return concrete structs      │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-7-Context-Cancellation|Bài 7: Context Package & Cancellation]]

---
*Tags: #go #interfaces #generics #type-system #composition #zero-to-hero*
