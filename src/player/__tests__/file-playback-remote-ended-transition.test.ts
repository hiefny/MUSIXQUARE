import { describe, expect, it } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  createFilePlaybackRemoteEndedTransitionEvidence,
  readFilePlaybackRemoteEndedTransitionEvidence,
  readFilePlaybackRemoteEndedTransitionIntent,
} from '../file-playback-remote-ended-transition.ts';

const Q1 = '9a000000-0000-4000-8000-000000000001' as QueueItemId;

function intent() {
  return {
    kind: 'file-playback-remote-ended-transition' as const,
    from: { queueItemId: Q1, runId: 'remote-ended-run', revision: 7 },
    to: { queueItemId: Q1, runId: 'remote-ended-run', revision: 8 },
    hostObservedAtRoomTimeMs: 123_456,
  };
}

describe('file playback remote-ended transition', () => {
  it.each(['playing', 'paused', 'ended'] as const)(
    'canonicalizes exact host EOF intent and %s retirement evidence',
    (observedPhase) => {
      const canonical = readFilePlaybackRemoteEndedTransitionIntent(intent());
      const evidence = createFilePlaybackRemoteEndedTransitionEvidence(intent(), observedPhase);

      expect(canonical).toEqual(intent());
      expect(evidence).toEqual({
        kind: 'remote-ended-renderer-retired',
        from: intent().from,
        to: intent().to,
        hostObservedAtRoomTimeMs: 123_456,
        observedPhase,
      });
      expect(Object.isFrozen(canonical)).toBe(true);
      expect(Object.isFrozen(evidence)).toBe(true);
      expect(readFilePlaybackRemoteEndedTransitionEvidence(evidence, intent())).toEqual(evidence);
    },
  );

  it('rejects revision gaps, another run, invalid host time, and extra authority fields', () => {
    expect(
      readFilePlaybackRemoteEndedTransitionIntent({
        ...intent(),
        to: { ...intent().to, revision: 9 },
      }),
    ).toBeNull();
    expect(
      readFilePlaybackRemoteEndedTransitionIntent({
        ...intent(),
        to: { ...intent().to, runId: 'another-run' },
      }),
    ).toBeNull();
    expect(
      readFilePlaybackRemoteEndedTransitionIntent({
        ...intent(),
        hostObservedAtRoomTimeMs: -1,
      }),
    ).toBeNull();
    expect(readFilePlaybackRemoteEndedTransitionIntent({ ...intent(), targetFrame: 4 })).toBeNull();
  });

  it('never invokes accessors while snapshotting untrusted transition input', () => {
    let reads = 0;
    const hostile = { ...intent() } as Record<string, unknown>;
    Object.defineProperty(hostile, 'kind', {
      enumerable: true,
      get() {
        reads += 1;
        return 'file-playback-remote-ended-transition';
      },
    });

    expect(readFilePlaybackRemoteEndedTransitionIntent(hostile)).toBeNull();
    expect(reads).toBe(0);
  });

  it('cannot reinterpret scheduled STOP evidence as remote-ended retirement evidence', () => {
    const stopLikeEvidence = {
      kind: 'stop-applied',
      observation: 'webaudio-schedule-passed',
      from: intent().from,
      to: intent().to,
      targetFrame: 10,
      appliedFrame: 10,
    };
    expect(readFilePlaybackRemoteEndedTransitionEvidence(stopLikeEvidence, intent())).toBeNull();

    const evidence = createFilePlaybackRemoteEndedTransitionEvidence(intent(), 'playing');
    expect(
      readFilePlaybackRemoteEndedTransitionEvidence(
        { ...evidence, observedPhase: 'connected' },
        intent(),
      ),
    ).toBeNull();
    expect(
      readFilePlaybackRemoteEndedTransitionEvidence(evidence, {
        ...intent(),
        hostObservedAtRoomTimeMs: intent().hostObservedAtRoomTimeMs + 1,
      }),
    ).toBeNull();
  });
});
