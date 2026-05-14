# Multiple Router Outlets trong React — Parallel Rendering Pattern

tags: #react #react-router #routing #parallel-routes #named-outlet

---

> Bài này cover phần React của chủ đề Multiple Router Outlets.
> Bài đầy đủ so sánh cả 3 framework: [[Angular-Latest-Series/23-Multiple-Router-Outlets-Named-Auxiliary]]

---

## Tóm tắt nhanh

React Router v6 **không có** Named Outlet native như Angular. Thay vào đó dùng:

- **Pattern A**: State-driven (Zustand) — outlet điều khiển qua store, không lên URL
- **Pattern B**: Search Params — outlet state lên URL, shareable
- **Pattern C**: Next.js Parallel Routes (`@folder`) — native support trong App Router

Chi tiết code từng pattern: [[Angular-Latest-Series/23-Multiple-Router-Outlets-Named-Auxiliary#3. React Router — Parallel Routes Pattern]]

---

## Khi nào dùng pattern nào

| Nhu cầu | Pattern |
|---|---|
| Modal, notification — không cần share URL | A — State-driven |
| Sidebar detail có thể bookmark/share | B — Search Params |
| Dùng Next.js App Router | C — Parallel Routes |

---

## Related

- [[Angular-Latest-Series/23-Multiple-Router-Outlets-Named-Auxiliary]]
- [[SolidJS-Series/SolidJS-14-Multiple-Outlets-Pattern]]
- [[07-React-Router-v6]]
- [[17-Zustand-State-Management]]
