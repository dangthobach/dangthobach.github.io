# Jakarta EE 12 — Full Feature Learning Track

> **Mục tiêu:** Spring Boot expert → Jakarta EE architect, spec-first approach
> **Phiên bản:** Jakarta EE 12 (GA target H2 2026, JDK 21 minimum)
> **Runtime prototype:** Quarkus (best Jakarta EE implementation for learning)

---

## Tại sao học Jakarta EE theo hướng này?

```
Spring Boot Expert
       │
       ▼
  Biết "HOW" (Spring cách làm)
  Cần biết "WHAT SPEC" (chuẩn định nghĩa gì)
       │
       ▼
  Đọc Quarkus/Helidon doc không bị lạ
  Design vendor-neutral enterprise systems
  Architect decisions dựa trên spec, không vendor lock-in
```

---

## Cấu trúc 3 Profiles — Học theo thứ tự này

```
┌─────────────────────────────────────────┐
│           FULL PLATFORM                 │
│  JMS, JCA, EJB, Batch, Mail...         │
│  ┌───────────────────────────────────┐  │
│  │         WEB PROFILE               │  │
│  │  Servlet, Faces, WebSocket,       │  │
│  │  Security, Persistence...         │  │
│  │  ┌─────────────────────────────┐  │  │
│  │  │       CORE PROFILE          │  │  │
│  │  │  CDI + REST + JSON + Valid  │  │  │
│  │  │  ← Quarkus & Helidon dùng  │  │  │
│  │  └─────────────────────────────┘  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

---

## Curriculum Map

### Phase 1 — Core Profile (3 tuần)
| # | Spec | Version | Spring Equivalent | File |
|---|------|---------|-------------------|------|
| 01 | CDI — Contexts & Dependency Injection | 5.0 | Spring DI + AOP | [[01-CDI-Contexts-DI]] |
| 02 | Jakarta REST (JAX-RS) | 5.0 | Spring MVC / WebFlux | [[02-Jakarta-REST]] |
| 03 | Jakarta JSON-P + JSON-B | 2.2 / 3.x | Jackson | [[03-JSON-P-JSON-B]] |
| 04 | Jakarta Validation | 4.0 | Bean Validation (same!) | [[04-Bean-Validation]] |

### Phase 2 — Persistence & Data (3 tuần)
| # | Spec | Version | Spring Equivalent | File |
|---|------|---------|-------------------|------|
| 05 | Jakarta Persistence (JPA) | 4.0 | Spring Data JPA | [[05-JPA-Deep-Dive]] |
| 06 | Jakarta Transactions | 2.1 | @Transactional | [[06-Transactions]] |
| 07 | Jakarta Data ⭐ NEW in EE11 | 1.1 | Spring Data Repositories | [[07-Jakarta-Data]] |
| 08 | Jakarta Query ⭐ NEW in EE12 | 1.0 | JPQL / Spring Query | [[08-Jakarta-Query]] |
| 09 | Jakarta NoSQL ⭐ NEW in EE12 | 1.1 | Spring Data MongoDB/Redis | [[09-Jakarta-NoSQL]] |

### Phase 3 — Security & Concurrency (2 tuần)
| # | Spec | Version | Spring Equivalent | File |
|---|------|---------|-------------------|------|
| 10 | Jakarta Security | 4.x | Spring Security | [[10-Jakarta-Security]] |
| 11 | Jakarta Concurrency | 3.x | @Async + Virtual Threads | [[11-Jakarta-Concurrency]] |

### Phase 4 — Platform / Enterprise (2 tuần)
| # | Spec | Version | Spring Equivalent | File |
|---|------|---------|-------------------|------|
| 12 | Jakarta Messaging (JMS) | 3.x | Spring Kafka/RabbitMQ | [[12-Jakarta-Messaging]] |
| 13 | Jakarta Faces (JSF) | 5.0 | Thymeleaf / no equiv | [[13-Jakarta-Faces]] |
| 14 | Jakarta EJB (Legacy) | 4.x | @Service / @Transactional | [[14-Legacy-EJB]] |

### Phase 5 — Architect Synthesis (ongoing)
| # | Topic | File |
|---|-------|------|
| 15 | Profile Design Patterns | [[15-Profile-Design]] |
| 16 | Vendor-Neutral System Design | [[16-Vendor-Neutral-Design]] |
| 17 | Spring → Jakarta Migration Path | [[17-Spring-to-Jakarta-Migration]] |

---

## Setup Prototype Environment

Tất cả code example trong series này dùng **Quarkus** làm runtime — lý do:
- Implement Jakarta EE spec chính xác nhất
- Dev Mode với live reload
- Doc rõ ràng, annotation mapping 1:1 với spec

```bash
# Tạo project Quarkus để chạy prototype
mvn io.quarkus.platform:quarkus-maven-plugin:3.x.x:create \
    -DprojectGroupId=com.example \
    -DprojectArtifactId=jakarta-ee-lab \
    -Dextensions="rest,rest-jackson,hibernate-orm-panache,jdbc-postgresql,security-oidc"

cd jakarta-ee-lab
./mvnw quarkus:dev   # Dev mode — live reload
# Mở http://localhost:8080/q/dev-ui để xem Dev UI
```

---

## Cách đọc mỗi bài

Mỗi file được cấu trúc:
1. **Spec says** — trích dẫn định nghĩa chính thức
2. **Spring equivalent** — anh đã biết cái này
3. **Key differences** — điểm khác biệt quan trọng
4. **Prototype** — code chạy được trên Quarkus
5. **Architect notes** — khi nào dùng, trade-off

---

## Quick Reference

- Jakarta EE Specs: https://jakarta.ee/specifications/
- Quarkus Guides: https://quarkus.io/guides/
- Jakarta EE 12 Release Plan: https://jakartaee.github.io/platform/jakartaee12/
- Spec GitHub: https://github.com/jakartaee/

---

*Track: JVM-Frameworks-2026 | Phase: 05-Jakarta-EE-12*
*Last updated: 2026-05*
