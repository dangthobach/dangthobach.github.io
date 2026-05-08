# Lộ trình Học tập React Hiện đại (v18/19+)

Chào mừng bạn đến với chuỗi bài học chuyên sâu về React. Khóa học này không chỉ dừng lại ở cách sử dụng API, mà còn đi sâu vào các cơ chế cốt lõi bên dưới (internals) để giúp bạn trở thành một chuyên gia thực thụ.

## Mục tiêu khóa học
- Hiểu rõ cơ chế Fiber Architecture và Reconciliation.
- Làm chủ Hooks và các vấn đề về Closure, Memory Leak.
- Tối ưu hóa hiệu năng ứng dụng quy mô lớn.
- Làm quen với Concurrent React và Server Components (RSC).
- Áp dụng các Pattern kiến trúc Enterprise.

## Danh sách bài học

### 01. [React Fiber & Reconciliation](./01-React-Fiber-and-Reconciliation.md)
- Virtual DOM vs Fiber.
- Quá trình Render Phase và Commit Phase.
- Luồng xử lý của Fiber Engine.

### 02. [Hooks Internal Logic](./02-Hooks-Internal-Logic.md)
- Hooks được lưu trữ như thế nào (Linked List).
- Vấn đề Closure trong Hooks.
- Chuyên sâu `useState` và `useReducer`.

### 03. [Effect & Synchronization](./03-Effect-and-Synchronization.md)
- Vòng đời của Effect.
- `useEffect` vs `useLayoutEffect`.
- Tránh Race Conditions khi fetch data.

### 04. [Performance Mastery](./04-Performance-Mastery.md)
- Memoization: `memo`, `useMemo`, `useCallback`.
- Transition API: `useTransition`, `useDeferredValue`.
- Profiling và xác định Bottleneck.

### 05. [Context & State Management](./05-Context-and-State-Management.md)
- Scaling State với Context + `useReducer`.
- Khi nào dùng Store ngoài: Zustand, TanStack Query.

### 06. [Concurrent React & Suspense](./06-Concurrent-React-and-Suspense.md)
- Suspense cho Data Fetching.
- Cơ chế "Interruptible Rendering".
- Tương lai của Async UI.

### 07. [Server Components & Next.js](./07-Server-Components-and-NextJS.md)
- React Server Components (RSC) là gì?
- Hybrid Model: Client vs Server Components.
- Kiến trúc Next.js App Router.

### 08. [Enterprise Architecture](./08-Enterprise-Architecture.md)
- Compound Components Pattern.
- HOCs vs Render Props vs Hooks.
- Cấu trúc thư mục cho dự án khổng lồ.

---
**Ghi chú:** Đây là tài liệu chuyên sâu, yêu cầu kiến thức vững về JavaScript ES6+ và kinh nghiệm làm việc cơ bản với React.
