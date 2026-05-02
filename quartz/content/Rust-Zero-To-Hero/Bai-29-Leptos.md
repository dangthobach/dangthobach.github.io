# Bài 29: Leptos — Fullstack Rust Web (SSR + CSR + Hydration)

> **Prerequisite:** Bài 24 (Axum Advanced) + Bài 26 (SQLx Advanced)  
> **Mục tiêu:** Build fullstack web app bằng Rust thuần — từ Component, Signals, Server Functions đến SSR+Hydration. Không cần JavaScript!

---

## 🗺️ Bức Tranh Tổng Quan

```
Leptos — Fullstack Rust:

  ┌─────────────────────────────────────────────────────────────┐
  │                     Leptos App                             │
  │                                                             │
  │  ┌─────────────────┐          ┌──────────────────────────┐ │
  │  │   Client (WASM) │          │    Server (Axum)         │ │
  │  │                 │          │                          │ │
  │  │  #[component]   │◀─────────│  #[server] fn            │ │
  │  │  fn UserList()  │ HTTP/WS  │  → DB query              │ │
  │  │                 │          │  → Business logic        │ │
  │  │  Signal<T>      │          │  → Auth check            │ │
  │  │  Resource<T>    │─────────▶│                          │ │
  │  └─────────────────┘          └──────────────────────────┘ │
  └─────────────────────────────────────────────────────────────┘

3 Rendering Modes:
  ┌──────────────────┬─────────────────┬──────────────────────┐
  │ CSR              │ SSR             │ SSR + Hydration      │
  │ (Client-Side)    │ (Server-Side)   │ (Full-stack)         │
  ├──────────────────┼─────────────────┼──────────────────────┤
  │ WASM-only        │ HTML từ server  │ HTML từ server       │
  │ SPA style        │ No JS           │ + WASM hydrate       │
  │ React analog     │ MPA style       │ Next.js analog       │
  │ Slow TTFB        │ Fast TTFB       │ Fast TTFB + reactive │
  └──────────────────┴─────────────────┴──────────────────────┘

Java analog:
  CSR = React/Angular standalone
  SSR = Thymeleaf / JSF
  SSR + Hydration = React + Next.js (Server Components)

Leptos Reactivity so với React:
  React:   Re-render toàn bộ component tree khi state thay đổi
  Leptos:  Fine-grained reactivity — chỉ update exact DOM node thay đổi
           (giống SolidJS — không có Virtual DOM!)
```

---

## PHẦN 1 — Setup

### 1.1 Tool Installation

```bash
# Install Rust WASM target
rustup target add wasm32-unknown-unknown

# Install cargo-leptos (build tool)
cargo install cargo-leptos

# Install leptosfmt (optional, formatter)
cargo install leptosfmt

# Tạo project từ template
cargo leptos new --git leptos-rs/start-axum
cd my-app
```

### 1.2 Project Structure

```
my-leptos-app/
├── Cargo.toml              ← workspace
├── app/                    ← shared code (server + client)
│   ├── src/
│   │   ├── lib.rs
│   │   ├── app.rs          ← App component, Router
│   │   ├── components/
│   │   │   ├── nav.rs
│   │   │   └── footer.rs
│   │   ├── pages/
│   │   │   ├── home.rs
│   │   │   ├── users.rs
│   │   │   └── documents.rs
│   │   └── server/         ← server-only code (DB, auth)
│   │       ├── auth.rs
│   │       └── db.rs
├── server/                 ← Axum server binary
│   └── src/
│       └── main.rs
└── style/
    └── main.scss
```

### 1.3 Cargo.toml

```toml
# Cargo.toml (workspace root)
[workspace]
members = ["app", "server"]

# app/Cargo.toml
[dependencies]
leptos = { version = "0.7", features = ["csr", "ssr"] }
leptos_axum = { version = "0.7", optional = true }
leptos_router = "0.7"
server_fn = "0.7"
axum = { version = "0.7", optional = true }
tokio = { version = "1", features = ["full"], optional = true }
sqlx = { version = "0.7", features = ["postgres", "runtime-tokio"], optional = true }
serde = { version = "1", features = ["derive"] }
thiserror = "1"

[features]
default = []
hydrate = ["leptos/hydrate"]    # client WASM build
ssr = [                          # server build
    "dep:leptos_axum",
    "dep:axum",
    "dep:tokio",
    "dep:sqlx",
    "leptos/ssr",
]
```

---

## PHẦN 2 — Components & RSX

### 2.1 Component Cơ Bản

```rust
// Đây là Rust function, không phải macro magic
// RSX (view! macro) = JSX nhưng trong Rust

use leptos::prelude::*;

// Component đơn giản không có props
#[component]
fn HelloWorld() -> impl IntoView {
    view! {
        <div class="hello">
            <h1>"Xin chào từ Leptos!"</h1>
            <p>"Đây là Rust chạy trong browser"</p>
        </div>
    }
}

// Component với props — các tham số là props
#[component]
fn UserCard(
    #[prop(into)] name: String,       // into: nhận &str, String, etc.
    #[prop(into)] email: String,
    #[prop(default = "user".to_string())] role: String,  // default value
    #[prop(optional)] avatar_url: Option<String>,         // optional prop
) -> impl IntoView {
    view! {
        <div class="card user-card">
            {avatar_url.map(|url| view! {
                <img src=url alt="Avatar" class="avatar"/>
            })}
            <div class="card-body">
                <h3 class="card-title">{name}</h3>
                <p class="card-email">{email}</p>
                <span class=format!("badge badge-{}", role)>{role}</span>
            </div>
        </div>
    }
}

// Children prop — composable components
#[component]
fn Card(
    #[prop(into)] title: String,
    children: Children,                // tương đương React children
) -> impl IntoView {
    view! {
        <div class="card">
            <div class="card-header">
                <h2>{title}</h2>
            </div>
            <div class="card-body">
                {children()}
            </div>
        </div>
    }
}

// Dùng
#[component]
fn App() -> impl IntoView {
    view! {
        <Card title="My Users">
            <UserCard name="Bach" email="bach@vpbank.com" role="admin"/>
            <UserCard name="Minh" email="minh@vpbank.com"/>
        </Card>
    }
}
```

### 2.2 RSX Syntax Chi Tiết

```rust
use leptos::prelude::*;

#[component]
fn RsxExamples() -> impl IntoView {
    let items = vec!["Apple", "Banana", "Cherry"];
    let show_list = true;

    view! {
        // Attributes
        <div
            class="container"
            id="main"
            style="color: red"
        >
            // Text strings trong quotes
            "Static text here"

            // Rust expressions trong {}
            {2 + 2}
            {format!("Hello {}", "world")}

            // Conditional rendering
            {if show_list {
                view! { <p>"List is shown"</p> }.into_any()
            } else {
                view! { <p>"List is hidden"</p> }.into_any()
            }}

            // Show/hide (không unmount)
            <p class:hidden=(!show_list)>"Always in DOM"</p>

            // List rendering
            <ul>
                {items.iter().map(|item| view! {
                    <li>{*item}</li>
                }).collect_view()}
            </ul>

            // Optional rendering
            {show_list.then(|| view! { <p>"Optional"</p> })}

            // Dynamic class binding
            <button
                class="btn"
                class:btn-primary=show_list
                class:btn-secondary=(!show_list)
            >
                "Click me"
            </button>

            // Event handlers
            <button on:click=|_| { log::info!("clicked!"); }>
                "Log Click"
            </button>

            // Component
            <UserCard name="Bach" email="bach@vpbank.com"/>
        </div>
    }
}
```

---

## PHẦN 3 — Signals & Reactivity

### 3.1 Signal — State Management

```rust
// Signal = reactive state — giống useState trong React
// NHƯNG: fine-grained — chỉ re-render exact DOM nodes đọc signal này

use leptos::prelude::*;

#[component]
fn Counter() -> impl IntoView {
    // signal(0) → (ReadSignal<i32>, WriteSignal<i32>)
    let (count, set_count) = signal(0i32);

    view! {
        <div>
            // Đọc signal trong view — Leptos track dependency tự động
            <p>"Count: " {count}</p>

            // Event handlers cập nhật signal
            <button on:click=move |_| set_count.update(|n| *n += 1)>
                "+"
            </button>
            <button on:click=move |_| set_count.update(|n| *n -= 1)>
                "-"
            </button>
            <button on:click=move |_| set_count.set(0)>
                "Reset"
            </button>
        </div>
    }
}

// RwSignal — read + write trong một (tiện hơn khi pass around)
#[component]
fn RwExample() -> impl IntoView {
    let count = RwSignal::new(0i32);

    view! {
        <p>{count}</p>
        <button on:click=move |_| count.update(|n| *n += 1)>"+"</button>
    }
}
```

### 3.2 Derived Signals — Computed Values

```rust
#[component]
fn ShoppingCart() -> impl IntoView {
    let (items, set_items) = signal(vec![
        ("Apple", 2.0f64, 3u32),
        ("Banana", 1.5f64, 5u32),
    ]);

    // Derived — tính toán từ signal khác, tự động re-compute khi dependency thay đổi
    // Giống React useMemo, nhưng automatic dependency tracking
    let total = Memo::new(move |_| {
        items.get().iter()
            .map(|(_, price, qty)| price * (*qty as f64))
            .sum::<f64>()
    });

    let item_count = Memo::new(move |_| {
        items.get().iter().map(|(_, _, qty)| qty).sum::<u32>()
    });

    view! {
        <div>
            <p>"Items: " {item_count}</p>
            <p>"Total: $" {move || format!("{:.2}", total.get())}</p>
        </div>
    }
}
```

### 3.3 Effect — Side Effects

```rust
use leptos::prelude::*;

#[component]
fn WithEffect() -> impl IntoView {
    let (count, set_count) = signal(0i32);

    // Effect chạy khi dependency thay đổi — giống React useEffect
    // Nhưng dependency tracking tự động (không cần [count])
    Effect::new(move |_| {
        let current = count.get();
        // Log mỗi khi count thay đổi
        if current > 0 {
            log::info!("Count changed to: {}", current);
        }
        // Return cleanup function (optional)
        // move || { /* cleanup */ }
    });

    // Effect với local storage persistence
    Effect::new(move |_| {
        let value = count.get();
        if let Some(window) = web_sys::window() {
            if let Ok(Some(storage)) = window.local_storage() {
                storage.set_item("count", &value.to_string()).ok();
            }
        }
    });

    view! {
        <div>
            <p>{count}</p>
            <button on:click=move |_| set_count.update(|n| *n += 1)>"+"</button>
        </div>
    }
}
```

---

## PHẦN 4 — Server Functions ⭐ Killer Feature

### 4.1 Tại sao Server Functions?

```
Vấn đề truyền thống:
  Frontend (React) → fetch → API endpoint (Express/Spring) → DB

Với Leptos #[server]:
  Frontend (Leptos component) → "function call" → Server fn → DB
  
  Compiler tự động:
  ├── Server: implement as Axum handler
  └── Client: compile sang HTTP fetch call (type-safe!)
  
  Lợi ích:
  - Không cần viết API endpoint riêng
  - Type-safe end-to-end (compiler check cả input lẫn output)
  - Serialize/deserialize tự động
  - Error types được share giữa client và server
```

### 4.2 Basic Server Functions

```rust
// Đặt trong file được compile cho cả server lẫn client (app/src/pages/users.rs)

use leptos::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub email: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateUserInput {
    pub name: String,
    pub email: String,
}

// #[server] — compile-time magic:
//   ┌── Khi build server: code này compile thành Axum handler
//   └── Khi build client (WASM): compile thành fetch() call
#[server(GetUsers, "/api")]
pub async fn get_users() -> Result<Vec<User>, ServerFnError> {
    // Code này CHỈ chạy trên server
    // Truy cập DB, context, auth...
    
    // Lấy DB pool từ Leptos context (inject bởi Axum)
    let pool = use_context::<sqlx::PgPool>()
        .ok_or_else(|| ServerFnError::new("DB not found in context"))?;

    let users = sqlx::query_as!(User,
        "SELECT id, name, email, role::text as role FROM users ORDER BY created_at DESC LIMIT 50"
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| ServerFnError::new(format!("DB error: {}", e)))?;

    Ok(users)
}

#[server(GetUser, "/api")]
pub async fn get_user(id: i64) -> Result<User, ServerFnError> {
    let pool = use_context::<sqlx::PgPool>().ok_or_else(|| ServerFnError::new("no db"))?;

    sqlx::query_as!(User,
        "SELECT id, name, email, role::text as role FROM users WHERE id = $1",
        id
    )
    .fetch_optional(&pool)
    .await
    .map_err(|e| ServerFnError::new(e.to_string()))?
    .ok_or_else(|| ServerFnError::new(format!("User {} not found", id)))
}

#[server(CreateUser, "/api")]
pub async fn create_user(input: CreateUserInput) -> Result<User, ServerFnError> {
    // Server-side validation
    if input.name.trim().is_empty() {
        return Err(ServerFnError::new("Name cannot be empty"));
    }
    if !input.email.contains('@') {
        return Err(ServerFnError::new("Invalid email"));
    }

    let pool = use_context::<sqlx::PgPool>().ok_or_else(|| ServerFnError::new("no db"))?;

    sqlx::query_as!(User,
        "INSERT INTO users (name, email, role, created_at)
         VALUES ($1, $2, 'user', NOW())
         RETURNING id, name, email, role::text as role",
        input.name, input.email
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") {
            ServerFnError::new("Email already registered")
        } else {
            ServerFnError::new(e.to_string())
        }
    })
}

#[server(DeleteUser, "/api")]
pub async fn delete_user(id: i64) -> Result<(), ServerFnError> {
    let pool = use_context::<sqlx::PgPool>().ok_or_else(|| ServerFnError::new("no db"))?;

    sqlx::query!("DELETE FROM users WHERE id = $1", id)
        .execute(&pool)
        .await
        .map_err(|e| ServerFnError::new(e.to_string()))?;

    Ok(())
}
```

---

## PHẦN 5 — Resource & Async Data Fetching

### 5.1 Resource — Async Data

```rust
use leptos::prelude::*;

#[component]
fn UserList() -> impl IntoView {
    // Resource = async data fetcher
    // Argument 1: reactive source (khi thay đổi → refetch)
    // Argument 2: async fetcher function
    let users = Resource::new(
        || (),                          // source: () = fetch once on mount
        |_| async { get_users().await } // fetcher: gọi server function
    );

    view! {
        // Suspense: hiện fallback trong khi đang fetch
        <Suspense fallback=move || view! { <div class="loading">"⏳ Loading users..."</div> }>
            // ErrorBoundary: catch errors từ server functions
            <ErrorBoundary fallback=|errors| view! {
                <div class="error">
                    "Error: "
                    {move || errors.get()
                        .into_iter()
                        .map(|(_, e)| e.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")}
                </div>
            }>
                // Đọc Resource value
                {move || users.get().map(|result| {
                    result.map(|user_list| {
                        if user_list.is_empty() {
                            view! { <p class="empty">"No users found"</p> }.into_any()
                        } else {
                            view! {
                                <div class="user-grid">
                                    {user_list.into_iter()
                                        .map(|user| view! { <UserCard user=user/> })
                                        .collect_view()}
                                </div>
                            }.into_any()
                        }
                    })
                })}
            </ErrorBoundary>
        </Suspense>
    }
}

// Resource với reactive source (refetch khi source thay đổi)
#[component]
fn UserDetail() -> impl IntoView {
    // Đọc route params
    let params = leptos_router::hooks::use_params_map();
    let id = move || params.with(|p| {
        p.get("id").and_then(|id| id.parse::<i64>().ok())
    });

    // Refetch mỗi khi id thay đổi
    let user = Resource::new(id, |id| async move {
        match id {
            Some(id) => get_user(id).await.ok(),
            None => None,
        }
    });

    view! {
        <Suspense fallback=move || view! { <p>"Loading..."</p> }>
            {move || user.get().flatten().map(|u| view! {
                <div class="user-detail">
                    <h1>{u.name}</h1>
                    <p>{u.email}</p>
                    <span class="badge">{u.role}</span>
                </div>
            })}
        </Suspense>
    }
}
```

---

## PHẦN 6 — Actions — Mutations

### 6.1 Action — Server Function Mutations

```rust
use leptos::prelude::*;

#[component]
fn CreateUserForm() -> impl IntoView {
    let (name, set_name) = signal(String::new());
    let (email, set_email) = signal(String::new());

    // Action = async mutation với loading/error state management
    let create_action = Action::new(|input: &CreateUserInput| {
        let input = input.clone();
        async move { create_user(input).await }
    });

    // Reactive state từ action
    let is_pending = create_action.pending();
    let last_result = create_action.value();

    view! {
        <form
            on:submit=move |ev| {
                ev.prevent_default();
                create_action.dispatch(CreateUserInput {
                    name: name.get(),
                    email: email.get(),
                });
            }
        >
            <div class="form-group">
                <label for="name">"Full Name"</label>
                <input
                    type="text"
                    id="name"
                    class="form-control"
                    placeholder="Nguyen Van Bach"
                    prop:value=name
                    on:input=move |ev| set_name.set(event_target_value(&ev))
                />
            </div>

            <div class="form-group">
                <label for="email">"Email"</label>
                <input
                    type="email"
                    id="email"
                    class="form-control"
                    placeholder="bach@vpbank.com"
                    prop:value=email
                    on:input=move |ev| set_email.set(event_target_value(&ev))
                />
            </div>

            // Submit button với loading state
            <button
                type="submit"
                class="btn btn-primary"
                disabled=is_pending
            >
                {move || if is_pending.get() { "Creating..." } else { "Create User" }}
            </button>

            // Success / Error feedback
            {move || last_result.get().map(|result| match result {
                Ok(user) => view! {
                    <div class="alert alert-success">
                        "✅ User " {user.name} " created successfully!"
                    </div>
                }.into_any(),
                Err(e) => view! {
                    <div class="alert alert-danger">
                        "❌ Error: " {e.to_string()}
                    </div>
                }.into_any(),
            })}
        </form>
    }
}
```

---

## PHẦN 7 — Routing

### 7.1 Router Setup

```rust
use leptos::prelude::*;
use leptos_router::{
    components::{A, Route, Router, Routes},
    path,
};

#[component]
fn App() -> impl IntoView {
    view! {
        <Router>
            // Navigation
            <nav class="navbar">
                <A href="/" class="navbar-brand">"PDMS"</A>
                <div class="navbar-nav">
                    <A href="/users" active_class="active">"Users"</A>
                    <A href="/documents" active_class="active">"Documents"</A>
                    <A href="/settings" active_class="active">"Settings"</A>
                </div>
            </nav>

            <main class="container">
                <Routes fallback=|| view! { <h1>"404 Not Found"</h1> }>
                    // Root route
                    <Route path=path!("") view=HomePage/>

                    // Users routes
                    <Route path=path!("users") view=UserListPage/>
                    <Route path=path!("users/new") view=CreateUserPage/>
                    <Route path=path!("users/:id") view=UserDetailPage/>
                    <Route path=path!("users/:id/edit") view=EditUserPage/>

                    // Documents
                    <Route path=path!("documents") view=DocumentListPage/>
                    <Route path=path!("documents/:id") view=DocumentDetailPage/>
                </Routes>
            </main>
        </Router>
    }
}
```

### 7.2 Nested Routes & Layouts

```rust
#[component]
fn DashboardLayout() -> impl IntoView {
    view! {
        <div class="dashboard">
            <aside class="sidebar">
                <nav>
                    <A href="/dashboard">"Overview"</A>
                    <A href="/dashboard/users">"Users"</A>
                    <A href="/dashboard/documents">"Documents"</A>
                    <A href="/dashboard/reports">"Reports"</A>
                </nav>
            </aside>
            <div class="main-content">
                // <Outlet/> renders the child route
                <leptos_router::components::Outlet/>
            </div>
        </div>
    }
}

// Nested routes
<Route path=path!("dashboard") view=DashboardLayout>
    <Route path=path!("") view=DashboardHome/>
    <Route path=path!("users") view=UsersSection/>
    <Route path=path!("documents") view=DocumentsSection/>
</Route>
```

---

## PHẦN 8 — SSR + Hydration với Axum

### 8.1 Server Setup

```rust
// server/src/main.rs
use axum::{Extension, Router};
use leptos::prelude::*;
use leptos_axum::{generate_route_list, LeptosRoutes};
use sqlx::PgPool;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    // Leptos config (từ Leptos.toml)
    let conf = get_configuration(None).unwrap();
    let leptos_options = conf.leptos_options;
    let addr = leptos_options.site_addr;

    // Database pool
    let pool = PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .expect("Failed to connect to DB");

    sqlx::migrate!().run(&pool).await.expect("Migration failed");

    // Generate Leptos routes (phân tích #[component] tree)
    let routes = generate_route_list(App);

    // Axum router
    let app = Router::new()
        // Leptos routes (SSR rendering)
        .leptos_routes_with_context(
            &leptos_options,
            routes,
            {
                let pool = pool.clone();
                move || {
                    // Provide context cho server functions
                    provide_context(pool.clone());
                }
            },
            App,  // root component
        )
        // Static files (CSS, WASM, JS)
        .fallback(leptos_axum::file_and_error_handler(shell))
        .with_state(leptos_options)
        // Extension middleware
        .layer(Extension(Arc::new(pool)));

    tracing::info!("Server listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// HTML shell — bao quanh Leptos app
fn shell(options: LeptosOptions) -> impl IntoView {
    view! {
        <!DOCTYPE html>
        <html lang="vi">
            <head>
                <meta charset="utf-8"/>
                <meta name="viewport" content="width=device-width, initial-scale=1"/>
                <title>"PDMS — Physical Document Management"</title>
                <link rel="stylesheet" href="/style/main.css"/>
                // Leptos injects hydration script đây
                <HydrationScripts options/>
            </head>
            <body>
                <App/>
            </body>
        </html>
    }
}
```

### 8.2 Build Commands

```bash
# Development (hot-reload)
cargo leptos watch

# Production build
cargo leptos build --release
# → target/release/server (binary)
# → target/site/ (static assets: CSS, WASM, JS)

# Run production
./target/release/server
```

---

## PHẦN 9 — Full CRUD Page Example

```rust
// app/src/pages/documents.rs
use leptos::prelude::*;
use crate::server_functions::documents::*;

#[component]
pub fn DocumentListPage() -> impl IntoView {
    // Reactive filter state
    let (search, set_search) = signal(String::new());
    let (category_filter, set_category) = signal(Option::<String>::None);

    // Resource refetch khi filter thay đổi
    let documents = Resource::new(
        move || (search.get(), category_filter.get()),
        |(search, category)| async move {
            list_documents(search, category).await
        }
    );

    let delete_action = Action::new(|id: &i64| {
        let id = *id;
        async move { delete_document(id).await }
    });

    // Refetch sau khi delete
    let _ = Effect::new(move |_| {
        let _ = delete_action.value().get(); // track
        documents.refetch();
    });

    view! {
        <div>
            <div class="page-header">
                <h1>"Documents"</h1>
                <A href="/documents/new" class="btn btn-primary">"+ New Document"</A>
            </div>

            // Filter bar
            <div class="filter-bar">
                <input
                    type="search"
                    class="form-control"
                    placeholder="Search..."
                    prop:value=search
                    on:input=move |ev| set_search.set(event_target_value(&ev))
                />
                <select
                    class="form-select"
                    on:change=move |ev| {
                        let val = event_target_value(&ev);
                        set_category.set(if val.is_empty() { None } else { Some(val) });
                    }
                >
                    <option value="">"All Categories"</option>
                    <option value="contract">"Contract"</option>
                    <option value="invoice">"Invoice"</option>
                    <option value="report">"Report"</option>
                </select>
            </div>

            // Document table
            <Suspense fallback=move || view! {
                <div class="spinner">"Loading..."</div>
            }>
                <ErrorBoundary fallback=|e| view! {
                    <div class="alert alert-danger">"Error loading documents"</div>
                }>
                    {move || documents.get().map(|result| result.map(|docs| view! {
                        <table class="table">
                            <thead>
                                <tr>
                                    <th>"Title"</th>
                                    <th>"Category"</th>
                                    <th>"Status"</th>
                                    <th>"Created"</th>
                                    <th>"Actions"</th>
                                </tr>
                            </thead>
                            <tbody>
                                <For
                                    each=move || docs.clone()
                                    key=|doc| doc.id
                                    children=move |doc| {
                                        let doc_id = doc.id;
                                        view! {
                                            <tr>
                                                <td>
                                                    <A href=format!("/documents/{}", doc.id)>
                                                        {doc.title}
                                                    </A>
                                                </td>
                                                <td>
                                                    <span class=format!("badge badge-{}", doc.category)>
                                                        {doc.category}
                                                    </span>
                                                </td>
                                                <td>{doc.status}</td>
                                                <td>{doc.created_at}</td>
                                                <td>
                                                    <A href=format!("/documents/{}/edit", doc.id)
                                                        class="btn btn-sm btn-outline">
                                                        "Edit"
                                                    </A>
                                                    <button
                                                        class="btn btn-sm btn-danger"
                                                        on:click=move |_| {
                                                            if web_sys::window()
                                                                .and_then(|w| w.confirm_with_message("Delete this document?").ok())
                                                                .unwrap_or(false)
                                                            {
                                                                delete_action.dispatch(doc_id);
                                                            }
                                                        }
                                                    >
                                                        "Delete"
                                                    </button>
                                                </td>
                                            </tr>
                                        }
                                    }
                                />
                            </tbody>
                        </table>
                    }))}
                </ErrorBoundary>
            </Suspense>
        </div>
    }
}
```

---

## 🎯 Leptos vs React/Next.js

| Concept | React/Next.js | Leptos |
|---|---|---|
| Component | `function Comp() { return <jsx> }` | `#[component] fn Comp() -> impl IntoView` |
| State | `useState(0)` | `signal(0)` |
| Computed | `useMemo(() => x*2, [x])` | `Memo::new(move \|_\| count.get() * 2)` |
| Side effect | `useEffect(() => {}, [dep])` | `Effect::new(move \|_\| { ... })` |
| Async data | `useQuery` (React Query) | `Resource::new(source, fetcher)` |
| Mutation | `useMutation` | `Action::new(\|input\| async { ... })` |
| Router | `<Link href>`, `useParams` | `<A href>`, `use_params_map()` |
| API calls | `fetch("/api/users")` | `get_users().await` (server fn) |
| SSR | `getServerSideProps` | `#[server]` fn + Axum |
| Hydration | Automatic (Next.js) | `<HydrationScripts>` |
| TypeScript | Required for types | Rust (compile-time safe) |

---

## 🏋️ Bài Tập

1. **User Dashboard**: Tạo trang `/users` list + `/users/:id` detail. Dùng Resource để fetch, signal để filter theo role. Có search box reactive.

2. **Create Form**: Form tạo user mới với validation client-side (signal) và server-side (server function). Hiện loading state + success/error message.

3. **SSR + DB**: Setup full SSR với Axum backend. Inject PgPool vào Leptos context. Server function `get_documents()` query thực từ PostgreSQL.

4. **CRUD Complete**: Implement full CRUD cho Document — list, detail, create, edit, delete. Dùng `For` component với `key` prop. `Action` cho mutations, `Resource` cho queries.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-24-Axum-Advanced|Bài 24: Axum Advanced]] — backend foundation
- [[Rust-Zero-To-Hero/Bai-26-SQLx-Advanced|Bài 26: SQLx Advanced]] — DB integration
- [[Rust-Zero-To-Hero/Plan-Framework-Mastery|Plan: Framework Mastery]] — tổng quan
