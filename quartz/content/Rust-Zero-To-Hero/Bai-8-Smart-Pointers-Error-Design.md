# Bài 8: Smart Pointers & Error Design — Foundation của App State

Chào Chuyên gia Java. Bài này có hai phần liên kết chặt: Smart Pointers (cách quản lý ownership phức tạp) và Error Design (cách xây dựng error system cho toàn app). Cả hai đều cần thiết trước khi bước vào Tokio và Axum.

---

## PHẦN 1 — SMART POINTERS

## 1. Bản đồ Smart Pointers

```
            ┌─────────────────────────────────────────┐
            │           Mục đích                      │
            ├──────────────┬──────────────────────────┤
Thread-safe │  Arc<T>      │  Arc<Mutex<T>>           │
            │              │  Arc<RwLock<T>>          │
            ├──────────────┼──────────────────────────┤
Single-thread│  Rc<T>      │  Rc<RefCell<T>>          │
            │  Box<T>      │  Cell<T>                 │
            └──────────────┴──────────────────────────┘
              Shared ref    Shared mutable ref
```

---

## 2. `Box<T>` — Heap Allocation Đơn Giản

```rust
// Use case 1: Recursive types — compiler cần biết size
enum List {
    Cons(i32, Box<List>), // Box breaks infinite size
    Nil,
}

// Use case 2: Trait objects
fn make_animal(is_dog: bool) -> Box<dyn Animal> {
    if is_dog { Box::new(Dog) } else { Box::new(Cat) }
}

// Use case 3: Large data — tránh copy lớn trên stack
let big_array = Box::new([0u8; 1_000_000]);
```

**Java analog:** Mọi object trong Java đều là Box ngầm định. Trong Rust bạn explicit.

---

## 3. `Arc<T>` — Shared Ownership Across Threads

`Arc` = Atomic Reference Counted. Đây là cách duy nhất để share data giữa nhiều tasks/threads mà không dùng `static`.

```rust
use std::sync::Arc;

let config = Arc::new(AppConfig::load());

// Clone chỉ copy pointer + increment counter — không copy data
let config_for_worker = Arc::clone(&config);
let config_for_handler = Arc::clone(&config);

tokio::spawn(async move {
    println!("{}", config_for_worker.db_url); // read-only: fine
});
```

**Trong Axum — đây là pattern chính cho App State:**
```rust
#[derive(Clone)]
struct AppState {
    db: PgPool,                    // PgPool đã có Arc bên trong
    config: Arc<Config>,           // immutable config
    cache: Arc<RwLock<HashMap<..>>>, // mutable shared cache
}

// Axum tự Clone state cho mỗi request
let app = Router::new().with_state(AppState { ... });
```

---

## 4. `Mutex<T>` và `RwLock<T>` — Mutable Shared State

```rust
use std::sync::{Arc, Mutex, RwLock};

// Mutex — exclusive access (read OR write, one at a time)
let counter = Arc::new(Mutex::new(0i64));

let c = Arc::clone(&counter);
tokio::spawn(async move {
    let mut guard = c.lock().unwrap(); // blocks until lock acquired
    *guard += 1;
    // guard dropped → lock released automatically
});

// RwLock — multiple readers OR one writer
let cache: Arc<RwLock<HashMap<String, String>>> = Arc::new(RwLock::new(HashMap::new()));

// Read — nhiều readers cùng lúc
let read_guard = cache.read().unwrap();
println!("{:?}", read_guard.get("key"));

// Write — exclusive
let mut write_guard = cache.write().unwrap();
write_guard.insert("key".to_string(), "value".to_string());
```

**⚠️ Deadlock Risk Pattern:**
```rust
// NGUY HIỂM: giữ lock qua .await
let guard = mutex.lock().unwrap();
some_async_fn().await; // lock vẫn held trong khi task yield!
// Dùng tokio::sync::Mutex thay vì std::sync::Mutex nếu cần .await trong lock
```

**Tokio Mutex vs Std Mutex:**
- `std::sync::Mutex` → dùng cho sync code, non-async sections
- `tokio::sync::Mutex` → dùng khi cần giữ lock qua `.await`

---

## 5. `RefCell<T>` — Interior Mutability (Single-thread)

```rust
use std::cell::RefCell;

// Khi bạn cần mutate qua immutable reference — checked at runtime
let data = RefCell::new(vec![1, 2, 3]);

// Nhiều immutable borrows
let r1 = data.borrow();
let r2 = data.borrow();

// Mutable borrow — sẽ panic nếu có borrow khác đang active
drop(r1); drop(r2);
data.borrow_mut().push(4);
```

**Trong web apps:** Ít dùng `RefCell` trực tiếp. Thường gặp trong testing và một số internal patterns. Prefer `Mutex`/`RwLock` cho shared state.

---

## PHẦN 2 — ERROR DESIGN

## 6. Tại Sao Cần Error Design Riêng

```rust
// Naive: Box<dyn Error> — nhanh nhưng mất type information
async fn handler() -> Result<Json<User>, Box<dyn std::error::Error>> { ... }

// Problem: caller không biết loại lỗi là gì để handle
// Axum cũng không biết trả về HTTP status code nào
```

**Cần:** Typed errors với automatic conversion + HTTP response mapping.

---

## 7. `thiserror` — Custom Error Types

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("User not found: {id}")]
    UserNotFound { id: i64 },
    
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),  // tự động From<sqlx::Error>
    
    #[error("Invalid input: {0}")]
    Validation(String),
    
    #[error("Unauthorized")]
    Unauthorized,
    
    #[error("External service error: {service} — {message}")]
    ExternalService { service: String, message: String },
}
```

**`#[from]`** tự generate `impl From<sqlx::Error> for AppError` — điều này cho phép dùng `?` operator tự động convert:

```rust
async fn get_user(pool: &PgPool, id: i64) -> Result<User, AppError> {
    let user = sqlx::query_as!(User, "SELECT * FROM users WHERE id = $1", id)
        .fetch_one(pool)
        .await?;  // sqlx::Error → AppError::Database tự động
    Ok(user)
}
```

---

## 8. `anyhow` — Cho Application-level Code

```rust
use anyhow::{Context, Result};

// anyhow::Result = Result<T, anyhow::Error>
async fn startup() -> anyhow::Result<()> {
    let config = Config::load()
        .context("Failed to load configuration")?;
    
    let pool = PgPool::connect(&config.db_url)
        .await
        .context("Failed to connect to database")?;
    
    Ok(())
}
```

**Khi nào dùng cái nào:**
- `thiserror` → Library code, service layer, bất kỳ code nào mà caller cần match error type
- `anyhow` → `main()`, startup code, scripts, tests — nơi chỉ cần log lỗi

---

## 9. Axum Error Response — Kết Hợp Tất Cả

```rust
use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde_json::json;

// Implement IntoResponse cho AppError → HTTP response
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::UserNotFound { id } => (
                StatusCode::NOT_FOUND,
                format!("User {} not found", id),
            ),
            AppError::Database(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Database error".to_string(),
            ),
            AppError::Validation(msg) => (
                StatusCode::BAD_REQUEST,
                msg.clone(),
            ),
            AppError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "Unauthorized".to_string(),
            ),
            AppError::ExternalService { service, .. } => (
                StatusCode::BAD_GATEWAY,
                format!("External service {} unavailable", service),
            ),
        };
        
        (status, Json(json!({ "error": message }))).into_response()
    }
}

// Kết quả: handler trở nên clean
async fn get_user_handler(
    State(pool): State<PgPool>,
    Path(id): Path<i64>,
) -> Result<Json<User>, AppError> {
    let user = get_user(&pool, id).await?; // AppError propagates → HTTP response
    Ok(Json(user))
}
```

**Java analog:** Toàn bộ pattern này tương đương `@ControllerAdvice` + `@ExceptionHandler` trong Spring, nhưng type-safe và không dùng reflection.

---

## 10. Error Handling Decision Tree

```
Bạn đang viết...
│
├─ Library / Service layer
│   → dùng thiserror, define AppError enum
│   → implement From<> cho external errors
│
├─ Handler / Controller
│   → Result<Json<T>, AppError>
│   → ? operator propagate
│   → AppError implements IntoResponse
│
├─ main() / startup
│   → anyhow::Result<()>
│   → .context("...") để add context
│
└─ Tests
    → unwrap() hoặc anyhow::Result, không cần fancy
```

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-2-Borrowing-Multi-threading|Bài 2: Arc & Mutex cơ bản]]
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9: Async & Tokio]] — dùng tokio::sync::Mutex
- [[Rust-Zero-To-Hero/Bai-11-Axum-Middleware-Error|Bài 11: Axum Error Response]]
- [[MOC-Concurrency]]

---
*Bài tập:*
1. Tạo `AppError` enum với ít nhất 4 variants dùng `thiserror`. Implement `IntoResponse` map sang HTTP status codes phù hợp.
2. Viết `Arc<RwLock<HashMap<String, User>>>` làm in-memory cache, implement `get(id)` và `set(id, user)` methods. Đảm bảo không giữ lock qua `.await`.
3. Viết function chain dùng `?` operator qua ít nhất 3 error types khác nhau, tất cả convert vào cùng một `AppError`.
