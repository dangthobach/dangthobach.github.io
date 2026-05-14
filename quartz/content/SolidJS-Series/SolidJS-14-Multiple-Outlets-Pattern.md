# Multiple Outlets trong SolidJS — Store-driven Pattern

tags: #solidjs #solid-router #routing #multiple-outlets #parallel

---

> Bài này cover phần SolidJS của chủ đề Multiple Router Outlets.
> Bài đầy đủ so sánh cả 3 framework: [[Angular-Latest-Series/23-Multiple-Router-Outlets-Named-Auxiliary]]

---

## Tóm tắt nhanh

Solid Router **không có** Named Outlet native. Dùng:

- **Pattern A**: `createStore` global — sidebar/modal state trong store, không lên URL
- **Pattern B**: `useSearchParams` — outlet state lên URL, shareable + reactive tự nhiên

Solid's `createStore` là lựa chọn idiomatic nhất vì:
- Module-level store = singleton tự nhiên, không cần Provider
- Fine-grained reactivity: `Show`/`Switch`/`Match` chỉ update phần DOM thay đổi
- Không re-run component function — chỉ reactive signal được track

Chi tiết code từng pattern: [[Angular-Latest-Series/23-Multiple-Router-Outlets-Named-Auxiliary#4. SolidJS — Multiple Outlet Pattern]]

---

## Khi nào dùng pattern nào

| Nhu cầu | Pattern |
|---|---|
| Modal, notification — không cần share URL | A — createStore |
| Sidebar detail có thể bookmark/share | B — useSearchParams |

---

## Related

- [[Angular-Latest-Series/23-Multiple-Router-Outlets-Named-Auxiliary]]
- [[React-Latest-Series/24-Multiple-Router-Outlets-Pattern]]
- [[SolidJS-09-Routing]]
- [[SolidJS-06-Stores-Nested-State]]
