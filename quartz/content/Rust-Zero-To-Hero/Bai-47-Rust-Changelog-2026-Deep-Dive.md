---
type: course
domain: languages/rust
status: active
created: 2026-07-24
updated: 2026-07-24
tags: []
---

# Bài 47: Rust Changelog 2026 Deep Dive — Symbol Mangling, Cargo Warnings & Một Case Study LLVM Miscompilation

> **Mục tiêu:** Hiểu bản chất 3 thay đổi quan trọng nhất của Rust 1.97.0/1.97.1 (bản mới nhất, 09-16/07/2026) — không chỉ để biết "có gì mới" mà để hiểu **compiler/toolchain hoạt động ở tầng nào** khi những thứ này thay đổi.
>
> **Level:** Advanced (đọc sau Bài 21 — Async Internals & Pin, và Bài 46 — Pointer Mental Model)
> **Bối cảnh:** Rust ra bản đều ~6 tuần/lần. Bài này chốt tại 1.97.1 (16/07/2026) — bản patch mới nhất tính đến 24/07/2026.

---

## 0. Vì sao Rust "ra bản nhanh" lại cần đọc kỹ hơn Go?

```
┌──────────────────────────────────────────────────────────┐
│  Go: ~6 tháng/major version → mỗi bản gói nhiều thay đổi, │
│      dễ dồn lại đọc 1 lần                                  │
│  Rust: ~6 tuần/minor version → mỗi bản ít thay đổi hơn,   │
│      NHƯNG dồn lại rất nhanh nếu bỏ qua vài bản liên tiếp  │
│      → dễ bị "surprise" khi build fail sau khi update xa   │
│      quá nhiều version cùng lúc                             │
└──────────────────────────────────────────────────────────┘
```

---

## 1. Đổi symbol mangling scheme mặc định sang v0

### 1.1 Symbol mangling là gì — nhắc lại bản chất

Compiler phải "mã hoá" tên hàm/type Rust (có thể chứa generic, module path, ký tự đặc biệt) thành một chuỗi hợp lệ ở tầng linker/object file — quá trình này gọi là **mangling**. Debugger, profiler, và crash reporter phải **demangle ngược lại** để hiển thị tên dễ đọc cho con người.

```
Tên gốc trong code:
  my_crate::repository::Repository<Order>::find_by_id

Sau khi mangle (rút gọn, minh hoạ ý tưởng — không phải chuỗi thật):
  legacy scheme:  _ZN9my_crate10repository10Repository...
  v0 scheme:      _RNvNtNtC8my_crate10repository10Repository...
```

### 1.2 Vì sao Rust đổi từ "legacy" sang "v0"

```
┌─────────────────────────────────────────────────────────┐
│  LEGACY MANGLING              │  V0 MANGLING              │
├─────────────────────────────────┼──────────────────────────┤
│ Không có spec chính thức,     │ Có spec chính thức, ổn    │
│ mỗi rustc version có thể       │ định giữa các version     │
│ khác nhau chút ít               │                            │
│ Không encode đủ thông tin      │ Encode đầy đủ generic type │
│ generic type phức tạp,          │ instantiation, const      │
│ decode dễ nhầm lẫn               │ generic — demangle chính  │
│                                  │ xác hơn nhiều              │
│ Công cụ demangle cũ (debugger, │ Cần công cụ demangle HỖ   │
│ profiler đời cũ) đọc được       │ TRỢ v0 — công cụ cũ FAIL  │
└─────────────────────────────────┴──────────────────────────┘
```

### 1.3 Tác động thực tế — điều cần kiểm tra ngay

```bash
# Kiểm tra công cụ debug/profiling đang dùng có hỗ trợ v0 chưa
# trước khi để CI/production build tự động dùng Rust 1.97+

# Nếu cần quay lại legacy mangling tạm thời (khi công cụ cũ chưa
# hỗ trợ v0), set trong Cargo config hoặc build flag:
# RUSTFLAGS="-C symbol-mangling-version=legacy" cargo build

# Đây là workaround TẠM THỜI — v0 sẽ là hướng đi lâu dài của
# toàn bộ ecosystem Rust, nên ưu tiên upgrade công cụ demangle
# thay vì pin ở legacy vĩnh viễn
```

**Liên hệ Bài 34 (OpenTelemetry) và Bài 39 (Security Production):** nếu PDMS dùng crash reporter hoặc APM tool để symbolicate stack trace từ binary Rust, đây là chỗ **bắt buộc kiểm tra** trước khi rollout Rust 1.97+ lên production — stack trace có thể hiện ra dạng mangled thô nếu tool chưa hỗ trợ.

---

## 2. `build.warnings` trong Cargo — kiểm soát warning khai báo được, không còn "ẩn" trong CI script

### 2.1 Cách cũ (trước 1.97)

```bash
# Cách cũ: muốn CI fail khi có warning, phải nhét vào script/env
# riêng biệt với Cargo.toml — dễ quên, dễ inconsistent giữa các
# CI job và local dev
RUSTFLAGS="-Dwarnings" cargo build
```

### 2.2 Cách mới — khai báo tường minh trong `Cargo.toml`

```toml
# Cargo.toml — Rust 1.97+
[build]
warnings = "deny"   # hoặc "warn" (mặc định) hoặc "allow"
```

```
┌─────────────────────────────────────────────────────────┐
│  allow   │  warn (mặc định)      │  deny                 │
├──────────┼─────────────────────────┼───────────────────────┤
│ Không    │ Hiện warning nhưng     │ Build FAIL nếu có bất  │
│ hiện gì  │ vẫn build thành công   │ kỳ warning nào          │
└──────────┴─────────────────────────┴───────────────────────┘
```

**Tình huống thực chiến:** đang sửa lỗi sau một refactor lớn, warning nhiều gây nhiễu khi đọc error thật:

```bash
# Tạm tắt warning để tập trung nhìn error trước, không cần sửa Cargo.toml
CARGO_BUILD_WARNINGS=allow cargo check

# Trong CI, ép fail khi có warning + gom hết lỗi/warning thay vì
# dừng ở lỗi đầu tiên:
CARGO_BUILD_WARNINGS=deny cargo check --keep-going
```

**Vì sao đáng để đưa vào series:** đây là ví dụ tốt cho phần Bài 15 (Config-Tracing-Testing) và pipeline CI của PDMS — config nằm cạnh code (`Cargo.toml`, version-controlled) thay vì nằm rải rác trong CI YAML, giảm khả năng team member quên set flag.

### 2.3 Linker stderr không còn bị ẩn mặc định

```
┌──────────────────────────────────────────────────────────┐
│  TRƯỚC 1.97: build thành công → linker im lặng hoàn toàn, │
│  kể cả khi linker có warning đáng chú ý (vd deprecated     │
│  optimization setting) — dev không biết trừ khi build FAIL │
│  TỪ 1.97: linker stderr hiển thị ngay cả khi build thành   │
│  công, ví dụ: "linker stderr: ignoring deprecated          │
│  optimization setting"                                       │
│  → muốn tắt noise này: [lints.rust] linker_messages =       │
│    "allow" trong Cargo.toml                                  │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Case study: Miscompilation trong LLVM optimization (1.97.0 → fix ở 1.97.1)

Đây là phần **quan trọng nhất về mặt tư duy** trong bài này — không phải để nhớ chi tiết bug, mà để rút bài học về niềm tin vào compiler.

### 3.1 Chuyện gì đã xảy ra

```
┌──────────────────────────────────────────────────────────┐
│  Timeline                                                  │
│  1.87.0 (~2025) → bug tiềm ẩn đã tồn tại trong cách Rust   │
│                    sinh LLVM IR (chưa ai phát hiện)         │
│  1.97.0 (09/07/2026) → thay đổi khác trong compiler làm    │
│                    TĂNG khả năng LLVM optimization pass     │
│                    kích hoạt đúng vào bug tiềm ẩn đó →      │
│                    miscompilation (code sinh ra SAI so      │
│                    với logic nguồn, không phải crash rõ     │
│                    ràng — nguy hiểm hơn crash vì im lặng)    │
│  1.97.1 (16/07/2026, 1 tuần sau) → backport fix từ LLVM +   │
│                    disable phần IR gây tăng khả năng trigger │
└──────────────────────────────────────────────────────────┘
```

### 3.2 Vì sao "miscompilation" đáng sợ hơn "compiler crash"

```
┌─────────────────────────────────────────────────────────┐
│  COMPILER CRASH                │  MISCOMPILATION            │
├───────────────────────────────┼──────────────────────────────┤
│ Build FAIL ngay lập tức         │ Build THÀNH CÔNG, binary   │
│ → bạn biết ngay có vấn đề       │ chạy nhưng sai logic ở      │
│                                  │ một số edge case cụ thể     │
│ Dễ báo lỗi, dễ tìm bản fix       │ Có thể chạy đúng ở dev/     │
│                                  │ staging, sai ở production   │
│                                  │ với input/optimization      │
│                                  │ level khác — RẤT khó debug  │
└─────────────────────────────────┴──────────────────────────────┘
```

### 3.3 Bài học thực chiến cho PDMS

```
┌──────────────────────────────────────────────────────────┐
│  ✅ KHÔNG bao giờ tự động auto-upgrade Rust toolchain      │
│     production ngay khi bản mới ra — đợi ít nhất vài ngày  │
│     tới 1 tuần, theo dõi Rust blog/issue tracker            │
│  ✅ Pin Rust version tường minh trong `rust-toolchain.toml`│
│     thay vì để "stable" trôi tự do — kiểm soát được thời    │
│     điểm upgrade, không bị kéo theo bản có bug ẩn            │
│  ✅ Giữ CI chạy test suite đầy đủ (đặc biệt property-based  │
│     test, không chỉ unit test cụ thể) — miscompilation dạng │
│     này thường chỉ lộ ra qua test bao phủ nhiều input/edge   │
│     case, không phải qua đọc code review                     │
│  ✅ Nếu nghi ngờ 1 bug production "vô lý" (logic đúng trên   │
│     giấy nhưng runtime sai) sau khi upgrade Rust gần đây →   │
│     thử downgrade 1 version để loại trừ compiler bug trước   │
│     khi tốn thời gian soi business logic                      │
└──────────────────────────────────────────────────────────┘
```

**Liên hệ Bài 35 (Resilience):** đây chính là lý do bài đó nhấn mạnh test coverage và staged rollout — compiler bug tuy hiếm nhưng khi xảy ra thì bypass hoàn toàn mọi code review, vì bug không nằm trong code bạn viết.

---

## 4. Các thay đổi nhỏ khác đáng lưu ý ở 1.97.0

```rust
// Thắt chặt pin!() — chặn deref coercion sai đã tồn tại từ 1.88
// (liên quan trực tiếp Bài 21 — Async Internals & Pin)

// Trước đây (bug từ 1.88): pin!(x) với x: &mut T có thể bị
// coerce sai thành Pin<&mut T> thay vì Pin<&mut &mut T>
let mut x: &mut T = ...;
let p = pin!(x); // Từ 1.97: LUÔN đúng là Pin<&mut &mut T>
                  // (trước đây đôi khi sai thành Pin<&mut T>)

// Nếu series Dioxus/Axum của bạn có code dùng pin!() trực tiếp
// (hiếm khi cần thủ công, thường ẩn sau async/await), đây là
// điểm cần re-check type sau khi upgrade lên 1.97+
```

```
Các thay đổi khác (ít ảnh hưởng PDMS trực tiếp, nên biết để không
bất ngờ khi đọc build log):
- Stabilize bit-manipulation APIs mới cho integer & NonZero types
- Stabilize thêm vài target feature cho kiến trúc ít dùng (div32,
  lam-bh, LoongArch...) — bỏ qua nếu không target các nền tảng này
- Loại bỏ hỗ trợ một số kiến trúc NVIDIA GPU cũ trong target list
```

---

## 5. Tổng kết Bài 47

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                          │
├─────────────────────────────────────────────────────┤
│  ✅ v0 symbol mangling (mặc định từ 1.97) chuẩn hoá   │
│     và encode đầy đủ generic type hơn — nhưng công cụ │
│     debug/profiler cũ có thể FAIL demangle, kiểm tra   │
│     trước khi rollout                                   │
│  ✅ build.warnings trong Cargo.toml thay thế -Dwarnings│
│     rải rác trong CI script — config nằm cạnh code      │
│  ✅ Linker stderr hiện mặc định kể cả build thành công  │
│     — tắt bằng [lints.rust] linker_messages = "allow"   │
│  ✅ Miscompilation (1.97.0, fix ở 1.97.1) nguy hiểm hơn │
│     compiler crash vì im lặng — bài học: pin version rõ│
│     ràng, không auto-upgrade production ngay lập tức    │
│  ✅ pin!() thắt chặt (liên quan Bài 21) — re-check nếu   │
│     có code dùng Pin thủ công                            │
└─────────────────────────────────────────────────────┘
```

**Xem lại:** [[Bai-21-Async-Internals-Pin|Bài 21: Async Internals & Pin]], [[Bai-46-Pointer-Mental-Model|Bài 46: Pointer Mental Model]]
**Liên quan:** [[Performance-Pitfalls-Rust|Performance Pitfalls in Rust]], [[Bai-35-Resilience|Bài 35: Resilience]]
**Bài tiếp theo gợi ý:** Audit lại `rust-toolchain.toml` của các service PDMS dùng Rust — pin version tường minh nếu chưa làm, và kiểm tra APM/crash reporter có hỗ trợ v0 mangling chưa.

---

**Bài tập:**
1. Kiểm tra công cụ profiling/APM đang dùng cho service Rust của PDMS — thử demangle 1 symbol thật với cả hai scheme, xác nhận công cụ hỗ trợ v0
2. Thêm `[build] warnings = "deny"` vào một crate thử nghiệm, chạy `cargo check` và so sánh với cách dùng `-Dwarnings` cũ
3. Đọc lại code dùng `pin!()` thủ công (nếu có) trong phần Dioxus/Axum, xác nhận type sau upgrade lên 1.97+ đúng như kỳ vọng

---
*Tags: #rust #changelog #cargo #llvm #symbol-mangling #pin #zero-to-hero*
