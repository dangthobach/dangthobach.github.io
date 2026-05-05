---
tags: [rust, axum, leptos, dioxus, state-management, context, reducer, production]
prerequisites: [Bai-39-Security-Production]
next: Bai-41-Auth-SSR
---

# Bài 40: Global State Management — Tránh Prop Drilling

> **Áp dụng cho:** Leptos · Dioxus (patterns khác nhau, bản chất giống nhau)  
> **Mục tiêu:** Share state qua component tree mà không cần truyền props qua từng cấp

---

## 🗺️ Bức Tranh Tổng Quan

```
Vấn đề Prop Drilling:

  App (có user state)
   └── Dashboard
        └── Sidebar
             └── UserMenu
                  └── Avatar     ← cần user.avatar
                  └── Username   ← cần user.name
                  
  Mỗi cấp phải truyền prop "user" xuống → boilerplate, fragile.

─────────────────────────────────────────────────────────────────

Context API giải quyết:

  App
  │  provide_context(user_signal)     ← đặt vào "context tree"
  │
  ├── Dashboard   (không cần biết về user)
  ├── Sidebar     (không cần biết về user)
  └── Avatar      use_context::<UserSignal>()  ← lấy trực tiếp

─────────────────────────────────────────────────────────────────

Khi nào dùng Context vs Props?

  Props:   Component con cần data → truyền trực tiếp 1-2 cấp
  Context: State dùng ở nhiều nơi, hoặc sâu nhiều cấp
           (auth, theme, language, cart, notifications)
```

---

## PHẦN 1 — Leptos Context API

### 1.1 provide_context + use_context

```rust
use leptos::prelude::*;

// --- State types ---

#[derive(Clone, Debug, Default)]
pub struct CurrentUser {
    pub id: Option<u32>,
    pub name: String,
    pub role: String,
    pub is_authenticated: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Theme { #[default] Light, Dark }

// Wrapper types để tránh conflict khi có nhiều context cùng type
#[derive(Clone, Copy)]
pub struct ThemeContext(pub RwSignal<Theme>);

#[derive(Clone, Copy)]
pub struct UserContext(pub RwSignal<CurrentUser>);

// --- Root App — provide context ---

#[component]
pub fn App() -> impl IntoView {
    // Tạo signals ở root
    let user = RwSignal::new(CurrentUser::default());
    let theme = RwSignal::new(Theme::default());

    // Inject vào context tree
    provide_context(UserContext(user));
    provide_context(ThemeContext(theme));

    view! {
        <div class=move || match theme.get() {
            Theme::Light => "app theme-light",
            Theme::Dark  => "app theme-dark",
        }>
            <TopBar />
            <main>
                <Sidebar />
                <Content />
            </main>
        </div>
    }
}

// --- Consumer components — không cần props ---

#[component]
fn TopBar() -> impl IntoView {
    // Lấy context bằng type — type-safe
    let UserContext(user) = use_context::<UserContext>()
        .expect("UserContext phải được provide ở root");
    let ThemeContext(theme) = use_context::<ThemeContext>().unwrap();

    view! {
        <header>
            <span>{move || user.get().name.clone()}</span>
            <span class="role">{move || user.get().role.clone()}</span>
            <button on:click=move |_| {
                theme.update(|t| *t = match t {
                    Theme::Light => Theme::Dark,
                    Theme::Dark  => Theme::Light,
                });
            }>"Toggle Theme"</button>
        </header>
    }
}

// Avatar component — sâu trong tree, vẫn access được user
#[component]
fn Avatar() -> impl IntoView {
    let UserContext(user) = use_context::<UserContext>().unwrap();

    view! {
        <div class="avatar">
            {move || {
                let name = user.get().name;
                if name.is_empty() { "?" .to_string() }
                else { name.chars().next().unwrap().to_string().to_uppercase() }
            }}
        </div>
    }
}
```

### 1.2 Pattern: Struct Chứa Nhiều Signals

```rust
use leptos::prelude::*;

// Thay vì nhiều context riêng lẻ → 1 struct chứa tất cả
// Ưu điểm: dễ manage, pass 1 lần

#[derive(Clone, Copy)]
pub struct AppState {
    // Auth
    pub user: RwSignal<Option<AuthUser>>,
    // UI
    pub theme: RwSignal<Theme>,
    pub sidebar_open: RwSignal<bool>,
    pub notifications: RwSignal<Vec<Notification>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            user: RwSignal::new(None),
            theme: RwSignal::new(Theme::Light),
            sidebar_open: RwSignal::new(true),
            notifications: RwSignal::new(vec![]),
        }
    }

    // Helper methods — action-style
    pub fn logout(&self) {
        self.user.set(None);
        self.notifications.update(|n| n.clear());
    }

    pub fn add_notification(&self, msg: String, level: NotifLevel) {
        self.notifications.update(|n| n.push(Notification {
            id: rand::random(),
            message: msg,
            level,
        }));
    }
}

#[derive(Clone, Debug)]
pub struct AuthUser { pub id: u32, pub name: String, pub role: String }

#[derive(Clone, Debug)]
pub struct Notification { pub id: u32, pub message: String, pub level: NotifLevel }

#[derive(Clone, Debug)]
pub enum NotifLevel { Info, Warning, Error }

#[component]
pub fn AppRoot() -> impl IntoView {
    let state = AppState::new();
    provide_context(state);

    view! { <AppLayout /> }
}

// Consumer
#[component]
fn NotificationBell() -> impl IntoView {
    let state = use_context::<AppState>().unwrap();

    view! {
        <div class="notif-bell">
            {move || state.notifications.get().len()}
            // Hiển thị list
            <ul>
                {move || state.notifications.get().into_iter()
                    .map(|n| view! {
                        <li class=format!("notif-{:?}", n.level)>
                            {n.message}
                            <button on:click=move |_| {
                                let id = n.id;
                                state.notifications.update(|list| list.retain(|x| x.id != id));
                            }>"×"</button>
                        </li>
                    })
                    .collect_view()}
            </ul>
        </div>
    }
}
```

### 1.3 Advanced Reactivity — For Component & Key Tracking

```rust
use leptos::prelude::*;

// ❌ SAI — dùng .map().collect_view() với list lớn
// Leptos re-render toàn bộ list khi bất kỳ item nào thay đổi
#[component]
fn BadList(items: ReadSignal<Vec<String>>) -> impl IntoView {
    view! {
        <ul>
            {move || items.get().iter().map(|item| view! {
                <li>{item.clone()}</li>
            }).collect_view()}
        </ul>
    }
}

// ✅ ĐÚNG — dùng <For> với key
// Leptos chỉ update exact <li> thay đổi/thêm/xóa
#[component]
fn GoodList(items: ReadSignal<Vec<Document>>) -> impl IntoView {
    view! {
        <ul>
            <For
                each=move || items.get()
                key=|doc| doc.id           // ← key tracking, như React key
                children=move |doc| view! {
                    <li>
                        <DocumentRow doc=doc />
                    </li>
                }
            />
        </ul>
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Document { id: u32, title: String, status: String }

#[component]
fn DocumentRow(doc: Document) -> impl IntoView {
    view! {
        <div class="doc-row">
            <span>{doc.title.clone()}</span>
            <span class=format!("status-{}", doc.status.to_lowercase())>
                {doc.status.clone()}
            </span>
        </div>
    }
}
```

### 1.4 Reactivity Footguns — Cạm Bẫy Phổ Biến

```rust
use leptos::prelude::*;

// ❌ FOOTGUN 1: Đọc signal bên ngoài reactive closure
// → không reactive, giá trị bị "đóng băng"
#[component]
fn Stale() -> impl IntoView {
    let (count, set_count) = signal(0i32);

    // BUG: count.get() được gọi 1 lần khi component mount
    // count sau đó thay đổi nhưng text KHÔNG update
    let static_text = format!("Count is: {}", count.get()); // ← ĐỌC NGAY

    view! {
        <p>{static_text}</p>  // Luôn hiển thị "Count is: 0"
        <button on:click=move |_| set_count.update(|n| *n += 1)>"+"</button>
    }
}

// ✅ FIX: Bọc trong closure → reactive
#[component]
fn Reactive() -> impl IntoView {
    let (count, set_count) = signal(0i32);

    view! {
        // Closure được gọi lại mỗi khi count thay đổi
        <p>{move || format!("Count is: {}", count.get())}</p>
        <button on:click=move |_| set_count.update(|n| *n += 1)>"+"</button>
    }
}

// ❌ FOOTGUN 2: Infinite loop trong create_effect
#[component]
fn InfiniteLoop() -> impl IntoView {
    let (a, set_a) = signal(0i32);

    // BUG: Effect đọc `a`, rồi lại set `a` → loop vô tận
    Effect::new(move |_| {
        let val = a.get();       // track `a`
        set_a.set(val + 1);     // set `a` → trigger effect lại
    });

    view! { <p>{a}</p> }
}

// ✅ FIX: Dùng untrack để đọc mà không track
#[component]
fn NoLoop() -> impl IntoView {
    let (a, set_a) = signal(0i32);
    let (b, _set_b) = signal(10i32);

    // Effect chỉ trigger khi `b` thay đổi (vì a được untrack)
    Effect::new(move |_| {
        let b_val = b.get();            // track `b`
        let a_val = untrack(|| a.get()); // đọc `a` mà KHÔNG track
        set_a.set(a_val + b_val);
    });

    view! { <p>{a}</p> }
}
```

---

## PHẦN 2 — Dioxus Context & Reducer

### 2.1 Context Provider + Consumer

```rust
use dioxus::prelude::*;

// State types
#[derive(Clone, Debug, Default)]
struct AppState {
    user: Option<UserInfo>,
    theme: AppTheme,
    notifications: Vec<Notif>,
}

#[derive(Clone, Debug, Default, PartialEq)]
enum AppTheme { #[default] Light, Dark }

#[derive(Clone, Debug)]
struct UserInfo { pub id: u32, pub name: String, pub role: String }

#[derive(Clone, Debug)]
struct Notif { pub id: u32, pub message: String }

// --- Root: inject context ---
#[component]
fn AppRoot() -> Element {
    use_context_provider(|| Signal::new(AppState::default()));

    rsx! { MainLayout {} }
}

// --- Consumer helper hook ---
fn use_app_state() -> Signal<AppState> {
    use_context::<Signal<AppState>>()
}

// --- Consumer components ---
#[component]
fn Header() -> Element {
    let state = use_app_state();

    rsx! {
        header {
            if let Some(user) = &state.read().user {
                span { "{user.name}" }
                span { class: "role", "{user.role}" }
            } else {
                button { "Đăng nhập" }
            }
            button {
                onclick: move |_| {
                    state.write().theme = match state.read().theme {
                        AppTheme::Light => AppTheme::Dark,
                        AppTheme::Dark  => AppTheme::Light,
                    };
                },
                "Toggle Theme"
            }
        }
    }
}

#[component]
fn NotificationCenter() -> Element {
    let mut state = use_app_state();

    rsx! {
        div { class: "notifications",
            for notif in state.read().notifications.iter() {
                div { class: "notif", key: "{notif.id}",
                    p { "{notif.message}" }
                    button {
                        onclick: {
                            let id = notif.id;
                            move |_| state.write().notifications.retain(|n| n.id != id)
                        },
                        "×"
                    }
                }
            }
        }
    }
}
```

### 2.2 Reducer Pattern — Complex State Transitions

```rust
use dioxus::prelude::*;

// Mọi state change đều đi qua action → predictable, testable
#[derive(Clone, Debug)]
enum AppAction {
    Login(UserInfo),
    Logout,
    SetTheme(AppTheme),
    AddNotification(String),
    RemoveNotification(u32),
    ToggleSidebar,
}

// Pure function — không có side effect, dễ test
fn app_reducer(state: &AppState, action: AppAction) -> AppState {
    let mut next = state.clone();
    match action {
        AppAction::Login(user)  => next.user = Some(user),
        AppAction::Logout       => { next.user = None; next.notifications.clear(); }
        AppAction::SetTheme(t)  => next.theme = t,
        AppAction::AddNotification(msg) => {
            static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let id = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            next.notifications.push(Notif { id, message: msg });
        }
        AppAction::RemoveNotification(id) => next.notifications.retain(|n| n.id != id),
        AppAction::ToggleSidebar => next.sidebar_open = !next.sidebar_open,
    }
    next
}

// Hook trả về (state, dispatch)
fn use_app_store() -> (Signal<AppState>, impl Fn(AppAction) + Clone) {
    let mut state = use_context::<Signal<AppState>>();
    let dispatch = move |action: AppAction| {
        let next = app_reducer(&state.read(), action);
        state.set(next);
    };
    (state, dispatch)
}

// --- Provider ---
#[component]
fn StoreProvider() -> Element {
    use_context_provider(|| Signal::new(AppState::default()));
    rsx! { Outlet::<Route> {} }
}

// --- Consumer với dispatch ---
#[component]
fn LoginButton() -> Element {
    let (state, dispatch) = use_app_store();

    rsx! {
        if state.read().user.is_none() {
            button {
                onclick: move |_| dispatch(AppAction::Login(UserInfo {
                    id: 1,
                    name: "Nguyễn Văn A".to_string(),
                    role: "Senior Engineer".to_string(),
                })),
                "Đăng nhập"
            }
        } else {
            button {
                onclick: move |_| dispatch(AppAction::Logout),
                "Đăng xuất"
            }
        }
    }
}

// --- Unit test cho reducer (không cần DOM) ---
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_login() {
        let state = AppState::default();
        assert!(state.user.is_none());

        let next = app_reducer(&state, AppAction::Login(UserInfo {
            id: 1, name: "Test".to_string(), role: "Admin".to_string(),
        }));
        assert!(next.user.is_some());
        assert_eq!(next.user.unwrap().name, "Test");
    }

    #[test]
    fn test_logout_clears_notifications() {
        let mut state = AppState::default();
        state.user = Some(UserInfo { id: 1, name: "X".to_string(), role: "Y".to_string() });
        state.notifications.push(Notif { id: 1, message: "Test".to_string() });

        let next = app_reducer(&state, AppAction::Logout);
        assert!(next.user.is_none());
        assert!(next.notifications.is_empty());
    }
}
```

### 2.3 For Loop & Key — Tránh Re-render Không Cần Thiết

```rust
use dioxus::prelude::*;

// Dioxus Virtual DOM diff dùng key để track items
// Thiếu key → re-render toàn bộ list khi thêm/xóa 1 item

// ❌ Không có key → inefficient
#[component]
fn BadList(items: Signal<Vec<Doc>>) -> Element {
    rsx! {
        ul {
            for item in items.read().iter() {
                li { "{item.title}" }  // Không có key!
            }
        }
    }
}

// ✅ Có key → Dioxus biết item nào thêm/xóa/di chuyển
#[component]
fn GoodList(items: Signal<Vec<Doc>>) -> Element {
    rsx! {
        ul {
            for item in items.read().iter() {
                li { key: "{item.id}",  // ← key = unique, stable ID
                    DocumentItem { doc: item.clone() }
                }
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Doc { id: u32, title: String, status: String }

#[component]
fn DocumentItem(doc: Doc) -> Element {
    rsx! {
        div { class: "doc-item",
            span { "{doc.title}" }
            span { class: "status-{doc.status.to_lowercase()}", "{doc.status}" }
        }
    }
}
```

---

## PHẦN 3 — So Sánh Patterns

```
Leptos vs Dioxus — Global State:

  Leptos                          Dioxus
  ─────────────────────────────────────────────────────
  provide_context(signal)         use_context_provider(|| Signal::new(state))
  use_context::<T>()              use_context::<Signal<T>>()
  
  RwSignal — read + write         Signal — read + write
  ReadSignal — read-only          ReadOnlySignal — read-only
  
  Fine-grained: chỉ component     Virtual DOM: re-render component
  đọc signal đó mới re-render     khi signal change

  Reducer:                        Reducer:
  → Dùng RwSignal + update()      → Dùng Signal + set()
  → Không có built-in dispatch    → Tự build use_app_store hook
  → Giống nhau về concept         → Giống nhau về concept

Khi nào dùng gì:
  Signal đơn giản (theme, sidebar_open) → Context với RwSignal/Signal
  State phức tạp (documents + filters + pagination) → Reducer pattern
  Server data (async) → use_resource (Leptos) / use_resource (Dioxus)
```

---

## 💡 Tips & Tricks

```
TIP 1 — Tên context rõ ràng
  ❌ provide_context(signal)           // Conflict nếu 2 Signal<bool>
  ✅ provide_context(ThemeContext(s))   // Wrapper type, type-safe
  ✅ provide_context(SidebarContext(s))

TIP 2 — Leptos: đọc signal đúng cách trong view!
  ❌ {user.get().name}          // Đọc 1 lần, không reactive
  ✅ {move || user.get().name}  // Closure → reactive

TIP 3 — Dioxus: tránh clone Signal không cần thiết
  // Signal là Copy type → không cần clone()
  let state = use_app_state();  // OK, Signal là Copy
  let d1 = dispatch.clone();    // dispatch là FnMut → cần clone nếu dùng nhiều nơi

TIP 4 — Split context theo domain
  Thay vì 1 AppState khổng lồ, split ra:
  AuthContext  → user, token, permissions
  UIContext    → theme, sidebar, modals
  DataContext  → documents, filters, pagination
  
  Component chỉ subscribe context nó cần → ít re-render hơn.

TIP 5 — Debug reactive graph (Leptos)
  Khi không biết tại sao component không update:
  1. Đảm bảo đọc signal trong reactive context (closure/view)
  2. Kiểm tra signal đúng scope (không bị drop)
  3. Dùng Effect::new để log khi signal thay đổi:
     Effect::new(move |_| println!("user changed: {:?}", user.get()));
```

---

## 📝 Exercises

1. **AppState đầy đủ (Leptos)**: Implement `AppState` với: user, theme, sidebar, notifications. Viết 5 components dùng context ở các độ sâu khác nhau. Đảm bảo không có prop drilling.

2. **Reducer cho Documents (Dioxus)**: `DocumentState` với fields: list, loading, error, filters, selected. Implement 8 actions: LoadStart/Success/Error, Select, SetFilter, UpdateStatus, Delete, Refresh. Viết unit test cho mỗi action.

3. **For vs map benchmark**: Tạo list 1000 items. So sánh performance giữa `<For key=...>` và `.map().collect_view()`. Thêm 1 item vào đầu list và đo số DOM operations.

4. **Split Context**: Refactor `AppState` thành 3 contexts riêng (Auth, UI, Data). Đo lại số re-render khi chỉ thay đổi theme (chỉ UIContext components nên re-render, không phải AuthContext).

5. **Persist State**: Extend context để tự động save/load theme preference vào `localStorage` (Leptos: dùng `web_sys::window().local_storage()`, Dioxus: tương tự qua eval).

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-39-Security-Production|Bài 39: Security]] ← trước đó
- [[Rust-Zero-To-Hero/Bai-29-Leptos|Bài 29: Leptos]] — signal basics
- [[Rust-Zero-To-Hero/Bai-36-Dioxus-Core|Bài 36: Dioxus Core]] — signal basics
- [[Rust-Zero-To-Hero/Bai-37-Dioxus-Advanced|Bài 37: Dioxus Advanced]] — reducer pattern (mở rộng)
- [[Rust-Zero-To-Hero/Bai-41-Auth-SSR|Bài 41: Auth Flow SSR]] → tiếp theo
