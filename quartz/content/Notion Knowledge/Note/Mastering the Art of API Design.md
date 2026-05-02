---
Created by: Bách Đặng Thọ
Created time: 2025-09-29T01:13
---
In this three-part series, we talk about API design:

1. Why is the “API First” principle important for an organization?

1. How do we design effective and safe APIs?

1. What are the tools that can boost productivity?

APIs are a set of protocols that define how system components interact with each other. As architectural styles evolve, APIs have gained prominence in recent years. The diagram below shows how the rise of microservices and cloud-native applications brings further granularity to services. In-process calls in monolithic applications transition to inter-process calls in microservice and serverless applications. Additionally, each process might reside on a different physical server, and service calls can fail due to various network issues.

Increased service complexity emphasizes the need for more disciplined API designs.

[![](https://substackcdn.com/image/fetch/$s_!kl0v!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fa5e7db07-a20d-4958-b8be-40748addc5e7_1600x936.png)](https://substackcdn.com/image/fetch/$s_!kl0v!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fa5e7db07-a20d-4958-b8be-40748addc5e7_1600x936.png)

# **API First**

Over the past decade, “API First” has emerged as a popular software development model. It prioritizes API design before system design. Various functional teams and systems use APIs as a shared communication language. For example, frontend developers, backend developers, and QA teams work together to design APIs based on system requirements. These APIs serve as specifications for business requirements and system designs. Each team then works independently, and they reconvene during the dev testing phase.

The diagram below compares the “Code First” and “API First” approaches. In the “Code First” model, APIs are byproducts of system designs, often referred to as “documentation”. The "API First" model begins with API specifications and concludes with API-driven tests, making APIs the driving force behind the entire software development cycle.

[![](https://substackcdn.com/image/fetch/$s_!4mHS!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Faad520f5-00d9-4606-af4b-fdb5d1ac63c4_1600x1483.png)](https://substackcdn.com/image/fetch/$s_!4mHS!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Faad520f5-00d9-4606-af4b-fdb5d1ac63c4_1600x1483.png)

"API First" offers several advantages:

1. Improved system integration. “API First” encourages developers to carefully consider system interactions from the project’s outset, reducing the need for ongoing modifications during development.

1. Enhanced collaboration and quality. APIs serve as a shared specification within the organization, allowing developers, testers, and DevOps to work independently. Agreeing on APIs at the project’s beginning helps eliminate uncertainties and boost software quality.

1. Increased scalability. With defined interfaces for each service, scaling becomes more manageable by spinning up new instances and adjusting load balancer settings.

In addition to efficiency and transparency, the API-first design also fosters network effects.

In 2002, Jeff Bezos issued the famous API mandate, an early version of “API First”. As a result, systems within the organization became Lego-like building blocks, creating an open ecosystem. The value of this ecosystem grows as more participants leverage APIs to develop new products or services, leading to network effects. Amazon Web Services (AWS), for example, has since become a significant revenue source for the company.

It is quite visionary to mandate that all systems be designed with scalability and flexibility in mind. As a result, the company can adapt swiftly to changing business conditions.

[![](https://substackcdn.com/image/fetch/$s_!ZTuj!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F78049284-2278-4d4b-b0ec-2a7734e6124a_1600x714.png)](https://substackcdn.com/image/fetch/$s_!ZTuj!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F78049284-2278-4d4b-b0ec-2a7734e6124a_1600x714.png)

# **API Architectural Styles**

Different API architectural styles use different communication protocols and data formats.

An overview of common styles is shown in the diagram below.

[![](https://substackcdn.com/image/fetch/$s_!eWTZ!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fd03a2351-962d-4199-a035-2c09c8ff12f4_1310x1600.png)](https://substackcdn.com/image/fetch/$s_!eWTZ!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fd03a2351-962d-4199-a035-2c09c8ff12f4_1310x1600.png)

Now let’s examine each architectural style individually.

## **1. REST**

Introduced in 2000 by Roy Fielding, REST (Representational State Transfer) is the most widely used style between front-end clients and back-end services. In a RESTful architecture, every component is a resource, accessed using standard HTTP methods like GET, POST, PUT, and DELETE. Payload formats can be JSON, XML, HTML, or plain text.

REST defines six architectural constraints which make a web service truly RESTful:

1. [Uniform interface](https://restfulapi.net/rest-architectural-constraints/#uniform-interface). We must define API interfaces for resources.

1. [Client–Server](https://restfulapi.net/rest-architectural-constraints/#client-server). Client-side application and server-side applications must evolve separately.

1. [Stateless](https://restfulapi.net/rest-architectural-constraints/#stateless). All client-server interactions are stateless. The server treats every request as new.

1. [Cacheable](https://restfulapi.net/rest-architectural-constraints/#cacheable). Data and responses are cached wherever possible.

1. [Layered system](https://restfulapi.net/rest-architectural-constraints/#layered-system). APIs, services, and data can be deployed on different servers.

1. [Code on demand (optional)](https://restfulapi.net/rest-architectural-constraints/#code-on-demand). This optional constraint allows the server to return executable code if needed.

We’ll cover more details in “REST API Design”.

## **2. GraphQL**

GraphQL was proposed in 2015 by Meta. It provides a schema and type system suitable for complex systems with graph-like relationships between entities. It handles complex queries with nested data structures. For example, in the diagram below, GraphQL can retrieve user and order information in one call, while REST requires multiple calls to different endpoints.

Note that GraphQL is not a replacement for REST. It can be built upon existing REST services, making migration less invasive.

However, GraphQL brings complexities. For example, GraphQL can expose more resource fields than necessary if the queries are not carefully designed. In addition, caching is more challenging due to increased query flexibility.

Organizations should evaluate the need for GraphQL. It has a steeper learning curve for understanding the new query language and new schema design.

## **3. WebSocket**

WebSocket is a protocol that provides full-duplex communications over TCP. Clients establish WebSockets to receive real-time updates from the back-end services. Unlike REST, which always “pulls” data, WebSocket enables data to be “pushed”. Applications, like online gaming, stock trading, and messaging apps leverage WebSocket for real-time communication.

## **4. Webhook**

Webhooks are commonly used for third-party asynchronous API calls. With a webhook, one application can register to receive updates from another.

As SaaS (Software-as-a-Service) becomes popular, webhook use has become widespread for integrating SaaS services. Many SaaS services include webhook support in their APIs.

In the diagram above, for example, we use Stripe or Paypal for payment channels and register a webhook for payment results. When a third-party payment service completes its process, it notifies our payment service whether the payment was successful or failed. Webhook calls typically form part of the system’s state machine.

## **5. gRPC**

Released in 2016 by Google, gRPC is a modern, open-sourced RPC (Remote Procedure Call) framework used for server-to-server communication in distributed systems. gRPC provides language-agnostic APIs and uses Protocol Buffers for data serialization in communications.

Compared with REST, gRPC offers code-generation tools that help generate client and server stubs, reducing coding effort for data transmission. gRPC is based on HTTP/2, allowing multiplexing and streaming, so clients and servers can send and receive data simultaneously.

A drawback of RPC frameworks is that they make remote procedure calls look like local procedure calls, masking the complexity of handling unreliable networks. This can lead to serious bugs if developers don’t realize that responses may be dropped intermittently due to network issues.

## **6. SOAP**

SOAP (Simple Object Access Protocol) uses XML payloads for communication between internal systems.

## **7. Kafka**

We have covered six architectural styles based on request-response communication mechanisms. Kafka is often used as a messaging layer to facilitate publish-subscribe-based communications. This event-streaming paradigm differs from the request-response paradigm in the [following aspects](https://www.confluent.io/blog/http-and-rest-api-use-cases-and-architecture-with-apache-kafka/):

[![](https://substackcdn.com/image/fetch/$s_!AgBD!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F4f9123ed-58d1-499f-8e9b-109dc2b75e88_846x390.png)](https://substackcdn.com/image/fetch/$s_!AgBD!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F4f9123ed-58d1-499f-8e9b-109dc2b75e88_846x390.png)

In the diagram above, the order service sends orders to the payment service via Kafka because the payment service is usually slower than the order service. Using REST APIs for payments may lead to long waits for responses, affecting processing throughput.

Additionally, Kafka supports fan-out, which is an electronic term for sending one input to multiple outputs. If the request-response paradigm were used for fan-out, the codebase would quickly become unmaintainable.

For those new to Kafka, “Kafka: The Definitive Guide”, written by Kafka authors, is an excellent starting point.

## **Popularity**

Postman published a [report](https://www.postman.com/state-of-api/api-technologies/) presenting the results of a survey on the popularity of each architectural style. REST remains the dominant style, with 89% of survey participants choosing it. Webhooks (35%), GraphQL (28%), and gRPC (11%) have gained popularity compared to the year before. “Their growth in popularity comes as gRPC is used for internal microservices and GraphQL for stitching together disparate data sources.”

[![](https://substackcdn.com/image/fetch/$s_!z1rh!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fe9fda436-d285-4e38-9170-afc91605fdbe_1600x848.png)](https://substackcdn.com/image/fetch/$s_!z1rh!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fe9fda436-d285-4e38-9170-afc91605fdbe_1600x848.png)

## **Comparison**

We have discussed seven types of architectural styles. Let’s compare some popular ones using the diagram below. Each style was developed for a specific purpose. For example, GraphQL gained increased popularity in large firms because it streamlines relationships among complex REST-based APIs; RPC became the standard protocol for microservices as firms adopted microservice architecture more widely.

When designing a system, we need to choose appropriate interaction methods for different scenarios. In some extreme situations, none of these architectural styles are suitable, and we must develop proprietary communication protocols. This requirement is typical in low-latency trading applications where RPC is too slow.

[![](https://substackcdn.com/image/fetch/$s_!1vKl!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F47a194af-c38c-48de-ad16-095cb43b452c_1600x1225.png)](https://substackcdn.com/image/fetch/$s_!1vKl!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F47a194af-c38c-48de-ad16-095cb43b452c_1600x1225.png)