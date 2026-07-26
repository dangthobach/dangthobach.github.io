---
type: moc
domain: knowledge-management
status: living-document
created: 2026-07-24
updated: 2026-07-24
tags: [moc, dashboard, dataview, audit, knowledge-management]
---

# Vault Dashboard

> Dashboard sinh trực tiếp từ metadata. Đây là nguồn hiện trạng; [[_moc/VAULT-AUDIT-2026|VAULT-AUDIT-2026]] được giữ như historical audit và roadmap.

## Tổng số note theo vai trò

```dataview
TABLE length(rows) AS "Notes"
FROM ""
WHERE !contains(file.path, "_archive/")
GROUP BY type
SORT length(rows) DESC
```

## Tổng số note theo domain

```dataview
TABLE length(rows) AS "Notes"
FROM ""
WHERE !contains(file.path, "_archive/")
GROUP BY domain
SORT length(rows) DESC
```

## Knowledge đang phát triển

```dataview
TABLE type, domain, updated, tags
FROM ""
WHERE status = "draft" OR status = "growing" OR status = "active"
SORT updated DESC
LIMIT 50
```

## Notion distillation queue

```dataview
TABLE distillation, updated
FROM "Notion Knowledge"
WHERE distillation = "reference"
SORT file.name ASC
```

## Note đã distilled hoặc superseded

```dataview
TABLE distillation, updated
FROM "Notion Knowledge"
WHERE distillation = "distilled" OR distillation = "superseded"
SORT updated DESC
```

## Technology updates

```dataview
TABLE domain, updated, source_checked
FROM ""
WHERE contains(tags, "technology-update")
SORT updated DESC
```

