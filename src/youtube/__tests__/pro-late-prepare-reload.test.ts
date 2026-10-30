/**
 * @vitest-environment jsdom
 *
 * Pins of a late PRO participant's YouTube stack (investigation of 2026-10-30
 * on 9.0.24), end to end: the real playback controller, the real playlist
 * media endpoint (initPlaylist), the real iframe module behind a scripted
 * IFrame API, and a calibrated server clock. When this device misses the
 * server's READY barrier, the COMMIT sends it down the catch-up path; these
 * rows count what that path does to the iframe and the toasts. They describe
 * current behaviour, including parts that look like defects.
 *
 * Timing: the Worker's barrier and COMMIT lead come from the copy that
 * pro-room-playback-timing.test.ts pins to cloudflare/pro-room-playback-timing.ts
 * (this suite must not load Worker code, see ci-quality-gates.test.ts); the
 * App's own late-join values come from
 * pro-room/__tests__/__helpers__/pro-late-youtube-join-timing.ts, which names
 * the row that pins each of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
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
import {
  LATE_YOUTUBE_COMMIT_LEAD_MS as LATE_JOIN_LEAD_MS,
  RELEASE_ACK_TIMEOUT_MS,
} from '../../pro-room/__tests__/__helpers__/pro-late-youtube-join-timing.ts';
import {
  PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS as COMMIT_LEAD_MS,
  PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS as BARRIER_MS,
} from '../../pro-room/__tests__/__helpers__/pro-room-playback-timing-copy.ts';
import { proSnapshot } from '../../pro-room/__tests__/__helpers__/pro-snapshot.ts';
import type { QueueItemId } from '../../types/index.ts';
import { showToast } from '../../ui/toast.ts';
import { cancelYouTubeAuthorityPreparation } from '../iframe.ts';
import { initYouTube } from '../player.ts';
import { getYouTubePlayer, isYtLoadInProgress, resetYouTubeModuleState } from '../_state.ts';
import { makeFakeYtPlayer, type FakeYtPlayer } from './__helpers__/fake-yt-player.ts';

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

function snapshot(): ProRoomSnapshot {
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
    currentQueueItemId: null,
    playback: {
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

function plays(fake: FakeYtPlayer): number[] {
  return fake.__log.filter((call) => call.op === 'playVideo').map((call) => call.at);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(2_000_000);
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  resetYouTubeModuleState();
  resetProPlaybackAuthorityHooks();
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
  it('(a) replays youtube:load and the effects toast when the COMMIT catch-up meets a still-loading iframe', async () => {
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

    // The catch-up runs the PREPARE path again: a second youtube:load for the
    // same occurrence, and loadYouTubeVideo shows its toast a second time.
    expect(loads).toHaveBeenCalledTimes(2);
    expect(loads.mock.calls[1]).toEqual([VIDEO_ID, null, QUEUE_ITEM_ID, false, 0]);
    expect(effectsToasts()).toBe(2);
    // Looks like a defect: that load also destroys the iframe still loading
    // and builds another, so the wait for its handshake starts over.
    expect(Player).toHaveBeenCalledTimes(2);
    expect(iframes[0]!.fake.__log.map(({ op }) => op)).toEqual(['destroy']);
    expect(getYouTubePlayer()).toBe(iframes[1]!.fake);

    // The new iframe is ready 500 ms later; the device joins at its plan,
    // 3 s after COMMIT receipt, at the room position there (3.0 - 0.7 s).
    await vi.advanceTimersByTimeAsync(500);
    iframes[1]!.ready();
    await vi.advanceTimersByTimeAsync(LATE_JOIN_LEAD_MS - 500);
    const joined = iframes[1]!.fake;
    expect(plays(joined).at(-1)).toBe(receivedAt + LATE_JOIN_LEAD_MS);
    expect(joined.__state).toBe(1);
    expect(joined.getCurrentTime()).toBeCloseTo(LATE_JOIN_ROOM_ADVANCE_SECONDS, 6);
    expect(loads).toHaveBeenCalledTimes(2);
    expect(effectsToasts()).toBe(2);
  });

  // (a) Scenario variant: the IFrame API script itself is still loading when
  // the budget ends. The catch-up's load queues behind the same script
  // request: again a second youtube:load and toast, but no iframe to destroy.
  it('(a) replays youtube:load and the effects toast while the IFrame API script is still loading', async () => {
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
    expect(loads).toHaveBeenCalledTimes(2);
    expect(effectsToasts()).toBe(2);

    // The script arrives 500 ms later and builds one iframe, for the newer load.
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
    expect(loads).toHaveBeenCalledTimes(2);
    expect(effectsToasts()).toBe(2);
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
});
