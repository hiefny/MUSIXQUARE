import type { QueueItemId } from '../../types/index.ts';
import {
  createFilePlaybackProductBaselineV2,
  createFilePlaybackProductReadyV2,
  parseFilePlaybackProductBaselineV2,
  parseFilePlaybackProductReadyV2,
  serializeFilePlaybackProductFrameV2,
} from '../file-playback-product-baseline.ts';

const SESSION_ID = 'session-product';
const CONNECTION_ID = 'connection-product';
const BASELINE_ID = 'baseline-product';
const HOST_ID = 'host-product';
const GUEST_ID = 'guest-product';
const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000071' as QueueItemId;
const RUN_ID = '00000000-0000-4000-8000-000000000072';

function playingInput() {
  return {
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    baselineId: BASELINE_ID,
    hostParticipantId: HOST_ID,
    guestParticipantId: GUEST_ID,
    playbackRevision: 7,
    phase: 'playing' as const,
    queueItemId: QUEUE_ITEM_ID,
    runId: RUN_ID,
    positionSeconds: 12.5,
    rate: 1,
    anchorRoomTimeMs: 4_000,
  };
}

function readyInput() {
  return {
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    baselineId: BASELINE_ID,
    guestParticipantId: GUEST_ID,
    playbackRevision: 7,
    observedAtRoomTimeMs: 4_100,
  };
}

describe('file playback product baseline v2', () => {
  it('creates a detached immutable playing baseline and round-trips JSON', () => {
    const input = playingInput();
    const baseline = createFilePlaybackProductBaselineV2(input);

    expect(baseline).toMatchObject({
      protocolVersion: 2,
      type: 'FILE_PLAYBACK_PRODUCT_BASELINE_V2',
      ...input,
    });
    expect(baseline).not.toBe(input);
    expect(Object.getPrototypeOf(baseline)).toBeNull();
    expect(Object.isFrozen(baseline)).toBe(true);
    expect(parseFilePlaybackProductBaselineV2(JSON.parse(JSON.stringify(baseline)))).toEqual(
      baseline,
    );
    expect(JSON.parse(serializeFilePlaybackProductFrameV2(baseline))).toEqual(baseline);
  });

  it('represents a stopped watermark without inventing a run', () => {
    const baseline = createFilePlaybackProductBaselineV2({
      ...playingInput(),
      playbackRevision: 0,
      phase: 'stopped',
      queueItemId: null,
      runId: null,
      positionSeconds: 0,
      rate: 1,
    });

    expect(baseline).toMatchObject({
      playbackRevision: 0,
      phase: 'stopped',
      queueItemId: null,
      runId: null,
      positionSeconds: 0,
    });
  });

  it('rejects inconsistent stopped and active identities', () => {
    expect(
      parseFilePlaybackProductBaselineV2({
        ...createFilePlaybackProductBaselineV2(playingInput()),
        phase: 'stopped',
      }),
    ).toBeNull();
    expect(
      parseFilePlaybackProductBaselineV2({
        ...createFilePlaybackProductBaselineV2(playingInput()),
        queueItemId: null,
      }),
    ).toBeNull();
    expect(
      parseFilePlaybackProductBaselineV2({
        ...createFilePlaybackProductBaselineV2(playingInput()),
        playbackRevision: 0,
      }),
    ).toBeNull();
  });

  it('rejects extra keys, accessors, non-finite values, and aliased session scope', () => {
    const canonical = createFilePlaybackProductBaselineV2(playingInput());
    expect(parseFilePlaybackProductBaselineV2({ ...canonical, extra: true })).toBeNull();
    expect(
      parseFilePlaybackProductBaselineV2({ ...canonical, positionSeconds: Number.NaN }),
    ).toBeNull();
    expect(
      parseFilePlaybackProductBaselineV2({ ...canonical, connectionId: SESSION_ID }),
    ).toBeNull();
    expect(
      parseFilePlaybackProductBaselineV2({ ...canonical, baselineId: CONNECTION_ID }),
    ).toBeNull();
    expect(parseFilePlaybackProductBaselineV2({ ...canonical, runId: QUEUE_ITEM_ID })).toBeNull();

    let getterReads = 0;
    const hostile = { ...canonical } as Record<string, unknown>;
    Object.defineProperty(hostile, 'runId', {
      enumerable: true,
      get() {
        getterReads += 1;
        return RUN_ID;
      },
    });
    expect(parseFilePlaybackProductBaselineV2(hostile)).toBeNull();
    expect(getterReads).toBe(0);
  });

  it('creates an exact ready echo and rejects malformed correlation', () => {
    const ready = createFilePlaybackProductReadyV2(readyInput());
    expect(ready).toMatchObject({
      protocolVersion: 2,
      type: 'FILE_PLAYBACK_PRODUCT_READY_V2',
      ...readyInput(),
    });
    expect(Object.getPrototypeOf(ready)).toBeNull();
    expect(Object.isFrozen(ready)).toBe(true);
    expect(parseFilePlaybackProductReadyV2(JSON.parse(JSON.stringify(ready)))).toEqual(ready);
    expect(parseFilePlaybackProductReadyV2({ ...ready, playbackRevision: -1 })).toBeNull();
    expect(parseFilePlaybackProductReadyV2({ ...ready, baselineId: '' })).toBeNull();
    expect(parseFilePlaybackProductReadyV2({ ...ready, baselineId: CONNECTION_ID })).toBeNull();
    expect(parseFilePlaybackProductReadyV2({ ...ready, nested: null })).toBeNull();
  });

  it('snapshots create inputs without invoking accessors or accepting extras', () => {
    const input = playingInput() as ReturnType<typeof playingInput> & Record<string, unknown>;
    let getterReads = 0;
    Object.defineProperty(input, 'phase', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'playing';
      },
    });
    expect(() => createFilePlaybackProductBaselineV2(input)).toThrow('input is invalid');
    expect(getterReads).toBe(0);
    expect(() =>
      createFilePlaybackProductReadyV2({ ...readyInput(), extra: true } as never),
    ).toThrow('input is invalid');
  });
});
