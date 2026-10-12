/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  ProRoomApiError,
  type ProRoomApiClient,
  type ProRoomPlaybackPrepareEvent,
} from '../api.ts';
import type { ProRoomPlaybackCheckpoint, ProRoomR2Source, ProRoomSnapshot } from '../contracts.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
  type ProPlaybackMediaEndpoint,
  type ProPlaybackPrepareRequest,
  type ProPlaybackPrepareResult,
} from '../playback-authority-hooks.ts';
import { ProRoomPlaybackController } from '../playback-controller.ts';
import * as serverClock from '../network-bridge.ts';
import { installProClockSnapshotMocks } from './__helpers__/pro-clock-fixture.ts';

vi.mock('../network-bridge.ts', () => ({
  getProRoomServerNow: () => Date.now(),
  isProRoomServerClockCalibrated: () => true,
  proRoomServerBridge: { waitForFreshClockCalibration: vi.fn().mockResolvedValue(true) },
  captureProRoomServerClockSnapshot: vi.fn(),
  acquireProRoomServerClock: vi.fn(),
  isProRoomClockSnapshotCurrent: vi.fn(),
}));

const ROOM = '000001';
const Q1 = '10000000-0000-4000-8000-000000000001' as QueueItemId;
const SOURCE: ProRoomR2Source = {
  kind: 'pro-r2',
  assetId: 'asset_00000000000001',
  version: 1,
  byteLength: 4096,
  mime: 'audio/mpeg',
};
const controllers: ProRoomPlaybackController[] = [];

function checkpoint(revision = 0): ProRoomPlaybackCheckpoint {
  return {
    coordinatorEpoch: 7,
    revision,
    state: revision ? 'playing' : 'idle',
    queueItemId: revision ? Q1 : null,
    positionSeconds: 0,
    youtubeVideoId: null,
    youtubeSubIndex: null,
    updatedAtMs: Date.now(),
  };
}

function ready(
  request: Readonly<ProPlaybackPrepareRequest>,
  durationSeconds = 180,
): ProPlaybackPrepareResult {
  return {
    status: 'ready',
    authority: request.authority,
    queueItemId: request.queueItemId,
    mediaKind: 'file',
    durationSeconds,
    youtubeSubIndex: null,
    youtubeVideoId: null,
  };
}

function fixture() {
  const snapshot: ProRoomSnapshot = {
    schemaVersion: 1,
    roomCode: ROOM,
    status: 'active',
    runtime: 'awake',
    revision: 1,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [{ queueItemId: Q1, name: 'Existing uploaded song', source: { ...SOURCE } }],
    currentQueueItemId: null,
    playback: checkpoint(),
    presence: {
      coordinatorEpoch: 7,
      revision: 1,
      coordinatorParticipantId: null,
      participants: [],
    },
    quota: {
      limitBytes: 1024 * 1024 * 1024,
      perAssetLimitBytes: 200 * 1024 * 1024,
      usedBytes: 4096,
      reservedBytes: 0,
    },
    viewer: null,
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [],
  };
  const lease = { generation: 1, roomCode: ROOM };
  const abort = new AbortController();
  let current = true;
  const prepare = vi.fn<ProPlaybackMediaEndpoint['prepare']>(async (request) => ready(request));
  const commit = vi.fn<ProPlaybackMediaEndpoint['commit']>(async (request) => ({
    status: 'applied',
    authority: request.authority,
  }));
  const cancel = vi.fn();
  registerProPlaybackMediaEndpoint({ prepare, commit, cancel });
  const report = vi.fn<ProRoomApiClient['reportMediaDuration']>().mockResolvedValue(undefined);
  const reportReady = vi
    .fn<ProRoomApiClient['reportPlaybackTransitionReady']>()
    .mockResolvedValue('waiting');
  const recover = vi.fn().mockResolvedValue(undefined);
  const controller = new ProRoomPlaybackController({
    isActive: () => current,
    getCanonicalSnapshot: () => snapshot,
    getPlaylistSnapshot: () => snapshot,
    capturePlaylistLease: () => lease,
    isPlaylistLeaseCurrent: (candidate) => candidate === lease && current,
    getRoomAbortSignal: () => abort.signal,
    subscribePlaylistProjection: () => () => undefined,
    runHeartbeat: vi.fn().mockResolvedValue(undefined),
    reportPlaybackTransitionReady: reportReady,
    reportMediaDuration: report,
    executePlaybackCommand: vi.fn(),
    recoverTerminalSession: recover,
  });
  controllers.push(controller);
  controller.startLifecycle();
  function event(revision = 1, id = `transition-${revision}`): ProRoomPlaybackPrepareEvent {
    return {
      type: 'pro-playback-prepare',
      transitionId: id,
      serverTimeMs: Date.now(),
      deadlineAtMs: Date.now() + 3000,
      basePlaybackRevision: revision - 1,
      target: checkpoint(revision),
    };
  }
  function commitEvent(prepared: ProRoomPlaybackPrepareEvent) {
    snapshot.playback = prepared.target;
    snapshot.currentQueueItemId = Q1;
    controller.acceptCommit({
      type: 'pro-playback-commit',
      transitionId: prepared.transitionId,
      serverTimeMs: Date.now(),
      executeAtMs: Date.now(),
      playback: prepared.target,
    });
  }
  return {
    snapshot,
    abort,
    prepare,
    commit,
    report,
    reportReady,
    recover,
    controller,
    event,
    commitEvent,
    leave: () => {
      current = false;
      abort.abort();
    },
  };
}

async function flush() {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

beforeEach(() => {
  installProClockSnapshotMocks(serverClock);
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  resetState();
  setState('room.context', {
    kind: 'pro',
    roomId: ROOM,
    role: 'member',
    coordinatorId: null,
    epoch: 7,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
  setState('playlist.items', [
    {
      queueItemId: Q1,
      type: 'file',
      name: 'Existing uploaded song',
      videoId: null,
      playlistId: null,
    },
  ]);
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stopLifecycle();
  registerProPlaybackMediaEndpoint(null);
  resetProPlaybackAuthorityHooks();
  clearAllManagedTimers();
  vi.useRealTimers();
  resetState();
});

describe('controller-only decoded file duration backfill', () => {
  it('records a successful PREPARE without waiting for its metadata request', async () => {
    const h = fixture();
    h.report.mockImplementation(() => new Promise(() => undefined));
    const event = h.event();
    h.controller.acceptPrepare(event);
    await flush();
    expect(h.report).toHaveBeenCalledWith(
      {
        code: ROOM,
        assetId: SOURCE.assetId,
        assetVersion: 1,
        byteLength: 4096,
        durationSeconds: 180,
      },
      expect.any(AbortSignal),
    );
    h.commitEvent(event);
    await flush();
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.reportReady).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.report.mock.calls[0]![1]!.aborted).toBe(true);
    expect(h.recover).not.toHaveBeenCalled();
  });

  it('backfills after the three-second READY deadline and a received COMMIT', async () => {
    const h = fixture();
    let finish!: (result: ProPlaybackPrepareResult) => void;
    h.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.reportReady.mockRejectedValue(new ProRoomApiError('PLAYBACK_TRANSITION_NOT_FOUND', 404));
    const event = h.event();
    h.controller.acceptPrepare(event);
    await flush();
    await vi.advanceTimersByTimeAsync(4000);
    h.commitEvent(event);
    await flush();
    finish(ready(h.prepare.mock.calls[0]![0]));
    await flush();
    expect(h.report).toHaveBeenCalledOnce();
    expect(h.commit).toHaveBeenCalledOnce();
  });

  it('backfills a late join from its canonical snapshot with no PREPARE cohort', async () => {
    const h = fixture();
    h.snapshot.playback = checkpoint(4);
    h.snapshot.currentQueueItemId = Q1;
    await h.controller.restorePersistedPlayback(h.snapshot);
    await flush();
    expect(h.report).toHaveBeenCalledOnce();
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.reportReady).not.toHaveBeenCalled();
  });

  it.each(['ordinary', 'failed', 'youtube', 'non-finite'] as const)(
    'does not attest %s preparation',
    async (condition) => {
      const h = fixture();
      if (condition === 'ordinary')
        setState('room.context', { ...getState('room.context'), capabilities: [] });
      h.prepare.mockImplementation(async (request) =>
        condition === 'failed'
          ? {
              status: 'failed',
              reason: 'decode-failed',
              authority: request.authority,
              queueItemId: request.queueItemId,
            }
          : {
              ...ready(request),
              ...(condition === 'youtube' ? { mediaKind: 'youtube' as const } : {}),
              ...(condition === 'non-finite' ? { durationSeconds: Infinity } : {}),
            },
      );
      h.controller.acceptPrepare(h.event());
      await flush();
      expect(h.report).not.toHaveBeenCalled();
    },
  );

  it.each(['cancel', 'source-replaced', 'permission-revoked', 'leave'] as const)(
    'drops late decode after %s',
    async (condition) => {
      const h = fixture();
      let finish!: (result: ProPlaybackPrepareResult) => void;
      h.prepare.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const event = h.event();
      h.controller.acceptPrepare(event);
      await flush();
      if (condition === 'cancel') h.controller.acceptCancel(event.transitionId);
      if (condition === 'source-replaced')
        h.snapshot.playlist[0]!.source = { ...SOURCE, assetId: 'asset_00000000000002', version: 2 };
      if (condition === 'permission-revoked')
        setState('room.context', { ...getState('room.context'), capabilities: [] });
      if (condition === 'leave') h.leave();
      finish(ready(h.prepare.mock.calls[0]![0]));
      await flush();
      expect(h.report).not.toHaveBeenCalled();
    },
  );

  it('deduplicates repeated preparations but allows corrected lengths', async () => {
    const h = fixture();
    for (const [index, duration] of [180, 180, 181].entries()) {
      h.prepare.mockImplementationOnce(async (request) => ready(request, duration));
      const event = h.event(index + 1);
      h.controller.acceptPrepare(event);
      await flush();
      h.commitEvent(event);
      await flush();
    }
    expect(h.report).toHaveBeenCalledTimes(2);
    expect(h.report.mock.calls.map(([input]) => input.durationSeconds)).toEqual([180, 181]);
  });

  it('does not loop on network failure and retries at the next preparation after backoff', async () => {
    const h = fixture();
    h.report.mockRejectedValueOnce(new ProRoomApiError('NETWORK_ERROR'));
    for (let revision = 1; revision <= 3; revision += 1) {
      if (revision === 3) await vi.advanceTimersByTimeAsync(30000);
      const event = h.event(revision);
      h.controller.acceptPrepare(event);
      await flush();
      h.commitEvent(event);
      await flush();
    }
    expect(h.report).toHaveBeenCalledTimes(2);
    expect(h.commit).toHaveBeenCalledTimes(3);
    expect(h.recover).not.toHaveBeenCalled();
  });

  it('quietly suppresses an old Worker endpoint until the next room lifecycle', async () => {
    const h = fixture();
    h.report.mockRejectedValue(new ProRoomApiError('NOT_FOUND', 404));
    for (let revision = 1; revision <= 2; revision += 1) {
      const event = h.event(revision);
      h.controller.acceptPrepare(event);
      await flush();
      h.commitEvent(event);
      await flush();
    }
    expect(h.report).toHaveBeenCalledOnce();
    expect(h.commit).toHaveBeenCalledTimes(2);
    expect(h.recover).not.toHaveBeenCalled();
    h.controller.resetPlaylistRuntime();
    const event = h.event(3);
    h.controller.acceptPrepare(event);
    await flush();
    expect(h.report).toHaveBeenCalledTimes(2);
  });

  it('does not disable backfill when a removed asset returns 404', async () => {
    const h = fixture();
    h.report.mockRejectedValueOnce(new ProRoomApiError('ASSET_NOT_FOUND', 404));
    h.controller.acceptPrepare(h.event());
    await flush();
    h.controller.acceptCancel('transition-1');
    h.snapshot.playlist[0]!.source = { ...SOURCE, assetId: 'asset_00000000000002' };
    h.controller.acceptPrepare(h.event(2));
    await flush();
    expect(h.report).toHaveBeenCalledTimes(2);
  });

  it('aborts in-flight metadata on lifecycle teardown without affecting the renderer', async () => {
    const h = fixture();
    h.report.mockImplementation(() => new Promise(() => undefined));
    h.controller.acceptPrepare(h.event());
    await flush();
    const signal = h.report.mock.calls[0]![1]!;
    h.controller.stopLifecycle();
    expect(signal.aborted).toBe(true);
    await flush();
    expect(h.recover).not.toHaveBeenCalled();
  });

  it('uses fresh preparation from local reconciliation to retry legacy asset backfill', async () => {
    const h = fixture();
    h.report.mockRejectedValueOnce(new ProRoomApiError('NETWORK_ERROR'));
    const event = h.event();
    h.controller.acceptPrepare(event);
    await flush();
    h.commitEvent(event);
    await flush();
    await vi.advanceTimersByTimeAsync(30000);
    await expect(
      h.controller.reconcile({ showLoading: false, youtubeOnly: false, rendezvous: true }),
    ).resolves.toBe(true);
    expect(h.report).toHaveBeenCalledTimes(2);
  });

  it('backfills only the successful exact-base recovery after a newer PREPARE is cancelled', async () => {
    const h = fixture();
    h.report.mockRejectedValueOnce(new ProRoomApiError('NETWORK_ERROR'));
    const first = h.event();
    h.controller.acceptPrepare(first);
    await flush();
    h.commitEvent(first);
    await flush();
    await vi.advanceTimersByTimeAsync(30000);
    h.prepare.mockImplementationOnce(() => new Promise(() => undefined));
    const cancelled = h.event(2);
    h.controller.acceptPrepare(cancelled);
    await flush();
    h.controller.acceptCancel(cancelled.transitionId);
    await h.controller.restorePersistedPlayback(h.snapshot);
    await flush();
    expect(h.report).toHaveBeenCalledTimes(2);
    expect(h.commit).toHaveBeenCalledTimes(2);
    expect(h.report.mock.calls[1]![0]).toEqual(h.report.mock.calls[0]![0]);
  });
});
