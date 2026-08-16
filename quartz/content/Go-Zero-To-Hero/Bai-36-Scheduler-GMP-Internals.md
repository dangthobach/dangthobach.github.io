---
type: course
domain: languages/go
status: active
created: 2026-08-16
updated: 2026-08-16
tags: []
---

# Bài 36: Go Scheduler Internals — GMP State Machine, Preemption & Correctness

> **Mục tiêu:** Bài 3 đã giới thiệu GMP ở mức "bức tranh tổng quan" (G/M/P là gì, work stealing tồn tại). Bài này đi sâu vào **cơ chế đảm bảo đúng đắn**: làm sao runtime chắc chắn tại một thời điểm không có nhiều hơn `GOMAXPROCS` OS thread đang chạy Go code cùng lúc, làm sao goroutine chạy CPU dài bị ngắt mà không cần tự nguyện yield, và làm sao hàng nghìn goroutine tranh nhau P/M mà không cần một global lock khổng lồ làm nghẽn toàn bộ scheduler.
>
> **Level:** Advanced (đọc sau Bài 3 — cần nền GMP cơ bản, netpoller, channel)

---

## 0. Câu hỏi cốt lõi bài này trả lời

```
┌──────────────────────────────────────────────────────────────┐
│  "Goroutine được quản lý thế nào khi có RẤT NHIỀU goroutine,  │
│   và làm sao scheduler kiểm soát được CHÍNH XÁC bao nhiêu     │
│   OS thread đang chạy Go code tại một thời điểm — không hơn,  │
│   không kém, và không bị race trong chính cơ chế điều phối?"  │
└──────────────────────────────────────────────────────────────┘

Trả lời gọn trước, chứng minh chi tiết bên dưới:
1. Bất biến (invariant) cốt lõi: tại mọi thời điểm, số M đang THỰC SỰ
   chạy Go code (không tính M đang kẹt syscall) LUÔN ≤ GOMAXPROCS,
   vì một M chỉ được chạy Go code khi đang "cầm" một P, và tổng số P
   là CỐ ĐỊNH = GOMAXPROCS.
2. Có thể có NHIỀU M hơn P (M cho syscall bị block, M sysmon...),
   nhưng số P — tài nguyên thực sự giới hạn quyền "chạy Go code" —
   không bao giờ đổi khi chương trình đang chạy (trừ khi gọi
   runtime.GOMAXPROCS() tường minh).
3. Đúng đắn không dựa vào 1 global mutex khổng lồ — mà dựa vào việc
   MỖI P chỉ có đúng 1 M sở hữu tại một thời điểm (quan hệ 1-1 tức
   thời), và các thao tác chuyển P giữa các M dùng atomic CAS trên
   con trỏ, không phải lock-toàn-hệ-thống.
```

---

## 1. Ba State Machine: G, M, P

### 1.1 Goroutine (G) — 3 trạng thái chính cần nhớ

```
                    go func()
                        │
                        ▼
                 ┌─────────────┐
        ┌───────►│  _Grunnable │◄────────────────────┐
        │        │ (chờ trong  │                      │
        │        │  run queue) │                      │
        │        └─────────────┘                      │
        │               │ M lấy G ra khỏi queue         │
        │               ▼                              │
        │        ┌─────────────┐                       │
        │        │  _Grunning  │──── block trên        │
        │  bị     │ (đang chạy  │     channel/mutex ──► │_Gwaiting│
        │ preempt │  trên 1 M)  │                        └────┬────┘
        │        └─────────────┘                             │ điều kiện
        │               │ gọi syscall                          │ thỏa mãn
        │               ▼                                     │
        │        ┌─────────────┐                              │
        │        │  _Gsyscall  │──── syscall xong ─────────────┘
        │        │ (đang trong  │     (goready)
        │        │  kernel)    │
        │        └─────────────┘
        │               │ function return / return từ goroutine
        └───────────────┴──────────────────────► _Gdead
```

⚠ **Điểm hay bị hiểu sai:** `_Gsyscall` **không phải** `_Gwaiting`. Một goroutine đang trong syscall vẫn "sống" và M của nó vẫn tồn tại (chỉ có P bị tách ra, xem mục 4) — khác với `_Gwaiting` là goroutine chủ động nhường CPU chờ điều kiện (channel recv, mutex lock, `select`...).

### 1.2 Machine (M) — OS thread, không có "run queue" riêng

M **không sở hữu run queue** — nó chỉ là cơ bắp thực thi. Muốn chạy Go code, M **bắt buộc** phải gắn (`acquirep`) với một P để lấy G từ local run queue của P đó.

```
┌────────────────────────────────────────────────────────────┐
│                  M CÓ THỂ Ở 3 TRẠNG THÁI CHÍNH               │
├────────────────────────────────────────────────────────────┤
│  1. Executing Go code    — M đang gắn P, chạy G trên đó       │
│  2. Blocked in syscall   — M trong kernel, P đã bị tách ra    │
│     (nếu syscall lâu, xem mục 4)                              │
│  3. Idle                 — M rảnh, đợi trong idle M list,      │
│     KHÔNG gắn P nào, chờ được wake khi có việc                │
└────────────────────────────────────────────────────────────┘
```

**Số lượng M có thể lớn hơn GOMAXPROCS rất nhiều** (mặc định giới hạn cứng 10.000 — `runtime.SetMaxThreads`, hiếm khi chạm tới) vì mỗi goroutine block ở syscall dài có thể giữ riêng 1 M. Đây chính là điều Bài 3 nói ngắn gọn "M có thể nhiều hơn P" — giờ ta thấy rõ lý do: **M là tài nguyên co giãn theo nhu cầu syscall, P mới là tài nguyên cố định đại diện cho "quyền chạy Go code".**

### 1.3 Processor (P) — tài nguyên thật sự bị giới hạn bởi GOMAXPROCS

```go
runtime.GOMAXPROCS(8) // đặt số P = 8 (mặc định = runtime.NumCPU())
```

```
┌────────────────────────────────────────────────────────────┐
│         P LÀ "GIẤY PHÉP" ĐỂ CHẠY GO CODE                     │
│                                                              │
│  Tổng số P = GOMAXPROCS = CỐ ĐỊNH khi chương trình chạy       │
│  (chỉ đổi khi code tường minh gọi runtime.GOMAXPROCS)         │
│                                                              │
│  Mỗi P sở hữu:                                               │
│  - Local run queue (mảng vòng, tối đa 256 G)                  │
│  - "runnext" slot — 1 G ưu tiên chạy NGAY SAU G hiện tại       │
│    (tối ưu locality, giống LIFO slot của Tokio đã nói ở       │
│    Deep-Dive VT vs Goroutine vs Rust Async)                   │
│  - mcache — bộ nhớ cache cho allocator (tránh contention lock  │
│    global khi allocate — liên quan tới GC ở Bài 24)            │
│                                                              │
│  BẤT BIẾN QUAN TRỌNG NHẤT:                                    │
│  → Mỗi P tại một thời điểm CHỈ gắn với ĐÚNG 1 M               │
│  → Do đó: số M đang thực thi Go code = số P đang được gắn     │
│    ≤ GOMAXPROCS — đây chính là câu trả lời cho câu hỏi gốc     │
└────────────────────────────────────────────────────────────┘
```

```
P state machine:
   _Pidle ──(acquirep bởi 1 M)──► _Prunning ──(entersyscall)──► _Psyscall
     ▲                                  │                          │
     │                                  │(releasep khi              │
     │                                  │ M đợi lâu quá)             │
     └──────────(handoff, mục 4)────────┴───────────────────────────┘
```

---

## 2. `schedule()` — Vòng lặp tìm việc của mỗi M

Mỗi M, khi rảnh (vừa chạy xong 1 G, hoặc vừa khởi tạo), gọi hàm nội bộ `schedule()` → `findRunnable()` theo **thứ tự ưu tiên cố định**, thiết kế để cân bằng giữa "nhanh" và "công bằng":

```
┌────────────────────────────────────────────────────────────────┐
│              findRunnable() — THỨ TỰ TÌM VIỆC                   │
├────────────────────────────────────────────────────────────────┤
│  1. Mỗi 61 lần gọi schedule() (đếm bằng schedtick % 61 == 0)     │
│     → kiểm tra GLOBAL run queue TRƯỚC local queue                │
│     (tránh global queue bị đói vô thời hạn nếu local queue        │
│      luôn có việc — đánh đổi fairness lấy locality)               │
│  2. Kiểm tra "runnext" slot của P hiện tại                        │
│  3. Kiểm tra local run queue của P hiện tại                       │
│  4. Kiểm tra global run queue (nếu bước 1 chưa check)             │
│  5. Kiểm tra netpoller (non-blocking) — có G nào vừa sẵn sàng     │
│     do I/O hoàn tất không (xem lại netpoller ở Deep-Dive VT)      │
│  6. WORK STEALING — thử steal từ P khác (chi tiết mục 3)          │
│  7. Kiểm tra lại global queue + netpoller (blocking lần này)      │
│  8. Không còn gì → M chuyển sang idle, trả P lại idle P list       │
│     (nếu có), M vào idle M list, đợi được đánh thức                │
└────────────────────────────────────────────────────────────────┘
```

⚠ **Vì sao có luật "1/61"?** Nếu M luôn ưu tiên local queue tuyệt đối, một chương trình mà mọi goroutine đều tự spawn thêm goroutine con vào local queue của chính P đó có thể khiến global queue (nơi chứa G bị "trôi dạt" từ nhiều nguồn — ví dụ `go func()` gọi từ M chưa gắn P ổn định, hoặc G bị đẩy ra khi local queue đầy) **không bao giờ được xử lý**. Con số 61 là hằng số cố định trong runtime (`schedtick%61==0`), chọn đủ lớn để không tốn overhead check liên tục, đủ nhỏ để đảm bảo global queue vẫn được ghé thăm định kỳ.

---

## 3. Work Stealing — Chi tiết thuật toán

```
┌─────────────────────────────────────────────────────────────┐
│                    WORK STEALING ALGORITHM                   │
│                                                               │
│  P0 (idle, vừa hết việc)                                      │
│      │                                                        │
│      ▼  chọn RANDOM permutation của các P khác                │
│  [P3, P1, P4, P2] ← thứ tự random, không phải tuần tự P1,P2..│
│      │              (tránh nhiều P idle cùng lúc đều nhắm      │
│      │               vào đúng 1 P "nạn nhân" → contention)     │
│      ▼                                                        │
│  Với mỗi P trong danh sách, thử steal-half:                    │
│    P1.localQueue = [G5,G6,G7,G8]  → steal MỘT NỬA:             │
│    P1 giữ lại [G5,G6], P0 lấy [G7,G8]                          │
│      │                                                        │
│      ▼ nếu P1 rỗng, thử P4, rồi P2... cho tới khi tìm được     │
│        1 P có việc để steal, hoặc hết danh sách                │
└─────────────────────────────────────────────────────────────┘
```

**Vì sao steal MỘT NỬA chứ không steal HẾT?** Steal hết sẽ làm P nạn nhân ngay lập tức trống queue, có thể phải quay lại steal ngược từ chính P vừa steal (dao động qua lại, tốn CAS liên tục). Steal-half cân bằng tải nhanh hơn trong khi vẫn để lại việc cho P gốc tiếp tục chạy mà không cần đi steal lại ngay.

### 3.1 Spinning M — vì sao cần một trạng thái "M đang tìm việc trong vô ích"

```
┌────────────────────────────────────────────────────────────┐
│  VẤN ĐỀ: nếu M rảnh → ngủ NGAY (park) khi không tìm thấy G    │
│  → một G mới xuất hiện (ví dụ do goroutine khác gọi go func())│
│    phải TRẢ GIÁ đánh thức 1 M đang ngủ (tốn futex wake,        │
│    context switch) → độ trễ tăng cho workload có nhiều G       │
│    ngắn, tần suất tạo/kết thúc cao (rất giống pattern PDMS     │
│    xử lý event Kafka dồn dập)                                  │
│                                                              │
│  GIẢI PHÁP: một số M được giữ ở trạng thái "spinning" —        │
│  KHÔNG chạy G nào, nhưng CŨNG KHÔNG ngủ ngay — liên tục thử    │
│  tìm việc (findRunnable loop) trong một khoảng ngắn trước khi  │
│  park. Runtime giới hạn số M spinning ≈ số P idle, để tránh    │
│  đốt CPU vô ích khi hệ thống thật sự không có việc              │
└────────────────────────────────────────────────────────────┘
```

Đây là đánh đổi latency-vs-CPU kinh điển: spinning tốn CPU cycle "lãng phí" trong lúc chờ, đổi lại G mới không phải trả giá đánh thức 1 M từ trạng thái ngủ sâu — quan trọng với workload PDMS có burst ngắn (ví dụ 1 batch Kafka message đến cùng lúc, spawn N goroutine xử lý rồi kết thúc gần như ngay).

---

## 4. Syscall Handoff — `entersyscall` / `exitsyscall`

Đây là cơ chế trả lời trực tiếp phần "quản lý thread cẩn thận" trong câu hỏi gốc: khi 1 goroutine gọi syscall block (đọc file, gọi cgo blocking...), **P không được phép ngồi không** trong khi M của nó bị kernel giữ.

```
┌────────────────────────────────────────────────────────────────┐
│  G1 đang chạy trên M1 (M1 đang gắn P1)                           │
│         │                                                        │
│         │ G1 gọi syscall (vd: file.Read())                        │
│         ▼                                                        │
│  runtime.entersyscall() được compiler chèn TỰ ĐỘNG trước mọi      │
│  syscall — đánh dấu G1 chuyển _Gsyscall, LƯU LẠI trạng thái P1     │
│  nhưng CHƯA tách P1 ra ngay (đặt cược syscall sẽ nhanh)            │
│         │                                                        │
│         ▼                                                        │
│  sysmon (mục 5) phát hiện: M1 đã ở syscall QUÁ 20µs                │
│  (retake threshold cố định trong runtime) mà chưa quay lại         │
│         │                                                        │
│         ▼                                                        │
│  sysmon gọi handoffP(): TÁCH P1 khỏi M1, gắn P1 cho M khác         │
│  (M idle có sẵn, hoặc tạo M mới nếu cần) → P1 tiếp tục chạy G       │
│  KHÁC ngay lập tức, không phải chờ M1 xong syscall                 │
│         │                                                        │
│         ▼  syscall của G1 hoàn tất                                │
│  runtime.exitsyscall(): G1 thử LẤY LẠI P1 (nếu P1 vẫn rảnh do      │
│  vừa được trả về) hoặc lấy 1 P idle khác — nếu KHÔNG có P nào       │
│  rảnh, G1 bị đẩy vào _Grunnable, chờ trong global run queue         │
│  tới khi có P → M1 tự trở thành idle M (hoặc bị dừng)               │
└────────────────────────────────────────────────────────────────┘
```

**Chi tiết quan trọng hay bị bỏ qua:** có 2 biến thể — `entersyscall` (dùng cho syscall NHANH, runtime "đặt cược" P sẽ không cần tách ngay, chỉ tách nếu sysmon retake) và `entersyscallblock` (dùng khi runtime BIẾT TRƯỚC syscall sẽ chậm — ví dụ `cgocall` block dài — tách P NGAY LẬP TỨC không cần đợi sysmon phát hiện). Compiler + runtime tự chọn biến thể phù hợp dựa vào loại syscall, không phải developer tự quyết định.

---

## 5. `sysmon` — Background thread giám sát độc lập với GMP

`sysmon` là **một OS thread đặc biệt, chạy độc lập, KHÔNG gắn P** (không tham gia vào cơ chế "phải có P mới chạy Go code" — đây là 1 trong số rất ít phần runtime tự cho phép ngoại lệ vì bản thân nó không chạy Go code của user, chỉ giám sát).

```
┌────────────────────────────────────────────────────────────┐
│         sysmon — VÒNG LẶP CHẠY MỖI 20µs → tối đa 10ms         │
│         (thời gian nghỉ giữa các vòng TĂNG DẦN nếu hệ thống    │
│          idle, giảm overhead khi không có gì để giám sát)      │
├────────────────────────────────────────────────────────────┤
│  1. retake() — quét toàn bộ P, tìm:                            │
│     a. P đang _Psyscall quá lâu (>20µs) → handoffP() (mục 4)   │
│     b. P đang _Prunning nhưng G trên đó chạy CPU liên tục       │
│        quá 10ms KHÔNG có safe-point tự nguyện nào               │
│        → đánh dấu cần ASYNC PREEMPTION (mục 6)                  │
│  2. Kiểm tra netpoller — nếu có kết quả I/O sẵn sàng mà chưa    │
│     goroutine nào đang chủ động poll, đưa G tương ứng vào       │
│     global run queue                                            │
│  3. Trigger forced GC nếu đã quá lâu chưa GC (2 phút mặc định)  │
└────────────────────────────────────────────────────────────┘
```

⚠ **Vì sao sysmon không cần P:** nếu sysmon phải tranh giành P như mọi goroutine khác, nó có thể bị đói (starve) đúng lúc hệ thống quá tải — chính là lúc CẦN nó nhất để retake P bị kẹt hoặc preempt G chạy CPU dài. Runtime thiết kế sysmon chạy trên 1 M riêng, độc lập hoàn toàn khỏi cơ chế P-giới hạn.

---

## 6. Preemption — Từ Cooperative đến Async (Go 1.14+)

### 6.1 Trước Go 1.14 — chỉ preempt tại "safe point"

```go
// Trước 1.14 — goroutine chạy CPU loop THUẦN, không gọi function,
// không allocate, không có "safe point" nào → KHÔNG THỂ bị preempt
func infiniteCPULoop() {
    for {
        x := x*2 + 1 // pure arithmetic, không có safe point
    }
}
// → có thể "đói" các goroutine khác trên cùng P vô thời hạn trước 1.14!
```

Cơ chế cũ: compiler chèn 1 check "stack guard" ở **prologue của mỗi function call** — mỗi khi 1 goroutine gọi function mới, nó tự kiểm tra "có cần dừng lại nhường chỗ không?". Đây là **cooperative preemption** — hoàn toàn phụ thuộc goroutine tự nguyện "ghé qua" một điểm kiểm tra. Function không gọi function con (pure tight loop) thì không bao giờ ghé qua safe point nào.

### 6.2 Go 1.14+ — Async Preemption (signal-based)

```
┌────────────────────────────────────────────────────────────────┐
│  sysmon phát hiện G chạy CPU liên tục >10ms (mục 5, bước 1b)      │
│         │                                                        │
│         ▼                                                        │
│  runtime gửi SIGNAL tới M đang chạy G đó                          │
│  (trên Unix/Linux: SIGURG — chọn signal ít khi bị OS/app khác     │
│   dùng, để tránh xung đột với signal handler của chương trình)     │
│         │                                                        │
│         ▼                                                        │
│  Signal handler của Go runtime bắt SIGURG, kiểm tra: instruction  │
│  hiện tại có nằm ở "vùng an toàn để ngắt" không (không phải giữa  │
│  1 atomic operation, không phải trong đoạn code runtime nhạy      │
│  cảm) → nếu an toàn: SỬA instruction pointer để nhảy tới hàm       │
│  asyncPreempt() ngay khi signal handler return                     │
│         │                                                        │
│         ▼                                                        │
│  asyncPreempt() lưu register state, đẩy G về _Grunnable, trả P     │
│  cho scheduler chọn G khác — G bị preempt sẽ resume sau, TỪ ĐÚNG   │
│  điểm bị ngắt (không mất tiến trình tính toán)                      │
└────────────────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────────────────────────────────┐
│  Cooperative (trước 1.14)   │  Async (1.14+)               │
├────────────────────────────────┼──────────────────────────┤
│  Chỉ preempt tại function call │  Preempt tại HẦU HẾT điểm  │
│  prologue                       │  trong chương trình         │
│  Tight loop thuần CPU KHÔNG    │  Tight loop VẪN bị preempt  │
│  thể bị preempt                 │  qua signal                 │
│  Có thể gây "goroutine đói"    │  Giảm mạnh rủi ro đói,       │
│  goroutine khác vô thời hạn    │  nhưng KHÔNG đảm bảo real-   │
│                                  │  time fairness tuyệt đối     │
│                                  │  (vẫn có 1 số đoạn runtime    │
│                                  │  non-preemptible ngắn)        │
└────────────────────────────────┴──────────────────────────┘
```

**Liên hệ PDMS thực tế:** một hàm tính checksum/hash thuần CPU chạy trên document lớn (ví dụ tính SHA256 cho file vài trăm MB, xem lại Bài 34 mục 5) trong vòng lặp byte thuần túy, KHÔNG gọi function nào khác — trước Go 1.14 đoạn này có thể làm các goroutine khác trên cùng P bị đói tới khi nó tự xong; từ 1.14 trở đi, runtime vẫn ngắt được nó sau tối đa ~10ms nhờ async preemption, dù code không hề "hợp tác".

---

## 7. Correctness — Vì sao không cần 1 Global Lock khổng lồ

Câu hỏi gốc nhấn mạnh "cho cẩn thận, đúng logic" — đây là phần trả lời trực tiếp về **an toàn dữ liệu trong chính scheduler**.

```
┌────────────────────────────────────────────────────────────┐
│  KHÔNG PHẢI: 1 mutex duy nhất bọc toàn bộ scheduler          │
│  (sẽ biến GMP thành single-threaded bottleneck — phản tác    │
│   dụng hoàn toàn với mục tiêu multi-core)                    │
│                                                              │
│  THỰC TẾ: phân tách phạm vi khóa theo TỪNG P                 │
│  - Local run queue của P: chỉ M đang SỞ HỮU P đó mới được    │
│    ghi/đọc trực tiếp mà không cần lock — vì tại một thời      │
│    điểm CHỈ CÓ 1 M gắn với P đó (bất biến ở mục 1.3)          │
│  - Khi M KHÁC muốn steal từ P này (work stealing, mục 3):     │
│    dùng lock-free/CAS trên các chỉ số head/tail của ring      │
│    buffer local queue (kỹ thuật giống lock-free queue single- │
│    producer multi-consumer)                                   │
│  - Global run queue: CẦN sched.lock vì nhiều M cùng truy cập  │
│    — nhưng global queue được truy cập ÍT (chỉ 1/61 lần, khi   │
│    local rỗng, hoặc khi G "trôi dạt" không có P sẵn) nên       │
│    contention thấp hơn nhiều so với nếu MỌI thao tác đều       │
│    qua global queue                                            │
│  - Chuyển P giữa M (handoffP, acquirep, releasep): thao tác   │
│    atomic CAS trên con trỏ P.m và M.p, không phải giữ lock     │
│    xuyên suốt cả quá trình chuyển giao                          │
└────────────────────────────────────────────────────────────┘
```

**Nguyên lý thiết kế cốt lõi:** giảm thiểu **phạm vi chia sẻ** (mỗi P gần như "thuộc riêng" 1 M tại một thời điểm → hầu hết thao tác không cần đồng bộ) thay vì cố gắng làm cho 1 cấu trúc dữ liệu chia sẻ toàn cục trở nên "nhanh". Đây chính là lý do Go scheduler scale tốt tới hàng chục core mà không cần 1 lock khổng lồ — tương tự triết lý sharding trong hệ thống phân tán: chia nhỏ tài nguyên theo đơn vị (P) để giảm tranh chấp, chỉ đồng bộ hóa ở lớp global khi thật sự cần "gặp nhau".

---

## 8. Tổng kết Bài 36

```
┌─────────────────────────────────────────────────────────────┐
│                     KEY TAKEAWAYS                             │
├─────────────────────────────────────────────────────────────┤
│  ✅ Bất biến cốt lõi: số P = GOMAXPROCS CỐ ĐỊNH → số M đang    │
│     THỰC SỰ chạy Go code tại một thời điểm ≤ GOMAXPROCS,       │
│     vì mỗi P chỉ gắn ĐÚNG 1 M tại một thời điểm                 │
│  ✅ M có thể nhiều hơn P (syscall block giữ riêng M) — P mới   │
│     là tài nguyên bị giới hạn thật sự, không phải M             │
│  ✅ findRunnable() ưu tiên: runnext → local queue → global      │
│     queue (1/61 lần) → netpoll → work-steal (steal-half,        │
│     thứ tự random) → global+netpoll blocking                     │
│  ✅ Spinning M: đánh đổi CPU cycle lấy latency thấp hơn cho      │
│     workload nhiều G ngắn/burst (rất hợp Kafka consumer PDMS)   │
│  ✅ entersyscall/exitsyscall + sysmon retake(): P không bao      │
│     giờ "ngồi không" chờ 1 syscall chậm — handoff sang M khác    │
│  ✅ Async preemption (Go 1.14+, SIGURG): tight CPU loop vẫn bị   │
│     ngắt sau tối đa ~10ms, khác hẳn cooperative preemption cũ    │
│     (chỉ ngắt tại function-call prologue)                        │
│  ✅ Đúng đắn dựa vào phân tách phạm vi khóa theo từng P + CAS    │
│     lock-free, KHÔNG dựa vào 1 global mutex duy nhất             │
└─────────────────────────────────────────────────────────────┘
```

**Liên quan trong vault:** [[Bai-3-Goroutines-Channels|Bài 3: Goroutines & Channels]] (GMP tổng quan) · [[Bai-23-Pointers-Deep-Dive|Bài 23: Pointers Deep Dive]] (escape analysis) · [[Bai-24-Go-1.26-1.27-Changelog-Deep-Dive|Bài 24: Go 1.26/1.27 Changelog]] (Green Tea GC) · [[Deep-Dive-VirtualThreads-vs-Goroutines-vs-RustAsync|Deep Dive: VT vs Goroutine vs Tokio]] · [[os-process-thread-scheduling|OS Process/Thread Scheduling]]

**Bài tiếp theo:** Bài 37 — Strings/Runes, Enum Pattern & Range-over-Func Iterators (Go 1.23+)

---

**Bài tập:**
1. Viết chương trình tạo N goroutine chạy CPU-bound loop thuần (không gọi function con) trong `GOMAXPROCS=1`, đo xem các goroutine khác (in ra log định kỳ) có bị "đói" tạm thời không — quan sát async preemption hoạt động bằng `GODEBUG=asyncpreemptoff=1` để tắt rồi so sánh
2. Dùng `go tool trace` trên 1 service PDMS thật (hoặc chương trình mô phỏng), tìm khoảng thời gian M bị kẹt syscall lâu và quan sát P được handoff sang M khác trên timeline
3. Thử `runtime.GOMAXPROCS(1)` rồi spawn 1000 goroutine gọi `time.Sleep` — verify tất cả vẫn chạy đồng thời (vì Sleep không giữ P, khác CPU-bound work) dù chỉ có 1 P
4. Đọc source `runtime/proc.go` (hàm `findrunnable`, `retake`, `sysmon`) trong Go source code thật, đối chiếu với thứ tự mô tả ở mục 2 — ghi lại điểm nào khác với bài viết (runtime source có thể đổi giữa các version)

---
*Tags: #go #scheduler #gmp #goroutine #preemption #sysmon #concurrency #zero-to-hero #advanced*
