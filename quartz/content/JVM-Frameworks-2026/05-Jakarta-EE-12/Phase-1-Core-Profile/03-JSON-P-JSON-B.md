# 03 — Jakarta JSON-P 2.2 + JSON-B 3.x

> **Specs:** Jakarta JSON Processing 2.2 + Jakarta JSON Binding 3.x | **Profile:** Core
> **Spring equivalent:** Jackson (`JsonNode` + `ObjectMapper`)
> **Prototype runtime:** Quarkus (dùng JSON-P/JSON-B mặc định)

---

## 1. Hai Spec Khác Nhau — Đừng Nhầm

```
JSON-P (Processing)  = Low-level DOM/Streaming API
                     = Jackson JsonNode / StAX equivalent
                     → Dùng khi cần parse/transform JSON linh hoạt

JSON-B (Binding)     = Object ↔ JSON serialization
                     = Jackson ObjectMapper equivalent
                     → Dùng khi map POJO ↔ JSON
```

Trong Spring Boot: Jackson làm **cả hai** vai trò.
Trong Jakarta EE: **tách biệt** — hai spec, hai API, dùng phối hợp.

---

## 2. JSON-P — Processing (Low-Level)

### 2.1 Đọc JSON

```java
// === JACKSON (Spring) ===
ObjectMapper mapper = new ObjectMapper();
JsonNode root = mapper.readTree(jsonString);
String name = root.get("name").asText();
JsonNode items = root.get("items");           // ArrayNode
items.forEach(item -> System.out.println(item.get("id").asText()));

// === JSON-P ===
JsonReader reader = Json.createReader(new StringReader(jsonString));
JsonObject root = reader.readObject();
reader.close();

String name = root.getString("name");
JsonArray items = root.getJsonArray("items");
items.forEach(item -> {
    JsonObject obj = (JsonObject) item;
    System.out.println(obj.getString("id"));
});
```

### 2.2 Build JSON

```java
// === JACKSON ===
ObjectNode node = mapper.createObjectNode();
node.put("id", "DOC-001");
node.put("title", "Contract ABC");
node.put("amount", 1500.0);
ArrayNode tags = node.putArray("tags");
tags.add("legal").add("finance");
String json = mapper.writeValueAsString(node);

// === JSON-P ===
JsonObject obj = Json.createObjectBuilder()
    .add("id", "DOC-001")
    .add("title", "Contract ABC")
    .add("amount", 1500.0)
    .add("tags", Json.createArrayBuilder()
        .add("legal")
        .add("finance"))
    .build();

String json = obj.toString();
// hoặc dùng JsonWriter:
StringWriter sw = new StringWriter();
try (JsonWriter writer = Json.createWriter(sw)) {
    writer.writeObject(obj);
}
```

### 2.3 JSON Pointer — Truy cập sâu

```java
// JSON-P có JSON Pointer (RFC 6901) — Jackson không có built-in
String jsonStr = """
    {"order": {"items": [{"id": "A1", "qty": 2}, {"id": "B2", "qty": 1}]}}
    """;

JsonStructure doc = Json.createReader(new StringReader(jsonStr)).read();

// Truy cập bằng JSON Pointer
JsonPointer ptr = Json.createPointer("/order/items/0/id");
JsonString val = (JsonString) ptr.getValue(doc);
System.out.println(val.getString()); // "A1"
```

### 2.4 JSON Patch — Modify Document (RFC 6902)

```java
// JSON-P JSON Patch — chuẩn hóa việc patch JSON
JsonPatch patch = Json.createPatchBuilder()
    .replace("/status", "APPROVED")
    .add("/approvedBy", "alice")
    .remove("/draft")
    .build();

JsonObject updated = patch.apply(originalDoc);
```

### 2.5 JSON Merge Patch (RFC 7396)

```java
// Merge patch — đơn giản hơn JSON Patch
JsonMergePatch mergePatch = Json.createMergePatch(
    Json.createObjectBuilder()
        .add("status", "APPROVED")
        .addNull("rejectedReason")  // null = delete field
        .build()
);
JsonValue updated = mergePatch.apply(originalDoc);
```

### 2.6 Streaming API — Xử lý JSON Lớn

```java
// === JSON-P Streaming (tương đương StAX) ===
// Dùng khi file JSON hàng trăm MB, không muốn load cả vào memory

// Parser (read)
try (JsonParser parser = Json.createParser(inputStream)) {
    while (parser.hasNext()) {
        JsonParser.Event event = parser.next();
        switch (event) {
            case KEY_NAME -> System.out.println("Key: " + parser.getString());
            case VALUE_STRING -> System.out.println("Val: " + parser.getString());
            case VALUE_NUMBER -> System.out.println("Num: " + parser.getBigDecimal());
            case START_ARRAY -> System.out.println("[");
            case END_ARRAY -> System.out.println("]");
        }
    }
}

// Generator (write streaming)
try (JsonGenerator gen = Json.createGenerator(outputStream)) {
    gen.writeStartObject()
       .write("id", "DOC-001")
       .write("title", "Contract")
       .writeStartArray("tags")
           .write("legal")
           .write("finance")
       .writeEnd()
    .writeEnd();
}
```

---

## 3. JSON-B — Binding (Object Mapping)

### 3.1 Basic Serialization

```java
// === JACKSON ===
ObjectMapper mapper = new ObjectMapper();
// Serialize
String json = mapper.writeValueAsString(document);
// Deserialize
Document doc = mapper.readValue(json, Document.class);

// === JSON-B ===
Jsonb jsonb = JsonbBuilder.create();
// Serialize
String json = jsonb.toJson(document);
// Deserialize
Document doc = jsonb.fromJson(json, Document.class);
jsonb.close();
```

### 3.2 Annotation Mapping

```java
// === JACKSON ===
public class Document {
    @JsonProperty("document_id")
    private String id;

    @JsonIgnore
    private String internalNote;

    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    private LocalDateTime createdAt;

    @JsonInclude(JsonInclude.Include.NON_NULL)
    private String optionalField;
}

// === JSON-B ===
public class Document {
    @JsonbProperty("document_id")
    private String id;

    @JsonbTransient                 // bỏ qua field này
    private String internalNote;

    @JsonbDateFormat("yyyy-MM-dd'T'HH:mm:ss")
    private LocalDateTime createdAt;

    @JsonbNillable                  // include null values
    private String optionalField;

    @JsonbNumberFormat("#,##0.00")  // format số
    private BigDecimal amount;
}
```

| Jackson | JSON-B |
|---|---|
| `@JsonProperty("name")` | `@JsonbProperty("name")` |
| `@JsonIgnore` | `@JsonbTransient` |
| `@JsonFormat(pattern=...)` | `@JsonbDateFormat(...)` |
| `@JsonInclude(NON_NULL)` | `@JsonbNillable` / config |
| `@JsonAlias` | Không có built-in |
| `@JsonCreator` | `@JsonbCreator` |
| `@JsonValue` | `@JsonbProperty` trên method |
| `@JsonTypeInfo` | `@JsonbTypeInfo` (JSON-B 3.0) |

### 3.3 Custom Serializer/Deserializer

```java
// === JACKSON ===
public class MoneySerializer extends JsonSerializer<Money> {
    @Override
    public void serialize(Money value, JsonGenerator gen,
            SerializerProvider provider) throws IOException {
        gen.writeStartObject();
        gen.writeNumberField("amount", value.amount());
        gen.writeStringField("currency", value.currency());
        gen.writeEndObject();
    }
}
@JsonSerialize(using = MoneySerializer.class)
private Money price;

// === JSON-B ===
public class MoneySerializer implements JsonbSerializer<Money> {
    @Override
    public void serialize(Money obj, JsonGenerator generator,
            SerializationContext ctx) {
        generator.writeStartObject();
        generator.write("amount", obj.amount());
        generator.write("currency", obj.currency());
        generator.writeEnd();
    }
}

public class MoneyDeserializer implements JsonbDeserializer<Money> {
    @Override
    public Money deserialize(JsonParser parser, DeserializationContext ctx,
            Type rtType) {
        JsonObject obj = parser.getObject();
        return new Money(
            obj.getJsonNumber("amount").bigDecimalValue(),
            obj.getString("currency")
        );
    }
}

// Apply
@JsonbTypeAdapter(MoneyAdapter.class)  // hoặc config khi build Jsonb
private Money price;
```

### 3.4 Config Jsonb Instance

```java
JsonbConfig config = new JsonbConfig()
    .withNullValues(true)                          // include null
    .withFormatting(true)                          // pretty print
    .withPropertyNamingStrategy(PropertyNamingStrategy.LOWER_CASE_WITH_UNDERSCORES)
    .withDateFormat("yyyy-MM-dd", Locale.ENGLISH)
    .withAdapters(new MoneyAdapter());

Jsonb jsonb = JsonbBuilder.create(config);
```

---

## 4. Prototype — Document Transform Pipeline

```java
// Scenario: nhận JSON từ legacy system, transform, validate, re-serialize

@ApplicationScoped
public class DocumentTransformService {

    private final Jsonb jsonb = JsonbBuilder.create(
        new JsonbConfig().withFormatting(false)
    );

    // Transform legacy format → internal format dùng JSON-P
    public JsonObject transformLegacyFormat(String legacyJson) {
        JsonObject legacy = Json.createReader(new StringReader(legacyJson))
            .readObject();

        return Json.createObjectBuilder()
            .add("id", legacy.getString("doc_id", ""))
            .add("title", legacy.getString("document_name", ""))
            .add("type", mapType(legacy.getString("category", "")))
            .add("status", "PENDING")
            .add("metadata", Json.createObjectBuilder()
                .add("source", "LEGACY_IMPORT")
                .add("originalId", legacy.getString("doc_id", "")))
            .build();
    }

    // Patch document dùng JSON Merge Patch
    public JsonObject applyPatch(JsonObject document, JsonObject patch) {
        JsonMergePatch mergePatch = Json.createMergePatch(patch);
        return (JsonObject) mergePatch.apply(document);
    }

    // Serialize DTO → JSON dùng JSON-B
    public String serialize(DocumentDTO dto) {
        return jsonb.toJson(dto);
    }

    // Deserialize → DTO
    public DocumentDTO deserialize(String json) {
        return jsonb.fromJson(json, DocumentDTO.class);
    }

    // Process large JSON stream
    public List<String> extractIdsFromBatch(InputStream stream) {
        List<String> ids = new ArrayList<>();
        boolean inItems = false;
        String lastKey = null;

        try (JsonParser parser = Json.createParser(stream)) {
            while (parser.hasNext()) {
                var event = parser.next();
                if (event == JsonParser.Event.KEY_NAME) {
                    lastKey = parser.getString();
                    if ("items".equals(lastKey)) inItems = true;
                } else if (inItems && event == JsonParser.Event.VALUE_STRING
                           && "id".equals(lastKey)) {
                    ids.add(parser.getString());
                }
            }
        }
        return ids;
    }

    private String mapType(String category) {
        return switch (category.toUpperCase()) {
            case "LEGAL" -> "CONTRACT";
            case "FIN"   -> "INVOICE";
            default      -> "REPORT";
        };
    }
}

// === DTO với JSON-B annotations ===
public class DocumentDTO {

    @JsonbProperty("document_id")
    public String id;

    @JsonbProperty("document_title")
    public String title;

    @JsonbTransient
    public String internalNote;

    @JsonbDateFormat("yyyy-MM-dd'T'HH:mm:ssZ")
    public ZonedDateTime createdAt;

    @JsonbNumberFormat("0.00")
    public BigDecimal amount;

    @JsonbNillable
    public String optionalTag;
}

// === REST Resource ===
@Path("/api/transform")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class TransformResource {

    @Inject DocumentTransformService svc;

    @POST
    @Path("/legacy")
    @Consumes(MediaType.TEXT_PLAIN)
    public Response transformLegacy(String legacyJson) {
        JsonObject result = svc.transformLegacyFormat(legacyJson);
        return Response.ok(result.toString()).build();
    }

    @PATCH
    @Path("/patch")
    public Response patch(JsonObject request) {
        JsonObject doc = request.getJsonObject("document");
        JsonObject patch = request.getJsonObject("patch");
        JsonObject result = svc.applyPatch(doc, patch);
        return Response.ok(result.toString()).build();
    }
}
```

```bash
./mvnw quarkus:dev

# Test transform
curl -X POST http://localhost:8080/api/transform/legacy \
  -H "Content-Type: text/plain" \
  -d '{"doc_id":"L001","document_name":"Contract","category":"LEGAL"}'

# Test patch
curl -X PATCH http://localhost:8080/api/transform/patch \
  -H "Content-Type: application/json" \
  -d '{
    "document": {"id":"D1","status":"PENDING","title":"Old"},
    "patch": {"status":"APPROVED","reviewedBy":"alice"}
  }'
```

---

## 5. Architect Notes

**Dùng JSON-P khi:**
- Transform JSON không cần POJO (schema-less data)
- Xử lý file JSON lớn (streaming)
- Implement JSON Patch / Merge Patch endpoint
- Dynamic JSON building

**Dùng JSON-B khi:**
- Serialize/deserialize DTO (giống Jackson)
- REST response body

**Thực tế trong Quarkus:** Mặc định dùng **Jackson** (không phải JSON-B) vì extension `rest-jackson`. Để dùng JSON-B phải add `rest-jsonb`. Trong production, Jackson vẫn phổ biến hơn vì ecosystem.

---

*[[02-Jakarta-REST]] | [[00-Overview]] | Next: [[04-Bean-Validation]]*
