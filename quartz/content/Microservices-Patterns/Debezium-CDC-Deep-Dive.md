---
tags: [debezium, cdc, kafka, microservices, data-streaming, postgresql, change-data-capture]
aliases: [Debezium, CDC Deep Dive]
up: "[[00-Hub-Microservices-Patterns]]"
related: ["[[Transactional-Outbox]]", "[[CQRS-Materialized-View]]", "[[Kafka-Configuration-Deep-Dive]]"]
created: 2026-04-15
---

# 🔄 Debezium & CDC — Deep Dive

> **Một câu tóm tắt:** Debezium là một distributed platform open-source cho **Change Data Capture (CDC)** — thay vì poll DB, nó đọc trực tiếp **transaction log** của database để stream mọi thay đổi (INSERT/UPDATE/DELETE) ra Kafka theo thời gian thực, với **đảm bảo at-least-once delivery** và **zero data loss**.

---

## Phần 1 — Tại sao CDC tồn tại?

### Vấn đề: Làm sao biết DB thay đổi gì?

Trong microservices, khi service A thay đổi data, service B cần biết. Có 3 cách truyền thống:

| Cách | Cơ chế | Nhược điểm |
|---|---|---|
| **Polling** | `SELECT * WHERE updated_at > last_check` | Miss soft deletes, tốn CPU, có delay |
| **Dual write** | Code vừa write DB vừa publish event | Race condition, inconsistency nếu 1 bước fail |
| **Outbox pattern** | Write cùng transaction vào outbox table, rồi poll outbox | Polling vẫn có overhead, cần maintain outbox table |
| **CDC** | Đọc transaction log của DB | ✅ Zero overhead, không miss gì, không cần thay đổi code |

### CDC hoạt động như thế nào?

Mọi database enterprise đều có **transaction log** (Write-Ahead Log trong PostgreSQL, binlog trong MySQL, redo log trong Oracle). Đây là log ghi lại *mọi thay đổi* trước khi apply vào data file — dùng để crash recovery. CDC tận dụng log này:

```
Thay đổi xảy ra trong DB
    ↓
Database ghi vào Transaction Log (WAL)
    ↓
CDC connector đọc WAL (như một replica)
    ↓
Chuyển đổi thành event và publish lên Kafka
    ↓
Downstream consumers nhận event
```

Không cần `WHERE updated_at > ?`. Không cần thêm column. Không cần thay đổi application code.

---

## Phần 2 — Debezium tổng quan

### Debezium là gì?

Debezium là **Kafka Connect-based CDC platform** do Red Hat tạo ra, open-source (Apache License 2.0). Nó cung cấp các **connector** cho từng loại database, mỗi connector chuyên đọc transaction log của database đó.

```
┌─────────────────────────────────────────────────────────┐
│                    Debezium Platform                     │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  PostgreSQL  │  │    MySQL     │  │   MongoDB    │  │
│  │  Connector   │  │  Connector   │  │  Connector   │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   SQL Svr    │  │    Oracle    │  │  Cassandra   │  │
│  │  Connector   │  │  Connector   │  │  Connector   │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
         ↓ chạy trên ↓
┌──────────────────────────────┐
│      Kafka Connect           │
│  (distributed framework)     │
└──────────────────────────────┘
         ↓ publish vào ↓
┌──────────────────────────────┐
│          Kafka               │
└──────────────────────────────┘
```

### Các connector được hỗ trợ

| Database | Connector | Protocol/Log |
|---|---|---|
| PostgreSQL | `debezium-connector-postgres` | Logical Replication (pgoutput/wal2json) |
| MySQL/MariaDB | `debezium-connector-mysql` | Binary Log (binlog) |
| MongoDB | `debezium-connector-mongodb` | Oplog / Change Streams |
| SQL Server | `debezium-connector-sqlserver` | SQL Server CDC feature |
| Oracle | `debezium-connector-oracle` | LogMiner / Redo Log |
| Cassandra | `debezium-connector-cassandra` | Commit Log |
| Db2 | `debezium-connector-db2` | ASN Capture |

### Debezium chạy ở đâu?

**3 deployment modes:**

```
Mode 1: Kafka Connect (production recommended)
┌──────────┐    ┌──────────────────────────────┐    ┌─────────┐
│    DB    │───▶│  Kafka Connect + Debezium    │───▶│  Kafka  │
└──────────┘    │  (distributed workers)       │    └─────────┘
                └──────────────────────────────┘

Mode 2: Debezium Server (standalone, không cần Kafka)
┌──────────┐    ┌──────────────────────┐    ┌────────────────┐
│    DB    │───▶│   Debezium Server    │───▶│  Kafka / Kinesis│
└──────────┘    └──────────────────────┘    │  / Pub/Sub...  │
                                            └────────────────┘

Mode 3: Embedded Engine (trong ứng dụng Java)
┌──────────────────────────────────────────────────────────┐
│                    Java Application                       │
│   ┌──────────┐    ┌──────────────────────────────────┐   │
│   │    DB    │───▶│   Debezium Embedded Engine       │   │
│   └──────────┘    └──────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

---

## Phần 3 — Cấu trúc Event của Debezium

### Anatomy của một Change Event

Mỗi event Debezium publish ra Kafka có cấu trúc:

```json
{
  "schema": { ... },          // Avro/JSON schema mô tả cấu trúc
  "payload": {
    "before": { ... },        // Row state TRƯỚC khi thay đổi (null nếu INSERT)
    "after":  { ... },        // Row state SAU khi thay đổi (null nếu DELETE)
    "source": {
      "version": "2.5.0.Final",
      "connector": "postgresql",
      "name": "pdms-connector",
      "ts_ms": 1713168000000, // Timestamp của transaction
      "snapshot": "false",
      "db": "pdms_db",
      "sequence": "[\"24023424\",\"24023424\"]",
      "schema": "public",
      "table": "documents",
      "txId": 756,            // PostgreSQL transaction ID
      "lsn": 24023424,        // Log Sequence Number (WAL position)
      "xmin": null
    },
    "op": "u",                // c=create, u=update, d=delete, r=read(snapshot)
    "ts_ms": 1713168000123,   // Timestamp khi connector xử lý
    "transaction": {
      "id": "756:24023424",
      "total_order": 1,
      "data_collection_order": 1
    }
  }
}
```

### Operation types

| `op` | Ý nghĩa | `before` | `after` |
|---|---|---|---|
| `c` | CREATE / INSERT | `null` | Row mới |
| `u` | UPDATE | Row cũ | Row mới |
| `d` | DELETE | Row bị xóa | `null` |
| `r` | READ (snapshot) | `null` | Row hiện tại |
| `t` | TRUNCATE | `null` | `null` |

### Kafka Topic naming

Mặc định Debezium tạo topic theo pattern:

```
{connector-name}.{database}.{schema}.{table}

Ví dụ:
pdms-connector.pdms_db.public.documents
pdms-connector.pdms_db.public.contracts
pdms-connector.pdms_db.public.customers
```

Mỗi table → 1 topic riêng. Message key = Primary Key của row (để đảm bảo same partition = same key = ordering per row).

---

## Phần 4 — Debezium với PostgreSQL (Chi tiết)

### PostgreSQL Logical Replication

Debezium PostgreSQL connector dùng **Logical Replication** — một feature built-in của PostgreSQL từ version 9.4+. Cơ chế:

```
PostgreSQL WAL (Write-Ahead Log)
    ↓ decode bởi
Logical Replication Slot
    ↓ sử dụng output plugin
pgoutput (built-in, PostgreSQL 10+)  ← Debezium recommend
  hoặc wal2json (extension cần cài)
    ↓
Replication stream → Debezium connector đọc
```

**Replication Slot** là một "cursor" persistent vào WAL — PostgreSQL giữ WAL lại cho đến khi slot đọc xong. Điều này đảm bảo không mất event ngay cả khi Debezium tạm dừng.

### Cấu hình PostgreSQL

**postgresql.conf:**
```ini
# Bật logical replication
wal_level = logical

# Số lượng replication slot tối đa (1 per Debezium connector)
max_replication_slots = 4

# Số lượng WAL sender process
max_wal_senders = 4

# Giữ WAL đủ lâu (tránh mất data khi Debezium down)
wal_keep_size = 1024  # MB (PostgreSQL 13+)
```

**Tạo role và permissions:**
```sql
-- Tạo replication user
CREATE ROLE debezium_user REPLICATION LOGIN PASSWORD 'strong_password';

-- Grant quyền đọc tables (chỉ cần SELECT)
GRANT SELECT ON ALL TABLES IN SCHEMA public TO debezium_user;

-- Cho phép đọc future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO debezium_user;

-- Publication (danh sách tables Debezium theo dõi)
CREATE PUBLICATION debezium_pub FOR TABLE
  documents, contracts, customers;
-- Hoặc theo dõi tất cả tables:
-- CREATE PUBLICATION debezium_pub FOR ALL TABLES;
```

**Xác nhận REPLICA IDENTITY** (cần để có `before` image trong UPDATE/DELETE):
```sql
-- Mặc định: chỉ có PRIMARY KEY trong before image
-- FULL: có toàn bộ row trong before image (tốn WAL hơn)
ALTER TABLE documents REPLICA IDENTITY FULL;

-- Kiểm tra current setting
SELECT relname, relreplident
FROM pg_class
WHERE relname IN ('documents', 'contracts');
-- d = default (PK only), f = full, n = nothing, i = index
```

---

## Phần 5 — Cấu hình Debezium Connector

### Connector Configuration (JSON)

```json
{
  "name": "pdms-postgres-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",

    "database.hostname": "postgres-host",
    "database.port": "5432",
    "database.user": "debezium_user",
    "database.password": "strong_password",
    "database.dbname": "pdms_db",
    "database.server.name": "pdms-connector",

    "plugin.name": "pgoutput",
    "publication.name": "debezium_pub",
    "slot.name": "debezium_slot",

    "table.include.list": "public.documents,public.contracts,public.customers",

    "heartbeat.interval.ms": "10000",
    "snapshot.mode": "initial",

    "key.converter": "io.confluent.kafka.serializers.KafkaAvroSerializer",
    "value.converter": "io.confluent.kafka.serializers.KafkaAvroSerializer",
    "key.converter.schema.registry.url": "http://schema-registry:8081",
    "value.converter.schema.registry.url": "http://schema-registry:8081",

    "decimal.handling.mode": "string",
    "time.precision.mode": "connect",
    "tombstones.on.delete": "true",

    "transforms": "unwrap",
    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.drop.tombstones": "false",
    "transforms.unwrap.delete.handling.mode": "rewrite",
    "transforms.unwrap.add.fields": "op,table,lsn,source.ts_ms"
  }
}
```

### Các `snapshot.mode` options

| Mode | Ý nghĩa | Dùng khi |
|---|---|---|
| `initial` | Snapshot toàn bộ DB trước, rồi stream | Lần đầu setup |
| `initial_only` | Chỉ snapshot, không stream tiếp | Migrate data one-time |
| `never` | Bỏ qua snapshot, stream từ hiện tại | Chỉ cần events tương lai |
| `always` | Snapshot mỗi lần restart | Testing/dev |
| `when_needed` | Snapshot nếu offset không valid | Tự động recover |
| `exported` | Snapshot từ điểm đã biết trước | Consistent snapshot với replica |
| `custom` | Tự define class snapshot | Advanced use case |

---

## Phần 6 — SMT: Single Message Transformations

SMT là transformations chạy inline trong Kafka Connect pipeline, trước khi event được ghi vào Kafka.

### ExtractNewRecordState (Quan trọng nhất!)

Mặc định event Debezium có cấu trúc `{before, after, source, op}`. SMT `ExtractNewRecordState` "unwrap" nó:

**Input (raw Debezium event):**
```json
{
  "payload": {
    "before": {"id": 1, "status": "PENDING"},
    "after":  {"id": 1, "status": "APPROVED"},
    "op": "u",
    "source": { "lsn": 24023424, "ts_ms": 1713168000000 }
  }
}
```

**Output (sau ExtractNewRecordState):**
```json
{
  "id": 1,
  "status": "APPROVED",
  "__op": "u",
  "__table": "documents",
  "__lsn": 24023424,
  "__source_ts_ms": 1713168000000
}
```

Flat, dễ consume hơn. Downstream consumer không cần biết về cấu trúc Debezium.

### Các SMT thông dụng

```json
"transforms": "route,unwrap,filter",

// 1. Routing: đổi tên topic
"transforms.route.type": "org.apache.kafka.connect.transforms.ReplaceField$Value",

// 2. ExtractNewRecordState
"transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",

// 3. Filter: chỉ forward events thỏa điều kiện
"transforms.filter.type": "io.debezium.transforms.Filter",
"transforms.filter.condition": "value.op != 'd'",  // Bỏ qua DELETE events

// 4. Regex Router: đổi tên topic theo pattern
"transforms.router.type": "org.apache.kafka.connect.transforms.RegexRouter",
"transforms.router.regex": "pdms-connector\\.pdms_db\\.public\\.(.*)",
"transforms.router.replacement": "pdms.$1",
// pdms-connector.pdms_db.public.documents → pdms.documents
```

---

## Phần 7 — Snapshot

### Snapshot là gì?

Khi Debezium lần đầu kết nối với DB đã có data sẵn, nó cần "bootstrap" — đọc toàn bộ data hiện tại trước khi bắt đầu stream WAL. Đây gọi là **initial snapshot**.

### Snapshot Flow

```
1. Debezium acquire global read lock (hoặc snapshot isolation)
2. Lấy LSN (Log Sequence Number) hiện tại → làm điểm bắt đầu stream sau snapshot
3. Đọc từng bảng bằng SELECT * (hoặc keyset pagination cho bảng lớn)
4. Publish mỗi row như một event với op="r"
5. Release lock
6. Bắt đầu stream từ LSN đã lưu
```

### Incremental Snapshot (Debezium 1.6+)

Snapshot thông thường lock table → ảnh hưởng production. **Incremental Snapshot** dùng thuật toán "watermarking" để snapshot an toàn:

```sql
-- Incremental snapshot dùng signal table
-- Tạo signal table
CREATE TABLE debezium_signals (
  id VARCHAR(42) PRIMARY KEY,
  type VARCHAR(32) NOT NULL,
  data VARCHAR(2048)
);

-- Trigger incremental snapshot qua signal
INSERT INTO debezium_signals (id, type, data)
VALUES (
  'snapshot-1',
  'execute-snapshot',
  '{"data-collections": ["public.documents"]}'
);
```

Incremental snapshot đọc data theo chunks nhỏ, xen kẽ với streaming WAL events — không lock table, không ảnh hưởng production.

---

## Phần 8 — Offset Management & Durability

### Debezium lưu offset ở đâu?

Debezium lưu **offset** (vị trí đã đọc trong WAL) vào Kafka topic đặc biệt:

```
__consumer_offsets  ← không phải đây
connect-offsets     ← đây! (tên có thể config)
```

Format offset của PostgreSQL connector:
```json
{
  "lsn": 24023424,           // Log Sequence Number
  "txId": 756,               // Transaction ID
  "ts_usec": 1713168000000000 // Microseconds timestamp
}
```

### Guarantees

| Property | Debezium đảm bảo |
|---|---|
| **No data loss** | Replication slot giữ WAL cho đến khi đọc xong |
| **Ordering** | Events trong cùng transaction được ordered |
| **At-least-once** | Có thể duplicate khi restart (consumer cần idempotent) |
| **Exactly-once** | Cần kết hợp Kafka Transactions + Idempotent producer |

### Xử lý khi Debezium bị down

```
Scenario: Debezium connector crash trong 2 giờ

Timeline:
  08:00  Connector crash. Replication slot VẪN tồn tại.
  08:00  PostgreSQL giữ WAL lại (không xóa vì có slot)
  10:00  Connector restart
  10:00  Đọc offset từ connect-offsets topic
  10:00  Resume từ LSN đã lưu
  10:01  Tất cả events trong 2 giờ down được replay
  ✅ ZERO data loss
```

**Cảnh báo quan trọng:** Nếu connector down quá lâu, WAL có thể tích lũy nhiều → tốn disk. Monitor với:
```sql
-- Kiểm tra replication slot lag
SELECT slot_name, confirmed_flush_lsn, pg_current_wal_lsn(),
       pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes
FROM pg_replication_slots;
```

---

## Phần 9 — Advanced Features

### 9.1 Schema Evolution

Khi DB schema thay đổi (thêm column, đổi type), Debezium tự động xử lý:

```sql
-- Thêm column mới
ALTER TABLE documents ADD COLUMN priority INT DEFAULT 0;
```

Debezium detect schema change qua WAL, tự update schema trong Schema Registry. Events sau thay đổi sẽ có field mới.

**Lưu ý:** Với Avro serialization, cần đảm bảo schema evolution compatibility (backward/forward). Debezium tích hợp tốt với Confluent Schema Registry.

### 9.2 Topic Routing cho Multi-tenant

```json
"transforms": "route",
"transforms.route.type": "io.debezium.transforms.ByLogicalTableRouter",
"transforms.route.topic.regex": "pdms-connector\\.pdms_db\\.public\\.(.*)",
"transforms.route.topic.replacement": "pdms.all-changes",
"transforms.route.key.field.name": "table_name"
```

Merge nhiều tables vào 1 topic, thêm field `table_name` để phân biệt.

### 9.3 Outbox Event Router

Debezium có SMT chuyên dụng cho **Transactional Outbox pattern**:

```json
"transforms": "outbox",
"transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter",
"transforms.outbox.table.field.event.id": "id",
"transforms.outbox.table.field.event.key": "aggregate_id",
"transforms.outbox.table.field.event.type": "event_type",
"transforms.outbox.table.field.event.payload": "payload",
"transforms.outbox.route.topic.replacement": "pdms.${routedByValue}"
```

Khi bạn write vào outbox table, Debezium tự động route event đến đúng topic dựa trên `aggregate_type`.

### 9.4 Heartbeat Events

Khi không có data change, replication slot vẫn cần "tiến" trong WAL. Heartbeat giải quyết vấn đề này:

```json
"heartbeat.interval.ms": "30000",
"heartbeat.action.query": "UPDATE debezium_heartbeat SET ts = now() WHERE id = 1"
```

Debezium tự INSERT/UPDATE một row heartbeat → WAL tiến → slot không bị lag.

### 9.5 Signal API (Debezium 1.7+)

Điều khiển Debezium runtime thông qua signal table hoặc Kafka topic:

```sql
-- Pause connector
INSERT INTO debezium_signals VALUES ('1', 'stop', null);

-- Resume
INSERT INTO debezium_signals VALUES ('2', 'resume', null);

-- Trigger incremental snapshot
INSERT INTO debezium_signals VALUES ('3', 'execute-snapshot',
  '{"data-collections": ["public.documents"], "type": "incremental"}');

-- Log current state
INSERT INTO debezium_signals VALUES ('4', 'log', '{"message": "Current state check"}');
```

### 9.6 Notification API (Debezium 2.x)

Debezium có thể emit notification events khi có status thay đổi:

```json
"notification.enabled.channels": "sink",
"notification.sink.topic.name": "debezium-notifications"
```

Events được emit: snapshot started/completed, connector paused/resumed, schema change detected.

---

## Phần 10 — Production Deployment

### 10.1 Kafka Connect Cluster cho Debezium

```yaml
# docker-compose.yml (development)
version: '3.8'
services:
  zookeeper:
    image: confluentinc/cp-zookeeper:7.5.0
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181

  kafka:
    image: confluentinc/cp-kafka:7.5.0
    depends_on: [zookeeper]
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1

  schema-registry:
    image: confluentinc/cp-schema-registry:7.5.0
    depends_on: [kafka]
    environment:
      SCHEMA_REGISTRY_KAFKASTORE_BOOTSTRAP_SERVERS: kafka:9092
      SCHEMA_REGISTRY_HOST_NAME: schema-registry
    ports: ["8081:8081"]

  kafka-connect:
    image: debezium/connect:2.5
    depends_on: [kafka, schema-registry]
    ports: ["8083:8083"]
    environment:
      BOOTSTRAP_SERVERS: kafka:9092
      GROUP_ID: debezium-connect
      CONFIG_STORAGE_TOPIC: connect-configs
      OFFSET_STORAGE_TOPIC: connect-offsets
      STATUS_STORAGE_TOPIC: connect-status
      KEY_CONVERTER: io.apicurio.registry.utils.converter.AvroConverter
      VALUE_CONVERTER: io.apicurio.registry.utils.converter.AvroConverter

  kafka-ui:
    image: provectuslabs/kafka-ui:latest
    ports: ["8080:8080"]
    environment:
      KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: kafka:9092
      KAFKA_CLUSTERS_0_SCHEMAREGISTRY: http://schema-registry:8081
      KAFKA_CLUSTERS_0_KAFKACONNECT_0_NAME: debezium
      KAFKA_CLUSTERS_0_KAFKACONNECT_0_ADDRESS: http://kafka-connect:8083
```

### 10.2 Deploy Connector qua REST API

```bash
# Đăng ký connector
curl -X POST http://localhost:8083/connectors \
  -H "Content-Type: application/json" \
  -d @connector-config.json

# Kiểm tra status
curl http://localhost:8083/connectors/pdms-postgres-connector/status

# Pause connector
curl -X PUT http://localhost:8083/connectors/pdms-postgres-connector/pause

# Resume
curl -X PUT http://localhost:8083/connectors/pdms-postgres-connector/resume

# Xóa connector
curl -X DELETE http://localhost:8083/connectors/pdms-postgres-connector

# Xem list tất cả connectors
curl http://localhost:8083/connectors
```

### 10.3 Consumer trong Spring Boot

```java
// Dependency
// implementation 'io.debezium:debezium-api:2.5.0.Final'
// implementation 'org.springframework.kafka:spring-kafka'

@Component
@Slf4j
public class DocumentChangeConsumer {

    @KafkaListener(
        topics = "pdms-connector.pdms_db.public.documents",
        groupId = "pdms-document-sync"
    )
    public void handleDocumentChange(
            @Payload String payload,
            @Header(KafkaHeaders.RECEIVED_KEY) String key,
            @Header("__op") String operation,
            Acknowledgment ack
    ) {
        try {
            DocumentEvent event = objectMapper.readValue(payload, DocumentEvent.class);

            switch (operation) {
                case "c" -> handleInsert(event);
                case "u" -> handleUpdate(event);
                case "d" -> handleDelete(key);  // key = PK
                case "r" -> handleSnapshot(event);
            }

            ack.acknowledge();
        } catch (Exception e) {
            log.error("Failed to process document change: key={}", key, e);
            // Đưa vào DLQ hoặc retry
        }
    }

    private void handleInsert(DocumentEvent event) {
        // Sync to read model / search index / cache
        documentReadRepository.save(toReadModel(event));
    }

    private void handleUpdate(DocumentEvent event) {
        documentReadRepository.update(event.getId(), toReadModel(event));
        // Invalidate cache
        cacheService.evict("document:" + event.getId());
    }

    private void handleDelete(String key) {
        long documentId = Long.parseLong(key);
        documentReadRepository.deleteById(documentId);
    }
}
```

### 10.4 Idempotent Consumer

Vì Debezium có at-least-once delivery, consumer PHẢI idempotent:

```java
@Service
@Transactional
public class IdempotentDocumentSyncService {

    @Autowired
    private ProcessedEventRepository processedEventRepository;

    public void process(DocumentEvent event, String eventId) {
        // Check đã xử lý chưa (dùng LSN làm idempotency key)
        String idempotencyKey = "document:" + event.getId() + ":" + event.getLsn();

        if (processedEventRepository.existsByKey(idempotencyKey)) {
            log.info("Duplicate event, skipping: {}", idempotencyKey);
            return;
        }

        // Xử lý event
        syncDocumentToReadModel(event);

        // Mark as processed (cùng transaction)
        processedEventRepository.save(new ProcessedEvent(idempotencyKey));
    }
}
```

---

## Phần 11 — Monitoring & Observability

### JMX Metrics (quan trọng nhất)

Debezium expose metrics qua JMX, có thể scrape bằng Prometheus JMX Exporter:

| Metric | Ý nghĩa | Alert nếu |
|---|---|---|
| `debezium_postgres_connector_streaming_metrics_MilliSecondsBehindSource` | Lag so với DB | > 30000ms |
| `debezium_postgres_connector_streaming_metrics_NumberOfCommittedTransactions` | Transactions đã commit | N/A (info) |
| `debezium_postgres_connector_snapshot_metrics_TotalTableCount` | Số tables trong snapshot | N/A |
| `debezium_postgres_connector_streaming_metrics_QueueTotalCapacity` | Queue capacity | N/A |
| `debezium_postgres_connector_streaming_metrics_QueueRemainingCapacity` | Queue còn lại | < 10% |
| `debezium_postgres_connector_streaming_metrics_NumberOfEventsFiltered` | Events bị filter | Spike |

### Grafana Dashboard Query

```promql
# Lag theo dõi real-time
debezium_postgres_connector_streaming_metrics_MilliSecondsBehindSource{connector="pdms-connector"}

# Throughput events/sec
rate(debezium_postgres_connector_streaming_metrics_NumberOfCommittedTransactions[1m])

# Replication slot lag (PostgreSQL side)
pg_replication_slot_lag_bytes{slot_name="debezium_slot"}
```

### Log4j Configuration

```xml
<!-- Trong Kafka Connect log4j.properties -->
log4j.logger.io.debezium=INFO
log4j.logger.io.debezium.connector.postgresql=DEBUG  <!-- dev only -->
log4j.logger.io.debezium.relational.history=INFO
```

---

## Phần 12 — Debezium vs Alternatives

| Feature | Debezium | Maxwell | Airbyte CDC | Custom WAL reader |
|---|---|---|---|---|
| License | Open source (Red Hat) | Open source | Open source | N/A |
| Databases | 9+ | MySQL only | 20+ | Custom |
| Delivery guarantee | At-least-once | At-least-once | At-least-once | Custom |
| Schema evolution | ✅ Tốt | ❌ Yếu | ✅ Tốt | Manual |
| Kafka dependency | ✅ Native | ✅ Native | ❌ Optional | Custom |
| Maturity | ★★★★★ | ★★★ | ★★★★ | — |
| Community | Rất lớn | Nhỏ | Lớn | — |
| PDMS fit | ✅ Best | ❌ Chỉ MySQL | ⚠️ Overweight | ❌ |

---

## Phần 13 — Patterns kết hợp với Debezium

### CDC + CQRS

```
Write Side (PostgreSQL - documents table)
    ↓ Debezium reads WAL
Kafka topic: pdms.documents
    ↓ Consumer
Read Side (Elasticsearch / Redis)
    - Full-text search index
    - Denormalized view for fast queries
```

### CDC + Event Sourcing

```
Debezium không phải Event Sourcing (nó đọc state changes, không phải domain events).
Tuy nhiên có thể kết hợp:

[Event Store] → Debezium CDC → Kafka → [Projections]

Hoặc dùng Debezium với Outbox table chứa domain events.
```

### CDC + Outbox (Transactional Outbox với CDC)

Thay vì polling outbox table (traditional outbox), dùng Debezium để stream outbox table:

```sql
-- Outbox table
CREATE TABLE outbox_events (
  id UUID PRIMARY KEY,
  aggregate_type VARCHAR(100),
  aggregate_id BIGINT,
  event_type VARCHAR(100),
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

```java
// Application code: write domain event + business logic trong 1 transaction
@Transactional
public void approveDocument(Long documentId) {
    Document doc = documentRepo.findById(documentId);
    doc.setStatus(Status.APPROVED);
    documentRepo.save(doc);

    // Debezium sẽ pick up event này từ WAL
    outboxRepo.save(OutboxEvent.of(
        "Document", documentId,
        "DocumentApproved",
        new DocumentApprovedPayload(documentId, doc.getApprovedBy())
    ));
    // Không cần gọi Kafka trực tiếp!
}
```

Debezium + Outbox Event Router SMT tự động route event đến topic đúng.

---

## Phần 14 — Common Pitfalls

### Pitfall 1: Không set REPLICA IDENTITY

```sql
-- Nếu không set REPLICA IDENTITY FULL, UPDATE event sẽ không có before image
-- DELETE event sẽ không có data gì ngoài PK

-- Kiểm tra
SELECT relname, relreplident FROM pg_class WHERE relname = 'documents';
-- Nếu kết quả là 'd' (default = PK only), UPDATE before chỉ có PK

-- Fix
ALTER TABLE documents REPLICA IDENTITY FULL;
```

### Pitfall 2: WAL accumulation

Nếu Debezium connector down trong thời gian dài, replication slot ngăn PostgreSQL xóa WAL cũ → disk đầy:

```sql
-- Monitor slot lag
SELECT slot_name,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS lag
FROM pg_replication_slots;

-- Nếu lag quá lớn và connector không thể catch up, drop slot
-- (sẽ mất data, cần re-snapshot)
SELECT pg_drop_replication_slot('debezium_slot');
```

**Giải pháp:** Set alert khi lag > threshold. Config `max_slot_wal_keep_size` (PostgreSQL 13+) để tự drop slot nếu quá lớn.

### Pitfall 3: Tombstone messages và log compaction

Khi Debezium phát DELETE event, nó emit 2 messages:
1. DELETE event (with `before` data)
2. **Tombstone** (key = PK, value = null)

Tombstone cần thiết để Kafka log compaction xóa record với key đó. Nếu consumer không handle null value:

```java
@KafkaListener(topics = "pdms.documents")
public void consume(@Payload(required = false) String payload, String key) {
    if (payload == null) {
        // Tombstone message - record đã bị delete
        handleTombstone(key);
        return;
    }
    // Process normal event
}
```

### Pitfall 4: Schema Registry với Avro

Nếu schema thay đổi không tương thích (remove required field), consumer cũ sẽ fail deserialize. Enforce schema compatibility:

```bash
# Set compatibility level
curl -X PUT http://schema-registry:8081/config/pdms.documents-value \
  -H "Content-Type: application/json" \
  -d '{"compatibility": "BACKWARD"}'
```

### Pitfall 5: DDL changes mà không update connector

```sql
-- DROP TABLE mà connector đang watch → connector error
-- Phải pause connector trước khi DROP TABLE

curl -X PUT http://localhost:8083/connectors/pdms-postgres-connector/pause
-- Thực hiện DDL
curl -X PUT http://localhost:8083/connectors/pdms-postgres-connector/resume
```

---

## Phần 15 — Áp dụng vào PDMS

### Use case 1: Sync data từ document service sang search index

```
pdms_document DB (PostgreSQL)
    ↓ Debezium
Kafka: pdms.documents, pdms.contracts
    ↓ Consumer
Elasticsearch (full-text search)
Redis (cache cho hot documents)
```

**Lợi ích so với Outbox pattern hiện tại:**
- Không cần maintain outbox table
- Không cần polling scheduler
- Real-time (< 100ms lag vs 5-10s polling interval)

### Use case 2: AuthZ cache invalidation

```
authz_service DB (permissions table)
    ↓ Debezium
Kafka: pdms.permissions
    ↓ Consumer (tất cả services)
Mỗi service invalidate local cache khi permission thay đổi
```

Giải quyết vấn đề **Local Cache với Kafka invalidation** mà vault đã document.

### Use case 3: Audit log

```
Mọi tables trong PDMS
    ↓ Debezium (không cần thay đổi application code)
Kafka: pdms.audit.*
    ↓ Consumer
TimescaleDB / S3 (long-term audit storage)
```

---

## Quick Reference

```bash
# Debezium REST API cheat sheet

# Tạo connector
POST /connectors

# List connectors
GET /connectors

# Status
GET /connectors/{name}/status

# Config
GET /connectors/{name}/config
PUT /connectors/{name}/config   # Update config

# Control
PUT /connectors/{name}/pause
PUT /connectors/{name}/resume
POST /connectors/{name}/restart

# Xóa
DELETE /connectors/{name}

# Tasks
GET /connectors/{name}/tasks
POST /connectors/{name}/tasks/{taskId}/restart

# Plugins
GET /connector-plugins
```

---

## Liên kết trong vault

- [[Transactional-Outbox]] — Pattern bổ trợ / thay thế
- [[CQRS-Materialized-View]] — Use case chính của CDC
- [[Kafka-Configuration-Deep-Dive]] — Kafka config kết hợp với Debezium
- [[PDMS-AuthZ-Sync-Strategy-Comparison]] — CDC là 1 trong các strategies đã so sánh
- [[01-Data-Consistency]] — Context rộng hơn về Data Consistency patterns


---

## 🖼️ Diagrams — Visual Reference

> Các file HTML standalone trong `diagrams/`. Mở bằng browser hoặc plugin Obsidian hỗ trợ HTML.

| # | Diagram | Mô tả | File |
|---|---|---|---|
| 1 | **Tại sao CDC?** | So sánh Polling vs Dual Write vs CDC | [debezium-01-why-cdc.html](diagrams/debezium-01-why-cdc.html) |
| 2 | **Kiến trúc tổng quan** | WAL → Debezium → Kafka → Consumers | [debezium-02-architecture.html](diagrams/debezium-02-architecture.html) |
| 3 | **Event Anatomy** | Interactive: before/after/op/source | [debezium-03-event-anatomy.html](diagrams/debezium-03-event-anatomy.html) |
| 4 | **Durability Timeline** | Zero data loss khi connector down | [debezium-04-durability.html](diagrams/debezium-04-durability.html) |
| 5 | **Outbox + PDMS** | Debezium kết hợp Transactional Outbox | [debezium-05-outbox-pdms.html](diagrams/debezium-05-outbox-pdms.html) |
