---
tags: [rxjava, backpressure, flowable]
created: 2026-04-12
status: active
week: 23
phase: P3-Advanced
framework: rxjava
---

# Backpressure Strategy

## 📌 One-liner
> Backpressure là cơ chế để consumer kiểm soát tốc độ producer trong `Flowable` — tránh `OutOfMemoryError` khi producer nhanh hơn consumer. 4 strategies: BUFFER, DROP, LATEST, ERROR.

---

## 🧠 Tại sao cần Backpressure?

```
Vấn đề:
Producer: 1,000,000 items/giây ────────────────────▶ Buffer (RAM tràn!) → OOM
Consumer:       1,000 items/giây ────────────────────▶

Giải pháp — Flowable với BackpressureStrategy:
Producer:  ──→ [Strategy] ──→ Buffer (controlled) ──→ Consumer
           BUFFER: giữ tất cả (cẩn thận OOM)
           DROP:   bỏ qua khi buffer đầy
           LATEST: chỉ giữ item mới nhất
           ERROR:  throw exception ngay
```

---

## 💻 4 Strategies Chi Tiết

```java
// BUFFER — giữ mọi item, buffer tăng dynamic
// ✅ Dùng khi: producer burst ngắn, consumer sẽ kịp xử lý
// ❌ Tránh: producer liên tục nhanh hơn consumer → OOM
Flowable.create(emitter -> {
    for (long i = 0; i < 1_000_000; i++) emitter.onNext(i);
    emitter.onComplete();
}, BackpressureStrategy.BUFFER)
    .observeOn(Schedulers.computation())
    .subscribe(item -> Thread.sleep(1));  // slow consumer

// DROP — bỏ qua items khi downstream không ready
// ✅ Dùng khi: bỏ item cũ OK (real-time updates, sensor data)
// ❌ Tránh: mỗi item đều quan trọng (financial transactions)
Flowable.create(emitter -> {
    // Fast sensor data
}, BackpressureStrategy.DROP)
    .observeOn(Schedulers.io())
    .subscribe(reading -> processReading(reading));

// LATEST — chỉ giữ item MỚI NHẤT khi buffer đầy
// ✅ Dùng khi: chỉ cần trạng thái hiện tại (UI state, price feeds)
// ≈ conflate() trong Kotlin Channels
Flowable.create(emitter -> {
    // Price tick stream — only latest matters
}, BackpressureStrategy.LATEST)
    .subscribe(price -> updatePriceDisplay(price));

// ERROR — throw MissingBackpressureException ngay khi downstream chậm
// ✅ Dùng khi: develop/test, muốn biết ngay nếu có backpressure issue
// ❌ Production: cần strategy rõ ràng hơn
Flowable.create(emitter -> {
    // Fast producer
}, BackpressureStrategy.ERROR)
    .subscribe(
        item -> process(item),
        err  -> log.error("Backpressure detected: {}", err.getMessage())
    );
```

---

## 🔧 Flowable Operators cho Backpressure

```java
Flowable<Long> fastProducer = Flowable.interval(1, TimeUnit.MILLISECONDS);

// onBackpressureBuffer — explicit buffer với bounded size
fastProducer
    .onBackpressureBuffer(1000,                     // max 1000 items
                          () -> log.warn("Buffer overflow!"),
                          BackpressureOverflowStrategy.DROP_OLDEST)
    .observeOn(Schedulers.io())
    .subscribe(item -> slowProcess(item));

// onBackpressureDrop — drop items với notification
fastProducer
    .onBackpressureDrop(dropped -> log.warn("Dropped: {}", dropped))
    .observeOn(Schedulers.io())
    .subscribe(item -> process(item));

// onBackpressureLatest — keep only latest
fastProducer
    .onBackpressureLatest()
    .observeOn(Schedulers.computation())
    .subscribe(item -> updateUI(item));
```

---

## 🔧 Kafka Consumer với Flowable Backpressure

```java
// Kafka có natural backpressure — consumer poll rate kiểm soát throughput
public Flowable<ConsumerRecord<String, DocumentEvent>> kafkaStream() {
    return Flowable.create(emitter -> {
        KafkaConsumer<String, DocumentEvent> consumer = createConsumer();

        emitter.setDisposable(Disposable.fromRunnable(consumer::close));

        while (!emitter.isCancelled()) {
            ConsumerRecords<String, DocumentEvent> records =
                consumer.poll(Duration.ofMillis(100));

            for (ConsumerRecord<String, DocumentEvent> record : records) {
                if (emitter.isCancelled()) break;
                emitter.onNext(record);
            }
        }
    }, BackpressureStrategy.BUFFER)
    .subscribeOn(Schedulers.io());
}

// Consume với batching
kafkaStream()
    .buffer(100, 500, TimeUnit.MILLISECONDS)  // batch 100 items hoặc 500ms
    .flatMap(batch ->
        processBatch(batch).toFlowable(),
        4  // max 4 concurrent batches
    )
    .subscribe(
        result -> log.debug("Batch processed: {}", result),
        err    -> log.error("Stream error", err)
    );
```

---

## ✅ Practice Checklist
- [ ] Reproduce OOM với Observable + slow subscriber
- [ ] Fix với Flowable + BackpressureStrategy.DROP
- [ ] Implement bounded buffer với `onBackpressureBuffer(1000, ...)`
- [ ] Stream Kafka events với Flowable, apply backpressure

## 🔗 Liên quan
- [[01 Observable vs Flowable]]
- [[02 Testing với TestObserver]]

## 📖 Nguồn
- https://github.com/ReactiveX/RxJava/wiki/Backpressure-(2.0)
