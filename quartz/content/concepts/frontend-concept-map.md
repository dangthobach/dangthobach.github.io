---
type: moc
domain: frontend
status: active
created: 2026-07-24
updated: 2026-07-24
tags: [frontend, reactivity, routing, forms, state-management, ssr, performance, moc]
---

# Frontend Concept Map

> Bản đồ nối các learning series với concept dùng chung. Nội dung chi tiết vẫn nằm trong từng article gốc.

```mermaid
flowchart LR
    C["Concept dùng chung"] --> A["Angular"]
    C --> R["React"]
    C --> S["SolidJS"]
    C --> C1["Reactivity"]
    C --> C2["Routing & layout"]
    C --> C3["Forms & validation"]
    C --> C4["State management"]
    C --> C5["SSR & hydration"]
    C --> C6["Performance"]
```

## Reactivity

- [[concepts/reactive-programming-fundamentals|Reactive programming fundamentals]]
- [[concepts/data-binding-one-way-vs-two-way|One-way vs two-way data binding]]
- [[concepts/SolidJS-vs-React-Reactivity-Model|SolidJS vs React reactivity]]
- [[Angular-Latest-Series/08-Signals-The-Modern-Reactivity|Angular Signals]]
- [[React-Latest-Series/25-vDOM-vs-SolidJS-Reactivity|React vDOM vs SolidJS]]
- [[SolidJS-Series/SolidJS-01-Reactivity-Internals|SolidJS reactivity internals]]

## Routing và layout

- [[Angular-Latest-Series/22-Routing-Layout-SearchState|Angular routing, layout, search state]]
- [[React-Latest-Series/23-Routing-Layout-SearchState|React routing, layout, search state]]
- [[SolidJS-Series/SolidJS-13-Routing-Layout-SearchState|SolidJS routing, layout, search state]]

## Forms và validation

- [[Angular-Latest-Series/09-Reactive-Forms-Mastery|Angular reactive forms]]
- [[React-Latest-Series/21-Multi-Step-Forms-Complex-Validation|React complex forms]]
- [[Rust-Zero-To-Hero/Bai-43-Form-Validation|Rust full-stack form validation]]

## State management

- [[Angular-Latest-Series/16-NgRx-State-Management|Angular NgRx]]
- [[React-Latest-Series/17-Zustand-State-Management|React Zustand]]
- [[SolidJS-Series/SolidJS-06-Stores-Nested-State|SolidJS stores]]

## SSR, hydration và rendering

- [[concepts/ssr-vs-csr-deep-dive|SSR vs CSR]]
- [[Angular-Latest-Series/20-Lazy-Loading-and-Code-Splitting|Angular lazy loading]]
- [[React-Latest-Series/13-React-Server-Components-and-NextJS-Intro|React Server Components]]
- [[SolidJS-Series/SolidJS-11-SolidStart-SSR|SolidStart SSR]]

## Performance

- [[concepts/React-Compiler-Internals-Memoization|React Compiler internals]]
- [[Angular-Latest-Series/15-Change-Detection-and-OnPush|Angular change detection]]
- [[React-Latest-Series/11-Performance-Optimization|React performance]]
- [[SolidJS-Series/SolidJS-12-Performance-Testing|SolidJS performance testing]]

