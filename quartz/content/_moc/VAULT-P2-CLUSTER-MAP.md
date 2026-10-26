---
type: moc
domain: knowledge-management
status: living-document
created: 2026-10-25
updated: 2026-10-25
tags: [moc, audit, refactor, cluster-map]
---

# P2 — Bản đồ cluster trùng chủ đề

> Chi tiết cho phase P2 của [[_moc/VAULT-REFACTOR-2026-10]]. **Không xóa, không gộp, không ghi đè note cũ.** Chỉnh sửa duy nhất lên note có sẵn là các mục "Đính chính" / "Bổ sung" ở cuối trang (ghi trong nhật ký từng cluster).
> Quy ước: *canonical* = note giữ làm bản chính cho một chủ đề; *absorbed* = note cũ sẽ chuyển `status: superseded` sau khi ledger hoàn tất (bất biến 3–4).

## Trạng thái các cluster

| # | Cluster | Trạng thái |
|---|---|---|
| 1 | SolidJS (hai series song song) | Đã lập bản đồ; đã sửa link hỏng, đã đính chính 1 claim; còn cặp 03 ↔ 05 chưa đối chiếu |
| 2 | Virtual thread / Loom (4 nơi) | Đã lập bản đồ; **kết luận: tách vai trò, không gộp**; chưa đính chính các note Java |
| 3 | Index PostgreSQL (concepts + PostgreSQL/04 + 2 Notion) | Chưa đọc |
| 4 | Saga / CQRS (Notion + Microservices-Patterns) | Chưa đọc |
| 5 | Sharding (3 Notion + PostgreSQL/10) | Chưa đọc |
| 6 | Reactivity React vs Solid (4 note / 3 thư mục) | Chưa đọc |

---

## Cluster 1 — SolidJS: series cũ (00–06) và series mới (SolidJS-01…15)

### Kết luận sơ bộ

- Series cũ là **bản nháp đầu** (cùng ngày tạo 2026-05-08, kích thước ~3 KB mỗi bài). Series mới `SolidJS-xx` mở rộng cùng chủ đề (11–28 KB) và có MOC riêng ([[SolidJS-Series/SolidJS-MOC]]).
- **Canonical đề xuất: series mới.** Series cũ **chưa được gộp** vì chứa một số nội dung không có trong series mới (bảng dưới).
- Mức đọc: đã đọc đầy đủ Roadmap cũ, 6 bài cũ, và 4 bài mới (01, 04, 06, 08) cùng MOC. Các bài mới 02, 03, 05, 07, 09–15 chưa đọc, nên các ô "đã có" liên quan chỉ mang tính tạm.

### Ledger: bài cũ → bài mới

| Bài cũ | Canonical | Ý chính đã có ở canonical | **Chưa có — cần chuyển trước khi superseded** | Claim nghi sai — **không chuyển** |
|---|---|---|---|---|
| [[SolidJS-Series/00-Roadmap]] | [[SolidJS-Series/SolidJS-MOC]] | Lộ trình, mục tiêu, sơ đồ tổng quan (MOC mới 12 bài, 3 phase) | — | — |
| [[SolidJS-Series/01-Reactivity-Internals]] | [[SolidJS-Series/SolidJS-01-Reactivity-Internals]] | Signal / Effect / Memo, tracking context, DAG, quy tắc đọc signal trong tracking scope (Pitfall 2); ví dụ JSX biên dịch có tương đương ở bài 04 (template, insert) | — | — |
| [[SolidJS-Series/02-Components-and-Props]] | [[SolidJS-Series/SolidJS-04-JSX-Component-Model]] | Component chạy một lần, props là Proxy/getter, không destructure props, mergeProps, splitProps | Sơ đồ sequence luồng props (Parent → Proxy → Child) | "Dùng `setInterval` trực tiếp trong thân component mà không sợ lặp" — thiếu `onCleanup`, dễ rò rỉ |
| [[SolidJS-Series/03-Control-Flow]] | [[SolidJS-Series/SolidJS-05-Control-Flow-Primitives]] | **Chưa đối chiếu** (bài 05 chưa đọc) | Cần đọc 05 để xác định | — |
| [[SolidJS-Series/04-Store-Management]] | [[SolidJS-Series/SolidJS-06-Stores-Nested-State]] | createStore, path syntax có predicate, reconcile, produce, store module-level, kết hợp Context | Bảng so sánh Signal vs Store; mẹo truyền store xuống con ở dạng read-only | — |
| [[SolidJS-Series/05-Async-and-Suspense]] | [[SolidJS-Series/SolidJS-08-Async-Resources]] | createResource, Suspense, ErrorBoundary, optimistic update bằng mutate, cache pattern | **`useTransition` (Transition API)** — xác minh bằng tìm kiếm toàn vault: chỉ xuất hiện trong note React và bài cũ này; prefetch khi hover; nhắc tới solid-query | "createResource tự hủy request cũ"; "Suspense hoạt động bằng cách throw Promise" (bài 08 mô tả khác: bỏ qua kết quả cũ, hủy mạng phải tự xử lý) |
| [[SolidJS-Series/06-Enterprise-Architecture]] | [[SolidJS-Series/SolidJS-07-Context-DI]] và [[SolidJS-Series/SolidJS-12-Performance-Testing]] | lazy (bài 08), batch (bài 02 theo MOC), cấu trúc Feature-Slice (bài 12 theo MOC); phần Context cần đối chiếu bài 07 | **Headless component** (tách logic `createCounter` khỏi UI); chiến lược nhiều Context chuyên biệt (cần đối chiếu 07); nhắc Playwright cho E2E | Placeholder `ThemeStub` trong ví dụ Context (lỗi đánh máy / mã giả) |

### Việc phải làm trước khi đánh dấu superseded (P4)

1. Đọc bài mới 03, 05, 07, 09–12 để hoàn tất cột "đã có" (đặc biệt cặp 03 ↔ 05 và phần Context ở 07).
2. Với từng mục ở cột "Chưa có": thêm vào bài canonical dưới dạng mục append "Bổ sung từ bản nháp cũ" (giữ nguyên ví dụ gốc), rồi kiểm tra bất biến 6.
3. Với cột "nghi sai": **không chuyển**, giữ nguyên trong bài cũ kèm callout `> [!warning]` trỏ tới bài mới đúng hơn.
4. Chỉ sau đó mới đặt `status: superseded` + `superseded_by` cho bài cũ.

### Đã xử lý (2026-10-25)

- **Link hỏng đã sửa:** tạo thật bài [[SolidJS-Series/SolidJS-00-Overview]] (toàn cảnh, phiên bản, bản đồ khóa học, bảng API bị ảnh hưởng bởi Solid 2.0). Link `SolidJS-00-Overview` trong bài 01 nay resolve (bài Overview có 1 inlink).
- **Bổ sung MOC:** thêm mục "Bổ sung (P2)" vào [[SolidJS-Series/SolidJS-MOC]] liệt kê Overview, bài 13, bài 14.
- **Đính chính bài 08:** thêm mục "Đính chính (2026-10-25)" cuối [[SolidJS-Series/SolidJS-08-Async-Resources]] — fetcher của `createResource` 1.x chỉ nhận `{ value, refetching }`, không có `signal`. Nguồn: tài liệu `createResource` và type definitions `solid-js@1.9.12`. Nội dung gốc giữ nguyên.

### Hiện trạng phiên bản (đã tra nguồn, 2026-10-25)

- Dòng 1.x là bản ổn định; type definitions `solid-js@1.9.12` có trên unpkg.
- **Solid 2.0 vẫn là Release Candidate:** bản mới nhất trên trang GitHub Releases khi kiểm tra là `solid-js@2.0.0-rc.9` (2026-09-18), đánh dấu Pre-release.
- Thay đổi theo nguồn: `createResource` bị gỡ (async qua memo), `batch` bị gỡ, `<Suspense>` → `<Loading>` + `isPending`, `onMount` → `onSettled` (thay thế gần nhất), `<Dynamic>` → `dynamic()` (deprecated ở rc.9).
- Series dạy Solid 1.x. Cập nhật sang 2.0 chỉ nên làm khi 2.0 ra bản ổn định (P3).

### Còn mở (Cluster 1)

- Bài 11 (SolidStart): RC nói `"use server"` thành tính năng lõi; ảnh hưởng tới `cache()` / `action()` trong bài 11 **chưa đối chiếu**.
- Bài 06: mô tả `setStore(fn)` như hàm nhận "draft" — nghi sai, **chưa tra nguồn**.
- SolidJS-14, SolidJS-15 ~1.5 KB mỗi bài (nghi con trỏ hoặc stub, chưa đọc).

---

## Cluster 2 — Virtual thread / Project Loom (4 nơi)

### Các note trong cluster

| Ký hiệu | Note | Kích thước | Ghi chú |
|---|---|---|---|
| A | [[concepts/java-virtual-threads-deep-dive]] | ~6 KB | `status: in-progress`; mở đầu ngắn gọn; frontmatter có alias "Project Loom" |
| B | [[concepts/project-loom-deep-dive]] | ~18.5 KB | `status: evergreen`; khung quyết định Loom vs Reactive, khuyến nghị cho PDMS |
| C | [[JVM-Frameworks-2026/04-RxJava/Project-Loom-Deep-Dive]] | ~27 KB | Tham chiếu Java đầy đủ nhất (API, pinning, ScopedValue, Structured Concurrency, observability, tích hợp) |
| D | [[Go-Zero-To-Hero/Deep-Dive-VirtualThreads-vs-Goroutines-vs-RustAsync]] | ~60 KB | So sánh đa ngôn ngữ; **đã được cập nhật 2026-08-15**, đã ghi nhận JEP 491 và coi phần cũ là lỗi thời |

Liên quan nhưng chưa đọc: [[Database-Patterns/JDBC-vs-R2DBC-vs-VirtualThreads]] (kiểm tra ở P3 cùng nhóm JDBC/Hibernate).

### Kết luận: **tách vai trò, không gộp**

Bốn note trùng một phần cơ chế (mount/unmount, pinning, API) nhưng mỗi note có một giá trị riêng mà ba note kia không thay thế được. Gộp sẽ làm mất giá trị đó, và phần trùng thực sự cần xử lý là **sự thật kỹ thuật đã lỗi thời**, không phải số lượng note.

| Vai trò đề xuất | Note | Giữ vì |
|---|---|---|
| Khái niệm nguyên tử (ngắn) | A | Giải thích Little's Law, phép ẩn dụ xe buýt, bảng Java/Rust analog (function coloring), nguyên tắc "đừng pool virtual thread" |
| Tham chiếu Java đầy đủ | C | API tạo thread, thuộc tính, ScopedValue vs ThreadLocal, Structured Concurrency, JFR / thread dump, tích hợp Spring / Kotlin |
| Quyết định Loom vs Reactive | B | Khung quyết định, backpressure, bảng khuyến nghị PDMS; **là nguồn duy nhất** cho ADR-002 (hiện chưa tồn tại) |
| So sánh đa ngôn ngữ + benchmark | D | Java / Go / Rust async, phương pháp benchmark, đã cập nhật JEP 491 |

### Ma trận sở hữu chủ đề (single source of truth)

| Chủ đề | Note sở hữu | Note khác trùng | Hành động đề xuất |
|---|---|---|---|
| Cơ chế mount/unmount, continuation, carrier | C | A, B, D | Giữ; các note khác trỏ tới C |
| **Pinning** | **D** (đã đính chính) | A, B, C | Thêm callout đính chính trỏ tới D |
| API tạo virtual thread, thuộc tính | C | A, B | Giữ |
| ScopedValue vs ThreadLocal | C | A (ThreadLocal), D | Gắn nhãn phiên bản (xem sổ claim) |
| Structured Concurrency | C | B | Gắn nhãn phiên bản và API đã đổi |
| Quyết định Loom vs Reactive, PDMS | B | C (tóm tắt) | Giữ; tạo ADR-002 khi bạn duyệt |
| Little's Law, ẩn dụ, Java/Rust analog | A | B | Giữ |
| Cấu hình Spring Boot / Tomcat / Quarkus | C, B | A | Xác minh ở P3 |
| Observability (JFR, thread dump, scheduler flags) | C | B | Sửa theo JEP 491 |
| So sánh Go / Rust, benchmark | D | — | Cập nhật baseline ở P3 |

### Sổ claim lỗi thời hoặc nghi sai

**Đã xác minh bằng nguồn chính (JEP 491, CSR JDK-8338813, InfoQ về JEP 533 / 543):**

| # | Claim trong vault | Thực tế đã tra | Ảnh hưởng |
|---|---|---|---|
| 1 | `synchronized` (và `Object.wait()`) **pin** virtual thread; fix bằng `ReentrantLock` | Từ **JDK 24**, JEP 491 giúp virtual thread nhả carrier khi chờ monitor, nên `synchronized` không còn là nguyên nhân pin trong trường hợp thường gặp | A (Pitfalls), B (§ pinning), C (sơ đồ lifecycle, Part 3). **D đã đính chính** |
| 2 | Phát hiện pin bằng `-Djdk.tracePinnedThreads=full` | Thuộc tính này **đã bị gỡ ở JDK 24**; dùng JFR event `jdk.VirtualThreadPinned` | B (§ phát hiện), C (Part 3, Part 8) |
| 3 | B: Structured Concurrency "Java 23 stable" | **Sai.** Vẫn là preview qua nhiều bản: JEP 453 (JDK 21) … JEP 505 (JDK 25), JEP 525 (JDK 26), JEP 533 (JDK 27, preview thứ bảy). JEP 543 đưa SC thành tính năng chính thức ở **JDK 28** | B |
| 4 | D: "Structured Concurrency Seventh Preview ở JDK 26" và nguồn "JEP 505 — Fifth/Seventh Preview (JDK 25/26)" | JDK 26 là preview thứ **sáu** (JEP 525); thứ **bảy** là JDK 27 (JEP 533) | D |
| 5 | D lấy mốc JDK 26 | JDK 27 theo lịch phát hành 2026-09-15; mốc cần cập nhật khi rà phiên bản (P3) | D |
| 6 | Ví dụ `StructuredTaskScope.ShutdownOnFailure`, `handleComplete` tùy biến | API được thiết kế lại ở JDK 25 (JEP 505, dùng `Joiner`); từ JDK 27 joiner báo lỗi bằng `ExecutionException` thay cho `FailedException` | B, C — ví dụ chỉ đúng cho JDK 21–24 |

**Nghi sai, chưa tra nguồn (đưa vào P3):**

- C: "Carrier thread **không bao giờ** bị block" — nói quá; D mô tả các trường hợp còn giữ carrier (native/FFM).
- C: `Thread.getState()` trả "PARKED/PINNED" — `Thread.State` không có hai giá trị này (chúng là trạng thái khái niệm).
- B: dùng `Future<User>` cho kết quả của `scope.fork(...)` — từ JDK 21 `fork` trả `Subtask`.
- A: bật `quarkus.virtual-threads.enabled=true` "để endpoint REST dùng virtual thread" — cần đối chiếu cơ chế `@RunOnVirtualThread` của Quarkus.
- B / C: các phát biểu về Hibernate 6.2+, Jedis/Lettuce, HikariCP, PgJDBC (đã sửa synchronized hay chưa).
- B: mục "Benchmark" dùng số minh họa, chưa đo thực; nên gắn nhãn rõ (D đã tách minh họa và đo thực).
- C / D: ScopedValue chính thức ở JDK 25 (D ghi "finalized ở Java 25 LTS", C còn ghi preview ở JDK 21) — cần dẫn JEP 506 khi sửa.

### Lỗi sẵn có phát hiện khi đọc (không do refactor gây ra)

- B link tới `JVM-Frameworks-2026/ADR-002-Project-Loom-vs-Reactive-for-PDMS` — **file không tồn tại** (tác giả đã ghi "cần viết"). Chỉ có ADR-001.
- A có alias "Project Loom" trong khi note B có tiêu đề "Project Loom Deep Dive" — tìm theo tên dễ nhầm.
- D không link tới A, B, C; A chỉ có 1 outlink — các note cùng chủ đề không biết đến nhau.

### Việc làm tiếp theo cho Cluster 2 (additive, chờ bạn duyệt)

1. Thêm mục "Đính chính (2026-10-25)" cuối A, B, C cho các claim đã xác minh (#1, #2, #3, #6), trỏ sang D và nêu rõ phạm vi phiên bản. Nội dung gốc giữ nguyên.
2. Thêm mục "Bản đồ note liên quan" cuối A, B, C, D (liên kết chéo + vai trò từng note).
3. Tạo `ADR-002-Project-Loom-vs-Reactive-for-PDMS` từ nội dung khung quyết định của B (cần bạn xác nhận ngữ cảnh PDMS).
4. P3: sửa mốc phiên bản của D, xác minh nhóm "nghi sai", đọc thêm [[Database-Patterns/JDBC-vs-R2DBC-vs-VirtualThreads]].

---

## Cluster 3–6

Chưa đọc. Mỗi cluster sẽ được thêm một mục tương tự (ledger + canonical đề xuất + lỗi sẵn có) khi lập bản đồ.
