/**
 * @vitest-environment jsdom
 *
 * RO-21 against this device's own PRO system-audio share (2026-11-18). A press
 * of System Audio reads the load epoch in its own turn, and the share window's
 * capture is dropped when a newer load epoch has started by the time it
 * returns. A participant-local re-apply of the current checkpoint that is
 * preparing at the press (the post-share restore, the foreground repair, the
 * background-return Sync, manual Sync) must therefore neither cancel itself
 * later nor prepare again until the start settles, and while the share is live
 * none of them may prepare (its playTrack would stop every medium, the share
 * included). The same holds for such a pass's catch-up of a newer revision
 * this device already knew of at the press (a COMMIT it missed); a newer
 * revision it learns of after the press still discards the capture. A share
 * that goes live in the room after the press replaces what the press stopped:
 * when it ends, a video is re-armed once and a file stays stopped, as on every
 * other device of the room.
 *
 * The real capture start, bridge, service, runtime, playback controller and
 * authority hooks run here. The media endpoint is a fake that moves the load
 * epoch where the real one does: prepare starts a new one and stops every
 * medium (playTrack), and cancel starts a new one (playlist.ts).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { bus } from '../../core/events.ts';
import { log } from '../../core/log.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { getManagedTimer } from '../../core/timers.ts';
import { t } from '../../i18n/index.ts';
import { newLoadEpoch } from '../../player/_state.ts';
import {
  isSystemAudioActive,
  registerSystemCaptureListeners,
  startSystemAudioCapture,
} from '../../audio/system-capture.ts';
import { isSystemAudioCaptureActive } from '../../audio/system-audio-policy.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  ProRoomApiClient,
  type ProRoomPlaybackCommitEvent,
  type ProRoomPlaybackPrepareEvent,
  type ProRoomSignalingAccess,
} from '../api.ts';
import { ProRoomApiError } from '../api-error.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  capabilitiesForProRoomRole,
  type ProRoomPlaybackCheckpoint,
  type ProRoomSnapshot,
  type ProRoomSystemAudioState,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import * as serverClock from '../network-bridge.ts';
import {
  registerProPlaybackMediaEndpoint,
  type ProPlaybackMediaEndpoint,
  type ProPlaybackPrepareRequest,
  type ProPlaybackPrepareResult,
} from '../playback-authority-hooks.ts';
import { restoreProPlaybackAfterSystemAudioRelease } from '../system-audio-bridge.ts';
import { getProSystemAudioViewState, refreshProSystemAudioState } from '../system-audio-service.ts';
import {
  acceptProRoomRealtimeFrameForTests,
  joinProRoom,
  requestActiveProRoomPlaybackReconciliation,
  requestProRoomBackgroundReturnSync,
} from '../runtime.ts';
import { installProClockSnapshotMocks } from './__helpers__/pro-clock-fixture.ts';
import { proHeartbeat } from './__helpers__/pro-heartbeat.ts';
import { proSnapshot } from './__helpers__/pro-snapshot.ts';

const fakes = vi.hoisted(() => {
  const node = () => ({
    channelCount: 0,
    channelCountMode: '',
    channelInterpretation: '',
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  return {
    context: { createMediaStreamSource: () => node(), createGain: () => node() },
    publish: vi.fn(),
  };
});

// The capture's audio graph has no Web Audio here; only the nodes it builds.
vi.mock('../../audio/engine.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../audio/engine.ts')>()),
  initAudio: vi.fn(async () => {}),
  getAnalyser: vi.fn(() => ({})),
  getMasterGain: vi.fn(() => null),
}));
vi.mock('../../audio/context.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../audio/context.ts')>()),
  getAudioContext: vi.fn(() => fakes.context),
}));
// The capture's own STOP of the previous media; the endpoint fake below
// stands for the media it would stop.
vi.mock('../../player/transport.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../player/transport.ts')>()),
  stopAllMediaAsync: vi.fn(async () => true),
  getTrackPosition: vi.fn(() => 0),
}));
// The share's publication (RO-20) is outside this resource: the room answers
// it live at once. The lease is the real service's, against the API mocks.
vi.mock('../system-audio-bridge.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../system-audio-bridge.ts')>()),
  publishLocalProSystemAudio: fakes.publish,
}));
vi.mock('../../network/pro-system-audio-sfu.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/pro-system-audio-sfu.ts')>()),
  beginProSystemAudioSfuPublisherPreflight: vi.fn(() =>
    Object.freeze({ kind: 'pro-system-audio-sfu-publisher-preflight' as const }),
  ),
  cancelProSystemAudioSfuPublisherPreflight: vi.fn(),
  // Another member's live share: this device listens without a network here.
  subscribeProSystemAudioSfu: vi.fn(async () => {}),
}));

const ROOM_CODE = '000001';
const ROOM_EPOCH = 7;
const PARTICIPANT_ID = 'participant_00001';
/** Another device signed in as the room's owner. */
const OTHER_PARTICIPANT_ID = 'participant_00002';
const QUEUE_ITEM_ID = '43000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'dQw4w9WgXcQ';
const TRANSITION_NEWER = `transition_${'n'.repeat(22)}`;
const TRANSITION_CANCELLED = `transition_${'c'.repeat(22)}`;
const VISIBILITY_RECOVERY_TIMER = 'pro-room-visibility-playback-recovery';
const HEARTBEAT_TIMER = 'pro-room-heartbeat';
// Longer than the post-share restore's first two retries (250 ms, 1 s) and
// the foreground repair's first retry (1 s): nothing may prepare after them.
const RETRY_WINDOW_MS = 1_300;

function playback(
  revision: number,
  overrides: Partial<ProRoomPlaybackCheckpoint> = {},
): ProRoomPlaybackCheckpoint {
  return {
    coordinatorEpoch: ROOM_EPOCH,
    revision,
    state: revision === 0 ? 'idle' : 'playing',
    queueItemId: revision === 0 ? null : QUEUE_ITEM_ID,
    positionSeconds: 0,
    youtubeVideoId: revision === 0 ? null : VIDEO_ID,
    youtubeSubIndex: revision === 0 ? null : 0,
    updatedAtMs: 10_000 + revision,
    ...overrides,
  };
}

type Media = 'youtube' | 'file';

function snapshot(currentPlayback = playback(0), media: Media = 'youtube'): ProRoomSnapshot {
  const viewer = {
    memberId: 'member_0000000001',
    memberDisplayNumber: 0,
    isAuthenticated: true,
    participantId: PARTICIPANT_ID,
    displayName: 'Sharing owner',
    role: 'owner' as const,
    capabilities: [...capabilitiesForProRoomRole('owner')],
  };
  return proSnapshot({
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 1,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [
      media === 'youtube'
        ? {
            queueItemId: QUEUE_ITEM_ID,
            name: 'Shared video',
            source: { kind: 'youtube', videoId: VIDEO_ID },
          }
        : {
            queueItemId: QUEUE_ITEM_ID,
            name: 'Shared file',
            source: {
              kind: 'pro-r2',
              assetId: 'asset_00000000001',
              version: 1,
              byteLength: 1024,
              mime: 'audio/flac',
            },
          },
    ],
    currentQueueItemId: currentPlayback.queueItemId,
    playback: currentPlayback,
    presence: {
      coordinatorEpoch: ROOM_EPOCH,
      revision: 1,
      participants: [{ ...viewer, devicePlatform: 'other', joinedAtMs: 1 }],
    },
    quota: {
      limitBytes: PRO_ROOM_QUOTA_BYTES,
      perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
      usedBytes: 0,
      reservedBytes: 0,
    },
    viewer: { ...viewer, presenceIncarnationId: 'presence_0000000001' },
    administrators: [
      {
        memberId: 'member_0000000001',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Sharing owner',
        role: 'owner',
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': true,
        },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 1,
      },
    ],
  });
}

function shareState(
  generation: number,
  status: ProRoomSystemAudioState['status'],
): ProRoomSystemAudioState {
  if (status === 'idle') {
    return {
      generation,
      status,
      ownerParticipantId: null,
      claimExpiresAt: null,
      liveExpiresAt: null,
      publication: null,
    };
  }
  if (status === 'preparing') {
    return {
      generation,
      status,
      ownerParticipantId: PARTICIPANT_ID,
      claimExpiresAt: Date.now() + 45_000,
      liveExpiresAt: null,
      publication: null,
    };
  }
  return {
    generation,
    status,
    ownerParticipantId: PARTICIPANT_ID,
    claimExpiresAt: null,
    liveExpiresAt: Date.now() + 60_000,
    publication: {
      publicationId: 'publication_00001',
      sessionId: 'session_000000001',
      track: { trackName: 'audio-stereo', mid: '0' },
    },
  };
}

/** The lease of another device signed in as the room's owner. */
function otherOwnerShareState(
  generation: number,
  status: 'preparing' | 'live',
): ProRoomSystemAudioState {
  if (status === 'preparing') {
    return {
      generation,
      status,
      ownerParticipantId: OTHER_PARTICIPANT_ID,
      claimExpiresAt: Date.now() + 45_000,
      liveExpiresAt: null,
      publication: null,
    };
  }
  return {
    generation,
    status,
    ownerParticipantId: OTHER_PARTICIPANT_ID,
    claimExpiresAt: null,
    liveExpiresAt: Date.now() + 60_000,
    publication: {
      publicationId: 'publication_00002',
      sessionId: 'session_000000002',
      track: { trackName: 'audio-stereo', mid: '0' },
    },
  };
}

function serverFrame(event: Record<string, unknown>) {
  return {
    type: 'pro-server-event' as const,
    version: 1 as const,
    roomCode: ROOM_CODE,
    coordinatorEpoch: ROOM_EPOCH,
    event: event as Record<string, unknown> & { type: string },
  };
}

function commitEvent(
  transitionId: string | null,
  checkpoint: ProRoomPlaybackCheckpoint,
): ProRoomPlaybackCommitEvent {
  const serverTimeMs = Date.now();
  return {
    type: 'pro-playback-commit',
    transitionId,
    serverTimeMs,
    executeAtMs: serverTimeMs,
    playback: checkpoint,
  };
}

function prepareEvent(
  transitionId: string,
  target: ProRoomPlaybackCheckpoint,
): ProRoomPlaybackPrepareEvent {
  const serverTimeMs = Date.now();
  return {
    type: 'pro-playback-prepare',
    transitionId,
    serverTimeMs,
    deadlineAtMs: serverTimeMs + 3_000,
    basePlaybackRevision: target.revision - 1,
    target,
  };
}

function setDocumentVisibility(value: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange'));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A held step: the media or the room answers once the test opens it. */
interface Gate {
  readonly reached: Promise<void>;
  open(): void;
}

function gate(queue: Gate[]): Gate {
  let open!: () => void;
  const reached = new Promise<void>((resolve) => {
    open = resolve;
  });
  const held: Gate = { reached, open: () => open() };
  queue.push(held);
  return held;
}

/** A captured share: one live audio track and the video track the capture discards. */
function capturedStream(): MediaStream {
  let readyState: MediaStreamTrackState = 'live';
  const listeners = new Set<() => void>();
  const audio = {
    id: 'captured-audio-track',
    kind: 'audio',
    get readyState() {
      return readyState;
    },
    muted: false,
    contentHint: '',
    stop: vi.fn(() => {
      readyState = 'ended';
    }),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'ended') listeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'ended') listeners.delete(listener);
    }),
  } as unknown as MediaStreamTrack;
  const video = {
    id: 'captured-video-track',
    kind: 'video',
    readyState: 'live',
    getSettings: () => ({ displaySurface: 'browser' }),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  return {
    get active() {
      return readyState === 'live';
    },
    getAudioTracks: () => [audio],
    getVideoTracks: () => [video],
    getTracks: () => [audio, video],
  } as unknown as MediaStream;
}

describe(
  'RO-21 holds checkpoint re-applies for this device own PRO share',
  { concurrent: false },
  () => {
    const restoreSpies: Array<{ mockRestore(): void }> = [];
    const prepareGates: Gate[] = [];
    const commitGates: Gate[] = [];
    const heartbeatGates: Gate[] = [];
    const openedGates: Gate[] = [];
    let roomSnapshot: ProRoomSnapshot;
    let systemAudio: ProRoomSystemAudioState;
    let systemAudioGeneration: number;
    let prepareMedia: Mock<ProPlaybackMediaEndpoint['prepare']>;
    let commitMedia: Mock<ProPlaybackMediaEndpoint['commit']>;
    let cancelMedia: Mock<NonNullable<ProPlaybackMediaEndpoint['cancel']>>;
    let toasts: string[];
    let superseded: Mock;
    let pendingWindows: Array<() => void>;

    beforeAll(() => {
      registerSystemCaptureListeners();
    });

    beforeEach(async () => {
      restoreSpies.push(
        ...installProClockSnapshotMocks(serverClock, { retainSuccessfulAcquisition: true }),
      );
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      resetState();
      prepareGates.length = 0;
      commitGates.length = 0;
      heartbeatGates.length = 0;
      openedGates.length = 0;
      pendingWindows = [];
      roomSnapshot = snapshot();
      systemAudioGeneration = 0;
      systemAudio = shareState(0, 'idle');
      toasts = [];
      const stopToasts = bus.on('ui:show-toast', (text) => {
        toasts.push(text);
      });
      restoreSpies.push({ mockRestore: stopToasts });

      restoreSpies.push(
        vi
          .spyOn(ProRoomApiClient.prototype, 'createSession')
          .mockImplementation(async () => roomSnapshot),
        vi.spyOn(ProRoomApiClient.prototype, 'createSignalingTicket').mockResolvedValue({
          ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
          expiresAtMs: Date.now() + 60_000,
          role: 'member',
          coordinatorEpoch: ROOM_EPOCH,
          presenceIncarnationId: 'presence_0000000001',
          ticketSequence: 1,
          pendingPlaybackTransition: null,
        }),
        vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockImplementation(async () => {
          const held = heartbeatGates.shift();
          if (held) {
            openedGates.push(held);
            await held.reached;
          }
          return proHeartbeat(roomSnapshot, systemAudio);
        }),
        vi.spyOn(ProRoomApiClient.prototype, 'reportMediaDuration').mockResolvedValue(undefined),
        vi.spyOn(ProRoomApiClient.prototype, 'getSettingsSync').mockResolvedValue({
          schemaVersion: 1,
          view: 'settings-sync',
          roomCode: ROOM_CODE,
          revision: 0,
          updatedAtMs: 1,
          masterVolume: 1,
          effects: createDefaultRoomEffectsState(),
        }),
        vi.spyOn(ProRoomApiClient.prototype, 'getQueueMode').mockResolvedValue({
          schemaVersion: 1,
          view: 'queue-mode',
          roomCode: ROOM_CODE,
          revision: 0,
          playlistRevision: 1,
          updatedAtMs: 1,
          repeatMode: 0,
          shuffleEnabled: false,
          shuffleOrder: [],
        }),
        // A stateful lease, as the room keeps it.
        vi
          .spyOn(ProRoomApiClient.prototype, 'getSystemAudioState')
          .mockImplementation(async () => systemAudio),
        vi
          .spyOn(ProRoomApiClient.prototype, 'acquireSystemAudioLease')
          .mockImplementation(async () => {
            systemAudioGeneration += 1;
            systemAudio = shareState(systemAudioGeneration, 'preparing');
            return { systemAudio, leaseId: 'L'.repeat(43) };
          }),
        vi
          .spyOn(ProRoomApiClient.prototype, 'releaseSystemAudioLease')
          .mockImplementation(async () => {
            systemAudioGeneration += 1;
            systemAudio = shareState(systemAudioGeneration, 'idle');
            return systemAudio;
          }),
        vi
          .spyOn(ProRoomApiClient.prototype, 'reportPlaybackTransitionReady')
          .mockResolvedValue('waiting'),
        vi.spyOn(ProRoomApiClient.prototype, 'closePresenceOnUnload').mockResolvedValue(undefined),
        vi.spyOn(ProRoomApiClient.prototype, 'closeSessionFenced').mockResolvedValue(undefined),
        vi.spyOn(ServerProRoomNetworkBridge.prototype, 'connect').mockResolvedValue(undefined),
        vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {}),
        vi
          .spyOn(ServerProRoomNetworkBridge.prototype, 'clockCalibrated', 'get')
          .mockReturnValue(true),
        vi
          .spyOn(ServerProRoomNetworkBridge.prototype, 'waitForFreshClockCalibration')
          .mockResolvedValue(true),
      );
      superseded = vi.fn();
      const info = vi.spyOn(log, 'info').mockImplementation((...args: unknown[]) => {
        if (String(args[0]).startsWith('[SystemAudio] Capture start superseded')) {
          superseded(String(args[0]), String(args[1]));
        }
      });
      restoreSpies.push(info);

      fakes.publish.mockReset().mockImplementation(async () => {
        systemAudio = shareState(systemAudioGeneration, 'live');
        return systemAudio;
      });
      prepareMedia = vi.fn<ProPlaybackMediaEndpoint['prepare']>(async (request) => {
        // As playTrack: a new load epoch, and every medium stops, a live share
        // included (transport.ts stopAllMedia).
        newLoadEpoch();
        if (isSystemAudioCaptureActive()) bus.emit('system-audio:force-stop');
        const held = prepareGates.shift();
        if (held) {
          openedGates.push(held);
          await held.reached;
        }
        return ready(request);
      });
      commitMedia = vi.fn<ProPlaybackMediaEndpoint['commit']>(async (request) => {
        // A held commit waits for its release instant, as a YouTube release does.
        const held = commitGates.shift();
        if (held) {
          openedGates.push(held);
          await held.reached;
        }
        return { status: 'applied' as const, authority: request.authority };
      });
      // As playlist.ts's endpoint cancel: a new load epoch.
      cancelMedia = vi.fn<NonNullable<ProPlaybackMediaEndpoint['cancel']>>(() => {
        newLoadEpoch();
      });
      registerProPlaybackMediaEndpoint({
        prepare: prepareMedia,
        commit: commitMedia,
        cancel: cancelMedia,
      });

      await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
      await vi.waitFor(() => expect(getState('room.context').kind).toBe('pro'));
    });

    afterEach(async () => {
      for (const cancel of pendingWindows.splice(0)) cancel();
      for (const held of [
        ...prepareGates.splice(0),
        ...commitGates.splice(0),
        ...heartbeatGates.splice(0),
        ...openedGates.splice(0),
      ]) {
        held.open();
      }
      await sleep(0);
      if (isSystemAudioActive()) bus.emit('system-audio:force-stop');
      const hadActiveSession = getState('room.context').kind === 'pro';
      requestProRoomLeave();
      await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
      if (hadActiveSession) await sleep(0);
      registerProPlaybackMediaEndpoint(null);
      for (const spy of restoreSpies.splice(0).reverse()) spy.mockRestore();
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      resetState();
    });

    function ready(request: Readonly<ProPlaybackPrepareRequest>): ProPlaybackPrepareResult {
      const youtube = request.youtubeVideoId !== null && request.youtubeVideoId !== undefined;
      return {
        status: 'ready',
        authority: request.authority,
        queueItemId: request.queueItemId,
        mediaKind: youtube ? 'youtube' : 'file',
        durationSeconds: 180,
        youtubeSubIndex: youtube ? (request.youtubeSubIndex ?? 0) : null,
        youtubeVideoId: youtube ? (request.youtubeVideoId ?? null) : null,
      };
    }

    /** The room's current checkpoint, applied on this device; every count back to zero. */
    async function establishCheckpoint(
      state: 'playing' | 'paused',
      media: Media = 'youtube',
    ): Promise<void> {
      const checkpoint = playback(1, {
        state,
        positionSeconds: 37.5,
        updatedAtMs: Date.now(),
        ...(media === 'file' ? { youtubeVideoId: null, youtubeSubIndex: null } : {}),
      });
      roomSnapshot = { ...snapshot(checkpoint, media), revision: 2 };
      acceptProRoomRealtimeFrameForTests(serverFrame({ ...commitEvent(null, checkpoint) }));
      await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
      await sleep(20);
      prepareMedia.mockClear();
      commitMedia.mockClear();
      cancelMedia.mockClear();
      vi.mocked(ProRoomApiClient.prototype.heartbeat).mockClear();
    }

    /**
     * This device's earlier share ends with the room still on its checkpoint: the
     * post-share restore starts once the room answers the release.
     */
    async function endEarlierLocalShare(hidden = false): Promise<void> {
      systemAudioGeneration += 1;
      systemAudio = shareState(systemAudioGeneration, 'live');
      await refreshProSystemAudioState();
      setState('playback.mode', 'system-audio');
      setState('playback.activity', 'playing');
      if (hidden) setDocumentVisibility('hidden');
      restoreProPlaybackAfterSystemAudioRelease(() => true);
      systemAudioGeneration += 1;
      systemAudio = shareState(systemAudioGeneration, 'idle');
      await refreshProSystemAudioState();
    }

    /** The press of System Audio, with the browser's share window held open. */
    function pressSystemAudio(): {
      select(): void;
      cancel(): void;
      settled: Promise<boolean>;
    } {
      let resolveWindow!: (stream: MediaStream) => void;
      let rejectWindow!: (error: unknown) => void;
      const opened = new Promise<MediaStream>((resolve, reject) => {
        resolveWindow = resolve;
        rejectWindow = reject;
      });
      const cancel = () => rejectWindow(new DOMException('Permission denied', 'NotAllowedError'));
      pendingWindows.push(cancel);
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getDisplayMedia: vi.fn(() => opened) },
      });
      const settlement = new Promise<boolean>((resolve) => {
        const stop = bus.on('system-audio:start-settled', ({ started }) => {
          stop();
          resolve(started);
        });
      });
      // The start never rejects on these paths; a rejection fails the row.
      const settled = Promise.all([settlement, startSystemAudioCapture()]).then(
        ([started]) => started,
      );
      return { select: () => resolveWindow(capturedStream()), cancel, settled };
    }

    /**
     * The share's publication waits after the room has committed it live (as a
     * LAN-direct share re-proves its route), so the start has not settled yet;
     * `end` ends it as a publication that lost its lease.
     */
    function holdPublicationAfterLiveCommit(): { end(): void } {
      let end!: () => void;
      fakes.publish.mockImplementation(
        () =>
          new Promise<ProRoomSystemAudioState>((_resolve, reject) => {
            end = () => reject(new Error('PRO_SYSTEM_AUDIO_LEASE_UNAVAILABLE'));
          }),
      );
      return { end: () => end() };
    }

    /** A room invalidation runs the room's ordinary presence heartbeat. */
    async function runRoomHeartbeat(): Promise<void> {
      const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
      const before = heartbeat.mock.calls.length;
      acceptProRoomRealtimeFrameForTests(
        serverFrame({ type: 'pro-room-invalidated', roomRevision: 3 }),
      );
      await vi.waitFor(() => expect(heartbeat.mock.calls.length).toBeGreaterThan(before));
    }

    /**
     * This device's live share ends from Stop, once the room's live answer has
     * reached the service: the post-share restore runs when the room answers
     * the release, and then the room's next presence heartbeat. The endpoint
     * counts start at the Stop.
     */
    async function stopLiveShareThenRunHeartbeat(): Promise<void> {
      await refreshProSystemAudioState();
      expect(getProSystemAudioViewState()).toMatchObject({ phase: 'live', isLocalOwner: true });
      prepareMedia.mockClear();
      commitMedia.mockClear();
      bus.emit('system-audio:stop');
      expect(isSystemAudioActive()).toBe(false);
      // Past the post-share restore and its first retries.
      await sleep(RETRY_WINDOW_MS);
      await runRoomHeartbeat();
      await sleep(RETRY_WINDOW_MS);
    }

    describe('a press while a re-apply prepares starts the share', () => {
      it.each(['paused', 'playing'] as const)(
        'R1: the post-share restore of a %s YouTube checkpoint, still preparing at the press, neither swallows the share nor prepares again',
        async (state) => {
          await establishCheckpoint(state);
          const restore = gate(prepareGates);
          await endEarlierLocalShare();
          await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());

          const share = pressSystemAudio();
          // The press cancels the restore's preparation in its own turn, so the
          // load epoch that cancel starts is the one the start reads.
          expect.soft(cancelMedia).toHaveBeenCalledOnce();
          // The iframe the restore was preparing finishes loading afterwards.
          restore.open();
          await sleep(20);
          share.select();

          await expect(share.settled).resolves.toBe(true);
          expect(superseded).not.toHaveBeenCalled();
          expect(isSystemAudioActive()).toBe(true);
          expect(fakes.publish).toHaveBeenCalledOnce();
          await sleep(RETRY_WINDOW_MS);
          expect(prepareMedia).toHaveBeenCalledOnce();
          expect(cancelMedia).toHaveBeenCalledOnce();
          expect(isSystemAudioActive()).toBe(true);
        },
      );

      it('A: a press after a hide and show, before the foreground repair prepares, starts the share and the repair neither prepares nor retries', async () => {
        await establishCheckpoint('playing');
        const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
        const repairHeartbeat = gate(heartbeatGates);
        setDocumentVisibility('hidden');
        setDocumentVisibility('visible');
        await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());

        const share = pressSystemAudio();
        repairHeartbeat.open();
        await sleep(50);
        share.select();

        await expect(share.settled).resolves.toBe(true);
        expect(superseded).not.toHaveBeenCalled();
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).not.toHaveBeenCalled();
        expect(getManagedTimer(VISIBILITY_RECOVERY_TIMER)).toBeNull();
        expect(isSystemAudioActive()).toBe(true);
      });

      it('A: a manual Sync started just before the press prepares nothing and the share starts', async () => {
        await establishCheckpoint('playing');
        const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
        const syncHeartbeat = gate(heartbeatGates);
        const sync = requestActiveProRoomPlaybackReconciliation();
        await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());

        const share = pressSystemAudio();
        syncHeartbeat.open();
        await sleep(50);
        share.select();

        await expect(share.settled).resolves.toBe(true);
        expect(superseded).not.toHaveBeenCalled();
        await expect(sync).resolves.toBe(false);
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).not.toHaveBeenCalled();
        expect(isSystemAudioActive()).toBe(true);
      });

      it('A: a background-return Sync of a playing file started just before the press prepares nothing and the share starts', async () => {
        await establishCheckpoint('playing', 'file');
        const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
        // The YouTube-only foreground repair cannot cover the file and settles;
        // the background-return Sync widens this return to every medium.
        setDocumentVisibility('hidden');
        setDocumentVisibility('visible');
        await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());
        await sleep(50);
        expect(prepareMedia).not.toHaveBeenCalled();
        const syncHeartbeat = gate(heartbeatGates);
        requestProRoomBackgroundReturnSync();
        await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(2));

        const share = pressSystemAudio();
        syncHeartbeat.open();
        await sleep(50);
        share.select();

        await expect(share.settled).resolves.toBe(true);
        expect(superseded).not.toHaveBeenCalled();
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).not.toHaveBeenCalled();
        expect(getManagedTimer(VISIBILITY_RECOVERY_TIMER)).toBeNull();
        expect(isSystemAudioActive()).toBe(true);
      });

      it('B: a press during the foreground repair preparation in a playing room cancels it in the press turn, and no retry prepares it again', async () => {
        await establishCheckpoint('playing');
        const repair = gate(prepareGates);
        setDocumentVisibility('hidden');
        setDocumentVisibility('visible');
        await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());

        const share = pressSystemAudio();
        expect.soft(cancelMedia).toHaveBeenCalledOnce();
        repair.open();
        await sleep(20);
        share.select();

        await expect(share.settled).resolves.toBe(true);
        expect(superseded).not.toHaveBeenCalled();
        // Past VISIBILITY_PLAYBACK_RECOVERY_RETRY_MS[0]: the stopped repair does
        // not prepare the checkpoint again (and would stop the share if it did).
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).toHaveBeenCalledOnce();
        expect(getManagedTimer(VISIBILITY_RECOVERY_TIMER)).toBeNull();
        expect(isSystemAudioActive()).toBe(true);
      });

      it('C: with a shared tab, the foreground repair queued behind the post-share restore prepares nothing after the press and keeps the presence heartbeat', async () => {
        await establishCheckpoint('playing');
        // The restore's preparation stalls like an iframe in a hidden tab.
        const restore = gate(prepareGates);
        await endEarlierLocalShare(true);
        await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
        // Back on the page: the visibility handler clears the presence heartbeat
        // loop for the foreground repair, which queues behind the restore.
        setDocumentVisibility('visible');
        await sleep(50);
        expect(prepareMedia).toHaveBeenCalledOnce();

        const share = pressSystemAudio();
        restore.open();
        await sleep(100);
        share.select();

        await expect(share.settled).resolves.toBe(true);
        expect(superseded).not.toHaveBeenCalled();
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).toHaveBeenCalledOnce();
        expect(isSystemAudioActive()).toBe(true);
        // The hold dropped the queued repair before its forced heartbeat ran.
        expect(getManagedTimer(HEARTBEAT_TIMER)).not.toBeNull();
      });
    });

    describe('a press while the recovery of a cancelled PREPARE prepares starts the share', () => {
      type RecoveryOwner = 'the post-share restore' | 'a hide and show' | 'a manual Sync';

      /**
       * A server PREPARE of revision 2 prepares here and the room cancels it,
       * so this device owes the recovery of revision 1, the checkpoint it applied.
       */
      async function cancelNewerPrepare(media: Media = 'youtube'): Promise<void> {
        const target = playback(2, {
          state: 'playing',
          positionSeconds: 0,
          updatedAtMs: Date.now(),
          ...(media === 'file' ? { youtubeVideoId: null, youtubeSubIndex: null } : {}),
        });
        acceptProRoomRealtimeFrameForTests(
          serverFrame({ ...prepareEvent(TRANSITION_CANCELLED, target) }),
        );
        await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
        await sleep(20);
        acceptProRoomRealtimeFrameForTests(
          serverFrame({
            type: 'pro-playback-cancel',
            transitionId: TRANSITION_CANCELLED,
            serverTimeMs: Date.now(),
            reason: 'queue-item-removed',
          }),
        );
        await vi.waitFor(() => expect(cancelMedia).toHaveBeenCalledOnce());
        prepareMedia.mockClear();
        commitMedia.mockClear();
        cancelMedia.mockClear();
        vi.mocked(ProRoomApiClient.prototype.heartbeat).mockClear();
      }

      /** An RO-21 pass starts that recovery, whose iframe stalls while it loads. */
      async function startRecovery(owner: RecoveryOwner): Promise<{
        recovery: Gate;
        sync: Promise<boolean> | null;
      }> {
        const recovery = gate(prepareGates);
        let sync: Promise<boolean> | null = null;
        if (owner === 'the post-share restore') {
          await endEarlierLocalShare();
        } else if (owner === 'a hide and show') {
          setDocumentVisibility('hidden');
          setDocumentVisibility('visible');
        } else {
          sync = requestActiveProRoomPlaybackReconciliation();
        }
        await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
        expect(prepareMedia.mock.calls[0]?.[0].authority.transitionId).toBe('snapshot_1');
        return { recovery, sync };
      }

      it.each(['the post-share restore', 'a hide and show', 'a manual Sync'] as const)(
        'I3: the recovery that %s started is cancelled in the press turn and does not prepare again',
        async (owner) => {
          await establishCheckpoint('paused');
          await cancelNewerPrepare();
          const { recovery, sync } = await startRecovery(owner);

          const share = pressSystemAudio();
          // Its endpoint cancel starts the load epoch the start reads.
          expect.soft(cancelMedia).toHaveBeenCalledOnce();
          recovery.open();
          await sleep(20);
          share.select();

          await expect(share.settled).resolves.toBe(true);
          expect(superseded).not.toHaveBeenCalled();
          if (sync) await expect(sync).resolves.toBe(false);
          await sleep(RETRY_WINDOW_MS);
          expect(prepareMedia).toHaveBeenCalledOnce();
          expect(cancelMedia).toHaveBeenCalledOnce();
          expect(isSystemAudioActive()).toBe(true);
        },
      );

      it.each(['joins it before the press', 'comes while the share window is open'] as const)(
        'I3: a room heartbeat that %s starts no recovery until the start settles',
        async (when) => {
          await establishCheckpoint('paused');
          await cancelNewerPrepare();
          const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
          const { recovery } = await startRecovery('the post-share restore');
          // A room invalidation runs the ordinary presence heartbeat, whose
          // snapshot restore recovers the cancelled PREPARE's base too.
          const invalidate = async () => {
            const before = heartbeat.mock.calls.length;
            acceptProRoomRealtimeFrameForTests(
              serverFrame({ type: 'pro-room-invalidated', roomRevision: 3 }),
            );
            await vi.waitFor(() => expect(heartbeat.mock.calls.length).toBeGreaterThan(before));
            await sleep(20);
          };
          if (when === 'joins it before the press') await invalidate();

          const share = pressSystemAudio();
          recovery.open();
          await sleep(20);
          if (when === 'comes while the share window is open') await invalidate();
          expect(prepareMedia).toHaveBeenCalledOnce();
          share.select();

          await expect(share.settled).resolves.toBe(true);
          expect(superseded).not.toHaveBeenCalled();
          await sleep(RETRY_WINDOW_MS);
          expect(prepareMedia).toHaveBeenCalledOnce();
          expect(isSystemAudioActive()).toBe(true);
        },
      );

      it('I3: re-applies the recovered checkpoint once when the share window is cancelled', async () => {
        await establishCheckpoint('paused');
        await cancelNewerPrepare();
        const { recovery } = await startRecovery('the post-share restore');

        const share = pressSystemAudio();
        recovery.open();
        await sleep(20);
        share.cancel();

        await expect(share.settled).resolves.toBe(false);
        expect.soft(superseded).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(commitMedia).toHaveBeenCalled());
        await sleep(RETRY_WINDOW_MS);
        const prepares = prepareMedia.mock.calls.length;
        const commits = commitMedia.mock.calls.length;
        for (const [request] of commitMedia.mock.calls) {
          expect(request).toMatchObject({
            committedPlaybackRevision: 1,
            queueItemId: QUEUE_ITEM_ID,
            state: 'paused',
            positionSeconds: 37.5,
          });
        }
        // One re-apply: nothing prepares or commits again afterwards.
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).toHaveBeenCalledTimes(prepares);
        expect(commitMedia).toHaveBeenCalledTimes(commits);
      });

      it.each(['a manual Sync', 'the post-share restore'] as const)(
        'I2-1: a share that goes live over the recovery of the applied playing file that %s started leaves the file stopped when it ends',
        async (owner) => {
          await establishCheckpoint('playing', 'file');
          await cancelNewerPrepare('file');
          const { recovery, sync } = await startRecovery(owner);

          const share = pressSystemAudio();
          recovery.open();
          await sleep(20);
          share.select();
          await expect(share.settled).resolves.toBe(true);
          if (sync) await expect(sync).resolves.toBe(false);

          await stopLiveShareThenRunHeartbeat();

          // Files stay stopped after a share on every device of the room: the
          // share replaced the playback that recovery was for.
          expect(prepareMedia).not.toHaveBeenCalled();
          expect(commitMedia).not.toHaveBeenCalled();
        },
      );
    });

    describe('a press while a re-apply pass catches up a newer revision starts the share', () => {
      type CatchUpOwner = 'a hide and show' | 'a manual Sync' | 'the room heartbeat';
      type CatchUpStage = 'preparing' | 'waiting for its release';

      /**
       * The room moved to revision 2 while this device missed its COMMIT (its
       * control channel was down, for example). The next heartbeat snapshot says
       * so, and the catch-up of revision 2 it starts stalls, still preparing or
       * waiting for its release instant.
       */
      async function startCatchUp(
        owner: CatchUpOwner,
        stage: CatchUpStage = 'preparing',
        media: Media = 'youtube',
      ): Promise<{ held: Gate; sync: Promise<boolean> | null }> {
        await establishCheckpoint('playing', media);
        const missed = playback(2, {
          state: 'playing',
          positionSeconds: 0,
          updatedAtMs: Date.now(),
          ...(media === 'file' ? { youtubeVideoId: null, youtubeSubIndex: null } : {}),
        });
        roomSnapshot = { ...snapshot(missed, media), revision: 3 };
        const held = gate(stage === 'preparing' ? prepareGates : commitGates);
        let sync: Promise<boolean> | null = null;
        if (owner === 'a hide and show') {
          setDocumentVisibility('hidden');
          setDocumentVisibility('visible');
        } else if (owner === 'a manual Sync') {
          sync = requestActiveProRoomPlaybackReconciliation();
        } else {
          acceptProRoomRealtimeFrameForTests(
            serverFrame({ type: 'pro-room-invalidated', roomRevision: 3 }),
          );
        }
        await vi.waitFor(() =>
          expect(stage === 'preparing' ? prepareMedia : commitMedia).toHaveBeenCalledOnce(),
        );
        expect(prepareMedia).toHaveBeenCalledOnce();
        expect(prepareMedia.mock.calls[0]?.[0].authority).toMatchObject({
          basePlaybackRevision: 1,
          transitionId: 'snapshot_2',
        });
        return { held, sync };
      }

      it.each([
        ['a hide and show', 'preparing'],
        ['a manual Sync', 'preparing'],
        ['a hide and show', 'waiting for its release'],
        ['a manual Sync', 'waiting for its release'],
      ] as const)(
        'S3: the catch-up of a missed newer COMMIT that %s started, still %s at the press, is cancelled in the press turn and the share starts',
        async (owner, stage) => {
          const { held, sync } = await startCatchUp(owner, stage);

          const share = pressSystemAudio();
          // Its endpoint cancel starts the load epoch the start reads.
          expect.soft(cancelMedia).toHaveBeenCalledOnce();
          held.open();
          await sleep(20);
          share.select();

          await expect(share.settled).resolves.toBe(true);
          expect(superseded).not.toHaveBeenCalled();
          if (sync) await expect(sync).resolves.toBe(false);
          await sleep(RETRY_WINDOW_MS);
          // Nothing prepares the newer revision again, which would stop the share.
          expect(prepareMedia).toHaveBeenCalledOnce();
          expect(cancelMedia).toHaveBeenCalledOnce();
          expect(commitMedia).toHaveBeenCalledTimes(stage === 'preparing' ? 0 : 1);
          expect(isSystemAudioActive()).toBe(true);
        },
      );

      it.each(['joins it before the press', 'comes while the share window is open'] as const)(
        'S3: a room heartbeat that %s starts no catch-up until the start settles',
        async (when) => {
          const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
          const { held } = await startCatchUp('a hide and show');
          // A room invalidation runs the ordinary presence heartbeat, whose
          // snapshot restore catches the newer revision up too.
          const invalidate = async () => {
            const before = heartbeat.mock.calls.length;
            acceptProRoomRealtimeFrameForTests(
              serverFrame({ type: 'pro-room-invalidated', roomRevision: 3 }),
            );
            await vi.waitFor(() => expect(heartbeat.mock.calls.length).toBeGreaterThan(before));
            await sleep(20);
          };
          if (when === 'joins it before the press') await invalidate();

          const share = pressSystemAudio();
          held.open();
          await sleep(20);
          if (when === 'comes while the share window is open') await invalidate();
          expect(prepareMedia).toHaveBeenCalledOnce();
          share.select();

          await expect(share.settled).resolves.toBe(true);
          expect(superseded).not.toHaveBeenCalled();
          await sleep(RETRY_WINDOW_MS);
          expect(prepareMedia).toHaveBeenCalledOnce();
          expect(commitMedia).not.toHaveBeenCalled();
          expect(isSystemAudioActive()).toBe(true);
        },
      );

      it.each(['before', 'after'] as const)(
        'S3: a COMMIT frame of the caught-up revision that arrives %s the press starts no catch-up of it, and the share starts',
        async (when) => {
          const { held } = await startCatchUp('a hide and show');
          // The COMMIT this device missed reaches it late (the room's outbox
          // retries an undelivered COMMIT) and crosses the heartbeat snapshot.
          const lateCommit = () =>
            acceptProRoomRealtimeFrameForTests(
              serverFrame({ ...commitEvent(TRANSITION_NEWER, roomSnapshot.playback) }),
            );
          if (when === 'before') lateCommit();
          await sleep(10);

          const share = pressSystemAudio();
          if (when === 'after') lateCommit();
          held.open();
          await sleep(50);
          share.select();

          await expect(share.settled).resolves.toBe(true);
          expect(superseded).not.toHaveBeenCalled();
          await sleep(RETRY_WINDOW_MS);
          // Its preparation would start a load epoch after the press read one.
          expect(prepareMedia).toHaveBeenCalledOnce();
          expect(commitMedia).not.toHaveBeenCalled();
          expect(isSystemAudioActive()).toBe(true);
        },
      );

      it('S3: a COMMIT frame of the caught-up revision that arrived before the press is applied once when the share window is cancelled', async () => {
        const { held } = await startCatchUp('a hide and show');
        acceptProRoomRealtimeFrameForTests(
          serverFrame({ ...commitEvent(TRANSITION_NEWER, roomSnapshot.playback) }),
        );
        await sleep(10);

        const share = pressSystemAudio();
        held.open();
        await sleep(50);
        share.cancel();

        await expect(share.settled).resolves.toBe(false);
        expect.soft(superseded).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
        expect(commitMedia.mock.calls[0]?.[0]).toMatchObject({
          committedPlaybackRevision: 2,
          queueItemId: QUEUE_ITEM_ID,
          state: 'playing',
        });
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).toHaveBeenCalledTimes(2);
        expect(commitMedia).toHaveBeenCalledOnce();
      });

      it.each(['a hide and show', 'a manual Sync'] as const)(
        'I2-1: a share that goes live over the catch-up of a missed playing file that %s started leaves the file stopped when it ends',
        async (owner) => {
          const { held, sync } = await startCatchUp(owner, 'preparing', 'file');

          const share = pressSystemAudio();
          held.open();
          await sleep(20);
          share.select();
          await expect(share.settled).resolves.toBe(true);
          if (sync) await expect(sync).resolves.toBe(false);

          await stopLiveShareThenRunHeartbeat();

          // Files stay stopped after a share on every device of the room, and
          // here on eae02e897, where the catch-up applied before the share's
          // STOP: neither the post-share restore nor the next heartbeat plays
          // revision 2 on this device alone.
          expect(prepareMedia).not.toHaveBeenCalled();
          expect(commitMedia).not.toHaveBeenCalled();
        },
      );

      it('I2-1: a share that goes live over the catch-up of a missed playing video re-arms the video once when it ends', async () => {
        const { held, sync } = await startCatchUp('a manual Sync');

        const share = pressSystemAudio();
        held.open();
        await sleep(20);
        share.select();
        await expect(share.settled).resolves.toBe(true);
        if (sync) await expect(sync).resolves.toBe(false);

        await stopLiveShareThenRunHeartbeat();

        expect(prepareMedia).toHaveBeenCalledOnce();
        expect(commitMedia).toHaveBeenCalledOnce();
        expect(commitMedia.mock.calls[0]?.[0]).toMatchObject({
          committedPlaybackRevision: 2,
          queueItemId: QUEUE_ITEM_ID,
          state: 'playing',
        });
      });

      it('I2-1: Stop after the room committed the share live over the catch-up of a missed playing file, before the start settled, leaves the file stopped', async () => {
        const { held, sync } = await startCatchUp('a manual Sync', 'preparing', 'file');
        const publication = holdPublicationAfterLiveCommit();

        const share = pressSystemAudio();
        held.open();
        await sleep(20);
        share.select();
        await vi.waitFor(() => expect(fakes.publish).toHaveBeenCalledOnce());
        if (sync) await expect(sync).resolves.toBe(false);
        systemAudio = shareState(systemAudioGeneration, 'live');

        await stopLiveShareThenRunHeartbeat();
        publication.end();
        await expect(share.settled).resolves.toBe(false);
        await sleep(RETRY_WINDOW_MS);

        // As when this device's share went live: the room had it live.
        expect(prepareMedia).not.toHaveBeenCalled();
        expect(commitMedia).not.toHaveBeenCalled();
      });

      it('I2-1: after a lost lease race over the catch-up of a missed playing file, a share the other device takes live leaves the file stopped when it ends', async () => {
        const { held, sync } = await startCatchUp('a manual Sync', 'preparing', 'file');
        // Another device signed in as the owner pressed first.
        vi.mocked(ProRoomApiClient.prototype.acquireSystemAudioLease).mockImplementation(
          async () => {
            throw new ProRoomApiError('SYSTEM_AUDIO_OWNER_ACTIVE', 409);
          },
        );
        systemAudioGeneration += 1;
        systemAudio = otherOwnerShareState(systemAudioGeneration, 'preparing');

        const share = pressSystemAudio();
        held.open();
        await sleep(20);
        share.select();
        await expect(share.settled).resolves.toBe(false);
        if (sync) await expect(sync).resolves.toBe(false);
        // Its share goes live, and this device listens to it.
        systemAudio = otherOwnerShareState(systemAudioGeneration, 'live');
        await refreshProSystemAudioState();
        await sleep(50);
        prepareMedia.mockClear();
        commitMedia.mockClear();
        // Its share ends: the listener restore, then the room's next heartbeat.
        systemAudioGeneration += 1;
        systemAudio = shareState(systemAudioGeneration, 'idle');
        await refreshProSystemAudioState();
        await sleep(RETRY_WINDOW_MS);
        await runRoomHeartbeat();
        await sleep(RETRY_WINDOW_MS);

        expect(prepareMedia).not.toHaveBeenCalled();
        expect(commitMedia).not.toHaveBeenCalled();
      });

      it('I2-1: after a lost lease race over the catch-up of a missed playing file, a share the other device takes live and ends while the share window is open leaves the file stopped', async () => {
        const { held, sync } = await startCatchUp('a manual Sync', 'preparing', 'file');
        vi.mocked(ProRoomApiClient.prototype.acquireSystemAudioLease).mockImplementation(
          async () => {
            throw new ProRoomApiError('SYSTEM_AUDIO_OWNER_ACTIVE', 409);
          },
        );
        systemAudioGeneration += 1;
        systemAudio = otherOwnerShareState(systemAudioGeneration, 'preparing');

        const share = pressSystemAudio();
        held.open();
        await sleep(20);
        if (sync) await expect(sync).resolves.toBe(false);
        // While this device's share window is open, the other device's share
        // goes live (this device listens to it) and ends.
        systemAudio = otherOwnerShareState(systemAudioGeneration, 'live');
        await refreshProSystemAudioState();
        await sleep(50);
        systemAudioGeneration += 1;
        systemAudio = shareState(systemAudioGeneration, 'idle');
        await refreshProSystemAudioState();
        await sleep(50);
        prepareMedia.mockClear();
        commitMedia.mockClear();
        share.cancel();
        await expect(share.settled).resolves.toBe(false);
        await sleep(RETRY_WINDOW_MS);
        await runRoomHeartbeat();
        await sleep(RETRY_WINDOW_MS);

        expect(prepareMedia).not.toHaveBeenCalled();
        expect(commitMedia).not.toHaveBeenCalled();
      });

      it('I2-1: a publication that fails after the room committed the share live over the catch-up of a missed playing file leaves the file stopped', async () => {
        const { held, sync } = await startCatchUp('a manual Sync', 'preparing', 'file');
        const publication = holdPublicationAfterLiveCommit();

        const share = pressSystemAudio();
        held.open();
        await sleep(20);
        share.select();
        await vi.waitFor(() => expect(fakes.publish).toHaveBeenCalledOnce());
        if (sync) await expect(sync).resolves.toBe(false);
        systemAudio = shareState(systemAudioGeneration, 'live');
        await refreshProSystemAudioState();
        expect(getProSystemAudioViewState()).toMatchObject({ phase: 'live', isLocalOwner: true });
        prepareMedia.mockClear();
        commitMedia.mockClear();

        // The publication fails after the room had it live: the capture
        // releases the lease and the start settles without a share.
        publication.end();
        await expect(share.settled).resolves.toBe(false);
        await sleep(RETRY_WINDOW_MS);
        await runRoomHeartbeat();
        await sleep(RETRY_WINDOW_MS);

        // The room's other devices keep the file stopped after that share.
        expect(prepareMedia).not.toHaveBeenCalled();
        expect(commitMedia).not.toHaveBeenCalled();
      });

      it('S3: a share that goes live over a catch-up that joined a server PREPARE this device prepares re-arms the video once when it ends', async () => {
        await establishCheckpoint('playing');
        const target = playback(2, {
          state: 'playing',
          positionSeconds: 0,
          updatedAtMs: Date.now(),
        });
        // The server PREPARE of revision 2 reaches this device and prepares.
        const held = gate(prepareGates);
        acceptProRoomRealtimeFrameForTests(
          serverFrame({ ...prepareEvent(TRANSITION_NEWER, target) }),
        );
        await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
        // The room commits it, and a manual Sync's heartbeat sees that before
        // this device's COMMIT frame: its catch-up joins that preparation.
        roomSnapshot = { ...snapshot(target), revision: 3 };
        const sync = requestActiveProRoomPlaybackReconciliation();
        const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
        await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
        await sleep(50);

        const share = pressSystemAudio();
        acceptProRoomRealtimeFrameForTests(
          serverFrame({ ...commitEvent(TRANSITION_NEWER, target) }),
        );
        await sleep(20);
        held.open();
        await sleep(50);
        share.select();
        await expect(share.settled).resolves.toBe(true);
        await expect(sync).resolves.toBe(false);

        await stopLiveShareThenRunHeartbeat();

        expect(prepareMedia).toHaveBeenCalledOnce();
        expect(commitMedia).toHaveBeenCalledOnce();
        expect(commitMedia.mock.calls[0]?.[0]).toMatchObject({
          committedPlaybackRevision: 2,
          queueItemId: QUEUE_ITEM_ID,
          state: 'playing',
        });
      });

      it("S3: a room heartbeat's own catch-up, still preparing at the press, goes on and the share starts", async () => {
        const { held } = await startCatchUp('the room heartbeat');

        const share = pressSystemAudio();
        // Not the press's to cancel: its load epoch came before the press, and
        // its commit starts none.
        expect.soft(cancelMedia).not.toHaveBeenCalled();
        held.open();
        await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
        share.select();

        await expect(share.settled).resolves.toBe(true);
        expect(superseded).not.toHaveBeenCalled();
        expect(commitMedia.mock.calls[0]?.[0].committedPlaybackRevision).toBe(2);
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).toHaveBeenCalledOnce();
        expect(cancelMedia).not.toHaveBeenCalled();
        expect(isSystemAudioActive()).toBe(true);
      });

      it('S3: applies the newer checkpoint once when the share window is cancelled', async () => {
        const { held } = await startCatchUp('a hide and show');

        const share = pressSystemAudio();
        held.open();
        await sleep(20);
        share.cancel();

        await expect(share.settled).resolves.toBe(false);
        // A cancelled share window says so; it was not superseded.
        expect.soft(superseded).not.toHaveBeenCalled();
        expect.soft(toasts).toContain(t('system_audio.capture_denied'));
        await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
        expect(commitMedia.mock.calls[0]?.[0]).toMatchObject({
          committedPlaybackRevision: 2,
          queueItemId: QUEUE_ITEM_ID,
          state: 'playing',
        });
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).toHaveBeenCalledTimes(2);
        expect(commitMedia).toHaveBeenCalledOnce();
        expect(getManagedTimer(VISIBILITY_RECOVERY_TIMER)).toBeNull();
      });

      it('S3: a COMMIT of a newer revision that arrives after the press still discards the capture, and nothing re-applies', async () => {
        const { held } = await startCatchUp('a hide and show');

        const share = pressSystemAudio();
        held.open();
        await sleep(20);
        // Another member picks a newer revision while the share window is open;
        // this device applies it from its COMMIT (the PREPARE never reached it).
        const newest = playback(3, {
          state: 'playing',
          positionSeconds: 0,
          updatedAtMs: Date.now(),
        });
        roomSnapshot = { ...snapshot(newest), revision: 4 };
        acceptProRoomRealtimeFrameForTests(
          serverFrame({ ...commitEvent(TRANSITION_NEWER, newest) }),
        );
        await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
        share.select();

        await expect(share.settled).resolves.toBe(false);
        expect(superseded).toHaveBeenCalledWith(
          '[SystemAudio] Capture start superseded after the share window:',
          'newer playback',
        );
        expect(isSystemAudioActive()).toBe(false);
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).toHaveBeenCalledTimes(2);
        expect(commitMedia).toHaveBeenCalledOnce();
        expect(commitMedia.mock.calls[0]?.[0].committedPlaybackRevision).toBe(3);
      });
    });

    describe('while this device shares over a playing YouTube checkpoint', () => {
      it.each([
        ['a hide and show', 'youtube'],
        ['a background-return Sync', 'file'],
        ['a manual Sync', 'youtube'],
      ] as const)(
        'D: %s (%s item) prepares nothing, keeps the share and keeps the presence heartbeat',
        async (trigger, media) => {
          await establishCheckpoint('playing', media);
          const share = pressSystemAudio();
          share.select();
          await expect(share.settled).resolves.toBe(true);
          expect(isSystemAudioActive()).toBe(true);

          if (trigger === 'a manual Sync') {
            await expect(requestActiveProRoomPlaybackReconciliation()).resolves.toBe(false);
          } else {
            setDocumentVisibility('hidden');
            setDocumentVisibility('visible');
            // A file item: the YouTube-only repair cannot cover it, and the
            // background-return Sync widens this return to every medium.
            if (trigger === 'a background-return Sync') {
              await sleep(50);
              requestProRoomBackgroundReturnSync();
            }
          }
          await sleep(RETRY_WINDOW_MS);

          expect(prepareMedia).not.toHaveBeenCalled();
          expect(isSystemAudioActive()).toBe(true);
          expect(getManagedTimer(VISIBILITY_RECOVERY_TIMER)).toBeNull();
          expect(getManagedTimer(HEARTBEAT_TIMER)).not.toBeNull();
        },
      );

      it('restores the checkpoint once when the share ends: the hold ends with the share', async () => {
        await establishCheckpoint('paused');
        const share = pressSystemAudio();
        share.select();
        await expect(share.settled).resolves.toBe(true);
        // A hide and show during the share is held and owes nothing.
        setDocumentVisibility('hidden');
        setDocumentVisibility('visible');
        // The room's live answer reaches the service.
        await refreshProSystemAudioState();

        bus.emit('system-audio:stop');

        expect(isSystemAudioActive()).toBe(false);
        await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
        expect(prepareMedia).toHaveBeenCalledOnce();
        expect(commitMedia.mock.calls[0]?.[0]).toMatchObject({
          committedPlaybackRevision: 1,
          state: 'paused',
          positionSeconds: 37.5,
        });
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).toHaveBeenCalledOnce();
        expect(commitMedia).toHaveBeenCalledOnce();
      });
    });

    describe('when the start settles without a share', () => {
      it('re-applies the paused checkpoint the press replaced, once, after the share window is cancelled', async () => {
        await establishCheckpoint('paused');
        const restore = gate(prepareGates);
        await endEarlierLocalShare();
        await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());

        const share = pressSystemAudio();
        restore.open();
        await sleep(20);
        share.cancel();

        await expect(share.settled).resolves.toBe(false);
        // A cancelled share window says so; it was not superseded.
        expect.soft(superseded).not.toHaveBeenCalled();
        expect.soft(toasts).toContain(t('system_audio.capture_denied'));
        await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
        expect(prepareMedia).toHaveBeenCalledTimes(2);
        expect(commitMedia.mock.calls[0]?.[0]).toMatchObject({
          committedPlaybackRevision: 1,
          queueItemId: QUEUE_ITEM_ID,
          state: 'paused',
          positionSeconds: 37.5,
        });
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).toHaveBeenCalledTimes(2);
        expect(commitMedia).toHaveBeenCalledOnce();
      });

      it('re-applies once the playing checkpoint a foreground repair stopped by the press was for', async () => {
        await establishCheckpoint('playing');
        const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
        const repairHeartbeat = gate(heartbeatGates);
        setDocumentVisibility('hidden');
        setDocumentVisibility('visible');
        await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());

        const share = pressSystemAudio();
        repairHeartbeat.open();
        await sleep(50);
        share.cancel();

        await expect(share.settled).resolves.toBe(false);
        await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
        expect(prepareMedia).toHaveBeenCalledOnce();
        expect(commitMedia.mock.calls[0]?.[0]).toMatchObject({
          committedPlaybackRevision: 1,
          state: 'playing',
        });
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).toHaveBeenCalledOnce();
        expect(commitMedia).toHaveBeenCalledOnce();
        expect(getManagedTimer(VISIBILITY_RECOVERY_TIMER)).toBeNull();
      });

      /**
       * Another device signed in as the owner pressed first: the room answers
       * this device's lease request with that device's preparing lease, which
       * this device's view has not heard of before the press.
       */
      function loseLeaseRace(): void {
        vi.mocked(ProRoomApiClient.prototype.acquireSystemAudioLease).mockImplementation(
          async () => {
            throw new ProRoomApiError('SYSTEM_AUDIO_OWNER_ACTIVE', 409);
          },
        );
        systemAudioGeneration += 1;
        systemAudio = otherOwnerShareState(systemAudioGeneration, 'preparing');
      }

      /** A press during the playing room's foreground rendezvous loses the lease race. */
      async function pressDuringRendezvousAndLoseLeaseRace(): Promise<void> {
        await establishCheckpoint('playing');
        const repair = gate(prepareGates);
        setDocumentVisibility('hidden');
        setDocumentVisibility('visible');
        await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
        loseLeaseRace();

        const share = pressSystemAudio();
        expect.soft(cancelMedia).toHaveBeenCalledOnce();
        repair.open();
        await sleep(20);
        share.select();

        await expect(share.settled).resolves.toBe(false);
        expect(toasts).toContain(t('system_audio.owner_preparing', { name: OTHER_PARTICIPANT_ID }));
        // Nothing re-applies while the other device's share prepares.
        await sleep(RETRY_WINDOW_MS);
        expect(commitMedia).not.toHaveBeenCalled();
      }

      it('I1: after a lost lease race, re-applies the playing checkpoint the press stopped once the other share ends without going live', async () => {
        await pressDuringRendezvousAndLoseLeaseRace();

        // The other device closes its share window: the room's share view
        // turns idle without a share going live.
        systemAudioGeneration += 1;
        systemAudio = shareState(systemAudioGeneration, 'idle');
        await refreshProSystemAudioState();

        await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
        expect(commitMedia.mock.calls[0]?.[0]).toMatchObject({
          committedPlaybackRevision: 1,
          queueItemId: QUEUE_ITEM_ID,
          state: 'playing',
        });
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).toHaveBeenCalledTimes(2);
        expect(commitMedia).toHaveBeenCalledOnce();
        expect(getManagedTimer(VISIBILITY_RECOVERY_TIMER)).toBeNull();
      });

      it('I1: after a lost lease race, a share that goes live leaves the re-apply to its end, once', async () => {
        await pressDuringRendezvousAndLoseLeaseRace();

        systemAudio = otherOwnerShareState(systemAudioGeneration, 'live');
        await refreshProSystemAudioState();
        await sleep(50);
        expect(commitMedia).not.toHaveBeenCalled();
        // The share ends: this device, a listener of it, restores the checkpoint.
        systemAudioGeneration += 1;
        systemAudio = shareState(systemAudioGeneration, 'idle');
        await refreshProSystemAudioState();

        await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
        expect(commitMedia.mock.calls[0]?.[0]).toMatchObject({
          committedPlaybackRevision: 1,
          state: 'playing',
        });
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).toHaveBeenCalledTimes(2);
        expect(commitMedia).toHaveBeenCalledOnce();
      });

      it.each(['paused', 'playing'] as const)(
        'I1: Stop while the share still prepares, after the press took over the %s post-share restore, re-applies it once the room answers the release',
        async (state) => {
          await establishCheckpoint(state);
          const restore = gate(prepareGates);
          await endEarlierLocalShare();
          await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
          // The publication waits (as for the LAN-direct proofs) and the release
          // answers one round trip after the Stop.
          let endPublication!: () => void;
          fakes.publish.mockImplementation(
            () =>
              new Promise<ProRoomSystemAudioState>((_resolve, reject) => {
                endPublication = () => reject(new Error('PRO_SYSTEM_AUDIO_LEASE_UNAVAILABLE'));
              }),
          );
          let answerRelease!: () => void;
          const releaseAnswered = new Promise<void>((resolve) => {
            answerRelease = resolve;
          });
          vi.mocked(ProRoomApiClient.prototype.releaseSystemAudioLease).mockImplementation(
            async () => {
              await releaseAnswered;
              systemAudioGeneration += 1;
              systemAudio = shareState(systemAudioGeneration, 'idle');
              return systemAudio;
            },
          );

          const share = pressSystemAudio();
          expect.soft(cancelMedia).toHaveBeenCalledOnce();
          restore.open();
          await sleep(20);
          share.select();
          await vi.waitFor(() => expect(fakes.publish).toHaveBeenCalledOnce());
          expect(getState('playback.mode')).toBe('system-audio');
          prepareMedia.mockClear();
          commitMedia.mockClear();

          bus.emit('system-audio:stop');
          expect(isSystemAudioActive()).toBe(false);
          expect(toasts).toContain(t('system_audio.stopped'));
          // The room still holds this device's lease until the release answers.
          await sleep(RETRY_WINDOW_MS);
          expect(commitMedia).not.toHaveBeenCalled();
          answerRelease();

          await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
          expect(commitMedia.mock.calls[0]?.[0]).toMatchObject({
            committedPlaybackRevision: 1,
            queueItemId: QUEUE_ITEM_ID,
            state,
          });
          if (state === 'paused') {
            expect(commitMedia.mock.calls[0]?.[0].positionSeconds).toBe(37.5);
          }
          endPublication();
          await expect(share.settled).resolves.toBe(false);
          await sleep(RETRY_WINDOW_MS);
          expect(prepareMedia).toHaveBeenCalledOnce();
          expect(commitMedia).toHaveBeenCalledOnce();
        },
      );

      it.each(['paused', 'playing'] as const)(
        'I2-2: Stop after the room committed the share live, before the start settled, after the press took over the %s post-share restore, re-applies it once',
        async (state) => {
          await establishCheckpoint(state);
          const restore = gate(prepareGates);
          await endEarlierLocalShare();
          await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
          const publication = holdPublicationAfterLiveCommit();

          const share = pressSystemAudio();
          expect.soft(cancelMedia).toHaveBeenCalledOnce();
          restore.open();
          await sleep(20);
          share.select();
          await vi.waitFor(() => expect(fakes.publish).toHaveBeenCalledOnce());
          // The room's commit turned the share live and this device's own;
          // Stop is available, since this device plays system audio.
          systemAudio = shareState(systemAudioGeneration, 'live');
          await refreshProSystemAudioState();
          expect(getProSystemAudioViewState()).toMatchObject({
            phase: 'live',
            isLocalOwner: true,
          });
          expect(getState('playback.mode')).toBe('system-audio');
          prepareMedia.mockClear();
          commitMedia.mockClear();

          bus.emit('system-audio:stop');
          expect(isSystemAudioActive()).toBe(false);
          await vi.waitFor(() => expect(commitMedia).toHaveBeenCalled());
          await sleep(RETRY_WINDOW_MS);
          publication.end();
          await expect(share.settled).resolves.toBe(false);
          await sleep(RETRY_WINDOW_MS);

          // One re-arm when the room answers the release, not one from the
          // start that did not settle live and another from the post-share
          // restore of the share the room had live.
          expect(prepareMedia).toHaveBeenCalledOnce();
          expect(commitMedia).toHaveBeenCalledOnce();
          expect(commitMedia.mock.calls[0]?.[0]).toMatchObject({
            committedPlaybackRevision: 1,
            queueItemId: QUEUE_ITEM_ID,
            state,
          });
          if (state === 'paused') {
            expect(commitMedia.mock.calls[0]?.[0].positionSeconds).toBe(37.5);
          }
        },
      );

      it('a publication that fails after the room committed the share live, after the press took over the playing post-share restore, re-arms the video once', async () => {
        await establishCheckpoint('playing');
        const restore = gate(prepareGates);
        await endEarlierLocalShare();
        await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
        const publication = holdPublicationAfterLiveCommit();

        const share = pressSystemAudio();
        restore.open();
        await sleep(20);
        share.select();
        await vi.waitFor(() => expect(fakes.publish).toHaveBeenCalledOnce());
        systemAudio = shareState(systemAudioGeneration, 'live');
        await refreshProSystemAudioState();
        prepareMedia.mockClear();
        commitMedia.mockClear();

        // No Stop schedules the post-share restore here: the start that did not
        // settle live re-applies what it owes once the room answers the release.
        publication.end();
        await expect(share.settled).resolves.toBe(false);
        await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
        expect(commitMedia.mock.calls[0]?.[0]).toMatchObject({
          committedPlaybackRevision: 1,
          queueItemId: QUEUE_ITEM_ID,
          state: 'playing',
        });
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).toHaveBeenCalledOnce();
        expect(commitMedia).toHaveBeenCalledOnce();
      });

      it('re-applies nothing after a newer server choice made after the press, which still discards the capture', async () => {
        await establishCheckpoint('paused');
        const restore = gate(prepareGates);
        await endEarlierLocalShare();
        await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());

        const share = pressSystemAudio();
        restore.open();
        // Another member starts a new revision while the share window is open.
        const newer = playback(2, {
          state: 'playing',
          positionSeconds: 0,
          updatedAtMs: Date.now(),
        });
        roomSnapshot = { ...snapshot(newer), revision: 3 };
        acceptProRoomRealtimeFrameForTests(
          serverFrame({ ...prepareEvent(TRANSITION_NEWER, newer) }),
        );
        await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledTimes(2));
        acceptProRoomRealtimeFrameForTests(
          serverFrame({ ...commitEvent(TRANSITION_NEWER, newer) }),
        );
        await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
        share.select();

        await expect(share.settled).resolves.toBe(false);
        expect(superseded).toHaveBeenCalledWith(
          '[SystemAudio] Capture start superseded after the share window:',
          'newer playback',
        );
        expect(isSystemAudioActive()).toBe(false);
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).toHaveBeenCalledTimes(2);
        expect(commitMedia).toHaveBeenCalledOnce();
        expect(commitMedia.mock.calls[0]?.[0].committedPlaybackRevision).toBe(2);
      });

      it('teardown: a room left while the start is pending re-applies nothing when it settles', async () => {
        await establishCheckpoint('paused');
        const restore = gate(prepareGates);
        await endEarlierLocalShare();
        await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());

        const share = pressSystemAudio();
        restore.open();
        requestProRoomLeave();
        await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
        share.cancel();

        await expect(share.settled).resolves.toBe(false);
        await sleep(RETRY_WINDOW_MS);
        expect(prepareMedia).toHaveBeenCalledOnce();
        expect(commitMedia).not.toHaveBeenCalled();
      });
    });
  },
);
