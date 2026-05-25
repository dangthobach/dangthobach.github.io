---
tags: [moc, observability, monitoring, distributed-systems, cloud-native]
created: 2026-04-14
status: growing
---

# 🔭 MOC — Observability

> **Mục tiêu của MOC này:** Hiểu và vận hành "trụ cột thứ 4" của Cloud-Native — khả năng **nhìn thấy bên trong hệ thống** mà không cần đoán mò. Observability không chỉ là logging hay monitoring — đó là khả năng trả lời câu hỏi **"Tại sao hệ thống hành xử như vậy?"** từ dữ liệu bên ngoài.

---

## 🧭 Ba Trụ cột (Three Pillars)

```
Observability
├── Logs      → "Điều gì đã xảy ra?"
├── Metrics   → "Hệ thống đang ở trạng thái nào?"
└── Traces    → "Request đã đi qua đâu và mất bao lâu?"
```

> **Tư duy quan trọng:** Ba trụ cột này **không thay thế nhau** — chúng bổ sung nhau. Alert từ Metrics → điều tra bằng Traces → xác nhận nguyên nhân bằng Logs.

---

## 📊 Metrics

### Lý thuyết nền tảng
- 📝 `[[four-golden-signals]]` *(cần viết)*
  → Latency, Traffic, Errors, Saturation. Bộ tứ của Google SRE Book — đây là **ngôn ngữ chung** khi nói về system health.
- 📝 `[[red-method-use-method]]` *(cần viết)*
  → RED (Rate, Errors, Duration) cho services. USE (Utilization, Saturation, Errors) cho resources. Khi nào dùng cái nào.

### Công cụ & Thực thi
- 📝 `[[micrometer-deep-dive]]` *(cần viết)*
  → Micrometer là "SLF4J của metrics". Counter, Gauge, Timer, DistributionSummary. Tích hợp với Spring Boot Actuator và Quarkus SmallRye Metrics.
- 📝 `[[prometheus-architecture]]` *(cần viết)*
  → Pull model vs Push model. PromQL cơ bản. Recording rules vs Alerting rules. Retention và remote storage.
- 📝 `[[grafana-dashboard-design]]` *(cần viết)*
  → Nguyên tắc thiết kế dashboard: USE/RED layout. Tránh "vanity metrics". Alert fatigue và cách giảm thiểu.

---

## 📋 Logging

### Lý thuyết nền tảng
- 📝 `[[structured-logging]]` *(cần viết)*
  → Tại sao `log.info("user {} logged in", userId)` tệ hơn JSON structured log. Correlation ID, Trace ID trong log. Log levels và khi nào dùng WARN vs ERROR.
- 📝 `[[log-aggregation-patterns]]` *(cần viết)*
  → Sidecar pattern (Fluentd/Logstash), DaemonSet log collector. Push vs Pull. Tại sao không log thẳng vào DB production.

### Công cụ & Stack
- 📝 `[[elk-stack-vs-loki]]` *(cần viết)*
  → ELK (Elasticsearch + Logstash + Kibana) vs Grafana Loki + Promtail. Chi phí storage, query performance, trade-off cho team nhỏ vs enterprise.
- 📝 `[[log-based-alerting]]` *(cần viết)*
  → Khi nào alert từ logs (vs metrics). Error rate từ log count. PagerDuty/Alertmanager integration.

---

## 🔍 Distributed Tracing

### Lý thuyết nền tảng
- 📝 `[[distributed-tracing-fundamentals]]` *(cần viết)*
  → Span, Trace, Context Propagation. W3C TraceContext vs B3 header. Sampling: head-based vs tail-based. Tại sao 100% sampling không scalable.
- 📝 `[[opentelemetry-architecture]]` *(cần viết)*
  → OTel = API + SDK + Collector. Vendor-neutral instrumentation. Auto-instrumentation vs Manual instrumentation. OTLP protocol.

### Công cụ & Thực thi
- 📝 `[[jaeger-vs-zipkin-vs-tempo]]` *(cần viết)*
  → So sánh backends. Grafana Tempo + Loki + Prometheus = full observability stack với chi phí thấp nhất. Jaeger cho enterprise.
- 📝 `[[opentelemetry-java-setup]]` *(cần viết)*
  → Java agent auto-instrumentation. Manual span creation. Context propagation qua Kafka headers. Quarkus OpenTelemetry extension vs Spring Boot OTel starter.

---

## 🚨 Alerting & SLO/SLI

### Lý thuyết nền tảng
- 📝 `[[slo-sli-sla-explained]]` *(cần viết)*
  → SLI (đo lường) → SLO (mục tiêu) → SLA (cam kết với khách hàng). Error Budget. Burn rate alerts. Tại sao "99.9% uptime" là con số dễ gây hiểu nhầm.
- 📝 `[[alert-fatigue-and-toil]]` *(cần viết)*
  → Nguyên nhân alert fatigue. Symptom-based vs cause-based alerting. Runbook automation. On-call rotation best practices.

### Thực thi
- 📝 `[[prometheus-alertmanager-setup]]` *(cần viết)*
  → AlertManager routing, inhibition, silencing. PagerDuty/Slack integration. Dead Man's Snitch pattern.

---

## 🏗️ Observability trong Microservices

### Context Propagation
- 📝 `[[trace-context-across-kafka]]` *(cần viết)*
  → Làm thế nào trace ID "sống sót" qua Kafka message. W3C TraceContext header trong Kafka ProducerRecord. OTel Kafka instrumentation.
- 📝 `[[correlation-id-pattern]]` *(cần viết)*
  → Correlation ID vs Trace ID — sự khác biệt. Inject ở API Gateway, propagate qua mọi service. Logging với MDC (Mapped Diagnostic Context).

### Framework-specific
- 📝 `[[quarkus-observability-stack]]` *(cần viết)*
  → Quarkus: SmallRye Health, Micrometer, OpenTelemetry extension. Native Image với OTel agent — các caveats.
- 📝 `[[spring-boot-actuator-deep-dive]]` *(cần viết)*
  → Actuator endpoints bảo mật, custom HealthIndicator, InfoContributor. Actuator vs OTel — khi nào dùng cái nào.

---

## 💡 Observability tại VPBank/PDMS

> Section này ghi lại các quyết định thực tế cho hệ thống PDMS — ánh xạ từ lý thuyết sang production constraints.

- **Hiện trạng:** Logging với SLF4J + Logback, chưa có structured logging chuẩn.
- **Gap cần giải quyết:**
  - [ ] Chuẩn hóa Correlation ID qua toàn bộ microservices
  - [ ] Setup Micrometer + Prometheus cho PDMS services
  - [ ] Distributed tracing cho luồng Credit Migration (Kafka-heavy)
  - [ ] SLO definition cho các API critical (upload document, search)
- **Constraints thực tế:** On-premise deployment, không dùng cloud-managed observability (Datadog, New Relic). → Stack khả thi: **Prometheus + Grafana + Loki + Tempo** (Grafana LGTM Stack).

---

## 🔗 Liên kết trong vault

- [[MOC-Distributed-Systems]] — Context propagation, microservice communication
- [[MOC-JVM-Frameworks]] — Framework-specific instrumentation (Quarkus, Spring)
- [[MOC-Scalability]] — Performance monitoring liên quan đến scalability decisions
- [[MOC-PDMS]] — Applied context: PDMS observability roadmap
- [[MOC-Database]] — DB-level metrics: slow query, connection pool, replication lag

---

## 📚 Lộ trình học đề xuất

```
Tuần 1-2: Nền tảng
  → Four Golden Signals → Structured Logging → SLO/SLI/SLA

Tuần 3-4: Công cụ
  → Prometheus + Grafana → Loki → OTel Architecture

Tuần 5-6: Distributed Tracing
  → OTel Java Setup → Trace Context qua Kafka → Jaeger/Tempo

Tuần 7-8: Production
  → Alert design (không gây fatigue) → PDMS implementation
```
