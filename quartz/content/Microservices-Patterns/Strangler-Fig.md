---
tags: [microservices, patterns, strangler-fig, migration, monolith, anti-corruption-layer]
up: "[[05-Decomposition]]"
related: "[[Database-per-Service]], [[Transactional-Outbox]], [[CQRS-Materialized-View]]"
---

# 🌿 Strangler Fig Pattern

> **TL;DR:** Thay vì rewrite toàn bộ monolith một lần (big bang — cực kỳ rủi ro), dần dần "bóc" từng tính năng ra thành microservice mới. Monolith co lại dần, service mới phình ra. Cuối cùng monolith bị "siết chết" như cây sung siết cây chủ.

---

## 🎯 Problem: Big Bang Rewrite

```
❌ "Hãy rewrite toàn bộ hệ thống trong 6 tháng"

Thực tế:
  - Tháng 1-3: Dev team bận rewrite, production không ai maintain
  - Tháng 4: Nhận ra đã miss nhiều business rules ngầm trong legacy code
  - Tháng 5: Deadline trượt, scope cắt giảm
  - Tháng 6: Release hệ thống mới → bugs không lường trước
  - Tháng 7: Rollback về monolith, team mất tinh thần

Thống kê: ~70% các dự án big bang rewrite thất bại
```

---

## ✅ Solution: Strangler Fig — migration từng bước

**Nguyên tắc:** Tại bất kỳ thời điểm nào, production system vẫn chạy bình thường. Mỗi bước migrate là một unit nhỏ, có thể rollback độc lập.

```
Step 0: Hiện trạng
  [All traffic] → [Monolith] → [Legacy DB]

Step 1: Đặt Proxy/API Gateway trước monolith (không thay đổi monolith)
  [All traffic] → [API Gateway] → [Monolith] → [Legacy DB]

Step 2: Tạo service mới, route một endpoint sang
  [All traffic] → [API Gateway]
                      ├─ GET /documents/**  → [Document Service] → [New DB]
                      └─ /**               → [Monolith]

Step 3: Migrate thêm features, shrink monolith
  [All traffic] → [API Gateway]
                      ├─ /documents/**  → [Document Service]
                      ├─ /credits/**    → [Credit Service]
                      └─ /**            → [Monolith] (nhỏ dần)

Step N: Monolith chỉ còn 1-2 tính năng → decommission
  [All traffic] → [API Gateway]
                      ├─ /documents/**  → [Document Service]
                      ├─ /credits/**    → [Credit Service]
                      └─ /workflows/**  → [Workflow Service]
```

---

## 🏗️ Implementation: Các kỹ thuật

### 1. HTTP Routing tại API Gateway (approach phổ biến nhất)

```yaml
# Spring Cloud Gateway — route theo path prefix
spring:
  cloud:
    gateway:
      routes:
        # Tính năng đã migrate → service mới
        - id: document-service
          uri: lb://document-service
          predicates:
            - Path=/api/v2/documents/**   # v2 = new service
          
        # Tính năng chưa migrate → monolith
        - id: legacy-monolith
          uri: http://monolith:8080
          predicates:
            - Path=/api/**                # fallthrough
          order: 999                      # priority thấp nhất
```

**Feature flag routing** — migrate dần theo % traffic:

```java
@Component
public class CanaryGatewayFilter implements GatewayFilter {
    
    @Value("${feature.new-document-service.percentage:0}")
    private int percentage;  // 0→5→25→50→100 qua các sprint
    
    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        ServerHttpRequest request = exchange.getRequest();
        
        if (request.getPath().value().startsWith("/api/documents")) {
            // Route X% traffic sang service mới
            if (ThreadLocalRandom.current().nextInt(100) < percentage) {
                // Forward to new Document Service
                return forwardToNewService(exchange, chain);
            }
        }
        return chain.filter(exchange);  // Monolith
    }
}
```

---

### 2. Anti-Corruption Layer (ACL)

Khi service mới cần data từ monolith, tuyệt đối **không để domain model của monolith leak vào service mới**. ACL là translation layer.

```java
// ❌ WRONG: Dùng trực tiếp legacy model
public class DocumentService {
    public Document createDocument(HopDongLegacyDTO legacy) {
        // Domain model của service mới bị polluted bởi legacy naming
        document.setMaHopDong(legacy.getMaHD());  // "MaHD" là legacy concept
        document.setLoaiHD(legacy.getLoai());
    }
}

// ✅ CORRECT: Anti-Corruption Layer translate
@Component
public class LegacyCreditSystemAdapter {
    private final LegacyCreditApiClient legacyClient;
    
    // Translate từ legacy model sang domain model mới
    public CreditAccount getCreditAccount(String legacyContractId) {
        LegacyCreditDTO legacy = legacyClient.fetchByContractId(legacyContractId);
        
        return CreditAccount.builder()
            .id(AccountId.of(legacy.getSO_TK()))              // "SO_TK" → AccountId
            .customerId(CustomerId.of(legacy.getMa_KH()))     // "Ma_KH" → CustomerId
            .outstandingBalance(Money.of(
                legacy.getDU_NO(), Currency.VND              // "DU_NO" → balance
            ))
            .accountType(mapAccountType(legacy.getLOAI_TK())) // enum mapping
            .status(mapStatus(legacy.getTRANG_THAI()))
            .build();
    }
    
    private AccountType mapAccountType(String legacyType) {
        return switch (legacyType) {
            case "VL"  -> AccountType.REVOLVING_CREDIT;
            case "TU"  -> AccountType.TERM_LOAN;
            case "OD"  -> AccountType.OVERDRAFT;
            default    -> AccountType.UNKNOWN;
        };
    }
}
```

---

### 3. Dual Write — Synchronize data trong giai đoạn chuyển tiếp

Khi một tính năng chạy song song (monolith + new service), cần keep data in sync:

```java
@Service
@RequiredArgsConstructor
public class DocumentService {
    
    private final DocumentRepository newRepository;
    private final LegacyDocumentClient legacyClient;
    
    @Value("${feature.dual-write.enabled:false}")
    private boolean dualWriteEnabled;
    
    @Transactional
    public Document createDocument(CreateDocumentCommand cmd) {
        // 1. Write vào new service (primary)
        Document doc = newRepository.save(Document.from(cmd));
        
        // 2. Write vào legacy (secondary) — không fail nếu legacy lỗi
        if (dualWriteEnabled) {
            try {
                legacyClient.createDocument(toLegacyDTO(doc));
            } catch (Exception e) {
                log.error("Dual-write to legacy failed for doc {}: {}",
                    doc.getId(), e.getMessage());
                // Không throw — legacy write là best-effort
                // Monitor metric này để biết sync rate
                meterRegistry.counter("dual.write.legacy.failures").increment();
            }
        }
        
        return doc;
    }
}
```

**Verification job — kiểm tra data consistency:**

```java
@Scheduled(cron = "0 3 * * * *")  // 3am hàng ngày
public void verifyDataConsistency() {
    // So sánh counts
    long newCount = documentRepository.count();
    long legacyCount = legacyClient.getDocumentCount();
    
    if (Math.abs(newCount - legacyCount) > ACCEPTABLE_DELTA) {
        alertService.sendAlert(
            String.format("Data sync gap: new=%d, legacy=%d", newCount, legacyCount),
            AlertSeverity.HIGH
        );
    }
    
    // Sample 100 records ngẫu nhiên, so sánh chi tiết
    List<String> sampleIds = documentRepository.findRandomIds(100);
    sampleIds.forEach(id -> compareDocument(id));
}
```

---

### 4. Strangler với Event Sourcing/CDC

Cho data migration lớn (10M+ records như PDMS):

```
Phase 1: CDC capture changes từ legacy DB
  Legacy DB → Debezium → Kafka → New Service DB
  (New service nhận real-time changes từ legacy)

Phase 2: Backfill historical data
  Legacy DB → Batch import job → New Service DB
  (Chạy song song, xử lý từng chunk 10K records)

Phase 3: Cutover
  - Tắt dual write về legacy
  - API Gateway route 100% về new service
  - Legacy trở thành read-only backup

Phase 4: Decommission
  - Legacy shutdown sau 30 ngày không có incident
```

---

## 📋 Migration Checklist

Trước khi migrate một tính năng:

```
□ Business logic được document đầy đủ (kể cả hidden rules trong legacy code)
□ Test suite coverage >= 80% cho tính năng cần migrate
□ Feature flag đã sẵn sàng để rollback nhanh
□ Monitoring/alerting đã setup cho service mới
□ Anti-Corruption Layer đã test với production-like data
□ Dual-write verification job đang chạy và báo cáo OK
□ Team agreed on rollback criteria (error rate > X% → rollback)
□ Runbook đã viết cho scenario phổ biến
```

---

## ⚖️ Trade-offs

| ✅ Lợi | ⚠️ Chi phí |
|---|---|
| Zero downtime migration | Thời gian dài hơn big bang |
| Rollback bất kỳ lúc nào | Giai đoạn transitional: maintain 2 systems |
| Rủi ro được chia nhỏ | Dual-write logic phức tạp |
| Business không bị interrupt | Cần discipline — dễ "never finish" |
| Validate từng bước trước khi tiếp | Data sync bugs khó phát hiện |

---

## 🏦 PDMS Migration Roadmap

```
Legacy: credit system với stored procedures PostgreSQL

Q2/2026 — Document Service
  ├── Setup API Gateway trước legacy
  ├── Tạo Document Service + DB mới
  ├── ACL để gọi legacy credit data
  ├── Dual-write: mọi create/update đi cả 2 nơi
  ├── Route /api/v2/documents → new service (10% → 50% → 100%)
  └── Verify data consistency daily

Q3/2026 — Credit Service  
  ├── CDC với Debezium: legacy credit_db → Kafka → new credit_db
  ├── Backfill 10M+ records (batch job, 50K records/chunk)
  ├── Dual-write cutover
  └── Route /api/v2/credits → new service

Q4/2026 — Workflow Service
  └── Tương tự, migrate workflow engine

2027 Q1 — Decommission
  └── Legacy read-only → shutdown
```

---

## 🔗 Liên kết
- [[05-Decomposition]] — Decomposition patterns group
- [[Database-per-Service]] — New service cần DB riêng ngay từ đầu
- [[CQRS-Materialized-View]] — Build read models từ CDC events trong migration
- [[Transactional-Outbox]] — Đảm bảo dual-write consistency
- [[Circuit-Breaker]] — Bảo vệ new service gọi legacy
