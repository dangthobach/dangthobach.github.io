# Kubernetes Architecture — Deep Dive

---
tags: [kubernetes, orchestration, containers, infrastructure, devops]
created: 2026-05-02
difficulty: advanced
estimated-read: 25 min
links: [[container-internals]], [[slo-sla-error-budget]], [[opentelemetry-deep-dive]]

---

## 🎯 Learning Objectives

Sau bài này bạn sẽ:
- Hiểu **kiến trúc bên trong** của Kubernetes cluster
- Biết lifecycle của một Pod từ khi tạo đến khi chạy
- Nắm được **networking model** của K8s (Service, Ingress, CNI)
- Áp dụng được các patterns quan trọng cho PDMS deployment

---

## 🏗️ Kubernetes Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Kubernetes Cluster                              │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Control Plane (Master)                    │   │
│  │                                                              │   │
│  │  ┌──────────────┐  ┌───────────┐  ┌──────────────────────┐ │   │
│  │  │  API Server  │  │  etcd     │  │  Scheduler           │ │   │
│  │  │  (kube-      │  │ (Raft     │  │  (kube-scheduler)    │ │   │
│  │  │   apiserver) │  │  cluster, │  │  Chọn Node cho Pod   │ │   │
│  │  │  REST API    │  │  key-val  │  │  based on resources, │ │   │
│  │  │  Auth/AuthZ  │  │  store)   │  │  affinity, taints    │ │   │
│  │  └──────────────┘  └───────────┘  └──────────────────────┘ │   │
│  │         ▲                                                    │   │
│  │  ┌──────────────────────────────────────────────────────┐   │   │
│  │  │         Controller Manager (kube-controller-manager) │   │   │
│  │  │  ReplicaSet Controller  Node Controller              │   │   │
│  │  │  Deployment Controller  Job Controller               │   │   │
│  │  │  (Reconciliation loops — "desired vs actual state")  │   │   │
│  │  └──────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌────────────────────┐   ┌────────────────────┐                   │
│  │   Worker Node 1    │   │   Worker Node 2     │                   │
│  │  ┌──────────────┐  │   │  ┌──────────────┐  │                   │
│  │  │  kubelet     │  │   │  │  kubelet     │  │                   │
│  │  │  (node agent)│  │   │  │  (node agent)│  │                   │
│  │  ├──────────────┤  │   │  ├──────────────┤  │                   │
│  │  │  kube-proxy  │  │   │  │  kube-proxy  │  │                   │
│  │  │  (iptables/  │  │   │  │  (network    │  │                   │
│  │  │  ipvs rules) │  │   │  │  rules)      │  │                   │
│  │  ├──────────────┤  │   │  ├──────────────┤  │                   │
│  │  │  Container   │  │   │  │  Container   │  │                   │
│  │  │  Runtime     │  │   │  │  Runtime     │  │                   │
│  │  │  (containerd)│  │   │  │  (containerd)│  │                   │
│  │  ├──────────────┤  │   │  ├──────────────┤  │                   │
│  │  │ Pod A  Pod B │  │   │  │ Pod C  Pod D │  │                   │
│  │  └──────────────┘  │   │  └──────────────┘  │                   │
│  └────────────────────┘   └────────────────────┘                   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## ⚙️ Control Plane Components — Chi Tiết

### 1. API Server — "Front Door" của K8s

```
Mọi thứ trong K8s đều thông qua API Server:
  kubectl → API Server → etcd
  kubelet → API Server (watch for pod specs)
  Controller → API Server (watch + update state)

API Server responsibilities:
  ✓ Authentication: client certificates, bearer tokens, OIDC
  ✓ Authorization: RBAC policies
  ✓ Admission Control: ValidatingAdmissionWebhook, MutatingAdmissionWebhook
  ✓ Resource validation: schema check
  ✓ Etcd persistence: store cluster state
```

### 2. etcd — "Brain" của K8s

```
etcd = Distributed key-value store (Raft consensus)

Lưu toàn bộ cluster state:
  /registry/pods/default/nginx-12345
  /registry/services/default/pdms-document-svc
  /registry/deployments/pdms/pdms-document-deployment

Tại sao dùng etcd?
  ✓ Strong consistency (Raft: linearizable reads)
  ✓ Watch API: components watch for changes (pub/sub pattern)
  ✓ Lease/TTL: node heartbeats

Production setup:
  etcd cluster = 3 hoặc 5 nodes (odd = avoid split brain)
  Separate disk cho etcd (fast SSD, không share với OS)
  Regular backup (etcdctl snapshot save)
```

### 3. Scheduler — "Matchmaker"

```
Scheduler algorithm:
  1. Filtering (Predicates): Loại bỏ nodes không phù hợp
     - NodeSelector/nodeAffinity match?
     - Resources available? (CPU/Memory request)
     - Taints/Tolerations match?
     - Pod affinity/anti-affinity satisfied?
     
  2. Scoring (Priorities): Rank remaining nodes
     - LeastAllocated: prefer node với ít resources đã allocate nhất
     - NodeAffinity: prefer nodes matching soft affinity
     - SpreadConstraints: balance pods across zones
     
  3. Bind: Assign pod to highest-scored node
```

### 4. Controller Manager — "Reconciliation Engine"

```
Reconciliation loop (cốt lõi của K8s philosophy):

  while true:
    desired_state = read from etcd
    actual_state  = observe cluster
    
    if desired != actual:
      take_action_to_reconcile()
    
    sleep(resync_period)

ReplicaSet Controller example:
  Desired: 3 replicas of pdms-document-pod
  Actual:  2 pods running (1 crashed)
  Action:  Create 1 new pod
```

---

## 🔄 Pod Lifecycle — Từ kubectl apply đến Running

```
kubectl apply -f pdms-deployment.yaml
         │
         ▼
┌─────────────────┐
│   API Server    │ ← Validate, persist to etcd
└─────────────────┘
         │ Watch event
         ▼
┌─────────────────┐
│  Deployment     │ ← Creates ReplicaSet
│  Controller     │
└─────────────────┘
         │
         ▼
┌─────────────────┐
│  ReplicaSet     │ ← Creates Pods (status: Pending)
│  Controller     │
└─────────────────┘
         │
         ▼
┌─────────────────┐
│   Scheduler     │ ← Assigns Pod to Node X
└─────────────────┘
         │ Watch event (pod assigned to me)
         ▼
┌─────────────────┐
│  kubelet        │ ← Pull image, create containers
│  (on Node X)    │
└─────────────────┘
         │
         ├─► Pull image from registry
         │
         ├─► Create Network Namespace (via CNI plugin)
         │   Assign Pod IP address
         │
         ├─► Mount Volumes (PVC, ConfigMap, Secret)
         │
         ├─► Run Init Containers (sequential)
         │
         ├─► Run Main Containers (parallel)
         │
         ├─► Run Liveness/Readiness Probes
         │
         └─► Report status back to API Server
             Pod status: Running ✓
```

---

## 🌐 Kubernetes Networking Model

### Core principle: Every Pod gets a unique IP

```
┌────────────────────────────────────────────────────────────┐
│             Kubernetes Network Model                        │
│                                                            │
│  Pod A (10.0.1.5) ──────────────────► Pod B (10.0.2.8)   │
│  (Node 1)          Direct IP routing  (Node 2)            │
│                    No NAT!                                 │
│                                                            │
│  Implemented by CNI plugins:                              │
│  - Calico (BGP routing, NetworkPolicy)                    │
│  - Flannel (VXLAN overlay)                                │
│  - Cilium (eBPF, best performance)                        │
└────────────────────────────────────────────────────────────┘
```

### Service — Stable Virtual IP

```yaml
# ClusterIP Service — internal only
apiVersion: v1
kind: Service
metadata:
  name: pdms-document-svc
spec:
  type: ClusterIP
  selector:
    app: pdms-document-service  # Routes to pods with this label
  ports:
  - port: 80         # Service port
    targetPort: 8080  # Container port

# kube-proxy creates iptables rules:
# Destination: 10.96.100.50:80 (ClusterIP)
# → Load balance to one of:
#   10.0.1.5:8080 (Pod A)
#   10.0.2.8:8080 (Pod B)
#   10.0.1.9:8080 (Pod C)
```

```
Service types:
  ClusterIP  → internal only (default)
  NodePort   → expose on node's IP:30000-32767
  LoadBalancer → cloud load balancer (AWS ELB, GCP GLB)
  ExternalName → DNS CNAME alias
  
Headless Service (clusterIP: None):
  Returns Pod IPs directly (no VIP)
  Used by StatefulSets (Kafka, Cassandra, PostgreSQL)
```

### Ingress — L7 Routing

```yaml
# Ingress — HTTP routing rules
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: pdms-ingress
  annotations:
    nginx.ingress.kubernetes.io/rate-limit: "100"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  tls:
  - hosts: [api.pdms.vpbank.com]
    secretName: pdms-tls-cert
    
  rules:
  - host: api.pdms.vpbank.com
    http:
      paths:
      - path: /api/v1/documents
        pathType: Prefix
        backend:
          service:
            name: pdms-document-svc
            port: { number: 80 }
      - path: /api/v1/warehouses
        pathType: Prefix
        backend:
          service:
            name: pdms-warehouse-svc
            port: { number: 80 }
```

---

## 📦 PDMS Deployment Patterns

### Deployment với Rolling Update

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pdms-document-service
  namespace: pdms
spec:
  replicas: 3
  
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1        # Có thể có tối đa 4 pods (3+1) trong upgrade
      maxUnavailable: 0  # Không được giảm dưới 3 pods → zero downtime
  
  selector:
    matchLabels:
      app: pdms-document-service
  
  template:
    metadata:
      labels:
        app: pdms-document-service
    spec:
      containers:
      - name: pdms-document
        image: pdms/document-service:2.3.1
        
        resources:
          requests:           # Scheduler dùng để chọn node
            cpu: "250m"       # 0.25 CPU cores
            memory: "512Mi"
          limits:             # Hard limit — container bị kill nếu vượt
            cpu: "1000m"
            memory: "1024Mi"
        
        ports:
        - containerPort: 8080
        
        # Health checks — ảnh hưởng trực tiếp đến SLI
        livenessProbe:
          httpGet:
            path: /actuator/health/liveness
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
          failureThreshold: 3   # Restart container sau 3 fails
          
        readinessProbe:
          httpGet:
            path: /actuator/health/readiness
            port: 8080
          initialDelaySeconds: 20
          periodSeconds: 5
          failureThreshold: 3   # Remove from Service endpoints sau 3 fails
        
        env:
        - name: SPRING_PROFILES_ACTIVE
          value: "kubernetes"
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: pdms-db-secret
              key: password
      
      # Graceful shutdown
      terminationGracePeriodSeconds: 60
```

### Pod Disruption Budget — Maintain SLO during updates

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: pdms-document-pdb
spec:
  maxUnavailable: 1  # Chỉ được take down 1 pod tại một thời điểm
  selector:
    matchLabels:
      app: pdms-document-service

# Này đảm bảo: khi node drain/upgrade, luôn có ít nhất 2/3 pods chạy
```

### HorizontalPodAutoscaler (HPA)

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: pdms-document-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: pdms-document-service
  
  minReplicas: 3
  maxReplicas: 20
  
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70  # Scale up khi CPU > 70%
  
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60    # Don't scale up too fast
      policies:
      - type: Pods
        value: 2
        periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300   # Wait 5 min before scale down
```

---

## 🔧 RBAC — Role-Based Access Control

```yaml
# Service Account for PDMS pods
apiVersion: v1
kind: ServiceAccount
metadata:
  name: pdms-document-sa
  namespace: pdms

---
# Role — permissions within namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pdms-document-role
  namespace: pdms
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list", "watch"]   # Read-only ConfigMaps
- apiGroups: [""]
  resources: ["secrets"]
  resourceNames: ["pdms-db-secret"]  # Only specific secret!
  verbs: ["get"]

---
# RoleBinding
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: pdms-document-rolebinding
  namespace: pdms
subjects:
- kind: ServiceAccount
  name: pdms-document-sa
roleRef:
  kind: Role
  name: pdms-document-role
  apiGroup: rbac.authorization.k8s.io
```

---

## 📚 Case Study — PDMS K8s Deployment Strategy

### Canary Deployment cho pdms-document-service

```yaml
# Stable version: 90% traffic
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pdms-document-stable
spec:
  replicas: 9   # 9 pods = 90% traffic (via service selector weight)
  template:
    metadata:
      labels:
        app: pdms-document
        version: stable   # v2.3.0

---
# Canary version: 10% traffic
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pdms-document-canary
spec:
  replicas: 1   # 1 pod = ~10% traffic
  template:
    metadata:
      labels:
        app: pdms-document
        version: canary   # v2.4.0

---
# Service selects both via common label
apiVersion: v1
kind: Service
metadata:
  name: pdms-document-svc
spec:
  selector:
    app: pdms-document  # Matches BOTH stable and canary pods
```

---

## 🔑 Key Takeaways

1. **Control Plane:** API Server (gateway) + etcd (state) + Scheduler (placement) + Controllers (reconciliation)
2. **Reconciliation loop** là core pattern: "desired state vs actual state → take action"
3. **Pod networking:** flat network, every pod gets unique IP, no NAT
4. **Services** = stable virtual IP + load balancing cho ephemeral pods
5. **Liveness vs Readiness:** Liveness = "should container restart?" | Readiness = "ready to receive traffic?"
6. **PodDisruptionBudget** = SLO enforcement trong node maintenance
7. **Resource requests** = Scheduler input | **limits** = hard enforcement
8. **HPA** scale dựa trên metrics → luôn có buffer capacity cho traffic spikes

---

## 🔗 Related Links

- [[container-internals]] — Namespaces, cgroups — nền tảng của Pods
- [[slo-sla-error-budget]] — PDB và SLO trong K8s context
- [[zero-trust-architecture]] — mTLS, NetworkPolicy trong K8s
- [[opentelemetry-deep-dive]] — OTel collector deployment trong K8s
