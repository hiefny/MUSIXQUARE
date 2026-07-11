import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { CHUNK_SIZE, LOAD_SOURCE, PLAYBACK_STATE, TRANSFER_STATE } from '../../core/constants.ts';
import { DEMO_TRACK } from '../../demo/tracks.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';

vi.mock('../storage.ts', () => ({
  admitIncomingStoredFile: vi.fn(),
  postCommand: vi.fn(),
  cleanupStoredFile: vi.fn(),
}));

vi.mock('../../network/peer.ts', () => ({
  sendToHost: vi.fn(),
  isRemoteGuest: vi.fn(() => false),
  waitForGuestConnectionType: vi.fn(),
}));

vi.mock('../../share/remote-share.ts', () => ({
  cancelRemoteShareWait: vi.fn(),
  prepareRemoteShareWait: vi.fn(),
  shouldWaitForRemoteShare: vi.fn(() => true),
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
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

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: vi.fn(),
  clearManagedTimer: vi.fn(),
}));

/** Highest invocationCallOrder of a managed-timer mock call for `timerName`, or -1. */
function lastCallOrder(
  mockFn: { mock: { calls: unknown[][]; invocationCallOrder: number[] } },
  timerName: string,
): number {
  let last = -1;
  mockFn.mock.calls.forEach((args, i) => {
    if (args[0] === timerName) last = mockFn.mock.invocationCallOrder[i];
  });
  return last;
}

describe('remote-share to local direct transfer promotion', () => {
  const conn = { open: true, peer: 'host-1' } as DataConnection;

  beforeEach(async () => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    const { clearReceiveState } = await import('../transfer-receive.ts');
    clearReceiveState();
    setState('network.hostConn', conn);
  });

  it('accepts local FILE_START after a remote-share wait was armed before localSessionId advanced', async () => {
    const { handleFileStart } = await import('../transfer-receive.ts');
    const { cancelRemoteShareWait } = await import('../../share/remote-share.ts');
    const { postCommand } = await import('../storage.ts');

    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
    setState('playback.loadSource', LOAD_SOURCE.PRELOAD_PROMOTED);
    setState('playback.pendingRecoveryTarget', { index: 0, name: 'song.mp3' });
    setState('transfer.meta', { name: 'song.mp3', index: 0, sessionId: 7 });
    setState('preload.meta', { name: 'song.mp3', index: 0, sessionId: 7 });
    setState('preload.nextTrackIndex', 0);
    setState('transfer.localSessionId', 0);
    bus.on('storage:clear-previous-track', (reason) => {
      if (reason !== 'new-session-start') return;
      setState('transfer.meta', {});
      setState('playback.pendingRecoveryTarget', null);
    });

    handleFileStart(
      {
        type: 'file-start',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        total: 1,
        size: 4,
        index: 0,
        sessionId: 7,
      },
      conn,
    );

    expect(cancelRemoteShareWait).toHaveBeenCalledWith('local-direct-file-start');
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('playback.loadSource')).toBe(LOAD_SOURCE.FRESH);
    expect(getState('transfer.localSessionId')).toBe(7);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
    expect(getState('preload.meta')).toBeNull();
    expect(getState('preload.nextTrackIndex')).toBe(-1);
    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'STORAGE_START',
        filename: 'song.mp3',
        isPreload: false,
        sessionId: 7,
      }),
    );
  });

  it('does not promote stale direct FILE_START after preload playback has already moved on', async () => {
    const { handleFileStart } = await import('../transfer-receive.ts');
    const { cancelRemoteShareWait } = await import('../../share/remote-share.ts');
    const { postCommand } = await import('../storage.ts');

    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.READY);
    setState('playback.loadSource', LOAD_SOURCE.PRELOAD_PROMOTED);
    setState('transfer.localSessionId', 6);
    setState('transfer.meta', { name: 'song.mp3', index: 0, sessionId: 7 });
    setState('preload.meta', { name: 'song.mp3', index: 0, sessionId: 7 });

    handleFileStart(
      {
        type: 'file-start',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        total: 1,
        size: 4,
        index: 0,
        sessionId: 7,
      },
      conn,
    );

    expect(cancelRemoteShareWait).not.toHaveBeenCalled();
    expect(postCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'STORAGE_START',
      }),
    );
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.READY);
    expect(getState('playback.loadSource')).toBe(LOAD_SOURCE.PRELOAD_PROMOTED);
  });

  it('accepts demo FILE_PREPARE while leaving YouTube mode', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');

    setPlaybackYouTubePlaying();
    setState('network.connectionType', 'local');
    setState('playlist.items', [
      {
        type: 'file',
        name: DEMO_TRACK.fileName,
        title: DEMO_TRACK.title,
        videoId: null,
        playlistId: null,
      },
    ]);

    await handleFilePrepare(
      {
        type: 'file-prepare',
        name: DEMO_TRACK.fileName,
        mime: DEMO_TRACK.mime,
        index: 0,
        sessionId: 11,
      },
      conn,
    );

    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('pending');
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('playlist.currentTrackIndex')).toBe(0);
  });

  it('ignores FILE_PREPARE while a system-audio receive placeholder owns playback', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');

    setState('network.connectionType', 'local');
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'system-audio-receiving',
      systemAudioPlaceholder: true,
    });

    await handleFilePrepare(
      {
        type: 'file-prepare',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        index: 0,
        sessionId: 12,
      },
      conn,
    );

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('transfer.meta')).toBeNull();
    expect(postCommand).not.toHaveBeenCalled();
  });

  it('does not let the demo FILE_PREPARE cross the system-audio receive placeholder', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');

    setState('network.connectionType', 'local');
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'system-audio-receiving',
      systemAudioPlaceholder: true,
    });
    setState('playlist.items', [
      {
        type: 'file',
        name: DEMO_TRACK.fileName,
        title: DEMO_TRACK.title,
        videoId: null,
        playlistId: null,
      },
    ]);

    await handleFilePrepare(
      {
        type: 'file-prepare',
        name: DEMO_TRACK.fileName,
        mime: DEMO_TRACK.mime,
        index: 0,
        sessionId: 13,
      },
      conn,
    );

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('playlist.currentTrackIndex')).toBe(-1);
    expect(getState('transfer.meta')).toBeNull();
    expect(postCommand).not.toHaveBeenCalled();
  });

  it('preserves a queued host PLAY when FILE_PREPARE resets receive state for the same track', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const { getPendingPlayTime, getPendingPlayTimeSetAt, setPendingPlayTime } =
      await import('../../player/_state.ts');

    setState('network.connectionType', 'local');
    setState('playlist.currentTrackIndex', 2);
    setState('playlist.items', [
      { type: 'file', name: 'a.mp3', title: 'A', videoId: null, playlistId: null },
      { type: 'file', name: 'b.mp3', title: 'B', videoId: null, playlistId: null },
      { type: 'file', name: 'song.mp3', title: 'Song', videoId: null, playlistId: null },
    ]);
    setPendingPlayTime(37, 123456);

    bus.on('player:stop-all-media', () => setPendingPlayTime(undefined));
    bus.on('storage:clear-previous-track', () => setPendingPlayTime(undefined));

    await handleFilePrepare(
      {
        type: 'file-prepare',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        index: 2,
        size: 1024,
        sessionId: 13,
      },
      conn,
    );

    expect(getPendingPlayTime()).toBe(37);
    expect(getPendingPlayTimeSetAt()).toBe(123456);
    expect(getState('transfer.meta')).toMatchObject({
      name: 'song.mp3',
      index: 2,
      sessionId: 13,
    });
  });

  // A remote-loaded guest has no local transfer session. The first promotion
  // FILE_START must adopt its session without destroying the playing buffer.
  it('skips re-transfer and preserves loaded audio when a promoted guest receives FILE_START for the already-loaded track', async () => {
    const { handleFileStart } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');

    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.PLAYING);
    setState('playback.loadSource', LOAD_SOURCE.PRELOAD_PROMOTED);
    setState('transfer.localSessionId', 0); // remote path never wrote it
    setState('transfer.meta', { name: 'song.mp3', index: 0, sessionId: 7, size: 4 });
    setState('files.currentFileBlob', new Blob(['abcd']));
    setState('playlist.currentTrackIndex', 0);

    const clearSpy = vi.fn();
    bus.on('storage:clear-previous-track', clearSpy);

    handleFileStart(
      {
        type: 'file-start',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        total: 1,
        size: 4,
        index: 0,
        sessionId: 7,
      },
      conn,
    );

    expect(clearSpy).not.toHaveBeenCalled();
    expect(postCommand).not.toHaveBeenCalled();
    expect(getState('files.currentFileBlob')).not.toBeNull();
    expect(getState('transfer.localSessionId')).toBe(7); // session adopted
    expect(getState('transfer.state')).not.toBe(TRANSFER_STATE.RECEIVING);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.PLAYING);
  });

  it('still falls through to a fresh receive when the same file arrives under a genuinely newer session', async () => {
    const { handleFileStart } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');

    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.PLAYING);
    setState('playback.loadSource', LOAD_SOURCE.PRELOAD_PROMOTED);
    setState('transfer.localSessionId', 0);
    setState('transfer.meta', { name: 'song.mp3', index: 0, sessionId: 7, size: 4 });
    setState('files.currentFileBlob', new Blob(['abcd']));
    setState('playlist.currentTrackIndex', 0);

    const clearSpy = vi.fn();
    bus.on('storage:clear-previous-track', clearSpy);

    handleFileStart(
      {
        type: 'file-start',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        total: 1,
        size: 4,
        index: 0,
        sessionId: 8, // host re-click / repeat rebroadcast — newer than loaded 7
      },
      conn,
    );

    expect(clearSpy).toHaveBeenCalled();
    expect(postCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'STORAGE_RESET' }));
    expect(getState('transfer.localSessionId')).toBe(8);
  });

  it('drops promoted-session FILE_CHUNK tails without treating chunk index as playlist index', async () => {
    const { handleFileChunk } = await import('../transfer-receive.ts');
    const { admitIncomingStoredFile, postCommand } = await import('../storage.ts');
    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.DECODING);
    setState('playback.loadSource', LOAD_SOURCE.PRELOAD_PROMOTED);
    setState('playlist.currentTrackIndex', 0);
    setState('transfer.localSessionId', 7);
    setState('transfer.state', TRANSFER_STATE.PROCESSING);
    setState('transfer.meta', { name: 'song.mp3', index: 0, sessionId: 7 });

    handleFileChunk(
      {
        type: 'file-chunk',
        name: 'song.mp3',
        sessionId: 7,
        index: 1,
        total: 2,
        size: CHUNK_SIZE + 1,
        chunk: new Uint8Array([0xaa]),
      },
      conn,
    );

    expect(admitIncomingStoredFile).not.toHaveBeenCalled();
    expect(postCommand).not.toHaveBeenCalled();
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.PROCESSING);
  });

  // Match booleans captured before a mismatch cleanup must not route a
  // same-name/different-index request through the cleared preload slot.
  it('does not enter preload-match for a same-name DIFFERENT-index track after the mismatch clear', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');

    setState('network.connectionType', 'local');
    setState('preload.meta', { name: 'song.mp3', index: 3, sessionId: 7 });
    setState('preload.nextFileBlob', new Blob(['stale-preload']));
    setState('preload.nextTrackIndex', 3);

    const usePreloaded = vi.fn();
    bus.on('storage:use-preloaded', usePreloaded);

    await handleFilePrepare(
      { type: 'file-prepare', name: 'song.mp3', mime: 'audio/mpeg', index: 7, sessionId: 9 },
      conn,
    );

    expect(usePreloaded).not.toHaveBeenCalled();
    expect(getState('preload.nextFileBlob')).toBeNull();
    expect(getState('preload.meta')).toBeNull();
    // The fresh receive pipeline must be armed for the REAL incoming transfer.
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
  });

  it('replays only the exact loaded session and playlist slot', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');

    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.PLAYING);
    setState('playlist.currentTrackIndex', 0);
    setState('transfer.localSessionId', 7);
    setState('transfer.meta', { name: 'song.mp3', index: 0, sessionId: 7, size: 4 });
    setState('files.currentFileBlob', new Blob(['abcd']));

    const replay = vi.fn();
    bus.on('playback:replay-current', replay);

    await handleFilePrepare(
      {
        type: 'file-prepare',
        name: 'song.mp3',
        index: 0,
        size: 4,
        sessionId: 7,
        autoPlayDelayMs: 3000,
      },
      conn,
    );

    expect(replay).toHaveBeenCalledWith(3000);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.PLAYING);
  });

  it('downloads fresh when identical metadata arrives under a newer session', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');

    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.PLAYING);
    setState('playlist.currentTrackIndex', 0);
    setState('transfer.localSessionId', 7);
    setState('transfer.meta', { name: 'song.mp3', index: 0, sessionId: 7, size: 4 });
    setState('files.currentFileBlob', new Blob(['abcd']));

    const replay = vi.fn();
    bus.on('playback:replay-current', replay);

    await handleFilePrepare(
      {
        type: 'file-prepare',
        name: 'song.mp3',
        index: 0,
        size: 4,
        sessionId: 8,
      },
      conn,
    );

    expect(replay).not.toHaveBeenCalled();
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('transfer.localSessionId')).toBe(8);
  });

  it('does not treat same-name/same-size preload metadata as cross-index identity', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');

    setState('network.connectionType', 'local');
    setState('preload.meta', { name: 'song.mp3', index: 3, sessionId: 7, size: 4 });
    setState('preload.nextFileBlob', new Blob(['abcd'])); // size 4
    setState('preload.nextTrackIndex', 3);

    const usePreloaded = vi.fn();
    bus.on('storage:use-preloaded', usePreloaded);

    await handleFilePrepare(
      {
        type: 'file-prepare',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        index: 0,
        size: 4,
        sessionId: 9,
      },
      conn,
    );

    expect(usePreloaded).not.toHaveBeenCalled();
    expect(getState('preload.nextFileBlob')).toBeNull();
    expect(getState('preload.nextTrackIndex')).toBe(-1);
    expect(getState('preload.meta')).toBeNull();
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
  });

  it('still clears and re-downloads when sizes differ (same name, different content)', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');

    setState('network.connectionType', 'local');
    setState('preload.meta', { name: 'song.mp3', index: 3, sessionId: 7, size: 4 });
    setState('preload.nextFileBlob', new Blob(['abcd'])); // size 4
    setState('preload.nextTrackIndex', 3);

    const usePreloaded = vi.fn();
    bus.on('storage:use-preloaded', usePreloaded);

    await handleFilePrepare(
      {
        type: 'file-prepare',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        index: 0,
        size: 999,
        sessionId: 9,
      },
      conn,
    );

    expect(usePreloaded).not.toHaveBeenCalled();
    expect(getState('preload.nextFileBlob')).toBeNull();
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
  });

  it('does not reuse a loaded file for a same-name/same-size entry at another index', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');

    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.PLAYING);
    setState('playlist.currentTrackIndex', 0);
    setState('transfer.localSessionId', 7);
    setState('transfer.meta', { name: 'song.mp3', index: 0, sessionId: 7, size: 4 });
    setState('files.currentFileBlob', new Blob(['abcd'])); // size 4

    const replay = vi.fn();
    bus.on('playback:replay-current', replay);

    await handleFilePrepare(
      {
        type: 'file-prepare',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        index: 2,
        size: 4,
        sessionId: 9,
        autoPlayDelayMs: 3000,
      },
      conn,
    );

    expect(replay).not.toHaveBeenCalled();
    expect(getState('files.currentFileBlob')).not.toBeNull();
    expect(getState('playlist.currentTrackIndex')).toBe(2);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
  });

  it('still re-downloads the duplicate-name track when the loaded size differs', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');

    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.PLAYING);
    setState('playlist.currentTrackIndex', 0);
    setState('transfer.localSessionId', 7);
    setState('transfer.meta', { name: 'song.mp3', index: 0, sessionId: 7, size: 4 });
    setState('files.currentFileBlob', new Blob(['abcd'])); // size 4

    const replay = vi.fn();
    bus.on('playback:replay-current', replay);

    await handleFilePrepare(
      {
        type: 'file-prepare',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        index: 2,
        size: 999,
        sessionId: 9,
      },
      conn,
    );

    expect(replay).not.toHaveBeenCalled();
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
  });

  it('keeps the fresh receive watchdog armed for a cross-index metadata collision', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const { setManagedTimer, clearManagedTimer } = await import('../../core/timers.ts');

    setState('network.connectionType', 'local');
    setState('playback.lifecycle', PLAYBACK_STATE.PLAYING);
    setState('playlist.currentTrackIndex', 0);
    setState('transfer.localSessionId', 7);
    setState('transfer.meta', { name: 'song.mp3', index: 0, sessionId: 7, size: 4 });
    setState('files.currentFileBlob', new Blob(['abcd'])); // size 4

    await handleFilePrepare(
      {
        type: 'file-prepare',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        index: 2,
        size: 4,
        sessionId: 9, // > 7 → new-session reset arms the watchdog
      },
      conn,
    );

    const armed = lastCallOrder(vi.mocked(setManagedTimer), 'chunkWatchdog');
    const disarmed = lastCallOrder(vi.mocked(clearManagedTimer), 'chunkWatchdog');
    expect(armed).toBeGreaterThan(-1);
    expect(disarmed).toBeLessThan(armed);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
  });

  it('still promotes a preload for the exact same playlist slot', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const { setManagedTimer, clearManagedTimer } = await import('../../core/timers.ts');

    setState('network.connectionType', 'local');
    setState('transfer.localSessionId', 7);
    setState('preload.meta', { name: 'song.mp3', index: 3, sessionId: 7, size: 4 });
    setState('preload.nextFileBlob', new Blob(['abcd'])); // size 4
    setState('preload.nextTrackIndex', 3);
    const usePreloaded = vi.fn();
    bus.on('storage:use-preloaded', usePreloaded);

    await handleFilePrepare(
      {
        type: 'file-prepare',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        index: 3,
        size: 4,
        sessionId: 9,
      },
      conn,
    );

    const armed = lastCallOrder(vi.mocked(setManagedTimer), 'chunkWatchdog');
    const disarmed = lastCallOrder(vi.mocked(clearManagedTimer), 'chunkWatchdog');
    expect(armed).toBeGreaterThan(-1);
    expect(disarmed).toBeGreaterThan(armed);
    expect(usePreloaded).toHaveBeenCalledWith(3, 'song.mp3', 7);
  });

  it('does not use a name-only preload when FILE_PREPARE carries no index', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');

    setState('network.connectionType', 'local');
    setState('preload.meta', { name: 'song.mp3', index: 3, sessionId: 7 });
    setState('preload.nextFileBlob', new Blob(['preload']));
    setState('preload.nextTrackIndex', 3);

    const usePreloaded = vi.fn();
    bus.on('storage:use-preloaded', usePreloaded);

    await handleFilePrepare(
      { type: 'file-prepare', name: 'song.mp3', mime: 'audio/mpeg', sessionId: 9 },
      conn,
    );

    expect(usePreloaded).not.toHaveBeenCalled();
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
  });
});
