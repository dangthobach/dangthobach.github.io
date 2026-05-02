---
Created by: Bách Đặng Thọ
Created time: 2025-09-09T00:55
---
No matter how many resources are allocated, systems have a specific capacity beyond which they don’t operate efficiently. Traffic can arrive in bursts, clients retry aggressively, and shared infrastructure makes one team spike everyone’s outage.

This is where rate limiting helps as a defensive and fairness mechanism. It protects services from overload and abuse, shapes traffic to match real capacity, and ensures that high-value work does not drown in noise.

Rate limiting matters because it enforces a defined policy at the moment a request hits the system. The limiter decides whether a request enters the system now, later, or not at all.

A good policy aligns with both reliability and user experience. It can protect downstream applications without surprising clients. In other words, rate limiting is not a feature for edge cases. It is part of the core reliability story, as essential as retries, timeouts, and circuit breakers.

In this article, we will focus on the need for rate limiting and some practical rate limiting strategies that are used in different scenarios.

[![](https://substackcdn.com/image/fetch/$s_!EmvS!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fc8da4839-d519-43a9-bffb-2c81a2c153f4_2250x2624.png)](https://substackcdn.com/image/fetch/$s_!EmvS!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fc8da4839-d519-43a9-bffb-2c81a2c153f4_2250x2624.png)

## **The Need for Rate Limiting**

The risk of denial-of-service attacks never disappears. Even traffic spikes from legitimate clients can appear like attacks. Bots and scrapers deliberately create pressure on the system.

Without controls, a sudden surge can saturate the CPU, fill connection pools, and amplify retries until everything collapses.

Noisy-neighbor effects are a close second. In multi-tenant APIs, one hot tenant or a single buggy integration can hog shared capacity. This results in a spike in latency and error rates.

Cost control also matters for any system. Unbounded traffic turns into unbounded spend on bandwidth, egress, and third-party APIs. A rate limiter eliminates the chances of surprise bills and keeps usage within the plan.

The diagram below shows how a rate limiter works on a high level:

[![](https://substackcdn.com/image/fetch/$s_!MQqy!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fcba15622-c35d-467d-8090-e1c8809f2dc8_1938x1246.heic)](https://substackcdn.com/image/fetch/$s_!MQqy!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fcba15622-c35d-467d-8090-e1c8809f2dc8_1938x1246.heic)

Rate limiting often gets confused with related ideas. Here are some key distinctions that should be kept in mind:

- Throttling slows a caller by delaying or spacing requests. Rate limiting enforces a policy by admitting or rejecting. Throttling can be a client-side reaction to limits or a server-side behavior that deals with timing rather than dropping requests.

- Quotas define an allowance over a long window, such as a monthly cap. Rate limits govern short windows and bursts. Systems often use both: quota to control total consumption, and rate limits to protect instantaneous capacity.

- Admission control inspects current health before allowing work. It reacts to load and SLOs. Rate limiting applies a predefined budget per key. Many designs combine them: check health, then apply the per-key limit.

- Backpressure signals upstream services to slow down, often with queue metrics or flow control. Rate limiting is more like a gate at the edge.

A rate limiter has trade-offs related to accuracy, predictability, fairness, and overhead. Some properties that need to be understood are as follows:

- **Accuracy:** This means the rate limiter enforces the budget as intended. For example, if the policy says “no more than 100 requests per minute”, the rate limiter should stick close to that rule. Some algorithms are loose and can allow callers to make more requests at the window boundaries. Others track usage more precisely.

- **Predictability:** This means the rate limiter behaves in a way that clients can rely on. If requests are admitted in a burst and then blocked for a long stretch, clients get frustrated and may retry aggressively. Rate limiters that smooth traffic produce steadier results and help keep downstream latency under control.

- **Fairness:** This means each key or client gets the share of traffic that policy allows. Per-instance limiters can over-reject or over-admit when traffic is uneven across replicas. Centralized or sharded approaches improve fairness but add coordination cost.

- **Low overhead:** This means the rate limiter runs fast and uses little memory. Request paths cannot afford slow checks. Expensive data structures or non-atomic updates add latency and risk contention or race conditions.

These properties rarely align perfectly. If the design optimizes accuracy, it likely pays in overhead. If it optimizes predictability with smoothing, it may pay in latency during bursts. If it optimizes fairness with the global state, it pays in complexity and cross-network calls.

A practical limiter also needs operational traits:

- Monotonic time for calculations that do not jump backward during NTP adjustments.

- Idempotent updates or atomic scripts in the case of multiple replicas.

- Clear headers and errors so clients can adapt behavior.

Let us now look at a few key rate-limiting strategies or algorithms in more detail.

## **Fixed Window Counter**

The fixed window counter is the simplest workable rate-limiting algorithm. This involves counting requests in the current discrete time bucket and rejecting once the threshold is reached. It is easy to reason about, cheap to run, and good enough for many low-risk endpoints.

A fixed window splits time into equal buckets, such as one minute or ten seconds. Each incoming request maps to a tuple (key, window_start) where key identifies the caller or scope of fairness and “window_start” represents the beginning of the current bucket.

See the diagram below for the basic concept:

[![](https://substackcdn.com/image/fetch/$s_!Y1Zm!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F96791836-e2b4-4c63-8bcd-aaf255a052e4_1938x1246.heic)](https://substackcdn.com/image/fetch/$s_!Y1Zm!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F96791836-e2b4-4c63-8bcd-aaf255a052e4_1938x1246.heic)

As a more detailed example, consider a rate-limiting policy that allows 100 requests per minute per API key. At 12:34:10, for key A1, the compute window_start is “12:34:00”. Increment the count for this counter key (A1: 12:34:00). If the new value is greater than or equal to 100, admit the request. Otherwise, it can be rejected.

This design enforces a hard cap per discrete window and keeps storage bounded by time.

However, fixed windows suffer from edge effects. A caller can send a burst at the end of one window and a burst at the start of the next, which exceeds the intended average over a true sliding minute.

For read-only or cacheable endpoints, this may be acceptable. For sensitive writes, it can break invariants or spike downstream load. Some mitigations are as follows:

- Use shorter windows (such as 10-second buckets) to reduce burst size at edges.

- Use sub-bucketing or rolling counters if precision must improve without moving to full sliding logs.

- Stagger window starts per key with a random offset to avoid synchronized spikes at the top of the minute.

- Switch to token bucket or leaky bucket strategies when consistent smoothing is required.

Fixed window counters work well when precision is not critical. Some examples are:

- Coarse controls on read-heavy endpoints such as search, list, or dashboard views.

- Internal tools and admin consoles where predictable ceilings matter more than perfect smoothing.

- Early-stage products that just need a guardrail and don’t want to invest in complex rate-limiting setups.

## **Sliding Window Log**

The sliding window log enforces limits over a true moving window.

It stores recent timestamps per key and admits a request only if the count within the last T seconds remains under the threshold. This improves precision when compared to fixed windows, but at the cost of more memory and per-request work.

See the diagram below that explains the concept of the sliding window log:

[![](https://substackcdn.com/image/fetch/$s_!ct4w!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F703f17cc-3c35-4e08-885c-415653c6953d_1938x1246.heic)](https://substackcdn.com/image/fetch/$s_!ct4w!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F703f17cc-3c35-4e08-885c-415653c6953d_1938x1246.heic)

Each key maintains a time-ordered log of request timestamps. On each request, the rate limiter performs three steps as follows:

- Append the current timestamp for the key.

- Prune all entries older than “Now - T”.

- Admit the request if the remaining count is below the limit. Otherwise, reject the request.

The precision comes from pruning based on the exact time window. The log always represents the last T seconds, not a coarse bucket. Pruning must happen before the count check, so expired entries do not inflate the total.

Some data structures that can help implement such a sliding window log are an in-memory deque per key or a Redis sorted set per key. Deques are fast and simple on one node. On the other hand, Redis sorted sets provide global fairness with more cost. Memory scales with recent traffic, not with total history.

Sliding window logs remove the boundary glitches seen in fixed windows. A caller cannot send 200 requests across a window edge when the policy intends 100 per true minute. The log always reflects the last T seconds, which yields precise enforcement and predictable behavior.

This approach is useful in the following cases:

- Sensitive write APIs such as payments, orders, OTP generation, or inventory changes.

- Partner or enterprise quotas that require fairness and clear guarantees.

- Abuse prevention where adversaries attempt to game window edges.

However, it does not work too well for the following scenarios:

- Hot high-cardinality keys where per-request storage becomes expensive.

- Very high QPS endpoints where O(log n) operations or large deques add latency.

- Multi-region deployments with strict global limits, unless a shared store is acceptable.

## **Sliding Window Counter**

A sliding window counter is a lighter alternative to storing every single request timestamp. It combines the fixed window counter and the sliding window log.

See the diagram below to understand the basic premise of a sliding window approach:

[![](https://substackcdn.com/image/fetch/$s_!kn6m!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F2c71abcd-2e1e-49d5-9e6e-0cb2d10c6589_2386x1448.heic)](https://substackcdn.com/image/fetch/$s_!kn6m!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F2c71abcd-2e1e-49d5-9e6e-0cb2d10c6589_2386x1448.heic)

In the sliding window counter, instead of keeping a log of request timestamps, it calculates the weighted counter for the previous time window. When a new request arrives, the counter is adjusted based on the weight, and the request is allowed if the total is below the limit.

Here’s how it works in practice:

- Suppose the rate limiter allows 10 requests per minute.

- In the previous minute, there were 6 requests, and in the current minute so far, there have been 4 requests.

- Now, a new request arrives 20 seconds (one-third of the way) into the current minute. To calculate the rolling count, we blend the current bucket with part of the previous one.

- This involves adding the requests in the current window to those in the previous window for the overlap percentage. In other words, 4 + (6 * 0.67), which comes to approximately 8 requests.

- Since the rate limiter allows 10 requests per minute, any new request can be accepted.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!yoHR!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F505ae42d-175b-4af2-a057-89fcd2e22802_1938x1246.heic)](https://substackcdn.com/image/fetch/$s_!yoHR!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F505ae42d-175b-4af2-a057-89fcd2e22802_1938x1246.heic)

The benefit of the sliding window counter is that memory usage remains constant because only a handful of bucket counts are stored, rather than thousands of timestamps. The trade-off is that the estimate can be slightly off near the boundaries of a slice.

The sliding window counter works well for the following scenarios:

- Medium-sensitivity endpoints, such as search, feed, and autocomplete, where UX benefits from smoothing and a small approximation error is fine.

- Partner APIs that need predictable behavior without the storage overhead of per-request logs.

- Gateways that enforce per-key limits at high cardinality, where constant memory per key is a priority.

Some poor fits for this strategy are as follows:

- High-stakes write paths like payments or OTP where exact guarantees matter.

- Extremely bursty workloads that can pack a large number of requests inside a sub-bucket.

- Scenarios that need a strict cutoff at exactly T seconds.

## **Token Bucket**

The token bucket is the most widely used rate-limiting algorithm because it balances two needs: allowing short bursts of traffic while keeping long-term usage under control.

It works by adding “tokens” to a bucket at a steady rate. Each request consumes one token. If tokens are available, the request passes immediately. If the bucket is empty, requests are rejected or delayed.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!OZyD!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fce44a21d-1849-402f-9c4f-003bbbb99563_1938x1246.heic)](https://substackcdn.com/image/fetch/$s_!OZyD!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fce44a21d-1849-402f-9c4f-003bbbb99563_1938x1246.heic)

Two numbers define a token bucket:

- **Refill rate:** Specifies how many tokens are added per second. This sets the sustained rate. For example, 10 tokens per second means on average, 10 requests per second can pass.

- **Capacity:** Specifies the maximum number of tokens the bucket can hold. This sets the burst size. If the capacity is 50, then up to 50 requests can pass at once (if the bucket is full), even though the steady rate is 10 per second.

Think of it this way: the refill rate defines the long-term speed limit, while the capacity defines how much flexibility is allowed for short bursts.

Here’s how it works:

- When a request arrives, check the token count.

- If at least one token is available, consume it and admit the request.

- If no tokens remain, reject or delay the request.

Tokens are replenished over time. The most common approach to do so is a lazy refill approach that only updates when a request arrives.

The token bucket strategy is popular because it allows occasional spikes while keeping the sustained load bounded. It fits quite well for the following scenarios:

- **Public APIs:** Clients can send a short burst without immediate rejection, but sustained abuse is capped.

- **Mobile apps:** Mobile networks generate bursty traffic when connections recover. The token bucket smooths this without punishing the user.

- **User-facing actions:** Typing, clicking, or retry storms often come in bursts. The token bucket absorbs these while keeping the downstreams safe.

## **Leaky Bucket**

The leaky bucket algorithm is another way to control traffic.

Unlike a token bucket, which decides at the arrival time whether a request can pass, the leaky bucket approach smooths traffic by allowing requests to flow out at a fixed rate. Bursty input goes into a queue (the bucket), and the queue “leaks” requests steadily over time.

See the diagram below to understand the concept of the leaky bucket:

[![](https://substackcdn.com/image/fetch/$s_!COPx!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F3d81c250-c6a0-4985-8850-03fb3ed4edb3_1938x1246.heic)](https://substackcdn.com/image/fetch/$s_!COPx!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F3d81c250-c6a0-4985-8850-03fb3ed4edb3_1938x1246.heic)

To describe more clearly the difference:

- The token bucket strategy allows bursts if tokens are available. It enforces an average rate but lets short spikes through.

- The leaky bucket strategy smooths everything into a constant output rate. Even if 100 requests arrive at once, they will leave at, say, 10 per second.

In short, the token bucket controls how much traffic can reach the system at once, whereas the leaky bucket controls how fast traffic can reach the protected system.

Requests that arrive faster than the drain rate are queued. This means:

- If the burst is small, the queue drains quickly and latency stays low.

- If the burst is large, the queue grows and the latency increases.

- If the queue is unbounded, latency can grow without limit, which hurts users.

Practical setups help keep the queue size limited. When the queue is full, new requests are dropped or rejected immediately. There are different ways to decide which requests to drop:

- Reject new arrivals when the queue is full.

- Start rejecting some requests before the queue is full to avoid sudden bursts of rejections.

- Keep high-value or critical requests and drop lower-priority ones.

The leaky bucket strategy is best when a steady, predictable output rate matters more than letting bursts through quickly.

## **Choosing Limits and Keys**

Algorithms set the mechanics, and configuration sets the policy.

The rate limiter should reflect value, cost, and fairness, not just a number in a config file. The goal is to pick keys and limits that protect scarce resources while keeping a good experience for well-behaved clients.

### **1 - Pick the right unit of fairness**

The choice of key decides who shares the same limit. Pick a key that reflects who should be held accountable for usage. Some strategies are as follows:

- Per user or per API key works well for consumer-facing services or paid plans, since each customer is isolated.

- Per tenant fits B2B platforms where multiple users belong to the same organization and share one quota.

- Per IP is usually a fallback for anonymous traffic. It can be inaccurate because many users may sit behind the same NAT or proxy.

Some good practices are as follows:

- Prefer stable identifiers like user IDs or API keys over IP addresses when possible.

- Normalize headers or keys to prevent spoofing.

- Combine identifiers when needed. For example, using tenant and user to balance fairness within a larger account.

### **2 - Scope limits to costs**

Not all endpoints cost the same. Writes, fan-out queries, and calls to paid third parties deserve tighter limits than cheaper reads. Some basic techniques are as follows:

- Apply per-endpoint or per-method limits to protect heavy paths.

- Keep a global cap per key to prevent broad abuse.

- Avoid throttling low-cost GETs when the pain comes from expensive POSTs.

### **3 - Translate business quotas into algorithm parameters**

Monthly or daily quotas need to be converted into per-second budgets that the rate limiter can enforce.

For example, the sustained rate is the quota divided by the period. Burst size is a small multiple of that rate, enough to cover short spikes without stressing downstream systems.

The token bucket strategy is a natural fit for this. Refill rate matches the sustained rate, and capacity matches the burst size.

### **4 - Balance Burst vs Sustained Rate**

Larger bursts feel responsive for clients but can overwhelm a backend. Smaller bursts feel strict but keep systems safe.

A good starting point is a burst equal to a few seconds of traffic. Monitor the downstream latency and adjust carefully when using this approach.

### **5 - Communicate limits to clients clearly**

Clients behave better when they know the rules. Some of the common conventions are as follows:

- Use HTTP 429 for rejections.

- Send Retry-After with a clear wait time.

- Include RateLimit-Limit, RateLimit-Remaining, and RateLimit-Reset headers.

- Return a structured error body with details so clients can adapt automatically.

## **Summary**

In this article, we have looked at rate limiting and its various strategies or algorithms in detail.

Here are the key learning points in brief:

- Rate limiting protects services by shaping traffic to match capacity and by enforcing policy at admission time.

- It complements throttling, quotas, admission control, and backpressure rather than replacing them.

- A good rate limiter optimizes for accuracy, predictability, fairness, and low overhead, and real systems trade one for another.

- Fixed window counters count requests in a discrete bucket and reject after the threshold for simple, fast enforcement. Use fixed windows for coarse limits where simplicity and cost win over precision.

- Sliding window logs keep exact timestamps and admit only if the last T seconds remain under the limit.

- In the sliding window counter, instead of keeping a log of request timestamps, it calculates the weighted counter for the previous time window. When a new request arrives, the counter is adjusted based on the weight, and the request is allowed if the total is below the limit.

- The token bucket adds tokens at a steady rate and spends them when requests arrive. It allows bursts as long as tokens are available, but enforces a steady long-term rate.

- The leaky bucket strategy queues requests and lets them out at a fixed drain rate. It smooths bursty input into a steady output stream.