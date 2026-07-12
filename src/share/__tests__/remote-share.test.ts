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

const conn = { open: true, peer: 'host-1' } as DataConnection;
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
    roomId: 'room',
    objectId: OBJECT_1,
    keyB64: 'a2V5',
    ivB64: 'aXY=',
    name: 'song.mp3',
    mime: 'audio/mpeg',
    size: 4,
    encryptedSize: 20,
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
    bus.emit('state:network.sessionCode', null);
    const { resetFileRequestAuthority } = await import('../../network/file-request-authority.ts');
    resetFileRequestAuthority();
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

  it('rejects an unsafe iOS download peak before starting XHR', async () => {
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
          ...descriptor({ size, encryptedSize: size + 16 }),
        },
        conn,
      );

      expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();
      expect(getState('share.remote').download.status).toBe('error');
      expect(mocks.transition).toHaveBeenCalledWith({ type: 'REMOTE_FILE_UNAVAILABLE' });
      expect(sendToHost).toHaveBeenCalledWith({ type: MSG.GUEST_DECODE_FAILED, queueItemId: Q0 });

      vi.mocked(showToast).mockClear();
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(showToast).not.toHaveBeenCalledWith('share.remote.timeout');
    } finally {
      vi.useRealTimers();
      if (originalUserAgent) Object.defineProperty(navigator, 'userAgent', originalUserAgent);
    }
  });

  it('waits for a transient native decode lease before starting remote XHR', async () => {
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
          ...descriptor({ size, encryptedSize: size + 16 }),
        },
        conn,
      );

      await Promise.resolve();
      expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();

      decodeLease.release();
      await pending;
      expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
      expect(getState('share.remote').download.status).toBe('ready');
    } finally {
      decodeLease.release();
      if (originalUserAgent) Object.defineProperty(navigator, 'userAgent', originalUserAgent);
    }
  });

  it('cancels a superseded admission waiter before the shared lease is released', async () => {
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
      const predecessor = handleData(
        {
          type: MSG.REMOTE_FILE_SHARE,
          ...descriptor({ objectId: OBJECT_1, size, encryptedSize: size + 16 }),
        },
        conn,
      );
      let predecessorSettled = false;
      void predecessor.then(() => {
        predecessorSettled = true;
      });
      await Promise.resolve();

      const successorDescriptor = descriptor({
        objectId: OBJECT_2,
        queueItemId: Q1,
        sessionId: 8,
        size,
        encryptedSize: size + 16,
      });
      const successor = handleData({ type: MSG.REMOTE_FILE_SHARE, ...successorDescriptor }, conn);

      await vi.waitFor(() => expect(predecessorSettled).toBe(true));
      expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();

      decodeLease.release();
      await successor;
      expect(mocks.downloadRemoteFile).toHaveBeenCalledOnce();
      expect(mocks.downloadRemoteFile.mock.calls[0]?.[0]).toMatchObject({
        objectId: OBJECT_2,
        queueItemId: Q1,
        sessionId: 8,
      });
    } finally {
      decodeLease.release();
      if (originalUserAgent) Object.defineProperty(navigator, 'userAgent', originalUserAgent);
    }
  });

  it('abandons an admission wait when its room watchdog expires', async () => {
    vi.useFakeTimers();
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
      const { showToast } = await import('../../ui/toast.ts');
      setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
      const size = 80 * 1024 * 1024;
      const pending = handleData(
        {
          type: MSG.REMOTE_FILE_SHARE,
          ...descriptor({ size, encryptedSize: size + 16 }),
        },
        conn,
      );
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 16_000);
      await pending;
      expect(showToast).toHaveBeenCalledWith('share.remote.timeout');
      expect(mocks.transition).toHaveBeenCalledWith({ type: 'REMOTE_FILE_UNAVAILABLE' });
      expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();
      expect(getState('share.remote').download).toEqual({
        status: 'error',
        progress: 0,
        error: 'share.remote.timeout',
      });

      decodeLease.release();
      await Promise.resolve();
      expect(mocks.downloadRemoteFile).not.toHaveBeenCalled();
    } finally {
      decodeLease.release();
      vi.useRealTimers();
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
    bus.emit('state:network.sessionCode', null);
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
    // second encryption/upload, rebased onto the new playback session.
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

  it('broadcasts once per share and rebases a cached descriptor onto the current context', async () => {
    const { shareRemoteFileIfNeeded } = await import('../remote-share.ts');
    const { broadcast } = await import('../../network/peer.ts');

    const fileA = new File(['aaaa'], 'track-a.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [fileItem(fileA, Q0)]);
    setHostFile(fileA, Q0, 7);

    // Control case: context unchanged at completion — broadcast goes out.
    const first = shareRemoteFileIfNeeded(fileA, 7, undefined, { queueItemId: Q0 });
    await vi.waitFor(() => expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce());
    resolveUpload(descriptor({ name: 'track-a.mp3', sessionId: 7, queueItemId: Q0 }));
    await first;

    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.REMOTE_FILE_SHARE,
        objectId: OBJECT_1,
        sessionId: 7,
        queueItemId: Q0,
      }),
    );

    // Host re-selects the same track under a new sessionId: the still-fresh
    // cached descriptor is reused (no second upload) and withPlaybackContext
    // rebases the wire descriptor onto the CURRENT playback context.
    setHostFile(fileA, Q0, 9);
    await shareRemoteFileIfNeeded(fileA, 9, undefined, { queueItemId: Q0 });

    expect(mocks.uploadRemoteFile).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenLastCalledWith(
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
