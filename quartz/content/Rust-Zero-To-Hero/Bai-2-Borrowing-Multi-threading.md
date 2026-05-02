# Bài 2: Borrowing & Multi-threading - Bí kíp "Diệt tận gốc" Data Race

Chào Chuyên gia Java, ở Bài 1 chúng ta đã biết về Ownership (quyền sở hữu). Nhưng nếu cứ mỗi lần dùng dữ liệu lại phải "chuyển giao hộ khẩu" (Move) thì code sẽ rất tù túng. Đó là lý do Rust có hệ thống **Borrowing (Vay mượn)**.

## 1. Borrowing: Quy tắc "Thư viện"

Hãy tưởng tượng dữ liệu là một cuốn sách trong thư viện:

### Quy tắc 1: Immutable Borrowing (`&T`)
Nhiều người có thể cùng mượn sách về **đọc** (Read-only) cùng một lúc. Không ai được phép dùng bút xóa hay viết đè lên sách.
*   **Java tương đương**: Nhiều Thread cùng đọc một `final` variable.

### Quy tắc 2: Mutable Borrowing (`&mut T`)
Chỉ **duy nhất một người** được mượn sách để **sửa** (Write). Khi người này đang giữ sách để sửa, không ai khác được phép đọc hay mượn thêm để sửa.
*   **Java tương đương**: Phải dùng `ReadWriteLock` hoặc `synchronized` để đảm bảo độc quyền.

### Hình minh họa: Quy tắc Vàng của Rust
```text
[ Dữ liệu X ]
      |
      |-- Cho mượn đọc (&) ----> Thread A (OK)
      |-- Cho mượn đọc (&) ----> Thread B (OK)
      |-- Cho mượn sửa (&mut) -> LỖI COMPILE! (Vì đã có người đang đọc)
      
---------------------------------------------------------

[ Dữ liệu Y ]
      |
      |-- Cho mượn sửa (&mut) -> Thread C (OK)
      |-- Cho mượn đọc (&) ----> LỖI COMPILE! (Vì có người đang sửa)
```

**Tại sao lại khắt khe vậy?** Vì Rust muốn loại bỏ **Data Race** ngay từ khi biên dịch. Trong Java, nếu Thread A đang đọc một `ArrayList` trong khi Thread B đang `add()` thêm phần tử, bạn sẽ dính `ConcurrentModificationException` (nếu may mắn) hoặc dữ liệu bị rác (nếu không may). Rust ngăn chặn điều này ngay từ bước `cargo build`.

## 2. Multi-threading: Fearless Concurrency (Đa luồng không sợ hãi)

Trong Java, bạn thường dùng `Lock`, `Semaphore` hoặc `Atomic` và luôn phải "cầu nguyện" mình không quên `unlock` hoặc không bị Deadlock. Rust biến những nỗi sợ này thành lỗi Compile.

### Ví dụ: Chia sẻ dữ liệu giữa các Thread

Để chia sẻ dữ liệu an toàn giữa các Thread, Rust dùng cặp bài trùng: `Arc` và `Mutex`.

*   **Arc (Atomic Reference Counted)**: Giống như một cái "Smart Pointer" đếm số lượng người đang giữ quyền sở hữu. Khi số lượng về 0, dữ liệu tự xóa. (Gần giống quản lý bộ nhớ của Python/Swift nhưng an toàn cho đa luồng).
*   **Mutex (Mutual Exclusion)**: Trong Java, Mutex nằm cạnh dữ liệu. Trong Rust, Mutex **bao bọc (wrap)** lấy dữ liệu. Bạn không thể chạm vào dữ liệu nếu không `lock()` cái Mutex đó.

### Ví dụ Code (So sánh tư duy)

**Java (Tiềm ẩn rủi ro):**
```java
public class Counter {
    public int count = 0; // Ai cũng có thể chạm vào nếu quên synchronized
}
```

**Rust (Bắt buộc an toàn):**
```rust
use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    // Arc giúp dữ liệu sống sót qua nhiều Thread
    // Mutex bảo vệ dữ liệu bên trong
    let counter = Arc::new(Mutex::new(0));
    let mut handles = vec![];

    for _ in 0..10 {
        let counter = Arc::clone(&counter);
        let handle = thread::spawn(move || {
            let mut num = counter.lock().unwrap(); // Bắt buộc phải lock mới lấy được dữ liệu
            *num += 1;
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }

    println!("Kết quả: {}", *counter.lock().unwrap());
}
```

## 3. Tại sao Java Dev sẽ thích điều này?

1.  **Không còn Race Conditions**: Nếu code của bạn build được, 99.9% là nó không bị tranh chấp dữ liệu (Data Race).
2.  **Hiệu năng tối đa**: Không có Garbage Collector chạy ngầm quét các Object đa luồng.
3.  **An toàn tuyệt đối**: Borrow Checker sẽ nhắc bạn nếu bạn định gửi một Reference không an toàn sang Thread khác.

## 4. Tổng kết lý thuyết để chuẩn bị làm Web Backend

Trước khi sang phần thiết lập dự án Web, bạn cần nhớ:
*   **Ownership**: Ai làm chủ? (Dùng để giải phóng bộ nhớ).
*   **Borrowing**: Ai đang mượn? (Dùng để truy cập dữ liệu).
*   **Lifetimes**: Mượn trong bao lâu? (Đảm bảo không mượn đồ đã bị chủ xóa).

---
**Bước tiếp theo:** Chúng ta sẽ cài đặt môi trường và khởi tạo dự án Web đầu tiên với **Axum** - Framework hiện đại nhất của Rust, có tư duy rất giống Spring Boot nhưng nhẹ và nhanh hơn gấp nhiều lần.

*Bài tập nhỏ:* Hãy thử giải thích tại sao Rust lại không cho phép vừa có người đọc vừa có người sửa dữ liệu cùng lúc? (Gợi ý: Hãy nghĩ về việc bộ nhớ bị thay đổi địa chỉ khi một Vector tăng kích thước).
