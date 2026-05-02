---
tags: [concepts, ddd, architecture, domain-driven-design, bounded-context, evergreen]
created: 2026-05-02
difficulty: advanced
estimated-read: 25 min
links: [clean-architecture-hexagonal, ddd-tactical, consistency-models-spectrum]
---

# 🗺️ DDD Strategic — Bounded Contexts, Context Maps & Ubiquitous Language

> **Mục tiêu:** Hiểu cách DDD giúp decompose một hệ thống phức tạp thành các phần có ranh giới rõ ràng — nền tảng cho microservices đúng nghĩa.

---

## 🎯 DDD là gì và khi nào áp dụng?

```
DDD phù hợp khi:
✅ Complex domain (banking, healthcare, logistics, ERP)
✅ Team size > 5-6 engineers
✅ Domain experts có thể tham gia modeling
✅ Hệ thống sẽ sống > 3 năm

DDD KHÔNG phù hợp khi:
❌ CRUD simple (blog, content management)
❌ Data pipeline / ETL (no complex business rules)
❌ MVP cần ship nhanh
❌ Team không có domain expertise
```

---

## 🌐 Ubiquitous Language — Ngôn ngữ chung

**Vấn đề thực tế:**
```
Business analyst nói: "Customer loan application"
Developer code:       Customer, LoanRequest, ApplicationForm
Database:             tbl_user_credit, loan_app, form_data
API:                  /users/{id}/applications, /loan/create

4 cách gọi cho cùng 1 khái niệm → chaos khi maintain
```

**Ubiquitous Language = mọi người dùng CÙNG một từ:**
```
Word: "Hồ sơ vay" → mapped everywhere

Business:    "Hồ sơ vay"
Domain Model: class HoSoVay (hoặc LoanApplication trong English codebase)
Database:    table loan_applications
API:         /loan-applications
Event:       LoanApplicationSubmittedEvent
Kafka topic: loan-application-events
Test:        "Given a LoanApplication in PENDING state..."
```

**Tip:** Khi developer và business dùng khác từ → phát hiện gap trong understanding → dừng lại và align.

---

## 📦 Bounded Context — Ranh giới nhận thức

**Core concept:** Một model domain chỉ valid TRONG một boundary (Bounded Context).

```
Ví dụ: Khái niệm "Customer" trong 2 contexts KHÁC NHAU:

┌─────────────────────────────────────────────────────┐
│         LOAN APPLICATION Context                    │
│                                                     │
│  Customer {                                         │
│    customerId,                                      │
│    nationalId (required!),                          │
│    creditScore,                                     │
│    monthlyIncome,                                   │
│    employmentStatus                                 │
│  }                                                  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│         DOCUMENT MANAGEMENT Context (PDMS)          │
│                                                     │
│  Customer {                                         │
│    customerId,                                      │
│    displayName,        ← different fields!         │
│    documentCount,                                   │
│    lastVisitDate                                    │
│  }                                                  │
└─────────────────────────────────────────────────────┘

Same "Customer" word → COMPLETELY different models
→ DON'T share 1 Customer class across both contexts
→ Each context has its OWN Customer representation
```

---

## 🗺️ Context Map — Quan hệ giữa các Bounded Contexts

### Các loại quan hệ

```
┌──────────────────────────────────────────────────────────────────┐
│                    CONTEXT MAP PATTERNS                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. PARTNERSHIP — 2 teams collaborate, mutual dependency         │
│     TeamA ←──────────────────► TeamB                            │
│     High communication, both adjust together                     │
│                                                                  │
│  2. SHARED KERNEL — shared code/model subset                     │
│     Context A ──► [SHARED] ◄── Context B                        │
│     Risk: changes affect both, needs coordination                │
│                                                                  │
│  3. CUSTOMER-SUPPLIER — upstream/downstream relationship         │
│     Upstream [U] ──────────────────► Downstream [D]              │
│     D requests features from U, U has the power                  │
│                                                                  │
│  4. CONFORMIST — downstream conforms to upstream                 │
│     Upstream (third party) ──────────────► Our system            │
│     We can't change upstream → must adapt to their model         │
│     Example: Integrating with VPBank core banking API            │
│                                                                  │
│  5. ANTI-CORRUPTION LAYER (ACL) — translation layer              │
│     External System ──► [ACL Translator] ──► Our Domain         │
│     Protect our domain model from upstream's messy model         │
│                                                                  │
│  6. OPEN HOST SERVICE (OHS) — public API with protocol           │
│     Context ──► [Published API/Events] ──► Multiple consumers   │
│                                                                  │
│  7. SEPARATE WAYS — no integration, solve independently          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Context Map Diagram — VPBank Example

```
┌─────────────────────────────────────────────────────────────────┐
│                 VPBank Domain Map                               │
│                                                                 │
│  ┌──────────────┐  Customer-Supplier  ┌──────────────────────┐  │
│  │   Core       │──────────────────►  │   Loan Origination   │  │
│  │   Banking    │                     │     System           │  │
│  │  (Upstream)  │     ACL             └──────────┬───────────┘  │
│  │              │◄─ ─ ─ ─ ─ ─ ─ ─ ─             │              │
│  └──────────────┘                    Customer-Supplier          │
│          │                                       │              │
│     OHS  │ (Events)                             ▼              │
│          ▼                           ┌─────────────────────┐   │
│  ┌──────────────────┐                │       PDMS          │   │
│  │   Notification   │ ◄──────────── │  (Document Mgmt)    │   │
│  │     Service      │  OHS (Events) │   (Downstream)      │   │
│  └──────────────────┘                └─────────────────────┘   │
│                                                                 │
│  ┌──────────────────┐  Conformist    ┌─────────────────────┐   │
│  │   Credit Bureau  │──────────────► │  Credit Scoring     │   │
│  │   (External)     │   (ACL needed) │     Service         │   │
│  └──────────────────┘                └─────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🧩 Strategic Design — How to Find Bounded Contexts

### Technique 1: Event Storming

```
Room full of sticky notes:

ORANGE: Domain Events (things that happened)
  "LoanApplicationSubmitted"
  "DocumentUploaded"
  "CreditScoreCalculated"
  "LoanApproved"
  "DocumentArchived"

BLUE: Commands (actions triggering events)
  "SubmitLoanApplication" → "LoanApplicationSubmitted"
  "UploadDocument"        → "DocumentUploaded"

GREEN: Aggregates (where commands happen)
  Aggregate: LoanApplication (handles Submit, Approve)
  Aggregate: Document (handles Upload, Archive)

PURPLE: Policies (reaction to events)
  When LoanApproved → trigger "SendApprovalNotification"

Cluster related events → candidate Bounded Contexts!
```

### Technique 2: Look for Language Shifts

```
Conversation:
"When a loan is APPROVED..."
"...the customer needs to sign the CONTRACT..."
"...and DOCUMENTS are submitted to the ARCHIVE..."

Words shift: loan → contract → documents → archive
Each shift = potential Bounded Context boundary!

Contexts identified:
1. Loan Origination Context: loan, application, approval
2. Contract Context: contract, signing, terms
3. Document Management Context: documents, archive (= PDMS!)
```

---

## 🔌 Context Integration Patterns

### Pattern 1: API Call (Synchronous)

```
Loan Service ──────► HTTP GET /documents/{customerId}/count ──────► PDMS

Use when:
→ Need response immediately
→ Acceptable coupling between services
→ PDMS failure = Loan Service failure

Risk: Distributed monolith if overused
```

### Pattern 2: Domain Events (Asynchronous)

```
PDMS ──► DocumentApprovedEvent ──► Kafka ──► Loan Service

Use when:
→ Eventual consistency acceptable
→ Services should be decoupled
→ PDMS failure ≠ Loan Service failure

Risk: Eventual consistency complexity
```

### Pattern 3: Anti-Corruption Layer (ACL)

```
External Core Banking (legacy model):
{
  "CUST_ID": "12345",
  "CUST_TYPE_CD": "I",          ← cryptic codes
  "LOAN_APPL_AMT": "1000000",
  "LOAN_APPL_DT": "20260502"    ← format YYYYMMDD
}

ACL Translation in PDMS:
class CoreBankingAdapter {
    Customer translate(CoreBankingCustomerDto legacy) {
        return new Customer(
            CustomerId.of(legacy.getCustId()),
            legacy.getCustTypeCd().equals("I")
                ? CustomerType.INDIVIDUAL : CustomerType.CORPORATE,
            Money.of(Long.parseLong(legacy.getLoanApplAmt()), "VND"),
            LocalDate.parse(legacy.getLoanApplDt(),
                           DateTimeFormatter.ofPattern("yyyyMMdd"))
        );
    }
}

→ Domain model của PDMS never sees the legacy model
→ Change in Core Banking API → only update ACL, not domain
```

---

## 📏 Heuristics — How large should a Bounded Context be?

```
Too large (Monolith symptoms):
→ "Everything is connected" — can't change X without breaking Y
→ Database has 200+ tables all in one schema
→ Same team works on everything → bottleneck

Too small (Micro-service hell):
→ Simple business operation requires 5+ service calls
→ Team manages 20 services for 5 engineers
→ Distributed monolith: services are coupled anyway

Right size signals:
✅ Team owns it entirely (2-pizza team)
✅ Independent deployable without coordinating other teams
✅ Has a clear, stable bounded language
✅ Database schema could be separate if needed
✅ Business capability is cohesive

Rule of thumb:
Bounded Context ≈ 1 subdomain ≈ 1 microservice (but not always!)
```

---

## 💡 Tips & Tricks

> **Tip 1 — Shared Kernel là technical debt**
> Shared Kernel có vẻ tiết kiệm code nhưng tạo coupling ẩn.
> Thay vì: `common-lib/Customer.java` shared across 5 services
> Dùng: mỗi service định nghĩa Customer của nó, copy data theo events
> "A little duplication is better than wrong abstraction" — Sandi Metz

> **Tip 2 — Generic Subdomain vs Core Domain**
> Core Domain: nơi competitive advantage → DDD đầy đủ, best developers
> Supporting Subdomain: cần nhưng không tạo advantage → buy or simple design
> Generic Subdomain: common need → buy off-the-shelf (email, auth, payments)
>
> PDMS context: Document Management = Supporting Subdomain for VPBank
> → Full DDD overkill → pragmatic design đủ

> **Tip 3 — Context Map là living document**
> Vẽ Context Map TRƯỚC KHI code, update khi domain evolves.
> Tool gợi ý: draw.io / Miro / Context Mapper (code-based)
> Đưa vào ADR khi thêm integration mới giữa contexts

> **Tip 4 — Database per Bounded Context**
> Mỗi BC có schema riêng (hoặc DB riêng trong microservices)
> Không JOIN across BC schemas → use ACL + events
> OK để có "redundant" data in different contexts

---

## 🔬 Case Studies

### Case Study 1: Amazon — Many Bounded Contexts
```
Amazon Product Page tổng hợp data từ NHIỀU BCs:
- Catalog BC: product name, description, images
- Pricing BC: price, discounts, promotions
- Inventory BC: stock availability, warehouse
- Review BC: ratings, customer reviews
- Recommendation BC: "customers also bought"

Each BC: separate team, separate DB, separate deployment
Page assembly: API composition at the edge (BFF pattern)
→ Changing review algorithm: zero impact on catalog
→ Catalog outage: price/inventory still works
```

### Case Study 2: PDMS — Identifying BCs
```
PDMS Event Storming results:

Domain Events found:
"DocumentReceived", "DocumentIndexed", "DocumentApproved",
"WarehouseLocationAssigned", "DocumentArchived",
"CustomerProfileUpdated", "ReportGenerated"

Language shifts:
- "Document" context: received, indexed, approved
- "Warehouse" context: location, slot, physical storage
- "Customer Profile" context: profile, KYC data
- "Reporting" context: reports, analytics

Candidate BCs:
1. Document Management BC (core)
2. Physical Warehouse BC (PDMS tích hợp cụ thể)
3. Customer Profile BC (data from Core Banking)
4. Reporting & Analytics BC

→ Current monolithic PDMS → decompose over time using Strangler Fig
```

### Case Study 3: Event Storming Reveals Gaps
```
During Event Storming for PDMS:
Team discovered: "DocumentApproved" → NOTHING HAPPENS (in code)
But business expected: automatic notification to branch officer

Discovery method: Event gap
→ "DocumentApproved" but no Command follows
→ Missing policy: "When DocumentApproved → NotifyBranchOfficer"
→ Found missing feature BEFORE coding, not after

Value: Event Storming surfaces hidden requirements
```

---

## 📝 Key Takeaways

1. **Ubiquitous Language** = same words used by ALL (business, code, DB, tests)
2. **Bounded Context** = boundary where a model is valid and consistent
3. **Same word, different context = different model** (Customer in Loan ≠ Customer in PDMS)
4. **Context Map** = visualize relationships between BCs (partnership, customer-supplier, ACL)
5. **ACL** = protect your domain from external messy models
6. **Event Storming** = collaborative technique to find BC boundaries
7. **Right size** = team can own it entirely, independent deployment
8. **Database per BC** = no cross-BC JOINs, use events for data sharing

---

## 🔗 Liên kết

- [[ddd-tactical]] — Aggregate, Entity, Value Object bên trong Bounded Context
- [[clean-architecture-hexagonal]] — Hexagonal architecture within a Bounded Context
- [[Microservices-Patterns/05-Decomposition]] — DDD Bounded Context → microservice decomposition
- [[Microservices-Patterns/Event-Sourcing]] — Events crossing BC boundaries
- [[Microservices-Patterns/PDMS-Architecture-Overview]] — PDMS context mapping
- [[MOC-System-Design]] — Architecture overview
