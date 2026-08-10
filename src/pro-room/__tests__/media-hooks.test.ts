import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueItemId } from '../../types/index.ts';
import {
  cancelProRoomPlaylistFilePreload,
  captureProRoomMediaHookSession,
  handleProRoomFiles,
  handleProRoomTrackMetadata,
  handleProRoomTrackMetadataForSession,
  handleProRoomTrackRemoval,
  handleProRoomYouTubeForSession,
  hasProRoomPlaylistFilePreload,
  invalidateProRoomMediaHookSession,
  isProRoomMediaHookSessionCurrent,
  preloadProRoomPlaylistFile,
  registerProRoomMediaHooks,
  renewProRoomMediaHookSession,
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
  it('fails closed while invalidated and renews the preserved hooks under a fresh session', () => {
    const addFiles = vi.fn<ProRoomMediaHooks['addFiles']>(() => true);
    const addYouTube = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
    const updateTrackMetadata = vi.fn<ProRoomMediaHooks['updateTrackMetadata']>(() => true);
    const removeTracks = vi.fn<ProRoomMediaHooks['removeTracks']>(() => true);
    const resolved = Promise.resolve(new File(['owned'], 'owned.flac'));
    const resolveFile = vi.fn<ProRoomMediaHooks['resolveFile']>(() => resolved);
    const mediaHooks = hooks({
      addFiles,
      addYouTube,
      updateTrackMetadata,
      removeTracks,
      resolveFile,
    });
    registerProRoomMediaHooks(mediaHooks);
    const sessionA = captureProRoomMediaHookSession();
    const renewal = invalidateProRoomMediaHookSession();

    const item = {
      queueItemId: Q1,
      type: 'youtube',
      name: 'Playlist',
      videoId: 'AAAAAAAAAAA',
      playlistId: 'PL_ACCOUNT_SWITCH',
    } as const;
    expect(renewal).not.toBeNull();
    expect(sessionA?.signal.aborted).toBe(true);
    expect(captureProRoomMediaHookSession()).toBeNull();
    expect(isProRoomMediaHookSessionCurrent(sessionA!)).toBe(false);
    expect(handleProRoomFiles([new File(['stale'], 'stale.flac')])).toBe(false);
    expect(handleProRoomTrackMetadata(Q1, { name: 'Stale', title: 'Stale' })).toBe(false);
    expect(handleProRoomTrackRemoval([Q1])).toBe(false);
    expect(resolveProRoomPlaylistFile(Q1)).toBeNull();
    expect(handleProRoomYouTubeForSession(sessionA!, item, 'https://youtube.test/stale')).toBe(
      false,
    );
    expect(
      handleProRoomTrackMetadataForSession(sessionA!, Q1, {
        name: 'Stale async title',
        title: 'Stale async title',
      }),
    ).toBe(false);
    expect(addFiles).not.toHaveBeenCalled();
    expect(addYouTube).not.toHaveBeenCalled();
    expect(updateTrackMetadata).not.toHaveBeenCalled();
    expect(removeTracks).not.toHaveBeenCalled();
    expect(resolveFile).not.toHaveBeenCalled();

    expect(renewProRoomMediaHookSession(renewal)).toBe(true);
    const sessionB = captureProRoomMediaHookSession();
    expect(sessionB).not.toBeNull();
    expect(sessionB).not.toBe(sessionA);
    expect(isProRoomMediaHookSessionCurrent(sessionB!)).toBe(true);

    // A stale async tail retains session A and cannot borrow the same hook
    // implementation after account B renews it.
    expect(handleProRoomYouTubeForSession(sessionA!, item, 'https://youtube.test/a')).toBe(false);
    expect(addYouTube).not.toHaveBeenCalled();
    expect(handleProRoomYouTubeForSession(sessionB!, item, 'https://youtube.test/b')).toBe(true);
    expect(addYouTube).toHaveBeenCalledOnce();
    expect(resolveProRoomPlaylistFile(Q1)).toBe(resolved);
  });

  it('lets only the latest account transition renew preserved hooks', () => {
    const mediaHooks = hooks({});
    registerProRoomMediaHooks(mediaHooks);
    const sessionA = captureProRoomMediaHookSession();
    const staleRenewal = invalidateProRoomMediaHookSession();
    const currentRenewal = invalidateProRoomMediaHookSession();

    expect(sessionA?.signal.aborted).toBe(true);
    expect(renewProRoomMediaHookSession(staleRenewal)).toBe(false);
    expect(captureProRoomMediaHookSession()).toBeNull();
    expect(renewProRoomMediaHookSession(currentRenewal)).toBe(true);
    const sessionB = captureProRoomMediaHookSession();
    expect(sessionB).not.toBeNull();
    expect(sessionB).not.toBe(sessionA);
    expect(renewProRoomMediaHookSession(currentRenewal)).toBe(false);
    expect(captureProRoomMediaHookSession()).toBe(sessionB);
  });

  it('removes preserved hooks and pending renewal authority on register null', () => {
    const addYouTube = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
    registerProRoomMediaHooks(hooks({ addYouTube }));
    const renewal = invalidateProRoomMediaHookSession();

    registerProRoomMediaHooks(null);

    expect(renewProRoomMediaHookSession(renewal)).toBe(false);
    expect(invalidateProRoomMediaHookSession()).toBeNull();
    expect(captureProRoomMediaHookSession()).toBeNull();
    expect(addYouTube).not.toHaveBeenCalled();
  });

  it('does not let a stale renewal disturb a newly registered runtime', () => {
    registerProRoomMediaHooks(hooks({}));
    const staleRenewal = invalidateProRoomMediaHookSession();
    const replacementHooks = hooks({});

    registerProRoomMediaHooks(replacementHooks);
    const replacementSession = captureProRoomMediaHookSession();

    expect(replacementSession).not.toBeNull();
    expect(renewProRoomMediaHookSession(staleRenewal)).toBe(false);
    expect(captureProRoomMediaHookSession()).toBe(replacementSession);
    expect(isProRoomMediaHookSessionCurrent(replacementSession!)).toBe(true);
  });

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
