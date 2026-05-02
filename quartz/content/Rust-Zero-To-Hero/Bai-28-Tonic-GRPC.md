# Bài 28: Tonic / gRPC — Full Course từ Cơ Bản đến Nâng Cao

> **Prerequisite:** Bài 9 (Tokio) + Bài 24-25 (Web Frameworks)  
> **Mục tiêu:** Build production gRPC microservices, hiểu 4 streaming modes, interceptors, reflection, và tích hợp với Axum gateway

---

## 🗺️ Bức Tranh Tổng Quan

```
gRPC Architecture:

  ┌──────────────────┐          ┌──────────────────────────────────┐
  │   Client (Rust)  │          │        Tonic Server              │
  │                  │          │                                  │
  │  UserClient      │          │  UserServiceImpl                 │
  │    .get_user()   │──HTTP/2─▶│    .get_user() ← Unary          │
  │    .list_users() │◀═══════╗ │    .list_users() ← Server Stream│
  │    .update()     │═══════╗║ │    .update() ← Client Stream    │
  │    .chat()       │◀═════╗║║ │    .chat() ← Bidi Stream        │
  └──────────────────┘      ║║║ └──────────────────────────────────┘
                             ║║║
         Protobuf binary ────╝║║
         (5-10x nhỏ hơn JSON) ║║
         HTTP/2 multiplexed ──╝║
         (nhiều stream trên 1 connection)
                               ║
         Type-safe từ .proto ──╝
         (compiler check cả client lẫn server)

4 RPC Modes:
  ┌───────────────┬────────────────┬────────────────────────────┐
  │ Mode          │ Client → Server│ Server → Client            │
  ├───────────────┼────────────────┼────────────────────────────┤
  │ Unary         │ 1 message      │ 1 message                  │
  │ Server Stream │ 1 message      │ N messages (stream)        │
  │ Client Stream │ N messages     │ 1 message                  │
  │ Bidi Stream   │ N messages     │ N messages                 │
  └───────────────┴────────────────┴────────────────────────────┘

Java analog: gRPC-Java + Spring gRPC / io.grpc
```

---

## PHẦN 1 — Setup & Project Structure

### 1.1 Dependencies

```toml
[dependencies]
tonic = "0.12"
prost = "0.13"
prost-types = "0.13"            # Google well-known types (Timestamp, Duration...)
tokio = { version = "1", features = ["full"] }
tokio-stream = "0.1"
futures-util = "0.3"
tonic-reflection = "0.12"       # gRPC reflection (grpcurl support)
tonic-health = "0.12"           # gRPC health check protocol
tracing = "0.1"
tracing-subscriber = "0.3"
sqlx = { version = "0.7", features = ["postgres", "runtime-tokio"] }
thiserror = "1"
uuid = { version = "1", features = ["v4"] }

[build-dependencies]
tonic-build = "0.12"
```

### 1.2 build.rs — Compile .proto → Rust

```rust
// build.rs
fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Compile proto files và generate code
    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        // Generate file descriptor cho reflection
        .file_descriptor_set_path("target/file_descriptor_set.bin")
        // Optional: custom output dir
        // .out_dir("src/generated")
        .compile(
            &[
                "proto/user/v1/user.proto",
                "proto/document/v1/document.proto",
            ],
            &["proto"], // include path
        )?;

    Ok(())
}
```

### 1.3 Project Structure

```
my-grpc-service/
├── build.rs
├── Cargo.toml
├── proto/
│   ├── user/
│   │   └── v1/
│   │       └── user.proto
│   └── document/
│       └── v1/
│           └── document.proto
└── src/
    ├── main.rs
    ├── proto.rs          ← tonic::include_proto! macro
    ├── services/
    │   ├── user_service.rs
    │   └── document_service.rs
    ├── interceptors/
    │   ├── auth.rs
    │   └── logging.rs
    └── errors.rs
```

---

## PHẦN 2 — Protobuf Design

### 2.1 .proto File — Best Practices

```protobuf
// proto/user/v1/user.proto
syntax = "proto3";

package user.v1;

// Import Google well-known types
import "google/protobuf/timestamp.proto";
import "google/protobuf/empty.proto";
import "google/protobuf/field_mask.proto";

// ─── Service Definition ───────────────────────────────────────────

service UserService {
    // Unary — 1 request, 1 response (như REST GET)
    rpc GetUser (GetUserRequest) returns (UserResponse);

    // Unary — create
    rpc CreateUser (CreateUserRequest) returns (UserResponse);

    // Unary — update với FieldMask (chỉ cập nhật fields được chỉ định)
    rpc UpdateUser (UpdateUserRequest) returns (UserResponse);

    // Unary — delete
    rpc DeleteUser (DeleteUserRequest) returns (google.protobuf.Empty);

    // Server-side streaming — trả về nhiều users (pagination alternative)
    rpc ListUsers (ListUsersRequest) returns (stream UserResponse);

    // Client-side streaming — bulk import
    rpc BulkCreateUsers (stream CreateUserRequest) returns (BulkCreateResponse);

    // Bidirectional streaming — real-time sync
    rpc SyncUsers (stream SyncRequest) returns (stream SyncResponse);
}

// ─── Message Definitions ──────────────────────────────────────────

message GetUserRequest {
    int64 id = 1;
}

message CreateUserRequest {
    string name = 1;
    string email = 2;
    string role = 3;                    // "admin" | "user" | "viewer"
}

message UpdateUserRequest {
    int64 id = 1;
    string name = 2;
    string email = 3;
    string role = 4;
    google.protobuf.FieldMask update_mask = 5;  // chỉ update fields này
}

message DeleteUserRequest {
    int64 id = 1;
}

message UserResponse {
    int64 id = 1;
    string name = 2;
    string email = 3;
    string role = 4;
    UserStatus status = 5;
    google.protobuf.Timestamp created_at = 6;
    google.protobuf.Timestamp updated_at = 7;
}

message ListUsersRequest {
    int32 page_size = 1;          // default 20
    string page_token = 2;        // cursor-based pagination
    string filter = 3;            // "status=active AND role=admin"
    string order_by = 4;          // "created_at desc"
}

message BulkCreateResponse {
    int32 created = 1;
    int32 failed = 2;
    repeated BulkError errors = 3;
}

message BulkError {
    int32 index = 1;
    string reason = 2;
}

message SyncRequest {
    oneof payload {
        CreateUserRequest create = 1;
        UpdateUserRequest update = 2;
        DeleteUserRequest delete = 3;
    }
}

message SyncResponse {
    int64 sequence = 1;
    bool success = 2;
    string error = 3;
}

// ─── Enums ───────────────────────────────────────────────────────

enum UserStatus {
    USER_STATUS_UNSPECIFIED = 0;  // proto3: luôn có 0 value
    USER_STATUS_ACTIVE = 1;
    USER_STATUS_INACTIVE = 2;
    USER_STATUS_SUSPENDED = 3;
}
```

### 2.2 Include Generated Code

```rust
// src/proto.rs
pub mod user {
    pub mod v1 {
        tonic::include_proto!("user.v1");

        // File descriptor cho reflection
        pub const FILE_DESCRIPTOR_SET: &[u8] =
            include_bytes!("../target/file_descriptor_set.bin");
    }
}

pub mod document {
    pub mod v1 {
        tonic::include_proto!("document.v1");
    }
}
```

---

## PHẦN 3 — Server Implementation

### 3.1 Unary RPC

```rust
use crate::proto::user::v1::{
    user_service_server::UserService,
    GetUserRequest, UserResponse, CreateUserRequest,
    DeleteUserRequest, UserStatus,
};
use tonic::{Request, Response, Status};

#[derive(Debug, Clone)]
pub struct UserServiceImpl {
    db: sqlx::PgPool,
}

#[tonic::async_trait]
impl UserService for UserServiceImpl {
    // GET USER — Unary
    async fn get_user(
        &self,
        request: Request<GetUserRequest>,
    ) -> Result<Response<UserResponse>, Status> {
        // Extract metadata (headers) từ request
        let metadata = request.metadata();
        let trace_id = metadata.get("x-trace-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("unknown");

        tracing::info!(trace_id = trace_id, "get_user called");

        let req = request.into_inner();

        // DB query
        let row = sqlx::query!(
            "SELECT id, name, email, role, status, created_at, updated_at
             FROM users WHERE id = $1",
            req.id
        )
        .fetch_optional(&self.db)
        .await
        .map_err(|e| {
            tracing::error!("DB error: {}", e);
            Status::internal("Database error")
        })?
        .ok_or_else(|| Status::not_found(format!("User {} not found", req.id)))?;

        let response = UserResponse {
            id: row.id,
            name: row.name,
            email: row.email,
            role: row.role,
            status: match row.status.as_str() {
                "active" => UserStatus::Active as i32,
                "inactive" => UserStatus::Inactive as i32,
                "suspended" => UserStatus::Suspended as i32,
                _ => UserStatus::Unspecified as i32,
            },
            created_at: Some(prost_types::Timestamp {
                seconds: row.created_at.timestamp(),
                nanos: row.created_at.timestamp_subsec_nanos() as i32,
            }),
            updated_at: Some(prost_types::Timestamp {
                seconds: row.updated_at.timestamp(),
                nanos: row.updated_at.timestamp_subsec_nanos() as i32,
            }),
        };

        Ok(Response::new(response))
    }

    // DELETE USER
    async fn delete_user(
        &self,
        request: Request<DeleteUserRequest>,
    ) -> Result<Response<prost_types::Empty>, Status> {
        let req = request.into_inner();

        let result = sqlx::query!("DELETE FROM users WHERE id = $1", req.id)
            .execute(&self.db)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(Status::not_found(format!("User {} not found", req.id)));
        }

        Ok(Response::new(prost_types::Empty {}))
    }
}
```

### 3.2 Server-side Streaming

```rust
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

#[tonic::async_trait]
impl UserService for UserServiceImpl {
    // Stream type — associated type
    type ListUsersStream = ReceiverStream<Result<UserResponse, Status>>;

    // LIST USERS — Server streaming
    async fn list_users(
        &self,
        request: Request<ListUsersRequest>,
    ) -> Result<Response<Self::ListUsersStream>, Status> {
        let req = request.into_inner();
        let page_size = req.page_size.max(1).min(1000) as i64;

        let db = self.db.clone();

        // Channel buffer — back-pressure control
        let (tx, rx) = mpsc::channel(100);

        // Spawn background task để stream data
        tokio::spawn(async move {
            // Dùng sqlx streaming cursor
            let mut stream = sqlx::query_as!(
                UserRow,
                "SELECT id, name, email, role, status, created_at, updated_at
                 FROM users
                 ORDER BY id
                 LIMIT $1",
                page_size
            )
            .fetch(&db); // trả về Stream, không load hết vào RAM!

            use futures_util::StreamExt;

            while let Some(result) = stream.next().await {
                match result {
                    Ok(row) => {
                        let user = UserResponse {
                            id: row.id,
                            name: row.name,
                            email: row.email,
                            role: row.role,
                            status: 1,
                            created_at: None,
                            updated_at: None,
                        };

                        // Gửi từng user qua stream
                        // Nếu client disconnect, tx.send fail → break
                        if tx.send(Ok(user)).await.is_err() {
                            tracing::info!("Client disconnected during stream");
                            break;
                        }
                    }
                    Err(e) => {
                        // Gửi error, kết thúc stream
                        tx.send(Err(Status::internal(e.to_string()))).await.ok();
                        break;
                    }
                }
            }
            // tx drop → stream kết thúc ở client
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }
}
```

### 3.3 Client-side Streaming

```rust
use tonic::Streaming;

#[tonic::async_trait]
impl UserService for UserServiceImpl {
    // BULK CREATE — Client streaming
    async fn bulk_create_users(
        &self,
        request: Request<Streaming<CreateUserRequest>>,
    ) -> Result<Response<BulkCreateResponse>, Status> {
        let mut stream = request.into_inner();

        let mut created = 0i32;
        let mut failed = 0i32;
        let mut errors = Vec::new();
        let mut index = 0i32;

        // Batch để tối ưu DB write
        let mut batch: Vec<CreateUserRequest> = Vec::new();
        const BATCH_SIZE: usize = 100;

        loop {
            // Nhận message từ client
            match stream.message().await {
                Ok(Some(req)) => {
                    batch.push(req);

                    // Flush batch khi đủ kích thước
                    if batch.len() >= BATCH_SIZE {
                        let (ok, err) = flush_batch(&self.db, &batch, index).await;
                        created += ok as i32;
                        failed += err.len() as i32;
                        errors.extend(err);
                        index += batch.len() as i32;
                        batch.clear();
                    }
                }
                Ok(None) => {
                    // Stream kết thúc — flush remaining
                    if !batch.is_empty() {
                        let (ok, err) = flush_batch(&self.db, &batch, index).await;
                        created += ok as i32;
                        failed += err.len() as i32;
                        errors.extend(err);
                    }
                    break;
                }
                Err(e) => {
                    return Err(Status::aborted(format!("Stream error: {}", e)));
                }
            }
        }

        Ok(Response::new(BulkCreateResponse { created, failed, errors }))
    }
}

// Helper batch insert
async fn flush_batch(
    db: &sqlx::PgPool,
    batch: &[CreateUserRequest],
    start_index: i32,
) -> (usize, Vec<BulkError>) {
    let names: Vec<&str> = batch.iter().map(|r| r.name.as_str()).collect();
    let emails: Vec<&str> = batch.iter().map(|r| r.email.as_str()).collect();

    match sqlx::query!(
        "INSERT INTO users (name, email, role, created_at, updated_at)
         SELECT name, email, 'user', NOW(), NOW()
         FROM UNNEST($1::text[], $2::text[]) AS t(name, email)",
        &names[..], &emails[..]
    )
    .execute(db)
    .await {
        Ok(result) => (result.rows_affected() as usize, vec![]),
        Err(e) => (0, batch.iter().enumerate().map(|(i, _)| BulkError {
            index: start_index + i as i32,
            reason: e.to_string(),
        }).collect()),
    }
}
```

### 3.4 Bidirectional Streaming

```rust
#[tonic::async_trait]
impl UserService for UserServiceImpl {
    type SyncUsersStream = ReceiverStream<Result<SyncResponse, Status>>;

    // SYNC USERS — Bidirectional streaming
    async fn sync_users(
        &self,
        request: Request<Streaming<SyncRequest>>,
    ) -> Result<Response<Self::SyncUsersStream>, Status> {
        let mut in_stream = request.into_inner();
        let db = self.db.clone();

        let (tx, rx) = mpsc::channel(100);

        tokio::spawn(async move {
            let mut sequence = 0i64;

            while let Ok(Some(sync_req)) = in_stream.message().await {
                sequence += 1;

                let result = match sync_req.payload {
                    Some(sync_request::Payload::Create(req)) => {
                        sqlx::query!(
                            "INSERT INTO users (name, email, role, created_at, updated_at)
                             VALUES ($1, $2, $3, NOW(), NOW())",
                            req.name, req.email, req.role
                        )
                        .execute(&db)
                        .await
                        .map(|_| ())
                        .map_err(|e| e.to_string())
                    }
                    Some(sync_request::Payload::Update(req)) => {
                        sqlx::query!(
                            "UPDATE users SET name = $1, email = $2, updated_at = NOW() WHERE id = $3",
                            req.name, req.email, req.id
                        )
                        .execute(&db)
                        .await
                        .map(|_| ())
                        .map_err(|e| e.to_string())
                    }
                    Some(sync_request::Payload::Delete(req)) => {
                        sqlx::query!("DELETE FROM users WHERE id = $1", req.id)
                        .execute(&db)
                        .await
                        .map(|_| ())
                        .map_err(|e| e.to_string())
                    }
                    None => Err("Empty payload".to_string()),
                };

                let response = match result {
                    Ok(_) => SyncResponse { sequence, success: true, error: String::new() },
                    Err(e) => SyncResponse { sequence, success: false, error: e },
                };

                if tx.send(Ok(response)).await.is_err() {
                    break; // client disconnect
                }
            }
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }
}
```

---

## PHẦN 4 — Interceptors (Middleware)

### 4.1 Auth Interceptor

```rust
use tonic::{Request, Status};

// Simple interceptor — function
fn auth_interceptor(mut req: Request<()>) -> Result<Request<()>, Status> {
    // Lấy metadata (HTTP headers trong gRPC)
    let token = req.metadata()
        .get("authorization")
        .ok_or_else(|| Status::unauthenticated("Missing authorization header"))?
        .to_str()
        .map_err(|_| Status::unauthenticated("Invalid authorization header"))?;

    let token = token.strip_prefix("Bearer ")
        .ok_or_else(|| Status::unauthenticated("Invalid token format"))?;

    // Verify JWT
    let claims = verify_jwt(token)
        .map_err(|_| Status::unauthenticated("Invalid or expired token"))?;

    // Inject claims vào extensions
    req.extensions_mut().insert(claims);

    Ok(req)
}

// Apply interceptor khi build server
use user::v1::user_service_server::UserServiceServer;

Server::builder()
    .add_service(
        UserServiceServer::with_interceptor(service, auth_interceptor)
    )
    .serve(addr)
    .await?;
```

### 4.2 Logging Interceptor (Tower Layer)

```rust
use tower::layer::Layer;
use tower::Service;
use tonic::body::BoxBody;
use hyper::Body;
use std::time::Instant;

#[derive(Clone)]
pub struct LoggingLayer;

impl<S> Layer<S> for LoggingLayer {
    type Service = LoggingService<S>;

    fn layer(&self, service: S) -> Self::Service {
        LoggingService { inner: service }
    }
}

#[derive(Clone)]
pub struct LoggingService<S> {
    inner: S,
}

impl<S> Service<hyper::Request<Body>> for LoggingService<S>
where
    S: Service<hyper::Request<Body>, Response = hyper::Response<BoxBody>>
        + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = futures_util::future::BoxFuture<'static, Result<Self::Response, Self::Error>>;

    fn poll_ready(&mut self, cx: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: hyper::Request<Body>) -> Self::Future {
        let path = req.uri().path().to_string();
        let start = Instant::now();
        let mut inner = self.inner.clone();

        Box::pin(async move {
            tracing::info!(grpc.method = %path, "gRPC call started");
            let result = inner.call(req).await;
            let elapsed = start.elapsed().as_millis();
            match &result {
                Ok(res) => {
                    // gRPC status trong trailer
                    tracing::info!(
                        grpc.method = %path,
                        elapsed_ms = elapsed,
                        "gRPC call completed"
                    );
                }
                Err(_) => {
                    tracing::error!(grpc.method = %path, elapsed_ms = elapsed, "gRPC call failed");
                }
            }
            result
        })
    }
}

// Apply Tower layer
Server::builder()
    .layer(LoggingLayer)
    .add_service(UserServiceServer::new(service))
    .serve(addr)
    .await?;
```

---

## PHẦN 5 — Health Check & Reflection

### 5.1 gRPC Health Protocol

```rust
use tonic_health::server::health_reporter;

// Standard gRPC health protocol — grpcurl support
let (mut health_reporter, health_service) = health_reporter();

// Set service health status
health_reporter
    .set_serving::<UserServiceServer<UserServiceImpl>>()
    .await;

// Bạn có thể set không-healthy khi cần
// health_reporter.set_not_serving::<UserServiceServer<_>>().await;

Server::builder()
    .add_service(health_service)
    .add_service(UserServiceServer::new(service))
    .serve(addr)
    .await?;

// Test với grpc-health-probe hoặc grpcurl:
// grpcurl -plaintext localhost:50051 grpc.health.v1.Health/Check
```

### 5.2 gRPC Reflection — grpcurl Support

```rust
use tonic_reflection::server::Builder as ReflectionBuilder;

let reflection_service = ReflectionBuilder::configure()
    .register_encoded_file_descriptor_set(
        crate::proto::user::v1::FILE_DESCRIPTOR_SET
    )
    .build_v1()
    .unwrap();

Server::builder()
    .add_service(health_service)
    .add_service(reflection_service)
    .add_service(UserServiceServer::new(service))
    .serve(addr)
    .await?;

// Bây giờ grpcurl tự khám phá API:
// grpcurl -plaintext localhost:50051 list
// → user.v1.UserService
// grpcurl -plaintext localhost:50051 list user.v1.UserService
// → user.v1.UserService.GetUser
// grpcurl -plaintext -d '{"id":1}' localhost:50051 user.v1.UserService/GetUser
```

---

## PHẦN 6 — Client

### 6.1 Basic Client

```rust
use tonic::transport::Channel;
use crate::proto::user::v1::user_service_client::UserServiceClient;
use crate::proto::user::v1::*;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Connect
    let channel = Channel::from_static("http://[::1]:50051")
        .connect()
        .await?;

    let mut client = UserServiceClient::new(channel);

    // Unary call
    let response = client.get_user(GetUserRequest { id: 1 }).await?;
    println!("User: {:?}", response.into_inner());

    // Server streaming
    let mut stream = client
        .list_users(ListUsersRequest {
            page_size: 10,
            page_token: String::new(),
            filter: "status=active".to_string(),
            order_by: "created_at desc".to_string(),
        })
        .await?
        .into_inner();

    println!("Users:");
    while let Some(user) = stream.message().await? {
        println!("  - {} ({})", user.name, user.email);
    }

    // Bidirectional streaming
    let (tx, rx) = tokio::sync::mpsc::channel(10);
    let request_stream = tokio_stream::wrappers::ReceiverStream::new(rx);

    let mut bidi = client.sync_users(request_stream).await?.into_inner();

    // Send requests
    tx.send(SyncRequest {
        payload: Some(sync_request::Payload::Create(CreateUserRequest {
            name: "Bach".into(),
            email: "bach@vpbank.com".into(),
            role: "admin".into(),
        }))
    }).await?;

    drop(tx); // close stream

    // Receive responses
    while let Some(resp) = bidi.message().await? {
        println!("Sync #{}: success={}", resp.sequence, resp.success);
    }

    Ok(())
}
```

### 6.2 Client với Auth Metadata

```rust
use tonic::metadata::MetadataValue;
use tonic::Request;

// Add auth header
let mut request = Request::new(GetUserRequest { id: 1 });
request.metadata_mut().insert(
    "authorization",
    MetadataValue::try_from(format!("Bearer {}", jwt_token)).unwrap(),
);
let response = client.get_user(request).await?;

// Hoặc dùng interceptor ở client side
let channel = Channel::from_static("http://[::1]:50051").connect().await?;
let token = "my-jwt-token";

let mut client = UserServiceClient::with_interceptor(channel, move |mut req: Request<()>| {
    req.metadata_mut().insert(
        "authorization",
        MetadataValue::try_from(format!("Bearer {}", token)).unwrap(),
    );
    Ok(req)
});
```

### 6.3 Connection Pool & Retry

```rust
use tonic::transport::{Channel, Endpoint};
use tower::ServiceBuilder;
use std::time::Duration;

// Channel với timeout và retry
let channel = Endpoint::from_static("http://[::1]:50051")
    .timeout(Duration::from_secs(5))
    .keep_alive_timeout(Duration::from_secs(20))
    .keep_alive_while_idle(true)
    .connect_timeout(Duration::from_secs(5))
    .connect()
    .await?;

// Load balancing across multiple endpoints
let channel = Channel::balance_list(vec![
    Endpoint::from_static("http://node1:50051"),
    Endpoint::from_static("http://node2:50051"),
    Endpoint::from_static("http://node3:50051"),
].into_iter());
```

---

## PHẦN 7 — Full Server Assembly

```rust
// src/main.rs
use tonic::transport::Server;
use tower::ServiceBuilder;

mod interceptors;
mod proto;
mod services;

use proto::user::v1::user_service_server::UserServiceServer;
use services::user_service::UserServiceImpl;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter("tonic=debug,grpc_service=debug")
        .init();

    let addr = "[::1]:50051".parse()?;

    let db = sqlx::PgPool::connect(&std::env::var("DATABASE_URL")?).await?;
    sqlx::migrate!().run(&db).await?;

    let user_service = UserServiceImpl { db: db.clone() };

    // Health check
    let (mut health_reporter, health_service) = tonic_health::server::health_reporter();
    health_reporter.set_serving::<UserServiceServer<UserServiceImpl>>().await;

    // Reflection
    let reflection_service = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(proto::user::v1::FILE_DESCRIPTOR_SET)
        .build_v1()?;

    tracing::info!("gRPC server listening on {}", addr);

    Server::builder()
        // Tower middleware layers
        .layer(
            ServiceBuilder::new()
                .layer(interceptors::logging::LoggingLayer)
                .into_inner()
        )
        // Services
        .add_service(health_service)
        .add_service(reflection_service)
        .add_service(
            UserServiceServer::with_interceptor(user_service, interceptors::auth::auth_interceptor)
        )
        .serve_with_shutdown(addr, shutdown_signal())
        .await?;

    Ok(())
}

// Graceful shutdown
async fn shutdown_signal() {
    tokio::signal::ctrl_c().await.expect("Failed to install CTRL+C handler");
    tracing::info!("Shutting down gRPC server...");
}
```

---

## PHẦN 8 — gRPC + Axum (Hybrid Server)

```rust
// Serve cả gRPC và HTTP/REST trên cùng port (HTTP/2)
use axum::Router;
use tonic::transport::Server;

// Axum REST router
let rest_app = Router::new()
    .route("/health", axum::routing::get(|| async { "OK" }))
    .route("/metrics", axum::routing::get(metrics_handler));

// gRPC service
let grpc = UserServiceServer::new(user_service);

// Combine: route theo Content-Type header
// application/grpc → gRPC handler
// everything else → Axum
let hybrid = tonic_web::enable(grpc);  // tonic-web cho browser gRPC

// Hoặc dùng axum::Router::merge với tonic routes (experimental)
// Chi tiết: https://github.com/tokio-rs/axum/tree/main/examples/tonic-greeting
```

---

## 🎯 Java Spring gRPC vs Tonic

| Concept | Java (gRPC-Java + Spring) | Tonic (Rust) |
|---|---|---|
| Proto compile | protoc plugin | `tonic-build` in build.rs |
| Service impl | `extends XxxGrpc.XxxImplBase` | `impl XxxService for MyStruct` |
| Unary | `@Override void getUser(req, obs)` | `async fn get_user(req) -> Result<Response, Status>` |
| Server stream | `observer.onNext(item); onCompleted()` | `ReceiverStream<Result<T, Status>>` |
| Client stream | `StreamObserver<Request>` return | `Streaming<T>` param |
| Interceptor | `ServerInterceptor` interface | Function or Tower Layer |
| Health | `HealthStatusManager` | `tonic_health::server::health_reporter()` |
| Reflection | `ProtoReflectionService` | `tonic_reflection::server::Builder` |
| Metadata | `Metadata` class | `request.metadata()` |
| Error | `Status.NOT_FOUND.withDescription()` | `Status::not_found("message")` |

---

## 🏋️ Bài Tập

1. **Document Service**: Implement gRPC service cho PDMS:
   - `GetDocument(id)` → Unary
   - `ListDocuments(filter, page_size)` → Server streaming  
   - `UploadDocumentChunks(stream bytes)` → Client streaming
   - Kết nối SQLx với `sqlx::test` isolation

2. **Auth Interceptor**: Implement interceptor verify JWT, extract `user_id` + `role`, inject vào extensions. Handler lấy ra và log.

3. **Sync Pipeline**: Implement bidirectional streaming cho data sync giữa 2 services. Client gửi events, server xử lý và confirm từng event.

4. **grpcurl Test**: Dùng reflection để test API với grpcurl. Test tất cả 4 streaming modes.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-25-ActixWeb|Bài 25: ActixWeb]] — prerequisite
- [[Rust-Zero-To-Hero/Bai-26-SQLx-Advanced|Bài 26: SQLx Advanced]] → tiếp theo
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9: Tokio]] — Streaming patterns
