import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginFilePlaybackLoading,
  clearFilePlaybackLoading,
  FILE_PLAYBACK_LOADING_VISUAL_DELAY_MS,
  getFilePlaybackLoadingSnapshot,
  settleFilePlaybackLoading,
  subscribeFilePlaybackLoading,
  type FilePlaybackLoadingSnapshot,
} from '../file-playback-loading-state.ts';

beforeEach(() => {
  vi.useFakeTimers();
  clearFilePlaybackLoading();
});

afterEach(() => {
  clearFilePlaybackLoading();
  vi.useRealTimers();
});

describe('file playback loading state', () => {
  it('delays only visual disclosure for 150ms', () => {
    beginFilePlaybackLoading('host-start', 'start-1');
    expect(getFilePlaybackLoadingSnapshot()).toMatchObject({
      active: true,
      visible: false,
      owner: 'host-start',
      token: 'start-1',
    });

    vi.advanceTimersByTime(FILE_PLAYBACK_LOADING_VISUAL_DELAY_MS - 1);
    expect(getFilePlaybackLoadingSnapshot().visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(getFilePlaybackLoadingSnapshot().visible).toBe(true);
  });

  it('never flashes when the exact operation settles inside the delay', () => {
    const seen: Readonly<FilePlaybackLoadingSnapshot>[] = [];
    const unsubscribe = subscribeFilePlaybackLoading((value) => seen.push(value));

    beginFilePlaybackLoading('guest-prepare', 11);
    expect(settleFilePlaybackLoading('guest-prepare', 11)).toBe(true);
    vi.advanceTimersByTime(FILE_PLAYBACK_LOADING_VISUAL_DELAY_MS);

    expect(seen.some((value) => value.visible)).toBe(false);
    expect(getFilePlaybackLoadingSnapshot().active).toBe(false);
    unsubscribe();
  });

  it('ignores a stale settlement after a newer token supersedes it', () => {
    beginFilePlaybackLoading('host-seek', 21);
    beginFilePlaybackLoading('host-seek', 22);

    expect(settleFilePlaybackLoading('host-seek', 21)).toBe(false);
    vi.advanceTimersByTime(FILE_PLAYBACK_LOADING_VISUAL_DELAY_MS);
    expect(getFilePlaybackLoadingSnapshot()).toMatchObject({
      active: true,
      visible: true,
      token: 22,
    });

    expect(settleFilePlaybackLoading('host-seek', 22)).toBe(true);
    expect(getFilePlaybackLoadingSnapshot()).toEqual({
      active: false,
      visible: false,
      owner: null,
      token: null,
    });
  });

  it('uses owner and token together as the exact settlement identity', () => {
    beginFilePlaybackLoading('host-replay', 31);

    expect(settleFilePlaybackLoading('host-recover', 31)).toBe(false);
    expect(getFilePlaybackLoadingSnapshot().active).toBe(true);

    clearFilePlaybackLoading();
    vi.advanceTimersByTime(FILE_PLAYBACK_LOADING_VISUAL_DELAY_MS);
    expect(getFilePlaybackLoadingSnapshot().active).toBe(false);
  });
});
