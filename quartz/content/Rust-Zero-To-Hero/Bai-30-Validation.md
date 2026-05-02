# Bài 30: Validation — validator · garde · Custom FromRequest

> **Prerequisite:** Bài 10-11 (Axum), Bài 13 (Serde)  
> **Mục tiêu:** Master validation layer hoàn chỉnh — từ field-level đến cross-field, custom rules, error formatting, và tích hợp seamless vào Axum extractor

---

## 🗺️ Bức Tranh Tổng Quan

```
Validation Layer trong Web App:

  HTTP Request
       │
       ▼
  ┌─────────────────────────────────────────────────────┐
  │              Axum Extractor                         │
  │  Json<T> / Form<T> / Path<T> / Query<T>            │
  │       │                                             │
  │       ▼                                             │
  │  Serde Deserialization  ← cấu trúc đúng?           │
  │       │                                             │
  │       ▼                                             │
  │  ✨ Validation Layer ✨  ← giá trị hợp lệ?         │
  │   validator / garde                                 │
  │   custom rules                                      │
  │   cross-field validation                            │
  │       │                                             │
  │       ▼                                             │
  │  Handler (business logic)                           │
  └─────────────────────────────────────────────────────┘

Java analog:
  @Valid + @NotBlank + @Email → javax.validation (Bean Validation)
  @ControllerAdvice MethodArgumentNotValidException
  
Rust approach:
  #[derive(Validate)] + validate() call → ValidationErrors
  Custom Axum extractor wraps Json<T> + validate()
```

---

## PHẦN 1 — validator Crate (Phổ Biến Nhất)

### 1.1 Setup

```toml
[dependencies]
validator = { version = "0.18", features = ["derive"] }
serde = { version = "1", features = ["derive"] }
axum = "0.7"
thiserror = "1"
```

### 1.2 Basic Field Validation

```rust
use serde::{Deserialize, Serialize};
use validator::Validate;

#[derive(Debug, Deserialize, Serialize, Validate)]
pub struct CreateUserDto {
    // length: min/max ký tự
    #[validate(length(min = 2, max = 100, message = "Name must be 2-100 characters"))]
    pub name: String,

    // email: format check (RFC 5322)
    #[validate(email(message = "Invalid email format"))]
    pub email: String,

    // range: số trong khoảng
    #[validate(range(min = 18, max = 120, message = "Age must be 18-120"))]
    pub age: u8,

    // url: valid URL format
    #[validate(url(message = "Invalid URL"))]
    pub website: Option<String>,

    // regex: custom pattern
    #[validate(regex(
        path = "PHONE_REGEX",
        message = "Phone must be Vietnamese format (+84...)"
    ))]
    pub phone: Option<String>,

    // contains: phải chứa substring
    #[validate(contains(pattern = "@vpbank", message = "Must use VPBank email"))]
    pub work_email: String,

    // does_not_contain
    #[validate(does_not_contain(pattern = "admin", message = "Cannot contain 'admin'"))]
    pub username: String,
}

// Regex cần khai báo lazy_static hoặc LazyLock
use std::sync::LazyLock;
use regex::Regex;

static PHONE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\+84[0-9]{9}$").expect("Invalid regex")
});

// Sử dụng
let dto = CreateUserDto {
    name: "Bach".to_string(),
    email: "bach@example.com".to_string(),
    age: 30,
    website: Some("https://vpbank.com".to_string()),
    phone: None,
    work_email: "bach@vpbank.com".to_string(),
    username: "bachdev".to_string(),
};

match dto.validate() {
    Ok(()) => println!("Valid!"),
    Err(errors) => println!("Errors: {:?}", errors),
}
```

### 1.3 Nested Struct Validation

```rust
#[derive(Debug, Deserialize, Validate)]
pub struct AddressDto {
    #[validate(length(min = 5, max = 200))]
    pub street: String,

    #[validate(length(min = 2, max = 100))]
    pub city: String,

    #[validate(length(equal = 5, message = "Postal code must be 5 digits"))]
    pub postal_code: String,
}

#[derive(Debug, Deserialize, Validate)]
pub struct RegisterDto {
    #[validate(length(min = 2, max = 50))]
    pub username: String,

    #[validate(email)]
    pub email: String,

    #[validate(length(min = 8, max = 100))]
    pub password: String,

    // Nested validation — tự động validate AddressDto
    #[validate(nested)]
    pub address: AddressDto,

    // Vec of nested
    #[validate(nested)]
    pub contacts: Vec<ContactDto>,
}
```

### 1.4 Custom Validation Functions

```rust
use validator::ValidationError;

// Custom validator function
fn validate_not_future_date(date: &chrono::NaiveDate) -> Result<(), ValidationError> {
    if date > &chrono::Local::now().date_naive() {
        let mut err = ValidationError::new("date_in_future");
        err.message = Some("Date cannot be in the future".into());
        return Err(err);
    }
    Ok(())
}

fn validate_vietnamese_id(id: &str) -> Result<(), ValidationError> {
    // CCCD: 12 chữ số, CMND: 9 chữ số
    let valid = (id.len() == 12 || id.len() == 9) && id.chars().all(|c| c.is_numeric());
    if !valid {
        return Err(ValidationError::new("invalid_vietnamese_id"));
    }
    Ok(())
}

#[derive(Debug, Deserialize, Validate)]
pub struct DocumentDto {
    #[validate(length(min = 1, max = 500))]
    pub title: String,

    #[validate(custom(function = "validate_not_future_date"))]
    pub issue_date: chrono::NaiveDate,

    #[validate(custom(function = "validate_vietnamese_id"))]
    pub owner_id_number: String,
}
```

### 1.5 Cross-field Validation (Must Validate Manually)

```rust
use validator::{Validate, ValidationErrors, ValidationErrorsKind};

#[derive(Debug, Deserialize, Validate)]
pub struct ChangePasswordDto {
    pub current_password: String,

    #[validate(length(min = 8, message = "Password must be at least 8 characters"))]
    pub new_password: String,

    pub confirm_password: String,
}

// Cross-field validation không support qua derive → implement thủ công
impl ChangePasswordDto {
    pub fn validate_all(&self) -> Result<(), ValidationErrors> {
        // 1. Field-level validation trước
        let mut errors = match self.validate() {
            Ok(()) => ValidationErrors::new(),
            Err(e) => e,
        };

        // 2. Cross-field: passwords must match
        if self.new_password != self.confirm_password {
            let mut err = validator::ValidationError::new("password_mismatch");
            err.message = Some("Passwords do not match".into());
            errors.add("confirm_password", err);
        }

        // 3. New password must differ from current
        if self.current_password == self.new_password {
            let mut err = validator::ValidationError::new("same_password");
            err.message = Some("New password must differ from current password".into());
            errors.add("new_password", err);
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}
```

---

## PHẦN 2 — garde Crate (Modern Alternative)

### 2.1 garde vs validator

```
validator:
  + Mature, widely used
  + Nhiều built-in rules
  - Cross-field validation awkward
  - Message customization verbose

garde:
  + Ergonomic syntax
  + Context-aware validation (có thể pass context vào)
  + Cross-field dễ hơn
  - Ít documentation hơn
```

```toml
[dependencies]
garde = { version = "0.20", features = ["derive", "email"] }
```

```rust
use garde::Validate;
use serde::Deserialize;

#[derive(Debug, Deserialize, Validate)]
#[garde(context(AppConfig))]  // context-aware validation!
pub struct CreateDocumentDto {
    #[garde(length(min = 1, max = 500))]
    pub title: String,

    #[garde(inner(length(min = 1, max = 100)))]
    pub tags: Vec<String>,

    #[garde(range(min = 1, max = 1000))]
    pub page_count: u32,

    #[garde(skip)]   // skip validation cho field này
    pub internal_ref: String,
}

// Context validation — biết về config khi validate
pub struct AppConfig {
    pub max_document_size: u32,
    pub allowed_categories: Vec<String>,
}

#[derive(Debug, Deserialize, Validate)]
#[garde(context(AppConfig))]
pub struct UploadDocumentDto {
    #[garde(length(min = 1, max = 500))]
    pub title: String,

    // Custom rule với context
    #[garde(custom(validate_category))]
    pub category: String,

    #[garde(range(max = ctx.max_document_size))]
    pub file_size_kb: u32,
}

fn validate_category(value: &str, context: &AppConfig) -> garde::Result {
    if context.allowed_categories.contains(&value.to_string()) {
        Ok(())
    } else {
        Err(garde::Error::new("Category not allowed"))
    }
}

// Sử dụng với context
let config = AppConfig {
    max_document_size: 10240,
    allowed_categories: vec!["contract".into(), "invoice".into()],
};

let dto = UploadDocumentDto {
    title: "Q4 Contract".into(),
    category: "contract".into(),
    file_size_kb: 1024,
};

dto.validate_with(&config)?;
```

---

## PHẦN 3 — Custom Axum Extractor với Validation

### 3.1 ValidatedJson Extractor — Production Pattern

```rust
// Thay vì dùng Json<T> (không validate), dùng ValidatedJson<T>
// Tự động validate sau khi deserialize

use axum::{
    async_trait,
    body::Body,
    extract::{FromRequest, Request},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::de::DeserializeOwned;
use serde_json::json;
use validator::Validate;

// Custom error response cho validation failures
#[derive(serde::Serialize)]
pub struct ValidationErrorResponse {
    pub code: &'static str,
    pub message: &'static str,
    pub fields: std::collections::HashMap<String, Vec<String>>,
}

impl IntoResponse for ValidationErrorResponse {
    fn into_response(self) -> Response {
        (StatusCode::UNPROCESSABLE_ENTITY, Json(self)).into_response()
    }
}

// Helper: convert ValidationErrors → HashMap<field, Vec<message>>
fn format_validation_errors(
    errors: validator::ValidationErrors,
) -> std::collections::HashMap<String, Vec<String>> {
    errors
        .field_errors()
        .iter()
        .map(|(field, errs)| {
            let messages: Vec<String> = errs
                .iter()
                .map(|e| {
                    e.message
                        .as_ref()
                        .map(|m| m.to_string())
                        .unwrap_or_else(|| format!("Validation failed: {}", e.code))
                })
                .collect();
            (field.to_string(), messages)
        })
        .collect()
}

// The extractor
pub struct ValidatedJson<T>(pub T);

#[async_trait]
impl<T, S> FromRequest<S> for ValidatedJson<T>
where
    T: DeserializeOwned + Validate,
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        // 1. Deserialize
        let Json(value) = Json::<T>::from_request(req, state)
            .await
            .map_err(|rejection| {
                // JSON parse error → 400 Bad Request
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "code": "INVALID_JSON",
                        "message": rejection.body_text()
                    })),
                )
                    .into_response()
            })?;

        // 2. Validate
        value.validate().map_err(|errors| {
            ValidationErrorResponse {
                code: "VALIDATION_FAILED",
                message: "Request validation failed",
                fields: format_validation_errors(errors),
            }
            .into_response()
        })?;

        Ok(ValidatedJson(value))
    }
}

// Dùng trong handler — đơn giản như Json<T>
async fn create_user(
    ValidatedJson(dto): ValidatedJson<CreateUserDto>,
) -> Result<impl IntoResponse, AppError> {
    // dto đã được validate — an toàn 100%
    let user = user_service::create(dto).await?;
    Ok((StatusCode::CREATED, Json(user)))
}
```

### 3.2 ValidatedQuery Extractor

```rust
use axum::extract::{FromRequestParts, Query};
use axum::http::request::Parts;

pub struct ValidatedQuery<T>(pub T);

#[async_trait]
impl<T, S> FromRequestParts<S> for ValidatedQuery<T>
where
    T: DeserializeOwned + Validate,
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let Query(value) = Query::<T>::from_request_parts(parts, state)
            .await
            .map_err(|rejection| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "code": "INVALID_QUERY", "message": rejection.to_string() })),
                )
                    .into_response()
            })?;

        value.validate().map_err(|errors| {
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(ValidationErrorResponse {
                    code: "VALIDATION_FAILED",
                    message: "Query parameter validation failed",
                    fields: format_validation_errors(errors),
                }),
            )
                .into_response()
        })?;

        Ok(ValidatedQuery(value))
    }
}

// Query struct với validation
#[derive(Debug, Deserialize, Validate)]
pub struct PaginationQuery {
    #[validate(range(min = 1, max = 1000, message = "Page must be 1-1000"))]
    pub page: Option<u32>,

    #[validate(range(min = 1, max = 100, message = "Size must be 1-100"))]
    pub size: Option<u32>,

    #[validate(length(max = 200, message = "Search query too long"))]
    pub search: Option<String>,
}

// Dùng trong handler
async fn list_users(
    ValidatedQuery(query): ValidatedQuery<PaginationQuery>,
) -> impl IntoResponse {
    // query.page, query.size đã validated
    let page = query.page.unwrap_or(1);
    let size = query.size.unwrap_or(20);
    Json(json!({ "page": page, "size": size }))
}
```

### 3.3 ValidatedPath Extractor

```rust
use axum::extract::Path;

pub struct ValidatedPath<T>(pub T);

#[async_trait]
impl<T, S> FromRequestParts<S> for ValidatedPath<T>
where
    T: DeserializeOwned + Validate + Send,
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let Path(value) = Path::<T>::from_request_parts(parts, state)
            .await
            .map_err(|rejection| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "code": "INVALID_PATH", "message": rejection.to_string() })),
                )
                    .into_response()
            })?;

        value.validate().map_err(|errors| {
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(ValidationErrorResponse {
                    code: "VALIDATION_FAILED",
                    message: "Path parameter validation failed",
                    fields: format_validation_errors(errors),
                }),
            )
                .into_response()
        })?;

        Ok(ValidatedPath(value))
    }
}

#[derive(Debug, Deserialize, Validate)]
pub struct DocumentPathParams {
    #[validate(range(min = 1))]
    pub id: i64,
}

async fn get_document(
    ValidatedPath(params): ValidatedPath<DocumentPathParams>,
) -> impl IntoResponse {
    Json(json!({ "id": params.id }))
}
```

---

## PHẦN 4 — Error Response Formatting

### 4.1 Standardized Error Format

```rust
// Chuẩn hóa format validation error (theo RFC 7807 — Problem Details)
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Serialize)]
pub struct ProblemDetail {
    #[serde(rename = "type")]
    pub problem_type: String,
    pub title: String,
    pub status: u16,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<HashMap<String, Vec<FieldError>>>,
}

#[derive(Debug, Serialize)]
pub struct FieldError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejected_value: Option<serde_json::Value>,
}

impl ProblemDetail {
    pub fn validation_error(
        errors: validator::ValidationErrors,
        instance: Option<String>,
    ) -> Self {
        let field_errors: HashMap<String, Vec<FieldError>> = errors
            .field_errors()
            .iter()
            .map(|(field, errs)| {
                let field_errors: Vec<FieldError> = errs
                    .iter()
                    .map(|e| FieldError {
                        code: e.code.to_string(),
                        message: e
                            .message
                            .as_ref()
                            .map(|m| m.to_string())
                            .unwrap_or_else(|| format!("Validation rule '{}' failed", e.code)),
                        rejected_value: e.params.get("value").cloned(),
                    })
                    .collect();
                (field.to_string(), field_errors)
            })
            .collect();

        ProblemDetail {
            problem_type: "https://api.pdms.vpbank.com/errors/validation-failed".to_string(),
            title: "Validation Failed".to_string(),
            status: 422,
            detail: "One or more fields failed validation".to_string(),
            instance,
            errors: Some(field_errors),
        }
    }
}

// Response body example:
// {
//   "type": "https://api.pdms.vpbank.com/errors/validation-failed",
//   "title": "Validation Failed",
//   "status": 422,
//   "detail": "One or more fields failed validation",
//   "errors": {
//     "email": [{ "code": "email", "message": "Invalid email format" }],
//     "age": [{ "code": "range", "message": "Age must be 18-120", "rejected_value": 15 }]
//   }
// }
```

---

## PHẦN 5 — Advanced Patterns

### 5.1 Conditional Validation

```rust
use validator::{Validate, ValidationErrors};

#[derive(Debug, Deserialize)]
pub struct TransferDto {
    pub transfer_type: String,  // "domestic" | "international"
    pub amount: f64,
    pub recipient_account: String,
    pub recipient_bank_code: Option<String>,  // bắt buộc nếu international
    pub swift_code: Option<String>,           // bắt buộc nếu international
}

impl TransferDto {
    pub fn validate_all(&self) -> Result<(), ValidationErrors> {
        let mut errors = ValidationErrors::new();

        // Amount validation
        if self.amount <= 0.0 {
            let mut err = validator::ValidationError::new("positive_amount");
            err.message = Some("Amount must be positive".into());
            errors.add("amount", err);
        }

        // Conditional: international transfer cần thêm fields
        if self.transfer_type == "international" {
            if self.recipient_bank_code.is_none() {
                let mut err = validator::ValidationError::new("required");
                err.message = Some("Bank code required for international transfers".into());
                errors.add("recipient_bank_code", err);
            }
            if self.swift_code.is_none() {
                let mut err = validator::ValidationError::new("required");
                err.message = Some("SWIFT code required for international transfers".into());
                errors.add("swift_code", err);
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}
```

### 5.2 Validation với Database Check (Async)

```rust
use sqlx::PgPool;

pub struct DbValidatedJson<T> {
    pub value: T,
}

// Ví dụ: validate email không tồn tại trong DB
pub async fn validate_unique_email(
    email: &str,
    pool: &PgPool,
) -> Result<(), validator::ValidationError> {
    let exists: bool =
        sqlx::query_scalar!("SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)", email)
            .fetch_one(pool)
            .await
            .unwrap_or(false)
            .unwrap_or(false);

    if exists {
        let mut err = validator::ValidationError::new("unique_email");
        err.message = Some("Email already registered".into());
        return Err(err);
    }
    Ok(())
}

// Trong handler — gọi async validation
async fn register_user(
    State(pool): State<PgPool>,
    ValidatedJson(dto): ValidatedJson<RegisterDto>,
) -> Result<impl IntoResponse, AppError> {
    // Sync validation đã xảy ra trong extractor
    // Async validation (DB check) thực hiện trong handler
    validate_unique_email(&dto.email, &pool)
        .await
        .map_err(|_| AppError::Conflict("Email already registered".into()))?;

    // Proceed with creation
    let user = create_user_in_db(&pool, dto).await?;
    Ok((StatusCode::CREATED, Json(user)))
}
```

### 5.3 Reusable Validation Rules

```rust
// Tạo module validation rules dùng chung
pub mod rules {
    use validator::ValidationError;

    pub fn validate_vn_phone(phone: &str) -> Result<(), ValidationError> {
        let cleaned = phone.replace([' ', '-', '(', ')'], "");
        let patterns = [
            (r"^\+84[0-9]{9}$", "International format"),
            (r"^0[0-9]{9}$", "Domestic format"),
        ];
        for (pattern, _) in &patterns {
            if regex::Regex::new(pattern).unwrap().is_match(&cleaned) {
                return Ok(());
            }
        }
        let mut err = ValidationError::new("invalid_vn_phone");
        err.message = Some("Invalid Vietnamese phone number".into());
        Err(err)
    }

    pub fn validate_vn_tax_code(code: &str) -> Result<(), ValidationError> {
        // MST: 10 hoặc 13 chữ số
        let valid =
            (code.len() == 10 || code.len() == 13) && code.chars().all(|c| c.is_numeric());
        if !valid {
            let mut err = ValidationError::new("invalid_tax_code");
            err.message = Some("Invalid Vietnamese tax code (10 or 13 digits)".into());
            return Err(err);
        }
        Ok(())
    }

    pub fn validate_contract_number(number: &str) -> Result<(), ValidationError> {
        // Format: YYYY-XXX-NNN (e.g., 2024-CTR-001)
        let re = regex::Regex::new(r"^\d{4}-[A-Z]{3}-\d{3}$").unwrap();
        if !re.is_match(number) {
            let mut err = ValidationError::new("invalid_contract_number");
            err.message = Some("Contract number format: YYYY-XXX-NNN".into());
            return Err(err);
        }
        Ok(())
    }
}

// Dùng trong DTOs
#[derive(Deserialize, Validate)]
pub struct CompanyDto {
    pub name: String,

    #[validate(custom(function = "rules::validate_vn_tax_code"))]
    pub tax_code: String,

    #[validate(custom(function = "rules::validate_vn_phone"))]
    pub phone: String,
}
```

---

## PHẦN 6 — Testing Validation

```rust
#[cfg(test)]
mod validation_tests {
    use super::*;
    use validator::Validate;

    #[test]
    fn test_valid_user_dto() {
        let dto = CreateUserDto {
            name: "Bach Nguyen".to_string(),
            email: "bach@vpbank.com.vn".to_string(),
            age: 30,
            website: None,
            phone: Some("+84912345678".to_string()),
            work_email: "bach@vpbank.com".to_string(),
            username: "bachdev".to_string(),
        };
        assert!(dto.validate().is_ok());
    }

    #[test]
    fn test_invalid_email() {
        let dto = CreateUserDto {
            email: "not-an-email".to_string(),
            ..valid_user_dto()
        };
        let errors = dto.validate().unwrap_err();
        assert!(errors.field_errors().contains_key("email"));
    }

    #[test]
    fn test_name_too_short() {
        let dto = CreateUserDto {
            name: "A".to_string(),
            ..valid_user_dto()
        };
        let errors = dto.validate().unwrap_err();
        let field_errors = errors.field_errors();
        assert!(field_errors.contains_key("name"));
        assert_eq!(field_errors["name"][0].code, "length");
    }

    #[test]
    fn test_cross_field_password_mismatch() {
        let dto = ChangePasswordDto {
            current_password: "old_pass".to_string(),
            new_password: "new_pass_123".to_string(),
            confirm_password: "different_pass".to_string(),
        };
        let errors = dto.validate_all().unwrap_err();
        assert!(errors.field_errors().contains_key("confirm_password"));
    }

    #[test]
    fn test_multiple_validation_errors() {
        let dto = CreateUserDto {
            name: "A".to_string(),           // too short
            email: "invalid".to_string(),    // bad format
            age: 10,                         // below 18
            ..valid_user_dto()
        };
        let errors = dto.validate().unwrap_err();
        let fields = errors.field_errors();
        assert!(fields.contains_key("name"));
        assert!(fields.contains_key("email"));
        assert!(fields.contains_key("age"));
        // 3 fields fail
        assert_eq!(fields.len(), 3);
    }

    fn valid_user_dto() -> CreateUserDto {
        CreateUserDto {
            name: "Bach Nguyen".to_string(),
            email: "bach@vpbank.com.vn".to_string(),
            age: 30,
            website: None,
            phone: None,
            work_email: "bach@vpbank.com".to_string(),
            username: "bachdev".to_string(),
        }
    }
}
```

---

## 🎯 So Sánh Java Spring Validation

| Concept | Spring (Bean Validation) | Rust |
|---|---|---|
| Annotation | `@NotBlank`, `@Email` | `#[validate(length(...))]` |
| Trigger | `@Valid` trên param | `dto.validate()?` hoặc extractor |
| Error | `MethodArgumentNotValidException` | `ValidationErrors` |
| Custom rule | `@Constraint` + `ConstraintValidator` | `custom(function = "fn_name")` |
| Cross-field | `@ScriptAssert` hoặc custom | Custom `validate_all()` method |
| Nested | `@Valid` trên field | `#[validate(nested)]` |
| Global handler | `@ControllerAdvice` | Custom Axum extractor |
| Async validate | `@Async` + workarounds | Direct `async fn` trong handler |

---

## 🏋️ Bài Tập

1. **PDMS Document Validator**: Implement `CreateDocumentDto` với fields: title (3-500 chars), category (enum: contract/invoice/report), file_size_kb (max 51200), tags (max 10 items, mỗi item max 50 chars), effective_date (không được là future). Viết test đầy đủ.

2. **Custom Extractor**: Implement `ValidatedForm<T>` cho form submission (multipart/form-data). Tích hợp với validator.

3. **DB Validation**: Implement async validation check: contract number unique trong DB. Handler reject với 409 Conflict nếu duplicate.

4. **Error RFC 7807**: Implement `ProblemDetail` format đầy đủ. Test response body với Axum TestClient.

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-10-Axum-Core|Bài 10: Axum — Extractors]]
- [[Rust-Zero-To-Hero/Bai-13-Serde-Reqwest-JWT|Bài 13: Serde]]
- [[Rust-Zero-To-Hero/Bai-31-Redis-Caching|Bài 31: Redis & Caching]] → tiếp theo
