# Bài 15: Config, Tracing & Testing — Production Readiness

---

## PHẦN 1 — CONFIG MANAGEMENT

### 1.1 So sánh với Spring Boot Config

```
Spring Boot:
application.yml → @ConfigurationProperties → @Value inject
→ Environment abstraction
→ Profile-based: application-dev.yml, application-prod.yml

Rust:
config crate → layered: defaults → file → env vars → overrides
→ Serde Deserialize vào struct → type-safe, compile-time checked
→ dotenvy → load .env
```

### 1.2 Setup

```toml
[dependencies]
config = "0.14"
dotenvy = "0.15"
serde = { version = "1", features = ["derive"] }
```

### 1.3 Config Struct

```rust
use serde::Deserialize;

#[derive(Debug, Deserialize, Clone)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub kafka: KafkaConfig,
    pub jwt: JwtConfig,
    pub observability: ObservabilityConfig,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub request_timeout_secs: u64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct DatabaseConfig {
    pub url: String,
    pub max_connections: u32,
    pub min_connections: u32,
    pub acquire_timeout_secs: u64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct KafkaConfig {
    pub brokers: String,
    pub consumer_group: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct JwtConfig {
    pub secret: String,
    pub expiry_hours: i64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ObservabilityConfig {
    pub log_level: String,
    pub service_name: String,
}
```

### 1.4 Loader với Layering

```rust
use config::{Config, Environment, File};

pub fn load_config() -> Result<AppConfig, config::ConfigError> {
    // Load .env file nếu có (development convenience)
    dotenvy::dotenv().ok();
    
    Config::builder()
        // Layer 1: defaults
        .set_default("server.host", "0.0.0.0")?
        .set_default("server.port", 3000)?
        .set_default("server.request_timeout_secs", 30)?
        .set_default("database.max_connections", 20)?
        .set_default("database.min_connections", 5)?
        .set_default("database.acquire_timeout_secs", 3)?
        .set_default("observability.log_level", "info")?
        
        // Layer 2: file (nếu tồn tại)
        .add_source(File::with_name("config/default").required(false))
        .add_source(
            File::with_name(&format!("config/{}", 
                std::env::var("APP_ENV").unwrap_or("development".into())
            ))
            .required(false)
        )
        
        // Layer 3: environment variables (ưu tiên cao nhất)
        // APP__SERVER__PORT=8080 → server.port = 8080
        .add_source(
            Environment::with_prefix("APP")
                .prefix_separator("__")
                .separator("__")
        )
        
        .build()?
        .try_deserialize()
}
```

### 1.5 Config File (config/default.toml)

```toml
[server]
host = "0.0.0.0"
port = 3000

[database]
max_connections = 20

[observability]
log_level = "info"
service_name = "pdms-service"
```

```toml
# config/production.toml
[server]
port = 8080

[database]
max_connections = 50
min_connections = 10

[observability]
log_level = "warn"
```

---

## PHẦN 2 — TRACING & STRUCTURED LOGGING

### 2.1 So sánh với Spring (Slf4j + MDC)

```
Spring + Logback:
Logger log = LoggerFactory.getLogger(getClass());
MDC.put("requestId", id);       ← thread-local context
log.info("User created", kv("userId", id));
MDC.clear();

Rust tracing:
let span = info_span!("create_user", user_id = id);
let _guard = span.enter();       ← span context, NOT thread-local
tracing::info!(email = %email, "User created");
// Context propagates across await points — MDC không làm được điều này
```

**Đây là lợi thế lớn:** Spring MDC dùng ThreadLocal — bị mất khi request chuyển sang thread khác (reactive, virtual threads). Rust tracing span propagate qua `.await`.

### 2.2 Setup

```toml
[dependencies]
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
tracing-opentelemetry = "0.22"   # optional: OpenTelemetry export
```

```rust
pub fn init_tracing(config: &ObservabilityConfig) {
    use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
    
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(&config.log_level));
    
    // Development: human-readable format
    // Production: JSON structured logs → ELK/Loki
    #[cfg(debug_assertions)]
    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_target(true)
        .with_level(true);
    
    #[cfg(not(debug_assertions))]
    let fmt_layer = tracing_subscriber::fmt::layer()
        .json()
        .with_current_span(true)
        .with_span_list(false);
    
    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt_layer)
        .init();
}
```

### 2.3 Structured Logging trong Handlers

```rust
use tracing::{error, info, info_span, instrument, warn};

// #[instrument] tự tạo span với tên hàm, log tham số
#[instrument(skip(pool, dto), fields(email = %dto.email))]
pub async fn create_user(
    pool: &PgPool,
    dto: CreateUserDto,
) -> Result<User, AppError> {
    info!("Creating user");
    
    let user = sqlx::query_as!(User, ...)
        .fetch_one(pool)
        .await
        .map_err(|e| {
            error!(err = %e, "Database error creating user");
            AppError::Database(e)
        })?;
    
    info!(user_id = user.id, "User created successfully");
    Ok(user)
}
```

### 2.4 Request ID Middleware với Tracing

```rust
use uuid::Uuid;

pub async fn tracing_middleware(mut req: Request, next: Next) -> Response {
    let request_id = req.headers()
        .get("X-Request-Id")
        .and_then(|h| h.to_str().ok())
        .map(String::from)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    
    let span = info_span!(
        "http_request",
        request_id = %request_id,
        method = %req.method(),
        path = %req.uri().path(),
    );
    
    let response = async move {
        let start = std::time::Instant::now();
        let mut response = next.run(req).await;
        
        let duration = start.elapsed();
        info!(
            status = response.status().as_u16(),
            duration_ms = duration.as_millis(),
            "Request completed"
        );
        
        response.headers_mut()
            .insert("X-Request-Id", request_id.parse().unwrap());
        response
    }
    .instrument(span)
    .await;
    
    response
}
```

---

## PHẦN 3 — TESTING

### 3.1 So sánh Test Ecosystem

```
Java/Spring:
@SpringBootTest       → full context (slow, ~5-30s startup)
@WebMvcTest           → slice test
@DataJpaTest          → DB slice
Mockito               → mock dependencies
@Transactional        → rollback sau test

Rust:
#[cfg(test)]          → unit tests (same file)
axum_test::TestClient → handler test (no network)
#[sqlx::test]         → isolated DB per test (auto rollback)
mockall               → mock traits
cargo test            → parallel by default
```

### 3.2 Unit Tests

```rust
// Trong cùng file với code (Rust convention)
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_password_hash() {
        let password = "secure_password";
        let hash = hash_password(password).unwrap();
        assert!(verify_password(password, &hash).unwrap());
        assert!(!verify_password("wrong", &hash).unwrap());
    }
    
    #[test]
    fn test_claims_expiry() {
        let claims = Claims {
            sub: 1,
            exp: chrono::Utc::now().timestamp() as usize - 1, // already expired
            ..Default::default()
        };
        assert!(claims.is_expired());
    }
    
    #[tokio::test]
    async fn test_async_logic() {
        let result = some_async_computation().await;
        assert_eq!(result, expected_value);
    }
}
```

### 3.3 Handler Integration Tests với axum_test

```toml
[dev-dependencies]
axum-test = "14"
```

```rust
#[cfg(test)]
mod handler_tests {
    use axum_test::TestServer;
    use serde_json::json;
    
    async fn build_test_server() -> TestServer {
        let pool = create_test_pool().await;
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        
        let state = AppState { pool, config: Arc::new(test_config()) };
        let app = build_router(state);
        TestServer::new(app).unwrap()
    }
    
    #[tokio::test]
    async fn test_create_user_success() {
        let server = build_test_server().await;
        
        let response = server
            .post("/api/v1/users")
            .json(&json!({ "name": "Alice", "email": "alice@test.com" }))
            .await;
        
        response.assert_status_created();
        let body: serde_json::Value = response.json();
        assert_eq!(body["name"], "Alice");
        assert!(body["id"].as_i64().unwrap() > 0);
    }
    
    #[tokio::test]
    async fn test_create_user_duplicate_email() {
        let server = build_test_server().await;
        
        let payload = json!({ "name": "Alice", "email": "dup@test.com" });
        server.post("/api/v1/users").json(&payload).await.assert_status_created();
        
        // Second request with same email
        let response = server.post("/api/v1/users").json(&payload).await;
        response.assert_status_bad_request();
        
        let body: serde_json::Value = response.json();
        assert_eq!(body["error"], "bad_request");
    }
    
    #[tokio::test]
    async fn test_protected_route_requires_auth() {
        let server = build_test_server().await;
        
        let response = server.get("/api/v1/profile").await;
        response.assert_status_unauthorized();
    }
    
    #[tokio::test]
    async fn test_protected_route_with_valid_token() {
        let server = build_test_server().await;
        
        let token = create_test_token(1, "user");
        
        let response = server
            .get("/api/v1/profile")
            .add_header("Authorization", format!("Bearer {}", token))
            .await;
        
        response.assert_status_ok();
    }
}
```

### 3.4 Database Tests với sqlx::test

```rust
// sqlx::test tự tạo isolated database per test
// Tự chạy migrations, tự rollback sau test
// Không cần @Transactional hay @DirtiesContext như Spring

#[sqlx::test(migrations = "./migrations")]
async fn test_user_repository_create(pool: PgPool) {
    let repo = UserRepository::new(pool);
    
    let dto = CreateUserDto {
        name: "Bob".to_string(),
        email: "bob@test.com".to_string(),
    };
    
    let user = repo.create(dto).await.unwrap();
    
    assert!(user.id > 0);
    assert_eq!(user.name, "Bob");
    assert_eq!(user.email, "bob@test.com");
}

#[sqlx::test(migrations = "./migrations")]
async fn test_user_repository_find_by_id(pool: PgPool) {
    // Setup
    sqlx::query!(
        "INSERT INTO users (name, email) VALUES ('Charlie', 'charlie@test.com')"
    )
    .execute(&pool)
    .await
    .unwrap();
    
    let user_id: i64 = sqlx::query_scalar!("SELECT id FROM users WHERE email = 'charlie@test.com'")
        .fetch_one(&pool)
        .await
        .unwrap();
    
    let repo = UserRepository::new(pool);
    let found = repo.find_by_id(user_id).await.unwrap();
    
    assert!(found.is_some());
    assert_eq!(found.unwrap().name, "Charlie");
}
```

### 3.5 Mocking với mockall

```rust
use mockall::{automock, predicate::*};

#[automock]
pub trait UserRepository: Send + Sync {
    async fn find_by_id(&self, id: i64) -> Result<Option<User>, AppError>;
    async fn create(&self, dto: CreateUserDto) -> Result<User, AppError>;
}

#[cfg(test)]
mod service_tests {
    use super::*;
    use mockall::predicate::eq;
    
    #[tokio::test]
    async fn test_get_profile_user_not_found() {
        let mut mock_repo = MockUserRepository::new();
        
        mock_repo
            .expect_find_by_id()
            .with(eq(999i64))
            .times(1)
            .returning(|_| Ok(None));
        
        let service = UserService::new(Arc::new(mock_repo));
        let result = service.get_profile(999).await;
        
        assert!(matches!(result, Err(AppError::NotFound(_))));
    }
}
```

### 3.6 Test Organization

```
tests/
├── common/
│   └── mod.rs         ← shared helpers: create_test_pool, create_test_token
├── user_tests.rs      ← handler integration tests cho /users
├── auth_tests.rs      ← auth flow tests
└── order_tests.rs

src/
└── services/
    └── user_service.rs
        └── #[cfg(test)] mod tests { ... }   ← unit tests inline
```

---

## Performance: Test Speed Java vs Rust

```
Spring Boot Integration Test:
  Context startup     : 5-30 giây
  Per test            : 10-100ms
  Suite (100 tests)   : 2-5 phút

Rust Integration Test:
  No startup overhead : 0ms
  Per test            : 5-50ms
  Suite (100 tests)   : 10-30 giây
  Parallel by default : cargo test runs tests concurrently
```

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-11-Axum-Middleware-Error|Bài 11: Middleware cho request ID]]
- [[Rust-Zero-To-Hero/Bai-12-SQLx-Database|Bài 12: sqlx::test]]
- [[Rust-Zero-To-Hero/Bai-16-Deployment|Bài 16: Deployment]]

---
*Bài tập:*
1. Implement full config loading: `config/default.toml` + `config/production.toml` + env var override. Test `APP__SERVER__PORT=9000 cargo run`.
2. Viết integration test suite cho toàn bộ CRUD `/users` endpoint. Cover: success, validation error, not found, duplicate.
3. Implement tracing middleware với request_id propagation. Verify log output có `request_id` field trong mỗi log line.
