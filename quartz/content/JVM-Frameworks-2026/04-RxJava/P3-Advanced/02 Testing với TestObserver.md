---
tags: [rxjava, testing, testobserver, testscheduler]
created: 2026-04-12
status: active
week: 24
phase: P3-Advanced
framework: rxjava
---

# Testing với TestObserver & TestScheduler

## 📌 One-liner
> RxJava cung cấp `TestObserver` (subscribe và assert kết quả) và `TestScheduler` (control thời gian trong test) — test async code một cách synchronous, không cần `Thread.sleep()`.

---

## 💻 TestObserver — Assert stream results

```java
// TestObserver = subscriber đặc biệt thu thập kết quả để assert

@Test
void filterAndMap_shouldReturnEvenSquares() {
    // Arrange
    Observable<Integer> source = Observable.just(1, 2, 3, 4, 5);

    // Act
    TestObserver<Integer> observer = source
        .filter(n -> n % 2 == 0)
        .map(n -> n * n)
        .test();  // ← .test() tạo TestObserver và subscribe

    // Assert
    observer.assertNoErrors()          // không có error
            .assertComplete()          // stream đã complete
            .assertValueCount(2)       // có đúng 2 items
            .assertValues(4, 16);      // items đúng thứ tự
}

@Test
void errorHandling_shouldRecoverWithFallback() {
    Observable<String> source = Observable
        .error(new RuntimeException("DB down"))
        .onErrorReturn(err -> "fallback");

    TestObserver<String> observer = source.test();

    observer.assertNoErrors()
            .assertValue("fallback")
            .assertComplete();
}

@Test
void asyncStream_shouldTimeout() {
    Observable<Long> delayed = Observable.timer(5, TimeUnit.SECONDS);

    TestObserver<Long> observer = delayed
        .timeout(1, TimeUnit.SECONDS, Observable.just(-1L))
        .test();

    // Với TestScheduler có thể control time
    // Không có TestScheduler → test sẽ đợi 1 giây thật...
    observer.awaitDone(2, TimeUnit.SECONDS)
            .assertValue(-1L);  // fallback khi timeout
}
```

---

## 🔧 TestScheduler — Control Time

```java
// TestScheduler cho phép advance thời gian trong test — không đợi thật!

@Test
void debounce_shouldOnlyEmitAfterQuiet() {
    TestScheduler scheduler = new TestScheduler();

    PublishSubject<String> input = PublishSubject.create();

    TestObserver<String> observer = input
        .debounce(300, TimeUnit.MILLISECONDS, scheduler)  // inject TestScheduler!
        .test();

    // Simulate typing fast
    input.onNext("Q");
    input.onNext("Qu");
    input.onNext("Que");

    scheduler.advanceTimeBy(100, TimeUnit.MILLISECONDS);  // advance 100ms
    observer.assertEmpty();  // nothing emitted yet (still in debounce window)

    input.onNext("Quer");
    scheduler.advanceTimeBy(300, TimeUnit.MILLISECONDS);  // advance 300ms after last input

    observer.assertValue("Quer");  // only last value emitted!
}

@Test
void retryWithBackoff_shouldRetry3Times() {
    TestScheduler scheduler = new TestScheduler();
    AtomicInteger attempts = new AtomicInteger(0);

    Observable<String> flaky = Observable.fromCallable(() -> {
        int attempt = attempts.incrementAndGet();
        if (attempt < 4) throw new RuntimeException("Attempt " + attempt + " failed");
        return "Success";
    });

    TestObserver<String> observer = flaky
        .retryWhen(errors -> errors.zipWith(
            Observable.range(1, 3),
            (err, count) -> count
        ).flatMap(count ->
            Observable.timer(count, TimeUnit.SECONDS, scheduler)
        ))
        .test();

    scheduler.advanceTimeBy(1, TimeUnit.SECONDS);  // retry 1
    scheduler.advanceTimeBy(2, TimeUnit.SECONDS);  // retry 2
    scheduler.advanceTimeBy(3, TimeUnit.SECONDS);  // retry 3 → success

    observer.assertValue("Success").assertComplete();
    assertEquals(4, attempts.get());
}
```

---

## 🔧 Testing với Mockito

```java
@ExtendWith(MockitoExtension.class)
class DocumentServiceTest {

    @Mock
    DocumentRepository documentRepo;

    @Mock
    KafkaProducer kafkaProducer;

    @InjectMocks
    DocumentService documentService;

    @Test
    void createDocument_shouldPersistAndPublish() {
        // Arrange — mock returns Observable
        when(documentRepo.save(any()))
            .thenReturn(Observable.just(new Document(1L, "Test Doc")));
        when(kafkaProducer.publish(any()))
            .thenReturn(Completable.complete());

        // Act
        TestObserver<Document> observer = documentService
            .create(new CreateDocRequest("Test Doc"))
            .test();

        // Assert
        observer.assertNoErrors()
                .assertValueCount(1)
                .assertValue(doc -> doc.getId().equals(1L));

        verify(kafkaProducer, times(1)).publish(any(DocumentEvent.class));
    }

    @Test
    void createDocument_whenRepoFails_shouldNotPublish() {
        when(documentRepo.save(any()))
            .thenReturn(Observable.error(new DatabaseException("Connection lost")));

        TestObserver<Document> observer = documentService
            .create(new CreateDocRequest("Test Doc"))
            .test();

        observer.assertError(DocumentServiceException.class);
        verify(kafkaProducer, never()).publish(any());
    }
}
```

---

## 🔧 Blocking Testing (simple cases)

```java
@Test
void blockingGet_forSimpleSync() {
    // Cho single-value sync observables, blockingGet() là đủ
    String result = Observable.just("Hello")
        .map(String::toUpperCase)
        .blockingFirst();

    assertEquals("HELLO", result);
}

@Test
void blockingList_collectResults() {
    List<Integer> results = Observable.range(1, 5)
        .filter(n -> n % 2 == 0)
        .toList()
        .blockingGet();

    assertEquals(List.of(2, 4), results);
}
```

> [!warning] blockingGet() trong production
> Chỉ dùng `blockingGet()` / `blockingFirst()` trong TEST. Trong production code, always subscribe properly để không block thread.

---

## ✅ Practice Checklist
- [ ] Viết TestObserver test cho Observable pipeline
- [ ] Test debounce logic với TestScheduler (không cần `Thread.sleep`)
- [ ] Mock repository trả về Observable, assert service behavior
- [ ] Test error handling và recovery paths

## 🔗 Liên quan
- [[01 Backpressure Strategy]]
- [[../P2-Operators/01 Core Operators]]

## 📖 Nguồn
- https://github.com/ReactiveX/RxJava/wiki/Testing
