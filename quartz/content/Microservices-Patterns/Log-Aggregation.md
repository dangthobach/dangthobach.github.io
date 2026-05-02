---
tags: [microservices, observability, logging, elk, loki, structured-logging]
up: "[[04-Observability]]"
related: "[[Distributed-Tracing]], [[Metrics-and-Alerting]]"
---

# 📝 Log Aggregation — Deep Dive

> **TL;DR:** Mỗi service log ra file/stdout riêng → không thể debug distributed systems. Giải pháp: structured JSON logs + tập trung về một hệ thống tìm kiếm. Stack phổ biến: ELK (Elasticsearch + Logstash + Kibana) hoặc PLG (Promtail + Loki + Grafana — nhẹ hơn, rẻ hơn).

---

## 🎯 Structured Logging — nền tảng của log aggregation

### Từ plain text sang JSON

```java
// ❌ Plain text — máy không đọc được, không filter được
log.info("Processing document " + docId + " for customer " + customerId + 
         " type=" + docType + " by user=" + userId);
// Output: "Processing document DOC-001 for customer CUST-123 type=HOPDONG by user=U001"
// → Tìm kiếm bằng regex? Không khả thi với 1M logs/day

// ✅ Structured logging với Logback + Logstash encoder
import static net.logstash.logback.argument.StructuredArguments.kv;
import static net.logstash.logback.argument.StructuredArguments.v;

log.info("Document processing started",
    kv("documentId", docId),
    kv("customerId", customerId),
    kv("documentType", docType),
    kv("initiatedBy", userId),
    kv("batchId", batchId)
);

/* JSON output:
{
  "timestamp": "2026-04-12T10:32:15.123Z",
  "level": "INFO",
  "service": "document-service",
  "traceId": "abc-123-xyz",           ← từ MDC (OpenTelemetry tự inject)
  "spanId": "span-456",
  "message": "Document processing started",
  "documentId": "DOC-001",
  "customerId": "CUST-123",
  "documentType": "HOPDONG",
  "initiatedBy": "U001",
  "batchId": "BATCH-789"
}
*/
```

### Logback Configuration (JSON format)

```xml
<!-- logback-spring.xml -->
<configuration>
    <springProperty scope="context" name="appName" source="spring.application.name"/>
    
    <appender name="JSON_STDOUT" class="ch.qos.logback.core.ConsoleAppender">
        <encoder class="net.logstash.logback.encoder.LoggingEventCompositeJsonEncoder">
            <providers>
                <timestamp>
                    <fieldName>timestamp</fieldName>
                    <pattern>yyyy-MM-dd'T'HH:mm:ss.SSS'Z'</pattern>
                    <timeZone>UTC</timeZone>
                </timestamp>
                <logLevel><fieldName>level</fieldName></logLevel>
                <loggerName><fieldName>logger</fieldName></loggerName>
                <message/>
                <mdc/>  <!-- Tự động include traceId, spanId từ MDC -->
                <arguments/>  <!-- Structured arguments từ kv() -->
                <stackTrace>
                    <fieldName>exception</fieldName>
                    <throwableConverter class="net.logstash.logback.stacktrace.ShortenedThrowableConverter">
                        <maxDepthPerCause>10</maxDepthPerCause>
                        <exclude>sun\.reflect\..*</exclude>
                        <exclude>java\.lang\.reflect\..*</exclude>
                    </throwableConverter>
                </stackTrace>
                <pattern>
                    <pattern>{"service": "${appName}", "environment": "${SPRING_PROFILES_ACTIVE:-local}"}</pattern>
                </pattern>
            </providers>
        </encoder>
    </appender>
    
    <!-- Dev: human-readable -->
    <springProfile name="local">
        <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
            <encoder>
                <pattern>%d{HH:mm:ss} [%X{traceId}] %-5level %logger{36} - %msg%n</pattern>
            </encoder>
        </appender>
        <root level="INFO"><appender-ref ref="CONSOLE"/></root>
    </springProfile>
    
    <!-- Production: JSON -->
    <springProfile name="prod,staging">
        <root level="INFO"><appender-ref ref="JSON_STDOUT"/></root>
        <!-- Document Service hay bị noisy từ Hibernate -->
        <logger name="org.hibernate.SQL" level="WARN"/>
        <logger name="org.springframework.kafka" level="WARN"/>
    </springProfile>
</configuration>
```

---

## 📋 Logging Conventions (PDMS Standard)

### Log levels — khi nào dùng gì

```java
@Service
public class DocumentService {
    
    public Document createDocument(CreateDocumentCommand cmd) {
        // DEBUG: Chi tiết implementation, chỉ bật khi troubleshoot
        log.debug("Validating document command",
            kv("commandType", cmd.getClass().getSimpleName()),
            kv("payload", cmd));  // ← KHÔNG log sensitive data (PII, credit info)
        
        // INFO: Business events quan trọng — normal operation
        log.info("Document created successfully",
            kv("documentId", doc.getId()),
            kv("documentType", doc.getType()),
            kv("customerId", doc.getCustomerId()),
            kv("processingTimeMs", duration.toMillis()));
        
        // WARN: Unexpected nhưng recoverable — cần investigate sau
        if (doc.getFileSize() > MAX_RECOMMENDED_SIZE) {
            log.warn("Document size exceeds recommendation",
                kv("documentId", doc.getId()),
                kv("fileSizeMB", doc.getFileSizeInMB()),
                kv("maxRecommendedMB", MAX_RECOMMENDED_SIZE_MB));
        }
        
        // ERROR: Phải investigate ngay — kèm exception
        try {
            creditService.linkAccount(doc.getId(), cmd.getAccountId());
        } catch (CreditServiceUnavailableException e) {
            log.error("Failed to link credit account — will retry via Saga",
                kv("documentId", doc.getId()),
                kv("accountId", cmd.getAccountId()),
                kv("errorCode", e.getCode()),
                e);  // ← luôn pass exception object vào cuối
        }
    }
}
```

### Logging sensitive data — KHÔNG bao giờ log

```java
// ❌ TUYỆT ĐỐI KHÔNG LOG
log.info("Customer data: {}", customer.getCccd());    // CMND/CCCD
log.info("Account: {}", account.getAccountNumber());  // Số tài khoản
log.info("Token: {}", authToken);                     // Auth tokens
log.info("Request body: {}", requestBody);            // Có thể chứa PII

// ✅ Log reference/mask
log.info("Customer authenticated",
    kv("customerId", customer.getId()),           // ID reference, không phải data
    kv("cccdMasked", maskCccd(customer.getCccd())));  // "***1234"
```

---

## 🗂️ Log Aggregation Stacks

### Stack 1: PLG — Promtail + Loki + Grafana (recommend cho PDMS)

```yaml
# docker-compose.yml
services:
  loki:
    image: grafana/loki:3.0.0
    ports: ["3100:3100"]
    volumes:
      - ./loki-config.yml:/etc/loki/config.yml
    command: -config.file=/etc/loki/config.yml

  promtail:
    image: grafana/promtail:3.0.0
    volumes:
      - /var/log:/var/log:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      - ./promtail-config.yml:/etc/promtail/config.yml
    command: -config.file=/etc/promtail/config.yml
```

```yaml
# promtail-config.yml
scrape_configs:
  - job_name: pdms-services
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
    relabel_configs:
      - source_labels: [__meta_docker_container_label_com_docker_compose_service]
        target_label: service
    pipeline_stages:
      - json:
          expressions:
            level: level
            traceId: traceId
            documentId: documentId
      - labels:
          level:
          service:
      - output:
          source: message
```

**Loki query (LogQL) trong Grafana:**

```logql
# Tất cả ERROR logs từ document-service trong 1h
{service="document-service"} |= `"level":"ERROR"` | json | line_format "{{.message}} | docId={{.documentId}}"

# Tìm tất cả logs của một trace cụ thể
{service=~"pdms-.*"} | json | traceId="abc-123-xyz"

# Count errors by service theo thời gian
sum by (service) (
  rate({service=~"pdms-.*"} |= `"level":"ERROR"` [5m])
)

# Batch jobs chạy > 10 phút
{service="document-service"} 
| json 
| documentType="BATCH" 
| processingTimeMs > 600000
```

### Stack 2: ELK (nếu team đã có Elasticsearch)

```yaml
# Logstash pipeline
input {
  beats { port => 5044 }
}

filter {
  if [message] =~ /^\{/ {
    json { source => "message" }
    
    # Parse timestamp
    date {
      match => ["timestamp", "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"]
      target => "@timestamp"
    }
    
    # Enrich với GeoIP nếu cần
    mutate {
      remove_field => ["message", "host", "agent"]
    }
  }
}

output {
  elasticsearch {
    hosts => ["elasticsearch:9200"]
    index => "pdms-logs-%{+YYYY.MM.dd}"
  }
}
```

---

## 🔍 Correlation: Trace + Log + Metric

```
Grafana Unified View:
┌──────────────────────────────────────────────────────────┐
│ Trace: abc-123-xyz — POST /documents — 450ms            │
│  └── [Credit Service span: 350ms] ← click span          │
│        ↓ Jump to logs                                    │
│ Logs filtered by traceId=abc-123-xyz:                   │
│  [document-svc] INFO  "Document processing started"     │
│  [credit-svc]   WARN  "DB query slow: 340ms"           │
│  [credit-svc]   ERROR "Connection pool exhausted"       │
│        ↓ Jump to metrics at t=10:32:15                  │
│ Metrics: hikaricp_connections_active = 20/20 (100%)     │
│          → DB connection pool exhausted là root cause   │
└──────────────────────────────────────────────────────────┘
```

**Grafana Explore — correlate từ trace sang log:**

Trong Grafana, khi xem trace → click "Logs for this trace" → tự động query Loki với `traceId` filter → thấy logs tương ứng.

Config trong Grafana datasource:

```yaml
# grafana datasource: Tempo (traces)
tracesToLogs:
  datasourceUid: loki-datasource
  filterByTraceID: true
  filterBySpanID: false
  mapTagNamesEnabled: true
  mappedTags:
    - key: service.name
      value: service

# grafana datasource: Loki (logs)
derivedFields:
  - name: TraceID
    matcherRegex: '"traceId":"(\w+)"'
    url: '$${__value.raw}'
    datasourceUid: tempo-datasource
```

---

## 🏦 PDMS Log Aggregation Setup

```
Architecture:
  Services → stdout (JSON) → Docker log driver
  → Promtail (collect) → Loki (store + index)
  → Grafana (query, alert, correlate với traces)

Retention policy:
  Production logs: 30 ngày (regulatory requirement banking)
  Staging logs: 7 ngày
  Debug logs: 3 ngày (rotate nhanh, verbose)

Alert từ logs (Grafana alert rule):
  Trigger: count({service=~"pdms-.*"} |= `"level":"ERROR"` [5m]) > 10
  → Slack notification với log sample
```

---

## 🔗 Liên kết
- [[04-Observability]] — Observability group
- [[Distributed-Tracing]] — Kết hợp trace + log
- [[Metrics-and-Alerting]] — Kết hợp metric + log
