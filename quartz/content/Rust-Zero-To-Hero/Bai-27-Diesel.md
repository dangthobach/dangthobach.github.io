# Bài 27: Diesel — Type-safe ORM, DSL Queries & diesel-async

> **Prerequisite:** Bài 26 (SQLx Advanced) — học Diesel sau SQLx giúp hiểu rõ sự khác biệt  
> **Mục tiêu:** Master Diesel ORM — schema codegen, DSL queries, associations, migrations, và tích hợp async với Axum/ActixWeb

---

## 🗺️ Bức Tranh Tổng Quan

```
Diesel vs SQLx — Triết lý khác nhau:

  SQLx:                           Diesel:
  ┌─────────────────────┐         ┌─────────────────────┐
  │  "Tôi viết SQL,     │         │  "Tôi viết Rust DSL,│
  │   Rust verify type" │         │   Diesel sinh SQL"   │
  └─────────────────────┘         └─────────────────────┘
  
  sqlx::query!("SELECT id,        users::table
    name FROM users                   .filter(users::id.eq(1))
    WHERE id = $1", id)               .select(User::as_select())
                                      .first(&mut conn)

Diesel Architecture:
  ┌──────────────────────────────────────────────────────────┐
  │                   schema.rs (auto-generated)             │
  │  diesel::table! { users (id) { id -> Int8, name -> ... }}│
  └───────────────────────────┬──────────────────────────────┘
                              │ DSL type-checks tại compile time
  ┌───────────────────────────▼──────────────────────────────┐
  │                     Diesel DSL                           │
  │  users::table.filter(id.eq(5)).select(User::as_select()) │
  └───────────────────────────┬──────────────────────────────┘
                              │ generate SQL
  ┌───────────────────────────▼──────────────────────────────┐
  │              SELECT id, name FROM users WHERE id = 5     │
  └───────────────────────────┬──────────────────────────────┘
                              │
  ┌───────────────────────────▼──────────────────────────────┐
  │                  PostgreSQL Server                       │
  └──────────────────────────────────────────────────────────┘

Java analog:
  Diesel ≈ jOOQ (type-safe DSL)
  schema.rs ≈ jOOQ generated tables/records
  #[derive(Queryable)] ≈ @Entity + @Column
```

---

## PHẦN 1 — Setup

### 1.1 Install diesel_cli

```bash
# Install CLI tool (chỉ cần một lần)
cargo install diesel_cli --no-default-features --features postgres

# Hoặc dùng Docker để không cần install libpq
# docker run --rm -v $(pwd):/app -w /app ghcr.io/diesel-rs/diesel:latest diesel setup
```

### 1.2 Dependencies

```toml
[dependencies]
diesel = { version = "2.2", features = ["postgres", "r2d2", "chrono", "uuid", "serde_json"] }
diesel-async = { version = "0.5", features = ["postgres", "deadpool"] }
deadpool = "0.12"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
chrono = { version = "0.4", features = ["serde"] }
uuid = { version = "1", features = ["v4", "serde"] }
dotenvy = "0.15"
thiserror = "1"

[dev-dependencies]
diesel = { version = "2.2", features = ["postgres", "r2d2"] }
```

### 1.3 Project Initialization

```bash
# Tạo .env
echo DATABASE_URL=postgres://user:pass@localhost/pdms_db > .env

# Setup database + tạo diesel.toml
diesel setup
# → Tạo database nếu chưa có
# → Tạo migrations/ folder
# → Tạo diesel.toml

# diesel.toml content:
# [print_schema]
# file = "src/schema.rs"
# custom_type_derives = ["diesel::query_builder::QueryId", "Clone"]
```

---

## PHẦN 2 — Migrations & Schema Generation

### 2.1 Tạo Migrations

```bash
# Tạo migration file
diesel migration generate create_users
diesel migration generate create_documents
diesel migration generate add_metadata_to_documents
```

```sql
-- migrations/2024-01-01-000001_create_users/up.sql
CREATE TYPE user_role AS ENUM ('admin', 'user', 'viewer');
CREATE TYPE user_status AS ENUM ('active', 'inactive', 'suspended');

CREATE TABLE users (
    id         BIGSERIAL     PRIMARY KEY,
    name       VARCHAR(255)  NOT NULL,
    email      VARCHAR(255)  NOT NULL UNIQUE,
    role       user_role     NOT NULL DEFAULT 'user',
    status     user_status   NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email  ON users (email);
CREATE INDEX idx_users_status ON users (status);

-- migrations/2024-01-01-000001_create_users/down.sql
DROP TABLE users;
DROP TYPE user_status;
DROP TYPE user_role;
```

```sql
-- migrations/2024-01-01-000002_create_documents/up.sql
CREATE TYPE document_category AS ENUM ('contract', 'invoice', 'report', 'other');
CREATE TYPE document_status   AS ENUM ('draft', 'pending', 'approved', 'rejected');

CREATE TABLE documents (
    id          BIGSERIAL          PRIMARY KEY,
    title       VARCHAR(500)       NOT NULL,
    content     TEXT,
    category    document_category  NOT NULL DEFAULT 'other',
    status      document_status    NOT NULL DEFAULT 'draft',
    created_by  BIGINT             NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ        NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_documents_created_by ON documents (created_by);
CREATE INDEX idx_documents_status     ON documents (status);
CREATE INDEX idx_documents_category   ON documents (category);
```

```bash
# Áp dụng migrations
diesel migration run

# Tự động update src/schema.rs!
# Xem schema:
diesel print-schema
```

### 2.2 schema.rs — Auto-generated

```rust
// src/schema.rs (DO NOT EDIT MANUALLY — auto-generated by diesel)
// diesel migration run sẽ regenerate file này

diesel::table! {
    use diesel::sql_types::*;
    use super::sql_types::*;

    documents (id) {
        id -> Int8,
        title -> Varchar,
        content -> Nullable<Text>,
        category -> DocumentCategory,
        status -> DocumentStatus,
        created_by -> Int8,
        created_at -> Timestamptz,
        updated_at -> Timestamptz,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use super::sql_types::*;

    users (id) {
        id -> Int8,
        name -> Varchar,
        email -> Varchar,
        role -> UserRole,
        status -> UserStatus,
        created_at -> Timestamptz,
        updated_at -> Timestamptz,
    }
}

// Custom SQL types (enum mapping)
pub mod sql_types {
    #[derive(diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "user_role"))]
    pub struct UserRole;

    #[derive(diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "user_status"))]
    pub struct UserStatus;

    #[derive(diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "document_category"))]
    pub struct DocumentCategory;

    #[derive(diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "document_status"))]
    pub struct DocumentStatus;
}

// Foreign key relationship
diesel::joinable!(documents -> users (created_by));

// Cho phép hai tables xuất hiện trong cùng một query
diesel::allow_tables_to_appear_in_same_query!(documents, users);
```

---

## PHẦN 3 — Models

### 3.1 Queryable — SELECT → Rust Struct

```rust
// src/models/user.rs
use crate::schema::{users, sql_types::*};
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use serde::{Deserialize, Serialize};

// Rust enum mapping PostgreSQL enum
#[derive(Debug, Clone, PartialEq, diesel::AsExpression, diesel::FromSqlRow, Serialize, Deserialize)]
#[diesel(sql_type = UserRole)]
pub enum UserRoleEnum {
    #[serde(rename = "admin")]
    Admin,
    #[serde(rename = "user")]
    User,
    #[serde(rename = "viewer")]
    Viewer,
}

// Implement PostgreSQL enum serialization/deserialization
impl diesel::serialize::ToSql<UserRole, diesel::pg::Pg> for UserRoleEnum {
    fn to_sql<'b>(&'b self, out: &mut diesel::serialize::Output<'b, '_, diesel::pg::Pg>) -> diesel::serialize::Result {
        match *self {
            UserRoleEnum::Admin => out.write_all(b"admin")?,
            UserRoleEnum::User => out.write_all(b"user")?,
            UserRoleEnum::Viewer => out.write_all(b"viewer")?,
        }
        Ok(diesel::serialize::IsNull::No)
    }
}

impl diesel::deserialize::FromSql<UserRole, diesel::pg::Pg> for UserRoleEnum {
    fn from_sql(bytes: diesel::pg::PgValue<'_>) -> diesel::deserialize::Result<Self> {
        match bytes.as_bytes() {
            b"admin" => Ok(UserRoleEnum::Admin),
            b"user" => Ok(UserRoleEnum::User),
            b"viewer" => Ok(UserRoleEnum::Viewer),
            v => Err(format!("Unknown role: {:?}", v).into()),
        }
    }
}

// Main User struct — SELECT query result
#[derive(Debug, Clone, Queryable, Selectable, Identifiable, Serialize)]
#[diesel(table_name = users)]
#[diesel(check_for_backend(diesel::pg::Pg))]
pub struct User {
    pub id: i64,
    pub name: String,
    pub email: String,
    pub role: UserRoleEnum,
    pub status: UserStatusEnum,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// NewUser — INSERT
#[derive(Debug, Insertable, Deserialize)]
#[diesel(table_name = users)]
pub struct NewUser {
    pub name: String,
    pub email: String,
    pub role: UserRoleEnum,
}

// UpdateUser — UPDATE SET (chỉ update fields có Some)
#[derive(Debug, AsChangeset, Deserialize)]
#[diesel(table_name = users)]
pub struct UpdateUser {
    pub name: Option<String>,
    pub email: Option<String>,
    pub role: Option<UserRoleEnum>,
    pub status: Option<UserStatusEnum>,
    pub updated_at: Option<DateTime<Utc>>,
}
```

---

## PHẦN 4 — CRUD với Diesel DSL

### 4.1 SELECT Queries

```rust
use crate::schema::users::dsl::*;  // import tất cả column names
use diesel::prelude::*;
use diesel_async::{AsyncPgConnection, RunQueryDsl};

// SELECT * WHERE id = ?
pub async fn find_by_id(
    conn: &mut AsyncPgConnection,
    user_id: i64,
) -> Result<Option<User>, diesel::result::Error> {
    users
        .filter(id.eq(user_id))
        .select(User::as_select())
        .first(conn)
        .await
        .optional()  // None nếu không tìm thấy
}

// SELECT với multiple conditions
pub async fn find_active_admins(
    conn: &mut AsyncPgConnection,
) -> Result<Vec<User>, diesel::result::Error> {
    users
        .filter(status.eq(UserStatusEnum::Active))
        .filter(role.eq(UserRoleEnum::Admin))
        .order(created_at.desc())
        .select(User::as_select())
        .load(conn)
        .await
}

// SELECT với LIKE (search)
pub async fn search_users(
    conn: &mut AsyncPgConnection,
    search_term: &str,
    page: i64,
    size: i64,
) -> Result<Vec<User>, diesel::result::Error> {
    let pattern = format!("%{}%", search_term);

    users
        .filter(
            name.ilike(pattern.clone())
                .or(email.ilike(pattern))
        )
        .order(created_at.desc())
        .limit(size)
        .offset((page - 1) * size)
        .select(User::as_select())
        .load(conn)
        .await
}

// COUNT
pub async fn count_users(
    conn: &mut AsyncPgConnection,
) -> Result<i64, diesel::result::Error> {
    users
        .count()
        .get_result(conn)
        .await
}

// Chỉ SELECT một số columns (projection)
pub async fn find_emails(
    conn: &mut AsyncPgConnection,
) -> Result<Vec<String>, diesel::result::Error> {
    users
        .select(email)  // chỉ lấy email column
        .load::<String>(conn)
        .await
}
```

### 4.2 INSERT

```rust
use crate::schema::users;

// INSERT một record
pub async fn create_user(
    conn: &mut AsyncPgConnection,
    new_user: NewUser,
) -> Result<User, diesel::result::Error> {
    diesel::insert_into(users::table)
        .values(&new_user)
        .returning(User::as_returning())
        .get_result(conn)
        .await
}

// INSERT nhiều records
pub async fn bulk_insert_users(
    conn: &mut AsyncPgConnection,
    new_users: &[NewUser],
) -> Result<Vec<User>, diesel::result::Error> {
    diesel::insert_into(users::table)
        .values(new_users)
        .returning(User::as_returning())
        .get_results(conn)
        .await
}

// INSERT ON CONFLICT DO NOTHING
pub async fn upsert_user(
    conn: &mut AsyncPgConnection,
    new_user: &NewUser,
) -> Result<Option<User>, diesel::result::Error> {
    diesel::insert_into(users::table)
        .values(new_user)
        .on_conflict(users::email)
        .do_nothing()
        .returning(User::as_returning())
        .get_result(conn)
        .await
        .optional()
}

// INSERT ON CONFLICT DO UPDATE (upsert)
pub async fn upsert_user_update(
    conn: &mut AsyncPgConnection,
    new_user: &NewUser,
) -> Result<User, diesel::result::Error> {
    diesel::insert_into(users::table)
        .values(new_user)
        .on_conflict(users::email)
        .do_update()
        .set((
            users::name.eq(excluded(users::name)),
            users::updated_at.eq(diesel::dsl::now),
        ))
        .returning(User::as_returning())
        .get_result(conn)
        .await
}
```

### 4.3 UPDATE

```rust
use crate::schema::users::dsl::*;

// UPDATE với AsChangeset
pub async fn update_user(
    conn: &mut AsyncPgConnection,
    user_id: i64,
    changes: UpdateUser,
) -> Result<Option<User>, diesel::result::Error> {
    diesel::update(users.filter(id.eq(user_id)))
        .set(&changes)
        .returning(User::as_returning())
        .get_result(conn)
        .await
        .optional()
}

// UPDATE chỉ một vài fields (inline)
pub async fn suspend_user(
    conn: &mut AsyncPgConnection,
    user_id: i64,
) -> Result<bool, diesel::result::Error> {
    let affected = diesel::update(users.filter(id.eq(user_id)))
        .set((
            status.eq(UserStatusEnum::Suspended),
            updated_at.eq(chrono::Utc::now()),
        ))
        .execute(conn)
        .await?;

    Ok(affected > 0)
}

// Bulk UPDATE
pub async fn activate_users_by_ids(
    conn: &mut AsyncPgConnection,
    user_ids: &[i64],
) -> Result<usize, diesel::result::Error> {
    diesel::update(users.filter(id.eq_any(user_ids)))
        .set((
            status.eq(UserStatusEnum::Active),
            updated_at.eq(chrono::Utc::now()),
        ))
        .execute(conn)
        .await
}
```

### 4.4 DELETE

```rust
use crate::schema::users::dsl::*;

// DELETE by id
pub async fn delete_user(
    conn: &mut AsyncPgConnection,
    user_id: i64,
) -> Result<bool, diesel::result::Error> {
    let affected = diesel::delete(users.filter(id.eq(user_id)))
        .execute(conn)
        .await?;
    Ok(affected > 0)
}

// Soft delete (UPDATE status thay vì DELETE)
pub async fn soft_delete_user(
    conn: &mut AsyncPgConnection,
    user_id: i64,
) -> Result<bool, diesel::result::Error> {
    let affected = diesel::update(users.filter(id.eq(user_id)))
        .set(status.eq(UserStatusEnum::Inactive))
        .execute(conn)
        .await?;
    Ok(affected > 0)
}
```

---

## PHẦN 5 — Associations (Quan Hệ)

### 5.1 One-to-Many (User has many Documents)

```rust
// Document model với belongs_to annotation
#[derive(Debug, Clone, Queryable, Selectable, Identifiable, Associations, Serialize)]
#[diesel(table_name = documents)]
#[diesel(belongs_to(User, foreign_key = created_by))]  // belongs_to declaration
#[diesel(check_for_backend(diesel::pg::Pg))]
pub struct Document {
    pub id: i64,
    pub title: String,
    pub content: Option<String>,
    pub category: DocumentCategoryEnum,
    pub status: DocumentStatusEnum,
    pub created_by: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
```

```rust
use diesel::prelude::*;
use diesel_async::RunQueryDsl;

// Load documents của một user (safe — không N+1)
pub async fn get_user_with_documents(
    conn: &mut AsyncPgConnection,
    user_id: i64,
) -> Result<Option<(User, Vec<Document>)>, diesel::result::Error> {
    use crate::schema::{users, documents};

    let user = users::table
        .filter(users::id.eq(user_id))
        .select(User::as_select())
        .first(conn)
        .await
        .optional()?;

    match user {
        Some(user) => {
            let user_docs = Document::belonging_to(&user)
                .select(Document::as_select())
                .order(documents::created_at.desc())
                .load(conn)
                .await?;

            Ok(Some((user, user_docs)))
        }
        None => Ok(None),
    }
}

// Bulk load — N+1 prevention cho list của users
// Java analog: @EntityGraph, fetch join — nhưng explicit và an toàn hơn
pub async fn get_users_with_documents(
    conn: &mut AsyncPgConnection,
) -> Result<Vec<(User, Vec<Document>)>, diesel::result::Error> {
    // Load all users
    let all_users = users::table
        .select(User::as_select())
        .order(users::created_at.desc())
        .load(conn)
        .await?;

    // Load all documents thuộc về các users trên (1 query, không phải N queries)
    let all_documents = Document::belonging_to(&all_users)
        .select(Document::as_select())
        .load(conn)
        .await?;

    // Group documents theo user — Diesel tự sort và zip
    let grouped = all_documents.grouped_by(&all_users);

    // Zip user với documents của user đó
    let result = all_users
        .into_iter()
        .zip(grouped)
        .collect::<Vec<_>>();

    Ok(result)
}
```

### 5.2 JOIN Queries

```rust
use crate::schema::{users, documents};
use diesel::prelude::*;

#[derive(Debug, Queryable, Selectable)]
#[diesel(check_for_backend(diesel::pg::Pg))]
struct DocumentWithAuthor {
    #[diesel(embed)]
    document: Document,
    #[diesel(embed)]
    author: User,
}

// INNER JOIN
pub async fn get_documents_with_authors(
    conn: &mut AsyncPgConnection,
) -> Result<Vec<(Document, User)>, diesel::result::Error> {
    documents::table
        .inner_join(users::table)  // Diesel dùng joinable!() để biết FK
        .select((Document::as_select(), User::as_select()))
        .load::<(Document, User)>(conn)
        .await
}

// LEFT JOIN (documents kể cả không có user)
pub async fn get_all_documents_with_optional_author(
    conn: &mut AsyncPgConnection,
) -> Result<Vec<(Document, Option<User>)>, diesel::result::Error> {
    documents::table
        .left_join(users::table)
        .select((Document::as_select(), User::as_select().nullable()))
        .load::<(Document, Option<User>)>(conn)
        .await
}

// JOIN với filter
pub async fn get_admin_documents(
    conn: &mut AsyncPgConnection,
) -> Result<Vec<Document>, diesel::result::Error> {
    documents::table
        .inner_join(users::table)
        .filter(users::role.eq(UserRoleEnum::Admin))
        .filter(documents::status.eq(DocumentStatusEnum::Approved))
        .select(Document::as_select())
        .order(documents::created_at.desc())
        .load(conn)
        .await
}
```

---

## PHẦN 6 — Connection Pool & Async

### 6.1 diesel-async + deadpool

```rust
use diesel_async::{
    pooled_connection::{deadpool::Pool, AsyncDieselConnectionManager},
    AsyncPgConnection,
};

pub type DbPool = Pool<AsyncPgConnection>;

pub async fn create_pool(database_url: &str) -> DbPool {
    let config = AsyncDieselConnectionManager::<AsyncPgConnection>::new(database_url);

    Pool::builder(config)
        .max_size(20)
        .build()
        .expect("Failed to create DB pool")
}

// Lấy connection từ pool
pub async fn get_conn(pool: &DbPool) -> Result<deadpool::managed::Object<AsyncDieselConnectionManager<AsyncPgConnection>>, AppError> {
    pool.get().await.map_err(|e| AppError::Database(e.to_string()))
}
```

### 6.2 Tích hợp với Axum

```rust
use axum::{extract::State, routing::get, Json, Router};

#[derive(Clone)]
pub struct AppState {
    pub db: DbPool,
}

pub fn user_router() -> Router<AppState> {
    Router::new()
        .route("/users", get(list_users).post(create_user_handler))
        .route("/users/:id", get(get_user_handler).put(update_user_handler).delete(delete_user_handler))
}

async fn list_users(
    State(state): State<AppState>,
) -> Result<Json<Vec<User>>, AppError> {
    let mut conn = state.db.get().await
        .map_err(|e| AppError::Database(e.to_string()))?;

    let users_list = find_all_users(&mut conn).await
        .map_err(|e| AppError::Database(e.to_string()))?;

    Ok(Json(users_list))
}

async fn create_user_handler(
    State(state): State<AppState>,
    Json(dto): Json<CreateUserDto>,
) -> Result<(axum::http::StatusCode, Json<User>), AppError> {
    let mut conn = state.db.get().await
        .map_err(|e| AppError::Database(e.to_string()))?;

    let new_user = NewUser {
        name: dto.name,
        email: dto.email,
        role: UserRoleEnum::User,
    };

    let user = create_user(&mut conn, new_user).await
        .map_err(|e| match e {
            diesel::result::Error::DatabaseError(
                diesel::result::DatabaseErrorKind::UniqueViolation, _
            ) => AppError::Conflict("Email already exists".into()),
            other => AppError::Database(other.to_string()),
        })?;

    Ok((axum::http::StatusCode::CREATED, Json(user)))
}
```

---

## PHẦN 7 — Transactions với Diesel Async

```rust
use diesel_async::AsyncConnection;

pub async fn create_user_with_profile(
    pool: &DbPool,
    user_dto: CreateUserDto,
    profile_dto: CreateProfileDto,
) -> Result<User, AppError> {
    let mut conn = pool.get().await
        .map_err(|e| AppError::Database(e.to_string()))?;

    // Transaction closure
    conn.transaction::<_, diesel::result::Error, _>(|conn| {
        Box::pin(async move {
            // INSERT user
            let new_user = NewUser {
                name: user_dto.name.clone(),
                email: user_dto.email.clone(),
                role: UserRoleEnum::User,
            };

            let user = diesel::insert_into(users::table)
                .values(&new_user)
                .returning(User::as_returning())
                .get_result(conn)
                .await?;

            // INSERT profile
            let new_profile = NewProfile {
                user_id: user.id,
                bio: profile_dto.bio.clone(),
                avatar_url: profile_dto.avatar_url.clone(),
            };

            diesel::insert_into(profiles::table)
                .values(&new_profile)
                .execute(conn)
                .await?;

            Ok(user)
            // Nếu bất kỳ query nào fail → auto rollback
        })
    })
    .await
    .map_err(|e| AppError::Database(e.to_string()))
}
```

---

## PHẦN 8 — Testing

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use diesel_async::AsyncConnection;

    // Helper: tạo test connection
    async fn test_conn() -> AsyncPgConnection {
        let database_url = std::env::var("TEST_DATABASE_URL")
            .unwrap_or_else(|_| "postgres://postgres:postgres@localhost/pdms_test".to_string());
        AsyncPgConnection::establish(&database_url)
            .await
            .expect("Failed to connect to test DB")
    }

    #[tokio::test]
    async fn test_create_and_find_user() {
        let mut conn = test_conn().await;

        // Wrap trong transaction → auto rollback sau test
        conn.transaction::<_, diesel::result::Error, _>(|conn| {
            Box::pin(async move {
                let new_user = NewUser {
                    name: "Test User".to_string(),
                    email: format!("test_{}@example.com", uuid::Uuid::new_v4()),
                    role: UserRoleEnum::User,
                };

                let created = create_user(conn, new_user).await.unwrap();
                assert!(created.id > 0);
                assert_eq!(created.role, UserRoleEnum::User);

                let found = find_by_id(conn, created.id).await.unwrap();
                assert!(found.is_some());
                assert_eq!(found.unwrap().email, created.email);

                // Rollback bằng cách return Err
                Err(diesel::result::Error::RollbackTransaction)
            })
        })
        .await
        .ok(); // ignore rollback error
    }

    #[tokio::test]
    async fn test_associations() {
        let mut conn = test_conn().await;

        conn.transaction::<_, diesel::result::Error, _>(|conn| {
            Box::pin(async move {
                // Create user
                let user = create_user(conn, NewUser {
                    name: "Author".to_string(),
                    email: format!("author_{}@test.com", uuid::Uuid::new_v4()),
                    role: UserRoleEnum::Admin,
                }).await?;

                // Create documents
                for i in 0..3 {
                    diesel::insert_into(documents::table)
                        .values(NewDocument {
                            title: format!("Doc {}", i),
                            created_by: user.id,
                            ..Default::default()
                        })
                        .execute(conn)
                        .await?;
                }

                // Test belonging_to
                let docs = Document::belonging_to(&user)
                    .select(Document::as_select())
                    .load(conn)
                    .await?;

                assert_eq!(docs.len(), 3);

                Err(diesel::result::Error::RollbackTransaction)
            })
        })
        .await
        .ok();
    }
}
```

---

## 📊 Diesel vs SQLx — Chọn Cái Nào?

```
┌───────────────────┬────────────────────────────┬────────────────────────────┐
│ Scenario          │ Diesel                     │ SQLx                       │
├───────────────────┼────────────────────────────┼────────────────────────────┤
│ Simple CRUD       │ ✅ DSL rõ ràng, ít code     │ ✅ SQL quen thuộc           │
│ Complex JOIN      │ ⚠️ Verbose                  │ ✅ Viết SQL trực tiếp       │
│ JSONB operations  │ ⚠️ Plugin cần thêm          │ ✅ Native operators          │
│ Bulk operations   │ ✅ bulk insert values        │ ✅ UNNEST, COPY             │
│ Full-text search  │ ⚠️ Custom SQL escape         │ ✅ tsvector, tsquery        │
│ CTE / Window fn   │ ❌ Không support            │ ✅ Raw SQL                  │
│ Schema as code    │ ✅ schema.rs auto-gen        │ ❌ Tự manage               │
│ Type safety       │ ✅ DSL type-checks           │ ✅ Compile-time verify       │
│ Migrations        │ ✅ diesel migration          │ ✅ sqlx migrate             │
│ Async support     │ ✅ diesel-async              │ ✅ Native async             │
│ Learning curve    │ Medium (học DSL)            │ Low (biết SQL là đủ)       │
│ Java analog       │ jOOQ / Spring Data JPA      │ JdbcTemplate / jOOQ raw    │
└───────────────────┴────────────────────────────┴────────────────────────────┘

💡 Recommendation cho PDMS:
  - CRUD đơn giản: Diesel (ít code hơn)
  - Batch import, complex SQL, JSONB: SQLx
  - Nhiều team dùng cả hai trong cùng project tùy use case
```

---

## 🏋️ Bài Tập

1. **Full CRUD**: Setup Diesel project với PostgreSQL. Create migration cho `documents` table. Implement CRUD async với `diesel-async` + `deadpool`. Tích hợp vào Axum router.

2. **Associations**: Implement `get_documents_with_authors()` dùng `grouped_by`. So sánh query count với N+1 naive approach (tracing SQL log).

3. **Upsert Pattern**: Implement `upsert_document(doc)` — insert nếu chưa có (theo title + created_by unique constraint), update nếu đã có. Dùng `on_conflict().do_update()`.

4. **Diesel vs SQLx Benchmark**: Implement cùng query với cả Diesel và SQLx. Benchmark với 100 concurrent requests. So sánh performance và code readability.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-26-SQLx-Advanced|Bài 26: SQLx Advanced]] — prerequisite, compare
- [[Rust-Zero-To-Hero/Bai-29-Leptos|Bài 29: Leptos]] → tiếp theo
- [[Rust-Zero-To-Hero/Bai-12-SQLx-Database|Bài 12: SQLx Basics]]
