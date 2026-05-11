# Liquibase 02 — Configuration & Spring Boot Enterprise Setup

> **Mục tiêu**: Cấu hình Liquibase vào project Spring Boot enterprise đúng cách — từ dependency đến multi-datasource, từ local dev đến production.

**Series**: [[Liquibase-MOC]] | **Prev**: [[Liquibase-01-Core-Mechanics]] | **Next**: [[Liquibase-03-Changelog-Mastery]]

---

## 1. Dependency Setup

### Maven (pom.xml)

```xml
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>

    <!-- Liquibase core — Spring Boot tự manage version -->
    <dependency>
        <groupId>org.liquibase</groupId>
        <artifactId>liquibase-core</artifactId>
    </dependency>

    <dependency>
        <groupId>org.postgresql</groupId>
        <artifactId>postgresql</artifactId>
        <scope>runtime</scope>
    </dependency>
</dependencies>
```

> 💡 Spring Boot **tự động** cấu hình Liquibase khi detect `liquibase-core` trên classpath. Default changelog path: `classpath:/db/changelog/db.changelog-master.yaml`

---

## 2. Application Properties — Full Reference

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/pdms_db
    username: ${DB_USERNAME:pdms_user}
    password: ${DB_PASSWORD:secret}
    driver-class-name: org.postgresql.Driver
    hikari:
      maximum-pool-size: 20
      minimum-idle: 5
      connection-timeout: 30000

  liquibase:
    # === CƠ BẢN ===
    enabled: true
    change-log: classpath:/db/changelog/db.changelog-master.xml

    # === CREDENTIALS (dedicated migration user) ===
    url: jdbc:postgresql://localhost:5432/pdms_db
    user: ${LIQUIBASE_USERNAME:liquibase_user}
    password: ${LIQUIBASE_PASSWORD:migration_secret}

    # === ENVIRONMENT CONTROL ===
    contexts: ${SPRING_PROFILES_ACTIVE:dev}
    labels: ${APP_VERSION:}

    # === BEHAVIOR ===
    default-schema: public
    liquibase-schema: public
    database-change-log-table: DATABASECHANGELOG
    database-change-log-lock-table: DATABASECHANGELOGLOCK

    # === SAFETY ===
    drop-first: false   # KHÔNG BAO GIỜ true trên prod!
    test-rollback-on-update: false

    # === PERFORMANCE ===
    lock-wait-time: 10m   # default 5m — với 200 bảng nên tăng lên

    # === PARAMETERS (truyền vào changelog) ===
    parameters:
      app_schema: public
      default_tenant: VPBANK
      batch_size: 1000
```

---

## 3. Profile-based Configuration

```
src/main/resources/
├── application.yml
├── application-dev.yml
├── application-staging.yml
└── application-prod.yml
```

### application-dev.yml

```yaml
spring:
  liquibase:
    enabled: true
    contexts: dev
    labels: ""
```

### application-staging.yml

```yaml
spring:
  liquibase:
    enabled: true
    contexts: staging
    labels: ${DEPLOY_VERSION:}
    lock-wait-time: 15m
```

### application-prod.yml

```yaml
spring:
  liquibase:
    enabled: true
    contexts: prod
    labels: ${DEPLOY_VERSION}    # BẮT BUỘC specify version khi prod deploy
    lock-wait-time: 30m
    user: ${LIQUIBASE_PROD_USER}
    password: ${LIQUIBASE_PROD_PASSWORD}
```

---

## 4. Dedicated Migration User (Security Best Practice)

### Tại sao cần user riêng?

- App user chỉ cần `SELECT, INSERT, UPDATE, DELETE`
- Migration user cần `CREATE TABLE, ALTER TABLE, DROP INDEX`...
- Tách biệt để hạn chế blast radius nếu app bị compromise

```sql
CREATE USER liquibase_migration WITH PASSWORD 'strong_migration_password';

GRANT CONNECT ON DATABASE pdms_db TO liquibase_migration;
GRANT USAGE ON SCHEMA public TO liquibase_migration;
GRANT CREATE ON SCHEMA public TO liquibase_migration;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO liquibase_migration;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO liquibase_migration;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO liquibase_migration;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO liquibase_migration;
```

---

## 5. Custom Liquibase Configuration Bean

```java
@Configuration
@ConditionalOnProperty(name = "spring.liquibase.enabled", havingValue = "true")
public class LiquibaseConfig {

    @Bean
    @Primary
    public SpringLiquibase liquibase(
            DataSource dataSource,
            LiquibaseProperties properties,
            @Value("${spring.profiles.active:dev}") String activeProfile) {

        SpringLiquibase liquibase = new SpringLiquibase();
        liquibase.setDataSource(dataSource);
        liquibase.setChangeLog(properties.getChangeLog());
        liquibase.setContexts(activeProfile);

        // Parameters truyền vào changelog
        Map<String, String> params = new HashMap<>();
        params.put("app.version", getAppVersion());
        params.put("schema.name", "public");
        liquibase.setChangeLogParameters(params);

        return liquibase;
    }

    private String getAppVersion() {
        return getClass().getPackage().getImplementationVersion();
    }
}
```

### Multi-datasource setup

```java
@Configuration
public class MultiDatasourceLiquibaseConfig {

    @Bean
    public SpringLiquibase pdmsLiquibase(
            @Qualifier("pdmsDataSource") DataSource dataSource) {
        SpringLiquibase liquibase = new SpringLiquibase();
        liquibase.setDataSource(dataSource);
        liquibase.setChangeLog("classpath:/db/changelog/pdms/db.changelog-master.xml");
        liquibase.setDefaultSchema("pdms");
        return liquibase;
    }

    @Bean
    public SpringLiquibase iamLiquibase(
            @Qualifier("iamDataSource") DataSource dataSource) {
        SpringLiquibase liquibase = new SpringLiquibase();
        liquibase.setDataSource(dataSource);
        liquibase.setChangeLog("classpath:/db/changelog/iam/db.changelog-master.xml");
        liquibase.setDefaultSchema("iam");
        return liquibase;
    }
}
```

---

## 6. Resource Structure trong Spring Boot Project

```
src/main/resources/
└── db/
    └── changelog/
        ├── db.changelog-master.xml
        └── migrations/
            ├── v1.0.0/
            │   ├── 001-create-schema.xml
            │   ├── 002-create-lookup-tables.xml
            │   ├── 003-create-core-tables.xml
            │   ├── 004-create-indexes.xml
            │   └── 005-seed-data.xml
            ├── v1.1.0/
            │   ├── 001-add-audit-columns.xml
            │   └── 002-new-constraints.xml
            └── v2.0.0/
                ├── 001-module-tsdb-tables.xml
                └── 002-multi-tenant-columns.xml
```

### db.changelog-master.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog
    xmlns="http://www.liquibase.org/xml/ns/dbchangelog"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.liquibase.org/xml/ns/dbchangelog
                        http://www.liquibase.org/xml/ns/dbchangelog/dbchangelog-4.20.xsd">

    <property name="now" value="now()" dbms="postgresql"/>
    <property name="blob_type" value="bytea" dbms="postgresql"/>

    <includeAll path="db/changelog/migrations/v1.0.0/"
                relativeToChangelogFile="false"/>
    <includeAll path="db/changelog/migrations/v1.1.0/"
                relativeToChangelogFile="false"/>
    <includeAll path="db/changelog/migrations/v2.0.0/"
                relativeToChangelogFile="false"/>

</databaseChangeLog>
```

---

## 7. Disable Liquibase cho Test

```yaml
# application-test.yml
spring:
  liquibase:
    enabled: false
```

### Testcontainers + Liquibase (integration test tốt nhất)

```java
@SpringBootTest
@Testcontainers
class DocumentRepositoryIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:15")
            .withDatabaseName("test_db")
            .withUsername("test_user")
            .withPassword("test_pass");

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
        // Liquibase tự chạy, tạo schema đúng trong container test
    }
}
```

---

## 8. Liquibase CLI Setup

```bash
# Homebrew
brew install liquibase

# Verify
liquibase --version
```

### liquibase.properties (project root, KHÔNG commit)

```properties
url=jdbc:postgresql://localhost:5432/pdms_db
username=liquibase_user
password=migration_pass
driver=org.postgresql.Driver
changeLogFile=src/main/resources/db/changelog/db.changelog-master.xml
defaultSchemaName=public
logLevel=INFO
```

```gitignore
# .gitignore
liquibase.properties   # Có credentials — KHÔNG commit!
```

---

## 9. Monitoring — Spring Boot Actuator

```yaml
management:
  endpoints:
    web:
      exposure:
        include: liquibase, health, info
  endpoint:
    liquibase:
      enabled: true
```

Endpoint `/actuator/liquibase` trả về toàn bộ lịch sử changeset đã chạy — rất hữu ích để debug production.

---

## Summary Checklist

```
✅ Thêm liquibase-core dependency
✅ Cấu hình spring.liquibase.* trong application.yml
✅ Tạo dedicated migration user với quyền DDL
✅ Dùng profiles để phân tách context (dev/staging/prod)
✅ KHÔNG commit credentials — dùng env vars
✅ Set lock-wait-time phù hợp (30m cho 200 bảng)
✅ Expose actuator endpoint để monitor
✅ Disable trong unit tests nếu không cần
✅ Dùng Testcontainers cho integration tests
```

**Next**: [[Liquibase-03-Changelog-Mastery]]

---

#liquibase #spring-boot #configuration #enterprise #postgresql #multi-datasource
