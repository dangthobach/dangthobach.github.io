---
tags: [rxjava, operators, flatmap, switchmap, concatmap]
created: 2026-04-12
status: active
week: 22
phase: P2-Operators
framework: rxjava
---

# Core Operators

## 📌 One-liner
> RxJava có 100+ operators. Cần nắm chắc 15 operators này đủ để viết 95% code reactive thực tế. Đặc biệt: `flatMap` vs `concatMap` vs `switchMap` là câu hỏi phỏng vấn kinh điển.

---

## 🗺️ Operators Phân Loại

```
Transform:  map · flatMap · concatMap · switchMap · scan · buffer · window
Filter:     filter · take · skip · distinct · debounce · throttle · sample
Combine:    merge · concat · zip · combineLatest · withLatestFrom
Utility:    doOnNext · doOnError · doOnComplete · delay · timeout · retry
Error:      onErrorReturn · onErrorResumeNext · retry · retryWhen
```

---

## 💻 Transformation Operators

### map — transform mỗi item (sync)
```java
Observable.just(1, 2, 3, 4, 5)
    .map(n -> n * n)          // sync transform
    .subscribe(System.out::println);
// Output: 1 4 9 16 25
```

### flatMap vs concatMap vs switchMap — THE BIG THREE

```
Tình huống: Stream userId → fetch user từ API cho mỗi id

flatMap:    ──id1──id2──id3──▶ ──fetch1──fetch2──fetch3──▶
            Gửi 3 requests SONG SONG, kết quả trả về THEO THỨ TỰ XONG
            → Có thể: id2 xong trước id1 (không guaranteed order)

concatMap:  ──id1──id2──id3──▶ ──fetch1─────fetch2─────fetch3──▶
            Đợi fetch1 xong → mới gửi fetch2
            → Guaranteed order, nhưng CHẬM HƠN

switchMap:  ──id1─id2─id3──▶ ──────────────────────fetch3──▶
            id2 đến → cancel fetch1, id3 đến → cancel fetch2
            → Chỉ quan tâm item MỚI NHẤT (perfect cho search autocomplete)
```

```java
Observable<Long> userIds = Observable.just(1L, 2L, 3L);

// flatMap — parallel, unordered results
userIds.flatMap(id -> fetchUser(id).toObservable())
    .subscribe(user -> log.info("Got: {}", user.name));
// Output có thể: User2, User1, User3 (nếu User2 fetch nhanh hơn)

// concatMap — sequential, ordered results
userIds.concatMap(id -> fetchUser(id).toObservable())
    .subscribe(user -> log.info("Got: {}", user.name));
// Output luôn là: User1, User2, User3

// switchMap — cancel previous, only latest
searchTextField.textChanges()  // search query stream
    .debounce(300, TimeUnit.MILLISECONDS)
    .switchMap(query -> searchApi(query).toObservable())
    .subscribe(results -> updateUI(results));
// Nếu user gõ nhanh → chỉ gọi API với query cuối cùng
```

> [!warning] Khi nào dùng gì?
> - **flatMap**: Cần tất cả results, thứ tự không quan trọng, muốn parallel → **performance**
> - **concatMap**: Cần đúng thứ tự (process order matters), sequential pipeline → **correctness**
> - **switchMap**: Search autocomplete, live data refresh, cancel on new input → **responsiveness**

---

## 💻 Filter Operators

```java
Observable<Integer> numbers = Observable.range(1, 20);

numbers.filter(n -> n % 2 == 0)        // chỉ số chẵn
       .take(5)                          // chỉ lấy 5 items đầu
       .skip(1)                          // bỏ qua item đầu tiên
       .distinct()                       // loại bỏ duplicate
       .subscribe(System.out::println);

// debounce — đợi 300ms không có item mới thì mới emit
// Dùng: search input, window resize
searchInput.debounce(300, TimeUnit.MILLISECONDS)
           .subscribe(query -> search(query));

// throttleFirst — emit item đầu, ignore các item trong window
// Dùng: button click (chống double-click)
buttonClicks.throttleFirst(1, TimeUnit.SECONDS)
            .subscribe(click -> submitForm());

// sample — emit item mới nhất mỗi interval
// Dùng: sensor data display
sensorData.sample(1, TimeUnit.SECONDS)
          .subscribe(reading -> updateDashboard(reading));
```

---

## 💻 Combining Operators

```java
Observable<String> obs1 = Observable.just("A", "B", "C");
Observable<String> obs2 = Observable.just("1", "2", "3");

// merge — interleave 2 streams (parallel, unordered)
Observable.merge(obs1, obs2)
    .subscribe(System.out::println);
// Output: A 1 B 2 C 3 (interleaved, may vary)

// concat — obs1 complete rồi mới bắt đầu obs2
Observable.concat(obs1, obs2)
    .subscribe(System.out::println);
// Output: A B C 1 2 3 (always)

// zip — kết hợp item tương ứng theo index
Observable.zip(obs1, obs2, (a, b) -> a + b)
    .subscribe(System.out::println);
// Output: A1 B2 C3

// combineLatest — emit khi BẤT KỲ stream nào emit, combine với latest của stream kia
// Dùng: form validation (tên + email → validate khi bất kỳ field thay đổi)
Observable.combineLatest(
    nameField.textChanges(),
    emailField.textChanges(),
    (name, email) -> name.length() > 0 && email.contains("@")
).subscribe(isValid -> submitButton.setEnabled(isValid));
```

---

## 💻 Utility Operators

```java
Observable.just("A", "B", "C")
    .doOnNext(item -> log.debug("Processing: {}", item))    // side effect, không modify
    .doOnError(err -> log.error("Error: {}", err.getMessage()))
    .doOnComplete(() -> log.info("Stream complete"))
    .map(String::toLowerCase)
    .delay(100, TimeUnit.MILLISECONDS)                       // delay mỗi item 100ms
    .timeout(5, TimeUnit.SECONDS,                            // fail nếu không nhận item trong 5s
             Observable.error(new TimeoutException()))
    .subscribe(System.out::println);

// scan — running aggregate (như reduce nhưng emit từng step)
Observable.just(1, 2, 3, 4, 5)
    .scan(0, Integer::sum)
    .subscribe(System.out::println);
// Output: 0 1 3 6 10 15 (running sum)

// buffer — group items thành batches
Observable.range(1, 10)
    .buffer(3)  // batch size 3
    .subscribe(batch -> log.info("Batch: {}", batch));
// Output: [1,2,3]  [4,5,6]  [7,8,9]  [10]
```

---

## 💻 Error Handling

```java
Observable<User> userStream = fetchUsers();

userStream
    // Fallback value on error
    .onErrorReturn(err -> User.empty())

    // Fallback observable on error
    .onErrorResumeNext(err -> Observable.fromIterable(localCache))

    // Retry 3 times
    .retry(3)

    // Retry with custom logic
    .retryWhen(errors -> errors
        .zipWith(Observable.range(1, 3), (err, count) -> count)
        .flatMap(count -> Observable.timer(count, TimeUnit.SECONDS)))
    // Retry lần 1 sau 1s, lần 2 sau 2s, lần 3 sau 3s (exponential backoff)

    .subscribe(
        user -> log.info("Got: {}", user),
        err  -> log.error("All retries failed", err)
    );
```

---

## ✅ Practice Checklist
- [ ] Implement search autocomplete với `switchMap` + `debounce`
- [ ] Fetch 3 APIs song song với `flatMap`, sau đó với `concatMap` — so sánh timing
- [ ] Validate form với `combineLatest`
- [ ] Implement exponential backoff retry với `retryWhen`
- [ ] Stream log events, buffer theo time window

## 🔗 Liên quan
- [[02 Schedulers - subscribeOn vs observeOn]]
- [[01 Observable vs Flowable]]
- reactivex.io → marble diagrams trực quan cho mọi operator

## 📖 Nguồn
- https://reactivex.io/documentation/operators.html
- https://rxmarbles.com — interactive marble diagrams
