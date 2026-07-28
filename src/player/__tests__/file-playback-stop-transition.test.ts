import { describe, expect, it } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import { createFilePlaybackCutoverTarget } from '../file-playback-source.ts';
import {
  createFilePlaybackFailedStopTransitionEvidence,
  createFilePlaybackFailedStopTransitionResult,
  createFilePlaybackStopTransitionEvidence,
  createFilePlaybackStopTransitionResult,
  readFilePlaybackStopTransitionEvidence,
  readFilePlaybackStopTransitionIntent,
  readFilePlaybackStopTransitionResult,
  sameFilePlaybackStopTransitionIntent,
  type FilePlaybackStopTransitionIntent,
} from '../file-playback-stop-transition.ts';

const Q1 = '00000000-0000-4000-8000-000000000001' as QueueItemId;

function context(sampleRate = 48_000): AudioContext {
  return { sampleRate } as AudioContext;
}

function intent(audioContext: AudioContext): FilePlaybackStopTransitionIntent {
  return {
    kind: 'file-playback-stop-transition',
    from: { queueItemId: Q1, runId: 'run-one', revision: 7 },
    to: { queueItemId: Q1, runId: 'run-one', revision: 8 },
    atRoomTimeMs: 12_000,
    target: createFilePlaybackCutoverTarget(audioContext, 2, 96_000),
  };
}

describe('file playback STOP transition contract', () => {
  it('canonicalizes an exact room boundary and process-local AudioContext target', () => {
    const audioContext = context();
    const original = intent(audioContext);
    const canonical = readFilePlaybackStopTransitionIntent(original, audioContext);
    expect(canonical).toEqual(original);
    expect(canonical).not.toBe(original);
    expect(Object.getPrototypeOf(canonical!)).toBeNull();
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(sameFilePlaybackStopTransitionIntent(original, { ...original }, audioContext)).toBe(
      true,
    );
  });

  it('rejects foreign contexts, non-consecutive identities, extra keys, and accessors', () => {
    const audioContext = context();
    const original = intent(audioContext);
    expect(readFilePlaybackStopTransitionIntent(original, context())).toBeNull();
    expect(
      readFilePlaybackStopTransitionIntent(
        { ...original, to: { ...original.to, revision: 9 } },
        audioContext,
      ),
    ).toBeNull();
    expect(
      readFilePlaybackStopTransitionIntent({ ...original, extra: true }, audioContext),
    ).toBeNull();

    let getterCalls = 0;
    const hostile = Object.defineProperty({ ...original }, 'target', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return original.target;
      },
    });
    expect(readFilePlaybackStopTransitionIntent(hostile, audioContext)).toBeNull();
    expect(getterCalls).toBe(0);

    const evidence = createFilePlaybackStopTransitionEvidence(original, 96_000);
    expect(
      readFilePlaybackStopTransitionEvidence(
        evidence,
        hostile as unknown as FilePlaybackStopTransitionIntent,
      ),
    ).toBeNull();
    expect(
      readFilePlaybackStopTransitionResult(
        createFilePlaybackStopTransitionResult(original, Promise.resolve(evidence)),
        hostile as unknown as FilePlaybackStopTransitionIntent,
      ),
    ).toBeNull();
    expect(getterCalls).toBe(0);
  });

  it('binds lightweight schedule-passed evidence to the exact state and frame', async () => {
    const audioContext = context();
    const original = intent(audioContext);
    const evidence = createFilePlaybackStopTransitionEvidence(original, 96_003);
    expect(readFilePlaybackStopTransitionEvidence(evidence, original)).toEqual(evidence);
    expect(
      readFilePlaybackStopTransitionEvidence({ ...evidence, appliedFrame: 95_999 }, original),
    ).toBeNull();
    expect(
      readFilePlaybackStopTransitionEvidence(
        { ...evidence, to: { ...evidence.to, revision: 9 } },
        original,
      ),
    ).toBeNull();

    const applied = Promise.resolve(evidence);
    const result = createFilePlaybackStopTransitionResult(original, applied);
    const canonical = readFilePlaybackStopTransitionResult(result, original);
    expect(canonical).toMatchObject({ status: 'scheduled', target: original.target });
    await expect(canonical!.applied).resolves.toBe(evidence);
    expect(
      readFilePlaybackStopTransitionResult(
        { ...result, target: createFilePlaybackCutoverTarget(audioContext, 3, 144_000) },
        original,
      ),
    ).toBeNull();

    class PromiseSubclass<T> extends Promise<T> {}
    const subclass = PromiseSubclass.resolve(evidence);
    expect(() => createFilePlaybackStopTransitionResult(original, subclass)).toThrow(
      /result is invalid/u,
    );
    expect(readFilePlaybackStopTransitionResult({ ...result, applied: subclass }, original)).toBe(
      null,
    );

    const hostile = new Proxy(applied, {
      getPrototypeOf() {
        throw new Error('hostile promise prototype');
      },
    });
    expect(() => createFilePlaybackStopTransitionResult(original, hostile)).toThrow(
      /result is invalid/u,
    );
    expect(readFilePlaybackStopTransitionResult({ ...result, applied: hostile }, original)).toBe(
      null,
    );
  });

  it('keeps exact failed-renderer retirement distinct from scheduled Web Audio evidence', async () => {
    const audioContext = context();
    const original = intent(audioContext);
    const evidence = createFilePlaybackFailedStopTransitionEvidence(original);
    expect(evidence).toEqual({
      kind: 'failed-stop-applied',
      observation: 'source-failed-retired',
      from: original.from,
      to: original.to,
    });
    expect(readFilePlaybackStopTransitionEvidence(evidence, original)).toEqual(evidence);
    expect(
      readFilePlaybackStopTransitionEvidence(
        { ...evidence, to: { ...evidence.to, revision: 9 } },
        original,
      ),
    ).toBeNull();
    expect(
      readFilePlaybackStopTransitionEvidence(
        { ...evidence, targetFrame: original.target.targetFrame },
        original,
      ),
    ).toBeNull();

    const applied = Promise.resolve(evidence);
    const result = createFilePlaybackFailedStopTransitionResult(original, applied);
    const canonical = readFilePlaybackStopTransitionResult(result, original);
    expect(canonical).toMatchObject({
      status: 'failed-retired',
      from: original.from,
      to: original.to,
      target: original.target,
    });
    await expect(canonical!.applied).resolves.toBe(evidence);
  });
});
