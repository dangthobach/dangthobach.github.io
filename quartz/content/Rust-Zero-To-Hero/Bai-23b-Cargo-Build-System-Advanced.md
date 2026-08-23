---
type: course
domain: languages/rust
status: active
created: 2026-08-22
updated: 2026-08-22
tags: []
---

# Bài 23b: Cargo & Build System nâng cao — Vượt qua `Cargo.toml` cơ bản

Chào Chuyên gia Java, Bài 23 đã cho bạn workspace & crate design (tương đương multi-module Maven/Gradle). Phần này lấp nốt các cơ chế Cargo mà bạn sẽ chạm hàng ngày trong dự án production: semver resolution, feature flags, và build profile tuning — tương đương phần "dependency management" và "build optimization" mà Maven/Gradle xử lý khá khác.

## 1. Semver Resolution — dấu `^`, `~`, `=` nghĩa là gì

```toml
[dependencies]
serde = "1.0.200"      # ngầm hiểu = "^1.0.200" → cho phép >=1.0.200, <2.0.0
tokio = "~1.38"        # cho phép >=1.38.0, <1.39.0 — chặt hơn, chỉ patch update
axum = "=0.7.5"        # CHÍNH XÁC 0.7.5, không tự update — dùng khi cần pin tuyệt đối
```

Mặc định (không ký hiệu) là **caret requirement** (`^`) — khác Maven (mặc định version cố định tuyệt đối trừ khi bạn khai báo range). Rust theo semver nghiêm ngặt: major version 0 (`0.x.y`) coi `y` như breaking change (vì "chưa ổn định"), còn từ `1.0.0` trở đi chỉ major version mới breaking.

`Cargo.lock` ghi lại version **chính xác** đã resolve — commit file này vào git cho binary/application (đảm bảo build reproducible), nhưng thường KHÔNG commit cho library crate (để downstream tự resolve theo constraint của họ).

## 2. Feature Flags — biên dịch có điều kiện, tối ưu binary size

Đây là cơ chế mạnh hơn Maven profile nhiều — features có thể bật/tắt từng phần code trong CHÍNH crate của bạn lẫn dependency:

```toml
[features]
default = ["postgres"]
postgres = ["dep:sqlx", "sqlx/postgres"]
mysql = ["dep:sqlx", "sqlx/mysql"]
full = ["postgres", "mysql", "metrics"]
metrics = ["dep:prometheus"]

[dependencies]
sqlx = { version = "0.8", optional = true, default-features = false }
prometheus = { version = "0.13", optional = true }
```

```rust
#[cfg(feature = "metrics")]
fn record_latency(ms: u64) {
    // chỉ compile khi feature "metrics" được bật
}
```

```bash
cargo build --features postgres,metrics
cargo build --no-default-features --features mysql
```

**Feature unification** là điểm dễ gây bug nhất: nếu 2 crate trong cùng dependency tree bật 2 feature set khác nhau của cùng 1 dependency, Cargo **hợp nhất (union)** chúng cho toàn bộ build — không có "feature riêng cho từng consumer". Đây là lý do design nguyên tắc "features nên additive, không nên loại trừ lẫn nhau" (tránh feature A tắt hành vi mà feature B cần).

## 3. Build Profile Tuning — kiểm soát trade-off compile time vs runtime performance

```toml
[profile.release]
opt-level = 3        # 0-3, hoặc "s"/"z" (tối ưu size). Mặc định release = 3
lto = "fat"          # Link-Time Optimization: true/"fat"/"thin"/false — tối ưu xuyên crate boundary
codegen-units = 1    # mặc định 16; =1 chậm compile hơn nhưng optimize tốt hơn (ít song song hóa compile)
panic = "abort"      # bỏ unwinding, binary nhỏ hơn & nhanh hơn, nhưng mất khả năng catch_unwind
strip = true         # loại bỏ debug symbol khỏi binary cuối

[profile.dev]
opt-level = 1        # tăng nhẹ so với mặc định 0, giúp test nhanh hơn mà debug vẫn ổn
```

Đây là công cụ tương đương "JIT tuning flags" của JVM nhưng ở **compile-time** — vì Rust compile ra native code thẳng, không có runtime JIT để tối ưu về sau. Với service như PDMS chạy trên EKS, `lto = "fat"` + `codegen-units = 1` cho binary release chậm build hơn đáng kể (có thể x2-3 lần) đổi lấy runtime nhanh hơn — nên thường chỉ áp dụng cho profile `release`, không áp cho `dev`.

## 4. `build.rs` — Build Script cơ bản

Chạy TRƯỚC khi crate của bạn compile — dùng để generate code, compile C library đi kèm (`cc` crate), hoặc set biến môi trường/cfg cho compiler:

```rust
// build.rs (đặt ở root, ngang hàng Cargo.toml)
fn main() {
    println!("cargo:rerun-if-changed=proto/service.proto");
    // ví dụ thực tế: tonic_build::compile_protos("proto/service.proto").unwrap();
    // -> sinh code Rust từ file .proto TRƯỚC khi crate chính compile
}
```

Đây chính là cơ chế đứng sau Bài 28 (Tonic gRPC) — `.proto` file được `build.rs` compile thành Rust struct/trait tự động mỗi lần bạn build, tương tự Maven protobuf-plugin nhưng tích hợp thẳng vào quy trình `cargo build` không cần plugin riêng.

## 5. Cheat Sheet

| Khái niệm | Maven/Gradle tương đương | Rust/Cargo |
|---|---|---|
| Version range | `[1.0,2.0)` | `^1.0` (mặc định), `~1.0`, `=1.0.0` |
| Lock file | không chuẩn hóa (hoặc dùng plugin) | `Cargo.lock` |
| Conditional compilation | Maven profile | `[features]` + `#[cfg(feature = "...")]` |
| Optimize build | JVM flags (runtime) | `[profile.release]` (compile-time) |
| Code generation trước build | annotation processor / plugin | `build.rs` |

---
**Bài tập nhỏ:**
1. Thêm feature `"debug-logs"` vào một crate demo, dùng `#[cfg(feature = "debug-logs")]` để bật một `println!` chỉ khi feature này được bật, build thử với và không có `--features debug-logs`.
2. So sánh thời gian `cargo build --release` giữa `codegen-units = 16` (mặc định) và `codegen-units = 1` trên một project vài trăm dòng, ghi nhận chênh lệch.
3. Viết một `build.rs` tối giản chỉ in ra biến môi trường `OUT_DIR` để hiểu build script chạy trước và tách biệt với crate chính như thế nào.
