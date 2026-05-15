# React Compiler — Cơ chế thu hẹp gap với SolidJS

tags: #react #react-compiler #memoization #performance #compiler #HIR #SSA #internals

---

## 1. Vấn đề React Compiler giải quyết

React's declarative model có một fundamental trade-off: developer viết component thuần, React re-run toàn bộ function khi state thay đổi. Tối ưu (memo, useMemo, useCallback) là opt-in thủ công — dễ thiếu, dễ sai.

Meta ước tính trong các codebase nội bộ: **60–70% performance issue liên quan đến thiếu hoặc sai memoization**. Nếu đây là vấn đề ngay với team tạo ra React, thì đó là gánh nặng không bền vững cho cộng đồng.

React Compiler (stable v1.0, tháng 10/2025) là build-time tool giải quyết vấn đề này bằng static analysis — không phải runtime magic.

---

## 2. Pipeline biên dịch nội bộ

Compiler chạy như Babel plugin (hoặc SWC plugin) trong build step. Pipeline đầy đủ:

```
Source (JSX/TSX)
    ↓
Babel/SWC parse → AST
    ↓
HIR — High-Level Intermediate Representation + CFG
    ↓
SSA Conversion
    ↓
Validation (rules of React check)
    ↓
Type Inference │ Purity + Effect Analysis
    ↓          ↓
    └──────────┘
         ↓
Reactive Scope Discovery
    ↓
Optimization (dead code elimination, constant propagation)
    ↓
Code Generation — Optimized JS với inline cache slots
```

### Phase 1 — HIR (High-Level IR + Control Flow Graph)

AST là cấu trúc đơn giản của code. HIR biến đổi AST thành dạng **Control Flow Graph** — mô hình hóa rõ ràng tất cả branches, loops, và code paths dưới dạng basic blocks liên kết nhau.

Tại sao cần CFG? Vì compiler cần biết chính xác giá trị nào phụ thuộc vào code path nào:

```tsx
// Với AST đơn giản, compiler không thể biết activeContracts
// phụ thuộc vào limitResults hay không tại build time
let activeContracts = contracts.filter(c => c.status === 'ACTIVE');
if (limitResults) {
  activeContracts = activeContracts.slice(0, 10);  // conditional mutation
}
```

### Phase 2 — SSA (Single Static Assignment)

SSA đảm bảo **mỗi variable chỉ được assign đúng một lần** — mỗi assignment nhận tên unique. Khi hai code path hội tụ, một **phi function** (φ) quyết định giá trị nào được dùng:

```
// SSA representation của code trên:
activeContracts_1 = contracts.filter(c => c.status === 'ACTIVE')

// Block B: nếu limitResults === true
activeContracts_2 = activeContracts_1.slice(0, 10)

// Merge point: phi function
activeContracts_3 = φ(activeContracts_1, activeContracts_2)
//   → Table chỉ re-render khi activeContracts_3 thay đổi
//   → compiler biết chính xác dependency graph
```

Không có SSA, compiler không thể safely xác định deps của các biến trong conditional branches — sẽ phải over-memoize (tốn bộ nhớ) hoặc under-memoize (miss optimization).

### Phase 3 — Type Inference + Purity Analysis

Compiler chạy song song hai analysis:

**Type inference**: Classify mỗi expression:
- `Static` — không bao giờ thay đổi giữa các render (constants, imports, module-level values)
- `Reactive` — có thể thay đổi (props, state, derived values)
- `Primitive` vs `Reference` — quan trọng cho equality check (number === number vs object reference)

**Purity analysis**: Kiểm tra component có pure không:
- Không mutate props hay external state trong render
- Không đọc non-deterministic values (`Date.now()`, `Math.random()`)
- Không có side effects ngoài Effects

Nếu component vi phạm → compiler **de-opts** component đó, bỏ qua optimization, fallback về full re-render. Điều này đảm bảo compiler không bao giờ tạo ra behavior sai.

### Phase 4 — Reactive Scope Discovery (quan trọng nhất)

Đây là phase quyết định **ranh giới memoization**. Compiler nhóm các values được tạo/mutate cùng nhau thành một "reactive scope". Mỗi scope nhận một cache slot.

```tsx
// Compiler phân tích component này:
function ContractList({ contracts, keyword, page }) {
  // Scope A: phụ thuộc vào [contracts, keyword]
  const filtered = contracts.filter(c => c.name.includes(keyword));

  // Scope B: phụ thuộc vào [filtered, page]
  const paginated = filtered.slice((page-1)*20, page*20);

  // Scope C: phụ thuộc vào [paginated] — JSX subtree
  return <Table data={paginated} onRowClick={handleClick} />;
}

// Compiler generates roughly:
function ContractList({ contracts, keyword, page }) {
  const $ = _cache; // inline cache array

  let filtered;
  if ($[0] !== contracts || $[1] !== keyword) {
    filtered = contracts.filter(c => c.name.includes(keyword));
    $[0] = contracts; $[1] = keyword; $[2] = filtered;
  } else {
    filtered = $[2];
  }

  let paginated;
  if ($[3] !== filtered || $[4] !== page) {
    paginated = filtered.slice((page-1)*20, page*20);
    $[3] = filtered; $[4] = page; $[5] = paginated;
  } else {
    paginated = $[5];
  }

  let jsx;
  if ($[6] !== paginated) {
    jsx = <Table data={paginated} onRowClick={handleClick} />;
    $[6] = paginated; $[7] = jsx;
  } else {
    jsx = $[7];
  }
  return jsx;
}
```

Memoization này **granular hơn `useMemo` thủ công** vì compiler track từng prop riêng lẻ thay vì toàn bộ component.

---

## 3. Điều compiler làm được mà developer không thể

### 3.1 Memo sau early return

```tsx
// Developer KHÔNG THỂ đặt useMemo sau early return
// (vi phạm Rules of Hooks — hooks phải ở top level)
function ContractDetail({ id, isAdmin }) {
  if (!id) return null;  // ← early return

  // useMemo ở đây → Error: "React Hook called conditionally"
  const processedData = expensiveTransform(id, isAdmin);
  return <Detail data={processedData} />;
}

// Compiler phân tích toàn bộ function qua CFG/SSA
// → tạo ra cache slot cho processedData một cách an toàn
// → không vi phạm Rules of Hooks vì đây là code generated, không phải Hook call
```

### 3.2 Fix inline arrow function breaking memo

Vấn đề kinh điển khiến `React.memo` không hoạt động:

```tsx
// Developer viết: (KHÔNG memo được dù Child dùng React.memo)
<Child onClick={() => handleClick(item)} />
// ↑ Arrow function mới mỗi render → Child luôn re-render

// Compiler phân tích: handleClick và item có thay đổi không?
// → Nếu không: inject stable reference
// → Child thực sự skip re-render
```

### 3.3 Tự động xác định conditional dependencies

```tsx
function Dashboard({ userId, includeStats }) {
  const user = fetchUser(userId);

  // Compiler biết stats chỉ cần tính khi includeStats === true
  // AND userId thay đổi → cache scope chính xác hơn
  const stats = includeStats ? computeStats(userId) : null;

  return <View user={user} stats={stats} />;
}
```

Với `useMemo` thủ công: dependency array `[userId, includeStats]` thì `computeStats` re-run cả khi `includeStats` chuyển false→true (dù result = null). Compiler optimize chính xác hơn.

---

## 4. Giới hạn của compiler — tại sao gap với Solid vẫn còn

### 4.1 `useRef` không được optimize

Compiler **intentionally skip** các component phụ thuộc vào `useRef` mutation. Lý do: `ref.current` mutable và non-reactive — compiler không thể biết khi nào ref thay đổi, nên không thể safely determine memoization boundary.

```tsx
// Compiler de-opts component này
function Timer() {
  const countRef = useRef(0);
  // ref.current mutation không trigger re-render
  // → compiler không track được → skip optimization
  const increment = () => { countRef.current++; };
  return <HeavyChild onIncrement={increment} />;
}

// Fix: dùng useState thay useRef nếu cần optimize
```

### 4.2 External library không theo Rules of React

```tsx
// Compiler fail nếu external library return non-memoized objects
const { data } = useExternalLibrary(); // { user: {...} } mới mỗi render
<Child config={data} /> // Child luôn re-render dù data content không đổi
```

Trường hợp này compiler "de-opts" toàn bộ subtree — không emit warning, chỉ silently skip.

### 4.3 vDOM vẫn còn — đây là gap cơ bản với SolidJS

Compiler giải quyết vấn đề **"skip re-run component function"** nhưng không xóa vDOM. Flow vẫn là:

```
setState
    ↓
Compiler check: deps thay đổi không?
    ├── NO → skip re-run component fn, reuse cached JSX ← đây là gain
    └── YES → re-run fn → build new vDOM subtree → diff → commit
```

SolidJS không có vDOM ngay từ đầu — signal thay đổi → update DOM node trực tiếp, không có "build vDOM → diff" step. Với fine-grained updates (single signal), Solid vẫn làm ít work hơn về mặt cơ bản.

### 4.4 Runtime overhead của cache check

Output của compiler thêm cache array access và comparison mỗi render:

```js
if ($[0] !== contracts || $[1] !== keyword) {
  // rebuild scope
}
```

Với component đơn giản, overhead này đôi khi lớn hơn benefit. Compiler có heuristic để skip memoization khi không đáng — nhưng không perfect.

---

## 5. Production metrics thực tế

| Source | Metric | Before | After |
|---|---|---|---|
| Meta Quest Store | Initial load | baseline | +12% faster |
| Meta Quest Store | Key interactions | baseline | 2.5× faster |
| Wakelet (100% rollout) | LCP | 2.6s | 2.4s (−10%) |
| Wakelet (100% rollout) | INP | 275ms | 240ms (−15%) |
| Wakelet (Radix dropdowns) | INP | baseline | −30% |
| Nadia Makarevich (15k LOC) | Lighthouse score | unchanged | unchanged |
| Nadia Makarevich | Theme toggle TBT | 280ms | 0ms |
| Nadia Makarevich | Checkbox filter TBT | 130ms | 90ms |

> **Takeaway**: gains tập trung ở **interaction performance** (INP), không phải initial load. Lighthouse score (LCP-heavy) thường không đổi — compiler chủ yếu giúp update performance.

---

## 6. Khi nào compiler impact lớn nhất

Compiler có benefit lớn nhất với:
- Component gần top của tree → cascade re-render xuống nhiều children
- Component có expensive derived state (filter, sort, transform large array)
- Tree sâu với nhiều component nhận props từ parent phổ biến (theme, auth context)
- Pure React components (Radix UI, shadcn/ui) — không có external mutable refs

Compiler ít impact với:
- Component dùng nhiều `useRef` mutations
- Component nhận objects từ external library không memoized
- Initial render (compiler chỉ optimize re-render)
- Components đã được memoize thủ công đúng cách

---

## 7. Cài đặt

```bash
npm install -D babel-plugin-react-compiler
# hoặc SWC plugin cho builds nhanh hơn
```

```js
// Next.js 16 — top-level config (không còn cần experimental)
// next.config.js
module.exports = {
  reactCompiler: true,
};

// Vite
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react({ babel: { plugins: ['babel-plugin-react-compiler'] } })],
});
```

DevTools: React DevTools v5+ hiển thị "Compiler" badge trên các component đã được optimize trong Profiler tab.

---

## 8. So sánh sau khi có compiler

| | SolidJS | React + Compiler |
|---|---|---|
| vDOM | Không có | Có, nhưng skip khi deps không đổi |
| Re-run component fn | Không bao giờ | Skip khi cache hit |
| Granular DOM update | ✅ Signal → DOM node trực tiếp | ✅ Cache scope → skip subtree |
| Early return optimization | ✅ Không liên quan | ✅ Compiler handle |
| Inline fn stability | ✅ Tự nhiên | ✅ Compiler inject |
| useRef compatibility | N/A | ❌ De-opt |
| Runtime overhead | Signal graph traversal | Cache array comparison |
| Bundle size | ~7KB | ~45KB (unchanged) |

**Kết luận**: React Compiler thu hẹp gap performance đáng kể ở layer "unnecessary re-renders" — đây là phần lớn nhất của React overhead trong production apps thực tế. Gap cơ bản (vDOM vs direct DOM) vẫn còn, nhưng ít quan trọng hơn nhiều khi re-renders đã được eliminate đúng cách.

---

## Related

- [[concepts/SolidJS-vs-React-Reactivity-Model]]
- [[React-Latest-Series/11-Performance-Optimization]]
- [[React-Latest-Series/12-Concurrent-Features]]
- [[Angular-Latest-Series/24-Two-Way-Binding-Internals]]
- [[Angular-Latest-Series/08-Signals-The-Modern-Reactivity]]
