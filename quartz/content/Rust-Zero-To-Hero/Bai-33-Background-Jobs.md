# Bài 33: Background Jobs — Scheduler · Worker Pool · Job Queue

> **Prerequisite:** Bài 9 (Tokio), Bài 12 (SQLx), Bài 31 (Redis)  
> **Mục tiêu:** Master background processing — cron scheduler, worker pool, persistent job queue, retry với backoff, job monitoring, và graceful shutdown

---

## 🗺️ Bức Tranh Tổng Quan

```
Background Job Architecture:

  ┌───────────────────────────────────────────────────────────┐
  │                    Axum HTTP Server                       │
  │  POST /documents/import → enqueue job → return job_id   │
  └──────────────────────┬────────────────────────────────────┘
                         │ enqueue
                         ▼
  ┌───────────────────────────────────────────────────────────┐
  │                   Job Queue                               │
  │   Redis (fast, volatile) hoặc PostgreSQL (persistent)    │
  │                                                           │
  │   [job_id, type, payload, status, retry_count, next_run] │
  └──────────────────────┬────────────────────────────────────┘
                         │ dequeue
                         ▼
  ┌───────────────────────────────────────────────────────────┐
  │                  Worker Pool                              │
  │  Worker 1: ImportDocuments                               │
  │  Worker 2: SendEmailNotifications                        │
  │  Worker 3: GenerateReports                               │
  │  Scheduler: CleanupExpiredSessions (cron: 0 2 * * *)     │
  └───────────────────────────────────────────────────────────┘

Job Types:
  1. One-shot: trigger once (import, export, email)
  2. Scheduled: cron expression (cleanup, report generation)
  3. Delayed: run after N seconds
  4. Periodic: repeat every N seconds

Java analog:
  Spring Batch + @Scheduled + Quartz Scheduler
  Kafka consumer group (for distributed jobs)
```

---

## PHẦN 1 — tokio-cron-scheduler

### 1.1 Setup

```toml
[dependencies]
tokio-cron-scheduler = { version = "0.11", features = ["signal"] }
tokio = { version = "1", features = ["full"] }
chrono = "0.4"
sqlx = { version = "0.7", features = ["postgres", "runtime-tokio"] }
uuid = { version = "1", features = ["v4"] }
```

### 1.2 Basic Scheduler

```rust
use tokio_cron_scheduler::{Job, JobScheduler};
use std::sync::Arc;

pub struct AppScheduler {
    scheduler: JobScheduler,
    db: sqlx::PgPool,
}

impl AppScheduler {
    pub async fn new(db: sqlx::PgPool) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let scheduler = JobScheduler::new().await?;

        Ok(Self { scheduler, db })
    }

    pub async fn register_all_jobs(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.register_cleanup_job().await?;
        self.register_report_job().await?;
        self.register_health_check_job().await?;
        Ok(())
    }

    pub async fn start(self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.scheduler.start().await?;
        // Keep alive
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(100)).await;
        }
    }
}
```

### 1.3 Cron Job Examples — PDMS Use Cases

```rust
use chrono::Utc;

impl AppScheduler {
    // Cleanup expired sessions — chạy lúc 2 giờ sáng mỗi ngày
    async fn register_cleanup_job(
        &self,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let db = self.db.clone();

        let job = Job::new_async("0 2 * * * *", move |uuid, mut l| {
            let db = db.clone();
            Box::pin(async move {
                let start = Utc::now();
                tracing::info!(job_id = %uuid, "Cleanup job started");

                match cleanup_expired_sessions(&db).await {
                    Ok(count) => {
                        let elapsed = (Utc::now() - start).num_milliseconds();
                        tracing::info!(
                            job_id = %uuid,
                            deleted = count,
                            elapsed_ms = elapsed,
                            "Cleanup completed"
                        );
                    }
                    Err(e) => {
                        tracing::error!(job_id = %uuid, error = %e, "Cleanup failed");
                    }
                }

                // Get next scheduled time
                let next = l.next_tick_for_job(uuid).await;
                if let Ok(Some(ts)) = next {
                    tracing::debug!("Next cleanup scheduled at: {:?}", ts);
                }
            })
        })?;

        self.scheduler.add(job).await?;
        Ok(())
    }

    // Weekly report — mỗi thứ 2 lúc 8 giờ sáng
    async fn register_report_job(
        &self,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let db = self.db.clone();

        // Cron: sec min hour day-of-month month day-of-week
        // "0 0 8 * * Mon" = every Monday 8:00 AM
        let job = Job::new_async("0 0 8 * * Mon *", move |uuid, _l| {
            let db = db.clone();
            Box::pin(async move {
                tracing::info!(job_id = %uuid, "Weekly report job started");

                if let Err(e) = generate_weekly_report(&db).await {
                    tracing::error!(job_id = %uuid, error = %e, "Report generation failed");
                }
            })
        })?;

        self.scheduler.add(job).await?;
        Ok(())
    }

    // Health check mỗi 30 giây
    async fn register_health_check_job(
        &self,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let db = self.db.clone();

        let job = Job::new_async("1/30 * * * * *", move |uuid, _l| {
            let db = db.clone();
            Box::pin(async move {
                match sqlx::query!("SELECT 1 AS ok").fetch_one(&db).await {
                    Ok(_) => tracing::debug!(job_id = %uuid, "DB health OK"),
                    Err(e) => tracing::error!(job_id = %uuid, error = %e, "DB health FAIL"),
                }
            })
        })?;

        self.scheduler.add(job).await?;
        Ok(())
    }
}

// Job implementations
async fn cleanup_expired_sessions(db: &sqlx::PgPool) -> Result<u64, sqlx::Error> {
    let result = sqlx::query!(
        "DELETE FROM sessions WHERE expires_at < NOW()"
    )
    .execute(db)
    .await?;

    Ok(result.rows_affected())
}

async fn generate_weekly_report(db: &sqlx::PgPool) -> Result<(), AppError> {
    let report = sqlx::query!(
        r#"
        SELECT
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS new_docs,
            COUNT(*) FILTER (WHERE status = 'approved') AS approved_docs,
            COUNT(DISTINCT created_by) AS active_users
        FROM documents
        "#
    )
    .fetch_one(db)
    .await?;

    // Save report to DB + send email
    tracing::info!(
        new_docs = report.new_docs.unwrap_or(0),
        approved = report.approved_docs.unwrap_or(0),
        "Weekly report generated"
    );

    Ok(())
}
```

### 1.4 Cron Expression Reference

```
Cron format: sec  min  hour  day-of-month  month  day-of-week  year
              0    *    *     *             *      *            *
              │    │    │     │             │      │            │
              │    │    │     │             │      │            └─ 2024,2025,...
              │    │    │     │             │      └──────────── Mon,Tue,.. / 1-7
              │    │    │     │             └─────────────────── Jan,.. / 1-12
              │    │    │     └───────────────────────────────── 1-31
              │    │    └─────────────────────────────────────── 0-23
              │    └──────────────────────────────────────────── 0-59
              └───────────────────────────────────────────────── 0-59

Common patterns:
  "0 0 * * * *"           → Every hour (at :00)
  "0 */15 * * * *"        → Every 15 minutes
  "0 0 2 * * *"           → Every day at 2 AM
  "0 0 8 * * Mon *"       → Every Monday 8 AM
  "0 0 0 1 * * *"         → First day of every month
  "0 0 9-17 * * Mon-Fri * → Weekdays 9 AM - 5 PM
  "1/30 * * * * *"        → Every 30 seconds
```

---

## PHẦN 2 — Worker Pool Pattern

### 2.1 Bounded Worker Pool

```rust
use tokio::sync::{mpsc, Semaphore};
use std::sync::Arc;

// Job definition
#[derive(Debug, Clone)]
pub struct Job {
    pub job_id: String,
    pub job_type: JobType,
    pub payload: serde_json::Value,
    pub priority: u8,     // 0 = highest
    pub max_retries: u32,
    pub retry_count: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum JobType {
    ImportDocuments { file_path: String, batch_size: u32 },
    SendEmail { to: String, template: String, context: serde_json::Value },
    GenerateReport { report_type: String, date_range: String },
    ExportDocuments { query: String, format: String },
    IndexDocuments { document_ids: Vec<i64> },
}

// Worker pool
pub struct WorkerPool {
    job_tx: mpsc::Sender<Job>,
    semaphore: Arc<Semaphore>,
}

impl WorkerPool {
    pub fn new(
        worker_count: usize,
        queue_capacity: usize,
        state: Arc<AppState>,
    ) -> Self {
        let (tx, mut rx) = mpsc::channel::<Job>(queue_capacity);
        let semaphore = Arc::new(Semaphore::new(worker_count));

        // Spawn coordinator task
        let sem_clone = semaphore.clone();
        tokio::spawn(async move {
            while let Some(job) = rx.recv().await {
                let permit = sem_clone.clone().acquire_owned().await.unwrap();
                let state = state.clone();

                // Spawn worker task — permit dropped when task completes
                tokio::spawn(async move {
                    let _permit = permit; // hold permit for duration of job
                    execute_job(job, state).await;
                });
            }
        });

        Self { job_tx: tx, semaphore }
    }

    pub async fn enqueue(&self, job: Job) -> Result<(), AppError> {
        self.job_tx
            .send(job)
            .await
            .map_err(|_| AppError::Internal("Worker pool closed".into()))
    }

    pub fn active_workers(&self) -> usize {
        let total = self.semaphore.available_permits();
        // Approximation — not exact
        10 - total
    }
}

// Job executor
async fn execute_job(job: Job, state: Arc<AppState>) {
    let start = std::time::Instant::now();
    let job_id = job.job_id.clone();
    let job_type = format!("{:?}", job.job_type);

    tracing::info!(job_id = %job_id, job_type = %job_type, "Job started");

    // Update status in DB
    update_job_status(&state.db, &job_id, "running", None).await.ok();

    let result = match &job.job_type {
        JobType::ImportDocuments { file_path, batch_size } => {
            import_documents_job(&state, file_path, *batch_size).await
        }
        JobType::SendEmail { to, template, context } => {
            send_email_job(&state, to, template, context).await
        }
        JobType::GenerateReport { report_type, date_range } => {
            generate_report_job(&state, report_type, date_range).await
        }
        _ => Ok(()),
    };

    let elapsed = start.elapsed();

    match result {
        Ok(()) => {
            tracing::info!(
                job_id = %job_id,
                elapsed_ms = elapsed.as_millis(),
                "Job completed successfully"
            );
            update_job_status(&state.db, &job_id, "completed", None).await.ok();
        }
        Err(e) => {
            tracing::error!(
                job_id = %job_id,
                error = %e,
                retry_count = job.retry_count,
                "Job failed"
            );
            handle_job_failure(&state, job, e).await;
        }
    }
}
```

### 2.2 Retry với Exponential Backoff

```rust
use std::time::Duration;

pub async fn handle_job_failure(state: &AppState, job: Job, error: AppError) {
    if job.retry_count < job.max_retries {
        // Exponential backoff: 2^retry * base_delay
        let base_delay_secs = 30u64;
        let delay_secs = base_delay_secs * 2u64.pow(job.retry_count);
        let max_delay_secs = 3600u64; // cap at 1 hour
        let delay_secs = delay_secs.min(max_delay_secs);

        let next_run_at = chrono::Utc::now() + chrono::Duration::seconds(delay_secs as i64);

        tracing::warn!(
            job_id = %job.job_id,
            retry = job.retry_count + 1,
            max_retries = job.max_retries,
            next_run_in_secs = delay_secs,
            "Scheduling job retry"
        );

        // Re-enqueue with delay
        sqlx::query!(
            r#"
            UPDATE jobs
            SET status = 'scheduled',
                retry_count = retry_count + 1,
                last_error = $1,
                next_run_at = $2
            WHERE job_id = $3
            "#,
            error.to_string(),
            next_run_at,
            job.job_id,
        )
        .execute(&state.db)
        .await
        .ok();
    } else {
        // Max retries exceeded → dead letter
        tracing::error!(
            job_id = %job.job_id,
            "Job exceeded max retries, moving to dead letter queue"
        );

        sqlx::query!(
            "UPDATE jobs SET status = 'dead', last_error = $1 WHERE job_id = $2",
            error.to_string(),
            job.job_id,
        )
        .execute(&state.db)
        .await
        .ok();

        // Alert (email/Slack/PagerDuty)
        send_dead_letter_alert(&state, &job).await.ok();
    }
}
```

---

## PHẦN 3 — Persistent Job Queue (PostgreSQL)

### 3.1 Database Schema

```sql
-- migrations/create_jobs_table.sql
CREATE TYPE job_status AS ENUM (
    'pending', 'scheduled', 'running', 'completed', 'failed', 'dead'
);

CREATE TABLE jobs (
    job_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type        VARCHAR(100) NOT NULL,
    payload         JSONB NOT NULL,
    status          job_status NOT NULL DEFAULT 'pending',
    priority        SMALLINT NOT NULL DEFAULT 5,
    max_retries     INTEGER NOT NULL DEFAULT 3,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_by      BIGINT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_run_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    worker_id       VARCHAR(100)
);

CREATE INDEX idx_jobs_status_next_run ON jobs (status, next_run_at, priority)
    WHERE status IN ('pending', 'scheduled');
CREATE INDEX idx_jobs_created_by ON jobs (created_by);
CREATE INDEX idx_jobs_created_at ON jobs (created_at DESC);
```

### 3.2 Job Queue Implementation

```rust
pub struct PgJobQueue {
    db: sqlx::PgPool,
    worker_id: String, // unique per instance
}

impl PgJobQueue {
    pub fn new(db: sqlx::PgPool) -> Self {
        Self {
            db,
            worker_id: format!("{}-{}", hostname(), uuid::Uuid::new_v4()),
        }
    }

    // Enqueue job từ HTTP handler
    pub async fn enqueue(
        &self,
        job_type: &str,
        payload: serde_json::Value,
        options: EnqueueOptions,
    ) -> Result<String, AppError> {
        let job_id = uuid::Uuid::new_v4().to_string();

        sqlx::query!(
            r#"
            INSERT INTO jobs (job_id, job_type, payload, priority, max_retries,
                              next_run_at, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#,
            job_id,
            job_type,
            payload,
            options.priority as i16,
            options.max_retries as i32,
            options.run_at.unwrap_or_else(chrono::Utc::now),
            options.created_by,
        )
        .execute(&self.db)
        .await?;

        tracing::info!(job_id = %job_id, job_type = %job_type, "Job enqueued");
        Ok(job_id)
    }

    // Atomic dequeue: SELECT FOR UPDATE SKIP LOCKED
    // Critical: SKIP LOCKED prevents multiple workers from getting same job
    pub async fn dequeue(&self, batch_size: u32) -> Result<Vec<JobRecord>, AppError> {
        let jobs = sqlx::query_as!(JobRecord,
            r#"
            UPDATE jobs
            SET status = 'running',
                started_at = NOW(),
                worker_id = $1
            WHERE job_id IN (
                SELECT job_id FROM jobs
                WHERE status IN ('pending', 'scheduled')
                  AND next_run_at <= NOW()
                ORDER BY priority ASC, next_run_at ASC
                LIMIT $2
                FOR UPDATE SKIP LOCKED
            )
            RETURNING *
            "#,
            self.worker_id,
            batch_size as i64,
        )
        .fetch_all(&self.db)
        .await?;

        Ok(jobs)
    }

    // Mark job complete
    pub async fn complete(&self, job_id: &str) -> Result<(), AppError> {
        sqlx::query!(
            "UPDATE jobs SET status = 'completed', completed_at = NOW() WHERE job_id = $1",
            job_id
        )
        .execute(&self.db)
        .await?;
        Ok(())
    }

    // Mark job failed (with retry)
    pub async fn fail(
        &self,
        job_id: &str,
        error: &str,
        next_run_at: Option<chrono::DateTime<chrono::Utc>>,
    ) -> Result<(), AppError> {
        let new_status = if next_run_at.is_some() { "scheduled" } else { "dead" };

        sqlx::query!(
            r#"
            UPDATE jobs
            SET status = $1::job_status,
                last_error = $2,
                retry_count = retry_count + 1,
                next_run_at = COALESCE($3, next_run_at),
                worker_id = NULL
            WHERE job_id = $4
            "#,
            new_status,
            error,
            next_run_at,
            job_id,
        )
        .execute(&self.db)
        .await?;
        Ok(())
    }

    // Job stats (for dashboard)
    pub async fn get_stats(&self) -> Result<JobStats, AppError> {
        sqlx::query_as!(JobStats,
            r#"
            SELECT
                COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                COUNT(*) FILTER (WHERE status = 'running') AS running,
                COUNT(*) FILTER (WHERE status = 'completed') AS completed,
                COUNT(*) FILTER (WHERE status = 'failed') AS failed,
                COUNT(*) FILTER (WHERE status = 'dead') AS dead,
                AVG(EXTRACT(EPOCH FROM (completed_at - started_at)))
                    FILTER (WHERE status = 'completed') AS avg_duration_secs
            FROM jobs
            WHERE created_at > NOW() - INTERVAL '24 hours'
            "#
        )
        .fetch_one(&self.db)
        .await
        .map_err(AppError::Database)
    }
}

#[derive(Debug)]
pub struct EnqueueOptions {
    pub priority: u8,
    pub max_retries: u32,
    pub run_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_by: Option<i64>,
}

impl Default for EnqueueOptions {
    fn default() -> Self {
        Self {
            priority: 5,
            max_retries: 3,
            run_at: None,
            created_by: None,
        }
    }
}
```

### 3.3 Worker Loop

```rust
use tokio::time::{interval, Duration};

pub struct JobWorker {
    queue: Arc<PgJobQueue>,
    state: Arc<AppState>,
    poll_interval: Duration,
    batch_size: u32,
}

impl JobWorker {
    pub async fn run_until_shutdown(self, mut shutdown: tokio::sync::watch::Receiver<bool>) {
        let mut ticker = interval(self.poll_interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        tracing::info!("Job worker started");

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    if let Err(e) = self.process_batch().await {
                        tracing::error!(error = %e, "Error processing job batch");
                    }
                }
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        tracing::info!("Job worker shutting down");
                        break;
                    }
                }
            }
        }

        tracing::info!("Job worker stopped");
    }

    async fn process_batch(&self) -> Result<(), AppError> {
        let jobs = self.queue.dequeue(self.batch_size).await?;

        if jobs.is_empty() {
            return Ok(());
        }

        tracing::debug!(count = jobs.len(), "Processing job batch");

        // Process jobs concurrently within batch
        let futures: Vec<_> = jobs
            .into_iter()
            .map(|job| {
                let queue = self.queue.clone();
                let state = self.state.clone();
                tokio::spawn(async move {
                    process_single_job(job, queue, state).await;
                })
            })
            .collect();

        // Wait for all jobs in batch
        futures_util::future::join_all(futures).await;

        Ok(())
    }
}

async fn process_single_job(job: JobRecord, queue: Arc<PgJobQueue>, state: Arc<AppState>) {
    let start = std::time::Instant::now();

    let result = match job.job_type.as_str() {
        "ImportDocuments" => {
            let payload: ImportDocumentsPayload = serde_json::from_value(job.payload.clone())
                .map_err(|e| AppError::Internal(e.to_string()));
            match payload {
                Ok(p) => import_documents_job(&state, &p.file_path, p.batch_size).await,
                Err(e) => Err(e),
            }
        }
        "SendEmail" => {
            let payload: SendEmailPayload = serde_json::from_value(job.payload.clone())
                .map_err(|e| AppError::Internal(e.to_string()))
                .and_then(|p| Ok(p));
            match payload {
                Ok(p) => send_email_job(&state, &p.to, &p.template, &p.context).await,
                Err(e) => Err(e),
            }
        }
        unknown => {
            tracing::error!(job_type = %unknown, "Unknown job type");
            Err(AppError::Internal(format!("Unknown job type: {}", unknown)))
        }
    };

    let elapsed = start.elapsed();

    match result {
        Ok(()) => {
            tracing::info!(
                job_id = %job.job_id,
                elapsed_ms = elapsed.as_millis(),
                "Job completed"
            );
            queue.complete(&job.job_id).await.ok();
        }
        Err(e) => {
            let retry_count = job.retry_count as u32;
            let max_retries = job.max_retries as u32;

            if retry_count < max_retries {
                let delay_secs = 30 * 2u64.pow(retry_count);
                let next_run = chrono::Utc::now() + chrono::Duration::seconds(delay_secs as i64);

                queue.fail(&job.job_id, &e.to_string(), Some(next_run)).await.ok();
            } else {
                queue.fail(&job.job_id, &e.to_string(), None).await.ok();
            }
        }
    }
}
```

---

## PHẦN 4 — Specific Job Implementations

### 4.1 Document Import Job (PDMS)

```rust
#[derive(serde::Deserialize)]
pub struct ImportDocumentsPayload {
    pub file_path: String,
    pub batch_size: u32,
    pub created_by: i64,
    pub job_id: String,  // for progress tracking
}

pub async fn import_documents_job(
    state: &AppState,
    payload: &ImportDocumentsPayload,
) -> Result<(), AppError> {
    tracing::info!(
        file = %payload.file_path,
        batch_size = payload.batch_size,
        "Import job started"
    );

    // Read CSV/Excel file
    let records = read_import_file(&payload.file_path).await?;
    let total = records.len() as u64;

    tracing::info!(total_records = total, "Parsed file");

    let mut processed = 0u64;
    let mut failed = 0u64;

    // Process in batches
    for chunk in records.chunks(payload.batch_size as usize) {
        // Bulk insert
        let titles: Vec<&str> = chunk.iter().map(|r| r.title.as_str()).collect();
        let categories: Vec<&str> = chunk.iter().map(|r| r.category.as_str()).collect();

        match sqlx::query!(
            "INSERT INTO documents (title, category, created_by, created_at)
             SELECT title, category::document_category, $3, NOW()
             FROM UNNEST($1::text[], $2::text[]) AS t(title, category)",
            &titles[..], &categories[..], payload.created_by
        )
        .execute(&state.db)
        .await {
            Ok(result) => processed += result.rows_affected(),
            Err(e) => {
                tracing::error!(error = %e, "Batch insert failed");
                failed += chunk.len() as u64;
            }
        }

        // Update progress in Redis
        let progress = serde_json::json!({
            "processed": processed,
            "failed": failed,
            "total": total,
            "percent": (processed * 100) / total.max(1),
        });
        state.redis.set(
            &format!("job:progress:{}", payload.job_id),
            &progress,
            Some(3600),
        ).await.ok();
    }

    tracing::info!(
        processed = processed,
        failed = failed,
        total = total,
        "Import job completed"
    );

    Ok(())
}
```

### 4.2 Email Notification Job

```rust
use lettre::{
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};

#[derive(serde::Deserialize)]
pub struct SendEmailPayload {
    pub to: String,
    pub template: String,
    pub context: serde_json::Value,
    pub subject: String,
}

pub async fn send_email_job(
    state: &AppState,
    payload: &SendEmailPayload,
) -> Result<(), AppError> {
    // Render template (dùng tera hoặc handlebars)
    let body = render_email_template(&payload.template, &payload.context)?;

    let email = Message::builder()
        .from("PDMS System <noreply@vpbank.com.vn>".parse().unwrap())
        .to(payload.to.parse().map_err(|_| AppError::Internal("Invalid email".into()))?)
        .subject(&payload.subject)
        .header(lettre::message::header::ContentType::TEXT_HTML)
        .body(body)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let mailer = AsyncSmtpTransport::<Tokio1Executor>::relay(&state.config.smtp_host)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .credentials(Credentials::new(
            state.config.smtp_user.clone(),
            state.config.smtp_pass.clone(),
        ))
        .build();

    mailer.send(email).await
        .map_err(|e| AppError::Internal(format!("Email send failed: {}", e)))?;

    Ok(())
}
```

---

## PHẦN 5 — HTTP API cho Jobs

### 5.1 Job Management Endpoints

```rust
use axum::{extract::Path, routing::{get, post}, Json, Router};

pub fn job_router() -> Router<AppState> {
    Router::new()
        .route("/jobs", post(enqueue_job_handler))
        .route("/jobs/:id", get(get_job_status))
        .route("/jobs/:id/progress", get(job_progress_sse))
        .route("/jobs/stats", get(job_stats))
        .route("/jobs/dead", get(list_dead_jobs))
        .route("/jobs/dead/:id/retry", post(retry_dead_job))
}

async fn enqueue_job_handler(
    State(state): State<AppState>,
    ValidatedJson(request): ValidatedJson<EnqueueJobRequest>,
) -> Result<impl IntoResponse, AppError> {
    let job_id = state.job_queue.enqueue(
        &request.job_type,
        request.payload,
        EnqueueOptions {
            priority: request.priority.unwrap_or(5),
            max_retries: request.max_retries.unwrap_or(3),
            run_at: request.run_at,
            created_by: None, // inject from auth context
        },
    ).await?;

    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({
            "job_id": job_id,
            "status": "pending",
            "progress_url": format!("/jobs/{}/progress", job_id),
        })),
    ))
}

async fn get_job_status(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let job = sqlx::query!(
        "SELECT job_id, job_type, status, retry_count, last_error, created_at, completed_at
         FROM jobs WHERE job_id = $1",
        job_id
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    // Get progress from Redis if running
    let progress = state.redis.get::<serde_json::Value>(
        &format!("job:progress:{}", job_id)
    ).await.ok().flatten();

    Ok(Json(serde_json::json!({
        "job_id": job.job_id,
        "type": job.job_type,
        "status": job.status,
        "retry_count": job.retry_count,
        "error": job.last_error,
        "created_at": job.created_at,
        "completed_at": job.completed_at,
        "progress": progress,
    })))
}

// SSE stream cho job progress
async fn job_progress_sse(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> impl IntoResponse {
    use axum::response::sse::{Event, Sse};
    use std::convert::Infallible;

    let stream = async_stream::stream! {
        loop {
            // Poll job status
            let status = sqlx::query_scalar!(
                "SELECT status::text FROM jobs WHERE job_id = $1",
                job_id
            )
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .flatten()
            .unwrap_or_else(|| "unknown".to_string());

            // Get progress
            let progress = state.redis.get::<serde_json::Value>(
                &format!("job:progress:{}", job_id)
            ).await.ok().flatten();

            let data = serde_json::json!({
                "status": status,
                "progress": progress,
            });

            yield Ok::<Event, Infallible>(
                Event::default().event("progress").data(serde_json::to_string(&data).unwrap())
            );

            // Stop streaming when job terminal
            if ["completed", "failed", "dead"].contains(&status.as_str()) {
                break;
            }

            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        }
    };

    Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default())
}
```

---

## PHẦN 6 — Graceful Shutdown

```rust
// Graceful shutdown: finish current jobs, refuse new ones

pub async fn run_application(state: Arc<AppState>) {
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

    // HTTP Server
    let http_handle = {
        let state = state.clone();
        let mut rx = shutdown_rx.clone();
        tokio::spawn(async move {
            let app = build_router(state);
            let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();

            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    rx.changed().await.ok();
                })
                .await
                .unwrap();
        })
    };

    // Job Worker
    let worker_handle = {
        let state = state.clone();
        let rx = shutdown_rx.clone();
        tokio::spawn(async move {
            let worker = JobWorker {
                queue: state.job_queue.clone(),
                state: state.clone(),
                poll_interval: Duration::from_secs(5),
                batch_size: 10,
            };
            worker.run_until_shutdown(rx).await;
        })
    };

    // Cron Scheduler
    let scheduler_handle = tokio::spawn(async move {
        let scheduler = AppScheduler::new(state.db.clone()).await.unwrap();
        scheduler.register_all_jobs().await.unwrap();
        scheduler.start().await.unwrap();
    });

    // Wait for SIGTERM or Ctrl+C
    tokio::signal::ctrl_c().await.expect("Failed to listen for ctrl+c");
    tracing::info!("Shutdown signal received");

    // Broadcast shutdown
    shutdown_tx.send(true).ok();

    // Wait for all components
    let _ = tokio::join!(http_handle, worker_handle);
    tracing::info!("All services stopped. Goodbye!");
}
```

---

## 🎯 So Sánh Spring Batch + @Scheduled

| Concept | Spring | Rust |
|---|---|---|
| Cron schedule | `@Scheduled(cron = "0 2 * * *")` | `Job::new_async("0 2 * * * *", ...)` |
| Worker pool | `ThreadPoolTaskExecutor` | `tokio::spawn` + `Semaphore` |
| Job queue | Quartz / Spring Batch | PostgreSQL + `FOR UPDATE SKIP LOCKED` |
| Retry | `@Retryable(maxAttempts = 3)` | Manual exponential backoff |
| Job monitoring | Spring Batch Admin / Actuator | Custom REST endpoints |
| Graceful shutdown | `SmartLifecycle` | `tokio::signal` + `watch::channel` |
| Dead letter | Manual | DB status = 'dead' + alert |

---

## 🏋️ Bài Tập

1. **PDMS Import Job**: Implement `ImportDocumentsJob`. HTTP POST `/imports` → enqueue → return job_id. GET `/imports/:id` → status + progress. SSE `/imports/:id/progress` → live updates.

2. **Cron Cleanup**: Schedule 3 cron jobs: (a) delete expired sessions mỗi đêm 2h, (b) archive documents older than 1 year mỗi chủ nhật, (c) log DB stats mỗi 5 phút.

3. **Worker Pool**: Implement bounded worker pool với 5 workers. Test với 50 concurrent jobs: verify max 5 chạy cùng lúc bằng cách log timestamps.

4. **Dead Letter**: Implement dead letter queue. Job fail 3 lần → move to dead letter. API: GET `/jobs/dead` → list, POST `/jobs/dead/:id/retry` → re-enqueue.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-9-Async-Tokio|Bài 9: Tokio — channels, select]]
- [[Rust-Zero-To-Hero/Bai-31-Redis-Caching|Bài 31: Redis → Job progress storage]]
- [[Rust-Zero-To-Hero/Bai-24-Axum-Advanced|Bài 24: Axum SSE → Job progress streaming]]
- [[Rust-Zero-To-Hero/Bai-34-OpenTelemetry|Bài 34: OpenTelemetry]] → tiếp theo
