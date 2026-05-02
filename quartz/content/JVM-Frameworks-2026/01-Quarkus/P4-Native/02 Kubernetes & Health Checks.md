---
tags: [quarkus, kubernetes, health, observability]
created: 2026-04-12
status: active
week: 8
phase: P4-Native
framework: quarkus
---

# Kubernetes & Health Checks

## 📌 One-liner
> Quarkus tích hợp sẵn MicroProfile Health, Metrics (Micrometer), và tự generate Kubernetes manifests — không cần viết YAML thủ công, không cần Spring Cloud Kubernetes.

---

## 🔧 Health Checks

```java
// Liveness — app có đang chạy không? (K8s restart nếu fail)
@Liveness
@ApplicationScoped
public class AppLivenessCheck implements HealthCheck {
    @Override
    public HealthCheckResponse call() {
        return HealthCheckResponse.up("application-live");
    }
}

// Readiness — app có sẵn sàng nhận traffic không? (K8s remove khỏi load balancer)
@Readiness
@ApplicationScoped
public class DatabaseReadinessCheck implements HealthCheck {

    @Inject
    DataSource dataSource;

    @Override
    public HealthCheckResponse call() {
        try (Connection c = dataSource.getConnection()) {
            return HealthCheckResponse.builder()
                .name("database-ready")
                .up()
                .withData("jdbcUrl", c.getMetaData().getURL())
                .build();
        } catch (SQLException e) {
            return HealthCheckResponse.builder()
                .name("database-ready")
                .down()
                .withData("error", e.getMessage())
                .build();
        }
    }
}

// Startup — app khởi động xong chưa? (K8s đợi trước khi check liveness/readiness)
@Startup
@ApplicationScoped
public class StartupCheck implements HealthCheck {
    private volatile boolean ready = false;

    public void setReady() { this.ready = true; }

    @Override
    public HealthCheckResponse call() {
        return ready ? HealthCheckResponse.up("startup")
                     : HealthCheckResponse.down("startup");
    }
}
```

```properties
# Endpoints tự động
# GET /q/health       → all checks
# GET /q/health/live  → liveness
# GET /q/health/ready → readiness
```

---

## 🔧 Kubernetes Manifest Generation

```properties
# application.properties — Quarkus tự generate K8s YAML!
quarkus.kubernetes.namespace=pdms-prod
quarkus.kubernetes.labels.app=pdms-document-service
quarkus.kubernetes.labels.version=1.0.0

# Resources
quarkus.kubernetes.resources.requests.memory=128Mi
quarkus.kubernetes.resources.requests.cpu=250m
quarkus.kubernetes.resources.limits.memory=512Mi
quarkus.kubernetes.resources.limits.cpu=500m

# Replicas
quarkus.kubernetes.replicas=3

# Image
quarkus.container-image.group=vpbank
quarkus.container-image.name=pdms-document-service
quarkus.container-image.tag=1.0.0

# Service type
quarkus.kubernetes.service-type=ClusterIP
```

```bash
# Build → generate manifest → apply
./mvnw package -Dquarkus.kubernetes.deploy=true
# Hoặc generate manifest trước, review, rồi apply
./mvnw package
kubectl apply -f target/kubernetes/kubernetes.yml
```

---

## 📊 Metrics với Micrometer

```java
@ApplicationScoped
public class DocumentService {

    @Inject
    MeterRegistry registry;

    private Counter createCounter;
    private Timer processTimer;

    @PostConstruct
    void init() {
        createCounter = registry.counter("document.created.total",
            "service", "pdms");
        processTimer = registry.timer("document.process.duration",
            "service", "pdms");
    }

    @Transactional
    public Document create(CreateDocRequest req) {
        return processTimer.record(() -> {
            Document doc = saveDocument(req);
            createCounter.increment();
            return doc;
        });
    }
}
```

```properties
# Expose Prometheus endpoint
quarkus.micrometer.export.prometheus.enabled=true
# GET /q/metrics → Prometheus format
```

---

## 🔧 Fault Tolerance — @Retry @CircuitBreaker @Timeout

```java
@ApplicationScoped
public class ExternalPaymentService {

    // Retry: thử lại 3 lần với delay 200ms
    @Retry(maxRetries = 3, delay = 200, delayUnit = ChronoUnit.MILLIS,
           retryOn = {IOException.class, TimeoutException.class})
    // Circuit Breaker: mở sau 5 failures trong 10 requests
    @CircuitBreaker(requestVolumeThreshold = 10,
                    failureRatio = 0.5,
                    delay = 5000)
    // Timeout: fail nếu quá 2 giây
    @Timeout(2000)
    // Fallback khi tất cả fail
    @Fallback(fallbackMethod = "paymentFallback")
    public PaymentResult charge(ChargeRequest req) throws Exception {
        return externalApi.charge(req);
    }

    private PaymentResult paymentFallback(ChargeRequest req) {
        log.warn("Payment service unavailable, using fallback");
        return PaymentResult.pending(req.orderId());
    }
}
```

---

## ✅ Practice Checklist
- [ ] Implement Liveness + Readiness health checks
- [ ] Thêm DB health check tự động (extension tự lo)
- [ ] Build và generate K8s manifests
- [ ] Expose Prometheus metrics, xem tại `/q/metrics`
- [ ] Apply `@Retry` + `@CircuitBreaker` cho external service call

## 🔗 Liên quan
- [[01 GraalVM Native Image]]
- [[MOC-Distributed-Systems]]

## 📖 Nguồn
- https://quarkus.io/guides/microprofile-health
- https://quarkus.io/guides/kubernetes
