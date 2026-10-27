/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { t } from '../../i18n/index.ts';
import type { DataConnection, PeerInstance, RoomContext } from '../../types/index.ts';

/**
 * peer.ts forwards the server-verified Standard signaling identity to the
 * room authority, which keeps a guest's "checking" feedback until that
 * identity and a fresh host roster agree. These cases drive the transport's
 * 'room-identity' event, not the authority functions directly.
 */
const mocks = vi.hoisted(() => ({
  createTransportPeer: vi.fn(),
  fetchWithCapability: vi.fn(),
  getRuntimeTransportConfig: vi.fn(),
  prepareRoomSessionFeatures: vi.fn((_signal?: AbortSignal) => Promise.resolve()),
  showDialog: vi.fn(async () => ({ action: 'cancel' })),
  showToast: vi.fn(),
}));

vi.mock('../../core/capability.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/capability.ts')>();
  return { ...actual, fetchWithCapability: mocks.fetchWithCapability };
});
vi.mock('../transport/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport/index.ts')>();
  return { ...actual, createTransportPeer: mocks.createTransportPeer };
});
vi.mock('../transport/config.ts', () => ({
  getRuntimeTransportConfig: mocks.getRuntimeTransportConfig,
}));
vi.mock('../room-session-feature-loader.ts', () => ({
  prepareRoomSessionFeatures: mocks.prepareRoomSessionFeatures,
}));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: mocks.showDialog }));
vi.mock('../../ui/toast.ts', () => ({ showToast: mocks.showToast }));

import { setPeer } from '../peer-state.ts';
import { __standardRoomPrerequisitesForTests } from '../standard-room-prerequisites.ts';
import { cancelPendingSessionSetup, createHostSessionWithShortCode } from '../peer.ts';
import {
  acceptStandardRoomHostIdentityProjection,
  beginStandardRoomAccountAuthorityCheck,
  markStandardRoomAuthorityConfirmed,
  resetStandardRoomAccountAuthorityCheck,
  roomCapabilityStatus,
  settleStandardRoomAccountAuthorityCheck,
} from '../../rooms/authority.ts';
import { roomCapabilityFeedbackMessage } from '../../rooms/permission-feedback.ts';

type FiringPeer = PeerInstance & { fire: (event: string, ...args: unknown[]) => void };

function makePeer(id: string): FiringPeer {
  const handlers = new Map<string, Set<(...args: never[]) => void>>();
  const peer = {
    id,
    open: true,
    destroyed: false,
    disconnected: false,
    connect: vi.fn(),
    reconnect: vi.fn(),
    setRtcConfiguration: vi.fn(),
    destroy: vi.fn(() => {
      peer.destroyed = true;
      peer.open = false;
    }),
    on: vi.fn((event: string, callback: (...args: never[]) => void) => {
      const callbacks = handlers.get(event) ?? new Set();
      callbacks.add(callback);
      handlers.set(event, callbacks);
    }),
    off: vi.fn((event: string, callback: (...args: never[]) => void) => {
      handlers.get(event)?.delete(callback);
    }),
    fire(event: string, ...args: unknown[]) {
      for (const callback of [...(handlers.get(event) ?? [])]) {
        callback(...(args as never[]));
      }
    },
  };
  return peer as unknown as FiringPeer;
}

const MEMBER_ID = `member_${'a'.repeat(22)}`;
const CHECKING = 'toast.media_management_checking' as const;
const REQUIRED = 'toast.media_management_required' as const;

/** A Standard guest whose account check waits on the signaling identity. */
async function pendingGuest(rosterMemberId: string | null) {
  const peer = makePeer('GUEST-PEER');
  mocks.createTransportPeer.mockResolvedValueOnce(peer);
  const code = await createHostSessionWithShortCode(1);
  const hostConn = { open: true, close: vi.fn(), peer: 'host-peer' } as unknown as DataConnection;
  setState('setup.sessionStarted', true);
  setState('network.appRole', 'guest');
  setState('network.myId', peer.id);
  setState('network.lastJoinCode', code);
  setState('network.hostConn', hostConn);
  markStandardRoomAuthorityConfirmed(hostConn);
  const check = beginStandardRoomAccountAuthorityCheck({
    roomCode: code,
    peerId: peer.id,
    role: 'guest',
  });
  expect(check).not.toBeNull();
  settleStandardRoomAccountAuthorityCheck(check, false);
  acceptStandardRoomHostIdentityProjection(hostConn, {
    id: peer.id,
    label: 'Peer',
    isHost: false,
    isOp: false,
    status: 'connected',
    isAuthenticated: rosterMemberId !== null,
    ...(rosterMemberId === null ? {} : { memberId: rosterMemberId }),
  });
  expect(roomCapabilityStatus('asset.upload')).toBe('pending');
  expect(roomCapabilityFeedbackMessage('asset.upload')).toBe(t(CHECKING));
  return { peer };
}

const identity = {
  memberId: MEMBER_ID,
  memberDisplayNumber: 1,
  nickname: 'Listener',
  isAuthenticated: true,
} as const;

beforeEach(() => {
  __standardRoomPrerequisitesForTests.reset();
  clearAllManagedTimers();
  resetStandardRoomAccountAuthorityCheck();
  resetState();
  setPeer(null);
  bus.clear();
  vi.clearAllMocks();
  setState('network.appRole', 'host');
  setState('setup.sessionStarted', false);
  mocks.getRuntimeTransportConfig.mockReturnValue({
    provider: 'cloudflare' as const,
    signalingUrl: 'https://signal.example.test/api/rooms',
    signalingFallbackUrl: 'wss://signal-alt.example.test/api/rooms',
  });
  mocks.fetchWithCapability.mockResolvedValue(
    Response.json({ provider: 'test', iceServers: [{ urls: 'turn:turn.example.test:3478' }] }),
  );
});

afterEach(() => {
  setState('setup.sessionStarted', false);
  cancelPendingSessionSetup();
  clearAllManagedTimers();
  resetStandardRoomAccountAuthorityCheck();
  vi.restoreAllMocks();
  setPeer(null);
});

describe('peer.ts Standard account identity feedback wiring', () => {
  it('ends checking when the verified signaling identity matches the host roster', async () => {
    const { peer } = await pendingGuest(MEMBER_ID);
    const badge = vi.fn();
    bus.on('network:role-badge-update', badge);

    peer.fire('room-identity', identity);

    expect(getState('network.myMemberId')).toBe(MEMBER_ID);
    expect(roomCapabilityStatus('asset.upload')).toBe('denied');
    expect(roomCapabilityFeedbackMessage('asset.upload')).toBe(t(REQUIRED));
    expect(badge).toHaveBeenCalled();
  });

  it('ends checking on a deliberate identity clear but keeps it through an expiry', async () => {
    const { peer } = await pendingGuest(null);

    // An expired identity is eligible for the account owner's retry.
    peer.fire('room-identity', null, 'expired');
    expect(roomCapabilityStatus('asset.upload')).toBe('pending');

    peer.fire('room-identity', null, 'explicit');
    expect(roomCapabilityStatus('asset.upload')).toBe('denied');
    expect(roomCapabilityFeedbackMessage('asset.upload')).toBe(t(REQUIRED));
  });

  it('ignores an identity from a replaced transport or a PRO room', async () => {
    const { peer } = await pendingGuest(MEMBER_ID);
    setPeer(makePeer('REPLACEMENT-PEER'));
    peer.fire('room-identity', identity);
    expect(roomCapabilityStatus('asset.upload')).toBe('pending');

    setPeer(peer);
    const standard = getState('room.context');
    const pro: RoomContext = { ...standard, kind: 'pro', roomId: '000001', capabilities: [] };
    setState('room.context', pro);
    peer.fire('room-identity', identity);
    setState('room.context', standard);
    expect(getState('network.myMemberId')).toBeNull();
    expect(roomCapabilityStatus('asset.upload')).toBe('pending');
  });
});
