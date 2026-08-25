---
type: course
domain: languages/rust
status: active
created: 2026-08-25
updated: 2026-08-25
tags: []
---

# Bài 59 (Dự án 3): Concurrent Pipeline Triệu-Record vs Go — Capstone Cuối Cùng

Đây là bài tổng kết toàn bộ series — và là bài **duy nhất trực tiếp trả lời câu hỏi ngầm xuyên suốt hành trình học**: "Học Rust xong thì được gì hơn so với việc cứ dùng Go, vốn đã quen thuộc và năng suất?" Không trả lời bằng lý thuyết — trả lời bằng số đo thật.

## Mục tiêu

Xây 1 pipeline xử lý (đọc → biến đổi → ghi) cho **10 triệu record** (giả lập dữ liệu giao dịch/log), viết 2 bản: Rust (dùng Tokio + Rayon kết hợp — Bài 22) và Go (idiomatic, dùng goroutine + channel). So sánh: throughput, tổng allocation, và **tail latency** (p99) — không chỉ trung bình.

## 1. Kiến trúc Pipeline (Bounded, chống OOM)

```rust
use tokio::sync::mpsc;
use std::sync::Arc;

const CHANNEL_CAPACITY: usize = 1000; // bounded — backpressure tự nhiên, tránh producer chạy nhanh hơn consumer gây phình RAM

async fn run_pipeline(records: impl Iterator<Item = Record> + Send + 'static) {
    let (tx, mut rx) = mpsc::channel::<Record>(CHANNEL_CAPACITY);

    // Producer: đọc I/O-bound (file/network) — dùng async task
    let producer = tokio::spawn(async move {
        for record in records {
            if tx.send(record).await.is_err() { break; } // rx đã đóng — dừng sớm
        }
    });

    // Consumer: CPU-bound transform — offload sang rayon, KHÔNG chạy trực tiếp trên tokio worker thread
    let rayon_pool = rayon::ThreadPoolBuilder::new().num_threads(num_cpus::get()).build().unwrap();
    let mut handles = vec![];

    while let Some(record) = rx.recv().await {
        let handle = tokio::task::spawn_blocking(move || {
            transform_cpu_heavy(record) // liên hệ Bài 22: KHÔNG bao giờ chạy CPU-bound trực tiếp trong async fn
        });
        handles.push(handle);
    }

    for h in handles { let _ = h.await; }
    let _ = producer.await;
}
```

**Điểm mấu chốt kiến trúc (liên hệ Bài 22):** producer là I/O-bound → dùng async task bình thường; transform là CPU-bound → BẮT BUỘC qua `spawn_blocking` hoặc rayon pool riêng, không được chạy trực tiếp trong async task (sẽ block hết worker thread của Tokio runtime, làm nghẽn toàn bộ service, kể cả các request không liên quan).

## 2. Bounded Backpressure — vì sao không dùng unbounded channel

```rust
// ❌ unbounded — nếu producer đọc nhanh hơn consumer xử lý, RAM phình vô hạn
// let (tx, rx) = mpsc::unbounded_channel();

// ✅ bounded — tx.send().await tự ĐỢI nếu channel đầy, ép producer chậm lại theo tốc độ consumer
let (tx, rx) = mpsc::channel(1000);
```

Đây chính là "backpressure" nhắc ở Stage 4 của roadmap — cơ chế tự động cân bằng tốc độ giữa các stage của pipeline mà không cần logic throttle thủ công.

## 3. Đo Allocation — `dhat` hoặc `heaptrack`

```toml
# Cargo.toml (chỉ bật khi profile để tránh overhead ở production)
[dependencies]
dhat = { version = "0.3", optional = true }
```

```rust
#[cfg(feature = "dhat-heap")]
#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

fn main() {
    #[cfg(feature = "dhat-heap")]
    let _profiler = dhat::Profiler::new_heap();
    run_pipeline(load_records());
}
```

```bash
cargo run --release --features dhat-heap
# Sinh dhat-heap.json -> mở tại https://nnethercote.github.io/dh_view/dh_view.html
# Cho biết: tổng số byte allocated, số lần allocate, "hot" allocation site nào tốn nhất
```

## 4. Benchmark Throughput & Tail Latency — Criterion + thủ công cho p99

```rust
// benches/pipeline_bench.rs — Criterion đo hàm đơn lẻ tốt, nhưng pipeline end-to-end cần đo tay
use std::time::Instant;

fn measure_pipeline(n: usize) -> Vec<std::time::Duration> {
    let mut latencies = Vec::with_capacity(n);
    for record in generate_records(n) {
        let start = Instant::now();
        let _ = transform_cpu_heavy(record);
        latencies.push(start.elapsed());
    }
    latencies.sort();
    latencies
}

fn percentile(sorted: &[std::time::Duration], p: f64) -> std::time::Duration {
    sorted[((sorted.len() as f64 - 1.0) * p) as usize]
}

// p50, p95, p99 — KHÔNG chỉ báo cáo trung bình (trung bình che giấu outlier)
```

**Nguyên tắc quan trọng khi báo cáo kết quả:** trung bình (mean) dễ đánh lừa — 1 request mất 5s trong 10,000 request có thể không ảnh hưởng mean nhiều, nhưng p99 sẽ lộ ra ngay. Với service thật (như PDMS), p99/p999 mới là con số khách hàng cảm nhận được ("tại sao thỉnh thoảng chậm").

## 5. Bản Go tương ứng — điểm khác biệt cần giải thích

```go
func runPipeline(records <-chan Record) {
    sem := make(chan struct{}, runtime.NumCPU()) // giới hạn concurrency thủ công — Go không có "spawn_blocking" tách biệt
    var wg sync.WaitGroup
    for r := range records {
        wg.Add(1)
        sem <- struct{}{}
        go func(rec Record) {
            defer wg.Done()
            defer func() { <-sem }()
            transformCpuHeavy(rec) // Go scheduler tự multiplex goroutine lên OS thread — không phân biệt tường minh CPU-bound/IO-bound như Tokio
        }(r)
    }
    wg.Wait()
}
```

Go's goroutine scheduler dùng cùng 1 pool OS thread cho mọi việc (M:N scheduling), không có khái niệm tách riêng "async executor" và "blocking thread pool" như Rust/Tokio — đơn giản hơn để viết, nhưng bạn **mất kiểm soát tường minh** về việc CPU-bound work có đang cạnh tranh với goroutine I/O-bound khác hay không (GC + scheduler tự lo, bạn không thấy được ranh giới).

## 6. Bảng So Sánh Cần Điền Sau Khi Chạy Thật

| Chỉ số | Rust (Tokio+Rayon) | Go (goroutine) | Giải thích khác biệt |
|---|---|---|---|
| Throughput (record/s) | ? | ? | Liên hệ: zero-cost abstraction (Bài 17), không GC pause |
| Tổng allocation (MB) | ? | ? | Rust: ownership tránh clone thừa (Bài 4c, 17); Go: GC tự động nhưng escape analysis kém hơn trong pipeline phức tạp |
| p50 latency | ? | ? | |
| p99 latency | ? | ? | Go: GC stop-the-world (dù ngắn) có thể gây spike; Rust: không GC, nhưng lock contention (Bài 22) nếu thiết kế sai vẫn gây spike tương đương |
| Memory footprint khi idle | ? | ? | Go runtime + GC overhead vs Rust binary tối giản |
| Dòng code | ? | ? | Go thường ngắn hơn — đánh đổi control lấy đơn giản |

## Checklist hoàn thành

- [ ] Cả 2 bản (Rust + Go) chạy được với cùng 10 triệu record giống hệt nhau (cùng seed random)
- [ ] Channel/goroutine đều bounded, có backpressure thật (không phải unbounded rồi "may mà đủ RAM")
- [ ] Đo được p50/p95/p99, không chỉ trung bình
- [ ] Có số đo allocation (dhat cho Rust, `pprof` heap profile cho Go)
- [ ] Viết 1 đoạn giải thích bằng lời (không chỉ số liệu) cho MỖI hàng trong bảng so sánh — đây là phần quan trọng nhất, thể hiện bạn hiểu NGUYÊN NHÂN chứ không chỉ đo được con số

---
**Đây là bài capstone cuối của lộ trình.** Hoàn thành nó nghĩa là bạn đã đi qua đủ 5 stage: Core Language → Mental Model → Abstractions → Production Backend → Expert Systems, với bằng chứng thực nghiệm so với chính công cụ nền tảng bạn dùng hàng ngày (Go) — không chỉ dừng ở "biết cú pháp Rust".
