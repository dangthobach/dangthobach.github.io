# Performance Mastery: Tối ưu hiệu năng ở quy mô lớn

Trong React, hiệu năng không chỉ là chạy nhanh, mà là **tránh những công việc thừa thãi**.

## 1. Cơ chế Re-render và Memoization

Mặc định, khi một component cha render, tất cả component con của nó cũng render theo. Điều này đôi khi không cần thiết.

### `React.memo`
Dùng để ngăn component con render lại nếu props của nó không thay đổi (Shallow Comparison).

### `useMemo` & `useCallback`
- `useMemo`: Ghi nhớ **giá trị** của một tính toán đắt đỏ.
- `useCallback`: Ghi nhớ **tham chiếu** của một hàm (thường dùng khi truyền hàm xuống component con đã được `memo`).

```javascript
const memoizedValue = useMemo(() => computeExpensiveValue(a, b), [a, b]);
const memoizedCallback = useCallback(() => { doSomething(a); }, [a]);
```

## 2. Transition API (React 18+)

Đây là một cuộc cách mạng trong việc xử lý UI mượt mà. React chia các cập nhật state thành 2 loại:
1. **Urgent updates**: Cần phản hồi ngay lập tức (typing, clicking).
2. **Transition updates**: Có thể chờ đợi một chút (search results, chuyển tab).

```javascript
const [isPending, startTransition] = useTransition();

const handleChange = (e) => {
  // Urgent: Cập nhật input ngay lập tức
  setInputValue(e.target.value);

  // Non-urgent: Cập nhật danh sách kết quả sau
  startTransition(() => {
    setSearchQuery(e.target.value);
  });
};
```

Khi dùng `useTransition`, React sẽ không chặn UI chính. Nếu bạn gõ phím liên tục, React sẽ hủy bỏ các lần tính toán cũ của `setSearchQuery` để ưu tiên cho lần gõ mới nhất.

## 3. `useDeferredValue`

Tương tự như `useTransition`, nhưng dùng khi bạn nhận được giá trị từ props và muốn "trì hoãn" việc cập nhật các phần UI phụ thuộc vào giá trị đó.

```javascript
const deferredValue = useDeferredValue(value);
```

## 4. Xác định Bottleneck bằng Profiler

Đừng tối ưu hóa mù quáng (Premature Optimization). Hãy dùng Chrome DevTools:
- **Profiler Tab**: Xem component nào render lâu nhất và tại sao.
- **Why did you render?**: Library giúp cảnh báo các lần render thừa.

## 5. Tối ưu hóa List với Virtualization

Với danh sách hàng ngàn item, đừng render hết. Hãy dùng các thư viện như `react-window` hoặc `tanstack-virtual` để chỉ render những item đang hiển thị trên màn hình.

---
**Gợi ý thực hành:** Hãy tạo một danh sách 10,000 phần tử có chức năng filter. So sánh trải nghiệm người dùng khi dùng và không dùng `useTransition`.
