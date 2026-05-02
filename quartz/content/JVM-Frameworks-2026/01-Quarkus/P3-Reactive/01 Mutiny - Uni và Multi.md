---
tags: [quarkus, mutiny, reactive, uni, multi, reactor-comparison]
created: 2026-04-12
status: active
week: 5
phase: P3-Reactive
framework: quarkus
---

# Mutiny — Uni\<T\> và Multi\<T\>

## 📌 One-liner
> Mutiny là reactive library của Quarkus — `Uni<T>` = async 0-1 item (giống Mono), `Multi<T>` = async stream (giống Flux), nhưng API được thiết kế **readable hơn** với builder-style chaining.

---

## 🆚 Mutiny vs Project Reactor

| | Project Reactor | Mutiny |
|--|----------------|--------|
| Single value | `Mono<T>` | `Uni<T>` |
| Stream | `Flux<T>` | `Multi<T>` |
| Empty | `Mono.empty()` | `Uni.createFrom().nullItem()` |
| Transform | `.map()` | `.onItem().transform()` |
| Async map | `.flatMap()` | `.onItem().transformToUni()` |
| Error handle | `.onErrorReturn()` | `.onFailure().recoverWithItem()` |
| Subscribe | `.subscribe()` | `.subscribe().with()` |
| Logging | `.log()` | `.log()` |

> [!tip] Tại sao Mutiny khác Reactor?
> Mutiny thiết kế API để **tránh nhầm lẫn** flatMap/concatMap. Thay vào đó dùng explicit builders:
> `onItem().transformToUni()` = flatMap
> `onItem().transformToMulti()` = flatMapMany

---

## 💻 Uni — Async Single Value

```java
// === TẠO Uni ===

// Từ giá trị có sẵn
Uni<String> hello = Uni.createFrom().item("Hello");

// Từ callable (lazy — chỉ chạy khi subscribe)
Uni<User> userUni = Uni.createFrom().callable(() -> userRepo.findById(id));

// Từ CompletableFuture
Uni<String> fromFuture = Uni.createFrom().completionStage(
    CompletableFuture.supplyAsync(() -> "result")
);

// Failure
Uni<User> failed = Uni.createFrom().failure(new NotFoundException("User not found"));

// === TRANSFORM Uni ===

Uni<UserDTO> result = userUni
    .onItem().transform(user -> new UserDTO(user))        // sync map
    .onItem().transformToUni(dto -> enrichAsync(dto))     // async flatMap
    .onFailure().recoverWithItem(new UserDTO())            // fallback on error
    .onFailure(NotFoundException.class)
        .recoverWithNull();                                // null on specific error

// === SUBSCRIBE ===
result.subscribe().with(
    dto  -> log.info("Got: {}", dto),   // onItem
    err  -> log.error("Failed", err)    // onFailure
);
```

---

## 💻 Multi — Async Stream

```java
// === TẠO Multi ===

// Từ Iterable
Multi<String> items = Multi.createFrom().items("a", "b", "c");

// Từ range
Multi<Integer> numbers = Multi.createFrom().range(1, 100);

// Từ Publisher (reactive streams compatible)
Multi<Event> events = Multi.createFrom().publisher(kafkaPublisher);

// === OPERATORS ===

Multi<UserDTO> pipeline = Multi.createFrom().iterable(userList)
    .select().where(user -> user.active)                          // filter
    .onItem().transform(user -> new UserDTO(user))                // map
    .onItem().transformToUniAndMerge(dto -> enrichAsync(dto))     // flatMap
    .select().first(100)                                           // take(100)
    .onFailure().recoverWithCompletion();                          // empty on error

// Collect stream to list
Uni<List<UserDTO>> listResult = pipeline.collect().asList();

// === SUBSCRIBE ===
pipeline.subscribe().with(
    dto -> process(dto),          // onItem (called for each)
    err -> handleError(err),      // onFailure
    ()  -> log.info("Done!")      // onCompletion
);
```

---

## 🔧 Trong REST Endpoint

```java
@GET
@Path("/{id}")
public Uni<Response> getUser(@PathParam("id") Long id) {
    return userService.findById(id)
        .onItem().transform(user -> Response.ok(user).build())
        .onFailure(NotFoundException.class)
            .recoverWithItem(Response.status(404).build());
}

@GET
@Path("/stream")
@Produces(MediaType.SERVER_SENT_EVENTS)
public Multi<User> streamAllUsers() {
    return User.streamAll()
        .onItem().transform(entity -> (User) entity);
}
```

---

## 🔧 Combining Unis

```java
// Chạy 2 tasks SONG SONG (như Mono.zip trong Reactor)
Uni<User> userUni = userService.findById(userId);
Uni<Order> orderUni = orderService.findLatest(userId);

Uni<UserWithOrder> combined = Uni.combine()
    .all().unis(userUni, orderUni)
    .combinedWith((user, order) -> new UserWithOrder(user, order));

// Chạy tuần tự (like flatMap chain)
Uni<Receipt> sequential = userService.findById(userId)
    .onItem().transformToUni(user ->
        orderService.createOrder(user)
    )
    .onItem().transformToUni(order ->
        paymentService.charge(order)
    );
```

---

## 🔧 Schedulers (Thread Management)

```java
// Chạy blocking operation trên worker thread (tránh block event loop)
Uni<List<User>> fromDb = Uni.createFrom()
    .callable(() -> User.listAll())          // blocking DB call
    .runSubscriptionOn(Infrastructure.getDefaultWorkerPool());

// Hoặc dùng @Blocking annotation trên method
@GET
@Blocking  // ← Quarkus tự chuyển sang worker thread
public List<User> getAllBlocking() {
    return User.listAll();  // blocking call OK trong @Blocking context
}
```

> [!warning] QUAN TRỌNG: Reactive thread model
> Trong RESTEasy Reactive, endpoint **không được block** event loop thread.
> Nếu code blocking → dùng `@Blocking` annotation hoặc `.runSubscriptionOn(workerPool)`

---

## 📊 Marble Diagram — Mutiny Operators

```
Uni.createFrom().item(5)
    .onItem().transform(x → x * 2)
    ─────────────────────────────
    Input:  [5]
    Output: [10]

Multi.createFrom().range(1,5)
    .select().where(x → x % 2 == 0)
    ──────────────────────────────────
    Input:  1 ─ 2 ─ 3 ─ 4 ─ 5 ─|
    Output:     2 ─     4 ─   ─|

Multi.combine().uniMerge([uniA, uniB])
    ──────────────────────────────────
    uniA: ──── resultA ─|
    uniB: ─ resultB ─|
    output: ─ resultB ─── resultA ─|  (race, whoever finishes first)
```

---

## ✅ Practice Checklist
- [ ] Chuyển 1 REST endpoint từ blocking sang Uni return
- [ ] Implement parallel calls với `Uni.combine()`
- [ ] Thêm error recovery với `.onFailure().recoverWithItem()`
- [ ] Test `@Blocking` vs non-blocking performance
- [ ] Tạo SSE endpoint với Multi

## 🔗 Liên quan
- [[02 RESTEasy Reactive]] — integrate Mutiny với REST
- [[03 SmallRye Kafka]] — Mutiny trong Kafka consumer
- [[../../04-RxJava/00 RxJava Overview]] — so sánh với RxJava

## 📖 Nguồn
- https://smallrye.io/smallrye-mutiny/
- https://quarkus.io/guides/mutiny-primer
