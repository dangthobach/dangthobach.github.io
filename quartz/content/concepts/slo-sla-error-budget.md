# SLO, SLA & Error Budget — Deep Dive

---
tags: [observability, sre, slo, sla, reliability, operations]
created: 2026-05-02
difficulty: intermediate
estimated-read: 18 min
links: [[opentelemetry-deep-dive]], [[kubernetes-architecture]], [[four-golden-signals]]

---

## 🎯 Learning Objectives

Sau bài này bạn sẽ:
- Phân biệt được **SLI, SLO, SLA** — 3 khái niệm hay bị nhầm lẫn
- Thiết kế **SLO hợp lý** cho hệ thống banking như PDMS
- Hiểu và tính được **Error Budget** để cân bằng reliability vs velocity
- Implement SLO monitoring với Prometheus + Grafana

---

## 📐 SLI, SLO, SLA — Phân Biệt

```
┌─────────────────────────────────────────────────────────────────┐
│                    SLI → SLO → SLA Hierarchy                    │
│                                                                  │
│  SLI (Service Level Indicator)                                   │
│  "Số đo thực tế của behavior hệ thống"                          │
│  Ví dụ: 99.2% requests thành công trong tuần qua               │
│                          │                                       │
│                          │ measured against                      │
│                          ▼                                       │
│  SLO (Service Level Objective)                                   │
│  "Mục tiêu nội bộ của team"                                     │
│  Ví dụ: 99.5% requests phải thành công                          │
│                          │                                       │
│                          │ formalized as                         │
│                          ▼                                       │
│  SLA (Service Level Agreement)                                   │
│  "Cam kết pháp lý với khách hàng, có penalty nếu vi phạm"      │
│  Ví dụ: 99.0% availability hoặc hoàn tiền 10%                  │
│                                                                  │
│  SLO > SLA (safety margin!)                                     │
│  SLO vi phạm → warning                                          │
│  SLA vi phạm → penalty, legal consequence                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📊 SLI — Đo Cái Gì?

### Good SLI characteristics

```
✓ Measured from user perspective (không phải server perspective)
✓ Directly relates to user happiness
✓ Quantifiable and measurable
✓ Actionable when violated
```

### 4 loại SLI phổ biến

```
┌──────────────┬─────────────────────────────────┬──────────────────────────┐
│ SLI Type     │ Definition                      │ PDMS Example              │
├──────────────┼─────────────────────────────────┼──────────────────────────┤
│ Availability │ % time service is up            │ HTTP success rate ≥99.5% │
│ Latency      │ % requests under threshold      │ 95th percentile < 500ms  │
│ Throughput   │ Operations per second           │ ≥ 100 doc uploads/min    │
│ Error Rate   │ % requests returning error      │ Error rate < 0.5%        │
└──────────────┴─────────────────────────────────┴──────────────────────────┘
```

### Công thức SLI chuẩn

```
Availability SLI = good_requests / total_requests

Where good_request = HTTP status 2xx or 3xx
                   (exclude client errors 4xx — those are user's fault)

Latency SLI = requests_under_threshold / total_requests

Example:
  Total requests = 10,000
  Requests completed < 500ms = 9,750
  Latency SLI = 9750 / 10000 = 97.5%
```

---

## 🎯 SLO — Đặt Mục Tiêu Đúng

### Bao nhiêu 9s là đủ?

```
┌────────────┬──────────────────────────────────────────┐
│ SLO        │ Allowed downtime per year                │
├────────────┼──────────────────────────────────────────┤
│ 90%        │ 36.5 days (horrible!)                    │
│ 99%        │ 3.65 days (87.6 hours)                  │
│ 99.5%      │ 1.83 days (43.8 hours)                  │
│ 99.9%      │ 8.76 hours  ← "Three nines"             │
│ 99.95%     │ 4.38 hours  ← Good target cho PDMS      │
│ 99.99%     │ 52.6 minutes ← "Four nines" (expensive!)│
│ 99.999%    │ 5.26 minutes ← Very hard, very costly   │
└────────────┴──────────────────────────────────────────┘
```

> **Banking context:** Không phải "cứ 5 nines là tốt nhất". 99.99% tốn tiền hơn nhiều so với 99.9% — và cần cân bằng với cost, velocity, business need.

### PDMS SLO Definitions

```yaml
# pdms-slo.yaml

service: PDMS Document Management System

SLOs:
  document_api_availability:
    description: "Document API returns successful responses"
    SLI: |
      sum(rate(http_requests_total{service="pdms-document",code!~"5.."}[5m]))
      /
      sum(rate(http_requests_total{service="pdms-document"}[5m]))
    target: 99.5%  # 43.8 hours downtime/year allowed
    window: 30d
    
  document_api_latency:
    description: "90% of Document API requests complete within 500ms"
    SLI: |
      histogram_quantile(0.90, 
        rate(http_request_duration_seconds_bucket{
          service="pdms-document"
        }[5m])
      ) < 0.5
    target: 99%
    window: 30d
    
  document_upload_success:
    description: "Document uploads complete successfully"
    SLI: |
      sum(rate(document_upload_total{status="success"}[5m]))
      /
      sum(rate(document_upload_total[5m]))
    target: 99.9%
    window: 30d
    
  warehouse_search_latency:
    description: "Warehouse search returns in <2s"
    SLI: |
      histogram_quantile(0.95,
        rate(http_request_duration_seconds_bucket{
          service="pdms-document", path="/api/v1/warehouses/search"
        }[5m])
      ) < 2.0
    target: 95%
    window: 30d
```

---

## 💰 Error Budget — Cân Bằng Reliability và Velocity

### Error Budget là gì?

```
Error Budget = 1 - SLO target

Example:
  SLO = 99.5% availability
  Error Budget = 0.5% = 0.005
  
  Per month (30 days = 43200 minutes):
  Error Budget = 43200 * 0.005 = 216 minutes/month
  
  Ý nghĩa: Service được phép down tổng cộng 216 phút/tháng
  mà không vi phạm SLO
```

### Error Budget = Development Currency

```
┌─────────────────────────────────────────────────────────────────┐
│                    Error Budget Decision Framework               │
│                                                                  │
│  Error Budget còn nhiều:                                        │
│  ✓ Deploy feature mới (có thể introduce bugs)                   │
│  ✓ Experiment với new technology                                │
│  ✓ Performance improvement (có thể disrupt)                     │
│  ✓ Architecture migration                                        │
│                                                                  │
│  Error Budget gần cạn (< 10% remaining):                        │
│  ⚠ Slow down deploys                                            │
│  ⚠ Focus on reliability improvements                            │
│  ⚠ No risky changes                                             │
│                                                                  │
│  Error Budget cạn kiệt (0% remaining):                          │
│  ✗ Feature freeze                                               │
│  ✗ Only reliability/bug fixes                                   │
│  ✗ Post-mortem required                                         │
│  ✗ SLA violation risk → escalate to management                  │
└─────────────────────────────────────────────────────────────────┘
```

### Error Budget burn rate

```
Burn rate = Error Budget consumed / Time elapsed

Normal burn rate = 1.0 (consuming budget at exact SLO pace)
Burn rate = 2.0 → consuming 2x faster than normal → will exhaust early!

Alert rules:
  Fast burn: burn rate > 14.4 over 1h  → CRITICAL alert (1 hour left!)
  Slow burn: burn rate > 6   over 6h   → WARNING alert
  
  Why 14.4?
  14.4x burn rate over 1h = 1/720 of monthly budget consumed in 1h
  = budget exhausted in 72 hours if unchanged
```

---

## 📈 Prometheus SLO Implementation

```yaml
# prometheus-rules.yml

groups:
- name: pdms-slo-rules
  rules:
  
  # --- Availability SLI ---
  - record: pdms:document_api:availability:rate5m
    expr: |
      sum(rate(http_requests_total{service="pdms-document",code!~"5.."}[5m]))
      /
      sum(rate(http_requests_total{service="pdms-document"}[5m]))
  
  # --- Error Budget Burn Rate ---
  - record: pdms:document_api:error_budget_burn:rate1h
    expr: |
      (
        1 - pdms:document_api:availability:rate5m
      ) / (1 - 0.995)  # 0.995 = SLO target
  
  # --- Alerts ---
  - alert: PDMSDocumentAPIFastBurn
    expr: |
      pdms:document_api:error_budget_burn:rate1h > 14.4
    for: 2m
    labels:
      severity: critical
      team: pdms
    annotations:
      summary: "PDMS Document API burning error budget too fast"
      description: |
        Current burn rate: {{ $value }}x (threshold: 14.4x)
        Estimated time to budget exhaustion: {{ ... }}
        Runbook: https://wiki.vpbank.com/pdms/runbook/api-outage

  - alert: PDMSDocumentAPISlowBurn
    expr: |
      pdms:document_api:error_budget_burn:rate1h > 6
    for: 15m
    labels:
      severity: warning
    annotations:
      summary: "PDMS Document API error budget burn rate elevated"
```

---

## 📊 Grafana SLO Dashboard

```
┌─────────────────────────────────────────────────────────────────┐
│              PDMS SLO Dashboard                                  │
│                                                                  │
│  Document API Availability (30d)                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Current: 99.67% ████████████████████░░░ Target: 99.5%  │    │
│  │ Status: ✅ WITHIN SLO                                    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Error Budget Remaining (30d)                                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Used: 47% (101 / 216 minutes)                           │    │
│  │ Remaining: 53% (115 minutes)                            │    │
│  │ Days elapsed: 16/30 (53%)                               │    │
│  │ Status: ✅ ON TRACK (budget consumed ≈ time elapsed)    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Latency P90 (7d)                                               │
│  234ms ─────────────────────────────────── Target: 500ms       │
│                                                                  │
│  Burn Rate (1h)                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │       2.3x                                              │    │
│  │  ─────────── Threshold 6x (warning)                    │    │
│  │  ─────────── Threshold 14.4x (critical)                │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔄 SLO Review Process

```
Monthly SLO Review Meeting Agenda:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Error Budget Report (15 min)
   - Budget consumed vs target
   - Top incidents contributing to consumption
   
2. SLO Target Review (10 min)
   - Is the target appropriate?
   - Too tight = always stressed, no room for feature work
   - Too loose = unhappy users, SLA violation risk

3. Action Items (20 min)
   - If budget consumed < 50%: OK to take risks (new features, migrations)
   - If budget consumed > 80%: Reliability sprint next month
   - If SLA violated: Root cause + prevention plan

4. SLO Adjustments (10 min)
   - New features affecting baseline?
   - Seasonal patterns (year-end banking = higher load)?
```

---

## 📚 Case Study — PDMS SLO Incident

### Incident: Document Upload API Degraded (2025-10-15)

```
Timeline:
  09:00  Deploy of pdms-document-service v2.3.1
  09:15  Error rate spikes to 8% (burn rate = 16x → CRITICAL alert)
  09:20  On-call receives PagerDuty notification
  09:25  Root cause identified: DB connection pool exhausted
         (new batch feature opened connections but didn't close)
  09:35  Hotfix deployed — error rate returns to 0.1%
  
Error Budget Impact:
  - 35 minutes of elevated errors @ 8% error rate
  - Budget consumed: 35 * 8% / 0.5% = 56 minutes equivalent
  - Monthly budget: 216 minutes → 56 minutes consumed in 35 min
  - Remaining budget before incident: 68% → after: 42%
  
Post-mortem:
  - Add connection pool monitoring to deployment checklist
  - Canary deployment for connection pool changes
  - Improve load testing to catch connection exhaustion
```

---

## 🔑 Key Takeaways

1. **SLI** = đo thực tế, **SLO** = target nội bộ, **SLA** = cam kết pháp lý
2. **SLO > SLA** — safety margin để không vi phạm SLA khi SLO bị miss
3. **Error Budget** = 1 - SLO = "currency" để spend on risk-taking
4. **Burn rate** quan trọng hơn absolute error count — phát hiện sớm trend
5. **SLO không phải 100%** — 100% không thể đạt được và cực kỳ đắt
6. **Feature freeze** khi error budget exhausted — reliability trước velocity
7. SLO phải được **review monthly** — business context thay đổi → SLO thay đổi
8. **Alert on burn rate**, không alert on SLI violation trực tiếp — tránh alert fatigue

---

## 🔗 Related Links

- [[opentelemetry-deep-dive]] — Thu thập SLI metrics với OTel
- [[four-golden-signals]] — SLI thường được đo qua 4 golden signals
- [[kubernetes-architecture]] — SLO trong K8s: PodDisruptionBudget
- [[container-internals]] — Health checks và readiness probes ảnh hưởng SLI
