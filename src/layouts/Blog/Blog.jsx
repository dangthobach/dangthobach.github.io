import './Blog.css';
import { useScrollReveal } from '../../hooks/useScrollReveal';

const FEATURED_NOTES = [
  {
    id: 1,
    title: 'Hibernate Performance Tuning & Deep Dive',
    category: 'Database & ORM',
    path: '/knowledge/Database-Patterns/Hibernate-Performance-Deep-Dive',
    readTime: '25 min read',
    description:
      'A comprehensive 270KB+ guide detailing query plan caches, N+1 problem mitigation, batch fetching strategies, and Hibernate level-2 cache tuning.',
    tags: ['L2 Cache', 'N+1 Query', 'Batch Fetching', 'Persistence Context'],
    color: '#ca8a04',
    icon: '🗄️',
  },
  {
    id: 2,
    title: 'AuthZ Platform: Dynamic 5-Layer Design',
    category: 'Microservices & Security',
    path: '/knowledge/Microservices-Patterns/AuthZ-Platform-Dynamic-5-Layer-Design',
    readTime: '12 min read',
    description:
      'Architectural design of an enterprise-grade authorization gateway. Covers role-based access control, token delegation, and policy enforcement layers.',
    tags: ['OAuth2/OIDC', 'RBAC', 'API Gateway', 'Keycloak'],
    color: '#ef4444',
    icon: '🔐',
  },
  {
    id: 3,
    title: 'JDBC vs R2DBC vs Virtual Threads Performance',
    category: 'High-Performance Java',
    path: '/knowledge/Database-Patterns/JDBC-vs-R2DBC-vs-VirtualThreads',
    readTime: '10 min read',
    description:
      'Benchmark analysis comparing blocking JDBC, reactive R2DBC, and Virtual Threads (Project Loom) under heavy concurrent connection profiles.',
    tags: ['R2DBC', 'Project Loom', 'Concurrency', 'Reactive Streams'],
    color: '#00d4ff',
    icon: '⚡',
  },
  {
    id: 4,
    title: 'ADR: Quarkus vs Micronaut for Enterprise Systems',
    category: 'System Architecture',
    path: '/knowledge/JVM-Frameworks-2026/ADR-001-Why-Quarkus-Over-Micronaut',
    readTime: '8 min read',
    description:
      'An Architectural Decision Record analyzing compile-time dependency injection, startup times, GraalVM native image generation, and ecosystem matureness.',
    tags: ['ADR', 'Quarkus', 'Micronaut', 'AOT Compilation'],
    color: '#8b5cf6',
    icon: '🏗️',
  },
];

const NoteCard = ({ note, index }) => {
  const [ref, isVisible] = useScrollReveal(0.08);

  return (
    <a
      href={note.path}
      ref={ref}
      className={`blog__card reveal ${isVisible ? 'visible' : ''}`}
      style={{ transitionDelay: `${index * 0.1}s` }}
      aria-label={`Read note: ${note.title}`}
    >
      <div className="blog__card-header">
        <div className="blog__card-meta">
          <span className="blog__card-icon" aria-hidden="true">{note.icon}</span>
          <span className="blog__card-category" style={{ color: note.color }}>
            {note.category}
          </span>
        </div>
      </div>

      <h3 className="blog__card-title">{note.title}</h3>
      <p className="blog__card-desc">{note.description}</p>

      <div className="blog__card-tags">
        {note.tags.map((tag) => (
          <span key={tag} className="tag tag--subtle">{tag}</span>
        ))}
      </div>

      <div className="blog__card-footer">
        <span className="blog__card-link">
          Read Full Note
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </span>
      </div>
    </a>
  );
};

const Blog = () => {
  const [ref, isVisible] = useScrollReveal(0.1);

  return (
    <section id="knowledge" className="blog">
      <div className="blog__inner section-inner">
        <div ref={ref} className={`blog__header reveal ${isVisible ? 'visible' : ''}`}>
          <p className="section-label">Continuous Learning</p>
          <h2 className="section-title">Technical Brain &amp; Garden</h2>
          <div className="section-divider" />
          <p className="blog__header-desc">
            I actively document my architectural research, benchmark studies, and implementation standards using Obsidian.
            Here are a few deep-dive notes from my digital garden.
          </p>
        </div>

        <div className="blog__grid">
          {FEATURED_NOTES.map((note, i) => (
            <NoteCard key={note.id} note={note} index={i} />
          ))}
        </div>

        <div className="blog__actions">
          <a
            href="/knowledge"
            className="btn btn--primary"
            id="knowledge-base-link"
            aria-label="Visit full Obsidian digital garden"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" />
              <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
            </svg>
            Explore Full Digital Garden
          </a>
        </div>
      </div>
    </section>
  );
};

export default Blog;