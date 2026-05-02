# Bài 24: Axum Advanced — WebSocket · SSE · File Upload · OpenAPI

> **Prerequisite:** Bài 10 (Axum Core) + Bài 11 (Middleware & Error)  
> **Mục tiêu:** Nắm full feature set của Axum cho production — real-time, streaming, file handling, tự động docs

---

## 🗺️ Bức Tranh Tổng Quan

```
┌─────────────────────────────────────────────────────────────────┐
│                     AXUM ADVANCED FEATURES                      │
├──────────────┬──────────────┬──────────────┬────────────────────┤
│  WebSocket   │     SSE      │ File Upload  │     OpenAPI        │
│              │              │              │                    │
│ Full-duplex  │ Server→Client│ Multipart    │ Auto-gen Swagger   │
│ ws:// proto  │ text/event-  │ stream       │ utoipa derive      │
│ chat, notif  │ stream       │ S3/disk save │ UI at /swagger-ui  │
└──────────────┴──────────────┴──────────────┴────────────────────┘

HTTP Upgrade Flow (WebSocket):
  Client                    Server
    │  GET /ws               │
    │  Upgrade: websocket ──▶│
    │                        │ 101 Switching Protocols
    │◀─────────────────────── │
    │◀═══ ws frame ══════════▶│  (full-duplex từ đây)
```

---

## PHẦN 1 — WebSocket

### 1.1 Tại sao WebSocket?

```
HTTP (Request-Response):          WebSocket (Full-duplex):
  Client ──req──▶ Server            Client ◀══ws══▶ Server
  Client ◀──res── Server            (1 connection, 2 chiều)
  (cần poll liên tục)               (server push được)

Use cases trong PDMS:
  - Notification khi document được approve
  - Real-time status update khi batch import
  - Live dashboard metrics
  - Chat support

Java analog: Spring WebSocket + STOMP / Jakarta WebSocket @ServerEndpoint
```

### 1.2 Dependencies

```toml
[dependencies]
axum = { version = "0.7", features = ["ws"] }
tokio = { version = "1", features = ["full"] }
tower-http = { version = "0.5", features = ["cors"] }
# WebSocket utilities
futures-util = "0.3"
```

### 1.3 Basic Echo Server

```rust
use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::IntoResponse,
    routing::get,
    Router,
};

// 1. Handler nhận upgrade request
async fn ws_handler(
    ws: WebSocketUpgrade,         // magic extractor — detect Upgrade header
    State(state): State<AppState>,
) -> impl IntoResponse {
    // on_upgrade: sau khi handshake xong, gọi closure này
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

// 2. Actual WebSocket logic
async fn handle_socket(mut socket: WebSocket, state: AppState) {
    // Vòng lặp message
    while let Some(msg) = socket.recv().await {
        match msg {
            Ok(Message::Text(text)) => {
                println!("Received: {}", text);
                // Echo lại
                if socket.send(Message::Text(format!("Echo: {text}"))).await.is_err() {
                    break; // client disconnect
                }
            }
            Ok(Message::Binary(bin)) => {
                socket.send(Message::Binary(bin)).await.ok();
            }
            Ok(Message::Ping(data)) => {
                // Axum tự handle Ping/Pong, nhưng bạn có thể custom
                socket.send(Message::Pong(data)).await.ok();
            }
            Ok(Message::Close(reason)) => {
                println!("Client closed: {:?}", reason);
                break;
            }
            Err(e) => {
                println!("WebSocket error: {}", e);
                break;
            }
            _ => {}
        }
    }
    println!("WebSocket connection closed");
}

fn main_router(state: AppState) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state)
}
```

### 1.4 Broadcast Chat Room — Production Pattern

```
Architecture:
  ┌─────────┐     ┌──────────────────────────────────────┐
  │Client A │◀════╪══ broadcast::Sender<ChatMessage> ════╪══▶│Client B │
  │Client C │◀════╪══════════════════════════════════════╪══▶│Client D │
  └─────────┘     │         Arc<ChatRoom>                │   └─────────┘
                  └──────────────────────────────────────┘
                  Mỗi connection subscribe 1 receiver
```

```rust
use tokio::sync::broadcast;
use std::sync::Arc;

#[derive(Clone, Debug)]
struct ChatMessage {
    user: String,
    content: String,
    timestamp: i64,
}

// AppState chứa broadcast channel
#[derive(Clone)]
struct AppState {
    // broadcast::Sender: clone được, gửi cho tất cả subscriber
    chat_tx: Arc<broadcast::Sender<String>>,
    user_count: Arc<std::sync::atomic::AtomicUsize>,
}

impl AppState {
    fn new() -> Self {
        let (tx, _) = broadcast::channel(1000); // buffer 1000 messages
        AppState {
            chat_tx: Arc::new(tx),
            user_count: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }
}

async fn chat_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_chat_socket(socket, state))
}

async fn handle_chat_socket(socket: WebSocket, state: AppState) {
    use futures_util::{sink::SinkExt, stream::StreamExt};

    // Track user count
    let count = state.user_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    println!("User joined. Total: {}", count);

    // Subscribe TRƯỚC khi split socket
    let mut rx = state.chat_tx.subscribe();

    // split socket thành sender + receiver — dùng 2 tasks
    let (mut sender, mut receiver) = socket.split();

    // Task 1: Nhận từ broadcast, gửi xuống client
    let mut send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg)).await.is_err() {
                break; // client disconnect
            }
        }
    });

    // Task 2: Nhận từ client, broadcast cho tất cả
    let tx = state.chat_tx.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(Message::Text(text))) = receiver.next().await {
            // Broadcast cho tất cả — ignore error nếu không có ai subscribe
            tx.send(text).ok();
        }
    });

    // Đợi một trong hai task kết thúc (client disconnect)
    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }

    // Cleanup
    let count = state.user_count.fetch_sub(1, std::sync::atomic::Ordering::SeqCst) - 1;
    println!("User left. Total: {}", count);
}
```

### 1.5 Auth trong WebSocket

```rust
// WebSocket không support Authorization header sau upgrade
// → Pass token qua query param hoặc protocol header

async fn ws_auth_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<WsParams>,  // ?token=xxx
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    // Verify TRƯỚC khi upgrade
    let user_id = verify_jwt(&params.token)
        .map_err(|_| AppError::Unauthorized)?;

    Ok(ws.on_upgrade(move |socket| handle_authed_socket(socket, user_id, state)))
}

#[derive(Deserialize)]
struct WsParams {
    token: String,
}
```

---

## PHẦN 2 — Server-Sent Events (SSE)

### 2.1 SSE vs WebSocket

```
SSE (Server-Sent Events):         WebSocket:
  Server ──────────▶ Client         Server ◀═══════▶ Client
  HTTP/1.1 compatible               Requires upgrade
  Auto-reconnect built-in           Manual reconnect
  Text only                         Text + Binary
  
Use cases SSE trong PDMS:
  - Progress bar import 10M records
  - Notification feed (read-only)
  - Live log streaming
  - Dashboard metrics auto-refresh

Java analog: SseEmitter / @GetMapping(produces = MediaType.TEXT_EVENT_STREAM_VALUE)
```

### 2.2 Basic SSE Endpoint

```rust
use axum::response::sse::{Event, KeepAlive, Sse};
use std::convert::Infallible;
use tokio_stream::{wrappers::IntervalStream, StreamExt};
use std::time::Duration;

// SSE endpoint — trả về stream of Events
async fn sse_handler() -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    // Tạo stream emit event mỗi giây
    let stream = IntervalStream::new(tokio::time::interval(Duration::from_secs(1)))
        .map(|_| {
            let timestamp = chrono::Utc::now().timestamp();
            Ok(Event::default()
                .event("tick")                          // event type
                .data(format!("{{\"ts\":{}}}", timestamp))  // data payload
                .id(timestamp.to_string()))             // event ID (auto-reconnect resume)
        });

    Sse::new(stream)
        .keep_alive(KeepAlive::default()) // gửi comment mỗi 15s để giữ connection
}
```

### 2.3 SSE với Broadcast Channel — Notification System

```rust
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "type", content = "data")]
enum AppEvent {
    DocumentApproved { doc_id: i64, title: String },
    ImportProgress { job_id: String, processed: u64, total: u64 },
    SystemAlert { message: String, level: String },
}

#[derive(Clone)]
struct AppState {
    event_tx: Arc<broadcast::Sender<AppEvent>>,
}

// SSE endpoint subscribe vào event channel
async fn notifications_sse(
    State(state): State<AppState>,
    // Optional: filter theo user
    Extension(user_id): Extension<UserId>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, axum::BoxError>>> {
    let rx = state.event_tx.subscribe();

    let stream = BroadcastStream::new(rx)
        .filter_map(|result| {
            match result {
                Ok(event) => {
                    // Serialize event thành JSON
                    let data = serde_json::to_string(&event).unwrap_or_default();
                    let event_type = match &event {
                        AppEvent::DocumentApproved { .. } => "document",
                        AppEvent::ImportProgress { .. } => "import",
                        AppEvent::SystemAlert { .. } => "alert",
                    };
                    Some(Ok(Event::default().event(event_type).data(data)))
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    // Client quá chậm, bỏ qua n messages
                    println!("SSE client lagged {} messages", n);
                    None
                }
                Err(_) => None, // channel closed
            }
        });

    Sse::new(stream).keep_alive(KeepAlive::default())
}

// Gửi event từ bất kỳ đâu trong app
async fn approve_document(
    State(state): State<AppState>,
    Path(doc_id): Path<i64>,
) -> impl IntoResponse {
    // Business logic...

    // Publish event → tất cả SSE clients nhận được
    state.event_tx.send(AppEvent::DocumentApproved {
        doc_id,
        title: "Contract Q4 2024".to_string(),
    }).ok(); // ok() vì có thể không có subscriber nào

    StatusCode::OK
}
```

### 2.4 SSE Progress Bar — PDMS Import Pattern

```rust
// POST /import → trả về job_id
// GET /import/{job_id}/progress → SSE stream

use std::collections::HashMap;
use tokio::sync::Mutex;

#[derive(Clone, Debug, serde::Serialize)]
struct ImportProgress {
    job_id: String,
    processed: u64,
    total: u64,
    status: String, // "running" | "completed" | "failed"
    error: Option<String>,
}

type ProgressMap = Arc<Mutex<HashMap<String, watch::Sender<ImportProgress>>>>;

async fn start_import(
    State(progress_map): State<ProgressMap>,
    Json(request): Json<ImportRequest>,
) -> Json<serde_json::Value> {
    let job_id = uuid::Uuid::new_v4().to_string();

    let initial = ImportProgress {
        job_id: job_id.clone(),
        processed: 0,
        total: request.record_count,
        status: "running".to_string(),
        error: None,
    };

    let (tx, _) = watch::channel(initial);
    progress_map.lock().await.insert(job_id.clone(), tx.clone());

    // Spawn background job
    tokio::spawn(async move {
        for i in 1..=request.record_count {
            tokio::time::sleep(Duration::from_millis(10)).await; // simulate work
            tx.send(ImportProgress {
                job_id: job_id.clone(),
                processed: i,
                total: request.record_count,
                status: if i == request.record_count { "completed" } else { "running" }.to_string(),
                error: None,
            }).ok();
        }
    });

    Json(serde_json::json!({ "job_id": job_id.clone() }))
}

async fn import_progress_sse(
    State(progress_map): State<ProgressMap>,
    Path(job_id): Path<String>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, AppError> {
    let map = progress_map.lock().await;
    let tx = map.get(&job_id).ok_or(AppError::NotFound)?;
    let mut rx = tx.subscribe();

    let stream = async_stream::stream! {
        loop {
            let progress = rx.borrow_and_update().clone();
            let data = serde_json::to_string(&progress).unwrap();
            yield Ok(Event::default().event("progress").data(data));

            if progress.status != "running" { break; }
            rx.changed().await.ok(); // wait for next update
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}
```

---

## PHẦN 3 — File Upload (Multipart)

### 3.1 Architecture

```
Client                          Axum Server
  │                                │
  │  POST /upload                  │
  │  Content-Type: multipart/form  │
  │  ─────────────────────────────▶│
  │  [--boundary]                  │  axum::extract::Multipart
  │  Content-Disposition: file     │  → iterate fields
  │  [file bytes streaming]        │  → read bytes
  │  [--boundary]                  │  → save to disk/S3
  │  metadata fields               │
  │  [--boundary--]                │
  │◀─────────────────────────────── │
  │  { "file_id": "..." }          │
```

### 3.2 Dependencies

```toml
[dependencies]
axum = { version = "0.7", features = ["multipart"] }
tokio = { version = "1", features = ["full", "io-util"] }
uuid = { version = "1", features = ["v4"] }
tokio-util = { version = "0.7", features = ["io"] }
```

### 3.3 Basic File Upload

```rust
use axum::extract::Multipart;
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

// Upload config
const MAX_FILE_SIZE: usize = 50 * 1024 * 1024; // 50MB
const ALLOWED_TYPES: &[&str] = &["application/pdf", "image/jpeg", "image/png", "application/msword"];

#[derive(serde::Serialize)]
struct UploadResponse {
    file_id: String,
    filename: String,
    content_type: String,
    size: usize,
    url: String,
}

async fn upload_handler(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Vec<UploadResponse>>, AppError> {
    let mut results = Vec::new();

    // Iterate qua từng field trong multipart
    while let Some(field) = multipart.next_field().await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        let field_name = field.name().unwrap_or("unknown").to_string();
        let filename = field.file_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("upload_{}", uuid::Uuid::new_v4()));
        let content_type = field.content_type()
            .map(|s| s.to_string())
            .unwrap_or("application/octet-stream".to_string());

        // Validate content type
        if !ALLOWED_TYPES.contains(&content_type.as_str()) {
            return Err(AppError::BadRequest(format!(
                "File type '{}' not allowed", content_type
            )));
        }

        // Stream bytes ra — KHÔNG load hết vào RAM
        let bytes = field.bytes().await
            .map_err(|e| AppError::BadRequest(e.to_string()))?;

        // Validate size
        if bytes.len() > MAX_FILE_SIZE {
            return Err(AppError::BadRequest(format!(
                "File too large: {} bytes (max {})", bytes.len(), MAX_FILE_SIZE
            )));
        }

        // Generate unique file ID
        let file_id = uuid::Uuid::new_v4().to_string();
        let safe_filename = sanitize_filename(&filename);
        let stored_path = format!("uploads/{}/{}", file_id, safe_filename);

        // Lưu xuống disk (hoặc S3 — xem phần 3.4)
        save_to_disk(&stored_path, &bytes).await?;

        results.push(UploadResponse {
            file_id: file_id.clone(),
            filename: safe_filename.clone(),
            content_type,
            size: bytes.len(),
            url: format!("/files/{}/{}", file_id, safe_filename),
        });
    }

    Ok(Json(results))
}

async fn save_to_disk(path: &str, bytes: &[u8]) -> Result<(), AppError> {
    let full_path = PathBuf::from("storage").join(path);

    // Tạo thư mục nếu chưa có
    if let Some(parent) = full_path.parent() {
        tokio::fs::create_dir_all(parent).await
            .map_err(|e| AppError::Internal(e.to_string()))?;
    }

    // Write file async
    let mut file = tokio::fs::File::create(&full_path).await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    file.write_all(bytes).await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    file.flush().await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(())
}

fn sanitize_filename(name: &str) -> String {
    // Remove path traversal, special chars
    name.chars()
        .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect::<String>()
        .trim_start_matches('.')
        .to_string()
}
```

### 3.4 Streaming Upload (Large Files)

```rust
// Tránh load file to vào RAM — dùng streaming
use tokio::io::AsyncWriteExt;
use futures_util::StreamExt;

async fn streaming_upload(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<UploadResponse>, AppError> {
    while let Some(mut field) = multipart.next_field().await? {
        let filename = field.file_name()
            .map(|s| s.to_string())
            .unwrap_or("upload".to_string());

        let file_id = uuid::Uuid::new_v4().to_string();
        let path = format!("storage/uploads/{}/{}", file_id, sanitize_filename(&filename));

        tokio::fs::create_dir_all(
            std::path::Path::new(&path).parent().unwrap()
        ).await?;

        let mut file = tokio::fs::File::create(&path).await?;
        let mut total_bytes = 0usize;

        // Stream chunks — không buffer toàn bộ file
        while let Some(chunk) = field.chunk().await? {
            total_bytes += chunk.len();

            if total_bytes > MAX_FILE_SIZE {
                // Xóa file partial, trả lỗi
                tokio::fs::remove_file(&path).await.ok();
                return Err(AppError::BadRequest("File too large".to_string()));
            }

            file.write_all(&chunk).await?;
        }

        file.flush().await?;

        return Ok(Json(UploadResponse {
            file_id,
            filename,
            content_type: "application/octet-stream".to_string(),
            size: total_bytes,
            url: path,
        }));
    }

    Err(AppError::BadRequest("No file in request".to_string()))
}
```

### 3.5 Upload + Metadata trong Cùng Request

```rust
// HTML form:
// <input type="file" name="file">
// <input type="text" name="title">
// <input type="text" name="document_type">

#[derive(Default)]
struct UploadForm {
    title: Option<String>,
    document_type: Option<String>,
    file_bytes: Option<bytes::Bytes>,
    filename: Option<String>,
}

async fn upload_with_metadata(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut form = UploadForm::default();

    while let Some(field) = multipart.next_field().await? {
        match field.name().unwrap_or("") {
            "title" => {
                form.title = Some(field.text().await?);
            }
            "document_type" => {
                form.document_type = Some(field.text().await?);
            }
            "file" => {
                form.filename = field.file_name().map(|s| s.to_string());
                form.file_bytes = Some(field.bytes().await?);
            }
            other => {
                println!("Unknown field: {}", other);
            }
        }
    }

    let bytes = form.file_bytes.ok_or(AppError::BadRequest("Missing file".to_string()))?;
    let filename = form.filename.unwrap_or("unknown".to_string());

    // Save + persist metadata to DB
    let file_id = uuid::Uuid::new_v4().to_string();
    save_to_disk(&format!("uploads/{}/{}", file_id, filename), &bytes).await?;

    // Insert DB record
    sqlx::query!(
        "INSERT INTO documents (file_id, title, document_type, filename, size)
         VALUES ($1, $2, $3, $4, $5)",
        file_id, form.title, form.document_type, filename, bytes.len() as i64
    )
    .execute(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "file_id": file_id,
        "title": form.title,
        "message": "Upload successful"
    })))
}
```

---

## PHẦN 4 — OpenAPI với utoipa

### 4.1 Tại sao utoipa?

```
Swagger annotation trong Java:
  @Operation(summary = "Get user by ID")
  @ApiResponse(responseCode = "200", content = @Content(schema = @Schema(impl = User.class)))
  @GetMapping("/users/{id}")
  public ResponseEntity<User> getUser(@PathVariable Long id) { ... }

utoipa trong Rust:
  #[utoipa::path(
      get, path = "/users/{id}",
      responses((status = 200, body = User))
  )]
  async fn get_user(Path(id): Path<i64>) -> Json<User> { ... }

→ Tự generate OpenAPI 3.0 JSON spec
→ Serve Swagger UI tại /swagger-ui
```

### 4.2 Dependencies

```toml
[dependencies]
utoipa = { version = "4", features = ["axum_extras"] }
utoipa-swagger-ui = { version = "7", features = ["axum"] }
```

### 4.3 Annotate Models

```rust
use utoipa::ToSchema;

#[derive(serde::Serialize, serde::Deserialize, ToSchema)]
pub struct UserResponse {
    /// User's unique identifier
    pub id: i64,
    /// Full name
    pub name: String,
    /// Email address
    pub email: String,
    /// Account status
    #[schema(example = "active")]
    pub status: String,
    /// Creation timestamp (ISO 8601)
    pub created_at: String,
}

#[derive(serde::Serialize, serde::Deserialize, ToSchema)]
pub struct CreateUserDto {
    /// Full name (2-100 chars)
    #[schema(example = "Nguyen Van Bach")]
    pub name: String,
    /// Valid email address
    #[schema(example = "bach@vpbank.com.vn")]
    pub email: String,
}

#[derive(serde::Serialize, ToSchema)]
pub struct ErrorResponse {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct PaginationParams {
    /// Page number (default: 1)
    #[param(example = 1, minimum = 1)]
    pub page: Option<u32>,
    /// Items per page (default: 20, max: 100)
    #[param(example = 20, minimum = 1, maximum = 100)]
    pub size: Option<u32>,
}
```

### 4.4 Annotate Handlers

```rust
use utoipa::OpenApi;

/// Get user by ID
///
/// Returns complete user profile including account status.
#[utoipa::path(
    get,
    path = "/api/v1/users/{id}",
    tag = "Users",
    params(
        ("id" = i64, Path, description = "User ID", example = 42)
    ),
    responses(
        (status = 200, description = "User found", body = UserResponse),
        (status = 404, description = "User not found", body = ErrorResponse),
        (status = 401, description = "Unauthorized", body = ErrorResponse),
    ),
    security(("bearer_auth" = []))
)]
async fn get_user(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<UserResponse>, AppError> {
    // ...
}

/// List users with pagination
#[utoipa::path(
    get,
    path = "/api/v1/users",
    tag = "Users",
    params(PaginationParams),
    responses(
        (status = 200, description = "User list", body = Vec<UserResponse>),
    ),
    security(("bearer_auth" = []))
)]
async fn list_users(
    State(state): State<AppState>,
    Query(params): Query<PaginationParams>,
) -> Json<Vec<UserResponse>> {
    // ...
}

/// Create new user
#[utoipa::path(
    post,
    path = "/api/v1/users",
    tag = "Users",
    request_body = CreateUserDto,
    responses(
        (status = 201, description = "User created", body = UserResponse),
        (status = 400, description = "Validation error", body = ErrorResponse),
        (status = 409, description = "Email already exists", body = ErrorResponse),
    ),
    security(("bearer_auth" = []))
)]
async fn create_user(
    State(state): State<AppState>,
    Json(dto): Json<CreateUserDto>,
) -> Result<(StatusCode, Json<UserResponse>), AppError> {
    // ...
}
```

### 4.5 OpenAPI Spec + Swagger UI Setup

```rust
use utoipa::{openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme}, Modify, OpenApi};
use utoipa_swagger_ui::SwaggerUi;

// Define security scheme
struct BearerAuth;
impl Modify for BearerAuth {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_default();
        components.add_security_scheme(
            "bearer_auth",
            SecurityScheme::Http(
                HttpBuilder::new()
                    .scheme(HttpAuthScheme::Bearer)
                    .bearer_format("JWT")
                    .build()
            ),
        );
    }
}

// Aggregate tất cả paths + schemas
#[derive(OpenApi)]
#[openapi(
    paths(
        get_user,
        list_users,
        create_user,
        update_user,
        delete_user,
    ),
    components(
        schemas(UserResponse, CreateUserDto, ErrorResponse, PaginationParams),
    ),
    modifiers(&BearerAuth),
    tags(
        (name = "Users", description = "User management endpoints"),
        (name = "Documents", description = "PDMS document endpoints"),
    ),
    info(
        title = "PDMS API",
        version = "1.0.0",
        description = "Physical Document Management System API",
        contact(name = "Bach", email = "bach@vpbank.com.vn"),
    )
)]
struct ApiDoc;

// Mount vào router
pub fn build_router(state: AppState) -> Router {
    Router::new()
        // Swagger UI
        .merge(SwaggerUi::new("/swagger-ui")
            .url("/api-docs/openapi.json", ApiDoc::openapi()))
        // Nếu muốn: RapiDoc, Redoc
        // .merge(Redoc::with_url("/redoc", ApiDoc::openapi()))
        // API routes
        .nest("/api/v1", api_routes(state))
}
```

### 4.6 Full App Assembly

```rust
#[tokio::main]
async fn main() {
    // Tracing setup
    tracing_subscriber::fmt()
        .with_env_filter("axum_advanced=debug,tower_http=debug")
        .init();

    let pool = PgPoolOptions::new()
        .max_connections(20)
        .connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .expect("Failed to connect to DB");

    let (event_tx, _) = broadcast::channel(10000);

    let state = AppState {
        db: pool,
        event_tx: Arc::new(event_tx),
        progress_map: Arc::new(Mutex::new(HashMap::new())),
    };

    let app = Router::new()
        // OpenAPI UI
        .merge(SwaggerUi::new("/swagger-ui")
            .url("/api-docs/openapi.json", ApiDoc::openapi()))
        // REST API
        .nest("/api/v1", api_routes(state.clone()))
        // Real-time
        .route("/ws/chat", get(chat_ws_handler))
        .route("/sse/notifications", get(notifications_sse))
        .route("/sse/import/:job_id/progress", get(import_progress_sse))
        // File upload
        .route("/upload", post(streaming_upload))
        .with_state(state)
        // Tower middleware
        .layer(
            tower_http::ServiceBuilder::new()
                .layer(tower_http::trace::TraceLayer::new_for_http())
                .layer(tower_http::cors::CorsLayer::permissive())
                .layer(tower_http::limit::RequestBodyLimitLayer::new(100 * 1024 * 1024)),
        );

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    tracing::info!("Listening on http://0.0.0.0:3000");
    tracing::info!("Swagger UI: http://0.0.0.0:3000/swagger-ui");
    axum::serve(listener, app).await.unwrap();
}
```

---

## 🎯 So Sánh Với Java Spring

| Feature | Spring Boot | Axum |
|---|---|---|
| WebSocket | `@EnableWebSocket` + `WebSocketHandler` | `WebSocketUpgrade` extractor |
| SSE | `SseEmitter` / `Flux<ServerSentEvent>` | `Sse<Stream<Event>>` |
| File Upload | `@RequestParam MultipartFile` | `Multipart` extractor |
| OpenAPI | `springdoc-openapi` + Swagger annotations | `utoipa` + `#[utoipa::path]` |
| Streaming large file | `MultipartFile.getInputStream()` | `field.chunk().await` |

---

## 🏋️ Bài Tập

1. **Chat Room**: Implement phòng chat có tên — `/ws/chat?room=general`. Mỗi room có broadcast channel riêng. Lưu 50 messages gần nhất, gửi cho user mới join.

2. **Import Progress**: Implement SSE progress bar cho batch import. POST `/import` → trả `job_id`. GET `/import/{job_id}/progress` → SSE stream với `processed/total`. Hoàn thành sau 5 giây.

3. **Document Upload**: Upload form có `file` + `title` + `category`. Validate: PDF only, max 20MB. Lưu metadata vào in-memory store. Endpoint GET `/documents` liệt kê tất cả.

4. **OpenAPI**: Annotate đầy đủ CRUD API cho `Document` model (id, title, category, filename, size, uploaded_at). Generate Swagger UI với auth bearer scheme.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-10-Axum-Core|Bài 10: Axum Core]] — prerequisite
- [[Rust-Zero-To-Hero/Bai-11-Axum-Middleware-Error|Bài 11: Middleware & Error]]
- [[Rust-Zero-To-Hero/Bai-25-ActixWeb|Bài 25: ActixWeb]] → tiếp theo
