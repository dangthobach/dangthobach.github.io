# 02 — Cơ Chế Hoạt Động Của Apache Fory: JIT, Zero-Copy, Object Graph

> **Series:** [[00-MOC-Apache-Fory-Series]]  
> **Tags:** #apache-fory #internals #jit #zero-copy #performance  
> **Level:** Intermediate  
> **Prerequisite:** [[01-Why-Serialization-Matters]]

---

## 🎯 Bạn sẽ học được gì?

- Fory JIT compilation hoạt động như thế nào (khác gì JVM JIT)
- Zero-copy buffer strategy — tại sao nó triệt tiêu GC pressure
- Object graph traversal — xử lý circular reference, polymorphism
- Memory layout của Fory binary format
- Thread-safety model

---

## 🧠 Phần 1 — Tại Sao Reflection Chậm?

Trước khi hiểu Fory làm gì, cần hiểu vấn đề cốt lõi của Kryo/Jackson.

### Reflection-based serialization

```java
// Đây là cách Kryo/Jackson đọc field (simplified):
Field[] fields = obj.getClass().getDeclaredFields();
for (Field field : fields) {
    field.setAccessible(true);
    Object value = field.get(obj);  // ← reflection call
    writeValue(output, value);
}
```

**Mỗi `field.get(obj)` là một reflection call:**

```
CPU cost breakdown (1 field read):
├── Lookup field in class descriptor      ~5 ns
├── Security check (setAccessible)        ~3 ns
├── JVM dispatch + boxing (int → Integer) ~8 ns
├── Null check + type resolution          ~2 ns
└── Total per field                      ~18 ns

100 fields × 18 ns × 1M objects/sec = 1,800 ms overhead/sec
                                       ↑ không thể JIT optimize
```

JVM JIT compiler **không thể inline** reflection calls vì chúng là dynamic dispatch → không thể eliminate.

---

## ⚡ Phần 2 — Fory JIT Compilation

### 2.1 Ý tưởng cốt lõi

Thay vì dùng reflection generic, Fory **generate bytecode chuyên biệt cho từng class** vào runtime:

```
Lần đầu serialize DocumentRecord:
─────────────────────────────────
DocumentRecord.class
        │
        ▼
  ┌─────────────────────────────────┐
  │  Fory Serializer Generator      │
  │                                 │
  │  Phân tích fields:              │
  │  - id: long                     │
  │  - name: String                 │
  │  - amount: BigDecimal           │
  │  - tags: List<String>           │
  │                                 │
  │  Generate bytecode:             │
  │  GETFIELD id → writeLong()      │
  │  GETFIELD name → writeString()  │
  │  GETFIELD amount → writeBD()    │
  │  GETFIELD tags → writeList()    │
  └─────────────────────────────────┘
        │
        ▼
  DocumentRecordSerializer.class  ← compiled, cached
        │
        ▼
  Mọi lần sau: DIRECT CALL, no reflection
```

### 2.2 So sánh bytecode

**Reflection (Kryo):**
```
// Pseudo-bytecode
ALOAD obj
INVOKEVIRTUAL Class.getDeclaredFields
ASTORE fields
ALOAD fields
ARRAYLENGTH
// loop...
INVOKEVIRTUAL Field.get    ← dynamic, không JIT được
```

**Fory generated:**
```
// Pseudo-bytecode — generated cho DocumentRecord
ALOAD obj
CHECKCAST DocumentRecord
GETFIELD DocumentRecord.id    ← DIRECT field access!
INVOKEVIRTUAL MemoryBuffer.writeLong
GETFIELD DocumentRecord.name
INVOKEVIRTUAL MemoryBuffer.writeString
// ... không có loop, không có reflection
```

→ JVM JIT **có thể inline** các GETFIELD calls → approach được tối ưu xuống native code.

### 2.3 Async compilation

```java
ThreadSafeFory fory = Fory.builder()
    .withAsyncCompilation(true)  // ← quan trọng
    .build();
```

```
Timeline:
─────────────────────────────────────────────────────
t=0ms   Request đến → serialize DocumentRecord
        Chưa có compiled serializer → fallback: interpret mode (chậm)
        Background: start compilation

t=50ms  Compiled serializer ready → cache

t=51ms  Tất cả request sau → sử dụng compiled serializer (nhanh)
─────────────────────────────────────────────────────

→ Không block production traffic trong thời gian compile
→ Tương tự JVM JIT: interpret trước, compile sau khi đủ hot
```

---

## 🚫 Phần 3 — Zero-Copy Architecture

### 3.1 Vấn đề của traditional buffer

```
TRADITIONAL FLOW (Kryo, Jackson):
──────────────────────────────────

Java Heap:                      Netty/OS Buffer:
┌──────────────┐                ┌──────────────────┐
│ MyObject     │                │ Network Buffer   │
│ (on-heap)    │                │ (off-heap)       │
└──────────────┘                └──────────────────┘
       │                                 ▲
       │  serialize                      │  send
       ▼                                 │
┌──────────────┐    COPY        ┌──────────────────┐
│ byte[]       │ ──────────────► │ DirectBuffer     │
│ (on-heap)    │                │ (off-heap)       │
└──────────────┘                └──────────────────┘
       ↑
  GC must scan + collect this
```

**Chi phí ẩn:**
- Allocate `byte[]` → GC pressure
- Copy bytes → CPU bandwidth wasted
- Young GC pause → latency spike

### 3.2 Fory Zero-Copy

```
FORY ZERO-COPY FLOW:
─────────────────────

Java Heap:                      Network/Redis:
┌──────────────┐
│ MyObject     │
│ (on-heap)    │
└──────────────┘
       │
       │ serialize trực tiếp vào
       ▼
┌──────────────────────────────┐
│ MemoryBuffer (off-heap)       │ ──────────────────► SEND
│ Wraps DirectByteBuffer        │
│ (không qua heap allocation)   │
└──────────────────────────────┘
       ↑
  Fory manages this, GC không scan
```

### 3.3 Out-of-band serialization cho large objects

Cảm hứng từ pickle5 (Python) và Ray:

```
Object chứa byte[] hoặc numpy array lớn:

WITHOUT out-of-band:
─────────────────────
[header][field1][field2]...[LARGE_BYTES_COPY_100MB]
                                     ↑ embed inline → copy

WITH out-of-band (Fory):
─────────────────────────
[header][field1][field2]...[ref_id: 0]
                                     ↑ chỉ ghi reference
OUT-OF-BAND BUFFER: [100MB original buffer]
                            ↑ zero-copy, no copy at all

→ Bên nhận reconstruct object từ metadata + out-of-band buffer
→ CPU overhead gần 0 cho large binary data
```

**Ứng dụng thực tế trong PDMS:**
```
Document scanning → PDF binary (5-50MB)
Fory zero-copy → không copy PDF bytes khi route qua services
→ throughput tăng linear với số tài liệu
```

---

## 🕸️ Phần 4 — Object Graph Serialization

### 4.1 Vấn đề circular reference

```java
// Structure phức tạp trong PDMS
class CreditFile {
    List<Document> documents;
    CreditProfile profile;
}

class Document {
    CreditFile parentFile;  // ← back-reference!
    byte[] content;
}
```

**Protobuf/Avro:** không handle được circular reference → phải flatten manually.

**Kryo:** handle được nhưng thường xuyên gặp StackOverflowError với deep graph.

**Fory — Reference tracking:**

```
Serialization process:

Gặp CreditFile (id=1):
  → write object_id: 1
  → serialize documents list
    → Gặp Document (id=2):
       → write object_id: 2
       → serialize parentFile
         → Gặp CreditFile LẠI!
           → write ref: 1  (đã thấy, chỉ ghi reference)
           → STOP, không recurse
```

```
Binary format:
┌─────────────────────────────────────────────────────────────┐
│ [0x01] NEW_OBJECT id=1 type=CreditFile                      │
│   [0x01] NEW_OBJECT id=2 type=Document                      │
│     [0x02] REF id=1  ← không copy lại CreditFile           │
│     [bytes: content]                                        │
│   [0x01] NEW_OBJECT id=3 type=Document                      │
│     [0x02] REF id=1  ← lại reference                       │
└─────────────────────────────────────────────────────────────┘

→ Không có duplicate data
→ Không có infinite loop
→ Reconstruct đúng graph structure
```

### 4.2 Polymorphism support

```java
// Interface với nhiều implementation
interface PaymentEvent { ... }
class CreditApprovalEvent implements PaymentEvent { ... }
class CreditRejectionEvent implements PaymentEvent { ... }

List<PaymentEvent> events = List.of(
    new CreditApprovalEvent(...),
    new CreditRejectionEvent(...)
);
```

**Fory lưu type information:**
```
[LIST len=2]
  [TYPE_ID: 42][CreditApprovalEvent fields...]
  [TYPE_ID: 43][CreditRejectionEvent fields...]
```

Deserialization tự động reconstruct đúng type → không cần manual type switching.

---

## 📦 Phần 5 — Binary Format Layout

### Fory message structure

```
┌────────────────────────────────────────────────────────────────┐
│                   FORY BINARY MESSAGE                          │
│                                                                │
│  ┌──────────┬───────────┬──────────────┬────────────────────┐ │
│  │ MAGIC    │ FLAGS     │ CLASS_INFO   │ OBJECT_DATA        │ │
│  │ 2 bytes  │ 1 byte    │ variable     │ variable           │ │
│  └──────────┴───────────┴──────────────┴────────────────────┘ │
│                                                                │
│  FLAGS byte:                                                   │
│  ┌─────┬─────┬─────┬──────┬──────┬─────────────────────────┐ │
│  │ IS_ │ IS_ │ IS_ │ IS_  │ IS_  │ ...reserved...          │ │
│  │ NULL│ REF │ LIST│ MAP  │ XLANG│                         │ │
│  └─────┴─────┴─────┴──────┴──────┴─────────────────────────┘ │
│                                                                │
│  OBJECT_DATA (primitive fields packed tightly):               │
│  ┌──────────┬──────────┬──────────────┬─────────────────────┐ │
│  │ long: 8B │ int: 4B  │ String: 2B+N │ nested objects...   │ │
│  └──────────┴──────────┴──────────────┴─────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

**Primitives không bị boxing:**

```
Jackson JSON:  {"id": 12345678}         → 15 bytes (string repr)
Fory binary:   [0xBC 0x61 0x4E 0x00...] → 8 bytes  (raw long)

100 records × 10 primitive fields:
JSON:  ~15KB
Fory:  ~8KB  → 47% nhỏ hơn, không cần parse
```

---

## 🔒 Phần 6 — Thread Safety Model

### ThreadSafeFory vs Fory

```java
// Fory base class — KHÔNG thread-safe
Fory fory = Fory.builder().build();
// → Phải dùng ThreadLocal hoặc pool

// ThreadSafeFory — THREAD-SAFE
ThreadSafeFory fory = Fory.builder()
    .buildThreadSafeFory();
// → Có thể inject vào Spring singleton bean

// Với ThreadLocalFory — explicit pool
ThreadLocalFory fory = Fory.builder()
    .buildThreadLocalFory();
```

**ThreadSafeFory internals:**

```
ThreadSafeFory
     │
     ├── Thread-1 → ObjectPool → [Fory instance 1]
     ├── Thread-2 → ObjectPool → [Fory instance 2]
     └── Thread-3 → ObjectPool → [Fory instance 3]
                         ↑
                  Borrow/return pattern
                  Không share state giữa threads
```

---

## 🗺️ Phần 7 — 3 Modes của Fory

```
┌─────────────────────────────────────────────────────────────────┐
│                    FORY 3 MODES                                 │
│                                                                 │
│  NATIVE MODE                                                    │
│  ───────────                                                    │
│  Java-only hoặc Python-only                                     │
│  Không write class metadata → payload nhỏ nhất                 │
│  Schema PHẢI consistent giữa reader/writer                      │
│  Use: Redis cache, internal queue, session                      │
│                                                                 │
│  COMPATIBLE MODE                                                │
│  ───────────────                                                │
│  Write class metadata (field names/types)                       │
│  Reader có thể bỏ qua field không biết                         │
│  Writer/reader có thể deploy độc lập                           │
│  Use: service version rolling deploy                            │
│                                                                 │
│  XLANG MODE                                                     │
│  ──────────                                                     │
│  Cross-language: Java ↔ Go ↔ Rust ↔ Python                    │
│  Type system normalized qua Fory type spec                     │
│  Compatible mode by default                                     │
│  Use: polyglot microservices nội bộ                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## ✅ Key Takeaways

- [ ] Fory JIT generate bytecode riêng cho từng class → tránh reflection hoàn toàn
- [ ] Zero-copy: serialize thẳng vào off-heap buffer → giảm GC pressure
- [ ] Object graph: handle circular reference + polymorphism natively
- [ ] 3 modes cho 3 mục đích: native (performance) / compatible (evolution) / xlang (polyglot)
- [ ] ThreadSafeFory → có thể dùng như Spring singleton bean

---

## 🔜 Bài tiếp theo

[[03-Fory-vs-Avro-Protobuf-Positioning]] — Khi nào dùng Fory, khi nào dùng Avro, khi nào dùng Protobuf — decision framework đầy đủ

---

## 📖 Tham khảo

- [Fory JIT Serialization Design](https://fory.apache.org/docs/guide/java_object_graph_guide)
- [Zero-copy & Buffer Management](https://fory.apache.org/docs/guide/java_object_graph_guide#zero-copy-support)
- [[01-Why-Serialization-Matters]]
