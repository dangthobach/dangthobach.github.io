---
tags: [rust, leptos, dioxus, tailwindcss, styling, css, build-pipeline, production]
prerequisites: [Bai-43-Form-Validation]
next: Bai-45-Background-Caching
---

# Bài 44: Styling Pipeline — Tailwind + Leptos/Dioxus

> **Áp dụng cho:** Leptos (cargo-leptos) · Dioxus (dx CLI)  
> **Mục tiêu:** Setup Tailwind đúng cách, CSS-in-Rust patterns, dark mode, responsive design

---

## 🗺️ Bức Tranh Tổng Quan

```
Styling trong Rust frontend — các lựa chọn:

  Option 1: Plain CSS / SCSS
  ├── File .css bên ngoài
  ├── Import trong HTML shell
  └── Đơn giản nhất, không type-safe

  Option 2: Tailwind CSS ← Recommended
  ├── Utility classes trong RSX/rsx!
  ├── PurgeCSS tự động loại unused classes
  └── Bundle nhỏ trong production

  Option 3: CSS Modules (hạn chế support)
  ├── Scoped styles per component
  └── Cần plugin bổ sung

  Option 4: CSS-in-Rust (stylers crate — Leptos)
  ├── Type-safe CSS trong Rust code
  └── Compile-time class generation

─────────────────────────────────────────────────────────────────

Build Pipeline:

  Leptos (cargo-leptos):
  ┌─────────────────────────────────────────────┐
  │  cargo leptos watch                          │
  │                                             │
  │  Rust compiler → WASM + Server binary        │
  │  Tailwind CLI → Scan RSX → Generate CSS      │
  │  cargo-leptos → Bundle assets                │
  └─────────────────────────────────────────────┘

  Dioxus (dx):
  ┌─────────────────────────────────────────────┐
  │  dx serve                                    │
  │                                             │
  │  Rust compiler → WASM bundle                 │
  │  Tailwind CLI (separate process) → CSS       │
  │  dx → Serve + HMR                            │
  └─────────────────────────────────────────────┘
```

---

## PHẦN 1 — Tailwind + Leptos

### 1.1 Setup

```bash
# Install Tailwind CLI
npm install -D tailwindcss
npx tailwindcss init

# Hoặc dùng standalone binary (không cần Node)
curl -sLO https://github.com/tailwindlabs/tailwindcss/releases/latest/download/tailwindcss-linux-x64
chmod +x tailwindcss-linux-x64
mv tailwindcss-linux-x64 ~/.local/bin/tailwindcss
```

```javascript
// tailwind.config.js
/** @type {import('tailwindcss').Config} */
module.exports = {
  // Leptos: scan .rs files để tìm class names
  content: [
    "./src/**/*.rs",
    "./index.html",
  ],
  // Dark mode qua class (toggle bằng Rust/JS)
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Brand colors PDMS
        primary: {
          50:  '#eff6ff',
          500: '#3b82f6',
          600: '#2563eb',
          900: '#1e3a8a',
        },
        vpbank: {
          green: '#00923f',
          dark:  '#004d1f',
        }
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),      // Form styling
    require('@tailwindcss/typography'), // Prose styling
  ],
}
```

```css
/* style/input.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

/* Custom component classes — dùng @apply */
@layer components {
  .btn {
    @apply px-4 py-2 rounded-lg font-medium transition-colors duration-200 cursor-pointer;
  }
  .btn-primary {
    @apply btn bg-primary-600 text-white hover:bg-primary-700 
           disabled:opacity-50 disabled:cursor-not-allowed;
  }
  .btn-outline {
    @apply btn border border-primary-600 text-primary-600 
           hover:bg-primary-50;
  }
  .btn-danger {
    @apply btn bg-red-600 text-white hover:bg-red-700;
  }
  
  .card {
    @apply bg-white rounded-xl shadow-sm border border-gray-200 p-6;
  }
  
  .field {
    @apply flex flex-col gap-1 mb-4;
  }
  .field label {
    @apply text-sm font-medium text-gray-700;
  }
  .field input,
  .field select,
  .field textarea {
    @apply rounded-lg border border-gray-300 px-3 py-2 text-sm
           focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent;
  }
  .field .error {
    @apply text-xs text-red-600 mt-1;
  }
  
  .badge {
    @apply inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium;
  }
  .badge-draft    { @apply badge bg-gray-100 text-gray-800; }
  .badge-pending  { @apply badge bg-yellow-100 text-yellow-800; }
  .badge-approved { @apply badge bg-green-100 text-green-800; }
  .badge-rejected { @apply badge bg-red-100 text-red-800; }
}
```

### 1.2 Leptos.toml — Build Config

```toml
# Leptos.toml
[package]
name = "pdms-web"

[[workspace]]

[lib]
output-name = "pdms_web"

[site]
pkg-dir = "pkg"
site-root = "target/site"
site-addr = "127.0.0.1:3000"

# Tailwind integration
[site.tailwind]
input-file = "style/input.css"   # Source CSS
# Output được cargo-leptos tự manage

[profile.release]
codegen-units = 1
lto = true
opt-level = 'z'  # Optimize cho bundle size
```

```bash
# Development — hot reload Rust + Tailwind
cargo leptos watch

# Tailwind watch riêng (terminal khác nếu cần)
npx tailwindcss -i style/input.css -o target/site/pkg/pdms.css --watch

# Production build
cargo leptos build --release
```

### 1.3 Sử Dụng Tailwind trong Leptos

```rust
use leptos::prelude::*;

// Utility: conditional classes helper
fn cx(classes: &[(&str, bool)]) -> String {
    classes.iter()
        .filter(|(_, active)| *active)
        .map(|(cls, _)| *cls)
        .collect::<Vec<_>>()
        .join(" ")
}

// Component với Tailwind classes
#[component]
fn DocumentCard(
    doc: Document,
    selected: bool,
) -> impl IntoView {
    view! {
        <div class=cx(&[
            ("card cursor-pointer transition-shadow", true),
            ("ring-2 ring-primary-500", selected),
            ("hover:shadow-md", !selected),
        ])>
            // Header
            <div class="flex items-center justify-between mb-3">
                <h3 class="font-semibold text-gray-900 truncate flex-1">
                    {doc.title.clone()}
                </h3>
                <span class=match doc.status.as_str() {
                    "DRAFT"    => "badge-draft",
                    "PENDING"  => "badge-pending",
                    "APPROVED" => "badge-approved",
                    _          => "badge-rejected",
                }>
                    {doc.status.clone()}
                </span>
            </div>

            // Body
            <p class="text-sm text-gray-500 line-clamp-2">
                {doc.description.clone().unwrap_or_default()}
            </p>

            // Footer
            <div class="flex items-center justify-between mt-4 pt-3 border-t border-gray-100">
                <span class="text-xs text-gray-400">
                    {doc.created_at.clone()}
                </span>
                <div class="flex gap-2">
                    <button class="btn-outline text-xs px-2 py-1">"Xem"</button>
                    <button class="btn-primary text-xs px-2 py-1">"Sửa"</button>
                </div>
            </div>
        </div>
    }
}

// Responsive layout
#[component]
fn DashboardLayout() -> impl IntoView {
    view! {
        <div class="min-h-screen bg-gray-50">
            // Navbar
            <nav class="bg-white border-b border-gray-200 px-4 py-3">
                <div class="max-w-7xl mx-auto flex items-center justify-between">
                    <span class="font-bold text-xl text-vpbank-green">"PDMS"</span>
                    <div class="hidden md:flex items-center gap-4">
                        // Desktop nav items
                    </div>
                    <button class="md:hidden">"☰"</button> // Mobile menu
                </div>
            </nav>

            // Main content
            <div class="max-w-7xl mx-auto px-4 py-6">
                // Responsive grid
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    // Document cards
                </div>
            </div>
        </div>
    }
}
```

### 1.4 Dark Mode

```rust
use leptos::prelude::*;
use gloo::storage::{LocalStorage, Storage};

const THEME_KEY: &str = "theme";

// Dark mode toggle — dùng class strategy
#[component]
fn ThemeToggle() -> impl IntoView {
    let (dark, set_dark) = signal(
        LocalStorage::get::<bool>(THEME_KEY).unwrap_or(false)
    );

    // Apply class tới <html> element khi dark thay đổi
    Effect::new(move |_| {
        let is_dark = dark.get();
        let _ = LocalStorage::set(THEME_KEY, is_dark);

        let document = web_sys::window().unwrap().document().unwrap();
        let html = document.document_element().unwrap();
        if is_dark {
            html.class_list().add_1("dark").unwrap();
        } else {
            html.class_list().remove_1("dark").unwrap();
        }
    });

    view! {
        <button
            class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            title=move || if dark.get() { "Chuyển sáng" } else { "Chuyển tối" }
            on:click=move |_| set_dark.update(|d| *d = !*d)
        >
            {move || if dark.get() { "☀️" } else { "🌙" }}
        </button>
    }
}

// Dùng dark: prefix trong bất kỳ component nào
#[component]
fn DarkAwareCard() -> impl IntoView {
    view! {
        <div class="
            bg-white dark:bg-gray-800
            text-gray-900 dark:text-gray-100
            border border-gray-200 dark:border-gray-700
            rounded-xl shadow-sm p-6
        ">
            <h3 class="font-semibold mb-2">"Tiêu đề card"</h3>
            <p class="text-gray-500 dark:text-gray-400">"Nội dung..."</p>
        </div>
    }
}
```

---

## PHẦN 2 — Tailwind + Dioxus

### 2.1 Setup

```bash
# Tạo project
dx new my-app
cd my-app

# Setup Tailwind
npm init -y
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init
```

```javascript
// tailwind.config.js
module.exports = {
  content: [
    "./src/**/*.rs",
    "./index.html",
  ],
  darkMode: 'class',
  theme: { extend: {} },
  plugins: [require('@tailwindcss/forms')],
}
```

```toml
# Dioxus.toml
[application]
name = "my-pdms"
default_platform = "web"

[web.app]
base_path = "/"

[web.watcher]
# Reload khi CSS thay đổi
reload_html = true
watch_path = ["src", "style"]

# Chạy Tailwind cùng lúc với dx serve
[web.pre_compress]
wasm = true
index = true
```

```bash
# Terminal 1: Dioxus
dx serve

# Terminal 2: Tailwind watch
npx tailwindcss -i style/input.css -o assets/tailwind.css --watch

# Production
npx tailwindcss -i style/input.css -o assets/tailwind.css --minify
dx build --release
```

### 2.2 Sử Dụng Tailwind trong Dioxus

```rust
use dioxus::prelude::*;

// Helper macro cho conditional classes (Dioxus không có cx() built-in)
macro_rules! cls {
    ($($class:literal $(if $cond:expr)?),* $(,)?) => {{
        let mut classes = Vec::new();
        $(
            $(if $cond { })?
            {
                $( let _cond = $cond; )?
                #[allow(unused_variables)]
                let should_add = true $( && $cond )?;
                if should_add { classes.push($class); }
            }
        )*
        classes.join(" ")
    }};
}

#[component]
fn DioxusDocumentCard(doc: Document, selected: bool) -> Element {
    rsx! {
        div {
            class: cls!(
                "card cursor-pointer transition-all",
                "ring-2 ring-primary-500" if selected,
                "hover:shadow-lg" if !selected,
            ),
            // Header
            div { class: "flex items-center justify-between mb-3",
                h3 { class: "font-semibold text-gray-900 truncate", "{doc.title}" }
                span {
                    class: match doc.status.as_str() {
                        "APPROVED" => "badge-approved",
                        "PENDING"  => "badge-pending",
                        _          => "badge-draft",
                    },
                    "{doc.status}"
                }
            }
            // Actions
            div { class: "flex gap-2 mt-4",
                button { class: "btn-outline text-sm", "Xem" }
                button { class: "btn-primary text-sm", "Sửa" }
            }
        }
    }
}

// Responsive sidebar layout
#[component]
fn AppLayout() -> Element {
    let mut sidebar_open = use_signal(|| true);

    rsx! {
        div { class: "flex h-screen bg-gray-50",
            // Sidebar — hidden on mobile, show on md+
            div {
                class: cls!(
                    "fixed inset-y-0 left-0 z-50 w-64 bg-white shadow-lg",
                    "transform transition-transform duration-300",
                    "translate-x-0" if sidebar_open(),
                    "-translate-x-full" if !sidebar_open(),
                    "md:relative md:translate-x-0",
                ),
                SidebarContent {}
            }

            // Overlay for mobile
            if !sidebar_open() {
                div {
                    class: "md:hidden fixed inset-0 bg-black/50 z-40",
                    onclick: move |_| sidebar_open.set(true),
                }
            }

            // Main
            div { class: "flex-1 flex flex-col min-w-0",
                // Topbar
                header { class: "bg-white border-b px-4 py-3 flex items-center gap-4",
                    button {
                        class: "md:hidden p-2 rounded hover:bg-gray-100",
                        onclick: move |_| sidebar_open.toggle(),
                        "☰"
                    }
                    h1 { class: "font-semibold text-lg", "PDMS" }
                }
                // Content
                main { class: "flex-1 overflow-auto p-6",
                    Outlet::<Route> {}
                }
            }
        }
    }
}
```

---

## PHẦN 3 — CSS-in-Rust (stylers crate)

```toml
# Cargo.toml — Leptos only
stylers = { version = "0.2", features = ["leptos"] }
```

```rust
use leptos::prelude::*;
use stylers::style;

// Type-safe CSS — lỗi CSS được phát hiện lúc compile!
#[component]
fn StyledButton(label: String) -> impl IntoView {
    // style! macro generate scoped CSS class
    let class = style! {
        button {
            background-color: #2563eb;
            color: white;
            padding: 8px 16px;
            border-radius: 8px;
            border: none;
            cursor: pointer;
            font-weight: 500;
        }
        button:hover {
            background-color: #1d4ed8;
        }
        // Typo sẽ bị compile error:
        // background-collor: red;  ← ERROR ở đây
    };

    view! {
        <button class=class>{label}</button>
    }
}
```

---

## PHẦN 4 — Patterns Thực Tế PDMS

### 4.1 Design Token System

```css
/* style/tokens.css — Design tokens */
@layer base {
  :root {
    /* Colors */
    --color-primary:    #2563eb;
    --color-primary-dk: #1d4ed8;
    --color-success:    #16a34a;
    --color-warning:    #d97706;
    --color-danger:     #dc2626;
    --color-vpbank:     #00923f;

    /* Spacing */
    --space-xs:  0.25rem;
    --space-sm:  0.5rem;
    --space-md:  1rem;
    --space-lg:  1.5rem;
    --space-xl:  2rem;

    /* Typography */
    --text-xs:  0.75rem;
    --text-sm:  0.875rem;
    --text-base: 1rem;
    --text-lg:  1.125rem;
    --text-xl:  1.25rem;

    /* Border radius */
    --radius-sm: 4px;
    --radius-md: 8px;
    --radius-lg: 12px;

    /* Shadows */
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
    --shadow-md: 0 4px 6px rgba(0,0,0,0.07);
    --shadow-lg: 0 10px 15px rgba(0,0,0,0.1);
  }

  .dark {
    --color-primary: #60a5fa;
    /* Override tokens cho dark mode */
  }
}
```

### 4.2 Status Badge Component

```rust
use leptos::prelude::*;

#[derive(Clone, Debug, PartialEq)]
pub enum DocumentStatus {
    Draft,
    Pending,
    Approved,
    Rejected,
    Archived,
}

impl DocumentStatus {
    pub fn label(&self) -> &str {
        match self {
            Self::Draft    => "Bản nháp",
            Self::Pending  => "Chờ duyệt",
            Self::Approved => "Đã duyệt",
            Self::Rejected => "Từ chối",
            Self::Archived => "Lưu trữ",
        }
    }

    pub fn tailwind_class(&self) -> &str {
        match self {
            Self::Draft    => "bg-gray-100 text-gray-700",
            Self::Pending  => "bg-yellow-100 text-yellow-800",
            Self::Approved => "bg-green-100 text-green-800",
            Self::Rejected => "bg-red-100 text-red-800",
            Self::Archived => "bg-blue-100 text-blue-800",
        }
    }

    pub fn icon(&self) -> &str {
        match self {
            Self::Draft    => "✏️",
            Self::Pending  => "⏳",
            Self::Approved => "✅",
            Self::Rejected => "❌",
            Self::Archived => "📦",
        }
    }
}

#[component]
pub fn StatusBadge(status: DocumentStatus) -> impl IntoView {
    view! {
        <span class=format!(
            "inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium {}",
            status.tailwind_class()
        )>
            {status.icon()}
            {status.label()}
        </span>
    }
}
```

---

## 💡 Tips & Tricks

```
TIP 1 — Tailwind purging trong Rust
  Tailwind scan .rs files theo regex pattern cho strings.
  Nhưng dynamic class concatenation sẽ bị purge:
  
  ❌ BỊ PURGE — Tailwind không thấy full class name
  let color = "red";
  format!("bg-{}-500", color)
  
  ✅ AN TOÀN — full class name trong source
  let class = if is_error { "bg-red-500" } else { "bg-green-500" };
  
  ✅ AN TOÀN — safelist trong tailwind.config.js
  safelist: [
    { pattern: /bg-(red|green|yellow|blue)-(100|500|800)/ }
  ]

TIP 2 — Class ordering convention
  Giữ thứ tự nhất quán để dễ đọc:
  1. Layout:     flex, grid, block, hidden
  2. Sizing:     w-*, h-*, max-w-*
  3. Spacing:    p-*, m-*, gap-*
  4. Typography: text-*, font-*, leading-*
  5. Colors:     bg-*, text-*, border-*
  6. Effects:    shadow-*, ring-*, rounded-*
  7. States:     hover:*, focus:*, dark:*
  
  Tool: Prettier + prettier-plugin-tailwindcss tự sort.

TIP 3 — @apply trong component library
  Dùng @apply trong input.css để tạo reusable components:
  
  @layer components {
    .btn { @apply px-4 py-2 rounded-lg font-medium ...; }
    .btn-primary { @apply btn bg-primary text-white ...; }
  }
  
  Rồi trong Rust chỉ cần:
  <button class="btn-primary">...</button>
  
  Đừng lạm dụng @apply — mục tiêu của Tailwind là utility-first.
  Chỉ dùng @apply cho patterns lặp đi lặp lại nhiều lần.

TIP 4 — Bundle size optimization
  Production Tailwind tự purge unused classes.
  Thêm bước wasm-opt cho WASM bundle:
  
  # Leptos.toml
  [profile.release]
  opt-level = 'z'   # optimize size over speed
  lto = true
  
  # Sau build:
  wasm-opt -Oz target/site/pkg/pdms.wasm -o target/site/pkg/pdms.wasm
  
  Kết quả: CSS ~10KB (gzipped), WASM ~500KB (Leptos) / ~1MB (Dioxus)

TIP 5 — Font loading tốt nhất
  <!-- index.html -->
  <!-- Preconnect trước khi load font -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
  
  Hoặc self-host font trong assets/ để không phụ thuộc Google.
```

---

## 📝 Exercises

1. **Design System**: Tạo component library: Button (primary/outline/danger/ghost, size sm/md/lg), Badge (5 status), Card, Modal, Toast notification. Tất cả support dark mode.

2. **Responsive Dashboard**: Dashboard PDMS với sidebar collapsible, top bar, content grid. Mobile: bottom tab bar. Tablet: collapsed sidebar. Desktop: full sidebar. Breakpoints: sm/md/lg/xl.

3. **Dark Mode Persist**: Implement dark mode toggle với localStorage persist + system preference detection (`prefers-color-scheme`). System pref là default, user override được lưu.

4. **Animation**: Thêm transitions cho: sidebar open/close (slide), card hover (lift), toast appear (slide-in từ bottom), modal open (fade + scale), loading skeleton.

5. **Tailwind Config Custom**: Extend tailwind.config.js với VPBank brand colors, custom fonts (Inter), custom spacing scale. Viết Storybook-style page liệt kê tất cả tokens với preview.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-43-Form-Validation|Bài 43: Form Validation]] ← trước đó
- [[Rust-Zero-To-Hero/Bai-29-Leptos|Bài 29: Leptos]] — styling context
- [[Rust-Zero-To-Hero/Bai-36-Dioxus-Core|Bài 36: Dioxus Core]] — rsx styling
- [[Rust-Zero-To-Hero/Bai-45-Background-Caching|Bài 45: Background & Caching]] → tiếp theo
