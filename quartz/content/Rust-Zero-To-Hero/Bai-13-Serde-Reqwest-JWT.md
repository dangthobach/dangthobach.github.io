# Bài 13: Serde + reqwest + JWT — Integration Layer

---

## PHẦN 1 — SERDE: SERIALIZATION ENGINE

### 1.1 Cơ chế hoạt động — So sánh với Java Jackson

```
JAVA (Jackson):
Runtime → Reflection → scan @JsonProperty → build ObjectMapper tree → serialize

RUST (Serde):
Compile time → proc-macro expand → generate code → ZERO runtime overhead

┌──────────────────────────────────────────────────────────────┐
│  Java Jackson                    │  Rust Serde               │
├──────────────────────────────────┼───────────────────────────┤
│  Reflection at runtime           │  Code gen at compile time │
│  ObjectMapper (heap allocation)  │  Zero-cost, inline code   │
│  ~2-5 µs per object              │  ~0.3-0.8 µs per object   │
│  JVM warm-up needed              │  Fast from first call     │
└──────────────────────────────────┴───────────────────────────┘
```

### 1.2 Derive cơ bản

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct User {
    id: i64,
    name: String,
    email: String,
    
    #[serde(skip_serializing_if = "Option::is_none")]
    phone: Option<String>,        // null → field bị omit khỏi JSON
    
    #[serde(default)]
    active: bool,                 // nếu thiếu trong JSON → false
    
    #[serde(rename = "createdAt")]
    created_at: String,
}

// Compile-time expand thành (roughly):
// impl Serialize for User {
//     fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
//         let mut state = s.serialize_struct("User", 5)?;
//         state.serialize_field("id", &self.id)?;
//         // ... không có reflection, không có HashMap lookup
//     }
// }
```

### 1.3 Rename strategies

```rust
// Java: @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
// Rust:
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]     // id, firstName, lastName
struct UserDto { first_name: String, last_name: String }

#[serde(rename_all = "snake_case")]    // first_name, last_name
#[serde(rename_all = "PascalCase")]    // FirstName, LastName
#[serde(rename_all = "SCREAMING_SNAKE_CASE")] // FIRST_NAME
```

### 1.4 Enums trong JSON — Rất mạnh

```rust
#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]  // internally tagged
enum Event {
    UserCreated { user_id: i64, email: String },
    OrderPlaced { order_id: i64, total: f64 },
    PaymentFailed { reason: String },
}

// Serialize ra:
// {"type": "UserCreated", "user_id": 1, "email": "a@b.com"}

#[serde(untagged)]  // no type field — match theo shape
enum Response {
    Success(SuccessBody),
    Error(ErrorBody),
}
```

### 1.5 Flatten — Xử lý nested JSON phẳng

```rust
// JSON: {"id": 1, "street": "123 Main", "city": "HN", "country": "VN"}
#[derive(Serialize, Deserialize)]
struct Address { street: String, city: String, country: String }

#[derive(Serialize, Deserialize)]
struct User {
    id: i64,
    #[serde(flatten)]     // Java: @JsonUnwrapped
    address: Address,
}
```

### 1.6 Dynamic JSON với `serde_json::Value`

```rust
use serde_json::{json, Value};

// Build JSON tùy ý — như JsonObject trong Java
let body = json!({
    "user_id": 42,
    "tags": ["rust", "axum"],
    "metadata": { "source": "api", "version": 2 }
});

// Navigate dynamic JSON
if let Value::Object(map) = &body {
    let user_id = map["user_id"].as_i64().unwrap();
}

// Parse unknown structure
let v: Value = serde_json::from_str(raw_json)?;
let name = v["user"]["name"].as_str().unwrap_or("unknown");
```

### 1.7 Custom Serializer — Khi derive không đủ

```rust
use serde::{Serializer, Deserializer};

// Serialize money as cents, deserialize as float
#[derive(Serialize, Deserialize)]
struct Money {
    #[serde(serialize_with = "serialize_cents", deserialize_with = "deserialize_cents")]
    amount_vnd: i64,
}

fn serialize_cents<S: Serializer>(cents: &i64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64(*cents as f64 / 100.0)
}
fn deserialize_cents<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    let f = f64::deserialize(d)?;
    Ok((f * 100.0) as i64)
}
```

---

## PHẦN 2 — REQWEST: ASYNC HTTP CLIENT

### 2.1 So sánh với Spring WebClient

```
Spring WebClient (reactive, Builder pattern):
WebClient.create()
    .get().uri("...")
    .retrieve()
    .bodyToMono(User.class)   ← reactive, Mono<User>

Reqwest (async, Builder pattern):
reqwest::Client::new()
    .get("...")
    .send().await?            ← native async/await
    .json::<User>().await?    ← typed deserialization
```

### 2.2 Client Setup — Singleton Pattern

```rust
use reqwest::Client;
use std::time::Duration;

// Client nên được reuse — không tạo mới mỗi request
// Vì Client giữ connection pool bên trong (giống HttpClient trong Java)
#[derive(Clone)]
pub struct HttpClientWrapper {
    client: Client,
    base_url: String,
}

impl HttpClientWrapper {
    pub fn new(base_url: String) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .connection_verbose(false)
            .pool_max_idle_per_host(20)      // connection pool
            .build()
            .expect("Failed to build HTTP client");
        
        Self { client, base_url }
    }
}
```

### 2.3 GET Request

```rust
#[derive(Deserialize)]
struct GitHubUser { login: String, public_repos: u32 }

pub async fn get_github_user(client: &Client, username: &str) -> Result<GitHubUser, AppError> {
    let url = format!("https://api.github.com/users/{}", username);
    
    let user = client
        .get(&url)
        .header("User-Agent", "my-app/1.0")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| AppError::ExternalService { 
            service: "github".to_string(), 
            message: e.to_string() 
        })?
        .error_for_status()   // 4xx/5xx → Err
        .map_err(|e| AppError::ExternalService { 
            service: "github".to_string(), 
            message: format!("HTTP {}", e.status().unwrap()) 
        })?
        .json::<GitHubUser>()
        .await?;
    
    Ok(user)
}
```

### 2.4 POST với JSON Body

```rust
#[derive(Serialize)]
struct CreateOrderRequest { user_id: i64, items: Vec<OrderItem> }

#[derive(Deserialize)]
struct CreateOrderResponse { order_id: String, status: String }

pub async fn create_order(
    client: &Client,
    request: CreateOrderRequest,
) -> Result<CreateOrderResponse, AppError> {
    client
        .post("https://order-service/api/orders")
        .bearer_auth(&get_service_token())   // Bearer token tự động
        .json(&request)                       // Serde serialize + Content-Type header
        .send()
        .await?
        .json::<CreateOrderResponse>()
        .await
        .map_err(Into::into)
}
```

### 2.5 Retry Pattern

```rust
use tokio::time::{sleep, Duration};

pub async fn with_retry<F, Fut, T>(
    f: F,
    max_attempts: u32,
) -> Result<T, AppError>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T, AppError>>,
{
    let mut attempt = 0;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) if attempt < max_attempts => {
                attempt += 1;
                let backoff = Duration::from_millis(100 * 2u64.pow(attempt));
                tracing::warn!(attempt, ?backoff, "Request failed, retrying");
                sleep(backoff).await;
            }
            Err(e) => return Err(e),
        }
    }
}

// Dùng:
let user = with_retry(|| get_github_user(&client, "torvalds"), 3).await?;
```

---

## PHẦN 3 — JWT: AUTHENTICATION

### 3.1 So sánh với Spring Security JWT Filter

```
Spring Security:
Request → JwtAuthenticationFilter → JwtUtil.validateToken() → SecurityContextHolder.set()
                                                              → @AuthenticationPrincipal inject

Axum:
Request → from_fn(auth_middleware) → verify_jwt() → req.extensions_mut().insert(Claims)
                                                   → Extension<Claims> extract trong handler
```

### 3.2 Setup

```toml
jsonwebtoken = "9"
```

```rust
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: i64,          // user_id
    pub email: String,
    pub role: String,
    pub exp: usize,        // expiry timestamp (Unix)
    pub iat: usize,        // issued at
}
```

### 3.3 Encode (Login)

```rust
pub fn create_token(user: &User, secret: &str) -> Result<String, AppError> {
    let expiry = chrono::Utc::now()
        .checked_add_signed(chrono::Duration::hours(24))
        .unwrap()
        .timestamp() as usize;
    
    let claims = Claims {
        sub: user.id,
        email: user.email.clone(),
        role: user.role.clone(),
        exp: expiry,
        iat: chrono::Utc::now().timestamp() as usize,
    };
    
    encode(
        &Header::default(),    // HS256
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(anyhow::anyhow!("JWT encode error: {}", e)))
}
```

### 3.4 Decode + Verify

```rust
pub fn verify_token(token: &str, secret: &str) -> Result<Claims, AppError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;    // check expiry
    
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map(|data| data.claims)
    .map_err(|e| {
        use jsonwebtoken::errors::ErrorKind;
        match e.kind() {
            ErrorKind::ExpiredSignature => AppError::Unauthorized,
            _ => AppError::Unauthorized,
        }
    })
}
```

### 3.5 Axum Auth Middleware

```rust
use axum::{extract::{Request, State}, middleware::Next, response::Response};

pub async fn require_auth(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let token = req
        .headers()
        .get("Authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;
    
    let claims = verify_token(token, &state.config.jwt_secret)?;
    req.extensions_mut().insert(claims);
    
    Ok(next.run(req).await)
}

// Handler sử dụng
async fn get_profile(
    Extension(claims): Extension<Claims>,
    State(state): State<AppState>,
) -> Result<Json<UserProfile>, AppError> {
    let user = state.user_repo.find_by_id(claims.sub).await?
        .ok_or(AppError::NotFound("User not found".to_string()))?;
    Ok(Json(UserProfile::from(user)))
}

// Apply middleware chỉ cho protected routes
let protected = Router::new()
    .route("/profile", get(get_profile))
    .route("/orders", get(list_orders))
    .layer(middleware::from_fn_with_state(state.clone(), require_auth));
```

---

## Performance Analysis: Java vs Rust ở Integration Layer

```
Serialization (JSON, 1000 objects/s):
  Java (Jackson)   : ~2-5 µs/object, GC pressure do intermediate allocations
  Rust (Serde)     : ~0.3-0.8 µs/object, zero intermediate allocation
  
HTTP Client throughput (concurrent requests):
  Java (WebClient) : ~50K req/s (reactive), limited by JVM GC
  Rust (reqwest)   : ~150-250K req/s, bounded by network I/O
  
JWT verification (token/s):
  Java (JJWT)      : ~100K tokens/s (after JIT warmup)
  Rust (jsonwebtoken): ~500K tokens/s (no warmup needed)
  
Memory per connection:
  Java             : ~2-4 KB + GC overhead
  Rust             : ~512 bytes - 1 KB, predictable
```

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-10-Axum-Core|Bài 10: State & Extractors]]
- [[Rust-Zero-To-Hero/Bai-11-Axum-Middleware-Error|Bài 11: Middleware]]
- [[Rust-Zero-To-Hero/Bai-14-Kafka-rdkafka|Bài 14: Kafka]]

---
*Bài tập:*
1. Tạo service gọi external API (ví dụ: JSONPlaceholder), deserialize response, retry 3 lần với exponential backoff.
2. Implement full JWT flow: `/login` tạo token, `/profile` verify và trả user info từ claims. Test với curl.
3. Tạo custom Serde serialize cho `chrono::DateTime<Utc>` ra format `"2024-01-15T10:30:00+07:00"` (Vietnam timezone).
