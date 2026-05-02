---
Created by: Bách Đặng Thọ
Created time: 2025-08-31T00:04
---
## **How Does SSO Work?**

Single Sign-On (SSO) is an authentication scheme. It allows a user to log in to different systems using a single ID.

[![](https://substackcdn.com/image/fetch/$s_!Jti2!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F4bf62d5c-e538-4fba-8d4f-aa00d0bd064a_3000x3900.png)](https://substackcdn.com/image/fetch/$s_!Jti2!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F4bf62d5c-e538-4fba-8d4f-aa00d0bd064a_3000x3900.png)

Let’s walk through a typical SSO login flow:

Step 1: A user accesses a protected resource on an application like Gmail, which is a Service Provider (SP).

Step 2: The Gmail server detects that the user is not logged in and redirects the browser to the company’s Identity Provider (IdP) with an authentication request.

Step 3: The browser sends the user to the IdP.

Step 4: The IdP shows the login page where the user enters their login credentials.

Step 5: The IdP creates a secure token and returns it to the browser. The IdP also creates a session for future access. The browser forwards the token to Gmail.

Step 6: Gmail validates the token to ensure it comes from the IdP.

Step 7: Gmail returns the protected resource to the browser based on what the user is allowed to access.

This completes the basic SSO login flow. Let’s see what happens when the user navigates to another SSO-integrated application, like Slack.

Step 8-9: The user accesses Slack, and the Slack server detects that the user is not logged in. It redirects the browser to the IdP with a new authentication request.

Step 10: The browser sends the user back to the IdP.

Step 11-13: Since the user has already logged in with the IdP, it skips the login process and instead creates a new token for Slack. The new token is sent to the browser, which forwards it to Slack.

Step 14-15: Slack validates the token and grants the user access accordingly.