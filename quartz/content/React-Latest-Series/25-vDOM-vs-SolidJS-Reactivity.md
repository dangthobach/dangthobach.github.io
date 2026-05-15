# React Virtual DOM vs SolidJS Fine-grained Reactivity

tags: #react #solidjs #virtual-dom #performance #reconciler #fiber

---

> Bài so sánh chi tiết: [[concepts/SolidJS-vs-React-Reactivity-Model]]

---

## Tóm tắt nhanh

React dùng Virtual DOM — mỗi `setState` trigger re-run component function, build new vDOM tree, diff (reconcile), rồi commit changes lên real DOM. Chi phí này là cố định và tỉ lệ với size của component subtree.

SolidJS không có vDOM — component chỉ chạy một lần, signal thay đổi chỉ update đúng DOM node đang subscribe signal đó.

## React tối ưu vDOM như nào

- `React.memo` — skip re-render nếu props không đổi
- `useMemo` / `useCallback` — cache computed values và functions
- `React.lazy` + `Suspense` — code splitting
- **React Compiler (2024)** — auto-memo ở compile time, thu hẹp gap với Solid

## Khi nào React vẫn là lựa chọn tốt hơn

- Cần Next.js (SSR/SSG best-in-class)
- Cần React Native (mobile)
- Team lớn, cần onboard nhanh
- Cần MUI / Ant Design / shadcn ecosystem
- App không có perf bottleneck rõ ràng

## Related

- [[concepts/SolidJS-vs-React-Reactivity-Model]]
- [[React-Latest-Series/11-Performance-Optimization]]
- [[React-Latest-Series/12-Concurrent-Features]]
