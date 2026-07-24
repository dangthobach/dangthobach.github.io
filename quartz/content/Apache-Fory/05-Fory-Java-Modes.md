---
type: course
domain: data/serialization
status: active
created: 2026-05-28
updated: 2026-05-28
tags: []
---

# 05 — Fory Java Modes: Native, Compatible, XLang

> **Series:** [[00-MOC-Apache-Fory-Series]]  
> **Tags:** #apache-fory #java #schema-evolution #modes #xlang  
> **Level:** Intermediate  
> **Prerequisite:** [[04-Fory-Java-Quickstart]]

---

## 🎯 Bạn sẽ học được gì?

- 3 modes của Fory và trade-off của từng mode
- Schema evolution: thêm/xóa/rename field an toàn
- CompatibleMode: SCHEMA_CONSISTENT vs COMPATIBLE
- XLang mode: Java serialize, Go/Rust deserialize
- Chiến lược chọn mode theo context

---

## 🗺️ Phần 1 — Overview: 3 Modes

```
┌──────────────────────────────────────────────────────────────────┐
│                     FORY SERIALIZATION MODES                     │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  NATIVE MODE  (Language.JAVA)                               │ │
│  │  ─────────────────────────────────────────────────────────  │ │
│  │  Chỉ Java ↔ Java                                           │ │
│  │  Không write metadata → payload nhỏ nhất                   │ │
│  │  Writer và reader PHẢI cùng schema                         │ │
│  │                                                             │ │
│  │  Performance: ★★★★★  Flexibility: ★★☆☆☆                  │ │
│  │  Use: Redis cache, internal state, single-team Kafka        │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  COMPATIBLE MODE  (Language.JAVA + CompatibleMode)          │ │
│  │  ─────────────────────────────────────────────────────────  │ │
│  │  Chỉ Java ↔ Java nhưng tolerant với schema changes         │ │
│  │  Write field metadata → reader có thể skip unknown fields  │ │
│  │  Hỗ trợ rolling deploy (writer/reader version khác nhau)   │ │
│  │                                                             │ │
│  │  Performance: ★★★★☆  Flexibility: ★★★★☆                  │ │
│  │  Use: Kafka internal topics, session store, rolling deploy  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  XLANG MODE  (Language.XLANG)                               │ │
│  │  ─────────────────────────────────────────────────────────  │ │
│  │  Java ↔ Go ↔ Rust ↔ Python ↔ JavaScript                   │ │
│  │  Normalized type system, compatible by default             │ │
│  │  Cần register type trên TẤT CẢ language implementations   │ │
│  │                                                             │ │
│  │  Performance: ★★★★☆  Flexibility: ★★★★★                  │ │
│  │  Use: Polyglot microservices nội bộ                        │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## ⚙️ Phần 2 — Native Mode Deep Dive

### 2.1 Cấu hình và binary layout

```java
ThreadSafeFory fory = Fory.builder()
    .withLanguage(Language.JAVA)
    .withCompatibleMode(CompatibleMode.SCHEMA_CONSISTENT) // default
    .requireClassRegistration(true)
    .build();
```

**Binary payload layout:**

```
SCHEMA_CONSISTENT binary:
┌────────┬──────────┬────────────────────────────────────────────┐
│ MAGIC  │ TYPE_ID  │  FIELD_VALUES (packed, no names/types)     │
│ 2 bytes│ 2 bytes  │  id: [long 8B] name: [len+bytes] ...       │
└────────┴──────────┴────────────────────────────────────────────┘

→ Không có field name, không có type info
→ Reader phải biết chính xác schema để parse
→ Payload nhỏ nhất có thể
```

### 2.2 Khi nào dùng Native/SCHEMA_CONSISTENT

```
✅ Phù hợp khi:
─────────────────
- Redis cache: put/get cùng service version
- In-memory session replication trong cluster (same version)
- Internal message passing không persist (in-memory queue)

❌ KHÔNG phù hợp khi:
──────────────────────
- Kafka topic (consumer có thể lag behind, đọc message cũ với schema cũ)
- Lưu vào database
- Bất kỳ nơi nào writer/reader có thể có schema khác nhau
```

### 2.3 Schema consistency enforcement

```java
// v1 schema
class CreditDocument {
    Long id;
    String code;
    BigDecimal amount;
}

// v2 schema — thêm field
class CreditDocument {
    Long id;
    String code;
    BigDecimal amount;
    String newField; // thêm mới
}
```

```
Native mode behavior:
─────────────────────
v1 serializes → [id][code][amount]
v2 tries to deserialize → reads [id][code][amount][MISSING newField]
                         → đọc sai vị trí → data corruption hoặc exception

→ PHẢI deploy writer và reader cùng lúc (hard cutover)
→ Không hỗ trợ rolling deploy
```

---

## 🔄 Phần 3 — Compatible Mode Deep Dive

### 3.1 Cấu hình

```java
ThreadSafeFory fory = Fory.builder()
    .withLanguage(Language.JAVA)
    .withCompatibleMode(CompatibleMode.COMPATIBLE) // ← key change
    .requireClassRegistration(true)
    .build();
```

### 3.2 Binary layout với metadata

```
COMPATIBLE binary:
┌────────┬──────────┬─────────────────────────────────────────────────┐
│ MAGIC  │ TYPE_ID  │  FIELD_COUNT │ [FIELD_ID │ TYPE │ VALUE] × N    │
│ 2 bytes│ 2 bytes  │  2 bytes     │ per field                        │
└────────┴──────────┴─────────────────────────────────────────────────┘

→ Mỗi field có FIELD_ID (hash của field name)
→ Reader có thể skip field không biết
→ Reader có thể dùng default value cho field thiếu
→ Payload lớn hơn ~15-20% so với SCHEMA_CONSISTENT
```

### 3.3 Schema evolution rules

```java
// v1 — baseline
class CreditDocument {
    Long id;           // field hash: 0x1A2B
    String code;       // field hash: 0x3C4D
    BigDecimal amount; // field hash: 0x5E6F
}

// v2 — safe changes
class CreditDocument {
    Long id;                     // ✅ unchanged
    String code;                 // ✅ unchanged
    BigDecimal amount;           // ✅ unchanged
    String newField;             // ✅ ADD field → v1 reader ignores it
    // String removedField;      // ✅ REMOVE field → v2 reader uses null
}

// v3 — UNSAFE changes
class CreditDocument {
    Long id;
    String code;
    // ❌ RENAME: amount → totalAmount → field hash changes → data lost
    BigDecimal totalAmount;
    // ❌ CHANGE TYPE: String → Integer → deserialization exception
    Integer status; // was String
}
```

**Safe evolution rules:**

```
┌───────────────────┬──────────┬───────────────────────────────┐
│ Change type       │ Safe?    │ Note                          │
├───────────────────┼──────────┼───────────────────────────────┤
│ Add field         │ ✅ YES   │ Old reader ignores it         │
│ Remove field      │ ✅ YES   │ New reader gets null/default  │
│ Rename field      │ ❌ NO    │ Hash changes → data lost      │
│ Change type       │ ❌ NO    │ Deserialization exception     │
│ Reorder fields    │ ✅ YES   │ Field-ID based, not position  │
│ Add method        │ ✅ YES   │ Methods not serialized        │
└───────────────────┴──────────┴───────────────────────────────┘
```

### 3.4 Rolling deploy với Compatible mode

```
Kafka Internal Topic — Rolling deploy scenario:

t=0:  Consumer v1 running, Producer v1 running
      Kafka: [v1 messages]

t=1:  Deploy Producer v2 (thêm field `branch`)
      Kafka: [v1 messages][v2 messages with branch field]
      Consumer v1 vẫn chạy, đọc v2 messages → ignore `branch` field ✅

t=2:  Deploy Consumer v2 (đọc được `branch` field)
      Consumer v2 đọc v1 messages → `branch` = null (default) ✅
      Consumer v2 đọc v2 messages → `branch` = "Hanoi" ✅

→ Zero-downtime migration, no hard cutover needed
```

---

## 🌐 Phần 4 — XLang Mode Deep Dive

### 4.1 Tại sao cần XLang?

```
Vấn đề của Java native serialization cho polyglot:
───────────────────────────────────────────────────

Java types:     int, long, String, BigDecimal, LocalDateTime
Go types:       int32, int64, string, *big.Float, time.Time
Rust types:     i32, i64, String, f64, chrono::DateTime

→ Không có mapping tự nhiên
→ Fory XLang normalize qua một type system chung
```

### 4.2 Fory Type System

```
┌─────────────────────────────────────────────────────────────────┐
│                  FORY XLANG TYPE MAPPING                        │
│                                                                 │
│  Fory Type    │ Java         │ Go          │ Rust               │
│  ─────────────┼──────────────┼─────────────┼────────────────    │
│  bool         │ boolean      │ bool        │ bool               │
│  int8         │ byte         │ int8        │ i8                 │
│  int16        │ short        │ int16       │ i16                │
│  int32        │ int          │ int32       │ i32                │
│  int64        │ long         │ int64       │ i64                │
│  float32      │ float        │ float32     │ f32                │
│  float64      │ double       │ float64     │ f64                │
│  string       │ String       │ string      │ String             │
│  binary       │ byte[]       │ []byte      │ Vec<u8>            │
│  list<T>      │ List<T>      │ []T         │ Vec<T>             │
│  map<K,V>     │ Map<K,V>     │ map[K]V     │ HashMap<K,V>       │
│  timestamp    │ Instant      │ time.Time   │ chrono::DateTime   │
└─────────────────────────────────────────────────────────────────┘
```

### 4.3 Java XLang setup

```java
// Java side
ThreadSafeFory fory = Fory.builder()
    .withLanguage(Language.XLANG)  // ← XLang mode
    .requireClassRegistration(true)
    .build();

// Register với type ID phải match ở Go/Rust side
fory.register(CreditEvent.class, 200);
```

```java
// CreditEvent — chỉ dùng XLang-compatible types
public class CreditEvent {
    private long eventId;         // int64 ✅
    private String eventType;     // string ✅
    private double amount;        // float64 ✅ (BigDecimal KHÔNG hỗ trợ xlang)
    private long timestampMs;     // int64 (epoch ms, không dùng LocalDateTime)
    private Map<String, String> metadata; // map<string,string> ✅
    private List<String> tags;    // list<string> ✅
}
```

### 4.4 Go side

```go
// go.mod
// require github.com/apache/fory/go/fory v0.11.2

package main

import (
    "github.com/apache/fory/go/fory"
)

type CreditEvent struct {
    EventId     int64             `fory:"eventId"`
    EventType   string            `fory:"eventType"`
    Amount      float64           `fory:"amount"`
    TimestampMs int64             `fory:"timestampMs"`
    Metadata    map[string]string `fory:"metadata"`
    Tags        []string          `fory:"tags"`
}

func main() {
    f := fory.NewFory(true) // ref tracking enabled

    // Type ID phải MATCH Java side (200)
    f.RegisterTagType("CreditEvent", CreditEvent{})

    // Deserialize bytes từ Java
    var event CreditEvent
    err := f.Deserialize(bytes, &event)
    if err != nil {
        panic(err)
    }

    fmt.Printf("Event: %+v\n", event)
}
```

### 4.5 Rust side

```rust
// Cargo.toml
// fory = "0.11"

use fory::{Fory, Serializable};

#[derive(Debug, Serializable)]
#[fory(tag = "CreditEvent", type_id = 200)]
pub struct CreditEvent {
    pub event_id: i64,
    pub event_type: String,
    pub amount: f64,
    pub timestamp_ms: i64,
    pub metadata: std::collections::HashMap<String, String>,
    pub tags: Vec<String>,
}

fn main() {
    let fory = Fory::new();

    // Deserialize bytes từ Java
    let event: CreditEvent = fory.deserialize(&bytes).unwrap();
    println!("Event: {:?}", event);
}
```

### 4.6 XLang data flow trong PDMS

```
┌─────────────────────────────────────────────────────────────────┐
│                    POLYGLOT DATA FLOW                           │
│                                                                 │
│  pdms-document-service (Java)                                   │
│  ─────────────────────────────                                  │
│  CreditEvent event = new CreditEvent(...);                      │
│  byte[] bytes = fory.serialize(event); // XLang mode           │
│  kafka.send("internal-credit-events", bytes);                   │
│                                                                 │
│          │ Kafka bytes                                          │
│          ▼                                                      │
│  pdms-analytics-agent (Go)           pdms-ml-service (Rust)    │
│  ─────────────────────────           ──────────────────────     │
│  f.Deserialize(bytes, &event)        fory.deserialize(&bytes)   │
│  processInGo(event)                  processInRust(event)       │
│                                                                 │
│  → Không cần REST API, không cần Protobuf IDL                  │
│  → Cùng byte stream, multiple consumers                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📊 Phần 5 — Mode Selection Framework

### Decision matrix

```
Câu hỏi 1: Có cross-language requirement?
─────────────────────────────────────────
YES → XLANG mode
NO  → tiếp theo

Câu hỏi 2: Có schema thay đổi với rolling deploy?
──────────────────────────────────────────────────
YES → COMPATIBLE mode
NO  → tiếp theo

Câu hỏi 3: Performance-critical (cache, hot path)?
───────────────────────────────────────────────────
YES → SCHEMA_CONSISTENT (native, fastest)
NO  → COMPATIBLE (safe default)
```

### Mapping với PDMS components

```
┌────────────────────────────────────────┬───────────────────────┐
│ Component                              │ Mode                  │
├────────────────────────────────────────┼───────────────────────┤
│ Redis document cache                   │ SCHEMA_CONSISTENT     │
│ Redis auth/JWT cache                   │ SCHEMA_CONSISTENT     │
│ Kafka internal events (same team)      │ COMPATIBLE            │
│ Session state replication              │ COMPATIBLE            │
│ Java → Go analytics agent              │ XLANG                 │
│ Java → Rust ML service                 │ XLANG                 │
│ Kafka multi-team topics                │ Avro (không dùng Fory)│
└────────────────────────────────────────┴───────────────────────┘
```

---

## 🧪 Phần 6 — Test Schema Evolution

```java
@Test
void shouldBeCompatibleAcrossSchemaVersions() {
    // Simulate v1 writer
    ThreadSafeFory v1Fory = Fory.builder()
        .withLanguage(Language.JAVA)
        .withCompatibleMode(CompatibleMode.COMPATIBLE)
        .requireClassRegistration(true)
        .build();
    v1Fory.register(CreditDocumentV1.class, 100);

    // Simulate v2 reader
    ThreadSafeFory v2Fory = Fory.builder()
        .withLanguage(Language.JAVA)
        .withCompatibleMode(CompatibleMode.COMPATIBLE)
        .requireClassRegistration(true)
        .build();
    v2Fory.register(CreditDocumentV2.class, 100); // same type ID!

    // V1 serialize
    CreditDocumentV1 v1Doc = new CreditDocumentV1(1L, "HSBG-001", new BigDecimal("5000000"));
    byte[] bytes = v1Fory.serialize(v1Doc);

    // V2 deserialize — should not throw
    CreditDocumentV2 v2Doc = (CreditDocumentV2) v2Fory.deserialize(bytes);

    assertThat(v2Doc.getId()).isEqualTo(1L);
    assertThat(v2Doc.getCode()).isEqualTo("HSBG-001");
    assertThat(v2Doc.getNewField()).isNull(); // new field → null default
}
```

---

## ✅ Key Takeaways

- [ ] SCHEMA_CONSISTENT: nhanh nhất, nhưng hard coupling writer/reader schema
- [ ] COMPATIBLE: rolling deploy safe, thêm/xóa field không breaking
- [ ] XLANG: multi-language, type system normalized — cần match type_id trên tất cả langs
- [ ] XLang KHÔNG support: BigDecimal, LocalDateTime → dùng double, long epoch ms
- [ ] Test schema evolution trước khi deploy Kafka consumers
- [ ] Type ID phải global unique và stable — maintain 1 registry document

---

## 🔜 Bài tiếp theo

[[06-Fory-Java-Spring-Redis-Cache]] — Tích hợp Fory vào Spring Boot Redis cache: production-grade config, monitoring, migration từ Jackson

---

## 📖 Tham khảo

- [Fory Compatible Mode Docs](https://fory.apache.org/docs/guide/java_object_graph_guide#compatible-mode)
- [Fory XLang Type System](https://fory.apache.org/docs/guide/xlang_object_graph_guide)
- [[04-Fory-Java-Quickstart]]
