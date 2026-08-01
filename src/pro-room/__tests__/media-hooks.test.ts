import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueItemId } from '../../types/index.ts';
import {
  cancelProRoomPlaylistFilePreload,
  hasProRoomPlaylistFilePreload,
  preloadProRoomPlaylistFile,
  registerProRoomMediaHooks,
  resolveProRoomPlaylistFile,
  type ProRoomMediaHooks,
} from '../media-hooks.ts';

const Q1 = '10000000-0000-4000-8000-000000000001' as QueueItemId;

function hooks(overrides: Partial<ProRoomMediaHooks>): ProRoomMediaHooks {
  return {
    addFiles: () => false,
    addYouTube: () => false,
    updateTrackMetadata: () => false,
    removeTracks: () => false,
    reorderTrack: () => false,
    resolveFile: () => null,
    ...overrides,
  };
}

afterEach(() => registerProRoomMediaHooks(null));

describe('PRO room media self-preload seam', () => {
  it('returns the runtime-owned preload promise without wrapping its identity', () => {
    const promise = Promise.resolve(new File(['audio'], 'next.flac', { type: 'audio/flac' }));
    const preloadFile = vi.fn(() => promise);
    registerProRoomMediaHooks(hooks({ preloadFile }));

    expect(preloadProRoomPlaylistFile(Q1)).toBe(promise);
    expect(preloadFile).toHaveBeenCalledWith(Q1);
  });

  it('keeps foreground resolution and targeted preload cancellation as separate lanes', () => {
    const foreground = Promise.resolve(new File(['current'], 'current.flac'));
    const resolveFile = vi.fn(() => foreground);
    const cancelPreload = vi.fn();
    registerProRoomMediaHooks(hooks({ resolveFile, cancelPreload }));

    expect(resolveProRoomPlaylistFile(Q1)).toBe(foreground);
    cancelProRoomPlaylistFilePreload(Q1);

    expect(resolveFile).toHaveBeenCalledWith(Q1);
    expect(cancelPreload).toHaveBeenCalledWith(Q1);
  });

  it('lets the scheduler verify that completed metadata still owns cache bytes', () => {
    const hasPreloadedFile = vi.fn(() => true);
    registerProRoomMediaHooks(hooks({ hasPreloadedFile }));

    expect(hasProRoomPlaylistFilePreload(Q1)).toBe(true);
    expect(hasPreloadedFile).toHaveBeenCalledWith(Q1);
  });

  it('is inert outside an active PRO runtime', () => {
    expect(preloadProRoomPlaylistFile(Q1)).toBeNull();
    expect(hasProRoomPlaylistFilePreload(Q1)).toBe(false);
    expect(() => cancelProRoomPlaylistFilePreload(Q1)).not.toThrow();
  });
});
