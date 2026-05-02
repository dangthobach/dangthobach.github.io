---
Created by: Bách Đặng Thọ
Created time: 2025-09-25T02:01
tags:
  - Story
---
I’ve found my new favorite book on refactoring code. It’s “[Tidy First?](https://www.amazon.com/Tidy-First-Personal-Exercise-Empirical/dp/1098151240/)” by Kent Beck.

Kent Beck is a renowned figure in the software industry. One of Kent’s notable contributions is his role as a signatory of the Agile Manifesto that was created in 2001 and laid the foundation for the agile software development methodology.

Kent has also been a key figure in the industry’s rediscovery of test-driven development (TDD). TDD is a software development practice that emphasizes writing tests before writing the code.

Throughout his career, Kent has worked at several prominent companies, including Facebook, Apple Computer, and Gusto. In addition to his professional work, Kent is also an active writer. He publishes a newsletter titled “[Software Design: Tidy First?](https://tidyfirst.substack.com/bytebytego)” which explores various aspects of software design and development. For readers interested in subscribing, here is a [20% discount offer](https://tidyfirst.substack.com/bytebytego).

Recently, I had the opportunity to meet Kent and talk about his book “Tidy First”.

[![](https://substackcdn.com/image/fetch/$s_!ypji!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Ff6ea57ee-22dc-43a6-ada7-a4a60275e5d1_1200x1600.jpeg)](https://substackcdn.com/image/fetch/$s_!ypji!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Ff6ea57ee-22dc-43a6-ada7-a4a60275e5d1_1200x1600.jpeg)

## **Story of Tidy First**

I came to learn from Kent that the idea of the book Tidy First came to him around 19 years ago.

The seed of the book’s idea was planted in 2005 when Kent attended a panel discussion about the book “Structured Design” by Ed Yourdon and Larry Constantine. Despite being 30 years old at the time, this book remained the most relevant resource on software design, highlighting the lack of a modern equivalent that addressed the current practices and principles of building software systems.

This realization set Kent on the path to creating an up-to-date book that can guide developers on how modern software systems are or should be, built. However, there was a fundamental question: Can you effectively discuss modern design without first addressing the need to tidy up existing code?

Kent recognized that before modernizing a codebase, it is often necessary to clean up and organize the existing code to make it ready for change.

The title “Tidy First?” encapsulates this realization, which also resonates with developers who encounter legacy codebases. Should they prioritize tidying up the code before attempting to modify its functionality, or should they dive straight into making changes?

It’s a remarkably concise book, consisting of just 33 standalone chapters spanning over 100 pages.

Despite its brevity, however, the book is packed with substance. It offers a concise but polished presentation of ideas, ensuring the reader’s time is well-spent.

In a world where finding the time to finish a lengthy nonfiction book can be challenging, the ease with which one can read through “Tidy First?” is a welcome change.

The book’s structure follows a natural path, with chapters building upon one another. On a high level, the content is divided into three parts:

- **Tidyings**: This part presents simple but powerful ideas such as the importance of reading order, explaining constants, and using explicit parameters. Each chapter focuses on one design aspect that can help you handle messy code.

- **Managing:** This part offers ideas to integrate tidying into a development workflow. It helps you identify when you should start tidying code and when you should stop. Also, how should you manage the tidying-related activities with behavior changes to the code?

- **Theory:** The last part of the book focuses on exploring the reasons behind tidying the code. Also, it explains the tradeoffs between investing and not investing in improving the structure of the code.

[![](https://substackcdn.com/image/fetch/$s_!djPj!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fb9e76434-5699-479f-8731-c287002e1cd4_1600x881.png)](https://substackcdn.com/image/fetch/$s_!djPj!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fb9e76434-5699-479f-8731-c287002e1cd4_1600x881.png)

Let’s now look at one full chapter from the book.

---

## **Tidy First Chapter 26: Options**

_The below excerpt is from the book “Tidy First?” by Kent Beck. Copyright © 2024 Kent Beck. Published by O'Reilly Media, Inc. Used with permission._

The previous chapter modeled the economic value of a software system as the sum of the discounted future cash flows. We create value when we change those flows:

- Earning money more, sooner, and with greater likelihood

- Spending money less, later, and with less likelihood

Working inside this model as a software designer already isn’t easy. We live in a Goldilocks world: not too much design or too soon, not too little design or too late. But wait, there’s more. (If it was easy, everybody would already be doing it and there’d be no excuse for this book.) There’s another, sometimes conflicting, source of value: optionality.

Decades back I worked with trading software on Wall Street. I did the background reading, as I like to do, and discovered options pricing. Down the rabbit hole I went. I had recently invented test-driven development (TDD), and I was looking for practice topics. Options pricing seemed like a great example: complicated algorithm with known answers.

I implemented the extant options pricing formulas test first (discovering the need for an epsilon when comparing floating-point numbers in the process). Along the way I developed an intuition for options that started to leak out into my general thinking about software design.

I can’t implement all those algorithms for you, but I can report the lessons I learned (I encourage you to try the exercise if you really want to “get it”):

- “What behavior can I implement next?” has value all on its own, even before I implement it. This surprised me. I thought I was getting paid for what I had done (as per the previous chapter). I wasn’t. I was mostly getting paid for what I could do next.

- “What behavior can I implement next?” is more valuable the more behaviors are in the portfolio. If I can increase the size of the portfolio, I have created value.

- “What behavior can I implement next?” is more valuable the more the behaviors in that portfolio are valuable. I can’t predict which behavior will be most valuable, nor how valuable it will be, but...

- I don’t have to care which item will be most valuable, as long as I keep open the option of implementing it.

- (This is the best one.) The _more_ uncertain my predictions of value are, the _greater_ the value of the option is (versus just implementing it). If I embrace change, I maximize the value I create in exactly those situations where (then) conventional software development fails most spectacularly.

If you haven’t encountered financial options before, here is my quick primer.

Start out with a thing with a price. A potato for a dollar. I have a dollar. You have a potato. I give you the dollar. You give me the potato. Now I have a potato, but I don’t have the dollar. You have the dollar, but you don’t have the potato anymore.

Maybe I don’t want the potato now; I want it tomorrow. I’m sure will I want it tomorrow. I can give you a dollar today in return for your promise of a potato tomorrow. Tomorrow you deliver the potato, and we’re both happy. I’ll give you a little less than a dollar today, because of the time value of money.

What if I’m not sure if I want the potato tomorrow? I might have a picnic if the weather is good, in which case I’ll make potato salad. If the weather is bad, though, I don’t want to have bought a potato that will go to waste. In this case I can buy your promise of a potato tomorrow for a dollar tomorrow, but I might not hold you to that promise.

How much should I pay you for this “promise for a promise”? You’re going to get the dollar tomorrow, but only if I hold you to your promise to sell your potato to me. You need to know what else you’ll do with the potato if you can’t sell it to me tomorrow. If you have other good uses for the potato tomorrow, then you can sell me this option for pennies. You don’t much care if I buy it tomorrow or not. But if the potato is going to waste if I don’t buy it tomorrow, then you have to charge me pretty much full price today.

I have just described a call option—the right, but not obligation, to purchase something in the future at a fixed price. Financial options have these parameters:

- The _underlying_ thing that we can buy

- The _price_ of the underlying, including the volatility of that price

- The _premium_ of the option, or the price we pay today

- The _duration_ of the option, or how long we have to decide whether to purchase the underlying (some options let you buy the underlying anytime between now and the end of the duration, which is what software looks like)

What does this mean for software design? Software design is preparation for change; change of behavior. The behavior changes we _could_ make next are the potatoes from the story. Design we do today is the premium we pay for the “option” of “buying” the behavior change tomorrow.

Thinking of software design in terms of optionality turned my thinking upside-down. When I focused on balancing creating options and changing behavior, what used to scare me now excited me:

- The more volatile the value of a potential behavior change, the better.

- The longer I could develop, the better.

- Yes, the cheaper I could develop in future, the better, but that was a small proportion of the value.

- The less design work I could do to create an option, the better.But I was still faced with that tricky problem I breezed over by saying, “Balancing creating options and changing behavior.”

## **My Chat with Kent**

As mentioned earlier, I had the opportunity to chat with Kent about his book “Tidy First” and his views on modern software development. Here are some things that were discussed:

**I asked him about his inspiration behind writing “Tidy First?”.**

Here’s what Kent told me:

> I had spent a lot of time thinking about software design throughout my career, up to 2005. I love that feeling when the design is slightly wrong, and you're struggling with it, and then you have a moment of insight. If things were like this, then these features would be easy to implement. I love that moment. I could discuss it effectively if I was pairing with someone I worked with a lot. I've done a lot of work on patterns, which was an attempt to capture the design habits of experts. So it's always been a topic of interest to me. In 2005, I was on a panel with Ed Jordan and Larry Constantine. I reread their book "Structured Design," which introduced the terms coupling and cohesion. When I read the book, it felt like the heavens opened. I thought this was Newton's Laws of Motion for software development. These are the basic fundamental building blocks we're all working on top of. But that discussion is hopelessly dated. I wanted to restate what they said in "Structured Design" for a modern audience. It took me 18 years to figure out how to explain that stuff. Does that answer your question?

**I then asked him about what “Tidy First?” is really about.**

Here’s Kent describing the scope of the book in his own words:

> The first sentence I wrote was: "Software design is an exercise in human relationships." I thought, what does that mean? That's nuts. I want to talk about coupling and cohesion, power law distributions, NPV, and optionality. These are very technical topics. But the more I thought about it, the more I realized that software design is indeed an exercise in human relationships. All the technical expertise we work so hard to gain is useless if it's not put in service of the relationships around software development.

**When I quizzed him about his plans for future books in the series, Kent explained that “Tidy First?” is indeed the first book in the series.**

Here’s what Kent said about each book and what he plans to cover in the future:

> Yes, this is the first of three books. I wanted to get "Tidy First" out there to get people in the habit of distinguishing between changing the structure of the system and changing the behavior of the system. Programmers can be reluctant to change the design, even though we complain about technical debt all the time. I wanted to get people used to making this distinction. The next book is tentatively called "Tidy Together," focusing on design changes that affect other people's work. The third book will address the whole team scale, where different people have different interests like sales, customer service, and product strategy. The goal is to use superior software design skills to maintain those relationships.

Kent also mentioned the key takeaways he wanted the readers to have:

> Paying attention to software design as a relationship skill, separating behavior changes from structure changes, making large changes in small, safe steps, and understanding coupling and cohesion. Coupling means changing one element implies changing another, and cohesion means changes are contained within an element. There's also the economic perspective, where investing in design creates value through the portfolio of options for what the software can do next.

**Then, I asked Kent his top three book recommendations for software engineers.**

Kent mentioned some really interesting books:

> "The Timeless Way of Building" by Christopher Alexander, "Defeat Into Victory" by Field Marshal Viscount Slim, and "The Beleaguered City" by Shelby Foote. Alexander's book reimagines the relationship between architects and clients. Slim's book is inspiring for his leadership during World War II. Foote's book describes Ulysses S. Grant's Vicksburg campaign, showing determination and perseverance.

**In the end, I also picked Kent’s mind about how he viewed the rise of AI, the developers worrying about AI taking their jobs, and his suggestions on how to adopt AI.**

Here’s what Kent advised:

> Accept that the rules have changed, and nobody knows the new rules. Be in experimental mode and reduce the cost of experimentation. Try out crazy ideas and see what sticks. Don't automate tasks that are already easy. I love coding with Copilot because it reduces cognitive load. The key is to experiment and find new capabilities that make your work more efficient.

## **Takeaways**

You can get [“Tidy First?” from the publisher (O’Reilly)](https://www.oreilly.com/library/view/tidy-first/9781098151232/). Also, you can subscribe to [Kent’s newsletter with the same name](https://tidyfirst.substack.com/).

Having written the book “System Design Interview”, I know the effort it takes to put a book together. In fact, explaining something in fewer words is even more difficult.

In my view “Tidy First?” is a must-read for any software developer looking to write code that’s readable, concise, and effective. The book packs a tremendous amount of value in a concise manner that’s instantly applicable to your day-to-day work.

I hope you enjoyed this sneak peek into the book.