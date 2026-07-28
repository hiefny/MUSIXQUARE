import { describe, expect, it } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  createFilePlaybackEndedTransitionEvidence,
  readFilePlaybackEndedTransitionEvidence,
  readFilePlaybackEndedTransitionIntent,
} from '../file-playback-ended-transition.ts';

const Q1 = '99000000-0000-4000-8000-000000000001' as QueueItemId;

function intent() {
  return {
    kind: 'file-playback-ended-transition' as const,
    from: { queueItemId: Q1, runId: 'ended-run', revision: 7 },
    to: { queueItemId: Q1, runId: 'ended-run', revision: 8 },
    observedAtRoomTimeMs: 123_456,
  };
}

describe('file playback ended transition', () => {
  it('canonicalizes one consecutive same-run EOF retirement and its evidence', () => {
    const canonical = readFilePlaybackEndedTransitionIntent(intent());
    const evidence = createFilePlaybackEndedTransitionEvidence(intent());

    expect(canonical).toEqual(intent());
    expect(evidence).toEqual({
      kind: 'ended-renderer-retired',
      from: intent().from,
      to: intent().to,
      observedAtRoomTimeMs: 123_456,
    });
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(readFilePlaybackEndedTransitionEvidence(evidence, intent())).toEqual(evidence);
  });

  it('rejects gaps, another run, invalid time, and extra authority fields', () => {
    expect(
      readFilePlaybackEndedTransitionIntent({
        ...intent(),
        to: { ...intent().to, revision: 9 },
      }),
    ).toBeNull();
    expect(
      readFilePlaybackEndedTransitionIntent({
        ...intent(),
        to: { ...intent().to, runId: 'another-run' },
      }),
    ).toBeNull();
    expect(
      readFilePlaybackEndedTransitionIntent({ ...intent(), observedAtRoomTimeMs: -1 }),
    ).toBeNull();
    expect(readFilePlaybackEndedTransitionIntent({ ...intent(), audioContext: {} })).toBeNull();
  });

  it('never invokes accessors while snapshotting untrusted transition input', () => {
    let reads = 0;
    const hostile = { ...intent() } as Record<string, unknown>;
    Object.defineProperty(hostile, 'kind', {
      enumerable: true,
      get() {
        reads += 1;
        return 'file-playback-ended-transition';
      },
    });

    expect(readFilePlaybackEndedTransitionIntent(hostile)).toBeNull();
    expect(reads).toBe(0);
  });

  it('rejects evidence from another observation or state', () => {
    const evidence = createFilePlaybackEndedTransitionEvidence(intent());
    expect(
      readFilePlaybackEndedTransitionEvidence(
        { ...evidence, observedAtRoomTimeMs: evidence.observedAtRoomTimeMs + 1 },
        intent(),
      ),
    ).toBeNull();
    expect(
      readFilePlaybackEndedTransitionEvidence(evidence, {
        ...intent(),
        from: { ...intent().from, revision: 8 },
        to: { ...intent().to, revision: 9 },
      }),
    ).toBeNull();
  });
});
