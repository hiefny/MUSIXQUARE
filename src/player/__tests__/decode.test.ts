/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { handleData } from '../../network/protocol.ts';
import type { ConnectedPeer, DataConnection, PlaylistItem } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  broadcastSystemNotice: vi.fn(),
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
    decodeAudioData: vi.fn(),
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
  sendToHost: vi.fn(),
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

describe('guest decode failure reports', () => {
  beforeEach(async () => {
    resetState();
    bus.clear();
    vi.clearAllMocks();

    const { initDecodeHandlers } = await import('../decode.ts');
    initDecodeHandlers();
    setState('playlist.items', [makeTrack('song.mp3')]);
    setState('playlist.currentTrackIndex', 0);
  });

  it('does not let one non-operator skip the room-wide track', async () => {
    const guest = makeConnectedPeer('guest-a', false);
    setState('network.connectedPeers', [guest]);

    await handleData({ type: MSG.GUEST_DECODE_FAILED, index: 0 }, guest.conn!);

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
});
