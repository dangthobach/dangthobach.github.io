---
tags: [concepts, ddd, architecture, aggregate, entity, value-object, evergreen]
created: 2026-05-02
difficulty: advanced
estimated-read: 25 min
links: [ddd-strategic, clean-architecture-hexagonal, consistency-models-spectrum]
---

# 🧩 DDD Tactical — Aggregate, Entity, Value Object, Domain Event

> **Mục tiêu:** Master các building blocks bên trong một Bounded Context — đặc biệt Aggregate là khái niệm khó nhất và quan trọng nhất.

---

## 🗺️ Tactical Design Building Blocks

```
┌─────────────────────────────────────────────────────────────────┐
│                    BOUNDED CONTEXT                              │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    AGGREGATE                            │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │              AGGREGATE ROOT (Entity)            │   │   │
│  │  │                                                 │   │   │
│  │  │  ┌──────────────┐    ┌──────────────────────┐   │   │   │
│  │  │  │    Entity    │    │    Value Object       │   │   │   │
│  │  │  │  (has ID,    │    │  (no ID, immutable,  │   │   │   │
│  │  │  │  lifecycle)  │    │   equality by value) │   │   │   │
│  │  │  └──────────────┘    └──────────────────────┘   │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │                                      │
│                          ▼                                      │
│              ┌───────────────────────┐                         │
│              │    Domain Event       │                         │
│              │  (something happened) │                         │
│              └───────────────────────┘                         │
│                                                                 │
│  ┌──────────────────────┐  ┌───────────────────────────────┐   │
│  │  Domain Service      │  │  Repository (interface)        │   │
│  │  (cross-aggregate    │  │  (aggregate root only)        │   │
│  │   business logic)    │  └───────────────────────────────┘   │
│  └──────────────────────┘                                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🆔 Entity vs Value Object

### Entity — Identity matters

```java
// Entity: hai object cùng data nhưng khác ID → khác nhau
public class LoanApplication {
    private final LoanApplicationId id; // identity
    private String borrowerName;
    private Money amount;
    private LoanApplicationStatus status;
    // Two LoanApplications with same borrower but different ID = DIFFERENT
}

LoanApplication app1 = new LoanApplication(id1, "Nguyen Van A", Money.of(100_000_000));
LoanApplication app2 = new LoanApplication(id2, "Nguyen Van A", Money.of(100_000_000));
app1.equals(app2); // FALSE — different IDs
```

### Value Object — Value matters, not identity

```java
// Value Object: 2 objects cùng value → bằng nhau
// IMMUTABLE — no setter
public final class Money {
    private final long amount;   // in VND cents
    private final String currency;

    private Money(long amount, String currency) {
        if (amount < 0) throw new IllegalArgumentException("Negative money");
        this.amount = amount;
        this.currency = currency;
    }

    public static Money of(long amount, String currency) {
        return new Money(amount, currency);
    }

    // Operations return NEW Money (immutable)
    public Money add(Money other) {
        if (!this.currency.equals(other.currency))
            throw new IllegalArgumentException("Currency mismatch");
        return new Money(this.amount + other.amount, this.currency);
    }

    @Override
    public boolean equals(Object o) {
        if (!(o instanceof Money m)) return false;
        return this.amount == m.amount && this.currency.equals(m.currency);
    }
}

Money m1 = Money.of(1_000_000, "VND");
Money m2 = Money.of(1_000_000, "VND");
m1.equals(m2); // TRUE — same value
```

**Value Object candidates:** Money, Address, Email, PhoneNumber, DateRange, Coordinates, Status, DocumentId (when used as reference).

---

## 🌳 Aggregate — Khái niệm quan trọng nhất

### Định nghĩa

```
Aggregate = cluster of Domain Objects (Entities + Value Objects)
            treated as a SINGLE UNIT for data changes

Aggregate Root = the ONLY entry point to the aggregate
                 External objects only hold reference to Root ID

Invariant = business rule that must ALWAYS be true within aggregate
```

### Aggregate Design Example — LoanApplication

```
Aggregate: LoanApplication
Root:      LoanApplication (id: LoanApplicationId)
Contains:  
  - Applicant (Entity — has life within application)
  - List<DocumentAttachment> (Entities)
  - List<ReviewComment> (Entities)
  - LoanTerms (Value Object)
  - Money requestedAmount (Value Object)

Invariant (business rules within aggregate):
1. Total attached documents must not exceed 50
2. Once APPROVED, no document can be added
3. Amount must be between 10M and 5B VND
4. Applicant must have at least 1 verified document
```

```java
// ✅ Aggregate Root enforces invariants
public class LoanApplication { // AGGREGATE ROOT

    private final LoanApplicationId id;
    private List<DocumentAttachment> attachments = new ArrayList<>();
    private LoanApplicationStatus status;
    private Money requestedAmount;

    // External code calls ROOT METHODS — never touches children directly
    public void attachDocument(DocumentAttachment doc) {
        // INVARIANT CHECK: root enforces rules
        if (this.status == LoanApplicationStatus.APPROVED) {
            throw new DomainException("Cannot attach document to approved application");
        }
        if (this.attachments.size() >= 50) {
            throw new DomainException("Maximum 50 documents per application");
        }
        this.attachments.add(doc);
        // Can raise domain event here
        this.registerEvent(new DocumentAttachedEvent(this.id, doc.getId()));
    }

    public void approve(ReviewerId reviewerId) {
        if (this.attachments.isEmpty()) {
            throw new DomainException("Cannot approve without documents");
        }
        if (this.status != LoanApplicationStatus.SUBMITTED) {
            throw new DomainException("Can only approve SUBMITTED applications");
        }
        this.status = LoanApplicationStatus.APPROVED;
        this.registerEvent(new LoanApplicationApprovedEvent(this.id, reviewerId));
    }
}

// ❌ WRONG: external code bypasses root
LoanApplication app = repo.findById(id);
app.getAttachments().add(new DocumentAttachment(...)); // bypasses invariant!
app.getAttachments().remove(0); // DANGEROUS

// ✅ CORRECT: always go through root
LoanApplication app = repo.findById(id);
app.attachDocument(new DocumentAttachment(...)); // enforces rules
```

---

## 📐 Aggregate Design Rules

### Rule 1: Small Aggregates

```
❌ Too large:
LoanApplication {
    List<Customer> allCustomers,          ← independent lifecycle
    List<Product> availableProducts,      ← different domain
    List<BranchOffice> branches,          ← completely different BC!
    List<LoanApplication> history,        ← infinite growth!
}

✅ Right size:
LoanApplication {
    LoanApplicationId id
    CustomerId borrowerId      ← ID reference, NOT Customer object!
    Money requestedAmount
    List<DocumentAttachment>   ← truly part of this application
    LoanApplicationStatus status
}

Customer aggregate is in ANOTHER aggregate, referenced by ID only
```

### Rule 2: Reference by ID across Aggregates

```java
// ❌ Wrong: aggregate holding another aggregate
public class LoanApplication {
    private Customer customer;  // loading entire Customer aggregate
    private BranchOffice branch; // another aggregate!
}

// ✅ Correct: reference by ID
public class LoanApplication {
    private CustomerId customerId;   // just the ID
    private BranchId branchId;       // just the ID
}

// When you need customer data: fetch separately
Customer customer = customerRepo.findById(application.getCustomerId());
```

### Rule 3: Aggregate Boundaries = Transaction Boundaries

```
One transaction = One aggregate change (ideally)

✅ Single transaction:
applicationRepo.save(loanApplication);  // one aggregate, one transaction

❌ Multi-aggregate transaction (smell):
// In one transaction:
loanApplication.approve();
customerAccount.debit();   // different aggregate!
// → Usually means wrong aggregate boundary design
// → Or need Saga pattern

Fix options:
1. Redesign: are LoanApplication and CustomerAccount the same aggregate?
   → Usually NO — different lifecycles, different teams
2. Use Saga: eventual consistency between aggregates
   → LoanApplication.approve() → event → CustomerAccount.debit()
```

---

## 📣 Domain Events

```java
// Domain Event: something that happened in the domain
// Immutable, past tense name, carries relevant data
public record LoanApplicationApprovedEvent(
    LoanApplicationId applicationId,
    CustomerId customerId,
    Money approvedAmount,
    LocalDateTime approvedAt,
    ReviewerId approvedBy
) implements DomainEvent {
    public LoanApplicationApprovedEvent {
        Objects.requireNonNull(applicationId);
        Objects.requireNonNull(customerId);
        Objects.requireNonNull(approvedAmount);
        if (approvedAt == null) approvedAt = LocalDateTime.now();
    }
}

// Aggregate collects events internally, publishes at end of transaction
public abstract class AggregateRoot {
    private final List<DomainEvent> domainEvents = new ArrayList<>();

    protected void registerEvent(DomainEvent event) {
        this.domainEvents.add(event);
    }

    public List<DomainEvent> pullDomainEvents() {
        List<DomainEvent> events = new ArrayList<>(this.domainEvents);
        this.domainEvents.clear();
        return events;
    }
}

// Application Service publishes after transaction commits
@Transactional
public void approveLoan(ApproveLoanCommand command) {
    LoanApplication app = repo.findById(command.applicationId());
    app.approve(command.reviewerId());
    repo.save(app);
    // After successful save, publish events
    app.pullDomainEvents().forEach(eventPublisher::publish);
}
```

---

## 🔧 Domain Service — Cross-Aggregate Logic

```java
// Domain Service: business logic that doesn't naturally fit in one aggregate
// Stateless, operates on aggregates

// Example: Credit scoring involves BOTH Customer and LoanApplication
public class CreditScoringService { // DOMAIN SERVICE

    public CreditScore calculate(Customer customer,
                                  LoanApplication application,
                                  CreditBureauData creditBureau) {
        // Logic that needs data from multiple aggregates
        // but the logic itself doesn't belong to either one
        int score = baseScore(creditBureau);
        score += employmentBonus(customer.getEmploymentStatus());
        score -= loanAmountPenalty(application.getRequestedAmount());
        return new CreditScore(score);
    }
}

// ❌ Wrong: put cross-aggregate logic in one of the aggregates
public class LoanApplication {
    public CreditScore calculateCreditScore(Customer customer) {
        // LoanApplication shouldn't know how to score a Customer
    }
}
```

---

## 🗄️ Repository — One per Aggregate Root

```java
// ONLY aggregate root has a Repository — never child entities!

// ✅ Correct: Repository for LoanApplication (root)
public interface LoanApplicationRepository {
    Optional<LoanApplication> findById(LoanApplicationId id);
    void save(LoanApplication application);
    Page<LoanApplication> findByCustomerId(CustomerId customerId, Pageable pageable);
}

// ❌ Wrong: Repository for child entity
public interface DocumentAttachmentRepository {
    // DocumentAttachment is part of LoanApplication aggregate
    // Don't create repo for it!
    void save(DocumentAttachment attachment);
}

// Accessing child: go through root
LoanApplication app = loanRepo.findById(id);
DocumentAttachment doc = app.getAttachments()
    .stream()
    .filter(d -> d.getId().equals(docId))
    .findFirst()
    .orElseThrow();
```

---

## 💡 Tips & Tricks

> **Tip 1 — Anemic Domain Model (Anti-pattern)**
> ```java
> // ❌ Anemic: model has no behavior, only getters/setters
> public class LoanApplication {
>     private LoanApplicationStatus status;
>     public void setStatus(LoanApplicationStatus s) { this.status = s; }
>     // No invariants, no business logic
> }
> // Service has ALL the logic:
> loanApp.setStatus(APPROVED); // no validation!
>
> // ✅ Rich Domain Model: behavior in the model
> public class LoanApplication {
>     public void approve(ReviewerId r) { /* enforces invariants */ }
> }
> ```

> **Tip 2 — Value Object vs Entity decision**
> Ask: "Would replacing this with same-valued new object change semantics?"
> Money($100) vs Money($100) → same → Value Object
> Document(id=5) vs Document(id=6) with same content → different → Entity

> **Tip 3 — Aggregates should be small (< 10 fields)**
> Large aggregates = concurrency conflicts (OptimisticLockException)
> Two users updating same aggregate → one fails, must retry
> Solution: split aggregate, use eventual consistency between them

> **Tip 4 — Use @Version for optimistic locking**
> ```java
> @Entity public class LoanApplication {
>     @Version private Long version; // JPA optimistic lock
>     // If two transactions update same row:
>     // Second commit → OptimisticLockException → must retry
> }
> ```

---

## 🔬 Case Studies

### Case Study 1: Order Aggregate Design — Amazon-style
```
Order Aggregate:
Root: Order { id, customerId, status }
Contains:
  - List<OrderItem> { productId, quantity, price }  ← items are part of order
  - ShippingAddress { street, city, ... }            ← Value Object
  - Payment { amount, method, transactionId }        ← Value Object (immutable after payment)

NOT in Order aggregate:
- Product { id, name, inventory }  ← separate aggregate, ref by productId
- Customer { id, name, email }     ← separate, ref by customerId
- Shipment { id, carrier, tracking } ← separate aggregate (different lifecycle)

Invariant: Order.totalAmount = sum(OrderItem.price × quantity)
            Enforced on every addItem() / removeItem() call
```

### Case Study 2: PDMS Document Aggregate
```java
// Document Aggregate Root
public class Document {
    private DocumentId id;
    private CustomerId customerId;       // reference by ID
    private WarehouseLocationId location; // reference by ID
    private List<Annotation> annotations; // part of this aggregate
    private DocumentStatus status;
    private AuditInfo auditInfo;          // Value Object

    public void approve(ApproverId approverId) {
        if (this.status != DocumentStatus.PENDING_REVIEW)
            throw new DomainException("Document not in review state");
        this.status = DocumentStatus.APPROVED;
        this.auditInfo = this.auditInfo.withApproval(approverId, LocalDateTime.now());
        this.registerEvent(new DocumentApprovedEvent(this.id, approverId));
    }

    public void addAnnotation(String content, UserId annotator) {
        if (this.status == DocumentStatus.ARCHIVED)
            throw new DomainException("Cannot annotate archived document");
        this.annotations.add(Annotation.create(content, annotator));
        // No event for annotation — not important enough
    }
}

// AuditInfo as Value Object (immutable)
public record AuditInfo(
    UserId createdBy, LocalDateTime createdAt,
    UserId lastModifiedBy, LocalDateTime lastModifiedAt,
    UserId approvedBy, LocalDateTime approvedAt
) {
    public AuditInfo withApproval(ApproverId approver, LocalDateTime at) {
        return new AuditInfo(createdBy, createdAt,
                            approver, at, approver, at);
    }
}
```

---

## 📝 Key Takeaways

1. **Entity** = has identity (ID), can change, equality by ID
2. **Value Object** = no ID, immutable, equality by value → prefer VO over Entity
3. **Aggregate** = unit of consistency, enforces business invariants
4. **Aggregate Root** = only entry point, external code holds root ID only
5. **Small aggregates** = less contention, less complexity
6. **Reference by ID** across aggregates, not direct reference
7. **Domain Event** = records something happened, triggers downstream actions
8. **Domain Service** = stateless logic spanning multiple aggregates
9. **Repository** = one per Aggregate Root only (not child entities)
10. **Anemic Domain Model** = anti-pattern (logic in services, model has no behavior)

---

## 🔗 Liên kết

- [[ddd-strategic]] — Bounded Context chứa các Aggregates này
- [[clean-architecture-hexagonal]] — Domain layer = Entities + VOs + Aggregates
- [[Microservices-Patterns/CQRS-Materialized-View]] — CQRS: separate read/write models
- [[Microservices-Patterns/Event-Sourcing]] — Domain Events → event log
- [[Microservices-Patterns/Saga-Pattern]] — Cross-aggregate consistency
- [[Database-Patterns/Hibernate-Performance-Deep-Dive]] — ORM mapping của Aggregates
