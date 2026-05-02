---
Created by: Bách Đặng Thọ
Created time: 2025-09-09T01:12
---
_Disclaimer: The details in this post have been derived from the articles/videos shared online by the Slack engineering team. All credit for the technical details goes to the Slack Engineering Team. The links to the original articles and videos are present in the references section at the end of the post. We’ve attempted to analyze the details and provide our input about them. If you find any inaccuracies or omissions, please leave a comment, and we will do our best to fix them._

Most people think of Slack as a messaging app. It is technically accurate, but from a systems perspective, it's more like a real-time, multiplayer collaboration platform with millions of concurrent users, thousands of messages per second, and an architecture that evolved under some unusual constraints.

At peak weekday hours, Slack maintains over five million simultaneous WebSocket sessions. That’s not just a metric, but a serious architectural challenge. Each session represents a live, long-running connection, often pushing out typing indicators, presence updates, and messages in milliseconds. Delivering this kind of interactivity on a global scale is hard. Doing it reliably with high performance is even harder.

One interesting trivia is that the team that built Slack was originally building a video game named Glitch: a browser-based MMORPG. While Glitch had a small but passionate audience, it struggled to become financially sustainable. During the development of Glitch, the team created an internal communication tool that would later become Slack. When Glitch shut down, the team recognized the potential of the internal communication tool and began to develop it into a bigger product for business use. The backend for this internal tool became the skeleton of what would become Slack.

[![](https://substackcdn.com/image/fetch/$s_!y5WI!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F1560999b-5cc5-449a-94cd-bd7fad6b666b_1600x1048.png)](https://substackcdn.com/image/fetch/$s_!y5WI!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F1560999b-5cc5-449a-94cd-bd7fad6b666b_1600x1048.png)

This inheritance shaped Slack’s architecture in two key ways:

- **Separation of concerns**: Like game servers manage real-time events separately from game logic, Slack splits its architecture early. One service (the “channel server”) handled real-time message propagation. Another (the “web app”) managed business logic, storage, and user auth.

- **Push-first mentality**: Unlike traditional request-response apps, Glitch pushed updates as the state changed. Slack adopted this model wholesale. WebSockets weren’t an optimization—they were the foundation.

This article explores how Slack’s architecture evolved to meet the demands of a system that makes real-time collaboration possible across organizations of 100,000+ people.

---

## **[Real-Time Code Reviews Powered by AI (Sponsored)](https://bit.ly/CodeRabbit_051325)**

[![](https://substackcdn.com/image/fetch/$s_!Nm2k!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F49ea9e90-675f-4107-802a-e273ff8f5d24_2048x1024.png)](https://substackcdn.com/image/fetch/$s_!Nm2k!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F49ea9e90-675f-4107-802a-e273ff8f5d24_2048x1024.png)

Slack made real-time collaboration seamless for teams. CodeRabbit brings that same spirit to code reviews. It analyzes every PR using context-aware AI that understands your codebase suggesting changes, catching bugs and even asking questions when something looks off. Perfect for fast-moving teams who want quality code reviews without slowing down. Integrated with GitHub, GitLab and it's like a senior engineer reviewing with you on every commit. Free for Open-source.

**[Review Smarter with CodeRabbit](https://bit.ly/CodeRabbit_051325)**

---

## **Initial Architecture**

Slack’s early architecture was a traditional monolithic backend fused with a purpose-built, real-time message delivery system.

The monolith, written in Hacklang, handled the application logic. Hacklang (Facebook’s typed dialect of PHP) offered a pragmatic path: move fast with a familiar scripting language, then gradually tighten things with types. For a product iterating quickly, that balance paid off. Slack’s backend handled everything from file permissions to session management to API endpoints.

But the monolith didn’t touch messages in motion. That job belonged to a real-time message bus: the channel server, written in Java. The channel server pushed updates over long-lived WebSocket connections, broadcast messages to active clients, and arbitrated message order. When two users hit “send” at the same moment, it was the channel server that decided which message came first.

Here’s how the division looked in terms of functionalities:

- Web App (Hacklang)
    
    - Auth, permissions, and storage
    
    - API endpoints and job queuing
    
    - Session bootstrapping and metadata lookup
    

- Channel Server (Java)
    
    - WebSocket handling
    
    - Real-time message fan-out
    
    - Typing indicators, presence blips, and ordering guarantees
    

[![](https://substackcdn.com/image/fetch/$s_!i_si!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F864cb6c8-f8b7-4cab-b43a-cdbf51f43c9e_1600x1045.png)](https://substackcdn.com/image/fetch/$s_!i_si!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F864cb6c8-f8b7-4cab-b43a-cdbf51f43c9e_1600x1045.png)

This split worked well when Slack served small teams and development moved fast. But over time, the costs surfaced:

- The monolith grew brittle as testing got harder and deployment risk went up.

- The channel server held state, which complicated recovery and scaling.

- Dependencies between the two made failures messy. If the web app went down, the channel server couldn’t persist messages, but might still tell users they’d sent them.

### **The Core Abstraction: Persistent Messaging**

Messaging apps live or die by trust. When someone sends a message and sees it appear on screen, they expect it to stay there and to show up for everyone else. If that expectation breaks, the product loses credibility fast. In other words, persistence becomes a foundational feature.

Slack’s design bakes this in from the start. Unlike Internet Relay Chat (IRC), where messages vanish the moment they scroll off-screen, Slack assumes every message matters, even the mundane ones. It doesn’t just aim to display messages in real-time. It aims to record them, index them, and replay them on demand. This shift from ephemeral to durable changes everything.

IRC treats each message like a radio transmission, whereas Slack treats messages like emails. If the user missed something, they can always scroll up, search later, and re-read at a later date. This shift demands a system that guarantees:

- Messages don’t disappear

- Message order stays consistent

- What one user sees, every user sees

Slack delivers that through what looks, at first glance, like a simple contract:

- When a message shows up in a channel, everyone should see it.

- When a message appears in the UI, it should be in stable storage.

- When clients scroll back, they should all see the same history, in the same order.

This is a textbook case of atomic broadcast.

### **Atomic Broadcast**

Atomic broadcast is a classic problem in distributed systems. It's a formal model where multiple nodes (or users) receive the same messages in the same order, and every message comes from someone. It guarantees three core properties:

- **Validity:** If a user sends a message, it eventually gets delivered.

- **Integrity:** No message appears unless it was sent.

- **Total Order:** All users see messages in the same sequence.

Slack implements a real-world approximation of atomic broadcast because it was essential for their functionality. Imagine a team seeing different sequences of edits, or comments that reference messages that “don’t exist” on someone else’s screen.

But here’s the twist: in distributed systems, atomic broadcast is as hard as consensus. And consensus, under real-world failure modes, is provably impossible to guarantee. So Slack, like many production systems, takes the pragmatic path. It relaxes constraints, defers work, and recovers from inconsistency instead of trying to prevent it entirely.

This tension between theoretical impossibility and practical necessity drives many of Slack’s architectural decisions.

## **Old vs New Send Flows**

In real-time apps, low latency is a necessity. When a user hits “send,” the message should appear instantly. Anything slower breaks the illusion of conversation. But making that feel snappy while also guaranteeing that the message is stored, ordered, and replayable? That’s where things get messy.

Slack’s original message send flow prioritized responsiveness. The architecture puts the channel server (the real-time message bus) at the front of the flow. A message went from the client straight to the channel server, which then:

- Broadcast it to all connected clients

- Sent an acknowledgment back to the sender

- Later handed it off to the web app for indexing, persistence, and other deferred work

This gave users lightning-fast feedback. However, it also introduced a dangerous window: the server might crash after confirming the message but before persisting it. To the sender, the message looked “sent.” To everyone else, especially after a recovery, it might be gone.

This flow worked, but it carried risk:

- Stateful servers meant complex failover logic and careful coordination.

- Deferred persistence meant the UI could technically lie about message delivery.

- Retries and recovery had to reconcile what was shown vs. what was saved.

Slack patched around this with persistent buffers and retry loops. But the complexity was stacking up. The system was fast, but fragile.

### **The Web App Takes the Lead**

As Slack matured, and as outages and scale pushed the limits, the team reversed the flow.

In the new send model, the web app comes first:

- The client sends the message via HTTP POST to the web app

- The web app logs the message to the job queue (persistence, indexing, and parsing all happen here)

- Only then does it invoke the channel server to broadcast the message in real-time

[![](https://substackcdn.com/image/fetch/$s_!16Rk!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F974efba8-a4c1-4b0b-ad4d-8965d57a6697_1600x1069.png)](https://substackcdn.com/image/fetch/$s_!16Rk!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F974efba8-a4c1-4b0b-ad4d-8965d57a6697_1600x1069.png)

This change improves several things:

- **Crash safety:** If anything goes down mid-flow, either the message persists or the client gets a clear failure.

- **Stateless channel servers:** Without needing local buffers or retries, they become easier to scale and maintain.

- **Latency preserved:** Users still see messages immediately, because the real-time broadcast happens fast, even while persistence continues in the background.

And one subtle benefit: the new flow doesn’t require a WebSocket connection to send a message. That’s a big deal for mobile clients responding to notifications, where setting up a full session just to reply was costly.

The old system showed messages fast, but sometimes dropped them. The new one does more work up front, but makes a stronger promise in terms of persistence.

## **Session Initialization and the Need for Flannel**

For small teams, starting a Slack session looks simple. The client requests some data, connects to a WebSocket, and starts chatting. However, at enterprise scale, that “simple” startup becomes a serious architectural choke point.

Originally, Slack used a method called RTM Start (Real-Time Messaging Start). When a client initiated a session, the web app assembled a giant JSON payload: user profiles, channel lists, membership maps, unread message counts, and a WebSocket URL. This was meant to be a keyframe: a complete snapshot of the team’s state, so the client could start cold and stay in sync via real-time deltas.

[![](https://substackcdn.com/image/fetch/$s_!pFXV!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F8ee2a242-a049-4adf-ada0-85144a21384f_1600x1168.png)](https://substackcdn.com/image/fetch/$s_!pFXV!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F8ee2a242-a049-4adf-ada0-85144a21384f_1600x1168.png)

It worked until teams got big.

- For small teams (under 100 users), the payload was lightweight.

- For large organizations (10,000+ users), it ballooned to tens of megabytes.

- Clients took tens of seconds just to parse the response and build local caches.

- If a network partition hit, thousands of clients would reconnect at once, slamming the backend with redundant work.

And it got worse:

- Payload size grew quadratically with team size. Every user could join every channel, and the web app calculated all of it.

- All this work happened in a single data center, creating global latency for users in Europe, Asia, or South America.

This wasn’t just slow. It was a vector for cascading failure. One bad deploy or dropped connection could take out Slack’s control plane under its load.

### **Flannel: Cache the Cold Start**

To fix this, Slack introduced Flannel, a purpose-built microservice that acts as a stateful, geo-distributed cache for session bootstrapping.

Instead of rebuilding a fresh session snapshot for every client on demand, Flannel does a couple of things differently:

- It maintains a pre-warmed in-memory cache of team metadata

- Listens to WebSocket events to keep that cache up to date, just like a client would

- It serves session boot data locally, from one of many regional replicas

- Sits astride the WebSocket connection, terminating it and handling session validation

Here’s what changes in the flow:

- A client connects to Flannel and presents its auth token.

- Flannel verifies the token (delegating to the web app if needed).

- If the cache is warm, it sends a hello response immediately. No need to hit the origin.

[![](https://substackcdn.com/image/fetch/$s_!k7Av!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F34ca89b4-9568-4675-8eb1-c73395fcb52c_1600x884.png)](https://substackcdn.com/image/fetch/$s_!k7Av!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F34ca89b4-9568-4675-8eb1-c73395fcb52c_1600x884.png)

This flips the cost model from compute-heavy startup to cache-heavy reuse. While it’s tempting to think that Flannel adds complexity. But Slack found that at scale, complexity that’s predictable and bounded is better than simplicity that breaks under pressure.

## **Scaling Considerations and Trade-offs**

Every system seems to work on the whiteboard. The real test comes when it’s live, overloaded, and something fails. At Slack’s scale, maintaining reliable real-time messaging isn’t just about handling more messages per second. It’s also about absorbing failure without breaking user expectations.

One of the most visible symptoms at scale is message duplication. Sometimes a user sees their message posted twice. It’s not random. It’s a side effect of client retries.

Here’s how it happens:

- A mobile client sends a message.

- Network flakiness delays the acknowledgment.

- The client times out and retries.

- Both messages make it through, or one makes it twice, and now the user wonders what just happened.

To survive this, Slack leans on idempotency. Each message includes a client-generated ID or salt. When the server sees the same message ID again, it knows it’s not a new send. This doesn’t eliminate all duplication, especially across devices, but it contains the damage.

On the backend, retries and failures get more serious. A message might:

- Reach the channel server but fail to persist

- Persist to the job queue but never push

- Push to some clients and not others

The system has to detect and recover from all of these without losing messages, breaking order guarantees, and flooding the user with confusing errors.

This is where queueing architecture matters. Slack uses Kafka for durable message queuing and Redis for in-flight, fast-access job data. Kafka acts as the system’s ledger and Redis provides short-term memory.

This separation balances:

- **Durability vs. speed:** Kafka holds the truth; Redis handles the work-in-progress.

- **Retry logic:** Jobs pulled from Kafka can be retried intelligently if processing fails.

- **Concurrency control:** The system avoids processing the same message twice and waiting forever for a stuck job.

## **Conclusion**

Slack’s architecture isn’t simple, and that’s by design. The system embraces complexity in the places where precision matters most: real-time messaging, session consistency, and user trust. These are the end-to-end paths where failure is visible, consequences are immediate, and user perception can shift in a heartbeat.

The architecture reflects a principle that shows up in high-performing systems again and again: push complexity to the edge, keep the core fast and clear. Channel servers, Flannel caches, and job queues each exist to protect a smooth user experience from the messiness of distributed systems, partial failures, and global scale.

At the same time, the parts of the system that don’t need complexity, like storage coordination or REST API responses, stay lean and conventional.

Ultimately, no architecture stands still. Every scaling milestone, every user complaint, every edge case pushes the system to adapt. Slack’s evolution from monolith-plus-bus to globally distributed microservices wasn’t planned in a vacuum. It came from running into real limits, then designing around them.

The lesson isn’t to copy Slack’s architecture. It’s to respect the trade-offs it reveals:

- Optimize for latency, but tolerate slowness in the right places.

- Build around failure, not away from it.

- Embrace complexity where correctness pays for itself, and fight to simplify the rest.

**References:**

- [Scaling Slack: Goto Conference](https://youtu.be/o4f5G9q_9O4?si=PerFODDzQ1JHz0QP)

- [Glitch - Wikipedia](https://en.wikipedia.org/wiki/Glitch_\(video_game\))

- [Flannel: An application level edge cache to make Slack scale](https://slack.engineering/flannel-an-application-level-edge-cache-to-make-slack-scale/)