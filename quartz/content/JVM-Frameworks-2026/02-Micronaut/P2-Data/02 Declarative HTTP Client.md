---
tags: [micronaut, http-client, declarative-client, feign]
created: 2026-04-12
status: active
week: 11
phase: P2-Data
framework: micronaut
---

# Declarative HTTP Client

## 📌 One-liner
> `@Client` trong Micronaut generate HTTP client implementation **lúc compile** — giống OpenFeign của Spring Cloud, nhưng không cần runtime proxy, tốt hơn cho native image và startup time.

---

## 🆚 Spring Cloud Feign vs Micronaut @Client

| | OpenFeign (Spring) | Micronaut @Client |
|--|-------------------|------------------|
| Implementation | Runtime JDK proxy | Compile-time bytecode |
| Annotation | `@FeignClient` | `@Client` |
| Reactive | Via RxJava adapter | Native: Single/Flux/Publisher |
| Retry | `@Retryable` + config | `@Retryable` |
| Circuit breaker | Resilience4J integration | `@CircuitBreaker` built-in |
| Load balance | Ribbon (deprecated) | Micronaut LB built-in |
| Native image | Problematic | Works out of the box |

---

## 💻 Basic Declarative Client

```java
// Giống @FeignClient nhưng compile-time!
@Client("https://api.payment.vpbank.com")
public interface PaymentClient {

    @Post("/v1/charge")
    Single<PaymentResponse> charge(@Body ChargeRequest request);

    @Get("/v1/status/{id}")
    Maybe<PaymentStatus> getStatus(@PathVariable String id);

    @Delete("/v1/payment/{id}")
    Completable cancel(@PathVariable String id);

    @Get("/v1/payments{?page,size}")
    Single<List<PaymentResponse>> listPayments(
        @QueryValue int page,
        @QueryValue int size
    );
}

// Inject và dùng bình thường
@Singleton
public class OrderService {

    private final PaymentClient paymentClient;

    public OrderService(PaymentClient paymentClient) {
        this.paymentClient = paymentClient;
    }

    public void processPayment(Order order) {
        paymentClient.charge(new ChargeRequest(order))
            .subscribe(response -> log.info("Charged: {}", response),
                       error -> log.error("Charge failed", error));
    }
}
```

---

## 🔧 Service Discovery Integration

```java
// Client với service ID (lookup từ Consul/Eureka)
@Client(id = "payment-service")  // lookup "payment-service" từ registry
public interface PaymentClient { ... }

// application.yml
micronaut:
  http:
    services:
      payment-service:
        urls:
          - http://payment-1:8080
          - http://payment-2:8080
        # hoặc dùng service discovery
  consul:
    client:
      registration:
        enabled: true
      defaultZone: "${CONSUL_HOST:localhost}:${CONSUL_PORT:8500}"
```

---

## 🔧 Retry & Circuit Breaker

```java
@Client("https://api.external.com")
@Retryable(attempts = "3", delay = "500ms")      // retry 3 lần
public interface ExternalClient {

    @Get("/data")
    @CircuitBreaker(reset = "30s")               // CB reset sau 30s
    Single<ExternalData> fetchData();
}
```

---

## 🔧 Request/Response Filtering

```java
// Thêm header tự động (giống RequestInterceptor của Feign)
@Filter("/**")
public class AuthHeaderFilter implements HttpClientFilter {

    @Override
    public Publisher<? extends HttpResponse<?>> doFilter(
            MutableHttpRequest<?> request,
            ClientFilterChain chain) {

        return chain.proceed(
            request.header("X-API-Key", "vpbank-secret")
                   .header("X-Service", "pdms")
        );
    }
}

// Hoặc chỉ filter cho specific client
@Client(value = "https://api.payment.com", filter = PaymentFilter.class)
public interface PaymentClient { ... }
```

---

## 🔧 Error Handling

```java
@Client("https://api.payment.com")
public interface PaymentClient {

    @Get("/status/{id}")
    @Error(status = HttpStatus.NOT_FOUND)
    Maybe<PaymentStatus> getStatus(@PathVariable String id);
}

// Custom error decoder
@Singleton
public class PaymentErrorDecoder implements HttpClientResponseExceptionDecoder {
    @Override
    public Throwable decode(HttpRequest<?> request, HttpResponse<?> response) {
        if (response.status() == HttpStatus.NOT_FOUND) {
            return new PaymentNotFoundException("Payment not found");
        }
        return new PaymentServiceException("Service error: " + response.status());
    }
}
```

---

## ✅ Practice Checklist
- [ ] Tạo `@Client` interface gọi external REST API
- [ ] Thêm `@Retryable` và `@CircuitBreaker`
- [ ] Implement `HttpClientFilter` để inject auth header
- [ ] Test với `@MicronautTest` + WireMock

## 🔗 Liên quan
- [[01 Micronaut Data JPA]]
- [[../../01-Quarkus/P3-Reactive/03 SmallRye Kafka]]

## 📖 Nguồn
- https://docs.micronaut.io/latest/guide/#httpClient
