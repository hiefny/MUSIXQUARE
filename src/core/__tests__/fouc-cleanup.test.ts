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
        body: { classList: { add } },
        documentElement: {},
      },
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
});
