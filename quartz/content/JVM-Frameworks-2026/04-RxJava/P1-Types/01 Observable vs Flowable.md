---
tags: [rxjava, observable, flowable, backpressure]
created: 2026-04-12
status: active
week: 21
phase: P1-Types
framework: rxjava
---

# Observable vs Flowable

## 📌 One-liner
> `Observable<T>` = stream không có backpressure (producer nhanh tuỳ thích). `Flowable<T>` = stream có backpressure (consumer kiểm soát tốc độ producer). Chọn sai → `MissingBackpressureException`.

---

## 🧠 Backpressure — Vấn đề là gì?

```
Observable (không backpressure):

Producer ────────────────────────────────────────────────→  tốc độ 1M items/s
Consumer ─────────────────────→                             tốc độ 100 items/s
                               ↑
                        Buffer tràn → OutOfMemoryError!

Flowable (có backpressure):

Producer ────→                                              tốc độ adaptive
Consumer ─────────────────────→  "Cho tôi 128 items"       tốc độ 100 items/s
Producer đáp ứng đúng 128 items → không overflow!
```

---

## 🆚 Khi nào dùng Observable vs Flowable?

| Dùng Observable khi... | Dùng Flowable khi... |
|------------------------|----------------------|
| GUI events (click, touch) | Database queries lớn |
| Short streams (< 1000 items) | Network streams |
| Sync transformations | File I/O |
| Hot observables (real-time) | Kafka consumer streams |
| Cold + small dataset | Producer >> Consumer speed |

> [!tip] Rule of thumb 2026
> Default → `Observable`. Khi thấy `MissingBackpressureException` hoặc biết trước data source lớn → chuyển sang `Flowable`.

---

## 💻 Observable — Tạo và Subscribe

```java
// === Cold Observable (lazy — chỉ chạy khi subscribe) ===
Observable<String> cold = Observable.create(emitter -> {
    emitter.onNext("A");
    emitter.onNext("B");
    emitter.onNext("C");
    emitter.onComplete();
});

// === Hot Observable (chạy dù có subscriber hay không) ===
PublishSubject<String> hot = PublishSubject.create();
hot.onNext("Before subscribe");  // Subscriber sẽ KHÔNG nhận cái này

Disposable d = hot.subscribe(
    item -> log.info("Got: {}", item),
    err  -> log.error("Error", err),
    ()   -> log.info("Complete")
);

hot.onNext("After subscribe");   // Subscriber NHẬN được cái này
hot.onComplete();

// === From collections ===
Observable<User> fromList = Observable.fromIterable(userList);
Observable<Long>  timer   = Observable.interval(1, TimeUnit.SECONDS);  // hot!
Observable<Long>  range   = Observable.range(1, 1000).map(Long::valueOf);
```

---

## 💻 Flowable — Backpressure Strategies

```java
// BackpressureStrategy.BUFFER — buffer tất cả (cẩn thận OOM!)
Flowable<Event> buffered = Flowable.create(emitter -> {
    // produce fast
    for (int i = 0; i < 1_000_000; i++) {
        emitter.onNext(new Event(i));
    }
    emitter.onComplete();
}, BackpressureStrategy.BUFFER);

// BackpressureStrategy.DROP — drop items nếu downstream chưa ready
Flowable<Event> dropped = Flowable.create(emitter -> {
    // Fast producer...
}, BackpressureStrategy.DROP);

// BackpressureStrategy.LATEST — chỉ giữ item mới nhất
Flowable<SensorReading> latestOnly = Flowable.create(emitter -> {
    // Sensor readings — chỉ cần giá trị mới nhất
}, BackpressureStrategy.LATEST);

// BackpressureStrategy.ERROR — throw MissingBackpressureException ngay
Flowable<Event> strict = Flowable.create(emitter -> {
    // ...
}, BackpressureStrategy.ERROR);

// === Từ Observable sang Flowable ===
Observable<User> obs = Observable.fromIterable(largeUserList);
Flowable<User>  flow = obs.toFlowable(BackpressureStrategy.BUFFER);

// === Subscribe Flowable với request control ===
flow.subscribe(new Subscriber<User>() {
    private Subscription subscription;

    @Override
    public void onSubscribe(Subscription s) {
        this.subscription = s;
        s.request(10);  // Request 10 items từ producer
    }

    @Override
    public void onNext(User user) {
        process(user);
        subscription.request(1);  // Xin thêm 1 item sau khi xử lý xong
    }

    @Override public void onError(Throwable t) { log.error("Error", t); }
    @Override public void onComplete() { log.info("Done!"); }
});
```

---

## 🔧 Flowable cho Database Streaming

```java
// Stream large dataset từ DB — không load tất cả vào RAM
public Flowable<Document> streamAllDocuments() {
    return Flowable.create(emitter -> {
        try (Stream<Document> dbStream = documentRepo.streamAll()) {
            dbStream.forEach(emitter::onNext);
            emitter.onComplete();
        } catch (Exception e) {
            emitter.onError(e);
        }
    }, BackpressureStrategy.BUFFER)
    .subscribeOn(Schedulers.io())
    .observeOn(Schedulers.computation());
}

// Consumer dùng Flowable
streamAllDocuments()
    .filter(doc -> doc.getStatus().equals("ACTIVE"))
    .map(DocumentDTO::from)
    .buffer(100)                           // batch 100 items
    .subscribe(batch -> processBatch(batch),
               err   -> log.error("Stream error", err));
```

---

## 📊 Visual: Hot vs Cold

```
COLD Observable (mỗi subscriber nhận từ đầu):
  Source: ──1──2──3──4──5─|
  Sub A:  ──1──2──3──4──5─|  (subscribe t=0)
  Sub B:        ──1──2──3──4──5─|  (subscribe t=2, nhận lại từ đầu)

HOT Observable (subscriber nhận từ thời điểm subscribe):
  Source: ──1──2──3──4──5─|
  Sub A:  ──1──2──3──4──5─|  (subscribe t=0)
  Sub B:        ──3──4──5─|  (subscribe t=2, miss 1 và 2)
```

---

## ✅ Practice Checklist
- [ ] Tạo cold Observable, subscribe 2 lần → thấy mỗi subscriber nhận từ đầu
- [ ] Tạo hot PublishSubject, subscribe muộn → miss items
- [ ] Reproduce `MissingBackpressureException` với Observable nhanh + slow subscriber
- [ ] Fix bằng Flowable + BackpressureStrategy.DROP
- [ ] Stream 100K records từ DB bằng Flowable

## 🔗 Liên quan
- [[02 Single, Maybe, Completable]]
- [[../P2-Operators/01 Core Operators]]
- [[../../01-Quarkus/P3-Reactive/01 Mutiny - Uni và Multi]]

## 📖 Nguồn
- https://reactivex.io/documentation/observable.html
- https://github.com/ReactiveX/RxJava/wiki/Backpressure-(2.0)
