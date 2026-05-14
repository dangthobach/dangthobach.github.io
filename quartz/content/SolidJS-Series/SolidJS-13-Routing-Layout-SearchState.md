# SolidJS Routing — Layout Cố Định & Search State Preservation

tags: #solidjs #solid-router #routing #layout #search-state #frontend

---

## 1. Bài toán thực tế

SolidJS khác React ở điểm quan trọng: **component chỉ chạy một lần** (không re-render). Reactivity dựa trên fine-grained signals. Điều này ảnh hưởng trực tiếp đến cách routing và state management hoạt động.

```
┌──────────────────────────────────────┐
│              Navbar/Header           │
├─────────┬────────────────────────────┤
│         │                            │
│ Sidebar │     props.children         │
│ (fixed) │   (content thay đổi)       │
│         │                            │
├─────────┴────────────────────────────┤
│               Footer                 │
└──────────────────────────────────────┘
```

---

## 2. Cấu trúc Route — Nested Layout (Solid Router v0.13+)

### `router.tsx`

```tsx
import { Router, Route } from '@solidjs/router';
import { lazy } from 'solid-js';

const ShellLayout = lazy(() => import('./layouts/ShellLayout'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ContractListPage = lazy(() => import('./pages/contracts/ContractListPage'));
const ContractDetailPage = lazy(() => import('./pages/contracts/ContractDetailPage'));

export function AppRouter() {
  return (
    <Router>
      <Route path="/" component={ShellLayout}>
        <Route path="/" component={() => <Navigate href="/dashboard" />} />
        <Route path="/dashboard" component={DashboardPage} />
        <Route path="/contracts">
          <Route path="/" component={ContractListPage} />
          <Route path="/:id" component={ContractDetailPage} />
        </Route>
      </Route>
      <Route path="/login" component={LoginPage} />
    </Router>
  );
}
```

### `ShellLayout.tsx`

```tsx
import { ParentProps } from 'solid-js';

export function ShellLayout(props: ParentProps) {
  return (
    <>
      <Navbar />
      <div class="app-body">
        <Sidebar />
        <main class="content">
          {props.children}  {/* Đây chính là Outlet */}
        </main>
      </div>
      <Footer />
    </>
  );
}
```

> **Solid Router v0.14+** có `<Outlet />` explicit. Với `props.children` hoặc `<Outlet />` đều không re-create ShellLayout khi navigate.

---

## 3. Solid Router — Cơ chế hoạt động khác React Router

| | React Router | Solid Router |
|---|---|---|
| Re-render | Component function chạy lại | Component function chỉ chạy **1 lần** |
| Reactivity | Virtual DOM diffing | Fine-grained signals |
| Route change | Unmount + Mount component mới | Swap component, Solid cập nhật DOM minimal |
| Layout | Không re-mount khi navigate children | Tương tự — layout function chạy 1 lần |

Khi navigate từ `ContractListPage` sang `ContractDetailPage`, Solid **destroy** component list và **create** component detail (2 route khác nhau). Khác với navigate trong cùng route (params thay đổi) — lúc đó component không bị destroy.

---

## 4. Search State Preservation

### Pattern A: Search Params (URL làm Source of Truth — Recommended)

```tsx
// ContractListPage.tsx
import { useSearchParams, useNavigate } from '@solidjs/router';
import { createEffect, createSignal } from 'solid-js';

export function ContractListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Derive từ URL params — reactive accessor
  const keyword = () => searchParams.keyword ?? '';
  const status = () => searchParams.status ?? '';
  const page = () => Number(searchParams.page) || 1;

  const [results, setResults] = createSignal<Contract[]>([]);

  // createEffect theo dõi keyword/status/page — chạy lại khi params thay đổi
  createEffect(() => {
    fetchContracts({
      keyword: keyword(),
      status: status(),
      page: page(),
    }).then(setResults);
  });

  const handleSearch = (values: SearchValues) => {
    setSearchParams({
      keyword: values.keyword,
      status: values.status,
      page: '1',
    });
  };

  return (
    <div>
      <SearchForm
        keyword={keyword()}
        status={status()}
        onSearch={handleSearch}
      />
      <ContractTable
        data={results()}
        onRowClick={(id) => navigate(`/contracts/${id}`)}
      />
      <Pagination current={page()} onChange={(p) => setSearchParams({ page: String(p) })} />
    </div>
  );
}
```

**Cơ chế**: `useSearchParams` trả về reactive store. `setSearchParams` → URL thay đổi → `keyword()`, `page()` accessor thay đổi → `createEffect` re-run → fetch mới. Navigate back → URL cũ restore → component re-create → đọc params → render đúng.

---

### Pattern B: Global Store với createStore (Solid's reactive store)

```tsx
// stores/contractSearch.store.ts
import { createStore } from 'solid-js/store';

interface ContractSearchState {
  keyword: string;
  status: string;
  page: number;
  results: Contract[];
  totalCount: number;
}

// Module-level store — singleton, sống suốt app lifetime
const [state, setState] = createStore<ContractSearchState>({
  keyword: '',
  status: '',
  page: 1,
  results: [],
  totalCount: 0,
});

export function useContractSearchStore() {
  const setFilter = (filter: Partial<ContractSearchState>) => {
    setState(filter);
  };

  const reset = () => {
    setState({ keyword: '', status: '', page: 1, results: [], totalCount: 0 });
  };

  return { state, setFilter, reset };
}
```

```tsx
// ContractListPage.tsx
export function ContractListPage() {
  const { state, setFilter } = useContractSearchStore();

  // Component chạy 1 lần — createEffect theo dõi state changes
  createEffect(() => {
    // Solid tự track state.keyword, state.page khi đọc bên trong effect
    fetchContracts({
      keyword: state.keyword,
      status: state.status,
      page: state.page,
    }).then(data => setFilter({ results: data.items, totalCount: data.total }));
  });

  return (
    <div>
      <input
        value={state.keyword}
        onInput={(e) => setFilter({ keyword: e.currentTarget.value })}
      />
      <Show when={state.results.length > 0}>
        <For each={state.results}>
          {(contract) => <ContractRow data={contract} />}
        </For>
      </Show>
    </div>
  );
}
```

> **Solid's `createStore`** dùng Proxy để track từng field riêng biệt → chỉ re-run effect nào phụ thuộc vào field đó. Granular hơn `createSignal` cho object phức tạp.

---

### Pattern C: createResource (Data fetching tích hợp Suspense)

```tsx
// ContractListPage.tsx
import { createResource, Suspense } from 'solid-js';
import { useSearchParams } from '@solidjs/router';

export function ContractListPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // createResource tự động refetch khi source signal thay đổi
  const [contracts] = createResource(
    // Source — reactive, thay đổi → refetch
    () => ({
      keyword: searchParams.keyword ?? '',
      page: Number(searchParams.page) || 1,
    }),
    // Fetcher
    (params) => fetchContracts(params)
  );

  return (
    <Suspense fallback={<Spinner />}>
      {/* contracts() trả undefined khi đang loading → Suspense handle */}
      <ContractTable data={contracts()?.items ?? []} />
    </Suspense>
  );
}
```

**Ưu điểm**: Source function là reactive — `searchParams` thay đổi → refetch tự động. Navigate back → component re-create → đọc lại `searchParams` → trigger fetch. Tích hợp sẵn với Solid's Suspense/ErrorBoundary.

---

## 5. Navigate từ Detail về List

```tsx
// ContractDetailPage.tsx
import { useNavigate } from '@solidjs/router';

export function ContractDetailPage() {
  const navigate = useNavigate();

  return (
    <div>
      {/* navigate(-1) tương đương history.back() */}
      <button onClick={() => navigate(-1)}>← Quay lại</button>
    </div>
  );
}
```

```tsx
// <A> component — tương đương <Link> trong React Router
import { A } from '@solidjs/router';

<A href="/contracts">← Quay lại danh sách</A>

// Với query params cụ thể
<A href={`/contracts?keyword=${savedKeyword}&page=${savedPage}`}>
  ← Quay lại kết quả tìm kiếm
</A>
```

**Edge case — vào detail từ URL trực tiếp (không có history)**:

```tsx
export function ContractDetailPage() {
  const navigate = useNavigate();

  const handleBack = () => {
    // Solid Router không expose location.key như React Router
    // Dùng document.referrer hoặc navigation state để detect
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate('/contracts');
    }
  };

  return <button onClick={handleBack}>← Quay lại</button>;
}
```

---

## 6. Điểm khác biệt then chốt so với React/Angular

```
React:     Component re-renders → hooks re-run → "tươi" mỗi render
Angular:   Lifecycle hooks + ChangeDetection cycle
SolidJS:   Component chạy 1 lần, signals/effects drive DOM updates trực tiếp
```

Vì Solid component chỉ chạy một lần, khi navigate về list:
- **URL params**: component re-create (function call mới), đọc params → OK tự nhiên
- **Module-level store**: store không bị destroy dù component destroy → state luôn còn
- Không cần `RouteReuseStrategy` (Angular) hay memoization tricks (React)

---

## 7. So sánh Pattern

| Pattern | URL shareable | Complexity | Solid-idiomatic | Best for |
|---|---|---|---|---|
| A — useSearchParams | ✅ | Thấp | ✅ | Search/filter page |
| B — createStore (global) | ❌ | Trung bình | ✅ | Complex form, multi-step |
| C — createResource | ✅ (kết hợp A) | Thấp | ✅✅ | Data fetching với Suspense |

---

## Related

- [[Angular-Latest-Series/22-Routing-Layout-SearchState]]
- [[React-Latest-Series/23-Routing-Layout-SearchState]]
- [[SolidJS-09-Routing]]
- [[SolidJS-06-Stores-Nested-State]]
- [[SolidJS-08-Async-Resources]]
