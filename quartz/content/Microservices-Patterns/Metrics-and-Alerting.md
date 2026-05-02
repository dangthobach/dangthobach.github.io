---
tags: [microservices, observability, prometheus, grafana, metrics, alerting]
up: "[[04-Observability]]"
related: "[[Distributed-Tracing]], [[Log-Aggregation]], [[Circuit-Breaker]]"
---

# 📈 Metrics & Alerting — Deep Dive

> **TL;DR:** Metrics là aggregated numbers theo thời gian — cho biết xu hướng của hệ thống. Alerting là tự động notify khi metrics vượt ngưỡng. Stack chuẩn: Prometheus (scrape + store) + Grafana (visualize + alert).

---

## 🏗️ Setup Prometheus + Grafana

### Spring Boot — expose metrics

```xml
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
</dependency>
```

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health, metrics, prometheus, info
  metrics:
    tags:
      # Tags xuất hiện trên mọi metric — rất quan trọng cho filtering
      application: ${spring.application.name}
      environment: ${spring.profiles.active}
      version: ${app.version}
    distribution:
      # Histogram buckets cho latency metrics
      percentiles-histogram:
        http.server.requests: true
      percentiles:
        http.server.requests: 0.5, 0.90, 0.95, 0.99
      slo:
        http.server.requests: 100ms, 500ms, 1s, 3s, 5s
```

### Prometheus scrape config

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'pdms-services'
    metrics_path: '/actuator/prometheus'
    static_configs:
      - targets:
          - 'document-service:8080'
          - 'credit-service:8080'
          - 'workflow-service:8080'
          - 'gateway:8080'
    relabel_configs:
      - source_labels: [__address__]
        target_label: instance
```

---

## 📊 Custom Business Metrics

### Counter — đếm sự kiện

```java
@Component
@RequiredArgsConstructor
public class DocumentMetrics {
    
    private final MeterRegistry registry;
    
    // Counters — chỉ tăng, không giảm
    private Counter documentsCreated(String type) {
        return Counter.builder("pdms.documents.created.total")
            .tag("document_type", type)
            .tag("service", "document-service")
            .description("Total documents created")
            .register(registry);
    }
    
    private Counter documentsFailedValidation(String reason) {
        return Counter.builder("pdms.documents.validation.failed.total")
            .tag("reason", reason)
            .register(registry);
    }
    
    public void recordDocumentCreated(String type) {
        documentsCreated(type).increment();
    }
    
    public void recordValidationFailed(String reason) {
        documentsFailedValidation(reason).increment();
    }
}
```

### Timer — đo latency với histogram

```java
@Component
public class BatchProcessingMetrics {
    
    private final Timer batchProcessingTimer;
    private final Timer validationTimer;
    
    public BatchProcessingMetrics(MeterRegistry registry) {
        this.batchProcessingTimer = Timer.builder("pdms.batch.processing.duration")
            .tag("type", "credit_migration")
            .description("Time to process a credit migration batch")
            .publishPercentiles(0.5, 0.95, 0.99)
            .publishPercentileHistogram()
            .sla(Duration.ofSeconds(30), Duration.ofMinutes(2), Duration.ofMinutes(10))
            .register(registry);
            
        this.validationTimer = Timer.builder("pdms.batch.validation.duration")
            .tag("procedure", "pr_process_validation_hopdong_batch")
            .register(registry);
    }
    
    // Sử dụng
    public void processBatch(BatchJob job) {
        batchProcessingTimer.record(() -> {
            doProcessBatch(job);
        });
    }
    
    // Hoặc manual timing
    public BatchResult processBatchWithResult(BatchJob job) {
        Timer.Sample sample = Timer.start(registry);
        try {
            BatchResult result = doProcessBatch(job);
            sample.stop(batchProcessingTimer);
            return result;
        } catch (Exception e) {
            // Tag thêm error
            sample.stop(Timer.builder("pdms.batch.processing.duration")
                .tag("type", "credit_migration")
                .tag("error", e.getClass().getSimpleName())
                .register(registry));
            throw e;
        }
    }
}
```

### Gauge — giá trị hiện tại

```java
@Component
public class QueueMetrics {
    
    public QueueMetrics(MeterRegistry registry, OutboxRepository outboxRepo,
                        KafkaConsumerLagService lagService) {
        
        // Gauge — reflect state hiện tại
        Gauge.builder("pdms.outbox.pending.count", outboxRepo,
                repo -> repo.countByPublishedAtIsNull())
            .description("Number of unpublished outbox events")
            .register(registry);
        
        Gauge.builder("pdms.kafka.consumer.lag", lagService,
                svc -> svc.getTotalLag("document-group"))
            .tag("consumer_group", "document-group")
            .description("Kafka consumer group lag")
            .register(registry);
    }
}
```

---

## 🚨 Alerting Rules (Prometheus Alertmanager)

```yaml
# alert-rules.yml
groups:
  - name: pdms-slo-alerts
    rules:
      # SLO: 99% requests < 3s
      - alert: HighLatencyP99
        expr: |
          histogram_quantile(0.99,
            sum(rate(http_server_requests_seconds_bucket{
              application=~"pdms-.*"
            }[5m])) by (application, uri, le)
          ) > 3
        for: 5m
        labels:
          severity: warning
          team: pdms
        annotations:
          summary: "High P99 latency on {{ $labels.application }}"
          description: "P99 latency is {{ $value }}s for {{ $labels.uri }}"
          runbook: "https://wiki/runbooks/high-latency"

      # SLO: Error rate < 1%
      - alert: HighErrorRate
        expr: |
          sum(rate(http_server_requests_seconds_count{
            application=~"pdms-.*", status=~"5.."
          }[5m])) by (application)
          /
          sum(rate(http_server_requests_seconds_count{
            application=~"pdms-.*"
          }[5m])) by (application)
          > 0.01
        for: 2m
        labels:
          severity: critical
          team: pdms

      # Circuit Breaker OPEN
      - alert: CircuitBreakerOpen
        expr: resilience4j_circuitbreaker_state{state="open"} == 1
        for: 1m
        labels:
          severity: high
        annotations:
          summary: "Circuit Breaker OPEN: {{ $labels.name }}"

      # Kafka consumer lag
      - alert: KafkaConsumerLagHigh
        expr: pdms.kafka.consumer.lag > 50000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Kafka consumer lag too high: {{ $value }} messages"

      # Outbox events stuck
      - alert: OutboxEventStuck
        expr: pdms_outbox_pending_count > 1000
        for: 15m
        labels:
          severity: high
        annotations:
          summary: "{{ $value }} outbox events not published for 15+ minutes"
          description: "Possible Debezium/Kafka connectivity issue"

      # Batch job duration
      - alert: BatchJobTooSlow
        expr: |
          histogram_quantile(0.95,
            rate(pdms_batch_processing_duration_seconds_bucket[30m])
          ) > 7200  # 2 hours
        labels:
          severity: warning
```

---

## 📊 Grafana Dashboard: Golden Signals

**Four Golden Signals** (Google SRE book):

```
1. Latency   — "Bao lâu?"
2. Traffic   — "Bao nhiêu requests?"
3. Errors    — "Bao nhiêu lỗi?"
4. Saturation— "Hệ thống gần đầy chưa?"
```

### PromQL queries cho Grafana panels

```promql
# 1. Request Rate (Traffic)
sum(rate(http_server_requests_seconds_count{application="document-service"}[1m]))
by (uri, method)

# 2. Error Rate
sum(rate(http_server_requests_seconds_count{
  application="document-service", status=~"5.."
}[1m]))
/
sum(rate(http_server_requests_seconds_count{
  application="document-service"
}[1m]))
* 100  -- percentage

# 3. Latency P50/P95/P99
histogram_quantile(0.99,
  sum(rate(http_server_requests_seconds_bucket{
    application="document-service"
  }[5m])) by (le, uri)
)

# 4. JVM Memory (Saturation)
jvm_memory_used_bytes{area="heap", application="document-service"}
/
jvm_memory_max_bytes{area="heap", application="document-service"}
* 100  -- percentage

# 5. DB Connection Pool (Saturation)
hikaricp_connections_active{application="document-service"}
/
hikaricp_connections_max{application="document-service"}

# 6. Kafka Consumer Lag
sum(kafka_consumer_group_offset_lag) by (consumer_group, topic)

# 7. Circuit Breaker State
resilience4j_circuitbreaker_state{application=~"pdms-.*"}
# 0=CLOSED (good), 1=OPEN (bad), 2=HALF_OPEN

# 8. Batch Processing Rate (PDMS-specific)
rate(pdms_documents_created_total[5m]) * 60  -- per minute
```

---

## 🏦 PDMS Metrics Checklist

```
Infrastructure metrics (auto từ Spring Actuator):
  ✅ JVM heap usage, GC pause duration
  ✅ HikariCP connection pool (active/idle/max/timeout)
  ✅ HTTP request rate, latency (p50/p95/p99), error rate
  ✅ Thread pool active/queue size

Business metrics (custom — cần implement):
  ✅ pdms.documents.created.total        (by document_type)
  ✅ pdms.documents.validation.failed.total (by reason)
  ✅ pdms.batch.processing.duration      (histogram)
  ✅ pdms.outbox.pending.count           (gauge)
  ✅ pdms.migration.records.processed    (counter, by batch)
  ✅ pdms.credit.accounts.linked.total

Infrastructure-specific:
  ✅ resilience4j.circuitbreaker.state
  ✅ kafka.consumer.group.offset.lag
  ✅ debezium.connector.status (nếu dùng CDC)
```

---

## 🔗 Liên kết
- [[04-Observability]] — Observability group
- [[Distributed-Tracing]] — Trace + metrics kết hợp trong Grafana
- [[Log-Aggregation]] — Third pillar: logs
- [[Circuit-Breaker]] — CB state là một trong các metrics quan trọng nhất
