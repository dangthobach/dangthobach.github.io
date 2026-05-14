# Multiple Router Outlets trong SPA — Named & Auxiliary Routes

tags: #angular #react #solidjs #routing #named-outlet #auxiliary-route

---

## 1. Câu hỏi cốt lõi

Một SPA có thể có **nhiều router-outlet đồng thời** không?

| Framework | Support | Cơ chế |
|---|---|---|
| **Angular** | ✅ Native | Named Outlets + Auxiliary Routes trên URL |
| **React Router** | ✅ Pattern | State-driven hoặc Search Params |
| **Next.js** | ✅ Native | Parallel Routes (`@folder` convention) |
| **SolidJS** | ✅ Pattern | Store-driven hoặc Search Params |

---

## 2. Angular — Named Outlets (Native Support)

### Cơ chế hoạt động

Angular hỗ trợ nhiều `<router-outlet>` trong cùng template bằng cách đặt **tên** (`name` attribute). Mỗi outlet có URL segment riêng gọi là **Auxiliary Route**, biểu diễn trên URL bằng cú pháp `(outletName:path)`.

```
URL: /dashboard(sidebar:contract-detail/123)(modal:confirm-delete/123)
      ─────────  ───────────────────────────  ──────────────────────────
      primary    auxiliary outlet "sidebar"   auxiliary outlet "modal"
```

### Template — Shell Layout với nhiều outlet

```html
<!-- shell-layout.component.html -->
<app-navbar />

<div class="app-body">
  <!-- Primary outlet — content chính -->
  <main class="content">
    <router-outlet />
  </main>

  <!-- Named outlet — side panel -->
  <aside class="side-panel" *ngIf="hasSidePanel()">
    <router-outlet name="sidebar" />
  </aside>
</div>

<!-- Named outlet — modal overlay -->
<router-outlet name="modal" />

<app-footer />
```

### Route Config

```typescript
// app.routes.ts
export const routes: Routes = [
  {
    path: '',
    component: ShellLayoutComponent,
    children: [
      { path: 'dashboard', component: DashboardComponent },
      {
        path: 'contracts',
        children: [
          { path: '', component: ContractListComponent },
          { path: ':id', component: ContractDetailComponent },
        ]
      },

      // ─── Auxiliary routes — outlet "sidebar" ───
      {
        path: 'contract-detail/:id',
        outlet: 'sidebar',         // ← tên khớp với name="sidebar"
        component: ContractSidebarDetailComponent,
      },
      {
        path: 'user-profile/:id',
        outlet: 'sidebar',
        component: UserProfileSidebarComponent,
      },

      // ─── Auxiliary routes — outlet "modal" ───
      {
        path: 'confirm-delete/:id',
        outlet: 'modal',
        component: ConfirmDeleteModalComponent,
      },
    ]
  }
];
```

### Navigate đến Named Outlet

```typescript
// Mở sidebar — URL: /contracts(sidebar:contract-detail/123)
this.router.navigate([
  { outlets: { sidebar: ['contract-detail', contractId] } }
]);

// Mở đồng thời sidebar + modal
this.router.navigate([
  { outlets: {
    sidebar: ['contract-detail', contractId],
    modal: ['confirm-delete', contractId]
  }}
]);

// Đóng outlet — set về null
this.router.navigate([
  { outlets: { sidebar: null } }
]);
```

```html
<!-- Dùng routerLink -->
<a [routerLink]="[{ outlets: { sidebar: ['contract-detail', contract.id] } }]">
  Xem chi tiết
</a>
```

### Component trong Named Outlet

Component hoạt động bình thường — inject `ActivatedRoute` để đọc params:

```typescript
// contract-sidebar-detail.component.ts
@Component({ ... })
export class ContractSidebarDetailComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  ngOnInit() {
    this.route.params.subscribe(params => {
      this.loadContract(params['id']);
    });
  }

  close() {
    this.router.navigate([{ outlets: { sidebar: null } }]);
  }
}
```

### Kiểm tra outlet có đang active không

```typescript
// shell-layout.component.ts
@Component({ ... })
export class ShellLayoutComponent {
  private router = inject(Router);

  hasSidePanel = signal(false);

  constructor() {
    this.router.events.pipe(
      filter(e => e instanceof NavigationEnd)
    ).subscribe(() => {
      const tree = this.router.parseUrl(this.router.url);
      this.hasSidePanel.set(!!tree.root.children['sidebar']);
    });
  }
}
```

### URL với nhiều Auxiliary Outlets

```
/contracts
  → primary: ContractListComponent
  → sidebar: (empty)
  → modal:   (empty)

/contracts(sidebar:contract-detail/123)
  → primary: ContractListComponent        ← list vẫn hiển thị
  → sidebar: ContractSidebarDetailComponent (id=123)

/contracts(sidebar:contract-detail/123)(modal:confirm-delete/123)
  → primary: ContractListComponent
  → sidebar: ContractSidebarDetailComponent
  → modal:   ConfirmDeleteModalComponent

/dashboard(sidebar:user-profile/456)
  → primary: DashboardComponent
  → sidebar: UserProfileSidebarComponent (id=456)
```

> **Key point**: Các outlet hoàn toàn **độc lập**. Primary outlet thay đổi không ảnh hưởng auxiliary outlet và ngược lại — trừ khi route config định nghĩa `canDeactivate` hay `resolve` liên quan.

### ⚠️ Lưu ý quan trọng

**Auxiliary route thoát độc lập với primary**:

```typescript
// Navigate primary sang trang khác — auxiliary vẫn còn!
this.router.navigate(['/dashboard']);
// URL: /dashboard(sidebar:contract-detail/123) ← sidebar vẫn active

// Phải đóng explicit nếu muốn clear
this.router.navigate(['/dashboard', { outlets: { sidebar: null } }]);
```

**Guard và Lazy Loading**: hoạt động bình thường như primary route — `canActivate`, `loadComponent`, `loadChildren` đều apply được trên auxiliary route.

---

## 3. React Router — Parallel Routes Pattern

React Router v6 không có Named Outlet native. Dùng một trong các pattern sau:

### Pattern A: State-driven Outlets (Phổ biến nhất)

Không dùng URL cho secondary outlet — dùng Zustand/Context để điều khiển:

```typescript
// stores/uiStore.ts
import { create } from 'zustand';

interface UiState {
  sidebar: { type: 'contract-detail' | 'user-profile' | null; id: string | null };
  modal: { type: 'confirm-delete' | null; id: string | null };
  openSidebar: (type: NonNullable<UiState['sidebar']['type']>, id: string) => void;
  closeSidebar: () => void;
  openModal: (type: NonNullable<UiState['modal']['type']>, id: string) => void;
  closeModal: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebar: { type: null, id: null },
  modal: { type: null, id: null },
  openSidebar: (type, id) => set({ sidebar: { type, id } }),
  closeSidebar: () => set({ sidebar: { type: null, id: null } }),
  openModal: (type, id) => set({ modal: { type, id } }),
  closeModal: () => set({ modal: { type: null, id: null } }),
}));
```

```tsx
// ShellLayout.tsx
const SidebarComponents = {
  'contract-detail': ContractSidebarDetail,
  'user-profile': UserProfileSidebar,
} as const;

const ModalComponents = {
  'confirm-delete': ConfirmDeleteModal,
} as const;

export function ShellLayout() {
  const { sidebar, modal, closeSidebar, closeModal } = useUiStore();

  const SidebarComp = sidebar.type ? SidebarComponents[sidebar.type] : null;
  const ModalComp = modal.type ? ModalComponents[modal.type] : null;

  return (
    <>
      <Navbar />
      <div className="app-body">
        <main className="content">
          <Outlet />         {/* Primary outlet */}
        </main>

        {SidebarComp && (
          <aside className="side-panel">
            <SidebarComp id={sidebar.id!} onClose={closeSidebar} />
          </aside>
        )}
      </div>

      {ModalComp && (
        <div className="modal-overlay">
          <ModalComp id={modal.id!} onClose={closeModal} />
        </div>
      )}
    </>
  );
}
```

### Pattern B: Search Params (URL-based, shareable)

```tsx
// Sidebar state sống trên URL: /contracts?keyword=VPBank&sidebar=123
export function ContractListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sidebarId = searchParams.get('sidebar');

  return (
    <div className="page-with-sidebar">
      <ContractTable
        onRowClick={(id) =>
          setSearchParams(prev => { prev.set('sidebar', id); return prev; })
        }
      />
      {sidebarId && (
        <aside className="side-panel">
          <ContractSidebarDetail
            id={sidebarId}
            onClose={() =>
              setSearchParams(prev => { prev.delete('sidebar'); return prev; })
            }
          />
        </aside>
      )}
    </div>
  );
}
```

### Pattern C: Next.js Parallel Routes (App Router)

```
app/
├── layout.tsx
├── @sidebar/
│   ├── default.tsx              ← render khi sidebar chưa active
│   └── contract/[id]/page.tsx
├── @modal/
│   ├── default.tsx
│   └── confirm/[id]/page.tsx
└── contracts/page.tsx
```

```tsx
// app/layout.tsx
export default function RootLayout({ children, sidebar, modal }: {
  children: React.ReactNode;
  sidebar: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <html><body>
      <main>{children}</main>
      <aside>{sidebar}</aside>
      {modal}
    </body></html>
  );
}
```

---

## 4. SolidJS — Multiple Outlet Pattern

### Pattern A: createStore-driven

```tsx
// stores/ui.store.ts
import { createStore } from 'solid-js/store';

interface UiState {
  sidebar: { type: 'contract-detail' | 'user-profile' | null; id: string | null };
  modal: { type: 'confirm-delete' | null; id: string | null };
}

const [ui, setUi] = createStore<UiState>({
  sidebar: { type: null, id: null },
  modal: { type: null, id: null },
});

export const useUiStore = () => ({
  ui,
  openSidebar: (type: NonNullable<UiState['sidebar']['type']>, id: string) =>
    setUi('sidebar', { type, id }),
  closeSidebar: () => setUi('sidebar', { type: null, id: null }),
  openModal: (type: NonNullable<UiState['modal']['type']>, id: string) =>
    setUi('modal', { type, id }),
  closeModal: () => setUi('modal', { type: null, id: null }),
});
```

```tsx
// ShellLayout.tsx
import { ParentProps, Show, Switch, Match } from 'solid-js';

export function ShellLayout(props: ParentProps) {
  const { ui, closeSidebar, closeModal } = useUiStore();

  return (
    <>
      <Navbar />
      <div class="app-body">
        <main class="content">
          {props.children}
        </main>

        <Show when={ui.sidebar.type !== null}>
          <aside class="side-panel">
            <Switch>
              <Match when={ui.sidebar.type === 'contract-detail'}>
                <ContractSidebarDetail id={ui.sidebar.id!} onClose={closeSidebar} />
              </Match>
              <Match when={ui.sidebar.type === 'user-profile'}>
                <UserProfileSidebar id={ui.sidebar.id!} onClose={closeSidebar} />
              </Match>
            </Switch>
          </aside>
        </Show>

        <Show when={ui.modal.type !== null}>
          <div class="modal-overlay">
            <Switch>
              <Match when={ui.modal.type === 'confirm-delete'}>
                <ConfirmDeleteModal id={ui.modal.id!} onClose={closeModal} />
              </Match>
            </Switch>
          </div>
        </Show>
      </div>
      <Footer />
    </>
  );
}
```

### Pattern B: useSearchParams (URL-based)

```tsx
// ContractListPage.tsx
import { useSearchParams } from '@solidjs/router';
import { createMemo, Show } from 'solid-js';

export function ContractListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sidebarId = createMemo(() => searchParams.sidebar ?? null);

  return (
    <div class="page-with-sidebar">
      <ContractTable
        onRowClick={(id) => setSearchParams({ sidebar: id })}
      />
      <Show when={sidebarId()}>
        <aside class="side-panel">
          <ContractSidebarDetail
            id={sidebarId()!}
            onClose={() => setSearchParams({ sidebar: undefined })}
          />
        </aside>
      </Show>
    </div>
  );
}
```

---

## 5. So sánh toàn diện

| | Angular Named Outlets | React State-driven | React Search Params | Next.js Parallel Routes | SolidJS Store |
|---|---|---|---|---|---|
| URL reflect state | ✅ | ❌ | ✅ | ✅ | ❌ |
| Native support | ✅ | ❌ | ❌ | ✅ | ❌ |
| Shareable URL | ✅ | ❌ | ✅ | ✅ | ❌ |
| Independent history | ✅ | ❌ | Một phần | ✅ | ❌ |
| Complexity | Trung bình | Thấp | Thấp | Trung bình | Thấp |
| Lazy load outlet | ✅ | ✅ (lazy component) | ✅ | ✅ | ✅ |

---

## 6. Use Case thực tế

| Use case | Outlet nào | Pattern phù hợp |
|---|---|---|
| Master-detail (list + sidebar) | Primary + sidebar | Angular Named Outlet / Search Param |
| Modal confirm/alert | Overlay | State-driven (không cần URL) |
| Notification tray | Corner overlay | State-driven |
| Side-by-side so sánh | Primary + secondary | Angular Named Outlet |
| Wizard steps trong page | Nội bộ component | Internal state — không dùng router |
| Deep-link được sidebar | Primary + sidebar | Angular Named Outlet / Next.js Parallel |

---

## Related

- [[Angular-Latest-Series/22-Routing-Layout-SearchState]]
- [[React-Latest-Series/23-Routing-Layout-SearchState]]
- [[SolidJS-Series/SolidJS-13-Routing-Layout-SearchState]]
- [[Angular-Latest-Series/10-Routing-and-Navigation]]
- [[React-Latest-Series/07-React-Router-v6]]
- [[SolidJS-Series/SolidJS-09-Routing]]
