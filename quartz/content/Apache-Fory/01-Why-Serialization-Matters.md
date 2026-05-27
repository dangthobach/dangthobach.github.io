# 01 — Tại Sao Serialization Quan Trọng & Lịch Sử Vấn Đề

> **Series:** [[00-MOC-Apache-Fory-Series]]  
> **Tags:** #serialization #fundamentals #apache-fory #distributed-systems  
> **Level:** Beginner → Intermediate

---

## 🎯 Bạn sẽ học được gì?

- Serialization là gì và tại sao nó là "xương sống" của distributed systems
- Lịch sử tiến hóa: từ Java Object Serialization → Kryo → Fory
- Vì sao các giải pháp cũ không còn đủ tốt
- Fory ra đời để giải quyết vấn đề gì cụ thể
- Use case nào PHÙ HỢP và KHÔNG PHÙ HỢP với Fory

---

## 🧩 Phần 1 — Serialization Là Gì?

### Định nghĩa đơn giản

> **Serialization** = chuyển đổi object trong bộ nhớ thành dạng bytes có thể truyền tải hoặc lưu trữ.  
> **Deserialization** = chiều ngược lại.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   Java Object                    Bytes                          │
│   ┌──────────┐    serialize    ┌────────────────────────┐       │
│   │ name: "Bach"│ ──────────► │ 0xAC 0xED 0x00 0x05... │       │
│   │ age: 28    │              └────────────────────────┘       │
│   │ bank: "VPB"│  deserialize         │                         │
│   └──────────┘ ◄────────────────────┘                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Tại sao cần làm điều này?

Trong memory, object là một mạng lưới con trỏ phức tạp:

```
┌─ DocumentRecord ──────────────────────┐
│  id: 0x7f3a...                        │
│  metadata ──────► ┌─ Metadata ──────┐ │
│  creditInfo ─┐    │  created: ...   │ │
│              │    │  tags: [...]    │ │
│              ▼    └────────────────┘ │
│         ┌─ CreditInfo ─────────────┐ │
│         │  amount: 1_000_000_000   │ │
│         │  currency: "VND"         │ │
│         └──────────────────────────┘ │
└───────────────────────────────────────┘
```

Khi bạn muốn:
- **Gửi qua network** → cần flatten thành byte stream
- **Lưu vào Redis** → cần binary format compact
- **Truyền qua Kafka** → cần format có thể đọc được bởi consumer khác

---

## 📜 Phần 2 — Lịch Sử Tiến Hóa (Timeline)

```
1996        2003        2008        2011        2015        2023
 │           │           │           │           │           │
 ▼           ▼           ▼           ▼           ▼           ▼
Java        Hessian    Protobuf    Kryo        Avro        Apache
ObjectSer.  (Caucho)   (Google)    (Apache)    matures     Fory
 │           │           │           │           │           │
 Verbose     RPC-        IDL-        Fast but    Schema-     JIT +
 Slow        focused     based       JVM-only    first       Zero-Copy
 Insecure    Binary      No          Pitfalls    Ecosystem   Multi-lang
```

### Mỗi thế hệ giải quyết vấn đề gì?

#### 🔴 Java Object Serialization (1996) — Thế hệ 1

```java
// Vẫn thấy trong legacy code Java
ObjectOutputStream oos = new ObjectOutputStream(baos);
oos.writeObject(myObject);  // ← đây là gốc rễ mọi vấn đề
```

**Vấn đề:**
- **Chậm** → reflection-based, không có optimization
- **Payload lớn** → ghi toàn bộ class metadata
- **Không an toàn** → CVE nổi tiếng: gadget chain attacks
- **Chỉ Java** → không thể đọc từ Python, Go, Rust

---

#### 🟡 Kryo (2011) — Thế hệ 2

Kryo là bước tiến lớn — Spark, Flink đều dùng Kryo thay JDK serialization.

```java
Kryo kryo = new Kryo();
kryo.register(DocumentRecord.class);
Output output = new Output(new FileOutputStream("file.bin"));
kryo.writeObject(output, doc);
```

**Cải thiện:** Nhanh hơn 10x, payload nhỏ hơn, hỗ trợ circular reference.

**Vẫn còn vấn đề:**

```
┌──────────────────────────────────────────────────────────────┐
│ VẤN ĐỀ CỦA KRYO                                             │
│                                                              │
│ ❌ Thread-unsafe → phải dùng ThreadLocal hoặc pool          │
│ ❌ Không có zero-copy → vẫn allocate intermediate buffer    │
│ ❌ Registration bắt buộc (classId = thứ tự register!)       │
│ ❌ Version mismatch = production disaster                   │
│ ❌ Chỉ Java                                                  │
└──────────────────────────────────────────────────────────────┘
```

**Kryo pitfall kinh điển trong production:**

```java
// Service A register theo thứ tự này:
kryo.register(UserEvent.class);    // id = 0
kryo.register(OrderEvent.class);   // id = 1

// Service B (deploy sau, thêm class mới):
kryo.register(PaymentEvent.class); // id = 0  ← DISASTER!
kryo.register(UserEvent.class);    // id = 1  ← WRONG!
kryo.register(OrderEvent.class);   // id = 2

// → Production crash, data corruption
```

---

#### 🟢 Apache Fory (2023 → TLP 2025) — Thế hệ 3

Fory không chỉ là "Kryo nhanh hơn" — nó có kiến trúc hoàn toàn khác.

```
┌─────────────────────────────────────────────────────────────┐
│ APACHE FORY — ĐỘT PHÁ                                       │
│                                                              │
│ ✅ JIT Compilation → generate bytecode chuyên biệt          │
│ ✅ Zero-copy → không allocate intermediate buffer           │
│ ✅ Thread-safe by default (ThreadSafeFory)                  │
│ ✅ Multi-language: Java, Python, Go, Rust, JS               │
│ ✅ Circular reference & polymorphism native support         │
│ ✅ 20-170x nhanh hơn JDK serialization                     │
└─────────────────────────────────────────────────────────────┘
```

---

## ⚙️ Phần 3 — Tại Sao Fory Nhanh? (Preview)

*(Chi tiết ở bài 02, nhưng cần hiểu sơ bộ ngay từ đầu)*

### 3.1 JIT-Compiled Serializers

JDK serialization và Kryo dùng **reflection** → phải lookup field dynamically mỗi lần:

```
REFLECTION-BASED (chậm):
Object → getDeclaredFields() → for each field → getValue() → write

FORY JIT (nhanh):
Object → [generated bytecode] → direct field access → write
         ↑ compile lần đầu, cache mãi mãi
```

Tương tự như JVM JIT compile hot method → native code. Fory làm điều này cho serialization.

### 3.2 Zero-Copy với Off-Heap Buffer

```
TRADITIONAL (Kryo, Jackson):
Object → serialize → HeapBuffer → copy → NetworkBuffer → send
                         ↑ allocation + GC pressure

FORY ZERO-COPY:
Object → serialize → DirectBuffer → send
                         ↑ no copy, no GC
```

---

## 🗺️ Phần 4 — Bản Đồ Use Case

### Ma trận quyết định

```
                     ┌──────────────────────────────────────┐
                     │          SCOPE CỦA DATA              │
                     │   JVM-Internal    Cross-System        │
                     │        │               │              │
         ┌───────────┼─────────┼───────────────┼────────────┐
         │ Schema    │         │               │            │
         │ Required  │   Fory  │    Protobuf   │            │
         │           │ compat  │    Avro       │            │
  SCHEMA ├───────────┼─────────┼───────────────┤            │
         │ Schema    │         │               │            │
         │ Optional  │   Fory  │    JSON       │            │
         │           │ native  │    MessagePack│            │
         └───────────┴─────────┴───────────────┴────────────┘
```

### Use cases CỤ THỂ

#### ✅ DÙNG FORY khi:

```
1. REDIS CACHE
   ─────────────
   Bạn cache DocumentMetadata object vào Redis
   Hiện tại: Jackson JSON → 2KB per object
   Với Fory: binary → 400 bytes + deserialize 50x nhanh hơn

2. INTERNAL SESSION STATE
   ─────────────────────
   HTTP session, workflow state trong memory
   Cần serialize để replicate sang node khác trong cluster

3. IN-PROCESS MESSAGE QUEUE
   ──────────────────────────
   Kafka internal topic chỉ 1 service team consume
   Không cần schema registry, không có cross-team contract

4. DISTRIBUTED CACHE (Hazelcast, Infinispan)
   ──────────────────────────────────────────
   Object phải serialize để migrate giữa nodes

5. CROSS-LANGUAGE INTERNAL RPC
   ──────────────────────────────
   Java service gọi Go/Rust service nội bộ
   Không cần IDL, không cần .proto file
```

#### ❌ KHÔNG DÙNG FORY khi:

```
1. KAFKA TOPIC có nhiều team khác nhau consume
   → Dùng Avro + Schema Registry
   → Cần backward/forward compatibility đảm bảo

2. gRPC / REST API
   → Dùng Protobuf / JSON
   → Contract phải được defined rõ ràng

3. DATA LAKE / ANALYTICS
   → Dùng Parquet, ORC, Arrow
   → Columnar format, không phải row-based

4. PUBLIC API (external clients)
   → Fory binary không self-describing
   → Client sẽ không thể decode nếu không có code

5. LONG-TERM STORAGE (years)
   → Schema evolution phức tạp hơn Avro
   → Binary compatibility chỉ guaranteed từ version 1.0+
```

---

## 🏗️ Phần 5 — Fory Bổ Trợ Avro/Protobuf Như Thế Nào?

Đây là câu hỏi quan trọng nhất. **Fory không cạnh tranh với Avro/Protobuf** — chúng giải quyết các lớp vấn đề khác nhau:

```
┌──────────────────────────────────────────────────────────────────┐
│                  KIẾN TRÚC PDMS ĐIỂN HÌNH                        │
│                                                                  │
│  ┌─────────────┐     Avro/Protobuf      ┌──────────────────┐    │
│  │ pdms-api    │ ──────────────────────► │ pdms-iam-service │    │
│  │ (gateway)   │   (cross-service       └──────────────────┘    │
│  └─────────────┘    contract cần rõ)                            │
│         │                                                        │
│         │  Fory (Redis cache)                                    │
│         ▼                                                        │
│  ┌─────────────┐     Avro (Schema       ┌──────────────────┐    │
│  │ document-   │     Registry)          │ Kafka Topic      │    │
│  │ service     │ ──────────────────────► │ (multi-team)     │    │
│  └─────────────┘                        └──────────────────┘    │
│         │                                                        │
│         │  Fory (internal topic, 1 team)                        │
│         ▼                                                        │
│  ┌─────────────┐                        ┌──────────────────┐    │
│  │ process-mgmt│ ──────────────────────► │ Kafka Internal   │    │
│  │ service     │                        │ (same team only) │    │
│  └─────────────┘                        └──────────────────┘    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

Fory và Avro/Protobuf sống CÙNG NHAU trong 1 hệ thống
Mỗi cái đúng layer của nó = tối ưu toàn hệ thống
```

---

## 💡 Phần 6 — Benchmark Thực Tế (Preview)

*(Chi tiết ở bài 13, nhưng cần có số liệu để motivate)*

| Format | Serialize (μs) | Deserialize (μs) | Size (bytes) |
|--------|---------------|-----------------|-------------|
| JDK Serialization | 8,200 | 11,000 | 1,240 |
| Kryo | 890 | 680 | 380 |
| Jackson JSON | 1,200 | 1,800 | 920 |
| Avro | 430 | 520 | 210 |
| Protobuf | 280 | 310 | 185 |
| **Fory (native)** | **48** | **52** | **165** |
| **Fory (xlang)** | **95** | **110** | **190** |

*Benchmark: Java 21, object 10 fields, MacBook M2, JMH warmup 10 iterations*

> **Fory native** nhanh hơn Kryo ~18x, nhanh hơn Jackson ~25x  
> Với Redis cache 10M records của PDMS → tiết kiệm ~60% memory

---

## 🧠 Mental Model Để Nhớ

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│    Nghĩ về serialization như ĐÓNG GÓI HÀNG HÓA            │
│                                                             │
│    Avro/Protobuf = Container shipping                       │
│    → Cần manifest (schema), nhiều bên đọc được             │
│    → Standardized, traceable, regulated                     │
│                                                             │
│    Fory = Internal warehouse logistics                       │
│    → Tốc độ tối đa trong nội bộ                            │
│    → Không cần giấy tờ nếu chỉ di chuyển nội bộ           │
│                                                             │
│    Bạn cần CẢ HAI trong 1 enterprise system                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## ✅ Key Takeaways

- [ ] Serialization là bottleneck ẩn trong mọi distributed system
- [ ] JDK Serialization → Kryo → Fory: mỗi thế hệ giải quyết pitfall của thế hệ trước
- [ ] Fory = **thay thế Kryo/JDK** ở tầng JVM-internal, KHÔNG thay thế Avro/Protobuf
- [ ] Fory dùng JIT compilation + zero-copy → đây là nguồn gốc tốc độ
- [ ] Quyết định đúng = dùng Fory ở cache/internal, Avro ở Kafka multi-team, Protobuf ở gRPC

---

## 🔜 Bài tiếp theo

[[02-How-Fory-Works-Internals]] — Đào sâu vào JIT compilation, zero-copy buffer, object graph serialization

---

## 📖 Tham khảo

- [Apache Fory GitHub](https://github.com/apache/fory)
- [Fory Design Doc — JIT Serialization](https://fory.apache.org/docs/guide/java_object_graph_guide)
- [[Kafka-Configuration-Deep-Dive]] — Kafka serialization context
- [[Debezium-CDC-Deep-Dive]] — CDC event serialization trong PDMS
