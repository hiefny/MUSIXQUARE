/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModalStackForTests,
  finishOverlayExit,
  startOverlayExit,
  syncOverlayState,
  trackOverlayExit,
  whenBackSurfaceSettled,
} from '../dom.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * The exit as css/style.css plays it: keyframes that only the closing class
 * starts. jsdom computes animation longhands from a stylesheet, not the
 * `animation` shorthand, and runs no animation, so each test ends the exit
 * with an animationend event or the fallback timer.
 */
const EXIT_STYLE = `
  .dialog-overlay.is-closing {
    animation-name: dialogBackdropOut;
    animation-duration: 0.22s;
  }
  .dialog-overlay.is-closing .dialog {
    animation-name: modalSlideDown;
    animation-duration: 0.22s;
  }
`;

function mount(...ids: string[]): void {
  document.body.innerHTML = `<style>${EXIT_STYLE}</style><main id="page"></main>${ids
    .map(
      (id) =>
        `<div id="${id}" class="dialog-overlay"><div class="dialog" role="dialog"></div></div>`,
    )
    .join('')}`;
}

function overlay(id = 'dialog-overlay'): HTMLElement {
  return document.getElementById(id)!;
}

/** Shows an overlay as an open path does. */
function show(id = 'dialog-overlay'): HTMLElement {
  const element = overlay(id);
  element.classList.add('show');
  element.setAttribute('aria-hidden', 'false');
  syncOverlayState(id as Parameters<typeof syncOverlayState>[0]);
  return element;
}

/** Closes an overlay as the close paths do: classes, aria-hidden, stack, then the exit. */
function close(element: HTMLElement, onSettled?: () => void): boolean {
  const exiting = startOverlayExit(element);
  element.setAttribute('aria-hidden', 'true');
  syncOverlayState();
  if (exiting) trackOverlayExit(element, onSettled);
  return exiting;
}

function animationEnd(target: Element, animationName: string): void {
  const event = new Event('animationend', { bubbles: true });
  Object.defineProperty(event, 'animationName', { value: animationName });
  target.dispatchEvent(event);
}

/** Resolves to whether the closing-surface ledger has settled after a few microtask turns. */
async function ledgerSettled(): Promise<boolean> {
  let settled = false;
  whenBackSurfaceSettled().then(
    () => {
      settled = true;
    },
    () => {},
  );
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  return settled;
}

beforeEach(() => {
  __resetModalStackForTests();
});

afterEach(() => {
  __resetModalStackForTests();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('dialog overlay exit', () => {
  it('settles at once when no exit animation applies, calling back once', async () => {
    mount('dialog-overlay');
    document.querySelector('style')!.remove();
    const element = show();
    const settled = vi.fn(() => {
      // The callback runs after the closing state is gone.
      expect(element.classList.contains('is-closing')).toBe(false);
    });

    expect(close(element, settled)).toBe(true);

    expect(settled).toHaveBeenCalledOnce();
    expect(element.classList.contains('show')).toBe(false);
    expect(element.classList.contains('is-closing')).toBe(false);
    expect(await ledgerSettled()).toBe(true);
    finishOverlayExit(element);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('treats a reduced-motion exit (animation-name none) as no exit', () => {
    mount('dialog-overlay');
    document.querySelector('style')!.textContent = `
      .dialog-overlay.is-closing { animation-name: none; animation-duration: 0.22s; }
    `;
    const settled = vi.fn();
    close(show(), settled);
    expect(settled).toHaveBeenCalledOnce();
    expect(overlay().classList.contains('is-closing')).toBe(false);
  });

  it('marks only a shown overlay closing', () => {
    mount('dialog-overlay');
    const element = overlay();
    const settled = vi.fn();

    expect(startOverlayExit(element)).toBe(false);
    expect(element.classList.contains('is-closing')).toBe(false);
    // Nothing is closing, so there is nothing to wait for.
    trackOverlayExit(element, settled);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('settles on its own end of the longest animation, ignoring a bubbled or shorter one', async () => {
    mount('dialog-overlay');
    document.querySelector('style')!.textContent = `
      .dialog-overlay.is-closing {
        animation-name: dialogBackdropOut, pulse;
        animation-duration: 0.22s, 100ms;
      }
    `;
    const element = show();
    const settled = vi.fn();
    close(element, settled);

    // Closed for the stack at once, still displayed for its exit.
    expect(element.classList.contains('show')).toBe(false);
    expect(element.classList.contains('is-closing')).toBe(true);
    expect(await ledgerSettled()).toBe(false);

    animationEnd(element.querySelector('.dialog')!, 'dialogBackdropOut');
    animationEnd(element, 'pulse');
    expect(settled).not.toHaveBeenCalled();
    expect(element.classList.contains('is-closing')).toBe(true);
    expect(await ledgerSettled()).toBe(false);

    animationEnd(element, 'dialogBackdropOut');
    expect(settled).toHaveBeenCalledOnce();
    expect(element.classList.contains('is-closing')).toBe(false);
    expect(await ledgerSettled()).toBe(true);
  });

  it('falls back at the longest finite end plus 100 ms, leaving out a looping animation', async () => {
    vi.useFakeTimers();
    mount('dialog-overlay');
    document.querySelector('style')!.textContent = `
      .dialog-overlay.is-closing {
        animation-name: dialogBackdropOut, glow, spinner;
        animation-duration: 0.22s, 100ms, 1s;
        animation-delay: 30ms, 0s, 0s;
        animation-iteration-count: 1, 2, infinite;
      }
    `;
    const element = show();
    const settled = vi.fn();
    close(element, settled);
    const ledger = vi.fn();
    const observed = whenBackSurfaceSettled().then(ledger);

    // dialogBackdropOut ends at 30 + 220 = 250 ms; glow at 2 x 100 = 200 ms.
    await vi.advanceTimersByTimeAsync(349);
    expect(settled).not.toHaveBeenCalled();
    expect(ledger).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await observed;
    expect(settled).toHaveBeenCalledOnce();
    expect(ledger).toHaveBeenCalledOnce();
    expect(element.classList.contains('is-closing')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes at once, once, before the overlay shows again', async () => {
    vi.useFakeTimers();
    mount('dialog-overlay');
    const element = show();
    const settled = vi.fn();
    close(element, settled);
    expect(element.classList.contains('is-closing')).toBe(true);

    finishOverlayExit(element);
    expect(settled).toHaveBeenCalledOnce();
    expect(element.classList.contains('is-closing')).toBe(false);
    expect(await ledgerSettled()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    finishOverlayExit(element);
    animationEnd(element, 'dialogBackdropOut');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toHaveBeenCalledOnce();

    // The next exit is tracked again.
    show();
    const next = vi.fn();
    close(element, next);
    expect(next).not.toHaveBeenCalled();
    animationEnd(element, 'dialogBackdropOut');
    expect(next).toHaveBeenCalledOnce();
  });

  it('ends an exit left over when the overlay closes again', () => {
    mount('dialog-overlay');
    const element = show();
    const first = vi.fn();
    close(element, first);
    // An open path that skipped finishOverlayExit.
    element.classList.add('show');
    const second = vi.fn();
    close(element, second);

    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(element.classList.contains('is-closing')).toBe(true);
    animationEnd(element, 'dialogBackdropOut');
    expect(second).toHaveBeenCalledOnce();
  });

  it('keeps the closing overlay in its layer until the exit settles', () => {
    mount('language-dialog-overlay', 'dialog-overlay');
    const language = show('language-dialog-overlay');
    const dialog = show('dialog-overlay');
    expect(language.style.zIndex).toBe('6000');
    expect(dialog.style.zIndex).toBe('6010');

    close(dialog);

    // The common dialog comes first in the markup: at the base z-index it
    // would paint its exit under the language dialog that stays open.
    expect(dialog.style.zIndex).toBe('6010');
    expect(language.style.zIndex).toBe('6000');
    expect(language.getAttribute('aria-hidden')).toBe('false');
    expect(language.hasAttribute('inert')).toBe(false);
    expect(dialog.getAttribute('aria-hidden')).toBe('true');

    animationEnd(dialog, 'dialogBackdropOut');
    expect(dialog.style.zIndex).toBe('');
    expect(language.style.zIndex).toBe('6000');
  });

  it('clears the layer at once when there is no exit to play', () => {
    mount('language-dialog-overlay', 'dialog-overlay');
    document.querySelector('style')!.remove();
    const language = show('language-dialog-overlay');
    const dialog = show('dialog-overlay');

    close(dialog);

    expect(dialog.style.zIndex).toBe('');
    expect(language.style.zIndex).toBe('6000');
  });

  describe('inside a fullscreen surface', () => {
    let fullscreen: Element | null = null;

    beforeEach(() => {
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => fullscreen,
      });
    });

    afterEach(() => {
      fullscreen = null;
      Reflect.deleteProperty(document, 'fullscreenElement');
    });

    function enterFullscreen(): HTMLElement {
      const host = document.createElement('div');
      host.id = 'fullscreen-host';
      document.body.prepend(host);
      fullscreen = host;
      document.dispatchEvent(new Event('fullscreenchange'));
      return host;
    }

    it('plays the exit where the dialog was shown, then goes back to its place', () => {
      mount('dialog-overlay');
      const marker = document.createElement('aside');
      overlay().after(marker);
      const host = enterFullscreen();
      const dialog = show();
      expect(dialog.parentElement).toBe(host);

      close(dialog);
      expect(dialog.parentElement).toBe(host);
      expect(dialog.classList.contains('is-closing')).toBe(true);

      animationEnd(dialog, 'dialogBackdropOut');
      expect(dialog.parentElement).toBe(document.body);
      expect(dialog.nextSibling).toBe(marker);
    });

    it('goes back at once when the fullscreen surface ends during the exit', () => {
      mount('dialog-overlay');
      const host = enterFullscreen();
      const dialog = show();
      expect(dialog.parentElement).toBe(host);
      close(dialog);

      fullscreen = null;
      document.dispatchEvent(new Event('fullscreenchange'));

      expect(dialog.parentElement).toBe(document.body);
      animationEnd(dialog, 'dialogBackdropOut');
      expect(dialog.parentElement).toBe(document.body);
      expect(dialog.classList.contains('is-closing')).toBe(false);
    });
  });
});
