---
Created by: Bách Đặng Thọ
Created time: 2025-08-30T23:12
---
Modern software development often involves complex systems that need to adapt quickly to changes, whether it's user requirements, technology updates, or market shifts.

Clean Architecture can help with this.

It is a software design philosophy that emphasizes creating systems that are easy to understand, maintain, and extend.

At its core, Clean Architecture tries to ensure that the most important parts of your application, like business rules and logic, are independent of external concerns such as frameworks, databases, or user interfaces.

Clean Architecture was popularized by Robert C. Martin, also known as Uncle Bob. He introduced the concept in his book Clean Architecture where he built upon earlier design paradigms like Hexagonal Architecture and Onion Architecture.

The main purpose of Clean Architecture is to:

- Make software maintainable

- Improve scalability

- Enhance the testability of components

- Decouple business logic from external details

In simple terms, Clean Architecture organizes a software system into layers, each with a specific responsibility. Dependencies flow only in one direction: toward the core business logic. This structure helps keep the system modular, testable, and resilient to changes.

In this article, we’ll understand what Clean Architecture is in detail. We’ll explore the key principles of Clean Architecture and also look at the various parts of the layered structure.

[![](https://substackcdn.com/image/fetch/$s_!55Wm!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F40cb8f80-601f-4364-a5a0-a34db7a96c26_2250x2814.png)](https://substackcdn.com/image/fetch/$s_!55Wm!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F40cb8f80-601f-4364-a5a0-a34db7a96c26_2250x2814.png)

## **Key Principles of Clean Architecture**

Clean Architecture is guided by a set of principles that help developers create systems that are scalable, maintainable, and testable.

Below are the key principles, explained with examples to illustrate their benefits.

### **1 - Separation of Concerns**

Separation of concerns is the practice of dividing a software system into distinct sections, each responsible for a specific aspect of the application.

This principle ensures that different parts of the system focus on their respective roles without overlapping responsibilities.

For example, it is considered a bad practice when a web controller handles HTTP requests, processes business logic, and interacts directly with the database. An improved design would be a controller that only handles HTTP requests, delegating business logic to a service layer and database interactions to a repository layer.

There are two main benefits of this approach:

- Each layer has a single responsibility, making the system easier to maintain.

- Changes in one layer (such as switching from an SQL database to a NoSQL database) do not require changes in other layers.

### **2 - Dependency Rule**

The dependency rule states that dependencies should flow inward, toward the system's core. Outer layers such as frameworks, UI, and databases depend on inner layers (business logic and entities), but not the other way around.

For example, a use case should not depend on a database schema or a specific UI framework. Instead, the database layer provides interfaces (for example, repositories) that the use case interacts with. If the database changes, the core business logic remains unaffected.

See the diagram below, which shows an example of the dependency rule principle.

[![](https://substackcdn.com/image/fetch/$s_!DJzN!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F1f164b5f-03f9-412c-ae65-099ab3fca63c_1938x1246.png)](https://substackcdn.com/image/fetch/$s_!DJzN!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F1f164b5f-03f9-412c-ae65-099ab3fca63c_1938x1246.png)

The benefits of this rule are as follows:

- Changes in outer layers, like replacing a database, do not impact the core business logic. Business rules remain stable even as technology evolves.

- Inner layers can be tested in isolation because they are not coupled with external systems.

- Components like the user interface or database can be swapped with minimal impact. For example, transitioning from a REST API to GraphQL affects only the Interface Adapters layer.

- The system grows easily by adding new features or technologies without disrupting the core logic.

- External systems (for example, web frameworks) are often volatile, with frequent updates or deprecations. By isolating these changes, the core remains unaffected.

### **3 - Single Responsibility Principle**

The single responsibility principle states that a class or module should have one, and only one, reason to change. Each component should focus on a specific task.

For example, it is considered bad practice when a single class manages user authentication and email notifications. It is better to have separate classes for authentication and notifications, each handling its responsibility

[![](https://substackcdn.com/image/fetch/$s_!lIte!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F9742a407-88b1-49f2-818e-bd8738132e2b_1938x1246.png)](https://substackcdn.com/image/fetch/$s_!lIte!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F9742a407-88b1-49f2-818e-bd8738132e2b_1938x1246.png)

The benefits of the single responsibility principle are as follows:

- Changes in one functionality (for example, modifying email-sending logic) do not impact unrelated parts of the system such as authentication.

- Improves code readability and reduces the risk of introducing bugs.

## **The Layered Structure of Clean Architecture**

Clean Architecture organizes a software system into layers, with each layer serving a distinct purpose.

See the diagram below that shows the various layers:

[![](https://substackcdn.com/image/fetch/$s_!tOwt!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F830153b2-22ba-4def-8e4e-a3ee63b2ab5d_1938x1246.png)](https://substackcdn.com/image/fetch/$s_!tOwt!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F830153b2-22ba-4def-8e4e-a3ee63b2ab5d_1938x1246.png)

These layers form concentric circles, where the core contains the most fundamental and unchanging parts of the system, and the outer layers handle technology-specific details like user interfaces and databases.

Let’s look at each layer in more detail.

### **1 - Entities (Core Business Rules)**

Entities represent the core business logic and rules of the application. We can also think of them as enterprise-level rules.

They encapsulate the most general and high-level concepts that remain constant, regardless of changes in the application or technology. Entities are independent of frameworks, databases, or any other external concerns.

Entities are the foundation upon which the rest of the application is built.

For example, in an e-commerce system, an Order entity may define rules such as:

- An order must have at least one item.

- Total cost = item cost * quantity.

### **2 - Use Cases (Application-Specific Business Rules)**

Use cases define the specific actions or workflows of the application. They orchestrate the interaction between entities and other layers to fulfill user requirements.

Their function is to encapsulate the business logic required for specific tasks and ensure that rules and workflows remain consistent.

For example, a "Place Order" use case interacts with the Order entity to validate items and calculate the total cost.

Use cases are independent of how they are triggered (for example, via a web interface or API).

See the diagram below that shows the overall flow of Clean Architecture in terms of the various layers.

[![](https://substackcdn.com/image/fetch/$s_!0bn3!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F163415ba-cbed-4f04-8539-3bc1c3a6fef3_1938x1246.png)](https://substackcdn.com/image/fetch/$s_!0bn3!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F163415ba-cbed-4f04-8539-3bc1c3a6fef3_1938x1246.png)

### **3 - Interface Adapters**

Interface Adapters bridge the core logic (Entities and Use Cases) with external systems (databases, UI, or APIs).

They convert data formats between layers and keep business logic unaware of external data structures.

There are three different types of interface adapters:

### **Controllers**

They receive HTTP requests, extract data, and call the appropriate Use Case. See the example below for a sample Controller implementation in Spring Boot.

```Plain
@RestController
@RequestMapping("/orders")
public class OrderController {
    private final PlaceOrderUseCase placeOrderUseCase;

    public OrderController(PlaceOrderUseCase placeOrderUseCase) {
        this.placeOrderUseCase = placeOrderUseCase;
    }

    @PostMapping
    public ResponseEntity<Map<String, Object>> placeOrder(@RequestBody List<OrderItem> items) {
        double total = placeOrderUseCase.execute(items);
        Map<String, Object> response = Map.of("total", total);
        return ResponseEntity.ok(response);
    }
}
```

### **Gateways**

Gateways abstract external systems like databases or APIs and provide clean interfaces.

See the code example below where the OrderRepository interface defines a clean contract for data persistence.

```Plain
public interface OrderRepository {
    void save(Order order);
}
```

### **Presenters**

Presenters format the output from Use Cases for external systems, like APIs or user interfaces.

Here’s an example of a possible presenter component.

```Plain
@Component
public class OrderPresenter {
    public Map<String, Object> formatResponse(double total) {
        return Map.of("message", String.format("The total cost of your order is $%.2f", total));
    }
}
```

### **4 - Frameworks and Drivers**

This outermost layer includes the technical details of the system, such as frameworks, databases, UI, and external APIs. It is the most volatile and prone to change.

The layer provides the infrastructure needed to support the application (for example, databases and web servers). This layer contains no business logic but only implementation details for interacting with external systems.

For example:

- A web framework like Django or Spring to handle routing and HTTP requests.

- A database driver for accessing stored data.

## **Benefits of Clean Architecture**

Clean Architecture is designed to create systems that are scalable, testable, flexible, maintainable, and portable.

[![](https://substackcdn.com/image/fetch/$s_!bhDy!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F3053bb88-2a32-45b9-a86b-cbed156dd0c6_1938x1246.png)](https://substackcdn.com/image/fetch/$s_!bhDy!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F3053bb88-2a32-45b9-a86b-cbed156dd0c6_1938x1246.png)

Let’s look at each benefit in more detail.

### **1 - Scalability**

Clean Architecture supports scalability by organizing the system into modular layers, allowing new features or components to be added without disrupting existing functionality.

New functionality can be added incrementally without significant refactoring, ensuring the application grows without compromising stability.

For example, an e-commerce platform may need to add a recommendation engine. With Clean Architecture, a new RecommendProductsUseCase can be added to the Use Cases layer. The new feature interacts with existing Entities (Product, Order) and integrates seamlessly without modifying unrelated layers.

See the code example below for reference:

```Plain
@Service
public class RecommendProductsUseCase {
    private final ProductRepository productRepository;

    public RecommendProductsUseCase(ProductRepository productRepository) {
        this.productRepository = productRepository;
    }

    public List<Product> recommend(String userId) {
        // Business logic for recommendations
        return productRepository.findRecommendationsForUser(userId);
    }
}
```

### **2 - Testability**

Clean architecture makes the system highly testable by isolating business logic in the inner layers (Entities and Use Cases).

Core business logic can be tested independently, reducing reliance on external systems and enabling faster, more reliable tests.

External dependencies, like databases and frameworks, are mocked or stubbed during testing. For example, to test a “Place Order” use case, we can use a mock repository to test the core logic without requiring a real database.

### **3 - Flexibility**

The layered structure ensures flexibility by decoupling business logic from frameworks and technologies, allowing components to be swapped without affecting the entire system.

Switching technologies becomes manageable, saving time and reducing the risk of introducing bugs.

For example, a project transitions from using a SQL database to a NoSQL database. With a proper Clean Architecture implementation, only the repository layer (Gateway) needs modification. The Use Cases and Entities remain unaffected.

### **4 - Maintainability**

Clean Architecture reduces technical debt by separating concerns and enforcing dependency direction.

This ensures that changes can be made without unintended consequences. Developers can confidently make changes, knowing that the rest of the system remains intact.

For example, consider that a payment gateway integration needs to be updated due to new API changes. With clean architecture, the changes are confined to the Gateway layer (for example, PaymentGatewayAdapter). Other parts of the system, like the Use Cases and Entities, can stay unaffected.

```Plain
@Component
public class PaymentGatewayAdapter {
    public PaymentResponse processPayment(PaymentRequest request) {
        // Updated API call logic
        return externalPaymentService.execute(request);
    }
}
```

### **5 - Portability**

Since the core logic is independent of frameworks, the application can be easily ported to different platforms or technologies.

The core application logic can be reused across web, mobile, and desktop platforms, reducing duplication and development time.

For example, a company decides to expand its application to support a desktop client. With Clean Architecture, the business logic (Entities and Use Cases) is reused. Only a new Interface Adapter layer (for the desktop client) needs to be implemented.

## **Clean Architecture And Common Pain Points**

Clean architecture addresses some common pain points with software development such as:

- **High Coupling:** Tightly coupled systems make it difficult to replace or upgrade components. Clean Architecture enforces dependency direction, ensuring that core business logic is decoupled from external systems.

- **Fragility:** Changes in one part of the system unintentionally break other parts. Layer isolation ensures changes are localized, reducing the risk of cascading failures.

- **Immobility:** Reusing parts of the system in other applications is challenging due to intertwined dependencies. By isolating core logic, Clean Architecture allows the reuse of business rules and workflows in other contexts.

- **Testing Challenges:** Systems dependent on databases and frameworks are hard to test in isolation. Mocking external dependencies enables fast, reliable testing of core functionality.

## **Challenges of Clean Architecture**

While Clean Architecture is widely regarded as a great practice for building robust and maintainable software, it is not without challenges.

Some of the main challenges with Clean Architecture are as follows:

- **Steep Learning Curve:** Clean Architecture introduces new concepts like the layered structure, dependency rule, and separation of concerns, which can be overwhelming for developers, especially those accustomed to simpler architectures or tightly coupled designs.

- **Performance Concerns:** The abstraction layers in Clean Architecture can introduce overhead, leading to potential performance issues in high-throughput applications. This can be due to multiple layers of indirection and excessive object creation or conversions between layers.

- **Integrating with Legacy Systems:** Migrating a legacy codebase to Clean Architecture can be complex and time-consuming. Legacy systems are often tightly coupled, making it hard to extract core business logic or implement a clean separation of concerns.

- **Lack of Tooling Support:** Some frameworks or tools do not inherently support Clean Architecture, requiring additional effort to implement its principles. This can make it difficult to structure projects and increase the setup time for repositories, dependency injection, and testing frameworks.

## **Summary**

In this article, we’ve taken a detailed look at Clean Architecture and its key principles and benefits.

Let’s summarize our learnings in brief:

- Clean Architecture organizes systems into layers to make them maintainable, scalable, and testable by decoupling business logic from external systems.

- There are some key principles of clean architecture such as separation of concerns, dependency rule, and single responsibility principle.

- Clean architecture follows a layered structure with multiple components such as entities, use cases, interface adapters, and frameworks.

- Entities represent the core business rules and remain independent of external factors.

- Use Cases define workflows specific to the application, orchestrating interactions between layers.

- Interface Adapters bridge the core logic with external systems like databases, APIs, and user interfaces.

- Frameworks and Drivers handle technical details such as routing, persistence, and integration.

- The benefits of clean architecture are scalability, testability, flexibility, maintainability, and portability.

- Some challenges of clean architecture are the learning curve, performance concerns, legacy integration, and tooling support.