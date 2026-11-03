/**
 * @vitest-environment jsdom
 *
 * The PRO start tokens stay apart (Phase 6 6D-4, plan step C2-13), tests
 * first. Four tokens count four different events, and each revokes only what
 * its own event must:
 * - the preparation token (iframe.ts's preparation generation): every
 *   prepare of an occurrence and every preparation cancel move it; its own
 *   prepare loop and a release's lead samples compare it;
 * - the COMMIT token (player.ts's COMMIT generation): a newer COMMIT and
 *   teardown move it; a waiting COMMIT and a release's lead samples compare
 *   it;
 * - the local-pause token (player.ts's local-pause generation): only a
 *   participant-local PRO pause moves it. It records that pause and fences
 *   nothing: a waiting COMMIT that finds it moved reports itself handled
 *   without starting audio, so the PRO controller does not undo the pause;
 * - the pause gate's token (iframe-audio.ts): a participant-local pause
 *   proposal holds the gate until its own settlement, and teardown drops it.
 *
 * Each row holds the gate, starts a direct PRO COMMIT that waits 700 ms for
 * its executeAt, and lets one event happen 200 ms later. It reads the
 * preparation token through iframe.ts's getter, the gate through
 * iframe-audio.ts's query, and the COMMIT and local-pause tokens through what
 * the waiting COMMIT then does: it plays (neither moved), it is handled
 * without playing (only the local-pause token moved), or it is refused (the
 * COMMIT token moved).
 *
 * Harness as in pro-arm-cancel-tokens.test.ts. Real: player.ts's direct COMMIT
 * (applyProPlaybackYouTubeCommit), local pause and teardown, iframe.ts's
 * prepare seam and the iframe module behind a scripted IFrame API, the iframe
 * audio owner, the playlist media endpoint (initPlaylist) and core/timers.
 * Fakes: the iframe (fake-yt-player.ts), a calibrated PRO server clock reading
 * Date.now(), the network sends, log and toasts.
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
  createProPlaybackAuthorityToken,
  getProPlaybackAuthorityKey,
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  cancelYouTubeAuthorityPreparation,
  getProYouTubeAuthorityPreparationGeneration,
  prepareYouTubeAuthorityOccurrence,
} from '../iframe.ts';
import { isYouTubePauseGateHeld } from '../iframe-audio.ts';
import { applyProPlaybackYouTubeCommit, initYouTube, stopYouTubeMode } from '../player.ts';
import {
  resetYouTubeModuleState,
  setYouTubePlayer,
  type YouTubePlayerInstance,
} from '../_state.ts';
import { resetYouTubeSyncState } from '../sync.ts';
import type { FakeYtPlayer } from './__helpers__/fake-yt-player.ts';
import { createProEndpointFixture } from './__helpers__/pro-endpoint-harness.ts';
import { installScriptedIframeApi, loadResidentIframe } from './__helpers__/scripted-iframe-api.ts';
import { createFakeClockStarter, opTrace } from './__helpers__/standard-start-harness.ts';

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
  roomEpoch: 7,
  queueItemId: '64000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'proTokensC1',
  transitionId: `transition_${'v'.repeat(22)}`,
});
/** A later queue occurrence this device has not selected yet. */
const NEXT_QUEUE_ITEM_ID = '64000000-0000-4000-8000-000000000002' as QueueItemId;
const COMMIT_WAIT_MS = 700;
const EVENT_AT_MS = 200;
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 10, 2, 0, 0, 0));

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

/** The pause proposal that holds the gate, as a PRO pause button sends it. */
function holdGate(token: number): void {
  bus.emit('pro-playback:ui-control-pending', {
    token,
    kind: 'pause',
    queueItemId: PRO.identity.queueItemId,
    targetSeconds: 0,
    wasPlaying: false,
  });
}

/** The server's answer to that proposal, which releases the gate it holds. */
function settleGate(token: number): void {
  bus.emit('pro-playback:ui-control-settled', {
    token,
    kind: 'pause',
    queueItemId: PRO.identity.queueItemId,
    status: 'applied',
  });
}

/** A direct PRO COMMIT (no transition) that plays the resident occurrence at 0:00. */
function directCommit(): Promise<boolean> {
  return applyProPlaybackYouTubeCommit({
    authority: createProPlaybackAuthorityToken({
      roomId: PRO.identity.roomCode,
      roomEpoch: PRO.identity.roomEpoch,
      basePlaybackRevision: 1,
      transitionId: null,
    }),
    committedPlaybackRevision: 2,
    queueItemId: PRO.identity.queueItemId,
    state: 'playing',
    positionSeconds: 0,
    scheduleDelayMs: COMMIT_WAIT_MS,
    timingMode: 'scheduled-control',
    youtubeSubIndex: 0,
    youtubeVideoId: PRO.identity.videoId,
  });
}

/**
 * '+<ms since t0> <what>' lines: each event with the preparation token's
 * moves since the row began and whether the gate holds, and the instant and
 * answer of the waiting COMMIT.
 */
function tokenLog(t0: number) {
  const preparationAtStart = getProYouTubeAuthorityPreparationGeneration();
  const lines: string[] = [];
  const at = () => `+${Date.now() - t0}`;
  return {
    lines,
    probe(event: string): void {
      const moves = getProYouTubeAuthorityPreparationGeneration() - preparationAtStart;
      lines.push(
        `${at()} ${event}: preparation +${moves}, gate ${isYouTubePauseGateHeld() ? 'held' : 'open'}`,
      );
    },
    settle(label: string, promise: Promise<unknown>): void {
      promise.then(
        (answer) => lines.push(`${at()} ${label} ${String(answer)}`),
        (error: unknown) => lines.push(`${at()} ${label} threw ${String(error)}`),
      );
    },
  };
}

function releases(): Record<string, unknown>[] {
  return getProStartObservations()
    .filter((entry) => entry.kind === 'youtube-release')
    .map(({ detail }) => ({
      path: (detail as Record<string, unknown>).path,
      timingMode: (detail as Record<string, unknown>).timingMode,
    }));
}

describe('PRO start tokens stay apart (Phase 6 6D-4)', () => {
  it('a local pause moves only the local-pause token: it cancels the preparation and the wait, and the COMMIT is handled without playing', async () => {
    const { fake, from, t0 } = await setUpPro();
    const tokens = tokenLog(t0);
    holdGate(61);
    tokens.settle('COMMIT', directCommit());
    tokens.probe('direct COMMIT');
    await vi.advanceTimersByTimeAsync(EVENT_AT_MS);
    bus.emit('youtube:set-local-paused', true);
    tokens.probe('local pause');
    await vi.advanceTimersByTimeAsync(2_000 - EVENT_AT_MS);
    settleGate(61);
    tokens.probe('gate settled');
    expect(tokens.lines).toEqual([
      // The direct COMMIT cancels any preparation before its wait.
      '+0 direct COMMIT: preparation +1, gate held',
      // The pause cancels the preparation again and ends the wait at once.
      '+200 local pause: preparation +2, gate held',
      // Handled (true) without a seek or play: the COMMIT token did not move.
      '+200 COMMIT true',
      '+2000 gate settled: preparation +2, gate open',
    ]);
    expect(opTrace(fake, t0, from)).toEqual([
      // The gate's own hold.
      '+0 mute()',
      // Only the gate's settlement writes after the pause.
      '+2000 setVolume(100)',
      '+2000 unMute()',
    ]);
    expect(releases()).toEqual([]);
  });

  it('teardown moves the COMMIT and preparation tokens and drops the gate: the waiting COMMIT stays refused on the same iframe and queue item', async () => {
    const { fake, from, t0 } = await setUpPro();
    const tokens = tokenLog(t0);
    holdGate(62);
    tokens.settle('COMMIT', directCommit());
    tokens.probe('direct COMMIT');
    await vi.advanceTimersByTimeAsync(EVENT_AT_MS);
    stopYouTubeMode({ silent: true });
    // The same iframe and queue item are current again before the cancelled
    // wait resumes, as stopYouTubeMode's own comment allows: only the COMMIT
    // token can refuse the COMMIT now.
    setYouTubePlayer(fake as unknown as YouTubePlayerInstance);
    tokens.probe('teardown, same iframe current again');
    await vi.advanceTimersByTimeAsync(2_000 - EVENT_AT_MS);
    expect(tokens.lines).toEqual([
      '+0 direct COMMIT: preparation +1, gate held',
      '+200 teardown, same iframe current again: preparation +2, gate open',
      // Refused (false), and nothing plays at its executeAt.
      '+200 COMMIT false',
    ]);
    expect(opTrace(fake, t0, from)).toEqual([
      '+0 mute()',
      // Teardown's own commands on this unprimed iframe.
      '+200 mute()',
      '+200 pauseVideo()',
      '+200 stopVideo()',
      '+200 destroy()',
    ]);
    expect(releases()).toEqual([]);
  });

  it('a newer prepare moves only the preparation token: the waiting COMMIT plays at its executeAt, muted while the gate holds', async () => {
    const { fake, from, t0 } = await setUpPro();
    const tokens = tokenLog(t0);
    holdGate(63);
    tokens.settle('COMMIT', directCommit());
    tokens.probe('direct COMMIT');
    await vi.advanceTimersByTimeAsync(EVENT_AT_MS);
    // A prepare of a later occurrence, which this device has not selected
    // yet: the seam moves its token on entry and answers at once.
    tokens.settle(
      'prepare',
      prepareYouTubeAuthorityOccurrence({
        authorityKey: getProPlaybackAuthorityKey(
          createProPlaybackAuthorityToken({
            roomId: PRO.identity.roomCode,
            roomEpoch: PRO.identity.roomEpoch,
            basePlaybackRevision: 2,
            transitionId: PRO.identity.transitionId,
          }),
        ),
        queueItemId: NEXT_QUEUE_ITEM_ID,
        videoId: 'proTokensC2',
        subIndex: 0,
        positionSeconds: 0,
      }).then((result) => (result.ready ? 'ready' : result.reason)),
    );
    tokens.probe('newer prepare');
    await vi.advanceTimersByTimeAsync(2_000 - EVENT_AT_MS);
    expect(tokens.lines).toEqual([
      '+0 direct COMMIT: preparation +1, gate held',
      '+200 newer prepare: preparation +2, gate held',
      '+200 prepare superseded',
      // Played (true): neither the COMMIT nor the local-pause token moved.
      '+700 COMMIT true',
    ]);
    expect(opTrace(fake, t0, from)).toEqual([
      '+0 mute()',
      '+700 seekTo(0,true)',
      '+700 setVolume(100)',
      // The COMMIT's write mutes: the gate's token still holds.
      '+700 mute()',
      '+700 playVideo()',
    ]);
    expect(releases()).toEqual([{ path: 'direct', timingMode: 'scheduled-control' }]);
  });

  it("the gate's settlement moves only the gate's token: the waiting COMMIT plays at its executeAt, unmuted", async () => {
    const { fake, from, t0 } = await setUpPro();
    const tokens = tokenLog(t0);
    holdGate(64);
    tokens.settle('COMMIT', directCommit());
    tokens.probe('direct COMMIT');
    await vi.advanceTimersByTimeAsync(EVENT_AT_MS);
    // Another proposal's settlement leaves the gate held.
    settleGate(65);
    tokens.probe('other settlement');
    settleGate(64);
    tokens.probe('gate settled');
    await vi.advanceTimersByTimeAsync(2_000 - EVENT_AT_MS);
    expect(tokens.lines).toEqual([
      '+0 direct COMMIT: preparation +1, gate held',
      '+200 other settlement: preparation +1, gate held',
      '+200 gate settled: preparation +1, gate open',
      '+700 COMMIT true',
    ]);
    expect(opTrace(fake, t0, from)).toEqual([
      '+0 mute()',
      // The settlement's write.
      '+200 setVolume(100)',
      '+200 unMute()',
      '+700 seekTo(0,true)',
      '+700 setVolume(100)',
      '+700 unMute()',
      '+700 playVideo()',
    ]);
    expect(releases()).toEqual([{ path: 'direct', timingMode: 'scheduled-control' }]);
  });
});
