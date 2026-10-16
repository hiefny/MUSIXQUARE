/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModalStackForTests,
  hasOpenWindow,
  offerBackToTopWindow,
  onOverlayStackChange,
  onWindowBack,
  syncOverlayState,
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
    __resetModalStackForTests();
  });

  it('treats the setup screens as the page, not a window', () => {
    const setup = overlay('setup-overlay', 'active');
    const handler = vi.fn(() => true);
    onWindowBack(setup, handler);
    syncOverlayState('setup-overlay');

    expect(hasOpenWindow()).toBe(false);
    expect(offerBackToTopWindow()).toBe(false);
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
    expect(offerBackToTopWindow()).toBe(true);
    expect(languageBack).toHaveBeenCalledOnce();
    expect(mediaBack).not.toHaveBeenCalled();

    expect(offerBackToTopWindow()).toBe(true);
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

    expect(offerBackToTopWindow()).toBe(true);
    expect(demoBack).not.toHaveBeenCalled();

    expect(offerBackToTopWindow()).toBe(true);
    expect(layerBack).toHaveBeenCalledTimes(2);
    expect(demoBack).toHaveBeenCalledOnce();
  });

  it('passes a Back the window does not use on to the session guard or the browser', () => {
    const demo = overlay('demo-overlay', 'active');
    syncOverlayState('demo-overlay');
    onWindowBack(demo, () => false);

    expect(hasOpenWindow()).toBe(true);
    expect(offerBackToTopWindow()).toBe(false);
  });

  it('uses the Back when a window handler throws, so the page never leaves', () => {
    const account = overlay('account-dialog-overlay', 'show');
    syncOverlayState('account-dialog-overlay');
    onWindowBack(account, () => {
      throw new Error('close failed');
    });

    expect(offerBackToTopWindow()).toBe(true);
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
    expect(offerBackToTopWindow()).toBe(false);

    drawer.setAttribute('aria-modal', 'true');
    expect(hasOpenWindow()).toBe(true);
    expect(offerBackToTopWindow()).toBe(true);
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
    expect(offerBackToTopWindow()).toBe(true);
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

      expect(offerBackToTopWindow()).toBe(true);
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

    expect(offerBackToTopWindow()).toBe(false);
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
