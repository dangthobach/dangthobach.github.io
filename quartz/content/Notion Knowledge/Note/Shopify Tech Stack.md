---
Created by: Bách Đặng Thọ
Created time: 2025-08-31T00:17
---
_Note: This article is written in collaboration with the Shopify engineering team. Special thanks to the Shopify engineering team for sharing details with us about their tech stack and also for reviewing the final article before publication. All credit for the technical details and diagrams shared in this article goes to the Shopify Engineering Team._

Shopify handles scale that would break most systems.

On a single day (Black Friday 2024), the platform processed 173 billion requests, peaked at 284 million requests per minute, and pushed 12 terabytes of traffic every minute through its edge.

These numbers aren’t anomalies. They’re sustained targets that Shopify strives to meet. Behind this scale is a stack that looks deceptively simple from the outside: Ruby on Rails, React, MySQL, and Kafka.

But that simplicity hides sharp architectural decisions, years of refactoring, and thousands of deliberate trade-offs.

In this article, we map the tech stack powering Shopify from the modular monolith that still runs the business, to the pods that isolate failure domains, to the deployment pipelines that ship hundreds of changes a day. It covers the tools, programming languages, and patterns Shopify uses to stay fast, resilient, and developer-friendly at incredible scale.

[![](https://substackcdn.com/image/fetch/$s_!6D09!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fd8f51e20-a3a2-455e-906c-bb0bb7222802_1222x1600.png)](https://substackcdn.com/image/fetch/$s_!6D09!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fd8f51e20-a3a2-455e-906c-bb0bb7222802_1222x1600.png)

## **Shopify Backend Architecture**

Shopify’s backend runs on Ruby on Rails. The original codebase, written in the early 2000s, still forms the heart of the system. Rails offers fast development, convention over configuration, and strong patterns for database-backed web applications. Shopify also uses Rust for its systems programming language.

While most startups eventually rewrite their early frameworks, Shopify doubled down to help ensure Ruby and Rails are 100-year tools that will continue to merit being in their toolchain of choice. Instead of moving on to another framework, Shopify pushed it further. They invested in:

- **YJIT**, a Just-in-Time compiler for Ruby built on Rust that improves runtime performance without changing developer ergonomics.

- **Sorbet**, a static type checker built specifically for Ruby. Shopify contributed heavily to Sorbet and made it a first-class part of the stack.

- **Rails Engines**, a built-in Rails feature repurposed as a modularity mechanism. Each engine behaves like a mini-application, allowing isolation, ownership, and eventual extraction if needed.

The result is one of the largest and longest-running Rails applications in production.

## **Frontend Technologies**

Shopify’s frontend has gone through multiple architectural shifts, each one reflecting changes in the broader web ecosystem and lessons learned under scale.

The early days used standard patterns: server-rendered HTML templates, enhanced with jQuery and prototype.js. As frontend complexity grew, Shopify built Batman.js, its single-page application (SPA) framework. It offered reactivity and routing, but like most in-house frameworks, it came with long-term maintenance overhead.

Eventually, Shopify shifted back to simpler patterns: statically rendered HTML and vanilla JavaScript. However, that also had limits. Once the broader ecosystem matured, particularly around React and TypeScript, the team made a clean move forward.

Today, the Shopify Admin interface runs on React, React Router by Remix, written in TypeScript, and driven entirely by GraphQL. It follows a strict separation: no business logic in the client, no shared state across views. The Admin is one of Shopify’s biggest apps, built on Remix that behaves as a stateless GraphQL client. Each page fetches exactly the data it needs, when it needs it.

This discipline enforces consistency across platforms. Mobile apps and web admin screens speak the same language (GraphQL), reducing duplication and misalignment between surfaces.

### **Mobile Development with React Native**

Mobile development at Shopify follows a similar philosophy: reuse where possible, specialize where needed.

Every app now runs on React Native. The goal of using a single framework is to share code, reduce drift between platforms, and improve developer velocity across Android and iOS.

Shared libraries power common concerns like authentication, error tracking, and performance monitoring. When apps need to drop into native for camera access, payment hardware, or long-running background tasks, they do so through well-defined native modules.

Shopify teams also built FlashList (a high-performance list component) and contribute directly to React Native ecosystem projects like Skia (for fast 2D rendering), WebGPU (that enables modern GPU APIs and enables general-purpose GPU computation for AI/ML), and Reanimated (for performant animations). In some cases, Shopify engineers co-captain React Native releases.

## **Programming Languages and Frameworks**

Shopify’s language choices reflect its commitment to developer productivity and operational resilience.

- **Ruby** remains the backbone of Shopify’s backend. It powers the monolith, the engines, and most of the internal services. Along with Ruby, Shopify also uses **Sorbet**, a static type checker for Ruby, to fill the safety gap traditionally left open in dynamically typed systems. It enables early feedback on interface violations and contract boundaries.

- **Rust and Go** are Shopify's systems programming languages used in situations where Ruby is less suitable.

- **TypeScript** is a first-class language on the frontend. Paired with React, it provides predictable behavior across the web and mobile surfaces.

- **JavaScript** still appears in shared libraries and older assets, but most modern development favors TypeScript for its tooling and clarity.

- **Remix** is a full-stack web framework used across various aspects of the platform — Shopify Admin Interface, marketing websites, and Hydrogen, Shopify's headless commerce framework for building custom storefronts.

- **Python** is the default for ML pipelines and analytics.

## **Developer Tooling & Open Source Contributions**

A large monolith doesn’t stay healthy without support. Shopify has developed an ecosystem of internal and open-source tools to enforce structure, automate safety checks, and reduce operational toil.

- **Packwerk** enforces dependency boundaries between components in the monolith. It flags violations early, before they cause architectural drift.

- **Tapioca** automates the generation of Sorbet RBI (Ruby Interface) files, keeping static type definitions in sync with actual code.

- **Bootsnap** improves startup times for Ruby applications by caching expensive computations like YAML parsing and gem loading.

- **Maintenance Tasks** standardize background job execution. They make recurring tasks idempotent, safe to rerun, and easy to observe.

- **Toxiproxy** simulates unreliable network conditions such as latency, dropped packets, or timeouts, allowing services to test their behavior under stress.

- **TruffleRuby** is a high-performance Ruby implementation developed by Oracle. Shopify contributes to this as part of its broader effort to push Ruby further.

- **Semian** is a circuit breaker library for Ruby, protecting critical resources like Redis or MySQL from cascading failures during partial outages.

- **Roast** is a convention-oriented framework for creating structured AI workflows, maintained and used internally by the Augmented Engineering team at Shopify.

A much more exhaustive list of open-source software supported by Shopify is also present [here](https://shopify.github.io/).

## **Databases, Caching, and Queuing**

There are two main categories here:

### **Primary Database: MySQL**

Shopify uses MySQL as its primary relational database, and has done so since the platform's early days. However, as merchant volume and transactional throughput grew, the limits of a single instance became unavoidable.

In 2014, Shopify introduced sharding. Each shard holds a partition of the overall data, and merchants are distributed across those shards based on deterministic rules. This works well in commerce, where tenant isolation is natural. One merchant’s orders don’t need to query another merchant’s inventory.

Over time, Shopify replaced the flat shard model with Pods. A pod is a fully isolated slice of Shopify, containing its own MySQL instance, Redis node, and Memcached cluster. Each pod can run independently, and each one can be deployed in a separate geographic region.

[![](https://substackcdn.com/image/fetch/$s_!s8a3!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F16b40a68-c6dc-49b5-a320-fadc10441365_1600x1133.png)](https://substackcdn.com/image/fetch/$s_!s8a3!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F16b40a68-c6dc-49b5-a320-fadc10441365_1600x1133.png)

This model solves two problems:

- It removes single points of failure. An issue in one pod won't cascade across the fleet.

- It allows Shopify to scale horizontally by adding more pods instead of vertically scaling the database.

By pushing isolation to the infrastructure level, Shopify contains failure domains and simplifies operational recovery.

### **Caching and Queues**

Shopify relies on two core systems for caching and asynchronous work: Memcached and Redis.

### **Memcached**

Memcached functions as the distributed, in-memory key-value store for many use cases. Two main examples are query caching and full/partial page caching. By materializing the results of read-heavy operations, such as product listings and metadata, and other frequently requested content in memory, Memcached delivers single-digit millisecond access time and off-loads a significant percentage of traffic from the primary database cluster. This architecture provides two strategic advantages:

1. Performance: Data that would normally require multiple disk reads and complex SQL joins is returned directly from memory, cutting average response latency and improving end-user experience during peak load.

1. Scalability and Cost Control: Offloading hot reads to Memcached reduces CPU, I/O, and connection pressure on the relational database, allowing us to defer hardware upgrades and focus database capacity on write-bound and transaction-oriented workloads.

In short, Memcached enables high-throughput, low-latency retrieval of product information and other dynamic content without imposing additional load on the underlying database.

### **Redis**

Redis powers queues for background job processing. It supports Shopify’s asynchronous workflows, including webhook delivery, email sends, payment retries, and inventory syncs.

But Redis wasn’t always scoped cleanly. At one point, all database shards shared a single Redis instance.

The lesson Shopify took from this incident was clear: never centralize a system that’s supposed to isolate work. Afterward, Redis was restructured to match the MySQL shard model, giving each pod its own Redis node. Since then, the platform has become far more resilient, with most outages being localized to one pod.

## **Messaging and Communication Between Services**

There are two main categories of the same:

### **Eventing & Streaming**

Shopify uses Kafka as the backbone for messaging and event distribution. It forms the spine of the platform’s internal communication layer, decoupling producers from consumers, buffering high-volume traffic, and supporting real-time pipelines that feed search, analytics, and business workflows.

At peak, Kafka at Shopify has handled 66 million messages per second, a throughput level that few systems encounter outside large-scale financial or streaming platforms.

This messaging layer serves many use cases, including:

- Emitting domain events when core objects change (for example, order created, product updated)

- Driving ML inference workflows with near real-time updates

- Powering search indexing, inventory tracking, and customer notifications

By relying on Kafka, Shopify avoids tight synchronous coupling between services. Producers don't wait for consumers. Consumers process at their own pace. And when something goes wrong, like a downstream service crashing, the event stream holds the data until the system recovers.

That’s a practical way to build resilience into a fast-moving platform.

### **API Interfaces**

For synchronous interactions, Shopify services communicate over HTTP, using a mix of REST, GraphQL, and gRPC

- REST APIs still power much of the internal communication, especially between older services and support tools.

- GraphQL is the preferred interface for public-facing clients. It allows precise data queries, reduces over-fetching, and aligns with Shopify’s philosophy of pushing complexity to the server.

- gRPC is the new standard for internal communication.

## **A glimpse into the ML Infrastructure at Shopify**

The two examples described below represent only a portion of Shopify's broader, comprehensive ML system.

### **Real-Time Search with Embeddings**

Shopify’s storefront search doesn’t only rely on traditional keyword matching. It uses semantic search powered by text and image embeddings: vector representations of product metadata and visual features that enable more relevant, contextual search results.

Source: [Shopify Engineering Blog](https://shopify.engineering/how-shopify-improved-consumer-search-intent-with-real-time-ml)

[![](https://substackcdn.com/image/fetch/$s_!dCKV!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fa872a155-4493-4427-8cd1-bdd505576fd8_1800x921.png)](https://substackcdn.com/image/fetch/$s_!dCKV!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fa872a155-4493-4427-8cd1-bdd505576fd8_1800x921.png)

This system runs at production scale. Shopify processes around 2,500 embeddings per second, translating to over 216 million per day.

Each embedding is generated in near real time and immediately published to downstream consumers who use it to update search indices and personalize results.

[![](https://substackcdn.com/image/fetch/$s_!OJSN!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F3cb0c0c8-4377-4616-a1b8-57713dd9a742_1600x1133.png)](https://substackcdn.com/image/fetch/$s_!OJSN!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F3cb0c0c8-4377-4616-a1b8-57713dd9a742_1600x1133.png)

The embedding system also performs intelligent deduplication. For example, visually identical images are grouped to avoid unnecessary inference. This optimization alone reduced image embedding memory usage from 104 GB to under 40 GB, freeing up GPU resources and cutting costs across the pipeline.

### **Data Pipeline Infrastructure**

_Note: The data pipeline infrastructure is currently undergoing changes._

Under the hood, Shopify runs its ML pipelines on a robust cloud platform, with clusters managed efficiently to support our needs.

- Streaming inference at scale

- GPU acceleration

- Efficient pipeline parallelism

Streaming inference jobs are structured to process embeddings as quickly and cheaply as possible. The pipeline uses a bunch of optimizations to ensure performance remains predictable under load.

Shopify trades off between latency, throughput, and infrastructure cost. The current configuration strikes that balance carefully:

- Embeddings are generated fast enough for near-real-time updates

- GPU memory is used efficiently

- Redundant computation is avoided through smart caching and pre-filtering

For offline analytics, Shopify stores embeddings in BigQuery, allowing large-scale querying, trend analysis, and model performance evaluation without affecting live systems.

## **DevOps, CI/CD & Deployment**

This area can be divided into the following parts:

### **Kubernetes-Based Deployment**

Much of Shopify’s infrastructure is deployed on Kubernetes, running on Google Kubernetes Engine (GKE).

The runtime environment uses containers for packaging applications.

Before Kubernetes, deployment was managed through Chef, a configuration management tool better suited for static environments. As the platform evolved, so did the need for a more dynamic management control plane.

### **CI/CD Process**

_Note: The CI/CD process is currently undergoing changes._

Shopify’s monolith contains over 400,000 unit tests, many of which exercise complex ORM behaviors. Running all of them serially would take hours, maybe days. To stay fast, Shopify relies on Buildkite as its CI orchestrator. Buildkite coordinates test runs across hundreds of parallel workers, slashing feedback time and keeping builds within a 15–20 minute window.

Once the build passes, Shopify's internal deployment tools take over and offer visibility into who's deploying what, and where.

Source: [Shopify Engineering Blog](https://shopify.engineering/e-commerce-at-scale-inside-shopifys-tech-stack)

[![](https://substackcdn.com/image/fetch/$s_!7GJ5!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F9a49f944-d87e-4bef-8355-da6d591c9db8_1999x1406.heic)](https://substackcdn.com/image/fetch/$s_!7GJ5!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F9a49f944-d87e-4bef-8355-da6d591c9db8_1999x1406.heic)

Deployments don’t go straight to production. Instead, Shopify uses Graphite's gt tool for stacking pull requests (PRs) in development, the Graphite Merge Queue for merging, and an in-house release management tool for managing deployments and release cycles. This throttling makes issues easier to trace and minimizes the blast radius when something breaks.

Notably, Shopify doesn’t rely on staging environments. They do canary deployments and use feature flags to control exposure and fast rollback mechanisms to undo bad changes quickly. If a feature misbehaves, it can be turned off without redeploying the code.

## **Observability, Reliability, and Security**

This area can be divided into multiple parts, such as:

### **Observability Infrastructure**

Incident response isn’t siloed into a single ops team. Shopify uses a lateral escalation model: all engineers share responsibility for uptime, and escalation happens based on domain expertise, not job title. This encourages shared ownership and reduces handoff delays during critical outages. Shopify also has a Resiliency org that helps bring resiliency tooling and efforts across the org, as well as incident management and 24x7 follow-the-sun SRE support.

For fault tolerance, Shopify leans on two key tools:

- **Semian**, a circuit breaker library for Ruby, helps protect core services like Redis and MySQL from cascading failures during degradation.

- **Toxiproxy** lets engineers simulate bad network conditions (latency spikes, dropped packets, service flaps) before those issues appear in production. It’s used in test environments to validate resilience assumptions early.

### **Supply Chain & Security**

Security isn’t an afterthought in Shopify’s stack, but part of the ecosystem investment. Since the company relies heavily on Ruby, it also works actively to secure the Ruby community at large. Shopify partners with non-profit organizations that oversee Ruby and Rails infrastructure

The goal isn’t just to secure Shopify’s stack, but to strengthen the foundation shared by thousands of developers who depend on the same tools.

## **Shopify’s Scale**

Shopify's architecture isn’t theoretical. It’s built to withstand real-world pressure—Black Friday flash sales, celebrity product drops, and continuous developer activity across a global platform. These numbers put that scale in context.

- $5 billion in Gross Merchandise Volume (GMV) processed on Black Friday.

- 284 million requests per minute at the edge during peak load.

- 173 billion total requests handled in a single 24-hour period.

- 12 terabytes of traffic egress per minute across Shopify’s edge network.

- 45 million database queries per second at peak read load.

- 7.6 million database writes per second during transactional bursts.

- 66 million Kafka messages per second, sustaining Shopify’s real-time event pipelines.

- 400,000+ unit tests executed in CI on every monolith build.

- 216 million embeddings processed per day through ML inference pipelines.

- >99.9% crash-free session rate across React Native mobile apps.

- 2.8 million lines of Ruby code in the monolith, with over 500,000 commits in version control.

- 100+ isolated shards.

- 100+ internal Rails apps, maintained alongside the monolith using shared standards.

**References**:

- [Shopify Tech Stack: ECommerce at Scale](https://shopify.engineering/e-commerce-at-scale-inside-shopifys-tech-stack)

- [Shopify’s 5-year migration over to to React Native](https://shopify.engineering/five-years-of-react-native-at-shopify)

- [AI-powered search features](https://shopify.engineering/how-shopify-improved-consumer-search-intent-with-real-time-ml)

- Open-source [tools that Shopify uses](https://shopify.engineering/shopify-open-source-philosophy)

- [Details about our core monolith](https://shopify.engineering/shopify-monolith)

- [Shopify Open Source](https://shopify.github.io/)