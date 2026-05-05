---
tags: [rust, dioxus, wasm, frontend, cross-platform]
prerequisites: [Bai-29-Leptos, Bai-9-Async-Tokio]
next: Bai-37-Dioxus-Advanced
---

# Bài 36: Dioxus — Cross-Platform UI Framework (Core)

> **Prerequisite:** Bài 29 (Leptos) — hiểu RSX syntax, component model cơ bản  
> **Mục tiêu:** Nắm vững Dioxus component model, signals, routing, async — nền tảng cho mọi platform target

---

## 🗺️ Bức Tranh Tổng Quan

```
Dioxus — "React của Rust"
  
  Cùng codebase Rust → nhiều target:
  
  ┌─────────────────────────────────────────────────────────────┐
  │                    Dioxus App (Rust)                        │
  │                                                             │
  │  Components → Signals → Hooks → Router → Async             │
  └──────────────────────────┬──────────────────────────────────┘
                             │ build target
          ┌──────────────────┼────────────────────┐
          ▼                  ▼                    ▼
    Web (WASM)         Desktop (native)      Mobile (iOS/Android)
    via WebSys         via Tauri/WRY         via DioxusMobile
    
  TUI (terminal) ← via ratatui backend (experimental)

Khác Leptos:
  Leptos   = SSR-first, fine-grained reactivity, Axum-integrated
  Dioxus   = Cross-platform first, React-like mental model, Virtual DOM
```

---

## ⚡ Leptos vs Dioxus — Chọn Cái Nào?

| Tiêu chí | Leptos | Dioxus |
|---|---|---|
| **Mental model** | SolidJS (fine-grained) | React (Virtual DOM) |
| **SSR** | ✅ First-class (Axum) | ✅ Fullstack mode |
| **Desktop** | ❌ Không | ✅ Native (Tauri) |
| **Mobile** | ❌ Không | ✅ iOS/Android |
| **TUI** | ❌ Không | ✅ Experimental |
| **Bundle size (WASM)** | ~200KB (nhỏ hơn) | ~500KB |
| **Reactivity** | Fine-grained (signal-level) | Virtual DOM diff |
| **Server Functions** | ✅ Built-in `#[server]` | ✅ `#[server_fn]` |
| **Community** | Nhỏ hơn | Lớn hơn, active hơn |
| **Dùng khi** | Web-only, SSR quan trọng | Multi-platform, React background |

**Quyết định nhanh:**
```
Cần SSR + SEO + Web-only → Leptos
Cần Desktop / Mobile / cross-platform → Dioxus
Background React muốn migrate → Dioxus (model tương tự hơn)
```

---

## 📦 Setup

### 1.1 Cài đặt

```bash
# Dioxus CLI
cargo install dioxus-cli

# Thêm WASM target (cho web)
rustup target add wasm32-unknown-unknown

# Tạo project mới
dx new my-app
cd my-app

# Chạy web dev server (hot-reload)
dx serve --platform web

# Chạy desktop
dx serve --platform desktop
```

### 1.2 Cargo.toml

```toml
[package]
name = "my-dioxus-app"
version = "0.1.0"
edition = "2021"

[dependencies]
dioxus = { version = "0.6", features = ["web", "router"] }
dioxus-web = "0.6"

# Logging trong WASM
tracing = "0.1"
tracing-wasm = "0.2"

# HTTP client (WASM-compatible)
reqwest = { version = "0.12", features = ["json"] }

# Serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[features]
default = ["web"]
web = ["dioxus/web"]
desktop = ["dioxus/desktop"]
```

### 1.3 main.rs — Entry Point

```rust
// src/main.rs
use dioxus::prelude::*;

fn main() {
    // Web: mount vào DOM
    // Desktop: tạo native window
    // Mobile: tạo mobile view
    dioxus::launch(App);
}

#[component]
fn App() -> Element {
    rsx! {
        div { class: "container",
            h1 { "Hello từ Dioxus!" }
            p { "Rust chạy trên mọi platform" }
        }
    }
}
```

---

## PHẦN 1 — Components & RSX

### 1.1 Component Cơ Bản

```rust
use dioxus::prelude::*;

// Component = Rust function với #[component] macro
// Trả về Element (không phải impl IntoView như Leptos)
#[component]
fn HelloWorld() -> Element {
    rsx! {
        div {
            h1 { "Xin chào từ Dioxus!" }
            p { "Đây là Rust chạy trong browser" }
        }
    }
}

// Component với props — dùng struct tự động từ #[component]
#[component]
fn UserCard(
    name: String,           // required prop
    email: String,          // required prop
    role: Option<String>,   // optional prop
) -> Element {
    rsx! {
        div { class: "card",
            h2 { "{name}" }
            p { class: "email", "{email}" }
            if let Some(r) = role {
                span { class: "role", "{r}" }
            }
        }
    }
}

// Dùng component
#[component]
fn Parent() -> Element {
    rsx! {
        UserCard {
            name: "Nguyễn Văn A",
            email: "a@vpbank.com",
            role: Some("Senior Engineer".to_string()),
        }
        UserCard {
            name: "Trần Thị B",
            email: "b@vpbank.com",
            // role không truyền → None
        }
    }
}
```

### 1.2 RSX Syntax Chi Tiết

```rust
use dioxus::prelude::*;

#[component]
fn RsxDemo() -> Element {
    let items = vec!["Apple", "Banana", "Cherry"];
    let show_footer = true;

    rsx! {
        // Thuộc tính HTML
        div {
            id: "main",
            class: "container active",
            style: "color: red;",

            // Text — chỉ cần string literal hoặc format
            h1 { "Tiêu đề" }
            p { "Giá trị: {42}" }

            // Conditional rendering
            if show_footer {
                footer { "Footer content" }
            }

            // Loop — for..in trong rsx!
            ul {
                for item in &items {
                    li { key: "{item}", "{item}" }
                }
            }

            // Match expression
            match items.len() {
                0 => rsx! { p { "Trống" } },
                1 => rsx! { p { "Có 1 item" } },
                n => rsx! { p { "Có {n} items" } },
            }

            // Event handler
            button {
                onclick: |_| println!("Clicked!"),
                "Click me"
            }

            // Nested components
            UserCard {
                name: "Test User",
                email: "test@example.com",
            }
        }
    }
}
```

### 1.3 Children & Slots

```rust
use dioxus::prelude::*;

// Component nhận children — như React children prop
#[component]
fn Card(title: String, children: Element) -> Element {
    rsx! {
        div { class: "card",
            div { class: "card-header",
                h3 { "{title}" }
            }
            div { class: "card-body",
                {children}  // render children ở đây
            }
        }
    }
}

// Dùng với children
#[component]
fn Page() -> Element {
    rsx! {
        Card { title: "Danh sách người dùng",
            p { "Đây là content bên trong card" }
            button { "Action" }
        }
    }
}
```

---

## PHẦN 2 — Signals & State (Reactivity)

### 2.1 use_signal — Local State

```rust
use dioxus::prelude::*;

// Dioxus 0.6 dùng Signals thay vì useState hook cũ
// Signal = reactive value, tự động re-render khi thay đổi

#[component]
fn Counter() -> Element {
    // use_signal → tương đương useState trong React
    // Khác Leptos signal(0): dùng use_signal(|| 0)
    let mut count = use_signal(|| 0i32);

    rsx! {
        div {
            p { "Count: {count}" }

            button {
                onclick: move |_| count += 1,
                "Tăng"
            }
            button {
                onclick: move |_| count -= 1,
                "Giảm"
            }
            button {
                onclick: move |_| count.set(0),
                "Reset"
            }
        }
    }
}
```

### 2.2 Derived State — use_memo

```rust
use dioxus::prelude::*;

#[component]
fn CartPage() -> Element {
    let mut items = use_signal(|| vec![
        ("Sản phẩm A", 100_000u32, 2u32),
        ("Sản phẩm B", 200_000u32, 1u32),
    ]);

    // use_memo = computed value, chỉ tính lại khi dependency thay đổi
    // Tương đương useMemo trong React
    let total = use_memo(move || {
        items.read().iter()
            .map(|(_, price, qty)| price * qty)
            .sum::<u32>()
    });

    let item_count = use_memo(move || {
        items.read().iter().map(|(_, _, qty)| qty).sum::<u32>()
    });

    rsx! {
        div {
            h2 { "Giỏ hàng ({item_count} sản phẩm)" }
            ul {
                for (name, price, qty) in items.read().iter() {
                    li { "{name}: {price:,} × {qty} = {price * qty:,} VNĐ" }
                }
            }
            p { class: "total", "Tổng: {total:,} VNĐ" }
        }
    }
}
```

### 2.3 use_effect — Side Effects

```rust
use dioxus::prelude::*;

#[component]
fn WithEffect() -> Element {
    let mut count = use_signal(|| 0i32);
    let mut log = use_signal(|| Vec::<String>::new());

    // use_effect chạy khi signal dependencies thay đổi
    // Dioxus tự động track dependencies (đọc signal trong closure)
    use_effect(move || {
        let current = count();
        log.write().push(format!("Count changed to: {current}"));
    });

    rsx! {
        div {
            p { "Count: {count}" }
            button { onclick: move |_| count += 1, "Tăng" }
            ul {
                for entry in log.read().iter() {
                    li { "{entry}" }
                }
            }
        }
    }
}
```

### 2.4 Global State — Context

```rust
use dioxus::prelude::*;
use std::rc::Rc;

// Global app state — chia sẻ giữa các component
#[derive(Clone, Debug)]
struct AppState {
    user: Option<String>,
    theme: String,
}

// Provider component — inject state vào context tree
#[component]
fn AppProvider() -> Element {
    // use_context_provider đặt value vào context
    let state = use_context_provider(|| Signal::new(AppState {
        user: None,
        theme: "light".to_string(),
    }));

    rsx! {
        div { class: "app theme-{state.read().theme}",
            Header {}
            MainContent {}
        }
    }
}

// Consumer — lấy state từ context
#[component]
fn Header() -> Element {
    // use_context lấy Signal đã inject
    let state = use_context::<Signal<AppState>>();

    rsx! {
        header {
            if let Some(user) = &state.read().user {
                span { "Xin chào, {user}!" }
            } else {
                button { "Đăng nhập" }
            }
        }
    }
}

#[component]
fn MainContent() -> Element {
    let mut state = use_context::<Signal<AppState>>();

    rsx! {
        main {
            button {
                onclick: move |_| {
                    let new_theme = if state.read().theme == "light" {
                        "dark"
                    } else {
                        "light"
                    };
                    state.write().theme = new_theme.to_string();
                },
                "Toggle Theme"
            }
        }
    }
}
```

---

## PHẦN 3 — Hooks

### 3.1 Custom Hook

```rust
use dioxus::prelude::*;

// Custom hook — Rust function trả về Signal hoặc derived value
// Tương đương custom hook trong React
fn use_counter(initial: i32, step: i32) -> (Signal<i32>, impl FnMut(), impl FnMut()) {
    let mut count = use_signal(move || initial);

    let increment = move || count += step;
    let decrement = move || count -= step;

    (count, increment, decrement)
}

fn use_toggle(initial: bool) -> (ReadOnlySignal<bool>, impl FnMut()) {
    let mut value = use_signal(move || initial);
    let toggle = move || value.toggle();
    (value.into(), toggle)
}

// Dùng custom hook
#[component]
fn StepCounter() -> Element {
    let (count, mut inc, mut dec) = use_counter(0, 5);
    let (visible, mut toggle) = use_toggle(true);

    rsx! {
        div {
            button { onclick: move |_| toggle(), "Toggle" }
            if visible() {
                div {
                    p { "Count: {count}" }
                    button { onclick: move |_| inc(), "+5" }
                    button { onclick: move |_| dec(), "-5" }
                }
            }
        }
    }
}
```

### 3.2 use_future — Async trong Component

```rust
use dioxus::prelude::*;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
struct User {
    id: u32,
    name: String,
    email: String,
}

// use_future: chạy async một lần khi component mount
// Khác use_resource (reactive): use_future không re-run khi signal thay đổi
#[component]
fn UserProfile(user_id: u32) -> Element {
    let user_future = use_future(move || async move {
        reqwest::get(format!("https://api.example.com/users/{user_id}"))
            .await?
            .json::<User>()
            .await
    });

    match &*user_future.read_unchecked() {
        Some(Ok(user)) => rsx! {
            div { class: "profile",
                h2 { "{user.name}" }
                p { "{user.email}" }
            }
        },
        Some(Err(e)) => rsx! {
            div { class: "error", "Lỗi: {e}" }
        },
        None => rsx! {
            div { class: "loading", "Đang tải..." }
        },
    }
}
```

### 3.3 use_resource — Reactive Async

```rust
use dioxus::prelude::*;

// use_resource: re-run khi dependencies (signal) thay đổi
// Tương đương useQuery trong TanStack Query (React)
#[component]
fn SearchPage() -> Element {
    let mut query = use_signal(|| String::new());

    // Re-fetch tự động khi query signal thay đổi
    let results = use_resource(move || async move {
        let q = query.read().clone();
        if q.is_empty() {
            return Ok(vec![]);
        }
        // Debounce nhỏ
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        reqwest::get(format!("https://api.example.com/search?q={q}"))
            .await?
            .json::<Vec<String>>()
            .await
    });

    rsx! {
        div {
            input {
                r#type: "text",
                placeholder: "Tìm kiếm...",
                oninput: move |e| query.set(e.value()),
            }
            match &*results.read_unchecked() {
                Some(Ok(items)) => rsx! {
                    ul {
                        for item in items {
                            li { key: "{item}", "{item}" }
                        }
                    }
                },
                Some(Err(e)) => rsx! { p { class: "error", "{e}" } },
                None => rsx! { p { "Đang tìm..." } },
            }
        }
    }
}
```

---

## PHẦN 4 — Event Handling

### 4.1 Các Event Cơ Bản

```rust
use dioxus::prelude::*;

#[component]
fn EventDemo() -> Element {
    let mut text = use_signal(|| String::new());
    let mut selected = use_signal(|| String::new());
    let mut checked = use_signal(|| false);

    rsx! {
        div {
            // onClick
            button {
                onclick: move |event| {
                    // event: Event<MouseData>
                    println!("Clicked at: {:?}", event.data.coordinates());
                },
                "Click me"
            }

            // onInput — real-time text input
            input {
                r#type: "text",
                value: "{text}",
                oninput: move |e| text.set(e.value()),
                placeholder: "Nhập text...",
            }
            p { "Bạn nhập: {text}" }

            // onChange — select
            select {
                onchange: move |e| selected.set(e.value()),
                option { value: "vn", "Việt Nam" }
                option { value: "us", "United States" }
                option { value: "jp", "Japan" }
            }
            p { "Đã chọn: {selected}" }

            // Checkbox
            input {
                r#type: "checkbox",
                checked: "{checked}",
                onchange: move |e| checked.set(e.checked()),
            }
            label { "Đồng ý điều khoản: {checked}" }

            // onKeyDown
            input {
                r#type: "text",
                onkeydown: move |e| {
                    if e.key() == Key::Enter {
                        println!("Enter pressed!");
                    }
                },
                placeholder: "Nhấn Enter...",
            }
        }
    }
}
```

### 4.2 Form Handling

```rust
use dioxus::prelude::*;

#[derive(Debug, Clone, Default)]
struct LoginForm {
    username: String,
    password: String,
}

#[component]
fn LoginPage() -> Element {
    let mut form = use_signal(LoginForm::default);
    let mut error = use_signal(|| Option::<String>::None);
    let mut loading = use_signal(|| false);

    let handle_submit = move |_| async move {
        let data = form.read().clone();

        if data.username.is_empty() || data.password.is_empty() {
            error.set(Some("Vui lòng điền đầy đủ thông tin".to_string()));
            return;
        }

        loading.set(true);
        error.set(None);

        // Gọi API
        let result = reqwest::Client::new()
            .post("https://api.example.com/login")
            .json(&serde_json::json!({
                "username": data.username,
                "password": data.password,
            }))
            .send()
            .await;

        loading.set(false);

        match result {
            Ok(resp) if resp.status().is_success() => {
                println!("Đăng nhập thành công!");
            }
            Ok(resp) => {
                error.set(Some(format!("Lỗi: {}", resp.status())));
            }
            Err(e) => {
                error.set(Some(format!("Network error: {e}")));
            }
        }
    };

    rsx! {
        form {
            onsubmit: handle_submit,

            if let Some(err) = error.read().as_ref() {
                div { class: "alert alert-error", "{err}" }
            }

            div { class: "field",
                label { r#for: "username", "Tên đăng nhập" }
                input {
                    id: "username",
                    r#type: "text",
                    value: "{form.read().username}",
                    oninput: move |e| form.write().username = e.value(),
                }
            }
            div { class: "field",
                label { r#for: "password", "Mật khẩu" }
                input {
                    id: "password",
                    r#type: "password",
                    value: "{form.read().password}",
                    oninput: move |e| form.write().password = e.value(),
                }
            }
            button {
                r#type: "submit",
                disabled: "{loading}",
                if loading() { "Đang đăng nhập..." } else { "Đăng nhập" }
            }
        }
    }
}
```

---

## PHẦN 5 — Router

### 5.1 Router Setup

```rust
use dioxus::prelude::*;
use dioxus_router::prelude::*;

// Routes định nghĩa bằng enum — type-safe routing
// Tương đương React Router v6 với typed routes
#[derive(Clone, Routable, Debug, PartialEq)]
enum Route {
    #[layout(MainLayout)]   // wrapper layout
        #[route("/")]
        Home {},

        #[route("/users")]
        UserList {},

        #[route("/users/:id")]
        UserDetail { id: u32 },

        #[route("/settings")]
        Settings {},

    #[end_layout]

    // Route không có layout
    #[route("/login")]
    Login {},

    // 404
    #[route("/:..segments")]
    NotFound { segments: Vec<String> },
}

fn main() {
    dioxus::launch(App);
}

#[component]
fn App() -> Element {
    rsx! {
        Router::<Route> {}
    }
}

// Layout component — wrap các route con
#[component]
fn MainLayout() -> Element {
    rsx! {
        div { class: "app",
            nav {
                Link { to: Route::Home {}, "Trang chủ" }
                Link { to: Route::UserList {}, "Người dùng" }
                Link { to: Route::Settings {}, "Cài đặt" }
            }
            main {
                // Outlet render route hiện tại
                Outlet::<Route> {}
            }
        }
    }
}
```

### 5.2 Route Components

```rust
use dioxus::prelude::*;
use dioxus_router::prelude::*;

#[component]
fn Home() -> Element {
    rsx! {
        div {
            h1 { "Trang chủ" }
            p { "Chào mừng đến với PDMS" }
        }
    }
}

#[component]
fn UserList() -> Element {
    let users = use_resource(|| async {
        reqwest::get("https://api.example.com/users")
            .await?
            .json::<Vec<serde_json::Value>>()
            .await
    });

    let nav = use_navigator();

    rsx! {
        div {
            h1 { "Danh sách người dùng" }
            match &*users.read_unchecked() {
                Some(Ok(list)) => rsx! {
                    ul {
                        for user in list {
                            li {
                                onclick: {
                                    let id = user["id"].as_u64().unwrap_or(0) as u32;
                                    move |_| nav.push(Route::UserDetail { id })
                                },
                                "{user[\"name\"]}"
                            }
                        }
                    }
                },
                Some(Err(e)) => rsx! { p { "Lỗi: {e}" } },
                None => rsx! { p { "Đang tải..." } },
            }
        }
    }
}

// Route với params
#[component]
fn UserDetail(id: u32) -> Element {
    // id được extract tự động từ URL /users/:id
    let user = use_resource(move || async move {
        reqwest::get(format!("https://api.example.com/users/{id}"))
            .await?
            .json::<serde_json::Value>()
            .await
    });

    rsx! {
        div {
            match &*user.read_unchecked() {
                Some(Ok(u)) => rsx! {
                    h1 { "{u[\"name\"]}" }
                    p { "Email: {u[\"email\"]}" }
                    Link { to: Route::UserList {}, "← Quay lại" }
                },
                Some(Err(e)) => rsx! { p { "Lỗi: {e}" } },
                None => rsx! { p { "Đang tải..." } },
            }
        }
    }
}

#[component]
fn NotFound(segments: Vec<String>) -> Element {
    rsx! {
        div {
            h1 { "404 — Không tìm thấy trang" }
            p { "Đường dẫn: /{segments.join(\"/\")}" }
            Link { to: Route::Home {}, "Về trang chủ" }
        }
    }
}
```

### 5.3 Navigation Programmatic

```rust
use dioxus::prelude::*;
use dioxus_router::prelude::*;

#[component]
fn LoginPage() -> Element {
    let nav = use_navigator();
    let mut username = use_signal(|| String::new());

    let handle_login = move |_| {
        let u = username.read().clone();
        async move {
            // Sau khi login thành công
            if !u.is_empty() {
                // push → thêm vào history (có thể back)
                nav.push(Route::Home {});

                // replace → thay thế history (không thể back)
                // nav.replace(Route::Home {});

                // go_back, go_forward
                // nav.go_back();
            }
        }
    };

    rsx! {
        div {
            input {
                oninput: move |e| username.set(e.value()),
                placeholder: "Username",
            }
            button { onclick: handle_login, "Login" }
        }
    }
}
```

---

## PHẦN 6 — Server Functions (Fullstack)

### 6.1 Server Functions — Giao tiếp Client/Server

```rust
// Dioxus Fullstack: cùng codebase, compile conditionally
// server_fn chạy trên server, gọi từ client như function call bình thường

use dioxus::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Document {
    id: i64,
    title: String,
    status: String,
}

// #[server] macro — compile thành:
// - Server: actual implementation (có thể dùng DB, file system...)
// - Client: HTTP call đến server endpoint
#[server(GetDocuments)]
async fn get_documents(page: u32, page_size: u32) -> Result<Vec<Document>, ServerFnError> {
    // Code này CHỈ chạy trên server
    // Import server-only dependencies ở đây
    use sqlx::PgPool;

    let pool = server_context().extract::<PgPool>().await
        .map_err(|e| ServerFnError::ServerError(e.to_string()))?;

    let offset = (page * page_size) as i64;
    let docs = sqlx::query_as!(
        Document,
        "SELECT id, title, status FROM documents ORDER BY created_at DESC LIMIT $1 OFFSET $2",
        page_size as i64,
        offset,
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| ServerFnError::ServerError(e.to_string()))?;

    Ok(docs)
}

#[server(CreateDocument)]
async fn create_document(title: String) -> Result<Document, ServerFnError> {
    use sqlx::PgPool;

    let pool = server_context().extract::<PgPool>().await
        .map_err(|e| ServerFnError::ServerError(e.to_string()))?;

    let doc = sqlx::query_as!(
        Document,
        "INSERT INTO documents (title, status) VALUES ($1, 'DRAFT') RETURNING id, title, status",
        title
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| ServerFnError::ServerError(e.to_string()))?;

    Ok(doc)
}

// Client component dùng server functions
#[component]
fn DocumentList() -> Element {
    let mut page = use_signal(|| 0u32);
    let mut refresh = use_signal(|| 0u32);  // trigger để refetch

    let docs = use_resource(move || async move {
        let _ = refresh();  // dependency: refetch khi refresh thay đổi
        get_documents(page(), 20).await
    });

    let mut new_title = use_signal(|| String::new());

    let handle_create = move |_| async move {
        let title = new_title.read().clone();
        if title.is_empty() { return; }

        match create_document(title).await {
            Ok(_) => {
                new_title.set(String::new());
                refresh += 1;  // trigger refetch
            }
            Err(e) => eprintln!("Lỗi: {e}"),
        }
    };

    rsx! {
        div {
            // Form tạo mới
            div { class: "create-form",
                input {
                    value: "{new_title}",
                    oninput: move |e| new_title.set(e.value()),
                    placeholder: "Tiêu đề tài liệu...",
                }
                button { onclick: handle_create, "Tạo mới" }
            }

            // Danh sách
            match &*docs.read_unchecked() {
                Some(Ok(list)) => rsx! {
                    div { class: "doc-list",
                        for doc in list {
                            div { class: "doc-item",
                                key: "{doc.id}",
                                h3 { "{doc.title}" }
                                span { class: "status", "{doc.status}" }
                            }
                        }
                    }
                },
                Some(Err(e)) => rsx! { p { class: "error", "Lỗi: {e}" } },
                None => rsx! { p { "Đang tải..." } },
            }

            // Pagination
            div { class: "pagination",
                button {
                    disabled: "{page() == 0}",
                    onclick: move |_| if page() > 0 { page -= 1; },
                    "← Trước"
                }
                span { "Trang {page() + 1}" }
                button {
                    onclick: move |_| page += 1,
                    "Tiếp →"
                }
            }
        }
    }
}
```

---

## 🎯 So Sánh Dioxus vs React (Nhanh)

| React | Dioxus | Ghi chú |
|---|---|---|
| `useState(0)` | `use_signal(\|\| 0)` | Signal thay useState |
| `useMemo(fn, deps)` | `use_memo(move \|\| fn)` | Auto-track deps |
| `useEffect(fn, deps)` | `use_effect(move \|\| fn)` | Auto-track deps |
| `useContext(Ctx)` | `use_context::<T>()` | Type-safe context |
| `useRef(null)` | `use_signal(\|\| None)` | Hoặc `use_ref` |
| `<Component />` | `Component {}` | RSX syntax |
| `{variable}` | `{variable}` | Giống nhau |
| `className` | `class` | HTML attribute |
| `onClick={fn}` | `onclick: fn` | camelCase → lowercase |
| `children` | `children: Element` | Typed children |

---

## 📝 Exercises

1. **Component Tree**: Tạo layout 3-panel (sidebar + content + detail) với Dioxus. Dùng context để share selected item state giữa panels.

2. **Reactive Search**: Input tìm kiếm + `use_resource` để debounce và fetch kết quả. Hiển thị loading/error/empty states.

3. **Form với validation**: Form CRUD hoàn chỉnh với client-side validation (required, email format, min length). Hiển thị error message per field.

4. **Router với auth guard**: Setup router với protected routes. Nếu chưa đăng nhập (check context) → redirect về `/login`.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-29-Leptos|Bài 29: Leptos]] — so sánh trực tiếp
- [[Rust-Zero-To-Hero/Bai-37-Dioxus-Advanced|Bài 37: Dioxus Advanced]] → tiếp theo
- [[Rust-Zero-To-Hero/Bai-38-Dioxus-Desktop-Mobile|Bài 38: Dioxus Desktop & Mobile]] → cross-platform
