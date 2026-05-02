---
tags: [observability, metrics, sre, monitoring, fundamentals]
created: 2026-04-14
status: evergreen
links: [MOC-Observability, MOC-Scalability]
---

# 📊 Four Golden Signals — Ngôn ngữ Chung của System Health

> **Nguồn gốc:** Google SRE Book (Chapter 6). Đây là bộ **4 metric tối thiểu** để biết một service có đang "healthy" không — không cần dashboard phức tạp, chỉ cần 4 con số này là đủ để diagnose 80% vấn đề production.

---

## 🎯 Tại sao lại là 4 cái này?

Trước khi có Four Golden Signals, teams thường monitor **everything** — CPU, RAM, disk I/O, thread count, JVM heap, GC pause... Kết quả là alert fatigue và không biết cái gì thực sự quan trọng.

Google SRE đúc kết: **user experience được xác định bởi 4 điều** — request có được xử lý không (Traffic), xử lý nhanh không (Latency), bị lỗi không (Errors), và hệ thống còn "room" không (Saturation). Mọi thứ khác là **input** (CPU, RAM) để giải thích tại sao 4 cái trên bị ảnh hưởng.

```
┌─────────────────────────────────────────────────────┐
│              USER EXPERIENCE                         │
│                                                      │
│  "Request của tôi có được xử lý đúng, nhanh không?" │
└──────────────────────┬──────────────────────────────┘
                       │ đo bằng
          ┌────────────┼────────────┐
          ▼            ▼            ▼            ▼
       Traffic     Latency       Errors     Saturation
    (bao nhiêu)  (nhanh không)  (lỗi không)  (sắp vỡ chưa)
```

---

## 1️⃣ Latency — "Request mất bao lâu?"

### Định nghĩa
Thời gian từ lúc request đến đến khi response được trả về.

> ⚠️ **Critical distinction:** Phân biệt latency của **successful requests** và **failed requests**.
> - Failed request thường fail **nhanh** (timeout sau 10ms, hoặc 400 ngay lập tức)
> - Nếu gộp chung, average latency trông tốt trong khi user thực sự đang bị lỗi

### Cách đo đúng

```java
// Spring Boot + Micrometer — đo latency tự động qua @Timed
@RestController
public class DocumentController {

    // Auto-record latency, error rate cho endpoint này
    @Timed(value = "document.upload", 
           description = "Time to upload document",
           percentiles = {0.5, 0.95, 0.99})
    @PostMapping("/documents")
    public ResponseEntity<DocumentDto> upload(...) { ... }
}
```

```yaml
# Prometheus metric được sinh ra:
# document_upload_seconds_count{status="200"} 1000
# document_upload_seconds_sum{status="200"}   45.2
# document_upload_seconds{quantile="0.95"}    0.23
# document_upload_seconds{quantile="0.99"}    1.87
```

### PromQL queries

```promql
# Average latency (5m window)
rate(document_upload_seconds_sum[5m]) / rate(document_upload_seconds_count[5m])

# P99 latency — dùng cái này để alert, không dùng average!
histogram_quantile(0.99, rate(document_upload_seconds_bucket[5m]))

# Latency chỉ của successful requests (status 2xx)
histogram_quantile(0.99, 
  rate(document_upload_seconds_bucket{status=~"2.."}[5m])
)
```

### Tại sao dùng P99, không dùng Average?

```
Request latencies (ms): 10, 12, 11, 13, 10, 850, 11, 12, 10, 11

Average  = 94ms  ← trông ổn
P50      = 11ms  ← 50% users ổn
P99      = 850ms ← 1% users đang bị "chết"
```

> Với 1000 requests/s, P99 = 850ms nghĩa là **10 users/s đang chờ gần 1 giây**. Average không thấy được điều này.

### Latency SLO thực tế (PDMS context)

| API | P50 target | P99 target | Alert threshold |
|-----|-----------|-----------|-----------------|
| Document upload | < 200ms | < 2s | P99 > 3s |
| Document search | < 100ms | < 500ms | P99 > 1s |
| Credit validation | < 50ms | < 300ms | P99 > 500ms |

---

## 2️⃣ Traffic — "Hệ thống đang xử lý bao nhiêu?"

### Định nghĩa
Đo lường **demand** đặt lên hệ thống — tùy service mà đơn vị khác nhau.

| Service type | Traffic metric |
|-------------|---------------|
| HTTP API | Requests/second (RPS) |
| Kafka consumer | Messages/second |
| Database | Queries/second |
| WebSocket | Active connections |
| Batch job | Records processed/second |

### Cách đo

```java
// Micrometer Counter — tự tăng mỗi request
Counter requestCounter = Counter.builder("document.requests.total")
    .tag("method", "POST")
    .tag("endpoint", "/documents")
    .register(meterRegistry);

// Trong handler:
requestCounter.increment();
```

```promql
# Requests per second (5m rolling window)
rate(document_requests_total[5m])

# So sánh traffic hiện tại vs cùng giờ hôm qua
rate(document_requests_total[5m]) 
  / rate(document_requests_total[5m] offset 24h)
```

### Traffic patterns quan trọng để monitor

```
Normal traffic pattern (VPBank):
  - Business hours (8h-17h): 500 RPS
  - Peak (9h-10h, 14h-15h): 1200 RPS  
  - Off-hours: 50 RPS

Alert khi:
  - Traffic giảm đột ngột 50% trong business hours → service down hoặc upstream vấn đề
  - Traffic tăng đột biến 3x → DDoS hoặc retry storm
```

---

## 3️⃣ Errors — "Hệ thống đang fail như thế nào?"

### Định nghĩa
Tỷ lệ requests bị fail — cả **explicit errors** (5xx) và **implicit errors** (wrong content, wrong data).

> ⚠️ **Không chỉ HTTP 5xx!** Explicit errors rõ ràng, nhưng implicit errors nguy hiểm hơn vì không trigger alert mặc định:
> - HTTP 200 nhưng response body thiếu field bắt buộc
> - HTTP 200 nhưng data bị truncated
> - Query trả về 0 rows trong khi phải có data (silent failure)

### Cách đo

```java
// Tách biệt success và error counter
Counter errorCounter = Counter.builder("document.errors.total")
    .tag("type", "validation_failed")
    .tag("endpoint", "/documents")
    .register(meterRegistry);

// Hoặc dùng @Timed — tự track status code
// Sau đó filter trong PromQL
```

```promql
# Error rate (%)
100 * rate(http_server_requests_seconds_count{status=~"5.."}[5m])
      / rate(http_server_requests_seconds_count[5m])

# Error rate chỉ của business-critical path
100 * rate(http_server_requests_seconds_count{
  uri="/api/documents/upload", status=~"5.."
}[5m])
/ rate(http_server_requests_seconds_count{
  uri="/api/documents/upload"
}[5m])
```

### Error budget từ Error rate

```
SLO: 99.9% success rate (0.1% error budget)

Trong 1 giờ với 1000 RPS:
  Total requests = 3,600,000
  Budget = 3,600 errors/hour = 60 errors/minute = 1 error/second

Alert khi error rate > 1% (burn rate = 10x) 
  → Budget sẽ cạn trong 6 giờ nếu không fix
```

---

## 4️⃣ Saturation — "Hệ thống còn bao nhiêu 'phòng'?"

### Định nghĩa
Đo lường mức độ **"đầy"** của resource constrained nhất trong system. Saturation tăng → latency tăng → errors bắt đầu xuất hiện.

> 💡 **Saturation là leading indicator** — nó cảnh báo **trước khi** latency và errors bị ảnh hưởng. Đây là signal quan trọng nhất để capacity planning.

### Resource cần monitor

```
┌─────────────────────────────────────────────────────┐
│  Resource               │  Metric                   │
├─────────────────────────┼───────────────────────────┤
│  CPU                    │  % utilization            │
│  Memory (JVM heap)      │  used / max               │
│  Thread pool            │  active / max             │
│  DB connection pool     │  active / max (CRITICAL)  │
│  Kafka consumer lag     │  lag per partition        │
│  Disk I/O               │  util%, queue depth       │
└─────────────────────────────────────────────────────┘
```

### Cách đo — DB Connection Pool là ví dụ quan trọng nhất

```yaml
# application.yaml — expose HikariCP metrics
spring:
  datasource:
    hikari:
      maximum-pool-size: 20
      minimum-idle: 5
      
management:
  metrics:
    enable:
      hikaricp: true
```

```promql
# DB connection pool saturation
hikaricp_connections_active / hikaricp_connections_max

# Alert khi > 80% (headroom chỉ còn 20%)
# Vì khi pool full, requests bị queue → latency spike
```

### Thread pool saturation (Spring/Quarkus)

```java
// Expose executor metrics
@Bean
public ThreadPoolTaskExecutor taskExecutor(MeterRegistry registry) {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(10);
    executor.setMaxPoolSize(50);
    executor.setQueueCapacity(100);
    
    // Register với Micrometer
    ExecutorServiceMetrics.monitor(registry, 
        executor.getThreadPoolExecutor(), 
        "document-processor");
    return executor;
}
```

```promql
# Thread pool queue saturation
executor_queue_remaining_tasks{name="document-processor"} 
  / (executor_queue_remaining_tasks + executor_queued_tasks)

# Khi ratio này tiến về 0 → queue sắp full → latency spike
```

### Kafka consumer lag — saturation trong event-driven system

```promql
# Consumer lag = messages chưa xử lý
kafka_consumer_group_lag{group="pdms-document-processor", topic="document-events"}

# Lag tăng liên tục → consumer không theo kịp producer → cần scale out
```

---

## 🔗 Correlation giữa 4 Signals

Khi xảy ra incident, đọc theo thứ tự này:

```
1. Errors ↑  → Alert trigger
      ↓
2. Latency ↑ → Confirm degradation (chậm hay chết?)
      ↓
3. Saturation ↑ → Tìm bottleneck (resource nào đầy?)
      ↓
4. Traffic ↑↓ → Root cause (traffic spike? retry storm? upstream fail?)
```

**Ví dụ PDMS incident:**
```
14:32 Alert: Error rate 5% ở Document Upload API
14:33 Check: P99 latency tăng từ 300ms → 8s
14:34 Check: DB connection pool 19/20 (95% saturated!)  
14:35 Check: Traffic bình thường, không có spike
→ Root cause: Slow query trong transaction giữ connection lâu
→ Fix: Add index + tune query timeout
```

---

## 📊 Dashboard Template (Grafana)

```
Row 1: Service Health Overview
  [Traffic RPS] [Error Rate %] [P50 Latency] [P99 Latency]

Row 2: Saturation
  [DB Pool %] [Thread Pool %] [JVM Heap %] [Kafka Lag]

Row 3: Per-Endpoint Breakdown
  [Heatmap: latency distribution by endpoint]
  [Error rate by endpoint + status code]
```

---

## 🆚 So sánh với RED và USE

| Method | Focus | Dùng khi |
|--------|-------|----------|
| **Four Golden Signals** | End-to-end user experience | Monitor services từ góc nhìn user |
| **RED** (Rate, Errors, Duration) | Service-level | Subset của Golden Signals, cho microservices |
| **USE** (Utilization, Saturation, Errors) | Resource-level | Monitor infrastructure (CPU, RAM, disk) |

> Trong thực tế: Dùng **Four Golden Signals** cho service dashboard, **USE** cho infra dashboard. Hai cái bổ sung nhau.

---

## 🔗 Liên kết trong vault

- [[_moc/MOC-Observability]] — MOC chính
- [[Microservices-Patterns/Metrics-and-Alerting]] — Implementation patterns
- [[concepts/micrometer-deep-dive]] *(cần viết)* — Java implementation chi tiết
- [[concepts/slo-sli-sla-explained]] *(cần viết)* — SLO từ 4 signals
- [[concepts/alert-fatigue-and-toil]] *(cần viết)* — Alerting strategy
