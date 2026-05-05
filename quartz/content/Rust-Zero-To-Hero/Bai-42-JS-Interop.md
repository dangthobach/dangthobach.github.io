---
tags: [rust, leptos, dioxus, wasm, wasm-bindgen, web-sys, js-interop, chartjs, d3, production]
prerequisites: [Bai-41-Auth-SSR]
next: Bai-43-Form-Validation
---

# Bài 42: JS Interop — wasm-bindgen, web-sys & Gọi Chart.js / D3

> **Áp dụng cho:** Leptos · Dioxus (cả 2 đều compile sang WASM)  
> **Mục tiêu:** Gọi JS libraries từ Rust, dùng Web APIs, tích hợp Chart.js & D3.js

---

## 🗺️ Bức Tranh Tổng Quan

```
Tại sao cần JS Interop?

  WASM (Rust) KHÔNG thể trực tiếp:
  ├── Gọi JavaScript functions
  ├── Truy cập DOM APIs (window, document, localStorage)
  ├── Dùng JS libraries (Chart.js, D3, Leaflet, etc.)
  └── Xử lý events từ JS world

  Giải pháp: wasm-bindgen tạo "bridge":

  ┌──────────────────────────────────────────────────┐
  │                  RUST/WASM                       │
  │                                                  │
  │   web_sys::window()                              │
  │   web_sys::Document                              │
  │   js_sys::eval("...")                            │
  │   #[wasm_bindgen] extern "C" { ... }             │
  └────────────────────┬─────────────────────────────┘
                       │  wasm-bindgen bridge
  ┌────────────────────▼─────────────────────────────┐
  │                 JavaScript                        │
  │                                                  │
  │   window.localStorage                            │
  │   document.querySelector()                       │
  │   new Chart(ctx, config)                         │
  │   d3.select("#chart")                            │
  └──────────────────────────────────────────────────┘

Layer của crate:
  wasm-bindgen  ← Low-level bridge (Rust ↔ JS types)
  js-sys        ← JS built-in types (Array, Promise, Date, JSON...)
  web-sys       ← Web APIs (Window, Document, Canvas, Fetch, WebSocket...)
  gloo          ← High-level wrappers (dễ dùng hơn web-sys)
```

---

## PHẦN 1 — Cơ Bản wasm-bindgen

### 1.1 Setup

```toml
# Cargo.toml
[dependencies]
wasm-bindgen = "0.2"
js-sys = "0.3"
web-sys = { version = "0.3", features = [
    # Chỉ enable features cần dùng — giảm bundle size
    "Window",
    "Document",
    "Element",
    "HtmlElement",
    "HtmlCanvasElement",
    "CanvasRenderingContext2d",
    "Storage",          # localStorage, sessionStorage
    "Navigator",        # geolocation, clipboard
    "Geolocation",
    "console",
    "Performance",
    "EventTarget",
    "MouseEvent",
    "KeyboardEvent",
    "CustomEvent",
    "WebSocket",
    "MessageEvent",
]}
gloo = { version = "0.11", features = ["timers", "storage", "events"] }
```

### 1.2 web-sys — Web APIs từ Rust

```rust
use wasm_bindgen::prelude::*;
use web_sys::{window, console};

// --- console.log ---
pub fn log(msg: &str) {
    console::log_1(&JsValue::from_str(msg));
}

// --- localStorage ---
pub fn local_storage_set(key: &str, value: &str) -> Result<(), JsValue> {
    window()
        .unwrap()
        .local_storage()?
        .unwrap()
        .set_item(key, value)
}

pub fn local_storage_get(key: &str) -> Option<String> {
    window()
        .ok()?
        .local_storage().ok()??
        .get_item(key).ok()?
}

// --- window.performance.now() ---
pub fn now_ms() -> f64 {
    window().unwrap().performance().unwrap().now()
}

// --- Geolocation ---
pub fn get_location() {
    let navigator = window().unwrap().navigator();
    let geolocation = navigator.geolocation().unwrap();

    let success_cb = Closure::wrap(Box::new(|position: web_sys::Position| {
        let coords = position.coords();
        log(&format!("Lat: {}, Lng: {}", coords.latitude(), coords.longitude()));
    }) as Box<dyn FnMut(web_sys::Position)>);

    geolocation.get_current_position(success_cb.as_ref().unchecked_ref()).unwrap();
    success_cb.forget(); // Prevent drop — JS cần giữ closure alive
}

// --- Clipboard API ---
pub async fn copy_to_clipboard(text: &str) -> Result<(), JsValue> {
    let navigator = window().unwrap().navigator();
    let clipboard = navigator.clipboard().unwrap();
    let promise = clipboard.write_text(text);
    wasm_bindgen_futures::JsFuture::from(promise).await?;
    Ok(())
}
```

### 1.3 Gọi JS Functions Tùy Chỉnh

```rust
use wasm_bindgen::prelude::*;

// Khai báo JS functions muốn gọi từ Rust
#[wasm_bindgen]
extern "C" {
    // Gọi function JS có sẵn
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);

    // Gọi function trong global scope
    #[wasm_bindgen(js_name = "showToast")]
    fn show_toast(message: &str, level: &str);

    // Gọi method của JS object
    type ChartJs;
    #[wasm_bindgen(constructor, js_namespace = Chart)]
    fn new(canvas: &web_sys::HtmlCanvasElement, config: &JsValue) -> ChartJs;
    #[wasm_bindgen(method)]
    fn update(this: &ChartJs);
    #[wasm_bindgen(method)]
    fn destroy(this: &ChartJs);
}

// Expose Rust function sang JS
#[wasm_bindgen]
pub fn greet_from_rust(name: &str) -> String {
    format!("Xin chào {} từ Rust/WASM!", name)
}

// Struct expose sang JS
#[wasm_bindgen]
pub struct Calculator {
    value: f64,
}

#[wasm_bindgen]
impl Calculator {
    #[wasm_bindgen(constructor)]
    pub fn new(initial: f64) -> Self {
        Self { value: initial }
    }

    pub fn add(&mut self, n: f64) -> f64 {
        self.value += n;
        self.value
    }

    pub fn get_value(&self) -> f64 {
        self.value
    }
}
```

---

## PHẦN 2 — Chart.js Integration

### 2.1 Setup Chart.js

```html
<!-- index.html — load Chart.js trước WASM bundle -->
<!DOCTYPE html>
<html>
<head>
    <!-- Chart.js từ CDN -->
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
</head>
<body>
    <div id="app"></div>
    <!-- WASM bundle load sau -->
</body>
</html>
```

### 2.2 Leptos — Chart Component

```rust
use leptos::prelude::*;
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;
use js_sys::Object;

// Khai báo Chart.js API
#[wasm_bindgen]
extern "C" {
    type ChartInstance;

    #[wasm_bindgen(js_name = "Chart")]
    type Chart;

    #[wasm_bindgen(constructor, js_name = "Chart")]
    fn new_chart(canvas: &HtmlCanvasElement, config: &JsValue) -> ChartInstance;

    #[wasm_bindgen(method, js_name = "update")]
    fn update(this: &ChartInstance);

    #[wasm_bindgen(method, js_name = "destroy")]
    fn destroy(this: &ChartInstance);
}

#[derive(Clone, Debug)]
pub struct ChartData {
    pub labels: Vec<String>,
    pub values: Vec<f64>,
    pub label: String,
}

// Leptos component bọc Chart.js
#[component]
pub fn LineChart(data: ReadSignal<ChartData>) -> impl IntoView {
    let canvas_ref = NodeRef::<leptos::html::Canvas>::new();
    // Lưu chart instance để update/destroy
    let chart_instance: StoredValue<Option<ChartInstance>> = StoredValue::new(None);

    // Khởi tạo chart khi canvas mount
    Effect::new(move |_| {
        let canvas = canvas_ref.get()?;
        let chart_data = data.get();

        // Destroy chart cũ nếu có
        chart_instance.update_value(|c| {
            if let Some(chart) = c.take() { chart.destroy(); }
        });

        // Build config object dùng js_sys
        let config = build_line_chart_config(&chart_data);

        let instance = new_chart(&canvas, &config);
        chart_instance.set_value(Some(instance));

        Some(())
    });

    // Cleanup khi component unmount
    on_cleanup(move || {
        chart_instance.update_value(|c| {
            if let Some(chart) = c.take() { chart.destroy(); }
        });
    });

    view! {
        <div class="chart-container" style="position: relative; height: 400px;">
            <canvas node_ref=canvas_ref />
        </div>
    }
}

// Build Chart.js config object từ Rust
fn build_line_chart_config(data: &ChartData) -> JsValue {
    // Dùng serde_wasm_bindgen để convert Rust struct → JS object
    let labels: js_sys::Array = data.labels.iter()
        .map(|l| JsValue::from_str(l))
        .collect();

    let values: js_sys::Array = data.values.iter()
        .map(|v| JsValue::from_f64(*v))
        .collect();

    // Build config as JSON string rồi parse (đơn giản hơn)
    let config_json = serde_json::json!({
        "type": "line",
        "data": {
            "labels": data.labels,
            "datasets": [{
                "label": data.label,
                "data": data.values,
                "borderColor": "rgb(75, 192, 192)",
                "backgroundColor": "rgba(75, 192, 192, 0.2)",
                "tension": 0.1,
                "fill": true,
            }]
        },
        "options": {
            "responsive": true,
            "maintainAspectRatio": false,
            "plugins": {
                "legend": { "position": "top" },
                "title": {
                    "display": true,
                    "text": data.label,
                }
            },
            "scales": {
                "y": { "beginAtZero": true }
            }
        }
    });

    js_sys::JSON::parse(&config_json.to_string()).unwrap()
}

// Dùng LineChart component
#[component]
fn DocumentTrends() -> impl IntoView {
    let (chart_data, set_chart_data) = signal(ChartData {
        labels: vec!["T1", "T2", "T3", "T4", "T5", "T6"]
            .into_iter().map(String::from).collect(),
        values: vec![45.0, 67.0, 89.0, 120.0, 98.0, 145.0],
        label: "Hồ sơ xử lý theo tháng".to_string(),
    });

    // Cập nhật chart khi có data mới từ server
    let data_resource = Resource::new(
        || (),
        |_| fetch_chart_data(),
    );

    Effect::new(move |_| {
        if let Some(Ok(new_data)) = data_resource.get() {
            set_chart_data.set(new_data);
        }
    });

    view! {
        <div class="dashboard-section">
            <h2>"Xu hướng xử lý hồ sơ"</h2>
            <LineChart data=chart_data />
        </div>
    }
}
```

### 2.3 Dioxus — Chart Component

```rust
use dioxus::prelude::*;
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

#[derive(Clone, Debug, PartialEq)]
pub struct ChartData {
    pub labels: Vec<String>,
    pub values: Vec<f64>,
    pub label: String,
}

#[component]
pub fn BarChart(data: Signal<ChartData>) -> Element {
    let canvas_id = "bar-chart-canvas";

    // Dioxus dùng use_effect để init chart sau khi DOM mount
    use_effect(move || {
        // Lấy canvas element
        let window = web_sys::window().unwrap();
        let document = window.document().unwrap();

        if let Some(canvas) = document.get_element_by_id(canvas_id) {
            let canvas: HtmlCanvasElement = canvas.dyn_into().unwrap();
            let chart_data = data.read().clone();
            let config = build_bar_chart_config(&chart_data);

            // Gọi Chart.js
            let _ = js_sys::eval(&format!(
                r#"
                // Destroy previous chart if exists
                if (window.__pdms_chart) {{
                    window.__pdms_chart.destroy();
                }}
                window.__pdms_chart = new Chart(
                    document.getElementById('{}'),
                    {}
                );
                "#,
                canvas_id,
                config
            ));
        }
    });

    rsx! {
        div { class: "chart-wrapper",
            canvas { id: canvas_id, style: "max-height: 400px;" }
        }
    }
}

fn build_bar_chart_config(data: &ChartData) -> String {
    serde_json::json!({
        "type": "bar",
        "data": {
            "labels": data.labels,
            "datasets": [{
                "label": data.label,
                "data": data.values,
                "backgroundColor": [
                    "rgba(255,99,132,0.5)", "rgba(54,162,235,0.5)",
                    "rgba(255,206,86,0.5)", "rgba(75,192,192,0.5)",
                    "rgba(153,102,255,0.5)", "rgba(255,159,64,0.5)",
                ],
                "borderWidth": 1,
            }]
        },
        "options": {
            "responsive": true,
            "scales": { "y": { "beginAtZero": true } }
        }
    }).to_string()
}
```

---

## PHẦN 3 — D3.js Integration

### 3.1 D3 Setup & Bindings

```html
<!-- index.html -->
<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
```

```rust
use wasm_bindgen::prelude::*;

// Khai báo D3 functions cần dùng
#[wasm_bindgen(module = "/assets/d3-bridge.js")]
extern "C" {
    // Bridge functions trong JS wrapper
    fn d3_render_pie_chart(container_id: &str, data_json: &str);
    fn d3_render_force_graph(container_id: &str, nodes_json: &str, links_json: &str);
    fn d3_clear(container_id: &str);
}
```

```javascript
// assets/d3-bridge.js — JS wrapper, gọi được từ Rust

export function d3_render_pie_chart(containerId, dataJson) {
    const data = JSON.parse(dataJson);
    const container = document.getElementById(containerId);
    if (!container) return;

    // Clear previous
    d3.select(`#${containerId}`).selectAll("*").remove();

    const width = 400, height = 400, radius = Math.min(width, height) / 2;
    const svg = d3.select(`#${containerId}`)
        .append("svg")
        .attr("width", width).attr("height", height)
        .append("g")
        .attr("transform", `translate(${width/2},${height/2})`);

    const color = d3.scaleOrdinal(d3.schemeCategory10);
    const pie = d3.pie().value(d => d.value);
    const arc = d3.arc().innerRadius(0).outerRadius(radius);

    svg.selectAll("path")
        .data(pie(data))
        .join("path")
        .attr("d", arc)
        .attr("fill", (d, i) => color(i))
        .attr("stroke", "white")
        .style("stroke-width", "2px");

    // Labels
    svg.selectAll("text")
        .data(pie(data))
        .join("text")
        .attr("transform", d => `translate(${arc.centroid(d)})`)
        .attr("text-anchor", "middle")
        .attr("font-size", "12px")
        .text(d => d.data.label);
}

export function d3_clear(containerId) {
    d3.select(`#${containerId}`).selectAll("*").remove();
}
```

### 3.2 Leptos — D3 Pie Chart Component

```rust
use leptos::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PieSlice {
    pub label: String,
    pub value: f64,
}

#[component]
pub fn PieChart(data: ReadSignal<Vec<PieSlice>>) -> impl IntoView {
    let container_id = "d3-pie-chart";

    // Re-render khi data thay đổi
    Effect::new(move |_| {
        let slices = data.get();
        if slices.is_empty() { return; }

        let json = serde_json::to_string(&slices).unwrap_or_default();
        d3_render_pie_chart(container_id, &json);
    });

    on_cleanup(move || {
        d3_clear(container_id);
    });

    view! {
        <div id=container_id class="d3-chart" />
    }
}

// Dùng trong dashboard
#[component]
fn DocumentStatusChart() -> impl IntoView {
    let status_data = Resource::new(
        || (),
        |_| async move {
            // Lấy data từ server
            vec![
                PieSlice { label: "Bản nháp".to_string(), value: 45.0 },
                PieSlice { label: "Chờ duyệt".to_string(), value: 23.0 },
                PieSlice { label: "Đã duyệt".to_string(), value: 89.0 },
                PieSlice { label: "Từ chối".to_string(), value: 12.0 },
            ]
        },
    );

    let (pie_data, set_pie_data) = signal(vec![]);

    Effect::new(move |_| {
        if let Some(data) = status_data.get() {
            set_pie_data.set(data);
        }
    });

    view! {
        <section class="chart-section">
            <h3>"Phân bố trạng thái hồ sơ"</h3>
            <Suspense fallback=|| view! { <div class="skeleton chart-skeleton" /> }>
                <PieChart data=pie_data />
            </Suspense>
        </section>
    }
}
```

---

## PHẦN 4 — Web APIs Hữu Ích

### 4.1 localStorage — Persist State

```rust
use gloo::storage::{LocalStorage, Storage};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct UserPreferences {
    pub theme: String,
    pub language: String,
    pub items_per_page: u32,
    pub sidebar_collapsed: bool,
}

const PREFS_KEY: &str = "pdms_user_preferences";

pub fn load_preferences() -> UserPreferences {
    LocalStorage::get(PREFS_KEY).unwrap_or_default()
}

pub fn save_preferences(prefs: &UserPreferences) {
    let _ = LocalStorage::set(PREFS_KEY, prefs);
}

// Leptos — auto-persist preference
#[component]
fn ThemeToggle() -> impl IntoView {
    let (prefs, set_prefs) = signal(load_preferences());

    Effect::new(move |_| {
        save_preferences(&prefs.get());
    });

    view! {
        <button on:click=move |_| {
            set_prefs.update(|p| {
                p.theme = if p.theme == "dark" {
                    "light".to_string()
                } else {
                    "dark".to_string()
                };
            });
        }>
            {move || if prefs.get().theme == "dark" { "☀️ Sáng" } else { "🌙 Tối" }}
        </button>
    }
}
```

### 4.2 WebSocket từ Rust/WASM

```rust
use wasm_bindgen::prelude::*;
use web_sys::{WebSocket, MessageEvent};
use leptos::prelude::*;

#[component]
fn LiveUpdates() -> impl IntoView {
    let (messages, set_messages) = signal(Vec::<String>::new());
    let (ws_status, set_ws_status) = signal("Đang kết nối...".to_string());

    // Khởi tạo WebSocket
    Effect::new(move |_| {
        let ws = WebSocket::new("wss://api.vpbank.com/ws/updates").unwrap();

        // onopen
        let status_clone = set_ws_status.clone();
        let on_open = Closure::wrap(Box::new(move |_: JsValue| {
            status_clone.set("Đã kết nối".to_string());
        }) as Box<dyn FnMut(JsValue)>);
        ws.set_onopen(Some(on_open.as_ref().unchecked_ref()));
        on_open.forget();

        // onmessage
        let msgs_clone = set_messages.clone();
        let on_message = Closure::wrap(Box::new(move |event: MessageEvent| {
            if let Ok(text) = event.data().dyn_into::<js_sys::JsString>() {
                let msg: String = text.into();
                msgs_clone.update(|m| {
                    m.insert(0, msg);
                    if m.len() > 50 { m.truncate(50); } // Giữ 50 tin gần nhất
                });
            }
        }) as Box<dyn FnMut(MessageEvent)>);
        ws.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
        on_message.forget();

        // onclose
        let status_close = set_ws_status.clone();
        let on_close = Closure::wrap(Box::new(move |_: JsValue| {
            status_close.set("Mất kết nối".to_string());
        }) as Box<dyn FnMut(JsValue)>);
        ws.set_onclose(Some(on_close.as_ref().unchecked_ref()));
        on_close.forget();
    });

    view! {
        <div class="live-updates">
            <div class="ws-status">{ws_status}</div>
            <ul>
                {move || messages.get().into_iter()
                    .map(|msg| view! { <li>{msg}</li> })
                    .collect_view()}
            </ul>
        </div>
    }
}
```

### 4.3 js_sys::eval — Thoát Nhanh

```rust
use wasm_bindgen::prelude::*;

// Khi không muốn viết binding đầy đủ, eval JS string thẳng
// ❌ Không nên dùng nhiều (khó debug, type-unsafe)
// ✅ Hợp lý cho quick integration hoặc third-party lib phức tạp

pub fn show_notification(title: &str, body: &str) {
    let script = format!(
        r#"
        if ('Notification' in window && Notification.permission === 'granted') {{
            new Notification('{}', {{ body: '{}' }});
        }}
        "#,
        title.replace('\'', "\\'"),
        body.replace('\'', "\\'"),
    );
    let _ = js_sys::eval(&script);
}

pub fn print_document() {
    let _ = js_sys::eval("window.print()");
}

pub fn scroll_to_top() {
    let _ = js_sys::eval("window.scrollTo({ top: 0, behavior: 'smooth' })");
}

// Dioxus — eval thông qua built-in eval()
use dioxus::prelude::*;

#[component]
fn PrintButton() -> Element {
    rsx! {
        button {
            onclick: move |_| async move {
                // Dioxus có eval() built-in, tiện hơn wasm_bindgen::eval
                let _ = eval("window.print()");
            },
            "🖨️ In trang"
        }
    }
}
```

---

## 💡 Tips & Tricks

```
TIP 1 — web-sys features → bundle size
  Mỗi web-sys feature thêm vào bundle size.
  Chỉ enable features cần dùng:
  
  web-sys = { version = "0.3", features = [
      "Window",       ← ~2KB
      "Document",     ← ~3KB
      "HtmlElement",  ← ~5KB
      "WebSocket",    ← ~8KB
  ]}
  
  Dùng wasm-opt sau build để shrink thêm:
  wasm-opt -Oz -o output.wasm input.wasm

TIP 2 — Closure::forget() — memory leak có chủ ý
  JS callbacks cần sống lâu hơn Rust closure.
  closure.forget() = leak memory có chủ ý để JS giữ callback.
  
  Chỉ forget() khi:
  - Event listener cần tồn tại suốt vòng đời page
  - WebSocket handlers
  
  Nếu cần cleanup:
  let closure = Closure::wrap(Box::new(handler) as Box<dyn FnMut(_)>);
  element.add_event_listener_with_callback("click", closure.as_ref().unchecked_ref());
  // Giữ closure trong state, drop khi component unmount

TIP 3 — js_sys::eval vs wasm_bindgen extern
  eval()        → Nhanh, dễ, khó test, runtime error
  extern "C"    → Type-safe, compile-time check, cần viết binding

  Quy tắc:
  eval() → prototype / 1-off scripts / third-party phức tạp
  extern → production code, reusable components

TIP 4 — Leptos NodeRef để access DOM element
  let canvas_ref = NodeRef::<leptos::html::Canvas>::new();
  view! { <canvas node_ref=canvas_ref /> }
  
  // Trong Effect:
  if let Some(canvas) = canvas_ref.get() {
      // canvas là HtmlCanvasElement — full web-sys access
      let ctx = canvas.get_context("2d").unwrap()...;
  }

TIP 5 — Dioxus eval() built-in
  // Dioxus có eval() function tiện hơn wasm-bindgen eval
  let result = eval("document.title").await;
  
  // Truyền data từ Rust vào JS:
  eval(r#"
      const data = await dioxus.recv();
      console.log('Got from Rust:', data);
  "#);
  // Chưa stable trong Dioxus 0.6, verify trước khi dùng
```

---

## 📝 Exercises

1. **Chart Dashboard**: Tạo dashboard Leptos với 3 biểu đồ (Line: xu hướng theo tháng, Bar: phân loại document, Pie: trạng thái). Data load từ server function. Charts update khi date range filter thay đổi.

2. **LocalStorage Theme**: Implement theme (dark/light) persist qua localStorage với gloo::storage. Load preference khi app start. Theme thay đổi → save ngay lập tức. Test bằng cách refresh page.

3. **WebSocket Live Feed**: Dioxus component hiển thị live notifications qua WebSocket. Kết nối khi component mount, disconnect khi unmount. Hiển thị status (connecting/connected/disconnected) và list 20 messages gần nhất.

4. **D3 Interactive Chart**: D3 force-directed graph cho document relationships (document A → references → document B). Click node để xem document detail. Highlight connected nodes khi hover.

5. **JS Library Binding**: Viết full wasm-bindgen bindings cho Leaflet.js (bản đồ). Component `<Map center={lat, lng} zoom={13}>` render bản đồ tương tác. Thêm markers từ Rust data.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-41-Auth-SSR|Bài 41: Auth SSR]] ← trước đó
- [[Rust-Zero-To-Hero/Bai-29-Leptos|Bài 29: Leptos]] — NodeRef, lifecycle
- [[Rust-Zero-To-Hero/Bai-36-Dioxus-Core|Bài 36: Dioxus Core]] — use_effect
- [[Rust-Zero-To-Hero/Bai-43-Form-Validation|Bài 43: Form & Validation]] → tiếp theo
