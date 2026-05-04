# 13 — Jakarta Faces 5.0 (JSF)

> **Spec:** Jakarta Faces 5.0 | **Profile:** Web Profile
> **Spring equivalent:** Thymeleaf / Vaadin (không có direct equiv)
> **Relevance 2026:** Thấp cho new projects — quan trọng để đọc hiểu legacy code

---

## 1. Spec Says

Jakarta Faces (JSF) là **component-based server-side UI framework**. Triết lý: developer làm việc với UI components trong Java, framework quản lý HTML rendering và state management.

Khác hoàn toàn với Spring MVC + Thymeleaf:
- JSF: **stateful, component-based** — state lưu trên server hoặc client
- Spring MVC + Thymeleaf: **stateless, template-based** — mỗi request render lại HTML

---

## 2. Architecture

```
Browser ──HTTP──→ FacesServlet ──→ Component Tree (UIComponent)
                                          │
                                   Managed Beans (CDI)
                                          │
                                   Business Logic
```

---

## 3. Managed Beans (CDI Integration)

```java
// === SPRING MVC + Thymeleaf ===
@Controller
public class DocumentController {
    @Autowired DocumentService svc;

    @GetMapping("/documents")
    public String list(Model model) {
        model.addAttribute("documents", svc.findAll());
        return "documents/list"; // templates/documents/list.html
    }

    @PostMapping("/documents/create")
    public String create(@ModelAttribute DocumentForm form,
                         BindingResult result,
                         RedirectAttributes attrs) {
        if (result.hasErrors()) return "documents/create";
        svc.create(form);
        attrs.addFlashAttribute("success", "Document created");
        return "redirect:/documents";
    }
}

// === JAKARTA FACES — CDI Backing Bean ===
@Named("documentBean")      // EL name cho Facelets: #{documentBean.list}
@ViewScoped                 // Scoped to current view (JSF-specific)
public class DocumentBackingBean implements Serializable {

    @Inject DocumentService svc;

    private List<Document> documents;
    private Document newDocument = new Document();
    private String searchQuery;

    @PostConstruct
    public void init() {
        loadDocuments();
    }

    private void loadDocuments() {
        this.documents = svc.findAll();
    }

    // Action method — trả về navigation outcome
    public String create() {
        try {
            svc.create(newDocument);
            FacesContext.getCurrentInstance()
                .addMessage(null,
                    new FacesMessage(FacesMessage.SEVERITY_INFO,
                        "Success", "Document created"));
            newDocument = new Document();
            loadDocuments();
            return null; // stay on page
        } catch (Exception e) {
            FacesContext.getCurrentInstance()
                .addMessage(null,
                    new FacesMessage(FacesMessage.SEVERITY_ERROR,
                        "Error", e.getMessage()));
            return null;
        }
    }

    public String viewDetail(String id) {
        return "detail?faces-redirect=true&id=" + id; // navigate
    }

    public void search() {
        this.documents = svc.search(searchQuery);
    }

    // Getters & setters
    public List<Document> getDocuments() { return documents; }
    public Document getNewDocument() { return newDocument; }
    public void setNewDocument(Document d) { this.newDocument = d; }
    public String getSearchQuery() { return searchQuery; }
    public void setSearchQuery(String q) { this.searchQuery = q; }
}
```

---

## 4. Facelets Template (XHTML)

```xml
<!-- src/main/webapp/documents/list.xhtml -->
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:h="jakarta.faces.html"
      xmlns:f="jakarta.faces.core"
      xmlns:p="http://primefaces.org/ui">

<h:head>
    <title>Documents</title>
</h:head>

<h:body>
    <!-- Messages -->
    <h:messages globalOnly="true" showDetail="true"/>

    <!-- Search Form -->
    <h:form id="searchForm">
        <h:inputText value="#{documentBean.searchQuery}"
                     placeholder="Search documents..."/>
        <h:commandButton value="Search"
                         action="#{documentBean.search}"
                         update="documentTable"/>
    </h:form>

    <!-- Document Table -->
    <h:form id="docForm">
        <h:dataTable id="documentTable"
                     value="#{documentBean.documents}"
                     var="doc"
                     styleClass="table">

            <h:column>
                <f:facet name="header">Title</f:facet>
                #{doc.title}
            </h:column>

            <h:column>
                <f:facet name="header">Status</f:facet>
                #{doc.status}
            </h:column>

            <h:column>
                <f:facet name="header">Created</f:facet>
                <h:outputText value="#{doc.createdAt}">
                    <f:convertDateTime pattern="dd/MM/yyyy"/>
                </h:outputText>
            </h:column>

            <h:column>
                <h:commandButton value="View"
                    action="#{documentBean.viewDetail(doc.id)}"
                    immediate="true"/>
            </h:column>
        </h:dataTable>
    </h:form>

    <!-- Create Form -->
    <h:form id="createForm">
        <h:panelGrid columns="2">
            <h:outputLabel for="title" value="Title:"/>
            <h:inputText id="title"
                         value="#{documentBean.newDocument.title}"
                         required="true"
                         requiredMessage="Title is required"/>

            <h:outputLabel for="type" value="Type:"/>
            <h:selectOneMenu id="type"
                             value="#{documentBean.newDocument.type}">
                <f:selectItem itemValue="CONTRACT" itemLabel="Contract"/>
                <f:selectItem itemValue="REPORT"   itemLabel="Report"/>
                <f:selectItem itemValue="INVOICE"  itemLabel="Invoice"/>
            </h:selectOneMenu>
        </h:panelGrid>

        <h:commandButton value="Create"
                         action="#{documentBean.create}"
                         update="@form documentTable messages"/>
    </h:form>
</h:body>
</html>
```

---

## 5. Navigation & View Scopes

```java
// === JSF Scopes ===
@RequestScoped       // Mỗi HTTP request — giống @RequestScoped CDI
@ViewScoped          // Sống cùng view (AJAX OK) — JSF-specific
@SessionScoped       // Sống cùng session — dùng ít thôi
@ApplicationScoped   // Singleton

// Navigation outcomes
public String action() {
    return "success";                    // → success.xhtml
    return "documents/list";             // → documents/list.xhtml
    return "detail?faces-redirect=true"; // → redirect (POST-Redirect-GET)
    return null;                         // stay on current view
}
```

---

## 6. Ajax Support

```xml
<!-- h:commandButton với AJAX partial update -->
<h:commandButton value="Load More">
    <f:ajax execute="@form"         <!-- gửi form data -->
            render="documentTable"  <!-- update chỉ component này -->
            listener="#{documentBean.loadMore}"/>
</h:commandButton>

<!-- Event-based AJAX -->
<h:inputText value="#{documentBean.searchQuery}">
    <f:ajax event="keyup"
            delay="300"
            render="documentTable"
            listener="#{documentBean.search}"/>
</h:inputText>
```

---

## 7. Faces 5.0 — Cái Mới

- **Standalone** — có thể chạy không cần full Jakarta EE server
- **CDI full integration** — không cần `@ManagedBean` nữa, dùng CDI bean
- **Record hỗ trợ** làm backing bean (read-only)
- Loại bỏ nhiều deprecated API từ JSF 2.x
- WebSocket integration cải thiện
- Modern CSS/JavaScript support

---

## 8. Khi Nào Dùng Jakarta Faces

```
NÊN dùng:
✅ Legacy enterprise app cần modernize (không rebuild từ đầu)
✅ Internal admin tool, dashboard không cần SPA
✅ Team mạnh Java, yếu JavaScript
✅ PrimeFaces ecosystem (rich components)

KHÔNG NÊN dùng:
❌ New project — Thymeleaf + Spring MVC hoặc React/Vue + REST API
❌ Mobile-first
❌ High-performance requirements (stateful overhead)
❌ Microservices (JSF monolithic by nature)
```

---

## 9. Architect Notes

**Jakarta Faces 5.0 — thực tế 2026:**
Faces vẫn được maintain vì legacy enterprise (banking, insurance, government) có hàng nghìn màn hình JSF cần support. Với PDMS: nếu có UI layer, nên dùng **React/Angular + Jakarta REST API** thay vì JSF.

Giá trị học: đọc hiểu legacy system, hiểu EL (Expression Language) syntax dùng chung với CDI, hiểu component lifecycle để debug.

---

*[[12-Jakarta-Messaging]] | [[00-Overview]] | Next: [[14-Legacy-EJB]]*
