/**
 * @vitest-environment jsdom
 *
 * YouTube loads on the paths that share the late PRO join's entry (pinned
 * 2026-11-02). The COMMIT catch-up of a device that missed its READY
 * (pro-late-prepare-reload.test.ts, the (a) rows) loads its occurrence through
 * the playlist media endpoint (prepareAuthoritativePlayback in
 * player/playlist.ts) and loadYouTubeVideo (youtube/iframe.ts), and so do the
 * paths below. These rows pin what those paths do today, so that a change to
 * the catch-up alone can be told apart from a change to them:
 * (1) a Standard room load shows the effects toast once;
 * (2) an ordinary PRO track change whose READY is on time loads once, with one
 *     toast, and its COMMIT adds none;
 * (3) a load of another video while one is still handshaking replaces that
 *     iframe, in a PRO room and in a Standard room;
 * (4) a new PREPARE, or a snapshot restore of a checkpoint this device did
 *     not prepare, of the same occurrence while its first iframe is still
 *     handshaking replaces that iframe, and so does the catch-up that follows
 *     the restore's own unbarriered wait;
 * (5) on an iPhone, the next track's load into the iframe the App kept from an
 *     earlier YouTube track stays in flight on that ready player until the
 *     iframe shows the track; when it misses READY, the COMMIT catch-up loads
 *     the occurrence again into the same iframe, with a second toast.
 *
 * The harness is the late-join suite's: the real playback controller, the
 * real playlist media endpoint (initPlaylist), the real iframe module behind
 * the scripted IFrame API (__helpers__/scripted-iframe-api.ts), whose player
 * methods appear only when the iframe handshake completes, and a calibrated
 * server clock. The platform is the App's own detection, core/platform.ts,
 * with IS_IOS switchable per row (as IS_ANDROID is in
 * pro-late-prepare-reload.test.ts).
 *
 * Timing: the Worker's COMMIT lead comes from the copy that
 * pro-room-playback-timing.test.ts pins to cloudflare/pro-room-playback-timing.ts
 * (this suite must not load Worker code, see ci-quality-gates.test.ts), the
 * App's late-join lead from
 * pro-room/__tests__/__helpers__/pro-late-youtube-join-timing.ts, which names
 * the row that pins it, and the barriered and unbarriered prepare budgets from
 * their home, src/youtube/constants.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { resetProStartObservations } from '../../diagnostics/pro-start-observations.ts';
import { t } from '../../i18n/index.ts';
import { initPlayback } from '../../player/playback.ts';
import { initPlaylist, playTrack } from '../../player/playlist.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';
import { LATE_YOUTUBE_COMMIT_LEAD_MS as LATE_JOIN_LEAD_MS } from '../../pro-room/__tests__/__helpers__/pro-late-youtube-join-timing.ts';
import { PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS as COMMIT_LEAD_MS } from '../../pro-room/__tests__/__helpers__/pro-room-playback-timing-copy.ts';
import type { QueueItemId } from '../../types/index.ts';
import { showToast } from '../../ui/toast.ts';
import {
  PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS,
  PRO_YOUTUBE_UNBARRIERED_PREPARE_TIMEOUT_MS,
} from '../constants.ts';
import {
  cancelYouTubeAuthorityPreparation,
  forgetRetainedYouTubePlayer,
  isRetainedYouTubePlayerParked,
} from '../iframe.ts';
import { initYouTube } from '../player.ts';
import {
  getYouTubePlayer,
  isYtLoadInProgress,
  isYtPlayerReady,
  isYtPrimed,
  resetYouTubeModuleState,
} from '../_state.ts';
import type { FakeYtPlayer } from './__helpers__/fake-yt-player.ts';
import { createProEndpointFixture } from './__helpers__/pro-endpoint-harness.ts';
import { installScriptedIframeApi, loadResidentIframe } from './__helpers__/scripted-iframe-api.ts';

const platformUnderTest = vi.hoisted(() => ({ ios: false }));
vi.mock('../../core/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/platform.ts')>()),
  get IS_IOS() {
    return platformUnderTest.ios;
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
const TRANSITION_A = `transition_${'w'.repeat(22)}`;
const TRANSITION_B = `transition_${'x'.repeat(22)}`;
/** One fixture per queue occurrence of the same synthetic room. */
const FIRST = createProEndpointFixture({
  roomCode: ROOM_CODE,
  roomEpoch: ROOM_EPOCH,
  queueItemId: '68000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'sharedPathA',
  transitionId: TRANSITION_A,
});
const SECOND = createProEndpointFixture({
  roomCode: ROOM_CODE,
  roomEpoch: ROOM_EPOCH,
  queueItemId: '68000000-0000-4000-8000-000000000002' as QueueItemId,
  videoId: 'sharedPathB',
  transitionId: TRANSITION_B,
});

function enterProRoom(): void {
  setState('room.context', {
    kind: 'pro',
    roomId: ROOM_CODE,
    role: 'member',
    coordinatorId: null,
    epoch: ROOM_EPOCH,
    snapshotRevision: 1,
    capabilities: [],
  });
}

function effectsToasts(): number {
  return vi
    .mocked(showToast)
    .mock.calls.filter(([message]) => message === t('youtube.effects_disabled')).length;
}

function plays(fake: FakeYtPlayer): number[] {
  return fake.__log.filter((call) => call.op === 'playVideo').map((call) => call.at);
}

function ops(fake: FakeYtPlayer): string[] {
  return fake.__log.map(({ op }) => op);
}

/**
 * A PREPARE's wait for READY: past the App's barriered budget (READY fails at
 * the iframe seam's first 40 ms poll after it), before the Worker's 3 s barrier.
 */
const PAST_PREPARE_BUDGET_MS = PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS + 100;

beforeEach(() => {
  platformUnderTest.ios = false;
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
    vi.fn(async () => Response.json({ title: 'Synthetic video' })),
  );
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
  initPlayback();
  initYouTube();
  initPlaylist();
  setState('setup.sessionStarted', true);
  setState(
    'playlist.items',
    [FIRST, SECOND].map(({ identity }, index) => ({
      queueItemId: identity.queueItemId,
      type: 'youtube' as const,
      name: `Synthetic video ${index + 1}`,
      videoId: identity.videoId,
      playlistId: null,
    })),
  );
});

afterEach(() => {
  FIRST.resetControllers();
  SECOND.resetControllers();
  resetProPlaybackAuthorityHooks();
  registerProPlaybackMediaEndpoint(null);
  cancelYouTubeAuthorityPreparation();
  bus.emit('youtube:stop-mode', { silent: true });
  // A primed iPhone row keeps its iframe parked in the iframe module's
  // retained-player controller; let the next row start without it.
  const player = getYouTubePlayer();
  if (player) forgetRetainedYouTubePlayer(player);
  platformUnderTest.ios = false;
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

describe('YouTube loads on the paths the late PRO join shares (pinned 2026-11-02)', () => {
  it('(1) a Standard room YouTube load shows the effects toast once', async () => {
    const { iframes, Player } = installScriptedIframeApi();
    const loads = vi.fn();
    bus.on('youtube:load', loads);

    await playTrack(FIRST.identity.queueItemId);
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(500);
    iframes[0]!.ready();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();
    expect(ops(iframes[0]!.fake)).not.toContain('destroy');
  });

  it('(2) a PRO track change whose READY is on time loads once with one effects toast', async () => {
    enterProRoom();
    const api = installScriptedIframeApi();
    const resident = await loadResidentIframe(api, {
      queueItemId: FIRST.identity.queueItemId,
      videoId: FIRST.identity.videoId,
      positionSeconds: 30,
    });
    vi.mocked(showToast).mockClear();
    const loads = vi.fn();
    bus.on('youtube:load', loads);
    const { controller, reportReady } = SECOND.createParticipant();

    controller.acceptPrepare(SECOND.prepareEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reportReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ transitionId: TRANSITION_B, status: 'ready' }),
    );
    expect(loads).toHaveBeenCalledOnce();
    expect(loads.mock.calls[0]).toEqual([
      SECOND.identity.videoId,
      null,
      SECOND.identity.queueItemId,
      false,
      0,
    ]);
    expect(effectsToasts()).toBe(1);
    expect(api.Player).toHaveBeenCalledOnce();
    expect(getYouTubePlayer()).toBe(resident);

    const commit = SECOND.commitEvent(2, 0, 'zero-start');
    controller.acceptCommit(commit);
    await vi.advanceTimersByTimeAsync(COMMIT_LEAD_MS + 500);
    expect(plays(resident).at(-1)).toBe(commit.executeAtMs);
    expect(resident.__state).toBe(1);
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);
    expect(api.Player).toHaveBeenCalledOnce();
  });

  it('(3) a load of another video while one is still handshaking replaces that iframe, as today', async () => {
    enterProRoom();
    const { iframes, Player } = installScriptedIframeApi();
    const loads = vi.fn();
    bus.on('youtube:load', loads);
    const { controller } = FIRST.createParticipant();

    controller.acceptPrepare(FIRST.prepareEvent(0, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();
    expect(isYtLoadInProgress()).toBe(true);

    // The room changes track again before this device's first iframe is ready.
    await vi.advanceTimersByTimeAsync(1_000);
    controller.acceptCancel(TRANSITION_A);
    controller.acceptPrepare(SECOND.prepareEvent(0, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveBeenCalledTimes(2);
    expect(loads.mock.calls[1]).toEqual([
      SECOND.identity.videoId,
      null,
      SECOND.identity.queueItemId,
      false,
      0,
    ]);
    expect(effectsToasts()).toBe(2);
    expect(Player).toHaveBeenCalledTimes(2);
    expect(ops(iframes[0]!.fake)).toEqual(['destroy']);
    expect(getYouTubePlayer()).toBe(iframes[1]!.fake);
  });

  it('(3, Standard) a load of another video while one is still handshaking replaces that iframe, as today', async () => {
    const { iframes, Player } = installScriptedIframeApi();
    const loads = vi.fn();
    bus.on('youtube:load', loads);

    await playTrack(FIRST.identity.queueItemId);
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveBeenCalledOnce();
    expect(Player).toHaveBeenCalledOnce();
    expect(isYtLoadInProgress()).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    await playTrack(SECOND.identity.queueItemId);
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveBeenCalledTimes(2);
    expect(loads.mock.calls[1]?.slice(0, 3)).toEqual([
      SECOND.identity.videoId,
      null,
      SECOND.identity.queueItemId,
    ]);
    expect(effectsToasts()).toBe(2);
    expect(Player).toHaveBeenCalledTimes(2);
    expect(ops(iframes[0]!.fake)).toEqual(['destroy']);
    expect(getYouTubePlayer()).toBe(iframes[1]!.fake);
  });

  it('(4) a new PREPARE of the occurrence whose first iframe is still handshaking replaces that iframe, as today', async () => {
    enterProRoom();
    const { iframes, Player } = installScriptedIframeApi();
    const loads = vi.fn();
    bus.on('youtube:load', loads);
    const { controller } = FIRST.createParticipant();

    controller.acceptPrepare(FIRST.prepareEvent(0, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();
    expect(isYtLoadInProgress()).toBe(true);

    // The room replaces its pending transition of the same occurrence (a seek
    // before the start) while this device's first iframe still handshakes.
    await vi.advanceTimersByTimeAsync(1_000);
    controller.acceptCancel(TRANSITION_A);
    controller.acceptPrepare(FIRST.prepareEvent(0, 30, 'scheduled-control', TRANSITION_B));
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveBeenCalledTimes(2);
    expect(loads.mock.calls[1]).toEqual([
      FIRST.identity.videoId,
      null,
      FIRST.identity.queueItemId,
      false,
      0,
    ]);
    expect(effectsToasts()).toBe(2);
    expect(Player).toHaveBeenCalledTimes(2);
    expect(ops(iframes[0]!.fake)).toEqual(['destroy']);
    expect(getYouTubePlayer()).toBe(iframes[1]!.fake);
  });

  it('(4) a restore of the occurrence whose first iframe is still handshaking replaces that iframe, and so does its own catch-up, as today', async () => {
    enterProRoom();
    const { iframes, Player } = installScriptedIframeApi();
    const loadedAt: number[] = [];
    bus.on('youtube:load', () => loadedAt.push(Date.now()));
    const participant = FIRST.createParticipant();

    // A heartbeat snapshot restores the room's running checkpoint; this device
    // holds no iframe yet.
    const first = FIRST.snapshot(FIRST.checkpoint(1, 10, Date.now()));
    participant.setCanonicalSnapshot(first);
    const firstRestore = participant.controller.restorePersistedPlayback(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadedAt).toHaveLength(1);
    expect(effectsToasts()).toBe(1);
    expect(Player).toHaveBeenCalledOnce();
    expect(isYtLoadInProgress()).toBe(true);

    // A newer checkpoint of the same occurrence (the room seeked) arrives while
    // that iframe still handshakes.
    await vi.advanceTimersByTimeAsync(1_000);
    const second = FIRST.snapshot(FIRST.checkpoint(2, 30, Date.now()));
    participant.setCanonicalSnapshot(second);
    const secondRestore = participant.controller.restorePersistedPlayback(second);
    await vi.advanceTimersByTimeAsync(100);
    expect(loadedAt).toHaveLength(2);
    expect(effectsToasts()).toBe(2);
    expect(Player).toHaveBeenCalledTimes(2);
    expect(ops(iframes[0]!.fake)).toEqual(['destroy']);
    expect(getYouTubePlayer()).toBe(iframes[1]!.fake);

    // The new iframe does not handshake within the restore's unbarriered wait.
    // The catch-up that follows loads the occurrence again.
    await vi.advanceTimersByTimeAsync(PRO_YOUTUBE_UNBARRIERED_PREPARE_TIMEOUT_MS);
    expect(loadedAt).toHaveLength(3);
    expect(effectsToasts()).toBe(3);
    expect(Player).toHaveBeenCalledTimes(3);
    expect(ops(iframes[1]!.fake)).toEqual(['destroy']);
    expect(getYouTubePlayer()).toBe(iframes[2]!.fake);

    // Its iframe is ready 500 ms later; the device joins 3 s after the
    // catch-up's load, at the room position there.
    const catchUpAt = loadedAt[2]!;
    await vi.advanceTimersByTimeAsync(catchUpAt + 500 - Date.now());
    iframes[2]!.ready();
    await vi.advanceTimersByTimeAsync(catchUpAt + LATE_JOIN_LEAD_MS - Date.now());
    const joined = iframes[2]!.fake;
    expect(plays(joined).at(-1)).toBe(catchUpAt + LATE_JOIN_LEAD_MS);
    expect(joined.__state).toBe(1);
    const roomPositionThere =
      second.playback.positionSeconds +
      (catchUpAt + LATE_JOIN_LEAD_MS - second.playback.updatedAtMs) / 1_000;
    expect(joined.getCurrentTime()).toBeCloseTo(roomPositionThere, 6);
    expect(loadedAt).toHaveLength(3);
    expect(effectsToasts()).toBe(3);
    await Promise.all([firstRestore, secondRestore]);
  });

  it('(5) a load into the kept, ready iframe of an iPhone that misses READY is loaded again at the COMMIT catch-up, as today', async () => {
    platformUnderTest.ios = true;
    enterProRoom();
    const api = installScriptedIframeApi();
    // This iPhone shows video A, and its iframe has played once (WebKit's
    // gesture gate). When the room leaves YouTube (for example for a file
    // track), the App keeps that ready iframe, parked on the silent prime video.
    const kept = await loadResidentIframe(api, {
      queueItemId: FIRST.identity.queueItemId,
      videoId: FIRST.identity.videoId,
      positionSeconds: 30,
    });
    kept.playVideo();
    await vi.advanceTimersByTimeAsync(0);
    expect(isYtPrimed()).toBe(true);
    bus.emit('youtube:stop-mode');
    await vi.advanceTimersByTimeAsync(500);
    expect(getYouTubePlayer()).toBe(kept);
    expect(isRetainedYouTubePlayerParked(getYouTubePlayer())).toBe(true);
    vi.mocked(showToast).mockClear();
    const loads = vi.fn();
    bus.on('youtube:load', loads);

    // The next YouTube track goes into that iframe, whose first cue of it does
    // not land before READY: the load stays in flight on a ready player.
    const cue = kept.cueVideoById;
    let cuesLand = false;
    kept.cueVideoById = (videoId: string, startSeconds?: number) => {
      if (cuesLand) return cue(videoId, startSeconds);
      kept.__log.push({ op: 'cueVideoById', args: [videoId, startSeconds], at: Date.now() });
    };
    const { controller, reportReady } = SECOND.createParticipant();
    controller.acceptPrepare(SECOND.prepareEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveBeenCalledOnce();
    expect(effectsToasts()).toBe(1);
    expect(getYouTubePlayer()).toBe(kept);
    await vi.advanceTimersByTimeAsync(PAST_PREPARE_BUDGET_MS);
    expect(reportReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ transitionId: TRANSITION_B, status: 'failed' }),
    );
    expect(isYtLoadInProgress()).toBe(true);
    expect(isYtPlayerReady()).toBe(true);

    // The catch-up loads the occurrence again into the same iframe: a second
    // youtube:load and effects toast, no new iframe and no destroy.
    cuesLand = true;
    const commit = SECOND.commitEvent(2, 0, 'zero-start');
    const receivedAt = Date.now();
    controller.acceptCommit(commit);
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveBeenCalledTimes(2);
    expect(loads.mock.calls[1]).toEqual([
      SECOND.identity.videoId,
      null,
      SECOND.identity.queueItemId,
      false,
      0,
    ]);
    expect(effectsToasts()).toBe(2);
    expect(api.Player).toHaveBeenCalledOnce();
    expect(ops(kept)).not.toContain('destroy');
    expect(getYouTubePlayer()).toBe(kept);

    // It joins 3 s after COMMIT receipt, at the room position there.
    await vi.advanceTimersByTimeAsync(LATE_JOIN_LEAD_MS);
    expect(plays(kept).at(-1)).toBe(receivedAt + LATE_JOIN_LEAD_MS);
    expect(kept.__state).toBe(1);
    expect(kept.getCurrentTime()).toBeCloseTo(
      commit.playback.positionSeconds +
        (receivedAt + LATE_JOIN_LEAD_MS - commit.playback.updatedAtMs) / 1_000,
      6,
    );
    expect(loads).toHaveBeenCalledTimes(2);
    expect(effectsToasts()).toBe(2);
  });
});
