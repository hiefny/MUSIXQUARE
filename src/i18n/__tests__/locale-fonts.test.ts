import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetLocaleFontLoadingForTests,
  __setLocaleFontLoaderForTests,
  isLocaleFontLoadedForTests,
  loadLocaleFont,
} from '../locale-fonts.ts';

afterEach(() => {
  __resetLocaleFontLoadingForTests();
});

describe('locale font CSS loading', () => {
  it('deduplicates concurrent and completed shard loads', async () => {
    let resolveLoad!: () => void;
    const loader = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    __setLocaleFontLoaderForTests('ja', loader);

    const first = loadLocaleFont('ja');
    const concurrent = loadLocaleFont('ja');
    expect(concurrent).toBe(first);
    expect(loader).toHaveBeenCalledTimes(1);

    resolveLoad();
    await first;
    expect(isLocaleFontLoadedForTests('ja')).toBe(true);

    await loadLocaleFont('ja');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('allows a later render to retry a failed shard load', async () => {
    const loader = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary chunk failure'))
      .mockResolvedValueOnce();
    __setLocaleFontLoaderForTests('th', loader);

    await loadLocaleFont('th');
    expect(isLocaleFontLoadedForTests('th')).toBe(false);
    await loadLocaleFont('th');

    expect(loader).toHaveBeenCalledTimes(2);
    expect(isLocaleFontLoadedForTests('th')).toBe(true);
  });
});
