/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycleMocks = vi.hoisted(() => ({
  markIntentionalNav: vi.fn(),
}));

vi.mock('../page-lifecycle.ts', () => lifecycleMocks);

const originalRequestAnimationFrame = window.requestAnimationFrame;

describe('session reset coordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    lifecycleMocks.markIntentionalNav.mockClear();
    document.documentElement.className = '';
    document.body.innerHTML = '<main id="app"><button id="control">Control</button></main>';
  });

  afterEach(() => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: originalRequestAnimationFrame,
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('blocks the document immediately and waits for an overlay paint before reset', async () => {
    const frames: FrameRequestCallback[] = [];
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    });
    const action = vi.fn();
    const shortcutHandler = vi.fn();
    window.addEventListener('keydown', shortcutHandler);
    const control = document.getElementById('control') as HTMLButtonElement;
    control.focus();
    const { scheduleSessionReset } = await import('../session-reset.ts');

    scheduleSessionReset('Refreshing session...', action);

    const overlay = document.getElementById('session-reset-overlay') as HTMLElement;
    expect(overlay.hidden).toBe(false);
    expect(overlay.classList.contains('show')).toBe(true);
    expect(overlay.getAttribute('aria-hidden')).toBe('false');
    expect(document.getElementById('session-reset-message')?.textContent).toBe(
      'Refreshing session...',
    );
    expect((document.getElementById('app') as HTMLElement).inert).toBe(true);
    expect(document.documentElement.classList.contains('session-reset-pending')).toBe(true);
    expect(action).not.toHaveBeenCalled();

    const keyEvent = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(keyEvent);
    expect(keyEvent.defaultPrevented).toBe(true);
    expect(shortcutHandler).not.toHaveBeenCalled();
    window.removeEventListener('keydown', shortcutHandler);

    frames.shift()?.(0);
    expect(action).not.toHaveBeenCalled();
    frames.shift()?.(16);

    expect(lifecycleMocks.markIntentionalNav).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });

  it('uses a native timeout fallback and accepts only the first reset request', async () => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: undefined,
    });
    const firstAction = vi.fn();
    const secondAction = vi.fn();
    const { scheduleSessionReset } = await import('../session-reset.ts');

    scheduleSessionReset('First', firstAction);
    scheduleSessionReset('Second', secondAction);
    vi.advanceTimersByTime(120);

    expect(firstAction).toHaveBeenCalledOnce();
    expect(secondAction).not.toHaveBeenCalled();
    expect(document.getElementById('session-reset-message')?.textContent).toBe('First');
    expect(lifecycleMocks.markIntentionalNav).toHaveBeenCalledOnce();
  });
});
