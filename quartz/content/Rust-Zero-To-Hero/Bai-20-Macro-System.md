# Bài 20: Macro System — Code Sinh Ra Code

> **Java analog:** Annotation Processing (APT) + Lombok. Nhưng Rust macros mạnh hơn nhiều: operate trên AST, không cần reflection, zero runtime overhead, và có thể tạo bất kỳ valid Rust code nào.

---

## 1. Hai loại Macro — Declarative và Procedural

```
Declarative (macro_rules!):
  Pattern matching trên token trees
  → Simple, trong cùng crate
  → Ví dụ: vec!, println!, assert_eq!

Procedural (proc-macro):
  Function nhận TokenStream, trả TokenStream
  → Powerful, cần crate riêng
  → Ví dụ: #[derive(Serialize)], #[tokio::main], #[instrument]
  
Java analog:
  macro_rules!  ≈ không có gì gần giống
  proc-macro    ≈ Annotation Processor (APT) nhưng không cần reflection
```

---

## 2. Declarative Macros — `macro_rules!`

```rust
// Syntax: pattern matching trên token trees
macro_rules! my_vec {
    // Pattern 1: empty vec![]
    () => {
        Vec::new()
    };
    
    // Pattern 2: vec![1, 2, 3]
    // $x:expr = "match expression", $(...),* = "repeat with comma"
    ($($x:expr),+) => {
        {
            let mut v = Vec::new();
            $(
                v.push($x);  // $x được expand cho mỗi element
            )+
            v
        }
    };
}

let empty: Vec<i32> = my_vec![];         // Vec::new()
let nums  = my_vec![1, 2, 3, 4];         // push 4 lần

// Macro fragment specifiers (loại token có thể match):
// expr   → expression: 1 + 2, "hello", func()
// ident  → identifier: foo, my_var
// ty     → type: i32, Vec<String>
// stmt   → statement: let x = 5;
// pat    → pattern: Some(x), (a, b)
// block  → block: { ... }
// tt     → token tree: bất kỳ token nào
// literal→ literal: 42, "hello"
```

### Ví dụ thực tế — HashMap builder macro

```rust
macro_rules! hashmap {
    ($($key:expr => $val:expr),* $(,)?) => {
        {
            let mut map = std::collections::HashMap::new();
            $(
                map.insert($key, $val);
            )*
            map
        }
    };
}

let config = hashmap! {
    "host"    => "localhost",
    "port"    => "5432",
    "dbname"  => "pdms",
};
// Tương đương: Map.of("host", "localhost", ...) trong Java
// Nhưng không cần HashMap::from([]) syntax phức tạp
```

### Ví dụ — retry macro

```rust
macro_rules! retry {
    ($times:expr, $body:block) => {
        {
            let mut attempt = 0;
            loop {
                attempt += 1;
                let result = $body;
                if result.is_ok() || attempt >= $times {
                    break result;
                }
                tracing::warn!(attempt, "Retrying...");
            }
        }
    };
}

// Dùng:
let response = retry!(3, {
    http_client.get(url).send().await
})?;
```

---

## 3. Procedural Macros — Ba Loại

```
1. Custom derive:   #[derive(MyTrait)]
2. Attribute macro: #[my_attribute]
3. Function-like:   my_macro!(...)
```

### Setup — proc-macro cần crate riêng

```toml
# Cargo.toml của proc-macro crate:
[lib]
proc-macro = true

[dependencies]
syn = { version = "2", features = ["full"] }    # parse Rust AST
quote = "1"                                       # generate Rust code
proc-macro2 = "1"                                 # TokenStream types
```

### Custom Derive — `#[derive(MyTrait)]`

```rust
// Trong proc-macro crate (src/lib.rs):
use proc_macro::TokenStream;
use quote::quote;
use syn::{parse_macro_input, DeriveInput};

#[proc_macro_derive(HelloWorld)]
pub fn hello_world_derive(input: TokenStream) -> TokenStream {
    // Parse input tokens thành AST
    let ast = parse_macro_input!(input as DeriveInput);
    
    let name = &ast.ident;  // lấy tên struct/enum
    
    // Generate code với quote!
    let gen = quote! {
        impl HelloWorld for #name {
            fn hello_world() {
                println!("Hello, World! My name is {}", stringify!(#name));
            }
        }
    };
    
    gen.into()
}
```

```rust
// Trong crate dùng proc-macro:
use my_derive::HelloWorld;

#[derive(HelloWorld)]
struct MyStruct;

fn main() {
    MyStruct::hello_world(); // "Hello, World! My name is MyStruct"
}
```

### Implement Builder derive thực tế

```rust
// Tạo Builder pattern tự động từ struct
#[proc_macro_derive(Builder)]
pub fn derive_builder(input: TokenStream) -> TokenStream {
    let ast = parse_macro_input!(input as DeriveInput);
    let name = &ast.ident;
    let builder_name = format_ident!("{}Builder", name);
    
    // Extract fields từ struct
    let fields = match &ast.data {
        syn::Data::Struct(s) => &s.fields,
        _ => panic!("Builder only works on structs"),
    };
    
    // Generate Option<T> fields cho builder
    let builder_fields = fields.iter().map(|f| {
        let fname = &f.ident;
        let ftype = &f.ty;
        quote! { #fname: Option<#ftype> }
    });
    
    // Generate setter methods
    let setters = fields.iter().map(|f| {
        let fname = &f.ident;
        let ftype = &f.ty;
        quote! {
            pub fn #fname(mut self, val: #ftype) -> Self {
                self.#fname = Some(val);
                self
            }
        }
    });
    
    let gen = quote! {
        struct #builder_name {
            #(#builder_fields,)*
        }
        
        impl #builder_name {
            #(#setters)*
        }
        
        impl #name {
            pub fn builder() -> #builder_name {
                #builder_name {
                    #(#(#fields.ident)?: None,)*
                }
            }
        }
    };
    
    gen.into()
}
```

### Attribute Macro — `#[my_attribute]`

```rust
// Ví dụ: #[retry(times = 3)] attribute
#[proc_macro_attribute]
pub fn retry(attr: TokenStream, item: TokenStream) -> TokenStream {
    let times: usize = attr.to_string().parse().unwrap_or(3);
    let mut function = parse_macro_input!(item as syn::ItemFn);
    let fn_name = &function.sig.ident;
    let fn_body = &function.block;
    
    let gen = quote! {
        async fn #fn_name() {
            let mut attempt = 0;
            loop {
                attempt += 1;
                let result = async #fn_body.await;
                if result.is_ok() || attempt >= #times { break result; }
            }
        }
    };
    
    gen.into()
}

// Dùng:
#[retry(3)]
async fn fetch_data() -> Result<Data, Error> {
    http_client.get(url).send().await
}
```

---

## 4. `cargo expand` — Xem Macro Output

```bash
# Install
cargo install cargo-expand

# Xem macro expansion
cargo expand

# Chỉ expand một module:
cargo expand my_module

# Output: code Rust sau khi expand tất cả macros
# Hữu ích để:
# 1. Debug macro không hoạt động đúng
# 2. Hiểu #[derive(Serialize)] sinh ra gì
# 3. Tối ưu generated code
```

```rust
// Input:
#[derive(Debug)]
struct Point { x: i32, y: i32 }

// cargo expand output:
impl std::fmt::Debug for Point {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Point")
         .field("x", &self.x)
         .field("y", &self.y)
         .finish()
    }
}
// Đây là code thực sự được compile — zero overhead
```

---

## 5. Common Macros trong Web Stack

```rust
// tokio::main — attribute macro
#[tokio::main]
async fn main() { ... }
// Expands to:
fn main() {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async { ... })
}

// tracing::instrument — attribute macro
#[instrument(skip(pool), fields(user_id = %id))]
async fn get_user(pool: &PgPool, id: i64) -> Result<User, Error> {
    // tự tạo span, log entry/exit, record fields
}

// sqlx::query! — function-like macro
let user = sqlx::query!(
    "SELECT id, name FROM users WHERE id = $1", id
).fetch_one(&pool).await?;
// Verify SQL tại compile time — syntax check, column types, parameter count
// user.id: i64, user.name: String — typed từ DB schema

// thiserror::Error — derive macro
#[derive(thiserror::Error, Debug)]
enum AppError {
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("DB error: {0}")]
    Database(#[from] sqlx::Error),
}
// Generates: impl Display, impl Error, impl From<sqlx::Error>
```

---

## 6. Macro Hygiene — Tại Sao Rust Macros Safe Hơn C Macros

```c
// C macro — không hygienic, dangerous:
#define SQUARE(x) x * x
// SQUARE(1 + 2) = 1 + 2 * 1 + 2 = 5 (sai, muốn 9)

#define MAX(a, b) ((a) > (b) ? (a) : (b))
// MAX(i++, j++) — i và j bị increment 2 lần!
```

```rust
// Rust macro — hygienic: variables trong macro không leak ra ngoài
macro_rules! swap {
    ($a:ident, $b:ident) => {
        let temp = $a;   // 'temp' không conflict với caller's variables
        $a = $b;
        $b = temp;
    };
}

let temp = "I am caller's temp";
let mut x = 1;
let mut y = 2;
swap!(x, y);
println!("{}", temp); // "I am caller's temp" — không bị override!
// x = 2, y = 1
```

---

## 7. Java vs Rust — Metaprogramming Comparison

| Feature | Java | Rust |
|---|---|---|
| Code generation | APT, Lombok | macro_rules!, proc-macro |
| Runtime reflection | `Class.getMethod()`, `Field.get()` | Không có — all compile time |
| Boilerplate reduction | `@Data`, `@Builder` (Lombok) | `#[derive(Debug, Clone, Builder)]` |
| Overhead | Runtime reflection cost | Zero — code inlined at compile |
| Error messages | Runtime StackTrace | Compile error with span |
| Type safety | Annotation strings | Token-level type safety |
| Debugging | Decompile .class | `cargo expand` |

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-6-Generics-Traits-Advanced|Bài 6: Traits — macros derive từ traits]]
- [[Rust-Zero-To-Hero/Bai-13-Serde-Reqwest-JWT|Bài 13: Serde — proc-macro in action]]
- [[Rust-Zero-To-Hero/Bai-21-Async-Internals-Pin|Bài 21: Async Internals]] → tiếp theo

---
*Bài tập:*
1. Viết `hashmap!` macro hỗ trợ trailing comma. Test với `hashmap!{"a" => 1, "b" => 2,}`.
2. Dùng `cargo expand` trên một struct có `#[derive(Debug, Serialize)]`. Đọc generated code và giải thích từng method.
3. Viết proc-macro `#[log_calls]` tự động thêm `tracing::info!("calling {fn_name}")` vào đầu mỗi function được annotate.
