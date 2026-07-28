import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FILE_PLAYBACK_RUN_BINDING_V2_MAX_RAW_FRAME_BYTES,
  FILE_PLAYBACK_RUN_BINDING_V2_TYPE,
} from '../../network/file-playback-transport-contract.ts';
import type { QueueItemId } from '../../types/index.ts';
import { createFilePlaybackMediaScope } from '../file-playback-media-scope.ts';
import {
  createFilePlaybackRunBindingV2,
  createFilePlaybackRunId,
  FILE_PLAYBACK_RUN_BINDING_V2_MAX_FRAME_BYTES,
  FILE_PLAYBACK_RUN_BINDING_V2_PROTOCOL_VERSION,
  parseFilePlaybackRunBindingV2,
  serializeFilePlaybackRunBindingV2,
  type FilePlaybackRunBindingV2,
  type FilePlaybackRunBindingV2Input,
} from '../file-playback-run-binding.ts';

const SESSION_ID = 'session:alpha';
const CONNECTION_ID = 'connection:alpha';
const QID = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const PREPARE_ID = '00000000-0000-4000-8000-000000000011';
const RUN_ID = '00000000-0000-4000-8000-000000000021';

function mediaScope(queueItemId = QID) {
  return createFilePlaybackMediaScope(SESSION_ID, queueItemId);
}

function rawBinding(overrides: Partial<FilePlaybackRunBindingV2> = {}): FilePlaybackRunBindingV2 {
  const media = mediaScope();
  return {
    protocolVersion: FILE_PLAYBACK_RUN_BINDING_V2_PROTOCOL_VERSION,
    type: FILE_PLAYBACK_RUN_BINDING_V2_TYPE,
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    prepareId: PREPARE_ID,
    prepareRevision: 2,
    queueItemId: QID,
    sourceIdentity: media.sourceIdentity,
    transferSessionId: media.transferSessionId,
    runId: RUN_ID,
    playbackRevision: 7,
    ...overrides,
  };
}

function binding(
  overrides: Partial<FilePlaybackRunBindingV2> = {},
): Readonly<FilePlaybackRunBindingV2> {
  const parsed = parseFilePlaybackRunBindingV2(rawBinding(overrides));
  if (!parsed) throw new Error('test run binding was invalid');
  return parsed;
}

function creatorInput(): FilePlaybackRunBindingV2Input {
  const value = rawBinding();
  return {
    sessionId: value.sessionId,
    connectionId: value.connectionId,
    prepareId: value.prepareId,
    prepareRevision: value.prepareRevision,
    queueItemId: value.queueItemId,
    sourceIdentity: value.sourceIdentity,
    transferSessionId: value.transferSessionId,
    runId: value.runId,
    playbackRevision: value.playbackRevision,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FilePlaybackRunBindingV2 wire contract', () => {
  it('creates one canonical preparation-to-run binding without rendezvous or codec state', () => {
    const randomUUID = vi.fn(() => '00000000-0000-4000-8000-000000000099');
    vi.stubGlobal('crypto', { randomUUID });
    const value = createFilePlaybackRunBindingV2(creatorInput());
    const serialized = serializeFilePlaybackRunBindingV2(value);

    expect(value).toEqual(rawBinding());
    expect(value.runId).toBe(RUN_ID);
    expect(randomUUID).not.toHaveBeenCalled();
    expect(value.transferSessionId).toContain(QID);
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.isFrozen(value)).toBe(true);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
      FILE_PLAYBACK_RUN_BINDING_V2_MAX_FRAME_BYTES,
    );
    expect(serialized).not.toMatch(
      /rendezvousId|startAt|position|codec|sampleRate|channelCount|duration/u,
    );
    expect(parseFilePlaybackRunBindingV2(JSON.parse(serialized))).toEqual(value);
  });

  it('reuses one caller-owned run ID across independent connection preparation scopes', () => {
    const firstInput = creatorInput();
    const secondInput: FilePlaybackRunBindingV2Input = {
      ...firstInput,
      connectionId: 'connection:beta',
      prepareId: '00000000-0000-4000-8000-000000000012',
      prepareRevision: 1,
    };

    const first = createFilePlaybackRunBindingV2(firstInput);
    const second = createFilePlaybackRunBindingV2(secondInput);

    expect(first.runId).toBe(RUN_ID);
    expect(second.runId).toBe(RUN_ID);
    expect(first.sessionId).toBe(second.sessionId);
    expect(first.connectionId).not.toBe(second.connectionId);
    expect(first.prepareId).not.toBe(second.prepareId);
    expect(parseFilePlaybackRunBindingV2(first)).toEqual(first);
    expect(parseFilePlaybackRunBindingV2(second)).toEqual(second);
  });

  it('requires an exact descriptor-safe caller input and is idempotent after validation', () => {
    const input = creatorInput();
    const first = createFilePlaybackRunBindingV2(input);
    const recreated = createFilePlaybackRunBindingV2({
      sessionId: first.sessionId,
      connectionId: first.connectionId,
      prepareId: first.prepareId,
      prepareRevision: first.prepareRevision,
      queueItemId: first.queueItemId,
      sourceIdentity: first.sourceIdentity,
      transferSessionId: first.transferSessionId,
      runId: first.runId,
      playbackRevision: first.playbackRevision,
    });
    expect(recreated).toEqual(first);

    let getterCalls = 0;
    const accessor = { ...input };
    Object.defineProperty(accessor, 'runId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return RUN_ID;
      },
    });
    expect(() => createFilePlaybackRunBindingV2(accessor)).toThrow('input is invalid');
    expect(getterCalls).toBe(0);
    expect(() =>
      createFilePlaybackRunBindingV2({ ...input, extra: true } as FilePlaybackRunBindingV2Input),
    ).toThrow('input is invalid');
    const { runId: omittedRunId, ...missingRunId } = input;
    expect(omittedRunId).toBe(RUN_ID);
    expect(() =>
      createFilePlaybackRunBindingV2(missingRunId as FilePlaybackRunBindingV2Input),
    ).toThrow('input is invalid');
  });

  it('keeps a reentrant creator call isolated from the outer caller-owned run binding', () => {
    const outerInput = creatorInput();
    let nested: Readonly<FilePlaybackRunBindingV2> | null = null;
    const proxied = new Proxy(outerInput, {
      ownKeys(target) {
        nested = createFilePlaybackRunBindingV2({
          ...target,
          connectionId: 'connection:nested',
          prepareId: '00000000-0000-4000-8000-000000000013',
        });
        return Reflect.ownKeys(target);
      },
    });

    const outer = createFilePlaybackRunBindingV2(proxied);

    expect(outer).toMatchObject({ connectionId: CONNECTION_ID, runId: RUN_ID });
    expect(nested).toMatchObject({ connectionId: 'connection:nested', runId: RUN_ID });
  });

  it('requires exact own enumerable plain data fields without invoking accessors', () => {
    const base = { ...binding() } as Record<PropertyKey, unknown>;
    let getterCalls = 0;
    Object.defineProperty(base, 'runId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return RUN_ID;
      },
    });
    expect(parseFilePlaybackRunBindingV2(base)).toBeNull();
    expect(getterCalls).toBe(0);

    expect(parseFilePlaybackRunBindingV2({ ...binding(), unexpected: true })).toBeNull();
    expect(
      parseFilePlaybackRunBindingV2({ ...binding(), rendezvousId: 'rendezvous:wrong' }),
    ).toBeNull();
    expect(parseFilePlaybackRunBindingV2({ ...binding(), [Symbol('extra')]: true })).toBeNull();
    expect(parseFilePlaybackRunBindingV2(Object.assign([], binding()))).toBeNull();
    expect(parseFilePlaybackRunBindingV2(Object.assign(new Date(), binding()))).toBeNull();

    const hidden = { ...binding() };
    Object.defineProperty(hidden, 'sourceIdentity', {
      value: hidden.sourceIdentity,
      enumerable: false,
    });
    expect(parseFilePlaybackRunBindingV2(hidden)).toBeNull();

    const inherited = Object.assign(Object.create({ inherited: true }), binding());
    expect(parseFilePlaybackRunBindingV2(inherited)).toBeNull();
  });

  it('keeps canonical and raw pre-materialization byte budgets as separate contracts', () => {
    const serialized = serializeFilePlaybackRunBindingV2(binding());
    const paddedRaw = `${' '.repeat(FILE_PLAYBACK_RUN_BINDING_V2_MAX_RAW_FRAME_BYTES + 1)}${serialized}`;

    expect(FILE_PLAYBACK_RUN_BINDING_V2_MAX_RAW_FRAME_BYTES).toBe(4 * 1024);
    expect(new TextEncoder().encode(paddedRaw).byteLength).toBeGreaterThan(
      FILE_PLAYBACK_RUN_BINDING_V2_MAX_RAW_FRAME_BYTES,
    );
    expect(parseFilePlaybackRunBindingV2(paddedRaw)).toBeNull();
    // Once an adapter has incorrectly materialized an oversized raw frame,
    // only the bounded canonical object remains observable to this parser.
    expect(parseFilePlaybackRunBindingV2(JSON.parse(paddedRaw))).toEqual(binding());
  });

  it('validates strict IDs, revisions, and only exact authority aliasing', () => {
    const invalid: ReadonlyArray<Partial<FilePlaybackRunBindingV2>> = [
      { sessionId: 'bad session' },
      { connectionId: SESSION_ID },
      { prepareId: 'prepare:not-a-uuid' },
      { prepareRevision: 0 },
      { prepareRevision: 1.5 },
      { queueItemId: 'queue:not-a-uuid' },
      { sourceIdentity: ' source:trimmed' },
      { transferSessionId: 'transfer:\u0000control' },
      { runId: 'run:not-a-uuid' },
      { playbackRevision: -1 },
      { playbackRevision: 0 },
      { playbackRevision: -0 },
      { playbackRevision: 1.5 },
      { prepareId: QID },
      { runId: PREPARE_ID },
      { runId: QID },
      { sessionId: RUN_ID },
      { connectionId: RUN_ID },
      { sourceIdentity: RUN_ID },
      { transferSessionId: RUN_ID },
      { transferSessionId: mediaScope().sourceIdentity },
    ];

    for (const mutation of invalid) {
      expect(parseFilePlaybackRunBindingV2(rawBinding(mutation))).toBeNull();
    }

    expect(binding().transferSessionId).toBe(`mxq:s:${SESSION_ID}:q:${QID}`);
  });

  it('uses UUIDv4 CSPRNG sources only and fails when secure randomness is unavailable', () => {
    expect(createFilePlaybackRunId({ randomUUID: () => RUN_ID })).toBe(RUN_ID);
    expect(() => createFilePlaybackRunId({ randomUUID: () => 'not-a-uuid' })).toThrow(
      'invalid UUID',
    );

    expect(
      createFilePlaybackRunId({
        getRandomValues(array) {
          array.forEach((_value, index) => {
            array[index] = index;
          });
          return array;
        },
      }),
    ).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');

    const mathRandom = vi.spyOn(Math, 'random');
    expect(() => createFilePlaybackRunId(null)).toThrow('unavailable');
    expect(mathRandom).not.toHaveBeenCalled();

    vi.stubGlobal('crypto', undefined);
    expect(() => createFilePlaybackRunId()).toThrow('unavailable');
    expect(createFilePlaybackRunBindingV2(creatorInput())).toEqual(rawBinding());
  });
});
