---
Created by: Bách Đặng Thọ
Created time: 2025-09-15T06:02
---
In today's world, distributed systems have become ubiquitous, powering everything from social media platforms and e-commerce websites to financial systems and healthcare applications.

As these systems grow in complexity and scale, it becomes increasingly important for software architects and developers to understand the inherent trade-offs and challenges associated with designing and building such systems.

One of the key challenges in distributed systems is ensuring data consistency, availability, and partition tolerance. These properties are often in tension with one another, and achieving all three simultaneously is impossible, as stated by the famous CAP theorem. This theorem has become a fundamental principle in distributed systems design, guiding architects in making informed decisions about the trade-offs between consistency, availability, and partition tolerance.

Building upon the CAP theorem, other frameworks and models have emerged to help reason about the trade-offs in distributed systems. The PACELC theorem extends the CAP theorem to provide a more nuanced understanding of the trade-offs between consistency and availability during normal operations and network partitions.

In addition to CAP and PACELC, the ACID (Atomicity, Consistency, Isolation, Durability) and BASE (Basically Available, Soft-state, Eventually Consistent) models provide guidance for designing transactional systems and dealing with the challenges of eventual consistency in distributed databases.

By carefully considering the implications of CAP, PACELC, ACID, and BASE, architects can make informed choices that align with the specific requirements and constraints of their applications.

In this article, we will dive deep into these concepts, exploring their definitions and implications. We will also discuss the limitations of these models and the factors to consider when choosing the right approach for a given use case.

[![](https://substackcdn.com/image/fetch/$s_!x_AK!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F732e86b8-f57e-4e0a-941f-5c6e15c2a53d_1591x1600.png)](https://substackcdn.com/image/fetch/$s_!x_AK!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F732e86b8-f57e-4e0a-941f-5c6e15c2a53d_1591x1600.png)

## **The CAP Theorem**

The CAP theorem, also known as Brewer's theorem, is a fundamental concept in distributed systems that highlights the inherent trade-offs between three important properties: consistency, availability, and partition tolerance.

It states that in a distributed system, it is impossible to guarantee all three of these properties simultaneously.

### **Properties of the CAP Theorem**

Let’s look at the three properties in more detail:

1. **Consistency (C):** In a consistent system, all nodes see the same data at the same time. Any read operation will return the most recent write, ensuring that all clients have a consistent view of the data.

1. **Availability (A):** In an available system, every request receives a non-error response, even if it may not contain the most recent write. The system remains operational and responsive, even in the presence of failures.

1. **Partition Tolerance (P):** A partition-tolerant system continues to operate despite an arbitrary number of messages being dropped or delayed by the network between nodes. In other words, such a system can tolerate network partitions without complete system failure.

The diagram below represents the CAP Theorem:

[![](https://substackcdn.com/image/fetch/$s_!9vM0!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fa5136ea6-6ab5-4b74-ab26-21edbee7f3c0_1600x969.png)](https://substackcdn.com/image/fetch/$s_!9vM0!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fa5136ea6-6ab5-4b74-ab26-21edbee7f3c0_1600x969.png)

### **Explanation of the CAP Theorem**

According to the CAP theorem, a distributed system can satisfy any two of these three properties, but not all three simultaneously.

The theorem suggests that there are three possible combinations of properties:

- CP (Consistent and Partition Tolerant)

- AP (Available and Partition Tolerant)

- CA (Consistent and Available)

The CAP theorem is particularly relevant in the context of network partitions or failures. When a partition occurs, causing communication breaks between nodes, the system must choose between maintaining consistency or availability. It cannot guarantee both in the presence of a partition.

### **Implications and Examples of CP, AP, and CA Systems**

The CAP theorem has significant implications for the design and behavior of distributed systems. Let's explore the different combinations of properties and their examples:

1. **CP Systems (Consistent and Partition Tolerant):**
    
    - In a CP system, consistency is prioritized over availability during a partition.
    
    - If a partition occurs, the system will preserve consistency by blocking or canceling some operations, sacrificing availability.
    
    - Examples of CP systems include traditional relational databases like PostgreSQL, and MySQL with strong consistency configuration.
    

1. **AP Systems (Available and Partition Tolerant):**
    
    - In an AP system, availability is prioritized over consistency during a partition.
    
    - If a partition occurs, the system will continue to serve requests, even if it cannot guarantee consistency across all nodes.
    
    - Examples of AP systems include Cassandra, CouchDB, Riak, and Dynamo-style databases.
    

1. **CA Systems (Consistent and Available):**
    
    - CA systems are not realistic in the presence of partitions, as they cannot guarantee both consistency and availability simultaneously during a partition.
    
    - However, if the system can ensure that partitions never occur (e.g., through robust network infrastructure), then it can be both consistent and available.
    
    - Examples of CA systems include single-node databases or systems with strong consistency and no network partitions.
    

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!H1G6!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F80ce435d-ddc1-4d6f-8d97-ce8db8b408c9_1600x973.png)](https://substackcdn.com/image/fetch/$s_!H1G6!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F80ce435d-ddc1-4d6f-8d97-ce8db8b408c9_1600x973.png)

### **Limitations of the CAP Model**

While the CAP theorem provides valuable insights into the trade-offs in distributed systems, it has some limitations:

1. **Strict Definitions:** The CAP theorem assumes a strict definition of consistency (linearizability) and availability, which may not always align with real-world requirements. In practice, systems may have more nuanced consistency and availability needs.

1. **Performance and Latency:** The theorem does not account for the performance or latency of the system, which are critical factors in many applications. It focuses solely on the trade-offs between consistency, availability, and partition tolerance.

1. **Lack of Guidance:** The CAP theorem does not provide specific guidance on how to make trade-offs between the three properties based on specific use cases. It is up to the system designers to determine the appropriate balance based on their requirements.

## **The PACELC Theorem**

The PACELC theorem, proposed by Daniel J. Abadi in 2012, is an extension of the CAP theorem that introduces the concept of latency (L) and provides a more nuanced view of the trade-offs in distributed systems.

It considers the choices available to system designers when dealing with the challenges of consistency, availability, partition tolerance, and latency.

### **Latency (L) in Normal Operation**

The PACELC theorem introduces the concept of latency (L) during normal operation when the system is available and not experiencing any network partitions.

[![](https://substackcdn.com/image/fetch/$s_!-drb!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Ff955d0b6-84d6-40bc-a3bf-497f8301ea38_1600x969.png)](https://substackcdn.com/image/fetch/$s_!-drb!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Ff955d0b6-84d6-40bc-a3bf-497f8301ea38_1600x969.png)

In this situation, the system can prioritize either consistency (C) or latency (L). This trade-off is represented by the "PACEL" part of the theorem.

- **Prioritizing Consistency (C):** If the system prioritizes consistency during normal operation, it ensures that all nodes always see the same data, even if this means higher latency for some operations. Consistency is maintained at the cost of increased latency.

- **Prioritizing Latency (L):** If the system prioritizes latency during normal operation, it responds to requests quickly, even if this means that some nodes may have slightly outdated data. Low latency is achieved by sacrificing strict consistency.

### **Availability (A) and Consistency (C) During a Partition**

The "C" part of the PACELC theorem refers to the same trade-off described in the CAP theorem.

During a network partition (P), the system must choose between availability (A) and consistency (C). This is the "PACE" part of the theorem.

- **Maintaining Availability (A):** If the system chooses to maintain availability during a partition, it continues to serve requests, even if it cannot guarantee consistency across all nodes. Availability is prioritized over consistency.

- **Maintaining Consistency (C):** If the system chooses to maintain consistency during a partition, it blocks or cancels some operations until the partition is resolved, sacrificing availability. Consistency is prioritized over availability.

### **Implications and Examples of Different PACELC Configurations**

The PACELC theorem describes four possible configurations for a distributed system:

- **PA/EL:** Prioritize availability over consistency during partitions, and prioritize latency over consistency during normal operation.
    
    - Examples: Cassandra, Amazon DynamoDB
    
    - Suitable for use cases that require high availability and low latency, and can tolerate eventual consistency.
    

- **PC/EC:** Prioritize consistency over availability during partitions, and prioritize consistency over latency during normal operation.
    
    - Examples: Google Spanner, Apache HBase, MongoDB (with strong consistency)
    
    - Suitable for use cases that require strong consistency and can tolerate higher latency and reduced availability during partitions.
    

- **PA/EC:** Prioritize availability over consistency during partitions, and prioritize consistency over latency during normal operation.
    
    - Examples: Apache Cassandra (with tunable consistency), Apache CouchDB
    
    - Suitable for use cases that require a balance between availability and consistency, depending on the specific requirements.
    

- **PC/EL:** Prioritize consistency over availability during partitions, and prioritize latency over consistency during normal operation.
    
    - Examples: Rare in practice, as it is an unusual combination of priorities.
    

## **ACID**

ACID is a set of properties that guarantee the reliability of database transactions.

The acronym ACID stands for Atomicity, Consistency, Isolation, and Durability. These properties ensure that database transactions are processed reliably, even in the event of errors, power failures, or other disruptions.

### **Definition of Atomicity, Consistency, Isolation, Durability**

Let's explore each of the ACID properties in detail:

### **1 - Atomicity**

Atomicity ensures that a transaction is treated as a single, indivisible unit of work. Either all of the transaction's operations are completed successfully, or none of them are applied.

If a transaction fails, the database is left unchanged, as if the transaction had never been started.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!xyOo!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fcad99d92-eb38-483e-b72d-381d97f1e4df_1600x970.png)](https://substackcdn.com/image/fetch/$s_!xyOo!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fcad99d92-eb38-483e-b72d-381d97f1e4df_1600x970.png)

### **2 - Consistency**

Consistency ensures that a transaction brings the database from one valid state to another. Any data written to the database must be valid according to all defined rules, including constraints, cascades, triggers, and any combination thereof.

This maintains data integrity and ensures that any corruption or inconsistency in the data is avoided. Note that consistency in ACID is not the same concept as consistency from a CAP perspective.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!SYS_!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fc3fc4a86-b29a-4e93-b210-6332fc121f27_1600x970.png)](https://substackcdn.com/image/fetch/$s_!SYS_!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fc3fc4a86-b29a-4e93-b210-6332fc121f27_1600x970.png)

### **3 - Isolation**

Isolation ensures that concurrent transactions do not interfere with each other. Each transaction must be executed in isolation from other transactions so that the intermediate state of one transaction is not visible to other transactions.

This prevents issues such as dirty reads, non-repeatable reads, and phantom reads.

See the diagram below that shows the impact of isolation property getting violated.

[![](https://substackcdn.com/image/fetch/$s_!qnPY!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F59ee1ba3-ef47-4dd7-ad71-47530fdd06ec_1600x970.png)](https://substackcdn.com/image/fetch/$s_!qnPY!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F59ee1ba3-ef47-4dd7-ad71-47530fdd06ec_1600x970.png)

### **4 - Durability**

Durability ensures that once a transaction has been committed, it will remain committed even in the event of a system failure. The changes made by the transaction must be permanently stored in the database and not be lost due to any failure.

This is typically achieved through the use of transaction logs and database backups.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!6TsD!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fc61de0ed-f0d4-4101-96c5-f3d01e103ce4_1600x970.png)](https://substackcdn.com/image/fetch/$s_!6TsD!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fc61de0ed-f0d4-4101-96c5-f3d01e103ce4_1600x970.png)

### **Relevance of ACID to Transactional Databases**

ACID properties are essential for transactional database systems, such as relational databases (e.g., MySQL, PostgreSQL, Oracle) and some NoSQL databases (e.g., MongoDB, FoundationDB). These systems are designed to handle critical data and ensure data integrity, consistency, and reliability.

Transactional database systems are used in applications where data accuracy is paramount, such as financial systems, e-commerce platforms, and healthcare applications.

By guaranteeing ACID properties, these systems ensure that data remains consistent and reliable, even in the face of failures or concurrent access by multiple users.

### **Challenges of Maintaining ACID Compliance in Distributed Databases**

Maintaining ACID compliance in distributed databases can be challenging due to the nature of distributed systems.

Some of the key challenges include:

- **Network Partitions and Failures:** Distributed systems are prone to network partitions and node failures, which can make it difficult to maintain consistency and availability simultaneously.

- **Latency:** Ensuring ACID properties across multiple nodes can introduce latency, as transactions may need to be coordinated and synced across the network.

- **Scalability:** As the number of nodes and transactions increases, maintaining ACID properties can become more complex and resource-intensive.

## **BASE**

BASE is an acronym that stands for Basically Available, Soft-state, and Eventually Consistent.

It is a set of properties that are often used to describe the behavior of distributed systems, particularly NoSQL databases, that prioritize availability and scalability over strong consistency.

### **Definition of BASE**

Let's explore each of the BASE properties in detail:

- **Basically Available:**
    
    - The system is available most of the time, even in the face of failures or network partitions.
    
    - This means the system will respond to requests, although the response may not always be the most up-to-date or consistent.
    
    - The system may sacrifice some level of consistency to maintain availability.
    

- **Soft-state:**
    
    - The state of the system may change over time, even without input from external sources.
    
    - This contrasts the "hard state" of traditional database systems, where the state only changes in response to explicit inputs or transactions.
    
    - In a soft-state system, replicas may diverge temporarily, leading to inconsistencies that are resolved over time.
    

- **Eventually Consistent:**
    
    - The system will eventually become consistent once all updates have been propagated to all replicas or nodes.
    
    - This means that, given enough time, all nodes in the system will have the same data, but there may be temporary inconsistencies or conflicts that need to be resolved.
    
    - The time taken to achieve consistency may vary depending on factors such as network latency, system load, and the number of replicas.
    

### **How BASE Contrasts with ACID**

BASE properties are often seen as a contrast to the ACID properties of traditional database systems.

While ACID systems prioritize consistency and isolation, BASE systems prioritize availability and scalability.

In a BASE system, consistency is relaxed in favor of availability and performance. This means that the system may continue to accept reads and writes even in the presence of network partitions or node failures, which can lead to temporary inconsistencies. However, the system will eventually converge to a consistent state once all updates have been propagated.

This relaxation of consistency allows BASE systems to achieve better availability and performance, particularly in distributed environments where network partitions and failures are common. By allowing temporary inconsistencies, BASE systems can continue to serve requests and scale horizontally, even under high load or in the face of failures.

### **Relevance to NoSQL and Other AP Systems**

BASE properties are particularly relevant to NoSQL databases and other systems that prioritize availability and partition tolerance (AP) over strong consistency.

Many NoSQL databases, such as Cassandra, Riak, and DynamoDB, are designed to be highly available and scalable, even in the face of network partitions and node failures.

These systems often employ techniques such as eventual consistency and conflict resolution to ensure that data is eventually consistent across all replicas. They may also use techniques such as sharding, replication, and distributed hash tables to distribute data across multiple nodes and ensure high availability.

### **Implications and Challenges of Eventual Consistency**

While eventual consistency allows for better availability and performance, it also introduces some challenges and implications that need to be considered when designing and working with BASE systems:

- **Stale Data:** In an eventually consistent system, reads may return stale data until all updates have been propagated. This can lead to inconsistencies and conflicts that need to be resolved.

- **Conflict Resolution:** When multiple updates are made to the same data simultaneously, conflicts can arise. BASE systems need to have mechanisms in place to detect and resolve these conflicts, such as vector clocks, timestamps, or application-specific conflict resolution logic.

- **Lack of Strong Consistency Guarantees:** BASE systems do not provide the same strong consistency guarantees as ACID systems. This means that applications need to be designed to handle temporary inconsistencies and conflicts, and may need to employ additional techniques such as compensating transactions or read-repair to maintain data integrity.

- **Complexity:** Building and maintaining eventually consistent systems can be more complex than traditional ACID systems, as developers need to reason about the potential inconsistencies and design appropriate conflict resolution and consistency mechanisms.

Despite these challenges, BASE properties have become increasingly important in the era of large-scale, distributed systems.

By prioritizing availability and scalability, BASE systems can provide the foundation for building highly responsive and resilient applications that can handle the demands of modern, data-intensive workloads.

## **Choosing the Right Model**

The suitability of different distributed system models may vary depending on the specific use case and requirements of the application. Here are some examples:

- **E-commerce:**
    
    - E-commerce applications typically require strong consistency for inventory and order management, as inconsistencies can lead to overselling or underselling.
    
    - ACID transactions and CP systems, such as traditional relational databases may be suitable for these use cases.
    

- **Social Media:**
    
    - Social media applications often prioritize availability and scalability over strong consistency, as users expect to be able to access and interact with content in real time.
    
    - AP systems, such as NoSQL databases or eventually consistent caches, may be suitable for these use cases, as they can provide high availability and low latency even in the face of network partitions.
    

- **Real-time Analytics:**
    
    - Real-time analytics applications require the ability to ingest and process large volumes of data in real time and to provide fast query responses.
    
    - AP systems, such as stream processing frameworks or NoSQL databases with eventual consistency, may be suitable for these use cases, as they can handle high throughput and provide low-latency queries.
    

- **Financial Systems:**
    
    - Financial systems often require strong consistency and ACID transactions to ensure the integrity of financial data and prevent anomalies such as double-spending.
    
    - CP systems, such as traditional relational databases or distributed ACID databases, may be suitable for these use cases, as they can provide strong consistency guarantees and support complex transactions.
    

In some cases, a hybrid approach that combines different models or provides tunable consistency may be necessary to meet the specific requirements of the application. For example:

- Using a CP system for critical data that requires strong consistency, and an AP system for less critical data that can tolerate eventual consistency.

- Employing a caching layer with eventual consistency in front of a strongly consistent database to improve read performance while maintaining consistency for writes.

- Using a database with tunable consistency, such as Apache Cassandra or DynamoDB, allows the consistency level to be adjusted on a per-operation basis, depending on the specific requirements of each use case.

## **Summary**

In this article, we’ve taken a detailed look at important concepts like CAP, PACELC, ACID, and BASE. These concepts are essential for an architect or developer designing modern applications.

Let’s summarize the key learnings from this article:

- Distributed systems face the challenge of ensuring data consistency, availability, and partition tolerance, which are often in tension with one another.

- The CAP theorem states that a distributed system can only guarantee two out of three properties: consistency, availability, and partition tolerance.

- The PACELC theorem extends the CAP theorem by considering the impact of latency in the system, providing a more nuanced understanding of the trade-offs between consistency and availability.

- The ACID (Atomicity, Consistency, Isolation, Durability) model is essential for transactional database systems, ensuring data integrity, consistency, and reliability.

- The BASE (Basically Available, Soft-state, Eventually Consistent) model prioritizes availability and scalability over strong consistency, allowing for temporary inconsistencies in favor of better performance.

- Maintaining ACID compliance in distributed databases is challenging due to network partitions, latency, scalability, and consistency vs. availability trade-offs.

- The suitability of different models may vary depending on the specific use case, and in some cases, a hybrid approach or tunable consistency may be necessary.