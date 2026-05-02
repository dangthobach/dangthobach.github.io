---
tags: [java, reactive, rxjava, concurrency, evergreen]
aliases: [backpressure, flow-control, reactive-backpressure]
created: 2026-04-13
status: evergreen
---

# Backpressure Explained

## 📌 One-liner
> Backpressure là cơ chế để **consumer báo với producer** "tôi chỉ xử lý được N items/giây" — thay vì producer cứ emit thoải mái rồi consumer bị tràn bộ nhớ.

---

## 🧠 Core Idea

### Vấn đề: Producer nhanh hơn Consumer

```
Không có backpressure:

Producer: ████████████████████████  1,000,000 items/s
                    ↓ buffer tích lũy
Consumer: ████                      100 items/s

→ Buffer tăng → RAM hết → OutOfMemoryError
→ Hoặc buffer drop item → data loss
```

```
Có backpressure:

Consumer: "Tôi sẵn sàng nhận 100 items" ──request(100)──→ Producer
Producer: emit đúng 100 items ──────────────────────────→ Consumer
Consumer: xử lý xong ──────── "Cho thêm 100" ──────────→ Producer
Producer: emit thêm 100 ────────────────────────────────→ Consumer

→ Không tràn, không drop, flow controlled
```

### Analogy thực tế

```
Không backpressure = vòi nước mở hết cỡ đổ vào cốc nhỏ → tràn

Có backpressure   = vòi nước điều chỉnh lưu lượng khớp với cốc → vừa đủ
```

---

## 🔁 Backpressure trong các Frameworks

| Framework | Type có backpressure | Type không có | Strategy |
|-----------|---------------------|---------------|----------|
| RxJava 3 | `Flowable<T>` | `Observable<T>` | BUFFER / DROP / LATEST / ERROR |
| Project Reactor | `Flux<T>` (built-in) | `Mono<T>` (1 item, N/A) | `onBackpressureBuffer()` etc. |
| Mutiny (Quarkus) | `Multi<T>` (built-in) | `Uni<T>` (1 item, N/A) | `onOverflow()` |
| Vert.x | `Pipe<T>` | `ReadStream<T>` (manual) | `pause()` / `resume()` |
| Kafka | Protocol-level (consumer poll rate) | — | `max.poll.records`, `fetch.min.bytes` |

---

## 💻 4 Backpressure Strategies — RxJava (rõ ràng nhất)

```java
// ── BUFFER ── giữ tất cả, buffer tăng dynamic
// Dùng: producer burst ngắn hạn, consumer sẽ catch up được
Flowable.create(emitter -> {
    for (long i = 0; i < 1_000_000; i++) emitter.onNext(i);
    emitter.onComplete();
}, BackpressureStrategy.BUFFER)
    .observeOn(Schedulers.io())
    .subscribe(n -> slowProcess(n)); // consumer chậm → buffer tăng → cẩn thận OOM

// ── DROP ── bỏ item khi buffer đầy, không báo lỗi
// Dùng: real-time updates (sensor, metrics) — giá trị cũ không cần thiết
Flowable.create(emitter -> produceSensorData(emitter),
    BackpressureStrategy.DROP)
    .observeOn(Schedulers.io())
    .subscribe(reading -> updateDashboard(reading));

// ── LATEST ── chỉ giữ item MỚI NHẤT khi buffer đầy
// Dùng: live price feed, UI state — chỉ quan tâm trạng thái hiện tại
Flowable.create(emitter -> producePriceTick(emitter),
    BackpressureStrategy.LATEST)
    .observeOn(Schedulers.computation())
    .subscribe(price -> displayPrice(price));

// ── ERROR ── throw MissingBackpressureException ngay khi downstream chậm
// Dùng: development / testing — phát hiện sớm backpressure issue
Flowable.create(emitter -> produceFast(emitter),
    BackpressureStrategy.ERROR)
    .observeOn(Schedulers.io())
    .subscribe(
        item -> process(item),
        err  -> log.error("Backpressure! {}", err.getMessage())
    );
```

---

## 💻 Backpressure trong Project Reactor (Flux)

```java
// Reactor: Flux có backpressure built-in — không cần chỉ định strategy khi tạo
// Nhưng có thể override downstream behavior:

Flux<Long> fastProducer = Flux.interval(Duration.ofMillis(1)); // 1000 items/s

// onBackpressureBuffer — buffer giới hạn với overflow action
fastProducer
    .onBackpressureBuffer(
        256,                                     // max buffer size
        item -> log.warn("Dropped: {}", item),   // overflow callback
        BufferOverflowStrategy.DROP_OLDEST        // strategy khi đầy
    )
    .delayElements(Duration.ofMillis(10))         // consumer xử lý 100/s
    .subscribe(n -> process(n));

// onBackpressureDrop — drop với notification
fastProducer
    .onBackpressureDrop(dropped -> metrics.increment("dropped"))
    .subscribe(n -> process(n));

// onBackpressureLatest — chỉ giữ latest
fastProducer
    .onBackpressureLatest()
    .subscribe(n -> updateUI(n));
```

---

## 💻 Backpressure trong Mutiny (Quarkus)

```java
// Multi trong Quarkus/Mutiny — backpressure built-in
Multi<DocumentEvent> eventStream = documentRepo.streamAll();

eventStream
    .onOverflow().buffer(500)              // buffer 500, drop oldest nếu đầy
    // hoặc:
    .onOverflow().drop()                   // drop silently
    // hoặc:
    .onOverflow().invoke(item ->
        log.warn("Overflow dropping: {}", item)).drop()
    .onItem().transform(DocumentDTO::from)
    .subscribe().with(
        dto  -> process(dto),
        err  -> log.error("Stream error", err)
    );
```

---

## 🔍 Backpressure tự nhiên: Kafka

Kafka có backpressure **ở protocol level** — không cần implement trong code:

```
Consumer poll rate = tốc độ consume
                        ↑
  max.poll.records=500  → consumer lấy tối đa 500 records/poll
  fetch.min.bytes=1024  → broker đợi đủ 1KB trước khi gửi
  Consumer Group lag    → monitor qua Kafka Consumer Lag metrics
```

```java
// Với SmallRye (Quarkus): batch để kiểm soát throughput
@Incoming("document-events")
public Uni<Void> processBatch(List<DocumentEvent> events) {
    // SmallRye tự kiểm soát batch size qua mp.messaging.incoming.*.batch-size
    return documentService.processBatch(events).replaceWithVoid();
}
```

---

## ⚠️ Pitfalls

> [!warning] Observable không có backpressure — dễ OOM
> ```java
> // ❌ Observable không có backpressure — nếu producer nhanh hơn consumer
> Observable<Long> fast = Observable.interval(1, TimeUnit.MICROSECONDS); // 1M/s
> fast.observeOn(Schedulers.io())
>     .subscribe(n -> Thread.sleep(1)); // consumer 1000/s → buffer nổ tung
>
> // ✅ Dùng Flowable nếu producer có thể nhanh hơn consumer
> Flowable<Long> controlled = Flowable.interval(1, TimeUnit.MICROSECONDS)
>     .onBackpressureDrop();
> ```

> [!warning] Buffer không giới hạn → OOM âm thầm
> ```java
> // ❌ BUFFER không giới hạn — OOM nếu producer nhanh liên tục
> .onBackpressureBuffer() // unlimited!
>
> // ✅ Luôn đặt max size
> .onBackpressureBuffer(1000, dropped -> log.warn("Dropped"),
>                       BufferOverflowStrategy.DROP_OLDEST)
> ```

> [!warning] Nhầm Observable và Flowable trong RxJava
> RxJava có 2 stream types khác nhau — `Observable` không có backpressure, `Flowable` có. Khi stream từ DB/file/Kafka → luôn dùng `Flowable`.

---

## 💡 Chọn Strategy nào?

| Tình huống | Strategy |
|-----------|---------|
| Xử lý tài chính, không được mất data | `BUFFER` (giới hạn) + alert khi đầy |
| Sensor, metrics, price feed — cũ không cần | `LATEST` hoặc `DROP` |
| Development, muốn phát hiện vấn đề sớm | `ERROR` |
| Kafka consumer với DLQ | `DROP` + gửi dropped items sang DLQ |
| ETL batch pipeline | `BUFFER` lớn + monitor lag |

---

## 🔗 Liên quan
- [[JVM-Frameworks-2026/04-RxJava/P1-Types/01 Observable vs Flowable|Observable vs Flowable]] — khi nào cần backpressure
- [[JVM-Frameworks-2026/04-RxJava/P3-Advanced/01 Backpressure Strategy|RxJava: Backpressure Strategies]] — code chi tiết
- [[JVM-Frameworks-2026/01-Quarkus/P3-Reactive/03 SmallRye Kafka|SmallRye Kafka]] — backpressure với Kafka
- [[reactive-programming-fundamentals]] — nền tảng reactive
- [[event-loop-model]] — tại sao backpressure quan trọng với event loop

## 📖 Nguồn
- https://github.com/ReactiveX/RxJava/wiki/Backpressure-(2.0)
- https://projectreactor.io/docs/core/release/reference/#reactive.backpressure
- https://smallrye.io/smallrye-reactive-messaging/latest/concepts/overflow/
