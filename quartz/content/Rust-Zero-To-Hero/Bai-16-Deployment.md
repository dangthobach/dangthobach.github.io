# Bài 16: Deployment — Docker, MUSL & Production

---

## 1. Tại Sao Rust Deployment Khác Hoàn Toàn Java

```
JAVA deployment:
  JVM (~300MB) + JAR (~50-200MB) + Heap config (-Xmx)
  Container: ~400-600MB image
  Startup: 10-60 giây (Spring context, JIT compile)
  
RUST deployment:
  Single binary (~10-30MB static) — KHÔNG CẦN runtime
  Container: ~15-50MB image (distroless)
  Startup: <100ms (no JIT, no class loading)
  
Ý nghĩa:
  - Kubernetes pod startup: 10s (Java) vs 0.1s (Rust) → faster rolling deploy
  - Memory limit: 512MB (Java) vs 64MB (Rust) → 8x density trên cùng node
  - Cold start Lambda: critical difference nếu dùng serverless
```

---

## 2. Build Optimization

### Release Profile

```toml
# Cargo.toml
[profile.release]
opt-level = 3          # Max optimization
lto = true             # Link-Time Optimization — remove dead code across crates
codegen-units = 1      # Single codegen unit — slower build, smaller/faster binary
strip = true           # Strip debug symbols — binary nhỏ hơn ~50%
panic = "abort"        # Panic → abort thay vì unwind → nhỏ hơn, nhanh hơn

[profile.release-with-debug]  # Custom profile cho profiling
inherits = "release"
strip = false
debug = true
```

```bash
# Build release
cargo build --release

# Build size comparison
ls -lh target/release/myapp
# Without strip: ~25MB
# With strip = true: ~8MB
# With UPX compression: ~4MB (optional)
```

---

## 3. Static Linking với MUSL — Binary Không Cần Glibc

```
Vấn đề với dynamic linking:
  Binary yêu cầu glibc của host OS
  Ubuntu 22.04: glibc 2.35
  Debian Buster: glibc 2.28
  → Binary build trên Ubuntu không chạy trên Alpine (musl)

Solution: MUSL static linking
  Binary tự chứa tất cả — không cần glibc trên host
  → Chạy trên BẤT KỲ Linux nào, kể cả Alpine (3MB base image)
```

```bash
# Thêm musl target
rustup target add x86_64-unknown-linux-musl

# Build static binary
cargo build --release --target x86_64-unknown-linux-musl

# Verify: không depend glibc
ldd target/x86_64-unknown-linux-musl/release/myapp
# → statically linked
```

---

## 4. Multi-stage Dockerfile

### Option A: Builder + Distroless (Recommended)

```dockerfile
# ====== Stage 1: Build ======
FROM rust:1.78-slim-bullseye AS builder

WORKDIR /app

# Cache dependencies separately (Docker layer caching)
# Trick: copy Cargo files first, build deps, then copy source
COPY Cargo.toml Cargo.lock ./

# Dummy main để build deps
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release --target x86_64-unknown-linux-musl 2>/dev/null || true
RUN rm src/main.rs

# Install musl tools
RUN apt-get update && apt-get install -y musl-tools && rustup target add x86_64-unknown-linux-musl

# Copy actual source
COPY src ./src
COPY config ./config
COPY migrations ./migrations

# Build release binary
RUN cargo build --release --target x86_64-unknown-linux-musl

# Strip debug symbols
RUN strip target/x86_64-unknown-linux-musl/release/myapp

# ====== Stage 2: Runtime ======
FROM gcr.io/distroless/static-debian12

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/target/x86_64-unknown-linux-musl/release/myapp .
COPY --from=builder /app/config ./config
COPY --from=builder /app/migrations ./migrations

# Non-root user (security best practice)
USER nonroot:nonroot

EXPOSE 3000

ENTRYPOINT ["./myapp"]
```

### Option B: Alpine (Smaller dev feedback loop)

```dockerfile
FROM rust:1.78-alpine AS builder
RUN apk add --no-cache musl-dev

WORKDIR /app
COPY . .
RUN cargo build --release

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=builder /app/target/release/myapp /usr/local/bin/
EXPOSE 3000
CMD ["myapp"]
```

```bash
# Image size comparison
docker images | grep myapp
# Java Spring Boot (jre-slim)     : 250-400 MB
# Rust + distroless               : 15-30 MB
# Rust + Alpine                   : 20-40 MB
```

---

## 5. Docker Compose cho Local Development

```yaml
# docker-compose.yml
version: '3.9'

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile.dev    # faster dev build, không musl
    ports:
      - "3000:3000"
    environment:
      APP__DATABASE__URL: postgres://postgres:password@postgres:5432/myapp
      APP__KAFKA__BROKERS: kafka:9092
      APP__JWT__SECRET: dev-secret-not-for-production
      APP__OBSERVABILITY__LOG_LEVEL: debug
    depends_on:
      postgres:
        condition: service_healthy
      kafka:
        condition: service_healthy
    volumes:
      - ./config:/app/config       # mount config cho hot reload

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: password
      POSTGRES_DB: myapp
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  kafka:
    image: confluentinc/cp-kafka:7.6.0
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      CLUSTER_ID: MkU3OEVBNTcwNTJENDM2Qk
    ports:
      - "9092:9092"
    healthcheck:
      test: ["CMD-SHELL", "kafka-topics.sh --bootstrap-server localhost:9092 --list"]
      interval: 10s
      timeout: 10s
      retries: 10

volumes:
  pgdata:
```

---

## 6. Graceful Shutdown — Hoàn Chỉnh

```rust
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = load_config()?;
    init_tracing(&config.observability);
    
    let pool = create_pool(&config.database).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    
    let shutdown_token = CancellationToken::new();
    
    let app_state = AppState {
        pool: pool.clone(),
        config: Arc::new(config.clone()),
        shutdown: shutdown_token.clone(),
    };
    
    let router = build_router(app_state.clone());
    let addr = format!("{}:{}", config.server.host, config.server.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    
    tracing::info!(addr = %addr, "Server starting");
    
    tokio::select! {
        result = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown_token.clone().cancelled()) => {
            if let Err(e) = result { tracing::error!(?e, "Server error"); }
        }
        
        // Background tasks
        _ = run_kafka_consumer(app_state.clone(), shutdown_token.clone()) => {}
        _ = run_outbox_poller(pool.clone(), shutdown_token.clone()) => {}
        
        // OS signals
        _ = wait_for_signal() => {
            tracing::info!("Shutdown signal received");
            shutdown_token.cancel();   // notify all tasks
        }
    }
    
    // Drain: give in-flight requests time to complete
    tracing::info!("Waiting for in-flight requests to drain...");
    tokio::time::sleep(Duration::from_secs(5)).await;
    
    // Cleanup
    pool.close().await;
    tracing::info!("Shutdown complete");
    
    Ok(())
}

async fn wait_for_signal() {
    let ctrl_c = async { tokio::signal::ctrl_c().await.unwrap() };
    
    #[cfg(unix)]
    let sigterm = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .unwrap()
            .recv()
            .await
    };
    
    #[cfg(not(unix))]
    let sigterm = std::future::pending::<()>();
    
    tokio::select! { _ = ctrl_c => {}, _ = sigterm => {} }
}
```

---

## 7. Health Check & Readiness

```rust
// Kubernetes liveness + readiness probe pattern
use axum::http::StatusCode;

// Liveness: "Am I running?" — simple, fast
async fn liveness() -> StatusCode {
    StatusCode::OK
}

// Readiness: "Can I serve traffic?" — check dependencies
async fn readiness(State(state): State<AppState>) -> impl IntoResponse {
    let db_ok = sqlx::query("SELECT 1")
        .fetch_one(&state.pool)
        .await
        .is_ok();
    
    if db_ok {
        (StatusCode::OK, Json(json!({ "status": "ready", "db": "ok" })))
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "status": "not ready", "db": "error" })))
    }
}

// Routes (không qua auth middleware)
Router::new()
    .route("/health/live", get(liveness))
    .route("/health/ready", get(readiness))
```

---

## 8. Kubernetes Deployment Manifest

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pdms-service
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: pdms-service
        image: registry.example.com/pdms-service:v1.2.0
        
        resources:
          requests:
            memory: "32Mi"    # Java cần 256-512Mi
            cpu: "50m"
          limits:
            memory: "128Mi"   # Rust predictable — không GC spike
            cpu: "500m"
        
        env:
        - name: APP__DATABASE__URL
          valueFrom:
            secretKeyRef:
              name: pdms-secrets
              key: database-url
        - name: APP__JWT__SECRET
          valueFrom:
            secretKeyRef:
              name: pdms-secrets
              key: jwt-secret
        
        livenessProbe:
          httpGet:
            path: /health/live
            port: 3000
          initialDelaySeconds: 3    # Java: 30-60s
          periodSeconds: 10
        
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 3000
          initialDelaySeconds: 3
          periodSeconds: 5
        
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 5"]   # Allow LB to drain
```

---

## 9. CI/CD Pipeline (GitHub Actions)

```yaml
# .github/workflows/ci.yml
name: CI

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: password }
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
    
    steps:
    - uses: actions/checkout@v4
    
    - name: Cache cargo
      uses: actions/cache@v4
      with:
        path: |
          ~/.cargo/registry
          ~/.cargo/git
          target
        key: ${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}
    
    - name: Run tests
      env:
        DATABASE_URL: postgres://postgres:password@localhost:5432/postgres
      run: cargo test --all-features
    
    - name: Check formatting
      run: cargo fmt --check
    
    - name: Clippy (linter)
      run: cargo clippy -- -D warnings

  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    
    - name: Install musl tools
      run: |
        sudo apt-get install -y musl-tools
        rustup target add x86_64-unknown-linux-musl
    
    - name: Build release
      run: cargo build --release --target x86_64-unknown-linux-musl
    
    - name: Build Docker image
      run: docker build -t pdms-service:${{ github.sha }} .
    
    - name: Push to registry
      run: |
        docker tag pdms-service:${{ github.sha }} registry.example.com/pdms-service:${{ github.sha }}
        docker push registry.example.com/pdms-service:${{ github.sha }}
```

---

## 10. Production Checklist

```
Binary & Build:
[ ] cargo build --release --target x86_64-unknown-linux-musl
[ ] strip = true trong Cargo.toml [profile.release]
[ ] lto = true, codegen-units = 1
[ ] Binary size < 30MB

Container:
[ ] Multi-stage Dockerfile
[ ] Non-root user (nonroot:nonroot)
[ ] Distroless hoặc Alpine base
[ ] Image size < 50MB
[ ] No secrets trong image layers

Config:
[ ] Tất cả secrets qua environment variables hoặc Kubernetes secrets
[ ] Không hardcode config trong binary
[ ] Config validation at startup (fail fast)

Observability:
[ ] Structured JSON logs (production mode)
[ ] Request ID propagation
[ ] /health/live và /health/ready endpoints
[ ] Metrics endpoint (optional: Prometheus /metrics)

Reliability:
[ ] Graceful shutdown (SIGTERM → drain → exit)
[ ] DB connection pool configured
[ ] Timeouts trên tất cả external calls
[ ] Circuit breaker nếu gọi nhiều external services

Security:
[ ] JWT secret rotation plan
[ ] TLS termination (nginx/Envoy/ALB)
[ ] Rate limiting (Tower middleware hoặc API Gateway)
[ ] Input validation trên tất cả endpoints
```

---

## So sánh Deployment: Java vs Rust — Tổng kết

```
┌───────────────────┬─────────────────────┬──────────────────────┐
│                   │ Java Spring Boot     │ Rust Axum            │
├───────────────────┼─────────────────────┼──────────────────────┤
│ Artifact size     │ 100-300 MB (JVM+JAR)│ 10-30 MB (binary)    │
│ Container image   │ 250-600 MB          │ 15-50 MB             │
│ Startup time      │ 10-60 giây          │ <100 ms              │
│ Memory (idle)     │ 256-512 MB          │ 20-64 MB             │
│ Memory (peak)     │ 1-4 GB (GC spikes)  │ 64-256 MB (stable)   │
│ CPU (cold start)  │ High (JIT compile)  │ Minimal              │
│ K8s pod density   │ 2-4 per node        │ 16-32 per node       │
│ Rolling deploy    │ Slow (liveness wait)│ Fast (<5s ready)     │
│ Predictability    │ GC pauses possible  │ Deterministic        │
└───────────────────┴─────────────────────┴──────────────────────┘
```

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-15-Config-Tracing-Testing|Bài 15: Config & Tracing]]
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9: CancellationToken, select!]]
- [[MOC-PDMS]] — production deployment context
