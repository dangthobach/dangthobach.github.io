---
tags: [microservices, patterns, observability, tracing, metrics, logging]
up: "[[00-Hub-Microservices-Patterns]]"
---

# 🔭 04 — Observability Patterns

> **Core problem:** Distributed systems là hộp đen. Một request có thể đi qua 10 services — khi nó fail, bạn tìm lỗi ở đâu?

---

## 🧭 Three Pillars of Observability

```
              Observability
           ┌──────┼──────┐
           ▼      ▼      ▼
         Logs  Metrics  Traces
           │      │      │
    "Gì xảy  "Bao  "Request
     ra lúc   nhiêu  đi đường
     này?"   lần?"   nào?"
```

**Dùng kết hợp — không thay thế nhau:**
- **Logs:** Chi tiết về một sự kiện cụ thể
- **Metrics:** Aggregated numbers (latency p99, error rate, throughput)
- **Traces:** Full journey của một request xuyên qua tất cả services

---

## 📊 Distributed Tracing

**Vấn đề:** Request từ user đi qua Gateway → Auth → Document → Credit → Audit. Mỗi service có log riêng. Làm sao biết 5 dòng log này thuộc cùng một request?

**Solution: Correlation ID (Trace ID)**

```
User Request
     │
     ▼ traceId: "abc-123"
[Gateway]        → log: "abc-123 | received GET /documents/456 | 2ms"
     │
     ▼ traceId: "abc-123", spanId: "span-01"
[Document Svc]   → log: "abc-123 | fetching document 456 | 15ms"
     │
     ▼ traceId: "abc-123", spanId: "span-02"
[Credit Svc]     → log: "abc-123 | fetching credit for customer X | 8ms"
     │
     ▼
Total: "abc-123" → 25ms, 3 spans, all successful
```

**Spring Boot + OpenTelemetry:**

```xml
<!-- pom.xml -->
<dependency>
  <groupId>io.micrometer</groupId>
  <artifactId>micrometer-tracing-bridge-otel</artifactId>
</dependency>
<dependency>
  <groupId>io.opentelemetry.instrumentation</groupId>
  <artifactId>opentelemetry-spring-boot-starter</artifactId>
</dependency>
```

```yaml
# application.yml
management:
  tracing:
    sampling:
      probability: 1.0  # 100% trong dev; 0.1 (10%) trong prod
  otlp:
    tracing:
      endpoint: http://jaeger:4318/v1/traces
      
logging:
  pattern:
    level: "%5p [${spring.application.name},%X{traceId},%X{spanId}]"
    # Log tự động include traceId
```

**Propagate trace header qua HTTP:**
```java
// Tự động với Spring + OpenTelemetry
// Header: traceparent: 00-abc123-span01-01
// Mỗi HTTP call tự động forward header này sang service tiếp theo
```

---

## 📈 Application Metrics

```yaml
# Prometheus + Spring Actuator
management:
  endpoints:
    web:
      exposure:
        include: health, metrics, prometheus
  metrics:
    tags:
      application: ${spring.application.name}
```

**Custom business metrics:**
```java
@Component
public class DocumentMetrics {
    private final Counter documentsCreated;
    private final Timer documentProcessingTime;
    
    public DocumentMetrics(MeterRegistry registry) {
        this.documentsCreated = Counter.builder("documents.created.total")
            .tag("type", "contract")
            .description("Total documents created")
            .register(registry);
            
        this.documentProcessingTime = Timer.builder("documents.processing.duration")
            .description("Time to process document")
            .register(registry);
    }
    
    public void recordDocumentCreated() {
        documentsCreated.increment();
    }
    
    public void recordProcessingTime(Duration duration) {
        documentProcessingTime.record(duration);
    }
}
```

**Key metrics cần monitor:**
| Metric | Alert khi |
|---|---|
| `http_server_requests_seconds_count` | Error rate > 1% |
| `http_server_requests_seconds_max` | P99 latency > 3s |
| `resilience4j_circuitbreaker_state` | State = OPEN |
| `kafka_consumer_lag` | Consumer lag > 10K messages |
| `jvm_memory_used_bytes` | Memory > 80% heap |

---

## 📝 Log Aggregation

**Structured logging — không log plain text:**

```java
// ❌ Plain text — khó parse
log.info("Document " + docId + " created by user " + userId);

// ✅ Structured JSON — dễ query trong ELK/Loki
log.info("Document created",
    StructuredArguments.kv("documentId", docId),
    StructuredArguments.kv("userId", userId),
    StructuredArguments.kv("documentType", type),
    StructuredArguments.kv("traceId", MDC.get("traceId"))
);
// Output: {"documentId":"456","userId":"U001","documentType":"HOPDONG","traceId":"abc-123"}
```

**Logback config (JSON format):**
```xml
<dependency>
  <groupId>net.logstash.logback</groupId>
  <artifactId>logstash-logback-encoder</artifactId>
</dependency>
```

---

## 🏥 Health Check API

```java
// Spring Actuator tự động expose /actuator/health
// Có thể custom:

@Component
public class KafkaHealthIndicator implements HealthIndicator {
    
    @Override
    public Health health() {
        try {
            long lag = calculateConsumerLag();
            if (lag > 100_000) {
                return Health.down()
                    .withDetail("lag", lag)
                    .withDetail("reason", "Consumer lag too high")
                    .build();
            }
            return Health.up().withDetail("lag", lag).build();
        } catch (Exception e) {
            return Health.down(e).build();
        }
    }
}
```

---

## 🏦 PDMS Observability Stack

```
Services → OpenTelemetry Agent → Jaeger (tracing UI)
        → Prometheus scrape   → Grafana (metrics dashboard)
        → Logback JSON        → Loki/ELK (log search)
        
Alerting rules:
  - CircuitBreaker OPEN → PagerDuty alert
  - Kafka consumer lag > 50K → Slack notification
  - Document processing errors > 5% → Alert
  - Batch job duration > 2h → Alert
```

---

## 🔗 Liên kết
- [[00-Hub-Microservices-Patterns]] — Hub
- [[03-Reliability]] — Circuit Breaker metrics quan trọng
- [[02-Communication]] — Trace xuyên qua API Gateway

## 🔗 Deep-dive notes

- [[Distributed-Tracing]] — OpenTelemetry setup, custom spans, trace propagation qua Kafka
- [[Metrics-and-Alerting]] — Prometheus, custom business metrics, PromQL, Alertmanager rules
- [[Log-Aggregation]] — Structured logging, PLG stack (Loki), ELK, log-trace correlation
- [[Circuit-Breaker]] — Monitor CB state qua metrics + alerts
