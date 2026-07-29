---
type: tutorial
domain: languages/go/microservices
status: active
created: 2026-07-27
updated: 2026-07-30
tags: [go, net-http, vertical-slice, clean-architecture]
---

# Bài 05 — Product Service: vertical slice đầu tiên

> [!success] Deliverable
> `POST /v1/products` và `GET /v1/products/{id}` chạy bằng `net/http`, business rule được test mà không cần HTTP.

## 1. Đừng bắt đầu bằng framework

Lát cắt đầu giúp thấy bốn trách nhiệm:

```mermaid
flowchart LR
    H["HTTP handler"] --> A["Application service"]
    A --> D["Domain model"]
    A --> R["Repository port"]
    R --> M["In-memory adapter"]
```

- Handler hiểu HTTP, không chứa business rule.
- Application service điều phối use case.
- Domain bảo vệ invariant.
- Repository che cách lưu trữ.

## 2. Domain model

`internal/catalog/product.go`:

```go
package catalog

import (
    "errors"
    "strings"
)

var (
    ErrInvalidName = errors.New("product name is required")
    ErrInvalidPrice = errors.New("price must be positive")
)

type Product struct {
    ID         string `json:"id"`
    Name       string `json:"name"`
    PriceCents int64  `json:"price_cents"`
}

func NewProduct(id, name string, priceCents int64) (Product, error) {
    name = strings.TrimSpace(name)
    if name == "" {
        return Product{}, ErrInvalidName
    }
    if priceCents <= 0 {
        return Product{}, ErrInvalidPrice
    }
    return Product{ID: id, Name: name, PriceCents: priceCents}, nil
}
```

Dùng integer minor unit thay `float64` để tránh sai số biểu diễn tiền. Production còn cần currency và policy rounding rõ ràng.

## 3. Repository port nhỏ

`internal/catalog/repository.go`:

```go
package catalog

import (
    "context"
    "errors"
)

var ErrNotFound = errors.New("product not found")

type Repository interface {
    Save(ctx context.Context, product Product) error
    FindByID(ctx context.Context, id string) (Product, error)
}
```

Interface được khai báo gần consumer/application layer. Chỉ có method use case thực sự cần.

## 4. Application service

`internal/catalog/service.go`:

```go
package catalog

import (
    "context"
    "fmt"
)

type IDGenerator func() string

type Service struct {
    repo Repository
    newID IDGenerator
}

func NewService(repo Repository, newID IDGenerator) *Service {
    return &Service{repo: repo, newID: newID}
}

func (s *Service) Create(ctx context.Context, name string, priceCents int64) (Product, error) {
    product, err := NewProduct(s.newID(), name, priceCents)
    if err != nil {
        return Product{}, err
    }
    if err := s.repo.Save(ctx, product); err != nil {
        return Product{}, fmt.Errorf("save product: %w", err)
    }
    return product, nil
}

func (s *Service) Get(ctx context.Context, id string) (Product, error) {
    product, err := s.repo.FindByID(ctx, id)
    if err != nil {
        return Product{}, fmt.Errorf("find product %q: %w", id, err)
    }
    return product, nil
}
```

## 5. In-memory adapter concurrency-safe

`internal/catalog/memory_repository.go`:

```go
package catalog

import (
    "context"
    "sync"
)

type MemoryRepository struct {
    mu   sync.RWMutex
    data map[string]Product
}

func NewMemoryRepository() *MemoryRepository {
    return &MemoryRepository{data: make(map[string]Product)}
}

func (r *MemoryRepository) Save(ctx context.Context, p Product) error {
    if err := ctx.Err(); err != nil {
        return err
    }
    r.mu.Lock()
    defer r.mu.Unlock()
    r.data[p.ID] = p
    return nil
}

func (r *MemoryRepository) FindByID(ctx context.Context, id string) (Product, error) {
    if err := ctx.Err(); err != nil {
        return Product{}, err
    }
    r.mu.RLock()
    defer r.mu.RUnlock()
    p, ok := r.data[id]
    if !ok {
        return Product{}, ErrNotFound
    }
    return p, nil
}
```

## 6. HTTP transport

`internal/catalog/http_handler.go`:

```go
package catalog

import (
    "encoding/json"
    "errors"
    "net/http"
    "strings"
)

type Handler struct{ service *Service }

func NewHandler(service *Service) *Handler { return &Handler{service: service} }

func (h *Handler) Register(mux *http.ServeMux) {
    mux.HandleFunc("POST /v1/products", h.create)
    mux.HandleFunc("GET /v1/products/{id}", h.get)
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
    var input struct {
        Name       string `json:"name"`
        PriceCents int64  `json:"price_cents"`
    }
    dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
    dec.DisallowUnknownFields()
    if err := dec.Decode(&input); err != nil {
        writeError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body")
        return
    }

    product, err := h.service.Create(r.Context(), input.Name, input.PriceCents)
    if errors.Is(err, ErrInvalidName) || errors.Is(err, ErrInvalidPrice) {
        writeError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
        return
    }
    if err != nil {
        writeError(w, http.StatusInternalServerError, "internal_error", "internal server error")
        return
    }
    writeJSON(w, http.StatusCreated, product)
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
    product, err := h.service.Get(r.Context(), strings.TrimSpace(r.PathValue("id")))
    if errors.Is(err, ErrNotFound) {
        writeError(w, http.StatusNotFound, "product_not_found", "product not found")
        return
    }
    if err != nil {
        writeError(w, http.StatusInternalServerError, "internal_error", "internal server error")
        return
    }
    writeJSON(w, http.StatusOK, product)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    _ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
    writeJSON(w, status, map[string]any{
        "error": map[string]string{"code": code, "message": message},
    })
}
```

Không trả `err.Error()` cho lỗi internal vì có thể lộ database/schema/credential.

## 7. Composition root và server timeout

`cmd/api/main.go`:

```go
package main

import (
    "log"
    "net/http"
    "time"

    "github.com/google/uuid"
    "github.com/<your-org>/gocommerce/internal/catalog"
)

func main() {
    repo := catalog.NewMemoryRepository()
    service := catalog.NewService(repo, func() string { return uuid.NewString() })
    handler := catalog.NewHandler(service)

    mux := http.NewServeMux()
    handler.Register(mux)

    server := &http.Server{
        Addr:              ":8080",
        Handler:           mux,
        ReadHeaderTimeout: 5 * time.Second,
        ReadTimeout:       10 * time.Second,
        WriteTimeout:      15 * time.Second,
        IdleTimeout:       60 * time.Second,
    }
    log.Fatal(server.ListenAndServe())
}
```

Thêm dependency:

```bash
go get github.com/google/uuid
go mod tidy
go run ./cmd/api
```

## 8. Kiểm thử nhanh

```bash
curl -i -X POST http://localhost:8080/v1/products \
  -H "Content-Type: application/json" \
  -d '{"name":"Mechanical Keyboard","price_cents":12900}'
```

Lấy `id` trả về:

```bash
curl -i http://localhost:8080/v1/products/<id>
curl -i http://localhost:8080/v1/products/not-found
```

## 9. Unit test business rule

`internal/catalog/product_test.go`:

```go
package catalog

import (
    "errors"
    "testing"
)

func TestNewProduct(t *testing.T) {
    tests := []struct {
        name  string
        input string
        price int64
        want  error
    }{
        {name: "valid", input: "Keyboard", price: 100, want: nil},
        {name: "blank name", input: "  ", price: 100, want: ErrInvalidName},
        {name: "zero price", input: "Keyboard", price: 0, want: ErrInvalidPrice},
    }
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            _, err := NewProduct("p-1", tt.input, tt.price)
            if !errors.Is(err, tt.want) {
                t.Fatalf("NewProduct() error = %v, want %v", err, tt.want)
            }
        })
    }
}
```

Chạy:

```bash
go test ./...
go test -race ./...
```

## 🔬 Đào sâu kỹ thuật — vì sao `RWMutex` không phải "cứ khóa cho chắc", và chi phí thật của nó

`MemoryRepository` ở mục 5 dùng `sync.RWMutex` — nhưng một mutex chỉ đúng nếu ta hiểu nó bảo vệ **cái gì**, và biết được cái giá phải trả khi contention tăng.

### Điều `RWMutex` thực sự bảo vệ

`RWMutex` không bảo vệ "map" — nó bảo vệ **invariant**: "không có write nào xảy ra đồng thời với read hoặc write khác". Map của Go **không** an toàn để đọc/ghi đồng thời kể cả khi chỉ một goroutine ghi — runtime sẽ panic với `fatal error: concurrent map read and map write` nếu thiếu mutex. Đây không phải "best practice", mà là bất biến bắt buộc của runtime.

```mermaid
sequenceDiagram
    participant G1 as Goroutine đọc (RLock)
    participant G2 as Goroutine đọc (RLock)
    participant G3 as Goroutine ghi (Lock)
    G1->>G1: RLock giữ được — nhiều reader song song
    G2->>G2: RLock giữ được — cùng lúc với G1
    G3->>G3: Lock phải chờ G1, G2 RUnlock xong
    Note over G3: Writer độc quyền — không reader/writer nào khác chen vào
```

### Đo chi phí bằng benchmark thay vì đoán

`internal/catalog/memory_repository_bench_test.go`:

```go
package catalog

import (
    "context"
    "strconv"
    "testing"
)

func BenchmarkMemoryRepository_ReadHeavy(b *testing.B) {
    repo := NewMemoryRepository()
    ctx := context.Background()
    for i := 0; i < 1000; i++ {
        p, _ := NewProduct(strconv.Itoa(i), "seed", 100)
        _ = repo.Save(ctx, p)
    }

    b.RunParallel(func(pb *testing.PB) {
        i := 0
        for pb.Next() {
            _, _ = repo.FindByID(ctx, strconv.Itoa(i%1000))
            i++
        }
    })
}

func BenchmarkMemoryRepository_WriteHeavy(b *testing.B) {
    repo := NewMemoryRepository()
    ctx := context.Background()
    b.RunParallel(func(pb *testing.PB) {
        i := 0
        for pb.Next() {
            p, _ := NewProduct(strconv.Itoa(i), "product", 100)
            _ = repo.Save(ctx, p)
            i++
        }
    })
}
```

```bash
go test -bench=MemoryRepository -benchmem -cpu=1,2,4,8 ./internal/catalog/
```

Chạy với `-cpu=1,2,4,8` cho thấy read-heavy workload scale gần tuyến tính theo core (nhiều `RLock` chạy song song), trong khi write-heavy gần như không cải thiện — writer độc quyền là điểm nghẽn. Đây là bằng chứng cụ thể, không phải cảm tính, cho quyết định ở bài 13: chuyển sang PostgreSQL với connection pool khi write contention thật sự xuất hiện.

### Xác nhận không có race bằng công cụ, không bằng mắt

```bash
go test -race -run=. ./internal/catalog/
```

Race detector mô phỏng lịch sử truy cập bộ nhớ (happens-before) và báo chính xác dòng code xung đột nếu có — hãy chạy lệnh này mỗi khi sửa `memory_repository.go`, không chỉ khi nghi ngờ có bug.

### Nối vào repo

Benchmark này commit cùng bài 05 và được bài 13 (PostgreSQL) chạy lại để so sánh trực tiếp: `BenchmarkMemoryRepository_WriteHeavy` so với benchmark tương đương trên `pgxpool` — một con số cụ thể thay cho nhận định "database sẽ nhanh hơn/chậm hơn".

## Failure checklist

- Body lớn hơn 1 MiB bị từ chối.
- Field lạ bị từ chối.
- Name rỗng/price không dương trả 422.
- ID không tồn tại trả 404.
- Internal error trả thông báo chung, không lộ chi tiết.
- Repository memory không race khi concurrent access.

## Definition of Done

- [ ] Hai endpoint chạy đúng.
- [ ] Domain test không import `net/http`.
- [ ] Handler không truy cập map/database trực tiếp.
- [ ] Error mapping phân biệt 400, 404, 422 và 500.
- [ ] `go test -race ./...` thành công.
- [ ] `go test -bench=MemoryRepository -benchmem` chạy được và đọc hiểu kết quả read vs write contention.

---

**Trước:** [[04-Chuan-bi-moi-truong-va-Repository]] · **Tiếp theo:** [[06-Chuan-Engineering-cho-moi-Service]]
