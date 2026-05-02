---
Created by: Bách Đặng Thọ
Created time: 2024-11-14T22:47
---
### **Serialization và Deserialization: Giải thích chuyên sâu**

### **Serialization là gì?**

Serialization là quá trình chuyển đổi một cấu trúc dữ liệu hoặc một đối tượng trong bộ nhớ (ví dụ: một đối tượng trong lập trình hướng đối tượng) thành một định dạng có thể được lưu trữ (như trong file, cơ sở dữ liệu) hoặc truyền tải (qua mạng). Định dạng này thường là một **chuỗi byte** (dạng binary) hoặc đôi khi là một chuỗi ký tự có thể đọc được (như JSON, XML). Mục tiêu của serialization là để dữ liệu có thể được lưu lại hoặc gửi đi, sau đó khôi phục lại ở một nơi khác hoặc thời điểm khác.

### **Deserialization là gì?**

Deserialization là quá trình ngược lại của serialization. Nó lấy chuỗi byte hoặc chuỗi ký tự đã được tạo ra từ serialization và chuyển đổi ngược lại thành cấu trúc dữ liệu hoặc đối tượng ban đầu trong bộ nhớ để chương trình có thể sử dụng.

### **Hoạt động về mặt kỹ thuật**

1. **Serialization:**
    
    - **Phân tích đối tượng:** Quá trình bắt đầu bằng việc phân tích cấu trúc của đối tượng cần serialize. Ví dụ, nếu đó là một đối tượng trong Java, nó bao gồm các thuộc tính (fields) như số nguyên, chuỗi, hoặc các đối tượng con.
    
    - **Mã hóa dữ liệu:** Mỗi thuộc tính được chuyển đổi thành một dạng byte theo một quy tắc cụ thể. Chẳng hạn:
        
        - Số nguyên (integer) có thể được mã hóa thành 4 byte.
        
        - Chuỗi (string) thường được mã hóa với độ dài của chuỗi đi kèm, theo sau là các byte biểu diễn ký tự.
        
        - Các đối tượng phức tạp hơn (như mảng, danh sách) được mã hóa tuần tự từng phần tử.
        
    
    - **Xử lý tham chiếu:** Nếu đối tượng có tham chiếu đến các đối tượng khác (ví dụ: con trỏ hoặc liên kết), serialization phải xử lý để đảm bảo tính toàn vẹn của dữ liệu, hoặc bằng cách mã hóa cả đối tượng được tham chiếu hoặc đánh dấu tham chiếu.
    
    - **Tạo byte stream:** Cuối cùng, tất cả các byte được mã hóa từ các thành phần của đối tượng được ghép lại thành một chuỗi byte duy nhất.
    

1. **Deserialization:**
    
    - **Đọc byte stream:** Quá trình bắt đầu bằng việc đọc chuỗi byte đã được tạo từ serialization.
    
    - **Phân tích schema (nếu có):** Với các công cụ như Avro hoặc Protobuf, một **schema** (lược đồ) được sử dụng để hiểu cách dữ liệu được tổ chức trong chuỗi byte.
    
    - **Giải mã dữ liệu:** Mỗi phần của chuỗi byte được giải mã ngược lại thành các thuộc tính của đối tượng theo quy tắc đã định nghĩa trong serialization.
    
    - **Tái tạo đối tượng:** Các thuộc tính được gán vào một đối tượng mới trong bộ nhớ, khôi phục lại trạng thái ban đầu của nó, bao gồm cả các tham chiếu nếu có.
    

### **Ví dụ minh họa**

Giả sử bạn có một đối tượng đơn giản:

```JSON
{
  "name": "John",
  "age": 30
}
```

- **Serialization:** Đối tượng này có thể được chuyển thành một chuỗi byte như 04 4A 6F 68 6E 1E (trong đó 04 là độ dài của "John", 4A 6F 68 6E là mã hex của "John", và 1E là mã của số 30).

- **Deserialization:** Chuỗi byte này được đọc lại, phân tích và tái tạo thành đối tượng { "name": "John", "age": 30 }.

Serialization và deserialization rất quan trọng trong các hệ thống phân tán, lưu trữ dữ liệu, và truyền dữ liệu qua mạng, vì chúng cho phép dữ liệu di chuyển giữa các môi trường khác nhau một cách hiệu quả.

---

### **So sánh Apache Avro và Protocol Buffers (Protobuf)**

### **Apache Avro**

- **Đặc điểm:**  
    Avro là một hệ thống serialization được phát triển bởi Apache. Nó sử dụng một **schema** định nghĩa bằng JSON để mô tả cấu trúc dữ liệu. Dữ liệu khi được serialize sẽ bao gồm schema này, giúp Avro tự mô tả (self-describing) và hỗ trợ tốt cho **schema evolution** (thay đổi cấu trúc dữ liệu theo thời gian).

- **Ưu điểm:**
    
    - **Schema evolution linh hoạt:** Vì schema được nhúng trong dữ liệu serialize, Avro có thể xử lý các phiên bản schema khác nhau mà không làm hỏng dữ liệu cũ.
    
    - **Nén dữ liệu tốt:** Avro hỗ trợ nén hiệu quả, giúp giảm kích thước dữ liệu khi lưu trữ hoặc truyền tải.
    
    - **Hỗ trợ nhiều ngôn ngữ:** Avro có thư viện cho nhiều ngôn ngữ lập trình như Java, Python, C++, v.v.
    
    - **Phù hợp với big data:** Thường được sử dụng trong các hệ thống như Hadoop, Kafka.
    

- **Nhược điểm:**
    
    - **Hiệu suất:** Serialization và deserialization của Avro có thể chậm hơn so với Protobuf trong một số trường hợp do phải xử lý schema nhúng.
    
    - **Phức tạp trong schema lớn:** Schema định nghĩa bằng JSON có thể trở nên khó quản lý với các cấu trúc dữ liệu phức tạp.
    

### **Protocol Buffers (Protobuf)**

- **Đặc điểm:**  
    Protobuf là một công cụ serialization do Google phát triển. Nó sử dụng một ngôn ngữ định nghĩa giao diện (IDL) để viết **schema**, sau đó schema này được biên dịch thành mã code cho các ngôn ngữ lập trình cụ thể. Protobuf tập trung vào hiệu suất cao và kích thước dữ liệu nhỏ.

- **Ưu điểm:**
    
    - **Hiệu suất cao:** Serialization và deserialization của Protobuf nhanh hơn Avro, rất phù hợp với các hệ thống yêu cầu độ trễ thấp (low-latency) như gRPC.
    
    - **Kích thước dữ liệu nhỏ:** Dữ liệu serialize của Protobuf rất gọn nhẹ (compact), giúp tiết kiệm băng thông.
    
    - **Hỗ trợ nhiều ngôn ngữ:** Có hỗ trợ tốt cho các ngôn ngữ phổ biến như Java, C++, Python, Go, v.v.
    

- **Nhược điểm:**
    
    - **Schema evolution phức tạp hơn:** Protobuf yêu cầu quản lý schema cẩn thận để đảm bảo tương thích giữa các phiên bản (ví dụ: không được xóa field mà không đánh dấu deprecated).
    
    - **Yêu cầu biên dịch:** Schema phải được biên dịch thành mã code trước khi sử dụng, làm tăng độ phức tạp trong quá trình triển khai.
    

### **So sánh chi tiết**

|   |   |   |
|---|---|---|
|Tiêu chí|Apache Avro|Protocol Buffers (Protobuf)|
|**Schema Evolution**|Linh hoạt, schema nhúng trong dữ liệu|Hỗ trợ, nhưng cần quản lý cẩn thận|
|**Hiệu suất**|Tốt, nhưng chậm hơn Protobuf|Rất cao, tối ưu cho độ trễ thấp|
|**Kích thước dữ liệu**|Nhỏ, có nén tốt|Rất nhỏ, tối ưu hóa kích thước|
|**Hỗ trợ ngôn ngữ**|Nhiều ngôn ngữ, không cần biên dịch|Nhiều ngôn ngữ, cần biên dịch schema|
|**Dễ sử dụng**|Dễ trong big data, tự mô tả|Phức tạp hơn do cần biên dịch|

---

### **Cách triển khai**

### **Apache Avro**

- **Bước 1: Định nghĩa schema**  
    Schema được viết bằng JSON. Ví dụ:
    
    ```JSON
    {
      "type": "record",
      "name": "User",
      "fields": [
        {"name": "name", "type": "string"},
        {"name": "age", "type": "int"}
      ]
    }
    ```
    

- **Bước 2: Sử dụng thư viện Avro**  
    Sử dụng thư viện Avro (ví dụ: trong Java hoặc Python) để serialize và deserialize dữ liệu trực tiếp từ schema. Không cần biên dịch schema trước.

- **Bước 3: Serialize và deserialize**  
    Dữ liệu được serialize kèm schema, và quá trình deserialize sử dụng schema này để tái tạo đối tượng.

### **Protocol Buffers (Protobuf)**

- **Bước 1: Định nghĩa schema**  
    Schema được viết bằng ngôn ngữ IDL trong file .proto. Ví dụ:
    
    ```JSON
    message User {
      string name = 1;
      int32 age = 2;
    }
    ```
    

- **Bước 2: Biên dịch schema**  
    Sử dụng công cụ protoc để biên dịch schema thành mã code cho ngôn ngữ cụ thể (như Java, Python).

- **Bước 3: Sử dụng mã code**  
    Sử dụng mã code đã biên dịch để serialize và deserialize dữ liệu.

---

### **Kết luận**

- **Serialization và Deserialization** là các quá trình quan trọng để lưu trữ và truyền dữ liệu, hoạt động bằng cách mã hóa và giải mã dữ liệu thành/dựa trên chuỗi byte theo một cấu trúc xác định.

- **Apache Avro** phù hợp với các hệ thống big data, có khả năng hỗ trợ schema evolution tốt và dễ sử dụng trong môi trường phân tán.

- **Protocol Buffers (Protobuf)** nổi bật với hiệu suất cao và kích thước dữ liệu nhỏ, lý tưởng cho các ứng dụng yêu cầu tốc độ và độ trễ thấp.

Lựa chọn giữa Avro và Protobuf phụ thuộc vào yêu cầu cụ thể của hệ thống: nếu cần hiệu suất tối ưu và không ngại quản lý schema, Protobuf là lựa chọn tốt; nếu cần sự linh hoạt trong schema evolution và tích hợp với big data, Avro sẽ phù hợp hơn.