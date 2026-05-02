---
tags: [concepts, architecture, clean-architecture, hexagonal, ddd, evergreen]
created: 2026-05-02
difficulty: intermediate
estimated-read: 25 min
links: [ddd-strategic, ddd-tactical, solid-principles-deep-dive]
---

# 🏛️ Clean Architecture & Hexagonal Architecture — Xây dựng System "Sống" được lâu dài

> **Mục tiêu:** Hiểu tại sao "architecture" không phải là folder structure mà là về **dependency direction** — và cách áp dụng vào Spring Boot / PDMS.

---

## 🎯 Vấn đề mà Clean Architecture giải quyết

```
Project sau 2 năm bảo trì:
├── controller/
│   └── OrderController.java    // HTTP + Business logic + DB query mixed
├── service/
│   └── OrderService.java       // Contains Hibernate entity, Kafka call, HTTP call
└── repository/
    └── OrderRepository.java    // JPA + business validation mixed

Vấn đề:
- Muốn test OrderService.java → cần database, Kafka, HTTP server
- Muốn đổi từ Kafka → RabbitMQ → sửa 20 files
- Muốn đổi từ REST → gRPC → sửa business logic
- Business rule nằm ở controller, service, AND repository → không biết đâu để sửa

→ "Accidental Complexity" lấn át "Essential Complexity"
```

---

## 📐 The Dependency Rule — Luật vàng

```
                    ┌─────────────────────────────────────┐
                    │                                     │
                    │   ┌─────────────────────────────┐   │
                    │   │                             │   │
                    │   │   ┌─────────────────────┐   │   │
                    │   │   │                     │   │   │
                    │   │   │   ┌─────────────┐   │   │   │
                    │   │   │   │  ENTITIES   │   │   │   │
                    │   │   │   │ (Enterprise │   │   │   │
                    │   │   │   │  Business   │   │   │   │
                    │   │   │   │   Rules)    │   │   │   │
                    │   │   │   └─────────────┘   │   │   │
                    │   │   │   USE CASES         │   │   │
                    │   │   │   (Application      │   │   │
                    │   │   │   Business Rules)   │   │   │
                    │   │   └─────────────────────┘   │   │
                    │   │   INTERFACE ADAPTERS        │   │
                    │   │   (Controllers, Presenters, │   │
                    │   │    Gateways)                │   │
                    │   └─────────────────────────────┘   │
                    │   FRAMEWORKS & DRIVERS              │
                    │   (Spring, Hibernate, Kafka,        │
                    │    React, PostgreSQL)               │
                    └─────────────────────────────────────┘

Dependency Rule: Dependencies ONLY point INWARD
→ Entities know NOTHING about Use Cases
→ Use Cases know NOTHING about Controllers or DB
→ Infrastructure adapts to Domain, not vice versa
```

---

## 🔌 Hexagonal Architecture (Ports & Adapters)

Hexagonal là implementation cụ thể của Clean Architecture concept.

```
                         ┌─────────────────────────────────────┐
                         │                                     │
     REST API ──────►    │    PORT (Input)                     │
     gRPC     ──────►    │       │                             │
     CLI      ──────►    │       ▼                             │
     Tests    ──────►    │  ┌─────────────────────────────┐    │
                         │  │     APPLICATION CORE        │    │
                         │  │                             │    │
                         │  │   Domain Entities           │    │
                         │  │   Domain Services           │    │
                         │  │   Use Cases                 │    │
                         │  │                             │    │
                         │  └──────────────┬──────────────┘    │
                         │                 │                   │
                         │    PORT (Output)│                   │
                         │                 ▼                   │
                         │         ◄── PostgreSQL Adapter      │
                         │         ◄── Kafka Adapter           │
                         │         ◄── Email Adapter           │
                         │         ◄── HTTP Client Adapter     │
                         └─────────────────────────────────────┘

Ports = Interfaces (Java interfaces, Rust traits)
Adapters = Implementations (Spring repositories, Kafka producers)
```

**Ưu điểm:**
- Swap PostgreSQL → MongoDB: chỉ thay Adapter, Core không thay đổi
- Test Core: inject mock adapters, no real DB/Kafka needed
- Multiple input ports: REST, gRPC, CLI cùng một Core

---

## 📁 Folder Structure — Spring Boot Example

```
src/main/java/com/pdms/
├── domain/                         ← INNERMOST (no Spring, no JPA)
│   ├── model/
│   │   ├── Document.java           ← Pure Java class (Entity)
│   │   ├── DocumentStatus.java     ← Enum (Value Object)
│   │   └── DocumentId.java         ← Value Object
│   ├── repository/
│   │   └── DocumentRepository.java ← Interface (Output Port)
│   ├── service/
│   │   └── DocumentDomainService.java ← Domain logic
│   └── event/
│       └── DocumentApprovedEvent.java ← Domain Event
│
├── application/                    ← USE CASES (depends on domain only)
│   ├── port/
│   │   ├── in/
│   │   │   ├── ApproveDocumentUseCase.java  ← Input Port (interface)
│   │   │   └── SearchDocumentUseCase.java
│   │   └── out/
│   │       ├── LoadDocumentPort.java        ← Output Port
│   │       └── PublishEventPort.java
│   └── service/
│       └── ApproveDocumentService.java      ← Use Case Implementation
│
├── adapter/                        ← OUTERMOST
│   ├── in/
│   │   ├── rest/
│   │   │   └── DocumentController.java     ← REST Adapter (Input)
│   │   └── kafka/
│   │       └── DocumentEventConsumer.java   ← Kafka Input Adapter
│   └── out/
│       ├── persistence/
│       │   ├── DocumentJpaRepository.java   ← JPA (Output Adapter)
│       │   ├── DocumentPersistenceAdapter.java
│       │   └── DocumentJpaEntity.java       ← JPA Entity (NOT domain model)
│       ├── kafka/
│       │   └── KafkaEventPublishAdapter.java
│       └── http/
│           └── NotificationHttpAdapter.java
│
└── config/                         ← Spring config, beans wiring
    └── BeanConfig.java
```

---

## 💻 Code Example — PDMS Document Approval

### Domain Layer (Pure Java)

```java
// domain/model/Document.java — NO Spring, NO JPA annotations
public class Document {
    private final DocumentId id;
    private String borrowerName;
    private DocumentStatus status;
    private List<DomainEvent> domainEvents = new ArrayList<>();

    // Factory method (not constructor injection)
    public static Document create(DocumentId id, String borrowerName) {
        Document doc = new Document(id, borrowerName, DocumentStatus.PENDING);
        doc.domainEvents.add(new DocumentCreatedEvent(id));
        return doc;
    }

    // Business rule encapsulated HERE, not in service
    public void approve(String approverName) {
        if (this.status != DocumentStatus.PENDING) {
            throw new IllegalStateException("Only PENDING docs can be approved");
        }
        this.status = DocumentStatus.APPROVED;
        this.domainEvents.add(new DocumentApprovedEvent(id, approverName));
    }

    public List<DomainEvent> pullDomainEvents() {
        List<DomainEvent> events = new ArrayList<>(domainEvents);
        domainEvents.clear();
        return events;
    }
}
```

### Output Port (Interface in Domain)

```java
// domain/repository/DocumentRepository.java
public interface DocumentRepository {           // OUTPUT PORT
    Optional<Document> findById(DocumentId id);
    void save(Document document);
}

// application/port/out/PublishEventPort.java
public interface PublishEventPort {             // OUTPUT PORT
    void publish(DomainEvent event);
}
```

### Use Case (Application Layer)

```java
// application/service/ApproveDocumentService.java
@Service
@Transactional
public class ApproveDocumentService implements ApproveDocumentUseCase {

    private final DocumentRepository documentRepository; // interface!
    private final PublishEventPort eventPublisher;       // interface!

    public ApproveDocumentService(DocumentRepository repo,
                                  PublishEventPort publisher) {
        this.documentRepository = repo;
        this.eventPublisher = publisher;
    }

    @Override
    public void approve(ApproveDocumentCommand command) {
        Document document = documentRepository
            .findById(new DocumentId(command.documentId()))
            .orElseThrow(() -> new DocumentNotFoundException(command.documentId()));

        document.approve(command.approverName()); // business rule in domain

        documentRepository.save(document);

        document.pullDomainEvents()
                .forEach(eventPublisher::publish);
    }
}
```

### Adapter (Infrastructure)

```java
// adapter/out/persistence/DocumentPersistenceAdapter.java
@Component
public class DocumentPersistenceAdapter implements DocumentRepository { // implements Port

    private final DocumentJpaRepository jpaRepository;
    private final DocumentMapper mapper;

    @Override
    public Optional<Document> findById(DocumentId id) {
        return jpaRepository.findById(id.value())
                            .map(mapper::toDomain);   // JPA Entity → Domain Model
    }

    @Override
    public void save(Document document) {
        DocumentJpaEntity entity = mapper.toJpa(document);
        jpaRepository.save(entity);
    }
}

// adapter/out/persistence/DocumentJpaEntity.java — JPA annotation here, NOT in domain
@Entity
@Table(name = "documents")
public class DocumentJpaEntity {
    @Id private Long id;
    private String borrowerName;
    @Enumerated(EnumType.STRING)
    private String status;
    // JPA-specific fields: version, createdAt, etc.
    @Version private Long version;
}
```

---

## 🧪 Testing — Killer Feature

```java
// Test Use Case WITHOUT database or Kafka
@ExtendWith(MockitoExtension.class)
class ApproveDocumentServiceTest {

    @Mock
    DocumentRepository documentRepository; // mock the port

    @Mock
    PublishEventPort eventPublisher;       // mock the port

    @InjectMocks
    ApproveDocumentService service;

    @Test
    void approveDocument_whenPending_shouldPublishEvent() {
        // Arrange
        Document doc = Document.create(new DocumentId(1L), "Nguyen Van A");
        when(documentRepository.findById(any())).thenReturn(Optional.of(doc));

        // Act
        service.approve(new ApproveDocumentCommand(1L, "TrungManager"));

        // Assert
        verify(documentRepository).save(any());
        verify(eventPublisher).publish(any(DocumentApprovedEvent.class));
    }
    // No Spring context, no DB, no Kafka — runs in milliseconds!
}
```

---

## 🆚 So sánh với Layered Architecture

```
LAYERED (Truyền thống):              HEXAGONAL:
                                     
Controller                           REST Adapter ──────►
    │                                                     │
    ▼                                                 Application Core
Service                                                   │
    │                                                     ▼
    ▼                                JPA Adapter ◄──────
Repository                          Kafka Adapter ◄──────
    │
    ▼
Database

Dependencies in Layered:            Dependencies in Hexagonal:
Controller → Service → Repository   All → Application Core
Service depends on DB framework     Core depends on NOTHING external

Testing in Layered:                 Testing in Hexagonal:
Need DB to test Service             Mock adapters → test Core in isolation
```

---

## 💡 Tips & Tricks

> **Tip 1 — Domain Model ≠ JPA Entity**
> Sai lầm phổ biến nhất: dùng `@Entity` class làm Domain Model.
> JPA Entity cần: `@Entity`, no-args constructor, mutable fields, @Version
> Domain Model cần: immutable where possible, business methods, no annotations
> → Tạo 2 class khác nhau + Mapper ở giữa

> **Tip 2 — Don't be dogmatic**
> Clean Architecture là guidelines, không phải rules.
> Cho CRUD đơn giản: ok để skip some layers
> Cho complex business logic: enforce strictly
> "If the app is simple, don't over-engineer" — Uncle Bob himself

> **Tip 3 — Package by Feature, not Layer**
> ```
> // ❌ Package by layer (traditional)
> controller/DocumentController, OrderController
> service/DocumentService, OrderService
> 
> // ✅ Package by feature
> document/DocumentController, DocumentService, Document, DocumentRepository
> order/OrderController, OrderService, Order, OrderRepository
> ```
> Feature-based: easier to find, easier to delete/move a feature

> **Tip 4 — Spring integration**
> Spring DI wires adapters to ports at startup:
> `@Service` on Use Case class → Spring creates bean
> Constructor injection: Spring finds `DocumentPersistenceAdapter` implementing
> `DocumentRepository` → injects automatically
> No need for explicit `@Qualifier` if only 1 implementation

---

## 🔬 Case Studies

### Case Study 1: Netflix — Why They Use Hexagonal
```
Netflix cần support multiple databases per service:
→ Cassandra for high-volume reads
→ RocksDB for local cache
→ PostgreSQL for transactional writes

With Hexagonal: same Use Case, 3 different Repository adapters
Switch per config: dev=PostgreSQL, prod=Cassandra
No business logic change when adding new storage backend
```

### Case Study 2: PDMS Application
```
PDMS hiện tại:
Problem: DocumentService.java directly imports:
- javax.persistence (JPA)
- org.apache.kafka.clients (Kafka)
- org.springframework.web (HTTP)
→ Cannot test without full Spring context + DB + Kafka

Migration path (Strangler Fig):
1. Extract interfaces for Repository, EventPublisher
2. Move business rules from Service → Domain model methods
3. Rename JPA Entity → DocumentJpaEntity
4. Create DocumentPersistenceAdapter wrapping JpaRepository
5. Test: service test runs without @SpringBootTest

Phased approach: migrate 1 service at a time
Highest value first: the service with most business logic
```

### Case Study 3: Switching from Kafka to Pulsar
```
If PDMS ever needed to switch from Kafka to Apache Pulsar:

With traditional architecture:
→ Search/replace KafkaProducer, KafkaConsumer in 30 files
→ Risk: breaking business logic accidentally

With Hexagonal architecture:
→ Create new PulsarEventPublishAdapter implements PublishEventPort
→ Update Spring config to inject PulsarAdapter instead of KafkaAdapter
→ Zero changes to Domain or Application layers
→ A/B test: route some events to Pulsar, some to Kafka
```

---

## 📝 Key Takeaways

1. **Dependency Rule** = dependencies point INWARD (Domain ← Application ← Infrastructure)
2. **Domain layer** = pure Java/Kotlin, no framework annotations
3. **Ports** = interfaces (Input ports = use cases, Output ports = repositories/events)
4. **Adapters** = implementations of ports (JPA, Kafka, REST controllers)
5. **Domain Model ≠ JPA Entity** — luôn tách biệt, dùng Mapper
6. **Testing benefit** = test Use Cases với mock adapters, không cần DB/Kafka
7. **Package by feature** > package by layer
8. **Don't over-engineer** CRUD services — apply where business logic is complex

---

## 🔗 Liên kết

- [[ddd-strategic]] — Bounded Contexts kết hợp với Hexagonal per-service
- [[ddd-tactical]] — Aggregate, Entity, Value Object = Domain layer building blocks
- [[solid-principles-deep-dive]] — DIP (Dependency Inversion) là nền tảng của Hexagonal
- [[Microservices-Patterns/05-Decomposition]] — Modular decomposition
- [[MOC-System-Design]] — Architecture patterns overview
