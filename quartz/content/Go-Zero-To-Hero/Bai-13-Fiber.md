# Bài 13: Fiber Framework — Zero Allocation, Express-style

> **Mục tiêu:** Hiểu tại sao Fiber nhanh nhất trong Go ecosystem, sử dụng Fiber cho high-performance API, và biết khi nào chọn Fiber vs Gin.

---

## 1. Tại sao Fiber Nhanh hơn Gin?

```
┌──────────────────────────────────────────────────────────────┐
│              FIBER vs GIN — PERFORMANCE ANATOMY              │
│                                                              │
│  GIN (net/http based):                                       │
│  Request → net/http.Server → gin.Context → Handler          │
│  ↑ net/http allocates Request/ResponseWriter per request     │
│  ↑ gin.Context wraps them → extra allocation                │
│                                                              │
│  FIBER (fasthttp based):                                     │
│  Request → fasthttp.Server → fiber.Ctx (pooled) → Handler   │
│  ↑ fasthttp reuses RequestCtx from sync.Pool                │
│  ↑ Zero allocation on hot path → dramatically less GC       │
│                                                              │
│  Benchmark (TechEmpower Round 22):                           │
│  Fiber:  ~202,000 req/s                                     │
│  Gin:    ~153,000 req/s  (+32% slower)                      │
│  net/http: ~98,000 req/s                                    │
│                                                              │
│  TRADE-OFF:                                                  │
│  ⚠ Fiber dùng fasthttp — KHÔNG compatible với net/http     │
│  ⚠ Một số thư viện net/http không dùng được với Fiber      │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Setup & Basic Usage

```go
// go get github.com/gofiber/fiber/v2

import "github.com/gofiber/fiber/v2"

func main() {
    app := fiber.New(fiber.Config{
        // Performance
        Prefork:       false,          // true = multi-process (production Linux)
        ServerHeader:  "",             // Hide server header
        StrictRouting: false,          // /foo và /foo/ khác nhau?
        CaseSensitive: false,
        
        // Limits
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
        IdleTimeout:  60 * time.Second,
        BodyLimit:    4 * 1024 * 1024, // 4MB
        
        // Error handler
        ErrorHandler: func(c *fiber.Ctx, err error) error {
            code := fiber.StatusInternalServerError
            var e *fiber.Error
            if errors.As(err, &e) {
                code = e.Code
            }
            return c.Status(code).JSON(fiber.Map{"error": err.Error()})
        },
    })
    
    // Routes
    app.Get("/hello", func(c *fiber.Ctx) error {
        return c.JSON(fiber.Map{"message": "hello from Fiber"})
    })
    
    log.Fatal(app.Listen(":3000"))
}
```

---

## 3. fiber.Ctx — API Overview

```go
func documentHandler(c *fiber.Ctx) error {
    // ── Params ──
    id := c.Params("id")              // /documents/:id
    
    // ── Query ──
    page := c.QueryInt("page", 1)     // /documents?page=2
    limit := c.QueryInt("limit", 20)
    search := c.Query("search")
    
    // ── Headers ──
    token := c.Get("Authorization")
    contentType := c.Get(fiber.HeaderContentType)
    
    // ── Body binding ──
    var req CreateDocRequest
    if err := c.BodyParser(&req); err != nil {
        return fiber.NewError(fiber.StatusBadRequest, "invalid body: "+err.Error())
    }
    
    // ── Locals (như gin.Context.Set/Get) ──
    userID := c.Locals("userID").(string)
    
    // ── Response ──
    return c.Status(fiber.StatusOK).JSON(fiber.Map{
        "id": id, "page": page, "limit": limit,
    })
    
    // Other response types:
    // c.SendString("Hello")
    // c.SendFile("./static/index.html")
    // c.Download("./report.pdf")
    // c.Redirect("/new-path", 301)
}
```

---

## 4. Middleware

```go
// Custom middleware — giống Gin nhưng khác pattern
func AuthMiddleware(secret []byte) fiber.Handler {
    return func(c *fiber.Ctx) error {
        auth := c.Get("Authorization")
        if !strings.HasPrefix(auth, "Bearer ") {
            return fiber.NewError(fiber.StatusUnauthorized, "missing token")
        }
        
        token := strings.TrimPrefix(auth, "Bearer ")
        claims, err := parseJWT(token, secret)
        if err != nil {
            return fiber.NewError(fiber.StatusUnauthorized, "invalid token")
        }
        
        // Set locals cho handlers sau
        c.Locals("userID", claims.UserID)
        c.Locals("userRole", claims.Role)
        
        return c.Next() // Tiếp tục pipeline
    }
}

// Built-in middleware
import (
    "github.com/gofiber/fiber/v2/middleware/logger"
    "github.com/gofiber/fiber/v2/middleware/recover"
    "github.com/gofiber/fiber/v2/middleware/cors"
    "github.com/gofiber/fiber/v2/middleware/limiter"
    "github.com/gofiber/fiber/v2/middleware/compress"
    "github.com/gofiber/fiber/v2/middleware/requestid"
    "github.com/gofiber/fiber/v2/middleware/helmet"
)

app.Use(
    requestid.New(),
    recover.New(),
    logger.New(logger.Config{
        Format: "[${time}] ${status} - ${latency} ${method} ${path}\n",
    }),
    cors.New(cors.Config{
        AllowOrigins: "https://app.pdms.vn",
        AllowHeaders: "Origin, Content-Type, Authorization",
    }),
    limiter.New(limiter.Config{
        Max:        100,
        Expiration: 1 * time.Minute,
        KeyGenerator: func(c *fiber.Ctx) string {
            return c.IP()
        },
    }),
    compress.New(), // gzip compression
    helmet.New(),   // security headers
)
```

---

## 5. Prefork Mode — Multi-process Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                   PREFORK MODE (Linux only)                  │
│                                                              │
│  Master Process                                              │
│  ├── Worker Process 1 (CPU Core 1) → Handle requests        │
│  ├── Worker Process 2 (CPU Core 2) → Handle requests        │
│  ├── Worker Process 3 (CPU Core 3) → Handle requests        │
│  └── Worker Process 4 (CPU Core 4) → Handle requests        │
│                                                              │
│  OS SO_REUSEPORT: tất cả workers bind cùng port             │
│  → Kernel load-balance requests giữa workers                │
│  → Mỗi worker là separate process → no GC pause giữa workers│
│  → Isolate memory → giảm GC pressure                        │
│                                                              │
│  ⚠ Prefork = true → KHÔNG chia sẻ memory giữa workers       │
│    Không dùng in-memory shared state (dùng Redis thay thế)  │
└──────────────────────────────────────────────────────────────┘
```

```go
app := fiber.New(fiber.Config{
    Prefork: true, // Enable trên production Linux với nhiều cores
})

// Detect nếu đang chạy trong master hay worker
if fiber.IsChild() {
    // Worker process code
    fmt.Println("Worker PID:", os.Getpid())
} else {
    // Master process code — chỉ chạy 1 lần
    fmt.Println("Master PID:", os.Getpid())
}
```

---

## 6. Router & Groups

```go
// Routes với validation middleware
v1 := app.Group("/api/v1")
v1.Use(AuthMiddleware(cfg.JWTSecret))

// Documents
docs := v1.Group("/documents")
docs.Get("/",     listDocuments)
docs.Post("/",    createDocument)
docs.Get("/:id",  getDocument)
docs.Put("/:id",  updateDocument)
docs.Delete("/:id", requireRole("admin"), deleteDocument)

// Static files
app.Static("/uploads", "./uploads", fiber.Static{
    Compress:      true,
    ByteRange:     true,  // Support Range requests (video streaming)
    Browse:        false,
    CacheDuration: 24 * time.Hour,
})
```

---

## 7. Fiber vs Gin — Khi nào chọn cái nào?

```
┌──────────────────────────────────────────────────────────────┐
│              FIBER vs GIN — DECISION GUIDE                   │
├──────────────────────────┬───────────────────────────────────┤
│  Choose GIN when:        │  Choose FIBER when:               │
├──────────────────────────┼───────────────────────────────────┤
│  ✅ Cần net/http libs    │  ✅ Max throughput là priority     │
│     (nhiều OAuth libs    │  ✅ High-frequency, simple APIs    │
│     dùng net/http)       │  ✅ Linux production + prefork    │
│                          │                                   │
│  ✅ Team quen Express/   │  ✅ Team đến từ Express/JS        │
│     Java Spring          │     (Fiber API gần Express nhất)  │
│                          │                                   │
│  ✅ Ecosystem lớn hơn    │  ✅ Gateway/proxy layer            │
│     (★75K vs ★35K)       │  ✅ Real-time data pipeline        │
│                          │                                   │
│  ✅ General-purpose API  │  ✅ IoT/telemetry endpoint         │
│     với nhiều features   │     (millions of small messages)  │
└──────────────────────────┴───────────────────────────────────┘
```

---

## 8. Case Study: High-throughput Metrics Endpoint

```go
// Use case: Nhận metrics từ IoT devices — millions req/day
app := fiber.New(fiber.Config{
    Prefork:     true,
    JSONEncoder: sonic.Marshal,   // Faster JSON encoder
    JSONDecoder: sonic.Unmarshal,
})

type MetricPayload struct {
    DeviceID  string  `json:"device_id"`
    Timestamp int64   `json:"ts"`
    Value     float64 `json:"value"`
    Tag       string  `json:"tag"`
}

app.Post("/metrics", func(c *fiber.Ctx) error {
    var payload MetricPayload
    if err := c.BodyParser(&payload); err != nil {
        return fiber.ErrBadRequest
    }
    
    // Async send to Kafka — không block HTTP response
    go kafkaProducer.Send("metrics", payload)
    
    return c.SendStatus(fiber.StatusAccepted) // 202 — không cần body
})
```

---

## 9. Tips & Tricks

```
💡 TIP 1: Không dùng fiber.Ctx outside of handler
   fiber.Ctx là pooled object — sẽ được reuse sau khi handler return
   → Không store *fiber.Ctx trong goroutine hoặc struct field

💡 TIP 2: c.BodyParser vs c.Body()
   BodyParser() → unmarshal JSON/XML/Form
   Body() → raw bytes → custom parsing

💡 TIP 3: Custom JSON encoder (sonic > stdlib)
   app := fiber.New(fiber.Config{
       JSONEncoder: sonic.Marshal,
       JSONDecoder: sonic.Unmarshal,
   })

💡 TIP 4: Prefork + Redis cho shared state
   Không có in-memory sharing giữa workers
   Dùng Redis cho sessions, rate limits, caches

💡 TIP 5: Fiber.Error type cho structured errors
   return fiber.NewError(404, "document not found")
   → Global error handler tự động process
```

---

## 10. Tổng kết Bài 13

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ Fiber dùng fasthttp — context pooling = ít GC   │
│  ✅ Prefork = multi-process, bind same port (Linux) │
│  ✅ fiber.Ctx.Locals() thay gin.Context.Set/Get     │
│  ✅ return c.Next() / return error (khác Gin)       │
│  ✅ Built-in middleware phong phú hơn Gin           │
│  ✅ Không compatible với net/http ecosystem         │
│  ✅ Chọn Fiber khi max performance > compatibility  │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-14-Echo|Bài 14: Echo Framework]]

---
*Tags: #go #fiber #fasthttp #performance #prefork #zero-to-hero*
