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
 * included).
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
import { refreshProSystemAudioState } from '../system-audio-service.ts';
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
}));

const ROOM_CODE = '000001';
const ROOM_EPOCH = 7;
const PARTICIPANT_ID = 'participant_00001';
const QUEUE_ITEM_ID = '43000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'dQw4w9WgXcQ';
const TRANSITION_NEWER = `transition_${'n'.repeat(22)}`;
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
      commitMedia = vi.fn<ProPlaybackMediaEndpoint['commit']>(async (request) => ({
        status: 'applied' as const,
        authority: request.authority,
      }));
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

      it('C: with a shared tab, the foreground repair queued behind the post-share restore prepares nothing after the press', async () => {
        await establishCheckpoint('playing');
        // The restore's preparation stalls like an iframe in a hidden tab.
        const restore = gate(prepareGates);
        await endEarlierLocalShare(true);
        await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
        // Back on the page: the foreground repair queues behind the restore.
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
