---
tags: [rust, axum, leptos, dioxus, background-jobs, caching, redis, http-cache, production]
prerequisites: [Bai-44-Styling-Pipeline]
next: null
---

# Bài 45: Background Jobs & Caching — Production Scale

> **Áp dụng cho:** Axum (backend) · Leptos · Dioxus  
> **Mục tiêu:** Job queues, HTTP caching, Redis cache layer, in-memory cache — không để server chết vì load

---

## 🗺️ Bức Tranh Tổng Quan

```
Tại sao cần Background Jobs & Caching?

  Không có → Mọi thứ xảy ra synchronously trong request:

  User request
      │
      ▼  (300ms) Database query
      ▼  (200ms) Generate PDF
      ▼  (500ms) Send email notification
      ▼  (100ms) Update audit log
      │
      │  TOTAL: 1100ms response time ← User chờ quá lâu
      ▼
  Response

─────────────────────────────────────────────────────────────────

  Có Background Jobs + Cache → Tách slow work ra:

  User request
      │
      ▼  (50ms) Database query (cached)
      ▼  (10ms) Enqueue: "generate PDF + send email + audit log"
      │
      │  TOTAL: 60ms response time ✅
      ▼
  Response (ngay lập tức)

  Background Worker (chạy riêng):
      ▼  Generate PDF
      ▼  Send email
      ▼  Update audit log
      (User nhận email sau vài giây)

─────────────────────────────────────────────────────────────────

Caching Layer:

  Request
      │
      ▼ L1: In-Memory Cache (DashMap, sub-millisecond)
      │     Hit rate: ~70% cho hot data
      │
      ▼ L2: Redis Cache (< 5ms)
      │     Hit rate: ~95% của những gì L1 miss
      │
      ▼ L3: Database (10-100ms)
            Chỉ ~5% requests chạm đến đây

─────────────────────────────────────────────────────────────────

Job Queue Architecture:

  HTTP Handler
      │ enqueue(job)
      ▼
  ┌─────────────┐
  │  Job Queue  │  ← Redis / PostgreSQL / In-memory
  │  (persist)  │
  └──────┬──────┘
         │ poll (n workers)
         ▼
  ┌─────────────────────────────────────┐
  │  Worker Pool (Tokio tasks)          │
  │  Worker 1: PDF generation           │
  │  Worker 2: Email sending            │
  │  Worker 3: Audit log                │
  │  Worker 4: File indexing            │
  └─────────────────────────────────────┘
```

---

## PHẦN 1 — Background Job Queue

### 1.1 In-Memory Queue (Simple)

```rust
// Phù hợp cho: low-traffic, không cần persist qua restart

use tokio::sync::mpsc;
use std::sync::Arc;
use serde::{Deserialize, Serialize};

// Định nghĩa tất cả job types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Job {
    GeneratePdf {
        document_id: u32,
        template: String,
    },
    SendEmail {
        to: String,
        subject: String,
        body: String,
    },
    UpdateAuditLog {
        user_id: u32,
        action: String,
        resource: String,
    },
    IndexDocument {
        document_id: u32,
    },
}

// Job executor — xử lý từng job type
pub struct JobExecutor {
    db: Arc<Database>,
    email_client: Arc<EmailClient>,
    pdf_service: Arc<PdfService>,
}

impl JobExecutor {
    pub async fn execute(&self, job: Job) -> Result<(), anyhow::Error> {
        match job {
            Job::GeneratePdf { document_id, template } => {
                tracing::info!("Generating PDF for document {}", document_id);
                let doc = self.db.get_document(document_id).await?;
                let pdf_bytes = self.pdf_service.render(&doc, &template).await?;
                self.db.save_pdf(document_id, pdf_bytes).await?;
                tracing::info!("PDF generated for document {}", document_id);
            }
            Job::SendEmail { to, subject, body } => {
                tracing::info!("Sending email to {}", to);
                self.email_client.send(&to, &subject, &body).await?;
            }
            Job::UpdateAuditLog { user_id, action, resource } => {
                self.db.insert_audit(user_id, &action, &resource).await?;
            }
            Job::IndexDocument { document_id } => {
                let doc = self.db.get_document(document_id).await?;
                self.db.update_search_index(&doc).await?;
            }
        }
        Ok(())
    }
}

// Queue manager — channel-based
#[derive(Clone)]
pub struct JobQueue {
    sender: mpsc::UnboundedSender<Job>,
}

impl JobQueue {
    pub fn new(executor: Arc<JobExecutor>, num_workers: usize) -> Self {
        let (tx, rx) = mpsc::unbounded_channel::<Job>();
        let rx = Arc::new(tokio::sync::Mutex::new(rx));

        // Spawn worker pool
        for worker_id in 0..num_workers {
            let exec = executor.clone();
            let rx_clone = rx.clone();

            tokio::spawn(async move {
                tracing::info!("Worker {} started", worker_id);
                loop {
                    let job = {
                        let mut receiver = rx_clone.lock().await;
                        receiver.recv().await
                    };

                    match job {
                        Some(j) => {
                            if let Err(e) = exec.execute(j).await {
                                tracing::error!("Worker {} job failed: {}", worker_id, e);
                                // TODO: retry logic
                            }
                        }
                        None => {
                            tracing::info!("Worker {} channel closed, exiting", worker_id);
                            break;
                        }
                    }
                }
            });
        }

        Self { sender: tx }
    }

    pub fn enqueue(&self, job: Job) -> Result<(), anyhow::Error> {
        self.sender.send(job)
            .map_err(|e| anyhow::anyhow!("Queue closed: {}", e))
    }
}

// Axum handler dùng queue
async fn create_document_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    axum::Json(req): axum::Json<CreateDocumentRequest>,
) -> impl axum::response::IntoResponse {
    // 1. Lưu document vào DB (fast)
    let doc_id = state.db.insert_document(&req).await.unwrap();

    // 2. Enqueue slow jobs (không block response)
    state.queue.enqueue(Job::GeneratePdf {
        document_id: doc_id,
        template: "standard".to_string(),
    }).unwrap();

    state.queue.enqueue(Job::UpdateAuditLog {
        user_id: user.id.parse().unwrap_or(0),
        action: "CREATE".to_string(),
        resource: format!("document:{}", doc_id),
    }).unwrap();

    state.queue.enqueue(Job::SendEmail {
        to: "manager@vpbank.com".to_string(),
        subject: format!("Hồ sơ mới #{}", doc_id),
        body: format!("Hồ sơ '{}' vừa được tạo.", req.title),
    }).unwrap();

    // 3. Trả về ngay — không cần chờ PDF/email
    axum::Json(serde_json::json!({
        "id": doc_id,
        "message": "Hồ sơ đang được xử lý",
    }))
}
```

### 1.2 Persistent Queue với PostgreSQL

```rust
// Phù hợp khi: cần đảm bảo job không bị mất khi restart
// Pattern: Transactional Outbox / SKIP LOCKED polling

use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, sqlx::FromRow)]
struct JobRecord {
    id: Uuid,
    job_type: String,
    payload: serde_json::Value,
    status: String,       // pending | processing | done | failed
    attempts: i32,
    max_attempts: i32,
    scheduled_at: chrono::DateTime<chrono::Utc>,
    created_at: chrono::DateTime<chrono::Utc>,
}

pub struct PgJobQueue {
    pool: PgPool,
}

impl PgJobQueue {
    // Enqueue trong cùng transaction với business logic
    // → Đảm bảo "create document" và "enqueue job" là atomic
    pub async fn enqueue_in_tx(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        job: &Job,
        delay_secs: u64,
    ) -> Result<Uuid, sqlx::Error> {
        let id = Uuid::new_v4();
        let payload = serde_json::to_value(job).unwrap();
        let scheduled_at = chrono::Utc::now()
            + chrono::Duration::seconds(delay_secs as i64);

        sqlx::query!(
            r#"
            INSERT INTO job_queue (id, job_type, payload, status, attempts, max_attempts, scheduled_at)
            VALUES ($1, $2, $3, 'pending', 0, 3, $4)
            "#,
            id,
            format!("{:?}", std::mem::discriminant(job)),
            payload,
            scheduled_at,
        )
        .execute(&mut **tx)
        .await?;

        Ok(id)
    }

    // Worker: poll và process jobs với SKIP LOCKED
    pub async fn poll_and_process(&self, executor: &JobExecutor) {
        loop {
            match self.fetch_and_lock_job().await {
                Ok(Some(record)) => {
                    tracing::info!("Processing job {} ({})", record.id, record.job_type);

                    let job: Job = serde_json::from_value(record.payload.clone()).unwrap();
                    match executor.execute(job).await {
                        Ok(_) => {
                            self.mark_done(record.id).await.unwrap();
                        }
                        Err(e) => {
                            tracing::error!("Job {} failed: {}", record.id, e);
                            self.mark_failed(record.id, &e.to_string()).await.unwrap();
                        }
                    }
                }
                Ok(None) => {
                    // Không có job → sleep trước khi poll lại
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
                Err(e) => {
                    tracing::error!("Poll error: {}", e);
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
        }
    }

    async fn fetch_and_lock_job(&self) -> Result<Option<JobRecord>, sqlx::Error> {
        // SKIP LOCKED: nhiều workers không lấy cùng 1 job
        // FOR UPDATE: lock row đang process
        sqlx::query_as!(
            JobRecord,
            r#"
            SELECT id, job_type, payload, status, attempts, max_attempts,
                   scheduled_at, created_at
            FROM job_queue
            WHERE status = 'pending'
              AND scheduled_at <= NOW()
              AND attempts < max_attempts
            ORDER BY scheduled_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
            "#
        )
        .fetch_optional(&self.pool)
        .await
    }

    async fn mark_done(&self, id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE job_queue SET status = 'done', attempts = attempts + 1 WHERE id = $1",
            id
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn mark_failed(&self, id: Uuid, error: &str) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"
            UPDATE job_queue
            SET attempts = attempts + 1,
                status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'pending' END,
                last_error = $2,
                -- Exponential backoff: 30s, 5min, 1h
                scheduled_at = NOW() + (INTERVAL '30 seconds' * POWER(2, attempts))
            WHERE id = $1
            "#,
            id,
            error,
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

// SQL: tạo bảng
// CREATE TABLE job_queue (
//     id UUID PRIMARY KEY,
//     job_type TEXT NOT NULL,
//     payload JSONB NOT NULL,
//     status TEXT NOT NULL DEFAULT 'pending',
//     attempts INTEGER NOT NULL DEFAULT 0,
//     max_attempts INTEGER NOT NULL DEFAULT 3,
//     last_error TEXT,
//     scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
//     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
// );
// CREATE INDEX idx_job_queue_poll ON job_queue (status, scheduled_at)
//     WHERE status = 'pending';
```

### 1.3 Graceful Shutdown

```rust
use tokio::signal;
use tokio_util::sync::CancellationToken;

pub async fn run_server_with_graceful_shutdown(router: axum::Router) {
    let cancel = CancellationToken::new();
    let cancel_clone = cancel.clone();

    // Background worker task
    let worker_cancel = cancel.clone();
    let worker_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = worker_cancel.cancelled() => {
                    tracing::info!("Worker: shutdown signal received, finishing current job...");
                    break;
                }
                _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                    // poll jobs...
                }
            }
        }
        tracing::info!("Worker: gracefully stopped");
    });

    // HTTP server
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    let server = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            // Chờ SIGTERM hoặc Ctrl+C
            let ctrl_c = async { signal::ctrl_c().await.unwrap() };
            #[cfg(unix)]
            let terminate = async {
                signal::unix::signal(signal::unix::SignalKind::terminate())
                    .unwrap()
                    .recv()
                    .await;
            };
            #[cfg(not(unix))]
            let terminate = std::future::pending::<()>();

            tokio::select! {
                _ = ctrl_c => {},
                _ = terminate => {},
            }

            tracing::info!("Shutdown signal received");
            cancel_clone.cancel(); // Signal workers to stop
        });

    server.await.unwrap();
    worker_handle.await.unwrap(); // Chờ worker finish job hiện tại
    tracing::info!("Server and workers stopped cleanly");
}
```

---

## PHẦN 2 — HTTP Caching

### 2.1 Bản Chất HTTP Cache

```
HTTP Cache Headers:

  Server response:
  Cache-Control: max-age=3600, public
      │
      │  Browser/CDN cache response này 1 giờ
      │  Requests tiếp theo trong 1 giờ → KHÔNG gọi server
      ▼

  max-age=N      : Cache N giây
  public         : Cả CDN lẫn browser đều cache
  private        : Chỉ browser cache (không qua CDN)
  no-cache       : Phải validate với server trước khi dùng
  no-store       : Không cache gì hết
  must-revalidate: Khi hết hạn phải hỏi lại server

─────────────────────────────────────────────────────────────────

ETag — Conditional Request:

  Request lần 1:
  GET /api/documents/123
  ←  200 OK
     ETag: "abc123"
     Cache-Control: max-age=0, must-revalidate

  Request lần 2 (sau max-age hết hạn):
  GET /api/documents/123
  If-None-Match: "abc123"
  ←  304 Not Modified (body RỖNG, chỉ headers)
     → Browser dùng cache cũ → Tiết kiệm bandwidth!

  Nếu document thay đổi:
  ←  200 OK
     ETag: "xyz789"
     (body mới)

─────────────────────────────────────────────────────────────────

Last-Modified — Alternative ETag:

  GET /api/documents/123
  ←  200 OK
     Last-Modified: Wed, 06 May 2026 08:00:00 GMT

  GET /api/documents/123
  If-Modified-Since: Wed, 06 May 2026 08:00:00 GMT
  ←  304 Not Modified (nếu không thay đổi)
```

### 2.2 Axum — Cache Middleware

```rust
use axum::{
    extract::Request,
    http::{header, HeaderValue, StatusCode},
    middleware::Next,
    response::Response,
};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

// Middleware: thêm cache headers vào response
pub async fn cache_control_middleware(
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_string();
    let method = request.method().clone();

    let mut response = next.run(request).await;

    // Chỉ cache GET requests thành công
    if method != axum::http::Method::GET {
        return response;
    }
    if !response.status().is_success() {
        return response;
    }

    let headers = response.headers_mut();

    // Chiến lược cache theo path
    let (max_age, scope) = cache_strategy(&path);

    let cache_value = format!(
        "{}, max-age={}, stale-while-revalidate=60",
        scope,
        max_age
    );

    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_str(&cache_value).unwrap(),
    );

    // Vary header — CDN cache riêng cho mỗi Accept-Language
    headers.insert(
        header::VARY,
        HeaderValue::from_static("Accept-Language, Accept-Encoding"),
    );

    response
}

fn cache_strategy(path: &str) -> (u64, &'static str) {
    match path {
        // Static assets — cache rất lâu (có content hash trong filename)
        p if p.starts_with("/assets/") => (31_536_000, "public"), // 1 năm
        // API data — cache ngắn, private
        p if p.starts_with("/api/documents") => (60, "private"),
        // Reference data ít thay đổi
        p if p.starts_with("/api/doc-types") => (3600, "public"),
        p if p.starts_with("/api/departments") => (3600, "public"),
        // User-specific data — không cache ở CDN
        p if p.starts_with("/api/users/me") => (0, "private, no-cache"),
        // Default
        _ => (0, "no-store"),
    }
}

// ETag Middleware
pub async fn etag_middleware(
    request: Request,
    next: Next,
) -> Response {
    let if_none_match = request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    let mut response = next.run(request).await;

    if !response.status().is_success() {
        return response;
    }

    // Tính ETag từ body (hash)
    // NOTE: Trong production nên dùng DB row version hoặc updated_at
    // thay vì hash body (để không phải đọc toàn bộ body)
    let etag = format!(
        r#""{}""#,
        // Giả sử có header X-Content-Version từ handler
        response.headers()
            .get("x-content-version")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("default")
    );

    // So sánh với If-None-Match
    if Some(&etag) == if_none_match.as_ref() {
        // Không thay đổi → 304
        return axum::response::Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, &etag)
            .body(axum::body::Body::empty())
            .unwrap();
    }

    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&etag).unwrap(),
    );

    response
}

// Handler set version header để ETag middleware dùng
async fn get_document(
    axum::extract::Path(id): axum::extract::Path<u32>,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl axum::response::IntoResponse {
    let doc = state.db.get_document(id).await.unwrap();

    // Set version dựa trên updated_at timestamp
    let version = format!("{}-{}", doc.id, doc.updated_at.timestamp());

    (
        [("x-content-version", version)],
        axum::Json(doc),
    )
}
```

---

## PHẦN 3 — Redis Cache Layer

### 3.1 Cache-Aside Pattern

```
Cache-Aside (Lazy Loading):

  Read:                              Write:
  ┌──────────────────────────┐      ┌───────────────────────────┐
  │ Check Redis              │      │ Write to DB               │
  │ Hit? → return            │      │ Invalidate/Update Redis   │
  │ Miss? → Read DB          │      └───────────────────────────┘
  │        Write Redis       │
  │        Return            │      Ưu điểm Write:
  └──────────────────────────┘      ✅ Data luôn consistent
                                    ✅ Đơn giản
  Ưu điểm Read:                     ❌ 2 round-trips khi write
  ✅ Chỉ cache data được request
  ✅ Cache miss không break app
  ❌ Cache miss = chậm (cold start)
```

```rust
use deadpool_redis::{Pool, Connection};
use redis::AsyncCommands;
use serde::{de::DeserializeOwned, Serialize};
use std::time::Duration;

pub struct RedisCache {
    pool: Pool,
    default_ttl: Duration,
}

impl RedisCache {
    pub fn new(pool: Pool, default_ttl_secs: u64) -> Self {
        Self {
            pool,
            default_ttl: Duration::from_secs(default_ttl_secs),
        }
    }

    // Cache-Aside: get hoặc fetch từ DB
    pub async fn get_or_set<T, F, Fut>(
        &self,
        key: &str,
        ttl: Option<Duration>,
        fetch: F,
    ) -> Result<T, anyhow::Error>
    where
        T: Serialize + DeserializeOwned,
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, anyhow::Error>>,
    {
        let mut conn = self.pool.get().await?;

        // Try cache first
        if let Ok(cached) = conn.get::<_, String>(key).await {
            if let Ok(value) = serde_json::from_str::<T>(&cached) {
                return Ok(value);
            }
        }

        // Cache miss → fetch from source
        let value = fetch().await?;

        // Write to cache
        let serialized = serde_json::to_string(&value)?;
        let ttl_secs = ttl.unwrap_or(self.default_ttl).as_secs() as usize;
        let _: () = conn.set_ex(key, serialized, ttl_secs).await?;

        Ok(value)
    }

    pub async fn invalidate(&self, key: &str) -> Result<(), anyhow::Error> {
        let mut conn = self.pool.get().await?;
        let _: () = conn.del(key).await?;
        Ok(())
    }

    // Invalidate theo pattern (prefix)
    pub async fn invalidate_pattern(&self, pattern: &str) -> Result<u64, anyhow::Error> {
        let mut conn = self.pool.get().await?;
        let keys: Vec<String> = conn.keys(pattern).await?;
        if keys.is_empty() { return Ok(0); }
        let count: u64 = conn.del(keys).await?;
        Ok(count)
    }
}

// Key naming convention
fn doc_cache_key(id: u32) -> String { format!("doc:{}", id) }
fn doc_list_cache_key(page: u32, per_page: u32) -> String {
    format!("docs:list:p{}:n{}", page, per_page)
}
fn user_cache_key(id: &str) -> String { format!("user:{}", id) }

// Áp dụng trong service layer
pub struct DocumentService {
    db: Arc<Database>,
    cache: Arc<RedisCache>,
}

impl DocumentService {
    pub async fn get_document(&self, id: u32) -> Result<Document, anyhow::Error> {
        self.cache.get_or_set(
            &doc_cache_key(id),
            Some(Duration::from_secs(300)), // 5 phút
            || self.db.get_document(id),
        ).await
    }

    pub async fn update_document(&self, id: u32, data: UpdateDocumentData)
        -> Result<Document, anyhow::Error>
    {
        // 1. Update DB
        let doc = self.db.update_document(id, &data).await?;

        // 2. Invalidate affected caches
        self.cache.invalidate(&doc_cache_key(id)).await?;
        // Invalidate tất cả list pages (vì order/content có thể thay đổi)
        self.cache.invalidate_pattern("docs:list:*").await?;

        Ok(doc)
    }

    pub async fn list_documents(&self, page: u32, per_page: u32)
        -> Result<Vec<Document>, anyhow::Error>
    {
        self.cache.get_or_set(
            &doc_list_cache_key(page, per_page),
            Some(Duration::from_secs(60)), // List cache ngắn hơn (thay đổi thường xuyên hơn)
            || self.db.list_documents(page, per_page),
        ).await
    }
}
```

---

## PHẦN 4 — In-Memory Cache (L1)

### 4.1 DashMap + TTL Cache

```rust
// Cargo.toml: dashmap = "5"

use dashmap::DashMap;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

struct CacheEntry<V> {
    value: V,
    expires_at: Instant,
}

impl<V> CacheEntry<V> {
    fn is_expired(&self) -> bool {
        Instant::now() > self.expires_at
    }
}

pub struct InMemoryCache<K, V> {
    store: DashMap<K, CacheEntry<V>>,
    default_ttl: Duration,
}

impl<K, V> InMemoryCache<K, V>
where
    K: std::hash::Hash + Eq + Clone,
    V: Clone,
{
    pub fn new(default_ttl: Duration) -> Arc<Self> {
        let cache = Arc::new(Self {
            store: DashMap::new(),
            default_ttl,
        });

        // Background cleanup task
        let cache_clone = cache.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                cache_clone.cleanup_expired();
            }
        });

        cache
    }

    pub fn get(&self, key: &K) -> Option<V> {
        let entry = self.store.get(key)?;
        if entry.is_expired() {
            drop(entry);
            self.store.remove(key);
            return None;
        }
        Some(entry.value.clone())
    }

    pub fn set(&self, key: K, value: V) {
        self.set_with_ttl(key, value, self.default_ttl);
    }

    pub fn set_with_ttl(&self, key: K, value: V, ttl: Duration) {
        self.store.insert(key, CacheEntry {
            value,
            expires_at: Instant::now() + ttl,
        });
    }

    pub fn invalidate(&self, key: &K) {
        self.store.remove(key);
    }

    fn cleanup_expired(&self) {
        self.store.retain(|_, entry| !entry.is_expired());
    }

    pub fn size(&self) -> usize {
        self.store.len()
    }
}

// Dùng trong service với 2-level cache
pub struct CachedDocumentService {
    l1: Arc<InMemoryCache<u32, Document>>,  // In-memory, sub-ms
    l2: Arc<RedisCache>,                     // Redis, <5ms
    db: Arc<Database>,
}

impl CachedDocumentService {
    pub async fn get(&self, id: u32) -> Result<Document, anyhow::Error> {
        // L1 cache
        if let Some(doc) = self.l1.get(&id) {
            return Ok(doc);
        }

        // L2 cache (Redis)
        let doc = self.l2.get_or_set(
            &format!("doc:{}", id),
            Some(Duration::from_secs(300)),
            || self.db.get_document(id),
        ).await?;

        // Populate L1
        self.l1.set_with_ttl(id, doc.clone(), Duration::from_secs(30));

        Ok(doc)
    }

    pub async fn invalidate(&self, id: u32) {
        self.l1.invalidate(&id);
        let _ = self.l2.invalidate(&format!("doc:{}", id)).await;
    }
}
```

### 4.2 Leptos — Resource Cache (Client-Side)

```rust
use leptos::prelude::*;

// Leptos Resources tự cache kết quả
// Nhưng có thể bổ sung invalidation pattern

#[component]
fn DocumentList() -> impl IntoView {
    // Source: reactive key — refetch khi key thay đổi
    let (refresh_trigger, set_refresh) = signal(0u32);

    let documents = Resource::new(
        // Source: refetch khi trigger thay đổi
        move || refresh_trigger.get(),
        // Fetcher: chạy khi source thay đổi
        |_| async move {
            fetch_documents().await
        },
    );

    let refresh = move |_| {
        set_refresh.update(|n| *n += 1); // trigger refetch
    };

    view! {
        <div>
            <div class="list-header">
                <h2>"Danh sách hồ sơ"</h2>
                <button on:click=refresh class="btn-outline">
                    "🔄 Làm mới"
                </button>
            </div>

            <Suspense fallback=|| view! { <DocumentListSkeleton /> }>
                <ErrorBoundary fallback=|errors| view! {
                    <div class="error-state">
                        "Không thể tải dữ liệu: "
                        {move || errors.get().iter()
                            .map(|(_, e)| view! { <p>{e.to_string()}</p> })
                            .collect_view()}
                    </div>
                }>
                    {move || documents.get().map(|docs| view! {
                        <div class="doc-grid">
                            <For
                                each=move || docs.clone().unwrap_or_default()
                                key=|d| d.id
                                children=move |doc| view! {
                                    <DocumentCard doc=doc />
                                }
                            />
                        </div>
                    })}
                </ErrorBoundary>
            </Suspense>
        </div>
    }
}

// Skeleton loader
#[component]
fn DocumentListSkeleton() -> impl IntoView {
    view! {
        <div class="doc-grid">
            {(0..6).map(|_| view! {
                <div class="card animate-pulse">
                    <div class="h-4 bg-gray-200 rounded w-3/4 mb-3" />
                    <div class="h-3 bg-gray-200 rounded w-full mb-2" />
                    <div class="h-3 bg-gray-200 rounded w-5/6" />
                </div>
            }).collect_view()}
        </div>
    }
}
```

### 4.3 Dioxus — Resource Caching

```rust
use dioxus::prelude::*;
use std::collections::HashMap;

// Simple client-side cache cho Dioxus
#[derive(Clone)]
struct ClientCache {
    store: Signal<HashMap<String, (serde_json::Value, std::time::Instant)>>,
    ttl: std::time::Duration,
}

impl ClientCache {
    fn new(ttl_secs: u64) -> Self {
        Self {
            store: Signal::new(HashMap::new()),
            ttl: std::time::Duration::from_secs(ttl_secs),
        }
    }

    fn get<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        let store = self.store.read();
        let (value, inserted_at) = store.get(key)?;
        if inserted_at.elapsed() > self.ttl { return None; }
        serde_json::from_value(value.clone()).ok()
    }

    fn set<T: serde::Serialize>(&self, key: &str, value: &T) {
        let json = serde_json::to_value(value).unwrap();
        self.store.write().insert(
            key.to_string(),
            (json, std::time::Instant::now()),
        );
    }

    fn invalidate(&self, key: &str) {
        self.store.write().remove(key);
    }
}

#[component]
fn DioxusDocumentList() -> Element {
    let cache = use_context_provider(|| ClientCache::new(60));
    let mut documents = use_signal(|| vec![]);
    let mut loading = use_signal(|| false);

    let load_docs = move || async move {
        let cache = use_context::<ClientCache>();

        // Check cache trước
        if let Some(cached) = cache.get::<Vec<Document>>("docs:all") {
            documents.set(cached);
            return;
        }

        loading.set(true);
        match fetch_documents().await {
            Ok(docs) => {
                cache.set("docs:all", &docs);
                documents.set(docs);
            }
            Err(e) => tracing::error!("Load error: {}", e),
        }
        loading.set(false);
    };

    use_effect(move || {
        spawn(load_docs());
    });

    rsx! {
        div {
            if loading() {
                for _ in 0..6 {
                    div { class: "card animate-pulse h-32 bg-gray-100 rounded-xl" }
                }
            } else {
                for doc in documents.read().iter() {
                    DocumentCard { doc: doc.clone() }
                }
            }
        }
    }
}
```

---

## PHẦN 5 — Monitoring & Observability

### 5.1 Job Queue Metrics

```rust
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

// Metrics đơn giản với atomic counters
#[derive(Default)]
pub struct QueueMetrics {
    pub jobs_enqueued:  AtomicU64,
    pub jobs_succeeded: AtomicU64,
    pub jobs_failed:    AtomicU64,
    pub jobs_retried:   AtomicU64,
}

impl QueueMetrics {
    pub fn enqueued(&self) { self.jobs_enqueued.fetch_add(1, Ordering::Relaxed); }
    pub fn succeeded(&self) { self.jobs_succeeded.fetch_add(1, Ordering::Relaxed); }
    pub fn failed(&self)   { self.jobs_failed.fetch_add(1, Ordering::Relaxed); }
    pub fn retried(&self)  { self.jobs_retried.fetch_add(1, Ordering::Relaxed); }

    pub fn success_rate(&self) -> f64 {
        let done = self.jobs_succeeded.load(Ordering::Relaxed) as f64;
        let total = done + self.jobs_failed.load(Ordering::Relaxed) as f64;
        if total == 0.0 { return 100.0; }
        done / total * 100.0
    }
}

// Metrics endpoint cho monitoring
async fn metrics_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl axum::response::IntoResponse {
    let m = &state.metrics;
    axum::Json(serde_json::json!({
        "jobs": {
            "enqueued":   m.jobs_enqueued.load(Ordering::Relaxed),
            "succeeded":  m.jobs_succeeded.load(Ordering::Relaxed),
            "failed":     m.jobs_failed.load(Ordering::Relaxed),
            "retried":    m.jobs_retried.load(Ordering::Relaxed),
            "success_rate_pct": format!("{:.1}", m.success_rate()),
        },
        "cache": {
            "l1_size": state.l1_cache.size(),
        }
    }))
}
```

---

## 💡 Tips & Tricks

```
TIP 1 — Chọn Queue strategy phù hợp
  In-memory queue:
  ✅ Setup siêu đơn giản
  ✅ Zero latency enqueue
  ❌ Mất jobs khi restart/crash
  → Dùng khi: jobs có thể bỏ qua (notification, analytics)

  PostgreSQL queue (SKIP LOCKED):
  ✅ Jobs không bị mất (persist)
  ✅ Đã có PostgreSQL → không cần infra mới
  ✅ Transactional (enqueue cùng transaction với business logic)
  ❌ Slower than Redis (~5ms overhead)
  → Dùng khi: banking, tài chính, jobs quan trọng ← PDMS nên dùng cái này

  Redis queue:
  ✅ Nhanh (sub-ms)
  ✅ Atomic operations
  ❌ Có thể mất data nếu Redis crash (persist mode có thể giúp)
  → Dùng khi: high throughput, có thể replay

TIP 2 — Exponential Backoff cho retry
  Lần 1 fail → chờ 30 giây
  Lần 2 fail → chờ 1 phút
  Lần 3 fail → chờ 5 phút
  Lần 4 fail → Dead Letter Queue (DLQ), alert team
  
  Công thức: delay = base_delay * 2^(attempt - 1) + jitter
  Jitter: thêm random để tránh thundering herd

TIP 3 — Cache Key Design
  Format: service:entity_type:id[:sub]
  
  Ví dụ:
  "doc:123"              → document #123
  "docs:list:p1:n20"    → page 1, 20 items
  "user:456:permissions" → user permissions
  "dept:all"             → all departments
  
  Prefix-based invalidation:
  Khi user 456 thay đổi → invalidate "user:456:*"
  Khi có document mới   → invalidate "docs:list:*"

TIP 4 — Avoid Cache Stampede
  Nhiều requests cùng miss cache → tất cả đọc DB đồng thời:
  
  ┌─────┐  miss  ┌───────┐  100 queries  ┌────┐
  │ R1  │───────▶│ Cache │──────────────▶│ DB │ 💀
  │ R2  │───────▶│ miss  │
  │ ... │───────▶│       │
  │ R100│───────▶└───────┘
  
  Fix: Mutex per cache key (chỉ 1 request fetch, rest chờ):
  
  let _guard = per_key_lock.lock(&key).await;
  if let Some(cached) = cache.get(&key) { return Ok(cached); }
  let value = fetch_from_db().await?;
  cache.set(&key, value.clone());
  Ok(value)

TIP 5 — Cache warming
  Cold start sau deploy → cache rỗng → DB bị hit nặng.
  
  Giải pháp: Pre-warm cache khi startup:
  
  async fn warm_cache(cache: &RedisCache, db: &Database) {
      // Load top 100 documents hay được access nhất
      let popular_ids = db.get_popular_document_ids(100).await.unwrap();
      for id in popular_ids {
          let _ = cache.get_or_set(&doc_cache_key(id), None, || db.get_document(id)).await;
      }
      tracing::info!("Cache warmed with {} documents", 100);
  }
```

---

## 📝 Exercises

1. **PostgreSQL Job Queue**: Implement đầy đủ PgJobQueue với: create/migrate table, enqueue trong transaction, SKIP LOCKED poll, exponential backoff retry, Dead Letter Queue sau 3 lần fail. Test với 100 concurrent jobs.

2. **Multi-Worker Pool**: Spawn 4 workers, mỗi worker xử lý job type riêng (worker 1+2 cho PDF, worker 3 cho email, worker 4 cho audit). Implement priority queue: HIGH > NORMAL > LOW jobs.

3. **2-Level Cache Service**: DocumentService với L1 (DashMap, 30s TTL) + L2 (Redis, 5min TTL). Benchmark: đo latency cho L1 hit, L2 hit, DB hit. Target: L1 < 1ms, L2 < 5ms, DB < 50ms.

4. **ETag Implementation**: Handler trả về ETag dựa trên `updated_at` timestamp. Test: 1st request → 200 + ETag. 2nd request với If-None-Match → 304 No Body. Update document → 3rd request → 200 + new ETag.

5. **Graceful Shutdown**: Server nhận SIGTERM → stop nhận request mới → chờ đang-xử lý requests hoàn thành (max 30s) → flush job queue (enqueue remaining) → shutdown. Test với `kill -TERM <pid>` khi đang process long job.

6. **Cache Dashboard (Leptos/Dioxus)**: Trang admin hiển thị: cache hit rate, L1/L2 size, job queue depth, success/fail rate. Auto-refresh mỗi 5 giây. Nút "Clear Cache" có confirmation dialog.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-44-Styling-Pipeline|Bài 44: Styling Pipeline]] ← trước đó
- [[Rust-Zero-To-Hero/Bai-24-Axum-Advanced|Bài 24: Axum Advanced]] — middleware
- [[Rust-Zero-To-Hero/Bai-25-PostgreSQL-Axum|Bài 25: PostgreSQL + Axum]] — SKIP LOCKED, transactions
- [[Rust-Zero-To-Hero/Bai-39-Security-Production|Bài 39: Security]] — Redis connection pool
- [[Microservices-Patterns/CDC-Transactional-Outbox|CDC Transactional Outbox]] — outbox pattern reference
