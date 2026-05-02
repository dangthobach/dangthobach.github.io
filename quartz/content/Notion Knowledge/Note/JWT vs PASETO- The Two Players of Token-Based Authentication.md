---
Created by: Bách Đặng Thọ
Created time: 2025-08-30T23:43
---
Token-based authentication has become quite popular over the years. Traditionally, JWTs have dominated this space.

[![](https://substackcdn.com/image/fetch/$s_!AtAK!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fd9e3b136-68f2-4033-8107-c693e2369115_2360x2952.jpeg)](https://substackcdn.com/image/fetch/$s_!AtAK!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fd9e3b136-68f2-4033-8107-c693e2369115_2360x2952.jpeg)

But now, a new player is making waves: PASETO, or Platform-Agnostic Security Tokens.

So, what’s the difference between the two?

1. JWTs
    
    JWT or JSON Web Tokens is an open standard for securely transmitting information between two parties.
    
    A JWT consists of a Header, Payload, and Signature.
    
    JWTs can be used to implement stateless authentication between client and server applications.
    

1. PASETO
    
    PASETO is a modern alternative to JWT. It addresses JWT's security flaws by implementing secure defaults.
    
    Unlike JWT, PASETO enforces strong, cryptographically sound algorithms, reducing the risk of vulnerabilities.
    
    A PASETO typically consists of Version, Purpose, and Payload. There are two types of PASETO:
    
    - Public PASETO: They are signed using asymmetric cryptography and ensure the integrity of the data, but not its confidentiality.
    
    - Local PASETO: They are encrypted using symmetric encryption algorithms, ensuring the confidentiality of the data contained within the token.