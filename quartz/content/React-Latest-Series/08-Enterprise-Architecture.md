# Enterprise Architecture: Xây dựng dự án quy mô lớn

Khi dự án lớn dần, code dễ trở nên hỗn loạn. Bài học này tập trung vào các pattern giúp code dễ bảo trì và mở rộng.

## 1. Compound Components Pattern

Đây là pattern giúp tạo ra các component linh hoạt, cho phép người dùng quyết định vị trí các phần tử con nhưng vẫn giữ được logic chung.

**Ví dụ:** `Select` component.
```javascript
<Select>
  <Select.Trigger />
  <Select.Content>
    <Select.Option value="1">Option 1</Select.Option>
  </Select.Content>
</Select>
```
Pattern này thường sử dụng `Context` để chia sẻ state ngầm giữa cha và con.

## 2. HOCs vs Render Props vs Hooks

- **HOC (High Order Component):** Dùng để bao bọc logic (Ví dụ: `withAuth(Profile)`). Hiện nay ít dùng hơn do khó debug và dễ bị "prop drilling".
- **Render Props:** Linh hoạt nhưng dễ gây ra "Callback Hell".
- **Hooks:** Là cách tốt nhất hiện nay để tái sử dụng logic (90% trường hợp).

## 3. Cấu trúc thư mục Enterprise (Feature-based)

Tránh cấu trúc theo kiểu `components/`, `pages/`, `hooks/` nếu dự án quá lớn. Hãy chia theo **Features**.

```text
src/
  features/
    auth/
      components/
      hooks/
      services/
      types.ts
    cart/
      ...
  shared/
    components/ (Button, Input)
    hooks/
    utils/
  layouts/
  app/ (Routing configuration)
```

## 4. Separation of Concerns (Tách biệt trách nhiệm)

Một component không nên làm quá nhiều việc. Hãy áp dụng quy tắc:
- **Presentation Component:** Chỉ nhận props và hiển thị UI.
- **Container/Feature Component:** Xử lý logic, fetch data, kết nối với store.

## 5. Testing Strategy

Trong môi trường Enterprise, test là bắt buộc:
- **Unit Tests (Vitest/Jest):** Test các hàm logic nhỏ, utils.
- **Component Tests (React Testing Library):** Test hành vi của component từ góc nhìn người dùng.
- **E2E Tests (Playwright/Cypress):** Test toàn bộ luồng nghiệp vụ trên trình duyệt thật.

---
**Gợi ý thực hành:** Hãy thử refactor một component Modal truyền thống sang kiểu Compound Components để thấy sự linh hoạt của nó.
