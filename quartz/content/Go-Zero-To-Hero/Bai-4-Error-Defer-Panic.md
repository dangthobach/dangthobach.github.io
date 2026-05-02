# Bài 4: Error Handling, defer, panic & recover

> **Mục tiêu:** Nắm vững triết lý xử lý lỗi của Go — error-as-value, defer stack, panic/recover pattern. So sánh sâu với Java exceptions và Rust Result<T,E>.

---

## 1. Triết lý Error của Go

```
┌──────────────────────────────────────────────────────────────┐
│               ERROR PHILOSOPHY COMPARISON                    │
├──────────────┬──────────────────┬───────────────────────────┤
│  Java        │  Rust            │  Go                       │
├──────────────┼──────────────────┼───────────────────────────┤
│  throw/catch │  Result<T, E>    │  (value, error) pair      │
│  Exception   │  Ok(v)/Err(e)    │  error interface          │
│  Hidden flow │  Explicit match  │  Explicit if err != nil   │
│  Stacktrace  │  No implicit     │  No stacktrace (default)  │
│  Checked/    │  Propagate with  │  Propagate with           │
│  Unchecked   │  ? operator      │  return err               │
└──────────────┴──────────────────┴───────────────────────────┘

Go RULE: Errors are VALUES, not exceptions.
→ Errors phải được xử lý TƯỜNG MINH.
→ Không có "hidden control flow" như Java exceptions.
```

---

## 2. error Interface — Cơ bản nhất

```go
// error là interface đơn giản nhất trong Go
type error interface {
    Error() string
}

// Cách tạo error đơn giản
err1 := errors.New("something went wrong")
err2 := fmt.Errorf("user %d not found", 42)

// Custom error type
type ValidationError struct {
    Field   string
    Message string
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation failed on %s: %s", e.Field, e.Message)
}

// Sử dụng
func validateAge(age int) error {
    if age < 0 {
        return &ValidationError{Field: "age", Message: "must be non-negative"}
    }
    if age > 150 {
        return &ValidationError{Field: "age", Message: "unrealistic value"}
    }
    return nil // nil = no error
}
```

---

## 3. Error Wrapping — Thêm Context

```
┌──────────────────────────────────────────────────────────────┐
│                  ERROR WRAPPING CHAIN                        │
│                                                              │
│  Original:  "connection refused"                             │
│       │ fmt.Errorf("connect to DB: %w", err)                │
│       ▼                                                      │
│  Layer 1: "connect to DB: connection refused"               │
│       │ fmt.Errorf("initialize service: %w", err)           │
│       ▼                                                      │
│  Layer 2: "initialize service: connect to DB: ..."          │
│                                                              │
│  Unwrap:   errors.Is(err, ErrConnRefused) → true ✅         │
│  Extract:  errors.As(err, &connErr)       → true ✅         │
└──────────────────────────────────────────────────────────────┘
```

```go
// Sentinel errors (pre-defined, like Java's specific exceptions)
var (
    ErrNotFound   = errors.New("not found")
    ErrForbidden  = errors.New("forbidden")
    ErrValidation = errors.New("validation error")
)

// Wrapping với %w
func getUser(id string) (*User, error) {
    user, err := db.Find(id)
    if err != nil {
        return nil, fmt.Errorf("getUser(%s): %w", id, err)
        // Thêm context mà không mất error gốc
    }
    return user, nil
}

// errors.Is — kiểm tra error trong chain
err := getUser("123")
if errors.Is(err, ErrNotFound) {
    // Xử lý not found, dù err có nhiều lớp wrap
}

// errors.As — extract type cụ thể
var valErr *ValidationError
if errors.As(err, &valErr) {
    fmt.Println("Field:", valErr.Field)
}
```

---

## 4. Pattern: Multiple Return Values

```go
// ❌ Java style — sai cách
func divide(a, b float64) float64 {
    if b == 0 {
        panic("division by zero") // ĐỪNG dùng panic cho business logic
    }
    return a / b
}

// ✅ Go idiom
func divide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, fmt.Errorf("divide: divisor cannot be zero")
    }
    return a / b, nil
}

// Named return values (hữu ích cho defer + cleanup)
func openFile(path string) (f *os.File, err error) {
    f, err = os.Open(path)
    if err != nil {
        return // return f=nil, err=<lỗi>
    }
    return // return f=<file>, err=nil
}
```

---

## 5. defer — Stack-based Cleanup

```
┌──────────────────────────────────────────────────────────────┐
│                   DEFER STACK (LIFO)                         │
│                                                              │
│  func processFile() {                                        │
│      defer fmt.Println("3rd — last defer")  ← push 1st      │
│      defer fmt.Println("2nd — middle defer") ← push 2nd     │
│      defer fmt.Println("1st — first defer")  ← push 3rd     │
│      // ... function body ...                                │
│  }                                                           │
│                                                              │
│  Output order (LIFO — Last In, First Out):                   │
│  "1st — first defer"                                         │
│  "2nd — middle defer"                                        │
│  "3rd — last defer"                                          │
│                                                              │
│  Defer luôn chạy khi function return — dù return bình        │
│  thường HAY do panic!                                        │
└──────────────────────────────────────────────────────────────┘
```

```go
// Dùng defer cho resource cleanup
func readConfig(path string) ([]byte, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, fmt.Errorf("readConfig: %w", err)
    }
    defer f.Close() // LUÔN đóng file, dù return ở đâu

    return io.ReadAll(f)
}

// Defer với database transaction
func transfer(from, to string, amount float64) (err error) {
    tx, err := db.Begin()
    if err != nil {
        return
    }
    defer func() {
        if err != nil {
            tx.Rollback() // Rollback nếu có lỗi
        } else {
            err = tx.Commit() // err có thể thay đổi ở đây!
        }
    }()

    // Thực hiện operations...
    err = deduct(tx, from, amount)
    if err != nil { return }
    
    err = credit(tx, to, amount)
    return
}

// Defer để đo thời gian (common pattern)
func measureTime(name string) func() {
    start := time.Now()
    return func() {
        fmt.Printf("%s took %v\n", name, time.Since(start))
    }
}

func heavyOp() {
    defer measureTime("heavyOp")()  // Chú ý dấu () cuối
    // ... heavy work ...
}
```

---

## 6. panic & recover

```
┌──────────────────────────────────────────────────────────────┐
│                  PANIC vs ERROR                              │
│                                                              │
│  Dùng error cho:              Dùng panic cho:               │
│  ─────────────────            ──────────────────            │
│  - Business logic failures    - Programming errors           │
│  - Expected failure cases     - Invariant violations         │
│  - I/O errors                 - nil pointer (Go runtime)    │
│  - Validation failures        - Index out of bounds          │
│  - Network errors             - Type assertion failure       │
│                               - Startup fatal config error   │
│                                                              │
│  RULE: panic = "this should NEVER happen in correct code"   │
└──────────────────────────────────────────────────────────────┘
```

```go
// recover() — bắt panic trước khi crash
func safeDiv(a, b int) (result int, err error) {
    defer func() {
        if r := recover(); r != nil {
            err = fmt.Errorf("recovered from panic: %v", r)
        }
    }()
    return a / b, nil // Sẽ panic nếu b == 0
}

// Pattern: HTTP server — recover từng request
func recoveryMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if err := recover(); err != nil {
                log.Printf("panic: %v\n%s", err, debug.Stack())
                http.Error(w, "Internal Server Error", 500)
            }
        }()
        next.ServeHTTP(w, r)
    })
}
```

---

## 7. Case Study: PDMS Document Service Error Handling

```go
// Domain errors
type DocumentError struct {
    Code    string
    DocID   string
    Wrapped error
}

func (e *DocumentError) Error() string {
    return fmt.Sprintf("[%s] document %s: %v", e.Code, e.DocID, e.Wrapped)
}

func (e *DocumentError) Unwrap() error { return e.Wrapped }

var (
    ErrDocNotFound  = errors.New("document not found")
    ErrDocArchived  = errors.New("document is archived")
    ErrUnauthorized = errors.New("unauthorized access")
)

// Service layer — wrap errors với context
func (s *DocumentService) GetDocument(ctx context.Context, id, userID string) (*Document, error) {
    doc, err := s.repo.FindByID(ctx, id)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, &DocumentError{
                Code:    "DOC_NOT_FOUND",
                DocID:   id,
                Wrapped: ErrDocNotFound,
            }
        }
        return nil, fmt.Errorf("GetDocument: %w", err)
    }

    if doc.OwnerID != userID {
        return nil, &DocumentError{
            Code:    "UNAUTHORIZED",
            DocID:   id,
            Wrapped: ErrUnauthorized,
        }
    }

    return doc, nil
}

// Handler layer — map errors to HTTP status
func (h *Handler) GetDocument(c *gin.Context) {
    doc, err := h.svc.GetDocument(c.Request.Context(), c.Param("id"), c.GetString("userID"))
    if err != nil {
        var docErr *DocumentError
        if errors.As(err, &docErr) {
            switch {
            case errors.Is(err, ErrDocNotFound):
                c.JSON(404, gin.H{"error": docErr.Error()})
            case errors.Is(err, ErrUnauthorized):
                c.JSON(403, gin.H{"error": docErr.Error()})
            default:
                c.JSON(500, gin.H{"error": "internal error"})
            }
            return
        }
        c.JSON(500, gin.H{"error": "internal error"})
        return
    }
    c.JSON(200, doc)
}
```

---

## 8. Tips & Tricks

```
💡 TIP 1: Luôn wrap error với context
   ✅  return fmt.Errorf("createUser: %w", err)
   ❌  return err  // Mất context — khó debug

💡 TIP 2: Sentinel errors phải unexported nếu chỉ dùng nội bộ
   ✅  var errTimeout = errors.New("timeout")  // lowercase
   ✅  var ErrNotFound = errors.New(...)       // uppercase nếu public API

💡 TIP 3: errors.Is/As thay vì so sánh == trực tiếp
   ✅  errors.Is(err, ErrNotFound)
   ❌  err == ErrNotFound  // Không hoạt động với wrapped errors

💡 TIP 4: defer f.Close() ngay sau khi mở file/connection
   ✅  f, err := os.Open(...); if err != nil { return }; defer f.Close()

💡 TIP 5: Không dùng panic cho business logic
   ❌  panic("user not found")  // WRONG
   ✅  return nil, ErrNotFound  // RIGHT
```

---

## 9. Tổng kết Bài 4

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ error là interface{Error() string} đơn giản     │
│  ✅ fmt.Errorf("%w", err) để wrap giữ chain         │
│  ✅ errors.Is kiểm tra type trong chain             │
│  ✅ errors.As extract type cụ thể từ chain          │
│  ✅ defer chạy LIFO khi function return (dù panic)  │
│  ✅ panic = programming error, error = business     │
│  ✅ recover() trong defer để bắt panic              │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-5-Modules-Tooling|Bài 5: Packages, Modules & Go Tooling]]

---
*Tags: #go #error-handling #defer #panic #recover #zero-to-hero*
