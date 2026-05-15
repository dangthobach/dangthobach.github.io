# SolidJS Reactivity vs React Virtual DOM — Performance Deep Dive

tags: #solidjs #react #reactivity #performance #virtual-dom

---

> Bài so sánh chi tiết: [[concepts/SolidJS-vs-React-Reactivity-Model]]

---

## Tóm tắt nhanh

SolidJS **không re-run component function** khi state thay đổi. Thay vào đó, reactive graph được build lúc mount — signal thay đổi → chỉ đúng DOM node liên quan được update trực tiếp, không qua vDOM, không diff.

React re-run toàn bộ component function → build new vDOM → diff → commit. Chi phí cố định mỗi update, bù lại bằng tối ưu thủ công (`memo`, `useMemo`) hoặc tự động (React Compiler).

## Điểm mạnh của Solid

- Runtime performance gần Vanilla JS nhất trong mọi framework
- Bundle ~7KB vs React ~45KB
- Không có stale closure bug (không có dependency array)
- Memory thấp hơn — không giữ vDOM tree

## Điểm Solid không thắng toàn diện

- Ecosystem nhỏ hơn React đáng kể
- Mental model signals khó hơn hooks với người mới
- SolidStart chưa battle-tested như Next.js
- React Compiler đang thu hẹp gap performance

## Related

- [[concepts/SolidJS-vs-React-Reactivity-Model]]
- [[SolidJS-Series/SolidJS-01-Reactivity-Internals]]
- [[SolidJS-Series/SolidJS-02-Signals-Deep-Dive]]
