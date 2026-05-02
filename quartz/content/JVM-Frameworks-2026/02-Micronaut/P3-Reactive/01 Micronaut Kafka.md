---
tags: [micronaut, kafka, messaging, reactive]
created: 2026-04-12
status: active
week: 13
phase: P3-Reactive
framework: micronaut
---

# Micronaut Kafka

## 📌 One-liner
> Micronaut Kafka dùng `@KafkaListener` (giống Spring Kafka!) và `@KafkaClient` (compile-time generated producer) — syntax gần với Spring nhất trong tất cả frameworks, nhưng compile-time benefits vẫn còn nguyên.

---

## 🆚 Spring Kafka vs Micronaut Kafka

| | Spring Kafka | Micronaut Kafka |
|--|-------------|-----------------|
| Consumer | `@KafkaListener` | `@KafkaListener` (giống!) |
| Producer | `KafkaTemplate` (inject bean) | `@KafkaClient` (declarative interface) |
| Reactive | Reactor Kafka (complex) | RxJava / Reactive Streams native |
| Batch | `@KafkaListener(batch=true)` | `@KafkaListener` + `List<T>` |
| Config | `spring.kafka.*` | `kafka.*` |
| Transactions | `@Transactional` + `KafkaTransactionManager` | `@KafkaTransaction` |

---

## 🔧 Configuration

```yaml
# application.yml
kafka:
  bootstrap:
    servers: ${KAFKA_BROKERS:`localhost:9092`}
  consumers:
    default:
      session:
        timeout:
          ms: 30000
      auto:
        offset:
          reset: earliest
  producers:
    default:
      acks: all
      retries: 3
```

---

## 💻 Consumer — @KafkaListener

```java
@KafkaListener(groupId = "pdms-processor")
public class DocumentEventListener {

    @Inject
    DocumentService documentService;

    // Simple consumer
    @Topic("pdms.document.events")
    public void receive(DocumentEvent event) {
        documentService.process(event);
    }

    // Với offset/partition info
    @Topic("pdms.document.events")
    public void receiveWithMeta(
            @KafkaKey String key,
            DocumentEvent event,
            long offset,
            int partition,
            @Header("X-Correlation-ID") String correlationId) {
        log.info("Key={}, offset={}, partition={}", key, offset, partition);
        documentService.process(event);
    }

    // Batch consumer
    @Topic("pdms.document.events")
    public void receiveBatch(List<DocumentEvent> events) {
        log.info("Processing batch: {}", events.size());
        documentService.processBatch(events);
    }

    // Reactive consumer
    @Topic("pdms.document.events")
    public Single<Void> receiveReactive(DocumentEvent event) {
        return documentService.processAsync(event)
            .toCompletable()
            .toSingle(() -> null);
    }
}
```

---

## 💻 Producer — @KafkaClient

```java
// Declarative producer interface (compile-time generated)
@KafkaClient
public interface DocumentEventProducer {

    @Topic("pdms.document.events")
    void send(@KafkaKey String documentId, DocumentEvent event);

    // Reactive producer
    @Topic("pdms.notifications")
    Single<RecordMetadata> sendReactive(NotificationEvent event);

    // Với custom headers
    @Topic("pdms.document.events")
    void sendWithHeaders(
        @KafkaKey String key,
        DocumentEvent event,
        @Header("X-Source") String source,
        @Header("X-Timestamp") long timestamp
    );
}

// Inject và dùng
@Singleton
public class DocumentService {

    @Inject
    DocumentEventProducer producer;

    @Transactional
    public Document create(CreateDocRequest req) {
        Document doc = saveDocument(req);

        producer.send(
            doc.getId().toString(),
            new DocumentEvent("CREATED", doc.getId(), Instant.now())
        );

        return doc;
    }
}
```

---

## 🔧 Error Handling & DLQ

```java
@KafkaListener(groupId = "pdms-processor",
               errorStrategy = @ErrorStrategy(
                   value = ErrorStrategyValue.RETRY_EXPONENTIALLY,
                   retryDelay = "100ms",
                   retryDelayMultiplier = 2,
                   maxRetries = 3
               ))
public class DocumentEventListener {

    @Topic("pdms.document.events")
    public void receive(DocumentEvent event) throws Exception {
        try {
            documentService.process(event);
        } catch (NonRetryableException e) {
            // Publish sang DLQ thủ công
            dlqProducer.send(event.documentId(), new DLQEvent(event, e));
        }
    }
}
```

---

## ✅ Practice Checklist
- [ ] Setup `@KafkaListener` consume từ topic
- [ ] Tạo `@KafkaClient` interface producer
- [ ] Implement batch consumer với `List<T>`
- [ ] Test với embedded Kafka (`@MicronautTest`)

## 🔗 Liên quan
- [[02 Compile-time AOP]]
- [[../../01-Quarkus/P3-Reactive/03 SmallRye Kafka]]
- [[MOC-Distributed-Systems]]

## 📖 Nguồn
- https://micronaut-projects.github.io/micronaut-kafka/
