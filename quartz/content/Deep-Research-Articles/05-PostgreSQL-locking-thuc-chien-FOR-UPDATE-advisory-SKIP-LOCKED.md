---
tags: [deep-research, postgresql, concurrency, for-update, advisory-lock, skip-locked]
type: article
domain: database
status: active
created: 2026-11-03
updated: 2026-11-03
source: "deep-research-report(4).md"
---

# PostgreSQL locking thực chiến: `FOR UPDATE`, advisory lock và `SKIP LOCKED`

> [!abstract] Luận đề
> Trong PostgreSQL, primitive tốt nhất thường là primitive nhỏ nhất vẫn giữ được invariant: một atomic `UPDATE` nếu đủ; `FOR UPDATE` khi cần đọc rồi kiểm tra nhiều dữ kiện; advisory lock cho tài nguyên logic; `SKIP LOCKED` cho bước claim của queue. Tất cả phải chạy trong transaction ngắn, có timeout, thứ tự khóa ổn định và telemetry.

![[assets/postgresql-locking-production-flows.png]]

*Ba flow production: transaction ngắn, queue nhiều worker và lease cho job dài. Hình do AI tạo để minh họa.*

## 1. Atomic write trước, explicit lock sau

Đừng tự động viết:

```text
SELECT → kiểm tra trong app → UPDATE
```

Hai request có thể cùng đọc một giá trị cũ. Nếu invariant biểu diễn được trong `WHERE`, một statement là boundary đơn giản nhất:

```sql
UPDATE seats
SET remaining = remaining - :requested
WHERE event_id = :event_id
  AND remaining >= :requested
RETURNING remaining;
```

| Kết quả | Diễn giải |
|---|---|
| 1 row | Reservation thành công; giá trị trả về là sau update |
| 0 row | Không tồn tại hoặc không đủ chỗ; không có mutation |

PostgreSQL mô tả `RETURNING` là dữ liệu từ các row thực sự được sửa ([PostgreSQL — UPDATE](https://www.postgresql.org/docs/current/sql-update.html)). Hãy tách “not found” và “insufficient” bằng một read phụ chỉ khi API thực sự cần phân biệt.

## 2. Khi nào `SELECT ... FOR UPDATE` là đúng

Sử dụng khi quyết định phụ thuộc vào nhiều cột/row hoặc logic khó nhét an toàn vào một statement.

```sql
BEGIN;
SET LOCAL lock_timeout = '750ms';
SET LOCAL statement_timeout = '3s';

SELECT id, available, reserved
FROM inventory
WHERE sku = :sku
FOR UPDATE;

-- ứng dụng kiểm tra invariant

UPDATE inventory
SET available = available - :qty,
    reserved  = reserved + :qty
WHERE sku = :sku;

COMMIT;
```

`FOR UPDATE` ngăn transaction khác sửa, xóa hoặc lấy row lock xung đột đến khi transaction hiện tại kết thúc ([PostgreSQL — Row-Level Locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)).

### Discipline bắt buộc

1. Bắt đầu transaction ngay trước khi lấy lock.
2. Không gọi HTTP, gửi email, upload file hoặc chờ người dùng khi đang giữ lock.
3. Khóa nhiều object theo một thứ tự toàn cục, ví dụ `ORDER BY id`.
4. Dùng `lock_timeout` để fail có kiểm soát.
5. Retry **toàn bộ transaction** với backoff + jitter khi deadlock/serialization failure.
6. Commit/rollback trong mọi đường lỗi.

> [!warning] Timeout không thay thế correctness
> `lock_timeout` chỉ giới hạn thời gian chờ. Sau timeout, transaction có thể ở trạng thái lỗi và phải rollback trước khi tái sử dụng connection.

## 3. `NOWAIT`, wait mặc định và `SKIP LOCKED`

| Mode | Khi gặp row đang khóa | Use case |
|---|---|---|
| Mặc định | Chờ | Cần đúng row đó và có latency budget |
| `NOWAIT` | Báo lỗi ngay | UI/API fail-fast hoặc thử tài nguyên khác |
| `SKIP LOCKED` | Bỏ qua row | Nhiều consumer lấy các job khác nhau |

`SKIP LOCKED` tạo view không nhất quán theo chủ đích; PostgreSQL nêu rõ nó thích hợp với queue-like table nhưng không phù hợp cho general-purpose consistent view ([PostgreSQL — SELECT](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)).

## 4. Claim queue đúng cách

Chỉ `SELECT id ... SKIP LOCKED` rồi commit là chưa đủ: sau commit, worker khác lại thấy cùng row. Hãy đổi trạng thái/ghi owner trong cùng statement claim.

```sql
WITH picked AS (
    SELECT id
    FROM jobs
    WHERE status = 'pending'
      AND run_at <= clock_timestamp()
    ORDER BY priority DESC, run_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT :batch_size
)
UPDATE jobs AS j
SET status      = 'running',
    worker_id   = :worker_id,
    claimed_at  = clock_timestamp(),
    attempt     = attempt + 1
FROM picked
WHERE j.id = picked.id
RETURNING j.*;
```

Transaction này chỉ claim rồi commit. Nếu job lâu, thêm `lease_until` và token như [[06-Lease-fencing-token-va-idempotency-cho-job-dai]].

### Index cho đường claim

```sql
CREATE INDEX CONCURRENTLY ix_jobs_claim
ON jobs (priority DESC, run_at, id)
WHERE status = 'pending';
```

Index partial giảm số row cần xét. Nhưng kiểm tra bằng `EXPLAIN (ANALYZE, BUFFERS)` với distribution production; index đúng cú pháp chưa chắc đúng workload.

### Starvation và fairness

`SKIP LOCKED` tối ưu throughput, không bảo đảm fairness tuyệt đối. Job bị khóa lâu hoặc liên tục thất bại có thể tụt lại. Cần:

- `attempt`, `last_error`, `next_attempt_at`;
- dead-letter state sau ngưỡng thử;
- watchdog đưa job `running` quá hạn về trạng thái có thể claim;
- metric tuổi của pending job lớn nhất, không chỉ queue depth.

## 5. Advisory lock: tài nguyên logic không có row

PostgreSQL gọi đây là khóa có ý nghĩa do ứng dụng định nghĩa; engine không ép mọi code path tuân thủ. Có hai lifetime ([PostgreSQL — Advisory Locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)):

| Scope | Hàm ví dụ | Giải phóng | Ghi chú |
|---|---|---|---|
| Transaction | `pg_advisory_xact_lock` | Tự động lúc transaction end | Thích hợp critical section ngắn |
| Session | `pg_advisory_lock` | Explicit unlock hoặc session end | Nguy hiểm với connection pool nếu lifecycle mơ hồ |

### Transaction-scoped, fail-fast

```sql
BEGIN;

SELECT pg_try_advisory_xact_lock(
  hashtextextended('tenant-migration:' || :tenant_id::text, 0)
) AS acquired;

-- acquired = false: bỏ qua/retry; true: chạy đoạn ngắn
COMMIT;
```

Hash có xác suất collision khác 0. Với resource có hai số 32-bit tự nhiên, dùng overload `(int, int)` để namespace rõ hơn:

```sql
SELECT pg_try_advisory_xact_lock(:resource_type, :resource_id);
```

### Session-scoped và connection pool

```sql
SELECT pg_try_advisory_lock(:key);
-- work
SELECT pg_advisory_unlock(:key);
```

Nếu connection được trả về pool trước khi unlock, request sau có thể thừa hưởng lock trên chính session đó. Dùng `try/finally`, pin đúng connection, và ưu tiên transaction scope khi có thể.

MySQL `GET_LOCK()` là session-scoped, không tự release ở `COMMIT`/`ROLLBACK`; lock được giải phóng khi explicit release hoặc session kết thúc ([MySQL 8.4 — Locking Functions](https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html)). Không được suy semantics MySQL sang PostgreSQL hoặc ngược lại.

## 6. Deadlock: engine phát hiện, ứng dụng phải retry

Ví dụ:

```text
T1: lock account 1 → đợi account 2
T2: lock account 2 → đợi account 1
```

PostgreSQL phát hiện cycle và abort một transaction. Phòng vệ tốt nhất là thứ tự nhất quán ([PostgreSQL — Deadlocks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-DEADLOCKS)):

```sql
SELECT id, balance
FROM account
WHERE id = ANY(:ids)
ORDER BY id
FOR UPDATE;
```

Retry policy:

```text
retryable = deadlock_detected (40P01)
         OR serialization_failure (40001)

delay = min(cap, base * 2^attempt) + random_jitter
```

Không retry riêng statement cuối: toàn bộ transaction phải chạy lại từ đầu trên snapshot/state mới.

## 7. Quan sát production

### Ai đang chờ ai?

```sql
SELECT
  a.pid,
  a.usename,
  a.application_name,
  a.state,
  now() - a.xact_start AS xact_age,
  now() - a.query_start AS query_age,
  pg_blocking_pids(a.pid) AS blocking_pids,
  left(a.query, 160) AS query
FROM pg_stat_activity AS a
WHERE cardinality(pg_blocking_pids(a.pid)) > 0
ORDER BY xact_age DESC NULLS LAST;
```

### Advisory lock nào đang tồn tại?

```sql
SELECT
  l.pid,
  l.locktype,
  l.mode,
  l.granted,
  l.classid,
  l.objid,
  a.application_name,
  now() - a.xact_start AS xact_age
FROM pg_locks AS l
LEFT JOIN pg_stat_activity AS a USING (pid)
WHERE l.locktype = 'advisory'
ORDER BY l.granted, xact_age DESC NULLS LAST;
```

PostgreSQL cung cấp `pg_locks` để quan sát lock hiện hữu ([PostgreSQL — `pg_locks`](https://www.postgresql.org/docs/current/view-pg-locks.html)).

### Bảng thống kê/SLO gợi ý

| Metric | Aggregation | Cảnh báo nên dựa trên |
|---|---|---|
| Lock wait | p50/p95/p99 | Vượt latency budget, không phải một giá trị ngẫu nhiên |
| Transaction age | max + histogram | `idle in transaction`, xact vượt budget |
| Deadlock | rate/5m | Tăng so với baseline |
| Claim throughput | jobs/s | Giảm trong khi pending age tăng |
| Queue lag | oldest pending age | SLA thực của job |
| Retry | count theo SQLSTATE | Hot key, deadlock hoặc isolation conflict |
| Pool | in-use, pending, timeout | Transaction dài giữ connection |

## 8. Mistakes chi tiết

| Mistake | Biểu hiện | Cơ chế gốc | Sửa |
|---|---|---|---|
| Gọi API khi giữ row lock | Lock wait tăng theo latency API | Transaction giữ lock đến end | Tách side effect ra sau commit/outbox |
| Session advisory lock qua pool | Lock “ma”, request khác không lấy được | Lock gắn session vật lý | Pin connection + finally hoặc xact lock |
| `SKIP LOCKED` chỉ `SELECT` | Job bị lấy lại sau commit | Chưa persist ownership | `UPDATE ... FROM picked RETURNING` |
| Không `ORDER BY` khi khóa nhiều row | Deadlock ngẫu nhiên | Thứ tự acquisition khác nhau | Global lock order |
| Retry vô hạn, không jitter | Retry storm | Nhiều client đồng bộ quay lại | Bounded exponential backoff + jitter |
| Dùng advisory lock thay unique constraint | Code path khác vẫn ghi trùng | Advisory lock cooperative | Dùng constraint làm backstop |
| Không đặt `lock_timeout` | Request treo đến timeout ngoài | Wait mặc định có thể dài | Local timeout + error mapping |
| Transaction mở trước khi parse/upload | Giữ connection dù chưa cần DB | Boundary quá rộng | Thu hẹp transaction |
| Batch claim quá lớn | Một worker khóa/chiếm quá nhiều | Critical section và retry cost phình | Batch nhỏ, đo p95 |

## 9. Checklist triển khai

- [ ] Invariant có thể chuyển thành atomic `UPDATE`/constraint không?
- [ ] Transaction boundary chỉ bao quanh DB work?
- [ ] Mọi multi-row lock có thứ tự ổn định?
- [ ] Có `lock_timeout`, `statement_timeout` và retry theo SQLSTATE?
- [ ] `SKIP LOCKED` dùng duy nhất cho queue-like semantics?
- [ ] Claim và state transition xảy ra atomically?
- [ ] Session advisory lock có pin/unlock đúng physical connection?
- [ ] Dashboard có blocking PID, xact age, deadlock và oldest-job age?
- [ ] Test đã inject deadlock, kill worker và connection loss?

## 10. Kết luận

PostgreSQL locking hiệu quả khi ta giữ critical section nhỏ và để database bảo vệ đúng invariant. `FOR UPDATE` không phải job scheduler; advisory lock không phải durable workflow state; `SKIP LOCKED` không phải consistent read. Dùng đúng vai trò, chúng tạo một nền tảng phối hợp đơn giản và dễ chứng minh hơn việc đưa mọi lock sang một hệ thống khác.

## Nguồn chính

- [PostgreSQL — Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL — `SELECT` / `NOWAIT` / `SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- [PostgreSQL — Advisory Lock Functions](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)
- [PostgreSQL — `UPDATE`](https://www.postgresql.org/docs/current/sql-update.html)
- [PostgreSQL — `pg_locks`](https://www.postgresql.org/docs/current/view-pg-locks.html)
- [MySQL 8.4 — `GET_LOCK()` semantics](https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html)

