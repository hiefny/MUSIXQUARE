/** @vitest-environment jsdom */

import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  animateTransition: vi.fn((apply: () => void) => apply()),
  clearManagedTimer: vi.fn(),
  setManagedTimer: vi.fn(),
}));

vi.mock('../../core/timers.ts', () => ({
  clearManagedTimer: mocks.clearManagedTimer,
  setManagedTimer: mocks.setManagedTimer,
}));

vi.mock('../../core/platform.ts', () => ({
  isCompactLandscape: vi.fn(() => false),
}));

vi.mock('../dom.ts', () => ({
  animateTransition: mocks.animateTransition,
  updateOverlayOpenClass: vi.fn(),
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
}));

vi.mock('../player-controls.ts', () => ({
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
  showPlacementToastForChannel: vi.fn(),
}));

vi.mock('../../core/wake-lock.ts', () => ({
  activateNoSleep: vi.fn(),
}));

vi.mock('../settings.ts', () => ({
  selectStandardChannelButton: vi.fn(),
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

import {
  initObCarousel,
  notifyObCarouselGreetingReady,
  setCurrentObSlide,
  setupHighlightJoinRole,
  setupRenderActions,
  setupSetGuestJoinBusy,
  setupSetGuestJoinError,
  setupShowWelcome,
  showSetupOverlay,
  updateObSlider,
} from '../setup-shared.ts';

const OB_CAROUSEL_AUTOPLAY_DELAY_MS = 6000;

function installMatchMedia(
  options: { reduced?: boolean; anyHover?: boolean; primaryHover?: boolean } = {},
) {
  const reducedListeners = new Set<(event: MediaQueryListEvent) => void>();
  const reducedQuery = {
    matches: options.reduced ?? false,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      reducedListeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      reducedListeners.delete(listener);
    }),
    addListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => {
      reducedListeners.add(listener);
    }),
    removeListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => {
      reducedListeners.delete(listener);
    }),
    dispatchEvent: vi.fn(),
  };
  const anyHoverQuery = {
    ...reducedQuery,
    matches: options.anyHover ?? true,
    media: '(any-hover: hover)',
  };
  const primaryHoverQuery = {
    ...reducedQuery,
    matches: options.primaryHover ?? options.anyHover ?? true,
    media: '(hover: hover)',
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => {
      if (query === '(prefers-reduced-motion: reduce)') return reducedQuery;
      return query === '(any-hover: hover)' ? anyHoverQuery : primaryHoverQuery;
    }),
  });

  return {
    reducedQuery,
    setReduced(matches: boolean) {
      reducedQuery.matches = matches;
      const event = { matches, media: reducedQuery.media } as MediaQueryListEvent;
      reducedListeners.forEach((listener) => listener(event));
    },
  };
}

function renderCarouselFixture(): void {
  document.body.innerHTML = `
    <div id="setup-overlay" class="active">
      <div id="setup-welcome-area" style="display: flex">
        <div id="ob-slider-area">
          <div id="ob-slider-viewport">
            <div id="ob-slider-track" aria-live="off">
              <section class="ob-slide active" aria-hidden="false"></section>
              <section class="ob-slide" aria-hidden="true" inert></section>
              <section class="ob-slide" aria-hidden="true" inert></section>
              <section class="ob-slide" aria-hidden="true" inert></section>
            </div>
          </div>
          <div class="ob-nav-row">
            <button id="ob-prev"></button>
            <div id="ob-dots">
              <button class="ob-dot" data-idx="0"></button>
              <button class="ob-dot" data-idx="1"></button>
              <button class="ob-dot" data-idx="2"></button>
              <button class="ob-dot" data-idx="3"></button>
            </div>
            <button id="ob-next"></button>
          </div>
        </div>
      </div>
    </div>
  `;
  setCurrentObSlide(0);
  updateObSlider();
}

function latestAutoplayCallback(): () => void {
  const call = [...mocks.setManagedTimer.mock.calls]
    .reverse()
    .find(([name]) => name === 'setup-ob-carousel-autoplay');
  if (!call) throw new Error('Autoplay timer was not scheduled');
  return call[1] as () => void;
}

function autoplayScheduleCount(): number {
  return mocks.setManagedTimer.mock.calls.filter(([name]) => name === 'setup-ob-carousel-autoplay')
    .length;
}

function dispatchTouch(target: Element, type: 'touchstart' | 'touchend', clientX: number): void {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, type === 'touchstart' ? 'touches' : 'changedTouches', {
    value: [{ clientX }],
  });
  target.dispatchEvent(event);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.animateTransition.mockImplementation((apply: () => void) => apply());
  installMatchMedia();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  document.documentElement.className = '';
  document.body.className = '';
  document.body.replaceChildren();
});

describe('onboarding carousel motion preference', () => {
  it('keeps a late setup transition behind a terminal bootstrap failure', () => {
    let applyTransition: (() => void) | undefined;
    mocks.animateTransition.mockImplementationOnce((apply: () => void) => {
      applyTransition = apply;
    });
    document.documentElement.className = 'setup-boot-block';
    document.body.innerHTML = '<div id="setup-overlay"></div>';

    showSetupOverlay();
    document.documentElement.classList.add('setup-boot-failed');
    document.documentElement.classList.remove('setup-boot-block');
    applyTransition?.();

    expect(document.getElementById('setup-overlay')?.classList.contains('active')).toBe(false);
    expect(document.documentElement.classList.contains('setup-boot-failed')).toBe(true);
    expect(mocks.setManagedTimer).not.toHaveBeenCalled();
  });

  it('promotes a visible CSS-only boot timeout before late setup can take ownership', () => {
    document.documentElement.className = 'setup-boot-block';
    document.body.innerHTML = `
      <section id="bootstrap-failure" style="display:flex;visibility:visible;opacity:1"></section>
      <div id="setup-overlay"></div>
    `;

    showSetupOverlay();

    expect(document.documentElement.classList.contains('setup-boot-failed')).toBe(true);
    expect(document.documentElement.classList.contains('setup-boot-block')).toBe(false);
    expect(document.body.classList.contains('fouc-loaded')).toBe(true);
    expect(document.getElementById('setup-overlay')?.classList.contains('active')).toBe(false);
    expect(mocks.animateTransition).not.toHaveBeenCalled();
    expect(mocks.setManagedTimer).not.toHaveBeenCalled();
  });

  it('exposes buttons/current state and hides inactive slides from interaction', async () => {
    const markup = await readFile('index.html', 'utf8');
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const dots = parsed.querySelectorAll<HTMLButtonElement>('#ob-dots button.ob-dot');
    const slides = parsed.querySelectorAll<HTMLElement>('#ob-slider-track .ob-slide');
    const nav = parsed.querySelector('.ob-nav-row');

    expect(dots).toHaveLength(4);
    expect(nav?.querySelector('button')?.id).toBe('ob-prev');
    expect(parsed.getElementById('ob-autoplay-toggle')).toBeNull();
    expect(markup).not.toContain('data-ob-autoplay-icon');
    expect(parsed.getElementById('ob-slider-track')?.getAttribute('aria-live')).toBe('off');
    expect(dots[0]?.getAttribute('aria-current')).toBe('true');
    expect(dots[3]?.getAttribute('aria-label')).toBe('4 / 4');
    expect(slides[0]?.getAttribute('aria-hidden')).toBe('false');
    expect(slides[0]?.hasAttribute('inert')).toBe(false);
    expect(slides[1]?.getAttribute('aria-hidden')).toBe('true');
    expect(slides[1]?.hasAttribute('inert')).toBe(true);
  });

  it('moves current, hidden, and inert state together on manual navigation', () => {
    document.body.innerHTML = `
      <div id="ob-slider-track">
        <section class="ob-slide"></section><section class="ob-slide"></section>
        <section class="ob-slide"></section><section class="ob-slide"></section>
      </div>
      <button class="ob-dot"></button><button class="ob-dot"></button>
      <button class="ob-dot"></button><button class="ob-dot"></button>
    `;

    setCurrentObSlide(2);
    updateObSlider();

    const dots = document.querySelectorAll('.ob-dot');
    const slides = document.querySelectorAll('.ob-slide');
    expect(dots[2]?.getAttribute('aria-current')).toBe('true');
    expect(dots[0]?.hasAttribute('aria-current')).toBe(false);
    expect(slides[2]?.getAttribute('aria-hidden')).toBe('false');
    expect(slides[2]?.hasAttribute('inert')).toBe(false);
    expect(slides[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(slides[0]?.hasAttribute('inert')).toBe(true);
  });

  it('uses a continuous six-second one-shot timer and wraps after slide four', () => {
    renderCarouselFixture();
    const controller = new AbortController();

    initObCarousel(controller.signal);

    const timerCall = mocks.setManagedTimer.mock.calls.at(-1);
    expect(timerCall?.[0]).toBe('setup-ob-carousel-autoplay');
    expect(timerCall?.[2]).toBe(OB_CAROUSEL_AUTOPLAY_DELAY_MS);
    expect(timerCall?.[3]).toBeUndefined();

    latestAutoplayCallback()();

    expect(document.getElementById('ob-slider-track')?.style.transform).toBe('translateX(-100%)');
    expect(autoplayScheduleCount()).toBe(2);

    latestAutoplayCallback()();
    latestAutoplayCallback()();
    latestAutoplayCallback()();
    expect(document.getElementById('ob-slider-track')?.style.transform).toBe('translateX(-0%)');
    expect(autoplayScheduleCount()).toBe(5);

    latestAutoplayCallback()();
    expect(document.getElementById('ob-slider-track')?.style.transform).toBe('translateX(-100%)');
    expect(autoplayScheduleCount()).toBe(6);
    controller.abort();
    expect(mocks.clearManagedTimer).toHaveBeenCalledWith('setup-ob-carousel-autoplay');
  });

  it('starts the first full dwell only after the greeting reveal finishes', () => {
    renderCarouselFixture();
    document
      .getElementById('setup-welcome-area')
      ?.insertAdjacentHTML(
        'afterbegin',
        '<div class="setup-greeting-row" aria-hidden="true"></div>',
      );
    const controller = new AbortController();

    initObCarousel(controller.signal);
    expect(autoplayScheduleCount()).toBe(0);

    notifyObCarouselGreetingReady();
    expect(autoplayScheduleCount()).toBe(1);
    expect(mocks.setManagedTimer.mock.calls.at(-1)?.[2]).toBe(OB_CAROUSEL_AUTOPLAY_DELAY_MS);
    controller.abort();
  });

  it('sticky-stops after manual navigation or focus with no resume control', () => {
    renderCarouselFixture();
    const controller = new AbortController();
    initObCarousel(controller.signal);
    const track = document.getElementById('ob-slider-track') as HTMLElement;
    const firstDot = document.querySelector<HTMLButtonElement>('.ob-dot[data-idx="0"]');

    expect(firstDot?.getAttribute('aria-label')).toBe('1 / 4, setup.carousel_pause');

    document.querySelector<HTMLButtonElement>('.ob-dot[data-idx="2"]')?.click();
    expect(track.getAttribute('aria-live')).toBe('polite');
    expect(track.style.transform).toBe('translateX(-200%)');
    expect(firstDot?.getAttribute('aria-label')).toBe('1 / 4');

    document.getElementById('ob-slider-area')?.dispatchEvent(new MouseEvent('mouseleave'));
    setupShowWelcome(false);
    setupShowWelcome(true);
    expect(autoplayScheduleCount()).toBe(1);
    expect(document.getElementById('ob-autoplay-toggle')).toBeNull();
    controller.abort();

    renderCarouselFixture();
    const focusController = new AbortController();
    initObCarousel(focusController.signal);
    document.getElementById('ob-next')?.focus();
    expect(document.getElementById('ob-slider-track')?.getAttribute('aria-live')).toBe('polite');
    expect(autoplayScheduleCount()).toBe(2);
    focusController.abort();
  });

  it('temporarily suspends hover and visibility with a fresh dwell on return', () => {
    renderCarouselFixture();
    const controller = new AbortController();
    initObCarousel(controller.signal);
    const area = document.getElementById('ob-slider-area') as HTMLElement;

    area.dispatchEvent(new MouseEvent('mouseenter'));
    expect(mocks.clearManagedTimer).toHaveBeenLastCalledWith('setup-ob-carousel-autoplay');
    area.dispatchEvent(new MouseEvent('mouseleave'));
    expect(autoplayScheduleCount()).toBe(2);

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(autoplayScheduleCount()).toBe(3);

    setupShowWelcome(false);
    expect(mocks.clearManagedTimer).toHaveBeenLastCalledWith('setup-ob-carousel-autoplay');
    setupShowWelcome(true);
    expect(autoplayScheduleCount()).toBe(4);
    controller.abort();
  });

  it('uses any-hover so a mouse still suspends autoplay on a touch-primary hybrid', () => {
    installMatchMedia({ anyHover: true, primaryHover: false });
    renderCarouselFixture();
    const controller = new AbortController();
    initObCarousel(controller.signal);
    const area = document.getElementById('ob-slider-area') as HTMLElement;
    const track = document.getElementById('ob-slider-track') as HTMLElement;

    area.dispatchEvent(new MouseEvent('mouseenter'));
    latestAutoplayCallback()();
    expect(track.style.transform).toBe('translateX(-0%)');
    expect(window.matchMedia).toHaveBeenCalledWith('(any-hover: hover)');

    area.dispatchEvent(new MouseEvent('mouseleave'));
    expect(autoplayScheduleCount()).toBe(2);
    controller.abort();
  });

  it('clears a hover pause lost while hidden and starts a fresh dwell on return', () => {
    renderCarouselFixture();
    const controller = new AbortController();
    initObCarousel(controller.signal);
    const area = document.getElementById('ob-slider-area') as HTMLElement;
    vi.spyOn(area, 'matches').mockReturnValue(false);

    area.dispatchEvent(new MouseEvent('mouseenter'));
    expect(autoplayScheduleCount()).toBe(1);

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(autoplayScheduleCount()).toBe(2);
    latestAutoplayCallback()();
    expect(document.getElementById('ob-slider-track')?.style.transform).toBe('translateX(-100%)');
    controller.abort();
  });

  it('clears a lost touch gesture while hidden and ignores its late touchend', () => {
    renderCarouselFixture();
    const controller = new AbortController();
    initObCarousel(controller.signal);
    const area = document.getElementById('ob-slider-area') as HTMLElement;
    const viewport = document.getElementById('ob-slider-viewport') as HTMLElement;
    const track = document.getElementById('ob-slider-track') as HTMLElement;
    vi.spyOn(area, 'matches').mockReturnValue(false);

    dispatchTouch(viewport, 'touchstart', 300);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(autoplayScheduleCount()).toBe(1);
    dispatchTouch(viewport, 'touchend', 100);
    expect(track.getAttribute('aria-live')).toBe('polite');
    expect(track.style.transform).toBe('translateX(-0%)');
    expect(autoplayScheduleCount()).toBe(1);

    latestAutoplayCallback()();
    expect(track.style.transform).toBe('translateX(-0%)');
    controller.abort();
  });

  it('dynamically makes reduced-motion users manual-only and removes slide transitions', async () => {
    const motion = installMatchMedia({ reduced: true, anyHover: false });
    renderCarouselFixture();
    const controller = new AbortController();
    initObCarousel(controller.signal);
    const track = document.getElementById('ob-slider-track') as HTMLElement;
    const firstDot = document.querySelector<HTMLButtonElement>('.ob-dot[data-idx="0"]');

    expect(track.getAttribute('aria-live')).toBe('polite');
    expect(firstDot?.getAttribute('aria-label')).toBe('1 / 4');
    expect(mocks.setManagedTimer).not.toHaveBeenCalled();

    motion.setReduced(false);
    expect(track.getAttribute('aria-live')).toBe('off');
    expect(firstDot?.getAttribute('aria-label')).toContain('setup.carousel_pause');
    expect(mocks.setManagedTimer).toHaveBeenCalledOnce();

    motion.setReduced(true);
    expect(track.getAttribute('aria-live')).toBe('polite');
    expect(firstDot?.getAttribute('aria-label')).toBe('1 / 4');
    const stylesheet = await readFile('css/style.css', 'utf8');
    expect(stylesheet).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ob-slider-track,[\s\S]*?transition: none !important;/,
    );
    controller.abort();
  });

  it('keeps controls working with the legacy MediaQueryList listener API', () => {
    const motion = installMatchMedia();
    Object.defineProperty(motion.reducedQuery, 'addEventListener', { value: undefined });
    Object.defineProperty(motion.reducedQuery, 'removeEventListener', { value: undefined });
    renderCarouselFixture();
    const controller = new AbortController();

    initObCarousel(controller.signal);
    document.getElementById('ob-next')?.click();
    expect(document.getElementById('ob-slider-track')?.style.transform).toBe('translateX(-100%)');

    motion.setReduced(true);
    expect(document.getElementById('ob-slider-track')?.getAttribute('aria-live')).toBe('polite');
    controller.abort();
    expect(motion.reducedQuery.removeListener).toHaveBeenCalledOnce();
  });
});

describe('setup greeting reveal', () => {
  it('keeps the greeting and language trigger separate from the room-choice prompt', async () => {
    const markup = await readFile('index.html', 'utf8');
    const headerStart = markup.indexOf('<div id="setup-welcome-header"');
    const headerEnd = markup.indexOf('<div id="ob-slider-area"', headerStart);
    const header = markup.slice(headerStart, headerEnd);

    expect(header).toContain('class="setup-brand-greeting-stage"');
    expect(header).toContain('class="setup-greeting-row" aria-hidden="true"');
    expect(header).toContain('<h2 class="setup-greeting-heading">');
    expect(header).toContain(
      '<span class="setup-greeting-text" data-i18n="setup.greeting"></span>',
    );
    expect(header).toContain('data-i18n="setup.greeting"');
    expect(header).toContain('data-setup-language-trigger');
    expect(header).toContain('aria-haspopup="dialog"');
    expect(header).toContain('aria-controls="language-dialog-overlay"');
    expect(header).toContain('data-i18n-aria-label="settings.language_select_aria"');
    expect(header.indexOf('data-i18n="setup.greeting"')).toBeLessThan(
      header.indexOf('data-i18n="setup.hello_select_role"'),
    );
  });

  it('crossfades the completed logo into the greeting without an extra hold', async () => {
    const source = await readFile('src/ui/setup.ts', 'utf8');
    const stylesheet = await readFile('css/style.css', 'utf8');

    expect(source).toContain('const SETUP_GREETING_DELAY_MS = 0;');
    expect(source).toContain(
      "document.addEventListener('animationend', handleFinalDraw, { signal })",
    );
    expect(source).toContain('SETUP_GREETING_FALLBACK_BUFFER_MS');
    expect(source).toContain("window.matchMedia('(prefers-reduced-motion: reduce)').matches");
    expect(source).toContain("stage.classList.add('is-greeting-visible')");
    expect(stylesheet).toContain('.setup-brand-greeting-stage.is-greeting-visible > .logo-welcome');
    expect(stylesheet).toContain('opacity: 0;');
    expect(stylesheet).toContain('.setup-greeting-row.is-visible');
    expect(stylesheet).toContain('opacity 0.48s ease-out 0.36s');
    expect(stylesheet).toContain('.logo-welcome > .wg,\n    .logo-welcome > .wl');
    expect(stylesheet).toContain('animation: none !important;');
  });

  it('reuses the welcome crossfade timing when the host guide becomes an invitation QR', async () => {
    const markup = await readFile('index.html', 'utf8');
    const stylesheet = await readFile('css/style.css', 'utf8');
    const setupShared = await readFile('src/ui/setup-shared.ts', 'utf8');

    expect(markup).toContain('id="setup-host-invite-stage"');
    expect(markup).toContain('id="setup-host-qr-placeholder"');
    expect(markup).toContain('id="setup-host-qr"');
    expect(markup).toContain('class="material-elastic-spinner setup-host-qr-loading-spinner"');
    expect(markup).toContain('class="material-elastic-spinner setup-qr-join-spinner"');
    expect(stylesheet).toContain(
      '.setup-host-invite-stage.is-room-qr-visible > .setup-host-qr-placeholder',
    );
    expect(stylesheet).toContain(
      '.setup-host-invite-stage.is-room-qr-visible > .setup-host-qr-room',
    );
    expect(stylesheet).toContain('opacity 0.36s ease-in');
    expect(stylesheet).toContain('opacity 0.48s ease-out');
    expect(stylesheet).toContain('.setup-host-qr {');
    expect(stylesheet).toContain(
      '.setup-host-invite-stage.is-room-qr-loading > .setup-host-qr-loading-spinner',
    );
    expect(stylesheet).toMatch(
      /\.setup-host-qr-loading-spinner\s*{[^}]*--material-elastic-size:\s*42px;[^}]*color:\s*var\(--text-main\);/s,
    );
    expect(stylesheet).not.toContain('.setup-host-qr-loading-spinner::before');
    expect(stylesheet).toMatch(/\.setup-qr-join-spinner\s*{[^}]*color:\s*var\(--text-main\);/s);
    expect(stylesheet).toContain(".setup-qr-scan-button[aria-busy='true'] .setup-qr-join-spinner");
    expect(stylesheet).toContain('transition: none !important;');
    expect(stylesheet).toContain('@media (max-width: 719px) and (orientation: portrait)');
    expect(
      stylesheet.indexOf('@media (max-width: 719px) and (orientation: portrait)'),
    ).toBeGreaterThan(stylesheet.indexOf('.setup-code-area-bottom {\n    margin-top: 40px;'));
    expect(stylesheet).toContain('margin-top: 14px;');
    expect(stylesheet).toContain('padding-top: 6px;');
    expect(setupShared).toContain("el.querySelector('.setup-host-invite-stage')");
  });

  it('welds animated wordmark joins without changing the reveal sequence', async () => {
    const markup = await readFile('index.html', 'utf8');
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const strokes = Array.from(parsed.querySelectorAll<SVGElement>('.logo-welcome > .wl'));

    expect(strokes).toHaveLength(36);
    expect(strokes[0]).toMatchObject({ dataset: { wt: '0', wd: '1080' } });
    expect(strokes[0]?.getAttribute('height')).toBe('4.8');
    expect(strokes[5]?.getAttribute('y')).toBe('30.5');
    expect(strokes[9]?.getAttribute('height')).toBe('5.1');
    expect(strokes[20]?.getAttribute('y')).toBe('35');
    expect(strokes[24]?.getAttribute('width')).toBe('4.8');
    expect(strokes[26]?.getAttribute('x')).toBe('205.4');
    expect(strokes[32]?.getAttribute('points')).toContain('223.8 26');
  });

  it('uses opacity-transitioned language-list edge gradients instead of mask swaps', async () => {
    const markup = await readFile('index.html', 'utf8');
    const stylesheet = await readFile('css/style.css', 'utf8');
    const languageStylesStart = stylesheet.indexOf('.language-list-frame');
    const languageStylesEnd = stylesheet.indexOf('.language-option {', languageStylesStart);
    const languageStyles = stylesheet.slice(languageStylesStart, languageStylesEnd);

    expect(markup).toContain('class="language-list-frame"');
    expect(markup).toContain('class="language-list-edge language-list-edge-top"');
    expect(markup).toContain('class="language-list-edge language-list-edge-bottom"');
    expect(languageStyles).toContain('.language-list.can-scroll-up ~ .language-list-edge-top');
    expect(languageStyles).toContain('.language-list.can-scroll-down ~ .language-list-edge-bottom');
    expect(languageStyles).toContain('transition: opacity 0.2s ease;');
    expect(languageStyles).toMatch(/\.language-list-edge-top\s*{[^}]*top:\s*-1px;/s);
    expect(languageStyles).toMatch(/\.language-list-edge-bottom\s*{[^}]*bottom:\s*-1px;/s);
    expect(
      languageStyles.match(/height:\s*calc\(var\(--language-list-fade-size\) \+ 1px\);/g),
    ).toHaveLength(2);
    expect(languageStyles.match(/var\(--glass-bg\) 1px/g)).toHaveLength(2);
    expect(languageStyles).not.toContain('mask-image');
  });
});

describe('setup recovery accessibility', () => {
  it('replaces the QR camera action with the canonical spinner while joining', () => {
    document.body.innerHTML = `
      <input id="setup-join-code">
      <button id="btn-setup-qr-scan" aria-busy="false">
        <svg class="setup-qr-scan-symbol"></svg>
        <span class="material-elastic-spinner setup-qr-join-spinner" aria-hidden="true"></span>
      </button>
      <div id="setup-role-grid"></div>
    `;

    const input = document.getElementById('setup-join-code') as HTMLInputElement;
    const scanButton = document.getElementById('btn-setup-qr-scan') as HTMLButtonElement;

    setupSetGuestJoinBusy(true);
    expect(input.disabled).toBe(true);
    expect(scanButton.disabled).toBe(true);
    expect(scanButton.getAttribute('aria-busy')).toBe('true');

    setupSetGuestJoinBusy(false);
    expect(input.disabled).toBe(false);
    expect(scanButton.disabled).toBe(false);
    expect(scanButton.getAttribute('aria-busy')).toBe('false');
  });

  it('keeps join-role visual and pressed states synchronized through selection and reset', async () => {
    const markup = await readFile('index.html', 'utf8');
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const initialOptions = [
      ...parsed.querySelectorAll<HTMLButtonElement>('#setup-role-grid [data-join-ch]'),
    ];

    expect(initialOptions).toHaveLength(4);
    expect(initialOptions.every((option) => option.getAttribute('aria-pressed') === 'false')).toBe(
      true,
    );

    document.body.innerHTML = parsed.getElementById('setup-role-grid')?.outerHTML ?? '';
    const options = () => [
      ...document.querySelectorAll<HTMLButtonElement>('#setup-role-grid [data-join-ch]'),
    ];

    setupHighlightJoinRole(-1);
    expect(
      options().map((option) => [option.classList.contains('selected'), option.ariaPressed]),
    ).toEqual([
      [true, 'true'],
      [false, 'false'],
      [false, 'false'],
      [false, 'false'],
    ]);

    setupHighlightJoinRole(2);
    expect(
      options().map((option) => [option.classList.contains('selected'), option.ariaPressed]),
    ).toEqual([
      [false, 'false'],
      [false, 'false'],
      [true, 'true'],
      [false, 'false'],
    ]);

    setupHighlightJoinRole(null);
    expect(options().every((option) => !option.classList.contains('selected'))).toBe(true);
    expect(options().every((option) => option.getAttribute('aria-pressed') === 'false')).toBe(true);
  });

  it('links an inline failure state to the code field and labels icon-only Back', () => {
    document.body.innerHTML = `
      <input id="setup-join-code" aria-describedby="setup-guest-error">
      <p id="setup-guest-error" role="alert" hidden></p>
      <p id="setup-auto-join-error" role="alert" hidden></p>
      <div id="setup-actions"></div>
    `;

    setupSetGuestJoinError('Could not reach the room.');
    setupRenderActions([
      {
        id: 'btn-setup-back',
        html: '<svg></svg>',
        ariaLabel: 'Go back',
        kind: 'icon-only',
      },
    ]);

    const input = document.getElementById('setup-join-code');
    const error = document.getElementById('setup-guest-error');
    const back = document.getElementById('btn-setup-back');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(input?.getAttribute('aria-describedby')).toBe('setup-guest-error');
    expect(error?.hidden).toBe(false);
    expect(error?.getAttribute('role')).toBe('alert');
    expect(back?.getAttribute('aria-label')).toBe('Go back');

    setupSetGuestJoinError(null);
    expect(input?.hasAttribute('aria-invalid')).toBe(false);
    expect(error?.hidden).toBe(true);
  });

  it('keeps invite-link failures in the dedicated alert without invalidating the code field', () => {
    document.body.innerHTML = `
      <input id="setup-join-code" aria-describedby="setup-guest-error">
      <p id="setup-guest-error" role="alert" hidden></p>
      <p id="setup-auto-join-error" role="alert" hidden></p>
    `;

    setupSetGuestJoinError('Could not reach the PRO room.', true);

    const input = document.getElementById('setup-join-code');
    const codeError = document.getElementById('setup-guest-error');
    const inviteError = document.getElementById('setup-auto-join-error');
    expect(input?.hasAttribute('aria-invalid')).toBe(false);
    expect(codeError?.hidden).toBe(true);
    expect(inviteError?.hidden).toBe(false);
    expect(inviteError?.textContent).toBe('Could not reach the PRO room.');
    expect(inviteError?.getAttribute('role')).toBe('alert');
  });

  it('centers the invite-link failure panel in the desktop setup layout', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const desktopSetupStart = stylesheet.indexOf('/* Content areas: center vertically */');
    const desktopSetupEnd = stylesheet.indexOf('/* Content padding inside right panel */');
    expect(desktopSetupStart).toBeGreaterThanOrEqual(0);
    expect(desktopSetupEnd).toBeGreaterThan(desktopSetupStart);

    const centeredAreaRules = stylesheet.slice(desktopSetupStart, desktopSetupEnd);
    expect(centeredAreaRules).toContain('#setup-overlay #setup-auto-join-area');
    expect(centeredAreaRules).toContain('justify-content: center !important');
  });
});
