import '@fontsource-variable/bricolage-grotesque/index.css';
import '@fontsource-variable/plus-jakarta-sans/index.css';
import './styles.css';

import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';

gsap.registerPlugin(ScrollTrigger);

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const isMobile = () => window.innerWidth <= 980;

/* ─────────── 1. Clone phone screens from <template>s ─────────── */
$$('[data-clone]').forEach((host) => {
  const tpl = document.getElementById(host.dataset.clone);
  if (tpl) host.appendChild(tpl.content.cloneNode(true));
});

/* ─────────── 2. Step state (works with or without motion) ─────────── */
const steps = $$('.step');
const screens = $$('#howScreens .screen');
let activeStep = 0;
function setStep(i) {
  if (i === activeStep) return;
  activeStep = i;
  steps.forEach((s, n) => s.classList.toggle('is-active', n === i));
  screens.forEach((s, n) => s.classList.toggle('is-on', n === i));
}

/* ─────────── 3. FAQ: one open at a time ─────────── */
const items = $$('.acc__item');
items.forEach((d) => {
  d.addEventListener('toggle', () => {
    if (!d.open) return;
    items.forEach((o) => { if (o !== d) o.open = false; });
    if (!reduced) gsap.fromTo($('p', d), { y: -10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: 'power3.out' });
  });
});

/* ─────────── Reduced motion: static page, clickable steps ─────────── */
if (reduced) {
  steps.forEach((s, n) => s.addEventListener('click', () => setStep(n)));
  $('#footWord').style.setProperty('--fill', '100%');
} else {
  initMotion();
}

function initMotion() {
  document.documentElement.classList.add('js-motion');
  window.scrollTo(0, 0);
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  /* ── smooth scroll ── */
  const lenis = new Lenis({ duration: 1.15, easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)), smoothWheel: true });
  lenis.stop();
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);

  $$('a[href^="#"]').forEach((a) =>
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      const target = id.length > 1 ? $(id) : null;
      if (!target) return;
      e.preventDefault();
      lenis.scrollTo(target, { duration: 1.6 });
    }),
  );

  /* ── split text into masked words ── */
  function splitWords(el) {
    const words = [];
    const nodes = Array.from(el.childNodes);
    el.textContent = '';
    const wrap = (node) => {
      const w = document.createElement('span');
      w.className = 'w';
      const wi = document.createElement('span');
      wi.className = 'wi';
      wi.appendChild(node);
      w.appendChild(wi);
      el.appendChild(w);
      words.push(wi);
    };
    nodes.forEach((n) => {
      if (n.nodeType === 3) {
        n.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) el.appendChild(document.createTextNode(' '));
          else if (/^[.,!?;:]+$/.test(part) && words.length && el.lastChild === words[words.length - 1].parentNode) {
            words[words.length - 1].appendChild(document.createTextNode(part)); // keep punctuation glued to the previous word
          } else wrap(document.createTextNode(part));
        });
      } else if (n.nodeName === 'BR') {
        el.appendChild(n);
      } else {
        wrap(n);
      }
    });
    return words;
  }

  const heroTitle = $('.hero__title');
  const heroWords = splitWords(heroTitle);
  const otherSplits = $$('[data-split]').filter((el) => el !== heroTitle).map((el) => ({ el, words: splitWords(el) }));

  /* ── initial hidden states (JS-only, so no-JS users still see everything) ── */
  gsap.set(heroWords, { yPercent: 115, rotate: 4 });
  gsap.set('.hero [data-reveal]', { y: 30, opacity: 0 });
  gsap.set('.hl', { '--hl': 0 });
  $('.hl__smile path').setAttribute('pathLength', '1');
  gsap.set('.hl', { '--sd': 1 });
  gsap.set('.nav', { yPercent: -160 });
  gsap.set('#heroPhone', { y: 140, opacity: 0, rotateX: 18 });
  gsap.set('.chip', { scale: 0.6, opacity: 0 });
  gsap.set('.scrollhint', { opacity: 0 });
  gsap.set('.loader__word span', { yPercent: 110 });
  gsap.set('.loader__mark', { scale: 0.6, opacity: 0 });

  /* ── loader → hero intro ── */
  const intro = gsap.timeline({ defaults: { ease: 'expo.out' }, paused: true, onComplete: () => lenis.start() });
  intro
    .to('.nav', { yPercent: 0, duration: 1.2 }, 0.1)
    .to(heroWords, { yPercent: 0, rotate: 0, duration: 1.3, stagger: 0.07 }, 0)
    .to('.hero [data-reveal]', { y: 0, opacity: 1, duration: 1, stagger: 0.12 }, 0.35)
    .to('.hl', { '--hl': 1, duration: 0.9, ease: 'power4.inOut' }, 0.85)
    .to('.hl', { '--sd': 0, duration: 0.8, ease: 'power2.inOut' }, 1.25)
    .to('#heroPhone', { y: 0, opacity: 1, rotateX: 0, duration: 1.6 }, 0.2)
    .to('.chip', { scale: 1, opacity: 1, duration: 1, stagger: 0.12, ease: 'back.out(1.8)' }, 0.9)
    .to('.scrollhint', { opacity: 1, duration: 1 }, 1.4);

  const loader = gsap.timeline({ onComplete: () => { $('.loader').style.display = 'none'; } });
  loader
    .to('.loader__mark', { scale: 1, opacity: 1, duration: 0.7, ease: 'back.out(1.6)' })
    .to('.loader__word span', { yPercent: 0, duration: 0.6, stagger: 0.05, ease: 'power4.out' }, 0.2)
    .to('.loader', { yPercent: -100, duration: 0.9, ease: 'power4.inOut' }, '+=0.35')
    .add(() => intro.play(), '-=0.45');

  /* ── generic scroll reveals ── */
  otherSplits.forEach(({ el, words }) => {
    gsap.from(words, {
      yPercent: 115, rotate: 3, duration: 1.1, stagger: 0.06, ease: 'expo.out',
      scrollTrigger: { trigger: el, start: 'top 88%', once: true },
    });
  });
  $$('[data-reveal]').filter((el) => !el.closest('.hero')).forEach((el) => {
    gsap.from(el, { y: 40, opacity: 0, duration: 1, ease: 'expo.out', scrollTrigger: { trigger: el, start: 'top 90%', once: true } });
  });
  gsap.from('.card', { y: 90, opacity: 0, duration: 1.1, stagger: 0.14, ease: 'expo.out', scrollTrigger: { trigger: '.cards', start: 'top 80%', once: true } });

  /* ── hero: pointer tilt + parallax chips, scroll parallax ── */
  const stage = $('.hero__stage');
  if (finePointer) {
    const rx = gsap.quickTo('#heroPhone', 'rotateX', { duration: 0.9, ease: 'power3' });
    const ry = gsap.quickTo('#heroPhone', 'rotateY', { duration: 0.9, ease: 'power3' });
    const chips = $$('.chip').map((c) => ({
      depth: parseFloat(c.dataset.depth),
      x: gsap.quickTo(c, 'x', { duration: 1.1, ease: 'power3' }),
      y: gsap.quickTo(c, 'y', { duration: 1.1, ease: 'power3' }),
    }));
    window.addEventListener('mousemove', (e) => {
      const nx = e.clientX / window.innerWidth - 0.5;
      const ny = e.clientY / window.innerHeight - 0.5;
      ry(nx * 16);
      rx(-ny * 12);
      chips.forEach((c) => { c.x(nx * 34 * c.depth); c.y(ny * 34 * c.depth); });
    });
  }
  gsap.to('.hero__stage', { yPercent: -8, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
  gsap.to('.hero__bigmark', { rotate: 6, yPercent: -42, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
  gsap.to('.hero__rings i', { scale: 1.25, ease: 'none', stagger: 0.05, scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
  gsap.to('.hero__copy', { yPercent: 10, opacity: 0.25, ease: 'none', scrollTrigger: { trigger: '.hero', start: '35% top', end: 'bottom top', scrub: true } });

  /* ── marquee (scroll-velocity aware) ── */
  const track = $('.marquee__track');
  const rowW = () => $('.marquee__row', track).offsetWidth;
  let mx = 0;
  let skew = 0;
  gsap.ticker.add(() => {
    const v = lenis.velocity || 0;
    mx -= 1.1 + Math.min(Math.abs(v), 40) * 0.35 * Math.sign(v || 1);
    const w = rowW();
    if (w) { if (mx <= -w) mx += w; if (mx > 0) mx -= w; }
    skew += (gsap.utils.clamp(-8, 8, v * 0.3) - skew) * 0.1;
    gsap.set(track, { x: mx, skewX: -skew });
  });

  /* ── How it works: pinned, scroll-scrubbed steps ── */
  ScrollTrigger.matchMedia({
    all: () => {
      const st = ScrollTrigger.create({
        trigger: '.how__pin',
        start: 'top top',
        end: () => (isMobile() ? '+=260%' : '+=320%'),
        pin: true,
        anticipatePin: 1,
        scrub: true,
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          setStep(Math.min(3, Math.floor(self.progress * 4)));
          gsap.set('#progressBar', { scaleX: Math.max(0.02, self.progress) });
        },
      });
      steps.forEach((s, n) =>
        s.addEventListener('click', () => lenis.scrollTo(st.start + ((n + 0.5) / 4) * (st.end - st.start), { duration: 1.4 })),
      );
      gsap.to('.how__halo', { scale: 1.25, rotate: 90, ease: 'none', scrollTrigger: { trigger: '.how__pin', start: 'top top', end: () => st.end, scrub: true } });
    },
  });

  /* ── apps: card spotlight + tilt ── */
  if (finePointer) {
    $$('[data-tilt]').forEach((card) => {
      const rX = gsap.quickTo(card, 'rotateX', { duration: 0.6, ease: 'power3' });
      const rY = gsap.quickTo(card, 'rotateY', { duration: 0.6, ease: 'power3' });
      gsap.set(card, { transformPerspective: 1000 });
      card.addEventListener('mousemove', (e) => {
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width;
        const py = (e.clientY - r.top) / r.height;
        card.style.setProperty('--mx', `${px * 100}%`);
        card.style.setProperty('--my', `${py * 100}%`);
        rY((px - 0.5) * 10);
        rX(-(py - 0.5) * 10);
      });
      card.addEventListener('mouseleave', () => { rX(0); rY(0); });
    });
  }

  /* ── bento: status rail + OTP scramble ── */
  const rail = $$('#rail span');
  let railTimer = null;
  let railI = -1;
  ScrollTrigger.create({
    trigger: '#rail',
    start: 'top 85%',
    end: 'bottom 5%',
    onToggle: (self) => {
      clearInterval(railTimer);
      if (!self.isActive) return;
      railTimer = setInterval(() => {
        railI = (railI + 1) % (rail.length + 2);
        rail.forEach((s, n) => s.classList.toggle('on', n === railI));
      }, 850);
    },
  });
  const otp = $$('.otp span');
  ScrollTrigger.create({
    trigger: '.otp',
    start: 'top 88%',
    once: true,
    onEnter: () => {
      otp.forEach((el, n) => {
        let ticks = 0;
        const t = setInterval(() => {
          el.textContent = Math.floor(Math.random() * 10);
          if (++ticks > 10 + n * 5) { clearInterval(t); el.textContent = [4, 8, 2, 7][n]; }
        }, 55);
      });
    },
  });

  /* ── footer wordmark fills up as you arrive ── */
  gsap.fromTo('#footWord', { '--fill': '0%' }, { '--fill': '100%', ease: 'none', scrollTrigger: { trigger: '.foot', start: 'top 90%', end: 'top 10%', scrub: true } });

  /* ── nav: hide on scroll down / theme over light sections ── */
  const nav = $('#nav');
  lenis.on('scroll', ({ direction, scroll }) => {
    if (scroll < 120) nav.classList.remove('is-hidden');
    else nav.classList.toggle('is-hidden', direction === 1);
  });
  $$('.how, .campus, .faq, .cta').forEach((sec) => {
    ScrollTrigger.create({ trigger: sec, start: 'top 44px', end: 'bottom 44px', onToggle: (s) => nav.classList.toggle('is-light', s.isActive) });
  });

  /* ── cursor + magnetic buttons ── */
  if (finePointer) {
    const dot = $('.cursor__dot');
    const ring = $('.cursor__ring');
    const cur = $('.cursor');
    const dx = gsap.quickSetter(dot, 'x', 'px');
    const dy = gsap.quickSetter(dot, 'y', 'px');
    const rx = gsap.quickTo(ring, 'x', { duration: 0.45, ease: 'power3' });
    const ry = gsap.quickTo(ring, 'y', { duration: 0.45, ease: 'power3' });
    window.addEventListener('mousemove', (e) => { dx(e.clientX); dy(e.clientY); rx(e.clientX); ry(e.clientY); });
    document.addEventListener('mouseover', (e) => cur.classList.toggle('is-hot', !!e.target.closest('a, button, summary, .card, .step')));

    $$('[data-magnetic]').forEach((el) => {
      const mxq = gsap.quickTo(el, 'x', { duration: 0.6, ease: 'elastic.out(1, 0.45)' });
      const myq = gsap.quickTo(el, 'y', { duration: 0.6, ease: 'elastic.out(1, 0.45)' });
      el.addEventListener('mousemove', (e) => {
        const r = el.getBoundingClientRect();
        mxq((e.clientX - (r.left + r.width / 2)) * 0.28);
        myq((e.clientY - (r.top + r.height / 2)) * 0.36);
      });
      el.addEventListener('mouseleave', () => { mxq(0); myq(0); });
    });
  }

  document.fonts.ready.then(() => ScrollTrigger.refresh());
  window.addEventListener('load', () => ScrollTrigger.refresh());
}
