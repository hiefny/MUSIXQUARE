// ─── Parse all .wl elements and pre-compute their animation data ───
declare global {
  interface Window {
    __promoSetTime(ms: number): void;
  }
}

type WriteDirection = 'wlr' | 'wrl' | 'wtb' | 'wbt' | 'wdiag';

interface WriteElementData {
  el: SVGElement;
  wt: number;
  wd: number;
  dir: WriteDirection;
}

function requireHtmlElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing HTML element #${id}.`);
  return element;
}

function requireSvgElement(id: string): SVGElement {
  const element = document.getElementById(id);
  if (!(element instanceof SVGElement)) throw new Error(`Missing SVG element #${id}.`);
  return element;
}

const wlData: WriteElementData[] = [];
document.querySelectorAll<SVGElement>('.wl').forEach((el) => {
  const style = el.style;
  const wt = parseFloat(style.getPropertyValue('--wt')) || 0; // ms
  const wd = parseFloat(style.getPropertyValue('--wd')) || 150; // ms

  // Direction classes encode which edge of the glyph reveals first.
  let dir: WriteDirection = 'wlr';
  if (el.classList.contains('wrl')) dir = 'wrl';
  if (el.classList.contains('wtb')) dir = 'wtb';
  if (el.classList.contains('wbt')) dir = 'wbt';
  if (el.classList.contains('wdiag')) dir = 'wdiag';

  wlData.push({ el, wt, wd, dir });
});

// Easing: approximate cubic-bezier(0.15, 0.5, 0.05, 1)
function ease(t: number): number {
  // Fast start, smooth deceleration
  return 1 - Math.pow(1 - t, 2.5);
}

// Set clip-path based on direction and progress (0→1)
function setClipPath(el: SVGElement, dir: WriteDirection, progress: number): void {
  const p = ease(progress);
  const remain = (1 - p) * 100;
  switch (dir) {
    case 'wlr':
      el.style.clipPath = `inset(0 ${remain}% 0 0)`;
      break;
    case 'wrl':
      el.style.clipPath = `inset(0 0 0 ${remain}%)`;
      break;
    case 'wtb':
      el.style.clipPath = `inset(0 0 ${remain}% 0)`;
      break;
    case 'wbt':
      el.style.clipPath = `inset(${remain}% 0 0 0)`;
      break;
    case 'wdiag':
      el.style.clipPath = `inset(0 ${remain}% ${remain}% 0)`;
      break;
  }
}

// ─── Timeline constants ───
const LOGO_WRITE_START = 1400; // ms — when letter writing begins
const NOTE_APPEAR = 200;
const NOTE_DRAW_START = 300;
const NOTE_DRAW_END = 1100;
const NOTE_FILL_START = 900;
const NOTE_FILL_END = 1300;
const GHOST_TIME = 1200;
const TAGLINE_START = 3200;
const PILLS_START = 3600;
const GLOW_START = 3800;

// ─── Main timeline controller ───
window.__promoSetTime = function (ms: number): void {
  const noteWrapper = requireHtmlElement('note-wrapper');
  const noteStroke = requireSvgElement('note-stroke');
  const noteFill = requireSvgElement('note-fill');
  const ghost = document.querySelector<SVGElement>('.wg');
  const tagline = requireHtmlElement('tagline');
  const pills = requireHtmlElement('pills');
  const glow = requireHtmlElement('glow');

  // Phase 1: Note icon scale-in (200ms)
  if (ms >= NOTE_APPEAR) {
    const p = Math.min((ms - NOTE_APPEAR) / 400, 1);
    const ep = 1 - Math.pow(1 - p, 3);
    noteWrapper.style.opacity = String(ep);
    noteWrapper.style.transform = `scale(${0.5 + 0.5 * ep})`;
  }

  // Phase 2: Note stroke draw-in (300–1100ms)
  if (ms >= NOTE_DRAW_START) {
    const p = Math.min((ms - NOTE_DRAW_START) / (NOTE_DRAW_END - NOTE_DRAW_START), 1);
    const ep = 1 - Math.pow(1 - p, 3);
    noteStroke.style.strokeDashoffset = String(60 * (1 - ep));
    noteStroke.style.opacity = '1';
  }

  // Phase 3: Note fill fade-in (900–1300ms)
  if (ms >= NOTE_FILL_START) {
    const p = Math.min((ms - NOTE_FILL_START) / (NOTE_FILL_END - NOTE_FILL_START), 1);
    noteFill.style.opacity = String(p);
  }

  // Phase 4: Ghost underlay (1200ms)
  if (ms >= GHOST_TIME && ghost) {
    const p = Math.min((ms - GHOST_TIME) / 300, 1);
    ghost.style.opacity = String(0.15 * p);
  }

  // Phase 5: Letter writing animation (1400ms+)
  // Each .wl element: startTime = LOGO_WRITE_START + wt, duration = wd
  wlData.forEach(({ el, wt, wd, dir }) => {
    const startTime = LOGO_WRITE_START + wt;
    if (ms < startTime) {
      return;
    }
    const progress = Math.min((ms - startTime) / wd, 1);
    setClipPath(el, dir, progress);
  });

  // Phase 6: Tagline (3200ms)
  if (ms >= TAGLINE_START) {
    const p = Math.min((ms - TAGLINE_START) / 500, 1);
    const ep = 1 - Math.pow(1 - p, 3);
    tagline.style.opacity = String(ep);
    tagline.style.transform = `translateY(${16 * (1 - ep)}px)`;
  }

  // Phase 7: Feature pills (3600ms)
  if (ms >= PILLS_START) {
    const p = Math.min((ms - PILLS_START) / 500, 1);
    const ep = 1 - Math.pow(1 - p, 3);
    pills.style.opacity = String(ep);
    pills.style.transform = `translateY(${16 * (1 - ep)}px)`;
  }

  // Phase 8: Glow pulse (3800ms)
  if (ms >= GLOW_START) {
    const p = Math.min((ms - GLOW_START) / 1200, 1);
    const pulse = Math.sin(p * Math.PI);
    glow.style.opacity = String(pulse * 0.8);
    glow.style.transform = `scale(${0.8 + pulse * 0.3})`;
  }
};

// Auto-play mode (for browser preview)
const params = new URLSearchParams(location.search);
if (params.get('autoplay') === 'true') {
  const startTime = performance.now();
  function loop(): void {
    const elapsed = performance.now() - startTime;
    window.__promoSetTime(elapsed);
    if (elapsed < 5000) requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}
