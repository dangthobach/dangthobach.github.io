---
tags: [microservices, patterns, reliability, circuit-breaker, resilience4j]
up: "[[00-Hub-Microservices-Patterns]]"
---

# 🛡️ 03 — Reliability Patterns

> **Core problem:** Trong distributed systems, failure là bình thường, không phải ngoại lệ. Câu hỏi không phải "liệu service có fail không" mà là "khi service fail, hệ thống còn lại có sống sót không?"

---

## 🧭 Cascade Failure — tại sao nguy hiểm

```
Scenario: Service C chậm (latency 10s thay vì 100ms)

Service A → gọi Service B → gọi Service C (10s timeout)
           
Service B đang dùng thread pool:
  - 1 request tới A = 1 thread B bị block 10s chờ C
  - 1000 concurrent requests → 1000 threads blocked
  - Thread pool exhausted → Service B không nhận request mới
  - Service A gọi B cũng timeout → A's threads blocked
  → Toàn bộ hệ thống sập vì Service C chậm
```

**Circuit Breaker ngăn điều này:** Khi C chậm/fail, B không chờ nữa — fail fast ngay lập tức.

---

## 🗂️ Patterns trong nhóm này

### [[Circuit-Breaker]]
Một câu: Proxy bao quanh remote calls — tự động "ngắt mạch" khi failure rate vượt ngưỡng, không chờ timeout.

**Ba trạng thái:**
```
CLOSED ──(failure rate > threshold)──► OPEN ──(wait period)──► HALF-OPEN
  ▲                                                                  │
  └──────────────(call succeeds)────────────────────────────────────┘
```

- **CLOSED:** Bình thường, mọi request đi qua. Đếm số lần fail.
- **OPEN:** Fail fast — reject ngay không gọi service downstream. Return fallback.
- **HALF-OPEN:** Thử N requests để kiểm tra service đã recover chưa. Nếu ok → CLOSED, nếu fail → OPEN lại.

**Resilience4J config:**
```yaml
resilience4j:
  circuitbreaker:
    instances:
      creditService:
        slidingWindowType: COUNT_BASED
        slidingWindowSize: 10          # Tính trên 10 requests gần nhất
        failureRateThreshold: 50       # 50% fail → OPEN
        waitDurationInOpenState: 30s   # Chờ 30s trước khi thử lại
        permittedNumberOfCallsInHalfOpenState: 3
        slowCallDurationThreshold: 3s  # Request > 3s cũng tính là "fail"
        slowCallRateThreshold: 80      # 80% slow calls → OPEN
  timelimiter:
    instances:
      creditService:
        timeoutDuration: 5s           # ← phải > max expected latency của service
```

**Spring Boot usage:**
```java
@Service
public class CreditServiceClient {
    
    @CircuitBreaker(name = "creditService", fallbackMethod = "getCreditFallback")
    @TimeLimiter(name = "creditService")
    public CompletableFuture<CreditInfo> getCreditInfo(String customerId) {
        return CompletableFuture.supplyAsync(() ->
            creditServiceRestClient.get(customerId)
        );
    }
    
    // Fallback khi circuit OPEN hoặc timeout
    public CompletableFuture<CreditInfo> getCreditFallback(
            String customerId, Exception ex) {
        log.warn("Circuit open for customer {}: {}", customerId, ex.getMessage());
        // Return cached data hoặc default
        return CompletableFuture.completedFuture(CreditInfo.unavailable(customerId));
    }
}
```

**⚠️ TimeLimiter gotcha (PDMS Spring Cloud Gateway issue):**
```
Nếu timeoutDuration = 2s nhưng service thực tế cần 3s để process
→ TimeLimiter ngắt sau 2s → Circuit Breaker đếm là failure
→ Sau 5 requests, circuit OPEN → 503 liên tục
→ Service thực ra đang hoạt động bình thường!

Fix: timeoutDuration phải > P99 latency của service downstream
```

---

### Service Discovery
Một câu: Services không biết địa chỉ IP cứng của nhau — query một registry để tìm healthy instances.

```
Client-side discovery (Eureka):
[Service A] → query [Eureka Registry] → nhận list of [Service B instances]
           → chọn instance (load balance) → gọi trực tiếp

Server-side discovery (Kubernetes):
[Service A] → gọi [K8s Service (DNS)] → K8s routing → [Service B pod]
           → không cần biết registry
```

**Trong Spring Boot (Client-side):**
```yaml
# Service B đăng ký với Eureka
eureka:
  client:
    serviceUrl:
      defaultZone: http://eureka-server:8761/eureka/
  instance:
    preferIpAddress: true
    healthCheckUrlPath: /actuator/health
```

```java
// Service A dùng service name thay vì IP
@LoadBalanced  // ← tự động resolve "document-service" sang IP thật
@Bean
public RestTemplate restTemplate() {
    return new RestTemplate();
}

// Gọi bằng tên service — Ribbon/Spring Cloud LoadBalancer handle
restTemplate.getForObject("http://document-service/api/documents/{id}", ...);
```

---

## 🔑 Defense in Depth

Không dùng Circuit Breaker một mình. Kết hợp nhiều lớp:

```
Request → [Rate Limiter] → [Timeout] → [Retry] → [Circuit Breaker] → Service
                                                         │
                                              fail fast  │
                                                    [Fallback / Cache]
```

```yaml
resilience4j:
  retry:
    instances:
      creditService:
        maxAttempts: 3
        waitDuration: 500ms
        retryExceptions:
          - java.net.ConnectException
          - java.net.SocketTimeoutException
        ignoreExceptions:
          - com.vpbank.exception.BusinessException  # Đừng retry lỗi business
```

---

## 🏦 PDMS Application

```
Spring Cloud Gateway bảo vệ tất cả services:
  → TimeLimiter: 10s (đủ cho batch operations)
  → CircuitBreaker: open nếu >50% fail trong 10 requests
  → Fallback: return 503 với message "Service temporarily unavailable"

Trong mỗi service:
  CreditServiceClient → CircuitBreaker("creditService")
    → fallback: return cached credit info từ Redis
    → log warning cho monitoring
```

---

## 🔗 Liên kết
- [[Circuit-Breaker]] — Deep dive
- [[02-Communication]] — API Gateway tích hợp Circuit Breaker
- [[04-Observability]] — Monitor circuit breaker state
