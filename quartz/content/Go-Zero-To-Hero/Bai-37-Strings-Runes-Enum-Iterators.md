---
type: course
domain: languages/go
status: active
created: 2026-08-16
updated: 2026-08-16
tags: []
---

# Bài 37: Strings/Runes, Enum Pattern & Range-over-Func Iterators

> **Mục tiêu:** Bài cuối nhóm "Cú pháp nền tảng" — nặng về code thực chiến hơn lý thuyết. String Go là UTF-8 immutable byte sequence (khác Java `String` UTF-16), Go không có `enum` native nên cần pattern chuẩn, và Go 1.23+ có iterator model hoàn toàn mới (`range-over-func`) đang dần thay thế việc viết getter trả `[]T`.
>
> **Level:** Foundation (đọc sau Bài 35). Range-over-func yêu cầu Go ≥ 1.23.

---

## 1. Strings & Runes — UTF-8 Byte Sequence, không phải mảng ký tự

```go
s := "Hồ sơ" // "Hồ sơ" = document record, ví dụ domain PDMS
fmt.Println(len(s))          // 7 — SỐ BYTE, không phải số ký tự!
fmt.Println(len([]rune(s)))  // 5 — số RUNE (ký tự Unicode thật)
```

```
┌────────────────────────────────────────────────────────────┐
│         "Hồ sơ" TRONG BỘ NHỚ — UTF-8 BYTE SEQUENCE            │
│                                                              │
│  H    ồ          s    ơ                                     │
│  │    │           │    │                                     │
│  1B  3B (ồ=U+1ED3) 1B 1B  2B (ơ=U+01A1)     ← 1 space = 1B    │
│  ─────────────────────────────────────                      │
│  Tổng: 1+3+1+1+2 = ... = 7 byte, nhưng chỉ 5 rune             │
│                                                              │
│  s[1] KHÔNG PHẢI 'ồ' — nó là 1 BYTE GIỮA của chuỗi UTF-8 3    │
│  byte, vô nghĩa nếu đứng riêng lẻ!                             │
└────────────────────────────────────────────────────────────┘
```

⚠ **Trap kinh điển:** `s[i]` index vào **byte**, không phải ký tự. Với ASCII thuần (a-z, 0-9) thì 1 byte = 1 ký tự nên không sao — nhưng bất kỳ dữ liệu tiếng Việt/CJK/emoji nào trong PDMS (tên người, tên hồ sơ tiếng Việt có dấu) mà index/slice theo byte sẽ cắt đứt giữa 1 ký tự multi-byte, gây `�` hoặc dữ liệu hỏng.

### 1.1 Advanced #1 — Đếm ký tự đúng chuẩn (không chỉ đếm rune)

```go
import (
    "unicode/utf8"
    "golang.org/x/text/unicode/norm" // xử lý ký tự tổ hợp (combining marks)
)

// Đếm rune — ĐỦ cho hầu hết trường hợp
n := utf8.RuneCountInString("Hồ sơ khách hàng") // đúng, nhanh, không alloc

// Đếm "grapheme cluster" (ký tự người dùng NHÌN THẤY) — cần khi
// có emoji ghép (👨‍👩‍👧‍👦 = 1 grapheme nhưng NHIỀU rune) hoặc
// tiếng Việt dùng dấu tổ hợp thay vì ký tự dựng sẵn (rất hiếm gặp
// nhưng có thể xảy ra với dữ liệu nhập từ hệ thống cũ/OCR)
import "github.com/rivo/uniseg"
n2 := uniseg.GraphemeClusterCount("Hồ sơ 👨‍👩‍👧") // đúng số ký tự hiển thị
```

### 1.2 Advanced #2 — Reverse string UTF-8-safe (câu hỏi phỏng vấn kinh điển, code sai rất phổ biến)

```go
// ❌ SAI — reverse theo byte, phá vỡ multi-byte character
func reverseBad(s string) string {
    b := []byte(s)
    for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
        b[i], b[j] = b[j], b[i]
    }
    return string(b) // "Hồ" → chuỗi rác vì đảo ngược byte giữa char 3-byte
}

// ✅ ĐÚNG — reverse theo rune
func reverse(s string) string {
    r := []rune(s)
    for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
        r[i], r[j] = r[j], r[i]
    }
    return string(r)
}
```

### 1.3 Advanced #3 — Truncate string an toàn (rất hay cần khi cắt preview tên hồ sơ)

```go
// ❌ SAI — s[:n] cắt theo byte offset, có thể cắt giữa ký tự
func truncateBad(s string, n int) string {
    return s[:n] // panic hoặc data hỏng nếu n rơi giữa multi-byte char
}

// ✅ ĐÚNG — cắt theo rune, kiểm tra boundary
func truncate(s string, maxRunes int) string {
    if utf8.RuneCountInString(s) <= maxRunes {
        return s
    }
    r := []rune(s)
    return string(r[:maxRunes]) + "…"
}

truncate("Hồ sơ vay vốn khách hàng doanh nghiệp", 10)
// → "Hồ sơ vay …" — cắt đúng ranh giới ký tự
```

### 1.4 Advanced #4 — Iterate rune với index byte chính xác (dùng khi cần vị trí gốc)

```go
s := "Hồ sơ"
for i, r := range s { // i = BYTE offset, r = rune (KHÔNG phải index thứ i)
    fmt.Printf("byte offset %d: %c (U+%04X)\n", i, r, r)
}
// byte offset 0: H (U+0048)
// byte offset 1: ồ (U+1ED3)   ← nhảy 3 byte cho 'ồ', không phải +1
// byte offset 4: (space)
// byte offset 5: s (U+0073)
// byte offset 6: ơ (U+01A1)
```

### 1.5 Advanced #5 — `strings.Builder` cho concatenation hiệu năng cao

```go
// ❌ O(n²) — mỗi lần += tạo string MỚI (string immutable trong Go)
func buildBad(docs []Document) string {
    var result string
    for _, d := range docs {
        result += d.ID + ", " // allocate + copy TOÀN BỘ result mỗi lần
    }
    return result
}

// ✅ O(n) — Builder ghi trực tiếp vào buffer nội bộ, không copy lại
func build(docs []Document) string {
    var b strings.Builder
    b.Grow(len(docs) * 16) // pre-allocate ước lượng — tránh grow nhiều lần
    for _, d := range docs {
        b.WriteString(d.ID)
        b.WriteString(", ")
    }
    return b.String() // KHÔNG copy — trả trực tiếp buffer nội bộ
}
```

```
┌────────────────────────────────────────────────────────────┐
│  string += string (loop N lần)     │  strings.Builder        │
├────────────────────────────────────┼──────────────────────────┤
│  Mỗi vòng: allocate string mới độ   │  Ghi trực tiếp vào []byte│
│  dài tăng dần, copy TOÀN BỘ nội     │  buffer nội bộ, chỉ grow │
│  dung cũ sang → O(n²) tổng          │  buffer khi cần → O(n)   │
│  Với 10.000 document ID: ~50M byte │  Với 10.000: chỉ vài KB   │
│  copy thừa (tam giác cấp số cộng)   │  buffer thao tác          │
└────────────────────────────────────┴──────────────────────────┘
```

---

## 2. Enum Pattern — Go không có `enum`, phải tự dựng đúng chuẩn

Đã giới thiệu `iota` cơ bản ở Bài 34. Giờ đi vào pattern **production-grade** đầy đủ.

### 2.1 Advanced #1 — Enum an toàn kiểu (type-safe) + `Stringer` + validation

```go
type DocumentStatus int

const (
    StatusDraft DocumentStatus = iota
    StatusPendingReview
    StatusApproved
    StatusArchived
    statusCount // trick: giữ chỗ để biết TỔNG số status, không export
)

// Implement fmt.Stringer — bất kỳ đâu dùng %v, %s, Println đều tự
// gọi String() thay vì in số nguyên vô nghĩa
func (s DocumentStatus) String() string {
    names := [...]string{"draft", "pending_review", "approved", "archived"}
    if s < 0 || int(s) >= len(names) {
        return fmt.Sprintf("DocumentStatus(%d)", int(s)) // fallback an toàn
    }
    return names[s]
}

// Validation — Go compiler KHÔNG tự chặn DocumentStatus(999),
// phải tự viết hàm kiểm tra tại boundary (API handler, DB scan)
func (s DocumentStatus) Valid() bool {
    return s >= StatusDraft && s < statusCount
}

fmt.Println(StatusApproved)        // "approved" — nhờ Stringer
fmt.Println(DocumentStatus(99))    // "DocumentStatus(99)" — không panic
```

⚠ **Khác biệt cốt lõi với Java enum:** Java `enum` là **closed type** — compiler đảm bảo giá trị luôn nằm trong tập hợp đã khai báo. Go `DocumentStatus(99)` **biên dịch được và chạy được** — nó chỉ là `int` được đặt tên. Đây là lý do method `Valid()` ở trên **bắt buộc phải có** ở mọi enum dùng cho dữ liệu đến từ bên ngoài (JSON request, DB row, message Kafka).

### 2.2 Advanced #2 — Bit flag enum (iota với shift) — dùng cho permission/feature flag

```go
type DocumentPermission uint8

const (
    PermView DocumentPermission = 1 << iota // 1  (0b0001)
    PermEdit                                 // 2  (0b0010)
    PermDelete                               // 4  (0b0100)
    PermShare                                // 8  (0b1000)
)

// Kết hợp nhiều permission bằng OR
userPerms := PermView | PermEdit // 0b0011 = 3

// Kiểm tra CÓ permission bằng AND
if userPerms&PermEdit != 0 {
    fmt.Println("user có quyền edit")
}

// Bỏ 1 permission bằng AND NOT (&^)
userPerms &^= PermEdit // bỏ quyền Edit, giữ nguyên các quyền khác
```

```
┌────────────────────────────────────────────────────────────┐
│              BIT FLAG — iota << N                            │
├───────────────┬──────────────┬───────────────────────────┤
│  Const         │  iota        │  Giá trị nhị phân          │
├───────────────┼──────────────┼───────────────────────────┤
│  PermView      │  0            │  1 << 0 = 0001             │
│  PermEdit      │  1            │  1 << 1 = 0010             │
│  PermDelete    │  2            │  1 << 2 = 0100             │
│  PermShare     │  3            │  1 << 3 = 1000             │
└───────────────┴──────────────┴───────────────────────────┘
So sánh Java: EnumSet<Permission> dùng bitmask nội bộ tương tự,
nhưng Go bit flag là kỹ thuật TƯỜNG MINH developer tự quản lý.
```

### 2.3 Advanced #3 — Exhaustive switch check tại compile-time (giả lập, vì Go không có native)

```go
// Go KHÔNG cảnh báo nếu switch thiếu case như Java "sealed" pattern
// matching — nhưng có công cụ lint để giả lập:
// go install github.com/nishanths/exhaustive/cmd/exhaustive@latest
// exhaustive ./...
//
//exhaustive:enforce
func slaHours(s DocumentStatus) int {
    switch s {
    case StatusDraft:
        return 0
    case StatusPendingReview:
        return 24
    case StatusApproved:
        return 0
    case StatusArchived:
        return 0
    // Nếu thêm StatusRejected sau này mà QUÊN thêm case ở đây,
    // linter `exhaustive` sẽ FAIL build trong CI — đây là cách
    // PDMS mô phỏng "sealed enum" của Java mà Go không có sẵn
    }
    return 0
}
```

### 2.4 Advanced #4 — Enum + JSON marshal/unmarshal tường minh

```go
// Mặc định json.Marshal(StatusApproved) → 2 (số nguyên vô nghĩa
// với client). Muốn API trả "approved" phải tự implement:

func (s DocumentStatus) MarshalJSON() ([]byte, error) {
    return json.Marshal(s.String())
}

func (s *DocumentStatus) UnmarshalJSON(data []byte) error {
    var str string
    if err := json.Unmarshal(data, &str); err != nil {
        return err
    }
    names := map[string]DocumentStatus{
        "draft": StatusDraft, "pending_review": StatusPendingReview,
        "approved": StatusApproved, "archived": StatusArchived,
    }
    v, ok := names[str]
    if !ok {
        return fmt.Errorf("invalid document status: %q", str)
    }
    *s = v
    return nil
}
```

---

## 3. Range-over-Func — Iterator Model Mới (Go 1.23+)

Trước Go 1.23, muốn duyệt custom collection phải trả `[]T` (tốn memory copy toàn bộ) hoặc tự viết interface kiểu `Next() (T, bool)` cồng kềnh. Go 1.23 đưa iterator vào cú pháp `range` trực tiếp qua package `iter`.

```
┌────────────────────────────────────────────────────────────┐
│                 ITER PACKAGE — 2 KIỂU CHUẨN                  │
├────────────────────────────────────────────────────────────┤
│  iter.Seq[V]      = func(yield func(V) bool)                 │
│    → range trả 1 giá trị mỗi lần   (for v := range seq)       │
│  iter.Seq2[K, V]  = func(yield func(K, V) bool)               │
│    → range trả 2 giá trị mỗi lần   (for k, v := range seq2)   │
│                                                              │
│  "yield" là callback do RUNTIME cung cấp — hàm iterator gọi   │
│  yield(v) cho MỖI phần tử; yield trả false = caller đã break, │
│  iterator PHẢI dừng lại ngay (không được yield thêm)           │
└────────────────────────────────────────────────────────────┘
```

### 3.1 Advanced #1 — Custom iterator cho cây thư mục PDMS (nối tiếp ví dụ Bài 35)

```go
import "iter"

type FolderNode struct {
    Name      string
    Documents []Document
    Children  []*FolderNode
}

// AllDocuments trả về iter.Seq[Document] — duyệt TOÀN BỘ document
// trong cây (kể cả folder con) mà KHÔNG cần allocate []Document
// trung gian chứa hết mọi thứ trước
func (f *FolderNode) AllDocuments() iter.Seq[Document] {
    return func(yield func(Document) bool) {
        var walk func(n *FolderNode) bool
        walk = func(n *FolderNode) bool {
            for _, d := range n.Documents {
                if !yield(d) {
                    return false // caller break → dừng đệ quy ngay
                }
            }
            for _, child := range n.Children {
                if !walk(child) {
                    return false // propagate break lên toàn bộ cây
                }
            }
            return true
        }
        walk(f)
    }
}

// Dùng y hệt range trên slice — nhưng KHÔNG có []Document trung
// gian nào được allocate, và break dừng NGAY LẬP TỨC giữa cây
for doc := range root.AllDocuments() {
    if doc.Status == StatusRejected {
        fmt.Println("found rejected:", doc.ID)
        break // yield nhận false, walk() dừng đệ quy ngay tức khắc
    }
}
```

```
┌────────────────────────────────────────────────────────────┐
│      SO SÁNH: []Document RETURN vs iter.Seq[Document]        │
├──────────────────────────────┬───────────────────────────────┤
│  func AllDocuments() []Document│  func AllDocuments() iter.Seq  │
│  → phải duyệt HẾT cây, gom     │  → LAZY — chỉ tính tới đâu cần │
│    hết vào 1 slice TRƯỚC KHI   │    tới đó, break dừng NGAY,     │
│    caller kịp dùng phần tử đầu │    không tốn công duyệt phần    │
│    tiên                         │    còn lại của cây               │
│  → tốn memory O(n) cho slice   │  → O(1) memory phụ trội          │
│    trung gian dù caller chỉ    │    (không có slice trung gian)   │
│    cần 1-2 phần tử đầu           │                                 │
└──────────────────────────────┴───────────────────────────────┘
```

### 3.2 Advanced #2 — `iter.Seq2` cho key-value, tương thích stdlib mới

```go
// Go 1.23+ stdlib đã có sẵn iterator cho map — maps.Keys/maps.Values
// (package "maps", KHÔNG phải built-in map type)
import "maps"

statusCounts := map[DocumentStatus]int{
    StatusDraft: 5, StatusApproved: 12,
}
for status := range maps.Keys(statusCounts) {
    fmt.Println(status)
}

// Tự viết Seq2 — ví dụ trả (folder path, document) cho toàn cây
func (f *FolderNode) AllWithPath() iter.Seq2[string, Document] {
    return func(yield func(string, Document) bool) {
        var walk func(n *FolderNode, path string) bool
        walk = func(n *FolderNode, path string) bool {
            full := path + "/" + n.Name
            for _, d := range n.Documents {
                if !yield(full, d) {
                    return false
                }
            }
            for _, c := range n.Children {
                if !walk(c, full) {
                    return false
                }
            }
            return true
        }
        walk(f, "")
    }
}

for path, doc := range root.AllWithPath() {
    fmt.Printf("%s/%s\n", path, doc.ID)
}
```

### 3.3 Advanced #3 — Compose iterator kiểu "filter/map" (functional style, không cần library ngoài)

```go
// Filter — trả iterator MỚI chỉ yield phần tử thỏa điều kiện
func Filter[V any](seq iter.Seq[V], keep func(V) bool) iter.Seq[V] {
    return func(yield func(V) bool) {
        for v := range seq {
            if keep(v) {
                if !yield(v) {
                    return
                }
            }
        }
    }
}

// Map — biến đổi type, giống stream().map() của Java
func Map[V, R any](seq iter.Seq[V], fn func(V) R) iter.Seq[R] {
    return func(yield func(R) bool) {
        for v := range seq {
            if !yield(fn(v)) {
                return
            }
        }
    }
}

// Compose — chain 3 iterator, KHÔNG allocate slice trung gian nào
approvedIDs := Map(
    Filter(root.AllDocuments(), func(d Document) bool {
        return d.Status == StatusApproved
    }),
    func(d Document) string { return d.ID },
)
for id := range approvedIDs {
    fmt.Println(id)
}
```

```
┌────────────────────────────────────────────────────────────┐
│  Java Stream API              │  Go 1.23+ iter.Seq            │
├──────────────────────────────────┼──────────────────────────────┤
│  docs.stream()                  │  Filter(Map(seq, ...), ...)   │
│    .filter(d -> ...)             │  → compose bằng function call, │
│    .map(d -> d.getId())          │    không có method chaining    │
│    .collect(toList())            │    cú pháp sẵn (chưa có trong  │
│                                   │    stdlib, tự viết như trên)   │
│  Lazy evaluation (Stream)        │  Lazy evaluation (yield-based) │
│  Terminal operation trigger chạy │  range loop trigger chạy thật   │
└──────────────────────────────────┴──────────────────────────────┘
```

### 3.4 Advanced #4 — `iter.Pull` khi cần iterator "kéo" thủ công (không dùng trong range)

```go
// Hiếm dùng nhưng quan trọng khi cần dừng/tiếp tục iterator giữa
// chừng mà KHÔNG nằm trong 1 range loop liên tục (ví dụ paginate
// qua nhiều HTTP request riêng biệt, giữ trạng thái giữa các request)
next, stop := iter.Pull(root.AllDocuments())
defer stop() // LUÔN gọi stop() để giải phóng goroutine nội bộ

doc1, ok := next()
if ok {
    fmt.Println("first:", doc1.ID)
}
doc2, ok := next()
if ok {
    fmt.Println("second:", doc2.ID)
}
// iter.Pull chạy iterator function trên 1 goroutine riêng, dùng
// channel để "kéo" từng giá trị — cost cao hơn range trực tiếp,
// chỉ dùng khi thực sự cần pull-based control flow
```

⚠ **Trap:** quên gọi `stop()` sau `iter.Pull` gây **goroutine leak** thật sự — vì `iter.Pull` chạy sẵn 1 goroutine chờ ở channel, không tự dọn nếu không được báo dừng. Đây là ví dụ nối tiếp trực tiếp phần "goroutine leak" đã nói ở Bài 3 mục 5.1.

---

## 4. Tổng kết Bài 37

```
┌─────────────────────────────────────────────────────────┐
│                   KEY TAKEAWAYS                          │
├─────────────────────────────────────────────────────────┤
│  ✅ string Go = UTF-8 byte sequence immutable — len() đếm │
│     byte, không đếm ký tự. Index/slice theo byte có thể   │
│     cắt đứt giữa ký tự multi-byte (tiếng Việt, CJK, emoji)│
│  ✅ range string trả (byte offset, rune) — không phải      │
│     (index tuần tự, char)                                 │
│  ✅ strings.Builder cho concatenation O(n) thay vì O(n²)   │
│  ✅ Go không có enum native — pattern chuẩn: iota + type   │
│     riêng + Stringer + Valid() + MarshalJSON tường minh    │
│  ✅ Bit flag enum dùng iota << N cho permission/feature flag│
│  ✅ Linter `exhaustive` giả lập sealed-enum check của Java  │
│  ✅ Go 1.23+ range-over-func (iter.Seq/Seq2): iterator lazy,│
│     break dừng ngay, không allocate slice trung gian        │
│  ✅ Compose Filter/Map trên iterator = functional style     │
│     không cần library ngoài, nhưng phải tự viết chaining     │
│  ✅ iter.Pull chạy goroutine riêng — PHẢI gọi stop() để       │
│     tránh goroutine leak                                     │
└─────────────────────────────────────────────────────────┘
```

**Hoàn thành Nhóm 1 (Cú pháp nền tảng):** Bài 34 → 35 → 36 (Scheduler, bonus) → 37. Toàn bộ 14 gap ban đầu từ gobyexample.com đã được cover, cộng thêm 1 bài deep-dive scheduler không có trong list gốc.

**Liên quan trong vault:** [[Bai-34-Constants-Control-Flow-Arrays|Bài 34]] · [[Bai-35-Functions-Deep-Dive|Bài 35]] · [[Bai-2-Syntax-Types-Structs|Bài 2]] (Slices, Maps) · [[Bai-6-Interfaces-Generics|Bài 6]] (Generics dùng trong Filter/Map ở mục 3.3)

---

**Bài tập:**
1. Viết `SanitizeDisplayName(s string, maxRunes int) string` xử lý đúng UTF-8: trim whitespace, truncate an toàn theo rune, loại bỏ control character — test với tên có dấu tiếng Việt và ít nhất 1 emoji
2. Định nghĩa `DocumentPriority` bit-flag enum (`Urgent`, `NeedsLegalReview`, `NeedsManagerApproval`, `CustomerFacing`) và viết hàm `RoutingRule(p DocumentPriority) []string` trả danh sách team cần route dựa trên tổ hợp flag
3. Viết iterator `iter.Seq2[int, Document]` trả (độ sâu trong cây, document) cho `FolderNode`, dùng để in ra document kèm thụt lề theo độ sâu
4. Benchmark (`go test -bench`) so sánh `string +=` vs `strings.Builder` với 10.000 lần ghép — verify độ chênh lệch O(n²) vs O(n) bằng số liệu thật

---
*Tags: #go #strings #runes #enum #iota #iterators #range-over-func #zero-to-hero #foundation*
