---
tags: [concepts, observability, opentelemetry, tracing, metrics, logs, evergreen]
created: 2026-05-02
difficulty: intermediate
estimated-read: 20 min
links: [Microservices-Patterns/04-Observability]
---

# 🔭 OpenTelemetry Deep Dive — The Three Pillars of Observability

> **Mục tiêu:** Hiểu Traces, Metrics, Logs không phải là 3 hệ thống riêng biệt mà là 3 signals tương quan với nhau — và OpenTelemetry là chuẩn thống nhất tất cả.

---

## 🎯 Monitoring vs Observability

```
Monitoring (biết trước muốn đo gì):
→ Dashboard CPU, RAM, request count, error rate
→ "Tôi biết system có thể fail theo cách này" → đặt alert
→ Known unknowns

Observability (hiểu system từ output):
→ "System có vấn đề lạ → đặt câu hỏi → system trả lời"
→ "Tại sao request của user này slow nhưng user khác thì không?"
→ Unknown unknowns

High observability = system có thể answer ANY question
  không chỉ questions bạn biết trước khi deploy
```

---

## 🏗️ Three Pillars — Và mối quan hệ

```
┌─────────────────────────────────────────────────────────────────┐
│                     ONE REQUEST JOURNEY                         │
│                                                                 │
│  TRACES (WHY is it slow? WHERE is the problem?)                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Span: HTTP GET /documents/123           [0ms - 245ms]   │   │
│  │  └── Span: Auth validate               [0ms - 12ms]     │   │
│  │  └── Span: DB query documents          [12ms - 230ms]   │   │
│  │       └── Span: Connection wait        [12ms - 62ms]    │   │
│  │       └── Span: Query execute          [62ms - 228ms]   │   │
│  │  └── Span: Cache set                   [230ms - 245ms]  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  METRICS (IS there a problem? WHAT is affected?)               │
│  http_request_duration_p99 = 245ms (above 200ms SLO!)         │
│  db_connection_pool_wait = 50ms (connection pool exhausted?)   │
│                                                                 │
│  LOGS (WHAT exactly happened?)                                  │
│  [2026-05-02 10:23:45] WARN  DB connection waited 50ms        │
│  [2026-05-02 10:23:45] INFO  Query: SELECT * FROM documents    │
│  traceId=abc123 spanId=def456 userId=user-789                   │
│                                                                 │
│  KEY: traceId correlates ALL THREE signals!                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📐 OpenTelemetry Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   YOUR APPLICATION                              │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              OTel SDK (in your process)                  │  │
│  │                                                          │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐ │  │
│  │  │ TracerProvider│ │MeterProvider │ │ LoggerProvider   │ │  │
│  │  │              │ │              │ │                  │ │  │
│  │  │ Auto-instrument:              │ │                  │ │  │
│  │  │ Spring MVC    │ │              │ │                  │ │  │
│  │  │ JDBC          │ │              │ │                  │ │  │
│  │  │ Kafka client  │ │              │ │                  │ │  │
│  │  └──────┬────────┘ └──────┬───────┘ └────────┬─────────┘ │  │
│  └─────────┼─────────────────┼──────────────────┼───────────┘  │
│            │       OTLP Protocol (gRPC/HTTP)     │             │
└────────────┼─────────────────┼──────────────────┼─────────────┘
             │                 │                  │
             ▼                 ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│              OTEL COLLECTOR (sidecar or standalone)             │
│                                                                 │
│   Receivers → Processors → Exporters                           │
│   (OTLP)      (batch,       (Jaeger, Prometheus, Loki,         │
│               filter,       Elasticsearch, Tempo, Grafana)     │
│               sample)                                          │
└─────────────────────────────────────────────────────────────────┘
```

### OTel Collector — Tại sao cần?

```
Without Collector:
App ──► Jaeger (traces)
App ──► Prometheus (metrics)    → 3 separate connections, 3 configs
App ──► Loki (logs)

With Collector:
App ──► OTLP ──► Collector ──► Jaeger
                           ──► Prometheus
                           ──► Loki (Grafana)
                           ──► S3 (archive)
                 + sampling, filtering, batching
                 + No code change if backend changes
```

---

## 🔍 Traces & Spans

```
Trace = collection of Spans representing a request's journey
Span  = single unit of work (has start time, duration, attributes)

Span Hierarchy:
TraceId: abc-123 (same for ALL spans in one request)

ROOT SPAN (entry point):
  spanId: A1, parentId: null
  name: "HTTP GET /api/documents/123"
  duration: 245ms
  attributes:
    http.method: GET
    http.url: /api/documents/123
    http.status_code: 200

  CHILD SPAN:
    spanId: B1, parentId: A1
    name: "DocumentService.getDocument"
    duration: 240ms

    CHILD SPAN:
      spanId: C1, parentId: B1
      name: "SELECT documents WHERE id=?"
      duration: 168ms
      attributes:
        db.system: postgresql
        db.statement: "SELECT * FROM documents WHERE id=$1"
        db.rows_affected: 1

    CHILD SPAN:
      spanId: C2, parentId: B1
      name: "Redis SETEX"
      duration: 3ms
```

### Context Propagation — Across Services

```
Service A ──────────────────────────────────► Service B
            HTTP Header: traceparent
            00-abc123...-span1-01

traceparent format: version-traceId-spanId-flags

Service B receives request:
→ Extracts traceparent header
→ Creates child span with parent = span1
→ Continues trace across service boundary!

Result: Full distributed trace across ALL services
→ Jaeger shows: A → B → C → D (entire call chain)
→ See EXACTLY where time was spent across service hops
```

---

## 📊 Metrics — The Three Types

```
COUNTER: monotonically increasing value
  http_requests_total{method="GET", status="200"} = 1523
  errors_total{service="document"} = 42
  Use: rate of change → requests_per_second = rate(http_requests_total[5m])

GAUGE: current point-in-time value (can go up/down)
  db_connections_active = 45
  jvm_memory_heap_used_bytes = 512000000
  Use: current state → dashboard of "right now"

HISTOGRAM: distribution of values (for latency, sizes)
  http_request_duration_seconds_bucket{le="0.1"} = 850   # < 100ms
  http_request_duration_seconds_bucket{le="0.5"} = 950   # < 500ms
  http_request_duration_seconds_bucket{le="1.0"} = 980   # < 1s
  http_request_duration_seconds_count = 1000
  http_request_duration_seconds_sum = 87.5
  
  Derived:
  p50 = percentile from bucket interpolation
  p99 = 99th percentile (most important for SLO)
  avg = sum / count (less useful than percentiles!)
```

### Four Golden Signals (Google SRE)

```
1. LATENCY  — How long does it take?
   p50, p95, p99 of request duration
   Error latency vs success latency (separately!)

2. TRAFFIC  — How much demand?
   Requests per second, queries per second
   Events consumed per second (Kafka)

3. ERRORS   — How often does it fail?
   HTTP 5xx rate, business exceptions, timeout rate
   Error budget: 1 - (successful / total)

4. SATURATION — How full is the system?
   CPU utilization, memory usage, disk I/O
   DB connection pool utilization
   Thread pool queue depth
   
These 4 signals tell you: is there a problem right now?
Traces tell you: what exactly is causing it?
```

---

## 📝 Logs — Structured Logging

```java
// ❌ Unstructured log (hard to query)
log.info("User 12345 approved document 678 at branch HN001");

// ✅ Structured log (machine-readable, queryable)
log.info("Document approved",
    "userId", "user-12345",
    "documentId", 678L,
    "branchId", "HN001",
    "action", "APPROVE",
    "traceId", Span.current().getSpanContext().getTraceId()
);

// Output (JSON):
{
  "timestamp": "2026-05-02T10:23:45.123Z",
  "level": "INFO",
  "message": "Document approved",
  "userId": "user-12345",
  "documentId": 678,
  "branchId": "HN001",
  "action": "APPROVE",
  "traceId": "abc123...",  ← correlates with trace!
  "spanId": "def456..."
}

// Query in Loki/Elasticsearch:
{branchId="HN001", action="APPROVE"} | count_over_time([1h])
```

### Log Levels Strategy

```
TRACE: very verbose, disabled in production (hot loop internals)
DEBUG: request parameters, DB queries, disabled in production
INFO:  business events (document approved, user logged in) ✅ prod
WARN:  unexpected but recoverable (retry, fallback used) ✅ prod
ERROR: requires attention (uncaught exception, data corruption) ✅ prod
FATAL: system must shut down ✅ prod

Rule: INFO = "things that should happen regularly"
      WARN = "things that should NOT happen, but we handled it"
      ERROR = "things that need human attention"
```

---

## 🔧 Spring Boot 3.x + OTel Setup

```xml
<!-- pom.xml -->
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-tracing-bridge-otel</artifactId>
</dependency>
<dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-exporter-otlp</artifactId>
</dependency>
```

```yaml
# application.yml
management:
  tracing:
    sampling:
      probability: 1.0           # 100% in dev, 0.1 in prod
  otlp:
    tracing:
      endpoint: http://otel-collector:4317
  metrics:
    export:
      otlp:
        endpoint: http://otel-collector:4317

# Structured logging with traceId/spanId auto-injected
logging:
  pattern:
    console: "%d{ISO8601} %highlight(%-5level) [%blue(%t)] %yellow(%C{1}): %msg traceId=%X{traceId} spanId=%X{spanId}%n"
```

```java
// Custom spans for business operations
@Autowired Tracer tracer;

public Document approveDocument(Long id, String approver) {
    Span span = tracer.nextSpan()
        .name("document-approval")
        .tag("document.id", id.toString())
        .tag("approver", approver)
        .start();

    try (Tracer.SpanInScope ws = tracer.withSpan(span)) {
        // Business logic here
        Document doc = repository.findById(id).orElseThrow();
        doc.approve(approver);
        repository.save(doc);
        span.tag("document.status", "APPROVED");
        return doc;
    } catch (Exception e) {
        span.error(e);
        throw e;
    } finally {
        span.end();
    }
}
```

---

## 💡 Tips & Tricks

> **Tip 1 — Sampling Strategy**
> ```yaml
> # Production: don't trace everything (expensive, storage)
> # Head-based sampling (decide at start):
> probability: 0.1  # 10% of requests
>
> # Tail-based sampling (decide at end):
> # → Always sample errors
> # → Always sample slow requests (> 500ms)
> # → Sample 1% of normal requests
> # Requires OTel Collector tail sampling processor
>
> collectors:
>   tail_sampling:
>     policies:
>       - name: error-policy
>         type: status_code
>         status_code: {status_codes: [ERROR]}
>       - name: latency-policy
>         type: latency
>         latency: {threshold_ms: 500}
>       - name: probabilistic-policy
>         type: probabilistic
>         probabilistic: {sampling_percentage: 1}
> ```

> **Tip 2 — Cardinality in Metrics**
> ```java
> // ❌ High cardinality label — DO NOT use unique IDs as labels!
> Counter.builder("http.requests")
>     .tag("userId", userId)    // millions of unique values → OOM!
>     .register(registry);
>
> // ✅ Low cardinality labels
> Counter.builder("http.requests")
>     .tag("method", request.getMethod())    // GET/POST/PUT (few values)
>     .tag("status", String.valueOf(status)) // 200/400/500 (few values)
>     .tag("endpoint", "/api/documents")     // route pattern, not exact URL
>     .register(registry);
> ```

> **Tip 3 — Alert on Symptoms, Not Causes**
> ```
> ❌ Alert: CPU > 80%  (cause — may or may not impact users)
> ✅ Alert: p99 latency > 500ms  (symptom — users definitely impacted)
>
> ❌ Alert: DB connections > 90  (cause)
> ✅ Alert: error rate > 1%  (symptom)
>
> Then: trace from symptom → find cause
> ```

---

## 🔬 Case Studies

### Case Study 1: Finding the Slow Query with Traces
```
Alert fires: p99 latency = 800ms (SLO = 200ms)
Metric: http_request_duration_p99{endpoint="/api/documents"} = 0.8

Action: Go to Jaeger, filter traces > 500ms
Found trace: abc-123
  HTTP GET /api/documents [800ms]
    DocumentService.getByBranch [795ms]
      SELECT documents WHERE branch_id=? [790ms]  ← THIS IS SLOW!
        Connection wait: 350ms  ← CONNECTION POOL EXHAUSTED!

Root cause: 50 connections configured, 60 concurrent requests
            40 requests wait for connection → 350ms wait

Fix: Increase connection pool from 50 to 80
     Add metrics: db_pool_wait_time histogram
Result: p99 back to 50ms
```

### Case Study 2: PDMS Observability Stack
```
Recommended stack for PDMS:
Traces:  → OTel Collector → Tempo (Grafana)
Metrics: → OTel Collector → Prometheus → Grafana
Logs:    → OTel Collector → Loki → Grafana

Grafana: single pane of glass
→ Click on metric spike → jump to traces in that time window
→ Click on trace → see correlated logs with same traceId

Key dashboards:
1. SLO Dashboard: p99 latency, error rate, throughput
2. Dependency Dashboard: Kafka lag, DB connections, Redis hits
3. Business Dashboard: documents approved/day, processing time by branch
```

---

## 📝 Key Takeaways

1. **Observability > Monitoring** — answer unknown questions vs known
2. **Three pillars**: Traces (why/where), Metrics (what/when), Logs (details)
3. **traceId** correlates all three signals — critical for debugging
4. **OTel Collector** = decouples app from backends, enables batching/sampling
5. **Four Golden Signals**: Latency, Traffic, Errors, Saturation
6. **Histogram > Average** for latency — always use p50/p95/p99
7. **Structured logging** = JSON with traceId → queryable in Loki/Elasticsearch
8. **Tail-based sampling** = always capture errors/slow requests, sample normal traffic
9. **Low cardinality labels** — never use unique IDs as metric labels → OOM
10. **Alert on symptoms** (p99 latency) not causes (CPU usage)

---

## 🔗 Liên kết

- [[Microservices-Patterns/04-Observability]] — Observability patterns overview
- [[Microservices-Patterns/Distributed-Tracing]] — Distributed tracing concepts
- [[Microservices-Patterns/Metrics-and-Alerting]] — Prometheus + Grafana setup
- [[concepts/four-golden-signals]] — Four Golden Signals detail
- [[Rust-Zero-To-Hero/Bai-34-OpenTelemetry]] — OTel in Rust
