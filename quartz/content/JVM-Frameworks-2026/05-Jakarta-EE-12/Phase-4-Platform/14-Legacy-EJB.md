# 14 — Jakarta EJB 4.x (Legacy)

> **Spec:** Jakarta Enterprise Beans 4.x | **Profile:** Full Platform
> **Spring equivalent:** `@Service` + `@Transactional` + `@Async`
> **Relevance 2026:** Thấp cho greenfield — **phải biết để đọc legacy code ngân hàng**

---

## 1. Spec Says

EJB (Enterprise JavaBeans) là component model của Java EE từ 1998. Từng là "backbone" của enterprise Java trước khi Spring thay thế. Năm 2026, EJB vẫn chạy trong hàng trăm nghìn hệ thống banking/insurance tại châu Á.

EJB 4.x = cleanup và trim — không thêm tính năng lớn, chủ yếu remove deprecated stuff.

---

## 2. Ba Loại EJB

### 2.1 Stateless Session Bean (SLSB)

```java
// === SPRING equivalent ===
@Service
@Transactional
public class DocumentService {
    public DocumentDTO getDocument(String id) { ... }
}

// === EJB Stateless ===
@Stateless          // không giữ state giữa các invocation
@TransactionAttribute(TransactionAttributeType.REQUIRED)
public class DocumentEJB {

    @PersistenceContext
    private EntityManager em;

    @EJB
    private AuditEJB auditEJB;        // inject EJB khác

    @Inject
    private DocumentValidator validator; // inject CDI bean

    public DocumentDTO getDocument(String id) {
        Document doc = em.find(Document.class, id);
        if (doc == null) throw new EJBException("Not found: " + id);
        return DocumentDTO.from(doc);
    }

    @TransactionAttribute(TransactionAttributeType.REQUIRES_NEW)
    public void createWithNewTx(CreateDocumentRequest req) { ... }
}

// Remote interface (cho distributed EJB — legacy pattern)
@Remote
public interface DocumentRemote {
    DocumentDTO getDocument(String id);
}

// Local interface (same JVM)
@Local
public interface DocumentLocal {
    DocumentDTO getDocument(String id);
}
```

### 2.2 Stateful Session Bean (SFSB)

```java
// Giữ state giữa các method calls của cùng client
// Spring không có equivalent — dùng @SessionScope bean

@Stateful
@StatefulTimeout(30) // minutes
public class ShoppingCartEJB {

    private List<Item> items = new ArrayList<>();
    private String sessionUserId;

    public void init(String userId) {
        this.sessionUserId = userId;
    }

    public void addItem(Item item) {
        items.add(item);
    }

    public List<Item> getItems() {
        return Collections.unmodifiableList(items);
    }

    @Remove                          // destroy bean sau khi gọi method này
    public Order checkout() {
        Order order = Order.from(sessionUserId, items);
        // process order
        return order;
    }
}
```

### 2.3 Singleton Session Bean

```java
// === SPRING ===
@Component   // singleton by default
@PostConstruct + @PreDestroy

// === EJB Singleton ===
@Singleton
@Startup                              // khởi tạo ngay khi app start
@ConcurrencyManagement(CONTAINER)     // container quản lý lock
public class AppInitializer {

    @EJB DocumentTypeCache cache;

    @PostConstruct
    void init() {
        System.out.println("App starting — loading reference data...");
        cache.warmUp();
    }

    @PreDestroy
    void cleanup() {
        System.out.println("App shutting down");
    }

    // READ lock — nhiều thread cùng đọc
    @Lock(LockType.READ)
    public String getConfig(String key) {
        return configs.get(key);
    }

    // WRITE lock — chỉ 1 thread ghi
    @Lock(LockType.WRITE)
    @AccessTimeout(5000)              // timeout nếu chờ lock quá 5s
    public void setConfig(String key, String val) {
        configs.put(key, val);
    }
}
```

---

## 3. Message-Driven Bean (MDB)

```java
// === EJB MDB — chạy khi nhận JMS message ===
// (đã thấy ở bài JMS — đây là container-managed)

@MessageDriven(activationConfig = {
    @ActivationConfigProperty(
        propertyName = "destinationType",
        propertyValue = "jakarta.jms.Queue"),
    @ActivationConfigProperty(
        propertyName = "destination",
        propertyValue = "java:/queue/documents")
})
public class DocumentProcessorMDB implements MessageListener {

    @EJB DocumentEJB docEJB;

    @Override
    @TransactionAttribute(TransactionAttributeType.REQUIRED)
    public void onMessage(Message message) {
        try {
            String docId = ((TextMessage) message).getText();
            docEJB.processDocument(docId);
        } catch (JMSException e) {
            throw new EJBException(e);
        }
    }
}
```

---

## 4. EJB Transaction Attributes

```java
// Tương đương Spring @Transactional propagation

@TransactionAttribute(TransactionAttributeType.REQUIRED)    // join hoặc tạo mới
@TransactionAttribute(TransactionAttributeType.REQUIRES_NEW)// luôn tạo mới
@TransactionAttribute(TransactionAttributeType.MANDATORY)   // phải có existing
@TransactionAttribute(TransactionAttributeType.NOT_SUPPORTED)// không dùng TX
@TransactionAttribute(TransactionAttributeType.SUPPORTS)    // dùng nếu có
@TransactionAttribute(TransactionAttributeType.NEVER)       // không được có TX
```

---

## 5. EJB Security

```java
@Stateless
@RolesAllowed("employee")              // class-level
public class DocumentEJB {

    @RolesAllowed({"admin", "manager"})  // method override
    public void deleteDocument(String id) { ... }

    @PermitAll
    public DocumentDTO viewDocument(String id) { ... }

    @DenyAll
    public void adminOnlyOp() { ... }

    // Programmatic check
    @Resource
    SessionContext ctx;

    public void conditionalOp() {
        if (ctx.isCallerInRole("admin")) {
            doAdminThing();
        }
        // Caller principal
        Principal caller = ctx.getCallerPrincipal();
    }
}
```

---

## 6. EJB Timer Service

```java
// Tương đương @Scheduled trong Spring
@Singleton
@Startup
public class DocumentCleanupTimer {

    @Resource
    TimerService timerService;

    @PostConstruct
    void createTimer() {
        // Programmatic timer — mỗi ngày lúc 2am
        ScheduleExpression schedule = new ScheduleExpression()
            .hour("2")
            .minute("0")
            .second("0");

        timerService.createCalendarTimer(schedule,
            new TimerConfig("daily-cleanup", true)); // persistent timer
    }

    // Declarative timer (annotation)
    @Schedule(hour = "2", minute = "0", second = "0", persistent = true)
    public void dailyCleanup(Timer timer) {
        System.out.println("Running daily cleanup: " + new Date());
        doCleanup();
    }

    @Schedule(second = "*/30", minute = "*", hour = "*")  // mỗi 30s
    public void healthCheck() {
        checkSystemHealth();
    }
}
```

---

## 7. EJB vs Spring — Migration Map

| EJB | Spring |
|---|---|
| `@Stateless` | `@Service` (singleton) |
| `@Stateful` | `@SessionScope` CDI bean |
| `@Singleton` + `@Startup` | `@Component` + `@PostConstruct` |
| `@MessageDriven` | `@KafkaListener` / `@RabbitListener` |
| `@EJB` injection | `@Autowired` / `@Inject` |
| `@TransactionAttribute` | `@Transactional(propagation=...)` |
| `@RolesAllowed` | `@PreAuthorize` |
| `@Schedule` | `@Scheduled` |
| `SessionContext` | `SecurityContextHolder` |
| `TimerService` | `TaskScheduler` |
| `@Remote` interface | REST API / gRPC |
| `@Local` interface | Interface injection |

---

## 8. EJB trong 2026 — Thực Tế

```
Đang DÙNG nhiều:
✅ Banking core systems (BIDV, VCB, VPBank legacy modules)
✅ IBM WebSphere / JBoss EAP deployments
✅ Insurance, telco enterprise apps

Đang THAY THẾ bằng:
→ @Stateless → Spring @Service / CDI @ApplicationScoped
→ @MessageDriven → Spring Kafka / @Incoming
→ @Schedule → @Scheduled / Quartz
→ @Remote → REST API / gRPC
→ @Stateful → Redis-backed session
```

---

## 9. Đọc Legacy EJB Code — Cheatsheet Nhanh

```java
// Gặp cái này → nghĩ tới Spring equivalent
@Stateless + @EJB     → @Service + @Autowired
@Stateful             → @SessionScoped + state management
@Singleton + @Startup → ApplicationRunner / @PostConstruct bean
@MessageDriven        → Message listener
@Resource EntityManager → @PersistenceContext
@TransactionAttribute  → @Transactional(propagation=...)
SessionContext.getCallerPrincipal() → SecurityContextHolder
ejbContext.setRollbackOnly() → TransactionStatus.setRollbackOnly()
```

---

*[[13-Jakarta-Faces]] | [[00-Overview]] | Next: [[15-Profile-Design]]*
