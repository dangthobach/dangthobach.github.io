---
type: moc
domain: knowledge-management
status: living-document
created: 2026-10-25
updated: 2026-10-25
tags: [moc, audit, refactor, cluster-map]
---

# P2 — Bản đồ cluster trùng chủ đề

> Chi tiết cho phase P2 của [[_moc/VAULT-REFACTOR-2026-10]]. **Chỉ đọc và lập bản đồ, chưa sửa / xóa / gộp note nào.**
> Quy ước: *canonical* = note giữ làm bản chính; *absorbed* = note cũ sẽ chuyển `status: superseded` sau khi ledger hoàn tất (bất biến 3–4).

## Trạng thái các cluster

| # | Cluster | Trạng thái |
|---|---|---|
| 1 | SolidJS (hai series song song) | Đã lập bản đồ (mục dưới); còn 1 cặp chưa đối chiếu |
| 2 | Virtual thread / Loom (4 nơi) | Chưa đọc |
| 3 | Index PostgreSQL (concepts + PostgreSQL/04 + 2 Notion) | Chưa đọc |
| 4 | Saga / CQRS (Notion + Microservices-Patterns) | Chưa đọc |
| 5 | Sharding (3 Notion + PostgreSQL/10) | Chưa đọc |
| 6 | Reactivity React vs Solid (4 note / 3 thư mục) | Chưa đọc |

---

## Cluster 1 — SolidJS: series cũ (00–06) và series mới (SolidJS-01…15)

### Kết luận sơ bộ

- Series cũ là **bản nháp đầu** (cùng ngày tạo 2026-05-08, kích thước ~3 KB mỗi bài). Series mới `SolidJS-xx` mở rộng cùng chủ đề (11–28 KB) và có MOC riêng ([[SolidJS-Series/SolidJS-MOC]]).
- **Canonical đề xuất: series mới.** Series cũ **chưa được gộp** vì chứa một số nội dung không có trong series mới (bảng dưới).
- Mức đọc: đã đọc đầy đủ Roadmap cũ, 6 bài cũ, và 4 bài mới (01, 04, 06, 08). Các bài mới 02, 03, 05, 07, 09–15 chưa đọc, nên các ô "đã có" liên quan chỉ mang tính tạm.

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

### Lỗi sẵn có phát hiện khi đọc (không do refactor gây ra)

- Bài [[SolidJS-Series/SolidJS-01-Reactivity-Internals]] link tới `SolidJS-Series/SolidJS-00-Overview`, file này **không tồn tại** (link hỏng). Cần quyết định: tạo bài Overview hay bỏ link.
- [[SolidJS-Series/SolidJS-MOC]] mô tả "12 modules" và mục Vault Structure chỉ liệt kê 01–12, trong khi tồn tại thêm SolidJS-13, 14, 15.
- SolidJS-14 và SolidJS-15 đều ~1.5 KB (nghi con trỏ hoặc stub, chưa đọc).

### Claim trong series mới cần xác minh bằng nguồn (đưa vào P3, chưa kết luận)

- Bài 08: fetcher của `createResource` nhận `{ signal }` (AbortSignal) từ "SolidJS v1.8+" — cần đối chiếu tài liệu chính thức.
- Bài 06: mô tả dạng `setStore(fn)` như hàm nhận "draft" — cần đối chiếu cách Solid xử lý hàm setter.
- Trạng thái SolidJS 2.0 / phiên bản hiện hành tại thời điểm 2026-10.

---

## Cluster 2–6

Chưa đọc. Mỗi cluster sẽ được thêm một mục tương tự (ledger + canonical đề xuất + lỗi sẵn có) khi lập bản đồ.
