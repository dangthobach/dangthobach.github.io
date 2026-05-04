# 12 — Jakarta Messaging (JMS) 3.x

> **Spec:** Jakarta Messaging 3.x (JMS) | **Profile:** Full Platform
> **Spring equivalent:** Spring Kafka / Spring AMQP (RabbitMQ) / Spring JMS
> **Prototype runtime:** Quarkus + ActiveMQ Artemis (dev service)

---

## 1. Spec Says

Jakarta Messaging (JMS) là chuẩn messaging API Java EE từ 2001. Hỗ trợ hai pattern:
- **Point-to-Point (Queue)** — 1 producer, 1 consumer, message được delivered một lần
- **Pub/Sub (Topic)** — 1 publisher, nhiều subscriber

JMS implementations: **ActiveMQ**, **IBM MQ**, **RabbitMQ** (via AMQP-JMS bridge), **Amazon SQS** (partial). Kafka **không phải** JMS — API khác hoàn toàn.

---

## 2. Core Concepts

```
Producer ──→ [Queue/Topic] ──→ Consumer(s)

Queue (P2P):  Message gửi 1 lần, 1 consumer nhận
Topic (PubSub): Message gửi đến tất cả subscribers
```

---

## 3. JMS vs Spring Kafka/AMQP

| Khái niệm | JMS | Spring Kafka | Spring AMQP |
|---|---|---|---|
| Send | `JMSContext.createProducer()` | `KafkaTemplate.send()` | `RabbitTemplate.send()` |
| Receive | `@JMSListener` | `@KafkaListener` | `@RabbitListener` |
| Queue | `Queue` | `Topic/Partition` | `Queue` |
| Topic | `Topic` | `Topic` | `Exchange+RoutingKey` |
| Durability | `DeliveryMode.PERSISTENT` | Log-based (permanent) | `durable=true` |
| At-least-once | Acknowledge mode | `enable.auto.commit=false` | `AcknowledgeMode.MANUAL` |

---

## 4. JMSContext API (JMS 2.0+)

```java
// JMS 2.0 — simplified API (JMSContext thay vì Connection+Session)

// === SEND — Point-to-Point ===
@Inject
@JMSConnectionFactory("java:comp/DefaultJMSConnectionFactory")
JMSContext context;

@Resource(mappedName = "java:/queue/documents")
Queue documentQueue;

@Resource(mappedName = "java:/topic/notifications")
Topic notificationTopic;

// Gửi String message
public void sendDocumentCreated(String documentId, String tenantId) {
    context.createProducer()
        .setProperty("tenantId", tenantId)        // message property (header)
        .setProperty("eventType", "DOCUMENT_CREATED")
        .setTimeToLive(24 * 60 * 60 * 1000L)     // 24h expiry
        .setDeliveryMode(DeliveryMode.PERSISTENT) // survive broker restart
        .send(documentQueue, documentId);
}

// Gửi Object message (Serializable hoặc JSON string)
public void sendEvent(DocumentEvent event) {
    String json = JsonbBuilder.create().toJson(event);
    context.createProducer()
        .setProperty("eventType", event.type())
        .send(documentQueue, json);
}

// Gửi Topic (broadcast)
public void broadcastNotification(String message) {
    context.createProducer()
        .send(notificationTopic, message);
}
```

---

## 5. Message Listener — Receive

```java
// === @JMSListener — MDB (Message-Driven Bean) pattern ===
@MessageDriven(
    activationConfig = {
        @ActivationConfigProperty(
            propertyName = "destinationType",
            propertyValue = "jakarta.jms.Queue"
        ),
        @ActivationConfigProperty(
            propertyName = "destination",
            propertyValue = "java:/queue/documents"
        ),
        @ActivationConfigProperty(
            propertyName = "acknowledgeMode",
            propertyValue = "Auto-acknowledge"
        )
    }
)
public class DocumentEventListener implements MessageListener {

    @Inject DocumentService docService;

    @Override
    public void onMessage(Message message) {
        try {
            String eventType = message.getStringProperty("eventType");
            String body = ((TextMessage) message).getText();

            switch (eventType) {
                case "DOCUMENT_CREATED" -> docService.onDocumentCreated(body);
                case "DOCUMENT_UPDATED" -> docService.onDocumentUpdated(body);
                case "STATUS_CHANGED"   -> docService.onStatusChanged(body);
                default -> log.warn("Unknown event type: {}", eventType);
            }
        } catch (JMSException e) {
            // Throw exception → message redelivered (based on config)
            throw new RuntimeException("Failed to process message", e);
        }
    }
}

// === Quarkus: JMS qua @Incoming (Reactive Messaging) ===
// application.properties:
// mp.messaging.incoming.documents.connector=smallrye-jms
// mp.messaging.incoming.documents.destination=documentQueue

@Incoming("documents")
public void onDocumentEvent(String payload) {
    DocumentEvent event = JsonbBuilder.create().fromJson(payload, DocumentEvent.class);
    docService.handle(event);
}
```

---

## 6. Request-Reply Pattern

```java
// JMS Request-Reply — synchronous over async
@ApplicationScoped
public class DocumentValidationGateway {

    @Inject JMSContext context;

    @Resource(mappedName = "java:/queue/validation-request")
    Queue requestQueue;

    public ValidationResult validate(String documentId) throws JMSException {
        // Tạo temp reply queue
        TemporaryQueue replyQueue = context.createTemporaryQueue();
        String correlationId = UUID.randomUUID().toString();

        // Gửi request
        context.createProducer()
            .setJMSReplyTo(replyQueue)
            .setJMSCorrelationID(correlationId)
            .send(requestQueue, documentId);

        // Chờ reply (blocking, 5s timeout)
        try (JMSConsumer consumer = context.createConsumer(replyQueue)) {
            Message reply = consumer.receive(5000); // 5s
            if (reply == null) throw new TimeoutException("Validation timed out");
            return JsonbBuilder.create().fromJson(
                ((TextMessage) reply).getText(),
                ValidationResult.class
            );
        } finally {
            replyQueue.delete();
        }
    }
}
```

---

## 7. Transactional Messaging

```java
// JMS + JTA: message chỉ được gửi khi TX commit
@Transactional
public void createDocumentAndNotify(CreateDocumentRequest req) {
    // 1. Lưu document vào DB
    Document doc = docRepo.save(req.toEntity());

    // 2. Gửi JMS message — chỉ actually gửi khi TX commit
    // Nếu TX rollback → message không được gửi
    context.createProducer().send(documentQueue,
        JsonbBuilder.create().toJson(DocumentCreatedEvent.of(doc)));

    // Atomic: hoặc cả hai thành công, hoặc cả hai rollback
}
```

---

## 8. Prototype — Document Event Bus

```bash
# Quarkus tự start ActiveMQ Artemis dev service
mvn io.quarkus.platform:quarkus-maven-plugin:3.x.x:create \
    -DprojectArtifactId=jms-lab \
    -Dextensions="rest,rest-jackson,messaging-artemis"
```

```java
// application.properties
// quarkus.artemis.url=tcp://localhost:61616
// quarkus.artemis.username=admin
// quarkus.artemis.password=admin
// %dev.quarkus.devservices.enabled=true

// === Event types ===
public record DocumentEvent(
    String eventId,
    String eventType,
    String documentId,
    String tenantId,
    String performedBy,
    Instant occurredAt,
    Map<String, Object> payload
) {
    static DocumentEvent of(String type, String docId, String tid, String user) {
        return new DocumentEvent(UUID.randomUUID().toString(), type,
            docId, tid, user, Instant.now(), Map.of());
    }
}

// === Producer Service ===
@ApplicationScoped
public class DocumentEventProducer {

    @Inject JMSContext jmsContext;

    @Resource(lookup = "java:/queue/document-events")
    Queue eventQueue;

    @Transactional
    public void publish(DocumentEvent event) {
        try {
            String json = JsonbBuilder.create().toJson(event);
            jmsContext.createProducer()
                .setProperty("eventType", event.eventType())
                .setProperty("tenantId", event.tenantId())
                .setDeliveryMode(DeliveryMode.PERSISTENT)
                .setTimeToLive(86400_000L) // 24h
                .send(eventQueue, json);
        } catch (Exception e) {
            log.error("Failed to publish event: {}", event.eventId(), e);
            throw new MessagingException("Event publish failed", e);
        }
    }
}

// === Consumer — MDB ===
@MessageDriven(activationConfig = {
    @ActivationConfigProperty(propertyName = "destinationType",
        propertyValue = "jakarta.jms.Queue"),
    @ActivationConfigProperty(propertyName = "destination",
        propertyValue = "java:/queue/document-events"),
    @ActivationConfigProperty(propertyName = "messageSelector",
        propertyValue = "eventType IN ('DOCUMENT_CREATED','STATUS_CHANGED')")
})
public class DocumentEventConsumer implements MessageListener {

    @Inject DocumentWorkflowService workflowSvc;
    @Inject AuditService auditSvc;

    @Override
    public void onMessage(Message msg) {
        try {
            String eventType = msg.getStringProperty("eventType");
            String json = ((TextMessage) msg).getText();
            var event = JsonbBuilder.create().fromJson(json, DocumentEvent.class);

            switch (eventType) {
                case "DOCUMENT_CREATED" -> {
                    auditSvc.log(event.tenantId(), event.documentId(),
                                 "CREATED", event.performedBy(), null);
                }
                case "STATUS_CHANGED" -> {
                    String newStatus = (String) event.payload().get("newStatus");
                    workflowSvc.onStatusChanged(event.documentId(), newStatus);
                }
            }

            log.infof("[JMS] Processed %s for %s", eventType, event.documentId());
        } catch (JMSException e) {
            throw new RuntimeException("JMS processing failed", e);
        }
    }
}

// === REST trigger ===
@Path("/api/events")
@Produces(MediaType.APPLICATION_JSON)
public class EventResource {

    @Inject DocumentEventProducer producer;

    @POST
    @Path("/document-created")
    @Transactional
    public Response fireDocumentCreated(
            @HeaderParam("X-Tenant-Id") String tenantId,
            @QueryParam("docId") String docId,
            @QueryParam("user") String user) {
        var event = DocumentEvent.of("DOCUMENT_CREATED", docId, tenantId, user);
        producer.publish(event);
        return Response.ok(Map.of("eventId", event.eventId())).build();
    }
}
```

---

## 9. Architect Notes

**JMS vs Kafka trong 2026:**
- **JMS (ActiveMQ/IBM MQ):** banking legacy, transactional (XA), at-most-once/at-least-once, broker-centric
- **Kafka:** event streaming, high-throughput, log-based retention, replay capability
- **Không phải cạnh tranh** — JMS cho transactional ops, Kafka cho event streaming

**PDMS context:** Spring Kafka đang dùng phù hợp hơn JMS cho event-driven patterns. JMS chỉ relevant nếu tích hợp với IBM MQ (common trong banking core systems tại VN).

---

*[[11-Jakarta-Concurrency]] | [[00-Overview]] | Next: [[13-Jakarta-Faces]]*
