/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataConnection, PeerInstance } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  getApplicationSessions: vi.fn(),
  getProductRuntime: vi.fn(),
  getPeer: vi.fn(),
  detectConnectionType: vi.fn(() => Promise.resolve('local' as const)),
  startWorkerTimer: vi.fn(),
}));

vi.mock('../../player/file-playback-engine-gate.ts', () => ({
  isFilePlaybackEngineV2Enabled: () => false,
  getFilePlaybackEngineMode: () => 'legacy',
}));

vi.mock('../file-playback-application-session.ts', () => ({
  getFilePlaybackApplicationSessionManager: mocks.getApplicationSessions,
}));

vi.mock('../../player/file-playback-product-runtime.ts', () => ({
  getFilePlaybackProductRuntime: mocks.getProductRuntime,
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
  return { ...actual, startWorkerTimer: mocks.startWorkerTimer };
});

vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn() }));
vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { applyPlaylistSnapshot } from '../../player/queue-model.ts';
import { PEER_RANGE_PROTOCOL } from '../../player/sources/peer-range-protocol.ts';
import { hasQueueAuthority, markQueueAuthorityReady } from '../queue-authority.ts';
import {
  FILE_PLAYBACK_CLOCK_PING_TYPE,
  FILE_PLAYBACK_CLOCK_PONG_TYPE,
} from '../file-playback-clock-exchange.ts';
import {
  FILE_PLAYBACK_SESSION_APPLIED_TYPE,
  FILE_PLAYBACK_SESSION_HELLO_TYPE,
  FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE,
  FILE_PLAYBACK_SESSION_WELCOME_TYPE,
} from '../file-playback-session-handshake.ts';
import {
  FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE,
  FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_READY_V2_TYPE,
  FILE_PLAYBACK_RUN_BINDING_V2_TYPE,
} from '../file-playback-transport-contract.ts';
import { joinSession } from '../guest.ts';
import { handleHostIncomingConnection } from '../host.ts';
import { handleData, initProtocol, registerHandler } from '../protocol.ts';

type FiringConn = DataConnection & {
  fire(event: string, ...args: unknown[]): void;
  open: boolean;
};

const FORBIDDEN_V2_TYPES = new Set<string>([
  FILE_PLAYBACK_SESSION_HELLO_TYPE,
  FILE_PLAYBACK_SESSION_WELCOME_TYPE,
  FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE,
  FILE_PLAYBACK_SESSION_APPLIED_TYPE,
  FILE_PLAYBACK_CLOCK_PING_TYPE,
  FILE_PLAYBACK_CLOCK_PONG_TYPE,
  FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
  FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE,
  FILE_PLAYBACK_RUN_BINDING_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_READY_V2_TYPE,
]);

function expectNoV2Frames(conn: FiringConn): void {
  const frames = vi.mocked(conn.send).mock.calls.map(([frame]) => frame as Record<string, unknown>);
  expect(frames.filter((frame) => FORBIDDEN_V2_TYPES.has(String(frame.type)))).toEqual([]);
  expect(frames.filter((frame) => frame.protocol === PEER_RANGE_PROTOCOL)).toEqual([]);
}

function makeConnection(peerId: string, initiallyOpen = false): FiringConn {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    peer: peerId,
    open: initiallyOpen,
    send: vi.fn(),
    close: vi.fn(),
    off: vi.fn(),
    on(event: string, callback: (...args: unknown[]) => void) {
      const current = handlers.get(event) ?? [];
      current.push(callback);
      handlers.set(event, current);
    },
    fire(event: string, ...args: unknown[]) {
      if (event === 'open') this.open = true;
      for (const callback of [...(handlers.get(event) ?? [])]) callback(...args);
    },
  } as unknown as FiringConn;
}

beforeEach(() => {
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  mocks.detectConnectionType.mockResolvedValue('local');
});

afterEach(() => {
  clearAllManagedTimers();
});

describe('fixed gate-off connection callsites', () => {
  it('hosts with WELCOME then legacy queue bootstrap and never touches V2', () => {
    setState('network.myId', 'HOST01');
    const conn = makeConnection('guest-off');
    const connected = vi.fn();
    const inbound = vi.fn();
    bus.on('network:peer-connected', connected);
    bus.on('network:data', inbound);
    bus.on('network:peer-bootstrap', (current, send, acknowledge) => {
      expect(current).toBe(conn);
      acknowledge(
        send({
          type: MSG.PLAYLIST_UPDATE,
          list: [],
          currentQueueItemId: null,
          revision: 0,
          bootstrap: true,
        }) &&
          send({ type: MSG.REPEAT_MODE, value: 0, _bootstrap: true }) &&
          send({ type: MSG.SHUFFLE_MODE, value: false, _bootstrap: true }),
      );
    });

    handleHostIncomingConnection(conn);
    conn.fire('open');

    const sentTypes = vi
      .mocked(conn.send)
      .mock.calls.map(([frame]) => (frame as { type?: string }).type);
    expect(sentTypes.slice(0, 4)).toEqual([
      MSG.WELCOME,
      MSG.PLAYLIST_UPDATE,
      MSG.REPEAT_MODE,
      MSG.SHUFFLE_MODE,
    ]);
    expectNoV2Frames(conn);
    expect(connected).toHaveBeenCalledWith(conn);
    expect(getState('network.connectedPeers').find((peer) => peer.id === conn.peer)?.status).toBe(
      'connected',
    );

    conn.fire('data', { type: MSG.CHAT, text: 'legacy generic' });
    expect(inbound).toHaveBeenCalledWith({ type: MSG.CHAT, text: 'legacy generic' }, conn);
    conn.fire('close');
    expect(getState('network.connectedPeers').some((peer) => peer.id === conn.peer)).toBe(false);
    expect(mocks.getApplicationSessions).not.toHaveBeenCalled();
    expect(mocks.getProductRuntime).not.toHaveBeenCalled();
  });

  it('keeps the legacy connection open when bootstrap acknowledges without all three frames', () => {
    setState('network.myId', 'HOST01');
    const conn = makeConnection('guest-incomplete-bootstrap');
    const connected = vi.fn();
    bus.on('network:peer-connected', connected);
    bus.on('network:peer-bootstrap', (_current, send, acknowledge) => {
      expect(
        send({
          type: MSG.PLAYLIST_UPDATE,
          list: [],
          currentQueueItemId: null,
          revision: 0,
          bootstrap: true,
        }),
      ).toBe(true);
      acknowledge(true);
    });

    handleHostIncomingConnection(conn);
    conn.fire('open');

    expect(conn.close).not.toHaveBeenCalled();
    expect(connected).toHaveBeenCalledWith(conn);
    expect(getState('network.connectedPeers').find((peer) => peer.id === conn.peer)?.status).toBe(
      'connected',
    );
    expectNoV2Frames(conn);
    expect(mocks.getApplicationSessions).not.toHaveBeenCalled();
  });

  it('keeps the legacy connection open when a bootstrap send fails transiently', () => {
    setState('network.myId', 'HOST01');
    const conn = makeConnection('guest-transient-bootstrap');
    const connected = vi.fn();
    bus.on('network:peer-connected', connected);
    vi.mocked(conn.send).mockImplementation((frame) => {
      if ((frame as { type?: string }).type === MSG.REPEAT_MODE) {
        throw new Error('transient data-channel send failure');
      }
    });
    bus.on('network:peer-bootstrap', (_current, send, acknowledge) => {
      acknowledge(
        send({
          type: MSG.PLAYLIST_UPDATE,
          list: [],
          currentQueueItemId: null,
          revision: 0,
          bootstrap: true,
        }) &&
          send({ type: MSG.REPEAT_MODE, value: 0, _bootstrap: true }) &&
          send({ type: MSG.SHUFFLE_MODE, value: false, _bootstrap: true }),
      );
    });

    handleHostIncomingConnection(conn);
    conn.fire('open');

    expect(conn.close).not.toHaveBeenCalled();
    expect(connected).toHaveBeenCalledWith(conn);
    expect(getState('network.connectedPeers').find((peer) => peer.id === conn.peer)?.status).toBe(
      'connected',
    );
    expectNoV2Frames(conn);
    expect(mocks.getApplicationSessions).not.toHaveBeenCalled();
  });

  it('joins on RTC open, applies generic legacy bootstrap, and emits no HELLO', async () => {
    const conn = makeConnection('HOST01');
    const connect = vi.fn(() => conn);
    mocks.getPeer.mockReturnValue({ open: true, connect } as unknown as PeerInstance);
    setState('network.appRole', 'guest');
    setState('network.myId', 'guest-off');
    const connected = vi.fn();
    const joined = vi.fn();
    bus.on('network:peer-connected', connected);
    bus.on('setup:guest-join-success', joined);
    initProtocol();
    registerHandler(MSG.PLAYLIST_UPDATE, (data, current) => {
      if (applyPlaylistSnapshot(data, 'rebase') === 'rebased') {
        markQueueAuthorityReady(current);
      }
    });
    registerHandler(MSG.REPEAT_MODE, (data) => {
      setState('playlist.repeatMode', Number(data.value));
    });
    registerHandler(MSG.SHUFFLE_MODE, (data) => {
      setState('playlist.isShuffle', data.value === true);
    });

    joinSession('HOST01');
    conn.fire('open');

    expect(getState('network.hostConn')).toBe(conn);
    expect(getState('network.isConnecting')).toBe(false);
    expect(connected).toHaveBeenCalledWith(conn);
    expect(joined).toHaveBeenCalledOnce();
    expect(conn.send).not.toHaveBeenCalled();
    expectNoV2Frames(conn);
    expect(mocks.startWorkerTimer).toHaveBeenCalledWith('sync', 1000);

    conn.fire('data', {
      type: MSG.PLAYLIST_UPDATE,
      list: [],
      currentQueueItemId: null,
      revision: 7,
      bootstrap: true,
    });
    conn.fire('data', { type: MSG.REPEAT_MODE, value: 2, _bootstrap: true });
    conn.fire('data', { type: MSG.SHUFFLE_MODE, value: true, _bootstrap: true });
    await Promise.resolve();

    expect(hasQueueAuthority(conn)).toBe(true);
    expect(getState('playlist.revision')).toBe(7);
    expect(getState('playlist.repeatMode')).toBe(2);
    expect(getState('playlist.isShuffle')).toBe(true);
    expect(mocks.getApplicationSessions).not.toHaveBeenCalled();
    expect(mocks.getProductRuntime).not.toHaveBeenCalled();

    conn.fire('close');
    expect(getState('network.hostConn')).toBeNull();
    expect(mocks.getApplicationSessions).not.toHaveBeenCalled();
  });

  it('keeps generic protocol validation while never consulting the V2 manager', async () => {
    const conn = makeConnection('guest-protocol-off', true);
    setState('network.appRole', 'host');
    setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
    const handler = vi.fn();
    registerHandler(MSG.CHAT, handler);

    await handleData({ type: MSG.CHAT, text: 'accepted' }, conn);
    await handleData({ type: MSG.CHAT, text: 42 }, conn);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ type: MSG.CHAT, text: 'accepted' }, conn);
    expect(mocks.getApplicationSessions).not.toHaveBeenCalled();
  });
});
