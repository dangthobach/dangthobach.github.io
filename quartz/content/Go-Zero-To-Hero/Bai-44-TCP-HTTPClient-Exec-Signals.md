---
type: course
domain: languages/go
status: active
created: 2026-08-22
updated: 2026-08-22
tags: []
---

# Bài 44: TCP Server, Advanced HTTP Client, Process Spawning & Signals

> **Mục tiêu:** Hoàn thành nốt Nhóm 7. [[Bai-9-Net-Http-Deep|Bài 9]] đã cover HTTP server sâu và [[Bai-7-Context-Cancellation|Bài 7]] đã touch graceful shutdown qua signal — bài này lấp phần còn thiếu: TCP thuần (nhìn xuống tầng dưới HTTP), HTTP Client production-grade (connection pooling, retry), chạy external process (`os/exec`) và xử lý signal đầy đủ hơn (reload config không cần restart — rất quan trọng cho banking service uptime cao).
>
> **Level:** Intermediate → Advanced

---

## 1. TCP Server — Tầng Dưới Cùng Mà HTTP Server Xây Trên Đó

Bài 9 đã nói "1 connection = 1 goroutine" cho HTTP — giờ xem RAW TCP, không có lớp HTTP parser nào ở giữa.

```go
func main() {
    ln, err := net.Listen("tcp", ":9000")
    if err != nil {
        log.Fatal(err)
    }
    defer ln.Close()

    for {
        conn, err := ln.Accept() // block tới khi có client kết nối mới
        if err != nil {
            log.Printf("accept error: %v", err)
            continue
        }
        go handleConn(conn) // ĐÚNG pattern Go — 1 goroutine per connection, không cần thread pool
    }
}

func handleConn(conn net.Conn) {
    defer conn.Close()
    conn.SetDeadline(time.Now().Add(30 * time.Second)) // ⚠ BẮT BUỘC — không có timeout, client treo kết nối = goroutine leak vĩnh viễn

    scanner := bufio.NewScanner(conn)
    for scanner.Scan() {
        line := scanner.Text()
        if line == "PING" {
            fmt.Fprintln(conn, "PONG")
            continue
        }
        fmt.Fprintf(conn, "unknown command: %s\n", line)
    }
}
```

```
┌────────────────────────────────────────────────────────────┐
│              HTTP SERVER (Bài 9)  vs  TCP THUẦN (bài này)     │
│                                                              │
│  net.Listen("tcp",...) ──┐                                   │
│                            │  CẢ HAI ĐỀU DÙNG chung nền tảng   │
│  http.Server ─────────────┤  net.Listener + Accept loop        │
│                            │                                   │
│  Khác biệt: http.Server TỰ ĐỘNG parse HTTP request/response   │
│  (header, method, body...) từ raw bytes trên connection —      │
│  TCP thuần thì BẠN tự định nghĩa protocol (ở trên: mỗi dòng    │
│  text là 1 "lệnh", tự parse bằng bufio.Scanner)                │
└────────────────────────────────────────────────────────────┘
```

⚠ **Vì sao PDMS hiếm khi viết TCP server thuần:** hầu hết giao tiếp nội bộ dùng gRPC (Bài 18, chạy trên HTTP/2) hoặc HTTP/REST vì đã có sẵn tooling (load balancer, observability, service mesh) hiểu HTTP. TCP thuần chỉ đáng viết khi: (1) cần latency cực thấp không chịu nổi HTTP overhead, (2) tích hợp protocol nhị phân có sẵn của hệ thống legacy (core banking dùng custom TCP protocol), hoặc (3) học để hiểu tầng dưới của mọi framework HTTP.

### 1.1 Advanced — Connection pool phía server (giới hạn số connection đồng thời)

```go
func main() {
    ln, _ := net.Listen("tcp", ":9000")
    sem := make(chan struct{}, 1000) // semaphore — tối đa 1000 connection xử lý đồng thời

    for {
        conn, err := ln.Accept()
        if err != nil {
            continue
        }
        sem <- struct{}{} // block nếu đã đủ 1000 — tự nhiên throttle, tránh goroutine bùng nổ
        go func() {
            defer func() { <-sem }()
            handleConn(conn)
        }()
    }
}
```

---

## 2. Advanced HTTP Client — Connection Pooling & Retry

Bài 9 chỉ nhắc ngắn "http.Client cần Timeout" — giờ đi sâu vào cấu hình production thật.

```go
var httpClient = &http.Client{
    Timeout: 10 * time.Second, // timeout TOÀN BỘ request (connect + write + read)
    Transport: &http.Transport{
        MaxIdleConns:        100, // tổng số idle connection giữ lại (tái sử dụng, tránh TCP handshake lại)
        MaxIdleConnsPerHost: 10,  // idle connection tối đa CHO MỖI host — quan trọng khi gọi nhiều host khác nhau
        IdleConnTimeout:     90 * time.Second,
        DialContext: (&net.Dialer{
            Timeout:   5 * time.Second, // timeout riêng cho bước TCP connect
            KeepAlive: 30 * time.Second,
        }).DialContext,
        TLSHandshakeTimeout: 5 * time.Second,
    },
}
```

```
┌────────────────────────────────────────────────────────────┐
│  KHÔNG CẤU HÌNH Transport (dùng http.DefaultTransport)        │
│  → vẫn CÓ pooling mặc định, nhưng MaxIdleConnsPerHost mặc     │
│  định CHỈ LÀ 2 — service gọi 1 host với concurrency cao (vd    │
│  gọi core banking API từ 50 goroutine cùng lúc) sẽ liên tục     │
│  mở/đóng TCP connection mới thay vì tái sử dụng → tốn latency   │
│  TCP handshake + TLS handshake lặp lại không cần thiết          │
└────────────────────────────────────────────────────────────┘
```

### 2.1 Advanced — Retry với exponential backoff (KHÔNG tự viết loop retry ngây thơ)

```go
func doWithRetry(ctx context.Context, req *http.Request, maxAttempts int) (*http.Response, error) {
    var lastErr error
    for attempt := 0; attempt < maxAttempts; attempt++ {
        if attempt > 0 {
            backoff := time.Duration(math.Pow(2, float64(attempt))) * 100 * time.Millisecond
            jitter := time.Duration(rand.IntN(50)) * time.Millisecond // jitter tránh "thundering herd" nếu nhiều client retry cùng lúc
            select {
            case <-time.After(backoff + jitter):
            case <-ctx.Done():
                return nil, ctx.Err()
            }
        }

        resp, err := httpClient.Do(req.Clone(ctx)) // Clone — body đã đọc 1 lần không thể gửi lại nguyên request cũ
        if err == nil && resp.StatusCode < 500 {
            return resp, nil // thành công HOẶC lỗi 4xx (client error — KHÔNG retry, retry cũng sẽ fail y hệt)
        }
        if err != nil {
            lastErr = err
        } else {
            lastErr = fmt.Errorf("server error: %d", resp.StatusCode)
            resp.Body.Close()
        }
    }
    return nil, fmt.Errorf("failed after %d attempts: %w", maxAttempts, lastErr)
}
```

⚠ **Trap kinh điển: chỉ retry lỗi 5xx/network error, KHÔNG BAO GIỜ retry 4xx.** Lỗi 400 (bad request)/401 (unauthorized)/404 (not found) sẽ **fail y hệt** ở lần retry tiếp theo — retry vô ích, chỉ tốn thời gian và có thể vi phạm rate limit của API bên thứ 3. Chỉ 5xx (server error, có thể tạm thời) và network-level error (timeout, connection refused) đáng để retry.

---

## 3. Process Spawning — `os/exec` (Fork+Exec, Cha Vẫn Sống)

"Spawning" = chạy 1 process con, cha **tiếp tục tồn tại**, đợi con xong (hoặc không đợi).

```go
// Chạy đơn giản, lấy output
out, err := exec.Command("pdftoppm", "-png", "document.pdf", "thumbnail").Output()

// CombinedOutput — gộp cả stdout + stderr (hữu ích khi debug external tool lỗi)
out, err = exec.Command("clamscan", "--no-summary", "uploaded-file.pdf").CombinedOutput()
```

### 3.1 Advanced #1 — Streaming stdout của long-running external process

```go
// Ví dụ PDMS: gọi tool convert document sang PDF/A (archival format) —
// tool có thể chạy vài giây, muốn stream log ra thay vì đợi xong mới có output
cmd := exec.Command("libreoffice", "--headless", "--convert-to", "pdf", "input.docx")

stdout, _ := cmd.StdoutPipe()
stderr, _ := cmd.StderrPipe()

if err := cmd.Start(); err != nil { // Start() KHÔNG block — khác Run()
    return err
}

go streamLog("stdout", stdout)
go streamLog("stderr", stderr)

if err := cmd.Wait(); err != nil { // Wait() block tới khi process con kết thúc
    return fmt.Errorf("conversion failed: %w", err)
}

func streamLog(prefix string, r io.Reader) {
    scanner := bufio.NewScanner(r)
    for scanner.Scan() {
        log.Printf("[%s] %s", prefix, scanner.Text())
    }
}
```

### 3.2 Advanced #2 — Context timeout cho external process (tránh treo vĩnh viễn)

```go
func convertWithTimeout(ctx context.Context, input, output string) error {
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    cmd := exec.CommandContext(ctx, "libreoffice", "--headless", "--convert-to", "pdf", input) // tự động Kill process nếu ctx hết hạn/cancel
    if err := cmd.Run(); err != nil {
        if ctx.Err() == context.DeadlineExceeded {
            return fmt.Errorf("conversion timed out after 30s: %w", err)
        }
        return fmt.Errorf("conversion failed: %w", err)
    }
    return nil
}
```

⚠ **Trap bảo mật — command injection:** **KHÔNG BAO GIỜ** build command bằng string concat rồi chạy qua shell nếu argument đến từ user input.

```go
// ❌ NGUY HIỂM nếu filename từ user input chứa "; rm -rf /"
exec.Command("sh", "-c", "convert "+filename+" output.png") // command injection!

// ✅ AN TOÀN — exec.Command tự tách argument, KHÔNG đi qua shell interpreter
exec.Command("convert", filename, "output.png") // filename dù chứa ký tự đặc biệt cũng chỉ là 1 ARGUMENT, không bị shell diễn giải
```

### 3.3 Exec'ing Processes — `syscall.Exec` (Thay Thế Hoàn Toàn Process Hiện Tại, KHÔNG Fork)

Khác hẳn "spawning" — `syscall.Exec` **thay thế process hiện tại bằng process mới** (cùng PID, memory cũ bị discard hoàn toàn), process gọi **không bao giờ return** nếu thành công (chỉ return khi có lỗi).

```go
import "syscall"

func execReplace() error {
    binary, err := exec.LookPath("psql")
    if err != nil {
        return err
    }
    args := []string{"psql", "-h", "localhost", "-U", "pdms"}
    env := os.Environ() // kế thừa toàn bộ env hiện tại

    // Nếu thành công, dòng code SAU DÒNG NÀY KHÔNG BAO GIỜ CHẠY —
    // process hiện tại đã bị THAY THẾ hoàn toàn bởi "psql"
    return syscall.Exec(binary, args, env)
}
```

```
┌────────────────────────────────────────────────────────────┐
│  exec.Command (Spawning)        │  syscall.Exec (Exec'ing)   │
├──────────────────────────────────┼──────────────────────────────┤
│  FORK process con MỚI, PID khác  │  THAY THẾ process HIỆN TẠI,  │
│  Process cha VẪN SỐNG, tiếp tục  │  CÙNG PID, memory cũ bị xoá   │
│  chạy code sau khi con xong       │  Code SAU lệnh Exec KHÔNG BAO │
│                                    │  GIỜ CHẠY (nếu Exec thành công)│
│  Dùng cho: hầu hết trường hợp —  │  Dùng cho: process supervisor/ │
│  gọi tool, đợi kết quả, xử lý     │  wrapper script (docker        │
│  tiếp                              │  entrypoint pattern: wrapper    │
│                                    │  setup xong rồi "exec" vào     │
│                                    │  process thật, để process thật │
│                                    │  nhận trực tiếp PID 1 và signal │
│                                    │  từ container runtime)          │
└──────────────────────────────────┴──────────────────────────────┘
```

⚠ `syscall.Exec` chỉ hoạt động trên **Unix** (Linux/Mac) — không có trên Windows (khác biệt platform cần lưu ý nếu code chạy đa nền tảng). Đây cũng chính xác là cơ chế `exec` trong Docker `ENTRYPOINT` script (`exec "$@"` ở cuối shell script) — để process thật nhận tín hiệu (mục 4) trực tiếp từ container runtime thay vì bị chặn bởi shell wrapper.

---

## 4. Signals — Sâu Hơn Graceful Shutdown Đã Nói Ở Bài 7

### 4.1 `signal.Notify` — Nhận NHIỀU loại signal, xử lý KHÁC NHAU

```go
sigCh := make(chan os.Signal, 1) // buffer size 1 — signal.Notify không block nếu chưa ai đọc
signal.Notify(sigCh, syscall.SIGHUP, syscall.SIGTERM, syscall.SIGINT)

for sig := range sigCh {
    switch sig {
    case syscall.SIGHUP:
        log.Println("SIGHUP received — reloading config, KHÔNG restart service")
        reloadConfig() // đọc lại config file mà KHÔNG cần restart, không mất connection đang xử lý
    case syscall.SIGTERM, syscall.SIGINT:
        log.Println("shutdown signal received")
        gracefulShutdown()
        return
    }
}
```

```
┌────────────────────────────────────────────────────────────┐
│  SIGHUP   →  truyền thống nghĩa "terminal đóng" — nhiều       │
│              service daemon "tái định nghĩa" thành "reload    │
│              config" (nginx, nhiều Go service làm vậy)          │
│  SIGTERM  →  yêu cầu dừng "lịch sự" — Kubernetes gửi tín hiệu  │
│              này trước khi SIGKILL (mặc định sau 30s grace     │
│              period nếu process chưa tự thoát)                 │
│  SIGINT   →  Ctrl+C từ terminal — hữu ích khi dev local          │
│  SIGKILL  →  KHÔNG THỂ bắt/xử lý — OS kill ngay lập tức,        │
│              không có cách nào chạy cleanup code trước khi chết  │
└────────────────────────────────────────────────────────────┘
```

⚠ **Ứng dụng thực tế cho PDMS:** đổi log level, refresh feature flag, hoặc reload TLS certificate (cert rotation) **không cần restart pod** — chỉ cần gửi `SIGHUP` (`kill -HUP <pid>`), tránh downtime/connection drop mà 1 lần restart pod thông thường gây ra. Đây là kỹ thuật vận hành thực sự dùng trong production banking service muốn giữ uptime cao.

### 4.2 `signal.NotifyContext` (Go 1.16+, đã dùng ở Bài 7) vs `signal.Notify` thô

```
┌────────────────────────────────────────────────────────────┐
│  signal.Notify(ch, ...)      │  signal.NotifyContext(...)     │
├──────────────────────────────┼──────────────────────────────────┤
│  Nhận channel thô, TỰ viết   │  Trả về context.Context — tích  │
│  switch/case xử lý từng loại │  hợp thẳng với ctx.Done() đã     │
│  signal                       │  dùng khắp nơi (Bài 7)            │
│  Linh hoạt hơn khi cần xử lý  │  Đơn giản hơn khi CHỈ CẦN biết   │
│  KHÁC NHAU cho từng loại      │  "có tín hiệu dừng" (không cần   │
│  signal (như SIGHUP ở trên)   │  phân biệt SIGTERM vs SIGINT)      │
└──────────────────────────────┴──────────────────────────────────┘
```

### 4.3 Advanced — Forward signal xuống child process (process supervisor pattern)

```go
// Khi Go service chạy 1 external process con dài hạn (không phải spawn-đợi-xong
// như mục 3), cần forward signal nhận được xuống con để con cũng graceful shutdown
cmd := exec.Command("some-long-running-worker")
cmd.Start()

sigCh := make(chan os.Signal, 1)
signal.Notify(sigCh, syscall.SIGTERM)

go func() {
    <-sigCh
    cmd.Process.Signal(syscall.SIGTERM) // forward CHÍNH signal đó xuống process con
}()

cmd.Wait()
```

---

## 5. Tổng kết Bài 44 — Hoàn Thành Nhóm 7

```
┌─────────────────────────────────────────────────────────┐
│                   KEY TAKEAWAYS                          │
├─────────────────────────────────────────────────────────┤
│  ✅ TCP server = net.Listen + Accept loop + goroutine/conn — │
│     HTTP server (Bài 9) xây TRÊN nền này, thêm lớp parse HTTP│
│  ✅ conn.SetDeadline BẮT BUỘC cho raw TCP — không có timeout  │
│     mặc định như http.Server                                  │
│  ✅ http.Transport cấu hình MaxIdleConnsPerHost — mặc định    │
│     chỉ 2, quá thấp cho service gọi 1 host với concurrency cao │
│  ✅ Retry CHỈ cho 5xx/network error, KHÔNG BAO GIỜ retry 4xx — │
│     kèm exponential backoff + jitter                            │
│  ✅ exec.Command = spawn process con, cha vẫn sống; dùng        │
│     CommandContext để tự Kill khi timeout; KHÔNG BAO GIỜ build   │
│     command qua string concat + shell (command injection)        │
│  ✅ syscall.Exec = THAY THẾ process hiện tại, không return nếu   │
│     thành công — dùng cho process supervisor/wrapper pattern      │
│  ✅ signal.Notify xử lý được NHIỀU loại signal khác nhau         │
│     (SIGHUP = reload config không restart); SIGKILL KHÔNG thể     │
│     bắt được                                                       │
└─────────────────────────────────────────────────────────┘
```

**Hoàn thành toàn bộ 7 nhóm từ gobyexample.com gap-check ban đầu, cộng thêm Bài 36 (Scheduler, bonus).**

**Liên quan trong vault:** [[Bai-7-Context-Cancellation|Bài 7]] (graceful shutdown, NotifyContext) · [[Bai-9-Net-Http-Deep|Bài 9]] (HTTP server xây trên net.Listener) · [[Bai-18-gRPC|Bài 18]] (tại sao PDMS ít viết TCP thuần)

---

**Bài tập:**
1. Viết TCP server + client đơn giản dùng protocol text-based tự định nghĩa (vd: `GET <key>`, `SET <key> <value>`) — thêm connection limit bằng semaphore (mục 1.1)
2. Viết `doWithRetry` đầy đủ, test với mock server trả lần lượt: 500, 500, 200 — verify đúng 3 lần gọi và backoff tăng dần
3. Viết wrapper gọi `libreoffice --convert-to pdf` với `CommandContext` timeout 10s, test với 1 file cố tình gây treo (hoặc `sleep` giả lập) verify process bị Kill đúng hạn
4. Viết service nhận `SIGHUP` để reload 1 file config JSON runtime (không cần restart), test bằng cách sửa file rồi `kill -HUP <pid>`, verify service dùng giá trị mới ngay

---
*Tags: #go #tcp #http-client #os-exec #signals #process #zero-to-hero*
