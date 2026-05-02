---
tags: [concepts, testing, quality, tdd, architecture, evergreen]
created: 2026-05-02
difficulty: intermediate
estimated-read: 20 min
links: [clean-architecture-hexagonal, ddd-tactical]
---

# 🧪 Testing Strategy Pyramid — Viết Test đúng, Đủ, Có giá trị

> **Mục tiêu:** Hiểu tại sao "nhiều test ≠ tốt hơn" và cách phân bổ effort đúng theo Testing Pyramid. Áp dụng trực tiếp vào Spring Boot / PDMS context.

---

## 🎯 Tại sao Testing Strategy quan trọng?

```
Dự án không có strategy thường rơi vào 1 trong 2 anti-pattern:

Anti-pattern 1: Ice Cream Cone (ngược kim tự tháp)
    ████████████████████████  ← Manual testing (slow, expensive)
        ████████████          ← Integration tests (slow, brittle)
            ████              ← Unit tests (few, fast)

Kết quả: Test suite chạy 45 phút, fail vì timing issue,
         developer skip tests vì "mất quá nhiều thời gian"

Anti-pattern 2: No Test / Chaos
→ Deploy và pray
→ Khách hàng là QA team
```

---

## 🏗️ The Testing Pyramid

```
                        ▲
                       ╱E╲        E2E / UI Tests
                      ╱   ╲       (5-10%)
                     ╱─────╲      Selenium, Playwright
                    ╱  Integ╲     Integration Tests
                   ╱─────────╲    (15-25%)
                  ╱           ╲   Spring @SpringBootTest
                 ╱   U N I T   ╲  Unit Tests (70-80%)
                ╱───────────────╲ JUnit5, Mockito
                ─────────────────

Speed:    Unit=ms  | Integration=seconds | E2E=minutes
Cost:     Unit=$   | Integration=$$      | E2E=$$$
Feedback: Unit=instant | Integration=fast | E2E=slow
```

### Layer 1 — Unit Tests (Đáy kim tự tháp, nhiều nhất)

```
ĐỊNH NGHĨA: Test 1 class/function trong isolation
            Dependencies = mocked
            No Spring context, no DB, no network

TARGET: Domain logic, Business rules, Utility classes
```

```java
// Unit test: DocumentApprovalService
// NO @SpringBootTest, runs in <10ms
@ExtendWith(MockitoExtension.class)
class DocumentApprovalServiceTest {

    @Mock DocumentRepository repo;          // mocked — no DB
    @Mock EventPublisher eventPublisher;    // mocked — no Kafka
    @InjectMocks DocumentApprovalService service;

    @Test
    void approve_whenDocumentPending_shouldChangeStatusAndPublishEvent() {
        // ARRANGE
        Document doc = Document.create(DocumentId.of(1L), "Nguyen Van A");
        when(repo.findById(DocumentId.of(1L))).thenReturn(Optional.of(doc));

        // ACT
        service.approve(new ApproveDocumentCommand(1L, "TrungManager"));

        // ASSERT
        ArgumentCaptor<Document> savedDoc = ArgumentCaptor.forClass(Document.class);
        verify(repo).save(savedDoc.capture());
        assertThat(savedDoc.getValue().getStatus()).isEqualTo(APPROVED);
        verify(eventPublisher).publish(any(DocumentApprovedEvent.class));
    }

    @Test
    void approve_whenDocumentNotPending_shouldThrowException() {
        Document doc = Document.create(DocumentId.of(1L), "Nguyen Van A");
        doc.approve("someone"); // already approved
        when(repo.findById(any())).thenReturn(Optional.of(doc));

        // ACT + ASSERT
        assertThatThrownBy(() -> service.approve(new ApproveDocumentCommand(1L, "Other")))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("Only PENDING");
    }
}

// Domain model unit test — even faster, no mocks needed
class DocumentTest {
    @Test
    void approve_whenAlreadyApproved_shouldThrow() {
        Document doc = Document.create(DocumentId.of(1L), "test");
        doc.approve("first-approver");

        assertThatThrownBy(() -> doc.approve("second-approver"))
            .isInstanceOf(IllegalStateException.class);
    }
}
```

### Layer 2 — Integration Tests (Giữa)

```
ĐỊNH NGHĨA: Test multiple components together
            Real DB (Testcontainers), real message broker
            Spring context loaded (subset)

TARGET: Repository + DB, REST adapter + serialization,
        Kafka producer/consumer, Cache behavior
```

```java
// Integration test: Repository layer with real PostgreSQL
@DataJpaTest                    // loads only JPA layer
@AutoConfigureTestDatabase(replace = NONE) // don't replace with H2
@Testcontainers
class DocumentRepositoryTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16")
        .withDatabaseName("pdms_test")
        .withUsername("test")
        .withPassword("test");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", postgres::getJdbcUrl);
        r.add("spring.datasource.username", postgres::getUsername);
        r.add("spring.datasource.password", postgres::getPassword);
    }

    @Autowired DocumentJpaRepository repo;

    @Test
    void findByCustomerId_shouldReturnAllDocumentsForCustomer() {
        // ARRANGE: insert test data
        repo.saveAll(List.of(
            new DocumentJpaEntity(null, "CUST-001", "PENDING"),
            new DocumentJpaEntity(null, "CUST-001", "APPROVED"),
            new DocumentJpaEntity(null, "CUST-002", "PENDING")
        ));

        // ACT
        List<DocumentJpaEntity> results = repo.findByCustomerId("CUST-001");

        // ASSERT
        assertThat(results).hasSize(2);
        assertThat(results).allMatch(d -> d.getCustomerId().equals("CUST-001"));
    }
}

// Integration test: REST endpoint
@WebMvcTest(DocumentController.class)   // loads only Web layer
class DocumentControllerTest {

    @Autowired MockMvc mvc;
    @MockBean DocumentQueryService service;  // mock the service

    @Test
    void getDocument_shouldReturn200WithDocumentJson() throws Exception {
        when(service.findById(1L)).thenReturn(Optional.of(
            new DocumentDto(1L, "CUST-001", "APPROVED")));

        mvc.perform(get("/api/documents/1")
                .accept(APPLICATION_JSON))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.id").value(1))
            .andExpect(jsonPath("$.status").value("APPROVED"));
    }

    @Test
    void getDocument_whenNotFound_shouldReturn404() throws Exception {
        when(service.findById(99L)).thenReturn(Optional.empty());

        mvc.perform(get("/api/documents/99"))
            .andExpect(status().isNotFound());
    }
}
```

### Layer 3 — E2E Tests (Đỉnh, ít nhất)

```
ĐỊNH NGHĨA: Test toàn bộ system từ UI/API đến DB
            Real running application
            Test user journeys, not individual units

TARGET: Critical user flows (login → approve document → view result)
```

```java
// E2E test: Full approval flow
@SpringBootTest(webEnvironment = RANDOM_PORT)
@Testcontainers
class DocumentApprovalE2ETest {

    @Container static PostgreSQLContainer<?> postgres = ...;
    @Container static KafkaContainer kafka = ...;

    @LocalServerPort int port;

    @Test
    void completeApprovalFlow_shouldEndWithApprovedDocumentAndEvent() {
        RestAssured.port = port;

        // Step 1: Authenticate
        String token = given()
            .body(new LoginRequest("manager", "password"))
            .post("/api/auth/login")
            .then().extract().path("access_token");

        // Step 2: Create document
        Long docId = given()
            .header("Authorization", "Bearer " + token)
            .body(new CreateDocumentRequest("CUST-001", ...))
            .post("/api/documents")
            .then().extract().<Integer>path("id").longValue();

        // Step 3: Approve document
        given()
            .header("Authorization", "Bearer " + token)
            .post("/api/documents/{id}/approve", docId)
            .then().statusCode(200);

        // Step 4: Verify final state
        given()
            .get("/api/documents/{id}", docId)
            .then()
            .body("status", equalTo("APPROVED"));

        // Step 5: Verify Kafka event published
        // (consume from Kafka topic and verify)
        ...
    }
}
```

---

## 🔬 Test Doubles — Đúng loại cho đúng mục đích

```
STUB:    Returns hardcoded value, doesn't verify calls
         Use: when you need predictable data, don't care how it's used

MOCK:    Verify interactions (was method called? with what args?)
         Use: when behavior (side effects) matters more than return value

FAKE:    Working implementation, simpler than real (e.g., in-memory DB)
         Use: when you need realistic behavior but not full complexity

SPY:     Wrap real object, can verify calls on it
         Use: when you want real behavior but need to verify calls

┌────────────────────────────────────────────────────────┐
│  Mockito quick reference:                              │
│                                                        │
│  Mock:    @Mock, verify(mock).method()                 │
│  Stub:    when(mock.method()).thenReturn(value)         │
│  Spy:     @Spy, calls real methods unless stubbed      │
│  Capture: ArgumentCaptor.forClass(X.class)             │
└────────────────────────────────────────────────────────┘
```

---

## 🧩 Test Patterns

### Pattern 1: Given-When-Then (Arrange-Act-Assert)

```java
@Test
void calculateCreditScore_withHighIncome_shouldReturnHighScore() {
    // GIVEN (Arrange) — setup
    Customer customer = new Customer("CUST-001",
        Income.of(50_000_000L, "VND"),
        EmploymentStatus.FULL_TIME);

    // WHEN (Act) — execute
    CreditScore score = creditScoringService.calculate(customer);

    // THEN (Assert) — verify
    assertThat(score.getValue()).isGreaterThanOrEqualTo(700);
    assertThat(score.getGrade()).isEqualTo(CreditGrade.A);
}
```

### Pattern 2: Parameterized Tests

```java
@ParameterizedTest(name = "status={0} → canApprove={1}")
@CsvSource({
    "PENDING, true",
    "APPROVED, false",
    "REJECTED, false",
    "ARCHIVED, false"
})
void canApprove_dependsOnCurrentStatus(DocumentStatus status, boolean expected) {
    Document doc = Document.withStatus(DocumentId.of(1L), status);
    assertThat(doc.canBeApproved()).isEqualTo(expected);
}
```

### Pattern 3: Builder Pattern for Test Data

```java
// ❌ Verbose test setup
Document doc = new Document(
    DocumentId.of(1L), "CUST-001", "Nguyen Van A",
    DocumentStatus.PENDING, null, null, "HN001",
    LocalDateTime.now(), LocalDateTime.now(), "system", "system"
);

// ✅ Test Builder (can use Lombok @Builder on test fixtures)
Document doc = DocumentTestBuilder.aDocument()
    .withId(1L)
    .withCustomerId("CUST-001")
    .pending()
    .atBranch("HN001")
    .build();
```

### Pattern 4: Contract Testing (Microservices)

```java
// Producer side (PDMS document service)
// Defines what it PROVIDES
@ExtendWith(PactProviderTestExtension.class)
@Provider("document-service")
class DocumentServicePactTest {
    @TestTarget
    public final MockMvcTarget target = new MockMvcTarget();

    @PactVerification
    @State("document 1 exists")
    public void documentOneExists() {
        when(service.findById(1L)).thenReturn(Optional.of(testDocument));
    }
}

// Consumer side (notification service)
// Defines what it EXPECTS from producer
@PactConsumerTest
@PactTestFor(providerName = "document-service")
class DocumentServiceConsumerPactTest {
    @Pact(consumer = "notification-service")
    RequestResponsePact documentExistsPact(PactDslWithProvider builder) {
        return builder
            .given("document 1 exists")
            .uponReceiving("get document 1")
            .path("/api/documents/1")
            .method("GET")
            .willRespondWith()
            .status(200)
            .body(newJsonBody(body -> body
                .numberValue("id", 1)
                .stringValue("status", "APPROVED")
            ).build())
            .toPact();
    }
}
```

---

## 📊 Coverage — Hiểu đúng ý nghĩa

```
Code Coverage KHÔNG phải là:
❌ Higher coverage = better quality
❌ 100% coverage = no bugs
❌ A goal in itself

Code Coverage LÀ:
✅ A safety net finding untested paths
✅ A smell indicator (if < 60%: insufficient coverage of business logic)
✅ A conversation starter ("why is this branch uncovered?")

Meaningful metrics:
- Line coverage: % lines executed by tests → easy to fake (just call method)
- Branch coverage: % if/else branches tested → more meaningful
- Mutation coverage: % mutations caught by tests → MOST meaningful

Mutation Testing:
// Mutation: change '>' to '>=' in business rule
if (amount > 1_000_000) → if (amount >= 1_000_000)
// If your test doesn't catch this: test is incomplete!
// Tool: PIT (pitest.org) for Java
```

---

## 🔧 Tools & Setup

```
UNIT:
  JUnit 5 + AssertJ + Mockito (Java)
  cargo test (Rust)
  go test (Go)

INTEGRATION:
  Testcontainers — real DB/Kafka in Docker
  @WebMvcTest — Spring MVC slice
  @DataJpaTest — JPA slice
  WireMock — mock external HTTP services

E2E:
  RestAssured — API testing
  Playwright / Cypress — browser automation
  k6 — load testing

CONTRACT:
  Pact — consumer-driven contract testing

MUTATION:
  PIT (Pitest) — Java mutation testing
  cargo-mutants — Rust

CI INTEGRATION:
  mvn test -Pcoverage → Jacoco report → SonarQube
  GitHub Actions: run tests on every PR
```

---

## 💡 Tips & Tricks

> **Tip 1 — Test boundaries, not implementation**
> ```java
> // ❌ Testing implementation (brittle — breaks on refactor)
> verify(documentRepository, times(1)).findById(any());
> verify(cacheService, times(1)).get("doc:1");
> verify(documentRepository, times(0)).save(any()); // internal detail!
>
> // ✅ Testing behavior (robust — survives refactor)
> DocumentDto result = service.getDocument(1L);
> assertThat(result.getId()).isEqualTo(1L);
> assertThat(result.getStatus()).isEqualTo("APPROVED");
> // HOW it fetched the data = implementation detail, don't test
> ```

> **Tip 2 — Fast feedback loop**
> ```bash
> # Watch mode: re-run tests on file change
> mvn test -Dtest=DocumentApprovalServiceTest --watch
>
> # Run only unit tests (fast) during development
> mvn test -Dgroups=unit
>
> # Run integration tests only in CI
> mvn test -Dgroups=integration
>
> # Tag tests
> @Tag("unit") class UnitTest {}
> @Tag("integration") class IntTest {}
> ```

> **Tip 3 — Test naming conventions**
> ```java
> // Format: methodName_condition_expectedBehavior
> void approve_whenDocumentPending_shouldChangeStatusToApproved() {}
> void approve_whenDocumentAlreadyApproved_shouldThrowIllegalStateException() {}
> void findByBranch_whenBranchHasNoDocuments_shouldReturnEmptyList() {}
> // Self-documenting: failing test name tells you EXACTLY what broke
> ```

> **Tip 4 — Testcontainers reuse**
> ```java
> // Slow: new container per test class
> @Container PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>(...);
>
> // Fast: reuse container across test classes
> @Container
> static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16")
>     .withReuse(true);  // requires ~/.testcontainers.properties: testcontainers.reuse.enable=true
> // First run: starts container. Subsequent: reuses same container
> // CI: disable reuse (TESTCONTAINERS_REUSE_ENABLE=false)
> ```

---

## 🔬 Case Studies

### Case Study 1: TDD for Document Approval Business Rule
```
Requirement: "A document can only be approved by a manager
              from the SAME branch as the document"

TDD process:
1. Write test FIRST (red):
   @Test
   void approve_byManagerFromDifferentBranch_shouldThrow() {
       Document doc = testDoc.atBranch("HN001");
       Manager manager = Manager.at("HCM001");
       assertThatThrownBy(() -> doc.approve(manager))
           .isInstanceOf(UnauthorizedApprovalException.class);
   }

2. Write minimal code to pass (green):
   public void approve(Manager approver) {
       if (!approver.getBranchId().equals(this.branchId))
           throw new UnauthorizedApprovalException(...);
       this.status = APPROVED;
   }

3. Refactor if needed (still green)

Value: business rule is documented in test, forever
```

### Case Study 2: Testcontainers cho PDMS
```
PDMS dùng PostgreSQL + specific extensions:
- uuid-ossp extension for UUID generation
- pg_trgm for text search

Testcontainers allows exact production setup:
@Container
static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16")
    .withInitScript("db/init-extensions.sql");  // CREATE EXTENSION pg_trgm;

Result:
- No "it works on my machine" issues
- Tests catch PostgreSQL-specific bugs (type casting, JSONB queries)
- CI environment matches production PostgreSQL version
```

### Case Study 3: What NOT to test
```
Don't test framework code:
❌ Testing that @NotNull throws ConstraintViolationException
❌ Testing that Spring's @Transactional rolls back on exception
❌ Testing Hibernate's lazy loading behavior
These are framework guarantees, not your code.

DO test your business logic:
✅ "Given this input, does MY validation reject it?"
✅ "Does MY service handle the rollback scenario correctly?"
✅ "Does MY code handle the lazy loading correctly?"
```

---

## 📝 Key Takeaways

1. **Testing Pyramid** = many unit tests, fewer integration, minimal E2E
2. **Unit tests** = fast, isolated, test business logic in domain layer
3. **Integration tests** = Testcontainers for real DB/Kafka, Spring slices (@WebMvcTest, @DataJpaTest)
4. **E2E tests** = critical user journeys only, expensive to maintain
5. **Test doubles**: Stub (return value), Mock (verify calls), Fake (simple impl), Spy (real + verify)
6. **Given-When-Then** = structured, readable test format
7. **Coverage ≠ quality** — branch coverage > line coverage, mutation testing = gold standard
8. **Test behavior, not implementation** — survive refactoring
9. **TDD** = write failing test → make it pass → refactor
10. **Contract testing** (Pact) = for microservice API compatibility

---

## 🔗 Liên kết

- [[clean-architecture-hexagonal]] — Hexagonal makes unit testing trivial (mock adapters)
- [[ddd-tactical]] — Domain objects = most valuable unit to test
- [[adr-framework]] — Document test strategy decisions in ADRs
- [[Microservices-Patterns/Consumer-Driven-Contracts]] — Pact contract testing
