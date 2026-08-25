---
type: course
domain: languages/rust
status: active
created: 2026-08-25
updated: 2026-08-25
tags: []
---

# Bài 57 (Dự án 1): CLI Log Parser — Capstone Stage 1 (Core Language)

Đây là dự án tổng hợp đầu tiên, chốt lại toàn bộ Stage 1 (Bài 1-4c, 7, 23, 23b): Cargo, pattern matching, struct/enum, Option/Result, collections, iterator/closure, và giờ thêm 1 mảnh mới — **CLI argument parsing** với `clap`, thứ chưa bài nào trong series chạm tới.

## Mục tiêu

Xây một CLI tool `logcheck` phân tích log file (dạng Apache/Nginx access log hoặc JSON log tự định nghĩa), hỗ trợ nhiều subcommand, trả lỗi kiểu (typed error, không phải `String` chung chung), và xuất kết quả dạng JSON để pipe sang tool khác.

```bash
logcheck count --file access.log --status 500          # đếm số dòng có status 500
logcheck top-ip --file access.log --limit 10            # top 10 IP truy cập nhiều nhất
logcheck errors --file access.log --format json         # xuất tất cả lỗi dạng JSON
```

## 1. CLI Argument Parsing với `clap` (derive API)

```rust
// Cargo.toml: clap = { version = "4", features = ["derive"] }
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "logcheck", version, about = "Phân tích access log")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Count {
        #[arg(long)]
        file: String,
        #[arg(long)]
        status: Option<u16>,
    },
    TopIp {
        #[arg(long)]
        file: String,
        #[arg(long, default_value_t = 10)]
        limit: usize,
    },
    Errors {
        #[arg(long)]
        file: String,
        #[arg(long, default_value = "text")]
        format: String,
    },
}

fn main() {
    let cli = Cli::parse(); // clap tự generate --help, validate, báo lỗi usage — không cần tự viết
    match cli.command {
        Commands::Count { file, status } => run_count(&file, status),
        Commands::TopIp { file, limit } => run_top_ip(&file, limit),
        Commands::Errors { file, format } => run_errors(&file, &format),
    }
}
```

So với Java: `clap` derive tương đương Picocli với annotation `@Command`/`@Option` — nhưng compile-time, không reflection, và `--help` được sinh tự động từ chính doc comment.

## 2. Typed Error — dùng lại Bài 3c (`From`) + Bài 8 (`thiserror`)

```rust
use thiserror::Error;

#[derive(Debug, Error)]
enum LogCheckError {
    #[error("không đọc được file '{path}': {source}")]
    FileRead { path: String, #[source] source: std::io::Error },

    #[error("dòng log không đúng định dạng tại line {line}: {content}")]
    ParseError { line: usize, content: String },

    #[error("lỗi serialize JSON: {0}")]
    Json(#[from] serde_json::Error), // tự động From<serde_json::Error> — liên hệ Bài 3c
}

fn read_log(path: &str) -> Result<String, LogCheckError> {
    std::fs::read_to_string(path)
        .map_err(|e| LogCheckError::FileRead { path: path.to_string(), source: e })
}
```

**Nguyên tắc:** hàm nội bộ (`read_log`, `parse_line`) trả `Result<T, LogCheckError>` cụ thể; chỉ ở `main()` mới convert sang exit code + message cho user — không dùng `unwrap()`/`expect()` ở tầng xử lý logic (chỉ chấp nhận ở test hoặc script một lần dùng).

## 3. Parse dòng log bằng Pattern Matching + Collections (Bài 3b, 4b)

```rust
struct LogEntry {
    ip: String,
    status: u16,
    path: String,
}

fn parse_line(line: &str, line_no: usize) -> Result<LogEntry, LogCheckError> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    match parts.as_slice() {
        [ip, _, _, _, _, _, path, status_str, ..] => {
            let status = status_str.parse::<u16>()
                .map_err(|_| LogCheckError::ParseError { line: line_no, content: line.to_string() })?;
            Ok(LogEntry { ip: ip.to_string(), status, path: path.to_string() })
        }
        _ => Err(LogCheckError::ParseError { line: line_no, content: line.to_string() }),
    }
}

fn top_ips(entries: &[LogEntry], limit: usize) -> Vec<(String, usize)> {
    use std::collections::HashMap;
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for e in entries {
        *counts.entry(&e.ip).or_insert(0) += 1; // Entry API — Bài 4b
    }
    let mut v: Vec<(String, usize)> = counts.into_iter().map(|(k, c)| (k.to_string(), c)).collect();
    v.sort_by(|a, b| b.1.cmp(&a.1));
    v.truncate(limit);
    v
}
```

## 4. JSON Output với `serde`

```rust
use serde::Serialize;

#[derive(Serialize)]
struct ErrorReport {
    line: usize,
    ip: String,
    status: u16,
    path: String,
}

fn print_json(reports: &[ErrorReport]) -> Result<(), LogCheckError> {
    let json = serde_json::to_string_pretty(reports)?; // ? tự convert nhờ #[from] ở trên
    println!("{json}");
    Ok(())
}
```

## 5. Kiến trúc & Test

```
src/
  main.rs      <- chỉ parse CLI args + gọi lib, KHÔNG chứa logic
  lib.rs       <- re-export public API
  parser.rs    <- parse_line, đơn vị test dễ nhất vì pure function
  error.rs     <- LogCheckError
  commands.rs  <- run_count, run_top_ip, run_errors
tests/
  cli_integration.rs  <- gọi binary thật qua assert_cmd, kiểm tra exit code + stdout
```

```rust
// tests/cli_integration.rs — integration test cho CLI thật (Bài 15b)
use assert_cmd::Command;

#[test]
fn count_status_500() {
    Command::cargo_bin("logcheck").unwrap()
        .args(["count", "--file", "tests/fixtures/sample.log", "--status", "500"])
        .assert()
        .success()
        .stdout(predicates::str::contains("3")); // giả sử fixture có 3 dòng 500
}
```

## Checklist hoàn thành

- [ ] 3 subcommand hoạt động đúng qua `clap`
- [ ] Toàn bộ lỗi đi qua `LogCheckError` (thiserror), không có `unwrap()` ngoài test
- [ ] `parse_line` có unit test cho cả input hợp lệ và input rác (Bài 3b: pattern matching trên slice)
- [ ] Output JSON hợp lệ, parse lại được bằng `serde_json::from_str`
- [ ] Có ít nhất 1 integration test dùng `assert_cmd` gọi binary thật

---
**Mở rộng (tùy chọn):** thêm subcommand `watch --file access.log` dùng `notify` crate để tail file real-time — bước đệm tự nhiên sang Stage 4 (async/Tokio) vì tail file liên tục là bài toán I/O-bound kinh điển.
