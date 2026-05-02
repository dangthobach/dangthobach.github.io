# Bài 14: Kafka với rdkafka — Messaging Layer

---

## 1. Cơ chế so sánh: Spring Kafka vs rdkafka

```
JAVA — Spring Kafka (annotation-driven, managed lifecycle):
@KafkaListener → ConcurrentMessageListenerContainer
               → ConsumerRecord<K,V>
               → Deserialization (JsonDeserializer via reflection)
               → @KafkaHandler dispatch
               → auto-ack hoặc manual Acknowledgment

RUST — rdkafka (explicit, async):
StreamConsumer::stream() → Message → manual payload parse
                        → tokio::spawn xử lý từng message
                        → consumer.commit() explicit
```

```
┌─────────────────────────────────────────────────────────────┐
│  Kafka Cluster                                              │
│  ┌─────────────────────────────────────────┐               │
│  │  Topic: user-events                     │               │
│  │  Partition 0: [msg1] [msg3] [msg5]      │               │
│  │  Partition 1: [msg2] [msg4] [msg6]      │               │
│  └───────────────────┬─────────────────────┘               │
└──────────────────────┼──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   Consumer 1     Consumer 2    Consumer 3   (cùng group)
   Part. 0        Part. 1       (standby)
```

---

## 2. Dependencies

```toml
[dependencies]
rdkafka = { version = "0.36", features = ["cmake-build", "tokio"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
```

---

## 3. Producer — So sánh với KafkaTemplate

### Java
```java
@Autowired KafkaTemplate<String, String> kafkaTemplate;

kafkaTemplate.send("user-events", key, payload)
             .addCallback(success -> log.info("Sent"), 
                          failure -> log.error("Failed"));
```

### Rust
```rust
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::ClientConfig;
use std::time::Duration;

pub struct KafkaProducer {
    producer: FutureProducer,
}

impl KafkaProducer {
    pub fn new(brokers: &str) -> Self {
        let producer: FutureProducer = ClientConfig::new()
            .set("bootstrap.servers", brokers)
            .set("message.timeout.ms", "5000")
            .set("acks", "all")                    // Đợi tất cả ISR replicas
            .set("retries", "3")
            .set("compression.type", "snappy")
            .create()
            .expect("Failed to create Kafka producer");
        
        Self { producer }
    }
    
    pub async fn send<T: Serialize>(
        &self,
        topic: &str,
        key: &str,
        payload: &T,
    ) -> Result<(), AppError> {
        let json = serde_json::to_string(payload)?;
        
        let record = FutureRecord::to(topic)
            .payload(json.as_bytes())
            .key(key);
        
        self.producer
            .send(record, Duration::from_secs(5))
            .await
            .map_err(|(kafka_err, _original_message)| {
                AppError::ExternalService {
                    service: "kafka".to_string(),
                    message: kafka_err.to_string(),
                }
            })?;
        
        Ok(())
    }
}
```

---

## 4. Consumer — So sánh với @KafkaListener

### Java
```java
@KafkaListener(topics = "user-events", groupId = "pdms-service")
public void handleUserEvent(@Payload UserEvent event, 
                             Acknowledgment ack) {
    processEvent(event);
    ack.acknowledge();
}
```

### Rust — Streaming Consumer
```rust
use rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};
use rdkafka::message::BorrowedMessage;
use rdkafka::{ClientConfig, Message};

pub struct KafkaConsumer {
    consumer: StreamConsumer,
}

impl KafkaConsumer {
    pub fn new(brokers: &str, group_id: &str, topics: &[&str]) -> Self {
        let consumer: StreamConsumer = ClientConfig::new()
            .set("bootstrap.servers", brokers)
            .set("group.id", group_id)
            .set("enable.auto.commit", "false")   // Manual commit — safe
            .set("auto.offset.reset", "earliest")
            .set("session.timeout.ms", "10000")
            .create()
            .expect("Failed to create consumer");
        
        consumer.subscribe(topics)
            .expect("Failed to subscribe to topics");
        
        Self { consumer }
    }
    
    pub async fn run(self) {
        use futures::StreamExt;
        
        loop {
            match self.consumer.stream().next().await {
                Some(Ok(message)) => {
                    if let Err(e) = Self::process_message(&message).await {
                        tracing::error!(?e, "Failed to process message");
                        // DLQ logic hoặc retry ở đây
                    }
                    // Commit SAU khi xử lý thành công
                    if let Err(e) = self.consumer.commit_message(&message, CommitMode::Async) {
                        tracing::error!(?e, "Failed to commit offset");
                    }
                }
                Some(Err(e)) => tracing::error!(?e, "Kafka error"),
                None => break,
            }
        }
    }
    
    async fn process_message(msg: &BorrowedMessage<'_>) -> Result<(), AppError> {
        let payload = msg.payload()
            .ok_or_else(|| AppError::BadRequest("Empty payload".to_string()))?;
        
        let event: UserEvent = serde_json::from_slice(payload)
            .map_err(|e| AppError::BadRequest(format!("Invalid JSON: {}", e)))?;
        
        tracing::info!(
            topic = msg.topic(),
            partition = msg.partition(),
            offset = msg.offset(),
            key = ?msg.key(),
            "Processing event"
        );
        
        // Business logic
        handle_user_event(event).await
    }
}
```

---

## 5. Parallel Consumer — Xử lý Concurrent

```rust
// Pattern: nhận message tuần tự (để commit đúng), xử lý song song
use tokio::sync::Semaphore;

pub async fn run_parallel(consumer: StreamConsumer, max_concurrent: usize) {
    use futures::StreamExt;
    let semaphore = Arc::new(Semaphore::new(max_concurrent));
    
    consumer.stream()
        .for_each_concurrent(max_concurrent, |result| {
            let sem = Arc::clone(&semaphore);
            async move {
                let _permit = sem.acquire().await.unwrap();
                
                match result {
                    Ok(msg) => {
                        // Spawn task cho mỗi message — parallel processing
                        tokio::spawn(async move {
                            if let Err(e) = process(&msg).await {
                                tracing::error!(?e, "Processing failed");
                            }
                            // Commit sau xử lý
                            consumer.commit_message(&msg, CommitMode::Async).ok();
                        });
                    }
                    Err(e) => tracing::error!(?e, "Kafka error"),
                }
            }
        })
        .await;
}
```

---

## 6. Transactional Outbox Pattern với Kafka — PDMS Context

```
Vấn đề: Làm sao đảm bảo DB write và Kafka publish cùng success/fail?

┌─────────────────────────────────────────────────────────┐
│  Service A                                              │
│                                                         │
│  BEGIN TRANSACTION                                      │
│    ┌─────────────────────┐                              │
│    │  INSERT INTO orders  │  ← business write          │
│    │  INSERT INTO outbox  │  ← event write (same tx)   │
│    └─────────────────────┘                              │
│  COMMIT                                                 │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Outbox Poller (separate tokio task)             │  │
│  │  SELECT * FROM outbox WHERE sent = false         │  │
│  │  → rdkafka.send(event)                           │  │
│  │  → UPDATE outbox SET sent = true                 │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

```rust
// Outbox poller chạy như background task
pub async fn outbox_poller(pool: PgPool, producer: KafkaProducer) {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    
    loop {
        interval.tick().await;
        
        // Fetch và lock pending events
        let events = sqlx::query_as!(OutboxEvent,
            r#"
            SELECT id, topic, key, payload, created_at
            FROM outbox
            WHERE sent = false
            ORDER BY created_at
            LIMIT 100
            FOR UPDATE SKIP LOCKED  -- PostgreSQL: tránh concurrent poller conflict
            "#
        )
        .fetch_all(&pool)
        .await
        .unwrap_or_default();
        
        for event in events {
            match producer.send_raw(&event.topic, &event.key, &event.payload).await {
                Ok(()) => {
                    sqlx::query!(
                        "UPDATE outbox SET sent = true, sent_at = NOW() WHERE id = $1",
                        event.id
                    )
                    .execute(&pool)
                    .await
                    .ok();
                }
                Err(e) => {
                    tracing::error!(event_id = event.id, ?e, "Failed to publish outbox event");
                }
            }
        }
    }
}
```

---

## 7. Khởi động Consumer trong Main

```rust
#[tokio::main]
async fn main() {
    init_tracing();
    
    let config = Config::load().expect("Config failed");
    let pool = create_pool(&config.database_url).await;
    let producer = KafkaProducer::new(&config.kafka_brokers);
    
    // Web server
    let app_state = AppState { pool: pool.clone(), producer: producer.clone() };
    let app = build_router(app_state);
    
    // Kafka consumer — chạy concurrent với web server
    let consumer = KafkaConsumer::new(
        &config.kafka_brokers,
        "pdms-service",
        &["user-events", "document-events"],
    );
    
    // Outbox poller
    let poller_pool = pool.clone();
    let poller_producer = producer.clone();
    
    tokio::select! {
        // Web server
        _ = serve_http(app, &config.server_addr) => {}
        // Kafka consumer
        _ = consumer.run() => {}
        // Outbox poller
        _ = outbox_poller(poller_pool, poller_producer) => {}
        // Graceful shutdown
        _ = shutdown_signal() => {
            tracing::info!("Shutting down...");
        }
    }
}
```

---

## Performance: rdkafka vs Spring Kafka

```
Throughput (messages/s, single consumer):
  Spring Kafka         : ~50K msg/s (depends on processing + GC)
  rdkafka + tokio      : ~200-400K msg/s (I/O-bound, no GC pauses)

Latency per message (end-to-end):
  Spring Kafka         : 5-50ms (GC jitter, warm-up)
  rdkafka              : 0.5-5ms (predictable)

Memory footprint (consumer process):
  Spring Boot + Kafka  : ~300-600 MB (JVM heap)
  Rust + rdkafka       : ~20-50 MB
  
Rebalance recovery:
  Spring               : Depends on session.timeout.ms + JVM GC
  Rust                 : Tighter control, no GC interference
```

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9: tokio::spawn, select!]]
- [[Rust-Zero-To-Hero/Bai-13-Serde-Reqwest-JWT|Bài 13: Serde cho message payload]]
- [[MOC-Distributed-Systems]] — Outbox pattern, at-least-once
- [[MOC-PDMS]] — applied context

---
*Bài tập:*
1. Implement producer gửi `DocumentCreatedEvent` mỗi khi POST `/documents`. Verify với `kafka-console-consumer`.
2. Implement consumer nhận event từ topic `document-events`, cập nhật read model vào PostgreSQL. Implement idempotency check (skip nếu event đã xử lý).
3. Implement outbox poller hoàn chỉnh với `FOR UPDATE SKIP LOCKED` và retry logic khi Kafka unavailable.
