---
tags: [rust, dioxus, wasm, state-management, performance, testing]
prerequisites: [Bai-36-Dioxus-Core]
next: Bai-38-Dioxus-Desktop-Mobile
---

# Bài 37: Dioxus Advanced — State Management, Performance & Patterns

> **Prerequisite:** Bài 36 (Dioxus Core)  
> **Mục tiêu:** Nắm các pattern nâng cao: global state, optimization, coroutines, error handling, testing

---

## PHẦN 1 — Global State Management

### 1.1 Vấn đề Prop Drilling

```
Vấn đề:
  App
  └── Dashboard
      └── Sidebar
          └── UserMenu
              └── Avatar   ← cần user info
              
Mỗi cấp phải truyền prop `user` xuống → prop drilling
```

### 1.2 Store Pattern với Signal

```rust
use dioxus::prelude::*;
use std::collections::HashMap;

// --- State types ---

#[derive(Clone, Debug, Default)]
struct User {
    id: u32,
    name: String,
    email: String,
    role: String,
}

#[derive(Clone, Debug, Default)]
struct AppStore {
    // Auth
    current_user: Option<User>,
    auth_token: Option<String>,

    // UI
    sidebar_open: bool,
    theme: Theme,
    notifications: Vec<Notification>,

    // Data cache
    document_cache: HashMap<u32, Document>,
}

#[derive(Clone, Debug, Default, PartialEq)]
enum Theme { #[default] Light, Dark }

#[derive(Clone, Debug)]
struct Notification {
    id: u32,
    message: String,
    level: NotifLevel,
}

#[derive(Clone, Debug)]
enum NotifLevel { Info, Warning, Error }

#[derive(Clone, Debug)]
struct Document {
    id: u32,
    title: String,
    status: String,
}

// --- Store hook ---

// Convention: use_store trả về Signal<AppStore> từ context
fn use_store() -> Signal<AppStore> {
    use_context::<Signal<AppStore>>()
}

// --- Provider ---

#[component]
fn StoreProvider() -> Element {
    // Khởi tạo store một lần ở root
    use_context_provider(|| Signal::new(AppStore::default()));

    rsx! { Outlet::<Route> {} }
}

// --- Actions — functions modify store ---

fn login(mut store: Signal<AppStore>, user: User, token: String) {
    store.write().current_user = Some(user);
    store.write().auth_token = Some(token);
}

fn logout(mut store: Signal<AppStore>) {
    store.write().current_user = None;
    store.write().auth_token = None;
    store.write().document_cache.clear();
}

fn toggle_sidebar(mut store: Signal<AppStore>) {
    let current = store.read().sidebar_open;
    store.write().sidebar_open = !current;
}

fn add_notification(mut store: Signal<AppStore>, message: String, level: NotifLevel) {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);

    let id = COUNTER.fetch_add(1, Ordering::Relaxed);
    store.write().notifications.push(Notification { id, message, level });
}

// --- Consumer components ---

#[component]
fn UserMenu() -> Element {
    let store = use_store();

    rsx! {
        div { class: "user-menu",
            if let Some(user) = &store.read().current_user {
                div {
                    span { class: "avatar", "{&user.name[..1]}" }
                    span { "{user.name}" }
                    span { class: "role", "{user.role}" }
                }
            } else {
                button { "Đăng nhập" }
            }
        }
    }
}

#[component]
fn NotificationList() -> Element {
    let mut store = use_store();

    rsx! {
        div { class: "notifications",
            for notif in store.read().notifications.iter() {
                div {
                    class: "notif notif-{notif.level:?}",
                    key: "{notif.id}",
                    p { "{notif.message}" }
                    button {
                        onclick: {
                            let id = notif.id;
                            move |_| {
                                store.write().notifications.retain(|n| n.id != id);
                            }
                        },
                        "×"
                    }
                }
            }
        }
    }
}
```

### 1.3 Reducer Pattern

```rust
use dioxus::prelude::*;

// Redux-like reducer cho complex state transitions
#[derive(Clone, Debug)]
struct DocumentState {
    documents: Vec<Document>,
    loading: bool,
    error: Option<String>,
    selected_id: Option<u32>,
    filter: DocumentFilter,
}

#[derive(Clone, Debug, Default)]
struct DocumentFilter {
    status: Option<String>,
    search: String,
}

#[derive(Clone, Debug)]
struct Document {
    id: u32,
    title: String,
    status: String,
}

// Action enum — mọi state change đều qua action
#[derive(Clone, Debug)]
enum DocumentAction {
    LoadStart,
    LoadSuccess(Vec<Document>),
    LoadError(String),
    Select(u32),
    Deselect,
    SetFilter(DocumentFilter),
    UpdateStatus(u32, String),
    Delete(u32),
}

// Pure reducer function — không có side effects
fn document_reducer(state: &DocumentState, action: DocumentAction) -> DocumentState {
    let mut next = state.clone();
    match action {
        DocumentAction::LoadStart => {
            next.loading = true;
            next.error = None;
        }
        DocumentAction::LoadSuccess(docs) => {
            next.loading = false;
            next.documents = docs;
        }
        DocumentAction::LoadError(e) => {
            next.loading = false;
            next.error = Some(e);
        }
        DocumentAction::Select(id) => {
            next.selected_id = Some(id);
        }
        DocumentAction::Deselect => {
            next.selected_id = None;
        }
        DocumentAction::SetFilter(f) => {
            next.filter = f;
        }
        DocumentAction::UpdateStatus(id, status) => {
            if let Some(doc) = next.documents.iter_mut().find(|d| d.id == id) {
                doc.status = status;
            }
        }
        DocumentAction::Delete(id) => {
            next.documents.retain(|d| d.id != id);
            if next.selected_id == Some(id) {
                next.selected_id = None;
            }
        }
    }
    next
}

// Hook dùng reducer
fn use_document_store() -> (Signal<DocumentState>, impl Fn(DocumentAction)) {
    let mut state = use_signal(|| DocumentState {
        documents: vec![],
        loading: false,
        error: None,
        selected_id: None,
        filter: DocumentFilter::default(),
    });

    let dispatch = move |action: DocumentAction| {
        let next = document_reducer(&state.read(), action);
        state.set(next);
    };

    (state, dispatch)
}

#[component]
fn DocumentManager() -> Element {
    let (state, dispatch) = use_document_store();

    // Load documents on mount
    let dispatch_clone = dispatch.clone();
    use_effect(move || {
        let dispatch = dispatch_clone.clone();
        spawn(async move {
            dispatch(DocumentAction::LoadStart);
            match fetch_documents().await {
                Ok(docs) => dispatch(DocumentAction::LoadSuccess(docs)),
                Err(e) => dispatch(DocumentAction::LoadError(e.to_string())),
            }
        });
    });

    // Filtered docs
    let filtered = use_memo(move || {
        let s = state.read();
        s.documents.iter()
            .filter(|d| {
                let search_match = s.filter.search.is_empty()
                    || d.title.to_lowercase().contains(&s.filter.search.to_lowercase());
                let status_match = s.filter.status.as_ref()
                    .map(|f| &d.status == f)
                    .unwrap_or(true);
                search_match && status_match
            })
            .cloned()
            .collect::<Vec<_>>()
    });

    rsx! {
        div {
            if state.read().loading {
                div { class: "spinner", "Đang tải..." }
            }
            if let Some(err) = &state.read().error {
                div { class: "error", "{err}" }
            }
            ul {
                for doc in filtered.read().iter() {
                    li {
                        key: "{doc.id}",
                        class: if state.read().selected_id == Some(doc.id) { "selected" } else { "" },
                        onclick: {
                            let id = doc.id;
                            let d = dispatch.clone();
                            move |_| d(DocumentAction::Select(id))
                        },
                        "{doc.title} — {doc.status}"
                    }
                }
            }
        }
    }
}

async fn fetch_documents() -> Result<Vec<Document>, reqwest::Error> {
    reqwest::get("https://api.example.com/documents")
        .await?
        .json()
        .await
}
```

---

## PHẦN 2 — Coroutines

### 2.1 use_coroutine — Background Tasks

```rust
use dioxus::prelude::*;
use tokio::time::{interval, Duration};

// Coroutine = long-running async task trong component lifecycle
// Khác use_resource: coroutine không trả về value, chạy liên tục

// Ví dụ: WebSocket connection
#[component]
fn RealtimeUpdates() -> Element {
    let mut messages = use_signal(|| Vec::<String>::new());

    // Coroutine nhận messages qua channel
    // Trả về CoroutineHandle để send message
    let ws_handle = use_coroutine(move |mut rx: UnboundedReceiver<String>| async move {
        // Simulate WebSocket connection
        let mut tick = interval(Duration::from_secs(2));

        loop {
            tokio::select! {
                // Nhận message từ component
                Some(msg) = rx.next() => {
                    println!("Sending to WS: {msg}");
                    // ws.send(msg).await;
                }
                // Nhận tick (simulate real-time updates)
                _ = tick.tick() => {
                    // Khi component vẫn mounted, push message
                    messages.write().push(format!("Update at {:?}", std::time::SystemTime::now()));
                }
            }
        }
    });

    rsx! {
        div {
            h2 { "Real-time Messages" }
            button {
                onclick: move |_| {
                    // Gửi message vào coroutine
                    ws_handle.send("ping".to_string());
                },
                "Send Ping"
            }
            ul {
                for msg in messages.read().iter().rev().take(10) {
                    li { "{msg}" }
                }
            }
        }
    }
}
```

### 2.2 Polling Pattern

```rust
use dioxus::prelude::*;
use tokio::time::{interval, Duration};

// Poll API định kỳ — dùng coroutine
#[component]
fn SystemStatus() -> Element {
    let mut status = use_signal(|| "Đang kiểm tra...".to_string());
    let mut healthy = use_signal(|| true);

    let _poll = use_coroutine(move |_rx: UnboundedReceiver<()>| async move {
        let mut ticker = interval(Duration::from_secs(30));

        loop {
            ticker.tick().await;

            match reqwest::get("https://api.example.com/health").await {
                Ok(resp) if resp.status().is_success() => {
                    status.set("✅ Hệ thống hoạt động bình thường".to_string());
                    healthy.set(true);
                }
                Ok(resp) => {
                    status.set(format!("⚠️ Cảnh báo: HTTP {}", resp.status()));
                    healthy.set(false);
                }
                Err(e) => {
                    status.set(format!("❌ Lỗi kết nối: {e}"));
                    healthy.set(false);
                }
            }
        }
    });

    rsx! {
        div {
            class: if healthy() { "status-ok" } else { "status-error" },
            p { "{status}" }
        }
    }
}
```

---

## PHẦN 3 — Performance Optimization

### 3.1 Tránh Re-render Không Cần Thiết

```rust
use dioxus::prelude::*;

// Vấn đề: component re-render dù prop không đổi
// Dioxus memoize component tự động nếu props implement PartialEq

#[derive(Props, Clone, PartialEq)]
struct ExpensiveProps {
    data: Vec<String>,   // PartialEq → só sánh trước khi render
    label: String,
}

// Component này chỉ re-render khi props thực sự thay đổi
#[component]
fn ExpensiveComponent(props: ExpensiveProps) -> Element {
    println!("ExpensiveComponent rendered!");  // Chỉ in khi thực sự render

    rsx! {
        div {
            h3 { "{props.label}" }
            ul {
                for item in &props.data {
                    li { "{item}" }
                }
            }
        }
    }
}

// Parent không gây ExpensiveComponent re-render nếu data/label không đổi
#[component]
fn Parent() -> Element {
    let mut counter = use_signal(|| 0);
    let data = use_signal(|| vec!["A".to_string(), "B".to_string()]);

    rsx! {
        div {
            p { "Counter: {counter}" }
            button { onclick: move |_| counter += 1, "Tăng counter" }

            // counter tăng KHÔNG làm ExpensiveComponent re-render
            // vì data và label không đổi
            ExpensiveComponent {
                data: data.read().clone(),
                label: "Danh sách".to_string(),
            }
        }
    }
}
```

### 3.2 Lazy Loading & Code Splitting

```rust
use dioxus::prelude::*;

// Dioxus hỗ trợ lazy component loading
// Hữu ích cho heavy components (charts, editors, etc.)

#[component]
fn AdminDashboard() -> Element {
    let mut show_chart = use_signal(|| false);

    rsx! {
        div {
            button {
                onclick: move |_| show_chart.toggle(),
                "Toggle Chart"
            }

            // Chỉ render khi cần — tránh load heavy dependencies sớm
            if show_chart() {
                // HeavyChart chỉ khởi tạo khi show_chart = true
                HeavyChartComponent {}
            }
        }
    }
}

#[component]
fn HeavyChartComponent() -> Element {
    // Simulate heavy initialization
    let chart_data = use_resource(|| async {
        // Load data chỉ khi component này được render
        reqwest::get("https://api.example.com/chart-data")
            .await?
            .json::<Vec<f64>>()
            .await
    });

    rsx! {
        div { class: "chart-container",
            match &*chart_data.read_unchecked() {
                Some(Ok(data)) => rsx! {
                    // Render chart với data
                    p { "Chart với {data.len()} điểm dữ liệu" }
                },
                Some(Err(e)) => rsx! { p { "Lỗi: {e}" } },
                None => rsx! { p { "Đang tải chart..." } },
            }
        }
    }
}
```

### 3.3 Virtualized Lists

```rust
use dioxus::prelude::*;

// Render danh sách lớn (10k+ items) hiệu quả
// Chỉ render items trong viewport

#[component]
fn VirtualList(items: Vec<String>, item_height: f64) -> Element {
    let mut scroll_top = use_signal(|| 0.0f64);
    let container_height = 400.0; // px

    // Tính items cần render
    let visible_start = use_memo(move || {
        (scroll_top() / item_height).floor() as usize
    });

    let visible_end = use_memo(move || {
        let end = ((scroll_top() + container_height) / item_height).ceil() as usize;
        end.min(items.len())
    });

    let total_height = items.len() as f64 * item_height;
    let offset_top = visible_start() as f64 * item_height;

    rsx! {
        div {
            style: "height: {container_height}px; overflow-y: auto; position: relative;",
            onscroll: move |e| {
                // Update scroll position
                // e.data().scroll_top() trong real implementation
            },

            // Spacer tạo scrollable height đúng
            div { style: "height: {total_height}px; position: relative;",
                div {
                    style: "position: absolute; top: {offset_top}px; width: 100%;",
                    for i in visible_start()..visible_end() {
                        div {
                            key: "{i}",
                            style: "height: {item_height}px;",
                            "{items[i]}"
                        }
                    }
                }
            }
        }
    }
}
```

---

## PHẦN 4 — Error Handling

### 4.1 ErrorBoundary

```rust
use dioxus::prelude::*;

// ErrorBoundary bắt lỗi từ component con
// Tương đương React ErrorBoundary

#[component]
fn SafePage() -> Element {
    rsx! {
        ErrorBoundary {
            handle_error: |errors| rsx! {
                div { class: "error-boundary",
                    h2 { "⚠️ Đã xảy ra lỗi" }
                    for (component, error) in errors.iter() {
                        div {
                            p { "Component: {component:?}" }
                            p { "Lỗi: {error}" }
                        }
                    }
                    button {
                        onclick: |_| {
                            // Retry: Dioxus có thể re-mount component
                            println!("Retry requested");
                        },
                        "Thử lại"
                    }
                }
            },
            // Nội dung được bảo vệ
            RiskyComponent {}
        }
    }
}

#[component]
fn RiskyComponent() -> Element {
    let data = use_resource(|| async {
        // Có thể panic hoặc trả về Err
        let resp = reqwest::get("https://api.example.com/data").await?;
        if !resp.status().is_success() {
            return Err(format!("HTTP Error: {}", resp.status()));
        }
        resp.json::<Vec<String>>().await.map_err(|e| e.to_string())
    });

    match &*data.read_unchecked() {
        Some(Ok(items)) => rsx! {
            ul { for item in items { li { "{item}" } } }
        },
        Some(Err(e)) => {
            // Throw error lên ErrorBoundary
            throw!(e.clone());
        }
        None => rsx! { p { "Đang tải..." } },
    }
}
```

### 4.2 Custom Error Display Pattern

```rust
use dioxus::prelude::*;

#[derive(Debug, Clone)]
enum AppError {
    Network(String),
    NotFound(String),
    Unauthorized,
    Unknown(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            AppError::Network(e) => write!(f, "Lỗi mạng: {e}"),
            AppError::NotFound(r) => write!(f, "Không tìm thấy: {r}"),
            AppError::Unauthorized => write!(f, "Chưa đăng nhập"),
            AppError::Unknown(e) => write!(f, "Lỗi không xác định: {e}"),
        }
    }
}

// Generic error display component
#[component]
fn ErrorDisplay(error: AppError, on_retry: Option<EventHandler<()>>) -> Element {
    let (icon, class) = match &error {
        AppError::Network(_) => ("🌐", "error-network"),
        AppError::NotFound(_) => ("🔍", "error-not-found"),
        AppError::Unauthorized => ("🔒", "error-auth"),
        AppError::Unknown(_) => ("⚠️", "error-unknown"),
    };

    rsx! {
        div { class: "error-container {class}",
            span { class: "error-icon", "{icon}" }
            p { class: "error-message", "{error}" }
            if let Some(retry) = on_retry {
                button {
                    onclick: move |_| retry.call(()),
                    "Thử lại"
                }
            }
        }
    }
}

// Async result wrapper component
#[component]
fn AsyncResult<T: Clone + 'static>(
    resource: Resource<Result<T, String>>,
    children: Element,
) -> Element {
    match &*resource.read_unchecked() {
        Some(Ok(_)) => children,
        Some(Err(e)) => rsx! {
            ErrorDisplay {
                error: AppError::Unknown(e.clone()),
            }
        },
        None => rsx! {
            div { class: "loading",
                div { class: "spinner" }
                p { "Đang tải..." }
            }
        },
    }
}
```

---

## PHẦN 5 — Testing

### 5.1 Unit Test Component

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use dioxus::prelude::*;

    // Test component rendering
    #[test]
    fn test_counter_initial_value() {
        // Dioxus test utilities
        let mut dom = VirtualDom::new(|| rsx! {
            Counter {}
        });
        dom.rebuild_in_place();
        // Kiểm tra initial state
        // (Chi tiết test API tùy version Dioxus)
    }

    // Test reducer
    #[test]
    fn test_document_reducer_load_success() {
        let initial = DocumentState {
            documents: vec![],
            loading: true,
            error: None,
            selected_id: None,
            filter: DocumentFilter::default(),
        };

        let docs = vec![
            Document { id: 1, title: "Doc 1".to_string(), status: "DRAFT".to_string() },
        ];

        let next = document_reducer(
            &initial,
            DocumentAction::LoadSuccess(docs.clone())
        );

        assert!(!next.loading);
        assert_eq!(next.documents.len(), 1);
        assert_eq!(next.documents[0].title, "Doc 1");
        assert!(next.error.is_none());
    }

    #[test]
    fn test_document_reducer_delete() {
        let initial = DocumentState {
            documents: vec![
                Document { id: 1, title: "Doc 1".to_string(), status: "DRAFT".to_string() },
                Document { id: 2, title: "Doc 2".to_string(), status: "FINAL".to_string() },
            ],
            loading: false,
            error: None,
            selected_id: Some(1),
            filter: DocumentFilter::default(),
        };

        let next = document_reducer(&initial, DocumentAction::Delete(1));

        assert_eq!(next.documents.len(), 1);
        assert_eq!(next.documents[0].id, 2);
        // selected_id bị clear vì đã delete doc được select
        assert_eq!(next.selected_id, None);
    }

    #[test]
    fn test_document_filter() {
        let state = DocumentState {
            documents: vec![
                Document { id: 1, title: "Hợp đồng A".to_string(), status: "DRAFT".to_string() },
                Document { id: 2, title: "Tài liệu B".to_string(), status: "FINAL".to_string() },
                Document { id: 3, title: "Hợp đồng C".to_string(), status: "FINAL".to_string() },
            ],
            loading: false,
            error: None,
            selected_id: None,
            filter: DocumentFilter { search: "Hợp đồng".to_string(), status: None },
        };

        // Test filter logic (tách ra function để test được)
        let filtered: Vec<_> = state.documents.iter()
            .filter(|d| {
                d.title.to_lowercase().contains(&state.filter.search.to_lowercase())
            })
            .collect();

        assert_eq!(filtered.len(), 2);
    }
}
```

### 5.2 Integration Test với Mock Server

```rust
#[cfg(test)]
mod integration_tests {
    use super::*;
    use wiremock::{MockServer, Mock, ResponseTemplate};
    use wiremock::matchers::{method, path};

    #[tokio::test]
    async fn test_fetch_documents() {
        // Start mock server
        let server = MockServer::start().await;

        // Setup mock response
        Mock::given(method("GET"))
            .and(path("/documents"))
            .respond_with(ResponseTemplate::new(200)
                .set_body_json(serde_json::json!([
                    {"id": 1, "title": "Test Doc", "status": "DRAFT"}
                ])))
            .mount(&server)
            .await;

        // Test với server URL thay thế
        let url = format!("{}/documents", server.uri());
        let result = reqwest::get(&url)
            .await
            .unwrap()
            .json::<Vec<serde_json::Value>>()
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["title"], "Test Doc");
    }
}
```

---

## PHẦN 6 — Advanced Patterns

### 6.1 Optimistic Updates

```rust
use dioxus::prelude::*;

// Optimistic update: update UI ngay lập tức, rollback nếu server fail
// Tương đương pattern trong TanStack Query (React)

#[component]
fn OptimisticDocList() -> Element {
    let mut docs = use_signal(|| vec![
        Document { id: 1, title: "Doc A".to_string(), status: "DRAFT".to_string() },
        Document { id: 2, title: "Doc B".to_string(), status: "DRAFT".to_string() },
    ]);

    let approve_doc = move |id: u32| async move {
        // 1. Optimistic update — update UI ngay
        let old_status = {
            let mut d = docs.write();
            if let Some(doc) = d.iter_mut().find(|doc| doc.id == id) {
                let old = doc.status.clone();
                doc.status = "APPROVED".to_string();
                old
            } else {
                return;
            }
        };

        // 2. Gọi server
        let result = reqwest::Client::new()
            .patch(format!("https://api.example.com/documents/{id}/approve"))
            .send()
            .await;

        // 3. Rollback nếu fail
        if result.is_err() {
            let mut d = docs.write();
            if let Some(doc) = d.iter_mut().find(|doc| doc.id == id) {
                doc.status = old_status;  // Rollback
            }
            // Hiển thị error notification
            eprintln!("Lỗi khi approve document {id}");
        }
    };

    rsx! {
        ul {
            for doc in docs.read().iter() {
                li {
                    key: "{doc.id}",
                    span { "{doc.title} — {doc.status}" }
                    if doc.status == "DRAFT" {
                        button {
                            onclick: {
                                let id = doc.id;
                                move |_| spawn(approve_doc(id))
                            },
                            "Phê duyệt"
                        }
                    }
                }
            }
        }
    }
}
```

### 6.2 Infinite Scroll

```rust
use dioxus::prelude::*;

#[component]
fn InfiniteDocList() -> Element {
    let mut page = use_signal(|| 0u32);
    let mut all_docs = use_signal(|| Vec::<Document>::new());
    let mut has_more = use_signal(|| true);
    let mut loading = use_signal(|| false);

    let load_more = move |_| async move {
        if !has_more() || loading() { return; }

        loading.set(true);
        match fetch_documents_page(page()).await {
            Ok(new_docs) => {
                if new_docs.is_empty() {
                    has_more.set(false);
                } else {
                    all_docs.write().extend(new_docs);
                    page += 1;
                }
            }
            Err(e) => eprintln!("Load error: {e}"),
        }
        loading.set(false);
    };

    // Load initial data
    use_effect(move || {
        spawn(load_more(()));
    });

    rsx! {
        div { class: "doc-list",
            for doc in all_docs.read().iter() {
                div { class: "doc-item", key: "{doc.id}",
                    h3 { "{doc.title}" }
                    span { "{doc.status}" }
                }
            }

            if loading() {
                div { class: "loading", "Đang tải thêm..." }
            }

            if has_more() && !loading() {
                button {
                    onclick: load_more,
                    "Tải thêm"
                }
            } else if !has_more() {
                p { class: "end", "Đã hiển thị tất cả" }
            }
        }
    }
}

async fn fetch_documents_page(page: u32) -> Result<Vec<Document>, reqwest::Error> {
    reqwest::get(format!("https://api.example.com/documents?page={page}&size=20"))
        .await?
        .json()
        .await
}
```

---

## 📝 Exercises

1. **Redux-style Store**: Implement store đầy đủ cho PDMS: auth state, document list state, filter state. Actions: login/logout, loadDocuments, createDocument, updateStatus, deleteDocument.

2. **Optimistic Delete**: List documents với nút delete. Optimistic: ẩn item ngay lập tức, gọi API, rollback nếu fail (hiển thị lại + error toast).

3. **WebSocket Coroutine**: Simulate WebSocket với coroutine. Server push updates mỗi 3 giây (mock bằng interval). Client có thể gửi message qua coroutine handle.

4. **Infinite Scroll với Search**: Kết hợp infinite scroll + search filter. Khi search thay đổi → reset page về 0, clear list, load lại từ đầu.

5. **Test reducers**: Viết comprehensive unit tests cho document_reducer — test tất cả actions, edge cases (delete selected item, load error sau load success...).

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-36-Dioxus-Core|Bài 36: Dioxus Core]] ← prerequisite
- [[Rust-Zero-To-Hero/Bai-38-Dioxus-Desktop-Mobile|Bài 38: Dioxus Desktop & Mobile]] → tiếp theo
- [[Rust-Zero-To-Hero/Bai-29-Leptos|Bài 29: Leptos]] — so sánh
