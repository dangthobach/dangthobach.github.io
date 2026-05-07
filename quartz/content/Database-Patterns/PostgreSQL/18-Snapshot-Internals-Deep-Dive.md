# 18 — PostgreSQL Snapshot Internals: Cơ Chế Thực Sự & Giới Hạn So Với Oracle

> **Audience:** Senior engineers cần hiểu sâu cơ chế snapshot để debug isolation bugs, tune performance, và đưa ra quyết định kiến trúc đúng đắn.
> **Scope:** Cấu trúc snapshot data structure, vòng đời đầy đủ, các vấn đề cố hữu của PostgreSQL MVCC, và cách Oracle giải quyết chúng khác biệt như thế nào.
> **Liên kết:** [[02-MVCC-Concurrency]] | [[01-ACID-Internals]] | [[15-Transaction-Isolation-Levels-Compared]] | [[08-MVCC-MySQL-PostgreSQL-Oracle]]

---

## 📋 Mục lục

1. [Snapshot là gì — Định nghĩa chính xác](#1-snapshot-là-gì--định-nghĩa-chính-xác)
2. [Cấu trúc dữ liệu thực tế trong source code](#2-cấu-trúc-dữ-liệu-thực-tế-trong-source-code)
3. [Vòng đời snapshot — Từ khi sinh đến khi chết](#3-vòng-đời-snapshot--từ-khi-sinh-đến-khi-chết)
4. [Snapshot Acquisition — Điều thực sự xảy ra](#4-snapshot-acquisition--điều-thực-sự-xảy-ra)
5. [Visibility Check — Thuật toán đầy đủ](#5-visibility-check--thuật-toán-đầy-đủ)
6. [Snapshot Export & Import — pg_export_snapshot](#6-snapshot-export--import--pg_export_snapshot)
7. [Các vấn đề cố hữu của PostgreSQL snapshot model](#7-các-vấn-đề-cố-hữu-của-postgresql-snapshot-model)
8. [Oracle Undo Segment — Kiến trúc khác biệt căn bản](#8-oracle-undo-segment--kiến-trúc-khác-biệt-căn-bản)
9. [Đối chiếu PostgreSQL vs Oracle — Bảng so sánh khoa học](#9-đối-chiếu-postgresql-vs-oracle--bảng-so-sánh-khoa-học)
10. [Hệ quả thực tế cho PDMS/Banking workloads](#10-hệ-quả-thực-tế-cho-pdmsbanking-workloads)

---

## 1. Snapshot là gì — Định nghĩa chính xác

Snapshot **không phải** là bản sao dữ liệu. Snapshot là một **predicate** — một tập điều kiện luận lý để quyết định xem một tuple phiên bản nào được "nhìn thấy" tại một thời điểm nhất định.

```
┌─────────────────────────────────────────────────────────────────────────┐
│              Snapshot = "Ảnh chụp trạng thái commit space"               │
│                                                                         │
│  Không phải: copy của dữ liệu vào thời điểm T                           │
│  Đúng hơn:   bộ quy tắc để lọc tuple nào visible                        │
│                                                                         │
│  Tương tự: không phải "chụp ảnh cuốn sách lúc 3:00 PM"                  │
│             mà là "quy tắc: tôi chỉ đọc những trang được in              │
│             trước 3:00 PM và chưa bị xé đi"                              │
└─────────────────────────────────────────────────────────────────────────┘
```

### Hai loại snapshot trong PostgreSQL

```
┌──────────────────────────────────┬──────────────────────────────────────┐
│         SnapshotNow              │        Registered Snapshot            │
│   (Statement-level snapshot)     │    (Transaction-level snapshot)       │
├──────────────────────────────────┼──────────────────────────────────────┤
│ Lấy mới mỗi statement            │ Lấy một lần khi transaction bắt đầu  │
│ READ COMMITTED behavior          │ REPEATABLE READ / SERIALIZABLE        │
│ Không cần register               │ Phải register để giữ xmin horizon     │
│ Rẻ (no ref counting)             │ Đắt hơn (cần ProcArray update)        │
└──────────────────────────────────┴──────────────────────────────────────┘
```

---

## 2. Cấu trúc dữ liệu thực tế trong source code

Đây là định nghĩa thực từ PostgreSQL source (`src/include/utils/snapshot.h`):

```c
/*
 * Snapshot — đơn giản hóa từ source PostgreSQL
 * Các field quan trọng nhất:
 */
typedef struct SnapshotData {
    SnapshotType snapshot_type; /* MVCC, Any, Self, v.v. */

    /*
     * Đây là TRÁI TIM của snapshot MVCC:
     */
    TransactionId xmin;   /* Tất cả XID < xmin đều đã committed
                             (hoặc đã aborted) khi snapshot được lấy.
                             Không cần check pg_xact cho chúng nữa. */

    TransactionId xmax;   /* Tất cả XID >= xmax đều chưa tồn tại
                             khi snapshot được lấy. Luôn invisible. */

    TransactionId *xip;   /* Mảng các XID đang in-progress
                             (đã bắt đầu nhưng chưa commit/abort)
                             xmin <= xip[i] < xmax */
    uint32  xcnt;         /* Số phần tử trong xip */

    /*
     * Cho Serializable Isolation:
     */
    TransactionId subxmin;
    TransactionId *subxip;
    int32   subxcnt;
    bool    suboverflowed;  /* xip quá lớn → cờ "có thể có thêm" */

    /*
     * Reference counting để biết khi nào có thể giải phóng:
     */
    uint32  active_count;   /* Số portal đang dùng snapshot này */
    uint32  regd_count;     /* Số lần được "registered" */
    pairingheap_node ph_node; /* Vị trí trong heap của registered snapshots */

    TimestampTz whenTaken;  /* Thời điểm snapshot được lấy (debug) */
    XLogRecPtr  lsn;        /* LSN để check WAL consistency */
} SnapshotData;
```

```
┌─────────────────────────────────────────────────────────────────────┐
│                   SnapshotData — Minh họa bộ nhớ                    │
│                                                                     │
│  xmin = 500    ──────────────────────────────────────────────────►  │
│                 Mọi XID < 500 đã settled (committed/aborted)        │
│                                                                     │
│  xmax = 520    ──────────────────────────────────────────────────►  │
│                 Mọi XID >= 520 chưa tồn tại khi snapshot lấy        │
│                                                                     │
│  xip = [502, 507, 515]   (in-progress)                              │
│         │     │     │                                               │
│         │     │     └── XID 515: đang chạy, uncommitted            │
│         │     └──────── XID 507: đang chạy, uncommitted            │
│         └────────────── XID 502: đang chạy, uncommitted            │
│                                                                     │
│  Vùng "nhìn thấy được":                                             │
│                                                                     │
│  │◄── invisible ──►│◄──────── visible (nếu committed) ────────►│   │
│  0               499  500           519  │      520 → ∞           │
│                                      [xip members → invisible]     │
└─────────────────────────────────────────────────────────────────────┘
```

### Tại sao cần xip array?

Vùng `[xmin, xmax)` **không phải tất cả đều committed**. Một số XID trong range này đang in-progress. `xip` list chính xác những XID đó.

```
Ví dụ thực tế:
  XID 500: committed (balance transfer xong)
  XID 502: in-progress (session của user A đang sửa document)
  XID 507: in-progress (batch job đang chạy)
  XID 508: committed
  XID 515: in-progress
  XID 519: committed

  Snapshot lấy lúc này:
  xmin = 502 (XID nhỏ nhất chưa committed)
  xmax = 520 (next XID sẽ được assign)
  xip  = [502, 507, 515]

  Khi check XID 508:
  → 508 trong [xmin=502, xmax=520)? YES
  → 508 trong xip=[502, 507, 515]? NO
  → Vậy 508 đã committed → VISIBLE ✓

  Khi check XID 507:
  → 507 trong [xmin=502, xmax=520)? YES
  → 507 trong xip=[502, 507, 515]? YES
  → UNCOMMITTED → INVISIBLE ✗
```

---

## 3. Vòng đời snapshot — Từ khi sinh đến khi chết

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Snapshot Lifecycle                                    │
│                                                                         │
│                    ┌──────────────────┐                                  │
│                    │  BEGIN (hoặc đầu │                                  │
│                    │  statement đầu   │                                  │
│                    │  tiên)           │                                  │
│                    └────────┬─────────┘                                  │
│                             │                                           │
│                             ▼                                           │
│              ┌──────────────────────────────┐                           │
│              │   GetTransactionSnapshot()   │                           │
│              │   hoặc GetLatestSnapshot()   │                           │
│              │                             │                           │
│              │   1. Lock ProcArrayLock      │                           │
│              │   2. Duyệt ProcArray         │                           │
│              │      (mọi running process)   │                           │
│              │   3. Tính xmin, xmax, xip    │                           │
│              │   4. Unlock ProcArrayLock    │                           │
│              └──────────────┬───────────────┘                           │
│                             │                                           │
│              ┌──────────────▼───────────────┐                           │
│              │    Snapshot object tạo ra    │                           │
│              │    (stack-allocated hoặc     │                           │
│              │     heap-allocated)          │                           │
│              └──────────────┬───────────────┘                           │
│                             │                                           │
│              ┌──────────────▼───────────────┐                           │
│              │  RegisterSnapshot() nếu cần  │                           │
│              │  → Thêm vào registered list  │                           │
│              │  → Cập nhật xmin horizon     │                           │
│              │    (ngăn VACUUM xóa tuples   │                           │
│              │     mà snapshot cần)         │                           │
│              └──────────────┬───────────────┘                           │
│                             │                                           │
│              ┌──────────────▼───────────────┐                           │
│              │   Sử dụng trong queries:     │                           │
│              │   HeapTupleSatisfiesMVCC()   │                           │
│              │   per-tuple visibility check  │                           │
│              └──────────────┬───────────────┘                           │
│                             │                                           │
│              ┌──────────────▼───────────────┐                           │
│              │  UnregisterSnapshot() /      │                           │
│              │  Transaction commit/rollback │                           │
│              │  → Xóa khỏi registered list  │                           │
│              │  → xmin horizon có thể tiến  │                           │
│              │  → VACUUM có thể tiến hành   │                           │
│              └──────────────────────────────┘                           │
└─────────────────────────────────────────────────────────────────────────┘
```

### xmin horizon — Khái niệm sống còn

**xmin horizon** = XID nhỏ nhất của tất cả active snapshots trên toàn hệ thống.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Global xmin Horizon                          │
│                                                                 │
│  Session 1 snapshot: xmin = 450                                 │
│  Session 2 snapshot: xmin = 480                                 │
│  Session 3 snapshot: xmin = 495                                 │
│                                                                 │
│  Global xmin horizon = min(450, 480, 495) = 450                 │
│                                                                 │
│  VACUUM có thể dọn dead tuples với xmax < 450                   │
│  (vì không có snapshot nào cần thấy chúng nữa)                  │
│                                                                 │
│  Nếu Session 1 giữ snapshot với xmin=450 mãi mãi:               │
│  → Global horizon bị "stuck" tại 450                            │
│  → Dead tuples từ XID 451 trở đi không thể vacuum               │
│  → BLOAT!                                                       │
│                                                                 │
│  Đây là nguồn gốc của vấn đề "long-running transactions"         │
│  trong PostgreSQL                                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Snapshot Acquisition — Điều thực sự xảy ra

Khi PostgreSQL lấy snapshot, nó phải quét **ProcArray** — mảng chứa thông tin của mọi backend process đang chạy.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       ProcArray Scan                                     │
│                                                                         │
│  ProcArray (shared memory):                                             │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  PGPROC[0]: backend PID=1001, XID=502, status=running            │  │
│  │  PGPROC[1]: backend PID=1002, XID=507, status=running            │  │
│  │  PGPROC[2]: backend PID=1003, XID=0,   status=idle               │  │
│  │  PGPROC[3]: backend PID=1004, XID=515, status=running            │  │
│  │  PGPROC[4]: autovacuum worker,  XID=518, status=running          │  │
│  │  ...                                                             │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  Quy trình GetSnapshotData():                                            │
│                                                                         │
│  1. LWLockAcquire(ProcArrayLock, LW_SHARED)   ← shared lock           │
│     (tất cả backend khác không thể commit/begin trong lúc này)          │
│                                                                         │
│  2. latestCompletedXid = ShmemVariableCache->latestCompletedXid        │
│     xmax = latestCompletedXid + 1                                       │
│                                                                         │
│  3. Duyệt mỗi PGPROC:                                                  │
│     if PGPROC.xid != InvalidXid:                                        │
│         xip[xcnt++] = PGPROC.xid                                        │
│                                                                         │
│  4. xmin = min(xip)                                                     │
│                                                                         │
│  5. LWLockRelease(ProcArrayLock)                                        │
│                                                                         │
│  Kết quả: Snapshot = {xmin=502, xmax=520, xip=[502,507,515,518]}       │
└─────────────────────────────────────────────────────────────────────────┘
```

### Chi phí của snapshot acquisition

```
O(N) trong đó N = số active backends

Với N=100 backends:
  → 100 PGPROC entries cần đọc
  → ProcArrayLock held trong suốt thời gian đó
  → Mọi transaction commit/begin phải chờ lock này

Đây là lý do:
  max_connections ảnh hưởng trực tiếp đến snapshot overhead
  1000 connections → snapshot acquisition chậm hơn ~10x so với 100
  → PgBouncer/connection pooling là CRITICAL, không phải optional
```

---

## 5. Visibility Check — Thuật toán đầy đủ

Hàm `HeapTupleSatisfiesMVCC()` trong source code thực hiện logic này:

```
┌─────────────────────────────────────────────────────────────────────────┐
│             HeapTupleSatisfiesMVCC(tuple, snapshot)                      │
│                                                                         │
│  INPUT: tuple(xmin, xmax, infomask), snapshot(xmin, xmax, xip)          │
│                                                                         │
│  PHASE 1: Check xmin (ai tạo ra tuple này?)                             │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                                                                   │  │
│  │  IF HEAP_XMIN_INVALID set in infomask:                           │  │
│  │     → xmin aborted → tuple NEVER EXISTED → return false          │  │
│  │                                                                   │  │
│  │  IF HEAP_XMIN_COMMITTED set in infomask:                         │  │
│  │     → cached result: xmin committed → skip pg_xact check         │  │
│  │     → nhảy sang PHASE 2                                          │  │
│  │                                                                   │  │
│  │  IF tuple.xmin == current transaction XID:                       │  │
│  │     → tự mình tạo ra → có thể thấy → nhảy sang PHASE 2          │  │
│  │                                                                   │  │
│  │  IF tuple.xmin in snapshot.xip:                                  │  │
│  │     → in-progress khi snapshot lấy → NOT VISIBLE → return false  │  │
│  │                                                                   │  │
│  │  IF tuple.xmin < snapshot.xmin:                                  │  │
│  │     → committed trước mọi active tx → VISIBLE (xmin ok)          │  │
│  │                                                                   │  │
│  │  IF tuple.xmin >= snapshot.xmax:                                 │  │
│  │     → chưa tồn tại khi snapshot lấy → NOT VISIBLE → return false │  │
│  │                                                                   │  │
│  │  ELSE (xmin trong [snapshot.xmin, snapshot.xmax)):               │  │
│  │     → Không trong xip → đã committed giữa chừng → VISIBLE        │  │
│  │                                                                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  PHASE 2: Check xmax (ai xóa/update tuple này?)                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                                                                   │  │
│  │  IF tuple.xmax == 0:                                             │  │
│  │     → chưa bị xóa → VISIBLE → return true ✓                     │  │
│  │                                                                   │  │
│  │  IF HEAP_XMAX_INVALID (infomask):                                │  │
│  │     → xmax aborted → xóa không thành → VISIBLE → return true ✓  │  │
│  │                                                                   │  │
│  │  IF tuple.xmax == current transaction XID:                       │  │
│  │     → tự mình xóa → NOT VISIBLE (đã xóa trong tx này)           │  │
│  │                                                                   │  │
│  │  IF tuple.xmax in snapshot.xip:                                  │  │
│  │     → xóa đang in-progress → chúng ta không thấy việc xóa        │  │
│  │     → VISIBLE → return true ✓                                    │  │
│  │                                                                   │  │
│  │  IF tuple.xmax < snapshot.xmin:                                  │  │
│  │     → xóa đã committed trước snapshot → NOT VISIBLE → false      │  │
│  │                                                                   │  │
│  │  IF tuple.xmax >= snapshot.xmax:                                 │  │
│  │     → xóa xảy ra sau snapshot → chúng ta không thấy             │  │
│  │     → VISIBLE → return true ✓                                    │  │
│  │                                                                   │  │
│  │  ELSE:                                                           │  │
│  │     Check pg_xact: xmax committed? NOT VISIBLE : VISIBLE         │  │
│  │                                                                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Minh họa với timeline thực tế

```
Timeline (thời gian trôi từ trái sang phải):

  T=1:  Tx 100 INSERT row A (salary=5000)            → committed
  T=2:  Tx 200 BEGIN (READ COMMITTED)
  T=3:  Tx 150 UPDATE row A (salary=6000)            → committed
  T=4:  Tx 200 SELECT salary FROM employees (statement 1)
                Snapshot₂₀₀ₐ = {xmin=200, xmax=201, xip=[200]}
                                (READ COMMITTED: snapshot per statement)
  T=5:  Tx 200 SELECT salary FROM employees (statement 2)
                Snapshot₂₀₀ᵦ = {xmin=200, xmax=201, xip=[200]}

  Tuples trên disk:
  Tuple A₁: (xmin=100, xmax=150, salary=5000)
  Tuple A₂: (xmin=150, xmax=0,   salary=6000)

  Tx200 statement 1 thấy gì?
  → Tuple A₁: xmax=150 < xmin=200 → committed trước snapshot → NOT VISIBLE
  → Tuple A₂: xmin=150 < xmin=200 → committed → VISIBLE, xmax=0 → VISIBLE
  → salary = 6000 ✓

  ─────────────────────────────────────────────────────────────────────

  Bây giờ với REPEATABLE READ:
  T=2': Tx 200 BEGIN (REPEATABLE READ)
  Snapshot₂₀₀ = {xmin=101, xmax=151, xip=[]}
                  (giả sử chỉ Tx100 đã committed, Tx150 chưa bắt đầu)

  T=3': Tx 150 UPDATE row A (salary=6000) → committed (sau snapshot của Tx200!)

  T=4': Tx 200 SELECT salary
  → Tuple A₁: xmin=100 < 101 → VISIBLE; xmax=150 >= xmax=151? NO.
              150 trong xip=[]? NO. 150 < xmin=101? NO.
              150 trong [101, 151)? YES, không trong xip → committed
              → xmax committed trong tầm nhìn của snapshot → NOT VISIBLE
              Hmm... cần check: 150 committed TRƯỚC snapshot (xmax=151 là next XID khi snapshot lấy)
              → 150 < 151 → đã committed trước snapshot
              → Việc xóa visible → tuple A₁ NOT VISIBLE
  → Tuple A₂: xmin=150 in [101, 151)? YES, không trong xip → committed
              Nhưng 150 >= xmax=151? NO. 150 committed trong snapshot? Check:
              150 in [xmin=101, xmax=151) và không trong xip → committed TRƯỚC snapshot
              → xmin VISIBLE. xmax=0 → VISIBLE
  → salary = 6000 ✓ (Repeatable read thấy update vì update xảy ra trước snapshot!)
```

---

## 6. Snapshot Export & Import — pg_export_snapshot

PostgreSQL cho phép chia sẻ snapshot giữa các transaction độc lập — cực kỳ hữu ích cho parallel processing.

```sql
-- Session 1 (coordinator):
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT pg_export_snapshot();
-- Returns: '00000003-00000001-1'
-- Snapshot này được "frozen" — Session 1 KHÔNG COMMIT cho đến khi workers xong

-- Session 2 (worker 1):
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET TRANSACTION SNAPSHOT '00000003-00000001-1';
SELECT * FROM large_table WHERE id % 2 = 0;   -- xử lý even rows

-- Session 3 (worker 2):
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET TRANSACTION SNAPSHOT '00000003-00000001-1';
SELECT * FROM large_table WHERE id % 2 = 1;   -- xử lý odd rows

-- Cả hai workers thấy CÙNG một snapshot → consistent parallel scan
```

```
┌──────────────────────────────────────────────────────────────────────┐
│                   Exported Snapshot Mechanism                         │
│                                                                      │
│  Session 1 (Exporter)                                                │
│  ┌─────────────────────┐                                             │
│  │ snapshot = {        │  ──── export ────►  snapshot file:          │
│  │   xmin: 500,        │                    /tmp/pg_snapshots/       │
│  │   xmax: 520,        │                    00000003-00000001-1      │
│  │   xip: [502,507]    │                                             │
│  │ }                   │                                             │
│  │ refcount: 3         │ ◄── Session 1,2,3 đều giữ reference        │
│  └─────────────────────┘                                             │
│                                                                      │
│  xmin horizon bị giữ tại 500                                         │
│  → VACUUM không thể dọn dead tuples với xmax >= 500                 │
│  → QUAN TRỌNG: Session 1 phải commit/rollback kịp thời               │
└──────────────────────────────────────────────────────────────────────┘
```

**Ứng dụng thực tế trong PDMS:**
```java
// Parallel document migration với consistent snapshot
@Transactional(isolation = Isolation.REPEATABLE_READ)
public String exportSnapshot() {
    return jdbcTemplate.queryForObject(
        "SELECT pg_export_snapshot()", String.class);
}

// Worker threads import snapshot này
// Tất cả thấy cùng dataset → không bị inconsistency khi migrate
```

---

## 7. Các vấn đề cố hữu của PostgreSQL snapshot model

### Vấn đề 1: Table Bloat từ Dead Tuples

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Table Bloat Problem                           │
│                                                                      │
│  Root cause: PostgreSQL lưu TẤT CẢ versions trong heap               │
│              (cả current lẫn old versions)                           │
│                                                                      │
│  Scenario: Bảng accounts với 1M rows, UPDATE balance mỗi giây        │
│                                                                      │
│  Sau 1 giờ:                                                          │
│  ┌─────────────────────────────────────────────────────────────┐     │
│  │  Page 1:  [dead][dead][dead][dead][live][dead][live][dead]   │     │
│  │  Page 2:  [dead][live][dead][dead][dead][live][dead][dead]   │     │
│  │  ...                                                        │     │
│  │  Page N:  [live][dead][live][dead][dead][dead][live][dead]   │     │
│  └─────────────────────────────────────────────────────────────┘     │
│                                                                      │
│  Physical size: 10x logical size (90% dead tuples!)                  │
│  Sequential scan: đọc 10x data cần thiết                             │
│  Index: trỏ vào dead tuples → index bloat                            │
│                                                                      │
│  VACUUM dọn được → nhưng KHÔNG shrink file!                          │
│  (chỉ free slots để reuse, không TRUNCATE file)                      │
│                                                                      │
│  Solution: VACUUM FULL (lock table!) hoặc pg_repack (online)         │
└──────────────────────────────────────────────────────────────────────┘
```

### Vấn đề 2: Long-Running Transaction = Bloat Accumulation

```
┌──────────────────────────────────────────────────────────────────────┐
│              Long-Running Transaction Blocking Vacuum                 │
│                                                                      │
│  T=0:    Tx_OLD BEGIN, snapshot xmin = 1000                          │
│  T=1:    Tx_OLD làm gì đó chậm (report generation, migration...)    │
│  T=100:  Hàng nghìn UPDATE diễn ra: XID 1001 → 5000                │
│          Dead tuples: (xmax=1001) đến (xmax=4999)                   │
│  T=101:  AUTOVACUUM chạy                                             │
│          Global xmin horizon = min(Tx_OLD.xmin=1000, others)        │
│          → horizon = 1000                                            │
│          → VACUUM chỉ dọn dead tuples với xmax < 1000               │
│          → Không có gì để dọn! (tất cả dead tuples có xmax >= 1001) │
│  T=200:  Tx_OLD vẫn chạy. Bloat tiếp tục tích lũy.                 │
│                                                                      │
│  Hệ quả:                                                            │
│  • Table size tăng liên tục                                          │
│  • Query plans degraded (stale statistics)                           │
│  • I/O tăng (scan nhiều dead pages)                                  │
│  • Có thể OOM nếu shared_buffers fill với bloat pages               │
└──────────────────────────────────────────────────────────────────────┘
```

```sql
-- Phát hiện long-running transactions
SELECT
    pid,
    usename,
    application_name,
    state,
    EXTRACT(EPOCH FROM (now() - xact_start))::int AS tx_duration_sec,
    EXTRACT(EPOCH FROM (now() - query_start))::int AS query_duration_sec,
    left(query, 100) AS current_query,
    age(backend_xmin) AS xmin_age  -- Bao nhiêu XID phía sau
FROM pg_stat_activity
WHERE state != 'idle'
  AND xact_start IS NOT NULL
ORDER BY tx_duration_sec DESC;

-- Alert khi tx > 5 phút và bloat có thể nghiêm trọng
-- tx_duration_sec > 300 → investigate!
```

### Vấn đề 3: Snapshot Overhead tăng theo connection count

```
┌──────────────────────────────────────────────────────────────────────┐
│              Snapshot Acquisition Cost vs Connections                 │
│                                                                      │
│  GetSnapshotData() = O(N connections) với ProcArrayLock held         │
│                                                                      │
│  100 connections:  ~5μs   per snapshot acquisition                   │
│  500 connections:  ~25μs  (linear scaling)                           │
│  1000 connections: ~50μs  + lock contention overhead                 │
│  5000 connections: ~250μs + severe contention → throughput collapse  │
│                                                                      │
│  Mỗi query cần ít nhất 1 snapshot                                    │
│  OLTP: 1000 QPS × 50μs = 5% CPU chỉ cho snapshot acquisition!       │
│                                                                      │
│  Giải pháp bắt buộc: Connection pooling (PgBouncer, pgpool-II)       │
│  Target: actual_connections < 100-200                                 │
│          client connections pooled đằng sau                          │
└──────────────────────────────────────────────────────────────────────┘
```

### Vấn đề 4: OOM từ xip Array với nhiều active transactions

```
Khi xcnt (số in-progress XIDs) lớn:
  xip array được allocated trên heap
  Mỗi snapshot: xcnt × 4 bytes

  500 active transactions × 4 bytes = 2KB per snapshot
  1000 queries/s × 2KB = 2MB/s allocation pressure

  Nếu subxip overflow (subtransactions > PGPROC_MAX_CACHED_SUBXIDS = 64):
  → suboverflowed = true
  → PostgreSQL phải scan pg_subtrans cho mọi visibility check
  → SEVERE performance degradation

  Subtransaction là root cause của nhiều production incidents!
```

```sql
-- NGUY HIỂM: Savepoints tạo subtransactions
BEGIN;
SAVEPOINT sp1;
-- ... nhiều operations ...
SAVEPOINT sp2;  -- Mỗi SAVEPOINT = 1 subtransaction
-- ... 64+ savepoints → suboverflowed = true → performance cliff!
ROLLBACK TO sp1;
COMMIT;
```

### Vấn đề 5: XID Wraparound — Catastrophic Failure Mode

```
┌──────────────────────────────────────────────────────────────────────┐
│                    XID Wraparound Horror Show                         │
│                                                                      │
│  XID space: 0 ──────────────────────────────────► 2³²-1 (4.3B)      │
│                                                                      │
│  PostgreSQL dùng modular arithmetic:                                 │
│  XID A "cũ hơn" XID B nếu B - A (mod 2³²) < 2³¹                    │
│                                                                      │
│  Normal:                                                             │
│  Current XID = 3,000,000,000                                         │
│  Tuple xmin  = 2,999,999,000  → "1000 transactions trước" → VISIBLE  │
│                                                                      │
│  Sau wraparound (chưa freeze):                                       │
│  Current XID = 500,000 (sau khi wrap)                                │
│  Tuple xmin  = 2,999,999,000                                         │
│  Diff = 500,000 - 2,999,999,000 mod 2³² = 1,295,968,296             │
│  1,295,968,296 < 2,147,483,648 (2³¹)?  YES                          │
│  → PostgreSQL nghĩ tuple "cũ" 1.3B transactions                     │
│  → Nhưng 2,999,999,000 có thể "trong tương lai" với một số logic    │
│                                                                      │
│  Thực tế: một số old tuples sẽ trở nên INVISIBLE                    │
│  → Data disappears! Không crash, không error — chỉ silent wrong data │
│  → Đây là worst possible failure mode                                │
│                                                                      │
│  Phòng ngừa: VACUUM FREEZE định kỳ, monitor age(relfrozenxid)       │
│  PostgreSQL tự động SHUT DOWN nếu approaching 3M XIDs to wraparound  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 8. Oracle Undo Segment — Kiến trúc khác biệt căn bản

Oracle giải quyết bài toán snapshot theo cách **hoàn toàn khác về cơ bản**.

### Oracle MVCC: Undo-Based Model

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Oracle vs PostgreSQL MVCC Model                    │
│                                                                      │
│  PostgreSQL (Copy-on-write trong Heap):                               │
│                                                                      │
│  Heap file:  [v1: old][v2: new][v3: newer][v4: current]              │
│              ↑ mọi versions đều nằm trong heap                       │
│              VACUUM dọn old versions                                  │
│                                                                      │
│  ─────────────────────────────────────────────────────────────────── │
│                                                                      │
│  Oracle (Undo Segment):                                              │
│                                                                      │
│  Heap file:  [current version chỉ]                                   │
│                   │                                                  │
│                   └──► Undo Segment (riêng biệt):                   │
│                          [delta: old → current]                      │
│                          [delta: older → old]                        │
│                          [delta: oldest → older]                     │
│                                                                      │
│  Để đọc "version tại thời điểm T":                                   │
│  1. Đọc current block từ heap                                        │
│  2. Apply undo deltas ngược về thời điểm T                           │
│  3. Kết quả = "constructed" snapshot                                 │
└──────────────────────────────────────────────────────────────────────┘
```

### Oracle SCN — System Change Number

Oracle không dùng XID như PostgreSQL. Oracle dùng **SCN (System Change Number)** — một monotonically increasing 48-bit number.

```
SCN ≠ XID:
  XID: identifies a specific transaction
  SCN: identifies a specific point in the database timeline
       (giống như "database timestamp" ở resolution rất cao)

SCN có 2 component:
  SCN = (base, wrap) → (48-bit effective range)

Oracle tăng SCN khi:
  - Transaction commits
  - Database checkpoint
  - Distributed transaction coordination
  - Redo log switch
```

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Oracle Snapshot via SCN                          │
│                                                                      │
│  Query bắt đầu → Oracle record SCN_query = current SCN              │
│                                                                      │
│  Khi đọc block:                                                      │
│  Block có SCN_block (khi block được modified lần cuối)               │
│                                                                      │
│  Case 1: SCN_block <= SCN_query                                      │
│          → Block phản ánh state tại/trước query time                 │
│          → Read directly (consistent!) ✓                             │
│                                                                      │
│  Case 2: SCN_block > SCN_query                                       │
│          → Block đã bị modify SAU query bắt đầu                     │
│          → Oracle cần "rollback" block về state tại SCN_query        │
│          → Vào Undo Segment, apply undo records                      │
│          → Construct "CR block" (Consistent Read block)              │
│          → Đọc CR block ✓                                            │
└──────────────────────────────────────────────────────────────────────┘
```

### Oracle Undo Segment Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Oracle Undo Tablespace                             │
│                                                                      │
│  UNDO tablespace:                                                    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Undo Segment 1 (USN=1):                                    │    │
│  │  ┌──────────┬──────────┬──────────┬──────────┐             │    │
│  │  │ Extent 1 │ Extent 2 │ Extent 3 │ Extent 4 │             │    │
│  │  │          │          │          │          │             │    │
│  │  │ Transaction Header  │          │          │             │    │
│  │  │ XID, status,        │          │          │             │    │
│  │  │ SCN, wrap#          │          │          │             │    │
│  │  │          │          │          │          │             │    │
│  │  │ Undo records:       │          │          │             │    │
│  │  │ [before-image]      │ [before] │ [before] │             │    │
│  │  │ [row-level lock]    │          │          │             │    │
│  │  └──────────┴──────────┴──────────┴──────────┘             │    │
│  │                                                             │    │
│  │  Undo Segment 2 (USN=2): ...                               │    │
│  │  Undo Segment N: ...                                       │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Segments được assign tự động khi transaction bắt đầu                │
│  Segments REUSED theo vòng tròn (circular — quan trọng!)             │
│  → Old undo bị overwrite khi segment đầy                            │
└──────────────────────────────────────────────────────────────────────┘
```

### Oracle CR Block Construction

```
┌──────────────────────────────────────────────────────────────────────┐
│                   Consistent Read Block Construction                  │
│                                                                      │
│  Data Block (current, modified by SCN=1000):                         │
│  ┌───────────────────────────────────────────────────────────┐       │
│  │ Row 1: salary=8000 (ITL: XID=Tx_C, SCN=1000, locked)    │       │
│  │ Row 2: salary=5000 (ITL: XID=Tx_A, SCN=800, committed)  │       │
│  └───────────────────────────────────────────────────────────┘       │
│                                                                      │
│  Query có SCN_query=900 → cần thấy state lúc SCN=900                │
│                                                                      │
│  Step 1: Copy block vào buffer cache (CR buffer)                     │
│  Step 2: Check ITL (Interested Transaction List) entries:            │
│          Row 1 modified at SCN=1000 > 900 → cần undo                 │
│          Row 2 modified at SCN=800 <= 900 → OK                       │
│                                                                      │
│  Step 3: Tìm undo record cho Tx_C tại SCN=1000                      │
│          Apply undo: salary 8000 → 7000 (giá trị cũ)                │
│                                                                      │
│  Step 4: Check lại: Row 1 now SCN=850 (previous version)            │
│          850 <= 900 → OK!                                            │
│                                                                      │
│  CR Block:                                                           │
│  ┌───────────────────────────────────────────────────────────┐       │
│  │ Row 1: salary=7000 (SCN=850, consistent for query)       │       │
│  │ Row 2: salary=5000 (SCN=800, consistent for query)       │       │
│  └───────────────────────────────────────────────────────────┘       │
│                                                                      │
│  Query đọc CR Block → consistent read ✓                              │
│  CR Block discarded sau khi dùng (không persist)                     │
└──────────────────────────────────────────────────────────────────────┘
```

### Oracle "ORA-01555: snapshot too old" — Hệ quả của undo model

```
┌──────────────────────────────────────────────────────────────────────┐
│              Oracle ORA-01555: Snapshot Too Old                       │
│                                                                      │
│  Vấn đề:                                                             │
│  Undo segments có kích thước hữu hạn.                                │
│  Oracle overwrite undo cũ khi cần space cho undo mới.               │
│                                                                      │
│  Scenario:                                                           │
│  T=0:   Long query bắt đầu với SCN_query=5000                        │
│  T=1:   Nhiều UPDATE diễn ra → undo segments fill up                 │
│  T=100: Undo cũ (SCN 5000-6000) bị overwrite bởi undo mới           │
│  T=101: Long query cần construct CR block cho SCN=5000               │
│         → Undo records đã bị overwrite                               │
│         → ORA-01555: snapshot too old!                               │
│         → Query FAILS, phải restart                                  │
│                                                                      │
│  PostgreSQL equivalent:                                              │
│  → KHÔNG CÓ vấn đề này!                                             │
│  → PostgreSQL giữ dead tuples miễn là có snapshot cần chúng         │
│  → Trade-off: bloat thay vì ORA-01555                                │
│                                                                      │
│  Oracle solutions:                                                   │
│  • UNDO_RETENTION parameter: bao lâu Oracle CỐ GẮNG giữ undo        │
│  • GUARANTEE retention: GUARANTEE (có thể fail DML nếu undo full)   │
│  • Tăng UNDO tablespace size                                         │
│  • Optimize long queries để chạy nhanh hơn                          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 9. Đối chiếu PostgreSQL vs Oracle — Bảng so sánh khoa học

### Bảng tổng hợp kiến trúc

```
┌──────────────────────┬────────────────────────────┬─────────────────────────────┐
│ Dimension            │ PostgreSQL                 │ Oracle                      │
├──────────────────────┼────────────────────────────┼─────────────────────────────┤
│ Storage model        │ Heap-only (all versions    │ Current version in heap,    │
│                      │ in heap file)              │ old versions in undo        │
├──────────────────────┼────────────────────────────┼─────────────────────────────┤
│ Version identifier   │ XID (32-bit, ~4.3B max)    │ SCN (48-bit, effectively    │
│                      │                            │ unlimited)                  │
├──────────────────────┼────────────────────────────┼─────────────────────────────┤
│ Snapshot mechanism   │ xmin/xmax/xip tuple        │ SCN-based CR block          │
│                      │                            │ construction                │
├──────────────────────┼────────────────────────────┼─────────────────────────────┤
│ Snapshot storage     │ In-memory SnapshotData     │ Undo segments (disk)        │
│                      │ struct                     │                             │
├──────────────────────┼────────────────────────────┼─────────────────────────────┤
│ Old version cleanup  │ VACUUM (manual or auto),   │ Automatic undo overwrite    │
│                      │ explicit background job    │ when segment wraps          │
├──────────────────────┼────────────────────────────┼─────────────────────────────┤
│ Bloat risk           │ HIGH (dead tuples in       │ LOW (undo separate from     │
│                      │ same heap)                 │ live data)                  │
├──────────────────────┼────────────────────────────┼─────────────────────────────┤
│ Snapshot age limit   │ Unlimited (snapshot        │ Limited by UNDO_RETENTION   │
│                      │ blocks vacuum but no       │ and undo tablespace size    │
│                      │ "too old" failure)         │ → ORA-01555 possible        │
├──────────────────────┼────────────────────────────┼─────────────────────────────┤
│ Long query impact    │ Blocks vacuum → bloat      │ May get ORA-01555 if undo   │
│                      │ (degraded performance)     │ overwritten (query fails)   │
├──────────────────────┼────────────────────────────┼─────────────────────────────┤
│ Read performance     │ Direct tuple access,       │ May need CR block           │
│ (hot data)           │ no reconstruction needed   │ construction (overhead)     │
├──────────────────────┼────────────────────────────┼─────────────────────────────┤
│ Write amplification  │ Writes full new tuple      │ Writes undo record + update │
│                      │ + undo in WAL              │ current (smaller writes)    │
├──────────────────────┼────────────────────────────┼─────────────────────────────┤
│ Concurrent readers   │ Zero read-write conflict   │ Zero read-write conflict    │
│                      │ (MVCC)                     │ (MVCC via CR blocks)        │
├──────────────────────┼────────────────────────────┼─────────────────────────────┤
│ Scalability          │ xip array O(connections)   │ No equivalent overhead      │
│ bottleneck           │ ProcArrayLock contention   │ SCN-based, more scalable    │
├──────────────────────┼────────────────────────────┼─────────────────────────────┤
│ Catastrophic failure │ XID wraparound (DB stops   │ No equivalent               │
│                      │ accepting writes at        │ (SCN space effectively      │
│                      │ ~2B XIDs to wraparound)    │ infinite)                   │
├──────────────────────┼────────────────────────────┼─────────────────────────────┤
│ Snapshot isolation   │ Serializable (SSI with     │ Serializable (requires      │
│ level                │ predicate locking)         │ locking, not true MVCC)     │
└──────────────────────┴────────────────────────────┴─────────────────────────────┘
```

### Điểm Oracle giải quyết tốt hơn

```
1. KHÔNG CÓ table bloat từ MVCC:
   Oracle dead data nằm trong undo (tự overwrite)
   PostgreSQL dead data chiếm heap space mãi đến khi VACUUM

2. Unlimited snapshot history (giới hạn bởi storage, không bởi logic):
   Oracle: undo_retention có thể set rất lớn nếu có disk
   PostgreSQL: snapshot không thể quá cũ (XID wraparound)

3. SCN space thực tế không bao giờ wraparound:
   Oracle SCN: 48-bit = 281 trillion → hàng triệu năm
   PostgreSQL XID: 32-bit = 4.3 billion → production DBs gặp này thực tế

4. Consistent read không block cleanup:
   Oracle có thể overwrite undo bất cứ lúc nào (trade: ORA-01555)
   PostgreSQL phải giữ dead tuples cho đến khi mọi snapshot cũ hơn release

5. Kích thước ProcArray không ảnh hưởng read path:
   Oracle visibility check không cần scan toàn bộ active sessions
   PostgreSQL: O(N) scan mỗi snapshot acquisition
```

### Điểm PostgreSQL giải quyết tốt hơn hoặc khác biệt

```
1. KHÔNG CÓ ORA-01555:
   PostgreSQL đảm bảo long queries không fail vì snapshot "quá cũ"
   (nhưng trả giá bằng bloat)

2. Simpler backup và point-in-time recovery:
   PostgreSQL WAL chứa toàn bộ before/after images
   Oracle requires undo + redo + archive logs để PITR

3. Vacuum tunable granularly:
   Per-table autovacuum settings
   Oracle undo retention là global, ít granular hơn

4. Open source, không license fee:
   Không phải điểm kỹ thuật nhưng critical cho nhiều org

5. Index-only scan với Visibility Map:
   Optimization tinh tế không có equivalent trong Oracle
```

---

## 10. Hệ quả thực tế cho PDMS/Banking workloads

### Scenarios thường gặp và cách xử lý

**Scenario 1: Document search trong khi batch update chạy**

```sql
-- PDMS: Tìm documents trong khi background job update status
-- Vấn đề: batch job tạo nhiều dead tuples → scan chậm

-- Monitoring:
SELECT
    relname,
    n_dead_tup,
    n_live_tup,
    ROUND(n_dead_tup::numeric / NULLIF(n_live_tup, 0) * 100, 2) AS bloat_ratio_pct
FROM pg_stat_user_tables
WHERE relname IN ('documents', 'document_versions', 'document_metadata')
ORDER BY bloat_ratio_pct DESC;

-- Nếu bloat_ratio_pct > 20% → aggressive vacuum:
VACUUM ANALYZE documents;

-- Tune autovacuum cho documents table (UPDATE heavy):
ALTER TABLE documents SET (
    autovacuum_vacuum_scale_factor = 0.05,   -- vacuum sau 5% dead
    autovacuum_vacuum_cost_delay = 2,         -- ít throttle hơn
    autovacuum_vacuum_cost_limit = 400        -- làm nhiều hơn mỗi lần
);
```

**Scenario 2: Long-running report query block vacuum**

```sql
-- Phát hiện reports đang block vacuum:
SELECT
    a.pid,
    a.usename,
    a.application_name,
    age(a.backend_xmin) AS xmin_horizon_age,
    EXTRACT(EPOCH FROM (now() - a.xact_start))::int AS tx_seconds,
    left(a.query, 200)
FROM pg_stat_activity a
WHERE a.backend_xmin IS NOT NULL
  AND age(a.backend_xmin) > 10000  -- đang hold xmin horizon
ORDER BY age(a.backend_xmin) DESC;

-- Nếu tx_seconds > 300 và xmin_horizon_age > 100000 → investigate!
-- Option: pg_terminate_backend(pid) nếu không critical
```

**Scenario 3: Tránh subtransaction overflow trong PDMS workflows**

```java
// NGUY HIỂM: Quá nhiều savepoints trong 1 transaction
@Transactional
public void processDocumentBatch(List<Document> docs) {
    for (Document doc : docs) {
        Object savepoint = TransactionAspectSupport
            .currentTransactionStatus().createSavepoint();
        try {
            processDocument(doc);
        } catch (Exception e) {
            TransactionAspectSupport.currentTransactionStatus()
                .rollbackToSavepoint(savepoint); // Tạo subtransaction!
        }
    }
    // 64+ documents → suboverflowed → performance cliff!
}

// TỐT HƠN: Xử lý từng document trong transaction riêng
@Transactional(propagation = Propagation.REQUIRES_NEW)
public void processDocument(Document doc) {
    // Nếu fail → chỉ rollback 1 transaction nhỏ
    // Không cần savepoints
}
```

**Scenario 4: Exported snapshot cho parallel document migration**

```java
// Coordinator service
@Service
public class DocumentMigrationCoordinator {

    @Transactional(isolation = Isolation.REPEATABLE_READ)
    public void coordinateMigration() {
        // Lấy snapshot nhất quán
        String snapshotId = jdbcTemplate.queryForObject(
            "SELECT pg_export_snapshot()", String.class);

        // Chia công việc cho workers
        long totalDocs = jdbcTemplate.queryForObject(
            "SELECT COUNT(*) FROM documents WHERE status = 'pending'",
            Long.class);

        // Launch workers với cùng snapshot
        int workerCount = 4;
        List<CompletableFuture<Void>> futures = new ArrayList<>();
        for (int i = 0; i < workerCount; i++) {
            final int workerId = i;
            futures.add(CompletableFuture.runAsync(() ->
                migrationWorker.process(snapshotId, workerId, workerCount)
            ));
        }

        // Đợi tất cả workers xong
        CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
        // Transaction kết thúc → snapshot released → VACUUM có thể tiến hành
    }
}

@Service
public class DocumentMigrationWorker {

    @Transactional(isolation = Isolation.REPEATABLE_READ)
    public void process(String snapshotId, int workerId, int totalWorkers) {
        // Import shared snapshot
        jdbcTemplate.execute("SET TRANSACTION SNAPSHOT '" + snapshotId + "'");

        // Mỗi worker xử lý partition của data
        jdbcTemplate.query(
            "SELECT * FROM documents WHERE status='pending' AND id % ? = ?",
            new Object[]{totalWorkers, workerId},
            rs -> { /* migrate */ }
        );
    }
}
```

### Monitoring snapshot health trong production

```sql
-- Dashboard query: Snapshot health check
WITH snapshot_info AS (
    SELECT
        pid,
        usename,
        application_name,
        state,
        backend_xmin,
        age(backend_xmin) AS xmin_age,
        EXTRACT(EPOCH FROM (now() - xact_start))::int AS tx_age_sec
    FROM pg_stat_activity
    WHERE backend_xmin IS NOT NULL
),
bloat_info AS (
    SELECT
        relname,
        n_dead_tup,
        n_live_tup,
        CASE WHEN n_live_tup > 0
             THEN ROUND(n_dead_tup::numeric / n_live_tup * 100, 1)
             ELSE 0 END AS dead_pct
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
)
SELECT
    'SNAPSHOT_HEALTH' AS check_type,
    (SELECT COUNT(*) FROM snapshot_info WHERE xmin_age > 1000000) AS long_horizon_count,
    (SELECT MAX(xmin_age) FROM snapshot_info) AS max_xmin_age,
    (SELECT MAX(tx_age_sec) FROM snapshot_info) AS max_tx_sec,
    (SELECT SUM(n_dead_tup) FROM bloat_info) AS total_dead_tuples,
    (SELECT MAX(dead_pct) FROM bloat_info) AS max_table_dead_pct,
    (SELECT relname FROM bloat_info ORDER BY dead_pct DESC LIMIT 1) AS most_bloated_table;
```

---

## Tóm tắt — Mental Model hoàn chỉnh

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  PostgreSQL Snapshot — Big Picture                       │
│                                                                         │
│  Snapshot = predicate {xmin, xmax, xip}                                 │
│  → Không phải bản sao data                                              │
│  → Định nghĩa tập committed transactions "nhìn thấy được"               │
│                                                                         │
│  Chi phí:                                                               │
│  • Acquisition: O(N connections), ProcArrayLock                         │
│  • Storage: dead tuples trong heap đến khi VACUUM                       │
│  • Risk: XID wraparound (32-bit), long-tx bloat                         │
│                                                                         │
│  Oracle giải quyết:                                                     │
│  • Undo segments (circular) → không bloat heap                          │
│  • SCN (48-bit) → không wraparound trong thực tế                        │
│  • CR block construction → reads luôn consistent                        │
│  • Trade-off: ORA-01555 khi undo bị overwrite                           │
│                                                                         │
│  Cho banking workloads:                                                 │
│  • Monitor xmin horizon, bloat ratio, long transactions                 │
│  • Tune autovacuum aggressively cho UPDATE-heavy tables                 │
│  • Tránh subtransaction overflow (< 64 savepoints per tx)               │
│  • Dùng exported snapshots cho consistent parallel processing           │
│  • Connection pooling là mandatory (không phải optional)                │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Related Notes

- [[02-MVCC-Concurrency]] — MVCC cơ bản: xmin/xmax, dead tuples, vacuum lifecycle
- [[01-ACID-Internals]] — WAL, checkpoint, crash recovery
- [[15-Transaction-Isolation-Levels-Compared]] — RC vs RR vs Serializable chi tiết
- [[08-MVCC-MySQL-PostgreSQL-Oracle]] — So sánh MVCC implementation 3 database
- [[03-Concurrency-Patterns]] — FOR UPDATE, SKIP LOCKED, advisory locks
- [[05-Performance-Tuning]] — Vacuum configuration chi tiết, bloat monitoring

---

*Tags: #postgresql #snapshot #mvcc #oracle #internals #concurrency #bloat #vacuum*
*Created: 2026-05-07 | Difficulty: ⭐⭐⭐⭐⭐ | Area: Database-Patterns/PostgreSQL*
