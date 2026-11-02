---
type: deep-dive
domain: database
status: active
created: 2026-11-02
updated: 2026-11-02
tags: [database, id-generation, uuid, uuidv7, ulid, snowflake, auto-increment, innodb, b-tree, postgresql, mysql, pdms]
aliases: [Chọn kiểu ID, ID Strategy, Primary Key Strategy, UUIDv7 vs Snowflake vs Auto-increment]
---

# Chọn kiểu ID cho hệ thống hiện đại (Database)

> **Mục tiêu:** Trả lời một câu hỏi tưởng nhỏ nhưng quyết định hình dạng của cả schema: *"Primary key nên sinh ra như thế nào?"* — bằng cơ chế bên trong B-Tree/InnoDB chứ không bằng "best practice" truyền miệng.

> [!summary] TL;DR
> 1. **Auto-increment** rất tốt về locality nhưng có **4 giới hạn cấu trúc** (single generator, đoán được, ID chỉ có sau INSERT, không merge được giữa các DB).
> 2. **UUIDv4 làm hỏng InnoDB** vì InnoDB là *clustered index*: PK ngẫu nhiên = insert rải khắp cây B+Tree → page split, fill-factor thấp, buffer pool thrashing, và PK phình to trong *mọi* secondary index.
> 3. **Snowflake** giải quyết locality nhưng đổi lại một **nghĩa vụ vận hành**: mỗi generator đang sống phải có `workerID` duy nhất + đồng hồ không lùi. Tính duy nhất của nó là *có điều kiện*.
> 4. **ULID / UUIDv7 lưu `BINARY(16)`** (hoặc `uuid` native trên PostgreSQL) cho bạn cả ba: sinh phía application không cần phối hợp, sắp xếp theo thời gian (insert ≈ append), chỉ 16 byte. Đó là lý do chúng là **mặc định cho hệ mới**.

---

## 0. ID thật sự đóng mấy vai trò?

Một cột `id` gánh đồng thời nhiều vai trò, và mỗi kiểu ID thắng/thua ở vai trò khác nhau:

| Vai trò | Câu hỏi | Kiểu ID ảnh hưởng thế nào |
|---|---|---|
| **Identity** | Hai row có cùng ID không? | Cần unique toàn cục hay chỉ trong 1 DB? |
| **Clustering key** (InnoDB) | Row nằm vật lý ở đâu? | ID *quyết định* thứ tự lưu row trên đĩa |
| **Row pointer** | Secondary index trỏ về row bằng gì? | InnoDB copy nguyên PK vào mọi secondary index entry |
| **Foreign key / join key** | Bao nhiêu byte mỗi lần join/FK? | Kích thước ID nhân lên khắp schema |
| **Public identifier** | Có lộ ra URL/API không? | Đoán được → enumeration, lộ volume |
| **Idempotency / correlation key** | Biết ID *trước* khi persist được không? | Outbox, retry, event sourcing cần ID sinh sớm |

> Nền tảng B-Tree: [[Database-Patterns/PostgreSQL/04-Index-Internals|PostgreSQL Index Internals]] · [[Notion Knowledge/Note/Database Indexing Demystified- Index Types and Use-Cases|Clustered vs Non-clustered index]] · [[Notion Knowledge/Note/Database Index Internals- Understanding the Data Structures|Index data structures]]

---

## 1. Auto-increment — mạnh ở đâu, gãy ở đâu

`AUTO_INCREMENT` (MySQL), `BIGSERIAL` / `GENERATED ... AS IDENTITY` (PostgreSQL), `IDENTITY` (SQL Server).

### 1.1 Điểm mạnh thật (đừng bỏ qua)

- **8 byte** (BIGINT) — nhỏ nhất trong các lựa chọn không-collision.
- **Append-only**: mọi insert rơi vào lá phải nhất của B+Tree → locality hoàn hảo.
- Dễ đọc, dễ debug, `ORDER BY id` ≈ `ORDER BY created_at`.

Với một bảng *nội bộ*, không lộ ra ngoài, nằm trên **một** database — auto-increment vẫn là lựa chọn hoàn toàn hợp lý.

### 1.2 Bốn giới hạn cấu trúc

```
        ┌──────────────────────────────────────────────────────────────┐
        │              4 GIỚI HẠN CỦA AUTO-INCREMENT                   │
        ├──────────────┬───────────────┬──────────────┬───────────────┤
        │ ① SINGLE     │ ② ĐOÁN ĐƯỢC   │ ③ ID CHỈ CÓ  │ ④ KHÔNG MERGE │
        │ GENERATOR    │ (predictable) │ SAU INSERT   │ ĐƯỢC          │
        ├──────────────┼───────────────┼──────────────┼───────────────┤
        │ 1 counter    │ id=1001,1002  │ DB cấp ID →  │ ID chỉ unique │
        │ ở primary →  │ → enumerate,  │ app không    │ trong 1 DB →  │
        │ không scale  │ lộ volume,    │ biết ID khi  │ gộp / shard / │
        │ ngang        │ IDOR          │ chưa persist │ migrate = đụng│
        └──────────────┴───────────────┴──────────────┴───────────────┘
```

**① Single generator — không scale ngang.**
Bộ đếm sống ở *một* node ghi. Multi-primary hoặc sharding ⇒ mỗi shard cấp `1,2,3…` ⇒ **trùng ID**. Cách chữa kiểu `auto_increment_increment/offset` (mỗi node một bước nhảy) gãy ngay khi thêm node. Đây chính là lý do ID generation là bài toán đầu tiên khi sharding — xem [[Database-Patterns/PostgreSQL/10-Sharding-When-Why-Pitfalls|Sharding: When, Why, Pitfalls]].

**② Đoán được — lộ thông tin và dễ enumerate.**
`/documents/1001` → thử `1002`. Nếu authorization lỏng thì là IDOR; ngay cả khi authz đúng, ID tăng dần vẫn **lộ tốc độ tăng trưởng** (đếm ID hôm nay trừ hôm qua = số đơn/ngày). Phòng thủ đúng là authz chặt ([[Microservices-Patterns/PDMS-AuthZ-Fine-Grained-Design|PDMS AuthZ Fine-Grained]]), nhưng ID không đoán được là lớp phòng thủ thứ hai miễn phí.

**③ ID chỉ tồn tại sau INSERT — coupling với DB.**
- Không biết ID trước khi persist ⇒ khó tạo aggregate + child + event trong cùng một bước, khó gắn idempotency key / correlation id, không sinh ID ở client/edge được.
- Với JPA: `GenerationType.IDENTITY` **vô hiệu hóa JDBC batch insert** vì Hibernate phải INSERT ngay để lấy ID. Dùng `SEQUENCE` + `allocationSize` (pooled optimizer) cứu được một phần — xem [[Database-Patterns/Hibernate-Performance-Deep-Dive|Hibernate Performance Deep Dive]] (phần ID generation) — nhưng vẫn là phối hợp với DB.
- Pattern Outbox cần event ID biết sớm: [[Microservices-Patterns/Transactional-Outbox|Transactional Outbox]].

**④ Không merge / migrate được.**
ID chỉ có nghĩa *trong một database*. Gộp hai DB (M&A, hợp nhất tenant), chạy data migration từ hệ cũ, replicate đa vùng, hay load song song vào nhiều shard — tất cả đều va chạm key space. Thêm một cạnh: kiểu `INT` 32-bit tràn ở 2.147.483.647 (đổi `INT`→`BIGINT` trên bảng lớn là migration đau — xem [[Database-Patterns/DBMigration/DBMigration-06-Flyway-TechLead-Governance|Flyway Governance]]); và sequence/identity **có gap** (rollback không trả lại số) nên đừng dùng nó làm số chứng từ liên tục.

---

## 2. Vì sao UUIDv4 "giết" InnoDB

UUIDv4 = 122 bit ngẫu nhiên. Unique toàn cục, sinh ở bất cứ đâu, không đoán được — giải được cả bốn giới hạn ở §1. Cái giá nằm ở **vị trí**: random ⇒ không có locality.

### 2.1 Tiền đề: InnoDB là clustered index

Trong InnoDB, **bảng chính là B+Tree của primary key**: lá của cây chứa *nguyên row*. Thứ tự PK = thứ tự vật lý.

```
                     InnoDB table = B+Tree theo PK
                              [ root ]
                         ┌───────┼───────┐
                      [int]    [int]    [int]          ← page 16 KB (mặc định)
                     ┌──┼──┐  ┌──┼──┐  ┌──┼──┐
                    [L1][L2][L3]...    ...[L98][L99]   ← LÁ = NGUYÊN ROW
```

### 2.2 Append vs scatter

```
 PK tăng dần (auto-inc / UUIDv7 / ULID)         PK ngẫu nhiên (UUIDv4)

 ... [L97] [L98] [L99]  ← insert chỉ ở đây       [L1] [L2] [L3] ... [L98] [L99]
                  ▲                                ▲    ▲         ▲     ▲
              "hot tail"                       insert có thể rơi vào BẤT KỲ lá nào
 buffer pool chỉ cần giữ vài page cuối          buffer pool phải giữ TOÀN BỘ cây
 page fill ≈ 15/16                              page fill  ≈ 1/2 … 15/16
```

Hệ quả cụ thể:

1. **Page split liên tục & fill-factor thấp.** Theo tài liệu MySQL, insert tuần tự cho page đầy khoảng 15/16, còn insert ngẫu nhiên chỉ từ 1/2 đến 15/16. Page half-empty = **space amplification** và nhiều page hơn phải đọc cho cùng một lượng dữ liệu.
2. **Vách đá buffer pool (the cliff).** Khi index còn vừa RAM, UUIDv4 trông ổn. Khi index vượt buffer pool, *mỗi insert phải đọc một page ngẫu nhiên từ đĩa trước khi ghi* ⇒ throughput rơi thẳng đứng. Với PK tuần tự, working set luôn chỉ là vài page cuối nên không có vách đá này.
3. **Write amplification.** Dirty page nằm rải rác ⇒ flush ngẫu nhiên, nhiều page bị bẩn hơn mỗi checkpoint, redo/doublewrite nặng hơn.
4. **Range scan theo thời gian mất nghĩa.** Không còn "N row mới nhất nằm cạnh nhau".

### 2.3 PK được copy vào *mọi* secondary index

InnoDB secondary index lưu `(cột index, PK)` — PK là con trỏ về row. Vậy kích thước PK **nhân với số index**:

| Kiểu PK | Byte/PK | 100M row × 4 secondary index (thô, chưa tính overhead) |
|---|---|---|
| `BIGINT` | 8 | ≈ 3,2 GB |
| `BINARY(16)` | 16 | ≈ 6,4 GB |
| `CHAR(36)` | 36 | ≈ 14,4 GB |

Nên: dù chọn UUID, **tuyệt đối không lưu `CHAR(36)`** (text hex có dấu gạch). `BINARY(16)` nhỏ hơn 2,25 lần và so sánh bằng `memcmp` nhanh hơn so sánh chuỗi theo collation.

### 2.4 PostgreSQL có "bị" không?

PostgreSQL **không clustered**: row nằm ở heap (append), B-Tree chỉ là index trỏ vào `ctid`. Nên cú sốc nhẹ hơn InnoDB — nhưng **B-Tree index trên cột UUIDv4 vẫn bị insert ngẫu nhiên**: page split, index bloat, cache locality xấu, và sau mỗi checkpoint lần chạm đầu tiên vào một page sẽ ghi *full page image* vào WAL (`full_page_writes`) ⇒ WAL phình vì các page ngẫu nhiên đều bị chạm. Xem [[Database-Patterns/PostgreSQL/01-ACID-Internals|ACID Internals (WAL, fsync)]] và [[concepts/postgresql-index-internals|PostgreSQL Index Internals]]. PostgreSQL có kiểu `uuid` native 16 byte nên không mắc lỗi `CHAR(36)` — nhưng vẫn mất locality.

> [!warning] Đừng kết luận quá tay
> UUIDv4 *không* "chết" ở bảng nhỏ (index vừa RAM) hay ở cột không phải PK/không bị index nặng. Vấn đề là **bảng lớn, ghi nhiều, index vượt bộ nhớ**. Và nếu ID cần *không đoán được tuyệt đối* (token, public handle) thì v4 vẫn là lựa chọn đúng — chỉ đừng dùng nó làm clustering key (xem §5, pattern *dual ID*).

---

## 3. Snowflake — locality tốt, nhưng có nghĩa vụ `workerID`

### 3.1 Bố cục 64-bit

```
  0 │       41 bit timestamp (ms)        │  10 bit worker  │  12 bit sequence
 ───┼────────────────────────────────────┼─────────────────┼──────────────────
 ±  │  ms kể từ custom epoch  (~69,7 năm)│ (5 DC + 5 node) │  4096 ID / ms / worker
```

- `2^41 ms ≈ 69,7 năm` từ custom epoch · `2^10 = 1024` worker · `2^12 = 4096` ID/ms/worker.
- Vừa `BIGINT` 8 byte, sort theo thời gian ⇒ locality như auto-increment, nhưng **sinh phía application, không cần DB**.
- Triển khai Java tham khảo (nodeId + sequence) nằm trong [[Database-Patterns/PostgreSQL/10-Sharding-When-Why-Pitfalls|note Sharding]]; nền tảng đồng hồ: [[concepts/distributed-clocks-ordering|Distributed Clocks & Ordering]].

### 3.2 "Nghĩa vụ workerID" — tính duy nhất là **có điều kiện**

Snowflake không *bảo đảm* unique; nó *chuyển* bài toán unique từ "chọn ID" sang "**chọn workerID cho mỗi generator đang sống** và **đồng hồ không đi lùi**". Cụ thể bạn nợ 5 nghĩa vụ:

```
   unique(ID) ⇐ unique(workerID trong tập generator đang sống)
              ∧ đồng hồ đơn điệu tăng
              ∧ sequence không tràn trong 1 ms
              ∧ epoch + bit layout bất biến
```

| # | Nghĩa vụ | Vi phạm thì sao |
|---|---|---|
| 1 | **Cấp phát workerID duy nhất** cho mọi instance *đang chạy* | Hai node cùng workerID ⇒ ID trùng âm thầm khi cùng ms + cùng sequence |
| 2 | **Đồng hồ đơn điệu**: phát hiện `now < lastTimestamp` (NTP step, leap second, VM migration) rồi chờ / từ chối | Đồng hồ lùi ⇒ sinh lại ID đã cấp |
| 3 | **Vòng đời workerID**: khi pod chết và workerID được tái dùng, instance mới phải bắt đầu *sau* timestamp cuối của chủ cũ | Tái dùng nóng ⇒ trùng với ID chủ cũ vừa sinh |
| 4 | **Giữ layout & epoch cố định mãi mãi** (config-as-code, có version) | Đổi layout ⇒ vỡ thứ tự và có thể trùng ID cũ |
| 5 | **Trần dung lượng**: ≤ 1024 generator sống; > 4096 ID/ms/worker thì spin sang ms sau | Vượt trần ⇒ phải chờ hoặc đổi layout |

**Vì sao nghĩa vụ #1 khó trên Kubernetes?** Pod là ephemeral, autoscale lên xuống, restart có IP/hostname mới. Cách chọn:

| Cách cấp workerID | Ưu | Nhược |
|---|---|---|
| Hash từ IP/hostname | Không cần hạ tầng | **Birthday paradox**: 10 bit chỉ có 1024 ô — 30 node ⇒ xác suất trùng ≈ 35 %, 50 node ⇒ ≈ 70 % |
| StatefulSet ordinal (`pod-0..N`) | Ổn định, đơn giản | Gắn chặt với StatefulSet; không hợp Deployment autoscale |
| **Lease** trong etcd / Redis / ZooKeeper / bảng DB (TTL + gia hạn + fencing) | Đúng nhất về mặt lý thuyết | Thêm một **dependency có trạng thái** vào service vốn stateless; lease etcd/ZK dựa trên [[concepts/consensus-raft-paxos\|consensus]] |
| Random workerID mỗi lần khởi động | Đơn giản | Lại là birthday paradox, chỉ đẹp khi số bit worker lớn |

Xác suất trùng tính theo xấp xỉ `1 − e^(−n(n−1)/2N)` với `N = 1024`.

**Code tối thiểu — đúng chỗ phải kiểm tra đồng hồ:**

```java
public synchronized long nextId() {
    long now = System.currentTimeMillis();
    if (now < lastTs) {                       // nghĩa vụ #2: đồng hồ lùi
        long skew = lastTs - now;
        if (skew > MAX_TOLERATED_SKEW_MS) throw new ClockMovedBackwardsException(skew);
        now = waitUntil(lastTs);              // lùi nhỏ: chờ
    }
    if (now == lastTs) {
        seq = (seq + 1) & 0xFFF;              // 12 bit
        if (seq == 0) now = waitNextMillis(lastTs);   // tràn 4096/ms → spin sang ms sau
    } else {
        seq = 0;
    }
    lastTs = now;
    return ((now - EPOCH) << 22) | ((long) workerId << 12) | seq;   // 41 | 10 | 12
}
```

**Hai bẫy phụ của Snowflake:**
- `long` 64-bit **vượt 2^53** ⇒ JavaScript làm tròn mất chữ số; ID Snowflake phải trả ra API dưới dạng **string**.
- Vì ID chứa timestamp, đừng dùng *prefix ID* làm shard key theo thời gian (tạo hotspot) — shard theo hash. Xem [[Database-Patterns/PostgreSQL/10-Sharding-When-Why-Pitfalls|Sharding]].

---

## 4. ULID / UUIDv7 + `BINARY(16)` — mặc định cho hệ mới

### 4.1 Bố cục 128-bit

```
 UUIDv7 (RFC 9562)
 ┌──────────────────────┬─────┬──────────────┬────┬───────────────────────────┐
 │ 48 bit unix_ts_ms    │ ver │ 12 bit rand_a│ var│       62 bit rand_b       │
 │ (big-endian, ĐỨNG ĐẦU)│ 0111│ (hoặc counter)│ 10 │                           │
 └──────────────────────┴─────┴──────────────┴────┴───────────────────────────┘
   ~74 bit ngẫu nhiên / ms (có thể dùng rand_a làm counter đơn điệu)

 ULID
 ┌──────────────────────┬────────────────────────────────────────┐
 │ 48 bit timestamp ms  │            80 bit randomness           │   → text: 26 ký tự Crockford Base32
 └──────────────────────┴────────────────────────────────────────┘
```

**Điểm mấu chốt của cả hai: timestamp nằm ở byte cao nhất, big-endian.** So sánh byte-by-byte (`memcmp`, đúng cách B-Tree so sánh `BINARY`) ⇒ **thứ tự byte = thứ tự thời gian** ⇒ insert ≈ append ⇒ giải quyết §2. UUIDv4 thì 122 bit ngẫu nhiên từ byte đầu.

### 4.2 Vì sao lưu `BINARY(16)` (không phải `CHAR(36)`)

- **16 byte** thay vì 36 (xem bảng §2.3) — nhỏ hơn 2,25 lần ở PK, ở *mọi* secondary index và ở mọi FK.
- So sánh `memcmp` 16 byte — nhanh, không qua collation.
- Giữ nguyên thứ tự byte ⇒ giữ nguyên locality của v7/ULID.
- PostgreSQL **không cần `BINARY(16)`**: kiểu `uuid` native đã là 16 byte nhị phân. Khái niệm `BINARY(16)` áp dụng cho MySQL/MariaDB.

```sql
-- MySQL / MariaDB (InnoDB)
CREATE TABLE document (
    id          BINARY(16)  NOT NULL,          -- UUIDv7 hoặc ULID dạng 16 byte
    code        VARCHAR(50) NOT NULL,          -- business key, tách riêng khỏi PK
    created_at  DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_document_code (code)
) ENGINE = InnoDB;

-- Hiển thị cho người đọc
SELECT BIN_TO_UUID(id) AS id_text FROM document;
```

> [!warning] Bẫy `swap_flag` của MySQL
> `UUID_TO_BIN(str, 1)` / `BIN_TO_UUID(bin, 1)` hoán đổi các trường thời gian để làm UUID **v1** có thứ tự. Với **v7/ULID thì giữ `swap_flag = 0`** (mặc định) — bật swap sẽ *xáo* phần timestamp và phá thứ tự.

```sql
-- PostgreSQL 18+: native
CREATE TABLE document (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    created_at timestamptz NOT NULL DEFAULT now()
);
-- Trích timestamp từ ID nếu cần:  SELECT uuid_extract_timestamp(id) ...
```

PostgreSQL 18 (phát hành 25/09/2025) mang `uuidv7()` vào core, kèm `uuid_extract_timestamp()`, và thêm alias `uuidv4()` cho `gen_random_uuid()`. Bản triển khai của PostgreSQL dành thêm 12 bit sau timestamp làm phần mili-giây mịn để các ID sinh trong cùng session luôn đơn điệu tăng.

### 4.3 Sinh ID ở phía application

| Stack | Cách sinh |
|---|---|
| **Hibernate 7** | `@Id @UuidGenerator(style = UuidGenerator.Style.VERSION_7) UUID id;` — `Style.VERSION_7` có trong javadoc Hibernate 7.0; một số nguồn nói đã có từ 6.5 ⇒ đối chiếu theo phiên bản đang dùng |
| **Java** (thư viện) | `UuidCreator.getTimeOrderedEpoch()` (uuid-creator) hoặc `Generators.timeBasedEpochGenerator()` (java-uuid-generator). `java.util.UUID` của JDK chỉ có `randomUUID()` (v4) |
| **Rust** | crate `uuid` bật feature `v7`: `Uuid::now_v7()` · crate `ulid`: `Ulid::new()` |
| **Go** | `google/uuid` ≥ v1.6: `uuid.NewV7()` |

Vì ID biết trước khi INSERT, các giới hạn ③ của §1 biến mất: **JDBC batch insert chạy lại bình thường**, ID có sẵn cho outbox/idempotency, sinh được ở edge/client.

Map `UUID` ↔ `BINARY(16)`: Hibernate 6+/7 map `java.util.UUID` sang `BINARY(16)` trên MySQL/MariaDB theo mặc định (đối chiếu dialect đang dùng và `hibernate.type.preferred_uuid_jdbc_type`); trên PostgreSQL map sang `uuid` native.

### 4.4 ULID hay UUIDv7?

Cả hai đều 128 bit, 48 bit timestamp ms ở đầu, sort theo thời gian. Khác biệt thực tế:

| | UUIDv7 | ULID |
|---|---|---|
| Chuẩn | **RFC 9562** | Spec cộng đồng (không phải RFC) |
| Native DB type | `uuid` (PostgreSQL), driver/ORM hiểu sẵn | Không — lưu `BINARY(16)` hoặc chuỗi |
| Text form | 36 ký tự hex + gạch | **26 ký tự** Crockford Base32, URL-friendly |
| Đơn điệu trong cùng ms | RFC cho phép dùng `rand_a` làm counter | "Monotonic mode": tăng phần random |
| Mặc định nên chọn | ✅ Khi có thể (chuẩn + hệ sinh thái) | Khi cần chuỗi ngắn đẹp ở API/URL |

Lưu trữ cả hai đều là 16 byte; ULID chuyển từ Crockford Base32 về 16 byte nhị phân trước khi ghi.

### 4.5 Cái giá phải nói thật

1. **Lộ thời điểm tạo.** Timestamp nằm trong ID. Nếu thời điểm tạo là thông tin nhạy cảm với bên ngoài ⇒ dùng *dual ID* (xem §5).
2. **Chỉ "k-sortable" qua nhiều node.** Timestamp lấy từ đồng hồ từng máy; skew vài giây ⇒ có *vài hot tail* (mỗi node một đuôi), vẫn tốt hơn hẳn random, nhưng **không dùng ID để suy ra thứ tự nhân quả** — đó là việc của logical clock ([[concepts/distributed-clocks-ordering|Distributed Clocks]]).
3. **Gấp đôi BIGINT.** 16 byte so với 8 byte — nhân lên ở secondary index và FK.
4. **Hotspot đuôi phải.** Mọi writer tranh nhau page cuối của một B-Tree; ở tốc độ insert rất cao trên *một* index có thể thấy tranh chấp latch ở lá phải nhất. Khi đó cân nhắc partitioning, chứ đừng quay lại UUIDv4.
5. **Không có "hợp đồng" duy nhất cứng như DB-generated.** Unique dựa vào ~74 bit ngẫu nhiên mỗi ms (collision xác suất ~0) — vẫn nên có `PRIMARY KEY`/unique constraint làm lưới an toàn.

---

## 5. So sánh tổng và cây quyết định

| | Auto-inc | UUIDv4 | Snowflake | **UUIDv7 / ULID** |
|---|---|---|---|---|
| Kích thước | 8 B | 16 B (`BINARY`) | 8 B | 16 B |
| Locality / insert | ✅ append | ❌ random | ✅ append | ✅ append |
| Sinh không cần DB | ❌ | ✅ | ✅ (cần workerID) | ✅ |
| Cần phối hợp / registry | DB counter | Không | **workerID + clock** | Không |
| Đoán được | ❌ rất dễ | ✅ không | ⚠️ khá dễ | ✅ khó (lộ timestamp) |
| Merge / multi-DB / shard | ❌ | ✅ | ✅ nếu workerID duy nhất | ✅ |
| Biết ID trước INSERT | ❌ | ✅ | ✅ | ✅ |
| Rủi ro vận hành | Thấp | Hiệu năng ở scale | **Cao** (workerID, clock) | Thấp |

```
Bảng chỉ nằm trên 1 DB, nội bộ, không lộ ra ngoài?
 ├─ CÓ  → BIGINT identity/sequence (đơn giản nhất, nhỏ nhất)
 └─ KHÔNG (đa service / shard / merge / lộ API / cần ID trước INSERT)
        │
        ├─ Cần ID 64-bit (JS number, giới hạn kích thước) và đã có hạ tầng cấp workerID?
        │      └─ Snowflake — nhận nghĩa vụ workerID + clock
        │
        ├─ Cần token không đoán được tuyệt đối (public handle, secret)?
        │      └─ UUIDv4 làm *public ID*, KHÔNG làm clustering key
        │
        └─ Còn lại (mặc định hệ mới)
               └─ UUIDv7 (hoặc ULID) lưu BINARY(16) / uuid native
```

**Pattern *dual ID*** khi cần cả hai thế giới: PK nội bộ tuần tự (BIGINT hoặc UUIDv7) làm clustering key + FK; thêm cột `public_id` (UUIDv4 hoặc opaque) có `UNIQUE` index để lộ ra API. Đổi lại: thêm một index và một lần lookup.

> Khi chốt quyết định cho một service mới, ghi lại bằng ADR: [[concepts/adr-framework|ADR Framework]].

---

## 6. Áp dụng vào PDMS / VPBank

- Các thiết kế trong vault đang dùng `gen_random_uuid()` (**v4**) làm PK trên PostgreSQL, ví dụ các bảng IAM/AuthZ ở [[Microservices-Patterns/AuthZ-Platform-Dynamic-5-Layer-Design|AuthZ Platform 5-Layer]] và `outbox_events` ở [[Microservices-Patterns/Transactional-Outbox|Transactional Outbox]].
- **Bảng append-nặng, volume cao** (decision log, audit, outbox, event) là nơi v4 trả giá lớn nhất (index bloat, WAL do full-page image). Đó là ứng viên đầu tiên chuyển sang **UUIDv7**. Bảng danh mục nhỏ (tenant, role, permission) thì v4 vô hại — không cần đụng.
- Giữ **business key** (`document_code`, `case_id`) tách khỏi PK như đã làm ở bảng `document` trong [[Database-Patterns/DBMigration/DBMigration-06-Flyway-TechLead-Governance|Flyway Governance]]; ID kỹ thuật và mã nghiệp vụ là hai thứ.
- Khi stack lên **Spring Boot 4 / Hibernate 7**, `@UuidGenerator(style = VERSION_7)` là cấu hình một dòng; trên PostgreSQL 18 thêm `DEFAULT uuidv7()` ở schema làm lưới an toàn cho insert ngoài ORM (batch/ETL).
- Đổi PK của bảng *đã có dữ liệu*: đừng đổi kiểu cột in-place. UUIDv7 và UUIDv4 cùng kiểu `uuid` nên **không cần migration schema** — chỉ đổi cách sinh ID *từ giờ trở đi*; dữ liệu cũ giữ nguyên, B-Tree chỉ có phần cũ rải rác còn phần mới nằm ở đuôi. Chiến lược migration lớn xem [[Database-Patterns/DBMigration/DBMigration-06-Flyway-TechLead-Governance|Flyway Governance]].
- Với bulk load/ETL nhiều triệu row: ID sinh sớm và có thứ tự ⇒ `COPY`/batch insert ghi gần như tuần tự; ID ngẫu nhiên thì không. (Liên quan hướng ETL ở [[Performance-System-Programming/03-Data-Format-Parsing/02-Read-Write-Separation-Type-Conversion|Read/Write Separation & Type Conversion]].)

---

## 7. Checklist chọn & triển khai

- [ ] Bảng có lộ ra ngoài / đa service / có thể shard hoặc merge? → loại auto-increment trần.
- [ ] Engine là InnoDB? → PK tuần tự theo thời gian, **không UUIDv4**, **không `CHAR(36)`**.
- [ ] Lưu `BINARY(16)` (MySQL) hoặc `uuid` (PostgreSQL); không lưu chuỗi.
- [ ] MySQL: `swap_flag = 0` cho v7/ULID.
- [ ] Nếu Snowflake: có cơ chế cấp workerID (lease), phát hiện clock rollback, epoch+layout là hằng có version, ID ra API dạng string.
- [ ] Business key tách riêng khỏi PK kỹ thuật.
- [ ] Cần public ID không đoán được/không lộ thời gian? → dual ID.
- [ ] Có `PRIMARY KEY`/`UNIQUE` làm lưới an toàn dù ID "gần như chắc chắn" unique.
- [ ] Đo bằng dữ liệu của bạn: insert throughput và kích thước index khi index vượt buffer pool (đó mới là chỗ khác biệt lộ ra).

---

## 8. Đính chính tri thức trong vault

> [!success] Đã sửa ngày 2026-11-02 trong các note gốc
> - [[Database-Patterns/PostgreSQL/10-Sharding-When-Why-Pitfalls|10-Sharding-When-Why-Pitfalls]] — "PostgreSQL 17+: UUID v7 built-in" → đúng là **PostgreSQL 18** (`uuidv7()`); đồng thời bổ sung cảnh báo workerID/clock rollback vào đoạn Snowflake.
> - [[concepts/distributed-clocks-ordering|distributed-clocks-ordering]] (Tip 1) — bỏ `uuid_generate_v7()` (không tồn tại trong `uuid-ossp`), thay bằng `uuidv7()` (PG 18+) kèm cảnh báo UUIDv7 chỉ là *k-sortable*, không thay logical clock.
> - [[Database-Patterns/Hibernate-Performance-Deep-Dive|Hibernate-Performance-Deep-Dive]] (mục `@Id` và Strategy) — `Style.TIME` → `Style.VERSION_7`; bỏ `uuid_generate_v7()`.
>
> Cơ chế nền của toàn bộ chủ đề: [[Database-Patterns/B-Tree-Clustered-Index-Random-Write-Cost|B-tree, clustered index và cái giá của ghi random]].

---

## 🔗 Chuỗi tri thức liên quan

**Nền tảng index & lưu trữ**
- [[Database-Patterns/PostgreSQL/04-Index-Internals|PostgreSQL 04 — Index Internals]] — B-Tree, page split
- [[concepts/postgresql-index-internals|PostgreSQL Index Internals (concept)]]
- [[Database-Patterns/PostgreSQL/01-ACID-Internals|PostgreSQL 01 — ACID Internals]] — WAL, full-page writes
- [[Database-Patterns/PostgreSQL/08-MVCC-MySQL-PostgreSQL-Oracle|08 — MVCC: MySQL vs PostgreSQL vs Oracle]] — so sánh cách lưu row giữa các engine
- [[concepts/memory-hierarchy-cpu-cache|Memory Hierarchy & CPU Cache]] — vì sao locality quyết định hiệu năng
- [[concepts/data-storage-model-java-go-rust|Data Storage Model Java/Go/Rust]] — bit-level layout
- [[Performance-System-Programming/01-Database-Internals/04-SSTable-Format|SSTable Format]] — góc nhìn LSM-Tree, nơi key ngẫu nhiên không bị phạt giống B+Tree

**Phân tán & thời gian**
- [[concepts/distributed-clocks-ordering|Distributed Clocks & Ordering]] — NTP, clock skew, logical clock
- [[concepts/consensus-raft-paxos|Consensus: Raft & Paxos]] — nền của lease cho workerID
- [[Database-Patterns/PostgreSQL/10-Sharding-When-Why-Pitfalls|Sharding: When, Why, Pitfalls]]

**ORM, migration, pattern**
- [[Database-Patterns/Hibernate-Performance-Deep-Dive|Hibernate Performance Deep Dive]] — IDENTITY vs SEQUENCE, batch insert
- [[Database-Patterns/DBMigration/DBMigration-06-Flyway-TechLead-Governance|Flyway Tech Lead Governance]]
- [[Microservices-Patterns/Transactional-Outbox|Transactional Outbox]] — event ID sinh sớm
- [[Notion Knowledge/Note/Mastering Idempotency- Building Reliable APIs|Mastering Idempotency]] — idempotency key

**Bối cảnh PDMS & quyết định**
- [[_moc/MOC-PDMS|MOC PDMS]]
- [[Microservices-Patterns/PDMS-AuthZ-Fine-Grained-Design|PDMS AuthZ Fine-Grained Design]]
- [[concepts/adr-framework|ADR Framework]]

**Hub**
- [[Database-Patterns/00-Hub-Database-Persistence|Hub Database Persistence]] · [[_moc/MOC-Database|MOC Database]] · [[_moc/MOC-Database-Internals|MOC Database Internals]]

---

*Tags: #database #id-generation #uuid #uuidv7 #ulid #snowflake #innodb #b-tree*


## Cơ chế nền (bổ sung 2026-11-02)

- [[Database-Patterns/B-Tree-Clustered-Index-Random-Write-Cost|B-tree, clustered index và cái giá của ghi random]] — page, buffer pool, page split, change buffer, phân mảnh: vì sao thứ tự khóa quyết định chi phí ghi (cơ sở của §2 trong bài này).


---

## 🛠 Usage — công thức dùng ngay

### U1. Dịch vụ mới trên MySQL/InnoDB: UUIDv7 + `BINARY(16)` + batch insert

```java
// Entity (Hibernate 7.x; với 6.x đối chiếu javadoc phiên bản đang dùng — xem R9)
@Entity
public class Document {
    @Id
    @UuidGenerator(style = UuidGenerator.Style.VERSION_7)   // time-ordered, RFC 9562
    private UUID id;                                         // MySQL dialect thường map sang BINARY(16)

    @Column(nullable = false, unique = true, length = 50)
    private String code;                                     // business key tách khỏi PK
}
```

```java
// Khi tự thao tác byte (JdbcTemplate, ETL): big-endian → timestamp đứng đầu → thứ tự byte = thứ tự thời gian
static byte[] toBytes(UUID u) {
    return ByteBuffer.allocate(16).putLong(u.getMostSignificantBits())
                                  .putLong(u.getLeastSignificantBits()).array();
}
static UUID fromBytes(byte[] b) {
    ByteBuffer bb = ByteBuffer.wrap(b);
    return new UUID(bb.getLong(), bb.getLong());
}
// Sinh v7 ngoài Hibernate:  UuidCreator.getTimeOrderedEpoch()  (uuid-creator)
```

```yaml
# Vì ID biết trước INSERT nên batch hoạt động — nhớ bật ở cả ORM lẫn driver
spring.jpa.properties.hibernate.jdbc.batch_size: 100
spring.jpa.properties.hibernate.order_inserts: true
spring.jpa.properties.hibernate.order_updates: true
# MySQL Connector/J: thêm rewriteBatchedStatements=true vào JDBC URL
# PostgreSQL JDBC:    thêm reWriteBatchedInserts=true
```

### U2. PostgreSQL 18+: mặc định ở schema + trích timestamp

```sql
CREATE TABLE document (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),     -- lưới an toàn cho INSERT ngoài ORM (ETL, script)
    code       text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

SELECT uuid_extract_timestamp(id) AS id_ts, created_at FROM document LIMIT 5;  -- đối chiếu lệch giờ
```

### U3. Dual ID — PK nội bộ có locality, public ID không lộ thời gian

```sql
CREATE TABLE case_file (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),           -- clustering/FK nội bộ
    public_id  uuid NOT NULL DEFAULT gen_random_uuid(),     -- v4, đưa ra API/URL
    CONSTRAINT uk_case_file_public UNIQUE (public_id)
);
-- API: GET /cases/{public_id}  → tra public_id → id nội bộ cho mọi join/FK
```

### U4. Snowflake: cấp `workerID` bằng lease trong DB (nghĩa vụ #1 và #3 của §3.2)

```sql
CREATE TABLE worker_lease (
    worker_id   smallint    PRIMARY KEY CHECK (worker_id BETWEEN 0 AND 1023),
    owner       text,
    lease_until timestamptz NOT NULL DEFAULT '-infinity',
    last_ts_ms  bigint      NOT NULL DEFAULT 0          -- timestamp ID cuối cùng chủ cũ đã phát
);

-- Acquire: lấy một worker_id đã hết hạn, KHÔNG tranh với instance khác
UPDATE worker_lease SET owner = :me, lease_until = now() + interval '30 seconds'
WHERE worker_id = (SELECT worker_id FROM worker_lease
                   WHERE lease_until < now() ORDER BY worker_id LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING worker_id, last_ts_ms;
```

Quy tắc đi kèm: (a) gia hạn lease định kỳ (≈ ⅓ TTL) và **ngừng phát ID ngay khi mất lease**; (b) chủ mới phải chờ cho tới khi `now_ms > last_ts_ms` trước khi phát ID; (c) định kỳ ghi `last_ts_ms` khi gia hạn lease.

### U5. Đổi PK `BIGINT` → UUIDv7 trên bảng đã có dữ liệu (expand/contract, không ALTER in-place)

| Bước | Việc làm | Vì sao an toàn |
|---|---|---|
| 1 | Thêm cột `new_id` (nullable), backfill theo lô nhỏ | Không giữ khóa dài, không rewrite bảng |
| 2 | Tạo unique index trên `new_id` bằng `CREATE INDEX CONCURRENTLY` (PostgreSQL) | Không chặn ghi |
| 3 | Thêm cột FK mới ở bảng con, backfill, dual-write | Hai khóa cùng tồn tại trong giai đoạn chuyển |
| 4 | Chuyển đọc sang `new_id`, theo dõi lỗi | Rollback = đọc lại khóa cũ |
| 5 | Đổi PK/FK, bỏ cột cũ trong một lần deploy riêng | Bước phá hủy tách biệt và đảo ngược được tới phút cuối |

Chiến lược migration dài hạn và governance: [[Database-Patterns/DBMigration/DBMigration-06-Flyway-TechLead-Governance|Flyway Governance]].

### U6. Bài kiểm thử "ID có thật sự tăng theo thời gian không?"

```sql
-- Kỳ vọng: chỉ vài ca cùng mili-giây hoặc lệch đồng hồ giữa node
SELECT COUNT(*) AS out_of_order
FROM (SELECT id, LAG(id) OVER (ORDER BY created_at, id) AS prev_id
      FROM document ORDER BY created_at LIMIT 100000) t
WHERE prev_id > id;
```

---

## ⚠️ Mistakes — lỗi thường gặp (cơ chế · cách phát hiện · cách sửa)

| # | Lỗi | Vì sao sai (cơ chế) | Cách phát hiện | Cách sửa |
|---|---|---|---|---|
| 1 | Lưu UUID dạng `CHAR(36)`/`VARCHAR(36)` | PK nhân vào mọi secondary index (InnoDB) ⇒ 36 B thay vì 16 B (≈ ×2,25); so sánh qua collation, không phải `memcmp` | `SHOW CREATE TABLE`; so `mysql.innodb_index_stats` (stat `size`) với dự kiến | Dùng `BINARY(16)` (MySQL) hoặc `uuid` (PostgreSQL) |
| 2 | UUIDv4 làm PK InnoDB cho bảng lớn | Chèn ngẫu nhiên ⇒ split, fill ≈ ½–15/16, vách đá buffer pool (xem bài B-tree §4–§7) | `index_page_splits` tăng nhanh; `Innodb_buffer_pool_reads` / `read_requests` cao khi bảng > RAM | UUIDv7/ULID cho PK; v4 chỉ làm `public_id` |
| 3 | Bật `swap_flag=1` của `UUID_TO_BIN` cho UUIDv7/ULID | `swap_flag` hoán đổi trường thời gian để *sửa* UUIDv1; áp vào v7 sẽ làm xáo timestamp | Chạy U6: `out_of_order` cao bất thường | `swap_flag=0` (mặc định) cho v7/ULID |
| 4 | Dùng `Style.TIME` hoặc `uuid_generate_v7()` cho "ordered UUID" | `TIME` là kiểu v1 (time_low đứng đầu → không sort theo byte); `uuid-ossp` không có v7 | Chạy U6 | `Style.VERSION_7`; `uuidv7()` (PG 18+) hoặc sinh ở application |
| 5 | Snowflake: `workerId = hash(IP)` | Xác suất trùng tăng theo birthday paradox: 30 node/1024 ô ≈ 35 % | Hai instance cùng `workerId` (log khi khởi động) | Lease (U4) hoặc StatefulSet ordinal |
| 6 | Snowflake: không phát hiện đồng hồ lùi | `now < lastTs` ⇒ sinh lại cặp (timestamp, worker, sequence) đã dùng | Metric "clock moved backwards"; unique violation hiếm, khó tái hiện | Chờ/từ chối khi lùi (code §3.2), giám sát NTP offset |
| 7 | Tái dùng `workerId` ngay sau khi pod chết | Chủ mới có thể phát lại timestamp chủ cũ vừa dùng | So `last_ts_ms` với đồng hồ lúc khởi động | Cooldown tới `last_ts_ms` (U4-b) |
| 8 | Trả Snowflake `long` ra JSON số | JavaScript chỉ chính xác tới 2^53 ⇒ làm tròn chữ số cuối | ID ở client khác ID ở server | Serialize dạng **string** |
| 9 | Dùng UUIDv7 làm token/secret | RFC 9562 cảnh báo không coi UUID là capability bảo mật; v7 lộ timestamp, ~74 bit ngẫu nhiên/ms | Review chỗ dùng ID làm "link bí mật" | Token ngẫu nhiên mật mã (≥128 bit từ CSPRNG) tách khỏi ID |
| 10 | Suy luận thứ tự nhân quả từ ID (v7/Snowflake) | Timestamp lấy từ wall clock của từng máy, có skew ⇒ chỉ k-sortable | Test với hai node lệch giờ | Dùng logical clock/version ([[concepts/distributed-clocks-ordering\|Distributed Clocks]]) |
| 11 | Shard theo *prefix* của ID thời gian | Mọi insert mới rơi vào cùng shard ⇒ hotspot | Một shard CPU/IO cao, các shard khác rảnh | Shard theo hash của khóa ([[Database-Patterns/PostgreSQL/10-Sharding-When-Why-Pitfalls\|Sharding]]) |
| 12 | Dùng sequence/identity làm số chứng từ liên tục | Sequence không rollback ⇒ có gap; cache sequence ⇒ gap khi restart | Truy vấn tìm khoảng trống | Bảng đánh số riêng có khóa, hoặc chấp nhận gap |
| 13 | `GenerationType.IDENTITY` rồi bật `batch_size` | Hibernate phải INSERT ngay để lấy ID ⇒ batch bị vô hiệu | Bật SQL log: mỗi row một câu INSERT | `SEQUENCE` + `allocationSize`, hoặc UUID sinh ở app |
| 14 | Bỏ unique constraint vì "ID gần như không trùng" | Bug generator/clock/sao chép dữ liệu vẫn tạo trùng; hỏng âm thầm | Không phát hiện được nếu không có ràng buộc | Luôn `PRIMARY KEY`/`UNIQUE` làm lưới an toàn |
| 15 | `ALTER TABLE ... MODIFY id` đổi kiểu PK trực tiếp trên bảng lớn | Rewrite toàn bảng + dựng lại mọi index, khóa/tốn I/O | Ước lượng thời gian bằng bản sao | Expand/contract (U5) |

---

## 📚 Tài liệu dẫn chứng

### Bảng: khẳng định → nguồn

| Khẳng định trong bài | Nguồn |
|---|---|
| Insert tuần tự ⇒ page ≈ 15/16 đầy; ngẫu nhiên ⇒ ½ … 15/16; `innodb_fill_factor` | R1 |
| Secondary index lưu PK; PK dài làm mọi index to | R2 |
| `swap_flag` của `UUID_TO_BIN` dành cho UUIDv1 | R3 |
| Bố cục UUIDv7 (48 + 4 + 12 + 2 + 62 bit); UUID không phải capability bảo mật | R4 |
| Bố cục ULID (48 + 80 bit, Crockford Base32) | R5 |
| Bố cục Snowflake 41/10/12 | R6 |
| `uuidv7()`, `uuid_extract_timestamp()` có từ PostgreSQL 18; `uuid-ossp` chỉ v1/v3/v4/v5 | R7, R8 |
| `UuidGenerator.Style.VERSION_7` | R9 |
| `IDENTITY` ngăn batch insert | R10 |
| Xác suất trùng workerID (birthday problem) | R11 |
| Đồng hồ vật lý không đủ để suy ra thứ tự nhân quả | R12 |
| Kích thước PK ảnh hưởng chi phí B-Tree, locality của khóa | R13 |

### Danh mục nguồn

- **R1** — MySQL 8.4 Reference Manual, *The Physical Structure of an InnoDB Index*: https://dev.mysql.com/doc/refman/8.4/en/innodb-physical-structure.html
- **R2** — MySQL 8.4 Reference Manual, *Clustered and Secondary Indexes*: https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html
- **R3** — MySQL 8.4 Reference Manual, `UUID_TO_BIN()`: https://dev.mysql.com/doc/refman/8.4/en/miscellaneous-functions.html#function_uuid-to-bin
- **R4** — RFC 9562, *Universally Unique IDentifiers (UUIDs)* (có mục Security Considerations): https://www.rfc-editor.org/rfc/rfc9562
- **R5** — ULID specification: https://github.com/ulid/spec
- **R6** — Twitter Snowflake (kho lưu trữ): https://github.com/twitter-archive/snowflake
- **R7** — PostgreSQL docs, *UUID Functions*: https://www.postgresql.org/docs/current/functions-uuid.html · Release notes 18: https://www.postgresql.org/docs/release/18.0/
- **R8** — PostgreSQL docs, `uuid-ossp`: https://www.postgresql.org/docs/current/uuid-ossp.html
- **R9** — Hibernate ORM 7.0 javadoc, `UuidGenerator.Style`: https://docs.jboss.org/hibernate/orm/7.0/javadocs/org/hibernate/annotations/UuidGenerator.Style.html
- **R10** — Hibernate User Guide (identifier generators): https://docs.hibernate.org/orm/current/userguide/html_single/Hibernate_User_Guide.html
- **R11** — Birthday problem: https://en.wikipedia.org/wiki/Birthday_problem
- **R12** — L. Lamport, *Time, Clocks, and the Ordering of Events in a Distributed System*, CACM 21(7), 1978.
- **R13** — M. Kleppmann, *Designing Data-Intensive Applications*, ch. 3 (Storage and Retrieval) · G. Graefe, *Modern B-Tree Techniques*, Foundations and Trends in Databases, 2011.

> Quy ước của vault cho các article triển khai: mỗi bài có đủ **Usage** (dùng ngay), **Mistakes** (cơ chế · phát hiện · sửa) và **Tài liệu dẫn chứng** (khẳng định → nguồn). Số liệu mô hình hóa luôn ghi rõ là minh họa; số đo thật phải lấy từ hệ thống của bạn.
