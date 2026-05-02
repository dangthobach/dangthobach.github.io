---
Created by: Bách Đặng Thọ
Created time: 2025-09-15T05:42
---
Asynchronous communication has become an important strategy for modern software systems, particularly in distributed and large-scale applications.

Unlike synchronous communication, where a sender waits for a response before proceeding, asynchronous communication allows processes to continue without waiting. This has a significant impact on the system's performance, scalability, and resilience.

Some real-world scenarios where async communication shines are as follows:

- An online store where an order placement triggers real-time calls to inventory, payment, and shipping services. If any of these services experience latency or downtime, the order process stalls, leading to poor user experience and lost revenue. Using a message queue, the order service can immediately enqueue messages for inventory, payment, and shipping.

- IoT systems like smart home devices often involve thousands of sensors sending data to central servers. A synchronous approach can overwhelm the server during peak activity, leading to data loss or delayed responses. Message queues allow sensors to send data without waiting for processing.

- In a microservices architecture, tightly coupled services communicating synchronously can create cascading failures. With message queues, services communicate indirectly, reducing dependency and allowing independent scaling.

These are just a few examples. There are several potential scenarios where async communication is important. But what makes async communication possible?

This is where message queues come into the picture.

Message queues act as intermediaries, enabling asynchronous between producers (senders) and consumers (receivers). In this article, we’ll look at understanding how message queues work, the various terminologies involved, and the patterns that can be implemented using them.

[![](https://substackcdn.com/image/fetch/$s_!ivJG!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F2ae8b491-b794-446b-8ca5-25ac552161be_1417x1600.png)](https://substackcdn.com/image/fetch/$s_!ivJG!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F2ae8b491-b794-446b-8ca5-25ac552161be_1417x1600.png)

## **What is a Message Queue?**

A message queue is a software component that allows applications and services to communicate with each other by storing messages until they are processed.

The producer-consumer model is the fundamental pattern behind message queues. It has three main components:

- **Producer:** A producer is any application or service that generates messages. It publishes messages to the queue, typically due to some event or process. For example, an e-commerce system's "order service" acts as a producer, generating messages when a customer places an order.

- **Queue:** The queue is a storage mechanism that holds messages in a temporary buffer until they are consumed. It generally operates based on the First-In-First-Out (FIFO) principle, ensuring that messages are delivered in the order they were received (unless specific prioritization is applied). For example, a queue in a payment processing pipeline holds all the pending payment requests in the order they were received.

- **Consumer:** A consumer is any application or service that retrieves and processes messages from the queue. Consumers can operate independently of producers, fetching messages at their own pace. For example, a "shipping service" consumes order-related messages to dispatch goods.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!cAwg!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F7e82f051-4df3-4c84-bc7b-5dc387746fb3_1600x975.png)](https://substackcdn.com/image/fetch/$s_!cAwg!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F7e82f051-4df3-4c84-bc7b-5dc387746fb3_1600x975.png)

### **How A Message Queue Operates?**

The diagram below shows a step-by-step look at how a message queue operates.

[![](https://substackcdn.com/image/fetch/$s_!0-8m!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fd227c268-d906-4c8f-b944-412cae479675_1600x921.png)](https://substackcdn.com/image/fetch/$s_!0-8m!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fd227c268-d906-4c8f-b944-412cae479675_1600x921.png)

Let’s look at each step in more detail.

- **Message Creation:** The producer creates a message containing data (JSON or XML) relevant to a specific task or event. This message might include headers, metadata, and the actual payload.

- **Enqueuing:** The producer sends the message to the queue. The queue acts as a buffer, temporarily storing the message until a consumer retrieves it. This decouples the producer and consumer, enabling independent operations.

- **Storage:** Messages are stored in the queue in the order they arrive. The FIFO principle ensures that the first message to enter the queue is the first to leave. Some queues also support prioritization, allowing certain messages to bypass FIFO when needed. We will also look at non-FIFO queues in a later section.

- **Dequeueing:** A consumer fetches messages from the queue. Depending on the configuration, the queue may:
    
    - Remove the message after it is consumed (default behavior).
    
    - Retain the message for reprocessing in case of errors or acknowledgment failures.
    

- **Acknowledgment:** After processing, the consumer typically sends an acknowledgment (ACK) back to the queue to confirm the successful handling of the message. If no ACK is received, the queue can re-deliver the message.

### **Benefits of Message Queues**

Message queues provide several key advantages:

- **Decoupling**: Reduces dependencies between components, allowing independent development and deployment.

- **Scalability**: Handles fluctuating workloads by supporting the dynamic scaling of producers and consumers.

- **Fault Tolerance**: Ensures data persistence and reliable message delivery, even during system failures.

- **Asynchronous Processing**: Minimizes latency by allowing producers to continue their operations without waiting for immediate responses.

- **Enhanced System Resilience**: Prevents cascading failures in distributed systems by isolating components.

## **Key Terminologies in Message Queues**

Understanding the core terminologies associated with message queues is crucial for designing and implementing asynchronous systems.

Below are the key concepts explained:

### **Message**

A message is the fundamental unit of data exchanged between systems in a message queue. It represents a discrete piece of information or a command intended for processing by a consumer.

Messages are made up of multiple components:

- **Header:** Metadata about the message, such as timestamp, priority, and routing information.

- **Body/Payload:** The actual data, typically in formats like JSON, XML, or plain text.

- **Attributes:** Additional properties like message IDs or custom tags for specific processing needs.

See the example below for a message that contains metadata and payload:

```Plain
{
  "messageId": "user123",
  "type": "UserRegistration",
  "payload": {
    "userId": "U001",
    "email": "john.doe@example.com"
  },
  "timestamp": "2024-12-25T12:00:00Z"
}
```

### **Topics vs Queues**

Both topics and queues are mechanisms for message delivery, but they differ in their communication patterns.

Queues operate on a one-to-one model. A message in a queue is consumed by a single consumer.

They are ideal for distributing tasks among workers or handling independent processing workflows. For example, a "payment queue" in a financial application where each payment message is processed by one worker.

Topics operate on a one-to-many model. A message published on a topic is delivered to all subscribers interested in that topic.

It is useful for broadcasting events to multiple consumers. For example, a "new order topic" in an e-commerce platform might simultaneously notify the inventory, shipping, and customer notification services.

### **Acknowledgments**

An acknowledgment (ACK) is a signal sent by a consumer to confirm that it has successfully processed a message.

Without ACKs, the system cannot guarantee that a message has been processed. If an ACK is not received, the queue can re-deliver the message. This ensures “at-least-once” delivery.

There are two types of acknowledgments:

- **Automatic Acknowledgment:** Messages are automatically acknowledged upon receipt by the consumer. This is faster but risks message loss if the consumer crashes before processing.

- **Manual Acknowledgment:** Consumers explicitly send an acknowledgment after successfully processing the message. This approach ensures reliability but adds complexity.

### **Dead Letter Queues**

A dead-letter queue (DLQ) is a secondary queue used to store messages that cannot be processed successfully after multiple attempts. For example, if a payment processing message fails repeatedly due to an invalid credit card number, it is sent to the DLQ for investigation.

These "poisoned messages" may fail due to various reasons, such as malformed data, unresolvable errors, or business logic violations.

DLQ works as follows:

- A message is delivered to a consumer.

- If the message cannot be processed successfully, it is retried based on the queue’s retry policy (for example, three attempts).

- After exhausting the retry attempts, the message is moved to the DLQ for further analysis.

## **Common Messaging Patterns in Message Queues**

Message queues support various messaging patterns to cater to different communication requirements in distributed systems.

Below are some of the most common patterns:

### **1 - Point-to-Point (P2P)**

In the point-to-point pattern, messages are sent by a producer and consumed by a single consumer. Once the consumer processes the message, it is removed from the queue.

This approach is ideal for task distribution where each message represents a discrete piece of work.

For example, in an e-commerce system, a producer (order service) sends payment requests to a queue. A worker in the payment service picks up and processes each payment request. Once processed, the message is removed from the queue to prevent duplicate processing.

### **2 - Publish-Subscribe**

In the publish-subscribe pattern, messages are published to a topic instead of a queue.

Multiple subscribers can listen to the topic, and all of them receive a copy of the message. For example, when a new order is placed, the order service publishes an event to the "new order" topic. Multiple subscribers may act upon the event as follows:

- The inventory service updates stock levels.

- The shipping service prepares to dispatch the product.

- The notification service sends confirmation emails or SMS to the customer.

See the diagram below to understand the example:

[![](https://substackcdn.com/image/fetch/$s_!MO6z!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fe011ef8e-578d-4bf7-9e6b-c230131f5008_1600x970.png)](https://substackcdn.com/image/fetch/$s_!MO6z!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fe011ef8e-578d-4bf7-9e6b-c230131f5008_1600x970.png)

### **3 - Request-Reply**

In the request-reply pattern, a producer sends a message (request) to the queue, and the consumer processes it and sends a response (reply) back through a separate queue.

This pattern enables a client to send a request to a server and continue with other processing without waiting for the response. The receiving server can process the request at its own pace and respond when ready.

See the diagram below that shows an example of this pattern:

[![](https://substackcdn.com/image/fetch/$s_!2BtH!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Faf48c45a-be23-4ba9-af5b-762a22824ba0_1600x971.png)](https://substackcdn.com/image/fetch/$s_!2BtH!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Faf48c45a-be23-4ba9-af5b-762a22824ba0_1600x971.png)

### **4 - Fanout**

The fanout pattern is a specific implementation of the broader pub/sub pattern. In this pattern, the same message is broadcast to multiple consumers simultaneously. Each consumer processes its copy of the message, allowing them to act independently.

For example, an image upload service publishes an "image uploaded" message to a queue. This message is then broadcast to multiple consumer services for appropriate action:

- The thumbnail service generates image thumbnails.

- The compression service optimizes the image for storage.

- The AI tagging service applies metadata tags using machine learning.

### **5 - Work Queue**

The work queue pattern distributes tasks among multiple worker consumers.

It is used to manage workloads efficiently, especially in systems that experience traffic spikes. Tasks are dynamically assigned to available workers for parallel processing.

[![](https://substackcdn.com/image/fetch/$s_!sI15!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fa87ab8cf-a174-4385-95f6-fe194247e51d_1600x971.png)](https://substackcdn.com/image/fetch/$s_!sI15!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fa87ab8cf-a174-4385-95f6-fe194247e51d_1600x971.png)

For example, a producer uploads a batch of videos for encoding. Each video encoding task is added to a work queue.

- Multiple workers pick up tasks from the queue and process them simultaneously.

- As each task is completed, the worker sends an acknowledgment to remove the task from the queue.

## **Popular Message Queue Technologies**

Let us now look at a couple of popular technologies that play the role of message queues:

### **RabbitMQ**

RabbitMQ is a robust, feature-rich, and open-source message broker that facilitates communication between applications by enabling asynchronous messaging.

It uses the Advanced Message Queuing Protocol (AMQP) as its core protocol but also supports other protocols like MQTT and STOMP.

RabbitMQ’s message routing relies on three core components:

### **1 - Queues**

A queue is a buffer where messages are stored until a consumer retrieves and processes them.

Messages are delivered to queues by an exchange, based on routing rules. There are different types of queues such as:

- **Durable Queues:** The data survives broker restarts.

- **Quorum Queue:** It is a modern queue type, which implements a durable, replicated queue based on the Raft consensus algorithm.

- **Exclusive Queues:** Limited to one connection, often used for temporary purposes.

- **Auto-Delete Queues:** Automatically deleted when no longer in use.

### **2 - Exchanges**

An exchange acts as a router for messages. Producers send messages to an exchange, which then routes them to one or more queues based on specified rules.

There are multiple types of exchanges such as:

- **Direct Exchange:** Routes messages to queues with matching routing keys. It can act as a task queue where specific workers handle tasks based on predefined categories.

- **Fanout Exchange:** Broadcasts messages to all queues bound to the exchange. It can be used for a notification system sending alerts to multiple services.

- **Topic Exchange:** Routes messages based on pattern matching in routing keys. It is ideal for log aggregation where messages are categorized by levels (for example, error.*, info.*).

See the diagram below that shows different RabbitMQ exchange types:

[![](https://substackcdn.com/image/fetch/$s_!4ysn!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F46f77568-2d26-4f49-8f7a-ca4c1c8712ec_1600x1130.png)](https://substackcdn.com/image/fetch/$s_!4ysn!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F46f77568-2d26-4f49-8f7a-ca4c1c8712ec_1600x1130.png)

### **3 - Bindings**

A binding links an exchange to a queue and defines the routing rules that determine how messages are forwarded.

Routing keys or header attributes are used to specify these rules.

### **AWS SQS**

AWS Simple Queue Service (SQS) is a fully managed message queuing service offered by AWS, designed to decouple and scale distributed systems, serverless applications, and microservices.

It simplifies the process of message queue setup and management, ensuring reliable delivery of messages between producers and consumers without requiring manual infrastructure maintenance.

SQS provides two main queue types:

- **Standard Queue:** Offers high throughput, “at-least-once” delivery, and best-effort ordering (messages may be delivered out of order).

- **FIFO Queue:** Guarantees first-in, first-out delivery, and exactly-once processing, making it suitable for use cases requiring strict ordering and duplication prevention.

[![](https://substackcdn.com/image/fetch/$s_!KuU3!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F5d39a74c-3e56-4dbf-9543-bc99aad97bb0_1600x1007.png)](https://substackcdn.com/image/fetch/$s_!KuU3!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F5d39a74c-3e56-4dbf-9543-bc99aad97bb0_1600x1007.png)

SQS is deeply integrated into the AWS ecosystem, allowing it to support multiple workflows. Some examples are as follows:

- **AWS Lambda:** SQS can trigger Lambda functions to process messages asynchronously. For example, a Lambda function can process incoming messages in a queue and update a database.

- **Amazon SNS:** SNS can push messages to an SQS queue for downstream processing. This is especially useful for fanout patterns in event-driven systems.

- **AWS Step Functions:** SQS queues can act as event sources or destinations in a Step Functions workflow, facilitating complex orchestration.

- **Amazon S3:** Events from S3 (such as file uploads) can trigger messages to be sent to an SQS queue.

- **Amazon EC2 and ECS:** Applications running on EC2 or ECS instances can consume messages from SQS to process workloads in a distributed fashion.

### **SQS in a Serverless Architecture**

Let’s understand the role of SQS using a simple example application.

For example, in a photo-sharing application, users upload images to the application that are then stored in an Amazon S3 bucket. These images need to be resized and processed asynchronously.

Here’s a possible workflow facilitated by SQS:

- **Event Trigger:** When an image is uploaded to the S3 bucket, an event notification is triggered and sent to an SQS queue.

- **Message Processing:** AWS Lambda functions are configured to process messages from the queue. Each message contains details about the uploaded image (for example, the S3 bucket name and file path).

- **Resizing and Storage:** The Lambda function retrieves the image from S3, resizes it, and saves the processed image back to the S3 bucket.

- **Error Handling with DLQs:** Failed messages are routed to a dead-letter queue (DLQ) for debugging and reprocessing.

## **Summary**

In this article, we’ve taken a detailed look at message queues and how they support asynchronous communication in distributed systems.

Let’s summarize our learnings in brief:

- Asynchronous communication reduces latency, enhances scalability, and decouples services in distributed systems. Message queues play a key role in supporting async communication.

- A message queue acts as a temporary storage in a producer-consumer model, ensuring reliable communication between services.

- To better understand message queues, some key terminologies we need to learn are messages, topics, queues, acknowledgments (ACKs), and dead-letter queues (DLQs)

- Patterns like point-to-point, publish-subscribe, request-reply, fanout, and work queues enable us to build applications using message queues.

- Point-to-point ensures one-to-one communication, making it ideal for task delegation where exactly one consumer processes each message.

- Pub/Sub enables one-to-many communication where multiple subscribers can subscribe to a topic for real-time event notifications and parallel workflows.

- Request-reply facilitates bidirectional communication over asynchronous channels, allowing producers to receive consumer responses while remaining decoupled.

- Fanout distributes a single message to multiple queues, enabling parallel processing of the same event by different systems.

- Work queue balances workloads by distributing tasks among multiple consumers, ensuring scalability and efficient use of resources.

- A couple of popular message queue technologies are RabbitMQ and AWS SQS.

- RabbitMQ provides robust message routing with exchanges, bindings, and queues, supporting multiple patterns and ensuring reliability and scalability for microservices and distributed systems.

- AWS SQS offers a fully managed, scalable queuing service integrated with the AWS ecosystem, ideal for serverless architectures.