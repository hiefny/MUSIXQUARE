import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('FOUC cleanup fallback', () => {
  it('stops polling for CSS after the timeout reveals the page', async () => {
    const frames: Array<() => void> = [];
    let timeout: (() => void) | undefined;
    const add = vi.fn();
    const getComputedStyle = vi.fn(() => ({
      getPropertyValue: () => '',
    }));
    const source = await readFile('public/fouc-cleanup.js', 'utf8');

    vm.runInNewContext(source, {
      document: {
        readyState: 'loading',
        hidden: true,
        body: { classList: { add } },
        documentElement: {},
        addEventListener: vi.fn(),
      },
      window: { addEventListener: vi.fn() },
      getComputedStyle,
      requestAnimationFrame: (callback: () => void) => {
        frames.push(callback);
        return frames.length;
      },
      setTimeout: (callback: () => void) => {
        timeout = callback;
        return 1;
      },
    });

    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(frames).toHaveLength(1);
    expect(getComputedStyle).toHaveBeenCalledOnce();

    timeout?.();
    expect(add).toHaveBeenCalledOnce();
    frames.shift()?.();
    expect(frames).toHaveLength(0);
    expect(getComputedStyle).toHaveBeenCalledOnce();
  });

  it('reveals a cold-restored hidden document at DOMContentLoaded without waiting for a frame', async () => {
    const documentListeners = new Map<string, () => void>();
    const add = vi.fn();
    const source = await readFile('public/fouc-cleanup.js', 'utf8');

    vm.runInNewContext(source, {
      document: {
        readyState: 'loading',
        hidden: true,
        body: { classList: { add } },
        documentElement: {},
        addEventListener: (type: string, callback: () => void) => {
          documentListeners.set(type, callback);
        },
      },
      window: { addEventListener: vi.fn() },
      getComputedStyle: vi.fn(() => ({ getPropertyValue: () => '' })),
      requestAnimationFrame: vi.fn(() => 1),
      setTimeout: vi.fn(() => 1),
    });

    expect(add).not.toHaveBeenCalled();
    documentListeners.get('DOMContentLoaded')?.();
    expect(add).toHaveBeenCalledWith('fouc-loaded');
  });

  it('re-asserts the reveal class when WebKit returns the document via pageshow', async () => {
    const windowListeners = new Map<string, () => void>();
    const add = vi.fn();
    const source = await readFile('public/fouc-cleanup.js', 'utf8');

    vm.runInNewContext(source, {
      document: {
        readyState: 'complete',
        hidden: false,
        body: { classList: { add } },
        documentElement: {},
        addEventListener: vi.fn(),
      },
      window: {
        addEventListener: (type: string, callback: () => void) => {
          windowListeners.set(type, callback);
        },
      },
      getComputedStyle: vi.fn(() => ({ getPropertyValue: () => 'black' })),
      requestAnimationFrame: vi.fn(() => 1),
      setTimeout: vi.fn(() => 1),
    });

    expect(add).toHaveBeenCalledTimes(1);
    windowListeners.get('pageshow')?.();
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenLastCalledWith('fouc-loaded');
  });
});
