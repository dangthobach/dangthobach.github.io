---
type: course
domain: languages/rust
status: active
created: 2026-08-25
updated: 2026-08-25
tags: []
---

# Bài 23c: CI, MSRV & Fuzzing — Kỷ luật Crate Engineering Cấp Production

Chào Chuyên gia Java, Bài 23b đã cho bạn semver/feature/build profile — phần "viết Cargo.toml đúng". Bài này là phần "đảm bảo crate không âm thầm hỏng theo thời gian": CI pipeline, chính sách MSRV, và fuzzing — 3 thứ Maven/Gradle + JUnit không có tương đương trực tiếp vì Java không có UB (undefined behavior) và ABI theo compiler version như Rust.

## 1. MSRV (Minimum Supported Rust Version) — cam kết version thấp nhất

Không giống JVM (bytecode tương thích ngược rất tốt), Rust liên tục thêm syntax/API mới, và nếu crate của bạn dùng API mới nhất mà không khai báo, người dùng dùng Rust cũ hơn sẽ build lỗi mà không biết tại sao:

```toml
[package]
name = "pdms-core"
version = "1.2.0"
rust-version = "1.75" # MSRV — cargo sẽ CẢNH BÁO nếu bạn code dùng feature mới hơn 1.75
```

```bash
cargo install cargo-msrv
cargo msrv find     # tự động dò MSRV thật sự của crate bằng cách build thử nhiều version
cargo msrv verify   # kiểm tra rust-version khai báo có đúng không, dùng trong CI
```

**Chính sách phổ biến:** "N-2" (hỗ trợ 2 minor version release gần nhất) hoặc pin cứng theo version dùng trong production (ví dụ PDMS deploy Rust 1.75 trên toàn bộ service → MSRV = 1.75, không quan tâm version mới hơn cho tới khi hạ tầng upgrade).

## 2. CI Pipeline — GitHub Actions cho Rust

Khác Maven (thường chỉ cần `mvn test`), CI Rust chuẩn cần chạy NHIỀU kiểm tra riêng biệt vì mỗi cái bắt một loại lỗi khác nhau:

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  test:
    strategy:
      matrix:
        rust: [stable, beta, "1.75"] # test cả MSRV lẫn version mới nhất
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@master
        with:
          toolchain: ${{ matrix.rust }}
          components: clippy, rustfmt
      - run: cargo fmt --check          # format sai -> fail, không tự sửa trong CI
      - run: cargo clippy -- -D warnings # lint sai -> fail (biến warning thành error)
      - run: cargo test --all-features
      - run: cargo doc --no-deps        # doctest + doc phải build được (liên hệ Bài 15b)

  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cargo install cargo-deny
      - run: cargo deny check           # license + security advisory + duplicate deps
```

**`cargo fmt --check` và `cargo clippy -- -D warnings`** là 2 gate gần như bắt buộc trong mọi team Rust nghiêm túc — tương đương checkstyle/spotbugs trong Java CI, nhưng compiler-integrated nên bắt được nhiều hơn (clippy có hơn 700 lint rule, nhiều cái phát hiện logic bug thật, không chỉ style).

## 3. `cargo-deny` — Audit License & Security

```toml
# deny.toml
[licenses]
allow = ["MIT", "Apache-2.0", "BSD-3-Clause"]
deny = ["GPL-3.0"] # chặn dependency có license không phù hợp dùng trong sản phẩm thương mại

[advisories]
vulnerability = "deny" # fail CI nếu có dependency với CVE đã biết (từ RustSec advisory database)

[bans]
multiple-versions = "warn" # cảnh báo khi 2 version khác nhau của cùng 1 crate cùng tồn tại trong dependency tree
```

Tương đương OWASP Dependency-Check hoặc Snyk trong thế giới Java/Maven, nhưng tích hợp thẳng vào `cargo` workflow.

## 4. Fuzzing — `cargo-fuzz`, khác property-testing (Bài 15b) như thế nào

Bài 15b đã có `proptest` — sinh input ngẫu nhiên theo **kiểu dữ liệu Rust có cấu trúc** (`Vec<i32>`, struct...) để kiểm property bạn tự định nghĩa. Fuzzing khác: sinh **byte ngẫu nhiên vô nghĩa** (không quan tâm cấu trúc) và feed thẳng vào hàm parse/deserialize của bạn, mục tiêu là tìm **panic hoặc crash**, không kiểm property logic:

```bash
cargo install cargo-fuzz
cargo fuzz init
```

```rust
// fuzz/fuzz_targets/parse_config.rs
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // Fuzzer feed hàng triệu tổ hợp byte ngẫu nhiên vào đây
    if let Ok(s) = std::str::from_utf8(data) {
        let _ = pdms_core::parse_config(s); // mục tiêu: không bao giờ panic/crash, kể cả input rác
    }
});
```

```bash
cargo fuzz run parse_config           # chạy liên tục tới khi tìm crash hoặc bạn dừng
cargo fuzz run parse_config -- -max_total_time=300  # giới hạn 5 phút, dùng trong CI nightly
```

**Khi nào cần fuzzing thật sự:** bất kỳ hàm nào parse input **không tin cậy** (file upload, network payload, config từ bên ngoài) — đây chính xác là nhóm chức năng dễ có lỗi bảo mật nhất (buffer over-read, panic-based DoS, integer overflow dẫn tới UB nếu có unsafe — liên hệ Bài 19). Fuzzing không thay thế unit test/proptest — nó là lớp phòng thủ thứ 3, chuyên tìm edge case bạn không thể nghĩ ra bằng tay.

## 5. Cheat Sheet

| Nhu cầu | Java/Maven | Rust |
|---|---|---|
| Cam kết version thấp nhất hỗ trợ | thường ngầm định qua `<source>`/`<target>` | `rust-version` trong Cargo.toml + `cargo-msrv` |
| CI test đa version | Maven + matrix CI thủ công | GitHub Actions matrix (stable/beta/MSRV) |
| Lint gate | Checkstyle, SpotBugs | `cargo clippy -- -D warnings` |
| Audit license/CVE dependency | OWASP Dependency-Check, Snyk | `cargo-deny` |
| Tìm crash bằng input ngẫu nhiên | JQF, Jazzer (ít phổ biến hơn) | `cargo-fuzz` (rất phổ biến, chuẩn ecosystem) |

---
**Bài tập nhỏ:**
1. Thêm `rust-version` vào `Cargo.toml` của một crate demo, chạy `cargo msrv find` để xác nhận version thật sự cần.
2. Viết file `.github/workflows/ci.yml` tối giản chạy `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` trên 1 project demo, push lên GitHub và xem Action chạy.
3. Viết 1 fuzz target cho một hàm parse CSV đơn giản (từ Bài 4c/4b), chạy `cargo fuzz run` vài phút, xem có crash nào được tìm thấy không.
