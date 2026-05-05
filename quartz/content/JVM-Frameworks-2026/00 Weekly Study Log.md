---
tags: [learning-tracker, jvm-frameworks, weekly-review]
created: 2026-04-12
updated: 2026-05
status: active
---

# 📅 JVM Frameworks — Weekly Study Log

> Ghi chép tiến độ học hàng tuần. Mỗi tuần = 1 entry.

---

## 🎯 Mục tiêu & Timeline

| Mốc | Ngày | Status |
|-----|------|--------|
| Bắt đầu | 14/04/2026 | ✅ |
| Jakarta EE 12 Series hoàn thành | 05/05/2026 | ✅ |
| Quarkus Foundation xong | 28/04/2026 | ⏳ |
| Quarkus hoàn thành | 09/06/2026 | ⏳ |
| Micronaut hoàn thành | 30/06/2026 | ⏳ |
| Vert.x hoàn thành | 21/07/2026 | ⏳ |
| RxJava hoàn thành | 11/08/2026 | ⏳ |

---

## 📚 Nội dung đã có trong Vault

### Java 2026 Ecosystem
- [[Java-2026-Trends]] — JDK 26, Valhalla, Loom, Spring Boot 4, Jakarta EE 12
- [[Framework-Landscape-2026]] — Spring, Quarkus, Micronaut, Helidon, Jakarta EE roles
- [[Helidon-2026]] — Oracle JVP, Helidon 4.4, SE vs MP
- [[MicroProfile-2026-Status]] — Spec status, what's deprecated, what's strong

### Jakarta EE 12 Full Series (17 files)
- [[05-Jakarta-EE-12/00-Overview]] — Curriculum map, 5 phases
- [[05-Jakarta-EE-12/Spring-to-Jakarta-EE-Cheatsheet]] — Quick reference
- [[05-Jakarta-EE-12/CDI-vs-Spring-IoC-Thread-Deep-Dive]] — Deep dive với diagram

**Phase 1 — Core Profile:**
- [[05-Jakarta-EE-12/Phase-1-Core-Profile/01-CDI-Contexts-DI]]
- [[05-Jakarta-EE-12/Phase-1-Core-Profile/02-Jakarta-REST]]
- [[05-Jakarta-EE-12/Phase-1-Core-Profile/03-JSON-P-JSON-B]]
- [[05-Jakarta-EE-12/Phase-1-Core-Profile/04-Bean-Validation]]

**Phase 2 — Persistence & Data:**
- [[05-Jakarta-EE-12/Phase-2-Persistence-Data/05-JPA-Deep-Dive]]
- [[05-Jakarta-EE-12/Phase-2-Persistence-Data/06-Transactions]]
- [[05-Jakarta-EE-12/Phase-2-Persistence-Data/07-Jakarta-Data]]
- [[05-Jakarta-EE-12/Phase-2-Persistence-Data/08-Jakarta-Query]]
- [[05-Jakarta-EE-12/Phase-2-Persistence-Data/09-Jakarta-NoSQL]]

**Phase 3 — Security & Concurrency:**
- [[05-Jakarta-EE-12/Phase-3-Security-Concurrency/10-Jakarta-Security]]
- [[05-Jakarta-EE-12/Phase-3-Security-Concurrency/11-Jakarta-Concurrency]]

**Phase 4 — Platform:**
- [[05-Jakarta-EE-12/Phase-4-Platform/12-Jakarta-Messaging]]
- [[05-Jakarta-EE-12/Phase-4-Platform/13-Jakarta-Faces]]
- [[05-Jakarta-EE-12/Phase-4-Platform/14-Legacy-EJB]]

**Phase 5 — Architecture:**
- [[05-Jakarta-EE-12/Phase-5-Architecture/15-Profile-Design]]
- [[05-Jakarta-EE-12/Phase-5-Architecture/16-Vendor-Neutral-Design]]
- [[05-Jakarta-EE-12/Phase-5-Architecture/17-Spring-to-Jakarta-Migration]]

---

## 📊 Tổng tiến độ

```dataview
TABLE framework, status, week
FROM "JVM-Frameworks-2026"
WHERE status = "active"
SORT week ASC
```

---

## 📝 Weekly Entries

---

### 🗓️ Tuần 0 — 28/04 → 05/05/2026 (bonus sprint)

**Focus:** Jakarta EE 12 Full Series — Spec-first approach

**Đã hoàn thành:**
- [x] Java 2026 trends research
- [x] Framework landscape analysis (Spring vs Quarkus vs Micronaut vs Helidon)
- [x] Helidon 2026 deep dive — JVP, Oracle strategy
- [x] MicroProfile 2026 status — what's deprecated, what's strong
- [x] Jakarta EE 12 — 17-file series (Phase 1-5)
- [x] CDI vs Spring IoC — proxy model, thread context propagation
- [x] Spring → Jakarta EE migration cheatsheet

**Thời gian học:** ~15 giờ (intensive sprint)

**Aha moments:**
> - CDI LUÔN dùng proxy (scoped beans) — Spring chỉ khi có AOP. Đây là tại sao self-invocation không phải vấn đề trong CDI.
> - Spring @Async mất SecurityContext, MDC, RequestScope theo mặc định. CDI ManagedExecutorService propagate tất cả tự động. Critical cho banking context.
> - Jakarta EE là SPEC, không phải framework. Quarkus implement spec bên dưới. Khi Quarkus hot, thực ra là Jakarta EE ecosystem đang hot.
> - MicroProfile đang mất territory cho OpenTelemetry (thay MP OpenTracing, MP Metrics). Đây là healthy evolution.
> - Helidon = "Oracle's Quarkus" — chiến lược với Java Verified Portfolio để đối đầu Red Hat.

**Key mappings learned:**
> - `@Classpath scan` → `Bean discovery`
> - `@Service singleton` → `@ApplicationScoped` (via proxy)
> - `@Async` → `@Asynchronous` (CDI, auto context propagate)
> - `JpaRepository` → `@Repository` (Jakarta Data, 1-based pagination!)
> - `@PreAuthorize(SpEL)` → `@RolesAllowed(String[])` (less flexible)
> - `Pageable(0-based)` → `PageRequest(1-based)` ⚠ off-by-one!

**Còn cần explore:**
> - Hands-on prototype Quarkus dev mode
> - Jakarta Data cursor pagination với PDMS 10M+ records
> - Quarkus OIDC + Keycloak integration (so sánh với Spring Security)

---

### 🗓️ Tuần 1 — 14/04 → 20/04/2026

**Focus:** Quarkus P1 — Foundation (CDI, JAX-RS)

**Đã hoàn thành:**
- [ ] [[01-Quarkus/P1-Foundation/01 CDI vs Spring IoC]]
- [ ] [[01-Quarkus/P1-Foundation/02 JAX-RS vs Spring MVC]]
- [ ] [[01-Quarkus/P1-Foundation/03 Config & Dev Mode]]
- [ ] Mini project: Tái implement 1 PDMS endpoint

**Thời gian học:** ___ giờ / 5 giờ target

**Aha moments:**
> _Ghi lại insights quan trọng nhất trong tuần_

**Còn băn khoăn:**
> _Ghi lại những gì chưa rõ_

---

### 🗓️ Tuần 2 — 21/04 → 27/04/2026

**Focus:** Quarkus P1 cont. — Testing, Dev Mode deep dive

**Đã hoàn thành:**
- [ ] Quarkus testing: @QuarkusTest, @QuarkusIntegrationTest
- [ ] Dev Services exploration
- [ ] Code review: mini project tuần 1

**Thời gian học:** ___ giờ / 5 giờ target

---

### 🗓️ Tuần 3 — 28/04 → 04/05/2026

**Focus:** Quarkus P2 — Panache Active Record

**Đã hoàn thành:**
- [ ] [[01-Quarkus/P2-Data/01 Panache Active Record]]
- [ ] [[01-Quarkus/P2-Data/02 Panache Repository Pattern]]
- [ ] Mini project: PDMS HopDong entity với Panache

**Thời gian học:** ___ giờ / 5 giờ target

---

### 🗓️ Tuần 4 — 05/05 → 11/05/2026

**Focus:** Quarkus P2 — Transactions, REST Client

**Đã hoàn thành:**
- [ ] [[01-Quarkus/P2-Data/03 Quarkus Transactions]]
- [ ] MicroProfile REST Client
- [ ] Unit testing với mock repos

**Thời gian học:** ___ giờ / 5 giờ target

---

### 🗓️ Tuần 5 — 12/05 → 18/05/2026

**Focus:** Quarkus P3 — Mutiny Reactive

**Đã hoàn thành:**
- [ ] [[01-Quarkus/P3-Reactive/01 Mutiny - Uni và Multi]]
- [ ] Convert 2 blocking endpoints sang Uni<T>
- [ ] So sánh Mutiny vs Reactor hands-on

**Thời gian học:** ___ giờ / 5 giờ target

---

### 🗓️ Tuần 6 — 19/05 → 25/05/2026

**Focus:** Quarkus P3 — RESTEasy Reactive & SmallRye Kafka

**Đã hoàn thành:**
- [ ] [[01-Quarkus/P3-Reactive/03 SmallRye Kafka]]
- [ ] Kafka consumer/producer với @Incoming/@Outgoing
- [ ] Transactional Outbox pattern demo

**Thời gian học:** ___ giờ / 5 giờ target

---

### 🗓️ Tuần 7-8 — 26/05 → 08/06/2026

**Focus:** Quarkus P4 — Native & Kubernetes

**Đã hoàn thành:**
- [ ] [[01-Quarkus/P4-Native/01 GraalVM Native Image]]
- [ ] [[01-Quarkus/P4-Native/02 Kubernetes & Health Checks]]
- [ ] Build native binary, measure startup vs JVM
- [ ] K8s manifest generation

**Thời gian học:** ___ giờ / 10 giờ target

---

### 🗓️ Tuần 9-10 — 09/06 → 22/06/2026

**Focus:** Micronaut P1 — Core DI & HTTP

**Đã hoàn thành:**
- [ ] [[02-Micronaut/P1-Core/01 Compile-time DI vs Runtime DI]]
- [ ] [[02-Micronaut/P1-Core/02 Controller và HTTP Layer]]
- [ ] So sánh @MicronautTest speed vs @SpringBootTest

**Thời gian học:** ___ giờ / 10 giờ target

---

### 🗓️ Tuần 11-12 — 23/06 → 06/07/2026

**Focus:** Micronaut P2 — Data & HTTP Client

**Đã hoàn thành:**
- [ ] [[02-Micronaut/P2-Data/01 Micronaut Data JPA]]
- [ ] [[02-Micronaut/P2-Data/02 Declarative HTTP Client]]

**Thời gian học:** ___ giờ / 10 giờ target

---

### 🗓️ Tuần 13-14 — 07/07 → 20/07/2026

**Focus:** Micronaut P3 — Kafka & AOP

**Đã hoàn thành:**
- [ ] [[02-Micronaut/P2-Data/01 Micronaut Data JPA]]
- [ ] [[02-Micronaut/P3-Reactive/02 Compile-time AOP]]

**Thời gian học:** ___ giờ / 10 giờ target

---

## 🏆 Milestones & Reflections

### ✅ Sau Jakarta EE 12 Sprint (05/05/2026)
Jakarta EE là spec ecosystem, không phải framework alternative. Spring Boot và Jakarta EE không cạnh tranh trực tiếp — Quarkus implement Jakarta EE spec trong khi cung cấp developer experience tương tự Spring Boot. CDI proxy model giải quyết elegantly các vấn đề mà Spring vẫn cần workaround (scope mismatch, self-invocation). Thread context propagation là điểm thực tế nhất để cân nhắc khi chọn runtime cho banking service.

### Sau Quarkus (tuần 8)
> _So sánh với Spring Boot: gì tốt hơn, gì phức tạp hơn, khi nào dùng cho PDMS?_

### Sau Micronaut (tuần 14)
> _So sánh Quarkus vs Micronaut: chọn cái nào cho project mới?_

### Sau Vert.x (tuần 20)
> _Event-driven programming có phù hợp với PDMS workload không?_

### Sau RxJava (tuần 24)
> _Khi nào dùng RxJava vs Reactor trong production?_

---

## 🔗 Liên quan
- [[Framework-Decision-Matrix]] — so sánh framework
- [[ADR-001-Why-Quarkus-Over-Micronaut]] — decision record
- [[Spring-to-Quarkus-Cheatsheet]] — annotation mapping
- [[_moc/MOC-Java]] — Spring Boot foundation
