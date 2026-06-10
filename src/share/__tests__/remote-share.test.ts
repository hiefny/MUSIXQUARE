/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { MSG } from '../../core/constants.ts';
import { DEMO_TRACK } from '../../demo/tracks.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection, RemoteFileSharePayload } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  downloadRemoteFile: vi.fn(),
  transition: vi.fn(),
}));

vi.mock('../remote-download.ts', () => ({
  downloadRemoteFile: mocks.downloadRemoteFile,
}));

vi.mock('../remote-upload.ts', () => ({
  uploadRemoteFile: vi.fn(),
}));

vi.mock('../r2-client.ts', () => ({
  isRemoteShareConfigured: vi.fn(() => true),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  isRemoteGuest: vi.fn(() => true),
  safeSend: vi.fn(),
  waitForGuestConnectionType: vi.fn(async () => 'remote'),
}));

vi.mock('../../player/lifecycle.ts', () => ({
  transition: mocks.transition,
}));

vi.mock('../../ui/toast.ts', () => ({
  showLoader: vi.fn(),
  showToast: vi.fn(),
  updateLoader: vi.fn(),
}));

vi.mock('../../chat/protocol.ts', () => ({
  sendSystemNotice: vi.fn(),
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../core/log.ts', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const conn = { open: true, peer: 'host-1' } as DataConnection;

function descriptor(overrides: Partial<RemoteFileSharePayload> = {}): RemoteFileSharePayload {
  return {
    roomId: 'room',
    objectId: 'object-1',
    keyB64: 'a2V5',
    ivB64: 'aXY=',
    name: 'song.mp3',
    mime: 'audio/mpeg',
    size: 4,
    encryptedSize: 4,
    index: 0,
    sessionId: 7,
    expiresAt: Date.now() + 300_000,
    ...overrides,
  };
}

describe('remote file share policy', () => {
  beforeEach(async () => {
    resetState();
    vi.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:remote-file'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    mocks.downloadRemoteFile.mockResolvedValue(
      new File(['data'], 'song.mp3', { type: 'audio/mpeg' }),
    );
    setState('network.hostConn', conn);
    setState('network.connectionType', 'remote');

    const { initRemoteShare } = await import('../remote-share.ts');
    initRemoteShare();
  });

  it('ignores legacy remote preload descriptors', async () => {
    const { handleData } = await import('../../network/protocol.ts');

    await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor({ preload: true }) }, conn);

    expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it('ignores demo descriptors because remote guests use the HTTP demo path', async () => {
    const { handleData } = await import('../../network/protocol.ts');

    await handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ name: DEMO_TRACK.fileName }) },
      conn,
    );

    expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it('accepts the active remote descriptor while currently in YouTube playback', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    setPlaybackYouTubePlaying();

    await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor() }, conn);

    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(mocks.transition).toHaveBeenCalledWith({ type: 'PRELOAD_FILE_READY', index: 0 });
  });

  // EXT-4 (external review 2026-06-11): a same-object descriptor under a NEW
  // playback context (duplicate playlist entry / host re-click rebases the
  // cached descriptor to a new index/sessionId) must keep the in-flight
  // download (same bytes) but completion must publish the LATEST context —
  // dropping it wholesale published the original index/sessionId, leaving
  // the guest on a stale track identity plus a spurious wait-timeout toast.
  it('publishes the latest context when a same-object descriptor arrives mid-download', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { getState } = await import('../../core/state.ts');
    const { bus } = await import('../../core/events.ts');

    let resolveDownload!: (file: File) => void;
    mocks.downloadRemoteFile.mockImplementation(
      () =>
        new Promise<File>((resolve) => {
          resolveDownload = resolve;
        }),
    );
    const usePreloaded = vi.fn();
    bus.on('storage:use-preloaded', usePreloaded);

    const first = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ index: 3, sessionId: 7 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());

    // Same objectId, rebased context — must dedup the download, not the context.
    await handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ index: 0, sessionId: 9 }) },
      conn,
    );
    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    // Wait machinery re-pointed to the new context.
    expect(getState('playback.pendingRecoveryTarget')).toMatchObject({ index: 0 });
    expect(getState('playlist.currentTrackIndex')).toBe(0);

    resolveDownload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await first;

    expect(getState('preload.meta')).toMatchObject({ index: 0, sessionId: 9 });
    expect(getState('preload.nextTrackIndex')).toBe(0);
    expect(mocks.transition).toHaveBeenCalledWith({ type: 'PRELOAD_FILE_READY', index: 0 });
    expect(usePreloaded).toHaveBeenCalledWith(0, 'song.mp3');
  });

  // EXT-5 (external review 2026-06-11, EXT-4 follow-up): a LATE same-object
  // descriptor can carry a composed-stale context — the host answers a stale
  // REQUEST_CURRENT_FILE with (current sessionId, requested OLD index)
  // because findMatchingBlob name-matches across indices and targeted sends
  // bypass the broadcast-only stale-track guard. The re-point must adopt
  // only a STRICTLY NEWER sessionId, never rewind to an equal/older context.
  it('does not rewind the wait when a late same-object descriptor carries a non-newer context', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { getState } = await import('../../core/state.ts');

    let resolveDownload!: (file: File) => void;
    mocks.downloadRemoteFile.mockImplementation(
      () =>
        new Promise<File>((resolve) => {
          resolveDownload = resolve;
        }),
    );

    // Active download for the CURRENT context: index 1, sessionId 9.
    const first = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ index: 1, sessionId: 9 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());

    // Late composed-stale response: same object, same (current) sessionId,
    // stale index 0. Must be pure-deduped — no context rewind.
    await handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ index: 0, sessionId: 9 }) },
      conn,
    );
    // Genuinely old descriptor (older sessionId) — also ignored.
    await handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ index: 0, sessionId: 7 }) },
      conn,
    );

    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(getState('playback.pendingRecoveryTarget')).toMatchObject({ index: 1 });
    expect(getState('playlist.currentTrackIndex')).toBe(1);

    resolveDownload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await first;

    expect(getState('preload.meta')).toMatchObject({ index: 1, sessionId: 9 });
    expect(getState('preload.nextTrackIndex')).toBe(1);
    expect(mocks.transition).toHaveBeenCalledWith({ type: 'PRELOAD_FILE_READY', index: 1 });
    expect(mocks.transition).not.toHaveBeenCalledWith({ type: 'PRELOAD_FILE_READY', index: 0 });
  });

  it('still dedups an identical re-sent descriptor without disturbing the wait', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { getState } = await import('../../core/state.ts');

    let resolveDownload!: (file: File) => void;
    mocks.downloadRemoteFile.mockImplementation(
      () =>
        new Promise<File>((resolve) => {
          resolveDownload = resolve;
        }),
    );

    const first = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ index: 3, sessionId: 7 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());

    // Identical context re-send (e.g. REQUEST_CURRENT_FILE response racing
    // the original broadcast) — pure dedup, single download, same publish.
    await handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ index: 3, sessionId: 7 }) },
      conn,
    );
    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();

    resolveDownload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await first;

    expect(getState('preload.meta')).toMatchObject({ index: 3, sessionId: 7 });
    expect(mocks.transition).toHaveBeenCalledWith({ type: 'PRELOAD_FILE_READY', index: 3 });
  });
});
