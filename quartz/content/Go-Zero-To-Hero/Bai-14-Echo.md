# Bài 14: Echo Framework — Clean & Balanced

> **Mục tiêu:** Nắm vững Echo — framework cân bằng giữa simplicity, performance và features. Standard context, group routing, auto-TLS.

---

## 1. Echo vs Gin — Key Differences

```
┌──────────────────────────────────────────────────────────────┐
│                   ECHO vs GIN                                │
├───────────────────────────┬──────────────────────────────────┤
│  GIN                      │  ECHO                            │
├───────────────────────────┼──────────────────────────────────┤
│  gin.Context              │  echo.Context (wraps std ctx)    │
│  c.ShouldBindJSON(&v)     │  c.Bind(&v) — auto detect type  │
│  c.JSON(200, obj)         │  c.JSON(200, obj) — same        │
│  router.Use(mw)           │  e.Use(mw) — same               │
│  gin.H{"key": val}        │  map[string]any{"key": val}      │
│  Uses gin.Context         │  Uses standard context.Context   │
│  Abort() to stop chain    │  return err to stop chain        │
│  No built-in validator    │  Built-in validator binder       │
└───────────────────────────┴──────────────────────────────────┘

KEY DIFFERENCE: Echo returns error from handlers — cleaner error flow
```

---

## 2. Setup & Hello World

```go
// go get github.com/labstack/echo/v4
// go get github.com/labstack/echo/v4/middleware

import (
    "github.com/labstack/echo/v4"
    "github.com/labstack/echo/v4/middleware"
)

func main() {
    e := echo.New()
    e.HideBanner = true // Ẩn ASCII banner khi start
    
    // Built-in middleware
    e.Use(middleware.Logger())
    e.Use(middleware.Recover())
    e.Use(middleware.RequestID())
    e.Use(middleware.Secure())
    e.Use(middleware.Compress())
    e.Use(middleware.CORS())
    
    // Routes
    e.GET("/health", func(c echo.Context) error {
        return c.JSON(200, map[string]string{"status": "ok"})
    })
    
    // Server config
    e.Server.ReadTimeout  = 15 * time.Second
    e.Server.WriteTimeout = 15 * time.Second
    
    e.Logger.Fatal(e.Start(":8080"))
}
```

---

## 3. echo.Context — Standard Context Integration

```go
// Echo's Context wraps standard library properly
func getDocument(c echo.Context) error {
    // Path param
    id := c.Param("id")
    
    // Query param
    page, _ := strconv.Atoi(c.QueryParam("page"))
    
    // Header
    token := c.Request().Header.Get("Authorization")
    
    // Request context (standard context.Context)
    ctx := c.Request().Context() // ← Direct access to std context!
    
    // Stored values (set by middleware)
    userID := c.Get("userID").(string)
    
    // Do work with standard ctx — compatible với tất cả thư viện!
    doc, err := docService.GetDocument(ctx, id)
    if err != nil {
        if errors.Is(err, ErrNotFound) {
            return echo.NewHTTPError(404, "document not found")
        }
        return err // → Global error handler sẽ xử lý
    }
    
    return c.JSON(200, doc)
}
```

---

## 4. Binding & Validation

```go
// Echo bind từ JSON, Form, Query params — auto detect
type CreateDocRequest struct {
    Title   string `json:"title"   form:"title"   query:"title"   validate:"required,min=1,max=255"`
    Content string `json:"content" form:"content"                  validate:"required"`
    Status  string `json:"status"                                  validate:"omitempty,oneof=draft active"`
}

// Custom validator (dùng go-playground/validator)
type CustomValidator struct {
    validator *validator.Validate
}

func (cv *CustomValidator) Validate(i interface{}) error {
    if err := cv.validator.Struct(i); err != nil {
        return echo.NewHTTPError(400, err.Error())
    }
    return nil
}

// Register validator
e.Validator = &CustomValidator{validator: validator.New()}

// Handler sử dụng
func createDocument(c echo.Context) error {
    var req CreateDocRequest
    
    // Bind tự động detect Content-Type
    if err := c.Bind(&req); err != nil {
        return echo.NewHTTPError(400, "invalid request body")
    }
    
    // Validate
    if err := c.Validate(&req); err != nil {
        return err // Already an HTTP error from validator
    }
    
    doc, err := docService.Create(c.Request().Context(), req)
    if err != nil {
        return err
    }
    
    return c.JSON(201, doc)
}
```

---

## 5. Error Handling — Echo's Approach

```go
// Echo propagates errors — handler returns error, NOT writes response directly

// Custom HTTP error
return echo.NewHTTPError(404, "document not found")
return echo.NewHTTPError(403, map[string]string{"error": "forbidden", "code": "AUTH_003"})

// Global error handler
e.HTTPErrorHandler = func(err error, c echo.Context) {
    code := 500
    message := "internal server error"
    
    var he *echo.HTTPError
    if errors.As(err, &he) {
        code = he.Code
        message = fmt.Sprintf("%v", he.Message)
    }
    
    // Log unexpected errors
    if code >= 500 {
        c.Logger().Error(err)
    }
    
    c.JSON(code, map[string]any{
        "error":      message,
        "request_id": c.Response().Header().Get(echo.HeaderXRequestID),
    })
}
```

---

## 6. Groups & Middleware

```go
// API versioning với groups
v1 := e.Group("/api/v1")
v1.Use(JWTMiddleware(cfg.JWTSecret))
v1.Use(middleware.RateLimiter(middleware.NewRateLimiterMemoryStore(20)))

// Documents group
docs := v1.Group("/documents")
docs.GET("", listDocuments)
docs.POST("", createDocument)
docs.GET("/:id", getDocument)
docs.PUT("/:id", updateDocument)
docs.DELETE("/:id", deleteDocument)

// Admin group — additional middleware
admin := v1.Group("/admin")
admin.Use(RequireRole("admin"))
admin.GET("/users", listUsers)
admin.PUT("/users/:id/role", updateUserRole)

// Public group — no auth
public := e.Group("")
public.GET("/health", healthCheck)
public.POST("/auth/login", login)
public.POST("/auth/register", register)
```

---

## 7. Middleware Example

```go
func JWTMiddleware(secret []byte) echo.MiddlewareFunc {
    return func(next echo.HandlerFunc) echo.HandlerFunc {
        return func(c echo.Context) error {
            auth := c.Request().Header.Get("Authorization")
            if !strings.HasPrefix(auth, "Bearer ") {
                return echo.NewHTTPError(401, "missing token")
            }
            
            claims, err := parseJWT(strings.TrimPrefix(auth, "Bearer "), secret)
            if err != nil {
                return echo.NewHTTPError(401, "invalid token")
            }
            
            c.Set("userID", claims.UserID)
            c.Set("userRole", claims.Role)
            
            return next(c) // return next(c) — đây là cách Echo stop/continue
        }
    }
}

// RequireRole
func RequireRole(roles ...string) echo.MiddlewareFunc {
    return func(next echo.HandlerFunc) echo.HandlerFunc {
        return func(c echo.Context) error {
            role := c.Get("userRole").(string)
            for _, r := range roles {
                if r == role { return next(c) }
            }
            return echo.NewHTTPError(403, "forbidden")
        }
    }
}
```

---

## 8. Auto-TLS với Let's Encrypt

```go
// Echo có built-in ACME/Let's Encrypt support
e := echo.New()
e.AutoTLSManager.Cache = autocert.DirCache("/var/www/.cache")

// Tự động request certificate
e.Logger.Fatal(e.StartAutoTLS(":443"))

// Với custom domain
e.AutoTLSManager.HostPolicy = autocert.HostWhitelist("api.pdms.vn")
```

---

## 9. Tips & Tricks

```
💡 TIP 1: Echo error handling clean hơn Gin
   return echo.NewHTTPError(404, "not found")
   vs Gin: c.AbortWithStatusJSON(404, ...) — side effect based

💡 TIP 2: c.Request().Context() cho standard ctx
   → Compatible với tất cả stdlib và third-party libraries
   Gin: c.Request.Context() (cú pháp khác một chút)

💡 TIP 3: Echo's middleware.KeyAuth cho API key auth
   e.Use(middleware.KeyAuthWithConfig(middleware.KeyAuthConfig{
       Validator: func(key string, c echo.Context) (bool, error) {
           return key == "valid-key", nil
       },
   }))

💡 TIP 4: Echo supports HTTP/2 out of the box
   e.StartTLS(":443", "cert.pem", "key.pem")
   → Tự động enable HTTP/2

💡 TIP 5: Bind và Validate có thể combine
   e.Use(middleware.BodyDump(...)) để log request/response pairs
```

---

## 10. Tổng kết Bài 14

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ Echo dùng standard context — tốt nhất cho libs  │
│  ✅ return err từ handler — cleaner error flow      │
│  ✅ c.Bind() auto-detect Content-Type               │
│  ✅ Custom validator tích hợp với go-playground     │
│  ✅ Global HTTPErrorHandler cho centralized errors  │
│  ✅ Built-in Auto-TLS với Let's Encrypt            │
│  ✅ MiddlewareFunc pattern nhất quán               │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-15-Chi-Clean-Architecture|Bài 15: Chi + Clean Architecture]]

---
*Tags: #go #echo #rest-api #standard-context #auto-tls #zero-to-hero*
