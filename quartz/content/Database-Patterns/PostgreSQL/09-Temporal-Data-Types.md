# 09 — Kiểu Dữ Liệu Thời Gian Tối Ưu trong PostgreSQL

> **Audience:** Backend engineers hay gặp bug timezone, lúng túng khi chọn giữa timestamp/timestamptz/date.  
> **Scope:** Semantic chính xác của từng type, timezone gotchas, storage/performance, và decision guide.  
> **Liên kết:** [[06-Query-Planner]] | [[05-Performance-Tuning]] | [[00-PostgreSQL-Hub]]

---

## 📋 Mục lục

1. [Inventory — PostgreSQL có những type nào?](#1-inventory--postgresql-có-những-type-nào)
2. [TIMESTAMP vs TIMESTAMPTZ — Khác nhau quan trọng nhất](#2-timestamp-vs-timestamptz)
3. [Timezone gotchas — Những cái bẫy phổ biến](#3-timezone-gotchas)
4. [DATE, TIME, INTERVAL — Khi nào dùng?](#4-date-time-interval)
5. [Storage và Performance](#5-storage-và-performance)
6. [Indexing temporal data](#6-indexing-temporal-data)
7. [Chuyển đổi và hiển thị](#7-chuyển-đổi-và-hiển-thị)
8. [Decision Guide — Banking/PDMS context](#8-decision-guide)

---

## 1. Inventory — PostgreSQL có những type nào?

```
┌─────────────────────────────────────────────────────────────────────┐
│               PostgreSQL Temporal Types                              │
│                                                                     │
│  Type                  │ Storage │ Range                            │
│  ──────────────────────┼─────────┼─────────────────────────────── │
│  DATE                  │ 4 bytes │ 4713 BC → 5874897 AD            │
│  TIME                  │ 8 bytes │ 00:00:00 → 24:00:00             │
│  TIMETZ                │ 12 bytes│ TIME + timezone offset           │
│  TIMESTAMP             │ 8 bytes │ 4713 BC → 294276 AD             │
│  TIMESTAMPTZ           │ 8 bytes │ Same (stored as UTC)            │
│  INTERVAL              │ 16 bytes│ -178M years → 178M years        │
│                                                                     │
│  Also useful:                                                       │
│  BIGINT (epoch ms)     │ 8 bytes │ Unix timestamp in milliseconds   │
│  INT    (epoch s)      │ 4 bytes │ Unix timestamp in seconds        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. TIMESTAMP vs TIMESTAMPTZ

### Định nghĩa chính xác

```
TIMESTAMP (without time zone):
  Lưu: "wall clock time" — đúng như bạn nhập
  Không lưu timezone
  Không convert khi đọc ra
  Ý nghĩa: "điểm thời gian trên đồng hồ tường"

TIMESTAMPTZ (with time zone):
  Lưu: UTC timestamp bên trong (8 bytes, giống TIMESTAMP)
  Khi INSERT: convert input → UTC để lưu
  Khi SELECT: convert UTC → session timezone để hiển thị
  Ý nghĩa: "điểm thời gian tuyệt đối trong vũ trụ"
```

```
┌──────────────────────────────────────────────────────────────────┐
│            TIMESTAMP vs TIMESTAMPTZ — Visual                      │
│                                                                  │
│  Bạn INSERT: '2026-05-06 14:30:00'                               │
│                                                                  │
│  TIMESTAMP:                                                      │
│  ┌────────────────────────────────────────┐                      │
│  │ DB stores: 2026-05-06 14:30:00         │ ← giữ nguyên         │
│  │ Session TZ: Asia/Ho_Chi_Minh (UTC+7)   │                      │
│  │ SELECT returns: 2026-05-06 14:30:00    │ ← giữ nguyên         │
│  │                                        │                      │
│  │ Session TZ: America/New_York (UTC-4)   │                      │
│  │ SELECT returns: 2026-05-06 14:30:00    │ ← VẪN giữ nguyên!    │
│  └────────────────────────────────────────┘                      │
│                                                                  │
│  TIMESTAMPTZ:                                                    │
│  ┌────────────────────────────────────────┐                      │
│  │ Assumes session TZ: Asia/Ho_Chi_Minh   │                      │
│  │ DB stores: 2026-05-06 07:30:00 UTC     │ ← convert to UTC     │
│  │                                        │                      │
│  │ Session TZ: Asia/Ho_Chi_Minh (UTC+7)   │                      │
│  │ SELECT returns: 2026-05-06 14:30:00+07 │ ← convert back       │
│  │                                        │                      │
│  │ Session TZ: America/New_York (UTC-4)   │                      │
│  │ SELECT returns: 2026-05-06 03:30:00-04 │ ← different display! │
│  └────────────────────────────────────────┘                      │
│                                                                  │
│  Cùng một moment in time, hiển thị theo timezone người dùng     │
└──────────────────────────────────────────────────────────────────┘
```

### Code so sánh

```sql
-- Setup
SET timezone = 'Asia/Ho_Chi_Minh';  -- UTC+7

CREATE TABLE demo (
    ts  TIMESTAMP,
    tsz TIMESTAMPTZ
);

INSERT INTO demo VALUES ('2026-05-06 14:30:00', '2026-05-06 14:30:00');

SELECT ts, tsz FROM demo;
-- ts:  2026-05-06 14:30:00      (không đổi)
-- tsz: 2026-05-06 14:30:00+07  (thêm offset)

-- Đổi timezone session
SET timezone = 'UTC';
SELECT ts, tsz FROM demo;
-- ts:  2026-05-06 14:30:00      (VẪN không đổi — đây là gotcha!)
-- tsz: 2026-05-06 07:30:00+00  (convert sang UTC → khác!)
```

### Khuyến nghị rõ ràng

```
LUÔN dùng TIMESTAMPTZ cho:
✓ created_at, updated_at, deleted_at
✓ event timestamps, audit logs
✓ bất kỳ "khi nào điều này xảy ra"
✓ distributed systems với nhiều timezone
✓ banking transactions (cần absolute time)

TIMESTAMP (without TZ) chỉ hợp lý khi:
→ Dữ liệu vốn không có timezone context
  Ví dụ: "lịch làm việc" — 09:00 sáng thứ Hai nghĩa là 09:00
  bất kể timezone, không convert
→ Calendar/scheduling data
→ Historical data không biết timezone gốc
```

---

## 3. Timezone gotchas

### Gotcha 1: Server timezone ≠ Application timezone ≠ Client timezone

```
┌──────────────────────────────────────────────────────────────────┐
│                  Timezone Flow                                     │
│                                                                  │
│  Java App       JDBC Driver    PostgreSQL    PostgreSQL           │
│  (Asia/HCM)  →  (UTC)      →  (UTC)      →  stores UTC          │
│                                                                  │
│  Khi app SET timezone không khớp với server config:              │
│  → Data insert đúng timezone                                     │
│  → Nhưng query "WHERE created_at > NOW()" có thể trả về          │
│    kết quả không expected nếu NOW() tính theo timezone khác      │
│                                                                  │
│  Giải pháp: Luôn set timezone explicitly trong connection:       │
│  SET timezone = 'UTC';  -- hoặc timezone app của bạn             │
└──────────────────────────────────────────────────────────────────┘
```

```java
// Spring Boot / HikariCP — set timezone cho connection
spring.datasource.hikari.connection-init-sql=SET timezone='UTC'

// Hoặc trong application.properties:
spring.jpa.properties.hibernate.jdbc.time_zone=UTC
```

### Gotcha 2: NOW() và CURRENT_TIMESTAMP

```sql
-- NOW() và CURRENT_TIMESTAMP trả về TIMESTAMPTZ (aware)
-- Luôn dùng TIMESTAMPTZ khi compare với NOW()

-- ✓ Safe comparison
WHERE created_at > NOW() - INTERVAL '1 day'
WHERE created_at AT TIME ZONE 'UTC' > NOW() AT TIME ZONE 'UTC' - INTERVAL '1 day'

-- ⚠️ Potential issue với TIMESTAMP column:
-- TIMESTAMP vs TIMESTAMPTZ comparison → implicit cast có thể sai timezone
SELECT * FROM events WHERE event_time > NOW();
-- event_time TIMESTAMP: PostgreSQL casts NOW() sang local timestamp
-- → đúng nếu session timezone nhất quán, sai nếu không
```

### Gotcha 3: DST (Daylight Saving Time)

```
Khi timezone có DST:
  America/New_York: UTC-5 (winter) / UTC-4 (summer)

  Với TIMESTAMP (no TZ):
  Một số "local times" không tồn tại (clock jumps forward)
  Một số "local times" xảy ra 2 lần (clock falls back)
  → Ambiguous! Bug phổ biến trong scheduling systems

  Với TIMESTAMPTZ:
  Store UTC → không có DST ambiguity
  Display theo timezone requested → handle DST khi display

  → TIMESTAMPTZ là cách duy nhất tránh DST bugs hoàn toàn
```

### Gotcha 4: to_timestamp() với epoch

```sql
-- to_timestamp() trả về TIMESTAMPTZ (có timezone context)
SELECT to_timestamp(1746500000);
-- → 2025-05-06 03:13:20+00 (UTC)

-- Epoch trong Java: System.currentTimeMillis() / 1000 → seconds
-- Epoch trong JavaScript: Date.now() → milliseconds

-- PostgreSQL:
SELECT to_timestamp(1746500000000 / 1000.0);  -- nếu ms epoch
```

---

## 4. DATE, TIME, INTERVAL

### DATE — Chỉ ngày, không giờ

```sql
-- 4 bytes, không có timezone concept
-- Dùng khi: ngày sinh, ngày hợp đồng, ngày hết hạn

CREATE TABLE contracts (
    id              BIGSERIAL PRIMARY KEY,
    signed_date     DATE,           -- ngày ký (không cần giờ)
    effective_date  DATE,           -- ngày hiệu lực
    expiry_date     DATE,           -- ngày hết hạn
    created_at      TIMESTAMPTZ     -- khi nào record được tạo (cần giờ)
);

-- Arithmetic với DATE:
SELECT expiry_date - signed_date AS days_valid FROM contracts WHERE id = 1;
SELECT expiry_date - CURRENT_DATE AS days_remaining FROM contracts WHERE id = 1;

-- Range check:
WHERE CURRENT_DATE BETWEEN effective_date AND expiry_date
```

### TIME và TIMETZ — Hiếm khi dùng

```sql
-- TIME: chỉ giờ phút giây, không có ngày, không có timezone
-- TIMETZ: TIME + timezone offset (12 bytes, awkward)

-- Use case hiếm: lịch làm việc cố định
CREATE TABLE work_schedule (
    day_of_week  INTEGER,          -- 1=Mon...7=Sun
    start_time   TIME,             -- '09:00:00'
    end_time     TIME              -- '18:00:00'
);

-- TIMETZ thường là antipattern — prefer TIMESTAMPTZ với ngày cụ thể
-- hoặc INTERVAL cho duration
```

### INTERVAL — Duration, không phải điểm thời gian

```sql
-- 16 bytes: months (4B) + days (4B) + microseconds (8B)
-- Lưu ý: months và days là "fuzzy" (phụ thuộc calendar)

-- Dùng cho: thời gian xử lý, deadline offset, expiry duration
SELECT 
    INTERVAL '1 year 2 months 3 days 4 hours 5 minutes 6 seconds',
    INTERVAL '90 days',
    INTERVAL '2 weeks';

-- Arithmetic:
SELECT NOW() + INTERVAL '30 days' AS expires_at;
SELECT AGE(CURRENT_DATE, '1990-01-15'::DATE) AS age;  -- returns INTERVAL
SELECT EXTRACT(YEAR FROM AGE(CURRENT_DATE, birthdate)) AS years_old FROM users;

-- Gotcha: INTERVAL '1 month' khác INTERVAL '30 days'
SELECT '2026-01-31'::DATE + INTERVAL '1 month';  -- → 2026-02-28 (end of Feb)
SELECT '2026-01-31'::DATE + INTERVAL '30 days';  -- → 2026-03-02
```

---

## 5. Storage và Performance

### Storage comparison

```
┌──────────────────────────────────────────────────────────────────┐
│                    Storage Sizes                                   │
│                                                                  │
│  Type          │ Bytes │ Range             │ Precision           │
│  ─────────────┼───────┼───────────────────┼──────────────────── │
│  DATE          │  4    │ 4713BC-5874897AD  │ 1 day               │
│  TIME          │  8    │ 00:00:00-24:00:00 │ 1 microsecond       │
│  TIMETZ        │  12   │ Same + TZ offset  │ 1 microsecond       │
│  TIMESTAMP     │  8    │ 4713BC-294276AD   │ 1 microsecond       │
│  TIMESTAMPTZ   │  8    │ Same              │ 1 microsecond       │
│  INTERVAL      │  16   │ ±178M years       │ 1 microsecond       │
│  BIGINT(epoch) │  8    │ ~292M years       │ 1 ms (nếu ms epoch) │
│  INT(epoch)    │  4    │ 1970-2038!        │ 1 second            │
│                                                                  │
│  TIMESTAMP = TIMESTAMPTZ về storage (cả hai 8 bytes)             │
│  → Không có lý do dùng TIMESTAMP vì "tiết kiệm storage"          │
└──────────────────────────────────────────────────────────────────┘
```

### BIGINT epoch — Khi nào hợp lý?

```sql
-- Một số hệ thống lưu timestamp dưới dạng milliseconds epoch
-- Pros: portable, no timezone issues, easy arithmetic
-- Cons: không readable, no native date functions, index behavior

-- Conversion:
SELECT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000 AS epoch_ms;  -- → ms epoch
SELECT to_timestamp(epoch_ms / 1000.0) AS readable FROM events;

-- Index trên BIGINT epoch hoạt động tốt (simple B-tree on integer)
-- Nhưng TIMESTAMPTZ cũng dùng B-tree và hiệu quả tương đương
-- → TIMESTAMPTZ preferred vì readable và có native date functions
```

---

## 6. Indexing temporal data

### B-Tree trên TIMESTAMPTZ — Default choice

```sql
-- Standard index cho timestamp columns
CREATE INDEX idx_docs_created_at ON documents(created_at DESC);

-- Hỗ trợ:
-- WHERE created_at > '2026-01-01'         (range)
-- WHERE created_at BETWEEN x AND y        (range)
-- ORDER BY created_at DESC LIMIT 20       (top-N)
-- WHERE created_at = '2026-05-06 14:30:00+07' (equality)

-- Composite với timestamp PHẢI đặt range column cuối:
CREATE INDEX idx_docs_branch_created ON documents(branch_id, created_at DESC);
-- ✓ WHERE branch_id='HN01' ORDER BY created_at DESC LIMIT 20
-- ✓ WHERE branch_id='HN01' AND created_at > '2026-01-01'
```

### BRIN — Cho append-only time-series

```sql
-- Nếu dữ liệu INSERT theo thứ tự thời gian (log, event, audit):
-- BRIN rất hiệu quả: size ~1/10000 so với B-Tree

CREATE INDEX idx_audit_log_created_brin ON audit_log
USING BRIN(created_at);

-- Chỉ hiệu quả khi physical insert order = temporal order
-- Check correlation:
SELECT correlation FROM pg_stats
WHERE tablename = 'audit_log' AND attname = 'created_at';
-- correlation gần 1.0 → BRIN excellent
-- correlation gần 0.0 → dùng B-Tree
```

### Partial index cho recent data

```sql
-- Đa số queries chỉ quan tâm dữ liệu gần đây:
CREATE INDEX idx_docs_recent ON documents(created_at DESC, id DESC)
WHERE created_at > '2025-01-01';

-- Index nhỏ hơn nhiều, cache hit rate cao hơn
-- Rebuild định kỳ khi "recent" window dịch chuyển
```

### Expression index cho date extraction

```sql
-- Nếu hay query theo ngày/tháng/năm:
CREATE INDEX idx_docs_date ON documents(DATE(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh'));

-- Query PHẢI match expression chính xác:
SELECT * FROM documents
WHERE DATE(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = '2026-05-06';

-- Thường dùng TIMESTAMPTZ + date truncate tốt hơn:
WHERE created_at >= '2026-05-06 00:00:00+07'
  AND created_at <  '2026-05-07 00:00:00+07'
-- → Dùng được standard B-Tree index!
```

---

## 7. Chuyển đổi và hiển thị

### Timezone conversion

```sql
-- AT TIME ZONE — convert timezone
SELECT created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' FROM documents;
-- TIMESTAMPTZ → TIMESTAMP (local time representation)

-- Lấy timezone list:
SELECT * FROM pg_timezone_names WHERE name LIKE '%Ho_Chi%';

-- Các cách hiển thị:
SELECT 
    created_at,                                              -- UTC (nếu session=UTC)
    created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' AS local_time,
    to_char(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 
            'DD/MM/YYYY HH24:MI:SS') AS formatted
FROM documents LIMIT 1;
```

### Truncation và arithmetic

```sql
-- DATE_TRUNC — truncate về mốc thời gian
SELECT DATE_TRUNC('month', created_at) AS month FROM documents;
-- → '2026-05-01 00:00:00+00'

SELECT DATE_TRUNC('day', created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')
       AT TIME ZONE 'Asia/Ho_Chi_Minh' AS local_day
FROM documents;
-- → Truncate theo ngày LOCAL (không phải UTC day!)

-- EXTRACT / DATE_PART
SELECT 
    EXTRACT(YEAR FROM created_at) AS year,
    EXTRACT(MONTH FROM created_at) AS month,
    EXTRACT(DOW FROM created_at) AS day_of_week,  -- 0=Sun, 6=Sat
    EXTRACT(EPOCH FROM created_at) AS unix_ts
FROM documents LIMIT 1;

-- AGE — human-readable interval
SELECT AGE(expiry_date, effective_date) FROM contracts;
-- → '2 years 3 mons 15 days'
```

---

## 8. Decision Guide

```
Bạn cần lưu gì?
│
├─► "Khi nào sự kiện xảy ra" (created_at, updated_at, logged_at)
│     → TIMESTAMPTZ ✓ — luôn dùng cái này
│
├─► "Ngày tháng không có giờ" (ngày sinh, ngày ký, ngày hết hạn)
│     → DATE ✓
│     Lưu ý: "ngày hết hạn" thường ngầm hiểu là end-of-day timezone nào đó
│     → Nếu cần chính xác: TIMESTAMPTZ với time='23:59:59' local timezone
│
├─► "Khoảng thời gian / duration" (thời gian xử lý, timeout)
│     → INTERVAL ✓ (ví dụ: '30 days', '2 hours')
│     → Hoặc số nguyên seconds/milliseconds nếu chỉ dùng arithmetic
│
├─► "Lịch làm việc / schedule không có timezone"
│     → TIMESTAMP (no TZ) + application enforces timezone
│     → Hoặc TIME cho giờ trong ngày
│
├─► "Unix epoch từ external system"
│     → Nhận vào: BIGINT (ms) hoặc INT (seconds)
│     → Lưu trong DB: convert sang TIMESTAMPTZ ngay lập tức
│     → Đừng lưu epoch lâu dài (mất khả năng dùng date functions)
│
├─► "Cần performance tối đa, data append-only (log/event)"
│     → TIMESTAMPTZ + BRIN index
│
└─► Banking/PDMS — các timestamps quan trọng:
      created_at, updated_at, deleted_at  → TIMESTAMPTZ NOT NULL DEFAULT NOW()
      submitted_at, approved_at           → TIMESTAMPTZ (nullable)
      effective_date, expiry_date         → DATE
      processing_duration                 → INTERVAL hoặc INTEGER (ms)

─────────────────────────────────────────────────────────────
GOLDEN RULE:
  Mặc định → TIMESTAMPTZ
  Chỉ dùng TIMESTAMP khi biết chắc không có timezone context
  KHÔNG bao giờ lưu "VN time" trong TIMESTAMP thinking "it's VN DB anyway"
  → Khi user từ timezone khác, hoặc server migrate, hoặc daylight saving → bug!
```

### Spring Boot setup chuẩn

```java
// application.properties
spring.jpa.properties.hibernate.jdbc.time_zone=UTC

// Entity
@Column(name = "created_at", nullable = false)
private Instant createdAt;   // Java Instant = UTC, maps to TIMESTAMPTZ

@PrePersist
protected void onCreate() {
    this.createdAt = Instant.now();
}

// Hoặc với LocalDateTime (nếu app đã chuẩn hóa UTC):
@Column(name = "created_at", nullable = false)
@CreationTimestamp
private LocalDateTime createdAt;
// + hibernate.jdbc.time_zone=UTC → store as UTC in TIMESTAMPTZ
```

---

## Related Notes

- [[05-Performance-Tuning]] — BRIN index cho time-series
- [[04-Index-Internals]] — B-Tree vs BRIN, expression indexes
- [[06-Query-Planner]] — Planner và timestamp range queries

---

*Tags: #postgresql #timestamp #timezone #datatypes #performance*  
*Created: 2026-05-06 | Difficulty: ⭐⭐*
