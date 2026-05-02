# Bài 15: Chi + Clean Architecture

> **Mục tiêu:** Dùng Chi router để build Clean Architecture — tách biệt domain logic khỏi infrastructure, dễ test, dễ maintain.

---

## 1. Tại sao Chi?

```
┌──────────────────────────────────────────────────────────────┐
│                   CHI PHILOSOPHY                             │
│                                                              │
│  "Chi is an idiomatic, composable, battle-tested Go HTTP    │
│   routing library. Built on the standard net/http."         │
│                                                              │
│  Chi = ONLY Router + Middleware                              │
│  → Không có binding, validation, ORM, templating            │
│  → Bạn tự chọn từng component phù hợp                      │
│                                                              │
│  WHO USES CHI:                                               │
│  - Projects cần Clean Architecture rõ ràng                  │
│  - Teams muốn control từng dependency                        │
│  - Microservices với bounded contexts                        │
│  - Teams đến từ Go standard library background              │
│                                                              │
│  KEY FEATURE: 100% net/http compatible                       │
│  → Mọi net/http middleware đều dùng được với Chi            │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Chi Basics

```go
// go get github.com/go-chi/chi/v5

import (
    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
)

func main() {
    r := chi.NewRouter()
    
    // Built-in middleware
    r.Use(middleware.RequestID)
    r.Use(middleware.RealIP)
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)
    r.Use(middleware.Timeout(60 * time.Second)) // Per-request timeout
    r.Use(middleware.Compress(5))               // gzip level 5
    
    // Routes
    r.Get("/health", healthCheck)
    
    r.Route("/api/v1", func(r chi.Router) {
        r.Use(JWTMiddleware)
        
        r.Route("/documents", func(r chi.Router) {
            r.Get("/", listDocuments)
            r.Post("/", createDocument)
            r.Get("/{id}", getDocument)
            r.Put("/{id}", updateDocument)
            r.Delete("/{id}", deleteDocument)
        })
    })
    
    http.ListenAndServe(":8080", r)
}

// Chi path params
func getDocument(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id") // Chi URL param extraction
    ctx := r.Context()          // Standard context
    // ...
}
```

---

## 3. Clean Architecture Structure

```
┌──────────────────────────────────────────────────────────────┐
│                 CLEAN ARCHITECTURE LAYERS                    │
│                                                              │
│  ┌─────────────────────────────────────────────┐            │
│  │              Delivery Layer                  │            │
│  │  (HTTP handlers, gRPC servers, CLI)          │            │
│  │  ← Knows about: Use Cases, Domain            │            │
│  └─────────────────┬───────────────────────────┘            │
│                    │ calls                                   │
│  ┌─────────────────▼───────────────────────────┐            │
│  │              Use Case Layer                  │            │
│  │  (Business logic, orchestration)             │            │
│  │  ← Knows about: Domain only                  │            │
│  └─────────────────┬───────────────────────────┘            │
│                    │ calls interfaces                        │
│  ┌─────────────────▼───────────────────────────┐            │
│  │              Repository Interfaces           │            │
│  │  (Defined in Domain or UseCase layer)        │            │
│  └─────────────────┬───────────────────────────┘            │
│                    │ implements                              │
│  ┌─────────────────▼───────────────────────────┐            │
│  │           Infrastructure Layer               │            │
│  │  (PostgreSQL, Kafka, Redis, HTTP clients)    │            │
│  │  ← Knows about: Domain, Repository Interface │            │
│  └─────────────────────────────────────────────┘            │
│                                                              │
│  DEPENDENCY RULE: Inner layers know NOTHING about outer     │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Domain Layer

```go
// internal/domain/document.go
package domain

import (
    "errors"
    "time"
)

// Domain errors
var (
    ErrDocumentNotFound  = errors.New("document not found")
    ErrDocumentArchived  = errors.New("document is archived")
    ErrUnauthorized      = errors.New("unauthorized")
    ErrInvalidTitle      = errors.New("title cannot be empty")
)

// Domain entity — pure Go struct, no DB tags, no JSON tags
type Document struct {
    ID        string
    Title     string
    Content   string
    Status    DocumentStatus
    OwnerID   string
    CreatedAt time.Time
    UpdatedAt time.Time
}

type DocumentStatus string

const (
    StatusDraft    DocumentStatus = "draft"
    StatusActive   DocumentStatus = "active"
    StatusArchived DocumentStatus = "archived"
)

// Domain behavior — business rules live here
func (d *Document) Archive() error {
    if d.Status == StatusArchived {
        return ErrDocumentArchived
    }
    d.Status = StatusArchived
    d.UpdatedAt = time.Now()
    return nil
}

func (d *Document) Rename(title string) error {
    if title == "" {
        return ErrInvalidTitle
    }
    d.Title = title
    d.UpdatedAt = time.Now()
    return nil
}

func (d *Document) CanBeAccessedBy(userID string) bool {
    return d.OwnerID == userID
}
```

---

## 5. Repository Interface (Domain Layer)

```go
// internal/domain/repository.go — interface defined IN domain
package domain

import "context"

// Thin interface — only what domain needs
type DocumentRepository interface {
    FindByID(ctx context.Context, id string) (*Document, error)
    FindByOwner(ctx context.Context, ownerID string, filter DocumentFilter) ([]*Document, int64, error)
    Save(ctx context.Context, doc *Document) error    // Create + Update
    Delete(ctx context.Context, id string) error
}

type DocumentFilter struct {
    Status string
    Search string
    Page   int
    Limit  int
}
```

---

## 6. Use Case Layer

```go
// internal/usecase/document_usecase.go
package usecase

import (
    "context"
    "fmt"
    "github.com/bach/pdms/internal/domain"
)

type DocumentUseCase struct {
    repo        domain.DocumentRepository
    eventBus    EventPublisher
    pdfService  PDFGenerator
}

func NewDocumentUseCase(
    repo domain.DocumentRepository,
    eventBus EventPublisher,
    pdfService PDFGenerator,
) *DocumentUseCase {
    return &DocumentUseCase{repo: repo, eventBus: eventBus, pdfService: pdfService}
}

// Get — orchestration với business rules
func (uc *DocumentUseCase) Get(ctx context.Context, id, requesterID string) (*domain.Document, error) {
    doc, err := uc.repo.FindByID(ctx, id)
    if err != nil {
        return nil, fmt.Errorf("Get: %w", err)
    }
    
    if !doc.CanBeAccessedBy(requesterID) {
        return nil, domain.ErrUnauthorized
    }
    
    return doc, nil
}

// Archive — domain logic + side effects
func (uc *DocumentUseCase) Archive(ctx context.Context, id, requesterID string) error {
    doc, err := uc.repo.FindByID(ctx, id)
    if err != nil {
        return fmt.Errorf("Archive: %w", err)
    }
    
    if !doc.CanBeAccessedBy(requesterID) {
        return domain.ErrUnauthorized
    }
    
    // Domain logic
    if err := doc.Archive(); err != nil {
        return fmt.Errorf("Archive: %w", err)
    }
    
    // Persist
    if err := uc.repo.Save(ctx, doc); err != nil {
        return fmt.Errorf("Archive: %w", err)
    }
    
    // Side effects (events, notifications)
    uc.eventBus.Publish(DocumentArchivedEvent{DocID: id, By: requesterID})
    
    return nil
}
```

---

## 7. Infrastructure Layer (PostgreSQL Repository)

```go
// internal/infrastructure/postgres/document_repo.go
package postgres

import (
    "context"
    "gorm.io/gorm"
    "github.com/bach/pdms/internal/domain"
)

// DB model — separate from domain entity!
type documentModel struct {
    ID        string         `gorm:"primaryKey"`
    Title     string         `gorm:"not null"`
    Content   string         `gorm:"type:text"`
    Status    string         `gorm:"not null"`
    OwnerID   string         `gorm:"index"`
    CreatedAt time.Time
    UpdatedAt time.Time
    DeletedAt gorm.DeletedAt `gorm:"index"`
}

type documentRepo struct {
    db *gorm.DB
}

func NewDocumentRepo(db *gorm.DB) domain.DocumentRepository {
    return &documentRepo{db: db}
}

func (r *documentRepo) FindByID(ctx context.Context, id string) (*domain.Document, error) {
    var model documentModel
    result := r.db.WithContext(ctx).First(&model, "id = ?", id)
    if result.Error != nil {
        if errors.Is(result.Error, gorm.ErrRecordNotFound) {
            return nil, domain.ErrDocumentNotFound
        }
        return nil, result.Error
    }
    return toDomain(&model), nil // Map DB model → Domain entity
}

func (r *documentRepo) Save(ctx context.Context, doc *domain.Document) error {
    model := toModel(doc) // Map Domain entity → DB model
    return r.db.WithContext(ctx).Save(model).Error
}

// Mapper functions
func toDomain(m *documentModel) *domain.Document {
    return &domain.Document{
        ID:        m.ID,
        Title:     m.Title,
        Content:   m.Content,
        Status:    domain.DocumentStatus(m.Status),
        OwnerID:   m.OwnerID,
        CreatedAt: m.CreatedAt,
        UpdatedAt: m.UpdatedAt,
    }
}
```

---

## 8. Delivery Layer (Chi HTTP Handlers)

```go
// internal/delivery/http/document_handler.go
package http

import (
    "encoding/json"
    "net/http"
    "github.com/go-chi/chi/v5"
    "github.com/bach/pdms/internal/domain"
    "github.com/bach/pdms/internal/usecase"
)

type DocumentHandler struct {
    uc *usecase.DocumentUseCase
}

func (h *DocumentHandler) Routes() chi.Router {
    r := chi.NewRouter()
    r.Get("/", h.List)
    r.Post("/", h.Create)
    r.Get("/{id}", h.Get)
    r.Put("/{id}/archive", h.Archive)
    return r
}

func (h *DocumentHandler) Get(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")
    userID := r.Context().Value("userID").(string)
    
    doc, err := h.uc.Get(r.Context(), id, userID)
    if err != nil {
        writeError(w, err) // Maps domain errors → HTTP status
        return
    }
    
    writeJSON(w, 200, toResponse(doc))
}

// Domain error → HTTP status mapping
func writeError(w http.ResponseWriter, err error) {
    switch {
    case errors.Is(err, domain.ErrDocumentNotFound):
        writeJSON(w, 404, map[string]string{"error": err.Error()})
    case errors.Is(err, domain.ErrUnauthorized):
        writeJSON(w, 403, map[string]string{"error": err.Error()})
    case errors.Is(err, domain.ErrDocumentArchived):
        writeJSON(w, 422, map[string]string{"error": err.Error()})
    default:
        writeJSON(w, 500, map[string]string{"error": "internal error"})
    }
}
```

---

## 9. Dependency Injection (main.go)

```go
func main() {
    // Infrastructure
    db, _ := newDB(cfg)
    kafkaProducer, _ := newKafkaProducer(cfg)
    
    // Repositories (Infrastructure implements Domain interfaces)
    docRepo := postgres.NewDocumentRepo(db)
    
    // Use cases (depend only on interfaces)
    docUC := usecase.NewDocumentUseCase(docRepo, kafkaProducer, pdfGen)
    
    // Handlers (depend on use cases)
    docHandler := http.NewDocumentHandler(docUC)
    
    // Router wiring
    r := chi.NewRouter()
    r.Use(middleware.RequestID, middleware.Logger, middleware.Recoverer)
    r.Use(JWTMiddleware(cfg.JWTSecret))
    
    r.Mount("/api/v1/documents", docHandler.Routes())
    
    http.ListenAndServe(":8080", r)
}
```

---

## 10. Tips & Tricks

```
💡 TIP 1: Domain entity ≠ DB model
   Tách domain.Document khỏi postgres.documentModel
   → Domain không phụ thuộc vào GORM tags

💡 TIP 2: Domain interfaces defined in Domain layer
   type DocumentRepository interface { ... } // in domain package
   → Use case không import infrastructure

💡 TIP 3: chi.URLParam vs r.PathValue (Go 1.22)
   chi.URLParam(r, "id") — works pre/post Go 1.22
   r.PathValue("id") — Go 1.22+ stdlib

💡 TIP 4: r.Mount() để compose routers
   r.Mount("/documents", docHandler.Routes())
   r.Mount("/users", userHandler.Routes())
   → Mỗi handler tự quản lý routes của mình

💡 TIP 5: Test use case không cần HTTP
   docUC := usecase.NewDocumentUseCase(mockRepo, mockBus, mockPDF)
   err := docUC.Archive(ctx, "doc-123", "user-1")
   → Pure unit test, không cần HTTP server
```

---

## 11. Tổng kết Bài 15

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ Chi = only router, 100% net/http compatible      │
│  ✅ Clean Architecture: 4 tầng rõ ràng              │
│  ✅ Domain không biết DB/HTTP/Kafka                  │
│  ✅ Repository interface nằm trong Domain layer      │
│  ✅ Mapper functions tách DB model ↔ Domain entity  │
│  ✅ DI wiring ở main.go — explicit, no magic        │
│  ✅ Use Case tests không cần HTTP server             │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-16-Framework-Comparison|Bài 16: Framework So Sánh & Decision Matrix]]

---
*Tags: #go #chi #clean-architecture #domain-driven #zero-to-hero*
