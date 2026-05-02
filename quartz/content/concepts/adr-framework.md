# ADR — Architecture Decision Records

---
tags: [architecture, documentation, decision-making, team-process]
created: 2026-05-02
difficulty: beginner
estimated-read: 12 min
links: [[clean-architecture-hexagonal]], [[ddd-strategic]], [[testing-strategy-pyramid]]

---

## 🎯 Learning Objectives

Sau bài này bạn sẽ:
- Hiểu **tại sao** ADR tồn tại và vấn đề nó giải quyết
- Viết được ADR chất lượng cao theo chuẩn
- Tích hợp ADR vào workflow team
- Có bộ template sẵn dùng cho PDMS

---

## 🤔 Vấn đề ADR Giải Quyết

### "Tại sao code này lại như vậy?"

Mỗi codebase đều có những quyết định bí ẩn:

```
// TODO: Tại sao không dùng Redis ở đây mà lại dùng PostgreSQL counter?
// Người viết: Bach, 2025-03-15
// ... người viết đã nghỉ việc
```

6 tháng sau, developer mới đến, thấy code "kỳ lạ", refactor sang Redis. 2 tuần sau: **production incident** vì bank không chấp nhận duplicate warehouse code.

**Vấn đề gốc:** Quyết định kiến trúc được ghi trong đầu người, không phải trong code.

```
┌──────────────────────────────────────────────────────────┐
│           Knowledge Loss Timeline                         │
│                                                           │
│  Quyết định ──► Email thread (lost in inbox)             │
│             ──► Meeting notes (never saved)              │
│             ──► Slack message (scrolled away)            │
│             ──► Jira comment (deleted with ticket)       │
│                                                           │
│  6 tháng sau: "Tại sao code này như vậy?"                │
│  "Ai biết không?" → Silence                              │
└──────────────────────────────────────────────────────────┘
```

### ADR = Architecture Decision Record

**Ghi lại quyết định kiến trúc** cùng với:
- **Context** — tại sao đây là vấn đề cần quyết định
- **Các lựa chọn** đã cân nhắc
- **Quyết định** được chọn và lý do
- **Hậu quả** — đánh đổi, trade-off

---

## 📝 Cấu Trúc ADR Chuẩn (Michael Nygard Format)

```markdown
# ADR-[NUMBER]: [Title — ngắn gọn, dùng động từ]

**Date:** YYYY-MM-DD  
**Status:** [Proposed | Accepted | Deprecated | Superseded by ADR-XXX]  
**Deciders:** [Tên người quyết định]

## Context

[Mô tả vấn đề, tại sao cần quyết định này ngay bây giờ.
Viết ở present tense. Không phán xét.]

## Decision Drivers

- [Yếu tố ảnh hưởng đến quyết định]
- [Constraints, requirements, concerns]

## Considered Options

1. [Option A]
2. [Option B]  
3. [Option C — Do nothing]

## Decision Outcome

**Chosen option:** [Option X], vì [justification ngắn gọn].

### Consequences

**Positive:**
- [Lợi ích cụ thể]

**Negative (trade-offs):**
- [Đánh đổi phải chấp nhận]

**Risks:**
- [Rủi ro cần monitor]

## Pros and Cons of Options

### Option A — [Tên]
**Pros:**
- [+] ...
**Cons:**
- [-] ...

### Option B — [Tên]
...
```

---

## 🏆 ADR Thực Tế — PDMS Examples

### ADR-001: Warehouse Code Generation Strategy

```markdown
# ADR-001: Warehouse Code Generation — PostgreSQL Counter vs Redis INCR

**Date:** 2025-03-15  
**Status:** Accepted  
**Deciders:** Bach (Arch), Minh (DBA), Lan (QA)

## Context

PDMS cần tạo unique warehouse codes (e.g., WH-2025-00001) cho physical
document boxes. Yêu cầu: unique, sequential, không có gap trong audit trail,
concurrent safe với 50+ users tạo cùng lúc.

## Decision Drivers

- Banking requirement: NO duplicate codes allowed (audit compliance)
- Concurrent users: 50+ simultaneous warehouse creation
- System boundary: PostgreSQL already in stack, Redis optional
- Recovery: system restart không được tạo duplicate

## Considered Options

1. PostgreSQL sequence + counter table (ON CONFLICT DO UPDATE)
2. Redis INCR command
3. UUID (non-sequential)
4. Application-level lock (Java synchronized)

## Decision Outcome

**Chosen option: Option 1 — PostgreSQL counter table**

Lý do: Banking context yêu cầu ACID guarantee. Redis INCR là atomic
nhưng không transactional với PostgreSQL — crash sau khi INCR nhưng trước
khi INSERT document sẽ tạo gap, không comply với banking audit trail.

### Consequences

**Positive:**
- ACID guaranteed — no duplicate, no gap under any failure scenario
- Single source of truth (DB, không cần sync Redis ↔ DB)
- Simpler ops — không cần Redis cho feature này

**Negative:**
- Counter table là hot spot: single row bị lock nhiều
- Throughput: ~500 TPS (đủ cho PDMS, expected ~50 concurrent)

**Risks:**
- Nếu scale lên >1000 TPS: cần revisit (xem ADR-005)

## Implementation

```sql
CREATE TABLE warehouse_code_counter (
    prefix VARCHAR(20) PRIMARY KEY,
    current_value BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Atomic increment + return
UPDATE warehouse_code_counter
SET current_value = current_value + 1, updated_at = NOW()
WHERE prefix = 'WH-2025'
RETURNING current_value;
```
```

---

### ADR-002: Authorization Source Migration

```markdown
# ADR-002: Authorization Data Source Migration — pdms-service to pdms-iam-service

**Date:** 2025-08-20  
**Status:** Accepted  
**Deciders:** Bach, Hùng (PM), Linh (Security Lead)

## Context

Hiện tại pdms-service chứa cả business logic VÀ authorization logic.
Khi onboard tenant mới (VPBank branch mới), phải deploy lại pdms-service.
Security team yêu cầu centralized audit log cho all authz decisions.

## Decision Outcome

**Chosen option:** Extract authz logic to pdms-iam-service, 
pdms-service calls pdms-iam-service via internal API.

**Migration strategy:** Strangler Fig — dual-write period 4 weeks,
feature flag `iam.source=pdms-iam` via ConfigMap, rollback < 5 minutes.
```

---

## 📁 Tổ Chức ADR Trong Dự Án

### Cấu trúc file

```
docs/
└── decisions/
    ├── README.md              ← Index of all ADRs
    ├── ADR-001-warehouse-code.md
    ├── ADR-002-authz-migration.md
    ├── ADR-003-kafka-vs-rabbitmq.md
    └── ADR-004-connection-pool.md
```

### Trong Obsidian vault

```
_decisions/
├── PDMS/
│   ├── ADR-001-warehouse-code.md
│   └── ADR-002-authz-migration.md
└── Platform/
    ├── ADR-003-database-selection.md
    └── ADR-004-message-broker.md
```

---

## 🔄 ADR Lifecycle & Status

```
┌────────────┐     review      ┌────────────┐
│  Proposed  │ ──────────────► │  Accepted  │
└────────────┘                 └────────────┘
                                      │
                              new decision
                                      │
                                      ▼
                               ┌────────────┐      ┌────────────┐
                               │  Deprecated│      │ Superseded │
                               │ (no longer │      │ by ADR-XXX │
                               │ relevant)  │      └────────────┘
                               └────────────┘
```

**Status giải thích:**
- **Proposed** — đang discuss, chưa finalize
- **Accepted** — quyết định chính thức
- **Deprecated** — context đã thay đổi, quyết định không còn áp dụng nhưng giữ lại vì historical record
- **Superseded** — bị thay thế bởi ADR mới (link đến ADR mới)

> ⚠️ **Quan trọng:** **Không bao giờ xóa ADR cũ**. Sửa status thành Deprecated/Superseded. ADR là historical record.

---

## ✅ Checklist — ADR Chất Lượng Cao

```
□ Title bắt đầu bằng động từ: "Use X", "Adopt Y", "Migrate Z"
□ Context viết ở present tense, không có opinion
□ Ít nhất 3 options được cân nhắc (kể cả "do nothing")  
□ Decision outcome clear và có justification
□ Consequences có cả positive VÀ negative
□ Risks được identify
□ Date và deciders được ghi rõ
□ Status luôn được update
□ Link đến ADR liên quan nếu có
```

---

## 💡 Tips & Best Practices

| Do ✅ | Don't ❌ |
|-------|---------|
| Viết ADR **tại thời điểm quyết định** | Viết ADR retroactively sau 6 tháng |
| Ngắn gọn — 1-2 trang là đủ | Viết essay dài dòng |
| Context objective, không phán xét | "Cái này rõ ràng là tệt nhất..." |
| Include "do nothing" option | Chỉ liệt kê option mình thích |
| Review ADR khi context thay đổi | Để ADR cũ mà không update status |
| Store cùng code (git) | Store trong wiki không ai đọc |

---

## 🔑 Key Takeaways

1. ADR giải quyết **"tại sao"** — code giải thích **"cái gì"**, ADR giải thích **"vì sao"**
2. Format đơn giản nhất vẫn tốt hơn không có ADR nào
3. **Không xóa ADR** — Deprecated/Superseded là trạng thái hợp lệ
4. ADR hiệu quả nhất khi viết **tại thời điểm quyết định**, không phải sau
5. Luôn có ít nhất **3 options** — kể cả "không làm gì"
6. Store trong git cùng code — ADR sẽ được review cùng Pull Request
7. PDMS context: mỗi major architectural choice nên có ADR tương ứng

---

## 🔗 Related Links

- [[clean-architecture-hexagonal]] — ADR cho architectural patterns
- [[ddd-strategic]] — ADR cho Bounded Context decisions
- [[consensus-raft-paxos]] — Ví dụ ADR về distributed coordination choice
- [Michael Nygard's original post](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [adr-tools CLI](https://github.com/npryce/adr-tools) — generate ADR từ command line
