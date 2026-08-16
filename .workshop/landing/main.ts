/**
 * MUSIXQUARE About page interactions: navigation progress, localized invite
 * copy, reveal effects, and reduced-motion-aware product illustrations.
 */

const EDITORIAL_LOAD_DELAY_MS = 300;

type LandingTranslator = (key: string, fallback: string) => string;
type LandingWindow = Window & { __landingT?: LandingTranslator };

let updateHeaderProgress: (() => void) | null = null;
let pendingEditorialNavigation = false;

function translateLanding(key: string, fallback: string): string {
  const landingWindow: LandingWindow = window;
  const translator = landingWindow.__landingT;
  return typeof translator === 'function' ? translator(key, fallback) : fallback;
}

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
  const header = document.querySelector<HTMLElement>('.lp-header');
  const doc = document.documentElement;
  let raf = 0;
  const update = () => {
    raf = 0;
    if (header?.classList.contains('is-loading')) return;
    const max = doc.scrollHeight - doc.clientHeight;
    const pct = max > 0 ? (doc.scrollTop / max) * 100 : 0;
    bar.style.width = pct + '%';
  };
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(update);
  };
  updateHeaderProgress = update;
  update();
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
}

function setHeaderLoading(loading: boolean): void {
  const header = document.querySelector<HTMLElement>('.lp-header');
  const bar = document.querySelector<HTMLElement>('.lp-header-progress');
  if (!header) return;

  if (loading) {
    header.classList.add('is-loading');
    if (bar) bar.style.width = '100%';
    return;
  }

  header.classList.remove('is-loading');
  requestAnimationFrame(() => updateHeaderProgress?.());
}

function initEditorialPageLoader(): void {
  window.setTimeout(() => setHeaderLoading(false), EDITORIAL_LOAD_DELAY_MS);

  document.querySelectorAll<HTMLAnchorElement>('.editorial-site-tab[href]').forEach((link) => {
    link.addEventListener('click', (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const href = link.getAttribute('href');
      if (!href) return;

      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return;

      event.preventDefault();
      if (pendingEditorialNavigation) return;

      pendingEditorialNavigation = true;
      setHeaderLoading(true);
      window.setTimeout(() => {
        window.location.assign(url.href);
      }, EDITORIAL_LOAD_DELAY_MS);
    });
  });
}

function initHairlineScale(): void {
  const update = (): void => {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    document.documentElement.style.setProperty('--hairline-scale', String(Math.min(1, 1 / dpr)));
  };

  update();
  window.addEventListener('resize', update, { passive: true });
}

function initSmoothAnchor(): void {
  document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const id = link.getAttribute('href')?.slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      if (id === 'top') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
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
      flash(translateLanding('code.toast_success', 'Invite link copied'));
    } catch {
      flash(translateLanding('code.toast_fail', 'Copy failed'));
    }
  });
}

function initRoomCount(): void {
  const el = document.querySelector<HTMLElement>('[data-room-count]');
  if (!el) return;

  const rawCount = document.documentElement.dataset.mxqrRoomsOpened?.trim() ?? '';
  const parsedCount = /^\d+$/.test(rawCount) ? Number(rawCount) : Number.NaN;
  const count = Number.isSafeInteger(parsedCount) && parsedCount >= 0 ? parsedCount : null;
  if (count == null) return;

  const render = (): void => {
    if (count == null) return;

    const template = translateLanding('hero.rooms_opened', '{{count}} rooms opened so far.');
    const placeholder = '{{count}}';
    const placeholderIndex = template.indexOf(placeholder);
    if (placeholderIndex < 0) return;

    const locale = document.documentElement.lang || 'en';
    let formattedCount: string;
    try {
      formattedCount = new Intl.NumberFormat(
        locale,
        count < 10_000 ? undefined : { notation: 'compact', maximumFractionDigits: 1 },
      ).format(count);
    } catch {
      // Older WebKit builds may not support compact notation. The exact
      // integer is still a truthful, readable fallback and must not abort the
      // rest of the About-page interactions.
      formattedCount = String(count);
    }
    const value = document.createElement('strong');
    value.textContent = formattedCount;
    const beforeCount = template.slice(0, placeholderIndex);
    let afterCount = template.slice(placeholderIndex + placeholder.length);
    const copy = document.createElement('span');
    copy.className = 'lp-room-count__copy';
    copy.append(document.createTextNode(beforeCount));
    if (locale.toLowerCase().startsWith('ko') && afterCount.startsWith('개의')) {
      const quantity = document.createElement('span');
      quantity.className = 'lp-room-count__quantity';
      quantity.append(value, document.createTextNode('개의'));
      copy.append(quantity);
      afterCount = afterCount.slice('개의'.length);
    } else {
      copy.append(value);
    }
    copy.append(document.createTextNode(afterCount));
    el.replaceChildren(copy);
    el.hidden = false;
  };

  window.addEventListener('mxqr:static-language-change', render);
  render();
}

function pad(n: number, len: number): string {
  return String(n).padStart(len, '0');
}

function formatSec(totalMs: number): string {
  const ms = Math.max(0, Math.floor(totalMs));
  const mm = Math.floor(ms / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  return `${pad(mm, 2)}:${pad(ss, 2)}`;
}

function formatMsPart(totalMs: number): string {
  const ms = Math.max(0, Math.floor(totalMs)) % 1000;
  return pad(ms, 3);
}

function initSyncClock(): void {
  const root = document.querySelector<HTMLElement>('[data-sync-clock]');
  if (!root) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const host = root.querySelector<HTMLElement>('[data-sync-tc="host"]');
  const peers = root.querySelectorAll<HTMLElement>('[data-sync-tc^="peer"]');
  if (!host || peers.length === 0) return;

  // Preserve the <em> structure for the host ms part (primary color).
  const hostEm = host.querySelector('em');
  // First text node (the "00:29." part before the em)
  let hostPrefixNode: Text | null = null;
  for (const n of host.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) {
      hostPrefixNode = n as Text;
      break;
    }
  }

  // Count 00:00.000 → 00:32.000 continuously, then hold dark for 0.5s.
  // [0s,    2s]   fade in  (opacity 0 → 1 while counting 0→2)
  // [2s,   30s]   full opacity (counting 2→30)
  // [30s,  32s]   fade out (opacity 1 → 0 while counting 30→32)
  // [32s,  32.5s] dark pause (opacity 0, host display reset to 0)
  const FADE_IN_END = 2_000;
  const FADE_OUT_START = 30_000;
  const FADE_OUT_END = 32_000;
  const CYCLE_MS = 32_500;
  const start = performance.now();

  function render(): void {
    const elapsed = (performance.now() - start) % CYCLE_MS;
    let hostMs: number;
    let opacity: number;

    if (elapsed < FADE_IN_END) {
      hostMs = elapsed;
      opacity = elapsed / FADE_IN_END; // 0 → 1
    } else if (elapsed < FADE_OUT_START) {
      hostMs = elapsed;
      opacity = 1;
    } else if (elapsed < FADE_OUT_END) {
      hostMs = elapsed;
      opacity = 1 - (elapsed - FADE_OUT_START) / (FADE_OUT_END - FADE_OUT_START); // 1 → 0
    } else {
      hostMs = 0; // pre-reset during dark
      opacity = 0;
    }

    if (hostPrefixNode) hostPrefixNode.nodeValue = `${formatSec(hostMs)}.`;
    if (hostEm) hostEm.textContent = formatMsPart(hostMs);
    host!.style.opacity = opacity.toFixed(2);

    peers.forEach((el) => {
      const offset = Number(el.dataset.offset ?? 0);
      const peerMs = hostMs - offset;
      el.textContent = `${formatSec(peerMs)}.${formatMsPart(peerMs)}`;
      el.style.opacity = opacity.toFixed(2);
    });

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}

function initCodeCycle(): void {
  const code = document.querySelector<HTMLElement>('[data-code-cycle]');
  if (!code) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const digits = code.querySelectorAll<HTMLElement>('em');
  if (digits.length === 0) return;

  let i = 0;
  digits.item(i).classList.add('is-lit');
  setInterval(() => {
    digits.item(i).classList.remove('is-lit');
    i = (i + 1) % digits.length;
    digits.item(i).classList.add('is-lit');
  }, 1000);
}

function initPhoneTilt(): void {
  const phone = document.querySelector<HTMLElement>('[data-phone-tilt]');
  if (!phone) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const base = { rx: 6, ry: -14 };
  let raf = 0;
  let targetRx = base.rx,
    targetRy = base.ry,
    targetTy = 0;
  let curRx = base.rx,
    curRy = base.ry,
    curTy = 0;

  const onMove = (e: PointerEvent) => {
    const dx = (e.clientX - window.innerWidth / 2) / window.innerWidth;
    const dy = (e.clientY - window.innerHeight / 2) / window.innerHeight;
    targetRy = base.ry + dx * 10;
    targetRx = base.rx - dy * 8;
  };
  const onScroll = () => {
    const r = phone.getBoundingClientRect();
    const vh = window.innerHeight || 1;
    const prog = 1 - (r.top + r.height / 2) / vh;
    const clamped = Math.max(-0.4, Math.min(1, prog));
    targetTy = clamped * -18;
  };
  const tick = () => {
    raf = 0;
    curRx += (targetRx - curRx) * 0.08;
    curRy += (targetRy - curRy) * 0.08;
    curTy += (targetTy - curTy) * 0.08;
    phone.style.transform = `translateY(${curTy.toFixed(2)}px) rotateY(${curRy.toFixed(2)}deg) rotateX(${curRx.toFixed(2)}deg)`;
    if (
      Math.abs(targetRx - curRx) > 0.01 ||
      Math.abs(targetRy - curRy) > 0.01 ||
      Math.abs(targetTy - curTy) > 0.05
    ) {
      raf = requestAnimationFrame(tick);
    }
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };
  window.addEventListener(
    'pointermove',
    (e) => {
      onMove(e);
      schedule();
    },
    { passive: true },
  );
  window.addEventListener(
    'scroll',
    () => {
      onScroll();
      schedule();
    },
    { passive: true },
  );
  window.addEventListener(
    'resize',
    () => {
      onScroll();
      schedule();
    },
    { passive: true },
  );
  onScroll();
  schedule();
}

function initChatMorph(): void {
  const chat = document.querySelector<HTMLElement>('.lp-chat');
  const section = document.querySelector<HTMLElement>('.lp-section--remote');
  if (!chat || !section) return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    chat.classList.add('lp-chat--flat');
    return;
  }

  // Hold the 3D pose long enough to register, then morph to the real-UI flat
  // look. Reveal stagger lands the last bubble ~1.6s after intersection.
  const HOLD_MS = 4000;
  const trigger = () => window.setTimeout(() => chat.classList.add('lp-chat--flat'), HOLD_MS);

  if (!('IntersectionObserver' in window)) {
    trigger();
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          trigger();
        }
      }
    },
    { threshold: 0.4 },
  );
  observer.observe(section);
}

function boot(): void {
  initHairlineScale();
  initReveal();
  initSmoothAnchor();
  initScrollProgress();
  initEditorialPageLoader();
  initPhoneTilt();
  initCopyInvite();
  initRoomCount();
  initSyncClock();
  initCodeCycle();
  initChatMorph();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
