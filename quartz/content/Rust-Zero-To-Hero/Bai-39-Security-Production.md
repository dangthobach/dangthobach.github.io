---
tags: [rust, axum, leptos, dioxus, security, cors, rate-limiting, validation, production]
prerequisites: [Bai-24-Axum-Advanced, Bai-29-Leptos, Bai-36-Dioxus-Core]
next: Bai-40-Global-State
---

# Bài 39: Security & Traffic Control — Production-Ready

> **Áp dụng cho:** Axum (backend) · Leptos (fullstack) · Dioxus (fullstack)  
> **Mục tiêu:** CORS đúng chuẩn, Rate Limiting, Input Validation — 3 lớp bảo vệ không thể thiếu

---

## 🗺️ Bức Tranh Tổng Quan

```
                    INTERNET
                        │
                        ▼
            ┌───────────────────────┐
            │   LAYER 1: CORS       │  ← Chặn request từ origin không được phép
            │   (trước khi vào app) │
            └───────────┬───────────┘
                        │
                        ▼
            ┌───────────────────────┐
            │  LAYER 2: RATE LIMIT  │  ← Chặn flood/abuse (per IP hoặc per User)
            │  (đếm request)        │
            └───────────┬───────────┘
                        │
                        ▼
            ┌───────────────────────┐
            │  LAYER 3: VALIDATION  │  ← Kiểm tra data trước khi xử lý
            │  (trước khi handler)  │
            └───────────┬───────────┘
                        │
                        ▼
                   Handler Logic
                   (DB, Business)

3 lớp xếp từ ngoài vào trong.
Lỗi ở lớp ngoài → reject sớm → tiết kiệm tài nguyên.
```

---

## PHẦN 1 — CORS

### 1.1 Bản Chất CORS

```
Vấn đề:
  Browser tại https://pdms.vpbank.com
       │ fetch("https://api.vpbank.com/documents")
       ▼
  api.vpbank.com nhận request
       │ Response có "Access-Control-Allow-Origin"?
  ┌────┴────┐
  │  Có     │  Browser cho phép JS đọc response ✅
  │  Không  │  Browser block response ❌ (CORS error)
  └─────────┘

⚠️ CORS là browser policy — curl/Postman/server-to-server KHÔNG bị ảnh hưởng.
   CORS chỉ bảo vệ user khỏi malicious website đọc data của họ.

Preflight — khi nào xảy ra?
  POST/PUT/DELETE với JSON body → Browser tự gửi OPTIONS trước:

  OPTIONS /api/documents
  Origin: https://pdms.vpbank.com
  Access-Control-Request-Method: POST
  Access-Control-Request-Headers: content-type, authorization

  Server phải trả:
  Access-Control-Allow-Origin: https://pdms.vpbank.com
  Access-Control-Allow-Methods: GET, POST, PUT, DELETE
  Access-Control-Allow-Headers: content-type, authorization
  Access-Control-Max-Age: 3600     ← cache preflight 1 giờ
```

### 1.2 Axum — CorsLayer

```rust
// Cargo.toml: tower-http = { version = "0.5", features = ["cors"] }

use tower_http::cors::{CorsLayer, AllowOrigin, AllowHeaders, AllowMethods};
use http::{HeaderValue, Method, header};

// ❌ SAI — wildcard không dùng được với credentials
fn cors_wrong() -> CorsLayer {
    CorsLayer::new().allow_origin(tower_http::cors::Any)
}

// ✅ ĐÚNG — production config
fn cors_production(allowed_origins: Vec<String>) -> CorsLayer {
    let origins: Vec<HeaderValue> = allowed_origins
        .iter()
        .filter_map(|o| o.parse().ok())
        .collect();

    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([
            Method::GET, Method::POST, Method::PUT,
            Method::DELETE, Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::ACCEPT,
            "x-request-id".parse().unwrap(),
        ])
        .expose_headers([
            "x-ratelimit-remaining".parse::<HeaderValue>().unwrap(),
        ])
        .allow_credentials(true)           // Bắt buộc nếu dùng cookies
        .max_age(std::time::Duration::from_secs(3600))
}

fn build_router(config: &AppConfig) -> Router {
    Router::new()
        .route("/api/documents", get(list_documents).post(create_document))
        .layer(cors_production(config.allowed_origins.clone()))
}
```

```
💡 TIP — Khi nào Leptos/Dioxus cần CORS?
  Cùng binary (Leptos SSR, Axum serve cả frontend+API): KHÔNG cần
  Frontend deploy riêng (WASM trên CDN, gọi API khác domain): CẦN
  Mobile app (Dioxus Mobile) gọi API: CẦN
```

---

## PHẦN 2 — Rate Limiting

### 2.1 Bản Chất

```
Token Bucket algorithm:

  Mỗi IP/User có 1 bucket:
  ┌─────────────────────────────────────┐
  │  Capacity: 100 tokens               │
  │  Refill: +10 tokens/giây            │
  │                                     │
  │  Mỗi request dùng 1 token           │
  │  Hết token → 429 Too Many Requests  │
  └─────────────────────────────────────┘

In-Memory vs Distributed:

  In-Memory (1 server)           Redis (multi-server)
  ┌──────────────┐                ┌───┐   ┌───┐   ┌───┐
  │ HashMap      │                │ A │   │ B │   │ C │
  │ IP → count   │                └─┬─┘   └─┬─┘   └─┬─┘
  └──────────────┘                  └────────┼────────┘
  ✅ Đơn giản                                │
  ❌ Không scale                        ┌────▼────┐
  ❌ Reset khi restart                  │  Redis  │ ← shared counter
                                        └─────────┘
                                   ✅ Scale được
                                   ✅ Persist
```

### 2.2 In-Memory Rate Limiting

```rust
use axum::{extract::{ConnectInfo, State}, middleware, response::Response};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone)]
struct RateLimiter {
    store: Arc<Mutex<HashMap<String, (u32, Instant)>>>,
    max_requests: u32,
    window: Duration,
}

impl RateLimiter {
    fn new(max_requests: u32, window: Duration) -> Self {
        Self {
            store: Arc::new(Mutex::new(HashMap::new())),
            max_requests,
            window,
        }
    }

    fn check_and_increment(&self, key: &str) -> Result<u32, ()> {
        let mut store = self.store.lock().unwrap();
        let now = Instant::now();
        let entry = store.entry(key.to_string()).or_insert((0, now));

        if now.duration_since(entry.1) > self.window {
            *entry = (0, now);  // Reset window
        }
        entry.0 += 1;

        if entry.0 > self.max_requests { Err(()) }
        else { Ok(self.max_requests - entry.0) }
    }
}

async fn rate_limit_middleware(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(limiter): State<RateLimiter>,
    request: axum::extract::Request,
    next: middleware::Next,
) -> Response {
    match limiter.check_and_increment(&addr.ip().to_string()) {
        Ok(remaining) => {
            let mut resp = next.run(request).await;
            resp.headers_mut().insert(
                "x-ratelimit-remaining",
                remaining.to_string().parse().unwrap(),
            );
            resp
        }
        Err(_) => axum::response::Response::builder()
            .status(429)
            .header("retry-after", "60")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(
                r#"{"error":"rate_limit_exceeded","message":"Thử lại sau 60 giây"}"#
            ))
            .unwrap(),
    }
}

fn build_router() -> Router {
    let limiter = RateLimiter::new(100, Duration::from_secs(60));
    Router::new()
        .route("/api/documents", get(list_documents))
        .layer(middleware::from_fn_with_state(limiter, rate_limit_middleware))
}
```

### 2.3 Distributed Rate Limiting với Redis

```rust
// Cargo.toml: deadpool-redis = "0.14"

use deadpool_redis::Pool;
use redis::AsyncCommands;

#[derive(Clone)]
struct RedisRateLimiter {
    pool: Pool,
    max_requests: u64,
    window_secs: u64,
}

impl RedisRateLimiter {
    async fn check(&self, key: &str) -> Result<RateLimitResult, anyhow::Error> {
        let mut conn = self.pool.get().await?;

        // Lua script — atomic INCR + EXPIRE (không có race condition)
        let script = redis::Script::new(r#"
            local n = redis.call('INCR', KEYS[1])
            if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
            return n
        "#);

        let count: u64 = script
            .key(format!("rl:{key}"))
            .arg(self.window_secs)
            .invoke_async(&mut conn)
            .await?;

        if count > self.max_requests {
            Ok(RateLimitResult::Exceeded)
        } else {
            Ok(RateLimitResult::Allowed { remaining: self.max_requests - count })
        }
    }
}

enum RateLimitResult {
    Allowed { remaining: u64 },
    Exceeded,
}

// Smart key: ưu tiên User ID, fallback về IP
async fn smart_rate_limit_mw(
    headers: axum::http::HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(limiter): State<RedisRateLimiter>,
    request: axum::extract::Request,
    next: middleware::Next,
) -> Response {
    // Nếu đã auth → dùng user_id làm key (fair per user)
    // Chưa auth → dùng IP (protect login endpoint)
    let key = headers
        .get("x-user-id")
        .and_then(|v| v.to_str().ok())
        .map(|id| format!("user:{id}"))
        .unwrap_or_else(|| format!("ip:{}", addr.ip()));

    match limiter.check(&key).await {
        Ok(RateLimitResult::Allowed { remaining }) => {
            let mut resp = next.run(request).await;
            resp.headers_mut().insert(
                "x-ratelimit-remaining",
                remaining.to_string().parse().unwrap(),
            );
            resp
        }
        Ok(RateLimitResult::Exceeded) => axum::response::Response::builder()
            .status(429)
            .body(axum::body::Body::from(r#"{"error":"rate_limit_exceeded"}"#))
            .unwrap(),
        Err(_) => next.run(request).await, // Redis lỗi → fail open
    }
}
```

```
💡 Rate limit strategy theo endpoint:
  /api/login        →  5 req/min per IP   (brute force protection)
  /api/documents    →  200 req/min per user
  /api/search       →  30 req/min per user
  /api/file-upload  →  10 req/hour per user
```

---

## PHẦN 3 — Input Validation

### 3.1 Bản Chất

```
Validation Pipeline:

  JSON body từ client
       │
       ▼
  STEP 1: Deserialization (serde_json)
       │  Lỗi: wrong type, missing required field
       ▼
  STEP 2: Business Validation (validator crate)
       │  Lỗi: email format, range, min/max length
       ▼
  Handler Logic (an toàn để xử lý)

Isomorphic Validation — dùng CHUNG 1 struct:

  ┌─────────────────────────────────────┐
  │         shared/src/models.rs        │
  │  #[derive(Validate, Serialize,      │
  │           Deserialize)]             │
  │  struct CreateDocumentRequest {...} │
  └──────────────┬──────────────────────┘
                 │
        ┌────────┴────────┐
        ▼                 ▼
  Client (WASM)     Server (Axum)
  Validate trước    Validate lại
  submit (UX)       (security)

→ Một lần định nghĩa rule, dùng ở cả 2 đầu.
```

### 3.2 Axum — ValidatedJson Extractor

```rust
// Cargo.toml: validator = { version = "0.18", features = ["derive"] }

use axum::{async_trait, extract::{FromRequest, Request}, Json};
use serde::{Deserialize, Serialize};
use validator::Validate;

#[derive(Debug, Deserialize, Validate)]
pub struct CreateUserRequest {
    #[validate(length(min = 2, max = 100, message = "Tên phải từ 2-100 ký tự"))]
    pub name: String,

    #[validate(email(message = "Email không hợp lệ"))]
    pub email: String,

    #[validate(length(min = 8, message = "Mật khẩu tối thiểu 8 ký tự"))]
    #[validate(custom(function = "validate_password_strength"))]
    pub password: String,

    #[validate(range(min = 18, max = 120, message = "Tuổi phải từ 18-120"))]
    pub age: u32,
}

fn validate_password_strength(pw: &str) -> Result<(), validator::ValidationError> {
    let ok = pw.chars().any(|c| c.is_uppercase())
        && pw.chars().any(|c| c.is_numeric());
    if ok { return Ok(()); }
    let mut e = validator::ValidationError::new("weak_password");
    e.message = Some("Mật khẩu phải có chữ hoa và số".into());
    Err(e)
}

// Custom Extractor: parse JSON rồi validate tự động
pub struct ValidatedJson<T>(pub T);

#[async_trait]
impl<T, S> FromRequest<S> for ValidatedJson<T>
where
    T: serde::de::DeserializeOwned + Validate,
    S: Send + Sync,
{
    type Rejection = (axum::http::StatusCode, axum::Json<serde_json::Value>);

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let Json(value) = Json::<T>::from_request(req, state)
            .await
            .map_err(|e| (
                axum::http::StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "parse_error", "message": e.to_string()})),
            ))?;

        value.validate().map_err(|errors| {
            let fields: Vec<_> = errors.field_errors()
                .iter()
                .flat_map(|(field, errs)| errs.iter().map(move |e| serde_json::json!({
                    "field": field,
                    "message": e.message.as_ref().map(|m| m.as_ref()).unwrap_or("invalid"),
                })))
                .collect();

            (
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({"error": "validation_error", "fields": fields})),
            )
        })?;

        Ok(ValidatedJson(value))
    }
}

// Handler — clean và đơn giản
async fn create_user(
    ValidatedJson(req): ValidatedJson<CreateUserRequest>,
) -> impl axum::response::IntoResponse {
    // req đã validate xong: email đúng, password đủ mạnh, age hợp lệ
    axum::Json(serde_json::json!({"message": format!("Tạo user {} OK", req.name)}))
}
```

### 3.3 Isomorphic Validation — Shared Crate

```toml
# shared/Cargo.toml — KHÔNG có platform-specific deps
[dependencies]
serde = { version = "1", features = ["derive"] }
validator = { version = "0.18", features = ["derive"] }
# Không có: axum, tokio, reqwest, wasm-bindgen
```

```rust
// shared/src/models.rs — compile được cả server lẫn WASM

use serde::{Deserialize, Serialize};
use validator::Validate;

#[derive(Debug, Clone, Serialize, Deserialize, Validate, PartialEq)]
pub struct CreateDocumentRequest {
    #[validate(length(min = 3, max = 200, message = "Tiêu đề 3-200 ký tự"))]
    pub title: String,

    #[validate(length(max = 5000, message = "Mô tả tối đa 5000 ký tự"))]
    pub description: Option<String>,

    #[validate(custom(function = "validate_doc_type"))]
    pub doc_type: String,

    #[validate(range(min = 1, max = 100, message = "Số trang 1-100"))]
    pub page_count: u32,
}

pub fn validate_doc_type(t: &str) -> Result<(), validator::ValidationError> {
    if ["CONTRACT", "REPORT", "INVOICE", "OTHER"].contains(&t) {
        return Ok(());
    }
    let mut e = validator::ValidationError::new("invalid_doc_type");
    e.message = Some("Loại tài liệu không hợp lệ".into());
    Err(e)
}
```

```rust
// Leptos form — validate real-time ở client
use leptos::prelude::*;
use validator::Validate;
use shared::models::CreateDocumentRequest;

#[component]
fn DocumentForm() -> impl IntoView {
    let (form, set_form) = signal(CreateDocumentRequest {
        title: String::new(),
        description: None,
        doc_type: "CONTRACT".to_string(),
        page_count: 1,
    });

    let errors = move || form.get().validate().err();

    view! {
        <form on:submit=move |ev| {
            ev.prevent_default();
            if form.get().validate().is_ok() {
                spawn_local(async move { let _ = create_document_sf(form.get()).await; });
            }
        }>
            <div class="field">
                <label>"Tiêu đề"</label>
                <input
                    type="text"
                    prop:value=move || form.get().title.clone()
                    on:input=move |e| {
                        let mut f = form.get();
                        f.title = event_target_value(&e);
                        set_form.set(f);
                    }
                />
                // Real-time error
                {move || errors().and_then(|e| {
                    e.field_errors().get("title").map(|errs| view! {
                        <span class="error">
                            {errs[0].message.as_ref().map(|m| m.to_string()).unwrap_or_default()}
                        </span>
                    })
                })}
            </div>
            <button type="submit">"Tạo tài liệu"</button>
        </form>
    }
}
```

```rust
// Dioxus form — cùng struct, cùng validate
use dioxus::prelude::*;
use shared::models::CreateDocumentRequest;
use validator::Validate;

#[component]
fn DioxusDocumentForm() -> Element {
    let mut form = use_signal(|| CreateDocumentRequest {
        title: String::new(),
        description: None,
        doc_type: "CONTRACT".to_string(),
        page_count: 1,
    });

    let errors = use_memo(move || form.read().validate().err());

    rsx! {
        form {
            div { class: "field",
                label { "Tiêu đề" }
                input {
                    r#type: "text",
                    value: "{form.read().title}",
                    oninput: move |e| form.write().title = e.value(),
                }
                if let Some(errs) = errors.read().as_ref() {
                    if let Some(title_errs) = errs.field_errors().get("title") {
                        span { class: "error",
                            {title_errs[0].message.as_ref()
                                .map(|m| m.to_string()).unwrap_or_default()}
                        }
                    }
                }
            }
            button { r#type: "submit", "Tạo tài liệu" }
        }
    }
}
```

---

## PHẦN 4 — Kết Hợp 3 Lớp

```rust
pub async fn build_secure_app(config: &AppConfig) -> Router {
    let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .expect("Redis pool failed");

    let rate_limiter = RedisRateLimiter {
        pool: redis_pool,
        max_requests: 100,
        window_secs: 60,
    };

    Router::new()
        .route("/api/users", axum::routing::post(create_user))
        .route("/api/documents", axum::routing::post(create_document_handler))
        // Layer 3: Validation xảy ra trong handler (ValidatedJson extractor)
        // Layer 2: Rate Limiting
        .layer(middleware::from_fn_with_state(rate_limiter, smart_rate_limit_mw))
        // Layer 1: CORS — ngoài cùng
        .layer(cors_production(config.allowed_origins.clone()))
}

async fn create_document_handler(
    ValidatedJson(req): ValidatedJson<CreateDocumentRequest>,
) -> impl axum::response::IntoResponse {
    // Đến đây: CORS ✅  Rate Limit ✅  Validation ✅
    axum::Json(serde_json::json!({"status": "created", "title": req.title}))
}
```

---

## 💡 Tips & Tricks

```
TIP 1 — Debug CORS nhanh
  curl kiểm tra preflight (không bị browser block):
  curl -v -X OPTIONS https://api.vpbank.com/documents \
       -H "Origin: https://pdms.vpbank.com" \
       -H "Access-Control-Request-Method: POST"
  
  Cần thấy trong response:
  Access-Control-Allow-Origin: https://pdms.vpbank.com
  Access-Control-Allow-Methods: POST
  
  ❌ Không thấy → CorsLayer chưa được apply đúng layer thứ tự.

TIP 2 — Rate limit per endpoint khác nhau
  // Mỗi route group có limiter riêng
  let login_limiter = RateLimiter::new(5, Duration::from_secs(60));
  let api_limiter = RateLimiter::new(200, Duration::from_secs(60));
  
  Router::new()
      .route("/auth/login", post(login_handler))
      .layer(middleware::from_fn_with_state(login_limiter, rate_limit_middleware))
      .merge(
          Router::new()
              .route("/api/documents", get(list_docs))
              .layer(middleware::from_fn_with_state(api_limiter, rate_limit_middleware))
      )

TIP 3 — Validation error phải human-readable
  ❌ {"error": "min_length"}
  ✅ {"error": "validation_error", "fields": [
       {"field": "email", "message": "Email không hợp lệ"},
       {"field": "password", "message": "Mật khẩu phải có chữ hoa và số"}
     ]}

TIP 4 — Shared crate workspace layout
  my-pdms/
  ├── shared/         ← Cargo.toml: chỉ serde + validator
  │   └── src/models.rs
  ├── server/         ← depend on shared, có axum/tokio
  └── client/         ← depend on shared, target wasm32
  
  Không được import axum/tokio trong shared/
  → Đảm bảo compile được cho WASM target.

TIP 5 — Fail open vs fail closed khi Redis lỗi
  Banking: fail open (cho request qua, ghi log, alert)
  → Không block giao dịch vì Redis tạm thời không phản hồi.
  
  Security-critical endpoint: fail closed (trả 503)
  → Tốt hơn deny service còn hơn để attack qua.
```

---

## 📝 Exercises

1. **CORS Dynamic Config**: `CorsLayer` đọc allowed origins từ env var `ALLOWED_ORIGINS=https://a.com,https://b.com`. Parse và tạo dynamic origin list. Viết unit test kiểm tra origin không hợp lệ bị reject.

2. **Per-Route Rate Limit**: Implement rate limiting khác nhau: `/auth/login` → 5/min, `/api/documents` → 200/min, `/api/search` → 30/min. Mỗi route group dùng limiter riêng.

3. **Isomorphic Form**: Tạo workspace 3 crates (shared, server, client-leptos). `CreateContractRequest` với 5 fields có validation. Leptos form validate real-time, server function validate lại trước khi insert DB.

4. **Validation Localization**: Extend `ValidatedJson` để đọc `Accept-Language` header, trả error message tiếng Việt hoặc tiếng Anh tùy header.

5. **Integration Test**: Viết test tự động kiểm tra: (a) origin không cho phép → bị reject, (b) quá 5 req/min trên `/auth/login` → 429, (c) email sai format → 422 với field error đúng.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-24-Axum-Advanced|Bài 24: Axum Advanced]] — middleware foundation
- [[Rust-Zero-To-Hero/Bai-29-Leptos|Bài 29: Leptos]] — server functions context
- [[Rust-Zero-To-Hero/Bai-36-Dioxus-Core|Bài 36: Dioxus Core]] — form handling
- [[Rust-Zero-To-Hero/Bai-40-Global-State|Bài 40: Global State Management]] → tiếp theo
