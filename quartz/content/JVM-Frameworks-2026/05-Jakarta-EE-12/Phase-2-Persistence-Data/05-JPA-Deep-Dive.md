# 05 — Jakarta Persistence 4.0 (JPA)

> **Spec:** Jakarta Persistence 4.0 | **Profile:** Web Profile
> **Spring equivalent:** Spring Data JPA (abstraction trên spec này)
> **Prototype runtime:** Quarkus + Hibernate ORM 6.x

---

## 1. Spec Says

Jakarta Persistence định nghĩa ORM standard cho Java. Hibernate là reference implementation. Spring Data JPA chỉ là **convenience layer trên JPA** — hiểu JPA trực tiếp giúp anh debug sâu hơn và làm việc với các runtime không có Spring.

JPA 4.0 (EE 12) thêm:
- Record types làm embeddable
- Named queries với Records
- `EXTRACT` function chuẩn hóa trong JPQL
- Loại bỏ SecurityManager dependency

---

## 2. Entity Lifecycle

```
New (Transient)  →  [persist()]  →  Managed  →  [flush()]  →  DB synced
                                        │
                                  [detach()]
                                        ↓
                                    Detached  →  [merge()]  →  Managed
                                        │
                                  [remove()]
                                        ↓
                                    Removed   →  [flush()]  →  DB deleted
```

```java
@ApplicationScoped
public class DocumentRepository {

    @PersistenceContext
    EntityManager em;

    // New → Managed
    @Transactional
    public Document create(Document doc) {
        em.persist(doc);     // doc: New → Managed
        return doc;          // doc.id đã được populate sau persist
    }

    // Find → Managed (trong transaction)
    public Optional<Document> findById(String id) {
        Document doc = em.find(Document.class, id); // null nếu không tìm thấy
        return Optional.ofNullable(doc);
    }

    // Merge Detached entity
    @Transactional
    public Document update(Document detachedDoc) {
        return em.merge(detachedDoc); // Detached → Managed copy
        // LƯU Ý: merge() trả về managed instance, argument vẫn là detached!
    }

    // Remove
    @Transactional
    public void delete(String id) {
        Document doc = em.find(Document.class, id);
        if (doc != null) em.remove(doc); // phải là Managed instance
    }

    // getReference — proxy, không hit DB ngay
    @Transactional
    public void deleteById(String id) {
        Document ref = em.getReference(Document.class, id);
        em.remove(ref); // chỉ hit DB khi flush
    }
}
```

---

## 3. JPQL — Jakarta Persistence Query Language

```java
// === SPRING DATA ===
@Query("SELECT d FROM Document d WHERE d.tenantId = :tid AND d.status = :status")
List<Document> findByTenantAndStatus(@Param("tid") String tid,
                                     @Param("status") String status);

// === JPA DIRECT ===
public List<Document> findByTenantAndStatus(String tenantId, String status) {
    return em.createQuery(
        "SELECT d FROM Document d WHERE d.tenantId = :tid AND d.status = :status",
        Document.class)
        .setParameter("tid", tenantId)
        .setParameter("status", status)
        .getResultList();
}

// Named Query (khai báo trên entity)
@Entity
@NamedQueries({
    @NamedQuery(
        name = "Document.findByTenant",
        query = "SELECT d FROM Document d WHERE d.tenantId = :tid ORDER BY d.createdAt DESC"
    ),
    @NamedQuery(
        name = "Document.countByStatus",
        query = "SELECT COUNT(d) FROM Document d WHERE d.status = :status"
    )
})
public class Document { ... }

// Sử dụng Named Query
List<Document> docs = em.createNamedQuery("Document.findByTenant", Document.class)
    .setParameter("tid", tenantId)
    .setFirstResult(page * size)  // pagination
    .setMaxResults(size)
    .getResultList();
```

---

## 4. Criteria API — Type-Safe Dynamic Query

```java
// === Criteria API — dùng khi query có điều kiện động ===
public List<Document> search(DocumentFilter filter) {
    CriteriaBuilder cb = em.getCriteriaBuilder();
    CriteriaQuery<Document> cq = cb.createQuery(Document.class);
    Root<Document> root = cq.from(Document.class);

    List<Predicate> predicates = new ArrayList<>();

    if (filter.tenantId() != null) {
        predicates.add(cb.equal(root.get("tenantId"), filter.tenantId()));
    }
    if (filter.status() != null) {
        predicates.add(cb.equal(root.get("status"), filter.status()));
    }
    if (filter.titleKeyword() != null) {
        predicates.add(cb.like(
            cb.lower(root.get("title")),
            "%" + filter.titleKeyword().toLowerCase() + "%"
        ));
    }
    if (filter.fromDate() != null) {
        predicates.add(cb.greaterThanOrEqualTo(
            root.get("createdAt"), filter.fromDate()
        ));
    }

    cq.where(predicates.toArray(new Predicate[0]))
      .orderBy(cb.desc(root.get("createdAt")));

    return em.createQuery(cq)
        .setFirstResult(filter.page() * filter.size())
        .setMaxResults(filter.size())
        .getResultList();
}
```

---

## 5. Mapping Quan Hệ — Pitfalls

### 5.1 @OneToMany / @ManyToOne

```java
@Entity
public class Contract {
    @Id
    private String id;

    @OneToMany(
        mappedBy = "contract",      // field trong Document trỏ về Contract
        cascade = CascadeType.ALL,  // persist/remove lan sang Document
        fetch = FetchType.LAZY,     // QUAN TRỌNG: luôn LAZY cho collection
        orphanRemoval = true        // xóa Document khi remove khỏi collection
    )
    private List<Document> documents = new ArrayList<>();

    // Helper method để duy trì bidirectional consistency
    public void addDocument(Document doc) {
        documents.add(doc);
        doc.setContract(this);
    }
    public void removeDocument(Document doc) {
        documents.remove(doc);
        doc.setContract(null);
    }
}

@Entity
public class Document {
    @Id private String id;

    @ManyToOne(fetch = FetchType.LAZY) // LAZY cho @ManyToOne
    @JoinColumn(name = "contract_id")
    private Contract contract;
}
```

### 5.2 N+1 Problem & Fix

```java
// ❌ N+1: lấy 100 contracts → 100 query lấy documents
List<Contract> contracts = em.createQuery(
    "SELECT c FROM Contract c", Contract.class).getResultList();
contracts.forEach(c -> c.getDocuments().size()); // N+1!

// ✅ Fix 1: JOIN FETCH
List<Contract> contracts = em.createQuery(
    "SELECT DISTINCT c FROM Contract c LEFT JOIN FETCH c.documents", Contract.class)
    .getResultList();

// ✅ Fix 2: EntityGraph
EntityGraph<Contract> graph = em.createEntityGraph(Contract.class);
graph.addAttributeNodes("documents");

List<Contract> contracts = em.createQuery("SELECT c FROM Contract c", Contract.class)
    .setHint("jakarta.persistence.fetchgraph", graph)
    .getResultList();

// ✅ Fix 3: Named EntityGraph (trên entity)
@Entity
@NamedEntityGraph(
    name = "Contract.withDocuments",
    attributeNodes = @NamedAttributeNode("documents")
)
public class Contract { ... }
```

### 5.3 @Embeddable — Record Support (JPA 4.0)

```java
// JPA 4.0: Record làm @Embeddable
@Embeddable
public record Money(
    @Column(name = "amount") BigDecimal amount,
    @Column(name = "currency") @Size(max=3) String currency
) {}

@Entity
public class Contract {
    @Id String id;

    @Embedded
    private Money value;        // columns: amount, currency

    @AttributeOverrides({       // override column names nếu có nhiều Money
        @AttributeOverride(name = "amount",   column = @Column(name = "penalty_amount")),
        @AttributeOverride(name = "currency", column = @Column(name = "penalty_currency"))
    })
    @Embedded
    private Money penalty;
}
```

---

## 6. Locking — Quan Trọng Với Banking

```java
// Optimistic Locking — version-based
@Entity
public class Account {
    @Id String id;

    @Version            // JPA tự quản lý version
    private Long version;

    private BigDecimal balance;
}

// Khi update: JPA thêm WHERE version = :oldVersion
// Nếu version không khớp → OptimisticLockException

// Pessimistic Locking — SELECT FOR UPDATE
public Account lockAndLoad(String id) {
    return em.find(Account.class, id,
        LockModeType.PESSIMISTIC_WRITE);  // SELECT ... FOR UPDATE
}

// SELECT FOR UPDATE SKIP LOCKED (Hibernate extension)
public List<OutboxEvent> pollOutbox(int batch) {
    return em.createQuery("SELECT e FROM OutboxEvent e WHERE e.processed = false",
                           OutboxEvent.class)
        .setMaxResults(batch)
        .setHint("jakarta.persistence.lock.timeout",
                 LockModeType.PESSIMISTIC_WRITE)
        // Quarkus/Hibernate: setLockMode hoặc @QueryHint
        .setLockMode(LockModeType.PESSIMISTIC_WRITE)
        .getResultList();
}
```

---

## 7. Second-Level Cache (L2)

```java
// Enable L2 cache trên entity
@Entity
@Cacheable          // Jakarta Persistence annotation
@Cache(usage = CacheConcurrencyStrategy.READ_WRITE)  // Hibernate annotation
public class DocumentType {
    @Id String code;
    String displayName;
    // Reference data — ít thay đổi → ideal cho L2 cache
}

// Query cache
List<DocumentType> types = em.createQuery(
    "SELECT dt FROM DocumentType dt ORDER BY dt.displayName", DocumentType.class)
    .setHint("org.hibernate.cacheable", true)
    .setHint("org.hibernate.cacheRegion", "document-types")
    .getResultList();
```

---

## 8. Prototype — Contract Management

```java
// === Entities ===
@Entity @Table(name = "contracts")
@NamedEntityGraph(name = "Contract.full",
    attributeNodes = {
        @NamedAttributeNode("documents"),
        @NamedAttributeNode("parties")
    })
public class Contract {
    @Id
    @Column(length = 36)
    private String id;

    @NotBlank @Size(max = 200)
    @Column(nullable = false)
    private String title;

    @Embedded
    private Money value;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private ContractStatus status = ContractStatus.DRAFT;

    @Column(name = "tenant_id", nullable = false)
    private String tenantId;

    @OneToMany(mappedBy = "contract", cascade = ALL,
               fetch = LAZY, orphanRemoval = true)
    private List<Document> documents = new ArrayList<>();

    @Column(name = "created_at")
    private Instant createdAt;

    @Version
    private Long version;

    @PrePersist
    void prePersist() {
        id = UUID.randomUUID().toString();
        createdAt = Instant.now();
    }
}

public enum ContractStatus { DRAFT, ACTIVE, EXPIRED, TERMINATED }

// === Repository với EntityManager trực tiếp ===
@ApplicationScoped
public class ContractRepository {

    @PersistenceContext EntityManager em;

    @Transactional
    public Contract save(Contract c) {
        if (c.getId() == null) em.persist(c);
        else c = em.merge(c);
        return c;
    }

    public Optional<Contract> findById(String id) {
        return Optional.ofNullable(em.find(Contract.class, id));
    }

    public Optional<Contract> findByIdWithDocuments(String id) {
        EntityGraph<?> graph = em.getEntityGraph("Contract.full");
        return Optional.ofNullable(em.find(Contract.class, id,
            Map.of("jakarta.persistence.fetchgraph", graph)));
    }

    public List<Contract> findByTenant(String tenantId, int page, int size) {
        return em.createQuery(
            "SELECT c FROM Contract c WHERE c.tenantId = :tid ORDER BY c.createdAt DESC",
            Contract.class)
            .setParameter("tid", tenantId)
            .setFirstResult(page * size)
            .setMaxResults(size)
            .getResultList();
    }

    public long countByTenantAndStatus(String tenantId, ContractStatus status) {
        return em.createQuery(
            "SELECT COUNT(c) FROM Contract c WHERE c.tenantId = :tid AND c.status = :s",
            Long.class)
            .setParameter("tid", tenantId)
            .setParameter("s", status)
            .getSingleResult();
    }

    @Transactional
    public boolean updateStatus(String id, ContractStatus newStatus) {
        int updated = em.createQuery(
            "UPDATE Contract c SET c.status = :s WHERE c.id = :id")
            .setParameter("s", newStatus)
            .setParameter("id", id)
            .executeUpdate();
        return updated > 0;
    }
}
```

---

## 9. Architect Notes

**JPA 4.0 highlights cho PDMS:**
- Record làm `@Embeddable` → `Money(amount, currency)` gọn hơn nhiều
- `@Version` → optimistic locking cho contract/document update
- Pessimistic SKIP LOCKED → outbox polling pattern đang dùng
- EntityGraph → tránh N+1 khi load contract với documents

**Không nên dùng JPA cho:**
- Batch bulk insert/update hàng triệu rows → JDBC trực tiếp nhanh hơn nhiều
- Complex analytics query → native SQL rõ ràng hơn JPQL
- Time-series data → specialized store

---

*[[04-Bean-Validation]] | [[00-Overview]] | Next: [[06-Transactions]]*
