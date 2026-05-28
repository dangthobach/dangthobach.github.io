# 04 — Fory Java Quickstart: Setup, Register, Serialize

> **Series:** [[00-MOC-Apache-Fory-Series]]  
> **Tags:** #apache-fory #java #spring-boot #quickstart  
> **Level:** Beginner-Intermediate  
> **Prerequisite:** [[03-Fory-vs-Avro-Protobuf-Positioning]]

---

## 🎯 Bạn sẽ học được gì?

- Thêm Fory vào Maven/Gradle project
- Khởi tạo đúng cách: ThreadSafeFory vs ThreadLocalFory
- Register class — tại sao cần và chiến lược register
- Serialize / Deserialize cơ bản
- Tích hợp vào Spring Bean (singleton-safe)
- Các pitfalls thường gặp

---

## 📦 Phần 1 — Maven Setup

```xml
<!-- pom.xml -->
<dependencies>
    <!-- Fory core -->
    <dependency>
        <groupId>org.apache.fory</groupId>
        <artifactId>fory-core</artifactId>
        <version>0.11.2</version>
    </dependency>

    <!-- Nếu cần serialize Java collections đặc biệt -->
    <!-- Fory hỗ trợ ArrayList, HashMap, etc mặc định -->
    <!-- Không cần dependency thêm cho standard JDK types -->
</dependencies>
```

**Gradle:**
```groovy
dependencies {
    implementation 'org.apache.fory:fory-core:0.11.2'
}
```

> ⚠️ Luôn kiểm tra version mới nhất tại [Maven Central](https://central.sonatype.com/artifact/org.apache.fory/fory-core)

---

## 🏗️ Phần 2 — Khởi Tạo Fory

### 2.1 Hiểu sự khác nhau giữa các builder modes

```
┌─────────────────────────────────────────────────────────────────┐
│                 FORY INITIALIZATION MODES                       │
│                                                                 │
│  Fory (base)                                                    │
│  ──────────                                                     │
│  Single instance, NOT thread-safe                               │
│  Dùng khi: unit test, single-threaded tool                      │
│                                                                 │
│  ThreadSafeFory                                                 │
│  ───────────────                                                │
│  Pool-based, THREAD-SAFE                                        │
│  Dùng khi: Spring singleton bean, shared instance               │
│  ← Đây là lựa chọn cho production                              │
│                                                                 │
│  ThreadLocalFory                                                │
│  ────────────────                                               │
│  ThreadLocal-based, THREAD-SAFE                                 │
│  Dùng khi: cần kiểm soát lifecycle thủ công                    │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Khởi tạo cơ bản

```java
import org.apache.fory.Fory;
import org.apache.fory.ThreadSafeFory;
import org.apache.fory.config.Language;

// ✅ Recommended cho production (thread-safe)
ThreadSafeFory fory = Fory.builder()
    .withLanguage(Language.JAVA)          // Java-only mode (fastest)
    .withAsyncCompilation(true)           // JIT compile không block request
    .requireClassRegistration(true)       // Security: whitelist classes
    .build();
```

### 2.3 Các builder options quan trọng

```java
ThreadSafeFory fory = Fory.builder()

    // Language mode
    .withLanguage(Language.JAVA)      // Java native — nhanh nhất
    // .withLanguage(Language.XLANG)  // Cross-language: Java↔Go↔Rust

    // Performance
    .withAsyncCompilation(true)       // Background JIT, không block lần đầu
    .withCodegen(true)                // Enable bytecode generation (default true)

    // Reference tracking
    .withRefTracking(true)            // Track circular refs (default: true)
    // .withRefTracking(false)        // Tắt nếu chắc chắn không có circular ref
                                      // → nhẹ hơn ~10%

    // Security
    .requireClassRegistration(true)   // Chỉ deserialize class đã register

    // Compatibility
    .withCompatibleMode(CompatibleMode.SCHEMA_CONSISTENT)
    // SCHEMA_CONSISTENT: nhanh nhất, writer/reader phải cùng schema
    // COMPATIBLE: chậm hơn chút, hỗ trợ thêm/bớt field

    .build();
```

---

## 📋 Phần 3 — Class Registration

### Tại sao phải register?

```
Fory binary format: [type_id: 2 bytes][data...]
                           ↑
                    Số nhỏ, compact

Nếu KHÔNG register → phải write full class name:
[type_name: "com.vpbank.pdms.document.CreditDocument"][data...]
                           ↑
                    Lãng phí bytes + security risk
```

### 3.1 Register cơ bản

```java
// Domain objects
fory.register(CreditDocument.class);
fory.register(DocumentMetadata.class);
fory.register(CreditProfile.class);
fory.register(WarehouseCode.class);

// Collections (JDK types thường tự động, nhưng explicit tốt hơn)
fory.register(ArrayList.class);
fory.register(HashMap.class);
fory.register(HashSet.class);

// Enums
fory.register(DocumentStatus.class);
fory.register(CreditType.class);
```

### 3.2 Register với explicit ID (production best practice)

```java
// ✅ PRODUCTION: assign explicit ID — stable across deploys
fory.register(CreditDocument.class,   100);
fory.register(DocumentMetadata.class, 101);
fory.register(CreditProfile.class,    102);
fory.register(DocumentStatus.class,   103);
// Bắt đầu từ 100+ để tránh conflict với Fory built-in types (0-99)
```

**Tại sao cần explicit ID:**

```
WITHOUT explicit ID:
─────────────────────
Deploy 1: CreditDocument → id=0, DocumentMetadata → id=1
Deploy 2: thêm AuditLog class
          AuditLog → id=0, CreditDocument → id=1 ← WRONG!

WITH explicit ID:
─────────────────
Deploy 1: CreditDocument=100, DocumentMetadata=101
Deploy 2: AuditLog=102 (thêm mới)
          CreditDocument vẫn=100 ✅ không bao giờ thay đổi
```

### 3.3 Tổ chức registration trong Spring Boot

```java
@Configuration
public class ForyConfig {

    @Bean
    public ThreadSafeFory fory() {
        ThreadSafeFory fory = Fory.builder()
            .withLanguage(Language.JAVA)
            .withAsyncCompilation(true)
            .requireClassRegistration(true)
            .build();

        registerDomainClasses(fory);
        return fory;
    }

    private void registerDomainClasses(ThreadSafeFory fory) {
        // === DOCUMENT DOMAIN ===
        fory.register(CreditDocument.class,     100);
        fory.register(DocumentMetadata.class,   101);
        fory.register(DocumentStatus.class,     102);
        fory.register(WarehouseCode.class,      103);

        // === CREDIT DOMAIN ===
        fory.register(CreditProfile.class,      110);
        fory.register(CreditType.class,         111);
        fory.register(CollateralInfo.class,     112);

        // === COLLECTIONS ===
        fory.register(ArrayList.class,          120);
        fory.register(HashMap.class,            121);
        fory.register(HashSet.class,            122);
        fory.register(LinkedList.class,         123);
    }
}
```

---

## ✍️ Phần 4 — Serialize / Deserialize Cơ Bản

### 4.1 Domain object mẫu

```java
// Domain classes
@Getter @Setter @NoArgsConstructor @AllArgsConstructor
public class CreditDocument {
    private Long id;
    private String documentCode;
    private DocumentStatus status;
    private DocumentMetadata metadata;
    private List<CollateralInfo> collaterals;
    private BigDecimal amount;
    private LocalDateTime createdAt;
}

@Getter @Setter @NoArgsConstructor
public class DocumentMetadata {
    private String warehouseCode;
    private String shelfCode;
    private Map<String, String> tags;
    private byte[] checksum;
}
```

### 4.2 Basic serialize/deserialize

```java
@Service
@RequiredArgsConstructor
public class DocumentCacheService {

    private final ThreadSafeFory fory;

    // Serialize: Object → byte[]
    public byte[] serialize(CreditDocument doc) {
        return fory.serialize(doc);
    }

    // Deserialize: byte[] → Object
    public CreditDocument deserialize(byte[] bytes) {
        return (CreditDocument) fory.deserialize(bytes);
    }
}
```

### 4.3 Với MemoryBuffer (zero-copy path)

```java
import org.apache.fory.memory.MemoryBuffer;
import org.apache.fory.memory.MemoryUtils;

// Serialize vào pre-allocated buffer (tránh allocate)
public byte[] serializeToBuffer(CreditDocument doc) {
    MemoryBuffer buffer = MemoryUtils.buffer(512); // initial capacity
    fory.serialize(buffer, doc);
    // buffer tự grow nếu cần
    return buffer.getBytes(0, buffer.writerIndex());
}

// Serialize trực tiếp vào OutputStream (cho large payloads)
public void serializeToStream(CreditDocument doc, OutputStream out) {
    fory.serialize(out, doc);
}

// Deserialize từ InputStream
public CreditDocument deserializeFromStream(InputStream in) {
    return (CreditDocument) fory.deserialize(in);
}
```

---

## 🔧 Phần 5 — Integration Patterns

### 5.1 Redis Cache với Fory

```java
@Service
@RequiredArgsConstructor
public class DocumentRedisCache {

    private final ThreadSafeFory fory;
    private final RedisTemplate<String, byte[]> redisTemplate;

    private static final Duration TTL = Duration.ofHours(2);

    public void put(String docId, CreditDocument document) {
        byte[] bytes = fory.serialize(document);
        redisTemplate.opsForValue().set(
            cacheKey(docId), bytes, TTL
        );
    }

    public Optional<CreditDocument> get(String docId) {
        byte[] bytes = redisTemplate.opsForValue().get(cacheKey(docId));
        if (bytes == null) return Optional.empty();
        return Optional.of((CreditDocument) fory.deserialize(bytes));
    }

    public void evict(String docId) {
        redisTemplate.delete(cacheKey(docId));
    }

    private String cacheKey(String docId) {
        return "pdms:doc:" + docId;
    }
}
```

**RedisTemplate config cho byte[]:**
```java
@Bean
public RedisTemplate<String, byte[]> bytesRedisTemplate(
        RedisConnectionFactory factory) {
    RedisTemplate<String, byte[]> template = new RedisTemplate<>();
    template.setConnectionFactory(factory);
    template.setKeySerializer(new StringRedisSerializer());
    template.setValueSerializer(new ByteArrayRedisSerializer()); // raw bytes
    return template;
}
```

### 5.2 Spring Cache abstraction với Fory serializer

```java
// Custom Redis serializer dùng Fory
public class ForyRedisSerializer implements RedisSerializer<Object> {

    private final ThreadSafeFory fory;

    public ForyRedisSerializer(ThreadSafeFory fory) {
        this.fory = fory;
    }

    @Override
    public byte[] serialize(Object obj) throws SerializationException {
        if (obj == null) return new byte[0];
        return fory.serialize(obj);
    }

    @Override
    public Object deserialize(byte[] bytes) throws SerializationException {
        if (bytes == null || bytes.length == 0) return null;
        return fory.deserialize(bytes);
    }
}

// Đăng ký với Spring Cache
@Bean
public RedisCacheConfiguration cacheConfiguration(ThreadSafeFory fory) {
    return RedisCacheConfiguration.defaultCacheConfig()
        .entryTtl(Duration.ofHours(1))
        .serializeValuesWith(
            RedisSerializationContext.SerializationPair
                .fromSerializer(new ForyRedisSerializer(fory))
        );
}
```

Sau đó dùng `@Cacheable` bình thường:

```java
@Cacheable(value = "documents", key = "#docId")
public CreditDocument getDocument(String docId) {
    return documentRepository.findById(docId).orElseThrow();
}
```

---

## ⚠️ Phần 6 — Common Pitfalls

### Pitfall 1: Dùng Fory base class trong multi-thread

```java
// ❌ SAI: Fory base class không thread-safe
@Service
public class BadService {
    // shared singleton → race condition!
    private final Fory fory = Fory.builder().build();

    public byte[] serialize(Object obj) {
        return fory.serialize(obj); // data corruption dưới high load
    }
}

// ✅ ĐÚNG: ThreadSafeFory
@Service
public class GoodService {
    private final ThreadSafeFory fory; // inject từ @Bean
    // ...
}
```

### Pitfall 2: Quên register class

```java
// Runtime exception:
// org.apache.fory.exception.ClassNotRegisteredException:
// Class com.vpbank.pdms.NewDocument is not registered

// Fix: thêm vào ForyConfig
fory.register(NewDocument.class, 130);
```

### Pitfall 3: Deserialize sang wrong type

```java
// ❌ ClassCastException
CreditDocument doc = (CreditDocument) fory.deserialize(bytes);
// bytes thực ra là DocumentMetadata

// ✅ Kiểm tra type hoặc dùng typed deserialize
Object obj = fory.deserialize(bytes);
if (obj instanceof CreditDocument doc) {
    // Java 16+ pattern matching
    processDocument(doc);
}
```

### Pitfall 4: Inner class / Anonymous class

```java
// ❌ Fory không serialize được non-static inner class
class Outer {
    class Inner { // implicit reference đến Outer
        String data;
    }
}

// ✅ Dùng static nested class
class Outer {
    static class Inner { // không có implicit reference
        String data;
    }
}
```

---

## 🧪 Phần 7 — Unit Test

```java
@SpringBootTest
class ForySerializationTest {

    @Autowired
    private ThreadSafeFory fory;

    @Test
    void shouldSerializeAndDeserializeCreditDocument() {
        CreditDocument original = CreditDocument.builder()
            .id(1L)
            .documentCode("HSBG-2026-001")
            .status(DocumentStatus.ACTIVE)
            .amount(new BigDecimal("5000000000"))
            .createdAt(LocalDateTime.now())
            .metadata(DocumentMetadata.builder()
                .warehouseCode("WH-HN-01")
                .shelfCode("A-01-03")
                .tags(Map.of("type", "credit", "branch", "HN"))
                .build())
            .build();

        // Serialize
        byte[] bytes = fory.serialize(original);
        assertThat(bytes).isNotEmpty();

        // Deserialize
        CreditDocument restored = (CreditDocument) fory.deserialize(bytes);

        // Verify
        assertThat(restored.getId()).isEqualTo(original.getId());
        assertThat(restored.getDocumentCode()).isEqualTo(original.getDocumentCode());
        assertThat(restored.getStatus()).isEqualTo(original.getStatus());
        assertThat(restored.getAmount()).isEqualByComparingTo(original.getAmount());
        assertThat(restored.getMetadata().getWarehouseCode())
            .isEqualTo(original.getMetadata().getWarehouseCode());
        assertThat(restored.getMetadata().getTags())
            .containsAllEntriesOf(original.getMetadata().getTags());
    }

    @Test
    void shouldHandleNullFields() {
        CreditDocument doc = new CreditDocument();
        doc.setId(42L);
        // metadata = null

        byte[] bytes = fory.serialize(doc);
        CreditDocument restored = (CreditDocument) fory.deserialize(bytes);

        assertThat(restored.getId()).isEqualTo(42L);
        assertThat(restored.getMetadata()).isNull();
    }

    @Test
    void shouldHandleCircularReference() {
        CreditDocument parent = new CreditDocument();
        parent.setId(1L);
        DocumentMetadata meta = new DocumentMetadata();
        meta.setParentDocument(parent); // circular ref
        parent.setMetadata(meta);

        byte[] bytes = fory.serialize(parent);
        CreditDocument restored = (CreditDocument) fory.deserialize(bytes);

        assertThat(restored.getMetadata().getParentDocument())
            .isSameAs(restored); // reference preserved!
    }
}
```

---

## ✅ Key Takeaways

- [ ] Luôn dùng `ThreadSafeFory` trong Spring singleton beans
- [ ] Register classes với explicit numeric ID để stable qua deploys
- [ ] Bắt đầu ID từ 100+ để tránh conflict với Fory built-in
- [ ] `withAsyncCompilation(true)` = JIT compile không block thread đầu tiên
- [ ] `requireClassRegistration(true)` = security whitelist, luôn bật production
- [ ] Test circular reference và null fields trước khi deploy

---

## 🔜 Bài tiếp theo

[[05-Fory-Java-Modes]] — Native vs Compatible vs XLang mode: hiểu sâu schema evolution và khi nào chọn mode nào

---

## 📖 Tham khảo

- [Fory Java Object Graph Guide](https://fory.apache.org/docs/guide/java_object_graph_guide)
- [Fory Java API Reference](https://fory.apache.org/api/java)
- [[03-Fory-vs-Avro-Protobuf-Positioning]]
