# Angular Routing — Layout Cố Định & Search State Preservation

tags: #angular #routing #layout #search-state #frontend

---

## 1. Bài toán thực tế

Ứng dụng có **shell layout cố định**:

```
┌──────────────────────────────────────┐
│              Navbar/Header           │
├─────────┬────────────────────────────┤
│         │                            │
│ Sidebar │     <router-outlet>        │
│ (fixed) │   (content thay đổi)       │
│         │                            │
├─────────┴────────────────────────────┤
│               Footer                 │
└──────────────────────────────────────┘
```

Chỉ phần `<router-outlet>` thay đổi. Sidebar, Navbar, Footer **không re-render**.

---

## 2. Cấu trúc Route — Nested Layout Route

### `app.routes.ts`

```typescript
import { Routes } from '@angular/router';
import { ShellLayoutComponent } from './layout/shell-layout.component';

export const routes: Routes = [
  {
    path: '',
    component: ShellLayoutComponent,  // Layout wrapper
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./pages/dashboard/dashboard.component')
            .then(m => m.DashboardComponent),
      },
      {
        path: 'contracts',
        children: [
          {
            path: '',
            loadComponent: () =>
              import('./pages/contracts/contract-list.component')
                .then(m => m.ContractListComponent),
          },
          {
            path: ':id',
            loadComponent: () =>
              import('./pages/contracts/contract-detail.component')
                .then(m => m.ContractDetailComponent),
          },
        ],
      },
    ],
  },
  { path: 'login', loadComponent: () => import('./pages/auth/login.component').then(m => m.LoginComponent) },
  { path: '**', redirectTo: '' },
];
```

### `shell-layout.component.ts`

```typescript
@Component({
  selector: 'app-shell-layout',
  standalone: true,
  imports: [RouterOutlet, NavbarComponent, SidebarComponent, FooterComponent],
  template: `
    <app-navbar />
    <div class="app-body">
      <app-sidebar />
      <main class="content">
        <router-outlet />   <!-- Chỉ phần này thay đổi -->
      </main>
    </div>
    <app-footer />
  `,
})
export class ShellLayoutComponent {}
```

> **Key insight**: `ShellLayoutComponent` không bao giờ bị destroy khi navigate giữa các child routes. Sidebar/Navbar/Footer giữ nguyên instance.

---

## 3. Search State Preservation — Các Pattern

### Problem

User ở `/contracts?page=2&status=ACTIVE&keyword=VPBank` → click vào contract → vào `/contracts/123` → bấm **Back** → muốn quay lại đúng trạng thái search cũ.

Angular mặc định **destroy component** khi navigate away → state mất.

---

### Pattern A: Query Params làm Source of Truth (Recommended cho shareable URL)

```typescript
// contract-list.component.ts
@Component({ ... })
export class ContractListComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  searchForm = new FormGroup({
    keyword: new FormControl(''),
    status: new FormControl(''),
    page: new FormControl(1),
  });

  ngOnInit() {
    // Hydrate form từ URL params khi component khởi tạo
    this.route.queryParams.pipe(
      take(1)
    ).subscribe(params => {
      this.searchForm.patchValue({
        keyword: params['keyword'] ?? '',
        status: params['status'] ?? '',
        page: Number(params['page']) || 1,
      });
      this.loadContracts();
    });
  }

  onSearch() {
    const val = this.searchForm.value;
    // Ghi state vào URL → đây là nguồn sự thật duy nhất
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        keyword: val.keyword || null,
        status: val.status || null,
        page: 1,
      },
      queryParamsHandling: 'merge',
    });
  }

  goToDetail(id: string) {
    // Navigate sang detail — query params của list route KHÔNG bị xóa
    // vì chúng là params của /contracts, không phải /contracts/:id
    this.router.navigate(['/contracts', id]);
  }
}
```

```typescript
// contract-detail.component.ts
@Component({ ... })
export class ContractDetailComponent {
  private location = inject(Location);
  private router = inject(Router);

  // Option 1: Browser back (giữ nguyên URL history)
  goBack() {
    this.location.back();
  }

  // Option 2: Navigate về list với params rõ ràng
  // (dùng khi cần control cụ thể)
  goBackToList() {
    this.router.navigate(['/contracts'], {
      queryParams: { /* nếu cần pass thêm gì */ }
    });
  }
}
```

**Kết quả**: URL `/contracts?keyword=VPBank&status=ACTIVE&page=2` → navigate sang `/contracts/123` → bấm browser Back → quay về đúng URL cũ → `ContractListComponent` khởi tạo lại → đọc params từ URL → restore form.

---

### Pattern B: Service-based State (cho state không muốn expose lên URL)

```typescript
// search-state.service.ts
@Injectable({ providedIn: 'root' })  // Singleton — sống suốt app lifetime
export class ContractSearchStateService {
  private state = signal<ContractSearchState>({
    keyword: '',
    status: '',
    page: 1,
    pageSize: 20,
    results: [],
    totalCount: 0,
  });

  readonly snapshot = this.state.asReadonly();

  save(partial: Partial<ContractSearchState>) {
    this.state.update(s => ({ ...s, ...partial }));
  }

  clear() {
    this.state.set({ keyword: '', status: '', page: 1, pageSize: 20, results: [], totalCount: 0 });
  }
}
```

```typescript
// contract-list.component.ts
@Component({ ... })
export class ContractListComponent implements OnInit {
  private searchState = inject(ContractSearchStateService);

  // Reactive từ service signal
  state = this.searchState.snapshot;

  searchForm = new FormGroup({
    keyword: new FormControl(''),
    status: new FormControl(''),
  });

  ngOnInit() {
    // Restore từ service state (component re-create khi navigate back)
    const s = this.state();
    this.searchForm.patchValue({ keyword: s.keyword, status: s.status });
    // Không cần load lại nếu results đã có
    if (s.results.length === 0) this.loadContracts();
  }

  onSearch() {
    this.searchState.save({
      keyword: this.searchForm.value.keyword!,
      status: this.searchForm.value.status!,
      page: 1,
    });
    this.loadContracts();
  }

  private loadContracts() {
    const s = this.state();
    this.contractService.search(s).subscribe(res => {
      this.searchState.save({ results: res.items, totalCount: res.total });
    });
  }
}
```

---

### Pattern C: RouteReuseStrategy — Giữ component instance (Advanced)

Khi navigate đi và quay lại, Angular **tái sử dụng component instance** thay vì destroy/recreate.

```typescript
// custom-route-reuse.strategy.ts
@Injectable({ providedIn: 'root' })
export class CustomReuseStrategy implements RouteReuseStrategy {
  private cache = new Map<string, DetachedRouteHandle>();

  private reuseRoutes = new Set(['/contracts']);

  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    return this.reuseRoutes.has(this.getKey(route));
  }

  store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle): void {
    this.cache.set(this.getKey(route), handle);
  }

  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    return this.cache.has(this.getKey(route));
  }

  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    return this.cache.get(this.getKey(route)) ?? null;
  }

  shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    return future.routeConfig === curr.routeConfig;
  }

  private getKey(route: ActivatedRouteSnapshot): string {
    return route.pathFromRoot.map(r => r.url.map(s => s.toString()).join('/')).join('/');
  }
}
```

```typescript
// app.config.ts
export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    { provide: RouteReuseStrategy, useClass: CustomReuseStrategy },
  ],
};
```

> **Tradeoff**: Mạnh nhất về UX (scroll position, animation state đều giữ), nhưng memory leak risk nếu không clear cache đúng lúc. Chỉ dùng khi Pattern A/B không đủ.

---

## 4. So sánh 3 Pattern

| Pattern | URL shareable | Memory | Complexity | Best for |
|---|---|---|---|---|
| A — Query Params | ✅ | Thấp | Thấp | Search/filter page cần bookmark/share |
| B — Service State | ❌ | Trung bình | Trung bình | Complex state, không cần expose lên URL |
| C — RouteReuseStrategy | ❌ | Cao | Cao | UX cực cao, infinite scroll, heavy component |

---

## 5. Hyperlink từ Detail về List

```html
<!-- contract-detail.component.html -->

<!-- Option 1: Router directive với queryParams rõ ràng -->
<a [routerLink]="['/contracts']" [queryParams]="{ keyword: previousKeyword }">
  ← Quay lại danh sách
</a>

<!-- Option 2: Location.back() — giữ nguyên history stack -->
<button (click)="location.back()">← Quay lại</button>
```

**Khuyến nghị**: Dùng `location.back()` khi flow là List → Detail → Back. Dùng `[routerLink]` khi Detail có thể được truy cập trực tiếp (bookmark, email link) và không có history stack để back về.

---

## 6. Scroll Position Restoration

```typescript
// app.config.ts
export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes, withRouterConfig({
      scrollPositionRestoration: 'enabled',  // Restore scroll khi back
      anchorScrolling: 'enabled',
    })),
  ],
};
```

---

## Related

- [[React-Latest-Series/23-Routing-Layout-SearchState]]
- [[SolidJS-Series/SolidJS-13-Routing-Layout-SearchState]]
- [[10-Routing-and-Navigation]]
- [[18-Route-Guards-and-Resolvers]]
