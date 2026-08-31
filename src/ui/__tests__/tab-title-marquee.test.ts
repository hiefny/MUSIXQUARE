/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { initTabTitleMarquee, setTabTitlePlaying, setTabTitleTrack } from '../tab-title-marquee.ts';

const DEFAULT_TAB_TITLE = 'MUSIXQUARE';

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value,
  });
}

describe('tab title marquee', () => {
  let dispose: (() => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    setVisibility('visible');
    document.querySelector('meta[property="og:title"]')?.remove();
    dispose = initTabTitleMarquee();
  });

  afterEach(() => {
    dispose?.();
    clearAllManagedTimers();
    vi.useRealTimers();
    setVisibility('visible');
    document.querySelector('meta[property="og:title"]')?.remove();
  });

  it('uses localized page metadata only when no track owns the tab title', () => {
    dispose?.();
    const pageTitle = document.createElement('meta');
    pageTitle.setAttribute('property', 'og:title');
    pageTitle.content = '뮤직스퀘어 | MUSIXQUARE';
    document.head.appendChild(pageTitle);
    dispose = initTabTitleMarquee();

    expect(document.title).toBe('뮤직스퀘어 | MUSIXQUARE');

    setTabTitleTrack('Playing track');
    setTabTitlePlaying(true);
    pageTitle.content = 'ミュージックスクエア | MUSIXQUARE';
    expect(document.title).toBe('Playing track · MUSIXQUARE');

    setTabTitleTrack('');
    expect(document.title).toBe('ミュージックスクエア | MUSIXQUARE');
  });

  it('derives frames from elapsed time and never splits an emoji surrogate pair', () => {
    setTabTitleTrack('🎵A');
    setTabTitlePlaying(true);
    expect(document.title).toBe('🎵A · MUSIXQUARE');

    vi.advanceTimersByTime(3_000);
    expect(document.title).toBe('A · MUSIXQUARE');

    setTabTitleTrack('ABC');
    vi.advanceTimersByTime(10_000);
    expect(document.title).toBe('ABC · MUSIXQUARE');

    setTabTitleTrack('');
    expect(document.title).toBe(DEFAULT_TAB_TITLE);
  });

  it('shows a new playing track immediately, then advances on wall-clock time', () => {
    setTabTitleTrack('First track');
    setTabTitlePlaying(true);

    expect(document.title).toBe('First track · MUSIXQUARE');
    expect(getManagedTimer('tab-title-marquee')).not.toBeNull();

    vi.advanceTimersByTime(3_000);
    expect(document.title).toBe('irst track · MUSIXQUARE');

    // A remote metadata update can arrive while playback is already active.
    // It must replace the title and restart the new track's opening pause.
    setTabTitleTrack('Remote track');
    expect(document.title).toBe('Remote track · MUSIXQUARE');

    vi.advanceTimersByTime(2_999);
    expect(document.title).toBe('Remote track · MUSIXQUARE');
  });

  it('updates metadata while paused without waiting for another playback event', () => {
    setTabTitleTrack('Old track');
    setTabTitlePlaying(false);
    setTabTitleTrack('Paused remote track');

    expect(document.title).toBe('Paused remote track · MUSIXQUARE');
    expect(getManagedTimer('tab-title-marquee')).toBeNull();
  });

  it('resynchronizes and restores a discarded timer when the tab becomes visible', () => {
    setTabTitleTrack('Background track');
    setTabTitlePlaying(true);
    clearAllManagedTimers();

    // Simulate a browser that suspended/discarded the interval while hidden.
    vi.setSystemTime(8_000);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(document.title).toBe('ound track · MUSIXQUARE');
    expect(getManagedTimer('tab-title-marquee')).not.toBeNull();
  });

  it('re-arms an interval whose managed handle survived a browser scheduler discard', () => {
    setTabTitleTrack('Background track');
    setTabTitlePlaying(true);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    // WebKit can discard the native interval while our managed-timer registry
    // still contains its handle. This is deliberately different from
    // clearAllManagedTimers(), which also removes the registry entry.
    vi.clearAllTimers();
    expect(getManagedTimer('tab-title-marquee')).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    vi.setSystemTime(8_000);
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(document.title).toBe('ound track · MUSIXQUARE');
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1_000);
    expect(document.title).toBe('und track · MUSIXQUARE');
  });

  it('rehydrates stale cached metadata from the canonical snapshot on pageshow', () => {
    dispose?.();

    let snapshot: { track: string; playing?: boolean } = {
      track: 'Old cached track',
      playing: true,
    };
    dispose = initTabTitleMarquee(() => snapshot);
    expect(document.title).toBe('Old cached track · MUSIXQUARE');

    vi.clearAllTimers();
    vi.setSystemTime(12_000);
    // An external player can be temporarily unavailable during restoration.
    // Missing motion state must preserve the last authoritative playing value.
    snapshot = { track: 'Current track' };
    window.dispatchEvent(new Event('pageshow'));

    expect(document.title).toBe('Current track · MUSIXQUARE');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('keeps the complete title static after playback stops', () => {
    setTabTitleTrack('Stopped track');
    setTabTitlePlaying(true);
    vi.advanceTimersByTime(5_000);
    setTabTitlePlaying(false);

    expect(document.title).toBe('Stopped track · MUSIXQUARE');
    expect(getManagedTimer('tab-title-marquee')).toBeNull();
  });
});
