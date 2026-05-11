# Liquibase — Map of Content

> **Series mục tiêu**: Giải quyết **triệt để** bài toán schema migration, DDL compare, và data seeding khi golive production với hệ thống 200+ bảng — không còn ngồi diff script bằng tay.

---

## 🗺️ Series Index

| # | Article | Nội dung cốt lõi |
|---|---------|-----------------|
| 1 | [[Liquibase-01-Core-Mechanics]] | Kiến trúc nội tại, DATABASECHANGELOG, checksum, lock mechanism |
| 2 | [[Liquibase-02-Configuration-SpringBoot]] | Cấu hình Spring Boot enterprise, multi-datasource, contexts |
| 3 | [[Liquibase-03-Changelog-Mastery]] | Changelog strategies, XML vs SQL, best practices cho 200 bảng |
| 4 | [[Liquibase-04-Advanced-Enterprise]] | Multi-schema, multi-tenant, preconditions, rollback, diff/generateChangeLog |
| 5 | [[Liquibase-05-CICD-Production-Workflow]] | CI/CD pipeline, golive checklist, zero-downtime, compare triệt để |

---

## 🔥 Problem Statement — Pain khi không dùng Liquibase

```
❌ Dev viết DDL → QA chạy script khác → Prod lại khác nữa
❌ Không biết Prod đang ở "version" nào so với code hiện tại
❌ INSERT seed data bị duplicate hoặc thiếu khi deploy env mới
❌ 3 dev cùng ALTER TABLE → conflict, không ai biết ai đã chạy
❌ Rollback = viết tay reverse script, dễ sai, không ai muốn làm
❌ "Compare scripts" = ngồi diff 200 file .sql bằng tay trước mỗi golive
❌ Hotfix trên Prod mà quên update vào repo → Prod và code bị lệch vĩnh viễn
```

## ✅ Liquibase giải quyết

```
✅ Single source of truth: toàn bộ changelog trong Git, versioned cùng code
✅ Mỗi changeset có ID + author + checksum → không bao giờ chạy lại
✅ DATABASECHANGELOG: audit trail đầy đủ — ai chạy cái gì lúc nào
✅ Context + label: kiểm soát script nào chạy ở env nào (dev/staging/prod)
✅ Preconditions: chỉ chạy nếu điều kiện thỏa mãn — tránh chạy 2 lần
✅ Rollback tự động hoặc tự định nghĩa — golive có exit plan rõ ràng
✅ diff & generateChangeLog: compare 2 DB schema chỉ 1 lệnh
✅ Spring Boot auto-run: migration chạy trước app start, không cần ops manual
```

---

## 📐 Core Concepts Quick Reference

| Concept | Ý nghĩa |
|---------|---------|
| **Changelog** | File gốc định nghĩa tất cả thay đổi (XML/YAML/JSON/SQL) |
| **Changeset** | Đơn vị thay đổi nhỏ nhất — có `id` + `author`, chạy đúng 1 lần |
| **DATABASECHANGELOG** | Bảng Liquibase tự tạo để track đã chạy gì, khi nào |
| **DATABASECHANGELOGLOCK** | Distributed lock — đảm bảo chỉ 1 instance chạy migration |
| **Checksum** | MD5 hash của changeset content — phát hiện thay đổi ngầm |
| **Context** | Tag môi trường: `dev`, `staging`, `prod` |
| **Label** | Tag feature/sprint: `v1.2`, `hotfix-2024-11` |
| **Precondition** | Guard condition — chỉ chạy nếu điều kiện đúng |
| **Tag** | Đánh dấu checkpoint để rollback về đúng điểm |

---

## 🗂️ Recommended Vault Structure cho 200-table Project

```
src/main/resources/db/
├── changelog/
│   ├── db.changelog-master.xml          ← Root entry point, chỉ include
│   ├── migrations/
│   │   ├── v1.0.0/
│   │   │   ├── 001-create-core-schema.xml
│   │   │   ├── 002-create-lookup-tables.xml
│   │   │   ├── 003-create-indexes.xml
│   │   │   └── 004-seed-initial-data.xml
│   │   ├── v1.1.0/
│   │   │   ├── 001-add-audit-columns.xml
│   │   │   └── 002-alter-document-table.xml
│   │   └── v2.0.0/
│   │       ├── 001-new-module-tables.xml
│   │       └── 002-migrate-legacy-data.sql
│   └── procedures/                      ← Stored procedures (luôn runOnChange)
│       ├── pr_process_validation.sql
│       └── pr_batch_processing.sql
```

---

## 🏷️ Tags

#liquibase #database-migration #schema-management #enterprise #spring-boot #postgresql #devops #pdms
