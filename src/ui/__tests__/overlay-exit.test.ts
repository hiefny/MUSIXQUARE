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

  // The windows below are mounted in index.html's order. Each is a sibling
  // under body with the same CSS z-index, so at an equal inline z-index the
  // later one in the markup paints on top.
  describe('a closing window under or beside one that stays open', () => {
    it('keeps a lower window closing under the window that stays open above it', () => {
      mount('dialog-overlay', 'signaling-recovery-overlay');
      const recovery = show('signaling-recovery-overlay');
      const dialog = show('dialog-overlay');
      expect(recovery.style.zIndex).toBe('6000');
      expect(dialog.style.zIndex).toBe('6010');

      close(recovery);

      // The recovery dialog comes later in the markup: level with the common
      // dialog, its exit would paint over the dialog that stays open.
      expect(recovery.classList.contains('is-closing')).toBe(true);
      expect(recovery.style.zIndex).toBe('6000');
      expect(dialog.style.zIndex).toBe('6010');
      expect(dialog.getAttribute('aria-hidden')).toBe('false');
      expect(dialog.hasAttribute('inert')).toBe(false);

      animationEnd(recovery, 'dialogBackdropOut');
      expect(dialog.style.zIndex).toBe('6000');
      expect(recovery.style.zIndex).toBe('');
    });

    it('keeps the move dialog closing under a dialog open above it', () => {
      mount('dialog-overlay', 'playlist-transfer-overlay');
      const transfer = show('playlist-transfer-overlay');
      const dialog = show('dialog-overlay');

      close(transfer);

      expect(transfer.style.zIndex).toBe('6000');
      expect(dialog.style.zIndex).toBe('6010');
      animationEnd(transfer, 'dialogBackdropOut');
      expect(dialog.style.zIndex).toBe('6000');
      expect(transfer.style.zIndex).toBe('');
    });

    it('paints a window shown during an exit above that exit', () => {
      mount('dialog-overlay', 'language-dialog-overlay');
      const language = show('language-dialog-overlay');
      close(language);
      const dialog = show('dialog-overlay');

      expect(language.classList.contains('is-closing')).toBe(true);
      expect(language.style.zIndex).toBe('6000');
      expect(dialog.style.zIndex).toBe('6010');

      animationEnd(language, 'dialogBackdropOut');
      expect(dialog.style.zIndex).toBe('6000');
      expect(language.style.zIndex).toBe('');
    });

    it('paints the playlist switcher, shown during the move dialog exit, above it', () => {
      mount('playlist-slots-overlay', 'playlist-transfer-overlay');
      const transfer = show('playlist-transfer-overlay');
      close(transfer);
      const slots = show('playlist-slots-overlay');

      expect(transfer.style.zIndex).toBe('6000');
      expect(slots.style.zIndex).toBe('6010');
    });

    it('keeps a middle window closing between the windows around it', () => {
      mount('dialog-overlay', 'signaling-recovery-overlay', 'language-dialog-overlay');
      const recovery = show('signaling-recovery-overlay');
      const language = show('language-dialog-overlay');
      const dialog = show('dialog-overlay');

      close(language);

      expect(recovery.style.zIndex).toBe('6000');
      expect(language.style.zIndex).toBe('6010');
      expect(dialog.style.zIndex).toBe('6020');

      animationEnd(language, 'dialogBackdropOut');
      expect(recovery.style.zIndex).toBe('6000');
      expect(dialog.style.zIndex).toBe('6010');
      expect(language.style.zIndex).toBe('');
    });

    it('keeps two exits in the order they were painted', () => {
      mount('dialog-overlay', 'language-dialog-overlay');
      const language = show('language-dialog-overlay');
      const dialog = show('dialog-overlay');

      close(dialog);
      close(language);

      expect(language.style.zIndex).toBe('6000');
      expect(dialog.style.zIndex).toBe('6010');
      // Alone on screen, the remaining exit takes the bottom layer.
      animationEnd(language, 'dialogBackdropOut');
      expect(language.style.zIndex).toBe('');
      expect(dialog.style.zIndex).toBe('6000');
      animationEnd(dialog, 'dialogBackdropOut');
      expect(dialog.style.zIndex).toBe('');
    });

    it('paints a window raised to the top during an exit above it', () => {
      mount('dialog-overlay', 'signaling-recovery-overlay', 'language-dialog-overlay');
      const recovery = show('signaling-recovery-overlay');
      const language = show('language-dialog-overlay');
      const dialog = show('dialog-overlay');
      close(language);

      // The recovery dialog's open path syncs it to the top while it shows.
      syncOverlayState('signaling-recovery-overlay');

      // The common dialog stayed open above the closing list, and the raised
      // recovery dialog goes above both.
      expect(language.style.zIndex).toBe('6000');
      expect(dialog.style.zIndex).toBe('6010');
      expect(recovery.style.zIndex).toBe('6020');
      expect(recovery.hasAttribute('inert')).toBe(false);
      expect(dialog.hasAttribute('inert')).toBe(true);
    });
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

    it('ends the exit and goes back hidden when the fullscreen surface ends during it', async () => {
      mount('dialog-overlay');
      const host = enterFullscreen();
      const dialog = show();
      expect(dialog.parentElement).toBe(host);
      const settled = vi.fn();
      close(dialog, settled);
      expect(dialog.parentElement).toBe(host);

      fullscreen = null;
      document.dispatchEvent(new Event('fullscreenchange'));

      // Moved while closing, the exit's keyframes would start again from the
      // fully shown dialog on the page that just left fullscreen.
      expect(dialog.parentElement).toBe(document.body);
      expect(dialog.classList.contains('is-closing')).toBe(false);
      expect(dialog.style.zIndex).toBe('');
      expect(settled).toHaveBeenCalledOnce();
      expect(await ledgerSettled()).toBe(true);

      animationEnd(dialog, 'dialogBackdropOut');
      expect(dialog.parentElement).toBe(document.body);
      expect(settled).toHaveBeenCalledOnce();
    });

    it('ends the exit first when any sync finds the fullscreen surface gone', () => {
      mount('dialog-overlay');
      enterFullscreen();
      const dialog = show();
      const settled = vi.fn();
      close(dialog, settled);

      // Fullscreen has ended but its change event has not arrived yet.
      fullscreen = null;
      syncOverlayState();

      expect(dialog.parentElement).toBe(document.body);
      expect(dialog.classList.contains('is-closing')).toBe(false);
      expect(settled).toHaveBeenCalledOnce();
    });
  });
});

describe('a dialog closed during its entrance', () => {
  /** The overlay's own animations as a browser would list them. */
  function animate(element: HTMLElement, animations: object[]): void {
    Object.defineProperty(element, 'getAnimations', {
      configurable: true,
      value: () => animations,
    });
  }

  it('hides at once rather than jump back to fully shown before it fades', async () => {
    mount('language-dialog-overlay', 'dialog-overlay');
    const language = show('language-dialog-overlay');
    const dialog = show('dialog-overlay');
    animate(dialog, [{ animationName: 'dialogBackdropIn', playState: 'running', pending: false }]);
    const settled = vi.fn(() => {
      expect(dialog.classList.contains('is-closing')).toBe(false);
    });

    expect(close(dialog, settled)).toBe(true);

    expect(dialog.classList.contains('show')).toBe(false);
    expect(dialog.classList.contains('is-closing')).toBe(false);
    expect(dialog.getAttribute('aria-hidden')).toBe('true');
    expect(settled).toHaveBeenCalledOnce();
    expect(dialog.style.zIndex).toBe('');
    expect(language.style.zIndex).toBe('6000');
    expect(await ledgerSettled()).toBe(true);
  });

  it('hides at once when it was shown in the same task and never painted', () => {
    mount('dialog-overlay');
    const dialog = show();
    // Reading the animations commits the shown class: its entrance is pending.
    animate(dialog, [{ animationName: 'dialogBackdropIn', playState: 'running', pending: true }]);
    const settled = vi.fn();

    close(dialog, settled);

    expect(dialog.classList.contains('is-closing')).toBe(false);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('plays the exit once the entrance has ended, whatever transition runs on it', () => {
    mount('dialog-overlay');
    const dialog = show();
    animate(dialog, [
      { animationName: 'dialogBackdropIn', playState: 'finished', pending: false },
      { transitionProperty: 'opacity', playState: 'running', pending: false },
    ]);
    const settled = vi.fn();

    close(dialog, settled);

    expect(dialog.classList.contains('is-closing')).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    animationEnd(dialog, 'dialogBackdropOut');
    expect(settled).toHaveBeenCalledOnce();
  });
});
