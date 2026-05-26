import { useEffect, useRef, useState } from 'react';
import './About.css';
import { useScrollReveal } from '../../hooks/useScrollReveal';

const STATS = [
  { label: 'Years of Experience', value: 7, suffix: '+', icon: '📅' },
  { label: 'REST APIs Delivered', value: 239, suffix: '+', icon: '🔌' },
  { label: 'Release Candidates', value: 580, suffix: '+', icon: '🚀' },
  { label: 'Records Migrated', value: 7, suffix: 'M+', icon: '🗄️' },
];

const CountUp = ({ end, suffix, isVisible }) => {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!isVisible) return;
    const duration = 1800;
    const startTime = performance.now();
    const update = (now) => {
      const progress = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.floor(eased * end));
      if (progress < 1) requestAnimationFrame(update);
      else setCount(end);
    };
    requestAnimationFrame(update);
  }, [isVisible, end]);

  return (
    <>
      {count}
      {suffix}
    </>
  );
};

const About = () => {
  const [sectionRef, isVisible] = useScrollReveal(0.1);

  return (
    <section id="about" className="about" ref={sectionRef}>
      <div className="about__inner section-inner">
        <div className={`about__header reveal ${isVisible ? 'visible' : ''}`}>
          <p className="section-label">Get to know me</p>
          <h2 className="section-title">About Me</h2>
          <div className="section-divider" />
        </div>

        <div className="about__body">
          {/* Bio */}
          <div className={`about__bio reveal ${isVisible ? 'visible' : ''} delay-1`}>
            <p>
              I'm a <strong>Senior Java Engineer and Technical Leader</strong> with 7+ years of
              hands-on experience designing and shipping enterprise-grade backend systems in the
              Vietnamese fintech and banking sector.
            </p>
            <br />
            <p>
              My focus areas are large-scale distributed systems — architectures that handle
              millions of records, high-throughput event streams, complex business domains, and
              strict security requirements. I care deeply about engineering quality: clean
              architecture, testability, observability, and proactive security posture.
            </p>
            <br />
            <p>
              Recently, I pioneered <strong>AI-augmented software development</strong> practices at
              VPBank — integrating AWS Bedrock (Claude), Kiro AI IDE, and MCP protocol servers at
              every phase of the SDLC. The measurable result: a{' '}
              <strong>~40% reduction in delivery cycle</strong> without sacrificing coverage or
              quality standards.
            </p>

            <div className="about__chips">
              {[
                'Hexagonal Architecture',
                'Event-Driven Systems',
                'DDD',
                'RBAC / Security',
                'TDD / jqwik',
                'AI-First SDLC',
              ].map((chip) => (
                <span key={chip} className="tag">
                  {chip}
                </span>
              ))}
            </div>

            <div className="about__meta-grid">
              <div className="about__meta-item">
                <span className="about__meta-icon" aria-hidden="true">🎓</span>
                <div>
                  <h4 className="about__meta-title">Education</h4>
                  <p className="about__meta-desc">Software Technology · Hanoi University Of Industry</p>
                </div>
              </div>
              <div className="about__meta-item">
                <span className="about__meta-icon" aria-hidden="true">🗣️</span>
                <div>
                  <h4 className="about__meta-title">Languages</h4>
                  <p className="about__meta-desc">English (University Level) · Vietnamese (Native)</p>
                </div>
              </div>
            </div>
          </div>

          {/* Stats grid */}
          <div className="about__stats">
            {STATS.map((stat, i) => (
              <div
                key={stat.label}
                className={`about__stat reveal ${isVisible ? 'visible' : ''} delay-${i + 2}`}
              >
                <span className="about__stat-icon" aria-hidden="true">
                  {stat.icon}
                </span>
                <div className="about__stat-value">
                  <CountUp end={stat.value} suffix={stat.suffix} isVisible={isVisible} />
                </div>
                <p className="about__stat-label">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default About;
