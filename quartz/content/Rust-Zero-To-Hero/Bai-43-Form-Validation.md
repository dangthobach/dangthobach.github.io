---
tags: [rust, leptos, dioxus, forms, validation, file-upload, isomorphic, production]
prerequisites: [Bai-42-JS-Interop, Bai-39-Security-Production]
next: Bai-44-Styling-Pipeline
---

# Bài 43: Form Handling & Isomorphic Validation

> **Áp dụng cho:** Leptos · Dioxus  
> **Mục tiêu:** Forms phức tạp (nested, dynamic fields), file upload UX, isomorphic validation

---

## 🗺️ Bức Tranh Tổng Quan

```
Form Complexity Spectrum:

  Simple          Medium              Complex
  ─────────────────────────────────────────────────────
  Login form      Multi-step wizard   Nested fields
  Search bar      File upload         Dynamic add/remove rows
  Settings form   Dependent fields    Multi-file batch
                  Real-time validate  Cross-field validation

─────────────────────────────────────────────────────────────────

Isomorphic Validation — The Key Advantage:

  Truyền thống (React + REST):
  
    Client (JS)          Server (Java/Node)
    ─────────────────────────────────────────
    Validation logic A   Validation logic B
    (2 codebase riêng)
    
    Vấn đề:
    - Duplicate logic → drift theo thời gian
    - Client validate khác server → user confused

  Leptos / Dioxus + Shared Crate:
  
    shared/src/models.rs
    #[derive(Validate, Serialize, Deserialize)]
    struct Request { ... }   ← 1 lần define
    
    Client (WASM)            Server (Axum)
    ─────────────────────────────────────────
    request.validate()       request.validate()
    (CÙNG logic)             (CÙNG logic)
    
    ✅ Không bao giờ drift
    ✅ Type-safe end-to-end
```

---

## PHẦN 1 — Form Patterns Nâng Cao (Leptos)

### 1.1 Multi-Step Form (Wizard)

```rust
use leptos::prelude::*;
use serde::{Deserialize, Serialize};
use validator::Validate;

// State wizard
#[derive(Clone, Debug, Default)]
struct ContractWizardState {
    step: u32,
    // Step 1: Thông tin cơ bản
    basic: BasicInfo,
    // Step 2: Các bên liên quan
    parties: Vec<Party>,
    // Step 3: Điều khoản
    terms: TermsInfo,
    // Step 4: Tài liệu đính kèm
    attachments: Vec<AttachmentInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Validate)]
struct BasicInfo {
    #[validate(length(min = 5, max = 200, message = "Tiêu đề 5-200 ký tự"))]
    pub title: String,
    #[validate(custom(function = "validate_contract_type"))]
    pub contract_type: String,
    pub effective_date: String,
    pub expiry_date: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Validate)]
struct Party {
    #[validate(length(min = 2, message = "Tên tổ chức tối thiểu 2 ký tự"))]
    pub org_name: String,
    #[validate(email(message = "Email không hợp lệ"))]
    pub email: String,
    pub role: String,  // "PARTY_A" | "PARTY_B" | "GUARANTOR"
}

fn validate_contract_type(t: &str) -> Result<(), validator::ValidationError> {
    if ["SALE", "SERVICE", "LOAN", "LEASE", "OTHER"].contains(&t) {
        return Ok(());
    }
    Err(validator::ValidationError::new("invalid_type"))
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Validate)]
struct TermsInfo {
    #[validate(range(min = 0.0, max = 100.0, message = "Lãi suất 0-100%"))]
    pub interest_rate: Option<f64>,
    #[validate(length(max = 10000, message = "Điều khoản tối đa 10000 ký tự"))]
    pub terms_text: String,
    pub auto_renew: bool,
}

#[derive(Clone, Debug, Default)]
struct AttachmentInfo {
    pub name: String,
    pub size: u64,
    pub file_type: String,
}

// Multi-step form component
#[component]
fn ContractWizard() -> impl IntoView {
    let (state, set_state) = signal(ContractWizardState::default());
    let (errors, set_errors) = signal(Vec::<String>::new());

    let next_step = move |_| {
        let s = state.get();
        // Validate current step
        let valid = match s.step {
            0 => s.basic.validate().is_ok(),
            1 => !s.parties.is_empty() && s.parties.iter().all(|p| p.validate().is_ok()),
            2 => s.terms.validate().is_ok(),
            _ => true,
        };
        if valid {
            set_errors.set(vec![]);
            set_state.update(|s| s.step += 1);
        } else {
            set_errors.set(vec!["Vui lòng điền đầy đủ và đúng định dạng".to_string()]);
        }
    };

    let prev_step = move |_| {
        set_state.update(|s| if s.step > 0 { s.step -= 1; });
    };

    view! {
        <div class="wizard">
            // Progress bar
            <div class="wizard-steps">
                {(0u32..4).map(|i| view! {
                    <div class=move || {
                        let current = state.get().step;
                        if i < current { "step done" }
                        else if i == current { "step active" }
                        else { "step pending" }
                    }>
                        {match i {
                            0 => "Thông tin cơ bản",
                            1 => "Các bên liên quan",
                            2 => "Điều khoản",
                            _ => "Tài liệu đính kèm",
                        }}
                    </div>
                }).collect_view()}
            </div>

            // Error display
            {move || if !errors.get().is_empty() {
                view! {
                    <div class="alert-error">
                        {errors.get().join(", ")}
                    </div>
                }.into_any()
            } else { ().into_any() }}

            // Step content
            {move || match state.get().step {
                0 => view! { <BasicInfoStep state=state set_state=set_state /> }.into_any(),
                1 => view! { <PartiesStep state=state set_state=set_state /> }.into_any(),
                2 => view! { <TermsStep state=state set_state=set_state /> }.into_any(),
                3 => view! { <AttachmentsStep state=state set_state=set_state /> }.into_any(),
                _ => view! { <ReviewStep state=state /> }.into_any(),
            }}

            // Navigation
            <div class="wizard-nav">
                {move || if state.get().step > 0 {
                    view! {
                        <button on:click=prev_step>"← Quay lại"</button>
                    }.into_any()
                } else { ().into_any() }}
                {move || if state.get().step < 4 {
                    view! {
                        <button on:click=next_step class="btn-primary">
                            {if state.get().step == 3 { "Xem lại" } else { "Tiếp theo →" }}
                        </button>
                    }.into_any()
                } else {
                    view! {
                        <button class="btn-success">"✓ Tạo hợp đồng"</button>
                    }.into_any()
                }}
            </div>
        </div>
    }
}
```

### 1.2 Dynamic Field Lists (Add/Remove Rows)

```rust
use leptos::prelude::*;

// Dynamic: thêm/xóa party rows
#[component]
fn PartiesStep(
    state: ReadSignal<ContractWizardState>,
    set_state: WriteSignal<ContractWizardState>,
) -> impl IntoView {
    let add_party = move |_| {
        set_state.update(|s| s.parties.push(Party::default()));
    };

    let remove_party = move |idx: usize| {
        set_state.update(|s| {
            if s.parties.len() > 1 { s.parties.remove(idx); }
        });
    };

    view! {
        <div class="parties-step">
            <h3>"Các bên tham gia hợp đồng"</h3>

            // Dynamic party rows — dùng <For> với key
            <For
                each=move || state.get().parties.into_iter().enumerate().collect::<Vec<_>>()
                key=|(idx, _)| *idx
                children=move |(idx, party)| {
                    let remove = move |_| remove_party(idx);
                    view! {
                        <div class="party-row">
                            <div class="field">
                                <label>"Tên tổ chức"</label>
                                <input
                                    type="text"
                                    prop:value=party.org_name.clone()
                                    on:input=move |e| {
                                        let val = event_target_value(&e);
                                        set_state.update(|s| {
                                            if let Some(p) = s.parties.get_mut(idx) {
                                                p.org_name = val;
                                            }
                                        });
                                    }
                                />
                            </div>
                            <div class="field">
                                <label>"Email"</label>
                                <input
                                    type="email"
                                    prop:value=party.email.clone()
                                    on:input=move |e| {
                                        let val = event_target_value(&e);
                                        set_state.update(|s| {
                                            if let Some(p) = s.parties.get_mut(idx) {
                                                p.email = val;
                                            }
                                        });
                                    }
                                />
                            </div>
                            <div class="field">
                                <label>"Vai trò"</label>
                                <select
                                    prop:value=party.role.clone()
                                    on:change=move |e| {
                                        let val = event_target_value(&e);
                                        set_state.update(|s| {
                                            if let Some(p) = s.parties.get_mut(idx) {
                                                p.role = val;
                                            }
                                        });
                                    }
                                >
                                    <option value="PARTY_A">"Bên A"</option>
                                    <option value="PARTY_B">"Bên B"</option>
                                    <option value="GUARANTOR">"Bên bảo lãnh"</option>
                                </select>
                            </div>
                            {move || if state.get().parties.len() > 1 {
                                view! {
                                    <button
                                        type="button"
                                        class="btn-danger btn-sm"
                                        on:click=remove
                                    >"🗑 Xóa"</button>
                                }.into_any()
                            } else { ().into_any() }}
                        </div>
                    }
                }
            />

            <button type="button" on:click=add_party class="btn-outline">
                "+ Thêm bên tham gia"
            </button>
        </div>
    }
}
```

### 1.3 Dependent Fields

```rust
use leptos::prelude::*;

// Field B phụ thuộc vào giá trị Field A
#[component]
fn LoanForm() -> impl IntoView {
    let (loan_type, set_loan_type) = signal("FIXED".to_string());
    let (amount, set_amount) = signal(0u64);
    let (rate, set_rate) = signal(0.0f64);
    let (term_months, set_term_months) = signal(12u32);

    // Derived: tính monthly payment khi inputs thay đổi
    let monthly_payment = move || {
        let p = amount.get() as f64;
        let r = rate.get() / 100.0 / 12.0;
        let n = term_months.get() as f64;

        if r == 0.0 { return p / n; }
        // Công thức EMI
        p * r * (1.0 + r).powf(n) / ((1.0 + r).powf(n) - 1.0)
    };

    view! {
        <form>
            <div class="field">
                <label>"Loại vay"</label>
                <select on:change=move |e| set_loan_type.set(event_target_value(&e))>
                    <option value="FIXED">"Lãi suất cố định"</option>
                    <option value="FLOATING">"Lãi suất thả nổi"</option>
                    <option value="ZERO">"Không lãi suất"</option>
                </select>
            </div>

            <div class="field">
                <label>"Số tiền vay (VNĐ)"</label>
                <input
                    type="number"
                    on:input=move |e| {
                        if let Ok(v) = event_target_value(&e).parse::<u64>() {
                            set_amount.set(v);
                        }
                    }
                />
            </div>

            // Chỉ hiện lãi suất nếu không phải "ZERO"
            {move || if loan_type.get() != "ZERO" {
                view! {
                    <div class="field">
                        <label>
                            {if loan_type.get() == "FLOATING" {
                                "Lãi suất gốc (%/năm)"
                            } else {
                                "Lãi suất (%/năm)"
                            }}
                        </label>
                        <input
                            type="number"
                            step="0.1"
                            on:input=move |e| {
                                if let Ok(v) = event_target_value(&e).parse::<f64>() {
                                    set_rate.set(v);
                                }
                            }
                        />
                        // Chỉ hiện warning cho floating rate
                        {move || if loan_type.get() == "FLOATING" {
                            view! {
                                <p class="hint">"⚠️ Lãi suất thả nổi có thể thay đổi theo thị trường"</p>
                            }.into_any()
                        } else { ().into_any() }}
                    </div>
                }.into_any()
            } else { ().into_any() }}

            // Monthly payment preview
            <div class="payment-preview">
                <strong>"Trả hàng tháng (ước tính): "</strong>
                {move || format!("{:.0} VNĐ", monthly_payment())}
            </div>
        </form>
    }
}
```

---

## PHẦN 2 — File Upload UX

### 2.1 Single File Upload (Leptos)

```rust
use leptos::prelude::*;
use wasm_bindgen::prelude::*;
use web_sys::{File, FileReader, HtmlInputElement};

#[derive(Clone, Debug)]
struct UploadedFile {
    name: String,
    size: u64,
    file_type: String,
    preview_url: Option<String>,  // data URL cho preview
    status: UploadStatus,
}

#[derive(Clone, Debug, PartialEq)]
enum UploadStatus {
    Pending,
    Uploading(u8),  // 0-100%
    Done(String),   // URL sau upload
    Error(String),
}

#[component]
fn FileUpload(
    #[prop(default = vec!["image/png","image/jpeg","application/pdf"].iter().map(|s| s.to_string()).collect())]
    accept: Vec<String>,
    #[prop(default = 10 * 1024 * 1024)]  // 10MB
    max_size: u64,
    on_upload: Callback<String>,  // callback trả về URL
) -> impl IntoView {
    let (file_state, set_file_state) = signal(Option::<UploadedFile>::None);
    let (drag_over, set_drag_over) = signal(false);

    let handle_file = move |file: File| {
        let name = file.name();
        let size = file.size() as u64;
        let file_type = file.type_();

        // Validate size
        if size > max_size {
            set_file_state.set(Some(UploadedFile {
                name: name.clone(),
                size,
                file_type: file_type.clone(),
                preview_url: None,
                status: UploadStatus::Error(format!(
                    "File quá lớn: {:.1}MB (tối đa {:.1}MB)",
                    size as f64 / 1024.0 / 1024.0,
                    max_size as f64 / 1024.0 / 1024.0,
                )),
            }));
            return;
        }

        // Validate type
        if !accept.is_empty() && !accept.contains(&file_type) {
            set_file_state.set(Some(UploadedFile {
                name,
                size,
                file_type,
                preview_url: None,
                status: UploadStatus::Error("Định dạng file không được hỗ trợ".to_string()),
            }));
            return;
        }

        set_file_state.set(Some(UploadedFile {
            name: name.clone(),
            size,
            file_type: file_type.clone(),
            preview_url: None,
            status: UploadStatus::Uploading(0),
        }));

        // Upload
        spawn_local(async move {
            match upload_file_to_server(file).await {
                Ok(url) => {
                    set_file_state.update(|f| {
                        if let Some(f) = f {
                            f.status = UploadStatus::Done(url.clone());
                        }
                    });
                    on_upload.call(url);
                }
                Err(e) => {
                    set_file_state.update(|f| {
                        if let Some(f) = f {
                            f.status = UploadStatus::Error(e);
                        }
                    });
                }
            }
        });
    };

    view! {
        <div
            class=move || if drag_over.get() { "upload-zone drag-over" } else { "upload-zone" }
            on:dragover=move |e| { e.prevent_default(); set_drag_over.set(true); }
            on:dragleave=move |_| set_drag_over.set(false)
            on:drop=move |e| {
                e.prevent_default();
                set_drag_over.set(false);
                if let Some(files) = e.data_transfer().and_then(|dt| dt.files()) {
                    if let Some(file) = files.get(0) {
                        handle_file(file);
                    }
                }
            }
        >
            {move || match file_state.get() {
                None => view! {
                    <div class="upload-prompt">
                        <span class="upload-icon">"📎"</span>
                        <p>"Kéo thả file vào đây hoặc"</p>
                        <label class="btn-outline">
                            "Chọn file"
                            <input
                                type="file"
                                style="display: none"
                                accept=accept.join(",")
                                on:change=move |e| {
                                    let input = e.target().unwrap().unchecked_into::<HtmlInputElement>();
                                    if let Some(files) = input.files() {
                                        if let Some(file) = files.get(0) {
                                            handle_file(file);
                                        }
                                    }
                                }
                            />
                        </label>
                        <p class="hint">{format!("Tối đa {:.0}MB", max_size as f64 / 1024.0 / 1024.0)}</p>
                    </div>
                }.into_any(),
                Some(f) => view! {
                    <div class="file-info">
                        <span class="file-name">{f.name.clone()}</span>
                        <span class="file-size">{format!("{:.1}KB", f.size as f64 / 1024.0)}</span>
                        {match f.status {
                            UploadStatus::Uploading(pct) => view! {
                                <div class="progress-bar">
                                    <div class="progress-fill" style=format!("width: {}%", pct) />
                                </div>
                            }.into_any(),
                            UploadStatus::Done(_) => view! {
                                <span class="status-done">"✅ Upload thành công"</span>
                            }.into_any(),
                            UploadStatus::Error(ref e) => view! {
                                <span class="status-error">"❌ " {e.clone()}</span>
                            }.into_any(),
                            _ => ().into_any(),
                        }}
                        <button type="button" on:click=move |_| set_file_state.set(None)>"× Xóa"</button>
                    </div>
                }.into_any(),
            }}
        </div>
    }
}

async fn upload_file_to_server(file: File) -> Result<String, String> {
    use wasm_bindgen::JsCast;

    let form_data = web_sys::FormData::new().map_err(|e| format!("{:?}", e))?;
    form_data.append_with_blob("file", &file).map_err(|e| format!("{:?}", e))?;

    let resp = reqwest::Client::new()
        .post("https://api.example.com/upload")
        .body(reqwest::Body::from(
            wasm_streams::ReadableStream::from_raw(file.stream())
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status().is_success() {
        let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(json["url"].as_str().unwrap_or("").to_string())
    } else {
        Err(format!("Upload thất bại: {}", resp.status()))
    }
}
```

### 2.2 Multi-File Upload với Queue

```rust
use leptos::prelude::*;

#[derive(Clone, Debug)]
struct QueuedFile {
    id: u32,
    name: String,
    size: u64,
    status: UploadStatus,
}

#[component]
fn MultiFileUpload() -> impl IntoView {
    let (queue, set_queue) = signal(Vec::<QueuedFile>::new());
    static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    let add_files = move |files: web_sys::FileList| {
        for i in 0..files.length() {
            if let Some(file) = files.get(i) {
                let id = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                set_queue.update(|q| q.push(QueuedFile {
                    id,
                    name: file.name(),
                    size: file.size() as u64,
                    status: UploadStatus::Pending,
                }));
            }
        }
    };

    let upload_all = move |_| {
        // Upload tuần tự để tránh overwhelm server
        spawn_local(async move {
            let pending_ids: Vec<u32> = queue.get()
                .iter()
                .filter(|f| f.status == UploadStatus::Pending)
                .map(|f| f.id)
                .collect();

            for id in pending_ids {
                set_queue.update(|q| {
                    if let Some(f) = q.iter_mut().find(|f| f.id == id) {
                        f.status = UploadStatus::Uploading(0);
                    }
                });

                // Simulate upload
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                set_queue.update(|q| {
                    if let Some(f) = q.iter_mut().find(|f| f.id == id) {
                        f.status = UploadStatus::Done("https://...".to_string());
                    }
                });
            }
        });
    };

    let total = move || queue.get().len();
    let done = move || queue.get().iter().filter(|f| matches!(f.status, UploadStatus::Done(_))).count();

    view! {
        <div class="multi-upload">
            <label class="upload-btn">
                "📎 Chọn nhiều file"
                <input
                    type="file"
                    multiple=true
                    style="display:none"
                    on:change=move |e| {
                        use wasm_bindgen::JsCast;
                        let input = e.target().unwrap().unchecked_into::<web_sys::HtmlInputElement>();
                        if let Some(files) = input.files() { add_files(files); }
                    }
                />
            </label>

            {move || if total() > 0 {
                view! {
                    <div class="queue-summary">
                        {done()}"/"{ total()}" file hoàn thành"
                        <button on:click=upload_all>"⬆ Upload tất cả"</button>
                    </div>
                }.into_any()
            } else { ().into_any() }}

            <ul class="file-queue">
                <For
                    each=move || queue.get()
                    key=|f| f.id
                    children=move |file| view! {
                        <li class="queue-item">
                            <span class="file-name">{file.name.clone()}</span>
                            <span class="file-size">
                                {format!("{:.1}KB", file.size as f64 / 1024.0)}
                            </span>
                            <span class="file-status">
                                {match &file.status {
                                    UploadStatus::Pending => "⏳ Chờ",
                                    UploadStatus::Uploading(_) => "⬆ Đang upload...",
                                    UploadStatus::Done(_) => "✅ Xong",
                                    UploadStatus::Error(e) => "❌ Lỗi",
                                }}
                            </span>
                        </li>
                    }
                />
            </ul>
        </div>
    }
}
```

---

## PHẦN 3 — Form Patterns (Dioxus)

### 3.1 Multi-Step Form (Dioxus)

```rust
use dioxus::prelude::*;
use validator::Validate;

#[derive(Clone, Debug, Default, Validate)]
struct Step1 {
    #[validate(length(min = 5, max = 200))]
    pub title: String,
    pub doc_type: String,
}

#[derive(Clone, Debug, Default)]
struct WizardState {
    step: usize,
    step1: Step1,
    step2_parties: Vec<String>,  // simplified
}

#[component]
fn DioxusWizard() -> Element {
    let mut state = use_signal(WizardState::default);
    let mut step_errors = use_signal(|| Vec::<String>::new());

    let validate_current = move || -> bool {
        let s = state.read();
        match s.step {
            0 => {
                let valid = s.step1.validate().is_ok();
                if !valid {
                    step_errors.set(vec!["Vui lòng điền đầy đủ thông tin".to_string()]);
                }
                valid
            }
            _ => true,
        }
    };

    rsx! {
        div { class: "wizard",
            // Steps indicator
            div { class: "steps",
                for (i, label) in ["Thông tin cơ bản", "Các bên", "Xem lại"].iter().enumerate() {
                    div {
                        class: if i == state.read().step { "step active" }
                               else if i < state.read().step { "step done" }
                               else { "step" },
                        "{label}"
                    }
                }
            }

            // Error
            for err in step_errors.read().iter() {
                div { class: "alert-error", "{err}" }
            }

            // Content
            match state.read().step {
                0 => rsx! {
                    div { class: "step-content",
                        label { "Tiêu đề tài liệu" }
                        input {
                            value: "{state.read().step1.title}",
                            oninput: move |e| state.write().step1.title = e.value(),
                        }
                        select {
                            onchange: move |e| state.write().step1.doc_type = e.value(),
                            option { value: "CONTRACT", "Hợp đồng" }
                            option { value: "REPORT", "Báo cáo" }
                            option { value: "INVOICE", "Hóa đơn" }
                        }
                    }
                },
                1 => rsx! {
                    div { class: "step-content",
                        p { "Thêm các bên tham gia..." }
                    }
                },
                _ => rsx! {
                    div { class: "step-content",
                        h3 { "Xem lại thông tin" }
                        p { "Tiêu đề: {state.read().step1.title}" }
                        p { "Loại: {state.read().step1.doc_type}" }
                    }
                },
            }

            // Navigation
            div { class: "wizard-nav",
                if state.read().step > 0 {
                    button {
                        onclick: move |_| state.write().step -= 1,
                        "← Quay lại"
                    }
                }
                if state.read().step < 2 {
                    button {
                        onclick: move |_| {
                            step_errors.set(vec![]);
                            if validate_current() {
                                state.write().step += 1;
                            }
                        },
                        class: "btn-primary",
                        "Tiếp theo →"
                    }
                } else {
                    button { class: "btn-success", "✓ Hoàn tất" }
                }
            }
        }
    }
}
```

---

## 💡 Tips & Tricks

```
TIP 1 — Field state đơn giản vs struct
  Ít fields (< 5): dùng signal riêng cho mỗi field
  let (name, set_name) = signal(String::new());
  
  Nhiều fields: dùng 1 signal chứa struct
  let (form, set_form) = signal(FormState::default());
  // → Ít signal hơn, nhưng mỗi keystroke clone cả struct
  
  Balance: dùng struct cho related fields (group thành step),
           signal riêng cho independent state (loading, error).

TIP 2 — File upload: Drag & Drop + Click
  Luôn support CẢ 2:
  - Drag & drop: UX tốt cho desktop
  - Click: dễ discover hơn, cần thiết cho mobile
  
  drop zone + <label> wrap input[type=file display:none]
  → Không cần JS library phức tạp.

TIP 3 — Upload progress trong WASM
  XMLHttpRequest có progress event, fetch() KHÔNG có.
  Để có progress bar thật:
  
  use web_sys::XmlHttpRequest;
  let xhr = XmlHttpRequest::new().unwrap();
  xhr.upload().unwrap().add_event_listener_with_callback(
      "progress",
      &on_progress_cb,
  ).unwrap();
  
  Hoặc: thay vì real progress, dùng fake indeterminate spinner
  → Đơn giản hơn, UX chấp nhận được cho files < 50MB.

TIP 4 — Multi-step validation pattern
  Validate từng step khi next → không cần submit toàn bộ form.
  Review step → chỉ hiển thị, không validate lại.
  Submit → validate toàn bộ lần cuối ở server.
  
  Pattern:
  step_data.validate()  ← validator crate
  .map_err(|e| collect_errors(e))
  .and_then(|_| next_step())

TIP 5 — Dynamic field array anti-pattern
  ❌ Dùng index làm key trong dynamic list
  <For key=|(idx, _)| *idx ...>
  
  ✅ Dùng stable unique ID
  struct Party { id: Uuid, ... }
  <For key=|(_, p)| p.id ...>
  
  Index key → khi xóa item giữa danh sách, Leptos/Dioxus
  không biết item nào bị xóa → re-render sai.
```

---

## 📝 Exercises

1. **Contract Wizard hoàn chỉnh**: 4 steps, mỗi step có validation riêng. Step cuối review + submit lên server function. Nếu server trả lỗi → highlight step bị lỗi, không reset form.

2. **Dynamic Party List**: Danh sách parties với min 2, max 10. Cho phép drag-and-drop reorder (dùng `@dnd-kit` qua JS interop hoặc CSS-only ordering). Validate không được có 2 parties cùng email.

3. **File Upload với Preview**: Upload ảnh → show preview ngay lập tức (dùng FileReader + data URL). Upload PDF → show thumbnail bằng PDF.js. Progress bar thật dùng XHR.

4. **Cross-field Validation**: Form vay vốn: `expiry_date` phải sau `effective_date`, `loan_amount` không được vượt `credit_limit` của user (lấy từ context). Hiển thị lỗi inline tại đúng field.

5. **Save & Resume**: Multi-step form auto-save vào localStorage sau mỗi thay đổi (debounce 500ms). Khi quay lại page → hỏi user "Bạn có muốn tiếp tục form đang điền dở?" với nút Tiếp tục / Bắt đầu lại.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-42-JS-Interop|Bài 42: JS Interop]] ← trước đó (FileReader, DnD)
- [[Rust-Zero-To-Hero/Bai-39-Security-Production|Bài 39: Security]] — server-side validation
- [[Rust-Zero-To-Hero/Bai-41-Auth-SSR|Bài 41: Auth]] — form auth context
- [[Rust-Zero-To-Hero/Bai-44-Styling-Pipeline|Bài 44: Styling Pipeline]] → tiếp theo
