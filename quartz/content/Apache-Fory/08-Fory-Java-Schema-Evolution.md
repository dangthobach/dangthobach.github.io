---
type: course
domain: data/serialization
status: active
created: 2026-05-28
updated: 2026-05-28
tags: []
---

# 08 — Schema Evolution Deep Dive: Version Strategy & Migration

> **Series:** [[00-MOC-Apache-Fory-Series]]  
> **Tags:** #apache-fory #schema-evolution #versioning #migration #backward-compat  
> **Level:** Advanced  
> **Prerequisite:** [[05-Fory-Java-Modes]]

---

## 🎯 Bạn sẽ học được gì?

- Schema evolution compatibility matrix đầy đủ
- Version strategy cho long-running systems
- Testing framework cho schema compatibility
- Migration từ Kryo/JDK sang Fory không downtime
- Xử lý edge case: enum changes, inheritance, generics
- Governance: ai được phép thay đổi schema và quy trình review

---

## 🧬 Phần 1 — Compatibility Matrix Đầy Đủ

```
┌───────────────────────────────────────────────────────────────────┐
│              FORY SCHEMA EVOLUTION COMPATIBILITY                  │
│         COMPATIBLE mode (CompatibleMode.COMPATIBLE)               │
│                                                                   │
│  Change                  │ Old reader  │ New reader  │ Safe?      │
│  ────────────────────────┼─────────────┼─────────────┼─────────── │
│  Add field               │ ignores     │ reads OK    │ ✅ YES     │
│  Remove field            │ reads OK    │ gets null   │ ✅ YES*    │
│  Rename field            │ gets null   │ gets null   │ ❌ NO      │
│  Change primitive type   │ exception   │ exception   │ ❌ NO      │
│  Widen numeric type      │ exception   │ reads OK    │ ⚠️ PARTIAL │
│  String → enum           │ exception   │ -           │ ❌ NO      │
│  Add enum constant       │ gets null   │ reads OK    │ ✅ YES**   │
│  Remove enum constant    │ exception   │ -           │ ❌ NO***   │
│  Add superclass          │ exception   │ -           │ ❌ NO      │
│  Add interface           │ reads OK    │ reads OK    │ ✅ YES     │
│  Reorder fields          │ reads OK    │ reads OK    │ ✅ YES     │
│  Change field to List    │ exception   │ -           │ ❌ NO      │
│                                                                   │
│  *  null safety: business logic phải handle null gracefully       │
│  ** enum: cần register enum constants với explicit ordinal        │
│  *** deprecated enums: giữ lại, không xóa                       │
└───────────────────────────────────────────────────────────────────┘
```

---

## 📏 Phần 2 — Versioning Strategy

### 2.1 Semantic versioning cho schema

```java
public abstract class BaseEvent {
    private long eventId;
    private String eventType;
    private long timestampMs;

    // Schema version — explicit tracking
    private int schemaVersion;

    // Migration hook: subclass override để xử lý version cũ
    public void onDeserialized() {
        if (schemaVersion < currentSchemaVersion()) {
            migrateFromVersion(schemaVersion);
        }
    }

    protected abstract int currentSchemaVersion();
    protected void migrateFromVersion(int oldVersion) {}
}

@Getter @Setter @NoArgsConstructor
public class CreditDocument extends BaseEvent {

    // v1 fields
    private String documentId;
    private String code;
    private BigDecimal amount;

    // v2 fields (thêm 2026-Q2)
    private String branchCode;     // null nếu đọc v1 data
    private String officerCode;    // null nếu đọc v1 data

    // v3 fields (thêm 2026-Q3)
    private List<String> tags;     // null nếu đọc v1/v2 data
    private String region;

    @Override
    protected int currentSchemaVersion() { return 3; }

    @Override
    protected void migrateFromVersion(int oldVersion) {
        if (oldVersion < 2) {
            // v1 → v2: branchCode, officerCode default
            this.branchCode = "LEGACY";
            this.officerCode = "UNKNOWN";
        }
        if (oldVersion < 3) {
            // v2 → v3: tags, region default
            this.tags = List.of();
            this.region = "HN"; // default region
        }
        // Update version
        this.setSchemaVersion(currentSchemaVersion());
    }
}
```

### 2.2 Version lifecycle

```
VERSION LIFECYCLE:
──────────────────────────────────────────────────────────────────

v1 ──────────► v2 ──────────► v3
│               │               │
ACTIVE          ACTIVE          ACTIVE
                (supports v1)   (supports v1, v2)

Sau khi deploy v3 ổn định:
v1 → DEPRECATED (6 tháng cảnh báo)
v1 → RETIRED (xóa migration code)

Rule of thumb:
- Hỗ trợ N-2 versions (hiện tại v3 → hỗ trợ v1, v2)
- Migration code cho version < N-2 → có thể xóa
- Chỉ xóa sau khi verify không còn v1 data trong Redis/Kafka
```

### 2.3 Version tracking trong distributed cache

```java
@Service
@RequiredArgsConstructor
public class VersionedCacheService {

    private final ThreadSafeFory fory;
    private final RedisTemplate<String, byte[]> redis;
    private static final int CURRENT_VERSION = 3;

    public void put(String key, CreditDocument doc) {
        doc.setSchemaVersion(CURRENT_VERSION);
        byte[] bytes = fory.serialize(doc);

        // Store với version metadata trong key
        String versionedKey = key + ":v" + CURRENT_VERSION;
        redis.opsForValue().set(versionedKey, bytes, Duration.ofHours(2));

        // Alias cho current version lookup
        redis.opsForValue().set(key + ":current", versionedKey.getBytes());
    }

    public Optional<CreditDocument> get(String key) {
        byte[] currentKeyBytes = redis.opsForValue().get(key + ":current");
        if (currentKeyBytes == null) return Optional.empty();

        String versionedKey = new String(currentKeyBytes);
        byte[] bytes = redis.opsForValue().get(versionedKey);
        if (bytes == null) return Optional.empty();

        CreditDocument doc = (CreditDocument) fory.deserialize(bytes);
        doc.onDeserialized(); // trigger migration nếu cần
        return Optional.of(doc);
    }
}
```

---

## 🔍 Phần 3 — Edge Cases Quan Trọng

### 3.1 Enum evolution

```java
// ❌ NGUY HIỂM: thay đổi enum ordinal
public enum DocumentStatus {
    DRAFT,    // ordinal 0
    ACTIVE,   // ordinal 1
    ARCHIVED  // ordinal 2
}

// Sau khi thêm PENDING vào giữa:
public enum DocumentStatus {
    DRAFT,    // ordinal 0
    PENDING,  // ordinal 1  ← ACTIVE shift xuống!
    ACTIVE,   // ordinal 2  ← data cũ bị đọc sai!
    ARCHIVED  // ordinal 3
}
```

**Fix: register enum với explicit ordinal**

```java
// Custom enum serializer
public class DocumentStatusSerializer implements Serializer<DocumentStatus> {

    // Stable ID map — không thay đổi dù thứ tự enum thay đổi
    private static final Map<Integer, DocumentStatus> ID_TO_STATUS = Map.of(
        1, DocumentStatus.DRAFT,
        2, DocumentStatus.PENDING,
        3, DocumentStatus.ACTIVE,
        4, DocumentStatus.ARCHIVED
    );
    private static final Map<DocumentStatus, Integer> STATUS_TO_ID =
        ID_TO_STATUS.entrySet().stream()
            .collect(Collectors.toMap(Map.Entry::getValue, Map.Entry::getKey));

    @Override
    public void write(MemoryBuffer buffer, DocumentStatus value) {
        buffer.writeInt32(STATUS_TO_ID.get(value));
    }

    @Override
    public DocumentStatus read(MemoryBuffer buffer) {
        int id = buffer.readInt32();
        return ID_TO_STATUS.getOrDefault(id, DocumentStatus.DRAFT); // safe default
    }
}

// Đăng ký custom serializer
fory.registerSerializer(DocumentStatus.class, new DocumentStatusSerializer());
```

### 3.2 Generic types

```java
// Generic wrapper
@Getter @Setter
public class PagedResult<T> {
    private List<T> items;
    private int total;
    private int page;
}

// ❌ Fory không serialize generic type parameter tốt
// PagedResult<CreditDocument> → T information lost at runtime

// ✅ Tạo concrete class
@Getter @Setter
public class PagedCreditDocuments extends PagedResult<CreditDocument> {
    // Fory serialize class cụ thể, không generic
}

// Register concrete class
fory.register(PagedCreditDocuments.class, 150);
```

### 3.3 Inheritance chain

```java
// Hierarchy
abstract class BaseEvent { ... }
class CreditEvent extends BaseEvent { ... }
class CreditApprovalEvent extends CreditEvent { ... }

// Register TẤT CẢ classes trong chain
fory.register(BaseEvent.class,          180);
fory.register(CreditEvent.class,        181);
fory.register(CreditApprovalEvent.class, 182);

// Polymorphic list
List<BaseEvent> events = List.of(
    new CreditEvent(...),
    new CreditApprovalEvent(...)
);

byte[] bytes = fory.serialize(events);
// Fory lưu type_id cho từng element
// Deserialize → đúng type được restored
List<BaseEvent> restored = (List<BaseEvent>) fory.deserialize(bytes);
// restored.get(0) instanceof CreditEvent → true ✅
// restored.get(1) instanceof CreditApprovalEvent → true ✅
```

### 3.4 Collection type changes

```java
// v1: dùng ArrayList
public class Document {
    private ArrayList<String> tags; // serialized as ArrayList
}

// v2: muốn đổi sang List interface
public class Document {
    private List<String> tags; // ← Fory deserialize OK (ArrayList implements List)
}

// ✅ ArrayList → List: an toàn
// ❌ List → Set: KHÔNG an toàn (thứ tự có thể mất)
// ❌ ArrayList → LinkedList: thường OK nhưng nên test
```

---

## 🧪 Phần 4 — Testing Framework

### 4.1 Compatibility test harness

```java
/**
 * Test matrix: mọi schema version phải đọc được bởi current reader
 */
@TestMethodOrder(OrderAnnotation.class)
class SchemaCompatibilityTest {

    private static final Path FIXTURE_DIR =
        Path.of("src/test/resources/schema-fixtures");

    /**
     * STEP 1: Generate fixtures cho current version
     * Chạy khi có schema thay đổi, commit fixtures vào Git
     */
    @Test
    @Order(1)
    void generateFixtures() throws Exception {
        ThreadSafeFory fory = buildCurrentFory();

        // v3 fixture
        CreditDocument v3Doc = buildV3Document();
        byte[] v3Bytes = fory.serialize(v3Doc);
        Files.write(FIXTURE_DIR.resolve("credit-document-v3.bin"), v3Bytes);

        System.out.println("Generated fixtures. Commit these files.");
    }

    /**
     * STEP 2: Verify current reader can read ALL historical fixtures
     * Chạy trong CI/CD — fail nếu backward compat bị phá vỡ
     */
    @Test
    @Order(2)
    void currentReaderCanReadAllHistoricalFixtures() throws Exception {
        ThreadSafeFory currentFory = buildCurrentFory();

        // Test với tất cả fixture files
        try (Stream<Path> files = Files.list(FIXTURE_DIR)) {
            files.filter(p -> p.toString().endsWith(".bin"))
                .forEach(fixture -> {
                    try {
                        byte[] bytes = Files.readAllBytes(fixture);
                        Object obj = currentFory.deserialize(bytes);
                        assertThat(obj).isNotNull();

                        // Trigger migration
                        if (obj instanceof BaseEvent event) {
                            event.onDeserialized();
                        }

                        System.out.printf("✅ %s → %s%n",
                            fixture.getFileName(), obj.getClass().getSimpleName());

                    } catch (Exception e) {
                        fail("Failed to read fixture " + fixture.getFileName()
                            + ": " + e.getMessage());
                    }
                });
        }
    }

    /**
     * STEP 3: Verify specific field migration
     */
    @Test
    void v1DataMigratesCorrectly() throws Exception {
        byte[] v1Bytes = Files.readAllBytes(
            FIXTURE_DIR.resolve("credit-document-v1.bin"));

        ThreadSafeFory currentFory = buildCurrentFory();
        CreditDocument doc = (CreditDocument) currentFory.deserialize(v1Bytes);
        doc.onDeserialized(); // trigger migration

        // v1 fields phải còn nguyên
        assertThat(doc.getDocumentId()).isNotBlank();
        assertThat(doc.getAmount()).isPositive();

        // v2+ fields phải có default values (không null)
        assertThat(doc.getBranchCode()).isEqualTo("LEGACY"); // migration default
        assertThat(doc.getOfficerCode()).isEqualTo("UNKNOWN");

        // v3 fields
        assertThat(doc.getTags()).isNotNull().isEmpty();
        assertThat(doc.getRegion()).isEqualTo("HN");
    }

    private ThreadSafeFory buildCurrentFory() {
        ThreadSafeFory f = Fory.builder()
            .withLanguage(Language.JAVA)
            .withCompatibleMode(CompatibleMode.COMPATIBLE)
            .requireClassRegistration(true)
            .build();
        ForyRegistrar.registerAll(f);
        return f;
    }
}
```

### 4.2 Property-based testing (jqwik)

```java
@ExtendWith(JqwikExtension.class)
class ForyPropertyTest {

    @Property(tries = 1000)
    void serializeDeserializeIsIdentity(
            @ForAll @IntRange(min = 1, max = 100) int fieldCount,
            @ForAll String documentId,
            @ForAll double amount) {

        CreditDocument doc = new CreditDocument();
        doc.setDocumentId(documentId);
        doc.setAmount(BigDecimal.valueOf(Math.abs(amount)));
        doc.setSchemaVersion(3);

        byte[] bytes = fory.serialize(doc);
        CreditDocument restored = (CreditDocument) fory.deserialize(bytes);

        assertThat(restored.getDocumentId()).isEqualTo(doc.getDocumentId());
        assertThat(restored.getAmount())
            .isEqualByComparingTo(doc.getAmount());
    }
}
```

---

## 🚚 Phần 5 — Migration Từ Kryo Sang Fory

### 5.1 Migration strategy

```
MIGRATION PHASES (không downtime):
────────────────────────────────────────────────────────────────

Phase 1 — Dual-read (1-2 tuần):
  Write: Kryo (unchanged)
  Read:  Try Fory → fallback Kryo nếu fail
  → Không có cache hiệu quả hơn vì vẫn dùng Kryo

Phase 2 — Dual-write (1-2 tuần):
  Write: Kryo VÀ Fory (2 keys trong Redis)
  Read:  Fory first → fallback Kryo
  → Mọi hot data có cả 2 format

Phase 3 — Fory primary (sau khi TTL của Kryo entries expire):
  Write: Fory only
  Read:  Fory first → fallback Kryo (cho stale entries)
  → Monitor fallback rate → trending to 0

Phase 4 — Fory only:
  Write: Fory only
  Read:  Fory only (remove fallback)
  → Migration complete
```

### 5.2 Implementation Phase 2-3

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class MigratingCacheService {

    private final ThreadSafeFory fory;
    private final Kryo kryo; // legacy
    private final RedisTemplate<String, byte[]> redis;

    // Feature flag: khi nào bật Fory write
    @Value("${cache.migration.fory-write-enabled:false}")
    private boolean foryWriteEnabled;

    // Feature flag: khi nào tắt Kryo fallback
    @Value("${cache.migration.kryo-fallback-enabled:true}")
    private boolean kryoFallbackEnabled;

    public void put(String key, Object obj) {
        if (foryWriteEnabled) {
            // Write Fory
            byte[] foryBytes = fory.serialize(obj);
            redis.opsForValue().set(foryKey(key), foryBytes, Duration.ofHours(2));
        }

        // Write Kryo (phase 1-2, xóa ở phase 3)
        if (!foryWriteEnabled || kryoFallbackEnabled) {
            byte[] kryoBytes = kryoSerialize(kryo, obj);
            redis.opsForValue().set(kryoKey(key), kryoBytes, Duration.ofHours(2));
        }
    }

    public Optional<Object> get(String key) {
        // Try Fory first
        byte[] foryBytes = redis.opsForValue().get(foryKey(key));
        if (foryBytes != null) {
            try {
                return Optional.of(fory.deserialize(foryBytes));
            } catch (Exception e) {
                log.warn("Fory deserialize failed for key {}: {}", key, e.getMessage());
            }
        }

        // Fallback to Kryo
        if (kryoFallbackEnabled) {
            byte[] kryoBytes = redis.opsForValue().get(kryoKey(key));
            if (kryoBytes != null) {
                meterRegistry.counter("cache.kryo.fallback").increment();
                return Optional.of(kryoDeserialize(kryo, kryoBytes));
            }
        }

        return Optional.empty();
    }

    private String foryKey(String key) { return "fory:" + key; }
    private String kryoKey(String key)  { return "kryo:" + key; }
}
```

---

## 📋 Phần 6 — Schema Governance

### 6.1 Schema change checklist (PR review)

```markdown
## Schema Change Checklist

### Loại thay đổi
- [ ] Thêm field mới
- [ ] Xóa field
- [ ] Thay đổi type
- [ ] Thêm class mới
- [ ] Thay đổi enum

### Backward compatibility
- [ ] Chạy `SchemaCompatibilityTest` và pass
- [ ] Fixture files mới đã được generate và commit
- [ ] Migration code đã xử lý null default cho field mới
- [ ] Unit test coverage cho migration path

### Type registry
- [ ] `type-registry.yml` đã cập nhật
- [ ] ID mới không conflict với existing IDs
- [ ] Deprecated types đánh dấu `deprecated: true` (KHÔNG xóa)

### Deployment plan
- [ ] Consumer deploy trước Producer (nếu thêm field)
- [ ] Rollback plan nếu incompatible bytes xuất hiện
- [ ] DLQ monitoring alert đã setup
```

### 6.2 Type registry automation test

```java
@Test
void typeRegistryHasNoConflicts() throws Exception {
    // Load type-registry.yml
    ObjectMapper yaml = new ObjectMapper(new YAMLFactory());
    TypeRegistry registry = yaml.readValue(
        getClass().getResourceAsStream("/type-registry.yml"),
        TypeRegistry.class
    );

    // Verify no duplicate IDs
    Set<Integer> ids = new HashSet<>();
    for (TypeEntry entry : registry.getTypes()) {
        assertThat(ids.add(entry.getTypeId()))
            .as("Duplicate type_id: %d for %s", entry.getTypeId(), entry.getTag())
            .isTrue();
    }

    // Verify all Java classes exist
    for (TypeEntry entry : registry.getTypes()) {
        if (!entry.isDeprecated() && entry.getJavaClass() != null) {
            assertThatCode(() -> Class.forName(entry.getJavaClass()))
                .as("Class not found: %s", entry.getJavaClass())
                .doesNotThrowAnyException();
        }
    }

    // Verify IDs start from 100 (Fory built-in uses 0-99)
    registry.getTypes().forEach(entry ->
        assertThat(entry.getTypeId())
            .as("Type ID must be >= 100: %s", entry.getTag())
            .isGreaterThanOrEqualTo(100)
    );
}
```

---

## ✅ Key Takeaways

- [ ] Safe changes: thêm/xóa field, reorder — với COMPATIBLE mode
- [ ] Unsafe: rename field, change type, remove enum constant
- [ ] Enum: luôn dùng explicit stable ID, không dựa vào ordinal
- [ ] Generic types: tạo concrete subclass thay vì serialize raw generics
- [ ] Testing: generate fixture → commit → CI verify backward compat mọi build
- [ ] Migration Kryo → Fory: dual-write phase, feature flag driven, monitor fallback rate
- [ ] Governance: `type-registry.yml` là source of truth, review khi có thay đổi

---

## 🔜 Bài tiếp theo

[[11-Fory-XLang-Java-Go-Rust]] — Full XLang demo: Java producer → Kafka → Go consumer + Rust consumer cùng byte stream

---

## 📖 Tham khảo

- [Fory Schema Evolution Guide](https://fory.apache.org/docs/guide/java_object_graph_guide#schema-evolution)
- [Fory Compatible Mode](https://fory.apache.org/docs/guide/java_object_graph_guide#compatible-mode)
- [[05-Fory-Java-Modes]]
- [[07-Fory-Java-Kafka-Internal-Events]]
