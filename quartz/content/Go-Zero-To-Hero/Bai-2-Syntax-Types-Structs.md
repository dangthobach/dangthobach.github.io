# Bài 2: Syntax, Types, Structs & Methods

> **Mục tiêu:** Nắm vững hệ thống kiểu dữ liệu Go, struct, methods, pointers — so sánh trực tiếp Java/Rust.

---

## 1. Zero Values — Go's Safety Default

Go không cho phép uninitialized memory. Mọi biến đều có **zero value**:

```
┌────────────────────────────────────────┐
│         GO ZERO VALUES                 │
├────────────┬───────────────────────────┤
│  Type      │  Zero Value               │
├────────────┼───────────────────────────┤
│  int/float │  0                        │
│  bool      │  false                    │
│  string    │  ""  (empty string)       │
│  pointer   │  nil                      │
│  slice     │  nil (len=0, cap=0)       │
│  map       │  nil (cannot write!)      │
│  channel   │  nil (blocks forever!)    │
│  interface │  nil                      │
│  struct    │  all fields zeroed        │
└────────────┴───────────────────────────┘
```

```go
// Java — NullPointerException trap!
String s;
s.length(); // NPE

// Go — zero value an toàn
var s string
fmt.Println(len(s)) // 0 — không panic

var p *int
fmt.Println(p) // <nil> — nhưng dereference sẽ panic
```

---

## 2. Slices — Quan trọng hơn Array

### Anatomy của Slice
```
┌──────────────────────────────────────────────────────┐
│                  SLICE HEADER (24 bytes)              │
│                                                      │
│  ┌─────────┐  ┌─────┐  ┌─────┐                      │
│  │  ptr    │  │ len │  │ cap │                       │
│  │ ─────►  │  │  3  │  │  5  │                       │
│  └─────────┘  └─────┘  └─────┘                       │
│       │                                              │
│       ▼  Underlying Array                            │
│  ┌────┬────┬────┬────┬────┐                          │
│  │ 10 │ 20 │ 30 │    │    │                          │
│  └────┴────┴────┴────┴────┘                          │
│   [0]  [1]  [2]  [3]  [4]  ← capacity               │
│   ─────────────            ← length                  │
└──────────────────────────────────────────────────────┘
```

```go
// Tạo slice
s := []int{10, 20, 30}          // len=3, cap=3
s2 := make([]int, 3, 5)         // len=3, cap=5
s3 := s[1:3]                    // sub-slice, SHARE cùng array!

// ⚠ TRAP: append có thể tạo array mới
s = append(s, 40)               // cap đủ: append in-place
s = append(s, 50, 60, 70)      // cap hết: copy sang array mới

// So sánh với Java ArrayList
// ArrayList tự động resize — Go yêu cầu bạn hiểu khi nào resize xảy ra
```

### Map — Luôn phải initialize
```go
// ❌ Sai — nil map panic khi write
var m map[string]int
m["key"] = 1  // panic: assignment to entry in nil map

// ✅ Đúng
m := make(map[string]int)
m["key"] = 1

// Hoặc map literal
m2 := map[string]int{
    "a": 1,
    "b": 2,
}

// Check key exists — QUAN TRỌNG
val, ok := m["key"]
if ok {
    fmt.Println(val)
}
```

---

## 3. Structs & Methods

### Struct trong Go vs Java Class
```
┌──────────────────────────────────────────────────────┐
│  JAVA CLASS          │  GO STRUCT                    │
├──────────────────────┼───────────────────────────────┤
│  Fields + Methods    │  Struct (data only)           │
│  Constructor         │  Struct literal / New func    │
│  Inheritance         │  Embedding (composition)      │
│  Abstract class      │  Interface                    │
│  Generics <T>        │  Generics [T any] (Go 1.18)  │
└──────────────────────┴───────────────────────────────┘
```

```go
type User struct {
    ID       int64
    Name     string
    Email    string
    IsActive bool
}

// Constructor pattern (Go convention)
func NewUser(name, email string) *User {
    return &User{
        Name:     name,
        Email:    email,
        IsActive: true,
    }
}

// Methods: Value receiver vs Pointer receiver
func (u User) Greet() string {          // Value receiver — copy
    return "Hello, " + u.Name
}

func (u *User) Deactivate() {           // Pointer receiver — modify original
    u.IsActive = false
}
```

### Value Receiver vs Pointer Receiver
```
┌─────────────────────────────────────────────────────┐
│           VALUE RECEIVER (u User)                   │
│                                                     │
│  Caller          Method gets a COPY                 │
│  ┌──────┐        ┌──────────┐                       │
│  │  u   │──copy─►│  u (copy)│                       │
│  └──────┘        └──────────┘                       │
│                                                     │
│  ✅ Safe — không modify original                    │
│  ✅ Goroutine-safe (mỗi goroutine có copy riêng)    │
│  ⚠ Tốn memory nếu struct lớn                       │
├─────────────────────────────────────────────────────┤
│           POINTER RECEIVER (u *User)                │
│                                                     │
│  Caller          Method gets POINTER                │
│  ┌──────┐        ┌──────────┐                       │
│  │  u   │──ptr──►│  u (ptr) │                       │
│  └──────┘        └──────────┘                       │
│       ▲                │ modify                     │
│       └────────────────┘                            │
│                                                     │
│  ✅ Modify original struct                          │
│  ✅ Efficient cho struct lớn                        │
│  ⚠ Cần chú ý concurrency                           │
└─────────────────────────────────────────────────────┘

RULE OF THUMB:
- Struct có mutex/state → Pointer receiver
- Struct nhỏ, immutable → Value receiver  
- Nếu một method dùng pointer → dùng pointer cho TẤT CẢ methods
```

---

## 4. Struct Embedding — Composition thay Inheritance

```go
// Java Inheritance
class Animal { String name; void breathe() {...} }
class Dog extends Animal { void bark() {...} }

// Go Embedding (Composition)
type Animal struct {
    Name string
}

func (a Animal) Breathe() {
    fmt.Println(a.Name, "is breathing")
}

type Dog struct {
    Animal           // Embedded — KHÔNG phải field, là embedding
    Breed string
}

func (d Dog) Bark() {
    fmt.Println("Woof!")
}

// Usage
d := Dog{
    Animal: Animal{Name: "Rex"},
    Breed:  "Labrador",
}

d.Breathe() // ✅ "promoted" từ Animal — gọi trực tiếp được!
d.Bark()
d.Name      // ✅ field promotion
d.Animal.Name // cũng được
```

```
Embedding promotion:
┌─────────────────────┐
│  Dog                │
│  ┌───────────────┐  │
│  │ Animal        │  │
│  │  .Name        │──┼──► d.Name (promoted)
│  │  .Breathe()   │──┼──► d.Breathe() (promoted)
│  └───────────────┘  │
│  .Breed             │
│  .Bark()            │
└─────────────────────┘
```

---

## 5. Pointers trong Go vs Java vs Rust

```
┌──────────────────────────────────────────────────────────────┐
│                    POINTER COMPARISON                        │
├──────────────┬──────────────────┬───────────────────────────┤
│  Java        │  Go              │  Rust                     │
├──────────────┼──────────────────┼───────────────────────────┤
│  Object refs │  *T pointers     │  &T, &mut T, Box<T>       │
│  always ref  │  explicit *      │  explicit + lifetime      │
│  GC manages  │  GC manages      │  Ownership manages        │
│  No arith    │  No arith        │  No arith (safe)          │
│  Null NPE    │  nil (panic)     │  Option<T> (no null)      │
└──────────────┴──────────────────┴───────────────────────────┘
```

```go
x := 42
p := &x          // lấy địa chỉ của x
fmt.Println(*p)  // derereference: 42
*p = 100         // modify qua pointer
fmt.Println(x)   // 100

// Khi nào dùng pointer?
// 1. Muốn function modify caller's value
// 2. Struct lớn — tránh copy
// 3. Optional value (nil = absent)
// 4. Implement interface với pointer receiver

// ⚠ Go KHÔNG có pointer arithmetic (khác C/Rust unsafe)
// p++ // compile error!
```

---

## 6. Generics (Go 1.18+)

```go
// Trước Go 1.18 — phải dùng interface{} hoặc codegen
func MaxInterface(a, b interface{}) interface{} {
    // type assertion cồng kềnh...
}

// Go 1.18+ — Generics
func Max[T int | float64 | string](a, b T) T {
    if a > b {
        return a
    }
    return b
}

// Dùng với constraints
import "golang.org/x/exp/constraints"

func Sum[T constraints.Number](nums []T) T {
    var total T
    for _, n := range nums {
        total += n
    }
    return total
}

// Generic struct
type Stack[T any] struct {
    items []T
}

func (s *Stack[T]) Push(item T) {
    s.items = append(s.items, item)
}

func (s *Stack[T]) Pop() (T, bool) {
    if len(s.items) == 0 {
        var zero T
        return zero, false
    }
    item := s.items[len(s.items)-1]
    s.items = s.items[:len(s.items)-1]
    return item, true
}
```

---

## 7. Tổng kết Bài 2

```
┌─────────────────────────────────────────────────────┐
│               KEY TAKEAWAYS                         │
├─────────────────────────────────────────────────────┤
│  ✅ Zero values — không có uninitialized variable   │
│  ✅ Slice = ptr + len + cap, share underlying array │
│  ✅ Map phải make() trước khi write                 │
│  ✅ Value receiver = copy, Pointer receiver = ref   │
│  ✅ Embedding = composition (không có inheritance)  │
│  ✅ Generics từ Go 1.18 — type-safe containers      │
└─────────────────────────────────────────────────────┘
```

**Bài tiếp theo:** [[Bai-3-Goroutines-Channels|Bài 3: Goroutines & Channels — Go Concurrency Model]]

---

**Bài tập:**
1. Tạo generic `Repository[T any]` interface với methods CRUD
2. Implement `UserRepository` và `ProductRepository` concrete structs
3. Viết `Stack[T]` dùng slice, test với int và string

---
*Tags: #go #structs #types #generics #pointers #zero-to-hero*
