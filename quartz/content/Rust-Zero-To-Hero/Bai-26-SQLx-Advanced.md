# Bài 26: SQLx Advanced — Compile-time SQL, Custom Types, Bulk Ops & Testing

> **Prerequisite:** Bài 12 (SQLx Basics)  
> **Mục tiêu:** Master toàn bộ SQLx feature set — type system, bulk operations, migrations, isolated testing, và query patterns cho high-throughput như PDMS

---

## 🗺️ Bức Tranh Tổng Quan

```
SQLx Architecture:

  ┌──────────────────────────────────────────────────────────────┐
  │                     Your Rust Code                          │
  │                                                              │
  │  sqlx::query!("SELECT ...")   ←── compile time: SQL check   │
  │  sqlx::query_as!("...", T)    ←── type inference: row → T   │
  │  sqlx::query_scalar!(...)     ←── single value extraction    │
  └───────────────────────┬──────────────────────────────────────┘
                          │
              ┌───────────▼───────────┐
              │       PgPool          │  connection pool (r2d2 equivalent)
              │  max_connections: 20  │  async-aware
              │  min_connections: 2   │  auto-reconnect
              └───────────┬───────────┘
                          │
              ┌───────────▼───────────┐
              │   PostgreSQL Server   │
              └───────────────────────┘

Compile-time verification flow:
  cargo build
       │
       ▼  sqlx::query!() macro
  Connect to DATABASE_URL (hoặc đọc .sqlx/ cache)
       │
       ▼  Send query to PostgreSQL
  Verify SQL syntax + table/column existence + types
       │
       ▼  Generate Rust types matching DB schema
  Embed type info into compiled code
  
Java analog: jOOQ (compile-time type-safe SQL) — nhưng native trong Rust
```

---

## PHẦN 1 — Compile-time Query Verification Deep Dive

### 1.1 Three Query Macros

```rust
use sqlx::PgPool;

// query! — trả về anonymous struct với field names từ SQL
let row = sqlx::query!(
    "SELECT id, name, email, created_at FROM users WHERE id = $1",
    user_id
)
.fetch_one(&pool)
.await?;

// Compiler biết exact types:
println!("{}", row.id);         // i64
println!("{}", row.name);       // String
println!("{}", row.email);      // String
println!("{}", row.created_at); // DateTime<Utc> (nếu dùng sqlx feature chrono)

// query_as! — map vào named struct
#[derive(Debug, sqlx::FromRow)]
struct User {
    id: i64,
    name: String,
    email: String,
    created_at: chrono::DateTime<chrono::Utc>,
}

let user = sqlx::query_as!(User,
    "SELECT id, name, email, created_at FROM users WHERE id = $1",
    user_id
)
.fetch_one(&pool)
.await?;

// query_scalar! — single value
let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM users")
    .fetch_one(&pool)
    .await?
    .unwrap_or(0);

let exists: bool = sqlx::query_scalar!(
    "SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)",
    email
)
.fetch_one(&pool)
.await?
.unwrap_or(false);
```

### 1.2 Fetch Methods

```rust
// fetch_one — đúng 1 row, lỗi nếu 0 hoặc nhiều hơn
let user = sqlx::query_as!(User, "SELECT ... WHERE id = $1", id)
    .fetch_one(&pool).await?;

// fetch_optional — 0 hoặc 1 row
let user: Option<User> = sqlx::query_as!(User, "SELECT ... WHERE id = $1", id)
    .fetch_optional(&pool).await?;

// fetch_all — tất cả rows vào Vec
let users: Vec<User> = sqlx::query_as!(User, "SELECT ...")
    .fetch_all(&pool).await?;

// fetch — Stream (cho large result sets, không load vào RAM)
use futures_util::StreamExt;

let mut stream = sqlx::query_as!(User, "SELECT ...")
    .fetch(&pool);

while let Some(result) = stream.next().await {
    let user = result?; // process từng row
    process_user(user).await;
}
```

### 1.3 Offline Mode — CI/CD

```bash
# Generate .sqlx/ cache directory (offline verification)
# Yêu cầu DATABASE_URL accessible
cargo sqlx prepare

# Kết quả: .sqlx/query-*.json files
# Commit .sqlx/ vào git → CI không cần DB

# Trong CI:
SQLX_OFFLINE=true cargo build
SQLX_OFFLINE=true cargo test
```

---

## PHẦN 2 — Custom Types

### 2.1 PostgreSQL Enum → Rust Enum

```sql
-- Migration
CREATE TYPE user_status AS ENUM ('active', 'inactive', 'suspended');
CREATE TYPE document_category AS ENUM ('contract', 'invoice', 'report', 'other');

ALTER TABLE users ADD COLUMN status user_status NOT NULL DEFAULT 'active';
ALTER TABLE documents ADD COLUMN category document_category NOT NULL;
```

```rust
// Derive sqlx::Type cho enum
#[derive(Debug, Clone, PartialEq, sqlx::Type, serde::Serialize, serde::Deserialize)]
#[sqlx(type_name = "user_status", rename_all = "lowercase")]
pub enum UserStatus {
    Active,
    Inactive,
    Suspended,
}

#[derive(Debug, Clone, sqlx::Type, serde::Serialize, serde::Deserialize)]
#[sqlx(type_name = "document_category", rename_all = "lowercase")]
pub enum DocumentCategory {
    Contract,
    Invoice,
    Report,
    Other,
}

// Dùng trong queries — type-safe!
let active_users = sqlx::query_as!(User,
    r#"SELECT id, name, email, status AS "status: UserStatus"
       FROM users WHERE status = $1"#,
    UserStatus::Active as UserStatus  // type annotation bắt buộc với custom types
)
.fetch_all(&pool)
.await?;
```

### 2.2 JSONB Fields

```rust
use serde::{Deserialize, Serialize};

// Struct cho JSONB column
#[derive(Debug, Serialize, Deserialize)]
pub struct DocumentMetadata {
    pub tags: Vec<String>,
    pub source: String,
    pub version: u32,
    pub custom_fields: std::collections::HashMap<String, serde_json::Value>,
}

// Dùng sqlx::types::Json wrapper
use sqlx::types::Json;

#[derive(Debug, sqlx::FromRow)]
pub struct Document {
    pub id: i64,
    pub title: String,
    pub metadata: Json<DocumentMetadata>,   // JSONB column
}

// Query JSONB
let doc = sqlx::query_as!(Document,
    r#"SELECT id, title, metadata as "metadata: Json<DocumentMetadata>"
       FROM documents WHERE id = $1"#,
    doc_id
)
.fetch_one(&pool)
.await?;

println!("Tags: {:?}", doc.metadata.tags);

// UPDATE JSONB
let new_metadata = DocumentMetadata {
    tags: vec!["urgent".to_string(), "q4".to_string()],
    source: "upload".to_string(),
    version: 2,
    custom_fields: Default::default(),
};

sqlx::query!(
    "UPDATE documents SET metadata = $1 WHERE id = $2",
    serde_json::to_value(&new_metadata).unwrap(),
    doc_id
)
.execute(&pool)
.await?;

// JSONB operator trong WHERE clause
let tagged = sqlx::query_as!(Document,
    r#"SELECT id, title, metadata as "metadata: Json<DocumentMetadata>"
       FROM documents
       WHERE metadata @> $1"#,  // @> = contains
    serde_json::json!({"tags": ["urgent"]})
)
.fetch_all(&pool)
.await?;
```

### 2.3 UUID Column

```rust
use uuid::Uuid;

// UUID primary key
#[derive(Debug, sqlx::FromRow)]
pub struct ApiKey {
    pub id: Uuid,
    pub user_id: i64,
    pub key_hash: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

// INSERT với UUID
let key_id = Uuid::new_v4();

sqlx::query!(
    "INSERT INTO api_keys (id, user_id, key_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')",
    key_id, user_id, key_hash
)
.execute(&pool)
.await?;

// SELECT
let key = sqlx::query_as!(ApiKey,
    "SELECT id, user_id, key_hash, expires_at FROM api_keys WHERE id = $1",
    key_id
)
.fetch_one(&pool)
.await?;
```

### 2.4 Decimal / Numeric (Financial Data)

```rust
// Dùng bigdecimal hoặc rust_decimal cho NUMERIC column
// Cargo.toml: sqlx = { features = ["rust_decimal"] }

use rust_decimal::Decimal;
use rust_decimal_macros::dec;

#[derive(Debug, sqlx::FromRow)]
pub struct Account {
    pub id: i64,
    pub balance: Decimal,     // NUMERIC column
    pub credit_limit: Decimal,
}

let account = sqlx::query_as!(Account,
    "SELECT id, balance, credit_limit FROM accounts WHERE id = $1",
    account_id
)
.fetch_one(&pool)
.await?;

// Precision-safe arithmetic
let new_balance = account.balance + dec!(1000.50);

sqlx::query!(
    "UPDATE accounts SET balance = $1 WHERE id = $2",
    new_balance, account_id
)
.execute(&pool)
.await?;
```

---

## PHẦN 3 — Transaction Patterns

### 3.1 Basic Transaction

```rust
pub async fn transfer_funds(
    pool: &PgPool,
    from_id: i64,
    to_id: i64,
    amount: rust_decimal::Decimal,
) -> Result<(), AppError> {
    // begin() → lấy connection từ pool, bắt đầu transaction
    let mut tx = pool.begin().await?;

    // Deduct from sender (lock row với FOR UPDATE)
    let sender = sqlx::query!(
        "SELECT balance FROM accounts WHERE id = $1 FOR UPDATE",
        from_id
    )
    .fetch_optional(&mut *tx)  // lưu ý: &mut *tx (deref transaction)
    .await?
    .ok_or(AppError::NotFound)?;

    if sender.balance < amount {
        // tx.rollback() được gọi tự động khi tx drop (không commit)
        return Err(AppError::InsufficientFunds);
    }

    // Deduct
    sqlx::query!(
        "UPDATE accounts SET balance = balance - $1, updated_at = NOW() WHERE id = $2",
        amount, from_id
    )
    .execute(&mut *tx)
    .await?;

    // Credit
    sqlx::query!(
        "UPDATE accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2",
        amount, to_id
    )
    .execute(&mut *tx)
    .await?;

    // Insert audit record
    sqlx::query!(
        "INSERT INTO transfers (from_id, to_id, amount, created_at)
         VALUES ($1, $2, $3, NOW())",
        from_id, to_id, amount
    )
    .execute(&mut *tx)
    .await?;

    // Commit — nếu không gọi, tx drop sẽ rollback
    tx.commit().await?;

    Ok(())
}
```

### 3.2 Savepoint (Nested Transaction)

```rust
pub async fn import_with_partial_success(
    pool: &PgPool,
    records: Vec<ImportRecord>,
) -> Result<ImportResult, AppError> {
    let mut tx = pool.begin().await?;
    let mut success = 0;
    let mut failed = 0;
    let mut errors = Vec::new();

    for (i, record) in records.iter().enumerate() {
        // Savepoint cho từng record — có thể rollback từng cái riêng lẻ
        let savepoint = tx.begin().await?;  // nested transaction = SAVEPOINT

        let result = sqlx::query!(
            "INSERT INTO documents (title, content, category) VALUES ($1, $2, $3)",
            record.title, record.content, record.category
        )
        .execute(&mut *savepoint)
        .await;

        match result {
            Ok(_) => {
                savepoint.commit().await?;  // RELEASE SAVEPOINT
                success += 1;
            }
            Err(e) => {
                savepoint.rollback().await?;  // ROLLBACK TO SAVEPOINT
                failed += 1;
                errors.push(format!("Record {}: {}", i, e));
            }
        }
    }

    // Commit outer transaction — successful records được giữ
    tx.commit().await?;

    Ok(ImportResult { success, failed, errors })
}
```

### 3.3 Transaction Trong Axum Handler

```rust
// Pattern: Pool trong State, transaction trong handler
async fn create_user_with_profile(
    State(state): State<AppState>,
    Json(dto): Json<CreateUserWithProfileDto>,
) -> Result<Json<UserResponse>, AppError> {
    let mut tx = state.db.begin().await?;

    let user = sqlx::query_as!(
        UserRow,
        "INSERT INTO users (name, email) VALUES ($1, $2)
         RETURNING id, name, email, created_at",
        dto.name, dto.email
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") {
            AppError::Conflict("Email already exists".into())
        } else {
            AppError::Database(e)
        }
    })?;

    sqlx::query!(
        "INSERT INTO profiles (user_id, bio, avatar_url) VALUES ($1, $2, $3)",
        user.id, dto.bio, dto.avatar_url
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(UserResponse::from(user)))
}
```

---

## PHẦN 4 — Bulk Operations (PDMS Scale)

### 4.1 UNNEST Bulk Insert — Cách Nhanh Nhất

```
Approach comparison for 10,000 rows:

  Row-by-row INSERT:        ~5000ms (10k round trips)
  Multi-row VALUES:         ~200ms  (1 round trip, large query)
  UNNEST (array):           ~80ms   (1 round trip, compact query)
  COPY FROM:                ~30ms   (binary protocol, fastest)
```

```rust
pub async fn bulk_insert_users(
    pool: &PgPool,
    users: Vec<NewUser>,
) -> Result<u64, sqlx::Error> {
    if users.is_empty() {
        return Ok(0);
    }

    // Tách thành arrays của từng column
    let names: Vec<&str> = users.iter().map(|u| u.name.as_str()).collect();
    let emails: Vec<&str> = users.iter().map(|u| u.email.as_str()).collect();
    let roles: Vec<&str> = users.iter().map(|u| u.role.as_str()).collect();

    let result = sqlx::query!(
        r#"
        INSERT INTO users (name, email, role, created_at, updated_at)
        SELECT name, email, role, NOW(), NOW()
        FROM UNNEST($1::text[], $2::text[], $3::text[]) AS t(name, email, role)
        ON CONFLICT (email) DO NOTHING
        "#,
        &names[..],
        &emails[..],
        &roles[..],
    )
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}

// Bulk insert với RETURNING
pub async fn bulk_insert_and_return(
    pool: &PgPool,
    users: Vec<NewUser>,
) -> Result<Vec<User>, sqlx::Error> {
    let names: Vec<&str> = users.iter().map(|u| u.name.as_str()).collect();
    let emails: Vec<&str> = users.iter().map(|u| u.email.as_str()).collect();

    sqlx::query_as!(User,
        r#"
        INSERT INTO users (name, email, created_at)
        SELECT name, email, NOW()
        FROM UNNEST($1::text[], $2::text[]) AS t(name, email)
        RETURNING id, name, email, created_at
        "#,
        &names[..], &emails[..]
    )
    .fetch_all(pool)
    .await
}
```

### 4.2 Bulk Insert với Chunking

```rust
// Chia thành chunks để tránh parameter limit (~65535 params)
const CHUNK_SIZE: usize = 1000;  // 1000 rows * N columns < 65535

pub async fn bulk_insert_chunked(
    pool: &PgPool,
    records: Vec<DocumentRecord>,
) -> Result<u64, AppError> {
    let mut total_inserted = 0u64;

    for chunk in records.chunks(CHUNK_SIZE) {
        let titles: Vec<&str> = chunk.iter().map(|r| r.title.as_str()).collect();
        let contents: Vec<&str> = chunk.iter().map(|r| r.content.as_str()).collect();
        let categories: Vec<&str> = chunk.iter().map(|r| r.category.as_str()).collect();

        let result = sqlx::query!(
            "INSERT INTO documents (title, content, category, created_at)
             SELECT title, content, category::document_category, NOW()
             FROM UNNEST($1::text[], $2::text[], $3::text[]) AS t(title, content, category)",
            &titles[..], &contents[..], &categories[..]
        )
        .execute(pool)
        .await?;

        total_inserted += result.rows_affected();
        tracing::debug!("Inserted chunk: {}/{}", total_inserted, records.len());
    }

    Ok(total_inserted)
}
```

### 4.3 Bulk Update với UNNEST

```rust
pub async fn bulk_update_status(
    pool: &PgPool,
    updates: Vec<(i64, String)>,  // (id, new_status)
) -> Result<u64, sqlx::Error> {
    let ids: Vec<i64> = updates.iter().map(|(id, _)| *id).collect();
    let statuses: Vec<&str> = updates.iter().map(|(_, s)| s.as_str()).collect();

    let result = sqlx::query!(
        r#"
        UPDATE documents d
        SET status = t.status::document_status, updated_at = NOW()
        FROM UNNEST($1::bigint[], $2::text[]) AS t(id, status)
        WHERE d.id = t.id
        "#,
        &ids[..], &statuses[..]
    )
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}
```

### 4.4 COPY FROM — Fastest Bulk Insert

```rust
// Chỉ dùng cho PostgreSQL, binary protocol → nhanh nhất
// Dùng khi import 100K+ records

use tokio::io::AsyncWriteExt;

pub async fn bulk_copy_users(
    pool: &PgPool,
    users: Vec<NewUser>,
) -> Result<u64, Box<dyn std::error::Error>> {
    let mut conn = pool.acquire().await?;

    // Bắt đầu COPY
    let mut copy = conn.copy_in_raw(
        "COPY users (name, email, role, created_at) FROM STDIN WITH (FORMAT CSV)"
    ).await?;

    // Write CSV data
    for user in &users {
        let line = format!(
            "{},{},{},{}\n",
            user.name.replace(',', "\\,"),
            user.email.replace(',', "\\,"),
            user.role,
            chrono::Utc::now().to_rfc3339()
        );
        copy.write_all(line.as_bytes()).await?;
    }

    // Finish COPY — trả về số rows
    let rows = copy.finish().await?;

    Ok(rows)
}
```

---

## PHẦN 5 — Dynamic Queries

### 5.1 Query Builder Pattern

```rust
// Khi cần build WHERE clause động (search, filter)
// query! macro không support dynamic SQL → dùng QueryBuilder

use sqlx::QueryBuilder;

pub async fn search_documents(
    pool: &PgPool,
    params: SearchParams,
) -> Result<Vec<Document>, sqlx::Error> {
    let mut builder = QueryBuilder::new(
        "SELECT id, title, category, status, created_at FROM documents WHERE 1=1"
    );

    if let Some(category) = &params.category {
        builder.push(" AND category = ");
        builder.push_bind(category);
    }

    if let Some(status) = &params.status {
        builder.push(" AND status = ");
        builder.push_bind(status);
    }

    if let Some(search) = &params.search {
        builder.push(" AND (title ILIKE ");
        builder.push_bind(format!("%{}%", search));
        builder.push(" OR content ILIKE ");
        builder.push_bind(format!("%{}%", search));
        builder.push(")");
    }

    if let Some(from) = params.created_after {
        builder.push(" AND created_at >= ");
        builder.push_bind(from);
    }

    builder.push(" ORDER BY ");
    match params.sort_by.as_deref() {
        Some("title") => builder.push("title ASC"),
        Some("created_at_asc") => builder.push("created_at ASC"),
        _ => builder.push("created_at DESC"),
    };

    builder.push(" LIMIT ");
    builder.push_bind(params.size.unwrap_or(20) as i64);
    builder.push(" OFFSET ");
    builder.push_bind(
        ((params.page.unwrap_or(1) - 1) * params.size.unwrap_or(20)) as i64
    );

    let query = builder.build_query_as::<Document>();
    query.fetch_all(pool).await
}
```

---

## PHẦN 6 — Connection Pool Tuning

### 6.1 Pool Configuration

```rust
use sqlx::postgres::{PgPoolOptions, PgConnectOptions};
use std::time::Duration;

// Production pool setup
let pool = PgPoolOptions::new()
    .max_connections(20)            // max concurrent connections
    .min_connections(5)             // keep-alive connections
    .acquire_timeout(Duration::from_secs(3))      // fail fast nếu pool full
    .idle_timeout(Duration::from_secs(600))       // close idle connections
    .max_lifetime(Duration::from_secs(1800))      // recycle connections sau 30 phút
    .test_before_acquire(true)      // ping trước khi dùng (detect stale connections)
    .connect_with(
        PgConnectOptions::new()
            .host("localhost")
            .port(5432)
            .database("pdms_db")
            .username("pdms_user")
            .password("secret")
            .ssl_mode(sqlx::postgres::PgSslMode::Require)
            .statement_cache_capacity(100)  // prepared statement cache
    )
    .await?;
```

### 6.2 Pool Health Monitoring

```rust
// Monitor pool metrics
async fn pool_health_handler(State(pool): State<PgPool>) -> impl IntoResponse {
    let pool_size = pool.size();
    let idle = pool.num_idle();

    Json(serde_json::json!({
        "pool_size": pool_size,
        "idle_connections": idle,
        "active_connections": pool_size - idle as u32,
        "is_closed": pool.is_closed()
    }))
}
```

---

## PHẦN 7 — sqlx::test — Isolated Database Testing

### 7.1 Test Setup

```toml
# Cargo.toml
[dev-dependencies]
sqlx = { version = "0.7", features = ["postgres", "runtime-tokio", "macros", "migrate"] }
tokio = { version = "1", features = ["full"] }
```

### 7.2 Basic sqlx::test

```rust
// Mỗi test nhận PgPool riêng biệt (separate database hoặc isolated transaction)
// Migrations tự động chạy
// Sau test: cleanup tự động

#[sqlx::test]
async fn test_create_user(pool: PgPool) {
    // INSERT
    let user = sqlx::query_as!(User,
        "INSERT INTO users (name, email, role, created_at)
         VALUES ($1, $2, $3, NOW())
         RETURNING id, name, email, role, created_at",
        "Test User", "test@example.com", "user"
    )
    .fetch_one(&pool)
    .await
    .expect("Insert failed");

    assert_eq!(user.name, "Test User");
    assert_eq!(user.email, "test@example.com");
    assert!(user.id > 0);
}

#[sqlx::test]
async fn test_unique_email_constraint(pool: PgPool) {
    // Insert first user
    sqlx::query!("INSERT INTO users (name, email) VALUES ($1, $2)",
        "User 1", "same@email.com")
        .execute(&pool).await.unwrap();

    // Insert duplicate → phải fail
    let result = sqlx::query!("INSERT INTO users (name, email) VALUES ($1, $2)",
        "User 2", "same@email.com")
        .execute(&pool).await;

    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.to_string().contains("unique") || err.to_string().contains("duplicate"));
}
```

### 7.3 Fixtures — Seed Data

```sql
-- tests/fixtures/users.sql
INSERT INTO users (id, name, email, role, created_at) VALUES
    (1, 'Admin Bach', 'bach@vpbank.com', 'admin', NOW()),
    (2, 'User Minh', 'minh@vpbank.com', 'user', NOW()),
    (3, 'Viewer Lan', 'lan@vpbank.com', 'viewer', NOW());

-- tests/fixtures/documents.sql
INSERT INTO documents (id, title, category, created_by, created_at) VALUES
    (1, 'Contract Q4 2024', 'contract', 1, NOW()),
    (2, 'Invoice #001', 'invoice', 2, NOW()),
    (3, 'Annual Report', 'report', 1, NOW());
```

```rust
// Dùng fixtures trong test
#[sqlx::test(fixtures("users", "documents"))]
async fn test_get_documents_by_user(pool: PgPool) {
    // Fixtures đã được load: 3 users, 3 documents

    let docs = sqlx::query!(
        "SELECT d.id, d.title FROM documents d
         JOIN users u ON d.created_by = u.id
         WHERE u.role = 'admin'"
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(docs.len(), 2); // user 1 (admin) tạo 2 documents
}
```

### 7.4 Test Repository Pattern

```rust
// Repository trait để dễ test + mock
#[async_trait::async_trait]
pub trait UserRepository: Send + Sync {
    async fn find_by_id(&self, id: i64) -> Result<Option<User>, sqlx::Error>;
    async fn create(&self, dto: NewUser) -> Result<User, sqlx::Error>;
    async fn update(&self, id: i64, dto: UpdateUser) -> Result<Option<User>, sqlx::Error>;
    async fn delete(&self, id: i64) -> Result<bool, sqlx::Error>;
    async fn find_all(&self, page: u32, size: u32) -> Result<Vec<User>, sqlx::Error>;
}

// Concrete implementation
pub struct PgUserRepository {
    pool: PgPool,
}

#[async_trait::async_trait]
impl UserRepository for PgUserRepository {
    async fn find_by_id(&self, id: i64) -> Result<Option<User>, sqlx::Error> {
        sqlx::query_as!(User, "SELECT * FROM users WHERE id = $1", id)
            .fetch_optional(&self.pool)
            .await
    }
    // ... other methods
}

// Test implementation
#[sqlx::test(fixtures("users"))]
async fn test_user_repository(pool: PgPool) {
    let repo = PgUserRepository { pool };

    // find existing
    let user = repo.find_by_id(1).await.unwrap();
    assert!(user.is_some());
    assert_eq!(user.unwrap().email, "bach@vpbank.com");

    // find non-existing
    let missing = repo.find_by_id(99999).await.unwrap();
    assert!(missing.is_none());
}
```

---

## PHẦN 8 — Migrations

### 8.1 Migration Files

```bash
# Tạo migration
sqlx migrate add create_users
sqlx migrate add add_status_to_users
sqlx migrate add create_documents
sqlx migrate add add_category_enum

# Kết quả:
# migrations/
#   20240101000001_create_users.sql
#   20240101000002_add_status_to_users.sql
#   20240101000003_create_documents.sql
```

```sql
-- migrations/20240101000001_create_users.sql
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    role VARCHAR(50) NOT NULL DEFAULT 'user',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_role ON users (role);

-- migrations/20240101000002_add_status_to_users.sql
CREATE TYPE user_status AS ENUM ('active', 'inactive', 'suspended');
ALTER TABLE users ADD COLUMN status user_status NOT NULL DEFAULT 'active';
CREATE INDEX idx_users_status ON users (status);
```

### 8.2 Run Migrations

```rust
// Trong main()
sqlx::migrate!("./migrations")
    .run(&pool)
    .await
    .expect("Migration failed");

// Hoặc run manually
sqlx::migrate!()  // default: migrations/ directory
    .run(&pool)
    .await?;

// Check pending migrations
let pending = sqlx::migrate!().get_unapplied_migrations(&pool).await?;
println!("Pending migrations: {}", pending.len());
```

---

## 🎯 SQLx vs JPA/Hibernate vs jOOQ

```
┌─────────────────────┬──────────────────┬──────────────────┬──────────────────┐
│ Aspect              │ JPA/Hibernate    │ jOOQ             │ SQLx             │
├─────────────────────┼──────────────────┼──────────────────┼──────────────────┤
│ Query type          │ JPQL/HQL (magic) │ Type-safe DSL    │ Raw SQL (checked)│
│ Type safety         │ Runtime          │ Compile-time     │ Compile-time     │
│ N+1 detection       │ No (footgun)     │ Explicit joins   │ Explicit joins   │
│ Async support       │ No (blocking)    │ R2DBC (complex)  │ Native async     │
│ Learning curve      │ High (magic)     │ Medium           │ Low (SQL)        │
│ SQL control         │ Low              │ Medium           │ Full             │
│ Migration           │ Flyway/Liquibase │ Flyway           │ Built-in         │
│ JSONB support       │ Plugin           │ Plugin           │ Native           │
│ Custom types        │ @Type            │ Converter        │ sqlx::Type       │
└─────────────────────┴──────────────────┴──────────────────┴──────────────────┘
```

---

## 🏋️ Bài Tập

1. **Custom Enum Types**: Tạo migration thêm `document_status` enum (draft, pending, approved, rejected). Implement `sqlx::Type` derive. CRUD với enum filter.

2. **Bulk Import**: Implement `bulk_import_documents(Vec<ImportRecord>) -> ImportResult`. Dùng UNNEST, chunk 500 records, return `{success, failed, errors[]}`. Test với 10,000 records.

3. **Dynamic Search**: Implement `search_documents(SearchParams)` với QueryBuilder. Support filter: category, status, date range, full-text search. Return paginated result.

4. **Test Suite**: Viết test suite với `sqlx::test` + fixtures cho Document CRUD. Mỗi test isolated, không ảnh hưởng nhau. Test: create, read, update, delete, bulk insert, search.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-12-SQLx-Database|Bài 12: SQLx Basics]] — prerequisite
- [[Rust-Zero-To-Hero/Bai-28-Tonic-GRPC|Bài 28: Tonic/gRPC]] — prerequisite
- [[Rust-Zero-To-Hero/Bai-27-Diesel|Bài 27: Diesel]] → tiếp theo
