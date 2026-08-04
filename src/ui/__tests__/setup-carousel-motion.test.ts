/** @vitest-environment jsdom */

import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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
  animateTransition: vi.fn((apply: () => void) => apply()),
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

import { setupRenderActions, setupSetGuestJoinError, startObAutoSlide } from '../setup-shared.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('onboarding carousel motion preference', () => {
  it('keeps normal automatic advancement when reduced motion is not requested', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });

    startObAutoSlide();

    expect(mocks.clearManagedTimer).toHaveBeenCalledWith('obAutoSlideTimer');
    expect(mocks.setManagedTimer).toHaveBeenCalledWith(
      'obAutoSlideTimer',
      expect.any(Function),
      5000,
      { interval: true },
    );
  });

  it('does not start automatic advancement for reduced-motion users', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    });

    startObAutoSlide();

    expect(mocks.clearManagedTimer).toHaveBeenCalledWith('obAutoSlideTimer');
    expect(mocks.setManagedTimer).not.toHaveBeenCalled();
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
