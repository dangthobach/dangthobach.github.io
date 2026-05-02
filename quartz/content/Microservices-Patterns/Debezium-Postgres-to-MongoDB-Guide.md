---
tags: [debezium, cdc, postgresql, mongodb, migration, kafka-connect, zero-to-hero]
aliases: [Postgres to Mongo Migration, CDC Migration Guide]
up: "[[Debezium-CDC-Deep-Dive]]"
created: 2026-04-15
---

# 🚀 Debezium: Migrate PostgreSQL → MongoDB — Zero to Hero

> **Mục tiêu:** Hướng dẫn toàn bộ quy trình cài đặt và vận hành Debezium để sync real-time từ PostgreSQL sang MongoDB — từ môi trường dev đơn giản nhất đến các kịch bản phức tạp như join nhiều bảng, schema transformation, xử lý edge cases và production hardening.

> **Stack:** PostgreSQL 15 → Kafka + Kafka Connect + Debezium 2.5 → MongoDB 7 (via MongoDB Sink Connector)

---

## Roadmap học tập

```
Phase 1 — Hiểu kiến trúc tổng thể         (đọc trước, đừng skip)
Phase 2 — Môi trường Dev (Docker)          (30 phút)
Phase 3 — Simple table sync               (45 phút — 1 bảng, 1:1)
Phase 4 — Multi-table + transformation    (join, reshape, denormalize)
Phase 5 — Complex joins                   (nhiều bảng → 1 MongoDB document)
Phase 6 — Edge cases & production         (tombstone, schema change, failover)
Phase 7 — Monitoring & Operations         (metrics, alerts, runbooks)
```

---

## Phase 1 — Kiến trúc tổng thể

### Luồng dữ liệu

```
PostgreSQL (source)
  └── WAL (Write-Ahead Log)
        └── Replication Slot "debezium_slot"
              └── Debezium PostgreSQL Source Connector
                    └── Kafka Topics (1 topic / table)
                          ├── pdms.public.documents
                          ├── pdms.public.contracts
                          └── pdms.public.customers
                                └── Kafka Streams / Custom Consumer  ← join logic
                                      └── MongoDB Sink Connector
                                            └── MongoDB Collections
                                                  ├── documents      (denormalized)
                                                  └── contracts
```

### Tại sao cần Kafka ở giữa?

Không thể dùng Debezium để ghi trực tiếp Postgres → MongoDB mà không qua Kafka, vì:

1. **Durability** — Kafka lưu event, consumer down 2h vẫn không mất data
2. **Fan-out** — 1 change event có thể đến nhiều consumer (Mongo, Elastic, Redis...)
3. **Join logic** — Kafka Streams cho phép join nhiều topics trước khi ghi Mongo
4. **Backpressure** — Kafka buffer giúp Mongo không bị overwhelm khi burst traffic
5. **Schema Registry** — Quản lý schema evolution tập trung

### Các component cần thiết

| Component | Image | Port | Vai trò |
|---|---|---|---|
| PostgreSQL | `postgres:15` | 5432 | Source database |
| Zookeeper | `confluentinc/cp-zookeeper:7.5` | 2181 | Kafka coordinator |
| Kafka | `confluentinc/cp-kafka:7.5` | 9092 | Message broker |
| Schema Registry | `confluentinc/cp-schema-registry:7.5` | 8081 | Schema store |
| Kafka Connect | `debezium/connect:2.5` | 8083 | Connector runtime |
| MongoDB | `mongo:7` | 27017 | Sink database |
| Kafka UI | `provectuslabs/kafka-ui` | 8080 | Monitoring UI |
| mongo-express | `mongo-express` | 8082 | MongoDB UI |

---

## Phase 2 — Môi trường Dev

### Bước 2.1 — Docker Compose

Tạo file `docker-compose.yml`:

```yaml
version: '3.8'

networks:
  debezium-net:
    driver: bridge

services:
  # ─── SOURCE ───────────────────────────────────────────
  postgres:
    image: postgres:15
    container_name: pg-source
    networks: [debezium-net]
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: pdms_db
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    command:
      - "postgres"
      - "-c" - "wal_level=logical"
      - "-c" - "max_replication_slots=4"
      - "-c" - "max_wal_senders=4"
      - "-c" - "wal_keep_size=1024"
    volumes:
      - ./init-pg.sql:/docker-entrypoint-initdb.d/init.sql
      - pg_data:/var/lib/postgresql/data

  # ─── KAFKA STACK ──────────────────────────────────────
  zookeeper:
    image: confluentinc/cp-zookeeper:7.5.0
    container_name: zookeeper
    networks: [debezium-net]
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
      ZOOKEEPER_TICK_TIME: 2000

  kafka:
    image: confluentinc/cp-kafka:7.5.0
    container_name: kafka
    networks: [debezium-net]
    depends_on: [zookeeper]
    ports: ["9092:9092"]
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092,PLAINTEXT_HOST://localhost:9092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_LOG_RETENTION_HOURS: 168
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"

  schema-registry:
    image: confluentinc/cp-schema-registry:7.5.0
    container_name: schema-registry
    networks: [debezium-net]
    depends_on: [kafka]
    ports: ["8081:8081"]
    environment:
      SCHEMA_REGISTRY_HOST_NAME: schema-registry
      SCHEMA_REGISTRY_KAFKASTORE_BOOTSTRAP_SERVERS: kafka:9092
      SCHEMA_REGISTRY_LISTENERS: http://0.0.0.0:8081

  kafka-connect:
    image: debezium/connect:2.5
    container_name: kafka-connect
    networks: [debezium-net]
    depends_on: [kafka, schema-registry, postgres]
    ports: ["8083:8083"]
    environment:
      BOOTSTRAP_SERVERS: kafka:9092
      GROUP_ID: debezium-connect-group
      CONFIG_STORAGE_TOPIC: _connect-configs
      OFFSET_STORAGE_TOPIC: _connect-offsets
      STATUS_STORAGE_TOPIC: _connect-status
      CONFIG_STORAGE_REPLICATION_FACTOR: 1
      OFFSET_STORAGE_REPLICATION_FACTOR: 1
      STATUS_STORAGE_REPLICATION_FACTOR: 1
      KEY_CONVERTER: org.apache.kafka.connect.json.JsonConverter
      VALUE_CONVERTER: org.apache.kafka.connect.json.JsonConverter
      KEY_CONVERTER_SCHEMAS_ENABLE: "false"
      VALUE_CONVERTER_SCHEMAS_ENABLE: "false"
      # MongoDB Sink Connector plugin (cài thêm)
      CONNECT_PLUGIN_PATH: /kafka/connect,/kafka/connect/mongodb

  # ─── SINK ─────────────────────────────────────────────
  mongodb:
    image: mongo:7
    container_name: mongo-sink
    networks: [debezium-net]
    ports: ["27017:27017"]
    environment:
      MONGO_INITDB_ROOT_USERNAME: admin
      MONGO_INITDB_ROOT_PASSWORD: admin
      MONGO_INITDB_DATABASE: pdms_mongo
    volumes:
      - mongo_data:/data/db

  # ─── UI TOOLS ─────────────────────────────────────────
  kafka-ui:
    image: provectuslabs/kafka-ui:latest
    container_name: kafka-ui
    networks: [debezium-net]
    depends_on: [kafka, schema-registry, kafka-connect]
    ports: ["8080:8080"]
    environment:
      KAFKA_CLUSTERS_0_NAME: local
      KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: kafka:9092
      KAFKA_CLUSTERS_0_SCHEMAREGISTRY: http://schema-registry:8081
      KAFKA_CLUSTERS_0_KAFKACONNECT_0_NAME: debezium
      KAFKA_CLUSTERS_0_KAFKACONNECT_0_ADDRESS: http://kafka-connect:8083

  mongo-express:
    image: mongo-express:latest
    container_name: mongo-express
    networks: [debezium-net]
    depends_on: [mongodb]
    ports: ["8082:8081"]
    environment:
      ME_CONFIG_MONGODB_ADMINUSERNAME: admin
      ME_CONFIG_MONGODB_ADMINPASSWORD: admin
      ME_CONFIG_MONGODB_URL: mongodb://admin:admin@mongodb:27017/

volumes:
  pg_data:
  mongo_data:
```

### Bước 2.2 — Init SQL cho PostgreSQL

Tạo `init-pg.sql`:

```sql
-- ============================================================
-- Schema: PDMS (Physical Document Management System)
-- ============================================================

-- Bảng chính: documents
CREATE TABLE IF NOT EXISTS documents (
  id            BIGSERIAL PRIMARY KEY,
  document_code VARCHAR(50) UNIQUE NOT NULL,
  title         VARCHAR(500) NOT NULL,
  doc_type      VARCHAR(50) NOT NULL,   -- CONTRACT, REPORT, INVOICE
  status        VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  customer_id   BIGINT,
  branch_id     BIGINT,
  file_path     TEXT,
  page_count    INT DEFAULT 0,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Bảng phụ: customers
CREATE TABLE IF NOT EXISTS customers (
  id            BIGSERIAL PRIMARY KEY,
  cif_code      VARCHAR(30) UNIQUE NOT NULL,
  full_name     VARCHAR(200) NOT NULL,
  phone         VARCHAR(20),
  email         VARCHAR(100),
  customer_type VARCHAR(20) DEFAULT 'INDIVIDUAL',  -- INDIVIDUAL, CORPORATE
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Bảng phụ: branches
CREATE TABLE IF NOT EXISTS branches (
  id            BIGSERIAL PRIMARY KEY,
  branch_code   VARCHAR(20) UNIQUE NOT NULL,
  branch_name   VARCHAR(200) NOT NULL,
  province      VARCHAR(100),
  region        VARCHAR(50)
);

-- Bảng phụ: contracts (1 document có thể có nhiều contracts)
CREATE TABLE IF NOT EXISTS contracts (
  id            BIGSERIAL PRIMARY KEY,
  document_id   BIGINT REFERENCES documents(id),
  contract_no   VARCHAR(100) UNIQUE NOT NULL,
  contract_type VARCHAR(50),
  signed_date   DATE,
  expire_date   DATE,
  amount        DECIMAL(20, 2),
  currency      VARCHAR(10) DEFAULT 'VND',
  status        VARCHAR(30) DEFAULT 'ACTIVE'
);

-- Bảng: document_tags (many-to-many)
CREATE TABLE IF NOT EXISTS document_tags (
  document_id BIGINT REFERENCES documents(id),
  tag         VARCHAR(100),
  PRIMARY KEY (document_id, tag)
);

-- Bảng: audit_log
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  table_name  VARCHAR(50),
  record_id   BIGINT,
  action      VARCHAR(20),
  changed_by  VARCHAR(100),
  changed_at  TIMESTAMPTZ DEFAULT now(),
  diff        JSONB
);

-- ─── REPLICA IDENTITY cho CDC ──────────────────────────
ALTER TABLE documents    REPLICA IDENTITY FULL;
ALTER TABLE customers    REPLICA IDENTITY FULL;
ALTER TABLE branches     REPLICA IDENTITY FULL;
ALTER TABLE contracts    REPLICA IDENTITY FULL;
ALTER TABLE document_tags REPLICA IDENTITY FULL;

-- ─── Publication ───────────────────────────────────────
CREATE PUBLICATION debezium_pub FOR TABLE
  documents, customers, branches, contracts, document_tags;

-- ─── Debezium user ─────────────────────────────────────
CREATE ROLE debezium_user REPLICATION LOGIN PASSWORD 'debezium_pass';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO debezium_user;
GRANT USAGE ON SCHEMA public TO debezium_user;

-- ─── Sample data ───────────────────────────────────────
INSERT INTO branches (branch_code, branch_name, province, region) VALUES
  ('HAN01', 'Chi nhánh Hà Nội', 'Hà Nội', 'NORTH'),
  ('HCM01', 'Chi nhánh TP.HCM', 'TP. Hồ Chí Minh', 'SOUTH'),
  ('DAN01', 'Chi nhánh Đà Nẵng', 'Đà Nẵng', 'CENTRAL');

INSERT INTO customers (cif_code, full_name, phone, email, customer_type) VALUES
  ('CIF001', 'Nguyễn Văn An', '0901234567', 'an@email.com', 'INDIVIDUAL'),
  ('CIF002', 'Trần Thị Bình', '0912345678', 'binh@email.com', 'INDIVIDUAL'),
  ('CIF003', 'Công ty ABC', '0281234567', 'abc@corp.com', 'CORPORATE');

INSERT INTO documents (document_code, title, doc_type, status, customer_id, branch_id, page_count) VALUES
  ('DOC-2024-001', 'Hợp đồng tín dụng ABC', 'CONTRACT', 'APPROVED', 1, 1, 10),
  ('DOC-2024-002', 'Báo cáo thẩm định BCD', 'REPORT', 'PENDING', 2, 2, 5),
  ('DOC-2024-003', 'Hồ sơ vay vốn CDE', 'CONTRACT', 'PROCESSING', 3, 1, 20);

INSERT INTO contracts (document_id, contract_no, contract_type, signed_date, expire_date, amount, status) VALUES
  (1, 'HD-2024-001-A', 'CREDIT', '2024-01-15', '2027-01-15', 500000000, 'ACTIVE'),
  (1, 'HD-2024-001-B', 'GUARANTEE', '2024-01-15', '2025-01-15', 100000000, 'ACTIVE'),
  (3, 'HD-2024-003-A', 'CREDIT', '2024-03-01', '2029-03-01', 2000000000, 'PENDING');

INSERT INTO document_tags VALUES (1, 'urgent'), (1, 'vip'), (2, 'review'), (3, 'large-loan');
```

### Bước 2.3 — Cài MongoDB Kafka Connector

Debezium image chỉ có Postgres/MySQL connector. MongoDB Sink Connector cần cài thêm:

```bash
# Option 1: Download thủ công và mount vào container
mkdir -p ./kafka-plugins/mongodb

# Download MongoDB Kafka Connector
curl -L https://search.maven.org/remotecontent?filepath=org/mongodb/kafka/mongo-kafka-connect/1.13.0/mongo-kafka-connect-1.13.0-all.jar \
  -o ./kafka-plugins/mongodb/mongo-kafka-connect-1.13.0-all.jar

# Thêm vào docker-compose kafka-connect service:
volumes:
  - ./kafka-plugins/mongodb:/kafka/connect/mongodb
```

```bash
# Option 2: Dùng confluent-hub (nếu dùng Confluent image)
confluent-hub install mongodb/kafka-connector:1.13.0
```

### Bước 2.4 — Khởi động stack

```bash
# Start toàn bộ stack
docker compose up -d

# Chờ 30s cho services khởi động, rồi kiểm tra
docker compose ps

# Verify Kafka Connect đang chạy
curl http://localhost:8083/connectors
# Expected: []

# Verify plugins có sẵn
curl http://localhost:8083/connector-plugins | jq '.[].class'
# Phải thấy:
# "io.debezium.connector.postgresql.PostgresConnector"
# "com.mongodb.kafka.connect.MongoSinkConnector"
```

---

## Phase 3 — Simple Sync: 1 bảng → 1 Collection

### Mục tiêu Phase 3

Sync bảng `documents` → MongoDB collection `documents` theo dạng 1:1, không transform.

```
PostgreSQL: documents table
  ↓ Debezium Source Connector
Kafka: pdms.public.documents topic
  ↓ MongoDB Sink Connector
MongoDB: pdms_mongo.documents collection
```

### Bước 3.1 — Tạo Debezium Source Connector

Tạo file `connectors/01-source-simple.json`:

```json
{
  "name": "pdms-pg-source-v1",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",

    "database.hostname": "postgres",
    "database.port": "5432",
    "database.user": "debezium_user",
    "database.password": "debezium_pass",
    "database.dbname": "pdms_db",
    "database.server.name": "pdms",

    "plugin.name": "pgoutput",
    "publication.name": "debezium_pub",
    "slot.name": "debezium_slot_v1",

    "table.include.list": "public.documents",

    "snapshot.mode": "initial",
    "snapshot.isolation.mode": "repeatable_read",

    "key.converter": "org.apache.kafka.connect.json.JsonConverter",
    "key.converter.schemas.enable": "false",
    "value.converter": "org.apache.kafka.connect.json.JsonConverter",
    "value.converter.schemas.enable": "false",

    "decimal.handling.mode": "string",
    "time.precision.mode": "connect",
    "interval.handling.mode": "string",

    "tombstones.on.delete": "true",

    "transforms": "unwrap",
    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.drop.tombstones": "false",
    "transforms.unwrap.delete.handling.mode": "rewrite",
    "transforms.unwrap.add.fields": "op,source.ts_ms,source.lsn",
    "transforms.unwrap.add.headers": "db,table"
  }
}
```

```bash
# Deploy connector
curl -X POST http://localhost:8083/connectors \
  -H "Content-Type: application/json" \
  -d @connectors/01-source-simple.json

# Kiểm tra status (sau 10s)
curl http://localhost:8083/connectors/pdms-pg-source-v1/status | jq
# Expected: connector.state = "RUNNING", tasks[0].state = "RUNNING"

# Kiểm tra topic đã có chưa
curl http://localhost:8083/connectors/pdms-pg-source-v1/topics | jq
```

### Bước 3.2 — Tạo MongoDB Sink Connector

Tạo `connectors/02-sink-simple.json`:

```json
{
  "name": "pdms-mongo-sink-v1",
  "config": {
    "connector.class": "com.mongodb.kafka.connect.MongoSinkConnector",

    "connection.uri": "mongodb://admin:admin@mongodb:27017",
    "database": "pdms_mongo",
    "collection": "documents",

    "topics": "pdms.public.documents",

    "key.converter": "org.apache.kafka.connect.json.JsonConverter",
    "key.converter.schemas.enable": "false",
    "value.converter": "org.apache.kafka.connect.json.JsonConverter",
    "value.converter.schemas.enable": "false",

    "document.id.strategy": "com.mongodb.kafka.connect.sink.processor.id.strategy.PartialValueStrategy",
    "document.id.strategy.partial.value.projection.list": "id",
    "document.id.strategy.partial.value.projection.type": "AllowList",

    "writemodel.strategy": "com.mongodb.kafka.connect.sink.writemodel.strategy.ReplaceOneBusinessKeyStrategy",

    "delete.on.null.values": "true",

    "max.batch.size": "100",
    "max.num.retries": "3",
    "retries.defer.timeout": "5000"
  }
}
```

```bash
# Deploy sink connector
curl -X POST http://localhost:8083/connectors \
  -H "Content-Type: application/json" \
  -d @connectors/02-sink-simple.json

# Verify MongoDB có data
docker exec -it mongo-sink mongosh -u admin -p admin --eval \
  "db.getSiblingDB('pdms_mongo').documents.find().pretty()"
```

### Bước 3.3 — Test live sync

```bash
# Kết nối PostgreSQL và INSERT thử
docker exec -it pg-source psql -U postgres -d pdms_db -c \
  "INSERT INTO documents (document_code, title, doc_type, status, customer_id, branch_id)
   VALUES ('DOC-TEST-001', 'Test Document', 'REPORT', 'PENDING', 1, 1);"

# Sau vài giây, kiểm tra MongoDB
docker exec -it mongo-sink mongosh -u admin -p admin --eval \
  "db.getSiblingDB('pdms_mongo').documents.findOne({document_code: 'DOC-TEST-001'})"

# Test UPDATE
docker exec -it pg-source psql -U postgres -d pdms_db -c \
  "UPDATE documents SET status = 'APPROVED' WHERE document_code = 'DOC-TEST-001';"

# Test DELETE
docker exec -it pg-source psql -U postgres -d pdms_db -c \
  "DELETE FROM documents WHERE document_code = 'DOC-TEST-001';"

# Verify document bị xóa khỏi MongoDB
docker exec -it mongo-sink mongosh -u admin -p admin --eval \
  "db.getSiblingDB('pdms_mongo').documents.findOne({document_code: 'DOC-TEST-001'})"
# Expected: null
```

---

## Phase 4 — Multi-table Sync + Field Transformation

### Mục tiêu Phase 4

Sync tất cả bảng, đổi tên field, thêm metadata field, filter chỉ lấy APPROVED documents.

### Bước 4.1 — Source Connector với SMT

Tạo `connectors/03-source-multi.json`:

```json
{
  "name": "pdms-pg-source-v2",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",

    "database.hostname": "postgres",
    "database.port": "5432",
    "database.user": "debezium_user",
    "database.password": "debezium_pass",
    "database.dbname": "pdms_db",
    "database.server.name": "pdms",

    "plugin.name": "pgoutput",
    "publication.name": "debezium_pub",
    "slot.name": "debezium_slot_v2",

    "table.include.list": "public.documents,public.customers,public.branches,public.contracts",

    "snapshot.mode": "initial",

    "key.converter": "org.apache.kafka.connect.json.JsonConverter",
    "key.converter.schemas.enable": "false",
    "value.converter": "org.apache.kafka.connect.json.JsonConverter",
    "value.converter.schemas.enable": "false",

    "decimal.handling.mode": "string",
    "time.precision.mode": "connect",

    "tombstones.on.delete": "true",

    "transforms": "unwrap,rename_fields,add_field_source",

    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.drop.tombstones": "false",
    "transforms.unwrap.delete.handling.mode": "rewrite",
    "transforms.unwrap.add.fields": "op,table,source.ts_ms",

    "transforms.rename_fields.type": "org.apache.kafka.connect.transforms.ReplaceField$Value",
    "transforms.rename_fields.renames": "id:pg_id,created_at:createdAt,updated_at:updatedAt",

    "transforms.add_field_source.type": "org.apache.kafka.connect.transforms.InsertField$Value",
    "transforms.add_field_source.static.field": "sync_source",
    "transforms.add_field_source.static.value": "debezium-postgresql"
  }
}
```

### Bước 4.2 — Topic-specific Sink Connectors

Mỗi bảng cần 1 Sink Connector riêng. Tạo `connectors/04-sink-multi.sh`:

```bash
#!/bin/bash
BASE_URL="http://localhost:8083/connectors"

# ─── Sink: documents ───────────────────────────────────
curl -X POST $BASE_URL -H "Content-Type: application/json" -d '{
  "name": "mongo-sink-documents",
  "config": {
    "connector.class": "com.mongodb.kafka.connect.MongoSinkConnector",
    "connection.uri": "mongodb://admin:admin@mongodb:27017",
    "database": "pdms_mongo",
    "collection": "documents",
    "topics": "pdms.public.documents",
    "key.converter": "org.apache.kafka.connect.json.JsonConverter",
    "key.converter.schemas.enable": "false",
    "value.converter": "org.apache.kafka.connect.json.JsonConverter",
    "value.converter.schemas.enable": "false",
    "document.id.strategy": "com.mongodb.kafka.connect.sink.processor.id.strategy.PartialValueStrategy",
    "document.id.strategy.partial.value.projection.list": "pg_id",
    "document.id.strategy.partial.value.projection.type": "AllowList",
    "writemodel.strategy": "com.mongodb.kafka.connect.sink.writemodel.strategy.ReplaceOneBusinessKeyStrategy",
    "delete.on.null.values": "true"
  }
}'

# ─── Sink: customers ───────────────────────────────────
curl -X POST $BASE_URL -H "Content-Type: application/json" -d '{
  "name": "mongo-sink-customers",
  "config": {
    "connector.class": "com.mongodb.kafka.connect.MongoSinkConnector",
    "connection.uri": "mongodb://admin:admin@mongodb:27017",
    "database": "pdms_mongo",
    "collection": "customers",
    "topics": "pdms.public.customers",
    "key.converter": "org.apache.kafka.connect.json.JsonConverter",
    "key.converter.schemas.enable": "false",
    "value.converter": "org.apache.kafka.connect.json.JsonConverter",
    "value.converter.schemas.enable": "false",
    "document.id.strategy": "com.mongodb.kafka.connect.sink.processor.id.strategy.PartialValueStrategy",
    "document.id.strategy.partial.value.projection.list": "pg_id",
    "document.id.strategy.partial.value.projection.type": "AllowList",
    "writemodel.strategy": "com.mongodb.kafka.connect.sink.writemodel.strategy.ReplaceOneBusinessKeyStrategy",
    "delete.on.null.values": "true"
  }
}'

echo "All sink connectors deployed!"
```

---

## Phase 5 — Complex Joins: Nhiều bảng → 1 MongoDB Document

### Vấn đề cần giải quyết

Trong PostgreSQL, dữ liệu bị normalize:

```sql
documents ──── customers   (1 document → 1 customer)
         ├─── branches    (1 document → 1 branch)
         └─── contracts[] (1 document → N contracts)
              └── document_tags[] (1 document → N tags)
```

Trong MongoDB, muốn 1 document có đầy đủ thông tin (denormalized):

```json
{
  "_id": "DOC-2024-001",
  "documentCode": "DOC-2024-001",
  "title": "Hợp đồng tín dụng ABC",
  "status": "APPROVED",
  "customer": {
    "cifCode": "CIF001",
    "fullName": "Nguyễn Văn An",
    "customerType": "INDIVIDUAL"
  },
  "branch": {
    "branchCode": "HAN01",
    "branchName": "Chi nhánh Hà Nội",
    "region": "NORTH"
  },
  "contracts": [
    { "contractNo": "HD-2024-001-A", "amount": "500000000", "status": "ACTIVE" },
    { "contractNo": "HD-2024-001-B", "amount": "100000000", "status": "ACTIVE" }
  ],
  "tags": ["urgent", "vip"]
}
```

### Giải pháp: Kafka Streams Consumer Service

Không có SMT nào xử lý được join phức tạp. Cần viết một **Kafka Streams service** hoặc **Consumer Service** để aggregate:

```
Kafka Topics (các bảng riêng lẻ)
  ├── pdms.public.documents
  ├── pdms.public.customers
  ├── pdms.public.branches
  ├── pdms.public.contracts
  └── pdms.public.document_tags
        ↓
   [Aggregation Service]  ← join logic ở đây
   (Kafka Streams / Spring Boot consumer)
        ↓
   Kafka Topic: pdms.aggregated.documents  (denormalized)
        ↓
   MongoDB Sink Connector
        ↓
   MongoDB: documents collection
```

### Bước 5.1 — Spring Boot Aggregation Service

Tạo project Spring Boot với dependencies:

```xml
<!-- pom.xml -->
<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.kafka</groupId>
    <artifactId>spring-kafka</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.data</groupId>
    <artifactId>spring-data-mongodb</artifactId>
  </dependency>
  <dependency>
    <groupId>com.fasterxml.jackson.core</groupId>
    <artifactId>jackson-databind</artifactId>
  </dependency>
</dependencies>
```

**DocumentAggregationService.java** — logic chính:

```java
@Service
@Slf4j
@RequiredArgsConstructor
public class DocumentAggregationService {

    private final MongoTemplate mongoTemplate;
    private final ObjectMapper objectMapper;

    // ─── CONSUMER: documents table ───────────────────────────
    @KafkaListener(topics = "pdms.public.documents", groupId = "doc-aggregator")
    public void onDocumentChange(
            @Payload(required = false) String payload,
            @Header(KafkaHeaders.RECEIVED_KEY) String key) {

        if (payload == null) {
            // Tombstone — xóa document khỏi MongoDB
            long docId = extractIdFromKey(key);
            mongoTemplate.remove(
                Query.query(Criteria.where("pgId").is(docId)),
                "documents"
            );
            log.info("Deleted document pgId={}", docId);
            return;
        }

        try {
            Map<String, Object> event = objectMapper.readValue(payload, Map.class);
            String op = (String) event.get("__op");

            if ("d".equals(op)) {
                long docId = ((Number) event.get("pg_id")).longValue();
                mongoTemplate.remove(
                    Query.query(Criteria.where("pgId").is(docId)),
                    "documents"
                );
                return;
            }

            // Upsert document với data từ event
            upsertDocument(event);

        } catch (Exception e) {
            log.error("Error processing document event: key={}", key, e);
            throw new RuntimeException(e); // Let Kafka retry
        }
    }

    // ─── CONSUMER: customers table ───────────────────────────
    @KafkaListener(topics = "pdms.public.customers", groupId = "doc-aggregator")
    public void onCustomerChange(
            @Payload(required = false) String payload,
            @Header(KafkaHeaders.RECEIVED_KEY) String key) {

        if (payload == null) return;

        try {
            Map<String, Object> customer = objectMapper.readValue(payload, Map.class);
            long customerId = ((Number) customer.get("pg_id")).longValue();

            // Update tất cả documents có customerId này
            mongoTemplate.updateMulti(
                Query.query(Criteria.where("customerId").is(customerId)),
                new Update()
                    .set("customer.cifCode", customer.get("cif_code"))
                    .set("customer.fullName", customer.get("full_name"))
                    .set("customer.customerType", customer.get("customer_type")),
                "documents"
            );
            log.info("Updated customer info for customerId={}", customerId);
        } catch (Exception e) {
            log.error("Error processing customer event", e);
        }
    }

    // ─── CONSUMER: contracts table ────────────────────────────
    @KafkaListener(topics = "pdms.public.contracts", groupId = "doc-aggregator")
    public void onContractChange(
            @Payload(required = false) String payload,
            @Header(KafkaHeaders.RECEIVED_KEY) String key) {

        if (payload == null) return;

        try {
            Map<String, Object> event = objectMapper.readValue(payload, Map.class);
            String op = (String) event.get("__op");
            long documentId = ((Number) event.get("document_id")).longValue();

            if ("d".equals(op)) {
                // Xóa contract khỏi array
                String contractNo = (String) event.get("contract_no");
                mongoTemplate.updateFirst(
                    Query.query(Criteria.where("pgId").is(documentId)),
                    new Update().pull("contracts",
                        new BasicDBObject("contractNo", contractNo)),
                    "documents"
                );
            } else {
                // Upsert contract trong array
                Map<String, Object> contractDoc = Map.of(
                    "contractNo", event.get("contract_no"),
                    "contractType", event.get("contract_type"),
                    "amount", event.get("amount"),
                    "currency", event.get("currency"),
                    "status", event.get("status"),
                    "signedDate", event.get("signed_date"),
                    "expireDate", event.get("expire_date")
                );

                mongoTemplate.updateFirst(
                    Query.query(Criteria.where("pgId").is(documentId)
                        .and("contracts.contractNo").ne(event.get("contract_no"))),
                    new Update().push("contracts", contractDoc),
                    "documents"
                );
                // Update nếu đã tồn tại
                mongoTemplate.updateFirst(
                    Query.query(Criteria.where("pgId").is(documentId)
                        .and("contracts.contractNo").is(event.get("contract_no"))),
                    new Update()
                        .set("contracts.$.amount", event.get("amount"))
                        .set("contracts.$.status", event.get("status")),
                    "documents"
                );
            }
        } catch (Exception e) {
            log.error("Error processing contract event", e);
        }
    }

    // ─── CONSUMER: document_tags ──────────────────────────────
    @KafkaListener(topics = "pdms.public.document_tags", groupId = "doc-aggregator")
    public void onTagChange(
            @Payload(required = false) String payload,
            @Header(KafkaHeaders.RECEIVED_KEY) String key) {

        if (payload == null) return;

        try {
            Map<String, Object> event = objectMapper.readValue(payload, Map.class);
            String op = (String) event.get("__op");
            long documentId = ((Number) event.get("document_id")).longValue();
            String tag = (String) event.get("tag");

            Query query = Query.query(Criteria.where("pgId").is(documentId));
            Update update;

            if ("d".equals(op)) {
                update = new Update().pull("tags", tag);
            } else {
                update = new Update().addToSet("tags", tag);
            }
            mongoTemplate.updateFirst(query, update, "documents");

        } catch (Exception e) {
            log.error("Error processing tag event", e);
        }
    }

    // ─── Helper: upsert document ──────────────────────────────
    private void upsertDocument(Map<String, Object> event) {
        long pgId = ((Number) event.get("pg_id")).longValue();

        // Build MongoDB document
        Document doc = new Document();
        doc.put("pgId", pgId);
        doc.put("documentCode", event.get("document_code"));
        doc.put("title", event.get("title"));
        doc.put("docType", event.get("doc_type"));
        doc.put("status", event.get("status"));
        doc.put("customerId", event.get("customer_id"));
        doc.put("branchId", event.get("branch_id"));
        doc.put("filePath", event.get("file_path"));
        doc.put("pageCount", event.get("page_count"));
        doc.put("metadata", event.get("metadata"));
        doc.put("createdAt", event.get("createdAt"));
        doc.put("updatedAt", event.get("updatedAt"));
        doc.put("syncedAt", new Date());

        // Upsert by pgId (giữ lại contracts/tags array đã có)
        mongoTemplate.upsert(
            Query.query(Criteria.where("pgId").is(pgId)),
            Update.fromDocument(doc, "contracts", "tags", "customer", "branch"),
            "documents"
        );
        log.info("Upserted document pgId={}", pgId);
    }

    private long extractIdFromKey(String key) {
        // Key format: {"id": 123}
        try {
            Map<String, Object> keyMap = objectMapper.readValue(key, Map.class);
            return ((Number) keyMap.get("id")).longValue();
        } catch (Exception e) {
            return -1;
        }
    }
}
```

### Bước 5.2 — Test Join Scenario

```bash
# 1. Kiểm tra document đã được denormalize chưa
docker exec -it mongo-sink mongosh -u admin -p admin --eval "
  db.getSiblingDB('pdms_mongo').documents.findOne(
    {documentCode: 'DOC-2024-001'},
    {_id:0}
  )
"

# 2. Cập nhật customer trong PG → phải sync sang tất cả docs của customer đó
docker exec -it pg-source psql -U postgres -d pdms_db -c "
  UPDATE customers SET full_name = 'Nguyễn Văn An (Updated)' WHERE id = 1;
"

# Verify MongoDB: customer.fullName đã update
sleep 2
docker exec -it mongo-sink mongosh -u admin -p admin --eval "
  db.getSiblingDB('pdms_mongo').documents.find(
    {customerId: 1},
    {'customer.fullName': 1, documentCode: 1}
  ).toArray()
"

# 3. Thêm contract mới
docker exec -it pg-source psql -U postgres -d pdms_db -c "
  INSERT INTO contracts (document_id, contract_no, contract_type, amount, status)
  VALUES (1, 'HD-2024-001-C', 'INSURANCE', 50000000, 'ACTIVE');
"

# Verify contracts array trong MongoDB
sleep 2
docker exec -it mongo-sink mongosh -u admin -p admin --eval "
  db.getSiblingDB('pdms_mongo').documents.findOne(
    {documentCode: 'DOC-2024-001'},
    {contracts: 1}
  )
"
```

---

## Phase 6 — Edge Cases

### Edge Case 1: Tombstone & DELETE handling

DELETE trong PostgreSQL → Debezium emit 2 messages:
1. DELETE event (`op: "d"`, `before` có data, `after` null)
2. Tombstone (key = PK, value = null)

```java
// Consumer phải handle BOTH
@KafkaListener(topics = "pdms.public.documents")
public void onMessage(
    @Payload(required = false) String payload,  // null = tombstone
    @Header(KafkaHeaders.RECEIVED_KEY) String key) {

    if (payload == null) {
        // Tombstone: xử lý delete
        handleDelete(key);
        return;
    }

    Map<String, Object> event = parse(payload);
    if ("d".equals(event.get("__op"))) {
        // DELETE event (trước tombstone)
        // payload.before có data nếu REPLICA IDENTITY FULL
        handleDelete(key);
    }
    // Không cần xử lý 2 lần nếu đã handle tombstone
}
```

### Edge Case 2: Schema thay đổi trong PostgreSQL

```sql
-- Thêm column mới
ALTER TABLE documents ADD COLUMN priority INT DEFAULT 5;
```

Debezium tự detect schema change qua WAL. Events sau đó sẽ có field `priority`. Consumer cần handle gracefully:

```java
// Dùng Map thay vì POJO strict để tránh deserialization error
Map<String, Object> event = objectMapper.readValue(payload,
    new TypeReference<Map<String, Object>>() {});

// Lấy field mới với default value nếu chưa có
Integer priority = (Integer) event.getOrDefault("priority", 5);
```

### Edge Case 3: TRUNCATE

```sql
TRUNCATE TABLE document_tags;
```

Debezium emit event `op: "t"` — không có before/after data. Consumer cần xử lý:

```java
if ("t".equals(event.get("__op"))) {
    // TRUNCATE event — xóa toàn bộ
    log.warn("TRUNCATE detected on table: {}", event.get("__table"));
    // Quyết định: có clear MongoDB collection không?
    // Thường nên alert + manual intervention hơn là auto-clear
}
```

### Edge Case 4: Large transactions

Khi 1 transaction UPDATE 100,000 rows, Debezium emit 100,000 events. Consumer cần batch:

```java
@KafkaListener(topics = "pdms.public.documents",
               containerFactory = "batchKafkaListenerContainerFactory")
public void onBatch(List<String> payloads, Acknowledgment ack) {
    // Xử lý batch tối đa 500 records
    List<Map<String, Object>> events = payloads.stream()
        .filter(Objects::nonNull)
        .map(this::parseEvent)
        .collect(toList());

    // Bulk write vào MongoDB
    List<WriteModel<Document>> writes = events.stream()
        .map(this::toReplaceOneModel)
        .collect(toList());

    if (!writes.isEmpty()) {
        mongoCollection.bulkWrite(writes,
            new BulkWriteOptions().ordered(false));
    }
    ack.acknowledge();
}
```

### Edge Case 5: Snapshot ordering race condition

Trong initial snapshot, Debezium đọc `documents` trước rồi mới đến `contracts`. Trong khoảng thời gian này, nếu có contract mới được insert, consumer có thể nhận contract event trước khi nhận document event (document chưa tồn tại trong MongoDB).

**Giải pháp: Upsert với partial update**

```java
// Khi nhận contract event, KHÔNG cần document phải tồn tại trước
// Dùng upsert = true + setOnInsert để tạo skeleton document
mongoTemplate.upsert(
    Query.query(Criteria.where("pgId").is(documentId)),
    new Update()
        .push("contracts", contractDoc)
        .setOnInsert("pgId", documentId)  // chỉ set khi document chưa tồn tại
        .setOnInsert("syncedAt", new Date()),
    "documents"
);
// Khi document event đến sau, nó sẽ fill các field còn lại
```

### Edge Case 6: Duplicate events (at-least-once)

Debezium có thể deliver event nhiều lần khi restart. Consumer PHẢI idempotent:

```java
// Dùng LSN làm idempotency key
String lsn = String.valueOf(event.get("__lsn"));
String idempotencyKey = "doc:" + pgId + ":lsn:" + lsn;

if (idempotencyStore.exists(idempotencyKey)) {
    log.debug("Duplicate event, skip: {}", idempotencyKey);
    return;
}

// Xử lý event...
processEvent(event);

// Mark processed (với TTL 7 ngày)
idempotencyStore.set(idempotencyKey, "1", Duration.ofDays(7));
```

### Edge Case 7: MongoDB write failure

```java
@KafkaListener(topics = "pdms.public.documents")
public void onMessage(String payload) {
    try {
        processEvent(payload);
    } catch (MongoException e) {
        if (isTransientError(e)) {
            // Retry sẽ được Kafka Spring handle
            throw new RetryableException(e);
        } else {
            // Permanent failure → DLQ
            dlqTemplate.send("pdms.dlq.documents", payload);
            log.error("Permanent error, sent to DLQ", e);
        }
    }
}

private boolean isTransientError(MongoException e) {
    // Network error, timeout, etc.
    return e.hasErrorLabel(MongoException.TRANSIENT_TRANSACTION_ERROR_LABEL)
        || e instanceof MongoSocketReadTimeoutException;
}
```

---

## Phase 7 — Production Hardening

### 7.1 Connector Config Production-ready

```json
{
  "name": "pdms-pg-source-prod",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",

    "database.hostname": "${env:PG_HOST}",
    "database.port": "5432",
    "database.user": "${env:PG_USER}",
    "database.password": "${env:PG_PASSWORD}",
    "database.dbname": "pdms_db",
    "database.server.name": "pdms-prod",

    "plugin.name": "pgoutput",
    "publication.name": "debezium_pub",
    "slot.name": "debezium_slot_prod",

    "table.include.list": "public.documents,public.customers,public.branches,public.contracts,public.document_tags",

    "snapshot.mode": "initial",
    "snapshot.fetch.size": "1000",

    "heartbeat.interval.ms": "10000",
    "heartbeat.action.query": "UPDATE debezium_heartbeat SET ts = now() WHERE id = 1",

    "max.queue.size": "20480",
    "max.batch.size": "2048",
    "poll.interval.ms": "500",

    "errors.tolerance": "all",
    "errors.log.enable": "true",
    "errors.log.include.messages": "true",
    "errors.deadletterqueue.topic.name": "pdms.dlq.source",
    "errors.deadletterqueue.topic.replication.factor": "3",
    "errors.deadletterqueue.context.headers.enable": "true",

    "key.converter": "io.confluent.kafka.serializers.KafkaAvroSerializer",
    "key.converter.schema.registry.url": "http://schema-registry:8081",
    "value.converter": "io.confluent.kafka.serializers.KafkaAvroSerializer",
    "value.converter.schema.registry.url": "http://schema-registry:8081",

    "transforms": "unwrap",
    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.drop.tombstones": "false",
    "transforms.unwrap.delete.handling.mode": "rewrite",
    "transforms.unwrap.add.fields": "op,table,source.ts_ms,source.lsn,source.txId"
  }
}
```

### 7.2 Monitoring Queries

```sql
-- PostgreSQL: kiểm tra replication slot lag
SELECT
  slot_name,
  confirmed_flush_lsn,
  pg_current_wal_lsn() AS current_lsn,
  pg_size_pretty(
    pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)
  ) AS lag_size,
  (EXTRACT(EPOCH FROM now()) - EXTRACT(EPOCH FROM
    pg_last_xact_replay_timestamp()
  ))::INT AS lag_seconds
FROM pg_replication_slots
WHERE slot_name = 'debezium_slot_prod';
```

```bash
# Kafka Connect: kiểm tra connector status
curl -s http://localhost:8083/connectors/pdms-pg-source-prod/status | \
  jq '{name: .name, state: .connector.state, tasks: [.tasks[] | {id:.id, state:.state}]}'

# MongoDB: kiểm tra số documents
mongosh -u admin -p admin --eval "
  db.getSiblingDB('pdms_mongo').documents.aggregate([
    { \$group: { _id: '\$status', count: { \$sum: 1 } } }
  ]).toArray()
"
```

### 7.3 Runbook: Xử lý khi connector bị FAILED

```bash
# 1. Xem lý do fail
curl http://localhost:8083/connectors/pdms-pg-source-prod/status | jq '.tasks[].trace'

# 2. Restart task (thử trước)
curl -X POST http://localhost:8083/connectors/pdms-pg-source-prod/tasks/0/restart

# 3. Nếu vẫn fail: restart toàn bộ connector
curl -X POST http://localhost:8083/connectors/pdms-pg-source-prod/restart

# 4. Nếu vẫn fail: xóa và tạo lại (GIỮ LẠI SLOT!)
# Kiểm tra slot còn tồn tại chưa
docker exec pg-source psql -U postgres -c \
  "SELECT slot_name, confirmed_flush_lsn FROM pg_replication_slots;"

# Tạo lại connector (dùng snapshot.mode=never vì slot vẫn còn)
# Thay snapshot.mode: "never" trong config
curl -X POST http://localhost:8083/connectors -d @connector-config-recovery.json

# 5. Worst case: slot bị mất → re-snapshot
# Xóa slot cũ nếu còn
docker exec pg-source psql -U postgres -c \
  "SELECT pg_drop_replication_slot('debezium_slot_prod');"
# Tạo lại với snapshot.mode: "initial"
```

---

## Checklist nhanh — Zero to Production

```
PHASE 2 — Setup
  □ docker compose up -d → tất cả services RUNNING
  □ curl :8083/connector-plugins → thấy PostgresConnector + MongoSinkConnector
  □ init-pg.sql chạy thành công → sample data có trong PG
  □ publication debezium_pub đã tạo
  □ REPLICA IDENTITY FULL đã set trên tất cả tables

PHASE 3 — Simple sync
  □ Source connector RUNNING
  □ Topic pdms.public.documents xuất hiện trong Kafka UI
  □ Sink connector RUNNING
  □ MongoDB có documents collection với 3 sample records
  □ Test INSERT → xuất hiện trong Mongo trong < 2s
  □ Test UPDATE → update trong Mongo < 2s
  □ Test DELETE → xóa khỏi Mongo < 2s

PHASE 4 — Multi-table
  □ Source connector watch tất cả 4 tables
  □ 4 Kafka topics tương ứng
  □ 4 Sink connectors tương ứng

PHASE 5 — Complex join
  □ Aggregation Service chạy và healthy
  □ documents trong MongoDB có nested customer, branch, contracts, tags
  □ Test customer update → all docs của customer đó updated trong Mongo
  □ Test contract insert → contracts array trong doc updated

PHASE 6 — Edge cases verified
  □ DELETE → tombstone handled, doc removed from Mongo
  □ TRUNCATE → alert fired, không auto-clear Mongo
  □ Duplicate event → idempotent, không double-insert
  □ Schema change (ADD COLUMN) → consumer handle gracefully

PHASE 7 — Production
  □ DLQ configured
  □ Error tolerance set
  □ Heartbeat configured
  □ Monitoring dashboard setup
  □ Runbook documented
  □ Slot lag alert < 5GB
  □ Connector status alert
```

---

## Liên kết

- [[Debezium-CDC-Deep-Dive]] — Lý thuyết nền
- [[Kafka-Configuration-Deep-Dive]] — Kafka tuning
- [[Transactional-Outbox]] — Pattern thay thế nếu không dùng CDC
- [[CQRS-Materialized-View]] — Pattern phù hợp với CDC output


---

## 🖼️ Diagrams — Visual Reference

| # | Diagram | Mô tả | File |
|---|---|---|---|
| 0 | **Interactive Stepper** | Zero-to-hero checklist có thể tick từng bước | [pg-to-mongo-00-stepper.html](diagrams/pg-to-mongo-00-stepper.html) |
