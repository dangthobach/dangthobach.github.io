import "./Content.css";
import logo from '../../assets/profile-pic.jpg'; 
import linkedin from '../../assets/linkedin.png'; 
import github from '../../assets/github.png'; 

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
          <button className="btn btn-color-1" onClick="location.href='./#contact'">
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
    </>
  )
}

export default Content