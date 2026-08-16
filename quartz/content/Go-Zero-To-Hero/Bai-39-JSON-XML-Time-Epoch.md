---
type: course
domain: languages/go
status: active
created: 2026-08-17
updated: 2026-08-17
tags: []
---

# Bài 39: JSON, XML, Time & Epoch — Nhóm 4 Phần 2

> **Mục tiêu:** Serialization (JSON/XML) và xử lý thời gian là 2 nguồn bug production phổ biến nhất trong hệ thống banking — sai timezone gây lệch SLA, thiếu `omitempty` làm vỡ contract API, streaming JSON sai cách gây OOM khi document lớn. Bài này tập trung vào **cách làm đúng trong production**, không chỉ cú pháp cơ bản.
>
> **Level:** Foundation → Intermediate (đọc sau Bài 38)

---

## 1. JSON — Struct Tags & Streaming

### 1.1 Struct tags đầy đủ

```go
type DocumentDTO struct {
    ID          string     `json:"id"`
    InternalRef string     `json:"-"`                    // KHÔNG BAO GIỜ serialize — dùng cho field nội bộ
    Note        string     `json:"note,omitempty"`        // bỏ qua nếu là zero value ("")
    Metadata    Metadata   `json:"metadata"`
    Amount      *float64   `json:"amount,omitempty"`      // con trỏ — phân biệt "0" với "không có field"
    Tags        []string   `json:"tags,omitempty"`
    Address                                                // embedded struct — field của Address "trồi" lên cấp DocumentDTO
}
```

```
┌────────────────────────────────────────────────────────────┐
│  ⚠ TRAP: `Amount float64 json:"amount,omitempty"`            │
│  → omitempty với float64 VALUE (không phải pointer) bỏ qua   │
│  field khi Amount == 0 — NHƯNG "0" và "không có giá trị"     │
│  là 2 Ý NGHĨA HOÀN TOÀN KHÁC NHAU trong banking (số tiền     │
│  = 0 đồng khác với "chưa nhập số tiền"). Dùng *float64 để    │
│  phân biệt nil (chưa có) với &0.0 (có, bằng 0)                │
└────────────────────────────────────────────────────────────┘
```

### 1.2 Advanced #1 — `json.RawMessage` khi cần "hoãn parse" một phần payload

```go
// Webhook nhận nhiều loại event khác nhau, "payload" có schema khác
// nhau tuỳ "event_type" — KHÔNG thể định nghĩa 1 struct cố định
type WebhookEvent struct {
    EventType string          `json:"event_type"`
    Payload   json.RawMessage `json:"payload"` // giữ nguyên bytes, parse SAU
}

var evt WebhookEvent
json.Unmarshal(data, &evt)

switch evt.EventType {
case "document.approved":
    var p ApprovedPayload
    json.Unmarshal(evt.Payload, &p) // parse LẦN 2, đúng type theo event_type
case "document.rejected":
    var p RejectedPayload
    json.Unmarshal(evt.Payload, &p)
}
```

### 1.3 Advanced #2 — Streaming Decoder cho document lớn (tránh OOM)

```go
// ❌ Load TOÀN BỘ file vào memory trước khi parse — nguy hiểm với
// document metadata export hàng trăm MB (batch export nhiều hồ sơ)
data, _ := os.ReadFile("large-export.json")
var docs []Document
json.Unmarshal(data, &docs) // peak memory = file size + parsed struct size

// ✅ Decoder đọc streaming, xử lý từng object mà không load hết vào RAM
f, _ := os.Open("large-export.json")
defer f.Close()
dec := json.NewDecoder(f)

dec.Token() // đọc '[' mở đầu mảng
for dec.More() {
    var doc Document
    if err := dec.Decode(&doc); err != nil {
        log.Printf("skip malformed record: %v", err)
        continue
    }
    process(doc) // xử lý từng document, giải phóng ngay sau khi dùng
}
```

### 1.4 Advanced #3 — Custom Marshal cho nested time/money type (nối tiếp pattern enum ở Bài 37)

```go
type Money struct {
    CentAmount int64  // lưu bằng cent, TRÁNH float cho tiền tệ (rounding error)
    Currency   string
}

func (m Money) MarshalJSON() ([]byte, error) {
    return json.Marshal(struct {
        Amount   string `json:"amount"`   // trả string để client không mất precision
        Currency string `json:"currency"`
    }{
        Amount:   strconv.FormatFloat(float64(m.CentAmount)/100, 'f', 2, 64),
        Currency: m.Currency,
    })
}
```

⚠ **Vì sao không dùng `float64` cho tiền:** `0.1 + 0.2 != 0.3` trong IEEE 754 — sai số tích luỹ qua hàng triệu giao dịch là lỗi nghiêm trọng trong banking. Luôn lưu tiền bằng số nguyên (cent/xu) hoặc `decimal` library (`shopspring/decimal`), không bao giờ `float64` cho amount thật.

---

## 2. XML — Vẫn Cần Trong Banking (SWIFT/ISO 20022)

JSON thống trị API hiện đại, nhưng tích hợp core banking, SWIFT MT/MX message, ISO 20022 vẫn dùng XML rộng rãi.

```go
type SwiftMessage struct {
    XMLName   xml.Name `xml:"Document"`
    MsgID     string   `xml:"GrpHdr>MsgId"`        // nested path bằng ">"
    Amount    float64  `xml:"Amt,attr"`             // đọc từ ATTRIBUTE, không phải element
    Reference string   `xml:"Ref,omitempty"`
    RawBody   string   `xml:",innerxml"`            // giữ nguyên XML con chưa parse — hữu ích khi chỉ cần vài field, phần còn lại forward nguyên trạng
}

var msg SwiftMessage
xml.Unmarshal(data, &msg)
```

```
┌────────────────────────────────────────────────────────────┐
│  JSON tag       │  XML tag tương đương                       │
├───────────────────┼───────────────────────────────────────────┤
│  json:"field"     │  xml:"field"          → element            │
│  (không có)        │  xml:"field,attr"     → XML attribute       │
│  json:"a.b"(ko có) │  xml:"a>b"            → nested path         │
│  json:"-"          │  xml:"-"              → bỏ qua               │
└───────────────────┴───────────────────────────────────────────┘
```

---

## 3. `time` — Reference Time & Timezone (nguồn bug #1 trong banking)

### 3.1 Reference time — cú pháp Go KHÔNG giống bất kỳ ngôn ngữ nào khác

```go
// Go dùng 1 THỜI ĐIỂM CỤ THỂ làm layout, KHÔNG dùng ký hiệu như yyyy-MM-dd
// Ghi nhớ bằng số thứ tự: 01/02 03:04:05 PM '06 -0700
//                          tháng/ngày giờ:phút:giây  năm  timezone
const referenceLayout = "2006-01-02 15:04:05 -0700"

t, err := time.Parse("2006-01-02", "2026-08-17")
formatted := t.Format("02/01/2006") // "17/08/2026" — format kiểu VN
```

```
┌────────────────────────────────────────────────────────────┐
│  Java: SimpleDateFormat("yyyy-MM-dd")  ← ký hiệu chữ cái      │
│  Go:   "2006-01-02"                     ← THỜI ĐIỂM THẬT       │
│                                                              │
│  Ghi nhớ: 1=tháng(Jan/01), 2=ngày(02), 3=giờ 12h(03),         │
│  4=phút(04), 5=giây(05), 6=năm(06/2006), 7=timezone(-0700)     │
│  Đây LUÔN LÀ THỨ TỰ 1-2-3-4-5-6-7, học thuộc 1 lần dùng mãi   │
└────────────────────────────────────────────────────────────┘
```

⚠ **Trap:** viết sai layout (ví dụ gõ nhầm `2016` thay vì `2006`) KHÔNG gây lỗi compile hay panic — `Format`/`Parse` chỉ trả kết quả sai lặng lẽ hoặc `err` khó hiểu. Luôn dùng constant có sẵn khi có thể:

```go
time.RFC3339       // "2006-01-02T15:04:05Z07:00" — chuẩn cho API JSON
time.RFC3339Nano   // kèm nanosecond — dùng cho audit log cần độ chính xác cao
time.DateOnly      // "2006-01-02" (Go 1.20+)
time.TimeOnly      // "15:04:05" (Go 1.20+)
```

### 3.2 Advanced #1 — Timezone: `time.Now()` không đủ, phải tường minh location

```go
// ❌ time.Now() dùng LOCAL timezone của MÁY CHẠY SERVER — khác nhau
// giữa dev laptop (giờ VN), CI runner (UTC), production pod (tuỳ config)
deadline := time.Now().Add(24 * time.Hour) // "24h nữa" theo timezone NÀO?

// ✅ Luôn tường minh location cho business logic (SLA, deadline)
loc, err := time.LoadLocation("Asia/Ho_Chi_Minh")
now := time.Now().In(loc)
deadline := now.Add(24 * time.Hour)

// ✅✅ Lưu trữ/so sánh internal LUÔN dùng UTC, chỉ convert sang local
// KHI HIỂN THỊ cho người dùng — tránh nhầm lẫn khi service chạy ở
// nhiều region hoặc DB lưu timestamp không rõ timezone
storedAt := time.Now().UTC()
```

### 3.3 Advanced #2 — So sánh `time.Time` — KHÔNG dùng `==`

```go
t1 := time.Now()
t2, _ := time.Parse(time.RFC3339, t1.Format(time.RFC3339))

t1 == t2        // ⚠ có thể FALSE dù cùng thời điểm — time.Time chứa
                // monotonic clock reading + wall clock + location,
                // struct so sánh field-by-field có thể lệch dù cùng instant

t1.Equal(t2)    // ✅ ĐÚNG — so sánh đúng thời điểm, bỏ qua khác biệt location/monotonic
```

```
┌────────────────────────────────────────────────────────────┐
│  time.Time chứa 3 phần: wall clock, monotonic clock reading, │
│  location pointer. Sau khi Marshal/Unmarshal (qua JSON, DB), │
│  monotonic reading bị "strip" — 2 time.Time cùng 1 khoảnh     │
│  khắc có thể có representation nội bộ khác nhau → == sai      │
│  → LUÔN dùng .Equal(), .Before(), .After() — KHÔNG BAO GIỜ ==  │
└────────────────────────────────────────────────────────────┘
```

---

## 4. Epoch — Unix Timestamp

```go
now := time.Now()
now.Unix()       // int64 — giây từ 1970-01-01 UTC
now.UnixMilli()  // Go 1.17+ — mili giây, hay dùng khi tích hợp JS/frontend
now.UnixNano()   // nano giây — CẨN THẬN: int64 overflow sau năm ~2262

// Convert ngược từ epoch
t := time.Unix(1755400000, 0)        // từ giây
t2 := time.UnixMilli(1755400000123)  // từ mili giây
```

⚠ **Trap tích hợp hệ thống cũ:** một số core banking legacy lưu epoch bằng **giây**, hệ thống mới (JS-based) mặc định dùng **mili giây** — nhầm đơn vị khi tích hợp cho ra timestamp sai lệch 1000 lần (năm 1970 hoặc năm 50000+). Luôn document rõ đơn vị epoch trong contract API/message Kafka.

---

## 5. Tổng kết Bài 39

```
┌─────────────────────────────────────────────────────────┐
│                   KEY TAKEAWAYS                          │
├─────────────────────────────────────────────────────────┤
│  ✅ *T + omitempty phân biệt "0/rỗng" với "không có field" │
│     — quan trọng cho field tiền tệ, số lượng trong banking │
│  ✅ json.RawMessage hoãn parse phần payload chưa biết schema│
│  ✅ json.Decoder streaming tránh OOM khi parse file/response│
│     lớn — đừng ReadFile toàn bộ rồi Unmarshal một lần        │
│  ✅ Tiền LUÔN lưu bằng số nguyên (cent) hoặc decimal lib,    │
│     KHÔNG BAO GIỜ float64 — tránh rounding error IEEE 754    │
│  ✅ XML vẫn cần cho tích hợp SWIFT/ISO 20022 — struct tag     │
│     dùng ">" cho nested path, ",attr" cho attribute            │
│  ✅ Go time layout dùng THỜI ĐIỂM THẬT (2006-01-02...), không │
│     dùng ký hiệu chữ như Java SimpleDateFormat                 │
│  ✅ Business logic (SLA, deadline) PHẢI tường minh timezone,   │
│     lưu trữ dùng UTC, chỉ convert sang local khi hiển thị       │
│  ✅ So sánh time.Time bằng .Equal(), KHÔNG BAO GIỜ dùng ==       │
│  ✅ Cẩn thận đơn vị epoch (giây vs mili giây) khi tích hợp hệ   │
│     thống khác nhau                                              │
└─────────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** Bài 40 — Random Numbers, Number Parsing, URL Parsing, SHA256, Base64 (Nhóm 4 phần 3, hoàn thành Nhóm 4)

---

**Bài tập:**
1. Viết `Money` type đầy đủ: `MarshalJSON`/`UnmarshalJSON`, `Add`/`Sub` (kiểm tra cùng `Currency` trước khi cộng), test với số tiền có phần thập phân dễ gây rounding error nếu dùng float
2. Viết function `IsWithinSLA(createdAt time.Time, slaHours int) bool` xử lý đúng timezone `Asia/Ho_Chi_Minh`, viết test chạy đúng ở CI (thường chạy UTC) lẫn máy dev (giờ VN)
3. Parse 1 đoạn XML ISO 20022 mẫu (tìm 1 ví dụ `pain.001` trên mạng) lấy ra `MsgId` và `Amount` bằng struct tag
4. Viết streaming JSON parser đọc file NDJSON (mỗi dòng 1 JSON object) xử lý từng dòng, so sánh peak memory với cách load toàn bộ rồi Unmarshal (dùng `runtime.MemStats`)

---
*Tags: #go #json #xml #time #epoch #zero-to-hero #foundation*
