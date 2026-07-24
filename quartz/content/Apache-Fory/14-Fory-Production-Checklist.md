---
type: course
domain: data/serialization
status: active
created: 2026-05-29
updated: 2026-05-29
tags: []
---

# 14 — Fory Production Checklist: Security, Versioning, Monitoring

> **Series:** [[00-MOC-Apache-Fory-Series]]  
> **Tags:** #apache-fory #production #security #checklist #monitoring  
> **Level:** Advanced  
> **Prerequisite:** [[12-Fory-PDMS-Integration-Blueprint]] | [[13-Fory-Performance-Benchmarks]]

---

## 🎯 Bạn sẽ học được gì?

- Security hardening: chống deserialization attacks trong banking context
- Versioning governance: ai được thay đổi gì và quy trình
- Operational runbook: debug production issue với Fory
- Capacity planning: sizing Redis, Kafka với Fory payload
- Go-live checklist đầy đủ cho PDMS
- Long-term maintenance strategy

---

## 🔒 Phần 1 — Security Hardening

### 1.1 Tại sao deserialization là attack vector nguy hiểm?

```
ATTACK SCENARIO (Java Deserialization):
────────────────────────────────────────

Attacker gửi crafted bytes → service deserialize → execute arbitrary code

Ví dụ nổi tiếng: Apache Commons Collections gadget chain
byte[] maliciousBytes = buildGadgetChain("calc.exe");
Object result = jdkDeserialize(maliciousBytes); // → RCE!

Fory có thể bị tấn công nếu:
1. requireClassRegistration = false (default off)
2. Deserialize input từ untrusted source
3. Class whitelist quá rộng (register Object.class)
```

### 1.2 Security configuration cho banking context

```java
@Configuration
public class ForySecurityConfig {

    @Bean
    public ThreadSafeFory secureFory() {
        ThreadSafeFory fory = Fory.builder()
            .withLanguage(Language.JAVA)

            // ✅ BẮTBUỘC: Class registration whitelist
            .requireClassRegistration(true)

            // ✅ Không cho phép Java serialization fallback
            // (Fory không có Java ser fallback mặc định, chỉ explicit confirm)

            // ✅ Disable class registration cho untrusted data
            // (xem section 1.3 cho separate deserializer)

            .build();

        // Register chỉ những class CỤ THỂ cần thiết
        // KHÔNG register: Object.class, Serializable.class, hoặc bất kỳ base type nào
        registerWhitelistedClasses(fory);

        return fory;
    }

    private void registerWhitelistedClasses(ThreadSafeFory fory) {
        // === DOMAIN CLASSES (explicit whitelist) ===
        fory.register(CreditDocument.class,     100);
        fory.register(DocumentMetadata.class,   101);
        fory.register(DocumentStatus.class,     102);
        fory.register(CreditProfile.class,      103);
        fory.register(CollateralInfo.class,     104);
        fory.register(TokenClaims.class,        105);
        fory.register(UserPermission.class,     106);
        fory.register(WorkflowState.class,      107);
        fory.register(ProcessTask.class,        108);

        // === JDK TYPES (chỉ những gì thực sự dùng) ===
        fory.register(ArrayList.class,          120);
        fory.register(HashMap.class,            121);
        fory.register(HashSet.class,            122);
        // KHÔNG register: LinkedList, TreeMap trừ khi thực sự cần
        // KHÔNG register: Runtime.class, ProcessBuilder.class, etc.

        // === FORBIDDEN — không bao giờ register ===
        // fory.register(Object.class);           // quá rộng
        // fory.register(Serializable.class);     // quá rộng
        // fory.register(Class.class);            // attack vector
        // fory.register(ClassLoader.class);      // attack vector
    }
}
```

### 1.3 Tách Fory instance cho trusted vs untrusted data

```java
@Configuration
public class ForyInstanceConfig {

    // Instance 1: Trusted internal data (Redis, internal Kafka)
    @Bean("trustedFory")
    public ThreadSafeFory trustedFory() {
        return Fory.builder()
            .withLanguage(Language.JAVA)
            .requireClassRegistration(true)  // whitelist
            .withAsyncCompilation(true)
            .build();
        // register domain classes...
    }

    // Instance 2: KHÔNG dùng Fory cho external/untrusted input
    // External data luôn dùng JSON (safe, self-describing)
    // Nếu cần binary từ external → Protobuf với strict schema
}
```

### 1.4 Audit logging cho deserialization

```java
@Aspect
@Component
@Slf4j
public class ForyAuditAspect {

    // Log mọi deserialization trong banking audit context
    @Around("execution(* org.apache.fory.ThreadSafeFory.deserialize(..))")
    public Object auditDeserialize(ProceedingJoinPoint pjp) throws Throwable {
        byte[] data = (byte[]) pjp.getArgs()[0];

        try {
            Object result = pjp.proceed();
            // Success: log class type được deserialize
            log.debug("Fory deserialized: class={}, size={}B",
                result.getClass().getSimpleName(), data.length);
            return result;

        } catch (Exception e) {
            // QUAN TRỌNG: log failure với context
            log.error("Fory deserialization FAILED: size={}B, error={}",
                data.length, e.getMessage());
            // Alert security team nếu pattern bất thường
            if (isAnomalousPattern(data)) {
                securityAlertService.alert("Potential malicious Fory payload detected");
            }
            throw e;
        }
    }

    private boolean isAnomalousPattern(byte[] data) {
        // Payload quá lớn (potential bomb)
        if (data.length > 10 * 1024 * 1024) return true; // > 10MB
        // Thêm heuristics khác nếu cần
        return false;
    }
}
```

### 1.5 Payload size limit

```java
public class SizeLimitedForyDeserializer {

    private static final int MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5MB
    private final ThreadSafeFory fory;

    public Object deserializeSafe(byte[] data) {
        if (data == null) return null;
        if (data.length > MAX_PAYLOAD_BYTES) {
            throw new SecurityException(
                "Fory payload exceeds limit: " + data.length + " bytes > " + MAX_PAYLOAD_BYTES
            );
        }
        return fory.deserialize(data);
    }
}
```

---

## 📋 Phần 2 — Versioning Governance

### 2.1 Type ID allocation policy

```
TYPE ID ALLOCATION POLICY — PDMS:
─────────────────────────────────────────────────────────────
Range       Owner               Purpose
0–99        Fory framework      Built-in types (DO NOT USE)
100–199     pdms-document-svc   Document domain classes
200–299     pdms-iam-service    IAM domain classes
300–399     pdms-process-mgmt   Process/workflow classes
400–499     pdms-reporting      Report domain classes
500–599     Shared/Common       JDK types, shared DTOs
600–699     XLang events        Cross-language event types
700+        Future services     Reserved

Rules:
1. Một ID được assign → KHÔNG BAO GIỜ thay đổi hoặc tái sử dụng
2. Deprecated class: đánh dấu trong registry, giữ lại code ≥ 6 tháng
3. Mọi thay đổi type-registry.yml phải qua PR review của Tech Lead
4. CI/CD phải chạy SchemaCompatibilityTest trước mỗi deploy
```

### 2.2 Type registry enforcement in CI

```yaml
# .github/workflows/fory-registry-check.yml
name: Fory Registry Validation

on: [push, pull_request]

jobs:
  validate-registry:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check type-registry.yml for conflicts
        run: |
          python3 scripts/validate-fory-registry.py type-registry.yml

      - name: Run schema compatibility tests
        run: |
          mvn test -pl fory-common \
            -Dtest=SchemaCompatibilityTest \
            -Dschema.fixture.dir=src/test/resources/schema-fixtures

      - name: Check no type IDs removed
        run: |
          # So sánh với main branch
          git diff origin/main -- type-registry.yml | \
            grep "^-.*type_id" && \
            echo "ERROR: Type IDs were removed! This breaks backward compat." && \
            exit 1 || echo "No type IDs removed ✅"
```

```python
# scripts/validate-fory-registry.py
import yaml
import sys

def validate(registry_path):
    with open(registry_path) as f:
        registry = yaml.safe_load(f)

    type_ids = {}
    errors = []

    for entry in registry['types']:
        tid = entry['type_id']
        tag = entry['tag']

        # Check duplicate IDs
        if tid in type_ids:
            errors.append(f"DUPLICATE type_id {tid}: {tag} vs {type_ids[tid]}")
        type_ids[tid] = tag

        # Check ID range
        if tid < 100:
            errors.append(f"type_id {tid} for {tag} conflicts with Fory built-in range (0-99)")

        # Check required fields
        for field in ['tag', 'type_id', 'schema_version', 'java_class']:
            if field not in entry:
                errors.append(f"Missing field '{field}' for type_id {tid}")

    if errors:
        print("❌ Registry validation FAILED:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    else:
        print(f"✅ Registry valid: {len(type_ids)} types, no conflicts")

if __name__ == '__main__':
    validate(sys.argv[1])
```

---

## 🔧 Phần 3 — Operational Runbook

### 3.1 Debug: ClassNotRegisteredException

```
SYMPTOM:
────────
org.apache.fory.exception.ClassNotRegisteredException:
  Class com.vpbank.pdms.domain.NewDocument is not registered

ROOT CAUSE OPTIONS:
───────────────────
1. Class mới thêm vào domain nhưng chưa register
2. Deploy mới chưa include registration trong ForyRegistrar
3. Class bị rename/move package

DIAGNOSIS:
──────────
1. Kiểm tra ForyRegistrar.java → tìm NewDocument
2. Kiểm tra log: class nào chưa register
3. Kiểm tra type-registry.yml → có entry chưa

FIX:
────
1. Thêm vào ForyRegistrar:
   fory.register(NewDocument.class, <next_available_id>);
2. Cập nhật type-registry.yml
3. Deploy với feature flag OFF → ON sau khi verify

PREVENTION:
───────────
Thêm integration test tự scan tất cả @Entity class và verify registered
```

```java
// Auto-scan test để prevent ClassNotRegisteredException
@Test
void allDomainClassesMustBeRegistered() {
    // Scan tất cả classes trong domain package
    Reflections reflections = new Reflections("com.vpbank.pdms.domain");
    Set<Class<?>> domainClasses = reflections.getTypesAnnotatedWith(Entity.class);
    domainClasses.addAll(reflections.getSubTypesOf(DomainEvent.class));

    ThreadSafeFory testFory = buildTestFory();

    for (Class<?> cls : domainClasses) {
        // Try serialize empty instance
        try {
            Object instance = cls.getDeclaredConstructor().newInstance();
            byte[] bytes = testFory.serialize(instance);
            assertThat(bytes).isNotEmpty();
        } catch (ClassNotRegisteredException e) {
            fail("Class not registered in Fory: " + cls.getName()
                + ". Add to ForyRegistrar.java");
        } catch (Exception e) {
            // Other exceptions OK (missing no-arg constructor etc.)
        }
    }
}
```

### 3.2 Debug: Data corruption sau schema change

```
SYMPTOM:
────────
Deserialized object có sai fields (null khi không nên null, hoặc wrong values)

CHECKLIST:
──────────
1. Xác định schema version của bytes trong Redis/Kafka
   → Thêm version header vào serialize (xem bài 08)
   → Check Redis key metadata

2. So sánh schema v_current vs schema v_bytes:
   → Có field bị rename không?
   → Có field bị đổi type không?
   → Có class bị move package không?

3. Check CompatibleMode setting:
   → SCHEMA_CONSISTENT: writer/reader PHẢI cùng schema
   → COMPATIBLE: OK nếu chỉ add/remove fields

DEBUG COMMAND:
──────────────
# Dump Fory bytes để inspect manually
java -cp benchmarks.jar com.vpbank.pdms.tools.ForyDumper <redis-key>
```

```java
// Tool để inspect Fory binary bytes
public class ForyDumper {
    public static void main(String[] args) throws Exception {
        String redisKey = args[0];
        byte[] bytes = redisTemplate.opsForValue().get(redisKey);

        System.out.println("Byte length: " + bytes.length);
        System.out.println("Hex dump (first 64 bytes):");
        System.out.println(HexFormat.of().formatHex(bytes, 0, Math.min(64, bytes.length)));

        try {
            Object obj = fory.deserialize(bytes);
            System.out.println("Deserialized class: " + obj.getClass().getName());
            System.out.println("Value: " + objectMapper.writeValueAsString(obj));
        } catch (Exception e) {
            System.out.println("Deserialization FAILED: " + e.getMessage());
        }
    }
}
```

### 3.3 Debug: Performance regression

```
SYMPTOM:
────────
Cache latency tăng đột ngột sau deploy Fory

DIAGNOSIS STEPS:
────────────────
Step 1: Kiểm tra async compilation
   → Fory async compile chưa xong → lần đầu dùng interpret mode (chậm)
   → Fix: withAsyncCompilation(true), warm up sau deploy

Step 2: Kiểm tra thread contention
   → ThreadSafeFory pool bị exhausted dưới high load
   → Fix: tune pool size (mặc định = available processors)

Step 3: Kiểm tra GC pressure
   → Serialize nhiều object lớn → nhiều allocation → GC pause
   → Fix: dùng MemoryBuffer reuse path

Step 4: Kiểm tra network (Redis)
   → Fory payload nhỏ hơn nhưng Redis connection pool không đủ
   → Fix: tune Redis connection pool size

MONITORING QUERY:
─────────────────
# Kiểm tra Fory compile status
# (Không có built-in metric hiện tại, dùng JFR để xem compilation events)
jcmd <pid> JFR.start duration=30s filename=fory-compile.jfr
```

---

## 📊 Phần 4 — Capacity Planning

### 4.1 Redis sizing sau migration

```
FORMULA:
────────
Redis memory = N_objects × avg_object_size_bytes × overhead_factor

Overhead factor: ~1.3 (Redis key metadata, hash table, etc.)

PDMS Example:
─────────────
10M documents × 165 bytes × 1.3 = 2.15 GB (Fory)
10M documents × 680 bytes × 1.3 = 8.84 GB (Jackson JSON)

Redis cluster sizing:
- Min: 2.15 GB × 2 (replication) = 4.3 GB
- Recommended: + 30% buffer = 5.6 GB
- Instance choice: cache.r6g.large (13.07 GB) → ổn

Monthly cost saving (AWS ap-southeast-1):
- Before: cache.r6g.2xlarge × 2 nodes = $835/month
- After:  cache.r6g.large × 2 nodes   = $417/month
- Saving: $418/month = ~$5,000/year
```

### 4.2 Kafka retention sizing

```
KAFKA TOPIC SIZING:
───────────────────
pdms.document.workflow.steps:
  - Current (Jackson JSON): avg 680B × 100K msg/day × 7 days = 476 MB
  - After Fory COMPATIBLE:  avg 210B × 100K msg/day × 7 days = 147 MB
  - Saving: 69% reduction → có thể tăng retention từ 7 → 22 days với cùng disk

pdms.process.task.events:
  - Current: 500B × 50K msg/day × 7 days = 175 MB
  - After:   165B × 50K msg/day × 7 days = 58 MB
  - Saving: 67% reduction
```

### 4.3 Network bandwidth

```
Internal service-to-service traffic reduction:
──────────────────────────────────────────────
Current: REST/JSON giữa document-service → iam-service
  5000 req/sec × 680 bytes = 3.4 MB/s inbound + 3.4 MB/s outbound

After Fory (nếu dùng XLang cho internal):
  5000 req/sec × 165 bytes = 0.825 MB/s = 76% bandwidth reduction

Note: REST/JSON vẫn giữ cho external API.
Fory XLang chỉ cho internal Kafka-based communication.
```

---

## ✅ Phần 5 — Go-Live Checklist Đầy Đủ

### Pre-deployment (T-1 tuần)

```markdown
#### Code Quality
- [ ] ForyRegistrar.java có tất cả domain classes với explicit ID
- [ ] type-registry.yml updated, reviewed bởi Tech Lead
- [ ] SchemaCompatibilityTest PASS trên CI (tất cả fixture files)
- [ ] allDomainClassesMustBeRegistered test PASS
- [ ] typeRegistryHasNoConflicts test PASS
- [ ] Security audit: không có Object.class, ClassLoader.class trong registry
- [ ] SizeLimitedForyDeserializer applied cho tất cả entry points

#### Testing
- [ ] Unit tests: serialize/deserialize roundtrip cho mọi domain class
- [ ] Unit tests: null fields, empty collections, circular references
- [ ] Integration tests: Spring Cache abstraction với Fory
- [ ] Load test trên staging: 5000 req/s trong 30 phút, error rate = 0
- [ ] Benchmark: payload size giảm ≥ 30% so với Jackson baseline

#### Infrastructure
- [ ] Redis connection pool sizing đã review (payload nhỏ hơn → throughput tăng)
- [ ] Grafana dashboard imported và alerting configured
- [ ] PagerDuty alert: Fory error rate > 0.1%
- [ ] Rollback procedure tested trên staging (< 5 phút thực hiện)
- [ ] Feature flag "fory.cache.enabled" = false trên production (deploy tắt trước)
```

### Deployment day (D-Day)

```markdown
#### Deploy Sequence
- [ ] 09:00 — Deploy fory-common module (library, no traffic impact)
- [ ] 09:15 — Deploy pdms-iam-service (lowest traffic, lowest risk)
- [ ] 09:30 — Verify IAM metrics: error rate = 0, cache hit rate ≥ 85%
- [ ] 10:00 — Enable feature flag: fory.cache.enabled = true (iam-service)
- [ ] 10:15 — Monitor 15 phút: Fory error rate, Redis memory metrics
- [ ] 10:30 — Deploy pdms-document-service
- [ ] 10:45 — Verify document-service metrics
- [ ] 11:00 — Enable feature flag (document-service)
- [ ] 11:15 — Monitor: Redis memory trending down (expect -40%)

#### Go/No-Go Criteria
- [ ] Fory error rate = 0 trong 15 phút sau enable
- [ ] Cache hit rate ≥ 85% (không giảm so với before)
- [ ] Serialize latency p99 < 500μs
- [ ] No increase in DB query rate (cache working)
- [ ] Redis memory trending down (confirm payload smaller)
```

### Post-deployment (D+7)

```markdown
#### Validation
- [ ] Redis memory giảm ≥ 30% so với trước migration
- [ ] JSON fallback rate < 5% (đang giảm về 0)
- [ ] P99 latency không tệ hơn trước
- [ ] GC pause frequency giảm hoặc stable

#### Documentation
- [ ] Confluence page: "Fory Integration — Post-migration Report"
  - Metrics before vs after
  - Lessons learned
  - Known limitations
- [ ] type-registry.yml: update status "active" cho tất cả entries
```

### D+30 — Migration Complete

```markdown
- [ ] JSON fallback rate = 0 → xóa fallback code
- [ ] Remove Jackson dependency từ cache layer (nếu không dùng chỗ khác)
- [ ] Kafka topics: confirm all consumers running Fory-native
- [ ] CI/CD: add regression test "Fory error rate must be 0 in staging"
- [ ] Team knowledge transfer: demo + recording cho team members mới
```

---

## 🔄 Phần 6 — Long-term Maintenance

### Quarterly review checklist

```markdown
#### Q1/Q2/Q3/Q4 — Every Quarter

Version:
- [ ] Kiểm tra Fory release notes (github.com/apache/fory/releases)
- [ ] Upgrade nếu có security fix hoặc significant perf improvement
- [ ] Sau upgrade: chạy full SchemaCompatibilityTest suite

Registry hygiene:
- [ ] Review type-registry.yml: class nào không còn dùng? → deprecated
- [ ] Xóa migration code cho versions > 12 tháng tuổi
- [ ] Verify type IDs vẫn stable (no accidental changes)

Performance baseline:
- [ ] Chạy JMH benchmark với current production data shape
- [ ] So sánh với baseline lần trước
- [ ] Alert nếu có regression > 10%

Security:
- [ ] Review class whitelist: có class nào nên bị remove?
- [ ] Check CVE database cho Fory version hiện tại
- [ ] Audit log review: có pattern bất thường không?
```

### Upgrade strategy

```
Fory upgrade process:
─────────────────────
1. Upgrade trong fory-common/pom.xml
2. Chạy SchemaCompatibilityTest với TẤT CẢ historical fixtures
   → Đây là safety net chính
3. Chạy JMH benchmark: performance không regression
4. Deploy lên dev → staging → production với canary (10% traffic trước)
5. Monitor 48h trước full rollout

KHÔNG upgrade khi:
- Major version jump (0.x → 1.0) → đọc migration guide cẩn thận
- Có thay đổi binary format trong release notes
- Gần cuối quarter (freeze period)
```

---

## 🎓 Phần 7 — Team Knowledge Transfer

### Onboarding checklist cho member mới

```markdown
## Fory Onboarding — New Team Member

Week 1:
- [ ] Đọc [[01-Why-Serialization-Matters]] và [[02-How-Fory-Works-Internals]]
- [ ] Đọc [[03-Fory-vs-Avro-Protobuf-Positioning]] (QUAN TRỌNG nhất)
- [ ] Review type-registry.yml → hiểu cấu trúc

Week 2:
- [ ] Đọc [[04-Fory-Java-Quickstart]] và [[05-Fory-Java-Modes]]
- [ ] Chạy SchemaCompatibilityTest trên máy local
- [ ] Add 1 domain class vào Fory (dưới supervision) → PR + review

Rules to internalize:
- [ ] "Fory for cache, Avro for cross-team Kafka, Protobuf for gRPC"
- [ ] "Never remove a type ID, only deprecate"
- [ ] "Consumer deploys before producer for Kafka schema evolution"
- [ ] "requireClassRegistration = true, always"
```

---

## ✅ Key Takeaways Toàn Series

```
┌──────────────────────────────────────────────────────────────────┐
│            APACHE FORY — MASTER MENTAL MODEL                     │
│                                                                  │
│  WHY FORY EXISTS:                                                │
│  JDK Serialization → insecure, slow                             │
│  Kryo → thread-unsafe, registration fragile                     │
│  Fory → JIT + zero-copy + thread-safe + multi-language          │
│                                                                  │
│  WHERE TO USE:                                                   │
│  ✅ Redis cache (replace Jackson/Kryo/JDK)                      │
│  ✅ Internal Kafka topics (1-team only)                         │
│  ✅ Cross-language nội bộ (Java↔Go↔Rust)                       │
│  ✅ Session state, workflow state                               │
│                                                                  │
│  WHERE NOT TO USE:                                               │
│  ❌ Cross-team Kafka (dùng Avro + Schema Registry)              │
│  ❌ gRPC (dùng Protobuf)                                        │
│  ❌ External APIs (dùng JSON)                                   │
│  ❌ Long-term storage / audit log                              │
│                                                                  │
│  THREE RULES:                                                    │
│  1. requireClassRegistration = true (always)                    │
│  2. Explicit type IDs (stable across deploys)                   │
│  3. Consumer before producer (Kafka schema evolution)           │
└──────────────────────────────────────────────────────────────────┘
```

---

## 🏁 Series Complete!

Bạn đã hoàn thành toàn bộ Apache Fory series. Bước tiếp theo:

```
THỰC HÀNH NGAY:
────────────────
1. Thêm fory-core vào PDMS pom.xml
2. Migrate 1 Redis cache nhỏ nhất (IAM token cache)
3. Benchmark trước/sau với JMH
4. Nếu kết quả tốt → áp dụng Phase 1 blueprint

THEO DÕI ECOSYSTEM:
────────────────────
- Apache Fory releases: github.com/apache/fory/releases
- Apache Fory blog: fory.apache.org/blog
- Benchmark suite: github.com/apache/fory/tree/main/benchmarks
```

---

## 📖 Tham khảo Toàn Series

- [Apache Fory Official Docs](https://fory.apache.org/docs)
- [Apache Fory GitHub](https://github.com/apache/fory)
- [Java Object Graph Guide](https://fory.apache.org/docs/guide/java_object_graph_guide)
- [XLang Guide](https://fory.apache.org/docs/guide/xlang_object_graph_guide)
- [[00-MOC-Apache-Fory-Series]] — Back to index
- [[12-Fory-PDMS-Integration-Blueprint]]
- [[13-Fory-Performance-Benchmarks]]
