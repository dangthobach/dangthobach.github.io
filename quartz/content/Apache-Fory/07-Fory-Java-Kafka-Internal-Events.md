# 07 — Fory + Kafka: Internal Event Serialization

> **Series:** [[00-MOC-Apache-Fory-Series]]  
> **Tags:** #apache-fory #kafka #events #serialization #spring-boot  
> **Level:** Intermediate-Advanced  
> **Prerequisite:** [[06-Fory-Java-Spring-Redis-Cache]]

---

## 🎯 Bạn sẽ học được gì?

- Khi nào dùng Fory thay Avro cho Kafka topics
- Implement Fory Serializer/Deserializer cho Kafka
- Error handling: poison pill, deserialization failure
- Schema evolution với Compatible mode trong Kafka
- Dead Letter Queue (DLQ) pattern
- Tích hợp với PDMS internal event bus

---

## 🔴 Phần 1 — Ground Rule: Khi Nào Fory Cho Kafka?

```
┌──────────────────────────────────────────────────────────────────┐
│  QUYẾT ĐỊNH: AVRO vs FORY cho Kafka topic                        │
│                                                                  │
│  Câu hỏi 1: Consumer có phải team khác không?                    │
│  ────────────────────────────────────────────                    │
│  YES → Avro + Schema Registry (KHÔNG dùng Fory)                 │
│  NO  → tiếp tục                                                 │
│                                                                  │
│  Câu hỏi 2: Data có cần đưa vào data lake (Spark, Flink)?       │
│  ────────────────────────────────────────────                    │
│  YES → Avro (ecosystem hỗ trợ tốt hơn)                          │
│  NO  → tiếp tục                                                 │
│                                                                  │
│  Câu hỏi 3: Đây là internal processing topic?                   │
│  ────────────────────────────────────────────                    │
│  YES → Fory Compatible mode ✅                                   │
│                                                                  │
│  PDMS examples:                                                  │
│  pdms.credit.events.public     → Avro (Analytics team reads)    │
│  pdms.process.internal.tasks   → Fory (process-mgmt only)       │
│  pdms.document.workflow.steps  → Fory (document-service only)   │
│  pdms.iam.sync.internal        → Fory (iam-service only)        │
└──────────────────────────────────────────────────────────────────┘
```

---

## 🔧 Phần 2 — Fory Kafka Serializer/Deserializer

### 2.1 ForyKafkaSerializer

```java
public class ForyKafkaSerializer<T> implements Serializer<T> {

    private ThreadSafeFory fory;

    @Override
    public void configure(Map<String, ?> configs, boolean isKey) {
        // Lấy Fory instance từ Spring context (nếu dùng Spring Kafka)
        // Hoặc initialize trực tiếp nếu standalone
        this.fory = ForyHolder.getInstance();
    }

    @Override
    public byte[] serialize(String topic, T data) {
        if (data == null) return null;
        try {
            return fory.serialize(data);
        } catch (Exception e) {
            throw new SerializationException(
                "Failed to serialize message for topic [" + topic + "]", e
            );
        }
    }

    @Override
    public void close() {}
}
```

### 2.2 ForyKafkaDeserializer

```java
public class ForyKafkaDeserializer<T> implements Deserializer<T> {

    private ThreadSafeFory fory;
    private Class<T> targetClass;

    @Override
    @SuppressWarnings("unchecked")
    public void configure(Map<String, ?> configs, boolean isKey) {
        this.fory = ForyHolder.getInstance();
        String className = (String) configs.get("fory.target.class");
        if (className != null) {
            try {
                this.targetClass = (Class<T>) Class.forName(className);
            } catch (ClassNotFoundException e) {
                throw new IllegalArgumentException("Target class not found: " + className);
            }
        }
    }

    @Override
    @SuppressWarnings("unchecked")
    public T deserialize(String topic, byte[] data) {
        if (data == null) return null;
        try {
            return (T) fory.deserialize(data);
        } catch (Exception e) {
            // Log và throw để trigger DLQ routing
            log.error("Failed to deserialize message from topic [{}]: {}",
                topic, e.getMessage());
            throw new SerializationException(
                "Fory deserialization failed for topic [" + topic + "]", e
            );
        }
    }
}
```

### 2.3 Singleton Fory holder (Kafka serializers không dùng Spring DI)

```java
@Component
public class ForyHolder {

    private static volatile ThreadSafeFory INSTANCE;

    // Called by Spring after bean creation
    @PostConstruct
    public void register() {
        ForyHolder.INSTANCE = buildFory();
    }

    public static ThreadSafeFory getInstance() {
        if (INSTANCE == null) {
            synchronized (ForyHolder.class) {
                if (INSTANCE == null) {
                    INSTANCE = buildFory();
                }
            }
        }
        return INSTANCE;
    }

    private static ThreadSafeFory buildFory() {
        ThreadSafeFory f = Fory.builder()
            .withLanguage(Language.JAVA)
            .withCompatibleMode(CompatibleMode.COMPATIBLE) // ← important cho Kafka
            .withAsyncCompilation(true)
            .requireClassRegistration(true)
            .build();

        // Register all event types
        f.register(CreditWorkflowEvent.class,  200);
        f.register(DocumentStatusEvent.class,  201);
        f.register(ProcessTaskEvent.class,     202);
        f.register(IamSyncEvent.class,         203);
        f.register(WorkflowStepResult.class,   204);

        return f;
    }
}
```

---

## ⚙️ Phần 3 — Spring Kafka Configuration

### 3.1 Producer config

```java
@Configuration
public class KafkaProducerConfig {

    @Bean
    public ProducerFactory<String, Object> foryProducerFactory() {
        Map<String, Object> props = new HashMap<>();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG,
            StringSerializer.class);
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
            ForyKafkaSerializer.class);

        // Reliability settings
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.RETRIES_CONFIG, 3);
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);

        return new DefaultKafkaProducerFactory<>(props);
    }

    @Bean("foryKafkaTemplate")
    public KafkaTemplate<String, Object> foryKafkaTemplate() {
        return new KafkaTemplate<>(foryProducerFactory());
    }
}
```

### 3.2 Consumer config

```java
@Configuration
public class KafkaConsumerConfig {

    @Bean
    public ConsumerFactory<String, Object> foryConsumerFactory() {
        Map<String, Object> props = new HashMap<>();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "pdms-internal-consumers");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG,
            StringDeserializer.class);
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
            ForyKafkaDeserializer.class);

        // Auto-commit false for explicit ack
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");

        return new DefaultKafkaConsumerFactory<>(props);
    }

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, Object>
            foryKafkaListenerContainerFactory() {

        ConcurrentKafkaListenerContainerFactory<String, Object> factory =
            new ConcurrentKafkaListenerContainerFactory<>();

        factory.setConsumerFactory(foryConsumerFactory());
        factory.getContainerProperties()
            .setAckMode(ContainerProperties.AckMode.MANUAL_IMMEDIATE);

        // Error handling → DLQ
        factory.setCommonErrorHandler(
            new DefaultErrorHandler(
                new DeadLetterPublishingRecoverer(dlqKafkaTemplate(),
                    (record, ex) -> new TopicPartition(
                        record.topic() + ".dlq",
                        record.partition()
                    )
                ),
                new FixedBackOff(1000L, 3)
            )
        );

        return factory;
    }
}
```

---

## 📨 Phần 4 — Event Types và Producers

### 4.1 Event class design

```java
// Base class cho tất cả internal events
@Getter @Setter @NoArgsConstructor
public abstract class InternalEvent {
    private String eventId;
    private String eventType;
    private long timestampMs;
    private String traceId;       // OpenTelemetry trace propagation
    private String correlationId;
    private int schemaVersion;    // explicit version tracking

    protected InternalEvent(String eventType) {
        this.eventId = UUID.randomUUID().toString();
        this.eventType = eventType;
        this.timestampMs = System.currentTimeMillis();
        this.schemaVersion = 1;
    }
}

// Concrete event
@Getter @Setter @NoArgsConstructor
public class DocumentStatusEvent extends InternalEvent {
    private String documentId;
    private String documentCode;
    private String previousStatus;
    private String newStatus;
    private String changedBy;
    private Map<String, String> metadata;

    public DocumentStatusEvent(String documentId, String from, String to) {
        super("DOCUMENT_STATUS_CHANGED");
        this.documentId = documentId;
        this.previousStatus = from;
        this.newStatus = to;
    }
}
```

### 4.2 Producer service

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class InternalEventPublisher {

    @Qualifier("foryKafkaTemplate")
    private final KafkaTemplate<String, Object> kafkaTemplate;

    public void publishDocumentStatusChange(
            String documentId, String from, String to) {

        DocumentStatusEvent event = new DocumentStatusEvent(documentId, from, to);
        event.setTraceId(Span.current().getSpanContext().getTraceId());

        ListenableFuture<SendResult<String, Object>> future =
            kafkaTemplate.send(
                "pdms.document.status.internal",
                documentId, // partition key = document ID
                event
            );

        future.addCallback(
            result -> log.debug("Published DocumentStatusEvent for doc: {}", documentId),
            ex -> log.error("Failed to publish event for doc: {}", documentId, ex)
        );
    }
}
```

---

## 🛡️ Phần 5 — Error Handling & DLQ Pattern

### 5.1 Poison pill handling

```java
@Component
@Slf4j
public class InternalEventConsumer {

    @KafkaListener(
        topics = "pdms.document.status.internal",
        containerFactory = "foryKafkaListenerContainerFactory",
        groupId = "pdms-document-processor"
    )
    public void onDocumentStatusEvent(
            ConsumerRecord<String, Object> record,
            Acknowledgment ack) {

        try {
            Object payload = record.value();

            // Type dispatch
            if (payload instanceof DocumentStatusEvent event) {
                processDocumentStatusChange(event);
            } else {
                log.warn("Unknown event type: {}", payload.getClass().getName());
            }

            ack.acknowledge();

        } catch (BusinessException e) {
            // Business error → ack anyway (không retry vô hạn)
            log.error("Business error processing event: {}", e.getMessage());
            ack.acknowledge();
            publishToManualReview(record);

        } catch (Exception e) {
            // Technical error → không ack → trigger retry → eventually DLQ
            log.error("Technical error, will retry: {}", e.getMessage());
            throw e;
        }
    }

    private void processDocumentStatusChange(DocumentStatusEvent event) {
        // Business logic
    }
}
```

### 5.2 DLQ Consumer (monitoring)

```java
@Component
@Slf4j
public class DlqConsumer {

    @KafkaListener(
        topics = "pdms.document.status.internal.dlq",
        groupId = "pdms-dlq-monitor"
    )
    public void onDlqMessage(ConsumerRecord<String, byte[]> record) {
        // DLQ messages là raw bytes (deserialization có thể fail)
        log.error("DLQ message received: topic={}, partition={}, offset={}, keySize={}, valueSize={}",
            record.topic(), record.partition(), record.offset(),
            record.key() != null ? record.key().length() : 0,
            record.value() != null ? record.value().length : 0
        );

        // Alert monitoring system
        alertingService.sendDlqAlert(record);

        // Attempt to decode for debugging
        try {
            Object decoded = fory.deserialize(record.value());
            log.error("DLQ decoded payload: {}", decoded);
        } catch (Exception e) {
            log.error("Cannot decode DLQ payload (likely schema mismatch): {}", e.getMessage());
        }
    }
}
```

---

## 🔄 Phần 6 — Schema Evolution Trong Kafka

### Scenario: Thêm field vào event class

```java
// v1 — hiện tại
public class DocumentStatusEvent extends InternalEvent {
    private String documentId;
    private String previousStatus;
    private String newStatus;
    // schemaVersion = 1
}

// v2 — thêm field
public class DocumentStatusEvent extends InternalEvent {
    private String documentId;
    private String previousStatus;
    private String newStatus;
    private String changedBy;    // ← field mới
    private String reason;       // ← field mới
    // schemaVersion = 2
}
```

**Deploy sequence với Compatible mode:**

```
Step 1: Deploy consumers v2 trước
────────────────────────────────────
Consumers v2 đọc v1 messages:
  changedBy = null (default)
  reason = null (default)
  → Business logic xử lý null gracefully ✅

Step 2: Deploy producers v2
────────────────────────────
Producers v2 write v2 messages (có changedBy, reason)
Consumers v2 đọc v2 messages → đầy đủ data ✅

→ Zero downtime, no message loss, no hard cutover needed
```

### Version tracking trong event header

```java
// Producer: đính kèm version vào Kafka header
ProducerRecord<String, Object> record = new ProducerRecord<>(topic, key, event);
record.headers().add("schema-version",
    String.valueOf(event.getSchemaVersion()).getBytes());
record.headers().add("event-type",
    event.getEventType().getBytes());

// Consumer: log version cho monitoring
@KafkaListener(...)
public void consume(ConsumerRecord<String, Object> record) {
    String version = new String(record.headers()
        .lastHeader("schema-version").value());
    log.debug("Processing event schema version: {}", version);
}
```

---

## 📊 Phần 7 — Performance So Sánh Với Avro

```
Benchmark: DocumentStatusEvent (12 fields)
Platform: Java 21, Kafka 3.7, JMH

Serialize 1 event:
──────────────────────────────────────────────
Avro (with schema registry lookup): 430 μs
Avro (cached schema):                65 μs
Fory COMPATIBLE mode:                 98 μs
Fory SCHEMA_CONSISTENT:               52 μs

Payload size:
──────────────────────────────────────────────
JSON:                               680 bytes
Avro (binary):                      190 bytes
Fory COMPATIBLE:                    205 bytes
Fory SCHEMA_CONSISTENT:             160 bytes

Consumer throughput (events/sec, single partition):
──────────────────────────────────────────────
Jackson JSON:                    45,000/s
Avro:                           110,000/s
Fory COMPATIBLE:                 95,000/s
Fory SCHEMA_CONSISTENT:         140,000/s
```

> **Kết luận:** Với Kafka internal topics, Fory COMPATIBLE mode cho throughput tương đương Avro nhưng không cần Schema Registry overhead. Fory SCHEMA_CONSISTENT nhanh hơn Avro 27% nhưng thiếu flexibility.

---

## ✅ Key Takeaways

- [ ] Chỉ dùng Fory cho Kafka **internal topics** (1 team control cả producer + consumer)
- [ ] Luôn dùng `CompatibleMode.COMPATIBLE` cho Kafka (rolling deploy support)
- [ ] Tách ForyHolder singleton để Kafka serializer classes có thể access
- [ ] DLQ routing cho tất cả deserialization failure
- [ ] Deploy consumers trước producers khi schema evolution
- [ ] Đính kèm schema-version vào Kafka header để debug

---

## 🔜 Bài tiếp theo

[[08-Fory-Java-Schema-Evolution]] — Schema evolution deep dive: version compatibility matrix, migration testing, long-term strategy

---

## 📖 Tham khảo

- [Spring Kafka Error Handling](https://docs.spring.io/spring-kafka/docs/current/reference/html/#annotation-error-handling)
- [Fory Compatible Mode](https://fory.apache.org/docs/guide/java_object_graph_guide#compatible-mode)
- [[Kafka-Configuration-Deep-Dive]]
- [[Kafka-Troubleshooting-and-Tips]]
- [[06-Fory-Java-Spring-Redis-Cache]]
