# REST API vs GraphQL vs Webhook vs gRPC — Lựa Chọn Khoa Học

> **Tags:** #api-design #rest #graphql #webhook #grpc #architecture #microservices  
> **Related:** [[02-Communication]] · [[PDMS-Workflow-Optimal-Communication]] · [[Transactional-Outbox]]  
> **Status:** 🟢 Complete

---

## TL;DR — Decision Matrix

| Tiêu chí | REST API | GraphQL | Webhook | gRPC |
|---|---|---|---|---|
| **Luồng dữ liệu** | Client → Server (pull) | Client → Server (pull, flexible) | Server → Client (push) | Bidirectional (streaming) |
| **Ai khởi tạo?** | Client | Client | Server | Client (hoặc cả hai) |
| **Protocol** | HTTP/1.1 | HTTP/1.1 (POST) | HTTP/1.1 | HTTP/2 |
| **Payload format** | JSON | JSON | JSON | Protobuf (binary) |
| **Real-time?** | ❌ Polling | ⚠️ Subscription (WS) | ✅ Native push | ✅ Streaming native |
| **Over-fetching** | ❌ Thường xảy ra | ✅ Không | N/A | ✅ Strongly typed, no excess |
| **Schema contract** | OpenAPI/Swagger | SDL (type-safe) | Event schema (lỏng) | `.proto` file (strict) |
| **Caching** | ✅ HTTP native | ⚠️ Phức tạp | ❌ Không | ❌ Không (binary) |
| **Browser support** | ✅ Native | ✅ Native | ✅ Native | ⚠️ Cần gRPC-Web proxy |
| **Human-readable** | ✅ JSON | ✅ JSON | ✅ JSON | ❌ Binary (cần tooling) |
| **Performance** | Trung bình | Trung bình | N/A | 🚀 Cao nhất |
| **Complexity** | Thấp | Cao | Trung bình | Cao |
| **Best for** | CRUD, public API | Complex data graph | Event notification | Internal microservice RPC |

---

## 1. Communication Flow — Minh họa

![[diagrams/api-communication-flows.svg]]

**Câu hỏi quyết định:**
1. **"Ai chủ động?"** → Client = REST/GraphQL/gRPC; Server = Webhook
2. **"Internal hay external?"** → Internal high-perf = gRPC; External/public = REST/GraphQL
3. **"Data có nested/related phức tạp?"** → Yes = GraphQL; No = REST hoặc gRPC
4. **"Cần real-time thông báo?"** → Server-push = Webhook; Streaming = gRPC

---

## 2. Scientific Decision Framework

![[diagrams/api-decision-tree.svg]]

### Step 1 — Communication Direction

```
Client muốn data/action  →  REST, GraphQL, hoặc gRPC
Server có event cần thông báo  →  Webhook
```

### Step 2 — Internal vs External boundary

```
Internal service-to-service (không expose ra ngoài):
  → Cân nhắc gRPC (performance, type safety, streaming)

External / public API / browser client:
  → REST hoặc GraphQL (human-readable, tooling phong phú)
```

### Step 3 — Data Complexity & Pattern

```
Phức tạp: nested, multi-consumer, BFF  →  GraphQL
Đơn giản CRUD, public  →  REST
High-perf internal RPC, streaming  →  gRPC
Event notification, async trigger  →  Webhook
```

### Step 4 — Volume & Reliability Check

```
Webhook > High volume (>500 events/s)  →  Kafka / Message Queue
gRPC streaming > Continuous data flow  →  gRPC server/bidi streaming
REST > Cần caching CDN  →  REST (HTTP/1.1 cache)
```

### Complete Decision Tree (text)

```
START
  │
  ▼
Ai khởi tạo?
  │
  ├─► CLIENT ──► Internal microservice?
  │                   │
  │                   ├─► YES ──► Cần streaming / high-perf?
  │                   │               │
  │                   │               ├─► YES ──► gRPC
  │                   │               └─► NO  ──► gRPC hoặc REST
  │                   │
  │                   └─► NO (external/public) ──► Data graph phức tạp?
  │                                                     │
  │                                                     ├─► YES ──► GraphQL
  │                                                     └─► NO  ──► REST
  │
  └─► SERVER ──► Volume cao? (>500/s)
                    │
                    ├─► YES ──► Kafka / Message Queue
                    └─► NO  ──► Webhook
                                   │
                                   Cần bi-directional?
                                   └─► YES ──► gRPC bidirectional stream
```

---

## 3. REST API — Deep Dive

### Khi nào dùng REST?

✅ **ĐÚNG usecase:**
- CRUD operations đơn giản (tạo/đọc/cập nhật/xóa một resource)
- Public API cho third-party developers (dễ hiểu, document tốt)
- Resource-based operations có hierarchy rõ ràng
- Cần HTTP caching (CDN, browser cache)
- Mobile app với bandwidth hạn chế (cache giúp tiết kiệm)
- Microservice-to-microservice sync call khi không cần performance tối ưu

❌ **Missuse REST:**
- Dùng REST để notify event: `POST /notify-order-completed` → Đây là webhook disguised as REST
- Endpoint explosion: `/getUserWithOrdersAndProductsAndReviews` → Nên dùng GraphQL
- Polling liên tục để check update: `GET /status` mỗi 1s → Nên dùng Webhook/SSE
- Internal high-throughput service call → Nên dùng gRPC

### REST Resource Design tại PDMS

```
# Đúng — Resource-oriented
GET    /api/v1/documents/{id}
POST   /api/v1/documents
PUT    /api/v1/documents/{id}
DELETE /api/v1/documents/{id}

GET    /api/v1/documents/{id}/workflows
POST   /api/v1/documents/{id}/workflows/{wfId}/approve

# Sai — Action-oriented (RPC style → dùng gRPC nếu cần RPC)
POST   /api/v1/approveDocument
POST   /api/v1/getDocumentsByWarehouse
```

### HTTP Status Code Semantic

```
2xx → Thành công
  200 OK           — GET, PUT thành công, trả body
  201 Created      — POST tạo resource mới, kèm Location header
  204 No Content   — DELETE thành công, không có body

4xx → Lỗi từ client
  400 Bad Request  — Input validation fail
  401 Unauthorized — Chưa authenticate
  403 Forbidden    — Đã authenticate nhưng không có quyền (PDMS IAM)
  404 Not Found    — Resource không tồn tại
  409 Conflict     — Optimistic locking fail, duplicate key

5xx → Lỗi từ server
  500 Internal     — Unexpected exception
  503 Unavailable  — Circuit breaker open, downstream down
```

---

## 4. GraphQL — Deep Dive

### Khi nào dùng GraphQL?

✅ **ĐÚNG usecase:**
- BFF (Backend For Frontend): mobile app cần data khác web app
- Data graph phức tạp: `User → Orders → Products → Reviews → Sellers`
- Multiple consumers có nhu cầu data khác nhau từ cùng backend
- Rapid UI iteration: frontend thay đổi data requirements thường xuyên
- Aggregation layer trên nhiều microservices (GraphQL Federation)

❌ **Missuse GraphQL:**
- Simple CRUD với một entity → Over-engineering
- File upload/download → REST với multipart form tốt hơn
- Public API cần document dễ → REST + Swagger dễ tiếp cận hơn
- Internal service-to-service call cần performance → gRPC tốt hơn

### N+1 Problem — DataLoader Solution

**Với REST (5 requests):**
```
GET /users/123
GET /users/123/orders?limit=3
GET /products/456 / /789 / /101
→ 5 requests total
```

**Với GraphQL (1 request):**
```graphql
query DashboardQuery {
  user(id: "123") {
    name
    recentOrders(limit: 3) {
      id
      status
      product { name thumbnailUrl }
    }
  }
}
```

**DataLoader batching:**
```
Vấn đề: N query (one per order's product)
Giải pháp: batch → SELECT * FROM products WHERE id IN (456, 789, 101)
→ 1 query
```

### GraphQL Resolver Architecture tại PDMS

```
pdms-gateway (GraphQL)
    │
    ├── UserResolver         → pdms-iam-service (REST)
    ├── DocumentResolver     → pdms-service (REST)
    ├── WorkflowResolver     → pdms-process-management (REST)
    └── WarehouseResolver    → pdms-warehouse-service (REST)
```

---

## 5. Webhook — Deep Dive

### Khi nào dùng Webhook?

✅ **ĐÚNG usecase:**
- Event notification: "payment completed", "document approved"
- Third-party integration: GitHub → CI/CD, Stripe → Order service
- Async workflow trigger
- Decoupled system: Sender không cần biết receiver làm gì

❌ **Missuse Webhook:**
- Khi cần response data từ receiver (Webhook là fire-and-forget)
- High-frequency events (>500/s) → Dùng Kafka/message queue
- Continuous data stream → gRPC server streaming phù hợp hơn

### Webhook Reliability — Transactional Outbox

```
BEGIN;
  UPDATE documents SET status = 'APPROVED';
  INSERT INTO outbox (event_type, payload) VALUES ('doc.approved', {...});
COMMIT;

Outbox Poller → HTTP POST → Receiver
             ↓ fail
             Exponential backoff → DLQ
```

### Webhook Security

```java
// Producer: ký payload
String signature = "sha256=" + hmacSHA256(payload, webhookSecret);
// Header: X-Webhook-Signature

// Receiver: verify + idempotency
String eventId = request.getHeader("X-Event-Id");
if (processedEventRepository.exists(eventId)) {
    return ResponseEntity.ok().build(); // Already processed
}
```

---

## 6. gRPC — Deep Dive

### gRPC là gì?

gRPC (Google Remote Procedure Call) là framework RPC hiệu năng cao, dùng **HTTP/2** làm transport và **Protocol Buffers (Protobuf)** làm serialization format. Thay vì design theo resource (REST) hay query (GraphQL), gRPC design theo **service contract** — caller gọi method trên remote service như gọi local function.

```
REST:    Client "lấy resource"     → GET /documents/123
GraphQL: Client "query data graph" → query { document(id:"123") {...} }
gRPC:    Client "gọi remote method" → stub.GetDocument(GetDocumentRequest{Id: "123"})
```

### Core concepts

**`.proto` file — Single source of truth:**
```protobuf
syntax = "proto3";

package pdms.document.v1;

service DocumentService {
  // Unary RPC — giống REST
  rpc GetDocument(GetDocumentRequest) returns (Document);
  rpc CreateDocument(CreateDocumentRequest) returns (Document);

  // Server streaming — server push nhiều response
  rpc WatchDocumentStatus(WatchRequest) returns (stream StatusUpdate);

  // Client streaming — client gửi nhiều request
  rpc UploadDocumentChunks(stream Chunk) returns (UploadResult);

  // Bidirectional streaming — real-time 2 chiều
  rpc CollaborativeEdit(stream EditOperation) returns (stream EditOperation);
}

message Document {
  string id = 1;
  string title = 2;
  string status = 3;
  int64 created_at = 4;
}

message GetDocumentRequest {
  string id = 1;
}
```

**Code generation:** Từ `.proto`, gRPC tự gen client stub và server interface cho Java, Go, Python, Rust, v.v. — không cần viết HTTP client thủ công, không cần parse JSON.

```bash
# Tự gen Java code từ proto
protoc --java_out=. --grpc-java_out=. document.proto
```

### 4 loại RPC — Khi nào dùng loại nào

```
1. Unary RPC (phổ biến nhất)
   Client → 1 request → Server → 1 response
   Usecase: GetDocument, CreateDocument, ValidateDocument
   Tương đương: REST request/response thông thường

2. Server Streaming
   Client → 1 request → Server → stream of responses
   Usecase: WatchDocumentStatus, ExportBulkDocuments, Progress updates
   Tương đương: SSE (Server-Sent Events) nhưng type-safe và binary

3. Client Streaming
   Client → stream of requests → Server → 1 response
   Usecase: Upload file chunks, Bulk import records, Log batching
   Tương đương: Chunked upload qua REST nhưng hiệu quả hơn

4. Bidirectional Streaming
   Client ←→ Server (full-duplex, concurrent)
   Usecase: Collaborative editing, Real-time chat, Live telemetry
   Tương đương: WebSocket nhưng strongly-typed với schema
```

### Tại sao gRPC nhanh hơn REST?

```
REST (HTTP/1.1 + JSON):              gRPC (HTTP/2 + Protobuf):
┌─────────────────────┐              ┌─────────────────────────┐
│ Text-based JSON      │              │ Binary Protobuf          │
│ {"id":"123","title": │  vs          │ \x0a\x03123\x12\x05...  │
│ "Document A",...}    │              │ (3-10x smaller payload)  │
│                      │              │                          │
│ HTTP/1.1:            │              │ HTTP/2:                  │
│ - 1 request/conn     │              │ - Multiplexing: nhiều    │
│ - Head-of-line block │              │   streams trên 1 conn    │
│ - Text headers (lớn) │              │ - Header compression     │
│                      │              │ - Server push            │
└─────────────────────┘              └─────────────────────────┘

Benchmark điển hình:
  Latency:   gRPC ~50% thấp hơn REST
  Throughput: gRPC ~7-10x cao hơn REST (heavily payload-dependent)
  CPU:        Protobuf serialize/deserialize nhanh hơn JSON ~5x
```

### Khi nào dùng gRPC?

✅ **ĐÚNG usecase:**
- Internal microservice-to-microservice communication (không expose ra browser)
- High-throughput internal APIs: validation service, scoring service, ML inference
- Streaming data: real-time status updates, log streaming, telemetry
- Polyglot environments: Java service gọi Go service gọi Python service — cùng `.proto` contract
- Strong schema enforcement: breaking changes detected at compile time, không phải runtime

❌ **Missuse gRPC:**
- Public API cho browser client → Browser không support HTTP/2 gRPC trực tiếp, cần gRPC-Web proxy (phức tạp)
- Khi team chưa quen Protobuf/gRPC toolchain → Học curve cao, debug khó hơn REST
- Simple CRUD API với ít service → Over-engineering nếu REST đủ dùng
- Khi cần human-readable payload cho debug/logging dễ → JSON của REST dễ đọc hơn binary Protobuf
- Cross-organization public API → Protobuf schema ít thân thiện hơn OpenAPI với external consumers

### gRPC trong Spring Boot (Java)

```xml
<!-- build.gradle hoặc pom.xml -->
<dependency>
    <groupId>net.devh</groupId>
    <artifactId>grpc-spring-boot-starter</artifactId>
    <version>3.1.0.RELEASE</version>
</dependency>
```

```java
// Server implementation
@GrpcService
public class DocumentGrpcService extends DocumentServiceGrpc.DocumentServiceImplBase {

    @Override
    public void getDocument(GetDocumentRequest request,
                            StreamObserver<Document> responseObserver) {
        Document doc = documentRepository.findById(request.getId())
            .map(this::toProto)
            .orElseThrow(() -> Status.NOT_FOUND
                .withDescription("Document not found: " + request.getId())
                .asRuntimeException());

        responseObserver.onNext(doc);
        responseObserver.onCompleted();
    }

    @Override
    public void watchDocumentStatus(WatchRequest request,
                                    StreamObserver<StatusUpdate> responseObserver) {
        // Server streaming: push status updates khi có thay đổi
        statusSubscriptionService.subscribe(request.getDocumentId(), update -> {
            responseObserver.onNext(StatusUpdate.newBuilder()
                .setStatus(update.getStatus())
                .setTimestamp(update.getTimestamp())
                .build());
        });
        // Stream giữ open đến khi client cancel hoặc document archived
    }
}
```

```java
// Client (từ service khác)
@GrpcClient("pdms-service")
private DocumentServiceGrpc.DocumentServiceBlockingStub documentStub;

public DocumentDto getDocument(String id) {
    Document doc = documentStub.getDocument(
        GetDocumentRequest.newBuilder().setId(id).build()
    );
    return mapper.fromProto(doc);
}
```

### gRPC Error Handling — Status Codes

gRPC có status code riêng, không dùng HTTP status:

```
OK (0)               — Thành công
INVALID_ARGUMENT (3) — Input validation fail (≈ HTTP 400)
NOT_FOUND (5)        — Resource không tồn tại (≈ HTTP 404)
ALREADY_EXISTS (6)   — Duplicate (≈ HTTP 409)
PERMISSION_DENIED (7)— Không có quyền (≈ HTTP 403)
UNAUTHENTICATED (16) — Chưa authenticate (≈ HTTP 401)
UNAVAILABLE (14)     — Service down (≈ HTTP 503)
INTERNAL (13)        — Unexpected error (≈ HTTP 500)
RESOURCE_EXHAUSTED (8)— Rate limit (≈ HTTP 429)
DEADLINE_EXCEEDED (4) — Timeout
```

### gRPC vs REST — Khi nào trade-off

```
                    REST            gRPC
Human debug         ✅ curl/Postman  ❌ cần grpcurl/BloomRPC
Browser native      ✅              ❌ cần gRPC-Web proxy
Firewall friendly   ✅ HTTP/1.1     ⚠️ HTTP/2 có thể bị block
Performance         Trung bình      🚀 Cao hơn 5-10x
Schema safety       ⚠️ OpenAPI opt  ✅ .proto strict
Streaming           ❌ SSE workaround✅ 4 streaming modes
Code gen            ⚠️ Optional      ✅ Mandatory (bắt buộc)
Learning curve      Thấp            Cao
```

---

## 7. Combination Patterns — Dùng cùng nhau

### Pattern A: REST (external) + gRPC (internal)

```
Client (browser/mobile)
    │
    │ REST/JSON (HTTP/1.1)
    ▼
API Gateway / BFF
    │
    ├─── gRPC ──► pdms-iam-service (ValidateToken, CheckPermission)
    ├─── gRPC ──► pdms-document-service (GetDocument, CreateDocument)
    └─── gRPC ──► pdms-process-management (GetWorkflowState)

→ External = REST (browser compatible, human readable)
→ Internal = gRPC (high performance, type safe)
```

### Pattern B: REST + Webhook (PDMS Document Workflow)

```
POST /api/v1/documents              → 201 Created
PUT  /api/v1/documents/{id}/submit  → 200 OK (trigger async processing)
...async OCR, validation...
POST webhook_url { event: "document.processed", status: "READY" }
```

### Pattern C: gRPC Streaming + Webhook

```
ETL progress: gRPC server streaming → client nhận % liên tục
Document event: Webhook → external system notification
Internal pipeline: gRPC bidi streaming → real-time collaborative processing
```

### Pattern D: GraphQL BFF + gRPC backends

```
pdms-gateway (GraphQL BFF)
    │
    ├── UserResolver     ──gRPC──► pdms-iam-service
    ├── DocumentResolver ──gRPC──► pdms-service
    └── WorkflowResolver ──gRPC──► pdms-process-management

→ Frontend: 1 GraphQL endpoint
→ Backend: gRPC for performance between services
→ Best of both worlds
```

---

## 8. Common Antipatterns

### REST Antipatterns

| Antipattern | Fix |
|---|---|
| `GET /getUsers` | `GET /users` |
| `POST /createDocument` | `POST /documents` |
| Trả `200 OK` cho mọi lỗi | Dùng đúng HTTP status |
| Polling `GET /status` mỗi giây | Webhook / SSE / gRPC streaming |
| Internal high-frequency calls | Migrate to gRPC |

### GraphQL Antipatterns

| Antipattern | Fix |
|---|---|
| Không dùng DataLoader | Implement DataLoader/batching |
| Query depth không giới hạn | Depth limiting + query complexity |
| Dùng cho file upload | REST multipart/form-data |
| Internal service-to-service | gRPC hiệu quả hơn |

### Webhook Antipatterns

| Antipattern | Fix |
|---|---|
| Không verify signature | HMAC verification |
| Không idempotent | Lưu processed event IDs |
| Timeout quá dài | Return 200 ngay, process async |
| Không retry | Exponential backoff + DLQ |
| Dùng cho high-frequency events | Kafka / gRPC streaming |

### gRPC Antipatterns

| Antipattern | Fix |
|---|---|
| Expose gRPC trực tiếp ra browser | Thêm REST/gRPC-Web gateway layer |
| Không version `.proto` | Dùng package `v1`, `v2`; không xóa field numbers |
| Xóa hoặc renumber field trong proto | Luôn dùng `reserved` keyword |
| Không set deadline/timeout | Luôn set `withDeadlineAfter()` |
| Blocking stub cho streaming | Dùng async stub hoặc Reactor gRPC |
| Quên handle `onError` trong StreamObserver | Implement đầy đủ onNext/onError/onCompleted |

---

## 9. Performance Characteristics

```
Latency (internal service call):
  REST:     10-100ms   (JSON parse + HTTP/1.1 overhead)
  GraphQL:  15-150ms   (resolver overhead + DataLoader)
  gRPC:     1-20ms     (binary Protobuf + HTTP/2 multiplexing)
  Webhook:  N/A        (server-initiated, one-way)

Throughput (requests/sec, same hardware):
  REST:     ~10,000 rps
  GraphQL:  ~8,000 rps  (resolver overhead)
  gRPC:     ~50,000+ rps (binary, multiplexed)
  Webhook:  phụ thuộc receiver

Payload size (same data):
  REST JSON:    100%  (baseline)
  GraphQL JSON: 80%   (no over-fetching)
  gRPC Protobuf: 30%  (binary, field numbers thay string keys)

Caching:
  REST:     Excellent  (HTTP cache, CDN, ETag)
  GraphQL:  Phức tạp   (POST = no cache; cần persisted queries)
  gRPC:     Không      (binary, HTTP/2 không cache như HTTP/1.1)
  Webhook:  N/A
```

---

## 10. Quick Reference

```
"Tôi cần lấy/thay đổi data (public API)"             → REST
"Data từ nhiều nguồn, consumers khác nhau (BFF)"      → GraphQL
"Tôi cần được thông báo khi có event"                 → Webhook
"Internal service-to-service, cần performance"        → gRPC (Unary)
"Tôi cần stream data liên tục từ server"              → gRPC (Server streaming)
"Tôi cần real-time 2 chiều"                           → gRPC (Bidi streaming)
"Tôi cần xử lý millions events"                       → Kafka/MQ
```

---

## 11. PDMS Mapping

| PDMS Feature | Pattern | Lý do |
|---|---|---|
| Document CRUD (external API) | REST | Resource-based, browser compatible |
| Document search/filter | REST | Standard HTTP, cacheable |
| Dashboard aggregation | GraphQL | Multi-entity, BFF cho web |
| Document processed notification | Webhook | Server push event |
| Workflow step completion | Webhook | Async event, decoupled |
| Real-time progress bar (ETL) | gRPC Server Streaming | Type-safe, hiệu quả hơn SSE |
| PDMS → external system | Webhook | Decoupled, event-driven |
| IAM authorization check (internal) | gRPC Unary | Latency-sensitive, high-frequency |
| pdms-service → pdms-iam-service | gRPC | Internal, performance critical |
| Bulk document migration status | gRPC Server Streaming | Real-time progress, binary efficient |
| Collaborative document editing | gRPC Bidi Streaming | Full-duplex, real-time ops |

---

## References

- [gRPC Documentation](https://grpc.io/docs/)
- [Protocol Buffers Language Guide](https://protobuf.dev/programming-guides/proto3/)
- [grpc-spring-boot-starter](https://yidongnan.github.io/grpc-spring-boot-starter/)
- [GraphQL Spec](https://spec.graphql.org/)
- [REST API Design — Microsoft](https://docs.microsoft.com/en-us/azure/architecture/best-practices/api-design)
- [Webhook Best Practices — Stripe](https://stripe.com/blog/webhooks)
- [GraphQL Federation — Apollo](https://www.apollographql.com/docs/federation/)
- [[Transactional-Outbox]] — Webhook reliability via outbox pattern
- [[02-Communication]] — Microservice communication patterns overview
- [[Kafka-Partition-and-Offset-Internals]] — Khi webhook không đủ, dùng Kafka
