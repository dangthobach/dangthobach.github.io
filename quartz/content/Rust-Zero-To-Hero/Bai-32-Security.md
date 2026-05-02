# Bài 32: Security — Rate Limiting · Password Hashing · Security Headers

> **Prerequisite:** Bài 11 (Axum Middleware), Bài 13 (JWT), Bài 31 (Redis)  
> **Mục tiêu:** Production security layer — rate limiting với token bucket, password hashing với argon2, security headers, CORS depth, input sanitization, audit logging

---

## 🗺️ Bức Tranh Tổng Quan

```
Security Layers:

  Internet
     │
     ▼
  ┌─────────────────────────────────────────────────────┐
  │  Layer 1: Network (TLS, Firewall) — not Rust        │
  ├─────────────────────────────────────────────────────┤
  │  Layer 2: Security Headers                          │
  │   X-Content-Type-Options, X-Frame-Options, HSTS    │
  ├─────────────────────────────────────────────────────┤
  │  Layer 3: CORS                                      │
  │   Allowed origins, methods, headers                 │
  ├─────────────────────────────────────────────────────┤
  │  Layer 4: Rate Limiting                             │
  │   IP-based, user-based, endpoint-based             │
  ├─────────────────────────────────────────────────────┤
  │  Layer 5: Authentication (JWT / Session)            │
  │   Bài 13 + Bài 31                                  │
  ├─────────────────────────────────────────────────────┤
  │  Layer 6: Authorization (RBAC/ABAC)                 │
  │   Role checks trong handler                         │
  ├─────────────────────────────────────────────────────┤
  │  Layer 7: Input Validation                          │
  │   Bài 30 — validator/garde                          │
  ├─────────────────────────────────────────────────────┤
  │  Layer 8: Data Security                             │
  │   Password hashing, encryption at rest              │
  └─────────────────────────────────────────────────────┘

Java analog:
  Spring Security filter chain
  BCryptPasswordEncoder
  SecurityHeadersWriter
```

---

## PHẦN 1 — Rate Limiting

### 1.1 Rate Limiting Algorithms

```
Token Bucket Algorithm (recommended):
  - Bucket capacity: max_tokens
  - Fill rate: tokens/second
  - Each request consumes 1 token
  - Request rejected nếu bucket trống

  ┌──────────────────────┐
  │    Token Bucket      │
  │  ████████████░░░░░   │  ← current tokens
  │  capacity: 100       │
  │  rate: 10/sec        │
  └──────────────────────┘
  
  → Cho phép burst (đến capacity tokens cùng lúc)
  → Sau đó rate-limit ở fill_rate

Sliding Window:
  - Track request timestamps trong window
  - Count requests trong cửa sổ thời gian
  - Chính xác hơn Fixed Window nhưng tốn memory hơn

Fixed Window:
  - Đếm request trong window cố định (mỗi phút)
  - Đơn giản nhất nhưng có edge case (burst ở ranh giới window)
```

### 1.2 Rate Limiter với governor Crate

```toml
[dependencies]
governor = "0.6"
axum = "0.7"
tower = "0.4"
```

```rust
use governor::{
    clock::DefaultClock,
    middleware::NoOpMiddleware,
    state::{InMemoryState, NotKeyed},
    Quota, RateLimiter,
};
use std::{num::NonZeroU32, sync::Arc, time::Duration};

// Global rate limiter (per app instance)
pub type GlobalLimiter = RateLimiter<NotKeyed, InMemoryState, DefaultClock, NoOpMiddleware>;

pub fn create_rate_limiter(requests_per_second: u32) -> Arc<GlobalLimiter> {
    let quota = Quota::per_second(NonZeroU32::new(requests_per_second).unwrap())
        .allow_burst(NonZeroU32::new(requests_per_second * 2).unwrap()); // 2x burst

    Arc::new(RateLimiter::direct(quota))
}

// Tower middleware với governor
use axum::{
    body::Body,
    http::{Request, Response, StatusCode},
    response::IntoResponse,
};
use tower::{Layer, Service};
use std::task::{Context, Poll};
use pin_project_lite::pin_project;
use futures_util::future::BoxFuture;

#[derive(Clone)]
pub struct RateLimitLayer {
    limiter: Arc<GlobalLimiter>,
}

impl RateLimitLayer {
    pub fn new(rps: u32) -> Self {
        Self {
            limiter: create_rate_limiter(rps),
        }
    }
}

impl<S> Layer<S> for RateLimitLayer {
    type Service = RateLimitService<S>;

    fn layer(&self, service: S) -> Self::Service {
        RateLimitService {
            inner: service,
            limiter: self.limiter.clone(),
        }
    }
}

#[derive(Clone)]
pub struct RateLimitService<S> {
    inner: S,
    limiter: Arc<GlobalLimiter>,
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for RateLimitService<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>> + Clone + Send + 'static,
    S::Future: Send + 'static,
    ReqBody: Send + 'static,
    ResBody: Default + Send + 'static,
{
    type Response = Response<ResBody>;
    type Error = S::Error;
    type Future = BoxFuture<'static, Result<Self::Response, Self::Error>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<ReqBody>) -> Self::Future {
        let limiter = self.limiter.clone();
        let mut inner = self.inner.clone();

        Box::pin(async move {
            match limiter.check() {
                Ok(_) => inner.call(req).await,
                Err(_) => {
                    // Return 429 Too Many Requests
                    Ok(Response::builder()
                        .status(StatusCode::TOO_MANY_REQUESTS)
                        .header("Retry-After", "1")
                        .header("X-RateLimit-Limit", "100")
                        .body(ResBody::default())
                        .unwrap())
                }
            }
        })
    }
}
```

### 1.3 Per-IP Rate Limiting (Redis-backed)

```rust
use std::net::IpAddr;

pub struct IpRateLimiter {
    redis: Arc<RedisClient>,
    max_requests: u32,
    window_secs: u64,
}

impl IpRateLimiter {
    pub fn new(redis: Arc<RedisClient>, max_requests: u32, window_secs: u64) -> Self {
        Self { redis, max_requests, window_secs }
    }

    fn key(ip: &str, endpoint: Option<&str>) -> String {
        match endpoint {
            Some(ep) => format!("rl:ip:{}:{}", ip, ep),
            None => format!("rl:ip:{}", ip),
        }
    }

    // Sliding window counter với Redis
    pub async fn check_and_increment(
        &self,
        ip: &str,
        endpoint: Option<&str>,
    ) -> Result<RateLimitResult, AppError> {
        let key = Self::key(ip, endpoint);
        let mut conn = self.redis.pool.get().await
            .map_err(|e| AppError::Redis(e.to_string()))?;

        // Lua script: atomic increment + TTL set
        let script = r#"
            local current = redis.call("INCR", KEYS[1])
            if current == 1 then
                redis.call("EXPIRE", KEYS[1], ARGV[1])
            end
            local ttl = redis.call("TTL", KEYS[1])
            return {current, ttl}
        "#;

        let result: (i64, i64) = redis::Script::new(script)
            .key(&key)
            .arg(self.window_secs)
            .invoke_async(&mut conn)
            .await
            .map_err(|e| AppError::Redis(e.to_string()))?;

        let (count, ttl) = result;
        let remaining = (self.max_requests as i64 - count).max(0) as u32;

        Ok(RateLimitResult {
            allowed: count <= self.max_requests as i64,
            count: count as u32,
            remaining,
            reset_after_secs: ttl as u64,
            limit: self.max_requests,
        })
    }
}

#[derive(Debug, Clone)]
pub struct RateLimitResult {
    pub allowed: bool,
    pub count: u32,
    pub remaining: u32,
    pub reset_after_secs: u64,
    pub limit: u32,
}

// Axum middleware: IP-based rate limiting
pub async fn ip_rate_limit_middleware(
    State(limiter): State<Arc<IpRateLimiter>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    let ip = addr.ip().to_string();
    let path = req.uri().path().to_string();

    match limiter.check_and_increment(&ip, Some(&path)).await {
        Ok(result) => {
            if !result.allowed {
                return (
                    StatusCode::TOO_MANY_REQUESTS,
                    [
                        ("X-RateLimit-Limit", result.limit.to_string()),
                        ("X-RateLimit-Remaining", "0".to_string()),
                        ("X-RateLimit-Reset", result.reset_after_secs.to_string()),
                        ("Retry-After", result.reset_after_secs.to_string()),
                    ],
                    axum::Json(serde_json::json!({
                        "code": "RATE_LIMIT_EXCEEDED",
                        "message": "Too many requests, please try again later",
                        "retry_after": result.reset_after_secs,
                    })),
                ).into_response();
            }

            let mut response = next.run(req).await;
            let headers = response.headers_mut();
            headers.insert("X-RateLimit-Limit",
                result.limit.to_string().parse().unwrap());
            headers.insert("X-RateLimit-Remaining",
                result.remaining.to_string().parse().unwrap());
            headers.insert("X-RateLimit-Reset",
                result.reset_after_secs.to_string().parse().unwrap());
            response
        }
        Err(_) => {
            // Redis down → fail open (allow request)
            next.run(req).await
        }
    }
}
```

### 1.4 Per-User Rate Limiting

```rust
// Khác nhau theo role: admin > user > anonymous
pub struct UserRateLimiter {
    redis: Arc<RedisClient>,
}

impl UserRateLimiter {
    fn limits_for_role(role: &str) -> (u32, u64) {
        match role {
            "admin" => (1000, 60),    // 1000 req/min
            "user" => (100, 60),      // 100 req/min
            _ => (20, 60),            // 20 req/min (anonymous)
        }
    }

    pub async fn check(
        &self,
        user_id: Option<i64>,
        role: &str,
        endpoint: &str,
    ) -> Result<RateLimitResult, AppError> {
        let (max_requests, window_secs) = Self::limits_for_role(role);

        let key = match user_id {
            Some(id) => format!("rl:user:{}:{}", id, endpoint),
            None => format!("rl:anon:{}", endpoint),
        };

        // Same sliding window logic as IP limiter
        self.sliding_window_check(&key, max_requests, window_secs).await
    }

    async fn sliding_window_check(
        &self,
        key: &str,
        limit: u32,
        window_secs: u64,
    ) -> Result<RateLimitResult, AppError> {
        // Implementation same as IP rate limiter
        todo!()
    }
}
```

---

## PHẦN 2 — Password Hashing

### 2.1 argon2 (Recommended — OWASP 2023)

```toml
[dependencies]
argon2 = "0.5"
password-hash = "0.5"
rand_core = { version = "0.6", features = ["getrandom"] }
```

```rust
use argon2::{
    password_hash::{
        rand_core::OsRng,
        Error as HashError, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
    },
    Argon2, Algorithm, Params, Version,
};

pub struct PasswordService {
    argon2: Argon2<'static>,
}

impl PasswordService {
    pub fn new() -> Self {
        // OWASP recommended params (2023):
        // m=19456 (19 MB memory), t=2 iterations, p=1 parallelism
        let params = Params::new(
            19 * 1024,  // m_cost: 19 MB
            2,          // t_cost: 2 iterations
            1,          // p_cost: 1 thread
            None,
        )
        .expect("Invalid Argon2 params");

        Self {
            argon2: Argon2::new(Algorithm::Argon2id, Version::V0x13, params),
        }
    }

    // Hash password (slow by design — ~100ms)
    pub fn hash(&self, password: &str) -> Result<String, AppError> {
        let salt = SaltString::generate(&mut OsRng);
        
        self.argon2
            .hash_password(password.as_bytes(), &salt)
            .map(|hash| hash.to_string())
            .map_err(|e| AppError::Internal(format!("Password hash failed: {}", e)))
    }

    // Verify password against hash
    pub fn verify(&self, password: &str, hash: &str) -> Result<bool, AppError> {
        let parsed_hash = PasswordHash::new(hash)
            .map_err(|e| AppError::Internal(format!("Invalid hash format: {}", e)))?;

        match self.argon2.verify_password(password.as_bytes(), &parsed_hash) {
            Ok(()) => Ok(true),
            Err(HashError::Password) => Ok(false),  // wrong password — not an error
            Err(e) => Err(AppError::Internal(format!("Verify failed: {}", e))),
        }
    }

    // Check if hash needs rehashing (params upgraded)
    pub fn needs_rehash(&self, hash: &str) -> bool {
        PasswordHash::new(hash)
            .map(|h| self.argon2.hash_password_simple(b"dummy", h.salt.unwrap())
                .map(|new_hash| new_hash.to_string() != hash)
                .unwrap_or(true))
            .unwrap_or(true)
    }
}

// Sử dụng trong handler
pub async fn login_handler(
    State(state): State<AppState>,
    ValidatedJson(dto): ValidatedJson<LoginDto>,
) -> Result<impl IntoResponse, AppError> {
    // 1. Find user
    let user = sqlx::query_as!(User,
        "SELECT id, email, password_hash, role FROM users WHERE email = $1",
        dto.email)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::Unauthorized("Invalid credentials".into()))?;

    // 2. Verify password (trong spawn_blocking vì CPU-intensive)
    let password_service = state.password_service.clone();
    let password = dto.password.clone();
    let hash = user.password_hash.clone();

    let valid = tokio::task::spawn_blocking(move || {
        password_service.verify(&password, &hash)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    if !valid {
        return Err(AppError::Unauthorized("Invalid credentials".into()));
    }

    // 3. Check if needs rehash (security upgrade)
    if state.password_service.needs_rehash(&user.password_hash) {
        let new_hash = state.password_service.hash(&dto.password)?;
        sqlx::query!("UPDATE users SET password_hash = $1 WHERE id = $2",
            new_hash, user.id)
            .execute(&state.db)
            .await?;
    }

    // 4. Issue JWT
    let token = create_jwt(user.id, &user.role, &state.config.jwt_secret)?;

    Ok(Json(serde_json::json!({ "token": token, "user_id": user.id })))
}
```

### 2.2 Timing Attack Prevention

```rust
// QUAN TRỌNG: Luôn verify password kể cả user không tồn tại
// Tránh timing side-channel leak (biết user có tồn tại không)

const DUMMY_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$\
    dummysalt123456789012345678901$\
    dummyhash1234567890123456789012345678901234567";

pub async fn login_safe(
    State(state): State<AppState>,
    ValidatedJson(dto): ValidatedJson<LoginDto>,
) -> Result<impl IntoResponse, AppError> {
    // Find user (may not exist)
    let user = sqlx::query_as!(User,
        "SELECT id, email, password_hash, role FROM users WHERE email = $1",
        dto.email)
        .fetch_optional(&state.db)
        .await?;

    // ALWAYS run password verification, even if user doesn't exist
    // This prevents timing attacks that reveal valid emails
    let hash = user
        .as_ref()
        .map(|u| u.password_hash.as_str())
        .unwrap_or(DUMMY_HASH);

    let password = dto.password.clone();
    let hash = hash.to_string();
    let ps = state.password_service.clone();

    let valid = tokio::task::spawn_blocking(move || ps.verify(&password, &hash))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;

    // Fail with same error regardless of reason
    if !valid || user.is_none() {
        return Err(AppError::Unauthorized("Invalid email or password".into()));
    }

    let user = user.unwrap();
    let token = create_jwt(user.id, &user.role, &state.config.jwt_secret)?;
    Ok(Json(serde_json::json!({ "token": token })))
}
```

### 2.3 Password Policy Validation

```rust
use zxcvbn::zxcvbn;  // Password strength estimator

pub struct PasswordPolicy {
    pub min_length: usize,
    pub require_uppercase: bool,
    pub require_lowercase: bool,
    pub require_digit: bool,
    pub require_special: bool,
    pub min_strength_score: u8,  // 0-4 (zxcvbn score)
}

impl Default for PasswordPolicy {
    fn default() -> Self {
        Self {
            min_length: 12,
            require_uppercase: true,
            require_lowercase: true,
            require_digit: true,
            require_special: true,
            min_strength_score: 3, // "Strong"
        }
    }
}

#[derive(Debug)]
pub struct PolicyViolation {
    pub code: &'static str,
    pub message: String,
}

impl PasswordPolicy {
    pub fn validate(&self, password: &str) -> Vec<PolicyViolation> {
        let mut violations = Vec::new();

        if password.len() < self.min_length {
            violations.push(PolicyViolation {
                code: "too_short",
                message: format!("Password must be at least {} characters", self.min_length),
            });
        }

        if self.require_uppercase && !password.chars().any(|c| c.is_uppercase()) {
            violations.push(PolicyViolation {
                code: "no_uppercase",
                message: "Password must contain at least one uppercase letter".into(),
            });
        }

        if self.require_lowercase && !password.chars().any(|c| c.is_lowercase()) {
            violations.push(PolicyViolation {
                code: "no_lowercase",
                message: "Password must contain at least one lowercase letter".into(),
            });
        }

        if self.require_digit && !password.chars().any(|c| c.is_numeric()) {
            violations.push(PolicyViolation {
                code: "no_digit",
                message: "Password must contain at least one digit".into(),
            });
        }

        if self.require_special && !password.chars().any(|c| "!@#$%^&*()_+-=[]{}|;:,.<>?".contains(c)) {
            violations.push(PolicyViolation {
                code: "no_special",
                message: "Password must contain at least one special character".into(),
            });
        }

        // zxcvbn strength check
        if let Ok(estimate) = zxcvbn(password, &[]) {
            if estimate.score() < self.min_strength_score as u8 {
                let feedback = estimate.feedback()
                    .as_ref()
                    .and_then(|f| f.warning())
                    .map(|w| w.to_string())
                    .unwrap_or_else(|| "Password is too weak".to_string());

                violations.push(PolicyViolation {
                    code: "too_weak",
                    message: feedback,
                });
            }
        }

        violations
    }
}
```

---

## PHẦN 3 — Security Headers

### 3.1 Complete Security Headers Middleware

```rust
use axum::{
    http::{header, HeaderValue, Response},
    middleware::Next,
    response::IntoResponse,
};

pub async fn security_headers_middleware(
    req: axum::extract::Request,
    next: Next,
) -> impl IntoResponse {
    let mut response = next.run(req).await;
    let headers = response.headers_mut();

    // Prevent MIME type sniffing
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );

    // Clickjacking protection
    headers.insert(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("DENY"),
    );

    // XSS protection (legacy, but still good)
    headers.insert(
        "X-XSS-Protection".parse().unwrap(),
        HeaderValue::from_static("1; mode=block"),
    );

    // HSTS: force HTTPS for 1 year + preload
    headers.insert(
        "Strict-Transport-Security".parse().unwrap(),
        HeaderValue::from_static("max-age=31536000; includeSubDomains; preload"),
    );

    // Referrer Policy
    headers.insert(
        "Referrer-Policy".parse().unwrap(),
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );

    // Permissions Policy (replaces Feature-Policy)
    headers.insert(
        "Permissions-Policy".parse().unwrap(),
        HeaderValue::from_static(
            "accelerometer=(), camera=(), geolocation=(), gyroscope=(), \
             magnetometer=(), microphone=(), payment=(), usb=()"
        ),
    );

    // Content Security Policy (tight for API)
    headers.insert(
        "Content-Security-Policy".parse().unwrap(),
        HeaderValue::from_static(
            "default-src 'none'; \
             script-src 'none'; \
             object-src 'none'; \
             frame-ancestors 'none'"
        ),
    );

    // Remove information-leaking headers
    headers.remove("Server");
    headers.remove("X-Powered-By");

    // Cache control for API responses
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );

    response
}
```

### 3.2 CORS — Deep Dive

```rust
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};
use axum::http::{header, Method};
use std::time::Duration;

pub fn cors_layer(allowed_origins: Vec<&str>) -> CorsLayer {
    let origins: Vec<HeaderValue> = allowed_origins
        .iter()
        .filter_map(|o| o.parse().ok())
        .collect();

    CorsLayer::new()
        // Allowed origins (production: specific domains only)
        .allow_origin(AllowOrigin::list(origins))
        // .allow_origin(AllowOrigin::any()) // NEVER in production!

        // Allowed HTTP methods
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])

        // Allowed request headers
        .allow_headers([
            header::AUTHORIZATION,
            header::ACCEPT,
            header::CONTENT_TYPE,
            header::ORIGIN,
            "X-Request-Id".parse().unwrap(),
            "X-Api-Version".parse().unwrap(),
        ])

        // Headers exposed to browser JS
        .expose_headers([
            header::CONTENT_TYPE,
            "X-Request-Id".parse().unwrap(),
            "X-RateLimit-Limit".parse().unwrap(),
            "X-RateLimit-Remaining".parse().unwrap(),
            "X-RateLimit-Reset".parse().unwrap(),
        ])

        // Allow cookies/credentials
        .allow_credentials(true)

        // Cache preflight for 1 hour
        .max_age(Duration::from_secs(3600))
}

// Dynamic CORS based on config
pub fn cors_from_config(config: &CorsConfig) -> CorsLayer {
    if config.allow_any_origin {
        // Development only!
        return CorsLayer::permissive();
    }

    cors_layer(config.allowed_origins.iter().map(|s| s.as_str()).collect())
}
```

---

## PHẦN 4 — Input Sanitization

### 4.1 HTML Sanitization (XSS Prevention)

```toml
[dependencies]
ammonia = "3"  # HTML sanitizer
```

```rust
use ammonia::Builder;

pub struct Sanitizer {
    builder: Builder<'static>,
}

impl Sanitizer {
    pub fn new() -> Self {
        let builder = Builder::default();
        Self { builder }
    }

    // Strip ALL HTML (for plain text fields)
    pub fn strip_html(&self, input: &str) -> String {
        ammonia::clean(input)
    }

    // Allow safe subset of HTML (for rich text fields)
    pub fn sanitize_rich_text(&self, input: &str) -> String {
        Builder::default()
            .tags(std::collections::HashSet::from([
                "p", "br", "strong", "em", "ul", "ol", "li", "a",
            ]))
            .url_schemes(std::collections::HashSet::from(["https"]))
            .link_rel(Some("noopener noreferrer nofollow"))
            .clean(input)
            .to_string()
    }
}

// Automatic sanitization trong DTO
impl CreateDocumentDto {
    pub fn sanitize(&mut self) {
        let sanitizer = Sanitizer::new();
        self.title = sanitizer.strip_html(&self.title);
        if let Some(ref content) = self.content {
            self.content = Some(sanitizer.sanitize_rich_text(content));
        }
    }
}
```

### 4.2 SQL Injection Prevention

```rust
// SQLx's query! macro AUTOMATICALLY prevents SQL injection
// via parameterized queries — không bao giờ concat SQL string

// ❌ SAAT (never do this!)
let user_input = "'; DROP TABLE users; --";
let query = format!("SELECT * FROM users WHERE name = '{}'", user_input);

// ✅ ĐÚNG — parameterized (SQLx tự xử lý)
let user = sqlx::query_as!(User,
    "SELECT * FROM users WHERE name = $1",
    user_input  // escaped automatically
)
.fetch_optional(&pool)
.await?;

// ✅ ĐÚNG — QueryBuilder cũng safe
use sqlx::QueryBuilder;
let mut builder = QueryBuilder::new("SELECT * FROM users WHERE 1=1");
if let Some(name) = filter.name {
    builder.push(" AND name = ");
    builder.push_bind(name);  // safe binding
}
```

---

## PHẦN 5 — Audit Logging

### 5.1 Security Audit Trail

```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
pub struct AuditEvent {
    pub event_id: String,
    pub event_type: AuditEventType,
    pub actor_id: Option<i64>,
    pub actor_ip: String,
    pub target_id: Option<String>,
    pub target_type: Option<String>,
    pub action: String,
    pub result: AuditResult,
    pub metadata: serde_json::Value,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuditEventType {
    Authentication,
    Authorization,
    DataAccess,
    DataMutation,
    AdminAction,
    SecurityEvent,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AuditResult {
    Success,
    Failure,
    Blocked,
}

pub struct AuditLogger {
    db: sqlx::PgPool,
    // Optional: async Kafka producer for high-throughput
}

impl AuditLogger {
    pub async fn log(&self, event: AuditEvent) -> Result<(), AppError> {
        // Non-blocking: log to DB
        let db = self.db.clone();
        tokio::spawn(async move {
            sqlx::query!(
                r#"
                INSERT INTO audit_logs
                    (event_id, event_type, actor_id, actor_ip, target_id, target_type,
                     action, result, metadata, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                "#,
                event.event_id,
                serde_json::to_string(&event.event_type).unwrap(),
                event.actor_id,
                event.actor_ip,
                event.target_id,
                event.target_type,
                event.action,
                serde_json::to_string(&event.result).unwrap(),
                event.metadata,
            )
            .execute(&db)
            .await
            .ok(); // Don't fail the request if audit logging fails
        });
        Ok(())
    }

    pub async fn log_login(&self, user_id: i64, ip: &str, success: bool) {
        let event = AuditEvent {
            event_id: uuid::Uuid::new_v4().to_string(),
            event_type: AuditEventType::Authentication,
            actor_id: Some(user_id),
            actor_ip: ip.to_string(),
            target_id: None,
            target_type: None,
            action: "LOGIN".to_string(),
            result: if success { AuditResult::Success } else { AuditResult::Failure },
            metadata: serde_json::json!({}),
            timestamp: Utc::now(),
        };
        self.log(event).await.ok();
    }

    pub async fn log_document_access(&self, user_id: i64, doc_id: i64, ip: &str) {
        let event = AuditEvent {
            event_id: uuid::Uuid::new_v4().to_string(),
            event_type: AuditEventType::DataAccess,
            actor_id: Some(user_id),
            actor_ip: ip.to_string(),
            target_id: Some(doc_id.to_string()),
            target_type: Some("document".to_string()),
            action: "READ".to_string(),
            result: AuditResult::Success,
            metadata: serde_json::json!({}),
            timestamp: Utc::now(),
        };
        self.log(event).await.ok();
    }
}
```

---

## PHẦN 6 — Full Security Stack Assembly

```rust
// main.rs — kết hợp tất cả security layers

let cors = cors_from_config(&config.cors);
let rate_limiter = Arc::new(IpRateLimiter::new(
    redis.clone(),
    config.rate_limit.max_requests,
    config.rate_limit.window_secs,
));

let app = Router::new()
    .nest("/api/v1", api_routes(state.clone()))
    // Layer order: outer = first to run
    .layer(
        tower::ServiceBuilder::new()
            // 1. Security headers (always)
            .layer(axum::middleware::from_fn(security_headers_middleware))
            // 2. CORS
            .layer(cors)
            // 3. Request ID
            .layer(axum::middleware::from_fn(request_id_middleware))
            // 4. Tracing
            .layer(tower_http::trace::TraceLayer::new_for_http())
            // 5. Rate limiting
            .layer(axum::middleware::from_fn_with_state(
                rate_limiter,
                ip_rate_limit_middleware,
            ))
            // 6. Compression
            .layer(tower_http::compression::CompressionLayer::new())
            // 7. Request body limit
            .layer(tower_http::limit::RequestBodyLimitLayer::new(10 * 1024 * 1024))
    );
```

---

## 🎯 So Sánh Spring Security

| Concept | Spring Security | Rust |
|---|---|---|
| Filter chain | `SecurityFilterChain` | Tower middleware stack |
| CORS | `CorsConfigurationSource` | `tower_http::cors::CorsLayer` |
| Rate limiting | `Bucket4j` / `RateLimiter` | `governor` / Redis Lua |
| Password hash | `BCryptPasswordEncoder` | `argon2` (stronger) |
| Security headers | `HeaderWriterFilter` | Custom middleware |
| CSRF | `CsrfFilter` | Not needed for API-only (JWT) |
| Audit | Custom `ApplicationListener` | `AuditLogger` async |

---

## 🏋️ Bài Tập

1. **Rate Limiting**: Setup IP rate limiting: 100 req/min cho anonymous, 1000 req/min cho authenticated. Test với vegeta hoặc wrk. Verify 429 response với headers.

2. **Password Security**: Implement register/login với argon2. Test timing attack: verify cả valid và invalid email mất thời gian tương đương (~100ms). Implement policy validation.

3. **Security Headers Audit**: Dùng [securityheaders.com](https://securityheaders.com) hoặc viết test với axum-test verify tất cả headers. Missing header = test fail.

4. **Audit Log**: Implement audit trail cho: login, logout, document CRUD. Store trong DB. Expose GET `/admin/audit-logs` với filtering theo user, action, date range.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-31-Redis-Caching|Bài 31: Redis → Rate limit counter storage]]
- [[Rust-Zero-To-Hero/Bai-13-Serde-Reqwest-JWT|Bài 13: JWT]]
- [[Rust-Zero-To-Hero/Bai-33-Background-Jobs|Bài 33: Background Jobs]] → tiếp theo
