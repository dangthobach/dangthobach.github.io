// Work experience — full career history extracted from CV
// Most recent first. Add new entries at the top.

export const experiences = [
  // ─── CURRENT ──────────────────────────────────────────────────────────────
  {
    id: 1,
    company: 'VPBank',
    companyFull: 'Vietnam Prosperity Joint-Stock Commercial Bank (Top 5 Private Bank in Vietnam)',
    badge: 'Current',
    role: 'Senior Java Engineer',
    project: 'PDMS — Physical Document Management System',
    period: 'Apr 2025 – Present',
    duration: '14 months',
    type: 'current',
    location: 'Hanoi, Vietnam',
    description:
      "Led architecture design and development of VPBank's enterprise Physical Document Management System — a bank-wide platform managing the full lifecycle of 7M+ physical banking documents across 50+ warehouse locations, serving more than 1000 internal users daily. Delivered 20+ release candidates in 14 months, transitioning from greenfield to production stability (now CR-only phase).",
    highlights: [
      '239+ REST API endpoints across 53 components, organized into 7 functional domains (accounting records, credit documents, distributed documents, warehouse operations, reporting, admin, RBAC)',
      'Migrated 7M+ legacy credit case records via multi-phase PostgreSQL stored procedures — 5,000–10,000 records/batch with FOR UPDATE SKIP LOCKED to prevent deadlocks under concurrent load',
      'Pioneered AI-augmented SDLC (AWS Bedrock + Kiro AI + MCP servers), reducing the development cycle ~40% and compressing an 18–24 month scope into 14 months with a lean team',
      'Hexagonal Architecture with 150+ unit test classes (jqwik property-based testing), 80%+ JaCoCo coverage; event-driven via Kafka (SASL_SSL, SCRAM-SHA-512)',
    ],
    tech: [
      'Java 21',
      'Spring Boot 3.4',
      'PostgreSQL',
      'Apache Kafka',
      'Keycloak',
      'AWS S3',
      'Redis',
      'Docker',
      'Resilience4j',
      'ShedLock',
    ],
  },

  // ─── SHB ──────────────────────────────────────────────────────────────────
  {
    id: 2,
    company: 'Sai Gon – Ha Noi Bank (SHB)',
    companyFull: 'Saigon–Hanoi Joint Stock Commercial Bank',
    badge: null,
    role: 'Software Engineer',
    project: 'Corebank (Intellect) · Corecard (SmartVista)',
    period: 'Sep 2022 – Mar 2025',
    duration: '2.5 years',
    type: 'past',
    location: 'Hanoi, Vietnam',
    description:
      'Developed and maintained core banking and core card systems serving SHB — covering modules for lending, identity document compliance (Circular 17/2024/TT-NHNN), card issuance/PIN management, Mastercard/Visa/SmartVisa reporting, and ATM/POS operations.',
    highlights: [
      'Deployed Keycloak identity provider for SSO across the organization; integrated and configured downstream systems',
      'Migrated CardUtility to microservice architecture on Kubernetes (13 functions in Phase 1, 4 in Phase 2), deployed CI/CD pipeline on GitLab',
      'Optimized PL/SQL scripts for bulk expiry-document cutoff processing — millions of records processed in seconds to meet Circular 17/2024/TT-NHNN compliance deadline',
      'Integrated BlackDuck (OSS vulnerability scanning) and Coverity (static code analysis) into pre-deployment gates; deployed ELK stack for monitoring and log tracing',
    ],
    tech: [
      'Spring Boot',
      'Oracle (PL/SQL)',
      'Spring Data JPA',
      'Keycloak',
      'Docker',
      'Kubernetes',
      'GitLab CI/CD',
      'ELK Stack',
      'JasperReport',
      'BlackDuck',
      'Coverity',
    ],
  },

  // ─── ALPHAWAY ─────────────────────────────────────────────────────────────
  {
    id: 3,
    company: 'Alphaway Technology Company',
    companyFull: null,
    badge: null,
    role: 'Software Engineer',
    project: 'Military Bank — Card Systems, Wallet, Wealth Management',
    period: 'Aug 2019 – Aug 2022',
    duration: '3 years',
    type: 'past',
    location: 'Hanoi, Vietnam',
    description:
      'Worked across multiple fintech projects for Military Bank (MBBank), An Binh Bank, and LienViet Postbank — building card management systems, payment scheduling, wallet core migration, wealth management tools, and credit rating platforms.',
    highlights: [
      'Built multithreaded job scheduling (Way4Batch) for card issuance, payment accounting, reissuance and limit changes; upgraded JDK 1.6 → 11 with zero service disruption',
      'Developed Unionpay/virtual card gateway (ISO 8583 socket), card portal (PIN management, stoplist/blacklist, reissuance), and card gateway with SMS notification',
      'Led wallet core migration project (ViettelPay): built connection streams for balance query, card unlock, beneficiary lookup, and cash-by-code withdrawal feature',
      'Built credit rating systems for An Binh Bank and LienViet Postbank: scoring screens, CIC record management, JasperReport outputs; Keycloak-based user admin for Wealth Management module',
    ],
    tech: [
      'Spring Boot',
      'Spring Cloud',
      'Oracle (PL/SQL)',
      'SOAP / REST WebService',
      'Keycloak',
      'ISO 8583',
      'Docker',
      'Kubernetes',
      'JDBC',
      'JasperReport',
      'Way4 (SmartVista)',
    ],
  },

  // ─── OMINEXT ──────────────────────────────────────────────────────────────
  {
    id: 4,
    company: 'Ominext JSC',
    companyFull: null,
    badge: null,
    role: 'Java Developer',
    project: 'Government eCabinet · Secom (Japan) · Fine Medical (Japan)',
    period: 'Dec 2018 – Jun 2019',
    duration: '7 months',
    type: 'past',
    location: 'Hanoi, Vietnam',
    description:
      'First professional role — built and maintained enterprise Java web applications for government and Japanese clients, spanning a government e-Cabinet system, an electronic medical records platform, and a pharmacy management solution.',
    highlights: [
      'eCabinet (Government): built news, meeting management, voting, user and permission screens on J2EE/JSP/Servlet stack on IBM WebSphere Application Server',
      'Secom (Japan): maintained and resolved on-demand issues for an electronic medical records web system',
      'Fine Medical (Japan): developed CRUD screens for a private pharmacy management system on SpringBoot/JSF/MySQL stack',
    ],
    tech: [
      'J2EE',
      'JSP / Servlet',
      'Spring Boot',
      'Hibernate',
      'JSF',
      'JDBC',
      'DB2',
      'MySQL',
      'IBM WebSphere',
    ],
  },
];
