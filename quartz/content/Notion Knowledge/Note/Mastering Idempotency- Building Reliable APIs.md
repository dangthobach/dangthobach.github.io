---
Created by: Bách Đặng Thọ
Created time: 2025-08-30T23:34
---
Idempotency is the property of an operation that ensures performing the same action multiple times produces the same outcome as doing it once.

In the context of APIs, this means a client can send the same request multiple times without causing unintended consequences, such as duplicate entries or repeated side effects.

For example:

- When a user initiates an online payment but experiences a timeout due to network issues, the payment API is called again as part of the retry mechanism. Without idempotency, the user might be charged multiple times for the same transaction.

- A customer adds items to their cart and places an order. However, due to a slow internet connection, they hit the "Place Order" button repeatedly. Without idempotency, multiple identical orders might be created, leading to duplicate shipments and inventory mismanagement.

- If a user registers for a service but the confirmation page doesn’t load properly, they are prompted to submit the registration form again. Without idempotency, duplicate user accounts might be created.

Idempotency is critical for reliability and consistency due to the following reasons:

- Network issues can cause API requests to fail or time out. In such cases, clients often retry requests to ensure the operation succeeds. Without idempotency, retries can lead to undesired duplication or data corruption.

- Idempotent operations help manage race conditions where multiple requests might be processed simultaneously.

- Idempotency provides predictability and stability, ensuring that users don’t encounter inconsistent or erroneous outcomes

In this article, we’ll understand how idempotency works in API Design and investigate multiple strategies to implement idempotency in real-world applications.

[![](https://substackcdn.com/image/fetch/$s_!YCT1!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fc3beec9e-cd04-4748-ae7e-3299b42883f6_2360x2824.png)](https://substackcdn.com/image/fetch/$s_!YCT1!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fc3beec9e-cd04-4748-ae7e-3299b42883f6_2360x2824.png)

## **Idempotency in API Design**

The concept of idempotency is inherently tied to HTTP methods, which can be categorized based on their idempotency properties.

- **Idempotent Methods**
    
    - GET retrieves information without modifying the server state. No matter how many times a GET request is made, the response remains the same, provided the resource state doesn’t change in the meantime. For example, GET /users/123 retrieves user data for user ID 123.
    
    - PUT updates or creates a resource. Multiple PUT requests with the same data will produce the same result.
    
    - DELETE deletes a resource. Repeated DELETE requests are idempotent because once the resource is deleted, subsequent DELETEs have no further effect.
    
    - HEAD is similar to GET but retrieves only headers. This method is also idempotent as it doesn’t modify the server state.
    

- **Non-Idempotent Method:** POST is typically used to create new resources or perform operations with side effects. Generally, POST is not idempotent because repeating the request may create multiple new resources or have different side effects. For example, POST /orders create a new order. Multiple POST requests can result in multiple orders being created.

[![](https://substackcdn.com/image/fetch/$s_!i_GX!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F9e186729-35c0-480d-a999-14b2814049ff_1600x1150.png)](https://substackcdn.com/image/fetch/$s_!i_GX!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F9e186729-35c0-480d-a999-14b2814049ff_1600x1150.png)

### **Idempotency vs Retries**

Although idempotency and retries are related concepts, they are distinct:

- Idempotency ensures that repeating the same operation produces the same result, regardless of whether the operation is retried intentionally or due to a failure.

- Retries are mechanisms to handle transient errors (such as network disruptions) by resending the request. When retries are implemented, idempotency becomes crucial to avoid unintended side effects from repeated operations.

For example:

- Without idempotency, retrying a payment request may charge a user multiple times.

- With idempotency, the payment request uses a unique transaction ID, ensuring that only one payment is processed, regardless of retries.

[![](https://substackcdn.com/image/fetch/$s_!IRfb!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F48613cc7-096d-4ba5-98f5-bf38c85b3201_1600x1150.png)](https://substackcdn.com/image/fetch/$s_!IRfb!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F48613cc7-096d-4ba5-98f5-bf38c85b3201_1600x1150.png)

### **Challenges in Ensuring Idempotent Operations**

While idempotency is crucial, it is also challenging to implement. Some of the key challenges with supporting idempotency are as follows:

- **Uniqueness** **of** **Identifiers**: Idempotency often relies on unique identifiers, such as transaction IDs or request IDs. Generating and managing these identifiers consistently across distributed systems can be challenging.

- **Concurrent Requests**: Simultaneous requests with the same ID can lead to race conditions. Ensuring thread safety and consistent behavior across concurrent operations requires careful design.

- **Partial Failures**: Operations that involve multiple steps (for example., updating a database and sending a notification) can fail midway. Designing rollback mechanisms or ensuring eventual consistency is critical to maintaining idempotency.

- **State Management**: Keeping track of processed requests or resource states (for example, using a database or cache) is necessary for idempotency but can introduce performance overhead or require additional infrastructure.

- **Cache Expiry**: When using distributed caches (such as Redis) to track idempotency keys, managing cache expiration becomes crucial. Expired keys might lead to duplicate processing if the client retries a request after evicting the key.

## **Strategies to Implement Idempotency**

Let us look at some of the main strategies to implement idempotency in our applications.

### **1 - Database Unique Constraints**

Database unique constraints are one of the most straightforward and reliable methods for implementing idempotency in APIs.

By enforcing uniqueness on specific fields, such as a transaction_id or request_id, we can ensure that duplicate operations are prevented at the database level.

See the diagram below that shows how a database unique constraint can work to support idempotency.

[![](https://substackcdn.com/image/fetch/$s_!DB7w!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Faf62c1ae-1dd4-49c0-9437-811349eb18da_1600x1148.png)](https://substackcdn.com/image/fetch/$s_!DB7w!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Faf62c1ae-1dd4-49c0-9437-811349eb18da_1600x1148.png)

Here’s how the process works on a step-by-step level:

- **Design the Schema:** Add a field to your database table to store a unique identifier for each operation. This could be a transaction_id, request_id, or any other unique key. Here, transaction_id is enforced as a unique key.

- **Generate Unique Identifiers:** Clients or the server generate a unique identifier for each API request (for example, UUID or a hash of the request payload). This identifier is included in the request payload and saved in the database during the operation.

- **Database Validation:** When the API receives a request, it attempts to insert the data along with the transaction_id into the database. If the transaction_id already exists, the database throws a constraint violation error, which the API can handle gracefully by returning the same result as the initial operation.

- **API Response:** If the operation is new, the API processes it normally and returns a successful response. If the operation is duplicated (due to a retry or duplicate request), the API catches the database error and returns the same response as the original request.

See the sample below for creating a table with transaction_id as a unique field.

```Plain
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL,
    transaction_id UUID UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

The advantages of using the database constraints approach are as follows:

- **Simplicity:** Relies on database features familiar to most developers and do not require additional infrastructure.

- **Reliability:** The database guarantees consistency and prevents duplicates through the unique constraint.

- **Strong Consistency:** Since the database enforces uniqueness, the API does not need to maintain a state for deduplication.

- **Ease of Implementation:** Requires minimal additional coding beyond adding the unique key and handling constraint violation errors.

The disadvantages or challenges with this approach are as follows:

- **Performance Bottlenecks**: While modern databases are highly optimized for handling unique constraints. However, in extremely high-traffic systems with frequent writes, unique constraints can result in performance problems.

- **Scalability Challenges**: In distributed databases, enforcing uniqueness across nodes can add latency or require global coordination.

- **Complex Error Handling**: The API must handle database constraint violations gracefully and return meaningful responses to clients.

### **2 - In-Memory Tracking**

In-memory tracking is a lightweight and straightforward method to implement idempotency.

It involves maintaining a data structure in memory (for example, a hash map or set) to store unique identifiers for processed requests. Before processing a new request, the system checks this in-memory store to determine whether the request has already been handled.

[![](https://substackcdn.com/image/fetch/$s_!iQ_1!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F8e2c61bc-8254-4e61-a34c-b39652c7efb3_1600x961.png)](https://substackcdn.com/image/fetch/$s_!iQ_1!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F8e2c61bc-8254-4e61-a34c-b39652c7efb3_1600x961.png)

Here’s how it works in a step-by-step manner:

- **Generate a Unique Identifier:** The client or server generates a unique identifier for each API request. Common choices include UUIDs or hashes derived from the request payload.

- **Initialize the In-Memory Store:** Use a data structure like a hash map (dictionary) or a set to store processed request IDs.

- **Check the In-Memory Store:** When the API receives a new request, it first checks if the transaction_id exists in the in-memory store. If the ID is found, the request has already been processed. The system can skip reprocessing and return the same response as before.

- **Process the Request:** If the ID is not found, process the request normally and store the transaction_id in the in-memory store after successful completion.

- **Return the Response:** Return the response to the client, ensuring that if the same request is received again, the system can respond consistently without reprocessing.

This technique to implement idempotency is best suited for:

- **Short-lived Services**: APIs with a limited lifespan where request history does not need to persist beyond the service's runtime.

- **Single-Node Environments**: Services deployed on a single instance that do not require state sharing.

- **Low-Traffic APIs**: Systems where the number of unique requests is small enough to fit comfortably in memory.

The advantages of the in-memory tracking approach are as follows:

- **Simplicity:** Easy to implement using standard data structures. There is no need for external dependencies or infrastructure.

- **Performance:** Lookups and inserts in in-memory data structures are fast, making this method highly efficient for low-latency applications.

- **No Additional Infrastructure:** Suitable for small-scale or short-lived services that do not require the complexity of external systems like databases or distributed caches.

- **Ideal for Single-Node Services:** Works well in environments where the service is deployed on a single node and does not need to share state with other instances.

However, this approach also has some limitations:

- **Volatility**: Data is stored in memory, so it is lost if the service restarts or crashes. This can lead to duplicate processing in such scenarios.

- **Limited Scalability**: In-memory tracking is unsuitable for distributed systems where multiple service instances are running. Synchronizing state across nodes would require additional coordination mechanisms.

- **Memory Constraints**: The size of the in-memory store is limited by the system's available memory. High-traffic or long-lived services may require more storage than memory can provide.

- **Concurrency Challenges**: Proper synchronization is required in multi-threaded environments to prevent race conditions when accessing the in-memory store.

- **TTL Management**: Without a mechanism to expire old entries, the in-memory store can grow indefinitely, leading to memory exhaustion. Implementing a TTL (time-to-live) for each entry adds complexity.

### **3 - Using a Distributed Cache Like Redis**

Redis, a high-performance in-memory data store, can be used to implement idempotency in APIs by tracking processed request IDs.

By storing a unique identifier (for example, transaction_id or request_id) for each API request in Redis, we can check for duplicates before processing a request. This ensures that even if the same request is retried, it is processed only once.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!DBmF!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fad1f0bee-fb22-4490-ae95-5708c8a198f7_1600x961.png)](https://substackcdn.com/image/fetch/$s_!DBmF!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fad1f0bee-fb22-4490-ae95-5708c8a198f7_1600x961.png)

Here’s how the process works in a step-by-step manner:

- **Generate a Unique Identifier:** A client or server generates a unique identifier for each API request. This could be a UUID or a hash of the request payload.

- **Store the Request ID in Redis:** When the API receives a request, it first checks if the request_id exists in Redis. If the ID does not exist, the server processes the request and stores the ID in Redis with a time-to-live (TTL) value. Redis provides atomic commands for this such as SETNX (Set If Not Exists) that sets the key if it does not already exist.

Using Redis to handle idempotency is effective in the below scenarios:

- **Stateless Microservices**: In distributed systems, stateless services rely on external systems like Redis to maintain the state across multiple nodes.

- **High-Traffic APIs**: Redis’s low latency ensures minimal performance overhead, even for APIs handling large volumes of requests.

- **Distributed Systems**: Redis operates as a centralized store accessible by all instances of a service, making it ideal for ensuring idempotency across distributed environments.

- **Temporary Operations**: For operations where idempotency is required only for a limited time, Redis’s TTL feature is perfect for automatic cleanup.

The advantages of using Redis are as follows:

- **High Performance**: Redis provides high-speed read and write operations, ensuring minimal latency for API requests.

- **Atomic Operations**: Commands like SETNX and EXPIRE are atomic, ensuring thread-safe and race-condition-free behavior.

- **Scalability**: Redis supports clustering, making it suitable for distributed systems and high-traffic environments.

- **TTL Management**: Automatic expiration of keys prevents memory bloat and eliminates the need for manual cleanup.

- **Simplicity**: Redis’s straightforward API makes it easy to integrate with applications.

The disadvantages are as follows:

- **Dependency on External Infrastructure**: Requires setting up and managing a Redis instance or cluster, adding operational complexity.

- **Memory Constraints**: Redis stores data in memory, so the size of the idempotency store is limited by the available memory. High-traffic systems may require significant resources.

- **Key Expiry Trade-Off**: Setting a TTL too short can lead to duplicate requests being processed if retries occur after the key expires. Setting it too long can waste memory.

- **Failure Scenarios**: If the Redis instance crashes or becomes unavailable, idempotency tracking may fail unless additional redundancy mechanisms exist.

### **4 - Using Message Duplicate Detection**

In event-driven systems, ensuring idempotency is essential to prevent processing the same message multiple times, especially when retries are involved.

Message brokers like Azure Service Bus, RabbitMQ, and others offer built-in duplicate detection mechanisms that rely on unique message identifiers (MessageId) and time windows to discard duplicates automatically.

See the screenshot below that shows how to enable duplicate detection while creating a queue in Azure Service Bus.

Source: [Microsoft Learning Center](https://learn.microsoft.com/en-us/azure/service-bus-messaging/enable-duplicate-detection)

[![](https://substackcdn.com/image/fetch/$s_!E7ac!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F8d914ffc-808f-4ad6-9ced-857f99db9045_435x898.png)](https://substackcdn.com/image/fetch/$s_!E7ac!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F8d914ffc-808f-4ad6-9ced-857f99db9045_435x898.png)

Here’s how the process works:

- **Unique Message Identifiers:** Each message sent to the broker is assigned a unique MessageId. If a message with the same MessageId is received within a specified time window, the broker identifies it as a duplicate and discards it.

- **Time Windows:** The broker maintains a history of processed MessageIds for a configurable time window (for example, 15 seconds, 5 minutes, or something else)**.**

- **Deduplication:** Upon receiving a message, the broker checks its MessageId against the history. If the ID exists within the time window, the broker discards the message. However, if the ID is new, the message is processed, and the ID is added to the history.

[![](https://substackcdn.com/image/fetch/$s_!gQzC!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fe4553647-5252-4c7f-96ab-5205b4dc53f8_1600x957.png)](https://substackcdn.com/image/fetch/$s_!gQzC!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fe4553647-5252-4c7f-96ab-5205b4dc53f8_1600x957.png)

The message duplicate detection approach is most effective in the following scenarios:

- **Event-Driven Systems**: Ensuring consistent processing of events in distributed, asynchronous architectures.

- **High-Throughput Environments**: Handling large volumes of messages where performance and scalability are critical.

- **Distributed Consumers**: Managing idempotency across multiple consumers of a queue or topic.

- **Stateless Microservices**: Ideal for stateless systems that rely on the broker for message tracking.

The benefits of this approach are as follows:

- **Simplified Application Logic**: Offloads idempotency management to the broker, reducing the complexity of application code.

- **Scalability**: Designed for high-throughput systems, ensuring consistent behavior even with large volumes of messages.

- **Performance**: Deduplication at the messaging layer is fast, minimizing latency for downstream consumers.

- **Distributed Support**: Brokers like Azure Service Bus and RabbitMQ support distributed environments, ensuring consistency across multiple consumers.

The limitations or challenges of this approach are as follows:

- **Managing Time Window**: Deduplication is only guaranteed within the specified time window. If retries occur after the window expires, duplicates may be processed.

- **Infrastructure Dependency**: Applications may become reliant on the messaging system for idempotency, increasing dependency on the broker's availability and configuration.

- **Configuration Overhead**: Proper setup and tuning (for example, time window size, and history size limits) are required to balance performance and memory usage.

- **Broker-Specific Features**: Deduplication behavior and capabilities vary across brokers, making it challenging to switch between systems without code changes.

- **Cost**: Using advanced broker features like duplicate detection may incur additional costs, particularly in cloud-based solutions like Azure Service Bus.

### **Best Practices for Designing Idempotent APIs**

Designing idempotent APIs requires careful consideration of several factors.

[![](https://substackcdn.com/image/fetch/$s_!f3FZ!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Ffa9f9679-0be2-408c-aa79-498db3a77484_1600x1361.png)](https://substackcdn.com/image/fetch/$s_!f3FZ!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Ffa9f9679-0be2-408c-aa79-498db3a77484_1600x1361.png)

Some best practices worth following are as follows:

- **Choose Appropriate Identifiers:** Use unique, deterministic identifiers to track requests. Common choices include UUIDs and Hashed Payloads. Unique identifiers prevent duplicate processing and help track requests across retries.

- **Document Idempotency Policies:** Clearly document which API endpoints are idempotent and describe their expected behavior. For example, specify that all PUT, DELETE, and some POST requests are idempotent. This ensures that developers understand how to interact with the API and prevent misuse.

- **Set Appropriate TTL for Idempotency Records:** Use a TTL for stored idempotency records to balance resource usage and functionality. Short TTLs work for ephemeral operations, like temporary data submissions. Longer TTLs are necessary for operations that may involve retries after significant delays.

- **Implement Logging:** Log all idempotency-related events, including request identifiers and timestamps. Also, log the results of idempotency checks and errors encountered during processing or deduplication.

- **Handle Partial Failures:** Ensure the system can recover from partial failures, such as network timeouts or service crashes, without breaking idempotency. Use transactional systems or rollback mechanisms to maintain consistency. For example, a payment system ensures funds are either fully transferred or not transferred at all, even in the event of a retry.

## **Summary**

In this article, we have understood the concept of idempotency and explored multiple strategies to implement it in APIs.

Let’s summarize the key learning points in brief:

- Idempotency ensures that repeated API requests produce the same result as a single request.

- HTTP Methods such as GET, PUT, and DELETE are conventionally idempotent. POST is not but can be designed to behave idempotently.

- Idempotency is different from retries and poses multiple challenges if not handled properly.

- There are multiple strategies to implement idempotency in APIs depending on the context.

- Database Unique Constraints is one of the most basic methods to implement idempotency. This approach uses unique keys with database constraints to prevent duplicate operations.

- With in-memory tracking, we maintain a data structure in memory to track processed request IDs. This is great for single-node services or short-lived operations.

- We can also use a distributed cache with Redis to store request IDs with a TTL for deduplication. This is the best choice for stateless microservices and distributed environments.

- Lastly, we can use message brokers like Azure Service Bus or RabbitMQ to detect duplicates based on unique MessageId and time windows. This approach is suitable for event-driven systems and high-throughput distributed environments.

- There are multiple best practices for designing idempotent APIs, which should be followed for good results.