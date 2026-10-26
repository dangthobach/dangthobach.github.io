---
type: moc
domain: knowledge-management
status: living-document
created: 2026-10-25
updated: 2026-10-25
tags: [moc, audit, refactor, knowledge-management]
---

# Vault Refactor & Currency Audit — 2026-10

> Tracker cho việc rà soát kiến thức lỗi thời + refactor hệ thống kiến thức. **Ràng buộc cứng: không mất knowledge, mọi chỉnh sửa đúng format Obsidian Vault (mục 8).**
> Liên quan: [[_moc/VAULT-DASHBOARD]] (hiện trạng) · [[_moc/VAULT-AUDIT-2026]] (audit lịch sử)

## 1. Bảy bất biến (không được vi phạm)

1. **Additive-first** — chỉ thêm / link / gắn metadata; không xóa, không ghi đè.
2. **Snapshot trước** — git commit + tag (hoặc zip vault) trước mỗi phase có ghi.
3. **Merge ≠ delete** — mô hình *canonical + absorbed*; note cũ → `status: superseded` + `superseded_by`, giữ nguyên nội dung.
4. **Knowledge ledger** — trước khi absorb phải liệt kê ý chính / code block / diagram / số liệu và ánh xạ hết vào canonical.
5. **Update ≠ rewrite** — giữ bản cũ trong khối `> [!history]` (version cũ → mới + lý do đổi).
6. **Verify mỗi batch** — broken link = 0; backlink không giảm; heading / code block / mermaid không giảm (trừ khi ghi lý do).
7. **Batch nhỏ, đảo ngược được.**

## 2. Baseline P0 (đóng băng ngày 2026-10-25, chưa tính `_archive/`)

| Chỉ số | Giá trị |
|---|---|
| Số note `.md` | ≈ 577 |
| Note mới nhất | 2026-09-02 |
| Mốc cập nhật chủ đạo | 2026-04 → 2026-05 (cũ ~5–6 tháng) |
| Technology-update đã có | Angular 22, Go, Rust (2026-07-24) |
| Note mồ côi (0 inlink) lúc baseline | 45 (38 knowledge + 7 cấu trúc/README) |
| Note mồ côi sau P1.5 | 7 (chỉ còn note cấu trúc/README/entry) |
| Cụm Notion Knowledge | ≈ 109 note, gần như 0 outlink ra phần còn lại |
| Mega-note > 50 KB | 5 (xem 3.4) |

> [!warning] Chưa xác nhận
> Số liệu trên chỉ từ metadata Dataview (ngày, kích thước, link). Chưa đọc nội dung từng note nên các mục "nghi trùng / nghi stub" cần đối chiếu nội dung trước khi hành động.

## 3. Phát hiện từ baseline

### 3.1 Hai series SolidJS song song (nghi trùng — cần đọc xác nhận)

| Bản cũ (skeleton ~3 KB) | Bản mới (sâu 11–28 KB) |
|---|---|
| [[SolidJS-Series/00-Roadmap]] (0 inlink lúc baseline) | [[SolidJS-Series/SolidJS-MOC]] |
| [[SolidJS-Series/01-Reactivity-Internals]] | [[SolidJS-Series/SolidJS-01-Reactivity-Internals]] |
| [[SolidJS-Series/02-Components-and-Props]] | [[SolidJS-Series/SolidJS-04-JSX-Component-Model]] |
| [[SolidJS-Series/03-Control-Flow]] | [[SolidJS-Series/SolidJS-05-Control-Flow-Primitives]] |
| [[SolidJS-Series/04-Store-Management]] | [[SolidJS-Series/SolidJS-06-Stores-Nested-State]] |
| [[SolidJS-Series/05-Async-and-Suspense]] | [[SolidJS-Series/SolidJS-08-Async-Resources]] |
| [[SolidJS-Series/06-Enterprise-Architecture]] | (chưa xác định cặp — cần đọc) |

→ Xử lý theo bất biến 3–4 (ledger trước, superseded sau). **Chưa đổi gì.**

### 3.2 Note mồ côi — đã nối ở P1.5

Danh sách lúc baseline (38 note kiến thức), nay đều đã có inlink từ hub/MOC:

- **Microservices-Patterns (8)** → [[Microservices-Patterns/00-Hub-Microservices-Patterns]]: Apache-Avro-Deep-Dive, API-Design-REST-GraphQL-Webhook, AuthZ-Platform-Dynamic-5-Layer-Design, BPMN-CMMN-DMN-Enterprise-Process-Modeling, CQRS-Rust-vs-SpringBoot, Debezium-Postgres-to-MongoDB-Guide, Notification-Service-High-Throughput-Never-Miss-Design, Realtime-Customer-Alert-Never-Fail-System
- **Rust-Zero-To-Hero (14)** → [[Rust-Zero-To-Hero/Lộ-trình-Tổng-quan]]: Bai-3b, 3c, 3d, 4b, 4c, 8b, 15b, 15c, 23b, 23c, 47, 57, 58, 59
- **Go-Zero-To-Hero (7)** → [[Go-Zero-To-Hero/Lộ-trình-Tổng-quan]]: Bai-33, 37, 39, 41, 42, 43, 44
- **Khác (9):** Project-Reactor-Deep-Dive → [[_moc/MOC-JVM-Frameworks]]; DBMigration-06 → [[Database-Patterns/DBMigration/DBMigration-MOC]]; concepts/hibernate-* (3) → [[Database-Patterns/00-Hub-Database-Persistence]]; SolidJS-15 + 00-Roadmap cũ → [[SolidJS-Series/SolidJS-MOC]]; BPMP Shadow Verification (cùng 2 note BPMP) → [[_moc/MOC-PDMS]]; Performance 03-Data-Format-Parsing (2 note) → [[_moc/MOC-Database-Internals]]

> [!note] Vị trí tạm
> Các link được thêm ở cuối hub trong mục "Bổ sung (P1.5 · 2026-10-25)". Sắp xếp lại theo chủ đề / thứ tự học thuộc P2.

### 3.3 Nợ kiến thức (skeleton / stub — cần làm sâu, không phải dedupe)

- **Angular (8 bài ~2 KB):** 01, 04, 05, 06, 08, 11, 13, 14
- **React (8 bài ~3–4 KB):** 01–05, 09, 14, 15
- **Stub 1–2 KB nghi là con trỏ:** React 24–25, SolidJS-14/15, Database-Patterns/PostgreSQL 04–06 (nghi trỏ sang `concepts/`), concepts/hibernate-* (< 1 KB)
- **Notion (12 note < 3 KB):** Best Practices in API Design, Concurrency is NOT Parallelism, EP176, EP177, JWT vs PASETO, Oauth2, SOAP vs REST…, What is the SOLID Principle, The Payments Ecosystem, How to avoid crawling duplicate URLs, Virtualization vs Containerization, Why is SSD fast

### 3.4 Mega-note (rủi ro chỉnh sửa / audit version)

| Note | Kích thước |
|---|---|
| Database-Patterns/Hibernate-Performance-Deep-Dive | ≈ 272 KB |
| Microservices-Patterns/AuthZ-Platform-Dynamic-5-Layer-Design | ≈ 133 KB |
| Database-Patterns/PostgreSQL/18-Snapshot-Internals-Deep-Dive | ≈ 73 KB |
| Go-Zero-To-Hero/Deep-Dive-VirtualThreads-vs-Goroutines-vs-RustAsync | ≈ 60 KB |
| concepts/rust-java-go-comparison | ≈ 53 KB |

→ Không tách trong phase đầu. Nếu tách: ledger + giữ note gốc làm hub (transclusion), không xóa.

### 3.5 Trùng chủ đề giữa các khu vực (nghi, chưa xác nhận)

Virtual thread/Loom (4 nơi) · Index PostgreSQL (concepts + PostgreSQL/04 + 2 Notion) · Saga/CQRS (Notion + Microservices-Patterns) · Sharding (3 Notion + PostgreSQL/10) · Reactivity React vs Solid (4 note / 3 thư mục).

### 3.6 Lệch quy ước của chính vault

- [[concepts/README]] ghi quy tắc "thêm note mới vào bảng Index + link vào MOC" nhưng bảng Index hiện chỉ liệt kê vài note (5 trong khoảng 48 note concepts). Cần bổ sung additive ở phase sau.
- `concepts/` quy định flat + kebab-case; một số note dùng PascalCase (`React-Compiler-Internals-Memoization`, `Frontend-Project-Architecture-2026`, `Rust-Java-Build-Compile-Deploy-Memory-Timeline`, `SolidJS-vs-React-Reactivity-Model`). **Không đổi tên** (đổi tên chỉ làm trong giao diện Obsidian, P6).

## 4. Mô hình phân tầng (rule-based, không sửa từng note)

Tier được suy ra từ vị trí thư mục (override ngoại lệ ghi ở mục 4.1). Chu kỳ review = nửa đời của tầng.

| Tầng | Chu kỳ | Phạm vi mặc định |
|---|---|---|
| **A** gắn version | 90 ngày | JVM-Frameworks-2026, Angular/React/SolidJS series, Go-Zero-To-Hero, Rust-Zero-To-Hero, Apache-Fory, Liquibase, DBMigration, Hibernate/R2DBC notes, Kafka/RabbitMQ/Debezium/Avro notes |
| **B** pattern + ví dụ theo tool | 180 ngày | Microservices-Patterns (còn lại), Database-Patterns/PostgreSQL, Design-Patterns-Go/Rust, Performance-System-Programming, BPMP-Platform, Go-Microservices-Mastery, PDMS-* |
| **C** evergreen | 365 ngày | concepts/ (trừ note gắn tool/version) |
| **D** reference | khi cần | Notion Knowledge → distill / superseded / giữ |
| Meta | — | _moc, _templates, HOME, gemini-scribe, _inbox |

### 4.1 Ngoại lệ đã biết (sẽ bổ sung khi audit)

- concepts/React-Compiler-Internals-Memoization → A
- concepts/hibernate-* → A
- concepts/oauth2-oidc-deep-dive, kubernetes-architecture, opentelemetry-deep-dive → B

> Khi một note được audit, mới thêm `source_checked`, `tier`, `valid_for` vào chính note đó (bất biến 1: additive, từng note một).

## 5. Dashboard sống

> [!info] Mốc "tươi" của một note
> Dùng `default(source_checked, default(created, updated))`. Không dùng `updated` làm mốc chính vì nó bị nhiễu bởi các chỉnh sửa link/cấu trúc (không phải xác minh nội dung).

### Tầng A quá hạn review (90 ngày)

```dataview
TABLE default(source_checked, default(created, updated)) AS checked, file.size AS bytes
FROM "JVM-Frameworks-2026" OR "Angular-Latest-Series" OR "React-Latest-Series" OR "SolidJS-Series" OR "Go-Zero-To-Hero" OR "Rust-Zero-To-Hero" OR "Apache-Fory" OR "Database-Patterns/Liquibase" OR "Database-Patterns/DBMigration"
WHERE default(source_checked, default(created, updated)) < date(today) - dur(90 days)
SORT default(source_checked, default(created, updated)) ASC
```

### Tầng B quá hạn review (180 ngày)

```dataview
TABLE default(source_checked, default(created, updated)) AS checked
FROM "Microservices-Patterns" OR "Database-Patterns/PostgreSQL" OR "Design-Patterns-Go" OR "Design-Patterns-Rust" OR "Performance-System-Programming" OR "BPMP-Platform" OR "Go-Microservices-Mastery"
WHERE default(source_checked, default(created, updated)) < date(today) - dur(180 days)
SORT default(source_checked, default(created, updated)) ASC
```

### Note mồ côi (mục tiêu = 0 knowledge-orphan)

```dataview
TABLE type, domain, file.size AS bytes
FROM ""
WHERE !contains(file.path, "_archive/") AND file.ext = "md" AND length(file.inlinks) = 0
SORT file.folder ASC
```

### Note mỏng < 3 KB trong series/pattern (nợ kiến thức)

```dataview
TABLE file.size AS bytes, updated
FROM "Angular-Latest-Series" OR "React-Latest-Series" OR "SolidJS-Series" OR "Database-Patterns" OR "Rust-Zero-To-Hero"
WHERE file.size < 3000
SORT file.size ASC
```

### Mega-note > 50 KB

```dataview
TABLE file.size AS bytes
FROM ""
WHERE !contains(file.path, "_archive/") AND file.size > 50000
SORT file.size DESC
```

### Hàng đợi superseded (theo dõi merge)

```dataview
TABLE superseded_by, updated
FROM ""
WHERE status = "superseded"
SORT updated DESC
```

## 6. Tiến độ phase

- [x] **P0a** Baseline metadata (note này)
- [ ] **P0b** Snapshot vault (git tag hoặc zip) — *do bạn thực hiện; tôi không tự xác nhận được*
- [x] **P1** Phân tầng rule-based + dashboard (thay cho gắn frontmatter hàng loạt — không sửa note nào)
- [x] **P1.5** Nối 38 note mồ côi vào hub/MOC (additive; đã verify, xem nhật ký)
- [ ] **P2** Lập bản đồ cluster trùng + chọn canonical (chỉ đọc)
- [ ] **P3** Audit Tầng A: Java / Spring Boot 4 / Hibernate / PostgreSQL / Kafka / Camunda trước
- [ ] **P4** Merge theo ledger (cluster đã duyệt)
- [ ] **P5** Distill Notion (Tầng D)
- [ ] **P6** (tuỳ chọn) di chuyển thư mục — thực hiện trong giao diện Obsidian để link tự cập nhật

## 7. Nhật ký

- 2026-10-25 — Tạo tracker; baseline P0a; P1 rule-based. Chưa sửa note nào.
- 2026-10-25 — **P1.5:** append mục "Bổ sung (P1.5)" vào 9 hub/MOC (Microservices hub, Rust và Go Lộ-trình, MOC-JVM-Frameworks, DBMigration-MOC, Hub-Database-Persistence, SolidJS-MOC, MOC-PDMS, MOC-Database-Internals). Chỉ append, không sửa dòng cũ.
  - Verify: dung lượng 9 file đều tăng; outlink tăng đúng số link đã thêm (ví dụ Rust Lộ-trình 33 → 48 = 14 link bài + 1 link tracker); orphan còn 7 = chỉ note cấu trúc (HOME, MOC-Reading-List, Notion Note.md, 2 README, Note-taking Methods, gemini example).
  - Đính chính baseline: 45 mồ côi = 38 knowledge + 7 cấu trúc (bản đầu ghi nhầm 37 + 8).
  - Ngoài kế hoạch: thêm 1 mục link tracker vào cuối `_moc/VAULT-DASHBOARD.md` (2026-10-25, phase P1).
- 2026-10-25 — **Kiểm tra format Obsidian** (theo yêu cầu bổ sung): đọc quy ước của vault (`gemini-scribe/AGENTS.md`, `_templates/template-concept`, `concepts/README`, mẫu technology-update Angular 22) và lập hợp đồng format ở mục 8.
  - Phát hiện: patch frontmatter qua API **ghi lại toàn bộ khối frontmatter** (`tags: [a, b]` → danh sách nhiều dòng). Vì vậy **không bump `updated`** của 10 note đã được append (tránh đổi style YAML của note cũ); mốc tươi chuyển sang `source_checked/created` (mục 5).
  - Link có dấu tiếng Việt (`Lộ-trình-Tổng-quan`) đã verify resolve (inlink tăng đúng).
  - Sửa tracker: đánh số mục 4.1, thêm 3.6 và mục 8.

## 8. Hợp đồng format Obsidian (áp dụng cho mọi chỉnh sửa)

### Frontmatter

- Khóa chuẩn của vault: `type`, `domain`, `status`, `created`, `updated`, `tags`; tùy chọn `aliases`. Note technology-update thêm `source_checked` và tag `technology-update`. Note bị thay thế thêm `status: superseded` + `superseded_by`.
- Ngày viết `YYYY-MM-DD`, **không để trong nháy** (khớp các note hiện có).
- Note mới: `tags: [a, b]` dạng inline (khớp style vault). Note cũ giữ nguyên style.
- Patch frontmatter qua API ghi lại cả khối (tags inline → danh sách nhiều dòng; giá trị ngày vẫn giữ). Chỉ dùng cho note cần thêm trường (P3), sau đó kiểm tra tag và ngày không đổi nghĩa.

### Link

- Wikilink dạng `[[thư-mục/tên-note]]` hoặc `[[thư-mục/tên-note|Nhãn]]`. Trong **ô bảng** không dùng nhãn có ký tự `|` (bỏ nhãn hoặc dùng `\|`).
- Không đổi tên / di chuyển file ngoài giao diện Obsidian (để link tự cập nhật) — thuộc P6.
- Không tạo link tới note chưa tồn tại. Sau mỗi batch kiểm tra `file.inlinks` của đích để xác nhận link resolve.

### Nội dung

- Heading phân cấp không nhảy bậc (`##` → `###`). Callout: `> [!warning] Tiêu đề`. Task: `- [ ]` / `- [x]`. Mermaid: khối ` ```mermaid `. Dataview: khối ` ```dataview `. Bảng luôn có hàng phân cách `|---|`.
- Khi cập nhật kiến thức: giữ bản cũ trong `> [!history]`.
- Note technology-update theo mẫu `Angular-Latest-Series/25-Angular-22-Technology-Update-2026`: Tóm tắt dễ nhớ (có mermaid) → Thay đổi ảnh hưởng thiết kế → Compatibility → Checklist nâng cấp → Liên kết trong Vault → Nguồn chính thức (link markdown tới trang chính thức).

### Đặt tên và nối vào hệ thống

- `concepts/`: flat, kebab-case, không subfolder. Series: tiền tố số `0X-` và `PX-`. MOC: `_moc/MOC-*.md`.
- Note mới phải (1) dùng template trong `_templates/`, (2) được link từ MOC/hub tương ứng, (3) với `concepts/` được thêm vào bảng Index của [[concepts/README]].

### Quy trình ghi (chống mất dữ liệu)

- Note cũ: **chỉ append** (mục cuối trang) hoặc patch có đích rõ ràng. Không ghi đè nguyên file.
- Trước khi tạo file mới: kiểm tra đường dẫn chưa tồn tại (công cụ tạo file sẽ ghi đè nếu trùng).
- Sau mỗi batch: so dung lượng, `file.outlinks`, `file.inlinks`; đọc lại file khi cần.

## 9. P2 — Bản đồ cluster (đang thực hiện)

- Chi tiết: [[_moc/VAULT-P2-CLUSTER-MAP]]
- 2026-10-25 — Cluster 1 (SolidJS) đã lập bản đồ; còn lại 5 cluster. Chưa sửa / xóa / gộp note nào.
- Phát hiện: `useTransition` của Solid chỉ tồn tại trong bài cũ `05-Async-and-Suspense` → bài cũ **chưa được gộp** cho tới khi ledger hoàn tất.
- 2026-10-25 — **Cluster 2 (Loom)** đã lập bản đồ: kết luận *tách vai trò, không gộp* (A: khái niệm, C: tham chiếu Java, B: quyết định Loom vs Reactive, D: so sánh đa ngôn ngữ). Sổ claim lỗi thời đã tra nguồn chính (JEP 491, JEP 533 / 543); chưa đính chính các note Java, chờ duyệt.
- 2026-10-25 — **Cluster 1 (SolidJS) xử lý một phần:** tạo `SolidJS-00-Overview` (sửa link hỏng), thêm mục "Bổ sung (P2)" vào `SolidJS-MOC`, thêm mục "Đính chính" cuối `SolidJS-08-Async-Resources`. Tất cả chỉ append hoặc tạo mới.
- Phát hiện phiên bản: Solid 2.0 vẫn ở RC (`rc.9`, 2026-09-18); series giữ baseline 1.x.
