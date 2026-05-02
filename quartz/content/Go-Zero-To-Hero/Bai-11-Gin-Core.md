# Bài 11: Gin Framework Core

> **Mục tiêu:** Xây dựng REST API hoàn chỉnh với Gin — routing, middleware, binding, validation, error handling chuẩn production.

---

## 1. Tại sao Gin là #1?

```
┌──────────────────────────────────────────────────────────────┐
│              GIN vs ALTERNATIVES (2026)                      │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  GitHub Stars: Gin ★75K > Fiber ★35K > Echo ★30K           │
│                                                              │
│  Throughput (~req/s):                                        │
│  Gin  ████████████████████ ~70K req/s                        │
│  Echo █████████████████ ~65K req/s                           │
│  Chi  ████████████████ ~60K req/s                            │
│  http ██████████████ ~50K req/s                              │
│                                                              │
│  WHY GIN WINS:                                               │
│  ✅ Zero-allocation router (httprouter)                      │
│  ✅ Largest middleware ecosystem                              │
│  ✅ Baked-in validation (go-playground/validator)            │
│  ✅ Most tutorials, most Stack Overflow answers              │
│  ✅ Used by: Alibaba, IBM, Docker ecosystem                  │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Kiến trúc của Gin

```
┌──────────────────────────────────────────────────────────────┐
│                   GIN REQUEST LIFECYCLE                      │
│                                                              │
│  HTTP Request                                                │
│       │                                                      │
│       ▼                                                      │
│  ┌─────────────────────────────────────────┐                │
│  │          Middleware Chain               │                │
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐  │                │
│  │  │Logger│►│Auth  │►│CORS  │►│Limit │  │                │
│  │  └──────┘ └──────┘ └──────┘ └──────┘  │                │
│  └─────────────────────────────────────────┘                │
│       │  c.Next()                                            │
│       ▼                                                      │
│  ┌─────────────────────────────────────────┐                │
│  │  Router (httprouter — radix tree)        │                │
│  │  GET  /users/:id  ──► UserHandler        │                │
│  │  POST /users      ──► CreateHandler      │                │
│  │  PUT  /users/:id  ──► UpdateHandler      │                │
│  └─────────────────────────────────────────┘                │
│       │                                                      │
│       ▼                                                      │
│  ┌─────────────────────────────────────────┐                │
│  │  Handler func(c *gin.Context)            │                │
│  │  - Parse request                         │                │
│  │  - Call business logic                   │                │
│  │  - Write response                        │                │
│  └─────────────────────────────────────────┘                │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Setup Project

```bash
mkdir gin-api && cd gin-api
go mod init github.com/bach/gin-api

go get github.com/gin-gonic/gin
go get github.com/gin-gonic/gin/binding
go get github.com/go-playground/validator/v10
```

---

## 4. Routing

```go
package main

import (
    "net/http"
    "github.com/gin-gonic/gin"
)

func main() {
    r := gin.Default() // Default = Logger + Recovery middleware

    // ─── Basic routes ───
    r.GET("/ping", func(c *gin.Context) {
        c.JSON(http.StatusOK, gin.H{"message": "pong"})
    })

    // ─── Path parameters ───
    r.GET("/users/:id", getUser)
    
    // ─── Query parameters ───
    r.GET("/users", listUsers) // /users?page=1&limit=20

    // ─── Route groups ───
    api := r.Group("/api/v1")
    {
        api.GET("/products", listProducts)
        api.POST("/products", createProduct)
        
        // Nested groups
        admin := api.Group("/admin")
        admin.Use(AuthMiddleware())  // middleware chỉ cho admin
        {
            admin.DELETE("/products/:id", deleteProduct)
        }
    }

    r.Run(":8080")
}
```

---

## 5. gin.Context — Trái tim của Gin

```go
func getUser(c *gin.Context) {
    // ─── Path params ───
    id := c.Param("id")               // /users/:id
    
    // ─── Query params ───
    page := c.Query("page")           // /users?page=1
    limit := c.DefaultQuery("limit", "20")
    
    // ─── Headers ───
    token := c.GetHeader("Authorization")
    
    // ─── Context values (set by middleware) ───
    userID, _ := c.Get("userID")     // type assertion needed
    userID2 := c.MustGet("userID")   // panic if not found
    
    // ─── Response ───
    c.JSON(http.StatusOK, gin.H{
        "id": id,
        "user": userID,
    })
    
    // Abort pipeline (middleware stopping request)
    c.AbortWithStatus(http.StatusUnauthorized)
    c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
        "error": "unauthorized",
    })
}
```

---

## 6. Request Binding & Validation

```go
// Struct với validation tags
type CreateUserRequest struct {
    Name     string `json:"name"     binding:"required,min=2,max=100"`
    Email    string `json:"email"    binding:"required,email"`
    Age      int    `json:"age"      binding:"required,min=18,max=120"`
    Role     string `json:"role"     binding:"required,oneof=admin user viewer"`
    Password string `json:"password" binding:"required,min=8"`
}

func createUser(c *gin.Context) {
    var req CreateUserRequest
    
    // ShouldBind = bind + validate, trả về error nếu thất bại
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{
            "error":   "validation failed",
            "details": err.Error(),
        })
        return
    }
    
    // req.Name, req.Email, req.Age đã được validate
    user, err := userService.Create(c.Request.Context(), req)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    
    c.JSON(http.StatusCreated, user)
}
```

### Validation Flow
```
┌──────────────────────────────────────────────────────────────┐
│              BINDING & VALIDATION FLOW                       │
│                                                              │
│  JSON Body                                                   │
│  {"name":"","email":"not-email","age":15}                   │
│       │                                                      │
│       ▼ ShouldBindJSON(&req)                                 │
│  ┌─────────────────────────┐                                 │
│  │  Binding (JSON decode)  │                                 │
│  └───────────┬─────────────┘                                 │
│              │                                               │
│              ▼                                               │
│  ┌─────────────────────────┐                                 │
│  │  Validator              │                                 │
│  │  name: required ❌      │                                 │
│  │  email: email ❌        │                                 │
│  │  age: min=18 ❌         │                                 │
│  └───────────┬─────────────┘                                 │
│              │                                               │
│              ▼                                               │
│  ValidationErrors (slice) → 400 Bad Request                  │
└──────────────────────────────────────────────────────────────┘
```

---

## 7. Middleware

```go
// ─── Custom Middleware Template ───
func AuthMiddleware() gin.HandlerFunc {
    return func(c *gin.Context) {
        token := c.GetHeader("Authorization")
        
        if token == "" {
            c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
                "error": "missing authorization header",
            })
            return // c.Abort() đã được gọi, không cần return thêm gì
        }
        
        // Validate token...
        userID, err := validateToken(token)
        if err != nil {
            c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
                "error": "invalid token",
            })
            return
        }
        
        // Set vào context để handlers sau dùng
        c.Set("userID", userID)
        
        c.Next() // Chuyển sang middleware/handler tiếp theo
        
        // Code sau c.Next() chạy SAU khi handler xong (như defer)
        // Dùng để log response status, v.v.
    }
}
```

### Middleware Execution Order
```
Request ─► M1.before ─► M2.before ─► M3.before ─► Handler
                                                      │
Response ◄─ M1.after ◄─ M2.after ◄─ M3.after ◄──────┘

Code trong gin.HandlerFunc:
  [code trước c.Next()]  → chạy khi request đến
  c.Next()               → gọi handler tiếp theo
  [code sau c.Next()]    → chạy khi response đi ra
```

---

## 8. Error Handling Pattern (Production)

```go
// Custom error types
type AppError struct {
    Code    string `json:"code"`
    Message string `json:"message"`
    Status  int    `json:"-"`
}

func (e *AppError) Error() string { return e.Message }

var (
    ErrNotFound   = &AppError{Code: "NOT_FOUND", Status: 404}
    ErrForbidden  = &AppError{Code: "FORBIDDEN", Status: 403}
)

// Global error handler middleware
func ErrorHandler() gin.HandlerFunc {
    return func(c *gin.Context) {
        c.Next()
        
        if len(c.Errors) == 0 {
            return
        }
        
        err := c.Errors.Last().Err
        
        var appErr *AppError
        if errors.As(err, &appErr) {
            c.JSON(appErr.Status, appErr)
            return
        }
        
        c.JSON(http.StatusInternalServerError, gin.H{
            "code":    "INTERNAL_ERROR",
            "message": "unexpected error occurred",
        })
    }
}

// Trong handler — dùng c.Error() thay vì c.JSON() trực tiếp
func getUser(c *gin.Context) {
    user, err := userRepo.FindByID(c.Param("id"))
    if err != nil {
        c.Error(ErrNotFound)  // error sẽ được xử lý bởi ErrorHandler
        return
    }
    c.JSON(http.StatusOK, user)
}
```

---

## 9. Complete Example — PDMS-like Document API

```go
package main

import (
    "net/http"
    "github.com/gin-gonic/gin"
)

// Domain
type Document struct {
    ID       string `json:"id"`
    Title    string `json:"title"`
    Content  string `json:"content"`
    OwnerID  string `json:"owner_id"`
}

type CreateDocRequest struct {
    Title   string `json:"title"   binding:"required,min=1,max=255"`
    Content string `json:"content" binding:"required"`
}

// Handler
type DocumentHandler struct {
    svc DocumentService
}

func (h *DocumentHandler) Register(r *gin.RouterGroup) {
    r.GET("", h.List)
    r.POST("", h.Create)
    r.GET("/:id", h.Get)
    r.PUT("/:id", h.Update)
    r.DELETE("/:id", h.Delete)
}

func (h *DocumentHandler) Create(c *gin.Context) {
    var req CreateDocRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }
    
    ownerID := c.MustGet("userID").(string)
    doc, err := h.svc.Create(c.Request.Context(), ownerID, req)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    
    c.JSON(http.StatusCreated, doc)
}

// Main
func main() {
    r := gin.New()
    r.Use(gin.Logger(), gin.Recovery())
    r.Use(ErrorHandler())
    
    api := r.Group("/api/v1")
    api.Use(AuthMiddleware())
    
    docHandler := &DocumentHandler{svc: NewDocumentService()}
    docHandler.Register(api.Group("/documents"))
    
    r.Run(":8080")
}
```

---

## 10. Tổng kết Bài 11

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ gin.Default() = Logger + Recovery               │
│  ✅ Route groups giúp organize routes               │
│  ✅ ShouldBindJSON = decode + validate atomically   │
│  ✅ Middleware: code trước/sau c.Next()             │
│  ✅ c.AbortWith* để dừng middleware chain           │
│  ✅ c.Set/c.Get để truyền data giữa middlewares     │
│  ✅ Global ErrorHandler pattern cho clean code      │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-12-Gin-Advanced|Bài 12: Gin Advanced — JWT, CORS, Rate Limit, WebSocket]]

---

**Bài tập:**
1. Build CRUD API cho `Document` với Gin + in-memory store (map)
2. Thêm middleware log request time (time từ trước đến sau `c.Next()`)
3. Implement custom validator cho `phone_vn` (số điện thoại VN)

---
*Tags: #go #gin #rest-api #middleware #validation #zero-to-hero*
