---
Created by: Bách Đặng Thọ
Created time: 2025-09-09T01:03
---
_Disclaimer: The details in this post have been derived from the articles shared online by the Tinder Engineering Team. All credit for the technical details goes to the Tinder Engineering Team.  The links to the original articles and sources are present in the references section at the end of the post. We’ve attempted to analyze the details and provide our input about them. If you find any inaccuracies or omissions, please leave a comment, and we will do our best to fix them._

API gateways sit at the front line of any large-scale application. They expose services to the outside world, enforce security, and shape how clients interact with the backend. Most teams start with off-the-shelf solutions like AWS API Gateway, Apigee, or Kong. And for many use cases, these tools work well, but at some points, they might not be sufficient.

Tinder reached that point sometime around 2020.

Over the years, Tinder scaled to over 500 microservices. These services communicate internally via a service mesh, but external-facing APIs, handling everything from recommendations to matches to payments, needed a unified, secure, and developer-friendly entry point. Off-the-shelf gateways offered power, but not precision. They imposed constraints on configuration, introduced complexity in deployment, and lacked deep integration with Tinder’s cloud stack.

There was also a velocity problem. Product teams push frequent updates to backend services and mobile clients. The gateway needed to keep up. Every delay in exposing a new route or tweaking behavior at the edge slowed down feature delivery.

Then came the bigger concern: security. Tinder operates globally. Real user traffic pours in from over 190 countries. So does bad traffic that includes bots, scrapers, and abuse attempts. The gateway became a critical choke point. It had to enforce strict controls, detect anomalies, and apply protective filters without slowing down legitimate traffic.

The engineering team needed more than an API gateway. It needed a framework that could scale with the organization, integrate deeply with internal tooling, and let teams move fast without compromising safety.

This is where TAG (Tinder API Gateway) was born.

## **Challenges before TAG**

Before TAG, gateway logic at Tinder was a patchwork of third-party solutions. Different application teams had adopted different API gateway products, each with its own tech stack, operational model, and limitations. What worked well for one team became a bottleneck for another.

This fragmented setup introduced real friction:

- Incompatible tech stacks made it hard to share code or configuration.

- Reusable components couldn’t propagate across teams, leading to duplication and drift.

- Session management behavior varied across gateways, creating subtle bugs and inconsistent user experiences.

- Operational overhead climbed. Each gateway had its own quirks, upgrade cycle, and maintenance cost.

- Deployment velocity slowed. Teams spent more time learning, debugging, and working around gateway limitations than shipping features.

Here’s a glimpse at the complexity of session management across APIs at Tinder before TAG.

Source: [Tinder Tech Blog](https://medium.com/tinder/how-we-built-the-tinder-api-gateway-831c6ca5ceca)

[![](https://substackcdn.com/image/fetch/$s_!7CyC!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F1fb67bca-56e5-41f8-adfd-3cd0dc2a43dd_1400x711.png)](https://substackcdn.com/image/fetch/$s_!7CyC!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F1fb67bca-56e5-41f8-adfd-3cd0dc2a43dd_1400x711.png)

At the same time, core features were simply missing or difficult to implement in existing gateways. Some examples were as follows:

- No clean way to spin up per-application gateways that could scale independently.

- Limited support for Kubernetes-native workflows, which Tinder had already adopted elsewhere.

- Configuration formats were heavy or inflexible, slowing down teams trying to expose or modify routes.

- Building custom middleware, such as filters for bot detection or request schema enforcement, was either unsupported or painful to maintain.

- Transforming requests and responses at the edge required writing boilerplate or adopting brittle plugins.

These weren’t edge cases. They were daily needs in a fast-moving, global-scale product.

The need was clear: a single, internal framework that let any Tinder team build and operate a secure, high-performance API gateway with minimal friction.

## **Limitations of Existing Solutions**

Before building TAG, the team evaluated several popular API gateway solutions, including AWS API Gateway, Apigee, Kong, Tyk, KrakenD, and Express Gateway.

Each of these platforms came with its strengths, but none aligned well with the operational and architectural demands at Tinder.

Several core issues surfaced during evaluation:

- Weak integration with Envoy, which serves as the backbone of Tinder's internal service mesh.

- Configuration overhead was high. Setting up even basic routes or transformations involved verbose config files, unfamiliar plugin systems, or custom scripting.

- Steep learning curves slowed down onboarding and debugging. Teams had to learn the internals of each gateway rather than focus on delivering features.

- Poor support for Tinder's preferred languages and tooling meant more glue code and less reuse. The friction added up quickly.

- Extensibility was limited. Adding custom filters or middleware often meant forking the gateway, writing unsupported plugins, or dealing with brittle lifecycle hooks.

## **What is TAG?**

TAG, short for Tinder API Gateway, is a JVM-based framework built on top of Spring Cloud Gateway.

It isn’t a plug-and-play product or a single shared gateway instance. It’s a gateway-building toolkit. Each application team can use it to spin up its own API gateway instance, tailored to its specific routes, filters, and traffic needs. See the diagram below for reference:

[![](https://substackcdn.com/image/fetch/$s_!3cdl!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F764e84f2-b22c-4cd9-ab61-371d622b941c_1600x932.png)](https://substackcdn.com/image/fetch/$s_!3cdl!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F764e84f2-b22c-4cd9-ab61-371d622b941c_1600x932.png)

At its core, TAG turns configuration into infrastructure. Teams define their routes, security rules, and middleware behavior using simple YAML or JSON files. TAG handles the rest by wiring everything together behind the scenes using Spring’s reactive engine.

This design unlocks three critical outcomes:

- Faster developer workflows, since most changes require no code, only config.

- Stronger security boundaries, because teams own and isolate their gateway instances.

- Better reuse, through shared filters and common middleware patterns.

From a developer's perspective, the experience looks like this:

- Define routes in a configuration file.

- Apply built-in filters like setPath, rewriteResponse, or addHeader.

- Reuse global filters for shared concerns like auth or metrics.

- Drop in custom filters where specific validation, transformation, or control is needed.

## **TAG Boot Flow**

Most API gateways suffer when the configuration grows large. Routes take time to load. Filters add complexity. Some systems even parse the config on the fly, introducing latency at request time. TAG avoids this entirely by doing the heavy lifting at startup.

Built on Spring Cloud Gateway, TAG extends the default lifecycle with custom components that process all configuration before traffic begins to flow. The result is a fully prepared routing engine that’s ready from the first request.

Here’s how the boot flow works:

- Gateway Watcher initiates the process, signaling that it’s time to load route definitions.

- Gateway Config Parser reads the environment-specific YAML configuration and validates the structure. This includes route paths, predicates, filters, and backend service bindings.

- Gateway Manager assembles a mapping of route IDs to their associated filters (pre-built, custom, and global).

- Gateway Route Locator takes that mapping and binds each route’s predicates and filters into Spring Cloud Gateway’s internal routing engine.

- The complete routing table is loaded into memory, so by the time TAG starts receiving traffic, there’s no need for any runtime parsing or config evaluation.

[![](https://substackcdn.com/image/fetch/$s_!jKjQ!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F9127beac-b62c-4958-b577-93b6fef61038_1600x1097.png)](https://substackcdn.com/image/fetch/$s_!jKjQ!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F9127beac-b62c-4958-b577-93b6fef61038_1600x1097.png)

This design ensures that routing logic executes with minimal overhead. Every decision has already been made. Every route, predicate, and filter is compiled into the runtime graph.

The trade-off is simple and deliberate: if something is misconfigured, the gateway fails fast at startup instead of failing slowly during production traffic. It enforces correctness early and protects runtime performance.

## **Request Lifecycle in TAG**

When a request hits a TAG-powered gateway, it passes through a well-defined pipeline of filters, transformations, and lookups before reaching the backend. This flow is a consistent execution path that gives teams control at each stage.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!3pgp!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F4e33a8df-cdc6-4869-ac21-64d02a6b448d_1600x1013.png)](https://substackcdn.com/image/fetch/$s_!3pgp!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F4e33a8df-cdc6-4869-ac21-64d02a6b448d_1600x1013.png)

Here’s how TAG handles an incoming request from start to finish:

### **Reverse Geo IP Lookup (RGIL)**

The first step is geolocation. TAG applies a global filter that maps the client’s IP address to a three-letter ISO country code. This lightweight check powers:

- Country-specific rate limiting

- Geo-aware request banning

- Regional feature gating

The filter runs before any route matching, ensuring even invalid or blocked paths can be stopped early.

### **Request and Response Scanning**

TAG captures request and response schemas, not full payloads. This happens through a global, asynchronous filter that publishes events to Amazon MSK (Kafka).

The data stream enables:

- Automatic schema generation for API documentation

- Bot detection, based on request patterns and shape

- Anomaly detection tools that analyze traffic structure in real time

The filter works off the main thread, avoiding impact on request latency.

### **Session Management**

A centralized global filter handles session validation and updates, ensuring that session logic stays consistent across all gateways and services.

There is no per-service session drift or duplicated logic.

### **Predicate Matching**

Once preliminary filters are complete, TAG matches the request path to a configured route using Spring Cloud Gateway’s predicate engine.

If no match is found, the request is rejected early.

### **Service Discovery**

With the route identified, TAG uses Envoy's service mesh to resolve the correct backend service. This approach decouples routing from fixed IPs or static service lists.

### **Pre-Filters**

Before forwarding the request, TAG applies any pre-filters defined for that route. These can include:

- Weighted routing across different backend versions.

- HTTP to gRPC conversion, when frontend clients talk HTTP but the backend speaks gRPC.

- Custom filters, like trimming headers or validating request fields.

Pre-filters run in a defined sequence, determined by the configuration.

### **Post-Filters**

After the backend service responds, TAG processes the output through post-filters. These often include:

- Logging or error enrichment

- Header modification or masking sensitive fields

- Response transformations for shape normalization

Again, execution order is configurable.

### **Final Response**

Once all post-filters complete, the final response is sent back to the client. No surprises, no side effects.

Every filter (pre, post, global, or custom) follows a strict execution order. Developers can:

- Insert custom logic at any stage.

- Share filters across routes.

- Define the exact execution priority.

This predictability is what makes TAG maintainable under load.

## **Conclusion**

TAG has become the standard API gateway framework across Tinder. Instead of relying on one centralized gateway instance, each application team deploys its TAG instance with application-specific configurations. This model gives teams autonomy while preserving consistency in how routes are defined, traffic is filtered, and security is enforced.

Every TAG instance scales independently, making it easy to adapt to changes in traffic patterns, feature launches, or business priorities. TAG now powers both B2C and B2B traffic, not just for Tinder, but also for other Match Group brands like Hinge, OkCupid, PlentyOfFish, and Ship.

See the visualization below for this capability.

Source: [Tinder Tech Blog](https://medium.com/tinder/how-we-built-the-tinder-api-gateway-831c6ca5ceca)

[![](https://substackcdn.com/image/fetch/$s_!JO0E!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F7afa9463-019b-44c1-8410-3a1421d5294f_1400x689.png)](https://substackcdn.com/image/fetch/$s_!JO0E!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F7afa9463-019b-44c1-8410-3a1421d5294f_1400x689.png)

TAG’s design unlocks several long-term advantages:

- Session and authentication logic are standardized, removing inconsistency between teams and services.

- Custom plugin support allows for rapid experimentation and fine-tuned behavior at the edge.

- No vendor lock-in means Tinder controls its evolution path without waiting for third-party roadmap updates.

- Route-as-Config (RAC) lets teams push changes faster without writing code or waiting on central teams.

Beyond current production use, TAG lays the foundation for future initiatives that require visibility and control at the API layer.

The lesson here isn’t that every company needs to build a custom gateway. The lesson is that at a certain scale, flexibility, consistency, and performance can’t be solved with off-the-shelf tools alone. TAG works because it’s deeply shaped by how Tinder builds, deploys, and defends its software, without compromising developer velocity or operational clarity.

**References:**

- [How we built the Tinder API Gateway](https://medium.com/tinder/how-we-built-the-tinder-api-gateway-831c6ca5ceca)

- [Spring Cloud Gateway](https://cloud.spring.io/spring-cloud-gateway/reference/html/)