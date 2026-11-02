---
type: guide
domain: database
status: active
created: 2026-11-02
updated: 2026-11-02
difficulty: ⭐⭐⭐
estimated-read: 30 min
tags: [database, postgresql, heap, ctid, tuple, mvcc, vacuum, autovacuum, hot-update, bloat, visibility-map, index-only-scan, learning]
aliases: [Heap CTID Vacuum, PostgreSQL heap, Table bloat, Dead tuple, Vì sao bảng phình, Index-only scan Heap Fetches]
---

# Heap, CTID và VACUUM (Database) — PostgreSQL không xếp bảng theo primary key

> **Bài này dành cho ai?** Bạn đã biết SQL, đã nghe "PostgreSQL dùng MVCC", nhưng chưa thấy *tận mắt* một bảng thật sự nằm trên đĩa như thế nào. Mình đi từ ví dụ nhỏ → cơ chế → thí nghiệm tự chạy được. Không cần đọc bài MVCC trước (nhưng nếu đã đọc thì bài này là "bản chạm vào vật lý" của nó).

> [!question] Đọc xong bạn trả lời được 5 câu này
> 1. Vì sao `SELECT * FROM t` không trả về theo thứ tự `id`, dù `id` là primary key?
> 2. `ctid` là gì và vì sao index lưu *nó* chứ không lưu "vị trí byte"?
> 3. Một câu `UPDATE` đổi 1 cột nhỏ thực sự làm gì trên đĩa?
> 4. Vì sao bảng cứ phình dù đã `VACUUM`, và vì sao file không nhỏ lại?
> 5. Vì sao "Index Only Scan" mà `EXPLAIN` vẫn báo `Heap Fetches: 48 213` (vẫn chạm bảng)?

> [!summary] TL;DR (5 dòng)
> 1. Bảng PostgreSQL là một **heap**: các page 8 KB chứa row theo **thứ tự chèn/chỗ trống**, *không* theo primary key.
> 2. Mỗi row-version có địa chỉ **CTID = (số page, số slot)**. **Mọi index** (kể cả primary key) chỉ là cây `key → CTID`.
> 3. `UPDATE` = **tạo tuple mới + đánh dấu tuple cũ hết hạn** (không sửa tại chỗ). `DELETE` chỉ đánh dấu. Xác chết ở lại.
> 4. **VACUUM** dọn xác (khi không ai còn cần xem bản cũ) và biến chỗ đó thành *chỗ trống tái dùng* — nhưng thường **không trả file cho hệ điều hành**. Nếu dọn không kịp (hoặc bị chặn) → bảng/index **phình (bloat)**.
> 5. Index **không chứa thông tin "tuple này còn sống cho transaction của tôi không"**. Index-only scan dựa vào **visibility map**; page nào chưa "sạch" thì **vẫn phải ra heap** kiểm tra.

---

## 0. Một ẩn dụ để nhớ cả bài: cuốn sổ cái bằng bút mực

Hãy tưởng tượng bảng là **một cuốn sổ cái** và bạn chỉ có **bút mực** (không có tẩy):

| Trong đời thực | Trong PostgreSQL |
|---|---|
| Ghi giao dịch mới vào **dòng trống kế tiếp** (không xếp theo mã khách) | **Heap**: row vào chỗ trống, không theo PK |
| Mục lục cuối sổ ghi "mã khách 1001 → **trang 7, dòng 3**" | **Index**: `key → CTID (page 7, slot 3)` |
| Sửa số tiền: *gạch* dòng cũ, **viết dòng mới** ở chỗ trống | **UPDATE** = tuple mới + tuple cũ bị đóng dấu hết hạn |
| Có người đang đọc sổ "như hồi sáng" nên chưa được xé dòng bị gạch | **MVCC snapshot** — bản cũ còn có người cần |
| Thủ thư đi qua, **chỉ xé những dòng gạch mà không ai cần nữa**, rồi ghi chú "dòng này trống, dùng lại được" | **VACUUM** |
| Xé xong, *quyển sổ vẫn dày như cũ* (chỉ có chỗ trống bên trong) | File **không nhỏ lại** |
| Mục lục có sẵn tên khách nhưng **thủ thư vẫn phải liếc trang** xem dòng đó còn hiệu lực không | **Index-only scan vẫn chạm heap** |

Phần còn lại của bài chỉ là làm cho bảng ẩn dụ này **chính xác về mặt kỹ thuật**.

---

## 1. Heap — bảng không có thứ tự theo primary key

### 1.1 Bảng = một file chia thành page 8 KB

```
 lab_doc  (một "relation" = một hoặc nhiều file trong thư mục data)
 ┌────────────┬────────────┬────────────┬────────────┐
 │  page 0    │  page 1    │  page 2    │   …        │   mỗi page = 8 KB (BLCKSZ)
 │  (8192 B)  │  (8192 B)  │  (8192 B)  │            │   file tối đa 1 GB/segment, Postgres tự chia tiếp
 └────────────┴────────────┴────────────┴────────────┘
```

Không có "cây theo PK" ở đây. Đây gọi là **heap** (đống): row cứ lấp vào page nào còn chỗ.

### 1.2 Tự chứng minh bằng 3 dòng SQL

```sql
CREATE TABLE lab_doc (
    id     int  PRIMARY KEY,
    status text NOT NULL,
    title  text NOT NULL
);

-- Chèn NGƯỢC thứ tự id cố ý:
INSERT INTO lab_doc VALUES (3, 'NEW', 'c'), (1, 'NEW', 'a'), (2, 'NEW', 'b');

SELECT ctid, id, status, title FROM lab_doc;
```

Kết quả (minh họa):

```
 ctid  | id | status | title
-------+----+--------+-------
 (0,1) |  3 | NEW    | c       ← page 0, slot 1  (chèn đầu tiên)
 (0,2) |  1 | NEW    | a       ← page 0, slot 2
 (0,3) |  2 | NEW    | b       ← page 0, slot 3
```

Thứ tự trả về là **thứ tự vật lý (= thứ tự chèn)**, không phải thứ tự `id`. Muốn có thứ tự phải `ORDER BY id` — SQL không bao giờ hứa thứ tự nếu không có `ORDER BY`.

> [!tip] So với InnoDB (MySQL)
> InnoDB **xếp row theo primary key** (clustered index) — bài [[Database-Patterns/B-Tree-Clustered-Index-Random-Write-Cost|B-tree, clustered index và cái giá của ghi random]] kể chuyện đó. PostgreSQL chọn con đường khác: row nằm ở heap, **primary key chỉ là một unique index bình thường**. Hệ quả của lựa chọn này chính là toàn bộ bài hôm nay.

### 1.3 `CLUSTER` thì sao? Thứ tự có giữ được không?

`CLUSTER` viết lại bảng *một lần* theo thứ tự một index — nhưng **không duy trì**: các row chèn/sửa sau đó vào chỗ trống nào có. Mức "khớp thứ tự" hiện tại được PostgreSQL đo bằng thống kê `correlation`:

```sql
SELECT attname, correlation FROM pg_stats WHERE tablename = 'lab_doc';
-- correlation ≈ 1  : thứ tự vật lý khớp thứ tự cột (index scan đọc gần tuần tự → rẻ)
-- correlation ≈ 0  : rải rác (index scan nhảy khắp heap → đắt)
```

---

## 2. Bên trong một page: line pointer và tuple

### 2.1 Cấu trúc page 8 KB

```
 ┌──────────────────────────────────────────────────────────────┐
 │ PageHeader (24 B): lsn, lower, upper, flags…                  │
 ├──────────────────────────────────────────────────────────────┤
 │ Line pointers (4 B/cái):  [lp1][lp2][lp3] …   ──► mọc xuống   │
 │                                                               │
 │                     … KHOẢNG TRỐNG (free space) …             │
 │                                                               │
 │                      ◄── mọc lên:  … [tuple3][tuple2][tuple1] │
 └──────────────────────────────────────────────────────────────┘
   lower ↓ (cuối mảng line pointer)           upper ↑ (đầu vùng tuple)
```

- **Line pointer (còn gọi ItemId)** = "ô danh bạ" 4 byte: *tuple đang nằm ở byte nào trong page, dài bao nhiêu, trạng thái gì*.
- **Tuple** = một **phiên bản của row**, gồm *header ~23–24 byte* + dữ liệu cột.
- Hai vùng mọc **ngược chiều nhau** cho đến khi chạm nhau ⇒ page đầy.

### 2.2 CTID = địa chỉ của *line pointer*, không phải của byte

```
 CTID = (block number, offset number) = (page, slot)
 ctid (0,2)  ⇒ "page 0, line pointer số 2"  ──► line pointer 2 ──► byte thật của tuple
```

**Vì sao thêm một tầng gián tiếp?** Vì Postgres có thể **dồn tuple trong page** (defragment) cho gọn **mà không đổi CTID** — index không phải sửa gì. Nhờ vậy dọn dẹp trong page rất rẻ.

### 2.3 Header của tuple — vài trường bạn cần nhớ

| Trường | Ý nghĩa dễ hiểu |
|---|---|
| `xmin` | ID của transaction **đã tạo** phiên bản này ("sinh ra lúc nào") |
| `xmax` | ID của transaction **đã xóa/thay thế** nó (0 = còn sống) ("hết hạn lúc nào") |
| `t_ctid` | Trỏ tới **phiên bản mới hơn** (nếu đã bị UPDATE); nếu là bản mới nhất thì trỏ **chính nó** |
| `t_infomask` | Cờ: đã commit/abort chưa (hint bits), đã frozen chưa… |

Bạn có thể nhìn thẳng các cột ẩn này:

```sql
SELECT ctid, xmin, xmax, * FROM lab_doc;
```

> Chi tiết xmin/xmax, snapshot và quy tắc nhìn thấy: [[Database-Patterns/PostgreSQL/02-MVCC-Concurrency|02 — MVCC & Concurrency]] · [[Database-Patterns/PostgreSQL/18-Snapshot-Internals-Deep-Dive|18 — Snapshot Internals]]. Ở đây chỉ cần nhớ: **mỗi phiên bản có xmin/xmax**.

Hai con số hữu ích để ước lượng: mỗi tuple tốn **~24 B header + 4 B line pointer ≈ 28 B overhead** trước khi tính dữ liệu.

---

## 3. Index chỉ là cây `key → CTID`

```
   Index B-Tree trên title                 Heap (lab_doc)
   ┌──────────────────────┐                ┌────────────────────────────┐
   │ 'a'  ──► (0,2) ──────┼───────────────►│ page 0, slot 2: id=1 'a'   │
   │ 'b'  ──► (0,3) ──────┼───────────────►│ page 0, slot 3: id=2 'b'   │
   │ 'c'  ──► (0,1) ──────┼───────────────►│ page 0, slot 1: id=3 'c'   │
   └──────────────────────┘                └────────────────────────────┘
```

Một truy vấn `WHERE title = 'a'` đi qua **3 bước**:

1. Đi cây index → tìm `'a'` → lấy **CTID (0,2)**.
2. **Nhảy sang heap**: đọc page 0 (đang trong cache hoặc từ đĩa).
3. Đọc tuple ở slot 2, **kiểm tra visibility** (xmin/xmax so với snapshot của bạn) → trả về nếu còn nhìn thấy.

Ba điều quan trọng rút ra:

- **Primary key không đặc biệt**: `id PRIMARY KEY` cũng chỉ là `id → CTID`, giống mọi index khác.
- **Index không biết tuple còn sống hay chết** (index entry *không có* xmin/xmax). Chỉ heap mới biết ⇒ bước 3 ở trên là bắt buộc. Đây là mầm của §9 (index-only scan).
- **CTID là "địa chỉ tạm"**: đổi khi UPDATE (non-HOT), khi `VACUUM FULL`/`CLUSTER`. **Đừng bao giờ dùng `ctid` làm ID bền** trong ứng dụng.

---

## 4. UPDATE thực sự làm gì?

### 4.1 Không sửa tại chỗ — viết dòng mới, gạch dòng cũ

```sql
-- transaction này có XID = 751 (ví dụ)
UPDATE lab_doc SET status = 'REVIEW' WHERE id = 1;
```

```
 TRƯỚC:   slot 2:  [xmin=749][xmax=0  ][t_ctid=(0,2)]  id=1 'NEW'      ← đang sống

 SAU:     slot 2:  [xmin=749][xmax=751][t_ctid=(0,4)]  id=1 'NEW'      ← "hết hạn bởi 751", trỏ sang bản mới
          slot 4:  [xmin=751][xmax=0  ][t_ctid=(0,4)]  id=1 'REVIEW'   ← bản mới, đang sống
```

Điều bạn nhìn thấy bằng `SELECT ctid, xmin, xmax, ...`: dòng `id=1` **đổi ctid từ (0,2) sang (0,4)** và `xmin` thành 751. Bản cũ vẫn nằm đó — các transaction cũ hơn 751 *vẫn có thể cần đọc nó*.

> [!example] 3 câu để tự kiểm tra
> - Update 1 cột nhỏ vẫn **ghi cả một tuple mới** (cả hàng, trừ giá trị TOAST không đổi thì chỉ copy con trỏ).
> - `DELETE` chỉ **đặt xmax**; tuple vẫn ở đó.
> - `ROLLBACK` cũng để lại xác: tuple do transaction bị hủy tạo ra là **chết ngay**, chỉ chờ dọn.

### 4.2 Hai loại UPDATE: thường và HOT

Tuple mới có địa chỉ mới (0,4), nên **index entry cũ (trỏ (0,2)) không còn đủ**. Có hai khả năng:

```
 ┌──────────────────── UPDATE THƯỜNG (non-HOT) ───────────────────┐
 │ Heap : thêm tuple mới (0,4), đóng dấu tuple cũ (0,2)            │
 │ MỖI index : THÊM entry mới  key → (0,4)   (entry cũ ở lại,     │
 │             chờ vacuum xóa)                                     │
 │ ⇒ N index = N lần ghi thêm  ⇒ đắt, sinh nhiều rác              │
 └─────────────────────────────────────────────────────────────────┘

 ┌──────────────────────── HOT UPDATE ─────────────────────────────┐
 │ Điều kiện: ① không cột nào CÓ INDEX bị đổi                      │
 │            ② tuple mới VỪA TRONG CÙNG PAGE                      │
 │ Heap : thêm tuple mới "heap-only" (0,4), tuple cũ trỏ sang nó   │
 │ Index: KHÔNG ĐỔI GÌ — vẫn trỏ (0,2); từ (0,2) đi theo chuỗi     │
 │        t_ctid ⇒ (0,4)                                           │
 │ ⇒ 0 lần ghi index, rác nằm gọn trong page, dọn rẻ               │
 └─────────────────────────────────────────────────────────────────┘
```

**HOT = Heap-Only Tuple**. Chuỗi HOT trông như sau:

```
 Index entry ──► slot 2 (tuple cũ, dead) ──t_ctid──► slot 4 (tuple mới, sống)
                 "root"                               "heap-only": không có index entry nào trỏ riêng nó
```

**Dọn chuỗi HOT (pruning):** khi page gần đầy, *bất kỳ* truy vấn nào chạm page đó có thể **"tỉa"** (prune): xóa tuple chết trong chuỗi, giải phóng chỗ, và biến slot gốc thành **line pointer kiểu `REDIRECT`** trỏ thẳng sang tuple sống. Index vẫn trỏ slot gốc (không phải sửa), nhưng giờ nó "chuyển hướng" luôn. *Không cần quét index, không cần VACUUM* ⇒ đó là lý do HOT rẻ.

### 4.3 Hệ quả thiết kế (rất thực tế)

| Bạn làm | Kết quả |
|---|---|
| Update cột **không index** và page còn chỗ | HOT ✅ rẻ |
| Update cột **có index** (kể cả cột "hay đổi" như `updated_at`, `status`) | Non-HOT ❌: ghi lại **mọi index** + sinh rác trong index |
| Bảng đầy 100% (`fillfactor=100`) | Không còn chỗ trong page ⇒ tuple mới nhảy sang page khác ⇒ không HOT |
| `fillfactor = 80–90` cho bảng update nhiều | Chừa chỗ ⇒ HOT dễ hơn (đổi lại bảng to hơn 10–20 %) |

```sql
-- Đo tỉ lệ HOT thật của bảng:
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 1) AS hot_pct
FROM pg_stat_user_tables WHERE relname = 'lab_doc';
```

> [!tip] Quy tắc ngón tay cái
> **Đừng index cột hay bị UPDATE** nếu không thật sự cần. Mỗi index trên cột "nóng" biến mọi UPDATE thành non-HOT.

---

## 5. Vì sao tuple cũ *chưa được xóa ngay*? — "Horizon"

Tuple cũ (0,2) chỉ có thể bị xóa khi **không còn transaction nào có thể cần nó**. PostgreSQL đo bằng một mốc gọi là **xmin horizon** = *transaction cũ nhất vẫn còn cần nhìn thấy dữ liệu "như hồi đó"*.

```
 thời gian ──────────────────────────────────────────────────►
 XID:  749      751 (UPDATE commit)           820              900
 tuple cũ: xmax=751

 Nếu có một transaction BẮT ĐẦU TRƯỚC 751 và còn mở (xmin = 740):
       horizon = 740  <  751  ⇒ tuple cũ CÒN CẦN ⇒ VACUUM KHÔNG ĐƯỢC xóa
 Khi nó kết thúc và horizon vượt 751 ⇒ tuple cũ thành "dead to everyone" ⇒ dọn được
```

**Những thứ có thể giữ horizon lại** (thủ phạm kinh điển của bloat):

| Thủ phạm | Vì sao |
|---|---|
| Transaction chạy lâu / **`idle in transaction`** (app mở transaction rồi quên commit) | Snapshot của nó cần bản cũ |
| Truy vấn báo cáo chạy hàng giờ (Repeatable Read) | Giữ một snapshot rất cũ |
| **Replication slot** bị bỏ quên / replica lag, `hot_standby_feedback = on` | Server khác "mượn" horizon |
| **Prepared transaction** (2PC) bị treo | Giữ xmin |

```sql
-- Ai đang giữ horizon?
SELECT pid, state, xact_start, backend_xmin, now() - xact_start AS age, left(query, 60) AS q
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY age(backend_xmin) DESC;

SELECT slot_name, active, xmin, catalog_xmin FROM pg_replication_slots;
SELECT gid, prepared, transaction FROM pg_prepared_xacts;
```

---

## 6. VACUUM làm gì, từng bước

### 6.1 Ba pha và vì sao thứ tự bắt buộc

```
 PHA 1 — Quét HEAP        │ Duyệt các page (bỏ qua page "all-visible" nhờ visibility map).
                          │ Tỉa chuỗi HOT. Với tuple chết thường: gom TID của chúng vào danh sách
                          │ trong RAM; slot chuyển thành "LP_DEAD" (xác còn bia mộ 4 byte).
                          ▼
 PHA 2 — Dọn INDEX        │ Với MỖI index: xóa mọi entry có CTID nằm trong danh sách chết.
                          │ (Tốn thời gian tỉ lệ với SỐ INDEX và kích thước index)
                          ▼
 PHA 3 — Dọn HEAP         │ Các slot LP_DEAD → LP_UNUSED (dùng lại được).
                          │ Cập nhật Free Space Map (FSM) + Visibility Map (VM),
                          │ freeze tuple đã già; cắt các page trống ở CUỐI file nếu lấy được lock.
```

> [!important] Vì sao phải dọn index **trước** khi giải phóng slot?
> Nếu giải phóng slot (0,2) khi index còn entry trỏ (0,2), một row hoàn toàn khác có thể được chèn vào (0,2) — và entry index cũ sẽ **trỏ nhầm sang row xa lạ**. Thứ tự "index trước, heap sau" ngăn điều đó.
> Đây cũng giải thích: **bảng nhiều index ⇒ VACUUM chậm hơn nhiều**, và **HOT rẻ** vì rác HOT không có index entry nào cần dọn.

Xem VACUUM đang ở pha nào:

```sql
SELECT pid, relid::regclass, phase, heap_blks_total, heap_blks_scanned, index_vacuum_count
FROM pg_stat_progress_vacuum;
-- phase: scanning heap → vacuuming indexes → vacuuming heap → cleaning up indexes → truncating heap …
```

### 6.2 Bốn "công cụ dọn dẹp" — đừng nhầm

| Lệnh | Làm gì | Khoá | Trả file cho OS? |
|---|---|---|---|
| `VACUUM` / **autovacuum** | Dọn xác, biến chỗ thành *tái dùng được*, cập nhật FSM/VM | **Nhẹ**, chạy song song đọc/ghi | **Hầu như không** (chỉ cắt đuôi trống) |
| `VACUUM FULL` | **Viết lại cả bảng** vào file mới gọn gàng + dựng lại index | **ACCESS EXCLUSIVE** (chặn cả đọc) | **Có** |
| `CLUSTER` | Như trên nhưng **sắp theo một index** | ACCESS EXCLUSIVE | Có |
| `pg_repack` (extension) / **`REPACK`** (PostgreSQL 19) | Viết lại **online** | Chỉ giữ khoá ngắn ở cuối | Có |

> [!note] Ghi chú phiên bản (kiểm tra theo bản bạn đang chạy)
> - **PG 13:** autovacuum cũng chạy theo *số dòng insert* (bảng chỉ insert vẫn được set visibility map); `VACUUM (PARALLEL n)` thủ công.
> - **PG 14:** có "failsafe" chống wraparound và có thể **bỏ qua pha dọn index** khi quá ít rác.
> - **PG 17:** theo dõi dead tuple bằng cấu trúc mới (TidStore) — **không còn trần 1 GB** của `maintenance_work_mem` và tốn ít RAM hơn.
> - **PG 18:** vacuum thường *chủ động freeze* hơn (eager freezing) và có trần `autovacuum_vacuum_max_threshold` cho bảng khổng lồ.
> - **PG 19** (đang ở giai đoạn RC khi viết bài này, 2026-11-02): thêm lệnh **`REPACK`** / **`REPACK (CONCURRENTLY)`** gom `VACUUM FULL` + `CLUSTER` và thêm chế độ online; **autovacuum chạy song song trên index** (mặc định tắt, bật bằng `autovacuum_max_parallel_workers`) và có **chấm điểm ưu tiên** (`pg_stat_autovacuum_scores`). Một số tài liệu lưu ý chế độ `CONCURRENTLY` có giới hạn (ví dụ không an toàn MVCC hoàn toàn) — đọc release notes trước khi dùng production.

### 6.3 Autovacuum chạy khi nào?

```
 chạy VACUUM khi:  dead_tuples  >  vacuum_threshold (50)  +  vacuum_scale_factor (0.2)  ×  số_row
```

Ví dụ bảng **10 triệu row**: ngưỡng ≈ 50 + 0,2 × 10 000 000 = **2 000 050 dead tuple**. Với row ≈ 100 B (+28 B overhead) đó là **~250 MB rác** *trước khi* autovacuum thức dậy. Bảng càng to, scale factor 20 % càng "lười" — nên bảng nóng hay chỉnh riêng (xem [[Database-Patterns/PostgreSQL/02-MVCC-Concurrency|02-MVCC]] và [[Database-Patterns/PostgreSQL/05-Performance-Tuning|05-Performance-Tuning]]):

```sql
ALTER TABLE document SET (
    autovacuum_vacuum_scale_factor = 0.02,   -- 2% thay vì 20%
    autovacuum_vacuum_threshold    = 1000
);
```

---

## 7. Vì sao bảng phình (bloat) — bốn nguyên nhân

**Bloat** = phần dung lượng bảng/index đang bị **rác hoặc chỗ trống chưa dùng** chiếm giữ. Hình dung:

```
 Khoẻ mạnh:   [ sống ][ sống ][ sống ][ sống ][ trống nhỏ ]
 Bị bloat:    [ chết ][ sống ][ chết ][ chết ][ trống ][ sống ][ chết ] …  ← file to, dữ liệu thật ít
```

| # | Nguyên nhân | Dấu hiệu | Cách xử |
|---|---|---|---|
| 1 | **UPDATE-nặng + non-HOT** (cột có index bị đổi, page không còn chỗ) | `hot_pct` thấp, index phình nhanh | Bỏ index cột "nóng", `fillfactor` 80–90, tách cột hay đổi sang bảng khác |
| 2 | **Autovacuum không theo kịp** (scale factor 20 %, bị throttle, worker ít) | `n_dead_tup` lớn, `last_autovacuum` cũ | Hạ `scale_factor` riêng bảng nóng, giảm `autovacuum_vacuum_cost_delay`, tăng worker |
| 3 | **Horizon bị giữ** (transaction dài, slot bỏ quên) | `VACUUM VERBOSE` báo *"dead row versions cannot be removed yet"* | Tìm và xử lý thủ phạm (§5), đặt `idle_in_transaction_session_timeout` |
| 4 | **VACUUM chỉ "để dành chỗ", không trả file** | Dọn xong mà `pg_relation_size` vẫn to | Chấp nhận (chỗ trống sẽ được tái dùng) hoặc `REPACK`/`pg_repack`/`VACUUM FULL` khi thật cần |

> [!warning] "Dead tuple nhiều" ≠ "bảng to vô lý"
> Bảng ổn định thường **có sẵn vài chục % chỗ trống tái dùng** — đó là bình thường: VACUUM không phải để thu nhỏ file mà để **giữ cho file không *tiếp tục* lớn**. Lo khi *kích thước tăng đều dù số dòng thật không tăng*.

**Index cũng bloat riêng:** index B-Tree không dễ gom lại page thưa; chữa bằng `REINDEX INDEX CONCURRENTLY` (hoặc `REPACK` ở PG 19). Chi tiết cấu trúc B-Tree: [[Database-Patterns/PostgreSQL/04-Index-Internals|04-Index-Internals]].

**Đo bloat:**

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;
SELECT table_len, tuple_percent, dead_tuple_percent, free_percent
FROM pgstattuple('lab_doc');          -- quét toàn bảng: dùng cẩn thận trên bảng lớn

SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 10;
```

---

## 8. Visibility map và free space map — hai "bản đồ phụ"

Cùng với file heap, mỗi bảng có hai file nhỏ do VACUUM bảo trì:

| Bản đồ | Chứa gì | Dùng để |
|---|---|---|
| **FSM** (Free Space Map) | Mỗi page còn bao nhiêu chỗ trống | INSERT/UPDATE tìm chỗ đặt tuple mà không phải dò từng page |
| **VM** (Visibility Map) | **2 bit/page**: `all-visible` (mọi tuple trong page nhìn thấy được bởi *mọi* transaction) và `all-frozen` | ① **Index-only scan** bỏ qua heap. ② **VACUUM bỏ qua** page đã sạch |

- VACUUM **bật** bit `all-visible` khi page chỉ còn tuple "sống cho tất cả".
- **Bất kỳ INSERT/UPDATE/DELETE nào trên page đó sẽ tắt bit** (kể cả HOT update).

---

## 9. Vì sao *Index-Only Scan* vẫn chạm bảng

### 9.1 Ý tưởng ban đầu

Nếu index đã chứa **mọi cột câu truy vấn cần** (covering), lý thuyết là khỏi đọc heap:

```sql
CREATE INDEX lab_ios_cover ON lab_ios (id) INCLUDE (v);
SELECT id, v FROM lab_ios WHERE id BETWEEN 1 AND 20000;     -- có thể là Index Only Scan
```

### 9.2 Cái bẫy: index không biết tuple còn sống hay chết

```
 Index entry:  key=500 → CTID(3,2)        ← KHÔNG có xmin/xmax

 Để trả key=500 cho transaction của bạn, Postgres phải biết "tuple (3,2) có nhìn thấy được với snapshot của tôi không?"
   → câu trả lời chỉ có trong HEAP (xmin/xmax) …
   → TRỪ khi visibility map nói: "page 3 là all-visible" ⇒ chắc chắn nhìn thấy ⇒ khỏi ra heap
```

```
 Với mỗi index entry:
   page của CTID có bit all-visible?
        ├─ CÓ  → trả dữ liệu thẳng từ index           (không chạm heap)   ✅
        └─ KHÔNG → ra heap kiểm tra visibility        (Heap Fetches +1)   ❌
```

`EXPLAIN` cho thấy rõ:

```
 Index Only Scan using lab_ios_cover on lab_ios
   Index Cond: ((id >= 1) AND (id <= 20000))
   Heap Fetches: 0              ← lý tưởng: không chạm bảng
```

sau khi bảng bị UPDATE nhiều mà **chưa VACUUM**:

```
   Heap Fetches: 18 742         ← "index-only" nhưng vẫn ra heap gần như từng dòng
```

### 9.3 Vì sao Heap Fetches cao — và cách hạ

| Nguyên nhân | Giải thích | Cách chữa |
|---|---|---|
| Vừa UPDATE/DELETE nhiều | Page bị tắt bit all-visible | Đợi/ép `VACUUM` để bật lại |
| Autovacuum chưa chạy tới | Bảng quá lớn, ngưỡng 20 % | Hạ `autovacuum_vacuum_scale_factor` |
| Bảng **chỉ insert** | Trước PG 13 autovacuum không chạy cho insert-only ⇒ VM không được set | PG 13+: `autovacuum_vacuum_insert_scale_factor` (hoặc VACUUM thủ công) |
| **Horizon bị giữ** bởi transaction dài | Page không thể coi là "visible với mọi transaction" | Xử lý transaction dài (§5) |
| Cột cần lấy **không có trong index** | Không phải index-only ngay từ đầu | `INCLUDE (cột)` hoặc bỏ cột khỏi `SELECT` |

> [!tip] Hệ quả đáng nhớ
> "Index-only scan nhanh" **phụ thuộc VACUUM khoẻ mạnh**. Bảng tải ghi nặng thì lợi ích này dao động theo thời gian. Bài [[Database-Patterns/PostgreSQL/07-Count-Star-vs-Count-Column|07 — COUNT(*) vs COUNT(col)]] cũng gặp đúng cơ chế này khi đếm.

---

## 10. Phòng thí nghiệm 15 phút (tự chạy để thấy tận mắt)

> Chỉ chạy ở DB thử nghiệm. Lab tắt autovacuum **trên bảng lab** để quan sát được từng bước.

### Lab 1 — Heap, CTID và UPDATE

```sql
CREATE EXTENSION IF NOT EXISTS pageinspect;

DROP TABLE IF EXISTS lab_doc;
CREATE TABLE lab_doc (id int PRIMARY KEY, status text NOT NULL, title text NOT NULL)
    WITH (autovacuum_enabled = off);
CREATE INDEX lab_doc_title_idx ON lab_doc (title);

INSERT INTO lab_doc VALUES (3,'NEW','c'), (1,'NEW','a'), (2,'NEW','b');
SELECT ctid, xmin, xmax, * FROM lab_doc;            -- ① thứ tự = thứ tự chèn

UPDATE lab_doc SET status = 'REVIEW' WHERE id = 1;  -- cột KHÔNG index → HOT
SELECT ctid, xmin, xmax, * FROM lab_doc;            -- ② id=1 đổi ctid, xmin mới

-- ③ Nhìn nguyên page: lp_flags 1=normal 2=redirect 3=dead 0=unused
SELECT lp, lp_flags, t_xmin, t_xmax, t_ctid,
       (t_infomask2 & 32768) <> 0 AS heap_only,       -- HEAP_ONLY_TUPLE
       (t_infomask2 & 16384) <> 0 AS hot_updated      -- HEAP_HOT_UPDATED
FROM heap_page_items(get_raw_page('lab_doc', 0));

UPDATE lab_doc SET title = 'a2' WHERE id = 1;       -- cột CÓ index → KHÔNG HOT
SELECT relname, n_tup_upd, n_tup_hot_upd            -- (số liệu có thể trễ ~1 giây)
FROM pg_stat_user_tables WHERE relname = 'lab_doc';
```

Cần thấy: ① thứ tự 3,1,2; ② `ctid` của id=1 nhảy sang slot mới; ③ tuple cũ có `t_xmax` ≠ 0 và `t_ctid` trỏ sang bản mới; update thứ hai **không** tăng `n_tup_hot_upd`.

### Lab 2 — VACUUM dọn gì

```sql
VACUUM (VERBOSE) lab_doc;
SELECT lp, lp_flags, t_xmin, t_xmax, t_ctid
FROM heap_page_items(get_raw_page('lab_doc', 0));
-- Xác chết đã thành lp_flags = 0 (unused); gốc chuỗi HOT (nếu còn) là 2 (redirect)

CREATE EXTENSION IF NOT EXISTS pg_visibility;
SELECT * FROM pg_visibility_map('lab_doc');          -- all_visible = t sau khi VACUUM
```

### Lab 3 — Horizon chặn dọn dẹp (cần 2 phiên psql)

Dùng bảng đủ lớn để *nhìn thấy* kích thước thay đổi:

```sql
DROP TABLE IF EXISTS lab_big;
CREATE TABLE lab_big (id int PRIMARY KEY, pad text NOT NULL) WITH (autovacuum_enabled = off);
INSERT INTO lab_big SELECT g, repeat('x', 100) FROM generate_series(1, 200000) g;
SELECT pg_size_pretty(pg_relation_size('lab_big'));      -- ① cỡ vài chục MB (mốc ban đầu)

-- Phiên A (GIỮ MỞ, đừng commit):
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM lab_big;

-- Phiên B:
UPDATE lab_big SET pad = repeat('y', 100);               -- sửa MỌI dòng
SELECT pg_size_pretty(pg_relation_size('lab_big'));      -- ② gần GẤP ĐÔI: bản cũ chưa được xóa
VACUUM (VERBOSE) lab_big;
-- Log có dạng:  "... dead row versions cannot be removed yet, oldest xmin: ..."   ← horizon bị giữ

-- Phiên A:
COMMIT;                                                  -- thả horizon

-- Phiên B:
VACUUM (VERBOSE) lab_big;                                -- ③ giờ mới dọn được
SELECT pg_size_pretty(pg_relation_size('lab_big'));      --   KHÔNG nhỏ lại (vẫn ≈ ②)
SELECT free_percent FROM pgstattuple('lab_big');         --   ~nửa bảng là chỗ trống tái dùng

UPDATE lab_big SET pad = repeat('z', 100);               -- ④ lần này TÁI DÙNG chỗ trống
SELECT pg_size_pretty(pg_relation_size('lab_big'));      --   gần như không lớn thêm
-- VACUUM FULL lab_big;   -- (khoá nặng, chỉ trong lab!) → ⑤ file mới nhỏ lại ≈ ①
```

Cần thấy: ② bảng phình vì horizon bị giữ · ③ VACUUM xong file vẫn to · ④ chỗ trống được dùng lại nên *không phình thêm* · ⑤ chỉ viết lại bảng mới trả dung lượng.

### Lab 4 — Heap Fetches tăng vọt rồi về 0

```sql
DROP TABLE IF EXISTS lab_ios;
CREATE TABLE lab_ios (id int PRIMARY KEY, v int NOT NULL);
INSERT INTO lab_ios SELECT g, g FROM generate_series(1, 100000) g;
CREATE INDEX lab_ios_cover ON lab_ios (id) INCLUDE (v);
VACUUM (ANALYZE) lab_ios;

SET enable_seqscan = off; SET enable_bitmapscan = off;      -- chỉ để lab chọn index-only
EXPLAIN (ANALYZE) SELECT id, v FROM lab_ios WHERE id BETWEEN 1 AND 20000;
-- Index Only Scan ... Heap Fetches: 0

UPDATE lab_ios SET v = v + 1 WHERE id <= 20000;             -- làm bẩn các page
EXPLAIN (ANALYZE) SELECT id, v FROM lab_ios WHERE id BETWEEN 1 AND 20000;
-- Heap Fetches: tăng vọt (cỡ số dòng nằm trên các page vừa bị sửa)

VACUUM lab_ios;
EXPLAIN (ANALYZE) SELECT id, v FROM lab_ios WHERE id BETWEEN 1 AND 20000;
-- Heap Fetches: về ~0
SELECT * FROM pg_visibility_map_summary('lab_ios');         -- số page all_visible
```

> Lưu ý: `v` ở lab này nằm trong `INCLUDE` của index nên UPDATE `v` là **non-HOT** (index phải đổi) — nó sẽ làm index lẫn heap có rác; thử bỏ `INCLUDE` (và dùng cột khác) để so sánh với trường hợp HOT.

---

## 11. Áp dụng vào PDMS / VPBank

- **Bảng "trạng thái hồ sơ" bị update liên tục** (status chuyển bước workflow): nếu `status` có index thì mỗi lần chuyển bước là một non-HOT update + rác trong index. Cân nhắc: index *partial* chỉ cho trạng thái cần tìm (`WHERE status IN (...)`), hoặc để trạng thái hay đổi ở bảng nhỏ riêng, tách khỏi các cột lớn.
- **Bảng outbox / queue** ([[Microservices-Patterns/Transactional-Outbox|Transactional Outbox]]): insert → publish → delete tạo **lượng dead tuple khổng lồ**. Hướng đi: partition theo thời gian rồi `DROP` partition cũ (không cần vacuum), hạ ngưỡng autovacuum riêng cho bảng này, tránh transaction dài trên cùng DB giữ horizon.
- **Báo cáo chạy lâu trên primary** là kẻ giữ horizon điển hình — đẩy sang replica thì nhớ `hot_standby_feedback` cũng có thể "mượn" horizon ngược lại; chọn có chủ đích.
- **Hibernate/JPA**: `save()` một entity đã có thường sinh `UPDATE` **toàn bộ cột** (nếu không bật `@DynamicUpdate`) — cột có index bị "chạm" dù giá trị không đổi thì Postgres vẫn có thể coi là không đổi (nó so giá trị), nhưng bạn vẫn trả chi phí ghi tuple mới. Xem [[Database-Patterns/Hibernate-Performance-Deep-Dive|Hibernate Performance Deep Dive]].
- **Chọn kiểu ID** ở PostgreSQL ảnh hưởng *index* (không ảnh hưởng vị trí heap) — nối với [[Database-Patterns/Chon-Kieu-ID-He-Thong-Hien-Dai|Chọn kiểu ID cho hệ thống hiện đại]].

---

## 12. Hiểu lầm thường gặp (Q&A nhanh)

> [!question]- "VACUUM làm file bảng nhỏ lại, đúng không?"
> **Không** (VACUUM thường). Nó biến chỗ chết thành chỗ tái dùng. Chỉ khi các page **ở cuối file** hoàn toàn trống và lấy được khoá ngắn thì file mới bị cắt đuôi. Muốn thu nhỏ thật: `VACUUM FULL` / `CLUSTER` / `pg_repack` / `REPACK` (PG 19).

> [!question]- "UPDATE đổi 1 cột nhỏ thì rẻ chứ?"
> Không hẳn: vẫn **ghi cả tuple mới** (trừ giá trị TOAST không đổi chỉ copy con trỏ), và nếu cột có index hoặc page hết chỗ thì còn **ghi thêm mọi index**.

> [!question]- "Index-only scan nghĩa là không đọc bảng?"
> Chỉ khi **visibility map nói page sạch**. Nhìn `Heap Fetches` trong `EXPLAIN (ANALYZE)` để biết thật sự.

> [!question]- "Có dùng `ctid` làm khoá/ID được không?"
> **Không.** Nó đổi khi UPDATE non-HOT, `VACUUM FULL`, `CLUSTER`. Chỉ dùng cho debug hoặc kỹ thuật dọn dữ liệu trùng trong một câu lệnh.

> [!question]- "Tắt autovacuum cho nhanh được không?"
> **Không** (trừ lab). Không có nó: bảng phình, VM không được set (index-only chậm), thống kê cũ (planner chọn sai plan) và — nguy hiểm nhất — **XID wraparound** có thể buộc database ngừng nhận ghi (xem [[Database-Patterns/PostgreSQL/02-MVCC-Concurrency|02-MVCC]] mục wraparound).

> [!question]- "PostgreSQL và InnoDB khác nhau ở đây thế nào?"
> InnoDB **sửa tại chỗ** trên cây PK và đẩy bản cũ sang **undo log** (purge dọn sau); PostgreSQL **để cả bản cũ lẫn mới trong heap** và dùng VACUUM dọn. Hệ quả: InnoDB ít "phình heap" nhưng secondary index phải chứa PK; PostgreSQL cần VACUUM nhưng index trỏ CTID nhỏ gọn. Xem [[Database-Patterns/PostgreSQL/08-MVCC-MySQL-PostgreSQL-Oracle|08 — MVCC: MySQL vs PostgreSQL vs Oracle]].

---

## 13. Tự kiểm tra (bấm để xem đáp án)

> [!question]- Câu 1. Bảng có PK `id`. Bạn chèn id = 5, 2, 9. `SELECT * FROM t` (không ORDER BY) thường trả thứ tự nào, vì sao?
> Thường là **5, 2, 9** — thứ tự vật lý trong heap (thứ tự chèn), vì PK không quyết định vị trí row. Muốn thứ tự phải `ORDER BY`.

> [!question]- Câu 2. Sau `UPDATE`, `ctid` của row đổi từ (7,3) sang (7,9). Index trên cột *không đổi* có cần sửa không?
> Phụ thuộc: nếu là **HOT** (cùng page 7, không cột index nào đổi) → **không**, index vẫn trỏ (7,3) và đi theo chuỗi. Nếu là update thường → **mọi index** phải thêm entry trỏ (7,9).

> [!question]- Câu 3. Vì sao VACUUM phải dọn index trước rồi mới giải phóng slot trong heap?
> Để không còn index entry nào trỏ vào CTID đã được cấp lại cho row khác — nếu không, index sẽ trỏ nhầm.

> [!question]- Câu 4. Autovacuum chạy đều mà bảng vẫn phình. Hai nguyên nhân đầu tiên cần kiểm tra?
> (1) **Horizon bị giữ** bởi transaction dài/`idle in transaction`/replication slot — VACUUM không được xóa. (2) **Tốc độ sinh rác > tốc độ dọn** (non-HOT update nhiều, scale factor 20 % quá lười).

> [!question]- Câu 5. `Index Only Scan ... Heap Fetches: 90 000`. Bạn làm gì?
> Kiểm tra **visibility map**: bảng vừa bị sửa nhiều chưa VACUUM, hoặc horizon bị giữ. Chạy/điều chỉnh autovacuum (hạ `scale_factor`), xử lý transaction dài; nếu cột cần lấy không nằm trong index thì thêm `INCLUDE`.

> [!question]- Câu 6. Vì sao đừng index cột `updated_at` nếu nó đổi ở mọi UPDATE?
> Vì mỗi UPDATE sẽ **không còn là HOT** (cột có index bị đổi) ⇒ ghi lại mọi index, sinh rác trong index, vacuum nặng và bảng/index phình nhanh.

---

## 14. Checklist thực hành

- [ ] Biết bảng nào là **update-nặng** (`n_tup_upd`, `hot_pct`) và vì sao HOT thấp (index trên cột nóng? `fillfactor` 100?).
- [ ] Autovacuum riêng cho bảng nóng (scale factor thấp, cost delay hợp lý); theo dõi `n_dead_tup`, `last_autovacuum`.
- [ ] Có cảnh báo cho **transaction dài / idle in transaction / replication slot không hoạt động**; đặt `idle_in_transaction_session_timeout`.
- [ ] Theo dõi **kích thước bảng và index theo thời gian** (tăng đều khi số dòng thật không tăng = bloat).
- [ ] Với truy vấn index-only quan trọng: kiểm `Heap Fetches` bằng `EXPLAIN (ANALYZE)`.
- [ ] Có kế hoạch trả dung lượng: `pg_repack` / `REPACK` (PG 19) / partition-and-drop, **không** `VACUUM FULL` giờ cao điểm.
- [ ] Không dùng `ctid` làm định danh bền.

---

## 🔗 Chuỗi tri thức liên quan

**Cùng chủ đề (PostgreSQL)**
- [[Database-Patterns/PostgreSQL/02-MVCC-Concurrency|02 — MVCC & Concurrency]] — xmin/xmax, snapshot, wraparound (bài này là bản "chạm vật lý")
- [[Database-Patterns/PostgreSQL/18-Snapshot-Internals-Deep-Dive|18 — Snapshot Internals]] — luật nhìn thấy tuple chi tiết
- [[Database-Patterns/PostgreSQL/04-Index-Internals|04 — Index Internals]] — B-Tree, covering/partial index
- [[Database-Patterns/PostgreSQL/05-Performance-Tuning|05 — Performance Tuning]] — cấu hình vacuum
- [[Database-Patterns/PostgreSQL/07-Count-Star-vs-Count-Column|07 — COUNT(*) vs COUNT(col)]] — visibility map khi đếm
- [[Database-Patterns/PostgreSQL/01-ACID-Internals|01 — ACID Internals]] — WAL
- [[Database-Patterns/PostgreSQL/08-MVCC-MySQL-PostgreSQL-Oracle|08 — MVCC: MySQL vs PostgreSQL vs Oracle]]

**Cặp bài về lưu trữ & ID**
- [[Database-Patterns/B-Tree-Clustered-Index-Random-Write-Cost|B-tree, clustered index và cái giá của ghi random]] — phía InnoDB: row nằm *trong* cây PK
- [[Database-Patterns/Chon-Kieu-ID-He-Thong-Hien-Dai|Chọn kiểu ID cho hệ thống hiện đại]]

**Áp dụng**
- [[Microservices-Patterns/Transactional-Outbox|Transactional Outbox]] · [[Database-Patterns/Hibernate-Performance-Deep-Dive|Hibernate Performance Deep Dive]] · [[_moc/MOC-PDMS|MOC PDMS]]

**Hub**
- [[Database-Patterns/PostgreSQL/00-PostgreSQL-Hub|PostgreSQL Hub]] · [[Database-Patterns/00-Hub-Database-Persistence|Hub Database Persistence]] · [[_moc/MOC-Database|MOC Database]] · [[_moc/MOC-Database-Internals|MOC Database Internals]]

---

*Tags: #postgresql #heap #ctid #vacuum #hot-update #bloat #visibility-map #index-only-scan*


---

## 🛠 Usage — công thức dùng ngay

### U1. Runbook chẩn đoán "bảng phình / vacuum không dọn được" (chạy theo thứ tự)

```sql
-- ① Bảng nào nhiều dead tuple? (n_dead_tup là ƯỚC LƯỢNG từ thống kê, không phải số đếm chính xác)
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_autovacuum, autovacuum_count
FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 20;

-- ② Ai đang giữ horizon? (transaction dài, idle in transaction)
SELECT pid, usename, state, now() - xact_start AS xact_age,
       age(backend_xmin) AS xmin_age, left(query, 80) AS q
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL OR state = 'idle in transaction'
ORDER BY xact_age DESC NULLS LAST LIMIT 20;

-- ③ Replication slot bỏ quên giữ xmin + WAL
SELECT slot_name, slot_type, active, xmin, catalog_xmin,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots;

-- ④ Prepared transaction (2PC) bị treo
SELECT gid, prepared, owner, database FROM pg_prepared_xacts;

-- ⑤ Tuổi XID theo database (nguy cơ wraparound)
SELECT datname, age(datfrozenxid) AS xid_age FROM pg_database ORDER BY xid_age DESC;

-- ⑥ VACUUM đang ở pha nào, tiến độ ra sao
SELECT pid, relid::regclass AS tbl, phase, heap_blks_total, heap_blks_scanned,
       heap_blks_vacuumed, index_vacuum_count
FROM pg_stat_progress_vacuum;
```

Đọc kết quả: ① cao + ② có transaction cũ ⇒ nguyên nhân là **horizon**; ① cao + ② sạch + `last_autovacuum` cũ ⇒ **autovacuum không theo kịp**; ⑥ chạy lâu với `index_vacuum_count` lớn ⇒ **quá nhiều index / bộ nhớ dead-tuple nhỏ** (trước PG 17).

### U2. Ba "công thức" autovacuum theo từng kiểu bảng (đặt theo bảng, không động vào global)

```sql
-- (a) Bảng cập nhật liên tục (trạng thái hồ sơ): mục tiêu HOT + dọn sớm
ALTER TABLE case_status SET (
    fillfactor                      = 85,      -- chừa 15 % mỗi page; CHỈ áp cho page mới (xem Mistake 6)
    autovacuum_vacuum_scale_factor  = 0.02,
    autovacuum_vacuum_threshold     = 1000,
    autovacuum_vacuum_cost_limit    = 1000     -- mặc định hiệu dụng 200: quá thấp cho ổ SSD/NVMe
);

-- (b) Bảng queue/outbox (insert → xử lý → delete): churn cao nhưng luôn nhỏ → dọn theo số tuyệt đối
ALTER TABLE outbox_events SET (
    autovacuum_vacuum_scale_factor  = 0.0,
    autovacuum_vacuum_threshold     = 5000,
    autovacuum_vacuum_cost_limit    = 2000
);
-- Tốt hơn cả: partition theo ngày, DROP/DETACH partition cũ → không sinh dead tuple, không cần vacuum

-- (c) Bảng chỉ-insert lớn (audit/log): để visibility map được set đều (PG 13+)
ALTER TABLE audit_log SET (
    autovacuum_vacuum_insert_scale_factor = 0.05,
    autovacuum_vacuum_insert_threshold    = 100000
);
```

> Mọi con số trên là **điểm khởi đầu** để thử và đo (`n_dead_tup`, thời gian chạy vacuum, `Heap Fetches`), không phải giá trị chuẩn.

### U3. Làm UPDATE thành HOT: kiểm toán index và đo tỉ lệ HOT

```sql
-- Index chưa từng được dùng (ứng viên bỏ). Lưu ý: idx_scan tính từ lần reset thống kê;
-- kiểm tra cả replica và chu kỳ nghiệp vụ (báo cáo cuối tháng/quý) trước khi xóa.
SELECT s.schemaname, s.relname, s.indexrelname, s.idx_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
ORDER BY pg_relation_size(s.indexrelid) DESC;

-- Bảng update nhiều mà HOT thấp
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 1) AS hot_pct
FROM pg_stat_user_tables WHERE n_tup_upd > 10000
ORDER BY hot_pct NULLS FIRST LIMIT 20;
```

Quy trình: (1) tìm cột bị UPDATE mà **có index** (đối chiếu `pg_index` với câu UPDATE thực tế), (2) bỏ index không cần hoặc chuyển cột hay đổi sang bảng riêng, (3) `fillfactor` 80–90, (4) viết lại bảng một lần để page cũ cũng có chỗ trống (U4), (5) đo lại `hot_pct`.

### U4. Thu hồi dung lượng an toàn — chọn đúng công cụ

| Mục tiêu | Công cụ | Khoá | Lưu ý |
|---|---|---|---|
| Chỉ **index** bị bloat | `REINDEX INDEX CONCURRENTLY` | Khoá ngắn, không chặn ghi | Cần chỗ trống ≈ kích thước index; có thể để lại index "invalid" nếu hủy giữa chừng |
| Bảng + index bloat, hệ thống 24/7 | `pg_repack` (extension) hoặc `REPACK (CONCURRENTLY)` (PG 19) | Chỉ giữ khoá mạnh ngắn ở cuối | `pg_repack` cần PK hoặc unique index trên cột NOT NULL; `REPACK CONCURRENTLY` có giới hạn (đọc release notes) |
| Có cửa sổ bảo trì | `VACUUM FULL` | **ACCESS EXCLUSIVE** (chặn cả đọc) | Cần chỗ trống ≈ dữ liệu sống của bảng + index |
| Dữ liệu theo thời gian / queue | Partition + `DETACH`/`DROP` | Khoá ngắn | Không sinh dead tuple; cách rẻ nhất |
| Chỉ cần *ngừng phình* | Chữa nguyên nhân (U1) + autovacuum (U2) | — | File không nhỏ lại nhưng chỗ trống được tái dùng |

### U5. Tối ưu Index-Only Scan: kiểm tra từng mắt xích

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT id, v FROM lab_ios WHERE id BETWEEN 1 AND 20000;   -- đọc dòng "Heap Fetches"

SELECT * FROM pg_visibility_map_summary('lab_ios');                  -- số page all_visible / all_frozen

SELECT relpages, relallvisible,
       round(100.0 * relallvisible / NULLIF(relpages, 0), 1) AS visible_pct
FROM pg_class WHERE relname = 'lab_ios';       -- planner dựa vào relallvisible (do VACUUM cập nhật) để cân nhắc index-only
```

Checklist: cột cần lấy có nằm trong index (`INCLUDE`)? · `SELECT` có kéo cột ngoài index (hoặc `*`)? · `visible_pct` cao? · autovacuum chạy gần đây? · có transaction dài giữ horizon? · bảng chỉ-insert đã có `autovacuum_vacuum_insert_*` (U2-c)?

### U6. Ngưỡng cảnh báo — điểm khởi đầu (hãy hiệu chỉnh theo hệ thống)

| Tín hiệu | Gợi ý ngưỡng khởi đầu | Hành động |
|---|---|---|
| `idle in transaction` | > 5 phút | Tìm app giữ transaction; đặt `idle_in_transaction_session_timeout` |
| Transaction dài trên primary OLTP | > 30–60 phút | Chuyển báo cáo sang replica/snapshot |
| Replication slot không active + WAL giữ lại | tăng liên tục | Xóa slot nếu consumer đã chết |
| `age(datfrozenxid)` | cảnh báo ≥ 500 triệu, nghiêm trọng ≥ 1 tỷ | Kiểm tra autovacuum anti-wraparound |
| `hot_pct` bảng update-nặng | < 50 % kéo dài | U3 |
| `dead_pct` | > 20 % kéo dài | U1 → U2 |
| Kích thước bảng/index tăng khi số dòng thật không tăng | xu hướng tuần/tháng | Bloat: U1, U4 |

---

## ⚠️ Mistakes — lỗi thường gặp (cơ chế · cách phát hiện · cách sửa)

| # | Lỗi | Vì sao sai (cơ chế) | Cách phát hiện | Cách sửa |
|---|---|---|---|---|
| 1 | Chạy `VACUUM FULL` giờ cao điểm để "gọn bảng" | Viết lại bảng với khoá **ACCESS EXCLUSIVE** ⇒ mọi truy vấn chờ; cần thêm chỗ đĩa cỡ dữ liệu sống | Hàng đợi `pg_locks`/`pg_stat_activity` chờ lock | `pg_repack`/`REPACK CONCURRENTLY`, hoặc cửa sổ bảo trì |
| 2 | Tắt autovacuum (toàn cục hoặc theo bảng) "cho nhanh" | Bảng phình, visibility map không được set (index-only chậm), thống kê cũ (plan xấu), nguy cơ XID wraparound | `SHOW autovacuum;` và `SELECT relname, reloptions FROM pg_class WHERE reloptions::text LIKE '%autovacuum_enabled=false%';` | Bật lại, chỉnh cost/threshold thay vì tắt |
| 3 | Để mặc định throttle cho bảng nóng trên SSD/NVMe | Cost limit hiệu dụng thấp ⇒ vacuum chạy chậm hơn tốc độ sinh rác | `pg_stat_progress_vacuum` tiến chậm; `n_dead_tup` vẫn tăng | `autovacuum_vacuum_cost_limit` theo bảng (U2), cân nhắc tăng số worker; PG 19: autovacuum song song trên index |
| 4 | Transaction mở lâu / `idle in transaction` (ORM open-in-view, gọi API ngoài trong `@Transactional`) | Giữ **horizon** ⇒ VACUUM không được xóa bản cũ ⇒ bloat toàn DB | U1-② | Rút ngắn transaction, tắt open-in-view ([[Database-Patterns/Hibernate-Performance-Deep-Dive\|Hibernate Deep Dive]]), `idle_in_transaction_session_timeout` |
| 5 | Index mọi cột lọc, kể cả cột hay UPDATE (`updated_at`, `status`) | Đổi cột có index ⇒ không HOT ⇒ ghi lại **mọi** index, sinh rác trong index | `hot_pct` thấp (U3) | Bỏ index không cần; partial index; tách cột nóng sang bảng riêng |
| 6 | Kỳ vọng `ALTER TABLE SET (fillfactor=…)` có hiệu lực ngay | Chỉ áp cho **page mới**; page cũ giữ nguyên độ đầy | `pgstattuple`: `free_percent` không đổi | Viết lại bảng một lần (U4) |
| 7 | Dùng `ctid` làm khoá/tham chiếu qua transaction | CTID đổi khi UPDATE non-HOT, `VACUUM FULL`, `CLUSTER`; có thể trỏ nhầm row khác | Mã nguồn lưu `ctid` | Dùng khoá nghiệp vụ/PK; `ctid` chỉ để debug trong một câu lệnh |
| 8 | Coi `n_dead_tup` là số chính xác | Là ước lượng từ thống kê; có thể lệch hoặc bị reset | So với `pgstattuple`/`pgstattuple_approx` | Đo chính xác khi cần quyết định |
| 9 | Nhầm "chỗ trống ổn định" là bloat rồi repack liên tục | Bảng khoẻ mạnh luôn có chỗ trống tái dùng; repack chỉ tạo churn I/O và có thể phình lại | Kích thước *không tăng* theo thời gian | Chỉ xử lý khi **xu hướng tăng** hoặc cần trả dung lượng thật |
| 10 | Kỳ vọng "Heap Fetches = 0" trên bảng ghi nặng, hoặc `SELECT *` rồi mong index-only | Mỗi lần sửa tắt bit all-visible của page; cột ngoài index buộc ra heap | `EXPLAIN ANALYZE`; `visible_pct` (U5) | `INCLUDE`, chọn cột tối thiểu, vacuum sớm hơn |
| 11 | Queue/outbox xử lý bằng `DELETE` hàng loạt | Mỗi row xóa là một dead tuple + index entry chờ dọn ⇒ vacuum nặng, bảng "nhỏ mà phình" | `n_dead_tup` cao, bảng ít dòng sống | Partition theo thời gian + `DROP`, hoặc `TRUNCATE` khi xóa toàn bộ |
| 12 | `autovacuum_vacuum_scale_factor = 0` với threshold quá nhỏ | Vacuum chạy liên tục, mỗi lần quét lại các index (pha 2) ngay cả khi rất ít rác (PG 14+ có bypass nhưng không phải lúc nào cũng áp dụng) | `autovacuum_count` tăng vọt, I/O nền cao | Threshold theo mức churn thực tế (U2-b) |
| 13 | Để replication slot không còn consumer | Slot giữ `xmin`/WAL ⇒ giữ horizon và làm đầy đĩa WAL | U1-③ | Xóa slot (`pg_drop_replication_slot`) khi consumer đã ngừng hẳn |
| 14 | Bật `hot_standby_feedback` mà không đánh giá | Truy vấn dài trên replica giữ horizon của primary ⇒ bloat trên primary | Xmin của replica trong `pg_stat_replication` cũ | Cân nhắc đánh đổi với hủy truy vấn xung đột (`max_standby_streaming_delay`) |
| 15 | Dùng `REPACK CONCURRENTLY` (PG 19) như thay thế vô điều kiện cho `VACUUM FULL` | Một số nguồn lưu ý giới hạn (không an toàn MVCC hoàn toàn, tương tác khoá) | Đọc release notes + thử trên bản sao | Thử nghiệm kỹ, kiểm tra khoá chờ trước khi dùng production |

---

## 📚 Tài liệu dẫn chứng

### Bảng: khẳng định → nguồn

| Khẳng định trong bài | Nguồn |
|---|---|
| Page 8 KB, header 24 B, line pointer 4 B, tuple header ~23 B; CTID = (block, offset) | R1 |
| HOT: điều kiện, pruning, line pointer `REDIRECT` | R2 |
| Visibility map: bit `all-visible`/`all-frozen`; bị xóa khi page bị sửa; dùng cho index-only scan và VACUUM | R3, R6 |
| Free Space Map | R4 |
| VACUUM: tái dùng chỗ trống, hiếm khi trả file; `VACUUM FULL` viết lại bảng với khoá mạnh | R5, R7 |
| Index-only scan vẫn phải kiểm tra visibility ở heap nếu page không all-visible; `Heap Fetches` | R6 |
| Ngưỡng autovacuum, `*_insert_*`, cost limit, `idle_in_transaction_session_timeout` | R8 |
| Hàm `heap_page_items`, `pgstattuple`, `pg_visibility` | R9 |
| `pg_stat_progress_vacuum` các pha | R10 |
| `pg_stat_user_tables` (`n_dead_tup`, `n_tup_hot_upd`), `pg_stat_user_indexes` | R11 |
| PG 13 (insert-triggered vacuum), 14 (bypass/failsafe), 17 (TidStore), 18 (eager freezing — đối chiếu bản bạn dùng) | R12 |
| PG 19: `REPACK`, parallel autovacuum, chấm điểm ưu tiên (bản RC khi viết) | R13 |
| `pg_repack` yêu cầu PK/unique NOT NULL | R14 |
| Vì sao phải dọn index trước khi giải phóng slot; 3 pha VACUUM | R16 (ch. 6), R5 |
| Lịch sử "no-overwrite storage" của POSTGRES | R17 |
| InnoDB dùng undo log (sửa tại chỗ) — đối chiếu | R18 |
| `REINDEX CONCURRENTLY` | R19 |

### Danh mục nguồn

- **R1** — PostgreSQL docs, *Database Page Layout*: https://www.postgresql.org/docs/current/storage-page-layout.html
- **R2** — PostgreSQL docs, *Heap-Only Tuples (HOT)*: https://www.postgresql.org/docs/current/storage-hot.html
- **R3** — PostgreSQL docs, *Visibility Map*: https://www.postgresql.org/docs/current/storage-vm.html
- **R4** — PostgreSQL docs, *Free Space Map*: https://www.postgresql.org/docs/current/storage-fsm.html
- **R5** — PostgreSQL docs, *Routine Vacuuming*: https://www.postgresql.org/docs/current/routine-vacuuming.html
- **R6** — PostgreSQL docs, *Index-Only Scans and Covering Indexes*: https://www.postgresql.org/docs/current/indexes-index-only-scans.html
- **R7** — PostgreSQL docs, `VACUUM`: https://www.postgresql.org/docs/current/sql-vacuum.html
- **R8** — PostgreSQL docs, *Automatic Vacuuming* (cấu hình): https://www.postgresql.org/docs/current/runtime-config-vacuum.html
- **R9** — `pageinspect`: https://www.postgresql.org/docs/current/pageinspect.html · `pgstattuple`: https://www.postgresql.org/docs/current/pgstattuple.html · `pg_visibility`: https://www.postgresql.org/docs/current/pgvisibility.html
- **R10** — PostgreSQL docs, *Progress Reporting*: https://www.postgresql.org/docs/current/progress-reporting.html
- **R11** — PostgreSQL docs, *The Cumulative Statistics System*: https://www.postgresql.org/docs/current/monitoring-stats.html
- **R12** — Release notes: https://www.postgresql.org/docs/release/13.0/ · https://www.postgresql.org/docs/release/14.0/ · https://www.postgresql.org/docs/release/17.0/ · https://www.postgresql.org/docs/release/18.0/
- **R13** — PostgreSQL 19 (bản devel/RC khi viết): `REPACK` https://www.postgresql.org/docs/devel/sql-repack.html · EDB: https://www.enterprisedb.com/blog/postgresql-19-what-changed-what-matters-and-what-test-now · PlanetScale: https://www.planetscale.com/blog/whats-new-in-postgres-19
- **R14** — `pg_repack`: https://github.com/reorg/pg_repack
- **R15** — B. Momjian, *MVCC Unmasked*: https://momjian.us/main/writings/pgsql/mvcc.pdf
- **R16** — H. Suzuki, *The Internals of PostgreSQL*: https://www.interdb.jp/pg/
- **R17** — M. Stonebraker, *The Design of the POSTGRES Storage System*, VLDB 1987.
- **R18** — MySQL 8.4, *InnoDB Multi-Versioning*: https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html
- **R19** — PostgreSQL docs, `REINDEX`: https://www.postgresql.org/docs/current/sql-reindex.html
- **R20** — J. M. Hellerstein, M. Stonebraker, J. Hamilton, *Architecture of a Database System*, Foundations and Trends in Databases 1(2), 2007.

> Lưu ý trung thực: thông tin PG 19 lấy từ tài liệu devel/RC và bài viết bên thứ ba tại thời điểm 2026-11-02 — **đọc release notes chính thức của bản bạn triển khai** trước khi dùng. Các ngưỡng trong U2/U6 là điểm khởi đầu để đo, không phải giá trị chuẩn. Phiên bản ví dụ XID, ctid, kết quả `EXPLAIN` trong bài là minh họa.
