# 04 — Jakarta Validation 4.0

> **Spec:** Jakarta Bean Validation 4.0 | **Profile:** Core
> **Spring equivalent:** Spring Validation + Hibernate Validator
> **Ghi chú:** Spring Boot **implement spec này** — anh đã dùng rồi, chỉ cần học phần nâng cao

---

## 1. Spec Says

Jakarta Validation định nghĩa API để validate object graph thông qua annotations. **Hibernate Validator** là reference implementation — được dùng trong cả Spring Boot lẫn Quarkus. Về bản chất, `@NotNull`, `@Size`... trong Spring Boot và Jakarta EE là **cùng một spec**.

Điểm cần học ở đây: custom constraints, group validation, programmatic API — những thứ ít dùng trong Spring hàng ngày.

---

## 2. Built-in Constraints (Cheatsheet)

```java
public class DocumentRequest {
    // Null / Blank
    @NotNull                    // không null (allow "")
    @NotEmpty                   // không null, không ""
    @NotBlank                   // không null, không "", không "   "
    private String title;

    // Size
    @Size(min = 2, max = 100)  // String length / Collection size
    private String code;

    @Length(min = 5, max = 200) // Hibernate-specific, giống @Size
    private String description;

    // Numeric
    @Min(1) @Max(9999)
    private int year;

    @Positive                   // > 0
    @PositiveOrZero             // >= 0
    private BigDecimal amount;

    @Negative                   // < 0
    @NegativeOrZero             // <= 0
    private int adjustment;

    @Digits(integer = 10, fraction = 2) // precision
    private BigDecimal price;

    @DecimalMin("0.01") @DecimalMax("999999.99")
    private BigDecimal fee;

    // String pattern
    @Email
    private String email;

    @Pattern(regexp = "^[A-Z]{2,3}-\\d{6}$", message = "Invalid document code")
    private String documentCode;  // e.g., VN-123456

    // Boolean
    @AssertTrue
    private boolean termsAccepted;

    @AssertFalse
    private boolean blacklisted;

    // Date
    @Past                       // phải là ngày quá khứ
    @PastOrPresent
    private LocalDate birthDate;

    @Future                     // phải là ngày tương lai
    @FutureOrPresent
    private LocalDate expiryDate;

    // Nested object
    @Valid                      // cascade validation vào nested object
    @NotNull
    private AddressRequest address;

    // Collection
    @Valid                      // cascade vào từng element
    @Size(min = 1, max = 10)
    private List<@NotBlank String> tags;
}
```

---

## 3. Custom Constraint — Cái Quan Trọng Nhất

### 3.1 Tạo Custom Annotation

```java
// Scenario: validate document code format theo nghiệp vụ VPBank
// Format: VPB-YYYYMM-NNNNNN (e.g., VPB-202506-000123)

// Bước 1: Define annotation
@Documented
@Constraint(validatedBy = DocumentCodeValidator.class)
@Target({FIELD, METHOD, PARAMETER, ANNOTATION_TYPE})
@Retention(RUNTIME)
public @interface ValidDocumentCode {

    String message() default "Invalid document code format. Expected: VPB-YYYYMM-NNNNNN";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};

    // Optional: configurable prefix
    String prefix() default "VPB";
}

// Bước 2: Implement validator
public class DocumentCodeValidator
        implements ConstraintValidator<ValidDocumentCode, String> {

    private String prefix;

    @Override
    public void initialize(ValidDocumentCode annotation) {
        this.prefix = annotation.prefix();
    }

    @Override
    public boolean isValid(String value, ConstraintValidatorContext ctx) {
        if (value == null) return true; // null check là việc của @NotNull

        String pattern = "^" + prefix + "-\\d{6}-\\d{6}$";
        if (!value.matches(pattern)) {
            // Custom message với field info
            ctx.disableDefaultConstraintViolation();
            ctx.buildConstraintViolationWithTemplate(
                "Format sai. Cần: " + prefix + "-YYYYMM-NNNNNN, nhận được: " + value
            ).addConstraintViolation();
            return false;
        }

        // Validate YYYYMM là tháng hợp lệ
        String yearMonth = value.split("-")[1];
        int year = Integer.parseInt(yearMonth.substring(0, 4));
        int month = Integer.parseInt(yearMonth.substring(4, 6));

        return year >= 2000 && year <= 2099 && month >= 1 && month <= 12;
    }
}

// Bước 3: Sử dụng
public class CreateDocumentRequest {
    @NotBlank
    @ValidDocumentCode(prefix = "VPB")
    private String code;
}
```

### 3.2 Cross-Field Validation (Class-Level)

```java
// Validate relation giữa nhiều field
@Documented
@Constraint(validatedBy = DateRangeValidator.class)
@Target(TYPE)         // apply trên class, không phải field
@Retention(RUNTIME)
public @interface ValidDateRange {
    String message() default "End date must be after start date";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
    String startField();
    String endField();
}

public class DateRangeValidator
        implements ConstraintValidator<ValidDateRange, Object> {

    private String startField;
    private String endField;

    @Override
    public void initialize(ValidDateRange annotation) {
        this.startField = annotation.startField();
        this.endField = annotation.endField();
    }

    @Override
    public boolean isValid(Object obj, ConstraintValidatorContext ctx) {
        try {
            var start = (LocalDate) getField(obj, startField);
            var end = (LocalDate) getField(obj, endField);
            if (start == null || end == null) return true;

            if (!end.isAfter(start)) {
                ctx.disableDefaultConstraintViolation();
                ctx.buildConstraintViolationWithTemplate(
                    endField + " phải sau " + startField
                ).addPropertyNode(endField).addConstraintViolation();
                return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private Object getField(Object obj, String name) throws Exception {
        var field = obj.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(obj);
    }
}

// Sử dụng
@ValidDateRange(startField = "effectiveFrom", endField = "effectiveTo")
public class ContractRequest {
    @NotNull LocalDate effectiveFrom;
    @NotNull LocalDate effectiveTo;
    @NotBlank String title;
}
```

### 3.3 CDI-Aware Validator (Jakarta EE specific)

```java
// Trong Jakarta EE, ConstraintValidator có thể @Inject CDI beans
// (Spring cũng hỗ trợ với SpringConstraintValidatorFactory)
public class UniqueDocumentCodeValidator
        implements ConstraintValidator<UniqueDocumentCode, String> {

    @Inject                     // CDI injection trong validator!
    DocumentRepository repo;

    @Override
    public boolean isValid(String code, ConstraintValidatorContext ctx) {
        if (code == null) return true;
        return repo.findByCode(code).isEmpty();
    }
}
```

---

## 4. Validation Groups

```java
// Groups cho phép validate theo scenario khác nhau
public interface OnCreate {}
public interface OnUpdate {}
public interface OnSubmit {}

public class DocumentRequest {

    @Null(groups = OnCreate.class)          // id phải null khi create
    @NotBlank(groups = OnUpdate.class)      // id phải có khi update
    private String id;

    @NotBlank(groups = {OnCreate.class, OnUpdate.class})
    private String title;

    @NotNull(groups = OnSubmit.class)       // chỉ check khi submit
    private String approverSignature;

    @Valid                                   // cascade tất cả groups
    private AddressRequest address;
}

// Sử dụng trong JAX-RS (Jakarta REST)
@POST
public Response create(@Valid @ConvertGroup(to = OnCreate.class)
                       DocumentRequest req) { ... }

// Sử dụng programmatic
Validator validator = Validation.buildDefaultValidatorFactory().getValidator();
Set<ConstraintViolation<DocumentRequest>> violations =
    validator.validate(req, OnCreate.class, Default.class);
```

---

## 5. Programmatic Validation API

```java
// === Dùng trực tiếp, không qua annotation ===
@ApplicationScoped
public class ValidationService {

    @Inject
    Validator validator; // CDI inject Validator

    public <T> void validate(T object, Class<?>... groups) {
        Set<ConstraintViolation<T>> violations = validator.validate(object, groups);
        if (!violations.isEmpty()) {
            throw new ValidationException(buildMessage(violations));
        }
    }

    public <T> Map<String, List<String>> validateToMap(T object) {
        return validator.validate(object).stream()
            .collect(Collectors.groupingBy(
                v -> v.getPropertyPath().toString(),
                Collectors.mapping(ConstraintViolation::getMessage, Collectors.toList())
            ));
    }

    // Validate single property
    public <T> void validateProperty(T object, String propertyName) {
        Set<ConstraintViolation<T>> violations =
            validator.validateProperty(object, propertyName);
        if (!violations.isEmpty()) throw new ValidationException("...");
    }

    private <T> String buildMessage(Set<ConstraintViolation<T>> violations) {
        return violations.stream()
            .map(v -> v.getPropertyPath() + ": " + v.getMessage())
            .collect(Collectors.joining("; "));
    }
}
```

---

## 6. Jakarta Validation 4.0 — Cái Mới

- **`@NotBlank`, `@NotEmpty` trên collection elements:** `List<@NotBlank String>`
- **Record support:** validate record component trực tiếp
- **Method validation nâng cao:** validate return value, cross-parameter

```java
// Record validation (4.0)
public record DocumentCode(
    @NotBlank @ValidDocumentCode String value
) {}

// Method return value validation
public class DocumentService {

    @NotNull
    @Valid
    public DocumentDTO findById(@NotBlank String id) { // validate param
        return repo.findById(id).orElse(null);          // validate return
    }
}
```

---

## 7. Prototype — Document Validation Pipeline

```java
// === Custom Constraints ===
@Constraint(validatedBy = VietnamPhoneValidator.class)
@Target(FIELD) @Retention(RUNTIME)
public @interface VietnamPhone {
    String message() default "Số điện thoại Việt Nam không hợp lệ";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}

public class VietnamPhoneValidator
        implements ConstraintValidator<VietnamPhone, String> {
    @Override
    public boolean isValid(String v, ConstraintValidatorContext ctx) {
        if (v == null) return true;
        // 0[35789]\d{8} — Viettel/Mobifone/Vinaphone
        return v.matches("^0[35789]\\d{8}$");
    }
}

// === Request DTO ===
@ValidDateRange(startField = "effectiveFrom", endField = "effectiveTo")
public class CreateContractRequest {

    @NotBlank(message = "Tiêu đề không được trống")
    @Size(max = 200)
    public String title;

    @NotBlank
    @ValidDocumentCode
    public String code;

    @NotBlank
    @Email
    public String contactEmail;

    @VietnamPhone
    public String contactPhone;

    @NotNull
    @Positive
    @Digits(integer = 15, fraction = 2)
    public BigDecimal contractValue;

    @NotNull
    @FutureOrPresent
    public LocalDate effectiveFrom;

    @NotNull
    @Future
    public LocalDate effectiveTo;

    @Size(min = 1, max = 5)
    public List<@NotBlank @Size(max = 50) String> tags;
}

// === Resource với ExceptionMapper ===
@Path("/api/contracts")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class ContractResource {

    @POST
    public Response create(@Valid CreateContractRequest req) {
        // Nếu validation fail → ConstraintViolationException
        // được bắt bởi ExceptionMapper bên dưới
        return Response.status(201)
            .entity(Map.of("code", req.code, "status", "CREATED"))
            .build();
    }
}

// ExceptionMapper để trả về lỗi dạng chuẩn
@Provider
public class ValidationExceptionMapper
        implements ExceptionMapper<ConstraintViolationException> {

    @Override
    public Response toResponse(ConstraintViolationException ex) {
        Map<String, List<String>> errors = ex.getConstraintViolations()
            .stream()
            .collect(Collectors.groupingBy(
                v -> extractField(v.getPropertyPath().toString()),
                Collectors.mapping(ConstraintViolation::getMessage,
                                   Collectors.toList())
            ));
        return Response.status(422) // Unprocessable Entity
            .entity(Map.of("errors", errors))
            .build();
    }

    private String extractField(String path) {
        // "create.req.title" → "title"
        String[] parts = path.split("\\.");
        return parts[parts.length - 1];
    }
}
```

```bash
# Test validation errors
curl -X POST http://localhost:8080/api/contracts \
  -H "Content-Type: application/json" \
  -d '{
    "title": "",
    "code": "INVALID",
    "contactEmail": "not-email",
    "contactPhone": "123",
    "contractValue": -100,
    "effectiveFrom": "2020-01-01",
    "effectiveTo": "2019-01-01"
  }'

# Kết quả:
# {
#   "errors": {
#     "title": ["Tiêu đề không được trống"],
#     "code": ["Invalid document code format"],
#     "contactEmail": ["must be a well-formed email address"],
#     "contactPhone": ["Số điện thoại Việt Nam không hợp lệ"],
#     "contractValue": ["must be greater than 0"],
#     "effectiveTo": ["effectiveTo phải sau effectiveFrom"]
#   }
# }
```

---

## 8. Architect Notes

**Dùng tốt ở PDMS:**
- `@ValidDocumentCode` cho mã hồ sơ theo format nghiệp vụ
- Cross-field validation cho date range của hợp đồng
- CDI-aware validator để check uniqueness trong DB
- `Validator` programmatic trong batch processing (không qua REST)

---

*[[03-JSON-P-JSON-B]] | [[00-Overview]] | Next: [[05-JPA-Deep-Dive]]*
