/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRetryableStylesheet } from '../retryable-stylesheet.ts';

afterEach(() => {
  document.head.innerHTML = '';
  vi.restoreAllMocks();
});

function failedViteImport() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/assets/noto-arabic-12345678.css';
  link.crossOrigin = '';
  link.nonce = 'local-test-nonce';
  document.head.appendChild(link);
  return Promise.reject(new Error('Unable to preload CSS'));
}

describe('native locale stylesheet retry', () => {
  it('shares normal loading and never refetches a completed stylesheet', async () => {
    let finish!: () => void;
    const original = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const load = createRetryableStylesheet('noto-arabic', original);
    const first = load();
    expect(load()).toBe(first);
    finish();
    await first;
    await load();
    expect(original).toHaveBeenCalledOnce();
    expect(document.querySelector('link')).toBeNull();
  });

  it('retries the emitted CSS URL with a native link even when Vite would falsely resolve', async () => {
    const original = vi.fn().mockImplementationOnce(failedViteImport).mockResolvedValue({});
    const load = createRetryableStylesheet('noto-arabic', original);
    await expect(load()).rejects.toThrow('Unable to preload CSS');
    expect(document.querySelector('link')).toBeNull();
    let resolved = false;
    const retry = load().then(() => {
      resolved = true;
    });
    const link = document.querySelector<HTMLLinkElement>('link')!;
    expect(link.getAttribute('href')).toBe('/assets/noto-arabic-12345678.css');
    expect(link.nonce).toBe('local-test-nonce');
    expect(link.crossOrigin).toBe('');
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(original).toHaveBeenCalledOnce();
    link.dispatchEvent(new Event('load'));
    await retry;
    await load();
    expect(resolved).toBe(true);
    expect(document.querySelectorAll('link')).toHaveLength(1);
  });

  it('shares aliases and keeps a second native failure retryable without accumulating links', async () => {
    const original = vi.fn(failedViteImport);
    const load = createRetryableStylesheet('noto-arabic', original);
    await expect(load()).rejects.toThrow();
    const firstRetry = load();
    expect(load()).toBe(firstRetry);
    const failure = expect(firstRetry).rejects.toThrow('Unable to load stylesheet');
    document.querySelector('link')!.dispatchEvent(new Event('error'));
    await failure;
    expect(document.querySelector('link')).toBeNull();
    const next = load();
    document.querySelector('link')!.dispatchEvent(new Event('load'));
    await next;
    expect(original).toHaveBeenCalledOnce();
  });

  it('does not remove or reuse an unrelated stylesheet after an import failure', async () => {
    const other = document.createElement('link');
    other.rel = 'stylesheet';
    other.href = '/assets/noto-hebrew-12345678.css';
    document.head.appendChild(other);
    const original = vi
      .fn()
      .mockRejectedValueOnce(new Error('module failure'))
      .mockResolvedValue({});
    const load = createRetryableStylesheet('noto-arabic', original);
    await expect(load()).rejects.toThrow('module failure');
    await load();
    expect(original).toHaveBeenCalledTimes(2);
    expect(document.querySelector('link')).toBe(other);
  });
});
