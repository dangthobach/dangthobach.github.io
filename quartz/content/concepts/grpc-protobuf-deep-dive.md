# gRPC & Protocol Buffers — Deep Dive

---
tags: [grpc, protobuf, microservices, networking, api, performance]
created: 2026-05-02
difficulty: intermediate
estimated-read: 22 min
links: [[kubernetes-architecture]], [[zero-trust-architecture]], [[opentelemetry-deep-dive]]

---

## 🎯 Learning Objectives

Sau bài này bạn sẽ:
- Hiểu **tại sao gRPC** được thiết kế và vấn đề nó giải quyết so với REST
- Nắm **Protocol Buffers** encoding và tại sao nó nhỏ hơn JSON
- Implement gRPC service trong Java/Spring Boot
- Biết khi nào dùng gRPC, khi nào dùng REST

---

## 🆚 REST vs gRPC — So Sánh Toàn Diện

```
┌────────────────────────────────────────────────────────────────┐
│                    REST vs gRPC                                 │
│                                                                 │
│  Feature          │ REST/HTTP+JSON        │ gRPC/HTTP2+Protobuf│
│  ─────────────────┼───────────────────────┼────────────────── │
│  Protocol         │ HTTP/1.1 hoặc HTTP/2  │ HTTP/2 (required) │
│  Serialization    │ JSON (text)           │ Protobuf (binary)  │
│  Schema           │ Optional (OpenAPI)    │ Required (.proto)  │
│  Code generation  │ Manual / partial      │ Auto từ .proto    │
│  Streaming        │ Limited (SSE)         │ Native (4 modes)  │
│  Browser support  │ Native ✓              │ Via grpc-web ⚠    │
│  Debugging        │ curl, Postman ✓       │ grpcurl, grpcui   │
│  Performance      │ Baseline              │ ~5-10x faster     │
│  Payload size     │ Baseline              │ ~5-10x smaller    │
│  Service contract │ Loose (OpenAPI opt)   │ Strong (.proto)   │
│  Cross-language   │ Any HTTP client       │ Generated client  │
└────────────────────────────────────────────────────────────────┘
```

### Khi nào dùng gRPC?

```
✓ Service-to-service communication (microservices internal APIs)
✓ High-performance, low-latency requirements
✓ Real-time streaming (live feeds, notifications)
✓ Polyglot environments (Java service ↔ Go service ↔ Python service)
✓ Mobile backend (bandwidth-constrained)

✗ Public-facing APIs (browser clients)
✗ Simple CRUD (REST + OpenAPI là đủ, dễ document hơn)
✗ Team unfamiliar with Protocol Buffers
✗ Need human-readable wire format for debugging
```

---

## 📦 Protocol Buffers — Binary Encoding

### Tại sao Protobuf nhỏ hơn JSON?

```
JSON (text):
{
  "id": 12345,
  "title": "Hợp đồng VPBank 2025",
  "status": "ACTIVE",
  "file_size": 1048576
}
→ ~75 bytes (+ field names repeated!)

Protobuf (binary):
  Field 1 (id): 0x08 0xB9 0x60  → 3 bytes (varint encoding)
  Field 2 (title): 0x12 0x1E [bytes] → 2 + 30 bytes = 32 bytes
  Field 3 (status): 0x18 0x01  → 2 bytes (enum = 1)
  Field 4 (file_size): 0x20 0x80 0x80 0x40 → 4 bytes
→ ~41 bytes (no field names! just field numbers)
```

### Protobuf Wire Format

```
Each field encoded as: [field_number << 3 | wire_type] [value]

Wire types:
  0 = Varint (int32, int64, bool, enum)
  1 = 64-bit (double, fixed64)
  2 = Length-delimited (string, bytes, embedded messages, repeated)
  5 = 32-bit (float, fixed32)

Example: id = 12345 (field number 1, wire type 0)
  Tag:   1 << 3 | 0 = 0x08
  Value: 12345 = 0x3039 → varint: 0xB9 0x60 (little-endian 7-bit groups)
```

---

## 📝 Protocol Buffers Schema (`.proto` file)

```protobuf
// pdms/document.proto
syntax = "proto3";

package pdms.document.v1;

option java_package = "com.vpbank.pdms.grpc.proto";
option java_multiple_files = true;

// Enum
enum DocumentStatus {
  DOCUMENT_STATUS_UNSPECIFIED = 0;  // Proto3: default must be 0
  DOCUMENT_STATUS_ACTIVE = 1;
  DOCUMENT_STATUS_ARCHIVED = 2;
  DOCUMENT_STATUS_PENDING = 3;
}

// Message
message Document {
  int64 id = 1;
  string title = 2;
  string tenant_id = 3;
  DocumentStatus status = 4;
  int64 file_size = 5;
  string created_at = 6;  // ISO 8601 string
  // Field 7 reserved for future use — don't reuse field numbers!
  reserved 7;
  repeated string tags = 8;  // Repeated = array
  DocumentMetadata metadata = 9;  // Nested message
}

message DocumentMetadata {
  string document_type = 1;
  string warehouse_code = 2;
  map<string, string> custom_fields = 3;  // Map support
}

// Service definition
service DocumentService {
  // Unary RPC
  rpc GetDocument(GetDocumentRequest) returns (GetDocumentResponse);
  rpc CreateDocument(CreateDocumentRequest) returns (CreateDocumentResponse);
  
  // Server streaming — server sends multiple responses
  rpc ListDocuments(ListDocumentsRequest) returns (stream Document);
  
  // Client streaming — client sends multiple requests
  rpc BulkUploadDocuments(stream CreateDocumentRequest) returns (BulkUploadResponse);
  
  // Bidirectional streaming
  rpc SyncDocuments(stream SyncRequest) returns (stream SyncResponse);
}

message GetDocumentRequest {
  int64 id = 1;
  string tenant_id = 2;
}

message GetDocumentResponse {
  Document document = 1;
}

message ListDocumentsRequest {
  string tenant_id = 1;
  DocumentStatus status_filter = 2;
  int32 page_size = 3;
  string page_token = 4;
}
```

---

## ⚡ gRPC 4 Communication Patterns

```
┌─────────────────────────────────────────────────────────────────┐
│                   gRPC Communication Patterns                    │
│                                                                  │
│  1. Unary (Request-Response)                                    │
│     Client ──── request ────► Server                           │
│     Client ◄─── response ─── Server                           │
│     Usage: GetDocument, CreateDocument                          │
│                                                                  │
│  2. Server Streaming                                            │
│     Client ──── request ────► Server                           │
│     Client ◄─── response 1 ─ Server                           │
│     Client ◄─── response 2 ─ Server                           │
│     Client ◄─── response N ─ Server                           │
│     Client ◄─── END ──────── Server                           │
│     Usage: ListDocuments (large result set), live feed         │
│                                                                  │
│  3. Client Streaming                                            │
│     Client ──── request 1 ──► Server                           │
│     Client ──── request 2 ──► Server                           │
│     Client ──── END ────────► Server                           │
│     Client ◄─── response ─── Server                           │
│     Usage: BulkUpload, file chunked upload                     │
│                                                                  │
│  4. Bidirectional Streaming                                     │
│     Client ──── request ────► Server                           │
│     Client ◄─── response ─── Server                           │
│     Client ──── request ────► Server  (concurrent!)           │
│     Client ◄─── response ─── Server                           │
│     Usage: Real-time sync, chat, live collaboration            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔧 Spring Boot + gRPC Implementation

### pom.xml dependencies

```xml
<dependencies>
    <!-- gRPC Spring Boot Starter -->
    <dependency>
        <groupId>net.devh</groupId>
        <artifactId>grpc-server-spring-boot-starter</artifactId>
        <version>2.15.0.RELEASE</version>
    </dependency>
    
    <!-- Protobuf -->
    <dependency>
        <groupId>com.google.protobuf</groupId>
        <artifactId>protobuf-java</artifactId>
        <version>3.25.3</version>
    </dependency>
</dependencies>

<build>
    <plugins>
        <!-- Generate Java from .proto files -->
        <plugin>
            <groupId>org.xolstice.maven.plugins</groupId>
            <artifactId>protobuf-maven-plugin</artifactId>
            <version>0.6.1</version>
            <configuration>
                <protocArtifact>com.google.protobuf:protoc:3.25.3:exe:${os.detected.classifier}</protocArtifact>
                <pluginId>grpc-java</pluginId>
            </configuration>
        </plugin>
    </plugins>
</build>
```

### gRPC Server Implementation

```java
// Server-side service implementation
@GrpcService  // net.devh annotation — registers as gRPC service
@Slf4j
public class DocumentGrpcService extends DocumentServiceGrpc.DocumentServiceImplBase {
    
    private final DocumentDomainService documentService;
    private final DocumentGrpcMapper mapper;
    
    // Unary RPC
    @Override
    public void getDocument(GetDocumentRequest request,
                             StreamObserver<GetDocumentResponse> responseObserver) {
        try {
            Document doc = documentService.findById(request.getId(), request.getTenantId())
                .orElseThrow(() -> Status.NOT_FOUND
                    .withDescription("Document " + request.getId() + " not found")
                    .asRuntimeException());
            
            GetDocumentResponse response = GetDocumentResponse.newBuilder()
                .setDocument(mapper.toProto(doc))
                .build();
            
            responseObserver.onNext(response);
            responseObserver.onCompleted();
            
        } catch (StatusRuntimeException e) {
            responseObserver.onError(e);
        } catch (Exception e) {
            log.error("Unexpected error in getDocument", e);
            responseObserver.onError(Status.INTERNAL
                .withDescription("Internal server error")
                .asRuntimeException());
        }
    }
    
    // Server streaming RPC
    @Override
    public void listDocuments(ListDocumentsRequest request,
                               StreamObserver<DocumentProto> responseObserver) {
        try {
            // Stream results instead of loading all into memory
            documentService.streamByTenantAndStatus(
                request.getTenantId(),
                request.getStatusFilter().name(),
                document -> {
                    responseObserver.onNext(mapper.toProto(document));
                }
            );
            responseObserver.onCompleted();
        } catch (Exception e) {
            responseObserver.onError(Status.INTERNAL.withCause(e).asRuntimeException());
        }
    }
    
    // Client streaming RPC
    @Override
    public StreamObserver<CreateDocumentRequest> bulkUploadDocuments(
            StreamObserver<BulkUploadResponse> responseObserver) {
        
        List<Long> createdIds = new ArrayList<>();
        AtomicInteger failureCount = new AtomicInteger(0);
        
        return new StreamObserver<>() {
            @Override
            public void onNext(CreateDocumentRequest request) {
                try {
                    Long id = documentService.create(request);
                    createdIds.add(id);
                } catch (Exception e) {
                    failureCount.incrementAndGet();
                    log.warn("Failed to create document: {}", e.getMessage());
                }
            }
            
            @Override
            public void onError(Throwable t) {
                log.error("Client streaming error", t);
            }
            
            @Override
            public void onCompleted() {
                BulkUploadResponse response = BulkUploadResponse.newBuilder()
                    .setSuccessCount(createdIds.size())
                    .setFailureCount(failureCount.get())
                    .addAllCreatedIds(createdIds)
                    .build();
                responseObserver.onNext(response);
                responseObserver.onCompleted();
            }
        };
    }
}
```

### gRPC Client

```java
// Client-side usage
@Service
public class DocumentGrpcClient {
    
    @GrpcClient("pdms-document-service")  // matches application.yml config
    private DocumentServiceGrpc.DocumentServiceBlockingStub blockingStub;
    
    @GrpcClient("pdms-document-service")
    private DocumentServiceGrpc.DocumentServiceStub asyncStub;
    
    // Unary call
    public DocumentDTO getDocument(Long id, String tenantId) {
        GetDocumentRequest request = GetDocumentRequest.newBuilder()
            .setId(id)
            .setTenantId(tenantId)
            .build();
        
        try {
            GetDocumentResponse response = blockingStub
                .withDeadlineAfter(5, TimeUnit.SECONDS)  // Timeout!
                .getDocument(request);
            return mapper.fromProto(response.getDocument());
        } catch (StatusRuntimeException e) {
            if (e.getStatus().getCode() == Status.Code.NOT_FOUND) {
                throw new DocumentNotFoundException(id);
            }
            throw new ServiceException("gRPC call failed", e);
        }
    }
    
    // Streaming call with Iterator
    public List<DocumentDTO> listDocuments(String tenantId) {
        ListDocumentsRequest request = ListDocumentsRequest.newBuilder()
            .setTenantId(tenantId)
            .build();
        
        Iterator<DocumentProto> iterator = blockingStub.listDocuments(request);
        List<DocumentDTO> results = new ArrayList<>();
        iterator.forEachRemaining(doc -> results.add(mapper.fromProto(doc)));
        return results;
    }
}

# application.yml gRPC client config:
grpc:
  client:
    pdms-document-service:
      address: 'discovery:///pdms-document-service'  # K8s DNS
      negotiationType: TLS
      security:
        certificate-chain: classpath:certs/client.crt
        private-key: classpath:certs/client.key
        trust-cert-collection: classpath:certs/ca.crt
```

---

## 🔒 gRPC Security — mTLS

```yaml
# gRPC server TLS config (application.yml)
grpc:
  server:
    port: 9090
    security:
      enabled: true
      certificate-chain: classpath:certs/server.crt
      private-key: classpath:certs/server.key
      trust-cert-collection: classpath:certs/ca.crt  # For mTLS
      client-auth: REQUIRE  # Enforce client certificate (mTLS)
```

---

## 📊 gRPC vs REST Performance

```
Benchmark (typical microservice call, LAN):
  
  REST/JSON (HTTP/1.1):
    Serialization: ~2-5ms (JSON stringify/parse)
    Payload size: 100% (baseline)
    Connections: 1 per request (no multiplexing)
    
  gRPC/Protobuf (HTTP/2):
    Serialization: ~0.2-0.5ms (binary encode/decode)
    Payload size: ~10-30% of JSON
    Connections: Multiplexed (many streams, 1 TCP connection)
    
  Result: gRPC typically 5-10x faster for high-frequency internal calls
  
  Caveat: For simple CRUD with low QPS → difference negligible
```

---

## 📚 Case Study — PDMS Internal Service Mesh

### Architecture Decision

```
PDMS services communication:

External (Internet → PDMS):
  Browser/Mobile → REST/JSON (via API Gateway)
  → Reason: Browser native support, human-readable, easy debugging

Internal (PDMS → PDMS):
  pdms-api-gateway → pdms-document-service  → gRPC
  pdms-process-service → pdms-iam-service   → gRPC
  → Reason: High-frequency calls, strong contract, auto code gen, mTLS native
  
Benefit:
  - API Gateway nhận 10,000 requests/min
  - Mỗi request cần 2-3 internal calls = 20,000-30,000 internal calls/min
  - gRPC: giảm serialization overhead ~80%, giảm payload size ~70%
  - Saving: ~$200/month AWS data transfer cost cho internal traffic
```

---

## 🔑 Key Takeaways

1. **gRPC = HTTP/2 + Protocol Buffers** — binary protocol, multiplexed connections
2. **Protobuf**: field numbers (không phải names) → 5-10x nhỏ hơn JSON
3. **4 communication patterns:** Unary, Server streaming, Client streaming, Bidirectional
4. **Strong contracts:** .proto files là source of truth, auto-generate clients
5. **mTLS native** trong gRPC → tốt cho Zero Trust architecture
6. **Khi dùng gRPC:** internal service APIs, high-frequency calls, streaming needs
7. **Khi dùng REST:** public APIs, browser clients, simplicity priority
8. **Field number stability** quan trọng — không bao giờ thay đổi field numbers sau khi deploy

---

## 🔗 Related Links

- [[zero-trust-architecture]] — mTLS integration với gRPC
- [[kubernetes-architecture]] — gRPC service discovery trong K8s
- [[opentelemetry-deep-dive]] — Distributed tracing qua gRPC calls
- [[api-security-patterns]] — gRPC authentication và authorization
