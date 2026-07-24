---
tags: [moc, scalability, performance, infrastructure]
type: moc
domain: knowledge-management
status: active
created: 2026-04-12
updated: 2026-04-12
---

# ⚡ MOC — Scalability & Infrastructure

> **Mục tiêu:** Hiểu các chiến lược scaling từ application layer đến data layer đến infrastructure. Liên kết với bài toán high-concurrency trong PDMS (10M+ records).

---

## 📐 Scalability Fundamentals

- [[A Crash Course on Architectural Scalability|Architectural Scalability Crash Course]]
  → Vertical vs Horizontal scaling. Stateless vs Stateful services. Scale-out bottlenecks. Amdahl's Law.
- [[Top Scalability Strategies for Real-World Load|Top Scalability Strategies]]
  → Caching, CDN, async processing, DB read replicas, sharding, queue-based load leveling. Priority order.
- [[Stateless Architecture- The Key to Building Scalable and Resilient Systems|Stateless Architecture]]
  → Session externalization (Redis), JWT vs server-side session, sticky sessions anti-pattern. **Core principle của microservices.**
- [[Non-Functional Requirements- The Backbone of Great Software - Part 1|NFR Part 1 — Fundamentals]]
  → Availability, Reliability, Scalability, Performance, Security. Cách đo và đặt mục tiêu (SLA/SLO/SLI).
- [[Non-Functional Requirements- The Backbone of Great Software - Part 2|NFR Part 2 — Advanced]]
  → Observability, Maintainability, Testability, Cost efficiency. Non-functional requirements trong architecture decision.

---

## 🔄 Load Balancing

- [[A Crash Course on Load Balancers for Scaling|Load Balancers for Scaling]]
  → L4 vs L7 load balancer. Algorithms: Round Robin, Least Connections, IP Hash. Health checks.
- [[Understanding Load Balancers- Traffic Management at Scale|Load Balancers — Traffic at Scale]]
  → Nginx, HAProxy, AWS ALB/NLB. Sticky sessions, SSL offloading, connection draining (graceful shutdown).

---

## 💾 Caching

- [[A Guide to Top Caching Strategies|Top Caching Strategies]]
  → Cache-aside (lazy loading), Read-through, Write-through, Write-behind. Khi nào dùng cái nào.
- [[Distributed Caching- The Secret to High-Performance Applications|Distributed Caching]]
  → Redis vs Memcached. Cache invalidation — "the hardest problem in CS". Cache stampede prevention.

---

## 🌍 CDN & Networking

- [[A Detailed Guide to Content Delivery Networks|CDN Guide — Detailed]]
  → Edge nodes, PoP (Point of Presence), cache TTL, origin pull vs push. CloudFront, Cloudflare, Fastly.
- [[A Crash Course in Networking|Networking Crash Course]]
  → OSI model thực tế: L3 (IP routing), L4 (TCP/UDP), L7 (HTTP). Subnets, VPC, NAT.
- [[A Crash Course in IPv4 Addressing|IPv4 Addressing]]
  → CIDR notation, subnetting, private vs public IP ranges. VPC design trong cloud.
- [[A Deep Dive into HTTP- From HTTP 1 to HTTP 3|HTTP 1→3 Deep Dive]]
  → HTTP/1.1 (head-of-line blocking), HTTP/2 (multiplexing, server push), HTTP/3 (QUIC). Khi nào upgrade mang lại lợi ích thực.
- [[HTTP1 vs HTTP2 vs HTTP3 - A Deep Dive|HTTP Versions Comparison]]
  → Performance benchmarks. HOL blocking ở các level khác nhau. TLS 1.3 integration với HTTP/3.

---

## ☁️ Infrastructure & Deployment

- [[Infrastructure as Code|Infrastructure as Code]]
  → Terraform, Ansible, CloudFormation. Idempotency trong IaC. GitOps workflow.
- Kubernetes Roadmap *(planned)*
  → Pod, Deployment, Service, Ingress, ConfigMap, Secret. HPA (Horizontal Pod Autoscaler). Rolling update.
- [[What are the differences between Virtualization (VMware) and Containerization (Docker)|Virtualization vs Containerization]]
  → VM hypervisor vs container runtime (containerd). Isolation level trade-off. When to use VMs still.
- [[A Crash Course on Cell-based Architecture|Cell-based Architecture]]
  → Cells = isolated deployment units. Blast radius reduction. AWS Zones of Availability approach. Shopify uses this.
- [[Does Serverless Have Servers|Does Serverless Have Servers?]]
  → FaaS (Lambda, Cloud Functions) internals. Cold start problem. When serverless fits, when it doesn't.

---

## 📊 Case Studies — Scaling Thực Tế

- [[How LinkedIn Scaled User Restriction System to 5 Million Queries Per Second|LinkedIn: 5M QPS Restriction System]]
  → Consistent hashing, distributed cache, async processing. **5M QPS = ~58K req/s, PDMS context tham khảo.**
- [[How Reddit Delivers Notifications to Tens of Millions of Users|Reddit: Notifications at Scale]]
  → Fan-out strategies, write-heavy vs read-heavy optimization, real-time delivery với WebSocket.
- [[How Slack Supports Billions of Daily Messages|Slack: Billions of Daily Messages]]
  → Message storage, search indexing, presence system. Channel-based sharding.
- [[How Tinder’s API Gateway Handles A Billion Swipes Per Day|Tinder: 1B Swipes/Day API Gateway]]
  → Gateway architecture, request coalescing, cache strategy for recommendations.
- [[Shopify Tech Stack|Shopify Tech Stack]]
  → Rails monolith at scale, Liquid templating, Kafka for async, Kubernetes deployment. Cell-based architecture.
- [[EP177- The Modern Software Stack|The Modern Software Stack]]
  → Snapshot of current best practices: observability stack, deployment pipeline, data stack.

---

## 🔗 Liên kết

- [[MOC-Database]] — DB scaling là phần quan trọng nhất của system scaling
- [[MOC-Distributed-Systems]] — Theoretical foundation
- [[MOC-System-Design]] — Architecture patterns tổng quan
- [[Bai-16-Deployment|Bài 16: Deployment]] — Rust deployment so với Java
