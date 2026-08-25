---
type: course
domain: languages/rust
status: active
created: 2026-08-25
updated: 2026-08-25
tags: []
---

# Bài 58 (Dự án 2): Axum + PostgreSQL Full-Stack Service — Capstone Stage 4 (Production Backend)

Đây là dự án lắp ráp — không giới thiệu khái niệm mới, mà **kết nối 8 bài đã học riêng lẻ** (10, 11, 12, 26, 30, 15, 34, 35) thành một service hoàn chỉnh chạy được thật, đúng như một service PDMS module thực tế cần có. Nếu Bài 10-35 là các phụ tùng, đây là bài lắp ráp thành cả cỗ máy.

## Mục tiêu

Service quản lý "Document Metadata" tối giản (đủ để soi toàn bộ kỹ thuật, không cần domain phức tạp):

```
POST   /documents          - tạo document (có validation)
GET    /documents/:id      - lấy document theo id
GET    /health             - health check (cho k8s liveness/readiness)
GET    /metrics            - Prometheus metrics (liên hệ Bài 34)
```

## 1. Migration — Schema có kiểm soát version (Bài 12/26)

```bash
cargo install sqlx-cli
sqlx migrate add create_documents_table
```

```sql
-- migrations/20260825_create_documents_table.up.sql
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```rust
// Chạy migration tự động khi service start — quan trọng cho CI/CD, không cần bước thủ công
sqlx::migrate!("./migrations").run(&pool).await?;
```

**Nguyên tắc:** migration luôn có cặp `up`/`down`, không sửa migration đã merge — chỉ thêm migration mới (giống Flyway/Liquibase convention bạn đã quen ở Java).

## 2. Connection Pool có cấu hình đúng (Bài 12)

```rust
use sqlx::postgres::PgPoolOptions;

let pool = PgPoolOptions::new()
    .max_connections(20)                 // tương ứng HikariCP maximumPoolSize
    .min_connections(2)
    .acquire_timeout(Duration::from_secs(3)) // fail nhanh thay vì treo connection request
    .idle_timeout(Duration::from_secs(600))
    .connect(&database_url)
    .await?;
```

## 3. Request Validation (Bài 30)

```rust
use validator::Validate;
use serde::Deserialize;

#[derive(Deserialize, Validate)]
struct CreateDocumentRequest {
    #[validate(length(min = 1, max = 200))]
    title: String,
}

async fn create_document(
    State(pool): State<PgPool>,
    Json(payload): Json<CreateDocumentRequest>,
) -> Result<Json<DocumentResponse>, AppError> {
    payload.validate().map_err(AppError::Validation)?; // reject sớm trước khi chạm DB
    // ...
}
```

## 4. Error Design nhất quán toàn service (Bài 8, 3c)

```rust
use axum::{response::{IntoResponse, Response}, http::StatusCode, Json};

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("dữ liệu không hợp lệ: {0}")]
    Validation(#[from] validator::ValidationErrors),
    #[error("không tìm thấy document")]
    NotFound,
    #[error("lỗi database: {0}")]
    Database(#[from] sqlx::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            AppError::Validation(_) => StatusCode::BAD_REQUEST,
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(serde_json::json!({ "error": self.to_string() }))).into_response()
    }
}
```

Mọi handler trả `Result<T, AppError>` — Axum tự gọi `IntoResponse` cho nhánh lỗi, không cần match tay ở từng handler.

## 5. Timeout & Graceful Shutdown (Bài 9b/9c, 22, 35)

```rust
use tower_http::timeout::TimeoutLayer;
use std::time::Duration;

let app = Router::new()
    .route("/documents", post(create_document))
    .layer(TimeoutLayer::new(Duration::from_secs(5))) // mọi request quá 5s -> 408, không treo worker
    .with_state(pool.clone());

let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
axum::serve(listener, app)
    .with_graceful_shutdown(shutdown_signal()) // chờ SIGTERM, cho request đang chạy hoàn tất trước khi thoát
    .await?;

async fn shutdown_signal() {
    tokio::signal::ctrl_c().await.expect("lỗi cài SIGINT handler");
    // Production: nên bắt cả SIGTERM (k8s gửi SIGTERM khi terminate pod)
}
```

## 6. Health Check phân biệt Liveness vs Readiness

```rust
async fn health_live() -> StatusCode { StatusCode::OK } // process còn sống — không check dependency

async fn health_ready(State(pool): State<PgPool>) -> StatusCode {
    match sqlx::query("SELECT 1").fetch_one(&pool).await {
        Ok(_) => StatusCode::OK,                    // sẵn sàng nhận traffic — DB kết nối được
        Err(_) => StatusCode::SERVICE_UNAVAILABLE,  // k8s sẽ ngừng route traffic tới pod này
    }
}
```

**Phân biệt quan trọng:** liveness fail → k8s **restart pod**; readiness fail → k8s chỉ **ngừng gửi traffic**, không restart. Gộp chung 2 cái này là lỗi thiết kế phổ biến gây restart loop không cần thiết khi DB tạm chậm.

## 7. Structured Tracing xuyên suốt request (Bài 15, 34)

```rust
use tracing::instrument;

#[instrument(skip(pool))] // tự log entry/exit + args (trừ pool), tự gắn trace_id xuyên request
async fn create_document(State(pool): State<PgPool>, Json(payload): Json<CreateDocumentRequest>)
    -> Result<Json<DocumentResponse>, AppError>
{
    tracing::info!(title = %payload.title, "đang tạo document");
    // ...
}
```

## 8. Integration Test — test cả HTTP layer lẫn DB thật (Bài 15b)

```rust
// tests/api_test.rs — dùng testcontainers để spawn Postgres thật trong Docker cho test
#[tokio::test]
async fn create_and_get_document() {
    let pool = setup_test_db().await; // testcontainers: PostgreSQL container riêng cho mỗi test run
    let app = build_app(pool);

    let response = app.clone()
        .oneshot(Request::post("/documents").body(json_body(r#"{"title":"Hợp đồng A"}"#)).unwrap())
        .await.unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);
}
```

## Checklist hoàn thành

- [ ] Migration chạy tự động khi service start, có `up`/`down`
- [ ] Connection pool có `max_connections`/`acquire_timeout` tường minh
- [ ] Validation reject request sai TRƯỚC khi chạm DB
- [ ] 1 enum `AppError` duy nhất, implement `IntoResponse`, không handler nào tự map status code tay
- [ ] `/health/live` và `/health/ready` tách riêng, ý nghĩa khác nhau rõ ràng
- [ ] Timeout áp dụng ở tầng middleware (`TimeoutLayer`), không phải try/catch trong từng handler
- [ ] Graceful shutdown chờ request đang chạy xong trước khi thoát process
- [ ] Ít nhất 2 integration test dùng DB thật (qua testcontainers), không mock DB layer

---
**Câu hỏi phản tư (bắt buộc trả lời để hoàn thành dự án):** Nếu 1 request đang giữ DB connection trong pool mà bị timeout ở tầng Axum (`TimeoutLayer`) hủy giữa chừng, connection đó về pool ở trạng thái nào? Có rủi ro leak hay corrupt state không? (Gợi ý: liên hệ `Drop` ở Bài 8 và cancellation-safety của Tokio ở Bài 21).
