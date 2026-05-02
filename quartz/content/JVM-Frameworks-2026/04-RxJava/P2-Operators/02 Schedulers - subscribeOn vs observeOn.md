---
tags: [rxjava, schedulers, threading, subscribeon, observeon]
created: 2026-04-12
status: active
week: 22
phase: P2-Operators
framework: rxjava
---

# Schedulers — subscribeOn vs observeOn

## 📌 One-liner
> `subscribeOn` = thread nào THỰC THI source code. `observeOn` = thread nào NHẬN và XỬ LÝ kết quả. Nhầm lẫn hai cái này → blocking event loop hoặc performance problems.

---

## 🧠 Mental Model

```
subscribeOn(Schedulers.io())
    ↕ "Hãy chạy CODE TẠO RA data trên IO thread"

Observable.fromCallable(() -> dbQuery())  ← chạy ở đây
    .subscribeOn(Schedulers.io())         ← trên IO thread
    .map(data -> process(data))           ← VẪN trên IO thread (không đổi)
    .observeOn(Schedulers.computation())  ← CHỈ TỪ ĐÂY TRỞ ĐI mới đổi thread
    .map(data -> transform(data))         ← trên computation thread
    .observeOn(AndroidSchedulers.mainThread()) ← đổi sang UI thread
    .subscribe(result -> updateUI(result))     ← trên main thread
```

> [!tip] Key Rule
> - `subscribeOn`: Chỉ cái **đầu tiên** có tác dụng, có thể đặt bất kỳ đâu trong chain
> - `observeOn`: Có tác dụng từ điểm đặt **trở xuống**, có thể dùng nhiều lần để switch thread

---

## 📋 Schedulers — Chọn cái nào?

| Scheduler | Dùng cho | Thread pool | Spring equivalent |
|-----------|---------|-------------|-------------------|
| `Schedulers.io()` | Blocking I/O: DB, HTTP, file | Unbounded cached pool | `@Async` với I/O executor |
| `Schedulers.computation()` | CPU-bound: parse, transform, encrypt | Fixed: CPU cores | `@Async` với CPU executor |
| `Schedulers.newThread()` | Mỗi task 1 thread mới | Không pool | `new Thread()` |
| `Schedulers.single()` | Sequential execution | 1 thread | `@Async` single-threaded |
| `Schedulers.trampoline()` | Queue on current thread | Current thread | Synchronous |
| `Schedulers.from(executor)` | Custom thread pool | Custom | Custom `TaskExecutor` |

---

## 💻 Common Patterns

### Pattern 1: Blocking I/O → Async Processing
```java
// DB query (blocking) → transform (CPU) → subscribe
Observable.fromCallable(() -> {
        // Blocking DB query — PHẢI trên io() thread!
        return documentRepo.findAll();  // JDBC blocking call
    })
    .subscribeOn(Schedulers.io())            // ← DB query chạy ở đây
    .map(docs -> docs.stream()               // CPU transform
        .map(DocumentDTO::from)
        .collect(Collectors.toList()))
    .observeOn(Schedulers.computation())     // ← (optional) explicit CPU thread
    .subscribe(
        dtos -> processResults(dtos),        // trên computation thread
        err  -> log.error("Error", err)
    );
```

### Pattern 2: Parallel Execution
```java
// Fetch 3 services song song, wait for all
Observable<User>    userObs    = fetchUser(userId).subscribeOn(Schedulers.io());
Observable<Account> accountObs = fetchAccount(userId).subscribeOn(Schedulers.io());
Observable<Orders>  ordersObs  = fetchOrders(userId).subscribeOn(Schedulers.io());

Observable.zip(userObs, accountObs, ordersObs,
    (user, account, orders) -> new UserProfile(user, account, orders))
    .subscribe(profile -> log.info("Profile: {}", profile));
// Cả 3 HTTP calls chạy song song, zip chờ tất cả done
```

### Pattern 3: Multiple observeOn Switches
```java
Observable.fromCallable(() -> readFromDisk())    // IO thread
    .subscribeOn(Schedulers.io())

    .map(raw -> parseJson(raw))                   // vẫn IO thread
    .observeOn(Schedulers.computation())          // switch → CPU

    .map(data -> heavyTransform(data))            // CPU thread
    .filter(data -> data.isValid())               // CPU thread

    .observeOn(Schedulers.from(customExecutor))   // switch → custom
    .subscribe(data -> saveResult(data));          // custom thread
```

---

## ⚠️ Common Mistakes

> [!warning] Mistake 1: Chạy blocking code mà không subscribeOn
> ```java
> // ❌ Sai — dbQuery() chạy trên thread gọi subscribe() (có thể là main thread!)
> Observable.fromCallable(() -> dbQuery())
>     .subscribe(data -> process(data));
>
> // ✅ Đúng
> Observable.fromCallable(() -> dbQuery())
>     .subscribeOn(Schedulers.io())
>     .subscribe(data -> process(data));
> ```

> [!warning] Mistake 2: Nghĩ nhiều subscribeOn có tác dụng
> ```java
> // ❌ Chỉ subscribeOn ĐẦU TIÊN có tác dụng
> Observable.fromCallable(() -> task())
>     .subscribeOn(Schedulers.io())          // ← cái này có tác dụng
>     .map(x -> transform(x))
>     .subscribeOn(Schedulers.computation()) // ← cái này bị IGNORE
>     .subscribe(x -> process(x));
> ```

> [!warning] Mistake 3: Quên observeOn trước UI update (Android)
> ```java
> // ❌ Crash: updating UI from non-main thread
> fetchData()
>     .subscribeOn(Schedulers.io())
>     .subscribe(data -> textView.setText(data));  // ❌ wrong thread!
>
> // ✅ Đúng
> fetchData()
>     .subscribeOn(Schedulers.io())
>     .observeOn(AndroidSchedulers.mainThread())   // switch về main
>     .subscribe(data -> textView.setText(data));   // ✅ main thread
> ```

---

## 🔧 Custom Scheduler từ Spring ThreadPoolTaskExecutor

```java
// Dùng lại Spring's thread pool trong RxJava
@Bean
public Scheduler rxScheduler(ThreadPoolTaskExecutor taskExecutor) {
    return Schedulers.from(taskExecutor.getThreadPoolExecutor());
}

// Inject và dùng
@Inject
Scheduler rxScheduler;

Observable.fromCallable(() -> heavyOperation())
    .subscribeOn(rxScheduler)  // dùng Spring's pool
    .subscribe(result -> log.info("Result: {}", result));
```

---

## 📊 Thread Timeline Visualization

```
Thread timeline cho:
Observable.fromCallable(() → DB_QUERY)
    .subscribeOn(io)
    .map(PARSE)
    .observeOn(computation)
    .map(TRANSFORM)
    .subscribe(CONSUME)

Main thread:  ──[subscribe()]──────────────────────────────────────────▶
IO thread:          ──[DB_QUERY]──[PARSE]──────────────────────────────▶
Computation:                             ──[TRANSFORM]──[CONSUME]───────▶
                                         ↑ observeOn switches here
```

---

## ✅ Practice Checklist
- [ ] Viết example: blocking DB call trên Schedulers.io()
- [ ] Parallel fetch 3 APIs với zip + subscribeOn per observable
- [ ] Dùng observeOn để switch sang Schedulers.computation() cho transform
- [ ] Verify threads với `Thread.currentThread().getName()` trong doOnNext()

## 🔗 Liên quan
- [[01 Core Operators]]
- [[../P3-Advanced/01 Backpressure Strategy]]

## 📖 Nguồn
- https://reactivex.io/documentation/scheduler.html
- https://github.com/ReactiveX/RxJava/wiki/Scheduler
