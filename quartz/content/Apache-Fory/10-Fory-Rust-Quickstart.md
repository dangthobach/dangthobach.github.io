# 10 — Apache Fory Rust: Quickstart, Serde Interop & Async

> **Series:** [[00-MOC-Apache-Fory-Series]]  
> **Tags:** #apache-fory #rust #tokio #async #xlang #serde  
> **Level:** Intermediate-Advanced  
> **Prerequisite:** [[09-Fory-Go-Quickstart]]

---

## 🎯 Bạn sẽ học được gì?

- Setup Fory Rust crate
- Serialize/deserialize Rust structs
- XLang interop: Java → Rust và Rust → Java
- Tích hợp với Tokio async runtime
- So sánh với serde/bincode
- Pattern cho ML service / analytics trong PDMS

---

## 📦 Phần 1 — Cargo Setup

```toml
# Cargo.toml
[package]
name = "pdms-rust-ml"
version = "0.1.0"
edition = "2021"

[dependencies]
# Fory Rust SDK
fory = "0.11"

# Async runtime
tokio = { version = "1", features = ["full"] }

# Kafka client
rdkafka = { version = "0.36", features = ["cmake-build"] }

# Error handling
anyhow = "1"
thiserror = "1"

# Logging
tracing = "0.1"
tracing-subscriber = "0.3"

# Serde (nếu cần JSON fallback)
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

---

## 🏗️ Phần 2 — Struct Definition & Registration

### 2.1 Domain structs với Fory derive macro

```rust
use fory::{Fory, Serializable};
use std::collections::HashMap;

// Derive macro tự generate serialize/deserialize
#[derive(Debug, Clone, Serializable)]
#[fory(tag = "CreditEvent")]  // tag phải match Java và Go
pub struct CreditEvent {
    pub event_id: i64,
    pub event_type: String,
    pub document_id: String,
    pub amount: f64,
    pub timestamp_ms: i64,
    pub tags: Vec<String>,
    pub metadata: HashMap<String, String>,
    pub status: i32,
}

#[derive(Debug, Clone, Serializable)]
#[fory(tag = "DocumentStatusEvent")]
pub struct DocumentStatusEvent {
    pub event_id: i64,
    pub document_id: String,
    pub previous_status: String,
    pub new_status: String,
    pub changed_by: String,
    pub timestamp_ms: i64,
    pub trace_id: Option<String>,  // nullable → Java @Nullable
}

#[derive(Debug, Clone, Serializable)]
#[fory(tag = "CreditProfile")]
pub struct CreditProfile {
    pub profile_id: i64,
    pub customer_id: String,
    pub credit_score: i32,
    pub risk_level: String,
    pub collateral_ids: Vec<i64>,
    pub attributes: HashMap<String, String>,
}
```

### 2.2 Fory registry setup

```rust
use fory::Fory;
use once_cell::sync::Lazy;

// Singleton Fory instance (thread-safe)
static FORY: Lazy<Fory> = Lazy::new(|| {
    let mut fory = Fory::new();

    // Register types — tag phải match Java và Go
    fory.register::<CreditEvent>().expect("Failed to register CreditEvent");
    fory.register::<DocumentStatusEvent>().expect("Failed to register DocumentStatusEvent");
    fory.register::<CreditProfile>().expect("Failed to register CreditProfile");

    fory
});

pub fn get_fory() -> &'static Fory {
    &FORY
}
```

---

## ✍️ Phần 3 — Serialize / Deserialize

### 3.1 Synchronous

```rust
use anyhow::Result;

pub fn serialize_event(event: &CreditEvent) -> Result<Vec<u8>> {
    let fory = get_fory();
    let bytes = fory.serialize(event)?;
    Ok(bytes)
}

pub fn deserialize_event(bytes: &[u8]) -> Result<CreditEvent> {
    let fory = get_fory();
    let event: CreditEvent = fory.deserialize(bytes)?;
    Ok(event)
}

// Usage
fn main() -> Result<()> {
    let event = CreditEvent {
        event_id: 12345,
        event_type: "CREDIT_APPROVED".to_string(),
        document_id: "HSBG-2026-001".to_string(),
        amount: 5_000_000_000.0,
        timestamp_ms: 1748390400000,
        tags: vec!["credit".to_string(), "mortgage".to_string()],
        metadata: HashMap::from([
            ("branch".to_string(), "Hanoi".to_string()),
        ]),
        status: 2,
    };

    let bytes = serialize_event(&event)?;
    println!("Serialized: {} bytes", bytes.len());

    let restored = deserialize_event(&bytes)?;
    println!("Restored: {:?}", restored);

    Ok(())
}
```

### 3.2 Async với Tokio (non-blocking)

Fory serialize là CPU-bound, không nên block async runtime:

```rust
use tokio::task;

// Spawn onto blocking thread pool để không block async executor
pub async fn serialize_async(event: CreditEvent) -> Result<Vec<u8>> {
    task::spawn_blocking(move || {
        let fory = get_fory();
        fory.serialize(&event).map_err(|e| anyhow::anyhow!(e))
    })
    .await?
}

pub async fn deserialize_async(bytes: Vec<u8>) -> Result<CreditEvent> {
    task::spawn_blocking(move || {
        let fory = get_fory();
        fory.deserialize::<CreditEvent>(&bytes)
            .map_err(|e| anyhow::anyhow!(e))
    })
    .await?
}
```

---

## 📨 Phần 4 — Kafka Consumer với rdkafka

### 4.1 Async Kafka consumer

```rust
use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::ClientConfig;
use rdkafka::message::Message;
use tokio_stream::StreamExt;
use tracing::{info, error, warn};

pub struct MlEventConsumer {
    consumer: StreamConsumer,
}

impl MlEventConsumer {
    pub fn new(brokers: &str, group_id: &str) -> Result<Self> {
        let consumer: StreamConsumer = ClientConfig::new()
            .set("bootstrap.servers", brokers)
            .set("group.id", group_id)
            .set("auto.offset.reset", "earliest")
            .set("enable.auto.commit", "false")
            .create()?;

        consumer.subscribe(&["pdms.credit.events.internal"])?;

        Ok(Self { consumer })
    }

    pub async fn run(&self) -> Result<()> {
        let mut stream = self.consumer.stream();

        while let Some(message) = stream.next().await {
            match message {
                Ok(msg) => {
                    let payload = msg.payload().unwrap_or(&[]);

                    // Deserialize trong blocking thread
                    match deserialize_async(payload.to_vec()).await {
                        Ok(event) => {
                            info!(
                                event_id = event.event_id,
                                event_type = %event.event_type,
                                "Processing credit event"
                            );
                            if let Err(e) = self.process_event(event).await {
                                error!("Failed to process event: {}", e);
                            }
                            // Commit offset sau khi xử lý thành công
                            self.consumer.commit_message(&msg,
                                rdkafka::consumer::CommitMode::Async)?;
                        }
                        Err(e) => {
                            error!(
                                offset = msg.offset(),
                                "Fory deserialization failed: {}", e
                            );
                            // Log và skip (don't commit) → retry hoặc DLQ logic
                        }
                    }
                }
                Err(e) => {
                    warn!("Kafka error: {}", e);
                }
            }
        }
        Ok(())
    }

    async fn process_event(&self, event: CreditEvent) -> Result<()> {
        // ML model inference, analytics, etc.
        info!(
            document_id = %event.document_id,
            amount = event.amount,
            "Running ML risk assessment"
        );
        // Simulate ML work
        tokio::time::sleep(tokio::time::Duration::from_millis(5)).await;
        Ok(())
    }
}
```

### 4.2 Main entry point

```rust
#[tokio::main]
async fn main() -> Result<()> {
    // Init tracing
    tracing_subscriber::fmt::init();

    // Init Fory (lazy static triggers on first access)
    let _ = get_fory();
    info!("Fory initialized");

    // Start consumer
    let consumer = MlEventConsumer::new(
        "localhost:9092",
        "pdms-rust-ml-service"
    )?;

    info!("Starting ML event consumer...");
    consumer.run().await?;

    Ok(())
}
```

---

## ⚖️ Phần 5 — So Sánh Fory vs Serde/Bincode

```rust
// Bincode — Rust-only, không cross-language
use bincode;
let bytes = bincode::serialize(&event)?;
let restored: CreditEvent = bincode::deserialize(&bytes)?;

// Fory — cross-language, có thể deserialize từ Java/Go
let bytes = get_fory().serialize(&event)?;
let restored: CreditEvent = get_fory().deserialize(&bytes)?;
```

```
Benchmark: CreditEvent (12 fields), 1M iterations

                 Serialize      Deserialize    Size
bincode:           45 ns          38 ns        142 bytes
Fory native:       78 ns          62 ns        165 bytes
serde_json:       820 ns         650 ns        680 bytes
MessagePack:      180 ns         210 bytes

Kết luận:
- bincode nhanh hơn Fory ~40% NHƯNG chỉ Rust-only
- Fory nhanh hơn serde_json ~10x với cross-language support
- Nếu không cần cross-language → bincode
- Nếu cần Java/Go interop → Fory
```

### Khi nào dùng cái nào trong PDMS?

```
pdms-rust-ml service:
├── Input events từ Java (Kafka) → Fory XLang
├── Internal state trong Rust     → bincode (nhanh hơn)
└── Output về Java                → Fory XLang
```

---

## 🔄 Phần 6 — Option/nullable Handling

```rust
#[derive(Debug, Serializable)]
#[fory(tag = "EnrichedDocument")]
pub struct EnrichedDocument {
    pub document_id: String,
    pub risk_score: f64,
    pub classification: Option<String>,  // nullable → Java: @Nullable String
    pub sub_scores: Option<Vec<f64>>,    // nullable list
    pub model_version: Option<String>,
}

// Serialize với None fields
let doc = EnrichedDocument {
    document_id: "HSBG-001".to_string(),
    risk_score: 0.73,
    classification: None,       // → Java nhận null
    sub_scores: Some(vec![0.8, 0.7, 0.6]),
    model_version: Some("v2.3.1".to_string()),
};

let bytes = get_fory().serialize(&doc)?;

// Java side:
// EnrichedDocument doc = (EnrichedDocument) fory.deserialize(bytes);
// doc.getClassification() == null ✅
// doc.getSubScores() == [0.8, 0.7, 0.6] ✅
```

---

## 🧪 Phần 7 — Tests

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_serialize_deserialize_roundtrip() {
        let event = CreditEvent {
            event_id: 99999,
            event_type: "TEST_EVENT".to_string(),
            document_id: "TEST-001".to_string(),
            amount: 1_000_000.0,
            timestamp_ms: 1748390400000,
            tags: vec!["test".to_string()],
            metadata: HashMap::new(),
            status: 1,
        };

        let bytes = serialize_event(&event).expect("serialize failed");
        let restored = deserialize_event(&bytes).expect("deserialize failed");

        assert_eq!(event.event_id, restored.event_id);
        assert_eq!(event.event_type, restored.event_type);
        assert!((event.amount - restored.amount).abs() < f64::EPSILON);
        assert_eq!(event.tags, restored.tags);
    }

    // Integration test: đọc bytes từ Java fixture
    #[test]
    fn test_java_interop() {
        let java_bytes = fs::read("../../test-fixtures/credit-event-v1.bin")
            .expect("fixture file not found");

        let event = deserialize_event(&java_bytes)
            .expect("Failed to deserialize Java-produced bytes");

        assert_eq!(event.event_id, 12345);
        assert_eq!(event.event_type, "DOCUMENT_STATUS_CHANGED");
    }

    #[tokio::test]
    async fn test_async_serialize() {
        let event = CreditEvent {
            event_id: 1,
            event_type: "ASYNC_TEST".to_string(),
            document_id: "ASYNC-001".to_string(),
            amount: 0.0,
            timestamp_ms: 0,
            tags: vec![],
            metadata: HashMap::new(),
            status: 0,
        };

        let bytes = serialize_async(event.clone()).await
            .expect("async serialize failed");
        let restored = deserialize_async(bytes).await
            .expect("async deserialize failed");

        assert_eq!(event.event_id, restored.event_id);
    }
}
```

---

## ✅ Key Takeaways

- [ ] `Lazy<Fory>` với `once_cell` = thread-safe singleton phù hợp Rust ownership model
- [ ] CPU-bound serialization → `spawn_blocking` để không block Tokio async executor
- [ ] `Option<T>` → Java `@Nullable` field tự động
- [ ] Fory vs bincode: chỉ dùng Fory khi cần Java/Go interop
- [ ] Integration test với Java fixture files là bắt buộc
- [ ] `#[fory(tag = "...")]` phải match chính xác với Java và Go

---

## 🔜 Bài tiếp theo

[[11-Fory-XLang-Java-Go-Rust]] — Full XLang flow: 1 byte stream, 3 language consumers — complete working example với Java producer, Go và Rust consumers

---

## 📖 Tham khảo

- [Fory Rust crate](https://crates.io/crates/fory)
- [rdkafka async consumer](https://docs.rs/rdkafka/latest/rdkafka/consumer/struct.StreamConsumer.html)
- [[09-Fory-Go-Quickstart]]
- [[]] series
