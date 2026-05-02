# Bài 35: Resilience — Circuit Breaker · Retry · Bulkhead · Tower Patterns

> **Prerequisite:** Bài 9 (Tokio), Bài 10-11 (Axum + Tower), Bài 34 (OTel)  
> **Mục tiêu:** Master resilience engineering — circuit breaker, retry với backoff, timeout, bulkhead isolation, health-based routing, và compose tất cả bằng Tower middleware stack

---

## 🗺️ Bức Tranh Tổng Quan

```
Resilience Patterns — Defense in Depth:

  Incoming Request
        │
        ▼
  ┌─────────────────────────────────────────────────────┐
  │  Timeout (Layer 1)                                  │
  │  "Nếu quá 30s → fail fast"                         │
  ├─────────────────────────────────────────────────────┤
  │  Rate Limiter (Layer 2)                             │
  │  "Không nhận quá 1000 req/s"                        │
  ├─────────────────────────────────────────────────────┤
  │  Bulkhead (Layer 3)                                 │
  │  "Tối đa 20 concurrent requests đến DB service"     │
  ├─────────────────────────────────────────────────────┤
  │  Circuit Breaker (Layer 4)                          │
  │  "Nếu 50% calls fail → stop calling for 30s"       │
  ├─────────────────────────────────────────────────────┤
  │  Retry (Layer 5)                                    │
  │  "Nếu fail → retry 3 lần với exponential backoff"  │
  └──────────────────────────┬──────────────────────────┘
                             │
                    External Service / DB

Java analog: Resilience4J
  @CircuitBreaker + @Retry + @Bulkhead + @TimeLimiter + @RateLimiter
  → Annotation-based, Spring Boot integration
  
Rust approach: Tower middleware stack (composable, type-safe)
```

---

## PHẦN 1 — Timeout

### 1.1 Tower TimeoutLayer (Built-in)

```rust
use tower::timeout::TimeoutLayer;
use std::time::Duration;

// Đơn giản nhất — Tower built-in
let app = Router::new()
    .nest("/api", api_routes())
    .layer(TimeoutLayer::new(Duration::from_secs(30)));

// Khi timeout: axum trả về 408 Request Timeout
```

### 1.2 Per-Route Timeout

```rust
use axum::{routing::get, Router};
use tower::ServiceBuilder;
use tower_http::timeout::RequestBodyTimeoutLayer;

// Timeout khác nhau cho từng route
pub fn build_router() -> Router {
    Router::new()
        // Fast endpoints: 5s
        .route("/health", get(health_handler))
        .route("/users/:id", get(get_user_handler))
        
        // Long-running: 120s
        .route(
            "/imports",
            axum::routing::post(import_handler)
                .layer(TimeoutLayer::new(Duration::from_secs(120)))
        )
        // Short timeout cho health check
        .layer(
            ServiceBuilder::new()
                .layer(TimeoutLayer::new(Duration::from_secs(30)))
        )
}

// Custom timeout error handling
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};

pub async fn handle_timeout_error(err: Box<dyn std::error::Error + Send + Sync>) -> Response {
    if err.is::<tower::timeout::error::Elapsed>() {
        (
            StatusCode::REQUEST_TIMEOUT,
            axum::Json(serde_json::json!({
                "code": "REQUEST_TIMEOUT",
                "message": "Request took too long to process",
            })),
        ).into_response()
    } else {
        (StatusCode::INTERNAL_SERVER_ERROR, "Internal error").into_response()
    }
}
```

### 1.3 tokio::time::timeout (Fine-grained)

```rust
use tokio::time::{timeout, Duration};

pub async fn get_document_with_timeout(
    pool: &PgPool,
    id: i64,
) -> Result<Document, AppError> {
    // Timeout chỉ cho DB query này, không cả request
    match timeout(Duration::from_secs(5), async {
        sqlx::query_as!(Document,
            "SELECT * FROM documents WHERE id = $1", id)
            .fetch_optional(pool)
            .await
    }).await {
        Ok(Ok(Some(doc))) => Ok(doc),
        Ok(Ok(None)) => Err(AppError::NotFound),
        Ok(Err(e)) => Err(AppError::Database(e)),
        Err(_) => {
            tracing::warn!(doc_id = id, "DB query timeout after 5s");
            Err(AppError::Timeout("Database query timed out".into()))
        }
    }
}
```

---

## PHẦN 2 — Circuit Breaker

### 2.1 Circuit Breaker States

```
Circuit Breaker State Machine:

     Calls succeed (< threshold)
  ┌─────────────────────────────────┐
  │                                 │
  ▼                                 │
CLOSED ──── failures > threshold ──▶ OPEN
  ▲                                 │
  │                                 │ After reset_timeout
  │                                 ▼
  └──── probe succeeds ─────── HALF_OPEN
         probe fails ──────────────▶ OPEN

States:
  CLOSED:    Normal operation. Track failure rate.
  OPEN:      All calls fail immediately (fast fail).
             Prevents cascade failures.
  HALF_OPEN: Allow 1 probe request.
             If success → CLOSED
             If fail → OPEN again
```

### 2.2 Circuit Breaker Implementation

```rust
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CircuitState {
    Closed,
    Open,
    HalfOpen,
}

pub struct CircuitBreaker {
    config: CircuitBreakerConfig,
    state: Arc<AtomicU8>,  // 0=Closed, 1=Open, 2=HalfOpen
    failure_count: Arc<AtomicU64>,
    success_count: Arc<AtomicU64>,
    total_count: Arc<AtomicU64>,
    last_failure_time: Arc<Mutex<Option<Instant>>>,
    // Window for sliding count
    window_start: Arc<Mutex<Instant>>,
}

pub struct CircuitBreakerConfig {
    /// Min requests trước khi tính failure rate
    pub min_request_threshold: u64,
    /// % failures để OPEN circuit (0.0 - 1.0)
    pub failure_rate_threshold: f64,
    /// Thời gian giữ OPEN state trước khi thử HALF_OPEN
    pub reset_timeout: Duration,
    /// Sliding window size
    pub sliding_window: Duration,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            min_request_threshold: 10,
            failure_rate_threshold: 0.5,  // 50%
            reset_timeout: Duration::from_secs(30),
            sliding_window: Duration::from_secs(60),
        }
    }
}

impl CircuitBreaker {
    pub fn new(config: CircuitBreakerConfig) -> Self {
        Self {
            config,
            state: Arc::new(AtomicU8::new(0)), // Closed
            failure_count: Arc::new(AtomicU64::new(0)),
            success_count: Arc::new(AtomicU64::new(0)),
            total_count: Arc::new(AtomicU64::new(0)),
            last_failure_time: Arc::new(Mutex::new(None)),
            window_start: Arc::new(Mutex::new(Instant::now())),
        }
    }

    pub fn state(&self) -> CircuitState {
        match self.state.load(Ordering::SeqCst) {
            0 => CircuitState::Closed,
            1 => CircuitState::Open,
            2 => CircuitState::HalfOpen,
            _ => CircuitState::Closed,
        }
    }

    // Check if request is allowed through
    pub async fn allow_request(&self) -> Result<(), CircuitBreakerError> {
        match self.state() {
            CircuitState::Closed => Ok(()),
            CircuitState::Open => {
                // Check if enough time has passed to try HALF_OPEN
                let last_failure = self.last_failure_time.lock().await;
                if let Some(t) = *last_failure {
                    if t.elapsed() >= self.config.reset_timeout {
                        drop(last_failure);
                        // Transition to HALF_OPEN
                        self.state.store(2, Ordering::SeqCst);
                        tracing::info!("Circuit breaker transitioning to HALF_OPEN");
                        return Ok(());
                    }
                }
                Err(CircuitBreakerError::CircuitOpen)
            }
            CircuitState::HalfOpen => Ok(()), // Allow probe request
        }
    }

    // Record result
    pub async fn record_success(&self) {
        self.success_count.fetch_add(1, Ordering::SeqCst);
        self.total_count.fetch_add(1, Ordering::SeqCst);

        if self.state() == CircuitState::HalfOpen {
            // Probe succeeded → CLOSED
            self.reset().await;
            tracing::info!("Circuit breaker CLOSED (probe succeeded)");
        }
    }

    pub async fn record_failure(&self) {
        self.failure_count.fetch_add(1, Ordering::SeqCst);
        self.total_count.fetch_add(1, Ordering::SeqCst);

        let total = self.total_count.load(Ordering::SeqCst);
        let failures = self.failure_count.load(Ordering::SeqCst);

        if self.state() == CircuitState::HalfOpen {
            // Probe failed → back to OPEN
            self.open().await;
            tracing::warn!("Circuit breaker OPEN (probe failed)");
            return;
        }

        // Check if should OPEN
        if total >= self.config.min_request_threshold {
            let failure_rate = failures as f64 / total as f64;
            if failure_rate >= self.config.failure_rate_threshold {
                self.open().await;
                tracing::warn!(
                    failure_rate = failure_rate,
                    total_requests = total,
                    "Circuit breaker OPEN (failure rate exceeded)"
                );
            }
        }
    }

    async fn open(&self) {
        self.state.store(1, Ordering::SeqCst);
        *self.last_failure_time.lock().await = Some(Instant::now());
    }

    async fn reset(&self) {
        self.state.store(0, Ordering::SeqCst);
        self.failure_count.store(0, Ordering::SeqCst);
        self.success_count.store(0, Ordering::SeqCst);
        self.total_count.store(0, Ordering::SeqCst);
    }

    // Execute with circuit breaker
    pub async fn execute<F, T, E>(&self, f: F) -> Result<T, CircuitBreakerError>
    where
        F: std::future::Future<Output = Result<T, E>>,
        E: std::fmt::Display,
    {
        self.allow_request().await?;

        match f.await {
            Ok(value) => {
                self.record_success().await;
                Ok(value)
            }
            Err(e) => {
                self.record_failure().await;
                Err(CircuitBreakerError::Underlying(e.to_string()))
            }
        }
    }

    // Get stats
    pub fn stats(&self) -> CircuitBreakerStats {
        let total = self.total_count.load(Ordering::SeqCst);
        let failures = self.failure_count.load(Ordering::SeqCst);
        CircuitBreakerStats {
            state: self.state(),
            total_requests: total,
            failure_count: failures,
            failure_rate: if total > 0 { failures as f64 / total as f64 } else { 0.0 },
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CircuitBreakerError {
    #[error("Circuit breaker is OPEN — requests blocked")]
    CircuitOpen,
    #[error("Underlying service error: {0}")]
    Underlying(String),
}

#[derive(Debug)]
pub struct CircuitBreakerStats {
    pub state: CircuitState,
    pub total_requests: u64,
    pub failure_count: u64,
    pub failure_rate: f64,
}
```

### 2.3 Circuit Breaker với Tower Layer

```rust
use tower::{Layer, Service};
use std::task::{Context, Poll};
use futures_util::future::BoxFuture;

#[derive(Clone)]
pub struct CircuitBreakerLayer {
    cb: Arc<CircuitBreaker>,
}

impl CircuitBreakerLayer {
    pub fn new(config: CircuitBreakerConfig) -> Self {
        Self { cb: Arc::new(CircuitBreaker::new(config)) }
    }
}

impl<S> Layer<S> for CircuitBreakerLayer {
    type Service = CircuitBreakerService<S>;

    fn layer(&self, service: S) -> Self::Service {
        CircuitBreakerService {
            inner: service,
            cb: self.cb.clone(),
        }
    }
}

#[derive(Clone)]
pub struct CircuitBreakerService<S> {
    inner: S,
    cb: Arc<CircuitBreaker>,
}

impl<S, Req, Res, Err> Service<Req> for CircuitBreakerService<S>
where
    S: Service<Req, Response = Res, Error = Err> + Clone + Send + 'static,
    S::Future: Send + 'static,
    Req: Send + 'static,
    Res: Send + 'static,
    Err: std::fmt::Display + Send + 'static,
{
    type Response = Res;
    type Error = CircuitBreakerError;
    type Future = BoxFuture<'static, Result<Self::Response, Self::Error>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
            .map_err(|e| CircuitBreakerError::Underlying(e.to_string()))
    }

    fn call(&mut self, req: Req) -> Self::Future {
        let cb = self.cb.clone();
        let mut inner = self.inner.clone();

        Box::pin(async move {
            cb.allow_request().await?;

            match inner.call(req).await {
                Ok(resp) => {
                    cb.record_success().await;
                    Ok(resp)
                }
                Err(e) => {
                    cb.record_failure().await;
                    Err(CircuitBreakerError::Underlying(e.to_string()))
                }
            }
        })
    }
}

// Apply lên reqwest client calls (external service)
let user_service = ServiceBuilder::new()
    .layer(CircuitBreakerLayer::new(CircuitBreakerConfig {
        min_request_threshold: 5,
        failure_rate_threshold: 0.5,
        reset_timeout: Duration::from_secs(30),
        sliding_window: Duration::from_secs(60),
    }))
    .layer(RetryLayer::new(RetryPolicy::default()))
    .service(user_service_client);
```

---

## PHẦN 3 — Retry với Exponential Backoff

### 3.1 tower-retry

```toml
[dependencies]
tower = { version = "0.4", features = ["retry", "limit"] }
```

```rust
use tower::retry::{Policy, Retry};
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
    pub jitter: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay: Duration::from_millis(100),
            max_delay: Duration::from_secs(30),
            jitter: true,
        }
    }
}

// Determine if request should be retried
#[derive(Clone)]
pub struct HttpRetryPolicy {
    config: RetryPolicy,
    attempt: u32,
}

impl HttpRetryPolicy {
    pub fn new(config: RetryPolicy) -> Self {
        Self { config, attempt: 0 }
    }

    fn delay_for_attempt(&self, attempt: u32) -> Duration {
        let base_ms = self.config.base_delay.as_millis() as u64;
        let exp = 2u64.pow(attempt);
        let delay_ms = base_ms * exp;
        let delay_ms = delay_ms.min(self.config.max_delay.as_millis() as u64);

        if self.config.jitter {
            // Add ±25% jitter
            let jitter_range = delay_ms / 4;
            let jitter = rand::random::<u64>() % (jitter_range * 2 + 1);
            let delay_ms = delay_ms.saturating_sub(jitter_range) + jitter;
            Duration::from_millis(delay_ms)
        } else {
            Duration::from_millis(delay_ms)
        }
    }
}

impl<Req: Clone, Res, Err> Policy<Req, Res, Err> for HttpRetryPolicy {
    type Future = tokio::time::Sleep;

    fn retry(&mut self, _req: &mut Req, result: &mut Result<Res, Err>) -> Option<Self::Future> {
        match result {
            Ok(_) => None, // Success — no retry
            Err(_) => {
                if self.attempt >= self.config.max_attempts {
                    None // Max attempts reached
                } else {
                    let delay = self.delay_for_attempt(self.attempt);
                    self.attempt += 1;
                    tracing::warn!(
                        attempt = self.attempt,
                        delay_ms = delay.as_millis(),
                        "Retrying request"
                    );
                    Some(tokio::time::sleep(delay))
                }
            }
        }
    }

    fn clone_request(&mut self, req: &Req) -> Option<Req> {
        Some(req.clone())
    }
}
```

### 3.2 Custom Retry với Selective Error Handling

```rust
// Chỉ retry một số loại lỗi nhất định
pub async fn retry_with_policy<F, T, E, Fut>(
    config: &RetryPolicy,
    should_retry: impl Fn(&E) -> bool,
    f: impl Fn() -> Fut,
) -> Result<T, E>
where
    Fut: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    let mut attempt = 0u32;

    loop {
        match f().await {
            Ok(value) => return Ok(value),
            Err(e) => {
                if attempt >= config.max_attempts || !should_retry(&e) {
                    tracing::error!(
                        attempt = attempt + 1,
                        error = %e,
                        "Request failed, not retrying"
                    );
                    return Err(e);
                }

                let delay = calculate_delay(config, attempt);
                tracing::warn!(
                    attempt = attempt + 1,
                    max_attempts = config.max_attempts,
                    error = %e,
                    delay_ms = delay.as_millis(),
                    "Request failed, retrying"
                );

                tokio::time::sleep(delay).await;
                attempt += 1;
            }
        }
    }
}

fn calculate_delay(config: &RetryPolicy, attempt: u32) -> Duration {
    let base = config.base_delay.as_millis() as u64;
    let delay = base * 2u64.pow(attempt);
    let delay = delay.min(config.max_delay.as_millis() as u64);

    // Jitter: rand * delay * 0.3
    let jitter = (rand::random::<u64>() % (delay / 3 + 1)) as u64;
    Duration::from_millis(delay + jitter)
}

// Retryable errors: network errors, 429, 503, 504
pub fn is_retryable_http_error(status: u16) -> bool {
    matches!(status, 429 | 500 | 502 | 503 | 504)
}

// Dùng trong service client
pub async fn call_external_service_with_retry(
    client: &reqwest::Client,
    url: &str,
) -> Result<serde_json::Value, AppError> {
    let config = RetryPolicy {
        max_attempts: 3,
        base_delay: Duration::from_millis(200),
        max_delay: Duration::from_secs(5),
        jitter: true,
    };

    retry_with_policy(
        &config,
        |e: &AppError| matches!(e, AppError::Network(_) | AppError::ServiceUnavailable),
        || async {
            let resp = client.get(url).send().await
                .map_err(|e| AppError::Network(e.to_string()))?;

            if !resp.status().is_success() && is_retryable_http_error(resp.status().as_u16()) {
                return Err(AppError::ServiceUnavailable);
            }

            resp.json().await.map_err(|e| AppError::External(e.to_string()))
        },
    ).await
}
```

---

## PHẦN 4 — Bulkhead (Concurrency Limiter)

```rust
// Bulkhead: giới hạn concurrent requests đến một service/resource
// Ngăn 1 service slow làm exhausted toàn bộ thread pool

use tokio::sync::Semaphore;

pub struct Bulkhead {
    semaphore: Arc<Semaphore>,
    name: String,
    max_concurrent: usize,
    max_wait_time: Duration,
}

impl Bulkhead {
    pub fn new(name: impl Into<String>, max_concurrent: usize, max_wait_time: Duration) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
            name: name.into(),
            max_concurrent,
            max_wait_time,
        }
    }

    pub async fn execute<F, T, E>(&self, f: F) -> Result<T, BulkheadError>
    where
        F: std::future::Future<Output = Result<T, E>>,
        E: Into<AppError>,
    {
        // Try to acquire permit within max_wait_time
        let permit = match tokio::time::timeout(
            self.max_wait_time,
            self.semaphore.acquire()
        ).await {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => return Err(BulkheadError::Closed),
            Err(_) => {
                tracing::warn!(
                    bulkhead = %self.name,
                    max_concurrent = self.max_concurrent,
                    "Bulkhead full — request rejected"
                );
                return Err(BulkheadError::Full);
            }
        };

        let current = self.max_concurrent - self.semaphore.available_permits();
        tracing::debug!(
            bulkhead = %self.name,
            concurrent = current,
            max = self.max_concurrent,
            "Bulkhead permit acquired"
        );

        let result = f.await.map_err(|e| BulkheadError::Underlying(e.into()));
        drop(permit); // Release slot
        result
    }

    pub fn available_permits(&self) -> usize {
        self.semaphore.available_permits()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BulkheadError {
    #[error("Bulkhead is full — too many concurrent requests")]
    Full,
    #[error("Bulkhead is closed")]
    Closed,
    #[error("Underlying error: {0}")]
    Underlying(AppError),
}

// Separate bulkheads cho từng external dependency
pub struct ServiceBulkheads {
    pub database: Bulkhead,
    pub user_service: Bulkhead,
    pub email_service: Bulkhead,
    pub storage_service: Bulkhead,
}

impl ServiceBulkheads {
    pub fn new() -> Self {
        Self {
            // DB: allow nhiều concurrent queries
            database: Bulkhead::new("database", 50, Duration::from_secs(3)),
            // User service: external, slower
            user_service: Bulkhead::new("user-service", 20, Duration::from_secs(5)),
            // Email: không urgent, ít concurrent
            email_service: Bulkhead::new("email-service", 5, Duration::from_secs(10)),
            // Storage: large ops, throttle aggressively
            storage_service: Bulkhead::new("storage-service", 10, Duration::from_secs(30)),
        }
    }
}

// Dùng trong handler
pub async fn upload_document(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<impl IntoResponse, AppError> {
    // Bulkhead: tối đa 10 concurrent uploads
    state.bulkheads.storage_service.execute(async {
        save_to_storage(&state, body).await
    }).await
    .map_err(|e| match e {
        BulkheadError::Full => AppError::ServiceUnavailable,
        BulkheadError::Underlying(e) => e,
        BulkheadError::Closed => AppError::Internal("Storage service closed".into()),
    })?;

    Ok(StatusCode::CREATED)
}
```

---

## PHẦN 5 — Composing Resilience Patterns với Tower

### 5.1 Resilient Service Client

```rust
use tower::{ServiceBuilder, ServiceExt};

pub fn build_resilient_user_service_client(
    config: &ServiceClientConfig,
) -> impl Service<UserRequest, Response = UserResponse, Error = AppError> + Clone {
    ServiceBuilder::new()
        // 1. Total timeout (outermost — first to intercept)
        .layer(TimeoutLayer::new(Duration::from_secs(10)))

        // 2. Retry (wraps circuit breaker + actual call)
        .layer(tower::retry::RetryLayer::new(
            HttpRetryPolicy::new(RetryPolicy {
                max_attempts: 3,
                base_delay: Duration::from_millis(100),
                max_delay: Duration::from_secs(5),
                jitter: true,
            })
        ))

        // 3. Circuit breaker
        .layer(CircuitBreakerLayer::new(CircuitBreakerConfig {
            min_request_threshold: 5,
            failure_rate_threshold: 0.5,
            reset_timeout: Duration::from_secs(30),
            sliding_window: Duration::from_secs(60),
        }))

        // 4. Concurrency limit (bulkhead)
        .layer(tower::limit::ConcurrencyLimitLayer::new(20))

        // 5. Actual service call
        .service(UserServiceHttpClient::new(&config.user_service_url))
}
```

### 5.2 Health Check — Proactive Circuit Breaking

```rust
use std::sync::atomic::{AtomicBool, Ordering};

pub struct DependencyHealthChecker {
    db_healthy: Arc<AtomicBool>,
    redis_healthy: Arc<AtomicBool>,
    user_service_healthy: Arc<AtomicBool>,
}

impl DependencyHealthChecker {
    pub fn new() -> Self {
        Self {
            db_healthy: Arc::new(AtomicBool::new(true)),
            redis_healthy: Arc::new(AtomicBool::new(true)),
            user_service_healthy: Arc::new(AtomicBool::new(true)),
        }
    }

    pub fn is_healthy(&self) -> bool {
        self.db_healthy.load(Ordering::Relaxed) &&
        self.redis_healthy.load(Ordering::Relaxed)
        // user_service: degrade gracefully nếu down
    }

    // Background health check loop
    pub async fn run_health_checks(self: Arc<Self>, state: Arc<AppState>) {
        let mut interval = tokio::time::interval(Duration::from_secs(10));

        loop {
            interval.tick().await;

            // DB health
            let db_ok = sqlx::query!("SELECT 1 AS ok")
                .fetch_one(&state.db)
                .await
                .is_ok();
            self.db_healthy.store(db_ok, Ordering::Relaxed);

            // Redis health
            let redis_ok = state.redis.exists("__health_check__").await.is_ok();
            self.redis_healthy.store(redis_ok, Ordering::Relaxed);

            if !db_ok {
                tracing::error!("Database health check FAILED");
            }
            if !redis_ok {
                tracing::warn!("Redis health check FAILED");
            }
        }
    }
}

// Readiness probe endpoint
pub async fn readiness_handler(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let healthy = state.health_checker.is_healthy();

    let status = if healthy {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (status, axum::Json(serde_json::json!({
        "ready": healthy,
        "db": state.health_checker.db_healthy.load(Ordering::Relaxed),
        "redis": state.health_checker.redis_healthy.load(Ordering::Relaxed),
    })))
}
```

---

## PHẦN 6 — Full Resilience Stack

### 6.1 Fallback Pattern

```rust
// Fallback: khi primary service down → dùng alternative

pub async fn get_document_with_fallback(
    state: &AppState,
    doc_id: i64,
) -> Result<Document, AppError> {
    // Try 1: Redis cache (fastest)
    if let Ok(Some(doc)) = state.redis.get::<Document>(&format!("doc:{}", doc_id)).await {
        tracing::debug!(doc_id = doc_id, "Served from cache");
        return Ok(doc);
    }

    // Try 2: Primary DB
    let result = state.circuit_breakers.database
        .execute(async {
            sqlx::query_as!(Document,
                "SELECT * FROM documents WHERE id = $1", doc_id)
                .fetch_optional(&state.db)
                .await
        })
        .await;

    match result {
        Ok(Ok(Some(doc))) => {
            // Warm cache
            state.redis.set(&format!("doc:{}", doc_id), &doc, Some(300)).await.ok();
            return Ok(doc);
        }
        Ok(Ok(None)) => return Err(AppError::NotFound),
        Ok(Err(e)) => tracing::warn!(error = %e, "DB query failed"),
        Err(CircuitBreakerError::CircuitOpen) => {
            tracing::warn!("DB circuit open, trying read replica");
        }
        Err(e) => tracing::error!(error = %e, "Circuit breaker error"),
    }

    // Fallback 3: Read replica
    if let Ok(Some(doc)) = sqlx::query_as!(Document,
        "SELECT * FROM documents WHERE id = $1", doc_id)
        .fetch_optional(&state.read_replica_db)
        .await {
        tracing::info!(doc_id = doc_id, "Served from read replica (fallback)");
        return Ok(doc);
    }

    Err(AppError::ServiceUnavailable)
}
```

### 6.2 Health Dashboard Endpoint

```rust
pub async fn health_dashboard(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let cb_db_stats = state.circuit_breakers.database_cb.stats();
    let cb_user_stats = state.circuit_breakers.user_service_cb.stats();

    axum::Json(serde_json::json!({
        "circuit_breakers": {
            "database": {
                "state": format!("{:?}", cb_db_stats.state),
                "failure_rate": cb_db_stats.failure_rate,
                "total_requests": cb_db_stats.total_requests,
            },
            "user_service": {
                "state": format!("{:?}", cb_user_stats.state),
                "failure_rate": cb_user_stats.failure_rate,
            }
        },
        "bulkheads": {
            "database": {
                "available_permits": state.bulkheads.database.available_permits(),
            },
            "user_service": {
                "available_permits": state.bulkheads.user_service.available_permits(),
            }
        }
    }))
}
```

---

## 🎯 So Sánh Resilience4J

```
┌────────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Pattern            │ Resilience4J (Java)           │ Tower + Custom (Rust)        │
├────────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Circuit Breaker    │ @CircuitBreaker               │ CircuitBreakerLayer          │
│ Retry              │ @Retry(maxAttempts = 3)       │ RetryLayer + RetryPolicy     │
│ Timeout            │ @TimeLimiter                  │ TimeoutLayer                 │
│ Bulkhead           │ @Bulkhead(maxConcurrent = 10) │ ConcurrencyLimitLayer        │
│ Rate Limiter       │ @RateLimiter                  │ tower_governor / Redis       │
│ Fallback           │ fallbackMethod = "..."        │ Explicit fallback in handler │
│ Composition        │ @CircuitBreaker + @Retry      │ ServiceBuilder chaining      │
│ Metrics            │ Micrometer integration        │ metrics crate + OTel         │
│ Config             │ application.yml               │ Code + Config struct         │
│ Overhead           │ JVM reflection + proxy        │ Zero-cost Tower abstraction  │
└────────────────────┴──────────────────────────────┴──────────────────────────────┘

Key difference: Tower middleware là pure Rust traits → compile-time checked
Không có reflection overhead, không có proxy generation
```

---

## 🏋️ Bài Tập

1. **Circuit Breaker**: Implement circuit breaker cho external user service call. Simulate failures. Verify: CLOSED → OPEN khi failure rate > 50%, HALF_OPEN sau 30s, CLOSED khi probe thành công.

2. **Retry + Backoff**: Implement retry wrapper với jitter. Log từng attempt với delay. Test với flaky service (fail 2 lần rồi succeed).

3. **Bulkhead**: Setup 3 bulkheads: DB (50 concurrent), Email service (5 concurrent), Storage (10 concurrent). Spam 100 concurrent requests. Verify bulkhead limits được giữ bằng metrics.

4. **Full Stack**: Combine tất cả: `ServiceBuilder::new().layer(timeout).layer(retry).layer(circuit_breaker).layer(bulkhead).service(client)`. Monitor với Prometheus: track circuit_breaker_state, retry_count, bulkhead_rejected.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-11-Axum-Middleware-Error|Bài 11: Tower Middleware foundation]]
- [[Rust-Zero-To-Hero/Bai-34-OpenTelemetry|Bài 34: OpenTelemetry → track resilience metrics]]
- [[Rust-Zero-To-Hero/Bai-31-Redis-Caching|Bài 31: Redis → rate limiting + fallback cache]]
- [[Rust-Zero-To-Hero/Plan-Framework-Mastery|Plan: Framework Mastery → roadmap overview]]
