/**
 * @vitest-environment jsdom
 *
 * Visibility anchors for the YouTube resource owners (pinned 2026-10-30):
 * one hidden-page row for each record whose registry entry said
 * "Visibility: missing" (RO-02, RO-03, RO-12, RO-13, RO-14). Each row runs
 * the owner with the page hidden part-way (document.visibilityState and
 * document.hidden through configurable getters, then visibilitychange) and
 * compares it with the same run on a visible page. Where an owner has no
 * visibility branch, the row pins that hiding changes nothing.
 *
 * Real: initYouTube's wiring, the iframe module behind a scripted IFrame
 * API, core/timers, the protocol dispatcher, the zero-start controller, the
 * Standard host manual-offset runtime, and for PRO the
 * ProRoomPlaybackController with the playlist media endpoint. Fakes: the
 * iframe, the Standard remote participant (the real zero-start controller
 * on its own fake iframe), a calibrated shared clock and PRO server clock,
 * the network sends, log and toasts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import {
  getProStartObservations,
  resetProStartObservations,
} from '../../diagnostics/pro-start-observations.ts';
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
import { resetYouTubeModuleState, setYtPrimed } from '../_state.ts';
import {
  prepareStandardHostManualOffsetRuntimeForTests,
  resetStandardHostManualOffsetTransaction,
} from '../standard-host-manual-offset-gate.ts';
import { resetYouTubeSyncState } from '../sync.ts';
import { createProEndpointFixture } from './__helpers__/pro-endpoint-harness.ts';
import { installScriptedIframeApi, loadResidentIframe } from './__helpers__/scripted-iframe-api.ts';
import {
  createFakeClockStarter,
  frameRoutes,
  opTrace,
  runStandardScenario,
  setUpStandardRig,
  standardScenarios,
  type StandardRig,
  type StandardRigOptions,
  type StandardScenario,
} from './__helpers__/standard-start-harness.ts';

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
  queueItemId: '72000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'visibilityA',
  nextQueueItemId: '72000000-0000-4000-8000-000000000002' as QueueItemId,
  nextVideoId: 'visibilityB',
};
const SCENARIOS = standardScenarios(STANDARD);
const PRO = createProEndpointFixture({
  roomCode: '000001',
  roomEpoch: 6,
  queueItemId: '63000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'visibilityP',
  transitionId: `transition_${'v'.repeat(22)}`,
});
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 9, 30, 0, 0, 0));
let rig: StandardRig | null = null;

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
}

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
  // Restore the prototype getters (visible) without a visibilitychange.
  Reflect.deleteProperty(document, 'visibilityState');
  Reflect.deleteProperty(document, 'hidden');
  PRO.resetControllers();
  resetProPlaybackAuthorityHooks();
  registerProPlaybackMediaEndpoint(null);
  cancelYouTubeAuthorityPreparation();
  stopYouTubeMode({ silent: true });
  resetStandardHostManualOffsetTransaction();
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

async function standardHost(extra: Partial<StandardRigOptions> = {}) {
  rig = await setUpStandardRig({
    role: 'host',
    sends: {
      broadcast: vi.mocked(broadcast),
      safeSend: vi.mocked(safeSend),
      sendToHost: vi.mocked(sendToHost),
    },
    roomCode: '100001',
    ...STANDARD,
    hostPeerId: 'host-1',
    guestPeerId: 'guest-1',
    ...extra,
  });
  return rig;
}

/** Run a Standard scenario, hiding the page at hideAt when given. */
async function standardRun(scenario: StandardScenario, hideAt: number | null) {
  const current = await standardHost(scenario.rig ?? {});
  const marks = await runStandardScenario(current, {
    ...scenario,
    steps: [
      ...scenario.steps,
      ...(hideAt === null ? [] : [{ at: hideAt, run: () => setVisibility('hidden') }]),
    ],
  });
  const result = {
    ops: opTrace(current.iframe(), current.t0),
    routes: frameRoutes(current.sent),
    marks,
  };
  rig?.dispose();
  rig = null;
  return result;
}

describe('visibility anchors (pinned 2026-10-30)', () => {
  it('RO-02: a Standard zero-start hidden mid-warm-up runs exactly as the visible one', async () => {
    const visible = await standardRun(SCENARIOS.hostAllReady, null);
    stopYouTubeMode({ silent: true });
    clearAllManagedTimers();
    bus.clear();
    resetState();
    resetYouTubeModuleState();
    resetYouTubeSyncState();
    document.body.innerHTML =
      '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
    const hidden = await standardRun(SCENARIOS.hostAllReady, 200);
    // Zero-start has no visibility branch: ops, frames and release match.
    expect(hidden).toEqual(visible);
    expect(hidden.ops.at(-2)).toBe('+1422 playVideo()');
  });

  it('RO-03: a PRO release whose lead samples fall while hidden records them as hidden and learns nothing', async () => {
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
    // The release plays at +700 from the COMMIT; hide before the 0.8 s sample.
    await vi.advanceTimersByTimeAsync(1_000);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(2_000);
    const pick = (kind: string, keys: readonly string[]) =>
      getProStartObservations()
        .filter((entry) => entry.kind === kind)
        .map(({ detail }) =>
          Object.fromEntries(keys.map((key) => [key, (detail as Record<string, unknown>)[key]])),
        );
    expect(pick('youtube-sample', ['checkpointMs', 'visible', 'eligible', 'reason'])).toEqual([
      { checkpointMs: 800, visible: false, eligible: false, reason: 'hidden' },
      { checkpointMs: 2000, visible: false, eligible: false, reason: 'hidden' },
    ]);
    // Neither sample is eligible, so the learner keeps its 0 ms lead.
    expect(
      pick('youtube-learning', ['learningEnabled', 'accepted', 'updated', 'nextTimelineLeadMs']),
    ).toEqual([{ learningEnabled: true, accepted: false, updated: false, nextTimelineLeadMs: 0 }]);
  });

  it.each(['visible', 'hidden'] as const)(
    'RO-12: a youtube:set-volume write and a PRO pause-gate settlement write the same audio while %s',
    async (visibility) => {
      const current = await standardHost();
      await current.advanceTo(100);
      if (visibility === 'hidden') setVisibility('hidden');
      const from = current.iframe().__log.length;
      bus.emit('youtube:set-volume', 40);
      bus.emit('pro-playback:ui-control-pending', {
        token: 601,
        kind: 'pause',
        queueItemId: STANDARD.queueItemId,
        targetSeconds: 0,
        wasPlaying: false,
      });
      bus.emit('pro-playback:ui-control-settled', {
        token: 601,
        kind: 'pause',
        queueItemId: STANDARD.queueItemId,
        status: 'applied',
        positionSeconds: 0,
      });
      expect(opTrace(current.iframe(), current.t0, from)).toEqual([
        '+100 setVolume(40)',
        '+100 unMute()',
        '+100 mute()',
        '+100 setVolume(100)',
        '+100 unMute()',
      ]);
    },
  );

  it.each(['visible', 'hidden'] as const)(
    'RO-13: a Standard host manual-offset transaction issues the same commands while %s',
    async (visibility) => {
      await prepareStandardHostManualOffsetRuntimeForTests();
      const current = await standardHost();
      await current.advanceTo(100);
      bus.emit('youtube:toggle-play');
      // Past the zero-start release and its calibration window.
      await current.advanceTo(5_000);
      if (visibility === 'hidden') setVisibility('hidden');
      const from = current.iframe().__log.length;
      const frameFrom = current.sent.length;
      bus.emit('youtube:set-coordinator-manual-offset', 2, 'committed');
      await current.advanceTo(8_000);
      expect({
        ops: opTrace(current.iframe(), current.t0, from),
        routes: frameRoutes(current.sent.slice(frameFrom)),
      }).toEqual(RO13_EXPECTED);
    },
  );

  it.each(['visible', 'hidden'] as const)(
    'RO-14: stopYouTubeMode parks a primed iframe the same way while %s',
    async (visibility) => {
      const current = await standardHost();
      setYtPrimed(true);
      await current.advanceTo(100);
      if (visibility === 'hidden') setVisibility('hidden');
      const from = current.iframe().__log.length;
      stopYouTubeMode();
      expect(opTrace(current.iframe(), current.t0, from)).toEqual([
        '+100 mute()',
        '+100 pauseVideo()',
        '+100 cueVideoById(r7M_P0FAOtw,0)',
      ]);
    },
  );
});

/** A +2 s manual offset on a host playing at 3.578 s (room time), visible or hidden alike. */
const RO13_EXPECTED = {
  ops: [
    '+5000 cueVideoById(visibilityA,3.578)',
    '+7000 loadVideoById(visibilityA,5.578)',
    '+7000 playVideo()',
  ],
  routes: [],
};
