---
tags: [quarkus, config, dev-mode, profiles]
created: 2026-04-12
status: active
week: 2
phase: P1-Foundation
framework: quarkus
---

# Config & Dev Mode

## 📌 One-liner
> Quarkus dùng `application.properties` với `@ConfigProperty` inject — không có YAML mặc định như Spring, nhưng hỗ trợ profiles kiểu `%dev.`, `%prod.` ngay trong cùng 1 file. Dev Mode là tính năng killer: live reload không cần restart.

---

## 🆚 Configuration Comparison

| | Spring Boot | Quarkus |
|--|-------------|---------|
| File mặc định | `application.yml` / `.properties` | `application.properties` |
| YAML support | Built-in | Extension `quarkus-config-yaml` |
| Inject value | `@Value("${key}")` | `@ConfigProperty(name = "key")` |
| Config class | `@ConfigurationProperties` | `@ConfigMapping` |
| Profiles | `application-dev.yml` (file riêng) | `%dev.key=value` (cùng file!) |
| Runtime override | `-Dkey=value` | `-Dkey=value` (giống) |
| Env var | `MY_APP_PORT=8080` | `MY_APP_PORT=8080` (giống) |

---

## 💻 @ConfigProperty — Inject Config

```java
@ApplicationScoped
public class DatabaseConfig {

    // Required — app lỗi ngay nếu không có trong properties
    @ConfigProperty(name = "db.host")
    String dbHost;

    // Optional với default value
    @ConfigProperty(name = "db.port", defaultValue = "5432")
    int dbPort;

    // Optional — trả về Optional.empty() nếu không có
    @ConfigProperty(name = "db.schema")
    Optional<String> dbSchema;

    // List values: db.allowed-hosts=host1,host2,host3
    @ConfigProperty(name = "db.allowed-hosts")
    List<String> allowedHosts;
}
```

---

## 💻 @ConfigMapping — Config Class (giống @ConfigurationProperties)

```java
// application.properties:
// app.payment.url=https://payment.api.vp.com
// app.payment.timeout=30
// app.payment.retry-attempts=3

@ConfigMapping(prefix = "app.payment")
public interface PaymentConfig {
    String url();
    int timeout();
    int retryAttempts();  // kebab-case → camelCase tự động
}

// Inject và dùng
@ApplicationScoped
public class PaymentService {
    @Inject
    PaymentConfig config;

    public void call() {
        // config.url(), config.timeout(), config.retryAttempts()
    }
}
```

---

## 🔧 Profiles — Tất cả trong 1 file

```properties
# application.properties — KHÔNG có file riêng cho từng env

# === SHARED (tất cả envs) ===
app.name=PDMS Service
quarkus.http.port=8080

# === DEV profile (%dev.) ===
%dev.quarkus.datasource.db-kind=postgresql
%dev.quarkus.datasource.username=dev_user
%dev.quarkus.datasource.password=dev_pass
%dev.quarkus.datasource.jdbc.url=jdbc:postgresql://localhost:5432/pdms_dev
%dev.quarkus.log.level=DEBUG

# === PROD profile (%prod.) ===
%prod.quarkus.datasource.jdbc.url=${DATABASE_URL}
%prod.quarkus.datasource.username=${DB_USER}
%prod.quarkus.datasource.password=${DB_PASS}
%prod.quarkus.log.level=INFO

# === TEST profile (%test.) ===
%test.quarkus.datasource.db-kind=h2  # hoặc Dev Services dùng TestContainers
```

```bash
# Chọn profile khi chạy
./mvnw quarkus:dev                              # → %dev profile
./mvnw package && java -jar app.jar            # → %prod profile
./mvnw test                                    # → %test profile
java -Dquarkus.profile=staging -jar app.jar   # → custom profile
```

---

## ⚡ Dev Mode — Killer Feature

```bash
./mvnw quarkus:dev
```

### Những gì Dev Mode làm tự động:

| Feature | Mô tả |
|---------|-------|
| **Live Reload** | Sửa code → save → test ngay, không restart |
| **Dev Services** | Tự spin Docker: PostgreSQL, Kafka, Redis, Keycloak |
| **Dev UI** | `localhost:8080/q/dev` — xem beans, endpoints, DB |
| **Continuous Testing** | Test chạy tự động khi code thay đổi |
| **Remote Dev** | Live reload trên remote container/K8s |

### Dev UI tại `localhost:8080/q/dev/`

```
📦 Arc (DI)          → Xem toàn bộ bean graph, dependencies
🗄️ Hibernate ORM     → Xem entities, queries đang chạy
📡 SmallRye Kafka    → Xem topics, consumer lag
🔒 SmallRye JWT      → Decode JWT token
📊 Metrics          → Micrometer metrics
📖 Swagger UI       → `localhost:8080/q/swagger-ui`
```

> [!tip] Dev Services = Zero Config cho development
> ```properties
> # Chỉ cần declare extension — Quarkus tự spin Docker container!
> quarkus.datasource.db-kind=postgresql
> # Không cần url, user, password trong %dev → Dev Services lo hết
> ```
> Tắt nếu không muốn: `quarkus.devservices.enabled=false`

---

## 🔧 Env Variables & Secrets

```properties
# Override bằng env var (uppercase, dot → underscore)
# app.payment.url → APP_PAYMENT_URL
APP_PAYMENT_URL=https://prod.payment.api.com

# Kubernetes Secret → Env var → Config Property
# Trong K8s deployment.yaml:
# env:
#   - name: DB_PASSWORD
#     valueFrom:
#       secretKeyRef:
#         name: db-secret
#         key: password
```

---

## ✅ Practice Checklist
- [ ] Tạo `PaymentConfig` với `@ConfigMapping`
- [ ] Setup %dev, %prod profiles cho datasource
- [ ] Chạy `quarkus:dev`, khám phá Dev UI
- [ ] Thử sửa code → quan sát live reload < 1 giây
- [ ] Bật Dev Services PostgreSQL (không cần Docker Compose manual)

## 🔗 Liên quan
- [[01 CDI vs Spring IoC]]
- [[02 JAX-RS vs Spring MVC]]

## 📖 Nguồn
- https://quarkus.io/guides/config
- https://quarkus.io/guides/dev-mode-differences
