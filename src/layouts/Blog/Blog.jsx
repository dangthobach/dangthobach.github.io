import './Blog.css';
import { useScrollReveal } from '../../hooks/useScrollReveal';

const TOPICS = [
  'Java & JVM Internals',
  'System Design',
  'Spring Boot',
  'AI/ML Engineering',
  'Event-Driven Patterns',
  'PostgreSQL Deep Dives',
  'Hexagonal Architecture',
  'MCP & AI Tooling',
];

const Blog = () => {
  const [ref, isVisible] = useScrollReveal(0.1);

  return (
    <section id="knowledge" className="blog" ref={ref}>
      <div className="blog__inner section-inner">
        <div className={`blog__header reveal ${isVisible ? 'visible' : ''}`}>
          <p className="section-label">Continuous Learning</p>
          <h2 className="section-title">Knowledge Base</h2>
          <div className="section-divider" />
        </div>

        <div className={`blog__card reveal ${isVisible ? 'visible' : ''} delay-1`}>
          <div className="blog__icon" aria-hidden="true">🌱</div>

          <div className="blog__body">
            <h3 className="blog__title">My Digital Garden</h3>
            <p className="blog__desc">
              I document my learning journey using Obsidian — from system design patterns and Java
              internals to AI tooling, architecture decisions, and engineering philosophy. Organized
              by topic and connection, not chronology.
            </p>

            <div className="blog__topics" aria-label="Topics covered">
              {TOPICS.map((t) => (
                <span key={t} className="tag">{t}</span>
              ))}
            </div>
          </div>

          <a
            href="/knowledge"
            className="blog__cta btn btn--primary"
            id="knowledge-base-link"
            aria-label="Visit Knowledge Base"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" />
              <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
            </svg>
            Visit Knowledge Base
          </a>
        </div>
      </div>
    </section>
  );
};

export default Blog;