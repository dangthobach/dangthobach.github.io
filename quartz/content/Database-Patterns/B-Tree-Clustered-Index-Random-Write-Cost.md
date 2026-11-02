---
type: deep-dive
domain: database
status: active
created: 2026-11-02
updated: 2026-11-02
tags: [database, b-tree, b-plus-tree, clustered-index, innodb, postgresql, buffer-pool, page-split, change-buffer, fragmentation, random-write, write-amplification, pdms]
aliases: [Cái giá của ghi random, B-Tree và random write, Clustered index cost, Page split và buffer pool, InnoDB write path]
---

# B-tree, clustered index và cái giá của ghi random (Database)

> **Mục tiêu:** Nối **một mạch** từ đơn vị vật lý nhỏ nhất (page) đến hiện tượng người dùng nhìn thấy (insert chậm dần, index phình, backup chậm) — để khi ai đó nói "UUID random làm chậm DB", bạn chỉ ra được *chính xác* cơ chế nào đang chạy ở từng tầng.
>
> Bài này là phần **cơ chế nền** của [[Database-Patterns/Chon-Kieu-ID-He-Thong-Hien-Dai|Chọn kiểu ID cho hệ thống hiện đại]]: bài kia trả lời *"chọn ID nào"*, bài này trả lời *"vì sao thứ tự khóa quyết định chi phí ghi"*.

> [!summary] TL;DR — chuỗi nhân quả
> **Thứ tự khóa → vị trí lá bị chạm → page đó có trong buffer pool không → page có đủ chỗ không (page split) → fill factor → kích thước index → working set so với RAM → tỉ lệ miss → I/O đọc ngẫu nhiên + flush ngẫu nhiên (+ doublewrite/WAL) → phân mảnh.**
> Một mắt xích xấu làm mắt xích sau xấu theo, và vòng **index to ra → miss tăng → I/O tăng** là vòng phản hồi dương: hiệu năng không giảm tuyến tính mà **rơi vách đá** khi working set vượt RAM.

---

## 0. Bản đồ cả mạch

```
 ┌──────────────┐   ┌────────────────┐   ┌────────────────────┐   ┌──────────────────┐
 │ ① PAGE       │──►│ ② B+TREE       │──►│ ③ CLUSTERED vs HEAP│──►│ ④ BUFFER POOL    │
 │ đơn vị I/O   │   │ fanout, height │   │ row nằm ở đâu?     │   │ RAM giữ page nào │
 └──────────────┘   └────────────────┘   └────────────────────┘   └────────┬─────────┘
                                                                           │
 ┌──────────────┐   ┌────────────────┐   ┌────────────────────┐   ┌────────▼─────────┐
 │ ⑨ ĐO & CHỮA  │◄──│ ⑧ PHÂN MẢNH    │◄──│ ⑥ CHANGE BUFFER    │◄──│ ⑤ ĐƯỜNG ĐI CỦA   │
 │              │   │ nội + ngoại    │   │ (cứu secondary idx)│   │   MỘT INSERT     │
 └──────────────┘   └────────────────┘   └────────────────────┘   └────────┬─────────┘
                                                                           │
                                                                  ┌────────▼─────────┐
                                                                  │ ⑦ PAGE SPLIT     │
                                                                  └──────────────────┘
```

Các mục dưới đi theo đúng thứ tự ①→⑨; §9 gộp lại thành một ví dụ định lượng.

> Nền tảng liên quan trong vault: [[Database-Patterns/PostgreSQL/04-Index-Internals|PostgreSQL Index Internals]] · [[Database-Patterns/PostgreSQL/01-ACID-Internals|ACID Internals (WAL)]] · [[concepts/memory-hierarchy-cpu-cache|Memory Hierarchy & CPU Cache]] · [[Database-Patterns/PostgreSQL/08-MVCC-MySQL-PostgreSQL-Oracle|MVCC MySQL vs PostgreSQL vs Oracle]]

---

## 1. ① Page — đơn vị I/O, không phải row

Database không đọc/ghi từng row. Nó đọc/ghi **page** (block) vì thiết bị lưu trữ và OS làm việc theo khối, và vì một lần seek/IO phải được "chia" cho nhiều byte hữu ích.

| Engine | Kích thước page mặc định | Ghi chú |
|---|---|---|
| InnoDB | **16 KB** (`innodb_page_size`) | Nhóm thành *extent* 1 MB = 64 page; mỗi index có segment riêng cho lá và nhánh |
| PostgreSQL | **8 KB** (`BLCKSZ`, đặt lúc compile) | Heap page và index page cùng kích thước |

```
 Page 16 KB (InnoDB INDEX page, rút gọn)
 ┌─────────────────────────────────────────────────────────────┐
 │ FIL header │ PAGE header │ Infimum/Supremum │ record │ record│
 │            │ (level, n_recs, last_insert, direction…)        │
 │ … record … free space … │ PAGE DIRECTORY (slots) │ FIL trailer│
 └─────────────────────────────────────────────────────────────┘
   ▲ ghi/đọc nguyên khối 16 KB, dù chỉ sửa 1 row ~200 B
```

**Hệ quả gốc rễ của cả bài:** sửa **1 row = làm bẩn (dirty) cả 1 page**. Cuối cùng cả page 16 KB phải được flush. Nếu một page "hút" được nhiều row sửa trước khi flush thì rẻ; nếu mỗi page chỉ nhận 1 row rồi bị flush thì đắt gấp trăm lần (xem §9).

---

## 2. ② B+Tree — fanout, chiều cao và vì sao lá mới là chỗ tốn kém

```
                          ┌───────────────┐
                 level 3  │     ROOT      │  1 page
                          └───┬───────┬───┘
                 level 2   [ nhánh ] [ nhánh ]  ~9 page
                 level 1   [ nhánh ] … [ nhánh ] ~4.8 nghìn page   ← ~78 MB, luôn nằm trong RAM
                 level 0   [LÁ]→[LÁ]→[LÁ]→ … →[LÁ]              ~2.86 triệu page (≈ 46 GB)
                            └── lá nối nhau thành danh sách liên kết (range scan đi ngang)
```

- **Nhánh (non-leaf)** chỉ lưu `(khóa phân tách, số page con)`, **lá (leaf)** lưu dữ liệu thật (với InnoDB clustered index: *nguyên row*).
- **Fanout** = số con mỗi page nhánh ≈ `(16384 × ~15/16) / (key + 4 B con trỏ + header ~6 B)`:
  - key `BIGINT` (8 B) → ≈ 850 · key `BINARY(16)` → ≈ 590 · key `CHAR(36)` → ≈ 330.
- **Ví dụ 200 triệu row, row ≈ 220 B, PK `BINARY(16)`, fill ≈ 15/16:** ≈ 70 row/lá ⇒ ≈ 2,86 triệu lá ⇒ ≈ 4.800 page level-1 ⇒ ≈ 9 page level-2 ⇒ 1 root ⇒ **chiều cao 4**. Tìm 1 row = tối đa 4 page access.

> [!tip] Điều quan trọng nhất của mục này
> Ba tầng trên chỉ chiếm ~0,2 % kích thước index (≈ 78 MB trên 46 GB) nên **gần như luôn nằm trong buffer pool**. Mọi cuộc chiến về cache/I/O diễn ra ở **tầng lá**. Vì vậy chi phí ghi quy về một câu hỏi: *"mỗi insert chạm vào lá nào, và lá đó có nóng không?"*

PostgreSQL dùng biến thể Lehman–Yao: mỗi page có *high key* và *right-link* để reader/writer đồng thời tiếp tục đi ngang sang phải khi một page đang split — nên split không chặn đọc. Chi tiết: [[Database-Patterns/PostgreSQL/04-Index-Internals|04-Index-Internals]] · [[concepts/postgresql-index-internals|PostgreSQL Index Internals (concept)]].

---

## 3. ③ Clustered index vs heap — row nằm ở đâu quyết định "ID có phải là vị trí vật lý không"

```
        InnoDB (clustered)                          PostgreSQL (heap + index)

   PK B+Tree  ── lá = NGUYÊN ROW                 heap (append, không theo thứ tự khóa)
        ▲                                         ┌────────────────────────────┐
        │  secondary index lá = (key, PK)         │ page: row, row, row, …      │
 secondary B+Tree ─► lấy PK ─► đi lại PK tree     └────────────────────────────┘
        (2 lần duyệt cây)                               ▲ ctid (page, offset)
                                                  index B-Tree lá = (key, ctid)
```

| | InnoDB | PostgreSQL |
|---|---|---|
| Row sống ở đâu | **Lá của PK B+Tree** | Heap, thứ tự chèn |
| Thứ tự PK ảnh hưởng vị trí row? | **Có — trực tiếp** | Không (chỉ ảnh hưởng *index*) |
| Secondary index trỏ về | **PK value** (nhân kích thước PK vào mọi index) | `ctid` 6 byte, cố định |
| Chèn PK ngẫu nhiên | Random vào **bảng + mọi index** | Heap vẫn append; **chỉ index B-Tree** bị random |
| Đổi PK/row move | Row di chuyển ⇒ đắt | UPDATE tạo version mới (xem [[Database-Patterns/PostgreSQL/02-MVCC-Concurrency\|MVCC]]) |

Vì vậy chuyện "UUIDv4 giết InnoDB" mạnh hơn nhiều so với PostgreSQL — nhưng cả hai đều trả giá ở tầng index. Phân tích kích thước PK nhân theo số index: [[Database-Patterns/Chon-Kieu-ID-He-Thong-Hien-Dai|bài ID Strategy §2.3]].

---

## 4. ④ Buffer pool — RAM giữ page nào, và "vách đá" ở đâu

Buffer pool (InnoDB) / `shared_buffers` (PostgreSQL) là cache các page trong RAM. Mọi đọc/ghi đều **đi qua nó**.

```
        yêu cầu page P
              │
      ┌───────▼────────┐  HIT  → dùng ngay (ns–µs)
      │  Buffer pool   │
      └───────┬────────┘  MISS → đọc 1 page 16 KB từ đĩa (µs–ms), thường phải đuổi 1 page khác
              │                 (nếu page bị đuổi đang dirty → phải flush trước)
              ▼
         đĩa / SSD
```

**InnoDB buffer pool** dùng LRU có *midpoint insertion*: page mới đọc vào chèn ở điểm 3/8 (`innodb_old_blocks_pct = 37`), chỉ lên "young" nếu được truy cập lại sau `innodb_old_blocks_time` (1000 ms) — để một lần full scan không làm bay hết working set. Page bị sửa vào **flush list** (xếp theo LSN sửa đầu tiên); *page cleaner* flush nền, kiểm soát bởi `innodb_io_capacity` và checkpoint. PostgreSQL dùng clock-sweep và còn có thêm **OS page cache** phía dưới (double buffering).

### Công thức vách đá

Với truy cập ngẫu nhiên đều lên các lá, cache giữ được `BP / kích thước_lá` của chúng:

```
  miss_rate  ≈  1 − (buffer_pool / kích_thước_các_lá)        (khi lá > buffer pool, ngược lại ≈ 0)
```

Ví dụ buffer pool 16 GB:

| Kích thước lá của B-Tree | PK tuần tự (hot tail) | PK ngẫu nhiên |
|---|---|---|
| 8 GB | miss ≈ 0 % | miss ≈ 0 % |
| 16 GB | ≈ 0 % | ≈ 0 % |
| 32 GB | **≈ 0 %** | ≈ 50 % |
| 64 GB | **≈ 0 %** | ≈ 75 % |
| 128 GB | **≈ 0 %** | ≈ 87,5 % |

Hai cột giống hệt nhau khi bảng còn nhỏ — **đó là lý do UUIDv4 "chạy tốt" trong dev/staging rồi gãy ở production**. PK tuần tự không có vách đá vì working set của *insert* luôn chỉ là vài page cuối, không phụ thuộc tổng kích thước.

> Nội dung này là mô hình bậc nhất (truy cập đều). Thực tế còn skew, page cold/hot, readahead — nên coi là **công cụ lập luận**, không phải dự báo con số.

---

## 5. ⑤ Đường đi của một INSERT (InnoDB) — hai kịch bản

Bảng `document(id BINARY(16) PK, …)` + 2 secondary index. So sánh PK tuần tự (UUIDv7/auto-inc) với PK ngẫu nhiên (UUIDv4):

```
 INSERT một row
   │
   ├─ 1. Duyệt PK B+Tree từ root xuống lá đích               [nhánh: luôn HIT]
   │      • tuần tự : lá đích = lá phải nhất → HIT (nóng)
   │      • ngẫu nhiên: lá đích bất kỳ → có thể MISS → đọc 1 page 16 KB ngẫu nhiên
   │
   ├─ 2. Lá còn chỗ?  ── có ─► chèn record, sửa page directory
   │                  └─ không ─► PAGE SPLIT (§7): cấp page mới, chia record, sửa nhánh cha
   │
   ├─ 3. Ghi REDO LOG (WAL) — tuần tự, thêm vào cuối, fsync khi commit
   │      (split ⇒ redo cho nhiều page: lá cũ, lá mới, nhánh cha)
   │
   ├─ 4. Với mỗi secondary index: chèn (key, PK) vào lá của index đó
   │      • nếu lá không trong RAM & index NON-UNIQUE → có thể đẩy vào CHANGE BUFFER (§6)
   │      • UNIQUE index: phải đọc lá để kiểm tra trùng → không buffer được
   │
   └─ 5. Page bị dirty nằm trong flush list; flush nền về đĩa SAU commit
          (qua DOUBLEWRITE để chống torn page → ghi 2 lần)
```

| Bước | PK tuần tự | PK ngẫu nhiên |
|---|---|---|
| Lá PK | Hit (đuôi nóng) | **Miss khi bảng > RAM** (đọc ngẫu nhiên) |
| Page split | Hiếm, **split tại điểm chèn** → trang trái đầy | Thường xuyên, **chia ~½** → hai trang nửa trống |
| Redo/WAL | Mỗi page nhận nhiều row trước khi bị flush | Nhiều page bị chạm → nhiều bản ghi hơn |
| Flush | Một page dirty chứa nhiều row mới ⇒ 1 lần ghi 16 KB "trả cho" ~70 row | Một page dirty thường chỉ chứa **1** row mới ⇒ 16 KB trả cho 1 row |

**Write amplification chặn trên (worst case):** để lưu một row ≈ 220 B, nếu mỗi lần flush ghi 16 KB cho đúng 1 row mới ⇒ `16384 / 220 ≈ 75×`; cộng doublewrite ≈ gấp đôi lượng byte ghi. PK tuần tự: một page nhận ~70 row trước khi flush ⇒ ≈ 1×. Đây là chặn trên minh họa, không phải số đo.

---

## 6. ⑥ Change buffer — cứu được cái gì và **không** cứu được cái gì

**Ý tưởng:** khi cần sửa một lá của *secondary index* mà lá đó **không nằm trong buffer pool**, thay vì đọc nó lên (random read), InnoDB ghi thao tác (insert / delete-mark / purge) vào một B-Tree phụ (**change buffer**, nằm ở system tablespace và một phần buffer pool). Khi lá đó được đọc lên vì lý do khác — hoặc nền đến lượt — các thay đổi được **merge** vào.

```
   INSERT vào secondary index, lá KHÔNG trong RAM
        │
        ├─ non-unique index ─► ghi vào CHANGE BUFFER (không đọc lá)   ✓ tiết kiệm 1 random read
        │                         … sau đó, khi lá được nạp: MERGE      (gom nhiều thay đổi / 1 lần ghi)
        └─ UNIQUE index ─────► PHẢI đọc lá để kiểm tra trùng           ✗ không buffer insert được
```

Điều kiện / giới hạn (MySQL/InnoDB):
- Chỉ áp dụng cho **secondary index** (không phải clustered index/PK), và insert chỉ buffer được cho **non-unique**.
- `innodb_change_buffering` (mặc định `all`) và `innodb_change_buffer_max_size` (mặc định 25 % buffer pool, tối đa 50 %).
- Có chi phí ẩn: merge dồn lại có thể gây **đọc nặng/đột biến** khi nạp lá, và kéo dài thời gian shutdown/recovery nếu quá nhiều thay đổi chờ merge (`innodb_fast_shutdown = 0` ép merge toàn bộ).

> [!warning] Hai hiểu lầm hay gặp
> 1. **Change buffer KHÔNG cứu PK ngẫu nhiên.** Chèn vào clustered index luôn cần đọc lá đích (để đặt row và để kiểm tra PK duy nhất). Đó là lý do §5 bước 1 vẫn miss — change buffer chỉ giảm chi phí *secondary index non-unique*.
> 2. **Không phải engine nào cũng có.** PostgreSQL **không có** cơ chế tương đương. MariaDB đã đặt `innodb_change_buffering=none` mặc định từ 10.5.15/10.6.7, đánh dấu deprecated ở 10.9 và **gỡ hẳn ở 11.0** (nguồn tài liệu MariaDB: benchmark cho thấy nó đôi khi làm giảm hiệu năng, và là nguồn lỗi corruption khó tái hiện). Với MySQL, kiểm tra release notes của đúng phiên bản đang chạy trước khi dựa vào nó.

Tóm lại: ngay cả khi bật change buffer, **vị trí chèn của PK vẫn là thứ trả giá lớn nhất** — nên chọn ID có locality (§5) vẫn đúng.

---

## 7. ⑦ Page split — cơ chế và vì sao thứ tự khóa quyết định fill factor

Khi lá đích hết chỗ:

```
   Trước:   [ … 1 2 3 4 5 6 7 8 9 … ]  ← page đầy, cần chèn khóa K

   (a) CHÈN NGẪU NHIÊN (K nằm giữa) — chia ĐÔI
       [ 1 2 3 4 5 ]  [ 6 7 8 9 ]      → cả hai page ~½ đầy; K vào một trong hai
       + cấp 1 page mới (từ extent), chuyển ~½ record, sửa con trỏ lá trái/phải,
         thêm 1 mục vào nhánh cha (có thể làm cha split → lan lên trên)

   (b) CHÈN TUẦN TỰ (K lớn hơn tất cả) — tách tại điểm chèn
       [ 1 2 3 … 9 ]  [ K ]            → page cũ giữ NGUYÊN đầy; page mới chỉ có K
```

- **InnoDB** nhận diện hướng chèn (`PAGE_DIRECTION`, `last_insert` trong page header) và chọn *split point* tương ứng: chèn tuần tự ⇒ trang trái giữ đầy; ngẫu nhiên ⇒ chia ở median. Theo tài liệu MySQL, insert tuần tự cho page đầy ≈ **15/16** (1/16 để dành cho record lớn lên; `innodb_fill_factor = 100` mặc định), còn insert ngẫu nhiên chỉ ≈ **½ … 15/16**.
- **Lý thuyết B-Tree:** chèn khóa ngẫu nhiên đều ⇒ độ lấp đầy trung bình hội tụ về khoảng **ln 2 ≈ 69 %**.
- **PostgreSQL:** index B-Tree có `fillfactor` mặc định **90** — áp dụng khi split *lá phải nhất* (kịch bản tuần tự); split ở giữa cây chọn điểm chia cân bằng ~50/50. Có thêm các tối ưu (deduplication từ PG 13, bottom-up index deletion từ PG 14) giúp *trì hoãn* split nhưng không đổi bản chất.
- **Page merge:** khi xóa làm page rỗng dưới `MERGE_THRESHOLD` (mặc định 50 %), InnoDB gộp với lá lân cận — nên xóa/chèn ngẫu nhiên xen kẽ tạo "xích-xông" split ↔ merge.

**Chi phí một lần split:** cấp page + di chuyển ~½ record + sửa 3 page (hai lá + cha) ⇒ nhiều bản ghi redo, có khi lan ngược lên nhiều tầng. Trong PostgreSQL, nếu page chạm lần đầu sau checkpoint còn kéo theo **full-page image** vào WAL ([[Database-Patterns/PostgreSQL/01-ACID-Internals|ACID Internals]]).

**Hệ quả định lượng (ví dụ 200 M row, row ≈ 220 B, cùng cấu hình §2):**

| | Tuần tự (fill ≈ 15/16) | Ngẫu nhiên (fill ≈ 69 %) |
|---|---|---|
| Row / lá | ≈ 70 | ≈ 51 |
| Số lá | ≈ 2,86 triệu | ≈ 3,92 triệu |
| Kích thước PK B-Tree | ≈ 46,8 GB | ≈ 64,3 GB (**×1,37**) |

Index to hơn 37 % ⇒ cần 37 % RAM nhiều hơn để giữ cùng tỉ lệ cache ⇒ **đẩy vách đá của §4 đến sớm hơn**.

---

## 8. ⑧ Phân mảnh — hai loại, hai cách đo

```
 Internal fragmentation (trong page)         External fragmentation (giữa các page)
 ┌──────────────┐                            thứ tự logic:   P1 → P2 → P3 → P4
 │ record·····  │  page ½ trống                 vị trí vật lý: P1 … P3 … P2 … … P4
 │ ·············│  lãng phí RAM/đĩa/cache       range scan nhảy cóc → mất sequential I/O/readahead
 └──────────────┘
```

- **Nội (internal):** do split chia đôi + xóa để lại lỗ. Hậu quả: index/bảng phình, cache loãng (§7).
- **Ngoại (external):** page logic liền nhau không liền nhau trên đĩa vì page mới do split được cấp từ extent còn trống ở nơi khác. Hậu quả: range scan/backup/`SELECT COUNT` quét chậm do mất readahead; **trên HDD cực rõ, trên SSD nhẹ hơn nhưng vẫn mất lợi thế đọc tuần tự**.
- Tuần tự PK gần như **không phân mảnh ngoại ở dữ liệu mới** vì page mới luôn được cấp "tiếp theo". Dữ liệu cũ đã rải thì chỉ rebuild mới gom lại.

**Chữa:** MySQL `OPTIMIZE TABLE` / `ALTER TABLE … FORCE` (rebuild, dùng *sorted index build* nên fill đều); PostgreSQL `REINDEX INDEX CONCURRENTLY` (không chặn ghi), `pg_repack` cho bảng. Rebuild chỉ là thuốc giảm đau nếu khóa vẫn ngẫu nhiên — rồi sẽ phân mảnh lại.

---

## 9. Nối thành một mạch — vòng phản hồi và ví dụ định lượng

```
        khóa ngẫu nhiên
              │
              ▼
   lá đích rải khắp cây ─────────────► dirty page rải rác ─► flush 16 KB/row (+doublewrite)
              │                                                       │
              ▼                                                       ▼
   page split nhiều, chia ½ ─► fill ≈ ½–69 % ─► index to hơn          I/O ghi ↑
              │                                       │
              │                                       ▼
              │                         working set > buffer pool
              │                                       │
              ▼                                       ▼
   page cấp phát rải rác              miss ↑ ─► đọc ngẫu nhiên ↑ ─┐
   (phân mảnh ngoại)                          ▲                    │ cạnh tranh IOPS
              │                               └────────────────────┘ với flush → latency ↑
              ▼
   range scan / backup chậm
```

**Ví dụ gom lại:** 200 M row, buffer pool 16 GB, PK ngẫu nhiên 64 GB lá, ba B-Tree ngẫu nhiên được chạm mỗi insert (PK + 2 secondary không buffer được), thiết bị ≈ 50 nghìn IOPS 16 KB (giả định để minh họa):

```
  miss_per_insert  ≈ (1 − 16/64) × 3 = 0,75 × 3 ≈ 2,25 lần đọc ngẫu nhiên/insert
  trần theo đọc    ≈ 50 000 / 2,25 ≈ 22 000 insert/s   (chưa tính IOPS dành cho flush)
  cùng bảng, PK tuần tự: PK miss ≈ 0 ⇒ chỉ còn secondary → trần cao hơn nhiều bậc
```

Đây là **mô hình giả định** để thấy *bậc* chênh lệch và hình dạng vách đá; số thật phải đo (§10).

> [!warning] Giới hạn thành thật của "dùng ID tuần tự"
> - Nó chỉ sửa **clustered index** (và index tương quan thời gian). **Secondary index trên cột ngẫu nhiên** (email, hash, mã đối tác…) vẫn random insert — ID tốt không cứu được.
> - Tuần tự = **hot tail**: mọi writer tranh nhau lá phải nhất; ở tốc độ rất cao có thể thấy tranh chấp latch trên page cuối. Khi đó cân nhắc partitioning thay vì quay lại khóa ngẫu nhiên.
> - SSD/NVMe làm nhẹ *phân mảnh ngoại* và miss, nhưng **không xóa** write amplification, fill-factor loãng và vách đá RAM.
> - Với workload ghi ngẫu nhiên khổng lồ, **LSM-Tree** biến ghi ngẫu nhiên thành ghi tuần tự (đổi lại read/compaction amplification) — xem [[Performance-System-Programming/01-Database-Internals/04-SSTable-Format|SSTable Format]].

---

## 10. ⑨ Đo — đừng đoán

### MySQL / InnoDB

```sql
-- 1) Tỉ lệ miss buffer pool: Innodb_buffer_pool_reads (đọc đĩa) / read_requests (đọc logic)
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_read%';

-- 2) Đếm page split / merge (bật module index trước)
SET GLOBAL innodb_monitor_enable = 'module_index';
SELECT name, count FROM information_schema.INNODB_METRICS
WHERE name IN ('index_page_splits','index_page_merge_attempts','index_page_merge_successful');

-- 3) Kích thước từng index (đơn vị page) để so với buffer pool
SELECT table_name, index_name, stat_value * @@innodb_page_size AS bytes
FROM mysql.innodb_index_stats
WHERE stat_name = 'size' AND table_name = 'document';

-- 4) Mức lấp đầy ước lượng của các lá ĐANG nằm trong buffer pool (đắt trên BP lớn!)
SELECT index_name, COUNT(*) AS pages, ROUND(AVG(data_size) / @@innodb_page_size, 3) AS avg_fill
FROM information_schema.INNODB_BUFFER_PAGE
WHERE page_type = 'INDEX' AND table_name LIKE '%document%'
GROUP BY index_name;

-- 5) Change buffer đang làm gì (mục INSERT BUFFER AND ADAPTIVE HASH INDEX)
SHOW ENGINE INNODB STATUS\G
```

### PostgreSQL

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;
SELECT tree_level, index_size, leaf_pages, avg_leaf_density, leaf_fragmentation
FROM pgstatindex('idx_document_pkey');          -- avg_leaf_density thấp = loãng; fragmentation cao = lá lộn thứ tự

CREATE EXTENSION IF NOT EXISTS pageinspect;
SELECT * FROM bt_metap('idx_document_pkey');    -- chiều cao cây
SELECT * FROM bt_page_stats('idx_document_pkey', 1);

-- WAL do full-page image phình lên khi khóa ngẫu nhiên:
SELECT wal_fpi, wal_bytes FROM pg_stat_wal;     -- so sánh trước/sau khi đổi kiểu ID
```

**Thí nghiệm nên tự chạy (1 giờ):** tạo hai bảng giống hệt, chỉ khác PK (UUIDv4 vs UUIDv7), nạp đến khi lá > buffer pool, đo insert/s + `avg_fill` + `index_page_splits`/`wal_fpi`. Điểm "gãy" của đường cong là mốc thực của hệ thống bạn.

---

## 11. Biện pháp, xếp theo hiệu quả / chi phí

1. **Chọn khóa có locality cho clustered/PK B-Tree** — ID theo thời gian (UUIDv7/ULID/identity): sửa gốc của §5–§7. → [[Database-Patterns/Chon-Kieu-ID-He-Thong-Hien-Dai|ID Strategy]]
2. **Giảm số index & độ rộng index** — mỗi secondary index = thêm một B-Tree bị chạm mỗi insert và mang theo PK; dùng covering/partial index có chủ đích ([[Database-Patterns/PostgreSQL/05-Performance-Tuning|Performance Tuning]]).
3. **Đặt buffer pool đủ lớn** cho working set của lá nóng (InnoDB thường 50–75 % RAM máy chuyên dụng); theo dõi tỉ lệ miss.
4. **Nạp hàng loạt theo thứ tự PK** (sort trước khi bulk insert; tạo index *sau* khi nạp để dùng sorted index build) — liên quan hướng ETL ở [[Performance-System-Programming/03-Data-Format-Parsing/02-Read-Write-Separation-Type-Conversion|Read/Write Separation & Type Conversion]].
5. **Partitioning theo thời gian** để mỗi partition có B-Tree nhỏ, đuôi nóng nằm trong RAM và detach dữ liệu cũ rẻ ([[Database-Patterns/PostgreSQL/10-Sharding-When-Why-Pitfalls|Partitioning vs Sharding]]).
6. **`innodb_fill_factor` / `fillfactor`** chỉnh cho bảng *ít ghi, nhiều sửa tại chỗ* (chừa chỗ); đừng hạ tùy tiện cho bảng append-only vì làm index to ra.
7. **Rebuild định kỳ** (`OPTIMIZE`, `REINDEX CONCURRENTLY`) — chỉ khi nguyên nhân gốc (khóa ngẫu nhiên) đã được xử lý.
8. **Batch / `JDBC reWriteBatchedInserts`/multi-row insert**: gom nhiều row đi cùng một lá khi khóa có thứ tự ([[Database-Patterns/Hibernate-Performance-Deep-Dive|Hibernate Performance Deep Dive]]).

---

## 12. Áp dụng vào PDMS / VPBank

- **Bảng ghi nhiều, append-only** (outbox, audit, decision log): khóa theo thời gian + partition theo thời gian ⇒ đuôi nóng nhỏ, DETACH partition cũ rẻ. Đây là bài toán trong [[Microservices-Patterns/Transactional-Outbox|Transactional Outbox]] và [[Microservices-Patterns/AuthZ-Platform-Dynamic-5-Layer-Design|AuthZ Platform 5-Layer]].
- **Bảng hồ sơ (`document`)**: giữ PK kỹ thuật có locality, tách business key (`document_code`) làm UNIQUE secondary — nhớ rằng index đó **ngẫu nhiên theo mã** nên vẫn là một B-Tree trả giá ghi (nếu mã cấp tuần tự theo chi nhánh/ngày thì tốt hơn).
- **Migration/ETL khối lượng lớn:** sort theo PK trước khi nạp và dựng index sau là cách rẻ nhất để tránh toàn bộ chi phí §5–§7; bối cảnh migration xem [[Database-Patterns/DBMigration/DBMigration-06-Flyway-TechLead-Governance|Flyway Governance]].
- Đừng kết luận từ staging: nhớ **hai cột giống nhau khi bảng còn nhỏ** (§4). Kiểm thử tải phải vượt kích thước buffer pool.

---

## 13. Checklist

- [ ] Biết engine nào có clustered index (InnoDB: có; PostgreSQL: không) và PK ảnh hưởng vị trí row hay chỉ index.
- [ ] Ước lượng kích thước lá của từng index so với buffer pool/`shared_buffers` — có vượt không?
- [ ] PK có locality theo thời gian? Secondary index nào vẫn ngẫu nhiên?
- [ ] Đã đo: tỉ lệ miss, `index_page_splits`, mức lấp đầy (`avg_fill`/`avg_leaf_density`), `wal_fpi`.
- [ ] Kiểm thử tải vượt RAM, không chỉ dữ liệu nhỏ.
- [ ] Kế hoạch bảo trì: partition/detach, rebuild khi cần, theo dõi tăng trưởng index.
- [ ] Không dựa vào change buffer cho PK/unique index; kiểm tra bản engine còn hỗ trợ.

---

## 🔗 Chuỗi tri thức liên quan

**Cặp bài này**
- [[Database-Patterns/Chon-Kieu-ID-He-Thong-Hien-Dai|Chọn kiểu ID cho hệ thống hiện đại]] — chọn ID nào (hệ quả thực hành của bài này)

**Index, WAL, MVCC**
- [[Database-Patterns/PostgreSQL/04-Index-Internals|PostgreSQL 04 — Index Internals]]
- [[concepts/postgresql-index-internals|PostgreSQL Index Internals (concept)]]
- [[Database-Patterns/PostgreSQL/01-ACID-Internals|PostgreSQL 01 — ACID Internals]] — WAL, fsync, full-page writes
- [[Database-Patterns/PostgreSQL/02-MVCC-Concurrency|PostgreSQL 02 — MVCC]]
- [[Database-Patterns/PostgreSQL/08-MVCC-MySQL-PostgreSQL-Oracle|08 — MVCC: MySQL vs PostgreSQL vs Oracle]]
- [[Database-Patterns/PostgreSQL/05-Performance-Tuning|PostgreSQL 05 — Performance Tuning]]
- [[Notion Knowledge/Note/Database Indexing Demystified- Index Types and Use-Cases|Database Indexing Demystified]]

**Bộ nhớ & lưu trữ**
- [[concepts/memory-hierarchy-cpu-cache|Memory Hierarchy & CPU Cache]] — vì sao locality quyết định tốc độ
- [[concepts/data-storage-model-java-go-rust|Data Storage Model Java/Go/Rust]]
- [[Performance-System-Programming/01-Database-Internals/04-SSTable-Format|SSTable Format]] — đối chiếu LSM-Tree

**ORM, scale, pipeline**
- [[Database-Patterns/Hibernate-Performance-Deep-Dive|Hibernate Performance Deep Dive]]
- [[Database-Patterns/PostgreSQL/10-Sharding-When-Why-Pitfalls|Sharding: When, Why, Pitfalls]]
- [[Database-Patterns/DBMigration/DBMigration-06-Flyway-TechLead-Governance|Flyway Tech Lead Governance]]

**Hub**
- [[Database-Patterns/00-Hub-Database-Persistence|Hub Database Persistence]] · [[_moc/MOC-Database|MOC Database]] · [[_moc/MOC-Database-Internals|MOC Database Internals]] · [[_moc/MOC-PDMS|MOC PDMS]]

---

*Tags: #database #b-tree #clustered-index #innodb #buffer-pool #page-split #change-buffer #fragmentation*
