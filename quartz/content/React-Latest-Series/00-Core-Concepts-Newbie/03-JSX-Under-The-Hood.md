# JSX: Khi HTML và JavaScript "về chung một nhà" 🏠 JS

Khi mới nhìn vào code React, chắc hẳn bạn sẽ thắc mắc: "Tại sao lại có thẻ HTML nằm chình ình trong file JavaScript thế này?". Đó chính là **JSX**!

## 1. JSX là gì?

JSX là viết tắt của **JavaScript XML**. Nó cho phép bạn viết các cấu trúc giao diện trông giống như HTML ngay bên trong code JavaScript.

Thay vì phải dùng những hàm phức tạp để tạo ra một nút bấm, bạn chỉ cần viết:
```jsx
const element = <button className="btn">Click me!</button>;
```

## 2. Tại sao chúng ta cần JSX?

Hãy tưởng tượng bạn đang tả một người bạn cho họa sĩ vẽ.
*   **Không có JSX:** "Vẽ một hình tròn cho mặt, sau đó vẽ hai chấm đen cho mắt, rồi vẽ một đường cong cho miệng..." (Rất dài dòng).
*   **Có JSX:** "Đây là tấm ảnh của bạn tôi, hãy vẽ giống như thế này!" (Trực quan và nhanh chóng).

JSX giúp code của chúng ta dễ đọc, dễ viết và dễ hình dung ra giao diện cuối cùng hơn.

## 3. Dưới "nắp ca-pô" (Under the hood)

Trình duyệt thực tế không hiểu được JSX. Vì vậy, một công cụ (thường là Babel) sẽ chuyển đổi JSX thành các hàm JavaScript thuần túy.

Cụ thể, mỗi thẻ JSX sẽ được chuyển thành hàm `React.createElement()`.

```mermaid
graph LR
    JSX[JSX: h1 Hello h1] -- Biên dịch / Compile -- JS[React.createElement 'h1', null, 'Hello']
    JS -- Thực thi -- UI[Giao diện trên trình duyệt]
```

**Ví dụ thực tế:**

*   **Bạn viết (JSX):**
    ```jsx
    <div id="greeting">
      <h1>Chào bạn!</h1>
    </div>
    ```

*   **Máy tính đọc (JavaScript thuần):**
    ```javascript
    React.createElement(
      "div",
      { id: "greeting" },
      React.createElement("h1", null, "Chào bạn!")
    );
    ```

## 4. Một số quy tắc "vàng" của JSX

1.  **Chỉ có một phần tử cha:** Bạn không thể để hai thẻ nằm cạnh nhau mà không có thẻ bao ngoài. (Giống như một gia đình phải sống chung dưới một mái nhà).
2.  **Dùng dấu ngoặc nhọn `{}` để viết JS:** Nếu muốn dùng biến hay tính toán, hãy đặt chúng vào trong `{}`.
    *   Ví dụ: `<h1>{2 + 2}</h1>` sẽ hiển thị là `4`.

---
**Tóm lại:** JSX không phải là phép thuật, nó chỉ là một cách viết tắt "xịn xò" để chúng ta tạo ra các phần tử React một cách dễ dàng và trực quan nhất.

Hẹn gặp bạn ở bài học tiếp theo nhé! 🚀
