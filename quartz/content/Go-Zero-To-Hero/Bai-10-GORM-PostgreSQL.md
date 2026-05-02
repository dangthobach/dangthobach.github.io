# Bài 10: GORM & PostgreSQL Integration

> **Mục tiêu:** Làm chủ GORM — ORM phổ biến nhất trong Go ecosystem. So sánh với JPA/Hibernate, học patterns quan trọng cho production.

---

## 1. GORM vs JPA/Hibernate

```
┌──────────────────────────────────────────────────────────────┐
│                GORM vs JPA/Hibernate                         │
├──────────────────────────┬───────────────────────────────────┤
│  JPA/Hibernate           │  GORM                            │
├──────────────────────────┼───────────────────────────────────┤
│  @Entity annotation      │  struct với gorm: tags           │
│  @Column, @Id, @Table    │  gorm:"column:name;primaryKey"   │
│  EntityManager           │  *gorm.DB                        │
│  @Transactional          │  db.Transaction(func(tx))        │
│  CascadeType             │  gorm:"constraint:OnDelete:..."  │
│  Lazy/Eager loading      │  Preload() / Joins()             │
│  JPQL                    │  Raw SQL / Method chaining       │
│  @MappedSuperclass       │  Embedded struct                 │
│  Spring Data Repository  │  GORM Scopes + custom methods    │
└──────────────────────────┴───────────────────────────────────┘
```

---

## 2. Setup & Model Definition

```go
// go get gorm.io/gorm
// go get gorm.io/driver/postgres

import (
    "gorm.io/driver/postgres"
    "gorm.io/gorm"
    "gorm.io/gorm/logger"
)

// ── Connection ──
func NewDB(cfg Config) (*gorm.DB, error) {
    dsn := fmt.Sprintf(
        "host=%s user=%s password=%s dbname=%s port=%d sslmode=disable TimeZone=Asia/Ho_Chi_Minh",
        cfg.Host, cfg.User, cfg.Password, cfg.DBName, cfg.Port,
    )
    
    db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
        Logger: logger.Default.LogMode(logger.Info), // SQL logging
        NowFunc: time.Now,
        PrepareStmt: true, // Cache prepared statements
    })
    if err != nil {
        return nil, fmt.Errorf("connect db: %w", err)
    }
    
    // Connection Pool (giống HikariCP)
    sqlDB, _ := db.DB()
    sqlDB.SetMaxOpenConns(25)
    sqlDB.SetMaxIdleConns(10)
    sqlDB.SetConnMaxLifetime(5 * time.Minute)
    
    return db, nil
}
```

---

## 3. Model Definition

```go
// Base model (như @MappedSuperclass trong JPA)
type BaseModel struct {
    ID        string         `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
    CreatedAt time.Time      `gorm:"autoCreateTime"`
    UpdatedAt time.Time      `gorm:"autoUpdateTime"`
    DeletedAt gorm.DeletedAt `gorm:"index"` // Soft delete support
}

// Domain model
type Document struct {
    BaseModel
    Title     string    `gorm:"not null;size:255"`
    Content   string    `gorm:"type:text"`
    Status    string    `gorm:"not null;default:'draft';check:status IN ('draft','active','archived')"`
    OwnerID   string    `gorm:"type:uuid;not null;index"`
    Owner     User      `gorm:"foreignKey:OwnerID"`          // Belongs-to
    Tags      []Tag     `gorm:"many2many:document_tags;"`    // Many-to-many
    Metadata  JSONB     `gorm:"type:jsonb"`                  // PostgreSQL JSONB
}

type User struct {
    BaseModel
    Name      string     `gorm:"not null;size:100"`
    Email     string     `gorm:"uniqueIndex;not null"`
    Documents []Document `gorm:"foreignKey:OwnerID"` // Has-many
}

// Auto-migrate (development/test only)
db.AutoMigrate(&User{}, &Document{}, &Tag{})
```

---

## 4. CRUD Operations

```go
type DocumentRepo struct {
    db *gorm.DB
}

// ── CREATE ──
func (r *DocumentRepo) Create(ctx context.Context, doc *Document) error {
    result := r.db.WithContext(ctx).Create(doc)
    return result.Error // doc.ID populated after create
}

// Batch insert
func (r *DocumentRepo) BulkCreate(ctx context.Context, docs []*Document) error {
    return r.db.WithContext(ctx).
        CreateInBatches(docs, 100). // 100 per batch
        Error
}

// ── READ ──
func (r *DocumentRepo) FindByID(ctx context.Context, id string) (*Document, error) {
    var doc Document
    result := r.db.WithContext(ctx).
        Preload("Owner").           // Eager load owner (1 extra query)
        Preload("Tags").            // Eager load tags
        First(&doc, "id = ?", id)  // First adds LIMIT 1
    
    if result.Error != nil {
        if errors.Is(result.Error, gorm.ErrRecordNotFound) {
            return nil, ErrNotFound
        }
        return nil, result.Error
    }
    return &doc, nil
}

func (r *DocumentRepo) FindWithFilter(ctx context.Context, filter Filter) ([]*Document, int64, error) {
    var docs []*Document
    var total int64
    
    query := r.db.WithContext(ctx).Model(&Document{})
    
    // Dynamic filters
    if filter.OwnerID != "" {
        query = query.Where("owner_id = ?", filter.OwnerID)
    }
    if filter.Status != "" {
        query = query.Where("status = ?", filter.Status)
    }
    if filter.Search != "" {
        query = query.Where("title ILIKE ?", "%"+filter.Search+"%")
    }
    
    // Count total (for pagination)
    query.Count(&total)
    
    // Paginate
    result := query.
        Offset((filter.Page - 1) * filter.Limit).
        Limit(filter.Limit).
        Order("created_at DESC").
        Find(&docs)
    
    return docs, total, result.Error
}

// ── UPDATE ──
func (r *DocumentRepo) Update(ctx context.Context, doc *Document) error {
    // Updates only non-zero fields (use Map for zero-value updates)
    result := r.db.WithContext(ctx).
        Model(doc).
        Updates(map[string]any{
            "title":      doc.Title,
            "content":    doc.Content,
            "status":     doc.Status,
            "updated_at": time.Now(),
        })
    return result.Error
}

// ── DELETE (Soft delete nếu có DeletedAt field) ──
func (r *DocumentRepo) Delete(ctx context.Context, id string) error {
    result := r.db.WithContext(ctx).Delete(&Document{}, "id = ?", id)
    return result.Error
}

// Hard delete
func (r *DocumentRepo) HardDelete(ctx context.Context, id string) error {
    result := r.db.WithContext(ctx).Unscoped().Delete(&Document{}, "id = ?", id)
    return result.Error
}
```

---

## 5. Transactions

```go
// Transaction với auto rollback
func (s *DocumentService) TransferOwnership(ctx context.Context, docID, newOwnerID string) error {
    return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
        // Tất cả operations trong tx sẽ rollback nếu return error
        
        var doc Document
        if err := tx.First(&doc, "id = ?", docID).Error; err != nil {
            return err
        }
        
        oldOwnerID := doc.OwnerID
        doc.OwnerID = newOwnerID
        
        if err := tx.Save(&doc).Error; err != nil {
            return err // → auto rollback
        }
        
        // Audit log
        audit := AuditLog{
            Action:    "OWNERSHIP_TRANSFER",
            TargetID:  docID,
            OldValue:  oldOwnerID,
            NewValue:  newOwnerID,
        }
        if err := tx.Create(&audit).Error; err != nil {
            return err // → auto rollback
        }
        
        return nil // → commit
    })
}
```

---

## 6. Scopes — Reusable Query Builders

```go
// Define reusable scopes
func ActiveDocuments(db *gorm.DB) *gorm.DB {
    return db.Where("status = ? AND deleted_at IS NULL", "active")
}

func OwnedBy(userID string) func(*gorm.DB) *gorm.DB {
    return func(db *gorm.DB) *gorm.DB {
        return db.Where("owner_id = ?", userID)
    }
}

func PaginatedBy(page, limit int) func(*gorm.DB) *gorm.DB {
    return func(db *gorm.DB) *gorm.DB {
        return db.Offset((page - 1) * limit).Limit(limit)
    }
}

// Usage — compose scopes
var docs []Document
db.Scopes(ActiveDocuments, OwnedBy("user-123"), PaginatedBy(1, 20)).Find(&docs)
```

---

## 7. Raw SQL & Performance

```go
// Raw SQL khi GORM không đủ expressive
var result []struct {
    OwnerID   string
    DocCount  int
    TotalSize int64
}

db.Raw(`
    SELECT owner_id, COUNT(*) as doc_count, SUM(LENGTH(content)) as total_size
    FROM documents
    WHERE status = ? AND deleted_at IS NULL
    GROUP BY owner_id
    HAVING COUNT(*) > ?
    ORDER BY doc_count DESC
`, "active", 10).Scan(&result)

// Exec cho INSERT/UPDATE/DELETE
db.Exec("UPDATE documents SET status = ? WHERE owner_id = ?", "archived", userID)

// Named args (readable)
db.Raw("SELECT * FROM documents WHERE owner_id = @ownerID AND status = @status",
    sql.Named("ownerID", ownerID),
    sql.Named("status", "active"),
).Scan(&docs)
```

---

## 8. Tips & Tricks

```
💡 TIP 1: Luôn dùng WithContext(ctx)
   db.WithContext(ctx).Find(...) → respects cancellation + deadline

💡 TIP 2: db.Model(&T{}) vs db.Model(&instance)
   db.Model(&Document{}).Where(...) → không load existing record
   db.Model(&existingDoc).Updates(...) → update specific instance

💡 TIP 3: Updates() vs Save()
   Updates() → chỉ update non-zero fields
   Save() → update TẤT CẢ fields (có thể xóa data!)

💡 TIP 4: Preload vs Joins
   Preload → N+1 queries (đơn giản, ít data)
   Joins → 1 JOIN query (tốt hơn khi data nhiều)

💡 TIP 5: Debug slow queries
   db.Debug().Find(&docs) // Print SQL to stdout
   GORM logger với threshold: logger.New(..., SlowThreshold: 200ms)
```

---

## 9. Tổng kết Bài 10

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ SetMaxOpenConns/IdleConns như HikariCP pool      │
│  ✅ BaseModel struct cho audit fields chung          │
│  ✅ Soft delete tự động với gorm.DeletedAt           │
│  ✅ Transaction callback auto-rollback on error      │
│  ✅ Scopes để reuse query builders                  │
│  ✅ Updates() an toàn hơn Save() (no zero overwrite)│
│  ✅ Raw SQL khi business logic phức tạp             │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-11-Gin-Core|Bài 11: Gin Framework Core]]

---
*Tags: #go #gorm #postgresql #orm #database #zero-to-hero*
