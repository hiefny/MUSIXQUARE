/**
 * @vitest-environment jsdom
 *
 * C4-0 owner-boundary contract for the device-wide system-audio receive slot,
 * PRO coordinator paths (SFU subscription and LAN-direct track delivery), the
 * Standard-to-PRO switch, share end, leave and force-stop. Standard paths are in
 * src/network/__tests__/system-audio-receive-slot-contract.test.ts. The setup
 * follows the G1 harness (system-audio-subscriber-watchdog.test.ts), with the
 * Standard SFU adapter and the decoder primer real instead of mocked.
 *
 * Registry records (docs/design/resource-ownership-registry.md):
 * - RO-04 System-audio receive slot (placeholder, receiving flag, restore meta,
 *   source on widener.input, decoder primer, receive deadline per route).
 * - RO-20 PRO system-audio lease and publication: the publication a listener
 *   receives (live SFU or LAN-direct, the direct-to-SFU promotion and the share
 *   end), and a local publisher only as far as the receive slot sees it: its
 *   'system-audio' playback claim with sharing meta (the claim system-capture.ts
 *   makes), a live state naming the local participant, and running capture
 *   (stopAllMedia then emits force-stop). The capture, lease claim and publish
 *   flows themselves are not exercised.
 * - RO-21 PRO checkpoint re-apply: only whether the post-share restore is asked
 *   for (the restore callback the runtime passes in), not what it re-applies.
 *
 * Real: pro-room/system-audio-service.ts with its controller, the guest
 * placeholder and watchdog (network/system-audio-guest.ts), the Standard SFU
 * guest adapter and route freeze (network/system-audio-sfu.ts,
 * system-audio-delivery.ts), protocol dispatch, player/ownership, core/state,
 * bus and managed timers, and the decoder primer. Listeners register once in
 * the production order (guest, Standard SFU, PRO service).
 *
 * Replaced, all native seams (see the harness for what each fake models and
 * leaves out): the PRO SFU and LAN-direct transports, Web Audio, the Cloudflare
 * Realtime API, RTCPeerConnection, MediaStream, media teardown (stopAllMedia
 * spy), the Standard TURN loader, the local capture module (inactive), the
 * room API's GET /system-audio and the chat notice (publisher side only). The
 * PRO live budget is carried only as data: the server installs liveExpiresAt
 * at commit and again at a direct-to-SFU promotion, but the subscriber's own
 * expiry timer at that instant is not modelled, so no test reaches it.
 *
 * Each test pins main d84f53f5 (9.0.3), which carries two fix lanes that
 * changed rows pinned earlier on c08b6c39. G5 (9.0.2): a PRO LAN-direct
 * listener begins without the guest's 30 s watchdog; the coordinator's direct
 * receive deadline shows connection_unstable once per generation and keeps
 * the placeholder for a late track. G6 (9.0.3): a same-publication SFU retry
 * keeps the coordinator's publication key and the placeholder, so the
 * reception start (stopAllMedia, host-started) runs once per publication.
 * Those rows say "fixed in 9.0.2 (G5)" or "fixed in 9.0.3 (G6)"; every other
 * comment names a known gap and the increment planned for it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG, SYSTEM_AUDIO_SHARE_LIMIT_MS } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { batchSetState, getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { registerSystemAudioGuestListeners } from '../../network/system-audio-guest.ts';
import { registerSystemAudioSfuListeners } from '../../network/system-audio-sfu.ts';
import {
  claimPlaybackOwner,
  createFileTrackMeta,
  createSystemAudioTrackMeta,
} from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';
import type { ProRoomApiClient } from '../api.ts';
import type {
  ProRoomSnapshot,
  ProRoomSystemAudioPublication,
  ProRoomSystemAudioState,
} from '../contracts.ts';
import {
  acceptProSystemAudioHeartbeatState,
  bindProSystemAudioSession,
  configureProSystemAudioService,
  refreshProSystemAudioState,
  registerProSystemAudioServiceListeners,
  resetProSystemAudioService,
} from '../system-audio-service.ts';
import {
  FakeRTCPeerConnection,
  installNativeGlobals,
  makeAudioTrack,
  media,
  observeReceiveBoundary,
  primerElements,
  proDirect,
  proSfu,
  realtime,
  resetNativeFakes,
  webAudio,
  type ReceiveObservations,
} from '../../network/__tests__/__helpers__/system-audio-receive-harness.ts';

vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../audio/context.ts', async () => {
  const { webAudio: fake } =
    await import('../../network/__tests__/__helpers__/system-audio-receive-harness.ts');
  return { getAudioContext: () => fake.context };
});
vi.mock('../../audio/engine.ts', async () => {
  const { webAudio: fake } =
    await import('../../network/__tests__/__helpers__/system-audio-receive-harness.ts');
  return { initAudio: fake.initAudio, getWidener: fake.getWidener };
});
vi.mock('../../player/transport.ts', async () => {
  const { media: fake } =
    await import('../../network/__tests__/__helpers__/system-audio-receive-harness.ts');
  return { stopAllMedia: fake.stopAllMedia };
});
vi.mock('../../core/capability.ts', async () => {
  const { realtime: fake } =
    await import('../../network/__tests__/__helpers__/system-audio-receive-harness.ts');
  return {
    fetchWithCapability: fake.fetchWithCapability,
    isCapabilityChallengeCancelled: () => false,
  };
});
vi.mock('../../network/standard-room-prerequisites.ts', () => ({
  getStandardRoomTurnCredentials: async () => null,
}));
vi.mock('../../audio/system-capture.ts', () => ({
  getCapturedAudioStream: () => null,
  isSystemAudioActive: () => false,
}));
vi.mock('../../chat/protocol.ts', () => ({ broadcastSystemMessage: vi.fn() }));
vi.mock(
  '../../network/pro-system-audio-sfu.ts',
  async () =>
    (await import('../../network/__tests__/__helpers__/system-audio-receive-harness.ts')).proSfu
      .module,
);
vi.mock(
  '../../network/pro-system-audio-direct.ts',
  async () =>
    (await import('../../network/__tests__/__helpers__/system-audio-receive-harness.ts')).proDirect
      .module,
);

const ROOM_CODE = '000001';
const LOCAL_ID = 'participant_00001';
const REMOTE_ID = 'participant_00002';
const PUBLICATION_ID = 'publication_00001';
// One PRO SFU attempt (TURN plus three Realtime calls) in the transport fake.
const PRO_TRACK_AT_MS = 1_000;
// A fixed live budget well past the fake clock. The server never slides it on
// a heartbeat, so repeating the same state keeps the same publication key.
const LIVE_EXPIRES_AT = 1_900_007_200_000;
// The server's live budget (SYSTEM_AUDIO_LIVE_TTL_MS in
// cloudflare/pro-room-worker.ts, not exported) equals the client share limit.
const LIVE_TTL_MS = SYSTEM_AUDIO_SHARE_LIMIT_MS;

const api = { getSystemAudioState: vi.fn<() => Promise<ProRoomSystemAudioState>>() };
const restorePlayback = vi.fn(async () => true);

let previousTitle: string | undefined;
let seen: ReceiveObservations;

function snapshot(presenceIncarnationId = 'presence_0000000001'): ProRoomSnapshot {
  return {
    roomCode: ROOM_CODE,
    status: 'active',
    viewer: { participantId: LOCAL_ID, presenceIncarnationId },
    presence: {
      coordinatorEpoch: 1,
      participants: [
        { participantId: LOCAL_ID, displayName: 'Listener' },
        { participantId: REMOTE_ID, displayName: 'Sharer' },
      ],
    },
  } as ProRoomSnapshot;
}

const sfuPublication = (): ProRoomSystemAudioPublication => ({
  publicationId: PUBLICATION_ID,
  sessionId: 'realtime_session_01',
  track: { trackName: 'audio-stereo', mid: '0' },
});
const directPublication = (): ProRoomSystemAudioPublication => ({
  publicationId: PUBLICATION_ID,
  transport: 'lan-direct',
  protocolVersion: 2,
});

function live(
  publication: ProRoomSystemAudioPublication,
  generation = 1,
  ownerParticipantId = REMOTE_ID,
  liveExpiresAt = LIVE_EXPIRES_AT,
): ProRoomSystemAudioState {
  return {
    generation,
    status: 'live',
    ownerParticipantId,
    claimExpiresAt: null,
    liveExpiresAt,
    publication,
  };
}

function idle(generation: number): ProRoomSystemAudioState {
  return {
    generation,
    status: 'idle',
    ownerParticipantId: null,
    claimExpiresAt: null,
    liveExpiresAt: null,
    publication: null,
  };
}

/** The local participant publishes (its own SFU publication). */
function localLive(generation: number): ProRoomSystemAudioState {
  return live(
    {
      publicationId: 'publication_00002',
      sessionId: 'realtime_session_02',
      track: { trackName: 'audio-stereo', mid: '0' },
    },
    generation,
    LOCAL_ID,
  );
}

/** The playback claim local capture makes when its share starts. */
function claimSharing(): void {
  claimPlaybackOwner('system-audio', { currentTrackMeta: createSystemAudioTrackMeta('sharing') });
}

function proContext() {
  return {
    kind: 'pro' as const,
    roomId: ROOM_CODE,
    epoch: 1,
    role: 'member' as const,
    coordinatorId: null,
    snapshotRevision: 1,
    capabilities: [],
  };
}

/** The coordinator's authenticated GET returns `state`. */
async function applyState(state: ProRoomSystemAudioState): Promise<void> {
  api.getSystemAudioState.mockResolvedValue(state);
  await refreshProSystemAudioState();
  await vi.advanceTimersByTimeAsync(0);
}

function slot() {
  const meta = getState('player.currentTrackMeta');
  return {
    receiving: getState('systemAudio.isReceiving'),
    mode: getState('playback.mode'),
    activity: getState('playback.activity'),
    title: meta?.title,
    placeholder: meta?.systemAudioMode === 'receiving',
    sources: webAudio.connectedTrackIds(),
    primers: primerElements().length,
  };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeAll(() => {
  registerSystemAudioGuestListeners();
  registerSystemAudioSfuListeners();
  configureProSystemAudioService(api as unknown as ProRoomApiClient, restorePlayback);
  registerProSystemAudioServiceListeners();
});

beforeEach(() => {
  vi.useFakeTimers();
  installNativeGlobals();
  resetNativeFakes();
  resetState();
  restorePlayback.mockClear();
  // The listener was playing a local file before the share started.
  claimPlaybackOwner('file', { currentTrackMeta: createFileTrackMeta('previous-track.mp3') });
  previousTitle = getState('player.currentTrackMeta')?.title;
  // The PRO bridge runs the media engine as a local 'host' with no host socket.
  setState('network.appRole', 'host');
  setState('room.context', proContext());
  resetProSystemAudioService();
  bindProSystemAudioSession(snapshot());
  seen = observeReceiveBoundary();
});

afterEach(() => {
  resetProSystemAudioService();
  bus.emit('system-audio:force-stop');
  seen.dispose();
  clearAllManagedTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('PRO SFU reception', () => {
  it('S5: the placeholder has no slot deadline; a 2.5 s disconnect drops receiving but keeps the source', async () => {
    // A first attempt slower than the guest's 30 s watchdog still attaches (G1).
    proSfu.latencyMs = 40_000;
    await applyState(live(sfuPublication()));
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
    });
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);

    await advance(40_000);
    expect(seen.toasts).toEqual([]);
    expect(seen.counts.receiveTimeouts).toBe(0);
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      sources: ['pro-sfu-audio-1'],
      primers: 1,
    });

    proSfu.emitState('disconnected');
    await advance(2_499);
    expect(slot().receiving).toBe(true);
    await advance(1);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: ['pro-sfu-audio-1'],
    });

    proSfu.emitState('subscribed');
    expect(slot()).toMatchObject({ receiving: true, activity: 'playing' });
    expect(webAudio.maxConnected).toBe(1);
    expect(seen.toasts).toEqual([]);
  });

  it('S5: a runtime failure while receiving drops receiving and the source at once, keeps the placeholder and re-attaches after backoff', async () => {
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS);
    expect(slot()).toMatchObject({ receiving: true, activity: 'playing', primers: 1 });
    const activitiesBefore = seen.activities.length;

    // The retry interrupts the slot (C4-5 makes this slot.interrupt('pro-sfu',
    // 'retry')): no playing state is left on a dead source during the backoff.
    proSfu.failLive();
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
      primers: 0,
    });
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    await advance(2_499);
    expect(proSfu.descriptors).toHaveLength(1);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });

    await advance(1);
    expect(proSfu.descriptors).toHaveLength(2);
    // Fixed in 9.0.3 (G6): the retry re-subscribes the same publication inside
    // the placeholder it holds. No second media stop or host-started, and no
    // idle write between the failure and the re-attach (before G6 the retry
    // began reception again: 'pending', 'idle', 'pending').
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(seen.counts.hostStarted).toBe(1);
    expect(seen.activities.slice(activitiesBefore)).toEqual(['pending']);

    await advance(PRO_TRACK_AT_MS);
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      placeholder: true,
      sources: ['pro-sfu-audio-2'],
      primers: 1,
    });
    expect(webAudio.maxConnected).toBe(1);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(seen.counts.receiveTimeouts).toBe(0);

    await applyState(idle(2));
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });
  });

  it('S5: after a disconnect the source stays until the subscription fails, then detaches', async () => {
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS);
    proSfu.emitState('disconnected');
    await advance(2_500);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      sources: ['pro-sfu-audio-1'],
      primers: 1,
    });
    expect(seen.toasts).toEqual([]);

    proSfu.failLive();
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
      primers: 0,
    });
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);

    await advance(2_500 + PRO_TRACK_AT_MS);
    expect(slot()).toMatchObject({ receiving: true, sources: ['pro-sfu-audio-2'] });
    expect(webAudio.maxConnected).toBe(1);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
  });

  it('G6, fixed in 9.0.3: failed attempts keep the placeholder with one notice and one reception start', async () => {
    proSfu.defaultOutcome = 'fail';
    await applyState(live(sfuPublication()));
    await advance(180_000);

    const attempts = proSfu.descriptors.length;
    expect(attempts).toBeGreaterThanOrEqual(8);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(seen.counts.receiveTimeouts).toBe(0);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
    });
    // Fixed in 9.0.3 (G6): every retry keeps the coordinator's publication
    // key, so the reception start ran once for the whole failure run: one
    // media stop, one host-started and no idle write (before G6 each attempt
    // tore the placeholder down and began it again).
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(seen.counts.hostStarted).toBe(1);
    expect(seen.activities).toEqual(['pending']);

    // The one restore point taken at the start survives every attempt.
    await applyState(idle(2));
    expect(slot()).toMatchObject({ mode: null, activity: 'idle', title: previousTitle });
  });

  it('G6, since 9.0.3: a force-stop during a retry backoff stays ended, but the retry still subscribes and its track is dropped at the boundary', async () => {
    proSfu.outcomes.push('fail');
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });

    bus.emit('system-audio:force-stop');
    expect(slot()).toMatchObject({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: previousTitle,
      placeholder: false,
    });

    await advance(2_500 + PRO_TRACK_AT_MS);
    expect(proSfu.descriptors).toHaveLength(2);
    // Since 9.0.3 (G6) the retry keeps its publication key, so it no longer
    // begins reception again over the force-stop (before G6 it re-entered the
    // placeholder and played). Its track waits at the trusted boundary for a
    // reception start that never comes and is dropped there, silently.
    await advance(60_000);
    expect(webAudio.sources).toHaveLength(0);
    expect(slot()).toMatchObject({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: previousTitle,
      sources: [],
      primers: 0,
    });
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(seen.counts.hostStarted).toBe(1);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    // Known gap (observed on d84f53f5, not device-verified): the force-stop
    // reaches only the guest placeholder, so the retry still opens a
    // subscription and holds it with nothing attached until the publication
    // changes or the room resets. Planned: a slot end() that covers every
    // route (C4-5/C4-7, a behaviour decision).
    expect(proSfu.isSubscribed).toBe(true);
    resetProSystemAudioService();
    expect(proSfu.isSubscribed).toBe(false);
  });

  it('a suspended context fails a PRO SFU attach into a backed-off retry that keeps the placeholder', async () => {
    webAudio.suspend();
    await applyState(live(sfuPublication()));
    // The track and 'subscribed' arrived at 1 s; the attach waits in
    // initAudio, so nothing claims receiving before it fails.
    await advance(PRO_TRACK_AT_MS + 499);
    expect(seen.toasts).toEqual([]);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', sources: [] });
    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
    });

    webAudio.finishResume();
    await advance(2_500 + PRO_TRACK_AT_MS);
    expect(slot()).toMatchObject({ receiving: true, sources: ['pro-sfu-audio-2'] });
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(seen.counts.receiveTimeouts).toBe(0);
    // Fixed in 9.0.3 (G6): the attach-failure retry re-subscribes inside the
    // placeholder too.
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(seen.counts.hostStarted).toBe(1);
  });

  it("a 'subscribed' state that arrives while the attach waits in initAudio claims nothing before a source exists", async () => {
    webAudio.suspend();
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS);
    // The subscriber emits its track and then 'subscribed' in the same turn,
    // while the attach is still waiting for the context. The resume re-claims
    // only when a source exists (C4-5 turns it into slot.resume('pro-sfu')).
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
    });
    await advance(400);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', sources: [] });

    webAudio.finishResume();
    await advance(0);
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      placeholder: true,
      sources: ['pro-sfu-audio-1'],
      primers: 1,
    });
    expect(seen.toasts).toEqual([]);
  });

  it('visibility: a hidden page keeps the retry running and attaches in the background', async () => {
    // The receive slot has no visibility hold: a background listener must
    // keep playing (unlike the post-share restore, which waits to be shown).
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    proSfu.outcomes.push('fail');
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS + 2_500 + PRO_TRACK_AT_MS);
    expect(proSfu.descriptors).toHaveLength(2);
    expect(slot()).toMatchObject({ receiving: true, sources: ['pro-sfu-audio-2'] });
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
  });

  it('trusted boundary: a track whose placeholder a successor replaced waits at the boundary and never attaches', async () => {
    await applyState(live(sfuPublication()));
    await advance(500);
    claimPlaybackOwner('file', { currentTrackMeta: createFileTrackMeta('successor.mp3') });

    await advance(PRO_TRACK_AT_MS);
    expect(slot()).toMatchObject({
      receiving: false,
      mode: 'file',
      activity: 'playing',
      title: 'successor',
      sources: [],
      primers: 0,
    });
    await advance(60_000);
    expect(webAudio.sources).toHaveLength(0);
    expect(slot()).toMatchObject({ receiving: false, mode: 'file', title: 'successor' });
    expect(seen.toasts).toEqual([]);
    expect(seen.counts.receiveTimeouts).toBe(0);
    // Known gap (observed on d84f53f5, not device-verified): the boundary's
    // refusal is silent and is not a subscription failure, so no retry runs
    // and the live subscription stays open with nothing attached until the
    // publication changes. Planned: slot.attach('pro-sfu') reports a stale
    // ticket and the adapter decides what to retire (C4-5, needs a decision).
    expect(proSfu.isSubscribed).toBe(true);
    expect(proSfu.descriptors).toHaveLength(1);

    // The share end leaves the successor alone and closes the subscription.
    await applyState(idle(2));
    expect(proSfu.isSubscribed).toBe(false);
    expect(slot()).toMatchObject({ mode: 'file', activity: 'playing', title: 'successor' });
  });

  it('a heartbeat reconcile while receiving leaves the source, primer and subscription untouched', async () => {
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS);
    const [source] = webAudio.connected();
    const [primer] = primerElements();

    bindProSystemAudioSession(snapshot());
    acceptProSystemAudioHeartbeatState(live(sfuPublication()), snapshot());
    await advance(15_000);
    expect(webAudio.connected()).toEqual([source]);
    expect(primerElements()).toEqual([primer]);
    expect(proSfu.descriptors).toHaveLength(1);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(slot()).toMatchObject({ receiving: true, activity: 'playing' });
  });

  it('S8: a track whose attach outlives a new room binding never connects', async () => {
    webAudio.suspend();
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS + 100);

    bindProSystemAudioSession(snapshot('presence_0000000002'));
    webAudio.finishResume();
    await advance(1_000);
    expect(webAudio.sources).toHaveLength(0);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'idle',
      placeholder: false,
      title: previousTitle,
    });
    expect(seen.toasts).toEqual([]);
  });
});

describe('PRO LAN-direct reception', () => {
  it('S6: reception is pending until the track; a receiver fallback drops receiving and the source with one notice', async () => {
    await applyState(live(directPublication()));
    expect(proDirect.activations).toBe(1);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });

    proDirect.deliverTrack(makeAudioTrack('direct-audio-1'));
    await advance(0);
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      sources: ['direct-audio-1'],
      primers: 1,
    });

    proDirect.receiverFallback();
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
      primers: 0,
    });
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    // The attach cleared the direct deadline and the fallback arms none: the
    // placeholder waits for the publisher's SFU promotion (a new publication).
    await advance(60_000);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });
    expect(seen.counts.receiveTimeouts).toBe(0);
  });

  it('G5, fixed in 9.0.2: with no track for 30 s the direct deadline says connection_unstable once, keeps the placeholder, and a late track attaches', async () => {
    await applyState(live(directPublication()));
    await advance(29_999);
    expect(seen.toasts).toEqual([]);
    await advance(1);
    // Fixed in 9.0.2 (G5): reception began without the guest watchdog, so no
    // receive_failed and no idle. The coordinator's direct receive deadline
    // reports once per generation and keeps the placeholder (before G5 the
    // watchdog ended reception and a late track attached nowhere).
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(seen.counts.receiveTimeouts).toBe(0);
    expect(slot()).toMatchObject({
      receiving: false,
      mode: 'system-audio',
      activity: 'pending',
      placeholder: true,
      sources: [],
    });

    // A presence heartbeat re-reconciles the unchanged publication: no second
    // reception start and no second notice.
    bindProSystemAudioSession(snapshot());
    await advance(60_000);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(slot()).toMatchObject({ activity: 'pending', placeholder: true });

    proDirect.deliverTrack(makeAudioTrack('direct-late'));
    await advance(0);
    expect(slot()).toMatchObject({
      receiving: true,
      mode: 'system-audio',
      activity: 'playing',
      placeholder: true,
      sources: ['direct-late'],
      primers: 1,
    });
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(seen.counts.hostStarted).toBe(1);
    await applyState(idle(2));
    expect(slot()).toMatchObject({ mode: null, activity: 'idle', title: previousTitle });
  });

  it('S8b, fixed in 9.0.2 (G5): the direct deadline that fires while a track waits in initAudio keeps the placeholder the track then attaches to', async () => {
    await applyState(live(directPublication()));
    await advance(29_800);
    webAudio.suspend();
    proDirect.deliverTrack(makeAudioTrack('direct-audio-1'));
    await advance(200);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });

    await advance(100);
    webAudio.finishResume();
    await advance(0);
    // Before G5 the guest watchdog ended reception here and this attach then
    // played after receive_failed under the restored title (the S8b gap). The
    // direct deadline only reports, so the attach lands inside its placeholder.
    expect(slot()).toMatchObject({
      receiving: true,
      mode: 'system-audio',
      activity: 'playing',
      placeholder: true,
      title: 'Receiving System Audio',
      sources: ['direct-audio-1'],
    });
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(seen.counts.receiveTimeouts).toBe(0);
  });

  it('S8b gap: a force-stop while a direct track waits in initAudio still connects it under the restored title', async () => {
    await applyState(live(directPublication()));
    webAudio.suspend();
    proDirect.deliverTrack(makeAudioTrack('direct-audio-1'));
    await advance(100);
    bus.emit('system-audio:force-stop');
    expect(slot()).toMatchObject({
      receiving: false,
      mode: null,
      activity: 'idle',
      placeholder: false,
      title: previousTitle,
    });

    webAudio.finishResume();
    await advance(0);
    // Known gap (C4 critique S8b, PRO side; observed on d84f53f5, not
    // device-verified): after the trusted boundary the coordinator attach
    // re-checks only the route, the publication and the owner, and a
    // force-stop changes none of them, so audio plays after the force-stop
    // under the restored title. Planned: the slot attach fence (C4-3,
    // inherited by C4-5) and a slot end() that covers every route (C4-5/C4-7);
    // both need owner sign-off.
    expect(slot()).toMatchObject({
      receiving: true,
      mode: 'system-audio',
      activity: 'playing',
      placeholder: false,
      title: previousTitle,
      sources: ['direct-audio-1'],
    });
    expect(seen.toasts).toEqual([]);
  });

  it('trusted boundary: a direct track that arrives after a force-stop waits at the boundary and never attaches; the direct deadline stays silent', async () => {
    await applyState(live(directPublication()));
    await advance(1_000);
    bus.emit('system-audio:force-stop');
    expect(slot()).toMatchObject({ mode: null, activity: 'idle', placeholder: false });

    proDirect.deliverTrack(makeAudioTrack('direct-late'));
    await advance(60_000);
    // The force-stop ends reception for good (G5's comment in the service):
    // the track waits for a reception start that never comes and is dropped,
    // and the direct deadline stays silent after the force-stop. Two guards
    // hold it off (the force-stop's clear and the deadline's placeholder
    // check); this row pins the outcome, not which one of them does it.
    expect(webAudio.sources).toHaveLength(0);
    expect(slot()).toMatchObject({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: previousTitle,
      sources: [],
      primers: 0,
    });
    expect(seen.toasts).toEqual([]);
    expect(seen.counts.receiveTimeouts).toBe(0);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
  });

  it('a suspended context fails a direct attach into a receiver fallback; since 9.0.2 (G5) the placeholder then waits for the promotion', async () => {
    webAudio.suspend();
    await applyState(live(directPublication(), 1, REMOTE_ID, Date.now() + LIVE_TTL_MS));
    proDirect.deliverTrack(makeAudioTrack('direct-audio-1'));
    await advance(500);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
    });

    // Fixed in 9.0.2 (G5): no guest watchdog ends the placeholder at 30 s, and
    // the fallback cleared the direct deadline (its notice was already shown).
    await advance(60_000);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(seen.counts.receiveTimeouts).toBe(0);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });

    // The publisher's promotion to the SFU is a new publication.
    webAudio.finishResume();
    await applyState(live(sfuPublication(), 1, REMOTE_ID, Date.now() + LIVE_TTL_MS));
    await advance(PRO_TRACK_AT_MS);
    expect(slot()).toMatchObject({ receiving: true, sources: ['pro-sfu-audio-1'] });
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
  });

  it('S7: a direct-to-SFU promotion moves the source without overlap and keeps the restore point', async () => {
    const committedAt = Date.now();
    await applyState(live(directPublication(), 1, REMOTE_ID, committedAt + LIVE_TTL_MS));
    proDirect.deliverTrack(makeAudioTrack('direct-audio-1'));
    await advance(0);
    await advance(20_000);
    const activitiesBefore = seen.activities.length;

    // The server installs a fresh live budget at the promotion
    // (pro-room-worker.ts), so the SFU publication expires later than the
    // direct one did.
    const promotedAt = Date.now();
    await applyState(live(sfuPublication(), 1, REMOTE_ID, promotedAt + LIVE_TTL_MS));
    // A promotion is a new publication key: the direct source leaves, the
    // placeholder is re-entered through idle in the same turn, and the
    // reception start runs again before the SFU subscription attaches.
    expect(slot()).toMatchObject({ receiving: false, placeholder: true, sources: [] });
    expect(seen.activities.slice(activitiesBefore)).toEqual(['pending', 'idle', 'pending']);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(2);
    // The descriptor carries the promotion's budget (20 s later than the
    // direct commit's), not the direct publication's expiry.
    expect(proSfu.descriptors.map((descriptor) => descriptor.expiresAt)).toEqual([
      promotedAt + LIVE_TTL_MS,
    ]);

    await advance(PRO_TRACK_AT_MS);
    expect(slot()).toMatchObject({ receiving: true, sources: ['pro-sfu-audio-1'] });
    expect(webAudio.maxConnected).toBe(1);
    await applyState(idle(2));
    expect(slot().title).toBe(previousTitle);
  });
});

describe('successor during initAudio (C4-3 attach fence gap, PRO routes)', () => {
  it.each([
    {
      route: 'SFU',
      trackId: 'pro-sfu-audio-1',
      deliver: async () => {
        await applyState(live(sfuPublication()));
        webAudio.suspend();
        await advance(PRO_TRACK_AT_MS + 100);
      },
    },
    {
      route: 'LAN-direct',
      trackId: 'direct-audio-1',
      deliver: async () => {
        await applyState(live(directPublication()));
        webAudio.suspend();
        proDirect.deliverTrack(makeAudioTrack('direct-audio-1'));
        await advance(100);
      },
    },
  ])(
    'S9 gap ($route): a successor that claims playback while the attach waits in initAudio is overwritten',
    async ({ trackId, deliver }) => {
      await deliver();
      expect(slot()).toMatchObject({ receiving: false, activity: 'pending', sources: [] });
      claimPlaybackOwner('file', { currentTrackMeta: createFileTrackMeta('successor.mp3') });

      webAudio.finishResume();
      await advance(0);
      // Known gap (C4 critique S9, same as the Standard P2P and SFU rows): the
      // shared coordinator attach re-checks the route and publication but not
      // the placeholder or owner after `await initAudio()`, so system audio
      // takes playback back under the successor's title. Planned: the slot's
      // attach fence (C4-3), which C4-5 inherits for both PRO routes; an
      // intended change needing owner sign-off.
      expect(slot()).toMatchObject({
        receiving: true,
        mode: 'system-audio',
        activity: 'playing',
        title: 'successor',
        sources: [trackId],
      });
    },
  );
});

describe('room switch, share end, leave and force-stop', () => {
  it('S7: a Standard-to-PRO switch retires the Standard SFU subscription before the PRO track connects', async () => {
    resetProSystemAudioService();
    setState('room.context', { ...proContext(), kind: 'standard', roomId: null, role: 'idle' });
    const hostConn = { open: true, peer: 'host-peer-0001', send: vi.fn() } as unknown;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn as DataConnection);
    setState('network.connectionType', 'remote');
    markQueueAuthorityReady(hostConn as DataConnection);
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn as DataConnection);
    await handleData(
      {
        type: MSG.SYSTEM_AUDIO_SFU_READY,
        version: 2,
        audience: 'remote',
        sessionId: 'rt_host_session_1',
        track: { trackName: 'stereo-standard', mid: '0' },
      },
      hostConn as DataConnection,
    );
    await advance(1_000);
    expect(slot().sources).toEqual(['sfu-remote-audio-1']);

    // The PRO bridge takes over the media engine, then the room context flips.
    batchSetState({ 'network.appRole': 'host', 'network.hostConn': null });
    setState('room.context', proContext());
    // The Standard route is retired without ending reception: receiving stays
    // true with no source until the PRO reconcile re-enters the placeholder.
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(true);
    expect(realtime.count('tracks-close')).toBe(1);
    expect(slot()).toMatchObject({ receiving: true, placeholder: true, sources: [] });

    bindProSystemAudioSession(snapshot());
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS);
    expect(slot()).toMatchObject({ receiving: true, sources: ['pro-sfu-audio-1'] });
    expect(webAudio.maxConnected).toBe(1);
    await applyState(idle(2));
    expect(slot().title).toBe(previousTitle);
  });

  it('the share ending restores the previous title and asks for the post-share restore once', async () => {
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS);

    await applyState(idle(2));
    expect(slot()).toEqual({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: previousTitle,
      placeholder: false,
      sources: [],
      primers: 0,
    });
    expect(restorePlayback).toHaveBeenCalledTimes(1);
    expect(seen.toasts).toEqual([]);
  });

  it('room leave ends PRO reception idle with no notice and no post-share restore', async () => {
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS);

    resetProSystemAudioService();
    await advance(60_000);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'idle',
      title: previousTitle,
      sources: [],
      primers: 0,
    });
    expect(restorePlayback).not.toHaveBeenCalled();
    expect(seen.toasts).toEqual([]);
  });

  it('force-stop ends the PRO placeholder without a restore, but the coordinator source stays until the room resets', async () => {
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS);

    bus.emit('system-audio:force-stop');
    expect(slot()).toMatchObject({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: previousTitle,
      placeholder: false,
    });
    expect(restorePlayback).not.toHaveBeenCalled();
    expect(seen.toasts).toEqual([]);
    // Observed gap (C4-0, not device-verified): force-stop reaches only the
    // guest placeholder. The coordinator's source, primer and subscription
    // stay connected under an idle UI, and a heartbeat reconcile of the
    // unchanged publication does not notice. On a leave (peer.ts
    // leaveSession requests the PRO leave and emits force-stop) the service
    // reset follows and closes it. Planned: a slot end() that covers every
    // route (C4-5/C4-7, a behaviour decision).
    expect(slot()).toMatchObject({ sources: ['pro-sfu-audio-1'], primers: 1 });
    bindProSystemAudioSession(snapshot());
    await advance(15_000);
    expect(slot()).toMatchObject({ activity: 'idle', sources: ['pro-sfu-audio-1'] });

    resetProSystemAudioService();
    expect(slot()).toMatchObject({ sources: [], primers: 0 });
    expect(restorePlayback).not.toHaveBeenCalled();
  });
});

describe('the same device as publisher (S11) and begin re-entrancy', () => {
  it('S11: a listener that becomes the publisher keeps its sharing claim through every coordinator slot end', async () => {
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS);
    await applyState(idle(2));
    expect(slot()).toMatchObject({ mode: null, activity: 'idle', title: previousTitle });

    // The listener starts its own share once the room's share is idle.
    claimSharing();
    await applyState(localLive(3));
    // The coordinator ends its (empty) slot for the local publication. Only
    // service.ts cleanupCoordinatorGraph's `!latestView.isLocalOwner` guard
    // keeps that end from releasing the publisher's claim; C4-7 replaces the
    // call with slot.end('pro-coordinator') and must keep an equivalent test.
    const sharing = {
      receiving: false,
      mode: 'system-audio',
      activity: 'playing',
      title: 'System Audio Sharing',
      placeholder: false,
      sources: [],
      primers: 0,
    };
    expect(slot()).toEqual(sharing);
    expect(getState('player.currentTrackMeta')?.systemAudioMode).toBe('sharing');
    await advance(60_000);
    expect(slot()).toEqual(sharing);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(seen.counts.hostStarted).toBe(1);

    // Reset while publishing: the service cleans the coordinator graph before
    // it forgets the local-owner view, so the claim survives here too (the
    // capture module's own lease-lost reaction is not modelled).
    resetProSystemAudioService();
    expect(slot()).toEqual(sharing);
    expect(restorePlayback).toHaveBeenCalledTimes(1);
    expect(seen.toasts).toEqual([]);
  });

  it('S11 gap: a sharing claim made while still receiving keeps the claim but leaves receiving set with no source', async () => {
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS);

    // A race the UI does not offer directly (canStart needs an idle share):
    // the local sharing claim lands while the remote share is still received.
    claimSharing();
    await applyState(localLive(2));
    // The guard that protects the claim skips the whole receive cleanup.
    // Known gap (observed on d84f53f5, not device-verified): the source and
    // primer leave, but systemAudio.isReceiving stays true and the receive
    // restore point stays held, so the mode stays 'system-audio' on the
    // receiving flag as well as on the claim. Planned: the C4-7 slot end with
    // an ownership test that tells the slot's claim from a publisher's (C4
    // critique: placeholder, receiving meta or a slot-held claim token).
    expect(slot()).toEqual({
      receiving: true,
      mode: 'system-audio',
      activity: 'playing',
      title: 'System Audio Sharing',
      placeholder: false,
      sources: [],
      primers: 0,
    });
    expect(getState('player.currentTrackMeta')?.systemAudioMode).toBe('sharing');

    resetProSystemAudioService();
    expect(slot()).toMatchObject({ receiving: true, mode: 'system-audio', sources: [] });
    expect(getState('player.currentTrackMeta')?.systemAudioMode).toBe('sharing');
    expect(seen.toasts).toEqual([]);

    // The held restore point is replayed by the next receive end: a
    // force-stop (the capture's own teardown event) restores the title from
    // before the received share over the sharing meta.
    bus.emit('system-audio:force-stop');
    expect(slot()).toMatchObject({ receiving: false, mode: null, title: previousTitle });
  });

  it('begin re-entrancy: a remote share that arrives while local capture runs begins through a nested force-stop', async () => {
    claimSharing();
    media.captureActive = true;
    await applyState(localLive(1));
    expect(slot()).toMatchObject({ mode: 'system-audio', title: 'System Audio Sharing' });

    // The lease moved to a remote publication before the local capture
    // stopped. The coordinator end releases the sharing claim first (the
    // view is no longer the local owner), then the reception start's
    // stopAllMedia emits force-stop, whose receive cleanup runs inside the
    // begin, before the placeholder claim.
    await applyState(live(sfuPublication(), 2));
    expect(seen.counts.forceStops).toBe(1);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(seen.activities).toEqual(['idle', 'pending']);
    expect(slot()).toMatchObject({
      receiving: false,
      mode: 'system-audio',
      activity: 'pending',
      placeholder: true,
    });
    expect(seen.counts.hostStarted).toBe(1);

    // The nested cleanup does not break the begin: the track still attaches.
    await advance(PRO_TRACK_AT_MS);
    expect(slot()).toMatchObject({ receiving: true, sources: ['pro-sfu-audio-1'] });

    // Observed (d84f53f5, not device-verified): the restore point is empty.
    // The coordinator end restored the receive slot's empty restore meta over
    // the sharing meta, and the begin captured that. The share end therefore
    // leaves no title; the post-share restore is asked once, and in the app
    // the capture module's force-stop reaction (restore: false, not modelled)
    // runs as well. C4-2's 'claiming' phase must say what a nested end does.
    await applyState(idle(3));
    expect(slot()).toMatchObject({ receiving: false, mode: null, activity: 'idle', sources: [] });
    expect(getState('player.currentTrackMeta')).toBeNull();
    expect(restorePlayback).toHaveBeenCalledTimes(1);
    expect(seen.toasts).toEqual([]);
  });
});
