import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import {
  DEMO_FILE_NAME,
  LOAD_SOURCE,
  PLAYBACK_STATE,
  TRANSFER_STATE,
} from '../../core/constants.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';

vi.mock('../storage.ts', () => ({
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

    handleFileStart(
      {
        type: 'file-start',
        name: 'song.mp3',
        mime: 'audio/mpeg',
        total: 2,
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

  it('accepts demo FILE_PREPARE while leaving YouTube mode', async () => {
    const { handleFilePrepare } = await import('../transfer-receive.ts');

    setPlaybackYouTubePlaying();
    setState('network.connectionType', 'local');
    setState('playlist.items', [
      {
        type: 'file',
        name: DEMO_FILE_NAME,
        title: 'demo_track',
        videoId: null,
        playlistId: null,
      },
    ]);

    await handleFilePrepare(
      {
        type: 'file-prepare',
        name: DEMO_FILE_NAME,
        mime: 'audio/mpeg',
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
});
