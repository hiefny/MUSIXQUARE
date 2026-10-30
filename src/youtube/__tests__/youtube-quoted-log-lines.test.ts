/**
 * @vitest-environment jsdom
 *
 * Quoted YouTube start log lines, frozen (pinned 2026-10-30). The release
 * record and the device check read these lines, so a later move of the code
 * that writes them must keep the exact first argument; detail objects are
 * checked only by their named keys.
 *
 * Each line is reached through the named Standard scenario scripts
 * (standard-start-harness.ts) or the PRO controller, with core/log.ts mocked.
 * The second 'Local fallback failed:' site (player.ts:2764) needs the managed
 * timer API itself to throw, so core/timers.ts is a pass-through mock here
 * that throws only for the one timer a row names.
 *
 * The four '[YouTube Prime]' warns run on paths the suites that already
 * drive them set up (an iOS platform, the prime player, an IFrame API onError,
 * the gesture submit), so their exact first arguments are asserted there
 * (pinned 2026-10-31):
 * - iframe.ts 'API load failed; tap-to-play fallback remains available':
 *   stale-async-guards.test.ts "releases a failed API preparation at the
 *   deadline without claiming readiness or retrying it".
 * - iframe.ts 'gesture bounce failed; tap-to-play fallback remains
 *   available': stale-async-guards.test.ts "re-arms a synchronous bounce
 *   failure for a later direct gesture".
 * - iframe.ts 'player error during prime; tap-to-play fallback remains':
 *   stale-async-guards.test.ts "keeps an iframe-reported bounce error
 *   retryable and silent".
 * - ui/player-controls.ts 'Submit flow failed': player-controls.test.ts
 *   "logs '[YouTube Prime] Submit flow failed' when the gesture submit throws
 *   after the prime wait".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { log } from '../../core/log.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { resetProStartObservations } from '../../diagnostics/pro-start-observations.ts';
import { broadcast, safeSend, sendToHost } from '../../network/peer.ts';
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
import { createProEndpointFixture } from './__helpers__/pro-endpoint-harness.ts';
import { installScriptedIframeApi, loadResidentIframe } from './__helpers__/scripted-iframe-api.ts';
import {
  createFakeClockStarter,
  makeReleaseStall,
  runStandardScenario,
  setUpStandardRig,
  standardScenarios,
  type StandardRig,
  type StandardRigOptions,
  type StandardScenario,
} from './__helpers__/standard-start-harness.ts';

const timerFault = vi.hoisted(() => ({ failName: null as string | null }));
vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Real managed timers, except that scheduling the one timer a row names throws.
vi.mock('../../core/timers.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/timers.ts')>();
  return {
    ...actual,
    setManagedTimer: (...args: Parameters<typeof actual.setManagedTimer>) => {
      if (args[0] === timerFault.failName) throw new Error('synthetic managed-timer failure');
      return actual.setManagedTimer(...args);
    },
  };
});
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
  queueItemId: '75000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'logLinesA01',
  nextQueueItemId: '75000000-0000-4000-8000-000000000002' as QueueItemId,
  nextVideoId: 'logLinesB02',
};
const SCENARIOS = standardScenarios(STANDARD);
const PRO = createProEndpointFixture({
  roomCode: '000001',
  roomEpoch: 6,
  queueItemId: '66000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'logLinesP01',
  transitionId: `transition_${'l'.repeat(22)}`,
});
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 9, 30, 0, 0, 0));
let rig: StandardRig | null = null;

beforeEach(() => {
  timerFault.failName = null;
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

async function runScenario(scenario: StandardScenario, extra: Partial<StandardRigOptions> = {}) {
  rig = await setUpStandardRig({
    role: scenario.role,
    sends: {
      broadcast: vi.mocked(broadcast),
      safeSend: vi.mocked(safeSend),
      sendToHost: vi.mocked(sendToHost),
    },
    roomCode: '100001',
    ...STANDARD,
    hostPeerId: 'host-1',
    guestPeerId: 'guest-1',
    ...scenario.rig,
    ...extra,
  });
  await runStandardScenario(rig, scenario);
  return rig;
}

/** Every first argument logged at this level, in order (YouTube lines only). */
function lines(level: 'debug' | 'warn'): string[] {
  return vi
    .mocked(log[level])
    .mock.calls.map(([message]) => String(message))
    .filter((message) => message.startsWith('[YouTube') || message.startsWith('[PRO YouTube]'));
}

/** The keys of the detail object logged with this exact line. */
function detailKeys(level: 'debug' | 'warn', line: string): string[] {
  const call = vi.mocked(log[level]).mock.calls.find(([message]) => message === line);
  if (!call) throw new Error(`no ${level} line ${line}`);
  return Object.keys((call[1] ?? {}) as Record<string, unknown>).sort();
}

describe('quoted YouTube start log lines (pinned 2026-10-30)', () => {
  it("'[PRO YouTube] Zero-start playback released' (player.ts:1278)", async () => {
    initPlayback();
    initYouTube();
    initPlaylist();
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
    setState('playlist.items', [
      {
        queueItemId: PRO.identity.queueItemId,
        type: 'youtube',
        name: 'Synthetic video',
        videoId: PRO.identity.videoId,
        playlistId: null,
      },
    ]);
    const api = installScriptedIframeApi();
    await loadResidentIframe(api, {
      queueItemId: PRO.identity.queueItemId,
      videoId: PRO.identity.videoId,
      positionSeconds: 0,
    });
    const participant = PRO.createParticipant();
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(1_000);
    participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines('debug')).toContain('[PRO YouTube] Zero-start playback released');
    expect(detailKeys('debug', '[PRO YouTube] Zero-start playback released')).toEqual(
      expect.arrayContaining(['platform', 'canonicalExecuteAtMs', 'status', 'playCallAtMs']),
    );
  });

  it("host all-ready: '[YouTube ZeroStart] Playback released', prepare-host and armed-guest", async () => {
    await runScenario(SCENARIOS.hostAllReady);
    expect(lines('debug')).toEqual(
      expect.arrayContaining([
        '[YouTube ZeroStart] prepare-host',
        '[YouTube ZeroStart] armed-guest',
        '[YouTube ZeroStart] Playback released',
      ]),
    );
    expect(detailKeys('debug', '[YouTube ZeroStart] Playback released')).toEqual(
      expect.arrayContaining(['role', 'platform', 'releaseLeadMs', 'runId']),
    );
  });

  it('guest all-ready: timeline-0.8s and timeline-2.0s with their drift keys', async () => {
    await runScenario(SCENARIOS.guestAllReady);
    expect(lines('debug')).toEqual(
      expect.arrayContaining([
        '[YouTube ZeroStart] timeline-0.8s',
        '[YouTube ZeroStart] timeline-2.0s',
      ]),
    );
    for (const line of ['[YouTube ZeroStart] timeline-0.8s', '[YouTube ZeroStart] timeline-2.0s']) {
      expect(detailKeys('debug', line)).toEqual(['estimatedAudibleErrorMs', 'timelineDriftMs']);
    }
  });

  it("host prepare failure: the reason warn, prepare-failed, cancel and 'Falling back to legacy rendezvous: <reason>'", async () => {
    await runScenario(SCENARIOS.hostPrepareFailure);
    expect(lines('warn')).toEqual(
      expect.arrayContaining([
        '[YouTube ZeroStart] hard-mute-timeout',
        '[YouTube ZeroStart] Falling back to legacy rendezvous: hard-mute-timeout',
      ]),
    );
    expect(lines('debug')).toEqual(
      expect.arrayContaining(['[YouTube ZeroStart] prepare-failed', '[YouTube ZeroStart] cancel']),
    );
  });

  it("peer replaced: cancel and audio-restore-complete; with every unMute ignored, the 'audio-restore-timeout' warn", async () => {
    await runScenario(SCENARIOS.hostPeerReplaced);
    expect(lines('debug')).toEqual(
      expect.arrayContaining([
        '[YouTube ZeroStart] cancel',
        '[YouTube ZeroStart] audio-restore-complete',
      ]),
    );
    vi.mocked(log.warn).mockClear();
    rig?.dispose();
    stopYouTubeMode({ silent: true });
    clearAllManagedTimers();
    bus.clear();
    resetState();
    resetYouTubeModuleState();
    document.body.innerHTML =
      '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
    await runScenario(SCENARIOS.hostPeerReplaced, { iframeInit: { __unMuteIgnoreCount: 1_000 } });
    expect(lines('warn')).toContain('[YouTube ZeroStart] audio-restore-timeout');
  });

  it("cohort-excluded guest: 'Falling back locally: <reason>' and 'Recovered locally: <reason>'", async () => {
    await runScenario(SCENARIOS.guestCohortExcluded(2_600));
    expect(lines('warn')).toEqual([
      '[YouTube ZeroStart] Falling back locally: cohort-excluded',
      '[YouTube ZeroStart] Recovered locally: cohort-excluded',
    ]);
  });

  it('guest release-ack timeout: the reason warn and the release-timeout fallback lines', async () => {
    await runScenario(SCENARIOS.guestReleaseAckTimeout);
    expect(lines('warn')).toEqual([
      '[YouTube ZeroStart] release-ack-timeout',
      '[YouTube ZeroStart] Falling back locally: release-timeout',
      '[YouTube ZeroStart] Recovered locally: release-timeout',
    ]);
  });

  it("guest fallback release without PLAYING: 'Local fallback release was not acknowledged'", async () => {
    const scenario = SCENARIOS.guestCohortExcluded(2_600);
    await runScenario({
      ...scenario,
      prepare: (r) => {
        scenario.prepare?.(r);
        // The fallback's release (+3100) is the iframe's first playVideo.
        makeReleaseStall(r.iframe(), 1);
      },
    });
    expect(lines('warn')).toContain(
      '[YouTube ZeroStart] Local fallback release was not acknowledged',
    );
  });

  it("guest fallback release that throws: 'Local fallback release failed:'", async () => {
    const scenario = SCENARIOS.guestCohortExcluded(2_600);
    await runScenario({
      ...scenario,
      prepare: (r) => {
        scenario.prepare?.(r);
        r.iframe().playVideo = () => {
          throw new Error('synthetic play failure');
        };
      },
    });
    expect(lines('warn')).toContain('[YouTube ZeroStart] Local fallback release failed:');
  });

  it("guest fallback whose restore keeps throwing past its deadline: 'Local fallback failed:' (player.ts:2752)", async () => {
    const scenario = SCENARIOS.guestCohortExcluded(2_600);
    await runScenario({
      ...scenario,
      steps: [
        ...scenario.steps,
        { at: 3_095, run: (r) => (r.iframe().__volumeReadFault = 'throw') },
      ],
    });
    expect(lines('warn')).toContain('[YouTube ZeroStart] Local fallback failed:');
  });

  it("guest fallback that cannot schedule its first attempt: 'Local fallback failed:' (player.ts:2764, pinned 2026-10-31)", async () => {
    const scenario = SCENARIOS.guestCohortExcluded(2_600);
    await runScenario({
      ...scenario,
      steps: [
        ...scenario.steps,
        // The fallback starts at +2401; from +2300 its timer cannot be scheduled.
        {
          at: 2_300,
          run: () => {
            timerFault.failName = 'yt-zero-start-external-fallback';
          },
        },
      ],
    });
    expect(lines('warn')).toEqual([
      '[YouTube ZeroStart] Falling back locally: cohort-excluded',
      '[YouTube ZeroStart] Local fallback failed:',
    ]);
  });

  it("host legacy recovery that times out: '[YouTube ZeroStart] Legacy recovery timed out:'", async () => {
    await runScenario(
      { ...SCENARIOS.hostAllReady, endAt: 6_000 },
      {
        iframeInit: { __unMuteIgnoreCount: 1_000 },
      },
    );
    expect(lines('warn')).toEqual(
      expect.arrayContaining([
        '[YouTube ZeroStart] audio-restore-timeout',
        '[YouTube ZeroStart] Legacy recovery timed out:',
      ]),
    );
  });

  it("a guest whose iframe is not ready at PREPARE: 'waiting-ready'", async () => {
    await runScenario({
      ...SCENARIOS.guestAllReady,
      steps: [{ at: 50, run: () => stopYouTubeMode() }, ...SCENARIOS.guestAllReady.steps],
      endAt: 3_500,
    });
    expect(lines('debug')).toContain('[YouTube ZeroStart] waiting-ready');
  });
});
