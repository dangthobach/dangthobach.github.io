# Bài 23: Workspace Architecture & Crate Design

> **Java analog:** Maven multi-module project. Nhưng Rust workspace có compile-time crate boundary enforcement — không thể accidentally import internal implementation details như trong Java's package-private.

---

## 1. Cargo Workspace — Cấu Trúc Cơ Bản

```toml
# workspace/Cargo.toml (root — không có [package])
[workspace]
members = [
    "crates/domain",
    "crates/infrastructure",
    "crates/api",
    "crates/kafka-consumer",
    "crates/migrations",
    "apps/server",
    "apps/worker",
]

# Shared dependencies — version lock tất cả crates
[workspace.dependencies]
tokio       = { version = "1", features = ["full"] }
sqlx        = { version = "0.7", features = ["postgres", "runtime-tokio"] }
serde       = { version = "1", features = ["derive"] }
axum        = "0.7"
tracing     = "0.1"
thiserror   = "1"
anyhow      = "1"

# Shared profile settings
[profile.release]
opt-level = 3
lto = "thin"
```

```toml
# crates/domain/Cargo.toml
[package]
name = "pdms-domain"
version = "0.1.0"
edition = "2021"

[dependencies]
serde    = { workspace = true }
thiserror = { workspace = true }
# domain không depend vào infrastructure hoặc API!
```

---

## 2. Domain-driven Crate Splitting

```
pdms-workspace/
├── Cargo.toml                    ← workspace root
├── crates/
│   ├── domain/                   ← business logic, no external deps
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── entities/         ← User, Document, Contract
│   │       ├── value_objects/    ← EmailAddress, VND, DocumentId
│   │       ├── repositories/     ← Repository traits (interfaces)
│   │       └── services/         ← Domain services
│   │
│   ├── infrastructure/           ← DB, Kafka implementations
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── postgres/         ← SqlxUserRepository impl
│   │       └── kafka/            ← rdkafka Producer/Consumer
│   │
│   ├── api/                      ← HTTP layer only
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── handlers/         ← Axum handlers
│   │       ├── extractors/       ← Custom extractors
│   │       └── dto/              ← Request/Response types
│   │
│   └── shared-kernel/            ← Shared types (error, pagination)
│       └── src/lib.rs
│
└── apps/
    ├── server/                   ← Main binary: wire everything
    │   └── src/main.rs
    └── worker/                   ← Kafka consumer binary
        └── src/main.rs
```

**Dependency rules (enforce tại compile time):**

```
domain          → KHÔNG depend vào bất cứ thứ gì
infrastructure  → depends on: domain
api             → depends on: domain, shared-kernel
apps/server     → depends on: api, infrastructure, domain
apps/worker     → depends on: infrastructure, domain
```

```toml
# crates/infrastructure/Cargo.toml
[dependencies]
pdms-domain   = { path = "../domain" }      # implements domain traits
sqlx          = { workspace = true }
rdkafka       = "0.36"
# KHÔNG có axum — infrastructure không biết về HTTP

# crates/api/Cargo.toml
[dependencies]
pdms-domain        = { path = "../domain" }
pdms-shared-kernel = { path = "../shared-kernel" }
axum               = { workspace = true }
serde              = { workspace = true }
# KHÔNG có sqlx — api không biết về database
```

---

## 3. Public API Design — `pub` vs `pub(crate)` vs Private

```rust
// crates/domain/src/entities/user.rs

// pub: visible everywhere
pub struct User {
    pub id: UserId,
    pub email: EmailAddress,
    // private — implementation detail
    created_at: chrono::DateTime<chrono::Utc>,
    // pub(crate) — visible trong crate này, không ra ngoài
    pub(crate) internal_state: UserState,
}

impl User {
    // Constructor — validate invariants
    pub fn new(email: EmailAddress) -> Result<Self, DomainError> {
        if email.is_blacklisted() {
            return Err(DomainError::BlacklistedEmail(email));
        }
        Ok(Self {
            id: UserId::new(),
            email,
            created_at: chrono::Utc::now(),
            internal_state: UserState::Active,
        })
    }
    
    // Getter — no setter! Domain state changes through domain methods
    pub fn created_at(&self) -> chrono::DateTime<chrono::Utc> {
        self.created_at
    }
    
    pub fn deactivate(&mut self) -> Result<(), DomainError> {
        if self.internal_state == UserState::Inactive {
            return Err(DomainError::AlreadyInactive);
        }
        self.internal_state = UserState::Inactive;
        Ok(())
    }
}

// crates/domain/src/lib.rs — explicit public API
pub mod entities;
pub mod repositories;
pub mod services;
mod internal;  // không public — implementation detail
```

---

## 4. Feature Flags — Conditional Compilation

```toml
# Cargo.toml
[features]
default = ["postgres"]

postgres  = ["sqlx/postgres", "dep:sqlx"]
mysql     = ["sqlx/mysql", "dep:sqlx"]
redis     = ["dep:redis"]
metrics   = ["dep:prometheus"]
```

```rust
// Conditional compilation với cfg
#[cfg(feature = "postgres")]
pub mod postgres;

#[cfg(feature = "redis")]
pub mod redis_cache;

// Trong code:
#[cfg(feature = "metrics")]
fn record_metric(name: &str, value: f64) {
    prometheus::gauge!(name, value);
}

#[cfg(not(feature = "metrics"))]
fn record_metric(_name: &str, _value: f64) {}  // no-op

// Build với specific features:
// cargo build --features "redis,metrics"
// cargo test --no-default-features --features "postgres"
```

---

## 5. Shared Kernel — Cross-crate Types

```rust
// crates/shared-kernel/src/lib.rs

/// Pagination request
#[derive(Debug, Deserialize)]
pub struct PageRequest {
    pub page: u32,
    pub size: u32,
}

impl PageRequest {
    pub fn offset(&self) -> u32 {
        (self.page.saturating_sub(1)) * self.size
    }
    pub fn limit(&self) -> u32 { self.size }
}

/// Typed page response
#[derive(Debug, Serialize)]
pub struct Page<T> {
    pub content: Vec<T>,
    pub total_elements: u64,
    pub total_pages: u64,
    pub page: u32,
    pub size: u32,
}

impl<T> Page<T> {
    pub fn new(content: Vec<T>, total: u64, req: &PageRequest) -> Self {
        let size = req.size as u64;
        Self {
            total_elements: total,
            total_pages: (total + size - 1) / size,
            page: req.page,
            size: req.size,
            content,
        }
    }
    
    pub fn map<U>(self, f: impl Fn(T) -> U) -> Page<U> {
        Page { content: self.content.into_iter().map(f).collect(), ..self }
    }
}

/// Typed ID — prevents mixing different entity IDs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TypedId<T> {
    value: uuid::Uuid,
    _marker: std::marker::PhantomData<T>,
}

impl<T> TypedId<T> {
    pub fn new() -> Self {
        Self { value: uuid::Uuid::new_v4(), _marker: Default::default() }
    }
    pub fn from_uuid(id: uuid::Uuid) -> Self {
        Self { value: id, _marker: Default::default() }
    }
}
```

---

## 6. Repository Pattern — Trait trong Domain, Impl trong Infrastructure

```rust
// crates/domain/src/repositories/user_repository.rs
use async_trait::async_trait;

#[async_trait]
pub trait UserRepository: Send + Sync {
    async fn find_by_id(&self, id: UserId) -> Result<Option<User>, DomainError>;
    async fn find_by_email(&self, email: &EmailAddress) -> Result<Option<User>, DomainError>;
    async fn save(&self, user: &User) -> Result<(), DomainError>;
    async fn delete(&self, id: UserId) -> Result<(), DomainError>;
    async fn find_all(&self, req: &PageRequest) -> Result<Page<User>, DomainError>;
}

// crates/infrastructure/src/postgres/user_repository.rs
pub struct PostgresUserRepository {
    pool: sqlx::PgPool,
}

#[async_trait]
impl UserRepository for PostgresUserRepository {
    async fn find_by_id(&self, id: UserId) -> Result<Option<User>, DomainError> {
        sqlx::query_as!(UserRow,
            "SELECT * FROM users WHERE id = $1",
            id.as_uuid()
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(DomainError::from)?
        .map(User::try_from)
        .transpose()
    }
    // ...
}

// apps/server/src/main.rs — wire everything
async fn main() {
    let pool = create_pool(&config).await;
    
    // Inject concrete implementation
    let user_repo: Arc<dyn UserRepository> = Arc::new(
        PostgresUserRepository::new(pool)
    );
    
    let app_state = AppState { user_repo };
    // ...
}
```

---

## 7. Testing Across Workspace

```rust
// Unit tests trong domain (không cần DB)
// crates/domain/src/entities/user.rs
#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn cannot_create_user_with_blacklisted_email() {
        let email = EmailAddress::parse("spam@blacklist.com").unwrap();
        assert!(User::new(email).is_err());
    }
}

// Integration tests với real DB
// crates/infrastructure/tests/user_repository_test.rs
#[sqlx::test(migrations = "../../migrations")]
async fn test_save_and_find_user(pool: PgPool) {
    let repo = PostgresUserRepository::new(pool);
    
    let user = User::new(EmailAddress::parse("test@example.com").unwrap()).unwrap();
    repo.save(&user).await.unwrap();
    
    let found = repo.find_by_id(user.id).await.unwrap();
    assert_eq!(found.unwrap().email, user.email);
}

// cargo test để chạy tất cả tests trong workspace
// cargo test -p pdms-domain  để chỉ test một crate
```

---

## 8. Build Time — Cải Thiện Incremental Compile

```toml
# .cargo/config.toml
[build]
# Dùng mold linker — 5-10x nhanh hơn lld trên Linux
linker = "clang"
rustflags = ["-C", "link-arg=-fuse-ld=mold"]

# Hoặc dùng sccache — cache compilation artifacts
[env]
RUSTC_WRAPPER = "sccache"
```

```bash
# Workspace build strategies:

# Build chỉ crate bạn đang làm việc (fast):
cargo build -p pdms-api

# Build tất cả (CI):
cargo build --workspace

# Check mà không compile binary (fastest):
cargo check --workspace

# Clean chỉ một crate:
cargo clean -p pdms-infrastructure

# Dependency graph:
cargo tree -p pdms-api  # xem tất cả dependencies

# Detect unused dependencies:
cargo install cargo-udeps
cargo udeps --workspace
```

---

## 9. Java Multi-module vs Rust Workspace

| | Java Maven Multi-module | Rust Workspace |
|---|---|---|
| Dependency boundary | `package-private` (runtime) | `pub`/`pub(crate)` (compile time) |
| Circular deps | Detected at build | Prevented by compiler |
| Shared versions | `<dependencyManagement>` | `[workspace.dependencies]` |
| Build unit | Module JAR | Crate `.rlib` |
| Incremental build | Rebuild if parent changes | Only rebuild changed crates |
| Cross-crate tests | Test in parent module | `tests/` directory per crate |
| Feature flags | Maven profiles | Cargo features |
| Binary separation | Executable JAR | `[[bin]]` or `apps/` crates |

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-15-Config-Tracing-Testing|Bài 15: Testing]]
- [[Rust-Zero-To-Hero/Bai-16-Deployment|Bài 16: Docker deployment]]
- [[MOC-PDMS]] — Applied: PDMS workspace structure
- [[MOC-System-Design]] — Clean Architecture mapping

---
*Bài tập:*
1. Convert PDMS project sang workspace với 4 crates: `pdms-domain`, `pdms-infrastructure`, `pdms-api`, `pdms-app`. Verify dependency rules: domain không import infrastructure.
2. Add feature flag `redis-cache` — chỉ compile Redis implementation khi flag enabled. Default dùng in-memory cache.
3. Viết `Page<T>` trong shared-kernel với `map()` method. Dùng trong cả API layer (Page<UserDto>) và domain layer (Page<User>).
