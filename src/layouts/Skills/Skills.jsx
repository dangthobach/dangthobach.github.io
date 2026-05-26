import './Skills.css';
import { useScrollReveal } from '../../hooks/useScrollReveal';
import { skillCategories } from '../../data/skills';

const SkillBar = ({ name, level, devicon }) => (
  <div className="skills__skill">
    <div className="skills__skill-header">
      {devicon && (
        <i
          className={`devicon-${devicon}-plain colored skills__devicon`}
          aria-hidden="true"
        />
      )}
      <span className="skills__skill-name">{name}</span>
      <span className="skills__skill-pct">{level}%</span>
    </div>
    <div className="skills__bar-track" role="progressbar" aria-valuenow={level} aria-valuemin="0" aria-valuemax="100" aria-label={`${name} proficiency: ${level}%`}>
      <div
        className="skills__bar-fill"
        style={{ '--skill-level': `${level}%` }}
      />
    </div>
  </div>
);

const SkillCategory = ({ category, index }) => {
  const [ref, isVisible] = useScrollReveal(0.1);

  return (
    <div
      ref={ref}
      className={`skills__category reveal ${isVisible ? 'visible' : ''}`}
      style={{ transitionDelay: `${index * 0.08}s` }}
    >
      <div className="skills__cat-header">
        <span className="skills__cat-icon" aria-hidden="true">{category.icon}</span>
        <h3
          className="skills__cat-name"
          style={{ color: category.color }}
        >
          {category.category}
        </h3>
      </div>

      <div className="skills__list">
        {category.skills.map((skill) => (
          <SkillBar key={skill.name} {...skill} isParentVisible={isVisible} />
        ))}
      </div>
    </div>
  );
};

const Skills = () => {
  const [headerRef, headerVisible] = useScrollReveal(0.1);

  return (
    <section id="skills" className="skills">
      <div className="skills__inner section-inner">
        <div ref={headerRef} className={`skills__header reveal ${headerVisible ? 'visible' : ''}`}>
          <p className="section-label">Technical Expertise</p>
          <h2 className="section-title">Skills &amp; Stack</h2>
          <div className="section-divider" />
        </div>

        <div className="skills__grid">
          {skillCategories.map((cat, i) => (
            <SkillCategory key={cat.category} category={cat} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
};

export default Skills;
