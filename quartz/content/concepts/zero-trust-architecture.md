# Zero Trust Architecture — Deep Dive

---
tags: [security, zero-trust, network, iam, microservices]
created: 2026-05-02
difficulty: advanced
estimated-read: 22 min
links: [[oauth2-oidc-deep-dive]], [[api-security-patterns]], [[opentelemetry-deep-dive]]

---

## 🎯 Learning Objectives

Sau bài này bạn sẽ:
- Hiểu **triết lý** Zero Trust và tại sao nó thay thế perimeter security
- Biết **5 pillars** của Zero Trust architecture
- Thiết kế được mô hình Zero Trust cho PDMS microservices
- Implement mTLS, identity-aware proxy, và least-privilege access

---

## 🧭 Từ Perimeter Security đến Zero Trust

### Mô hình cũ — Castle and Moat

```
┌─────────────────────────────────────────────────────────────┐
│               Perimeter Security (Old Model)                 │
│                                                             │
│  Internet    │  Firewall   │      Internal Network          │
│              │             │                               │
│  Attacker ───┤   "Wall"    │  Trust everyone inside!       │
│              │   ─────     │  ┌───────┐  ┌───────┐        │
│  Employee ───┤   (Moat)    │  │ DB    │  │ API   │        │
│   with VPN   │             │  └───────┘  └───────┘        │
│              │             │  ┌───────┐  ┌───────┐        │
│              │             │  │ File  │  │ Admin │        │
│              │             │  └───────┘  └───────┘        │
│                                                             │
│  Problem: Nếu attacker vào được "inside" → game over       │
│  Lateral movement tự do trong internal network!            │
└─────────────────────────────────────────────────────────────┘
```

### Tại sao Perimeter Security Thất Bại

```
Attack vectors bypassing perimeter:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Compromised VPN credentials → inside network
2. Phishing → employee laptop compromised → inside
3. Supply chain attack → trusted vendor → inside  
4. Insider threat → employee with bad intent → inside
5. Cloud misconfiguration → S3 bucket public → data leak

Kết quả thực tế:
- SolarWinds (2020): inside network → 18,000 organizations compromised
- Colonial Pipeline (2021): 1 compromised password → $4.4M ransom
```

### Zero Trust Manifesto

> **"Never trust, always verify"**
> **"Assume breach"**
> **"Verify explicitly, use least privilege, assume breach"**

```
┌─────────────────────────────────────────────────────────────┐
│                   Zero Trust Model                          │
│                                                             │
│  Không có "inside" hay "outside" network                   │
│  Mọi request đều phải được authenticated + authorized      │
│  Ngay cả từ internal services!                             │
│                                                             │
│  Service A ──request──► Service B                          │
│                              │                             │
│                              ▼ Verify:                     │
│                         1. Identity (who?)                  │
│                         2. Device health                   │
│                         3. Context (when? where? how?)     │
│                         4. Authorization (allowed?)        │
│                         → Only then: grant access          │
└─────────────────────────────────────────────────────────────┘
```

---

## 🏛️ 5 Pillars of Zero Trust

```
┌─────────────────────────────────────────────────────────────┐
│                  Zero Trust 5 Pillars                       │
│                                                             │
│  1. IDENTITY    2. DEVICE     3. NETWORK                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│  │Who are   │  │Is device │  │Micro-    │                 │
│  │you?      │  │healthy?  │  │segment-  │                 │
│  │AuthN/Z   │  │MDM/EDR   │  │ation     │                 │
│  │MFA       │  │Patch     │  │mTLS      │                 │
│  └──────────┘  └──────────┘  └──────────┘                 │
│                                                             │
│  4. APPLICATION              5. DATA                       │
│  ┌──────────────────┐       ┌──────────────────┐          │
│  │App-level AuthZ   │       │Data classification│          │
│  │WAF, API GW       │       │Encryption at rest │          │
│  │RBAC/ABAC         │       │DLP, tokenization  │          │
│  └──────────────────┘       └──────────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔐 Pillar 1: Identity — Strong Authentication

### Service Identity với mTLS

```
Service-to-service authentication trong microservices:

JWT Token approach (phổ biến nhưng thiếu):
  Service A → Service B + "Authorization: Bearer <jwt>"
  Vấn đề: Token bị stolen → attacker có thể impersonate A

mTLS approach (Zero Trust):
  Service A có Certificate (issued by internal CA)
  Service B có Certificate (issued by internal CA)
  Mutual verification: A verifies B, B verifies A
  → Private key không bao giờ rời khỏi service → unforgeable identity
```

### mTLS với Spring Boot và Istio

```yaml
# Istio PeerAuthentication — enforce mTLS
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: pdms
spec:
  mtls:
    mode: STRICT  # All pods phải dùng mTLS
```

```yaml
# AuthorizationPolicy — Service A chỉ được call Service B
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: pdms-document-policy
  namespace: pdms
spec:
  selector:
    matchLabels:
      app: pdms-document-service
  rules:
  - from:
    - source:
        principals:
        - "cluster.local/ns/pdms/sa/pdms-api-gateway"
        - "cluster.local/ns/pdms/sa/pdms-process-service"
    to:
    - operation:
        methods: ["GET", "POST"]
        paths: ["/api/v1/documents/*"]
```

### SPIFFE — Universal Identity for Workloads

```
SPIFFE (Secure Production Identity Framework for Everyone):
  Mỗi workload được cấp SVID (SPIFFE Verifiable Identity Document)
  
  SPIFFE ID format: spiffe://trust-domain/path
  PDMS example:
  - pdms-document-service: spiffe://vpbank.com/pdms/document-service
  - pdms-api-gateway: spiffe://vpbank.com/pdms/api-gateway
  
  Implemented by: Istio, SPIRE, Envoy
```

---

## 🌐 Pillar 3: Network — Microsegmentation

### Kubernetes NetworkPolicy

```yaml
# Chỉ cho phép traffic explicit
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: pdms-document-service-policy
  namespace: pdms
spec:
  podSelector:
    matchLabels:
      app: pdms-document-service
  
  # Ingress rules — ai được gọi vào service này
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: pdms-api-gateway    # Chỉ từ API Gateway
    - podSelector:
        matchLabels:
          app: pdms-process-service # Và Process Service
    ports:
    - protocol: TCP
      port: 8080
  
  # Egress rules — service này được gọi ra đâu
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: postgres-primary    # Chỉ tới DB
    ports:
    - protocol: TCP
      port: 5432
  - to:
    - podSelector:
        matchLabels:
          app: pdms-iam-service    # Và IAM service
    ports:
    - protocol: TCP
      port: 8080
  
  policyTypes:
  - Ingress
  - Egress
```

---

## 🛡️ Pillar 4: Application — Identity-Aware Proxy

### Zero Trust Application Access Flow

```
┌─────────────────────────────────────────────────────────────────┐
│               PDMS Zero Trust Request Flow                       │
│                                                                  │
│  User (Browser/App)                                              │
│       │                                                          │
│       ▼                                                          │
│  Identity Provider (Keycloak)  ← Step 1: AuthN + MFA            │
│       │                                                          │
│       │  Access Token (JWT)                                      │
│       ▼                                                          │
│  API Gateway (Spring Cloud Gateway)  ← Step 2: Verify JWT       │
│       │                                                          │
│       │ Extract claims: user_id, roles, branch_id, tenant_id    │
│       ▼                                                          │
│  Policy Engine (OPA/jCasbin)  ← Step 3: AuthZ decision         │
│       │                                                          │
│       │ Allow/Deny based on: role + resource + action + context  │
│       ▼                                                          │
│  Backend Service  ← Step 4: Process request với verified context │
└─────────────────────────────────────────────────────────────────┘
```

### OPA (Open Policy Agent) — Policy as Code

```rego
# pdms-policy.rego — OPA policy
package pdms.authz

import future.keywords

# Default deny
default allow = false

# Allow if all conditions met
allow if {
    # User is authenticated
    input.user.authenticated == true
    
    # User has required role
    required_role := role_for_action[input.action]
    required_role in input.user.roles
    
    # User can access this tenant
    input.user.tenant_id == input.resource.tenant_id
    
    # Not outside working hours for sensitive operations
    not sensitive_outside_hours
}

# Role requirements per action
role_for_action := {
    "document:read":   "ROLE_VIEWER",
    "document:create": "ROLE_CREATOR",
    "document:approve": "ROLE_APPROVER",
    "document:delete": "ROLE_ADMIN",
}

# Sensitive operations only during business hours (UTC+7)
sensitive_outside_hours if {
    input.action in {"document:delete", "document:approve"}
    current_hour := time.clock(time.now_ns())[0]
    not is_business_hour(current_hour)
}

is_business_hour(hour) if {
    hour >= 8   # 8 AM ICT
    hour < 17   # 5 PM ICT
}
```

```java
// Spring Boot + OPA integration
@Component
public class OpaAuthorizationFilter implements WebFilter {
    
    private final WebClient opaClient;
    
    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        Authentication auth = extractAuthentication(exchange);
        String resource = extractResource(exchange);
        String action = extractAction(exchange);
        
        OpaRequest request = OpaRequest.builder()
            .user(OpaUser.from(auth))
            .resource(resource)
            .action(action)
            .build();
        
        return opaClient.post()
            .uri("/v1/data/pdms/authz/allow")
            .bodyValue(Map.of("input", request))
            .retrieve()
            .bodyToMono(OpaResponse.class)
            .flatMap(response -> {
                if (response.isAllow()) {
                    return chain.filter(exchange);
                }
                exchange.getResponse().setStatusCode(HttpStatus.FORBIDDEN);
                return exchange.getResponse().setComplete();
            });
    }
}
```

---

## 🔒 Pillar 5: Data — Encryption & Classification

### Data Classification

```
PDMS Data Classification:
┌─────────────────────────────────────────────────────────────┐
│ Classification │ Examples                 │ Controls        │
├────────────────┼──────────────────────────┼─────────────────┤
│ PUBLIC         │ System announcements      │ None required   │
│ INTERNAL       │ Document metadata         │ Auth required   │
│ CONFIDENTIAL   │ Contract documents        │ Auth + Audit    │
│ RESTRICTED     │ CIF data, salary info     │ Auth+Audit+Encrypt+MFA│
└─────────────────────────────────────────────────────────────┘
```

### Encryption at Rest

```yaml
# PostgreSQL: Column-level encryption for sensitive fields
# pgcrypto extension

# Encrypt when storing:
UPDATE customers 
SET tax_id = pgp_sym_encrypt(
    '0123456789',
    current_setting('app.encryption_key')
)
WHERE id = 123;

# Decrypt when reading (only authorized service):
SELECT pgp_sym_decrypt(
    tax_id::bytea,
    current_setting('app.encryption_key')
) AS tax_id
FROM customers WHERE id = 123;
```

### Secrets Management

```yaml
# Kubernetes + Vault (HashiCorp) — không hardcode secrets
# Never: environment variables với plaintext passwords
# Always: dynamic secrets fetched at runtime

# Vault Agent Sidecar Injection:
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pdms-document-service
spec:
  template:
    metadata:
      annotations:
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: "pdms-document-service"
        vault.hashicorp.com/agent-inject-secret-db: "pdms/data/database"
        vault.hashicorp.com/agent-inject-template-db: |
          {{- with secret "pdms/data/database" -}}
          spring.datasource.password={{ .Data.data.password }}
          {{- end -}}
```

---

## 📊 Zero Trust Maturity Model

```
Level 0 — Traditional (Perimeter)
  ✗ Implicit trust inside network
  ✗ VPN = full access
  ✗ Shared credentials
  
Level 1 — Basic Zero Trust
  ✓ MFA for user access
  ✓ JWT for service authentication
  ✓ Basic network segmentation
  
Level 2 — Intermediate
  ✓ mTLS for service-to-service
  ✓ RBAC with central policy
  ✓ Encrypted secrets management
  ✓ Audit logging all access
  
Level 3 — Advanced (Optimal target)
  ✓ SPIFFE/SPIRE workload identity
  ✓ Policy as Code (OPA)
  ✓ Continuous verification (re-auth on risk signals)
  ✓ Data classification + field-level encryption
  ✓ Behavioral analytics
```

---

## 📚 Case Study — PDMS Zero Trust Implementation

### Tình huống: VPBank Security Audit

**Audit finding:** pdms-process-service có thể trực tiếp query `customers` table trong pdms-iam-service database — không qua API.

**Risk:** Service bị compromise → toàn bộ customer data exposed.

### Remediation Plan

```
Bước 1: Network Segmentation
  NetworkPolicy: pdms-process-service → blocked từ postgres-iam
  Chỉ pdms-iam-service → được access postgres-iam

Bước 2: Service Identity
  Istio PeerAuthentication: STRICT mTLS trong namespace pdms
  AuthorizationPolicy: pdms-process-service chỉ được call
    pdms-iam-service /api/v1/internal/customer-info endpoint

Bước 3: Least Privilege API
  pdms-iam-service expose endpoint trả về minimum data cần thiết
  pdms-process-service không cần tax_id, salary → không get them
  
Bước 4: Audit Trail
  Mọi call đến /api/v1/internal/* → audit log với caller identity
  OTel trace: full request path từ user → api-gw → process-svc → iam-svc

Kết quả: Attack surface giảm, blast radius limited nếu process-svc bị compromise
```

---

## 🔑 Key Takeaways

1. **Zero Trust ≠ No Trust** — trust được granted explicitly, không implicitly
2. **Identity là perimeter mới** — không phải network boundary
3. **mTLS** cho service-to-service: mutual authentication, phòng impersonation
4. **Microsegmentation** bằng NetworkPolicy + Istio AuthorizationPolicy — deny by default
5. **Least privilege** — mỗi service chỉ access những gì nó cần, không hơn
6. **Policy as Code** (OPA) — centralized, testable, versionable authorization logic
7. **Assume breach:** thiết kế như thể attacker đã vào — limit lateral movement
8. Zero Trust là **hành trình**, không phải destination — implement từng pillar

---

## 🔗 Related Links

- [[oauth2-oidc-deep-dive]] — Identity pillar: AuthN/AuthZ foundation
- [[api-security-patterns]] — Application pillar: API-level security controls
- [[opentelemetry-deep-dive]] — Audit trail và visibility cho Zero Trust
- [[ddd-strategic]] — Bounded Context giúp define segmentation boundaries
