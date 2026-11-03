/**
 * @vitest-environment jsdom
 *
 * Pins of a late PRO participant's YouTube stack (investigation of 2026-10-30
 * on 9.0.24), end to end: the real playback controller, the real playlist
 * media endpoint (initPlaylist), the real iframe module behind a scripted
 * IFrame API, and a calibrated server clock. When this device misses the
 * server's READY barrier, the COMMIT sends it down the catch-up path; these
 * rows count what that path does to the iframe and the toasts. They describe
 * current behaviour, including parts that look like defects. The first four
 * (a) rows, of a device that held no iframe, describe the catch-up as Phase 6
 * 6D-6 changed it (owner decision Q22 (a)): it keeps that device's
 * still-loading load instead of loading the occurrence again, also when the
 * committed checkpoint reaches the device in a snapshot rather than the COMMIT
 * frame. It keeps that load only up to the join the catch-up plans: a first
 * iframe that has still not finished its handshake there is loaded again, as
 * the COMMIT loaded it before 6D-6. The rows after the first four pin that
 * deadline's sides (the snapshot route, the IFrame API script, a handshake
 * just before it) and one residual it does not cover: a snapshot 12 to 15 s
 * after PREPARE plans its join past the first load's own 15 s deadline, which
 * ends that load first.
 *
 * The platform is the App's own detection: core/platform.ts with IS_ANDROID
 * switchable per row (as in pro-manual-zero-start.test.ts). player.ts and the
 * iframe arm read it on every call, so the Android rows run the App's real
 * 250 ms output-lead path.
 *
 * Timing: the Worker's barrier and COMMIT lead come from the copy that
 * pro-room-playback-timing.test.ts pins to cloudflare/pro-room-playback-timing.ts
 * (this suite must not load Worker code, see ci-quality-gates.test.ts); the
 * App's own late-join lead comes from
 * pro-room/__tests__/__helpers__/pro-late-youtube-join-timing.ts, which names
 * the row that pins it, and the arm's release acknowledgement and the iframe
 * load deadline from their home, src/youtube/constants.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import {
  getProStartObservations,
  resetProStartObservations,
} from '../../diagnostics/pro-start-observations.ts';
import { t } from '../../i18n/index.ts';
import { setPlaybackYouTubePaused } from '../../player/ownership.ts';
import { initPlayback } from '../../player/playback.ts';
import { initPlaylist } from '../../player/playlist.ts';
import type {
  ProRoomPlaybackCommitEvent,
  ProRoomPlaybackPrepareEvent,
} from '../../pro-room/api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomPlaybackCheckpoint,
  type ProRoomSnapshot,
} from '../../pro-room/contracts.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';
import { ProRoomPlaybackController } from '../../pro-room/playback-controller.ts';
import { LATE_YOUTUBE_COMMIT_LEAD_MS as LATE_JOIN_LEAD_MS } from '../../pro-room/__tests__/__helpers__/pro-late-youtube-join-timing.ts';
import {
  PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS as COMMIT_LEAD_MS,
  PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS as BARRIER_MS,
} from '../../pro-room/__tests__/__helpers__/pro-room-playback-timing-copy.ts';
import { proSnapshot } from '../../pro-room/__tests__/__helpers__/pro-snapshot.ts';
import type { QueueItemId } from '../../types/index.ts';
import { showToast } from '../../ui/toast.ts';
import {
  ANDROID_YOUTUBE_PLAY_LATENCY_FLOOR_MS,
  SCRIPT_LOAD_TIMEOUT_MS,
  YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS,
} from '../constants.ts';
import { cancelYouTubeAuthorityPreparation } from '../iframe.ts';
import { initYouTube } from '../player.ts';
import { getYouTubePlayer, isYtLoadInProgress, resetYouTubeModuleState } from '../_state.ts';
import { makeFakeYtPlayer, type FakeYtPlayer } from './__helpers__/fake-yt-player.ts';

const platformUnderTest = vi.hoisted(() => ({ android: false }));
vi.mock('../../core/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/platform.ts')>()),
  get IS_ANDROID() {
    return platformUnderTest.android;
  },
}));
vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
}));
vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
}));
// A calibrated server clock that reads this device's own time.
vi.mock('../../pro-room/network-bridge.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../pro-room/network-bridge.ts')>();
  const snapshot = () => ({
    generation: 1,
    sampleId: 1,
    offsetMs: 0,
    rttMs: 10,
    sampledAtMs: performance.now(),
    roundId: 1,
    source: 'ready' as const,
  });
  return {
    ...actual,
    getProRoomServerNow: () => Date.now(),
    isProRoomServerClockCalibrated: () => true,
    captureProRoomServerClockSnapshot: () => snapshot(),
    isProRoomClockSnapshotCurrent: () => true,
    acquireProRoomServerClock: async (options: {
      serverDeadlineAtMs?: number;
      signal?: AbortSignal;
    }) =>
      !options.signal?.aborted && Date.now() <= (options.serverDeadlineAtMs ?? Infinity)
        ? snapshot()
        : null,
  };
});

const ROOM_CODE = '000001';
const ROOM_EPOCH = 6;
const QUEUE_ITEM_ID = '60000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'dQw4w9WgXcQ';
const TRANSITION_ID = `transition_${'y'.repeat(22)}`;
/**
 * How far a late join's instant is past executeAt, and so how far the room
 * timeline has run there: one late-join lead after the COMMIT, which is one
 * COMMIT lead before executeAt (today 3.0 - 0.7 = 2.3 s).
 */
const LATE_JOIN_ROOM_ADVANCE_SECONDS = (LATE_JOIN_LEAD_MS - COMMIT_LEAD_MS) / 1_000;
/** The arm's release acknowledgement, read from its home. */
const RELEASE_ACK_TIMEOUT_MS = YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS;
/**
 * The PREPARE's wait for READY: past the App's 2.3 s barriered budget (READY
 * fails at the iframe seam's first 40 ms poll after it, 2.32 s), before the
 * Worker's 3 s barrier.
 */
const PAST_PREPARE_BUDGET_MS = 2_400;

/** The player API a real IFrame API player gains only when its iframe handshake completes. */
const IFRAME_API_METHODS = [
  'playVideo',
  'pauseVideo',
  'stopVideo',
  'seekTo',
  'cueVideoById',
  'loadVideoById',
  'nextVideo',
  'previousVideo',
  'setVolume',
  'mute',
  'unMute',
  'isMuted',
  'getPlayerState',
  'getCurrentTime',
  'getDuration',
  'getVideoData',
  'getPlaylistIndex',
  'getPlaylist',
  'getVolume',
  'getVideoLoadedFraction',
] as const;

interface ScriptedIframe {
  readonly fake: FakeYtPlayer;
  /** Completes the iframe handshake: the API appears and onReady fires. */
  ready(): void;
}

function installIframeApi() {
  const iframes: ScriptedIframe[] = [];
  const Player = vi.fn(function (
    _element: string,
    options: {
      videoId?: string;
      events: {
        onReady: (event: { target: unknown }) => void;
        onStateChange: (event: { data: number; target: unknown }) => void;
      };
    },
  ) {
    const fake = makeFakeYtPlayer({
      __videoId: options.videoId ?? '',
      __state: 5,
      __duration: 240,
      __advanceClock: true,
    });
    const api = Object.fromEntries(IFRAME_API_METHODS.map((name) => [name, fake[name]]));
    for (const name of IFRAME_API_METHODS) Reflect.deleteProperty(fake, name);
    fake.__onStateChange = options.events.onStateChange;
    iframes.push({
      fake,
      ready: () => {
        Object.assign(fake, api);
        options.events.onReady({ target: fake });
      },
    });
    return fake;
  });
  vi.stubGlobal('YT', {
    Player,
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  });
  return { iframes, Player };
}

/** This device already shows the video, ready and paused at positionSeconds. */
async function residentIframe(iframes: ScriptedIframe[], positionSeconds: number) {
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  bus.emit('youtube:load', VIDEO_ID, null, QUEUE_ITEM_ID, false, 0);
  const iframe = iframes.at(-1)!;
  iframe.ready();
  iframe.fake.__currentTime = positionSeconds;
  iframe.fake.__setState(2, false);
  setPlaybackYouTubePaused();
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(showToast).mockClear();
  return iframe.fake;
}

function checkpoint(
  revision: number,
  positionSeconds: number,
  updatedAtMs: number,
): ProRoomPlaybackCheckpoint {
  return {
    coordinatorEpoch: ROOM_EPOCH,
    revision,
    state: 'playing',
    queueItemId: QUEUE_ITEM_ID,
    positionSeconds,
    youtubeVideoId: VIDEO_ID,
    youtubeSubIndex: 0,
    updatedAtMs,
  };
}

function prepareEvent(
  basePlaybackRevision: number,
  positionSeconds: number,
  timingMode: 'zero-start' | 'scheduled-control',
): ProRoomPlaybackPrepareEvent {
  const serverTimeMs = Date.now();
  return {
    type: 'pro-playback-prepare',
    transitionId: TRANSITION_ID,
    serverTimeMs,
    deadlineAtMs: serverTimeMs + BARRIER_MS,
    basePlaybackRevision,
    target: checkpoint(basePlaybackRevision + 1, positionSeconds, serverTimeMs),
    timingMode,
  };
}

function commitEvent(
  revision: number,
  positionSeconds: number,
  timingMode: 'zero-start' | 'scheduled-control',
): ProRoomPlaybackCommitEvent {
  const serverTimeMs = Date.now();
  const executeAtMs = serverTimeMs + COMMIT_LEAD_MS;
  return {
    type: 'pro-playback-commit',
    transitionId: TRANSITION_ID,
    serverTimeMs,
    executeAtMs,
    playback: checkpoint(revision, positionSeconds, executeAtMs),
    timingMode,
  };
}

/** The room's snapshot: idle, or carrying the given checkpoint. */
function snapshot(playback?: ProRoomPlaybackCheckpoint): ProRoomSnapshot {
  return proSnapshot({
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 1,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [
      {
        queueItemId: QUEUE_ITEM_ID,
        name: 'Late video',
        source: { kind: 'youtube', videoId: VIDEO_ID },
      },
    ],
    currentQueueItemId: playback?.queueItemId ?? null,
    playback: playback ?? {
      coordinatorEpoch: ROOM_EPOCH,
      revision: 0,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: 1,
    },
    presence: { coordinatorEpoch: ROOM_EPOCH, revision: 1, participants: [] },
    quota: {
      limitBytes: PRO_ROOM_QUOTA_BYTES,
      perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
      usedBytes: 0,
      reservedBytes: 0,
    },
    viewer: null,
    administrators: [],
  });
}

const controllers: ProRoomPlaybackController[] = [];

function createParticipant() {
  const current = snapshot();
  const reportReady = vi.fn().mockResolvedValue('waiting');
  const controller = new ProRoomPlaybackController({
    isActive: () => true,
    getCanonicalSnapshot: () => current,
    getPlaylistSnapshot: () => current,
    capturePlaylistLease: () => ({ generation: 1, roomCode: ROOM_CODE }),
    isPlaylistLeaseCurrent: () => true,
    getRoomAbortSignal: () => undefined,
    subscribePlaylistProjection: () => () => undefined,
    runHeartbeat: vi.fn().mockResolvedValue(undefined),
    reportPlaybackTransitionReady: reportReady,
    executePlaybackCommand: vi.fn(),
    recoverTerminalSession: vi.fn().mockResolvedValue(undefined),
  });
  controllers.push(controller);
  return { controller, reportReady };
}

function effectsToasts(): number {
  return vi
    .mocked(showToast)
    .mock.calls.filter(([message]) => message === t('youtube.effects_disabled')).length;
}

function loadTimeoutToasts(): number {
  return vi
    .mocked(showToast)
    .mock.calls.filter(([message]) => message === t('youtube.load_timeout')).length;
}

function plays(fake: FakeYtPlayer): number[] {
  return fake.__log.filter((call) => call.op === 'playVideo').map((call) => call.at);
}

beforeEach(() => {
  platformUnderTest.android = false;
  vi.useFakeTimers();
  vi.setSystemTime(2_000_000);
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  resetYouTubeModuleState();
  resetProPlaybackAuthorityHooks();
  resetProStartObservations();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ title: 'Late video' })),
  );
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
  initPlayback();
  initYouTube();
  initPlaylist();
  setState('room.context', {
    kind: 'pro',
    roomId: ROOM_CODE,
    role: 'member',
    coordinatorId: null,
    epoch: ROOM_EPOCH,
    snapshotRevision: 1,
    capabilities: [],
  });
  setState('setup.sessionStarted', true);
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Late video',
      videoId: VIDEO_ID,
      playlistId: null,
    },
  ]);
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.resetPlaylistRuntime();
  resetProPlaybackAuthorityHooks();
  registerProPlaybackMediaEndpoint(null);
  cancelYouTubeAuthorityPreparation();
  bus.emit('youtube:stop-mode', { silent: true });
  clearAllManagedTimers();
  resetYouTubeModuleState();
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  bus.clear();
  resetState();
  document.body.innerHTML = '';
  document
    .querySelectorAll('script[src*="youtube.com/iframe_api"]')
    .forEach((script) => script.remove());
  delete window.onYouTubeIframeAPIReady;
});

describe('PRO late YouTube cohort join on the device (pinned 2026-10-30)', () => {
  // (a) Scenario: this device holds no iframe when PREPARE arrives. The
  // iframe it builds has not finished its handshake (onReady) when the 2.3 s
  // barriered budget ends, so READY fails and the Worker commits without it.
  it('(a) keeps the still-loading iframe, its one youtube:load and one effects toast at the COMMIT catch-up', async () => {
    const { iframes, Player } = installIframeApi();
    const loads = vi.fn();
    bus.on('youtube:load', loads);
    const { controller, reportReady } = createParticipant();

    controller.acceptPrepare(prepareEvent(0, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();
    expect(isYtLoadInProgress()).toBe(true);

    await vi.advanceTimersByTimeAsync(PAST_PREPARE_BUDGET_MS);
    expect(reportReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ transitionId: TRANSITION_ID, status: 'failed' }),
    );
    expect(isYtLoadInProgress()).toBe(true);

    const receivedAt = Date.now();
    controller.acceptCommit(commitEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(0);

    // The catch-up waits for the PREPARE's own load of the occurrence: no
    // second youtube:load or toast, and the iframe still loading is neither
    // destroyed nor replaced, so its handshake does not start over.
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();
    expect(iframes[0]!.fake.__log.map(({ op }) => op)).not.toContain('destroy');
    expect(getYouTubePlayer()).toBe(iframes[0]!.fake);

    // That iframe is ready 500 ms later; the device joins at its plan, 3 s
    // after COMMIT receipt, at the room position there (3.0 - 0.7 s).
    await vi.advanceTimersByTimeAsync(500);
    iframes[0]!.ready();
    await vi.advanceTimersByTimeAsync(LATE_JOIN_LEAD_MS - 500);
    const joined = iframes[0]!.fake;
    expect(plays(joined).at(-1)).toBe(receivedAt + LATE_JOIN_LEAD_MS);
    expect(joined.__state).toBe(1);
    expect(joined.getCurrentTime()).toBeCloseTo(LATE_JOIN_ROOM_ADVANCE_SECONDS, 6);
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();
    expect(iframes[0]!.fake.__log.map(({ op }) => op)).not.toContain('destroy');
  });

  // (a) Scenario variant: the IFrame API script itself is still loading when
  // the budget ends. The catch-up waits behind the same script request with
  // the PREPARE's load: one youtube:load and one toast.
  it('(a) waits for the IFrame API script without a second youtube:load or effects toast', async () => {
    const loads = vi.fn();
    bus.on('youtube:load', loads);
    const { controller, reportReady } = createParticipant();

    controller.acceptPrepare(prepareEvent(0, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);
    expect(getYouTubePlayer()).toBeNull();

    await vi.advanceTimersByTimeAsync(PAST_PREPARE_BUDGET_MS);
    expect(reportReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ transitionId: TRANSITION_ID, status: 'failed' }),
    );

    const receivedAt = Date.now();
    controller.acceptCommit(commitEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);

    // The script arrives 500 ms later and builds one iframe, for that load.
    await vi.advanceTimersByTimeAsync(500);
    const scripts = document.querySelectorAll<HTMLScriptElement>(
      'script[src*="youtube.com/iframe_api"]',
    );
    expect(scripts).toHaveLength(1);
    const { iframes, Player } = installIframeApi();
    scripts[0]!.dispatchEvent(new Event('load'));
    expect(Player).toHaveBeenCalledOnce();
    iframes[0]!.ready();
    await vi.advanceTimersByTimeAsync(LATE_JOIN_LEAD_MS - 500);
    expect(plays(iframes[0]!.fake).at(-1)).toBe(receivedAt + LATE_JOIN_LEAD_MS);
    expect(iframes[0]!.fake.getCurrentTime()).toBeCloseTo(LATE_JOIN_ROOM_ADVANCE_SECONDS, 6);
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();
  });

  // (a) Scenario variant: this device never gets the COMMIT frame (for
  // example it reconnects), and the next snapshot carries the checkpoint the
  // Worker committed. That is the checkpoint this device prepared, so the
  // snapshot commits as that transition's COMMIT, and its catch-up keeps the
  // same still-loading load.
  it('(a) keeps the still-loading iframe when the committed checkpoint arrives in a snapshot instead of the COMMIT frame', async () => {
    const { iframes, Player } = installIframeApi();
    const loads = vi.fn();
    bus.on('youtube:load', loads);
    const { controller, reportReady } = createParticipant();

    controller.acceptPrepare(prepareEvent(0, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(PAST_PREPARE_BUDGET_MS);
    expect(reportReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ transitionId: TRANSITION_ID, status: 'failed' }),
    );
    expect(isYtLoadInProgress()).toBe(true);

    // The Worker commits revision 1 at 0:00, executeAt one COMMIT lead from now.
    const receivedAt = Date.now();
    const restore = controller.restorePersistedPlayback(
      snapshot(checkpoint(1, 0, receivedAt + COMMIT_LEAD_MS)),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();
    expect(iframes[0]!.fake.__log.map(({ op }) => op)).not.toContain('destroy');
    expect(getYouTubePlayer()).toBe(iframes[0]!.fake);

    // As with the frame: ready 500 ms later, the join 3 s after the snapshot's
    // receipt, at the room position there (3.0 - 0.7 s).
    await vi.advanceTimersByTimeAsync(500);
    iframes[0]!.ready();
    await vi.advanceTimersByTimeAsync(LATE_JOIN_LEAD_MS - 500);
    const joined = iframes[0]!.fake;
    expect(plays(joined).at(-1)).toBe(receivedAt + LATE_JOIN_LEAD_MS);
    expect(joined.__state).toBe(1);
    expect(joined.getCurrentTime()).toBeCloseTo(LATE_JOIN_ROOM_ADVANCE_SECONDS, 6);
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();
    await restore;
  });

  // (a) Scenario variant: the first iframe never finishes its handshake. The
  // COMMIT catch-up keeps it only until the start its plan sets, 3 s after
  // COMMIT receipt. Still handshaking there, the catch-up loads the occurrence
  // again as it did at the COMMIT before 6D-6: a second youtube:load and
  // effects toast, the unready iframe destroyed and a new one built. The
  // device joins once that iframe is ready, at the room position then, and the
  // first load's 15 s deadline no longer ends anything.
  it('(a) loads the occurrence again, as before 6D-6, when its first iframe is still handshaking at the planned join', async () => {
    const { iframes, Player } = installIframeApi();
    const loads = vi.fn();
    const loadedAt: number[] = [];
    bus.on('youtube:load', loads);
    bus.on('youtube:load', () => loadedAt.push(Date.now()));
    const { controller, reportReady } = createParticipant();

    controller.acceptPrepare(prepareEvent(0, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(PAST_PREPARE_BUDGET_MS);
    expect(reportReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ transitionId: TRANSITION_ID, status: 'failed' }),
    );
    const receivedAt = Date.now();
    controller.acceptCommit(commitEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(0);
    expect(loadedAt).toHaveLength(1);
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();

    // Kept up to the planned join, 3 s after COMMIT receipt.
    const plannedJoin = receivedAt + LATE_JOIN_LEAD_MS;
    await vi.advanceTimersByTimeAsync(plannedJoin - 1 - Date.now());
    expect(loadedAt).toHaveLength(1);
    expect(Player).toHaveBeenCalledOnce();
    expect(iframes[0]!.fake.__log).toEqual([]);

    // Still handshaking at the planned join: loaded again there, as the COMMIT
    // did before 6D-6, and the unready iframe is replaced. (The prepare seam
    // polls every 40 ms from the catch-up's start; 3 s is a whole number of
    // polls, so here and in the rows below the reload lands on the planned
    // join itself.)
    await vi.advanceTimersByTimeAsync(1);
    expect(loadedAt).toEqual([loadedAt[0], plannedJoin]);
    expect(loads.mock.calls[1]).toEqual([VIDEO_ID, null, QUEUE_ITEM_ID, false, 0]);
    expect(effectsToasts()).toBe(2);
    expect(Player).toHaveBeenCalledTimes(2);
    expect(iframes[0]!.fake.__log).toEqual([{ op: 'destroy', at: plannedJoin }]);
    expect(getYouTubePlayer()).toBe(iframes[1]!.fake);

    // The new iframe is ready 500 ms later. The plan has passed, so the device
    // joins as soon as that iframe is armed, at the room position then.
    await vi.advanceTimersByTimeAsync(500);
    const readyAt = Date.now();
    iframes[1]!.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    const joined = iframes[1]!.fake;
    expect(plays(joined).at(-1)).toBeGreaterThan(readyAt);
    expect(joined.__state).toBe(1);
    expect(joined.getCurrentTime()).toBeCloseTo(
      (Date.now() - receivedAt - COMMIT_LEAD_MS) / 1_000,
      2,
    );

    // Neither load's deadline ends anything: no load-timeout toast.
    await vi.advanceTimersByTimeAsync(loadedAt[1]! + SCRIPT_LOAD_TIMEOUT_MS - Date.now());
    expect(loadTimeoutToasts()).toBe(0);
    expect(joined.__state).toBe(1);
    expect(getState('playback.mode')).toBe('youtube');
    expect(loadedAt).toHaveLength(2);
    expect(effectsToasts()).toBe(2);
    expect(Player).toHaveBeenCalledTimes(2);
  });

  // (a) Scenario variant: as above, but the committed checkpoint reaches this
  // device in a snapshot. The planned join, and so the kept load's deadline,
  // counts from the snapshot's receipt.
  it('(a) loads the occurrence again at the join a snapshot plans when its first iframe is still handshaking there', async () => {
    const { iframes, Player } = installIframeApi();
    const loadedAt: number[] = [];
    bus.on('youtube:load', () => loadedAt.push(Date.now()));
    const { controller, reportReady } = createParticipant();

    controller.acceptPrepare(prepareEvent(0, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(PAST_PREPARE_BUDGET_MS);
    expect(reportReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ transitionId: TRANSITION_ID, status: 'failed' }),
    );
    const receivedAt = Date.now();
    const restore = controller.restorePersistedPlayback(
      snapshot(checkpoint(1, 0, receivedAt + COMMIT_LEAD_MS)),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(loadedAt).toHaveLength(1);
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();

    // Kept up to the planned join, 3 s after the snapshot's receipt, and
    // loaded again there into a new iframe.
    const plannedJoin = receivedAt + LATE_JOIN_LEAD_MS;
    await vi.advanceTimersByTimeAsync(plannedJoin - 1 - Date.now());
    expect(loadedAt).toHaveLength(1);
    expect(iframes[0]!.fake.__log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(loadedAt).toEqual([loadedAt[0], plannedJoin]);
    expect(effectsToasts()).toBe(2);
    expect(Player).toHaveBeenCalledTimes(2);
    expect(iframes[0]!.fake.__log).toEqual([{ op: 'destroy', at: plannedJoin }]);
    expect(getYouTubePlayer()).toBe(iframes[1]!.fake);

    // The new iframe is ready 500 ms later; the device joins once it is armed,
    // at the room position then, and no load deadline ends anything.
    await vi.advanceTimersByTimeAsync(500);
    const readyAt = Date.now();
    iframes[1]!.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    const joined = iframes[1]!.fake;
    expect(plays(joined).at(-1)).toBeGreaterThan(readyAt);
    expect(joined.__state).toBe(1);
    expect(joined.getCurrentTime()).toBeCloseTo(
      (Date.now() - receivedAt - COMMIT_LEAD_MS) / 1_000,
      2,
    );
    await vi.advanceTimersByTimeAsync(loadedAt[1]! + SCRIPT_LOAD_TIMEOUT_MS - Date.now());
    expect(loadTimeoutToasts()).toBe(0);
    expect(getState('playback.mode')).toBe('youtube');
    expect(loadedAt).toHaveLength(2);
    expect(effectsToasts()).toBe(2);
    expect(Player).toHaveBeenCalledTimes(2);
    await restore;
  });

  // (a) Scenario variant: the IFrame API script is still loading at the
  // planned join. That load still counts as loading, so the catch-up loads the
  // occurrence again there, as the COMMIT did before 6D-6: a second
  // youtube:load and effects toast behind the same script request. The script
  // then builds one iframe, for the newer load.
  it('(a) loads the occurrence again at the planned join while the IFrame API script is still loading', async () => {
    const loadedAt: number[] = [];
    bus.on('youtube:load', () => loadedAt.push(Date.now()));
    const { controller, reportReady } = createParticipant();

    controller.acceptPrepare(prepareEvent(0, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(PAST_PREPARE_BUDGET_MS);
    expect(reportReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ transitionId: TRANSITION_ID, status: 'failed' }),
    );
    const receivedAt = Date.now();
    controller.acceptCommit(commitEvent(1, 0, 'zero-start'));

    const plannedJoin = receivedAt + LATE_JOIN_LEAD_MS;
    await vi.advanceTimersByTimeAsync(plannedJoin - 1 - Date.now());
    expect(loadedAt).toHaveLength(1);
    expect(effectsToasts()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(loadedAt).toEqual([loadedAt[0], plannedJoin]);
    expect(effectsToasts()).toBe(2);
    expect(getYouTubePlayer()).toBeNull();

    // The script arrives 500 ms later and builds one iframe, for the newer
    // load; the device joins once it is armed, at the room position then.
    await vi.advanceTimersByTimeAsync(500);
    const scripts = document.querySelectorAll<HTMLScriptElement>(
      'script[src*="youtube.com/iframe_api"]',
    );
    expect(scripts).toHaveLength(1);
    const { iframes, Player } = installIframeApi();
    scripts[0]!.dispatchEvent(new Event('load'));
    expect(Player).toHaveBeenCalledOnce();
    iframes[0]!.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    const joined = iframes[0]!.fake;
    expect(plays(joined).at(-1)).toBeGreaterThan(plannedJoin);
    expect(joined.__state).toBe(1);
    expect(joined.getCurrentTime()).toBeCloseTo(
      (Date.now() - receivedAt - COMMIT_LEAD_MS) / 1_000,
      2,
    );
    await vi.advanceTimersByTimeAsync(loadedAt[1]! + SCRIPT_LOAD_TIMEOUT_MS - Date.now());
    expect(loadTimeoutToasts()).toBe(0);
    expect(getState('playback.mode')).toBe('youtube');
    expect(loadedAt).toHaveLength(2);
    expect(effectsToasts()).toBe(2);
    expect(Player).toHaveBeenCalledOnce();
  });

  // (a) Scenario, the other side of that deadline: the first iframe finishes
  // its handshake just before the planned join. The catch-up keeps it (one
  // load, one toast, no second iframe). Arming it overruns the plan, so the
  // device joins as soon as it is armed, at the room position then.
  it('(a) keeps a first iframe that finishes its handshake just before the planned join', async () => {
    const { iframes, Player } = installIframeApi();
    const loads = vi.fn();
    bus.on('youtube:load', loads);
    const { controller, reportReady } = createParticipant();

    const preparedAt = Date.now();
    controller.acceptPrepare(prepareEvent(0, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(PAST_PREPARE_BUDGET_MS);
    expect(reportReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ transitionId: TRANSITION_ID, status: 'failed' }),
    );
    const receivedAt = Date.now();
    controller.acceptCommit(commitEvent(1, 0, 'zero-start'));

    const plannedJoin = receivedAt + LATE_JOIN_LEAD_MS;
    await vi.advanceTimersByTimeAsync(plannedJoin - 1 - Date.now());
    iframes[0]!.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    const joined = iframes[0]!.fake;
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();
    expect(joined.__log.map(({ op }) => op)).not.toContain('destroy');
    expect(getYouTubePlayer()).toBe(joined);
    expect(plays(joined).at(-1)).toBeGreaterThan(plannedJoin);
    expect(joined.__state).toBe(1);
    expect(joined.getCurrentTime()).toBeCloseTo(
      (Date.now() - receivedAt - COMMIT_LEAD_MS) / 1_000,
      2,
    );
    await vi.advanceTimersByTimeAsync(preparedAt + SCRIPT_LOAD_TIMEOUT_MS - Date.now());
    expect(loadTimeoutToasts()).toBe(0);
    expect(loads).toHaveBeenCalledOnce();
    expect(Player).toHaveBeenCalledOnce();
  });

  // (a) Residual that the kept load's deadline does not cover, pinned as this
  // branch behaves: the device misses the COMMIT frame and learns of the start
  // from a snapshot 13 s after PREPARE, its first iframe still handshaking.
  // The join that snapshot plans (receipt + 3 s) comes after the first load's
  // own 15 s deadline, which ends that load first: the load-timeout toast, the
  // unready iframe destroyed, YouTube mode stopped and no second load. Only a
  // later room-state sync loads the occurrence again. Before 6D-6 the
  // snapshot's catch-up loaded again at once; a change that covers this case
  // flips this row.
  it('(a) ends a first iframe still handshaking at a snapshot 13 s after PREPARE with the load timeout, until a later room-state sync loads again', async () => {
    const { iframes, Player } = installIframeApi();
    const loadedAt: number[] = [];
    bus.on('youtube:load', () => loadedAt.push(Date.now()));
    const { controller, reportReady } = createParticipant();

    const preparedAt = Date.now();
    controller.acceptPrepare(prepareEvent(0, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(PAST_PREPARE_BUDGET_MS);
    expect(reportReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ transitionId: TRANSITION_ID, status: 'failed' }),
    );

    // The Worker commits without this device at its barrier. This device
    // misses that frame and gets the checkpoint in a snapshot 13 s after PREPARE.
    const executeAt = preparedAt + BARRIER_MS + COMMIT_LEAD_MS;
    await vi.advanceTimersByTimeAsync(preparedAt + 13_000 - Date.now());
    const receivedAt = Date.now();
    const restore = controller.restorePersistedPlayback(snapshot(checkpoint(1, 0, executeAt)));
    await vi.advanceTimersByTimeAsync(0);
    expect(loadedAt).toEqual([preparedAt]);
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();

    // The first load's deadline, 15 s after PREPARE, comes before the planned
    // join and ends that load.
    const loadDeadline = preparedAt + SCRIPT_LOAD_TIMEOUT_MS;
    expect(loadDeadline).toBeLessThan(receivedAt + LATE_JOIN_LEAD_MS);
    await vi.advanceTimersByTimeAsync(loadDeadline - Date.now());
    expect(loadTimeoutToasts()).toBe(1);
    expect(iframes[0]!.fake.__log).toEqual([{ op: 'destroy', at: loadDeadline }]);
    expect(getState('playback.mode')).not.toBe('youtube');

    // Past the planned join nothing loads again and nothing plays.
    await vi.advanceTimersByTimeAsync(receivedAt + LATE_JOIN_LEAD_MS + 5_000 - Date.now());
    expect(loadedAt).toEqual([preparedAt]);
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();
    await restore;

    // A later room-state sync (in the app, the next heartbeat) carries the same
    // checkpoint and loads the occurrence again at once. The device joins at
    // the plan that sync sets, 3 s later, at the room position there.
    const syncedAt = Date.now();
    const resync = controller.restorePersistedPlayback(snapshot(checkpoint(1, 0, executeAt)));
    await vi.advanceTimersByTimeAsync(0);
    expect(loadedAt).toEqual([preparedAt, syncedAt]);
    expect(effectsToasts()).toBe(2);
    expect(Player).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    iframes[1]!.ready();
    await vi.advanceTimersByTimeAsync(LATE_JOIN_LEAD_MS - 500);
    const joined = iframes[1]!.fake;
    expect(plays(joined).at(-1)).toBe(syncedAt + LATE_JOIN_LEAD_MS);
    expect(joined.__state).toBe(1);
    expect(joined.getCurrentTime()).toBeCloseTo(
      (syncedAt + LATE_JOIN_LEAD_MS - executeAt) / 1_000,
      6,
    );
    await resync;
  });

  // (a) Scenario, for contrast: the video is resident and ready, but the
  // arm's muted warm-up sees no PLAYING within the 2.3 s budget. The
  // catch-up reuses the resident iframe: no youtube:load and no toast.
  it('(a) re-arms a resident iframe whose warm-up missed the budget without a reload or toast', async () => {
    const { iframes, Player } = installIframeApi();
    const resident = await residentIframe(iframes, 30);
    const loads = vi.fn();
    bus.on('youtube:load', loads);
    const { controller, reportReady } = createParticipant();
    const play = resident.playVideo;
    resident.playVideo = () => {
      resident.__log.push({ op: 'playVideo', at: Date.now() });
      resident.__setState(3);
    };

    controller.acceptPrepare(prepareEvent(1, 30, 'scheduled-control'));
    await vi.advanceTimersByTimeAsync(PAST_PREPARE_BUDGET_MS);
    expect(reportReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: 'failed' }),
    );
    resident.playVideo = play;

    const receivedAt = Date.now();
    controller.acceptCommit(commitEvent(2, 30, 'scheduled-control'));
    await vi.advanceTimersByTimeAsync(LATE_JOIN_LEAD_MS);

    expect(plays(resident).at(-1)).toBe(receivedAt + LATE_JOIN_LEAD_MS);
    expect(resident.__state).toBe(1);
    expect(resident.getCurrentTime()).toBeCloseTo(30 + LATE_JOIN_ROOM_ADVANCE_SECONDS, 6);
    expect(loads).not.toHaveBeenCalled();
    expect(effectsToasts()).toBe(0);
    expect(Player).toHaveBeenCalledOnce();
  });

  // (c) Scenario: as above, but the catch-up's warm-up buffers for 2.08 s,
  // so the re-armed iframe is ready 300 ms before the planned instant, inside
  // the controller's 400 ms minimum release lead. Looks like a defect: the
  // controller then commits at once at the room position now (32.0 s), the
  // arm never seeks backward, and the device plays from the 32.3 s it settled
  // at, 0.3 s ahead of the room.
  it('(c) starts a late join whose re-arm ends 300 ms before its plan 0.3 s ahead of the room', async () => {
    const { iframes } = installIframeApi();
    const resident = await residentIframe(iframes, 30);
    const { controller, reportReady } = createParticipant();
    const play = resident.playVideo;
    let warmUps = 0;
    resident.playVideo = () => {
      resident.__log.push({ op: 'playVideo', at: Date.now() });
      resident.__setState(3);
      warmUps += 1;
      if (warmUps < 2) return;
      resident.playVideo = play;
      setTimeout(() => resident.__setState(1), 2_080);
    };

    controller.acceptPrepare(prepareEvent(1, 30, 'scheduled-control'));
    await vi.advanceTimersByTimeAsync(PAST_PREPARE_BUDGET_MS);
    expect(reportReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: 'failed' }),
    );

    const receivedAt = Date.now();
    controller.acceptCommit(commitEvent(2, 30, 'scheduled-control'));
    await vi.advanceTimersByTimeAsync(LATE_JOIN_LEAD_MS - 300);
    expect(warmUps).toBe(2);
    expect(plays(resident).at(-1)).toBe(receivedAt);
    // Ready now; the arm releases at once. (The fake clock runs a zero-delay
    // timer that is set during a tick 1 ms later.)
    await vi.advanceTimersByTimeAsync(1);

    const playedAt = plays(resident).at(-1)!;
    expect(playedAt - receivedAt).toBe(LATE_JOIN_LEAD_MS - 299);
    expect(resident.__state).toBe(1);
    expect(resident.getCurrentTime()).toBeCloseTo(30 + LATE_JOIN_ROOM_ADVANCE_SECONDS, 6);
    const roomAtPlaySeconds = 30 + (playedAt - receivedAt - COMMIT_LEAD_MS) / 1_000;
    expect(resident.getCurrentTime() - roomAtPlaySeconds).toBeCloseTo(0.299, 6);
  });

  // (b) Scenario: a resident, ready device releases on time, but the iframe
  // buffers and reports no PLAYING within 1.8 s. The arm pauses it and fails
  // the commit; playlist.ts reports media-unavailable, so the controller
  // re-arms the same iframe for a join 3 s later, 4.8 s into the room.
  it('(b) pauses a release that saw no PLAYING for 1.8 s and rejoins 3 s later at the room position', async () => {
    const { iframes } = installIframeApi();
    const resident = await residentIframe(iframes, 30);
    const loads = vi.fn();
    bus.on('youtube:load', loads);
    const { controller, reportReady } = createParticipant();

    controller.acceptPrepare(prepareEvent(1, 30, 'scheduled-control'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reportReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: 'ready' }),
    );
    const play = resident.playVideo;
    resident.playVideo = () => {
      resident.playVideo = play;
      resident.__log.push({ op: 'playVideo', at: Date.now() });
      resident.__setState(3);
    };

    const receivedAt = Date.now();
    controller.acceptCommit(commitEvent(2, 30, 'scheduled-control'));
    await vi.advanceTimersByTimeAsync(COMMIT_LEAD_MS + RELEASE_ACK_TIMEOUT_MS);
    const releasedAt = receivedAt + COMMIT_LEAD_MS;
    expect(plays(resident).at(-1)).toBe(releasedAt);
    expect(
      resident.__log.filter((call) => call.op === 'pauseVideo' && call.at > releasedAt)[0]?.at,
    ).toBe(releasedAt + RELEASE_ACK_TIMEOUT_MS);
    // Unmuted for the whole 1.8 s window: anything the iframe played was
    // audible. At its end the arm restores the captured audio (unMute), then
    // the catch-up's own warm-up hard-mutes the iframe again.
    expect(
      resident.__log
        .filter((call) => (call.op === 'mute' || call.op === 'unMute') && call.at >= releasedAt)
        .map(({ op, at }) => [op, at - releasedAt]),
    ).toEqual([
      ['unMute', RELEASE_ACK_TIMEOUT_MS],
      ['mute', RELEASE_ACK_TIMEOUT_MS],
    ]);

    await vi.advanceTimersByTimeAsync(LATE_JOIN_LEAD_MS);
    expect(plays(resident).at(-1)).toBe(releasedAt + RELEASE_ACK_TIMEOUT_MS + LATE_JOIN_LEAD_MS);
    expect(resident.__state).toBe(1);
    // 34.8 s: the room has run 1.8 s past executeAt plus the 3 s rejoin lead.
    expect(resident.getCurrentTime()).toBeCloseTo(
      30 + (RELEASE_ACK_TIMEOUT_MS + LATE_JOIN_LEAD_MS) / 1_000,
      6,
    );
    expect(loads).not.toHaveBeenCalled();
    expect(effectsToasts()).toBe(0);
  });

  describe('on Android, where the App adds a fixed 250 ms output lead', () => {
    // The titles and comments in this block quote today's floor (250 ms, and
    // numbers derived from it such as 0.25 s and 32.55 s) while the bodies
    // read ANDROID_YOUTUBE_PLAY_LATENCY_FLOOR_MS, so a change to the floor
    // renames those titles and updates those comments with it.
    const outputLeadMs = ANDROID_YOUTUBE_PLAY_LATENCY_FLOOR_MS;

    beforeEach(() => {
      platformUnderTest.android = true;
    });

    function lastRelease() {
      return getProStartObservations()
        .filter((entry) => entry.kind === 'youtube-release')
        .at(-1)?.detail;
    }

    function seeksAt(fake: FakeYtPlayer, at: number): unknown[][] {
      return fake.__log
        .filter((call) => call.op === 'seekTo' && call.at === at)
        .map((call) => call.args ?? []);
    }

    // (c) on Android: the late join of '(a) re-arms a resident iframe whose
    // warm-up missed the budget without a reload or toast', whose catch-up
    // warm-up succeeds. The catch-up drops only the learned lead and keeps the
    // fixed output lead the App applies to every playing start on Android, so
    // play is called 250 ms before the planned instant, from the room position
    // at that instant, with no seek. The media then runs 0.25 s ahead of the
    // room, the delay its sound is assumed to take to be heard. Where the
    // fixed lead is 0 (that row, 'other'), the call lands on the instant.
    it('(c) on Android calls play 250 ms before a late join instant from the room position there', async () => {
      const { iframes } = installIframeApi();
      const resident = await residentIframe(iframes, 30);
      const { controller, reportReady } = createParticipant();
      const play = resident.playVideo;
      resident.playVideo = () => {
        resident.__log.push({ op: 'playVideo', at: Date.now() });
        resident.__setState(3);
      };

      controller.acceptPrepare(prepareEvent(1, 30, 'scheduled-control'));
      await vi.advanceTimersByTimeAsync(PAST_PREPARE_BUDGET_MS);
      expect(reportReady).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: 'failed' }),
      );
      resident.playVideo = play;

      const receivedAt = Date.now();
      controller.acceptCommit(commitEvent(2, 30, 'scheduled-control'));
      const roomAtInstantSeconds = 30 + LATE_JOIN_ROOM_ADVANCE_SECONDS;
      await vi.advanceTimersByTimeAsync(LATE_JOIN_LEAD_MS - outputLeadMs);
      const calledAt = receivedAt + LATE_JOIN_LEAD_MS - outputLeadMs;
      expect(plays(resident).at(-1)).toBe(calledAt);
      expect(resident.getCurrentTime()).toBeCloseTo(roomAtInstantSeconds, 6);
      expect(seeksAt(resident, calledAt)).toEqual([]);
      expect(lastRelease()).toMatchObject({
        platform: 'android',
        timingMode: 'scheduled-control',
        platformLeadMs: outputLeadMs,
        timelineLeadMs: 0,
        scheduledLeadMs: outputLeadMs,
        outputPositionAdvanceMs: 0,
        releasedTargetSeconds: roomAtInstantSeconds,
      });

      // At the planned instant the media is 0.25 s ahead of the room.
      await vi.advanceTimersByTimeAsync(outputLeadMs);
      expect(resident.__state).toBe(1);
      expect(resident.getCurrentTime()).toBeCloseTo(roomAtInstantSeconds + outputLeadMs / 1_000, 6);
    });

    // (c) on Android: the re-arm of '(c) starts a late join whose re-arm ends
    // 300 ms before its plan 0.3 s ahead of the room'. The controller's
    // fallback again commits the room position now (32.0 s) with no delay. The
    // arm has no time left for the 250 ms output lead, so it supplies it as
    // position: from the 32.3 s it settled at it seeks to 32.55 s and plays at
    // once. Heard 250 ms after the call, that is still 0.3 s ahead of the
    // room, as on 'other', but this release also seeks.
    it('(c) on Android seeks a late join whose re-arm ends 300 ms before its plan 250 ms on and still starts 0.3 s ahead of the room', async () => {
      const { iframes } = installIframeApi();
      const resident = await residentIframe(iframes, 30);
      const { controller, reportReady } = createParticipant();
      const play = resident.playVideo;
      let warmUps = 0;
      resident.playVideo = () => {
        resident.__log.push({ op: 'playVideo', at: Date.now() });
        resident.__setState(3);
        warmUps += 1;
        if (warmUps < 2) return;
        resident.playVideo = play;
        setTimeout(() => resident.__setState(1), 2_080);
      };

      controller.acceptPrepare(prepareEvent(1, 30, 'scheduled-control'));
      await vi.advanceTimersByTimeAsync(PAST_PREPARE_BUDGET_MS);
      expect(reportReady).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: 'failed' }),
      );

      const receivedAt = Date.now();
      controller.acceptCommit(commitEvent(2, 30, 'scheduled-control'));
      await vi.advanceTimersByTimeAsync(LATE_JOIN_LEAD_MS - 300);
      expect(warmUps).toBe(2);
      await vi.advanceTimersByTimeAsync(1);

      const playedAt = plays(resident).at(-1)!;
      expect(playedAt - receivedAt).toBe(LATE_JOIN_LEAD_MS - 299);
      const settledSeconds = 30 + LATE_JOIN_ROOM_ADVANCE_SECONDS;
      const seeks = seeksAt(resident, playedAt);
      expect(seeks).toHaveLength(1);
      expect(seeks[0]![0]).toBeCloseTo(settledSeconds + outputLeadMs / 1_000, 6);
      expect(resident.__state).toBe(1);
      expect(resident.getCurrentTime()).toBeCloseTo(settledSeconds + outputLeadMs / 1_000, 6);
      expect(lastRelease()).toMatchObject({
        platform: 'android',
        timingMode: 'scheduled-control',
        platformLeadMs: outputLeadMs,
        scheduledLeadMs: 0,
        outputPositionAdvanceMs: expect.closeTo(outputLeadMs, 6),
      });
      const roomAtPlaySeconds = 30 + (playedAt - receivedAt - COMMIT_LEAD_MS) / 1_000;
      // Heard 250 ms after the call, the media's first sound meets a room
      // that has run 0.25 s further.
      const aheadSeconds = resident.getCurrentTime() - (roomAtPlaySeconds + outputLeadMs / 1_000);
      expect(aheadSeconds).toBeCloseTo(0.299, 6);
    });
  });
});
