---
tags: [microservices, observability, tracing, opentelemetry, prometheus, grafana, elk, loki]
up: "[[04-Observability]]"
related: "[[Circuit-Breaker]], [[03-Reliability]]"
---

# 🔭 Distributed Tracing — Deep Dive

> **TL;DR:** Gán một `traceId` duy nhất cho mỗi request từ khi vào hệ thống. TraceId được propagate qua tất cả services. Mọi log, metric, span đều gắn với traceId → có thể reconstruct full journey của request.

---

## 🎯 Problem

```
User báo: "Tôi tạo hợp đồng lúc 10:32, bị lỗi 500"

Không có distributed tracing:
  Gateway log:   "2026-04-12 10:32:15 POST /api/documents 500"
  Doc Svc log:   "2026-04-12 10:32:15 ERROR NullPointerException at..."
  Credit Svc log:"2026-04-12 10:32:14 INFO getCreditInfo customerId=?"
  Audit Svc log: "2026-04-12 10:32:16 INFO audit event logged"
  
  Câu hỏi: 4 dòng log này có liên quan đến nhau không?
           Lỗi xuất hiện ở service nào?
           Latency breakdown như thế nào?
  → Không biết. Phải guess.

Có distributed tracing:
  traceId: abc-123-xyz
  [Gateway]     10:32:15.000  POST /documents — 450ms  → traceId: abc-123-xyz
  [Doc Service] 10:32:15.002  createDocument  — 430ms  → traceId: abc-123-xyz
  [Credit Svc]  10:32:15.010  getCreditInfo   — 350ms  → traceId: abc-123-xyz ❌ ERROR
  
  → Lỗi ở Credit Service, latency chủ yếu do Credit Svc (350/450ms)
```

---

## 🏗️ OpenTelemetry Setup (Spring Boot 3)

### Dependencies

```xml
<!-- Spring Boot 3 — dùng Micrometer + OTEL bridge -->
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-tracing-bridge-otel</artifactId>
</dependency>
<dependency>
    <groupId>io.opentelemetry.instrumentation</groupId>
    <artifactId>opentelemetry-spring-boot-starter</artifactId>
    <version>2.10.0</version>
</dependency>
<!-- Export tới Jaeger/Tempo -->
<dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-exporter-otlp</artifactId>
</dependency>
```

### Configuration

```yaml
spring:
  application:
    name: document-service   # ← xuất hiện trong traces

management:
  tracing:
    sampling:
      probability: 1.0       # 100% trong dev; 0.05-0.1 trong prod
  otlp:
    tracing:
      endpoint: http://tempo:4318/v1/traces  # Grafana Tempo hoặc Jaeger

logging:
  pattern:
    # Tự động inject traceId, spanId vào mỗi log line
    level: "%5p [${spring.application.name},%X{traceId},%X{spanId}]"
    
otel:
  instrumentation:
    jdbc:
      enabled: true          # Trace SQL queries
    kafka:
      enabled: true          # Trace Kafka produce/consume
    spring-web:
      enabled: true          # Trace HTTP calls
```

### Trace propagation — HTTP

```java
// Khi gọi service khác qua RestTemplate/WebClient
// OTEL tự động inject headers:
//   traceparent: 00-abc123traceId-spanId-01
//   baggage: userId=U001,sessionId=S999

@Bean
@LoadBalanced
public WebClient.Builder webClientBuilder(ObservationRegistry registry) {
    return WebClient.builder()
        .observationRegistry(registry);  // ← auto-propagate trace context
}

// Dùng WebClient — trace context tự lan sang service kia
webClient.get()
    .uri("http://credit-service/api/credits/{id}", customerId)
    .retrieve()
    .bodyToMono(CreditInfo.class);
```

### Trace propagation — Kafka

```java
// Producer — inject trace context vào Kafka headers
@Bean
public ProducerFactory<String, String> producerFactory() {
    Map<String, Object> props = new HashMap<>(kafkaProperties.buildProducerProperties());
    return new DefaultKafkaProducerFactory<>(props);
}

// Với spring-kafka 3.x + OTEL, tracing headers tự động được inject:
// Header: traceparent = 00-{traceId}-{spanId}-01

// Consumer — extract trace context từ Kafka headers
@KafkaListener(topics = "document-events")
public void consume(ConsumerRecord<String, String> record) {
    // OTEL tự động extract trace context từ headers
    // → span mới được tạo, linked với producer span
    // → traceId liên tục từ HTTP request ban đầu → Kafka → consumer
    processDocument(record.value());
}
```

### Custom Spans — thêm business context

```java
@Service
@RequiredArgsConstructor
public class DocumentBatchProcessor {
    
    private final Tracer tracer;
    
    public void processBatch(List<String> documentIds) {
        // Tạo custom span cho business operation
        Span batchSpan = tracer.nextSpan()
            .name("document.batch.process")
            .tag("batch.size", String.valueOf(documentIds.size()))
            .tag("batch.type", "CREDIT_MIGRATION")
            .start();
        
        try (Tracer.SpanInScope scope = tracer.withSpan(batchSpan)) {
            for (String docId : documentIds) {
                processOne(docId);
            }
            batchSpan.tag("batch.status", "SUCCESS");
        } catch (Exception e) {
            batchSpan.tag("batch.status", "FAILED");
            batchSpan.error(e);
            throw e;
        } finally {
            batchSpan.end();
        }
    }
    
    private void processOne(String docId) {
        Span span = tracer.nextSpan().name("document.process.single")
            .tag("document.id", docId)
            .start();
        try (Tracer.SpanInScope s = tracer.withSpan(span)) {
            // processing logic
        } finally {
            span.end();
        }
    }
}
```

---

## 🎯 Jaeger UI — Đọc Trace

```
Trace: abc-123-xyz — POST /api/documents — 450ms

├── [Gateway] route-document-service           0ms  →  5ms    (5ms)
└── [Document Service] createDocument          5ms  →  450ms  (445ms)
    ├── [DB] SELECT * FROM documents           5ms  →  15ms   (10ms)
    ├── [Credit Service] getCreditInfo         15ms →  365ms  (350ms) ❌ SLOW
    │   └── [DB] SELECT credits WHERE...      20ms →  360ms  (340ms) ← root cause
    └── [DB] INSERT INTO documents            365ms→  445ms  (80ms)
    └── [Kafka] produce document-events       445ms→  450ms  (5ms)

Root cause: Credit Service DB query chậm 340ms
            → Thiếu index hoặc lock contention
```

---

## 🔗 Liên kết
- [[04-Observability]] — Observability group overview
- [[Metrics-and-Alerting]] — Metrics + Alerting deep dive
- [[Log-Aggregation]] — Structured logging + ELK/Loki
- [[Circuit-Breaker]] — Monitor CB state qua traces và metrics
