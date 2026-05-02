# Bài 19: Unsafe Rust & FFI — Khi Safe Không Đủ

> **Tại sao học Unsafe?** Không phải để dùng nhiều — mà để hiểu **tại sao** safe Rust có những restrictions như vậy. Khi bạn biết điều gì xảy ra trong unsafe, toàn bộ borrow checker trở nên có lý. 95% code Rust production không cần unsafe.

---

## 1. Safe vs Unsafe — Ranh Giới Rõ Ràng

```
Safe Rust:   Compiler guarantee: no memory bugs, no data races
Unsafe Rust: YOU take responsibility — compiler tin bạn

Java analog:
  Safe Rust  ≈ Java với SecurityManager (enforce rules)
  Unsafe Rust ≈ JNI (bạn tự manage memory, compiler không help)
```

```rust
// unsafe block: "Tôi biết tôi đang làm gì, compiler hãy tin tôi"
unsafe {
    // Ở đây bạn có thể:
    // 1. Dereference raw pointers
    // 2. Call unsafe functions/methods
    // 3. Access/modify mutable static variables
    // 4. Implement unsafe traits
    // 5. Access fields của union
}

// 5 điều này KHÔNG có trong safe Rust vì compiler không thể verify
```

---

## 2. Raw Pointers — `*const T` và `*mut T`

```rust
let x = 42i32;
let safe_ref: &i32 = &x;              // safe reference — always valid
let raw_ptr: *const i32 = &x as *const i32;  // raw pointer — có thể null, dangling

// Tạo raw pointer — safe (chỉ tạo, chưa dereference)
let mut y = 100i32;
let ptr: *mut i32 = &mut y as *mut i32;

// Dereference — PHẢI trong unsafe block
unsafe {
    println!("{}", *raw_ptr);    // đọc qua raw pointer
    *ptr = 200;                  // ghi qua raw pointer
    println!("{}", y);           // 200
}

// So sánh với Java:
// Java reference = safe reference trong Rust (GC đảm bảo valid)
// C void* pointer = raw pointer trong Rust
// JNI jobject = raw pointer nhưng được JVM manage

// Raw pointer properties:
// - Có thể là null (safe reference không thể null)
// - Có thể dangling (safe reference guaranteed valid)
// - Không có borrow checking
// - Không auto-drop
```

---

## 3. Unsafe Functions

```rust
// Hàm unsafe: caller phải đảm bảo preconditions
unsafe fn dangerous_operation(ptr: *mut i32, len: usize) {
    // Compiler không verify — bạn phải đúng
    for i in 0..len {
        *ptr.add(i) = i as i32;
    }
}

// Safe wrapper — đây là pattern chuẩn:
fn safe_wrapper(slice: &mut [i32]) {
    // Validate preconditions trong safe code
    if slice.is_empty() { return; }
    
    // Bây giờ gọi unsafe với preconditions đã verified
    unsafe {
        dangerous_operation(slice.as_mut_ptr(), slice.len());
    }
}

// Ví dụ từ std library: slice::from_raw_parts
pub unsafe fn from_raw_parts<'a, T>(ptr: *const T, len: usize) -> &'a [T] {
    // Caller phải đảm bảo:
    // 1. ptr valid và non-null
    // 2. ptr aligned cho T
    // 3. ptr..ptr+len là valid memory
    // 4. Memory không bị mutate trong lifetime 'a
    // ...
}

// Safe pattern — dùng std safe APIs thay vì từ đầu
let v = vec![1, 2, 3, 4, 5];
let slice: &[i32] = &v[1..4];  // safe — bounds checked
// vs
let slice = unsafe { std::slice::from_raw_parts(v.as_ptr().add(1), 3) };
// unsafe — bạn tự verify bounds
```

---

## 4. Unsafe Traits

```rust
// unsafe trait: implementation phải maintain invariants
// mà compiler không thể verify

// Send: safe to transfer ownership across threads
// Sync: safe to share reference across threads
// Compiler auto-derives Send/Sync cho most types
// Nhưng raw pointer *mut T không auto-derive → compiler conservative

struct MyBuffer {
    ptr: *mut u8,
    len: usize,
}

// Manual implementation — bạn đảm bảo thread safety
unsafe impl Send for MyBuffer {}
unsafe impl Sync for MyBuffer {}

// Java analog:
// Thread-safe class annotation (@ThreadSafe) = documentation
// Rust unsafe impl = COMPILER TRACKED documentation
// Nếu bạn implement Send sai → data race, UB tại runtime
// Nhưng Rust track việc bạn đã explicit opt-in
```

---

## 5. Interior Mutability Pattern — Unsafe Underneath

```rust
// Cell<T>, RefCell<T>, Mutex<T> đều dùng unsafe internally
// nhưng expose safe API với runtime checks

// UnsafeCell<T> — building block của mọi interior mutability
use std::cell::UnsafeCell;

struct MyCell<T> {
    value: UnsafeCell<T>,
}

impl<T: Copy> MyCell<T> {
    pub fn new(val: T) -> Self {
        MyCell { value: UnsafeCell::new(val) }
    }
    
    pub fn get(&self) -> T {
        // SAFETY: MyCell<T> is not Sync, so only one thread accesses this
        unsafe { *self.value.get() }
    }
    
    pub fn set(&self, val: T) {
        // SAFETY: same as above + T: Copy, no drop needed
        unsafe { *self.value.get() = val; }
    }
}

// SAFETY comment là convention quan trọng
// Giải thích TẠI SAO unsafe code này correct
// Đây là cách Rust community document unsafe code
```

---

## 6. FFI — Gọi C từ Rust và Ngược Lại

### Gọi C library từ Rust

```rust
// Ví dụ: gọi C's strlen
extern "C" {
    fn strlen(s: *const std::os::raw::c_char) -> usize;
}

fn main() {
    let c_string = std::ffi::CString::new("hello world").unwrap();
    
    let len = unsafe {
        strlen(c_string.as_ptr())
    };
    
    println!("Length: {}", len); // 11
}
```

```toml
# Cargo.toml — link với C library
[dependencies]
libc = "0.2"

# Nếu cần link static library:
[build-dependencies]
cc = "1.0"
```

```rust
// build.rs — compile và link C code
fn main() {
    cc::Build::new()
        .file("src/mylib.c")
        .compile("mylib");
    
    println!("cargo:rustc-link-lib=static=mylib");
}
```

### Export Rust function cho C

```rust
// Expose Rust function với C ABI
#[no_mangle]  // đừng mangle function name
pub extern "C" fn add_numbers(a: i32, b: i32) -> i32 {
    a + b
}

// Header file cho C:
// extern int32_t add_numbers(int32_t a, int32_t b);

// Cargo.toml:
// [lib]
// crate-type = ["cdylib"]  # tạo .so/.dll
```

### bindgen — Auto-generate FFI bindings

```bash
cargo install bindgen-cli

# Từ C header tự động tạo Rust bindings:
bindgen mylib.h -o src/bindings.rs

# Trong build.rs:
bindgen::Builder::default()
    .header("mylib.h")
    .generate()
    .unwrap()
    .write_to_file("src/bindings.rs")
    .unwrap();
```

---

## 7. Khi Nào Dùng Unsafe — Decision Tree

```
Bạn cần unsafe khi:
│
├─ FFI với C library?
│   → extern "C" block, CString/CStr cho strings
│
├─ Performance critical: tránh bounds check trong hot loop?
│   → get_unchecked() với proof bounds đã verified
│   → Nhưng: profile trước, bounds check thường free (CPU predict)
│
├─ Implement data structure yêu cầu aliasing?
│   → LinkedList, intrusive collections, arena allocators
│
├─ Implement interior mutability primitive?
│   → UnsafeCell<T> — building block
│
└─ Gần như mọi trường hợp khác?
    → Dùng safe Rust. Bạn đang overthink.

Rust philosophy: unsafe là escape hatch, không phải shortcut.
90% performance gains có thể đạt được trong safe Rust.
```

---

## 8. SAFETY Comments — Convention Bắt Buộc

```rust
// Mọi unsafe block/function cần SAFETY comment:
// Giải thích invariants bạn đang uphold

fn get_first_unchecked(slice: &[i32]) -> i32 {
    // SAFETY: caller guarantees slice is non-empty.
    // This is verified by checking slice.len() > 0 before calling.
    unsafe { *slice.get_unchecked(0) }
}

impl<T> Vec<T> {
    pub fn push(&mut self, val: T) {
        if self.len == self.capacity {
            self.grow();
        }
        // SAFETY: We just ensured len < capacity,
        // so this write is within bounds.
        unsafe {
            std::ptr::write(self.ptr.add(self.len), val);
        }
        self.len += 1;
    }
}
```

---

## 9. Tools: Audit Unsafe Code

```bash
# cargo-geiger: đếm unsafe usage trong project và dependencies
cargo install cargo-geiger
cargo geiger

# Output:
# Functions  Expressions  Impls  Traits  Methods
#      0/0          0/0    0/0     0/0      0/0  your_crate
#      2/2         15/15   1/1     0/0      3/3  some_dependency

# Miri: execute Rust với memory model interpreter — detect UB
rustup component add miri
cargo miri test
# Detect: use-after-free, invalid alignment, data races, out-of-bounds
```

---

## 10. Unsafe vs Java JNI

| | Java JNI | Rust Unsafe |
|---|---|---|
| Trigger | Crossing JVM boundary | `unsafe` block |
| Memory model | JVM managed + native | Rust ownership + raw |
| Error detection | Runtime (segfault, OOME) | Miri tool, ASAN |
| Documentation | @Native, comments | `SAFETY:` comment convention |
| Frequency | Explicit JNI call | Can be anywhere in codebase |
| Risk | High — JVM can crash | High — but contained in block |
| Tooling | JNI headers, javah | bindgen, cbindgen |

---

## 🔗 Links
- [[Rust-Zero-To-Hero/Bai-8-Smart-Pointers-Error-Design|Bài 8: Arc/Mutex — safe wrappers của unsafe]]
- [[Rust-Zero-To-Hero/Bai-18-Type-System-Advanced|Bài 18: Unsafe traits (Send/Sync)]]
- [[Rust-Zero-To-Hero/Bai-20-Macro-System|Bài 20: Macro System]] → tiếp theo

---
*Bài tập:*
1. Implement `MyVec<T>` đơn giản dùng raw pointer và unsafe. Cần: `new()`, `push()`, `get()`, `len()`, `Drop`. Viết SAFETY comment cho mỗi unsafe block.
2. Dùng `bindgen` generate bindings cho một C function đơn giản (ví dụ: `math.h`'s `sqrt`). Gọi từ safe Rust wrapper.
3. Chạy `cargo miri test` trên test suite của bạn. Fix bất kỳ UB nào được detect.
