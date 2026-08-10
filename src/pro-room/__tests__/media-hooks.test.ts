import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueItemId } from '../../types/index.ts';
import {
  cancelProRoomPlaylistFilePreload,
  captureProRoomMediaHookSession,
  handleProRoomTrackMetadataForSession,
  handleProRoomYouTubeForSession,
  hasProRoomPlaylistFilePreload,
  isProRoomMediaHookSessionCurrent,
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
  it('aborts and fences an async hook lease when the installed session is replaced', () => {
    const addA = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
    const metadataA = vi.fn<ProRoomMediaHooks['updateTrackMetadata']>(() => true);
    registerProRoomMediaHooks(hooks({ addYouTube: addA, updateTrackMetadata: metadataA }));
    const sessionA = captureProRoomMediaHookSession();
    expect(sessionA).not.toBeNull();

    const addB = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
    const metadataB = vi.fn<ProRoomMediaHooks['updateTrackMetadata']>(() => true);
    registerProRoomMediaHooks(hooks({ addYouTube: addB, updateTrackMetadata: metadataB }));
    const sessionB = captureProRoomMediaHookSession();
    expect(sessionB).not.toBeNull();

    const item = {
      queueItemId: Q1,
      type: 'youtube',
      name: 'Playlist',
      videoId: 'AAAAAAAAAAA',
      playlistId: 'PL_SESSION',
    } as const;
    expect(sessionA?.signal.aborted).toBe(true);
    expect(isProRoomMediaHookSessionCurrent(sessionA!)).toBe(false);
    expect(handleProRoomYouTubeForSession(sessionA!, item, 'https://youtube.test/a')).toBe(false);
    expect(
      handleProRoomTrackMetadataForSession(sessionA!, Q1, {
        name: 'Stale title',
        title: 'Stale title',
      }),
    ).toBe(false);
    expect(addA).not.toHaveBeenCalled();
    expect(metadataA).not.toHaveBeenCalled();
    expect(addB).not.toHaveBeenCalled();
    expect(metadataB).not.toHaveBeenCalled();

    expect(isProRoomMediaHookSessionCurrent(sessionB!)).toBe(true);
    expect(handleProRoomYouTubeForSession(sessionB!, item, 'https://youtube.test/b')).toBe(true);
    expect(addB).toHaveBeenCalledOnce();
  });

  it('creates a fresh generation even when the same hook object is reinstalled', () => {
    const mediaHooks = hooks({});
    registerProRoomMediaHooks(mediaHooks);
    const first = captureProRoomMediaHookSession();
    registerProRoomMediaHooks(mediaHooks);
    const second = captureProRoomMediaHookSession();

    expect(first).not.toBe(second);
    expect(first?.signal.aborted).toBe(true);
    expect(isProRoomMediaHookSessionCurrent(first!)).toBe(false);
    expect(isProRoomMediaHookSessionCurrent(second!)).toBe(true);
  });

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
