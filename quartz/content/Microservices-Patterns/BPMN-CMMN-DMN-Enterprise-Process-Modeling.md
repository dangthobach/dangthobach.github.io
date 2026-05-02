# BPMN · CMMN · DMN — Enterprise Process Modeling Deep Dive

> **Tags:** #bpmn #cmmn #dmn #process-modeling #workflow #enterprise #camunda #pdms  
> **Status:** 🟢 Complete  
> **Related:** [[PDMS-Workflow-Optimal-Communication]] · [[PDMS-Architecture-Overview]] · [[Saga-Pattern]] · [[Transactional-Outbox]]

---

## 📌 Tại sao các Model này là xu hướng?

Trước khi đi vào từng notation, cần hiểu **vấn đề mà chúng giải quyết**.

### Bài toán cốt lõi của Enterprise Systems

Các hệ thống doanh nghiệp hiện đại — như PDMS tại VPBank — phải xử lý:

| Thách thức | Hệ quả nếu thiếu standard |
|---|---|
| Business logic phức tạp, nhiều nhánh điều kiện | Code spaghetti, khó audit |
| Quy trình kéo dài nhiều ngày (long-running process) | State bị mất khi restart service |
| Quy trình có thể thay đổi theo nghiệp vụ | Deploy lại toàn bộ app chỉ để đổi 1 luồng |
| Multi-stakeholder (nhiều phòng ban cùng tham gia) | Không ai hiểu được "cả hệ thống" |
| Audit, compliance, traceability | Không có lịch sử thực thi |

### Ba Notation, Ba Vai trò khác nhau

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Enterprise Process Triad                         │
│                                                                      │
│   BPMN                   CMMN                    DMN                 │
│   (How to DO it)         (What MIGHT happen)     (Why to DO it)      │
│                                                                      │
│   Structured Flow        Adaptive Case           Decision Logic      │
│   Sequential Steps       Knowledge Work          Business Rules      │
│   "Onboarding KH"        "Xử lý khiếu nại"       "Tính lãi suất"    │
│                                                                      │
│   ──────────────────────────────────────────────────────────────     │
│              Cùng nhau = Complete Business Automation                │
└──────────────────────────────────────────────────────────────────────┘
```

**Lý do chúng trở thành xu hướng:**

1. **OMG Standard** — Được chuẩn hóa bởi Object Management Group, vendor-neutral, không bị lock-in
2. **Executable Models** — Không chỉ là diagram, các engine (Camunda, Flowable, Drools) có thể *chạy* trực tiếp từ model
3. **Business-IT Alignment** — Business analyst vẽ diagram, developer deploy nguyên diagram đó, không dịch thuật mất thông tin
4. **Audit by Design** — Mọi token chạy qua process đều được log, visualize được real-time
5. **Microservices-friendly** — Service Task trong BPMN gọi REST/gRPC → tích hợp tự nhiên với microservices

---

## 🔷 BPMN — Business Process Model and Notation

### Khái niệm cốt lõi

**BPMN (phiên bản 2.0)** là ngôn ngữ mô hình hóa quy trình nghiệp vụ *có thể thực thi*. Nó định nghĩa một tập hợp ký hiệu chuẩn để biểu diễn luồng công việc tuần tự, điều kiện rẽ nhánh, và tương tác giữa các bên tham gia.

> **Mental model:** Hãy nghĩ BPMN như một **flowchart trên steroid** — đủ expressive để máy tính có thể execute, đủ visual để business người đọc được.

### Các phần tử cơ bản

#### 1. Events (Sự kiện)

Events là những điểm quan trọng xảy ra trong process. Có 3 loại chính theo vị trí:

```
Start Event          Intermediate Event       End Event
    ○                      ◎                     ●
(Mỏng, trống)        (Vòng đôi)            (Đặc/dày)
```

Và theo **loại trigger**:

| Symbol | Loại | Ý nghĩa | Ví dụ PDMS |
|---|---|---|---|
| ○ | None Start | Bắt đầu thủ công | Nhân viên click "Tạo hồ sơ" |
| ✉○ | Message Start | Nhận message để bắt đầu | Nhận event từ Kafka topic |
| ⏱○ | Timer Start | Bắt đầu theo lịch | Cron job batch validation lúc 2AM |
| ⚡○ | Signal Start | Nhận broadcast signal | Hệ thống CoreBanking gửi signal |
| ✉◎ | Message Intermediate | Chờ/gửi message giữa chừng | Chờ approval từ manager |
| ⏱◎ | Timer Intermediate | Chờ sau N giờ/ngày | Escalate nếu 24h chưa approve |
| 🔗◎ | Link Intermediate | Jump giữa các phần trong process | Nối subprocess với main flow |
| ●  | None End | Kết thúc | Hồ sơ đã lưu thành công |
| ✉● | Message End | Gửi message khi kết thúc | Gửi notification đến KH |
| ⚠● | Error End | Kết thúc với lỗi | Validation thất bại |
| ⛔● | Terminate End | Kết thúc toàn bộ process instance | |

#### 2. Activities (Hoạt động)

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│                  │    │ ≡ (có dấu gạch)  │    │  +  (có dấu +)  │
│   User Task      │    │  Script Task     │    │  Subprocess      │
│  (người thực)    │    │  (tự động/code)  │    │  (process con)   │
└──────────────────┘    └──────────────────┘    └──────────────────┘

┌──────────────────┐    ┌──────────────────┐
│  ⚙ Service Task  │    │  Call Activity   │
│  (gọi service    │    │  (gọi process    │
│   bên ngoài)     │    │   khác)          │
└──────────────────┘    └──────────────────┘
```

**Service Task** là loại quan trọng nhất trong microservices:
- Gọi REST API của service khác
- Publish message lên Kafka
- Tương tác với database
- Có thể implement bằng Java Delegate, External Task, hoặc Connector

#### 3. Gateways (Cổng phân nhánh)

```
◇ XOR (Exclusive)   ◇ AND (Parallel)    ◇ OR (Inclusive)    ◇ Event-Based
     X                    +                   O                    ⬡
  Chọn 1 nhánh      Tất cả nhánh         1+ nhánh           Theo event nào đến
```

**XOR Gateway — ví dụ thực tế:**
```
                    ┌─── [Số lượng > 1000] ──→ Senior Review
Upload Excel ──→ ◇ ─┤
                    └─── [Số lượng ≤ 1000] ──→ Auto Validate
```

**Parallel (AND) Gateway — xử lý song song:**
```
                    ┌──→ Validate CIF ────────────┐
                    │                              │
Nhận file  ──→ ◇+ ─┼──→ Validate HopDong ─────── ┼──→ ◇+ ──→ Tổng hợp kết quả
                    │                              │
                    └──→ Validate TAP ─────────────┘
```

**Event-Based Gateway — chờ event nào đến trước:**
```
                    ┌─── ⏱ 24h timeout ──→ Auto Reject
                    │
Gửi yêu cầu ──→ ◇⬡ ┤
                    │
                    └─── ✉ Nhận approval ──→ Tiếp tục
```

#### 4. Sequence Flow và Message Flow

```
──────────────────────►  Sequence Flow   (trong cùng pool)
- - - - - - - - - - - ►  Message Flow   (giữa các pool/participant)
```

#### 5. Pools và Lanes

**Pool** = một participant (một tổ chức/system).  
**Lane** = phân chia vai trò trong pool.

```
┌─────────────────────────────────────────────────────────────────────┐
│ POOL: Hệ thống PDMS                                                  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ LANE: Nhân viên Kho                                            │  │
│  │   ○ ──→ [Upload file] ──→ [Kiểm tra] ──→ ✉→                  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ LANE: Hệ thống Tự động                                        │  │
│  │                       ←✉ ──→ [ETL Process] ──→ [Notify] ──→ ● │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

### 🔬 Subprocess — Xử lý Process Phức tạp

#### Tại sao cần Subprocess?

Khi một process có hơn 20-30 task, nó trở nên khó đọc và khó maintain. Subprocess cho phép **đóng gói** một nhóm task thành một unit có thể collapse/expand.

Có **3 loại Subprocess** quan trọng:

#### 3.1. Embedded Subprocess (Inline)

Chạy **trong cùng process instance**, share cùng process variables.

```xml
<!-- Camunda BPMN XML -->
<subProcess id="validateDocuments" name="Validate Documents">
  <startEvent id="startValidate"/>
  <serviceTask id="validateCIF" name="Validate CIF"
    camunda:class="vn.vpbank.pdms.delegate.ValidateCIFDelegate"/>
  <serviceTask id="validateHopDong" name="Validate HopDong"
    camunda:class="vn.vpbank.pdms.delegate.ValidateHopDongDelegate"/>
  <parallelGateway id="joinGateway"/>
  <endEvent id="endValidate"/>
  <!-- sequence flows... -->
</subProcess>
```

**Đặc điểm:**
- Variables của subprocess accessible từ parent
- Nếu subprocess end với error → có thể catch ở boundary của subprocess
- Không thể tái sử dụng ở process khác

#### 3.2. Call Activity (Reusable Subprocess)

Gọi một **process riêng biệt**, có thể tái sử dụng, có thể version độc lập.

```
Main Process:                     Sub Process (riêng):
                                  ┌────────────────────────────┐
○ ──→ [Upload] ──→ [Validate] ──→ │ Process: DocumentValidation │ ──→ [Store] ──→ ●
                      ↑           │   ○──→[CIF]──→[Contract]──→●│
                 Call Activity    └────────────────────────────┘
                 gọi process con
```

```xml
<!-- Call Activity trong Camunda -->
<callActivity id="callValidation"
              name="Run Document Validation"
              calledElement="documentValidationProcess">
  <extensionElements>
    <camunda:in source="batchId" target="batchId"/>
    <camunda:in source="warehouseId" target="warehouseId"/>
    <camunda:out source="validationResult" target="validationResult"/>
    <camunda:out source="errorCount" target="errorCount"/>
  </extensionElements>
</callActivity>
```

**Input/Output Mapping** rất quan trọng — bạn explicit define variable nào được pass vào và trả về.

#### 3.3. Event Subprocess

Một subprocess **không nằm trong main flow**, chỉ triggered khi có event xảy ra. Dùng cho cross-cutting concerns như logging, error handling, timeout.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Main Process                                                         │
│   ○ ──→ [Validate] ──→ [ETL] ──→ [Store] ──→ ●                     │
│                                                                      │
│   ┌──────────────────────────────────────────┐                      │
│   │ Event Subprocess (triggered by Error)    │                      │
│   │  ⚠○ ──→ [Log Error] ──→ [Notify Admin] ──→ ●                   │
│   └──────────────────────────────────────────┘                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

### 🔗 Linked/Triggered Processes — Giải quyết Multi-Process Orchestration

Đây là câu hỏi quan trọng: **Khi các process cần trigger lẫn nhau, giải quyết thế nào?**

Có **4 cơ chế** chính:

#### Cơ chế 1: Call Activity (Synchronous)

Process cha **gọi** process con và **chờ** kết quả. Phù hợp khi cần kết quả ngay.

```
PDMS Example:
BatchUploadProcess
  └──→ [Call: ValidateAllDocuments] ←── chờ xong mới tiếp
          └── ValidateAllDocuments Process
                ├── [Validate CIF]
                ├── [Validate HopDong]
                └── [Return: errorList]
  └──→ [Nếu OK: Call ETLProcess]
```

#### Cơ chế 2: Message Events (Asynchronous)

Process A gửi **Message**, Process B lắng nghe Message đó. Không cần biết nhau trực tiếp.

```
WarehouseUploadProcess                    ETLProcess
                                          ✉○ "BatchReadyToETL"
   [Upload OK] ──→ ✉● "BatchReadyToETL"  ──────────────────►   [Start ETL]
   (kết thúc/tiếp tục)                    (được trigger bởi message)
```

Trong Camunda, correlate message qua:
```java
runtimeService.createMessageCorrelation("BatchReadyToETL")
    .processInstanceVariableEquals("batchId", batchId)
    .correlate();
```

#### Cơ chế 3: Signal Events (Broadcast)

Một process gửi **Signal** — **tất cả** processes đang chờ signal đó đều được kích hoạt. Dùng cho system-wide events.

```
CoreBankingSystem ──→ ⚡ Signal "EndOfDay"
                           │
                           ├──→ BatchReconcileProcess (đang chờ signal này) ── start
                           ├──→ AuditReportProcess    (đang chờ signal này) ── start
                           └──→ NotificationProcess   (đang chờ signal này) ── start
```

#### Cơ chế 4: Error/Escalation Boundary Events

Khi subprocess throw error, parent có thể catch và xử lý:

```
Main Process:
  [Validate] ──→ [ETL Subprocess]
                        │
                  ⚠ Error Boundary ──→ [Handle ETL Error] ──→ [Retry or Fail]
```

```xml
<boundaryEvent id="etlError" attachedToRef="etlSubProcess">
  <errorEventDefinition errorRef="ETLException"/>
</boundaryEvent>
<sequenceFlow sourceRef="etlError" targetRef="handleETLError"/>
```

#### So sánh 4 cơ chế

| Cơ chế | Coupling | Hướng | Use Case |
|---|---|---|---|
| Call Activity | Tight (biết tên process) | 1-to-1, sync | Sub-workflow bắt buộc phải xong |
| Message | Loose (biết tên message) | 1-to-1, async | Handoff giữa departments |
| Signal | Loose | 1-to-many, broadcast | System events, EOD |
| Error/Escalation | Context | Child → Parent | Exception handling |

---

### 📋 BPMN UseCase: PDMS Batch Upload & ETL

Đây là một ví dụ **full-feature** áp dụng vào PDMS:

```
POOL: PDMS System
│
LANE: Nhân viên Kho
│  ○ ──→ [Upload Excel] ──→ [Preview Summary] ──→◇──[Confirm?]──→●(Cancel)
│                                                  └──[Yes]──→✉● "UploadConfirmed"
│
LANE: Batch Processing Service
│  ✉○ "UploadConfirmed"
│    │
│    ▼
│  [Parse Excel SAX] ──→ [Stage to DB] ──→◇+ ─┬──→[Validate CIF Batch]──┐
│                                              ├──→[Validate HD Batch] ──┤──→◇+ ──→[Merge Results]
│                                              └──→[Validate TAP Batch]──┘
│                                                                  │
│                                              ┌───────────────────┘
│                                              ▼
│                                        ◇XOR──┬──[errorCount > 0]──→[Notify Errors]──→✉●"BatchFailed"
│                                              └──[errorCount = 0]──→[Call: ETLProcess]
│                                                                           │
│                                                              ┌────────────┘
│                                                              ▼
LANE: ETL Process (Call Activity / separate process)
│     ○──→[pdms_etl_from_staging()]──→[Invalidate Cache]──→[Audit Log]──→●
│          (stored procedure)
│
LANE: Notification Service
│  ✉○ "BatchFailed" ──→ [Send Notification] ──→ ●
│  ✉○ "ETLComplete" ──→ [Send Success Notif] ──→ ●
```

---

## 🔷 CMMN — Case Management Model and Notation

### Khái niệm: Adaptive vs Structured

BPMN giỏi mô hình hóa **structured processes** — những gì bạn biết trước sẽ xảy ra. Nhưng nhiều công việc thực tế của doanh nghiệp là **knowledge work** — những gì cần làm phụ thuộc vào những gì khám phá được trong quá trình.

> **Analogy:** BPMN là **bản đồ GPS** (đường đi cố định). CMMN là **tấm bản đồ mở** của thám tử — bạn có các manh mối, các hành động có thể làm, nhưng thứ tự và điều kiện do người xử lý quyết định theo context.

### Khi nào dùng CMMN thay vì BPMN?

| Tình huống | BPMN | CMMN |
|---|---|---|
| Onboarding KH tiêu chuẩn | ✅ | |
| Xử lý khiếu nại phức tạp | | ✅ |
| Quy trình phê duyệt 3 cấp | ✅ | |
| Điều tra gian lận | | ✅ |
| ETL batch processing | ✅ | |
| Case management y tế | | ✅ |
| KYC/AML screening | | ✅ |
| Hỗ trợ khách hàng đặc biệt | | ✅ |

**Rule of thumb:** Nếu bạn không thể vẽ được flowchart rõ ràng cho một tình huống, đó là CMMN territory.

### Các phần tử CMMN

#### Case (Hồ sơ)

Một **Case** là unit công việc chính trong CMMN. Mỗi case instance mang theo **Case File** — tập hợp data liên quan đến case đó.

```
┌──────────────────────────────────────────────────────────┐
│ CASE: Xử lý Khiếu nại KH #KN-2024-001                   │
│                                                           │
│ Case File:                                                │
│   - KhachHang: { id, name, segment }                     │
│   - KhieuNai: { loai, moTa, ngayGui }                    │
│   - TaiLieuDinhKem: [...]                                 │
│   - LichSuXuLy: [...]                                     │
│                                                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │ Task:    │ │ Task:    │ │ Task:    │ │ Stage:   │    │
│  │ Tiếp    │ │ Điều tra │ │ Phê      │ │ Escalate │    │
│  │ nhận    │ │ hồ sơ    │ │ duyệt    │ │ (nếu cần)│    │
│  │[ENABLED]│ │[AVAILABLE│ │[AVAILABLE│ │[AVAILABLE│    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘    │
└──────────────────────────────────────────────────────────┘
```

#### Task States trong CMMN

Khác với BPMN (task chạy theo sequence), CMMN task có lifecycle state:

```
INITIAL ──→ AVAILABLE ──→ ENABLED ──→ ACTIVE ──→ COMPLETED
                │                       │
                └──→ DISABLED           └──→ FAILED
                                        └──→ TERMINATED
```

- **AVAILABLE**: Task có thể được thực hiện nhưng chưa ai bắt đầu
- **ENABLED**: Điều kiện để start task đã thỏa mãn
- **ACTIVE**: Đang được thực hiện

#### Sentries — Điều kiện kích hoạt

**Sentry** là điều kiện quyết định khi nào một task trở nên available/required.

```
Entry Sentry (◇ trước task):  Khi nào task có thể BẮT ĐẦU
Exit Sentry  (◇ sau task):    Khi nào task có thể KẾT THÚC
```

Sentry kết hợp:
- **On Part**: Dựa vào lifecycle transition của task/stage khác ("sau khi task A complete")
- **If Part**: Dựa vào expression trên Case File data ("nếu `khieuNai.giaTriThietHai > 100_000_000`")

#### Plan Items và Discretionary Items

- **Plan Item** (solid border): Task mặc định có trong case plan
- **Discretionary Item** (dashed border): Task tùy chọn — case worker có thể add nếu thấy cần

```
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─┐    ┌──────────────────┐
  [Lấy thêm tài liệu]      │ [Xác minh danh   │
└ ─ ─ ─ ─ ─ ─ ─ ─ ─┘    │  tính KH]         │
  Discretionary             └──────────────────┘
  (tùy chọn)                Plan Item (bắt buộc)
```

### UseCase CMMN: Xử lý Khiếu nại PDMS

Khi một lô tài liệu PDMS bị từ chối sau kiểm tra, case worker cần điều tra:

```
CASE: DocumentDisputeCase

Plan Items (bắt buộc):
  [Tiếp nhận thông tin] ──◇(entry: case created)
  [Phân tích lỗi]       ──◇(entry: tiếp nhận completed AND loaiKhieuNai != null)
  [Ra quyết định]       ──◇(entry: phanTich completed)

Discretionary Items (case worker thêm nếu cần):
  [Liên hệ đơn vị cung cấp]  ── dashed
  [Yêu cầu bổ sung tài liệu] ── dashed
  [Escalate lên Ban lãnh đạo] ── dashed

Milestones:
  ⬡ "Đã có đủ thông tin"     ── trigger khi case file đủ data
  ⬡ "Quyết định đã được ký"  ── trigger khi decision document uploaded

Case File Items:
  - KhieuNaiInfo: { maBatch, loaiLoi, moTa }
  - TaiLieuGoc: File[]
  - KetQuaDieuTra: { ketLuan, deNghi }
  - QuyetDinh: { type: APPROVE|REJECT|PARTIAL }
```

---

## 🔷 DMN — Decision Model and Notation

### Khái niệm: Tách Business Rules ra khỏi Code

**DMN** giải quyết một vấn đề kinh điển: business rules bị **chôn vùi trong code** dưới dạng `if-else` chains dài hàng trăm dòng.

```java
// ❌ Business rule trong code — khó maintain
if (customerSegment.equals("VIP") && amount > 1_000_000_000) {
    if (documentCount >= 3) {
        return "APPROVE_LEVEL_3";
    } else if (documentCount >= 1) {
        return "APPROVE_LEVEL_2";
    }
} else if (customerSegment.equals("STANDARD") && amount > 500_000_000) {
    // ... 50 dòng nữa
}
```

DMN cho phép **business analyst** định nghĩa rules trong bảng, không cần developer:

### Decision Table — Trái tim của DMN

```
╔══════════════════════════════════════════════════════════════════════╗
║ Decision Table: ApprovalLevelDecision                               ║
║ Hit Policy: UNIQUE (chỉ 1 rule match)                               ║
╠═══════════════════╦════════════════╦══════════════╦════════════════╣
║ INPUT             ║ INPUT          ║ OUTPUT       ║ ANNOTATION     ║
╠═══════════════════╬════════════════╬══════════════╬════════════════╣
║ customerSegment   ║ amount         ║ approvalLevel║                ║
╠═══════════════════╬════════════════╬══════════════╬════════════════╣
║ "VIP"             ║ > 1000000000   ║ "LEVEL_3"    ║ VIP lớn        ║
╠═══════════════════╬════════════════╬══════════════╬════════════════╣
║ "VIP"             ║ [100M..1B]     ║ "LEVEL_2"    ║ VIP trung      ║
╠═══════════════════╬════════════════╬══════════════╬════════════════╣
║ "VIP"             ║ < 100000000    ║ "LEVEL_1"    ║ VIP nhỏ        ║
╠═══════════════════╬════════════════╬══════════════╬════════════════╣
║ "STANDARD"        ║ > 500000000    ║ "LEVEL_2"    ║ Standard lớn   ║
╠═══════════════════╬════════════════╬══════════════╬════════════════╣
║ "STANDARD"        ║ -              ║ "LEVEL_1"    ║ Standard còn   ║
╚═══════════════════╩════════════════╩══════════════╩════════════════╝
```

### Hit Policies

Hit policy quyết định khi **nhiều rule cùng match** thì xử lý thế nào:

| Hit Policy | Symbol | Ý nghĩa | Dùng khi |
|---|---|---|---|
| UNIQUE | U | Chỉ đúng 1 rule match, else error | Mutually exclusive rules |
| FIRST | F | Lấy rule match đầu tiên (theo thứ tự) | Priority-based rules |
| RULE ORDER | R | Trả về list kết quả theo thứ tự rule match | Nhiều kết quả có priority |
| ANY | A | Nhiều rule match nhưng output phải giống nhau | Redundant rules |
| COLLECT | C | Thu thập tất cả output (có thể aggregate) | Multi-match, sum/count |
| OUTPUT ORDER | O | List kết quả sorted theo output value | |

**COLLECT với Aggregation:**
```
C+ = sum tất cả output numeric
C< = min
C> = max
C# = count
```

### FEEL — Friendly Enough Expression Language

DMN sử dụng **FEEL** để viết conditions:

```feel
// Numeric ranges
amount > 1000000              // greater than
amount in [100000..500000]    // inclusive range
amount in (100000..500000)    // exclusive range
amount in [100000..500000)    // half-open

// String
customerSegment = "VIP"
customerSegment in ["VIP", "PREMIUM"]

// Date/Time
date("2024-01-01")
date and time("2024-01-01T09:00:00")
duration("P1Y2M")             // 1 year 2 months

// List
count(items) > 3
some item in items satisfies item.status = "PENDING"
every item in items satisfies item.validated = true

// Functions
if condition then value1 else value2
```

### Decision Requirements Diagram (DRD)

Khi có nhiều decision tables liên kết nhau:

```
        ┌────────────────────┐
        │ GetCustomerSegment │  ← Input Data: customerId
        │ (Decision Table)   │
        └─────────┬──────────┘
                  │ customerSegment
                  ▼
        ┌────────────────────┐         ┌──────────────────┐
        │ ApprovalLevel      │ ◄────── │ amount           │
        │ Decision           │         │ (Input Data)     │
        └─────────┬──────────┘         └──────────────────┘
                  │ approvalLevel
                  ▼
        ┌────────────────────┐
        │ NotificationPolicy │  ← approvalLevel
        │ Decision           │
        └────────────────────┘
```

### UseCase DMN: PDMS Document Processing Rules

#### Decision 1: Xác định loại validation cần thiết

```
╔══════════════════════════════════════════════════════════════════╗
║ ValidationRequirementDecision  |  Hit Policy: COLLECT (output list)║
╠═══════════════════╦════════════╦══════════════════════════════════╣
║ documentType      ║ batchSize  ║ requiredValidations              ║
╠═══════════════════╬════════════╬══════════════════════════════════╣
║ "HSBG"            ║ -          ║ ["CIF", "HOP_DONG", "TAP"]       ║
╠═══════════════════╬════════════╬══════════════════════════════════╣
║ "KHO_CHUNG"       ║ > 10000    ║ ["CIF", "BARCODE"]               ║
╠═══════════════════╬════════════╬══════════════════════════════════╣
║ "KHO_CHUNG"       ║ <= 10000   ║ ["CIF"]                          ║
╚═══════════════════╩════════════╩══════════════════════════════════╝
```

#### Decision 2: Notification Escalation

```
╔═════════════════════════════════════════════════════════════════╗
║ EscalationDecision  |  Hit Policy: FIRST                        ║
╠═══════════════╦══════════════════╦══════════════════════════════╣
║ errorRate     ║ timeSinceUpload  ║ action                       ║
╠═══════════════╬══════════════════╬══════════════════════════════╣
║ > 0.5         ║ -                ║ "NOTIFY_MANAGER_IMMEDIATELY" ║
╠═══════════════╬══════════════════╬══════════════════════════════╣
║ > 0.2         ║ > duration("PT4H")║ "NOTIFY_MANAGER"            ║
╠═══════════════╬══════════════════╬══════════════════════════════╣
║ > 0           ║ > duration("PT8H")║ "NOTIFY_STAFF"              ║
╠═══════════════╬══════════════════╬══════════════════════════════╣
║ -             ║ -                ║ "NO_ACTION"                  ║
╚═══════════════╩══════════════════╩══════════════════════════════╝
```

---

## 🔗 Tích hợp BPMN + CMMN + DMN trong một hệ thống

Đây là kiến trúc **Hybrid** — ba notation làm việc cùng nhau:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PDMS Process Orchestration                        │
│                                                                      │
│  1. BPMN: BatchUploadProcess (structured, predictable flow)          │
│     ○─→[Upload]─→[Stage]─→ ◇ ─→[Validate]─→[Call DMN Decision]─→◇  │
│                              │                      │               │
│                              │              [DMN: ValidationReqDecision]
│                              │                      │               │
│                         [Auto Reject]    [ETL]─→[Notify]─→●         │
│                                                                      │
│  2. DMN: Embedded in BPMN Service Tasks                              │
│     [Determine Approval Level] ──calls──► [ApprovalLevelDecision]   │
│     [Escalation Check]         ──calls──► [EscalationDecision]      │
│                                                                      │
│  3. CMMN: Triggered when batch has disputes                          │
│     BPMN ──Message──► DocumentDisputeCase (CMMN)                    │
│                        [Investigate] [Contact] [Decide]              │
│                         (adaptive, human-driven)                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Orchestration với Camunda 7/8

```java
// Spring Boot integration
@Component
public class ETLDecisionDelegate implements JavaDelegate {
    
    @Autowired
    private DecisionService decisionService;
    
    @Override
    public void execute(DelegateExecution execution) {
        String documentType = (String) execution.getVariable("documentType");
        Long batchSize = (Long) execution.getVariable("batchSize");
        
        // Gọi DMN Decision Table
        DmnDecisionTableResult result = decisionService
            .evaluateDecisionTableByKey("ValidationRequirementDecision")
            .variable("documentType", documentType)
            .variable("batchSize", batchSize)
            .evaluate();
        
        List<String> requiredValidations = result.collectEntries("requiredValidations");
        execution.setVariable("requiredValidations", requiredValidations);
    }
}

// External Task (Non-blocking pattern)
@Component
public class ValidateBatchExternalTask implements ExternalTaskHandler {
    
    @Override
    public void execute(ExternalTask externalTask, ExternalTaskService service) {
        String batchId = externalTask.getVariable("batchId");
        
        try {
            ValidationResult result = validationService.validate(batchId);
            service.complete(externalTask,
                Map.of("validationResult", result.toJson(),
                       "errorCount", result.getErrorCount()));
        } catch (Exception e) {
            service.handleBpmnError(externalTask, "VALIDATION_ERROR", e.getMessage());
        }
    }
}
```

---

## ⚡ Tool Support và Implementation Path

### Process Engine Options

| Engine | License | Strengths | Best For |
|---|---|---|---|
| **Camunda 7** | Community/Enterprise | BPMN+CMMN+DMN, mature, Spring integration | Enterprise Java |
| **Camunda 8** (SaaS/Self) | SSPL/Enterprise | Cloud-native, Zeebe engine, high throughput | Cloud microservices |
| **Flowable** | Apache 2.0 | Lightweight, BPMN+CMMN+DMN | Open-source |
| **Activiti** | Apache 2.0 | Simple, widely known | Simple workflows |
| **jBPM** | Apache 2.0 | Drools integration, decision-heavy | Rule-heavy systems |

### Tooling cho PDMS (đề xuất stack)

```
Design:       Camunda Modeler (free desktop app) → export BPMN/DMN XML
Engine:       Camunda 7 (embedded trong Spring Boot) hoặc Camunda 8
Testing:      camunda-bpm-assert + JUnit5
Monitoring:   Camunda Cockpit (built-in) + Grafana metrics
Version:      Store BPMN/DMN XML trong Git, CI/CD deploy to engine
```

### Spring Boot + Camunda 7 setup nhanh

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.camunda.bpm.springboot</groupId>
    <artifactId>camunda-bpm-spring-boot-starter</artifactId>
    <version>7.21.0</version>
</dependency>
<dependency>
    <groupId>org.camunda.bpm.springboot</groupId>
    <artifactId>camunda-bpm-spring-boot-starter-rest</artifactId>
    <version>7.21.0</version>
</dependency>
```

```yaml
# application.yml
camunda.bpm:
  admin-user:
    id: admin
    password: admin
  database:
    schema-update: true
  job-execution:
    enabled: true
    core-pool-size: 5
    max-pool-size: 25
```

BPMN files đặt trong `src/main/resources/bpmn/` sẽ được **auto-deploy** khi start.

---

## 📊 Summary — Khi nào dùng gì?

```
Câu hỏi: Process này có predictable flow không?
    │
    ├── YES → Dùng BPMN
    │         Câu hỏi: Có business rules phức tạp không?
    │             ├── YES → BPMN + DMN embedded
    │             └── NO  → BPMN thuần
    │
    └── NO → Knowledge work / adaptive
              Dùng CMMN
              Câu hỏi: Có rules để quyết định actions không?
                  ├── YES → CMMN + DMN
                  └── NO  → CMMN thuần

Luôn tích hợp cả 3 trong enterprise system phức tạp.
```

### Quick Reference Cards

**BPMN Quick Card:**
- Events: ○ Start / ◎ Intermediate / ● End
- Tasks: User / Service / Script / Call Activity / Subprocess
- Gateways: XOR (◇X) / AND (◇+) / OR (◇O) / Event-Based (◇⬡)
- Multi-process: Message Events cho async, Call Activity cho sync

**CMMN Quick Card:**
- Case = unit công việc adaptive
- Plan Item = task bắt buộc trong plan
- Discretionary = task tùy chọn
- Sentry = điều kiện trigger (on part + if part)
- Milestone = checkpoint trong case

**DMN Quick Card:**
- Decision Table = bảng if-else rõ ràng, business-editable
- Hit Policy: U(nique), F(irst), C(ollect), A(ny)
- FEEL = expression language cho conditions
- DRD = nhiều decisions liên kết thành graph

---

## 📚 Resources

- [BPMN 2.0 Spec](https://www.omg.org/spec/BPMN/2.0/)
- [CMMN 1.1 Spec](https://www.omg.org/spec/CMMN/1.1/)
- [DMN 1.3 Spec](https://www.omg.org/spec/DMN/1.3/)
- [Camunda BPMN Reference](https://docs.camunda.org/manual/latest/reference/bpmn20/)
- [Camunda DMN Reference](https://docs.camunda.org/manual/latest/reference/dmn/)
- [Flowable Documentation](https://www.flowable.com/open-source/docs/)
- [BPMN.io Modeler](https://bpmn.io/) — online modeler free
