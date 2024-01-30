import './Project.css'

import project1 from "../../assets/project-1.png"
import project2 from "../../assets/project-2.png"
import project3 from "../../assets/project-3.png"
import arrow from "../../assets/arrow.png"
import "wired-elements"

const Project = () => {
    return (
        <>
        <section id="projects">
      <p className="section__text__p1">Browse My Recent</p>
      <h1 className="title">Projects</h1>
      <div className="project-details-container">
        <div className="project-containers">
        <wired-card elevation="5" class="detail-container">
              <wired-image
                src={project1}
                alt="Project 1"
              ></wired-image>
            <h2 className="project-title">Project One</h2>
            <div className="btn-container">
              
                <wired-button>
                Github
                </wired-button>
              <wired-button>
                Live Demo
                </wired-button>
            </div>
          </wired-card>
          <wired-card elevation="5" class="detail-container">
              <wired-image
                src={project2}
                alt="Project 1"
              ></wired-image>
            <h2 className="project-title">Project Two</h2>
            <div className="btn-container">
              
                <wired-button>
                Github
                </wired-button>
              <wired-button>
                Live Demo
                </wired-button>
            </div>
          </wired-card>
          <wired-card elevation="5" class="detail-container">
              <wired-image
                src={project3}
                alt="Project 1"
              ></wired-image>
            <h2 className="project-title">Project Three</h2>
            <div className="btn-container">
              
                <wired-button>
                Github
                </wired-button>
              <wired-button>
                Live Demo
                </wired-button>
            </div>
          </wired-card>
          </div>
        </div>
      <img
        src={arrow}
        alt="Arrow icon"
        className="icon arrow"
      />
    </section>
        </>
    )
}

export default Project;