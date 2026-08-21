---
type: course
domain: languages/go
status: active
created: 2026-08-22
updated: 2026-08-22
tags: []
---

# Bài 43: CLI Arguments, Flags, Subcommands & Environment Variables

> **Mục tiêu:** [[Bai-19-Config-Log-Trace|Bài 19]] đã dùng Viper cho config production — nhưng đó là tầng CAO, xây trên nền `flag`/`os.Getenv` mà chưa bài nào nói tới. Bài này lấp phần nền tảng: parse argument thủ công, dựng subcommand (kiểu `pdms-cli migrate up`, `pdms-cli user create`), và cách raw env var hoạt động — cần biết TRƯỚC KHI hiểu Viper đang làm gì "phép màu" bên dưới.
>
> **Level:** Foundation (bổ sung Nhóm 6, đọc độc lập được, không cần Bài 19 trước)

---

## 1. `os.Args` — Raw Positional Arguments

```go
// go run main.go create --name="DOC-001" --priority=high
func main() {
    fmt.Println(os.Args)     // ["main", "create", "--name=DOC-001", "--priority=high"]
    fmt.Println(os.Args[0])  // đường dẫn tới binary đang chạy — KHÔNG phải argument thật
    args := os.Args[1:]      // arguments thật sự, bỏ os.Args[0]
}
```

⚠ `os.Args[0]` **luôn là đường dẫn binary**, không phải argument — trap phổ biến cho dev từ ngôn ngữ có `argv` bắt đầu từ argument thật (một số script Python/shell khi dùng `sys.argv` cũng có behavior tương tự nên có thể không lạ, nhưng dev quen C# `Main(string[] args)` — args KHÔNG chứa tên chương trình — dễ bị lệch index 1).

---

## 2. `flag` Package — Parse Chuẩn, Không Cần Tự Viết Parser

```go
func main() {
    name := flag.String("name", "", "document name (required)")
    priority := flag.String("priority", "normal", "priority level: low|normal|high|urgent")
    dryRun := flag.Bool("dry-run", false, "print what would happen without executing")
    timeout := flag.Duration("timeout", 30*time.Second, "operation timeout")

    flag.Parse() // PHẢI gọi sau khi khai báo hết flag, trước khi dùng giá trị

    if *name == "" {
        flag.Usage() // in help text tự động sinh từ description ở trên
        os.Exit(1)
    }
    fmt.Printf("creating %s (priority=%s, dry-run=%v, timeout=%v)\n", *name, *priority, *dryRun, *timeout)
}
// Chạy: go run main.go --name=DOC-001 --priority=high --timeout=1m
// go run main.go --help   → tự động in usage
```

```
┌────────────────────────────────────────────────────────────┐
│  flag.String/Int/Bool/Duration TRẢ VỀ CON TRỎ (*string,...)  │
│  → PHẢI deref (*name) SAU khi gọi flag.Parse(), KHÔNG PHẢI   │
│  trước — giá trị con trỏ trỏ tới chỉ đúng SAU Parse()          │
│                                                              │
│  flag.StringVar(&existingVar, "name", "", "...")  ← biến thể  │
│  ghi trực tiếp vào biến CÓ SẴN thay vì tạo con trỏ mới,        │
│  hữu ích khi bind vào field của 1 config struct               │
└────────────────────────────────────────────────────────────┘
```

### 2.1 Advanced — Bind flag trực tiếp vào struct (`*Var` variants)

```go
type CLIConfig struct {
    Name     string
    Priority string
    DryRun   bool
}

func parseFlags() *CLIConfig {
    cfg := &CLIConfig{}
    flag.StringVar(&cfg.Name, "name", "", "document name")
    flag.StringVar(&cfg.Priority, "priority", "normal", "priority level")
    flag.BoolVar(&cfg.DryRun, "dry-run", false, "dry run mode")
    flag.Parse()
    return cfg
}
```

---

## 3. Subcommands — `pdms-cli migrate up`, `pdms-cli user create`

`flag` package **KHÔNG có subcommand built-in** — nhưng `flag.NewFlagSet` cho phép tự dựng, mỗi subcommand có bộ flag RIÊNG.

```go
func main() {
    if len(os.Args) < 2 {
        fmt.Println("usage: pdms-cli <command> [flags]")
        fmt.Println("commands: migrate, user, healthcheck")
        os.Exit(1)
    }

    switch os.Args[1] {
    case "migrate":
        runMigrateCmd(os.Args[2:]) // os.Args[2:] — bỏ qua binary name VÀ command name
    case "user":
        runUserCmd(os.Args[2:])
    case "healthcheck":
        runHealthcheckCmd(os.Args[2:])
    default:
        fmt.Printf("unknown command: %s\n", os.Args[1])
        os.Exit(1)
    }
}

func runMigrateCmd(args []string) {
    fs := flag.NewFlagSet("migrate", flag.ExitOnError) // ExitOnError = tự os.Exit(2) khi parse lỗi
    direction := fs.String("direction", "up", "up or down")
    steps := fs.Int("steps", 0, "number of steps (0 = all)")
    fs.Parse(args)

    fmt.Printf("running migration %s, steps=%d\n", *direction, *steps)
}

func runUserCmd(args []string) {
    if len(args) < 1 {
        fmt.Println("usage: pdms-cli user <create|delete|list>")
        os.Exit(1)
    }
    switch args[0] { // sub-sub-command — "pdms-cli user create --email=..."
    case "create":
        fs := flag.NewFlagSet("user create", flag.ExitOnError)
        email := fs.String("email", "", "user email (required)")
        fs.Parse(args[1:])
        if *email == "" {
            fmt.Println("--email is required")
            os.Exit(1)
        }
        createUser(*email)
    case "delete":
        // ...
    }
}
```

```
┌────────────────────────────────────────────────────────────┐
│              CẤU TRÚC SUBCOMMAND 2 CẤP                        │
│                                                              │
│  os.Args:  [pdms-cli, user, create, --email=a@b.com]         │
│              │         │      │         │                    │
│              binary    │      │         flag của subcommand   │
│                       lệnh   sub-lệnh   cấp 2                 │
│                        cấp 1                                  │
│                                                              │
│  main() đọc os.Args[1] → dispatch runUserCmd(os.Args[2:])     │
│  runUserCmd() đọc args[0] ("create") → dispatch tiếp,         │
│  tự tạo FlagSet RIÊNG parse phần còn lại (args[1:])            │
└────────────────────────────────────────────────────────────┘
```

⚠ **Khi nào nên chuyển sang `cobra` (`github.com/spf13/cobra`)** thay vì tự viết switch/case: khi CLI có >5-6 subcommand, cần auto-generate help text đẹp, cần shell completion (bash/zsh autocomplete), hoặc cần flag kế thừa giữa parent/child command. Pattern switch/case ở trên hoàn toàn ổn cho CLI nội bộ nhỏ (2-10 lệnh) — không cần thêm dependency chỉ vì "ai cũng dùng cobra".

```go
// Cùng ví dụ migrate/user bằng cobra — khai báo declarative hơn
var rootCmd = &cobra.Command{Use: "pdms-cli"}

var migrateCmd = &cobra.Command{
    Use:   "migrate",
    Short: "Run database migrations",
    Run: func(cmd *cobra.Command, args []string) {
        direction, _ := cmd.Flags().GetString("direction")
        fmt.Println("migrating:", direction)
    },
}

func init() {
    migrateCmd.Flags().String("direction", "up", "up or down")
    rootCmd.AddCommand(migrateCmd)
}

func main() {
    rootCmd.Execute() // tự động xử lý --help, error message, shell completion
}
```

---

## 4. Environment Variables — `os.Getenv` vs `os.LookupEnv`

```go
port := os.Getenv("PORT") // trả "" nếu KHÔNG tồn tại — KHÔNG PHÂN BIỆT được
                            // "biến không tồn tại" với "biến tồn tại nhưng rỗng"

port2, exists := os.LookupEnv("PORT") // exists=false nếu THỰC SỰ không set,
                                        // exists=true, port2="" nếu set rỗng tường minh
```

```
┌────────────────────────────────────────────────────────────┐
│  os.Getenv("X")           │  os.LookupEnv("X")                │
├──────────────────────────────┼──────────────────────────────────┤
│  X không tồn tại  →  ""       │  X không tồn tại  → ("", false)  │
│  X="" (set rỗng)  →  ""       │  X="" (set rỗng)  → ("", true)   │
│  → 2 trường hợp trên GIỐNG    │  → phân biệt được rõ ràng          │
│    HỆT NHAU, không phân biệt  │                                   │
│    được — dùng Getenv cho     │  Dùng LookupEnv khi CẦN validate  │
│    optional config với default│  biến BẮT BUỘC phải được set,      │
│    hợp lý                     │  kể cả set rỗng cũng là lỗi cấu hình│
└──────────────────────────────┴──────────────────────────────────┘
```

### 4.1 Advanced — Fail-fast validate required env vars khi khởi động (rất quan trọng cho service banking)

```go
// ✅ Validate TẤT CẢ env var bắt buộc NGAY LÚC KHỞI ĐỘNG — service crash
// ngay với message rõ ràng, thay vì chạy được vài phút rồi lỗi giữa chừng
// khi code chạm tới đoạn cần biến đó (ví dụ JWT_SECRET rỗng → token verify luôn fail)
func mustLoadConfig() *Config {
    required := []string{"DATABASE_URL", "JWT_SECRET", "KAFKA_BROKERS"}
    var missing []string
    for _, key := range required {
        if _, ok := os.LookupEnv(key); !ok {
            missing = append(missing, key)
        }
    }
    if len(missing) > 0 {
        log.Fatalf("missing required environment variables: %s", strings.Join(missing, ", "))
    }
    return &Config{
        DatabaseURL:  os.Getenv("DATABASE_URL"),
        JWTSecret:    os.Getenv("JWT_SECRET"),
        KafkaBrokers: strings.Split(os.Getenv("KAFKA_BROKERS"), ","),
        Port:         getEnvOrDefault("PORT", "8080"), // optional — có default hợp lý
    }
}

func getEnvOrDefault(key, fallback string) string {
    if v, ok := os.LookupEnv(key); ok {
        return v
    }
    return fallback
}
```

### 4.2 Advanced — Thứ tự ưu tiên: Flag > Env > Default (chuẩn 12-factor app, Viper cũng làm y hệt bên dưới)

```go
func resolvePort() string {
    // 1. Flag command-line có độ ưu tiên CAO NHẤT (dev override tạm thời)
    flagPort := flag.String("port", "", "server port")
    flag.Parse()
    if *flagPort != "" {
        return *flagPort
    }
    // 2. Environment variable (deployment config — Docker/K8s ConfigMap)
    if v, ok := os.LookupEnv("PORT"); ok {
        return v
    }
    // 3. Default cứng trong code — fallback cuối cùng
    return "8080"
}
```

```
┌────────────────────────────────────────────────────────────┐
│         THỨ TỰ ƯU TIÊN CONFIG (12-FACTOR APP CHUẨN)           │
│                                                              │
│  --port=9000 (flag)  >  PORT=9000 (env)  >  "8080" (default)  │
│                                                              │
│  Đây CHÍNH XÁC là cơ chế Viper ở Bài 19 làm bên dưới          │
│  (v.AutomaticEnv() + v.SetDefault()) — giờ đã hiểu "phép      │
│  màu" đó thực chất là gì                                       │
└────────────────────────────────────────────────────────────┘
```

⚠ **Bảo mật — KHÔNG BAO GIỜ log giá trị env var nhạy cảm khi debug:** `log.Printf("config loaded: %+v", cfg)` in ra CẢ `JWTSecret`, `DatabasePassword` nếu chúng là field exported trong struct — dùng pattern `Format()`/mask đã học ở [[Bai-38-Strings-Fmt-Templates-Regex|Bài 38 mục 2.1]] cho các struct config chứa secret.

---

## 5. Tổng kết Bài 43

```
┌─────────────────────────────────────────────────────────┐
│                   KEY TAKEAWAYS                          │
├─────────────────────────────────────────────────────────┤
│  ✅ os.Args[0] là đường dẫn binary, KHÔNG phải argument     │
│     thật — argument thật bắt đầu từ os.Args[1]              │
│  ✅ flag.Parse() phải gọi TRƯỚC khi deref giá trị con trỏ    │
│     (*name); flag.StringVar bind trực tiếp vào struct field  │
│  ✅ Subcommand = tự dispatch qua os.Args[1] + FlagSet riêng   │
│     cho từng lệnh; chuyển sang cobra khi CLI lớn (>5-6 lệnh)  │
│  ✅ os.Getenv không phân biệt "không tồn tại" vs "rỗng" —      │
│     dùng os.LookupEnv khi cần validate bắt buộc phải có         │
│  ✅ Validate TẤT CẢ env var bắt buộc ngay lúc khởi động        │
│     (fail-fast) thay vì để service crash giữa chừng khi         │
│     chạm tới code cần biến đó                                    │
│  ✅ Thứ tự ưu tiên chuẩn 12-factor: Flag > Env > Default —     │
│     đây chính là cơ chế Viper (Bài 19) làm ngầm bên dưới        │
└─────────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** Bài 44 — TCP Server, Advanced HTTP Client, Process Spawning & Signals (Nhóm 7)

**Liên quan trong vault:** [[Bai-19-Config-Log-Trace|Bài 19]] (Viper — làm y hệt cơ chế mục 4.2 nhưng tự động hoá) · [[Bai-38-Strings-Fmt-Templates-Regex|Bài 38]] (mask secret trong log)

---

**Bài tập:**
1. Viết CLI tool `pdms-cli` với 3 subcommand (`migrate up/down`, `user create/list`, `healthcheck`) dùng pattern switch/case + FlagSet, có `--help` hoạt động đúng ở cả 2 cấp
2. Viết `mustLoadConfig()` đầy đủ validate 5 env var bắt buộc, viết test set/unset env var (dùng `t.Setenv` — Go 1.17+, tự cleanup sau test) verify fail-fast hoạt động đúng
3. Refactor CLI tool ở bài tập 1 sang dùng `cobra`, so sánh lượng code và trải nghiệm `--help` giữa 2 cách
4. Viết hàm resolve config theo đúng thứ tự Flag > Env > Default cho ít nhất 3 tham số, viết test cover đủ 8 tổ hợp có/không có ở mỗi tầng

---
*Tags: #go #cli #flags #subcommands #env-vars #zero-to-hero*
