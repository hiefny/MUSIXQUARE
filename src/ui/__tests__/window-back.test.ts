/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModalStackForTests,
  animateTransition,
  beginBackSurfaceTransition,
  hasOpenWindow,
  offerBackToTopWindow,
  onOverlayStackChange,
  onWindowBack,
  syncOverlayState,
  trackClosingCssTransition,
  whenBackSurfaceSettled,
} from '../dom.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function overlay(id: string, cls: string, shown = true): HTMLElement {
  const element = document.createElement('div');
  element.id = id;
  if (shown) element.classList.add(cls);
  document.body.appendChild(element);
  return element;
}

describe('history Back to the topmost window', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    __resetModalStackForTests();
  });

  afterEach(() => {
    Reflect.deleteProperty(document, 'startViewTransition');
    __resetModalStackForTests();
    vi.useRealTimers();
  });

  it('waits for the longest transition on the specified closing surface only', async () => {
    const surface = overlay('account-dialog-overlay', 'show', false);
    surface.style.transitionProperty = 'opacity, transform, visibility';
    surface.style.transitionDuration = '0.2s, 350ms, 0s';
    surface.style.transitionDelay = '0s, 0s, 350ms';
    trackClosingCssTransition(surface);
    const observed = vi.fn();
    const settled = whenBackSurfaceSettled().then(observed);
    const end = (target: HTMLElement, property: string, type = 'transitionend') => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'propertyName', { value: property });
      target.dispatchEvent(event);
    };
    const child = document.createElement('div');
    surface.appendChild(child);
    end(child, 'transform');
    end(surface, 'opacity');
    end(surface, 'transform', 'transitioncancel');
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    end(surface, 'transform');
    await settled;
    expect(observed).toHaveBeenCalledOnce();
  });

  it('settles a dropped CSS end event at its computed deadline and clears cancelled work', async () => {
    vi.useFakeTimers();
    const surface = overlay('account-dialog-overlay', 'show', false);
    surface.style.transitionProperty = 'opacity';
    surface.style.transitionDuration = '0.2s';
    surface.style.transitionDelay = '50ms';
    const cancel = trackClosingCssTransition(surface);
    const cancelled = whenBackSurfaceSettled();
    cancel();
    await cancelled;
    expect(vi.getTimerCount()).toBe(0);
    trackClosingCssTransition(surface);
    const observed = vi.fn();
    const settled = whenBackSurfaceSettled().then(observed);
    await vi.advanceTimersByTimeAsync(349);
    expect(observed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(observed).toHaveBeenCalledOnce();
  });

  it('does not delay a closing surface without CSS transitions', async () => {
    const surface = overlay('account-dialog-overlay', 'show', false);
    surface.style.transitionProperty = 'none';
    surface.style.transitionDuration = '0s';
    trackClosingCssTransition(surface);
    await whenBackSurfaceSettled();
  });

  it('settles immediately when a required window consumes Back without closing', async () => {
    const dialog = overlay('dialog-overlay', 'show');
    onWindowBack(dialog, () => true);
    syncOverlayState('dialog-overlay');

    const result = offerBackToTopWindow();
    expect(result.handled).toBe(true);
    await result.settled;
    expect(dialog.classList.contains('show')).toBe(true);
  });

  it.each(['back', 'button'] as const)(
    'waits for the actual view transition after closing through %s',
    async (source) => {
      const media = overlay('media-source-overlay', 'active');
      syncOverlayState('media-source-overlay');
      let update!: () => void;
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      Object.defineProperty(document, 'startViewTransition', {
        configurable: true,
        value: (callback: () => void) => {
          update = callback;
          return { finished };
        },
      });
      const close = () => {
        animateTransition(
          () => {
            media.classList.remove('active');
            syncOverlayState();
          },
          source === 'button' ? { closingWindow: true } : undefined,
        );
        return true;
      };
      onWindowBack(media, close);

      const result = source === 'back' ? offerBackToTopWindow() : (close(), null);
      const settled = result?.settled ?? whenBackSurfaceSettled();
      const observed = vi.fn();
      const observation = settled.then(observed);
      await Promise.resolve();
      expect(media.classList.contains('active')).toBe(true);
      expect(observed).not.toHaveBeenCalled();

      update();
      await Promise.resolve();
      expect(media.classList.contains('active')).toBe(false);
      expect(observed).not.toHaveBeenCalled();

      finish();
      await observation;
      expect(observed).toHaveBeenCalledOnce();
    },
  );

  it('does not wait for unrelated entry or tab animations', async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: (callback: () => void) => {
        callback();
        return { finished };
      },
    });
    animateTransition(() => overlay('media-source-overlay', 'active'));
    await whenBackSurfaceSettled();
    finish();
  });

  it('waits for a successor closing surface instead of resolving a stale snapshot', async () => {
    const changes = vi.fn();
    const unsubscribe = onOverlayStackChange(changes);
    const finishFirst = beginBackSurfaceTransition();
    const settled = whenBackSurfaceSettled();
    const observed = vi.fn();
    const observation = settled.then(observed);
    finishFirst();
    const finishSecond = beginBackSurfaceTransition();
    await Promise.resolve();
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    finishSecond();
    await observation;
    expect(observed).toHaveBeenCalledOnce();
    expect(changes).toHaveBeenCalledTimes(4);
    finishFirst();
    finishSecond();
    expect(changes).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it('isolates listener failures when acquiring, releasing and synchronizing a surface', async () => {
    const failed = vi.fn(() => {
      throw new Error('observer failed');
    });
    const healthy = vi.fn();
    const removeFailed = onOverlayStackChange(failed);
    const removeHealthy = onOverlayStackChange(healthy);
    try {
      const finish = beginBackSurfaceTransition();
      const settled = whenBackSurfaceSettled();
      expect(failed).toHaveBeenCalledOnce();
      expect(healthy).toHaveBeenCalledOnce();
      expect(finish).not.toThrow();
      await settled;
      expect(healthy).toHaveBeenCalledTimes(2);
      expect(() => syncOverlayState()).not.toThrow();
      expect(healthy).toHaveBeenCalledTimes(3);
    } finally {
      removeFailed();
      removeHealthy();
    }
  });

  it('releases every batched close even when a completion listener throws', async () => {
    let completing = false;
    const removeFailed = onOverlayStackChange(() => {
      if (completing) throw new Error('completion observer failed');
    });
    const healthy = vi.fn();
    const removeHealthy = onOverlayStackChange(healthy);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const transition = vi.fn((callback: () => void) => {
      callback();
      return { finished };
    });
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: transition,
    });
    try {
      const first = vi.fn();
      const second = vi.fn();
      animateTransition(first, { closingWindow: true });
      animateTransition(second, { closingWindow: true });
      const settled = whenBackSurfaceSettled();
      await Promise.resolve();
      expect(transition).toHaveBeenCalledOnce();
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
      expect(healthy).toHaveBeenCalledTimes(2);
      completing = true;
      finish();
      await settled;
      expect(healthy).toHaveBeenCalledTimes(4);
    } finally {
      removeFailed();
      removeHealthy();
    }
  });

  it('settles an interrupted view transition without rejecting the Back result', async () => {
    const media = overlay('media-source-overlay', 'active');
    syncOverlayState('media-source-overlay');
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: (callback: () => void) => {
        callback();
        return { finished: Promise.reject(new Error('transition replaced')) };
      },
    });
    onWindowBack(media, () => {
      animateTransition(() => media.classList.remove('active'));
      return true;
    });
    const result = offerBackToTopWindow();
    expect(result.handled).toBe(true);
    await expect(result.settled).resolves.toBeUndefined();
  });

  it('treats the setup screens as the page, not a window', () => {
    const setup = overlay('setup-overlay', 'active');
    const handler = vi.fn(() => true);
    onWindowBack(setup, handler);
    syncOverlayState('setup-overlay');

    expect(hasOpenWindow()).toBe(false);
    expect(offerBackToTopWindow().handled).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('offers Back only to the top window, a dialog above a fullscreen layer', () => {
    const media = overlay('media-source-overlay', 'active');
    syncOverlayState('media-source-overlay');
    const language = overlay('language-dialog-overlay', 'show');
    syncOverlayState('language-dialog-overlay');
    const mediaBack = vi.fn(() => true);
    const languageBack = vi.fn(() => {
      language.classList.remove('show');
      return true;
    });
    onWindowBack(media, mediaBack);
    onWindowBack(language, languageBack);

    expect(hasOpenWindow()).toBe(true);
    expect(offerBackToTopWindow().handled).toBe(true);
    expect(languageBack).toHaveBeenCalledOnce();
    expect(mediaBack).not.toHaveBeenCalled();

    expect(offerBackToTopWindow().handled).toBe(true);
    expect(mediaBack).toHaveBeenCalledOnce();
  });

  it('gives a layer inside the window the first chance', () => {
    const demo = overlay('demo-overlay', 'active');
    const header = document.createElement('div');
    demo.appendChild(header);
    syncOverlayState('demo-overlay');
    let expanded = true;
    const layerBack = vi.fn(() => {
      if (!expanded) return false;
      expanded = false;
      return true;
    });
    const demoBack = vi.fn(() => true);
    onWindowBack(header, layerBack);
    onWindowBack(demo, demoBack);

    expect(offerBackToTopWindow().handled).toBe(true);
    expect(demoBack).not.toHaveBeenCalled();

    expect(offerBackToTopWindow().handled).toBe(true);
    expect(layerBack).toHaveBeenCalledTimes(2);
    expect(demoBack).toHaveBeenCalledOnce();
  });

  it('passes a Back the window does not use on to the session guard or the browser', () => {
    const demo = overlay('demo-overlay', 'active');
    syncOverlayState('demo-overlay');
    onWindowBack(demo, () => false);

    expect(hasOpenWindow()).toBe(true);
    expect(offerBackToTopWindow().handled).toBe(false);
  });

  it('uses the Back when a window handler throws, so the page never leaves', () => {
    const account = overlay('account-dialog-overlay', 'show');
    syncOverlayState('account-dialog-overlay');
    onWindowBack(account, () => {
      throw new Error('close failed');
    });

    expect(offerBackToTopWindow().handled).toBe(true);
  });

  it('closes the chat drawer only while it is a modal sheet', () => {
    const drawer = document.createElement('div');
    drawer.id = 'chat-drawer';
    drawer.classList.add('open');
    document.body.appendChild(drawer);
    const drawerBack = vi.fn(() => true);
    onWindowBack(drawer, drawerBack);

    // The desktop side panel is part of the page.
    expect(hasOpenWindow()).toBe(false);
    expect(offerBackToTopWindow().handled).toBe(false);

    drawer.setAttribute('aria-modal', 'true');
    expect(hasOpenWindow()).toBe(true);
    expect(offerBackToTopWindow().handled).toBe(true);
    expect(drawerBack).toHaveBeenCalledOnce();
  });

  it('leaves a fullscreen video first, below any dialog above it', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper';
    const player = document.createElement('div');
    wrapper.appendChild(player);
    document.body.appendChild(wrapper);
    const videoBack = vi.fn(() => true);
    onWindowBack(wrapper, videoBack);
    expect(hasOpenWindow()).toBe(false);

    // The iOS shell fills the screen with a class.
    wrapper.classList.add('fake-fullscreen');
    expect(offerBackToTopWindow().handled).toBe(true);
    expect(videoBack).toHaveBeenCalledOnce();
    wrapper.classList.remove('fake-fullscreen');

    // Native fullscreen on the player or an element inside it.
    Object.defineProperty(document, 'fullscreenElement', { value: player, configurable: true });
    try {
      expect(hasOpenWindow()).toBe(true);
      const dialog = overlay('dialog-overlay', 'show');
      const dialogBack = vi.fn(() => true);
      onWindowBack(dialog, dialogBack);
      syncOverlayState('dialog-overlay');

      expect(offerBackToTopWindow().handled).toBe(true);
      expect(dialogBack).toHaveBeenCalledOnce();
      expect(videoBack).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
    }
  });

  it('stops a handler once its signal aborts', () => {
    const language = overlay('language-dialog-overlay', 'show');
    syncOverlayState('language-dialog-overlay');
    const controller = new AbortController();
    const handler = vi.fn(() => true);
    onWindowBack(language, handler, controller.signal);
    controller.abort();

    expect(offerBackToTopWindow().handled).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports every modal stack change until unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = onOverlayStackChange(listener);
    overlay('dialog-overlay', 'show');

    syncOverlayState('dialog-overlay');
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    syncOverlayState();
    expect(listener).toHaveBeenCalledOnce();
  });
});
