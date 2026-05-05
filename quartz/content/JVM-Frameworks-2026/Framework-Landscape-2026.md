# Java Framework Landscape 2026

> **Cập nhật:** 2026-05 | **Scope:** Spring Boot, Quarkus, Micronaut, Helidon, Jakarta EE, MicroProfile
> **Tags:** framework, spring-boot, quarkus, micronaut, helidon, jakarta-ee, microprofile

---

## Bức Tranh Tổng Thể — Roles Không Cạnh Tranh Nhau

```
Jakarta EE    = SPECIFICATION (chuẩn)
                → CDI, JAX-RS, JPA, Data, Security...
                → Vendors implement

MicroProfile  = SPECIFICATION (microservices extension)
                → Config, Fault Tolerance, Health, JWT, OpenAPI...
                → Built ON TOP OF Jakarta EE

Spring Boot   = FRAMEWORK (không implement Jakarta EE)
                → Ecosystem riêng, alternative approach
                → Vay mượn concept nhưng không follow spec

Quarkus       = RUNTIME (implement Jakarta EE + MicroProfile)
                → "Jakarta EE for cloud-native"
                → Red Hat backed

Helidon       = RUNTIME (implement Jakarta EE + MicroProfile)
                → Oracle backed
                → JVP certified

Micronaut     = FRAMEWORK (CDI-compatible, không full Jakarta EE)
                → AOT compilation pioneer
                → Object Computing backed
```

---

## 1. Spring Boot — Vẫn Dominant

**Thị phần 2026:** Vẫn là lựa chọn số 1 về job market và adoption.

**Spring Boot 4.0 (11/2025):**
- JDK 21 minimum
- JSpecify null-safety
- API versioning native
- Spring Framework 7.0 baseline

**Ưu điểm:**
- Ecosystem khổng lồ — Data, Security, Cloud, Batch, AI
- Team familiarity cao
- Auto-configuration giảm boilerplate
- Actuator, test support phong phú

**Nhược điểm:**
- Không TCK certified (vendor lock-in Broadcom)
- Startup chậm hơn Quarkus (dù đang cải thiện với AOT)
- License risk sau Broadcom acquisition

**Verdict cho PDMS:** Tiếp tục dùng Spring Boot — không có lý do migrate ngay.

---

## 2. Quarkus — Cloud-Native Leader

**Backed by:** Red Hat (IBM)
**Implements:** Jakarta EE Core Profile + MicroProfile

**2026 highlights:**
- Build-time optimization (ArC CDI, Hibernate ORM, REST)
- Dev Mode với live reload + Dev UI
- Native image với GraalVM
- @RunOnVirtualThread cho blocking endpoints

**Performance comparison (JDK 25, JVM mode):**

| Framework | Startup | Memory (idle) |
|---|---|---|
| Spring Boot 3.x | ~1.9s | ~250MB |
| Quarkus (JVM) | ~0.8s | ~150MB |
| Quarkus (Native) | ~0.02s | ~50MB |
| Micronaut (JVM) | ~0.65s | ~120MB |

**Verdict:** Best choice nếu evaluate runtime mới cho microservice cần cloud-native perf.

---

## 3. Micronaut — Minimal Footprint

**Backed by:** Object Computing

**Đặc điểm:**
- AOT compilation pioneer (trước Quarkus)
- Jakarta EE-compatible annotations (dễ migrate từ EE)
- GraalVM native image support tốt
- Micronaut Data — compile-time query generation

**Nhược điểm:**
- Ecosystem nhỏ nhất trong 3 big frameworks
- Ít extension/plugin hơn Quarkus
- Community nhỏ hơn Spring và Quarkus

**Verdict:** Phù hợp minimal footprint use case, nhưng Quarkus có community tốt hơn nhiều.

---

## 4. Helidon — Oracle's Strategic Bet

**Backed by:** Oracle

**Helidon 4.4 (3/2026) — Thay Đổi Chiến Lược:**
- Vào **Java Verified Portfolio (JVP)** — Oracle commercial support
- Align release cadence với JDK roadmap
- Đề xuất trở thành OpenJDK project
- Từ JDK 27: đổi versioning → Helidon 27 (theo JDK)

**Tính năng 4.4:**
- Declarative APIs, Helidon JSON
- OpenTelemetry metrics & logs
- AI: LangChain4j agentic support + MCP spec

**Hai flavor:**
```
Helidon SE  = Reactive, functional, no CDI
              → Minimal, maximum control

Helidon MP  = MicroProfile implementation
              → Similar to Quarkus MP flavor
```

**Verdict:** "Oracle's Quarkus" — theo dõi nếu stack là OCI. Không cần invest học riêng khi Quarkus có community tốt hơn nhiều.

---

## 5. Jakarta EE — Spec, Không Phải Framework

### Tại sao vẫn update liên tục dù không trending?

Jakarta EE là **specification**, không phải framework. Nó định nghĩa chuẩn — các runtime implement. Khi Quarkus "hot", thực ra nó implement Jakarta EE bên dưới.

**Jakarta EE phục vụ:**
- Heavily regulated industries (banking, defense, government)
- Organizations yêu cầu TCK-certified implementation
- Procurement contracts yêu cầu standards compliance

**Ai implement Jakarta EE:**
- Quarkus (Core Profile, một phần Web Profile)
- WildFly / JBoss EAP (Full Platform) — Red Hat
- Open Liberty (Full Platform) — IBM
- Payara (Full Platform)
- GlassFish (Reference Implementation)
- Helidon MP (MicroProfile + Jakarta EE subset)

**Jakarta EE 12 (H2 2026):**
- 24 specifications
- JDK 21 minimum
- Jakarta Query 1.0 ⭐ NEW
- Jakarta Data 1.1 ⭐ NEW
- Jakarta NoSQL 1.1 ⭐ NEW

→ Chi tiết: [[05-Jakarta-EE-12/00-Overview]]

---

## 6. MicroProfile — Sandbox Cho Innovation

### Role thực sự

```
MicroProfile = "Innovation sandbox" của Jakarta EE ecosystem
             → Test new ideas nhanh
             → Nếu thành công → merge vào Jakarta EE
             → Nếu có alternative tốt hơn → deprecated
```

### Status 2026 — Losing Territory

| Spec | Status | Thay thế bởi |
|---|---|---|
| MP OpenTracing | ❌ Deprecated | OpenTelemetry (CNCF) |
| MP Metrics | ⚠ Thu nhỏ | Micrometer + OTEL |
| MP Rest Client | ✅ Active | Quarkus REST Client |
| MP Config | ✅ Strong | Chưa có thay thế tốt hơn |
| MP Fault Tolerance | ✅ Active | Resilience4J cạnh tranh |
| MP Health | ✅ Active | Kubernetes standard |
| MP JWT Auth | ✅ Active | Relevant với banking auth |
| MP OpenAPI | ✅ Active | Swagger/OpenAPI standard |

**MicroProfile 7.1 (6/2025):** Update MP Telemetry và MP OpenAPI.

### MicroProfile Có Giá Trị Khi

- Dùng Quarkus hoặc Helidon (implement MP natively)
- Cần vendor-neutral fault tolerance, config, health
- Không muốn lock-in vào Spring Resilience4J

### Không Cần Học Sâu Khi

- Stack là Spring Boot (đã có tương đương: Actuator, Resilience4J, Config)
- Không dùng Quarkus/Helidon/Open Liberty

---

## Decision Matrix — Chọn Runtime/Framework

```
Câu hỏi                         Recommendation
─────────────────────────────────────────────────────────
Greenfield enterprise service?  Spring Boot 4 (safe choice)
Cần startup < 200ms?            Quarkus JVM
Cần memory < 100MB?             Quarkus Native / Micronaut
Đang trên OCI?                  Helidon (Oracle JVP support)
Cần TCK compliance?             Quarkus / Open Liberty
Team mạnh Java, yếu cloud?      Spring Boot (ecosystem quen)
Học Jakarta EE spec?            Quarkus (best doc, 1:1 spec)
Legacy EJB migration?           WildFly → Quarkus path
```

---

## Mối Quan Hệ — Quick Reference

```
Red Hat ecosystem:   Quarkus ── implements ──→ Jakarta EE + MicroProfile
                     WildFly  ── implements ──→ Jakarta EE Full Platform

Oracle ecosystem:    Helidon  ── implements ──→ Jakarta EE + MicroProfile
                     GlassFish ── reference ──→ Jakarta EE

IBM ecosystem:       Open Liberty ── implements ──→ Jakarta EE + MicroProfile

VMware/Broadcom:     Spring Boot ── alternative ──→ (not Jakarta EE)
                                 ── borrows concepts from Jakarta EE

OC ecosystem:        Micronaut ── CDI-compatible ──→ (partial Jakarta EE)
```

---

*Track: JVM-Frameworks-2026 | Related: [[Java-2026-Trends]], [[Helidon-2026]], [[MicroProfile-2026-Status]]*
*Xem series Jakarta EE 12: [[05-Jakarta-EE-12/00-Overview]]*
