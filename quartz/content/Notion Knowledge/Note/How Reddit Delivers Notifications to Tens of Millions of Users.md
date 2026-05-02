---
Created by: Bách Đặng Thọ
Created time: 2025-08-31T00:21
---
_Disclaimer: The details in this post have been derived from the official documentation shared online by the Reddit Engineering Team. All credit for the technical details goes to the Reddit Engineering Team.  The links to the original articles and sources are present in the references section at the end of the post. We’ve attempted to analyze the details and provide our input about them. If you find any inaccuracies or omissions, please leave a comment, and we will do our best to fix them._

Push notifications carry a double-edged sword in the design of any product. Done well, these notifications reconnect users with content they care about. Done poorly, they turn into noise, leading users to mute them entirely or uninstall the app. Striking the right balance requires a precise and scalable system that understands what matters to each user and when it makes sense to interrupt them.

Reddit’s notification recommender system handles this problem at scale.

It evaluates millions of new posts daily and decides which ones should be sent as personalized notifications to tens of millions of users. Behind each decision is a pipeline that combines causal modeling, real-time retrieval, deep learning, and product-driven reranking.

In this article, we understand how that pipeline works. It walks through the key components (budgeting, retrieval, ranking, and reranking) of the pipeline and highlights the trade-offs at each stage.

Some key features of the system are as follows:

- It operates using a close-to-real-time pipeline.

- Driven by asynchronous workers and queues.

- Shares core components with other ML and ranking systems at Reddit.

- Aims for low latency and high freshness of recommendations.

The system has evolved significantly, but the core goal remains unchanged: deliver timely, relevant notifications that drive engagement without overwhelming the user.

## **The Overall Architecture**

The notification pipeline processes millions of posts daily to decide which ones to deliver as push notifications.

It’s structured as a series of focused stages, each responsible for narrowing and refining the candidate set.

- **Budgeting** sets the daily limit for how many notifications to send to each user, balancing engagement with fatigue.

- **Retrieval** pulls a shortlist of potentially interesting posts using fast, lightweight methods.

- **Ranking** scores these candidates using a deep learning model trained on user interactions like clicks, upvotes, and comments.

- **Reranking** adjusts the final order based on business goals—boosting certain content types or enforcing diversity.

[![](https://substackcdn.com/image/fetch/$s_!Ud-p!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F85385f25-c348-4329-9f20-09bc1f564a46_1249x1600.png)](https://substackcdn.com/image/fetch/$s_!Ud-p!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F85385f25-c348-4329-9f20-09bc1f564a46_1249x1600.png)

The pipeline runs on a queue-based asynchronous infrastructure to ensure timely delivery, even at massive scale.

## **Budgeter**

The first decision the system makes each day is how many notifications a user should receive.

Notification fatigue isn’t just a UX nuisance, but a permanent loss of reach. Once a user disables notifications, there’s rarely a path back. The system treats this as a high-cost failure. The goal is to maximize engagement without making things annoying.

Not every user gets the same treatment. The budgeter estimates how each additional notification might affect user behavior. Push too hard, and users disable notifications or churn. Hold back too much, and the system misses opportunities to re-engage them. The balance between the two is modeled using causal inference and adaptive scoring.

The system uses a causal modeling approach to weigh outcomes:

- Positive outcomes include increased activity such as clicking the notification, browsing the app, and interacting with content.

- Negative outcomes include signs of churn (long gaps in usage) or outright disabling of push notifications.

Often, basic correlation (for example, “this user got 5 notifications and stayed active”) doesn’t reveal the whole picture. Instead, the system uses past user behavior to estimate how different notification volumes affect outcomes such as staying active versus dropping off. This approach, known as causal modeling, helps avoid overfitting to noisy engagement data. It doesn’t just look at what happened, but tries to estimate what would have happened under different conditions.

To do this effectively, the team builds unbiased datasets by intentionally varying notification volumes across different user groups. These variations are used to estimate treatment effects and how different budgets affect long-term engagement patterns.

At the start of each day, a multi-model ensemble estimates several candidate budgets for a user. Each model simulates outcomes under different conditions: some more conservative, some more aggressive.

The system then selects the budget that optimizes a final engagement score. That score reflects both expected gains (clicks, sessions) and expected risks (disablement, drop-off). If the models indicate that an extra PN would yield a meaningful value, the budget is increased up to that point. If not, the system holds the line. The result is a dynamic, per-user push strategy that reflects actual behavioral data.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!-4lZ!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F568e3c0b-0afe-47e9-b678-c8dab8678ab1_1488x1600.png)](https://substackcdn.com/image/fetch/$s_!-4lZ!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F568e3c0b-0afe-47e9-b678-c8dab8678ab1_1488x1600.png)

## **Retrieval**

Before a notification can be ranked or sent, the system needs a shortlist of candidate posts worth considering. That’s the job of the retrieval stage.

This stage scans Reddit’s firehose of daily content and narrows it down to a few hundred posts that might interest a specific user.

This step has to be fast and efficient. Ranking every new post with a heavy ML model would be ideal in theory, but in practice, it’s computationally impossible. Reddit sees millions of posts per day, and latency budgets for notification generation are tight.

To stay within those constraints, the system relies on a mix of rule-based and model-based retrieval methods. These techniques are lightweight by design, offering high recall without doing deep computation. The goal is to cast a wide net and keep promising candidates without overloading the pipeline.

The simplest signal of user interest is subreddit subscriptions. If someone subscribes to “r/AskHistorians” and “r/MechanicalKeyboards”, there’s a good chance they want to hear about new posts from those communities.

Here’s how this method works:

- List the user’s subscribed subreddits.

- Apply subreddit-level filters, such as removing NSFW communities that don’t belong in notifications.

- Pick the top X subreddits based on engagement or recency of interaction.

- For each subreddit, select the top Y posts from the last few days using a heuristic score that blends upvotes, downvotes, and post age.

- Filter out posts the user has already seen.

- Use round-robin selection to pull from multiple subreddits, ensuring that one active community doesn’t dominate the list.

This rule-based method is fast and transparent. But it’s also limited. Subscriptions don’t capture every user’s evolving interests, and not all posts in a subreddit are equally relevant.

### **Model-Based Retrieval: Two-Tower Architecture**

To go beyond simple heuristics, the system uses two-tower models: a standard technique in large-scale recommendation systems.

One tower learns to represent users while the other learns to represent posts. Both output embeddings are fixed-length vectors that capture user and content characteristics.

The model is trained using historical PN click data. If a user clicked on a post in the past, the model learns to place that user and post closer together in the embedding space.

At runtime, the process looks like this:

- Post embeddings are precomputed and indexed. This saves time during notification generation since posts are expensive to encode.

- User embedding is computed on the fly using their recent behavior and metadata.

- The system performs a nearest-neighbor search between the user vector and the precomputed post vectors to find the closest matches. These are the posts the model believes the user is most likely to click.

After this step, the candidate list undergoes a final pass of filtering to remove stale or already-viewed content. The result is a highly personalized set of posts that’s both fresh and computationally cheap to obtain.

## **Ranking**

Once the retrieval stage returns a set of potentially interesting posts, the ranking model steps in to decide which ones are worth sending as a push notification.

This is the most compute-heavy part of the pipeline and predicts how likely a user is to engage with each candidate.

The ranking system uses a deep neural network (DNN) that takes in hundreds of signals and outputs a predicted likelihood of user engagement. But engagement means different things: clicking a notification, upvoting a post, or leaving a comment.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!H9pP!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F31407c61-393a-4211-a078-162e114d90f7_1440x1600.png)](https://substackcdn.com/image/fetch/$s_!H9pP!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F31407c61-393a-4211-a078-162e114d90f7_1440x1600.png)

To handle this, the model uses a structure called multi-task learning (MTL). In MTL, the model doesn’t just optimize for a single outcome. It learns to predict multiple behaviors at once:

- **P(click):** probability that the user clicks the notification

- **P(upvote):** probability the user upvotes the post

- **P(comment):** probability that the user leaves a comment

These predictions feed into a final score using a weighted formula:

```Plain
Final Score = Wclick * P(click) + Wupvote * P(upvote) + ... + Wdownvote * P(downvote)
```

Source: [Reddit Engineering Blog](https://www.reddit.com/r/RedditEng/comments/1kqjhwf/an_indepth_look_at_the_notifications_recommender/)

The weights (Wclick, Wupvote, etc.) let the team tune the model’s priorities. For example, some users might care more about discussion-heavy posts (comments), while others are more likely to interact with high-quality content (upvotes). Adjusting these weights allows the system to steer the output based on what matters most for engagement.

The neural network is structured in two parts:

- Shared layers at the beginning that process all the input features (user profile, post metadata, time of day, etc.) into a common representation.

- Task-specific heads at the end that specialize in predicting each target (click, comment, upvote, etc.).

This architecture allows the model to generalize well across behaviors while still optimizing for the nuances of each interaction type.

One of the subtler challenges in large-scale ML systems is train-serve skew. This is the mismatch between how data looks during training and what the model sees in production.

Reddit handles this by using prediction logs: the system records all the features passed into the model at the moment it served a notification, along with the actual outcome (clicked, ignored, etc.).

This approach brings several benefits:

- Accurate feedback for training, grounded in real serving conditions.

- Faster iteration on new features. No need to wait weeks to collect data.

- Improved observability into how the model behaves in production.

## **Reranking**

Even after the ranking model has scored each post (candidate), the job isn’t quite done. The top-ranked result might be statistically relevant, but that doesn’t always mean it’s the right choice to send.

That’s where reranking comes in. It is a final layer that adjusts the ranked list based on product strategy, UX goals, and business logic.

Machine learning models optimize for historical patterns. However, product goals often evolve faster than models can retrain. For instance, a model might consistently surface high-engagement posts from one very active subreddit because that’s what the user clicked on last week. But sending similar notifications every day creates fatigue or makes the system feel one-dimensional.

This is where reranking helps. Think of reranking as the system’s way of applying editorial judgment on top of raw model output. It doesn’t override the model entirely, but it nudges the final result in ways that reflect what Reddit wants the user experience to look and feel like.

Some strategies that are used in this phase are as follows:

- Boost subscribed content over generic posts. Even if a non-subscribed post scores slightly higher, the system often favors personalized content rooted in the user’s chosen communities.

- Enforce diversity. Prevent multiple posts from the same subreddit or similar topics from crowding out the experience. This avoids repetition and keeps recommendations feeling fresh.

- Personalize content-type emphasis. If a user has a history of engaging with discussion threads, the system can boost posts with active comment sections—even if those posts weren’t top-ranked originally.

The team is also experimenting with dynamic weight adjustment, where boosts and priorities adapt in real time. These adjustments draw from UX research and behavior modeling. For example:

- If a user rarely upvotes but frequently comments, it might be a good idea to prioritize like-heavy posts and conversation starters.

- If a user is exploring new topics outside their usual subscriptions, slightly boost non-subscribed but semantically relevant posts.

This dynamic reranking approach allows the system to respond to intent, not just history, and improve relevance.

## **Conclusion**

Building a high-quality notifications system isn’t just about pushing notifications. It also requires understanding when to stay silent.

Reddit’s notification pipeline handles this balance through a carefully staged system: budgeters control volume, retrieval systems narrow the field, ranking models score intent, and reranking layers apply product nuance. Each stage works in real time, under heavy load, across millions of users and posts.

But the system is far from static.

Future work focuses on making recommendations more responsive to changing user habits, improving experiences for low-signal users, and integrating signals across Reddit surfaces like Search and Feed. Dynamic reranking and real-time learning will play a bigger role in steering relevance without relying on hardcoded rules.

**References:**

- [An In-Depth Look at the Notifications Recommender System](https://www.reddit.com/r/RedditEng/comments/1kqjhwf/an_indepth_look_at_the_notifications_recommender/)

- [Deep Learning](https://en.wikipedia.org/wiki/Deep_learning)

- [Neural Networks](https://en.wikipedia.org/wiki/Neural_network_\(machine_learning\))