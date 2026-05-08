# 03 - New Control Flow & Deferrable Views

Angular v17 giới thiệu một cú pháp điều khiển (Control Flow) hoàn toàn mới, tích hợp sâu vào compiler để đạt hiệu suất tối ưu và loại bỏ sự phụ thuộc vào `CommonModule` (`*ngIf`, `*ngFor`).

## 1. Built-in Control Flow

Cú pháp mới sử dụng ký tự `@`, giúp code sạch hơn và dễ đọc hơn.

### `@if` / `@else`
```html
@if (user.isLoggedIn) {
  <app-dashboard />
} @else if (user.isPending) {
  <p>Đang xác thực...</p>
} @else {
  <app-login />
}
```

### `@for` (Với sự cải tiến vượt bậc về hiệu năng)
Yêu cầu bắt buộc phải có `track` (thay thế cho `trackBy`), giúp Angular tối ưu việc tái sử dụng các phần tử DOM.

```html
<ul>
  @for (item of items; track item.id; let i = $index) {
    <li>{{ i }}: {{ item.name }}</li>
  } @empty {
    <li>Danh sách trống</li>
  }
</ul>
```

### `@switch`
```html
@switch (userRole) {
  @case ('admin') { <app-admin-panel /> }
  @case ('editor') { <app-editor-panel /> }
  @default { <app-viewer-panel /> }
}
```

## 2. Deferrable Views (`@defer`)

Đây là một trong những tính năng mạnh mẽ nhất của Angular hiện đại. Nó cho phép bạn **Lazy Load** bất kỳ phần nào của component một cách declarative (khai báo).

### Cơ chế hoạt động:
Khi điều kiện thỏa mãn, Angular sẽ tải component và các dependencies của nó ở background.

```html
@defer (on viewport) {
  <app-heavy-chart />
} @placeholder {
  <div>Hình ảnh tạm thời (Placeholder)</div>
} @loading {
  <p>Đang tải biểu đồ...</p>
} @error {
  <p>Lỗi tải biểu đồ!</p>
}
```

### Các Trigger phổ biến của `@defer`:
-   `on idle`: Tải khi trình duyệt rảnh (mặc định).
-   `on viewport`: Tải khi phần tử xuất hiện trong khung nhìn của người dùng.
-   `on interaction`: Tải khi người dùng click hoặc gõ vào placeholder.
-   `on hover`: Tải khi di chuột qua.
-   `when condition`: Tải khi một biến logic (Signal) là true.

## 3. Tại sao nên dùng Control Flow mới?

1.  **Hiệu năng**: Nhanh hơn tới 90% so với `*ngIf` và `*ngFor` trong một số trường hợp benchmark.
2.  **Tiện lợi**: Không cần import `CommonModule` hay `NgIf`, `NgFor` vào standalone component.
3.  **Type Safety**: Kiểm tra kiểu dữ liệu trong template tốt hơn.

## 4. Sơ đồ quyết định sử dụng `@defer`

```mermaid
graph TD
    A[Bắt đầu] --> B{Component có nặng không?}
    B -- Không --> C[Dùng Render bình thường]
    B -- Có --> D{Có cần hiển thị ngay lập tức?}
    D -- Có --> C
    D -- Không --> E{Khi nào cần hiển thị?}
    E -- Khi cuộn đến --> F[@defer on viewport]
    E -- Khi click --> G[@defer on interaction]
    E -- Sau X giây --> H[@defer on timer]
```

## 5. Ví dụ kết hợp Signals và Control Flow

```typescript
@Component({
  standalone: true,
  template: `
    <button (click)="showComments.set(true)">Hiển thị bình luận</button>

    @defer (when showComments()) {
      <app-comment-list />
    } @placeholder {
      <p>Bình luận đang được ẩn.</p>
    }
  `
})
export class PostComponent {
  showComments = signal(false);
}
```

---
**Lời khuyên:** Hãy bắt đầu chuyển đổi sang cú pháp `@` ngay hôm nay. Angular CLI cung cấp lệnh migration tự động: `ng generate @angular/core:control-flow`.
