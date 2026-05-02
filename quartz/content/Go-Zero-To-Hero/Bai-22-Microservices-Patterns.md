# Bài 22: Microservices Patterns trong Go

> **Mục tiêu:** Nắm vững các pattern thiết yếu cho microservices production — Saga, Outbox, Circuit Breaker, Service Discovery. Đây là bài tổng kết toàn bộ series.

---

## 1. Microservices Landscape

```
┌──────────────────────────────────────────────────────────────┐
│              PDMS MICROSERVICES ARCHITECTURE                 │
│                                                              │
│  Client ──► API Gateway (Kong/Nginx)                         │
│               │                                              │
│     ┌─────────┼──────────────────────────┐                  │
│     │         │                          │                  │
│     ▼         ▼                          ▼                  │
│  pdms-iam  pdms-service           pdms-process-mgmt         │
│  (Keycloak) (Documents)           (Camunda/Workflows)        │
│     │         │                          │                  │
│     │    ┌────┴──────┐                   │                  │
│     │    │           │                   │                  │
│     │    ▼           ▼                   ▼                  │
│     │  PostgreSQL  MongoDB         pdms-notification         │
│     │              (audit)         (email/push)              │
│     │                                                        │
│     └────────────────► Kafka ◄─────────────────────────────  │
│                    (event backbone)                          │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Saga Pattern — Distributed Transactions

```
┌──────────────────────────────────────────────────────────────┐
│              SAGA PATTERN — CHOREOGRAPHY                     │
│                                                              │
│  Use case: Create Document + Notify Owner + Log Audit        │
│                                                              │
│  WITHOUT Saga (2PC) — coupling, blocking:                    │
│  ❌ Distributed transaction across 3 services = nightmare   │
│                                                              │
│  WITH Saga (Choreography) — event-driven:                   │
│                                                              │
│  pdms-service       Kafka           notification-svc         │
│     │                 │                    │                 │
│     │─ CREATE doc ──► │                    │                 │
│     │ publish         │                    │                 │
│     │ DOC_CREATED     │                    │                 │
│     │ ────────────►   │ DOC_CREATED ─────► │                 │
│     │                 │                    │─ send email     │
│     │                 │                    │  publish        │
│     │                 │          ◄──────── │  EMAIL_SENT     │
│     │                 │                    │                 │
│     │  ◄── EMAIL_SENT ─                    │                 │
│     │  update doc.notified = true          │                 │
│                                                              │
│  Compensating Transaction (Rollback):                        │
│  nếu email fails → publish DOC_CREATION_FAILED              │
│  → pdms-service lắng nghe → mark doc as error state        │
└──────────────────────────────────────────────────────────────┘
```

```go
// Saga Step definition
type SagaStep struct {
    Name        string
    Execute     func(ctx context.Context, data any) error
    Compensate  func(ctx context.Context, data any) error
}

type Saga struct {
    steps     []SagaStep
    completed []int // Track completed steps for compensation
}

func (s *Saga) Execute(ctx context.Context, data any) error {
    for i, step := range s.steps {
        if err := step.Execute(ctx, data); err != nil {
            // Compensate in reverse order
            for j := len(s.completed) - 1; j >= 0; j-- {
                completedStep := s.steps[s.completed[j]]
                if compErr := completedStep.Compensate(ctx, data); compErr != nil {
                    log.Printf("compensation failed for step %s: %v", completedStep.Name, compErr)
                }
            }
            return fmt.Errorf("saga failed at step %s: %w", step.Name, err)
        }
        s.completed = append(s.completed, i)
    }
    return nil
}

// PDMS Example: Create Document Saga
func NewCreateDocumentSaga(docSvc *DocumentService, notifSvc *NotificationService, auditSvc *AuditService) *Saga {
    return &Saga{
        steps: []SagaStep{
            {
                Name: "CreateDocument",
                Execute: func(ctx context.Context, data any) error {
                    req := data.(*CreateDocRequest)
                    doc, err := docSvc.Create(ctx, req)
                    if err != nil { return err }
                    req.DocID = doc.ID // Pass to next steps
                    return nil
                },
                Compensate: func(ctx context.Context, data any) error {
                    req := data.(*CreateDocRequest)
                    return docSvc.Delete(ctx, req.DocID) // Rollback: delete doc
                },
            },
            {
                Name: "NotifyOwner",
                Execute: func(ctx context.Context, data any) error {
                    req := data.(*CreateDocRequest)
                    return notifSvc.SendCreationNotification(ctx, req.OwnerID, req.DocID)
                },
                Compensate: func(ctx context.Context, data any) error {
                    // Can't unsend email — send cancellation email instead
                    req := data.(*CreateDocRequest)
                    return notifSvc.SendCancellationNotification(ctx, req.OwnerID, req.DocID)
                },
            },
            {
                Name: "WriteAuditLog",
                Execute: func(ctx context.Context, data any) error {
                    req := data.(*CreateDocRequest)
                    return auditSvc.Log(ctx, "DOC_CREATED", req.DocID, req.OwnerID)
                },
                Compensate: func(ctx context.Context, data any) error {
                    req := data.(*CreateDocRequest)
                    return auditSvc.Log(ctx, "DOC_CREATION_ROLLED_BACK", req.DocID, req.OwnerID)
                },
            },
        },
    }
}
```

---

## 3. Transactional Outbox Pattern

```
┌──────────────────────────────────────────────────────────────┐
│           TRANSACTIONAL OUTBOX PATTERN                       │
│                                                              │
│  Problem: DB write + Kafka publish — not atomic!             │
│  DB succeeds but Kafka fails → data inconsistency           │
│                                                              │
│  Solution: Outbox table in SAME database                     │
│                                                              │
│  Step 1: Trong cùng 1 DB transaction:                        │
│  ┌────────────────────────────────────────────────┐         │
│  │  INSERT INTO documents (...)         ← business│         │
│  │  INSERT INTO outbox (event, payload) ← outbox  │         │
│  │  COMMIT ← atomic!                             │         │
│  └────────────────────────────────────────────────┘         │
│                                                              │
│  Step 2: Outbox worker (polling / Debezium CDC):             │
│  ┌────────────────────────────────────────────────┐         │
│  │  SELECT * FROM outbox WHERE status='pending'   │         │
│  │  → Publish to Kafka                           │         │
│  │  → UPDATE outbox SET status='sent'            │         │
│  └────────────────────────────────────────────────┘         │
│                                                              │
│  → Guaranteed: nếu DB commit → event SẼ được publish        │
│  → At-least-once (idempotency at consumer)                  │
└──────────────────────────────────────────────────────────────┘
```

```go
// Outbox table model
type OutboxEvent struct {
    ID          string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()"`
    EventType   string    `gorm:"not null"`
    AggregateID string    `gorm:"not null;index"`
    Payload     []byte    `gorm:"type:jsonb"`
    Status      string    `gorm:"not null;default:'pending';index"`
    CreatedAt   time.Time
    ProcessedAt *time.Time
    RetryCount  int
}

// Service: write business entity + outbox in SAME transaction
func (s *DocumentService) Create(ctx context.Context, doc *Document) error {
    return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
        // 1. Save business entity
        if err := tx.Create(doc).Error; err != nil {
            return err
        }
        
        // 2. Write to outbox (same transaction!)
        payload, _ := json.Marshal(map[string]any{
            "doc_id":   doc.ID,
            "owner_id": doc.OwnerID,
            "title":    doc.Title,
        })
        
        outboxEvent := &OutboxEvent{
            EventType:   "DOCUMENT_CREATED",
            AggregateID: doc.ID,
            Payload:     payload,
            Status:      "pending",
        }
        
        return tx.Create(outboxEvent).Error
    })
}

// Outbox relay worker — publish pending events to Kafka
type OutboxWorker struct {
    db       *gorm.DB
    producer KafkaProducer
    interval time.Duration
}

func (w *OutboxWorker) Run(ctx context.Context) {
    ticker := time.NewTicker(w.interval)
    defer ticker.Stop()
    
    for {
        select {
        case <-ticker.C:
            w.processBatch(ctx)
        case <-ctx.Done():
            return
        }
    }
}

func (w *OutboxWorker) processBatch(ctx context.Context) {
    var events []OutboxEvent
    
    // Lock rows to prevent duplicate processing (concurrent workers)
    w.db.WithContext(ctx).
        Where("status = ? AND retry_count < ?", "pending", 3).
        Order("created_at ASC").
        Limit(100).
        Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"}).
        Find(&events)
    
    for _, event := range events {
        if err := w.producer.Publish(ctx, event.EventType, event.Payload); err != nil {
            w.db.Model(&event).Updates(map[string]any{
                "retry_count": event.RetryCount + 1,
                "status":      gorm.Expr("CASE WHEN retry_count >= 2 THEN 'failed' ELSE 'pending' END"),
            })
            continue
        }
        
        now := time.Now()
        w.db.Model(&event).Updates(map[string]any{
            "status":       "sent",
            "processed_at": &now,
        })
    }
}
```

---

## 4. Circuit Breaker

```
┌──────────────────────────────────────────────────────────────┐
│                 CIRCUIT BREAKER STATES                       │
│                                                              │
│  CLOSED (normal):                                            │
│  Request → Service → Response                                │
│  Failure count tracked. If failures > threshold → OPEN       │
│                                                              │
│  OPEN (tripped):                                             │
│  Request → Circuit Breaker → FAIL IMMEDIATELY               │
│  No calls to unhealthy service                               │
│  After timeout → HALF-OPEN                                  │
│                                                              │
│  HALF-OPEN (testing):                                        │
│  1 probe request → Service                                   │
│  SUCCESS → CLOSED again                                      │
│  FAILURE → back to OPEN                                      │
│                                                              │
│  Benefits:                                                   │
│  → Fail fast (không waste time waiting for timeout)         │
│  → Allow service to recover                                  │
│  → Prevent cascade failure                                   │
└──────────────────────────────────────────────────────────────┘
```

```go
// go get github.com/sony/gobreaker
import "github.com/sony/gobreaker"

// Create circuit breaker per external service
func NewCircuitBreaker(name string) *gobreaker.CircuitBreaker {
    settings := gobreaker.Settings{
        Name:        name,
        MaxRequests: 3,                // HALF-OPEN: allow 3 probes
        Interval:    10 * time.Second, // CLOSED: reset failure count every 10s
        Timeout:     30 * time.Second, // OPEN: stay open for 30s before HALF-OPEN
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            // Trip if: ≥5 failures AND >60% failure rate
            return counts.ConsecutiveFailures >= 5 ||
                (counts.Requests >= 10 && float64(counts.TotalFailures)/float64(counts.Requests) >= 0.6)
        },
        OnStateChange: func(name string, from, to gobreaker.State) {
            log.Printf("Circuit breaker %s: %s → %s", name, from, to)
            // Alert/metric here
        },
    }
    return gobreaker.NewCircuitBreaker(settings)
}

// Wrap service calls với circuit breaker
type IAMServiceClient struct {
    cb      *gobreaker.CircuitBreaker
    baseURL string
    http    *http.Client
}

func (c *IAMServiceClient) ValidateToken(ctx context.Context, token string) (*Claims, error) {
    result, err := c.cb.Execute(func() (interface{}, error) {
        // This is only called when circuit is CLOSED or HALF-OPEN
        req, _ := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/validate", strings.NewReader(token))
        resp, err := c.http.Do(req)
        if err != nil {
            return nil, err
        }
        defer resp.Body.Close()
        
        if resp.StatusCode >= 500 {
            return nil, fmt.Errorf("IAM service error: %d", resp.StatusCode)
        }
        
        var claims Claims
        json.NewDecoder(resp.Body).Decode(&claims)
        return &claims, nil
    })
    
    if err != nil {
        if errors.Is(err, gobreaker.ErrOpenState) {
            // Circuit is OPEN — use cached/degraded response
            return c.getCachedClaims(token)
        }
        return nil, err
    }
    
    return result.(*Claims), nil
}

// Fallback khi circuit open
func (c *IAMServiceClient) getCachedClaims(token string) (*Claims, error) {
    // Try JWT local validation (doesn't need IAM service)
    return parseJWTLocally(token, c.jwtPublicKey)
}
```

---

## 5. Service Discovery

```go
// Option 1: DNS-based (Kubernetes native — recommended)
// Service name = DNS hostname trong K8s
// pdms-iam-service → resolves to ClusterIP automatically

// Không cần code đặc biệt — chỉ dùng service name:
conn, _ := grpc.NewClient("pdms-iam-service:50051", ...)

// Option 2: Consul (cho non-K8s environments)
// go get github.com/hashicorp/consul/api

func RegisterWithConsul(svcName, addr string, port int) error {
    client, _ := consul.NewClient(consul.DefaultConfig())
    
    return client.Agent().ServiceRegister(&consul.AgentServiceRegistration{
        ID:   fmt.Sprintf("%s-%s-%d", svcName, addr, port),
        Name: svcName,
        Address: addr,
        Port: port,
        Tags: []string{"pdms", "go", "v1"},
        Check: &consul.AgentServiceCheck{
            HTTP:     fmt.Sprintf("http://%s:%d/health/live", addr, port),
            Interval: "10s",
            Timeout:  "5s",
        },
    })
}
```

---

## 6. API Gateway Pattern với Go

```go
// Simple API Gateway với go-chi + reverse proxy
func NewGateway(services map[string]string) http.Handler {
    r := chi.NewRouter()
    r.Use(middleware.Logger, middleware.Recoverer)
    r.Use(RateLimitMiddleware)
    r.Use(JWTValidationMiddleware)
    
    // Route to services
    for prefix, target := range services {
        targetURL, _ := url.Parse(target)
        proxy := httputil.NewSingleHostReverseProxy(targetURL)
        
        r.Handle(prefix+"/*", http.StripPrefix(prefix, proxy))
    }
    
    return r
}

// Usage
gateway := NewGateway(map[string]string{
    "/api/v1/documents": "http://pdms-service:8080",
    "/api/v1/iam":       "http://pdms-iam-service:8080",
    "/api/v1/process":   "http://pdms-process-service:8080",
})
```

---

## 7. Pattern Summary Matrix

```
┌──────────────────────────────────────────────────────────────┐
│              WHEN TO USE WHICH PATTERN                       │
├──────────────────────┬───────────────────────────────────────┤
│  Pattern             │  Use when                            │
├──────────────────────┼───────────────────────────────────────┤
│  Saga (Choreography) │  Long-running business transactions  │
│                      │  across ≥2 services, event-driven   │
├──────────────────────┼───────────────────────────────────────┤
│  Saga (Orchestration)│  Complex workflows với branching,    │
│                      │  rollback logic phức tạp            │
├──────────────────────┼───────────────────────────────────────┤
│  Transactional Outbox│  DB write + Kafka publish atomically  │
│                      │  (LUÔN cần khi publish events!)     │
├──────────────────────┼───────────────────────────────────────┤
│  Circuit Breaker     │  Gọi external/downstream services    │
│                      │  Tránh cascade failure              │
├──────────────────────┼───────────────────────────────────────┤
│  Bulkhead            │  Isolate resource pools per caller   │
│                      │  (separate thread/goroutine pools)  │
├──────────────────────┼───────────────────────────────────────┤
│  Retry + Backoff     │  Transient failures (network blip)   │
│                      │  Kết hợp với circuit breaker         │
└──────────────────────┴───────────────────────────────────────┘
```

---

## 8. Tips & Tricks

```
💡 TIP 1: Idempotency key cho mọi state-changing operation
   POST /documents với X-Idempotency-Key: uuid
   → Store key + result → return same result nếu duplicate call
   → Safe với at-least-once delivery từ Kafka

💡 TIP 2: Outbox thay vì direct Kafka publish
   LUÔN dùng Outbox Pattern khi:
   - Publish event từ trong DB transaction
   - Cần guaranteed delivery
   Debezium CDC: đọc PostgreSQL WAL → không cần polling worker

💡 TIP 3: Circuit Breaker timeout < HTTP client timeout
   circuit breaker timeout: 30s (OPEN → HALF-OPEN)
   http.Client timeout: 5s (per request)
   → CB collect enough failures before tripping

💡 TIP 4: Saga compensating transaction phải idempotent
   Compensation có thể được gọi nhiều lần
   → Check state trước khi rollback

💡 TIP 5: Distributed tracing kết nối mọi patterns
   Mọi Saga step, Outbox relay, CB calls đều cần trace context
   → OpenTelemetry propagation qua Kafka headers, HTTP headers
```

---

## 9. Tổng kết Series — Go Zero to Hero

```
┌──────────────────────────────────────────────────────────────┐
│               GO ZERO-TO-HERO — FULL JOURNEY                 │
│                                                              │
│  Phase 1 — Foundation (Bài 1-5):                            │
│  ✅ GMP scheduler, goroutines, channels                      │
│  ✅ Error handling, defer, panic/recover                     │
│  ✅ Interfaces, generics, modules                            │
│                                                              │
│  Phase 2 — Intermediate (Bài 6-10):                         │
│  ✅ Context cancellation & propagation                       │
│  ✅ Table-driven tests, race detection                       │
│  ✅ net/http internals, GORM/PostgreSQL                      │
│                                                              │
│  Phase 3 — Frameworks (Bài 11-16):                          │
│  ✅ Gin (★75K), Fiber (fastest), Echo (balanced), Chi (clean)│
│  ✅ JWT, CORS, rate limiting, WebSocket                      │
│  ✅ Framework selection decision matrix                      │
│                                                              │
│  Phase 4 — Production (Bài 17-22):                          │
│  ✅ Kafka/Sarama consumer groups, DLQ                        │
│  ✅ gRPC với 4 streaming modes + interceptors               │
│  ✅ Viper config, Zap logging, OpenTelemetry tracing        │
│  ✅ Redis caching, distributed locks                         │
│  ✅ Docker multi-stage, K8s deployment                       │
│  ✅ Saga, Outbox, Circuit Breaker patterns                   │
│                                                              │
│  Next Steps:                                                 │
│  → Rust Zero-to-Hero series (đã có trong vault)             │
│  → Deep dive: Go profiling & performance tuning             │
│  → PDMS implementation với patterns learned here            │
└──────────────────────────────────────────────────────────────┘
```

---
*Tags: #go #microservices #saga #outbox #circuit-breaker #service-discovery #zero-to-hero*
