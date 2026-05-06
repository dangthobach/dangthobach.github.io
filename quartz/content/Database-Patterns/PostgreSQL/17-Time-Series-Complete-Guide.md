# 17 — Time Series: PostgreSQL & Oracle Full-Feature Guide

> **Audience:** Engineers xây dựng time-series data systems — metrics, IoT, financial ticks, audit logs.  
> **Scope:** Schema design, partitioning, compression, specialized queries, TimescaleDB, Oracle features, common mistakes.  
> **Liên kết:** [[09-Temporal-Data-Types]] | [[05-Performance-Tuning]] | [[00-PostgreSQL-Hub]]

---

## 📋 Mục lục

1. [Time Series đặc điểm và challenges](#1-characteristics)
2. [Schema design — Foundations matter](#2-schema-design)
3. [Partitioning — The essential pattern](#3-partitioning)
4. [Querying patterns — Aggregation, resampling, gaps](#4-querying-patterns)
5. [Window functions cho time-series](#5-window-functions)
6. [BRIN index và time-series indexing](#6-indexing)
7. [Data lifecycle — Retention, archiving, compression](#7-data-lifecycle)
8. [TimescaleDB — PostgreSQL time-series extension](#8-timescaledb)
9. [Oracle time-series features](#9-oracle)
10. [Common Mistakes](#10-common-mistakes)

---

## 1. Characteristics

Time-series data có pattern đặc biệt cần optimize theo:

```
┌──────────────────────────────────────────────────────────────────────┐
│               Time Series Data Characteristics                        │
│                                                                      │
│  INSERT pattern:  Append-only, ordered by time, high throughput      │
│  ─────────────────────────────────────────────────────────────────  │
│  time  │ ... │ ... │ ... │ ... │ ... │ ...                           │
│  t+1     t+2   t+3   t+4   t+5   t+6   t+7   → always appending    │
│                                                                      │
│  UPDATE: Rare or never (immutable historical data)                   │
│  DELETE: Bulk (TTL-based: "delete all data older than 90 days")      │
│  READ:   Recent data (hot), old data (cold, archived)                │
│          Range queries ("last 24 hours"), aggregations               │
│                                                                      │
│  Key challenges:                                                     │
│  1. Volume: 1M+ rows/day is common                                   │
│  2. Cardinality: timestamps nearly unique → B-Tree deep              │
│  3. Hot/cold data: 90% queries on last 10% data                      │
│  4. Retention: must delete old data efficiently                      │
│  5. Resampling: "average per 5 min" from second-level data           │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. Schema Design

### Core time-series table pattern

```sql
-- Document processing metrics (PDMS context):
CREATE TABLE document_events (
    -- Time + entity → natural composite key
    occurred_at     TIMESTAMPTZ NOT NULL,
    doc_id          BIGINT NOT NULL,
    branch_id       TEXT NOT NULL,

    -- Event data
    event_type      TEXT NOT NULL,  -- 'submitted', 'approved', 'rejected'
    processing_ms   INTEGER,        -- duration of this event
    reviewer_id     BIGINT,
    metadata        JSONB,

    -- Derived (for fast aggregation, optional)
    hour_bucket     TIMESTAMPTZ GENERATED ALWAYS AS
                    (date_trunc('hour', occurred_at)) STORED

) PARTITION BY RANGE (occurred_at);

-- Financial tick data:
CREATE TABLE price_ticks (
    tick_time   TIMESTAMPTZ NOT NULL,
    symbol      TEXT NOT NULL,
    price       NUMERIC(12,4) NOT NULL,
    volume      BIGINT NOT NULL,
    bid         NUMERIC(12,4),
    ask         NUMERIC(12,4)
) PARTITION BY RANGE (tick_time);

-- IoT sensor readings:
CREATE TABLE sensor_readings (
    recorded_at  TIMESTAMPTZ NOT NULL,
    sensor_id    TEXT NOT NULL,
    metric       TEXT NOT NULL,     -- 'temperature', 'humidity', etc.
    value        DOUBLE PRECISION NOT NULL,
    quality      SMALLINT DEFAULT 100  -- data quality score 0-100
) PARTITION BY RANGE (recorded_at);
```

### Choosing PRIMARY KEY for time-series

```sql
-- Option 1: (time, entity) — natural, good for partition pruning
-- No auto-increment overhead
PRIMARY KEY (occurred_at, doc_id)
-- Problem: if same doc has multiple events per microsecond → collision

-- Option 2: Surrogate + time column (more flexible)
id          BIGSERIAL,
occurred_at TIMESTAMPTZ NOT NULL,
PRIMARY KEY (occurred_at, id)  -- still partition-friendly

-- Option 3: No explicit PK (for pure append-only, maximum INSERT speed)
-- TimescaleDB recommends this for hypertables

-- ✅ For most cases: (time, entity_id) composite PK
-- Time first → partition pruning works
-- Entity second → efficient point lookups within partition
```

---

## 3. Partitioning

Partitioning is **mandatory** for time-series at scale — not optional.

```
┌──────────────────────────────────────────────────────────────────────┐
│               Time-based Partitioning Strategy                        │
│                                                                      │
│  Choose partition granularity based on:                              │
│  - Volume per day                                                    │
│  - Retention period                                                  │
│  - Query range typical size                                          │
│                                                                      │
│  Guidelines:                                                         │
│  < 1M rows/day   → MONTHLY partitions                                │
│  1-10M rows/day  → WEEKLY partitions                                 │
│  > 10M rows/day  → DAILY partitions                                  │
│  > 100M rows/day → DAILY + sub-partition by hour                    │
│                                                                      │
│  Partition size target: 100MB - 10GB per partition                   │
└──────────────────────────────────────────────────────────────────────┘
```

```sql
-- Create monthly partitions (auto-naming pattern):
CREATE TABLE document_events_2026_01 PARTITION OF document_events
    FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-02-01 00:00:00+00');

CREATE TABLE document_events_2026_02 PARTITION OF document_events
    FOR VALUES FROM ('2026-02-01 00:00:00+00') TO ('2026-03-01 00:00:00+00');

-- ✅ Better: Use pg_partman extension for automatic partition management:
-- SELECT partman.create_parent(
--     p_parent_table := 'public.document_events',
--     p_control := 'occurred_at',
--     p_type := 'range',
--     p_interval := 'monthly',
--     p_premake := 3   -- pre-create 3 future partitions
-- );

-- Verify partition pruning is working:
EXPLAIN SELECT * FROM document_events
WHERE occurred_at BETWEEN '2026-05-01' AND '2026-05-31';
-- Look for: "document_events_2026_05" in plan
-- NOT: scanning all partitions!
```

### Sub-partitioning (two-level)

```sql
-- For very high volume: partition by month, then by branch:
CREATE TABLE events_2026_05 PARTITION OF document_events
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01')
    PARTITION BY LIST (branch_id);

CREATE TABLE events_2026_05_hn PARTITION OF events_2026_05
    FOR VALUES IN ('HN01', 'HN02', 'HN03');

CREATE TABLE events_2026_05_sg PARTITION OF events_2026_05
    FOR VALUES IN ('SG01', 'SG02');
-- → Query for HN branch in May → only scans events_2026_05_hn!
```

### Dropping old partitions (fast delete)

```sql
-- The BEST way to delete old time-series data:
-- DROP partition = instant, no vacuum needed, no bloat
DROP TABLE document_events_2023_01;
-- → 1ms regardless of partition size! vs DELETE which takes hours

-- Archive before drop:
-- 1. DETACH partition
ALTER TABLE document_events DETACH PARTITION document_events_2023_01;
-- → Now it's a standalone table, not attached to parent

-- 2. Export to cold storage (optional)
COPY document_events_2023_01 TO '/archive/events_2023_01.csv';

-- 3. Drop
DROP TABLE document_events_2023_01;

-- pg_partman can automate this with retention policy:
-- UPDATE partman.part_config SET retention = '1 year' WHERE parent_table = 'document_events';
```

---

## 4. Querying Patterns

### Pattern 1: Time bucket / Resampling

```sql
-- Aggregate raw second-level data into 5-minute buckets:
SELECT
    date_trunc('minute', occurred_at) -
        (EXTRACT(MINUTE FROM occurred_at)::INT % 5) * INTERVAL '1 minute'
        AS bucket_5min,
    branch_id,
    COUNT(*) AS event_count,
    AVG(processing_ms) AS avg_processing_ms,
    MAX(processing_ms) AS max_processing_ms,
    COUNT(*) FILTER (WHERE event_type = 'approved') AS approvals
FROM document_events
WHERE occurred_at >= NOW() - INTERVAL '24 hours'
GROUP BY bucket_5min, branch_id
ORDER BY bucket_5min, branch_id;

-- Simpler with TimescaleDB:
-- SELECT time_bucket('5 minutes', occurred_at) AS bucket, ...
```

### Pattern 2: Last-N-per-group (latest reading per sensor)

```sql
-- Latest reading per sensor (common in IoT, status monitoring):
WITH latest AS (
    SELECT sensor_id, metric,
           MAX(recorded_at) AS last_recorded
    FROM sensor_readings
    WHERE recorded_at > NOW() - INTERVAL '1 hour'
    GROUP BY sensor_id, metric
)
SELECT sr.*
FROM sensor_readings sr
JOIN latest ON sr.sensor_id = latest.sensor_id
           AND sr.metric = latest.metric
           AND sr.recorded_at = latest.last_recorded;

-- Alternative (PostgreSQL DISTINCT ON — more elegant):
SELECT DISTINCT ON (sensor_id, metric)
    sensor_id, metric, recorded_at, value
FROM sensor_readings
WHERE recorded_at > NOW() - INTERVAL '1 hour'
ORDER BY sensor_id, metric, recorded_at DESC;
-- → Returns exactly 1 row per (sensor, metric), the most recent
```

### Pattern 3: Filling gaps (no-data periods)

```sql
-- Generate time series then LEFT JOIN to fill gaps:
WITH time_spine AS (
    SELECT generate_series(
        date_trunc('hour', NOW() - INTERVAL '24 hours'),
        date_trunc('hour', NOW()),
        INTERVAL '1 hour'
    ) AS hour
),
hourly_counts AS (
    SELECT date_trunc('hour', occurred_at) AS hour, COUNT(*) AS cnt
    FROM document_events
    WHERE occurred_at > NOW() - INTERVAL '24 hours'
    GROUP BY date_trunc('hour', occurred_at)
)
SELECT
    ts.hour,
    COALESCE(hc.cnt, 0) AS event_count   -- 0 for hours with no events
FROM time_spine ts
LEFT JOIN hourly_counts hc ON hc.hour = ts.hour
ORDER BY ts.hour;
```

### Pattern 4: Moving average / Rolling statistics

```sql
-- 7-day rolling average of daily document approvals:
WITH daily_stats AS (
    SELECT
        date_trunc('day', occurred_at)::DATE AS day,
        COUNT(*) FILTER (WHERE event_type = 'approved') AS approvals
    FROM document_events
    WHERE occurred_at > NOW() - INTERVAL '90 days'
    GROUP BY 1
)
SELECT
    day,
    approvals,
    AVG(approvals) OVER (
        ORDER BY day
        ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ) AS rolling_7d_avg,
    SUM(approvals) OVER (
        ORDER BY day
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS cumulative_total
FROM daily_stats
ORDER BY day;
```

### Pattern 5: Period comparison (YoY, MoM)

```sql
-- Month-over-month comparison:
SELECT
    date_trunc('month', occurred_at) AS month,
    COUNT(*) AS current_month_events,
    LAG(COUNT(*), 1) OVER (ORDER BY date_trunc('month', occurred_at)) AS prev_month,
    ROUND(
        100.0 * (COUNT(*) - LAG(COUNT(*), 1) OVER (ORDER BY date_trunc('month', occurred_at)))
        / NULLIF(LAG(COUNT(*), 1) OVER (ORDER BY date_trunc('month', occurred_at)), 0),
    2) AS mom_pct_change
FROM document_events
GROUP BY date_trunc('month', occurred_at)
ORDER BY month;
```

### Pattern 6: Continuous aggregates / Incremental update

```sql
-- Materialized view for pre-computed hourly stats:
CREATE MATERIALIZED VIEW mv_hourly_stats AS
SELECT
    date_trunc('hour', occurred_at) AS hour,
    branch_id,
    event_type,
    COUNT(*) AS event_count,
    AVG(processing_ms) AS avg_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY processing_ms) AS p95_ms
FROM document_events
GROUP BY 1, 2, 3
WITH NO DATA;

-- Indexes on the materialized view:
CREATE INDEX ON mv_hourly_stats(hour, branch_id);

-- Refresh (CONCURRENTLY = no lock, needs UNIQUE index):
CREATE UNIQUE INDEX ON mv_hourly_stats(hour, branch_id, event_type);
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_hourly_stats;

-- Schedule with pg_cron:
SELECT cron.schedule('0 * * * *', 'REFRESH MATERIALIZED VIEW CONCURRENTLY mv_hourly_stats');
```

---

## 5. Window Functions cho Time Series

```sql
-- Lead/lag for delta calculations:
SELECT
    recorded_at,
    sensor_id,
    value,
    value - LAG(value) OVER (PARTITION BY sensor_id ORDER BY recorded_at) AS delta,
    (value - LAG(value) OVER (PARTITION BY sensor_id ORDER BY recorded_at)) /
    NULLIF(LAG(value) OVER (PARTITION BY sensor_id ORDER BY recorded_at), 0) * 100 AS pct_change
FROM sensor_readings
WHERE sensor_id = 'TEMP-001'
  AND recorded_at > NOW() - INTERVAL '1 day';

-- Detect anomalies (value exceeds 3 sigma):
WITH stats AS (
    SELECT sensor_id,
           AVG(value) AS mean,
           STDDEV(value) AS std
    FROM sensor_readings
    WHERE recorded_at > NOW() - INTERVAL '7 days'
    GROUP BY sensor_id
)
SELECT sr.*, s.mean, s.std,
       ABS(sr.value - s.mean) / NULLIF(s.std, 0) AS z_score
FROM sensor_readings sr
JOIN stats s ON s.sensor_id = sr.sensor_id
WHERE ABS(sr.value - s.mean) > 3 * s.std  -- > 3 sigma = anomaly
  AND sr.recorded_at > NOW() - INTERVAL '1 hour'
ORDER BY z_score DESC;

-- Session analysis (events within 30-min window):
SELECT
    user_id,
    occurred_at,
    event_type,
    -- Detect new session (> 30 min gap from previous)
    CASE WHEN occurred_at - LAG(occurred_at) OVER (PARTITION BY user_id ORDER BY occurred_at)
              > INTERVAL '30 minutes'
         THEN 1 ELSE 0 END AS new_session_flag
FROM user_events
ORDER BY user_id, occurred_at;
```

---

## 6. Indexing

### BRIN — The time-series index

```sql
-- BRIN excels for time-series: data physically ordered by time
-- Size: ~100-1000x smaller than B-Tree equivalent

CREATE INDEX idx_events_brin ON document_events
USING BRIN(occurred_at)
WITH (pages_per_range = 64);  -- default 128, smaller = more precise but larger index

-- Verify BRIN is useful (need high correlation):
SELECT correlation FROM pg_stats
WHERE tablename = 'document_events_2026_05' AND attname = 'occurred_at';
-- → Should be close to 1.0 (physical order matches temporal order)

-- BRIN index size comparison:
SELECT
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE tablename LIKE 'document_events%';
-- BRIN: ~48KB  vs  B-Tree: ~50MB  (for same 10M row partition)
```

### Composite indexes for time-series queries

```sql
-- Most time-series queries filter by: time range + entity
CREATE INDEX idx_events_branch_time ON document_events_2026_05
    (branch_id, occurred_at DESC);
-- Supports: WHERE branch_id='HN01' AND occurred_at > '2026-05-01'
-- Supports: ORDER BY occurred_at DESC LIMIT 20 (for branch)

-- For aggregation queries:
CREATE INDEX idx_events_covering ON document_events_2026_05
    (occurred_at, branch_id, event_type)
INCLUDE (processing_ms);
-- Index-Only Scan for: SELECT event_type, AVG(processing_ms)
-- WHERE occurred_at BETWEEN x AND y AND branch_id='HN01'
-- GROUP BY event_type
```

---

## 7. Data Lifecycle

```
┌──────────────────────────────────────────────────────────────────────┐
│                  Time Series Data Lifecycle                           │
│                                                                      │
│  HOT TIER (0-30 days):                                               │
│  ┌─────────────────────────────────────┐                             │
│  │ PostgreSQL MAIN partitions          │                             │
│  │ Full indexes (B-Tree + BRIN)        │                             │
│  │ Queries: sub-second                 │                             │
│  │ Storage: SSD                        │                             │
│  └─────────────────────────────────────┘                             │
│                     │ after 30 days                                  │
│                     ▼                                                │
│  WARM TIER (30-365 days):                                            │
│  ┌─────────────────────────────────────┐                             │
│  │ PostgreSQL DETACHED partitions      │                             │
│  │ Compressed (pg_compress or TSdb)    │                             │
│  │ Fewer indexes (just BRIN)           │                             │
│  │ Queries: seconds acceptable         │                             │
│  └─────────────────────────────────────┘                             │
│                     │ after 1 year                                   │
│                     ▼                                                │
│  COLD TIER (1+ years):                                               │
│  ┌─────────────────────────────────────┐                             │
│  │ Object storage (S3/GCS)             │                             │
│  │ Parquet files (columnar, compressed)│                             │
│  │ Query via: Athena/BigQuery/DuckDB   │                             │
│  └─────────────────────────────────────┘                             │
└──────────────────────────────────────────────────────────────────────┘
```

```sql
-- PostgreSQL table compression (native since PG16):
ALTER TABLE document_events_2025_01
    SET ACCESS METHOD columnar;  -- requires columnar extension

-- Or: Use UNLOGGED tables for temporary/replay-able data:
CREATE UNLOGGED TABLE staging_events (LIKE document_events);
-- 5-10x faster INSERT, data lost on crash (OK for re-playable sources)

-- Partition management automation with pg_partman:
SELECT partman.run_maintenance('public.document_events');
-- Auto-creates future partitions, drops old per retention policy
```

---

## 8. TimescaleDB

TimescaleDB is a PostgreSQL extension that makes time-series dramatically easier:

```sql
-- Install:
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Convert table to hypertable (automatic partitioning):
SELECT create_hypertable(
    'document_events',
    'occurred_at',
    chunk_time_interval => INTERVAL '1 week',
    if_not_exists => TRUE
);
-- → TimescaleDB auto-creates chunks (partitions) per week
-- → Transparent: all standard SQL still works!

-- Time bucket (much cleaner than manual truncation):
SELECT time_bucket('5 minutes', occurred_at) AS bucket,
       branch_id,
       COUNT(*) AS events,
       AVG(processing_ms) AS avg_ms
FROM document_events
WHERE occurred_at > NOW() - INTERVAL '24 hours'
GROUP BY bucket, branch_id
ORDER BY bucket;

-- Continuous aggregate (automatic incremental refresh):
CREATE MATERIALIZED VIEW docs_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', occurred_at) AS hour,
       branch_id,
       COUNT(*) AS events,
       AVG(processing_ms) AS avg_ms
FROM document_events
GROUP BY hour, branch_id;

-- Automatic refresh policy:
SELECT add_continuous_aggregate_policy('docs_hourly',
    start_offset => INTERVAL '2 days',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- Compression (60-90% size reduction for cold chunks):
SELECT add_compression_policy('document_events', INTERVAL '30 days');
-- Chunks older than 30 days are automatically compressed

-- Retention:
SELECT add_retention_policy('document_events', INTERVAL '1 year');
-- Chunks older than 1 year automatically dropped

-- Check compression stats:
SELECT * FROM timescaledb_information.compression_settings;
SELECT * FROM chunk_compression_stats('document_events');
```

---

## 9. Oracle Time Series Features

### Oracle DATE vs TIMESTAMP

```sql
-- Oracle DATE: stores date + time (unlike ANSI DATE which is date only!)
SELECT SYSDATE FROM dual;  -- returns date + time

-- Oracle TIMESTAMP: microsecond precision
SELECT SYSTIMESTAMP FROM dual;  -- with timezone

-- Oracle TIMESTAMP WITH TIME ZONE (equivalent to PG TIMESTAMPTZ):
SELECT TIMESTAMP '2026-05-07 14:30:00 Asia/Ho_Chi_Minh' FROM dual;

-- AT TIME ZONE:
SELECT occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh' FROM events;
```

### Oracle Interval Partitioning

```sql
-- Oracle INTERVAL partitioning: auto-creates partitions!
CREATE TABLE document_events (
    occurred_at  TIMESTAMP WITH TIME ZONE,
    branch_id    VARCHAR2(20),
    event_type   VARCHAR2(50),
    amount       NUMBER(15,2)
)
PARTITION BY RANGE (occurred_at)
INTERVAL (NUMTOYMINTERVAL(1, 'MONTH'))  -- auto monthly partitions!
(
    PARTITION p_initial VALUES LESS THAN (TIMESTAMP '2026-01-01 00:00:00+00:00')
);
-- → Oracle auto-creates partition when first row with new month arrives
-- PostgreSQL needs pg_partman or manual creation
```

### Oracle Analytic Functions (window functions)

```sql
-- Oracle's syntax, same concept as PostgreSQL:
SELECT
    occurred_at,
    branch_id,
    event_count,
    AVG(event_count) OVER (
        PARTITION BY branch_id
        ORDER BY occurred_at
        ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ) AS rolling_7d_avg,
    FIRST_VALUE(event_count) OVER (
        PARTITION BY branch_id
        ORDER BY occurred_at
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS first_val
FROM daily_branch_stats;

-- Oracle-specific: KEEP (DENSE_RANK):
SELECT
    branch_id,
    MAX(event_count) KEEP (DENSE_RANK FIRST ORDER BY occurred_at DESC)
        AS latest_event_count
FROM daily_branch_stats
GROUP BY branch_id;
```

### Oracle FLASHBACK for time-travel queries

```sql
-- Query data as it was N hours ago (unique Oracle feature):
SELECT * FROM document_events
AS OF TIMESTAMP (SYSTIMESTAMP - INTERVAL '2' HOUR);

-- As of specific SCN:
SELECT * FROM document_events AS OF SCN 12345678;

-- Very useful for: "what did the data look like before that batch job ran?"
-- No PostgreSQL equivalent (PITR requires restore, not inline query)
```

---

## 10. Common Mistakes

### Mistake 1: No partitioning (and paying for it)

```sql
-- ❌ Flat table with 500M rows:
DELETE FROM events WHERE recorded_at < NOW() - INTERVAL '90 days';
-- → Runs for HOURS, massive WAL, huge bloat, autovacuum overwhelmed

-- ✅ Partitioned:
DROP TABLE events_2023_q1;  -- → 1ms, no bloat, no vacuum needed
```

### Mistake 2: B-Tree index on timestamp (instead of BRIN)

```sql
-- ❌ Massive B-Tree on sequential timestamp:
CREATE INDEX idx_events_time ON events(occurred_at);
-- For 100M rows: B-Tree takes ~8GB+

-- ✅ BRIN: ~10KB, nearly as effective for sequential data
CREATE INDEX idx_events_time_brin ON events USING BRIN(occurred_at);
-- Check: correlation > 0.9 → BRIN is appropriate
```

### Mistake 3: SELECT * on large time range without limit

```sql
-- ❌ Returning millions of raw rows:
SELECT * FROM events WHERE occurred_at > NOW() - INTERVAL '30 days';
-- → 50M rows to application → OOM, timeout

-- ✅ Always aggregate or paginate:
SELECT date_trunc('hour', occurred_at), COUNT(*)
FROM events WHERE occurred_at > NOW() - INTERVAL '30 days'
GROUP BY 1;

-- Or paginate with keyset:
WHERE occurred_at > NOW() - INTERVAL '30 days'
  AND occurred_at < :cursor_time  -- from previous page
ORDER BY occurred_at DESC LIMIT 1000;
```

### Mistake 4: Storing timezone offset in timestamp string

```sql
-- ❌ Storing as text with offset embedded:
INSERT INTO events(ts) VALUES ('2026-05-07T14:30:00+07:00');
-- stored as TEXT → no timezone handling, no date functions

-- ✅ TIMESTAMPTZ:
INSERT INTO events(ts) VALUES ('2026-05-07T14:30:00+07:00'::TIMESTAMPTZ);
-- stored as UTC internally, displays correctly per session timezone
```

### Mistake 5: Not pre-aggregating for dashboards

```sql
-- ❌ Live aggregate on 1B row table for every dashboard load:
SELECT date_trunc('day', occurred_at), COUNT(*) FROM events GROUP BY 1;
-- → 30+ second query every page load

-- ✅ Pre-aggregate via materialized view + scheduled refresh:
-- Dashboard reads from mv_daily_stats (fast) → updated every 5 min
```

### Mistake 6: Forgetting WHERE clause on partitioned table

```sql
-- ❌ No time filter → scans ALL partitions:
SELECT COUNT(*) FROM events WHERE event_type = 'error';
-- EXPLAIN: scans 24 monthly partitions = full table scan!

-- ✅ Always include time range for partition pruning:
SELECT COUNT(*) FROM events
WHERE occurred_at > NOW() - INTERVAL '30 days'
  AND event_type = 'error';
-- EXPLAIN: scans only 1-2 relevant partitions!
```

---

## Quick Reference

```sql
-- Time buckets:
date_trunc('hour', ts)                → truncate to hour
date_trunc('minute', ts) - 
  (EXTRACT(MINUTE FROM ts)::INT % 5) * INTERVAL '1 min' → 5-min bucket

-- Latest per group:
SELECT DISTINCT ON (group_col) * FROM t ORDER BY group_col, time DESC;

-- Fill gaps:
FROM generate_series(start, end, interval) AS gs(t)
LEFT JOIN actual_data ON date_trunc('hour', ts) = gs.t

-- Rolling N-row window:
ROWS BETWEEN N PRECEDING AND CURRENT ROW

-- Rolling time window:
RANGE BETWEEN INTERVAL 'N days' PRECEDING AND CURRENT ROW

-- Fast partition delete:
ALTER TABLE parent DETACH PARTITION child;
DROP TABLE child;

-- BRIN index:
CREATE INDEX USING BRIN(ts) WITH (pages_per_range=64);

-- Anomaly detection:
WHERE ABS(value - AVG(value) OVER (...)) > 3 * STDDEV(value) OVER (...)
```

---

## Related Notes

- [[09-Temporal-Data-Types]] — TIMESTAMPTZ vs TIMESTAMP
- [[05-Performance-Tuning]] — Partitioning config, autovacuum
- [[13-Grouping-and-Aggregation]] — Window functions, FILTER clause
- [[04-Index-Internals]] — BRIN vs B-Tree internals

---

*Tags: #postgresql #oracle #timeseries #partitioning #brin #timescaledb #analytics*
*Created: 2026-05-07 | Difficulty: ⭐⭐⭐⭐*
