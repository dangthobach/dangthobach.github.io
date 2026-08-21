---
type: course
domain: languages/go
status: active
created: 2026-08-22
updated: 2026-08-22
tags: []
---

# Bài 42: I/O & Filesystem — Reading, Writing, Paths, Temp Files & Embed

> **Mục tiêu:** Nhóm 5 — hoàn toàn chưa có bài riêng trong vault. Đây là nhóm kỹ năng "nhàm chán nhưng dùng hàng ngày": đọc/ghi file đúng cách (streaming vs load hết), atomic write để không làm hỏng document khi crash giữa chừng, và `//go:embed` để đóng gói template/migration SQL thẳng vào binary — rất hợp với triết lý "single binary deployment" của Go so với JAR + resources rời của Java.
>
> **Level:** Foundation → Intermediate

---

## 1. Reading Files — Load Hết vs Streaming

```go
// ── Cách 1: Load TOÀN BỘ vào memory — đơn giản, chỉ dùng cho file NHỎ ──
data, err := os.ReadFile("document.pdf")
if err != nil {
    return fmt.Errorf("read file: %w", err)
}
// data []byte chứa TOÀN BỘ nội dung — nguy hiểm nếu file vài trăm MB - GB

// ── Cách 2: Streaming — đọc theo chunk, KHÔNG load hết vào RAM ──
f, err := os.Open("document.pdf")
if err != nil {
    return err
}
defer f.Close()

buf := make([]byte, 32*1024) // 32KB buffer, tái sử dụng qua mỗi lần đọc
for {
    n, err := f.Read(buf)
    if n > 0 {
        process(buf[:n]) // xử lý CHUNK hiện tại, không giữ toàn bộ
    }
    if err == io.EOF {
        break
    }
    if err != nil {
        return err
    }
}
```

```
┌────────────────────────────────────────────────────────────┐
│  os.ReadFile          │  os.Open + Read theo chunk           │
├──────────────────────────┼───────────────────────────────────┤
│  Memory = KÍCH THƯỚC FILE│  Memory = KÍCH THƯỚC BUFFER (cố    │
│  Đơn giản, 1 dòng code    │  định, tái sử dụng — 32KB dù file  │
│                            │  1KB hay 10GB)                     │
│  Dùng cho: config file,   │  Dùng cho: upload document lớn,    │
│  file nhỏ biết trước size │  export batch, checksum (Bài 40),  │
│                            │  bất kỳ đâu KHÔNG chắc chắn size    │
└──────────────────────────┴───────────────────────────────────┘
```

### 1.1 Advanced — `bufio.Scanner` đọc theo dòng (line-by-line)

```go
f, _ := os.Open("audit-log.txt")
defer f.Close()

scanner := bufio.NewScanner(f)
scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // tăng buffer nếu có dòng RẤT dài (mặc định 64KB/dòng)
for scanner.Scan() {
    line := scanner.Text()
    processLogLine(line)
}
if err := scanner.Err(); err != nil { // ⚠ LUÔN check Err() sau vòng lặp — Scan() trả false cả khi hết file LẪN khi có lỗi thật
    return fmt.Errorf("scan error: %w", err)
}
```

⚠ **Trap hay quên:** `scanner.Scan()` trả `false` khi **hết file** (bình thường) và khi **có lỗi đọc thật sự** (bất thường) — 2 trường hợp trông giống hệt nhau trong vòng `for`. Luôn gọi `scanner.Err()` sau vòng lặp để phân biệt, nếu không code âm thầm bỏ qua lỗi đọc (ví dụ disk I/O error giữa chừng) như thể đã đọc xong bình thường.

---

## 2. Writing Files — Đơn Giản, Buffered & Atomic

```go
// ── Cách 1: Ghi 1 lần, đơn giản ──
err := os.WriteFile("output.json", data, 0644) // mode 0644 = rw-r--r--

// ── Cách 2: Append vào file có sẵn ──
f, err := os.OpenFile("audit.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
defer f.Close()
f.WriteString("event logged\n")

// ── Cách 3: Buffered write — hiệu năng cao khi ghi NHIỀU lần nhỏ ──
f, _ = os.Create("large-export.csv")
defer f.Close()
w := bufio.NewWriter(f)
defer w.Flush() // ⚠ BẮT BUỘC — bufio.Writer giữ data trong buffer, KHÔNG tự flush khi defer f.Close()
for _, row := range rows {
    fmt.Fprintf(w, "%s,%s,%d\n", row.ID, row.Status, row.Amount)
}
```

⚠ **Trap thứ tự defer:** `defer f.Close()` chạy **SAU** `defer w.Flush()` (defer chạy theo thứ tự LIFO — khai báo sau chạy trước). Nếu khai báo `defer f.Close()` **trước** `defer w.Flush()`, file sẽ bị đóng trước khi buffer kịp flush → **mất dữ liệu ở cuối file, không có lỗi báo**. Luôn khai báo theo đúng thứ tự: mở file → defer Close → tạo writer → defer Flush (để Flush chạy trước Close).

### 2.1 Advanced — Atomic Write Pattern (bảo vệ document integrity khi crash giữa chừng)

```go
// ❌ NGUY HIỂM: ghi trực tiếp đè lên file gốc — nếu process crash/mất điện
// giữa chừng, document.json bị HỎNG DỞ DANG (nửa cũ nửa mới, hoặc rỗng)
func saveBad(path string, data []byte) error {
    return os.WriteFile(path, data, 0644) // KHÔNG atomic!
}

// ✅ AN TOÀN: ghi vào file TẠM cùng thư mục, rồi os.Rename — rename trên
// CÙNG filesystem là thao tác ATOMIC ở cấp OS (không có trạng thái "nửa vời")
func saveAtomic(path string, data []byte) error {
    dir := filepath.Dir(path)
    tmp, err := os.CreateTemp(dir, ".tmp-*") // PHẢI cùng thư mục với path đích
    if err != nil {
        return err
    }
    tmpPath := tmp.Name()
    defer os.Remove(tmpPath) // dọn dẹp nếu có lỗi trước khi Rename thành công

    if _, err := tmp.Write(data); err != nil {
        tmp.Close()
        return err
    }
    if err := tmp.Sync(); err != nil { // đảm bảo data thực sự xuống disk, không chỉ ở OS page cache
        tmp.Close()
        return err
    }
    if err := tmp.Close(); err != nil {
        return err
    }
    return os.Rename(tmpPath, path) // ATOMIC — path hoặc là bản CŨ, hoặc là bản MỚI, không bao giờ nửa vời
}
```

```
┌────────────────────────────────────────────────────────────┐
│  VÌ SAO os.Rename ATOMIC nhưng ghi trực tiếp thì KHÔNG        │
│                                                              │
│  Ghi trực tiếp: OS ghi TỪNG BYTE tuần tự vào file — nếu       │
│  crash ở byte thứ 500/1000, file CHỈ CÓ 500 byte đầu           │
│                                                              │
│  Rename: chỉ đổi 1 CON TRỎ trong filesystem metadata (inode  │
│  trên Linux) trỏ tên "document.json" sang file tạm đã ghi     │
│  ĐẦY ĐỦ — đây là 1 THAO TÁC DUY NHẤT ở cấp filesystem,         │
│  không thể "nửa vời". Điều kiện: file tạm và đích PHẢI cùng    │
│  filesystem/partition (khác filesystem, Rename fallback về    │
│  copy+delete, MẤT tính atomic)                                 │
└────────────────────────────────────────────────────────────┘
```

⚠ **Vì sao PDMS cần pattern này:** ghi metadata hồ sơ hoặc file config trực tiếp mà service bị kill (deploy, OOM kill, pod restart) đúng lúc đang ghi có thể để lại file JSON hỏng dở dang — lần đọc tiếp theo parse lỗi, toàn bộ document coi như mất. Atomic write pattern đảm bảo file luôn ở 1 trong 2 trạng thái toàn vẹn: bản cũ hoặc bản mới hoàn chỉnh.

---

## 3. Line Filters — Unix Filter Pattern (stdin → transform → stdout)

```go
// Đọc từ stdin, xử lý từng dòng, ghi ra stdout — pattern Unix pipe cổ điển,
// dùng cho CLI tool nội bộ (vd: lọc log, chuẩn hoá mã hồ sơ hàng loạt)
func main() {
    scanner := bufio.NewScanner(os.Stdin)
    writer := bufio.NewWriter(os.Stdout)
    defer writer.Flush()

    for scanner.Scan() {
        line := strings.ToUpper(scanner.Text()) // transform tuỳ ý
        fmt.Fprintln(writer, line)
    }
}
// Dùng: cat doc-codes.txt | ./normalize-tool | sort | uniq
```

⚠ Cùng lý do với mục 2, **`defer writer.Flush()` bắt buộc** — chương trình CLI ngắn hạn dễ quên vì "chạy xong sẽ tự thoát" nhưng buffer chưa flush nghĩa là output bị cắt cụt trước khi kịp ghi ra thật.

---

## 4. File Paths — `path/filepath`, Xử Lý Đa Nền Tảng

```go
filepath.Join("documents", "2026", "DOC-001.pdf")
// Linux/Mac: "documents/2026/DOC-001.pdf"
// Windows:   "documents\\2026\\DOC-001.pdf"   ← TỰ ĐỘNG đúng separator theo OS

filepath.Base("/var/pdms/documents/DOC-001.pdf")  // "DOC-001.pdf"
filepath.Dir("/var/pdms/documents/DOC-001.pdf")   // "/var/pdms/documents"
filepath.Ext("DOC-001.pdf")                        // ".pdf"
filepath.Clean("documents/../documents/./DOC-001.pdf") // "documents/DOC-001.pdf" — chuẩn hoá ".." và "."

abs, _ := filepath.Abs("./config.yaml") // đường dẫn tuyệt đối từ working directory hiện tại
```

⚠ **Trap bảo mật — Path Traversal:** nếu tên file đến từ **user input** (upload filename, document ID từ URL param), **PHẢI validate/sanitize trước khi `filepath.Join`** — user gửi `"../../etc/passwd"` làm filename có thể escape khỏi thư mục dự định nếu không kiểm tra.

```go
// ⚠ NGUY HIỂM nếu userFilename không được validate
fullPath := filepath.Join(uploadDir, userFilename) // userFilename = "../../etc/passwd" → thoát khỏi uploadDir!

// ✅ Validate: đảm bảo kết quả VẪN nằm trong uploadDir sau khi Clean
func safeJoin(baseDir, userInput string) (string, error) {
    full := filepath.Join(baseDir, userInput)
    if !strings.HasPrefix(full, filepath.Clean(baseDir)+string(os.PathSeparator)) {
        return "", fmt.Errorf("path traversal detected: %q", userInput)
    }
    return full, nil
}
```

### 4.1 Advanced — `filepath.WalkDir` (Go 1.16+, thay `Walk` cũ vì nhanh hơn)

```go
err := filepath.WalkDir("./documents", func(path string, d fs.DirEntry, err error) error {
    if err != nil {
        return err // lỗi truy cập (permission denied...) — propagate lên
    }
    if d.IsDir() {
        return nil // bỏ qua thư mục, chỉ xử lý file
    }
    if filepath.Ext(path) == ".pdf" {
        fmt.Println("found document:", path)
    }
    return nil
})
```

⚠ `WalkDir` (1.16+) nhanh hơn `Walk` cũ vì dùng `fs.DirEntry` (lấy metadata từ chính lệnh đọc thư mục, không cần `os.Stat` riêng cho mỗi entry như `Walk` cũ) — luôn dùng `WalkDir` cho code mới.

---

## 5. Directories & Temporary Files/Directories

```go
os.Mkdir("documents", 0755)              // tạo 1 cấp — lỗi nếu cha chưa tồn tại
os.MkdirAll("documents/2026/08", 0755)   // tạo TOÀN BỘ cây thư mục, không lỗi nếu đã tồn tại

entries, err := os.ReadDir("documents")  // Go 1.16+ — trả []DirEntry, KHÔNG load full FileInfo (nhanh hơn ioutil.ReadDir cũ)
for _, e := range entries {
    fmt.Println(e.Name(), e.IsDir())
}
```

### 5.1 Advanced — Temp file/dir cho xử lý trung gian an toàn

```go
// Temp DIRECTORY cho batch xử lý (vd: giải nén file zip hồ sơ để validate
// từng file con trước khi import chính thức)
tmpDir, err := os.MkdirTemp("", "pdms-import-*") // "" = dùng OS default temp dir
if err != nil {
    return err
}
defer os.RemoveAll(tmpDir) // ⚠ RemoveAll (không phải Remove) vì xoá CẢ nội dung bên trong

extractZipTo(uploadedZip, tmpDir)
for _, f := range listFiles(tmpDir) {
    if err := validateDocument(f); err != nil {
        return fmt.Errorf("invalid document in batch: %w", err) // tmpDir tự dọn qua defer dù lỗi ở đâu
    }
}
```

⚠ **Vì sao dùng temp dir thay vì xử lý trực tiếp trong thư mục đích:** nếu batch import 500 document mà lỗi ở document thứ 300, xử lý trực tiếp vào thư mục thật để lại 300 file "mồ côi" phải dọn thủ công. Temp dir + `defer os.RemoveAll` đảm bảo dọn sạch tự động dù thành công hay thất bại ở bất kỳ đâu — cùng triết lý với atomic write ở mục 2.1.

---

## 6. `//go:embed` — Đóng Gói File Vào Binary (Go 1.16+)

```go
import "embed"

//go:embed templates/document_notification.html
var notificationTemplate string // embed 1 FILE trực tiếp thành string

//go:embed migrations/*.sql
var migrationFiles embed.FS // embed NHIỀU file thành virtual filesystem

//go:embed static/*
var staticAssets embed.FS
```

```
┌────────────────────────────────────────────────────────────┐
│         TRƯỚC go:embed (Go < 1.16)     │  TỪ go:embed        │
├────────────────────────────────────────┼──────────────────────┤
│  Binary + thư mục templates/ + migrations/│  1 BINARY DUY NHẤT│
│  phải deploy CÙNG NHAU (COPY riêng       │  chứa sẵn mọi asset,│
│  trong Dockerfile, dễ quên/lệch version) │  không phụ thuộc file│
│                                          │  bên ngoài khi chạy   │
│  Giống Java: JAR + resources/ folder     │  Giống Java: file    │
│  rời phải cùng classpath                 │  đã đóng gói TRONG    │
│                                          │  JAR qua getResource()│
└────────────────────────────────────────┴──────────────────────┘
```

### 6.1 Advanced #1 — Serve embedded static assets qua HTTP (không cần thư mục ngoài)

```go
//go:embed static/*
var staticFS embed.FS

func main() {
    // http.FS adapter biến embed.FS thành http.FileSystem
    sub, _ := fs.Sub(staticFS, "static") // bỏ prefix "static/" trong URL path
    http.Handle("/assets/", http.StripPrefix("/assets/", http.FileServer(http.FS(sub))))
}
```

### 6.2 Advanced #2 — Embed migration SQL, chạy tự động khi service khởi động

```go
//go:embed migrations/*.sql
var migrationsFS embed.FS

func runMigrations(db *sql.DB) error {
    entries, _ := migrationsFS.ReadDir("migrations")
    sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() }) // đảm bảo thứ tự 001, 002, 003...

    for _, e := range entries {
        content, err := migrationsFS.ReadFile("migrations/" + e.Name())
        if err != nil {
            return err
        }
        if _, err := db.Exec(string(content)); err != nil {
            return fmt.Errorf("migration %s failed: %w", e.Name(), err)
        }
    }
    return nil
}
// → deploy chỉ cần 1 binary, migration SQL LUÔN đồng bộ với version code
// đang chạy — không còn tình huống "quên copy file migration mới lên server"
```

⚠ **Trade-off cần biết:** embed làm **tăng kích thước binary** theo đúng dung lượng file được embed — hợp lý cho template/migration/static asset nhỏ-vừa (vài KB-MB), **không hợp lý** cho asset lớn (video, document mẫu nhiều chục MB) — những thứ đó nên ở object storage (S3/MinIO), không embed vào binary.

---

## 7. Tổng kết Bài 42

```
┌─────────────────────────────────────────────────────────┐
│                   KEY TAKEAWAYS                          │
├─────────────────────────────────────────────────────────┤
│  ✅ os.ReadFile cho file nhỏ; os.Open + streaming/buffer   │
│     cho file lớn — tránh load hết vào RAM                  │
│  ✅ bufio.Scanner luôn check Err() sau vòng lặp — Scan()   │
│     false không phân biệt "hết file" với "lỗi đọc"          │
│  ✅ bufio.Writer PHẢI Flush() — defer Flush TRƯỚC defer     │
│     Close (khai báo Close trước để nó chạy SAU, do LIFO)     │
│  ✅ Atomic write = ghi file tạm CÙNG THƯ MỤC + os.Rename —   │
│     bảo vệ document khỏi hỏng dở dang khi crash giữa chừng   │
│  ✅ filepath.Join xử lý separator đa nền tảng tự động, NHƯNG  │
│     phải tự validate path traversal khi input từ user         │
│  ✅ filepath.WalkDir (1.16+) nhanh hơn Walk cũ                │
│  ✅ Temp dir + defer os.RemoveAll cho batch xử lý trung gian,  │
│     tự dọn dẹp dù thành công hay lỗi ở bước nào                │
│  ✅ //go:embed đóng gói template/migration/static vào 1 binary │
│     duy nhất — chỉ dùng cho asset nhỏ-vừa, không phải file lớn │
└─────────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** Bài 43 — CLI Arguments, Flags, Subcommands & Environment Variables (Nhóm 6)

**Liên quan trong vault:** [[Bai-40-Random-Strconv-URL-Hashes-Base64|Bài 40]] (checksum streaming với io.Copy) · [[Bai-19-Config-Log-Trace|Bài 19]] (Viper — dùng embed cho default config template là pattern hay)

---

**Bài tập:**
1. Viết `SaveDocumentAtomic(path string, doc *Document) error` marshal JSON rồi ghi atomic theo pattern mục 2.1, viết test giả lập crash giữa chừng (kill process/panic sau Write nhưng trước Rename) verify file gốc không bị hỏng
2. Viết CLI tool đọc file CSV lớn (streaming, không ReadFile toàn bộ), lọc theo điều kiện, ghi kết quả ra file mới (buffered write) — benchmark memory usage so với cách load hết
3. Viết `safeJoin` đầy đủ (mục 4) kèm test với các input path traversal (`../`, encoded `%2e%2e%2f`, symlink) — liệt kê trường hợp nào cách kiểm tra hiện tại CHƯA bắt được
4. Dùng `//go:embed` đóng gói 3 file migration SQL mẫu, viết `runMigrations` chạy đúng thứ tự, test với 1 migration cố tình lỗi cú pháp SQL để verify error handling

---
*Tags: #go #file-io #filesystem #embed #atomic-write #zero-to-hero*
