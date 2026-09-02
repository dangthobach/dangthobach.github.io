---
type: course
domain: languages/rust
status: active
created: 2026-04-10
updated: 2026-08-27
tags: [depth-pass]
---

# Bài 2: Borrowing & Multi-threading - Bí kíp "Diệt tận gốc" Data Race (Deep Dive)

Ở Bài 1, `String` bị move khi gán cho biến khác. Nếu mọi lần dùng dữ liệu đều phải move, code sẽ vô cùng tù túng — mọi hàm nhận tham số đều "nuốt" luôn biến gốc. Đó là lý do có **Borrowing**: mượn quyền truy cập mà không lấy ownership.

## 1. Cơ chế bên dưới: Vì sao không được vừa đọc vừa sửa

Bài tập gốc gợi ý: *"vector bị đổi địa chỉ khi tăng kích thước"* — đây chính là lý do sâu xa.

```text
Vec<T> layout: { ptr, len, cap } — giống String hệt cấu trúc

let v = vec![1, 2, 3];       // cap = 3, buffer tại địa chỉ 0x1000
let r = &v[0];                // r trỏ tới 0x1000

v.push(4);                    // cap vượt ngưỡng -> Rust cấp phát buffer MỚI (vd 0x2000),
                               // copy toàn bộ dữ liệu cũ sang, rồi free buffer 0x1000

// r bây giờ là DANGLING POINTER — vẫn trỏ 0x1000, nơi đã bị free!
```

Đây chính xác là bug **iterator invalidation** / **use-after-free** kinh điển trong C++ (và có thể xảy ra âm thầm trong Java nếu bạn tự quản lý array bằng tay, hoặc gây `ConcurrentModificationException` khi sửa `ArrayList` trong lúc for-each). Rust chặn đứng bằng quy tắc: **muốn có `&mut v` (có thể trigger realloc) thì không được có bất kỳ `&v` nào còn sống**. Compiler không "đoán" — nó chứng minh bằng phân tích tĩnh rằng không có reference nào còn dùng tới buffer cũ tại thời điểm `push()`.

```text
[ Dữ liệu X ]
      |-- &X ----> Thread A (OK, đọc)
      |-- &X ----> Thread B (OK, đọc)
      |-- &mut X -> LỖI COMPILE! (vì buffer có thể bị realloc, làm &X ở trên thành dangling)
```

## 2. Bảng so sánh: bộ công cụ concurrency Java vs Rust

| | Java | Rust |
|---|---|---|
| Khóa độc quyền | `synchronized` (intrinsic lock trên object header — biased/lightweight/heavyweight locking tùy JIT), `ReentrantLock` | `Mutex<T>` — **data nằm bên trong lock**, không tách rời |
| Đọc-nhiều/ghi-một | `ReadWriteLock` | `RwLock<T>` |
| Đếm tham chiếu an toàn đa luồng | Không có tương đương trực tiếp (GC lo việc này) | `Arc<T>` (Atomic Reference Counted) — CAS-based increment/decrement |
| Biến nguyên tử | `AtomicInteger`, `AtomicReference` (CAS) | `AtomicUsize`, `AtomicBool`... (cùng cơ chế CAS) |
| Rủi ro quên khóa | Compiler **không** báo — bug chỉ lộ ra lúc runtime (race condition, đôi khi chỉ xảy ra trên production dưới tải cao) | **Không thể quên** — muốn chạm vào data bên trong `Mutex<T>` bắt buộc phải `.lock()`, đây là ràng buộc ở type-system, không phải convention |

**Khác biệt cốt lõi về thiết kế:** trong Java, lock và data là hai thứ tách rời — bạn phải tự kỷ luật để luôn nhớ "trước khi đụng field này, phải synchronized". Rust gắn lock **vào chính type** (`Mutex<T>` sở hữu `T` bên trong nó) — bạn **không có cách nào lấy `T` ra mà không đi qua `.lock()`**, vì vậy lớp bug "quên đồng bộ hóa" không tồn tại được ở Rust.

## 3. Arc: Atomic Reference Counting — cơ chế thật bên trong

```rust
let counter = Arc::new(Mutex::new(0));
let counter2 = Arc::clone(&counter);
```

`Arc::clone` **không** copy dữ liệu bên trong — nó chỉ tăng một bộ đếm nguyên tử (atomic increment, dùng CPU instruction `LOCK XADD` trên x86) lưu cạnh dữ liệu trên heap. Khi Arc cuối cùng bị drop, bộ đếm về 0, buffer heap mới thực sự bị giải phóng. Về bản chất, nó giống `std::shared_ptr` trong C++ (cũng dùng atomic refcount), khác với `Rc<T>` (Reference Counted, refcount **không** atomic — chỉ dùng được trong 1 thread, nhanh hơn vì không cần CPU lock instruction).

## 4. Ví dụ thực tế: cache trạng thái validate hồ sơ (PDMS context)

Giả sử một pool worker thread cùng validate batch hồ sơ, cần cập nhật một cache trạng thái dùng chung:

```rust
use std::sync::{Arc, RwLock};
use std::collections::HashMap;
use std::thread;

fn main() {
    // RwLock phù hợp hơn Mutex ở đây: nhiều worker chỉ ĐỌC trạng thái để quyết định
    // có validate lại hay không, chỉ 1 worker GHI khi có kết quả mới
    let status_cache: Arc<RwLock<HashMap<u64, bool>>> = Arc::new(RwLock::new(HashMap::new()));

    let mut handles = vec![];
    for doc_id in 0..10u64 {
        let cache = Arc::clone(&status_cache);
        handles.push(thread::spawn(move || {
            // Nhiều thread có thể đọc song song — không chặn nhau
            let already_validated = cache.read().unwrap().contains_key(&doc_id);
            if !already_validated {
                let result = validate_document(doc_id);
                // Chỉ khi cần ghi mới xin quyền độc quyền
                cache.write().unwrap().insert(doc_id, result);
            }
        }));
    }
    for h in handles { h.join().unwrap(); }
}

fn validate_document(_id: u64) -> bool { true }
```

So với dùng `Mutex<HashMap<...>>` cho toàn bộ cache: nếu workload chủ yếu là đọc (kiểm tra "đã validate chưa" trước khi làm việc nặng), `RwLock` cho phép N reader chạy song song thật sự, trong khi `Mutex` sẽ serialize hoá tất cả truy cập kể cả đọc — với PDMS xử lý batch lớn, đây là khác biệt throughput đáng kể.

## 5. Pitfalls thường gặp

- **Mutex poisoning**: nếu một thread panic trong lúc đang giữ lock, Rust **đánh dấu Mutex là "poisoned"** — lần `.lock()` tiếp theo sẽ trả về `Err`. Đây là khác biệt lớn so với Java: `synchronized` chỉ đơn giản nhả lock khi exception ném ra, không có cảnh báo gì — dữ liệu có thể đã ở trạng thái dở dang mà không ai biết. Rust buộc bạn phải xử lý tường minh (`.lock().unwrap()` sẽ panic tiếp — đúng ý đồ: đừng âm thầm dùng dữ liệu có thể đã hỏng).
- **Deadlock do lock ordering ngược nhau**: Thread A lock `mutex_1` rồi cố lock `mutex_2`; Thread B lock `mutex_2` rồi cố lock `mutex_1` — cả hai chờ nhau vô thời hạn. Rust **không** phát hiện lỗi này tại compile-time (đây vẫn là runtime logic error, giống hệt Java) — quy tắc để tránh: luôn lock theo **một thứ tự cố định** trên toàn codebase.
- **Giữ lock guard lâu hơn cần thiết**: gọi hàm tốn thời gian (I/O, tính toán nặng) trong khi vẫn giữ `.lock()` sẽ chặn toàn bộ thread khác — nên giải phóng guard (dùng block `{ }` để guard tự drop) ngay khi xong phần cần bảo vệ.
- **Nhầm giữa `Arc::clone(&x)` và clone dữ liệu bên trong**: `Arc::clone` chỉ tăng refcount (rẻ), còn `(*x).clone()` sẽ deep-clone dữ liệu thật (đắt) — dễ gõ nhầm khi mới quen.

## 6. Hiệu năng: Mutex vs RwLock vs Atomic

Về chi phí runtime khi có tranh chấp (contention): `Mutex`/`RwLock` khi bị tranh chấp sẽ rơi vào syscall của OS (futex trên Linux) để parking thread — có context switch. `AtomicUsize` dùng CPU instruction trực tiếp (CAS loop), **không syscall**, rẻ hơn nhiều lần cho các thao tác đơn giản như đếm — nếu chỉ cần một bộ đếm dùng chung, ưu tiên `AtomicUsize` thay vì `Arc<Mutex<usize>>`. Tự benchmark bằng `criterion` với `bench_mutex_counter` vs `bench_atomic_counter` dưới N thread để thấy chênh lệch cụ thể trên máy của bạn.

## 7. Bài tập

1. (Gốc, mở rộng) Giải thích chính xác cơ chế vector reallocation khiến Rust phải cấm `&` và `&mut` cùng tồn tại — vẽ lại diagram địa chỉ bộ nhớ trước/sau `push()`.
2. Viết đoạn code cố tình tạo deadlock bằng 2 `Mutex` lock ngược thứ tự ở 2 thread — chạy thử và quan sát chương trình treo.
3. Cố tình panic trong một thread đang giữ `Mutex`, quan sát lỗi "PoisonError" ở lần lock kế tiếp — giải thích tại sao đây là thiết kế an toàn hơn Java.
4. So sánh thời gian chạy của cùng một bộ đếm dùng `Arc<Mutex<usize>>` và `Arc<AtomicUsize>` với 8 thread, mỗi thread tăng 1 triệu lần.

---
**Bước tiếp theo:** Cài đặt môi trường và khởi tạo dự án Web đầu tiên với **Axum**.
