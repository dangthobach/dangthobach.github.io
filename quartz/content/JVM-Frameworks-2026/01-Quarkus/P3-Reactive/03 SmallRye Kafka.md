---
tags: [quarkus, kafka, smallrye, reactive-messaging]
created: 2026-04-12
status: active
week: 6
phase: P3-Reactive
framework: quarkus
---

# SmallRye Kafka — Reactive Messaging

## 📌 One-liner
> SmallRye Reactive Messaging là abstraction layer cho messaging (Kafka, AMQP, MQTT...) trong Quarkus — dùng `@Incoming` / `@Outgoing` thay vì `@KafkaListener` / `KafkaTemplate` như Spring Kafka.

---

## 🆚 Spring Kafka vs SmallRye

| | Spring Kafka | SmallRye (Quarkus) |
|--|-------------|-------------------|
| Consumer | `@KafkaListener` | `@Incoming("channel")` |
| Producer | `KafkaTemplate.send()` | `@Outgoing("channel")` hoặc Emitter |
| Batch consume | `@KafkaListener(batch=true)` | `@Incoming` + `Message<List<T>>` |
| Error handling | `@RetryableTopic`, DLT | `@OnOverflow`, failure strategy config |
| Reactive | Spring Kafka Reactive (phức tạp) | Native — return `Uni<T>` / `Multi<T>` |
| Serialization | `JsonDeserializer<T>` | `@Deserialization` hoặc Jackson auto |
| Config | `spring.kafka.*` | `mp.messaging.*` (MicroProfile) |

---

## 🔧 Configuration

```properties
# application.properties

# === CONSUMER ===
mp.messaging.incoming.document-events.connector=smallrye-kafka
mp.messaging.incoming.document-events.topic=pdms.document.events
mp.messaging.incoming.document-events.group.id=pdms-processor
mp.messaging.incoming.document-events.value.deserializer=io.quarkus.kafka.client.serialization.JsonbDeserializer

# === PRODUCER ===
mp.messaging.outgoing.notification-out.connector=smallrye-kafka
mp.messaging.outgoing.notification-out.topic=pdms.notifications
mp.messaging.outgoing.notification-out.value.serializer=io.quarkus.kafka.client.serialization.JsonbSerializer

# === KAFKA BROKER ===
kafka.bootstrap.servers=localhost:9092
# Dev Services tự setup broker nếu không có url!
```

---

## 💻 Consumer — @Incoming

```java
@ApplicationScoped
public class DocumentEventProcessor {

    @Inject
    DocumentService documentService;

    // === Simple consumer — blocking ===
    @Incoming("document-events")
    public void processBlocking(DocumentEvent event) {
        // Chạy trên worker thread (blocking OK)
        documentService.process(event);
    }

    // === Reactive consumer — return Uni ===
    @Incoming("document-events")
    public Uni<Void> processReactive(DocumentEvent event) {
        return documentService.processAsync(event)
            .onFailure().invoke(err ->
                log.error("Failed to process event: {}", event.id(), err))
            .replaceWithVoid();
    }

    // === With full Message control (ack/nack) ===
    @Incoming("document-events")
    public Uni<Void> processWithAck(Message<DocumentEvent> message) {
        DocumentEvent event = message.getPayload();

        return documentService.processAsync(event)
            .onItem().transformToUni(result -> message.ack())  // Manual ack
            .onFailure().recoverWithUni(err -> {
                log.error("Processing failed, nacking", err);
                return message.nack(err);  // Manual nack → DLT hoặc retry
            });
    }

    // === Batch consumer ===
    @Incoming("document-events")
    public Uni<Void> processBatch(List<DocumentEvent> events) {
        log.info("Processing batch of {}", events.size());
        return documentService.processBatch(events).replaceWithVoid();
    }
}
```

---

## 💻 Producer — @Outgoing & Emitter

```java
// === Option 1: @Outgoing method — transform stream ===
@ApplicationScoped
public class DocumentEventPublisher {

    // Method này tạo ra stream events khi được trigger
    @Outgoing("notification-out")
    public Multi<NotificationEvent> generateNotifications() {
        // Emit events programmatically
        return Multi.createFrom().emitter(emitter -> {
            // Store emitter reference để emit later
        });
    }
}

// === Option 2: Emitter — emit programmatically (THƯỜNG DÙNG HƠN) ===
@ApplicationScoped
public class DocumentService {

    @Inject
    @Channel("notification-out")
    Emitter<NotificationEvent> notificationEmitter;

    @Transactional
    public Document create(CreateDocRequest req) {
        Document doc = saveDocument(req);

        // Emit Kafka message
        notificationEmitter.send(
            NotificationEvent.builder()
                .type("DOCUMENT_CREATED")
                .documentId(doc.getId())
                .timestamp(Instant.now())
                .build()
        );

        return doc;
    }

    // === Reactive Emitter ===
    @Inject
    @Channel("notification-out")
    MutinyEmitter<NotificationEvent> reactiveEmitter;

    @Transactional
    public Uni<Document> createAsync(CreateDocRequest req) {
        return saveDocumentAsync(req)
            .onItem().transformToUni(doc ->
                reactiveEmitter.send(NotificationEvent.of(doc))
                    .replaceWith(doc)
            );
    }
}
```

---

## 🔧 Transactional Outbox Pattern với SmallRye

```java
// Outbox pattern: persist event trong cùng DB transaction → CDC publish
@ApplicationScoped
public class OutboxService {

    @Inject
    OutboxRepository outboxRepo;

    @Inject
    @Channel("outbox-events")
    Emitter<OutboxEvent> outboxEmitter;

    @Transactional
    public void publishWithOutbox(String type, JsonObject payload) {
        // 1. Persist vào outbox table (cùng transaction với domain operation)
        OutboxEvent event = new OutboxEvent(type, payload.encode());
        outboxRepo.persist(event);

        // 2. Emit sau khi transaction commit (Quarkus @Transactional observer)
        // Hoặc dùng Debezium CDC để đọc outbox table → Kafka
    }
}
```

---

## 🔧 Error Handling & Dead Letter Topic

```properties
# Cấu hình failure strategy
mp.messaging.incoming.document-events.failure-strategy=dead-letter-queue
mp.messaging.incoming.document-events.dead-letter-queue.topic=pdms.document.events.dlq
mp.messaging.incoming.document-events.dead-letter-queue.value.serializer=...

# Hoặc retry
mp.messaging.incoming.document-events.failure-strategy=ignore  # log và tiếp tục
```

```java
// Custom failure handler
@ApplicationScoped
public class KafkaFailureHandler implements KafkaFailureHandler {
    @Override
    public <T> Uni<Void> handle(KafkaRecord<?, T> record, Throwable reason, String channel) {
        log.error("Failed record on channel {}: {}", channel, reason.getMessage());
        return Uni.createFrom().voidItem(); // ignore và continue
    }
}
```

---

## ✅ Practice Checklist
- [ ] Setup consumer với `@Incoming`, consume `DocumentEvent`
- [ ] Dùng `Emitter<T>` để publish từ Service
- [ ] Test với Dev Services Kafka (không cần Kafka riêng)
- [ ] Implement batch consumer
- [ ] Setup Dead Letter Topic cho failed messages

## 🔗 Liên quan
- [[01 Mutiny - Uni và Multi]]
- [[02 RESTEasy Reactive]]
- [[MOC-Distributed-Systems]]

## 📖 Nguồn
- https://quarkus.io/guides/kafka
- https://smallrye.io/smallrye-reactive-messaging/
