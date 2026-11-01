/**
 * @vitest-environment jsdom
 *
 * YouTube start-ownership truth table, PRO participant (pinned 2026-11-01):
 * the same columns and sample points as youtube-start-ownership-table.test.ts,
 * for the coordinator-free PRO arm and the PRO direct COMMIT wait.
 *
 * Real: initYouTube's wiring, youtube/iframe.ts's state dispatch and PRO
 * authority arm behind a scripted IFrame API, core/timers, and the
 * ProRoomPlaybackController with the playlist media endpoint (initPlaylist).
 * Fakes at the edges only: the iframe (fake-yt-player.ts), the network sends,
 * the shared clock and the PRO server clock (calibrated, reading Date.now()),
 * log and toasts. The setup is the C2-0 boundary suite's PRO participant: a
 * resident iframe ready and paused at 0:00. Instants are milliseconds after
 * that setup; PREPARE and COMMIT timing comes from the fixture's pinned copy
 * of the Worker's values (pro-endpoint-harness.ts).
 *
 * The PRO arm's own phase has no public query, so the zero-start phase column
 * reads 'idle' throughout; proMute is the arm's hard-mute ownership. A row
 * marked "Looks like a defect" pins today's behaviour, not claimed right.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { resetProStartObservations } from '../../diagnostics/pro-start-observations.ts';
import { initProtocol } from '../../network/protocol.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import { initPlayback } from '../../player/playback.ts';
import { initPlaylist } from '../../player/playlist.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';
import type { QueueItemId } from '../../types/index.ts';
import { cancelYouTubeAuthorityPreparation } from '../iframe.ts';
import { initYouTube, stopYouTubeMode } from '../player.ts';
import { resetYouTubeModuleState } from '../_state.ts';
import { resetYouTubeSyncState } from '../sync.ts';
import type { FakeYtPlayer } from './__helpers__/fake-yt-player.ts';
import { createProEndpointFixture } from './__helpers__/pro-endpoint-harness.ts';
import { installScriptedIframeApi, loadResidentIframe } from './__helpers__/scripted-iframe-api.ts';
import {
  probeStartOwnership,
  type StartOwnershipProbe,
} from './__helpers__/start-ownership-sampler.ts';
import { createFakeClockStarter } from './__helpers__/standard-start-harness.ts';

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
// A calibrated PRO server clock that reads this device's own time.
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

const PRO = createProEndpointFixture({
  roomCode: '000001',
  roomEpoch: 6,
  queueItemId: '61000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'ownTableP01',
  transitionId: `transition_${'d'.repeat(22)}`,
});
const SUPERSEDING_TRANSITION_ID = `transition_${'e'.repeat(22)}`;

let probe: StartOwnershipProbe | null = null;
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 10, 1, 0, 0, 0));

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
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
});

afterEach(() => {
  probe?.dispose();
  probe = null;
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

/** The C2-0 boundary suite's PRO participant, with a probe started at t0. */
async function setUpPro(
  options: { localOffsetSeconds?: number; iframeInit?: Partial<FakeYtPlayer> } = {},
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ title: 'Synthetic video' })),
  );
  initPlayback();
  initYouTube();
  initPlaylist();
  initProtocol();
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
  const api = installScriptedIframeApi(options.iframeInit ?? {});
  await loadResidentIframe(api, {
    queueItemId: PRO.identity.queueItemId,
    videoId: PRO.identity.videoId,
    positionSeconds: 0,
  });
  if (options.localOffsetSeconds) {
    setState('sync.youtubeLocalOffset', options.localOffsetSeconds);
  }
  const t0 = Date.now();
  const started = probeStartOwnership({ api, now: () => Date.now() - t0, isHost: false });
  probe = started;
  return { probe: started, participant: PRO.createParticipant() };
}

type ProSetup = Awaited<ReturnType<typeof setUpPro>>;

/** The participant shows the room playing (the projection only; the iframe stays paused). */
async function showRoomPlaying({ probe: started }: ProSetup): Promise<void> {
  await started.step('playing', () => setPlaybackYouTubePlaying());
}

/** PREPARE (zero-start) at t0, COMMIT for `transitionId` at +1000, then 3 s more. */
async function prepareAndCommit(
  { probe: started, participant }: ProSetup,
  transitionId?: string,
  beforeCommit: () => Promise<void> = async () => undefined,
): Promise<string[]> {
  await started.step('prepare', () =>
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start')),
  );
  await beforeCommit();
  await started.advanceTo(1_000);
  await started.step('commit', () =>
    participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'zero-start', transitionId)),
  );
  await started.advanceTo(4_000);
  return started.samples;
}

/** A second PREPARE for a new transition at +100. */
function supersedeAt100(setup: ProSetup): () => Promise<void> {
  return async () => {
    await setup.probe.advanceTo(100);
    await setup.probe.step('supersede', () =>
      setup.participant.controller.acceptPrepare(
        PRO.prepareEvent(1, 0, 'zero-start', SUPERSEDING_TRANSITION_ID),
      ),
    );
  };
}

/** PREPARE at t0, then cancelYouTubeAuthorityPreparation() at +100, then 1.9 s more. */
async function prepareThenCancel({ probe: started, participant }: ProSetup): Promise<string[]> {
  await started.step('prepare', () =>
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start')),
  );
  await started.advanceTo(100);
  await started.step('cancel', () => cancelYouTubeAuthorityPreparation());
  await started.advanceTo(2_000);
  return started.samples;
}

// ─── Expected lines (today's values) ───────────────────────────────

/** The PREPARE's arm starts one microtask chain after the step: muting through settling. */
const ARM_STARTS = (activity: string) => [
  `0 ready@micro idle ${activity}`,
  `0 loading:idle:-@micro idle ${activity}`,
  `0 micro idle proMute unMuteHeld ${activity}`,
];
/** The COMMIT's microtask chain at +1000 and the release 700 ms later. */
const COMMIT_AND_RELEASE = [
  '1000 ready@micro idle paused',
  '1000 loading:idle:-@micro idle paused',
  '1700 notify:1:after idle playing',
];
const P1_SAMPLES = [
  '0 rest idle paused',
  ...ARM_STARTS('paused'),
  // Audio restored at +500: the arm no longer owns hard mute.
  '500 rest idle paused',
  ...COMMIT_AND_RELEASE,
];
const P1P_SAMPLES = [
  '0 rest idle paused',
  '0 step:playing idle playing',
  ...ARM_STARTS('playing'),
  '500 rest idle playing',
  // READY at +620 leaves the prepared iframe paused, and the projection follows.
  '620 rest idle paused',
  ...COMMIT_AND_RELEASE,
];
const P2_SAMPLES = [
  '0 rest idle paused',
  ...ARM_STARTS('paused'),
  // The old arm drops its run before its own pauseVideo: inside that PAUSED,
  // proMute is already off, and nothing consumes it.
  '100 notify:2:before idle paused',
  '100 ready@micro idle paused',
  '100 loading:idle:-@micro idle paused',
  '100 micro idle proMute unMuteHeld paused',
  '600 rest idle paused',
  ...COMMIT_AND_RELEASE,
];
const P2P_SAMPLES = [
  '0 rest idle paused',
  '0 step:playing idle playing',
  ...ARM_STARTS('playing'),
  // The unconsumed PAUSED reaches the ordinary projection: 'paused' from
  // +100, where P1P turns 'paused' at READY (+620).
  '100 notify:2:before idle playing',
  '100 notify:2:after idle paused',
  '100 ready@micro idle paused',
  '100 loading:idle:-@micro idle paused',
  '100 micro idle proMute unMuteHeld paused',
  '600 rest idle paused',
  ...COMMIT_AND_RELEASE,
];
const P3_SAMPLES = [
  '0 rest idle paused',
  ...ARM_STARTS('paused'),
  '100 notify:2:before idle paused',
];
const P3P_SAMPLES = [
  '0 rest idle paused',
  '0 step:playing idle playing',
  ...ARM_STARTS('playing'),
  '100 notify:2:before idle playing',
  '100 notify:2:after idle paused',
];
const P4_SAMPLES = [
  '0 rest idle paused',
  '0 ready@micro idle paused',
  '0 loading:idle:-@micro idle paused',
  // Looks like a defect: no public owner covers the direct COMMIT's 2 s local
  // wait, so every column, the Sync and nudge owner gates' syncOwned included,
  // stays off while the iframe is held paused until +2700.
  '2700 notify:1:after idle playing',
];
const P5_SAMPLES = [
  '0 rest idle paused',
  ...ARM_STARTS('paused'),
  '100 step:pause idle proMute pauseGate unMuteHeld paused',
  '500 rest idle pauseGate paused',
  '1000 ready@micro idle pauseGate paused',
  '1000 loading:idle:-@micro idle pauseGate paused',
  // The release plays silently; only the settlement closes the gate.
  '1700 notify:1:after idle pauseGate playing',
  '2500 step:settle idle playing',
];
// P7 and P8 never reach 'playing', and that is intended: the arm reports READY
// only after a confirmed hard mute and a restored audio, so nothing is ever
// released. The COMMIT's catch-up prepares the committed checkpoint once more
// (a second proMute window) and fails the same way; the revision stays
// unapplied for a later heartbeat, outside these rows. Unlike row (b) of
// authority-arm.test.ts, whose release had already played unmuted, nothing
// plays audibly here, and the projection stays 'paused' throughout.
const P7_SAMPLES = [
  '0 rest idle paused',
  ...ARM_STARTS('paused'),
  // The hard mute never confirms: the arm gives up after its bounded polls and
  // drops its run before its own pauseVideo, as in P2.
  '330 notify:2:before idle paused',
  '1000 ready@micro idle paused',
  '1000 loading:idle:-@micro idle paused',
  '1010 rest idle proMute unMuteHeld paused',
  '1330 notify:2:before idle paused',
];
const P8_SAMPLES = [
  '0 rest idle paused',
  ...ARM_STARTS('paused'),
  // The audio restore starts at +500, as in P1, but every unMute is ignored:
  // the COMMIT at +1000 waits until the restore times out at +1460.
  '500 rest idle paused',
  '1460 ready@timer-micro idle paused',
  '1460 loading:idle:-@timer-micro idle paused',
  '1460 rest idle proMute unMuteHeld paused',
  '1970 rest idle paused',
];

describe('start-ownership table: PRO participant (pinned 2026-11-01)', () => {
  it('P1 PREPARE (zero-start) then COMMIT', async () => {
    expect(await prepareAndCommit(await setUpPro())).toEqual(P1_SAMPLES);
  });

  it('P1p the same while the participant shows the room playing', async () => {
    const setup = await setUpPro();
    await showRoomPlaying(setup);
    expect(await prepareAndCommit(setup)).toEqual(P1P_SAMPLES);
  });

  it('P2 a superseding PREPARE at +100', async () => {
    const setup = await setUpPro();
    expect(await prepareAndCommit(setup, SUPERSEDING_TRANSITION_ID, supersedeAt100(setup))).toEqual(
      P2_SAMPLES,
    );
  });

  it('P2p the same while the participant shows the room playing', async () => {
    const setup = await setUpPro();
    await showRoomPlaying(setup);
    expect(await prepareAndCommit(setup, SUPERSEDING_TRANSITION_ID, supersedeAt100(setup))).toEqual(
      P2P_SAMPLES,
    );
  });

  it('P3 cancelYouTubeAuthorityPreparation() at +100', async () => {
    expect(await prepareThenCancel(await setUpPro())).toEqual(P3_SAMPLES);
  });

  it('P3p the same while the participant shows the room playing', async () => {
    const setup = await setUpPro();
    await showRoomPlaying(setup);
    expect(await prepareThenCancel(setup)).toEqual(P3P_SAMPLES);
  });

  it('P4 a direct COMMIT held 2 s by a -2 s manual offset', async () => {
    const { probe: started, participant } = await setUpPro({ localOffsetSeconds: -2 });
    await started.step('commit', () =>
      participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'scheduled-control', null)),
    );
    await started.advanceTo(4_000);
    expect(started.samples).toEqual(P4_SAMPLES);
  });

  it('P5 a pause gate that opens during PREPARE and settles after the release', async () => {
    const { probe: started, participant } = await setUpPro();
    await started.step('prepare', () =>
      participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start')),
    );
    await started.advanceTo(100);
    await started.step('pause', () =>
      bus.emit('pro-playback:ui-control-pending', {
        token: 301,
        kind: 'pause',
        queueItemId: PRO.identity.queueItemId,
        targetSeconds: 0,
        wasPlaying: false,
      }),
    );
    await started.advanceTo(1_000);
    await started.step('commit', () =>
      participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'zero-start')),
    );
    await started.advanceTo(2_500);
    await started.step('settle', () =>
      bus.emit('pro-playback:ui-control-settled', {
        token: 301,
        kind: 'pause',
        queueItemId: PRO.identity.queueItemId,
        status: 'applied',
        positionSeconds: 0,
      }),
    );
    await started.advanceTo(3_000);
    expect(started.samples).toEqual(P5_SAMPLES);
  });

  it('P6 P1 with a synchronous BUFFERING then PAUSED inside every seek', async () => {
    const setup = await setUpPro({ iframeInit: { __seekStateSequence: [3, 2] } });
    expect(await prepareAndCommit(setup)).toEqual(P1_SAMPLES);
  });

  it('P7 a hard mute that never confirms', async () => {
    const setup = await setUpPro({ iframeInit: { __hardMuteFails: true } });
    expect(await prepareAndCommit(setup)).toEqual(P7_SAMPLES);
  });

  it('P8 every unMute ignored', async () => {
    const setup = await setUpPro({ iframeInit: { __unMuteIgnoreCount: 1_000 } });
    expect(await prepareAndCommit(setup)).toEqual(P8_SAMPLES);
  });
});

describe('start-ownership table: PRO coverage (pinned 2026-11-01)', () => {
  it('shows the PRO-only columns both on and off', () => {
    const parsed = [
      P1_SAMPLES,
      P1P_SAMPLES,
      P2_SAMPLES,
      P2P_SAMPLES,
      P3_SAMPLES,
      P3P_SAMPLES,
      P4_SAMPLES,
      P5_SAMPLES,
      P7_SAMPLES,
      P8_SAMPLES,
    ]
      .flat()
      .map((line) => line.split(' ').slice(3, -1));
    const proColumns = ['proMute', 'pauseGate', 'unMuteHeld'];
    expect(proColumns.filter((token) => parsed.some((tokens) => tokens.includes(token)))).toEqual(
      proColumns,
    );
    expect(proColumns.filter((token) => parsed.some((tokens) => !tokens.includes(token)))).toEqual(
      proColumns,
    );
    // No Standard owner column turns on in a PRO room.
    expect([...new Set(parsed.flat())].sort()).toEqual(['pauseGate', 'proMute', 'unMuteHeld']);
  });
});
