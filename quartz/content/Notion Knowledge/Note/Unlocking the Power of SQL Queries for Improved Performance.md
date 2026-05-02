---
Created by: Bách Đặng Thọ
Created time: 2025-09-25T02:15
---
SQL, or Structured Query Language, is the backbone of modern data management. It enables efficient retrieval, manipulation, and management of data in a Database Management System (DBMS). Each SQL command taps into a complex sequence within a database, building on concepts like the connection pool, query cache, command parser, optimizer, and executor, which we covered in our last issue.

Crafting effective queries is essential. The right SQL can enhance database performance; the wrong one can lead to increased costs and slower responses. In this issue, we focus on strategies such as using the Explain Plan, adding proper indexes, and optimizing commands like COUNT(*) and ORDER BY. We also dive into troubleshooting slow queries.

While MySQL is our primary example, the techniques and strategies discussed are applicable across various database systems. Join us as we refine SQL queries for better performance and cost efficiency.

---

## **Explain Plan**

In MySQL, the EXPLAIN command, known as EXPLAIN PLAN in systems like Oracle, is a useful tool for analyzing how queries are executed. By adding EXPLAIN before a SELECT statement, MySQL provides information about how it processes the SQL. This output shows the tables involved, operations performed (such as sort, scan, and join), and the indexes used, among other execution details. This tool is particularly useful for optimizing SQL queries, as it helps developers see the query execution plan and identify potential bottlenecks.

When an EXPLAIN statement is executed in MySQL, the database engine simulates the query execution. This simulation generates a detailed report without running the actual query. This report includes several important columns:

- id: Identifier for each step in the query execution.

- select_type: The type of SELECT operation, like SIMPLE (a basic SELECT without unions or subqueries), SUBQUERY, or UNION.

- table: The table involved in a particular part of the query.

- type: The join type shows how MySQL joins the tables. Common types include ALL (full table scan), index (index scan), range (index range scan), eq_ref (unique index scan), const/system (constant value optimization).

- possible_keys: Potential indexes that might be used.

- key: The key (index) chosen by MySQL.

- key_len: The length of the chosen key.

- ref: Columns or constants used with the key to select rows.

- rows: Estimated number of rows MySQL expects to examine when executing the query.

- Extra: Additional details, such as the use of temporary tables or filesorts.

Let's explore a practical application of the EXPLAIN command using a database table named _orders_. Suppose we want to select orders with user_id equal to 100.

```Plain
SELECT *FROM ordersWHERE user_id = 100;
```

To analyze this query with EXPLAIN, we would use:

```Plain
EXPLAIN SELECT *FROM ordersWHERE user_id = 100;
```

The output might look like this:

[![](https://substackcdn.com/image/fetch/$s_!DDAO!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F72d33f7e-6fca-47da-9e4a-04a9e053c2b8_1470x210.png)](https://substackcdn.com/image/fetch/$s_!DDAO!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F72d33f7e-6fca-47da-9e4a-04a9e053c2b8_1470x210.png)

Analysis of the EXPLAIN Output:

- id: 1, indicating the query executes as a single unit.

- select_type: SIMPLE, a straightforward select without any subqueries or unions.

- table: orders, the table accessed by the query.

- type: ref, indicating the query finds rows using an index value, here based on _user_id_.

- possible_keys: usr_idx, suggesting that the _usr_idx_ index could be used.

- key: usr_idx, confirming MySQL chooses to use the _usr_idx_ index.

- key_len: 4, the length of the key used in bytes.

- ref: const, treating _user_id_ as a constant.

- rows: 10, reflecting MySQL's estimate that it needs to examine 10 rows to fulfill the query.

- Extra: Using index, meaning the index on user_id alone is sufficient to fulfill the query without accessing table data.

Using the EXPLAIN command before running actual queries is invaluable. It helps identify inefficient SQL queries and guides us in indexing and restructuring queries to optimize performance.

## **Adding Proper Indexes**

Adding indexes to database tables is a key optimization technique that requires careful consideration to avoid creating unnecessary overhead and to maximize performance gains. Let’s review some common pitfalls:

### **1. Over Indexing**

Adding too many indexes can degrade performance, particularly in databases with heavy write operations such as INSERT, UPDATE, and DELETE. Each modification requires updates to all indexes, which consumes additional I/O and CPU resources.

### **2. Under Indexing**

Conversely, insufficient indexing leads to poor query performance, often resulting in full table scans. This is particularly detrimental in large datasets where scans are slow and inefficient.

### **3. Indexing the Wrong Columns**

Indexes on columns that are rarely used in queries do not improve performance and use up disk space and resources unnecessarily. It's vital to **analyze query patterns** to understand which columns are most beneficial to index.

### **4. Misordering Columns in Composite Indexes**

A composite index includes multiple columns. The order in which columns are arranged in these indexes matters. The ideal order prioritizes columns by their frequency in queries and their cardinality. High cardinality columns, which have a wide range of unique values, should ideally lead in the index to narrow down search results effectively. If a frequently queried column with high cardinality isn't first, MySQL may not utilize the index efficiently, which can slow down query performance.

### **5. Neglecting Cardinality**

Indexing columns with low cardinality (i.e., few unique values, such as a "gender" column) may not be effective. The database optimizer might bypass these indexes because they do not sufficiently reduce the number of rows to examine.

### **6. Ignoring Write Performance**

While indexes can significantly improve read performance, they can also degrade write performance. This consideration is particularly important in Online Transaction Processing (OLTP) systems where transaction speed is critical. Balancing read and write performance needs is key.

For high-write environments, B-Tree indexes may not be ideal. Instead, LSM trees are often used. New records are written quickly to an active memtable in memory. Older memtables are then transformed into SSTables and moved to disk, avoiding disruption to current writes. Over time, these SSTables are compacted and reorganized, enhancing future write and read operations.

Databases like Apache Cassandra, RocksDB, and Google's Bigtable employ this structure. They offer increased write throughput at the cost of higher latency and sometimes more complex read operations.

### **7. Reorg and runstats**

Over time, as data grows and changes, indexes can become fragmented, leading to decreased performance. Regular maintenance, such as rebuilding indexes and updating statistics, is necessary to maintain optimal index performance. Developers often overlook this task, as they might assume it falls under the DBA’s responsibilities.

### **8. Ignoring Index Size and Storage**

Indexes consume disk space. In systems with limited disk resources, aggressive indexing can cause storage issues. Additionally, **larger indexes take longer to maintain** and can slow down backup processes.

## **COUNT(*)**

It is a common practice to use _SELECT COUNT(*)_ to count the number of rows in a table. However, the performance can deteriorate as the number of rows grows. Why?

_COUNT(*)_ is implemented differently in different storage engines. MyISAM stores the total number of rows in a table on the disk, so _COUNT(*)_ returns the number directly. InnoDB executes _COUNT(*)_ by reading the data line by line and then accumulating the count.

InnoDB chose this design because of its transaction design. Repeatable reads are the default isolation level in InnoDB, which is implemented with Multi-Version Concurrency Control, or MVCC. Each row has to determine if it is visible to the transaction, so for a _COUNT(*)_ request, InnoDB has to read the data row by row and determine which rows are visible before it can be used to calculate the total number of rows in the table.

For a frequently updated count, a more realistic solution for counting numbers is to accumulate the counts ourselves instead of asking the database each time.

For example, we can use Redis to keep the total number of rows. Every time there is an insertion to the table, the count is incremented by one; every time there is a deletion, the count is decreased by one. However, Redis stores data in memory, so we need to run a _COUNT(*)_ request when the cache is restarted.

Adding a cache to the system will cause data consistency issues. So, another approach is to maintain a count in the database and update the count when the update transaction is committed.

Note that _COUNT(*)_ doesn’t read the row data, similar to _COUNT(1)_, where the InnoDB engine traverses the entire table but does not retrieve data from the pages. So _COUNT(*)_ and _COUNT(1)_ have similar performance.

## **ORDER BY**

As developers, we often use the ORDER BY clause in SQL queries to sort results. However, it’s often overlooked how resource-intensive this simple clause can be. Let’s look at how the sorting process works.

Assuming that we execute the following query:

```Plain
SELECT order_id, user_id, region, amount
FROM orders
WHERE region = 'CA'
ORDERBY user_id
LIMIT 5000;
```

To optimize this, we might add an index on the _region_ column to prevent a full table scan. Yet, the EXPLAIN plan may show “_Using filesort_”, indicating that sorting is necessary. MySQL allocates each thread a block of memory for sorting, called _sort_buffer_. The process works like this:

1. Allocate _sort_buffer_ for _order_id_, _user_id_, _region,_ and _amount_.

1. Retrieve the primary keys that match _region = ‘CA’_ using the index scan on the _region_ column.

1. Retrieve the matched rows from the pages, and put _order_id_, _user_id_, _region,_ and _amount columns_ into _sort_buffer._

1. Sort the data in _sort_buffer_ by the column _user_id_.

1. Take the first 5000 rows from the _sort_buffer_ and return the resultset to the client.

The diagram below shows the step-by-step process.

[![](https://substackcdn.com/image/fetch/$s_!f7t3!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F5b106e37-e264-4af2-98ce-26cd979aa36f_801x741.png)](https://substackcdn.com/image/fetch/$s_!f7t3!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F5b106e37-e264-4af2-98ce-26cd979aa36f_801x741.png)

Depending on the size of the sort_buffer, the sorting process can be conducted in memory or on disk. If the data can fit in the sort buffer, the sorting is done in memory; otherwise, it is done with temporary files on disk (external merge sort).

We can see that _ORDER BY_ can be an expensive operation. If the rows in the resultset are already sorted, there is no need for the sorting process. We can add a composite index on _(region, user_id)_ so when we retrieve all the rows with “_region = ‘CA’_”, the rows are already sorted by _user_id_. In this way, we save the resources spent on sorting.

## **IN Clause**

The _IN_ clause is often used to filter records based on multiple values, typically sourced from user inputs. When there are too many values, the _IN_ clause can grow quite large, leading to potential performance issues. For example, the SQL statement below queries orders for many users.

```Plain
SELECT *
FROM orders
WHERE user_idIN (
123, 345, 2523, 2334, 878, 3321, 332, ...)
```

Excessively large lists in an _IN_ clause can lead to several issues that negatively impact database performance:

1. SQL queries using a large _IN_ clause consume more memory and CPU resources. This is because the database engine needs to compare each row in the table against a lengthy list of values, which is computationally expensive. The database often fails to use indexes effectively when the IN list is very large.

1. The database's query planner must evaluate the best way to execute the query, and a large _IN_ clause increases the complexity of this task. This leads to longer compilation times.

1. Extensive _IN_ clauses can be difficult to read and understand. This complexity can lead to errors during maintenance or when modifying the query.

Instead of a large _IN_ clause, using joins with temporary tables can sometimes be more efficient. This method allows the database's optimizer more flexibility in using indexes and partitioning data.

## **Other Slow SQLs**

In this section, we review some cases where badly written SQL statements can lead to bad performance.

### **Implicit Type Conversion**

Assuming that we use the SQL statement below to select an order from the _orders_ table. This works fine if the _order_id_ column is numeric.

```Plain
SELECT *
FROM orders
WHERE order_id = 1234;
```

However, if the _order_id_ column is varchar(32), there is an implicit type conversion here, which triggers a table scan because the optimizer gives up index search for a function operation on an indexed column.

### **Locks**

Sometimes, when we execute a simple SQL statement, it hangs for a long time without returning any results. We need to run the “_show processlist_” command to see what state the SQL statement is in.

1. “Waiting for table metadata lock”: This means a thread is requesting or holding an MDL(metadata lock) write lock on a table, blocking the SQL statement. We can kill the process that holds the MDL lock.

1. “Waiting for table flush”: A flush table command was blocked by another statement, which then blocked our SQL statement.

1. Row lock. We can use the SQL below to check locks on a certain table and kill the _blocking_pid_ if necessary.

```Plain
SELECT *
FROM sys.innodb_lock_waits
WHERE locked_table='`myschema`.`orders`'
```

# **Summary**

We have covered the basic principles of adding proper indexes and common SQL statements that require extra database resources. While SQL is a powerful tool for data manipulation and retrieval, misuse or poor practices can lead to significant performance issues, security vulnerabilities, and maintainability challenges.

1. Improper indexing: Failing to properly index tables can lead to slow query performance. Conversely, over-indexing can slow down write operations.

1. Ignoring database concurrency: Neglecting transaction management and isolation levels can lead to data inconsistencies, especially in high concurrency environments.

1. Inefficient queries: Overly complex queries, excessive use of subqueries, and large IN clauses can severely degrade performance by increasing CPU and memory usage and extending execution times.

By addressing these pitfalls, developers and database administrators can enhance both the efficiency and security of their DBMS, leading to more robust, scalable, and reliable applications.