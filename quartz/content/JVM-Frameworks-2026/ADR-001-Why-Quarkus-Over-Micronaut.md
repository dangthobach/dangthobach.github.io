---
tags: [adr, decision-record, jvm-frameworks, quarkus, micronaut, architecture]
created: 2026-04-14
status: accepted
deciders: [Bach]
---

# ADR-001 — Chọn Quarkus thay vì Micronaut cho PDMS Migration

## 📋 Trạng thái
**Accepted** — áp dụng từ 2026-Q2, review lại 2026-Q4

---

## 🧭 Bối cảnh (Context)

PDMS (Physical Document Management System) tại VPBank hiện đang chạy Spring Boot microservices với các đặc điểm:
- **10M+ records** trong luồng Credit Migration, batch ETL nặng
- **High-concurrency**: Document processing, Kafka consumers xử lý event từ nhiều nguồn
- **PostgreSQL** làm primary DB, Kafka làm message broker
- **jCasbin ABAC** cho authorization
- **On-premise Kubernetes** — RAM và CPU cost là thực tế, không phải abstract
- Team: ~5 Java developers, background Spring Boot 2.x/3.x

Khi xem xét migration từ Spring Boot sang framework cloud-native, hai ứng viên chính là **Quarkus** và **Micronaut**.

---

## 🤔 Vấn đề cần quyết định (Decision Drivers)

1. **Memory footprint**: Giảm RAM consumption trên K8s — mỗi 100MB tiết kiệm là chi phí thực
2. **Startup time**: HPA scale-out cần pod sẵn sàng nhanh, tránh request drop
3. **Kafka integration**: SmallRye Reactive Messaging vs Micronaut Kafka — mature và production-ready
4. **Reactive model**: Xử lý high I/O concurrency cho document streaming
5. **Dev experience**: Learning curve của team, hot reload, testability
6. **Ecosystem cho PDMS use cases**: Panache (complex queries), Native Image feasibility
7. **Spring familiarity**: Reduce context switch cost cho team

---

## 🔍 Các lựa chọn đã xem xét

### Option A: Quarkus ⬡
### Option B: Micronaut ◈
### Option C: Giữ Spring Boot 3 + Virtual Threads 🍃

---

## ⚖️ So sánh chi tiết

### Performance & Runtime

| Metric | Quarkus Native | Quarkus JVM | Micronaut Native | Spring Boot 3 (VT) |
|--------|--------------|-------------|-----------------|-------------------|
| Startup | **~40ms** | ~500ms | ~100ms | ~4s |
| RAM idle | **~25MB** | ~120MB | ~35MB | ~280MB |
| Throughput (after warmup) | Good | **Excellent** | Good | Excellent |
| Peak latency | Predictable | Good | Predictable | Good (với VT) |

**Verdict (Performance):** Quarkus Native thắng rõ ràng về startup và RAM. Tuy nhiên Micronaut không thua kém nhiều — cả hai đều vượt Spring Boot đáng kể.

### Kafka Integration (PDMS-critical)

| | Quarkus | Micronaut |
|--|---------|-----------|
| Library | **SmallRye Reactive Messaging** | Micronaut Kafka |
| Model | **Reactive, non-blocking, backpressure** | Annotation-driven, dễ dùng |
| Multi-topic routing | Linh hoạt | Bị giới hạn ở complex cases |
| Error handling / DLQ | Mature, built-in | Basic |
| Schema Registry (Avro) | Built-in extension | Manual config |
| Production track record | **Netflix, RedHat, IBM** | Ít case study lớn hơn |

**Verdict (Kafka):** Quarkus thắng rõ. SmallRye Reactive Messaging có production track record lớn hơn và xử lý backpressure tốt hơn — quan trọng khi consume 10K+ msg/s trong Credit Migration pipeline.

### Development Experience

| | Quarkus | Micronaut |
|--|---------|-----------|
| Hot reload | **Quarkus Dev Mode** — live reload < 1s | Mạnh nhưng chậm hơn |
| Dev Services | **Auto-spin PostgreSQL, Kafka, Redis** qua Docker | Cần cấu hình thêm |
| Test speed | Quarkus Test + `@QuarkusTest` nhanh | **Micronaut Test nhanh nhất** |
| IDE support | Tốt (IntelliJ plugin) | Tốt |
| Spring migration | Moderate learning curve | **Gần Spring nhất** |
| Documentation | **Xuất sắc** — guides rất chi tiết | Tốt nhưng ít hơn |

**Verdict (Dev XP):** Micronaut gần Spring hơn, nhưng Quarkus Dev Mode là killer feature — team phản hồi productivity tăng rõ khi không phải restart server mỗi thay đổi.

### Ecosystem & Long-term

| | Quarkus | Micronaut |
|--|---------|-----------|
| Backing | **Red Hat** (IBM) — enterprise support | Object Computing — smaller |
| Community size | Lớn hơn đáng kể | Nhỏ hơn |
| Extension count | **500+** | ~200 |
| Native Image maturity | **Production-grade** | Production-grade |
| GraalVM support | **First-class** — Red Hat tham gia GraalVM team | Good |
| Long-term risk | Thấp | Trung bình |

---

## ✅ Quyết định (Decision)

**Chọn Quarkus** cho PDMS migration với strategy theo phases:

```
Phase 1 (Pilot — Q2 2026):
  → Kafka Event Processor service (document-events consumer)
  → Lý do: I/O-bound, stateless, rõ ràng ROI
  → Metric thành công: RAM giảm >40%, throughput tăng >20%

Phase 2 (Q3 2026):
  → Document Service (CRUD, search, streaming)
  → Dùng Panache + SmallRye OpenAPI

Phase 3 (2027):
  → Review lại: Native Image cho document-processor nếu K8s cost justify
  → Giữ Spring Boot cho ETL batch — Spring Batch ecosystem irreplaceable
```

---

## 📊 Hệ quả (Consequences)

### Tích cực ✅
- RAM saving: ~120MB/pod JVM, ~250MB/pod Native → tiết kiệm đáng kể ở scale
- Startup < 1s (JVM) → HPA scale-out không drop request
- SmallRye Reactive Messaging handle backpressure tốt hơn cho Credit Migration pipeline
- Quarkus Dev Mode tăng developer productivity
- Red Hat backing = long-term support đảm bảo hơn

### Tiêu cực / Rủi ro ⚠️
- **CDI ≠ Spring IoC**: Team cần 2-4 tuần adjust tư duy scope/proxy
- **JAX-RS thay Spring MVC**: Annotation set khác, cần cheatsheet (đã có `Spring-to-Quarkus-Cheatsheet.md`)
- **Mutiny ≠ Reactor**: Nếu vào Phase 3 (reactive full stack), học lại reactive model
- **Native Image caveats**: Reflection-heavy code (jCasbin) cần manual config → defer Native Image đến Phase 3
- **Rủi ro key person**: Nếu chỉ 1-2 người dẫn đầu, knowledge transfer cần được document hóa

### Không áp dụng cho ❌
- **Spring Batch ETL pipelines**: Giữ Spring Boot — không có equivalent mature
- **Existing Spring Security SAML** (nếu có): Migration cost cao, giữ nguyên
- **Legacy credit system interfaces**: Strangler Fig dần, không big-bang

---

## 🔄 Khi nào Review lại quyết định này

- **Trigger tự động**: Nếu Micronaut ra major version với Kafka improvements lớn (v5+)
- **Trigger từ PDMS**: Nếu Phase 1 pilot không đạt target metrics sau 3 tháng
- **Trigger từ team**: Nếu learning curve cao hơn dự kiến → xem xét Micronaut cho services ít phức tạp
- **Review định kỳ**: Q4 2026

---

## 🔗 Liên kết

- [[JVM-Frameworks-2026/Framework-Decision-Matrix]] — Ma trận so sánh đầy đủ
- [[JVM-Frameworks-2026/Spring-to-Quarkus-Cheatsheet]] — Migration reference
- [[JVM-Frameworks-2026/01-Quarkus/00 Quarkus Overview]] — Deep dive Quarkus
- [[JVM-Frameworks-2026/02-Micronaut/]] — Tài liệu Micronaut để compare
- [[_moc/MOC-PDMS]] — PDMS context
- [[ADR-002-Project-Loom-vs-Reactive-for-PDMS]] *(cần viết)* — Decision tiếp theo
