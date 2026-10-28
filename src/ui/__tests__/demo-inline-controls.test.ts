/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bindDemoInlineControls } from '../demo-inline-controls.ts';
import {
  __resetModalStackForTests,
  offerBackToTopWindow,
  syncOverlayState,
  whenBackSurfaceSettled,
} from '../dom.ts';

let controller: AbortController;

function end(property: string): void {
  const event = new Event('transitionend');
  Object.defineProperty(event, 'propertyName', { value: property });
  document.getElementById('demo-inline-controls')!.dispatchEvent(event);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  setState('demo.active', true);
  document.body.innerHTML = `
    <style>
      #demo-inline-controls { transition-property: opacity, transform; transition-duration: 0.3s, 0.35s; }
      .demo-controls-expanded #demo-inline-controls { transition-duration: 1s, 1s; }
    </style>
    <div id="demo-overlay" class="active">
      <div class="demo-track-header">
        <button id="btn-demo-settings">Settings</button>
        <div class="demo-track-copy">Track</div>
        <div id="demo-inline-controls"></div>
      </div>
    </div>
  `;
  __resetModalStackForTests();
  controller = new AbortController();
  bindDemoInlineControls({
    signal: controller.signal,
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onSync: vi.fn(),
  });
  syncOverlayState('demo-overlay');
  document.getElementById('btn-demo-settings')!.click();
});

afterEach(() => {
  controller.abort();
  __resetModalStackForTests();
  vi.useRealTimers();
});

describe('demo disclosure closing settlement', () => {
  it('waits for transform completion after Back rather than the earlier opacity end', async () => {
    await whenBackSurfaceSettled();
    const result = offerBackToTopWindow();
    expect(result.handled).toBe(true);
    const observed = vi.fn();
    const settled = result.settled.then(observed);
    end('opacity');
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    end('transform');
    await settled;
    expect(observed).toHaveBeenCalledOnce();
  });

  it('uses the post-close CSS duration for the fallback', async () => {
    const result = offerBackToTopWindow();
    const observed = vi.fn();
    const settled = result.settled.then(observed);
    await vi.advanceTimersByTimeAsync(449);
    expect(observed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(observed).toHaveBeenCalledOnce();
  });

  it('releases a superseded close on reopen and pending work on teardown', async () => {
    const result = offerBackToTopWindow();
    document.getElementById('btn-demo-settings')!.click();
    await result.settled;
    expect(document.querySelector('.demo-controls-expanded')).not.toBeNull();
    const closing = offerBackToTopWindow();
    controller.abort();
    await closing.settled;
    expect(document.querySelector('.demo-controls-expanded')).toBeNull();
  });
});

describe('demo settings disclosure name', () => {
  it('keeps the Settings name and tells open or closed with aria-expanded', async () => {
    // A disclosure keeps one name (hint and name copy rule); its back-arrow
    // icon while open is not a reason to rename it Close.
    const opener = document.getElementById('btn-demo-settings')!;
    const closing = offerBackToTopWindow();
    end('transform');
    await closing.settled;
    expect(opener.getAttribute('aria-expanded')).toBe('false');

    opener.setAttribute('aria-label', 'Settings');
    opener.setAttribute('data-i18n-aria-label', 'nav.settings');
    opener.click();
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    expect(opener.getAttribute('aria-label')).toBe('Settings');
    expect(opener.getAttribute('data-i18n-aria-label')).toBe('nav.settings');
    expect(opener.hasAttribute('title')).toBe(false);
  });
});
