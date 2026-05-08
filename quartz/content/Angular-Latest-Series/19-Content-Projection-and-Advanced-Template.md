# 19. Content Projection & Advanced Template Patterns 🎭

> **Tại sao cần học?**
> Content Projection là cách xây dựng các **component tái sử dụng linh hoạt** — modal, card, table, layout — mà không bị ràng buộc vào nội dung cụ thể. Đây là kỹ năng thiết yếu để xây dựng Design System cho dự án enterprise.

---

## 📦 1. Content Projection: Hộp thư có slot

### Ẩn dụ: Khuôn bánh có ô trống

Hãy tưởng tượng bạn có một khuôn làm bánh đặc biệt với các **ô trống có thể điền**:
- Ô tiêu đề → điền gì tuỳ ý
- Ô nội dung → điền gì tuỳ ý
- Ô footer → điền gì tuỳ ý

Đó chính là **Content Projection** với `<ng-content>`.

---

## 🕳️ 2. Single Slot Projection (ng-content cơ bản)

```typescript
// card.component.ts
@Component({
  selector: 'app-card',
  standalone: true,
  template: `
    <div class="card">
      <div class="card-body">
        <ng-content></ng-content>  <!-- ← Ô trống, điền gì vào đây tuỳ ý -->
      </div>
    </div>
  `
})
export class CardComponent {}
```

```html
<!-- Cách dùng -->
<app-card>
  <h2>Thông tin hồ sơ vay</h2>
  <p>CIF: 0123456789</p>
</app-card>

<!-- Kết quả render -->
<div class="card">
  <div class="card-body">
    <h2>Thông tin hồ sơ vay</h2>
    <p>CIF: 0123456789</p>
  </div>
</div>
```

---

## 🎯 3. Multi-Slot Projection (select attribute)

```typescript
// dialog.component.ts
@Component({
  selector: 'app-dialog',
  standalone: true,
  template: `
    <div class="dialog-overlay">
      <div class="dialog-container">
        <!-- Header slot -->
        <div class="dialog-header">
          <ng-content select="[dialog-title]"></ng-content>
        </div>
        
        <!-- Body slot -->
        <div class="dialog-body">
          <ng-content select="[dialog-body]"></ng-content>
        </div>
        
        <!-- Footer slot -->
        <div class="dialog-footer">
          <ng-content select="[dialog-footer]"></ng-content>
          <!-- Fallback nếu không truyền footer -->
          <ng-content></ng-content>
        </div>
      </div>
    </div>
  `
})
export class DialogComponent {
  @Input() isOpen = false;
}
```

```html
<!-- Cách dùng: Rõ ràng, linh hoạt -->
<app-dialog [isOpen]="showApprovalDialog">
  <h2 dialog-title>Xác nhận phê duyệt hồ sơ</h2>
  
  <div dialog-body>
    <p>Bạn có chắc muốn phê duyệt hồ sơ <strong>{{ caseFile.id }}</strong>?</p>
    <app-loan-summary [data]="caseFile" />
  </div>
  
  <div dialog-footer>
    <button (click)="cancel()">Huỷ</button>
    <button class="primary" (click)="confirm()">Phê duyệt</button>
  </div>
</app-dialog>
```

---

## 👁️ 4. ViewChild & ContentChild

### ViewChild: Truy cập element trong template

```typescript
@Component({
  standalone: true,
  template: `
    <input #searchInput type="text" placeholder="Tìm kiếm hồ sơ..." />
    <app-data-table #dataTable [data]="tableData" />
  `
})
export class CaseFileSearchComponent implements AfterViewInit {
  // Truy cập DOM element
  @ViewChild('searchInput') searchInput!: ElementRef<HTMLInputElement>;
  
  // Truy cập component con
  @ViewChild('dataTable') dataTable!: DataTableComponent;
  
  // Với signal (Angular 17+) — khuyến khích dùng
  searchInputRef = viewChild<ElementRef>('searchInput');
  dataTableRef = viewChild(DataTableComponent);

  ngAfterViewInit() {
    // Focus vào ô tìm kiếm khi component load
    this.searchInput.nativeElement.focus();
  }

  exportData() {
    // Gọi method của component con
    this.dataTable.exportToExcel();
  }
}
```

### ContentChild: Truy cập element được project vào

```typescript
// expandable-section.component.ts
@Component({
  selector: 'app-expandable',
  standalone: true,
  template: `
    <div class="header" (click)="toggle()">
      <ng-content select="[expandable-header]"></ng-content>
      <span>{{ isExpanded ? '▲' : '▼' }}</span>
    </div>
    @if (isExpanded) {
      <div class="content">
        <ng-content select="[expandable-content]"></ng-content>
      </div>
    }
  `
})
export class ExpandableSectionComponent {
  // Truy cập content được truyền từ bên ngoài
  @ContentChild('customTrigger') customTrigger?: ElementRef;
  
  isExpanded = signal(false);
  
  toggle() {
    this.isExpanded.update(v => !v);
  }
}
```

---

## 🏗️ 5. Pattern thực chiến: Generic Table Component

```typescript
// data-table.component.ts
interface TableColumn<T> {
  key: keyof T;
  label: string;
  sortable?: boolean;
  formatter?: (value: any) => string;
}

@Component({
  selector: 'app-data-table',
  standalone: true,
  imports: [CommonModule],
  template: `
    <table>
      <thead>
        <tr>
          @for (col of columns; track col.key) {
            <th (click)="col.sortable && sortBy(col.key)">
              {{ col.label }}
              @if (col.sortable) { <span>⇅</span> }
            </th>
          }
          <!-- Slot cho action columns -->
          <ng-content select="[table-header-extra]"></ng-content>
        </tr>
      </thead>
      <tbody>
        @for (row of data; track row[trackByKey]) {
          <tr>
            @for (col of columns; track col.key) {
              <td>
                {{ col.formatter ? col.formatter(row[col.key]) : row[col.key] }}
              </td>
            }
            <!-- Slot cho action cells (nút Edit, Delete, ...) -->
            <ng-content select="[table-row-action]"></ng-content>
          </tr>
        }
      </tbody>
    </table>
    
    <!-- Slot cho pagination -->
    <ng-content select="[table-footer]"></ng-content>
  `
})
export class DataTableComponent<T extends Record<string, any>> {
  @Input({ required: true }) data: T[] = [];
  @Input({ required: true }) columns: TableColumn<T>[] = [];
  @Input() trackByKey: keyof T = 'id' as keyof T;
  
  @Output() sortChange = new EventEmitter<{ key: keyof T; direction: 'asc' | 'desc' }>();
  
  sortState = signal<{ key: keyof T | null; dir: 'asc' | 'desc' }>({ key: null, dir: 'asc' });
  
  sortBy(key: keyof T) {
    const current = this.sortState();
    const newDir = current.key === key && current.dir === 'asc' ? 'desc' : 'asc';
    this.sortState.set({ key, dir: newDir });
    this.sortChange.emit({ key, direction: newDir });
  }
}
```

```html
<!-- Sử dụng generic table cho danh sách hồ sơ -->
<app-data-table [data]="caseFiles" [columns]="caseFileColumns">
  <!-- Thêm cột action tùy ý -->
  <ng-template table-row-action let-row>
    <td>
      <button (click)="viewDetail(row.id)">Chi tiết</button>
      @if (canApprove) {
        <button (click)="approve(row.id)">Phê duyệt</button>
      }
    </td>
  </ng-template>
  
  <app-pagination [total]="totalCount" table-footer (pageChange)="onPageChange($event)" />
</app-data-table>
```

---

## 🎨 6. ng-template & ng-container

### ng-template: Khuôn mẫu chưa render

```typescript
@Component({
  template: `
    <!-- ng-container: Không tạo DOM element thật, chỉ là grouping -->
    <ng-container *ngIf="isLoading; else contentTemplate">
      <app-skeleton />
    </ng-container>
    
    <!-- ng-template: Định nghĩa template có thể tái sử dụng -->
    <ng-template #contentTemplate>
      <div class="content">...</div>
    </ng-template>
    
    <!-- Dùng trong table: Không tạo <div> thừa trong <tr><td> -->
    <tr>
      <ng-container *ngIf="showExtraColumns">
        <td>Cột A</td>
        <td>Cột B</td>
      </ng-container>
    </tr>
  `
})
export class ContentExampleComponent {
  isLoading = signal(true);
  showExtraColumns = signal(false);
}
```

---

**Bài tiếp theo:** [[20-Lazy-Loading-and-Code-Splitting|20. Lazy Loading & Code Splitting: Tối ưu bundle size]] 🚀
