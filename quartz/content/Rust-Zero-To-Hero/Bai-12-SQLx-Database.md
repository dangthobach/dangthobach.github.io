# Bài 12: SQLx — Type-safe Database Layer

---

## 1. SQLx vs JPA — Triết lý Khác Nhau

| | JPA/Hibernate | SQLx |
|---|---|---|
| Query style | JPQL / method names | Raw SQL (bạn viết SQL thật) |
| Type check | Runtime | **Compile-time** (query! macro) |
| N+1 | Dễ xảy ra với LAZY | Explicit — bạn phải viết JOIN |
| Magic | Nhiều (proxy, session) | Ít — predictable |
| Migration | Flyway/Liquibase | sqlx migrate (built-in) |

**Tư duy:** SQLx giống `JdbcTemplate` nhưng async + type-safe tại compile time.

---

## 2. Setup

```toml
[dependencies]
sqlx = { version = "0.7", features = ["postgres", "runtime-tokio", "macros", "migrate", "uuid", "chrono"] }
```

```rust
use sqlx::PgPool;

pub async fn create_pool(database_url: &str) -> PgPool {
    PgPool::connect(database_url)
        .await
        .expect("Failed to connect to database")
}

// Hoặc với options
let pool = sqlx::postgres::PgPoolOptions::new()
    .max_connections(20)
    .min_connections(5)
    .acquire_timeout(Duration::from_secs(3))
    .connect(database_url)
    .await?;
```

---

## 3. `query!` Macro — Compile-time Checked

```rust
// LƯU Ý: cần DATABASE_URL env var lúc compile để macro verify SQL
// Thêm .env file với DATABASE_URL=postgres://...

// query! trả về anonymous struct — không cần define struct trước
let row = sqlx::query!(
    "SELECT id, name, email FROM users WHERE id = $1",
    user_id
)
.fetch_one(&pool)
.await?;

println!("{}: {}", row.id, row.name); // type-safe fields
```

---

## 4. `query_as!` — Map Vào Struct

```rust
#[derive(Debug, sqlx::FromRow)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub email: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

// fetch_one — trả về 1, lỗi nếu không tìm thấy
let user = sqlx::query_as!(User,
    "SELECT id, name, email, created_at FROM users WHERE id = $1",
    user_id
)
.fetch_one(&pool)
.await?; // sqlx::Error::RowNotFound nếu không có

// fetch_optional — trả về Option<User>
let user = sqlx::query_as!(User,
    "SELECT id, name, email, created_at FROM users WHERE email = $1",
    email
)
.fetch_optional(&pool)
.await?;

// fetch_all — trả về Vec<User>
let users = sqlx::query_as!(User,
    "SELECT id, name, email, created_at FROM users ORDER BY created_at DESC LIMIT $1",
    limit
)
.fetch_all(&pool)
.await?;
```

---

## 5. Insert / Update / Delete

```rust
// Insert với RETURNING — lấy lại row vừa insert
let user = sqlx::query_as!(User,
    r#"
    INSERT INTO users (name, email, created_at)
    VALUES ($1, $2, NOW())
    RETURNING id, name, email, created_at
    "#,
    dto.name,
    dto.email
)
.fetch_one(&pool)
.await?;

// Update
let updated = sqlx::query_as!(User,
    r#"
    UPDATE users SET name = $1 WHERE id = $2
    RETURNING id, name, email, created_at
    "#,
    dto.name,
    user_id
)
.fetch_optional(&pool) // None nếu id không tồn tại
.await?
.ok_or(AppError::NotFound(format!("User {} not found", user_id)))?;

// Delete
let result = sqlx::query!(
    "DELETE FROM users WHERE id = $1",
    user_id
)
.execute(&pool)
.await?;

if result.rows_affected() == 0 {
    return Err(AppError::NotFound(...));
}
```

---

## 6. Transactions

```rust
// Transaction tự rollback nếu không commit
async fn transfer_funds(
    pool: &PgPool,
    from_id: i64,
    to_id: i64,
    amount: i64,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    
    // Debit
    sqlx::query!(
        "UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1",
        amount, from_id
    )
    .execute(&mut *tx)
    .await?;
    
    // Credit
    sqlx::query!(
        "UPDATE accounts SET balance = balance + $1 WHERE id = $2",
        amount, to_id
    )
    .execute(&mut *tx)
    .await?;
    
    tx.commit().await?; // nếu không reach đây → auto rollback
    Ok(())
}
```

---

## 7. Migrations

```bash
# Install sqlx-cli
cargo install sqlx-cli --no-default-features --features postgres

# Tạo migration
sqlx migrate add create_users_table

# Thư mục migrations/ được tạo:
# migrations/20240101000000_create_users_table.sql
```

```sql
-- migrations/20240101000000_create_users_table.sql
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
```

```rust
// Chạy migrations lúc startup
sqlx::migrate!("./migrations")
    .run(&pool)
    .await
    .expect("Failed to run migrations");
```

---

## 8. Repository Pattern

```rust
pub struct UserRepository {
    pool: PgPool,
}

impl UserRepository {
    pub fn new(pool: PgPool) -> Self { Self { pool } }

    pub async fn find_by_id(&self, id: i64) -> Result<Option<User>, AppError> {
        sqlx::query_as!(User,
            "SELECT id, name, email, created_at FROM users WHERE id = $1",
            id
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::Database)
    }

    pub async fn find_all(&self, page: i64, size: i64) -> Result<Vec<User>, AppError> {
        sqlx::query_as!(User,
            "SELECT id, name, email, created_at FROM users ORDER BY id LIMIT $1 OFFSET $2",
            size,
            (page - 1) * size
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::Database)
    }

    pub async fn create(&self, dto: CreateUserDto) -> Result<User, AppError> {
        sqlx::query_as!(User,
            r#"INSERT INTO users (name, email, created_at)
               VALUES ($1, $2, NOW())
               RETURNING id, name, email, created_at"#,
            dto.name, dto.email
        )
        .fetch_one(&self.pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db_err) if db_err.is_unique_violation() => {
                AppError::BadRequest("Email already exists".to_string())
            }
            other => AppError::Database(other),
        })
    }
}

// Trong AppState
#[derive(Clone)]
struct AppState {
    users: Arc<UserRepository>,
    // PgPool implements Clone (Arc internally), có thể pass trực tiếp
}
```

---

## 9. Testing với SQLx

```rust
// sqlx::test tự tạo isolated database per test, rollback sau khi test xong
#[sqlx::test(migrations = "./migrations")]
async fn test_create_user(pool: PgPool) {
    let repo = UserRepository::new(pool);
    
    let dto = CreateUserDto {
        name: "Alice".to_string(),
        email: "alice@test.com".to_string(),
    };
    
    let user = repo.create(dto).await.unwrap();
    assert_eq!(user.name, "Alice");
    assert!(user.id > 0);
}
```

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-10-Axum-Core|Bài 10: State integration]]
- [[Rust-Zero-To-Hero/Bai-8-Smart-Pointers-Error-Design|Bài 8: AppError từ sqlx::Error]]
- [[MOC-Database]]
- [[MOC-PDMS]] — applied cho PDMS queries
