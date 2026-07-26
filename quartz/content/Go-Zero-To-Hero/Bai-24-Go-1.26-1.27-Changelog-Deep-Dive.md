---
type: course
domain: languages/go
status: active
created: 2026-07-24
updated: 2026-07-24
tags: []
---

# Bài 24: Go 1.26 & 1.27 Changelog Deep Dive — Green Tea GC, Generic Methods & Escape Analysis Update

> **Mục tiêu:** Không chỉ liệt kê "có gì mới" — mà hiểu **vì sao** Go team đổi GC mặc định, đổi cách generic hoạt động, và những thay đổi này tác động gì tới code PDMS đang chạy production.
>
> **Level:** Advanced (đọc sau Bài 23 — cần nền escape analysis + GC)
> **Bối cảnh:** Go 1.26 phát hành 10/02/2026 (bản ổn định hiện tại), Go 1.27 đang ở Release Candidate, dự kiến phát hành 08/2026.

---

## 0. Vì sao cần bài "đọc changelog" riêng?

```
┌──────────────────────────────────────────────────────────┐
│  CÁCH ĐỌC CHANGELOG SAI          │  CÁCH ĐỌC ĐÚNG          │
├────────────────────────────────────┼──────────────────────┤
│ Đọc tiêu đề, gật đầu "ok cool"    │ Hỏi: thay đổi này đụng │
│                                    │ tới cơ chế nào bên     │
│                                    │ dưới mà mình đã học?   │
│ Bỏ qua nếu "mình không dùng       │ Kiểm tra: có ảnh hưởng  │
│ feature đó"                        │ benchmark/behavior     │
│                                    │ NGẦM không (vd GC mặc  │
│                                    │ định đổi mà code không │
│                                    │ đổi 1 dòng)             │
│ Update Go version ngay lập tức    │ Đọc release notes,      │
│ trên production                    │ chạy trên staging,      │
│                                    │ đo GC pause/benchmark   │
│                                    │ trước khi rollout       │
└────────────────────────────────────┴──────────────────────┘
```

---

## 1. Go 1.26 — Green Tea GC chính thức bật mặc định

Bài 23 đã nói GC phải scan pointer field. Green Tea là **thiết kế lại phần mark/scan** cho small object — đây là thay đổi ảnh hưởng lớn nhất tới toàn bộ PDMS mà **không cần đổi một dòng code nào**.

### 1.1 Vấn đề mà GC cũ gặp phải

```
┌─────────────────────────────────────────────────────────┐
│           GC TRUYỀN THỐNG (trước Green Tea)              │
│                                                            │
│  Heap: hàng triệu small object (struct nhỏ, string, map  │
│  entry...) nằm RẢI RÁC khắp heap                          │
│                                                            │
│  ┌───┐    ┌───┐         ┌───┐              ┌───┐         │
│  │obj│....│obj│.........│obj│..............│obj│         │
│  └───┘    └───┘         └───┘              └───┘         │
│                                                            │
│  Mark phase phải "nhảy" (random access) qua từng object   │
│  → cache miss liên tục → CPU chờ RAM, scalability kém khi │
│  tăng số core (nhiều goroutine mark cùng lúc nhưng vẫn    │
│  đụng cùng vấn đề cache locality)                          │
└─────────────────────────────────────────────────────────┘
```

### 1.2 Green Tea giải quyết thế nào

```
┌─────────────────────────────────────────────────────────┐
│              GREEN TEA GC (Go 1.26 mặc định)              │
│                                                            │
│  Gom nhóm small object theo SPAN (khối bộ nhớ liền kề)    │
│  và scan theo khối thay vì nhảy từng object riêng lẻ       │
│                                                            │
│  ┌─────────────────────┐  ┌─────────────────────┐         │
│  │ SPAN: obj│obj│obj│obj│  │ SPAN: obj│obj│obj│obj│         │
│  │ (liền kề bộ nhớ)     │  │ (liền kề bộ nhớ)     │         │
│  └─────────────────────┘  └─────────────────────┘         │
│         ↓ scan tuần tự            ↓ scan tuần tự          │
│  Cache locality tốt hơn nhiều → ít cache miss              │
│  Trên CPU hỗ trợ vector instruction (Ice Lake, Zen 4+)     │
│  → dùng SIMD để scan nhiều object cùng lúc                 │
└─────────────────────────────────────────────────────────┘
```

**Kết quả đo được:** giảm 10–40% GC overhead tuỳ workload, thêm ~10% nữa trên CPU mới. Đây là lý do nên **benchmark lại các service PDMS chạy trên EKS** sau khi lên 1.26 — service nào tạo nhiều small object/giây (ví dụ pipeline xử lý document metadata, event từ Kafka) sẽ thấy khác biệt rõ nhất.

```go
// Không cần đổi code — Green Tea tự động áp dụng.
// Muốn quay lại GC cũ để so sánh (chỉ nên làm khi benchmark, KHÔNG production):
// GOEXPERIMENT=nogreenteagc go build ./...
// Lưu ý: cờ này dự kiến bị XOÁ ở Go 1.27 — đừng phụ thuộc lâu dài.
```

### 1.3 Liên hệ với checklist Bài 23

Nguyên tắc "giảm số pointer field trong struct có hàng triệu instance" ở Bài 23 **vẫn đúng và còn quan trọng hơn** với Green Tea — vì struct scalar-only (không pointer) gần như miễn phí hoàn toàn với GC mới, trong khi struct nhiều pointer field vẫn cần theo dõi.

---

## 2. Go 1.26 — Hai thay đổi cú pháp nhỏ nhưng ảnh hưởng cách viết generic code

### 2.1 `new()` nhận biểu thức làm operand

```go
// Trước Go 1.26 — new() chỉ tạo zero value, phải gán riêng
p := new(int)
*p = 42

// Go 1.26 — new() nhận operand để khởi tạo giá trị ngay
p := new(42) // tương đương: x := 42; p := &x

// Hữu ích nhất trong context trả pointer tới literal/expression
// trực tiếp mà không cần khai báo biến tạm — hay gặp khi build
// optional field cho request DTO (xem *T pattern ở Bài 23, mục 7)
type UpdateRequest struct {
    Priority *int
}

req := UpdateRequest{
    Priority: new(5), // gọn hơn hẳn so với "p := 5; Priority: &p"
}
```

### 2.2 Generic type tự tham chiếu chính nó trong type parameter list

```go
// Trước Go 1.26 — không thể viết trực tiếp kiểu này,
// phải dùng workaround (interface riêng hoặc thêm type parameter phụ)

// Go 1.26 — cho phép:
type Node[T any] struct {
    Value T
    Next  *Node[T] // OK — nhưng phần MỚI là type parameter tự trỏ
}

// Ví dụ thật hơn: một Tree tự cân bằng generic, node cần biết
// kiểu chính xác của "chính nó" để so sánh/merge — trước đây phải
// thêm type parameter phụ kiểu Self như Rust hoặc dùng any + type
// assertion (mất type safety), giờ viết trực tiếp được.
```

**Vì sao đáng chú ý cho PDMS:** phần Design-Patterns-Go và Microservices-Patterns hay cần cấu trúc dữ liệu tự tham chiếu generic (linked structure, tree cho document hierarchy) — thay đổi này giảm workaround, code generic gọn và type-safe hơn.

### 2.3 Package mới đáng chú ý: `runtime/pprof` goroutineleak (experimental)

```go
// Experimental profile giúp phát hiện goroutine bị leak —
// rất hợp với phần Kafka Sarama consumer (Bài 17) và worker pool
// (Microservices-Patterns) nơi goroutine leak là bug khó phát hiện nhất

// Bật khi profiling (không dùng production thường trực vì là experimental):
// go tool pprof -goroutineleak http://localhost:6060/debug/pprof/goroutineleak
```

---

## 3. Go 1.27 (RC, sắp phát hành 08/2026) — Generic Methods

Đây là thay đổi **được chờ đợi nhất** kể từ khi Go có generics (1.18).

### 3.1 Vấn đề hiện tại (Go ≤ 1.26)

```go
// Method KHÔNG được tự khai báo type parameter riêng —
// chỉ có generic FUNCTION ở package-level làm được việc này

type Repository struct{ db *sql.DB }

// ❌ Không hợp lệ ở Go ≤ 1.26:
// func (r *Repository) FindBy[T any](id string) (T, error) { ... }

// Workaround hiện tại: phải kéo generic ra thành free function,
// mất tính "method" tự nhiên, hoặc dùng any + type assertion (mất
// type safety) — đây là điều Bài 23 mục 9 gọi là "trade-off có chủ đích"
// nhưng thực ra là GIỚI HẠN của ngôn ngữ, không phải lựa chọn thiết kế
func FindBy[T any](r *Repository, id string) (T, error) {
    var result T
    // ...
    return result, nil
}
```

### 3.2 Go 1.27 giải quyết

```go
// ✅ Go 1.27 — method tự khai báo type parameter:
type Repository struct{ db *sql.DB }

func (r *Repository) FindBy[T any](id string) (T, error) {
    var result T
    row := r.db.QueryRow("SELECT data FROM entities WHERE id = ?", id)
    err := row.Scan(&result)
    return result, err
}

// Dùng tự nhiên như bất kỳ generic function nào:
repo := &Repository{db: conn}
order, err := repo.FindBy[Order]("order-123")
doc, err := repo.FindBy[Document]("doc-456")
```

```
┌──────────────────────────────────────────────────────────┐
│  LƯU Ý QUAN TRỌNG (đọc kỹ trước khi áp dụng)              │
│  - Method của INTERFACE KHÔNG được khai báo type param     │
│  - Interface method KHÔNG THỂ được implement bởi generic   │
│    method — tức không thể dùng generic method để thoả mãn  │
│    một interface method thông thường                       │
│  → generic method phù hợp cho REPOSITORY LAYER (concrete   │
│    type) hơn là cho SERVICE INTERFACE (vẫn cần function    │
│    signature cụ thể như trước)                              │
└──────────────────────────────────────────────────────────┘
```

### 3.3 Go 1.27 — size-specialized allocation, giảm ~30% chi phí small allocation

Compiler sinh ra các routine allocation chuyên biệt theo size cho object nhỏ (<80 byte) thay vì dùng 1 routine chung — giảm overhead đáng kể cho workload tạo nhiều small struct/giây (rất giống context Green Tea GC ở mục 1, nhưng đây là phía **allocation** thay vì **collection**).

```
┌─────────────────────────────────────────────────────────┐
│  Go ≤ 1.26: 1 allocation routine chung xử lý mọi size     │
│  Go 1.27: routine RIÊNG cho từng size class phổ biến      │
│           (compiler tự chọn tại compile-time dựa vào      │
│           kích thước struct đã biết)                        │
│  → giảm branch/overhead runtime khi allocate object nhỏ    │
└─────────────────────────────────────────────────────────┘
```

---

## 4. Timeline tổng hợp — nên upgrade khi nào?

```
┌────────────────────────────────────────────────────────────┐
│  Go 1.25 (08/2025) → GA, ổn định, đã EOL support sớm hơn    │
│  Go 1.26 (02/2026) → STABLE HIỆN TẠI, khuyến nghị dùng cho  │
│                       PDMS production ngay (Green Tea GC    │
│                       đã qua giai đoạn experimental)         │
│  Go 1.27 (~08/2026, đang RC2) → CHỜ bản GA + ít nhất 1       │
│                       point release (1.27.1) trước khi đưa   │
│                       vào production, nhưng NÊN thử ngay      │
│                       trên nhánh dev để làm quen generic      │
│                       methods trước khi refactor repository   │
│                       layer thật                               │
└────────────────────────────────────────────────────────────┘
```

---

## 5. Tổng kết Bài 24

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                          │
├─────────────────────────────────────────────────────┤
│  ✅ Green Tea GC (1.26, mặc định) = scan theo span    │
│     liền kề thay vì nhảy từng object → giảm 10-40%    │
│     GC overhead, KHÔNG cần đổi code                    │
│  ✅ Nguyên tắc "giảm pointer field" ở Bài 23 vẫn đúng, │
│     thậm chí quan trọng hơn với Green Tea              │
│  ✅ new(expr) và generic type tự tham chiếu (1.26) →   │
│     gọn hơn cho optional field và cấu trúc tự đệ quy   │
│  ✅ Generic methods (1.27, sắp GA) = giải quyết giới    │
│     hạn lớn nhất của generics từ 1.18 tới nay — nhưng  │
│     KHÔNG áp dụng được cho interface method             │
│  ✅ Size-specialized allocation (1.27) giảm ~30% chi   │
│     phí allocate object nhỏ                             │
│  ✅ Luôn benchmark trên staging trước khi upgrade Go    │
│     version cho PDMS — đặc biệt với thay đổi GC mặc     │
│     định "âm thầm" như Green Tea                         │
└─────────────────────────────────────────────────────┘
```

**Xem lại:** [[Bai-23-Pointers-Deep-Dive|Bài 23: Pointers Deep Dive]] (nền tảng escape analysis & GC)
**Liên quan:** [[Performance-Pitfalls-Go|Performance Pitfalls in Go]]
**Bài tiếp theo gợi ý:** Benchmark thực tế Green Tea GC trên 1 service PDMS thật (đo GC pause trước/sau khi upgrade lên 1.26), và thử nghiệm generic methods trên repository layer khi Go 1.27 GA.

---

**Bài tập:**
1. Upgrade 1 service PDMS non-critical lên Go 1.26 trên staging, đo GC pause time (dùng `GODEBUG=gctrace=1`) trước và sau
2. Viết thử 1 generic method trên `go1.27rc2` (`go install golang.org/dl/go1.27rc2@latest`) cho Repository layer, so sánh với workaround free-function hiện tại
3. Tìm 1 struct trong PDMS có nhiều pointer field, thử refactor giảm pointer field và benchmark tác động GC

---
*Tags: #go #changelog #gc #green-tea-gc #generics #escape-analysis #zero-to-hero*

## 6. Cập nhật 26/07/2026 — đối chiếu với nguồn chính thức (go.dev, blog Go)

Kiểm tra lại 2 ngày sau khi bài viết, không có thay đổi lớn nào lệch với nội dung trên — nhưng có vài điểm nên bổ sung:

### 6.1 Trạng thái phiên bản mới nhất
- **Go 1.26 (bản ổn định):** patch mới nhất là **1.26.5** (phát hành 07/07/2026) — vá 2 lỗi bảo mật (`crypto/tls`, `os`), không đổi hành vi Green Tea GC đã mô tả ở mục 1.
- **Go 1.27:** đã lên **Release Candidate 2** (`go1.27rc2`, phát hành 07-08/07/2026) — RC2 chỉ chứa 2 fix bảo mật (`os.Root` symlink escape, `crypto/tls` ECH privacy leak), không có thay đổi tính năng so với RC1. Vẫn đúng lộ trình GA dự kiến 08/2026 như đã ghi ở mục 4.
- Bài tập cuối bài (`go install golang.org/dl/go1.27rc2@latest`) đã đúng với RC hiện tại — không cần sửa.

### 6.2 Ba thay đổi Go 1.27 khác nên biết thêm (ngoài generic methods và size-specialized allocation ở mục 3)

Theo release notes chính thức (tip.golang.org/doc/go1.27, còn ở dạng draft):

```
┌─────────────────────────────────────────────────────────┐
│  encoding/json chuyển sang v2 làm mặc định                │
│  → hành vi marshal/unmarshal một số edge case (duplicate  │
│    key, số lớn, omitempty) có thể khác v1 — cần test kỹ   │
│    trước khi upgrade service PDMS nào serialize JSON       │
│    phức tạp (đặc biệt request/response document metadata) │
│                                                            │
│  stdlib có package `uuid` chính thức                       │
│  → có thể bỏ dependency bên thứ 3 (google/uuid) cho code   │
│    mới, nhưng KHÔNG cần migrate code cũ ngay                │
│                                                            │
│  Post-quantum signature hỗ trợ trong TLS                   │
│  → tiếp nối post-quantum key exchange đã có ở Go 1.26      │
│    (SecP256r1MLKEM768/SecP384r1MLKEM1024), giờ thêm chữ ký │
│    hậu lượng tử — liên quan tới hạ tầng TLS termination ở  │
│    EKS ingress, nên theo dõi khi GA                         │
└─────────────────────────────────────────────────────────┘
```

**Lưu ý:** các điểm trên vẫn ở dạng *draft release notes* (go.dev tự ghi rõ "Go 1.27 is not yet released... Details can still change"), nên chỉ nên dùng để lên kế hoạch, chưa nên viết code phụ thuộc vào hành vi cụ thể trước khi GA.

*Nguồn kiểm tra: go.dev/doc/go1.27 (draft), go.dev/doc/devel/release, groups.google.com/g/golang-announce — truy cập 26/07/2026.*
