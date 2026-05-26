import { useState, useEffect, useRef } from 'react';

export const useTypingAnimation = (texts, speed = 80, pauseDuration = 2200) => {
  const [displayText, setDisplayText] = useState('');
  const [textIndex, setTextIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const isPausing = useRef(false);

  useEffect(() => {
    if (isPausing.current) return;

    const currentText = texts[textIndex];

    const timer = setTimeout(() => {
      if (!isDeleting) {
        if (charIndex < currentText.length) {
          setDisplayText(currentText.slice(0, charIndex + 1));
          setCharIndex((c) => c + 1);
        } else {
          isPausing.current = true;
          setTimeout(() => {
            isPausing.current = false;
            setIsDeleting(true);
          }, pauseDuration);
        }
      } else {
        if (charIndex > 0) {
          setDisplayText(currentText.slice(0, charIndex - 1));
          setCharIndex((c) => c - 1);
        } else {
          setIsDeleting(false);
          setTextIndex((i) => (i + 1) % texts.length);
        }
      }
    }, isDeleting ? speed / 2 : speed);

    return () => clearTimeout(timer);
  }, [charIndex, isDeleting, textIndex, texts, speed, pauseDuration]);

  return displayText;
};
