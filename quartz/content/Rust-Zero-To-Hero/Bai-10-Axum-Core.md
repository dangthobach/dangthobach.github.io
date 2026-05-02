# Bài 10: Axum Core — Routing, Extractors & App State

Chào Chuyên gia Java. Đây là bài bạn đã chờ đợi. Axum = Spring MVC nhưng compile-time safe, zero reflection, và build trên tokio. Mọi thứ từ Bài 1–9 đều hội tụ tại đây.

---

## 1. Project Setup

```toml
# Cargo.toml
[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tower = "0.4"
tower-http = { version = "0.5", features = ["cors", "trace", "compression"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

---

## 2. Minimal Working Server

```rust
use axum::{routing::get, Router};

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/", get(root_handler))
        .route("/health", get(|| async { "OK" }));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    println!("Listening on {}", listener.local_addr().unwrap());
    axum::serve(listener, app).await.unwrap();
}

async fn root_handler() -> &'static str {
    "Hello from Axum!"
}
```

**Java analog:**
```java
@SpringBootApplication
public class App { public static void main(String[] args) { SpringApplication.run(App.class, args); } }

@RestController
public class RootController {
    @GetMapping("/") public String root() { return "Hello!"; }
}
```

---

## 3. Routing

```rust
use axum::routing::{delete, get, post, put};

let users_router = Router::new()
    .route("/",       get(list_users).post(create_user))
    .route("/:id",    get(get_user).put(update_user).delete(delete_user))
    .route("/:id/orders", get(get_user_orders));

// Nested routers — tổ chức theo domain
let app = Router::new()
    .nest("/api/v1/users", users_router)
    .nest("/api/v1/orders", orders_router)
    .route("/health", get(health_check));
```

---

## 4. Extractors — Đây Là Core Concept Của Axum

Extractor là type implement `FromRequest` hoặc `FromRequestParts`. Axum tự inject vào handler params.

### Path params
```rust
use axum::extract::Path;

// GET /users/42
async fn get_user(Path(id): Path<i64>) -> impl IntoResponse {
    format!("User id: {}", id)
}

// Multiple path params
// GET /users/42/orders/7
async fn get_order(Path((user_id, order_id)): Path<(i64, i64)>) -> impl IntoResponse {
    format!("User {} Order {}", user_id, order_id)
}
```

### Query params
```rust
use axum::extract::Query;
use serde::Deserialize;

#[derive(Deserialize)]
struct Pagination {
    page: Option<u32>,
    size: Option<u32>,
}

// GET /users?page=2&size=20
async fn list_users(Query(pagination): Query<Pagination>) -> impl IntoResponse {
    let page = pagination.page.unwrap_or(1);
    let size = pagination.size.unwrap_or(20);
    format!("Page {} Size {}", page, size)
}
```

### JSON Body
```rust
use axum::extract::Json;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct CreateUserDto {
    name: String,
    email: String,
}

#[derive(Serialize)]
struct UserResponse {
    id: i64,
    name: String,
    email: String,
}

async fn create_user(Json(dto): Json<CreateUserDto>) -> impl IntoResponse {
    // dto.name, dto.email available
    Json(UserResponse { id: 1, name: dto.name, email: dto.email })
}
```

### State — Shared App Dependencies
```rust
use axum::extract::State;

// App state — equivalent to Spring @Autowired beans
#[derive(Clone)]
struct AppState {
    db: PgPool,
    config: Arc<Config>,
}

// Handler nhận state
async fn get_user(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<UserResponse>, AppError> {
    let user = sqlx::query_as!(UserResponse,
        "SELECT id, name, email FROM users WHERE id = $1", id)
        .fetch_one(&state.db)
        .await
        .map_err(|_| AppError::UserNotFound { id })?;
    Ok(Json(user))
}

// Register state
let state = AppState { db: pool, config: Arc::new(config) };
let app = Router::new()
    .route("/users/:id", get(get_user))
    .with_state(state);
```

**Java analog:** `@Autowired UserRepository`, `@Autowired Config` → trong Axum, tất cả qua `State<AppState>`.

---

## 5. Handler Signature Rules

Axum handlers là async functions với pattern linh hoạt. Axum tự figure out cách inject params theo type:

```rust
// Tất cả đều hợp lệ:
async fn handler_1() -> &'static str { "ok" }
async fn handler_2(Path(id): Path<i64>) -> String { format!("{}", id) }
async fn handler_3(State(s): State<AppState>, Json(b): Json<Dto>) -> impl IntoResponse { ... }
async fn handler_4(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<Params>,
    Json(body): Json<CreateDto>,
) -> Result<Json<Response>, AppError> { ... }

// Quy tắc: State phải là tham số đầu tiên nếu có
// Body extractor (Json, Bytes, String) phải là cuối cùng
```

---

## 6. Responses

```rust
use axum::http::StatusCode;

// Trả về tuple (status, body)
async fn create_user(...) -> (StatusCode, Json<User>) {
    (StatusCode::CREATED, Json(user))
}

// Trả về Result — Ok branch và Err branch đều là IntoResponse
async fn get_user(...) -> Result<Json<User>, AppError> {
    // AppError phải impl IntoResponse (xem Bài 8)
}

// Custom response với headers
use axum::response::Response;
use axum::http::header;

async fn download_file() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_DISPOSITION, "attachment; filename=file.pdf")
        .body(axum::body::Body::from(file_bytes))
        .unwrap()
}
```

---

## 7. Request Extensions — Middleware → Handler Data Flow

```rust
use axum::extract::Extension;

// Middleware inject data vào request extension
async fn auth_middleware(mut req: Request, next: Next) -> Response {
    let user_id = extract_user_id_from_jwt(&req).await?;
    req.extensions_mut().insert(UserId(user_id)); // inject
    next.run(req).await
}

// Handler extract từ extension
async fn profile(
    Extension(user_id): Extension<UserId>,
    State(state): State<AppState>,
) -> Result<Json<User>, AppError> {
    // user_id được inject bởi middleware
}
```

---

## 8. Custom Extractors

Implement `FromRequestParts` cho domain-specific extraction:

```rust
use axum::{async_trait, extract::FromRequestParts, http::request::Parts};

struct AuthenticatedUser {
    id: i64,
    role: String,
}

#[async_trait]
impl<S> FromRequestParts<S> for AuthenticatedUser
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let auth_header = parts.headers
            .get("Authorization")
            .ok_or(AppError::Unauthorized)?
            .to_str()
            .map_err(|_| AppError::Unauthorized)?;
        
        let token = auth_header.strip_prefix("Bearer ")
            .ok_or(AppError::Unauthorized)?;
        
        let claims = verify_jwt(token)?;
        
        Ok(AuthenticatedUser { id: claims.sub, role: claims.role })
    }
}

// Dùng như extractor bình thường
async fn admin_action(user: AuthenticatedUser) -> impl IntoResponse {
    if user.role != "admin" { return Err(AppError::Forbidden); }
    // ...
}
```

---

## 9. Organizing A Real App

```
src/
├── main.rs          ← runtime setup, router assembly
├── routes/
│   ├── mod.rs       ← combine all routers
│   ├── users.rs     ← /api/v1/users handlers
│   └── orders.rs    ← /api/v1/orders handlers
├── models/
│   ├── user.rs      ← User struct, CreateUserDto, UserResponse
│   └── order.rs
├── services/
│   ├── user_service.rs  ← business logic
│   └── order_service.rs
├── db/
│   └── queries.rs   ← SQLx queries
├── errors.rs        ← AppError + IntoResponse
├── middleware/
│   ├── auth.rs
│   └── logging.rs
└── config.rs        ← Config struct, load from env
```

**Java analog:**
```
controller/ → routes/
service/    → services/
repository/ → db/
dto/        → models/
exception/  → errors.rs
```

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9: Tokio]] — runtime
- [[Rust-Zero-To-Hero/Bai-11-Axum-Middleware-Error|Bài 11: Middleware & Production Patterns]]
- [[Rust-Zero-To-Hero/Bai-12-SQLx-Database|Bài 12: SQLx Database]]
- [[Rust-Zero-To-Hero/Bai-8-Smart-Pointers-Error-Design|Bài 8: AppError pattern]]

---
*Bài tập:*
1. Tạo CRUD router cho `Product` — GET list, GET by id, POST create, PUT update, DELETE. Dùng in-memory `Arc<RwLock<HashMap<i64, Product>>>` làm store.
2. Implement custom extractor `PaginationParams` từ query string với default values và validation (page >= 1, size <= 100).
3. Implement custom extractor `AuthenticatedUser` đọc header `X-User-Id` và `X-User-Role` (giả lập auth gateway inject headers).
