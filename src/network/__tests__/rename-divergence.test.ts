/**
 * @vitest-environment jsdom
 *
 * Regression tests for guest-rename convergence.
 *
 * A guest must not apply `network.myDeviceLabel` optimistically because the
 * host's handleRequestRename can reject silently (reserved /
 * profanity / duplicate / empty-after-strip) with no NACK and no corrective
 * broadcast — the guest's identity UI diverged from the room until the next
 * device-list churn. Worse, the client-side duplicate pre-check read
 * `network.connectedPeers`, which is host-only state and ALWAYS empty on a
 * guest, so renaming to another guest's name passed locally 100% of the time
 * and was rejected by the host 100% of the time.
 *
 * DEVICE_LIST_UPDATE round-trips the accepted label as the single writer.
 * Role-aware client validation mirrors
 * the host's char-strip and duplicate criteria so rejections happen locally
 * with feedback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { addSystemChatMessage } from '../../ui/chat-render.ts';
import type { ConnectedPeer, DataConnection, DeviceInfo } from '../../types/index.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
}));

vi.mock('../peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
  broadcastDeviceList: vi.fn(),
}));

vi.mock('../peer-state.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../peer-state.ts')>();
  return {
    ...actual,
    getPeer: vi.fn(),
    detectConnectionType: vi.fn(),
  };
});

vi.mock('../sync-worker.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync-worker.ts')>();
  return {
    ...actual,
    startWorkerTimer: vi.fn(),
  };
});

vi.mock('../../ui/chat-render.ts', () => ({
  addSystemChatMessage: vi.fn(),
  addWhisperMessage: vi.fn(),
  addNoticeChatMessage: vi.fn(),
}));

vi.mock('../protocol.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../protocol.ts')>();
  return { ...actual };
});

vi.mock('../../chat/protocol.ts', () => ({
  rememberPinnedNotice: vi.fn(),
}));

vi.mock('../../audio/engine.ts', () => ({
  isAudioReady: vi.fn(() => false),
  getAudioContext: vi.fn(() => null),
}));

vi.mock('../../storage/preload.ts', () => ({
  getPreloadMemoryStats: vi.fn(() => ({})),
}));

vi.mock('../../storage/transfer-receive.ts', () => ({
  getTransferMemoryStats: vi.fn(() => ({})),
}));

vi.mock('../../storage/ramstore.ts', () => ({
  ramStats: vi.fn(() => ({})),
}));

vi.mock('../../player/_state.ts', () => ({
  getCurrentAudioBuffer: vi.fn(() => null),
  liveAudioBufferCount: vi.fn(() => 0),
}));

vi.mock('../../core/log-capture.ts', () => ({
  getCapturedLogs: vi.fn(() => []),
}));

vi.mock('../../player/ownership.ts', () => ({
  getPlaybackOwnership: vi.fn(() => ({})),
}));

vi.mock('../system-audio-debug.ts', () => ({
  collectSystemAudioDebugText: vi.fn(() => ''),
}));

import { getOtherDeviceLabels } from '../guards.ts';
import { initGuestProtocolHandlers } from '../guest.ts';
import { parseCommand, executeCommand } from '../../chat/commands.ts';

const addSystemChatMessageMock = vi.mocked(addSystemChatMessage);

function makePeer(label: string): ConnectedPeer {
  return { id: `id-${label}`, label, status: 'connected' } as unknown as ConnectedPeer;
}

function makeDevice(id: string, label: string): DeviceInfo {
  return { id, label } as unknown as DeviceInfo;
}

function makeHostConn(): DataConnection & { send: ReturnType<typeof vi.fn> } {
  return { open: true, peer: 'host', send: vi.fn() } as unknown as DataConnection & {
    send: ReturnType<typeof vi.fn>;
  };
}

function setupGuestRoom(otherLabels: string[] = ['Alice']): ReturnType<typeof makeHostConn> {
  const hostConn = makeHostConn();
  setState('network.hostConn', hostConn);
  setState('network.myId', 'me');
  setState('network.myDeviceLabel', 'Peer 1');
  setState('network.lastKnownDeviceList', [
    makeDevice('host-id', 'HOST'),
    makeDevice('me', 'Peer 1'),
    ...otherLabels.map((label, i) => makeDevice(`g${i}`, label)),
  ]);
  return hostConn;
}

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
});

// ─── getOtherDeviceLabels ──────────────────────────────────────────────────

describe('getOtherDeviceLabels (role-aware rename validation source)', () => {
  it('host reads connectedPeers', () => {
    setState('network.connectedPeers', [makePeer('Alice'), makePeer('Bob')]);
    expect(getOtherDeviceLabels()).toEqual(['Alice', 'Bob']);
  });

  it('guest reads the device-list broadcast, excluding itself and including the host', () => {
    setupGuestRoom(['Alice']);
    // connectedPeers is host-only state — stays empty on a guest, which is
    // exactly why the old validator passed every duplicate.
    expect(getState('network.connectedPeers')).toEqual([]);
    expect(getOtherDeviceLabels()).toEqual(['HOST', 'Alice']);
  });

  it('PRO member reads the authoritative device list even without a browser host connection', () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['room.configure'],
    });
    setState('network.hostConn', null);
    setState('network.myId', 'owner-member');
    setState('network.connectedPeers', [makePeer('Stale Browser Peer')]);
    setState('network.lastKnownDeviceList', [
      makeDevice('owner-member', 'Owner'),
      makeDevice('member-2', 'Alice'),
    ]);

    expect(getOtherDeviceLabels()).toEqual(['Alice']);
  });
});

// ─── Guest rename listener ─────────────────────────────────────────────────

describe('guest rename request (no optimistic apply)', () => {
  it('sends REQUEST_RENAME but leaves myDeviceLabel to the device-list round-trip', () => {
    initGuestProtocolHandlers();
    const hostConn = setupGuestRoom();

    bus.emit('network:rename-device', 'NewName');

    expect(hostConn.send).toHaveBeenCalledWith({ type: MSG.REQUEST_RENAME, newLabel: 'NewName' });
    // Core assertion: this must not be optimistically flipped to 'NewName',
    // diverging from the room whenever the host silently rejected.
    expect(getState('network.myDeviceLabel')).toBe('Peer 1');
  });
});

// ─── /nick client validation parity ────────────────────────────────────────

describe('/nick guest-side validation mirrors the host (F-2404)', () => {
  function runNick(arg: string): void {
    const cmd = parseCommand(`/nick ${arg}`);
    expect(cmd).not.toBeNull();
    executeCommand(cmd!);
  }

  it("rejects another device's name locally (was: always passed, host silently dropped)", () => {
    setupGuestRoom(['Alice']);
    const renameSpy = vi.fn();
    bus.on('network:rename-device', renameSpy);

    runNick('Alice');

    expect(addSystemChatMessageMock).toHaveBeenCalledWith('connect.rename_duplicate');
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it("rejects the host's CUSTOM label via the device list (not reachable through RESERVED_NAMES)", () => {
    const hostConn = makeHostConn();
    setState('network.hostConn', hostConn);
    setState('network.myId', 'me');
    setState('network.myDeviceLabel', 'Peer 1');
    setState('network.lastKnownDeviceList', [
      makeDevice('host-id', 'DJ Booth'),
      makeDevice('me', 'Peer 1'),
    ]);
    const renameSpy = vi.fn();
    bus.on('network:rename-device', renameSpy);

    runNick('dj booth');

    expect(addSystemChatMessageMock).toHaveBeenCalledWith('connect.rename_duplicate');
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it('strips zero-width characters before validating, like the host does', () => {
    setupGuestRoom([]);
    const renameSpy = vi.fn();
    bus.on('network:rename-device', renameSpy);

    // 'HO' + U+200B + 'ST' — trim() alone leaves the zero-width space, so the
    // The client validator must reject this before the host silently does.
    const spoofed = `HO${String.fromCharCode(0x200b)}ST`;
    runNick(spoofed);

    expect(addSystemChatMessageMock).toHaveBeenCalledWith('connect.rename_reserved');
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it('a unique valid name still goes through (positive control)', () => {
    setupGuestRoom(['Alice']);
    const renameSpy = vi.fn();
    bus.on('network:rename-device', renameSpy);

    runNick('Carol');

    expect(renameSpy).toHaveBeenCalledWith('Carol');
    expect(addSystemChatMessageMock).toHaveBeenCalledWith('chat.cmd_nick_changed');
  });

  it('does not let a coordinator-free PRO owner restore the reserved HOST identity', () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['room.configure'],
    });
    setState('network.hostConn', null);
    setState('network.myId', 'owner-member');
    setState('network.myDeviceLabel', 'Owner');
    setState('network.lastKnownDeviceList', [makeDevice('owner-member', 'Owner')]);
    const renameSpy = vi.fn();
    bus.on('network:rename-device', renameSpy);

    runNick('HOST');

    expect(addSystemChatMessageMock).toHaveBeenCalledWith('connect.rename_reserved');
    expect(renameSpy).not.toHaveBeenCalled();
  });
});
