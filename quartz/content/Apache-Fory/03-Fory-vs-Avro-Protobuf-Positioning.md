# 03 — Fory vs Avro vs Protobuf: Định Vị & Decision Framework

> **Series:** [[00-MOC-Apache-Fory-Series]]  
> **Tags:** #apache-fory #avro #protobuf #architecture-decision #kafka  
> **Level:** Intermediate  
> **Prerequisite:** [[02-How-Fory-Works-Internals]]

---

## 🎯 Bạn sẽ học được gì?

- Hiểu root cause tại sao 3 framework này KHÔNG thay thế nhau
- Decision framework với câu hỏi cụ thể để chọn đúng tool
- Pattern kết hợp Fory + Avro + Protobuf trong 1 hệ thống
- Áp dụng vào kiến trúc PDMS thực tế

---

## 🧬 Phần 1 — DNA Của Mỗi Framework

Trước khi so sánh features, cần hiểu **mục tiêu thiết kế gốc** của mỗi cái:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  AVRO                                                           │
│  ─────                                                          │
│  Created by: Doug Cutting (creator of Hadoop)                   │
│  Context: Big Data pipelines, schema evolution over years       │
│  Core belief: "Data outlives code"                              │
│  → Schema phải self-describing, readable bởi bất kỳ ai         │
│  → Backward/forward compat là tính năng TRUNG TÂM              │
│                                                                 │
│  PROTOBUF                                                       │
│  ────────                                                       │
│  Created by: Google                                             │
│  Context: Internal RPC giữa 1000s services tại Google          │
│  Core belief: "Services need a language-agnostic contract"      │
│  → .proto = source of truth, compile → code                    │
│  → Performance + type safety là TRUNG TÂM                      │
│                                                                 │
│  FORY                                                           │
│  ─────                                                          │
│  Created by: Alibaba/Alipay team                                │
│  Context: Serialize Java objects giữa nodes trong cluster       │
│  Core belief: "Serialization should be invisible overhead"      │
│  → Không cần IDL, không cần schema registry                    │
│  → Raw speed + developer ergonomics là TRUNG TÂM               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📊 Phần 2 — So Sánh Chi Tiết

### 2.1 Feature Matrix

| Dimension | Avro | Protobuf | Fory |
|-----------|------|----------|------|
| **Schema definition** | JSON (.avsc) | .proto IDL | Không cần (class = schema) |
| **Code generation** | Optional | Bắt buộc | Không cần |
| **Schema Registry** | ✅ Ecosystem tốt | ✅ Có | ❌ Không có |
| **Cross-language** | ✅ | ✅ | ✅ (xlang mode) |
| **Circular reference** | ❌ | ❌ | ✅ Native |
| **Polymorphism** | Manual union type | oneof | ✅ Native |
| **Backward compat** | ✅ Core feature | ✅ Field numbers | ✅ Compatible mode |
| **Forward compat** | ✅ | ✅ | ✅ Compatible mode |
| **Zero-copy** | ❌ | ❌ | ✅ |
| **JIT compilation** | ❌ | ❌ | ✅ |
| **gRPC integration** | Limited | ✅ Native | ❌ |
| **Kafka ecosystem** | ✅ Schema Registry | ✅ | Limited |
| **Raw speed** | ★★★ | ★★★★ | ★★★★★ |
| **Developer ergonomics** | ★★★ | ★★ | ★★★★★ |

### 2.2 Payload Size Comparison

```
Object: CreditDocument (15 fields, 2 nested objects)

JSON (baseline):         1,240 bytes  ████████████████████████████ 100%
JDK Serialization:       1,680 bytes  ████████████████████████████████████ 135%
Avro (with schema):        185 bytes  ████ 15%
Protobuf:                  170 bytes  ███ 14%
Fory native:               155 bytes  ███ 12.5%
Fory xlang (compatible):   195 bytes  ████ 16%

→ Fory native: compact nhất
→ Avro/Protobuf: tốt hơn JSON nhưng cần schema overhead
```

### 2.3 Serialization Performance

```
Serialize 1 object (lower = better), unit: nanoseconds

JDK Serialization   ████████████████████████████████████  8,200 ns
Jackson JSON        ██████████████████████████████        6,100 ns
Kryo                █████████████                         2,800 ns
Avro                ████████                              1,650 ns
Protobuf            ██████                                  890 ns
Fory xlang          ███                                     420 ns
Fory native         █                                        95 ns
                    0      2000    4000    6000    8000
```

---

## 🤔 Phần 3 — Decision Framework

### Flowchart quyết định

```
START: Bạn cần serialize data để...
                │
                ▼
     ┌─────────────────────┐
     │ Data đi qua ranh    │
     │ giới tổ chức/team?  │
     └─────────────────────┘
          │          │
         YES         NO
          │          │
          ▼          ▼
   ┌────────────┐  ┌─────────────────────┐
   │ Cần gRPC   │  │ Chỉ trong 1 team/   │
   │ transport? │  │ service group?      │
   └────────────┘  └─────────────────────┘
     │       │            │
    YES       NO           │
     │        │            ▼
     ▼        ▼     ┌─────────────┐
  PROTOBUF   AVRO   │ Java-only   │
  (+ gRPC)   (+SR)  │ hoặc single │
                    │ language?   │
                    └─────────────┘
                      │         │
                     YES        NO
                      │         │
                      ▼         ▼
                  FORY         FORY
                  NATIVE       XLANG
                  MODE         MODE
```

### 5 câu hỏi cụ thể

**Q1: Có nhiều team độc lập produce/consume data không?**
- YES → Avro + Schema Registry. Schema evolution cần centralized governance.
- NO → Fory hoặc Protobuf.

**Q2: Có cần gRPC?**
- YES → Protobuf (tích hợp native).
- NO → tiếp tục Q3.

**Q3: Data có cần survive sau nhiều năm (data lake, audit log)?**
- YES → Avro (self-describing, Spark/Flink ecosystem).
- NO → Fory.

**Q4: Có cross-language requirement không?**
- YES → Fory xlang mode hoặc Protobuf.
- NO → Fory native mode.

**Q5: Có schema thay đổi thường xuyên và deploy độc lập?**
- YES → Fory compatible mode hoặc Avro.
- NO → Fory native mode (payload nhỏ nhất, nhanh nhất).

---

## 🏗️ Phần 4 — Pattern Kết Hợp Trong 1 Hệ Thống

### The "Right Tool for Right Layer" Pattern

```
┌──────────────────────────────────────────────────────────────────┐
│                    ENTERPRISE SYSTEM LAYERS                      │
│                                                                  │
│  EXTERNAL BOUNDARY                                               │
│  ─────────────────────────────────────────────────────────────  │
│  Mobile App, Partner API, Third-party                           │
│       │                        ▲                                │
│       │  REST/JSON             │  gRPC/Protobuf                 │
│       ▼                        │                                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   API Gateway                            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                           │                                      │
│  INTERNAL SERVICE MESH                                           │
│  ─────────────────────────────────────────────────────────────  │
│       │                                                          │
│       ├── Service A ──[Fory xlang]──► Service B (Go)            │
│       │       │                                                  │
│       │       ├── Redis Cache ──[Fory native]── fast!           │
│       │       │                                                  │
│       │       └── Kafka (internal topic) ──[Fory compatible]    │
│       │                                                          │
│  EVENT STREAMING                                                 │
│  ─────────────────────────────────────────────────────────────  │
│       │                                                          │
│       └── Kafka (cross-team topic) ──[Avro + Schema Registry]   │
│               │                                                  │
│               ├── Data Pipeline ──[Avro → Parquet]              │
│               └── Analytics Team service                        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Pattern cụ thể: "Avro at the boundary, Fory internally"

Đây là pattern phổ biến nhất trong các hệ thống mature:

```java
// Kafka Consumer (boundary) - nhận Avro
@KafkaListener(topics = "credit-events")
public void onCreditEvent(byte[] avroBytes) {
    // 1. Deserialize Avro tại boundary
    CreditEventAvro avroEvent = avroDeserializer.deserialize(avroBytes);
    
    // 2. Convert sang domain object
    CreditEvent event = mapper.toDomain(avroEvent);
    
    // 3. Cache với Fory (internal)
    byte[] foryBytes = fory.serialize(event);
    redis.set("event:" + event.getId(), foryBytes);
    
    // 4. Process, update internal state (Fory serialized)
    processEvent(event);
}

// Internal cache lookup - nhanh với Fory
public CreditEvent getEvent(String id) {
    byte[] bytes = redis.get("event:" + id);
    return (CreditEvent) fory.deserialize(bytes);  // fast!
}
```

---

## 🏦 Phần 5 — Áp Dụng Vào PDMS

### Current state (before Fory)

```
PDMS hiện tại:
─────────────────────────────────────────────────────
Kafka topics      → Avro (đúng rồi, giữ nguyên)
Redis cache       → Jackson JSON (có thể optimize)
Session/JWT cache → JDK serialization (cần replace)
Internal events   → Jackson JSON (có thể optimize)
Cross-service     → REST/JSON hoặc Feign (giữ nguyên)
```

### Recommended state (after Fory)

```
PDMS sau khi thêm Fory:
─────────────────────────────────────────────────────
Kafka topics (multi-team) → Avro ✅ (không đổi)
Kafka topics (internal)   → Fory compatible mode 🆕
Redis cache               → Fory native mode 🆕 (+60% throughput)
Session/JWT auth cache    → Fory native mode 🆕 (+50% memory saved)
Internal events           → Fory compatible mode 🆕
Cross-service REST API    → JSON ✅ (không đổi)
gRPC (nếu có)            → Protobuf ✅ (không đổi)
```

### Migration priority

```
Priority 1 (Quick Win, Low Risk):
─────────────────────────────────
Redis cache → Fory native
  Impact: -60% Redis memory, +50% cache throughput
  Risk: Low (internal only, can test in isolation)
  Effort: 2-3 ngày

Priority 2 (Medium Impact):
─────────────────────────────────
Internal Kafka topics → Fory compatible
  Impact: -40% payload size, +30% consumer throughput
  Risk: Medium (cần test backward compat)
  Effort: 1 tuần

Priority 3 (Evaluate):
─────────────────────────────────
Cross-language nếu có Go/Rust service → Fory xlang
  Impact: Remove IDL overhead
  Risk: Low nếu internal only
  Effort: 2-3 ngày per service pair
```

---

## ⚠️ Phần 6 — Anti-patterns Cần Tránh

### Anti-pattern 1: Dùng Fory cho cross-team Kafka topics

```java
// ❌ SAI: Fory cho topic có Analytics team consume
@KafkaListener(topics = "credit-documents-v2")  // Analytics team dùng
public void publishWithFory(CreditDocument doc) {
    byte[] bytes = fory.serialize(doc);  // Analytics team không có Fory!
    producer.send("credit-documents-v2", bytes);
}

// ✅ ĐÚNG: Avro cho cross-team topic
public void publishWithAvro(CreditDocument doc) {
    CreditDocumentAvro avro = mapper.toAvro(doc);
    producer.send("credit-documents-v2", avroSerializer.serialize(avro));
}
```

### Anti-pattern 2: Dùng Fory cho long-term storage

```java
// ❌ SAI: Fory serialize rồi lưu vào PostgreSQL long-term
// Binary không self-describing, version 1.0 chưa guarantee compat
documentRepository.save(new StoredDocument(
    id, 
    fory.serialize(creditData)  // 5 năm sau đọc lại bằng gì?
));

// ✅ ĐÚNG: JSON hoặc Avro cho long-term storage
documentRepository.save(new StoredDocument(
    id,
    objectMapper.writeValueAsBytes(creditData)  // self-describing
));
```

### Anti-pattern 3: Không register class khi có untrusted input

```java
// ❌ NGUY HIỂM: Deserialize bytes từ external source
Fory fory = Fory.builder()
    .requireClassRegistration(false)  // disable security check
    .build();
Object obj = fory.deserialize(externalBytes);  // RCE risk!

// ✅ AN TOÀN: Luôn register whitelist
ThreadSafeFory fory = Fory.builder()
    .requireClassRegistration(true)  // default in latest versions
    .build();
fory.register(CreditDocument.class);
fory.register(DocumentMetadata.class);
// Chỉ những class này mới được deserialize
```

---

## 📋 Phần 7 — Cheat Sheet Quyết Định Nhanh

```
┌──────────────────────────────────────────────────────────────────┐
│                    QUICK DECISION CARD                           │
├──────────────────────┬───────────────────────────────────────────┤
│ Situation            │ Recommendation                            │
├──────────────────────┼───────────────────────────────────────────┤
│ Kafka, multi-team    │ Avro + Schema Registry                    │
│ Kafka, 1 team only   │ Fory compatible mode                      │
│ Redis cache          │ Fory native mode                          │
│ gRPC between svcs    │ Protobuf                                  │
│ REST API             │ JSON                                      │
│ Session state        │ Fory native mode                          │
│ Java ↔ Go internal   │ Fory xlang mode                           │
│ Java ↔ Go external   │ Protobuf hoặc JSON                        │
│ Data lake / Spark    │ Avro hoặc Parquet                         │
│ Audit log            │ Avro (self-describing)                    │
│ Replace JDK Serial.  │ Fory native mode                          │
│ Replace Kryo         │ Fory native mode                          │
└──────────────────────┴───────────────────────────────────────────┘
```

---

## ✅ Key Takeaways

- [ ] Avro: cho data pipelines, schema registry, cross-team Kafka — "data outlives code"
- [ ] Protobuf: cho gRPC, external APIs, compile-time contract
- [ ] Fory: cho JVM-internal, cache, internal events — "serialization as infrastructure"
- [ ] Pattern đúng: Avro/Protobuf ở boundary, Fory ở trong
- [ ] Không bao giờ dùng Fory cho: cross-team Kafka, external API, long-term storage
- [ ] Security: luôn enable `requireClassRegistration` cho untrusted input

---

## 🔜 Bài tiếp theo

[[04-Fory-Java-Quickstart]] — Setup Fory trong Java/Spring Boot, viết code serialize đầu tiên

---

## 📖 Tham khảo

- [Apache Fory GitHub README](https://github.com/apache/fory)
- [Avro vs Protobuf use cases](https://automq.com/blog/avro-vs-json-schema-vs-protobuf-kafka-data-formats)
- [[Kafka-Configuration-Deep-Dive]]
- [[gRPC-Deep-Dive]]
- [[01-Why-Serialization-Matters]]
- [[02-How-Fory-Works-Internals]]
