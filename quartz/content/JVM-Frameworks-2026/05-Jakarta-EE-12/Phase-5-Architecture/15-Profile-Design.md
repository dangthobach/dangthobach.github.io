# 15 — Profile Design Patterns

> **Topic:** Chọn và thiết kế theo Jakarta EE Profile | **Phase:** Architect Synthesis
> **Mục tiêu:** Biết khi nào dùng Core / Web / Full Platform và tại sao

---

## 1. Ba Profile — Recap Visual

```
┌─────────────────────────────────────────────────────────────┐
│                     FULL PLATFORM                           │
│                                                             │
│  Jakarta Messaging (JMS)    Jakarta Batch                   │
│  Jakarta Connectors (JCA)   Jakarta Mail                    │
│  Jakarta EJB (Legacy)       Jakarta XML Web Services        │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                   WEB PROFILE                         │  │
│  │                                                       │  │
│  │  Jakarta Servlet     Jakarta Faces (JSF)              │  │
│  │  Jakarta WebSocket   Jakarta Security                 │  │
│  │  Jakarta Pages (JSP) Jakarta Persistence (JPA)        │  │
│  │  Jakarta Transactions Jakarta Data ⭐                  │  │
│  │  Jakarta Concurrency  Jakarta Query ⭐                  │  │
│  │  Jakarta NoSQL ⭐                                      │  │
│  │                                                       │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │               CORE PROFILE                      │  │  │
│  │  │                                                 │  │  │
│  │  │  Jakarta CDI 5.0        Jakarta REST 5.0        │  │  │
│  │  │  Jakarta JSON-P 2.2     Jakarta JSON-B 3.x      │  │  │
│  │  │  Jakarta Validation 4.0 Jakarta Interceptors    │  │  │
│  │  │  Jakarta Annotations    Jakarta Inject           │  │  │
│  │  │                                                 │  │  │
│  │  │  ← Quarkus, Helidon SE default                 │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Decision Framework — Chọn Profile

```
Câu hỏi 1: Service có cần database không?
  → Không → Core Profile đủ
  → Có    → Web Profile minimum

Câu hỏi 2: Service có cần UI (web pages) không?
  → Có JSF/Servlet → Web Profile
  → Chỉ REST API   → Core Profile + JPA extension

Câu hỏi 3: Service có cần JMS / legacy integration?
  → Có → Full Platform
  → Không → Web Profile đủ

Câu hỏi 4: Microservice hay Monolith?
  → Microservice → Core Profile per service
  → Monolith     → Web hoặc Full Platform
```

---

## 3. Microservice Pattern — Core Profile Only

```java
// Mỗi microservice chỉ dùng Core Profile
// → build nhanh, startup nhanh, memory thấp

// pdms-document-service (Core Profile)
@Path("/documents")
@ApplicationScoped
public class DocumentResource {
    @Inject DocumentService svc;
    // Chỉ dùng: CDI + REST + Validation + JSON-B
}

// pdms-auth-service (Core Profile)
@Path("/auth")
@ApplicationScoped
public class AuthResource {
    // Chỉ dùng: CDI + REST + JWT validation
}

// pdms-reporting-service (Web Profile — cần JPA)
@Path("/reports")
@ApplicationScoped
public class ReportResource {
    @PersistenceContext EntityManager em;
    // CDI + REST + JPA + Transactions
}
```

---

## 4. Profile per Service — Mixed Architecture

```yaml
# PDMS microservices → mỗi service chọn profile phù hợp

pdms-gateway:
  profile: Core Profile
  uses: CDI, REST, JSON-B
  no-db: true
  deps: Spring Cloud Gateway (thực tế)

pdms-document-service:
  profile: Web Profile
  uses: CDI, REST, JPA, Transactions, Data, Query, Security
  db: PostgreSQL

pdms-iam-service:
  profile: Core Profile  
  uses: CDI, REST, JWT, Security
  external-auth: Keycloak

pdms-audit-service:
  profile: Web Profile
  uses: CDI, REST, NoSQL (Jakarta NoSQL)
  db: MongoDB

pdms-notification-service:
  profile: Full Platform (nếu dùng JMS với IBM MQ)
  OR: Core Profile (nếu dùng Kafka/REST)
  uses: CDI, REST, Messaging
```

---

## 5. Portable Artifacts — Vendor-Neutral Design

```java
// === Design để portable across runtimes ===

// ✅ GOOD — chỉ dùng Jakarta spec annotations
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import jakarta.ws.rs.*;
import jakarta.persistence.*;
import jakarta.transaction.Transactional;
import jakarta.validation.Valid;

@ApplicationScoped
public class DocumentService {
    @Inject DocumentRepository repo;
    @Transactional
    public Document create(@Valid CreateRequest req) { ... }
}

// ❌ BAD — dùng Quarkus-specific
import io.quarkus.hibernate.orm.panache.PanacheRepository;
import io.quarkus.logging.Log;
// → Không portable sang WildFly hay Open Liberty

// ❌ BAD — dùng Spring-specific
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
// → Không portable sang Jakarta EE runtime
```

---

## 6. Packaging Strategy

### WAR — Web Profile
```xml
<!-- pom.xml — WAR packaging -->
<packaging>war</packaging>

<dependencies>
    <!-- Provided by runtime, không bundle vào WAR -->
    <dependency>
        <groupId>jakarta.platform</groupId>
        <artifactId>jakarta.jakartaee-web-api</artifactId>
        <version>12.0.0</version>
        <scope>provided</scope>
    </dependency>
</dependencies>
```

### Uber JAR — Microservice style (Quarkus/Micronaut)
```xml
<!-- Quarkus bundle runtime vào JAR -->
<packaging>jar</packaging>
<!-- quarkus-maven-plugin tạo target/quarkus-app/ -->
```

### Native Image — GraalVM
```bash
# Quarkus native build
./mvnw package -Pnative
# → target/pdms-document-service-runner (binary, no JVM)
```

---

## 7. EJB → CDI Migration Path (Legacy)

```
Legacy EJB System (Java EE 6/7)
         │
         ▼
Step 1: Thêm CDI beans bên cạnh EJB
         │ (CDI và EJB coexist trong Jakarta EE)
         ▼
Step 2: Extract business logic từ EJB → CDI @ApplicationScoped
         │
         ▼
Step 3: Thay @EJB injection → @Inject
         │
         ▼
Step 4: Thay @Stateless → @ApplicationScoped
         @Stateful → @SessionScoped
         @MessageDriven → @Incoming (Reactive Messaging)
         │
         ▼
Step 5: Remove EJB dependencies
         │
         ▼
Step 6: Optional: Migrate từ WildFly → Quarkus
```

---

## 8. Profile Compatibility Matrix

| Spec | Core | Web | Full |
|------|:----:|:---:|:----:|
| CDI 5.0 | ✅ | ✅ | ✅ |
| Jakarta REST 5.0 | ✅ | ✅ | ✅ |
| JSON-P / JSON-B | ✅ | ✅ | ✅ |
| Bean Validation | ✅ | ✅ | ✅ |
| Jakarta Persistence | ❌ | ✅ | ✅ |
| Jakarta Transactions | ❌ | ✅ | ✅ |
| Jakarta Data | ❌ | ✅ | ✅ |
| Jakarta Query | ❌ | ✅ | ✅ |
| Jakarta NoSQL | ❌ | ✅ | ✅ |
| Jakarta Security | ❌ | ✅ | ✅ |
| Jakarta Servlet | ❌ | ✅ | ✅ |
| Jakarta Faces | ❌ | ✅ | ✅ |
| Jakarta WebSocket | ❌ | ✅ | ✅ |
| Jakarta Concurrency | ❌ | ✅ | ✅ |
| Jakarta Messaging | ❌ | ❌ | ✅ |
| Jakarta EJB | ❌ | ❌ | ✅ |
| Jakarta Batch | ❌ | ❌ | ✅ |
| Jakarta Connectors | ❌ | ❌ | ✅ |
| Jakarta Mail | ❌ | ❌ | ✅ |

---

*[[14-Legacy-EJB]] | [[00-Overview]] | Next: [[16-Vendor-Neutral-Design]]*
