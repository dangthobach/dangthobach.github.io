---
type: course
domain: languages/go
status: active
created: 2026-08-17
updated: 2026-08-17
tags: []
---

# Bài 40: Random Numbers, Number Parsing, URL, SHA256 & Base64 — Nhóm 4 Phần 3

> **Mục tiêu:** Bài cuối Nhóm 4 — nhóm "utility" hay bị coi nhẹ nhưng chứa 1 trong những lỗi bảo mật nghiêm trọng nhất: dùng nhầm `math/rand` (không an toàn crypto) cho token/OTP trong hệ thống banking. Đây là điểm quan trọng nhất bài này.
>
> **Level:** Foundation → Security-critical (đọc kỹ mục 1)

---

## 1. Random Numbers — `math/rand` vs `crypto/rand`, KHÔNG BAO GIỜ nhầm lẫn

```
┌────────────────────────────────────────────────────────────┐
│  math/rand      →  PSEUDO-random, DETERMINISTIC nếu biết seed│
│                     NHANH, dùng cho: test data, shuffle UI,   │
│                     load test, simulation — KHÔNG liên quan   │
│                     bảo mật                                   │
│  crypto/rand    →  CRYPTOGRAPHICALLY SECURE random, lấy       │
│                     entropy từ OS (/dev/urandom trên Linux)   │
│                     CHẬM HƠN nhưng BẮT BUỘC cho: token, OTP,  │
│                     session ID, API key, salt, nonce, mọi thứ  │
│                     liên quan bảo mật                          │
└────────────────────────────────────────────────────────────┘
```

```go
// ❌ NGHIÊM TRỌNG — math/rand có thể bị PREDICT nếu attacker biết
// hoặc đoán được seed (thường là thời gian khởi động service) —
// KHÔNG BAO GIỜ dùng cho OTP, token xác thực, reset password link
import "math/rand"
otp := rand.Intn(1000000) // ⚠ CVE-worthy nếu dùng cho OTP thật

// ✅ ĐÚNG — crypto/rand cho MỌI THỨ liên quan bảo mật
import "crypto/rand"
import "encoding/binary"

func secureOTP() (int, error) {
    var b [4]byte
    if _, err := rand.Read(b[:]); err != nil {
        return 0, err
    }
    n := binary.BigEndian.Uint32(b[:])
    return int(n % 1000000), nil
}

// Go 1.22+: crypto/rand có thêm rand.Text() sinh chuỗi random an toàn sẵn
token := rand.Text() // base32, độ dài cố định, dùng cho session token/API key
```

⚠ **Go 1.22+ đã tự động seed `math/rand` bằng giá trị random thật mỗi lần chạy** (trước đó `rand.Seed` mặc định = 1, khiến sequence GIỐNG HỆT NHAU mỗi lần chạy chương trình nếu quên gọi `rand.Seed(time.Now().UnixNano())`) — nhưng **điều này KHÔNG làm `math/rand` an toàn cho crypto use case**. "Random hơn theo mặc định" ≠ "an toàn về bảo mật". Quy tắc vẫn không đổi: bất kỳ giá trị nào ảnh hưởng tới xác thực/bảo mật → `crypto/rand`, không có ngoại lệ.

### 1.1 Advanced — `math/rand/v2` (Go 1.22+) cho non-crypto use case

```go
import "math/rand/v2"

n := rand.IntN(100)              // API mới, tên rõ ràng hơn Intn cũ
rand.Shuffle(len(docs), func(i, j int) { docs[i], docs[j] = docs[j], docs[i] })
// dùng cho: xáo trộn thứ tự test case, A/B test bucket assignment (không cần crypto)
```

---

## 2. Number Parsing — `strconv`

```go
i, err := strconv.Atoi("123")              // string → int, error nếu không parse được
s := strconv.Itoa(123)                      // int → string

f, err := strconv.ParseFloat("12.34", 64)   // bitSize 64 = float64
n, err := strconv.ParseInt("-123", 10, 64)  // base 10, bitSize 64 (int64)
u, err := strconv.ParseUint("123", 10, 32)  // unsigned, bitSize 32 (uint32)

formatted := strconv.FormatFloat(12.345, 'f', 2, 64) // "12.35" — 2 chữ số thập phân, làm tròn
```

### 2.1 Advanced #1 — Parse input tiền tệ từ form/API an toàn (kèm validate)

```go
func parseAmount(raw string) (int64, error) { // trả về CENT, không phải float
    raw = strings.TrimSpace(raw)
    f, err := strconv.ParseFloat(raw, 64)
    if err != nil {
        return 0, fmt.Errorf("invalid amount format: %q", raw)
    }
    if f < 0 {
        return 0, fmt.Errorf("amount cannot be negative: %v", f)
    }
    cents := int64(math.Round(f * 100)) // round TƯỜNG MINH, tránh truncate sai
    return cents, nil
}
```

### 2.2 Advanced #2 — `ParseInt` với base tự động nhận diện (0x, 0o, 0b prefix)

```go
// base = 0 → tự nhận diện: "0x1A" → hex, "0o17" → octal, "0b101" → binary
n, _ := strconv.ParseInt("0x1A", 0, 64) // 26
n2, _ := strconv.ParseInt("0o17", 0, 64) // 15
```

⚠ **Trap phổ biến:** quên check `err` của `Atoi`/`ParseFloat` khi parse input từ user — input `"abc"` không panic, chỉ trả `err != nil` và `0` — nếu bỏ qua `err`, code âm thầm coi input rác là `0`, gây sai lệch số liệu (ví dụ amount = 0 thay vì reject request).

---

## 3. URL Parsing — `net/url`

```go
u, err := url.Parse("https://pdms.vpbank.internal/api/v1/documents?status=approved&limit=20")
u.Scheme   // "https"
u.Host     // "pdms.vpbank.internal"
u.Path     // "/api/v1/documents"
u.Query().Get("status") // "approved"
```

### 3.1 Advanced #1 — Build URL an toàn (tránh injection từ string concat)

```go
// ❌ String concat — nguy hiểm nếu docID chứa ký tự đặc biệt (&, ?, #, khoảng trắng)
endpoint := "https://api.example.com/documents?id=" + docID // ⚠ injection risk

// ✅ url.Values tự encode đúng chuẩn (percent-encoding)
u, _ := url.Parse("https://api.example.com/documents")
q := u.Query()
q.Set("id", docID)          // tự động escape ký tự đặc biệt
q.Set("include", "metadata,comments")
u.RawQuery = q.Encode()
finalURL := u.String() // an toàn dù docID chứa "&" hay khoảng trắng
```

### 3.2 Advanced #2 — `url.JoinPath` (Go 1.19+) tránh trap dấu `/` thừa/thiếu

```go
// ❌ String concat dễ lỗi double-slash hoặc thiếu slash
base + "/" + "documents/" + id // "api.com//documents/D1" hoặc "api.comdocuments/D1"

// ✅ JoinPath xử lý đúng mọi trường hợp
full, err := url.JoinPath("https://api.example.com", "documents", id)
// "https://api.example.com/documents/D1" — luôn đúng dù base có/không có trailing slash
```

---

## 4. SHA256 Hashes — Checksum & Integrity

Đã dùng ví dụ `[32]byte` cho SHA256 ở Bài 34 mục 5 — giờ xem cách dùng thực tế đầy đủ:

```go
import "crypto/sha256"

func checksumFile(path string) (string, error) {
    f, err := os.Open(path)
    if err != nil {
        return "", err
    }
    defer f.Close()

    h := sha256.New()
    if _, err := io.Copy(h, f); err != nil { // streaming — KHÔNG load toàn bộ file vào RAM
        return "", err
    }
    return hex.EncodeToString(h.Sum(nil)), nil // hex string, dễ lưu DB/so sánh
}
```

```
┌────────────────────────────────────────────────────────────┐
│  io.Copy(h, f) — h là io.Writer, f là io.Reader              │
│  → hash được tính STREAMING theo từng chunk khi đọc file,     │
│  KHÔNG cần load toàn bộ file (có thể vài trăm MB - GB) vào     │
│  memory trước — quan trọng khi checksum document lớn trong PDMS│
└────────────────────────────────────────────────────────────┘
```

⚠ **SHA256 KHÔNG dùng để hash password.** SHA256 quá nhanh (tính được hàng tỷ lần/giây trên GPU) — dùng cho password cho phép brute-force hiệu quả. Password PHẢI dùng thuật toán chậm có chủ đích: `bcrypt`, `argon2`, hoặc `scrypt` (`golang.org/x/crypto/bcrypt`). SHA256 chỉ hợp lý cho: checksum file, dedupe content, HMAC signature — không phải cho credential.

```go
// ✅ Password hashing — dùng bcrypt, KHÔNG dùng sha256.Sum256 trực tiếp
import "golang.org/x/crypto/bcrypt"

hashed, _ := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
err := bcrypt.CompareHashAndPassword(hashed, []byte(inputPassword)) // nil = khớp
```

---

## 5. Base64 Encoding

```go
import "encoding/base64"

encoded := base64.StdEncoding.EncodeToString([]byte("Hồ sơ vay vốn"))
decoded, err := base64.StdEncoding.DecodeString(encoded)
```

```
┌────────────────────────────────────────────────────────────┐
│  base64.StdEncoding    →  dùng '+' và '/' — KHÔNG an toàn để  │
│                            nhét trực tiếp vào URL (cần escape) │
│  base64.URLEncoding    →  dùng '-' và '_' thay '+'/'/' — AN    │
│                            TOÀN để nhét thẳng vào URL path/query│
│  ...WithPadding(base64.NoPadding) → bỏ ký tự '=' đệm cuối,     │
│                            hay dùng cho token/id ngắn gọn hơn   │
└────────────────────────────────────────────────────────────┘
```

### 5.1 Advanced #1 — Encode file đính kèm nhỏ vào JSON payload

```go
// Trường hợp thực tế PDMS: đính kèm ảnh chữ ký nhỏ (<1MB) trực tiếp
// trong JSON request thay vì upload riêng qua multipart
type SignatureUpload struct {
    DocumentID string `json:"document_id"`
    ImageData  string `json:"image_data"` // base64 của ảnh PNG
}

imgBytes, _ := os.ReadFile("signature.png")
payload := SignatureUpload{
    DocumentID: "D1",
    ImageData:  base64.StdEncoding.EncodeToString(imgBytes),
}
```

⚠ **Trap hiệu năng:** base64 tăng kích thước dữ liệu ~33% (4 byte output cho mỗi 3 byte input) — nhúng file lớn (>vài MB) vào JSON base64 tốn băng thông + memory đáng kể so với multipart upload hoặc pre-signed URL trực tiếp lên object storage (S3/MinIO). Chỉ base64-embed cho file thực sự nhỏ.

### 5.2 Advanced #2 — URL-safe token (kết hợp `crypto/rand` + `base64.URLEncoding`)

```go
func generateURLSafeToken(byteLen int) (string, error) {
    b := make([]byte, byteLen)
    if _, err := crand.Read(b); err != nil { // crypto/rand, alias crand
        return "", err
    }
    return base64.URLEncoding.WithPadding(base64.NoPadding).EncodeToString(b), nil
}
// dùng cho: reset-password link token, invite link, API key — an toàn nhét thẳng vào URL
```

---

## 6. Tổng kết Bài 40 — Hoàn Thành Nhóm 4

```
┌─────────────────────────────────────────────────────────┐
│                   KEY TAKEAWAYS                          │
├─────────────────────────────────────────────────────────┤
│  ✅ math/rand cho non-security (test, shuffle UI) — crypto/  │
│     rand BẮT BUỘC cho OTP/token/session/API key, KHÔNG NGOẠI  │
│     LỆ, kể cả sau khi Go 1.22 auto-seed math/rand              │
│  ✅ Luôn check err của strconv.Atoi/ParseFloat — input rác     │
│     không panic, chỉ âm thầm trả 0 nếu bị bỏ qua err            │
│  ✅ url.Values.Encode() / url.JoinPath thay string concat để   │
│     tránh injection và lỗi slash thừa/thiếu                     │
│  ✅ SHA256 dùng cho checksum/dedupe (io.Copy streaming, không   │
│     load hết file vào RAM) — KHÔNG BAO GIỜ dùng cho password,   │
│     phải dùng bcrypt/argon2 (chậm có chủ đích)                   │
│  ✅ base64.URLEncoding (không phải StdEncoding) khi nhét vào     │
│     URL; base64 tốn thêm ~33% kích thước — chỉ embed file nhỏ    │
└─────────────────────────────────────────────────────────┘
```

**Nhóm 4 hoàn thành: Bài 38 → 39 → 40** (Sorting đã có sẵn ở [[Bai-32-Data-Structures-Algorithms|Bài 32]], không lặp lại).

**Liên quan trong vault:** [[Bai-34-Constants-Control-Flow-Arrays|Bài 34]] (checksum `[32]byte` ban đầu) · [[Bai-19|Bài 19]] (structured logging, liên quan mục 2.3 Bài 38)

---

**Bài tập:**
1. Viết `GenerateOTP()` dùng `crypto/rand` đúng chuẩn, viết test đảm bảo phân phối đều (không bias) qua nhiều lần gọi
2. Refactor 1 đoạn code thật trong PDMS đang dùng string concat build URL sang `url.Values`/`url.JoinPath`
3. Viết `VerifyFileIntegrity(path, expectedSHA256 string) (bool, error)` dùng streaming `io.Copy`, test với file vài trăm MB, đo memory bằng `runtime.MemStats` so với cách đọc hết file vào `[]byte` trước
4. So sánh thời gian hash bcrypt (cost=10) vs sha256.Sum256 cho cùng 1 password bằng benchmark — quan sát chênh lệch hàng nghìn lần, giải thích vì sao đó chính là điểm mạnh bảo mật của bcrypt

---
*Tags: #go #random #crypto #strconv #url #sha256 #base64 #security #zero-to-hero*
