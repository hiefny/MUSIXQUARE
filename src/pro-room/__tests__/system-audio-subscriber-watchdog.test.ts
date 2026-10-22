/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus, createBusScope, type BusScope } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { ProRoomApiClient } from '../api.ts';
import type { ProRoomSnapshot, ProRoomSystemAudioState } from '../contracts.ts';

// The PRO coordinator and the real guest receive placeholder together: only
// the native SFU and LAN-direct transports, Web Audio and media teardown are
// replaced.
const mocks = vi.hoisted(() => ({
  sfuListener: null as ((event: Record<string, unknown>) => void) | null,
  subscribe: vi.fn<(descriptor: Record<string, unknown>) => Promise<void>>(),
  stopAllMedia: vi.fn(),
  initAudio: vi.fn(async () => undefined),
  getAudioContext: vi.fn(),
  getWidener: vi.fn(),
  cleanupSfuGuestRoute: vi.fn(),
}));

vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../audio/context.ts', () => ({ getAudioContext: mocks.getAudioContext }));
vi.mock('../../audio/engine.ts', () => ({
  initAudio: mocks.initAudio,
  getWidener: mocks.getWidener,
}));
vi.mock('../../chat/protocol.ts', () => ({ broadcastSystemMessage: vi.fn() }));
vi.mock('../../player/transport.ts', () => ({ stopAllMedia: mocks.stopAllMedia }));
vi.mock('../../network/pro-system-audio-sfu.ts', () => ({
  beginProSystemAudioSfuPublisherPreflight: vi.fn(),
  cancelProSystemAudioSfuPublisherPreflight: vi.fn(),
  onProSystemAudioSfuEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => {
    mocks.sfuListener = listener;
  }),
  publishProSystemAudioSfu: vi.fn(),
  stopProSystemAudioSfuPublisher: vi.fn(),
  stopProSystemAudioSfuSubscriber: vi.fn(),
  updateProSystemAudioSfuPublisherExpiry: vi.fn(),
  subscribeProSystemAudioSfu: mocks.subscribe,
}));
vi.mock('../../network/pro-system-audio-direct.ts', () => ({
  configureProSystemAudioDirectTransport: vi.fn(),
  attemptProSystemAudioDirectPublication: vi.fn(),
  activateProSystemAudioDirectPublication: vi.fn(async () => true),
  reconcileProSystemAudioDirectTargets: vi.fn(async () => true),
  resetProSystemAudioDirectTransport: vi.fn(),
}));
vi.mock('../../network/system-audio-sfu.ts', () => ({
  cleanupSystemAudioSfuGuestRoute: mocks.cleanupSfuGuestRoute,
}));
vi.mock('../../network/webrtc-audio-decoder-primer.ts', () => ({
  cleanupWebRtcAudioDecoderPrimer: vi.fn(),
  getAudioTrackStreamKey: vi.fn(),
  primeWebRtcAudioDecoder: vi.fn(() => null),
}));

import { configureProSystemAudioDirectTransport } from '../../network/pro-system-audio-direct.ts';
import { registerSystemAudioGuestListeners } from '../../network/system-audio-guest.ts';
import {
  bindProSystemAudioSession,
  configureProSystemAudioService,
  refreshProSystemAudioState,
  registerProSystemAudioServiceListeners,
  resetProSystemAudioService,
} from '../system-audio-service.ts';

const ROOM_CODE = '000001';
const LOCAL_ID = 'participant_00001';
const REMOTE_ID = 'participant_00002';
// Every real re-subscribe first fetches TURN credentials and opens a Realtime
// session, so an attempt takes a moment before it reports `failed`.
const ATTEMPT_MS = 1_000;

const api = { getSystemAudioState: vi.fn<() => Promise<ProRoomSystemAudioState>>() };

function snapshot(): ProRoomSnapshot {
  return {
    roomCode: ROOM_CODE,
    status: 'active',
    viewer: { participantId: LOCAL_ID, presenceIncarnationId: 'presence_0000000001' },
    presence: {
      coordinatorEpoch: 1,
      participants: [
        { participantId: LOCAL_ID, displayName: 'Listener' },
        { participantId: REMOTE_ID, displayName: 'Sharer' },
      ],
    },
  } as ProRoomSnapshot;
}

function live(): Extract<ProRoomSystemAudioState, { status: 'live' }> {
  return {
    generation: 1,
    status: 'live',
    ownerParticipantId: REMOTE_ID,
    claimExpiresAt: null,
    liveExpiresAt: 1_900_007_200_000,
    publication: {
      publicationId: 'publication_00001',
      sessionId: 'realtime_session_01',
      track: { trackName: 'audio-stereo', mid: '0' },
    },
  };
}

function isReceivingPlaceholder(): boolean {
  return getState('player.currentTrackMeta')?.systemAudioMode === 'receiving';
}

let toasts: string[];
let receiveTimeouts: number;
// Only the test's own listeners: the service registers its bus listeners once,
// as the app does, and every test must keep them.
let testListeners: BusScope;

beforeAll(() => {
  configureProSystemAudioService(api as unknown as ProRoomApiClient);
  registerProSystemAudioServiceListeners();
});

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  mocks.subscribe.mockReset();
  mocks.stopAllMedia.mockClear();
  mocks.initAudio.mockClear();
  mocks.getAudioContext.mockReset().mockReturnValue({
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
  });
  mocks.getWidener.mockReset().mockReturnValue({ input: {} });
  vi.stubGlobal(
    'MediaStream',
    class MockMediaStream {
      constructor(readonly tracks: MediaStreamTrack[]) {}
    },
  );
  mocks.cleanupSfuGuestRoute.mockClear();
  setState('room.context', {
    kind: 'pro',
    roomId: ROOM_CODE,
    epoch: 1,
    role: 'member',
    coordinatorId: null,
    snapshotRevision: 1,
    capabilities: [],
  });
  // The service's room-context listener is wired for this test too.
  expect(mocks.cleanupSfuGuestRoute).toHaveBeenCalled();
  resetProSystemAudioService();
  bindProSystemAudioSession(snapshot());
  api.getSystemAudioState.mockReset().mockResolvedValue(live());
  toasts = [];
  receiveTimeouts = 0;
  testListeners = createBusScope();
  testListeners.on('ui:show-toast', (message) => {
    toasts.push(String(message));
  });
  testListeners.on('system-audio:receive-timeout', () => {
    receiveTimeouts += 1;
  });
});

afterEach(() => {
  resetProSystemAudioService();
  clearAllManagedTimers();
  testListeners.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PRO SFU subscriber retry and the guest receive watchdog', () => {
  it('shows one connection_unstable and no receive_failed or idle gap through three minutes of retries', async () => {
    mocks.subscribe.mockImplementation(async (descriptor) => {
      await new Promise((resolve) => setTimeout(resolve, ATTEMPT_MS));
      mocks.sfuListener?.({ type: 'subscriber-state', state: 'failed', descriptor });
      throw new Error('REALTIME_SESSION_FAILED');
    });
    await refreshProSystemAudioState();
    await vi.advanceTimersByTimeAsync(0);
    expect(isReceivingPlaceholder()).toBe(true);

    // Retries wait 2.5, 5, 10, 20 and then 30 seconds. Each retry tears the
    // placeholder down and re-enters it in the same turn (cleanupCoordinatorGraph
    // -> cleanupGuestSystemAudio -> beginTrustedSystemAudioReception), so a
    // sample between timer turns across three minutes of a persistent
    // subscription failure must never find the receiver idle.
    const idleAtSeconds: number[] = [];
    for (let elapsed = 250; elapsed <= 180_000; elapsed += 250) {
      await vi.advanceTimersByTimeAsync(250);
      if (!isReceivingPlaceholder()) idleAtSeconds.push(elapsed / 1_000);
    }

    expect(mocks.subscribe.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(idleAtSeconds).toEqual([]);
    expect(receiveTimeouts).toBe(0);
    expect(toasts).toEqual(['system_audio.connection_unstable']);
    expect(getState('systemAudio.isReceiving')).toBe(false);
  });

  it('attaches a first subscription whose track arrives after 30 seconds', async () => {
    mocks.subscribe.mockImplementation(async (descriptor) => {
      await new Promise((resolve) => setTimeout(resolve, 34_000));
      mocks.sfuListener?.({
        type: 'subscriber-track',
        descriptor,
        track: { id: 'slow-stereo' } as MediaStreamTrack,
        isCurrent: () => true,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      mocks.sfuListener?.({ type: 'subscriber-state', state: 'subscribed', descriptor });
    });
    await refreshProSystemAudioState();
    await vi.advanceTimersByTimeAsync(0);
    expect(isReceivingPlaceholder()).toBe(true);

    await vi.advanceTimersByTimeAsync(70_000);

    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(receiveTimeouts).toBe(0);
    expect(toasts).toEqual([]);
    expect(getState('systemAudio.isReceiving')).toBe(true);
    expect(getState('playback.mode')).toBe('system-audio');
    expect(getState('playback.activity')).toBe('playing');
    expect(isReceivingPlaceholder()).toBe(true);
  });
});

describe('PRO SFU subscription that rejects synchronously', () => {
  // subscribeProSystemAudioSfu() validates the descriptor before it starts:
  // a publication already expired by the local clock (clock skew, or a retry
  // in the last seconds of the share) throws before any `failed` event.
  function rejectSynchronously(): never {
    throw new TypeError('PRO system-audio SFU publication has expired');
  }

  async function sampleThreeMinutes(): Promise<number[]> {
    const idleAtSeconds: number[] = [];
    for (let elapsed = 250; elapsed <= 180_000; elapsed += 250) {
      await vi.advanceTimersByTimeAsync(250);
      if (!isReceivingPlaceholder()) idleAtSeconds.push(elapsed / 1_000);
    }
    return idleAtSeconds;
  }

  function expectBackedOffRetriesWithOneNotice(idleAtSeconds: number[]): void {
    // 2.5, 5, 10, 20 and then 30 seconds apart: a retry keeps coming, but
    // never faster than the backoff allows.
    expect(mocks.subscribe.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(mocks.subscribe.mock.calls.length).toBeLessThanOrEqual(11);
    expect(idleAtSeconds).toEqual([]);
    expect(receiveTimeouts).toBe(0);
    expect(toasts).toEqual(['system_audio.connection_unstable']);
    expect(getState('systemAudio.isReceiving')).toBe(false);
  }

  it('retries a first subscription that rejects synchronously', async () => {
    mocks.subscribe.mockImplementation(rejectSynchronously);
    await refreshProSystemAudioState();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(isReceivingPlaceholder()).toBe(true);

    expectBackedOffRetriesWithOneNotice(await sampleThreeMinutes());
  });

  it('keeps retrying when a backed-off retry rejects synchronously', async () => {
    mocks.subscribe
      .mockImplementationOnce(async (descriptor) => {
        await new Promise((resolve) => setTimeout(resolve, ATTEMPT_MS));
        mocks.sfuListener?.({ type: 'subscriber-state', state: 'failed', descriptor });
        throw new Error('REALTIME_SESSION_FAILED');
      })
      .mockImplementation(rejectSynchronously);
    await refreshProSystemAudioState();
    await vi.advanceTimersByTimeAsync(0);
    expect(isReceivingPlaceholder()).toBe(true);

    expectBackedOffRetriesWithOneNotice(await sampleThreeMinutes());
  });

  it('keeps retrying when a reconcile during the retry wait rejects synchronously', async () => {
    mocks.subscribe.mockImplementation(async (descriptor) => {
      await new Promise((resolve) => setTimeout(resolve, ATTEMPT_MS));
      mocks.sfuListener?.({ type: 'subscriber-state', state: 'failed', descriptor });
      throw new Error('REALTIME_SESSION_FAILED');
    });
    await refreshProSystemAudioState();
    await vi.advanceTimersByTimeAsync(ATTEMPT_MS);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);

    // A presence heartbeat re-reconciles the same publication while the
    // first retry waits, and that attempt rejects synchronously.
    mocks.subscribe.mockImplementation(rejectSynchronously);
    bindProSystemAudioSession(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    expect(isReceivingPlaceholder()).toBe(true);

    expectBackedOffRetriesWithOneNotice(await sampleThreeMinutes());
  });

  it('turns an attached subscription into backed-off retries when a later reconcile rejects synchronously', async () => {
    mocks.subscribe.mockImplementation(async (descriptor) => {
      mocks.sfuListener?.({
        type: 'subscriber-track',
        descriptor,
        track: { id: 'stereo' } as MediaStreamTrack,
        isCurrent: () => true,
      });
      mocks.sfuListener?.({ type: 'subscriber-state', state: 'subscribed', descriptor });
    });
    await refreshProSystemAudioState();
    await vi.advanceTimersByTimeAsync(0);
    expect(getState('systemAudio.isReceiving')).toBe(true);

    // The local clock passes the share's expiry, so the next heartbeat
    // reconcile is rejected before any request goes out.
    mocks.subscribe.mockImplementation(rejectSynchronously);
    bindProSystemAudioSession(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);

    expectBackedOffRetriesWithOneNotice(await sampleThreeMinutes());

    // Once the coordinator ends the share, the retries stop and the receiver leaves.
    api.getSystemAudioState.mockResolvedValue({
      generation: 2,
      status: 'idle',
      ownerParticipantId: null,
      claimExpiresAt: null,
      liveExpiresAt: null,
      publication: null,
    });
    await refreshProSystemAudioState();
    await vi.advanceTimersByTimeAsync(0);
    const callsAtIdle = mocks.subscribe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.subscribe).toHaveBeenCalledTimes(callsAtIdle);
    expect(isReceivingPlaceholder()).toBe(false);
  });
});

describe('PRO LAN-direct listener and the guest receive watchdog', () => {
  beforeAll(() => {
    // The app registers the guest's bus listeners once beside the service's.
    registerSystemAudioGuestListeners();
  });

  function directLive(): Extract<ProRoomSystemAudioState, { status: 'live' }> {
    return {
      ...live(),
      publication: {
        publicationId: 'publication_00001',
        transport: 'lan-direct',
        protocolVersion: 2,
      },
    };
  }

  function directCallbacks() {
    return vi.mocked(configureProSystemAudioDirectTransport).mock.calls[0]?.[0];
  }

  /** The direct transport hands over the publisher's track once per route. */
  function deliverDirectTrack(id: string): Promise<void> {
    return Promise.resolve(
      directCallbacks()?.onReceiverTrackReady({
        ownerParticipantId: REMOTE_ID,
        generation: 1,
        publicationId: 'publication_00001',
        negotiationId: 'negotiation_000000000001',
        track: { id } as MediaStreamTrack,
        isCurrent: () => true,
      }),
    );
  }

  async function enterDirectReception(): Promise<void> {
    api.getSystemAudioState.mockResolvedValue(directLive());
    await refreshProSystemAudioState();
    await vi.advanceTimersByTimeAsync(0);
    expect(isReceivingPlaceholder()).toBe(true);
  }

  async function idleSecondsOverThreeMinutes(): Promise<number[]> {
    const idleAtSeconds: number[] = [];
    for (let elapsed = 250; elapsed <= 180_000; elapsed += 250) {
      await vi.advanceTimersByTimeAsync(250);
      if (!isReceivingPlaceholder()) idleAtSeconds.push(elapsed / 1_000);
    }
    return idleAtSeconds;
  }

  it('attaches a direct track whose offer arrives after 30 seconds', async () => {
    await enterDirectReception();

    // The publisher reaches this listener late (it joined late, or its page
    // slept), and an unchanged live state never reconciles it again.
    await vi.advanceTimersByTimeAsync(34_000);
    const handoff = deliverDirectTrack('late-direct-stereo');
    // Long enough for a trusted-boundary wait to give up as well.
    await vi.advanceTimersByTimeAsync(35_000);
    await handoff;

    expect(getState('systemAudio.isReceiving')).toBe(true);
    expect(receiveTimeouts).toBe(0);
    expect(toasts).toEqual([]);
    expect(mocks.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(getState('playback.mode')).toBe('system-audio');
    expect(getState('playback.activity')).toBe('playing');
    expect(isReceivingPlaceholder()).toBe(true);
  });

  it('keeps one placeholder through three minutes without an offer', async () => {
    let hostStarted = 0;
    testListeners.on('system-audio:host-started', () => {
      hostStarted += 1;
    });
    await enterDirectReception();

    // The LAN-direct route and its publisher own this deadline: an unreachable
    // listener makes the publisher promote the share to the SFU, which is a
    // new publication. Until then the listener waits in one placeholder.
    expect(await idleSecondsOverThreeMinutes()).toEqual([]);
    expect(receiveTimeouts).toBe(0);
    expect(toasts).toEqual([]);
    expect(mocks.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(hostStarted).toBe(1);
    expect(getState('systemAudio.isReceiving')).toBe(false);
  });

  it('shows one connection_unstable for a failed direct route and keeps the placeholder', async () => {
    await enterDirectReception();

    await vi.advanceTimersByTimeAsync(5_000);
    directCallbacks()?.onLiveRouteFallback({
      role: 'receiver',
      reason: 'receiver-track-timeout',
      participantId: REMOTE_ID,
      generation: 1,
      publicationId: 'publication_00001',
    });

    expect(await idleSecondsOverThreeMinutes()).toEqual([]);
    expect(receiveTimeouts).toBe(0);
    expect(toasts).toEqual(['system_audio.connection_unstable']);
    expect(mocks.stopAllMedia).toHaveBeenCalledTimes(1);
  });

  it('leaves a late direct track detached after a force-stop ended the placeholder', async () => {
    await enterDirectReception();

    // A force-stop is a transition to another owner, never something the
    // receiver undoes when the publisher's track turns up afterwards.
    bus.emit('system-audio:force-stop');
    expect(isReceivingPlaceholder()).toBe(false);
    const handoff = deliverDirectTrack('direct-stereo');
    await vi.advanceTimersByTimeAsync(35_000);
    await handoff;

    expect(mocks.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(getState('systemAudio.isReceiving')).toBe(false);
    expect(isReceivingPlaceholder()).toBe(false);
  });
});
