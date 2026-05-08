# Bài 13: React Server Components & Next.js - Tương lai của React 🚀

Bạn đã quen với việc React chạy hoàn toàn trên trình duyệt của người dùng (Client-side). Nhưng thế giới React đang thay đổi với sự xuất hiện của **React Server Components (RSC)** và **Next.js**.

## 1. React Server Components là gì?

### 💡 Ẩn dụ cho Newbie:
Hãy tưởng tượng bạn đặt một bộ đồ chơi Lego.
- **Client-side Rendering (CSR):** Người ta gửi cho bạn một thùng gạch Lego rời rạc và một tờ hướng dẫn. Bạn (Trình duyệt) phải tự ngồi lắp ráp từ đầu đến cuối mới có đồ chơi.
- **Server Components (RSC):** Người ta lắp ráp sẵn bộ đồ chơi ở xưởng (Server) rồi mới gửi thành phẩm đến cho bạn. Bạn chỉ việc bày ra chơi thôi, không tốn sức lắp ráp nữa.

### So sánh Server vs Client:
```mermaid
graph LR
    subgraph "Server (Xưởng sản xuất)"
    A[Lấy dữ liệu từ DB] --> B[Render Component thành HTML]
    end
    B -- Gửi HTML nhẹ về --> C[Trình duyệt (Người dùng)]
    subgraph "Client (Trình duyệt)"
    C --> D[Hiển thị ngay lập tức]
    D --> E[Tải thêm JS cho các nút bấm]
    end
```

---

## 2. Khi nào dùng cái nào?

Trong một ứng dụng Next.js hiện đại, chúng ta kết hợp cả hai:

1. **Server Components (Mặc định):**
   - Dùng để: Lấy dữ liệu (Fetch data), truy cập trực tiếp Database, chứa các thành phần tĩnh (Header, Footer).
   - Lợi ích: Tốc độ tải trang nhanh, tốt cho SEO, bảo mật thông tin nhạy cảm.

2. **Client Components (Dùng `'use client'`):**
   - Dùng để: Xử lý sự kiện (`onClick`, `onChange`), dùng các Hook (`useState`, `useEffect`), dùng thư viện của trình duyệt.
   - Lợi ích: Tương tác mượt mà với người dùng.

---

## 3. Giới thiệu nhanh về Next.js

Next.js là một Framework xây dựng trên nền React, giúp bạn triển khai RSC một cách dễ dàng nhất.

**Các tính năng "ăn tiền" của Next.js:**
- **File-based Routing:** Tạo một file trong thư mục `app/` là có ngay một đường dẫn trang web.
- **Tối ưu hóa hình ảnh:** Tự động nén ảnh cho nhẹ.
- **Fullstack:** Bạn có thể viết code Backend ngay trong cùng một dự án React.

```jsx
// app/page.tsx (Mặc định là Server Component)
async function Page() {
  const data = await fetch('https://api.example.com/posts'); // Chạy trên Server!
  const posts = await data.json();

  return (
    <div>
      <h1>Bài viết mới nhất</h1>
      {posts.map(post => <p key={post.id}>{post.title}</p>)}
    </div>
  );
}
```

---

## 4. Lợi ích cho người dùng cuối 🌟

Người dùng sẽ thấy trang web hiện ra gần như ngay lập tức vì trình duyệt không phải tải một đống file JavaScript nặng nề về để tự "lắp ráp" giao diện nữa. Điều này cực kỳ quan trọng cho người dùng dùng điện thoại yếu hoặc mạng 3G/4G.

---

**Tóm tắt bài học:**
1.  **Server Components**: Chạy trên Server, gửi kết quả về trình duyệt.
2.  **Client Components**: Chạy trên trình duyệt, xử lý tương tác.
3.  **Next.js**: Framework giúp tận dụng tối đa sức mạnh của Server + Client.
4.  **SEO & Performance**: Là lý do chính để chuyển sang mô hình này.

Hãy thử cài đặt một dự án Next.js trắng bằng lệnh `npx create-next-app@latest` để trải nghiệm nhé! ⚡
