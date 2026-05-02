---
tags: [microservices, patterns, decomposition, ddd, strangler-fig, deployment]
up: "[[00-Hub-Microservices-Patterns]]"
---

# ✂️ 05 — Decomposition & Deployment Patterns

> **Core problem:** Làm sao cắt service boundaries đúng? Làm sao migrate từ monolith mà không "big bang rewrite"? Deploy như thế nào để có thể release độc lập?

---

## 🧭 Sai lầm phổ biến khi cắt services

```
❌ Cắt theo technical layer:
  [UI Service] [Business Service] [Data Service]
  → Mỗi feature cần update cả 3 services → coupling

❌ Cắt quá nhỏ (nano-services):
  [CreateOrderService] [ValidateOrderService] [SaveOrderService]
  → Overhead giao tiếp > business value

✅ Cắt theo business capability / DDD subdomain:
  [Order Service] [Catalog Service] [Customer Service] [Payment Service]
  → Mỗi service có thể deploy, scale, thay đổi độc lập
```

---

## 🗂️ Patterns trong nhóm này

### Decompose by Subdomain (DDD)

**DDD Bounded Context → Service boundary:**

```
Domain: Ngân hàng bán lẻ (PDMS)
│
├── Subdomain: Document Management    → Document Service
│   └── Ngôn ngữ riêng: "hợp đồng", "tập hồ sơ", "lưu trữ"
│
├── Subdomain: Credit Processing      → Credit Service  
│   └── Ngôn ngữ riêng: "khoản vay", "dư nợ", "tài sản đảm bảo"
│
├── Subdomain: Workflow Management    → Workflow Service
│   └── Ngôn ngữ riêng: "luồng duyệt", "task", "assignee"
│
└── Subdomain: Audit & Compliance     → Audit Service
    └── Ngôn ngữ riêng: "sự kiện", "người thực hiện", "dấu thời gian"
```

**Heuristic để kiểm tra boundary đúng chưa:**
- Một team có thể làm việc trên service này mà không cần coordinate với team khác? ✅
- Deployment của service này không break service khác? ✅
- Service này có một "reason to change" duy nhất? ✅

---

### [[Strangler-Fig]] — Migrate monolith từng bước

**Tên pattern từ cây sung siết (strangler fig):** Cây mới mọc xung quanh cây cũ, dần dần thay thế từng phần, cuối cùng cây cũ chết đi.

```
Phase 1: Monolith handles everything
  [All Requests] → [Monolith]

Phase 2: New service behind proxy
  [All Requests] → [Proxy/Gateway]
                      ├── /documents/** → [New Document Service]
                      └── /** → [Monolith]

Phase 3: Migrate more features
  [All Requests] → [Proxy/Gateway]
                      ├── /documents/** → [Document Service]
                      ├── /credits/** → [Credit Service]
                      └── /** → [Monolith] (shrinking)

Phase N: Monolith retired
  [All Requests] → [API Gateway]
                      ├── /documents/** → [Document Service]
                      ├── /credits/** → [Credit Service]
                      └── /workflows/** → [Workflow Service]
```

**Anti-Corruption Layer (ACL):** Khi new service cần data từ monolith, tạo một translation layer để không để domain model của monolith leak vào service mới.

```java
// ACL trong Document Service — translate legacy credit model
@Component
public class LegacyCreditAdapter {
    
    private final LegacyCreditClient legacyClient;
    
    // Legacy model có field names kiểu cũ → translate sang domain model mới
    public CreditAccount getLegacyCreditAccount(String contractId) {
        LegacyCreditDTO legacy = legacyClient.fetchByContractId(contractId);
        return CreditAccount.builder()
            .accountId(legacy.getSO_TK())         // "SO_TK" → accountId
            .balance(legacy.getDU_NO())            // "DU_NO" → balance
            .customerId(legacy.getMa_KH())         // "Ma_KH" → customerId
            .build();
    }
}
```

---

### Service per Container

**Container = đơn vị deploy chuẩn của microservices:**

```dockerfile
# Dockerfile cho Document Service
FROM eclipse-temurin:21-jre-alpine

WORKDIR /app
COPY target/document-service.jar app.jar

# Health check built-in
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD wget -q --spider http://localhost:8080/actuator/health || exit 1

EXPOSE 8080
ENTRYPOINT ["java", \
    "-XX:+UseContainerSupport", \
    "-XX:MaxRAMPercentage=75.0", \
    "-Djava.security.egd=file:/dev/./urandom", \
    "-jar", "app.jar"]
```

```yaml
# K8s Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: document-service
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: document-service
        image: pdms/document-service:1.2.0
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
        readinessProbe:
          httpGet:
            path: /actuator/health/readiness
            port: 8080
          initialDelaySeconds: 30
        livenessProbe:
          httpGet:
            path: /actuator/health/liveness
            port: 8080
```

---

### Microservice Chassis

Cross-cutting concerns không nên viết lại trong mỗi service:

```
Microservice Chassis (Spring Boot Starter nội bộ):
  ✅ Logging format chuẩn (JSON + traceId)
  ✅ Metrics endpoint (/actuator/prometheus)
  ✅ Health checks chuẩn
  ✅ Distributed tracing setup (OpenTelemetry)
  ✅ Security defaults (HTTPS, security headers)
  ✅ Externalized config pattern
  ✅ Graceful shutdown

→ Tất cả services đều extend chassis này
→ Thay đổi 1 chỗ, apply cho tất cả services
```

```java
// Internal Spring Boot Starter
@AutoConfiguration
public class PdmsChassisAutoConfiguration {
    
    @Bean
    @ConditionalOnMissingBean
    public PdmsTracing pdmsTracing(Tracer tracer) {
        return new PdmsTracing(tracer);
    }
    
    @Bean
    public MeterRegistryCustomizer<MeterRegistry> metricsCommonTags(
            @Value("${spring.application.name}") String appName) {
        return registry -> registry.config()
            .commonTags("application", appName, "team", "pdms");
    }
}
```

---

## 🏦 PDMS Migration Strategy (Strangler Fig)

```
Hiện tại: Legacy credit system (monolith/stored procs)

Phase 1 (Q1): Document Service mới
  → Migrate document metadata ra khỏi monolith
  → Anti-corruption layer để đọc credit data từ legacy

Phase 2 (Q2): CQRS Read Models
  → Build search/query service mới từ events
  → Legacy vẫn là source of truth cho writes

Phase 3 (Q3): Credit Service
  → Migrate credit account management
  → Dual-write: write vào cả legacy và new service
  → Verify data consistency

Phase 4 (Q4): Decommission legacy
  → New services là source of truth
  → Legacy readonly → retired
```

---

## 🔗 Liên kết
- [[00-Hub-Microservices-Patterns]] — Hub
- [[Database-per-Service]] — Prerequisite của decomposition đúng
- [[01-Data-Consistency]] — Sau khi decompose, cần handle data consistency

## 🔗 Deep-dive notes

- [[Strangler-Fig]] — Step-by-step migration, Anti-Corruption Layer, dual-write, CDC backfill
- [[Event-Sourcing]] — Aggregate pattern, event store schema, snapshot optimization
- [[Circuit-Breaker]] — Resilience4J config, bulkhead, monitoring
