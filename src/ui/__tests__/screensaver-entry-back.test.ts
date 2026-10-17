/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { __resetModalStackForTests, whenBackSurfaceSettled } from '../dom.ts';
import { beginScreensaverEntry, type ScreensaverEntry } from '../screensaver-entry.ts';

let entry: ScreensaverEntry | null = null;

function fullscreenFixture(legacy = false) {
  let fullscreen: Element | null = null;
  const property = legacy ? 'webkitFullscreenElement' : 'fullscreenElement';
  const change = (element: Element | null) => {
    fullscreen = element;
    document.dispatchEvent(new Event(legacy ? 'webkitfullscreenchange' : 'fullscreenchange'));
  };
  Object.defineProperty(document, property, { configurable: true, get: () => fullscreen });
  const exit = vi.fn<() => void | Promise<void>>(() => change(null));
  Object.defineProperty(document, legacy ? 'webkitExitFullscreen' : 'exitFullscreen', {
    configurable: true,
    value: exit,
  });
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: vi.fn(() => {
      change(document.documentElement);
      return Promise.resolve();
    }),
  });
  return { exit, change };
}

async function openEntry(): Promise<ScreensaverEntry> {
  entry = beginScreensaverEntry();
  expect(entry).not.toBeNull();
  await Promise.resolve();
  await Promise.resolve();
  return entry!;
}

beforeEach(() => {
  vi.useFakeTimers();
  clearAllManagedTimers();
  __resetModalStackForTests();
});

afterEach(async () => {
  entry?.release();
  window.dispatchEvent(new Event('pagehide'));
  await vi.advanceTimersByTimeAsync(2_000);
  __resetModalStackForTests();
  clearAllManagedTimers();
  entry = null;
  for (const key of [
    'fullscreenElement',
    'exitFullscreen',
    'webkitFullscreenElement',
    'webkitExitFullscreen',
  ])
    delete (document as unknown as Record<string, unknown>)[key];
  delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
  vi.useRealTimers();
});

describe('screensaver native exit Back surface', () => {
  it('keeps Back settlement pending after the overlay releases its fullscreen entry', async () => {
    const native = fullscreenFixture();
    let resolve!: () => void;
    native.exit.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const current = await openEntry();
    current.release();
    const observed = vi.fn();
    const settled = whenBackSurfaceSettled().then(observed);
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    resolve();
    await settled;
    expect(observed).toHaveBeenCalledOnce();
    expect(native.exit).toHaveBeenCalledOnce();
  });

  it('settles from fullscreenchange without waiting for a stalled native promise', async () => {
    const native = fullscreenFixture();
    native.exit.mockImplementation(() => new Promise<void>(() => {}));
    const current = await openEntry();
    current.release();
    const observed = vi.fn();
    const settled = whenBackSurfaceSettled().then(observed);
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    native.change(null);
    await settled;
    expect(observed).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'bounds a missing native completion after timer-registry teardown (legacy=%s)',
    async (legacy) => {
      const native = fullscreenFixture(legacy);
      native.exit.mockImplementation(() => (legacy ? undefined : new Promise<void>(() => {})));
      const current = await openEntry();
      current.release();
      const observed = vi.fn();
      const settled = whenBackSurfaceSettled().then(observed);
      clearAllManagedTimers();
      await vi.advanceTimersByTimeAsync(1_499);
      expect(observed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(observed).toHaveBeenCalledOnce();
    },
  );

  it('releases the pending surface when the browser rejects exit', async () => {
    const native = fullscreenFixture();
    native.exit.mockImplementation(() => Promise.reject(new Error('denied')));
    const current = await openEntry();
    current.release();
    await whenBackSurfaceSettled();
    expect(native.exit).toHaveBeenCalledOnce();
  });

  it('releases the pending surface on pagehide and ignores late completion', async () => {
    const native = fullscreenFixture();
    let resolve!: () => void;
    native.exit.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const current = await openEntry();
    current.release();
    window.dispatchEvent(new Event('pagehide'));
    await whenBackSurfaceSettled();
    resolve();
    await Promise.resolve();
    await whenBackSurfaceSettled();
    expect(native.exit).toHaveBeenCalledOnce();
  });

  it('preserves a pre-existing fullscreen surface without introducing an exit wait', async () => {
    const native = fullscreenFixture();
    native.change(document.body);
    const current = await openEntry();
    current.release();
    await whenBackSurfaceSettled();
    expect(native.exit).not.toHaveBeenCalled();
  });
});
