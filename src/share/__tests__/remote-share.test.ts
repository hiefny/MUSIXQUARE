/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { DEMO_TRACK } from '../../demo/tracks.ts';
import { setPlaybackFilePlaying, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type {
  ConnectedPeer,
  DataConnection,
  PlaylistItem,
  RemoteFileSharePayload,
} from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  downloadRemoteFile: vi.fn(),
  uploadRemoteFile: vi.fn(),
  transition: vi.fn(),
}));

vi.mock('../remote-download.ts', () => ({
  downloadRemoteFile: mocks.downloadRemoteFile,
}));

vi.mock('../remote-upload.ts', () => ({
  uploadRemoteFile: mocks.uploadRemoteFile,
}));

vi.mock('../r2-client.ts', () => ({
  isRemoteShareConfigured: vi.fn(() => true),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  isRemoteGuest: vi.fn(() => true),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
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
  broadcastSystemMessage: vi.fn(),
  sendSystemMessage: vi.fn(),
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

function dataConnection(peer: string, send = vi.fn()): DataConnection {
  return {
    open: true,
    peer,
    send,
    close: vi.fn(),
    on: () => undefined,
  };
}

const conn = dataConnection('host-1');
const OBJECT_1 = '00000000-0000-4000-8000-000000000001';
const OBJECT_2 = '00000000-0000-4000-8000-000000000002';
const OBJECT_A = '00000000-0000-4000-8000-00000000000a';
const OBJECT_B = '00000000-0000-4000-8000-00000000000b';
const Q0 = '10000000-0000-4000-8000-000000000001';
const Q1 = '10000000-0000-4000-8000-000000000002';
const Q2 = '10000000-0000-4000-8000-000000000003';
const Q3 = '10000000-0000-4000-8000-000000000004';

function descriptor(overrides: Partial<RemoteFileSharePayload> = {}): RemoteFileSharePayload {
  return {
    roomId: '123456',
    objectId: OBJECT_1,
    downloadUrl: `https://share.musixquare.com/download/123456/${OBJECT_1}`,
    storageFormat: 'whole-v1',
    storedSize: 4,
    downloadToken: `eyJ2IjoxLCJraW5kIjoid2hvbGUtZG93bmxvYWQifQ.${'a'.repeat(43)}`,
    name: 'song.mp3',
    mime: 'audio/mpeg',
    size: 4,
    queueItemId: Q0,
    sessionId: 7,
    expiresAt: Date.now() + 300_000,
    ...overrides,
  };
}

describe('remote file share policy', () => {
  beforeEach(async () => {
    resetState();
    const { resetStoredFileAdmissionsForTests } = await import('../../storage/storage.ts');
    resetStoredFileAdmissionsForTests();
    // Session boundary: resets module-local remote-share state (adopted
    // context gate, active download) registered by prior initRemoteShare
    // calls — module state would otherwise leak across tests.
    const { bus } = await import('../../core/events.ts');
    bus.emit('state:network.sessionCode', null, 'network.sessionCode');
    bus.clear();
    const { resetFileRequestAuthority } = await import('../../network/file-request-authority.ts');
    resetFileRequestAuthority();
    const { resetInboundRateLimit } = await import('../../network/protocol.ts');
    resetInboundRateLimit(conn.peer);
    vi.clearAllMocks();
    const { isRemoteGuest, waitForGuestConnectionType } = await import('../../network/peer.ts');
    vi.mocked(isRemoteGuest).mockReturnValue(true);
    vi.mocked(waitForGuestConnectionType).mockReset();
    vi.mocked(waitForGuestConnectionType).mockResolvedValue('remote');
    // Keep the lifecycle spy observable while preserving the production state
    // changes that remote-share's completion ownership checks depend on.
    mocks.transition.mockImplementation((event: { type: string; variant?: string }) => {
      if (event.type === 'FILE_PREPARE' && event.variant === 'preload-waiting') {
        setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
      } else if (
        event.type === 'PRELOAD_FILE_READY' ||
        (event.type === 'FILE_PREPARE' && event.variant === 'preload-match')
      ) {
        setState('playback.lifecycle', PLAYBACK_STATE.DECODING);
      } else if (event.type === 'REMOTE_FILE_UNAVAILABLE') {
        setState('playback.lifecycle', PLAYBACK_STATE.FAILED);
      }
      return getState('playback.lifecycle');
    });
    mocks.downloadRemoteFile.mockResolvedValue(
      new File(['data'], 'song.mp3', { type: 'audio/mpeg' }),
    );
    setState('network.hostConn', conn);
    setState('network.connectionType', 'remote');
    setState(
      'playlist.items',
      [Q0, Q1, Q2, Q3].map((queueItemId) => ({
        queueItemId,
        type: 'file' as const,
        name: 'song.mp3',
        videoId: null,
        playlistId: null,
      })),
    );
    setState('playlist.currentQueueItemId', Q0);

    const { initRemoteShare } = await import('../remote-share.ts');
    initRemoteShare();
  });

  it('downloads a user file even when its filename matches a bundled demo asset', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    mocks.downloadRemoteFile.mockResolvedValueOnce(
      new File(['user-data'], DEMO_TRACK.fileName, { type: DEMO_TRACK.mime }),
    );

    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ name: DEMO_TRACK.fileName, mime: DEMO_TRACK.mime }),
      },
      conn,
    );

    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(mocks.downloadRemoteFile.mock.calls[0]?.[0]).toMatchObject({
      queueItemId: Q0,
      name: DEMO_TRACK.fileName,
    });
  });

  it('warms an R2 preload silently without entering the current-track lifecycle', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { showLoader, showToast } = await import('../../ui/toast.ts');

    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ queueItemId: Q1, preload: true }),
      },
      conn,
    );

    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(getState('preload.ready')).toMatchObject({
      queueItemId: Q1,
      sessionId: 7,
      objectId: OBJECT_1,
    });
    expect(getState('playlist.currentQueueItemId')).toBe(Q0);
    expect(getState('share.remote').download.status).toBe('idle');
    expect(mocks.transition).not.toHaveBeenCalled();
    expect(showLoader).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not download a fresh-session preload for the current immutable object', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const current = new File(['data'], 'song.mp3', { type: 'audio/mpeg' });
    setState('files.current', {
      queueItemId: Q0,
      indexHint: 0,
      name: current.name,
      size: current.size,
      mime: current.type,
      sessionId: 7,
      objectId: OBJECT_1,
      blob: current,
    });

    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ queueItemId: Q0, sessionId: 8, preload: true }),
      },
      conn,
    );

    expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();
    expect(getState('preload.ready')).toBeNull();
    expect(getState('files.current')?.blob).toBe(current);
  });

  it('promotes the exact in-flight R2 preload without restarting its download', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    let resolveDownload!: (file: File) => void;
    mocks.downloadRemoteFile.mockImplementationOnce(
      () =>
        new Promise<File>((resolve) => {
          resolveDownload = resolve;
        }),
    );

    const preload = handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ queueItemId: Q1, preload: true }),
      },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());

    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ queueItemId: Q1 }),
      },
      conn,
    );
    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);

    resolveDownload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await preload;

    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(getState('preload.ready')).toMatchObject({
      queueItemId: Q1,
      sessionId: 7,
      objectId: OBJECT_1,
    });
    expect(mocks.transition).toHaveBeenCalledWith({
      type: 'PRELOAD_FILE_READY',
      queueItemId: Q1,
    });
  });

  it('lets PLAY_PRELOADED promote the background owner before a current descriptor arrives', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { promoteRemotePreloadWait } = await import('../remote-share.ts');
    let resolveDownload!: (file: File) => void;
    mocks.downloadRemoteFile.mockImplementationOnce(
      () =>
        new Promise<File>((resolve) => {
          resolveDownload = resolve;
        }),
    );

    const preload = handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ queueItemId: Q1, preload: true }),
      },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());

    expect(promoteRemotePreloadWait(Q1, 'song.mp3')).toBe(true);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);
    resolveDownload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await preload;

    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(getState('preload.ready')).toMatchObject({ queueItemId: Q1, sessionId: 7 });
    expect(mocks.transition).toHaveBeenCalledWith({
      type: 'PRELOAD_FILE_READY',
      queueItemId: Q1,
    });
  });

  it('keeps an almost-finished preload owned across FILE_PREPARE before PLAY_PRELOADED', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { prepareRemoteShareWait } = await import('../remote-share.ts');
    let resolveDownload!: (file: File) => void;
    mocks.downloadRemoteFile.mockImplementationOnce(
      () =>
        new Promise<File>((resolve) => {
          resolveDownload = resolve;
        }),
    );

    const preload = handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ queueItemId: Q1, preload: true }),
      },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());

    // This is the production ordering: FILE_PREPARE establishes foreground
    // intent just before PLAY_PRELOADED promotes (or consumes) the warm bytes.
    prepareRemoteShareWait(Q1, 'song.mp3', 7);
    expect(getState('preload.activeTarget')).toMatchObject({
      queueItemId: Q1,
      sessionId: 7,
      objectId: OBJECT_1,
    });

    // Completion in that exact gap must remain publishable, not be discarded
    // and fetched again from 0% by the later current-track descriptor.
    resolveDownload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await preload;
    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(getState('preload.ready')).toMatchObject({
      queueItemId: Q1,
      sessionId: 7,
      objectId: OBJECT_1,
    });
  });

  it('carries background download progress into foreground promotion', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { promoteRemotePreloadWait } = await import('../remote-share.ts');
    const { updateLoader } = await import('../../ui/toast.ts');
    let resolveDownload!: (file: File) => void;
    let reportProgress!: (fraction: number) => void;
    mocks.downloadRemoteFile.mockImplementationOnce(
      (_descriptor, onProgress: (fraction: number) => void) =>
        new Promise<File>((resolve) => {
          resolveDownload = resolve;
          reportProgress = onProgress;
        }),
    );

    const preload = handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ queueItemId: Q1, preload: true }),
      },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
    reportProgress(0.37);
    vi.mocked(updateLoader).mockClear();

    expect(promoteRemotePreloadWait(Q1, 'song.mp3')).toBe(true);
    expect(updateLoader).toHaveBeenLastCalledWith(37);
    expect(getState('share.remote').download.progress).toBe(0.37);

    reportProgress(0.6);
    expect(updateLoader).toHaveBeenLastCalledWith(60);
    expect(getState('share.remote').download.progress).toBe(0.6);
    resolveDownload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await preload;
    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
  });

  it('cancels a different speculative owner when the current track needs another object', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    let resolvePreload!: (file: File) => void;
    mocks.downloadRemoteFile.mockImplementationOnce(
      (_descriptor, _onProgress, signal: AbortSignal) =>
        new Promise<File>((resolve) => {
          resolvePreload = resolve;
          expect(signal.aborted).toBe(false);
        }),
    );

    const preload = handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ queueItemId: Q1, preload: true }),
      },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
    const preloadSignal = mocks.downloadRemoteFile.mock.calls[0]?.[2] as AbortSignal;

    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({
          objectId: OBJECT_2,
          queueItemId: Q2,
          sessionId: 8,
        }),
      },
      conn,
    );

    expect(preloadSignal.aborted).toBe(true);
    expect(mocks.downloadRemoteFile).toHaveBeenCalledTimes(2);
    expect(getState('preload.ready')).toMatchObject({
      queueItemId: Q2,
      sessionId: 8,
      objectId: OBJECT_2,
    });
    resolvePreload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await preload;
  });

  it('queues a speculative descriptor until the active current-file download releases', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { getRemotePreloadOwnershipForTests } = await import('../remote-share.ts');
    let resolveCurrent!: (file: File) => void;
    mocks.downloadRemoteFile.mockImplementationOnce(
      () =>
        new Promise<File>((resolve) => {
          resolveCurrent = resolve;
        }),
    );

    const current = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());

    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_2, queueItemId: Q1, sessionId: 8, preload: true }),
      },
      conn,
    );
    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(getState('preload.activeTarget')).toMatchObject({ queueItemId: Q0, objectId: OBJECT_1 });
    expect(getRemotePreloadOwnershipForTests()).toMatchObject({
      foregroundQueueItemId: Q0,
      deferredQueueItemId: Q1,
    });

    resolveCurrent(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await current;
    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    const currentReady = getState('preload.ready');
    expect(currentReady).toMatchObject({ queueItemId: Q0, objectId: OBJECT_1 });
    if (!currentReady) throw new Error('expected completed current resident');
    setState('files.current', currentReady);
    setState('preload.ready', null);
    setState('preload.activeTarget', null);
    setState('preload.nextQueueItemId', null);
    setState('playback.pendingRecoveryTarget', null);
    setState('playback.lifecycle', PLAYBACK_STATE.READY);
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(getState('preload.ready')).toMatchObject({
        queueItemId: Q1,
        sessionId: 8,
        objectId: OBJECT_2,
      }),
    );
  });

  it('queues the next descriptor while FILE_PREPARE is waiting for the current descriptor', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { getRemotePreloadOwnershipForTests, prepareRemoteShareWait } =
      await import('../remote-share.ts');

    prepareRemoteShareWait(Q0, 'song.mp3', 7);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);
    expect(getRemotePreloadOwnershipForTests().foregroundQueueItemId).toBeNull();

    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_2, queueItemId: Q1, sessionId: 8, preload: true }),
      },
      conn,
    );
    expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();
    expect(getState('preload.activeTarget')).toMatchObject({ queueItemId: Q0, sessionId: 7 });
    expect(getRemotePreloadOwnershipForTests()).toMatchObject({
      foregroundQueueItemId: null,
      preloadQueueItemId: null,
      deferredQueueItemId: Q1,
    });

    let resolveCurrent!: (file: File) => void;
    mocks.downloadRemoteFile.mockImplementationOnce(
      () =>
        new Promise<File>((resolve) => {
          resolveCurrent = resolve;
        }),
    );
    const current = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
    expect(getRemotePreloadOwnershipForTests()).toMatchObject({
      foregroundQueueItemId: Q0,
      deferredQueueItemId: Q1,
    });

    resolveCurrent(new File(['current'], 'song.mp3', { type: 'audio/mpeg' }));
    await current;
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(getState('preload.ready')).toMatchObject({
        queueItemId: Q1,
        sessionId: 8,
        objectId: OBJECT_2,
      }),
    );
  });

  it('uses a late preload descriptor immediately when FILE_PREPARE already selected that row', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { prepareRemoteShareWait } = await import('../remote-share.ts');

    prepareRemoteShareWait(Q1, 'song.mp3', 8);
    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_2, queueItemId: Q1, sessionId: 8, preload: true }),
      },
      conn,
    );

    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(mocks.downloadRemoteFile.mock.calls[0]?.[0]).toMatchObject({
      objectId: OBJECT_2,
      queueItemId: Q1,
      sessionId: 8,
    });
    expect(getState('preload.ready')).toMatchObject({
      objectId: OBJECT_2,
      queueItemId: Q1,
      sessionId: 8,
    });
  });

  it('lets a selected late preload supersede the previous foreground GET', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { prepareRemoteShareWait } = await import('../remote-share.ts');
    let resolveCurrent!: (file: File) => void;
    mocks.downloadRemoteFile.mockImplementationOnce(
      (_descriptor, _onProgress, signal: AbortSignal) =>
        new Promise<File>((resolve) => {
          resolveCurrent = resolve;
          expect(signal.aborted).toBe(false);
        }),
    );

    const current = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0, sessionId: 7 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
    const currentSignal = mocks.downloadRemoteFile.mock.calls[0]?.[2] as AbortSignal;

    prepareRemoteShareWait(Q1, 'song.mp3', 8);
    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_2, queueItemId: Q1, sessionId: 8, preload: true }),
      },
      conn,
    );

    expect(currentSignal.aborted).toBe(true);
    expect(mocks.downloadRemoteFile).toHaveBeenCalledTimes(2);
    expect(getState('preload.ready')).toMatchObject({ queueItemId: Q1, sessionId: 8 });
    resolveCurrent(new File(['stale'], 'song.mp3', { type: 'audio/mpeg' }));
    await current;
  });

  it('drains an R2 next-track hint after a local current-file wait completes', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { prepareRemoteShareWait } = await import('../remote-share.ts');

    prepareRemoteShareWait(Q0, 'song.mp3', 7);
    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_2, queueItemId: Q1, sessionId: 8, preload: true }),
      },
      conn,
    );
    expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();

    const localFile = new File(['local'], 'song.mp3', { type: 'audio/mpeg' });
    setState('files.current', {
      queueItemId: Q0,
      indexHint: 0,
      name: localFile.name,
      sessionId: 7,
      size: localFile.size,
      mime: localFile.type,
      blob: localFile,
    });
    setState('preload.ready', null);
    setState('preload.activeTarget', null);
    setState('playback.pendingRecoveryTarget', null);
    setState('playback.lifecycle', PLAYBACK_STATE.READY);

    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
    expect(getState('preload.ready')).toMatchObject({ queueItemId: Q1, sessionId: 8 });
  });

  it('aborts a speculative GET as soon as its queue occurrence is removed', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { getRemotePreloadOwnershipForTests } = await import('../remote-share.ts');
    const observedSignal: { current: AbortSignal | null } = { current: null };
    mocks.downloadRemoteFile.mockImplementationOnce(
      async (_descriptor, _onProgress, signal: AbortSignal) => {
        observedSignal.current = signal;
        return await new Promise<File>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Removed queue item', 'AbortError')),
            { once: true },
          );
        });
      },
    );

    const preload = handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_2, queueItemId: Q1, sessionId: 8, preload: true }),
      },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
    setState(
      'playlist.items',
      getState('playlist.items').filter((item) => item.queueItemId !== Q1),
    );

    expect(observedSignal.current?.aborted).toBe(true);
    await preload;
    expect(getRemotePreloadOwnershipForTests().preloadQueueItemId).toBeNull();
  });

  it('discards a deferred next target when a newer direct jump becomes authoritative', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { getRemotePreloadOwnershipForTests } = await import('../remote-share.ts');
    let resolveCurrent!: (file: File) => void;
    mocks.downloadRemoteFile.mockImplementationOnce(
      () =>
        new Promise<File>((resolve) => {
          resolveCurrent = resolve;
        }),
    );

    const current = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0, sessionId: 7 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_2, queueItemId: Q1, sessionId: 8, preload: true }),
      },
      conn,
    );
    expect(getRemotePreloadOwnershipForTests().deferredQueueItemId).toBe(Q1);

    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_A, queueItemId: Q2, sessionId: 9 }),
      },
      conn,
    );
    expect(getRemotePreloadOwnershipForTests().deferredQueueItemId).toBeNull();
    expect(mocks.downloadRemoteFile).toHaveBeenCalledTimes(2);

    resolveCurrent(new File(['stale'], 'song.mp3', { type: 'audio/mpeg' }));
    await current;
    await Promise.resolve();
    expect(mocks.downloadRemoteFile).toHaveBeenCalledTimes(2);
  });

  it('does not revive a deferred preload after its foreground barrier is cancelled', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { cancelRemoteShareWait, getRemotePreloadOwnershipForTests } =
      await import('../remote-share.ts');
    let resolveCurrent!: (file: File) => void;
    mocks.downloadRemoteFile.mockImplementationOnce(
      (_descriptor, _onProgress, signal: AbortSignal) =>
        new Promise<File>((resolve) => {
          resolveCurrent = resolve;
          expect(signal.aborted).toBe(false);
        }),
    );

    const current = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
    const currentSignal = mocks.downloadRemoteFile.mock.calls[0]?.[2] as AbortSignal;
    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_2, queueItemId: Q1, sessionId: 8, preload: true }),
      },
      conn,
    );
    expect(getRemotePreloadOwnershipForTests().deferredQueueItemId).toBe(Q1);

    cancelRemoteShareWait('superseded-playback-owner');
    expect(currentSignal.aborted).toBe(true);
    expect(getRemotePreloadOwnershipForTests()).toMatchObject({
      foregroundQueueItemId: null,
      deferredQueueItemId: null,
    });

    resolveCurrent(new File(['stale'], 'song.mp3', { type: 'audio/mpeg' }));
    await current;
    await Promise.resolve();
    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
  });

  it('preserves the deferred successor when removing the current queue occurrence', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { cancelRemoteShareWait, getRemotePreloadOwnershipForTests, prepareRemoteShareWait } =
      await import('../remote-share.ts');

    prepareRemoteShareWait(Q0, 'song.mp3', 7);
    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_2, queueItemId: Q1, sessionId: 8, preload: true }),
      },
      conn,
    );
    expect(getRemotePreloadOwnershipForTests().deferredQueueItemId).toBe(Q1);

    setState(
      'playlist.items',
      getState('playlist.items').filter((item) => item.queueItemId !== Q0),
    );
    setState('playlist.currentQueueItemId', Q1);
    cancelRemoteShareWait('playlist-current-removed');
    expect(getRemotePreloadOwnershipForTests().deferredQueueItemId).toBe(Q1);

    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
    expect(getState('preload.ready')).toMatchObject({ queueItemId: Q1, sessionId: 8 });
  });

  it('promotes a queued descriptor immediately when its track is selected', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { getRemotePreloadOwnershipForTests, promoteRemotePreloadWait } =
      await import('../remote-share.ts');
    let resolveCurrent!: (file: File) => void;
    mocks.downloadRemoteFile.mockImplementationOnce(
      (_descriptor, _onProgress, signal: AbortSignal) =>
        new Promise<File>((resolve) => {
          resolveCurrent = resolve;
          expect(signal.aborted).toBe(false);
        }),
    );

    const current = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
    const currentSignal = mocks.downloadRemoteFile.mock.calls[0]?.[2] as AbortSignal;
    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_2, queueItemId: Q1, sessionId: 8, preload: true }),
      },
      conn,
    );

    expect(promoteRemotePreloadWait(Q1, 'song.mp3')).toBe(true);
    expect(currentSignal.aborted).toBe(true);
    expect(getRemotePreloadOwnershipForTests()).toMatchObject({
      foregroundQueueItemId: Q1,
      deferredQueueItemId: null,
    });
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledTimes(2));

    resolveCurrent(new File(['stale'], 'song.mp3', { type: 'audio/mpeg' }));
    await current;
  });

  it('does not classify explicit R2 current and preload descriptors through a shared wait', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { waitForGuestConnectionType } = await import('../../network/peer.ts');
    setState('network.connectionType', 'unknown');
    let resolveCurrent!: (file: File) => void;
    mocks.downloadRemoteFile.mockImplementationOnce(
      () =>
        new Promise<File>((resolve) => {
          resolveCurrent = resolve;
        }),
    );

    const current = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0, delivery: 'r2' }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({
          objectId: OBJECT_2,
          queueItemId: Q1,
          sessionId: 8,
          delivery: 'r2',
          preload: true,
        }),
      },
      conn,
    );

    expect(waitForGuestConnectionType).not.toHaveBeenCalled();
    resolveCurrent(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await current;
    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    const currentReady = getState('preload.ready');
    if (!currentReady) throw new Error('expected completed current resident');
    setState('files.current', currentReady);
    setState('preload.ready', null);
    setState('preload.activeTarget', null);
    setState('preload.nextQueueItemId', null);
    setState('playback.pendingRecoveryTarget', null);
    setState('playback.lifecycle', PLAYBACK_STATE.READY);
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledTimes(2));
  });

  it('accepts only an explicitly R2-routed descriptor on a physically local guest', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { isRemoteGuest } = await import('../../network/peer.ts');
    vi.mocked(isRemoteGuest).mockReturnValue(false);
    setState('network.connectionType', 'local');

    await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor() }, conn);
    expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();

    await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor({ delivery: 'r2' }) }, conn);
    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
  });

  it('rejects a descriptor issued for a different room', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    setState('network.sessionCode', '654321');

    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ roomId: '123456', delivery: 'r2' }),
      },
      conn,
    );

    expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();
  });

  it('clears guest delivery markers when switching directly between room codes', async () => {
    const { bus } = await import('../../core/events.ts');
    const { isGuestR2FileDelivery, recordGuestFileDelivery } =
      await import('../file-delivery-policy.ts');
    recordGuestFileDelivery(Q0, 7, 'r2');
    expect(isGuestR2FileDelivery(Q0, 7)).toBe(true);

    bus.emit('state:network.sessionCode', '654321', 'network.sessionCode');

    expect(isGuestR2FileDelivery(Q0, 7)).toBe(false);
  });

  it('clears guest R2 authority and aborts its download when the host connection is replaced', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { isGuestR2FileDelivery, recordGuestFileDelivery } =
      await import('../file-delivery-policy.ts');
    const observedSignal: { current: AbortSignal | null } = { current: null };
    mocks.downloadRemoteFile.mockImplementationOnce(
      async (_descriptor, _onProgress, signal: AbortSignal) => {
        observedSignal.current = signal;
        return await new Promise<File>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Replaced host connection', 'AbortError')),
            { once: true },
          );
        });
      },
    );
    recordGuestFileDelivery(Q0, 7, 'r2');

    const pending = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ delivery: 'r2' }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());

    const replacement = dataConnection('host-2');
    setState('network.hostConn', replacement);

    expect(isGuestR2FileDelivery(Q0, 7)).toBe(false);
    expect(observedSignal.current?.aborted).toBe(true);
    await pending;
    expect(getState('share.remote').download.status).toBe('idle');
  });

  it('advertises R2 support only over the current guest host connection', async () => {
    const { bus } = await import('../../core/events.ts');
    const { safeSend } = await import('../../network/peer.ts');
    setState('network.appRole', 'guest');
    setState('network.hostConn', conn);

    bus.emit('network:peer-connected', conn);

    expect(safeSend).toHaveBeenCalledOnce();
    expect(safeSend).toHaveBeenCalledWith(conn, {
      type: MSG.FILE_R2_CAPABILITY,
      version: 1,
      localAudience: true,
    });
  });

  it('recovers only an authenticated unadvertised overflow connection after capability arrives', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { safeSend } = await import('../../network/peer.ts');
    const {
      freezeFileDeliveryMode,
      getDirectFilePeers,
      getR2FileTargets,
      getUnsupportedFileTargetsForTests,
      isLocalFileR2CapableForTests,
    } = await import('../file-delivery-policy.ts');
    setState('network.appRole', 'host');
    setState('network.hostConn', null);

    const peers = Array.from({ length: 9 }, (_, index) => {
      const id = `local-unadvertised-${index + 1}`;
      return {
        id,
        status: 'connected' as const,
        slot: index + 1,
        label: id,
        conn: dataConnection(id),
        isOp: false,
        preloadedQueueItemIds: new Set(),
        isDataTarget: true,
        connectionType: 'local' as const,
        joinOrder: index + 1,
        lastHeartbeat: 0,
      } satisfies ConnectedPeer;
    });
    const target = peers[8]!;
    setState('network.connectedPeers', peers);
    setState(
      'network.activeHostConnByPeerId',
      new Map(peers.map((peer) => [peer.id, peer.conn as DataConnection])),
    );
    expect(freezeFileDeliveryMode(11)).toBe('mixed');
    expect(getUnsupportedFileTargetsForTests(11).map((item) => item.peer)).toEqual([target.id]);

    const next = new File(['next'], 'next.flac', { type: 'audio/flac' });
    setState(
      'playlist.items',
      getState('playlist.items').map((item) =>
        item.queueItemId === Q1 ? { ...item, name: next.name, file: next } : item,
      ),
    );
    setState('preload.activeTarget', {
      queueItemId: Q1,
      indexHint: 1,
      name: next.name,
      mime: next.type,
      size: next.size,
      sessionId: 11,
    });
    setState('preload.ready', {
      queueItemId: Q1,
      indexHint: 1,
      name: next.name,
      mime: next.type,
      size: next.size,
      sessionId: 11,
      blob: next,
    });
    mocks.uploadRemoteFile.mockResolvedValueOnce(
      descriptor({ objectId: OBJECT_2, name: next.name, queueItemId: Q1, sessionId: 11 }),
    );

    await handleData(
      { type: MSG.FILE_R2_CAPABILITY, version: 1, localAudience: true },
      target.conn as DataConnection,
    );

    expect(isLocalFileR2CapableForTests(target.id)).toBe(true);
    expect(getDirectFilePeers(11)).toHaveLength(8);
    expect(getR2FileTargets(11).map((item) => item.peer)).toEqual([target.id]);
    expect(getUnsupportedFileTargetsForTests(11)).toHaveLength(0);
    expect(safeSend).toHaveBeenCalledWith(
      target.conn,
      expect.objectContaining({
        type: MSG.REMOTE_FILE_SHARE,
        queueItemId: Q1,
        sessionId: 11,
        preload: true,
      }),
    );
  });

  it('does not let a suspended stale descriptor replace a newer transfer owner', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { waitForGuestConnectionType } = await import('../../network/peer.ts');
    setState('network.connectionType', 'unknown');

    let resolveConnection!: (value: 'local' | 'remote') => void;
    vi.mocked(waitForGuestConnectionType).mockImplementationOnce(
      () => new Promise<'local' | 'remote'>((resolve) => (resolveConnection = resolve)),
    );

    const stale = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0, sessionId: 7 }) },
      conn,
    );

    setState('playlist.currentQueueItemId', Q1);
    setState('playback.pendingRecoveryTarget', {
      queueItemId: Q1,
      indexHint: 1,
      name: 'newer.mp3',
    });
    setState('transfer.meta', {
      queueItemId: Q1,
      indexHint: 1,
      name: 'newer.mp3',
      sessionId: 9,
    });
    setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);

    resolveConnection('remote');
    await stale;

    expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();
    expect(getState('playlist.currentQueueItemId')).toBe(Q1);
    expect(getState('playback.pendingRecoveryTarget')?.queueItemId).toBe(Q1);
    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({ queueItemId: Q1, sessionId: 9 }),
    );
  });

  it('allows a descriptor to bootstrap when the current target stayed null', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    setState('network.connectionType', 'unknown');
    setState('playlist.currentQueueItemId', null);
    setState('playback.pendingRecoveryTarget', null);
    setState('transfer.meta', null);

    await handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0, sessionId: 7 }) },
      conn,
    );

    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(getState('playlist.currentQueueItemId')).toBe(Q0);
  });

  it('does not reject an iOS download from a predicted crypto memory peak', async () => {
    vi.useFakeTimers();
    const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone)',
    });
    try {
      const { handleData } = await import('../../network/protocol.ts');
      const { sendToHost } = await import('../../network/peer.ts');
      const { showToast } = await import('../../ui/toast.ts');
      setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
      const size = 81 * 1024 * 1024;
      await handleData(
        {
          type: MSG.REMOTE_FILE_SHARE,
          ...descriptor({ size, storedSize: size }),
        },
        conn,
      );

      expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
      expect(getState('share.remote').download.status).toBe('ready');
      expect(mocks.transition).not.toHaveBeenCalledWith({ type: 'REMOTE_FILE_UNAVAILABLE' });
      expect(sendToHost).not.toHaveBeenCalledWith({
        type: MSG.GUEST_DECODE_FAILED,
        queueItemId: Q0,
      });

      vi.mocked(showToast).mockClear();
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(showToast).not.toHaveBeenCalledWith('share.remote.timeout');
    } finally {
      vi.useRealTimers();
      if (originalUserAgent) Object.defineProperty(navigator, 'userAgent', originalUserAgent);
    }
  });

  it('starts remote XHR without waiting for a native decode lease', async () => {
    const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone)',
    });
    const { setCurrentAudioBuffer } = await import('../../player/_state.ts');
    const { reserveDecodeMemoryWithinBudget, resolveDecodeMemoryBudget } =
      await import('../../player/decode-admission.ts');
    setCurrentAudioBuffer(null);
    const budget = resolveDecodeMemoryBudget();
    const decodeLease = reserveDecodeMemoryWithinBudget(1, { budget, fileName: 'old.mp3' });

    try {
      const { handleData } = await import('../../network/protocol.ts');
      setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
      const size = 80 * 1024 * 1024;
      const pending = handleData(
        {
          type: MSG.REMOTE_FILE_SHARE,
          ...descriptor({ size, storedSize: size }),
        },
        conn,
      );

      await Promise.resolve();
      expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();

      await pending;
      expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
      expect(getState('share.remote').download.status).toBe('ready');
    } finally {
      decodeLease.release();
      if (originalUserAgent) Object.defineProperty(navigator, 'userAgent', originalUserAgent);
    }
  });

  it('does not apply the room wait deadline to a progressing remote XHR', async () => {
    vi.useFakeTimers();
    try {
      const { handleData } = await import('../../network/protocol.ts');
      const { showToast } = await import('../../ui/toast.ts');
      setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
      let resolveDownload!: (file: File) => void;
      mocks.downloadRemoteFile.mockImplementationOnce(
        () =>
          new Promise<File>((resolve) => {
            resolveDownload = resolve;
          }),
      );

      const pending = handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor() }, conn);
      await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(6 * 60_000);

      expect(showToast).not.toHaveBeenCalledWith('share.remote.timeout');
      expect(mocks.transition).not.toHaveBeenCalledWith({ type: 'REMOTE_FILE_UNAVAILABLE' });

      resolveDownload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
      await pending;
      expect(getState('share.remote').download.status).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the remote wait immediately after a terminal download failure', async () => {
    vi.useFakeTimers();
    try {
      const { handleData } = await import('../../network/protocol.ts');
      const { showToast } = await import('../../ui/toast.ts');
      setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
      mocks.downloadRemoteFile.mockRejectedValueOnce(
        new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH'),
      );

      await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor() }, conn);

      expect(getState('share.remote').download.status).toBe('error');
      expect(mocks.transition).toHaveBeenCalledWith({ type: 'REMOTE_FILE_UNAVAILABLE' });
      vi.mocked(showToast).mockClear();
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(showToast).not.toHaveBeenCalledWith('share.remote.timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a superseded download failure detach its successor', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);

    let rejectSuccessor!: (error: Error) => void;
    mocks.downloadRemoteFile
      .mockImplementationOnce(
        (_descriptor, _onProgress, signal: AbortSignal) =>
          new Promise<File>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('superseded', 'AbortError')),
              { once: true },
            );
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<File>((_resolve, reject) => {
            rejectSuccessor = reject;
          }),
      );

    const predecessor = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ objectId: OBJECT_1 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
    const successor = handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_2, queueItemId: Q1, sessionId: 8 }),
      },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledTimes(2));
    await predecessor;

    mocks.transition.mockClear();
    rejectSuccessor(new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH'));
    await successor;

    expect(getState('share.remote').download.status).toBe('error');
    expect(mocks.transition).toHaveBeenCalledWith({ type: 'REMOTE_FILE_UNAVAILABLE' });
  });

  it('does not let a cancelled same-object predecessor detach its retry successor', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { cancelRemoteShareWait } = await import('../remote-share.ts');
    setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);

    let rejectPredecessor!: (error: Error) => void;
    let rejectSuccessor!: (error: Error) => void;
    mocks.downloadRemoteFile
      .mockImplementationOnce(
        () =>
          new Promise<File>((_resolve, reject) => {
            rejectPredecessor = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<File>((_resolve, reject) => {
            rejectSuccessor = reject;
          }),
      );

    const predecessor = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ objectId: OBJECT_1 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());

    // Cancellation clears the active slot immediately even though the browser
    // operation may settle later. A retry for the same R2 object can therefore
    // become the new owner before the predecessor's Promise rejects.
    cancelRemoteShareWait('same-object-retry');
    setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
    const successor = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ objectId: OBJECT_1 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledTimes(2));

    rejectPredecessor(new DOMException('cancelled', 'AbortError'));
    await predecessor;

    mocks.transition.mockClear();
    rejectSuccessor(new Error('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH'));
    await successor;

    expect(getState('share.remote').download.status).toBe('error');
    expect(mocks.transition).toHaveBeenCalledWith({ type: 'REMOTE_FILE_UNAVAILABLE' });
  });

  it('accepts the active remote descriptor while currently in YouTube playback', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    setPlaybackYouTubePlaying();

    await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor() }, conn);

    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(mocks.transition).toHaveBeenCalledWith({ type: 'PRELOAD_FILE_READY', queueItemId: Q0 });
  });

  it('does not treat same-name/size bytes from another R2 object as already loaded', async () => {
    const { handleData } = await import('../../network/protocol.ts');

    const current = new File(['data'], 'song.mp3', { type: 'audio/mpeg' });
    setState('files.current', {
      queueItemId: Q0,
      indexHint: 0,
      name: 'song.mp3',
      size: 4,
      mime: 'audio/mpeg',
      sessionId: 7,
      objectId: 'different-object',
      blob: current,
    });

    await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor() }, conn);

    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
  });

  it('does not promote a same-name/size preload from another R2 object', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { getState } = await import('../../core/state.ts');

    const preloaded = new File(['data'], 'song.mp3', { type: 'audio/mpeg' });
    setState('preload.ready', {
      queueItemId: Q0,
      indexHint: 0,
      name: 'song.mp3',
      size: 4,
      mime: 'audio/mpeg',
      sessionId: 7,
      objectId: 'different-object',
      blob: preloaded,
    });

    await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor() }, conn);

    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(getState('preload.activeTarget')).toMatchObject({ objectId: OBJECT_1 });
  });

  it('does not let synchronous preload activation clear a successor request', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { bus } = await import('../../core/events.ts');
    const { beginFileRequest, getCurrentFileRequestOwnerForTests } =
      await import('../../network/file-request-authority.ts');
    const preloaded = new File(['data'], 'song.mp3', { type: 'audio/mpeg' });
    setState('preload.ready', {
      queueItemId: Q0,
      indexHint: 0,
      name: 'song.mp3',
      size: 4,
      mime: 'audio/mpeg',
      sessionId: 7,
      objectId: OBJECT_1,
      blob: preloaded,
    });
    beginFileRequest(conn, Q0, 7);
    let successor: ReturnType<typeof beginFileRequest> | null = null;
    const unsubscribe = bus.on('storage:use-preloaded', () => {
      successor = beginFileRequest(conn, Q0, 7);
    });

    try {
      await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor() }, conn);
    } finally {
      unsubscribe();
    }

    expect(successor).not.toBeNull();
    expect(getCurrentFileRequestOwnerForTests()).toBe(successor);
  });

  it('releases an active remote-share wait when the host reports the file unavailable', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { getState } = await import('../../core/state.ts');
    const { showToast } = await import('../../ui/toast.ts');

    setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
    setState('playback.pendingRecoveryTarget', {
      queueItemId: Q2,
      indexHint: 2,
      name: 'missing.mp3',
    });
    setState('transfer.meta', {
      queueItemId: Q2,
      indexHint: 2,
      name: 'missing.mp3',
      sessionId: 11,
    });

    await handleData(
      {
        type: MSG.REMOTE_FILE_UNAVAILABLE,
        name: 'missing.mp3',
        queueItemId: Q2,
        sessionId: 11,
      },
      conn,
    );

    expect(showToast).toHaveBeenCalledWith('chat.remote_upload_failed_system_message');
    expect(getState('share.remote').download).toMatchObject({
      status: 'error',
      progress: 0,
      error: 'chat.remote_upload_failed_system_message',
    });
    expect(mocks.transition).toHaveBeenCalledWith({ type: 'REMOTE_FILE_UNAVAILABLE' });
  });

  it('settles only the exact pending request on a remote descriptor', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { beginFileRequest, getCurrentFileRequestOwnerForTests } =
      await import('../../network/file-request-authority.ts');

    beginFileRequest(conn, Q0, 7);
    await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor() }, conn);
    expect(getCurrentFileRequestOwnerForTests()).toBeNull();

    const successor = beginFileRequest(conn, Q1, 9);
    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_2, queueItemId: Q0, sessionId: 7 }),
      },
      conn,
    );
    expect(getCurrentFileRequestOwnerForTests()).toBe(successor);
  });

  it('does not settle an unscoped successor with a stale same-queue descriptor', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { beginFileRequest, getCurrentFileRequestOwnerForTests } =
      await import('../../network/file-request-authority.ts');

    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_1, queueItemId: Q0, sessionId: 9 }),
      },
      conn,
    );
    const successor = beginFileRequest(conn, Q0);

    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_2, queueItemId: Q0, sessionId: 7 }),
      },
      conn,
    );

    expect(getCurrentFileRequestOwnerForTests()).toBe(successor);
  });

  it('settles the exact pending request when remote bytes are unavailable', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { beginFileRequest, getCurrentFileRequestOwnerForTests } =
      await import('../../network/file-request-authority.ts');

    setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
    setState('playback.pendingRecoveryTarget', {
      queueItemId: Q2,
      indexHint: 2,
      name: 'missing.mp3',
    });
    setState('transfer.meta', {
      queueItemId: Q2,
      indexHint: 2,
      name: 'missing.mp3',
      sessionId: 11,
    });
    beginFileRequest(conn, Q2, 11);

    await handleData(
      {
        type: MSG.REMOTE_FILE_UNAVAILABLE,
        name: 'missing.mp3',
        queueItemId: Q2,
        sessionId: 11,
      },
      conn,
    );

    expect(getCurrentFileRequestOwnerForTests()).toBeNull();
  });

  it('ignores stale remote-file-unavailable notices outside the active wait context', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { beginFileRequest, getCurrentFileRequestOwnerForTests } =
      await import('../../network/file-request-authority.ts');

    setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
    setState('playback.pendingRecoveryTarget', {
      queueItemId: Q2,
      indexHint: 2,
      name: 'target.mp3',
    });
    setState('transfer.meta', { queueItemId: Q2, indexHint: 2, name: 'target.mp3', sessionId: 11 });
    const successor = beginFileRequest(conn, Q1, 11);

    await handleData(
      {
        type: MSG.REMOTE_FILE_UNAVAILABLE,
        name: 'old.mp3',
        queueItemId: Q1,
        sessionId: 11,
      },
      conn,
    );

    expect(mocks.transition).not.toHaveBeenCalledWith({ type: 'REMOTE_FILE_UNAVAILABLE' });
    expect(getCurrentFileRequestOwnerForTests()).toBe(successor);
  });

  // The same object may be rebased to a newer playback context while its bytes
  // are downloading. Deduplicate the bytes but publish the newest context.
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
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q3, sessionId: 7 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());

    // Same objectId, rebased context — must dedup the download, not the context.
    await handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0, sessionId: 9 }) },
      conn,
    );
    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    // Wait machinery re-pointed to the new context.
    expect(getState('playback.pendingRecoveryTarget')).toMatchObject({ queueItemId: Q0 });
    expect(getState('playlist.currentQueueItemId')).toBe(Q0);

    resolveDownload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await first;

    expect(getState('preload.activeTarget')).toMatchObject({ queueItemId: Q0, sessionId: 9 });
    expect(getState('preload.nextQueueItemId')).toBe(Q0);
    expect(mocks.transition).toHaveBeenCalledWith({ type: 'PRELOAD_FILE_READY', queueItemId: Q0 });
    expect(usePreloaded).toHaveBeenCalledWith(Q0, 'song.mp3', 9);
  });

  it('rebinds an in-flight same-qid/object download to only the newer session', async () => {
    const { handleData } = await import('../../network/protocol.ts');
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
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0, sessionId: 7 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());

    await handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0, sessionId: 9 }) },
      conn,
    );

    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(getState('preload.activeTarget')).toMatchObject({
      queueItemId: Q0,
      sessionId: 9,
      objectId: OBJECT_1,
    });
    expect(getState('transfer.meta')).toMatchObject({ queueItemId: Q0, sessionId: 9 });

    resolveDownload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await first;

    expect(getState('preload.ready')).toMatchObject({
      queueItemId: Q0,
      sessionId: 9,
      objectId: OBJECT_1,
    });
    expect(usePreloaded).toHaveBeenCalledTimes(1);
    expect(usePreloaded).toHaveBeenCalledWith(Q0, 'song.mp3', 9);
    expect(usePreloaded).not.toHaveBeenCalledWith(Q0, 'song.mp3', 7);
  });

  // A targeted response may pair the current sessionId with an older requested
  // queue occurrence. Same-object re-pointing requires a strictly newer session.
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

    // Active download for the CURRENT context: Q1, sessionId 9.
    const first = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q1, sessionId: 9 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());

    // Late composed-stale response: same object, same (current) sessionId,
    // stale Q0 occurrence. It must be pure-deduped with no context rewind.
    await handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0, sessionId: 9 }) },
      conn,
    );
    // Genuinely old descriptor (older sessionId) — also ignored.
    await handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0, sessionId: 7 }) },
      conn,
    );

    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
    expect(getState('playback.pendingRecoveryTarget')).toMatchObject({ queueItemId: Q1 });
    expect(getState('playlist.currentQueueItemId')).toBe(Q1);

    resolveDownload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await first;

    expect(getState('preload.activeTarget')).toMatchObject({ queueItemId: Q1, sessionId: 9 });
    expect(getState('preload.nextQueueItemId')).toBe(Q1);
    expect(mocks.transition).toHaveBeenCalledWith({ type: 'PRELOAD_FILE_READY', queueItemId: Q1 });
    expect(mocks.transition).not.toHaveBeenCalledWith({
      type: 'PRELOAD_FILE_READY',
      queueItemId: Q0,
    });
  });

  // The monotonic context gate must outlive the download because control
  // responses and R2 completion are independently ordered.
  it('ignores a stale same-object descriptor arriving after the download completed', async () => {
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
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q1, sessionId: 9 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
    resolveDownload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await first; // download done, _activeDownload cleared

    // Late composed-stale responses — same object, non-newer context.
    await handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0, sessionId: 9 }) },
      conn,
    );
    await handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0, sessionId: 7 }) },
      conn,
    );

    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce(); // no re-download
    expect(getState('playback.pendingRecoveryTarget')).toMatchObject({ queueItemId: Q1 });
    expect(getState('playlist.currentQueueItemId')).toBe(Q1);
    expect(getState('preload.activeTarget')).toMatchObject({ queueItemId: Q1, sessionId: 9 });
    expect(mocks.transition).not.toHaveBeenCalledWith({
      type: 'PRELOAD_FILE_READY',
      queueItemId: Q0,
    });
  });

  // Recovery may re-upload the same playback context as a new R2 object after
  // descriptor expiry, so the retry exemption cannot depend on objectId.
  it('accepts a re-issued object for the same playback context (host cache expired)', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    const { getState } = await import('../../core/state.ts');

    let resolveDownload!: (file: File) => void;
    let rejectDownload!: (err: unknown) => void;
    mocks.downloadRemoteFile.mockImplementation(
      () =>
        new Promise<File>((resolve, reject) => {
          resolveDownload = resolve;
          rejectDownload = reject;
        }),
    );

    // Adopt the context, then fail before retaining a blob so recovery must
    // fetch the replacement object rather than use the promotion fast path.
    const first = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q1, sessionId: 9 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
    rejectDownload(new Error('REMOTE_SHARE_DOWNLOAD_EXPIRED'));
    await first;

    // Composed-stale under the new object: different queue occurrence, same sid.
    // still blocked (rewind protection must not regress).
    await handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_2, queueItemId: Q0, sessionId: 9 }),
      },
      conn,
    );
    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();

    // Legit recovery re-issue: same context {Q1, sid 9}, new objectId.
    const second = handleData(
      {
        type: MSG.REMOTE_FILE_SHARE,
        ...descriptor({ objectId: OBJECT_2, queueItemId: Q1, sessionId: 9 }),
      },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledTimes(2));
    const reissued = new File(['newB'], 'song.mp3', { type: 'audio/mpeg' });
    resolveDownload(reissued);
    await second;

    expect(getState('preload.ready')?.blob).toBe(reissued);
    expect(getState('preload.activeTarget')).toMatchObject({ queueItemId: Q1, sessionId: 9 });
    expect(getState('playback.pendingRecoveryTarget')).toMatchObject({ queueItemId: Q1 });
  });

  it('still accepts a genuinely newer same-object context after the download completed', async () => {
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
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q1, sessionId: 9 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());
    resolveDownload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await first;

    // Host re-selected the duplicate entry — strictly newer sessionId.
    const second = handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q0, sessionId: 10 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledTimes(2));
    expect(getState('playback.pendingRecoveryTarget')).toMatchObject({ queueItemId: Q0 });
    resolveDownload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await second;

    expect(getState('preload.activeTarget')).toMatchObject({ queueItemId: Q0, sessionId: 10 });
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
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q3, sessionId: 7 }) },
      conn,
    );
    await vi.waitFor(() => expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce());

    // Identical context re-send (e.g. REQUEST_CURRENT_FILE response racing
    // the original broadcast) — pure dedup, single download, same publish.
    await handleData(
      { type: MSG.REMOTE_FILE_SHARE, ...descriptor({ queueItemId: Q3, sessionId: 7 }) },
      conn,
    );
    expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();

    resolveDownload(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
    await first;

    expect(getState('preload.activeTarget')).toMatchObject({ queueItemId: Q3, sessionId: 7 });
    expect(mocks.transition).toHaveBeenCalledWith({ type: 'PRELOAD_FILE_READY', queueItemId: Q3 });
  });

  it('retries one no-progress download stall as a transient transport failure', async () => {
    const { handleData } = await import('../../network/protocol.ts');
    mocks.downloadRemoteFile
      .mockRejectedValueOnce(new Error('REMOTE_SHARE_DOWNLOAD_STALLED'))
      .mockResolvedValueOnce(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));

    await handleData({ type: MSG.REMOTE_FILE_SHARE, ...descriptor() }, conn);

    expect(mocks.downloadRemoteFile).toHaveBeenCalledTimes(2);
    expect(getState('preload.activeTarget')).toMatchObject({ objectId: OBJECT_1, sessionId: 7 });
  });
});

// Uploads may finish after navigation to warm the descriptor cache and serve
// shared recovery waiters. Completion-time target, identity, and ownership
// gates decide whether the descriptor may still be broadcast.
describe('host-side completion-time broadcast gate (HET-3)', () => {
  function remotePeer(): ConnectedPeer {
    return {
      id: 'guest-remote-1',
      slot: 1,
      label: 'Guest 1',
      conn: { open: true, peer: 'guest-remote-1' } as DataConnection,
      isOp: false,
      preloadedQueueItemIds: new Set<string>(),
      status: 'connected',
      isDataTarget: true,
      joinOrder: 1,
      connectionType: 'remote',
      lastHeartbeat: Date.now(),
    };
  }

  function localPeer(): ConnectedPeer {
    return {
      id: 'guest-local-1',
      slot: 2,
      label: 'Guest 2',
      conn: { open: true, peer: 'guest-local-1' } as DataConnection,
      isOp: false,
      preloadedQueueItemIds: new Set<string>(),
      status: 'connected',
      isDataTarget: true,
      joinOrder: 2,
      connectionType: 'local',
      lastHeartbeat: Date.now(),
    };
  }

  function fileItem(file: File, queueItemId = Q0): PlaylistItem {
    return { queueItemId, type: 'file', file, name: file.name, videoId: null, playlistId: null };
  }

  function setHostFile(file: File, queueItemId: string, sessionId: number): void {
    setState('playlist.currentQueueItemId', queueItemId);
    setState('files.current', {
      queueItemId,
      indexHint: queueItemId === Q0 ? 0 : 1,
      name: file.name,
      sessionId,
      size: file.size,
      mime: file.type,
      blob: file,
    });
  }

  let resolveUpload!: (d: RemoteFileSharePayload) => void;

  beforeEach(async () => {
    resetState();
    // Session boundary: resets module-local remote-share state (upload map,
    // descriptor cache) registered by prior initRemoteShare calls — module
    // state would otherwise leak across tests.
    const { bus } = await import('../../core/events.ts');
    bus.emit('state:network.sessionCode', null, 'network.sessionCode');
    bus.clear();
    vi.clearAllMocks();

    // Host role: no hostConn, one connected remote guest as broadcast target.
    setState('network.hostConn', null);
    setState('network.connectedPeers', [remotePeer()]);

    mocks.uploadRemoteFile.mockImplementation(
      () =>
        new Promise<RemoteFileSharePayload>((resolve) => {
          resolveUpload = resolve;
        }),
    );

    const { initRemoteShare } = await import('../remote-share.ts');
    initRemoteShare();
  });

  it('never creates a second remote-share object for PRO room media', async () => {
    const { shareRemoteFileIfNeeded } = await import('../remote-share.ts');
    const file = new File(['canonical-r2'], 'persistent.flac', { type: 'audio/flac' });
    setState('playlist.items', [fileItem(file, Q0)]);
    setHostFile(file, Q0, 7);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'coordinator',
      coordinatorId: 'local-device',
      epoch: 5,
      snapshotRevision: 9,
      capabilities: ['playback.control'],
    });

    await shareRemoteFileIfNeeded(file, 7, undefined, { queueItemId: Q0 });

    expect(mocks.uploadRemoteFile).not.toHaveBeenCalled();
  });

  it('announces room storage exhaustion as a gray system message', async () => {
    const { shareRemoteFileIfNeeded } = await import('../remote-share.ts');
    const { broadcastSystemMessage, sendSystemMessage } = await import('../../chat/protocol.ts');
    const { safeSend } = await import('../../network/peer.ts');
    const file = new File(['aaaa'], 'track-a.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [fileItem(file, Q0)]);
    setHostFile(file, Q0, 7);
    const directLocalPeer = localPeer();
    setState('network.connectedPeers', [remotePeer(), directLocalPeer]);
    mocks.uploadRemoteFile.mockRejectedValueOnce(new Error('REMOTE_SHARE_SESSION_HTTP_409'));

    await shareRemoteFileIfNeeded(file, 7, undefined, { queueItemId: Q0 });

    expect(broadcastSystemMessage).toHaveBeenCalledWith('chat.remote_storage_quota_system_message');
    expect(sendSystemMessage).not.toHaveBeenCalled();
    expect(safeSend).toHaveBeenCalledWith(
      expect.objectContaining({ peer: 'guest-remote-1' }),
      expect.objectContaining({ type: MSG.REMOTE_FILE_UNAVAILABLE, limited: true }),
    );
    expect(safeSend).not.toHaveBeenCalledWith(
      directLocalPeer.conn,
      expect.objectContaining({ type: MSG.REMOTE_FILE_UNAVAILABLE }),
    );
    expect(getState('share.remote').upload.error).toBe('share.remote.quota_reached');
  });

  it('shows a friendly network error when the room quota check is temporarily unavailable', async () => {
    const { shareRemoteFileIfNeeded } = await import('../remote-share.ts');
    const file = new File(['aaaa'], 'track-a.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [fileItem(file, Q0)]);
    setHostFile(file, Q0, 7);
    mocks.uploadRemoteFile.mockRejectedValueOnce(new Error('REMOTE_SHARE_SESSION_HTTP_503'));

    await shareRemoteFileIfNeeded(file, 7, undefined, { queueItemId: Q0 });

    expect(getState('share.remote').upload.error).toBe('share.remote.network_error');
  });

  it('uploads the next R2 file silently and reuses that object when it becomes current', async () => {
    const { preloadRemoteFileIfNeeded, shareRemoteFileIfNeeded } =
      await import('../remote-share.ts');
    const { safeSend } = await import('../../network/peer.ts');
    const { showLoader, showToast } = await import('../../ui/toast.ts');

    const current = new File(['aaaa'], 'current.mp3', { type: 'audio/mpeg' });
    const next = new File(['bbbb'], 'next.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [fileItem(current, Q0), fileItem(next, Q1)]);
    setHostFile(current, Q0, 6);
    setState('preload.activeTarget', {
      queueItemId: Q1,
      indexHint: 1,
      name: next.name,
      mime: next.type,
      size: next.size,
      sessionId: 7,
    });
    setState('preload.ready', {
      queueItemId: Q1,
      indexHint: 1,
      name: next.name,
      mime: next.type,
      size: next.size,
      sessionId: 7,
      blob: next,
    });

    const preload = preloadRemoteFileIfNeeded(next, 7, Q1);
    await vi.waitFor(() => expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce());
    expect(mocks.uploadRemoteFile.mock.calls[0]?.[3]).toMatchObject({ publishState: false });
    resolveUpload(descriptor({ name: next.name, queueItemId: Q1, sessionId: 7 }));
    await preload;

    expect(safeSend).toHaveBeenCalledWith(
      expect.objectContaining({ peer: 'guest-remote-1' }),
      expect.objectContaining({
        type: MSG.REMOTE_FILE_SHARE,
        queueItemId: Q1,
        sessionId: 7,
        preload: true,
      }),
    );
    expect(showLoader).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();

    setHostFile(next, Q1, 7);
    await shareRemoteFileIfNeeded(next, 7, undefined, { queueItemId: Q1 });

    expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce();
    expect(safeSend).toHaveBeenLastCalledWith(
      expect.objectContaining({ peer: 'guest-remote-1' }),
      expect.not.objectContaining({ preload: true }),
    );
  });

  it('replays the warm descriptor after a late peer finishes route evaluation', async () => {
    const { bus } = await import('../../core/events.ts');
    const { safeSend } = await import('../../network/peer.ts');
    const next = new File(['bbbb'], 'next.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [fileItem(next, Q1)]);
    setState('preload.activeTarget', {
      queueItemId: Q1,
      indexHint: 0,
      name: next.name,
      mime: next.type,
      size: next.size,
      sessionId: 7,
    });
    setState('preload.ready', {
      queueItemId: Q1,
      indexHint: 0,
      name: next.name,
      mime: next.type,
      size: next.size,
      sessionId: 7,
      blob: next,
    });

    bus.emit('orchestrator:peer-evaluated', 'guest-remote-1');
    await vi.waitFor(() => expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce());
    resolveUpload(descriptor({ name: next.name, queueItemId: Q1, sessionId: 7 }));
    await vi.waitFor(() =>
      expect(safeSend).toHaveBeenCalledWith(
        expect.objectContaining({ peer: 'guest-remote-1' }),
        expect.objectContaining({
          type: MSG.REMOTE_FILE_SHARE,
          queueItemId: Q1,
          preload: true,
        }),
      ),
    );
  });

  it('serializes late-peer current and next descriptors so the warm GET is not aborted', async () => {
    const { bus } = await import('../../core/events.ts');
    const { safeSend } = await import('../../network/peer.ts');
    const current = new File(['aaaa'], 'current.mp3', { type: 'audio/mpeg' });
    const next = new File(['bbbb'], 'next.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [fileItem(current, Q0), fileItem(next, Q1)]);
    setHostFile(current, Q0, 7);
    setState('preload.activeTarget', {
      queueItemId: Q1,
      indexHint: 1,
      name: next.name,
      mime: next.type,
      size: next.size,
      sessionId: 8,
    });
    setState('preload.ready', {
      queueItemId: Q1,
      indexHint: 1,
      name: next.name,
      mime: next.type,
      size: next.size,
      sessionId: 8,
      blob: next,
    });

    const uploadResolvers: Array<(value: RemoteFileSharePayload) => void> = [];
    mocks.uploadRemoteFile.mockImplementation(
      () =>
        new Promise<RemoteFileSharePayload>((resolve) => {
          uploadResolvers.push(resolve);
        }),
    );

    bus.emit('orchestrator:peer-evaluated', 'guest-remote-1');
    await vi.waitFor(() => expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce());
    expect(uploadResolvers[0]).toBeDefined();
    uploadResolvers[0]!(
      descriptor({ objectId: OBJECT_1, name: current.name, queueItemId: Q0, sessionId: 7 }),
    );
    await vi.waitFor(() => expect(mocks.uploadRemoteFile).toHaveBeenCalledTimes(2));
    expect(uploadResolvers[1]).toBeDefined();
    uploadResolvers[1]!(
      descriptor({ objectId: OBJECT_2, name: next.name, queueItemId: Q1, sessionId: 8 }),
    );

    await vi.waitFor(() => {
      const descriptors = vi
        .mocked(safeSend)
        .mock.calls.map(
          (call) => call[1] as { type?: string; queueItemId?: string; preload?: true },
        )
        .filter((message) => message.type === MSG.REMOTE_FILE_SHARE);
      const firstCurrent = descriptors.findIndex((message) => message.queueItemId === Q0);
      const firstNext = descriptors.findIndex((message) => message.queueItemId === Q1);
      expect(firstCurrent).toBeGreaterThanOrEqual(0);
      expect(firstNext).toBeGreaterThan(firstCurrent);
      expect(descriptors[firstCurrent]).not.toHaveProperty('preload');
      expect(descriptors[firstNext]).toMatchObject({ queueItemId: Q1, preload: true });
    });
  });

  it('cancels a host speculative upload but preserves it once foreground playback joins', async () => {
    const { cancelRemoteFilePreload, preloadRemoteFileIfNeeded, shareRemoteFileIfNeeded } =
      await import('../remote-share.ts');
    const next = new File(['bbbb'], 'next.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [fileItem(next, Q1)]);
    setState('preload.activeTarget', {
      queueItemId: Q1,
      indexHint: 0,
      name: next.name,
      mime: next.type,
      size: next.size,
      sessionId: 7,
    });
    setState('preload.ready', {
      queueItemId: Q1,
      indexHint: 0,
      name: next.name,
      mime: next.type,
      size: next.size,
      sessionId: 7,
      blob: next,
    });

    const preload = preloadRemoteFileIfNeeded(next, 7, Q1);
    await vi.waitFor(() => expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce());
    const firstSignal = mocks.uploadRemoteFile.mock.calls[0]?.[3]?.signal as AbortSignal;
    cancelRemoteFilePreload('target-changed');
    expect(firstSignal.aborted).toBe(true);
    resolveUpload(descriptor({ name: next.name, queueItemId: Q1, sessionId: 7 }));
    await preload;

    mocks.uploadRemoteFile.mockClear();
    const secondPreload = preloadRemoteFileIfNeeded(next, 8, Q1);
    await vi.waitFor(() => expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce());
    const secondOptions = mocks.uploadRemoteFile.mock.calls[0]?.[3];
    const secondSignal = secondOptions?.signal as AbortSignal;
    setHostFile(next, Q1, 8);
    const foreground = shareRemoteFileIfNeeded(next, 8, undefined, { queueItemId: Q1 });
    secondOptions?.onStageChange?.('uploading');
    secondOptions?.onUploadProgress?.(0.42);
    expect(getState('share.remote').upload).toMatchObject({
      status: 'uploading',
      progress: 0.42,
    });
    cancelRemoteFilePreload('promoted');
    expect(secondSignal.aborted).toBe(false);
    resolveUpload(descriptor({ name: next.name, queueItemId: Q1, sessionId: 8 }));
    await Promise.all([secondPreload, foreground]);
    expect(getState('share.remote').upload).toMatchObject({ status: 'done', progress: 1 });
  });

  it('suppresses the broadcast when the host advanced past the track during the upload', async () => {
    const { shareRemoteFileIfNeeded } = await import('../remote-share.ts');
    const { broadcast, safeSend } = await import('../../network/peer.ts');

    const fileA = new File(['aaaa'], 'track-a.mp3', { type: 'audio/mpeg' });
    const fileB = new File(['bbbb'], 'track-b.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [fileItem(fileA, Q0), fileItem(fileB, Q1)]);
    setHostFile(fileA, Q0, 7);

    const share = shareRemoteFileIfNeeded(fileA, 7, undefined, { queueItemId: Q0 });
    await vi.waitFor(() => expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce());

    // Host moves to the next track mid-upload — the upload still completes
    // (no cancel by design), but the completed descriptor is stale.
    setHostFile(fileB, Q1, 8);

    resolveUpload(descriptor({ name: 'track-a.mp3', sessionId: 7, queueItemId: Q0 }));
    await share;

    expect(broadcast).not.toHaveBeenCalled();
    expect(safeSend).not.toHaveBeenCalled();
  });

  it('suppresses the broadcast when external playback owns the room at completion (HET-3)', async () => {
    const { shareRemoteFileIfNeeded } = await import('../remote-share.ts');
    const { broadcast, safeSend } = await import('../../network/peer.ts');

    const fileA = new File(['aaaa'], 'track-a.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [fileItem(fileA, Q0)]);
    setHostFile(fileA, Q0, 7);

    const share = shareRemoteFileIfNeeded(fileA, 7, undefined, { queueItemId: Q0 });
    await vi.waitFor(() => expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce());

    // Host flips file→YouTube mid-upload. The switch does NOT clear
    // The resident Blob remains published, so isHostActiveFile still passes,
    // identity — only the external-owner gate blocks this stale broadcast.
    setPlaybackYouTubePlaying();

    resolveUpload(descriptor({ name: 'track-a.mp3', sessionId: 7, queueItemId: Q0 }));
    await share;

    expect(broadcast).not.toHaveBeenCalled();
    expect(safeSend).not.toHaveBeenCalled();
  });

  it('suppresses the broadcast when no remote targets remain at completion', async () => {
    const { shareRemoteFileIfNeeded } = await import('../remote-share.ts');
    const { broadcast, safeSend } = await import('../../network/peer.ts');

    const fileA = new File(['aaaa'], 'track-a.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [fileItem(fileA, Q0)]);
    setHostFile(fileA, Q0, 7);

    const share = shareRemoteFileIfNeeded(fileA, 7, undefined, { queueItemId: Q0 });
    await vi.waitFor(() => expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce());

    // The only remote guest disconnects mid-upload (no orchestrator event in
    // this test — the completion-time re-check is the gate under test).
    setState('network.connectedPeers', []);

    resolveUpload(descriptor({ name: 'track-a.mp3', sessionId: 7, queueItemId: Q0 }));
    await share;

    expect(broadcast).not.toHaveBeenCalled();
    expect(safeSend).not.toHaveBeenCalled();
  });

  it('suppresses a targeted late-join descriptor after the host advances tracks and keeps the cached upload reusable', async () => {
    const { shareRemoteFileIfNeeded } = await import('../remote-share.ts');
    const { safeSend } = await import('../../network/peer.ts');

    const targetConn = getState('network.connectedPeers')[0]?.conn;
    if (!targetConn) throw new Error('expected remote target connection');

    const fileA = new File(['aaaa'], 'track-a.mp3', { type: 'audio/mpeg' });
    const fileB = new File(['bbbb'], 'track-b.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [fileItem(fileA, Q0), fileItem(fileB, Q1)]);
    setHostFile(fileA, Q0, 7);

    const first = shareRemoteFileIfNeeded(fileA, 7, targetConn, { queueItemId: Q0 });
    await vi.waitFor(() => expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce());

    setHostFile(fileB, Q1, 8);
    resolveUpload(descriptor({ name: 'track-a.mp3', sessionId: 7, queueItemId: Q0 }));
    await first;

    expect(safeSend).not.toHaveBeenCalled();

    // The completed upload still warms the cache and leaves no active waiter.
    // Returning to the same queue occurrence can therefore publish without a
    // second upload, rebased onto the new playback session.
    setHostFile(fileA, Q0, 9);
    await shareRemoteFileIfNeeded(fileA, 9, targetConn, { queueItemId: Q0 });

    expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce();
    expect(safeSend).toHaveBeenCalledOnce();
    expect(safeSend).toHaveBeenCalledWith(
      targetConn,
      expect.objectContaining({
        type: MSG.REMOTE_FILE_SHARE,
        queueItemId: Q0,
        sessionId: 9,
        objectId: OBJECT_1,
      }),
    );
  });

  it('suppresses a targeted recovery descriptor when YouTube takes playback ownership', async () => {
    const { shareRemoteFileIfNeeded } = await import('../remote-share.ts');
    const { safeSend } = await import('../../network/peer.ts');

    const targetConn = getState('network.connectedPeers')[0]?.conn;
    if (!targetConn) throw new Error('expected remote target connection');

    const fileA = new File(['aaaa'], 'track-a.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [fileItem(fileA, Q0)]);
    setHostFile(fileA, Q0, 7);

    const first = shareRemoteFileIfNeeded(fileA, 7, targetConn, { queueItemId: Q0 });
    await vi.waitFor(() => expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce());

    setPlaybackYouTubePlaying();
    resolveUpload(descriptor({ name: 'track-a.mp3', sessionId: 7, queueItemId: Q0 }));
    await first;

    expect(safeSend).not.toHaveBeenCalled();

    // Ownership suppression is publication-only: cleanup and cache warming
    // still let a later file-mode retry use the completed descriptor.
    setPlaybackFilePlaying();
    setHostFile(fileA, Q0, 9);
    await shareRemoteFileIfNeeded(fileA, 9, targetConn, { queueItemId: Q0 });

    expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce();
    expect(safeSend).toHaveBeenCalledOnce();
  });

  it('sends once per R2 target and rebases a cached descriptor onto the current context', async () => {
    const { shareRemoteFileIfNeeded } = await import('../remote-share.ts');
    const { safeSend } = await import('../../network/peer.ts');

    const fileA = new File(['aaaa'], 'track-a.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [fileItem(fileA, Q0)]);
    setHostFile(fileA, Q0, 7);

    // Control case: context unchanged at completion — broadcast goes out.
    const first = shareRemoteFileIfNeeded(fileA, 7, undefined, { queueItemId: Q0 });
    await vi.waitFor(() => expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce());
    resolveUpload(descriptor({ name: 'track-a.mp3', sessionId: 7, queueItemId: Q0 }));
    await first;

    expect(safeSend).toHaveBeenCalledOnce();
    expect(safeSend).toHaveBeenCalledWith(
      expect.objectContaining({ peer: 'guest-remote-1' }),
      expect.objectContaining({
        type: MSG.REMOTE_FILE_SHARE,
        objectId: OBJECT_1,
        sessionId: 7,
        queueItemId: Q0,
        delivery: 'r2',
      }),
    );

    // Host re-selects the same track under a new sessionId: the still-fresh
    // cached descriptor is reused (no second upload) and withPlaybackContext
    // rebases the wire descriptor onto the CURRENT playback context.
    setHostFile(fileA, Q0, 9);
    await shareRemoteFileIfNeeded(fileA, 9, undefined, { queueItemId: Q0 });

    expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce();
    expect(safeSend).toHaveBeenCalledTimes(2);
    expect(safeSend).toHaveBeenLastCalledWith(
      expect.objectContaining({ peer: 'guest-remote-1' }),
      expect.objectContaining({
        type: MSG.REMOTE_FILE_SHARE,
        objectId: OBJECT_1,
        sessionId: 9,
        queueItemId: Q0,
      }),
    );
  });

  it('does not reuse an R2 descriptor for a different File with colliding metadata', async () => {
    const { shareRemoteFileIfNeeded } = await import('../remote-share.ts');

    const lastModified = 1_700_000_000_000;
    const fileA = new File(['aaaa'], 'same.mp3', { type: 'audio/mpeg', lastModified });
    const fileB = new File(['bbbb'], 'same.mp3', { type: 'audio/mpeg', lastModified });
    setState('playlist.items', [fileItem(fileA, Q0)]);
    setHostFile(fileA, Q0, 7);

    const first = shareRemoteFileIfNeeded(fileA, 7, undefined, { queueItemId: Q0 });
    await vi.waitFor(() => expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce());
    resolveUpload(descriptor({ objectId: OBJECT_A, name: fileA.name }));
    await first;

    setState('playlist.items', [fileItem(fileB, Q0)]);
    setHostFile(fileB, Q0, 8);
    const second = shareRemoteFileIfNeeded(fileB, 8, undefined, { queueItemId: Q0 });
    await vi.waitFor(() => expect(mocks.uploadRemoteFile).toHaveBeenCalledTimes(2));
    resolveUpload(descriptor({ objectId: OBJECT_B, name: fileB.name, sessionId: 8 }));
    await second;

    expect(mocks.uploadRemoteFile).toHaveBeenCalledTimes(2);
  });
});
