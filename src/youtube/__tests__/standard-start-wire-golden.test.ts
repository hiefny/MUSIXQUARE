/**
 * @vitest-environment jsdom
 *
 * Standard-room YouTube start wire and timing golden (pinned 2026-10-30).
 *
 * Every frame the App sends in each named Standard start scenario
 * (standard-start-harness.ts), with its recipient, its send instant relative
 * to t0 (the iframe handshake, which also arms the host heartbeat, so the
 * heartbeat phase never drifts) and its key fields. Later Phase 6 increments
 * that claim to be neutral must pass these arrays byte for byte; the
 * mixed-version argument rests on them. Also pinned: when the guest's
 * zero-start CAPABILITY goes out, the no-auto-retry Sync window after a
 * release (known-accepted #14), and the guest fallback deadlines.
 *
 * Real: initYouTube's wiring, the iframe module behind a scripted IFrame
 * API, core/timers, the protocol dispatcher and the zero-start controller.
 * The remote participant is the real zero-start controller on its own fake
 * iframe, so every timing value on the wire comes from zero-start.ts.
 *
 * Instants a test chooses come from src/youtube/constants.ts or from the
 * scenario scripts; runIds are aliased run-1, run-2 in order of appearance,
 * and host instants are written relative to t0. A row marked "Looks like a
 * defect" pins today's behaviour, not claimed right.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { t } from '../../i18n/index.ts';
import { broadcast, safeSend, sendToHost } from '../../network/peer.ts';
import { initProtocol, resetInboundRateLimit } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { initPlayback } from '../../player/playback.ts';
import type { QueueItemId } from '../../types/index.ts';
import { showToast } from '../../ui/toast.ts';
import { HEARTBEAT_INTERVAL_MS } from '../constants.ts';
import { cancelYouTubeAuthorityPreparation } from '../iframe.ts';
import { initYouTube, stopYouTubeMode } from '../player.ts';
import { resetYouTubeModuleState } from '../_state.ts';
import { guestRendezvousSync, initYouTubeSync, resetYouTubeSyncState } from '../sync.ts';
import { installScriptedIframeApi } from './__helpers__/scripted-iframe-api.ts';
import {
  createFakeClockStarter,
  opTrace,
  recordSentFrames,
  runIdAliases,
  runStandardScenario,
  setUpStandardRig,
  standardScenarios,
  syntheticConnection,
  type SentFrame,
  type StandardRig,
  type StandardScenario,
} from './__helpers__/standard-start-harness.ts';

const clockUnderTest = vi.hoisted(() => ({ calibrated: true }));
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
  isClockCalibrated: () => clockUnderTest.calibrated,
}));

const IDENTITY = {
  queueItemId: '73000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'wireGoldenA',
  nextQueueItemId: '73000000-0000-4000-8000-000000000002' as QueueItemId,
  nextVideoId: 'wireGoldenB',
};
const SCENARIOS = standardScenarios(IDENTITY);
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 9, 30, 0, 0, 0));
let rig: StandardRig | null = null;

beforeEach(() => {
  startFakeClock();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  resetYouTubeModuleState();
  resetYouTubeSyncState();
  clockUnderTest.calibrated = true;
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
});

afterEach(() => {
  rig?.dispose();
  rig = null;
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

const SENDS = () => ({
  broadcast: vi.mocked(broadcast),
  safeSend: vi.mocked(safeSend),
  sendToHost: vi.mocked(sendToHost),
});

async function startRig(scenario: StandardScenario): Promise<StandardRig> {
  rig = await setUpStandardRig({
    role: scenario.role,
    sends: SENDS(),
    roomCode: '100001',
    ...IDENTITY,
    hostPeerId: 'host-1',
    guestPeerId: 'guest-1',
    ...scenario.rig,
  });
  return rig;
}

/** One golden line per frame: '<ms> <route> <type> <key fields>'. */
function goldenLines(
  frames: readonly SentFrame[],
  t0: number,
  aliases: Map<string, string>,
): string[] {
  const rel = (value: unknown) => (typeof value === 'number' ? value - t0 : value);
  const num = (value: unknown) =>
    typeof value === 'number' ? String(Math.round(value * 1_000) / 1_000) : String(value);
  return frames.map(({ at, via, to, type, frame }) => {
    const run = typeof frame.runId === 'string' ? (aliases.get(frame.runId) ?? frame.runId) : '';
    let fields: string;
    switch (type) {
      case MSG.YOUTUBE_ZERO_START_CAPABILITY:
        fields = `v${num(frame.version)} ${frame.platform} ready=${frame.ready}`;
        break;
      case MSG.YOUTUBE_ZERO_START_PREPARE:
        fields = `${run} seq=${num(frame.sequence)} prepare=${num(rel(frame.prepareAtHost))} decision=${num(rel(frame.decisionAtHost))} deadline=${num(rel(frame.startDeadlineAtHost))} host=${frame.hostPlatform}`;
        break;
      case MSG.YOUTUBE_ZERO_START_ARMED:
        fields = `${run} prepared=${num(frame.preparedMs)} warm=${num(frame.warmLatencyMs)} pos=${num(frame.positionSec)} state=${num(frame.playerState)} muted=${frame.muted} volume=${num(frame.volume)} lead=${num(frame.startLeadMs)}/${num(frame.audibleBaseLeadMs)}/${num(frame.timelineLeadMs)} ${frame.platform}`;
        break;
      case MSG.YOUTUBE_ZERO_START_COMMIT:
        fields = `${run} start=${num(rel(frame.startAtHost))} ${frame.reason} cohort=${(frame.cohort as string[]).join(',')}`;
        break;
      case MSG.YOUTUBE_ZERO_START_ABORT:
        fields = `${run} ${frame.reason}`;
        break;
      case MSG.YOUTUBE_ZERO_START_TIMELINE:
        fields = `${run} host=${num(rel(frame.hostTime))} pos=${num(frame.positionSec)} state=${num(frame.playerState)}`;
        break;
      case MSG.YOUTUBE_SYNC:
        fields = `time=${num(frame.time)} state=${num(frame.state)}${frame.isManual ? ' manual' : ''} clock=${num(rel(frame.hostClock))}`;
        break;
      case MSG.YOUTUBE_STATE:
        fields = `state=${num(frame.state)} time=${num(frame.time)}${
          typeof frame.hostPlayAt === 'number'
            ? ` playAt=${frame.hostPlayAt > 0 ? num(rel(frame.hostPlayAt)) : '0'}`
            : ''
        } clock=${num(rel(frame.hostClock))}`;
        break;
      default:
        fields = '';
    }
    return `${at} ${via}:${to ?? '*'} ${type}${fields ? ` ${fields}` : ''}`;
  });
}

async function golden(scenario: StandardScenario): Promise<string[]> {
  const current = await startRig(scenario);
  await runStandardScenario(current, scenario);
  const all = [...current.preT0Sent, ...current.sent];
  return goldenLines(all, current.t0, runIdAliases(all));
}

/** What a guest sends before t0: the first advertisement and its readiness upgrade. */
const GUEST_CAPABILITIES = [
  '0 peer:host-1 youtube-zero-start-capability v2 other ready=false',
  '0 peer:host-1 youtube-zero-start-capability v2 other ready=true',
];
const GUEST_ARMED =
  '721 peer:host-1 youtube-zero-start-armed run-1 prepared=621 warm=0 pos=0 state=2 muted=false volume=100 lead=0/0/0 other';
/** The host's PREPARE after play at +100 (host instants relative to t0). */
const HOST_PREPARE =
  '100 peer:guest-1 youtube-zero-start-prepare run-1 seq=1 prepare=100 decision=2400 deadline=3100 host=other';

describe('Standard start wire and timing golden (pinned 2026-10-30)', () => {
  it('host all-ready release', async () => {
    expect(await golden(SCENARIOS.hostAllReady)).toEqual([
      // Before t0: the load's stop-all-media.
      '0 broadcast:* pause',
      HOST_PREPARE,
      '722 peer:guest-1 youtube-zero-start-commit run-1 start=1422 all-ready cohort=host-1,guest-1',
      ...[1672, 1922, 2172, 2422, 2672, 2922, 3172, 3422, 3672, 3922].map(
        (at, index) =>
          `${at} peer:guest-1 youtube-zero-start-timeline run-1 host=${at} pos=${(index + 1) * 0.25} state=1`,
      ),
      // No heartbeat at +3000 while the run owns sync (sync.ts:375). The run
      // releases ownership 2,750 ms after the release PLAYING (+4172), and the
      // next heartbeat tick follows the interval armed at t0.
      '6000 broadcast:* youtube-sync time=4.578 state=1 clock=6000',
      '9000 broadcast:* youtube-sync time=7.578 state=1 clock=9000',
    ]);
  });

  it('guest all-ready release', async () => {
    expect(await golden(SCENARIOS.guestAllReady)).toEqual([...GUEST_CAPABILITIES, GUEST_ARMED]);
  });

  it('guest cohort-excluded, released before startAtHost', async () => {
    // A guest that never arms sends nothing after its advertisements.
    expect(await golden(SCENARIOS.guestCohortExcluded(2_600))).toEqual(GUEST_CAPABILITIES);
  });

  it('guest cohort-excluded, released after startAtHost', async () => {
    expect(await golden(SCENARIOS.guestCohortExcluded(4_000))).toEqual(GUEST_CAPABILITIES);
  });

  it('guest clock uncalibrated', async () => {
    const scenario = SCENARIOS.guestClockUncalibrated((calibrated) => {
      clockUnderTest.calibrated = calibrated;
    });
    // The PREPARE's phase change re-advertises readiness, now false; no ARMED.
    expect(await golden(scenario)).toEqual([
      ...GUEST_CAPABILITIES,
      '100 peer:host-1 youtube-zero-start-capability v2 other ready=false',
    ]);
  });

  it('guest release-ack timeout', async () => {
    expect(await golden(SCENARIOS.guestReleaseAckTimeout)).toEqual([
      ...GUEST_CAPABILITIES,
      GUEST_ARMED,
    ]);
  });

  it('host prepare failure, legacy Stage-1 and Stage-2', async () => {
    expect(await golden(SCENARIOS.hostPrepareFailure)).toEqual([
      '0 broadcast:* pause',
      HOST_PREPARE,
      '430 peer:guest-1 youtube-zero-start-abort run-1 prepare-failed',
      // The iframe's own PLAYING broadcast, then Stage 1.
      '481 broadcast:* youtube-state state=1 time=0 clock=481',
      '481 broadcast:* youtube-state state=1 time=0 playAt=0 clock=481',
      // Stage 2 after TRACK_TRANSITION_RENDEZVOUS_MS, then the heartbeats.
      '4481 broadcast:* youtube-sync time=4 state=1 manual clock=4481',
      '6000 broadcast:* youtube-sync time=5.519 state=1 clock=6000',
      '9000 broadcast:* youtube-sync time=8.519 state=1 clock=9000',
    ]);
  });

  it('host peer replaced, 1.5 s replacement fallback', async () => {
    expect(await golden(SCENARIOS.hostPeerReplaced)).toEqual([
      '0 broadcast:* pause',
      HOST_PREPARE,
      '400 peer:guest-1 youtube-zero-start-abort run-1 authority-changed',
      '1951 broadcast:* youtube-state state=1 time=0 clock=1951',
      '1951 broadcast:* youtube-state state=1 time=0 playAt=0 clock=1951',
      '5951 broadcast:* youtube-sync time=4 state=1 manual clock=5951',
      // The heartbeat at +6000 falls within 500 ms of the manual Stage 2.
      '9000 broadcast:* youtube-sync time=7.049 state=1 clock=9000',
    ]);
  });
});

describe('Standard guest zero-start CAPABILITY timing (pinned 2026-10-30)', () => {
  /** A guest App with no rig: the test decides when the host link opens. */
  function guestApp(options: { role: 'guest' | 'idle'; open: boolean }) {
    const hostConn = syntheticConnection('cap-host-1');
    (hostConn as { open: boolean }).open = options.open;
    const t0 = Date.now();
    const recorder = recordSentFrames(
      SENDS(),
      () => t0,
      () => hostConn,
    );
    setState('network.appRole', options.role);
    setState('network.myId', 'cap-guest-1');
    setState('network.hostConn', hostConn);
    markQueueAuthorityReady(hostConn);
    resetInboundRateLimit(hostConn.peer);
    setState('setup.sessionStarted', true);
    setState('playlist.items', [
      {
        queueItemId: IDENTITY.queueItemId,
        type: 'youtube',
        name: 'Synthetic video',
        videoId: IDENTITY.videoId,
        playlistId: null,
      },
    ]);
    initPlayback();
    initYouTube();
    initYouTubeSync();
    initProtocol();
    const api = installScriptedIframeApi();
    const lines = () => goldenLines(recorder.frames, t0, new Map());
    const loadAndReady = () => {
      setState('playlist.currentQueueItemId', IDENTITY.queueItemId);
      bus.emit('youtube:load', IDENTITY.videoId, null, IDENTITY.queueItemId, false, 0);
      api.iframes.at(-1)!.ready();
    };
    return { hostConn, lines, loadAndReady };
  }

  it('advertises at network:peer-connected for the exact host connection, again when readiness changes, and never on a repeat', async () => {
    const app = guestApp({ role: 'guest', open: true });
    bus.emit('network:peer-connected', app.hostConn);
    await vi.advanceTimersByTimeAsync(100);
    app.loadAndReady();
    await vi.advanceTimersByTimeAsync(100);
    // Repeats with the same (host, platform, ready) send nothing.
    bus.emit('youtube:player-ready');
    bus.emit('sync:latency-update', 0);
    bus.emit('network:peer-connected', app.hostConn);
    await vi.advanceTimersByTimeAsync(100);
    expect(app.lines()).toEqual([
      '0 peer:cap-host-1 youtube-zero-start-capability v2 other ready=false',
      '100 peer:cap-host-1 youtube-zero-start-capability v2 other ready=true',
    ]);
  });

  it('defers the first advertisement while the role is not yet guest', async () => {
    const app = guestApp({ role: 'idle', open: true });
    bus.emit('network:peer-connected', app.hostConn);
    await vi.advanceTimersByTimeAsync(100);
    const atPeerConnected = app.lines();
    setState('network.appRole', 'guest');
    await vi.advanceTimersByTimeAsync(100);
    bus.emit('sync:latency-update', 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(atPeerConnected).toEqual([]);
    // The role change resets the controller, whose phase event advertises;
    // the reset then forgets that advertisement, so the next readiness event
    // repeats it.
    expect(app.lines()).toEqual([
      '100 peer:cap-host-1 youtube-zero-start-capability v2 other ready=false',
      '200 peer:cap-host-1 youtube-zero-start-capability v2 other ready=false',
    ]);
  });

  it('defers the first advertisement while the host connection is not open', async () => {
    const app = guestApp({ role: 'guest', open: false });
    bus.emit('network:peer-connected', app.hostConn);
    await vi.advanceTimersByTimeAsync(100);
    const atPeerConnected = app.lines();
    (app.hostConn as { open: boolean }).open = true;
    app.loadAndReady();
    await vi.advanceTimersByTimeAsync(100);
    expect(atPeerConnected).toEqual([]);
    expect(app.lines()).toEqual([
      '100 peer:cap-host-1 youtube-zero-start-capability v2 other ready=false',
      '100 peer:cap-host-1 youtube-zero-start-capability v2 other ready=true',
    ]);
  });
});

describe('Sync right after a zero-start release: no automatic retry (known-accepted #14, pinned 2026-10-30)', () => {
  it('answers not-ready while the run owns the player and no-data until a heartbeat, each with one toast', async () => {
    const current = await startRig(SCENARIOS.guestAllReady);
    await runStandardScenario(current, { ...SCENARIOS.guestAllReady, endAt: 2_000 });
    const toasts = () =>
      vi
        .mocked(showToast)
        .mock.calls.map(([message]) => message)
        .filter(
          (message) =>
            message === t('toast.sync_not_ready') || message === t('toast.yt_rendezvous_no_data'),
        );
    const results: string[] = [];
    results.push(`${current.now()} ${guestRendezvousSync().status}`);
    // The run releases ownership 2,750 ms after the release PLAYING (+1422).
    await current.advanceTo(4_300);
    results.push(`${current.now()} ${guestRendezvousSync().status}`);
    const opsFrom = current.iframe().__log.length;
    const framesFrom = current.sent.length;
    await current.advanceTo(4_300 + HEARTBEAT_INTERVAL_MS);
    const quietOps = opTrace(current.iframe(), current.t0, opsFrom);
    const quietFrames = current.sent.length - framesFrom;
    const quietToasts = toasts().length;
    // The host's next heartbeat arrives; the next press runs a rendezvous.
    current.deliver({
      type: MSG.YOUTUBE_SYNC,
      queueItemId: IDENTITY.queueItemId,
      videoId: IDENTITY.videoId,
      subIndex: -1,
      time: (current.now() - 1_422) / 1_000,
      state: 1,
      hostClock: Date.now(),
    });
    results.push(`${current.now()} ${guestRendezvousSync().status}`);
    expect(results).toEqual(['2000 not-ready', '4300 no-data', '7300 started']);
    expect(toasts()).toEqual([t('toast.sync_not_ready'), t('toast.yt_rendezvous_no_data')]);
    // Waiting adds no toast, op or frame: there is no automatic retry.
    expect({ quietOps, quietFrames, quietToasts }).toEqual({
      quietOps: [],
      quietFrames: 0,
      quietToasts: 2,
    });
  });
});

describe('Standard guest fallback deadlines (pinned 2026-10-30)', () => {
  // A cohort-excluded guest whose load was issued adopts the rest of the
  // 10 s prepare window: 7,700 ms from its fallback (+2401). Every other
  // fallback gets 3,000 ms (player.ts:2460-2466). Polls run every 50 ms.
  it.each([
    ['7.7 s', 'settled one poll before the deadline and released one poll after it', 9_949],
    ['7.7 s', 'abandoned at the deadline', 10_060],
  ] as const)('%s deadline: a late load %s', async (_deadline, _outcome, readyAfterMs) => {
    const current = await startRig(SCENARIOS.guestCohortExcluded(readyAfterMs));
    await runStandardScenario(current, {
      ...SCENARIOS.guestCohortExcluded(readyAfterMs),
      endAt: 13_000,
    });
    expect(opTrace(current.iframe(), current.t0).slice(4)).toEqual(
      DEADLINE_ROWS[`7.7 ${readyAfterMs}`],
    );
  });

  it.each([
    ['3 s', 'released one poll before the deadline', 5_340],
    ['3 s', 'abandoned at the deadline', 5_410],
  ] as const)('%s deadline: a late ready iframe %s', async (_deadline, _outcome, readyAt) => {
    const scenario = SCENARIOS.guestClockUncalibrated((calibrated) => {
      clockUnderTest.calibrated = calibrated;
    });
    const current = await startRig(scenario);
    await runStandardScenario(current, {
      ...scenario,
      steps: [
        ...scenario.steps,
        // The fallback starts at +2401; the iframe stops reporting a cueable
        // target until readyAt.
        { at: 2_402, run: (r) => r.iframe().__setState(-1, false) },
        { at: readyAt, run: (r) => r.iframe().__setState(2, false) },
      ],
      endAt: 8_000,
    });
    expect(opTrace(current.iframe(), current.t0).slice(8)).toEqual(DEADLINE_ROWS[`3 ${readyAt}`]);
  });
});

/** Ops from the controller's stop of the warm-up on (+2401), per deadline row. */
const DEADLINE_ROWS: Record<string, string[]> = {
  // Ready at +10050: the poll at +10052 settles it and +10102 releases at
  // the room position (7.002 s). The deadline (+10101) has passed by then,
  // but a ready, settled target still proceeds.
  '7.7 9949': [
    '+2401 pauseVideo()',
    '+10052 pauseVideo()',
    '+10052 seekTo(0,true)',
    '+10102 setVolume(100)',
    '+10102 unMute()',
    '+10102 pauseVideo()',
    '+10102 seekTo(7.002,true)',
    '+10102 setVolume(100)',
    '+10102 unMute()',
    '+10102 playVideo()',
  ],
  // Not ready at the +10102 poll: abandoned with one verified cleanup. The
  // load that lands at +10161 is paused back by the ordinary iframe path.
  '7.7 10060': [
    '+2401 pauseVideo()',
    '+10102 pauseVideo()',
    '+10102 seekTo(0,true)',
    '+10102 setVolume(100)',
    '+10102 unMute()',
    '+10161 pauseVideo()',
  ],
  // The uncalibrated fallback (deadline +5401) settled at +2402; ready again
  // at +5340, the poll at +5352 releases from 0:00.
  '3 5340': [
    '+2401 pauseVideo()',
    '+2402 pauseVideo()',
    '+2402 seekTo(0,true)',
    '+5352 setVolume(100)',
    '+5352 unMute()',
    '+5352 pauseVideo()',
    '+5352 seekTo(0,true)',
    '+5352 setVolume(100)',
    '+5352 unMute()',
    '+5352 playVideo()',
  ],
  '3 5410': [
    '+2401 pauseVideo()',
    '+2402 pauseVideo()',
    '+2402 seekTo(0,true)',
    '+5402 pauseVideo()',
    '+5402 seekTo(0,true)',
    '+5402 setVolume(100)',
    '+5402 unMute()',
  ],
};
