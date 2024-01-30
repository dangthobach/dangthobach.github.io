import "./Content.css"
import "../../layouts/mediaqueries.css"
import logo from "../../assets/profile-pic.jpg"
import linkedin from "../../assets/linkedin.png"
import github from "../../assets/github.png"
import arrow from "../../assets/arrow.png"
import "wired-elements";
import mail from "../../assets/email.png"
import Project from "../Project/Project"
import Blog from "../Blog/Blog"


const Content = () => {
  return (
    <>
      <section id="profile">
        <div className="section__pic-container">
          <img src={logo} alt="John Doe profile picture" />
        </div>
        <div className="section__text">
          <p className="section__text__p1">Hello, I'm</p>
          <h1 className="title">Dang Tho Bach</h1>
          <p className="section__text__p2">Fullstack Developer</p>
          <div className="btn-container">
            <button
              className="btn btn-color-2"
              onClick="window.open('./assets/resume-example.pdf')"
            >
              Download CV
            </button>
            <button
              className="btn btn-color-1"
              onClick="location.href='./#contact'"
            >
              Contact Info
            </button>
          </div>
          <div id="socials-container">
            <img
              src={linkedin}
              alt="My LinkedIn profile"
              className="icon"
              onClick="location.href='https://linkedin.com/'"
            />
            <img
              src={github}
              alt="My Github profile"
              className="icon"
              onClick="location.href='https://github.com/'"
            />
          </div>
        </div>
      </section>
      <section id="about">
        <p className="section__text__p1">Get To Know More</p>
        <h1 className="title">About Me</h1>
        <div className="section-container">
          <div className="about-details-container">
          <wired-card elevation="5">
          Takuya is a freelance and a full-stack developer based in Osaka with a passion for building digital services/stuff he wants. He has a knack for all things launching products, from planning and designing all the way to solving real-life problems with code. When not online, he loves hanging out with his camera. Currently, he is living off of his own product called Inkdrop. He publishes content for marketing his products and his YouTube channel called "Dev as Life" has more than 100k subscribers.
            </wired-card>
          </div>
        </div>
        <img
          src={arrow}
          alt="Arrow icon"
          className="icon arrow"
          onClick="location.href='./#experience'"
        />
      </section>

      <Project></Project>
      <Blog></Blog>

      <section id="contact">
      <p className="section__text__p1">Get in Touch</p>
      <h1 className="title">Contact Me</h1>
      <div className="contact-info-upper-container">
        <div className="contact-info-container">
          <img
            src={mail}
            alt="Email icon"
            className="icon contact-icon email-icon"
          />
          <p><a href="mailto:examplemail@gmail.com">Example@gmail.com</a></p>
        </div>
        <div className="contact-info-container">
          <img
            src={linkedin}
            alt="LinkedIn icon"
            className="icon contact-icon"
          />
          <p><a href="https://www.linkedin.com">LinkedIn</a></p>
        </div>
      </div>
    </section>
      <footer>
      <nav>
        <div className="nav-links-container">
          <ul className="nav-links">
            <li><a href="#about">About</a></li>
            <li><a href="#experience">Experience</a></li>
            <li><a href="#projects">Projects</a></li>
            <li><a href="#contact">Contact</a></li>
          </ul>
        </div>
      </nav>
      <p>Copyright &#169; 2024 Codegap. All Rights Reserved.</p>
    </footer>
    </>
  );
};

export default Content;
