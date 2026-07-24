---
type: course
domain: languages/rust
status: active
created: 2026-07-24
updated: 2026-07-24
tags: [rust, sqlx, diesel, database, migration, transactions]
source_checked: 2026-07-24
---

# Bài 53 — SQLx 0.8 và Diesel 2.3 Update

## Decision model

```mermaid
flowchart TD
    Q{"Ưu tiên gì?"}
    Q -->|"SQL explicit + async"| S["SQLx"]
    Q -->|"Typed query DSL + schema"| D["Diesel"]
    S --> SC["Compile-time checked query tùy chọn"]
    D --> DC["Compile-time schema/query types"]
```

## SQLx 0.8

Các điểm cần cập nhật:

- Database traits sử dụng GAT.
- Offline query metadata tách theo invocation.
- Query nullability inference có thể thay đổi.
- MSSQL driver không còn trong open-source set.
- `PgListener` có các sửa lỗi cancellation.
- MSRV theo policy release cycle.

### Offline CI

```bash
cargo sqlx prepare --workspace -- --all-targets
cargo check --workspace --all-targets
```

CI phải kiểm tra metadata không stale sau khi SQL thay đổi.

## Diesel 2.3

Khi nâng:

- Chạy migration test trên database thật.
- Audit derive/macro errors.
- Kiểm tra insert/returning khác biệt theo backend.
- Không giả định Diesel sync có thể chạy trực tiếp trên async worker.
- Dùng blocking pool hoặc integration phù hợp.

## Transaction và cancellation

Future bị cancel không đồng nghĩa database operation chắc chắn “chưa chạy”. Thiết kế idempotency và transaction boundary theo database guarantee, không theo cảm giác của async call site.

## Lab

Triển khai cùng use case bằng SQLx và Diesel:

- Optimistic locking.
- Transaction rollback.
- Batch insert.
- Query pagination.
- Pool saturation test.

## Gap cần tránh

- Tin compile-time SQL check thay thế integration test.
- Giữ transaction qua remote RPC.
- Pool size lớn hơn khả năng database.
- Gọi blocking Diesel trên Tokio core thread.
- Auto migration không có review/governance.

## Liên kết

- [[Bai-12-SQLx-Database|SQLx foundation]]
- [[Bai-26-SQLx-Advanced|SQLx Advanced]]
- [[Bai-27-Diesel|Diesel]]
- [[connection-pooling-pgbouncer|Connection Pooling]]

## Nguồn

- [SQLx changelog](https://github.com/launchbadge/sqlx/blob/main/CHANGELOG.md)
- [Diesel 2.3.7](https://github.com/diesel-rs/diesel/releases/tag/v2.3.7)

