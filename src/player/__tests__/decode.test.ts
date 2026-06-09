/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { DEMO_TRACK } from '../../demo/tracks.ts';
import { handleData } from '../../network/protocol.ts';
import { getPendingPlayTime, setPendingPlayTime } from '../_state.ts';
import type { ConnectedPeer, DataConnection, PlaylistItem } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  broadcastSystemNotice: vi.fn(),
  decodeAudioData: vi.fn(),
  sendRecoveryRequest: vi.fn(),
  safeSend: vi.fn(() => true),
  sendToHost: vi.fn(),
  stopAllMedia: vi.fn(),
  showLoader: vi.fn(),
  showToast: vi.fn(),
  transition: vi.fn(),
}));

vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(),
}));

vi.mock('../../audio/context.ts', () => ({
  ensureRunning: vi.fn(),
  getAudioContext: vi.fn(() => ({
    state: 'running',
    decodeAudioData: mocks.decodeAudioData,
  })),
}));

vi.mock('../../audio/system-capture.ts', () => ({
  isSystemAudioActive: vi.fn(() => false),
}));

vi.mock('../../storage/storage.ts', () => ({
  cleanupStoredFile: vi.fn(),
  postCommand: vi.fn(),
}));

vi.mock('../../storage/transfer.ts', () => ({
  broadcastFileDebounced: vi.fn(),
}));

vi.mock('../../share/remote-share.ts', () => ({
  shareRemoteFileIfNeeded: vi.fn(),
}));

vi.mock('../../storage/preload.ts', () => ({
  schedulePreload: vi.fn(),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: mocks.broadcast,
  safeSend: mocks.safeSend,
  sendToHost: mocks.sendToHost,
}));

vi.mock('../../storage/recovery.ts', () => ({
  sendRecoveryRequest: mocks.sendRecoveryRequest,
}));

vi.mock('../../chat/protocol.ts', () => ({
  broadcastSystemNotice: mocks.broadcastSystemNotice,
}));

vi.mock('../../ui/toast.ts', () => ({
  showLoader: mocks.showLoader,
  showToast: mocks.showToast,
}));

vi.mock('../transport.ts', () => ({
  play: vi.fn(),
  stopAllMedia: mocks.stopAllMedia,
  stopPlayerNode: vi.fn(),
}));

vi.mock('../lifecycle.ts', () => ({
  transition: mocks.transition,
}));

vi.mock('../video.ts', () => ({
  setEngineMode: vi.fn(),
}));

function makeConnection(peer: string): DataConnection {
  return { peer, open: true } as DataConnection;
}

function makeConnectedPeer(id: string, isOp: boolean): ConnectedPeer {
  return {
    id,
    slot: 0,
    label: id,
    conn: makeConnection(id),
    isOp,
    preloadedIndexes: new Set<number>(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 0,
    connectionType: 'unknown',
    lastHeartbeat: Date.now(),
  };
}

function makeTrack(name: string): PlaylistItem {
  return {
    type: 'file',
    name,
    videoId: null,
    playlistId: null,
  };
}

function makeFileTrack(file: File): PlaylistItem {
  return {
    type: 'file',
    name: file.name,
    title: file.name,
    file,
    videoId: null,
    playlistId: null,
  };
}

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('guest decode failure reports', () => {
  beforeEach(async () => {
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    mocks.decodeAudioData.mockResolvedValue({ duration: 120 });

    const { initDecodeHandlers } = await import('../decode.ts');
    initDecodeHandlers();
    setState('playlist.items', [makeTrack('song.mp3')]);
    setState('playlist.currentTrackIndex', 0);
  });

  it('keeps the only non-operator report local instead of advancing the room', async () => {
    const guest = makeConnectedPeer('guest-a', false);
    setState('network.connectedPeers', [guest]);

    await handleData({ type: MSG.GUEST_DECODE_FAILED, index: 0 }, guest.conn!);

    expect(mocks.broadcastSystemNotice).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith(
      'A device failed to decode this track. Playback is continuing for everyone else.',
    );
    expect(getState('playback.failedTrackKeys').size).toBe(0);
  });

  it('forwards held non-operator decode failure notices to connected operators only', async () => {
    const guest = makeConnectedPeer('guest-a', false);
    const op = makeConnectedPeer('guest-op', true);
    setState('network.connectedPeers', [guest, op]);

    await handleData({ type: MSG.GUEST_DECODE_FAILED, index: 0 }, guest.conn!);

    expect(mocks.safeSend).toHaveBeenCalledWith(op.conn, {
      type: MSG.OPERATOR_TOAST,
      text: 'A device failed to decode this track. Playback is continuing for everyone else.',
      i18nKey: 'toast.remote_decode_device_wait',
    });
    expect(mocks.safeSend).not.toHaveBeenCalledWith(guest.conn, expect.anything());
  });

  it('does not let one non-operator skip when another non-operator is connected', async () => {
    const guestA = makeConnectedPeer('guest-a', false);
    const guestB = makeConnectedPeer('guest-b', false);
    setState('network.connectedPeers', [guestA, guestB]);

    await handleData({ type: MSG.GUEST_DECODE_FAILED, index: 0 }, guestA.conn!);

    expect(mocks.broadcastSystemNotice).not.toHaveBeenCalled();
    expect(getState('playback.failedTrackKeys').size).toBe(0);
  });

  it('advances after two connected non-operator reports for the same track', async () => {
    const guestA = makeConnectedPeer('guest-a', false);
    const guestB = makeConnectedPeer('guest-b', false);
    setState('network.connectedPeers', [guestA, guestB]);

    await handleData({ type: MSG.GUEST_DECODE_FAILED, index: 0 }, guestA.conn!);
    await handleData({ type: MSG.GUEST_DECODE_FAILED, index: 0 }, guestB.conn!);

    expect(mocks.broadcastSystemNotice).toHaveBeenCalledOnce();
  });

  it('still lets an operator report advance immediately', async () => {
    const op = makeConnectedPeer('guest-op', true);
    setState('network.connectedPeers', [op]);

    await handleData({ type: MSG.GUEST_DECODE_FAILED, index: 0 }, op.conn!);

    expect(mocks.broadcastSystemNotice).toHaveBeenCalledOnce();
  });

  it('shows a local wait notice when guest decoding gives up', async () => {
    mocks.decodeAudioData.mockRejectedValue(new Error('decode failed'));
    setState('network.hostConn', makeConnection('host'));
    setState('player.decodeFailureCount', 1);
    setState('transfer.meta', { name: 'song.mp3', type: 'audio/mpeg', index: 0 });

    const { finalizeGuestFile } = await import('../decode.ts');
    await finalizeGuestFile(new File([new Uint8Array([1, 2, 3])], 'song.mp3'));

    expect(mocks.showToast).toHaveBeenCalledWith(
      "This device couldn't decode the track.\nPlease wait for the next track.",
    );
    expect(mocks.sendToHost).toHaveBeenCalledWith({ type: MSG.GUEST_DECODE_FAILED, index: 0 });
    expect(mocks.sendRecoveryRequest).not.toHaveBeenCalled();
  });
});

describe('guest file finalization sync', () => {
  beforeEach(() => {
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:guest-file'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    mocks.decodeAudioData.mockResolvedValue({ duration: 120 });
  });

  it('wraps local P2P demo pending time and requests an immediate host sync', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T00:00:05.000Z'));

    const hostConn = makeConnection('host-1');
    setState('network.hostConn', hostConn);
    setState('playlist.items', [makeTrack(DEMO_TRACK.fileName)]);
    setState('playlist.currentTrackIndex', 0);
    setPendingPlayTime(118, Date.now() - 5_000);

    const syncRequest = vi.fn();
    bus.on('sync:request-immediate-ping', syncRequest);

    const { finalizeGuestFile } = await import('../decode.ts');
    const { play } = await import('../transport.ts');
    await finalizeGuestFile(
      new File([new Uint8Array([1, 2, 3])], DEMO_TRACK.fileName, { type: DEMO_TRACK.mime }),
    );

    expect(play).toHaveBeenCalledWith(3);
    expect(getPendingPlayTime()).toBeUndefined();
    expect(syncRequest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);

    expect(syncRequest).toHaveBeenCalledOnce();
  });
});

describe('host preload activation result (SA-05)', () => {
  beforeEach(() => {
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:preload'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('returns false on decode failure and routes the host into failed-mark cleanup', async () => {
    mocks.decodeAudioData.mockRejectedValue(new Error('unsupported codec'));
    const file = new File([new Uint8Array([1, 2, 3])], 'broken.mp3', {
      type: 'audio/mpeg',
      lastModified: 123,
    });
    setState('playlist.items', [makeFileTrack(file)]);
    setState('playlist.currentTrackIndex', 0);
    setState('preload.nextFileBlob', file);
    setState('preload.meta', { name: 'broken.mp3', index: 0, sessionId: 7 });
    setState('preload.nextTrackIndex', 0);

    const { loadPreloadedTrack } = await import('../decode.ts');
    const activated = await loadPreloadedTrack(0);

    expect(activated).toBe(false);
    // Host must not fall into the guest-only recovery request (no-op on host)
    expect(mocks.sendToHost).not.toHaveBeenCalled();
    // Single broken track → all-failed terminal reset, mirrored to guests
    expect(mocks.broadcast).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 0,
      endOfPlaylist: true,
      reason: 'end-of-playlist',
    });
    expect(getState('playlist.currentTrackIndex')).toBe(-1);
  });

  it('returns true when activation succeeds', async () => {
    mocks.decodeAudioData.mockResolvedValue({ duration: 120 });
    const file = new File([new Uint8Array([1, 2, 3])], 'ok.mp3', {
      type: 'audio/mpeg',
      lastModified: 123,
    });
    setState('playlist.items', [makeFileTrack(file)]);
    setState('playlist.currentTrackIndex', 0);
    setState('preload.nextFileBlob', file);
    setState('preload.meta', { name: 'ok.mp3', index: 0, sessionId: 7 });
    setState('preload.nextTrackIndex', 0);

    const { loadPreloadedTrack } = await import('../decode.ts');
    const activated = await loadPreloadedTrack(0);

    expect(activated).toBe(true);
    expect(getState('preload.nextFileBlob')).toBeNull();
  });

  it('returns false when no preloaded blob exists', async () => {
    const { loadPreloadedTrack } = await import('../decode.ts');
    expect(await loadPreloadedTrack(0)).toBe(false);
  });
});

describe('host decode failure cleanup', () => {
  beforeEach(() => {
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    mocks.decodeAudioData.mockRejectedValue(new Error('unsupported codec'));
  });

  it('returns to an empty player title state when the only track cannot decode', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'broken.mp3', {
      type: 'audio/mpeg',
      lastModified: 123,
    });
    setState('playlist.items', [makeFileTrack(file)]);
    setState('playlist.currentTrackIndex', 0);
    setState('player.currentTrackMeta', makeFileTrack(file));

    const { loadAndBroadcastFile } = await import('../decode.ts');
    const didLoad = await loadAndBroadcastFile(file, 1);

    expect(didLoad).toBe(false);
    expect(getState('player.currentTrackMeta')).toBeNull();
    expect(getState('playlist.currentTrackIndex')).toBe(-1);
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    expect(mocks.broadcast).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 0,
      endOfPlaylist: true,
      reason: 'end-of-playlist',
    });
  });
});
