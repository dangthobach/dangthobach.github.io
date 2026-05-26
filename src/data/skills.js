// Technical skill categories and proficiency levels

export const skillCategories = [
  {
    category: 'Backend Engineering',
    icon: '☕',
    color: '#f59e0b',
    skills: [
      { name: 'Java 21', level: 95, devicon: 'java' },
      { name: 'Spring Boot 3.x', level: 95, devicon: 'spring' },
      { name: 'JPA / Hibernate', level: 90, devicon: null },
      { name: 'Maven', level: 90, devicon: 'maven' },
      { name: 'JUnit 5 / jqwik', level: 88, devicon: null },
    ],
  },
  {
    category: 'Architecture & Design',
    icon: '🏗️',
    color: '#00d4ff',
    skills: [
      { name: 'Hexagonal Architecture', level: 92, devicon: null },
      { name: 'Event-Driven Architecture', level: 90, devicon: null },
      { name: 'Domain-Driven Design', level: 87, devicon: null },
      { name: 'Microservices', level: 90, devicon: null },
      { name: 'REST API Design', level: 95, devicon: null },
    ],
  },
  {
    category: 'Data & Messaging',
    icon: '🗄️',
    color: '#8b5cf6',
    skills: [
      { name: 'PostgreSQL', level: 92, devicon: 'postgresql' },
      { name: 'Apache Kafka', level: 87, devicon: 'apachekafka' },
      { name: 'Redis', level: 85, devicon: 'redis' },
      { name: 'Apache POI / SXSSF', level: 82, devicon: null },
      { name: 'Stored Procedures / CTEs', level: 88, devicon: null },
    ],
  },
  {
    category: 'Cloud & DevOps',
    icon: '☁️',
    color: '#10b981',
    skills: [
      { name: 'Docker', level: 88, devicon: 'docker' },
      { name: 'AWS S3 / Bedrock', level: 85, devicon: 'amazonwebservices' },
      { name: 'GitHub Actions', level: 80, devicon: 'github' },
      { name: 'JaCoCo (80%+ gates)', level: 85, devicon: null },
      { name: 'ShedLock (Distributed)', level: 82, devicon: null },
    ],
  },
  {
    category: 'Security & Resilience',
    icon: '🔐',
    color: '#ef4444',
    skills: [
      { name: 'Keycloak / OAuth2 / OIDC', level: 90, devicon: null },
      { name: 'JWT / RBAC', level: 90, devicon: null },
      { name: 'Resilience4j', level: 85, devicon: null },
      { name: 'CVE Management', level: 80, devicon: null },
    ],
  },
  {
    category: 'AI & Productivity',
    icon: '🤖',
    color: '#f59e0b',
    skills: [
      { name: 'Kiro AI IDE', level: 92, devicon: null },
      { name: 'AWS Bedrock (Claude)', level: 85, devicon: null },
      { name: 'MCP Protocol / Servers', level: 85, devicon: null },
      { name: 'Prompt Engineering', level: 82, devicon: null },
      { name: 'RAG Systems', level: 78, devicon: null },
    ],
  },
];
