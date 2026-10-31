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

  it('abandons a stalled first attempt: removes its link, rejects, and retries natively', async () => {
    const original = vi.fn(() => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/assets/noto-arabic-12345678.css';
      document.head.appendChild(link);
      return new Promise<never>(() => undefined);
    });
    const load = createRetryableStylesheet('noto-arabic', original);
    const first = load();
    const failure = expect(first).rejects.toThrow('abandoned');

    load.abandon();
    await failure;
    expect(document.querySelector('link')).toBeNull();

    const retry = load();
    expect(retry).not.toBe(first);
    const link = document.querySelector<HTMLLinkElement>('link')!;
    expect(link.getAttribute('href')).toBe('/assets/noto-arabic-12345678.css');
    link.dispatchEvent(new Event('load'));
    await retry;
    await load();
    expect(original).toHaveBeenCalledOnce();
    expect(document.querySelectorAll('link')).toHaveLength(1);
  });

  it('abandons a stalled native retry without leaving its link behind', async () => {
    const original = vi.fn(failedViteImport);
    const load = createRetryableStylesheet('noto-arabic', original);
    await expect(load()).rejects.toThrow();
    const stalled = load();
    const failure = expect(stalled).rejects.toThrow('abandoned');
    expect(document.querySelectorAll('link')).toHaveLength(1);

    load.abandon();
    await failure;
    expect(document.querySelector('link')).toBeNull();

    const next = load();
    expect(document.querySelectorAll('link')).toHaveLength(1);
    document.querySelector('link')!.dispatchEvent(new Event('load'));
    await next;
    expect(original).toHaveBeenCalledOnce();
  });

  it('ignores abandon() when nothing is in flight', async () => {
    const original = vi.fn().mockResolvedValue({});
    const load = createRetryableStylesheet('noto-arabic', original);
    load.abandon();
    await load();
    load.abandon();
    await load();
    expect(original).toHaveBeenCalledOnce();
  });

  function loadedViteImport() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/assets/noto-arabic-12345678.css';
    link.nonce = 'local-test-nonce';
    document.head.appendChild(link);
    return Promise.resolve({});
  }

  it('declares a loaded sheet again with a fresh link and drops the old one once it loads', async () => {
    const load = createRetryableStylesheet('noto-arabic', vi.fn(loadedViteImport));
    await load();
    const old = document.querySelector<HTMLLinkElement>('link')!;

    expect(load.redeclare()).toBe(true);
    const links = document.querySelectorAll<HTMLLinkElement>('link');
    expect(links).toHaveLength(2);
    const fresh = links[1]!;
    expect(fresh).not.toBe(old);
    expect(fresh.getAttribute('href')).toBe('/assets/noto-arabic-12345678.css');
    expect(fresh.nonce).toBe('local-test-nonce');
    // A second request while one is pending declares nothing more.
    expect(load.redeclare()).toBe(false);

    fresh.dispatchEvent(new Event('load'));
    expect([...document.querySelectorAll('link')]).toEqual([fresh]);

    // The fresh link is now the one a later recovery clones.
    expect(load.redeclare()).toBe(true);
    const newest = document.querySelectorAll<HTMLLinkElement>('link')[1]!;
    newest.dispatchEvent(new Event('load'));
    expect([...document.querySelectorAll('link')]).toEqual([newest]);
  });

  it('keeps the declaring link when the fresh one fails', async () => {
    const load = createRetryableStylesheet('noto-arabic', vi.fn(loadedViteImport));
    await load();
    const old = document.querySelector<HTMLLinkElement>('link')!;

    expect(load.redeclare()).toBe(true);
    document.querySelectorAll<HTMLLinkElement>('link')[1]!.dispatchEvent(new Event('error'));

    expect([...document.querySelectorAll('link')]).toEqual([old]);
    expect(load.redeclare()).toBe(true);
  });

  it('declares again the native link that loaded a retried sheet', async () => {
    const load = createRetryableStylesheet('noto-arabic', vi.fn(failedViteImport));
    await expect(load()).rejects.toThrow();
    const retry = load();
    const declaring = document.querySelector<HTMLLinkElement>('link')!;
    declaring.dispatchEvent(new Event('load'));
    await retry;

    expect(load.redeclare()).toBe(true);
    const fresh = document.querySelectorAll<HTMLLinkElement>('link')[1]!;
    expect(fresh.getAttribute('href')).toBe(declaring.getAttribute('href'));
    fresh.dispatchEvent(new Event('load'));
    expect([...document.querySelectorAll('link')]).toEqual([fresh]);
  });

  it('declares nothing again before the sheet has loaded', async () => {
    const load = createRetryableStylesheet('noto-arabic', vi.fn(failedViteImport));
    expect(load.redeclare()).toBe(false);
    await expect(load()).rejects.toThrow();
    expect(load.redeclare()).toBe(false);
    expect(document.querySelector('link')).toBeNull();
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
