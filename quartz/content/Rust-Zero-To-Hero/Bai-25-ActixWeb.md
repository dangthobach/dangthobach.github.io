# Bài 25: ActixWeb — Full Course từ Cơ Bản đến Nâng Cao

> **Prerequisite:** Bài 9 (Tokio) + Bài 10-11 (Axum) — biết Axum giúp học ActixWeb nhanh hơn nhiều  
> **Mục tiêu:** Build production REST API với ActixWeb, hiểu kiến trúc actor-based, so sánh tường minh với Axum và Spring Boot

---

## 🗺️ Bức Tranh Tổng Quan

```
ActixWeb Architecture:
                    ┌────────────────────────────────┐
                    │         HttpServer             │
                    │  .workers(N) = N OS threads    │
                    └────────────┬───────────────────┘
                                 │ mỗi thread spawn
                    ┌────────────▼───────────────────┐
                    │    actix-web worker thread     │
                    │  ┌──────────────────────────┐  │
                    │  │      App (per thread)    │  │
                    │  │  middleware stack        │  │
                    │  │  routes                  │  │
                    │  │  app_data (cloned)       │  │
                    │  └──────────────────────────┘  │
                    └────────────────────────────────┘

So sánh với Axum:
  Axum:     1 tokio multi-thread runtime, tasks share threads
  ActixWeb: N OS threads, mỗi thread có actix runtime riêng

Java analog: Axum ≈ Spring WebFlux | ActixWeb ≈ Vert.x (event loop per thread)
```

---

## PHẦN 1 — Setup & Hello World

### 1.1 Dependencies

```toml
[dependencies]
actix-web = "4"
actix-rt = "2"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "1"
sqlx = { version = "0.7", features = ["postgres", "runtime-tokio", "chrono", "uuid"] }
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
tracing = "0.1"
tracing-actix-web = "0.7"
actix-multipart = "0.7"
actix-ws = "0.3"
```

### 1.2 Minimal Server

```rust
use actix_web::{web, App, HttpServer, HttpResponse, Responder};

// Handler — function trả về impl Responder
async fn hello() -> impl Responder {
    HttpResponse::Ok().body("Hello from ActixWeb!")
}

async fn health_check() -> impl Responder {
    HttpResponse::Ok().json(serde_json::json!({
        "status": "healthy",
        "version": env!("CARGO_PKG_VERSION")
    }))
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .route("/", web::get().to(hello))
            .route("/health", web::get().to(health_check))
    })
    .bind("0.0.0.0:8080")?
    .run()
    .await
}
```

**Java analog:**
```java
@SpringBootApplication
public class App { ... }
@RestController
class HelloController {
    @GetMapping("/") String hello() { return "Hello!"; }
}
```

---

## PHẦN 2 — Routing

### 2.1 Routing Styles

```rust
use actix_web::{web, HttpResponse};

// Style 1: route() method (flexible)
App::new()
    .route("/users", web::get().to(list_users))
    .route("/users", web::post().to(create_user))
    .route("/users/{id}", web::get().to(get_user))
    .route("/users/{id}", web::put().to(update_user))
    .route("/users/{id}", web::delete().to(delete_user))

// Style 2: service() với Resource (nhóm theo path)
App::new()
    .service(
        web::resource("/users")
            .route(web::get().to(list_users))
            .route(web::post().to(create_user))
    )
    .service(
        web::resource("/users/{id}")
            .route(web::get().to(get_user))
            .route(web::put().to(update_user))
            .route(web::delete().to(delete_user))
    )

// Style 3: scope() — prefix grouping (recommend cho large apps)
App::new()
    .service(
        web::scope("/api/v1")
            .configure(users::config)
            .configure(orders::config)
            .configure(documents::config)
    )
```

### 2.2 Service Configuration — Module Pattern

```rust
// src/routes/users.rs
use actix_web::web;

pub fn config(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/users")
            .route("", web::get().to(list_users))
            .route("", web::post().to(create_user))
            .route("/{id}", web::get().to(get_user))
            .route("/{id}", web::put().to(update_user))
            .route("/{id}", web::delete().to(delete_user))
            .route("/{id}/documents", web::get().to(get_user_documents))
    );
}

// src/main.rs
App::new()
    .service(
        web::scope("/api/v1")
            .configure(users::config)
            .configure(documents::config)
    )
```

---

## PHẦN 3 — Extractors

### 3.1 Path Parameters

```rust
use actix_web::web;
use serde::Deserialize;

// Single param
async fn get_user(path: web::Path<i64>) -> impl Responder {
    let user_id = path.into_inner();
    HttpResponse::Ok().body(format!("User: {}", user_id))
}

// Multiple params trong struct
#[derive(Deserialize)]
struct UserDocPath {
    user_id: i64,
    doc_id: i64,
}

// GET /users/{user_id}/documents/{doc_id}
async fn get_user_document(path: web::Path<UserDocPath>) -> impl Responder {
    let UserDocPath { user_id, doc_id } = path.into_inner();
    HttpResponse::Ok().json(serde_json::json!({
        "user_id": user_id,
        "doc_id": doc_id
    }))
}
```

### 3.2 Query Parameters

```rust
#[derive(Deserialize)]
struct UserQuery {
    page: Option<u32>,
    size: Option<u32>,
    search: Option<String>,
    status: Option<String>,
}

// GET /users?page=2&size=20&search=bach&status=active
async fn list_users(
    query: web::Query<UserQuery>,
    data: web::Data<AppState>,
) -> impl Responder {
    let page = query.page.unwrap_or(1).max(1);
    let size = query.size.unwrap_or(20).min(100);
    let offset = (page - 1) * size;

    // Build query dynamically...
    HttpResponse::Ok().json(serde_json::json!({
        "page": page,
        "size": size,
        "search": query.search,
    }))
}
// Java analog: @RequestParam(defaultValue = "1") int page
```

### 3.3 JSON Body

```rust
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct CreateUserDto {
    name: String,
    email: String,
    role: Option<String>,
}

#[derive(Serialize)]
struct UserResponse {
    id: i64,
    name: String,
    email: String,
    role: String,
    created_at: String,
}

// POST /users với JSON body
async fn create_user(
    body: web::Json<CreateUserDto>,       // @RequestBody
    data: web::Data<AppState>,
) -> Result<HttpResponse, AppError> {
    // Validation thủ công (hoặc dùng validator crate)
    if body.name.trim().is_empty() {
        return Err(AppError::BadRequest("Name cannot be empty".into()));
    }
    if !body.email.contains('@') {
        return Err(AppError::BadRequest("Invalid email".into()));
    }

    let user = sqlx::query_as!(
        UserResponse,
        "INSERT INTO users (name, email, role, created_at)
         VALUES ($1, $2, $3, NOW())
         RETURNING id, name, email, role, created_at::text",
        body.name, body.email, body.role.as_deref().unwrap_or("user")
    )
    .fetch_one(&data.db)
    .await?;

    Ok(HttpResponse::Created().json(user))
}
// Java analog: @RequestBody @Valid CreateUserDto dto
```

### 3.4 JSON Config — Customize Error Response

```rust
// Custom JSON error response khi deserialize thất bại
let json_cfg = web::JsonConfig::default()
    .limit(1024 * 1024)  // 1MB max body
    .error_handler(|err, req| {
        let response = HttpResponse::BadRequest().json(serde_json::json!({
            "code": "INVALID_JSON",
            "message": err.to_string()
        }));
        actix_web::error::InternalError::from_response(err, response).into()
    });

App::new()
    .app_data(json_cfg)
    .app_data(
        web::QueryConfig::default().error_handler(|err, _| {
            let response = HttpResponse::BadRequest().json(serde_json::json!({
                "code": "INVALID_QUERY",
                "message": err.to_string()
            }));
            actix_web::error::InternalError::from_response(err, response).into()
        })
    )
```

---

## PHẦN 4 — App State & Shared Data

### 4.1 AppState Pattern

```rust
use actix_web::web::Data;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
struct AppState {
    db: PgPool,             // đã là Arc bên trong
    config: Arc<Config>,
    redis: Arc<RedisClient>,
    http_client: reqwest::Client,  // đã là Arc bên trong
}

// Register
let state = Data::new(AppState {
    db: pool,
    config: Arc::new(config),
    redis: Arc::new(redis),
    http_client: reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap(),
});

HttpServer::new(move || {
    App::new()
        .app_data(state.clone())
        .configure(users::config)
})
.workers(num_cpus::get())
.bind("0.0.0.0:8080")?
.run()
.await

// Dùng trong handler
async fn handler(data: web::Data<AppState>) -> impl Responder {
    let db = &data.db;
    let config = &data.config;
    // ...
}
// Java analog: @Autowired ApplicationContext / @Autowired các @Bean
```

### 4.2 Multiple Data Types

```rust
// Register nhiều loại data riêng biệt (không cần AppState wrapper)
App::new()
    .app_data(Data::new(pool))
    .app_data(Data::new(redis_client))
    .app_data(Data::new(app_config))

// Inject riêng lẻ
async fn handler(
    db: web::Data<PgPool>,
    config: web::Data<AppConfig>,
) -> impl Responder {
    // ...
}
// Lưu ý: cách này ít flexible hơn AppState struct
```

---

## PHẦN 5 — Error Handling

### 5.1 ResponseError Trait

```
Axum: return Err(AppError) → AppError impl IntoResponse
ActixWeb: return Err(AppError) → AppError impl ResponseError

Cả hai đều compile-time safe, handler return Result<_, AppError>
```

```rust
use actix_web::{HttpResponse, ResponseError};
use thiserror::Error;
use serde::Serialize;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Resource not found: {resource} with id {id}")]
    NotFound { resource: &'static str, id: i64 },

    #[error("Validation failed: {0}")]
    BadRequest(String),

    #[error("Unauthorized — {0}")]
    Unauthorized(String),

    #[error("Forbidden — insufficient permissions")]
    Forbidden,

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Database error")]
    Database(#[from] sqlx::Error),

    #[error("Internal server error")]
    Internal(#[from] anyhow::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    code: String,
    message: String,
}

impl From<&AppError> for ErrorBody {
    fn from(e: &AppError) -> Self {
        let code = match e {
            AppError::NotFound { .. } => "NOT_FOUND",
            AppError::BadRequest(_) => "BAD_REQUEST",
            AppError::Unauthorized(_) => "UNAUTHORIZED",
            AppError::Forbidden => "FORBIDDEN",
            AppError::Conflict(_) => "CONFLICT",
            AppError::Database(_) => "DATABASE_ERROR",
            AppError::Internal(_) => "INTERNAL_ERROR",
        };
        ErrorBody { code: code.to_string(), message: e.to_string() }
    }
}

impl ResponseError for AppError {
    fn status_code(&self) -> actix_web::http::StatusCode {
        use actix_web::http::StatusCode;
        match self {
            AppError::NotFound { .. } => StatusCode::NOT_FOUND,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            AppError::Forbidden => StatusCode::FORBIDDEN,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::Database(_) | AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn error_response(&self) -> HttpResponse {
        // Log internal errors
        if matches!(self, AppError::Database(_) | AppError::Internal(_)) {
            tracing::error!(error = %self, "Internal error occurred");
        }

        HttpResponse::build(self.status_code())
            .json(ErrorBody::from(self))
    }
}

// Sử dụng trong handler
async fn get_user(
    path: web::Path<i64>,
    data: web::Data<AppState>,
) -> Result<HttpResponse, AppError> {
    let id = path.into_inner();

    let user = sqlx::query_as!(UserResponse,
        "SELECT id, name, email, role, created_at::text FROM users WHERE id = $1", id)
        .fetch_optional(&data.db)
        .await
        .map_err(AppError::Database)?
        .ok_or(AppError::NotFound { resource: "user", id })?;

    Ok(HttpResponse::Ok().json(user))
}
// Java analog: @ControllerAdvice + @ExceptionHandler + ResponseEntityExceptionHandler
```

---

## PHẦN 6 — Middleware

### 6.1 Middleware Architecture

```
Request Flow:
  Client Request
       │
       ▼
  ┌─────────────────────────────────────────┐
  │ Logger middleware (wrap)                │
  │  ┌──────────────────────────────────┐   │
  │  │ Auth middleware (wrap)           │   │
  │  │  ┌───────────────────────────┐   │   │
  │  │  │ Compress middleware (wrap)│   │   │
  │  │  │  ┌────────────────────┐  │   │   │
  │  │  │  │   Your Handler     │  │   │   │
  │  │  │  └────────────────────┘  │   │   │
  │  │  └───────────────────────────┘   │   │
  │  └──────────────────────────────────┘   │
  └─────────────────────────────────────────┘
       │
       ▼
  Client Response
```

### 6.2 Built-in Middleware

```rust
use actix_web::middleware::{Logger, DefaultHeaders, Compress, NormalizePath};
use tracing_actix_web::TracingLogger;

App::new()
    // Structured logging (dùng TracingLogger thay Logger nếu dùng tracing)
    .wrap(TracingLogger::default())

    // Compress responses (gzip/deflate/brotli tự negotiate)
    .wrap(Compress::default())

    // Add response headers mặc định
    .wrap(DefaultHeaders::new()
        .add(("X-Content-Type-Options", "nosniff"))
        .add(("X-Frame-Options", "DENY"))
        .add(("X-Request-Id", uuid::Uuid::new_v4().to_string())))

    // Normalize trailing slash
    .wrap(NormalizePath::trim())
```

### 6.3 Custom Middleware — wrap_fn (Simple)

```rust
use actix_web::{dev::{Service, ServiceRequest, ServiceResponse, Transform}, web};
use std::time::Instant;

// Simple inline middleware với wrap_fn
App::new()
    .wrap_fn(|req, srv| {
        let start = Instant::now();
        let method = req.method().clone();
        let path = req.path().to_string();

        let fut = srv.call(req);

        async move {
            let res = fut.await?;
            let elapsed = start.elapsed().as_millis();
            let status = res.status().as_u16();

            tracing::info!(
                method = %method,
                path = %path,
                status = status,
                elapsed_ms = elapsed,
                "Request completed"
            );

            Ok(res)
        }
    })
// Java analog: OncePerRequestFilter (đơn giản)
```

### 6.4 Full Middleware — Transform + Service (Complex)

```rust
use actix_web::dev::{forward_ready, Service, ServiceRequest, ServiceResponse, Transform};
use actix_web::{Error, HttpMessage};
use futures_util::future::LocalBoxFuture;
use std::future::{ready, Ready};
use std::rc::Rc;

// JWT Auth Middleware
pub struct JwtAuth;

impl<S, B> Transform<S, ServiceRequest> for JwtAuth
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type InitError = ();
    type Transform = JwtAuthMiddleware<S>;
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ready(Ok(JwtAuthMiddleware {
            service: Rc::new(service),
        }))
    }
}

pub struct JwtAuthMiddleware<S> {
    service: Rc<S>,
}

impl<S, B> Service<ServiceRequest> for JwtAuthMiddleware<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

    forward_ready!(service);

    fn call(&self, req: ServiceRequest) -> Self::Future {
        let service = self.service.clone();

        Box::pin(async move {
            // Extract token
            let auth_header = req.headers()
                .get("Authorization")
                .and_then(|h| h.to_str().ok())
                .and_then(|h| h.strip_prefix("Bearer "));

            match auth_header {
                Some(token) => {
                    match verify_jwt(token) {
                        Ok(claims) => {
                            // Inject claims vào request extensions
                            req.extensions_mut().insert(claims);
                            service.call(req).await
                        }
                        Err(_) => {
                            Err(actix_web::error::ErrorUnauthorized("Invalid token"))
                        }
                    }
                }
                None => Err(actix_web::error::ErrorUnauthorized("Missing token")),
            }
        })
    }
}

// Áp dụng cho specific scope
App::new()
    .service(
        web::scope("/api/v1")
            .wrap(JwtAuth)              // chỉ auth routes này
            .configure(users::config)
    )
    .route("/health", web::get().to(health_check))   // public
// Java analog: SecurityFilterChain + OncePerRequestFilter
```

### 6.5 Extract Middleware-injected Data trong Handler

```rust
use actix_web::HttpRequest;

#[derive(Debug, Clone)]
struct JwtClaims {
    user_id: i64,
    role: String,
    exp: i64,
}

async fn protected_handler(
    req: HttpRequest,
    data: web::Data<AppState>,
) -> Result<HttpResponse, AppError> {
    // Extract claims injected by JwtAuth middleware
    let claims = req.extensions()
        .get::<JwtClaims>()
        .cloned()
        .ok_or(AppError::Unauthorized("No auth context".into()))?;

    if claims.role != "admin" {
        return Err(AppError::Forbidden);
    }

    // Tiến hành với claims.user_id
    Ok(HttpResponse::Ok().finish())
}
```

---

## PHẦN 7 — WebSocket với actix-ws

### 7.1 Basic WebSocket

```rust
use actix_web::{web, HttpRequest, HttpResponse};
use actix_ws::{AggregatedMessage, Session};
use futures_util::StreamExt;

async fn ws_handler(
    req: HttpRequest,
    stream: web::Payload,
    data: web::Data<AppState>,
) -> Result<HttpResponse, actix_web::Error> {
    let (res, mut session, stream) = actix_ws::handle(&req, stream)?;

    // Aggregate fragmented messages (optional)
    let mut stream = stream
        .aggregate_continuations()
        .max_continuation_size(2 * 1024 * 1024); // 2MB max

    // Spawn handler task
    actix_web::rt::spawn(async move {
        while let Some(msg) = stream.next().await {
            match msg {
                Ok(AggregatedMessage::Text(text)) => {
                    // Echo
                    if session.text(text).await.is_err() {
                        break;
                    }
                }
                Ok(AggregatedMessage::Binary(bin)) => {
                    session.binary(bin).await.ok();
                }
                Ok(AggregatedMessage::Ping(bytes)) => {
                    session.pong(&bytes).await.ok();
                }
                Ok(AggregatedMessage::Close(reason)) => {
                    session.close(reason).await.ok();
                    break;
                }
                Err(e) => {
                    tracing::error!("WebSocket error: {}", e);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(res)
}
```

---

## PHẦN 8 — Testing

### 8.1 Unit Test Handler

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, web, App};

    #[actix_web::test]
    async fn test_health_check() {
        let app = test::init_service(
            App::new().route("/health", web::get().to(health_check))
        ).await;

        let req = test::TestRequest::get()
            .uri("/health")
            .to_request();

        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), 200);
    }

    #[actix_web::test]
    async fn test_create_user() {
        let pool = create_test_pool().await;

        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(AppState { db: pool.clone() }))
                .app_data(web::JsonConfig::default())
                .configure(users::config)
        ).await;

        let req = test::TestRequest::post()
            .uri("/users")
            .set_json(&serde_json::json!({
                "name": "Test User",
                "email": "test@example.com"
            }))
            .to_request();

        let resp: UserResponse = test::call_and_read_body_json(&app, req).await;
        assert_eq!(resp.name, "Test User");
        assert_eq!(resp.email, "test@example.com");
    }

    #[actix_web::test]
    async fn test_get_user_not_found() {
        let pool = create_test_pool().await;
        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(AppState { db: pool }))
                .configure(users::config)
        ).await;

        let req = test::TestRequest::get()
            .uri("/users/99999")
            .to_request();

        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), 404);

        let body: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(body["code"], "NOT_FOUND");
    }
}
```

---

## PHẦN 9 — Full App Example

### 9.1 Project Structure

```
src/
├── main.rs
├── config.rs          ← Config struct, load từ env
├── errors.rs          ← AppError + ResponseError
├── state.rs           ← AppState
├── routes/
│   ├── mod.rs         ← combine all configs
│   ├── users.rs
│   └── documents.rs
├── models/
│   ├── user.rs        ← User, CreateUserDto, UserResponse
│   └── document.rs
├── middleware/
│   ├── auth.rs        ← JwtAuth middleware
│   └── request_id.rs  ← X-Request-Id injection
└── db/
    └── migrations/    ← SQL migration files
```

### 9.2 main.rs Đầy Đủ

```rust
use actix_web::{web, App, HttpServer, middleware};
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use tracing_actix_web::TracingLogger;

mod config;
mod errors;
mod middleware;
mod models;
mod routes;
mod state;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Tracing setup
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("actix_web=info".parse().unwrap())
        )
        .json()
        .init();

    // Load config
    let config = config::Config::from_env().expect("Config load failed");
    let port = config.port;

    // DB pool
    let pool = PgPoolOptions::new()
        .max_connections(config.db_pool_size)
        .acquire_timeout(std::time::Duration::from_secs(3))
        .connect(&config.database_url)
        .await
        .expect("DB connect failed");

    // Run migrations
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Migration failed");

    let state = web::Data::new(state::AppState {
        db: pool,
        config: Arc::new(config),
        http_client: reqwest::Client::new(),
    });

    tracing::info!("Starting server on 0.0.0.0:{}", port);

    HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .app_data(
                web::JsonConfig::default()
                    .limit(1024 * 1024)
                    .error_handler(errors::json_error_handler)
            )
            // Global middleware (áp dụng cho tất cả routes)
            .wrap(TracingLogger::default())
            .wrap(actix_web::middleware::Compress::default())
            .wrap(actix_web::middleware::NormalizePath::trim())
            // Public routes
            .route("/health", web::get().to(routes::health_check))
            // Protected API
            .service(
                web::scope("/api/v1")
                    .wrap(middleware::auth::JwtAuth)
                    .configure(routes::users::config)
                    .configure(routes::documents::config)
            )
    })
    .workers(num_cpus::get())
    .bind(format!("0.0.0.0:{}", port))?
    .run()
    .await
}
```

---

## 📊 Axum vs ActixWeb — So Sánh Chi Tiết

```
┌─────────────────────┬──────────────────────────┬──────────────────────────┐
│ Aspect              │ Axum 0.7                 │ ActixWeb 4               │
├─────────────────────┼──────────────────────────┼──────────────────────────┤
│ Concurrency model   │ Tokio M:N tasks          │ Actix actor per thread   │
│ Handler ergonomics  │ Fn extractor params      │ Fn extractor params      │
│ State injection     │ State<T> extractor       │ Data<T> extractor        │
│ Error handling      │ IntoResponse             │ ResponseError trait      │
│ Middleware          │ Tower ServiceBuilder     │ Transform trait / wrap   │
│ Simple middleware   │ from_fn                  │ wrap_fn                  │
│ Complex middleware  │ Tower Layer              │ Transform + Service impl │
│ WebSocket           │ WebSocketUpgrade         │ actix-ws::handle         │
│ Testing             │ axum::test::TestClient   │ actix_web::test module   │
│ Tower compat        │ Native                   │ Không                    │
│ Perf (TechEmpower)  │ Rất cao                  │ Cao nhất (lịch sử)      │
│ Ecosystem           │ Tower, Hyper             │ Actix ecosystem          │
└─────────────────────┴──────────────────────────┴──────────────────────────┘

Chọn Axum khi: muốn tích hợp Tower ecosystem, quen tokio patterns
Chọn ActixWeb khi: cần max throughput, team quen API style giống Express.js
```

---

## 🏋️ Bài Tập

1. **CRUD API**: Implement đầy đủ CRUD cho `Document` (id, title, status, created_by, created_at). Dùng in-memory `HashMap` wrapped trong `RwLock`. Có pagination cho list endpoint.

2. **Auth Middleware**: Implement `JwtAuth` middleware extract `X-User-Id` và `X-User-Role` headers (giả lập gateway). Inject `AuthUser` struct vào request extensions. Protect `/api/v1/*` routes.

3. **Error Handling**: Tạo `AppError` với 6 variants, implement `ResponseError` với JSON response body. Test với test module cho từng error case.

4. **Comparison**: Build cùng một API với cả Axum (Bài 10) và ActixWeb. So sánh boilerplate, ergonomics, và test code.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-24-Axum-Advanced|Bài 24: Axum Advanced]] — prerequisite
- [[Rust-Zero-To-Hero/Bai-28-Tonic-GRPC|Bài 28: Tonic/gRPC]] → tiếp theo
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9: Tokio]] — runtime foundation
