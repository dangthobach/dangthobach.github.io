# Bài 17: Kafka với Go — Sarama & confluent-kafka-go

> **Mục tiêu:** Build Kafka Producer/Consumer trong Go, consumer group, offset management, error handling — so sánh với Java Kafka client.

---

## 1. Go Kafka Client Options

```
┌──────────────────────────────────────────────────────────────┐
│              GO KAFKA LIBRARIES COMPARISON                   │
├─────────────────┬────────────────┬──────────────────────────┤
│  Library        │  Stars         │  Best for                │
├─────────────────┼────────────────┼──────────────────────────┤
│  Sarama         │ ★10K          │  Pure Go, no C dep        │
│  confluent-go   │ ★4K           │  librdkafka C binding     │
│  segmentio/kafka│ ★6K           │  Simple API, no deps      │
│  franz-go       │ ★2K           │  Modern, feature-rich     │
└─────────────────┴────────────────┴──────────────────────────┘

Recommendation:
- Sarama: Battle-tested, phổ biến nhất, pure Go
- segmentio/kafka-go: Simplest API cho beginners
- confluent-go: Nếu cần Schema Registry, exactly-once semantics
```

---

## 2. Producer với Sarama

```go
// go get github.com/IBM/sarama (Sarama đã được IBM fork)

import "github.com/IBM/sarama"

type KafkaProducer struct {
    producer sarama.SyncProducer
    topic    string
}

func NewKafkaProducer(brokers []string, topic string) (*KafkaProducer, error) {
    config := sarama.NewConfig()
    
    // Reliability settings
    config.Producer.RequiredAcks  = sarama.WaitForAll    // Wait for all ISR
    config.Producer.Retry.Max     = 5
    config.Producer.Retry.Backoff = 100 * time.Millisecond
    
    // Idempotent producer (exactly-once per partition)
    config.Producer.Idempotent    = true
    config.Net.MaxOpenRequests    = 1 // Required for idempotent
    
    // Compression
    config.Producer.Compression   = sarama.CompressionSnappy
    
    // Batching
    config.Producer.Flush.Messages = 100
    config.Producer.Flush.Frequency = 500 * time.Millisecond
    
    // Return success/error
    config.Producer.Return.Successes = true
    config.Producer.Return.Errors    = true
    
    producer, err := sarama.NewSyncProducer(brokers, config)
    if err != nil {
        return nil, fmt.Errorf("create producer: %w", err)
    }
    
    return &KafkaProducer{producer: producer, topic: topic}, nil
}

type DocumentEvent struct {
    EventType string          `json:"event_type"`
    DocID     string          `json:"doc_id"`
    OwnerID   string          `json:"owner_id"`
    Timestamp time.Time       `json:"timestamp"`
    Payload   json.RawMessage `json:"payload"`
}

func (p *KafkaProducer) PublishDocumentEvent(ctx context.Context, event DocumentEvent) error {
    data, err := json.Marshal(event)
    if err != nil {
        return fmt.Errorf("marshal event: %w", err)
    }
    
    msg := &sarama.ProducerMessage{
        Topic: p.topic,
        Key:   sarama.StringEncoder(event.DocID), // Same key → same partition → ordered
        Value: sarama.ByteEncoder(data),
        Headers: []sarama.RecordHeader{
            {Key: []byte("event_type"), Value: []byte(event.EventType)},
            {Key: []byte("source"),     Value: []byte("pdms-service")},
        },
    }
    
    partition, offset, err := p.producer.SendMessage(msg)
    if err != nil {
        return fmt.Errorf("send message: %w", err)
    }
    
    log.Printf("Published to partition %d, offset %d", partition, offset)
    return nil
}

func (p *KafkaProducer) Close() error {
    return p.producer.Close()
}
```

---

## 3. Consumer Group với Sarama

```
┌──────────────────────────────────────────────────────────────┐
│              CONSUMER GROUP ARCHITECTURE                     │
│                                                              │
│  Topic: "document-events" (6 partitions)                     │
│                                                              │
│  Consumer Group: "pdms-notification-service"                 │
│  ├── Instance 1: Partition 0, 1, 2                           │
│  └── Instance 2: Partition 3, 4, 5                           │
│                                                              │
│  Consumer Group: "pdms-audit-service"                        │
│  ├── Instance 1: Partition 0, 1                              │
│  ├── Instance 2: Partition 2, 3                              │
│  └── Instance 3: Partition 4, 5                              │
│                                                              │
│  → Mỗi group nhận TẤT CẢ messages (independent consumption) │
│  → Trong 1 group: mỗi partition chỉ 1 consumer đọc          │
└──────────────────────────────────────────────────────────────┘
```

```go
// Consumer Group Handler (implement sarama.ConsumerGroupHandler)
type documentEventConsumer struct {
    notifier NotificationService
    auditor  AuditService
}

// Setup — called when session starts (partition assignment)
func (c *documentEventConsumer) Setup(session sarama.ConsumerGroupSession) error {
    log.Printf("Consumer setup: partitions %v", session.Claims())
    return nil
}

// Cleanup — called when session ends (rebalance)
func (c *documentEventConsumer) Cleanup(session sarama.ConsumerGroupSession) error {
    log.Println("Consumer cleanup")
    return nil
}

// ConsumeClaim — message processing loop per partition
func (c *documentEventConsumer) ConsumeClaim(
    session sarama.ConsumerGroupSession,
    claim sarama.ConsumerGroupClaim,
) error {
    for {
        select {
        case msg, ok := <-claim.Messages():
            if !ok {
                return nil // Channel closed — rebalance
            }
            
            // Process message
            if err := c.processMessage(session.Context(), msg); err != nil {
                log.Printf("Error processing msg offset %d: %v", msg.Offset, err)
                // Decide: retry? DLQ? skip?
            }
            
            // Mark AFTER successful processing (commit offset)
            session.MarkMessage(msg, "")
            
        case <-session.Context().Done():
            return nil
        }
    }
}

func (c *documentEventConsumer) processMessage(ctx context.Context, msg *sarama.ConsumerMessage) error {
    var event DocumentEvent
    if err := json.Unmarshal(msg.Value, &event); err != nil {
        return fmt.Errorf("unmarshal: %w", err) // Bad message — skip or DLQ
    }
    
    switch event.EventType {
    case "DOCUMENT_CREATED":
        return c.notifier.NotifyOwner(ctx, event.OwnerID, "Document created: "+event.DocID)
    case "DOCUMENT_ARCHIVED":
        return c.auditor.Record(ctx, event.DocID, "archived", event.OwnerID)
    default:
        log.Printf("Unknown event type: %s", event.EventType)
    }
    return nil
}

// Start consuming
func StartConsumer(ctx context.Context, brokers []string, groupID, topic string, handler *documentEventConsumer) error {
    config := sarama.NewConfig()
    config.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
        sarama.NewBalanceStrategyRoundRobin(),
    }
    config.Consumer.Offsets.Initial   = sarama.OffsetNewest
    config.Consumer.Offsets.AutoCommit.Enable = false // Manual commit!
    
    client, err := sarama.NewConsumerGroup(brokers, groupID, config)
    if err != nil {
        return err
    }
    defer client.Close()
    
    for {
        // Consume blocks until session ends (rebalance/shutdown)
        if err := client.Consume(ctx, []string{topic}, handler); err != nil {
            if errors.Is(err, sarama.ErrClosedConsumerGroup) {
                return nil
            }
            log.Printf("Consumer error: %v", err)
        }
        
        if ctx.Err() != nil {
            return nil // Context cancelled — graceful shutdown
        }
    }
}
```

---

## 4. Dead Letter Queue (DLQ) Pattern

```go
func (c *documentEventConsumer) processWithDLQ(ctx context.Context, msg *sarama.ConsumerMessage) error {
    maxRetries := 3
    
    for attempt := 1; attempt <= maxRetries; attempt++ {
        err := c.processMessage(ctx, msg)
        if err == nil {
            return nil
        }
        
        if attempt == maxRetries {
            // Send to DLQ
            dlqMsg := &sarama.ProducerMessage{
                Topic: msg.Topic + ".dlq",
                Key:   sarama.ByteEncoder(msg.Key),
                Value: sarama.ByteEncoder(msg.Value),
                Headers: append(msg.Headers,
                    sarama.RecordHeader{Key: []byte("error"),        Value: []byte(err.Error())},
                    sarama.RecordHeader{Key: []byte("retry_count"),  Value: []byte(strconv.Itoa(maxRetries))},
                    sarama.RecordHeader{Key: []byte("original_topic"),Value: []byte(msg.Topic)},
                ),
            }
            c.dlqProducer.SendMessage(dlqMsg)
            return nil // Acknowledge to move on
        }
        
        // Exponential backoff
        time.Sleep(time.Duration(attempt*attempt) * 100 * time.Millisecond)
    }
    return nil
}
```

---

## 5. Case Study: PDMS Document Event Pipeline

```
Document Service                   Kafka                  Consumers
     │                               │                       │
     │ doc created                   │                       │
     ├─── Publish("DOCUMENT_CREATED")──►─── "pdms-events" ──►─ notification-svc
     │                               │                       │ (sends email)
     │ doc archived                  │                       │
     ├─── Publish("DOCUMENT_ARCHIVED")─►─── "pdms-events" ──►─ audit-svc
     │                               │                       │ (writes audit log)
     │                               │                       │
     │                               │                       ├─ search-indexer
     │                               │                       │ (updates ES index)
     │                               │                       │
     │                               │                       └─ analytics-svc
     │                               │                         (updates metrics)
```

---

## 6. Tips & Tricks

```
💡 TIP 1: Key-based partitioning cho ordering
   msg.Key = docID → messages cho cùng doc → cùng partition → ordered

💡 TIP 2: Manual commit sau khi process xong
   config.Consumer.Offsets.AutoCommit.Enable = false
   session.MarkMessage(msg, "") → commit on success only

💡 TIP 3: Graceful shutdown với context
   ctx, cancel := signal.NotifyContext(context.Background(), SIGTERM)
   defer cancel()
   → Consumer tự dừng khi ctx cancelled

💡 TIP 4: Idempotent processing
   Check processed_events table trước khi process
   → Safe với at-least-once delivery

💡 TIP 5: Monitor consumer lag
   kubectl exec kafka -- kafka-consumer-groups.sh --describe --group pdms
   → Lag = committed offset - latest offset
```

---

## 7. Tổng kết Bài 17

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ Sarama: WaitForAll + Idempotent cho reliability │
│  ✅ Key = entity ID → ordering per entity          │
│  ✅ Consumer Group: shared consumption, scaled      │
│  ✅ Manual commit: MarkMessage sau process success  │
│  ✅ DLQ pattern cho failed messages                 │
│  ✅ Context cancellation cho graceful shutdown      │
│  ✅ Exponential backoff trước khi DLQ              │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-18-gRPC|Bài 18: gRPC với Go]]

---
*Tags: #go #kafka #sarama #consumer-group #messaging #zero-to-hero*
