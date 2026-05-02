---
tags: [learning-tracker, jvm-frameworks, weekly-review]
created: 2026-04-12
status: active
---

# 📅 JVM Frameworks — Weekly Study Log

> Ghi chép tiến độ học hàng tuần. Mỗi tuần = 1 entry.

---

## 🎯 Mục tiêu & Timeline

| Mốc | Ngày | Status |
|-----|------|--------|
| Bắt đầu | 14/04/2026 | ✅ |
| Quarkus Foundation xong | 28/04/2026 | ⏳ |
| Quarkus hoàn thành | 09/06/2026 | ⏳ |
| Micronaut hoàn thành | 30/06/2026 | ⏳ |
| Vert.x hoàn thành | 21/07/2026 | ⏳ |
| RxJava hoàn thành | 11/08/2026 | ⏳ |

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

**Điểm khác với Spring Boot:**
> _So sánh cụ thể_

---

### 🗓️ Tuần 2 — 21/04 → 27/04/2026

**Focus:** Quarkus P1 cont. — Testing, Dev Mode deep dive

**Đã hoàn thành:**
- [ ] Quarkus testing: @QuarkusTest, @QuarkusIntegrationTest
- [ ] Dev Services exploration
- [ ] Code review: mini project tuần 1

**Thời gian học:** ___ giờ / 5 giờ target

**Aha moments:**
> 

**Còn băn khoăn:**
> 

---

### 🗓️ Tuần 3 — 28/04 → 04/05/2026

**Focus:** Quarkus P2 — Panache Active Record

**Đã hoàn thành:**
- [ ] [[01-Quarkus/P2-Data/01 Panache Active Record]]
- [ ] [[01-Quarkus/P2-Data/02 Panache Repository Pattern]]
- [ ] Mini project: PDMS HopDong entity với Panache

**Thời gian học:** ___ giờ / 5 giờ target

**Aha moments:**
> 

**Còn băn khoăn:**
> 

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
- [ ] [[02-Micronaut/P3-Reactive/01 Micronaut Kafka]]
- [ ] [[02-Micronaut/P3-Reactive/02 Compile-time AOP]]

**Thời gian học:** ___ giờ / 10 giờ target

---

### 🗓️ Tuần 15-20 — Vert.x

> _Entries sẽ được thêm vào khi đến giai đoạn này_

---

### 🗓️ Tuần 21-24 — RxJava

> _Entries sẽ được thêm vào khi đến giai đoạn này_

---

## 🏆 Milestones & Reflections

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
- [[MOC-JVM-Frameworks]] — Master map
- [[_moc/MOC-Java]] — Spring Boot foundation
