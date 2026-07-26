---
type: tutorial
domain: languages/go/microservices
status: active
created: 2026-07-27
updated: 2026-07-27
tags: [go, setup, repository, docker]
---

# Bài 04 — Chuẩn bị môi trường và repository

> [!success] Deliverable
> Repository `gocommerce` build/test được, có convention rõ ràng và local infrastructure khởi động độc lập với ứng dụng.

## 1. Phiên bản baseline

Series dùng:

- Go **1.26.x**; cập nhật bản vá mới nhất trong CI/image;
- Git;
- Docker Engine/Desktop có Compose;
- editor có `gopls`;
- PostgreSQL, Kafka, RabbitMQ, Redis chạy bằng container ở các phase tương ứng.

Kiểm tra:

```bash
go version
go env GOMODCACHE GOPATH
docker version
docker compose version
git --version
```

> [!note]
> Tại ngày 27/07/2026, Go 1.26.5 là bản vá mới nhất được liệt kê trên trang release chính thức. Không hard-code bản vá này mãi mãi; CI phải nhận cập nhật security.

## 2. Khởi tạo project

```bash
mkdir gocommerce
cd gocommerce
git init
go mod init github.com/<your-org>/gocommerce
mkdir -p cmd/api internal/catalog internal/platform docs/adr
```

Trên PowerShell:

```powershell
New-Item -ItemType Directory -Force cmd/api, internal/catalog, internal/platform, docs/adr
```

Không dùng tên module giả trong dự án thật. Module path là import identity và nên khớp repository dự kiến.

## 3. Entry point tối thiểu

Tạo `cmd/api/main.go`:

```go
package main

import (
    "fmt"
    "runtime/debug"
)

func main() {
    version := "dev"
    if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" {
        version = info.Main.Version
    }
    fmt.Printf("gocommerce-api version=%s\n", version)
}
```

Chạy:

```bash
go run ./cmd/api
go test ./...
go vet ./...
```

## 4. File convention

`.gitignore`:

```gitignore
.env
.idea/
.vscode/
bin/
coverage.out
*.prof
tmp/
```

`.env.example` chỉ chứa tên biến và giá trị local không bí mật:

```dotenv
APP_ENV=local
HTTP_ADDR=:8080
DATABASE_URL=postgres://gocommerce:gocommerce@localhost:5432/catalog?sslmode=disable
```

> [!danger]
> `.env.example` được commit; `.env` không được commit. Production secret phải đi qua secret manager/platform, không nhúng vào image.

## 5. Lệnh phát triển thống nhất

`Makefile` gợi ý:

```makefile
.PHONY: fmt test race vet run check

fmt:
	go fmt ./...

test:
	go test ./...

race:
	go test -race ./...

vet:
	go vet ./...

run:
	go run ./cmd/api

check: fmt vet test
```

Nếu team Windows không dùng `make`, tạo script PowerShell tương đương hoặc dùng task runner đã được team chuẩn hóa. Điều quan trọng là CI và local chạy cùng semantics.

## 6. Local infrastructure theo profile

Không bật Kafka/RabbitMQ/SFTP từ ngày đầu. Chia Compose theo capability:

```text
deployments/local/
├─ compose.yaml          # postgres + redis
├─ compose.kafka.yaml
├─ compose.rabbitmq.yaml
└─ compose.sftp.yaml
```

Lý do: feedback loop nhanh, máy học không phải luôn gánh toàn bộ stack, failure dễ khoanh vùng.

## 7. Kiểm tra reproducibility

Một người mới phải có thể:

```bash
git clone <repo>
cd gocommerce
go mod download
go test ./...
go run ./cmd/api
```

Không được cần file hoặc biến “chỉ có trên máy tác giả”.

## Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách xử lý |
|---|---|---|
| import có `/internal/` bị từ chối | gọi từ ngoài parent tree | giữ consumer trong module/repo đúng boundary |
| tool dùng Go version khác | PATH/editor chưa đồng nhất | kiểm tra `go version` trong terminal và editor |
| build chỉ chạy trên máy tác giả | phụ thuộc env/CGO ẩn | build trong clean container/CI |
| commit secret | copy `.env` | ignore + secret scanning + rotate ngay nếu lộ |

## Definition of Done

- [ ] `go test ./...` và `go vet ./...` thành công.
- [ ] Module path đúng với repository dự kiến.
- [ ] `.env` bị ignore; `.env.example` không có secret.
- [ ] README ghi prerequisites và quick start.
- [ ] Một clean clone chạy được không cần kiến thức ẩn.

---

**Trước:** [[03-Kien-truc-GoCommerce]] · **Tiếp theo:** [[05-Product-Service-Vertical-Slice]]
