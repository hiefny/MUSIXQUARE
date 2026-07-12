import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  createAudioBufferPlaybackStartEvidence,
  createFilePlaybackCutoverTarget,
  createFilePlaybackScheduledTransitionResult,
  createFilePlaybackSourceSnapshot,
  createFilePlaybackTransitionEvidence,
  createStreamingFlacPlaybackStartEvidence,
  isFilePlaybackSourceSnapshot,
  readFilePlaybackCutoverTarget,
  readFilePlaybackCancelIntent,
  readFilePlaybackPauseIntent,
  readFilePlaybackPauseTransitionIntent,
  readFilePlaybackSeekIntent,
  readFilePlaybackSeekTransitionIntent,
  readFilePlaybackStartEvidence,
  readFilePlaybackTransitionEvidence,
  readFilePlaybackTransitionResult,
  sourceOwnsRevisionedRun,
  type FilePlaybackSource,
  type FilePlaybackSourceSnapshot,
} from '../file-playback-source.ts';
import type { RevisionedPlaybackRun } from '../rendezvous-contract.ts';

const QID = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const OTHER_QID = '00000000-0000-4000-8000-000000000002' as QueueItemId;
const RUN: RevisionedPlaybackRun = { queueItemId: QID, runId: 'run-3', revision: 3 };

function snapshot(overrides: Partial<FilePlaybackSourceSnapshot> = {}): FilePlaybackSourceSnapshot {
  return {
    schemaVersion: 1,
    queueItemId: QID,
    backend: 'streaming-flac',
    phase: 'playing',
    revision: 3,
    run: RUN,
    durationSeconds: 554.893,
    positionSeconds: 12.25,
    bufferedAheadSeconds: 9.5,
    outputSampleRateHz: 48_000,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
    ...overrides,
  };
}

describe('file playback source contract', () => {
  it.each(['audio-buffer', 'streaming-flac'] as const)(
    'accepts a JSON-safe %s backend snapshot',
    (backend) => {
      const value = snapshot({ backend });
      expect(isFilePlaybackSourceSnapshot(value)).toBe(true);
      expect(isFilePlaybackSourceSnapshot(JSON.parse(JSON.stringify(value)))).toBe(true);
    },
  );

  it('copies and deeply freezes state before publication', () => {
    const input = snapshot();
    const published = createFilePlaybackSourceSnapshot(input);

    expect(published).not.toBe(input);
    expect(published.run).not.toBe(input.run);
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.run)).toBe(true);
    expect(published).toEqual(input);
  });

  it('rejects accessor snapshots without invoking application code', () => {
    let getterCalls = 0;
    const accessor = { ...snapshot() };
    Object.defineProperty(accessor, 'queueItemId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return QID;
      },
    });

    expect(isFilePlaybackSourceSnapshot(accessor)).toBe(false);
    expect(() => createFilePlaybackSourceSnapshot(accessor)).toThrow(TypeError);
    expect(getterCalls).toBe(0);
  });

  it('publishes one detached descriptor snapshot under Proxy reentry and hostile gets', () => {
    const input = snapshot();
    let getCalls = 0;
    let reentryCalls = 0;
    const proxied = new Proxy(input, {
      get() {
        getCalls += 1;
        throw new Error('dynamic [[Get]] must not run');
      },
      ownKeys(target) {
        reentryCalls += 1;
        const nested = createFilePlaybackSourceSnapshot(
          snapshot({ phase: 'ready', revision: 0, run: null, positionSeconds: 0 }),
        );
        expect(nested.phase).toBe('ready');
        return Reflect.ownKeys(target);
      },
    });

    const published = createFilePlaybackSourceSnapshot(proxied);
    expect(published).toEqual(input);
    expect(published).not.toBe(input);
    expect(Object.is(published, proxied)).toBe(false);
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.getPrototypeOf(published.run)).toBeNull();
    expect(getCalls).toBe(0);
    expect(reentryCalls).toBe(1);
  });

  it('rejects unexpected native/runtime fields instead of publishing them globally', () => {
    const withNativeObject = {
      ...snapshot(),
      audioNode: { connect: vi.fn() },
    };
    expect(isFilePlaybackSourceSnapshot(withNativeObject)).toBe(false);
    expect(() =>
      createFilePlaybackSourceSnapshot(withNativeObject as FilePlaybackSourceSnapshot),
    ).toThrow(TypeError);

    const hiddenSymbol = snapshot() as FilePlaybackSourceSnapshot & { [key: symbol]: unknown };
    Object.defineProperty(hiddenSymbol, Symbol('native'), { value: {}, enumerable: false });
    expect(isFilePlaybackSourceSnapshot(hiddenSymbol)).toBe(false);
  });

  it('enforces the immutable queue occurrence and revision association', () => {
    expect(
      isFilePlaybackSourceSnapshot(snapshot({ run: { ...RUN, queueItemId: OTHER_QID } })),
    ).toBe(false);
    expect(isFilePlaybackSourceSnapshot(snapshot({ revision: 4 }))).toBe(false);
  });

  it('requires a run for armed, playing, and paused phases', () => {
    for (const phase of ['armed', 'playing', 'paused'] as const) {
      expect(isFilePlaybackSourceSnapshot(snapshot({ phase, run: null }))).toBe(false);
    }
    expect(
      isFilePlaybackSourceSnapshot(
        snapshot({ phase: 'ready', revision: 0, run: null, positionSeconds: 0 }),
      ),
    ).toBe(true);
  });

  it('rejects unsafe counters, dimensions, and non-finite diagnostics', () => {
    expect(isFilePlaybackSourceSnapshot(snapshot({ positionSeconds: Number.NaN }))).toBe(false);
    expect(isFilePlaybackSourceSnapshot(snapshot({ bufferedAheadSeconds: -1 }))).toBe(false);
    expect(isFilePlaybackSourceSnapshot(snapshot({ channelCount: 0 }))).toBe(false);
    expect(isFilePlaybackSourceSnapshot(snapshot({ channelCount: 9 }))).toBe(false);
    expect(isFilePlaybackSourceSnapshot(snapshot({ durationSeconds: 0 }))).toBe(false);
    expect(isFilePlaybackSourceSnapshot(snapshot({ underrunCount: 0.5 }))).toBe(false);
    expect(isFilePlaybackSourceSnapshot(snapshot({ errorCode: '' }))).toBe(false);
  });

  it('canonicalizes pause, seek, and cancel without invoking accessors', () => {
    let getterCalls = 0;
    const values = [
      {
        kind: 'file-playback-pause',
        ...RUN,
        get atRoomTimeMs() {
          getterCalls += 1;
          return 1_000;
        },
      },
      {
        kind: 'file-playback-seek',
        ...RUN,
        positionSeconds: 5,
        get atRoomTimeMs() {
          getterCalls += 1;
          return 1_000;
        },
      },
      {
        kind: 'file-playback-cancel',
        ...RUN,
        rendezvousId: 'rv-contract',
        get reasonCode() {
          getterCalls += 1;
          return 'cancelled';
        },
      },
    ] as const;

    expect(readFilePlaybackPauseIntent(values[0])).toBeNull();
    expect(readFilePlaybackSeekIntent(values[1])).toBeNull();
    expect(readFilePlaybackCancelIntent(values[2])).toBeNull();
    expect(getterCalls).toBe(0);

    const pause = readFilePlaybackPauseIntent({
      kind: 'file-playback-pause',
      ...RUN,
      atRoomTimeMs: 1_000,
    });
    expect(pause).toMatchObject({ kind: 'file-playback-pause', atRoomTimeMs: 1_000 });
    expect(Object.getPrototypeOf(pause)).toBeNull();
    expect(Object.isFrozen(pause)).toBe(true);

    const cancel = readFilePlaybackCancelIntent({
      kind: 'file-playback-cancel',
      ...RUN,
      rendezvousId: 'rv-contract',
      reasonCode: 'cancelled',
    });
    expect(cancel).toMatchObject({
      kind: 'file-playback-cancel',
      rendezvousId: 'rv-contract',
      reasonCode: 'cancelled',
    });
    expect(
      readFilePlaybackCancelIntent({
        kind: 'file-playback-cancel',
        ...RUN,
        reasonCode: 'legacy-run-only-cancel',
      }),
    ).toBeNull();
  });

  it('canonicalizes exact from-to transition intents without invoking nested accessors', () => {
    const from = { queueItemId: QID, runId: 'run-3', revision: 3 };
    const to = { queueItemId: QID, runId: 'run-3', revision: 4 };
    const pause = readFilePlaybackPauseTransitionIntent({
      kind: 'file-playback-pause-transition',
      from,
      to,
      atRoomTimeMs: 2_000,
    });
    const seek = readFilePlaybackSeekTransitionIntent({
      kind: 'file-playback-seek-transition',
      from,
      to,
      positionSeconds: 9,
      atRoomTimeMs: 2_000,
    });
    expect(pause).toMatchObject({ from, to, atRoomTimeMs: 2_000 });
    expect(seek).toMatchObject({ from, to, positionSeconds: 9 });
    expect(Object.getPrototypeOf(pause)).toBeNull();
    expect(Object.isFrozen(pause?.from)).toBe(true);

    let getterCalls = 0;
    const hostileFrom = { ...from };
    Object.defineProperty(hostileFrom, 'revision', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 3;
      },
    });
    expect(
      readFilePlaybackPauseTransitionIntent({
        kind: 'file-playback-pause-transition',
        from: hostileFrom,
        to,
        atRoomTimeMs: 2_000,
      }),
    ).toBeNull();
    expect(getterCalls).toBe(0);
  });

  it('binds immutable transition evidence and enforces exact Worklet pause frames', () => {
    const context = { sampleRate: 48_000 } as AudioContext;
    const intent = {
      kind: 'file-playback-pause-transition' as const,
      from: { queueItemId: QID, runId: 'run-3', revision: 3 },
      to: { queueItemId: QID, runId: 'run-3', revision: 4 },
      atRoomTimeMs: 2_000,
    };
    const evidence = createFilePlaybackTransitionEvidence(
      intent,
      'worklet-observed',
      96_000,
      96_000,
    );
    expect(
      readFilePlaybackTransitionEvidence(evidence, intent, 'worklet-observed', 96_000),
    ).toEqual(evidence);
    expect(() =>
      createFilePlaybackTransitionEvidence(intent, 'worklet-observed', 96_000, 96_001),
    ).toThrow(TypeError);
    const applied = Promise.resolve(evidence);
    const result = createFilePlaybackScheduledTransitionResult(
      intent,
      createFilePlaybackCutoverTarget(context, 2, 96_000),
      snapshot(),
      applied,
    );
    expect(readFilePlaybackTransitionResult(result, intent, context)).toMatchObject({
      status: 'scheduled',
      from: { revision: 3 },
      to: { revision: 4 },
      target: { targetFrame: 96_000 },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it('checks a runtime source against the run queue identity', () => {
    const source = {
      queueItemId: QID,
      backend: 'streaming-flac',
    } as Pick<FilePlaybackSource, 'queueItemId' | 'backend'>;

    expect(sourceOwnsRevisionedRun(source, RUN)).toBe(true);
    expect(sourceOwnsRevisionedRun(source, { ...RUN, queueItemId: OTHER_QID })).toBe(false);
  });

  it('canonicalizes exact local cutover targets and rejects inconsistent clocks', () => {
    const context = { sampleRate: 48_000 } as AudioContext;
    const target = createFilePlaybackCutoverTarget(context, 2, 96_000);

    expect(target).toMatchObject({
      audioContext: context,
      contextTimeSeconds: 2,
      targetFrame: 96_000,
    });
    expect(Object.getPrototypeOf(target)).toBeNull();
    expect(Object.isFrozen(target)).toBe(true);
    expect(readFilePlaybackCutoverTarget(target, context)).toEqual(target);
    expect(
      readFilePlaybackCutoverTarget(target, { sampleRate: 48_000 } as AudioContext),
    ).toBeNull();
    expect(() => createFilePlaybackCutoverTarget(context, 2, 95_999)).toThrow(TypeError);
    expect(() => createFilePlaybackCutoverTarget({ sampleRate: 0 } as AudioContext, 2, 0)).toThrow(
      TypeError,
    );

    let getterCalls = 0;
    const accessor = {
      audioContext: context,
      contextTimeSeconds: 2,
      get targetFrame() {
        getterCalls += 1;
        return 96_000;
      },
    };
    expect(readFilePlaybackCutoverTarget(accessor, context)).toBeNull();
    expect(getterCalls).toBe(0);
  });

  it('keeps AudioBuffer and streaming start evidence exact and distinguishable', () => {
    const audioBuffer = createAudioBufferPlaybackStartEvidence(96_000);
    const streaming = createStreamingFlacPlaybackStartEvidence(96_000, 96_000);

    expect(readFilePlaybackStartEvidence(audioBuffer, 96_000)).toEqual(audioBuffer);
    expect(readFilePlaybackStartEvidence(streaming, 96_000)).toEqual(streaming);
    expect(readFilePlaybackStartEvidence(audioBuffer, 96_001)).toBeNull();
    expect(readFilePlaybackStartEvidence({ ...streaming, extra: true }, 96_000)).toBeNull();
    expect(() => createStreamingFlacPlaybackStartEvidence(96_000, 96_001)).toThrow(TypeError);
    expect(Object.getPrototypeOf(audioBuffer)).toBeNull();
    expect(Object.getPrototypeOf(streaming)).toBeNull();
    expect(Object.isFrozen(audioBuffer)).toBe(true);
    expect(Object.isFrozen(streaming)).toBe(true);
  });

  it('does not upgrade evidence whose Proxy discriminator changes during snapshotting', () => {
    const changingEvidence = (
      firstKind: 'webaudio-schedule-passed' | 'worklet-observed',
      laterKind: 'webaudio-schedule-passed' | 'worklet-observed',
    ) => {
      let kindDescriptorReads = 0;
      const target =
        firstKind === 'webaudio-schedule-passed'
          ? { kind: firstKind, targetFrame: 96_000 }
          : { kind: firstKind, targetFrame: 96_000, actualStartFrame: 96_000 };
      const proxy = new Proxy(target, {
        getOwnPropertyDescriptor(current, key) {
          const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
          if (key !== 'kind' || !descriptor) return descriptor;
          kindDescriptorReads += 1;
          return {
            ...descriptor,
            value: kindDescriptorReads === 1 ? firstKind : laterKind,
          };
        },
      });
      return { proxy, descriptorReads: () => kindDescriptorReads };
    };

    const audioToStreaming = changingEvidence('webaudio-schedule-passed', 'worklet-observed');
    expect(readFilePlaybackStartEvidence(audioToStreaming.proxy, 96_000)).toBeNull();
    expect(audioToStreaming.descriptorReads()).toBeGreaterThanOrEqual(2);

    const streamingToAudio = changingEvidence('worklet-observed', 'webaudio-schedule-passed');
    expect(readFilePlaybackStartEvidence(streamingToAudio.proxy, 96_000)).toBeNull();
    expect(streamingToAudio.descriptorReads()).toBeGreaterThanOrEqual(2);
  });
});
