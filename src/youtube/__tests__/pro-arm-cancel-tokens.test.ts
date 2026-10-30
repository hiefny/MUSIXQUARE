/**
 * @vitest-environment jsdom
 *
 * PRO arm tokens and prime pins (pinned 2026-10-30), tests first for the
 * Phase 6 increments that give the PRO arm its own tokens (6D-4) and the
 * shared arm steps (6C).
 *
 * Real: the ProRoomPlaybackController, the playlist media endpoint
 * (initPlaylist), player.ts's applyProPlaybackYouTubeCommit, the iframe
 * module and its PRO authority arm behind a scripted IFrame API, and
 * core/timers. Fakes: the iframe (fake-yt-player.ts, with its fault knobs),
 * a calibrated PRO server clock reading Date.now(), the network sends, log
 * and toasts. The platform is the App's own detection (core/platform.ts)
 * with IS_IOS switchable per row.
 *
 * Already pinned elsewhere, not repeated here: a prepared COMMIT after a
 * local pause is handled ("records a locally paused prepared commit as
 * applied in the actual PRO controller without a fallback retry",
 * pro-manual-zero-start.test.ts).
 *
 * A row marked "Looks like a defect" pins today's behaviour, not claimed right.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import {
  getProStartObservations,
  resetProStartObservations,
} from '../../diagnostics/pro-start-observations.ts';
import { initPlayback } from '../../player/playback.ts';
import { initPlaylist } from '../../player/playlist.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';
import type { QueueItemId } from '../../types/index.ts';
import { cancelYouTubeAuthorityPreparation } from '../iframe.ts';
import { initYouTube, stopYouTubeMode } from '../player.ts';
import { isYtPrimed, resetYouTubeModuleState, setYtPrimed } from '../_state.ts';
import { resetYouTubeSyncState } from '../sync.ts';
import type { FakeYtPlayer } from './__helpers__/fake-yt-player.ts';
import { createProEndpointFixture } from './__helpers__/pro-endpoint-harness.ts';
import { installScriptedIframeApi, loadResidentIframe } from './__helpers__/scripted-iframe-api.ts';
import { createFakeClockStarter, opTrace } from './__helpers__/standard-start-harness.ts';

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
  videoId: 'proTokensA1',
  transitionId: `transition_${'t'.repeat(22)}`,
});
const SECOND_TRANSITION_ID = `transition_${'u'.repeat(22)}`;
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 9, 30, 0, 0, 0));

beforeEach(() => {
  platformUnderTest.ios = false;
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
  delete window.onYouTubeIframeAPIReady;
});

async function setUpPro(): Promise<{ fake: FakeYtPlayer; from: number; t0: number }> {
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
  const fake = await loadResidentIframe(api, {
    queueItemId: PRO.identity.queueItemId,
    videoId: PRO.identity.videoId,
    positionSeconds: 0,
  });
  return { fake, from: fake.__log.length, t0: Date.now() };
}

function observations(kind: 'youtube-release' | 'youtube-sample', keys: readonly string[]) {
  return getProStartObservations()
    .filter((entry) => entry.kind === kind)
    .map(({ detail }) =>
      Object.fromEntries(keys.map((key) => [key, (detail as Record<string, unknown>)[key]])),
    );
}

describe('PRO arm tokens (pinned 2026-10-30)', () => {
  it('applies a direct play COMMIT that follows a prepare cancel, rather than consuming it', async () => {
    const { fake, from, t0 } = await setUpPro();
    const participant = PRO.createParticipant();
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(200);
    // The server cancels the transition mid-warm-up.
    participant.controller.acceptCancel(PRO.identity.transitionId);
    await vi.advanceTimersByTimeAsync(300);
    // A direct COMMIT (transitionId null) then plays the same occurrence.
    participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'scheduled-control', null));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(opTrace(fake, t0, from)).toEqual([
      '+0 mute()',
      '+0 setVolume(100)',
      '+0 mute()',
      '+0 pauseVideo()',
      '+0 seekTo(0,true)',
      '+0 playVideo()',
      // The cancel stops the warm-up and restores audio.
      '+200 pauseVideo()',
      '+200 setVolume(100)',
      '+200 unMute()',
      // The direct COMMIT (received at +500) plays at its executeAt. Its own
      // cancel (player.ts:1315) does not move the local-pause generation it
      // captured (:1150), so the frame is applied, not consumed.
      '+1200 seekTo(0,true)',
      '+1200 setVolume(100)',
      '+1200 unMute()',
      '+1200 playVideo()',
    ]);
    expect(observations('youtube-release', ['path', 'timingMode'])).toEqual([
      { path: 'direct', timingMode: 'scheduled-control' },
    ]);
  });

  it('keeps only the first, synchronous attempt of the detached restore that cancelAll started', async () => {
    const { fake, from, t0 } = await setUpPro();
    const participant = PRO.createParticipant();
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(100);
    // WebKit ignores the next unmute: the first restore attempt fails.
    fake.__unMuteIgnoreCount = 1;
    cancelYouTubeAuthorityPreparation();
    await vi.advanceTimersByTimeAsync(1_000);
    // cancel() makes one synchronous restore attempt (authority-arm.ts:496-501);
    // cancelAll then revokes its retries (:519-525), so the ignored unMute is
    // never retried at +220 and the iframe stays hard-muted.
    expect(opTrace(fake, t0, from)).toEqual([
      '+0 mute()',
      '+0 setVolume(100)',
      '+0 mute()',
      '+0 pauseVideo()',
      '+0 seekTo(0,true)',
      '+0 playVideo()',
      '+100 pauseVideo()',
      '+100 setVolume(100)',
      '+100 unMute()',
    ]);
    expect(fake.isMuted()).toBe(true);
  });

  it('does not learn a lead sample whose preparation generation moved before its checkpoint', async () => {
    await setUpPro();
    const participant = PRO.createParticipant();
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(1_000);
    participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'zero-start'));
    // The release plays at +1700; its first lead sample is due at +2500.
    await vi.advanceTimersByTimeAsync(1_000);
    cancelYouTubeAuthorityPreparation();
    await vi.advanceTimersByTimeAsync(2_000);
    // player.ts:968 compares the preparation generation captured at release.
    expect(
      observations('youtube-sample', [
        'checkpointMs',
        'identityMatches',
        'reason',
        'eligible',
        'learningEnabled',
      ]),
    ).toEqual([
      {
        checkpointMs: 800,
        identityMatches: false,
        reason: 'identity-mismatch',
        eligible: false,
        learningEnabled: true,
      },
      {
        checkpointMs: 2000,
        identityMatches: false,
        reason: 'identity-mismatch',
        eligible: false,
        learningEnabled: true,
      },
    ]);
  });
});

describe('PRO prime on iOS (pinned 2026-10-30)', () => {
  it('keeps an iframe unlocked only by the tap gate un-primed through PREPARE; the release PLAYING primes it', async () => {
    platformUnderTest.ios = true;
    const { fake, from, t0 } = await setUpPro();
    const participant = PRO.createParticipant();
    const primed: string[] = [`${Date.now() - t0} ${isYtPrimed()}`];
    // The first PREPARE finds a never-primed iOS iframe and asks for the tap.
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(100);
    const overlay = document.getElementById('youtube-ios-sync-overlay');
    primed.push(`overlay ${overlay !== null}`);
    overlay?.click();
    primed.push(`${Date.now() - t0} after tap ${isYtPrimed()}`);
    // Model WebKit not delivering the tap's PLAYING: only the tap gate's
    // unlock record remains.
    setYtPrimed(false);
    await vi.advanceTimersByTimeAsync(3_000);
    const prepareAt = Date.now() - t0;
    participant.controller.acceptPrepare(
      PRO.prepareEvent(1, 0, 'zero-start', SECOND_TRANSITION_ID),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    primed.push(`${Date.now() - t0} prepared ${isYtPrimed()}`);
    participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'zero-start', SECOND_TRANSITION_ID));
    await vi.advanceTimersByTimeAsync(1_000);
    primed.push(`${Date.now() - t0} released ${isYtPrimed()}`);
    expect(prepareAt).toBe(3_100);
    expect(primed).toEqual([
      '0 false',
      'overlay true',
      // The tap's own PLAYING primes the iframe (iframe.ts:3154).
      '100 after tap true',
      // The arm's warm PLAYING is consumed at iframe.ts:3116, so the primed
      // write is never reached while it prepares.
      '4100 prepared false',
      // The release PLAYING goes on to the ordinary path and primes it.
      '5100 released true',
    ]);
    expect(opTrace(fake, t0, from)).toEqual([
      '+100 playVideo()',
      '+100 pauseVideo()',
      '+3100 mute()',
      '+3100 setVolume(100)',
      '+3100 mute()',
      '+3100 pauseVideo()',
      '+3100 seekTo(0,true)',
      '+3100 playVideo()',
      '+3360 pauseVideo()',
      '+3440 seekTo(0,true)',
      '+3600 setVolume(100)',
      '+3600 unMute()',
      '+4800 playVideo()',
    ]);
    expect(
      participant.reportReady.mock.calls.map(([report]) => (report as { status: string }).status),
    ).toEqual(['failed', 'ready']);
    expect(observations('youtube-release', ['path', 'timingMode'])).toEqual([
      { path: 'prepared', timingMode: 'zero-start' },
    ]);
  });
});
