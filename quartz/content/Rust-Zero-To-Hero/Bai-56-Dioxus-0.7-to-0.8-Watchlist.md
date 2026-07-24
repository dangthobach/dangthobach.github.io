---
type: course
domain: languages/rust
status: active
created: 2026-07-24
updated: 2026-07-24
tags: [rust, dioxus, dioxus-0-7, dioxus-0-8, migration, fullstack, wasm]
source_checked: 2026-07-24
---

# Bài 56 — Dioxus 0.7 và 0.8 Watchlist

## Trạng thái

Dioxus stable đang ở 0.7.9; maintainers cho biết dòng 0.7 đi vào giai đoạn cuối và nhánh phát triển chuẩn bị breaking changes cho 0.8. Production nên pin 0.7.x, không theo git main.

## Kiến trúc mới cần hiểu

```mermaid
flowchart TD
    UI["Dioxus component"] --> ST["Stores/reactive state"]
    UI --> SF["Server functions"]
    SF --> AX["Axum integration"]
    UI --> W["Web/WASM"]
    UI --> D["Desktop"]
    UI --> M["Mobile"]
    D --> N["Blitz/Dioxus Native renderer"]
    M --> P["Kotlin/Java/Swift plugins"]
```

## Điểm nổi bật dòng 0.7

- Subsecond hot-patching.
- Native renderer dựa trên WGPU/Blitz.
- Full-stack server functions tích hợp Axum.
- WASM code splitting.
- Stores cho nested reactive state.
- UI primitives.
- Full-stack WebSocket.
- Mobile build/plugin customization.

## Production rule

- Pin CLI và crate cùng version.
- Commit `Cargo.lock` cho application.
- Test `dx bundle`, không chỉ `dx serve`.
- Tách server secret khỏi WASM client.
- Kiểm tra platform-specific code bằng CI matrix.
- Không coi hot patch là production update mechanism.

## 0.8 watchlist

Khi 0.8 stable:

1. Đọc migration guide chính thức.
2. Tạo branch upgrade riêng.
3. Nâng CLI trước trong môi trường cô lập.
4. Compile từng target.
5. Snapshot routes, server-function contracts và asset output.
6. Benchmark bundle/startup.

## Gap cần tránh

- Dùng API từ `main` trong bài stable.
- Trộn Dioxus state với backend global state.
- Đưa secret/config server vào client bundle.
- Giả định Web, Desktop và Mobile có lifecycle giống nhau.
- Dùng một abstraction chung đến mức không xử lý được platform failure.

## Lab

Xây document viewer chạy Web + Desktop:

- Shared domain crate.
- Platform adapter riêng.
- Server function có auth.
- Offline/error state.
- Bundle verification.

## Liên kết

- [[Bai-36-Dioxus-Core|Dioxus Core]]
- [[Bai-37-Dioxus-Advanced|Dioxus Advanced]]
- [[Bai-38-Dioxus-Desktop-Mobile|Desktop và Mobile]]
- [[Bai-42-JS-Interop|JS Interop]]
- [[frontend-concept-map|Frontend Concept Map]]

## Nguồn

- [Dioxus 0.7.9 release](https://github.com/DioxusLabs/dioxus/releases/tag/v0.7.9)
- [Dioxus releases](https://github.com/DioxusLabs/dioxus/releases)

