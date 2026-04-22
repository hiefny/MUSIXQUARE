/**
 * MUSIXQUARE landing page — minimal entry.
 * Reveals stage and scroll-in elements via IntersectionObserver.
 */

const REVEAL_SELECTORS = [
  '[data-animate="stage"]',
  '[data-animate="fade"]',
  '[data-animate="chat"]',
  '.lp-feature',
  '.lp-step',
  '.lp-cta__inner',
  '.lp-features__head',
];

function isInViewport(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return r.top < vh - 60 && r.bottom > 0;
}

function initReveal(): void {
  const targets = document.querySelectorAll<HTMLElement>(REVEAL_SELECTORS.join(','));

  if (!('IntersectionObserver' in window)) {
    targets.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  targets.forEach((el) => {
    if (isInViewport(el)) el.classList.add('is-visible');
  });

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -60px 0px' },
  );

  targets.forEach((el) => {
    if (!el.classList.contains('is-visible')) observer.observe(el);
  });
}

function initSmoothAnchor(): void {
  document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const id = link.getAttribute('href')?.slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function boot(): void {
  initReveal();
  initSmoothAnchor();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
