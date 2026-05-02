# Concepts — Atomic Knowledge Notes

Thư mục này chứa **atomic concept notes** — mỗi file = 1 concept.

**Quy tắc:**
- Flat hoàn toàn, không có subfolder
- Tên file = tên concept (e.g., `Arc-T.md`, `Transactional-Outbox.md`)
- Dùng tags để phân loại: `#rust`, `#java`, `#pattern`, `#evergreen`
- Dùng wikilinks để kết nối, không dùng folder để phân loại

**Tags chuẩn:**
- `#rust` / `#java` / `#postgresql` — language/tech
- `#concurrency` / `#distributed` / `#memory` — domain
- `#evergreen` — note đã mature, ít cần edit
- `#wip` — đang viết dở
- `#pdms` — liên quan trực tiếp đến dự án

---

## 📑 Index

### ⚡ Reactive & Async
| Note                                  | Tags                        | Liên kết chính                |
| ------------------------------------- | --------------------------- | ----------------------------- |
| [[reactive-programming-fundamentals]] | java, reactive, concurrency | Mutiny, RxJava, Reactor       |
| [[event-loop-model]]                  | java, reactive, vertx       | Vert.x, WebFlux, Quarkus      |
| [[backpressure-explained]]            | java, reactive, rxjava      | RxJava Flowable, Mutiny Multi |

### 🏗️ DI & Build
| Note | Tags | Liên kết chính |
|------|------|----------------|
| [[compile-time-vs-runtime-di]] | java, di, quarkus, micronaut | ArC, Micronaut IoC, Spring IoC |
| [[native-image-aot-jit]] | java, quarkus, graalvm, native | GraalVM, Quarkus Native |

---

## 📥 Để thêm note mới
1. Dùng template: `_templates/template-concept.md`
2. Tên file: `kebab-case.md`
3. Thêm vào bảng Index ở trên
4. Link vào MOC tương ứng
