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
  timelineFromFilePlaybackTimelineUpdateV2,
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

function update(): Readonly<FilePlaybackTimelineUpdateV2> {
  return createFilePlaybackTimelineUpdateV2(playingInput());
}

describe('FILE_PLAYBACK_TIMELINE_UPDATE_V2 auxiliary contract', () => {
  it('creates one flat, primitive-only, frozen canonical update', () => {
    const dateNow = vi.spyOn(Date, 'now');
    const value = update();

    expect(value).toEqual({
      type: FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE,
      protocolVersion: FILE_PLAYBACK_TIMELINE_UPDATE_V2_PROTOCOL_VERSION,
      sessionId: SESSION_ID,
      connectionId: CONNECTION_ID,
      roomGeneration: 3,
      revision: 9,
      phase: 'playing',
      queueItemId: QUEUE_ITEM_ID,
      runId: RUN_ID,
      positionSeconds: 12.5,
      anchorRoomTimeMs: 8_000,
      rate: 1,
    });
    expect(Object.values(value).every((item) => item === null || typeof item !== 'object')).toBe(
      true,
    );
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.isFrozen(value)).toBe(true);
    expect(dateNow).not.toHaveBeenCalled();
    dateNow.mockRestore();
  });

  it('round-trips JSON and reconstructs the canonical timeline', () => {
    const value = update();
    const serialized = serializeFilePlaybackTimelineUpdateV2(value);

    expect(FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_RAW_FRAME_BYTES).toBe(4 * 1024);
    expect(FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_FRAME_BYTES).toBe(4 * 1024);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(4 * 1024);
    expect(parseFilePlaybackTimelineUpdateV2(JSON.parse(serialized))).toEqual(value);
    expect(timelineFromFilePlaybackTimelineUpdateV2(value)).toEqual(playingInput().timeline);
  });

  it('allows null run fields only for an exact stopped timeline', () => {
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
    expect(stopped).toMatchObject({ phase: 'stopped', queueItemId: null, runId: null });
    for (const candidate of [
      { ...stopped, phase: 'paused' },
      { ...stopped, queueItemId: QUEUE_ITEM_ID },
      { ...stopped, runId: RUN_ID },
      { ...stopped, positionSeconds: 0.1 },
      { ...stopped, rate: 1.1 },
    ]) {
      expect(parseFilePlaybackTimelineUpdateV2(candidate)).toBeNull();
    }
  });

  it('rejects wrong scope, versions, generations, values, and extra fields', () => {
    const value = update();
    const invalid = [
      { ...value, type: 'FILE_PLAYBACK_TIMELINE_UPDATE_V1' },
      { ...value, protocolVersion: 1 },
      { ...value, sessionId: '' },
      { ...value, connectionId: SESSION_ID },
      { ...value, roomGeneration: 0 },
      { ...value, revision: 0 },
      { ...value, queueItemId: null },
      { ...value, runId: null },
      { ...value, positionSeconds: Number.NaN },
      { ...value, anchorRoomTimeMs: -1 },
      { ...value, rate: 0 },
      { ...value, extra: true },
    ];
    for (const candidate of invalid)
      expect(parseFilePlaybackTimelineUpdateV2(candidate)).toBeNull();
  });

  it('never invokes accessors and rejects non-plain records', () => {
    const canonical = update();
    let reads = 0;
    const accessor = { ...canonical } as Record<string, unknown>;
    Object.defineProperty(accessor, 'revision', {
      enumerable: true,
      get() {
        reads += 1;
        return 9;
      },
    });
    expect(parseFilePlaybackTimelineUpdateV2(accessor)).toBeNull();
    expect(reads).toBe(0);
    expect(parseFilePlaybackTimelineUpdateV2(Object.assign([], canonical))).toBeNull();
    expect(parseFilePlaybackTimelineUpdateV2(Object.assign(new Date(), canonical))).toBeNull();
    expect(parseFilePlaybackTimelineUpdateV2({ ...canonical, [Symbol('extra')]: true })).toBeNull();
  });

  it('recognizes only exact primitive replays', () => {
    const first = update();
    const replay = parseFilePlaybackTimelineUpdateV2(JSON.parse(JSON.stringify(first)));
    expect(isFilePlaybackTimelineUpdateV2Replay(first, replay)).toBe(true);
    expect(isFilePlaybackTimelineUpdateV2Replay(first, { ...first, anchorRoomTimeMs: 8_001 })).toBe(
      false,
    );
    expect(isFilePlaybackTimelineUpdateV2Replay(first, { ...first, extra: true })).toBe(false);
  });

  it('requires the exact nested input shape before flattening', () => {
    expect(() =>
      createFilePlaybackTimelineUpdateV2({ ...playingInput(), extra: true } as never),
    ).toThrow('input is invalid');
    expect(() =>
      createFilePlaybackTimelineUpdateV2({
        ...playingInput(),
        timeline: { ...playingInput().timeline, extra: true } as never,
      }),
    ).toThrow('input is invalid');
  });
});
