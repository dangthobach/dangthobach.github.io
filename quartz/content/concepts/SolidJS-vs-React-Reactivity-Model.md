# SolidJS vs React — Fine-grained Reactivity vs Virtual DOM

tags: #solidjs #react #reactivity #virtual-dom #signals #performance #internals

---

## 1. Câu hỏi cốt lõi

> "SolidJS không diff virtual DOM — điều đó có nghĩa là nó mạnh hơn React toàn diện không?"

Câu trả lời ngắn: **không phải mạnh hơn toàn diện, mà là đánh đổi khác nhau**. SolidJS thắng về runtime performance và memory. React thắng về ecosystem, tooling, và đang thu hẹp gap với React Compiler.

---

## 2. React — Virtual DOM hoạt động như nào

### Component function là "render function"

Trong React, mỗi khi state thay đổi, **toàn bộ component function chạy lại**:

```tsx
function ContractList() {
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);

  // Toàn bộ phần này chạy lại mỗi khi keyword hoặc page thay đổi
  const filtered = contracts.filter(c => c.name.includes(keyword));

  return (
    <div>
      <input value={keyword} onChange={e => setKeyword(e.target.value)} />
      <Table data={filtered} />  {/* Table cũng re-render */}
      <Pagination page={page} />  {/* Pagination cũng re-render */}
    </div>
  );
}
```

### Virtual DOM pipeline mỗi update

```
setState('newValue')
    ↓
Component function chạy lại → tạo new vDOM tree (JS object)
    ↓
Reconciler (Fiber) diff old vDOM vs new vDOM
    ↓
Tính ra minimal set of DOM operations
    ↓
Commit phase: apply changes lên real DOM
```

**Chi phí cố định mỗi update:**
- Re-run function body (dù chỉ 1 pixel thay đổi)
- Allocate new vDOM objects
- Traverse và diff 2 trees
- Commit to real DOM

### Tối ưu của React

React cung cấp escape hatch để giảm re-render:

```tsx
// memo — chỉ re-render khi props thay đổi
const Table = memo(({ data }: { data: Contract[] }) => {
  return <>{data.map(c => <Row key={c.id} contract={c} />)}</>;
});

// useMemo — cache computed value
const filtered = useMemo(
  () => contracts.filter(c => c.name.includes(keyword)),
  [contracts, keyword]
);

// useCallback — cache function reference
const handleSearch = useCallback((val: string) => {
  setKeyword(val);
}, []);
```

**Vấn đề**: những tối ưu này là **opt-in manual** — developer phải tự nhớ và tự áp dụng. Dễ bỏ sót, dễ tạo stale closure bug.

---

## 3. SolidJS — Fine-grained Reactivity hoạt động như nào

### Component function chạy đúng một lần

Solid compile JSX thành **reactive graph** — không phải render function:

```tsx
function ContractList() {
  const [keyword, setKeyword] = createSignal('');
  const [page, setPage] = createSignal(1);

  // Chạy 1 lần duy nhất khi mount
  // filtered là derived signal — tự track dependency
  const filtered = createMemo(() =>
    contracts.filter(c => c.name.includes(keyword()))
  );

  return (
    <div>
      {/* Chỉ input.value được update khi keyword thay đổi */}
      <input value={keyword()} onInput={e => setKeyword(e.target.value)} />
      {/* Chỉ table rows được update khi filtered thay đổi */}
      <Table data={filtered()} />
      {/* Pagination không chạy lại khi keyword thay đổi */}
      <Pagination page={page()} />
    </div>
  );
}
```

### Reactive graph — cơ chế dependency tracking

Solid dùng **synchronous reactive graph** được xây dựng lúc component mount:

```
Khi component function chạy lần đầu:
    ↓
Solid track mọi signal nào được đọc trong mỗi effect/memo
    → input.value đọc keyword() → tạo link: keyword → input.value
    → filtered đọc keyword() → tạo link: keyword → filtered
    → Table đọc filtered() → tạo link: filtered → Table rows
    → Pagination đọc page() → tạo link: page → Pagination

Khi keyword.set('new'):
    ↓
Solid traverse graph: ai subscribe keyword?
    → input.value node → update trực tiếp input.value attribute
    → filtered memo → recompute → ai subscribe filtered?
        → Table rows → update chỉ những row thay đổi
    (page và Pagination không liên quan → không chạy)
```

### Solid compiles JSX khác React

```tsx
// JSX này:
<div class="list">
  <span>{count()}</span>
</div>

// React compile thành:
React.createElement('div', { className: 'list' },
  React.createElement('span', null, count())
)
// → vDOM object, recreated mỗi render

// Solid compile thành (roughly):
const _el = document.createElement('div');
_el.className = 'list';
const _span = document.createElement('span');
_el.appendChild(_span);
createEffect(() => {
  _span.textContent = count();  // ← chỉ textContent update, không có vDOM
});
return _el;
// → real DOM node, effect track count() và update trực tiếp
```

---

## 4. So sánh thực tế — Benchmark và trade-offs

### Performance benchmark (js-framework-benchmark)

Trong các benchmark chuẩn (js-framework-benchmark của Stefan Krause):

| Framework | Geomean score | Notes |
|---|---|---|
| Vanilla JS | ~1.0 (baseline) | Raw DOM manipulation |
| SolidJS | ~1.08–1.12 | Gần baseline nhất trong các framework |
| Svelte | ~1.15–1.20 | Compile-time approach |
| Vue 3 | ~1.25–1.35 | Proxy-based reactivity |
| React 18 | ~1.55–1.70 | vDOM overhead |
| React + Compiler | ~1.25–1.40 | Thu hẹp gap đáng kể |

> **Lưu ý**: Benchmark đo throughput cực đoan (10k rows, massive update). Trong app thực tế với vài trăm nodes, sự khác biệt thường không cảm nhận được bằng mắt thường.

### Memory footprint

```
React:   Component tree + vDOM tree (2 copies of structure at all times)
         + Fiber nodes + work-in-progress tree during reconciliation

SolidJS: Component tree (1 copy) + reactive graph (signal nodes + subscribers)
         Không giữ vDOM → memory thấp hơn đáng kể với tree lớn
```

### Bundle size (minified + gzipped)

```
React + ReactDOM: ~45KB
SolidJS:          ~7KB
Vue 3:            ~22KB
Svelte:           ~2KB (runtime nhỏ, compile nhiều hơn)
```

---

## 5. Điểm SolidJS thua React

### 5.1 Ecosystem gap — vẫn rất lớn

```
React component libraries:  MUI, Ant Design, Chakra, shadcn/ui, Radix...
SolidJS component libraries: solid-ui (cộng đồng nhỏ hơn nhiều)

React meta-frameworks: Next.js (dominant), Remix, Gatsby...
SolidJS meta-frameworks: SolidStart (đang phát triển, chưa stable như Next.js)

React Native: ✅ Mobile apps từ React codebase
SolidJS Native: ❌ Không tồn tại
```

### 5.2 Mental model khó hơn

React `useState` trực quan — developer mới học được ngay:

```tsx
const [count, setCount] = useState(0);
// "count là số, setCount để thay đổi nó" → xong
```

Solid signals cần hiểu **tại sao phải gọi như function**:

```tsx
const [count, setCount] = createSignal(0);
count   // ← đây là function, không phải số!
count() // ← mới là số — và việc gọi này tạo dependency tracking
```

Lỗi phổ biến của người mới học Solid:

```tsx
// BUG — destructure mất reactivity
const { name } = props;
return <div>{name}</div>;  // name không reactive nữa

// CORRECT
return <div>{props.name}</div>;  // props.name là getter, reactive

// BUG — đọc signal ngoài reactive context
const val = count();  // đọc ở top-level → không track
createEffect(() => {
  console.log(count()); // ← đúng, trong reactive context
});
```

### 5.3 Stale closure không tồn tại trong Solid — nhưng có vấn đề khác

React có stale closure bug:

```tsx
// React — stale closure
useEffect(() => {
  const interval = setInterval(() => {
    console.log(count); // ← luôn in giá trị cũ (stale closure)
  }, 1000);
  return () => clearInterval(interval);
}, []); // ← dependency array dễ quên
```

Solid không có stale closure, nhưng có **reactive context leak**:

```tsx
// Solid — đọc signal ngoài reactive scope → không reactive
const snapshot = count(); // giá trị tại thời điểm đọc, không update
setTimeout(() => {
  console.log(snapshot); // luôn in giá trị ban đầu
  console.log(count());  // ← đúng, đọc lại tại thời điểm này
}, 1000);
```

### 5.4 React Compiler thu hẹp gap

React Compiler (2024, formerly React Forget) tự động thêm `memo`, `useMemo`, `useCallback` ở compile time:

```tsx
// Developer viết:
function App() {
  const [count, setCount] = useState(0);
  const doubled = count * 2;  // không cần useMemo
  return <Child value={doubled} />;  // không cần memo(Child)
}

// Compiler tạo ra roughly:
function App() {
  const [count, setCount] = useState(0);
  const doubled = useMemo(() => count * 2, [count]);
  return <MemoizedChild value={doubled} />;
}
```

Với React Compiler, nhiều overhead của vDOM được loại bỏ tự động — developer không cần viết tối ưu thủ công.

---

## 6. Khi nào chọn SolidJS vs React

### Chọn SolidJS khi:
- App performance-critical, nhiều real-time update (dashboard, trading UI, data visualization)
- Bundle size là ưu tiên (mobile web, slow networks)
- Team đã quen với reactive programming (RxJS, Svelte experience)
- Greenfield project không cần tái sử dụng React ecosystem

### Chọn React khi:
- Cần large ecosystem (component libs, integrations)
- Team lớn, mix seniority — React dễ onboard hơn
- Cần React Native cho mobile
- Dùng Next.js cho SSR/SSG — Next.js là best-in-class
- App không có performance bottleneck rõ ràng

### Trong bối cảnh PDMS (banking enterprise):
React hoặc Angular phù hợp hơn vì:
- Component library enterprise (Ant Design, Kendo UI) mature hơn trên React/Angular
- Team size lớn → React dễ maintain hơn
- Angular nếu cần DI system, typed forms, opinionated structure
- SolidJS hấp dẫn về mặt kỹ thuật nhưng ecosystem risk cao cho banking system

---

## 7. Tóm tắt — Bảng so sánh toàn diện

| | SolidJS | React 18 | React + Compiler |
|---|---|---|---|
| Runtime perf | ✅✅ Tốt nhất | ✅ Tốt | ✅✅ Gần Solid |
| Memory | ✅✅ Thấp nhất | ✅ Trung bình | ✅ Trung bình |
| Bundle size | ✅✅ ~7KB | ❌ ~45KB | ❌ ~45KB |
| Mental model | ❌ Khó hơn | ✅ Đơn giản | ✅ Đơn giản |
| Ecosystem | ❌ Nhỏ | ✅✅ Áp đảo | ✅✅ Áp đảo |
| SSR | ✅ SolidStart | ✅✅ Next.js | ✅✅ Next.js |
| Mobile | ❌ | ✅✅ React Native | ✅✅ React Native |
| Stale closure | ✅ Không có | ❌ Có | ✅ Compiler fixes |
| DevTools | ✅ Có | ✅✅ Mature | ✅✅ Mature |
| Production risk | ⚠️ Nhỏ hơn | ✅ Battle-tested | ✅ Battle-tested |

> **Kết luận**: SolidJS là framework được thiết kế tốt hơn về mặt kỹ thuật cho reactivity. React là framework thực tế hơn cho hầu hết production use case nhờ ecosystem. Với React Compiler, gap kỹ thuật đang thu hẹp nhanh.

---

## Related

- [[Angular-Latest-Series/24-Two-Way-Binding-Internals]]
- [[Angular-Latest-Series/08-Signals-The-Modern-Reactivity]]
- [[Angular-Latest-Series/15-Change-Detection-and-OnPush]]
- [[SolidJS-Series/SolidJS-01-Reactivity-Internals]]
- [[SolidJS-Series/SolidJS-02-Signals-Deep-Dive]]
- [[React-Latest-Series/11-Performance-Optimization]]
- [[React-Latest-Series/12-Concurrent-Features]]
