/**
 * @vitest-environment jsdom
 *
 * PRO start-kind rows at the YouTube endpoint (pinned 2026-10-30), tests
 * first for the increments that give the PRO arm its own start claim.
 *
 * ZS-06: a device that prepared a zero-start PREPARE and then receives the
 * heartbeat snapshot (restorePersistedPlayback) or a reconcile before the
 * COMMIT frame commits that checkpoint as zero-start: the endpoint takes the
 * prepared path (player.ts:1176-1179) and the arm releases with the learned
 * timeline lead (authority-arm.ts:410-413). The controller-level precedent is
 * playback-snapshot-share-ownership.test.ts "commits a %s that lands a
 * zero-start PREPARE checkpoint before its COMMIT as zero-start".
 *
 * ZS-09: a COMMIT that names zero-start without a matching PREPARE goes
 * through the real controller, which lowers it to scheduled-control
 * (playback-controller.ts:1624), and reaches the direct path: the release
 * has timelineLeadMs 0 (player.ts:1452) and the sample is a scheduled
 * control that does not learn (:1476-1478). The release observation's
 * timingMode echoes the request (:1436) and is not asserted.
 *
 * Each row first seeds one learned zero-start lead in the room session (an
 * iframe whose PLAYING lags its play call by 80 ms), so a learned lead can be
 * told apart from 0.
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
import { resetYouTubeModuleState } from '../_state.ts';
import { resetYouTubeSyncState } from '../sync.ts';
import type { FakeYtPlayer } from './__helpers__/fake-yt-player.ts';
import {
  createProEndpointFixture,
  type ProParticipant,
} from './__helpers__/pro-endpoint-harness.ts';
import { installScriptedIframeApi, loadResidentIframe } from './__helpers__/scripted-iframe-api.ts';
import { createFakeClockStarter } from './__helpers__/standard-start-harness.ts';

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

// The participant's lead learner survives renderer resets within one room
// (player.ts keys it by room and epoch), so every row owns a fresh epoch.
let roomEpoch = 600;
let PRO = createProEndpointFixture({
  roomCode: '000001',
  roomEpoch,
  queueItemId: '67000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'startKindA1',
  transitionId: `transition_${'k'.repeat(22)}`,
});
const SEED_TRANSITION_ID = `transition_${'s'.repeat(22)}`;
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 9, 30, 0, 0, 0));

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

async function setUpPro(): Promise<{ fake: FakeYtPlayer; participant: ProParticipant }> {
  roomEpoch += 1;
  PRO = createProEndpointFixture({ ...PRO.identity, roomEpoch });
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
  return { fake, participant: PRO.createParticipant() };
}

/** One zero-start whose PLAYING lags its play call by 80 ms; the room session learns from it. */
async function seedLearnedLead(fake: FakeYtPlayer, participant: ProParticipant): Promise<number> {
  const play = fake.playVideo;
  let releases = 0;
  fake.playVideo = () => {
    // The warm-up is the first play of the transition; lag only the release.
    releases += 1;
    if (releases !== 2) {
      play();
      return;
    }
    fake.__log.push({ op: 'playVideo', at: Date.now() });
    setTimeout(play, 80);
  };
  participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start', SEED_TRANSITION_ID));
  await vi.advanceTimersByTimeAsync(1_000);
  participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'zero-start', SEED_TRANSITION_ID));
  await vi.advanceTimersByTimeAsync(3_500);
  fake.playVideo = play;
  const learned = getProStartObservations()
    .filter(({ kind }) => kind === 'youtube-learning')
    .map(({ detail }) => (detail as { nextTimelineLeadMs?: number }).nextTimelineLeadMs);
  return learned.at(-1) ?? Number.NaN;
}

function lastOf(kind: 'youtube-release' | 'youtube-sample', keys: readonly string[]) {
  const entries = getProStartObservations().filter((entry) => entry.kind === kind);
  return entries.map(({ detail }) =>
    Object.fromEntries(keys.map((key) => [key, (detail as Record<string, unknown>)[key]])),
  );
}

describe('PRO start kind at the YouTube endpoint (pinned 2026-10-30)', () => {
  it.each(['restore', 'reconcile'] as const)(
    'ZS-06: commits a %s that lands a prepared zero-start checkpoint before its COMMIT on the prepared path with the learned lead',
    async (route) => {
      const { fake, participant } = await setUpPro();
      const learned = await seedLearnedLead(fake, participant);
      const prepare = PRO.prepareEvent(2, 0, 'zero-start');
      participant.controller.acceptPrepare(prepare);
      // Armed and READY at +620; the snapshot follows right after.
      await vi.advanceTimersByTimeAsync(650);
      // The heartbeat snapshot carries the PREPARE's reserved checkpoint first.
      const landed = PRO.snapshot(prepare.target);
      participant.setCanonicalSnapshot(landed);
      const landing =
        route === 'restore'
          ? participant.controller.restorePersistedPlayback(landed)
          : participant.controller.reconcile({
              showLoading: false,
              youtubeOnly: false,
              rendezvous: false,
            });
      await vi.advanceTimersByTimeAsync(3_500);
      await landing;
      const releases = lastOf('youtube-release', ['path', 'timingMode', 'timelineLeadMs']);
      const samples = lastOf('youtube-sample', [
        'timingMode',
        'learningEnabled',
        'path',
        'checkpointMs',
      ]);
      // Today, at the endpoint, the landed checkpoint commits as a scheduled
      // control on the prepared path, without the learned 20 ms lead: the
      // checkpoint is stamped at the PREPARE instant and the server clock
      // has moved on when it lands (the controller-level pin cited above
      // reads a frozen server clock). The samples listed are the seed's.
      expect(learned).toBeCloseTo(20, 6);
      expect({ releases, samples }).toEqual({
        releases: [
          { path: 'prepared', timingMode: 'zero-start', timelineLeadMs: 0 },
          { path: 'prepared', timingMode: 'scheduled-control', timelineLeadMs: 0 },
        ],
        samples: [
          { timingMode: 'zero-start', learningEnabled: true, path: 'prepared', checkpointMs: 800 },
          { timingMode: 'zero-start', learningEnabled: true, path: 'prepared', checkpointMs: 2000 },
        ],
      });
    },
  );

  it('ZS-09: catches up a zero-start COMMIT of an unknown transition as a scheduled control that does not learn', async () => {
    const { fake, participant } = await setUpPro();
    const learned = await seedLearnedLead(fake, participant);
    resetProStartObservations();
    participant.controller.acceptCommit(
      PRO.commitEvent(3, 0, 'zero-start', `transition_${'q'.repeat(22)}`),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    const releases = lastOf('youtube-release', ['path', 'timelineLeadMs']);
    const samples = lastOf('youtube-sample', ['timingMode', 'learningEnabled', 'path']);
    // An unknown transition's COMMIT is caught up through a prepare: the
    // prepared path, as a scheduled control that does not learn.
    expect(learned).toBeCloseTo(20, 6);
    expect({ releases, samples }).toEqual({
      releases: [{ path: 'prepared', timelineLeadMs: 0 }],
      samples: [
        { timingMode: 'scheduled-control', learningEnabled: false, path: 'prepared' },
        { timingMode: 'scheduled-control', learningEnabled: false, path: 'prepared' },
      ],
    });
  });

  it('ZS-09: plays a direct COMMIT (transitionId null) that names zero-start as a scheduled control on the direct path', async () => {
    const { fake, participant } = await setUpPro();
    const learned = await seedLearnedLead(fake, participant);
    resetProStartObservations();
    participant.controller.acceptCommit(PRO.commitEvent(3, 0, 'zero-start', null));
    await vi.advanceTimersByTimeAsync(3_000);
    const releases = lastOf('youtube-release', ['path', 'timelineLeadMs']);
    const samples = lastOf('youtube-sample', ['timingMode', 'learningEnabled', 'path']);
    expect(learned).toBeCloseTo(20, 6);
    expect({ releases, samples }).toEqual({
      releases: [{ path: 'direct', timelineLeadMs: 0 }],
      samples: [
        { timingMode: 'scheduled-control', learningEnabled: false, path: 'direct' },
        { timingMode: 'scheduled-control', learningEnabled: false, path: 'direct' },
      ],
    });
  });
});
