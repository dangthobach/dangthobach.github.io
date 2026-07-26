---
type: course
domain: data/serialization
status: active
created: 2026-05-27
updated: 2026-05-29
tags: []
---

# 🗺️ Apache Fory — Series Map of Content

> **Apache Fory** (formerly Fury) — Blazingly fast multi-language serialization framework  
> Top-Level Apache Project · Graduated July 2025 · Production-ready

---

## 🎯 Mục tiêu Series

```
Từ nguyên lý → Triển khai thực tế trong Java, Rust, Go
Hiểu tại sao Fory tồn tại, dùng ở đâu, không dùng ở đâu
Áp dụng vào hệ thống PDMS / microservices thực tế
```

---

## 📚 Danh sách bài học

### Phần I — Nền tảng & Nguyên lý
| # | Bài | Trạng thái |
|---|-----|-----------|
| 01 | [[01-Why-Serialization-Matters]] — Tại sao serialization quan trọng & lịch sử vấn đề | ✅ |
| 02 | [[02-How-Fory-Works-Internals]] — Cơ chế hoạt động: JIT, Zero-Copy, Object Graph | ✅ |
| 03 | [[03-Fory-vs-Avro-Protobuf-Positioning]] — Định vị: bổ trợ chứ không thay thế | ✅ |

### Phần II — Java Deep Dive
| # | Bài | Trạng thái |
|---|-----|-----------|
| 04 | [[04-Fory-Java-Quickstart]] — Setup, Register, Serialize cơ bản | ✅ |
| 05 | [[05-Fory-Java-Modes]] — Native vs Compatible vs XLang mode | ✅ |
| 06 | [[06-Fory-Java-Spring-Redis-Cache]] — Tích hợp Spring Boot + Redis cache | ✅ |
| 07 | [[07-Fory-Java-Kafka-Internal-Events]] — Serialize Kafka internal events | ✅ |
| 08 | [[08-Fory-Java-Schema-Evolution]] — Schema evolution & backward compatibility | ✅ |

### Phần III — Go & Rust
| # | Bài | Trạng thái |
|---|-----|-----------|
| 09 | [[09-Fory-Go-Quickstart]] — Go setup, struct registration, cross-service | ✅ |
| 10 | [[10-Fory-Rust-Quickstart]] — Rust setup, serde interop, async context | ✅ |
| 11 | [[11-Fory-XLang-Java-Go-Rust]] — Cross-language: Java ↔ Go ↔ Rust cùng payload | ✅ |

### Phần IV — Thực chiến
| # | Bài | Trạng thái |
|---|-----|-----------|
| 12 | [[12-Fory-PDMS-Integration-Blueprint]] — Blueprint tích hợp vào PDMS | ✅ |
| 13 | [[13-Fory-Performance-Benchmarks]] — Benchmark thực tế vs Kryo, Jackson, Avro | ✅ |
| 14 | [[14-Fory-Production-Checklist]] — Security, versioning, monitoring production | ✅ |

---

## 🧠 Mental Model nhanh

```
CROSS-SYSTEM CONTRACT       → Avro, Protobuf  (có Schema Registry)
JVM INTERNAL / CACHE / RPC  → Fory            (thay thế Kryo/JDK)
ANALYTICS / COLUMNAR        → Parquet, Arrow
```

---

## ⚡ Quick Decision Card

```
Kafka multi-team?          → Avro + Schema Registry
Kafka 1-team internal?     → Fory COMPATIBLE
Redis cache?               → Fory SCHEMA_CONSISTENT
gRPC?                      → Protobuf
REST API?                  → JSON
Java ↔ Go/Rust internal?   → Fory XLANG
Replace Kryo/JDK Ser?      → Fory SCHEMA_CONSISTENT
```

---

## 📊 Series Stats

- **14 bài học** hoàn chỉnh
- **Languages covered:** Java, Go, Rust
- **Frameworks:** Spring Boot, Tokio, rdkafka, kafka-go
- **Patterns:** Cache, Kafka, XLang, Schema Evolution, Security
- **Hoàn thành:** 2026-05

---

## 🔗 Liên kết liên quan
- [[Kafka-Configuration-Deep-Dive]]
- [[Debezium-CDC-Deep-Dive]]
- [[gRPC-Deep-Dive]]
- [[PDMS-Architecture-Overview]]
- [[Rust-Zero-To-Hero/]] — Rust foundation cho bài 10

---

*Series hoàn thành: 2026-05*
