/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import type { DataConnection } from '../../types/index.ts';
import type { FilePlaybackProductRuntimeSessionAdapter } from '../../player/file-playback-product-runtime.ts';
import type { TransportPeer } from '../transport/types.ts';

const runtimeHolder = vi.hoisted(() => ({ current: undefined as unknown }));
const transportMocks = vi.hoisted(() => ({
  createTransportPeer: vi.fn(),
}));

let lastCreatedPeer: ReturnType<typeof readyPeer> | null = null;

vi.mock('../../player/file-playback-product-runtime.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../player/file-playback-product-runtime.ts')>();
  return {
    ...actual,
    getFilePlaybackProductRuntime: () => runtimeHolder.current,
  };
});

vi.mock('../transport/index.ts', () => ({
  createTransportPeer: transportMocks.createTransportPeer,
}));

vi.mock('../../core/capability.ts', () => ({
  fetchWithCapability: vi.fn(async () => ({ ok: false, status: 503 })),
  isCapabilityChallengeCancelled: vi.fn(() => false),
}));

import { FilePlaybackProductRuntime } from '../../player/file-playback-product-runtime.ts';
import { createHostSessionWithShortCode, leaveSession } from '../peer.ts';

const PEER_SOURCE = readFileSync(resolve(process.cwd(), 'src/network/peer.ts'), 'utf8');

interface SessionSpies {
  readonly adapter: FilePlaybackProductRuntimeSessionAdapter;
  readonly beginHostRoom: ReturnType<typeof vi.fn>;
  readonly endRoom: ReturnType<typeof vi.fn>;
  readonly handleWake: ReturnType<typeof vi.fn>;
}

function sessions(): SessionSpies {
  let roomSequence = 0;
  const beginHostRoom = vi.fn((hostParticipantId: string) => {
    roomSequence += 1;
    return Object.freeze({
      applicationSessionId: `peer-product-session-${roomSequence}`,
      hostParticipantId,
    });
  });
  const endRoom = vi.fn();
  const handleWake = vi.fn(() => true);
  return {
    beginHostRoom,
    endRoom,
    handleWake,
    adapter: {
      installHooks: vi.fn(),
      beginHostRoom,
      endRoom,
      handleWake,
      nowRoomTimeMs: vi.fn(() => 1_000),
      sendRequired: vi.fn(() => true),
      closeConnection: vi.fn(),
    },
  };
}

function readyPeer(id: string): TransportPeer & {
  readonly listeners: Map<string, (...args: never[]) => void>;
} {
  const listeners = new Map<string, (...args: never[]) => void>();
  return {
    id,
    open: true,
    destroyed: false,
    disconnected: false,
    listeners,
    connect: vi.fn(),
    destroy: vi.fn(),
    reconnect: vi.fn(),
    on: vi.fn((event: string, callback: (...args: never[]) => void) => {
      listeners.set(event, callback);
    }) as TransportPeer['on'],
    off: vi.fn((event: string, callback: (...args: never[]) => void) => {
      if (listeners.get(event) === callback) listeners.delete(event);
    }) as TransportPeer['off'],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetState();
  bus.clear();
  setState('network.appRole', 'host');
  lastCreatedPeer = null;
  transportMocks.createTransportPeer.mockImplementation(async (requestedId: string | null) => {
    lastCreatedPeer = readyPeer(requestedId ?? 'guest-peer');
    return lastCreatedPeer;
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('peer product runtime lifecycle', () => {
  it('owns room lifecycle only through the gate-aware facade', () => {
    expect(PEER_SOURCE).toContain(
      "import { getFilePlaybackProductRuntime } from '../player/file-playback-product-runtime.ts';",
    );
    expect(PEER_SOURCE).not.toContain('getFilePlaybackApplicationSessionManager');
    expect(PEER_SOURCE).not.toContain("from './file-playback-application-session.ts'");
    expect(
      PEER_SOURCE.match(/getFilePlaybackProductRuntime\(\)\.beginHostRoom\(id\)/gu),
    ).toHaveLength(1);
    expect(PEER_SOURCE.match(/getFilePlaybackProductRuntime\(\)\.endRoom\(\)/gu)).toHaveLength(2);
  });

  it('keeps gate-off host creation and teardown away from session-manager authority', async () => {
    const sessionSpies = sessions();
    runtimeHolder.current = new FilePlaybackProductRuntime({
      enabled: false,
      sessions: sessionSpies.adapter,
    });

    await createHostSessionWithShortCode(1);
    leaveSession();

    expect(sessionSpies.beginHostRoom).not.toHaveBeenCalled();
    expect(sessionSpies.endRoom).not.toHaveBeenCalled();
    expect(sessionSpies.handleWake).not.toHaveBeenCalled();
  });

  it('begins one genuine host room after peer ID assignment and ends it once on teardown', async () => {
    const sessionSpies = sessions();
    const runtime = new FilePlaybackProductRuntime({
      enabled: true,
      sessions: sessionSpies.adapter,
      nowMonotonicMs: () => 500,
    });
    runtime.initializeBeforeProtocol();
    runtimeHolder.current = runtime;

    const id = await createHostSessionWithShortCode(1);

    expect(sessionSpies.beginHostRoom).toHaveBeenCalledOnce();
    expect(sessionSpies.beginHostRoom).toHaveBeenCalledWith(id);
    expect(sessionSpies.endRoom).not.toHaveBeenCalled();

    const disconnected = lastCreatedPeer?.listeners.get('disconnected');
    disconnected?.();
    expect(sessionSpies.beginHostRoom).toHaveBeenCalledOnce();

    leaveSession();
    expect(sessionSpies.endRoom).toHaveBeenCalledOnce();
  });

  it('delegates wake only for an initialized gate-on runtime', () => {
    const offSessions = sessions();
    const off = new FilePlaybackProductRuntime({ enabled: false, sessions: offSessions.adapter });
    expect(off.handleWake({ peer: 'off' } as DataConnection)).toBe(false);
    expect(offSessions.handleWake).not.toHaveBeenCalled();

    const onSessions = sessions();
    const on = new FilePlaybackProductRuntime({ enabled: true, sessions: onSessions.adapter });
    const connection = { peer: 'on' } as DataConnection;
    expect(on.handleWake(connection)).toBe(false);
    on.initializeBeforeProtocol();
    expect(on.handleWake(connection)).toBe(true);
    expect(onSessions.handleWake).toHaveBeenCalledOnce();
    expect(onSessions.handleWake).toHaveBeenCalledWith(connection);
  });
});
