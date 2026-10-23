/** @vitest-environment jsdom */
/**
 * RO-26 owner boundary: the shared fullscreen helper in core/fullscreen.ts and
 * the two surfaces that leave top-document fullscreen through it, the YouTube
 * player (exitYouTubeFullscreen) and the screensaver entry (release()).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exitYouTubeFullscreen } from '../../player/video.ts';
import { __resetModalStackForTests, whenBackSurfaceSettled } from '../../ui/dom.ts';
import { beginScreensaverEntry, type ScreensaverEntry } from '../../ui/screensaver-entry.ts';
import { FULLSCREEN_SETTLEMENT_MS } from '../fullscreen.ts';
import { resetState, setState } from '../state.ts';
import { clearAllManagedTimers } from '../timers.ts';

const DOCUMENT_PROPERTIES = [
  'fullscreenElement',
  'exitFullscreen',
  'webkitFullscreenElement',
  'webkitCurrentFullScreenElement',
  'webkitIsFullScreen',
  'webkitExitFullscreen',
  'webkitCancelFullScreen',
] as const;

let entry: ScreensaverEntry | null = null;

function defineDocument(property: string, descriptor: PropertyDescriptor): void {
  Object.defineProperty(document, property, { configurable: true, ...descriptor });
}

/** Standard Fullscreen API whose exit never settles by itself. */
function stalledFullscreen(initial: Element | null = null) {
  let current = initial;
  const change = (element: Element | null): void => {
    current = element;
    document.dispatchEvent(new Event('fullscreenchange'));
  };
  defineDocument('fullscreenElement', { get: () => current });
  const exit = vi.fn(() => new Promise<void>(() => {}));
  defineDocument('exitFullscreen', { value: exit });
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: vi.fn(() => {
      change(document.documentElement);
      return Promise.resolve();
    }),
  });
  return { exit, change };
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  clearAllManagedTimers();
  __resetModalStackForTests();
  document.body.className = '';
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><iframe></iframe></div></div>';
});

afterEach(async () => {
  entry?.release();
  entry = null;
  window.dispatchEvent(new Event('pagehide'));
  await vi.advanceTimersByTimeAsync(FULLSCREEN_SETTLEMENT_MS);
  __resetModalStackForTests();
  clearAllManagedTimers();
  for (const property of DOCUMENT_PROPERTIES) Reflect.deleteProperty(document, property);
  Reflect.deleteProperty(document.documentElement, 'requestFullscreen');
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('fullscreen settlement bound (C8-I2)', () => {
  it('is one 1.5 s constant shared by both exits', () => {
    expect(FULLSCREEN_SETTLEMENT_MS).toBe(1_500);
  });

  it('bounds a stalled YouTube exit at FULLSCREEN_SETTLEMENT_MS after room timers are cleared', () => {
    setState('playback.mode', 'youtube');
    const native = stalledFullscreen(document.querySelector('.video-wrapper'));
    const settled = vi.fn();
    exitYouTubeFullscreen(settled);
    expect(native.exit).toHaveBeenCalledOnce();
    clearAllManagedTimers();
    vi.advanceTimersByTime(FULLSCREEN_SETTLEMENT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('bounds a stalled screensaver exit at FULLSCREEN_SETTLEMENT_MS after room timers are cleared', async () => {
    const native = stalledFullscreen();
    entry = beginScreensaverEntry();
    expect(entry).not.toBeNull();
    await settleMicrotasks();
    entry!.release();
    expect(native.exit).toHaveBeenCalledOnce();
    const observed = vi.fn();
    const settled = whenBackSurfaceSettled().then(observed);
    clearAllManagedTimers();
    await vi.advanceTimersByTimeAsync(FULLSCREEN_SETTLEMENT_MS - 1);
    expect(observed).not.toHaveBeenCalled();
    expect(beginScreensaverEntry()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(observed).toHaveBeenCalledOnce();
    const retry = beginScreensaverEntry();
    expect(retry).not.toBeNull();
    retry?.release();
  });
});
