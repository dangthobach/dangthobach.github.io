---
type: course
domain: languages/go/microservices
status: active
created: 2026-07-27
updated: 2026-07-29
tags: [learning-path, hands-on, definition-of-done]
---

# Bài 01 — Học series thế nào để vào dự án nhanh?

> [!success] Sau bài này
> Bạn có một cách học đo được bằng sản phẩm chạy được, thay vì “đọc xong thấy hiểu”.

## Vòng lặp của mỗi article

```mermaid
flowchart LR
    A["Đọc use case"] --> B["Vẽ boundary"]
    B --> C["Code happy path"]
    C --> D["Thêm failure path"]
    D --> E["Test + quan sát"]
    E --> F["Viết ADR ngắn"]
    F --> G["Demo từ đầu"]
```

### 1. Đọc use case

Trả lời ba câu trước khi code:

- Ai gọi capability này?
- Thành công làm thay đổi business state nào?
- Nếu dependency chết giữa chừng, hệ thống cần đảm bảo điều gì?

### 2. Vẽ boundary

Không bắt đầu bằng package hay broker. Bắt đầu bằng **business capability**, dữ liệu nó sở hữu và contract nó công bố.

### 3. Code happy path

Tạo lát cắt nhỏ nhất đi xuyên qua transport → application → domain → repository. Chưa tối ưu và chưa tạo interface ở mọi nơi.

### 4. Thêm failure path

Ít nhất phải xử lý:

- input sai;
- resource không tồn tại hoặc conflict;
- dependency timeout;
- shutdown khi request/message đang xử lý;
- message bị giao lại.

### 5. Test và quan sát

Một tính năng chưa hoàn tất nếu chỉ “trả về 200”. Cần thấy được log có cấu trúc, metric/trace phù hợp và test cho invariant quan trọng.

### 6. Viết ADR

ADR một trang:

```markdown
# ADR-NNN: <quyết định>
Status: Accepted
Context: vấn đề và constraint
Decision: chọn gì
Consequences: được gì, trả giá gì
Revisit when: khi nào cần xem lại
```

### 7. Demo từ đầu

Xóa container/volume test, chạy lại README và xác nhận người khác không cần kiến thức ẩn của người viết.

## Definition of Done cho mỗi bài

- [ ] Chạy được bằng các lệnh trong bài.
- [ ] Có request/event mẫu để chứng minh happy path.
- [ ] Có ít nhất một failure case được kiểm thử.
- [ ] `go test ./...` thành công.
- [ ] `go test -race ./...` thành công với phần có concurrency.
- [ ] Không commit secret; config nhận qua environment.
- [ ] Network server/client có timeout và truyền `context.Context`.
- [ ] Log có `service`, `request_id` hoặc `trace_id`; không log token/PII.
- [ ] README/sơ đồ phản ánh đúng code hiện tại.
- [ ] Ghi lại trade-off quan trọng bằng ADR.

## Ba cấp độ bài tập

> [!example] Core
> Làm đúng các bước để có deliverable chuẩn. Phù hợp người cần vào dự án nhanh.

> [!example] Production
> Thêm retry, idempotency, security, metrics và operational check tương ứng.

> [!example] Architect
> So sánh ít nhất hai phương án, ghi ADR và xác định tín hiệu khiến quyết định phải thay đổi.

## Quy tắc không “copy-paste mù”

Sau mỗi đoạn code, hãy tự trả lời:

1. Object nào sở hữu state?
2. Lifetime của goroutine/connection là bao lâu?
3. Ai hủy operation?
4. Error được chuyển thành transport response/event thế nào?
5. Retry có thể tạo duplicate side effect không?

Nếu chưa trả lời được, quay lại đoạn vừa code trước khi thêm thư viện tiếp theo.

## 🔬 Đào sâu kỹ thuật — biến Definition of Done thành code, không phải checklist giấy

Checklist markdown dễ bị bỏ qua khi deadline gấp. Cách khoa học hơn: viết một **DoD runner** bằng Go, chạy thật các điều kiện và fail build nếu vi phạm — đây cũng là bài kiểm tra Go đầu tiên trong repo `gocommerce`, được các bài sau tái sử dụng.

`tools/dodcheck/main.go`:

```go
package main

import (
    "fmt"
    "os"
    "os/exec"
)

type check struct {
    name string
    args []string
}

func main() {
    checks := []check{
        {"go vet", []string{"vet", "./..."}},
        {"go test", []string{"test", "./..."}},
        {"go test -race", []string{"test", "-race", "./..."}},
    }

    failed := 0
    for _, c := range checks {
        fmt.Printf("== %s ==\n", c.name)
        cmd := exec.Command("go", c.args...)
        cmd.Stdout = os.Stdout
        cmd.Stderr = os.Stderr
        if err := cmd.Run(); err != nil {
            fmt.Printf("FAIL: %s (%v)\n", c.name, err)
            failed++
            continue
        }
        fmt.Printf("PASS: %s\n", c.name)
    }

    if failed > 0 {
        fmt.Printf("\n%d/%d check thất bại — chưa đạt Definition of Done.\n", failed, len(checks))
        os.Exit(1)
    }
    fmt.Println("\nTất cả check đạt Definition of Done.")
}
```

Chạy sau mỗi bài:

```bash
go run ./tools/dodcheck
```

Vì sao viết bằng Go thay vì chỉ dùng script bash: `dodcheck` sẽ được các bài sau (10, 12, 48…) mở rộng để tự động kiểm tra coverage tối thiểu, độ trễ benchmark, hoặc số goroutine leak sau test — logic đó cần cấu trúc dữ liệu (`[]check`, kết quả có typed error) chứ không chỉ nối lệnh shell.

### Xâu chuỗi mã nguồn qua các bài

Từ bài này, mỗi lần hoàn thành một bài trong repo `gocommerce`, đóng tag để bài sau tham chiếu chính xác:

```bash
go run ./tools/dodcheck && git add -A && git commit -m "Bài 01: dodcheck runner" && git tag v0.1.0
```

Bài 04 sẽ tạo repo thật và bài 05 là service đầu tiên chạy qua `dodcheck`; từ đó `tools/dodcheck` là một phần cố định của mọi bài, không phải ví dụ dùng một lần.

## Nhật ký tiến độ gợi ý

| Ngày | Bài | Core | Production | Điều chưa rõ | ADR/commit |
|---|---|---:|---:|---|---|
| | | ⬜ | ⬜ | | |

---

**Trước:** [[00-Series-Hub]] · **Tiếp theo:** [[02-Vi-sao-Go-cho-Microservices]]
