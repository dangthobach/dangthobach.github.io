# Bài 11: Axum Middleware, Tower & Production Patterns

---

## 1. Tower Service Model

Axum build trên Tower. Mọi middleware là `Layer`, mọi handler là `Service`.

```
Request → [Layer N] → ... → [Layer 1] → Handler → [Layer 1] → ... → [Layer N] → Response
         ↑ Outer                          ↑ Inner
```

**Java analog:** Filter chain trong Spring Security / OncePerRequestFilter.

---

## 2. Built-in Middleware (tower-http)

```rust
use tower_http::{
    cors::{CorsLayer, Any},
    trace::TraceLayer,
    compression::CompressionLayer,
    timeout::TimeoutLayer,
    limit::RequestBodyLimitLayer,
};
use std::time::Duration;

let app = Router::new()
    .route("/users", get(list_users))
    .layer(
        ServiceBuilder::new()
            .layer(TraceLayer::new_for_http())          // structured logging
            .layer(CompressionLayer::new())              // gzip/brotli response
            .layer(TimeoutLayer::new(Duration::from_secs(30))) // request timeout
            .layer(RequestBodyLimitLayer::new(10 * 1024 * 1024)) // 10MB body limit
            .layer(
                CorsLayer::new()
                    .allow_origin(Any)
                    .allow_methods(Any)
                    .allow_headers(Any),
            )
    );
```

---

## 3. Custom Middleware với `from_fn`

```rust
use axum::middleware::{self, Next};
use axum::extract::Request;
use axum::response::Response;

// Simple middleware — function style
async fn logging_middleware(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let start = std::time::Instant::now();
    
    let response = next.run(req).await;
    
    let duration = start.elapsed();
    tracing::info!(
        method = %method,
        uri = %uri,
        status = response.status().as_u16(),
        duration_ms = duration.as_millis(),
        "request completed"
    );
    
    response
}

// Auth middleware
async fn require_auth(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let token = req.headers()
        .get("Authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;
    
    let claims = verify_jwt(token, &state.config.jwt_secret)?;
    req.extensions_mut().insert(claims);
    
    Ok(next.run(req).await)
}

// Apply middleware — chỉ cho một số routes
let protected = Router::new()
    .route("/profile", get(profile_handler))
    .route("/admin", get(admin_handler))
    .layer(middleware::from_fn_with_state(state.clone(), require_auth));

let public = Router::new()
    .route("/login", post(login_handler))
    .route("/health", get(health_check));

let app = Router::new()
    .merge(public)
    .merge(protected)
    .layer(middleware::from_fn(logging_middleware));
```

---

## 4. Error Response Design — Production Grade

```rust
use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde_json::json;
use tracing::error;

#[derive(Debug)]
pub enum AppError {
    NotFound(String),
    BadRequest(String),
    Unauthorized,
    Forbidden,
    Internal(anyhow::Error),
    Database(sqlx::Error),
    Validation(Vec<ValidationError>),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            AppError::NotFound(msg) => (
                StatusCode::NOT_FOUND,
                json!({ "error": "not_found", "message": msg }),
            ),
            AppError::BadRequest(msg) => (
                StatusCode::BAD_REQUEST,
                json!({ "error": "bad_request", "message": msg }),
            ),
            AppError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                json!({ "error": "unauthorized" }),
            ),
            AppError::Forbidden => (
                StatusCode::FORBIDDEN,
                json!({ "error": "forbidden" }),
            ),
            AppError::Database(ref e) => {
                error!(err = %e, "Database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "error": "internal_error" }),
                )
            }
            AppError::Internal(ref e) => {
                error!(err = ?e, "Internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "error": "internal_error" }),
                )
            }
            AppError::Validation(errors) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({
                    "error": "validation_error",
                    "details": errors
                }),
            ),
        };
        
        (status, Json(body)).into_response()
    }
}

// From impls cho ? operator
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => AppError::NotFound("Record not found".to_string()),
            other => AppError::Database(other),
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e)
    }
}
```

---

## 5. Request ID & Correlation

```rust
use uuid::Uuid;

async fn request_id_middleware(mut req: Request, next: Next) -> Response {
    let request_id = req.headers()
        .get("X-Request-Id")
        .and_then(|h| h.to_str().ok())
        .map(String::from)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    
    // Inject vào extension để handlers dùng
    req.extensions_mut().insert(RequestId(request_id.clone()));
    
    let mut response = next.run(req).await;
    
    // Propagate ra response header
    response.headers_mut().insert(
        "X-Request-Id",
        request_id.parse().unwrap(),
    );
    
    response
}
```

---

## 6. Graceful Shutdown

```rust
#[tokio::main]
async fn main() {
    let app = build_app();
    
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.expect("Ctrl+C handler failed");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler failed")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    
    tracing::info!("Shutdown signal received, draining requests...");
}
```

---

## 7. Health Check Pattern

```rust
use serde_json::json;

async fn health_check(State(state): State<AppState>) -> impl IntoResponse {
    // Check DB connectivity
    let db_ok = sqlx::query("SELECT 1")
        .fetch_one(&state.db)
        .await
        .is_ok();
    
    let status = if db_ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    
    (status, Json(json!({
        "status": if db_ok { "healthy" } else { "unhealthy" },
        "database": db_ok,
        "version": env!("CARGO_PKG_VERSION"),
    })))
}
```

---

## 8. Tracing Setup

```rust
fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=debug".into())
        )
        .with_target(true)
        .with_thread_ids(false)
        .json() // structured JSON logs cho production
        .init();
}

// Trong handlers, dùng tracing macros
async fn create_user(...) -> Result<Json<User>, AppError> {
    tracing::info!(email = %dto.email, "Creating user");
    
    let user = user_service.create(dto).await
        .map_err(|e| {
            tracing::error!(err = ?e, email = %dto.email, "Failed to create user");
            e
        })?;
    
    tracing::info!(user_id = user.id, "User created successfully");
    Ok(Json(user))
}
```

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-10-Axum-Core|Bài 10: Axum Core]]
- [[Rust-Zero-To-Hero/Bai-12-SQLx-Database|Bài 12: SQLx]]
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9: Graceful shutdown với select!]]
