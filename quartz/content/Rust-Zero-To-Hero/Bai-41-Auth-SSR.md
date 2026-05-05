---
tags: [rust, axum, leptos, dioxus, auth, jwt, cookie, ssr, protected-routes, production]
prerequisites: [Bai-40-Global-State]
next: Bai-42-JS-Interop
---

# Bài 41: Auth Flow — Cookie, SSR Hydration & Protected Routes

> **Áp dụng cho:** Axum (backend) · Leptos (SSR fullstack) · Dioxus (fullstack)  
> **Mục tiêu:** Auth đúng chuẩn trong mô hình SSR — set cookie, hydrate state, bảo vệ routes

---

## 🗺️ Bức Tranh Tổng Quan

```
Auth trong CSR (React truyền thống) vs SSR (Leptos/Dioxus):

CSR Flow (React):
  1. Browser load blank HTML
  2. JS bundle tải xong
  3. JS gọi /api/me → check auth
  4. Nếu chưa login → redirect /login
  
  Vấn đề: Bước 1-3 tạo flash of unauthenticated content (FOUC)
           SEO crawler thấy blank page

──────────────────────────────────────────────────────────────────

SSR Flow (Leptos/Dioxus):
  1. Browser gửi request + cookie đến server
  2. Server đọc cookie → verify JWT
  3. Server render HTML ĐÃ CÓ user state (không cần gọi API thêm)
  4. HTML gửi về → user thấy đúng UI ngay lập tức
  5. WASM bundle tải → hydrate (gắn event handlers vào HTML có sẵn)
  
  ✅ Không có FOUC
  ✅ SEO thấy đúng nội dung
  ✅ Faster Time to Interactive

──────────────────────────────────────────────────────────────────

Cookie vs LocalStorage:

  LocalStorage          HttpOnly Cookie
  ──────────────────────────────────────────
  JS có thể đọc         JS KHÔNG đọc được
  XSS có thể lấy token  XSS KHÔNG lấy được ← AN TOÀN HƠN
  Không tự gửi          Tự gửi mọi request
  Phải set Authorization header thủ công  Browser tự set
  
  → Dùng HttpOnly Cookie cho auth token trong SSR app.
```

---

## PHẦN 1 — Axum JWT Middleware

### 1.1 JWT Setup

```rust
// Cargo.toml
// jsonwebtoken = "9"
// axum-extra = { version = "0.9", features = ["cookie"] }

use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: String,        // user ID
    pub name: String,
    pub role: String,
    pub exp: u64,           // expiry timestamp
    pub iat: u64,           // issued at
}

pub struct JwtService {
    encoding_key: EncodingKey,
    decoding_key: DecodingKey,
}

impl JwtService {
    pub fn new(secret: &str) -> Self {
        Self {
            encoding_key: EncodingKey::from_secret(secret.as_bytes()),
            decoding_key: DecodingKey::from_secret(secret.as_bytes()),
        }
    }

    pub fn generate(&self, user_id: &str, name: &str, role: &str) -> Result<String, jsonwebtoken::errors::Error> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let claims = Claims {
            sub: user_id.to_string(),
            name: name.to_string(),
            role: role.to_string(),
            iat: now,
            exp: now + 3600 * 24, // 24 giờ
        };
        encode(&Header::default(), &claims, &self.encoding_key)
    }

    pub fn verify(&self, token: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
        let data = decode::<Claims>(token, &self.decoding_key, &Validation::new(Algorithm::HS256))?;
        Ok(data.claims)
    }
}
```

### 1.2 Login Handler — Set HttpOnly Cookie

```rust
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::{Deserialize, Serialize};
use time::Duration;

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct LoginResponse {
    pub message: String,
    pub user: UserInfo,
}

#[derive(Debug, Serialize, Clone)]
pub struct UserInfo {
    pub id: u32,
    pub name: String,
    pub role: String,
}

pub async fn login_handler(
    State(app): State<AppState>,
    jar: CookieJar,
    Json(req): Json<LoginRequest>,
) -> Result<(CookieJar, Json<LoginResponse>), StatusCode> {
    // 1. Verify credentials
    let user = app.db.verify_user(&req.username, &req.password)
        .await
        .map_err(|_| StatusCode::UNAUTHORIZED)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // 2. Generate JWT
    let token = app.jwt.generate(
        &user.id.to_string(),
        &user.name,
        &user.role,
    ).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // 3. Set HttpOnly cookie — JS KHÔNG đọc được
    let cookie = Cookie::build(("auth_token", token))
        .http_only(true)              // ← XSS protection
        .secure(true)                  // ← HTTPS only
        .same_site(SameSite::Lax)     // ← CSRF protection
        .path("/")
        .max_age(Duration::days(1))
        .build();

    let response = LoginResponse {
        message: "Đăng nhập thành công".to_string(),
        user: UserInfo { id: user.id, name: user.name.clone(), role: user.role.clone() },
    };

    Ok((jar.add(cookie), Json(response)))
}

pub async fn logout_handler(jar: CookieJar) -> (CookieJar, StatusCode) {
    // Xóa cookie bằng cách set max_age = 0
    let cookie = Cookie::build(("auth_token", ""))
        .http_only(true)
        .secure(true)
        .path("/")
        .max_age(Duration::seconds(0))
        .build();
    (jar.remove(cookie), StatusCode::OK)
}
```

### 1.3 Auth Middleware — Extract User từ Cookie

```rust
use axum::{
    extract::{Request, State},
    middleware::Next,
    response::Response,
    http::StatusCode,
};
use axum_extra::extract::CookieJar;

// Struct inject vào request extensions
#[derive(Clone, Debug)]
pub struct AuthUser {
    pub id: String,
    pub name: String,
    pub role: String,
}

// Optional auth — không reject nếu chưa login
pub async fn optional_auth(
    State(app): State<AppState>,
    jar: CookieJar,
    mut request: Request,
    next: Next,
) -> Response {
    if let Some(token) = jar.get("auth_token").map(|c| c.value().to_owned()) {
        if let Ok(claims) = app.jwt.verify(&token) {
            request.extensions_mut().insert(AuthUser {
                id: claims.sub,
                name: claims.name,
                role: claims.role,
            });
        }
    }
    next.run(request).await
}

// Required auth — reject 401 nếu chưa login
pub async fn require_auth(
    State(app): State<AppState>,
    jar: CookieJar,
    mut request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let token = jar.get("auth_token")
        .map(|c| c.value().to_owned())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let claims = app.jwt.verify(&token)
        .map_err(|_| StatusCode::UNAUTHORIZED)?;

    request.extensions_mut().insert(AuthUser {
        id: claims.sub,
        name: claims.name,
        role: claims.role,
    });

    Ok(next.run(request).await)
}

// RBAC — kiểm tra role
pub fn require_role(role: &'static str) -> impl Fn(
    axum::extract::Extension<AuthUser>,
    Request,
    Next,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Response, StatusCode>> + Send>> + Clone {
    move |axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
          request: Request, next: Next| {
        Box::pin(async move {
            if user.role != role {
                return Err(StatusCode::FORBIDDEN);
            }
            Ok(next.run(request).await)
        })
    }
}

// Router config
pub fn build_router(app_state: AppState) -> axum::Router {
    use axum::{middleware, routing::{get, post}};

    axum::Router::new()
        // Public routes
        .route("/auth/login", post(login_handler))
        .route("/auth/logout", post(logout_handler))

        // Protected routes — cần auth
        .route("/api/documents", get(list_documents).post(create_document))
        .route("/api/users", get(list_users))
        .layer(middleware::from_fn_with_state(app_state.clone(), require_auth))

        // Admin routes — cần role
        .route("/admin/users", get(admin_list_users))
        .layer(middleware::from_fn(require_role("ADMIN")))

        .with_state(app_state)
}
```

---

## PHẦN 2 — Leptos — Auth SSR + Hydration

### 2.1 Server Function Login + Cookie

```rust
use leptos::prelude::*;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuthUser {
    pub id: u32,
    pub name: String,
    pub role: String,
}

// Server function: login, set cookie, return user info
#[server(LoginAction)]
pub async fn login(username: String, password: String) -> Result<AuthUser, ServerFnError> {
    // Chỉ chạy trên server
    use axum_extra::extract::cookie::{Cookie, CookieJar};
    use leptos_axum::ResponseOptions;

    // Verify credentials
    let user = verify_credentials(&username, &password)
        .await
        .map_err(|_| ServerFnError::ServerError("Sai username hoặc password".into()))?;

    // Generate JWT
    let jwt_service = use_context::<JwtService>()
        .ok_or(ServerFnError::ServerError("JWT service unavailable".into()))?;
    let token = jwt_service.generate(&user.id.to_string(), &user.name, &user.role)
        .map_err(|e| ServerFnError::ServerError(e.to_string()))?;

    // Set cookie trong SSR response
    let response = use_context::<ResponseOptions>().unwrap();
    let cookie = format!(
        "auth_token={}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400",
        token
    );
    response.insert_header(
        axum::http::header::SET_COOKIE,
        axum::http::HeaderValue::from_str(&cookie).unwrap(),
    );

    Ok(AuthUser { id: user.id, name: user.name, role: user.role })
}

#[server(LogoutAction)]
pub async fn logout() -> Result<(), ServerFnError> {
    use leptos_axum::ResponseOptions;
    let response = use_context::<ResponseOptions>().unwrap();
    // Xóa cookie
    response.insert_header(
        axum::http::header::SET_COOKIE,
        axum::http::HeaderValue::from_static(
            "auth_token=; HttpOnly; Secure; Path=/; Max-Age=0"
        ),
    );
    Ok(())
}

// Server function: lấy current user từ cookie (dùng khi SSR)
#[server(GetCurrentUser)]
pub async fn get_current_user() -> Result<Option<AuthUser>, ServerFnError> {
    use axum_extra::extract::CookieJar;
    use leptos_axum::extract;

    let jar = extract::<CookieJar>().await?;
    let token = match jar.get("auth_token").map(|c| c.value().to_owned()) {
        Some(t) => t,
        None => return Ok(None),
    };

    let jwt_service = use_context::<JwtService>().unwrap();
    match jwt_service.verify(&token) {
        Ok(claims) => Ok(Some(AuthUser {
            id: claims.sub.parse().unwrap_or(0),
            name: claims.name,
            role: claims.role,
        })),
        Err(_) => Ok(None),
    }
}
```

### 2.2 Auth Context + Hydration-Safe

```rust
use leptos::prelude::*;

// AuthContext chứa user state — load từ server khi SSR
#[derive(Clone, Copy)]
pub struct AuthContext {
    pub user: Resource<Option<AuthUser>>,
    pub login: Action<(String, String), Result<AuthUser, ServerFnError>>,
    pub logout: Action<(), Result<(), ServerFnError>>,
}

// Root App — setup auth context
#[component]
pub fn App() -> impl IntoView {
    // Resource này chạy trên server trong SSR phase
    // → HTML trả về đã có user info (không cần fetch thêm ở client)
    let user = Resource::new(|| (), |_| get_current_user());

    let login = Action::new(|(username, password): &(String, String)| {
        let u = username.clone();
        let p = password.clone();
        async move { login(u, p).await }
    });

    let logout = Action::new(|_: &()| async move { logout().await });

    provide_context(AuthContext { user, login, logout });

    view! {
        <Router>
            <Routes fallback=|| view! { <NotFound /> }>
                <Route path="/" view=HomePage />
                <Route path="/login" view=LoginPage />
                // Protected — xem section 2.3
                <ProtectedRoute path="/dashboard" view=Dashboard />
            </Routes>
        </Router>
    }
}
```

### 2.3 Protected Routes (Leptos)

```rust
use leptos::prelude::*;
use leptos_router::*;

// Protected route wrapper — redirect /login nếu chưa auth
#[component]
pub fn ProtectedRoute(
    path: &'static str,
    #[prop(into)] view: ViewFn,
) -> impl IntoView {
    let AuthContext { user, .. } = use_context::<AuthContext>().unwrap();

    view! {
        <Suspense fallback=|| view! { <div class="loading">"Đang kiểm tra..."</div> }>
            {move || {
                user.get().map(|u| match u {
                    // Có user → render route
                    Ok(Some(_)) => view.run(),
                    // Chưa login → redirect
                    _ => view! {
                        <Redirect path="/login" />
                    }.into_any(),
                })
            }}
        </Suspense>
    }
}

// Role-based protected route
#[component]
pub fn AdminRoute(
    path: &'static str,
    #[prop(into)] view: ViewFn,
) -> impl IntoView {
    let AuthContext { user, .. } = use_context::<AuthContext>().unwrap();

    view! {
        <Suspense fallback=|| view! { <div>"Loading..."</div> }>
            {move || user.get().map(|u| match u {
                Ok(Some(u)) if u.role == "ADMIN" => view.run(),
                Ok(Some(_)) => view! {
                    <div class="forbidden">
                        <h1>"403 — Không có quyền truy cập"</h1>
                    </div>
                }.into_any(),
                _ => view! { <Redirect path="/login" /> }.into_any(),
            })}
        </Suspense>
    }
}

// Login page
#[component]
fn LoginPage() -> impl IntoView {
    let AuthContext { login, user, .. } = use_context::<AuthContext>().unwrap();
    let (username, set_username) = signal(String::new());
    let (password, set_password) = signal(String::new());
    let navigate = use_navigate();

    // Redirect nếu đã login
    Effect::new(move |_| {
        if let Some(Ok(Some(_))) = user.get() {
            navigate("/dashboard", Default::default());
        }
    });

    let on_submit = move |ev: leptos::ev::SubmitEvent| {
        ev.prevent_default();
        login.dispatch((username.get(), password.get()));
    };

    view! {
        <div class="login-page">
            <h1>"Đăng nhập PDMS"</h1>

            // Hiển thị lỗi
            {move || login.value().get().and_then(|r| r.err()).map(|e| view! {
                <div class="alert alert-error">{e.to_string()}</div>
            })}

            <form on:submit=on_submit>
                <div class="field">
                    <label>"Tên đăng nhập"</label>
                    <input
                        type="text"
                        prop:value=username
                        on:input=move |e| set_username.set(event_target_value(&e))
                    />
                </div>
                <div class="field">
                    <label>"Mật khẩu"</label>
                    <input
                        type="password"
                        prop:value=password
                        on:input=move |e| set_password.set(event_target_value(&e))
                    />
                </div>
                <button type="submit" disabled=move || login.pending().get()>
                    {move || if login.pending().get() { "Đang đăng nhập..." } else { "Đăng nhập" }}
                </button>
            </form>
        </div>
    }
}
```

---

## PHẦN 3 — Dioxus Auth Flow

### 3.1 Server Function Login + Cookie (Dioxus)

```rust
use dioxus::prelude::*;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct AuthUser {
    pub id: u32,
    pub name: String,
    pub role: String,
}

#[server(Login)]
async fn login_sf(username: String, password: String) -> Result<AuthUser, ServerFnError> {
    // Verify credentials (server-side only)
    let user = db_verify_user(&username, &password).await
        .map_err(|_| ServerFnError::new("Sai username hoặc password"))?;

    // Generate token và set cookie
    let token = generate_jwt(&user)?;

    // Dioxus server: inject Set-Cookie vào response
    let headers = server_context().response_parts_mut();
    let cookie = format!(
        "auth_token={}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400",
        token
    );
    headers.headers.insert(
        axum::http::header::SET_COOKIE,
        axum::http::HeaderValue::from_str(&cookie).unwrap(),
    );

    Ok(AuthUser { id: user.id, name: user.name, role: user.role })
}

#[server(GetMe)]
async fn get_me() -> Result<Option<AuthUser>, ServerFnError> {
    // Đọc cookie từ request (server-side)
    let headers = server_context().request_parts();
    let cookie_header = headers.headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let token = cookie_header.split(';')
        .find_map(|part| {
            let part = part.trim();
            part.strip_prefix("auth_token=")
        });

    match token {
        Some(t) => {
            match verify_jwt(t) {
                Ok(claims) => Ok(Some(AuthUser {
                    id: claims.sub.parse().unwrap_or(0),
                    name: claims.name,
                    role: claims.role,
                })),
                Err(_) => Ok(None),
            }
        }
        None => Ok(None),
    }
}
```

### 3.2 Protected Routes (Dioxus)

```rust
use dioxus::prelude::*;
use dioxus_router::prelude::*;

#[derive(Clone, Routable, Debug, PartialEq)]
enum Route {
    #[route("/login")]
    Login {},
    #[layout(AuthGuard)]
        #[route("/")]
        Dashboard {},
        #[route("/documents")]
        Documents {},
    #[end_layout]
    #[route("/:..segments")]
    NotFound { segments: Vec<String> },
}

// Auth guard layout — kiểm tra auth trước khi render children
#[component]
fn AuthGuard() -> Element {
    let current_user = use_resource(get_me);
    let nav = use_navigator();

    // Khi resource resolve
    use_effect(move || {
        if let Some(Ok(None)) = &*current_user.read_unchecked() {
            nav.replace(Route::Login {});
        }
    });

    match &*current_user.read_unchecked() {
        None => rsx! { div { class: "loading", "Đang kiểm tra đăng nhập..." } },
        Some(Ok(Some(user))) => {
            // Inject user vào context
            use_context_provider(|| Signal::new(user.clone()));
            rsx! { Outlet::<Route> {} }
        },
        Some(_) => rsx! { div { "Redirecting..." } },
    }
}

// Login page (Dioxus)
#[component]
fn Login() -> Element {
    let mut username = use_signal(|| String::new());
    let mut password = use_signal(|| String::new());
    let mut error = use_signal(|| Option::<String>::None);
    let mut loading = use_signal(|| false);
    let nav = use_navigator();

    let handle_login = move |_| async move {
        loading.set(true);
        error.set(None);

        match login_sf(username.read().clone(), password.read().clone()).await {
            Ok(_user) => nav.push(Route::Dashboard {}),
            Err(e) => error.set(Some(e.to_string())),
        }
        loading.set(false);
    };

    rsx! {
        div { class: "login-page",
            h1 { "Đăng nhập PDMS" }

            if let Some(err) = error.read().as_ref() {
                div { class: "alert-error", "{err}" }
            }

            input {
                r#type: "text",
                placeholder: "Tên đăng nhập",
                oninput: move |e| username.set(e.value()),
            }
            input {
                r#type: "password",
                placeholder: "Mật khẩu",
                oninput: move |e| password.set(e.value()),
            }
            button {
                onclick: handle_login,
                disabled: "{loading}",
                if loading() { "Đang đăng nhập..." } else { "Đăng nhập" }
            }
        }
    }
}
```

---

## PHẦN 4 — Axum Middleware + Session

### 4.1 Session-Based Auth (Alternative)

```rust
// Cho app không muốn stateless JWT
// Session lưu trong Redis, gửi session ID qua cookie

use axum_sessions::{async_session::MemoryStore, SessionLayer};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionUser {
    pub id: u32,
    pub name: String,
    pub role: String,
}

// Setup session layer
pub fn session_layer() -> SessionLayer<MemoryStore> {
    let store = MemoryStore::new(); // Production: dùng RedisStore
    SessionLayer::new(store, b"super-secret-key-min-64-bytes-long-for-security!")
        .with_secure(true)
        .with_http_only(true)
        .with_same_site_policy(axum_sessions::SameSite::Lax)
}

// Login với session
pub async fn session_login(
    mut session: axum_sessions::extractors::WritableSession,
    Json(req): Json<LoginRequest>,
) -> impl axum::response::IntoResponse {
    // Verify user ...
    session.insert("user", SessionUser {
        id: 1,
        name: "Test User".to_string(),
        role: "USER".to_string(),
    }).unwrap();

    axum::Json(serde_json::json!({"message": "Đăng nhập thành công"}))
}

// Middleware đọc session
pub async fn require_session(
    session: axum_sessions::extractors::ReadableSession,
    mut request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, axum::http::StatusCode> {
    let user = session.get::<SessionUser>("user")
        .ok_or(axum::http::StatusCode::UNAUTHORIZED)?;

    request.extensions_mut().insert(user);
    Ok(next.run(request).await)
}
```

---

## 💡 Tips & Tricks

```
TIP 1 — HttpOnly Cookie vs JWT in Header
  Trong browser app → dùng HttpOnly Cookie (XSS safe)
  Trong mobile app (Dioxus Mobile) → dùng Authorization header + secure storage
  Trong CLI/API client → dùng Authorization header

TIP 2 — Cookie SameSite policy
  SameSite=Strict : Cookie chỉ gửi khi request từ cùng site
                    → Không tự gửi khi click link từ email/external
                    → Tốt nhất cho security nhưng UX kém hơn
  SameSite=Lax    : Gửi khi navigate đến site (click link), nhưng không
                    gửi trong cross-site POST (form từ site khác)
                    → Balance tốt giữa security và UX ✅
  SameSite=None   : Luôn gửi (cần Secure=true)
                    → Cần cho cross-origin iframe hoặc third-party

TIP 3 — Token refresh
  JWT 1 giờ (short) + Refresh token 30 ngày (long):
  - Auth token expire → client dùng refresh token lấy token mới
  - Refresh token có thể revoke (blacklist trong Redis)
  - Auth token không cần revoke (chờ expire)

TIP 4 — Leptos SSR hydration mismatch
  Vấn đề: HTML server render khác với client render
  → "hydration mismatch" error trong console
  
  Nguyên nhân phổ biến:
  - Server thấy user logged in, client không biết
  - Dùng create_resource với Source = () để fetch SAME data ở cả 2 đầu
  - Dùng <Suspense> để handle async state đúng cách

TIP 5 — PDMS Role Hierarchy
  Leptos ProtectedRoute có thể accept Vec<&str> roles:
  
  fn require_any_role(roles: Vec<&'static str>) {
      // user.role ∈ roles → cho qua
  }
  
  Ví dụ PDMS roles:
  ADMIN  → full access
  MANAGER → approve documents, view reports  
  MAKER   → create/edit documents
  VIEWER  → read-only
```

---

## 📝 Exercises

1. **Cookie Auth Axum**: Implement đầy đủ login/logout với HttpOnly cookie. Viết integration test: login → get protected route → logout → get protected route bị 401.

2. **Leptos Protected Route**: App với 3 routes: `/` (public), `/dashboard` (require login), `/admin` (require ADMIN role). AuthContext inject từ root. Test với các trường hợp: chưa login, login user thường, login admin.

3. **SSR Hydration**: So sánh 2 implementation: (a) load user ở client sau hydration (FOUC), (b) load user trong SSR qua `get_current_user()` server function. Dùng DevTools Network tab quan sát sự khác biệt.

4. **Token Refresh**: Implement refresh token flow: JWT auth_token expire sau 15 phút, refresh_token expire sau 7 ngày. Middleware tự động refresh khi auth_token gần expire (còn < 5 phút).

5. **Role-Based UI**: Component `<RequireRole role="ADMIN">` ẩn children nếu user không đủ role. Khác với route guard (ở level routing), cái này ở level component. Dùng ở cả Leptos và Dioxus.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-40-Global-State|Bài 40: Global State]] ← trước đó
- [[Rust-Zero-To-Hero/Bai-13-Serde-Reqwest-JWT|Bài 13: JWT basics]]
- [[Rust-Zero-To-Hero/Bai-32-Security|Bài 32: Security]] — crypto context
- [[Rust-Zero-To-Hero/Bai-42-JS-Interop|Bài 42: JS Interop]] → tiếp theo
