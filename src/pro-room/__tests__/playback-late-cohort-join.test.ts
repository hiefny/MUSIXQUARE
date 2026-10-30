/**
 * @vitest-environment jsdom
 *
 * Pins of today's late YouTube cohort join in a PRO room (investigation of
 * 2026-10-30 on 9.0.24). The Worker commits a transition once its frozen
 * cohort has answered READY or failed, or once its barrier has passed, and
 * every device starts at the COMMIT's executeAt (the commit plus 700 ms).
 * These rows drive one participant's real playback controller against a
 * scripted media endpoint and a calibrated synthetic server clock, and record
 * what it commits when its own YouTube preparation is late. They describe
 * current behaviour, including parts that look like defects: a change that
 * moves a pinned number has to say why.
 *
 * The controller takes no platform input, so these rows hold on every
 * platform. What the device does with each commit differs on Android, where
 * the YouTube endpoint adds a fixed 250 ms output lead: see the Android rows
 * in src/youtube/__tests__/pro-manual-zero-start.test.ts and
 * src/youtube/__tests__/pro-late-prepare-reload.test.ts.
 *
 * Timing: the Worker's barrier and COMMIT lead come from the copy that
 * pro-room-playback-timing.test.ts pins to cloudflare/pro-room-playback-timing.ts
 * (this suite must not load Worker code, see ci-quality-gates.test.ts); the
 * App's own late-join values come from __helpers__/pro-late-youtube-join-timing.ts,
 * which names the row that pins each of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import type { QueueItemId } from '../../types/index.ts';
import type { ProRoomPlaybackCommitEvent, ProRoomPlaybackPrepareEvent } from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomPlaybackCheckpoint,
  type ProRoomSnapshot,
} from '../contracts.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
  type ProPlaybackCommitResult,
  type ProPlaybackMediaEndpoint,
  type ProPlaybackPrepareRequest,
  type ProPlaybackPrepareResult,
} from '../playback-authority-hooks.ts';
import { ProRoomPlaybackController } from '../playback-controller.ts';
import {
  LATE_YOUTUBE_COMMIT_LEAD_MS as LATE_JOIN_LEAD_MS,
  LATE_YOUTUBE_RELEASE_TOLERANCE_MS,
  RELEASE_ACK_TIMEOUT_MS,
} from './__helpers__/pro-late-youtube-join-timing.ts';
import {
  PRO_ROOM_PLAYBACK_COMMIT_LEAD_MS as COMMIT_LEAD_MS,
  PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS as BARRIER_MS,
} from './__helpers__/pro-room-playback-timing-copy.ts';
import { proSnapshot } from './__helpers__/pro-snapshot.ts';

const serverClock = vi.hoisted(() => ({ offsetMs: 0 }));

// A calibrated server clock: server time is this device's time plus offsetMs.
// A fresh READY clock is refused past its server deadline, as the bridge does.
vi.mock('../network-bridge.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../network-bridge.ts')>();
  const snapshot = () => ({
    generation: 1,
    sampleId: 1,
    offsetMs: serverClock.offsetMs,
    rttMs: 10,
    sampledAtMs: performance.now(),
    roundId: 1,
    source: 'ready' as const,
  });
  return {
    ...actual,
    getProRoomServerNow: () => Date.now() + serverClock.offsetMs,
    isProRoomServerClockCalibrated: () => true,
    captureProRoomServerClockSnapshot: () => snapshot(),
    isProRoomClockSnapshotCurrent: () => true,
    acquireProRoomServerClock: async (options: {
      serverDeadlineAtMs?: number;
      signal?: AbortSignal;
    }) => {
      if (options.signal?.aborted) return null;
      const deadline = options.serverDeadlineAtMs ?? Number.MAX_SAFE_INTEGER;
      return Date.now() + serverClock.offsetMs <= deadline ? snapshot() : null;
    },
  };
});

const ROOM_CODE = '000001';
const ROOM_EPOCH = 4;
const QUEUE_ITEM_ID = '50000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'dQw4w9WgXcQ';
const TRANSITION_ID = `transition_${'l'.repeat(22)}`;
/**
 * The room position at a fresh start's late-join instant: that instant is one
 * late-join lead after the COMMIT, which is one COMMIT lead before executeAt,
 * where the room timeline starts at 0 (today 3.0 - 0.7 = 2.3 s).
 */
const LATE_JOIN_POSITION_SECONDS = (LATE_JOIN_LEAD_MS - COMMIT_LEAD_MS) / 1_000;

function playing(revision: number, updatedAtMs: number): ProRoomPlaybackCheckpoint {
  return {
    coordinatorEpoch: ROOM_EPOCH,
    revision,
    state: 'playing',
    queueItemId: QUEUE_ITEM_ID,
    positionSeconds: 0,
    youtubeVideoId: VIDEO_ID,
    youtubeSubIndex: 0,
    updatedAtMs,
  };
}

function serverNow(): number {
  return Date.now() + serverClock.offsetMs;
}

/** The Worker's PREPARE of a fresh start: barrier 3 s, start kind zero-start. */
function prepareEvent(): ProRoomPlaybackPrepareEvent {
  const serverTimeMs = serverNow();
  return {
    type: 'pro-playback-prepare',
    transitionId: TRANSITION_ID,
    serverTimeMs,
    deadlineAtMs: serverTimeMs + BARRIER_MS,
    basePlaybackRevision: 0,
    target: playing(1, serverTimeMs),
    timingMode: 'zero-start',
  };
}

/** The Worker's COMMIT sent now: executeAt one lead later, the checkpoint stamped at it. */
function commitEvent(): ProRoomPlaybackCommitEvent {
  const serverTimeMs = serverNow();
  const executeAtMs = serverTimeMs + COMMIT_LEAD_MS;
  return {
    type: 'pro-playback-commit',
    transitionId: TRANSITION_ID,
    serverTimeMs,
    executeAtMs,
    playback: playing(1, executeAtMs),
    timingMode: 'zero-start',
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
        name: 'Late cohort join',
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

function readyFor(request: Readonly<ProPlaybackPrepareRequest>): ProPlaybackPrepareResult {
  return {
    status: 'ready',
    authority: request.authority,
    queueItemId: request.queueItemId,
    mediaKind: 'youtube',
    durationSeconds: 240,
    youtubeSubIndex: 0,
    youtubeVideoId: VIDEO_ID,
  };
}

function failedFor(request: Readonly<ProPlaybackPrepareRequest>): ProPlaybackPrepareResult {
  return {
    status: 'failed',
    authority: request.authority,
    queueItemId: request.queueItemId,
    reason: 'timeout',
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createFixture() {
  const current = snapshot();
  setState('room.context', {
    kind: 'pro',
    roomId: ROOM_CODE,
    role: 'member',
    coordinatorId: null,
    epoch: ROOM_EPOCH,
    snapshotRevision: current.revision,
    capabilities: [],
  });
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Late cohort join',
      videoId: VIDEO_ID,
      playlistId: null,
    },
  ]);
  const prepare = vi.fn<ProPlaybackMediaEndpoint['prepare']>(async (request) => readyFor(request));
  const commit = vi.fn<ProPlaybackMediaEndpoint['commit']>(
    async (request): Promise<ProPlaybackCommitResult> => ({
      status: 'applied',
      authority: request.authority,
    }),
  );
  const cancel = vi.fn<NonNullable<ProPlaybackMediaEndpoint['cancel']>>();
  const unregister = registerProPlaybackMediaEndpoint({
    prepare,
    commit,
    cancel,
    invalidateCommitted: vi.fn(),
  });
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
  fixtures.push({ controller, unregister });
  return { controller, prepare, commit, cancel, reportReady };
}

const fixtures: Array<{ controller: ProRoomPlaybackController; unregister: () => void }> = [];

beforeEach(() => {
  resetState();
  resetProPlaybackAuthorityHooks();
  serverClock.offsetMs = 0;
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  for (const { controller, unregister } of fixtures.splice(0)) {
    controller.resetPlaylistRuntime();
    unregister();
  }
  resetProPlaybackAuthorityHooks();
  vi.clearAllTimers();
  vi.useRealTimers();
  resetState();
});

describe('PRO late YouTube cohort join (pinned 2026-10-30)', () => {
  // (c) Scenario: this device's YouTube preparation outlasts the 2.3 s
  // barriered budget, so it reports failed READY and the Worker commits
  // without it. Its clock reads 5 s behind the server's.
  it('(c) joins a failed-READY device 3 s after COMMIT on the server clock, mid-track, as a scheduled control', async () => {
    serverClock.offsetMs = 5_000;
    const fixture = createFixture();
    const transition = deferred<ProPlaybackPrepareResult>();
    const lateJoin = deferred<ProPlaybackPrepareResult>();
    fixture.prepare
      .mockImplementationOnce(() => transition.promise)
      .mockImplementationOnce(() => lateJoin.promise);

    fixture.controller.acceptPrepare(prepareEvent());
    // The real YouTube endpoint gives up 2.32 s after the PREPARE, at its first
    // 40 ms poll past the 2.3 s barriered budget (src/youtube/iframe.ts, as
    // seen end to end in pro-late-prepare-reload.test.ts). This endpoint is
    // scripted, so only the order matters: READY fails before the COMMIT.
    await vi.advanceTimersByTimeAsync(2_320);
    transition.resolve(failedFor(fixture.prepare.mock.calls[0]![0]));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.reportReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ transitionId: TRANSITION_ID, status: 'failed' }),
    );

    const committed = commitEvent();
    fixture.controller.acceptCommit(committed);
    await vi.advanceTimersByTimeAsync(0);

    // The catch-up prepares at a participant-local instant 3 s ahead on the
    // server clock: the room position there is 3.0 - 0.7 = 2.3 s. It has no
    // READY budget, so the YouTube endpoint may wait for a first player load.
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
    const lateRequest = fixture.prepare.mock.calls[1]![0];
    expect(lateRequest).toMatchObject({
      authority: { transitionId: 'snapshot_1', basePlaybackRevision: 0 },
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: LATE_JOIN_POSITION_SECONDS,
      state: 'playing',
      youtubeVideoId: VIDEO_ID,
    });
    expect(lateRequest.prepareBudgetMs).toBeUndefined();
    expect(fixture.commit).not.toHaveBeenCalled();

    // The re-armed iframe settles 600 ms later; the release waits out the plan.
    await vi.advanceTimersByTimeAsync(600);
    lateJoin.resolve(readyFor(lateRequest));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.commit).toHaveBeenCalledOnce();
    const release = fixture.commit.mock.calls[0]![0];
    expect(release).toMatchObject({
      authority: { transitionId: 'snapshot_1' },
      committedPlaybackRevision: 1,
      state: 'playing',
      positionSeconds: LATE_JOIN_POSITION_SECONDS,
      scheduleDelayMs: LATE_JOIN_LEAD_MS - 600,
      // Not the transition's zero-start: no learned startup lead (see
      // src/youtube/__tests__/pro-manual-zero-start.test.ts for the endpoint).
      timingMode: 'scheduled-control',
    });
    // Release instant on the server clock: COMMIT receipt + 3 s, which is
    // executeAt + 2.3 s, where the room timeline is at the committed 2.3 s.
    // This is the row that pins the shared LATE_YOUTUBE_COMMIT_LEAD_MS copy.
    const releaseServerAtMs = serverNow() + release.scheduleDelayMs;
    expect(releaseServerAtMs).toBe(committed.serverTimeMs + LATE_JOIN_LEAD_MS);
    expect(releaseServerAtMs - committed.executeAtMs).toBe(LATE_JOIN_LEAD_MS - COMMIT_LEAD_MS);
  });

  // (c) Scenario: as above, but the re-armed preparation ends 300 ms before
  // its planned instant, inside LOCAL_YOUTUBE_REJOIN_MIN_RELEASE_MS (400 ms).
  // Looks like a defect: the commit falls back to the room position now
  // (2.0 s), below the 2.3 s the iframe settled at, and the arm never seeks
  // backward, so the device starts 0.3 s ahead of the room (pinned end to end
  // in src/youtube/__tests__/pro-late-prepare-reload.test.ts).
  it('(c) commits a late join that ends 300 ms before its plan at the current room position, below the settled one', async () => {
    const fixture = createFixture();
    const lateJoin = deferred<ProPlaybackPrepareResult>();
    fixture.prepare
      .mockImplementationOnce(async (request) => failedFor(request))
      .mockImplementationOnce(() => lateJoin.promise);
    fixture.controller.acceptPrepare(prepareEvent());
    await vi.advanceTimersByTimeAsync(0);
    const committed = commitEvent();
    fixture.controller.acceptCommit(committed);
    await vi.advanceTimersByTimeAsync(0);
    const lateRequest = fixture.prepare.mock.calls[1]![0];
    expect(lateRequest.positionSeconds).toBe(LATE_JOIN_POSITION_SECONDS);

    await vi.advanceTimersByTimeAsync(LATE_JOIN_LEAD_MS - 300);
    lateJoin.resolve(readyFor(lateRequest));
    await vi.advanceTimersByTimeAsync(0);

    expect(fixture.commit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        authority: expect.objectContaining({ transitionId: 'snapshot_1' }),
        // The room position now, 300 ms before the plan: 2.0 s.
        positionSeconds: (LATE_JOIN_LEAD_MS - 300 - COMMIT_LEAD_MS) / 1_000,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
      }),
    );
  });

  // (b) Scenario: this device was ready on time, but at its release the
  // iframe reports no PLAYING within 1.8 s. The arm pauses and fails the
  // commit; playlist.ts reports that as media-unavailable (not
  // device-unavailable), so applyPlaybackCommit runs the catch-up.
  it('(b) re-arms a device whose release saw no PLAYING for 1.8 s at a fresh instant 3 s later', async () => {
    const fixture = createFixture();
    fixture.commit.mockImplementationOnce(
      (request) =>
        new Promise<ProPlaybackCommitResult>((resolve) => {
          setTimeout(
            () =>
              resolve({
                status: 'failed',
                authority: request.authority,
                reason: 'media-unavailable',
              }),
            request.scheduleDelayMs + RELEASE_ACK_TIMEOUT_MS,
          );
        }),
    );
    fixture.controller.acceptPrepare(prepareEvent());
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.reportReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: 'ready' }),
    );

    const committed = commitEvent();
    fixture.controller.acceptCommit(committed);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.commit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        authority: expect.objectContaining({ transitionId: TRANSITION_ID }),
        positionSeconds: 0,
        scheduleDelayMs: COMMIT_LEAD_MS,
        timingMode: 'zero-start',
      }),
    );

    await vi.advanceTimersByTimeAsync(COMMIT_LEAD_MS + RELEASE_ACK_TIMEOUT_MS - 1);
    expect(fixture.prepare).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(fixture.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ transitionId: TRANSITION_ID }),
    );
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
    // 1.8 s after executeAt plus the 3 s rejoin lead: the room is at 4.8 s.
    const rejoinAfterExecuteMs = RELEASE_ACK_TIMEOUT_MS + LATE_JOIN_LEAD_MS;
    expect(fixture.prepare.mock.calls[1]![0]).toMatchObject({
      authority: { transitionId: 'snapshot_1' },
      positionSeconds: rejoinAfterExecuteMs / 1_000,
    });
    expect(fixture.commit).toHaveBeenCalledTimes(2);
    expect(fixture.commit.mock.calls[1]![0]).toMatchObject({
      authority: { transitionId: 'snapshot_1' },
      positionSeconds: rejoinAfterExecuteMs / 1_000,
      scheduleDelayMs: LATE_JOIN_LEAD_MS,
      timingMode: 'scheduled-control',
    });
    expect(serverNow() + LATE_JOIN_LEAD_MS - committed.executeAtMs).toBe(rejoinAfterExecuteMs);
  });

  // (d) Scenario: this device's preparation started late (for example its
  // PREPARE frame arrived late or waited for playlist hydration) and ends
  // after the Worker committed at the barrier, but before executeAt.
  it('(d) starts a device ready after the deadline COMMIT but before executeAt on time from 0:00', async () => {
    const fixture = createFixture();
    const transition = deferred<ProPlaybackPrepareResult>();
    fixture.prepare.mockImplementationOnce(() => transition.promise);
    fixture.controller.acceptPrepare(prepareEvent());
    await vi.advanceTimersByTimeAsync(BARRIER_MS);

    const committed = commitEvent();
    fixture.controller.acceptCommit(committed);
    await vi.advanceTimersByTimeAsync(500);
    transition.resolve(readyFor(fixture.prepare.mock.calls[0]![0]));
    await vi.advanceTimersByTimeAsync(0);

    expect(fixture.commit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        authority: expect.objectContaining({ transitionId: TRANSITION_ID }),
        positionSeconds: 0,
        scheduleDelayMs: COMMIT_LEAD_MS - 500,
        timingMode: 'zero-start',
      }),
    );
    expect(fixture.prepare).toHaveBeenCalledOnce();
    // The COMMIT arrived first, so this device never reports READY at all.
    expect(fixture.reportReady).not.toHaveBeenCalled();
  });

  // (d) Scenario: as above, but ready 0-40 ms after executeAt. Within
  // LATE_YOUTUBE_RELEASE_TOLERANCE_MS the prepared release still runs: the
  // commit names the room position, and the arm, which ignores a target
  // change of 40 ms or less, plays from 0:00 at once (that many ms late).
  // That holds where the fixed output lead is 0; on Android the arm seeks
  // 250 ms ahead first (pro-manual-zero-start.test.ts, '(d) on Android').
  it.each([0, LATE_YOUTUBE_RELEASE_TOLERANCE_MS - 1, LATE_YOUTUBE_RELEASE_TOLERANCE_MS])(
    '(d) releases a device ready %i ms after executeAt from its transition without a catch-up',
    async (lateMs) => {
      const fixture = createFixture();
      const transition = deferred<ProPlaybackPrepareResult>();
      fixture.prepare.mockImplementationOnce(() => transition.promise);
      fixture.controller.acceptPrepare(prepareEvent());
      await vi.advanceTimersByTimeAsync(BARRIER_MS);
      fixture.controller.acceptCommit(commitEvent());
      await vi.advanceTimersByTimeAsync(COMMIT_LEAD_MS + lateMs);
      transition.resolve(readyFor(fixture.prepare.mock.calls[0]![0]));
      await vi.advanceTimersByTimeAsync(0);

      expect(fixture.commit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          authority: expect.objectContaining({ transitionId: TRANSITION_ID }),
          positionSeconds: lateMs / 1_000,
          scheduleDelayMs: 0,
          timingMode: 'zero-start',
        }),
      );
      expect(fixture.prepare).toHaveBeenCalledOnce();
      expect(fixture.cancel).not.toHaveBeenCalled();
    },
  );

  // (d) Scenario: ready 41 ms after executeAt, one past the tolerance. The
  // prepared release is dropped and the device re-arms for a mid-track join
  // more than 3 s later: a 1 ms difference costs the whole song start.
  it('(d) re-arms a device ready 41 ms after executeAt for a mid-track join 3 s later', async () => {
    const lateMs = LATE_YOUTUBE_RELEASE_TOLERANCE_MS + 1;
    const fixture = createFixture();
    const transition = deferred<ProPlaybackPrepareResult>();
    fixture.prepare.mockImplementationOnce(() => transition.promise);
    fixture.controller.acceptPrepare(prepareEvent());
    await vi.advanceTimersByTimeAsync(BARRIER_MS);
    fixture.controller.acceptCommit(commitEvent());
    await vi.advanceTimersByTimeAsync(COMMIT_LEAD_MS + lateMs);
    transition.resolve(readyFor(fixture.prepare.mock.calls[0]![0]));
    await vi.advanceTimersByTimeAsync(0);

    expect(fixture.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ transitionId: TRANSITION_ID }),
    );
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
    // The rejoin instant is a late-join lead after now: the room is at 3.041 s.
    const rejoinSeconds = (lateMs + LATE_JOIN_LEAD_MS) / 1_000;
    expect(fixture.prepare.mock.calls[1]![0]).toMatchObject({
      authority: { transitionId: 'snapshot_1' },
      positionSeconds: rejoinSeconds,
    });
    expect(fixture.commit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        authority: expect.objectContaining({ transitionId: 'snapshot_1' }),
        positionSeconds: rejoinSeconds,
        scheduleDelayMs: LATE_JOIN_LEAD_MS,
        timingMode: 'scheduled-control',
      }),
    );
  });
});
