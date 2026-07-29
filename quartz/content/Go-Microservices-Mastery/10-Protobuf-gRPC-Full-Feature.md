---
type: tutorial
domain: languages/go/microservices
status: active
created: 2026-07-29
updated: 2026-07-29
tags: [protobuf, grpc, rpc, codegen, streaming]
---

# Bài 10 — Protobuf & gRPC Full-Feature cho Go

> [!success] Deliverable
> `order-service` expose gRPC API bằng Protobuf, có unary + server-streaming, interceptor cho auth/logging/metrics, deadline propagation xuyên client → server, và test chứng minh contract không bị phá khi tiến hóa schema.

## 1. Vì sao Protobuf/gRPC tồn tại song song với REST (bài 05, 07)

| Tiêu chí | REST + JSON | gRPC + Protobuf |
|---|---|---|
| Đối tượng dùng | public API, browser, partner rộng | internal service-to-service |
| Contract | OpenAPI, loose typing lúc runtime | `.proto`, strict typing, codegen hai chiều |
| Payload | text, dễ đọc, lớn hơn | binary, nhỏ hơn, không tự đọc được |
| Streaming | polling/SSE/WebSocket riêng | streaming là tính năng gốc của RPC |
| Versioning | URL/header version, tự quản lý | field number + `reserved`, có kỷ luật rõ ràng |
| Tooling | phổ biến ở mọi ngôn ngữ/trình duyệt | cần codegen, khó gọi trực tiếp từ browser |

Quyết định trong GoCommerce: **Order → Payment**, **Order → Inventory** dùng gRPC (nội bộ, typed, latency thấp); **Client → Gateway** vẫn REST (bài 07). Đây là quyết định ranh giới, không phải "gRPC luôn tốt hơn".

```mermaid
flowchart LR
    Client["Web/Mobile"] -->|"REST/JSON"| GW["API Gateway"]
    GW -->|"REST"| ORD["Order Service"]
    ORD -->|"gRPC/Protobuf"| PAY["Payment Service"]
    ORD -->|"gRPC/Protobuf"| INV["Inventory Service"]
```

## 2. Thiết kế `.proto` có kỷ luật versioning

`api/proto/inventory/v1/inventory.proto`:

```protobuf
syntax = "proto3";

package inventory.v1;

option go_package = "github.com/<your-org>/gocommerce/internal/inventory/inventorypb;inventorypb";

import "google/protobuf/timestamp.proto";

service InventoryService {
  rpc Reserve(ReserveRequest) returns (ReserveResponse);
  rpc Release(ReleaseRequest) returns (ReleaseResponse);
  rpc WatchStock(WatchStockRequest) returns (stream StockEvent);
}

message ReserveRequest {
  string product_id = 1;
  int32 quantity = 2;
  string idempotency_key = 3;
}

message ReserveResponse {
  string reservation_id = 1;
  ReservationStatus status = 2;
  reserved 3, 4; // trường cũ đã xóa — không tái sử dụng số này
}

enum ReservationStatus {
  RESERVATION_STATUS_UNSPECIFIED = 0;
  RESERVATION_STATUS_CONFIRMED = 1;
  RESERVATION_STATUS_INSUFFICIENT_STOCK = 2;
}

message ReleaseRequest {
  string reservation_id = 1;
}

message ReleaseResponse {}

message WatchStockRequest {
  string product_id = 1;
}

message StockEvent {
  string product_id = 1;
  int32 available_quantity = 2;
  google.protobuf.Timestamp occurred_at = 3;
}
```

### Quy tắc field number — đây là hợp đồng nhị phân, không phải thẩm mỹ

- **Không bao giờ** đổi hoặc tái sử dụng số field đã release; wire format chỉ dựa vào số, không dựa vào tên.
- Field bị xóa phải đánh dấu `reserved` (số và/hoặc tên) để tránh cộng tác viên sau vô tình gán lại.
- Thêm field mới luôn optional theo ngữ nghĩa proto3 (không có trường nào "required" trong proto3) — client cũ đọc message mới vẫn chạy được, bỏ qua field lạ.
- Enum luôn có giá trị `..._UNSPECIFIED = 0` để tránh nhầm "chưa set" với "giá trị hợp lệ đầu tiên".

## 3. Toolchain — `buf` thay vì gọi `protoc` tay

`buf.yaml`:

```yaml
version: v2
modules:
  - path: api/proto
lint:
  use: [STANDARD]
breaking:
  use: [FILE]
```

`buf.gen.yaml`:

```yaml
version: v2
plugins:
  - remote: buf.build/protocolbuffers/go
    out: .
    opt: paths=source_relative
  - remote: buf.build/grpc/go
    out: .
    opt: paths=source_relative,require_unimplemented_servers=true
```

```bash
buf lint api/proto
buf breaking api/proto --against '.git#branch=main'
buf generate api/proto
```

`buf breaking` là bước quan trọng nhất trong CI: nó **so sánh proto hiện tại với proto ở `main`** và fail build nếu có breaking change (đổi field number, đổi type, xóa field không `reserved`...). Đây là cách biến "đừng phá contract" từ quy tắc bằng lời thành kiểm tra tự động.

## 4. Server implementation với interceptor chain

`internal/inventory/grpc_server.go`:

```go
package inventory

import (
    "context"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    pb "github.com/<your-org>/gocommerce/internal/inventory/inventorypb"
)

type Server struct {
    pb.UnimplementedInventoryServiceServer
    service *Service
}

func NewServer(service *Service) *Server { return &Server{service: service} }

func (s *Server) Reserve(ctx context.Context, req *pb.ReserveRequest) (*pb.ReserveResponse, error) {
    if req.GetProductId() == "" {
        return nil, status.Error(codes.InvalidArgument, "product_id is required")
    }
    if req.GetQuantity() <= 0 {
        return nil, status.Error(codes.InvalidArgument, "quantity must be positive")
    }

    reservation, err := s.service.Reserve(ctx, req.GetProductId(), int(req.GetQuantity()), req.GetIdempotencyKey())
    switch {
    case errors.Is(err, ErrInsufficientStock):
        return &pb.ReserveResponse{Status: pb.ReservationStatus_RESERVATION_STATUS_INSUFFICIENT_STOCK}, nil
    case err != nil:
        return nil, status.Error(codes.Internal, "reserve failed")
    }
    return &pb.ReserveResponse{
        ReservationId: reservation.ID,
        Status:        pb.ReservationStatus_RESERVATION_STATUS_CONFIRMED,
    }, nil
}
```

`google.golang.org/grpc/status` + `codes` là cách gRPC map lỗi business thành lỗi transport ổn định — tương đương `errors.Is/As` + HTTP status ở bài 06, chỉ khác transport.

### Interceptor: auth, logging, recovery, metrics — một chuỗi, đúng thứ tự

```go
server := grpc.NewServer(
    grpc.ChainUnaryInterceptor(
        RecoveryInterceptor(logger),   // luôn ngoài cùng — bắt panic từ mọi interceptor sau nó
        RequestIDUnaryInterceptor(),
        AuthUnaryInterceptor(verifier), // TokenVerifier từ bài 08
        MetricsUnaryInterceptor(requestsTotal, requestDuration),
        LoggingUnaryInterceptor(logger),
    ),
    grpc.ChainStreamInterceptor(
        RecoveryStreamInterceptor(logger),
        AuthStreamInterceptor(verifier),
    ),
    grpc.KeepaliveParams(keepalive.ServerParameters{
        MaxConnectionIdle: 5 * time.Minute,
        Time:              30 * time.Second,
        Timeout:           10 * time.Second,
    }),
)
```

`AuthUnaryInterceptor` tái dùng nguyên `TokenVerifier` và `JWKSCache` đã viết ở bài 08 — service-to-service call cũng đi qua cùng identity boundary, không có "kênh tin cậy ngầm" giữa các service nội bộ.

## 5. Client: deadline propagation và connection reuse

```go
conn, err := grpc.NewClient(
    "inventory-service:9090",
    grpc.WithTransportCredentials(insecure.NewCredentials()), // production: mTLS, xem bài 47
    grpc.WithKeepaliveParams(keepalive.ClientParameters{
        Time:                20 * time.Second,
        Timeout:             5 * time.Second,
        PermitWithoutStream: true,
    }),
)
if err != nil {
    return fmt.Errorf("dial inventory service: %w", err)
}
defer conn.Close()

client := pb.NewInventoryServiceClient(conn)
```

`grpc.NewClient` chỉ tạo **một** connection dùng cho toàn bộ vòng đời process (giống nguyên tắc "một `http.Transport` dùng lại" ở bài 07) — không gọi `Dial` mới cho mỗi request.

```go
func (o *OrderService) reserveStock(ctx context.Context, productID string, qty int) error {
    ctx, cancel := context.WithTimeout(ctx, 700*time.Millisecond) // nằm trong timeout budget bài 06
    defer cancel()

    resp, err := o.inventoryClient.Reserve(ctx, &pb.ReserveRequest{
        ProductId:      productID,
        Quantity:       int32(qty),
        IdempotencyKey: o.idempotencyKey(ctx),
    })
    if err != nil {
        st, _ := status.FromError(err)
        if st.Code() == codes.DeadlineExceeded {
            return fmt.Errorf("reserve stock timeout: %w", err)
        }
        return fmt.Errorf("reserve stock: %w", err)
    }
    if resp.GetStatus() == pb.ReservationStatus_RESERVATION_STATUS_INSUFFICIENT_STOCK {
        return ErrInsufficientStock
    }
    return nil
}
```

`context.WithTimeout` ở client tự động trở thành gRPC deadline gửi qua wire (`grpc-timeout` header) — server nhận được deadline **còn lại**, không phải deadline gốc, nên chuỗi gọi nhiều hop vẫn tôn trọng budget tổng.

## 6. Server-streaming cho cập nhật tồn kho realtime

```go
func (s *Server) WatchStock(req *pb.WatchStockRequest, stream pb.InventoryService_WatchStockServer) error {
    ch, unsubscribe := s.service.SubscribeStock(req.GetProductId())
    defer unsubscribe()

    for {
        select {
        case event := <-ch:
            if err := stream.Send(&pb.StockEvent{
                ProductId:          event.ProductID,
                AvailableQuantity:  int32(event.Available),
                OccurredAt:         timestamppb.New(event.OccurredAt),
            }); err != nil {
                return err // client disconnect hoặc lỗi network — thoát, đừng log như panic
            }
        case <-stream.Context().Done():
            return stream.Context().Err() // client cancel hoặc deadline — kết thúc sạch
        }
    }
}
```

`stream.Context()` mang cancellation của client stream — nếu client đóng kết nối, `Done()` fire và server phải dừng gửi, không rò rỉ goroutine `SubscribeStock`.

## 7. Case khó — lồng object phức tạp trong Protobuf

Phần này là nơi phần lớn hướng dẫn Protobuf trên mạng dừng lại quá sớm: họ chỉ dạy message phẳng (flat). Thực tế production luôn có **nested message, danh sách message lồng nhau, polymorphism, cấu trúc tự tham chiếu (tree), và payload không biết trước schema**. Dưới đây là năm case khó, mỗi case có lý do vì sao nó khó và cách Go xử lý đúng.

### 7.1 Nested message + repeated nested message — `Order` chứa danh sách `OrderItem` chứa `Product`

Đây là case phổ biến nhất nhưng vẫn hay bị làm sai ở chỗ **ai sở hữu bản sao nào của dữ liệu**.

```protobuf
message Order {
  string id = 1;
  repeated OrderItem items = 2;
  Money total = 3;
}

message OrderItem {
  Product product = 1;   // nested message — không phải chỉ product_id
  int32 quantity = 2;
  Money line_total = 3;
}

message Product {
  string id = 1;
  string name = 2;
  Money price = 3;
}

message Money {
  string currency_code = 1;
  int64 minor_units = 2; // giống bài 05 — không dùng float cho tiền
}
```

Go codegen sinh nested message thành **pointer field**, không phải value:

```go
type OrderItem struct {
    Product   *Product `protobuf:"bytes,1,opt,name=product,proto3"`
    Quantity  int32    `protobuf:"varint,2,opt,name=quantity,proto3"`
    LineTotal *Money   `protobuf:"bytes,3,opt,name=line_total,proto3"`
}
```

> [!danger] Bẫy phổ biến nhất: quên nil-check nested pointer
> `item.Product.Name` sẽ **panic** nếu `Product` chưa được set — vì proto3 message field luôn là con trỏ, `nil` là giá trị hợp lệ và phổ biến (ví dụ deserialize từ client cũ chưa có field này). Luôn dùng generated getter (`item.GetProduct().GetName()`), không truy cập field trực tiếp khi có khả năng nested message rỗng.

```go
func lineDescription(item *pb.OrderItem) string {
    // ĐÚNG: getter tự trả zero-value nếu Product == nil, không panic
    return fmt.Sprintf("%s x%d", item.GetProduct().GetName(), item.GetQuantity())
}
```

### 7.2 `oneof` cho polymorphism — chiết khấu có thể là phần trăm hoặc số tiền cố định

`oneof` là cách Protobuf biểu diễn "đúng một trong nhiều loại nested message" — tương đương sum type/tagged union.

```protobuf
message Discount {
  oneof kind {
    PercentageDiscount percentage = 1;
    FixedAmountDiscount fixed_amount = 2;
  }
}

message PercentageDiscount {
  int32 basis_points = 1; // 1000 = 10.00%
}

message FixedAmountDiscount {
  Money amount = 1;
}
```

Codegen sinh một **interface riêng** cho oneof, mỗi variant là một struct implement interface đó — pattern gần nhất Protobuf có với sealed interface của Go:

```go
type Discount struct {
    Kind isDiscount_Kind `protobuf:"..."`
}

type isDiscount_Kind interface{ isDiscount_Kind() }

type Discount_Percentage struct{ Percentage *PercentageDiscount }
type Discount_FixedAmount struct{ FixedAmount *FixedAmountDiscount }
```

Xử lý bằng type switch — chỗ nhiều người viết sai vì quên `default` khi thêm variant mới sau này:

```go
func applyDiscount(subtotal int64, discount *pb.Discount) (int64, error) {
    switch kind := discount.GetKind().(type) {
    case *pb.Discount_Percentage:
        return subtotal - (subtotal * int64(kind.Percentage.GetBasisPoints()) / 10000), nil
    case *pb.Discount_FixedAmount:
        return subtotal - kind.FixedAmount.GetAmount().GetMinorUnits(), nil
    case nil:
        return subtotal, nil // chưa set discount — hợp lệ, không phải lỗi
    default:
        // BẮT BUỘC có nhánh này. Khi ai đó thêm variant thứ 3 vào .proto mà quên
        // cập nhật hàm này, code phải fail rõ ràng thay vì âm thầm bỏ qua discount.
        return 0, fmt.Errorf("unhandled discount kind: %T", kind)
    }
}
```

### 7.3 Cấu trúc tự tham chiếu (recursive message) — cây danh mục sản phẩm

Category có thể có category con, sinh cấu trúc tree lồng nhau không giới hạn độ sâu — Protobuf hỗ trợ recursive message trực tiếp vì `repeated` field chỉ là con trỏ tới message khác, không nhúng giá trị.

```protobuf
message Category {
  string id = 1;
  string name = 2;
  repeated Category children = 3; // tự tham chiếu — hợp lệ vì children là con trỏ
}
```

Duyệt cây bằng đệ quy, có phòng thủ cycle nếu dữ liệu từ service khác bị lỗi:

```go
func flattenCategories(root *pb.Category, seen map[string]bool) []*pb.Category {
    if root == nil || seen[root.GetId()] {
        return nil // chặn vòng lặp vô hạn nếu dữ liệu có cycle bất thường
    }
    seen[root.GetId()] = true

    result := []*pb.Category{root}
    for _, child := range root.GetChildren() {
        result = append(result, flattenCategories(child, seen)...)
    }
    return result
}
```

> [!tip] Vì sao `seen map[string]bool` không phải phòng thủ thừa
> Protobuf chỉ ngăn cycle ở compile time trong file `.proto`. Runtime data từ service khác hoàn toàn có thể có cycle do bug; đệ quy không phòng thủ sẽ stack-overflow production.

### 7.4 `google.protobuf.Any` — envelope sự kiện domain chứa payload không đồng nhất

```protobuf
import "google/protobuf/any.proto";
import "google/protobuf/timestamp.proto";

message DomainEvent {
  string event_id = 1;
  string event_type = 2;
  google.protobuf.Timestamp occurred_at = 3;
  google.protobuf.Any payload = 4; // có thể là OrderPlaced, PaymentAuthorized, ...
}
```

`Any` lưu payload dưới dạng `type_url + bytes` — Go phải "mở" nó bằng đúng type đích, và luôn xử lý trường hợp không khớp:

```go
func handleDomainEvent(event *pb.DomainEvent) error {
    switch event.GetEventType() {
    case "order.placed":
        var placed pb.OrderPlaced
        if err := event.GetPayload().UnmarshalTo(&placed); err != nil {
            return fmt.Errorf("unmarshal OrderPlaced: %w", err)
        }
        return handleOrderPlaced(&placed)
    case "payment.authorized":
        var authorized pb.PaymentAuthorized
        if err := event.GetPayload().UnmarshalTo(&authorized); err != nil {
            return fmt.Errorf("unmarshal PaymentAuthorized: %w", err)
        }
        return handlePaymentAuthorized(&authorized)
    default:
        // Consumer cũ gặp event_type mới hơn nó biết — bỏ qua có log, KHÔNG crash.
        // Ngược với case 7.2 (nội bộ 1 service, phải fail cứng): domain event là
        // contract liên service, consumer cũ phải sống sót khi có type mới.
        logger.Warn("unknown event type, skipping", "event_type", event.GetEventType())
        return nil
    }
}
```

> [!important] So sánh 7.2 và 7.4 — cùng "case chưa biết", xử lý ngược nhau
> `oneof` nội bộ service (7.2): variant mới bắt buộc sửa code, `default` phải fail cứng. `Any` giữa nhiều service độc lập deploy (7.4): consumer cũ phải sống sót khi có event type mới, `default` phải bỏ qua có log. Nhầm hai nguyên tắc này là lỗi kiến trúc phổ biến nhất khi mới dùng oneof/Any.

### 7.5 `google.protobuf.Struct` — khi schema thật sự không biết trước

```protobuf
import "google/protobuf/struct.proto";

message PartnerShipmentNotice {
  string shipment_id = 1;
  google.protobuf.Struct partner_metadata = 2; // đối tác tự quyết định field bên trong
}
```

```go
metadata := notice.GetPartnerMetadata().AsMap() // map[string]any
if carrier, ok := metadata["carrier_code"].(string); ok {
    // luôn qua type assertion có kiểm tra ok — Struct không có type safety như message thường
}
```

> [!warning] `Struct` là lối thoát, không phải mặc định
> Nếu field xuất hiện ổn định và có ý nghĩa nghiệp vụ rõ, đưa vào message thật (case 7.1) để có type safety và `buf breaking` bảo vệ. `Struct` chỉ dành cho phần dữ liệu thật sự không kiểm soát được schema từ phía mình.

### Test chống nested-nil và cycle — bắt buộc, không phải optional

```go
func TestApplyDiscount_HandlesNilKind(t *testing.T) {
    result, err := applyDiscount(10000, &pb.Discount{}) // Kind chưa set
    if err != nil || result != 10000 {
        t.Fatalf("expected no-op discount, got result=%d err=%v", result, err)
    }
}

func TestFlattenCategories_HandlesCycle(t *testing.T) {
    a := &pb.Category{Id: "a"}
    b := &pb.Category{Id: "b", Children: []*pb.Category{a}}
    a.Children = []*pb.Category{b} // cycle nhân tạo — mô phỏng dữ liệu lỗi từ service khác

    done := make(chan []*pb.Category, 1)
    go func() { done <- flattenCategories(a, map[string]bool{}) }()

    select {
    case result := <-done:
        if len(result) != 2 {
            t.Fatalf("expected 2 categories, got %d", len(result))
        }
    case <-time.After(time.Second):
        t.Fatal("flattenCategories did not terminate — infinite recursion on cycle")
    }
}
```

`TestFlattenCategories_HandlesCycle` dùng goroutine + `time.After` để biến "có thể treo vô hạn" thành test xác định, có timeout — cách chuẩn để kiểm chứng một hàm đệ quy thiếu cycle-guard sẽ thật sự treo, thay vì hy vọng suông.

## 🔬 Đào sâu kỹ thuật — Protobuf nhanh hơn JSON bao nhiêu, và tại sao

Tuyên bố "Protobuf nhỏ hơn/nhanh hơn JSON" cần bằng chứng đo được, không phải trích dẫn blog.

```mermaid
flowchart TB
    M["ReserveResponse struct"] --> J["json.Marshal — text, field name lặp lại mỗi lần"]
    M --> P["proto.Marshal — binary, chỉ field number + wire type + value"]
    J --> SJ["Kích thước JSON"]
    P --> SP["Kích thước Protobuf — thường nhỏ hơn đáng kể"]
```

`internal/inventory/encoding_bench_test.go`:

```go
package inventory

import (
    "encoding/json"
    "testing"

    "google.golang.org/protobuf/proto"
    pb "github.com/<your-org>/gocommerce/internal/inventory/inventorypb"
)

type jsonReserveResponse struct {
    ReservationID string `json:"reservation_id"`
    Status        string `json:"status"`
}

func BenchmarkMarshal_JSON(b *testing.B) {
    v := jsonReserveResponse{ReservationID: "res-12345", Status: "RESERVATION_STATUS_CONFIRMED"}
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        _, _ = json.Marshal(v)
    }
}

func BenchmarkMarshal_Protobuf(b *testing.B) {
    v := &pb.ReserveResponse{
        ReservationId: "res-12345",
        Status:        pb.ReservationStatus_RESERVATION_STATUS_CONFIRMED,
    }
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        _, _ = proto.Marshal(v)
    }
}
```

```bash
go test -bench=Marshal_ -benchmem ./internal/inventory/
```

Lý do Protobuf thường thắng cả về kích thước lẫn tốc độ: JSON lặp lại **tên field** dạng text trong mọi message (`"reservation_id"` luôn 16 ký tự); Protobuf chỉ ghi **tag number + wire type** (thường 1 byte) rồi tới value — enum còn được encode dạng varint. Cái giá đánh đổi: Protobuf không tự đọc được bằng mắt và cần codegen — đây là lý do bài 11 (GraphQL) và bài 07 (REST Gateway) vẫn giữ JSON ở boundary hướng tới client/browser, nơi tính người-đọc-được và tương thích rộng quan trọng hơn vài trăm byte tiết kiệm.

### Xác nhận `buf breaking` thật sự chặn được lỗi

Test tình huống: đổi field number của `reservation_id` từ `1` thành `2` trong nhánh thử nghiệm rồi chạy lại `buf breaking` — build phải fail. Đây là bài tập bắt buộc, không phải tùy chọn, vì lỗi field-number là loại lỗi **không panic lúc build, chỉ vỡ dữ liệu lúc chạy** — nguy hiểm nhất trong toàn bộ hệ thống RPC.

## Definition of Done

- [ ] `buf lint` và `buf breaking` chạy trong CI, fail khi phá contract.
- [ ] Enum có giá trị `..._UNSPECIFIED = 0`; field đã xóa được `reserved`.
- [ ] Server áp dụng interceptor chain: recovery ngoài cùng, sau đó auth, metrics, logging.
- [ ] Client dùng một connection dùng lại (`grpc.NewClient` một lần), không dial mỗi request.
- [ ] `context.WithTimeout` ở client truyền đúng deadline còn lại qua gRPC.
- [ ] Server-streaming dừng sạch khi `stream.Context().Done()`.
- [ ] Benchmark Protobuf vs JSON chạy được và giải thích được vì sao có chênh lệch.
- [ ] Nested pointer field luôn truy cập qua getter, không truy cập trực tiếp.
- [ ] `oneof` xử lý có nhánh `default` fail cứng khi gặp variant chưa biết.
- [ ] Đệ quy trên recursive message (category tree) có cycle-guard và test timeout.
- [ ] `Any` envelope xử lý `event_type` lạ bằng bỏ qua có log, không crash consumer.

## Nguồn chuẩn

- [Protocol Buffers language guide (proto3)](https://protobuf.dev/programming-guides/proto3/)
- [gRPC Go documentation](https://grpc.io/docs/languages/go/)
- [Buf CLI documentation](https://buf.build/docs/introduction)

---

**Trước:** [[09-Observability-Standard-Metrics-Prometheus-Logs]] · **Tiếp theo:** [[11-GraphQL-Full-Feature]]
