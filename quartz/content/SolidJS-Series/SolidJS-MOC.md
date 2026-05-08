# SolidJS Series — Master Index (MOC)

#solidjs #frontend #moc

> Series học SolidJS từ cơ chế nội tại đến enterprise patterns. Thiết kế theo nguyên tắc **mechanism-first**: bản chất → cơ chế → API → thực chiến.

---

## 🗺️ Roadmap

### Phase 1 — Core Mechanics ✅

| # | Bài | Nội dung cốt lõi |
|---|---|---|
| 01 | [[SolidJS-Series/SolidJS-01-Reactivity-Internals\|Reactivity Internals]] | Reactive graph, tracking context, ownership tree |
| 02 | [[SolidJS-Series/SolidJS-02-Signals-Deep-Dive\|Signals Deep Dive]] | createSignal, createMemo, batch, untrack |
| 03 | [[SolidJS-Series/SolidJS-03-Effects-And-Lifecycle\|Effects & Lifecycle]] | createEffect, onMount, onCleanup, cleanup patterns |
| 04 | [[SolidJS-Series/SolidJS-04-JSX-Component-Model\|JSX & Component Model]] | Compile model, run-once, mergeProps, splitProps |
| 05 | [[SolidJS-Series/SolidJS-05-Control-Flow-Primitives\|Control Flow Primitives]] | Show, For, Index, Switch, Dynamic |

### Phase 2 — State & Data ✅

| # | Bài | Nội dung cốt lõi |
|---|---|---|
| 06 | [[SolidJS-Series/SolidJS-06-Stores-Nested-State\|Stores & Nested State]] | createStore, produce, reconcile |
| 07 | [[SolidJS-Series/SolidJS-07-Context-DI\|Context & DI]] | createContext, Provider, service layer |
| 08 | [[SolidJS-Series/SolidJS-08-Async-Resources\|Async & Resources]] | createResource, Suspense, ErrorBoundary |
| 09 | [[SolidJS-Series/SolidJS-09-Routing\|Routing]] | @solidjs/router, nested routes, loaders |

### Phase 3 — Enterprise ✅

| # | Bài | Nội dung cốt lõi |
|---|---|---|
| 10 | [[SolidJS-Series/SolidJS-10-Complex-UI-Patterns\|Complex UI Patterns]] | Forms (Zod), data tables, virtual scroll |
| 11 | [[SolidJS-Series/SolidJS-11-SolidStart-SSR\|SolidStart & SSR]] | Server functions, streaming SSR, islands |
| 12 | [[SolidJS-Series/SolidJS-12-Performance-Testing\|Performance & Testing]] | Profiling, Vitest, Feature-Slice architecture |

---

## 🧭 Learning Paths

### Path A: Full sequence (recommended)
`01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12`

### Path B: Build UI nhanh sau Phase 1
`01 → 02 → 03 → 04 → 05` → **`06`** → **`10`**

### Path C: Backend-for-frontend focus
`01 → 02` → `08` → `09` → `11`

### Path D: Testing focus
`01 → 02 → 03` → `06` → `10` → **`12`**

---

## 🔑 Quick Reference

| Concept | Bài | Khi nào dùng |
|---|---|---|
| `createSignal` | 02 | Primitive reactive value |
| `createMemo` | 02 | Derived value, expensive, dùng nhiều nơi |
| `batch()` | 02 | Gộp nhiều signal updates |
| `untrack()` | 02 | Đọc signal không subscribe |
| `createEffect` | 03 | Side effects (fetch, log, DOM) |
| `onCleanup` | 03 | Cleanup WS, timer, listener |
| `mergeProps` | 04 | Default props |
| `splitProps` | 04 | Forward props xuống native el |
| `<Show>` | 05 | Conditional render |
| `<For>` | 05 | List objects có id |
| `<Index>` | 05 | List primitives / position-stable |
| `createStore` | 06 | Nested reactive object |
| `produce()` | 06 | Immer-style mutation |
| `reconcile()` | 06 | Sync server data, tránh full re-mount |
| `createContext` | 07 | Service layer, tránh prop drilling |
| `createResource` | 08 | Async fetch reactive |
| `<Suspense>` | 08 | Loading boundary declarative |
| `<ErrorBoundary>` | 08 | Error recovery UI |
| `useParams` | 09 | Route params reactive |
| `useSearchParams` | 09 | URL state reactive |
| `useBeforeLeave` | 09 | Unsaved changes guard |
| `createForm` | 10 | Signal-based form + Zod validation |
| `createDataTable` | 10 | Table filter/sort/page thuần signal |
| `createVirtualList` | 10 | Windowing 100k+ rows |
| `"use server"` | 11 | Server-only function |
| `cache()` | 11 | Deduplicate + memoize server calls |
| `action()` | 11 | Mutation server function |
| `revalidate()` | 11 | Invalidate cache sau mutation |
| Streaming SSR | 11 | Suspense → progressive HTML |
| `createRoot` | 12 | Isolate reactive scope trong tests |

---

## 📁 Vault Structure

```
SolidJS-Series/
├── SolidJS-MOC.md
├── SolidJS-01-Reactivity-Internals.md
├── SolidJS-02-Signals-Deep-Dive.md
├── SolidJS-03-Effects-And-Lifecycle.md
├── SolidJS-04-JSX-Component-Model.md
├── SolidJS-05-Control-Flow-Primitives.md
├── SolidJS-06-Stores-Nested-State.md
├── SolidJS-07-Context-DI.md
├── SolidJS-08-Async-Resources.md
├── SolidJS-09-Routing.md
├── SolidJS-10-Complex-UI-Patterns.md
├── SolidJS-11-SolidStart-SSR.md
└── SolidJS-12-Performance-Testing.md
```

---

*Hoàn thành: 2026-05 · 12 modules · 3 phases*
