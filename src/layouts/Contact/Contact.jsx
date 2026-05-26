import './Contact.css';
import { useScrollReveal } from '../../hooks/useScrollReveal';

const CONTACTS = [
  {
    id: 'email-contact',
    label: 'Email',
    value: 'dangthobach@gmail.com',
    href: 'mailto:dangthobach@gmail.com',
    external: false,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="28" height="28" aria-hidden="true">
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
        <polyline points="22,6 12,13 2,6" />
      </svg>
    ),
  },
  {
    id: 'linkedin-contact',
    label: 'LinkedIn',
    value: 'linkedin.com/in/bach201197',
    href: 'https://www.linkedin.com/in/bach201197/',
    external: true,
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28" aria-hidden="true">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
      </svg>
    ),
  },
  {
    id: 'github-contact',
    label: 'GitHub',
    value: 'github.com/dangthobach',
    href: 'https://github.com/dangthobach',
    external: true,
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28" aria-hidden="true">
        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
      </svg>
    ),
  },
];

const Contact = () => {
  const [ref, isVisible] = useScrollReveal(0.1);

  return (
    <section id="contact" className="contact" ref={ref}>
      <div className="contact__inner section-inner">
        <div className={`contact__header reveal ${isVisible ? 'visible' : ''}`}>
          <p className="section-label">Let's connect</p>
          <h2 className="section-title">Get in Touch</h2>
          <div className="section-divider" />
          <p className="contact__subtitle">
            Open to senior and lead engineering roles, architecture consulting, and discussions about
            AI-augmented development practices.
          </p>
        </div>

        <div className="contact__grid">
          {CONTACTS.map((c, i) => (
            <a
              key={c.id}
              id={c.id}
              href={c.href}
              target={c.external ? '_blank' : undefined}
              rel={c.external ? 'noopener noreferrer' : undefined}
              className={`contact__card reveal ${isVisible ? 'visible' : ''} delay-${i + 1}`}
              aria-label={`Contact via ${c.label}`}
            >
              <div className="contact__card-icon">{c.icon}</div>
              <div className="contact__card-info">
                <span className="contact__card-label">{c.label}</span>
                <span className="contact__card-value">{c.value}</span>
              </div>
              <span className="contact__card-arrow" aria-hidden="true">→</span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Contact;
