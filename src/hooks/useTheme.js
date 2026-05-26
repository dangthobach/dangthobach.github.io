import { useState, useEffect } from 'react';

const STORAGE_KEY = 'portfolio-theme';

export const useTheme = () => {
  const [theme, setTheme] = useState(() => {
    // Read from localStorage — default is 'light'
    if (typeof window !== 'undefined') {
      return localStorage.getItem(STORAGE_KEY) || 'light';
    }
    return 'light';
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.setAttribute('data-theme', 'dark');
    } else {
      root.removeAttribute('data-theme');
    }
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  return { theme, toggleTheme };
};
