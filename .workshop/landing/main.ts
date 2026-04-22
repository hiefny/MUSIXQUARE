/**
 * MUSIXQUARE landing — reveal-on-scroll with in-viewport fallback.
 */

function isInViewport(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return r.top < vh - 80 && r.bottom > 0;
}

function initReveal(): void {
  const targets = document.querySelectorAll<HTMLElement>('[data-animate]');
  if (targets.length === 0) return;

  if (!('IntersectionObserver' in window)) {
    targets.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const initiallyVisible: HTMLElement[] = [];
  targets.forEach((el) => {
    if (isInViewport(el)) initiallyVisible.push(el);
  });
  if (initiallyVisible.length > 0) {
    setTimeout(() => {
      initiallyVisible.forEach((el) => el.classList.add('is-visible'));
    }, 20);
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -80px 0px' },
  );

  targets.forEach((el) => {
    if (!initiallyVisible.includes(el)) observer.observe(el);
  });
}

function initScrollProgress(): void {
  const bar = document.querySelector<HTMLElement>('.lp-header-progress');
  if (!bar) return;
  const doc = document.documentElement;
  let raf = 0;
  const update = () => {
    raf = 0;
    const max = doc.scrollHeight - doc.clientHeight;
    const pct = max > 0 ? (doc.scrollTop / max) * 100 : 0;
    bar.style.width = pct + '%';
  };
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(update);
  };
  update();
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
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

function initCopyInvite(): void {
  const btn = document.getElementById('lp-copy-link');
  const toast = document.getElementById('lp-toast');
  const toastMsg = document.getElementById('lp-toast-msg');
  if (!btn || !toast || !toastMsg) return;

  let hideTimer = 0;
  const flash = (text: string): void => {
    toastMsg.textContent = text;
    toast.classList.add('show');
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      toast.classList.remove('show');
    }, 2000);
  };

  btn.addEventListener('click', async () => {
    const url = 'https://musixquare.com';
    try {
      await navigator.clipboard.writeText(url);
      flash('Invite link copied');
    } catch {
      flash('Copy failed');
    }
  });
}

function boot(): void {
  initReveal();
  initSmoothAnchor();
  initScrollProgress();
  initCopyInvite();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
