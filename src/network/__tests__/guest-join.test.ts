import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { t } from '../../i18n/index.ts';
import { FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID } from '../../player/file-playback-semantic-cohort.ts';
import type { DataConnection, PeerInstance } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  getPeer: vi.fn(),
  detectConnectionType: vi.fn(),
  startWorkerTimer: vi.fn(),
  showToast: vi.fn(),
  beginGuestRoom: vi.fn(() => true),
  endRoom: vi.fn(),
}));

// This suite exercises the V2 handshake path explicitly. Legacy gate-off
// behavior has its own isolated module-reset callsite suite.
vi.mock('../../player/file-playback-engine-gate.ts', () => ({
  isFilePlaybackEngineV2Enabled: () => true,
  getFilePlaybackEngineMode: () => 'v2',
}));

vi.mock('../../player/file-playback-product-runtime.ts', () => ({
  getFilePlaybackProductRuntime: () => ({
    beginGuestRoom: mocks.beginGuestRoom,
    endRoom: mocks.endRoom,
  }),
}));

vi.mock('../../core/log.ts', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: mocks.showToast,
}));

vi.mock('../peer-state.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../peer-state.ts')>();
  return {
    ...actual,
    getPeer: mocks.getPeer,
    detectConnectionType: mocks.detectConnectionType,
  };
});

vi.mock('../sync-worker.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync-worker.ts')>();
  return {
    ...actual,
    startWorkerTimer: mocks.startWorkerTimer,
  };
});

import { joinSession, setInitNetwork } from '../guest.ts';
import { getFilePlaybackApplicationSessionManager } from '../file-playback-application-session.ts';
import {
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackHostSessionHandshake,
} from '../file-playback-session-handshake.ts';
import { markQueueAuthorityReady } from '../queue-authority.ts';
import { MSG } from '../../core/constants.ts';

type FiringConn = DataConnection & {
  fire: (event: string, ...args: unknown[]) => void;
  open: boolean;
};

function makeFakeConn(peerId: string): FiringConn {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    peer: peerId,
    open: false,
    send: vi.fn(),
    close: vi.fn(),
    off: vi.fn(),
    on(event: string, cb: (...args: unknown[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    fire(event: string, ...args: unknown[]) {
      if (event === 'open') (this as { open: boolean }).open = true;
      for (const cb of [...(handlers.get(event) ?? [])]) cb(...args);
    },
  } as unknown as FiringConn;
}

function makeFakePeer(): {
  peer: PeerInstance;
  conns: FiringConn[];
  connect: ReturnType<typeof vi.fn>;
} {
  const conns: FiringConn[] = [];
  const connect = vi.fn((hostId: string) => {
    const conn = makeFakeConn(hostId);
    conns.push(conn);
    return conn;
  });
  const peer = { open: true, connect } as unknown as PeerInstance;
  return { peer, conns, connect };
}

beforeEach(() => {
  vi.useRealTimers();
  clearAllManagedTimers();
  resetState();
  getFilePlaybackApplicationSessionManager().endRoom();
  setState('network.myId', 'guest-test-participant');
  bus.clear();
  vi.clearAllMocks();
  mocks.detectConnectionType.mockResolvedValue('local');
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('joinSession reconnect racing', () => {
  it('begins one guest room only when a recursive peer-ready retry reaches connect', async () => {
    const { peer, connect, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValueOnce(null).mockReturnValue(peer);
    setInitNetwork(() => Promise.resolve('guest-test-participant'));
    const manager = getFilePlaybackApplicationSessionManager();
    const beginConnection = vi.spyOn(manager, 'beginGuestConnection');

    joinSession('HOST01');
    expect(mocks.beginGuestRoom).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.beginGuestRoom).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();

    conns[0].fire('open');
    expect(beginConnection).toHaveBeenCalledOnce();
    expect(mocks.beginGuestRoom.mock.invocationCallOrder[0]).toBeLessThan(
      beginConnection.mock.invocationCallOrder[0],
    );
  });

  it('ends the V2 room when peer.connect throws before transport ownership', () => {
    const connect = vi.fn(() => {
      throw new Error('connect boom');
    });
    mocks.getPeer.mockReturnValue({ open: true, connect } as unknown as PeerInstance);
    const errors = vi.fn();
    bus.on('network:error', errors);

    joinSession('HOST01');

    expect(mocks.beginGuestRoom).toHaveBeenCalledOnce();
    expect(mocks.endRoom).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'CONNECT_FAILED' }));
    expect(getState('network.isConnecting')).toBe(false);
  });

  it('queues bounded legacy setup data that arrives before RTC open and flushes after exact bind', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const inbound = vi.fn();
    bus.on('network:data', inbound);

    joinSession('HOST01');
    const conn = conns[0];
    conn.fire('data', {
      type: MSG.WELCOME,
      label: 'HOST',
      lockChannel: false,
      chatFrozen: false,
      slowmodeSeconds: 0,
      filterEnabled: false,
    });
    expect(inbound).not.toHaveBeenCalled();

    conn.fire('open');

    expect(inbound).toHaveBeenCalledTimes(1);
    expect(inbound).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.WELCOME }), conn);
    expect(getState('network.hostConn')).toBe(conn);
    expect(getFilePlaybackApplicationSessionManager().phase(conn)).toBe('handshaking');
  });

  it('fails closed on arbitrary application data before RTC open', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const inbound = vi.fn();
    bus.on('network:data', inbound);

    joinSession('HOST01');
    const conn = conns[0];
    conn.fire('data', { type: MSG.PLAY, currentTime: 0 });
    conn.fire('open');

    expect(conn.close).toHaveBeenCalled();
    expect(inbound).not.toHaveBeenCalled();
    expect(getState('network.hostConn')).toBeNull();
    expect(getState('network.isConnecting')).toBe(false);
    expect(getFilePlaybackApplicationSessionManager().phase(conn)).toBe('none');
  });

  it('caps the pre-open legacy queue by both frame count and encoded bytes', () => {
    const first = makeFakePeer();
    mocks.getPeer.mockReturnValue(first.peer);
    joinSession('HOST01');
    const countLimited = first.conns[0];
    for (let index = 0; index < 4; index += 1) {
      countLimited.fire('data', { type: MSG.FORCE_CLOSE_DUPLICATE });
    }
    expect(countLimited.close).toHaveBeenCalled();
    expect(getState('network.isConnecting')).toBe(false);

    resetState();
    getFilePlaybackApplicationSessionManager().endRoom();
    setState('network.myId', 'guest-test-participant');
    const second = makeFakePeer();
    mocks.getPeer.mockReturnValue(second.peer);
    joinSession('HOST02');
    const byteLimited = second.conns[0];
    byteLimited.fire('data', { type: MSG.WELCOME, label: 'x'.repeat(2_100) });
    expect(byteLimited.close).toHaveBeenCalled();
    expect(getState('network.isConnecting')).toBe(false);
  });

  it('expires an RTC-open guest handshake without publishing join success', () => {
    vi.useFakeTimers();
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const connected = vi.fn();
    const joinSuccess = vi.fn();
    bus.on('network:peer-connected', connected);
    bus.on('setup:guest-join-success', joinSuccess);

    joinSession('HOST01');
    const conn = conns[0];
    conn.fire('open');
    vi.advanceTimersByTime(10_000);

    expect(conn.close).toHaveBeenCalled();
    expect(getFilePlaybackApplicationSessionManager().phase(conn)).toBe('none');
    expect(connected).not.toHaveBeenCalled();
    expect(joinSuccess).not.toHaveBeenCalled();
    conn.fire('close');
    expect(getState('network.isConnecting')).toBe(false);
  });

  it('publishes guest join success only after exact bootstrap and APPLIED send succeed', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const peerConnected = vi.fn();
    const joinSuccess = vi.fn();
    bus.on('network:peer-connected', peerConnected);
    bus.on('setup:guest-join-success', joinSuccess);
    bus.on('network:peer-bootstrap-apply', (frame, conn, acknowledge) => {
      const message = frame as { type?: string };
      if (message.type === MSG.PLAYLIST_UPDATE) markQueueAuthorityReady(conn);
      acknowledge(true);
    });

    const hostIssuer = new FilePlaybackHandshakeIdIssuer();
    const host = new FilePlaybackHostSessionHandshake({
      idIssuer: hostIssuer,
      sessionId: hostIssuer.issueSessionId(),
      connectionId: hostIssuer.issueConnectionId(),
      hostParticipantId: 'HOST01',
      guestParticipantId: 'guest-test-participant',
    });

    joinSession('HOST01');
    const conn = conns[0];
    conn.fire('open');
    expect(peerConnected).not.toHaveBeenCalled();
    expect(joinSuccess).not.toHaveBeenCalled();
    expect(getState('network.isConnecting')).toBe(true);

    const hello = vi.mocked(conn.send).mock.calls[0]?.[0];
    const welcome = host.handleHello(hello);
    if (!welcome.accepted) throw new Error(welcome.reason);
    conn.fire('data', welcome.welcome);
    expect(peerConnected).not.toHaveBeenCalled();

    conn.fire('data', {
      type: MSG.PLAYLIST_UPDATE,
      list: [],
      currentQueueItemId: null,
      revision: 0,
      bootstrap: true,
    });
    conn.fire('data', { type: MSG.REPEAT_MODE, value: 0, _bootstrap: true });
    conn.fire('data', { type: MSG.SHUFFLE_MODE, value: false, _bootstrap: true });
    const snapshot = host.createSnapshot();
    if (!snapshot.accepted) throw new Error(snapshot.reason);
    conn.fire('data', snapshot.snapshot);

    expect(peerConnected).toHaveBeenCalledTimes(1);
    expect(peerConnected).toHaveBeenCalledWith(conn);
    expect(joinSuccess).toHaveBeenCalledTimes(1);
    expect(getState('network.isConnecting')).toBe(false);
    const applied = vi
      .mocked(conn.send)
      .mock.calls.map(([value]) => value as { type?: string })
      .find((value) => value.type === 'FILE_PLAYBACK_SESSION_APPLIED_V2');
    expect(applied).toBeDefined();

    conn.fire('close');
    expect(mocks.endRoom).toHaveBeenCalledOnce();
  });

  it('reports an exact pre-cohort host frame once and suppresses generic close and error UI', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const networkErrors = vi.fn();
    const joinFailures = vi.fn();
    bus.on('network:error', networkErrors);
    bus.on('setup:guest-join-failure', joinFailures);
    const hostIssuer = new FilePlaybackHandshakeIdIssuer();
    const host = new FilePlaybackHostSessionHandshake({
      idIssuer: hostIssuer,
      sessionId: hostIssuer.issueSessionId(),
      connectionId: hostIssuer.issueConnectionId(),
      hostParticipantId: 'HOST01',
      guestParticipantId: 'guest-test-participant',
    });

    joinSession('HOST01');
    const conn = conns[0];
    conn.fire('open');
    const hello = vi.mocked(conn.send).mock.calls[0]?.[0];
    const welcome = host.handleHello(hello);
    if (!welcome.accepted) throw new Error(welcome.reason);
    const { semanticPlaybackCohortId: _cohort, ...preCohortWelcome } = welcome.welcome;

    conn.fire('data', preCohortWelcome);

    expect(getFilePlaybackApplicationSessionManager().phase(conn)).toBe('none');
    expect(conn.close).toHaveBeenCalledOnce();
    expect(getState('network.isConnecting')).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledOnce();
    expect(mocks.showToast).toHaveBeenCalledWith(t('error.app_version_mismatch'));
    expect(joinFailures).toHaveBeenCalledOnce();
    expect((joinFailures.mock.calls[0]?.[0] as Error).message).toBe(
      'FILE_PLAYBACK_UPDATE_REQUIRED',
    );
    expect(networkErrors).not.toHaveBeenCalled();

    conn.fire('close');
    conn.fire('error', new Error('late transport error'));
    expect(mocks.showToast).toHaveBeenCalledOnce();
    expect(joinFailures).toHaveBeenCalledOnce();
    expect(networkErrors).not.toHaveBeenCalled();
  });

  it('reports a current-schema host frame from a different semantic cohort once', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const networkErrors = vi.fn();
    const joinFailures = vi.fn();
    bus.on('network:error', networkErrors);
    bus.on('setup:guest-join-failure', joinFailures);
    const hostIssuer = new FilePlaybackHandshakeIdIssuer();
    const host = new FilePlaybackHostSessionHandshake({
      idIssuer: hostIssuer,
      sessionId: hostIssuer.issueSessionId(),
      connectionId: hostIssuer.issueConnectionId(),
      hostParticipantId: 'HOST01',
      guestParticipantId: 'guest-test-participant',
    });

    joinSession('HOST01');
    const conn = conns[0];
    conn.fire('open');
    const hello = vi.mocked(conn.send).mock.calls[0]?.[0];
    const welcome = host.handleHello(hello);
    if (!welcome.accepted) throw new Error(welcome.reason);
    const otherCohortWelcome = {
      ...welcome.welcome,
      semanticPlaybackCohortId: FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
    };

    conn.fire('data', otherCohortWelcome);

    expect(getFilePlaybackApplicationSessionManager().phase(conn)).toBe('none');
    expect(conn.close).toHaveBeenCalledOnce();
    expect(getState('network.isConnecting')).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledOnce();
    expect(mocks.showToast).toHaveBeenCalledWith(t('error.app_version_mismatch'));
    expect(joinFailures).toHaveBeenCalledOnce();
    expect((joinFailures.mock.calls[0]?.[0] as Error).message).toBe(
      'FILE_PLAYBACK_UPDATE_REQUIRED',
    );
    expect(networkErrors).not.toHaveBeenCalled();

    conn.fire('close');
    conn.fire('error', new Error('late transport error'));
    expect(mocks.showToast).toHaveBeenCalledOnce();
    expect(joinFailures).toHaveBeenCalledOnce();
    expect(networkErrors).not.toHaveBeenCalled();
  });

  it('uses neutral copy for an unclassified V2 handshake close', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const networkErrors = vi.fn();
    const joinFailures = vi.fn();
    bus.on('network:error', networkErrors);
    bus.on('setup:guest-join-failure', joinFailures);

    joinSession('HOST01');
    const conn = conns[0];
    conn.fire('open');
    conn.fire('close');

    expect(mocks.showToast).toHaveBeenCalledOnce();
    expect(mocks.showToast).toHaveBeenCalledWith(t('error.session_handshake_failed'));
    expect(mocks.showToast).not.toHaveBeenCalledWith(t('error.app_version_mismatch'));
    expect(joinFailures).toHaveBeenCalledOnce();
    expect((joinFailures.mock.calls[0]?.[0] as Error).message).toBe(
      'FILE_PLAYBACK_HANDSHAKE_FAILED',
    );
    expect(networkErrors).not.toHaveBeenCalled();
  });

  it('ignores a duplicate joinSession call while the first attempt is still connecting', () => {
    vi.useFakeTimers();
    const { peer, connect } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);

    joinSession('HOST01');
    expect(getState('network.isConnecting')).toBe(true);

    joinSession('HOST01');
    joinSession('HOST02');

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith('HOST01', expect.anything());
  });

  it('does not let a replaced connection’s late close nullify the new host connection', async () => {
    vi.useFakeTimers();
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const errors = vi.fn();
    bus.on('network:error', errors);

    joinSession('HOST01');
    const first = conns[0];
    first.fire('open');
    expect(getState('network.hostConn')).toBe(first);
    // This suite isolates replacement lifecycle. APPLIED completion owns this
    // transition in product; mark the fixture established for the legacy race.
    setState('network.isConnecting', false);

    // Transport blip: the channel is dead but PeerJS has not delivered the
    // close event yet, and the user re-joins in that window.
    first.open = false;
    joinSession('HOST01');
    expect(getFilePlaybackApplicationSessionManager().phase(first)).toBe('none');
    expect(mocks.endRoom).toHaveBeenCalledOnce();
    expect(mocks.beginGuestRoom).toHaveBeenCalledTimes(2);
    expect(mocks.endRoom.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.beginGuestRoom.mock.invocationCallOrder[1],
    );
    const second = conns[1];
    second.fire('open');
    setState('network.isConnecting', false);
    expect(getState('network.hostConn')).toBe(second);

    first.fire('close');

    expect(getState('network.hostConn')).toBe(second);
    expect(getState('network.isConnecting')).toBe(false);

    // The successful open also cleared the join timeout — advancing past it
    // must not surface HOST_UNREACHABLE against the live connection. The
    // replaced conn's close must not surface HOST_DISCONNECTED either: the
    // consumer would show a "disconnected — reconnect?" dialog (and stop
    // YouTube playback) over the live session.
    await vi.advanceTimersByTimeAsync(10_000);
    const errorMessages = errors.mock.calls.map((call) => (call[0] as Error)?.message);
    expect(errorMessages).not.toContain('HOST_UNREACHABLE');
    expect(errorMessages).not.toContain('HOST_DISCONNECTED');
    expect(getState('network.hostConn')).toBe(second);
  });

  it('ignores connection-type detection that resolves from a replaced host connection', async () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    let resolveFirst!: (value: 'remote') => void;
    let resolveSecond!: (value: 'local') => void;
    mocks.detectConnectionType
      .mockImplementationOnce(() => new Promise<'remote'>((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise<'local'>((resolve) => (resolveSecond = resolve)));

    joinSession('HOST01');
    const first = conns[0];
    first.fire('open');
    setState('network.isConnecting', false);
    first.open = false;

    joinSession('HOST01');
    const second = conns[1];
    second.fire('open');
    setState('network.isConnecting', false);
    expect(getState('network.hostConn')).toBe(second);

    resolveFirst('remote');
    await Promise.resolve();
    expect(getState('network.connectionType')).toBe('unknown');

    resolveSecond('local');
    await Promise.resolve();
    expect(getState('network.connectionType')).toBe('local');
  });

  it('a replaced connection closing mid-connect neither resets isConnecting nor surfaces errors', () => {
    vi.useFakeTimers();
    const { peer, conns, connect } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const errors = vi.fn();
    bus.on('network:error', errors);

    joinSession('HOST01');
    const first = conns[0];
    first.fire('open');
    setState('network.isConnecting', false);

    // Rejoining during an undetected transport failure replaces the stale
    // connection while the successor is still connecting.
    first.open = false;
    joinSession('HOST01');
    expect(getState('network.isConnecting')).toBe(true);

    // conn1's late close/error land BEFORE conn2 opens. They must be inert:
    // no isConnecting reset (would defeat the duplicate-join guard), no
    // spurious HOST_DISCONNECTED / HOST_CONNECTION_ERROR dialog.
    first.fire('close');
    first.fire('error', new Error('boom'));

    expect(getState('network.isConnecting')).toBe(true);
    expect(errors).not.toHaveBeenCalled();

    joinSession('HOST01');
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('times out with HOST_UNREACHABLE when the data channel never opens within 10s', () => {
    vi.useFakeTimers();
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const errors = vi.fn();
    bus.on('network:error', errors);

    joinSession('HOST01');
    const conn = conns[0];

    vi.advanceTimersByTime(9_999);
    expect(errors).not.toHaveBeenCalled();
    expect(getState('network.isConnecting')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(getState('network.isConnecting')).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);
    expect((errors.mock.calls[0][0] as Error).message).toBe('HOST_UNREACHABLE');
  });
});

describe('joinSession capability-challenge cancel (F-2401)', () => {
  it('routes a cancelled init to a silent join-UI restore, not a network:error toast', async () => {
    mocks.getPeer.mockReturnValue(null);
    setInitNetwork(() => Promise.reject(new Error('NETWORK_INIT_CANCELLED')));

    const errors = vi.fn();
    const cancelled = vi.fn();
    bus.on('network:error', errors);
    bus.on('setup:guest-join-cancelled', cancelled);

    joinSession('HOST01');
    // Flush the _initNetwork(null).then().catch() chain (real timers).
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Cancellation restores the join UI without surfacing a connection error.
    expect(errors).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(getState('network.isConnecting')).toBe(false);
  });
});
