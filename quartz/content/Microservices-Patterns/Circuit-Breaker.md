---
tags: [microservices, patterns, circuit-breaker, resilience4j, reliability, cascade-failure]
up: "[[03-Reliability]]"
related: "[[03-Reliability]], [[02-Communication]], [[04-Observability]]"
---

# ⚡ Circuit Breaker

> **TL;DR:** Proxy bao quanh remote call. Tự động chuyển sang "OPEN" khi failure rate vượt ngưỡng — reject request ngay lập tức thay vì chờ timeout. Ngăn cascade failure lan rộng toàn hệ thống.

---

## 🎯 Problem: Cascade Failure

```
Scenario: Service C bị chậm đột ngột (latency 30s)

Không có Circuit Breaker:
  Request → Service A → Service B → Service C (block 30s)
                        ↑
                  Thread pool của B:
                  t=0s:  1 thread blocked chờ C
                  t=5s:  50 threads blocked
                  t=10s: 200 threads blocked — pool exhausted
                  t=15s: Service B không nhận request mới
                  t=20s: Service A cũng tắc → user thấy timeout
                  → Toàn bộ system sập vì C chậm

Có Circuit Breaker:
  Request → Service A → [Circuit Breaker] → Service C
  t=0s:   10 requests fail → CB chuyển OPEN
  t=5s:   CB reject ngay, return fallback → A nhận 503 ngay
  t=30s:  CB thử HALF-OPEN → C đã recover → CLOSED
  → Damage control, hệ thống còn sống
```

---

## 🔄 Ba trạng thái

```
                    failure rate > threshold
         CLOSED ────────────────────────────────► OPEN
           ▲                                        │
           │  test calls succeed                   wait
           │                                        │ (waitDurationInOpenState)
         HALF-OPEN ◄────────────────────────────────┘
           │
           │ test calls fail
           ▼
         OPEN (reset timer)
```

| State | Hành vi | Chuyển sang |
|---|---|---|
| **CLOSED** | Forward tất cả calls, đếm failure | OPEN nếu failure rate > threshold |
| **OPEN** | Reject ngay (throw CallNotPermittedException), return fallback | HALF-OPEN sau waitDuration |
| **HALF-OPEN** | Cho qua N calls để test | CLOSED nếu ok, OPEN nếu fail |

---

## 🏗️ Implementation với Resilience4J

### Dependency

```xml
<dependency>
    <groupId>io.github.resilience4j</groupId>
    <artifactId>resilience4j-spring-boot3</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-aop</artifactId>
</dependency>
```

### Configuration

```yaml
resilience4j:
  circuitbreaker:
    instances:
      # Config cho Credit Service — batch processing, tolerant of slowness
      creditService:
        slidingWindowType: COUNT_BASED        # hoặc TIME_BASED
        slidingWindowSize: 20                  # tính trên 20 requests gần nhất
        minimumNumberOfCalls: 5               # cần ít nhất 5 calls để tính %
        failureRateThreshold: 50              # 50% fail → OPEN
        slowCallDurationThreshold: 10s        # > 10s coi là slow (batch có thể chậm)
        slowCallRateThreshold: 80             # 80% slow → OPEN
        waitDurationInOpenState: 60s          # chờ 1 phút trước khi thử lại
        permittedNumberOfCallsInHalfOpenState: 3
        automaticTransitionFromOpenToHalfOpenEnabled: true
        recordExceptions:
          - java.io.IOException
          - java.net.SocketTimeoutException
          - feign.FeignException.ServiceUnavailable
        ignoreExceptions:
          - com.vpbank.exception.ValidationException  # Đừng count lỗi business logic

      # Config cho Document Service — user-facing, strict SLA
      documentService:
        slidingWindowSize: 10
        failureRateThreshold: 30              # Khắt khe hơn — 30% là OPEN
        slowCallDurationThreshold: 3s
        waitDurationInOpenState: 30s
        permittedNumberOfCallsInHalfOpenState: 5

  timelimiter:
    instances:
      creditService:
        timeoutDuration: 12s     # PHẢI > slowCallDurationThreshold
        cancelRunningFuture: true
      documentService:
        timeoutDuration: 5s
```

> **⚠️ PDMS gotcha đã gặp:** `timeoutDuration` trong TimeLimiter phải lớn hơn `slowCallDurationThreshold`. Nếu không, TimeLimiter ngắt kết nối trước khi Circuit Breaker có thể đánh giá là "slow call" → CB không bao giờ mở → request liên tục bị kill → user thấy 503.

### Service Client

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class CreditServiceClient {
    
    private final WebClient webClient;
    private final CreditCacheService cacheService;
    
    // ── Async với @CircuitBreaker + @TimeLimiter ──────────────────
    @CircuitBreaker(name = "creditService", fallbackMethod = "getCreditInfoFallback")
    @TimeLimiter(name = "creditService")
    @Retry(name = "creditService")
    public CompletableFuture<CreditInfo> getCreditInfo(String customerId) {
        return webClient.get()
            .uri("/internal/credits/{customerId}", customerId)
            .retrieve()
            .bodyToMono(CreditInfo.class)
            .toFuture();
    }
    
    // ── Sync với CircuitBreakerRegistry programmatic ──────────────
    // (Dùng khi cần control chi tiết hơn annotation)
    public CreditSummary getCreditSummary(String accountId) {
        CircuitBreaker cb = circuitBreakerRegistry.circuitBreaker("creditService");
        
        return cb.executeSupplier(() ->
            webClient.get()
                .uri("/internal/credits/{accountId}/summary", accountId)
                .retrieve()
                .bodyToMono(CreditSummary.class)
                .block(Duration.ofSeconds(5))
        );
    }
    
    // ── Fallback methods — signature phải match + thêm Throwable ──
    
    // Fallback 1: Return cached data nếu có
    private CompletableFuture<CreditInfo> getCreditInfoFallback(
            String customerId, Throwable ex) {
        
        log.warn("CB fallback for customer {}: {} - {}",
            customerId, ex.getClass().getSimpleName(), ex.getMessage());
        
        // Try cache first
        return cacheService.getCreditInfo(customerId)
            .map(CompletableFuture::completedFuture)
            .orElseGet(() -> CompletableFuture.completedFuture(
                CreditInfo.unavailable(customerId)  // graceful degradation
            ));
    }
    
    // Fallback 2: CallNotPermittedException — CB đang OPEN
    private CompletableFuture<CreditInfo> getCreditInfoFallback(
            String customerId, CallNotPermittedException ex) {
        
        log.warn("CB OPEN for creditService, customer: {}", customerId);
        // Metric cho alert
        meterRegistry.counter("cb.rejected", "service", "creditService").increment();
        
        return CompletableFuture.completedFuture(
            CreditInfo.serviceUnavailable(customerId)
        );
    }
}
```

### Retry Configuration

```yaml
resilience4j:
  retry:
    instances:
      creditService:
        maxAttempts: 3
        waitDuration: 500ms
        enableExponentialBackoff: true
        exponentialBackoffMultiplier: 2     # 500ms → 1000ms → 2000ms
        retryExceptions:
          - java.net.ConnectException
          - java.net.SocketTimeoutException
        ignoreExceptions:
          - com.vpbank.exception.BusinessException
          - com.vpbank.exception.ValidationException
          - feign.FeignException.BadRequest    # 4xx không retry
```

---

## 📊 Monitor Circuit Breaker State

### Expose metrics (Prometheus + Grafana)

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health, circuitbreakers, metrics, prometheus
  health:
    circuitbreakers:
      enabled: true
```

```java
// Đăng ký event listener để log state changes
@Component
@RequiredArgsConstructor
public class CircuitBreakerEventListener {
    
    private final CircuitBreakerRegistry registry;
    private final AlertService alertService;
    
    @PostConstruct
    public void registerListeners() {
        registry.getAllCircuitBreakers().forEach(cb -> {
            cb.getEventPublisher()
                .onStateTransition(event -> {
                    log.warn("Circuit Breaker '{}': {} → {}",
                        cb.getName(),
                        event.getStateTransition().getFromState(),
                        event.getStateTransition().getToState()
                    );
                    
                    // Alert khi OPEN
                    if (event.getStateTransition().getToState() == OPEN) {
                        alertService.sendAlert(
                            "Circuit Breaker OPEN: " + cb.getName(),
                            AlertSeverity.HIGH
                        );
                    }
                })
                .onFailureRateExceeded(event ->
                    log.warn("CB '{}' failure rate: {}%",
                        cb.getName(), event.getFailureRate())
                );
        });
    }
}
```

**Grafana dashboard queries:**
```promql
# Circuit Breaker state (0=CLOSED, 1=OPEN, 2=HALF_OPEN)
resilience4j_circuitbreaker_state{application="pdms-gateway"}

# Failure rate
resilience4j_circuitbreaker_failure_rate{name="creditService"}

# Số calls bị reject khi CB OPEN
rate(resilience4j_circuitbreaker_not_permitted_calls_total[5m])
```

---

## 🔧 Bulkhead — ngăn resource exhaustion

Circuit Breaker ngăn cascade failure. Bulkhead ngăn một service dùng hết resource của service gọi nó:

```yaml
resilience4j:
  bulkhead:
    instances:
      creditService:
        maxConcurrentCalls: 20    # Tối đa 20 concurrent calls tới Credit Service
        maxWaitDuration: 100ms    # Chờ tối đa 100ms nếu bulkhead full
```

```java
@Bulkhead(name = "creditService", type = Bulkhead.Type.SEMAPHORE)
@CircuitBreaker(name = "creditService", fallbackMethod = "fallback")
public CreditInfo getCreditInfo(String customerId) { ... }
```

**Khi nào dùng Bulkhead:** Khi một slow service có thể chiếm hết thread pool và làm nghẽn toàn bộ service gọi nó. Bulkhead + CircuitBreaker là combo lý tưởng.

---

## ⚖️ Tuning Guidelines

| Tình huống | Điều chỉnh |
|---|---|
| CB mở quá sớm (false positive) | Tăng `slidingWindowSize`, tăng `minimumNumberOfCalls` |
| CB không mở kịp (cascade xảy ra) | Giảm `failureRateThreshold`, giảm `waitDurationInOpenState` |
| Timeout liên tục dù service OK | Kiểm tra `timeoutDuration` > P99 latency của downstream |
| CB bounce (open/close liên tục) | Tăng `waitDurationInOpenState`, tăng `permittedNumberOfCallsInHalfOpenState` |
| User-facing SLA khắt khe | `failureRateThreshold: 20-30`, `slowCallDurationThreshold: 2-3s` |
| Background/batch job | `failureRateThreshold: 60-70`, `slowCallDurationThreshold: 30-60s` |

---

## 🏦 PDMS Circuit Breaker Topology

```
[Spring Cloud Gateway]
  ├── route: /api/documents/** 
  │     CB: documentService (threshold: 30%, timeout: 5s)
  │     fallback: 503 + Retry-After header
  │
  ├── route: /api/credits/**
  │     CB: creditService (threshold: 50%, timeout: 12s)
  │     fallback: 503 với cached response nếu có
  │
  └── route: /api/workflows/**
        CB: workflowService (threshold: 40%, timeout: 8s)

[DocumentService] → calls [CreditService]
  CB: creditServiceInternal (threshold: 50%, timeout: 10s)
  fallback: CreditInfo.unavailable() — document vẫn tạo được

[DocumentService] → calls [AuditService]  
  CB: auditService (threshold: 70%, timeout: 3s)
  fallback: queue audit event vào local retry queue
```

---

## 🔗 Liên kết
- [[03-Reliability]] — Reliability patterns group
- [[04-Observability]] — Monitor CB state với Prometheus/Grafana
- [[02-Communication]] — API Gateway tích hợp CB
- [[Transactional-Outbox]] — Dùng outbox làm retry queue cho CB fallback
