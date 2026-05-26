import './Projects.css';
import { useScrollReveal } from '../../hooks/useScrollReveal';
import { projects } from '../../data/projects';

const MetricCard = ({ label, value }) => (
  <div className="proj__metric">
    <span className="proj__metric-value">{value}</span>
    <span className="proj__metric-label">{label}</span>
  </div>
);

const ProjectCard = ({ project, index }) => {
  const [ref, isVisible] = useScrollReveal(0.08);

  return (
    <article
      ref={ref}
      className={`proj__card ${project.featured ? 'proj__card--featured' : ''} ${isVisible ? 'visible' : ''}`}
      style={{ transitionDelay: `${index * 0.15}s` }}
      aria-label={`Project: ${project.title}`}
    >
      {/* Header */}
      <header className="proj__card-header">
        <div className="proj__card-top">
          <div className="proj__card-meta">
            <span className={`proj__status proj__status--${project.status.toLowerCase()}`}>
              <span aria-hidden="true">●</span> {project.status}
            </span>
            <time className="proj__period">{project.period}</time>
          </div>
          <div className="proj__title-row">
            <h3 className="proj__title">{project.title}</h3>
            {project.featured && (
              <span className="proj__featured-badge" aria-label="Featured project">
                ⭐ Featured
              </span>
            )}
          </div>
          <p className="proj__subtitle">{project.subtitle}</p>
        </div>
        <p className="proj__company">
          <span aria-hidden="true">🏦</span>
          {project.company} · {project.role}
        </p>
      </header>

      {/* Metrics bar */}
      {project.metrics && (
        <div className="proj__metrics" aria-label="Key metrics">
          {project.metrics.map((m) => (
            <MetricCard key={m.label} {...m} />
          ))}
        </div>
      )}

      {/* Description */}
      <p className="proj__description">{project.description}</p>

      {/* Highlights */}
      <ul className="proj__highlights" aria-label="Technical highlights">
        {project.highlights.slice(0, 4).map((h, i) => (
          <li key={i} className="proj__highlight">
            <span className="proj__bullet" aria-hidden="true">▸</span>
            <span>{h}</span>
          </li>
        ))}
        {project.highlights.length > 4 && (
          <details className="proj__more">
            <summary>
              +{project.highlights.length - 4} more technical highlights
            </summary>
            {project.highlights.slice(4).map((h, i) => (
              <li key={`more-${i}`} className="proj__highlight proj__highlight--more">
                <span className="proj__bullet" aria-hidden="true">▸</span>
                <span>{h}</span>
              </li>
            ))}
          </details>
        )}
      </ul>

      {/* Footer */}
      <footer className="proj__footer">
        <div className="proj__tech" aria-label="Technologies">
          {project.tech.slice(0, 7).map((t) => (
            <span key={t} className="tag">{t}</span>
          ))}
          {project.tech.length > 7 && (
            <span className="tag tag--more">+{project.tech.length - 7}</span>
          )}
        </div>

        {project.private ? (
          <span className="proj__private">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
            Enterprise / Private
          </span>
        ) : (
          <div className="proj__links">
            {project.github && (
              <a href={project.github} target="_blank" rel="noopener noreferrer" className="btn btn--ghost">
                GitHub
              </a>
            )}
            {project.demo && (
              <a href={project.demo} target="_blank" rel="noopener noreferrer" className="btn btn--ghost">
                Live Demo
              </a>
            )}
          </div>
        )}
      </footer>
    </article>
  );
};

const Projects = () => {
  const [headerRef, headerVisible] = useScrollReveal(0.1);

  return (
    <section id="projects" className="projects">
      <div className="projects__inner section-inner">
        <div ref={headerRef} className={`proj__header reveal ${headerVisible ? 'visible' : ''}`}>
          <p className="section-label">What I've built</p>
          <h2 className="section-title">Projects</h2>
          <div className="section-divider" />
          <p className="proj__header-desc">
            Enterprise systems built at scale — serving hundreds of users, processing millions of
            records, and delivered with AI-augmented velocity.
          </p>
        </div>

        <div className="proj__grid">
          {projects.map((project, i) => (
            <ProjectCard key={project.id} project={project} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
};

export default Projects;
