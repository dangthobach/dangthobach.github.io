# Frontend Project Architecture 2026 — Kiến Trúc Nào Cho Usecase Nào?

> **Status:** 🟢 Active  
> **Tags:** #frontend #architecture #react #angular #solidjs #FSD #scalability  
> **Related:** [[React-Latest-Series/15-Enterprise-Best-Practices]] · [[Angular-Latest-Series/14-Enterprise-Architecture-and-Standalone]] · [[SolidJS-Series/06-Enterprise-Architecture]] · [[concepts/]]

---

## 🗺️ Tại Sao Cần Quan Tâm Đến Project Structure?

Hầu hết dev khi start project đều tổ chức theo **technical role** — tức là nhóm theo loại file:

```
src/
  components/
  hooks/
  utils/
  services/
  types/
```

Cách này hoạt động ổn khi project nhỏ. Nhưng khi team lớn lên và features tăng, nó biến thành **spaghetti code** — một component `UserCard` phụ thuộc vào một hook trong `hooks/`, một service trong `services/`, một type trong `types/`, và một util trong `utils/`. Để hiểu một feature, bạn phải nhảy qua 5 folder khác nhau.

> **Nguyên tắc cốt lõi:** Complexity không biến mất — nó chỉ *dịch chuyển*. Kiến trúc tốt là kiến trúc kiểm soát được nơi complexity trú ngụ.

---

## 📐 Tổng Quan Các Kiến Trúc Phổ Biến 2025–2026

```mermaid
graph TD
    A[Frontend Architectures] --> B[Layered / MVC / MVVM]
    A --> C[Component-Based]
    A --> D[Feature-Sliced Design - FSD]
    A --> E[Vertical Slice Architecture]
    A --> F[Micro-Frontends]

    B --> B1["✅ Small–Medium projects\n❌ Degrades at scale"]
    C --> C1["✅ Non-negotiable foundation\n❌ Doesn't solve domain complexity"]
    D --> D1["✅ Medium–Large SPA/MPA\n✅ Cross-functional teams"]
    E --> E1["✅ Large, team-owned features\n✅ Backend-for-frontend pattern"]
    F --> F1["✅ Multiple teams, separate deploys\n❌ Overkill nếu 1 team"]
```

---

## 1️⃣ Layered Architecture (MVC / MVVM)

### Khái niệm

Tổ chức code theo **trách nhiệm kỹ thuật** (technical concern). MVVM đặc biệt phổ biến trong Angular và Vue vì có reactive binding sẵn.

```
src/
  models/        # Data models, interfaces
  views/         # UI components
  controllers/   # Business logic / ViewModels
  services/      # API calls, side effects
```

### Khi nào dùng?

| Tiêu chí | Phù hợp |
|----------|---------|
| Team size | Solo → 3 devs |
| Project size | < 20 features |
| Vòng đời | Short-lived, prototype |
| Framework | Angular (có sẵn DI + service layer) |

### Hạn chế

Khi features tăng lên 30+, `services/` folder trở thành một "thùng rác" không có ranh giới rõ ràng giữa các domain.

---

## 2️⃣ Feature-Sliced Design (FSD) ⭐ — *Xu hướng chính 2025–2026*

### Khái niệm

FSD là methodology được thiết kế riêng cho frontend, tổ chức code theo 3 chiều: **Layer → Slice → Segment**.

```mermaid
graph LR
    subgraph LAYERS ["6 Layers (top → bottom)"]
        APP["app\n(bootstrap, routing, providers)"]
        PAGES["pages\n(screen-level views)"]
        WIDGETS["widgets\n(composite blocks)"]
        FEATURES["features\n(user actions)"]
        ENTITIES["entities\n(business objects)"]
        SHARED["shared\n(reusable, framework-agnostic)"]
    end

    APP -->|"can use"| PAGES
    PAGES -->|"can use"| WIDGETS
    WIDGETS -->|"can use"| FEATURES
    FEATURES -->|"can use"| ENTITIES
    ENTITIES -->|"can use"| SHARED

    style APP fill:#ff6b6b,color:#fff
    style PAGES fill:#ffa94d,color:#fff
    style WIDGETS fill:#ffd43b,color:#000
    style FEATURES fill:#69db7c,color:#000
    style ENTITIES fill:#4dabf7,color:#fff
    style SHARED fill:#9775fa,color:#fff
```

> **Quy tắc vàng:** Layer chỉ được import từ layer **thấp hơn** nó. `features` không được import từ `pages`. `shared` không được import từ bất kỳ layer nào khác.

### Cấu trúc thư mục thực tế

```
src/
├── app/                    # Layer 1: App bootstrap
│   ├── providers/          # Redux store, ThemeProvider, AuthProvider
│   ├── router/             # Root routing config
│   └── styles/             # Global CSS / design tokens
│
├── pages/                  # Layer 2: Route-level screens
│   ├── dashboard/
│   │   ├── ui/             # DashboardPage.tsx
│   │   └── index.ts        # Public API (barrel export)
│   └── profile/
│       ├── ui/
│       └── index.ts
│
├── widgets/                # Layer 3: Composite blocks
│   ├── header/
│   │   ├── ui/             # Header.tsx (combines features + entities)
│   │   └── index.ts
│   └── sidebar/
│
├── features/               # Layer 4: User interactions
│   ├── auth-by-email/      # "Login with email" feature
│   │   ├── ui/             # LoginForm.tsx
│   │   ├── model/          # useLoginForm.ts, authSlice.ts
│   │   ├── api/            # loginUser.ts (API call)
│   │   └── index.ts
│   └── add-to-cart/
│
├── entities/               # Layer 5: Business domain objects
│   ├── user/
│   │   ├── ui/             # UserCard.tsx, UserAvatar.tsx
│   │   ├── model/          # userSlice.ts, User type
│   │   └── index.ts
│   └── product/
│
└── shared/                 # Layer 6: Pure reusable code
    ├── ui/                 # Button, Input, Modal (design system)
    ├── api/                # axios instance, API client
    ├── config/             # env variables, constants
    ├── lib/                # Generic helpers (formatDate, cn())
    └── types/              # Shared TypeScript types
```

### Ví dụ: Flow của feature "Add to Cart"

```mermaid
sequenceDiagram
    participant Page as pages/product-detail
    participant Widget as widgets/product-info
    participant Feature as features/add-to-cart
    participant Entity as entities/cart
    participant Shared as shared/api

    Page->>Widget: renders ProductInfoWidget
    Widget->>Feature: renders AddToCartButton
    Feature->>Entity: dispatches cart.addItem(product)
    Entity->>Shared: calls POST /cart/items
    Shared-->>Entity: returns updated cart
    Entity-->>Feature: updates cart state
    Feature-->>Widget: shows "Added ✓" feedback
```

### Segments trong mỗi Slice

```
feature/auth-by-email/
├── ui/       # React/Angular/Solid components
├── model/    # State, business logic, hooks
├── api/      # API calls riêng cho feature này
├── lib/      # Helpers chỉ dùng trong feature này
├── config/   # Constants riêng
└── index.ts  # PUBLIC API — chỉ export những gì cần thiết!
```

> **`index.ts` là "public API contract"** — bên ngoài chỉ được import từ `features/auth-by-email`, không được đi thẳng vào `features/auth-by-email/model/authSlice`. Đây là cơ chế encapsulation của FSD.

### Khi nào dùng FSD?

| Tiêu chí | Phù hợp |
|----------|---------|
| Team size | 2–20 devs |
| Project size | Medium → Large SPA |
| Features | 10+ business features rõ ràng |
| Framework | React, Angular, SolidJS, Vue — framework-agnostic |
| Onboarding | Cần onboard member mới nhanh |

---

## 3️⃣ Vertical Slice Architecture (VSA)

### Khái niệm

Mỗi **"use case"** hoặc **"user story"** là một slice hoàn toàn độc lập, chứa toàn bộ stack từ UI → business logic → API call.

```mermaid
graph LR
    subgraph VSA ["Vertical Slice Architecture"]
        direction TB
        S1["CreatePost/\n  CreatePostForm.tsx\n  useCreatePost.ts\n  createPost.api.ts\n  createPost.test.ts"]
        S2["LikePost/\n  LikeButton.tsx\n  useLikePost.ts\n  likePost.api.ts"]
        S3["CommentPost/\n  CommentSection.tsx\n  useComments.ts\n  comments.api.ts"]
    end

    style S1 fill:#4dabf7,color:#000
    style S2 fill:#69db7c,color:#000
    style S3 fill:#ffd43b,color:#000
```

### So sánh với FSD

| | FSD | Vertical Slice |
|--|-----|---------------|
| Tổ chức theo | Layer + Domain | Use case / User story |
| Code sharing | Qua `entities` và `shared` | Cẩn thận, dễ duplicate |
| Team ownership | Feature team own một slice | Use case team own một slice |
| Phù hợp | SPA có domain model rõ | BFF, server-driven UI |
| Backend analogy | DDD + Layered | CQRS + Vertical Slice |

### Khi nào dùng VSA?

- App có các use case **hoàn toàn độc lập** với nhau
- Backend-for-Frontend (BFF) pattern — mỗi screen có API endpoint riêng
- Team lớn, mỗi team sở hữu một flow end-to-end

---

## 4️⃣ Micro-Frontends

### Khái niệm

Tách frontend thành các **ứng dụng nhỏ độc lập**, mỗi cái có thể deploy riêng, viết bằng framework khác nhau.

```mermaid
graph TD
    Shell["Shell App\n(App Shell / Root)"]
    Shell --> MF1["MFE: Auth\n(React Team)"]
    Shell --> MF2["MFE: Dashboard\n(Angular Team)"]
    Shell --> MF3["MFE: Reports\n(Vue Team)"]

    subgraph Integration
        WC["Web Components"]
        MF["Module Federation\n(Webpack 5 / Vite)"]
        IF["iframe isolation"]
    end
```

### Khi nào dùng?

| Tiêu chí | Phù hợu |
|----------|---------|
| Team size | 5+ independent teams |
| Deploy | Cần deploy độc lập từng phần |
| Tech diversity | Nhiều framework khác nhau |
| Org structure | Conway's Law — team structure = architecture |

> ⚠️ **Cảnh báo:** Micro-frontends giải quyết **organizational scale**, không phải code complexity. Nếu chỉ có 1–2 team, FSD là đủ và nhẹ hơn nhiều.

---

## 🔄 Decision Tree — Chọn Kiến Trúc Nào?

```mermaid
flowchart TD
    Start([Bắt đầu project mới]) --> Q1{Số lượng teams?}
    
    Q1 -->|"1 team"| Q2{Project size?}
    Q1 -->|"3+ teams\nindependent"| MFE["🏗️ Micro-Frontends\n+ Module Federation"]
    
    Q2 -->|"Prototype / < 3 months"| MVC["📦 Layered / MVC\nSimple folder by type"]
    Q2 -->|"Medium–Large SPA"| Q3{Domain model rõ ràng?}
    
    Q3 -->|"Có entities rõ\n(User, Product, Order...)"| FSD["⭐ Feature-Sliced Design\nBest for most SPAs"]
    Q3 -->|"Use cases độc lập\nít share logic"| VSA["🔪 Vertical Slice\nPer use case isolation"]
    
    FSD --> Angular["Angular: FSD\n+ NgModules / Standalone"]
    FSD --> React["React: FSD\n+ TanStack Query + Zustand"]
    FSD --> Solid["SolidJS: FSD\n+ SolidStart + Stores"]

    style FSD fill:#69db7c,color:#000,stroke:#2f9e44
    style MFE fill:#ffd43b,color:#000
    style VSA fill:#4dabf7,color:#000
    style MVC fill:#dee2e6,color:#000
```

---

## ⚡ Áp Dụng FSD Cho Từng Framework

### React + FSD

```tsx
// features/auth-by-email/ui/LoginForm.tsx
import { Button } from "@/shared/ui";          // ✅ import from shared
import { UserCard } from "@/entities/user";    // ✅ import from entities (lower layer)
// import { Header } from "@/widgets/header";  // ❌ FORBIDDEN — widgets is higher layer

export const LoginForm = () => {
  const { mutate: login, isPending } = useLogin(); // from features/auth-by-email/model

  return (
    <form onSubmit={login}>
      <Button loading={isPending}>Sign In</Button>
    </form>
  );
};
```

```
// tsconfig.json — path aliases để enforce FSD imports
{
  "compilerOptions": {
    "paths": {
      "@/app/*":      ["./src/app/*"],
      "@/pages/*":    ["./src/pages/*"],
      "@/widgets/*":  ["./src/widgets/*"],
      "@/features/*": ["./src/features/*"],
      "@/entities/*": ["./src/entities/*"],
      "@/shared/*":   ["./src/shared/*"]
    }
  }
}
```

### Angular + FSD

Angular có sẵn module system — map rất tự nhiên sang FSD:

```
src/
├── app/                    # AppModule / bootstrapApplication
├── pages/                  # Lazy-loaded route components
│   └── dashboard/
│       ├── dashboard.component.ts
│       └── index.ts
├── features/
│   └── filter-products/
│       ├── filter-form.component.ts
│       ├── filter.service.ts          # Angular DI service
│       └── index.ts
├── entities/
│   └── product/
│       ├── product-card.component.ts
│       ├── product.model.ts           # Interface + Zod schema
│       └── index.ts
└── shared/
    ├── ui/                # Reusable Angular components
    └── api/               # HttpClient wrapper
```

> Angular với **Standalone Components** (Angular 17+) fit FSD cực tốt — mỗi slice là một tập standalone components với DI riêng.

### SolidJS + FSD

SolidJS's fine-grained reactivity maps cleanly vào FSD model layer:

```tsx
// entities/user/model/user.store.ts
import { createStore } from "solid-js/store";

export const [userStore, setUserStore] = createStore({
  currentUser: null as User | null,
  isLoading: false,
});

// features/edit-profile/ui/EditProfileForm.tsx  
import { userStore } from "@/entities/user";  // ✅ lower layer
import { Button } from "@/shared/ui";          // ✅ lower layer
```

---

## 🛠️ Tooling Hỗ Trợ FSD

| Tool | Mục đích |
|------|---------|
| `@feature-sliced/eslint-config` | ESLint rules enforce import rules |
| `steiger` | Linter kiểm tra toàn bộ FSD conventions |
| `npx fsd` | CLI tạo folder/slice structure |
| VSCode plugin | Steiger integration trong editor |
| `eslint-plugin-boundaries` | Alternative enforce module boundaries |

```bash
# Tạo FSD structure với CLI
npx fsd pages dashboard profile settings --segments ui model
npx fsd features auth-by-email add-to-cart --segments ui model api
npx fsd entities user product order --segments ui model
```

---

## 📊 So Sánh Tổng Hợp

```mermaid
quadrantChart
    title Architecture Fit: Complexity vs Team Scale
    x-axis "Low Team Scale" --> "High Team Scale"
    y-axis "Low App Complexity" --> "High App Complexity"
    quadrant-1 Micro-Frontends
    quadrant-2 Feature-Sliced Design
    quadrant-3 Layered / MVC
    quadrant-4 Vertical Slice
    Layered MVC: [0.15, 0.2]
    MVVM Angular: [0.3, 0.35]
    FSD React: [0.45, 0.65]
    FSD Angular: [0.5, 0.7]
    Vertical Slice: [0.65, 0.55]
    Module Federation: [0.82, 0.75]
    Monorepo NX: [0.75, 0.8]
```

| Kiến trúc | Team | Project Size | Learning Curve | Flexibility |
|-----------|------|-------------|---------------|------------|
| Layered/MVC | Solo–3 | Small | ⭐ Thấp | ⭐⭐⭐ Cao |
| FSD | 2–20 | Medium–Large | ⭐⭐⭐ Trung bình | ⭐⭐ Trung bình |
| Vertical Slice | 3–10 | Large | ⭐⭐ Thấp-TB | ⭐⭐⭐ Cao |
| Micro-Frontends | 5+ teams | Very Large | ⭐⭐⭐⭐⭐ Cao | ⭐⭐⭐⭐ Rất cao |

---

## 🚀 Migration Path — Refactor Dần Không Đau

Nếu bạn có codebase cũ theo style "folders by type", không cần rewrite toàn bộ:

```mermaid
graph LR
    Step1["1. Extract Shared\nMove utils, UI kit\nvào shared/"] -->
    Step2["2. Extract Entities\nIdentify domain objects\n(User, Product...)"] -->
    Step3["3. Extract Features\nWrap user actions\nvào features/"] -->
    Step4["4. Compose Pages\nPages chỉ compose\nwidgets + features"] -->
    Step5["5. Add ESLint rules\nEnforce import rules\ntự động"]
```

> Làm từng bước, feature by feature. Không cần "big rewrite".

---

## 💡 Kết Luận — Lựa Chọn Của Tôi

Cho stack **React / Angular / SolidJS** trong context **enterprise/medium-large SPA**:

> **⭐ Feature-Sliced Design là default choice cho 2025–2026.**

Lý do:
1. **Framework-agnostic** — cùng methodology cho React, Angular, SolidJS
2. **Domain-driven** — structure phản ánh business, không phải technical concerns  
3. **Onboarding nhanh** — member mới đọc folder name là hiểu app làm gì
4. **Tooling tốt** — ESLint, CLI, steiger linter
5. **Scale gracefully** — không cần rewrite khi team lớn lên

Chỉ chuyển sang Micro-Frontends khi có **nhiều team độc lập cần deploy riêng**.

---

## 🔗 Tài Liệu Tham Khảo

- [Feature-Sliced Design Official Docs](https://feature-sliced.design/)
- [FSD Tutorial — Conduit App](https://feature-sliced.design/docs/get-started/tutorial)
- [FSD with Angular — Medium](https://medium.com/@fed4wet/feature-sliced-design-modern-architectural-methodology-on-angular-d0ef705ef598)
- [[React-Latest-Series/15-Enterprise-Best-Practices]]
- [[Angular-Latest-Series/14-Enterprise-Architecture-and-Standalone]]
- [[SolidJS-Series/06-Enterprise-Architecture]]
- [[concepts/]]
