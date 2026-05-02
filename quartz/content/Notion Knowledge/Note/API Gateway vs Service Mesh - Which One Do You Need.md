---
Created by: Bách Đặng Thọ
Created time: 2025-09-14T18:04
---
Modern software systems rarely live in isolation. Most applications today are stitched together from dozens,  sometimes hundreds, of independently deployed services, each handling a piece of the puzzle. This helps create smaller units of responsibility and loose coupling. However, the flexibility comes with a new kind of complexity, especially around how these services communicate.

In a monolith, in-process function calls stitch components together. In a service-based world, everything talks over the network. Suddenly, concerns that were once handled inside the application, like retries, authentication, rate limiting, encryption, and observability, become distributed concerns. And distributed concerns are harder to get right.

To manage this complexity, engineering teams typically reach for one of two patterns: the API gateway or the service mesh.

Both aim to make communication between services more manageable, secure, and observable. But they do it in very different ways, and for different reasons. The confusion often starts when these tools are treated as interchangeable or when their roles are reduced to simple traffic direction: "API gateways are for north-south traffic, service meshes are for east-west." That shortcut oversimplifies both and sets teams up for misuse or unnecessary overhead.

In this article, we look at both API Gateways and Service Mesh in detail, along with their key differences and usage goals.

[![](https://substackcdn.com/image/fetch/$s_!31us!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F3530d961-653b-4631-95db-004c0df05073_2250x2624.png)](https://substackcdn.com/image/fetch/$s_!31us!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F3530d961-653b-4631-95db-004c0df05073_2250x2624.png)

## **What is an API Gateway?**

An API gateway acts as the front door to a system. It sits between external clients (web browsers, mobile apps, partner systems) and the backend services that do the work. Every request from the outside world flows through this centralized layer before reaching the services behind it.

At its core, the API gateway pattern solves one fundamental problem: how to expose a distributed set of backend services through a single, manageable entry point. It does this by operating at Layer 7 (L7) of the OSI model (the application layer), where it has full visibility into HTTP requests, headers, and payloads. That position gives it powerful control over how requests are handled.

[![](https://substackcdn.com/image/fetch/$s_!UzFM!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F7733bdca-052d-472e-96c1-93e648a23c93_1992x1216.png)](https://substackcdn.com/image/fetch/$s_!UzFM!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F7733bdca-052d-472e-96c1-93e648a23c93_1992x1216.png)

This pattern is especially common for requests coming from outside the system into the data center or cloud environment. But in practice, many teams also route internal requests through the gateway when they need consistent access policies or observability.

An effective API gateway handles a wide range of responsibilities, offloading work from backend services and standardizing how clients interact with them. Here are some core responsibilities:

- **Request Routing and Protocol Translation:** The gateway routes requests to the appropriate backend service based on the path, method, or other metadata. It can also act as a protocol translator, converting between HTTP, gRPC, WebSocket, or other formats to match what each service expects.

- **Authentication and Authorization:** A central place to enforce identity and access control. This might include OAuth2 token validation, API key enforcement, or integrating with identity providers. Instead of duplicating auth logic across services, the gateway handles it up front.

- **Rate Limiting and Request Shaping:** To prevent abuse or overload, the gateway can throttle clients, limit request frequency, or block malformed payloads before they hit internal systems.

- **Load Balancing and Caching:** API gateways often balance traffic across multiple service instances. They may also cache frequent responses, reducing load on backend services and speeding up response times for clients.

- **Observability and Analytics:** Because it sits on the request path, the gateway becomes a natural place to collect logs, metrics, and traces. These insights help teams understand traffic patterns, troubleshoot latency, and detect anomalies.

- **API Versioning and Abstraction:** Backend services evolve, but clients don’t always update immediately. The gateway can present a stable interface to consumers while routing requests to newer versions behind the scenes. It also enables aggregation, combining responses from multiple services into one payload.

The diagram below shows the various features and functionalities of an API Gateway:

[![](https://substackcdn.com/image/fetch/$s_!GcXx!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F893588c6-f136-45f7-ad47-626e4a21728a_1992x1816.png)](https://substackcdn.com/image/fetch/$s_!GcXx!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F893588c6-f136-45f7-ad47-626e4a21728a_1992x1816.png)

Beyond runtime concerns, many gateways serve as the anchor point for API productization. When APIs are treated as products that are used by internal teams, partners, or third-party developers, more is needed than just routing and auth.

Modern gateways often tie into broader API management platforms that support various capabilities such as:

- Developer portals with documentation and testing tools

- Self-service onboarding for developers

- API monetization features (for example, tiered plans or billing hooks)

- Mocking and testing environments before deployment

- Access control dashboards for administrators

## **What is a Service Mesh?**

A service mesh is an infrastructure layer that manages service-to-service communication in a distributed system. It focuses on the internal traffic that flows between services inside a data center or cloud environment. While API gateways protect the edge, the service mesh secures and controls the interior.

What makes service mesh different is how it handles this control. Instead of baking networking logic into application code, the mesh delegates it to lightweight network proxies called sidecars that run alongside each service instance. These proxies intercept all inbound and outbound traffic, enforcing policies without requiring services to be aware of them.

[![](https://substackcdn.com/image/fetch/$s_!PUsd!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F71543b63-9ac4-4c4f-bea9-103cd25fcdc3_1992x1514.png)](https://substackcdn.com/image/fetch/$s_!PUsd!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F71543b63-9ac4-4c4f-bea9-103cd25fcdc3_1992x1514.png)

This design shifts networking from application code to the infrastructure, bringing consistency, security, and observability across the system without touching the service logic.

A typical service mesh architecture is split into two parts:

- **Data Plane:** The data plane consists of **sidecar proxies**: one running next to each service instance. These proxies sit directly on the execution path of requests, handling traffic routing, encryption, authentication, retries, and more. Since each proxy is paired with a specific service, the deployment model is decentralized.

- **Control Plane:** The control plane is the brain of the operation. It pushes configuration and policies to the sidecar proxies, manages service identities, and coordinates updates. It is not on the request path, which helps reduce latency, but makes it essential that proxies remain connected and in sync.

This separation ensures that data path operations are lightweight and fast, while administrative logic remains centralized and easier to manage.

The key responsibilities of a service mesh are as follows:

- **mTLS Encryption and Service Identity:** Every service gets a unique identity, often backed by certificates. Sidecar proxies enforce mutual TLS (mTLS) between services, ensuring traffic is encrypted and only trusted services can talk to each other.

- **Dynamic Service Discovery and Routing:** Proxies automatically discover where to send requests, often without hardcoded IPs or DNS tricks. This enables seamless scaling and migration of services without client-side awareness.

- **Load Balancing and Retries:** Each proxy performs intelligent routing and load balancing, spreading traffic across service instances. It also handles retries and timeouts transparently, avoiding code duplication in each service.

- **Tracing, Metrics, and Logging:** Proxies emit telemetry data that feeds into observability platforms. Since every request flows through the mesh, teams gain full visibility into service interactions, latency, and failure points, without instrumenting every application.

- **Resilience Features: Circuit Breaking and Fault Injection:** Meshes can automatically short-circuit failing services to avoid cascading failures.

- **Access Control and Policy Enforcement:** Fine-grained access rules determine which services can talk to each other. Policies can be updated at runtime, scoped to services, namespaces, or even request metadata.

Service meshes thrive in highly dynamic environments, especially container orchestrators like Kubernetes, where services scale up and down constantly, IPs change frequently, and communication patterns evolve quickly. In these contexts, writing custom networking logic inside each service doesn’t scale.

## **Key Differences: Deployment, Scope, and Use Cases**

A mature architecture often needs both API Gateways and Service Mesh. Understanding how they differ helps avoid forcing one tool to do the other’s job or worse, layering both without understanding what each contributes.

Let’s look at the key differentiation points:

### **1 - Deployment Model**

API gateways are centralized components. They typically run as edge-facing services or ingress controllers, handling all traffic that enters the system. One instance or a small cluster manages the full flow of incoming requests, which makes it easy to enforce global policies and observe all external interactions from a single point.

Service meshes, by contrast, are decentralized. They embed control at the service level, deploying a sidecar proxy alongside every service replica. That model pushes traffic control to the edges of each application, turning policy enforcement and routing into localized operations. The result is fine-grained control, but at the cost of increased infrastructure footprint and coordination.

### **2 - Layer of Operation**

API gateways operate at Layer 7 (L7) or the application layer. They understand high-level protocols like HTTP, HTTPS, and WebSocket. That focus makes them ideal for tasks that depend on full visibility into request paths, headers, and payloads like routing based on URL patterns or injecting authorization tokens.

Service meshes span both Layer 4 (L4) and Layer 7. They handle low-level TCP and UDP traffic, while also inspecting L7 metadata when needed. This broader scope allows them to manage diverse communication protocols (gRPC, raw TCP streams, or even database calls) without being tightly coupled to the HTTP layer.

### **3 - Scope of Control**

An API gateway governs access from outside the system. It controls who can reach which services, how requests are shaped, and how failures are surfaced to clients. It’s the front door of the architecture, deciding what gets in and what gets blocked.

A service mesh controls communication inside the system. It manages how services talk to each other, routes internal requests, and enforces rules about what is allowed to call what. It also adds visibility into internal failures that would otherwise get lost between services.

### **4 - Identity and Trust**

Service meshes assign identity to services using mutual TLS (mTLS). Every service gets a unique certificate, and every connection between services is encrypted and authenticated. This enables a zero-trust model internally. In other words, no implicit trust based on IP addresses or networks.

API gateways focus on external identity. They handle OAuth2, JWTs, API keys, or client certificates to authenticate external users or systems.

### **5 - Use Case Breadth**

API gateways do more than route traffic. They support API productization, enabling teams to expose, document, version, monetize, and secure their APIs. Features like developer portals, onboarding flows, and analytics dashboards turn APIs into shareable, consumable products, especially in B2B and internal platform settings.

[![](https://substackcdn.com/image/fetch/$s_!dFmp!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fd2a30ac1-dac2-4583-9dc0-1602026e90c3_1992x1610.png)](https://substackcdn.com/image/fetch/$s_!dFmp!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fd2a30ac1-dac2-4583-9dc0-1602026e90c3_1992x1610.png)

Service meshes don’t deal with API consumption. Their focus is service connectivity, reliability, and security. They don’t expose APIs to external consumers or provide developer self-service tools. Instead, they aim to make internal communication safer and more resilient.

## **When to Use API Gateway?**

An API gateway shines when the boundary between external clients and internal services needs to be managed with care. This edge layer becomes the control point for how users, applications, and partners access backend systems. When traffic originates outside the system or when internal teams are treated as consumers of shared APIs, the gateway simplifies complexity and enforces consistency.

Here are some important use cases for API Gateways:

### **Exposing APIs to External Consumers or Internal Teams**

When backend services need to be exposed beyond the team that built them, whether to external partners, mobile apps, frontend teams, or other internal squads, the API gateway becomes a clean access point. It wraps internal systems in a stable interface, hiding internal churn while offering a contract to consumers.

Without a gateway, teams often end up hardcoding service endpoints, maintaining inconsistent interfaces, or duplicating access logic. The gateway centralizes that responsibility.

### **Managing Authentication, Authorization, and Rate Limits**

APIs that face the outside world must be protected. Gateways enforce authentication (for example, API keys, JWTs, OAuth2) and authorization policies up front before requests reach sensitive business logic.

[![](https://substackcdn.com/image/fetch/$s_!ccgH!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fe614f19e-35ef-40ae-920f-b789a4c57e5f_2456x1514.png)](https://substackcdn.com/image/fetch/$s_!ccgH!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fe614f19e-35ef-40ae-920f-b789a4c57e5f_2456x1514.png)

They also prevent misuse or abuse through rate limiting and throttling, which helps safeguard downstream services from being overwhelmed. Without these controls, one buggy client—or one aggressive scraper—can degrade performance for everyone else.

### **Providing a Consistent Developer Experience**

APIs are products. When treated as such, they need more than an endpoint. They also need documentation, testing tools, and onboarding flows. Many gateways integrate with developer portals, where teams can:

- Explore available APIs

- Generate credentials

- Try out endpoints in a sandbox

- Monitor usage and errors

This becomes especially valuable in platform engineering contexts, where teams expose reusable services across the organization.

### **Acting as a Façade Over Backend Evolution**

Backend services change, but APIs should not do so in a way that breaks consumers. The gateway acts as a translation layer, enabling teams to evolve internal systems without forcing every client to adapt immediately.

It supports versioning strategies, response transformation, and request aggregation. This abstraction shields clients from internal refactors or service splits.

[![](https://substackcdn.com/image/fetch/$s_!ot8M!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F5635e141-6b2b-4b71-8299-8958e7ccfd9a_1992x1610.png)](https://substackcdn.com/image/fetch/$s_!ot8M!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F5635e141-6b2b-4b71-8299-8958e7ccfd9a_1992x1610.png)

### **Handling Diverse Client Types**

Different clients have different needs. A mobile app might require lightweight payloads. A web dashboard might make frequent polling calls. A third-party partner might call from a slower network or use an older protocol.

The gateway accommodates these differences by:

- Compressing responses for mobile

- Caching static data for web apps

- Translating protocols for legacy clients

This flexibility keeps backend services focused on business logic while the gateway handles adaptation at the edge.

## **When to Use a Service Mesh**

In modern systems, especially those built on Kubernetes or other container platforms, services are ephemeral, dynamic, and interconnected. Each network call introduces a point of failure. Each dependency adds coupling. And each inconsistency in how services talk to each other increases operational overhead.

The service mesh steps in to create a uniform communication layer that handles reliability, security, and observability, without requiring every service to reimplement the same boilerplate logic.

Here are the key use cases of a service mesh:

### **Managing a Large Number of Microservices**

In small systems, direct service-to-service calls with basic DNS-based discovery might suffice. But once the architecture grows—dozens or hundreds of microservices, each deployed independently—the network becomes a distributed minefield.

[![](https://substackcdn.com/image/fetch/$s_!axGm!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fd688502f-df1a-44af-8e9f-a08058dfadb4_1992x1216.png)](https://substackcdn.com/image/fetch/$s_!axGm!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fd688502f-df1a-44af-8e9f-a08058dfadb4_1992x1216.png)

Routing rules get complicated. Dependencies shift constantly. One service’s failure can ripple through the rest. A service mesh abstracts away this chaos by managing routing, retries, discovery, and failure handling consistently across the system.

Instead of every team building their networking library, the mesh handles it uniformly—one configuration change applies everywhere.

### **Achieving Observability Without Changing Application Code**

Understanding what happens across microservices requires distributed tracing, latency metrics, traffic logs, and error tracking. Without a mesh, that means modifying every service to emit telemetry.

With a service mesh, sidecar proxies emit telemetry automatically, since they sit on the request path. This enables full visibility across the system (end-to-end traces, service dependency graphs, real-time metrics) without changing a line of application code.

This is especially powerful during on-call incidents, when teams need quick insight into which service is slow, broken, or misbehaving, without digging through logs from five different places.

### **Enforcing Zero-Trust Security Internally**

The zero-trust model says no service should implicitly trust another, even inside the same network. Every call must be authenticated, encrypted, and auditable.

A service mesh enforces this with mutual TLS (mTLS) between all services. It assigns identities to services, rotates certificates, and blocks unauthorized communication. This closes the gaps left by traditional perimeter-based security models, especially in multi-tenant or multi-cluster environments.

### **Requiring Advanced Traffic Control**

Some of the most valuable features of a service mesh live in its traffic control layer. This includes:

- Automatic retries with jitter and backoff

- Failovers to healthy instances

- Circuit breakers to isolate unstable services

- Timeout enforcement

- Canary releases and traffic splitting

## **Can We Use Both Together?**

API gateways and service meshes solve different problems at different layers of a distributed system, and in many modern setups, they work best together.

Used together, these tools form a clean boundary: the API gateway controls how external systems enter, and the service mesh governs how services interact once inside. This layered model brings clarity and control to both user-facing and internal concerns.

For example, imagine a multi-tenant SaaS platform running on Kubernetes. A user logs in through a mobile app, which sends an authenticated request to an endpoint managed by the API gateway. The gateway validates the token, applies rate limits, and transforms the request into a gRPC call.

That call is then forwarded to a service—say, cart-service—which lives inside a mesh-enabled cluster. From there, the mesh takes over. The request is securely routed to the correct instance, retries are handled automatically if latency spikes occur, and any calls from cart-service to inventory or payments follow mesh policies, including circuit breakers and trace emission.

Notably, the API gateway can live as a service within the mesh. This allows it to participate in mTLS-based encryption, benefit from mesh-wide observability, and route requests using service discovery. It acts as the system’s front door but still plays by the same internal rules as the services it connects.

## **Summary**

In this article, we’ve looked at API Gateway and Service Mesh in detail.

Here are the key learning points in brief:

- Microservices increase flexibility but introduce complex communication challenges that must be managed explicitly.

- API gateways act as centralized entry points, managing external requests and exposing services cleanly and securely.

- Service meshes manage internal service-to-service communication, providing security, observability, and resilience inside the system.

- API gateways typically operate at Layer 7 and are ideal for handling HTTP-based, client-facing traffic.

- Service meshes operate at both Layer 4 and Layer 7, supporting a wider range of protocols and communication patterns.

- API gateways centralize authentication, rate limiting, caching, and routing for external clients.

- Service meshes decentralize communication control using sidecars, enabling encryption, retries, tracing, and access policies without changing app code.

- API gateways simplify client interaction, enable API versioning, and provide developer portals and analytics for productized APIs.

- Service meshes enforce zero-trust security through mTLS and automate routing and resilience across internal service calls.

- API gateways are best suited for managing ingress traffic from web, mobile, or third-party integrations.

- Service meshes are ideal for complex, dynamic microservice environments where internal service interactions need reliability and visibility.

- The two are not mutually exclusive. Gateways and meshes complement each other when layered properly.

- In a combined setup, the API gateway handles external traffic at the edge, while the mesh secures and manages communication within the cluster.

- Treating API gateways and service meshes as interchangeable leads to architectural mistakes. Each has a distinct role and strength.

- Mature systems benefit from using both, creating a secure, observable, and adaptable communication layer from edge to core.