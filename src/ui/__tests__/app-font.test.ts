import { describe, expect, it, vi } from 'vitest';

import { schedulePrimaryFontLoad } from '../app-font.ts';

interface ScheduledWindow {
  addEventListener: ReturnType<typeof vi.fn>;
  requestIdleCallback?: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
}

function loadingDocument(): Document {
  return { readyState: 'loading' } as Document;
}

describe('primary app font scheduling', () => {
  it('waits for window load and then browser idle before importing the font CSS', async () => {
    let onLoad: (() => void) | undefined;
    let onIdle: (() => void) | undefined;
    const loader = vi.fn(async () => undefined);
    const targetWindow: ScheduledWindow = {
      addEventListener: vi.fn((type: string, listener: () => void, options?: unknown) => {
        expect(type).toBe('load');
        expect(options).toEqual({ once: true });
        onLoad = listener;
      }),
      requestIdleCallback: vi.fn((callback: () => void, options?: { timeout?: number }) => {
        expect(options?.timeout).toBeGreaterThan(0);
        onIdle = callback;
        return 1;
      }),
      setTimeout: vi.fn(),
    };

    schedulePrimaryFontLoad(targetWindow as unknown as Window, loadingDocument(), loader);
    expect(loader).not.toHaveBeenCalled();
    expect(targetWindow.requestIdleCallback).not.toHaveBeenCalled();

    onLoad?.();
    expect(loader).not.toHaveBeenCalled();
    expect(targetWindow.requestIdleCallback).toHaveBeenCalledOnce();

    onIdle?.();
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
  });

  it('uses a new post-load task when requestIdleCallback is unavailable', async () => {
    let onTimeout: (() => void) | undefined;
    const loader = vi.fn(async () => undefined);
    const targetWindow: ScheduledWindow = {
      addEventListener: vi.fn(),
      setTimeout: vi.fn((callback: () => void, delay: number) => {
        expect(delay).toBe(0);
        onTimeout = callback;
        return 1;
      }),
    };

    schedulePrimaryFontLoad(
      targetWindow as unknown as Window,
      { readyState: 'complete' } as Document,
      loader,
    );
    expect(loader).not.toHaveBeenCalled();
    expect(targetWindow.addEventListener).not.toHaveBeenCalled();

    onTimeout?.();
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
  });
});
