# React Routing — Layout Cố Định & Search State Preservation

tags: #react #react-router #routing #layout #search-state #frontend

---

## 1. Bài toán thực tế

Layout shell cố định với `<Outlet />` của React Router v6+:

```
┌──────────────────────────────────────┐
│              Navbar/Header           │
├─────────┬────────────────────────────┤
│         │                            │
│ Sidebar │        <Outlet />          │
│ (fixed) │   (content thay đổi)       │
│         │                            │
├─────────┴────────────────────────────┤
│               Footer                 │
└──────────────────────────────────────┘
```

---

## 2. Cấu trúc Route — Nested Layout

### `router.tsx` (React Router v6)

```tsx
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import { ShellLayout } from './layouts/ShellLayout';

const router = createBrowserRouter([
  {
    path: '/',
    element: <ShellLayout />,      // Layout wrapper
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      {
        path: 'contracts',
        children: [
          { index: true, element: <ContractListPage /> },
          { path: ':id', element: <ContractDetailPage /> },
        ],
      },
    ],
  },
  { path: '/login', element: <LoginPage /> },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
```

### `ShellLayout.tsx`

```tsx
import { Outlet } from 'react-router-dom';

export function ShellLayout() {
  return (
    <>
      <Navbar />
      <div className="app-body">
        <Sidebar />
        <main className="content">
          <Outlet />   {/* Chỉ phần này thay đổi */}
        </main>
      </div>
      <Footer />
    </>
  );
}
```

> `ShellLayout` mount **một lần duy nhất**. Navigate giữa children không gây re-mount layout.

---

## 3. Search State Preservation

### Problem

`/contracts?page=2&status=ACTIVE&keyword=VPBank` → click detail → `/contracts/123` → Back → state mất vì `ContractListPage` unmount.

---

### Pattern A: URL Search Params làm Source of Truth (Recommended)

```tsx
// ContractListPage.tsx
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';

export function ContractListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Derive state từ URL — không cần useState riêng cho filter
  const keyword = searchParams.get('keyword') ?? '';
  const status = searchParams.get('status') ?? '';
  const page = Number(searchParams.get('page')) || 1;

  const [results, setResults] = useState<Contract[]>([]);

  useEffect(() => {
    // Gọi API mỗi khi URL params thay đổi
    fetchContracts({ keyword, status, page }).then(setResults);
  }, [keyword, status, page]);

  const handleSearch = (values: SearchValues) => {
    setSearchParams({
      keyword: values.keyword,
      status: values.status,
      page: '1',
    });
    // URL thay đổi → useEffect chạy lại → fetch mới
  };

  const handlePageChange = (newPage: number) => {
    setSearchParams(prev => {
      prev.set('page', String(newPage));
      return prev;
    });
  };

  return (
    <div>
      <SearchForm
        defaultValues={{ keyword, status }}
        onSearch={handleSearch}
      />
      <ContractTable
        data={results}
        onRowClick={(id) => navigate(`/contracts/${id}`)}
      />
      <Pagination current={page} onChange={handlePageChange} />
    </div>
  );
}
```

```tsx
// ContractDetailPage.tsx
import { useNavigate } from 'react-router-dom';

export function ContractDetailPage() {
  const navigate = useNavigate();

  return (
    <div>
      {/* navigate(-1) = browser Back — giữ nguyên URL history */}
      <button onClick={() => navigate(-1)}>← Quay lại</button>
    </div>
  );
}
```

**Kết quả**: URL `/contracts?keyword=VPBank&status=ACTIVE&page=2` tồn tại trong browser history. Navigate sang detail → Back → URL cũ được restore → component re-mount → đọc params từ URL → render đúng state.

---

### Pattern B: Zustand Store (State không expose lên URL)

```typescript
// stores/contractSearchStore.ts
import { create } from 'zustand';

interface ContractSearchState {
  keyword: string;
  status: string;
  page: number;
  results: Contract[];
  totalCount: number;
  setFilter: (filter: Partial<ContractSearchState>) => void;
  reset: () => void;
}

export const useContractSearchStore = create<ContractSearchState>((set) => ({
  keyword: '',
  status: '',
  page: 1,
  results: [],
  totalCount: 0,
  setFilter: (filter) => set((s) => ({ ...s, ...filter })),
  reset: () => set({ keyword: '', status: '', page: 1, results: [], totalCount: 0 }),
}));
```

```tsx
// ContractListPage.tsx
export function ContractListPage() {
  const { keyword, status, page, results, setFilter } = useContractSearchStore();

  useEffect(() => {
    fetchContracts({ keyword, status, page }).then(data =>
      setFilter({ results: data.items, totalCount: data.total })
    );
  }, [keyword, status, page]);

  // Component unmount (navigate sang detail) → store giữ nguyên
  // Component mount lại (navigate back) → store state vẫn ở đó

  return (...);
}
```

> Thêm `persist` middleware nếu muốn giữ qua refresh:
> ```ts
> import { persist } from 'zustand/middleware';
> create(persist(..., { name: 'contract-search' }))
> ```

---

### Pattern C: TanStack Query — Cache-based Restoration

```tsx
// ContractListPage.tsx
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

export function ContractListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const keyword = searchParams.get('keyword') ?? '';
  const page = Number(searchParams.get('page')) || 1;

  const { data, isFetching } = useQuery({
    queryKey: ['contracts', { keyword, page }],
    queryFn: () => fetchContracts({ keyword, page }),
    staleTime: 30_000,          // 30s — navigate back trong 30s không refetch
    placeholderData: keepPreviousData,  // Giữ data cũ khi đang fetch mới
  });

  return (
    <div>
      {isFetching && <Spinner />}
      <ContractTable data={data?.items ?? []} />
    </div>
  );
}
```

**Ưu điểm**: Navigate về list trong `staleTime` → hiển thị ngay lập tức từ cache, background refetch. Kết hợp hoàn hảo với Pattern A (URL params).

---

## 4. Preserve Scroll Position

```tsx
// ScrollRestoration — đặt trong ShellLayout
import { ScrollRestoration } from 'react-router-dom';

export function ShellLayout() {
  return (
    <>
      <ScrollRestoration />   {/* Built-in của React Router Data Router */}
      <Navbar />
      <div className="app-body">
        <Sidebar />
        <main className="content">
          <Outlet />
        </main>
      </div>
      <Footer />
    </>
  );
}
```

Hoặc custom nếu không dùng Data Router:

```tsx
// hooks/useScrollRestoration.ts
export function useScrollRestoration() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
}
```

---

## 5. Hyperlink Detail → List — Xử lý edge case

```tsx
// ContractDetailPage.tsx
import { useNavigate, useLocation } from 'react-router-dom';

export function ContractDetailPage() {
  const navigate = useNavigate();
  const location = useLocation();

  const handleBack = () => {
    if (location.key !== 'default') {
      // Có history stack → back bình thường
      navigate(-1);
    } else {
      // Vào thẳng từ URL / bookmark → không có history
      navigate('/contracts');
    }
  };

  return (
    <button onClick={handleBack}>← Quay lại</button>
  );
}
```

```tsx
// Truyền metadata qua navigation state (không lên URL)
navigate(`/contracts/${id}`, {
  state: { fromSearch: { keyword, page } }
});

// Ở detail đọc lại để build back URL cụ thể
const location = useLocation();
const fromSearch = location.state?.fromSearch;
// → navigate(`/contracts?keyword=${fromSearch.keyword}&page=${fromSearch.page}`)
```

---

## 6. So sánh Pattern

| Pattern | URL shareable | Persist qua refresh | Complexity | Best for |
|---|---|---|---|---|
| A — useSearchParams | ✅ | ✅ (URL) | Thấp | Search/filter page |
| B — Zustand | ❌ | ✅ (với persist) | Trung bình | Complex form state |
| C — TanStack Query | ✅ (kết hợp A) | ❌ (in-memory cache) | Trung bình | Data-heavy, stale-while-revalidate |

---

## Related

- [[Angular-Latest-Series/22-Routing-Layout-SearchState]]
- [[SolidJS-Series/SolidJS-13-Routing-Layout-SearchState]]
- [[07-React-Router-v6]]
- [[17-Zustand-State-Management]]
- [[18-TanStack-Query-Server-State]]
