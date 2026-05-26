import './Experience.css';
import { useScrollReveal } from '../../hooks/useScrollReveal';
import { experiences } from '../../data/experience';

const ExperienceCard = ({ exp, index }) => {
  const [ref, isVisible] = useScrollReveal(0.08);

  return (
    <div
      ref={ref}
      className={`exp__item ${isVisible ? 'visible' : ''}`}
      style={{ transitionDelay: `${index * 0.12}s` }}
    >
      {/* Timeline dot */}
      <div className="exp__dot" aria-hidden="true">
        <div className="exp__dot-core" />
      </div>

      {/* Card */}
      <article className="exp__card">
        <header className="exp__card-header">
          <div className="exp__card-left">
            <div className="exp__role">{exp.role}</div>
            <div className="exp__company-row">
              <span className="exp__company">{exp.company}</span>
              {exp.companyFull && (
                <span className="exp__company-full"> — {exp.companyFull}</span>
              )}
            </div>
            {exp.project && (
              <p className="exp__project">
                <span aria-hidden="true">📁</span> {exp.project}
              </p>
            )}
          </div>

          <div className="exp__card-right">
            {exp.badge && (
              <span className={`exp__badge exp__badge--${exp.type}`}>
                {exp.type === 'current' && (
                  <span className="exp__badge-pulse" aria-hidden="true" />
                )}
                {exp.badge}
              </span>
            )}
            <time className="exp__period">{exp.period}</time>
            <span className="exp__location">
              <span aria-hidden="true">📍</span> {exp.location}
            </span>
          </div>
        </header>

        <p className="exp__description">{exp.description}</p>

        <ul className="exp__highlights" aria-label="Key achievements">
          {exp.highlights.map((h, i) => (
            <li key={i} className="exp__highlight">
              <span className="exp__bullet" aria-hidden="true">▸</span>
              {h}
            </li>
          ))}
        </ul>

        <div className="exp__tech" aria-label="Technologies used">
          {exp.tech.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
      </article>
    </div>
  );
};

const Experience = () => {
  const [headerRef, headerVisible] = useScrollReveal(0.1);

  return (
    <section id="experience" className="experience">
      <div className="experience__inner section-inner">
        <div ref={headerRef} className={`exp__header reveal ${headerVisible ? 'visible' : ''}`}>
          <p className="section-label">Career Path</p>
          <h2 className="section-title">Experience</h2>
          <div className="section-divider" />
        </div>

        <div className="exp__timeline">
          {experiences.map((exp, i) => (
            <ExperienceCard key={exp.id} exp={exp} index={i} />
          ))}

          {/* "More coming" note if only 1 entry */}
          {experiences.length === 1 && (
            <p className="exp__note">
              ✦ Full work history available in the{' '}
              <a href="/src/assets/DangThoBach_EN.pdf" target="_blank" rel="noopener noreferrer">
                downloadable CV
              </a>
            </p>
          )}
        </div>
      </div>
    </section>
  );
};

export default Experience;
