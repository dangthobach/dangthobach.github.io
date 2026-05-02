---
tags: [moc, database, internals, performance, rust]
aliases: [DB Internals MOC]
created: 2026-05-01
---

# 🗄️ Database Internals — MOC

> **Mục tiêu:** Hiểu cách dữ liệu được lưu trữ, đánh chỉ mục và truy xuất ở mức độ byte. Từ Bitcask đến LSM-Tree và B-Tree.

---

## 🗺️ Lộ trình học tập (ViperKV Project)

### 🟢 Level 1: Log-Structured Storage (Bitcask)
- [[Performance-System-Programming/01-Database-Internals/01-Bitcask-Architecture|01. Kiến trúc Bitcask]] — Hash Table + Append-only Log.
- [[Performance-System-Programming/01-Database-Internals/02-Append-Only-Log-Rust|02. Triển khai Append-only Log với Rust]] — `std::fs` và Binary Encoding.
- [[Performance-System-Programming/01-Database-Internals/03-Bitcask-Merge-Compaction|03. Cơ chế Merge & Compaction]] — Dọn dẹp đĩa hiệu quả.

### 🟡 Level 2: Sorted Storage (LSM-Tree)
- [[Performance-System-Programming/01-Database-Internals/04-SSTable-Format|04. Định dạng SSTable]] — Sorted String Table.
- [[Performance-System-Programming/01-Database-Internals/05-Memtable-SkipList|05. Memtable & SkipList]] — Cấu trúc dữ liệu trong bộ nhớ.
- [[Performance-System-Programming/01-Database-Internals/06-Bloom-Filters|06. Bloom Filters]] — Tối ưu hóa I/O cho "Key not found".

### 🔴 Level 3: Advanced Topics
- [[Performance-System-Programming/01-Database-Internals/07-B-Tree-vs-LSM-Tree|07. B-Tree vs LSM-Tree]] — Khi nào dùng cái nào?
- [[Performance-System-Programming/01-Database-Internals/08-WAL-Recovery|08. Write-Ahead Log & Crash Recovery]].

---

## 🛠️ ViperKV Project Log
- [[Performance-System-Programming/01-Database-Internals/ViperKV-Project-Log|Mật ký dự án ViperKV]]

---

## 🔗 Liên kết liên quan
- [[_moc/MOC-Rust|MOC Rust]]
- [[_moc/MOC-Database|MOC Database (Usage)]]
- [[concepts/postgresql-performance-deep-dive|PostgreSQL Internals]]
