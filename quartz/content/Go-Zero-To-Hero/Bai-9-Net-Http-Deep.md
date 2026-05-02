# Bài 9: net/http Deep Dive — Standard Library

> **Mục tiêu:** Hiểu HTTP server của Go từ bên trong — Handler, ServeMux, middleware chaining, connection lifecycle. Nền tảng để hiểu Gin/Echo/Fiber.

---

## 1. Go HTTP Server Architecture

```
┌──────────────────────────────────────────────────────────────┐
│              GO HTTP SERVER INTERNALS                        │
│                                                              │
│  Client Request                                              │
│       │                                                      │
│       ▼                                                      │
│  ┌─────────────────────────────────────────────┐            │
│  │  net.Listener (TCP accept loop)             │            │
│  │  for { conn, _ := l.Accept(); go serve(conn)}│            │
│  └─────────────────────────────────────────────┘            │
│       │ New goroutine per connection                         │
│       ▼                                                      │
│  ┌─────────────────────────────────────────────┐            │
│  │  HTTP Parser (reads request headers/body)   │            │
│  └─────────────────────────────────────────────┘            │
│       │                                                      │
│       ▼                                                      │
│  ┌─────────────────────────────────────────────┐            │
│  │  ServeMux (router — longest prefix match)   │            │
│  │  /api/v1/documents/:id → handler            │            │
│  └─────────────────────────────────────────────┘            │
│       │                                                      │
│       ▼                                                      │
│  ┌─────────────────────────────────────────────┐            │
│  │  Handler.ServeHTTP(w ResponseWriter, r *Req)│            │
│  └─────────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────┘

1 connection = 1 goroutine (Go 1.22: HTTP/2 multiplexes streams)
→ Tự nhiên handle concurrent requests mà không cần thread pool!
```

---

## 2. Handler Interface — Foundation

```go
// Handler interface — cốt lõi của net/http
type Handler interface {
    ServeHTTP(ResponseWriter, *Request)
}

// HandlerFunc — adapter để dùng function như Handler
type HandlerFunc func(ResponseWriter, *Request)

func (f HandlerFunc) ServeHTTP(w ResponseWriter, r *Request) {
    f(w, r)
}

// Cách viết handler
func helloHandler(w http.ResponseWriter, r *http.Request) {
    // ResponseWriter — interface để write response
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK) // Set status code
    w.Write([]byte(`{"message": "hello"}`))
    
    // Hoặc dùng encoder (better)
    json.NewEncoder(w).Encode(map[string]string{"message": "hello"})
}

// Minimal HTTP server
func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/hello", helloHandler)
    mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })
    
    server := &http.Server{
        Addr:         ":8080",
        Handler:      mux,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
        IdleTimeout:  60 * time.Second,
    }
    
    log.Fatal(server.ListenAndServe())
}
```

---

## 3. Middleware Chaining Pattern

```
┌──────────────────────────────────────────────────────────────┐
│              MIDDLEWARE CHAIN (Onion Pattern)                 │
│                                                              │
│  Request ──► Logger ──► Auth ──► CORS ──► Handler           │
│                                              │               │
│  Response ◄─ Logger ◄─ Auth ◄─ CORS ◄───────┘               │
│                                                              │
│  Each middleware wraps the next:                             │
│  loggerMiddleware(                                           │
│    authMiddleware(                                           │
│      corsMiddleware(                                         │
│        handler                                               │
│      )                                                       │
│    )                                                         │
│  )                                                           │
└──────────────────────────────────────────────────────────────┘
```

```go
// Middleware type
type Middleware func(http.Handler) http.Handler

// Logger middleware
func Logger(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        
        // Wrap ResponseWriter để capture status code
        wrapped := &responseWriter{ResponseWriter: w, status: 200}
        
        next.ServeHTTP(wrapped, r) // Call next handler
        
        // Log AFTER handler completes
        log.Printf("%s %s %d %v", r.Method, r.URL.Path, wrapped.status, time.Since(start))
    })
}

// ResponseWriter wrapper để capture status
type responseWriter struct {
    http.ResponseWriter
    status int
}

func (rw *responseWriter) WriteHeader(status int) {
    rw.status = status
    rw.ResponseWriter.WriteHeader(status)
}

// Chain utility
func Chain(middlewares ...Middleware) Middleware {
    return func(final http.Handler) http.Handler {
        for i := len(middlewares) - 1; i >= 0; i-- {
            final = middlewares[i](final)
        }
        return final
    }
}

// Usage
chain := Chain(Logger, Auth, CORS)
http.Handle("/api/", chain(apiHandler))
```

---

## 4. Request Parsing

```go
func parseRequest(w http.ResponseWriter, r *http.Request) {
    // ── Method check ──
    if r.Method != http.MethodPost {
        http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
        return
    }
    
    // ── Path parameters (Go 1.22 mux supports patterns) ──
    // GET /users/{id}
    id := r.PathValue("id")
    
    // ── Query parameters ──
    page := r.URL.Query().Get("page")
    limit := r.URL.Query().Get("limit")
    
    // ── Headers ──
    contentType := r.Header.Get("Content-Type")
    bearer := r.Header.Get("Authorization") // "Bearer <token>"
    
    // ── JSON body ──
    var body struct {
        Name  string `json:"name"`
        Email string `json:"email"`
    }
    
    r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1MB limit
    decoder := json.NewDecoder(r.Body)
    decoder.DisallowUnknownFields() // Strict parsing
    
    if err := decoder.Decode(&body); err != nil {
        http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
        return
    }
    
    // ── Form data ──
    r.ParseForm()
    username := r.FormValue("username")
    
    _ = id; _ = page; _ = limit; _ = contentType; _ = bearer; _ = username
}
```

---

## 5. Go 1.22 Enhanced ServeMux

```go
// Go 1.22 added method + path params to stdlib mux!
mux := http.NewServeMux()

// Method-specific routing (mới từ Go 1.22)
mux.HandleFunc("GET /users/{id}", getUser)
mux.HandleFunc("POST /users", createUser)
mux.HandleFunc("PUT /users/{id}", updateUser)
mux.HandleFunc("DELETE /users/{id}", deleteUser)

// Path parameters
func getUser(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id") // New Go 1.22 API
    // ...
}

// NOTE: Trước Go 1.22 cần dùng thư viện routing riêng (gorilla/mux, chi)
// Từ Go 1.22: stdlib đủ dùng cho nhiều use case đơn giản
```

---

## 6. Server Configuration Best Practices

```go
func newServer(handler http.Handler) *http.Server {
    return &http.Server{
        Addr:    ":8080",
        Handler: handler,
        
        // Timeouts — QUAN TRỌNG để tránh resource leaks
        ReadTimeout:       5 * time.Second,  // Time to read request body
        ReadHeaderTimeout: 2 * time.Second,  // Time to read request headers
        WriteTimeout:      10 * time.Second, // Time to write response
        IdleTimeout:       120 * time.Second, // Keep-alive timeout
        
        // Limits
        MaxHeaderBytes: 1 << 20, // 1 MB
        
        // TLS (production)
        TLSConfig: &tls.Config{
            MinVersion: tls.VersionTLS12,
            CipherSuites: []uint16{
                tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
                tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
            },
        },
    }
}
```

---

## 7. Tips & Tricks

```
💡 TIP 1: Luôn set timeouts trên http.Server
   Không có timeout → goroutine leak khi client chậm

💡 TIP 2: http.MaxBytesReader giới hạn body size
   Tránh OOM attacks với body quá lớn

💡 TIP 3: http.Client cần timeout
   client := &http.Client{Timeout: 10 * time.Second}
   Không set → request block vĩnh viễn

💡 TIP 4: Go 1.22+ stdlib mux đủ cho microservices nhỏ
   Chỉ cần Gin/Echo khi cần: middleware chain mạnh,
   request binding, validation built-in

💡 TIP 5: http.DefaultServeMux là shared global — tránh dùng
   Dùng http.NewServeMux() để tạo instance riêng
```

---

## 8. Tổng kết Bài 9

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ 1 connection = 1 goroutine (lightweight!)        │
│  ✅ Handler interface: ServeHTTP(w, r)              │
│  ✅ Middleware = func(Handler) Handler               │
│  ✅ Go 1.22 mux hỗ trợ method + path params        │
│  ✅ Luôn set ReadTimeout, WriteTimeout, IdleTimeout │
│  ✅ MaxBytesReader để giới hạn body size            │
│  ✅ http.Client cần Timeout để tránh goroutine leak │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-10-GORM-PostgreSQL|Bài 10: GORM & PostgreSQL Integration]]

---
*Tags: #go #net-http #middleware #handler #server #zero-to-hero*
