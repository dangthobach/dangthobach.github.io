---
Created by: Bách Đặng Thọ
Created time: 2025-09-14T16:04
---
In the world of distributed systems, one of the hardest problems isn’t just storing or retrieving data. It’s figuring out where that data should live when we have dozens, hundreds, or even thousands of servers.

Imagine running a large-scale web service where user profiles, cached web pages, or product catalogs need to be spread across multiple machines.

Consistent hashing emerged as a clever solution to this problem and quickly became one of the foundational ideas for scaling distributed systems.

Instead of scattering keys randomly and having to reshuffle them every time the cluster size changes, consistent hashing ensures that only a small, predictable portion of keys needs to move when servers are created or destroyed. This property, often described as “minimal disruption,” is what makes the technique so powerful.

Over the years, consistent hashing has been adopted by some of the largest companies in technology. It underpins distributed caching systems like memcached, powers databases like Apache Cassandra and Riak, and is at the heart of large-scale architectures such as Amazon Dynamo. When browsing a social media feed, streaming a video, or shopping online, chances are that consistent hashing is working quietly in the background to keep the experience smooth and fast.

In this article, we will look at consistent hashing in detail. We will also understand the improvements to consistent hashing using virtual nodes and how it helps scale systems.

[![](https://substackcdn.com/image/fetch/$s_!PZ0l!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fa3800af4-ff26-4a37-a03a-e991dc7ae74e_2250x2624.heic)](https://substackcdn.com/image/fetch/$s_!PZ0l!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fa3800af4-ff26-4a37-a03a-e991dc7ae74e_2250x2624.heic)

## **The Problem with Traditional Hashing**

The most straightforward way to distribute data across servers is by using a hash function combined with the modulo operator.

For example, if we have 4 cache servers, we could take the hash of a key (say, hash(user_id)) and then compute hash(user_id) % 4 to decide which server stores the data. This approach works neatly at first: each server potentially gets roughly one-fourth of the keys, and lookups are fast and predictable.

However, the cracks appear as soon as the number of servers changes.

Imagine adding a fifth server to handle growing traffic. Now the placement calculation changes to hash(user_id) % 5. That small change completely reshuffles the assignment of keys. A key that previously landed on server 2 might now be sent to server 4, while keys on server 0 may scatter across all the others. The result is that almost every key gets remapped.

This causes the following problems:

- For a caching system, this means nearly all cached data is suddenly “lost” because the lookup points to different servers, forcing a flood of expensive cache misses and database queries.

- For storage systems, this requires physically moving huge amounts of data across the network, which is slow, costly, and can overload the cluster.

The same problem happens in reverse when a server fails or is removed. Going from 5 servers back to 4 once again changes the calculation, triggering another near-total reshuffling of keys.

To make matters worse, the more data there is, the more disruptive this becomes. Even a minor infrastructure adjustment (such as adding one new node to a cluster of dozens) can cause a domino effect of data migrations and downtime.

In practice, this instability makes traditional modulo-based hashing unsuitable for dynamic environments. This is because systems at scale rarely remain static. Hardware fails, workloads grow, and operators continually add or remove capacity.

What’s needed is a smarter way to assign keys to servers that can handle these changes gracefully, without forcing a complete reallocation of data every time the cluster size shifts. This is the exact gap that consistent hashing tries to fill.

## **The Core Idea of Consistent Hashing**

Consistent hashing takes a very different approach to solving the redistribution problem.

Instead of tying the placement of keys directly to the number of servers (as in the modulo method), it maps both servers and keys onto the same continuous space. This space is a logical circle often referred to as the hash ring.

See the diagram below that shows such a hash ring:

[![](https://substackcdn.com/image/fetch/$s_!1UXd!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Febf4dde6-243c-4970-a564-b5bb8025093e_1784x1296.heic)](https://substackcdn.com/image/fetch/$s_!1UXd!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Febf4dde6-243c-4970-a564-b5bb8025093e_1784x1296.heic)

As an example, if we use a 32-bit hash function, the possible values range from 0 to 2³² - 1. Instead of treating that range as a straight line, consistent hashing “wraps” it into a circle where 0 comes right after 2³² - 1. This circular space is what we refer to as the hash ring.

Both servers (nodes) and data keys are mapped onto this ring by running them through the same hash function. For instance, if we hash Server A and get a value of 1000000, that’s Server A’s position on the ring. If we hash Server B and get 2500000, that’s where Server B sits.

The assignment rule for keys is simple: a key belongs to the first server that appears in the clockwise direction from its position on the ring. If we visualize it, each server “owns” the arc of the ring between itself and its predecessor. So if there are three servers (let’s call them A, B, and C) placed at different points on the circle, all keys that fall between A and B go to B, those between B and C go to C, and so on. This creates a natural partitioning of the key space without relying on the total number of servers as a divisor.

The beauty of this design becomes clear when there are changes to the cluster.

Suppose we add a new server D somewhere between A and B. In traditional hashing, nearly all keys would get reassigned, but in consistent hashing, only the keys that now fall between A and D move over to the new server. Everything else stays exactly where it was.

Similarly, if server C were to fail, its keys would simply shift to the next server clockwise, while keys mapped to A or B remain untouched. In both cases, only a fraction of the keys are remapped, dramatically reducing the disruption caused by scaling or failures.

This lookup mechanism is also both simple and powerful. Here’s how it works:

- Each server is responsible for the segment of the ring between itself and its predecessor, so the load is divided into continuous ranges of the hash space.

- As long as servers are spread evenly around the circle, the keys are also distributed fairly evenly.

[![](https://substackcdn.com/image/fetch/$s_!b8gS!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fe7875e76-33ec-42fa-a41e-0b34a715991d_1784x1296.heic)](https://substackcdn.com/image/fetch/$s_!b8gS!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fe7875e76-33ec-42fa-a41e-0b34a715991d_1784x1296.heic)

This principle of minimal disruption is the cornerstone of consistent hashing. It means the system can scale gracefully, handling node churn without forcing massive rebalancing.

For large-scale platforms where servers are constantly being added, retired, or replaced, this stability is invaluable. Of course, in practice, hash functions don’t always place servers perfectly evenly, which can lead to imbalance. However, at a conceptual level, the ring structure guarantees that if nodes are reasonably well distributed, the keys will be too.

## **Virtual Nodes and Load Balancing**

While the hash ring concept solves the problem of massive reshuffling, it isn’t perfect.

One of the biggest issues is uneven load distribution. As mentioned, hash functions, while generally uniform, can still place servers unevenly on the ring.

For example, suppose we have three servers: A, B, and C. If Server A and Server B happen to land close together on the ring, then Server C might end up covering a much larger portion of the key space. This means C will store far more data than the others, becoming a hotspot and potentially getting overwhelmed, while A and B sit underutilized.

The problem becomes even more pronounced when the cluster size is small, since randomness plays a bigger role in how the ring is divided.

To address this, consistent hashing introduces the idea of virtual nodes (sometimes called replicas).

Instead of placing each physical server at a single point on the ring, we place it at multiple points. For example, Server A might be assigned 100 virtual positions, each with a slightly different hash value, like hash(ServerA#1), hash(ServerA#2), and so on. The same is done for Servers B and C.

See the diagram below that shows the concept of virtual nodes for two nodes: Node 0 and Node 1.

[![](https://substackcdn.com/image/fetch/$s_!QeYp!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fabdb9ede-a756-417f-a506-335c7820cd8f_1650x1296.heic)](https://substackcdn.com/image/fetch/$s_!QeYp!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fabdb9ede-a756-417f-a506-335c7820cd8f_1650x1296.heic)

Now, instead of each server owning one large contiguous slice of the ring, the key space is divided into many smaller chunks spread across the circle. Each physical server is then responsible for the collection of chunks corresponding to its virtual nodes.

This technique smooths out the distribution. If one area of the ring is sparse, virtual nodes from multiple servers will fill in the gaps, preventing a single machine from becoming overloaded.

It also makes the system more flexible. In heterogeneous clusters where servers have different capacities, stronger machines can be assigned more virtual nodes than weaker ones, giving them a larger share of the key space. For example, a high-performance server might handle 200 virtual nodes while a smaller machine handles only 50. This way, the load aligns more closely with the actual capacity of the hardware.

## **Node Addition and Removal**

The true power of consistent hashing becomes clear when nodes are added or removed from a cluster. Unlike traditional modulo-based hashing, where almost every key gets reassigned, consistent hashing localizes the impact so that only a fraction of the keys have to move. Let’s walk through both scenarios.

Here’s what happens when a new node joins the cluster:

- Suppose we have three nodes (A, B, and C) placed evenly around the hash ring, each handling about one-third of the key space.

- A new node D is introduced, and its hash places it between A and C on the ring.

- Only the keys that fall between C and D are remapped to D instead of A.

- Keys owned by B and C remain completely unchanged.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!QF-Q!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F9af3cca4-cb99-47ca-8d63-9c764e5396b9_1784x1296.heic)](https://substackcdn.com/image/fetch/$s_!QF-Q!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F9af3cca4-cb99-47ca-8d63-9c764e5396b9_1784x1296.heic)

Here’s what happens when a node leaves or fails:

- Imagine node B suddenly goes offline.

- All the keys that were mapped to B are reassigned to the next server clockwise, which is C in this example.

- Keys mapped to A or D are unaffected and continue to be served as before.

- Instead of a complete reshuffle, only B’s e of the key space is redistributed

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!X04e!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F2e00b09c-461f-4a9e-b7fd-974fd3d090be_1784x1296.heic)](https://substackcdn.com/image/fetch/$s_!X04e!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F2e00b09c-461f-4a9e-b7fd-974fd3d090be_1784x1296.heic)

In large-scale deployments, these transitions are often smoothed out with rebalancing strategies.

- For example, when adding a node, data might be migrated in controlled batches to avoid sudden spikes in traffic.

- Similarly, in the case of a failure, replication ensures that data remains available on other servers, so the reassignment is primarily about shifting ownership rather than moving raw data.

## **Challenges and Practical Considerations**

While consistent hashing is elegant, implementing it in real-world systems comes with its own set of challenges.

At scale, operators have to deal with not just the math of the hash ring, but also the messy realities of hardware variability, skewed workloads, and operational overhead. Some of the key challenges include:

- **Maintaining metadata about the ring:** Servers need to know the positions of all other nodes (and their virtual nodes) to route requests correctly, which can grow expensive in very large clusters.

- **Efficient lookup algorithms:** Finding the “next server clockwise” must be done quickly. Naive approaches can be too slow, so systems often rely on sorted data structures or specialized search techniques.

- **Skewed key distributions:** If the input keys aren’t uniformly random, some servers may still get overloaded even with consistent hashing, requiring further balancing strategies.

- **Heterogeneous server capacities:** Not all machines are equal. Some may be more powerful than others, and the ring needs to account for this by assigning proportional virtual nodes.

- **Operational complexity:** Adding or removing nodes gracefully often means migrating data in batches, monitoring system health, and ensuring replicas remain in sync, which adds engineering overhead.

## **Conclusion**

In this article, we’ve covered consistent hashing in detail, along with the concept of virtual nodes.

Here are the key learning points in brief:

- Consistent hashing solves the key distribution problem in distributed systems, ensuring data can be placed efficiently across a dynamic set of servers.

- Traditional hashing methods, such as modulo, are simple but don’t work well when nodes are added or removed, causing almost every key to be remapped and leading to disruption.

- The core idea of consistent hashing is to map both servers and keys onto a circular hash ring, assigning each key to the first server found in the clockwise direction.

- The hash ring allows the key space to be partitioned fairly, and as long as servers are evenly spread, keys get distributed evenly without depending on the number of servers.

- Virtual nodes improve fairness by letting each physical server appear multiple times on the ring, smoothing out uneven distribution and allowing stronger servers to handle more load.

- Adding a new server affects only the keys between it and its predecessor, while removing a server shifts its slice of keys to the next node clockwise, ensuring minimal disruption.