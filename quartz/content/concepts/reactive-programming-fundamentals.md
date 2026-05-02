---
tags: [java, reactive, concurrency, evergreen]
aliases: [reactive-programming, reactive-streams, lập-trình-reactive]
created: 2026-04-13
status: evergreen
---

# Reactive Programming Fundamentals

## 📌 One-liner
> Reactive programming là mô hình lập trình xử lý **data streams bất đồng bộ** theo kiểu khai báo (declarative) — thay vì "pull data khi cần", bạn **subscribe vào stream** và react khi data đến.

---

## 🧠 Core Idea

Imperative (cách cũ):
```
Bước 1: Gọi DB → đợi → nhận List<User>
Bước 2: Gọi API → đợi → nhận Response
Bước 3: Xử lý → trả kết quả
→ Thread bị BLOCK ở mỗi bước "đợi"
```

Reactive (cách mới):
```
Subscribe vào stream User từ DB
   → khi có User → transform
   → khi có lỗi  → recover
   → khi xong    → complete
→ Thread KHÔNG bị block, xử lý event khi chúng xảy ra
```

### Observer Pattern là nền tảng

```
Publisher ──emit items──→ Subscriber
          ──emit error──→ Subscriber.onError()
          ──complete──→   Subscriber.onComplete()
```

Reactive chính là **Observer Pattern + async + backpressure + operators**.

---

## 🔁 Cross-Framework Analog

| Concept | Project Reactor (Spring) | Mutiny (Quarkus) | RxJava 3 | Vert.x |
|---------|--------------------------|------------------|----------|--------|
| 0–1 item async | `Mono<T>` | `Uni<T>` | `Single<T>` / `Maybe<T>` | `Future<T>` |
| 0–N stream | `Flux<T>` | `Multi<T>` | `Observable<T>` / `Flowable<T>` | `ReadStream<T>` |
| Empty signal | `Mono<Void>` | `Uni<Void>` | `Completable` | `Future<Void>` |
| Backpressure | Built-in `Flux` | Built-in `Multi` | `Flowable` (tách riêng) | Không built-in |

| | Java Imperative | Java Reactive |
|---|---|---|
| Mô hình | Pull (block & wait) | Push (subscribe & react) |
| Thread | 1 thread/request | Ít thread, event-driven |
| Error handling | try/catch | `.onError()` / `.onFailure()` |
| Composition | Gọi lồng nhau | Operator chain |
| Backpressure | Không có | Built-in (Flowable/Flux) |

---

## 💻 Imperative vs Reactive — Code So Sánh

```java
// IMPERATIVE — blocking, sequential
public UserProfile getProfile(Long userId) {
    User user    = userRepo.findById(userId);       // BLOCK: chờ DB
    Account acct = accountRepo.find(userId);        // BLOCK: chờ DB
    Orders orders = orderRepo.findByUser(userId);   // BLOCK: chờ DB
    return new UserProfile(user, acct, orders);     // tất cả xong rồi mới assemble
    // Total time = DB1 + DB2 + DB3 (sequential)
}

// REACTIVE — non-blocking, parallel
public Mono<UserProfile> getProfile(Long userId) {
    Mono<User>    userMono    = userRepo.findById(userId);    // khai báo, chưa chạy
    Mono<Account> accountMono = accountRepo.find(userId);
    Mono<Orders>  ordersMono  = orderRepo.findByUser(userId);

    return Mono.zip(userMono, accountMono, ordersMono)        // chạy SONG SONG
               .map(tuple -> new UserProfile(
                   tuple.getT1(), tuple.getT2(), tuple.getT3()
               ));
    // Total time = max(DB1, DB2, DB3) — nhanh hơn nhiều!
}
```

---

## 🌊 Reactive Streams Specification

Reactive Streams là Java **standard** (JSR-166) định nghĩa 4 interface:

```java
Publisher<T>   // produces items: subscribe(Subscriber)
Subscriber<T>  // consumes items: onNext(), onError(), onComplete()
Subscription   // controls flow: request(n), cancel()
Processor<T,R> // both Publisher + Subscriber
```

**Tất cả reactive libraries đều implement spec này:**
- Project Reactor (`Flux`/`Mono`) ✓
- RxJava 3 (`Flowable`) ✓
- Mutiny (qua bridge) ✓
- Vert.x (qua bridge) ✓

→ Có thể convert qua lại giữa các libraries vì cùng chuẩn.

---

## 💡 Khi nào dùng Reactive

✅ **Nên dùng:**
- I/O-bound services: nhiều DB calls, HTTP calls đồng thời
- Streaming data: SSE, WebSocket, Kafka consumer
- High-concurrency với ít thread (K8s pod với RAM giới hạn)
- Pipeline xử lý: transform → filter → aggregate → publish

❌ **Không nên dùng:**
- CPU-bound tasks (reactive không giúp gì ở đây, dùng thread pool)
- Simple CRUD với ít concurrent users (overhead không đáng)
- Team chưa quen reactive — learning curve cao, debug khó hơn
- Legacy code integration nặng nề (phải bridge blocking code)

---

## ⚠️ Pitfalls

> [!warning] Pitfall 1: Blocking trong reactive context
> ```java
> // ❌ Deadlock / thread starvation
> Mono.fromCallable(() -> {
>     Thread.sleep(5000);            // BLOCK event loop!
>     return jdbcTemplate.query(…);  // BLOCK event loop!
> }).subscribe(…);
>
> // ✅ Đúng: chạy blocking code trên separate thread pool
> Mono.fromCallable(() -> jdbcTemplate.query(…))
>     .subscribeOn(Schedulers.boundedElastic())
>     .subscribe(…);
> ```

> [!warning] Pitfall 2: "Nothing happens until you subscribe"
> ```java
> Mono<User> userMono = userRepo.findById(1L); // chưa chạy gì!
> // ... 100 dòng code sau ...
> userMono.subscribe(u -> log.info(u)); // chỉ đến đây mới thực sự chạy
> ```

> [!warning] Pitfall 3: Không handle error → silent failure
> ```java
> // ❌ Lỗi bị nuốt im
> userMono.subscribe(u -> process(u));
>
> // ✅ Luôn handle cả error path
> userMono.subscribe(
>     u   -> process(u),
>     err -> log.error("Failed", err)
> );
> ```

---

## 🔗 Liên quan
- [[JVM-Frameworks-2026/01-Quarkus/P3-Reactive/01 Mutiny - Uni và Multi|Mutiny — Uni và Multi]] — Reactive trong Quarkus
- [[JVM-Frameworks-2026/04-RxJava/P1-Types/01 Observable vs Flowable|Observable vs Flowable]] — RxJava types
- [[backpressure-explained]] — kiểm soát tốc độ trong reactive stream
- [[event-loop-model]] — runtime model bên dưới reactive
- [[_moc/MOC-Concurrency|MOC-Concurrency]] — threading context

## 📖 Nguồn
- https://www.reactive-streams.org — JSR spec
- https://projectreactor.io/learn — Project Reactor docs
- https://smallrye.io/smallrye-mutiny/guides — Mutiny concept guides
