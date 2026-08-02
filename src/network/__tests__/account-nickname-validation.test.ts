/**
 * @vitest-environment jsdom
 *
 * Regression tests for account nickname validation parity.
 *
 * `/nick` updates the authenticated account profile. Client validation keeps
 * reserved namespaces aligned with room identity projection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { addSystemChatMessage } from '../../ui/chat-render.ts';
import type { DataConnection, DeviceInfo } from '../../types/index.ts';
import {
  __resetAccountStateForTests,
  applyAccountSession,
  setAccountAnonymous,
} from '../../account/state.ts';

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

import { parseCommand, executeCommand } from '../../chat/commands.ts';

const addSystemChatMessageMock = vi.mocked(addSystemChatMessage);

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
  __resetAccountStateForTests();
  applyAccountSession({
    configured: true,
    authenticated: true,
    account: { nickname: 'Current', profileComplete: true },
    statsScope: 's'.repeat(43),
  });
  resetState();
  bus.clear();
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const nickname = JSON.parse(String(init?.body || '{}')).nickname || 'Current';
      return new Response(
        JSON.stringify({
          configured: true,
          authenticated: true,
          account: { nickname, profileComplete: true },
          statsScope: 's'.repeat(43),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── /nick client validation parity ────────────────────────────────────────

describe('/nick account nickname validation', () => {
  function runNick(arg: string): void {
    const cmd = parseCommand(`/nick ${arg}`);
    expect(cmd).not.toBeNull();
    executeCommand(cmd!);
  }

  it('opens optional login for an anonymous user', () => {
    setAccountAnonymous(true);
    const accountOpenSpy = vi.fn();
    const stopAccountOpen = bus.on('account:open', accountOpenSpy);

    runNick('Carol');

    expect(accountOpenSpy).toHaveBeenCalledOnce();
    stopAccountOpen();
  });

  it("allows another account's display name through the account profile", async () => {
    setupGuestRoom(['Alice']);

    runNick('Alice');

    await vi.waitFor(() =>
      expect(addSystemChatMessageMock).toHaveBeenCalledWith('chat.cmd_nick_changed'),
    );
  });

  it("allows the host account's display name without trusting the local device list", async () => {
    const hostConn = makeHostConn();
    setState('network.hostConn', hostConn);
    setState('network.myId', 'me');
    setState('network.myDeviceLabel', 'Peer 1');
    setState('network.lastKnownDeviceList', [
      makeDevice('host-id', 'DJ_Booth'),
      makeDevice('me', 'Peer 1'),
    ]);
    runNick('dj_booth');

    await vi.waitFor(() =>
      expect(addSystemChatMessageMock).toHaveBeenCalledWith('chat.cmd_nick_changed'),
    );
  });

  it('strips zero-width characters before validating', () => {
    setupGuestRoom([]);

    // 'HO' + U+200B + 'ST' — trim() alone leaves the zero-width space, so the
    // The account validator must reject this visually identical reserved name.
    const spoofed = `HO${String.fromCharCode(0x200b)}ST`;
    runNick(spoofed);

    expect(addSystemChatMessageMock).toHaveBeenCalledWith('connect.rename_reserved');
  });

  it('a unique valid name goes through the account profile', async () => {
    setupGuestRoom(['Alice']);

    runNick('Carol');

    await vi.waitFor(() =>
      expect(addSystemChatMessageMock).toHaveBeenCalledWith('chat.cmd_nick_changed'),
    );
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
    runNick('HOST');

    expect(addSystemChatMessageMock).toHaveBeenCalledWith('connect.rename_reserved');
  });

  it('keeps the server-owned Peer N namespace unavailable to PRO /nick', () => {
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
    setState('network.myId', 'member-1');
    setState('network.myDeviceLabel', 'Peer 1');
    setState('network.lastKnownDeviceList', [makeDevice('member-1', 'Peer 1')]);
    runNick('pEeR');

    expect(addSystemChatMessageMock).toHaveBeenCalledWith('connect.rename_reserved');
  });
});
