---
type: moc
domain: knowledge-management
status: living-document
created: 2026-10-25
updated: 2026-10-25
tags: [moc, audit, refactor, version-baseline, technology-update]
source_checked: 2026-10-25
---

# P3 — Baseline phiên bản stack PDMS (tra ngày 2026-10-25)

> Mốc đối chiếu cho bước audit Tầng A của [[_moc/VAULT-REFACTOR-2026-10]]. Mỗi dòng ghi rõ **nguồn chính** (trang của chính dự án) hay **nguồn thứ cấp** (blog, tổng hợp). Chưa đối chiếu với nội dung từng note trong vault; cột cuối chỉ là nơi cần rà.
> Đã có sẵn từ P2: JEP 491 / 506 / 533 / 543 (xem [[_moc/VAULT-P2-CLUSTER-MAP]]), Solid 2.0 RC.

## 1. Bảng phiên bản hiện hành

| Công nghệ | Trạng thái mới nhất tra được | Mốc vòng đời | Nguồn | Cần rà trong vault |
|---|---|---|---|---|
| **JDK** | 25 là LTS (phát hành 2025-09-16). JDK 26 đã có (Hibernate 7.3 liệt kê hỗ trợ Java 26). JDK 27 theo lịch GA 2026-09-15 (chưa xác nhận trực tiếp trên trang release). JDK 28: JEP 543 chốt Structured Concurrency | JDK 28 GA dự kiến 03/2027 | inside.java, InfoQ (JEP 533 / 543) | Note Java/JVM ghi baseline JDK 21 hoặc 26 |
| **Spring Boot** | **4.1.x**: GA 2026-05-20; 4.1.1 phát hành 2026-08-20 (có thể đã có patch sau đó). Nền tảng: Spring Framework 7, Jakarta EE 11, Servlet 6.1; baseline Java 17, hỗ trợ Java 25 | 4.1: hết OSS support 2027-06-30 · **4.0: hết OSS support 2026-12-31** · **3.5: hết free support 06/2026** | spring.io (4.1.1: nguồn chính); ngày GA và mốc hỗ trợ: nguồn thứ cấp | Note Spring/Boot, ví dụ cấu hình `spring.threads.virtual.enabled` |
| **Hibernate ORM** | **7.4 là bản stable mới nhất** (7.4.5.Final, 2026-07-12). **7.3 đã EOL**. 7.2 / 7.1 / 6.6 ở limited support. **8.0.0.Beta1** (2026-06-16) đang phát triển, đi cùng Jakarta Persistence 4.0 | 7.3 EOL | hibernate.org (nguồn chính) | [[Database-Patterns/Hibernate-Performance-Deep-Dive]], `concepts/hibernate-*`, Hibernate-Reactive |
| **PostgreSQL** | **18.6** là minor mới nhất của 18 (18.5 bị bỏ qua vì regression). **19 Beta 4** phát hành 2026-09-24, GA được thông báo cho tháng 10/2026 (chưa xác nhận đã phát hành) | 18 hỗ trợ đến 2030-11-14 · **14 EOL 2026-11-12** | postgresql.org (Beta 4); bản 18.6 và mốc EOL: nguồn thứ cấp | [[Database-Patterns/PostgreSQL/18-Snapshot-Internals-Deep-Dive]] và series PostgreSQL 00–18 |
| **Apache Kafka** | **4.3.0** (2026-05-22), patch 4.3.1 (2026-06-23). 4.2.0 phát hành 2026-02-17. KRaft-only từ 4.0 (2025-03), ZooKeeper đã gỡ. Nguồn tra từ tháng 7/2026 nên có thể đã có bản mới hơn | — | Nguồn thứ cấp (tổng hợp changelog, tài liệu bên thứ ba) | Note Kafka trong Microservices-Patterns (config, partition, troubleshooting, multi-cluster) |
| **Camunda 7** | **Community Edition đã EOL tháng 10/2025**: bản cuối 7.24 phát hành 2025-10-14, không còn bản vá bảo mật cho CE. Enterprise Edition được hỗ trợ đến 04/2030 (7.24 là LTS) | CE: 2025-10 · EE: 2030-04 | camunda.com (nguồn chính) | [[Microservices-Patterns/BPMN-CMMN-DMN-Enterprise-Process-Modeling]] và mọi note nhắc Camunda |
| **SolidJS** | 1.x ổn định (`solid-js@1.9.12`); **2.0.0-rc.9** (2026-09-18) vẫn là pre-release | — | GitHub Releases, unpkg | Series SolidJS (xem [[SolidJS-Series/SolidJS-00-Overview]]) |

## 2. Ý nghĩa với kiến thức trong vault

- **Camunda là phát hiện có tác động lớn nhất:** nếu note nào mô tả Camunda 7 như một lựa chọn "đang được hỗ trợ", cần ghi rõ phân biệt Community và Enterprise. Cần xác nhận edition thực tế đang dùng ở PDMS trước khi kết luận.
- **Spring Boot:** nên đối chiếu note migration theo nhánh đích **4.1.x**, vì 4.0 hết OSS support 2026-12-31 và 3.5 đã hết free support. Mốc hỗ trợ này đến từ nguồn thứ cấp, cần đối chiếu lại với trang support của Spring trước khi đưa vào note.
- **Hibernate:** các note dạy API/hành vi cần ghi rõ dòng (6.6 hay 7.x). 7.3 đã EOL nên không nên coi là mốc.
- **PostgreSQL:** series đang chốt ở PG 18, vẫn đúng với bản stable. PG 19 chỉ nên thêm vào khi GA được xác nhận.
- **Kafka:** mọi chỉ dẫn ZooKeeper cần được ghi là "chỉ áp dụng cho Kafka 3.x trở về trước".

## 3. Quy trình rà mỗi công nghệ (bước tiếp theo)

1. Liệt kê note liên quan và **trích các claim gắn version** (số phiên bản, cờ cấu hình, tên API).
2. Lập bảng *claim → thực tế → mức lệch* kèm link nguồn chính.
3. Với claim đã xác minh: append mục "Đính chính" vào note (nội dung gốc giữ nguyên). Với claim chưa xác minh: ghi vào mục "Chưa xác minh".
4. Khi một note được rà xong: thêm `source_checked`, `valid_for` vào frontmatter của chính note đó (lưu ý patch frontmatter ghi lại cả khối YAML, xem mục 8 của tracker).

## 4. Thứ tự rà đề xuất

1. Camunda
2. Spring Boot 4.x
3. Hibernate 7.x
4. PostgreSQL
5. Kafka
6. Java (mốc JDK 25 / 27) và các note Loom còn lại

## 5. Độ tin cậy của baseline

- **Nguồn chính:** Spring Boot 4.1.1 (spring.io), Hibernate (hibernate.org), PostgreSQL Beta 4 (postgresql.org), Camunda (camunda.com), JEP (openjdk.org), Solid (GitHub Releases).
- **Nguồn thứ cấp:** ngày GA và mốc hỗ trợ của Spring Boot, bản 18.6 và mốc EOL của PostgreSQL, toàn bộ dòng Kafka.
- Mọi ô "dự kiến / chưa xác nhận" cần kiểm tra lại khi bắt đầu rà từng công nghệ.
