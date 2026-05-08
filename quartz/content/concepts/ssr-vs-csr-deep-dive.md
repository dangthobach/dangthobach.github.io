# SSR vs CSR — Cơ Chế Thực Sự, Workflow & Những Hiểu Lầm Phổ Biến

> **Tags:** #frontend #web-rendering #SSR #CSR #performance #architecture  
> **Related:** [[React-Internals]], [[Next.js-Patterns]], [[Web-Performance-Optimization]]

---

## 🗺️ Tổng Quan

Hai thuật ngữ **SSR (Server-Side Rendering)** và **CSR (Client-Side Rendering)** thường bị hiểu sai hoặc dùng lẫn lộn. Thực tế, chúng mô tả **nơi và khi nào** HTML được tạo ra — không chỉ đơn giản là "render ở server" hay "render ở browser".

```
Câu hỏi cốt lõi: "Tại thời điểm nào, và ở đâu, HTML được tạo ra?"
```

---

## 1. CSR — Client-Side Rendering

### 1.1 Cơ Chế Thực Sự

CSR là mô hình mà **browser tải về một HTML shell rỗng**, sau đó JavaScript chịu trách nhiệm fetch data và dựng toàn bộ DOM.

```mermaid
sequenceDiagram
    autonumber
    participant U as 👤 User Browser
    participant CDN as 📦 CDN / Static Host
    participant API as 🔌 API Server

    U->>CDN: GET / (request trang)
    CDN-->>U: index.html (shell rong ~1KB)
    Note over U: HTML chi co div id=root rong hoàn toàn

    U->>CDN: GET /bundle.js (~500KB-2MB)
    CDN-->>U: JavaScript bundle

    Note over U: JS parse & execute (2-5s trên mobile)

    U->>API: GET /api/user, /api/posts
    API-->>U: JSON data

    Note over U: React/Vue render DOM - Page visible & interactive
```

**Thực tế HTML server trả về:**
```html
<!-- Đây là toàn bộ HTML từ server trong CSR -->
<!DOCTYPE html>
<html>
  <head>
    <title>My App</title>
    <link rel="stylesheet" href="/main.css">
  </head>
  <body>
    <div id="root"></div>  <!-- ← RỖNG HOÀN TOÀN -->
    <script src="/bundle.js"></script>
  </body>
</html>
```

### 1.2 Timeline Thực Tế (CSR — Mobile 3G)

```mermaid
flowchart LR
    A["📡 TTFB\n~100ms\nHTML shell 1KB"] --> B["📦 JS Download\n~1400ms\nbundle 1MB"]
    B --> C["⚙️ JS Execute\n~1300ms\nparse + run"]
    C --> D["🌐 API Fetch\n~600ms\nJSON data"]
    D --> E["✅ FCP + TTI\n~3.5s total\npage interactive"]

    style A fill:#4ade80,color:#000
    style B fill:#f59e0b,color:#000
    style C fill:#ef4444,color:#fff
    style D fill:#f59e0b,color:#000
    style E fill:#3b82f6,color:#fff
```

**Metrics trong CSR:**
| Metric | Giá trị điển hình | Ý nghĩa |
|--------|------------------|---------|
| **TTFB** | ~50-200ms | Nhanh (chỉ trả HTML shell) |
| **FCP** | ~2-5s | Chậm (JS chưa chạy xong) |
| **TTI** | ~3-7s | Chậm nhất (phải hydrate xong) |
| **LCP** | ~3-6s | Thường là content cuối cùng load |

---

## 2. SSR — Server-Side Rendering

### 2.1 Cơ Chế Thực Sự

SSR là mô hình mà **server chạy JavaScript/Template engine**, tạo ra HTML đầy đủ content, rồi mới gửi về browser. Browser nhận được HTML **có thể đọc ngay** — nhưng chưa interactive cho đến khi **hydration** hoàn tất.

```mermaid
sequenceDiagram
    autonumber
    participant U as 👤 User Browser
    participant S as 🖥️ Next.js Server
    participant DB as 🗄️ Database / API

    U->>S: GET /products/123

    activate S
    S->>DB: SELECT * FROM products WHERE id=123
    DB-->>S: Product data (JSON)
    S->>S: React renderToString(ProductPage)
    Note over S: Server executes React code, generates full HTML
    S-->>U: Full HTML (~50KB, content-rich)
    deactivate S

    Note over U: FCP - User sees content IMMEDIATELY
    Note over U: (nhung cac button chua click duoc)

    U->>S: GET /bundle.js
    S-->>U: JavaScript bundle

    Note over U: Hydration - React attaches event listeners
    Note over U: TTI - Page fully interactive
```

**HTML server trả về trong SSR:**
```html
<!-- HTML đầy đủ content từ server -->
<!DOCTYPE html>
<html>
  <body>
    <div id="root">
      <!-- React đã render sẵn trên server -->
      <nav class="navbar">
        <a href="/">Home</a>
        <a href="/products">Products</a>
      </nav>
      <main>
        <h1>iPhone 15 Pro</h1>
        <p class="price">$999</p>
        <button data-reactroot="">Add to Cart</button>
        <!-- Button NHÌN thấy được nhưng chưa có event listener -->
      </main>
    </div>
    <script src="/bundle.js"></script>
  </body>
</html>
```

### 2.2 Hydration — Phần Hay Bị Bỏ Qua

> **Hydration** là quá trình React "tiếp quản" HTML tĩnh do server tạo ra, gắn event listeners và biến nó thành app động.

```mermaid
flowchart LR
    subgraph SERVER["🖥️ Server"]
        A["React Component\n(renderToString)"] --> B["Static HTML String\n(no interactivity)"]
    end

    subgraph BROWSER["🌐 Browser"]
        C["Receive HTML\nPaint immediately\nFCP done"] --> D["Download bundle.js"]
        D --> E["React.hydrate()\nMatch virtual DOM\nwith server HTML"]
        E --> F{"Mismatch?"}
        F -->|"Match OK"| G["Attach Event Listeners\nTTI done"]
        F -->|"Mismatch"| H["RE-RENDER entire tree\nHydration Error\nFlicker visible"]
    end

    B --> C

    style G fill:#4ade80,color:#000
    style H fill:#ef4444,color:#fff
```

**Hydration Mismatch — Bug phổ biến nhất:**
```jsx
// ❌ SAI — Date khác nhau giữa server và client
function Post() {
  return <span>Posted: {new Date().toLocaleString()}</span>
  // Server: "10:00 AM"  |  Client: "10:00:02 AM"  →  MISMATCH
}

// ✅ ĐÚNG — Dùng useEffect để render time chỉ ở client
function Post() {
  const [time, setTime] = useState(null)
  useEffect(() => setTime(new Date().toLocaleString()), [])
  return <span>Posted: {time ?? 'Loading...'}</span>
}
```

### 2.3 Timeline SSR (Mobile 3G)

```mermaid
flowchart LR
    A["🖥️ Server Work\n~400ms\nDB query + renderToString"] --> B["📡 Network\n~300ms\nFull HTML 50KB"]
    B --> C["🖼️ FCP\n~700ms\ncontent visible!"]
    C --> D["📦 JS Download\n~1300ms\nbundle 1MB"]
    D --> E["💧 Hydration\n~300ms\nattach events"]
    E --> F["✅ TTI\n~2.8s total\nfully interactive"]

    style A fill:#8b5cf6,color:#fff
    style C fill:#4ade80,color:#000
    style F fill:#3b82f6,color:#fff
```

---

## 3. So Sánh Trực Tiếp

```mermaid
flowchart TD
    subgraph FAST_TTFB["✅ Fast TTFB"]
        CSR_T["CSR\n(tiny HTML shell)"]
    end

    subgraph FAST_FCP["✅ Fast FCP"]
        SSR_F["SSR\n(full HTML from server)"]
        SSG_F["SSG\n(pre-built HTML)"]
    end

    subgraph GOOD_SEO["✅ Good SEO"]
        SSR_S["SSR"]
        SSG_S["SSG"]
        ISR_S["ISR"]
    end

    subgraph LOW_COST["✅ Low Server Cost"]
        CSR_C["CSR\n(CDN only)"]
        SSG_C["SSG\n(CDN only)"]
    end
```

| Tiêu chí | CSR | SSR |
|----------|-----|-----|
| **TTFB** | ✅ Nhanh (shell nhỏ) | ⚠️ Chậm hơn (server cần render) |
| **FCP** | ❌ Chậm | ✅ Nhanh |
| **TTI** | ❌ Chậm nhất | ⚠️ Vẫn cần hydration |
| **SEO** | ❌ Khó (Googlebot cần JS) | ✅ Tốt (HTML đầy đủ) |
| **Server Cost** | ✅ Thấp (static files) | ❌ Cao (CPU per request) |
| **Caching** | ✅ CDN cache toàn bộ | ⚠️ Phức tạp (vary by user) |
| **Real-time data** | ✅ Dễ (client fetch) | ⚠️ Cần revalidate |
| **UX sau load** | ✅ Mượt như app native | ✅ Tương đương |

---

## 4. Những Hiểu Lầm Phổ Biến ⚠️

### Misconception 1: "SSR thì không cần JavaScript ở client"
```
❌ SAI: SSR vẫn gửi JS bundle về client để hydration
✅ ĐÚNG: SSR giúp HTML render nhanh, nhưng JS vẫn cần thiết để interactive

Ngoại lệ: Server Components (React 18+) có thể THỰC SỰ 
không gửi JS về client cho những component thuần display.
```

### Misconception 2: "CSR thì xấu cho SEO hoàn toàn"
```
❌ SAI: Googlebot hiện tại CÓ THỂ execute JavaScript và index CSR apps
✅ ĐÚNG: 
  - Googlebot crawl CSR chậm hơn SSR (delayed indexing)
  - Social crawlers (Facebook, Twitter) KHÔNG chạy JS → no preview
  - SSR vẫn tốt hơn cho critical SEO pages
```

### Misconception 3: "SSR luôn nhanh hơn CSR"
```
❌ SAI: SSR có TTFB cao hơn (server cần xử lý trước khi trả HTML)
✅ ĐÚNG:
  - SSR nhanh hơn ở FCP và LCP (content visible sớm hơn)
  - CSR nhanh hơn ở TTFB và subsequent navigation
  - SSR có thể CHẬM hơn CSR nếu server bị overload
```

### Misconception 4: "Next.js = SSR"
```
❌ SAI: Next.js hỗ trợ nhiều rendering strategies
✅ ĐÚNG: Next.js có:
  - SSR: getServerSideProps (per request)
  - SSG: getStaticProps (build time)  
  - ISR: revalidate option (hybrid)
  - CSR: useEffect + SWR (pure client)
  - RSC: React Server Components (zero JS)
```

### Misconception 5: "Hydration là miễn phí (không có cost)"
```
❌ SAI: Hydration là expensive — phải chạy toàn bộ component tree
✅ ĐÚNG:
  - Page có thể NHÌN thấy nhưng KHÔNG tương tác được trong thời gian hydration
  - Giai đoạn này gọi là "uncanny valley" — user click nhưng không có gì xảy ra
  - React 18 giải quyết với Selective Hydration (ưu tiên component user interact)
```

---

## 5. Modern Rendering Patterns (Beyond SSR/CSR)

```mermaid
flowchart TD
    A["Rendering Strategy"] --> B["SSG\nStatic Site Gen"]
    A --> C["SSR\nServer-Side Render"]
    A --> D["CSR\nClient-Side Render"]
    A --> E["ISR\nIncremental Static Regen"]
    A --> F["RSC\nReact Server Components"]
    A --> G["Streaming SSR\nReact 18+"]

    B --> B1["Build time render\nBest: blogs, docs, marketing\nWorst: personalized content"]
    C --> C1["Per-request render\nBest: dashboards, auth pages\nWorst: high traffic, no cache"]
    D --> D1["Browser render\nBest: apps, admin panels\nWorst: SEO-critical, slow devices"]
    E --> E1["Stale-While-Revalidate\nBest: e-commerce, news\nWorst: real-time data"]
    F --> F1["Zero JS for server parts\nBest: data-heavy UIs\nWorst: highly interactive"]
    G --> G1["HTML streamed in chunks\nBest: slow data sources\nWorst: streaming not supported"]

    style B fill:#4ade80,color:#000
    style C fill:#60a5fa,color:#000
    style D fill:#f59e0b,color:#000
    style E fill:#a78bfa,color:#000
    style F fill:#f472b6,color:#000
    style G fill:#34d399,color:#000
```

### Streaming SSR (React 18) — Game Changer

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as Next.js Server
    participant DB as Database

    B->>S: GET /dashboard

    S-->>B: HTTP stream bat dau
    S-->>B: html + head + Navbar sent immediately

    par Parallel Data Fetching
        S->>DB: Query user stats (slow: 800ms)
        S->>DB: Query recent orders (fast: 100ms)
    end

    S-->>B: RecentOrders chunk at 100ms
    Note over B: User thay orders ngay lap tuc

    S-->>B: UserStats chunk at 800ms
    Note over B: Stats xuat hien sau, khong block gi ca
```

---

## 6. Decision Tree — Chọn Strategy Nào?

```mermaid
flowchart TD
    Start(["Trang web cua ban la?"]) --> Q1{"Can SEO khong?"}

    Q1 -->|"Khong"| Q2{"Admin panel\nhoac app phuc tap?"}
    Q1 -->|"Co"| Q3{"Data thay doi\nthuong xuyen?"}

    Q2 -->|"Co"| CSR["CSR\nReact SPA / Vite"]
    Q2 -->|"Khong"| Q3

    Q3 -->|"Khong - data static"| SSG["SSG\nNext.js getStaticProps"]
    Q3 -->|"Thinh thoang"| ISR["ISR\nNext.js revalidate"]
    Q3 -->|"Moi request"| Q4{"Personalized\nper user?"}

    Q4 -->|"Co"| SSR["SSR\nNext.js getServerSideProps"]
    Q4 -->|"Khong - chung"| ISR

    style CSR fill:#f59e0b,color:#000
    style SSG fill:#4ade80,color:#000
    style ISR fill:#a78bfa,color:#000
    style SSR fill:#60a5fa,color:#000
```

---

## 7. Use Cases Thực Tế

### Nên dùng CSR khi:
```
✅ Dashboard nội bộ (không cần SEO)
✅ Admin panels, CRM systems
✅ Apps cần real-time updates liên tục (trading, chat)
✅ PWA (Progressive Web App)
✅ Sau login — personalized content không cache được
```

### Nên dùng SSR khi:
```
✅ E-commerce product pages (SEO critical + fresh price/stock)
✅ News articles, blog posts (SEO + fresh content)
✅ Social media feeds (personalized + SEO share preview)
✅ Landing pages cần fast FCP trên mobile
✅ Pages cần Open Graph tags chính xác (Facebook/Twitter preview)
```

### Nên dùng SSG/ISR khi:
```
✅ Marketing sites, landing pages (cực ít thay đổi)
✅ Documentation (Docusaurus, VitePress)
✅ Blog với nhiều bài (Gatsby)
✅ E-commerce catalog (ISR — revalidate mỗi 60s)
```

---

## 8. Core Web Vitals & Rendering Impact

| Strategy | LCP | FID | CLS | Overall Score |
|----------|-----|-----|-----|---------------|
| CSR | ❌ Poor | ✅ Good | ✅ Good | ~40/100 |
| CSR + Code Split | ⚠️ Needs Improvement | ✅ Good | ✅ Good | ~60/100 |
| SSR | ✅ Good | ⚠️ Needs Improvement | ✅ Good | ~78/100 |
| SSG | ✅ Excellent | ✅ Good | ✅ Good | ~95/100 |
| ISR | ✅ Excellent | ✅ Good | ✅ Good | ~88/100 |

---

## 📝 Summary

```
CSR:      Browser làm tất cả → Fast TTFB, Slow FCP, Bad SEO, Low server cost
SSR:      Server render HTML  → Slow TTFB, Fast FCP, Good SEO, High server cost
SSG:      Build-time render   → Fastest everything, Bad for dynamic content
ISR:      SSG + auto revalidate → Best of SSG + fresh data
RSC:      Zero client JS for server parts → Future of SSR
Streaming: HTML in chunks → Eliminates blocking, best UX
```

---

*Created: 2026-05-08*  
*Source: MDN Web Docs, web.dev, Next.js Documentation, React 18 RFC*
