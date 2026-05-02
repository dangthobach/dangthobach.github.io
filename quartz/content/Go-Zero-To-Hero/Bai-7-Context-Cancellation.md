# Bài 7: Context Package & Cancellation

> **Mục tiêu:** Hiểu và dùng thành thạo context.Context — công cụ số 1 để quản lý lifecycle, cancellation, và truyền metadata trong Go.

---

## 1. Tại sao cần Context?

```
┌──────────────────────────────────────────────────────────────┐
│               THE PROBLEM WITHOUT CONTEXT                    │
│                                                              │
│  HTTP Request → Handler → Service → DB Query                 │
│                                                              │
│  Scenario: Client disconnect sau 2 giây                      │
│                                                              │
│  WITHOUT Context:                                            │
│  Handler: "Client disconnect!" → returns                     │
│  Service: Still running...                                   │
│  DB Query: Still running...   (WASTED RESOURCES!)            │
│                                                              │
│  WITH Context:                                               │
│  Handler: cancel() → cancels context                         │
│  Service: ctx.Done() → detects cancel → stops               │
│  DB Query: ctx.Done() → detects cancel → stops              │
│  → Resources freed immediately!                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Context Tree

```
context.Background()          ← Root (never cancelled)
│
├── WithCancel(ctx)            ← Manual cancel
│   └── Goroutine A
│
├── WithTimeout(ctx, 5s)       ← Auto cancel after 5s
│   ├── DB Query
│   └── HTTP Call
│
└── WithValue(ctx, "userID", "123")  ← Carry metadata
    └── Handler chain
```

```go
// 4 loại context
ctx1 := context.Background()          // Root, dùng ở main/test
ctx2 := context.TODO()                // Placeholder, chưa biết dùng gì

ctx3, cancel := context.WithCancel(ctx1)     // Manual cancel
defer cancel()

ctx4, cancel := context.WithTimeout(ctx1, 5*time.Second) // Auto cancel
defer cancel()

ctx5, cancel := context.WithDeadline(ctx1, time.Now().Add(5*time.Second))
defer cancel()

ctx6 := context.WithValue(ctx1, "requestID", "req-123") // Carry values
```

---

## 3. WithCancel — Manual Cancellation

```go
func processDocuments(ctx context.Context, ids []string) error {
    ctx, cancel := context.WithCancel(ctx)
    defer cancel() // Cleanup khi function return

    results := make(chan Result, len(ids))
    var wg sync.WaitGroup

    for _, id := range ids {
        wg.Add(1)
        go func(id string) {
            defer wg.Done()
            result, err := processOne(ctx, id) // Pass context!
            if err != nil {
                cancel() // Cancel tất cả workers nếu 1 cái fail
                return
            }
            results <- result
        }(id)
    }

    go func() {
        wg.Wait()
        close(results)
    }()

    for result := range results {
        // collect results
        _ = result
    }
    return ctx.Err() // nil nếu success, context.Canceled nếu cancelled
}

// Kiểm tra cancellation trong long-running loop
func longRunning(ctx context.Context) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err() // context.Canceled hoặc DeadlineExceeded
        default:
            // Do work
            doSomething()
        }
    }
}
```

---

## 4. WithTimeout — HTTP & DB Calls

```
┌──────────────────────────────────────────────────────────────┐
│              TIMEOUT LAYERING STRATEGY                       │
│                                                              │
│  Request timeout: 30s                                        │
│  │                                                           │
│  ├── Service call timeout: 10s                               │
│  │   ├── DB query timeout: 3s                               │
│  │   └── Cache lookup: 1s                                   │
│  │                                                           │
│  └── External API timeout: 5s                               │
│                                                              │
│  Inner timeout < Outer timeout → Inner fails first           │
│  → Propagate error up with context                          │
└──────────────────────────────────────────────────────────────┘
```

```go
// HTTP Handler — set request-level timeout
func (h *Handler) GetDocument(c *gin.Context) {
    // Inherit context từ HTTP request (đã có deadline từ server config)
    ctx := c.Request.Context()

    // Thêm operation-level timeout
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    doc, err := h.svc.GetDocument(ctx, c.Param("id"))
    if err != nil {
        if errors.Is(err, context.DeadlineExceeded) {
            c.JSON(504, gin.H{"error": "request timeout"})
            return
        }
        c.JSON(500, gin.H{"error": err.Error()})
        return
    }
    c.JSON(200, doc)
}

// DB Repository — context passed to all queries
func (r *DocRepo) FindByID(ctx context.Context, id string) (*Document, error) {
    var doc Document
    // GORM respects context cancellation
    result := r.db.WithContext(ctx).Where("id = ?", id).First(&doc)
    if result.Error != nil {
        return nil, fmt.Errorf("FindByID: %w", result.Error)
    }
    return &doc, nil
}

// HTTP Client — always pass context
func callExternalAPI(ctx context.Context, url string) ([]byte, error) {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, err
    }
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("callExternalAPI: %w", err)
    }
    defer resp.Body.Close()
    return io.ReadAll(resp.Body)
}
```

---

## 5. WithValue — Metadata Propagation

```go
// Define typed key để tránh collision
type contextKey string

const (
    keyRequestID contextKey = "requestID"
    keyUserID    contextKey = "userID"
    keyTenant    contextKey = "tenantID"
)

// Middleware inject values vào context
func RequestIDMiddleware() gin.HandlerFunc {
    return func(c *gin.Context) {
        requestID := c.GetHeader("X-Request-ID")
        if requestID == "" {
            requestID = uuid.New().String()
        }
        ctx := context.WithValue(c.Request.Context(), keyRequestID, requestID)
        c.Request = c.Request.WithContext(ctx)
        c.Header("X-Request-ID", requestID)
        c.Next()
    }
}

// Helper functions để get/set (clean API)
func GetRequestID(ctx context.Context) string {
    v, _ := ctx.Value(keyRequestID).(string)
    return v
}

func GetUserID(ctx context.Context) string {
    v, _ := ctx.Value(keyUserID).(string)
    return v
}

// Service — extract from context (không cần pass riêng)
func (s *DocumentService) Create(ctx context.Context, doc *Document) error {
    doc.CreatedBy = GetUserID(ctx)    // Từ context
    doc.RequestID = GetRequestID(ctx) // Từ context
    return s.repo.Create(ctx, doc)
}
```

---

## 6. Context Best Practices

```
┌──────────────────────────────────────────────────────────────┐
│               CONTEXT DO's & DON'Ts                          │
├──────────────────────────────────────────────────────────────┤
│  DO:                                                         │
│  ✅ Luôn truyền ctx là argument đầu tiên                    │
│     func Do(ctx context.Context, ...) error                  │
│  ✅ defer cancel() ngay sau WithCancel/WithTimeout           │
│  ✅ Kiểm tra ctx.Done() trong goroutine loops               │
│  ✅ Dùng typed key (type contextKey string)                  │
│  ✅ ctx từ http.Request.Context() là chuẩn                  │
│                                                              │
│  DON'T:                                                      │
│  ❌ Store context trong struct field                          │
│     type Server struct { ctx context.Context } // WRONG     │
│  ❌ Truyền nil context                                       │
│     doSomething(nil) // WRONG — dùng context.Background()   │
│  ❌ Dùng string key cho WithValue                            │
│     ctx = context.WithValue(ctx, "key", val) // WRONG       │
│  ❌ Store business data lớn trong context                   │
│     Context chỉ cho metadata nhỏ (requestID, userID)        │
└──────────────────────────────────────────────────────────────┘
```

---

## 7. Case Study: Graceful Shutdown với Context

```go
func main() {
    ctx, stop := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM)
    defer stop()

    srv := &http.Server{Addr: ":8080", Handler: router}

    // Start server trong goroutine
    go func() {
        if err := srv.ListenAndServe(); err != http.ErrServerClosed {
            log.Fatal(err)
        }
    }()

    // Block cho đến khi nhận signal
    <-ctx.Done()

    log.Println("Shutting down gracefully...")
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := srv.Shutdown(shutdownCtx); err != nil {
        log.Printf("Shutdown error: %v", err)
    }
    log.Println("Server stopped")
}
```

---

## 8. Tổng kết Bài 7

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ Context = cancellation + deadline + metadata    │
│  ✅ ctx luôn là argument đầu tiên của function      │
│  ✅ defer cancel() ngay sau WithCancel/WithTimeout  │
│  ✅ ctx.Done() channel để detect cancellation       │
│  ✅ Typed context keys tránh collision              │
│  ✅ Gin: c.Request.Context() là context chuẩn       │
│  ✅ GORM, http.Client đều respect context           │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-8-Testing-Benchmarking|Bài 8: Testing, Table-driven Tests & Benchmarking]]

---
*Tags: #go #context #cancellation #timeout #zero-to-hero*
