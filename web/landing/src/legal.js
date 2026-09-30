import '@fontsource-variable/bricolage-grotesque/index.css';
import '@fontsource-variable/plus-jakarta-sans/index.css';
import './styles.css';

// Legal pages are static on purpose: no scroll-jacking, just a nav that tucks away while reading.
const nav = document.getElementById('nav');
let last = window.scrollY;
window.addEventListener(
  'scroll',
  () => {
    const y = window.scrollY;
    nav.classList.toggle('is-hidden', y > last && y > 120);
    last = y;
  },
  { passive: true },
);
