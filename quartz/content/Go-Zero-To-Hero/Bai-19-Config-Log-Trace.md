# Bài 19: Config, Logging & Distributed Tracing

> **Mục tiêu:** Production-ready observability stack — Viper cho config, Zap cho structured logging, OpenTelemetry cho distributed tracing.

---

## 1. The Observability Stack

```
┌──────────────────────────────────────────────────────────────┐
│                OBSERVABILITY PILLARS                         │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │    METRICS   │  │    LOGS      │  │      TRACES        │ │
│  │              │  │              │  │                    │ │
│  │  Prometheus  │  │  Zap         │  │  OpenTelemetry     │ │
│  │  + Grafana   │  │  + ELK/Loki  │  │  + Jaeger/Tempo    │ │
│  │              │  │              │  │                    │ │
│  │  "HOW FAST?" │  │  "WHAT HAPPENED?"│ "WHERE IS SLOW?" │ │
│  └──────────────┘  └──────────────┘  └────────────────────┘ │
│                                                              │
│  Library stack:                                              │
│  go.uber.org/zap          → Structured logging               │
│  github.com/spf13/viper   → Config management               │
│  go.opentelemetry.io/otel → Distributed tracing             │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Viper — Config Management

```go
// go get github.com/spf13/viper

type Config struct {
    Server   ServerConfig
    Database DatabaseConfig
    Kafka    KafkaConfig
    JWT      JWTConfig
    Redis    RedisConfig
}

type ServerConfig  struct { Port int; ReadTimeout time.Duration; WriteTimeout time.Duration }
type DatabaseConfig struct { Host, Port, User, Password, DBName, SSLMode string; MaxConns int }
type KafkaConfig   struct { Brokers []string; GroupID string; Topics map[string]string }

func LoadConfig() (*Config, error) {
    v := viper.New()
    
    // Config file locations (priority: last wins)
    v.SetConfigName("config")
    v.SetConfigType("yaml")
    v.AddConfigPath(".")
    v.AddConfigPath("./config")
    v.AddConfigPath("/etc/pdms/")
    
    // Environment variables override file (12-factor app)
    v.AutomaticEnv()
    v.SetEnvKeyReplacer(strings.NewReplacer(".", "_")) // server.port → SERVER_PORT
    v.SetEnvPrefix("PDMS") // PDMS_SERVER_PORT
    
    // Defaults
    v.SetDefault("server.port", 8080)
    v.SetDefault("server.read_timeout", "15s")
    v.SetDefault("database.ssl_mode", "disable")
    v.SetDefault("database.max_conns", 25)
    
    if err := v.ReadInConfig(); err != nil {
        if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
            return nil, fmt.Errorf("read config: %w", err)
        }
        // Config file optional — use env vars + defaults
    }
    
    var cfg Config
    if err := v.Unmarshal(&cfg); err != nil {
        return nil, fmt.Errorf("unmarshal config: %w", err)
    }
    
    return &cfg, nil
}
```

```yaml
# config/config.yaml
server:
  port: 8080
  read_timeout: 15s
  write_timeout: 15s

database:
  host: localhost
  port: 5432
  user: pdms
  password: ${PDMS_DATABASE_PASSWORD}  # From env
  dbname: pdms
  max_conns: 25

kafka:
  brokers:
    - localhost:9092
  group_id: pdms-service
  topics:
    documents: pdms.document-events
    audit: pdms.audit-events

jwt:
  secret: ${PDMS_JWT_SECRET}
  access_ttl: 15m
  refresh_ttl: 168h
```

---

## 3. Zap — Structured Logging

```
┌──────────────────────────────────────────────────────────────┐
│           ZAP vs logrus vs log/slog                          │
├────────────────┬───────────────┬─────────────────────────────┤
│  Library       │  Perf         │  Best for                   │
├────────────────┼───────────────┼─────────────────────────────┤
│  log/slog      │ Good          │ stdlib, simple apps         │
│  logrus        │ Moderate      │ Legacy, familiar API        │
│  zerolog       │ Fastest       │ Extreme perf, JSON only     │
│  Zap           │ Very fast     │ Production, structured      │
└────────────────┴───────────────┴─────────────────────────────┘
```

```go
// go get go.uber.org/zap

func NewLogger(level string, isDev bool) (*zap.Logger, error) {
    var cfg zap.Config
    
    if isDev {
        cfg = zap.NewDevelopmentConfig() // Human-readable, colored
    } else {
        cfg = zap.NewProductionConfig()  // JSON for ELK/Loki
    }
    
    // Set log level
    logLevel, err := zap.ParseAtomicLevel(level)
    if err != nil {
        return nil, err
    }
    cfg.Level = logLevel
    
    // Add caller + stacktrace on error
    cfg.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
    
    return cfg.Build(
        zap.AddCaller(),
        zap.AddCallerSkip(0),
        zap.Fields(
            zap.String("service", "pdms-service"),
            zap.String("version", Version),
        ),
    )
}

// Usage patterns
func (s *DocumentService) GetDocument(ctx context.Context, id string) (*Document, error) {
    logger := s.logger.With(
        zap.String("doc_id", id),
        zap.String("request_id", GetRequestID(ctx)),
        zap.String("user_id", GetUserID(ctx)),
    )
    
    logger.Info("getting document")
    
    doc, err := s.repo.FindByID(ctx, id)
    if err != nil {
        logger.Error("failed to get document",
            zap.Error(err),
            zap.Duration("elapsed", time.Since(start)),
        )
        return nil, err
    }
    
    logger.Info("document retrieved successfully",
        zap.String("title", doc.Title),
        zap.Duration("elapsed", time.Since(start)),
    )
    
    return doc, nil
}
```

```json
// Production JSON log output (ELK-friendly):
{
  "level": "info",
  "ts": "2026-05-01T10:30:45.123Z",
  "caller": "usecase/document.go:45",
  "msg": "document retrieved successfully",
  "service": "pdms-service",
  "version": "1.2.3",
  "doc_id": "doc-123",
  "request_id": "req-abc",
  "user_id": "user-1",
  "title": "Q1 Report",
  "elapsed": "2.3ms"
}
```

---

## 4. OpenTelemetry — Distributed Tracing

```
┌──────────────────────────────────────────────────────────────┐
│              DISTRIBUTED TRACE EXAMPLE                       │
│                                                              │
│  POST /api/v1/documents                                      │
│  TraceID: abc123                                             │
│  │                                                           │
│  ├── [0ms] Gin Handler (SpanID: A)                           │
│  │   ├── [1ms] JWT Validation (SpanID: B)                   │
│  │   ├── [3ms] DocumentService.Create (SpanID: C)            │
│  │   │   ├── [2ms] DocumentRepo.Save (SpanID: D)            │
│  │   │   │   └── [1ms] PostgreSQL INSERT (SpanID: E)        │
│  │   │   └── [5ms] Kafka.Publish (SpanID: F)               │
│  │   └── [1ms] Response encoding                            │
│  └── Total: 12ms                                             │
│                                                              │
│  → Jaeger UI shows entire trace as waterfall chart           │
└──────────────────────────────────────────────────────────────┘
```

```go
// go get go.opentelemetry.io/otel
// go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp
// go get go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin

func InitTracer(serviceName, collectorURL string) (func(context.Context) error, error) {
    exporter, err := otlptracehttp.New(context.Background(),
        otlptracehttp.WithEndpoint(collectorURL), // e.g. "jaeger:4318"
        otlptracehttp.WithInsecure(),
    )
    if err != nil {
        return nil, err
    }
    
    tp := tracesdk.NewTracerProvider(
        tracesdk.WithBatcher(exporter),
        tracesdk.WithResource(resource.NewWithAttributes(
            semconv.SchemaURL,
            semconv.ServiceName(serviceName),
            semconv.ServiceVersion(Version),
            attribute.String("environment", Env),
        )),
        tracesdk.WithSampler(tracesdk.AlwaysSample()), // 100% in dev
        // tracesdk.WithSampler(tracesdk.TraceIDRatioBased(0.1)), // 10% in prod
    )
    
    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))
    
    return tp.Shutdown, nil
}

// Auto-instrumentation với Gin
r.Use(otelgin.Middleware("pdms-service"))

// Manual span trong service
func (s *DocumentService) Create(ctx context.Context, doc *Document) error {
    tracer := otel.Tracer("pdms-service")
    ctx, span := tracer.Start(ctx, "DocumentService.Create")
    defer span.End()
    
    // Add attributes to span
    span.SetAttributes(
        attribute.String("doc.owner_id", doc.OwnerID),
        attribute.Int("doc.content_length", len(doc.Content)),
    )
    
    if err := s.repo.Save(ctx, doc); err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return err
    }
    
    span.SetStatus(codes.Ok, "")
    return nil
}

// Auto-instrument GORM
// go get github.com/uptrace/opentelemetry-go-extra/otelgorm
db.Use(otelgorm.NewPlugin())
```

---

## 5. Prometheus Metrics

```go
// go get github.com/prometheus/client_golang

import "github.com/prometheus/client_golang/prometheus"

var (
    httpRequestDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "http_request_duration_seconds",
        Help:    "HTTP request latency distribution",
        Buckets: prometheus.DefBuckets,
    }, []string{"method", "path", "status"})
    
    documentsCreated = prometheus.NewCounterVec(prometheus.CounterOpts{
        Name: "pdms_documents_created_total",
        Help: "Total documents created",
    }, []string{"owner_id", "status"})
    
    activeConnections = prometheus.NewGauge(prometheus.GaugeOpts{
        Name: "pdms_active_connections",
        Help: "Active connections to PDMS service",
    })
)

func init() {
    prometheus.MustRegister(httpRequestDuration, documentsCreated, activeConnections)
}

// Gin middleware to collect metrics
func PrometheusMiddleware() gin.HandlerFunc {
    return func(c *gin.Context) {
        start := time.Now()
        c.Next()
        
        httpRequestDuration.WithLabelValues(
            c.Request.Method,
            c.FullPath(),
            strconv.Itoa(c.Writer.Status()),
        ).Observe(time.Since(start).Seconds())
    }
}

// Expose metrics endpoint
r.GET("/metrics", gin.WrapH(promhttp.Handler()))
```

---

## 6. Tips & Tricks

```
💡 TIP 1: Zap sugar cho fmt-style logging (dev only)
   sugar := logger.Sugar()
   sugar.Infof("User %s created doc %s", userID, docID)
   → sugar.Info() chậm hơn logger.Info() một chút

💡 TIP 2: Log sampling trong production
   zap.NewProductionConfig() mặc định sample 100/s cho same msg
   → Tránh log flood khi có bug gây nhiều errors

💡 TIP 3: Correlation ID trong mọi logs
   logger.With(zap.String("trace_id", span.SpanContext().TraceID().String()))

💡 TIP 4: Never log sensitive data
   ❌ logger.Info("user login", zap.String("password", pwd))
   ✅ logger.Info("user login", zap.String("email", email))

💡 TIP 5: Trace sampling trong production
   AlwaysSample() cho dev, 10% cho production
   Luôn sample nếu error (ParentBased + TraceIDRatio)
```

---

## 7. Tổng kết Bài 19

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ Viper: file + env vars, 12-factor app ready     │
│  ✅ Zap: structured JSON logs, ELK/Loki compatible  │
│  ✅ OTEL: auto-instrument Gin + GORM + HTTP client  │
│  ✅ Correlation: request_id + trace_id trong mọi log│
│  ✅ Prometheus: histogram cho latency, counter cho  │
│     business events                                 │
│  ✅ Log sensitive fields là security issue          │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-20-Redis-Caching|Bài 20: Redis Caching & Distributed Locks]]

---
*Tags: #go #viper #zap #opentelemetry #prometheus #observability #zero-to-hero*
