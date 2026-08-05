---
type: course
domain: languages/go
status: active
created: 2026-08-05
updated: 2026-08-05
tags: []
---

# Bài 34: Constants, Control Flow & Arrays — Nền Tảng Hay Bị Bỏ Qua

> **Mục tiêu:** Đây là nhóm khái niệm tưởng "quá cơ bản để viết riêng một bài", nhưng chính vì bị coi nhẹ mà dev Java/Spring chuyển sang Go hay dính bug từ `iota`, từ switch **không fallthrough** (ngược hẳn Java!), và từ array copy-by-value. Bài này lấp khoảng trống đó — so sánh trực tiếp với Java như các bài trước.
>
> **Level:** Foundation (nên đọc trước Bài 2, dù được viết sau)

---

## 0. Vì sao cần viết riêng?

```
┌──────────────────────────────────────────────────────────┐
│  GIẢ ĐỊNH SAI CỦA DEV JAVA        │  THỰC TẾ TRONG GO       │
├────────────────────────────────────┼─────────────────────┤
│ "const" giống Java final           │ const là COMPILE-TIME, │
│                                     │ untyped, khác hẳn cơ   │
│                                     │ chế final runtime      │
│ switch có fallthrough như Java/C  │ Go switch KHÔNG         │
│                                     │ fallthrough mặc định    │
│ Array = List/ArrayList             │ Array là value type,    │
│                                     │ copy toàn bộ khi gán    │
│ for/while/do-while ba loại riêng  │ Go chỉ có DUY NHẤT `for`│
└────────────────────────────────────┴─────────────────────┘
```

---

## 1. Constants — Không chỉ là "final" của Java

### 1.1 Typed vs Untyped constant

```go
const MaxRetries = 3          // untyped constant — linh hoạt kiểu
const Timeout time.Duration = 5 * time.Second  // typed constant

var x int32 = 10
var y int64 = 20
// x + MaxRetries hoạt động với CẢ int32 và int64 vì MaxRetries untyped
fmt.Println(x + MaxRetries) // OK
fmt.Println(y + MaxRetries) // OK — cùng 1 hằng số, không cần ép kiểu
```

```
┌───────────────────────────────────────────────────────────┐
│              UNTYPED CONSTANT — "KIỂU LINH HOẠT"            │
│                                                             │
│   const MaxRetries = 3                                     │
│              │                                             │
│              ▼  compiler tự suy kiểu tại nơi SỬ DỤNG        │
│   ┌─────────┐  ┌─────────┐  ┌─────────┐                    │
│   │ int32   │  │ int64   │  │ float64 │                    │
│   │ context │  │ context │  │ context │                    │
│   └─────────┘  └─────────┘  └─────────┘                    │
│                                                             │
│   Khác Java: final int MAX = 3 luôn cố định là int,         │
│   muốn dùng ở long context phải ép kiểu (long) MAX          │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 `iota` — bộ đếm compile-time, dùng thay cho enum

Ví dụ gắn với domain PDMS — trạng thái vòng đời hồ sơ:

```go
type DocumentStatus int

const (
    StatusDraft DocumentStatus = iota // 0
    StatusPendingReview               // 1 — tự động += 1
    StatusApproved                    // 2
    StatusArchived                    // 3
)
```

```
┌─────────────────────────────────────────────────────────┐
│                  IOTA TRONG const BLOCK                  │
├───────────────────────────┬───────────────────────────┤
│  Dòng trong block          │  Giá trị iota tương ứng    │
├───────────────────────────┼───────────────────────────┤
│  StatusDraft = iota         │  0                         │
│  StatusPendingReview        │  1 (kế thừa "= iota" ngầm) │
│  StatusApproved             │  2                         │
│  StatusArchived             │  3                         │
└───────────────────────────┴───────────────────────────┘
iota reset về 0 ở MỖI const block mới — không phải biến toàn cục.
```

⚠ **Trap:** `iota` chỉ tăng theo **dòng**, không theo giá trị gán. Skip dòng bằng `_` nếu cần bỏ một giá trị (ví dụ giữ chỗ cho `StatusRejected` sau này mà không đổi số của các status phía sau).

### 1.3 Constant compile-time evaluation

```go
const KB = 1 << 10        // 1024, tính tại compile-time, không tốn cost runtime
const MB = KB * 1024
// So với Java: static final int KB = 1 << 10 vẫn phải qua constant
// folding của javac — Go đảm bảo điều này ở mức spec ngôn ngữ,
// không phụ thuộc optimization level của compiler
```

---

## 2. For — Duy nhất một loại vòng lặp

Go không có `while` hay `do-while` riêng — tất cả đều là `for`:

```go
// Dạng 1: classic 3-phần (giống Java for)
for i := 0; i < 10; i++ {
    fmt.Println(i)
}

// Dạng 2: chỉ có điều kiện — thay thế "while" của Java
count := 0
for count < 5 {
    count++
}

// Dạng 3: vô hạn — thay thế "while(true)"
for {
    if shouldStop() {
        break
    }
}

// Dạng 4: range — duyệt collection (chi tiết ở Bài 35)
for i, v := range []string{"a", "b"} {
    fmt.Println(i, v)
}
```

```
┌────────────────────────────────────────────────────┐
│  Java            │  Go tương đương                  │
├───────────────────┼──────────────────────────────────┤
│  for(;;)          │  for i := 0; i < n; i++ { }       │
│  while(cond)      │  for cond { }                     │
│  do { } while()    │  không có — mô phỏng bằng for{}   │
│                    │  + break ở cuối thân vòng lặp     │
│  for(T x : list)  │  for _, x := range list { }        │
└───────────────────┴──────────────────────────────────┘
```

---

## 3. If/Else — Không ngoặc, có init statement

```go
// Không cần ngoặc quanh điều kiện (khác Java bắt buộc có "()")
if x > 0 {
    fmt.Println("positive")
} else if x < 0 {
    fmt.Println("negative")
} else {
    fmt.Println("zero")
}

// Init statement — biến chỉ scope trong if/else, RẤT hay dùng
// với error handling (xem thêm Bài 4 — Error, defer, panic)
if doc, err := fetchDocument(id); err != nil {
    log.Printf("fetch failed: %v", err)
} else {
    process(doc) // doc chỉ tồn tại trong nhánh này
}
// doc và err KHÔNG tồn tại ở đây nữa — khác Java nơi biến khai báo
// trước if vẫn sống sau khối if/else
```

⚠ Go **không có toán tử ternary** (`cond ? a : b`). Muốn viết ngắn gọn phải dùng if/else đầy đủ hoặc một hàm helper — đây là lựa chọn thiết kế có chủ đích của Go team để tránh nested ternary khó đọc.

---

## 4. Switch — Trap lớn nhất cho dev Java: KHÔNG fallthrough

```go
switch docType {
case "invoice":
    handleInvoice()
case "contract":
    handleContract()
default:
    handleGeneric()
}
// Mỗi case tự động break — KHÔNG rơi xuống case tiếp theo
// Java/C: quên "break" là bug kinh điển. Go: ngược lại,
// muốn fallthrough phải viết TƯỜNG MINH bằng từ khoá `fallthrough`
```

```
┌──────────────────────────────────────────────────────────┐
│  JAVA switch                │  GO switch                  │
├──────────────────────────────┼──────────────────────────────┤
│  Mặc định: fallthrough        │  Mặc định: KHÔNG fallthrough│
│  Phải viết break để dừng      │  Phải viết `fallthrough` để  │
│                                │  cố tình rơi xuống case sau  │
│  Quên break = bug phổ biến    │  An toàn hơn theo mặc định   │
└──────────────────────────────┴──────────────────────────────┘
```

### 4.1 Switch không điều kiện — thay thế if/else chain dài

```go
switch {
case priority > 90:
    return "critical"
case priority > 50:
    return "normal"
default:
    return "low"
}
```

### 4.2 Type switch — dùng với interface (liên quan Bài 6)

```go
func describe(v any) string {
    switch val := v.(type) {
    case DocumentStatus:
        return fmt.Sprintf("status: %d", val)
    case string:
        return "text: " + val
    case nil:
        return "empty"
    default:
        return "unknown type"
    }
}
```

---

## 5. Arrays — Value type, KHÁC hoàn toàn Java array

Đây là trap nguy hiểm nhất trong bài — vì cú pháp `[N]T` trông giống mảng Java/C nhưng **semantics hoàn toàn khác**.

```go
// Array — kích thước là 1 phần của TYPE, cố định tại compile-time
var checksum [32]byte // ví dụ: SHA256 checksum của 1 file hồ sơ PDMS

a := [3]int{1, 2, 3}
b := a        // COPY TOÀN BỘ mảng, không phải reference!
b[0] = 100
fmt.Println(a[0]) // vẫn là 1 — a không đổi

func modify(arr [3]int) {
    arr[0] = 999 // chỉ sửa bản copy được truyền vào
}
modify(a)
fmt.Println(a[0]) // vẫn là 1
```

```
┌────────────────────────────────────────────────────────────┐
│         JAVA: int[] LUÔN LÀ REFERENCE (giống object)         │
│                                                               │
│   int[] a = {1,2,3};                                          │
│   int[] b = a;        b ──┐                                   │
│                            ▼                                  │
│                     ┌───┬───┬───┐                              │
│                a ──►│ 1 │ 2 │ 3 │   ← CÙNG 1 mảng trên heap    │
│                     └───┴───┴───┘                              │
│   b[0] = 100  →  a[0] cũng đổi thành 100!                      │
├────────────────────────────────────────────────────────────┤
│         GO: [N]T LÀ VALUE TYPE (giống struct/int)             │
│                                                               │
│   a := [3]int{1,2,3}   ┌───┬───┬───┐                           │
│                    a──►│ 1 │ 2 │ 3 │                            │
│                        └───┴───┴───┘                            │
│   b := a          COPY TOÀN BỘ                                 │
│                    b──►│ 1 │ 2 │ 3 │  ← mảng RIÊNG BIỆT         │
│                        └───┴───┴───┘                            │
│   b[0] = 100  →  a[0] VẪN LÀ 1                                 │
└────────────────────────────────────────────────────────────┘
```

⚠ **Vì sao PDMS code gần như luôn dùng slice `[]T` chứ không dùng array `[N]T`:** slice có con trỏ tới underlying array (xem lại slice header ở Bài 2) nên truyền qua function không copy toàn bộ dữ liệu. Array chỉ nên dùng khi kích thước thật sự cố định và nhỏ về mặt ngữ nghĩa — ví dụ `[32]byte` cho SHA256 checksum, `[4]byte` cho IPv4 — nơi "cố định kích thước + value semantics" chính là điều mình muốn (so sánh checksum bằng `==` trực tiếp được, vì array hỗ trợ so sánh bằng `==` còn slice thì không).

```go
c1 := sha256.Sum256(data1) // trả về [32]byte
c2 := sha256.Sum256(data2)
if c1 == c2 { // so sánh trực tiếp được vì là array, không phải slice!
    fmt.Println("checksums match")
}
```

---

## 6. Tổng kết Bài 34

```
┌─────────────────────────────────────────────────────────┐
│                   KEY TAKEAWAYS                          │
├─────────────────────────────────────────────────────────┤
│  ✅ const untyped linh hoạt hơn Java final, tính tại      │
│     compile-time                                          │
│  ✅ iota = bộ đếm theo dòng trong const block, dùng thay  │
│     cho enum (reset về 0 mỗi block mới)                   │
│  ✅ for là loop DUY NHẤT — 4 dạng thay cho while/do-while  │
│  ✅ if/else không ngoặc, có init statement scope riêng,    │
│     KHÔNG có ternary operator                              │
│  ✅ switch KHÔNG fallthrough mặc định — ngược Java/C        │
│  ✅ [N]T là value type, copy toàn bộ khi gán/truyền —       │
│     khác hẳn Java array (luôn reference). Dùng slice cho   │
│     hầu hết trường hợp, array cho fixed-size value data     │
│     (checksum, hash) cần so sánh bằng ==                    │
└─────────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** Bài 35 — Functions Sâu Hơn (Multiple Return Values, Variadic Functions, Closures, Recursion, Range over Built-in Types)

---

**Bài tập:**
1. Viết `const` block dùng `iota` cho `DocumentPriority` (Low, Medium, High, Critical) và một hàm nhận `switch` không điều kiện để map priority sang SLA (số giờ xử lý)
2. Viết function nhận `[16]byte` (giả lập UUID dạng array) bằng value và thử sửa nó bên trong function — verify caller không bị ảnh hưởng bằng test
3. Viết type switch xử lý 3 loại document event (`UploadedEvent`, `ApprovedEvent`, `ArchivedEvent`) implement chung 1 interface `DocumentEvent`

---
*Tags: #go #constants #control-flow #arrays #switch #zero-to-hero #foundation*
