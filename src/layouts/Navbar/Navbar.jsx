import { useState } from "react";
import "./Navbar.css";
import { RoughNotation} from "react-rough-notation";


const Navbar = () => {
  const divider = {
    margin : "0 10rem"
  }
 
  const [isShown, setIsShown] = useState([false,false,false,false]);

  const handleMouseOver = (index) => {
    const newArray = [...isShown];
    newArray[index] = true;
    setIsShown(newArray);
  };

  const handleMouseOut = (index) => {
    const newArray = [...isShown];
    newArray[index] = false;
    setIsShown(newArray);
  };
  return (
    <>
    <nav id="desktop-nav">
        <div className="logo">Codegap</div>
        <div>
          <ul className="nav-links" id="menu">
            <li><a href="#about" onMouseOver={()=>handleMouseOver(0)} onMouseOut={()=>handleMouseOut(0)}><RoughNotation type = "underline" show = {isShown[0]}>About</RoughNotation></a></li>
            <li><a href="#experience"  onMouseOver={()=>handleMouseOver(1)} onMouseOut={()=>handleMouseOut(1)}><RoughNotation type = "underline" show = {isShown[1]}>Experience</RoughNotation></a></li>
            <li><a href="#projects" onMouseOver={()=>handleMouseOver(2)} onMouseOut={()=>handleMouseOut(2)}><RoughNotation type = "underline" show = {isShown[2]}>Projects</RoughNotation></a></li>
            <li><a href="#contact" onMouseOver={()=>handleMouseOver(3)} onMouseOut={()=>handleMouseOut(3)}><RoughNotation type = "underline" show = {isShown[3]}>Contact</RoughNotation></a></li>
          </ul>
        </div>
      </nav>
      <wired-divider style={divider}></wired-divider>
      </>
  )
}

export default Navbar