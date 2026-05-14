# Angular Two-Way Data Binding — Cơ chế bên dưới

tags: #angular #data-binding #zone-js #change-detection #signals #internals

---

## 1. Two-way binding trông như gì

```html
<input [(ngModel)]="username" />
<p>Hello, {{ username }}</p>
```

User gõ → `username` cập nhật → `<p>` re-render. Trông như magic — thực ra là cú pháp sugar kết hợp đúng 2 chiều.

---

## 2. `[(ngModel)]` expand thành gì

Angular's banana-in-a-box `[(x)]` luôn expand thành:

```html
<!-- Hai cú pháp này hoàn toàn tương đương -->
<input [(ngModel)]="username" />

<input
  [ngModel]="username"
  (ngModelChange)="username = $event"
/>
```

- `[ngModel]="username"` → **Property binding** — Angular ghi value từ component xuống DOM
- `(ngModelChange)="username = $event"` → **Event binding** — khi DOM fires event, Angular ghi ngược lên component

Quy tắc chung cho bất kỳ custom two-way binding nào:

```typescript
// Để component hỗ trợ [(value)]="x", cần:
@Input() value: string = '';
@Output() valueChange = new EventEmitter<string>();
// ← tên Output phải là tên Input + "Change"
```

---

## 3. Cơ chế thật sự — Zone.js + Change Detection

Two-way binding chỉ là cú pháp. Thứ thực sự làm cho reactivity hoạt động là **Zone.js** và **Change Detection cycle**.

### Zone.js — The spy

Khi Angular bootstrap, Zone.js **monkey-patch** toàn bộ browser async APIs:

```
setTimeout, setInterval, Promise.then, addEventListener,
XMLHttpRequest, fetch, requestAnimationFrame, ...
```

Bất kỳ async task nào chạy trong Angular zone, Zone.js đều bắt được và thông báo cho Angular khi task hoàn thành.

### Change Detection cycle

```
User gõ phím
    ↓
Browser fires native "input" event
    ↓
Zone.js intercepts (đã patch addEventListener)
    ↓
Zone.js notifies Angular: "async task completed"
    ↓
Angular triggers Change Detection (CD)
    ↓
CD duyệt cây component từ root xuống
    ↓
So sánh template expressions với giá trị cũ (dirty check)
    ↓
Phát hiện username thay đổi → cập nhật DOM
    ↓
Đồng thời: (ngModelChange) emit → username = $event
```

### Dirty checking — Angular so sánh như nào

Angular lưu giá trị cũ của mọi binding expression sau mỗi CD cycle. Khi CD chạy lại, nó so sánh từng expression:

```
Old: username = "Bac"
New: username = "Bach"   ← diff → update DOM
```

Với object/array, Angular so sánh **reference** (không deep equal) — đây là lý do cần tạo object mới thay vì mutate:

```typescript
// WRONG — CD không phát hiện thay đổi
this.user.name = 'Bach';

// CORRECT — reference mới → CD detect
this.user = { ...this.user, name: 'Bach' };
```

---

## 4. OnPush — Tối ưu Change Detection

Mặc định Angular chạy CD cho **toàn bộ cây** mỗi khi có async event. Với `ChangeDetectionStrategy.OnPush`, component chỉ được check khi:

1. Input reference thay đổi
2. Component emit event
3. Observable được async pipe subscribe emit
4. CD được trigger thủ công (`markForCheck()`)

```typescript
@Component({
  selector: 'app-contract-list',
  changeDetection: ChangeDetectionStrategy.OnPush,  // ← opt-in
  template: `...`
})
export class ContractListComponent {
  @Input() contracts: Contract[] = [];
}
```

> **Kết hợp với two-way binding**: khi dùng `OnPush`, phải đảm bảo data flow qua `@Input()` là immutable — mutate array/object in-place sẽ không trigger CD.

---

## 5. Angular Signals — Zone.js-free reactivity (Angular 17+)

Signals là cơ chế reactivity mới, không cần Zone.js:

```typescript
// Thay vì Zone.js detect và duyệt toàn cây:
@Component({
  template: `<input [value]="username()" (input)="username.set($event.target.value)" />`
})
export class MyComponent {
  username = signal('Bach');  // ← signal
}
```

**Cơ chế signal khác Zone.js hoàn toàn:**

```
signal.set('new value')
    ↓
Signal tự track các effect/template nào đang "đọc" nó
    ↓
Notify chỉ những subscriber đó (không duyệt toàn cây)
    ↓
Angular scheduler update đúng DOM node đó
```

Two-way binding với signal dùng `model()` signal (Angular 17.2+):

```typescript
// Child component
export class InputComponent {
  value = model<string>('');  // ← model() = two-way signal
}

// Parent template
<app-input [(value)]="username" />
// username phải là signal hoặc plain property
```

### So sánh Zone.js vs Signals

| | Zone.js (classic) | Signals (modern) |
|---|---|---|
| Trigger CD | Mọi async event | Chỉ khi signal thay đổi |
| Scope check | Toàn cây (hoặc OnPush branch) | Chỉ subscribers của signal đó |
| Zone patch | Cần monkey-patch APIs | Không cần |
| Zoneless mode | Không | ✅ `provideExperimentalZonelessChangeDetection()` |

---

## 6. Reactive Forms — Không dùng ngModel

Trong enterprise Angular (như PDMS), thường dùng `ReactiveFormsModule` thay vì `ngModel`. Two-way sync hoạt động qua `FormControl`:

```typescript
// FormControl tự có value accessor + valueChanges observable
searchForm = new FormGroup({
  keyword: new FormControl(''),
});

// Ghi vào form (→ DOM)
this.searchForm.patchValue({ keyword: 'VPBank' });

// Đọc từ form (← DOM via reactive stream)
this.searchForm.get('keyword')!.valueChanges.subscribe(val => {
  // val thay đổi mỗi khi user gõ
});
```

`FormControl` implement `ControlValueAccessor` — interface chuẩn để sync giữa model và DOM element, không phụ thuộc Zone.js.

---

## Related

- [[Angular-Latest-Series/08-Signals-The-Modern-Reactivity]]
- [[Angular-Latest-Series/09-Reactive-Forms-Mastery]]
- [[Angular-Latest-Series/10-Routing-and-Navigation]]
- [[Angular-Latest-Series/15-Change-Detection-and-OnPush]]
- [[concepts/SolidJS-vs-React-Reactivity-Model]]
