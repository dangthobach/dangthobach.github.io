---
type: course
domain: languages/go
status: active
created: 2026-08-16
updated: 2026-08-16
tags: []
---

# Bài 38: String Functions, Formatting, Templates & Regex — Nhóm 4 Phần 1

> **Mục tiêu:** Nhóm 4 xử lý "text processing" — 4 mảnh cần trong hầu như mọi service PDMS: tra cứu/xử lý chuỗi (`strings`), format output (`fmt`), sinh nội dung động (`text/template` — email thông báo, PDF template) và validate pattern (`regexp`). Note: **Sorting/Sorting-by-Functions đã cover đầy đủ ở [[Bai-32-Data-Structures-Algorithms|Bài 32 mục 9-10]]** — không lặp lại ở đây.
>
> **Level:** Foundation → Intermediate (đọc sau Bài 37 — cần nền string/rune)

---

## 1. `strings` Package — Tour nhanh + trap hiệu năng

```go
strings.Contains("Hồ sơ vay vốn", "vay")     // true
strings.HasPrefix("DOC-2026-001", "DOC-")     // true
strings.Split("a,b,,c", ",")                  // ["a","b","","c"] — GIỮ empty string!
strings.Fields("  a   b  c ")                 // ["a","b","c"] — tự loại whitespace thừa
strings.TrimSpace("  hồ sơ  ")                // "hồ sơ"
strings.ToLower("DOC-001") == "doc-001"       // so sánh case-insensitive kiểu thủ công
strings.EqualFold("DOC-001", "doc-001")       // true — ĐÚNG hơn ToLower==ToLower (xử lý Unicode case folding đúng chuẩn, vd tiếng Thổ Nhĩ Kỳ "İ"/"i")
```

### 1.1 Advanced #1 — `strings.Cut` (Go 1.18+) thay cho `SplitN` khi chỉ cần 2 phần

```go
// Trước 1.18 — cồng kềnh cho trường hợp phổ biến "tách 1 lần"
parts := strings.SplitN("user:pass", ":", 2)
if len(parts) == 2 {
    user, pass := parts[0], parts[1]
}

// Go 1.18+ — rõ ràng, không cần check len
user, pass, found := strings.Cut("user:pass", ":")
if !found {
    // không có dấu ":" trong chuỗi
}
```

### 1.2 Advanced #2 — `strings.Replacer` khi thay THẬT NHIỀU cặp string cùng lúc

```go
// ❌ N lần Replace = N lần duyệt toàn bộ chuỗi
s = strings.ReplaceAll(s, "&", "&amp;")
s = strings.ReplaceAll(s, "<", "&lt;")
s = strings.ReplaceAll(s, ">", "&gt;")

// ✅ 1 lần duyệt cho TẤT CẢ cặp — dựng 1 lần, dùng lại nhiều lần
var htmlEscaper = strings.NewReplacer(
    "&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;",
)
escaped := htmlEscaper.Replace(rawInput) // dùng trong PDMS khi build nội dung email/notification
```

### 1.3 Advanced #3 — `FieldsFunc` cho custom delimiter logic

```go
// Tách theo NHIỀU loại delimiter khác nhau (vd parse mã hồ sơ cũ hệ legacy
// dùng lẫn lộn dấu / và - và khoảng trắng)
parts := strings.FieldsFunc("DOC-2026/08 VAY", func(r rune) bool {
    return r == '-' || r == '/' || r == ' '
})
// ["DOC", "2026", "08", "VAY"]
```

---

## 2. `fmt` — Verbs, Custom Formatting & Trap Hiệu Năng

```go
type Document struct {
    ID     string
    Status DocumentStatus
}
d := Document{ID: "D1", Status: StatusApproved}

fmt.Printf("%v\n",  d) // {D1 approved} — dùng Stringer nếu field có implement
fmt.Printf("%+v\n", d) // {ID:D1 Status:approved} — kèm tên field, RẤT hữu ích khi debug/log
fmt.Printf("%#v\n", d) // main.Document{ID:"D1", Status:2} — Go-syntax representation, dùng khi cần copy-paste literal
fmt.Printf("%T\n",  d) // main.Document — type, hữu ích khi debug interface{} chứa gì
```

```
┌────────────────────────────────────────────────────────────┐
│  %v    →  giá trị mặc định (gọi String() nếu có Stringer)   │
│  %+v   →  thêm tên field — DÙNG CHO LOG, dễ đọc nhất         │
│  %#v   →  Go syntax literal — DÙNG CHO DEBUG cần tái tạo code│
│  %T    →  type — DÙNG KHI debug any/interface{} không rõ type│
└────────────────────────────────────────────────────────────┘
```

### 2.1 Advanced #1 — Custom `Format` interface (mạnh hơn `Stringer`, kiểm soát từng verb)

```go
// Stringer chỉ can thiệp %v/%s. Muốn custom CẢ %x, %+v khác nhau
// phải implement fmt.Formatter — hiếm dùng nhưng quan trọng khi
// cần che dữ liệu nhạy cảm (PII) một cách nhất quán ở MỌI verb
type MaskedAccountNumber string

func (a MaskedAccountNumber) Format(f fmt.State, verb rune) {
    s := string(a)
    if len(s) > 4 {
        s = "****" + s[len(s)-4:] // chỉ hiện 4 số cuối, mọi verb đều bị mask
    }
    fmt.Fprint(f, s)
}
// fmt.Printf("%v", MaskedAccountNumber("0123456789")) → "****6789"
// fmt.Printf("%s", MaskedAccountNumber("0123456789")) → "****6789" — KHÔNG THỂ lộ full số
```

⚠ **Vì sao quan trọng với PDMS/banking:** nếu chỉ dựa vào developer "nhớ" luôn mask số tài khoản trước khi log, sớm muộn sẽ có chỗ quên → lộ PII vào log. Implement `Format()` một lần trên type khiến việc mask trở thành **bất biến ở mức type system** — bất kỳ đâu log struct chứa field này đều tự động mask.

### 2.2 Advanced #2 — `%w` wrap error (nối tiếp Bài 4, cần nhắc vì hay dùng chung với Sprintf)

```go
if err != nil {
    return fmt.Errorf("fetch document %s: %w", id, err) // %w giữ chain lỗi gốc
}
// Cho phép errors.Is / errors.Unwrap truy ngược lỗi gốc — %v/%s chỉ nối string,
// mất khả năng unwrap
```

### 2.3 Advanced #3 — Trap hiệu năng: `Sprintf` trong hot path

```go
// ❌ Sprintf allocate string trung gian rồi Println LẠI allocate/copy
log.Println(fmt.Sprintf("processing doc %s status %s", id, status))

// ✅ Println/Printf nhận args trực tiếp — build string 1 lần, đúng chỗ cần
log.Printf("processing doc %s status %s", id, status)

// ✅✅ Structured logging (Zap, đã dùng ở Bài 19) — KHÔNG format string ở tất cả,
// tránh cost format hoàn toàn nếu log level bị tắt (lazy field evaluation)
logger.Info("processing document", zap.String("id", id), zap.String("status", status.String()))
```

---

## 3. `text/template` — Sinh Nội Dung Động (Email, Thông Báo)

```go
import "text/template"

const notifyTmpl = `Kính gửi {{.RecipientName}},

Hồ sơ {{.DocumentID}} đã chuyển trạng thái: {{.Status}}.
{{if .IsUrgent}}⚠ Đây là hồ sơ ƯU TIÊN, cần xử lý trong {{.SLAHours}}h.{{end}}

{{range .Comments}}- {{.Author}}: {{.Text}}
{{end}}
Trân trọng,
Hệ thống PDMS
`

type NotifyData struct {
    RecipientName string
    DocumentID    string
    Status        string
    IsUrgent      bool
    SLAHours      int
    Comments      []Comment
}

tmpl := template.Must(template.New("notify").Parse(notifyTmpl))
var buf bytes.Buffer
err := tmpl.Execute(&buf, NotifyData{
    RecipientName: "Anh Bách", DocumentID: "DOC-2026-001",
    Status: "pending_review", IsUrgent: true, SLAHours: 24,
})
```

```
┌────────────────────────────────────────────────────────────┐
│  {{.Field}}       → truy cập field/method                    │
│  {{if .X}}...{{end}}       → điều kiện                        │
│  {{range .Items}}...{{end}} → lặp (bên trong {{.}} = item hiện tại)│
│  {{with .X}}...{{end}}      → đổi context nếu .X không rỗng   │
│  template.Must(...)         → panic ngay nếu parse lỗi (dùng  │
│                                 cho template load lúc khởi động,│
│                                 lỗi cấu hình PHẢI fail sớm)     │
└────────────────────────────────────────────────────────────┘
```

⚠ **CỰC KỲ quan trọng cho PDMS — `text/template` KHÔNG escape HTML:** nếu nội dung template được render ra và hiển thị trong browser (email HTML, trang xem trước hồ sơ), PHẢI dùng `html/template` (cùng API, khác package import) — nó tự động escape `<script>` trong dữ liệu người dùng nhập (comment, tên hồ sơ) để chống XSS. Dùng nhầm `text/template` cho output HTML là lỗ hổng bảo mật thực sự, không phải lý thuyết.

```go
// ❌ Nếu Comment.Text chứa "<script>alert(1)</script>" và render ra email HTML
import "text/template" // SAI cho HTML output

// ✅ Cùng cú pháp, tự động escape
import "html/template" // ĐÚNG — html/template.Must, .Parse, .Execute giống hệt API
```

---

## 4. `regexp` — Compile Once, Trap Hiệu Năng Kinh Điển

```go
// ❌ TRAP CỰC KỲ PHỔ BIẾN — compile regex MỖI LẦN gọi function
func isValidDocCode(s string) bool {
    re := regexp.MustCompile(`^DOC-\d{4}-\d{3,6}$`) // compile lại MỖI lần gọi!
    return re.MatchString(s)
}

// ✅ Compile MỘT LẦN ở package level (init time), tái sử dụng
var docCodeRegex = regexp.MustCompile(`^DOC-\d{4}-\d{3,6}$`)

func isValidDocCode(s string) bool {
    return docCodeRegex.MatchString(s)
}
```

```
┌────────────────────────────────────────────────────────────┐
│  regexp.Compile() KHÔNG rẻ — nó parse pattern thành finite   │
│  automaton (NFA), tốn CPU đáng kể. Gọi trong hot path (mỗi   │
│  request HTTP validate input) mà compile lại mỗi lần có thể   │
│  chiếm phần lớn latency của handler — dùng biến package-level │
│  hoặc sync.Once nếu cần compile lazy (pattern build từ config) │
└────────────────────────────────────────────────────────────┘
```

### 4.1 Advanced #1 — Named capture group cho parse có cấu trúc

```go
var docCodeParts = regexp.MustCompile(`^DOC-(?P<year>\d{4})-(?P<seq>\d{3,6})$`)

func parseDocCode(s string) (year, seq string, ok bool) {
    m := docCodeParts.FindStringSubmatch(s)
    if m == nil {
        return "", "", false
    }
    names := docCodeParts.SubexpNames()
    result := make(map[string]string)
    for i, name := range names {
        if i != 0 && name != "" {
            result[name] = m[i]
        }
    }
    return result["year"], result["seq"], true
}
```

### 4.2 Advanced #2 — `FindAllStringSubmatch` cho parse log/text nhiều dòng

```go
var kvPattern = regexp.MustCompile(`(\w+)=("[^"]*"|\S+)`)

// Parse structured log line kiểu: level=info doc_id="DOC-001" status=approved
matches := kvPattern.FindAllStringSubmatch(`level=info doc_id="DOC-001" status=approved`, -1)
for _, m := range matches {
    key, val := m[1], strings.Trim(m[2], `"`)
    fmt.Println(key, "=", val)
}
```

⚠ **Khi nào KHÔNG nên dùng regex:** validate format đơn giản (chỉ check prefix/suffix/length) nên dùng `strings.HasPrefix`/`len()` trực tiếp — nhanh hơn regex đáng kể và dễ đọc hơn. Regex hợp lý khi pattern thực sự phức tạp (nhiều nhóm, alternation, lookup theo vị trí) — đừng regex hoá mọi thứ chỉ vì quen tay từ ngôn ngữ khác.

---

## 5. Tổng kết Bài 38

```
┌─────────────────────────────────────────────────────────┐
│                   KEY TAKEAWAYS                          │
├─────────────────────────────────────────────────────────┤
│  ✅ strings.Cut thay SplitN khi chỉ cần tách 1 lần;        │
│     strings.Replacer cho nhiều cặp thay thế cùng lúc,      │
│     nhanh hơn N lần ReplaceAll liên tiếp                   │
│  ✅ %+v cho log dễ đọc, %#v cho debug tái tạo literal,      │
│     %T khi debug type của interface{}/any                  │
│  ✅ Implement fmt.Formatter để BẮT BUỘC mask dữ liệu nhạy   │
│     cảm (PII) ở mọi verb — an toàn hơn "nhớ" mask thủ công  │
│  ✅ text/template KHÔNG escape HTML — dùng html/template     │
│     cho bất kỳ output nào render ra browser/email HTML       │
│  ✅ regexp.MustCompile phải ở package level, KHÔNG compile   │
│     lại trong function gọi thường xuyên (hot path)            │
│  ✅ Không phải validate nào cũng cần regex — strings.HasPrefix│
│     đơn giản hơn và nhanh hơn cho pattern không phức tạp      │
└─────────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** Bài 39 — JSON, XML, Time & Epoch (Nhóm 4 phần 2)

---

**Bài tập:**
1. Viết `MaskedField` generic dùng cho cả số tài khoản, số CCCD, email — implement `fmt.Formatter` chung, tham số hoá số ký tự giữ lại
2. Viết template email HTML đầy đủ (dùng `html/template`) cho thông báo phê duyệt hồ sơ, test với input chứa `<script>` để verify escape hoạt động
3. Viết regex + named group parse số điện thoại Việt Nam ở nhiều format khác nhau (+84, 0, có/không dấu cách) về 1 dạng chuẩn hoá
4. Benchmark `regexp.MustCompile` gọi trong loop vs compile 1 lần package-level, đo chênh lệch với `go test -bench`

---
*Tags: #go #strings #fmt #templates #regexp #zero-to-hero #foundation*
