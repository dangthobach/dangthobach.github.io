---
tags: [rust, dioxus, desktop, mobile, tui, cross-platform, tauri]
prerequisites: [Bai-37-Dioxus-Advanced]
next: null
---

# Bài 38: Dioxus Desktop, Mobile & TUI

> **Prerequisite:** Bài 37 (Dioxus Advanced)  
> **Mục tiêu:** Deploy cùng codebase Dioxus lên Desktop (native), Mobile (iOS/Android), TUI (terminal)

---

## 🗺️ Cross-Platform Architecture

```
Cùng codebase Rust:
  
  src/
  ├── components/     ← shared UI components
  ├── state/          ← shared business logic & state
  ├── api/            ← shared API calls
  ├── main_web.rs     ← web entry point
  ├── main_desktop.rs ← desktop entry point
  ├── main_mobile.rs  ← mobile entry point
  └── main_tui.rs     ← TUI entry point

Platform-specific chỉ ở:
  - Entry point (main_*.rs)
  - Native feature gating (#[cfg(feature = "desktop")])
  - Platform APIs (file system, camera, push notifications...)

Cargo.toml features:
  [features]
  web     = ["dioxus/web"]
  desktop = ["dioxus/desktop"]
  mobile  = ["dioxus/mobile"]
  tui     = ["dioxus/tui"]
```

---

## PHẦN 1 — Desktop (Native Window)

### 1.1 Setup Desktop

```toml
# Cargo.toml
[dependencies]
dioxus = { version = "0.6", features = ["desktop"] }
dioxus-desktop = "0.6"

# Native file dialog
rfd = "0.14"                   # Rusty File Dialog
notify = "6"                   # File system watcher
```

```rust
// src/main_desktop.rs
use dioxus::prelude::*;
use dioxus_desktop::{Config, WindowBuilder};

fn main() {
    // Desktop-specific launch với window config
    dioxus_desktop::launch_with_props(
        App,
        (),
        Config::default()
            .with_window(
                WindowBuilder::new()
                    .with_title("PDMS Desktop")
                    .with_inner_size(dioxus_desktop::LogicalSize::new(1280.0, 800.0))
                    .with_min_inner_size(dioxus_desktop::LogicalSize::new(800.0, 600.0))
                    .with_resizable(true)
                    .with_decorations(true),
            )
            // Cho phép JS tương tác với Rust
            .with_custom_protocol("pdms".to_string(), handle_protocol),
    );
}

// Custom protocol handler — serve local assets
fn handle_protocol(
    _window: &dioxus_desktop::tao::window::Window,
    request: dioxus_desktop::wry::http::Request<Vec<u8>>,
) -> dioxus_desktop::wry::http::Response<Vec<u8>> {
    // Handle pdms://local/... URLs
    dioxus_desktop::wry::http::Response::builder()
        .status(200)
        .body(vec![])
        .unwrap()
}

#[component]
fn App() -> Element {
    rsx! {
        // Desktop app có thể dùng toàn bộ Dioxus components như web
        // Thêm native features bên dưới
        div { class: "desktop-app",
            TitleBar {}
            MainLayout {}
            StatusBar {}
        }
    }
}
```

### 1.2 Native Features — File System

```rust
use dioxus::prelude::*;
use dioxus_desktop::use_window;

// Native file dialog — KHÔNG có trong web
#[component]
fn FileImporter() -> Element {
    let mut selected_path = use_signal(|| Option::<String>::None);
    let mut file_content = use_signal(|| Option::<String>::None);

    // Chỉ compile khi feature = "desktop"
    let open_file = move |_| async move {
        // rfd = Rusty File Dialog — native OS file picker
        let file = rfd::AsyncFileDialog::new()
            .add_filter("Excel", &["xlsx", "xls"])
            .add_filter("CSV", &["csv"])
            .add_filter("All", &["*"])
            .set_title("Chọn file nhập liệu")
            .pick_file()
            .await;

        if let Some(file) = file {
            let path = file.path().to_string_lossy().to_string();
            selected_path.set(Some(path.clone()));

            // Đọc file
            match tokio::fs::read_to_string(&path).await {
                Ok(content) => file_content.set(Some(content)),
                Err(e) => eprintln!("Lỗi đọc file: {e}"),
            }
        }
    };

    rsx! {
        div { class: "file-importer",
            button { onclick: open_file, "📂 Chọn File" }

            if let Some(path) = selected_path.read().as_ref() {
                p { "File: {path}" }
            }

            if let Some(content) = file_content.read().as_ref() {
                div { class: "preview",
                    h3 { "Preview (500 ký tự đầu):" }
                    pre { "{&content[..content.len().min(500)]}" }
                }
            }
        }
    }
}
```

### 1.3 System Tray

```rust
use dioxus::prelude::*;
use dioxus_desktop::{use_window, tao::system_tray::SystemTrayBuilder};

#[component]
fn AppWithTray() -> Element {
    let window = use_window();

    // Setup system tray (desktop only)
    use_effect(move || {
        #[cfg(feature = "desktop")]
        {
            // Tray icon setup — platform native
            println!("Desktop: System tray would be set up here");
            // Real implementation dùng tao::system_tray::SystemTray
        }
    });

    rsx! {
        div {
            button {
                onclick: move |_| {
                    #[cfg(feature = "desktop")]
                    window.set_visible(false);  // Hide to tray
                },
                "Thu nhỏ xuống tray"
            }
        }
    }
}
```

### 1.4 Inter-process Communication (IPC)

```rust
use dioxus::prelude::*;
use dioxus_desktop::use_window;

// Desktop: JS → Rust IPC cho native APIs
#[component]
fn NativeIntegration() -> Element {
    let window = use_window();
    let mut result = use_signal(|| String::new());

    // Gọi native Rust function từ component
    let get_system_info = move |_| async move {
        // Đây là Rust thuần — có thể gọi OS APIs
        let info = format!(
            "OS: {}\nArch: {}\nCPU cores: {}",
            std::env::consts::OS,
            std::env::consts::ARCH,
            num_cpus::get(),
        );
        result.set(info);
    };

    rsx! {
        div {
            button { onclick: get_system_info, "Lấy thông tin hệ thống" }
            if !result.read().is_empty() {
                pre { class: "system-info", "{result}" }
            }
        }
    }
}
```

### 1.5 Desktop Build & Distribution

```bash
# Build desktop app
cargo build --release --features desktop

# macOS: tạo .app bundle
dx bundle --release --platform macos

# Windows: tạo .msi / .exe
dx bundle --release --platform windows

# Linux: tạo .deb / .AppImage
dx bundle --release --platform linux

# Cross-compile (từ macOS → Windows)
# Cần cross-compilation toolchain
cargo build --release --target x86_64-pc-windows-gnu --features desktop
```

```toml
# Dioxus.toml — cấu hình bundle
[application]
name = "PDMS Desktop"
default_platform = "desktop"

[web.app]
base_path = "/"

[desktop]
[desktop.bundle]
identifier = "com.vpbank.pdms"
publisher = "VPBank"
copyright = "© 2026 VPBank"
category = "Finance"
icon = ["assets/icons/512.png", "assets/icons/256.png"]

[desktop.bundle.windows]
webview_install_mode = "EmbedBootstrapper"
```

---

## PHẦN 2 — Mobile (iOS & Android)

### 2.1 Setup Mobile

```bash
# Thêm mobile targets
rustup target add aarch64-apple-ios     # iOS physical device
rustup target add x86_64-apple-ios     # iOS simulator (Intel)
rustup target add aarch64-apple-ios-sim # iOS simulator (Apple Silicon)
rustup target add aarch64-linux-android # Android ARM64

# Cài Android NDK
# macOS: brew install android-ndk
# Set ANDROID_NDK_HOME environment variable

# Dioxus mobile CLI
cargo install dioxus-cli
```

```toml
# Cargo.toml
[dependencies]
dioxus = { version = "0.6", features = ["mobile"] }

# Platform-specific
[target.'cfg(target_os = "ios")'.dependencies]
dioxus-ios = "0.6"

[target.'cfg(target_os = "android")'.dependencies]
dioxus-android = "0.6"
```

### 2.2 Mobile Entry Point

```rust
// src/main_mobile.rs
use dioxus::prelude::*;

// iOS entry point
#[cfg(target_os = "ios")]
#[no_mangle]
pub extern "C" fn start_app() {
    dioxus_mobile::launch(App);
}

// Android entry point
#[cfg(target_os = "android")]
#[no_mangle]
fn android_main(app: dioxus_mobile::AndroidApp) {
    dioxus_mobile::launch_with_android_app(app, App);
}

#[component]
fn App() -> Element {
    rsx! {
        div { class: "mobile-app",
            // Responsive design tự động
            // Dioxus render qua WebView trên mobile
            MobileHeader {}
            MobileContent {}
            MobileTabBar {}
        }
    }
}
```

### 2.3 Mobile-specific UI Patterns

```rust
use dioxus::prelude::*;

// Bottom tab bar — mobile pattern
#[derive(Clone, PartialEq, Debug)]
enum Tab { Documents, Search, Profile }

#[component]
fn MobileApp() -> Element {
    let mut active_tab = use_signal(|| Tab::Documents);

    rsx! {
        div { class: "mobile-container",
            // Main content
            div { class: "mobile-content",
                match active_tab() {
                    Tab::Documents => rsx! { DocumentsScreen {} },
                    Tab::Search => rsx! { SearchScreen {} },
                    Tab::Profile => rsx! { ProfileScreen {} },
                }
            }

            // Bottom navigation (iOS/Android pattern)
            nav { class: "tab-bar",
                button {
                    class: if active_tab() == Tab::Documents { "tab active" } else { "tab" },
                    onclick: move |_| active_tab.set(Tab::Documents),
                    span { class: "tab-icon", "📄" }
                    span { class: "tab-label", "Tài liệu" }
                }
                button {
                    class: if active_tab() == Tab::Search { "tab active" } else { "tab" },
                    onclick: move |_| active_tab.set(Tab::Search),
                    span { class: "tab-icon", "🔍" }
                    span { class: "tab-label", "Tìm kiếm" }
                }
                button {
                    class: if active_tab() == Tab::Profile { "tab active" } else { "tab" },
                    onclick: move |_| active_tab.set(Tab::Profile),
                    span { class: "tab-icon", "👤" }
                    span { class: "tab-label", "Tài khoản" }
                }
            }
        }
    }
}

// Pull-to-refresh pattern
#[component]
fn DocumentsScreen() -> Element {
    let mut refreshing = use_signal(|| false);
    let docs = use_resource(move || async move {
        let _ = refreshing();  // dependency
        fetch_docs().await
    });

    let handle_refresh = move |_| async move {
        refreshing.set(true);
        // Simulate refresh
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        refreshing.set(false);
    };

    rsx! {
        div { class: "screen documents-screen",
            // Pull-to-refresh indicator
            if refreshing() {
                div { class: "refresh-indicator", "⟳ Đang cập nhật..." }
            }

            // Swipe-friendly list
            div { class: "doc-list",
                match &*docs.read_unchecked() {
                    Some(Ok(items)) => rsx! {
                        for item in items.iter() {
                            MobileDocCard { doc: item.clone() }
                        }
                    },
                    Some(Err(e)) => rsx! { p { "Lỗi: {e}" } },
                    None => rsx! { p { "Đang tải..." } },
                }
            }
        }
    }
}

#[derive(Debug, Clone)]
struct Document { id: u32, title: String, status: String }

#[component]
fn MobileDocCard(doc: Document) -> Element {
    rsx! {
        div { class: "mobile-card",
            div { class: "card-content",
                h3 { class: "card-title", "{doc.title}" }
                span { class: "status-badge status-{doc.status.to_lowercase()}", "{doc.status}" }
            }
            // Swipe actions (CSS-based, no JS)
            div { class: "swipe-actions",
                button { class: "action-approve", "✓" }
                button { class: "action-delete", "🗑" }
            }
        }
    }
}

async fn fetch_docs() -> Result<Vec<Document>, String> {
    Ok(vec![
        Document { id: 1, title: "Hợp đồng A".to_string(), status: "DRAFT".to_string() },
    ])
}
```

### 2.4 Mobile Build

```bash
# iOS
dx build --platform ios --release
# Output: target/aarch64-apple-ios/release/

# Android
dx build --platform android --release
# Output: target/aarch64-linux-android/release/

# Chạy trên iOS Simulator
dx serve --platform ios

# Chạy trên Android Emulator
dx serve --platform android

# Generate Xcode project (iOS)
dx bundle --platform ios
# → Mở trong Xcode, sign và deploy lên App Store

# Generate Android Studio project
dx bundle --platform android
# → Mở trong Android Studio, sign và deploy lên Play Store
```

---

## PHẦN 3 — TUI (Terminal UI)

### 3.1 Setup TUI

```toml
# Cargo.toml
[dependencies]
dioxus = { version = "0.6", features = ["tui"] }
# Hoặc dùng ratatui trực tiếp (stable hơn Dioxus TUI)
ratatui = "0.27"
crossterm = "0.27"
tokio = { version = "1", features = ["full"] }
```

### 3.2 Dioxus TUI App

```rust
// Dioxus TUI — experimental, API có thể thay đổi
// Dùng cùng rsx! syntax nhưng render ra terminal

use dioxus::prelude::*;

fn main() {
    // TUI launch — render vào terminal
    dioxus_tui::launch(App);
}

#[component]
fn App() -> Element {
    let mut selected = use_signal(|| 0usize);
    let items = vec!["📄 Documents", "👥 Users", "⚙️ Settings", "❌ Exit"];

    rsx! {
        // TUI: width/height tính bằng terminal cells
        div {
            width: "100%",
            height: "100%",
            flex_direction: "column",

            // Header
            div {
                width: "100%",
                height: "3",
                background_color: "blue",
                color: "white",
                align_items: "center",
                justify_content: "center",
                "PDMS Terminal UI"
            }

            // Main content
            div {
                width: "100%",
                flex: "1",
                flex_direction: "row",

                // Sidebar menu
                div {
                    width: "20",
                    height: "100%",
                    background_color: "dark_gray",
                    flex_direction: "column",

                    for (i, item) in items.iter().enumerate() {
                        div {
                            width: "100%",
                            height: "3",
                            align_items: "center",
                            background_color: if selected() == i { "blue" } else { "transparent" },
                            color: if selected() == i { "white" } else { "gray" },
                            onclick: move |_| selected.set(i),
                            "{item}"
                        }
                    }
                }

                // Content area
                div {
                    flex: "1",
                    height: "100%",
                    padding: "1",
                    match selected() {
                        0 => rsx! { TuiDocumentList {} },
                        1 => rsx! { TuiUserList {} },
                        2 => rsx! { TuiSettings {} },
                        _ => rsx! { p { "Goodbye!" } },
                    }
                }
            }

            // Status bar
            div {
                width: "100%",
                height: "1",
                background_color: "dark_gray",
                color: "white",
                "Press Tab to navigate | Enter to select | q to quit"
            }
        }
    }
}

#[component]
fn TuiDocumentList() -> Element {
    let docs = vec![
        ("HĐ-2026-001", "Hợp đồng mua bán", "DRAFT"),
        ("HĐ-2026-002", "Hợp đồng dịch vụ", "APPROVED"),
        ("HĐ-2026-003", "Biên bản nghiệm thu", "FINAL"),
    ];

    rsx! {
        div { flex_direction: "column", gap: "1",
            div {
                color: "yellow",
                "📄 DANH SÁCH TÀI LIỆU"
            }
            div {
                border: "single",
                flex_direction: "column",
                for (code, name, status) in &docs {
                    div {
                        flex_direction: "row",
                        gap: "2",
                        span { color: "cyan", width: "15", "{code}" }
                        span { flex: "1", "{name}" }
                        span {
                            color: match *status {
                                "DRAFT" => "yellow",
                                "APPROVED" => "green",
                                _ => "white",
                            },
                            "{status}"
                        }
                    }
                }
            }
        }
    }
}
```

### 3.3 Ratatui (Stable Alternative)

```rust
// Ratatui stable hơn Dioxus TUI cho production
// Không dùng rsx! — dùng Rust code trực tiếp

use ratatui::{
    backend::CrosstermBackend,
    crossterm::{
        event::{self, Event, KeyCode},
        execute,
        terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    },
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph},
    Terminal,
};
use std::io;

struct TuiApp {
    documents: Vec<(String, String)>,  // (title, status)
    list_state: ListState,
    should_quit: bool,
}

impl TuiApp {
    fn new() -> Self {
        let mut state = ListState::default();
        state.select(Some(0));
        Self {
            documents: vec![
                ("Hợp đồng A".to_string(), "DRAFT".to_string()),
                ("Tài liệu B".to_string(), "APPROVED".to_string()),
                ("Biên bản C".to_string(), "FINAL".to_string()),
            ],
            list_state: state,
            should_quit: false,
        }
    }

    fn on_key(&mut self, key: KeyCode) {
        match key {
            KeyCode::Char('q') => self.should_quit = true,
            KeyCode::Down | KeyCode::Char('j') => {
                let i = self.list_state.selected().unwrap_or(0);
                self.list_state.select(Some((i + 1).min(self.documents.len() - 1)));
            }
            KeyCode::Up | KeyCode::Char('k') => {
                let i = self.list_state.selected().unwrap_or(0);
                self.list_state.select(Some(i.saturating_sub(1)));
            }
            _ => {}
        }
    }
}

fn run_tui() -> io::Result<()> {
    // Setup terminal
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = TuiApp::new();

    loop {
        // Draw frame
        terminal.draw(|frame| {
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Length(3),  // Header
                    Constraint::Min(0),     // Content
                    Constraint::Length(1),  // Status
                ])
                .split(frame.area());

            // Header
            let header = Paragraph::new("PDMS Terminal v1.0")
                .style(Style::default().bg(Color::Blue).fg(Color::White).add_modifier(Modifier::BOLD))
                .block(Block::default());
            frame.render_widget(header, chunks[0]);

            // Document list
            let items: Vec<ListItem> = app.documents.iter()
                .map(|(title, status)| {
                    let color = match status.as_str() {
                        "DRAFT" => Color::Yellow,
                        "APPROVED" => Color::Green,
                        "FINAL" => Color::Cyan,
                        _ => Color::White,
                    };
                    ListItem::new(format!("{:<30} {}", title, status))
                        .style(Style::default().fg(color))
                })
                .collect();

            let list = List::new(items)
                .block(Block::default().borders(Borders::ALL).title("Tài liệu"))
                .highlight_style(Style::default().bg(Color::DarkGray).add_modifier(Modifier::BOLD))
                .highlight_symbol("▶ ");

            frame.render_stateful_widget(list, chunks[1], &mut app.list_state);

            // Status bar
            let status = Paragraph::new(" j/k: di chuyển | q: thoát")
                .style(Style::default().bg(Color::DarkGray).fg(Color::White));
            frame.render_widget(status, chunks[2]);
        })?;

        // Handle events
        if event::poll(std::time::Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                app.on_key(key.code);
            }
        }

        if app.should_quit { break; }
    }

    // Cleanup
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    Ok(())
}

fn main() {
    run_tui().expect("TUI error");
}
```

---

## PHẦN 4 — Shared Codebase Strategy

### 4.1 Platform Abstraction Layer

```rust
// src/platform/mod.rs — Abstract platform capabilities

// Platform trait — implement cho từng target
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait Platform {
    async fn read_file(&self, path: &str) -> Result<String, PlatformError>;
    async fn write_file(&self, path: &str, content: &str) -> Result<(), PlatformError>;
    async fn show_notification(&self, title: &str, body: &str) -> Result<(), PlatformError>;
    async fn open_url(&self, url: &str) -> Result<(), PlatformError>;
}

#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    #[error("Không hỗ trợ trên nền tảng này")]
    NotSupported,
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Lỗi: {0}")]
    Other(String),
}

// --- Web Implementation ---
#[cfg(target_arch = "wasm32")]
pub struct WebPlatform;

#[cfg(target_arch = "wasm32")]
#[async_trait::async_trait(?Send)]
impl Platform for WebPlatform {
    async fn read_file(&self, _path: &str) -> Result<String, PlatformError> {
        // Web: không có direct file access — phải dùng File API
        Err(PlatformError::NotSupported)
    }
    async fn write_file(&self, _path: &str, _content: &str) -> Result<(), PlatformError> {
        // Web: download file thay thế
        Err(PlatformError::NotSupported)
    }
    async fn show_notification(&self, title: &str, body: &str) -> Result<(), PlatformError> {
        // Web: Web Notifications API
        web_sys::console::log_2(
            &wasm_bindgen::JsValue::from_str(title),
            &wasm_bindgen::JsValue::from_str(body),
        );
        Ok(())
    }
    async fn open_url(&self, url: &str) -> Result<(), PlatformError> {
        // Web: window.open
        let window = web_sys::window().ok_or(PlatformError::NotSupported)?;
        window.open_with_url(url).map_err(|_| PlatformError::NotSupported)?;
        Ok(())
    }
}

// --- Desktop Implementation ---
#[cfg(all(not(target_arch = "wasm32"), feature = "desktop"))]
pub struct DesktopPlatform;

#[cfg(all(not(target_arch = "wasm32"), feature = "desktop"))]
#[async_trait::async_trait]
impl Platform for DesktopPlatform {
    async fn read_file(&self, path: &str) -> Result<String, PlatformError> {
        tokio::fs::read_to_string(path).await.map_err(Into::into)
    }
    async fn write_file(&self, path: &str, content: &str) -> Result<(), PlatformError> {
        tokio::fs::write(path, content).await.map_err(Into::into)
    }
    async fn show_notification(&self, title: &str, body: &str) -> Result<(), PlatformError> {
        // Desktop: OS native notification
        notify_rust::Notification::new()
            .summary(title)
            .body(body)
            .show()
            .map_err(|e| PlatformError::Other(e.to_string()))?;
        Ok(())
    }
    async fn open_url(&self, url: &str) -> Result<(), PlatformError> {
        open::that(url).map_err(|e| PlatformError::Other(e.to_string()))
    }
}
```

### 4.2 Feature Flag Pattern

```rust
// Dùng cfg attributes để gate platform-specific code

// src/components/file_upload.rs
use dioxus::prelude::*;

#[component]
pub fn FileUpload() -> Element {
    rsx! {
        div {
            // Web: HTML input file
            #[cfg(target_arch = "wasm32")]
            input {
                r#type: "file",
                accept: ".xlsx,.csv",
                onchange: move |_e| {
                    // Xử lý file qua Web File API
                    println!("Web file selected");
                }
            }

            // Desktop: native file dialog button
            #[cfg(all(not(target_arch = "wasm32"), feature = "desktop"))]
            button {
                onclick: move |_| async move {
                    if let Some(file) = rfd::AsyncFileDialog::new()
                        .add_filter("Data", &["xlsx", "csv"])
                        .pick_file()
                        .await
                    {
                        println!("Desktop file: {:?}", file.path());
                    }
                },
                "📂 Chọn file (Desktop)"
            }

            // Mobile: native file picker
            #[cfg(feature = "mobile")]
            button {
                onclick: move |_| {
                    println!("Mobile: trigger native file picker");
                },
                "📂 Chọn file (Mobile)"
            }
        }
    }
}
```

---

## 📊 Platform Comparison Summary

| Feature | Web (WASM) | Desktop | Mobile | TUI |
|---|---|---|---|---|
| **Rendering** | Browser DOM | Native WebView | Native WebView | Terminal |
| **File System** | ❌ Hạn chế | ✅ Full access | ✅ Sandboxed | ✅ Full access |
| **Native UI** | ❌ CSS only | ✅ OS dialogs | ✅ OS components | ✅ Terminal widgets |
| **Push notifications** | ✅ Web Push | ✅ OS native | ✅ APNs/FCM | ❌ |
| **Offline** | ✅ Service Worker | ✅ Always offline | ✅ Always offline | ✅ Always offline |
| **Distribution** | Browser URL | .dmg/.msi/.deb | App Store | Binary |
| **Bundle size** | ~500KB WASM | ~10MB binary | ~30MB APK | ~5MB binary |
| **Performance** | Good | Excellent | Good | Excellent |
| **Maturity (Dioxus)** | ✅ Stable | ✅ Stable | ⚠️ Beta | ⚠️ Experimental |

---

## 🏗️ Recommended Project Structure (Full Cross-Platform)

```
my-pdms/
├── Cargo.toml               ← workspace
├── Dioxus.toml              ← Dioxus config
│
├── app/                     ← shared app code
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── components/      ← shared components
│       │   ├── mod.rs
│       │   ├── doc_list.rs
│       │   ├── doc_form.rs
│       │   └── shared/
│       ├── state/           ← global state
│       │   ├── store.rs
│       │   └── actions.rs
│       ├── api/             ← API calls (shared)
│       │   ├── documents.rs
│       │   └── users.rs
│       └── platform/        ← platform abstraction
│           ├── mod.rs
│           ├── web.rs
│           └── native.rs
│
├── web/                     ← web-specific
│   ├── Cargo.toml
│   └── src/main.rs
│
├── desktop/                 ← desktop-specific
│   ├── Cargo.toml
│   └── src/main.rs
│
├── mobile/                  ← mobile-specific
│   ├── Cargo.toml
│   └── src/main.rs
│
└── tui/                     ← TUI (ratatui)
    ├── Cargo.toml
    └── src/main.rs
```

---

## 📝 Exercises

1. **Desktop file browser**: App desktop với sidebar navigation + file list. Dùng `rfd` để pick folder, list files, click để xem content. Dùng `notify` crate để watch folder changes.

2. **Mobile-responsive layout**: Tạo layout tự adapt giữa mobile (tab bar bottom + stack navigation) và desktop (sidebar + main content). Detect platform bằng `cfg`.

3. **TUI document viewer**: Ratatui app với 3 panels: (1) document list, (2) document detail, (3) action log. vim-style navigation (j/k), Enter để select, q để quit.

4. **Cross-platform notification**: Implement `Platform` trait cho cả Web và Desktop. Component `NotificationButton` dùng trait object — compile và chạy được trên cả hai platform.

5. **Shared state across windows** (Desktop): Dioxus desktop mở 2 cửa sổ — danh sách documents + detail viewer. Khi click document trong cửa sổ 1, cửa sổ 2 update. Dùng `Arc<Mutex<>>` + channel.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-37-Dioxus-Advanced|Bài 37: Dioxus Advanced]] ← prerequisite
- [[Rust-Zero-To-Hero/Bai-36-Dioxus-Core|Bài 36: Dioxus Core]] ← foundation
- [[Rust-Zero-To-Hero/Bai-29-Leptos|Bài 29: Leptos]] — web-only alternative
- [[Rust-Zero-To-Hero/Plan-Framework-Mastery|Framework Mastery Plan]]
