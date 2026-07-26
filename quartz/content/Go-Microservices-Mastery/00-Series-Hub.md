---
type: moc
domain: languages/go/microservices
status: active
created: 2026-07-27
updated: 2026-07-27
tags: [go, microservices, hands-on, system-design]
aliases: [Go Microservices Mastery, Go Microservices từ Basic đến Production]
---

# Go Microservices Mastery — từ Basic đến Production

> [!abstract] Kết quả cuối series
> Xây dựng **GoCommerce**, một hệ thống commerce/fulfillment chạy được trên máy cá nhân và có đường nâng cấp rõ ràng lên production. Người học không chỉ biết gọi thư viện mà hiểu **vì sao chọn REST, gRPC, Kafka, RabbitMQ, SFTP hay WebSocket tại từng boundary**.

## Bắt đầu ở đâu?

- Chưa chắc Go có phù hợp: [[02-Vi-sao-Go-cho-Microservices]]
- Muốn thấy hệ thống cuối cùng: [[03-Kien-truc-GoCommerce]]
- Muốn bắt tay code ngay: [[04-Chuan-bi-moi-truong-va-Repository]]
- Đã vững Go: bắt đầu từ bài 05, dùng [[Go-Zero-To-Hero/Lộ-trình-Tổng-quan|Go Zero to Hero]] để tra cứu khi cần.

## Case study xuyên suốt

GoCommerce gồm các capability tăng dần theo series:

```mermaid
flowchart LR
    C["Web / Mobile"] --> G["API Gateway"]
    G --> U["Identity"]
    G --> P["Product"]
    G --> O["Order"]
    G --> N["Notification"]
    O --> PG["Payment"]
    O --> W["Warehouse"]
    O -. domain events .-> K[("Kafka")]
    N -. task queue .-> R[("RabbitMQ")]
    W -. partner files .-> S["SFTP Partner"]
    O -. live status .-> WS["WebSocket Gateway"]
```

> [!tip] Một dự án, không phải 48 demo rời rạc
> Mỗi bài tạo một lát cắt có thể chạy và kiểm chứng. Commit/tag đề xuất ở cuối bài giúp quay lại bất kỳ trạng thái nào.

## Lộ trình 52 bài (00–51)

Ký hiệu: ✅ đã có bài chi tiết · 🧱 sẽ triển khai tiếp · 🔗 tận dụng bài chuyên sâu sẵn có.

### Phase 0 — Orientation

| # | Article | Deliverable | Trạng thái |
|---|---|---|---|
| 00 | Series Hub | Bản đồ toàn series | ✅ |
| 01 | [[01-Phuong-phap-hoc-va-Definition-of-Done]] | Cách học, chuẩn hoàn thành | ✅ |
| 02 | [[02-Vi-sao-Go-cho-Microservices]] | Decision record chọn Go | ✅ |
| 03 | [[03-Kien-truc-GoCommerce]] | Context map và luồng nghiệp vụ | ✅ |

### Phase 1 — Foundation: service đầu tiên

| # | Article | Deliverable | Trạng thái |
|---|---|---|---|
| 04 | [[04-Chuan-bi-moi-truong-va-Repository]] | Monorepo, tooling, local infra | ✅ |
| 05 | [[05-Product-Service-Vertical-Slice]] | Product API chạy được | ✅ |
| 06 | [[06-Chuan-Engineering-cho-moi-Service]] | Config, log, error, shutdown | ✅ |
| 07 | [[07-API-Gateway-Full-Feature-Blueprint]] | Gateway production blueprint | ✅ |
| 08 | [[08-Authentication-Authorization-va-Third-Party-Identity]] | AuthN/AuthZ và third-party IdP | ✅ |
| 09 | [[09-Observability-Standard-Metrics-Prometheus-Logs]] | Metrics, Prometheus, distributed logs | ✅ |
| 10 | REST API production | Pagination, validation, Problem Details | 🧱 |
| 11 | PostgreSQL + migrations | Repository thật, transaction | 🧱 |
| 12 | Testing pyramid | Unit, integration, contract | 🧱 |
| 13 | Docker image an toàn | Multi-stage, non-root, healthcheck | 🧱 |

### Phase 2 — Gateway, Identity và tách services

| # | Article | Deliverable | Trạng thái |
|---|---|---|---|
| 14 | Modular monolith trước microservices | Module boundaries | 🧱 |
| 15 | Tách Order service | Strangler migration | 🧱 |
| 16 | Gateway routing và reverse proxy | Route table, discovery, streaming | 🧱 |
| 17 | Gateway security pipeline | TLS, CORS, auth, quotas, WAF hooks | 🧱 |
| 18 | Gateway resilience | Timeout, retry, circuit breaker, load shed | 🧱 |
| 19 | OIDC login và token lifecycle | Authorization Code + PKCE | 🧱 |
| 20 | Third-party identity federation | Google/Microsoft/enterprise IdP | 🧱 |
| 21 | Authorization enforcement | RBAC, ABAC, ReBAC, object-level policy | 🧱 |

### Phase 3 — Event-driven với Kafka

| # | Article | Deliverable | Trạng thái |
|---|---|---|---|
| 22 | Kafka mental model | Topic, partition, offset, group | 🔗 [[Microservices-Patterns/Kafka-Partition-and-Offset-Internals|Deep dive]] |
| 23 | Go producer/consumer | Order events end-to-end | 🔗 [[Go-Zero-To-Hero/Bai-17-Kafka-Sarama|Go + Kafka]] |
| 24 | Event contract và schema evolution | Versioned envelope | 🧱 |
| 25 | Idempotent consumer | Inbox/deduplication | 🧱 |
| 26 | Transactional Outbox | DB + event nhất quán | 🔗 [[Microservices-Patterns/Transactional-Outbox|Outbox pattern]] |
| 27 | Retry topic và DLQ | Poison-message recovery | 🧱 |
| 28 | Ordering, rebalance, backpressure | Consumer vận hành ổn định | 🧱 |
| 29 | Saga choreography | Order–Payment–Inventory | 🔗 [[Microservices-Patterns/Saga-Pattern|Saga pattern]] |

### Phase 4 — RabbitMQ cho task/workflow

| # | Article | Deliverable | Trạng thái |
|---|---|---|---|
| 30 | Kafka hay RabbitMQ? | Decision matrix theo use case | 🧱 |
| 31 | Exchange, queue, binding | Notification topology | 🧱 |
| 32 | Work queue trong Go | Email worker pool | 🧱 |
| 33 | Ack, confirm, prefetch | At-least-once an toàn | 🧱 |
| 34 | TTL, retry, DLX | Retry có kiểm soát | 🧱 |
| 35 | Quorum queue và operations | HA và monitoring | 🧱 |

### Phase 5 — Enterprise integration và realtime

| # | Article | Deliverable | Trạng thái |
|---|---|---|---|
| 36 | SFTP ingestion | Download, checksum, archive | 🧱 |
| 37 | SFTP outbound | Atomic upload, PGP, reconciliation | 🧱 |
| 38 | TCP socket fundamentals | Framing, deadline, connection lifecycle | 🧱 |
| 39 | WebSocket gateway | Live order tracking | 🧱 |
| 40 | Webhook delivery platform | Signature, retry, replay protection | 🧱 |
| 41 | Batch và scheduler phân tán | Lock, leader election | 🧱 |

### Phase 6 — Reliability, observability, security

| # | Article | Deliverable | Trạng thái |
|---|---|---|---|
| 42 | Timeout, retry, circuit breaker | Resilience policy | 🔗 [[Microservices-Patterns/Circuit-Breaker|Circuit Breaker]] |
| 43 | Rate limit và load shedding | Bảo vệ service | 🧱 |
| 44 | OpenTelemetry | Trace xuyên REST/gRPC/broker | 🔗 [[Microservices-Patterns/Distributed-Tracing|Tracing]] |
| 45 | Prometheus + Grafana | Recording rules, dashboard, alert | 🧱 |
| 46 | Distributed logging | Collector, Loki/OpenSearch, retention | 🧱 |
| 47 | Secrets, TLS/mTLS, supply chain | Security baseline | 🧱 |
| 48 | Performance engineering | pprof, benchmark, load test | 🧱 |

### Phase 7 — Production và capstone

| # | Article | Deliverable | Trạng thái |
|---|---|---|---|
| 49 | Kubernetes deployment | Probe, resources, autoscaling | 🧱 |
| 50 | CI/CD và migration strategy | Progressive delivery | 🧱 |
| 51 | Capstone: chaos, DR, production review | Game day + runbook + review | 🧱 |

## Nhịp học đề xuất

- **Nhanh — 12 tuần:** 4 bài/tuần, ưu tiên lab và Definition of Done.
- **Chắc — 24 tuần:** 2 bài/tuần, thêm bài tập mở rộng và viết ADR.
- **Dùng cho team:** 1 phase/sprint; review code và vận hành demo cuối sprint.

## Nguyên tắc công nghệ

1. Standard library trước framework; abstraction chỉ xuất hiện sau khi thấy pain point.
2. PostgreSQL là source of truth; Redis không được dùng như database mặc định.
3. Event delivery mặc định là **at-least-once**; handler phải idempotent.
4. Không dùng distributed transaction như phép màu; dùng local transaction + outbox/saga.
5. Mọi network call đều có timeout, cancellation và quan sát được.
6. Tách service theo business capability, không theo bảng dữ liệu.

## Nguồn chuẩn

- [Go release history](https://go.dev/doc/devel/release)
- [Go 1.26 release notes](https://go.dev/doc/go1.26)
- [Apache Kafka documentation](https://kafka.apache.org/documentation/)
- [RabbitMQ documentation](https://www.rabbitmq.com/docs)
- [gRPC documentation](https://grpc.io/docs/)
- [OpenTelemetry documentation](https://opentelemetry.io/docs/)
- [Kubernetes documentation](https://kubernetes.io/docs/)

---

**Tiếp theo:** [[01-Phuong-phap-hoc-va-Definition-of-Done]]
