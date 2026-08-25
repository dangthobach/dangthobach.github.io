---
type: course
domain: languages/rust
status: active
created: 2026-08-26
updated: 2026-08-26
tags: []
---

# Bài 15c: Logging Ecosystem & Request Logging Thực Chiến

Chào Chuyên gia Java, Bài 15 và 34 đã dùng thẳng `tracing` mà chưa giải thích **tại sao** chọn nó, và log mọi request thì Bài 34 mới dừng ở tầng "span cho observability" (Jaeger). Bài này lấp 2 khoảng trống: chọn đúng thư viện, và log **mọi request/response** một cách thực dụng — điều bạn cần ngay khi vận hành PDMS.

## 1. Bản đồ hệ sinh thái logging Rust — chọn cái nào?

| Crate | Vai trò | Khi dùng |
|---|---|---|
| `log` | Facade tối giản (giống SLF4J) — chỉ định nghĩa macro `info!/warn!/error!`, không tự in ra đâu cả | Thư viện dùng chung, không quyết định implementation |
| `env_logger` | Backend đơn giản cho `log`, in ra stdout theo `RUST_LOG` | CLI tool nhỏ, script, không cần structured log |
| `fern` | Backend linh hoạt hơn cho `log` (nhiều output, custom format) | Khi cần multi-output nhưng vẫn ở hệ `log`, ít dùng trong service hiện đại |
| **`tracing`** | Framework structured, **span-aware** (theo dõi được ngữ cảnh xuyên async task) | **Mặc định cho mọi service production, đặc biệt có async/Tokio** |
| `slog` | Structured logging, ra trước `tracing`, cộng đồng đang giảm dần | Legacy project — không chọn cho project mới |

**Quyết định thực dụng cho PDMS:** luôn dùng `tracing` + `tracing-subscriber`. Lý do cốt lõi không phải "mới hơn là tốt hơn" mà là kỹ thuật: `log` chỉ ghi được **một dòng độc lập**, không biết dòng đó thuộc request nào khi có hàng nghìn task async chạy xen kẽ trên cùng thread pool. `tracing` gắn mỗi log vào 1 **span** (ngữ cảnh) — nhờ đó `request_id`/`trace_id` tự động đi theo, kể cả khi code nhảy qua `.await` nhiều lần và scheduler đổi OS thread giữa chừng (điều `log`+MDC kiểu Java/Log4j **không** làm được đúng trong môi trường async, vì `ThreadLocal` gãy khi task nhảy thread).

## 2. Setup `tracing` — output tối thiểu cần có

```rust
// Cargo.toml
// tracing = "0.1"
// tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
// tracing-appender = "0.2"

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

fn init_logging() -> tracing_appender::non_blocking::WorkerGuard {
    // Non-blocking writer — QUAN TRỌNG: ghi log không được block async runtime
    let (non_blocking, guard) = tracing_appender::non_blocking(std::io::stdout());

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(
            tracing_subscriber::fmt::layer()
                .json()                          // structured JSON — bắt buộc cho log aggregator (Loki/ELK)
                .with_writer(non_blocking)        // không block executor thread khi ghi I/O
                .with_current_span(true)          // tự inject span context (trace_id ở Bài 34) vào mỗi dòng
                .with_target(true)
        )
        .init();

    guard // PHẢI giữ guard sống tới hết main() — drop sớm sẽ mất log cuối cùng chưa flush
}

#[tokio::main]
async fn main() {
    let _guard = init_logging();
    tracing::info!("Service starting");
    // ...
}
```

**Vì sao non-blocking bắt buộc:** `tracing::info!()` trong 1 async handler mà ghi thẳng ra file/stdout đồng bộ (blocking I/O) sẽ **block luôn worker thread của Tokio** trong khoảnh khắc đó — dưới tải cao, hàng nghìn request log cùng lúc có thể làm nghẽn cả service dù logic nghiệp vụ không hề chậm. `tracing-appender::non_blocking` đẩy việc ghi thật sự sang 1 thread riêng qua channel.

**`RUST_LOG` — điều khiển log level không cần recompile:**

```bash
RUST_LOG=info cargo run
RUST_LOG=pdms_core=debug,sqlx=warn,tower_http=info cargo run  # per-module level, giống Logback logger config
```

## 3. Log Mọi Request/Response — Middleware thực dụng

Bài 34 dùng `OtelAxumLayer` cho **tracing span** (phục vụ Jaeger). Nhưng để có **access log** truyền thống (1 dòng JSON gọn cho mỗi request, dễ grep/filter, không cần mở Jaeger) — viết middleware riêng:

```rust
use axum::{extract::Request, middleware::Next, response::Response};
use std::time::Instant;

pub async fn access_log_middleware(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let user_agent = req.headers()
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    let client_ip = req.headers()
        .get("x-forwarded-for") // đứng sau load balancer/ingress — không dùng peer addr trực tiếp
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();

    let start = Instant::now();
    let response = next.run(req).await; // gọi tiếp handler thật
    let elapsed_ms = start.elapsed().as_millis();
    let status = response.status().as_u16();

    // 1 dòng JSON duy nhất mỗi request — trace_id tự có nhờ span context (Bài 34)
    if status >= 500 {
        tracing::error!(%method, %path, status, elapsed_ms, %client_ip, %user_agent, "request completed with server error");
    } else if status >= 400 {
        tracing::warn!(%method, %path, status, elapsed_ms, %client_ip, "request completed with client error");
    } else {
        tracing::info!(%method, %path, status, elapsed_ms, "request completed");
    }

    response
}
```

## 4. Có nên log Request Body / Response Body?

**Không log toàn bộ body mặc định** — 2 lý do thực tế trong bối cảnh banking (PDMS):
1. **Rò rỉ dữ liệu nhạy cảm:** body có thể chứa mật khẩu, token, số CMND/CCCD, thông tin tài khoản — log ra rồi bị đẩy sang Loki/ELK là vi phạm compliance ngay lập tức.
2. **Chi phí:** body lớn (upload file) log hết sẽ làm phình log storage vô ích.

Nếu THẬT SỰ cần debug body (môi trường dev/staging), luôn **redact field nhạy cảm** và **giới hạn kích thước**:

```rust
use serde_json::Value;

const SENSITIVE_FIELDS: &[&str] = &["password", "token", "access_token", "refresh_token", "id_card_number", "card_number"];
const MAX_BODY_LOG_SIZE: usize = 2048; // bytes

fn redact_body(mut body: Value) -> Value {
    if let Value::Object(map) = &mut body {
        for field in SENSITIVE_FIELDS {
            if map.contains_key(*field) {
                map.insert(field.to_string(), Value::String("***REDACTED***".into()));
            }
        }
    }
    body
}

fn truncate_for_log(s: &str) -> String {
    if s.len() > MAX_BODY_LOG_SIZE {
        format!("{}... [truncated, {} bytes total]", &s[..MAX_BODY_LOG_SIZE], s.len())
    } else {
        s.to_string()
    }
}
```

**Quy tắc thực dụng:** log body chỉ nên bật qua feature flag/env var (`LOG_REQUEST_BODY=true`), tắt mặc định ở production, và luôn đi qua redact trước khi bật ở staging.

## 5. Rolling File Appender — khi cần log ra file (bên cạnh stdout cho k8s)

```rust
use tracing_appender::rolling;

let file_appender = rolling::daily("/var/log/pdms", "service.log"); // xoay file mỗi ngày
let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
// Kết hợp cả stdout layer VÀ file layer cùng lúc bằng cách .with() 2 layer trong registry()
```

**Thực tế trên k8s:** hầu hết không cần ghi file — container log ra stdout, Fluent Bit/Promtail đọc stdout của container và đẩy vào Loki/ELK. Rolling file chỉ cần khi chạy bare-metal/VM không có log collector sidecar.

## 6. Distributed Log với `trace_id` — Cross-reference Bài 34

Phần "mọi log line của cùng 1 request, ở CẢ 2-3 service khác nhau, đều mang chung 1 `trace_id` để grep xuyên suốt" — đây chính là nội dung Bài 34 (OpenTelemetry) đã làm chi tiết: `TraceContextPropagator` (W3C `traceparent` header) qua HTTP (reqwest) và gRPC (Tonic metadata), và `tracing-opentelemetry` tự inject `trace_id`/`span_id` vào mọi dòng log JSON. Middleware `access_log_middleware` ở mục 3 **tự động** có `trace_id` trong output miễn là bạn đặt nó SAU `OtelAxumLayer` trong middleware stack (Bài 34 mục 2.2) — vì span context đã được tạo trước đó, mọi `tracing::info!()` gọi sau đều nằm trong span đó.

```rust
// Thứ tự middleware quan trọng — OtelAxumLayer PHẢI ở ngoài cùng để tạo span trước
let app = Router::new()
    .route("/documents", post(create_document))
    .layer(axum::middleware::from_fn(access_log_middleware)) // log dùng trace_id đã có
    .layer(OtelAxumLayer::default()); // tạo span/trace_id trước tiên — layer ngoài cùng chạy trước
```

## 7. Cheat Sheet

| Nhu cầu | Java | Rust |
|---|---|---|
| Log facade | SLF4J | `tracing` (khuyến nghị) hoặc `log` (đơn giản) |
| Structured JSON log | Logstash encoder cho Logback | `tracing-subscriber` `.json()` |
| Context xuyên async (request_id) | MDC — GÃY khi dùng reactive/coroutine | Span — thiết kế đúng cho async từ đầu |
| Non-blocking log I/O | AsyncAppender (Logback) | `tracing-appender::non_blocking` |
| Level theo module | Logback `<logger name="...">` | `RUST_LOG=module=level` |

---
**Bài tập nhỏ:**
1. Setup `tracing-subscriber` với JSON output + non-blocking writer, kiểm tra `RUST_LOG=sqlx=warn,my_app=debug` lọc đúng theo module.
2. Viết `access_log_middleware` như trên, thêm test đảm bảo log level tự đổi giữa info/warn/error theo status code.
3. Viết hàm `redact_body` xử lý JSON lồng nhau (nested object), test với payload chứa field `"user": {"password": "123456"}` — đảm bảo redact đúng cả field lồng sâu, không chỉ top-level.
