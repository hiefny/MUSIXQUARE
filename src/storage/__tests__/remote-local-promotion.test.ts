import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { LOAD_SOURCE, MSG, PLAYBACK_STATE, TRANSFER_STATE } from '../../core/constants.ts';
import { DEMO_TRACK } from '../../demo/tracks.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';

vi.mock('../storage.ts', () => ({
  admitIncomingStoredFile: vi.fn(),
  postCommand: vi.fn(),
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

vi.mock('../../i18n/index.ts', () => ({ t: vi.fn((key: string) => key) }));
vi.mock('../../player/transport.ts', () => ({ pause: vi.fn() }));
vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../core/timers.ts', () => ({ setManagedTimer: vi.fn(), clearManagedTimer: vi.fn() }));

const warningMocks = vi.hoisted(() => ({
  announceSystemMessageLocally: vi.fn(),
}));
vi.mock('../../chat/protocol.ts', () => ({
  announceSystemMessageLocally: warningMocks.announceSystemMessageLocally,
}));

const Q0 = '00000000-0000-4000-8000-000000000001';
const Q1 = '00000000-0000-4000-8000-000000000002';
const conn = { open: true, peer: 'host-1' } as DataConnection;

function fileItem(queueItemId: string, name: string) {
  return { queueItemId, type: 'file' as const, name, videoId: null, playlistId: null };
}

function resident(queueItemId: string, sessionId: number, blob: Blob, name = 'song.mp3') {
  return {
    queueItemId,
    indexHint: queueItemId === Q0 ? 0 : 1,
    name,
    sessionId,
    size: blob.size,
    mime: blob.type,
    blob,
  };
}

function startFrame(queueItemId: string, sessionId: number, name = 'song.mp3') {
  return {
    type: 'file-start',
    queueItemId,
    name,
    mime: 'audio/mpeg',
    total: 1,
    size: 4,
    sessionId,
  };
}

function prepareFrame(queueItemId: string, sessionId: number, name = 'song.mp3') {
  return {
    type: 'file-prepare',
    queueItemId,
    name,
    mime: 'audio/mpeg',
    size: 4,
    sessionId,
  };
}

describe('remote-share to local direct transfer promotion', () => {
  beforeEach(async () => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    const { isRemoteGuest, waitForGuestConnectionType } = await import('../../network/peer.ts');
    vi.mocked(isRemoteGuest).mockReturnValue(false);
    vi.mocked(waitForGuestConnectionType).mockReset();
    const { resetIncomingTransferAuthority } = await import('../transfer-receive.ts');
    resetIncomingTransferAuthority();
    setState('network.hostConn', conn);
    setState('network.connectionType', 'local');
    setState('playlist.items', [fileItem(Q0, 'song.mp3'), fileItem(Q1, 'song.mp3')]);
    setState('playlist.currentQueueItemId', Q0);
  });

  it('promotes an exact remote wait to a local direct FILE_START', async () => {
    const { handleFileStart } = await import('../transfer-receive.ts');
    const { cancelRemoteShareWait } = await import('../../share/remote-share.ts');
    const { postCommand } = await import('../storage.ts');

    setState('playback.lifecycle', PLAYBACK_STATE.AWAITING_PRELOAD);
    setState('playback.loadSource', LOAD_SOURCE.PRELOAD_PROMOTED);
    setState('playback.pendingRecoveryTarget', {
      queueItemId: Q0,
      indexHint: 0,
      name: 'song.mp3',
    });
    setState('transfer.meta', { queueItemId: Q0, indexHint: 0, name: 'song.mp3', sessionId: 7 });
    setState('preload.activeTarget', {
      queueItemId: Q0,
      indexHint: 0,
      name: 'song.mp3',
      sessionId: 7,
    });

    handleFileStart(startFrame(Q0, 7), conn);

    expect(cancelRemoteShareWait).toHaveBeenCalledWith('local-direct-file-start');
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('playback.loadSource')).toBe(LOAD_SOURCE.FRESH);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
    expect(getState('preload.activeTarget')).toBeNull();
    expect(getState('preload.ready')).toBeNull();
    expect(getState('preload.nextQueueItemId')).toBeNull();
    expect(postCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'STORAGE_START',
        queueItemId: Q0,
        filename: 'song.mp3',
        sessionId: 7,
      }),
    );
  });

  it('drops a stale direct tail after preload playback already owns the exact transfer', async () => {
    const { handleFileStart } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const blob = new Blob(['abcd'], { type: 'audio/mpeg' });
    setState('playback.lifecycle', PLAYBACK_STATE.READY);
    setState('playback.loadSource', LOAD_SOURCE.PRELOAD_PROMOTED);
    setState('files.current', resident(Q0, 7, blob));
    setState('transfer.meta', { queueItemId: Q0, indexHint: 0, name: 'song.mp3', sessionId: 7 });
    setState('transfer.localSessionId', 7);

    handleFileStart(startFrame(Q0, 7), conn);

    expect(postCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'STORAGE_START' }),
    );
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.READY);
  });

  it('does not let a demo-like filename override explicit YouTube ownership', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    setPlaybackYouTubePlaying();
    const lifecycleBefore = getState('playback.lifecycle');
    setState('playlist.items', [fileItem(Q0, DEMO_TRACK.fileName)]);
    setState('playlist.currentQueueItemId', Q0);

    await handleFilePrepare(
      {
        ...prepareFrame(Q0, 11, DEMO_TRACK.fileName),
        mime: DEMO_TRACK.mime,
      },
      conn,
    );

    expect(getState('playback.mode')).toBe('youtube');
    expect(getState('playback.lifecycle')).toBe(lifecycleBefore);
    expect(getState('playlist.currentQueueItemId')).toBe(Q0);
    expect(postCommand).not.toHaveBeenCalled();
  });

  it('preserves a first decode failure across same-occurrence recovery prepare', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    setState('player.decodeFailureCount', 1);
    setState('transfer.meta', {
      queueItemId: Q0,
      indexHint: 0,
      name: 'song.mp3',
      sessionId: 7,
      size: 4,
      total: 1,
      mime: 'audio/mpeg',
    });

    await handleFilePrepare(prepareFrame(Q0, 8), conn);

    expect(getState('player.decodeFailureCount')).toBe(1);
  });

  it('resets the decode failure count for a new queue occurrence', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    setState('player.decodeFailureCount', 1);
    setState('transfer.meta', {
      queueItemId: Q0,
      indexHint: 0,
      name: 'song.mp3',
      sessionId: 7,
      size: 4,
      total: 1,
      mime: 'audio/mpeg',
    });
    setState('playlist.currentQueueItemId', Q1);

    await handleFilePrepare(prepareFrame(Q1, 9, 'next.mp3'), conn);

    expect(getState('player.decodeFailureCount')).toBe(0);
  });

  it('also resets a new occurrence when FILE_PREPARE was lost', async () => {
    const { handleFileStart } = await import('../transfer-receive.ts');
    setState('player.decodeFailureCount', 1);
    setState('transfer.meta', {
      queueItemId: Q0,
      indexHint: 0,
      name: 'song.mp3',
      sessionId: 7,
      size: 4,
      total: 1,
      mime: 'audio/mpeg',
    });
    setState('playlist.currentQueueItemId', Q1);

    handleFileStart(startFrame(Q1, 9, 'next.mp3'), conn);

    expect(getState('player.decodeFailureCount')).toBe(0);
  });

  it('does not reopen transfer for a queue occurrence this device cannot decode', async () => {
    const { markTrackFailed } = await import('../../player/_state.ts');
    const { handleFilePrepare, handleFileStart } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    const { showLoader } = await import('../../ui/toast.ts');
    markTrackFailed(`queue:${Q0}`);

    await handleFilePrepare(prepareFrame(Q0, 7), conn);
    handleFileStart(startFrame(Q0, 7), conn);

    expect(postCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'STORAGE_START', queueItemId: Q0 }),
    );
    expect(showLoader).toHaveBeenCalledWith(false);
  });

  it('turns a RAM admission rejection into one terminal device-local failure', async () => {
    const { handleFileStart } = await import('../transfer-receive.ts');
    const { admitIncomingStoredFile } = await import('../storage.ts');
    const { sendToHost } = await import('../../network/peer.ts');
    const { showToast } = await import('../../ui/toast.ts');
    setState('playback.pendingPlayTime', 92);
    setState('playback.pendingPlayTimeSetAt', Date.now());
    setState('playback.pendingRecoveryTarget', {
      queueItemId: Q0,
      indexHint: 0,
      name: 'song.mp3',
    });
    vi.mocked(admitIncomingStoredFile).mockImplementationOnce(() => {
      throw new Error('device memory budget exceeded');
    });

    handleFileStart(startFrame(Q0, 7), conn);
    handleFileStart(startFrame(Q0, 8), conn);

    expect(getState('playback.failedTrackKeys')).toContain(`queue:${Q0}`);
    expect(warningMocks.announceSystemMessageLocally).toHaveBeenCalledOnce();
    expect(warningMocks.announceSystemMessageLocally).toHaveBeenCalledWith(
      'chat.device_track_unavailable_system_message',
    );
    expect(sendToHost).toHaveBeenCalledOnce();
    expect(sendToHost).toHaveBeenCalledWith({
      type: MSG.GUEST_DECODE_FAILED,
      queueItemId: Q0,
    });
    expect(admitIncomingStoredFile).toHaveBeenCalledOnce();
    expect(showToast).not.toHaveBeenCalled();
    expect(getState('playback.pendingPlayTime')).toBeUndefined();
    expect(getState('playback.pendingRecoveryTarget')).toBeNull();
  });

  it('routes a remote user file matching a demo filename through remote share', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const { isRemoteGuest } = await import('../../network/peer.ts');
    const { prepareRemoteShareWait } = await import('../../share/remote-share.ts');
    vi.mocked(isRemoteGuest).mockReturnValue(true);
    setState('network.connectionType', 'remote');
    setState('playlist.items', [fileItem(Q0, DEMO_TRACK.fileName)]);
    setState('playlist.currentQueueItemId', Q0);

    await handleFilePrepare(
      {
        ...prepareFrame(Q0, 11, DEMO_TRACK.fileName),
        mime: DEMO_TRACK.mime,
      },
      conn,
    );

    expect(prepareRemoteShareWait).toHaveBeenCalledWith(Q0, DEMO_TRACK.fileName, 11);
  });

  it('ignores FILE_PREPARE while system-audio placeholder owns playback', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const { postCommand } = await import('../storage.ts');
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'system-audio-receiving',
      systemAudioPlaceholder: true,
    });

    await handleFilePrepare(prepareFrame(Q0, 12), conn);

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
    expect(postCommand).not.toHaveBeenCalled();
  });

  it('does not promote same-name preload bytes owned by another queue item', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const stale = new Blob(['same'], { type: 'audio/mpeg' });
    setState('preload.nextQueueItemId', Q0);
    setState('preload.activeTarget', {
      queueItemId: Q0,
      indexHint: 0,
      name: 'song.mp3',
      sessionId: 7,
    });
    setState('preload.ready', resident(Q0, 7, stale));

    await handleFilePrepare(prepareFrame(Q1, 9), conn);

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('playlist.currentQueueItemId')).toBe(Q1);
  });

  it('promotes the exact queue item preload atomically', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const blob = new Blob(['same'], { type: 'audio/mpeg' });
    const ready = resident(Q1, 7, blob);
    setState('preload.nextQueueItemId', Q1);
    setState('preload.activeTarget', ready);
    setState('preload.ready', ready);
    const usePreloaded = vi.fn();
    bus.on('storage:use-preloaded', usePreloaded);

    await handleFilePrepare(prepareFrame(Q1, 9), conn);

    expect(usePreloaded).toHaveBeenCalledWith(Q1, 'song.mp3', 7);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DECODING);
  });

  it('deduplicates only the exact resident queue item and session', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const { pause } = await import('../../player/transport.ts');
    const blob = new Blob(['abcd'], { type: 'audio/mpeg' });
    setState('files.current', resident(Q0, 7, blob));
    setState('transfer.meta', { queueItemId: Q0, indexHint: 0, name: 'song.mp3', sessionId: 7 });

    await handleFilePrepare(prepareFrame(Q0, 7), conn);
    expect(getState('playlist.currentQueueItemId')).toBe(Q0);
    expect(getState('files.current')).toEqual(expect.objectContaining({ queueItemId: Q0 }));
    expect(pause).not.toHaveBeenCalled();

    await handleFilePrepare(prepareFrame(Q1, 9), conn);
    expect(getState('playlist.currentQueueItemId')).toBe(Q1);
  });

  it('holds an exact resident for an already-open host that still delays PLAY', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const { pause } = await import('../../player/transport.ts');
    const blob = new Blob(['abcd'], { type: 'audio/mpeg' });
    setState('files.current', resident(Q0, 7, blob));
    setState('transfer.meta', { queueItemId: Q0, indexHint: 0, name: 'song.mp3', sessionId: 7 });
    await handleFilePrepare({ ...prepareFrame(Q0, 7), autoPlayDelayMs: 3000 }, conn);

    expect(pause).toHaveBeenCalledWith(0, { holdVisualizer: false, showToast: false });
  });

  it('keeps a newer FILE_PREPARE owner when an older connection check resumes last', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const { isRemoteGuest, waitForGuestConnectionType } = await import('../../network/peer.ts');
    vi.mocked(isRemoteGuest).mockReturnValue(true);
    setState('network.connectionType', 'unknown');

    let resolveA!: (value: 'local' | 'remote') => void;
    let resolveB!: (value: 'local' | 'remote') => void;
    vi.mocked(waitForGuestConnectionType)
      .mockImplementationOnce(
        () => new Promise<'local' | 'remote'>((resolve) => (resolveA = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise<'local' | 'remote'>((resolve) => (resolveB = resolve)),
      );

    const staleA = handleFilePrepare(prepareFrame(Q0, 7, 'a.mp3'), conn);
    const winningB = handleFilePrepare(prepareFrame(Q1, 9, 'b.mp3'), conn);

    resolveB('local');
    await winningB;
    resolveA('local');
    await staleA;

    expect(getState('playlist.currentQueueItemId')).toBe(Q1);
    expect(getState('transfer.localSessionId')).toBe(9);
    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({ queueItemId: Q1, sessionId: 9, name: 'b.mp3' }),
    );
  });

  it('allows an unchanged null current target to bootstrap after connection classification', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');
    const { isRemoteGuest, waitForGuestConnectionType } = await import('../../network/peer.ts');
    vi.mocked(isRemoteGuest).mockReturnValue(true);
    vi.mocked(waitForGuestConnectionType).mockResolvedValue('local');
    setState('network.connectionType', 'unknown');
    setState('playlist.currentQueueItemId', null);

    await handleFilePrepare(prepareFrame(Q0, 11), conn);

    expect(getState('playlist.currentQueueItemId')).toBe(Q0);
    expect(getState('transfer.meta')).toEqual(
      expect.objectContaining({ queueItemId: Q0, sessionId: 11 }),
    );
  });
});
