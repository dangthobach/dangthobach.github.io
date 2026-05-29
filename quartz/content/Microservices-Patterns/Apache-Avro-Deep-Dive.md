# Apache Avro — Deep Dive: Internals, Schema Evolution & Kafka Integration

> **Tags:** #avro #kafka #schema-registry #serialization #microservices #data-engineering  
> **Level:** Intermediate → Advanced  
> **Related:** [[Kafka-Configuration-Deep-Dive]] | [[gRPC-Deep-Dive]] | [[03-Fory-vs-Avro-Protobuf-Positioning]] | [[Debezium-CDC-Deep-Dive]]

---

## 🎯 Bạn sẽ học được gì?

- Avro wire format hoạt động như thế nào bên dưới (binary encoding, varint, zigzag)
- Schema evolution rules: BACKWARD, FORWARD, FULL — sự khác biệt quan trọng
- Confluent Schema Registry: magic byte, schema ID, subject naming strategies
- Kafka + Avro integration end-to-end trong Java/Spring Boot
- Anti-patterns và production pitfalls thực tế

---

## 🧬 Phần 1 — Avro Là Gì & Tại Sao Tồn Tại?

### 1.1 Nguồn gốc và design goal

Avro được tạo bởi Doug Cutting (creator của Hadoop) năm 2009 như một giải pháp serialization cho Apache Hadoop. Design goal gốc:

```
Hadoop cần đọc/ghi dữ liệu từ nhiều job khác nhau,
chạy ở nhiều thời điểm khác nhau, bởi nhiều team khác nhau.

→ "Data phải tự mô tả được (self-describing)"
→ "Schema phải đi kèm với data, không phải embedded trong code"
→ "Backward compatibility phải là default, không phải optional"
```

Đây là điểm khác biệt cốt lõi so với Protobuf:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  PROTOBUF mindset:                                          │
│  "Define contract in .proto → compile → use generated code" │
│  Schema sống trong source code, không trong data            │
│                                                             │
│  AVRO mindset:                                              │
│  "Schema đi kèm hoặc có thể resolve từ registry"           │
│  Data có thể được đọc mà không cần original code           │
│  → Spark job viết 2019 vẫn đọc được data Avro từ 2015      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Schema definition

Avro schema viết bằng JSON:

```json
{
  "type": "record",
  "name": "CreditDocument",
  "namespace": "vn.vpbank.pdms.avro",
  "doc": "Represents a credit document in PDMS",
  "fields": [
    {"name": "documentId",  "type": "string"},
    {"name": "contractId",  "type": "string"},
    {"name": "documentType","type": {"type": "enum", "name": "DocumentType",
                                    "symbols": ["HSBG", "CONTRACT", "REPORT"]}},
    {"name": "pageCount",   "type": "int"},
    {"name": "status",      "type": {"type": "enum", "name": "Status",
                                    "symbols": ["PENDING", "APPROVED", "REJECTED"]}},
    {"name": "createdAt",   "type": "long", "logicalType": "timestamp-millis"},
    {"name": "metadata",    "type": {"type": "map", "values": "string"},
                            "default": {}}
  ]
}
```

Avro hỗ trợ các primitive types: `null`, `boolean`, `int`, `long`, `float`, `double`, `bytes`, `string`

Complex types: `record`, `enum`, `array`, `map`, `union`, `fixed`

Logical types (annotation trên primitive): `date`, `time-millis`, `timestamp-millis`, `decimal`, `uuid`

---

## ⚙️ Phần 2 — Wire Format & Binary Encoding

Đây là phần hầu hết developer bỏ qua nhưng cực kỳ quan trọng để hiểu tại sao Avro compact và nhanh.

### 2.1 Không có field names trong binary

Điểm then chốt: **Avro binary không chứa field names hay field IDs**.

```
JSON (text):
  {"documentId":"doc-123","pageCount":42,"status":"APPROVED"}
  → 57 bytes, mỗi record lặp lại key names

Avro binary (schema: documentId:string, pageCount:int, status:enum):
  \x0e doc-123 \x54 \x02
  └─┘ └──────┘ └──┘ └──┘
   6     doc     84   enum
  chars  -123  (42*2) index 1

  → ~12 bytes (không có key names, không có delimiters)
```

Avro encode theo **thứ tự field trong schema**. Reader phải có schema để biết field nào đang được đọc. Đây là lý do tại sao schema phải được quản lý cẩn thận.

### 2.2 Variable-length integer encoding (Zigzag + VarInt)

Avro dùng kết hợp **zigzag encoding** + **variable-length integer** giống Protobuf:

**Zigzag encoding** — map số âm sang số dương để VarInt hiệu quả hơn:

```
 0 → 0
-1 → 1
 1 → 2
-2 → 3
 2 → 4
-n → 2n-1
 n → 2n

Formula: (n << 1) ^ (n >> 63)  [cho long]
```

**Variable-length integer** — mỗi byte dùng 7 bits cho data, 1 bit MSB làm continuation flag:

```
Giá trị 1:
  Binary:  0000 0001
  VarInt:  0000 0010  (zigzag)  → 1 byte: 0x02

Giá trị 64:
  Binary:  0100 0000
  Zigzag:  1000 0000 = 128
  VarInt:  1000 0000 0000 0001  → 2 bytes: 0x80 0x01
            │         └── continuation bit = 1 (more bytes)
            └── continuation bit = 0 (last byte)

Tại sao cần zigzag?
  -1 biểu diễn như int64: 1111...1111 (64 bits đầy)
  → VarInt thuần sẽ cần 10 bytes!
  Zigzag(-1) = 1 → chỉ cần 1 byte
```

**String encoding** — length-prefixed, UTF-8:

```
"doc-123":
  \x0e "doc-123"
   └──┘
   7*2=14 (zigzag của length 7)
```

**Array encoding** — block-based với negative count để hỗ trợ streaming:

```
[item1, item2, item3]:
  \x06          count = 3 (zigzag: 3*2=6)
  <item1 bytes>
  <item2 bytes>
  <item3 bytes>
  \x00          end of array (count = 0)

Hoặc với byte size (cho random access):
  \xFB \xFF...  ← negative block count = -(byte_size)
  \x0c          ← byte_size = 6
  <6 bytes of items>
  \x00          ← end
```

**Union encoding** — index trước, value sau:

```
Schema: ["null", "string"]

null value:   \x00                    (index 0 = null)
"hello":      \x02 \x0a hello         (index 1 = string, then string bytes)
```

**Enum encoding** — chỉ lưu index, không lưu symbol name:

```
Schema: {"type": "enum", "symbols": ["PENDING", "APPROVED", "REJECTED"]}

PENDING  → \x00
APPROVED → \x02
REJECTED → \x04
```

### 2.3 Object Container File (OCF) format

Khi Avro ghi ra file (`.avro`), format là **Object Container File**:

```
┌─────────────────────────────────────────────────────────────┐
│                  AVRO FILE STRUCTURE                        │
├─────────────────────────────────────────────────────────────┤
│  HEADER                                                     │
│  ├── Magic bytes: "Obj\x01" (4 bytes)                      │
│  ├── File metadata (Avro map):                              │
│  │   ├── "avro.schema" → JSON schema string                │
│  │   └── "avro.codec"  → "null" | "deflate" | "snappy"    │
│  └── 16-byte random sync marker                             │
├─────────────────────────────────────────────────────────────┤
│  DATA BLOCKS (repeating)                                    │
│  ├── Object count (long)                                    │
│  ├── Byte count (long)                                      │
│  ├── Serialized objects                                     │
│  └── 16-byte sync marker (same as header)                  │
├─────────────────────────────────────────────────────────────┤
│  (repeat data blocks...)                                    │
└─────────────────────────────────────────────────────────────┘
```

Sync marker cho phép: detect corruption, split file cho parallel processing (Hadoop/Spark đọc file ở offset bất kỳ bằng cách scan tìm sync marker).

---

## 🔄 Phần 3 — Schema Evolution Rules

Đây là tính năng quan trọng nhất của Avro — và cũng là phần dễ nhầm lẫn nhất.

### 3.1 Writer Schema vs Reader Schema

Avro dùng mô hình **dual-schema resolution**: reader dùng **writer schema** (schema lúc data được ghi) và **reader schema** (schema hiện tại của reader) để resolve data:

```
Producer (Writer Schema v1):           Consumer (Reader Schema v2):
┌──────────────────────────┐           ┌──────────────────────────┐
│ fields:                  │           │ fields:                  │
│   documentId: string     │ ────────► │   documentId: string     │
│   pageCount: int         │           │   pageCount: int         │
│   status: string         │           │   status: string         │
└──────────────────────────┘           │   priority: int (NEW)    │
                                       │     default: 0           │
                                       └──────────────────────────┘
```

Avro resolution algorithm:
1. Writer field có trong reader schema → copy value
2. Reader field không có trong writer schema → dùng default value
3. Writer field không có trong reader schema → skip (đọc bytes nhưng discard)

### 3.2 Ba loại compatibility

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  BACKWARD compatible (default, quan trọng nhất):               │
│  "New schema có thể đọc data được ghi bởi old schema"          │
│  → Deploy consumer TRƯỚC, producer sau                         │
│                                                                 │
│  FORWARD compatible:                                            │
│  "Old schema có thể đọc data được ghi bởi new schema"          │
│  → Deploy producer TRƯỚC, consumer sau                         │
│                                                                 │
│  FULL compatible:                                               │
│  BACKWARD + FORWARD cùng lúc                                   │
│  → Deploy theo bất kỳ thứ tự nào                               │
│                                                                 │
│  BACKWARD_TRANSITIVE / FORWARD_TRANSITIVE / FULL_TRANSITIVE:   │
│  Compatible với TẤT CẢ các version trước, không chỉ version -1 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 BACKWARD compatibility — Rules chi tiết

**Schema mới có thể đọc data cũ:**

```
✅ ALLOWED (BACKWARD safe):

1. Thêm field với default value
   v1: {documentId, pageCount}
   v2: {documentId, pageCount, priority: int = 0}  ← default bắt buộc
   → Old data không có priority → reader dùng default 0 ✅

2. Xóa field (dù field đó không có default)
   v1: {documentId, pageCount, legacyField}
   v2: {documentId, pageCount}
   → Old data có legacyField → reader skip nó ✅

3. Thêm alias cho field
   v1: {documentId}
   v2: {documentId, aliases: ["docId"]}

4. Mở rộng enum symbols
   v1: enum {PENDING, APPROVED}
   v2: enum {PENDING, APPROVED, REJECTED}  ← thêm symbol ✅

5. Mở rộng union types
   v1: union ["null", "string"]
   v2: union ["null", "string", "int"]    ← thêm type ✅
```

```
❌ BREAKING (BACKWARD unsafe):

1. Thêm field KHÔNG có default
   v2: {documentId, pageCount, priority: int}  ← NO default!
   → Old data không có priority → ERROR ❌

2. Đổi type không tương thích
   v1: pageCount: int
   v2: pageCount: string  ← không thể promote int → string ❌

3. Rename field (không dùng alias)
   v1: {documentId}
   v2: {docId}  ← reader không biết map field nào ❌

4. Xóa enum symbol (mà old data đang dùng)
   v1: enum {PENDING, APPROVED, REJECTED}
   v2: enum {PENDING, APPROVED}  ← old data có REJECTED → ❌
```

### 3.4 FORWARD compatibility — Rules chi tiết

**Schema cũ có thể đọc data mới:**

```
✅ ALLOWED (FORWARD safe):

1. Xóa field có default value
   v1: {documentId, pageCount, priority: int = 0}
   v2: {documentId, pageCount}
   → New data không có priority → old reader dùng default ✅

2. Thêm field (old reader sẽ skip)
   v1: {documentId}
   v2: {documentId, newField: string}
   → Old reader skip newField ✅
```

```
❌ BREAKING (FORWARD unsafe):

1. Xóa field KHÔNG có default
   v1: {documentId, pageCount, priority: int}  ← no default
   v2: {documentId, pageCount}
   → Old reader expects priority → missing → ERROR ❌
```

### 3.5 FULL compatibility

FULL = BACKWARD + FORWARD cùng lúc:

```
✅ ALLOWED (FULL safe):
- Thêm field với default value          (BACKWARD ✅, FORWARD ✅)
- Xóa field có default value            (BACKWARD ✅, FORWARD ✅)

❌ BREAKING (FULL unsafe):
- Thêm field không có default  (BACKWARD ❌)
- Xóa field không có default   (FORWARD ❌)
- Đổi type bất kỳ              (cả hai ❌)
- Rename field                  (cả hai ❌)
```

### 3.6 Type promotion — implicit conversions

Avro cho phép một số type promotions an toàn:

```
int    → long, float, double
long   → float, double
float  → double
string → bytes
bytes  → string
```

```json
// Writer schema: pageCount là int
{"name": "pageCount", "type": "int"}

// Reader schema: pageCount là long (BACKWARD safe)
{"name": "pageCount", "type": "long"}
```

### 3.7 Default value rules

Default value trong Avro phải match type của **nhánh đầu tiên trong union**:

```json
// ✅ ĐÚNG: null là nhánh đầu, default là null
{"name": "notes", "type": ["null", "string"], "default": null}

// ✅ ĐÚNG: string là nhánh đầu, default là string
{"name": "notes", "type": ["string", "null"], "default": ""}

// ❌ SAI: string là nhánh đầu nhưng default là null
{"name": "notes", "type": ["string", "null"], "default": null}
```

**Nullable field pattern chuẩn** trong Avro (optional field):

```json
{"name": "notes", "type": ["null", "string"], "default": null}
```

---

## 🏗️ Phần 4 — Confluent Schema Registry

### 4.1 Tại sao cần Schema Registry?

Vấn đề cơ bản khi dùng Avro với Kafka:

```
Producer phải gửi schema cùng với data:
  Option A: Gửi full JSON schema trong mỗi message
            → Overhead khổng lồ, schema (200-500 bytes) >> data (50 bytes) sometimes
            → Không có centralized governance

  Option B: Schema Registry — centralized schema store
            → Producer đăng ký schema một lần → nhận schema ID (integer)
            → Chỉ gửi 5-byte magic header + data payload
            → Consumer lookup schema từ Registry khi cần
```

### 4.2 Message wire format với Schema Registry

Confluent dùng format **5-byte magic header**:

```
┌─────────────────────────────────────────────────────────────┐
│                  KAFKA MESSAGE PAYLOAD                      │
├────┬────────────────────┬──────────────────────────────────┤
│ 0  │ Magic Byte = 0x00  │  1 byte — version marker         │
├────┼────────────────────┤                                  │
│1-4 │ Schema ID          │  4 bytes big-endian int          │
├────┼────────────────────┤                                  │
│ 5+ │ Avro binary data   │  actual payload                  │
└────┴────────────────────┴──────────────────────────────────┘

Ví dụ:
  0x00                     ← magic byte
  0x00 0x00 0x00 0x42      ← schema ID = 66
  0x0e 0x64 0x6f 0x63 ...  ← Avro binary data
```

Magic byte `0x00` quan trọng: nếu consumer nhận message không bắt đầu bằng `0x00`, biết ngay là message không dùng Schema Registry format.

### 4.3 Schema Registry subjects và naming strategies

Schema Registry lưu schema theo **subject**. Confluent hỗ trợ 3 naming strategies:

**TopicNameStrategy (default):**
```
Topic: pdms.credit.events
  → Key subject:   pdms.credit.events-key
  → Value subject: pdms.credit.events-value
```

**RecordNameStrategy:**
```
Schema: namespace.ClassName
  → Subject: vn.vpbank.pdms.avro.CreditEvent

Use case: Nhiều event types trên cùng 1 topic
          → Mỗi record type có subject riêng
          → Topic không bị gắn với 1 schema cứng
```

**TopicRecordNameStrategy:**
```
  → Subject: pdms.credit.events-vn.vpbank.pdms.avro.CreditEvent

Use case: Isolate schema per topic + per record type
```

```
┌──────────────────────┬────────────────────────────────────────┐
│ Strategy             │ Best for                               │
├──────────────────────┼────────────────────────────────────────┤
│ TopicName (default)  │ 1 event type per topic (simple setup)  │
│ RecordName           │ Multi-type topics (event bus pattern)  │
│ TopicRecordName      │ Large orgs, strict governance per topic│
└──────────────────────┴────────────────────────────────────────┘
```

### 4.4 Schema Registry compatibility config

```bash
# Set compatibility cho một subject
curl -X PUT http://schema-registry:8081/config/pdms.credit.events-value \
  -H "Content-Type: application/json" \
  -d '{"compatibility": "BACKWARD"}'

# Test schema compatibility trước khi register
curl -X POST http://schema-registry:8081/compatibility/subjects/pdms.credit.events-value/versions/latest \
  -H "Content-Type: application/json" \
  -d '{"schema": "{...new schema JSON...}"}'
# Response: {"is_compatible": true}
```

Compatibility levels:
```
BACKWARD             (default) — new reads old
FORWARD                        — old reads new
FULL                           — both directions
BACKWARD_TRANSITIVE            — new reads ALL previous versions
FORWARD_TRANSITIVE             — ALL previous read new
FULL_TRANSITIVE                — all combinations
NONE                           — no checks (dangerous in production)
```

### 4.5 Schema Registry API overview

```bash
# Register new schema
POST /subjects/{subject}/versions
Body: {"schema": "<JSON string>"}
Response: {"id": 42}

# Get schema by ID
GET /schemas/ids/42

# Get all versions of subject
GET /subjects/{subject}/versions

# Get latest version
GET /subjects/{subject}/versions/latest

# List all subjects
GET /subjects

# Soft delete subject
DELETE /subjects/{subject}

# Hard delete (permanent)
DELETE /subjects/{subject}?permanent=true
```

---

## ☕ Phần 5 — Java/Spring Boot Implementation

### 5.1 Dependencies

```xml
<!-- pom.xml -->
<dependencies>
  <dependency>
    <groupId>org.apache.avro</groupId>
    <artifactId>avro</artifactId>
    <version>1.11.3</version>
  </dependency>
  <dependency>
    <groupId>io.confluent</groupId>
    <artifactId>kafka-avro-serializer</artifactId>
    <version>7.6.0</version>
  </dependency>
  <dependency>
    <groupId>org.springframework.kafka</groupId>
    <artifactId>spring-kafka</artifactId>
  </dependency>
</dependencies>

<repositories>
  <repository>
    <id>confluent</id>
    <url>https://packages.confluent.io/maven/</url>
  </repository>
</repositories>
```

Avro code generation plugin:
```xml
<plugin>
  <groupId>org.apache.avro</groupId>
  <artifactId>avro-maven-plugin</artifactId>
  <version>1.11.3</version>
  <executions>
    <execution>
      <phase>generate-sources</phase>
      <goals><goal>schema</goal></goals>
      <configuration>
        <sourceDirectory>${project.basedir}/src/main/avro/</sourceDirectory>
        <outputDirectory>${project.basedir}/target/generated-sources/avro/</outputDirectory>
        <stringType>String</stringType>
      </configuration>
    </execution>
  </executions>
</plugin>
```

### 5.2 Schema file

```json
// src/main/avro/vn/vpbank/pdms/CreditEvent.avsc
{
  "type": "record",
  "name": "CreditEvent",
  "namespace": "vn.vpbank.pdms.avro",
  "fields": [
    {"name": "eventId",      "type": "string"},
    {"name": "eventType",    "type": "string"},
    {"name": "contractId",   "type": "string"},
    {"name": "documentId",   "type": ["null", "string"], "default": null},
    {"name": "status",       "type": {
      "type": "enum",
      "name": "CreditEventStatus",
      "symbols": ["INITIATED", "PROCESSING", "COMPLETED", "FAILED"]
    }},
    {"name": "payload",      "type": {"type": "map", "values": "string"}, "default": {}},
    {"name": "occurredAt",   "type": "long", "logicalType": "timestamp-millis"},
    {"name": "schemaVersion","type": "int",  "default": 1}
  ]
}
```

### 5.3 Producer configuration

```java
@Configuration
public class KafkaProducerConfig {

    @Bean
    public ProducerFactory<String, SpecificRecord> producerFactory() {
        Map<String, Object> props = new HashMap<>();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, KafkaAvroSerializer.class);
        props.put(KafkaAvroSerializerConfig.SCHEMA_REGISTRY_URL_CONFIG, schemaRegistryUrl);
        props.put(KafkaAvroSerializerConfig.VALUE_SUBJECT_NAME_STRATEGY,
                  TopicNameStrategy.class.getName());
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        return new DefaultKafkaProducerFactory<>(props);
    }

    @Bean
    public KafkaTemplate<String, SpecificRecord> kafkaTemplate() {
        return new KafkaTemplate<>(producerFactory());
    }
}
```

### 5.4 Consumer configuration

```java
@Configuration
public class KafkaConsumerConfig {

    @Bean
    public ConsumerFactory<String, SpecificRecord> consumerFactory() {
        Map<String, Object> props = new HashMap<>();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "pdms-document-service");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, KafkaAvroDeserializer.class);
        props.put(KafkaAvroDeserializerConfig.SCHEMA_REGISTRY_URL_CONFIG, schemaRegistryUrl);

        // true = SpecificRecord (generated class)
        // false = GenericRecord (dynamic access)
        props.put(KafkaAvroDeserializerConfig.SPECIFIC_AVRO_READER_CONFIG, true);
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
        return new DefaultKafkaConsumerFactory<>(props);
    }

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, SpecificRecord>
           kafkaListenerContainerFactory() {
        var factory = new ConcurrentKafkaListenerContainerFactory<String, SpecificRecord>();
        factory.setConsumerFactory(consumerFactory());
        factory.getContainerProperties().setAckMode(ContainerProperties.AckMode.MANUAL_IMMEDIATE);
        return factory;
    }
}
```

### 5.5 Producer service

```java
@Service
@Slf4j
public class CreditEventPublisher {

    private final KafkaTemplate<String, SpecificRecord> kafkaTemplate;

    public void publishCreditEvent(CreditEventCommand command) {
        CreditEvent event = CreditEvent.newBuilder()
            .setEventId(UUID.randomUUID().toString())
            .setEventType(command.getType())
            .setContractId(command.getContractId())
            .setDocumentId(command.getDocumentId())
            .setStatus(CreditEventStatus.INITIATED)
            .setPayload(command.getMetadata())
            .setOccurredAt(Instant.now().toEpochMilli())
            .setSchemaVersion(1)
            .build();

        kafkaTemplate.send("pdms.credit.events", command.getContractId(), event)
            .whenComplete((result, ex) -> {
                if (ex != null) {
                    log.error("Failed to publish credit event: {}", command.getEventId(), ex);
                } else {
                    log.debug("Published credit event {} partition {} offset {}",
                        command.getEventId(),
                        result.getRecordMetadata().partition(),
                        result.getRecordMetadata().offset());
                }
            });
    }
}
```

### 5.6 Consumer với GenericRecord

```java
@Service
@Slf4j
public class CreditEventConsumer {

    @KafkaListener(topics = "pdms.credit.events", groupId = "pdms-iam-service")
    public void handleCreditEvent(
            @Payload GenericRecord record,
            @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
            @Header(KafkaHeaders.OFFSET) long offset,
            Acknowledgment ack) {
        try {
            String eventType = record.get("eventType").toString();
            String contractId = record.get("contractId").toString();

            // Nullable field — GenericRecord trả về null trực tiếp
            Object docIdObj = record.get("documentId");
            String documentId = docIdObj != null ? docIdObj.toString() : null;

            processEvent(eventType, contractId, documentId, record);
            ack.acknowledge();

        } catch (Exception e) {
            log.error("Error processing event at partition {} offset {}", partition, offset, e);
            ack.nack(Duration.ofSeconds(5));
        }
    }
}
```

### 5.7 Schema evolution — migration workflow

```java
// V2 Schema: thêm field priority với default → BACKWARD compatible
// {"name": "priority", "type": "int", "default": 0}

// Consumer handle cả V1 và V2 message:
@KafkaListener(topics = "pdms.credit.events")
public void handle(GenericRecord record, Acknowledgment ack) {
    // Defensive read field mới
    Object priorityObj = record.get("priority");
    int priority = (priorityObj instanceof Integer) ? (Integer) priorityObj : 0;

    // Hoặc check schema version field
    Object versionObj = record.get("schemaVersion");
    int version = (versionObj instanceof Integer) ? (Integer) versionObj : 1;

    if (version >= 2) {
        // V2-specific logic
    }
    ack.acknowledge();
}
```

---

## ⚠️ Phần 6 — Anti-patterns & Production Pitfalls

### 6.1 Không dùng default cho nullable fields

```json
// ❌ SAI LẦM PHỔ BIẾN NHẤT
{"name": "notes", "type": ["null", "string"]}
// Thiếu "default": null → BACKWARD unsafe khi thêm field mới

// ✅ ĐÚNG
{"name": "notes", "type": ["null", "string"], "default": null}
```

### 6.2 Dùng NONE compatibility trong production

```bash
# ❌ NGUY HIỂM — không check compatibility gì cả
curl -X PUT http://schema-registry:8081/config \
  -d '{"compatibility": "NONE"}'
# Một developer thay đổi schema type → production broken ngay lập tức
```

### 6.3 Deploy sai thứ tự

```
BACKWARD strategy yêu cầu deploy đúng thứ tự:
  ✅ Consumer (new reader schema) deploy TRƯỚC
  ✅ Producer (writing new data) deploy SAU

Nếu làm ngược:
  Producer ghi V2 data → Consumer V1 không đọc được → ERROR ❌

Deploy checklist:
  □ Schema validated qua compatibility API
  □ Consumer V2 deployed và healthy
  □ Producer V2 deployed
  □ Monitor consumer lag sau deploy
```

### 6.4 Schema Registry không HA

```
Schema Registry down → Mọi producer/consumer không thể serialize/deserialize

Production best practice:
  - Minimum 3 Schema Registry instances
  - Client-side schema cache (built-in trong KafkaAvroSerializer)
  - Hoặc: Apicurio Registry với Kafka-backed storage (embedded trong Kafka)
```

### 6.5 Enum naming collision

```json
// ❌ SAI — hai record cùng namespace dùng enum tên "Status"
// CreditEvent.avsc:
{"type": "enum", "name": "Status", "symbols": ["PENDING", "DONE"]}

// DocumentEvent.avsc (cùng namespace):
{"type": "enum", "name": "Status", "symbols": ["DRAFT", "PUBLISHED"]}
// → Avro schema parser conflict!

// ✅ ĐÚNG — prefix enum name rõ ràng
{"type": "enum", "name": "CreditEventStatus", ...}
{"type": "enum", "name": "DocumentEventStatus", ...}
```

### 6.6 Circular reference

Avro không hỗ trợ circular reference:

```json
// ❌ KHÔNG THỂ
{"name": "parent", "type": ["null", "CreditFile"]}  ← circular!

// ✅ Flatten bằng ID reference
{"name": "parentFileId", "type": ["null", "string"], "default": null}
```

---

## 📊 Phần 7 — Avro vs Protobuf — Khi nào dùng cái nào?

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  Dùng AVRO khi:                                                 │
│  ✅ Kafka topics consume bởi nhiều team                        │
│  ✅ Data cần tồn tại lâu dài (data lake, Parquet, audit log)   │
│  ✅ Hệ sinh thái Hadoop/Spark/Flink                            │
│  ✅ Schema governance quan trọng (Schema Registry)             │
│  ✅ Consumer deploy không cùng lúc producer                    │
│                                                                 │
│  Dùng PROTOBUF khi:                                             │
│  ✅ gRPC service-to-service communication                       │
│  ✅ Mobile clients (protobuf-lite)                             │
│  ✅ External API với strict contract (third-party)             │
│  ✅ Code generation là first-class priority                    │
│                                                                 │
│  PDMS recommendation:                                           │
│  Kafka public topics    → Avro + Schema Registry               │
│  Internal gRPC (nếu có) → Protobuf                             │
│  Redis cache            → Fory (xem [[03]])        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## ✅ Key Takeaways

- [ ] Avro binary không chứa field names — reader cần schema để giải mã đúng thứ tự
- [ ] VarInt + Zigzag encoding: số nhỏ và số âm chiếm ít bytes hơn — nguồn gốc sự compact của Avro
- [ ] BACKWARD = new reads old → deploy **consumer trước**; FORWARD = old reads new → deploy **producer trước**
- [ ] Mọi optional field phải có `"default": null` trong union `["null", "string"]`
- [ ] Magic byte `0x00` + 4-byte schema ID = 5-byte header của mọi Confluent Avro Kafka message
- [ ] Subject naming strategy ảnh hưởng trực tiếp đến khả năng evolve schema per topic
- [ ] `BACKWARD_TRANSITIVE` an toàn hơn `BACKWARD` — check với tất cả versions, không chỉ version -1
- [ ] Không bao giờ dùng `NONE` compatibility trong production Kafka

---

## 🔗 Xem thêm

- [[Kafka-Configuration-Deep-Dive]] — Producer/Consumer tuning, retention, partitioning
- [[Kafka-Partition-and-Offset-Internals]] — Offset management, consumer group rebalance
- [[Debezium-CDC-Deep-Dive]] — Avro format trong CDC events (Debezium + Schema Registry)
- [[gRPC-Deep-Dive]] — Protobuf wire format so sánh trực tiếp với Avro
- [[03-Fory-vs-Avro-Protobuf-Positioning]] — Decision framework đầy đủ

## 📖 Tham khảo

- [Apache Avro Specification](https://avro.apache.org/docs/current/spec.html)
- [Confluent Schema Registry Docs](https://docs.confluent.io/platform/current/schema-registry/index.html)
- [Confluent Schema Evolution Guide](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)
