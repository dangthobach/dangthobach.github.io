# Bài 34: OpenTelemetry — Distributed Tracing · Metrics · Jaeger

> **Prerequisite:** Bài 15 (Tracing cơ bản), Bài 9 (Tokio), Bài 28 (Tonic/gRPC)  
> **Mục tiêu:** Master observability stack đầy đủ — traces qua service boundaries, metrics Prometheus, log correlation, và tích hợp với Jaeger/OTLP

---

## 🗺️ Bức Tranh Tổng Quan

```
Observability = Metrics + Traces + Logs

  ┌──────────────────────────────────────────────────────────────┐
  │                     Microservices                            │
  │                                                              │
  │  ┌──────────────┐    ┌───────────────┐    ┌──────────────┐ │
  │  │  API Gateway  │───▶│ PDMS Service  │───▶│ User Service │ │
  │  │  (Axum)       │    │ (Tonic gRPC)  │    │ (Axum)       │ │
  │  └──────┬────────┘    └──────┬────────┘    └──────┬───────┘ │
  │         │                    │                     │         │
  └─────────┼────────────────────┼─────────────────────┼─────────┘
            │    OpenTelemetry SDK (traces, metrics, logs)       
            ▼                    ▼                     ▼         
  ┌─────────────────────────────────────────────────────────────┐
  │                 OpenTelemetry Collector                      │
  │  (filter, batch, export to multiple backends)               │
  └──────────────┬────────────────┬───────────────┬─────────────┘
                 │                │               │
          ┌──────▼──────┐  ┌──────▼──────┐  ┌───▼────────┐
          │   Jaeger    │  │ Prometheus   │  │    Loki     │
          │  (traces)   │  │  (metrics)  │  │   (logs)   │
          └─────────────┘  └─────────────┘  └────────────┘

Propagation context qua services:
  Request A (trace_id=abc, span_id=001)
       │ gRPC call với W3C traceparent header
       ▼
  Request B (trace_id=abc, span_id=002, parent=001)
       │ HTTP call với traceparent
       ▼
  Request C (trace_id=abc, span_id=003, parent=002)
  
→ Toàn bộ flow visible trong 1 trace tree trong Jaeger!

Java analog:
  Spring Cloud Sleuth + Micrometer + Zipkin/Jaeger
```

---

## PHẦN 1 — OpenTelemetry Setup

### 1.1 Dependencies

```toml
[dependencies]
# Core OpenTelemetry
opentelemetry = { version = "0.24", features = ["trace"] }
opentelemetry_sdk = { version = "0.24", features = ["rt-tokio", "trace"] }
opentelemetry-otlp = { version = "0.17", features = ["tonic", "trace", "metrics"] }
opentelemetry-semantic-conventions = "0.16"

# Tracing integration
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json", "registry"] }
tracing-opentelemetry = "0.25"

# Axum + Tower tracing
tower-http = { version = "0.5", features = ["trace"] }
axum-tracing-opentelemetry = "0.19"

# Metrics
opentelemetry-prometheus = "0.17"
prometheus = { version = "0.13", features = ["process"] }
metrics = "0.23"
metrics-exporter-prometheus = "0.15"
```

### 1.2 Tracer Setup

```rust
use opentelemetry::{global, trace::TracerProvider as _};
use opentelemetry_otlp::{ExportConfig, WithExportConfig};
use opentelemetry_sdk::{
    propagation::TraceContextPropagator,
    runtime::Tokio,
    trace::{BatchConfig, RandomIdGenerator, Sampler, SdkTracerProvider},
    Resource,
};
use opentelemetry::KeyValue;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

pub struct TelemetryGuard {
    _provider: SdkTracerProvider,
}

impl Drop for TelemetryGuard {
    fn drop(&mut self) {
        // Flush remaining spans on shutdown
        global::shutdown_tracer_provider();
    }
}

pub fn init_telemetry(config: &TelemetryConfig) -> TelemetryGuard {
    // W3C TraceContext propagation (standard cho HTTP headers)
    global::set_text_map_propagator(TraceContextPropagator::new());

    // Resource: thông tin về service
    let resource = Resource::new(vec![
        KeyValue::new("service.name", config.service_name.clone()),
        KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
        KeyValue::new("deployment.environment", config.environment.clone()),
        KeyValue::new("host.name", hostname()),
    ]);

    // OTLP Exporter → Jaeger / Grafana Tempo / OTEL Collector
    let tracer_provider = opentelemetry_otlp::new_pipeline()
        .tracing()
        .with_exporter(
            opentelemetry_otlp::new_exporter()
                .tonic()
                .with_endpoint(&config.otlp_endpoint) // "http://localhost:4317"
                .with_timeout(std::time::Duration::from_secs(3))
        )
        .with_trace_config(
            opentelemetry_sdk::trace::Config::default()
                .with_sampler(Sampler::ParentBased(Box::new(
                    // Sample 100% trong dev, 10% trong prod
                    if config.is_production() {
                        Sampler::TraceIdRatioBased(0.1)
                    } else {
                        Sampler::AlwaysOn
                    }
                )))
                .with_id_generator(RandomIdGenerator::default())
                .with_max_events_per_span(64)
                .with_max_attributes_per_span(32)
                .with_resource(resource.clone()),
        )
        .with_batch_config(
            BatchConfig::default()
                .with_max_queue_size(8192)
                .with_max_export_batch_size(512)
                .with_scheduled_delay(std::time::Duration::from_secs(5))
        )
        .install_batch(Tokio)
        .expect("OTLP tracer setup failed");

    let tracer = tracer_provider.tracer(config.service_name.clone());

    // Tracing subscriber: kết hợp console + OpenTelemetry
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(&config.log_level));

    let fmt_layer = tracing_subscriber::fmt::layer()
        .json()
        .with_current_span(true)
        .with_thread_ids(true);

    let otel_layer = tracing_opentelemetry::layer()
        .with_tracer(tracer)
        .with_error_records_to_exceptions(true);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt_layer)
        .with(otel_layer)
        .init();

    tracing::info!(
        service = %config.service_name,
        otlp_endpoint = %config.otlp_endpoint,
        "OpenTelemetry initialized"
    );

    TelemetryGuard { _provider: tracer_provider }
}
```

---

## PHẦN 2 — Distributed Tracing

### 2.1 Span Creation với tracing-opentelemetry

```rust
use tracing::{info, instrument, Span};
use opentelemetry::trace::TraceContextExt;

// #[instrument] tự tạo span với tên hàm
// Tất cả log trong function này thuộc về span này
#[instrument(
    name = "document.get_by_id",    // custom span name
    skip(pool),                      // skip logging pool
    fields(
        document.id = %id,
        // otel.status_code sẽ được set tự động nếu error
    )
)]
pub async fn get_document(pool: &PgPool, id: i64) -> Result<Document, AppError> {
    info!("Fetching document from database");

    // Add attributes to current span
    Span::current().record("db.system", "postgresql");
    Span::current().record("db.operation", "SELECT");

    let doc = sqlx::query_as!(Document,
        "SELECT * FROM documents WHERE id = $1", id)
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            // Error tự động attach vào span
            tracing::error!(error = %e, "DB query failed");
            AppError::Database(e)
        })?
        .ok_or_else(|| {
            tracing::warn!(document.id = id, "Document not found");
            AppError::NotFound
        })?;

    info!(document.title = %doc.title, "Document fetched successfully");
    Ok(doc)
}

// Manual span creation
pub async fn complex_operation(state: &AppState) -> Result<(), AppError> {
    // Parent span — sub-spans kế thừa context
    let span = tracing::info_span!("complex_operation");
    let _enter = span.enter();

    // Sub-operation 1
    {
        let _span = tracing::info_span!("validate_inputs").entered();
        validate_inputs().await?;
    }

    // Sub-operation 2 với custom attributes
    {
        let span = tracing::info_span!(
            "db_transaction",
            db.system = "postgresql",
            db.operation = "INSERT",
        );
        let _enter = span.enter();
        execute_transaction(&state.db).await?;
    }

    Ok(())
}
```

### 2.2 Axum Integration — Auto HTTP Tracing

```rust
use axum_tracing_opentelemetry::middleware::{OtelAxumLayer, OtelInResponseLayer};
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .nest("/api/v1", api_routes(state))
        .layer(
            tower::ServiceBuilder::new()
                // OpenTelemetry traces cho mỗi HTTP request
                // Tự động propagate W3C traceparent header
                .layer(OtelAxumLayer::default())
                // Inject trace ID vào response headers
                .layer(OtelInResponseLayer)
                // Tower HTTP tracing (logs)
                .layer(
                    TraceLayer::new_for_http()
                        .make_span_with(
                            DefaultMakeSpan::new()
                                .include_headers(false)
                                .level(tracing::Level::INFO)
                        )
                        .on_response(
                            DefaultOnResponse::new().level(tracing::Level::INFO)
                        )
                )
        )
}

// Response headers tự động có:
// traceparent: 00-{trace_id}-{span_id}-01
// tracestate: ""
```

### 2.3 Propagation qua HTTP Client (reqwest)

```rust
use opentelemetry::global;
use opentelemetry::propagation::Injector;
use tracing_opentelemetry::OpenTelemetrySpanExt;

// Custom reqwest middleware inject trace headers
pub struct TracePropagator;

// Helper inject W3C traceparent vào HashMap
struct HeaderInjector<'a>(pub &'a mut reqwest::header::HeaderMap);

impl<'a> Injector for HeaderInjector<'a> {
    fn set(&mut self, key: &str, value: String) {
        if let Ok(name) = reqwest::header::HeaderName::from_bytes(key.as_bytes()) {
            if let Ok(val) = reqwest::header::HeaderValue::from_str(&value) {
                self.0.insert(name, val);
            }
        }
    }
}

pub fn inject_trace_context(headers: &mut reqwest::header::HeaderMap) {
    let cx = tracing::Span::current().context();
    global::get_text_map_propagator(|propagator| {
        propagator.inject_context(&cx, &mut HeaderInjector(headers));
    });
}

// HTTP client với trace propagation
pub async fn call_user_service(
    client: &reqwest::Client,
    user_id: i64,
) -> Result<UserResponse, AppError> {
    let span = tracing::info_span!(
        "http.client.request",
        http.method = "GET",
        http.url = format!("/users/{}", user_id),
        peer.service = "user-service",
    );
    let _enter = span.enter();

    let mut headers = reqwest::header::HeaderMap::new();
    // Inject current trace context vào outgoing headers
    inject_trace_context(&mut headers);

    let response = client
        .get(format!("http://user-service:3000/users/{}", user_id))
        .headers(headers)
        .send()
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "HTTP call failed");
            AppError::External(e.to_string())
        })?;

    let status = response.status().as_u16();
    Span::current().record("http.status_code", status);

    response.json::<UserResponse>().await
        .map_err(|e| AppError::External(e.to_string()))
}
```

### 2.4 Propagation qua gRPC (Tonic)

```rust
use opentelemetry::global;
use opentelemetry::propagation::{Injector, Extractor};
use tonic::metadata::{MetadataMap, MetadataValue};

// Inject context vào gRPC metadata
struct MetadataInjector<'a>(&'a mut MetadataMap);

impl<'a> Injector for MetadataInjector<'a> {
    fn set(&mut self, key: &str, value: String) {
        if let Ok(key) = key.parse::<tonic::metadata::MetadataKey<_>>() {
            if let Ok(val) = MetadataValue::from_str(&value) {
                self.0.insert(key, val);
            }
        }
    }
}

// Extract context từ incoming gRPC request
struct MetadataExtractor<'a>(&'a MetadataMap);

impl<'a> Extractor for MetadataExtractor<'a> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|v| v.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(|k| k.as_str()).collect()
    }
}

// gRPC client interceptor — inject trace context
pub fn grpc_trace_client_interceptor(
    mut req: tonic::Request<()>,
) -> Result<tonic::Request<()>, tonic::Status> {
    let cx = tracing::Span::current().context();
    global::get_text_map_propagator(|propagator| {
        propagator.inject_context(&cx, &mut MetadataInjector(req.metadata_mut()));
    });
    Ok(req)
}

// gRPC server interceptor — extract và continue trace
pub fn grpc_trace_server_interceptor(
    req: tonic::Request<()>,
) -> Result<tonic::Request<()>, tonic::Status> {
    let parent_cx = global::get_text_map_propagator(|propagator| {
        propagator.extract(&MetadataExtractor(req.metadata()))
    });

    // Tạo span với parent context từ client
    let span = tracing::info_span!("grpc.server.request");
    span.set_parent(parent_cx);
    let _enter = span.enter();

    Ok(req)
}

// Apply trên gRPC server
let user_service = UserServiceServer::with_interceptor(
    service,
    grpc_trace_server_interceptor,
);
```

---

## PHẦN 3 — Metrics

### 3.1 Prometheus Metrics Setup

```rust
use metrics::{counter, gauge, histogram};
use metrics_exporter_prometheus::PrometheusBuilder;
use std::time::Duration;

pub fn init_metrics(service_name: &str) -> Result<(), Box<dyn std::error::Error>> {
    PrometheusBuilder::new()
        // Global labels cho tất cả metrics
        .add_global_label("service", service_name)
        .add_global_label("version", env!("CARGO_PKG_VERSION"))
        // Histogram buckets cho response time
        .set_buckets(&[
            0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
        ])?
        .install()?;

    Ok(())
}

// Custom metrics trong code
pub fn record_request_metrics(
    method: &str,
    path: &str,
    status: u16,
    duration: Duration,
) {
    let labels = [
        ("method", method.to_string()),
        ("path", path.to_string()),
        ("status", status.to_string()),
    ];

    // Counter: tổng số requests
    counter!("http_requests_total", &labels).increment(1);

    // Histogram: response time distribution
    histogram!("http_request_duration_seconds", &labels)
        .record(duration.as_secs_f64());
}

pub fn record_db_query_metrics(operation: &str, table: &str, duration: Duration, success: bool) {
    let labels = [
        ("operation", operation.to_string()),
        ("table", table.to_string()),
        ("success", success.to_string()),
    ];

    counter!("db_queries_total", &labels).increment(1);
    histogram!("db_query_duration_seconds", &labels).record(duration.as_secs_f64());
}

pub fn record_cache_metrics(cache_type: &str, hit: bool) {
    let labels = [
        ("cache", cache_type.to_string()),
        ("result", if hit { "hit" } else { "miss" }.to_string()),
    ];
    counter!("cache_operations_total", &labels).increment(1);
}
```

### 3.2 Axum Metrics Middleware

```rust
use axum::{
    extract::MatchedPath,
    http::{Method, Request},
    middleware::Next,
    response::Response,
};
use std::time::Instant;

pub async fn metrics_middleware(
    method: Method,
    matched_path: Option<MatchedPath>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let start = Instant::now();

    // Use matched route pattern, not actual path (avoid cardinality explosion)
    let path = matched_path
        .as_ref()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let response = next.run(req).await;

    let duration = start.elapsed();
    let status = response.status().as_u16();

    record_request_metrics(method.as_str(), &path, status, duration);

    response
}

// Expose /metrics endpoint
pub async fn metrics_handler() -> impl axum::response::IntoResponse {
    use prometheus::{Encoder, TextEncoder};

    let encoder = TextEncoder::new();
    let metric_families = prometheus::gather();
    let mut buffer = vec![];
    encoder.encode(&metric_families, &mut buffer).unwrap();

    (
        [("Content-Type", "text/plain; version=0.0.4; charset=utf-8")],
        buffer,
    )
}
```

### 3.3 Business Metrics — PDMS Specific

```rust
// Domain-specific metrics cho PDMS
pub struct PdmsMetrics;

impl PdmsMetrics {
    // Document operations
    pub fn document_uploaded(category: &str, size_kb: u64) {
        counter!("pdms_documents_uploaded_total", "category" => category.to_string())
            .increment(1);
        histogram!("pdms_document_size_kb", "category" => category.to_string())
            .record(size_kb as f64);
    }

    pub fn document_approved(time_to_approve_hours: f64) {
        counter!("pdms_documents_approved_total").increment(1);
        histogram!("pdms_document_approval_time_hours").record(time_to_approve_hours);
    }

    pub fn import_job_completed(records: u64, failed: u64, duration: Duration) {
        counter!("pdms_import_jobs_total", "result" => "success").increment(1);
        counter!("pdms_import_records_total", "result" => "success").increment(records);
        counter!("pdms_import_records_total", "result" => "failed").increment(failed);
        histogram!("pdms_import_job_duration_seconds").record(duration.as_secs_f64());
    }

    pub fn active_users_gauge(count: i64) {
        gauge!("pdms_active_users").set(count as f64);
    }

    pub fn storage_usage_bytes(bytes: u64) {
        gauge!("pdms_storage_usage_bytes").set(bytes as f64);
    }
}

// Update gauges periodically (dùng scheduler từ Bài 33)
pub async fn update_business_metrics(state: Arc<AppState>) {
    loop {
        // Active users in last 5 minutes
        if let Ok(count) = sqlx::query_scalar!(
            "SELECT COUNT(DISTINCT user_id) FROM sessions WHERE last_activity > NOW() - INTERVAL '5 minutes'"
        )
        .fetch_one(&state.db)
        .await {
            PdmsMetrics::active_users_gauge(count.unwrap_or(0));
        }

        // Storage usage
        if let Ok(bytes) = sqlx::query_scalar!(
            "SELECT COALESCE(SUM(file_size_bytes), 0) FROM documents WHERE status != 'deleted'"
        )
        .fetch_one(&state.db)
        .await {
            PdmsMetrics::storage_usage_bytes(bytes.unwrap_or(0) as u64);
        }

        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}
```

---

## PHẦN 4 — Structured Logging với Trace Correlation

### 4.1 Log Format với Trace ID

```rust
// Structured log output (JSON) với trace_id + span_id tự động:
// {
//   "timestamp": "2024-01-15T10:30:00Z",
//   "level": "INFO",
//   "message": "Document created",
//   "service.name": "pdms-service",
//   "trace_id": "abc123def456",     ← từ OpenTelemetry span
//   "span_id": "123abc",            ← correlatable trong Jaeger
//   "document.id": 42,
//   "user.id": 1
// }

// Tất cả logs trong một #[instrument] span tự động có trace_id

#[instrument(fields(document.id = %doc_id, user.id = %user_id))]
pub async fn approve_document(
    db: &PgPool,
    doc_id: i64,
    user_id: i64,
) -> Result<Document, AppError> {
    tracing::info!("Document approval started");

    let doc = sqlx::query_as!(Document,
        "UPDATE documents SET status = 'approved', approved_by = $1, approved_at = NOW()
         WHERE id = $2 RETURNING *",
        user_id, doc_id)
        .fetch_one(db)
        .await?;

    tracing::info!(
        document.title = %doc.title,
        "Document approved"
    );

    Ok(doc)
}
// Log sẽ có trace_id → search trong Loki → click → xem Jaeger trace
```

### 4.2 Baggage — Pass Data qua Service Boundaries

```rust
use opentelemetry::{baggage::BaggageExt, Context};

// Baggage: key-value propagated qua toàn bộ trace
// Dùng cho: tenant_id, request_id, user_id, feature flags

pub fn with_baggage(tenant_id: &str, user_id: i64) -> Context {
    let cx = Context::current();
    cx.with_baggage(vec![
        opentelemetry::KeyValue::new("tenant.id", tenant_id.to_string()),
        opentelemetry::KeyValue::new("user.id", user_id.to_string()),
    ])
}

// Set trong entry point (middleware)
pub async fn tenant_context_middleware(
    headers: axum::http::HeaderMap,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    let tenant_id = headers
        .get("X-Tenant-Id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("default");

    // Add tenant to trace context
    let _cx = opentelemetry::Context::current()
        .with_baggage(vec![
            opentelemetry::KeyValue::new("tenant.id", tenant_id.to_string()),
        ])
        .attach();

    next.run(req).await
}
```

---

## PHẦN 5 — Jaeger Setup & Docker

### 5.1 Docker Compose

```yaml
# docker-compose.yml
version: '3.8'

services:
  # OTEL Collector (receives from services, routes to backends)
  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    command: ["--config=/etc/otel-collector-config.yaml"]
    volumes:
      - ./otel-collector-config.yaml:/etc/otel-collector-config.yaml
    ports:
      - "4317:4317"   # OTLP gRPC receiver
      - "4318:4318"   # OTLP HTTP receiver
      - "8889:8889"   # Prometheus metrics exporter
    depends_on:
      - jaeger

  # Jaeger: distributed tracing UI
  jaeger:
    image: jaegertracing/all-in-one:latest
    environment:
      - COLLECTOR_OTLP_ENABLED=true
    ports:
      - "16686:16686"  # Jaeger UI
      - "14317:4317"   # OTLP gRPC
    
  # Prometheus: metrics
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"
    
  # Grafana: dashboards
  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
    volumes:
      - ./grafana/provisioning:/etc/grafana/provisioning

  # Application
  pdms-service:
    build: .
    environment:
      - OTLP_ENDPOINT=http://otel-collector:4317
      - DATABASE_URL=postgres://user:pass@postgres/pdms
    ports:
      - "3000:3000"
```

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 1s
    send_batch_size: 1024
  
  # Add resource attributes
  resource:
    attributes:
      - key: environment
        value: development
        action: upsert

  # Sample traces (reduce volume in production)
  probabilistic_sampler:
    sampling_percentage: 100  # 100% in dev

exporters:
  jaeger:
    endpoint: jaeger:14250
    tls:
      insecure: true
  
  prometheus:
    endpoint: "0.0.0.0:8889"
    namespace: pdms
  
  # Debug: print to console
  debug:
    verbosity: detailed

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, resource]
      exporters: [jaeger, debug]
    
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus]
```

```yaml
# prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'pdms-service'
    static_configs:
      - targets: ['pdms-service:3000']
    metrics_path: '/metrics'
  
  - job_name: 'otel-collector'
    static_configs:
      - targets: ['otel-collector:8889']
```

---

## PHẦN 6 — Full Observability Setup trong main.rs

```rust
// main.rs — complete observability initialization

#[tokio::main]
async fn main() {
    // Load config
    let config = Config::from_env().expect("Config failed");

    // Initialize telemetry (must be before any spans!)
    let _telemetry_guard = init_telemetry(&config.telemetry);

    // Initialize metrics
    init_metrics(&config.telemetry.service_name)
        .expect("Metrics init failed");

    tracing::info!(
        service = %config.telemetry.service_name,
        version = env!("CARGO_PKG_VERSION"),
        "Service starting"
    );

    // Database
    let pool = PgPoolOptions::new()
        .max_connections(config.database.max_connections)
        .connect(&config.database.url)
        .await
        .expect("DB connect failed");

    sqlx::migrate!().run(&pool).await.expect("Migration failed");

    // Redis
    let redis = create_redis_pool(&config.redis.url).expect("Redis pool failed");

    let state = Arc::new(AppState { db: pool.clone(), redis });

    // Background metrics updater
    let state_clone = state.clone();
    tokio::spawn(async move {
        update_business_metrics(state_clone).await;
    });

    // Build router
    let app = Router::new()
        .nest("/api/v1", api_routes(state.clone()))
        // Expose metrics endpoint
        .route("/metrics", axum::routing::get(metrics_handler))
        .route("/health", axum::routing::get(health_handler))
        .layer(
            tower::ServiceBuilder::new()
                // OTel trace for each request
                .layer(OtelAxumLayer::default())
                // Inject trace ID into response
                .layer(OtelInResponseLayer)
                // Metrics collection
                .layer(axum::middleware::from_fn(metrics_middleware))
                // Other middleware...
        )
        .with_state(state);

    let addr = format!("0.0.0.0:{}", config.server.port);
    tracing::info!(addr = %addr, "HTTP server starting");

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();

    tracing::info!("Server stopped");
    // _telemetry_guard drops here → flushes remaining spans
}

async fn health_handler() -> impl axum::response::IntoResponse {
    axum::Json(serde_json::json!({
        "status": "healthy",
        "version": env!("CARGO_PKG_VERSION"),
        "timestamp": chrono::Utc::now().to_rfc3339(),
    }))
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c().await.expect("Failed to listen for shutdown");
    tracing::info!("Shutdown signal received");
}
```

---

## 🎯 So Sánh Spring Boot Observability

| Concept | Spring Boot | Rust |
|---|---|---|
| Distributed tracing | Spring Cloud Sleuth | `tracing-opentelemetry` |
| Trace propagation | Auto (Sleuth injects headers) | `inject_trace_context()` / interceptors |
| Metrics | Micrometer + Actuator | `metrics` crate + `/metrics` endpoint |
| Log correlation | MDC (thread-local) | Span context (async-safe) |
| Span creation | `@Traced` / `Tracer.nextSpan()` | `#[instrument]` / `info_span!()` |
| Exporter | Zipkin / Jaeger / OTLP | OTLP (standard) |
| Health check | `/actuator/health` | Custom `/health` handler |
| Tracing backend | Jaeger / Zipkin / Tempo | Jaeger / Tempo / Honeycomb |

---

## 🏋️ Bài Tập

1. **Full Setup**: Spin up Docker Compose với OTEL Collector + Jaeger + Prometheus + Grafana. Configure Rust app với OTLP exporter. Verify traces hiển thị trong Jaeger UI.

2. **Cross-service Trace**: Implement 2 services: Gateway (Axum) gọi UserService (Tonic gRPC). Verify trace_id liên tục qua cả hai services trong Jaeger.

3. **Custom Metrics**: Add Prometheus metrics: (a) request rate per endpoint, (b) document upload count by category, (c) DB query duration histogram. Tạo Grafana dashboard.

4. **Trace Sampling**: Implement 100% sampling cho `/health` routes, 10% cho normal routes, 100% cho error responses. Verify trong Jaeger.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-15-Config-Tracing-Testing|Bài 15: Tracing cơ bản]]
- [[Rust-Zero-To-Hero/Bai-28-Tonic-GRPC|Bài 28: Tonic — gRPC trace propagation]]
- [[Rust-Zero-To-Hero/Bai-35-Resilience|Bài 35: Resilience]] → tiếp theo
