# Bài 31: Redis & Caching — deadpool-redis · Cache Patterns · Session

> **Prerequisite:** Bài 9 (Tokio), Bài 10-11 (Axum), Bài 13 (Serde)  
> **Mục tiêu:** Master Redis integration — connection pool, caching patterns, session management, pub/sub, distributed lock, và pipeline optimization

---

## 🗺️ Bức Tranh Tổng Quan

```
Redis Use Cases trong PDMS:

  ┌─────────────────────────────────────────────────────────────┐
  │                    Axum Service                             │
  │                                                             │
  │  Request → [Redis Cache Check] → Hit? Return cached        │
  │                    │ Miss                                   │
  │                    ▼                                        │
  │  [DB Query] → [Cache Store] → Return result                │
  │                                                             │
  │  Use cases:                                                 │
  │  ├── Document metadata cache (hot data)                    │
  │  ├── User session storage                                   │
  │  ├── JWT token blacklist (logout)                          │
  │  ├── Rate limit counters                                    │
  │  ├── Distributed lock (prevent duplicate processing)       │
  │  ├── Pub/Sub (real-time notifications)                      │
  │  └── Leaderboard / sorted sets                             │
  └─────────────────────────────────────────────────────────────┘

Redis Crate Landscape:
  redis          → low-level, synchronous + async
  deadpool-redis → connection pooling (recommended)
  fred           → fully async, feature-rich, newer
  
Java analog:
  Spring Cache + @Cacheable + Lettuce/Jedis + Spring Session
```

---

## PHẦN 1 — Setup & Connection Pool

### 1.1 Dependencies

```toml
[dependencies]
redis = { version = "0.26", features = ["tokio-comp", "connection-manager"] }
deadpool-redis = "0.18"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
axum = "0.7"
thiserror = "1"
uuid = { version = "1", features = ["v4"] }
chrono = "0.4"
```

### 1.2 Connection Pool Setup

```rust
use deadpool_redis::{Config, Pool, Runtime};
use redis::AsyncCommands;

pub type RedisPool = Pool;

pub fn create_redis_pool(redis_url: &str) -> Result<RedisPool, deadpool_redis::CreatePoolError> {
    let cfg = Config::from_url(redis_url);
    cfg.create_pool(Some(Runtime::Tokio1))
}

// AppState
#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::PgPool,
    pub redis: RedisPool,
}

// main.rs
let redis_pool = create_redis_pool(
    &std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".into())
)
.expect("Failed to create Redis pool");
```

### 1.3 Basic Operations

```rust
use deadpool_redis::Connection;
use redis::AsyncCommands;

// Wrapper để dễ dùng hơn
pub struct RedisClient {
    pool: RedisPool,
}

impl RedisClient {
    pub fn new(pool: RedisPool) -> Self {
        Self { pool }
    }

    async fn conn(&self) -> Result<Connection, AppError> {
        self.pool
            .get()
            .await
            .map_err(|e| AppError::Redis(e.to_string()))
    }

    // SET key value [EX seconds]
    pub async fn set<V: serde::Serialize>(
        &self,
        key: &str,
        value: &V,
        ttl_secs: Option<u64>,
    ) -> Result<(), AppError> {
        let json = serde_json::to_string(value)
            .map_err(|e| AppError::Serialization(e.to_string()))?;

        let mut conn = self.conn().await?;

        match ttl_secs {
            Some(ttl) => conn
                .set_ex::<_, _, ()>(key, json, ttl)
                .await
                .map_err(|e| AppError::Redis(e.to_string())),
            None => conn
                .set::<_, _, ()>(key, json)
                .await
                .map_err(|e| AppError::Redis(e.to_string())),
        }
    }

    // GET key → Option<T>
    pub async fn get<V: serde::de::DeserializeOwned>(
        &self,
        key: &str,
    ) -> Result<Option<V>, AppError> {
        let mut conn = self.conn().await?;

        let result: Option<String> = conn
            .get(key)
            .await
            .map_err(|e| AppError::Redis(e.to_string()))?;

        match result {
            Some(json) => {
                let value = serde_json::from_str(&json)
                    .map_err(|e| AppError::Serialization(e.to_string()))?;
                Ok(Some(value))
            }
            None => Ok(None),
        }
    }

    // DEL key
    pub async fn del(&self, key: &str) -> Result<bool, AppError> {
        let mut conn = self.conn().await?;
        let deleted: i64 = conn
            .del(key)
            .await
            .map_err(|e| AppError::Redis(e.to_string()))?;
        Ok(deleted > 0)
    }

    // EXISTS key
    pub async fn exists(&self, key: &str) -> Result<bool, AppError> {
        let mut conn = self.conn().await?;
        let exists: bool = conn
            .exists(key)
            .await
            .map_err(|e| AppError::Redis(e.to_string()))?;
        Ok(exists)
    }

    // EXPIRE key seconds
    pub async fn expire(&self, key: &str, ttl_secs: u64) -> Result<(), AppError> {
        let mut conn = self.conn().await?;
        conn.expire::<_, ()>(key, ttl_secs as i64)
            .await
            .map_err(|e| AppError::Redis(e.to_string()))
    }

    // TTL key
    pub async fn ttl(&self, key: &str) -> Result<i64, AppError> {
        let mut conn = self.conn().await?;
        conn.ttl(key)
            .await
            .map_err(|e| AppError::Redis(e.to_string()))
    }
}
```

---

## PHẦN 2 — Cache Patterns

### 2.1 Cache Aside (Lazy Loading) — Most Common

```
Cache Aside Pattern:
  ┌──────┐  1. get(key)   ┌───────┐                ┌────────┐
  │Client│ ─────────────▶ │ Cache │  2. cache miss │   DB   │
  │      │ ◀─────────────  │       │ ──────────────▶│        │
  │      │  3. set(key,v) │       │ ◀────────────── │        │
  │      │                └───────┘  4. return data └────────┘
  └──────┘
  Client responsible for loading + caching
```

```rust
use std::time::Duration;

pub struct DocumentCache {
    redis: Arc<RedisClient>,
    db: sqlx::PgPool,
}

impl DocumentCache {
    const KEY_PREFIX: &'static str = "doc";
    const DEFAULT_TTL: u64 = 3600; // 1 hour

    fn cache_key(id: i64) -> String {
        format!("{}:{}", Self::KEY_PREFIX, id)
    }

    fn list_cache_key(page: u32, size: u32, category: Option<&str>) -> String {
        format!(
            "{}:list:{}:{}:{}",
            Self::KEY_PREFIX,
            page,
            size,
            category.unwrap_or("all")
        )
    }

    // Cache-Aside: get or fetch
    pub async fn get_document(&self, id: i64) -> Result<Option<Document>, AppError> {
        let key = Self::cache_key(id);

        // 1. Check cache
        if let Some(cached) = self.redis.get::<Document>(&key).await? {
            tracing::debug!(doc_id = id, "Cache hit");
            return Ok(Some(cached));
        }

        tracing::debug!(doc_id = id, "Cache miss — fetching from DB");

        // 2. Fetch from DB
        let doc = sqlx::query_as!(Document,
            "SELECT * FROM documents WHERE id = $1", id)
            .fetch_optional(&self.db)
            .await?;

        // 3. Store in cache
        if let Some(ref d) = doc {
            self.redis.set(&key, d, Some(Self::DEFAULT_TTL)).await?;
        }

        Ok(doc)
    }

    // Invalidate on update
    pub async fn update_document(
        &self,
        id: i64,
        dto: UpdateDocumentDto,
    ) -> Result<Document, AppError> {
        // Update DB
        let doc = sqlx::query_as!(Document,
            "UPDATE documents SET title = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
            dto.title, id)
            .fetch_one(&self.db)
            .await?;

        // Invalidate cache (stale data pattern)
        self.redis.del(&Self::cache_key(id)).await?;

        // Also invalidate list caches
        self.invalidate_list_caches().await?;

        Ok(doc)
    }

    async fn invalidate_list_caches(&self) -> Result<(), AppError> {
        let mut conn = self.redis.pool.get().await
            .map_err(|e| AppError::Redis(e.to_string()))?;

        // Scan và xóa tất cả list cache keys
        let pattern = format!("{}:list:*", Self::KEY_PREFIX);
        let keys: Vec<String> = redis::cmd("SCAN")
            .arg(0)
            .arg("MATCH")
            .arg(&pattern)
            .arg("COUNT")
            .arg(100)
            .query_async(&mut conn)
            .await
            .unwrap_or((0i64, vec![]))
            .1;

        if !keys.is_empty() {
            conn.del::<_, ()>(keys)
                .await
                .map_err(|e| AppError::Redis(e.to_string()))?;
        }

        Ok(())
    }
}
```

### 2.2 Read-Through Cache

```rust
// Cache library tự load từ DB khi miss
// Pattern phổ biến cho data ít thay đổi (config, reference data)

pub struct ConfigCache {
    redis: Arc<RedisClient>,
    db: sqlx::PgPool,
}

impl ConfigCache {
    // Transparent: caller không biết có cache hay không
    pub async fn get_system_config(&self) -> Result<SystemConfig, AppError> {
        const KEY: &str = "system:config";
        const TTL: u64 = 300; // 5 minutes

        // Internal: check cache → load DB → cache → return
        match self.redis.get::<SystemConfig>(KEY).await? {
            Some(config) => Ok(config),
            None => {
                let config = sqlx::query_as!(SystemConfig,
                    "SELECT * FROM system_config WHERE id = 1")
                    .fetch_one(&self.db)
                    .await?;

                self.redis.set(KEY, &config, Some(TTL)).await.ok(); // fail-open
                Ok(config)
            }
        }
    }
}
```

### 2.3 Write-Through Cache

```rust
// Write to cache VÀ DB cùng lúc
// Đảm bảo cache luôn có data mới nhất

pub async fn create_document_write_through(
    &self,
    dto: CreateDocumentDto,
) -> Result<Document, AppError> {
    // 1. Write to DB
    let doc = sqlx::query_as!(Document,
        "INSERT INTO documents (title, category, created_at) VALUES ($1, $2, NOW()) RETURNING *",
        dto.title, dto.category)
        .fetch_one(&self.db)
        .await?;

    // 2. Write to cache immediately (không đợi miss)
    self.redis.set(
        &DocumentCache::cache_key(doc.id),
        &doc,
        Some(DocumentCache::DEFAULT_TTL),
    ).await.ok(); // fail-open: cache failure không block

    Ok(doc)
}
```

### 2.4 Cache Stampede Prevention (Mutex Lock)

```
Cache Stampede Problem:
  Cache expires → 1000 concurrent requests all hit DB at once
  → DB overloaded!

Solution: Only 1 request rebuilds cache, others wait
```

```rust
use tokio::sync::Mutex;
use std::collections::HashMap;

pub struct AntiStampedeCache {
    redis: Arc<RedisClient>,
    db: sqlx::PgPool,
    // In-memory mutex per key
    rebuilding: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
}

impl AntiStampedeCache {
    pub async fn get_with_lock(&self, id: i64) -> Result<Document, AppError> {
        let key = format!("doc:{}", id);

        // Fast path: cache hit
        if let Some(doc) = self.redis.get::<Document>(&key).await? {
            return Ok(doc);
        }

        // Slow path: get per-key mutex
        let key_mutex = {
            let mut map = self.rebuilding.lock().await;
            map.entry(key.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };

        // Only ONE goroutine rebuilds cache
        let _guard = key_mutex.lock().await;

        // Double-check after acquiring lock (another request may have populated cache)
        if let Some(doc) = self.redis.get::<Document>(&key).await? {
            return Ok(doc);
        }

        // Actually rebuild cache
        let doc = sqlx::query_as!(Document,
            "SELECT * FROM documents WHERE id = $1", id)
            .fetch_one(&self.db)
            .await?;

        self.redis.set(&key, &doc, Some(3600)).await.ok();

        Ok(doc)
    }
}
```

---

## PHẦN 3 — Session Management

### 3.1 Session Store

```rust
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub session_id: String,
    pub user_id: i64,
    pub user_role: String,
    pub created_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    pub ip_address: String,
    pub user_agent: String,
}

pub struct SessionStore {
    redis: Arc<RedisClient>,
    ttl_secs: u64,
}

impl SessionStore {
    pub fn new(redis: Arc<RedisClient>, ttl_secs: u64) -> Self {
        Self { redis, ttl_secs }
    }

    fn session_key(session_id: &str) -> String {
        format!("session:{}", session_id)
    }

    fn user_sessions_key(user_id: i64) -> String {
        format!("user:{}:sessions", user_id)
    }

    // Tạo session mới
    pub async fn create_session(
        &self,
        user_id: i64,
        user_role: &str,
        ip_address: &str,
        user_agent: &str,
    ) -> Result<Session, AppError> {
        let session = Session {
            session_id: Uuid::new_v4().to_string(),
            user_id,
            user_role: user_role.to_string(),
            created_at: Utc::now(),
            last_activity: Utc::now(),
            ip_address: ip_address.to_string(),
            user_agent: user_agent.to_string(),
        };

        // Store session
        let key = Self::session_key(&session.session_id);
        self.redis.set(&key, &session, Some(self.ttl_secs)).await?;

        // Track user's sessions (SADD user:N:sessions session_id)
        let mut conn = self.redis.pool.get().await
            .map_err(|e| AppError::Redis(e.to_string()))?;
        conn.sadd::<_, _, ()>(
            &Self::user_sessions_key(user_id),
            &session.session_id,
        )
        .await
        .map_err(|e| AppError::Redis(e.to_string()))?;

        // Set expiry on user sessions set
        conn.expire::<_, ()>(
            &Self::user_sessions_key(user_id),
            self.ttl_secs as i64,
        )
        .await
        .ok();

        Ok(session)
    }

    // Lấy session (cập nhật last_activity)
    pub async fn get_session(&self, session_id: &str) -> Result<Option<Session>, AppError> {
        let key = Self::session_key(session_id);
        let mut session: Session = match self.redis.get(&key).await? {
            Some(s) => s,
            None => return Ok(None),
        };

        // Refresh TTL + update last_activity
        session.last_activity = Utc::now();
        self.redis.set(&key, &session, Some(self.ttl_secs)).await?;

        Ok(Some(session))
    }

    // Destroy session (logout)
    pub async fn destroy_session(&self, session_id: &str) -> Result<(), AppError> {
        let key = Self::session_key(session_id);

        // Get session để lấy user_id
        if let Some(session) = self.redis.get::<Session>(&key).await? {
            // Remove từ user's session set
            let mut conn = self.redis.pool.get().await
                .map_err(|e| AppError::Redis(e.to_string()))?;
            conn.srem::<_, _, ()>(
                &Self::user_sessions_key(session.user_id),
                session_id,
            )
            .await
            .ok();
        }

        self.redis.del(&key).await?;
        Ok(())
    }

    // Invalidate ALL sessions của một user (force logout everywhere)
    pub async fn destroy_all_user_sessions(&self, user_id: i64) -> Result<u32, AppError> {
        let user_sessions_key = Self::user_sessions_key(user_id);
        let mut conn = self.redis.pool.get().await
            .map_err(|e| AppError::Redis(e.to_string()))?;

        // Get tất cả session IDs
        let session_ids: Vec<String> = conn
            .smembers(&user_sessions_key)
            .await
            .map_err(|e| AppError::Redis(e.to_string()))?;

        let count = session_ids.len() as u32;

        // Delete từng session
        for session_id in &session_ids {
            conn.del::<_, ()>(&Self::session_key(session_id))
                .await
                .ok();
        }

        // Delete user sessions set
        conn.del::<_, ()>(&user_sessions_key).await.ok();

        Ok(count)
    }
}
```

### 3.2 Session Middleware trong Axum

```rust
use axum::{
    extract::{FromRequestParts, State},
    http::{request::Parts, HeaderMap, StatusCode},
    middleware::Next,
    response::Response,
    Extension,
};

// Session extractor
pub struct CurrentSession(pub Session);

#[async_trait]
impl<S> FromRequestParts<S> for CurrentSession
where
    S: Send + Sync,
{
    type Rejection = (StatusCode, axum::Json<serde_json::Value>);

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        // Lấy session từ extensions (injected bởi middleware)
        parts
            .extensions
            .get::<Session>()
            .cloned()
            .map(CurrentSession)
            .ok_or_else(|| {
                (
                    StatusCode::UNAUTHORIZED,
                    axum::Json(serde_json::json!({ "error": "Not authenticated" })),
                )
            })
    }
}

// Session auth middleware
pub async fn session_auth_middleware(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut req: axum::extract::Request,
    next: Next,
) -> Response {
    // Extract session ID from Cookie or Bearer token
    let session_id = extract_session_id(&headers);

    if let Some(session_id) = session_id {
        if let Ok(Some(session)) = state.sessions.get_session(&session_id).await {
            req.extensions_mut().insert(session);
        }
    }

    next.run(req).await
}

fn extract_session_id(headers: &HeaderMap) -> Option<String> {
    // Try Authorization header first
    if let Some(auth) = headers.get("Authorization") {
        if let Ok(value) = auth.to_str() {
            if let Some(token) = value.strip_prefix("Bearer ") {
                return Some(token.to_string());
            }
        }
    }

    // Fallback: Cookie header
    if let Some(cookie) = headers.get("Cookie") {
        if let Ok(cookie_str) = cookie.to_str() {
            for part in cookie_str.split(';') {
                let part = part.trim();
                if let Some(session_id) = part.strip_prefix("session_id=") {
                    return Some(session_id.to_string());
                }
            }
        }
    }

    None
}

// Dùng trong handler
async fn get_current_user(
    CurrentSession(session): CurrentSession,
    State(state): State<AppState>,
) -> impl axum::response::IntoResponse {
    axum::Json(serde_json::json!({
        "user_id": session.user_id,
        "role": session.user_role,
        "last_activity": session.last_activity,
    }))
}
```

---

## PHẦN 4 — JWT Token Blacklist

```rust
// Logout invalidation: store revoked JWTs until they expire
pub struct TokenBlacklist {
    redis: Arc<RedisClient>,
}

impl TokenBlacklist {
    fn blacklist_key(jti: &str) -> String {
        format!("token:blacklist:{}", jti)
    }

    // Revoke token (logout)
    pub async fn revoke(&self, jti: &str, expires_at: i64) -> Result<(), AppError> {
        let ttl = expires_at - chrono::Utc::now().timestamp();
        if ttl > 0 {
            // Store until token naturally expires
            let key = Self::blacklist_key(jti);
            self.redis.set(&key, &true, Some(ttl as u64)).await?;
        }
        Ok(())
    }

    // Check if token is revoked
    pub async fn is_revoked(&self, jti: &str) -> Result<bool, AppError> {
        self.redis.exists(&Self::blacklist_key(jti)).await
    }
}

// JWT Claims struct với jti (JWT ID)
#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: i64,          // user_id
    pub jti: String,       // JWT ID (unique per token)
    pub role: String,
    pub exp: i64,
    pub iat: i64,
}

// Auth middleware check blacklist
pub async fn jwt_auth_middleware(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut req: axum::extract::Request,
    next: Next,
) -> Response {
    if let Some(token) = extract_bearer_token(&headers) {
        if let Ok(claims) = verify_jwt(&token, &state.config.jwt_secret) {
            // Check blacklist
            if let Ok(false) = state.blacklist.is_revoked(&claims.jti).await {
                req.extensions_mut().insert(claims);
            }
        }
    }
    next.run(req).await
}
```

---

## PHẦN 5 — Advanced Redis Operations

### 5.1 Pipeline — Batch Commands

```rust
// Pipeline: gửi nhiều commands một lúc → giảm round trips
pub async fn get_multiple_documents(
    pool: &RedisPool,
    ids: &[i64],
) -> Result<Vec<Option<Document>>, AppError> {
    let mut conn = pool.get().await
        .map_err(|e| AppError::Redis(e.to_string()))?;

    let keys: Vec<String> = ids.iter().map(|id| format!("doc:{}", id)).collect();

    // Dùng MGET thay vì nhiều GET
    let values: Vec<Option<String>> = redis::cmd("MGET")
        .arg(&keys)
        .query_async(&mut conn)
        .await
        .map_err(|e| AppError::Redis(e.to_string()))?;

    let results = values
        .into_iter()
        .map(|v| {
            v.and_then(|json| serde_json::from_str(&json).ok())
        })
        .collect();

    Ok(results)
}

// Pipeline với nhiều loại operations
pub async fn pipeline_example(pool: &RedisPool) -> Result<(), AppError> {
    let mut conn = pool.get().await
        .map_err(|e| AppError::Redis(e.to_string()))?;

    // Pipeline: tất cả commands gửi cùng lúc
    let (set_result, get_result, incr_result): ((), Option<String>, i64) =
        redis::pipe()
            .set_ex("key1", "value1", 3600)
            .get("key2")
            .incr("counter", 1)
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Redis(e.to_string()))?;

    println!("get_result: {:?}, counter: {}", get_result, incr_result);
    Ok(())
}
```

### 5.2 Hash Operations (HSET/HGET)

```rust
// Redis Hash = một object với nhiều fields
// Hiệu quả hơn nhiều JSON strings cho partial updates

pub async fn update_user_field(
    pool: &RedisPool,
    user_id: i64,
    field: &str,
    value: &str,
) -> Result<(), AppError> {
    let mut conn = pool.get().await
        .map_err(|e| AppError::Redis(e.to_string()))?;

    let key = format!("user:{}", user_id);

    // HSET user:1 field value (partial update!)
    conn.hset::<_, _, _, ()>(&key, field, value)
        .await
        .map_err(|e| AppError::Redis(e.to_string()))?;

    Ok(())
}

pub async fn get_user_fields(
    pool: &RedisPool,
    user_id: i64,
) -> Result<std::collections::HashMap<String, String>, AppError> {
    let mut conn = pool.get().await
        .map_err(|e| AppError::Redis(e.to_string()))?;

    let key = format!("user:{}", user_id);
    let fields: std::collections::HashMap<String, String> = conn
        .hgetall(&key)
        .await
        .map_err(|e| AppError::Redis(e.to_string()))?;

    Ok(fields)
}
```

### 5.3 Sorted Set — Leaderboard / Recent Items

```rust
// ZADD: add với score
// ZRANGE: lấy theo rank
// Dùng cho: top documents, recent activity feed, priority queue

pub async fn add_recent_document(
    pool: &RedisPool,
    user_id: i64,
    doc_id: i64,
) -> Result<(), AppError> {
    let mut conn = pool.get().await
        .map_err(|e| AppError::Redis(e.to_string()))?;

    let key = format!("user:{}:recent_docs", user_id);
    let score = chrono::Utc::now().timestamp() as f64;

    // ZADD key score member
    conn.zadd::<_, _, _, ()>(&key, doc_id.to_string(), score)
        .await
        .map_err(|e| AppError::Redis(e.to_string()))?;

    // Giữ tối đa 50 items (ZREMRANGEBYRANK)
    conn.zremrangebyrank::<_, ()>(&key, 0, -51)
        .await
        .map_err(|e| AppError::Redis(e.to_string()))?;

    // Set TTL
    conn.expire::<_, ()>(&key, 86400 * 7) // 7 days
        .await
        .ok();

    Ok(())
}

pub async fn get_recent_documents(
    pool: &RedisPool,
    user_id: i64,
    limit: isize,
) -> Result<Vec<i64>, AppError> {
    let mut conn = pool.get().await
        .map_err(|e| AppError::Redis(e.to_string()))?;

    let key = format!("user:{}:recent_docs", user_id);

    // ZREVRANGE: newest first
    let members: Vec<String> = conn
        .zrevrange(&key, 0, limit - 1)
        .await
        .map_err(|e| AppError::Redis(e.to_string()))?;

    let ids: Vec<i64> = members
        .iter()
        .filter_map(|m| m.parse().ok())
        .collect();

    Ok(ids)
}
```

### 5.4 Distributed Lock (Redlock)

```rust
use std::time::Duration;

pub struct DistributedLock {
    redis: Arc<RedisClient>,
}

impl DistributedLock {
    fn lock_key(resource: &str) -> String {
        format!("lock:{}", resource)
    }

    // Acquire lock (SET NX PX)
    pub async fn acquire(
        &self,
        resource: &str,
        ttl: Duration,
    ) -> Result<Option<String>, AppError> {
        let token = Uuid::new_v4().to_string();
        let key = Self::lock_key(resource);
        let ttl_ms = ttl.as_millis() as u64;

        let mut conn = self.redis.pool.get().await
            .map_err(|e| AppError::Redis(e.to_string()))?;

        // SET key token NX PX ttl_ms (atomic)
        let result: Option<String> = redis::cmd("SET")
            .arg(&key)
            .arg(&token)
            .arg("NX")   // Only set if not exists
            .arg("PX")   // Millisecond TTL
            .arg(ttl_ms)
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Redis(e.to_string()))?;

        // "OK" means lock acquired
        if result.as_deref() == Some("OK") {
            Ok(Some(token))
        } else {
            Ok(None) // Lock not acquired
        }
    }

    // Release lock (Lua script để atomic check + delete)
    pub async fn release(&self, resource: &str, token: &str) -> Result<bool, AppError> {
        let key = Self::lock_key(resource);

        // Lua script: chỉ delete nếu value match (tránh xóa lock của người khác)
        let script = r#"
            if redis.call("GET", KEYS[1]) == ARGV[1] then
                return redis.call("DEL", KEYS[1])
            else
                return 0
            end
        "#;

        let mut conn = self.redis.pool.get().await
            .map_err(|e| AppError::Redis(e.to_string()))?;

        let result: i64 = redis::Script::new(script)
            .key(&key)
            .arg(token)
            .invoke_async(&mut conn)
            .await
            .map_err(|e| AppError::Redis(e.to_string()))?;

        Ok(result == 1)
    }

    // Convenience: execute with lock
    pub async fn with_lock<F, T>(
        &self,
        resource: &str,
        ttl: Duration,
        f: F,
    ) -> Result<Option<T>, AppError>
    where
        F: std::future::Future<Output = Result<T, AppError>>,
    {
        match self.acquire(resource, ttl).await? {
            Some(token) => {
                let result = f.await;
                self.release(resource, &token).await.ok();
                result.map(Some)
            }
            None => Ok(None), // Could not acquire lock
        }
    }
}

// Dùng trong PDMS: prevent duplicate document processing
pub async fn process_document_batch(
    lock: &DistributedLock,
    batch_id: &str,
) -> Result<(), AppError> {
    let resource = format!("batch:{}", batch_id);

    let result = lock
        .with_lock(&resource, Duration::from_secs(300), async {
            // Chỉ 1 instance xử lý batch này
            do_batch_processing(batch_id).await
        })
        .await?;

    match result {
        Some(_) => tracing::info!("Batch {} processed", batch_id),
        None => tracing::warn!("Batch {} already being processed, skipped", batch_id),
    }

    Ok(())
}
```

### 5.5 Pub/Sub

```rust
// Redis Pub/Sub cho real-time notifications
use redis::Msg;

pub struct RedisPubSub {
    pool: RedisPool,
}

// Publisher
impl RedisPubSub {
    pub async fn publish<T: serde::Serialize>(
        &self,
        channel: &str,
        message: &T,
    ) -> Result<i64, AppError> {
        let mut conn = self.pool.get().await
            .map_err(|e| AppError::Redis(e.to_string()))?;

        let payload = serde_json::to_string(message)
            .map_err(|e| AppError::Serialization(e.to_string()))?;

        let receivers: i64 = conn
            .publish(channel, &payload)
            .await
            .map_err(|e| AppError::Redis(e.to_string()))?;

        Ok(receivers)
    }
}

// Subscriber (cần dedicated connection — không dùng pool)
pub async fn subscribe_to_notifications(
    redis_url: &str,
    channels: &[&str],
    mut handler: impl FnMut(String, String) + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    let client = redis::Client::open(redis_url).expect("Redis connect failed");

    tokio::spawn(async move {
        let mut pubsub = client
            .get_async_pubsub()
            .await
            .expect("Failed to get pubsub connection");

        pubsub.subscribe(channels).await.expect("Subscribe failed");

        let mut stream = pubsub.on_message();

        while let Some(msg) = stream.next().await {
            let channel: String = msg.get_channel().unwrap_or_default();
            let payload: String = msg.get_payload().unwrap_or_default();
            handler(channel, payload);
        }
    })
}

// Dùng với SSE để push notifications
pub async fn setup_notification_bridge(
    redis_url: &str,
    broadcast_tx: tokio::sync::broadcast::Sender<String>,
) {
    subscribe_to_notifications(
        redis_url,
        &["document:events", "user:events"],
        move |channel, payload| {
            let msg = format!(r#"{{"channel":"{}","data":{}}}"#, channel, payload);
            broadcast_tx.send(msg).ok();
        },
    ).await;
}
```

---

## PHẦN 6 — Cache Layer trong Axum (Production Setup)

```rust
// Axum middleware: cache GET responses
use axum::{body::Body, http::{Method, Request, StatusCode}, response::Response};
use std::time::Instant;

pub async fn cache_middleware(
    State(redis): State<Arc<RedisClient>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    // Chỉ cache GET requests
    if req.method() != Method::GET {
        return next.run(req).await;
    }

    let path = req.uri().to_string();
    let cache_key = format!("http:{}", path);

    // Check cache
    if let Ok(Some(cached_body)) = redis.get::<String>(&cache_key).await {
        return Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "application/json")
            .header("X-Cache", "HIT")
            .body(Body::from(cached_body))
            .unwrap();
    }

    // Cache miss — execute handler
    let response = next.run(req).await;

    // Cache 200 responses
    if response.status() == StatusCode::OK {
        let (parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap_or_default();
        let body_str = String::from_utf8_lossy(&bytes).to_string();

        // Store in cache (5 minutes)
        redis.set(&cache_key, &body_str, Some(300)).await.ok();

        let mut response = Response::from_parts(parts, Body::from(bytes));
        response.headers_mut().insert(
            "X-Cache",
            "MISS".parse().unwrap(),
        );
        return response;
    }

    response
}
```

---

## 🎯 So Sánh Spring Cache

| Concept | Spring | Rust/Redis |
|---|---|---|
| Cache config | `@EnableCaching` + `CacheManager` | `RedisPool` + custom wrapper |
| Cache put | `@Cacheable` annotation | `redis.set(&key, &value, ttl)` |
| Cache evict | `@CacheEvict` | `redis.del(&key)` |
| Session | Spring Session + `@EnableRedisHttpSession` | `SessionStore` + middleware |
| Pub/Sub | `@EventListener` + `RedisMessageListenerContainer` | `subscribe_to_notifications()` |
| Distributed lock | `ShedLock` / custom | `DistributedLock` với Lua script |

---

## 🏋️ Bài Tập

1. **Document Cache**: Implement `DocumentCache` với Cache-Aside pattern. GET `/documents/:id` → check Redis → miss → DB → cache. Kiểm tra với `X-Cache` header.

2. **Session Auth**: Build session-based auth flow: POST `/login` → create session → return cookie. GET `/me` → validate session. POST `/logout` → destroy session.

3. **JWT Blacklist**: Implement logout với token blacklist. POST `/logout` invalidate JWT trong Redis cho đến khi token hết hạn.

4. **Distributed Lock**: Simulate double-submit problem với batch processing. Dùng `DistributedLock` để ensure chỉ 1 worker xử lý mỗi batch.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-30-Validation|Bài 30: Validation]] ← prerequisite
- [[Rust-Zero-To-Hero/Bai-32-Security|Bài 32: Security → Rate Limiting]] → tiếp theo
- [[Rust-Zero-To-Hero/Bai-24-Axum-Advanced|Bài 24: Axum → SSE integration]]
