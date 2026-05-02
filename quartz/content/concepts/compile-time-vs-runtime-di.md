---
tags: [java, di, quarkus, micronaut, spring, evergreen]
aliases: [compile-time-di, aot-di, runtime-di, dependency-injection-comparison]
created: 2026-04-13
status: evergreen
---

# Compile-time vs Runtime Dependency Injection

## 📌 One-liner
> Runtime DI (Spring) đọc annotations qua reflection lúc khởi động và tạo proxy động → startup chậm. Compile-time DI (Quarkus ArC, Micronaut) generate code wiring lúc build → startup milliseconds, không cần reflection.

---

## 🧠 Core Idea

### Cả hai làm cùng một việc — nhưng *khi nào* thì khác hoàn toàn

```
RUNTIME DI (Spring Boot):

  Source.java ──javac──→ .class  ──[App Start]──→ Reflect → Wire → Proxy → Ready
                                                   ↑
                                             3–10 giây ở đây
                                             RAM cho reflection cache
                                             Không biết lỗi DI cho đến khi chạy

──────────────────────────────────────────────────────────────────────────────────

COMPILE-TIME DI (Quarkus / Micronaut):

  Source.java ──[Build: Annotation Processor]──→ Generated wiring code
                                              ──→ .class (đã có wiring)
                                              ──→ [App Start] execute code → Ready
                                                             ↑
                                                       40–400ms ở đây
                                                       Lỗi DI → BUILD FAIL (bắt sớm hơn!)
```

### Annotation Processor tạo ra gì?

```java
// Bạn viết:
@ApplicationScoped          // hoặc @Singleton trong Micronaut
public class UserService {
    @Inject
    UserRepository repo;
}

// Quarkus ArC / Micronaut tạo ra (simplified):
public class UserService$Definition {
    public UserService create(BeanContext ctx) {
        UserRepository repo = ctx.getBean(UserRepository.class); // direct call, no reflection
        UserService svc = new UserService();
        svc.repo = repo;   // direct field set, no reflection
        return svc;
    }
}
// File này được compile vào .class → chạy thẳng lúc startup
```

---

## 🔁 So sánh 3 frameworks

| Khía cạnh | Spring Boot | Quarkus (ArC) | Micronaut |
|-----------|-------------|---------------|-----------|
| DI xử lý lúc | Runtime (app start) | Compile-time (build) | Compile-time (build) |
| Cơ chế | Reflection + CGLIB proxy | CDI bytecode gen | ASM bytecode gen |
| DI spec | Spring proprietary | CDI (Jakarta EE) | JSR-330 (@Inject) |
| Scope annotation | `@Component` `@Service` | `@ApplicationScoped` `@Dependent` | `@Singleton` `@Prototype` |
| Inject annotation | `@Autowired` | `@Inject` | `@Inject` |
| Startup time | 3–10s | 0.4–1s (JVM), 0.04s (Native) | 0.3–0.8s |
| Memory overhead | High (reflection cache, proxy) | Low (no reflection) | Low (no reflection) |
| DI lỗi phát hiện | Runtime (app crash on start) | Compile-time (build fail) | Compile-time (build fail) |
| GraalVM Native | Cần thêm config | First-class | First-class |
| AOP | Runtime CGLIB proxy | Compile-time interceptors | Compile-time interceptors |

---

## 💻 Code So Sánh: Cùng 1 Service, 3 cách viết

```java
// ──────────── SPRING BOOT ────────────
@Service                               // = @Component + semantic label
public class DocumentService {

    @Autowired                         // runtime: Spring inject qua reflection
    private DocumentRepository repo;

    @Autowired
    private KafkaTemplate<String, DocumentEvent> kafka;

    @Transactional                     // runtime: CGLIB proxy intercepts
    public Document create(CreateRequest req) {
        Document doc = repo.save(new Document(req));
        kafka.send("docs", new DocumentEvent(doc));
        return doc;
    }
}

// ──────────── QUARKUS (ArC / CDI) ────────────
@ApplicationScoped                     // CDI scope — tạo proxy, thread-safe
public class DocumentService {

    @Inject                            // compile-time: ArC generate injection code
    DocumentRepository repo;

    @Inject
    @Channel("docs-out")
    Emitter<DocumentEvent> emitter;

    @Transactional                     // compile-time: CDI interceptor weaved in
    public Document create(CreateRequest req) {
        Document doc = new Document(req);
        repo.persist(doc);
        emitter.send(new DocumentEvent(doc));
        return doc;
    }
}

// ──────────── MICRONAUT ────────────
@Singleton                             // Micronaut scope ≈ Spring @Service
public class DocumentService {

    private final DocumentRepository repo;      // constructor injection — recommended
    private final DocumentEventProducer kafka;

    public DocumentService(DocumentRepository repo,
                           DocumentEventProducer kafka) { // compile-time wired
        this.repo  = repo;
        this.kafka = kafka;
    }

    @Transactional                     // compile-time interceptor
    public Document create(CreateRequest req) {
        Document doc = repo.save(new Document(req));
        kafka.send(new DocumentEvent(doc));
        return doc;
    }
}
```

---

## 🔬 Tại sao Compile-time DI tương thích GraalVM Native?

```
GraalVM Native Image phân tích code tĩnh (static analysis):
- Biết chính xác class nào được dùng
- Biết chính xác method nào được gọi
- Có thể loại bỏ code không dùng (dead code elimination)

SPRING (Runtime Reflection):
- Gọi Class.forName("com.example.UserRepo") lúc runtime
- GraalVM không biết string này sẽ resolve thành class nào
- → Phải khai báo thủ công trong reflect-config.json
- → Hay bị thiếu → native image crash lúc runtime

QUARKUS / MICRONAUT (Compile-time):
- Mọi wiring đã là direct method calls lúc compile
- GraalVM thấy rõ: new UserService(new UserRepo())
- → Native image tự động include đúng class cần thiết
- → Không cần reflect-config cho DI layer
```

---

## ⚠️ Pitfalls

> [!warning] Compile-time DI không có "Spring magic"
> Không có auto-detection lúc runtime. Mọi bean phải được khai báo rõ ràng qua annotation. Không thể dùng `@ConditionalOnProperty` với điều kiện tính lúc runtime — phải dùng `@Requires` (Micronaut) hoặc `@IfBuildProperty` (Quarkus).

> [!warning] Quarkus: @Singleton ≠ @ApplicationScoped
> ```java
> @Singleton          // KHÔNG có proxy → không inject được vào @RequestScoped bean
> @ApplicationScoped  // CÓ proxy → an toàn, dùng cho hầu hết services
> ```
> Luôn dùng `@ApplicationScoped` cho services trừ khi có lý do cụ thể.

> [!warning] Self-invocation vẫn là vấn đề
> Cả Spring lẫn Quarkus/Micronaut đều không intercept khi gọi `this.method()` — phải inject bản thân hoặc tách class để AOP hoạt động đúng.

---

## 💡 Khi nào chọn cái nào

✅ **Runtime DI (Spring Boot)** khi:
- Team quen Spring, đổi framework tốn chi phí cao
- Cần nhiều Spring ecosystem libraries (Spring Security, Spring Data complex)
- Startup time không quan trọng (long-running monolith)

✅ **Compile-time DI (Quarkus/Micronaut)** khi:
- Cần GraalVM Native Image
- Microservices cần scale nhanh, cold start thấp (K8s, serverless)
- Muốn bắt lỗi DI sớm hơn (build fail > runtime crash)
- RAM constraint (container với giới hạn 256MB)

---

## 🔗 Liên quan
- [[JVM-Frameworks-2026/01-Quarkus/P1-Foundation/01 CDI vs Spring IoC|Quarkus: CDI vs Spring IoC]] — implementation chi tiết
- [[JVM-Frameworks-2026/02-Micronaut/P1-Core/01 Compile-time DI vs Runtime DI|Micronaut: Compile-time DI]] — implementation chi tiết
- [[native-image-aot-jit]] — tại sao compile-time DI quan trọng cho Native
- [[_moc/MOC-Java|MOC-Java]] — Spring IoC context

## 📖 Nguồn
- https://quarkus.io/guides/cdi — Quarkus CDI guide
- https://docs.micronaut.io/latest/guide/#ioc — Micronaut IoC
- https://spring.io/blog/2023/06/23/up-and-running-with-spring-boot-and-graalvm — Spring + GraalVM
