import '@fontsource-variable/bricolage-grotesque/index.css';
import '@fontsource-variable/plus-jakarta-sans/index.css';
import './styles.css';

// Nav tucks away while reading, same as the legal pages.
const nav = document.getElementById('nav');
let last = window.scrollY;
window.addEventListener(
  'scroll',
  () => {
    const y = window.scrollY;
    nav.classList.toggle('is-hidden', y > last && y > 120);
    nav.classList.toggle('is-light', y > window.innerHeight * 0.8);
    last = y;
  },
  { passive: true },
);

// Reveal on scroll.
const items = document.querySelectorAll('[data-in]');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }),
    { threshold: 0.15 },
  );
  items.forEach((el) => io.observe(el));
} else {
  items.forEach((el) => el.classList.add('in'));
}

// Card spotlight follows the pointer.
document.querySelectorAll('[data-spot]').forEach((card) => {
  card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
});

// Copy the address.
const btn = document.getElementById('copyMail');
if (btn) {
  const label = btn.querySelector('span');
  btn.addEventListener('click', async () => {
    const mail = btn.dataset.mail;
    try {
      await navigator.clipboard.writeText(mail);
    } catch {
      const t = document.createElement('textarea');
      t.value = mail; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      t.remove();
    }
    btn.classList.add('is-done');
    label.textContent = 'Copied';
    setTimeout(() => { btn.classList.remove('is-done'); label.textContent = 'Copy address'; }, 1800);
  });
}
