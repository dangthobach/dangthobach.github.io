import './Skills.css';
import { useScrollReveal } from '../../hooks/useScrollReveal';
import { skillCategories } from '../../data/skills';

const SkillTag = ({ name, devicon }) => (
  <div className="skills__tag">
    {devicon && (
      <i
        className={`devicon-${devicon}-plain colored skills__devicon`}
        aria-hidden="true"
      />
    )}
    <span className="skills__tag-name">{name}</span>
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

      <div className="skills__list" aria-label={`Skills in ${category.category}`}>
        {category.skills.map((skill) => (
          <SkillTag key={skill.name} {...skill} />
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
