# 09 — Apache Fory Go: Quickstart & Cross-Service Serialization

> **Series:** [[00-MOC-Apache-Fory-Series]]  
> **Tags:** #apache-fory #golang #xlang #cross-language #microservices  
> **Level:** Intermediate  
> **Prerequisite:** [[05-Fory-Java-Modes]]

---

## 🎯 Bạn sẽ học được gì?

- Setup Fory Go SDK
- Serialize / deserialize Go structs
- XLang interop: Java serialize → Go deserialize
- Struct tagging và type registration
- Error handling và best practices Go-style
- Pattern tích hợp trong microservices (Kafka + gRPC alternatives)

---

## 📦 Phần 1 — Setup

```bash
# Tạo Go module
mkdir pdms-go-agent && cd pdms-go-agent
go mod init github.com/vpbank/pdms-go-agent

# Thêm Fory dependency
go get github.com/apache/fory/go/fory@v0.11.2
```

**go.mod:**
```
module github.com/vpbank/pdms-go-agent

go 1.22

require (
    github.com/apache/fory/go/fory v0.11.2
)
```

---

## 🏗️ Phần 2 — Go-Only Serialization (Quickstart)

### 2.1 Struct definition

```go
package domain

// Fory tự động serialize exported fields
type CreditEvent struct {
    EventId     int64             `fory:"eventId"`
    EventType   string            `fory:"eventType"`
    DocumentId  string            `fory:"documentId"`
    Amount      float64           `fory:"amount"`
    TimestampMs int64             `fory:"timestampMs"`
    Tags        []string          `fory:"tags"`
    Metadata    map[string]string `fory:"metadata"`
    Status      int32             `fory:"status"` // enum as int32 for xlang
}
```

**Fory struct tag rules:**

```
`fory:"fieldName"`   → explicit field name mapping
`fory:"-"`          → skip this field (không serialize)
`fory:"name,omit"` → skip nếu zero value
```

### 2.2 Fory instance setup

```go
package serialization

import (
    "github.com/apache/fory/go/fory"
    "github.com/vpbank/pdms-go-agent/domain"
)

var globalFory *fory.Fory

func init() {
    globalFory = fory.NewFory(true) // true = reference tracking

    // Register types với ID match Java side
    if err := globalFory.RegisterTagType("CreditEvent", domain.CreditEvent{}); err != nil {
        panic("Failed to register CreditEvent: " + err.Error())
    }
    if err := globalFory.RegisterTagType("DocumentStatus", domain.DocumentStatus{}); err != nil {
        panic("Failed to register DocumentStatus: " + err.Error())
    }
}

func GetFory() *fory.Fory {
    return globalFory
}
```

### 2.3 Basic serialize/deserialize

```go
package main

import (
    "fmt"
    "github.com/vpbank/pdms-go-agent/domain"
    "github.com/vpbank/pdms-go-agent/serialization"
)

func main() {
    f := serialization.GetFory()

    // Tạo event
    event := &domain.CreditEvent{
        EventId:     12345,
        EventType:   "DOCUMENT_STATUS_CHANGED",
        DocumentId:  "HSBG-2026-001",
        Amount:      5_000_000_000.0,
        TimestampMs: 1748390400000,
        Tags:        []string{"credit", "mortgage", "approved"},
        Metadata:    map[string]string{"branch": "Hanoi", "officer": "NguyenVanA"},
        Status:      1,
    }

    // Serialize → bytes
    bytes, err := f.Marshal(event)
    if err != nil {
        panic(fmt.Sprintf("serialize failed: %v", err))
    }
    fmt.Printf("Serialized size: %d bytes\n", len(bytes))

    // Deserialize → struct
    var restored domain.CreditEvent
    err = f.Unmarshal(bytes, &restored)
    if err != nil {
        panic(fmt.Sprintf("deserialize failed: %v", err))
    }

    fmt.Printf("Restored: EventId=%d, Type=%s, Amount=%.0f\n",
        restored.EventId, restored.EventType, restored.Amount)
}
```

---

## 🌐 Phần 3 — XLang Mode: Java → Go

### 3.1 Type ID alignment

Đây là điểm quan trọng nhất: **type ID phải match giữa Java và Go**.

```
Java side (ForyHolder.java):
─────────────────────────────
f.register(CreditEvent.class, 200);  // type_id = 200

Go side:
─────────────────────────────
// Fory Go dùng "tag" string, không dùng numeric ID trực tiếp
// Tag phải match với chuỗi đăng ký trong Java xlang mode

// Trong Java XLang mode:
// fory.register(CreditEvent.class); // Fory tự hash class name làm type_id
// HOẶC annotate với @ForyType tag
```

**Java XLang annotation:**
```java
// Cách 1: Dùng tag name (recommended cho Go interop)
@FuryType(tag = "CreditEvent") // thư viện đổi tên, tag giống nhau
public class CreditEvent {
    // fields
}

// Trong ForyHolder:
ThreadSafeFory fory = Fory.builder()
    .withLanguage(Language.XLANG)
    .build();
fory.registerTagType(CreditEvent.class); // dùng @FuryType tag
```

**Go side match:**
```go
// Tag string phải khớp chính xác với Java @FuryType(tag = "CreditEvent")
globalFory.RegisterTagType("CreditEvent", domain.CreditEvent{})
//                          ↑ phải khớp
```

### 3.2 Full XLang flow example

```go
package kafka

import (
    "context"
    "github.com/segmentio/kafka-go"
    "github.com/vpbank/pdms-go-agent/domain"
    "github.com/vpbank/pdms-go-agent/serialization"
    "log"
)

type CreditEventConsumer struct {
    reader *kafka.Reader
    fory   *fory.Fory
}

func NewCreditEventConsumer(brokers []string) *CreditEventConsumer {
    return &CreditEventConsumer{
        reader: kafka.NewReader(kafka.ReaderConfig{
            Brokers: brokers,
            Topic:   "pdms.credit.events.internal",
            GroupID: "pdms-go-analytics",
        }),
        fory: serialization.GetFory(),
    }
}

func (c *CreditEventConsumer) Start(ctx context.Context) error {
    for {
        msg, err := c.reader.ReadMessage(ctx)
        if err != nil {
            if ctx.Err() != nil {
                return nil // graceful shutdown
            }
            return fmt.Errorf("kafka read error: %w", err)
        }

        if err := c.processMessage(msg.Value); err != nil {
            log.Printf("Failed to process message offset=%d: %v", msg.Offset, err)
            // Continue processing (don't block on single message failure)
            continue
        }
    }
}

func (c *CreditEventConsumer) processMessage(data []byte) error {
    // Fory deserialize bytes từ Java producer
    var event domain.CreditEvent
    if err := c.fory.Unmarshal(data, &event); err != nil {
        return fmt.Errorf("fory unmarshal: %w", err)
    }

    log.Printf("Processing event: id=%d type=%s amount=%.0f",
        event.EventId, event.EventType, event.Amount)

    // Business logic
    return c.computeAnalytics(event)
}

func (c *CreditEventConsumer) computeAnalytics(event domain.CreditEvent) error {
    // Go analytics processing
    return nil
}
```

---

## ⚙️ Phần 4 — Go-Specific Patterns

### 4.1 Fory với sync.Pool (concurrent access)

Fory Go instance là **thread-safe** (goroutine-safe), không cần pool. Nhưng nếu cần custom buffer management:

```go
var bufferPool = sync.Pool{
    New: func() interface{} {
        return make([]byte, 0, 1024) // initial capacity 1KB
    },
}

func SerializeWithPool(f *fory.Fory, obj interface{}) ([]byte, error) {
    // Get buffer from pool
    buf := bufferPool.Get().([]byte)
    defer func() {
        // Reset và return to pool
        bufferPool.Put(buf[:0])
    }()

    bytes, err := f.Marshal(obj)
    if err != nil {
        return nil, err
    }
    return bytes, nil
}
```

### 4.2 Null/nil handling

```go
// Go pointers → Java nullable fields
type DocumentMetadata struct {
    WarehouseCode *string           `fory:"warehouseCode"` // nullable
    ShelfCode     string            `fory:"shelfCode"`     // non-null
    Tags          map[string]string `fory:"tags"`          // nullable map
}

// Serialize với nil field
meta := &DocumentMetadata{
    ShelfCode: "A-01-03",
    // WarehouseCode = nil → Java side nhận null
}

bytes, _ := f.Marshal(meta)

// Deserialize — check nil
var restored DocumentMetadata
f.Unmarshal(bytes, &restored)
if restored.WarehouseCode != nil {
    fmt.Println(*restored.WarehouseCode)
}
```

### 4.3 Slice vs Array

```go
// Fory Go serialize slices, không phải fixed arrays
type CreditDocument struct {
    // ✅ Dùng slice
    Tags        []string          `fory:"tags"`
    CollateralIds []int64         `fory:"collateralIds"`

    // ❌ Tránh fixed arrays (không hỗ trợ xlang tốt)
    // Codes [5]string `fory:"codes"`
}
```

---

## 🧪 Phần 5 — Testing

### 5.1 Unit test Go-only

```go
package domain_test

import (
    "testing"
    "github.com/apache/fory/go/fory"
    "github.com/vpbank/pdms-go-agent/domain"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestCreditEventSerializeDeserialize(t *testing.T) {
    f := fory.NewFory(true)
    require.NoError(t, f.RegisterTagType("CreditEvent", domain.CreditEvent{}))

    original := domain.CreditEvent{
        EventId:     99999,
        EventType:   "CREDIT_APPROVED",
        DocumentId:  "HSBG-2026-999",
        Amount:      1_000_000_000.0,
        TimestampMs: 1748390400000,
        Tags:        []string{"approved", "express"},
        Metadata:    map[string]string{"approver": "manager@vpbank.com"},
        Status:      2,
    }

    // Serialize
    bytes, err := f.Marshal(&original)
    require.NoError(t, err)
    assert.Greater(t, len(bytes), 0)

    // Deserialize
    var restored domain.CreditEvent
    err = f.Unmarshal(bytes, &restored)
    require.NoError(t, err)

    assert.Equal(t, original.EventId, restored.EventId)
    assert.Equal(t, original.EventType, restored.EventType)
    assert.InDelta(t, original.Amount, restored.Amount, 0.01)
    assert.Equal(t, original.Tags, restored.Tags)
    assert.Equal(t, original.Metadata["approver"], restored.Metadata["approver"])
}

func TestNilFieldHandling(t *testing.T) {
    f := fory.NewFory(true)
    require.NoError(t, f.RegisterTagType("CreditEvent", domain.CreditEvent{}))

    event := domain.CreditEvent{EventId: 1} // minimal fields

    bytes, err := f.Marshal(&event)
    require.NoError(t, err)

    var restored domain.CreditEvent
    err = f.Unmarshal(bytes, &restored)
    require.NoError(t, err)

    assert.Equal(t, int64(1), restored.EventId)
    assert.Empty(t, restored.Tags)    // nil slice → empty
    assert.Empty(t, restored.Metadata) // nil map → empty
}
```

### 5.2 Integration test: Java bytes → Go deserialize

```go
func TestJavaXLangInterop(t *testing.T) {
    // Bytes được generate từ Java test (hardcoded hoặc từ file)
    // java: byte[] bytes = fory.serialize(creditEvent);
    // Files.write(Path.of("test-fixtures/credit-event-v1.bin"), bytes);
    javaBytes, err := os.ReadFile("../../test-fixtures/credit-event-v1.bin")
    require.NoError(t, err)

    f := fory.NewFory(true)
    f.RegisterTagType("CreditEvent", domain.CreditEvent{})

    var event domain.CreditEvent
    err = f.Unmarshal(javaBytes, &event)
    require.NoError(t, err, "Should deserialize Java-produced bytes")

    assert.Equal(t, int64(12345), event.EventId)
    assert.Equal(t, "DOCUMENT_STATUS_CHANGED", event.EventType)
}
```

---

## 📋 Phần 6 — Type Registry Document (Quan Trọng)

Maintain một file registry chung cho Java + Go (và Rust sau này):

```yaml
# type-registry.yml — source of truth cho tất cả languages
# Commit file này vào Git, team review khi thay đổi

types:
  - tag: "CreditEvent"
    type_id: 200
    java_class: "com.vpbank.pdms.events.CreditEvent"
    go_struct: "domain.CreditEvent"
    rust_struct: "events::CreditEvent"
    schema_version: 2
    added_in: "2026-Q1"

  - tag: "DocumentStatusEvent"
    type_id: 201
    java_class: "com.vpbank.pdms.events.DocumentStatusEvent"
    go_struct: "domain.DocumentStatusEvent"
    schema_version: 1
    added_in: "2026-Q1"

  - tag: "ProcessTaskEvent"
    type_id: 202
    java_class: "com.vpbank.pdms.events.ProcessTaskEvent"
    go_struct: "domain.ProcessTaskEvent"
    schema_version: 1
    added_in: "2026-Q2"
```

> ⚠️ **Rule:** Không bao giờ reuse type_id. Khi xóa type, đánh dấu `deprecated: true`, không xóa khỏi registry.

---

## ✅ Key Takeaways

- [ ] Fory Go instance goroutine-safe — không cần pool
- [ ] Tag string phải match chính xác giữa Java và Go
- [ ] XLang types: dùng int64 (không int), float64 (không BigDecimal), string (không LocalDate)
- [ ] Maintain `type-registry.yml` chung cho tất cả languages
- [ ] Integration test với actual Java-produced bytes (fixture files)
- [ ] Nil slice và nil map serialize an toàn → empty sau deserialization

---

## 🔜 Bài tiếp theo

[[10-Fory-Rust-Quickstart]] — Fory Rust SDK: setup, serde interop, async Tokio context, cross-language với Java và Go

---

## 📖 Tham khảo

- [Fory Go SDK](https://github.com/apache/fory/tree/main/go/fory)
- [Fory XLang Guide](https://fory.apache.org/docs/guide/xlang_object_graph_guide)
- [[05-Fory-Java-Modes]]
- [[07-Fory-Java-Kafka-Internal-Events]]
