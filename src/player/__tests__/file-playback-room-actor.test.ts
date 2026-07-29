import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  FilePlaybackRoomActor,
  createFilePlaybackActorInput,
  createInitialFilePlaybackRoomReplica,
  reduceFilePlaybackActorInput,
  type FilePlaybackActorInput,
  type FilePlaybackEffectLease,
  type FilePlaybackMediaBinding,
  type FilePlaybackRoomEvent,
  type FilePlaybackRoomReduceResult,
  type FilePlaybackRoomRun,
  type FilePlaybackRoomTimeline,
  type FilePlaybackRoomTimelineIntent,
} from './helpers/file-playback-room-actor-model.ts';

const ROOM_EPOCH = 'room-epoch-1';
const ACTOR_GENERATION = 'actor-generation-1';
const QUEUE_ITEM_1 = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const QUEUE_ITEM_2 = '00000000-0000-4000-8000-000000000002' as QueueItemId;
const RUN_1: FilePlaybackRoomRun = Object.freeze({
  queueItemId: QUEUE_ITEM_1,
  runId: 'run-1',
});
const RUN_2: FilePlaybackRoomRun = Object.freeze({
  queueItemId: QUEUE_ITEM_2,
  runId: 'run-2',
});
const MEDIA_1: FilePlaybackMediaBinding = Object.freeze({
  bindingId: 'binding-1',
  queueItemId: QUEUE_ITEM_1,
  sourceIdentity: 'source-1',
  delivery: 'r2-records',
  descriptorId: 'descriptor-1',
  descriptorVersion: 1,
  encodedSize: 12_345,
  mimeType: 'audio/flac',
  durationSeconds: 240,
});
const MEDIA_2: FilePlaybackMediaBinding = Object.freeze({
  ...MEDIA_1,
  bindingId: 'binding-2',
  queueItemId: QUEUE_ITEM_2,
  sourceIdentity: 'source-2',
  descriptorId: 'descriptor-2',
});

function initial() {
  return createInitialFilePlaybackRoomReplica(ROOM_EPOCH, ACTOR_GENERATION);
}

function mediaEvent(
  sequence: number,
  eventId: string,
  media: FilePlaybackMediaBinding | null = MEDIA_1,
  roomEpoch = ROOM_EPOCH,
): FilePlaybackRoomEvent {
  return createFilePlaybackActorInput({
    schemaVersion: 1,
    roomEpoch,
    sequence,
    eventId,
    kind: 'media-bound',
    media,
  }) as FilePlaybackRoomEvent;
}

function playIntent(
  revision = 1,
  run: FilePlaybackRoomRun = RUN_1,
): FilePlaybackRoomTimelineIntent {
  return Object.freeze({
    type: 'play',
    revision,
    run,
    positionSeconds: 0,
    rate: 1,
  });
}

function pauseIntent(
  revision = 2,
  run: FilePlaybackRoomRun = RUN_1,
): FilePlaybackRoomTimelineIntent {
  return Object.freeze({ type: 'pause', revision, run });
}

function timelineEvent(
  sequence: number,
  eventId: string,
  intent: FilePlaybackRoomTimelineIntent,
  atRoomTimeMs = sequence * 1_000,
): FilePlaybackRoomEvent {
  return createFilePlaybackActorInput({
    schemaVersion: 1,
    roomEpoch: ROOM_EPOCH,
    sequence,
    eventId,
    kind: 'timeline-transition',
    atRoomTimeMs,
    intent,
  }) as FilePlaybackRoomEvent;
}

function playingTimeline(
  run: FilePlaybackRoomRun = RUN_1,
  anchorRoomTimeMs = 2_000,
): FilePlaybackRoomTimeline {
  return Object.freeze({
    schemaVersion: 1,
    revision: 1,
    phase: 'playing',
    run,
    positionSeconds: 0,
    anchorRoomTimeMs,
    rate: 1,
  });
}

function pausedTimeline(): FilePlaybackRoomTimeline {
  return Object.freeze({
    schemaVersion: 1,
    revision: 2,
    phase: 'paused',
    run: RUN_1,
    positionSeconds: 1,
    anchorRoomTimeMs: 3_000,
    rate: 1,
  });
}

function stoppedTimeline(revision = 0, anchorRoomTimeMs = 0): FilePlaybackRoomTimeline {
  return Object.freeze({
    schemaVersion: 1,
    revision,
    phase: 'stopped',
    run: null,
    positionSeconds: 0,
    anchorRoomTimeMs,
    rate: 1,
  });
}

function snapshotEvent(
  sequence: number,
  eventId: string,
  timeline: FilePlaybackRoomTimeline = playingTimeline(),
  media: FilePlaybackMediaBinding | null = MEDIA_1,
): FilePlaybackRoomEvent {
  return createFilePlaybackActorInput({
    schemaVersion: 1,
    roomEpoch: ROOM_EPOCH,
    sequence,
    eventId,
    kind: 'snapshot',
    timeline,
    media,
  }) as FilePlaybackRoomEvent;
}

function rendererCompletion(
  lease: FilePlaybackEffectLease,
  outcome: 'ready' | 'failed' = 'ready',
  actorGeneration = ACTOR_GENERATION,
): FilePlaybackActorInput {
  return createFilePlaybackActorInput({
    schemaVersion: 1,
    kind: 'renderer-effect-completed',
    roomEpoch: ROOM_EPOCH,
    actorGeneration,
    lease,
    outcome,
  });
}

function resyncRetry(
  resyncGeneration: number,
  actorGeneration = ACTOR_GENERATION,
): FilePlaybackActorInput {
  return createFilePlaybackActorInput({
    schemaVersion: 1,
    kind: 'resync-retry',
    roomEpoch: ROOM_EPOCH,
    actorGeneration,
    resyncGeneration,
  });
}

function rendererLease(result: FilePlaybackRoomReduceResult): FilePlaybackEffectLease {
  const effect = result.effects.find((candidate) => candidate.kind === 'reconcile-renderer');
  if (!effect || effect.kind !== 'reconcile-renderer') {
    throw new Error('renderer effect is missing');
  }
  return effect.lease;
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((suffix) => [
      value,
      ...suffix,
    ]),
  );
}

describe('FilePlaybackRoomActor model', () => {
  it('commits room sequence and desired timeline without requiring renderer readiness', () => {
    const bound = reduceFilePlaybackActorInput(initial(), mediaEvent(1, 'event-1'));
    const played = reduceFilePlaybackActorInput(
      bound.state,
      timelineEvent(2, 'event-2', playIntent(), 2_000),
    );

    expect(bound).toMatchObject({ status: 'applied', reason: null });
    expect(played.state).toMatchObject({
      appliedSequence: 2,
      timeline: { phase: 'playing', anchorRoomTimeMs: 2_000 },
      media: MEDIA_1,
      rendererStatus: 'reconciling',
    });
    expect(played.effects.map((effect) => effect.kind)).toEqual(['reconcile-renderer']);
  });

  it('accepts desired playback before media exists and requests the exact queue item', () => {
    const played = reduceFilePlaybackActorInput(
      initial(),
      timelineEvent(1, 'event-1', playIntent(), 1_000),
    );

    expect(played).toMatchObject({ status: 'applied', reason: null });
    expect(played.state.resync).toBeNull();
    expect(played.effects.map((effect) => effect.kind)).toEqual([
      'reconcile-renderer',
      'request-media',
    ]);
    expect(played.effects[0]).toMatchObject({
      kind: 'reconcile-renderer',
      media: null,
    });
    expect(played.effects[1]).toMatchObject({
      kind: 'request-media',
      queueItemId: QUEUE_ITEM_1,
    });
  });

  it('never sends a stale media binding with a successor timeline to the renderer', () => {
    const bound = reduceFilePlaybackActorInput(initial(), mediaEvent(1, 'event-1', MEDIA_1));
    const switched = reduceFilePlaybackActorInput(
      bound.state,
      timelineEvent(2, 'event-2', playIntent(1, RUN_2), 2_000),
    );

    expect(switched.state).toMatchObject({
      timeline: { run: RUN_2 },
      media: null,
    });
    expect(switched.effects[0]).toMatchObject({
      kind: 'reconcile-renderer',
      timeline: { run: RUN_2 },
      media: null,
    });
    expect(switched.effects[1]).toMatchObject({
      kind: 'request-media',
      queueItemId: QUEUE_ITEM_2,
    });
  });

  it('requires both event ID and canonical payload for an exact duplicate', () => {
    const first = reduceFilePlaybackActorInput(initial(), mediaEvent(1, 'event-1', MEDIA_1));
    const duplicate = reduceFilePlaybackActorInput(first.state, mediaEvent(1, 'event-1', MEDIA_1));
    const conflictingPayload = reduceFilePlaybackActorInput(
      first.state,
      mediaEvent(1, 'event-1', MEDIA_2),
    );

    expect(duplicate).toMatchObject({ status: 'ignored', reason: 'duplicate' });
    expect(conflictingPayload).toMatchObject({
      status: 'resync-required',
      reason: 'sequence-conflict',
    });
  });

  it('advances sequence for the same semantic media without restarting the renderer', () => {
    const first = reduceFilePlaybackActorInput(initial(), mediaEvent(1, 'prepare-1'));
    const repeated = reduceFilePlaybackActorInput(first.state, mediaEvent(2, 'prepare-2'));

    expect(repeated).toMatchObject({ status: 'applied', reason: null, effects: [] });
    expect(repeated.state.appliedSequence).toBe(2);
    expect(repeated.state.effectSerial).toBe(first.state.effectSerial);
    expect(repeated.state.activeRendererLease).toEqual(first.state.activeRendererLease);
  });

  it('tracks the highest sequence observed during resync before accepting a snapshot', () => {
    const first = reduceFilePlaybackActorInput(initial(), mediaEvent(1, 'event-1'));
    const gap = reduceFilePlaybackActorInput(
      first.state,
      timelineEvent(3, 'event-3', playIntent()),
    );
    const later = reduceFilePlaybackActorInput(
      gap.state,
      timelineEvent(10, 'event-10', playIntent()),
    );
    const insufficient = reduceFilePlaybackActorInput(later.state, snapshotEvent(3, 'snapshot-3'));
    const recovered = reduceFilePlaybackActorInput(
      insufficient.state,
      snapshotEvent(10, 'snapshot-10'),
    );

    expect(gap.state.resync).toMatchObject({ highestObservedSequence: 3, requestAttempt: 1 });
    expect(later.state.resync).toMatchObject({ highestObservedSequence: 10, requestAttempt: 2 });
    expect(later.effects).toEqual([
      expect.objectContaining({
        kind: 'request-snapshot',
        highestObservedSequence: 10,
        attempt: 2,
      }),
    ]);
    expect(insufficient).toMatchObject({
      status: 'resync-required',
      reason: 'resync-pending',
    });
    expect(insufficient.state.resync).toMatchObject({
      highestObservedSequence: 10,
      requestAttempt: 3,
    });
    expect(recovered.state).toMatchObject({
      appliedSequence: 10,
      snapshotSequence: 10,
      resync: null,
      timeline: { phase: 'playing' },
    });
  });

  it('retries a lost snapshot request under the exact resync generation', () => {
    const gap = reduceFilePlaybackActorInput(initial(), timelineEvent(2, 'event-2', playIntent()));
    const generation = gap.state.resync?.generation;
    if (!generation) throw new Error('resync generation is missing');
    const retried = reduceFilePlaybackActorInput(gap.state, resyncRetry(generation));
    const staleRetry = reduceFilePlaybackActorInput(retried.state, resyncRetry(generation + 1));

    expect(retried.state.resync).toMatchObject({ requestAttempt: 2 });
    expect(retried.effects).toEqual([
      expect.objectContaining({ kind: 'request-snapshot', attempt: 2 }),
    ]);
    expect(staleRetry).toMatchObject({ status: 'ignored', reason: 'stale-local-event' });
  });

  it('bounds snapshot retries without closing or mutating the room timeline', () => {
    let state = reduceFilePlaybackActorInput(
      initial(),
      timelineEvent(2, 'event-2', playIntent()),
    ).state;
    const generation = state.resync?.generation;
    if (!generation) throw new Error('resync generation is missing');
    let last: FilePlaybackRoomReduceResult | null = null;
    for (let index = 0; index < 8; index += 1) {
      last = reduceFilePlaybackActorInput(state, resyncRetry(generation));
      state = last.state;
    }

    expect(last).toMatchObject({
      status: 'resync-required',
      reason: 'resync-retry-exhausted',
      effects: [],
    });
    expect(state.timeline.phase).toBe('stopped');
    expect(state.resync).toMatchObject({ requestAttempt: 8 });
  });

  it('converges across every media/play/pause delivery permutation', () => {
    const events = [
      mediaEvent(1, 'event-1'),
      timelineEvent(2, 'event-2', playIntent(), 2_000),
      timelineEvent(3, 'event-3', pauseIntent(), 3_000),
    ] as const;

    for (const deliveryOrder of permutations(events)) {
      let state = initial();
      for (const event of deliveryOrder) {
        state = reduceFilePlaybackActorInput(state, event).state;
      }
      if (state.resync) {
        state = reduceFilePlaybackActorInput(
          state,
          snapshotEvent(3, 'snapshot-3', pausedTimeline()),
        ).state;
      }
      for (const event of deliveryOrder) {
        state = reduceFilePlaybackActorInput(state, event).state;
      }

      expect(state).toMatchObject({
        appliedSequence: 3,
        snapshotSequence: state.snapshotSequence,
        resync: null,
        timeline: { phase: 'paused', revision: 2, run: RUN_1 },
        media: MEDIA_1,
      });
    }
  });

  it('uses canonical room time and rejects local-monotonic wire fields', () => {
    const wrongClockField = {
      schemaVersion: 1,
      roomEpoch: ROOM_EPOCH,
      sequence: 1,
      eventId: 'event-1',
      kind: 'timeline-transition',
      atMonotonicMs: 1_000,
      intent: playIntent(),
    };
    const rejected = reduceFilePlaybackActorInput(initial(), wrongClockField);
    const played = reduceFilePlaybackActorInput(
      initial(),
      timelineEvent(1, 'event-1', playIntent(), 2_000),
    );
    const backwards = reduceFilePlaybackActorInput(
      played.state,
      timelineEvent(2, 'event-2', pauseIntent(), 1_000),
    );

    expect(rejected).toMatchObject({ status: 'rejected', reason: 'invalid-event' });
    expect(played.state.timeline).toMatchObject({ anchorRoomTimeMs: 2_000 });
    expect(backwards).toMatchObject({
      status: 'resync-required',
      reason: 'timeline-conflict',
    });
  });

  it('restores a late join from one complete authoritative snapshot', () => {
    const restored = reduceFilePlaybackActorInput(
      initial(),
      snapshotEvent(12, 'late-join-snapshot'),
    );

    expect(restored.state).toMatchObject({
      appliedSequence: 12,
      snapshotSequence: 12,
      timeline: { phase: 'playing', revision: 1 },
      media: MEDIA_1,
      rendererStatus: 'reconciling',
    });
    expect(restored.effects.map((effect) => effect.kind)).toEqual(['reconcile-renderer']);
  });

  it('rejects regressive and internally inconsistent snapshots', () => {
    const current = reduceFilePlaybackActorInput(initial(), snapshotEvent(2, 'snapshot-2')).state;
    const regressive = reduceFilePlaybackActorInput(
      current,
      snapshotEvent(3, 'snapshot-3', stoppedTimeline(0, 3_000), null),
    );
    const inconsistent = reduceFilePlaybackActorInput(
      current,
      snapshotEvent(3, 'snapshot-3b', playingTimeline(RUN_1, 3_000), MEDIA_2),
    );

    expect(regressive).toMatchObject({ status: 'rejected', reason: 'regressive-snapshot' });
    expect(inconsistent).toMatchObject({
      status: 'rejected',
      reason: 'inconsistent-snapshot',
    });
    expect(regressive.state).toBe(current);
    expect(inconsistent.state).toBe(current);
  });

  it('keeps foreign room events outside the playback state boundary', () => {
    const state = initial();
    const reduced = reduceFilePlaybackActorInput(
      state,
      mediaEvent(1, 'foreign-1', MEDIA_1, 'room-epoch-2'),
    );

    expect(reduced).toMatchObject({ status: 'rejected', reason: 'foreign-room-epoch' });
    expect(reduced.state).toBe(state);
    expect(reduced.effects).toEqual([]);
  });

  it('canonicalizes a snapshot once without invoking timeline accessors', () => {
    const getter = vi.fn(() => {
      throw new Error('must not execute');
    });
    const timeline = Object.defineProperty(
      {
        schemaVersion: 1,
        revision: 1,
        phase: 'playing',
        run: RUN_1,
        positionSeconds: 0,
        rate: 1,
      },
      'anchorRoomTimeMs',
      { enumerable: true, get: getter },
    );
    const reduced = reduceFilePlaybackActorInput(initial(), {
      schemaVersion: 1,
      roomEpoch: ROOM_EPOCH,
      sequence: 1,
      eventId: 'snapshot-1',
      kind: 'snapshot',
      timeline,
      media: MEDIA_1,
    });

    expect(reduced).toMatchObject({ status: 'rejected', reason: 'invalid-event' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('admits only the exact active renderer lease and retires stale completion', () => {
    const bound = reduceFilePlaybackActorInput(initial(), mediaEvent(1, 'event-1'));
    const oldLease = rendererLease(bound);
    const played = reduceFilePlaybackActorInput(
      bound.state,
      timelineEvent(2, 'event-2', playIntent(), 2_000),
    );
    const currentLease = rendererLease(played);
    const stale = reduceFilePlaybackActorInput(played.state, rendererCompletion(oldLease, 'ready'));
    const completed = reduceFilePlaybackActorInput(
      stale.state,
      rendererCompletion(currentLease, 'ready'),
    );

    expect(stale).toMatchObject({ status: 'ignored', reason: 'stale-local-event' });
    expect(stale.effects).toEqual([
      expect.objectContaining({ kind: 'retire-stale-renderer', lease: oldLease }),
    ]);
    expect(stale.state).toBe(played.state);
    expect(completed.state).toMatchObject({
      rendererStatus: 'ready',
      activeRendererLease: null,
    });
  });

  it('fences an old actor generation even when its effect serial matches', () => {
    const bound = reduceFilePlaybackActorInput(initial(), mediaEvent(1, 'event-1'));
    const currentLease = rendererLease(bound);
    const oldLease = Object.freeze({
      ...currentLease,
      actorGeneration: 'actor-generation-old',
      effectId: 'actor-generation-old:renderer:1',
    });
    const stale = reduceFilePlaybackActorInput(
      bound.state,
      rendererCompletion(oldLease, 'ready', 'actor-generation-old'),
    );

    expect(stale).toMatchObject({ status: 'ignored', reason: 'stale-local-event' });
    expect(stale.state).toBe(bound.state);
    expect(stale.effects[0]).toMatchObject({ kind: 'retire-stale-renderer' });
  });

  it('constructs and owns its initial state instead of aliasing caller state', () => {
    const actor = new FilePlaybackRoomActor({
      roomEpoch: ROOM_EPOCH,
      actorGeneration: ACTOR_GENERATION,
    });

    expect(Object.isFrozen(actor.snapshot())).toBe(true);
    expect(actor.snapshot()).toMatchObject({
      roomEpoch: ROOM_EPOCH,
      actorGeneration: ACTOR_GENERATION,
      appliedSequence: 0,
    });
  });

  it('defers synchronous observer re-entry to the next actor microtask', async () => {
    let actor: FilePlaybackRoomActor;
    let reentered: Promise<FilePlaybackRoomReduceResult> | null = null;
    actor = new FilePlaybackRoomActor({
      roomEpoch: ROOM_EPOCH,
      actorGeneration: ACTOR_GENERATION,
      onResult: (observed) => {
        if (observed.state.appliedSequence === 1 && !reentered) {
          reentered = actor.dispatch(timelineEvent(2, 'event-2', playIntent(), 2_000));
        }
      },
    });

    const first = await actor.dispatch(mediaEvent(1, 'event-1'));
    expect(first.state.appliedSequence).toBe(1);
    expect(actor.snapshot().appliedSequence).toBe(1);
    const secondPromise = reentered as Promise<FilePlaybackRoomReduceResult> | null;
    if (!secondPromise) throw new Error('observer re-entry was not queued');
    const second = await secondPromise;

    expect(second.state.appliedSequence).toBe(2);
    expect(actor.snapshot().appliedSequence).toBe(2);
  });

  it('isolates observer failures and continues later actor events', async () => {
    const observerError = vi.fn();
    const actor = new FilePlaybackRoomActor({
      roomEpoch: ROOM_EPOCH,
      actorGeneration: ACTOR_GENERATION,
      onResult: () => {
        throw new Error('observer failed');
      },
      onObserverError: observerError,
    });

    const first = actor.dispatch(mediaEvent(1, 'event-1'));
    const second = actor.dispatch(timelineEvent(2, 'event-2', playIntent(), 2_000));
    await expect(first).resolves.toMatchObject({ status: 'applied' });
    await expect(second).resolves.toMatchObject({ status: 'applied' });
    expect(actor.snapshot().appliedSequence).toBe(2);
    expect(observerError).toHaveBeenCalledTimes(2);
  });

  it('bounds all unresolved work even while an observer queues the next batch', async () => {
    let actor: FilePlaybackRoomActor;
    let admittedReentry: Promise<FilePlaybackRoomReduceResult> | null = null;
    let rejectedReentry: Promise<FilePlaybackRoomReduceResult> | null = null;
    actor = new FilePlaybackRoomActor({
      roomEpoch: ROOM_EPOCH,
      actorGeneration: ACTOR_GENERATION,
      onResult: (observed) => {
        if (observed.state.appliedSequence === 1 && !admittedReentry) {
          admittedReentry = actor.dispatch(mediaEvent(257, 'event-257', MEDIA_1));
          rejectedReentry = actor.dispatch(mediaEvent(258, 'event-258', MEDIA_1));
        }
      },
    });
    const pending = Array.from({ length: 256 }, (_, index) =>
      actor.dispatch(mediaEvent(index + 1, `event-${index + 1}`, MEDIA_1)),
    );
    const initialOverflow = await actor.dispatch(mediaEvent(259, 'event-259', MEDIA_1));
    await Promise.all(pending);
    if (!admittedReentry || !rejectedReentry) {
      throw new Error('observer re-entry was not exercised');
    }
    const admitted = await admittedReentry;
    const rejected = await rejectedReentry;

    expect(initialOverflow).toMatchObject({ status: 'rejected', reason: 'inbox-overflow' });
    expect(admitted).toMatchObject({ status: 'applied', reason: null });
    expect(rejected).toMatchObject({ status: 'rejected', reason: 'inbox-overflow' });
    expect(actor.snapshot().appliedSequence).toBe(257);
  });
});
