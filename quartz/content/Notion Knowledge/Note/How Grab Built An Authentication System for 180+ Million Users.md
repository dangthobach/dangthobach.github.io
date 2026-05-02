---
Created by: Bách Đặng Thọ
Created time: 2025-09-09T00:49
---
_Disclaimer: The details in this post have been derived from the official documentation shared online by the Grab Engineering Team. All credit for the technical details goes to the Grab Engineering Team.  The links to the original articles and sources are present in the references section at the end of the post. We’ve attempted to analyze the details and provide our input about them. If you find any inaccuracies or omissions, please leave a comment, and we will do our best to fix them._

Grab is a superapp, operating in more than 800 cities across eight countries. Through a single app, it offers ride-hailing, food and grocery delivery, payments, financial services, and logistics, making it a core part of everyday life for millions of people in the region. To support all these services, Grab also builds many internal applications used by its employees and business teams.

To make these apps secure, two things are important:

- **Authentication:** making sure the person is really who they say they are.

- **Authorization:** deciding what that person is allowed to do once logged in.

The problem was that Grab didn’t have a single, unified way of handling this.

Different apps were using different systems. For example, some used Google’s OAuth2.0 in a custom way, while others relied on outside tools like Databricks or Datadog that had their own login methods.

This led to a messy situation:

- Employees had to juggle multiple accounts and passwords.

- The user experience was clunky and inconsistent.

- It created extra work for administrators who had to manage all these separate identities.

- Security wasn’t uniform across the organisation.

So, Grab decided they needed one central system that would make authentication and authorization the same across all applications. This would simplify the process, improve security, and make things smoother both for users and for administrators.

Source: [Grab Engineering Blog](https://engineering.grab.com/dex-in-action)

[![](https://substackcdn.com/image/fetch/$s_!YJat!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F82d0e8da-b2ce-4d08-a771-2570d1298403_1464x1600.png)](https://substackcdn.com/image/fetch/$s_!YJat!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F82d0e8da-b2ce-4d08-a771-2570d1298403_1464x1600.png)

## **Existing Solution - Concedo**

Before moving to a new approach, Grab had already built its own internal system called Concedo.

The idea behind Concedo was to make life easier for developers so they didn’t have to build authentication and authorization features from scratch every time they created a new service.

Concedo worked using something called a Role-to-Permission Matrix (R2PM). This basically means every role in the company (like “engineer,” “manager,” or “analyst”) is mapped to specific permissions (what actions they can or cannot do). For example, a manager might have permission to view financial reports, while an analyst might not.

This setup allowed services at Grab to plug into Concedo quickly and enforce access rules consistently. Developers could focus on building their actual applications instead of worrying about identity and access management.

However, there was a catch: Concedo’s authentication was built on Google OAuth2.0, but with custom changes. These tweaks worked fine inside Grab but made it difficult to integrate with external platforms like Databricks or Datadog, which expected the standard version. That meant users still had a fragmented sign-in experience whenever they needed to use third-party tools.

## **Evaluation of Industry Standards**

When Grab looked for a standard way to fix its messy authentication setup, the team compared a few industry protocols that are widely used for login and access control.

- **SAML (Security Assertion Markup Language):** This is an older system that works mainly with web apps. It uses browser cookies to keep track of your login. It handles authentication (proving who you are), but not much beyond that.

- **OAuth 2.0:** This one is more about authorization, granting apps limited access to your data without giving them your password. For example, when you log in to a site using your Google account and let it pull your profile picture, that’s OAuth 2.0 in action. But it doesn’t really confirm your full identity on its own.

- **OpenID Connect (OIDC):** This builds on top of OAuth 2.0 and adds identity verification. In other words, it doesn’t just say “this app can access your data,” it also says “this really is Alice, logged in through Google.” With OIDC, a person can log in once and get into many apps (known as Single Sign-On or SSO). It also works smoothly across mobile apps, APIs, and web apps.

Because of these advantages, Grab chose OIDC as its standard.

However, OIDC isn’t perfect. It depends on external identity providers (like Google or Microsoft). If one of them goes down, users might lose access. Also, if someone’s credentials are stolen, attackers could use them to access multiple systems at once. So, Grab had to think about mitigation strategies like fallback options and scoping tokens carefully to reduce the risks.

## **Adoption of Dex (Open Source)**

Once Grab decided to adopt OpenID Connect (OIDC) as its standard, the next question was around implementation.

Instead of building a whole new identity system from scratch, Grab looked into existing open-source projects. That’s when the team found Dex, a project under the Cloud Native Computing Foundation (CNCF).

Dex is a federated OpenID Connect (OIDC) provider. That means it acts like a bridge or middleman between Grab’s applications and various identity providers (IdPs) such as Google, Microsoft, or any other login system.

[![](https://substackcdn.com/image/fetch/$s_!k--U!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fc817ccfb-77b9-4059-a0a9-012b45e4765e_1600x927.png)](https://substackcdn.com/image/fetch/$s_!k--U!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fc817ccfb-77b9-4059-a0a9-012b45e4765e_1600x927.png)

Here’s how it works in practice:

- When a user or a machine tries to access an application, the request is redirected to Dex.

- Dex then talks to the configured IdP (say Google).

- Once the IdP verifies the user’s identity, Dex issues a standard OIDC token that the application can understand and trust.

- This token contains all the necessary identity and access information, so the app doesn’t need to worry about custom login logic.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!9nMO!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F7777ccc4-6392-4324-a74f-63547e29d384_1600x1053.png)](https://substackcdn.com/image/fetch/$s_!9nMO!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F7777ccc4-6392-4324-a74f-63547e29d384_1600x1053.png)

Dex was the right choice for Grab for the following reasons:

- **Single Sign-On (SSO):** Users only need to log in once, and Dex lets them access multiple applications without re-entering credentials.

- **Standardised tokens:** Dex issues OIDC-compliant tokens, which avoid the integration problems caused by Grab’s earlier custom OAuth tweaks.

- **Easy to add new IdPs:** If Grab wants to integrate a new identity provider in the future, Dex can handle it without requiring every single application to be changed.

- **Scalability:** Dex is built for cloud-native environments, making it suitable for Grab’s large-scale deployments across both internal and third-party apps.

- **Open-source contribution:** By using Dex, Grab benefits from community-driven improvements and can also contribute back to strengthen the ecosystem.

In short, Dex gave Grab exactly what they needed: a flexible, standardised, and scalable identity layer that sits neatly between their apps and multiple login systems, while also ensuring developers don’t need to reinvent authentication every time.

## **Key Features in Grab’s Dex Implementation**

The main features are as follows:

### **Token Delegation & Exchange**

In Grab’s systems, it’s common for one service (say Service A) to call another service (Service B). However, Service B needs to know who exactly is making the request to decide what’s allowed.

Traditionally, companies solve this using service accounts (sometimes called robot accounts). These are special accounts with high-level permissions that a service uses to “log in” to another service.

[![](https://substackcdn.com/image/fetch/$s_!3L3Q!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F7c4dcdd3-9853-42fe-b2a7-b97d233cd9ca_1999x1161.heic)](https://substackcdn.com/image/fetch/$s_!3L3Q!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F7c4dcdd3-9853-42fe-b2a7-b97d233cd9ca_1999x1161.heic)

However, there were a couple of problems with this:

- If a service account is compromised, attackers might gain broad access because these accounts usually have wide privileges.

- If Service A tries to pass along the user’s identity to Service B, it gets complicated and breaks the clean separation between authentication and business logic.

Dex introduces a smarter way called token exchange. Instead of using fixed service accounts, the following approach is used:

- When a user (such as Alice) logs into Service A, Dex gives Service A a valid token.

- Because Service A is a trusted peer, it’s authorised to mint a new token that is valid for both Service A and Service B. This is done using the token’s “aud” (audience) field, which now lists both services ("aud": "serviceA serviceB").

- Service B is configured to trust Service A as a token issuer.

- Service B accepts the minted token and processes Alice’s request.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!y5Yg!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F093e0656-04ac-49b1-a7f0-c9562dbed4f2_1999x1159.heic)](https://substackcdn.com/image/fetch/$s_!y5Yg!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F093e0656-04ac-49b1-a7f0-c9562dbed4f2_1999x1159.heic)

The benefits are as follows:

- Tokens are scoped tightly to specific services, reducing risk.

- There’s a clear audit trail showing which service minted which token.

- No need to hand out all-powerful service accounts.

- Cleaner separation of concerns: Service A doesn’t have to directly manage user-level permissions for Service B.

### **Kill Switch (IdP Failover)**

Another big issue with OIDC is its reliance on external identity providers (IdPs) like Google or Microsoft. If an IdP goes down, every service relying on it might be blocked from authenticating users, which could cause massive downtime.

Dex’s solution was a multi-IdP failover (a “kill switch”) that works as follows:

- Dex can be configured with multiple IdPs at once.

- If one IdP (say Google) has an outage, Dex can automatically switch to another IdP (say Microsoft).

- From the perspective of Grab’s applications, nothing changes — they continue to get valid OIDC tokens from Dex.

See the diagram below:

Source: [Grab Engineering Blog](https://engineering.grab.com/dex-in-action)

[![](https://substackcdn.com/image/fetch/$s_!PzVI!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F3866d154-9ac8-4238-bdd5-8f566ae8c587_1999x681.heic)](https://substackcdn.com/image/fetch/$s_!PzVI!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F3866d154-9ac8-4238-bdd5-8f566ae8c587_1999x681.heic)

This matters because of the following reasons:

- Ensures high availability of authentication across the company.

- Minimises disruption for users during third-party outages.

- Applications don’t need to be rewritten or updated to handle IdP failures — Dex handles it centrally.

This design provides Grab with resilience and reliability guarantees, which are crucial when authentication underpins everything from ride-hailing to financial services.

## **Conclusion**

Grab has already achieved a big milestone by unifying authentication through Dex, but the journey isn’t finished yet.

While users now enjoy a consistent and secure way of proving who they are, the question of what they are allowed to do (authorization) remains scattered and complicated across different systems. Today, each service may have its own way of defining permissions, managing roles, and enforcing rules, which leads to inefficiencies and even security gaps.

The next step is to build a unified authorization model on top of the solid identity foundation provided by Dex. This means bringing all policies together under a central framework, standardising how access control is handled across applications, and making it much simpler to manage user permissions. By consolidating the rules, Grab can reduce complexity for developers, provide a smoother experience for users, and strengthen overall security. The long-term vision is a seamless combination of identity and authorization, where logging in and accessing resources across Grab’s ecosystem feels effortless, reliable, and consistent.

In conclusion, the adoption of Dex has already transformed authentication at Grab, turning a fragmented experience into a unified one that works across both internal and external applications. By extending this approach to authorization, Grab is setting the stage for an even stronger and more secure access management system. This evolution will not only improve developer productivity and reduce administrative burden but also deliver a smoother, safer experience for every user across Grab’s wide range of services.

**References:**

- [Effortless enterprise authentication at Grab: Dex in Action](https://engineering.grab.com/dex-in-action)

- [What is OpenID Connect](https://openid.net/developers/how-connect-works/)