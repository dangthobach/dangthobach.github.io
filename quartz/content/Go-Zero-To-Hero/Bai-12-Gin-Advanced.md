# Bài 12: Gin Advanced — JWT, CORS, Rate Limit, WebSocket

> **Mục tiêu:** Xây dựng production-ready API với Gin — authentication, authorization, rate limiting, graceful shutdown, và WebSocket.

---

## 1. JWT Authentication Middleware

```
┌──────────────────────────────────────────────────────────────┐
│                   JWT FLOW WITH GIN                          │
│                                                              │
│  POST /auth/login                                            │
│  ├── Validate credentials                                    │
│  └── Return JWT (access + refresh tokens)                    │
│                                                              │
│  GET /api/v1/documents (with Authorization: Bearer <token>)  │
│  ├── AuthMiddleware:                                         │
│  │   ├── Extract token from header                          │
│  │   ├── Verify signature (HMAC/RSA)                        │
│  │   ├── Check expiration                                    │
│  │   └── Set userID in context                              │
│  └── Handler: use c.Get("userID")                           │
└──────────────────────────────────────────────────────────────┘
```

```go
// go get github.com/golang-jwt/jwt/v5

type Claims struct {
    UserID string `json:"user_id"`
    Email  string `json:"email"`
    Role   string `json:"role"`
    jwt.RegisteredClaims
}

// Generate token pair
func GenerateTokenPair(userID, email, role string, secret []byte) (access, refresh string, err error) {
    // Access token — short lived
    accessClaims := Claims{
        UserID: userID, Email: email, Role: role,
        RegisteredClaims: jwt.RegisteredClaims{
            ExpiresAt: jwt.NewNumericDate(time.Now().Add(15 * time.Minute)),
            IssuedAt:  jwt.NewNumericDate(time.Now()),
            Subject:   userID,
        },
    }
    access, err = jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims).SignedString(secret)
    if err != nil {
        return
    }
    
    // Refresh token — long lived
    refreshClaims := jwt.RegisteredClaims{
        ExpiresAt: jwt.NewNumericDate(time.Now().Add(7 * 24 * time.Hour)),
        Subject:   userID,
    }
    refresh, err = jwt.NewWithClaims(jwt.SigningMethodHS256, refreshClaims).SignedString(secret)
    return
}

// JWT Middleware
func JWTMiddleware(secret []byte) gin.HandlerFunc {
    return func(c *gin.Context) {
        authHeader := c.GetHeader("Authorization")
        if !strings.HasPrefix(authHeader, "Bearer ") {
            c.AbortWithStatusJSON(401, gin.H{"error": "missing bearer token"})
            return
        }
        
        tokenStr := strings.TrimPrefix(authHeader, "Bearer ")
        
        token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (any, error) {
            if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
                return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
            }
            return secret, nil
        })
        
        if err != nil || !token.Valid {
            c.AbortWithStatusJSON(401, gin.H{"error": "invalid or expired token"})
            return
        }
        
        claims := token.Claims.(*Claims)
        c.Set("userID", claims.UserID)
        c.Set("userRole", claims.Role)
        c.Set("userEmail", claims.Email)
        
        c.Next()
    }
}

// Role-based authorization
func RequireRole(roles ...string) gin.HandlerFunc {
    return func(c *gin.Context) {
        userRole := c.GetString("userRole")
        for _, role := range roles {
            if role == userRole {
                c.Next()
                return
            }
        }
        c.AbortWithStatusJSON(403, gin.H{"error": "insufficient permissions"})
    }
}
```

---

## 2. CORS Middleware

```go
// go get github.com/gin-contrib/cors

import "github.com/gin-contrib/cors"

func setupCORS() gin.HandlerFunc {
    config := cors.Config{
        AllowOrigins:     []string{"https://app.pdms.vn", "http://localhost:3000"},
        AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
        AllowHeaders:     []string{"Origin", "Content-Type", "Authorization", "X-Request-ID"},
        ExposeHeaders:    []string{"X-Request-ID", "X-Rate-Limit-Remaining"},
        AllowCredentials: true,
        MaxAge:           12 * time.Hour,
    }
    return cors.New(config)
}

// Hoặc custom CORS nếu cần dynamic origin
func DynamicCORS(allowedOrigins []string) gin.HandlerFunc {
    origins := make(map[string]bool)
    for _, o := range allowedOrigins {
        origins[o] = true
    }
    
    return func(c *gin.Context) {
        origin := c.Request.Header.Get("Origin")
        if origins[origin] {
            c.Header("Access-Control-Allow-Origin", origin)
            c.Header("Access-Control-Allow-Credentials", "true")
            c.Header("Vary", "Origin")
        }
        
        if c.Request.Method == "OPTIONS" {
            c.Header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,PATCH")
            c.Header("Access-Control-Allow-Headers", "Content-Type,Authorization")
            c.Header("Access-Control-Max-Age", "43200")
            c.AbortWithStatus(204)
            return
        }
        c.Next()
    }
}
```

---

## 3. Rate Limiting

```go
// go get golang.org/x/time/rate
// go get github.com/gin-contrib/ratelimit  (hoặc custom)

import "golang.org/x/time/rate"

// Per-IP rate limiter
type IPRateLimiter struct {
    limiters sync.Map
    rate     rate.Limit
    burst    int
}

func NewIPRateLimiter(r rate.Limit, burst int) *IPRateLimiter {
    return &IPRateLimiter{rate: r, burst: burst}
}

func (l *IPRateLimiter) GetLimiter(ip string) *rate.Limiter {
    v, _ := l.limiters.LoadOrStore(ip, rate.NewLimiter(l.rate, l.burst))
    return v.(*rate.Limiter)
}

func RateLimitMiddleware(limiter *IPRateLimiter) gin.HandlerFunc {
    return func(c *gin.Context) {
        ip := c.ClientIP()
        l := limiter.GetLimiter(ip)
        
        if !l.Allow() {
            c.Header("X-RateLimit-Limit", "100")
            c.Header("X-RateLimit-Remaining", "0")
            c.Header("Retry-After", "1")
            c.AbortWithStatusJSON(429, gin.H{
                "error": "too many requests",
                "retry_after_seconds": 1,
            })
            return
        }
        
        c.Header("X-RateLimit-Remaining", fmt.Sprintf("%.0f", l.Tokens()))
        c.Next()
    }
}

// Usage: 100 requests/second, burst up to 20
limiter := NewIPRateLimiter(rate.Limit(100), 20)
r.Use(RateLimitMiddleware(limiter))
```

---

## 4. WebSocket với Gin

```go
// go get github.com/gorilla/websocket

var upgrader = websocket.Upgrader{
    ReadBufferSize:  1024,
    WriteBufferSize: 1024,
    CheckOrigin: func(r *http.Request) bool {
        // Validate origin in production!
        return true
    },
}

// Document collaboration websocket
type DocumentHub struct {
    rooms      map[string]map[*websocket.Conn]bool
    mu         sync.RWMutex
    broadcast  chan Message
}

type Message struct {
    DocID   string `json:"doc_id"`
    UserID  string `json:"user_id"`
    Type    string `json:"type"` // "edit", "cursor", "presence"
    Content any    `json:"content"`
}

func (h *DocumentHub) HandleWebSocket(c *gin.Context) {
    docID := c.Param("docId")
    userID := c.GetString("userID")
    
    conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
    if err != nil {
        return
    }
    defer conn.Close()
    
    // Register connection
    h.mu.Lock()
    if h.rooms[docID] == nil {
        h.rooms[docID] = make(map[*websocket.Conn]bool)
    }
    h.rooms[docID][conn] = true
    h.mu.Unlock()
    
    defer func() {
        h.mu.Lock()
        delete(h.rooms[docID], conn)
        h.mu.Unlock()
    }()
    
    // Notify others of new user
    h.broadcast <- Message{DocID: docID, UserID: userID, Type: "presence", Content: "joined"}
    
    // Read loop
    for {
        var msg Message
        if err := conn.ReadJSON(&msg); err != nil {
            break
        }
        msg.DocID = docID
        msg.UserID = userID
        h.broadcast <- msg
    }
}

func (h *DocumentHub) Run() {
    for msg := range h.broadcast {
        h.mu.RLock()
        conns := h.rooms[msg.DocID]
        h.mu.RUnlock()
        
        for conn := range conns {
            conn.WriteJSON(msg)
        }
    }
}
```

---

## 5. Graceful Shutdown

```go
func main() {
    r := gin.New()
    r.Use(gin.Recovery(), gin.Logger())
    setupRoutes(r)
    
    srv := &http.Server{
        Addr:    ":8080",
        Handler: r,
    }
    
    // Start server
    go func() {
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatalf("listen: %v", err)
        }
    }()
    
    // Wait for interrupt signal
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit
    
    log.Println("Shutting down server...")
    
    // Give existing requests 30s to complete
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    
    if err := srv.Shutdown(ctx); err != nil {
        log.Fatal("Server forced to shutdown:", err)
    }
    
    log.Println("Server exiting")
}
```

---

## 6. Complete Router Setup

```go
func SetupRouter(
    docHandler *DocumentHandler,
    authHandler *AuthHandler,
    wsHub *DocumentHub,
    cfg Config,
) *gin.Engine {
    r := gin.New()
    r.Use(
        gin.Recovery(),
        RequestIDMiddleware(),
        Logger(),
        setupCORS(),
        RateLimitMiddleware(NewIPRateLimiter(100, 20)),
    )
    
    // Public routes
    auth := r.Group("/auth")
    {
        auth.POST("/login", authHandler.Login)
        auth.POST("/refresh", authHandler.Refresh)
        auth.POST("/register", authHandler.Register)
    }
    
    // Protected routes
    api := r.Group("/api/v1")
    api.Use(JWTMiddleware(cfg.JWTSecret))
    {
        docs := api.Group("/documents")
        {
            docs.GET("", docHandler.List)
            docs.POST("", docHandler.Create)
            docs.GET("/:id", docHandler.Get)
            docs.PUT("/:id", docHandler.Update)
            docs.DELETE("/:id", RequireRole("admin", "manager"), docHandler.Delete)
        }
        
        // WebSocket — requires auth
        api.GET("/ws/documents/:docId", wsHub.HandleWebSocket)
        
        // Admin only
        admin := api.Group("/admin")
        admin.Use(RequireRole("admin"))
        {
            admin.GET("/users", adminHandler.ListUsers)
            admin.DELETE("/users/:id", adminHandler.DeleteUser)
        }
    }
    
    return r
}
```

---

## 7. Tips & Tricks

```
💡 TIP 1: Refresh token rotation
   Mỗi lần dùng refresh token → issue new refresh token
   → Old refresh token bị invalidate → phát hiện token theft

💡 TIP 2: JWT secret rotation
   Dùng kid (key ID) trong JWT header
   → Support nhiều secret keys cùng lúc cho zero-downtime rotation

💡 TIP 3: Rate limit per endpoint, không chỉ per IP
   API login nên limit strict hơn (5 req/min)
   API read có thể liberal hơn (1000 req/min)

💡 TIP 4: WebSocket pingInterval để detect dead connections
   conn.SetPongHandler(...)
   go func() { ticker.Tick → conn.WriteMessage(Ping) }()

💡 TIP 5: Gin gin.SetMode(gin.ReleaseMode) trong production
   Loại bỏ debug output, giảm latency một chút
```

---

## 8. Tổng kết Bài 12

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ JWT: short access token + long refresh token    │
│  ✅ Claims typed struct với jwt.RegisteredClaims    │
│  ✅ Per-IP rate limiting với token bucket           │
│  ✅ CORS config phải whitelist origins cụ thể       │
│  ✅ WebSocket: hub pattern cho broadcast            │
│  ✅ Graceful shutdown: 30s để requests hoàn thành  │
│  ✅ RequireRole middleware cho RBAC                 │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-13-Fiber|Bài 13: Fiber Framework]]

---
*Tags: #go #gin #jwt #cors #rate-limit #websocket #zero-to-hero*
