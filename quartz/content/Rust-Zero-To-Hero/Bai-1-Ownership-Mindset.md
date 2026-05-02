# Bài 1: Ownership - Chìa khóa Tối ưu Bộ nhớ

Chào Chuyên gia Java, hãy quên Garbage Collector (GC) trong chốc lát. Trong Java, bạn tạo Object và mặc kệ nó. Trong Rust, mọi vùng nhớ phải có một "Chủ sở hữu" duy nhất.

## 1. Hình minh họa: Java vs Rust

### Java (Garbage Collection)
```text
[ Heap Memory ]
  (Object A)  <-- Ref 1 (Biến x)
  (Object A)  <-- Ref 2 (Biến y)
       |
[ GC chạy định kỳ để quét xem ai còn dùng Object A không, nếu không thì xóa ]
-> Gây ra "Stop the world" (Pause ứng dụng).
```

### Rust (Ownership)
```text
[ Heap Memory ]
  (Data A)  <-- Chủ sở hữu: Biến x
       |
[ Khi x ra khỏi scope { } ]
-> Data A bị xóa NGAY LẬP TỨC.
-> Không cần GC, không có độ trễ.
```

## 2. Quy tắc Vàng của Ownership
1. Mỗi giá trị trong Rust có một biến gọi là **owner**.
2. Chỉ có **một owner** tại một thời điểm.
3. Khi owner ra khỏi **scope**, giá trị sẽ bị hủy (dropped).

## 3. Ví dụ thực tế (Dành cho Java Dev)

### Java (Copy Reference)
```java
String s1 = new String("Hello");
String s2 = s1; 
System.out.println(s1); // OK
// Cả s1 và s2 cùng trỏ vào 1 vùng nhớ.
```

### Rust (Move Semantics)
```rust
let s1 = String::from("hello");
let s2 = s1;

// println!("{}", s1); // LỖI COMPILE! 
// Giá trị đã bị "Move" sang s2. s1 không còn quyền sở hữu.
```

**Tại sao Rust làm vậy?** Để tránh lỗi "Double Free" (giải phóng bộ nhớ 2 lần) khi cả 2 biến cùng ra khỏi scope. Đây là cách Rust đảm bảo an toàn bộ nhớ ở mức compile-time.

## 4. Làm sao để dùng chung dữ liệu? (Borrowing)
Thay vì đưa quyền sở hữu, ta cho "mượn":
*   `&s1`: Cho mượn để đọc (Immutable Borrow).
*   `&mut s1`: Cho mượn để sửa (Mutable Borrow).

**Quy tắc mượn:** Bạn có thể có nhiều người mượn để đọc, HOẶC chỉ một người mượn để sửa. Không được cả hai cùng lúc. Điều này loại bỏ hoàn toàn **Data Race** trong lập trình đa luồng - một nỗi đau kinh điển trong Java.

---
**Bài tập nhỏ:** Hãy thử tạo một hàm nhận vào một `String` và trả về độ dài của nó mà không làm mất quyền sở hữu của biến truyền vào.
