---
Created by: Bách Đặng Thọ
Created time: 2025-09-15T05:54
---
Databases are the backbone of modern applications. They power everything from e-commerce platforms and financial systems to social media and analytics tools.

Ensuring good database performance is critical, as it directly impacts user experience, operational costs, and the ability to scale when needed.

Users expect applications to respond instantly. A slow database can lead to delays in fetching data, resulting in poor application performance and monetary impact. For example:

- Delayed product searches or sluggish checkout processes can frustrate customers, increasing cart abandonment rates in an e-commerce platform.

- Slow feed updates can reduce user engagement for a social media application.

A strong database performance is the key to retaining users and keeping them positively engaged with the application.

Database inefficiencies often lead to increased hardware requirements and higher cloud usage bills. Poorly optimized queries can consume excessive CPU, memory, and disk I/O. This leads to organizations provisioning expensive resources to compensate for poor performance, which could have been avoided with proper optimization.

However, optimizing database performance requires a multi-faceted approach. There is no magical one-size-fits-all strategy.

In this post, we’ll explore the various factors that can impact the performance of a database. We’ll also look at multiple strategies that can help improve the database performance.

[![](https://substackcdn.com/image/fetch/$s_!tpzP!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F64991a04-4e41-4e54-ab88-de6612b026b2_1592x1600.png)](https://substackcdn.com/image/fetch/$s_!tpzP!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F64991a04-4e41-4e54-ab88-de6612b026b2_1592x1600.png)

## **Key Metrics to Evaluate Database Performance**

Effective evaluation of database performance depends on understanding and monitoring key metrics. These metrics provide insights into how the database handles queries, resources, and user demands, helping to identify and resolve bottlenecks.

Below are the primary metrics used in the industry:

### **1 - Query Execution Time**

This is the time it takes for a database to process and return the results of a query.

High query execution time often indicates issues with query optimization, lack of proper indexing, or large dataset scans. For example, a query fetching customer order history in an e-commerce database might take several seconds if it performs a full table scan instead of utilizing an index.

We can use database profiling tools like EXPLAIN and EXPLAIN ANALYZE in PostgreSQL or the Query Store in SQL Server to measure the query execution time.

### **2 - Throughput**

Throughput is the number of database transactions (reads, writes, updates) processed per second. The common unit is Transactions Per Second (TPS).

A low throughput under high traffic could point to resource bottlenecks or inefficient query handling. For example, an analytics platform processing user event logs might require a throughput of 10,000 transactions per second.

### **3 - Latency**

This is the time taken for a database request to travel from the client, be processed, and return the response.

Latency is critical for real-time applications where user experience depends on quick responses.

For example, in a messaging app, if the latency for fetching new messages exceeds a few milliseconds, users might experience unacceptable delays in chat updates.

### **4 - Resource Utilization**

Resource utilization involves measuring the consumption of CPU, memory, disk I/O, and network resources by the database.

Measuring these parameters is important to identify whether resource limitations are causing bottlenecks. For example, a database experiencing 90% CPU utilization during peak hours may require query optimization or vertical scaling to avoid performance degradation.

Here’s how these parameters are typically measured:

- **CPU**: Monitor query workloads and CPU usage per session or process.

- **Memory**: Track buffer pool usage (for example, InnoDB buffer pool in MySQL).

- **Disk I/O**: Monitor read/write operations per second.

- **Network**: Measure data transfer rates for distributed systems or replication.

## **Factors Affecting Database Performance**

Several factors can impact the performance of a database. Let’s look at some of the most common factors:

### **Item Size**

The size of individual records or rows directly impacts storage requirements and query performance.

It dictates whether the workload is CPU-bound or storage-bound. For example, running 100K operations with an average payload size of 80KB is much different than managing the same throughput with a 1KB payload.

Having a larger number of smaller-sized items may introduce CPU overhead. However, large items may require more I/O to issue, process, and merge several data pages.

When working with extremely large payloads, it’s important to have realistic latency and throughput expectations. Generally speaking, databases should not be used to store large blobs.

Some strategies are as follows:

- Techniques like compression to reduce storage overhead and data pruning to remove unnecessary or redundant fields.

- Storing large items, such as media files, in dedicated object storage (e.g., Amazon S3) while referencing them via the database can also improve performance.

### **Item Type**

The nature of data stored, such as text, numbers, JSON, or binary formats, impacts database performance due to differences in how these types are processed.

For instance, querying structured numeric data is typically faster than parsing and filtering unstructured JSON data. As a general rule of thumb, we should choose the data type that’s the minimum needed to store the type of data. For example, we don’t need to store a year as bigint.

Optimizing performance also involves using specialized indexes, like JSON indexes for document-based data, and ensuring that complex types are only used when necessary. For example, flattening JSON fields into separate columns can simplify query patterns and improve retrieval speeds.

### **Dataset Size**

As the dataset grows, query execution times and maintenance operations like indexing or backups can become slower.

Large datasets often lead to full table scans, causing significant performance bottlenecks.

Strategies to address this include partitioning the data into smaller, manageable chunks (e.g., by date or region), and archiving infrequently accessed records to external storage. For example, an analytics database can use horizontal partitioning to split data by year, ensuring that queries only scan relevant partitions.

### **Concurrency**

Concurrency refers to the ability of a database to handle simultaneous operations.

High concurrency can lead to contention for resources like locks on rows or tables. This is common in multi-user systems, such as financial applications where transactions must be consistent and isolated.

Concurrency must be balanced to reach appropriate throughput and latency values. Little’s law can help with this. The law states that:

```Plain
Total Concurrent Requests Being Processed or Queued = Average Throughput * Average Latency
```

For example, if we want a system to serve 500K requests per second at 2 ms average latency, the possible concurrency is around 1000 in-flight requests.

Some optimizations that can help are as follows:

- Include using optimistic locking for low-conflict scenarios or pessimistic locking when conflicts are frequent. We will look at them in more detail in a later section.

- Adjusting transaction isolation levels, such as using READ COMMITTED instead of SERIALIZABLE, can also balance performance and consistency.

### **Consistency Expectations**

Different applications require varying levels of consistency.

While strong consistency ensures immediate synchronization across nodes, it can increase latency in distributed systems. Conversely, eventual consistency allows for temporary inconsistencies but offers better performance.

For example, a social media platform might use eventual consistency for displaying user posts but enforce strong consistency for financial transactions.

Optimizations include choosing the right consistency model based on application needs and using caching layers to reduce the perceived delay for eventual consistency.

### **Geographic Distribution**

Databases spanning multiple geographic locations face challenges such as network latency and synchronization delays.

For example, a global e-commerce platform might experience slower response times for users far from the primary database.

A couple of common strategies to handle this are as follows:

- Geo-replication to store data closer to users.

- Latency-based routing to direct traffic to the nearest replica.

Typically, read-heavy applications benefit greatly from replicating data across regions, while write-heavy systems require more complex conflict resolution mechanisms.

### **High Availability (HA) Expectations**

Ensuring uptime and fault tolerance often involves replicating data across multiple nodes or regions, which can introduce performance trade-offs. For instance, synchronous replication guarantees that all nodes are updated simultaneously but increases write latency.

To optimize HA expectations:

- Use asynchronous replication for non-critical data and prioritize synchronous replication for critical operations.

- Clustering and automated failover mechanisms further enhance availability without compromising performance. For example, a payment processing system might use synchronous replication for transaction data while using asynchronous replication for logging.

### **Workload Variability**

Fluctuations in workload, such as traffic spikes during sales events, can strain database performance. For instance, an online retailer might experience 10x traffic during Black Friday, overwhelming the database.

Auto-scaling database resources during peak times and implementing rate limiting to control the number of concurrent requests can help maintain stability. Also, partitioning heavy batch operations into smaller tasks ensures real-time queries are not blocked during high-demand periods.

## **Impact of Workload Types on Database Performance**

Database workloads vary based on the nature and frequency of operations performed.

Each type of workload, such as write-heavy, read-heavy, mixed, delete-heavy, and competing workloads, poses unique challenges and requires specific optimization strategies.

Let’s look at each workload type, its impact, and practical optimization strategies in more detail.

### **1 - Write-Heavy Workloads**

Write-heavy workloads involve frequent INSERT and UPDATE operations. They are common in logging systems, real-time IoT applications, and order management systems in e-commerce platforms.

There are multiple challenges with such workloads:

- Disk I/O bottlenecks.

- Increased latency due to frequent disk writes.

- Lock contention, particularly in concurrent environments.

- Index maintenance overhead during frequent updates.

Several optimization strategies can be applied to handle write-heavy workloads:

- **Batch Writing**: Aggregate multiple writes into a single operation to reduce disk I/O.

- **Asynchronous Writes**: Use write-ahead logs (WAL) or message queues to decouple write operations from the main database workload.

- **Reduce Index Overhead**: Limit the number of indexes on frequently updated tables, as each write requires index updates.

- **Fast Storage:** Use extremely fast storage, such as NVMe drives if the peak throughput requirement is high.

- **Partitioning**: Split data (e.g., by date or region) to distribute writes across multiple partitions, reducing contention.

### **2 - Read-Heavy Workloads**

Read-heavy workloads consist of frequent SELECT operations, often seen in content delivery systems, dashboards, or e-commerce platforms where customers browse products.

The challenges with such workloads are as follows:

- High latency for complex queries on large datasets.

- Cache misses leading to increased disk I/O.

- Strain on a single database instance serving both reads and writes.

Some optimization strategies to deal with read-heavy workloads are as follows:

- **Caching**: Use in-memory caching systems like Redis or Memcached to store frequently accessed data (for example, product details or user profiles).

- **Replication**: Set up read replicas to distribute read queries, reducing the load on the primary database.

- **Materialized Views**: Precompute complex queries and store the results for faster access.

- **Efficient Indexing**: Use covering indexes to optimize queries that retrieve multiple columns.

See the diagram below that shows the concept of materialized views:

[![](https://substackcdn.com/image/fetch/$s_!XTX-!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F679bf91a-f9e1-47eb-b2a1-5ed9aa4b5f6f_1600x1127.png)](https://substackcdn.com/image/fetch/$s_!XTX-!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F679bf91a-f9e1-47eb-b2a1-5ed9aa4b5f6f_1600x1127.png)

### **3 - Delete-Heavy Workloads**

Delete-heavy workloads involve frequent removal of records, often seen in systems implementing data retention policies, archival processes, or GDPR compliance.

Excessive deletions can cause several challenges such as:

- Fragmentation and performance degradation

- Index bloat as deleted entries persist until explicitly rebuilt.

- Table locks and delays in completing other operations.

Some optimization strategies to handle delete-heavy workloads are as follows:

- **Soft Deletes**: Mark rows as inactive (e.g., with a status column) instead of physically deleting them, deferring actual deletion to off-peak hours.

- **Batch Deletions**: Perform deletions in small batches to minimize lock contention and resource spikes.

- **Partition Dropping**: For large-scale deletions, drop entire partitions (e.g., monthly logs) instead of deleting row-by-row.

- **Regular Index Maintenance**: Rebuild or reorganize indexes periodically to avoid bloat.

### **4 - Competing Workloads (Real-Time vs Batch)**

Competing workloads occur when real-time operations (user-facing queries) and batch jobs (ETL processes) run on the same database.

This is common in data warehouses or hybrid systems, where both workloads need resources simultaneously. The challenges are as follows:

- Batch jobs consuming resources can slow down real-time queries.

- Increased latency for user-facing operations due to resource contention.

- Unpredictable query performance during peak load.

Several optimization strategies are available to manage competing workloads:

- **Workload Scheduling**: Schedule batch jobs during off-peak hours to avoid conflicting with real-time workloads.

- **Resource Isolation**: Use resource groups or quotas to allocate dedicated CPU, memory, or I/O bandwidth for real-time queries.

- **Separate Workloads**: Move batch processing to a separate database or data warehouse.

- **Incremental Processing**: Break large batch jobs into smaller chunks to minimize resource contention.

## **Optimizing Schema and Data Design**

Schema and data design are foundational to database performance. Poor design can lead to inefficiencies that ripple through every layer of an application.

Let’s look at some strategies to achieve an efficient database design.

### **Normalization vs Denormalization**

Normalization organizes data into separate, related tables to eliminate redundancy and maintain data integrity. It is ideal for transactional systems where consistency is critical.

For example:

- A Product table contains product details, while an Orders table references the product through a product_id foreign key.

- This approach means that every time order details have to be shown, the product name has to be fetched from the Product table.

However, Denormalization combines data into fewer tables to reduce the overhead of joins, improving read performance.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!I36L!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fe7ceb9ba-d831-4e9e-a801-301cdb34cda1_1600x1136.png)](https://substackcdn.com/image/fetch/$s_!I36L!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fe7ceb9ba-d831-4e9e-a801-301cdb34cda1_1600x1136.png)

It is commonly used in read-heavy systems like analytics platforms. For example, apart from maintaining separate Product and Orders tables, a single denormalized OrderDetails table can also be created that includes product details alongside order data, reducing the need for joins.

### **Partitioning**

Partitioning divides a large table into smaller, more manageable pieces, improving query performance and scalability.

- In horizontal partitioning, we split rows across multiple tables or storage locations based on a key, such as “date” or “region”. For example, an Orders table can be partitioned by year, so a query for orders in 2023 only scans the relevant partition.

- In vertical partitioning, we split columns into separate tables, keeping frequently accessed columns in one table and less-used columns in another. In a Users table, columns like username and email might be kept in the primary table, while large profile photos are stored in a secondary table.

### **Data Modeling Best Practices**

Efficient data modeling ensures the schema supports application performance and scalability. Some useful practices to keep in mind are as follows:

- Use the smallest data type that meets requirements. For example, use TINYINT for values ranging from 0-255 instead of INT.

- Avoid generic types like TEXT or BLOB unless necessary, as they consume more storage and impact performance.

- Avoid overcomplicated relationships, such as deep hierarchies or excessive foreign keys since they can slow queries.

- Use surrogate keys (id) for primary keys instead of composite keys for simpler joins

## **Query Optimization**

Query optimization is an important aspect of improving database performance. It ensures queries execute efficiently, consumes minimal resources, and returns results quickly.

Some key aspects of query optimization with practical tips and examples are as follows:

### **Analyzing Execution Plans**

Execution plans are detailed representations of how a database engine executes a query. They provide insights into operations like table scans, index usage, joins, and sort operations.

We can use tools like EXPLAIN in MySQL or EXPLAIN ANALYZE in PostgreSQL to view execution plans.

See the example below:

```Plain
EXPLAIN SELECT * FROM orders WHERE customer_id = 123;
```

The plan might reveal a full table scan if the customer_id column lacks an index.

A few key indicators to check in the execution plans are as follows:

- **Full Table Scans**: Indicate missing indexes or poorly designed queries.

- **Index Usage**: Confirms that indexes are being utilized effectively.

- **Join Order and Type**: Highlights whether nested loops or hash joins are used, which can affect performance.

### **Writing Efficient Queries**

Poorly written queries can severely degrade performance. Simple changes in query design can make a significant difference.

Some basic techniques are as follows:

- **Avoid SELECT ALL:** Fetching all columns of a table when only a few are needed is a waste of resources. Fetch only the required columns.

- **Filter Early:** Apply filters in the WHERE clause to reduce the data scanned and returned.

- **Using Index Hints:** Index hints force the database to use a specific index, which can be helpful when the query planner does not automatically select the optimal index. See the example below**:**

```Plain
SELECT * FROM orders USE INDEX (idx_customer_id) WHERE customer_id = 123;
```

- **Optimize Common Query Patterns:** Aggregate functions like SUM, COUNT, and AVG can be resource-intensive, especially on large datasets. To optimize, use covering indexes to include all columns required for the aggregate operation. Precompute aggregates and store them in summary tables for frequent queries. See the example below:

```Plain
CREATE INDEX idx_order_date ON orders(order_date);
SELECT COUNT(*) FROM orders WHERE order_date > '2023-01-01';
```

- **Handling Joins:** Joins can slow down the queries, especially between large tables. It is good to ensure that indexed columns are used for join conditions. Also, use the smallest possible dataset by filtering before joining.

## **Indexing Techniques to Improve Performance**

Indexes are critical for speeding up database queries by reducing the amount of data scanned.

However, using the wrong index type or failing to maintain them can negatively impact performance, particularly for write-heavy workloads.

Let’s understand some key indexing techniques and their performance implications.

### **Primary and Secondary Indexes**

A primary index is automatically created on the primary key column(s) of a table. It ensures that each row has a unique identifier and organizes the data in a sorted order.

[![](https://substackcdn.com/image/fetch/$s_!qVuc!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fed555574-3418-44c3-903e-48a201226dba_1600x1029.png)](https://substackcdn.com/image/fetch/$s_!qVuc!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fed555574-3418-44c3-903e-48a201226dba_1600x1029.png)

See the example below where customer_id has been declared as the primary key:

```Plain
CREATE TABLE customers (
    customer_id INT PRIMARY KEY,
    name VARCHAR(100),
    email VARCHAR(100)
);
```

Primary indexes improve lookup speed for queries filtering by the primary key. However, they might slow down insertions if the primary key is auto-incremented, as the database must maintain the sorted order.

A secondary index is created on non-primary columns to speed up searches. Unlike the primary index, it does not dictate the physical storage order.

See the example below:

```Plain
CREATE INDEX idx_name ON customers(email);
```

Secondary indexes improve query performance for non-primary key searches but increase storage overhead and slow down writes due to index updates.

See the diagram below to understand their application:

[![](https://substackcdn.com/image/fetch/$s_!7cXg!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Ffa5eb2e6-544a-4adf-aef0-9e646ae2cab1_1600x864.png)](https://substackcdn.com/image/fetch/$s_!7cXg!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Ffa5eb2e6-544a-4adf-aef0-9e646ae2cab1_1600x864.png)

### **Composite Index**

Composite indexes cover multiple columns, allowing queries filtering on one or more of these columns to execute faster. They help optimize queries with multiple filtering conditions.

See the example below for a composite index:

```Plain
CREATE INDEX idx_customer_order ON orders(customer_id, order_date);
```

Composite indexes improve performance for multi-column filters but must be carefully designed based on query patterns, as the order of columns in the index matters. For instance, the above index will not optimize query filtering by only order_date.

### **Index Maintenance**

Indexes degrade over time due to fragmentation, bloat, and changes in data distribution. Regular maintenance is necessary to ensure optimal performance.

Some common maintenance tasks should be performed to maintain the indexes:

- Rebuilding and reorganizing indexes to remove fragmentation.

- Unused indexes consume storage and slow down writes and should be removed.

- Evaluate the efficiency of indexes by checking the cache hit ratio. Low ratios indicate that indexes are not effectively used or the cache size is insufficient.

- Avoid over-indexing, which increases storage and maintenance costs, and slows down write operations.

- Database query planners rely on index statistics to make optimization decisions. Regularly update these to reflect data changes.

- Use database tools or queries to identify how often indexes are used.

## **Concurrency Management and Lock Handling**

Poor concurrency handling can lead to slow performance, inconsistencies, and even system failures, especially in high-traffic applications like online transaction processing (OLTP) systems.

Let us look at some key aspects of concurrency management for database performance.

### **Importance of Concurrency Management**

When multiple transactions access the same data concurrently, conflicts can arise, such as:

- **Lost Updates**: Two transactions update the same record simultaneously, overwriting each other's changes.

- **Dirty Reads**: A transaction reads uncommitted changes from another, leading to inconsistencies.

- **Deadlocks**: Two or more transactions wait indefinitely for resources locked by the other.

### **Transaction Isolation Levels**

Transaction isolation levels define how much a transaction must be isolated from others. Higher isolation ensures consistency but may reduce concurrency and performance.

Here are the isolation levels from lowest to highest isolation.

- **Read Uncommitted**: Transactions can read uncommitted changes made by other transactions. This is useful for analytics queries where absolute accuracy isn’t critical. However, there is a risk of dirty reads.

- **Read Committed**: In this isolation level, transactions only read committed changes. This is suitable for most OLTP systems. For example, a banking application prevents viewing partial updates during a transfer.

- **Repeatable Read**: Ensures consistent reads within a transaction but doesn’t prevent phantom reads (new rows matching criteria added by other transactions). This is useful for inventory systems to prevent stock inconsistencies.

- **Serializable**: At the highest isolation level, transactions are executed as if they were serialized. This is suitable for critical financial operations requiring strict consistency. However, it reduces concurrency significantly.

### **Optimistic vs Pessimistic Locking**

Pessimistic locking locks a resource for the entire transaction to prevent other transactions from accessing it. She diagram below that shows pessimistic locking in action.

[![](https://substackcdn.com/image/fetch/$s_!DMhi!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F4d37c0aa-4f76-4b16-90ec-792bc1151ea0_1600x1111.png)](https://substackcdn.com/image/fetch/$s_!DMhi!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F4d37c0aa-4f76-4b16-90ec-792bc1151ea0_1600x1111.png)

Pessimistic locking is useful in high-conflict scenarios where data changes are frequent, such as inventory updates. However, it can also lead to contention and reduced concurrency.

See the example below that shows pessimistic locking.

```Plain
BEGIN TRANSACTION;
SELECT * FROM inventory WITH (UPDLOCK) WHERE product_id = 123;
UPDATE inventory SET stock = stock - 1 WHERE product_id = 123;
COMMIT;
```

Optimistic locking assumes conflicts are rare and doesn’t lock resources. Instead, it validates data integrity before committing.

See the diagram below that shows optimistic locking in action using version numbers of the entity

[![](https://substackcdn.com/image/fetch/$s_!dq9s!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fd512a099-fae7-4311-861b-db1be230b4f2_1600x1109.png)](https://substackcdn.com/image/fetch/$s_!dq9s!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fd512a099-fae7-4311-861b-db1be230b4f2_1600x1109.png)

This type of locking is useful for low-conflict scenarios like user profile updates.

See the below possible example for optimistic locking

```Plain
BEGIN TRANSACTION;
SELECT stock, version FROM inventory WHERE product_id = 123;

-- Check version matches before updating
UPDATE inventory SET stock = stock - 1, version = version + 1
WHERE product_id = 123 AND version = 1;
COMMIT;
```

### **Connection Pooling**

Connection pooling maintains a pool of database connections that can be reused, reducing the overhead of creating and closing connections for every request.

The benefits are as follows:

- Reduces latency by avoiding frequent connection setup/teardown.

- Prevents resource exhaustion by limiting the maximum number of active connections.

## **Strategies for Scaling Databases**

Scaling databases is essential as application workloads grow, ensuring they maintain performance and reliability under increased demand.

Let’s look at the primary scaling approaches for databases in more detail:

### **Vertical Scaling**

Vertical scaling involves upgrading the hardware of a single database server to handle more load. This includes adding more CPU, memory, or storage.

[![](https://substackcdn.com/image/fetch/$s_!OxeQ!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F60668ca6-3f43-4ec6-a9c6-e1a9f13a490e_1600x873.png)](https://substackcdn.com/image/fetch/$s_!OxeQ!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F60668ca6-3f43-4ec6-a9c6-e1a9f13a490e_1600x873.png)

The basic techniques are as follows:

- **Increasing CPU and Memory:** Enhances the server's ability to handle more concurrent connections and complex queries.

- **Upgrading Storage:** Switching to faster SSDs or increasing storage capacity improves I/O performance.

- **Using Larger Instances in Cloud Environments:** For example, moving from an AWS R5 instance to an R6 instance with higher specifications.

The key benefits of vertical scaling are simple management of a single database server and no changes to the application or database design.

However, vertical scaling also has some limitations such as:

- **Cost**: Hardware upgrades become increasingly expensive with diminishing returns.

- **Single Point of Failure**: A single server means no failover, increasing downtime risks.

- **Scalability Limitations**: Physical hardware has upper limits, making vertical scaling unsustainable for large workloads.

### **Horizontal Scaling**

Horizontal scaling involves distributing the database load across multiple servers by adding nodes. This method enhances scalability and fault tolerance.

The key techniques for horizontal scaling are as follows:

### **1 - Sharding**

In this case, we divide the data into smaller, more manageable chunks known as shards and store each shard on a different server.

See the diagram below that demonstrates the concept of sharding

[![](https://substackcdn.com/image/fetch/$s_!08W7!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F48f12994-f708-494a-a31c-efc65e0fdcd4_1600x1002.png)](https://substackcdn.com/image/fetch/$s_!08W7!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F48f12994-f708-494a-a31c-efc65e0fdcd4_1600x1002.png)

This approach is ideal for large datasets accessed independently, such as social media platforms or multi-tenant applications.

To implement sharding, we follow the following steps:

- Identify a sharding key, such as user_id or region.

- Route queries to the appropriate shard based on the key.

- Use middleware or custom logic in the application to manage shard locations.

### **2 - Replication**

Replication involves maintaining multiple copies of the same database, typically with a primary node for writes and secondary nodes for reads.

See the diagram below to understand how the leader-follower replication works.

[![](https://substackcdn.com/image/fetch/$s_!lRz0!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F95eba9ce-4956-414c-8ff4-62796b39ea92_1600x1062.png)](https://substackcdn.com/image/fetch/$s_!lRz0!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F95eba9ce-4956-414c-8ff4-62796b39ea92_1600x1062.png)

A basic leader-follower replication involves the leader node handling writes and critical reads and the follower nodes handling most read operations.

This type of replication is best for read-heavy workloads where read operations significantly outnumber writes.

## **Summary**

In this article, we’ve taken a detailed look at various aspects of database performance along with multiple strategies that help improve performance.

Let’s summarize our learnings in brief:

- The key metrics to evaluate performance are query execution time, throughput, and latency.

- Elements like item size, dataset size, and consistency requirements influence how well the database performs under different conditions.

- Tailoring strategies to workload types (write-heavy, read-heavy, mixed, etc.) ensures optimal performance for varying application demands.

- Balancing normalization and denormalization and following data modeling best practices are the keys to efficient schema design.

- Analyzing execution plans, writing efficient queries, and leveraging index hints can significantly reduce query execution times and resource usage.

- Using appropriate indexing strategies (for example, primary, secondary, composite) and maintaining indexes regularly ensures faster query performance and reduced overhead.

- Transaction isolation levels, deadlock resolution, and efficient locking strategies maintain consistency while enabling high concurrency in multi-user environments.

- Vertical scaling upgrades hardware, while horizontal scaling strategies like sharding and replication distribute traffic for enhanced scalability and fault tolerance.