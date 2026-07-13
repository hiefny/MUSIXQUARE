import { describe, expect, it, vi } from 'vitest';

import {
  FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_RAW_FRAME_BYTES,
  FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE,
} from '../../network/file-playback-transport-contract.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  createFilePlaybackTimelineUpdateV2,
  FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_FRAME_BYTES,
  FILE_PLAYBACK_TIMELINE_UPDATE_V2_PROTOCOL_VERSION,
  isFilePlaybackTimelineUpdateV2Replay,
  parseFilePlaybackTimelineUpdateV2,
  serializeFilePlaybackTimelineUpdateV2,
  type FilePlaybackTimelineUpdateV2,
  type FilePlaybackTimelineUpdateV2Input,
} from '../file-playback-timeline-update.ts';

const SESSION_ID = 'session-timeline-update';
const CONNECTION_ID = 'connection-timeline-update';
const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000091' as QueueItemId;
const RUN_ID = '00000000-0000-4000-8000-000000000092';

function playingInput(): FilePlaybackTimelineUpdateV2Input {
  return {
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    roomGeneration: 3,
    timeline: {
      schemaVersion: 1,
      revision: 9,
      phase: 'playing',
      run: { queueItemId: QUEUE_ITEM_ID, runId: RUN_ID },
      positionSeconds: 12.5,
      anchorMonotonicMs: 8_000,
      rate: 1,
    },
  };
}

function update(
  overrides: Partial<FilePlaybackTimelineUpdateV2> = {},
): Readonly<FilePlaybackTimelineUpdateV2> {
  const base = createFilePlaybackTimelineUpdateV2(playingInput());
  const parsed = parseFilePlaybackTimelineUpdateV2({ ...base, ...overrides });
  if (!parsed) throw new Error('test timeline update was invalid');
  return parsed;
}

describe('FILE_PLAYBACK_TIMELINE_UPDATE_V2 auxiliary contract', () => {
  it('creates a detached, deeply immutable, body-free canonical update', () => {
    const dateNow = vi.spyOn(Date, 'now');
    const input = playingInput();
    const value = createFilePlaybackTimelineUpdateV2(input);
    const serialized = serializeFilePlaybackTimelineUpdateV2(value);

    expect(value).toEqual({
      type: FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE,
      protocolVersion: FILE_PLAYBACK_TIMELINE_UPDATE_V2_PROTOCOL_VERSION,
      ...input,
    });
    expect(value).not.toBe(input);
    expect(value.timeline).not.toBe(input.timeline);
    expect(value.timeline.run).not.toBe(input.timeline.run);
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.getPrototypeOf(value.timeline)).toBeNull();
    expect(Object.getPrototypeOf(value.timeline.run)).toBeNull();
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.timeline)).toBe(true);
    expect(Object.isFrozen(value.timeline.run)).toBe(true);
    expect(serialized).not.toMatch(/blob|bytes|buffer|codec|url|payload|rendezvous/iu);
    expect(dateNow).not.toHaveBeenCalled();
    dateNow.mockRestore();
  });

  it('round-trips canonical JSON within the raw and canonical byte budgets', () => {
    const value = update();
    const serialized = serializeFilePlaybackTimelineUpdateV2(value);

    expect(FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_RAW_FRAME_BYTES).toBe(4 * 1024);
    expect(FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_FRAME_BYTES).toBe(4 * 1024);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
      FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_FRAME_BYTES,
    );
    expect(parseFilePlaybackTimelineUpdateV2(JSON.parse(serialized))).toEqual(value);
  });

  it('allows a null run only for the exact stopped timeline', () => {
    const stopped = createFilePlaybackTimelineUpdateV2({
      ...playingInput(),
      timeline: {
        schemaVersion: 1,
        revision: 10,
        phase: 'stopped',
        run: null,
        positionSeconds: 0,
        anchorMonotonicMs: 9_000,
        rate: 1,
      },
    });

    expect(stopped.timeline).toMatchObject({ phase: 'stopped', run: null });
    expect(
      parseFilePlaybackTimelineUpdateV2({
        ...stopped,
        timeline: { ...stopped.timeline, phase: 'paused' },
      }),
    ).toBeNull();
    expect(
      parseFilePlaybackTimelineUpdateV2({
        ...stopped,
        timeline: {
          ...stopped.timeline,
          run: { queueItemId: QUEUE_ITEM_ID, runId: RUN_ID },
        },
      }),
    ).toBeNull();
    expect(
      parseFilePlaybackTimelineUpdateV2({
        ...stopped,
        timeline: { ...stopped.timeline, positionSeconds: 0.1 },
      }),
    ).toBeNull();
    expect(
      parseFilePlaybackTimelineUpdateV2({
        ...stopped,
        timeline: { ...stopped.timeline, rate: 1.1 },
      }),
    ).toBeNull();
  });

  it('rejects wrong scope, versions, generations, timeline values, and extra fields', () => {
    const value = update();
    const invalid: readonly unknown[] = [
      { ...value, type: 'FILE_PLAYBACK_TIMELINE_UPDATE_V1' },
      { ...value, protocolVersion: 1 },
      { ...value, sessionId: '' },
      { ...value, connectionId: SESSION_ID },
      { ...value, roomGeneration: 0 },
      { ...value, roomGeneration: 1.5 },
      { ...value, extra: true },
      { ...value, timeline: { ...value.timeline, schemaVersion: 2 } },
      { ...value, timeline: { ...value.timeline, revision: 0 } },
      { ...value, timeline: { ...value.timeline, positionSeconds: Number.NaN } },
      { ...value, timeline: { ...value.timeline, anchorMonotonicMs: -1 } },
      { ...value, timeline: { ...value.timeline, rate: 0 } },
      { ...value, timeline: { ...value.timeline, extra: true } },
      { ...value, timeline: { ...value.timeline, run: null } },
    ];

    for (const candidate of invalid) {
      expect(parseFilePlaybackTimelineUpdateV2(candidate)).toBeNull();
    }
  });

  it('does not invoke outer, timeline, or run accessors while parsing or creating', () => {
    const canonical = update();
    let getterReads = 0;
    const outer = { ...canonical } as Record<string, unknown>;
    Object.defineProperty(outer, 'timeline', {
      enumerable: true,
      get() {
        getterReads += 1;
        return canonical.timeline;
      },
    });
    expect(parseFilePlaybackTimelineUpdateV2(outer)).toBeNull();

    const timeline = { ...canonical.timeline } as Record<string, unknown>;
    Object.defineProperty(timeline, 'run', {
      enumerable: true,
      get() {
        getterReads += 1;
        return canonical.timeline.run;
      },
    });
    expect(parseFilePlaybackTimelineUpdateV2({ ...canonical, timeline })).toBeNull();

    const run = { ...canonical.timeline.run } as Record<string, unknown>;
    Object.defineProperty(run, 'runId', {
      enumerable: true,
      get() {
        getterReads += 1;
        return RUN_ID;
      },
    });
    expect(
      parseFilePlaybackTimelineUpdateV2({
        ...canonical,
        timeline: { ...canonical.timeline, run },
      }),
    ).toBeNull();
    expect(getterReads).toBe(0);

    expect(() => createFilePlaybackTimelineUpdateV2(outer as never)).toThrow('input is invalid');
    expect(getterReads).toBe(0);
  });

  it('recognizes only exact canonical replays', () => {
    const first = update();
    const replay = parseFilePlaybackTimelineUpdateV2(JSON.parse(JSON.stringify(first)));

    expect(isFilePlaybackTimelineUpdateV2Replay(first, replay)).toBe(true);
    expect(
      isFilePlaybackTimelineUpdateV2Replay(first, {
        ...first,
        timeline: { ...first.timeline, anchorMonotonicMs: 8_001 },
      }),
    ).toBe(false);
    expect(
      isFilePlaybackTimelineUpdateV2Replay(first, { ...first, connectionId: 'connection-other' }),
    ).toBe(false);
    expect(isFilePlaybackTimelineUpdateV2Replay(first, { ...first, extra: true })).toBe(false);
  });

  it('rejects non-plain records and exact input shape violations', () => {
    const canonical = update();
    expect(parseFilePlaybackTimelineUpdateV2(Object.assign([], canonical))).toBeNull();
    expect(parseFilePlaybackTimelineUpdateV2(Object.assign(new Date(), canonical))).toBeNull();
    expect(
      parseFilePlaybackTimelineUpdateV2(
        Object.assign(Object.create({ inherited: true }), canonical),
      ),
    ).toBeNull();
    expect(parseFilePlaybackTimelineUpdateV2({ ...canonical, [Symbol('extra')]: true })).toBeNull();
    expect(() =>
      createFilePlaybackTimelineUpdateV2({ ...playingInput(), extra: true } as never),
    ).toThrow('input is invalid');
  });
});
