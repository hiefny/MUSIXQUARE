/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const timerMocks = vi.hoisted(() => {
  const callbacks = new Map<string, () => unknown>();
  return {
    callbacks,
    setManagedTimer: vi.fn((name: string, callback: () => unknown) => {
      callbacks.set(name, callback);
    }),
    clearManagedTimer: vi.fn((name: string) => {
      callbacks.delete(name);
    }),
  };
});

const uiMocks = vi.hoisted(() => ({
  addSystemChatMessage: vi.fn(),
  showToast: vi.fn(),
  clipboardWriteText: vi.fn(async () => undefined),
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: timerMocks.setManagedTimer,
  clearManagedTimer: timerMocks.clearManagedTimer,
}));

vi.mock('../../ui/chat-render.ts', () => ({
  addSystemChatMessage: uiMocks.addSystemChatMessage,
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: uiMocks.showToast,
}));

import { resetState } from '../../core/state.ts';
import { cmdDebug } from '../debug-console.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function storageEstimate(usageMB: number): StorageEstimate {
  return {
    usage: usageMB * 1_048_576,
    quota: 100 * 1_048_576,
  };
}

function canvasContext(): CanvasRenderingContext2D {
  return {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  resetState();
  document.body.innerHTML = '';
  timerMocks.callbacks.clear();
  timerMocks.setManagedTimer.mockClear();
  timerMocks.clearManagedTimer.mockClear();
  uiMocks.clipboardWriteText.mockClear();
  uiMocks.showToast.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: uiMocks.clipboardWriteText },
  });
  vi.stubGlobal('caches', undefined);
});

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  document.getElementById('debug-memory-overlay')?.click();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('/debug memory live overlay', () => {
  it('does not copy a text snapshot after its view has been dismissed', async () => {
    cmdDebug(['console']);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('debug-console-overlay')).toBeNull();
    expect(uiMocks.clipboardWriteText).not.toHaveBeenCalled();
    expect(uiMocks.showToast).not.toHaveBeenCalled();
  });

  it('cancels pending memory collection when the current view is dismissed', async () => {
    const slowEstimate = deferred<StorageEstimate>();
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: vi.fn(() => slowEstimate.promise) },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());
    cmdDebug(['console']);
    cmdDebug(['memory']);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    slowEstimate.resolve(storageEstimate(2));
    await slowEstimate.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector('.debug-memory-overlay')).toBeNull();
    expect(uiMocks.clipboardWriteText).not.toHaveBeenCalled();
  });

  it('does not replace a newer debug view when an earlier initial memory snapshot finishes', async () => {
    const slowEstimate = deferred<StorageEstimate>();
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: vi.fn(() => slowEstimate.promise) },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());

    cmdDebug(['memory']);
    cmdDebug(['console']);
    await vi.waitFor(() => expect(uiMocks.clipboardWriteText).toHaveBeenCalledOnce());
    const currentOverlay = document.getElementById('debug-console-overlay');
    expect(currentOverlay).not.toBeNull();

    slowEstimate.resolve(storageEstimate(2));
    // Let the discarded storage read finish without waiting for a UI mutation.
    await slowEstimate.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('debug-console-overlay')).toBe(currentOverlay);
    expect(document.getElementById('debug-memory-overlay')).toBeNull();
    expect(uiMocks.clipboardWriteText).toHaveBeenCalledOnce();
    expect(timerMocks.callbacks.has('debug-memory-poll')).toBe(false);
  });

  it('keeps slow memory collection single-flight and resumes after it settles', async () => {
    const slowEstimate = deferred<StorageEstimate>();
    const estimate = vi
      .fn()
      .mockResolvedValueOnce(storageEstimate(1))
      .mockReturnValueOnce(slowEstimate.promise)
      .mockResolvedValueOnce(storageEstimate(3));
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate },
    });

    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);

    cmdDebug(['memory']);

    await vi.waitFor(() => {
      expect(document.getElementById('debug-memory-overlay')).not.toBeNull();
      expect(timerMocks.callbacks.has('debug-memory-poll')).toBe(true);
    });

    const poll = timerMocks.callbacks.get('debug-memory-poll');
    if (!poll) throw new Error('Missing debug memory poll callback');

    poll();
    expect(estimate).toHaveBeenCalledTimes(2);

    // The first poll is still waiting on StorageManager. Repeated interval
    // callbacks must not start more collectors or append out of order.
    poll();
    poll();
    expect(estimate).toHaveBeenCalledTimes(2);

    slowEstimate.resolve(storageEstimate(2));
    await vi.waitFor(() => {
      expect(document.querySelector('.debug-memory-content')?.textContent).toContain('disk:2.0MB');
    });

    poll();
    await vi.waitFor(() => {
      expect(estimate).toHaveBeenCalledTimes(3);
      expect(document.querySelector('.debug-memory-content')?.textContent).toContain('disk:3.0MB');
    });

    expect(context.fillText).toHaveBeenCalledWith(
      '3.0 (n=3)',
      expect.any(Number),
      expect.any(Number),
    );
  });
});
