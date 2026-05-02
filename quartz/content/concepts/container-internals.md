# Container Internals — Deep Dive

---
tags: [containers, linux, namespaces, cgroups, docker, kubernetes]
created: 2026-05-02
difficulty: advanced
estimated-read: 20 min
links: [[kubernetes-architecture]], [[os-process-thread-scheduling]], [[zero-trust-architecture]]

---

## 🎯 Learning Objectives

Sau bài này bạn sẽ:
- Hiểu **container không phải VM** — chỉ là Linux process với restrictions
- Nắm được cơ chế **namespaces** (isolation) và **cgroups** (resource limiting)
- Hiểu **container image** là gì và Union Filesystem hoạt động như thế nào
- Biết các **security considerations** khi chạy container trong production

---

## 🤔 Container là gì, thực sự?

### Myth vs Reality

```
┌─────────────────────────────────────────────────────────────┐
│  Myth: Container = lightweight VM                           │
│                                                             │
│  Reality: Container = OS process + Linux isolation features │
│                                                             │
│  VM:                        Container:                      │
│  ┌──────────────────┐       ┌────────────────────────────┐  │
│  │ Guest OS kernel  │       │ Host OS kernel (shared!)   │  │
│  │ Guest OS libs    │       │        │                   │  │
│  │ App              │       │  [namespaces + cgroups]    │  │
│  └──────────────────┘       │  Container process         │  │
│  │ Hypervisor       │       └────────────────────────────┘  │
│  │ Host OS          │       Host OS                         │
│                                                             │
│  VM: full OS isolation      Container: process isolation    │
│  Boot time: ~30s-2min       Boot time: ~100ms               │
│  Size: GB                   Size: MB                        │
│  Security: strong           Security: weaker (shared kernel)│
└─────────────────────────────────────────────────────────────┘
```

**Proof:** `docker run ubuntu ps aux` → Bạn thấy 1 process. Nếu container là VM, bạn sẽ thấy nhiều OS processes.

---

## 🏠 Linux Namespaces — Isolation

Namespaces là kernel feature cho phép processes "thấy" một subset của system resources:

```
┌─────────────────────────────────────────────────────────────┐
│                  Linux Namespaces (7 loại)                  │
│                                                             │
│  Namespace   │ Isolates                    │ Container Use  │
│  ────────────┼─────────────────────────────┼────────────── │
│  PID         │ Process IDs                 │ PID 1 trong   │
│              │ Container có PID tree riêng │ container =   │
│              │                             │ init process   │
│  ────────────┼─────────────────────────────┼────────────── │
│  NET         │ Network stack               │ Mỗi container  │
│              │ Interfaces, routing, ports  │ có eth0 riêng  │
│  ────────────┼─────────────────────────────┼────────────── │
│  MNT         │ Filesystem mount points     │ / của container│
│              │                             │ ≠ / của host  │
│  ────────────┼─────────────────────────────┼────────────── │
│  UTS         │ Hostname, domain name       │ Container có  │
│              │                             │ hostname riêng │
│  ────────────┼─────────────────────────────┼────────────── │
│  IPC         │ System V IPC, POSIX MQ      │ Shared memory │
│              │                             │ isolation     │
│  ────────────┼─────────────────────────────┼────────────── │
│  USER        │ User/group IDs              │ Root trong    │
│              │                             │ container ≠   │
│              │                             │ root on host  │
│  ────────────┼─────────────────────────────┼────────────── │
│  CGROUP      │ cgroup root view            │ Resource mgmt │
└─────────────────────────────────────────────────────────────┘
```

### Xem namespaces của container thực tế

```bash
# Start container
docker run -d --name pdms-test nginx

# Get container PID on host
CONTAINER_PID=$(docker inspect pdms-test --format '{{.State.Pid}}')
echo "Container PID on host: $CONTAINER_PID"  # e.g., 12345

# Xem namespaces của container process
ls -la /proc/$CONTAINER_PID/ns/
# lrwxrwxrwx net -> net:[4026532193]  ← unique net namespace
# lrwxrwxrwx pid -> pid:[4026532194]  ← unique pid namespace
# lrwxrwxrwx mnt -> mnt:[4026532192]  ← unique mount namespace

# Vào namespace của container từ host:
nsenter -t $CONTAINER_PID -n ip addr  # Xem network của container
nsenter -t $CONTAINER_PID -m ls /     # Xem filesystem của container
```

---

## 📊 cgroups — Resource Limiting

**Control Groups (cgroups)** giới hạn và theo dõi resource usage của process groups:

```
┌─────────────────────────────────────────────────────────────┐
│                   cgroups Subsystems                        │
│                                                             │
│  cpu       → CPU time allocation (cpu.shares, cpu.quota)   │
│  memory    → Memory limit + OOM killer                      │
│  blkio     → Block I/O throughput (disk IOPS/bandwidth)    │
│  net_cls   → Network traffic classification                 │
│  pids      → Max number of processes                        │
│  cpuset    → Which CPUs/NUMA nodes can be used             │
└─────────────────────────────────────────────────────────────┘
```

### Kubernetes resource limits → cgroups

```yaml
# K8s pod spec:
resources:
  requests:
    cpu: "500m"      # 0.5 CPU cores
    memory: "512Mi"
  limits:
    cpu: "1000m"     # 1 CPU core max
    memory: "1024Mi"
```

**Mapping to cgroups:**

```bash
# Kubernetes tạo cgroups tương ứng:
cat /sys/fs/cgroup/memory/kubepods/pod<pod-uid>/memory.limit_in_bytes
# 1073741824  (= 1024 * 1024 * 1024 = 1GiB)

cat /sys/fs/cgroup/cpu/kubepods/pod<pod-uid>/cpu.cfs_quota_us
# 100000  (= 100ms per 100ms period = 1 full CPU core)

cat /sys/fs/cgroup/cpu/kubepods/pod<pod-uid>/cpu.cfs_period_us
# 100000  (100ms period)
```

### OOM Killer — Khi memory limit bị vượt

```
Container dùng 1100Mi memory, limit = 1024Mi
→ Linux OOM Killer kích hoạt
→ Kill process trong container (thường là PID 1)
→ Container restart (với RestartPolicy = Always)
→ CrashLoopBackOff nếu xảy ra liên tục

K8s log:
  OOMKilled: true
  Exit Code: 137  (128 + 9 = 128 + SIGKILL)

Fix:
  1. Tăng memory limit
  2. Fix memory leak trong app
  3. Tune JVM heap: -Xmx800m (< container memory limit!)
```

> ⚠️ **Java + Container pitfall:** JVM mặc định đọc total host RAM, không phải container memory. JVM 8u191+ tự động detect cgroups. Luôn set `-Xmx` hoặc dùng `-XX:MaxRAMPercentage=75`.

---

## 📁 Container Images — Union Filesystem

### Layer architecture

```
┌─────────────────────────────────────────────────────────────┐
│               Container Image Layers (OverlayFS)            │
│                                                             │
│  ┌─────────────────────────────────┐                       │
│  │ Layer 4: App JAR                │ ← Writeable (container)│
│  │ /app/pdms-document-service.jar  │   (Ephemeral!)         │
│  ├─────────────────────────────────┤                       │
│  │ Layer 3: Custom config          │                       │
│  │ /etc/pdms/application.yml       │ ← Read-only           │
│  ├─────────────────────────────────┤   (Image layers)      │
│  │ Layer 2: JDK 21                 │                       │
│  │ /usr/local/openjdk-21/          │                       │
│  ├─────────────────────────────────┤                       │
│  │ Layer 1: Ubuntu base            │                       │
│  │ /bin, /lib, /usr/lib ...        │                       │
│  └─────────────────────────────────┘                       │
│                                                             │
│  Filesystem view (container sees merged):                   │
│  / = Layer1 + Layer2 + Layer3 + Layer4 overlaid           │
│                                                             │
│  OverlayFS: lowerdir=layers, upperdir=writeable layer       │
│  Copy-on-write: modifying Layer1 file → copies to upperdir │
└─────────────────────────────────────────────────────────────┘
```

### Dockerfile best practices

```dockerfile
# Multi-stage build — tách build environment khỏi runtime image

# Stage 1: Build
FROM maven:3.9-eclipse-temurin-21 AS builder
WORKDIR /build

# Leverage layer caching — copy pom.xml first
COPY pom.xml .
RUN mvn dependency:go-offline -q  # Cache dependencies

# Copy source (changes frequently → separate layer)
COPY src ./src
RUN mvn package -DskipTests -q

# Stage 2: Runtime — minimal image
FROM eclipse-temurin:21-jre-jammy

# Security: Run as non-root user
RUN groupadd -r pdms && useradd -r -g pdms pdms
WORKDIR /app

COPY --from=builder /build/target/pdms-document-service.jar app.jar

# JVM flags for container awareness
ENV JAVA_OPTS="-XX:MaxRAMPercentage=75 \
               -XX:+UseContainerSupport \
               -XX:+ExitOnOutOfMemoryError \
               -Djava.security.egd=file:/dev/./urandom"

USER pdms  # Never run as root!

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8080/actuator/health || exit 1

ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS -jar app.jar"]
```

---

## 🔐 Container Security

### Security Context

```yaml
# Pod security configuration
spec:
  securityContext:
    runAsNonRoot: true       # Refuse to run as root
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault   # Apply default seccomp filter
  
  containers:
  - name: pdms-document
    securityContext:
      allowPrivilegeEscalation: false  # Cannot gain more privileges
      readOnlyRootFilesystem: true     # Filesystem read-only!
      capabilities:
        drop: [ALL]           # Drop all Linux capabilities
        add: [NET_BIND_SERVICE] # Add back only if needed
```

### Container escape vectors

```
Common container escape scenarios:
  
  1. Privileged container + host /proc access
     → --privileged flag gives host-level access
     Prevention: Never use privileged containers in production
  
  2. Host path volume mounts
     → docker run -v /etc:/etc → access host files
     Prevention: Restrict volume mounts via PSA/OPA
  
  3. Docker socket mount
     → -v /var/run/docker.sock → control host Docker daemon
     Prevention: NEVER mount Docker socket in containers
  
  4. Root process + kernel vulnerability
     → Root in container can exploit kernel bugs
     Prevention: Run as non-root, use seccomp, AppArmor
```

---

## 🔍 Debugging Container Issues

```bash
# Container không start — xem logs
kubectl logs pdms-document-xxxx --previous  # Logs của lần chạy trước

# Exec vào running container
kubectl exec -it pdms-document-xxxx -- /bin/sh

# Xem resource usage
kubectl top pods -n pdms

# Describe pod để xem events
kubectl describe pod pdms-document-xxxx

# Typical issue: CrashLoopBackOff
# Check: 
#   - OOMKilled? → tăng memory limit
#   - Exit Code 1? → app startup failure → xem logs
#   - Exit Code 137? → OOMKilled (SIGKILL)
#   - liveness probe failing? → tăng initialDelaySeconds

# Check cgroup memory:
cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes
```

---

## 📚 Case Study — PDMS Java Memory Tuning

### Problem: OOMKilled pods

```
Symptom:
  pods.pdms.pdms-document-xxxx  OOMKilled  Exit 137

Container spec:
  memory limit: 1Gi

JVM behavior:
  Default: JVM sees host 32GB RAM → sets heap = 8GB (25%)
  Container limit: 1GB → heap 8GB > container memory → OOM!
```

### Fix

```dockerfile
# Correct JVM flags for containerized Java
ENV JAVA_OPTS="\
  -XX:+UseContainerSupport \        # JVM reads cgroup limits
  -XX:MaxRAMPercentage=75.0 \       # Use 75% of container memory for heap
  -XX:InitialRAMPercentage=50.0 \   # Start at 50%
  -XX:+ExitOnOutOfMemoryError \     # Fail fast vs struggling
  -XX:+HeapDumpOnOutOfMemoryError \ # Dump for analysis
  -XX:HeapDumpPath=/tmp/heapdump.hprof"

# With 1Gi container:
# MaxRAMPercentage=75% → Max heap = 768MB
# Remaining 256MB for: JVM overhead, off-heap, metaspace
```

---

## 🔑 Key Takeaways

1. **Container = process + namespaces + cgroups** — không phải VM, chia sẻ host kernel
2. **7 namespaces** = PID, NET, MNT, UTS, IPC, USER, CGROUP → mỗi loại isolate một phần
3. **cgroups** enforce resource limits → OOM Killer khi vượt memory limit
4. **Union FS (OverlayFS)** = layered images, copy-on-write → hiệu quả storage
5. **Java + container:** phải set `-XX:+UseContainerSupport` và `MaxRAMPercentage`
6. **Never run as root** trong container production — dùng non-root user
7. **readOnlyRootFilesystem: true** → security hardening, giảm attack surface
8. **Multi-stage Docker build** → image nhỏ hơn, không có build tools trong runtime

---

## 🔗 Related Links

- [[kubernetes-architecture]] — K8s orchestrate containers với Pods
- [[os-process-thread-scheduling]] — Container processes dùng host OS scheduler
- [[zero-trust-architecture]] — Security context, seccomp, AppArmor
- [[memory-hierarchy-cpu-cache]] — Container cgroups và CPU cache behavior
