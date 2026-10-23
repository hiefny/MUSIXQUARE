/** @vitest-environment jsdom */
/**
 * RO-26 hand-off between the two fullscreen owners: the screensaver closes on
 * a YouTube takeover (screensaver.ts enforcePlayback, release()) and the user
 * taps the YouTube fullscreen toggle before the screensaver's native exit has
 * delivered its fullscreenchange.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { FULLSCREEN_SETTLEMENT_MS } from '../../core/fullscreen.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import '../../player/video.ts';
import { __resetModalStackForTests, whenBackSurfaceSettled } from '../dom.ts';
import { initPlayerControls } from '../player-controls.ts';
import { openScreensaver } from '../screensaver.ts';

vi.mock('../toast.ts', () => ({ showToast: vi.fn(), showLoader: vi.fn() }));

const DOCUMENT_PROPERTIES = ['fullscreenElement', 'exitFullscreen'] as const;

/** Standard Fullscreen API whose exit stays in flight until the test changes it. */
function standardFullscreen() {
  let current: Element | null = null;
  const change = (element: Element | null): void => {
    current = element;
    document.dispatchEvent(new Event('fullscreenchange'));
  };
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => current,
  });
  const exit = vi.fn(() => new Promise<void>(() => {}));
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
  const requestRoot = vi.fn(() => {
    change(document.documentElement);
    return Promise.resolve();
  });
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: requestRoot,
  });
  const wrapper = document.querySelector<HTMLElement>('.video-wrapper')!;
  const requestWrapper = vi.fn(() => {
    change(wrapper);
    return Promise.resolve();
  });
  Object.defineProperty(wrapper, 'requestFullscreen', {
    configurable: true,
    value: requestWrapper,
  });
  return { exit, change, requestWrapper };
}

async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  clearAllManagedTimers();
  __resetModalStackForTests();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  document.body.className = '';
  document.body.innerHTML = `
    <main id="app-shell">
      <div class="video-wrapper">
        <div id="youtube-player-container"><iframe></iframe></div>
        <button id="btn-fullscreen"></button>
      </div>
    </main>
  `;
  setState('setup.sessionStarted', true);
  setState('playback.mode', 'file');
  setState('player.currentTrackMeta', { type: 'file', name: 'Midnight.mp3' });
});

afterEach(async () => {
  window.dispatchEvent(new Event('pagehide'));
  await vi.advanceTimersByTimeAsync(2_000);
  setState('setup.sessionStarted', false);
  __resetModalStackForTests();
  clearAllManagedTimers();
  for (const property of DOCUMENT_PROPERTIES) Reflect.deleteProperty(document, property);
  Reflect.deleteProperty(document.documentElement, 'requestFullscreen');
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
  bus.clear();
});

/** Opens the screensaver in fullscreen, then lets YouTube take over and close it. */
async function closeScreensaverOnYouTubeTakeover(): Promise<ReturnType<typeof standardFullscreen>> {
  const native = standardFullscreen();
  initPlayerControls();
  openScreensaver();
  await settleMicrotasks();
  expect(document.fullscreenElement).toBe(document.documentElement);
  // YouTube takes over: the screensaver closes and starts its native exit.
  setState('playback.mode', 'youtube');
  expect(native.exit).toHaveBeenCalledOnce();
  return native;
}

describe('YouTube fullscreen toggle during a screensaver exit', () => {
  it('is unavailable until the screensaver exit settles, then enters again [C8-I13, owner decision O2]', async () => {
    const native = await closeScreensaverOnYouTubeTakeover();
    const toggle = document.getElementById('btn-fullscreen')!;
    expect(toggle.getAttribute('aria-disabled')).toBe('true');

    // The tap lands before fullscreenchange, while <html> is still fullscreen.
    toggle.click();
    expect(native.exit).toHaveBeenCalledOnce();
    expect(native.requestWrapper).not.toHaveBeenCalled();

    const observed = vi.fn();
    const settled = whenBackSurfaceSettled().then(observed);
    await settleMicrotasks();
    expect(observed).not.toHaveBeenCalled();
    native.change(null);
    await settled;
    expect(observed).toHaveBeenCalledOnce();
    expect(toggle.hasAttribute('aria-disabled')).toBe(false);

    toggle.click();
    expect(native.requestWrapper).toHaveBeenCalledOnce();
    expect(native.exit).toHaveBeenCalledOnce();
  });

  it('comes back at the 1.5 s bound when the screensaver exit never reports', async () => {
    await closeScreensaverOnYouTubeTakeover();
    const toggle = document.getElementById('btn-fullscreen')!;
    clearAllManagedTimers();
    await vi.advanceTimersByTimeAsync(FULLSCREEN_SETTLEMENT_MS - 1);
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    await vi.advanceTimersByTimeAsync(1);
    expect(toggle.hasAttribute('aria-disabled')).toBe(false);
  });

  it('a YouTube mode exit during the screensaver exit joins it [C8-I9]', async () => {
    const native = await closeScreensaverOnYouTubeTakeover();
    // The host switches back to a file before fullscreenchange arrives.
    setState('playback.mode', 'file');
    expect(native.exit).toHaveBeenCalledOnce();
    native.change(null);
    await settleMicrotasks();
    expect(document.getElementById('btn-fullscreen')!.hasAttribute('aria-disabled')).toBe(false);
  });

  it('stays available while only a YouTube-owned exit is in flight', async () => {
    const native = standardFullscreen();
    setState('playback.mode', 'youtube');
    initPlayerControls();
    const toggle = document.getElementById('btn-fullscreen')!;
    toggle.click();
    await settleMicrotasks();
    expect(document.fullscreenElement).toBe(document.querySelector('.video-wrapper'));
    toggle.click();
    expect(native.exit).toHaveBeenCalledOnce();
    expect(toggle.hasAttribute('aria-disabled')).toBe(false);
    native.change(null);
  });
});
