# AGENTS.md

This file provides context about this Obsidian vault for AI agents.

## Vault Overview

This vault is a highly structured technical knowledge base and learning repository focused on modern backend engineering. It serves as a deep-dive resource for mastering the JVM ecosystem (Quarkus, Micronaut, Vert.x), Reactive Programming, Microservices patterns, and the Rust programming language.

## Organization

The vault follows a sophisticated organizational structure designed for systematic learning and quick retrieval:

- **Maps of Content (MOCs)**: Located in `_moc/`, these files act as central hubs for complex domains like Concurrency, Distributed Systems, and Java.
- **Structured Learning Paths**: Folders like `JVM-Frameworks-2026` and `Rust-Zero-To-Hero` use numerical prefixes (01, 02) and phase-based subfolders (P1-Foundation, P2-Data) to indicate a clear progression of study.
- **Concept & Pattern Repositories**: The `concepts/` and `Microservices-Patterns/` folders store atomic, reusable knowledge about architectural styles and low-level system behaviors.
- **Template-Driven**: A dedicated `_templates/` folder ensures consistency for new notes, specifically for "Today I Learned" (TIL) entries, patterns, and framework concepts.
- **Legacy Integration**: The `Notion Knowledge/` folder contains a large volume of imported "Crash Course" style notes, which appear to be used as a reference library for broader engineering topics.

## Key Topics

- **Modern JVM Frameworks**: Quarkus, Micronaut, Vert.x, and Spring-to-Framework migrations.
- **Reactive Programming**: RxJava, Project Reactor, Backpressure strategies, and Event Loop models.
- **Rust Development**: Ownership mindset, Axum web framework, and Serde/JWT implementation.
- **Distributed Systems**: Microservices patterns, data consistency, and API versioning strategies.
- **Cloud-Native Java**: GraalVM Native Image, AOT vs. JIT compilation, and Project Loom deep dives.

## User Preferences

The user prefers a highly structured, hierarchical approach to information. Notes are often organized into 'Phases' (P1, P2, etc.) and numbered sequences, suggesting a preference for logical progression and 'Zero-to-Hero' style learning modules.

There is a strong emphasis on comparative analysis, as evidenced by the presence of 'Decision Matrices' and 'Cheatsheets' for comparing frameworks. The user also appears to be bilingual or utilizing Vietnamese resources, as seen in the `Rust-Zero-To-Hero` folder naming convention (e.g., 'Bai-1'). Responses should be technically dense, focusing on 'Deep Dives' rather than high-level summaries.

## Custom Instructions

- **Utilize Templates**: When drafting new content, always reference the structures in `_templates/` (e.g., `template-concept` for architectural topics).
- **Maintain Numbering**: If suggesting new modules or files within existing learning paths, follow the `0X-Name` and `PX-Phase` naming conventions.
- **Cross-Link to MOCs**: Ensure new technical notes are linked back to their respective Map of Content in the `_moc/` folder to maintain vault connectivity.
- **Comparative Format**: When asked to evaluate technologies, prefer using a 'Decision Matrix' or 'Cheatsheet' format similar to the existing ones in the `JVM-Frameworks-2026` folder.
