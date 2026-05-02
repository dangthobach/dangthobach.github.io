# Bài 1: Go Mindset — Chuyển tư duy từ Java/Rust sang Go

> **Mục tiêu:** Hiểu triết lý thiết kế của Go, so sánh với Java và Rust, setup workspace chuẩn.

---

## 1. Triết lý của Go — "Simplicity is the prerequisite for reliability"

Go ra đời năm 2009 tại Google bởi Rob Pike, Ken Thompson, và Robert Griesemer. Họ muốn giải quyết 3 vấn đề cụ thể của Google:

```
┌─────────────────────────────────────────────────────────┐
│               VẤN ĐỀ GOOGLE CẦN GIẢI QUYẾT             │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. Build time quá chậm (C++/Java với codebase lớn)     │
│     → Go: build trong vài giây dù codebase triệu dòng  │
│                                                         │
│  2. Quản lý dependency phức tạp                         │
│     → Go modules: go.mod — đơn giản, rõ ràng           │
│                                                         │
│  3. Concurrency khó viết đúng (thread + lock)           │
│     → Go: Goroutines + Channels (CSP model)             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**3 đặc trưng cốt lõi của Go:**
- **Simplicity over cleverness** — 25 keywords (Java có 51, C++ có ~90)
- **Composition over inheritance** — Không có class hierarchy, chỉ có interfaces + embedding
- **Explicit over implicit** — Error phải được xử lý rõ ràng, không có exceptions

---

## 2. Hình minh họa: Goroutine vs Thread vs Rust async

### Java: Thread-per-request (truyền thống)
```
┌──────────────────────────────────────────────────────┐
│                    JVM Process                        │
│                                                      │
│  Request 1 ──► [OS Thread 1] (1–2 MB stack)          │
│  Request 2 ──► [OS Thread 2] (1–2 MB stack)          │
│  Request 3 ──► [OS Thread 3] (1–2 MB stack)          │
│  ...                                                 │
│  Request N ──► [OS Thread N] (1–2 MB stack)          │
│                                                      │
│  ⚠ 10,000 requests = 10,000 threads = 10–20 GB RAM   │
│  ⚠ Context switching overhead (OS kernel)            │
└──────────────────────────────────────────────────────┘
```

### Rust: async/await với Tokio
```
┌──────────────────────────────────────────────────────┐
│                  Rust Process                         │
│                                                      │
│  Tokio Runtime (N OS threads = CPU cores)            │
│  ├── Thread 1: [Future A] [Future B] [Future C]      │
│  ├── Thread 2: [Future D] [Future E] [Future F]      │
│  └── Thread N: [Future G] ...                        │
│                                                      │
│  ✅ Explicit async/await — you control scheduling     │
│  ✅ Zero-cost abstractions                            │
│  ⚠ Steep learning curve (Pin, Waker, async traits)   │
└──────────────────────────────────────────────────────┘
```

### Go: Goroutines với M:N Scheduler
```
┌──────────────────────────────────────────────────────┐
│                    Go Process                         │
│                                                      │
│  Go Runtime Scheduler (GMP Model)                    │
│  ├── OS Thread (M1): runs Goroutine P from queue     │
│  ├── OS Thread (M2): runs Goroutine Q from queue     │
│  └── OS Thread (M3): runs Goroutine R from queue     │
│                                                      │
│  Goroutine Queue: [G1][G2][G3]...[G1,000,000]        │
│                                                      │
│  ✅ 10,000 goroutines = ~80 MB RAM (8KB stack each)  │
│  ✅ Go scheduler handles everything                   │
│  ✅ Không cần async/await — viết code sequential     │
└──────────────────────────────────────────────────────┘
```

**Đây là lý do Go "feel" đơn giản hơn Rust trong concurrency:**
- Rust: `async fn`, `await`, `Pin`, `Send + Sync bounds` — explicit mọi thứ
- Go: `go func()` — xong. Scheduler lo phần còn lại.

---

## 3. GC Model của Go — Khác Java ở điểm nào?

### Java GC (Stop-the-World)
```
Timeline: ──────────────────────────────────────────►

App:    [RUN ████████████][STOP ██][RUN ████████████][STOP ██]
GC:                       [  GC  ]                   [  GC  ]

⚠ "Stop the World" pause: 10ms đến vài giây
⚠ Unpredictable latency spikes
```

### Go GC (Tricolor Incremental Mark & Sweep)
```
Timeline: ──────────────────────────────────────────►

App:    [RUN ████████████████████████████████████████]
GC:     [ concurrent marking ........ sweep ........ ]

✅ GC chạy SONG SONG với application
✅ Pause time < 1ms (thường < 100µs)
✅ Không có "Stop the World" đáng kể
```

**Tại sao Go GC tốt hơn Java GC về latency?**
```
┌─────────────────────────────────────────────────────┐
│  Go GC dùng thuật toán Tricolor Marking:            │
│                                                     │
│  WHITE  = chưa thăm   ●                             │
│  GREY   = đang thăm   ◉  (trong worklist)           │
│  BLACK  = đã thăm     ◎  (reachable, giữ lại)       │
│                                                     │
│  Objects cuối cùng còn WHITE → unreachable → xóa   │
│                                                     │
│  Write barrier đảm bảo correctness khi GC chạy     │
│  song song với Goroutine mutating heap              │
└─────────────────────────────────────────────────────┘
```

---

## 4. Cú pháp đầu tiên — Java Dev sẽ ngạc nhiên điều gì?

### 4.1 Khai báo biến (Go đảo ngược kiểu so với Java)
```go
// Java
String name = "Bach";
int age = 30;

// Go — kiểu đứng SAU tên biến
var name string = "Bach"
var age int = 30

// Go — short declaration (phổ biến hơn)
name := "Bach"
age := 30
```

### 4.2 Không có constructor — dùng struct literal
```go
// Java
public class User {
    private String name;
    private int age;
    public User(String name, int age) { ... }
}
User u = new User("Bach", 30);

// Go — struct + literal, không có new/constructor
type User struct {
    Name string
    Age  int
}

u := User{Name: "Bach", Age: 30}
u2 := &User{Name: "Linh", Age: 25} // pointer to User
```

### 4.3 Interface — Implicit, không cần "implements"
```go
// Java — explicit
class Dog implements Animal {
    @Override
    public String Sound() { return "Woof"; }
}

// Go — IMPLICIT: struct tự động thỏa interface nếu có đủ methods
type Animal interface {
    Sound() string
}

type Dog struct{}

func (d Dog) Sound() string { return "Woof" }

// Dog tự động implements Animal — không cần khai báo!
var a Animal = Dog{} // ✅ hoạt động
```

### 4.4 Error handling — Không có try/catch
```go
// Java
try {
    String content = Files.readString(Path.of("file.txt"));
} catch (IOException e) {
    log.error("Failed: {}", e.getMessage());
}

// Go — error là giá trị trả về
content, err := os.ReadFile("file.txt")
if err != nil {
    log.Printf("Failed: %v", err)
    return
}
// dùng content ở đây
```

**Tại sao Go chọn cách này?**
```
┌────────────────────────────────────────────────────────┐
│  Java Exceptions:                                      │
│  ├── Checked exception: phải declare hoặc catch        │
│  ├── Unchecked exception: có thể bỏ qua (nguy hiểm!)  │
│  └── Exception là control flow — khó trace             │
│                                                        │
│  Go Error Values:                                      │
│  ├── Error là giá trị bình thường — buộc xử lý        │
│  ├── Compiler không enforce, nhưng convention mạnh     │
│  └── Dễ trace, không có "hidden exception paths"       │
└────────────────────────────────────────────────────────┘
```

---

## 5. Go vs Rust — Khi nào dùng cái nào?

```
┌─────────────────────────────────────────────────────────────┐
│                   DECISION MATRIX                           │
├───────────────────────┬────────────┬────────────────────────┤
│ Use case              │    Go      │        Rust            │
├───────────────────────┼────────────┼────────────────────────┤
│ REST API / Microservice│  ✅ Best   │  ✅ Good               │
│ CLI tools             │  ✅ Great   │  ✅ Great              │
│ Systems programming   │  ❌ Limited │  ✅ Best               │
│ Game engine           │  ❌         │  ✅                    │
│ Embedded / no std     │  ❌         │  ✅ Best               │
│ WebAssembly           │  ⚠ Large   │  ✅ Small binary       │
│ Team productivity     │  ✅ High    │  ⚠ Lower              │
│ Hire-ability          │  ✅ Easy    │  ⚠ Harder             │
│ PDMS-like project     │  ✅ Great   │  ✅ Great              │
└───────────────────────┴────────────┴────────────────────────┘

Go = Productivity + Simplicity + Good performance
Rust = Control + Safety + Maximum performance
```

---

## 6. Setup Workspace

### 6.1 Cài đặt Go
```bash
# Trên EndeavourOS (Arch-based)
sudo pacman -S go

# Kiểm tra
go version  # go version go1.22.x linux/amd64

# Cấu hình GOPATH (thường không cần với Go modules)
export GOPATH=$HOME/go
export PATH=$PATH:$GOPATH/bin
```

### 6.2 Tạo project đầu tiên
```bash
mkdir go-zero-to-hero && cd go-zero-to-hero
go mod init github.com/bach/go-zero-to-hero
```

Cấu trúc `go.mod`:
```
module github.com/bach/go-zero-to-hero

go 1.22
```

### 6.3 Neovim setup cho Go
```bash
# Cài gopls (Go Language Server)
go install golang.org/x/tools/gopls@latest

# Trong NvChad, mason sẽ auto-detect gopls
# Thêm vào mason-lspconfig:
# "gopls", "golangci-lint"

# Formatter
go install mvdan.cc/gofumpt@latest
```

### 6.4 Hello World
```go
// main.go
package main

import "fmt"

func main() {
    fmt.Println("Chào từ Go!")
    
    // Goroutine đầu tiên
    go func() {
        fmt.Println("Tôi chạy trong goroutine!")
    }()
    
    // Đợi goroutine (sẽ học Channel ở Bài 3)
    fmt.Scanln()
}
```

```bash
go run main.go
go build -o app main.go  # build binary
./app
```

---

## 7. Cấu trúc thư mục chuẩn (Standard Layout)

```
my-service/
├── cmd/
│   └── server/
│       └── main.go          # Entry point
├── internal/
│   ├── domain/              # Business entities
│   ├── usecase/             # Business logic
│   ├── repository/          # Data access
│   └── delivery/
│       └── http/            # HTTP handlers (Gin/Echo/Fiber)
├── pkg/                     # Public shared packages
│   ├── logger/
│   └── config/
├── migrations/              # SQL migrations
├── docker/
│   └── Dockerfile
├── go.mod
├── go.sum
└── README.md
```

**So sánh với Java Spring Boot:**
```
Spring Boot                  Go (Clean Architecture)
─────────────────────────    ─────────────────────────
src/main/java/.../           cmd/server/main.go
  controller/                internal/delivery/http/
  service/                   internal/usecase/
  repository/                internal/repository/
  entity/                    internal/domain/
  config/                    pkg/config/
```

---

## 8. Quick Reference: Go vs Java vs Rust

```go
// ─── GOROUTINE vs Thread vs Tokio Task ───

// Java (Virtual Thread - Project Loom)
Thread.ofVirtual().start(() -> handleRequest(req));

// Rust (Tokio)
tokio::spawn(async move { handle_request(req).await });

// Go (Goroutine)  ← ĐƠN GIẢN NHẤT
go handleRequest(req)

// ─── CHANNEL vs BlockingQueue vs Channel ───

// Java
BlockingQueue<String> q = new LinkedBlockingQueue<>();
q.put("message");
String msg = q.take();

// Go
ch := make(chan string, 1)
ch <- "message"
msg := <-ch

// ─── DEFER vs try-finally vs Drop ───

// Java
try {
    conn = getConnection();
    // use conn
} finally {
    conn.close();
}

// Go — CLEAN HƠN NHIỀU
conn := getConnection()
defer conn.Close()  // tự động gọi khi function return
// use conn

// Rust — Drop trait tự động
{
    let conn = get_connection();
    // use conn
} // conn.drop() tự gọi khi out of scope
```

---

## 9. Tổng kết Bài 1

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ Go = Simplicity first, performance second        │
│  ✅ Goroutines nhẹ hơn Thread 100-1000x             │
│  ✅ GC concurrent — latency < 1ms                   │
│  ✅ Interface implicit — composition over inherit.  │
│  ✅ Error là giá trị, không phải exception          │
│  ✅ defer thay thế try-finally                      │
│  ✅ 25 keywords — ít hơn Java (51) và C++ (~90)     │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-2-Syntax-Types-Structs|Bài 2: Syntax, Types, Structs & Methods]]

---

**Bài tập:**
1. Tạo `go-zero-to-hero` module, viết `main.go` khởi động HTTP server đơn giản bằng `net/http` thuần
2. Tạo 100 goroutine, mỗi goroutine print ID của nó. Quan sát thứ tự in — tại sao không theo thứ tự?
3. Dùng `go tool pprof` để xem goroutine count

---
*Tags: #go #golang #concurrency #goroutine #mindset #zero-to-hero*

---

## Addendum 2026 — Java Virtual Threads có "bắt kịp" Go chưa?

> Phần trên mô tả Java theo mô hình OS Thread truyền thống. Nhưng từ **Java 21 (LTS)**, Project Loom đã GA với **Virtual Threads** — cơ chế gần giống goroutine hơn nhiều. Dưới đây là update quan trọng.

```
┌──────────────────────────────────────────────────────┐
│       JVM — Virtual Threads (Java 21+ Loom)          │
│                                                      │
│  ForkJoinPool (carrier threads = CPU cores)          │
│  ├── Carrier 1: [VT-A running] [VT-B,C parked]      │
│  └── Carrier 2: [VT-D running] [VT-E parked]        │
│                                                      │
│  VT blocks on I/O → unmount từ carrier              │
│  → carrier chạy VT khác → I/O xong → remount VT     │
│                                                      │
│  ✅ 10,000 VTs ≈ 1–4 GB heap (vs 10–20 GB threads)  │
│  ✅ Blocking code = non-blocking behavior!           │
│  ✅ Zero code change khi migrate legacy Java!        │
│     spring.threads.virtual.enabled=true ← 1 dòng    │
│  ⚠ Pinning: synchronized block giữ carrier bị block │
│  ⚠ JVM baseline: ~200–500MB (Go binary: ~10MB)      │
└──────────────────────────────────────────────────────┘
```

### So sánh nhanh sau khi có VT

| Criterion | Go Goroutine | Java VT | Rust Async |
|---|---|---|---|
| Throughput | ★★★★ | ★★★☆ | ★★★★★ |
| Memory/task | ~4–8 KB | ~heap alloc | ~smallest |
| Container size | ~10 MB | ~200–500 MB | ~5 MB |
| Startup time | <100ms | 2–10s | <100ms |
| Pinning risk | ✅ None | ⚠ Real | ✅ None |
| Legacy migration | ❌ Rewrite | ✅ Zero-change | ❌ Rewrite |
| Code simplicity | `go func()` | familiar Java | `async/await` |

### Verdict thẳng thắn

```
Virtual Threads KHÔNG "better" hơn Goroutines — chúng giải quyết
bài toán KHÁC NHAU với trade-off khác nhau:

VT wins:  Legacy Java migration, JPA/JDBC ecosystem, Java-only team
Go wins:  Container-native, startup time, no pinning, simplicity
Rust wins: Maximum performance, no GC, embedded/real-time
```

📖 **Full analysis với benchmarks, code comparison, pinning deep-dive:**
[[Deep-Dive-VirtualThreads-vs-Goroutines-vs-RustAsync|🔗 Deep Dive: Virtual Threads vs Goroutines vs Rust Async]]
