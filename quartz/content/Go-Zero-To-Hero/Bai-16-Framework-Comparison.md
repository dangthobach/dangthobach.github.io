# Bài 16: Framework So Sánh & Decision Matrix

> **Mục tiêu:** Hiểu rõ trade-offs của từng framework, biết chọn đúng framework cho đúng use case.

---

## 1. Tổng quan Performance

```
┌──────────────────────────────────────────────────────────────┐
│           PERFORMANCE BENCHMARK (TechEmpower 2024)           │
│                   plaintext, req/s (higher=better)           │
│                                                              │
│  Fiber   ████████████████████████████ ~202,000              │
│  Echo    ██████████████████████ ~170,000                     │
│  Gin     ████████████████████ ~153,000                       │
│  Chi     ███████████████████ ~148,000                        │
│  net/http ████████████████ ~98,000                           │
│  Spring  ████ ~28,000                                        │
│                                                              │
│  JSON serialization, req/s:                                  │
│  Fiber   ██████████████████ ~142,000                         │
│  Gin     ████████████████ ~128,000                           │
│  Echo    ███████████████ ~120,000                            │
│                                                              │
│  NOTE: Chênh lệch trong real-world app << benchmark          │
│  DB query (3ms) >> framework overhead (<0.05ms)              │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Feature Matrix

```
┌──────────────────────────────────────────────────────────────┐
│              FEATURE COMPARISON MATRIX                       │
├─────────────────────┬────────┬────────┬────────┬────────────┤
│ Feature             │  Gin   │ Fiber  │  Echo  │  Chi       │
├─────────────────────┼────────┼────────┼────────┼────────────┤
│ HTTP Base           │net/http│fasthttp│net/http│ net/http   │
│ GitHub Stars ★      │ 75K    │ 35K    │ 30K    │ 18K        │
│ Request binding     │ ✅ Gin │ ✅ body│ ✅ auto│ ❌ manual  │
│ Validation built-in │ ✅     │ ❌     │ ✅     │ ❌         │
│ Middleware chain    │ ✅     │ ✅     │ ✅     │ ✅         │
│ Route groups        │ ✅     │ ✅     │ ✅     │ ✅ Mount() │
│ Path params         │ :id    │ :id    │ :id    │ {id}       │
│ Regex routes        │ ❌     │ ✅     │ ✅     │ ✅         │
│ Auto-TLS            │ ❌     │ ❌     │ ✅     │ ❌         │
│ WebSocket           │ ✅gorilla│ ✅    │ ✅     │ ✅gorilla  │
│ Server-sent events  │ ✅     │ ✅     │ ✅     │ ✅         │
│ HTTP/2              │ net/http│ ❌     │ ✅     │ net/http   │
│ net/http compat     │ ✅     │ ❌     │ ✅     │ ✅         │
│ Prefork (multi-proc)│ ❌     │ ✅     │ ❌     │ ❌         │
│ Swagger/OpenAPI     │ swaggo │ fiber-swagger│swaggo│ swaggo│
│ Learning curve      │ Easy   │ Easy   │ Medium │ Medium     │
│ Community           │ ★★★★★ │ ★★★★  │ ★★★★  │ ★★★       │
└─────────────────────┴────────┴────────┴────────┴────────────┘
```

---

## 3. Decision Tree

```
START: Chọn Go Framework cho project mới
│
├── Cần tương thích với net/http ecosystem?
│   (OAuth libs, WebAuthn, specific middleware)
│   │
│   └── YES → Loại Fiber → Chọn Gin/Echo/Chi
│
├── Muốn maximum performance, chạy Linux + prefork?
│   │
│   └── YES → FIBER ✅
│
├── Muốn Clean Architecture rõ ràng, tự chọn components?
│   │
│   └── YES → CHI ✅
│
├── Team nhỏ, cần productivity cao, ecosystem lớn?
│   │
│   └── YES → GIN ✅
│
├── Cần Auto-TLS, standard context, balanced features?
│   │
│   └── YES → ECHO ✅
│
└── Building microservice at Google/Uber scale?
    │
    └── Consider Encore / Kratos (opinionated microservice frameworks)
```

---

## 4. Use Case Mapping

| Use Case | Recommendation | Lý do |
|---|---|---|
| General REST API | **Gin** | Ecosystem lớn, community, dễ hire |
| High-traffic gateway | **Fiber** | Prefork, max throughput |
| API với Auto-TLS | **Echo** | Built-in Let's Encrypt |
| Clean Architecture | **Chi** | Minimal, composable |
| Enterprise app | **Echo** hoặc **Gin** | Battle-tested, tài liệu nhiều |
| Rapid prototype | **Gin** | Ít boilerplate nhất |
| IoT/telemetry | **Fiber** | High message rate, low overhead |
| gRPC + REST | **Go-kit** hoặc **Kratos** | Transport agnostic |
| PDMS-like (Banking) | **Gin** hoặc **Chi+Clean** | Compliance + testability |

---

## 5. Code Style Comparison

```go
// ── SAME ENDPOINT: GET /documents/:id ──

// GIN
r.GET("/documents/:id", func(c *gin.Context) {
    id := c.Param("id")
    doc, err := svc.Get(c.Request.Context(), id)
    if err != nil {
        c.JSON(404, gin.H{"error": err.Error()})
        return
    }
    c.JSON(200, doc)
})

// FIBER
app.Get("/documents/:id", func(c *fiber.Ctx) error {
    id := c.Params("id")
    doc, err := svc.Get(c.Context(), id)
    if err != nil {
        return fiber.NewError(404, err.Error())
    }
    return c.JSON(doc)
})

// ECHO
e.GET("/documents/:id", func(c echo.Context) error {
    id := c.Param("id")
    doc, err := svc.Get(c.Request().Context(), id)
    if err != nil {
        return echo.NewHTTPError(404, err.Error())
    }
    return c.JSON(200, doc)
})

// CHI + standard net/http
r.Get("/documents/{id}", func(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")
    doc, err := svc.Get(r.Context(), id)
    if err != nil {
        http.Error(w, err.Error(), 404)
        return
    }
    json.NewEncoder(w).Encode(doc)
})
```

---

## 6. Ecosystem Extras

```
┌──────────────────────────────────────────────────────────────┐
│                 ECOSYSTEM COMPARISON                         │
├──────────────────────────────────────────────────────────────┤
│  Gin Ecosystem:                                              │
│  ├── gin-contrib/cors          — CORS                        │
│  ├── gin-contrib/sessions      — Session management          │
│  ├── gin-contrib/cache         — Response caching            │
│  ├── appleboy/gin-jwt          — JWT helper                  │
│  └── swaggo/gin-swagger        — Swagger UI                  │
│                                                              │
│  Fiber Ecosystem:                                            │
│  ├── gofiber/contrib/...       — Official contrib packages   │
│  ├── fiber/middleware/*        — 20+ built-in middlewares    │
│  └── fiber/storage/*           — Redis, MongoDB adapters     │
│                                                              │
│  Echo Ecosystem:                                             │
│  ├── echo/middleware           — 20+ official middlewares    │
│  └── labstack/echo-contrib     — Community packages          │
│                                                              │
│  Chi Ecosystem:                                              │
│  ├── go-chi/cors               — CORS                        │
│  ├── go-chi/jwtauth            — JWT auth                    │
│  ├── go-chi/render             — Response rendering          │
│  └── ANY net/http middleware   — Full compatibility          │
└──────────────────────────────────────────────────────────────┘
```

---

## 7. My Recommendation cho PDMS Project

```
┌──────────────────────────────────────────────────────────────┐
│              PDMS RECOMMENDATION                             │
│                                                              │
│  Primary: GIN                                                │
│  ├── Lý do: Ecosystem lớn nhất, Keycloak integration        │
│  │         dễ dàng với net/http libs                        │
│  ├── + gin-gonic/gin + GORM + go-redis                      │
│  └── + swaggo cho API docs                                  │
│                                                              │
│  Alternative: CHI + Clean Architecture                       │
│  ├── Nếu team muốn DDD/Clean Architecture thuần túy         │
│  ├── + chi/jwtauth cho Keycloak JWT validation              │
│  └── + chi/render cho consistent JSON responses             │
│                                                              │
│  Avoid Fiber cho PDMS vì:                                   │
│  ├── Keycloak OAuth2 libs thường dùng net/http              │
│  └── Banking system cần compliance — ít thư viện exotic hơn│
└──────────────────────────────────────────────────────────────┘
```

---

## 8. Tổng kết Bài 16

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ Fiber fastest nhưng không net/http compatible   │
│  ✅ Gin: biggest community, easiest start           │
│  ✅ Echo: auto-TLS, standard context, balanced      │
│  ✅ Chi: minimal, composable, clean architecture    │
│  ✅ Framework overhead < 0.05ms — không quyết định  │
│     performance, DB query mới là bottleneck         │
│  ✅ Chọn framework theo team size, use case, compat │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-17-Kafka-Sarama|Bài 17: Kafka với Go — Sarama & confluent-kafka-go]]

---
*Tags: #go #gin #fiber #echo #chi #framework-comparison #zero-to-hero*
