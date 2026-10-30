/**
 * @vitest-environment jsdom
 *
 * Room-switch trace T1-T5 (pinned 2026-10-30): what the YouTube start owners
 * leave behind when the room changes under them, observed by the iframe's
 * ops, the frames sent and the public predicates (no timer names).
 *
 * L is the real leaveSession (network/peer.ts is mocked only for its sends;
 * core/wake-lock.ts as in peer.test.ts). P is runtime.ts's cleared() order
 * (pro-room/runtime.ts:2682-2694) on the real ProRoomPlaybackController and
 * hooks: stopLifecycle() (which resets the playback hooks and cancels a
 * pending preparation through the endpoint), then resetPlaylistRuntime(),
 * then the room-context reset. P emits no youtube:stop-mode.
 *
 * Real: initYouTube's wiring, the iframe module behind a scripted IFrame
 * API, core/timers, the protocol dispatcher, the zero-start controller, the
 * playlist media endpoint (initPlaylist) and the PRO controller. Fakes: the
 * iframe (with its fault knobs), the Standard remote participant (the real
 * zero-start controller on its own fake iframe), a calibrated shared clock
 * and PRO server clock, the network sends, log and toasts.
 *
 * There is no direct Standard to PRO path: every Standard to PRO switch goes
 * through L first (T1, T2). P is the only room-context change that runs
 * without youtube:stop-mode (T4). A row marked "Looks like a defect" pins
 * today's behaviour, not claimed right.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { resetProStartObservations } from '../../diagnostics/pro-start-observations.ts';
import { broadcast, leaveSession, safeSend, sendToHost } from '../../network/peer.ts';
import { resetInboundRateLimit } from '../../network/protocol.ts';
import { initPlaylist } from '../../player/playlist.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';
import { resetRoomContext } from '../../rooms/authority.ts';
import type { QueueItemId } from '../../types/index.ts';
import { cancelYouTubeAuthorityPreparation } from '../iframe.ts';
import { toCanonicalYouTubeTime } from '../local-offset.ts';
import { initYouTube, scheduleYtAutoSync, stopYouTubeMode } from '../player.ts';
import { resetYouTubeModuleState, setYtPrimed } from '../_state.ts';
import { initYouTubeSync, resetYouTubeSyncState } from '../sync.ts';
import { initProtocol } from '../../network/protocol.ts';
import { initPlayback } from '../../player/playback.ts';
import type { FakeYtPlayer } from './__helpers__/fake-yt-player.ts';
import { createProEndpointFixture } from './__helpers__/pro-endpoint-harness.ts';
import { installScriptedIframeApi, loadResidentIframe } from './__helpers__/scripted-iframe-api.ts';
import {
  createFakeClockStarter,
  frameRoutes,
  opTrace,
  predicateFlags,
  recordSentFrames,
  runStandardScenario,
  setUpStandardRig,
  standardScenarios,
  syntheticConnection,
  type StandardRig,
} from './__helpers__/standard-start-harness.ts';

const wakeLock = vi.hoisted(() => ({ deactivateNoSleep: vi.fn() }));
vi.mock('../../core/wake-lock.ts', () => ({ deactivateNoSleep: wakeLock.deactivateNoSleep }));
vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
}));
vi.mock('../../network/peer.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/peer.ts')>()),
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
}));
vi.mock('../../network/shared-clock.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/shared-clock.ts')>()),
  getHostNow: () => Date.now(),
  getClockOffset: () => 0,
  isClockCalibrated: () => true,
}));
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

const STANDARD = {
  queueItemId: '71000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'roomSwitchA',
  nextQueueItemId: '71000000-0000-4000-8000-000000000002' as QueueItemId,
  nextVideoId: 'roomSwitchB',
};
const SCENARIOS = standardScenarios(STANDARD);
const PRO = createProEndpointFixture({
  roomCode: '000001',
  roomEpoch: 6,
  queueItemId: '62000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'roomSwitchP',
  transitionId: `transition_${'r'.repeat(22)}`,
});
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 9, 30, 0, 0, 0));
let rig: StandardRig | null = null;
const SENDS = () => ({
  broadcast: vi.mocked(broadcast),
  safeSend: vi.mocked(safeSend),
  sendToHost: vi.mocked(sendToHost),
});

beforeEach(() => {
  startFakeClock();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  resetYouTubeModuleState();
  resetYouTubeSyncState();
  resetProPlaybackAuthorityHooks();
  resetProStartObservations();
  registerProPlaybackMediaEndpoint(null);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ title: 'Synthetic video' })),
  );
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
});

afterEach(() => {
  rig?.dispose();
  rig = null;
  PRO.resetControllers();
  resetProPlaybackAuthorityHooks();
  registerProPlaybackMediaEndpoint(null);
  cancelYouTubeAuthorityPreparation();
  stopYouTubeMode({ silent: true });
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

/** Enter a PRO room as an ordinary member on this already-initialized App. */
function enterProRoom(): void {
  setState('room.context', {
    kind: 'pro',
    roomId: PRO.identity.roomCode,
    role: 'member',
    coordinatorId: null,
    epoch: PRO.identity.roomEpoch,
    snapshotRevision: 1,
    capabilities: [],
  });
  setState('setup.sessionStarted', true);
  setState('audio.masterVolume', 1);
  setState('playlist.items', [
    {
      queueItemId: PRO.identity.queueItemId,
      type: 'youtube',
      name: 'Synthetic video',
      videoId: PRO.identity.videoId,
      playlistId: null,
    },
  ]);
}

/** ms since t0, iframe index and op, for every iframe the scripted API built. */
function allOps(current: StandardRig, fromMs: number): string[] {
  return current.api.iframes.flatMap(({ fake }, index) =>
    opTrace(fake, current.t0)
      .filter((line) => Number(line.slice(1, line.indexOf(' '))) >= fromMs)
      .map((line) => `#${index} ${line}`),
  );
}

describe('Room-switch trace (pinned 2026-10-30)', () => {
  it('T1: a Standard host in zero-start warm-up under hard mute, then L, then a PRO PREPARE', async () => {
    rig = await setUpStandardRig({
      role: 'host',
      sends: SENDS(),
      roomCode: '100001',
      ...STANDARD,
      hostPeerId: 'host-1',
      guestPeerId: 'guest-1',
    });
    initPlaylist();
    setYtPrimed(true);
    await runStandardScenario(rig, { ...SCENARIOS.hostAllReady, endAt: 250 });
    const flagsInWarmUp = predicateFlags();
    leaveSession();
    const afterLeave = predicateFlags();
    await rig.advanceTo(1_000);
    enterProRoom();
    const participant = PRO.createParticipant();
    // The PREPARE reuses the parked iframe, whose handshake completed at t0,
    // so no second handshake runs.
    participant.controller.acceptPrepare(PRO.prepareEvent(0, 0, 'zero-start'));
    // Past every Standard fallback deadline (3 s, 7.7 s) and the prepare window.
    await rig.advanceTo(14_000);
    expect(flagsInWarmUp).toBe('owned inFlight protocol -');
    expect(afterLeave).toBe('- - - -');
    expect(predicateFlags()).toBe('- - - -');
    // L parks the primed iframe with no unMute after parking; the PRO
    // PREPARE reuses that iframe and arms it from a clean state.
    expect(rig.api.iframes).toHaveLength(1);
    expect(allOps(rig, 250)).toEqual([
      '#0 +250 pauseVideo()',
      '#0 +250 mute()',
      '#0 +250 pauseVideo()',
      '#0 +250 cueVideoById(r7M_P0FAOtw,0)',
      '#0 +1000 pauseVideo()',
      '#0 +1000 pauseVideo()',
      '#0 +1000 mute()',
      '#0 +1000 cueVideoById(roomSwitchP,0)',
      '#0 +1080 mute()',
      '#0 +1081 setVolume(100)',
      '#0 +1081 mute()',
      '#0 +1081 pauseVideo()',
      '#0 +1081 seekTo(0,true)',
      '#0 +1081 playVideo()',
      '#0 +1341 pauseVideo()',
      '#0 +1421 seekTo(0,true)',
      '#0 +1581 setVolume(100)',
      '#0 +1581 unMute()',
    ]);
    expect(
      participant.reportReady.mock.calls.map(([report]) => (report as { status: string }).status),
    ).toEqual(['ready']);
    // Nothing from the Standard run follows its ABORT and the teardown.
    expect(frameRoutes(rig.sent)).toEqual([
      'peer:guest-1 youtube-zero-start-prepare',
      'peer:guest-1 youtube-zero-start-abort',
      'broadcast:* youtube-stop',
      'broadcast:* pause',
      'broadcast:* pause',
      'broadcast:* pause',
    ]);
  });

  it('T2: a Standard guest holding the external fallback, then L, then a PRO PREPARE', async () => {
    rig = await setUpStandardRig({
      role: 'guest',
      sends: SENDS(),
      roomCode: '100001',
      ...STANDARD,
      hostPeerId: 'host-1',
      guestPeerId: 'guest-1',
    });
    initPlaylist();
    await runStandardScenario(rig, { ...SCENARIOS.guestCohortExcluded(60_000), endAt: 3_000 });
    const flagsInFallback = predicateFlags();
    leaveSession();
    const afterLeave = predicateFlags();
    await rig.advanceTo(3_500);
    enterProRoom();
    const participant = PRO.createParticipant();
    participant.controller.acceptPrepare(PRO.prepareEvent(0, 0, 'zero-start'));
    await rig.advanceTo(3_600);
    rig.api.iframes.at(-1)?.ready();
    await rig.advanceTo(16_000);
    expect(flagsInFallback).toBe('owned - - fallback');
    expect(afterLeave).toBe('- - - -');
    expect(predicateFlags()).toBe('- - - -');
    // L destroys the unprimed guest iframe; the PRO PREPARE builds and arms
    // a new one, and the abandoned fallback issues nothing on either.
    expect(rig.api.iframes).toHaveLength(2);
    expect(allOps(rig, 3_000)).toEqual([
      '#0 +3000 mute()',
      '#0 +3000 pauseVideo()',
      '#0 +3000 stopVideo()',
      '#0 +3000 destroy()',
      '#1 +3620 mute()',
      '#1 +3621 setVolume(100)',
      '#1 +3621 mute()',
      '#1 +3621 pauseVideo()',
      '#1 +3621 seekTo(0,true)',
      '#1 +3621 playVideo()',
      '#1 +3881 pauseVideo()',
      '#1 +3961 seekTo(0,true)',
      '#1 +4121 setVolume(100)',
      '#1 +4121 unMute()',
    ]);
    expect(
      participant.reportReady.mock.calls.map(([report]) => (report as { status: string }).status),
    ).toEqual(['ready']);
  });

  it("T3: a Standard host in the stage-2 'yt-auto-sync' wait, then L", async () => {
    rig = await setUpStandardRig({
      role: 'host',
      sends: SENDS(),
      roomCode: '100001',
      ...STANDARD,
      hostPeerId: 'host-1',
      guestPeerId: 'guest-1',
      localOffsetSeconds: -5,
    });
    await rig.advanceTo(100);
    scheduleYtAutoSync(0);
    await rig.advanceTo(1_000);
    const before = toCanonicalYouTubeTime(rig.iframe().getCurrentTime(), 240);
    const from = rig.sent.length;
    leaveSession();
    const iframeTime = rig.iframe().getCurrentTime();
    const after = toCanonicalYouTubeTime(iframeTime, 240);
    await rig.advanceTo(9_000);
    // The held speaker read the room's 0.9 s through the local-start reader;
    // after L the reader is gone and the iframe's own time is returned.
    expect(before).toBeCloseTo(0.9, 6);
    expect(after).toBe(iframeTime);
    expect(after).toBe(0);
    // No YOUTUBE_SYNC after L: only the teardown's own frames.
    expect(frameRoutes(rig.sent.slice(from))).toEqual([
      'broadcast:* youtube-stop',
      'broadcast:* pause',
    ]);
    expect(predicateFlags()).toBe('- - - -');
  });
});

describe('Room-switch trace: P, the PRO session cleared (pinned 2026-10-30)', () => {
  async function setUpProParticipant(): Promise<{
    fake: FakeYtPlayer;
    t0: number;
    api: ReturnType<typeof installScriptedIframeApi>;
  }> {
    initPlayback();
    initYouTube();
    initYouTubeSync();
    initPlaylist();
    initProtocol();
    enterProRoom();
    const api = installScriptedIframeApi();
    const fake = await loadResidentIframe(api, {
      queueItemId: PRO.identity.queueItemId,
      videoId: PRO.identity.videoId,
      positionSeconds: 0,
    });
    return { fake, t0: Date.now(), api };
  }

  function clearProSession(
    controller: ReturnType<typeof PRO.createParticipant>['controller'],
  ): void {
    controller.stopLifecycle();
    controller.resetPlaylistRuntime();
    resetRoomContext();
  }

  it('T4 (a): P during the PREPARE warm-up cancels the arm', async () => {
    const { fake, t0 } = await setUpProParticipant();
    const participant = PRO.createParticipant();
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(150);
    const from = fake.__log.length;
    clearProSession(participant.controller);
    await vi.advanceTimersByTimeAsync(5_000);
    // stopLifecycle cancels the arm through the endpoint: pause, and one
    // restore of the captured audio. No READY is reported.
    expect(opTrace(fake, t0, from)).toEqual([
      '+150 pauseVideo()',
      '+150 setVolume(100)',
      '+150 unMute()',
    ]);
    expect(fake.isMuted()).toBe(false);
    expect(participant.reportReady).not.toHaveBeenCalled();
  });

  it('T4 (b): P after a timed-out release lands on the catch-up re-arm that superseded the detached restore', async () => {
    const { fake, t0 } = await setUpProParticipant();
    const participant = PRO.createParticipant();
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(1_000);
    // The release buffers and never reports PLAYING, and WebKit ignores the
    // unmutes of the arm's detached restore that follows the 1.8 s timeout.
    const play = fake.playVideo;
    fake.playVideo = () => {
      fake.playVideo = play;
      fake.__log.push({ op: 'playVideo', at: Date.now() });
      fake.__setState(3);
    };
    fake.__unMuteIgnoreCount = 1_000;
    const commitFrom = fake.__log.length;
    participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'zero-start'));
    // The release at +1700 times out at +3500; the detached restore retries.
    await vi.advanceTimersByTimeAsync(2_600);
    const pAt = Date.now() - t0;
    clearProSession(participant.controller);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pAt).toBe(3_600);
    // Today the detached restore after the 1.8 s release timeout (+3500)
    // makes one attempt and is superseded at once by the controller's
    // catch-up re-arm (+3501, to 4.8 s, three seconds later). The restore
    // lives only that 1 ms, so P cannot land on it here: P at +3600 cancels
    // the re-arm with one restore attempt, and nothing writes after P.
    expect(opTrace(fake, t0, commitFrom)).toEqual([
      '+1700 playVideo()',
      '+3500 pauseVideo()',
      '+3500 setVolume(100)',
      '+3500 unMute()',
      '+3500 mute()',
      '+3501 setVolume(100)',
      '+3501 mute()',
      '+3501 pauseVideo()',
      '+3501 seekTo(4.8,true)',
      '+3501 playVideo()',
      '+3600 pauseVideo()',
      '+3600 setVolume(100)',
      '+3600 unMute()',
    ]);
  });

  it('T5: PRO, then L, then a Standard host start runs a normal zero-start', async () => {
    const { t0, api } = await setUpProParticipant();
    // A participant-local PRO pause is still pending when the room is left.
    bus.emit('pro-playback:ui-control-pending', {
      token: 501,
      kind: 'pause',
      queueItemId: PRO.identity.queueItemId,
      targetSeconds: 0,
      wasPlaying: false,
    });
    leaveSession();
    await vi.advanceTimersByTimeAsync(500);
    // Create a Standard room on the same App, with one guest that advertises.
    const guest = syntheticConnection('switch-guest-1');
    const recorder = recordSentFrames(SENDS(), () => t0);
    setState('network.appRole', 'host');
    setState('network.myId', 'switch-host-1');
    setState('network.sessionCode', '100001');
    setState('setup.sessionStarted', true);
    setState('audio.masterVolume', 1);
    setState('network.activeHostConnByPeerId', new Map([[guest.peer, guest]]));
    resetInboundRateLimit(guest.peer);
    setState('playlist.items', [
      {
        queueItemId: STANDARD.queueItemId,
        type: 'youtube',
        name: 'Synthetic video',
        videoId: STANDARD.videoId,
        playlistId: null,
      },
    ]);
    bus.emit(
      'network:data',
      { type: MSG.YOUTUBE_ZERO_START_CAPABILITY, version: 2, platform: 'other', ready: true },
      guest,
    );
    setState('playlist.currentQueueItemId', STANDARD.queueItemId);
    bus.emit('youtube:load', STANDARD.videoId, null, STANDARD.queueItemId, false, 0);
    const iframes = api.iframes.length;
    api.iframes.at(-1)!.ready();
    await vi.advanceTimersByTimeAsync(100);
    const startAt = Date.now() - t0;
    const fake = api.iframes.at(-1)!.fake;
    const opsFrom = fake.__log.length;
    bus.emit('youtube:toggle-play');
    await vi.advanceTimersByTimeAsync(8_000);
    // L destroyed the PRO iframe; the Standard load built a second one.
    expect(iframes).toBe(2);
    expect(startAt).toBe(600);
    // A normal zero-start: hard-muted warm-up, then the release restores the
    // master volume (no stale PRO pause gate keeps it muted).
    expect(opTrace(fake, t0, opsFrom)).toEqual([
      '+600 mute()',
      '+600 setVolume(100)',
      '+600 mute()',
      '+600 playVideo()',
      '+860 pauseVideo()',
      '+940 seekTo(0,true)',
      '+1100 setVolume(100)',
      '+1100 unMute()',
      '+3600 playVideo()',
      '+3600 unMute()',
    ]);
    // A fresh authority signature: the PREPARE goes out, then the COMMIT
    // without the silent guest, the timeline samples and the heartbeat.
    expect(frameRoutes(recorder.frames)).toEqual([
      'broadcast:* playlist-slots',
      'broadcast:* pause',
      'broadcast:* playlist-slots',
      'peer:switch-guest-1 youtube-zero-start-prepare',
      'peer:switch-guest-1 youtube-zero-start-commit',
      ...Array.from({ length: 10 }, () => 'peer:switch-guest-1 youtube-zero-start-timeline'),
      'broadcast:* youtube-sync',
    ]);
    expect(predicateFlags()).toBe('- - - -');
  });
});
