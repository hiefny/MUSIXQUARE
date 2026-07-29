import { describe, expect, it } from 'vitest';

import {
  classifyFilePlaybackFailure,
  type FilePlaybackFailureKind,
} from './helpers/file-playback-fault-boundary-model.ts';

const PLAYBACK_FAILURES: readonly FilePlaybackFailureKind[] = Object.freeze([
  'delivery-transient',
  'delivery-exhausted',
  'media-integrity-failed',
  'decoder-unsupported-before-adoption-with-legacy-ready',
  'decoder-unsupported-after-adoption',
  'decoder-failed',
  'renderer-failed',
  'sequence-gap',
  'state-conflict',
  'stale-effect',
  'stale-local-epoch',
]);

describe('file playback fault boundary model', () => {
  it.each(PLAYBACK_FAILURES)('exposes no room-connection action for %s', (kind) => {
    const classified = classifyFilePlaybackFailure(kind);

    expect(Object.keys(classified)).toEqual(['recovery']);
    expect(classified).not.toHaveProperty('transport');
    expect(classified).not.toHaveProperty('close');
  });

  it('allows legacy fallback only before bounded ownership adoption is possible', () => {
    expect(
      classifyFilePlaybackFailure('decoder-unsupported-before-adoption-with-legacy-ready'),
    ).toEqual({ recovery: 'fallback-legacy-before-adoption' });
    expect(classifyFilePlaybackFailure('decoder-unsupported-after-adoption')).toEqual({
      recovery: 'retire-media',
    });
  });

  it('retires corrupted media without promoting it to transport policy', () => {
    expect(classifyFilePlaybackFailure('media-integrity-failed')).toEqual({
      recovery: 'retire-media',
    });
  });

  it('maps observed V2 races to local convergence actions', () => {
    expect(classifyFilePlaybackFailure('delivery-exhausted')).toEqual({
      recovery: 'request-alternate-delivery',
    });
    expect(classifyFilePlaybackFailure('state-conflict')).toEqual({
      recovery: 'request-snapshot',
    });
    expect(classifyFilePlaybackFailure('stale-local-epoch')).toEqual({
      recovery: 'discard-stale-effect',
    });
  });
});
