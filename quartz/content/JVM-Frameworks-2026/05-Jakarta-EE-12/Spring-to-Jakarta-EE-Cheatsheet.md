# Spring → Jakarta EE Cheatsheet

> **Dùng khi:** Đọc Quarkus/Helidon doc, design vendor-neutral APIs
> **Phiên bản:** Jakarta EE 12 vs Spring Boot 3.x / Spring Framework 7

---

## Dependency Injection

| Spring | Jakarta CDI 5.0 | Ghi chú |
|---|---|---|
| `@Component` / `@Service` | `@ApplicationScoped` | CDI dùng proxy |
| `@Bean` trong `@Configuration` | `@Produces` method | |
| `@Autowired` | `@Inject` | Cả hai support field/constructor/setter |
| `@Qualifier("name")` | Custom `@Qualifier` annotation | CDI type-safe hơn |
| `@Primary` | `@Default` (CDI built-in) | |
| `@Scope("prototype")` | `@Dependent` | |
| `@RequestScope` | `@RequestScoped` | |
| `@SessionScope` | `@SessionScoped` | |
| `@Lazy` | Không có equivalent | CDI proxy = lazy by nature |
| `@Profile("prod")` | `@IfBuildProperty` (Quarkus ext) | Build-time |
| `@ConditionalOnProperty` | `@IfBuildProperty` | Quarkus extension |
| `ApplicationEventPublisher` | `Event<T>` | |
| `@EventListener` | `@Observes` | |
| `@Async` event | `@ObservesAsync` | |
| `@Aspect` + `@Around` | `@Interceptor` + `@AroundInvoke` | |
| `@Order` | `@Priority(int)` | |

---

## REST / Web

| Spring MVC | Jakarta REST 5.0 | Ghi chú |
|---|---|---|
| `@RestController` | `@Path` (class) | |
| `@GetMapping("/path")` | `@GET` + `@Path("/path")` | |
| `@PostMapping` | `@POST` | |
| `@PutMapping` | `@PUT` | |
| `@DeleteMapping` | `@DELETE` | |
| `@PatchMapping` | `@PATCH` | |
| `@PathVariable` | `@PathParam` | |
| `@RequestParam` | `@QueryParam` | |
| `@RequestHeader` | `@HeaderParam` | |
| `@CookieValue` | `@CookieParam` | |
| `@RequestBody` | Method parameter (auto) | |
| `ResponseEntity<T>` | `Response` builder | |
| `@ResponseStatus(CREATED)` | `Response.created(uri)` | |
| `produces = "application/json"` | `@Produces(APPLICATION_JSON)` | |
| `consumes = "application/json"` | `@Consumes(APPLICATION_JSON)` | |
| `@ControllerAdvice` | `@Provider ExceptionMapper<E>` | |
| `@ExceptionHandler` | `ExceptionMapper.toResponse()` | |
| `HandlerInterceptor` | `ContainerRequestFilter` | |
| `@ModelAttribute` | `@BeanParam` | |
| `RestTemplate` / `RestClient` | `Client` (JAX-RS Client API) | |

---

## Persistence / Data

| Spring Data JPA | Jakarta Persistence 4.0 | Ghi chú |
|---|---|---|
| `@Entity` | `@Entity` | Giống nhau |
| `@Table` | `@Table` | Giống nhau |
| `@Id` | `@Id` | Giống nhau |
| `@GeneratedValue` | `@GeneratedValue` | Giống nhau |
| `@Column` | `@Column` | Giống nhau |
| `@OneToMany` etc. | Same | Giống nhau |
| `@Transient` | `@Transient` | Giống nhau |
| `@NamedQuery` | `@NamedQuery` | Giống nhau |
| `@Query` (JPQL) | `@Query` (JDQL) | JDQL là subset JPQL |
| `JpaRepository` | `@Repository` (Jakarta Data) | |
| `findByXxx()` derivation | `@Find` + param name | |
| `save(entity)` | `@Save` | |
| `deleteById(id)` | `@Delete` | |
| `Pageable` (0-based) | `PageRequest` (1-based) | ⚠️ Off by 1! |
| `Page<T>` | `Page<T>` | Tương tự |
| Custom keyset | Manual | `CursoredPage<T>` built-in |
| `@Modifying @Query` | `@Query` (update/delete) | |
| `EntityManager` (direct) | `@PersistenceContext EntityManager` | |

---

## Transactions

| Spring | Jakarta Transactions 2.1 | Ghi chú |
|---|---|---|
| `@Transactional` | `@Transactional` | Jakarta Transactions |
| `propagation = REQUIRED` | `@Transactional` (default) | Giống nhau |
| `propagation = REQUIRES_NEW` | `@Transactional(REQUIRES_NEW)` | |
| `propagation = NOT_SUPPORTED` | `@Transactional(NOT_SUPPORTED)` | |
| `rollbackFor = Exception.class` | `rollbackOn = Exception.class` | Khác attribute name! |
| `readOnly = true` | Không có built-in | Hint qua `EntityManager` |
| `TransactionTemplate` | `UserTransaction` (inject) | |
| `@TransactionalEventListener` | `@Observes(during = AFTER_SUCCESS)` | |

---

## Validation

| Spring / Hibernate Validator | Jakarta Validation 4.0 | Ghi chú |
|---|---|---|
| `@NotNull` | `@NotNull` | **Giống hệt** — same spec |
| `@NotBlank` | `@NotBlank` | |
| `@Size(min,max)` | `@Size(min,max)` | |
| `@Min` / `@Max` | `@Min` / `@Max` | |
| `@Email` | `@Email` | |
| `@Pattern` | `@Pattern` | |
| `@Valid` | `@Valid` | |
| `@Validated` | Không có | Spring extension |
| `ConstraintValidator<A,T>` | `ConstraintValidator<A,T>` | **Giống hệt** |
| `BindingResult` | `ConstraintViolationException` | |

---

## Security

| Spring Security | Jakarta Security 4.x | Ghi chú |
|---|---|---|
| `@PreAuthorize("hasRole('X')")` | `@RolesAllowed("X")` | Spring flexible hơn |
| `@PreAuthorize("permitAll()")` | `@PermitAll` | |
| `@PreAuthorize("denyAll()")` | `@DenyAll` | |
| `SecurityContextHolder` | `@Inject SecurityContext` | |
| `Authentication.getName()` | `SecurityContext.getCallerPrincipal().getName()` | |
| `UserDetailsService` | `IdentityStore` | |
| `AbstractAuthFilter` | `HttpAuthenticationMechanism` | |
| `@AuthenticationPrincipal` | Manual inject SecurityContext | |
| Spring Security OAuth2 OIDC | MicroProfile JWT / Quarkus OIDC | Vendor extension |

---

## Concurrency

| Spring | Jakarta Concurrency 3.x | Ghi chú |
|---|---|---|
| `@Async` | `@Asynchronous` (CDI) | |
| `ThreadPoolTaskExecutor` | `ManagedExecutorService` | |
| `@Scheduled` | `ManagedScheduledExecutorService` | |
| `CompletableFuture` | `CompletionStage` | |
| Virtual threads (Loom) | `ManagedExecutorService` + virtual thread config | |
| `@EnableAsync` | Không cần (CDI auto) | |

---

## Profiles — Nhớ Cái Này Khi Đọc Doc

```
Core Profile   = CDI + REST + JSON-P + JSON-B + Interceptors + Validation
              → Quarkus và Helidon SE/MP

Web Profile    = Core + Servlet + Faces + WebSocket + Security + Persistence
              + Data + Transactions + Concurrency
              → WildFly, Payara Web

Full Platform  = Web + JMS + JCA + EJB + Batch + Connector + Mail
              → WildFly Full, Payara Full, Open Liberty
```

---

## Quick Gotchas

```
⚠️ CDI @ApplicationScoped → proxy object (không phải instance thật)
   → class và method không được final

⚠️ Jakarta Data PageRequest → 1-based (Spring là 0-based)
   Spring page=0 == Jakarta page=1

⚠️ @Transactional rollbackFor vs rollbackOn — khác tên attribute

⚠️ JAX-RS resource class mặc định là per-request, không phải singleton
   → Phải @ApplicationScoped nếu muốn share state

⚠️ Jakarta Security @RolesAllowed không có SpEL
   → Không thể @RolesAllowed("#userId == authentication.name")
   → Cần custom logic trong method body

⚠️ Jakarta không có @ConditionalOnProperty
   → Build-time config qua @IfBuildProperty (Quarkus extension)
```

---

*[[00-Overview]] | Track: JVM-Frameworks-2026/05-Jakarta-EE-12*
