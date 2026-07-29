---
type: tutorial
domain: languages/go/microservices
status: active
created: 2026-07-27
updated: 2026-07-29
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
mkdir -p cmd/api internal/catalog internal/platform docs/adr tools/dodcheck
```

Trên PowerShell:

```powershell
New-Item -ItemType Directory -Force cmd/api, internal/catalog, internal/platform, docs/adr, tools/dodcheck
```

Không dùng tên module giả trong dự án thật. Module path là import identity và nên khớp repository dự kiến.

> [!tip] Nối tiếp bài 01 và 03
> Copy `tools/dodcheck/main.go` (bài 01) và `internal/order/status.go` + test (bài 03) vào đúng vị trí này. Từ đây repo là **một** codebase phát triển liên tục — không phải project mới cho mỗi bài.

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
.PHONY: fmt test race vet run check dod

fmt:
	go fmt ./...

test:
	go test ./...

race:
	go test -race ./...

vet:
	go vet ./...

check: fmt vet test

dod:
	go run ./tools/dodcheck
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

## 🔬 Đào sâu kỹ thuật — build đóng gói được, xác minh được, không chỉ "chạy trên máy tôi"

`go run` tiện cho dev loop nhưng che mất những gì thật sự đi vào binary production. Ba lệnh dưới đây nên là một phần thường trực của repo, không phải kiến thức chỉ dùng khi có sự cố.

### Build tái lập được (reproducible build)

```bash
go build -trimpath -ldflags="-s -w -X main.version=v0.4.0" -o bin/api ./cmd/api
```

- `-trimpath`: xóa đường dẫn tuyệt đối của máy build khỏi binary — hai máy build cùng commit phải cho binary giống nhau về mặt nội dung mã nguồn, không lộ `/home/<user>/...`.
- `-ldflags="-s -w"`: bỏ symbol table và DWARF debug info khi build release, giảm kích thước artifact.
- `-X main.version=...`: inject version lúc build thay vì hard-code, khớp với `runtime/debug.ReadBuildInfo()` đã dùng ở mục 3.

### Xác minh module graph, không tin ngầm

```bash
go mod verify        # checksum module trong cache khớp go.sum
go list -m all        # toàn bộ dependency graph đã resolve
go mod why <module>   # vì sao module này có mặt — hữu ích khi audit transitive dependency
```

`go mod verify` nên là một bước trong CI trước khi build image; một cache bị corrupt hoặc bị can thiệp sẽ bị chặn ở đây thay vì lan vào production artifact.

### Soi chính binary đã build ra

```bash
go version -m bin/api
```

Lệnh này in lại toàn bộ module + version đã được **link vào chính binary đó** — khác với `go.mod` chỉ là ý định. Khi debug "tại sao production chạy code cũ", đây là bằng chứng đầu tiên cần xem trước khi nghi ngờ downstream.

### Nối vào quy ước tag của series

```bash
go run ./tools/dodcheck && \
  go build -trimpath -ldflags="-X main.version=v0.4.0" -o bin/api ./cmd/api && \
  git add -A && git commit -m "Bài 04: repo skeleton + reproducible build" && \
  git tag v0.4.0
```

Từ bài 13 (Docker image), `-trimpath` và `-ldflags` ở trên sẽ được đưa thẳng vào multi-stage Dockerfile — không phải khái niệm mới, chỉ là di chuyển đúng lệnh đã quen vào build stage.

## Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách xử lý |
|---|---|---|
| import có `/internal/` bị từ chối | gọi từ ngoài parent tree | giữ consumer trong module/repo đúng boundary |
| tool dùng Go version khác | PATH/editor chưa đồng nhất | kiểm tra `go version` trong terminal và editor |
| build chỉ chạy trên máy tác giả | phụ thuộc env/CGO ẩn | build trong clean container/CI |
| commit secret | copy `.env` | ignore + secret scanning + rotate ngay nếu lộ |
| binary hai máy build khác nhau dù cùng commit | thiếu `-trimpath`, GOPATH khác nhau | build trong container chuẩn hóa, luôn dùng `-trimpath` |

## Definition of Done

- [ ] `go test ./...` và `go vet ./...` thành công.
- [ ] Module path đúng với repository dự kiến.
- [ ] `.env` bị ignore; `.env.example` không có secret.
- [ ] README ghi prerequisites và quick start.
- [ ] Một clean clone chạy được không cần kiến thức ẩn.
- [ ] `go build -trimpath` chạy thành công và `go version -m bin/api` phản ánh đúng version.
- [ ] `go run ./tools/dodcheck` pass và đã `git tag v0.4.0`.

---

**Trước:** [[03-Kien-truc-GoCommerce]] · **Tiếp theo:** [[05-Product-Service-Vertical-Slice]]
