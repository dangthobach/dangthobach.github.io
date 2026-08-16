---
type: course
domain: languages/go
status: active
created: 2026-08-16
updated: 2026-08-16
tags: []
---

# Bài 35: Functions Sâu Hơn — Multiple Returns, Variadic, Closures, Recursion, Range

> **Mục tiêu:** Function trong Go trông đơn giản nhưng có 5 cơ chế mà dev Java hay hiểu sai vì áp đặt mental model cũ: closure bắt biến **theo tham chiếu** chứ không phải theo giá trị tại thời điểm gọi, `range` copy value chứ không cho reference, và multiple return values chính là lý do error-handling của Go trông khác hẳn exception của Java.
>
> **Level:** Foundation (đọc sau Bài 34, trước Bài 2 nếu đọc theo thứ tự logic dependency)

---

## 1. Multiple Return Values — Xương sống của Error Handling

Java trả nhiều giá trị phải bọc trong object/`Map`/`Optional` hoặc dùng exception cho lỗi. Go trả trực tiếp nhiều giá trị — không cần allocate wrapper:

```go
func fetchDocument(id string) (*Document, error) {
    doc, err := db.QueryDocument(id)
    if err != nil {
        return nil, fmt.Errorf("fetch document %s: %w", id, err)
    }
    return doc, nil
}

// Caller — pattern lặp lại xuyên suốt toàn bộ codebase Go
doc, err := fetchDocument("doc-123")
if err != nil {
    log.Printf("error: %v", err)
    return
}
```

```
┌──────────────────────────────────────────────────────────┐
│  JAVA                          │  GO                      │
├──────────────────────────────────┼──────────────────────────┤
│  T result = fn();               │  result, err := fn()      │
│  → throw nếu lỗi (control flow  │  → err là GIÁ TRỊ, kiểm   │
│    "nhảy" ra khỏi luồng code)   │    tra tường minh tại chỗ  │
│  Cần try/catch hoặc Optional<T> │  Không cần wrapper type    │
│    để biểu diễn "có thể vắng"   │    riêng cho multi-return   │
└──────────────────────────────────┴──────────────────────────┘
```

### 1.1 Named Return Values — cú pháp ít dùng nhưng cần hiểu

```go
func divide(a, b float64) (result float64, err error) {
    if b == 0 {
        err = errors.New("division by zero")
        return // "naked return" — trả về result, err hiện tại
    }
    result = a / b
    return
}
```

⚠ **Trap:** naked return dễ đọc nhầm khi function dài — hầu hết style guide Go (kể cả Google Go Style Guide) khuyến nghị chỉ dùng cho function ngắn, và luôn return tường minh (`return result, err`) khi function vượt quá ~10-15 dòng.

---

## 2. Variadic Functions — `...T` thực chất là Slice

```go
func Sum(nums ...int) int {
    total := 0
    for _, n := range nums {
        total += n
    }
    return total
}

Sum(1, 2, 3)       // nums = []int{1, 2, 3}
Sum()               // nums = nil (không phải []int{})

// Spread một slice có sẵn vào variadic param bằng "..."
scores := []int{10, 20, 30}
Sum(scores...)      // KHÔNG copy — truyền thẳng slice header
```

```
┌────────────────────────────────────────────────────────────┐
│         VARIADIC PARAM = SYNTACTIC SUGAR CHO []T             │
│                                                              │
│  func Sum(nums ...int) int { ... }                          │
│                    │                                         │
│                    ▼  compiler biên dịch giống hệt           │
│  func Sum(nums []int) int { ... }                            │
│                                                              │
│  Khác biệt DUY NHẤT: caller được viết Sum(1,2,3) thay vì     │
│  Sum([]int{1,2,3}) — compiler tự gói các argument rời rạc     │
│  thành slice tại call site                                    │
└────────────────────────────────────────────────────────────┘
```

⚠ **Trap hiệu năng:** mỗi lần gọi `Sum(1, 2, 3)` (không spread sẵn slice), Go phải **allocate một slice mới trên heap hoặc stack** để gói các argument — gọi variadic function trong hot path (ví dụ log function gọi hàng triệu lần/giây trong pipeline xử lý document) có cost khác `Sum(scores...)` khi `scores` đã tồn tại sẵn. So sánh với Java: `varargs` (`int... nums`) có **đúng chi phí allocation tương tự** — Java compiler cũng tạo array mới tại call site, nên đây không phải điểm yếu riêng của Go mà là chi phí chung của mọi ngôn ngữ hỗ trợ variadic qua array/slice.

```go
// Pattern hay dùng trong PDMS: structured logging
func LogEvent(msg string, fields ...Field) {
    // fields được gói thành []Field mỗi lần gọi
}
LogEvent("document approved", F("doc_id", id), F("user", userID))
```

---

## 3. Closures — Bắt biến theo THAM CHIẾU, không phải theo GIÁ TRỊ

Đây là khái niệm gây bug nhiều nhất trong nhóm 5 topic của bài này.

```go
func counter() func() int {
    count := 0
    return func() int {
        count++     // closure "đóng" (close over) biến count
        return count
    }
}

c := counter()
fmt.Println(c()) // 1
fmt.Println(c()) // 2 — count VẪN SỐNG giữa các lần gọi
```

```
┌────────────────────────────────────────────────────────────┐
│              CLOSURE — BIẾN "THOÁT" LÊN HEAP                 │
│                                                              │
│  counter() được gọi → biến "count" LẼ RA chết khi function   │
│  return (nếu là biến local bình thường)                       │
│                                                              │
│  Nhưng compiler PHÁT HIỆN closure bên trong tham chiếu tới    │
│  "count" → escape analysis quyết định allocate "count" lên   │
│  HEAP thay vì stack (xem lại escape analysis ở Bài 23)        │
│                                                              │
│  ┌─────────────┐      ┌──────────────────────┐               │
│  │ closure func│─────►│  count (trên HEAP)    │               │
│  │  (returned) │      │  sống lâu hơn function │               │
│  └─────────────┘      │  counter() đã return   │               │
│                        └──────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

### 3.1 Trap kinh điển — Closure trong vòng lặp

Đây chính là pitfall đã nêu ngắn gọn ở Bài 3 mục 5.2 — giờ giải thích tận gốc **vì sao** nó xảy ra:

```go
// ❌ Trước Go 1.22 — TẤT CẢ closure share CÙNG MỘT biến i
funcs := make([]func(), 3)
for i := 0; i < 3; i++ {
    funcs[i] = func() { fmt.Println(i) }
}
for _, f := range funcs {
    f() // in ra 3, 3, 3 — không phải 0, 1, 2!
}
```

```
┌────────────────────────────────────────────────────────────┐
│   TRƯỚC GO 1.22 — 1 BIẾN i DÙNG CHUNG CHO CẢ 3 VÒNG LẶP       │
│                                                              │
│   i (1 ô nhớ duy nhất, cập nhật qua từng vòng)                │
│        ▲        ▲        ▲                                  │
│   funcs[0]  funcs[1]  funcs[2]   ← cả 3 đều trỏ về CÙNG i    │
│   (đều tham chiếu cùng địa chỉ, không phải copy giá trị)       │
│                                                              │
│   Khi loop kết thúc: i = 3 → cả 3 closure đều thấy i = 3      │
└────────────────────────────────────────────────────────────┘
```

**Go 1.22 (02/2024) đã sửa hành vi này ở mức ngôn ngữ** — mỗi vòng lặp `for` giờ tạo một **biến `i` MỚI** cho mỗi iteration thay vì dùng chung 1 ô nhớ:

```go
// Go 1.22+ — hành vi ĐÚNG mặc định, không cần workaround nữa
for i := 0; i < 3; i++ {
    funcs[i] = func() { fmt.Println(i) } // mỗi closure bắt i RIÊNG của iteration đó
}
// in ra 0, 1, 2 — đúng như trực giác Java dev mong đợi
```

⚠ **Vẫn cần biết workaround cũ** vì code base cũ (module `go 1.21` trở xuống trong `go.mod`) hoặc code đọc trên mạng vẫn dùng pattern truyền tham số:

```go
for i := 0; i < 3; i++ {
    i := i // shadow — tạo biến MỚI trong scope của mỗi iteration
    funcs[i] = func() { fmt.Println(i) }
}
```

**Cách kiểm tra dự án đang chạy version nào:** xem dòng `go 1.xx` trong `go.mod` — hành vi loop-variable phụ thuộc **version khai báo trong go.mod**, không phải version toolchain đang cài, vì Go compiler áp dụng semantics theo "language version" của module để tránh breaking change ngầm khi chỉ upgrade toolchain.

---

## 4. Recursion — Stack Growth khác hẳn Java

```go
// Ví dụ PDMS: đếm tổng số document trong cây thư mục hồ sơ
type FolderNode struct {
    Documents []Document
    Children  []*FolderNode
}

func countDocuments(node *FolderNode) int {
    if node == nil {
        return 0
    }
    total := len(node.Documents)
    for _, child := range node.Children {
        total += countDocuments(child) // recursive call
    }
    return total
}
```

```
┌────────────────────────────────────────────────────────────┐
│   JAVA: Stack cố định (~512KB-1MB mặc định)                  │
│   → StackOverflowError nếu đệ quy quá sâu (thường ~10.000-   │
│     50.000 frame tùy kích thước frame)                        │
│                                                              │
│   GO: Goroutine stack bắt đầu ~2KB, TỰ ĐỘNG GROW              │
│   → runtime allocate segment lớn hơn + copy stack khi cần     │
│   → giới hạn mặc định rất cao (maxstacksize ~1GB) trước khi   │
│     "goroutine stack exceeds ... limit" fatal error            │
│   → đệ quy sâu trong Go "an toàn hơn" về mặt kỹ thuật, nhưng   │
│     KHÔNG có nghĩa nên viết đệ quy không giới hạn — vẫn tốn   │
│     CPU + risk fatal error nếu input không kiểm soát           │
└────────────────────────────────────────────────────────────┘
```

⚠ **Go KHÔNG có tail-call optimization** (khác một số ngôn ngữ functional). Đệ quy đuôi (tail recursion) trong Go vẫn tốn 1 stack frame mỗi lần gọi, y hệt đệ quy thường — nếu cần xử lý cây tài liệu cực sâu (hiếm trong PDMS nhưng có thể xảy ra với cấu trúc thư mục lồng nhau nhiều cấp), nên cân nhắc chuyển sang vòng lặp + explicit stack (dùng slice làm stack) thay vì tin vào TCO không tồn tại.

---

## 5. Range over Built-in Types — Copy Value, không phải Reference

Đây là trap thứ hai gây bug nhiều nhất sau closure-in-loop, và **thực ra cùng gốc rễ**: biến vòng lặp của `range` cũng từng dùng chung 1 ô nhớ trước Go 1.22 — nhưng vấn đề "copy value" mô tả dưới đây là một cơ chế **khác**, vẫn tồn tại **cả ở Go 1.22+**.

```go
type Document struct {
    ID     string
    Status DocumentStatus
}

docs := []Document{{ID: "d1"}, {ID: "d2"}, {ID: "d3"}}

// ❌ v là BẢN COPY của từng phần tử — sửa v không sửa docs
for _, v := range docs {
    v.Status = StatusApproved // KHÔNG có tác dụng gì lên docs!
}
fmt.Println(docs[0].Status) // vẫn là StatusDraft (zero value)

// ✅ Sửa qua index để thao tác trực tiếp trên slice gốc
for i := range docs {
    docs[i].Status = StatusApproved // đúng — sửa qua index
}
```

```
┌────────────────────────────────────────────────────────────┐
│         RANGE OVER SLICE — v LÀ COPY, KHÔNG PHẢI REF          │
│                                                              │
│  docs (underlying array)                                     │
│  ┌──────┬──────┬──────┐                                      │
│  │ d1   │ d2   │ d3   │                                       │
│  └──────┴──────┴──────┘                                      │
│      │                                                        │
│      │ range copy TỪNG PHẦN TỬ vào v tại mỗi vòng lặp          │
│      ▼                                                        │
│  ┌────────┐                                                   │
│  │ v (copy)│  ← sửa v chỉ sửa bản copy tạm thời này            │
│  └────────┘                                                   │
│                                                              │
│  ⚠ Struct càng LỚN → copy mỗi vòng lặp càng tốn — dùng        │
│    range index hoặc range con trỏ (for i := range docs, hoặc  │
│    range []*Document) cho struct lớn/hay sửa                  │
└────────────────────────────────────────────────────────────┘
```

### 5.1 Bảng hành vi range theo từng type

```
┌───────────┬──────────────────────────────────────────────────┐
│  Type     │  range trả về                                    │
├───────────┼──────────────────────────────────────────────────┤
│  array/   │  index (int), value (COPY của phần tử)            │
│  slice    │                                                   │
├───────────┼──────────────────────────────────────────────────┤
│  map      │  key, value — THỨ TỰ NGẪU NHIÊN mỗi lần chạy      │
│           │  (cố ý randomize từ Go 1.0 để tránh code phụ      │
│           │  thuộc ngầm vào thứ tự lặp map)                    │
├───────────┼──────────────────────────────────────────────────┤
│  string   │  index (byte offset), value là RUNE (int32) —     │
│           │  KHÔNG phải byte — xem chi tiết ở Bài 37           │
│           │  (Strings & Runes)                                 │
├───────────┼──────────────────────────────────────────────────┤
│  channel  │  chỉ 1 giá trị (value) — lặp tới khi channel đóng  │
│           │  (đã ví dụ ở Bài 3)                                │
├───────────┼──────────────────────────────────────────────────┤
│  int      │  (Go 1.22+) range over int — for i := range 5     │
│  (1.22+)  │  lặp i = 0..4, thay cho for i:=0;i<5;i++ ngắn gọn  │
├───────────┼──────────────────────────────────────────────────┤
│  func     │  (Go 1.23+) range-over-func — iterator pattern    │
│  (1.23+)  │  mới, chi tiết đầy đủ ở Bài 37                     │
└───────────┴──────────────────────────────────────────────────┘
```

⚠ **Trap map — không được sửa map trong lúc range (thêm/xóa key):** Go spec nói rõ hành vi không xác định nếu bạn thêm key mới trong lúc đang range map đó (key có thể được duyệt hoặc không, tùy implementation). Xóa key hiện tại đang duyệt thì an toàn (Go spec đảm bảo riêng trường hợp này), nhưng thêm key mới thì không.

```go
// ⚠ Nguy hiểm — hành vi không xác định
for k := range m {
    if shouldRemove(k) {
        delete(m, k) // AN TOÀN — xóa key hiện tại được đảm bảo
    }
    if shouldAdd(k) {
        m["new-"+k] = 1 // KHÔNG AN TOÀN — thêm key mới trong lúc range
    }
}
```

---

## 6. Tổng kết Bài 35

```
┌─────────────────────────────────────────────────────────┐
│                   KEY TAKEAWAYS                          │
├─────────────────────────────────────────────────────────┤
│  ✅ Multiple return values (result, err) là nền tảng      │
│     error handling — không cần wrapper type như Java      │
│  ✅ Variadic (...T) = syntactic sugar cho []T, allocate    │
│     slice mới mỗi lần gọi trừ khi spread sẵn slice có sẵn  │
│  ✅ Closure bắt biến theo THAM CHIẾU — biến "thoát" lên    │
│     heap qua escape analysis khi bị closure giữ            │
│  ✅ Go 1.22+ đã fix loop-variable-per-iteration ở mức       │
│     ngôn ngữ — nhưng vẫn cần biết pattern shadow cũ         │
│  ✅ Goroutine stack grow tự động (~2KB → tối đa ~1GB),      │
│     nhưng Go KHÔNG có tail-call optimization                │
│  ✅ range slice/array copy VALUE — sửa qua index cho struct │
│     lớn; range map thứ tự random cố ý; range string trả     │
│     rune không phải byte                                    │
└─────────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** Bài 36 — Go Scheduler Internals (GMP Deep Dive): sysmon, preemption, work-stealing, handoff on syscall
**Sau đó:** Bài 37 — Strings/Runes, Enum Pattern & Range-over-Func Iterators (Go 1.23+)

---

**Bài tập:**
1. Viết function `retryWithBackoff(fn func() error, maxAttempts int) error` dùng closure để giữ state số lần retry giữa các lần gọi
2. Viết `BatchProcessor` variadic nhận `...ProcessorOption` (functional options pattern) — pattern rất phổ biến trong Go stdlib và các thư viện production
3. Viết `flattenTree(node *FolderNode) []Document` bằng đệ quy, sau đó viết lại bằng vòng lặp + explicit stack (slice), so sánh 2 cách
4. Tìm 1 đoạn code thật trong PDMS dùng `for _, v := range items` rồi sửa `v`, verify bug bằng test — sau đó fix bằng range index

---
*Tags: #go #functions #closures #recursion #range #variadic #zero-to-hero #foundation*
