# Java 2026 — Điểm Nhấn Xu Hướng

> **Cập nhật:** 2026-05 | **Context:** Enterprise / Spring Boot / Banking
> **Tags:** java, jdk26, loom, valhalla, spring-boot-4, jakarta-ee-12

---

## 1. JDK 26 (GA tháng 3/2026) — Non-LTS nhưng nặng ký

10 JEP, trong đó 5 vẫn preview/incubator. Các điểm đáng chú ý:

- **HPKE (Hybrid Public Key Encryption)** — post-quantum-ready JAR signing
- **Unicode 17 + CLDR v48** — cập nhật locale/format
- **Region-based file uploads** trong `HttpClient`
- JDK 27 (tháng 9/2026) sẽ chính thức target **Post-Quantum Hybrid Key Exchange** cho TLS 1.3 → quan trọng với fintech/banking SBV compliance

---

## 2. Project Valhalla — Bắt Đầu Hạ Cánh

**JEP 401 (Value Classes and Objects)** — early-access trong JDK 26, preview.

- Loại bỏ identity overhead của value types
- Ảnh hưởng trực tiếp tới domain objects: `Money`, `AccountNumber`, DTO trong PDMS
- Lộ trình production-ready: Java 26–27 (2026–2027)

```java
// Value class — no identity, stored inline (JEP 401)
value class Money {
    private final BigDecimal amount;
    private final String currency;
    // → stored on stack/inline, không cần heap allocation
}
```

---

## 3. Project Loom + Structured Concurrency — Thành Baseline

Virtual threads không còn là chủ đề "mới" — đã thành mặc định cho cloud-native/microservices.

**Structured Concurrency** (JEP ổn định dần):
- Xử lý task song song như một đơn vị
- Auto-cancel khi một task fail
- Tránh task zombie (chạy sau khi parent đã kết thúc)

```java
// Structured Concurrency
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    Future<Document> doc  = scope.fork(() -> fetchDocument(id));
    Future<Audit>    audit = scope.fork(() -> fetchAudit(id));
    scope.join().throwIfFailed();
    return new Result(doc.get(), audit.get());
}
```

**Recommendation PDMS:** JDBC + Virtual Threads là lựa chọn an toàn cho banking CRUD — không cần reactive.

---

## 4. Project Leyden — AOT Caching

AOT caching — alternative thực dụng cho GraalVM Native Image, không có các ràng buộc của native (reflection, dynamic proxy, build time lâu).

```
Leyden:
- Build: cache class loading decisions, JIT profiles
- Runtime: reuse cache → faster startup + warmup
- Không đổi code, không mất dynamic features

GraalVM Native Image:
- Build: compile ahead-of-time (30+ phút)
- Runtime: instant start, low memory
- Constraint: no reflection, no dynamic class loading
```

**Recommendation:** Leyden phù hợp hơn cho Spring Boot service cần cải thiện cold-start mà không muốn dính ràng buộc native image.

---

## 5. Spring AI 1.0 — AI Stack trên JVM Đủ Chín

Spring AI 1.0 (GA 5/2025) — tier "Early Majority" trong InfoQ Java Trends Report 2025:

- `ChatClient` hỗ trợ 20+ AI model với multi-modal input
- **Advisors API** — inject retrieval data và conversation memory vào prompt
- **Model Context Protocol (MCP) support** — full spec
- Tích hợp vector stores, embeddings, tool calling

```java
@Bean
ChatClient chatClient(ChatClient.Builder builder, VectorStore vectorStore) {
    return builder
        .defaultAdvisors(
            new QuestionAnswerAdvisor(vectorStore),
            new MessageChatMemoryAdvisor(new InMemoryChatMemory())
        )
        .build();
}
```

---

## 6. Spring Boot 4.0 (11/2025) — Baseline Mới

| Thay đổi | Chi tiết |
|---|---|
| JDK minimum | JDK 17 → JDK 21 |
| Null safety | JSpecify annotations first-class |
| API versioning | Built-in support |
| Base framework | Spring Framework 7.0 |
| Style | Functional, declarative hơn |

**Migration plan PDMS:** Spring Boot 3.x hiện tại vẫn supported đến 2025. Boot 4 migration nên lên kế hoạch cho 2026.

---

## 7. Project Amber — Critical Mass

Các tính năng đã stable, thành baseline kỳ vọng cho Java code hiện đại:

```java
// Sealed classes
sealed interface Shape permits Circle, Rectangle, Triangle {}

// Pattern matching instanceof
if (obj instanceof Document doc && doc.isActive()) { ... }

// Pattern matching switch
double area = switch (shape) {
    case Circle c    -> Math.PI * c.radius() * c.radius();
    case Rectangle r -> r.width() * r.height();
    case Triangle t  -> 0.5 * t.base() * t.height();
};

// Records
record Money(BigDecimal amount, String currency) {}

// Primitive types in patterns (JDK 26 preview)
switch (value) {
    case int i when i > 0 -> "positive";
    case int i            -> "non-positive";
    case float f          -> "float: " + f;
}
```

---

## 8. Jakarta EE 12 (GA H2 2026) — Spec Update Lớn

- **24 specification** đang review
- JDK 21 minimum
- **Jakarta Query 1.0** — unified query language mới ⭐
- **Jakarta Data 1.1** — repository pattern chuẩn hóa ⭐
- **Jakarta NoSQL 1.1** — NoSQL standard API ⭐
- Core Profile, Web Profile, Full Platform

→ Chi tiết đầy đủ: [[05-Jakarta-EE-12/00-Overview]]

---

## Tóm Gọn Cho PDMS/VPBank

| Priority | Technology | Action |
|---|---|---|
| ⭐⭐⭐ | Spring Boot 4 migration | Plan 2026 |
| ⭐⭐⭐ | Virtual Threads (Loom) | Safe to production now |
| ⭐⭐⭐ | Post-quantum TLS (JDK 27) | SBV compliance sẽ yêu cầu |
| ⭐⭐ | Spring AI + MCP | Evaluate cho PDMS assistant |
| ⭐⭐ | Project Leyden | Khi cần optimize cold-start |
| ⭐ | Project Valhalla | Watch, dài hạn |
| ⭐ | Jakarta EE 12 | Học spec để đọc Quarkus/Helidon |

---

*Track: JVM-Frameworks-2026 | Related: [[Framework-Landscape-2026]], [[05-Jakarta-EE-12/00-Overview]]*
