---
type: project
domain: data/serialization
status: active
created: 2026-05-28
updated: 2026-05-28
tags: []
---

# 12 — PDMS Integration Blueprint: Fory End-to-End

> **Series:** [[00-MOC-Apache-Fory-Series]]  
> **Tags:** #apache-fory #pdms #architecture #migration #blueprint  
> **Level:** Advanced  
> **Prerequisite:** [[11-Fory-XLang-Java-Go-Rust]]

---

## 🎯 Bạn sẽ học được gì?

- Blueprint tích hợp Fory vào PDMS từng layer
- Migration plan 4 phases với timeline thực tế
- Rollback strategy khi có sự cố
- Dependency graph: service nào deploy trước
- Risk assessment cho từng migration step
- Monitoring dashboard cần setup

---

## 🗺️ Phần 1 — PDMS Current State vs Target State

### Current State

```
┌──────────────────────────────────────────────────────────────────┐
│                    PDMS CURRENT STATE                            │
│                                                                  │
│  pdms-api-gateway                                                │
│  ├── Redis auth cache      → JDK Serialization ❌ (slow, large) │
│  └── Route cache           → Jackson JSON ❌ (verbose)           │
│                                                                  │
│  pdms-document-service                                           │
│  ├── Redis document cache  → Jackson JSON ❌ (~680B/obj)         │
│  ├── Kafka internal events → Jackson JSON ❌ (no schema track)   │
│  └── Session state         → JDK Serialization ❌               │
│                                                                  │
│  pdms-iam-service                                                │
│  ├── Permission cache      → Jackson JSON ❌                     │
│  └── Token cache           → JDK Serialization ❌               │
│                                                                  │
│  pdms-process-management                                         │
│  ├── Workflow state cache  → Jackson JSON ❌                     │
│  └── Task queue events     → Jackson JSON ❌                     │
│                                                                  │
│  Cross-service:                                                  │
│  ├── Kafka public topics   → Avro ✅ (giữ nguyên)               │
│  └── REST APIs             → JSON ✅ (giữ nguyên)               │
└──────────────────────────────────────────────────────────────────┘
```

### Target State

```
┌──────────────────────────────────────────────────────────────────┐
│                    PDMS TARGET STATE                             │
│                                                                  │
│  pdms-api-gateway                                                │
│  ├── Redis auth cache      → Fory native 🆕 (~40% smaller)      │
│  └── Route cache           → Fory native 🆕                     │
│                                                                  │
│  pdms-document-service                                           │
│  ├── Redis document cache  → Fory native 🆕 (~165B/obj)         │
│  ├── Kafka internal events → Fory compatible 🆕                 │
│  └── Session state         → Fory native 🆕                     │
│                                                                  │
│  pdms-iam-service                                                │
│  ├── Permission cache      → Fory native 🆕                     │
│  └── Token cache           → Fory native 🆕                     │
│                                                                  │
│  pdms-process-management                                         │
│  ├── Workflow state cache  → Fory compatible 🆕                 │
│  └── Task queue events     → Fory compatible 🆕                 │
│                                                                  │
│  Cross-service (unchanged):                                      │
│  ├── Kafka public topics   → Avro ✅                             │
│  └── REST APIs             → JSON ✅                             │
│                                                                  │
│  New (optional, phased):                                         │
│  └── Go/Rust internal svc  → Fory XLang 🆕                     │
└──────────────────────────────────────────────────────────────────┘
```

---

## 📅 Phần 2 — Migration Plan 4 Phases

### Phase Timeline

```
2026-Q2 Week 1-2:   Phase 1 — Foundation & pdms-iam-service
2026-Q2 Week 3-4:   Phase 2 — pdms-document-service cache
2026-Q3 Week 1-2:   Phase 3 — Kafka internal events
2026-Q3 Week 3-4:   Phase 4 — Cleanup & XLang (optional)
```

---

### Phase 1 — Foundation (Week 1–2)

**Mục tiêu:** Setup Fory infrastructure, migrate service ít risk nhất trước.

**Deliverables:**

```
1. Tạo fory-common module (shared Maven dependency)
   ├── ForyConfig.java
   ├── ForyRegistrar.java (tất cả domain classes)
   ├── ForyRedisSerializer.java (có magic prefix)
   └── type-registry.yml

2. Migrate pdms-iam-service (risk thấp nhất, isolated)
   ├── Permission cache: JDK Ser → Fory native
   └── Token cache: JDK Ser → Fory native

3. Setup monitoring baseline
   ├── Redis memory before (record metrics)
   ├── Cache hit rate before
   └── Serialize latency before
```

**Risk:** Thấp. IAM cache miss → re-validate token từ DB, không mất data.

**Rollback:** Xóa Fory dependency, revert cache serializer. Redis entries tự expire.

```java
// fory-common/pom.xml → parent dependency
// Tất cả services import:
<dependency>
    <groupId>com.vpbank.pdms</groupId>
    <artifactId>fory-common</artifactId>
    <version>${project.version}</version>
</dependency>
```

```java
// ForyRegistrar.java — centralized registry
public class ForyRegistrar {

    public static void registerAll(ThreadSafeFory fory) {
        registerIamDomain(fory);
        registerDocumentDomain(fory);
        registerProcessDomain(fory);
        registerJdkTypes(fory);
    }

    private static void registerIamDomain(ThreadSafeFory fory) {
        fory.register(UserPermission.class,     100);
        fory.register(RoleBinding.class,        101);
        fory.register(TokenClaims.class,        102);
        fory.register(PermissionSet.class,      103);
        fory.register(TenantContext.class,      104);
    }

    private static void registerDocumentDomain(ThreadSafeFory fory) {
        fory.register(CreditDocument.class,     110);
        fory.register(DocumentMetadata.class,   111);
        fory.register(DocumentStatus.class,     112);
        fory.register(WarehouseCode.class,      113);
        fory.register(CreditProfile.class,      114);
        fory.register(CollateralInfo.class,     115);
        fory.register(PagedDocuments.class,     116);
    }

    private static void registerProcessDomain(ThreadSafeFory fory) {
        fory.register(WorkflowState.class,      120);
        fory.register(ProcessTask.class,        121);
        fory.register(TaskResult.class,         122);
        fory.register(WorkflowStep.class,       123);
    }

    private static void registerJdkTypes(ThreadSafeFory fory) {
        fory.register(ArrayList.class,          130);
        fory.register(HashMap.class,            131);
        fory.register(HashSet.class,            132);
        fory.register(LinkedList.class,         133);
        fory.register(TreeMap.class,            134);
    }
}
```

---

### Phase 2 — Document Service Cache (Week 3–4)

**Mục tiêu:** Migrate pdms-document-service Redis cache. Đây là high-traffic, largest impact.

**Deliverables:**

```
1. Migrate document Redis cache: Jackson → Fory native
   └── Dùng magic prefix + JSON fallback (migration period)

2. Migrate session state cache

3. Validate metrics:
   ├── Redis memory giảm ≥ 40%
   ├── Cache hit rate không đổi
   └── Deserialization error rate = 0
```

**Risk:** Medium. Document cache miss → DB query, hơi chậm nhưng correct.

**Rollback trigger:** Error rate > 0.1% trong 5 phút → auto rollback qua feature flag.

```java
// Feature flag driven (dùng Spring @ConditionalOnProperty hoặc LaunchDarkly)
@Bean
@ConditionalOnProperty("fory.cache.enabled", havingValue = "true", matchIfMissing = false)
public ForyRedisSerializer foryRedisSerializer(ThreadSafeFory fory) {
    return new ForyRedisSerializer(fory);
}

@Bean
@ConditionalOnMissingBean(ForyRedisSerializer.class)
public JacksonRedisSerializer jacksonRedisSerializer() {
    return new JacksonRedisSerializer(); // fallback
}
```

**application.yml (per-environment):**

```yaml
# dev, staging: bật sớm để test
fory:
  cache:
    enabled: true
  migration:
    json-fallback-enabled: true  # true trong migration period

# production: bật sau khi staging ổn định 1 tuần
fory:
  cache:
    enabled: true
  migration:
    json-fallback-enabled: true
```

---

### Phase 3 — Kafka Internal Events (Week 5–6)

**Mục tiêu:** Migrate internal Kafka topics từ Jackson JSON sang Fory COMPATIBLE.

**Trình tự QUAN TRỌNG — Consumer deploy trước Producer:**

```
Day 1:  Deploy consumer v2 (hỗ trợ cả JSON fallback + Fory)
        ↓
        Test: consumer đọc JSON messages cũ → OK ✅

Day 3:  Monitor consumer v2 ổn định, không có error
        ↓
Day 5:  Deploy producer v2 (write Fory messages)
        ↓
        Consumer v2 đọc Fory messages → OK ✅
        JSON fallback rate trending → 0 (cũ hết TTL)

Day 14: Confirm fallback rate = 0
        ↓
Day 15: Remove JSON fallback code từ consumer
        Deploy consumer v3 (Fory only)
```

**Topics cần migrate:**

```
pdms.document.workflow.steps        (document-service internal)
pdms.process.task.events            (process-management internal)
pdms.iam.permission.sync            (iam-service internal)
pdms.document.status.changes        (document-service internal)
```

**KHÔNG migrate (giữ Avro):**

```
pdms.credit.events.public           (Analytics team reads)
pdms.document.audit.log             (Compliance reads)
pdms.report.generation.triggers     (Reporting service reads)
```

---

### Phase 4 — Cleanup & Optional XLang (Week 7–8)

**Mục tiêu:** Cleanup migration code, evaluate XLang nếu có Go/Rust services.

**Deliverables:**

```
1. Remove JSON fallback code từ tất cả services
2. Remove Kryo dependency (nếu có)
3. Update type-registry.yml → mark migration complete
4. Document final metrics (before vs after)

5. Optional: XLang cho Go analytics / Rust ML
   (chỉ nếu team đã có Go/Rust services)
```

---

## 🔄 Phần 3 — Rollback Strategy

### Auto-rollback via feature flags

```java
@Component
@RequiredArgsConstructor
@Slf4j
public class ForyHealthMonitor {

    private final MeterRegistry registry;
    private final FeatureFlagService featureFlags;

    // Check mỗi 30 giây
    @Scheduled(fixedDelay = 30_000)
    public void checkErrorRate() {
        double errorRate = getErrorRateLastMinute();

        if (errorRate > 0.001) { // > 0.1%
            log.error("Fory error rate too high: {}%. Triggering rollback!", errorRate * 100);
            featureFlags.disable("fory.cache.enabled");
            alertingService.page("Fory auto-rollback triggered");
        }
    }

    private double getErrorRateLastMinute() {
        Counter errors = registry.find("fory.deserialize.errors").counter();
        Counter total  = registry.find("fory.deserialize.total").counter();
        if (errors == null || total == null || total.count() == 0) return 0;
        return errors.count() / total.count();
    }
}
```

### Manual rollback steps

```bash
# Rollback Step 1: Disable Fory write via feature flag
curl -X POST http://pdms-config/flags/fory.cache.enabled -d '{"value": false}'

# Rollback Step 2: Flush Redis cache (force reload từ DB)
redis-cli -h pdms-redis FLUSHDB ASYNC
# Sau đó services sẽ tự warm lại cache với format cũ

# Rollback Step 3: Nếu cần full rollback service
kubectl rollout undo deployment/pdms-document-service
kubectl rollout undo deployment/pdms-iam-service

# Rollback Step 4: Verify
kubectl rollout status deployment/pdms-document-service
curl http://pdms-document-service/actuator/health
```

---

## 📊 Phần 4 — Monitoring Dashboard

### 4.1 Metrics cần track

```java
@Aspect
@Component
@RequiredArgsConstructor
public class ForyMetricsAspect {

    private final MeterRegistry registry;

    @Around("@annotation(ForyCacheable)")
    public Object trackCacheOperation(ProceedingJoinPoint pjp) throws Throwable {
        String cacheName = extractCacheName(pjp);
        Timer.Sample sample = Timer.start(registry);

        try {
            Object result = pjp.proceed();
            sample.stop(registry.timer("fory.cache.op",
                "cache", cacheName,
                "status", "success"));
            return result;
        } catch (Exception e) {
            registry.counter("fory.deserialize.errors",
                "cache", cacheName,
                "error", e.getClass().getSimpleName()).increment();
            throw e;
        }
    }
}
```

**Metrics list:**

```
fory_serialize_seconds{cache}          → Serialize latency histogram
fory_deserialize_seconds{cache}        → Deserialize latency histogram
fory_payload_bytes{cache}              → Payload size histogram
fory_deserialize_errors_total{cache}   → Error counter (phải = 0)
cache_hit_total{level, cache}          → L1/L2 hit rate
cache_migration_fallback_total{cache}  → JSON fallback rate (→ 0)
redis_memory_used_bytes                → Total Redis memory (giảm sau migration)
```

### 4.2 Grafana dashboard panels

```json
[
  {
    "title": "Fory Serialize Latency p99",
    "query": "histogram_quantile(0.99, rate(fory_serialize_seconds_bucket[5m]))",
    "alert": "> 1ms"
  },
  {
    "title": "Fory Error Rate",
    "query": "rate(fory_deserialize_errors_total[5m])",
    "alert": "> 0.001 (0.1%)"
  },
  {
    "title": "Cache Hit Rate L1+L2",
    "query": "rate(cache_hit_total[5m]) / rate(cache_requests_total[5m])",
    "alert": "< 0.85 (85%)"
  },
  {
    "title": "Migration Fallback Rate",
    "query": "rate(cache_migration_fallback_total[5m])",
    "note": "Phải giảm về 0 sau migration"
  },
  {
    "title": "Redis Memory Saved",
    "query": "redis_memory_used_bytes",
    "note": "Expect -40% sau Phase 2"
  },
  {
    "title": "Payload Size P95",
    "query": "histogram_quantile(0.95, fory_payload_bytes_bucket)",
    "note": "Expect < 250 bytes per object"
  }
]
```

---

## ⚠️ Phần 5 — Risk Register

```
┌──────────────────────────────────────────────────────────────────────┐
│                    RISK REGISTER                                     │
├────────────────────────┬──────────┬────────────┬────────────────────┤
│ Risk                   │ Prob     │ Impact     │ Mitigation         │
├────────────────────────┼──────────┼────────────┼────────────────────┤
│ Class not registered   │ Medium   │ High       │ CI test toàn bộ    │
│ (ClassNotRegistered    │          │ (Runtime   │ domain classes;    │
│ Exception)             │          │ exception) │ integration test   │
├────────────────────────┼──────────┼────────────┼────────────────────┤
│ Schema mismatch sau    │ Low      │ Medium     │ Compatible mode +  │
│ rolling deploy         │          │ (Cache     │ JSON fallback      │
│                        │          │ miss)      │ during migration   │
├────────────────────────┼──────────┼────────────┼────────────────────┤
│ Fory version upgrade   │ Low      │ Medium     │ Test fixture-based │
│ binary compat break    │          │            │ compat test in CI  │
├────────────────────────┼──────────┼────────────┼────────────────────┤
│ Circular reference in  │ Low      │ High       │ Unit test với      │
│ domain object          │          │ (Stack-    │ withRefTracking=T  │
│                        │          │ Overflow)  │ Scan domain model  │
├────────────────────────┼──────────┼────────────┼────────────────────┤
│ Non-static inner class │ Low      │ Medium     │ Code review check  │
│ không serialize được   │          │ (Exception)│ @ForyField("-")    │
├────────────────────────┼──────────┼────────────┼────────────────────┤
│ XLang type mismatch    │ Medium   │ High       │ type-registry.yml  │
│ Java-Go-Rust           │          │ (Silent    │ + integration test │
│                        │          │ wrong data)│ fixture files      │
└────────────────────────┴──────────┴────────────┴────────────────────┘
```

---

## 📋 Phần 6 — Definition of Done

Mỗi phase chỉ được close khi checklist này PASS:

```markdown
### Phase Done Checklist

#### Correctness
- [ ] Serialize/deserialize roundtrip test: PASS (unit + integration)
- [ ] Null field handling: PASS
- [ ] Circular reference test: PASS (nếu có circular ref trong domain)
- [ ] Schema evolution test: PASS (fixture-based compat test)
- [ ] Fory error rate = 0 trong 48h trên staging

#### Performance
- [ ] Serialize latency p99 < 500μs (cache path)
- [ ] Redis memory giảm ≥ 30% (so với before migration)
- [ ] Cache hit rate không giảm (so với before)
- [ ] No GC spike sau deployment

#### Observability
- [ ] Grafana dashboard deployed và alerting configured
- [ ] Fory error rate alert (> 0.1%) → PagerDuty
- [ ] Fallback rate alert (> 5%) → Slack warning

#### Documentation
- [ ] type-registry.yml updated và reviewed
- [ ] Migration notes added vào Confluence
- [ ] Rollback procedure tested trên staging
```

---

## ✅ Key Takeaways

- [ ] Migrate từ thấp risk → cao risk: IAM → Document → Kafka → XLang
- [ ] Feature flag là bắt buộc cho mọi production migration
- [ ] Luôn có JSON fallback trong migration period (magic prefix detect)
- [ ] Consumer deploy trước producer khi migrate Kafka topics
- [ ] Auto-rollback monitor error rate mỗi 30 giây
- [ ] "Done" chỉ khi cả correctness + performance + observability đều PASS

---

## 🔜 Bài tiếp theo

[[13-Fory-Performance-Benchmarks]] — Benchmark thực tế: JMH setup, so sánh số liệu đầy đủ Fory vs Kryo vs Jackson vs Avro vs Protobuf

---

## 📖 Tham khảo

- [[PDMS-Architecture-Overview]]
- [[06-Fory-Java-Spring-Redis-Cache]]
- [[07-Fory-Java-Kafka-Internal-Events]]
- [[11-Fory-XLang-Java-Go-Rust]]
