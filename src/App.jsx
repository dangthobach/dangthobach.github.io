import './App.css';
import Navbar from './layouts/Navbar/Navbar';
import Hero from './layouts/Hero/Hero';
import About from './layouts/About/About';
import Experience from './layouts/Experience/Experience';
import Projects from './layouts/Projects/Projects';
import Skills from './layouts/Skills/Skills';
import Blog from './layouts/Blog/Blog';
import Contact from './layouts/Contact/Contact';

function App() {
  return (
    <div className="app">
      <Navbar />
      <main>
        <Hero />
        <About />
        <Experience />
        <Projects />
        <Skills />
        <Blog />
        <Contact />
      </main>
      <footer className="footer">
        <div className="footer__inner">
          <div className="footer__left">
            <span className="footer__brand">
              <span>{'<'}</span>DTB<span>{' />'}</span>
            </span>
            <span className="footer__copy">© 2025 Dang Tho Bach. Built with ☕ and Java.</span>
          </div>
          <nav className="footer__nav">
            <a href="#about">About</a>
            <a href="#experience">Experience</a>
            <a href="#projects">Projects</a>
            <a href="#skills">Skills</a>
            <a href="#contact">Contact</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

export default App;
