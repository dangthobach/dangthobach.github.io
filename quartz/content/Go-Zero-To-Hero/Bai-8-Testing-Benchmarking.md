# Bài 8: Testing, Table-driven Tests & Benchmarking

> **Mục tiêu:** Viết tests chất lượng production — table-driven tests, mocking interfaces, race detection, benchmark và profiling.

---

## 1. Testing Philosophy của Go

```
┌──────────────────────────────────────────────────────────────┐
│              GO TESTING vs JAVA TESTING                      │
├───────────────────────────┬──────────────────────────────────┤
│  Java (JUnit 5)           │  Go (testing package)            │
├───────────────────────────┼──────────────────────────────────┤
│  @Test annotation         │  func TestXxx(t *testing.T)     │
│  @BeforeEach             │  TestMain / setup inline         │
│  @ParameterizedTest      │  Table-driven tests              │
│  Mockito.mock()          │  gomock / testify mock           │
│  assert.assertEquals    │  t.Errorf / testify assert       │
│  Maven test lifecycle    │  go test ./...                   │
│  Separate test config    │  _test.go files                  │
└───────────────────────────┴──────────────────────────────────┘
```

---

## 2. Basic Testing

```go
// File: internal/usecase/document_service_test.go
package usecase_test // "_test" suffix = black-box testing

import (
    "context"
    "testing"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestDocumentService_Create(t *testing.T) {
    // Arrange
    repo := &mockDocumentRepo{}
    svc := NewDocumentService(repo)
    ctx := context.Background()
    
    doc := &Document{Title: "Test Doc", OwnerID: "user-1"}

    // Act
    err := svc.Create(ctx, doc)

    // Assert
    require.NoError(t, err)          // require.X → stop test on fail
    assert.NotEmpty(t, doc.ID)       // assert.X → continue test on fail
    assert.Equal(t, "user-1", doc.OwnerID)
}

// t.Run — subtests (like @Nested in JUnit)
func TestDocumentService_Validate(t *testing.T) {
    t.Run("empty title should fail", func(t *testing.T) {
        doc := &Document{Title: ""}
        err := validateDocument(doc)
        assert.ErrorIs(t, err, ErrValidation)
    })

    t.Run("valid document should pass", func(t *testing.T) {
        doc := &Document{Title: "Valid Title"}
        err := validateDocument(doc)
        assert.NoError(t, err)
    })
}
```

---

## 3. Table-Driven Tests — Go's Superpower

```go
func TestDivide(t *testing.T) {
    // Table of test cases
    tests := []struct {
        name      string
        a, b      float64
        want      float64
        wantErr   bool
    }{
        {name: "normal division",      a: 10, b: 2,   want: 5,   wantErr: false},
        {name: "division by zero",     a: 10, b: 0,   want: 0,   wantErr: true},
        {name: "float division",       a: 7,  b: 2,   want: 3.5, wantErr: false},
        {name: "negative numerator",   a: -6, b: 2,   want: -3,  wantErr: false},
        {name: "both negative",        a: -6, b: -2,  want: 3,   wantErr: false},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got, err := divide(tt.a, tt.b)

            if tt.wantErr {
                assert.Error(t, err)
                return
            }

            require.NoError(t, err)
            assert.InDelta(t, tt.want, got, 0.001)
        })
    }
}
```

```
💡 WHY TABLE-DRIVEN?
   ✅ Thêm test case = thêm 1 dòng struct
   ✅ Code DRY — logic test viết 1 lần
   ✅ Parallel-friendly với t.Parallel()
   ✅ Output rõ ràng khi fail: "--- FAIL: TestDivide/division_by_zero"
```

---

## 4. Mocking Interfaces

```go
// Interface cần mock
type DocumentRepository interface {
    FindByID(ctx context.Context, id string) (*Document, error)
    Create(ctx context.Context, doc *Document) error
}

// Option 1: Manual mock (đơn giản nhất)
type mockDocRepo struct {
    docs   map[string]*Document
    findErr error
}

func (m *mockDocRepo) FindByID(ctx context.Context, id string) (*Document, error) {
    if m.findErr != nil {
        return nil, m.findErr
    }
    doc, ok := m.docs[id]
    if !ok {
        return nil, ErrNotFound
    }
    return doc, nil
}

func (m *mockDocRepo) Create(ctx context.Context, doc *Document) error {
    doc.ID = uuid.New().String()
    m.docs[doc.ID] = doc
    return nil
}

// Option 2: testify/mock (feature-rich)
type MockDocRepo struct {
    mock.Mock
}

func (m *MockDocRepo) FindByID(ctx context.Context, id string) (*Document, error) {
    args := m.Called(ctx, id)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).(*Document), args.Error(1)
}

// Trong test:
func TestService_GetDocument(t *testing.T) {
    mockRepo := new(MockDocRepo)
    
    // Setup expectations
    mockRepo.On("FindByID", mock.Anything, "doc-123").
        Return(&Document{ID: "doc-123", Title: "Test"}, nil)
    
    svc := NewDocumentService(mockRepo)
    doc, err := svc.GetDocument(context.Background(), "doc-123")
    
    assert.NoError(t, err)
    assert.Equal(t, "doc-123", doc.ID)
    mockRepo.AssertExpectations(t) // Verify all mocked calls were made
}
```

---

## 5. gomock — Code Generation cho Mocks

```bash
# Install
go install go.uber.org/mock/mockgen@latest

# Generate mock
mockgen -source=internal/repository/document_repo.go \
        -destination=internal/repository/mock/document_repo.go \
        -package=mock
```

```go
//go:generate mockgen -source=document_repo.go -destination=mock/document_repo.go

// Generated mock sử dụng
func TestService_WithGomock(t *testing.T) {
    ctrl := gomock.NewController(t)
    defer ctrl.Finish()

    mockRepo := mock.NewMockDocumentRepository(ctrl)
    
    mockRepo.EXPECT().
        FindByID(gomock.Any(), "doc-123").
        Return(&Document{ID: "doc-123"}, nil).
        Times(1)

    svc := NewDocumentService(mockRepo)
    doc, err := svc.GetDocument(context.Background(), "doc-123")
    
    require.NoError(t, err)
    assert.Equal(t, "doc-123", doc.ID)
}
```

---

## 6. Benchmarking

```go
// File: internal/usecase/document_service_bench_test.go
func BenchmarkDocumentService_Create(b *testing.B) {
    svc := setupBenchService()
    ctx := context.Background()
    
    b.ResetTimer() // Không tính setup time
    
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            doc := &Document{Title: "Bench Doc", OwnerID: "user-1"}
            _ = svc.Create(ctx, doc)
        }
    })
}

// Benchmark với table
func BenchmarkJSON(b *testing.B) {
    type Encoder interface{ Encode(any) []byte }
    
    encoders := []struct {
        name    string
        encoder Encoder
    }{
        {"stdlib json",    stdlibEncoder{}},
        {"sonic json",     sonicEncoder{}},
        {"jsoniter",       jsoniterEncoder{}},
    }
    
    for _, e := range encoders {
        b.Run(e.name, func(b *testing.B) {
            for i := 0; i < b.N; i++ {
                _ = e.encoder.Encode(testDocument)
            }
        })
    }
}
```

```bash
# Run benchmarks
go test -bench=. -benchmem ./...

# Output:
# BenchmarkDocumentService_Create-8    125432    9543 ns/op    2048 B/op    15 allocs/op
#                                      ^iters    ^time/op      ^bytes       ^allocations

# Compare benchmarks
go test -bench=. > old.txt
# make changes
go test -bench=. > new.txt
benchstat old.txt new.txt
```

---

## 7. Race Condition Detection

```go
// Code có race condition
var counter int

func TestRaceCondition(t *testing.T) {
    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            counter++ // ⚠ DATA RACE!
        }()
    }
    wg.Wait()
}
```

```bash
go test -race ./...
# OUTPUT:
# WARNING: DATA RACE
# Write at 0x00c000018230 by goroutine 8:
#   main.TestRaceCondition.func1()
#       .../service_test.go:12 +0x3c
# Previous write at 0x00c000018230 by goroutine 7:
#   main.TestRaceCondition.func1()
#       .../service_test.go:12 +0x3c
```

---

## 8. Integration Tests

```go
//go:build integration

package repository_test

func TestDocumentRepo_Integration(t *testing.T) {
    // Dùng testcontainers-go để spin up PostgreSQL
    ctx := context.Background()
    
    container, err := postgres.RunContainer(ctx,
        testcontainers.WithImage("postgres:16"),
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("test"),
        postgres.WithPassword("test"),
    )
    require.NoError(t, err)
    defer container.Terminate(ctx)
    
    connStr, _ := container.ConnectionString(ctx, "sslmode=disable")
    
    db, err := gorm.Open(postgres.Open(connStr))
    require.NoError(t, err)
    db.AutoMigrate(&Document{})
    
    repo := NewDocumentRepo(db)
    
    // Test với real database
    doc := &Document{Title: "Integration Test"}
    err = repo.Create(ctx, doc)
    require.NoError(t, err)
    assert.NotEmpty(t, doc.ID)
}
```

---

## 9. Tips & Tricks

```
💡 TIP 1: Parallel tests tăng tốc
   func TestXxx(t *testing.T) {
       t.Parallel() // Run this test in parallel with others
   }

💡 TIP 2: TestMain cho global setup/teardown
   func TestMain(m *testing.M) {
       setup()
       code := m.Run()
       teardown()
       os.Exit(code)
   }

💡 TIP 3: t.Helper() trong helper functions
   func assertValidDoc(t *testing.T, doc *Document) {
       t.Helper() // Stack trace points to caller, not this function
       assert.NotEmpty(t, doc.ID)
   }

💡 TIP 4: -count=N để run tests nhiều lần (flaky test detection)
   go test -count=10 -race ./...

💡 TIP 5: Coverage với HTML report
   go test -coverprofile=coverage.out ./...
   go tool cover -html=coverage.out
```

---

## 10. Tổng kết Bài 8

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ Table-driven tests = Go's best practice         │
│  ✅ t.Run() cho subtests, t.Parallel() cho speed    │
│  ✅ Manual mock cho simple, gomock cho complex      │
│  ✅ -race flag bắt buộc trong CI/CD                 │
│  ✅ -benchmem để xem allocations (performance)      │
│  ✅ testcontainers cho integration tests            │
│  ✅ require.X dừng test, assert.X tiếp tục         │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-9-Net-Http-Deep|Bài 9: net/http Deep Dive]]

---
*Tags: #go #testing #benchmark #mock #table-driven #zero-to-hero*
