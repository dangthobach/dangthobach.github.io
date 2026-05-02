# Bài 18: gRPC với Go — Protobuf, Unary & Streaming

> **Mục tiêu:** Build gRPC services trong Go — proto3 definition, code generation, interceptors, server/client streaming, health check.

---

## 1. gRPC vs REST — Khi nào dùng?

```
┌──────────────────────────────────────────────────────────────┐
│                   gRPC vs REST                               │
├───────────────────────────┬──────────────────────────────────┤
│  REST                     │  gRPC                           │
├───────────────────────────┼──────────────────────────────────┤
│  JSON (text)              │  Protobuf (binary, 3-10x smaller)│
│  HTTP/1.1 (mostly)        │  HTTP/2 (multiplexed)           │
│  Any client               │  Generated stubs only           │
│  Discoverable/human read  │  Need .proto contract           │
│  No streaming built-in    │  4 streaming modes              │
│  Latency: higher          │  Latency: 2-7x lower            │
│  External APIs            │  Internal microservices         │
└───────────────────────────┴──────────────────────────────────┘

USE gRPC WHEN:
✅ Internal service-to-service communication
✅ High-throughput, low-latency requirements
✅ Bi-directional streaming (real-time)
✅ Multiple languages in the system
✅ Strict API contract enforcement
```

---

## 2. Proto Definition

```protobuf
// proto/document/v1/document.proto
syntax = "proto3";

package document.v1;

option go_package = "github.com/bach/pdms/gen/document/v1;documentv1";

import "google/protobuf/timestamp.proto";
import "google/protobuf/empty.proto";

// Messages
message Document {
  string id          = 1;
  string title       = 2;
  string content     = 3;
  string status      = 4;
  string owner_id    = 5;
  google.protobuf.Timestamp created_at = 6;
  google.protobuf.Timestamp updated_at = 7;
}

message GetDocumentRequest  { string id = 1; }
message CreateDocumentRequest {
  string title    = 1;
  string content  = 2;
  string owner_id = 3;
}
message ListDocumentsRequest {
  string owner_id = 1;
  int32  page     = 2;
  int32  limit    = 3;
}
message ListDocumentsResponse {
  repeated Document documents = 1;
  int64 total = 2;
}
message WatchDocumentRequest { string doc_id = 1; }
message DocumentEvent {
  string event_type = 1;
  Document document = 2;
  google.protobuf.Timestamp occurred_at = 3;
}

// Service definition — 4 types of RPC
service DocumentService {
  // Unary: 1 request → 1 response
  rpc GetDocument(GetDocumentRequest) returns (Document);
  rpc CreateDocument(CreateDocumentRequest) returns (Document);
  
  // Server streaming: 1 request → N responses
  rpc ListDocuments(ListDocumentsRequest) returns (stream Document);
  
  // Client streaming: N requests → 1 response
  rpc BulkCreateDocuments(stream CreateDocumentRequest) returns (ListDocumentsResponse);
  
  // Bidirectional streaming: N requests ↔ N responses
  rpc WatchDocument(stream WatchDocumentRequest) returns (stream DocumentEvent);
}
```

```bash
# Code generation
# Install tools
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# Generate
protoc --go_out=. --go_opt=paths=source_relative \
       --go-grpc_out=. --go-grpc_opt=paths=source_relative \
       proto/document/v1/document.proto
```

---

## 3. Server Implementation

```go
// go get google.golang.org/grpc
// go get google.golang.org/protobuf

import (
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    pb "github.com/bach/pdms/gen/document/v1"
)

type documentGRPCServer struct {
    pb.UnimplementedDocumentServiceServer // Forward compatibility
    svc *DocumentService
}

// Unary RPC
func (s *documentGRPCServer) GetDocument(ctx context.Context, req *pb.GetDocumentRequest) (*pb.Document, error) {
    doc, err := s.svc.GetDocument(ctx, req.GetId())
    if err != nil {
        if errors.Is(err, ErrNotFound) {
            return nil, status.Errorf(codes.NotFound, "document %s not found", req.GetId())
        }
        return nil, status.Errorf(codes.Internal, "internal error: %v", err)
    }
    return toProto(doc), nil
}

// Server streaming — stream nhiều documents về client
func (s *documentGRPCServer) ListDocuments(req *pb.ListDocumentsRequest, stream pb.DocumentService_ListDocumentsServer) error {
    docs, _, err := s.svc.List(stream.Context(), req.GetOwnerId(), req.GetPage(), req.GetLimit())
    if err != nil {
        return status.Errorf(codes.Internal, "list: %v", err)
    }
    
    for _, doc := range docs {
        // Check if client cancelled
        if err := stream.Context().Err(); err != nil {
            return nil
        }
        
        if err := stream.Send(toProto(doc)); err != nil {
            return status.Errorf(codes.Unavailable, "send: %v", err)
        }
    }
    return nil
}

// Client streaming — nhận nhiều requests từ client
func (s *documentGRPCServer) BulkCreateDocuments(stream pb.DocumentService_BulkCreateDocumentsServer) error {
    var created []*pb.Document
    
    for {
        req, err := stream.Recv()
        if err == io.EOF {
            // Client done sending — send final response
            return stream.SendAndClose(&pb.ListDocumentsResponse{
                Documents: created,
                Total:     int64(len(created)),
            })
        }
        if err != nil {
            return status.Errorf(codes.Internal, "recv: %v", err)
        }
        
        doc, err := s.svc.Create(stream.Context(), req.GetTitle(), req.GetContent(), req.GetOwnerId())
        if err != nil {
            return status.Errorf(codes.Internal, "create: %v", err)
        }
        created = append(created, toProto(doc))
    }
}

// Bidirectional streaming — real-time document watching
func (s *documentGRPCServer) WatchDocument(stream pb.DocumentService_WatchDocumentServer) error {
    events := s.eventBus.Subscribe()
    defer s.eventBus.Unsubscribe(events)
    
    for {
        select {
        case <-stream.Context().Done():
            return nil
            
        case event := <-events:
            if err := stream.Send(&pb.DocumentEvent{
                EventType: event.Type,
                Document:  toProto(event.Doc),
            }); err != nil {
                return err
            }
        }
    }
}
```

---

## 4. Interceptors (Middleware for gRPC)

```go
// Unary interceptor — like middleware for single requests
func UnaryLoggingInterceptor(
    ctx context.Context,
    req interface{},
    info *grpc.UnaryServerInfo,
    handler grpc.UnaryHandler,
) (interface{}, error) {
    start := time.Now()
    
    // Before handler
    log.Printf("gRPC: %s called", info.FullMethod)
    
    resp, err := handler(ctx, req) // Call actual handler
    
    // After handler
    log.Printf("gRPC: %s completed in %v, err: %v", info.FullMethod, time.Since(start), err)
    
    return resp, err
}

// Auth interceptor — validate JWT from metadata
func UnaryAuthInterceptor(secret []byte) grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
        // Skip auth for health check
        if info.FullMethod == "/grpc.health.v1.Health/Check" {
            return handler(ctx, req)
        }
        
        md, ok := metadata.FromIncomingContext(ctx)
        if !ok {
            return nil, status.Error(codes.Unauthenticated, "missing metadata")
        }
        
        tokens := md.Get("authorization")
        if len(tokens) == 0 {
            return nil, status.Error(codes.Unauthenticated, "missing token")
        }
        
        claims, err := parseJWT(strings.TrimPrefix(tokens[0], "Bearer "), secret)
        if err != nil {
            return nil, status.Error(codes.Unauthenticated, "invalid token")
        }
        
        // Inject into context
        ctx = context.WithValue(ctx, "userID", claims.UserID)
        return handler(ctx, req)
    }
}

// Start server với interceptors
func StartGRPCServer(svc *DocumentService, cfg Config) error {
    srv := grpc.NewServer(
        grpc.ChainUnaryInterceptor(
            UnaryLoggingInterceptor,
            UnaryAuthInterceptor(cfg.JWTSecret),
            grpc_recovery.UnaryServerInterceptor(), // recover from panics
        ),
        grpc.ChainStreamInterceptor(
            StreamLoggingInterceptor,
        ),
    )
    
    pb.RegisterDocumentServiceServer(srv, &documentGRPCServer{svc: svc})
    
    // Health check service
    grpc_health_v1.RegisterHealthServer(srv, health.NewServer())
    
    // Reflection — for grpcurl/grpc-ui
    reflection.Register(srv)
    
    lis, _ := net.Listen("tcp", ":50051")
    return srv.Serve(lis)
}
```

---

## 5. gRPC Client

```go
// Connect với options
conn, err := grpc.NewClient(
    "document-service:50051",
    grpc.WithTransportCredentials(insecure.NewCredentials()), // dev
    // grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{})), // prod
    grpc.WithDefaultCallOptions(
        grpc.MaxCallRecvMsgSize(10*1024*1024), // 10MB
    ),
)
defer conn.Close()

client := pb.NewDocumentServiceClient(conn)

// Unary call với timeout
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()

// Attach JWT to request
ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+jwtToken)

doc, err := client.GetDocument(ctx, &pb.GetDocumentRequest{Id: "doc-123"})

// Client streaming
stream, _ := client.BulkCreateDocuments(ctx)
for _, req := range requests {
    stream.Send(req)
}
response, err := stream.CloseAndRecv()
```

---

## 6. Tips & Tricks

```
💡 TIP 1: Luôn embed UnimplementedXxxServer
   → Forward compatible khi thêm methods mới vào proto
   → Không implement method mới → default "Unimplemented" response

💡 TIP 2: status.Errorf thay vì plain error
   return nil, status.Errorf(codes.NotFound, "doc %s not found", id)
   → Client nhận đúng gRPC status code

💡 TIP 3: grpcurl để test thay vì curl
   grpcurl -plaintext localhost:50051 list
   grpcurl -d '{"id":"doc-123"}' localhost:50051 document.v1.DocumentService/GetDocument

💡 TIP 4: gRPC-gateway cho REST + gRPC cùng lúc
   → Tạo REST API tự động từ proto annotations
   → Giảm duplication giữa REST và gRPC services

💡 TIP 5: Tracing với OpenTelemetry
   grpc.WithUnaryInterceptor(otelgrpc.UnaryClientInterceptor())
   → Auto-propagate trace context qua gRPC calls
```

---

## 7. Tổng kết Bài 18

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ Proto3 → codegen → type-safe server/client      │
│  ✅ 4 RPC types: unary, server/client/bidi stream  │
│  ✅ UnimplementedXxxServer cho forward compat       │
│  ✅ Interceptors = middleware cho unary + stream    │
│  ✅ metadata package để pass JWT, trace ID          │
│  ✅ Reflection + health check cho production         │
│  ✅ grpcurl để manual test gRPC endpoints            │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-19-Config-Log-Trace|Bài 19: Config, Logging & Distributed Tracing]]

---
*Tags: #go #grpc #protobuf #streaming #interceptors #zero-to-hero*
