# Bài 5: Packages, Modules & Go Tooling

> **Mục tiêu:** Hiểu hệ thống module của Go, cách tổ chức packages, và làm chủ bộ công cụ CLI của Go.

---

## 1. Module System — go.mod là trái tim

```
┌──────────────────────────────────────────────────────────────┐
│                   GO MODULE SYSTEM                           │
│                                                              │
│  Before Go Modules (GOPATH era):                             │
│  ~/go/src/github.com/user/project/ ← tất cả code ở đây     │
│  → Khó quản lý, không version isolation                      │
│                                                              │
│  Go Modules (Go 1.11+, default Go 1.16+):                   │
│  Any directory → go mod init → tự quản lý dependencies      │
│                                                              │
│  go.mod (lock file + version spec):                          │
│  ┌─────────────────────────────────────────┐                │
│  │ module github.com/bach/pdms             │                │
│  │                                         │                │
│  │ go 1.22                                 │                │
│  │                                         │                │
│  │ require (                               │                │
│  │   github.com/gin-gonic/gin v1.10.0      │                │
│  │   gorm.io/gorm v1.25.7                  │                │
│  │   go.uber.org/zap v1.27.0               │                │
│  │ )                                       │                │
│  └─────────────────────────────────────────┘                │
│                                                              │
│  go.sum (cryptographic hashes — như npm package-lock):       │
│  github.com/gin-gonic/gin v1.10.0 h1:...                    │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Package Structure

```go
// Package = directory = đơn vị compilation
// Package name phải match directory name (convention)

// File: internal/domain/user.go
package domain          // package name

type User struct {
    ID    string
    Email string
}

// File: internal/domain/user_test.go
package domain_test    // hoặc "domain" — test package

// File: cmd/server/main.go
package main           // entry point — phải là "main"

func main() { ... }
```

### Visibility Rules
```
┌──────────────────────────────────────────────────────────────┐
│                VISIBILITY IN GO                              │
│                                                              │
│  Uppercase = Exported (Public)                               │
│  type User struct { ... }     → visible outside package     │
│  func NewUser(...) *User { }  → visible outside package     │
│  var DefaultTimeout = 30s     → visible outside package     │
│                                                              │
│  Lowercase = Unexported (Private to package)                 │
│  type userCache struct { ... } → only within package        │
│  func validateEmail(s string) → only within package         │
│  var maxRetries = 3           → only within package         │
│                                                              │
│  NOTE: NO class-level private — package-level only!         │
│  (Không có "private field accessible within same class"      │
│   như Java — một file khác trong cùng package THẤY hết)     │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Standard Project Layout

```
pdms-service/
├── cmd/
│   └── server/
│       └── main.go              # Entry point — chỉ khởi động
├── internal/                    # Không thể import từ ngoài module
│   ├── domain/                  # Entities, Value Objects
│   │   ├── document.go
│   │   └── user.go
│   ├── usecase/                 # Business logic
│   │   ├── document_service.go
│   │   └── document_service_test.go
│   ├── repository/              # Data access interfaces + impls
│   │   ├── document_repo.go     # Interface
│   │   └── postgres/
│   │       └── document_repo.go # Implementation
│   └── delivery/
│       └── http/
│           ├── handler.go
│           └── middleware.go
├── pkg/                         # Có thể import từ ngoài module
│   ├── logger/
│   └── config/
├── migrations/
├── docker/
│   └── Dockerfile
├── go.mod
├── go.sum
└── Makefile
```

---

## 4. Go CLI Commands — Bộ công cụ đầy đủ

```bash
# ── PROJECT INIT ──
go mod init github.com/bach/project   # Tạo module
go mod tidy                           # Remove unused, add missing deps
go mod download                       # Download all deps to cache

# ── BUILD & RUN ──
go run ./cmd/server/                  # Chạy không compile file
go build -o bin/server ./cmd/server/  # Compile thành binary
go build ./...                        # Build tất cả packages

# ── TESTING ──
go test ./...                         # Run all tests
go test -v ./...                      # Verbose output
go test -run TestName ./...           # Run specific test
go test -race ./...                   # Detect race conditions
go test -cover ./...                  # Coverage report
go test -bench=. ./...                # Run benchmarks
go test -benchmem ./...               # Benchmark + memory allocs

# ── DEPENDENCY MANAGEMENT ──
go get github.com/gin-gonic/gin       # Add dependency
go get github.com/gin-gonic/gin@v1.9  # Specific version
go get -u ./...                       # Update all deps
go list -m all                        # List all modules

# ── CODE QUALITY ──
go fmt ./...                          # Format code (gofmt)
go vet ./...                          # Static analysis
go doc fmt.Println                    # View docs

# ── PROFILING ──
go tool pprof                         # CPU/memory profiler
go tool trace                         # Execution tracer

# ── GENERATE ──
go generate ./...                     # Run //go:generate directives
```

---

## 5. golangci-lint — Linter tổng hợp

```yaml
# .golangci.yml
linters:
  enable:
    - errcheck      # Check unhandled errors
    - gosimple      # Simplification suggestions
    - govet         # Suspicious code constructs
    - ineffassign   # Detect ineffectual assignments
    - staticcheck   # Comprehensive static analysis
    - unused        # Check unused code
    - gofumpt       # Strict formatting (superset of gofmt)
    - goimports     # Auto-manage imports
    - revive        # Replacement for golint
    - gosec         # Security checks

linters-settings:
  errcheck:
    check-type-assertions: true
  govet:
    enable-all: true

run:
  timeout: 5m
```

```bash
# Cài đặt
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest

# Chạy
golangci-lint run ./...
golangci-lint run --fix ./...  # Auto-fix where possible
```

---

## 6. Makefile — Automation

```makefile
# Makefile
.PHONY: build run test lint clean migrate

BUILD_DIR := bin
BINARY := $(BUILD_DIR)/server

build:
	@mkdir -p $(BUILD_DIR)
	go build -ldflags="-s -w" -o $(BINARY) ./cmd/server/

run:
	go run ./cmd/server/

test:
	go test -race -cover ./...

lint:
	golangci-lint run ./...

fmt:
	gofumpt -l -w .
	goimports -l -w .

clean:
	rm -rf $(BUILD_DIR)

migrate-up:
	migrate -path migrations/ -database "$(DATABASE_URL)" up

tidy:
	go mod tidy
	go mod verify

.DEFAULT_GOAL := build
```

---

## 7. Build Tags — Conditional Compilation

```go
//go:build linux && amd64
// +build linux,amd64   (Go < 1.17 syntax)

package main

// File này chỉ compile trên Linux AMD64

// Dùng cho:
// - Platform-specific code
// - Integration tests (chỉ chạy khi có flag)
// - Debug builds
```

```go
// file: integration_test.go
//go:build integration

package usecase_test

// Chạy với: go test -tags=integration ./...
```

---

## 8. Workspace Mode — Multi-module Development

```bash
# Khi develop nhiều module cùng lúc (ví dụ: pdms-core + pdms-iam)
go work init ./pdms-core ./pdms-iam

# go.work file:
# go 1.22
# use (
#   ./pdms-core
#   ./pdms-iam
# )
# → Module này refer nhau qua local path thay vì published version
```

---

## 9. Tips & Tricks

```
💡 TIP 1: internal/ là hard boundary
   Code trong internal/ không thể bị import bởi external modules
   → Dùng cho implementation details bạn muốn giữ private

💡 TIP 2: go mod tidy sau mỗi change dependencies
   Giữ go.mod và go.sum sạch sẽ, không có orphaned deps

💡 TIP 3: Đặt //go:generate ở file để track code generation
   //go:generate mockgen -source=repo.go -destination=mock/repo.go
   → Chạy go generate ./... để regenerate

💡 TIP 4: GOFLAGS environment variable
   export GOFLAGS="-mod=vendor"  # Dùng vendor directory
   export GONOSUMCHECK="*"       # Skip checksum (internal repos)

💡 TIP 5: go build -race binary (production debug)
   Có thể ship race-enabled binary để debug production issues
   (tốn ~2x CPU, dùng cẩn thận)
```

---

## 10. Tổng kết Bài 5

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ go.mod = Maven pom.xml, Gradle build.gradle     │
│  ✅ Uppercase = exported, lowercase = package-only  │
│  ✅ internal/ = private to module (hard boundary)   │
│  ✅ go test -race là bắt buộc trong CI/CD           │
│  ✅ golangci-lint thay thế nhiều linters riêng lẻ  │
│  ✅ Makefile chuẩn hóa workflow cho team            │
│  ✅ go work cho multi-module local development      │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-6-Interfaces-Generics|Bài 6: Interfaces Deep Dive & Generics]]

---
*Tags: #go #modules #packages #tooling #go-mod #zero-to-hero*
