---
tags: [java, quarkus, graalvm, native, performance, evergreen]
aliases: [native-image, graalvm, aot-compilation, jit-compilation, ahead-of-time]
created: 2026-04-13
status: evergreen
---

# Native Image, AOT vs JIT

## 📌 One-liner
> JIT (Just-In-Time) compile bytecode → native code **lúc runtime** khi app đang chạy — startup chậm nhưng throughput cao sau warmup. AOT (Ahead-Of-Time) compile toàn bộ thành native binary **lúc build** — startup milliseconds, RAM thấp, nhưng không có JIT optimization.

---

## 🧠 Core Idea

### JVM Execution Pipeline (truyền thống)

```
Source.java
    │ javac
    ▼
Bytecode (.class)
    │ JVM loads & interprets
    ▼
Interpreter (chậm, chạy từng instruction)
    │ JIT compiler phát hiện "hot methods" (được gọi thường xuyên)
    ▼
Native machine code (cho hot methods) ← nhanh sau warmup
    │
    ▼ App chạy bình thường
```

### GraalVM Native Image Pipeline

```
Source.java + Dependencies
    │ javac → bytecode
    │ GraalVM native-image (phân tích tĩnh toàn bộ)
    │   → Points-to analysis: class nào thực sự được dùng?
    │   → Dead code elimination: loại bỏ code không dùng
    │   → AOT compile tất cả → machine code
    ▼
Standalone binary (không cần JVM)
    │ Chạy thẳng trên OS
    ▼
App ready: ~40ms, ~20MB RAM
```

---

## 🔁 So sánh: JIT vs AOT vs JVM Warmup

| Metric | JVM (JIT) | GraalVM Native (AOT) | Ghi chú |
|--------|-----------|----------------------|---------|
| Startup time | 3–10s | 0.01–0.05s | Native nhanh hơn 100–200× |
| Warmup time | 30–120s (JIT optimize) | Không cần warmup | AOT compile sẵn |
| Peak throughput | Cao (JIT optimized) | Thấp hơn ~10–20% | JIT biết runtime behavior |
| RAM (idle) | 200–500MB | 15–50MB | Native tiết kiệm 10× |
| RAM (peak) | Tương đương | Tương đương | Không khác nhiều |
| Binary size | JAR ~50MB + JVM ~300MB | Native binary ~80–150MB | Native self-contained |
| Build time | ~30s | 5–15 phút | Native build cực chậm |
| Debuggability | Dễ (JVM tools đầy đủ) | Khó hơn (hạn chế tooling) | Trade-off |
| Reflection | Đầy đủ | Cần khai báo thủ công | Hạn chế lớn nhất |
| Dynamic class loading | Có | Không | Không thể load class mới lúc runtime |

---

## 💻 Quarkus: Build JVM vs Native

```bash
# Build JVM (truyền thống — nhanh, debug dễ)
./mvnw package
java -jar target/quarkus-app/quarkus-run.jar

# Build Native — cần GraalVM installed
./mvnw package -Pnative
./target/my-app-1.0.0-runner                    # chạy thẳng, không cần JVM!

# Build Native trong Docker (không cần cài GraalVM local)
./mvnw package -Pnative \
    -Dquarkus.native.container-build=true       # build trong container GraalVM
./target/my-app-1.0.0-runner

# Đo startup time
time java -jar target/quarkus-app/quarkus-run.jar &
# → Started in 0.823s

time ./target/my-app-1.0.0-runner &
# → Started in 0.038s
```

---

## 🔍 Reflection Problem — Hạn chế lớn nhất của Native

GraalVM phân tích code **tĩnh** — không thể biết string nào sẽ được dùng để load class lúc runtime:

```java
// ❌ GraalVM không biết class nào được load
String className = config.get("plugin.class");      // dynamic string
Class<?> clazz = Class.forName(className);           // runtime reflection → fail in native

// ❌ Jackson dùng reflection để serialize/deserialize
ObjectMapper mapper = new ObjectMapper();
User user = mapper.readValue(json, User.class);      // reflection → phải khai báo

// ✅ Fix: khai báo class cần reflection
@RegisterForReflection                               // Quarkus annotation
public class User { }

// ✅ Fix: JSON config
// reflect-config.json
[{
    "name": "com.example.User",
    "allDeclaredFields": true,
    "allDeclaredMethods": true,
    "allDeclaredConstructors": true
}]
```

### Quarkus giải quyết phần lớn tự động

```java
// Quarkus extension tự xử lý reflection cho:
// - RESTEasy (JAX-RS) endpoints ✅
// - Hibernate/Panache entities ✅
// - Jackson JSON serialization ✅ (nếu dùng Jackson extension)
// - CDI beans ✅

// Chỉ cần @RegisterForReflection cho:
// - Thư viện bên thứ ba ít phổ biến
// - Dynamic class loading của chính bạn
// - Custom serializers không qua Jackson extension

@RegisterForReflection(targets = {
    LegacyDto.class,
    ExternalLibraryModel.class
})
public class ReflectionRegistrations { }   // empty class, chỉ để register
```

---

## 📊 Khi nào Native Image thực sự có giá trị?

```
Scenario 1: Kubernetes Microservice với nhiều pods

  JVM: 512MB RAM/pod × 50 pods = 25.6GB RAM total
  Native: 64MB RAM/pod × 50 pods = 3.2GB RAM total
  → Tiết kiệm ~22GB RAM → tiết kiệm chi phí infra đáng kể cho VPBank

Scenario 2: Serverless / Lambda Function

  JVM: Cold start 5–15s → timeout, poor UX
  Native: Cold start 40–100ms → acceptable

Scenario 3: CLI Tool (ít phổ biến cho Java)

  JVM: `java -jar tool.jar` → chờ 3s để show --help
  Native: `./tool` → instant response

Scenario 4: Long-running Monolith

  JVM: Startup 10s một lần → không vấn đề
  Native: Build 10 phút, debug khó hơn → không đáng
```

---

## 🔍 AOT trong Spring Boot 3+ (không phải GraalVM)

Spring Boot 3 cũng có **AOT processing** riêng — khác GraalVM Native:

```bash
# Spring AOT: process annotation → generate source code lúc build
./mvnw spring-boot:process-aot

# Vẫn chạy trên JVM, nhưng startup nhanh hơn (bỏ annotation scanning)
# Không phải binary native như GraalVM
```

```
Spring Boot 3 AOT:
  Build time: annotation processing → generated sources
  Runtime: chạy trên JVM, startup ~1–2s (thay vì 5–10s)
  Không cần GraalVM

GraalVM Native Image:
  Build time: toàn bộ compile → native binary
  Runtime: không cần JVM, startup ~40ms
  Cần GraalVM native-image tool
```

---

## ⚠️ Pitfalls

> [!warning] Build time cực chậm — plan trước
> Native image build: 5–15 phút. Không nên chạy trong inner dev loop.
> **Workflow khuyến nghị:** dev với JVM (`quarkus:dev`) → test → CI build native.

> [!warning] Một số libraries không tương thích
> Dynamic proxies, bytecode generation lúc runtime (như một số legacy Spring libs) không hoạt động với Native. Luôn kiểm tra Quarkus extension compatibility list trước.

> [!warning] Debug khó hơn
> GDB debugging native image có thể, nhưng không có JVM tools (JProfiler, async-profiler). Troubleshoot lỗi production native khó hơn JVM.

> [!tip] "Test locally with JVM, deploy native to production"
> Đây là workflow phổ biến nhất — JVM cho dev speed, native cho prod performance.

---

## 💡 Khi nào dùng JIT JVM vs Native

✅ **Giữ JVM (JIT) khi:**
- App long-running, cần throughput cao (JIT optimize sau warmup)
- Dùng libraries chưa tương thích GraalVM
- Team cần easy debugging, JVM profiling tools
- Startup time không quan trọng

✅ **Chuyển sang Native (AOT) khi:**
- Microservice K8s cần scale nhanh (cold start quan trọng)
- Serverless / event-driven (Lambda, Knative)
- RAM bị giới hạn nghiêm ngặt (sidecar containers)
- CLI tools phân phối đến user cuối

---

## 🔗 Liên quan
- [[JVM-Frameworks-2026/01-Quarkus/P4-Native/01 GraalVM Native Image|Quarkus: GraalVM Native Image]] — hướng dẫn thực hành
- [[JVM-Frameworks-2026/01-Quarkus/P4-Native/02 Kubernetes & Health Checks|Quarkus: Kubernetes]] — deploy native lên K8s
- [[compile-time-vs-runtime-di]] — tại sao compile-time DI tương thích native tốt hơn
- [[_moc/MOC-Java|MOC-Java]] — JVM internals context

## 📖 Nguồn
- https://quarkus.io/guides/building-native-image
- https://www.graalvm.org/native-image/ — GraalVM docs
- https://docs.spring.io/spring-boot/reference/packaging/native-image/ — Spring Native
