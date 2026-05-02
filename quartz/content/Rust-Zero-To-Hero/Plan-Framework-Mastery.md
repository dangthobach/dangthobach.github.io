# 🗺️ Framework Mastery Plan — Axum · ActixWeb · Leptos · SQLx · Diesel · Tonic

> **Dành cho:** Java Spring Boot Senior Developer học Rust production stack  
> **Prerequisite:** Đã hoàn thành Bài 1–23 (Rust-Zero-To-Hero)  
> **Mục tiêu:** Full-feature mastery, production-grade, từ cơ bản → nâng cao

---

## 📊 Đánh Giá Hiện Tại

### ✅ Tokio — Full Coverage (Bài 9 + Bài 21 + Bài 22)

| Topic | Trạng thái |
|---|---|
| `Future` trait, polling model | ✅ Bài 9 |
| `async/await` internals, state machine | ✅ Bài 9 + 21 |
| Runtime setup (`#[tokio::main]`, Builder) | ✅ Bài 9 |
| `tokio::spawn`, `JoinHandle`, `join!` | ✅ Bài 9 |
| `spawn_blocking` cho CPU-bound | ✅ Bài 9 |
| Channels: mpsc, oneshot, broadcast, watch | ✅ Bài 9 |
| `select!` macro | ✅ Bài 9 |
| `timeout`, `interval` | ✅ Bài 9 |
| `Pin<T>`, Waker internals | ✅ Bài 21 |
| Atomics, memory ordering | ✅ Bài 22 |
| Actor pattern với tokio channels | ✅ Bài 22 |
| `CancellationToken` | ✅ Bài 15 (graceful shutdown) |
| `tokio::fs`, `tokio::net` | ⚠️ Nhắc qua, chưa deep |
| `tokio_util` (codec, StreamReader) | ❌ Chưa có |
| `tokio::sync::Notify`, `Barrier` | ❌ Chưa có |

**Kết luận Tokio:** Đủ để build production web apps. `tokio_util`, `Notify`, `Barrier` là advanced features — bổ sung sau khi cần.

---

### ✅ Axum — Đã có Bài 10 + 11 (cần bổ sung)

| Topic | Trạng thái |
|---|---|
| Routing, nested router | ✅ Bài 10 |
| Extractors (Path, Query, Json, State) | ✅ Bài 10 |
| Custom extractors | ✅ Bài 10 |
| Middleware (Tower ServiceBuilder) | ✅ Bài 11 |
| Error handling + IntoResponse | ✅ Bài 11 |
| WebSocket | ❌ Chưa có |
| SSE (Server-Sent Events) | ❌ Chưa có |
| File upload (Multipart) | ❌ Chưa có |
| Testing (axum-test / TestClient) | ✅ Bài 15 |
| OpenAPI / utoipa integration | ❌ Chưa có |

---

## 🗺️ Tổng Quan Learning Path

```
┌─────────────────────────────────────────────────────────────────┐
│  FOUNDATION (✅ done)                                           │
│  Rust core + Tokio + Axum + SQLx basics                        │
├─────────────────────────────────────────────────────────────────┤
│  MODULE A — WEB FRAMEWORKS                                      │
│  Bài 24: Axum Advanced (WS, SSE, Upload, OpenAPI)              │
│  Bài 25: ActixWeb Full Course                                   │
├─────────────────────────────────────────────────────────────────┤
│  MODULE B — DATABASE LAYER                                      │
│  Bài 26: SQLx Advanced (types, transactions, testing)          │
│  Bài 27: Diesel Full Course                                     │
├─────────────────────────────────────────────────────────────────┤
│  MODULE C — RPC & FRONTEND                                      │
│  Bài 28: Tonic / gRPC Full Course                              │
│  Bài 29: Leptos Full Course (SSR + CSR + Hydration)            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📚 CHI TIẾT TỪNG MODULE

---

### BÀI 24 — Axum Advanced

> Bổ sung những feature còn thiếu sau Bài 10-11

#### 24.1 WebSocket
```rust
// Axum WebSocket handler
use axum::extract::ws::{WebSocket, WebSocketUpgrade, Message};

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    while let Some(Ok(msg)) = socket.recv().await {
        match msg {
            Message::Text(txt) => {
                socket.send(Message::Text(format!("Echo: {txt}"))).await.ok();
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}
// Java analog: @ServerEndpoint (Jakarta WebSocket) / Spring WebSocket
```

#### 24.2 SSE (Server-Sent Events)
```rust
use axum::response::sse::{Event, Sse};
use tokio_stream::wrappers::BroadcastStream;

async fn sse_handler(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.tx.subscribe();
    let stream = BroadcastStream::new(rx)
        .map(|msg| Ok(Event::default().data(msg.unwrap())));
    Sse::new(stream).keep_alive(KeepAlive::default())
}
// Java analog: SseEmitter / @GetMapping(produces = TEXT_EVENT_STREAM)
```

#### 24.3 File Upload (Multipart)
```rust
use axum::extract::Multipart;

async fn upload_handler(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    while let Some(field) = multipart.next_field().await? {
        let name = field.name().unwrap_or("unknown").to_string();
        let filename = field.file_name().map(str::to_owned);
        let content_type = field.content_type().map(str::to_owned);
        let bytes = field.bytes().await?;
        // Lưu file...
    }
    Ok(StatusCode::OK)
}
```

#### 24.4 OpenAPI với utoipa
```rust
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;

#[derive(Serialize, Deserialize, ToSchema)]
struct UserResponse {
    id: i64,
    name: String,
    email: String,
}

#[utoipa::path(
    get, path = "/api/v1/users/{id}",
    params(("id" = i64, Path, description = "User ID")),
    responses(
        (status = 200, body = UserResponse),
        (status = 404, description = "User not found")
    )
)]
async fn get_user(...) -> Result<Json<UserResponse>, AppError> { ... }

// Swagger UI mount
let app = Router::new()
    .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()));
// Java analog: @Operation, @ApiResponse, springdoc-openapi
```

---

### BÀI 25 — ActixWeb Full Course

> Framework thay thế Axum — hiệu năng cao, actor-based architecture

#### 25.1 Vì sao cần học ActixWeb?

```
Axum vs ActixWeb:

┌─────────────────┬─────────────────────┬─────────────────────┐
│ Tiêu chí        │ Axum                │ ActixWeb            │
├─────────────────┼─────────────────────┼─────────────────────┤
│ Runtime         │ Tokio (explicit)    │ Actix (trên Tokio)  │
│ Type safety     │ Compile-time        │ Compile-time        │
│ Throughput      │ Rất cao             │ Cao nhất (TechEmpower)│
│ Middleware      │ Tower (composable)  │ Wrap (simpler API)  │
│ WebSocket       │ Có                  │ Có (actix-ws)       │
│ Ecosystem       │ Tower ecosystem     │ Actix ecosystem     │
│ Learning curve  │ Moderate            │ Moderate            │
│ Java analog     │ Spring MVC          │ Vert.x              │
└─────────────────┴─────────────────────┴─────────────────────┘
```

#### 25.2 Hello World & App Setup
```rust
use actix_web::{web, App, HttpServer, HttpResponse, middleware::Logger};

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .wrap(Logger::default())          // middleware
            .app_data(web::JsonConfig::default().limit(1024 * 1024))
            .service(web::scope("/api/v1")
                .configure(users::config)
                .configure(orders::config))
            .route("/health", web::get().to(health_check))
    })
    .bind("0.0.0.0:8080")?
    .workers(4)                               // số worker threads
    .run()
    .await
}
```

#### 25.3 Routing & Service Configuration
```rust
// users.rs
pub fn config(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/users")
            .route("", web::get().to(list_users))
            .route("", web::post().to(create_user))
            .route("/{id}", web::get().to(get_user))
            .route("/{id}", web::put().to(update_user))
            .route("/{id}", web::delete().to(delete_user))
    );
}
// Java analog: @RequestMapping("/users") trên class level
```

#### 25.4 Extractors
```rust
use actix_web::{web, HttpRequest, HttpResponse};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct UserPath { id: i64 }

#[derive(Deserialize)]
struct Pagination { page: Option<u32>, size: Option<u32> }

#[derive(Deserialize)]
struct CreateUserDto { name: String, email: String }

// GET /users/{id}?page=1
async fn get_user(
    path: web::Path<UserPath>,          // @PathVariable
    query: web::Query<Pagination>,      // @RequestParam  
    data: web::Data<AppState>,          // @Autowired (shared state)
) -> HttpResponse {
    let user_id = path.id;
    let page = query.page.unwrap_or(1);
    let state = data.as_ref();
    HttpResponse::Ok().json(/* result */)
}

// POST /users (JSON body)
async fn create_user(
    body: web::Json<CreateUserDto>,     // @RequestBody
    data: web::Data<AppState>,
) -> HttpResponse {
    HttpResponse::Created().json(/* created user */)
}
```

#### 25.5 App State & Data Sharing
```rust
use actix_web::web::Data;
use std::sync::Arc;

struct AppState {
    db: PgPool,
    config: Arc<Config>,
    cache: Arc<RedisClient>,
}

// Đăng ký state
let state = Data::new(AppState { db: pool, config, cache });

HttpServer::new(move || {
    App::new()
        .app_data(state.clone())
        .service(/* routes */)
})
// Java analog: @Bean + @Autowired
// ActixWeb Data<T> tự wrap Arc bên trong
```

#### 25.6 Error Handling — ResponseError Trait
```rust
use actix_web::{HttpResponse, ResponseError};
use thiserror::Error;

#[derive(Debug, Error)]
enum AppError {
    #[error("User {id} not found")]
    UserNotFound { id: i64 },
    #[error("Unauthorized")]
    Unauthorized,
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
}

impl ResponseError for AppError {
    fn error_response(&self) -> HttpResponse {
        match self {
            AppError::UserNotFound { .. } => HttpResponse::NotFound().json(ErrorBody::from(self)),
            AppError::Unauthorized => HttpResponse::Unauthorized().json(ErrorBody::from(self)),
            AppError::Database(_) => HttpResponse::InternalServerError().json(ErrorBody::from(self)),
        }
    }
    
    fn status_code(&self) -> StatusCode {
        match self {
            AppError::UserNotFound { .. } => StatusCode::NOT_FOUND,
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

// Handler có thể return Result<_, AppError>
async fn get_user(path: web::Path<i64>) -> Result<HttpResponse, AppError> {
    let user = db_fetch(path.into_inner()).await
        .map_err(|_| AppError::UserNotFound { id: 0 })?;
    Ok(HttpResponse::Ok().json(user))
}
// Java analog: @ControllerAdvice + @ExceptionHandler
```

#### 25.7 Middleware
```rust
use actix_web::dev::{Service, ServiceRequest, ServiceResponse, Transform};
use actix_web::middleware::{Logger, DefaultHeaders, Compress};

// Built-in middleware
App::new()
    .wrap(Logger::default())                              // access log
    .wrap(Compress::default())                            // gzip
    .wrap(DefaultHeaders::new().add(("X-Version", "1"))) // inject headers
    
// Custom middleware với wrap_fn (đơn giản)
.wrap_fn(|req, srv| {
    let start = std::time::Instant::now();
    let fut = srv.call(req);
    async move {
        let res = fut.await?;
        println!("Request took {}ms", start.elapsed().as_millis());
        Ok(res)
    }
})

// Full middleware (phức tạp — implement Transform + Service)
// Java analog: OncePerRequestFilter
```

#### 25.8 WebSocket với actix-ws
```rust
use actix_ws::{Message, Session};

async fn ws_handler(
    req: HttpRequest,
    stream: web::Payload,
    data: web::Data<AppState>,
) -> Result<HttpResponse, actix_web::Error> {
    let (res, mut session, mut stream) = actix_ws::handle(&req, stream)?;
    
    actix_web::rt::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(text) => {
                    session.text(format!("Echo: {text}")).await.ok();
                }
                Message::Close(reason) => {
                    session.close(reason).await.ok();
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(res)
}
```

#### 25.9 Testing
```rust
use actix_web::test;

#[actix_web::test]
async fn test_get_user() {
    let app = test::init_service(
        App::new()
            .app_data(Data::new(create_test_state().await))
            .configure(users::config)
    ).await;
    
    let req = test::TestRequest::get()
        .uri("/users/1")
        .to_request();
    
    let resp: UserResponse = test::call_and_read_body_json(&app, req).await;
    assert_eq!(resp.id, 1);
}
```

---

### BÀI 26 — SQLx Advanced

> Deep dive những tính năng chưa cover ở Bài 12

#### 26.1 Compile-time Query Verification
```bash
# Yêu cầu DATABASE_URL trong .env
DATABASE_URL=postgres://user:pass@localhost/dbname

# Chạy prepare để cache query metadata (cho CI khi không có DB)
cargo sqlx prepare
```

```rust
// query! — kiểm tra SQL tại compile time
let user = sqlx::query!(
    "SELECT id, name, email, created_at FROM users WHERE id = $1",
    user_id
)
.fetch_one(&pool)
.await?;
// user.id: i64, user.name: String, ... — compiler biết types!

// query_as! — map vào struct
#[derive(sqlx::FromRow)]
struct User {
    id: i64,
    name: String,
    email: String,
    created_at: DateTime<Utc>,
}

let user = sqlx::query_as!(User,
    "SELECT id, name, email, created_at FROM users WHERE id = $1",
    id
)
.fetch_one(&pool)
.await?;
```

#### 26.2 Custom Types
```rust
use sqlx::{Type, Encode, Decode};

// Map PostgreSQL enum → Rust enum
#[derive(Debug, sqlx::Type, Serialize, Deserialize)]
#[sqlx(type_name = "user_status", rename_all = "lowercase")]
enum UserStatus {
    Active,
    Inactive,
    Suspended,
}

// Map JSONB → serde struct
#[derive(Serialize, Deserialize)]
struct Metadata {
    tags: Vec<String>,
    source: String,
}

// Dùng sqlx::types::Json wrapper
let row = sqlx::query!(
    "SELECT id, metadata FROM users WHERE id = $1",
    id
)
.fetch_one(&pool)
.await?;
let metadata: Metadata = serde_json::from_value(row.metadata)?;
```

#### 26.3 Transactions Pattern
```rust
// Basic transaction
async fn transfer_funds(
    pool: &PgPool,
    from: i64, to: i64, amount: Decimal
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    
    sqlx::query!("UPDATE accounts SET balance = balance - $1 WHERE id = $2",
        amount, from).execute(&mut *tx).await?;
    
    sqlx::query!("UPDATE accounts SET balance = balance + $1 WHERE id = $2",
        amount, to).execute(&mut *tx).await?;
    
    tx.commit().await?;  // auto rollback nếu không commit (Drop)
    Ok(())
}

// Savepoint (nested transaction)
let mut tx = pool.begin().await?;
let savepoint = tx.begin().await?;
// ... operations
savepoint.rollback().await?; // chỉ rollback đến savepoint
tx.commit().await?;
```

#### 26.4 Bulk Operations
```rust
// Bulk insert với UNNEST (PostgreSQL-specific, cực nhanh)
let ids: Vec<i64> = users.iter().map(|u| u.id).collect();
let names: Vec<&str> = users.iter().map(|u| u.name.as_str()).collect();
let emails: Vec<&str> = users.iter().map(|u| u.email.as_str()).collect();

sqlx::query!(
    "INSERT INTO users (id, name, email)
     SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::text[])",
    &ids[..], &names[..], &emails[..]
)
.execute(&pool)
.await?;
// Java analog: JdbcTemplate.batchUpdate(), Spring Data saveAll()
```

#### 26.5 sqlx::test
```rust
#[sqlx::test(fixtures("users", "orders"))]
async fn test_get_user_with_orders(pool: PgPool) {
    // pool tự động được tạo, migrate, và rollback sau test
    let user = get_user_with_orders(&pool, 1).await.unwrap();
    assert_eq!(user.orders.len(), 2);
}
// fixtures/users.sql, fixtures/orders.sql tự động load
// Mỗi test chạy trong isolated transaction → không side effect
```

---

### BÀI 27 — Diesel Full Course

> ORM alternative — type-safe, compile-time DSL, eager schema

#### 27.1 Diesel vs SQLx

```
┌──────────────┬────────────────────────────┬────────────────────────────┐
│ Tiêu chí     │ SQLx                       │ Diesel                     │
├──────────────┼────────────────────────────┼────────────────────────────┤
│ Approach     │ Raw SQL với compile check  │ Type-safe DSL (viết Rust)  │
│ Schema       │ Tự quản lý migrations      │ schema.rs auto-generated   │
│ Query style  │ SQL string                 │ Rust DSL                   │
│ Async        │ Native async               │ diesel-async crate         │
│ Type safety  │ Compile-time (query macro) │ Compile-time (DSL)         │
│ Joins        │ SQL JOIN                   │ DSL joins                  │
│ Learning     │ Thấp (biết SQL là đủ)     │ Trung bình (học DSL)       │
│ Java analog  │ JdbcTemplate + Flyway      │ JPA/Hibernate              │
└──────────────┴────────────────────────────┴────────────────────────────┘

Khi nào dùng Diesel: Team quen ORM pattern, cần associations tự động,
  không muốn viết SQL tay cho CRUD cơ bản.
Khi nào dùng SQLx: Cần full SQL control, queries phức tạp, JSONB, CTEs.
```

#### 27.2 Setup & Schema Generation
```bash
# Install diesel_cli
cargo install diesel_cli --no-default-features --features postgres

# Setup
diesel setup
diesel migration generate create_users

# migrations/2024-01-01-000001_create_users/up.sql
```
```sql
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
```bash
diesel migration run  # áp dụng migration
# Tự động generate src/schema.rs!
```

#### 27.3 Schema & Models
```rust
// src/schema.rs (auto-generated bởi diesel)
diesel::table! {
    users (id) {
        id -> Int8,
        name -> Varchar,
        email -> Varchar,
        status -> Varchar,
        created_at -> Timestamptz,
    }
}

// src/models/user.rs
use crate::schema::users;

// Queryable: SELECT → Rust struct
#[derive(Debug, Queryable, Selectable, Serialize)]
#[diesel(table_name = users)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub email: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

// Insertable: Rust struct → INSERT
#[derive(Insertable, Deserialize)]
#[diesel(table_name = users)]
pub struct NewUser {
    pub name: String,
    pub email: String,
}

// AsChangeset: Rust struct → UPDATE SET
#[derive(AsChangeset, Deserialize)]
#[diesel(table_name = users)]
pub struct UpdateUser {
    pub name: Option<String>,
    pub email: Option<String>,
}
```

#### 27.4 CRUD Operations (DSL)
```rust
use diesel::prelude::*;
use crate::schema::users::dsl::*;

// Connection (sync, dùng trong spawn_blocking)
// Hoặc AsyncPgConnection với diesel-async

// SELECT
let all_users = users.select(User::as_select())
    .load::<User>(&mut conn)?;

// SELECT với filter
let user = users.filter(id.eq(user_id))
    .select(User::as_select())
    .first(&mut conn)
    .optional()?; // trả về Option<User>

// SELECT với multiple filters
let active_users = users
    .filter(status.eq("active"))
    .filter(name.like("%John%"))
    .order(created_at.desc())
    .limit(20)
    .offset(0)
    .select(User::as_select())
    .load(&mut conn)?;

// INSERT
let new_user = NewUser { name: "Bach".to_string(), email: "bach@vpbank.com".to_string() };
let created = diesel::insert_into(users)
    .values(&new_user)
    .returning(User::as_returning())
    .get_result(&mut conn)?;

// UPDATE
let updated = diesel::update(users.filter(id.eq(user_id)))
    .set(&UpdateUser { name: Some("New Name".to_string()), email: None })
    .returning(User::as_returning())
    .get_result(&mut conn)?;

// DELETE
diesel::delete(users.filter(id.eq(user_id)))
    .execute(&mut conn)?;
```

#### 27.5 Associations (Quan hệ)
```rust
// One-to-many: User has many Orders
diesel::table! {
    orders (id) {
        id -> Int8,
        user_id -> Int8,
        total -> Numeric,
    }
}

joinable!(orders -> users (user_id));
allow_tables_to_appear_in_same_query!(users, orders);

#[derive(Debug, Queryable, Selectable, Identifiable, Associations)]
#[diesel(belongs_to(User))]
#[diesel(table_name = orders)]
pub struct Order {
    pub id: i64,
    pub user_id: i64,
    pub total: BigDecimal,
}

// Load user với orders
let user = users.filter(id.eq(1)).first::<User>(&mut conn)?;
let user_orders = Order::belonging_to(&user)
    .select(Order::as_select())
    .load(&mut conn)?;

// Bulk load (N+1 prevention)
let users_list = users.load::<User>(&mut conn)?;
let orders_list = Order::belonging_to(&users_list)
    .select(Order::as_select())
    .load(&mut conn)?;
let grouped = orders_list.grouped_by(&users_list);
let result: Vec<(User, Vec<Order>)> = users_list.into_iter().zip(grouped).collect();
// Java analog: @OneToMany với fetch = EAGER (nhưng N+1 safe!)
```

#### 27.6 Diesel Async (với Axum/ActixWeb)
```toml
[dependencies]
diesel-async = { version = "0.5", features = ["postgres", "deadpool"] }
deadpool = "0.12"
```
```rust
use diesel_async::{AsyncPgConnection, RunQueryDsl, pooled_connection::deadpool::Pool};

// Connection pool
let pool = Pool::builder(/* config */).build().unwrap();

// Async queries — API giống Diesel sync nhưng có .await
let user = users.filter(id.eq(user_id))
    .select(User::as_select())
    .first::<User>(&mut conn)
    .await?;
// Java analog: Spring Data JPA với @Async
```

---

### BÀI 28 — Tonic / gRPC Full Course

> gRPC framework cho Rust — microservices, high-performance RPC

#### 28.1 Tại sao gRPC?

```
REST/HTTP vs gRPC:

REST:
  Protocol:  HTTP/1.1 + JSON (text)
  Schema:    OpenAPI (optional)
  Streaming: Server-Sent Events (limited)
  Perf:      Tốt cho web
  
gRPC:
  Protocol:  HTTP/2 + Protobuf (binary)
  Schema:    .proto (mandatory, contract-first)
  Streaming: 4 modes (unary, server, client, bidirectional)
  Perf:      5-10x nhanh hơn REST cho microservices
  
Java analog: Spring gRPC / gRPC-Java
Khi dùng gRPC: internal microservices, high-throughput, streaming data
Khi dùng REST: public API, browser clients, simple integrations
```

#### 28.2 Project Setup
```toml
# Cargo.toml
[dependencies]
tonic = "0.12"
prost = "0.13"
tokio = { version = "1", features = ["full"] }
tonic-reflection = "0.12"

[build-dependencies]
tonic-build = "0.12"
```

```rust
// build.rs — compile .proto → Rust code
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::compile_protos("proto/user.proto")?;
    Ok(())
}
```

#### 28.3 Protobuf Definition
```protobuf
// proto/user.proto
syntax = "proto3";
package user.v1;

service UserService {
    rpc GetUser (GetUserRequest) returns (UserResponse);
    rpc CreateUser (CreateUserRequest) returns (UserResponse);
    rpc ListUsers (ListUsersRequest) returns (stream UserResponse);
    rpc UpdateUsers (stream UpdateUserRequest) returns (BatchResponse);
    rpc Chat (stream ChatMessage) returns (stream ChatMessage);
}

message GetUserRequest { int64 id = 1; }
message CreateUserRequest {
    string name = 1;
    string email = 2;
}
message UserResponse {
    int64 id = 1;
    string name = 2;
    string email = 3;
    string status = 4;
}
message ListUsersRequest {
    int32 page = 1;
    int32 size = 2;
}
message UpdateUserRequest {
    int64 id = 1;
    string name = 2;
}
message BatchResponse { int32 updated = 1; }
message ChatMessage { string content = 1; }
```

#### 28.4 Server Implementation
```rust
use tonic::{transport::Server, Request, Response, Status};
// Generated code từ .proto
use user::v1::user_service_server::{UserService, UserServiceServer};
use user::v1::*;

pub mod user {
    pub mod v1 {
        tonic::include_proto!("user.v1");
    }
}

#[derive(Debug, Default, Clone)]
struct UserServiceImpl {
    db: PgPool,
}

#[tonic::async_trait]
impl UserService for UserServiceImpl {
    // Unary RPC
    async fn get_user(
        &self,
        request: Request<GetUserRequest>,
    ) -> Result<Response<UserResponse>, Status> {
        let id = request.into_inner().id;
        
        let user = sqlx::query_as!(User, "SELECT * FROM users WHERE id = $1", id)
            .fetch_one(&self.db)
            .await
            .map_err(|_| Status::not_found(format!("User {} not found", id)))?;
        
        Ok(Response::new(UserResponse {
            id: user.id,
            name: user.name,
            email: user.email,
            status: user.status,
        }))
    }
    
    // Server-side streaming
    type ListUsersStream = ReceiverStream<Result<UserResponse, Status>>;
    
    async fn list_users(
        &self,
        request: Request<ListUsersRequest>,
    ) -> Result<Response<Self::ListUsersStream>, Status> {
        let (tx, rx) = tokio::sync::mpsc::channel(100);
        let db = self.db.clone();
        
        tokio::spawn(async move {
            let mut cursor = sqlx::query_as!(User, "SELECT * FROM users ORDER BY id")
                .fetch(&db);
            
            while let Some(Ok(user)) = cursor.next().await {
                if tx.send(Ok(UserResponse { id: user.id, name: user.name, email: user.email, status: user.status }))
                    .await.is_err() { break; }
            }
        });
        
        Ok(Response::new(ReceiverStream::new(rx)))
    }
    
    // Bidirectional streaming
    type ChatStream = ReceiverStream<Result<ChatMessage, Status>>;
    
    async fn chat(
        &self,
        request: Request<Streaming<ChatMessage>>,
    ) -> Result<Response<Self::ChatStream>, Status> {
        let mut stream = request.into_inner();
        let (tx, rx) = tokio::sync::mpsc::channel(100);
        
        tokio::spawn(async move {
            while let Some(Ok(msg)) = stream.next().await {
                let reply = ChatMessage { content: format!("Echo: {}", msg.content) };
                if tx.send(Ok(reply)).await.is_err() { break; }
            }
        });
        
        Ok(Response::new(ReceiverStream::new(rx)))
    }
}

// Start server
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = "0.0.0.0:50051".parse()?;
    let service = UserServiceImpl { db: pool };
    
    Server::builder()
        .add_service(UserServiceServer::new(service))
        .add_service(tonic_reflection::server::Builder::configure()
            .register_encoded_file_descriptor_set(FILE_DESCRIPTOR_SET)
            .build_v1()?)
        .serve(addr)
        .await?;
    Ok(())
}
```

#### 28.5 Interceptors (Middleware)
```rust
use tonic::{service::interceptor, Request, Status};

// Auth interceptor
fn auth_interceptor(req: Request<()>) -> Result<Request<()>, Status> {
    let token = req.metadata().get("authorization")
        .ok_or_else(|| Status::unauthenticated("Missing token"))?
        .to_str().map_err(|_| Status::unauthenticated("Invalid token"))?;
    
    let user_id = verify_jwt(token)
        .map_err(|_| Status::unauthenticated("Invalid token"))?;
    
    let mut req = req;
    req.extensions_mut().insert(UserId(user_id));
    Ok(req)
}

// Apply interceptor
Server::builder()
    .add_service(UserServiceServer::with_interceptor(service, auth_interceptor))
    .serve(addr)
    .await?;
// Java analog: ClientInterceptor / ServerInterceptor trong gRPC-Java
```

#### 28.6 Client Usage
```rust
use tonic::transport::Channel;
use user::v1::user_service_client::UserServiceClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let channel = Channel::from_static("http://[::1]:50051")
        .connect()
        .await?;
    
    let mut client = UserServiceClient::new(channel);
    
    // Unary call
    let response = client.get_user(GetUserRequest { id: 1 }).await?;
    println!("User: {:?}", response.into_inner());
    
    // Server streaming
    let mut stream = client.list_users(ListUsersRequest { page: 1, size: 10 })
        .await?
        .into_inner();
    
    while let Some(user) = stream.message().await? {
        println!("User: {:?}", user);
    }
    
    Ok(())
}
```

---

### BÀI 29 — Leptos Full Course

> Fullstack web framework — viết UI bằng Rust (SSR + CSR + Hydration)

#### 29.1 Leptos là gì?

```
Leptos = React + Next.js nhưng viết bằng Rust thuần

Feature                 React/Next.js           Leptos
─────────────────────────────────────────────────────
Component model         JSX (JS/TS)             RSX (Rust macros)
Reactivity              State + hooks           Signals (fine-grained)
SSR                     Next.js (Node)          Axum/Actix backend
Hydration               Client hydrates SSR     Partial hydration
Server functions        API routes              #[server] macro
Compile target          JS bundle               WASM + native binary
Type safety             TypeScript              Rust (compile-time)

Java analog: Vaadin (server UI) + Thymeleaf — nhưng modern reactive
```

#### 29.2 Setup
```toml
[dependencies]
leptos = { version = "0.7", features = ["ssr"] }
leptos_axum = "0.7"
axum = "0.7"
tokio = { version = "1", features = ["full"] }
```

#### 29.3 Components & RSX
```rust
use leptos::prelude::*;

// Function component (giống React functional component)
#[component]
fn UserCard(user: User) -> impl IntoView {
    view! {
        <div class="card">
            <h2>{user.name}</h2>
            <p>{user.email}</p>
        </div>
    }
}

// Component với children
#[component]
fn Container(children: Children) -> impl IntoView {
    view! {
        <div class="container">
            {children()}
        </div>
    }
}

// App root
#[component]
fn App() -> impl IntoView {
    view! {
        <Container>
            <UserCard user=User { id: 1, name: "Bach".into(), email: "bach@vpbank.com".into() }/>
        </Container>
    }
}
```

#### 29.4 Signals — Reactivity
```rust
use leptos::prelude::*;

#[component]
fn Counter() -> impl IntoView {
    // Signal = reactive state (giống React useState)
    let (count, set_count) = signal(0i32);
    
    // Derived signal (giống React useMemo)
    let doubled = move || count.get() * 2;
    
    // Effect (giống React useEffect)
    Effect::new(move |_| {
        log::info!("Count changed to {}", count.get());
    });
    
    view! {
        <div>
            <p>"Count: " {count}</p>
            <p>"Doubled: " {doubled}</p>
            <button on:click=move |_| set_count.update(|n| *n += 1)>
                "Increment"
            </button>
            <button on:click=move |_| set_count.set(0)>
                "Reset"
            </button>
        </div>
    }
}
// Java/Spring analog: không có direct — gần nhất là Vaadin reactive binding
```

#### 29.5 Server Functions — Killer Feature
```rust
// Server function — chạy trên server, gọi từ client!
#[server(GetUsers, "/api")]
pub async fn get_users(page: u32, size: u32) -> Result<Vec<User>, ServerFnError> {
    // Code này chạy trên server (Axum handler)
    let pool = use_context::<PgPool>().ok_or(ServerFnError::ServerError("No DB".into()))?;
    let users = sqlx::query_as!(User, "SELECT * FROM users LIMIT $1 OFFSET $2",
        size as i64, (page * size) as i64)
        .fetch_all(&pool)
        .await?;
    Ok(users)
}

// Gọi từ component (compile sang fetch call trên client)
#[component]
fn UserList() -> impl IntoView {
    let users = Resource::new(|| (), |_| get_users(1, 20));
    
    view! {
        <Suspense fallback=move || view! { <p>"Loading..."</p> }>
            <ErrorBoundary fallback=|errors| view! { <p>"Error: " {format!("{:?}", errors)}</p> }>
                {move || users.get().map(|users| {
                    users.map(|list| list.into_iter()
                        .map(|u| view! { <UserCard user=u /> })
                        .collect_view())
                })}
            </ErrorBoundary>
        </Suspense>
    }
}
// Java analog: Spring MVC controller + Thymeleaf template — nhưng type-safe end-to-end
```

#### 29.6 Routing
```rust
use leptos_router::*;

#[component]
fn App() -> impl IntoView {
    view! {
        <Router>
            <nav>
                <A href="/">"Home"</A>
                <A href="/users">"Users"</A>
            </nav>
            <main>
                <Routes fallback=NotFound>
                    <Route path=path!("") view=HomePage />
                    <Route path=path!("users") view=UserList />
                    <Route path=path!("users/:id") view=UserDetail />
                </Routes>
            </main>
        </Router>
    }
}

// Nested route với params
#[component]
fn UserDetail() -> impl IntoView {
    let params = use_params_map();
    let id = move || params.with(|p| p.get("id").and_then(|id| id.parse::<i64>().ok()));
    
    let user = Resource::new(id, |id| async move {
        get_user(id?).await.ok()
    });
    // ...
}
```

#### 29.7 SSR + Hydration với Axum
```rust
// main.rs — Axum server với Leptos SSR
use leptos_axum::{generate_route_list, LeptosRoutes};

#[tokio::main]
async fn main() {
    let conf = get_configuration(None).await.unwrap();
    let leptos_options = conf.leptos_options;
    let routes = generate_route_list(App);
    
    let app = Router::new()
        .leptos_routes(&leptos_options, routes, App)
        .fallback(file_and_error_handler)
        .layer(Extension(Arc::new(pool))); // inject DB pool cho server fns
    
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
// Java analog: Spring Boot + Thymeleaf SSR + Turbo/HTMX hydration
```

---

## 📅 Thứ Tự Học Đề Xuất

```
Phase 1 — Web Framework Depth (4-6 tuần)
─────────────────────────────────────────
Week 1-2: Bài 24 — Axum Advanced
          → Bổ sung WS, SSE, Upload, OpenAPI
          → Project: Chat service với WebSocket

Week 3-4: Bài 25 — ActixWeb Full
          → Hiểu cả hai framework để so sánh
          → Project: REST API với ActixWeb

Week 5-6: Bài 28 — Tonic/gRPC
          → Internal service communication
          → Project: User microservice với gRPC

Phase 2 — Database Layer (3-4 tuần)  
────────────────────────────────────
Week 7-8: Bài 26 — SQLx Advanced
          → Custom types, bulk ops, testing
          → Áp dụng vào PDMS-like use case

Week 9-10: Bài 27 — Diesel
           → ORM approach, so sánh với SQLx
           → Project: CRUD app với Diesel + diesel-async

Phase 3 — Fullstack (4-6 tuần)
───────────────────────────────
Week 11-14: Bài 29 — Leptos
            → Component → Signals → Server Functions → SSR
            → Project: Admin dashboard cho PDMS

Phase 4 — Capstone Project
────────────────────────────
Kết hợp: Axum (gateway) + Tonic (services) + SQLx/Diesel + Leptos (UI)
Mini PDMS viết bằng Rust từ đầu đến cuối
```

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9: Tokio]] ✅
- [[Rust-Zero-To-Hero/Bai-10-Axum-Core|Bài 10: Axum Core]] ✅
- [[Rust-Zero-To-Hero/Bai-11-Axum-Middleware-Error|Bài 11: Axum Middleware]] ✅
- [[Rust-Zero-To-Hero/Bai-12-SQLx-Database|Bài 12: SQLx Basics]] ✅
- Bài 24: Axum Advanced ← next
- Bài 25: ActixWeb ← next
- Bài 26: SQLx Advanced ← next
- Bài 27: Diesel ← next
- Bài 28: Tonic/gRPC ← next
- Bài 29: Leptos ← next
