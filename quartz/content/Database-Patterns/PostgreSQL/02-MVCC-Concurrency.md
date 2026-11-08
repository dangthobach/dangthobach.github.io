---
type: guide
domain: database
status: active
created: 2026-05-06
updated: 2026-11-02
tags: []
---

# 02 — MVCC & Concurrency Engine: Bên Trong PostgreSQL

> **Audience:** Senior engineers muốn hiểu tại sao PostgreSQL scale tốt cho concurrent workloads.  
> **Scope:** MVCC mechanics, snapshot model, visibility rules, dead tuples, vacuum lifecycle.  
> **Liên kết:** [[01-ACID-Internals]] | [[03-Concurrency-Patterns]] | [[00-PostgreSQL-Hub]]

---

## 📋 Mục lục

1. [Tại sao cần MVCC?](#tại-sao-cần-mvcc)
2. [Tuple Versioning — mỗi row có nhiều phiên bản](#tuple-versioning--mỗi-row-có-nhiều-phiên-bản)
3. [Transaction ID (XID) và Snapshot](#transaction-id-xid-và-snapshot)
4. [Visibility Rules — PostgreSQL thấy gì?](#visibility-rules--postgresql-thấy-gì)
5. [Dead Tuples và Vacuum](#dead-tuples-và-vacuum)
6. [HOT Update — Optimization quan trọng](#hot-update--optimization-quan-trọng)
7. [MVCC và Index — Complication](#mvcc-và-index--complication)
8. [Transaction ID Wraparound — Kịch bản nguy hiểm](#transaction-id-wraparound--kịch-bản-nguy-hiểm)
9. [Lịch sử đính chính](#lịch-sử-đính-chính)
10. [Tài liệu dẫn chứng](#tài-liệu-dẫn-chứng)

---

## Tại sao cần MVCC?

Traditional locking approach có vấn đề:

```
Traditional 2PL (Two-Phase Locking):
  ┌──────────────────────────────────────────────────┐
  │  Reader phải chờ Writer (shared/exclusive lock)  │
  │  Writer phải chờ Reader                          │
  │                                                  │
  │  → High contention → low throughput              │
  │  → Deadlock risk                                 │
  └──────────────────────────────────────────────────┘

MVCC (Multi-Version Concurrency Control):
  ┌──────────────────────────────────────────────────┐
  │  Reader KHÔNG block Writer                       │
  │  Writer KHÔNG block Reader                       │
  │                                                  │
  │  → Concurrent reads/writes không conflict        │
  │  → "Time travel" — mỗi transaction thấy         │
  │    consistent snapshot của quá khứ               │
  └──────────────────────────────────────────────────┘
```

Đây là lý do PostgreSQL handle concurrent workloads tốt hơn MySQL MyISAM (table-level locking) và comparable với InnoDB (row-level locking + MVCC).

> Lưu ý chính xác: "Writer không block Reader" đúng cho đọc thường (`SELECT`). Hai writer sửa *cùng một row* vẫn phải chờ nhau (row-level lock), và một số lệnh DDL lấy khoá mạnh có thể chặn cả đọc.

---

## Tuple Versioning — mỗi row có nhiều phiên bản

PostgreSQL không update-in-place. Mỗi UPDATE tạo ra **row version mới (tuple)** và mark row cũ là "deleted".

### Anatomy of a Tuple

```
┌──────────────────────────────────────────────────────────────────┐
│                    PostgreSQL Tuple (Row)                         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    Tuple Header (23 bytes)                  │  │
│  │                                                            │  │
│  │  xmin:  TransactionID — XID của transaction tạo tuple này  │  │
│  │  xmax:  TransactionID — XID của transaction xóa/update     │  │
│  │                         (0 nếu tuple chưa bị xóa/update)   │  │
│  │  ctid:  ItemPointer (t_ctid) — trỏ tới PHIÊN BẢN KẾ TIẾP   │  │
│  │         trong chuỗi update; trỏ chính nó nếu là bản mới    │  │
│  │         nhất                                               │  │
│  │  infomask: flags (committed, aborted, frozen, v.v.)        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    Tuple Data                              │  │
│  │  col1 | col2 | col3 | ...                                  │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### UPDATE = INSERT mới + Mark cũ là dead

```sql
-- Ban đầu
INSERT INTO accounts(id, balance) VALUES ('A', 1000);
-- Tạo tuple: (xmin=100, xmax=0, id='A', balance=1000)

-- Session B (XID=200) update
UPDATE accounts SET balance = 800 WHERE id = 'A';
-- Tuple cũ: (xmin=100, xmax=200, id='A', balance=1000)  ← dead sau khi Tx200 commit
-- Tuple mới: (xmin=200, xmax=0,   id='A', balance=800)  ← live
```

```
Physical layout sau UPDATE:
┌──────────────────────────────────────────────────────────────┐
│                     Page (8KB)                               │
│                                                              │
│  Slot 1: [xmin=100][xmax=200][ctid=(0,2)][balance=1000]     │
│           ← Dead tuple (sẽ bị dọn: pruning/vacuum)          │
│                                                              │
│  Slot 2: [xmin=200][xmax=0  ][ctid=(0,2)][balance=800]      │
│           ← Live tuple                                       │
│                                                              │
│  Slot 1's ctid → (page 0, slot 2) = phiên bản kế tiếp        │
│  (ở đây cũng là bản mới nhất)                                │
└──────────────────────────────────────────────────────────────┘
```

> "Dead sau khi Tx200 commit" nghĩa là: bản cũ không còn hiển thị với các snapshot *mới*. Nó chỉ thực sự được dọn khi không snapshot nào còn cần nó (xem [Dead Tuple Lifecycle](#dead-tuples-và-vacuum)).

---

## Transaction ID (XID) và Snapshot

### XID — Transaction Identity

```
XID là unsigned 32-bit integer, tăng dần theo thời gian cấp phát.
  • Không gian giá trị: 2^32 ≈ 4,3 tỷ, nhưng PostgreSQL so sánh XID theo số học modulo 2^32:
    với mỗi XID hiện tại, 2^31 giá trị "phía trước" là QUÁ KHỨ và 2^31 giá trị "phía sau" là TƯƠNG LAI.
    → Một tuple chưa freeze chỉ có thể sống tối đa ~2^31 ≈ 2,1 tỷ transaction (KHÔNG phải 4,3 tỷ).
  • XID chỉ được cấp khi transaction GHI lần đầu; transaction chỉ-đọc dùng virtual XID và không tiêu XID.

Đặc biệt:
  XID = 0 → Invalid
  XID = 1 → Bootstrap (system catalog initialization)
  XID = 2 → Frozen (luôn "cũ hơn" mọi XID thường, visible với mọi snapshot)
  XID ≥ 3 → "normal"; khi tràn 32-bit, bộ đếm quay về 3
```

### Snapshot — "Tôi thấy gì vào thời điểm này"

Snapshot được lấy **theo isolation level**:

- `READ COMMITTED`: mỗi *câu lệnh* lấy một snapshot mới.
- `REPEATABLE READ` / `SERIALIZABLE`: lấy **một** snapshot ở câu lệnh truy vấn đầu tiên của transaction và dùng cho cả transaction.

```
Snapshot = {
  xmin: XID nhỏ nhất vẫn đang active (mọi XID < xmin đã HOÀN TẤT — committed hoặc aborted)
  xmax: XID đầu tiên CHƯA được cấp phát (mọi XID >= xmax coi như chưa bắt đầu)
  xip:  Danh sách các XID đang in-progress trong khoảng [xmin, xmax)
}
```

```
Ví dụ:
  Active transactions: [300, 305, 310]
  Next XID: 315

  Snapshot = {xmin=300, xmax=315, xip=[300, 305, 310]}

  Tuple với xmin=295 → 295 < xmin: đã hoàn tất → tra pg_xact/hint bits: committed → VISIBLE (aborted → KHÔNG)
  Tuple với xmin=300 → in xip → đang chạy → KHÔNG VISIBLE
  Tuple với xmin=307 → 300 <= 307 < 315 và không in xip: đã hoàn tất → tra pg_xact: committed → VISIBLE (aborted → KHÔNG)
  Tuple với xmin=315 → >= xmax → chưa bắt đầu khi lấy snapshot → KHÔNG VISIBLE
```

> Quan sát snapshot hiện tại bằng `SELECT pg_current_snapshot();` (định dạng `xmin:xmax:xip_list`).

---

## Visibility Rules — PostgreSQL thấy gì?

Đây là **logic cốt lõi của MVCC**. PostgreSQL check visibility của mỗi tuple:

```
Một tuple (xmin, xmax) có visible với snapshot S không?

RULE 1: Tuple phải được tạo bởi transaction đã COMMIT và "đã xảy ra" theo snapshot S
  → xmin < S.xmax VÀ xmin không thuộc S.xip VÀ xmin committed (tra pg_xact/hint bits)
  → xmin in S.xip hoặc xmin >= S.xmax → chưa xảy ra với S → NOT VISIBLE
  → xmin aborted → NOT VISIBLE

RULE 2: Tuple không được bị xóa bởi transaction mà S "nhìn thấy"
  → xmax = 0 → chưa bị xóa → VISIBLE (nếu Rule 1 pass)
  → xmax committed VÀ đã xảy ra theo S (xmax < S.xmax, không in S.xip) → bị xóa → NOT VISIBLE
  → xmax committed nhưng CHƯA xảy ra theo S (in S.xip hoặc >= S.xmax) → S không thấy việc xóa → VISIBLE
  → xmax aborted → việc xóa không xảy ra → VISIBLE

Ngoại lệ: tuple do CHÍNH transaction hiện tại tạo/xóa được xét riêng (theo thứ tự câu lệnh, cmin/cmax).
```

### Minh họa cụ thể

```
┌─────────────────────────────────────────────────────────────────────┐
│  Timeline:                                                           │
│                                                                      │
│  T100: INSERT row A (balance=1000) → COMMIT                          │
│  R   : transaction ĐỌC (chưa có XID thật) bắt đầu, lấy snapshot S    │
│        S = {xmin=150, xmax=150, xip=[]}   (lúc đó XID kế tiếp = 150) │
│        SELECT → thấy balance=1000                                    │
│  T150: UPDATE row A SET balance=800 → COMMIT                         │
│  R   : SELECT lần nữa                                                │
│                                                                      │
│  Tuples trên disk:                                                   │
│  Tuple 1: (xmin=100, xmax=150, balance=1000)                         │
│  Tuple 2: (xmin=150, xmax=0,   balance=800)                          │
│                                                                      │
│  R là REPEATABLE READ (dùng lại snapshot S):                         │
│  → Tuple 2: xmin=150 >= S.xmax=150 → chưa xảy ra với S → NOT VISIBLE │
│  → Tuple 1: xmin=100 committed ✓; xmax=150 >= S.xmax → S không thấy  │
│             việc xóa → VISIBLE   ⇒ R vẫn thấy balance=1000           │
│                                                                      │
│  R là READ COMMITTED (câu lệnh mới lấy snapshot mới):                │
│  S' = {xmin=151, xmax=151, xip=[]}                                   │
│  → Tuple 2: xmin=150 < 151, committed ✓, xmax=0 → VISIBLE            │
│  → Tuple 1: xmax=150 committed và 150 < S'.xmin → bị xóa → NOT VISIBLE│
│                                       ⇒ R thấy balance=800           │
└─────────────────────────────────────────────────────────────────────┘
```

### infomask — Cache visibility hints

Checking commit status mỗi tuple sẽ rất chậm nếu phải tra `pg_xact` mỗi lần. PostgreSQL dùng **hint bits** trong `infomask`:

```
infomask flags:
  HEAP_XMIN_COMMITTED (0x0100) — xmin đã committed (cached)
  HEAP_XMIN_INVALID   (0x0200) — xmin đã aborted
  HEAP_XMAX_COMMITTED (0x0400) — xmax đã committed
  HEAP_XMAX_INVALID   (0x0800) — xmax không có hiệu lực (xmax=0 hoặc transaction xóa đã abort)
  HEAP_XMIN_FROZEN    = HEAP_XMIN_COMMITTED | HEAP_XMIN_INVALID (0x0300) — tuple đã freeze (từ 9.4)

Lần đầu check: tra pg_xact, set hint bit (khi đã biết chắc trạng thái cuối)
Lần sau: chỉ cần check hint bit → không cần I/O
```

---

## Dead Tuples và Vacuum

MVCC tạo ra dead tuples — không ai cần nữa nhưng vẫn chiếm space. **Vacuum** là process dọn dẹp.

### Dead Tuple Lifecycle

```
┌──────────────────────────────────────────────────────────────────┐
│                    Dead Tuple Lifecycle                           │
│                                                                  │
│  INSERT → tuple (xmin=T, xmax=0)      LIVE                       │
│     │                                                            │
│     ▼                                                            │
│  UPDATE → tuple cũ (xmin=T, xmax=T')                            │
│         → tuple mới (xmin=T', xmax=0)                           │
│     │                                                            │
│     ▼  Khi nào tuple cũ là "dead" thực sự (dọn được)?            │
│  T' đã COMMIT và xmax < "horizon" (OldestXmin): không còn        │
│  transaction/snapshot nào — kể cả replication slot, standby      │
│  feedback, prepared transaction — có thể cần thấy bản cũ         │
│     │                                                            │
│     ▼                                                            │
│  Dọn dẹp:                                                        │
│   • HOT pruning (khi page gần đầy, bất kỳ truy vấn nào)          │
│   • VACUUM: dead tuple → LP_DEAD; dọn index entry trỏ tới nó;    │
│     rồi slot → LP_UNUSED và ghi vào Free Space Map               │
│   (page vẫn giữ size; file thường KHÔNG nhỏ lại, chỉ cắt các     │
│    page trống ở CUỐI file khi lấy được khoá ngắn)                │
│     │                                                            │
│     ▼                                                            │
│  INSERT/UPDATE sau → tái sử dụng chỗ trống (theo FSM)            │
│     │                                                            │
│     ▼  Nếu bloat nhiều và cần trả dung lượng cho OS              │
│  VACUUM FULL / CLUSTER / pg_repack (/ REPACK ở PG 19)            │
│  → viết lại bảng → reclaim disk                                  │
└──────────────────────────────────────────────────────────────────┘
```

> Bản "chạm vật lý" có lab (page, line pointer, 3 pha vacuum): [[Database-Patterns/PostgreSQL/19-Heap-CTID-Vacuum|19 — Heap, CTID và VACUUM]].

### Khi nào VACUUM cần thiết nhất?

```sql
-- Bảng có UPDATE nhiều → dead tuples tích lũy nhanh
-- Kiểm tra (n_live_tup / n_dead_tup là ƯỚC LƯỢNG từ thống kê, không phải số đếm chính xác):
SELECT 
    relname,
    n_live_tup,
    n_dead_tup,
    ROUND(n_dead_tup::numeric / NULLIF(n_live_tup + n_dead_tup, 0) * 100, 2) AS dead_pct,
    last_autovacuum,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY dead_pct DESC;

-- Với cấu hình MẶC ĐỊNH (scale_factor = 0.2), autovacuum chỉ kích hoạt khi
-- dead ≈ 20% số row sống ⇒ dead_pct ≈ 0.2 / 1.2 ≈ 16,7% ở bảng lớn. Mức đó là BÌNH THƯỜNG.
-- dead_pct vượt xa mức này kéo dài ⇒ vấn đề: autovacuum bị throttle/disabled,
-- hoặc "horizon" bị giữ bởi transaction dài / replication slot (VACUUM không được phép xóa).
```

### Autovacuum triggers

```
Autovacuum chạy VACUUM khi:
  n_dead_tup > autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × reltuples
  Default:      50             +              0.2                       × reltuples
  (reltuples = pg_class.reltuples — số row ước lượng của bảng)

Ví dụ: table 1M rows → trigger khi dead_tup > 50 + 0.2×1M = 200,050

Autovacuum cũng chạy VACUUM khi bảng có nhiều row MỚI INSERT (PostgreSQL 13+):
  n_ins_since_vacuum > autovacuum_vacuum_insert_threshold (1000)
                     + autovacuum_vacuum_insert_scale_factor (0.2) × reltuples
  (một số bản mới tính phần scale theo số page chưa freeze — đối chiếu docs đúng phiên bản)
  → giúp bảng insert-only vẫn được set visibility map và freeze.

PostgreSQL 18+: autovacuum_vacuum_max_threshold đặt trần số dead tuple cần có để kích hoạt (mặc định 100 triệu).

Autovacuum chạy ANALYZE khi:
  n_mod_since_analyze > autovacuum_analyze_threshold (50) + autovacuum_analyze_scale_factor (0.1) × reltuples
```

```sql
-- Tuning cho bảng hot (nhiều updates như documents, transactions)
ALTER TABLE documents SET (
    autovacuum_vacuum_scale_factor = 0.02,    -- 2% thay vì 20%
    autovacuum_vacuum_threshold = 100,
    autovacuum_analyze_scale_factor = 0.01,
    autovacuum_vacuum_cost_limit = 1000       -- mặc định hiệu dụng 200; tăng để bớt throttle
);
-- Lưu ý mặc định: autovacuum_vacuum_cost_delay = 2 ms (từ PostgreSQL 12) — đã nhỏ sẵn,
-- nên đặt lại = 2 là không có tác dụng; autovacuum_vacuum_cost_limit = -1 nghĩa là dùng vacuum_cost_limit (200).
```

---

## HOT Update — Optimization quan trọng

Mỗi UPDATE bình thường tạo tuple mới ở địa chỉ (CTID) mới, nên phải **thêm một index entry mới vào tất cả index** của bảng (entry cũ ở lại chờ vacuum dọn). Với table nhiều indexes, UPDATE rất tốn kém.

**HOT = Heap-Only Tuple** — optimization cho UPDATE không làm đổi giá trị của cột nào có index.

```
Normal UPDATE (balance thay đổi, balance là indexed):
  ┌─────────────────────────────────────────────┐
  │  Heap page: mark old dead, insert new       │
  │  Index₁ (balance): giữ entry cũ,            │
  │                     THÊM entry mới → CTID mới│
  │  Index₂ (status):  giữ entry cũ,            │
  │                     THÊM entry mới → CTID mới│
  └─────────────────────────────────────────────┘
  → N index updates = expensive, và sinh rác trong cả N index

HOT UPDATE (chỉ balance thay đổi, nhưng balance NOT indexed):
  ┌─────────────────────────────────────────────┐
  │  Heap page: mark old dead, insert new       │
  │  → old tuple's t_ctid points to new tuple   │
  │  Indexes: NO CHANGES! Entry cũ vẫn trỏ vào  │
  │  CTID của tuple GỐC của chuỗi; runtime đi   │
  │  theo chuỗi t_ctid trong cùng page          │
  └─────────────────────────────────────────────┘
  → 0 index updates = much cheaper
```

```
HOT chain (trong CÙNG một page):
  Index entry ──► Slot 1 (dead, t_ctid→Slot 2) ──► Slot 2 (dead, t_ctid→Slot 3) ──► Slot 3 (live, heap-only)

Sau khi PRUNING (page pruning):
  Index entry ──► Slot 1 = LP_REDIRECT ──► Slot 3 (live)
  (Slot 2 và dữ liệu của tuple dead được giải phóng; index KHÔNG phải sửa gì — vẫn trỏ Slot 1)
```

> [!bug] Đính chính 2026-11-02
> Bản trước viết *"VACUUM prunes HOT chains: Index → Slot 3"*. Chính xác hơn: (1) **pruning không chỉ do VACUUM** — khi page gần đầy, *bất kỳ* truy vấn nào chạm page cũng có thể tỉa chuỗi HOT (không cần quét index); (2) index entry **không** được sửa để trỏ Slot 3 — slot gốc chuyển thành **line pointer kiểu `REDIRECT`** trỏ sang tuple sống. Giải thích từng bước kèm lab: [[Database-Patterns/PostgreSQL/19-Heap-CTID-Vacuum|19 — Heap, CTID và VACUUM]] (§4.2).

**Điều kiện HOT update:**
1. **Không cột nào có index bị đổi giá trị** — tính theo *giá trị thực sự đổi*, không phải theo danh sách `SET`; gồm cả cột nằm trong `INCLUDE`, cột dùng trong biểu thức/partial index. (Từ PostgreSQL 16, đổi cột chỉ nằm trong index kiểu *summarizing* như BRIN không còn chặn HOT — đối chiếu release notes bản bạn dùng.)
2. New tuple fit vào **cùng page** với old tuple (`fillfactor` ảnh hưởng điều này)

```sql
-- Để HOT update có chỗ hoạt động:
CREATE TABLE hot_heavy_table (...) WITH (fillfactor = 85);
-- Chừa ~15% mỗi page cho tuple mới (70 là rất tay; 80–90 thường là điểm khởi đầu — hãy đo hot_pct).
-- Lưu ý: ALTER TABLE ... SET (fillfactor=...) CHỈ áp cho page MỚI; muốn áp cho page cũ phải viết lại bảng
-- (VACUUM FULL / pg_repack / REPACK).

-- Đo tỉ lệ HOT thật:
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 1) AS hot_pct
FROM pg_stat_user_tables WHERE relname = 'hot_heavy_table';
```

---

## MVCC và Index — Complication

Index entries KHÔNG có xmin/xmax. Điều này tạo ra một số phức tạp.

### Index-Only Scan và Visibility Map

```
Index entry: (key=500, TID=(page 3, slot 2))
Index không biết tuple này có visible không!

Khi Index-Only Scan (chỉ khả thi nếu MỌI cột truy vấn cần đều có trong index — key hoặc INCLUDE):
  1. Tìm key trong index → TID
  2. Check Visibility Map — page này có được đánh dấu all-visible không?
     └─ YES (bit all-visible set) → return data FROM INDEX (không cần heap fetch để kiểm visibility)
     └─ NO  → heap fetch → check tuple visibility → return if visible
```

```
Visibility Map (VM) — 2 BIT cho mỗi heap page (từ 9.6):
  bit all-visible : mọi tuple trên page đều visible với MỌI transaction (hiện tại và tương lai)
                    → index-only scan bỏ qua heap; VACUUM (thường) bỏ qua page
  bit all-frozen  : mọi tuple trên page đã freeze
                    → VACUUM cũng bỏ qua page kể cả khi vacuum "aggressive"/chống wraparound
                    (all-frozen kéo theo all-visible)

  Quy tắc: bit chỉ được SET bởi VACUUM; bị CLEAR bởi mọi thao tác sửa dữ liệu trên page
           (INSERT, UPDATE — kể cả HOT —, DELETE).
  VM mang tính "bảo thủ": bit đã set thì chắc chắn đúng; bit chưa set thì có thể đúng hoặc sai.
```

```
Quan sát:
  EXPLAIN (ANALYZE) → dòng "Heap Fetches: N" của Index Only Scan = số lần vẫn phải ra heap
  pg_class.relallvisible = số page all-visible (planner dùng để ước lượng lợi ích của index-only scan)
  Extension pg_visibility: pg_visibility_map(), pg_visibility_map_summary()
```

---

## Transaction ID Wraparound — Kịch bản nguy hiểm

XID là 32-bit nhưng được so sánh theo số học modulo 2^32 → **ranh giới nguy hiểm thực tế là ~2^31 ≈ 2,1 tỷ transaction**, không phải 4,3 tỷ.

```
Vấn đề:
  Với mỗi XID hiện tại: 2^31 giá trị "phía trước" = quá khứ, 2^31 giá trị "phía sau" = tương lai.

  Tuple cũ có xmin=100 nhưng KHÔNG ĐƯỢC FREEZE:
    khi XID hiện tại vượt 100 + 2^31 (≈ 2,1 tỷ transaction sau),
    xmin=100 bị coi là "trong tương lai" → tuple INVISIBLE!
  → Dữ liệu cũ có thể "biến mất" khỏi truy vấn (mất visibility) — đây là lý do PostgreSQL
    tự khoá ghi để bảo vệ trước khi chạm ngưỡng.
```

### Cách PostgreSQL phòng ngừa

```
FREEZE: đánh dấu tuple "cũ đến mức visible với mọi snapshot, mãi mãi"
  • Từ 9.4: VACUUM set cờ HEAP_XMIN_FROZEN trong infomask (xmin gốc được GIỮ LẠI để debug).
  • Trước 9.4: ghi đè xmin = 2 (FrozenTransactionId).
  • Tuple frozen không còn phụ thuộc phép so sánh XID → an toàn trước wraparound.

Các tham số chính (mặc định):
  vacuum_freeze_min_age     = 50,000,000   tuple có xmin cũ hơn mức này sẽ bị freeze khi vacuum quét tới
  vacuum_freeze_table_age   = 150,000,000  vacuum "aggressive" (quét cả page chưa all-frozen) khi tuổi bảng vượt mức này
  autovacuum_freeze_max_age = 200,000,000  ép chạy autovacuum chống wraparound — KỂ CẢ khi autovacuum bị tắt
                                           (đổi tham số này cần restart)
  vacuum_failsafe_age       = 1,600,000,000  (PostgreSQL 14+) vacuum bỏ qua các bước không thiết yếu để kịp freeze

Các giới hạn bảo vệ (mức hiện hành; đối chiếu docs bản bạn dùng):
  còn ~40 triệu XID → server ghi cảnh báo mỗi transaction
  còn ~3 triệu XID  → server TỪ CHỐI cấp XID mới (ghi bị chặn; đọc vẫn chạy được)
```

```sql
-- Monitor XID age — CRITICAL metric
-- Mức bảng (r = table, m = materialized view, t = TOAST):
SELECT 
    relname,
    age(relfrozenxid) AS xid_age,
    pg_size_pretty(pg_relation_size(oid)) AS size
FROM pg_class
WHERE relkind IN ('r', 'm', 't') AND age(relfrozenxid) > 100000000  -- > 100M
ORDER BY age(relfrozenxid) DESC;

-- Mức database (chỉ số cần cảnh báo):
SELECT datname, age(datfrozenxid) AS xid_age FROM pg_database ORDER BY xid_age DESC;

-- Gợi ý ngưỡng (heuristic, hiệu chỉnh theo hệ thống):
--   ≥ autovacuum_freeze_max_age (200M): autovacuum chống wraparound đang/ phải chạy — kiểm tra có bị kẹt không
--   > 500M: cảnh báo sớm · > 1B: khẩn cấp (VACUUM thủ công, xử lý thủ phạm giữ horizon)
--   Giới hạn cứng ≈ 2^31 ≈ 2,147B; server ngừng cấp XID khi còn ~3M
```

**Thủ phạm điển hình khiến freeze không tiến được:** transaction mở quá lâu / `idle in transaction`, replication slot không còn consumer, prepared transaction bị treo — chúng giữ "horizon" nên VACUUM không freeze được các tuple cần thiết. Truy vấn chẩn đoán: xem [[Database-Patterns/PostgreSQL/19-Heap-CTID-Vacuum|19 — Heap, CTID và VACUUM]] (Usage U1).

> Ngoài XID còn có **MultiXact ID** (dùng cho row lock chia sẻ bởi nhiều transaction) cũng có cơ chế wraparound và freeze riêng (`autovacuum_multixact_freeze_max_age`).

---

## Tóm tắt — MVCC Mental Model

```
┌──────────────────────────────────────────────────────────────────┐
│                    MVCC Core Concepts                             │
│                                                                  │
│  1. Each tuple has (xmin, xmax):                                 │
│     xmin = transaction that created it                           │
│     xmax = transaction that deleted/updated it (0 if live)       │
│                                                                  │
│  2. Each transaction has a snapshot:                             │
│     {xmin, xmax, xip} — defines what's "visible"               │
│     (READ COMMITTED: mỗi câu lệnh; RR/SERIALIZABLE: một lần)     │
│                                                                  │
│  3. Visibility = xmin committed & đã xảy ra theo snapshot        │
│                  AND (xmax=0 OR xmax chưa xảy ra/aborted)        │
│                                                                  │
│  4. UPDATE = new tuple + mark old as dead                        │
│     → dead tuples accumulate → pruning/VACUUM cleans up          │
│                                                                  │
│  5. HOT optimization: avoid index updates when possible          │
│                                                                  │
│  6. XID is 32-bit (so sánh modulo, cửa sổ 2^31)                  │
│     → VACUUM FREEZE prevents wraparound disaster                 │
└──────────────────────────────────────────────────────────────────┘
```

---

## Related Notes

- [[01-ACID-Internals]] — WAL và Isolation levels
- [[03-Concurrency-Patterns]] — Áp dụng MVCC: FOR UPDATE, SKIP LOCKED, edge cases
- [[05-Performance-Tuning]] — Vacuum configuration chi tiết
- [[_moc/MOC-Database-Internals]] — Storage engine level (LSM, B-Tree)

---

*Tags: #postgresql #mvcc #concurrency #vacuum #internals*  
*Created: 2026-05-06 | Difficulty: ⭐⭐⭐⭐*

---

## Lịch sử đính chính

> [!bug] 2026-11-02 — rà soát tính chính xác kỹ thuật
> - **HOT chain:** pruning không chỉ do VACUUM; index entry không đổi, slot gốc thành `LP_REDIRECT`; điều kiện HOT tính theo giá trị đổi thực sự (gồm cột `INCLUDE`); `fillfactor` chỉ áp cho page mới.
> - **Visibility Map:** là **2 bit/page** (`all-visible`, `all-frozen`) — bản cũ ghi 1 bit; bit chỉ được set bởi VACUUM và bị clear bởi **mọi** thao tác sửa dữ liệu (kể cả INSERT, HOT update), không chỉ UPDATE/DELETE.
> - **Autovacuum:** công thức dùng `pg_class.reltuples`; bỏ ví dụ `autovacuum_vacuum_cost_delay = 2` (đã là mặc định từ PG 12) thay bằng `autovacuum_vacuum_cost_limit`; thêm trigger theo insert (PG 13+) và ngưỡng `dead_pct` ≈ 16,7 % là bình thường ở cấu hình mặc định (bản cũ ghi >10 % là bất thường).
> - **XID / wraparound:** cửa sổ so sánh là 2^31 (≈ 2,1 tỷ) chứ không phải 4,3 tỷ; XID thường bắt đầu từ 3; freeze từ 9.4 là **cờ `HEAP_XMIN_FROZEN`** (không ghi đè `xmin = 2`); thêm các tham số freeze, giới hạn cảnh báo ~40 triệu / từ chối ghi ~3 triệu, truy vấn theo `relkind IN ('r','m','t')` và cấp database.
> - **Snapshot / visibility:** snapshot của RR/SERIALIZABLE lấy ở câu lệnh truy vấn đầu tiên (không phải lúc `BEGIN`); XID `< xmin` chỉ nghĩa là "đã hoàn tất" — vẫn phải tra committed/aborted; `t_ctid` trỏ phiên bản *kế tiếp* chứ không luôn là "mới nhất"; viết lại ví dụ minh họa với số liệu nhất quán (transaction chỉ-đọc không có XID).
> - **Dead tuple:** điều kiện "dead" thực sự là xmax < horizon (tính cả replication slot, standby feedback, prepared xact); VACUUM không trả file cho OS (trừ cắt đuôi).

---

## Tài liệu dẫn chứng

| Khẳng định | Nguồn |
|---|---|
| Header tuple, `t_ctid`, `infomask`, line pointer | R1 |
| Snapshot, isolation level, MVCC | R2, R9 |
| Visibility Map: 2 bit, set bởi VACUUM, clear bởi mọi thao tác sửa, "bảo thủ" | R3 |
| HOT, pruning, `LP_REDIRECT`, điều kiện | R4 |
| Cửa sổ XID 2^31, freeze, các tham số `*_freeze_*`, giới hạn ~40M/~3M | R5, R6, R7 |
| Freeze bằng cờ từ 9.4 (không ghi đè `xmin=2`) | R6, R8 |
| Ngưỡng autovacuum, insert-triggered vacuum (PG 13), `vacuum_failsafe_age` | R10, R11 |
| `cost_delay` mặc định 2 ms từ PG 12 | R10, R11 |
| HOT với index summarizing (PG 16) | R12 |

- **R1** — PostgreSQL docs, *Database Page Layout*: https://www.postgresql.org/docs/current/storage-page-layout.html
- **R2** — PostgreSQL docs, *Concurrency Control — Introduction*: https://www.postgresql.org/docs/current/mvcc-intro.html
- **R3** — PostgreSQL docs, *Visibility Map*: https://www.postgresql.org/docs/current/storage-vm.html
- **R4** — PostgreSQL docs, *Heap-Only Tuples (HOT)*: https://www.postgresql.org/docs/current/storage-hot.html
- **R5** — PostgreSQL docs, *Routine Vacuuming* (mục *Preventing Transaction ID Wraparound Failures*): https://www.postgresql.org/docs/current/routine-vacuuming.html
- **R6** — H. Suzuki, *The Internals of PostgreSQL*, ch. 5.10 (wraparound, freeze): https://www.interdb.jp/pg/pgsql05/10.html
- **R7** — T. Lane, *Surviving transaction-ID wraparound, take 2* (pgsql-hackers, 2001): https://hackorum.dev/topics/7035
- **R8** — PostgreSQL 9.4 release notes: https://www.postgresql.org/docs/release/9.4.0/
- **R9** — P. A. Bernstein, N. Goodman, *Multiversion Concurrency Control — Theory and Algorithms*, ACM TODS 8(4), 1983 · H. Berenson et al., *A Critique of ANSI SQL Isolation Levels*, SIGMOD 1995 · D. Ports, K. Grittner, *Serializable Snapshot Isolation in PostgreSQL*, VLDB 2012.
- **R10** — PostgreSQL docs, *Automatic Vacuuming* (runtime config): https://www.postgresql.org/docs/current/runtime-config-vacuum.html
- **R11** — PostgreSQL release notes 12, 13, 14, 18: https://www.postgresql.org/docs/release/12.0/ · https://www.postgresql.org/docs/release/13.0/ · https://www.postgresql.org/docs/release/14.0/ · https://www.postgresql.org/docs/release/18.0/
- **R12** — PostgreSQL 16 release notes: https://www.postgresql.org/docs/release/16.0/

> Các ngưỡng cảnh báo ghi là *heuristic* — hiệu chỉnh theo hệ thống của bạn và đối chiếu docs của đúng phiên bản đang chạy.


## Xem thêm (2026-11-02)

- [[Database-Patterns/PostgreSQL/19-Heap-CTID-Vacuum|19 — Heap, CTID và VACUUM]] — bản dễ hiểu, có lab, "chạm vào vật lý" của các khái niệm trong note này (page, line pointer, CTID, HOT pruning, 3 pha vacuum, visibility map, vì sao Index-Only Scan vẫn có Heap Fetches).
