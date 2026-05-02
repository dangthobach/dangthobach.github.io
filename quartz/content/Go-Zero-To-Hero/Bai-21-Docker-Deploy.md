# Bài 21: Docker, CI/CD & Kubernetes Deployment

> **Mục tiêu:** Đóng gói Go service thành Docker image tối ưu, thiết lập CI/CD pipeline, và deploy lên Kubernetes với health checks, resource limits.

---

## 1. Tại sao Go + Docker là "perfect match"?

```
┌──────────────────────────────────────────────────────────────┐
│             GO + DOCKER — PERFECT MATCH                      │
│                                                              │
│  Go compiles to SINGLE STATIC BINARY                         │
│  → Không cần JVM, Python runtime, Node.js                   │
│  → Image size: Go ~10MB vs Java Spring ~200MB+              │
│                                                              │
│  Java Spring Boot image:                                     │
│  ┌─────────────────────────────────┐                        │
│  │ ubuntu:22.04          ~80MB     │                        │
│  │ + JDK 21              ~180MB    │                        │
│  │ + app.jar             ~50MB     │                        │
│  │ = TOTAL               ~310MB   │                        │
│  └─────────────────────────────────┘                        │
│                                                              │
│  Go service image (distroless):                              │
│  ┌─────────────────────────────────┐                        │
│  │ gcr.io/distroless/static ~2MB   │                        │
│  │ + ./server binary        ~10MB  │                        │
│  │ = TOTAL                  ~12MB  │                        │
│  └─────────────────────────────────┘                        │
│                                                              │
│  → 25x smaller image → faster pull → faster startup         │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Multi-stage Dockerfile

```dockerfile
# ── Stage 1: Builder ──────────────────────────────────────────
FROM golang:1.22-alpine AS builder

# Security: non-root build
RUN addgroup -g 1001 appgroup && \
    adduser -D -u 1001 -G appgroup appuser

WORKDIR /app

# Cache dependencies (layer cache optimization)
# Copy go.mod/go.sum TRƯỚC khi copy source code
# → Chỉ re-download deps khi go.mod thay đổi
COPY go.mod go.sum ./
RUN go mod download && go mod verify

# Copy source code
COPY . .

# Build với optimizations
RUN CGO_ENABLED=0 \
    GOOS=linux \
    GOARCH=amd64 \
    go build \
      -ldflags="-s -w \
        -X main.Version=${VERSION} \
        -X main.BuildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
        -X main.GitCommit=${GIT_COMMIT}" \
      -trimpath \
      -o /app/bin/server \
      ./cmd/server/

# -s: strip symbol table
# -w: strip DWARF debug info
# -trimpath: remove build path from binary
# CGO_ENABLED=0: static binary (no C dependencies)

# ── Stage 2: Runtime (Distroless) ────────────────────────────
# gcr.io/distroless/static: only ca-certificates + timezone data
# No shell, no package manager → minimal attack surface
FROM gcr.io/distroless/static-debian12:nonroot AS runtime

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/bin/server .

# Copy config (nếu cần — prefer env vars)
COPY --from=builder /app/config/config.yaml ./config/

# Non-root user (security best practice)
USER nonroot:nonroot

# Expose port
EXPOSE 8080

# Health check (Docker will restart if unhealthy)
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["/app/server", "--health-check"]
# Hoặc dùng wget/curl nếu dùng image có shell:
# HEALTHCHECK CMD wget -qO- http://localhost:8080/health || exit 1

ENTRYPOINT ["/app/server"]
```

---

## 3. docker-compose cho local development

```yaml
# docker-compose.yml
version: "3.9"

services:
  pdms-service:
    build:
      context: .
      dockerfile: Dockerfile
      target: builder           # Dùng builder stage cho dev (có shell)
      args:
        - VERSION=dev
        - GIT_COMMIT=local
    image: pdms-service:dev
    container_name: pdms-service
    restart: unless-stopped
    ports:
      - "8080:8080"
      - "2345:2345"             # Delve debugger port
    environment:
      - PDMS_SERVER_PORT=8080
      - PDMS_DATABASE_HOST=postgres
      - PDMS_DATABASE_USER=pdms
      - PDMS_DATABASE_PASSWORD=pdms_dev_password
      - PDMS_DATABASE_NAME=pdms
      - PDMS_KAFKA_BROKERS=kafka:9092
      - PDMS_REDIS_HOST=redis
      - PDMS_JWT_SECRET=dev-secret-change-in-prod
      - PDMS_LOG_LEVEL=debug
      - PDMS_ENV=development
    depends_on:
      postgres:
        condition: service_healthy
      kafka:
        condition: service_healthy
      redis:
        condition: service_healthy
    volumes:
      - .:/app                  # Source mount cho hot reload
    networks:
      - pdms-network

  postgres:
    image: postgres:16-alpine
    container_name: pdms-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: pdms
      POSTGRES_PASSWORD: pdms_dev_password
      POSTGRES_DB: pdms
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./migrations:/docker-entrypoint-initdb.d  # Auto-run migrations
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pdms"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - pdms-network

  kafka:
    image: confluentinc/cp-kafka:7.6.0
    container_name: pdms-kafka
    restart: unless-stopped
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      CLUSTER_ID: MkU3OEVBNTcwNTJENDM2Qk
    ports:
      - "9092:9092"
    healthcheck:
      test: ["CMD", "kafka-broker-api-versions", "--bootstrap-server", "kafka:9092"]
      interval: 15s
      timeout: 10s
      retries: 5
    networks:
      - pdms-network

  redis:
    image: redis:7-alpine
    container_name: pdms-redis
    restart: unless-stopped
    command: redis-server --appendonly yes --requirepass redis_dev_password
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "redis_dev_password", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3
    networks:
      - pdms-network

  # Optional: Jaeger for tracing (dev only)
  jaeger:
    image: jaegertracing/all-in-one:latest
    container_name: pdms-jaeger
    ports:
      - "16686:16686"   # Jaeger UI
      - "4318:4318"     # OTLP HTTP
    networks:
      - pdms-network

volumes:
  postgres_data:
  redis_data:

networks:
  pdms-network:
    driver: bridge
```

---

## 4. Live Reload với Air

```toml
# .air.toml — hot reload cho Go development
root = "."
tmp_dir = "tmp"

[build]
  cmd = "go build -o ./tmp/main ./cmd/server/"
  bin = "./tmp/main"
  delay = 1000
  include_ext = ["go", "tpl", "tmpl", "html"]
  exclude_dir = ["assets", "tmp", "vendor", "testdata"]
  exclude_file = []
  exclude_regex = ["_test.go"]
  kill_delay = "0s"
  log = "build-errors.log"
  
[log]
  time = false

[color]
  main = "magenta"
  watcher = "cyan"
  build = "yellow"
  runner = "green"

[misc]
  clean_on_exit = true
```

```bash
# go install github.com/air-verse/air@latest
air  # Tự động reload khi thay đổi source code
```

---

## 5. CI/CD Pipeline — GitHub Actions

```yaml
# .github/workflows/ci.yml
name: CI/CD Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}/pdms-service

jobs:
  # ── Job 1: Test ──────────────────────────────────────────────
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: pdms_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: "1.22"
          cache: true                     # Cache go modules
      
      - name: Lint
        uses: golangci/golangci-lint-action@v4
        with:
          version: latest
      
      - name: Test with Race Detection
        run: |
          go test -race -cover -coverprofile=coverage.out ./...
        env:
          DATABASE_URL: postgres://test:test@localhost:5432/pdms_test?sslmode=disable
      
      - name: Upload Coverage
        uses: codecov/codecov-action@v4
        with:
          files: coverage.out
  
  # ── Job 2: Security Scan ─────────────────────────────────────
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Run Gosec Security Scanner
        uses: securego/gosec@master
        with:
          args: ./...
      
      - name: Trivy vulnerability scan
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: fs
          exit-code: 1
          severity: CRITICAL,HIGH

  # ── Job 3: Build & Push Image ────────────────────────────────
  build:
    needs: [test, security]
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    
    outputs:
      image-tag: ${{ steps.meta.outputs.tags }}
      image-digest: ${{ steps.build.outputs.digest }}
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Login to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=sha,prefix={{branch}}-
            type=raw,value=latest,enable={{is_default_branch}}
      
      - name: Build and push
        id: build
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha       # GitHub Actions cache
          cache-to: type=gha,mode=max
          build-args: |
            VERSION=${{ github.sha }}
            GIT_COMMIT=${{ github.sha }}
  
  # ── Job 4: Deploy to K8s ─────────────────────────────────────
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: production
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Deploy to Kubernetes
        uses: azure/k8s-deploy@v4
        with:
          manifests: |
            k8s/deployment.yaml
            k8s/service.yaml
          images: |
            ${{ needs.build.outputs.image-tag }}
```

---

## 6. Kubernetes Manifests

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pdms-service
  namespace: pdms
  labels:
    app: pdms-service
    version: "1.0"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: pdms-service
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1          # Max extra pods during update
      maxUnavailable: 0    # Zero downtime deployment
  template:
    metadata:
      labels:
        app: pdms-service
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      # Security Context
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
        fsGroup: 1001
      
      containers:
        - name: pdms-service
          image: ghcr.io/bach/pdms-service:latest
          imagePullPolicy: Always
          
          ports:
            - containerPort: 8080
              name: http
          
          # Environment from Secrets & ConfigMaps
          env:
            - name: PDMS_DATABASE_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: pdms-secrets
                  key: database-password
            - name: PDMS_JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: pdms-secrets
                  key: jwt-secret
          
          envFrom:
            - configMapRef:
                name: pdms-config
          
          # Resource limits — CRITICAL cho stability
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          
          # Health checks
          livenessProbe:               # Restart container nếu fail
            httpGet:
              path: /health/live
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 3
          
          readinessProbe:              # Remove from LB nếu fail
            httpGet:
              path: /health/ready
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 3
          
          startupProbe:                # Cho phép slow startup
            httpGet:
              path: /health/live
              port: 8080
            failureThreshold: 30
            periodSeconds: 10
          
          # Security
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          
          # Graceful shutdown
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 5"]
      
      # Graceful termination period
      terminationGracePeriodSeconds: 60
      
      # Spread pods across nodes
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: pdms-service

---
# k8s/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: pdms-service
  namespace: pdms
spec:
  selector:
    app: pdms-service
  ports:
    - name: http
      port: 80
      targetPort: 8080
  type: ClusterIP

---
# k8s/hpa.yaml — Horizontal Pod Autoscaler
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: pdms-service-hpa
  namespace: pdms
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: pdms-service
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

---

## 7. Health Check Endpoints

```go
// Health check handler — K8s expects specific paths
func (h *HealthHandler) RegisterRoutes(r *gin.Engine) {
    health := r.Group("/health")
    {
        health.GET("/live",  h.Liveness)   // K8s livenessProbe
        health.GET("/ready", h.Readiness)  // K8s readinessProbe
        health.GET("",       h.Full)       // Full health report
    }
}

// Liveness: "Is the process alive?"
// → Simple check, chỉ fail nếu process thực sự broken
func (h *HealthHandler) Liveness(c *gin.Context) {
    c.JSON(200, gin.H{"status": "alive"})
}

// Readiness: "Can the service handle requests?"
// → Check dependencies — fail nếu DB/Redis không kết nối được
func (h *HealthHandler) Readiness(c *gin.Context) {
    checks := map[string]string{}
    allOK := true

    // Check PostgreSQL
    if err := h.db.SqlDB().PingContext(c.Request.Context()); err != nil {
        checks["postgres"] = "unhealthy: " + err.Error()
        allOK = false
    } else {
        checks["postgres"] = "healthy"
    }

    // Check Redis
    if err := h.rdb.Ping(c.Request.Context()).Err(); err != nil {
        checks["redis"] = "unhealthy: " + err.Error()
        allOK = false
    } else {
        checks["redis"] = "healthy"
    }

    status := 200
    statusText := "ready"
    if !allOK {
        status = 503
        statusText = "not ready"
    }

    c.JSON(status, gin.H{
        "status": statusText,
        "checks": checks,
    })
}
```

---

## 8. Tips & Tricks

```
💡 TIP 1: Multi-stage build = small + secure image
   Builder stage: có Go toolchain, source code
   Runtime stage: chỉ có binary
   → Không leak source code hay Go tools vào production

💡 TIP 2: distroless vs alpine
   distroless: no shell → harder to debug, most secure
   alpine: có /bin/sh → easier debug, still tiny
   Production: distroless. Debug: alpine + ephemeral containers

💡 TIP 3: ReadinessProbe != LivenessProbe
   Liveness: chỉ fail khi process cần restart (deadlock, OOM)
   Readiness: fail khi dependency down → K8s stop routing traffic
   Cấu hình sai → restart loop hoặc traffic đến pod lỗi

💡 TIP 4: resource.requests = JVM -Xmx equivalent
   Go service dùng ít memory hơn Java nhiều
   Start với requests: 128Mi, limits: 512Mi
   Điều chỉnh sau khi có metrics thực tế

💡 TIP 5: preStop sleep 5s + terminationGracePeriodSeconds: 60
   preStop sleep 5s → K8s cần thời gian update Endpoints
   terminationGracePeriod 60s → service hoàn thành requests hiện tại
```

---

## 9. Tổng kết Bài 21

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ Multi-stage Dockerfile → image 12MB vs 310MB    │
│  ✅ CGO_ENABLED=0 → static binary, distroless ready │
│  ✅ docker-compose cho local dev với health checks  │
│  ✅ Air cho hot reload trong development             │
│  ✅ CI: lint → test -race → security scan → build  │
│  ✅ K8s: readiness ≠ liveness probe (rất quan trọng)│
│  ✅ HPA tự động scale theo CPU/memory              │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-22-Microservices-Patterns|Bài 22: Microservices Patterns trong Go]]

---
*Tags: #go #docker #kubernetes #cicd #deployment #zero-to-hero*
