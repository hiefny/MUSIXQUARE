import { describe, expect, it } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  createPlaybackRunIdentity,
  createPlaybackStateIdentity,
  isPlaybackRevision,
  isPlaybackRevisionWatermark,
  isPlaybackRunIdentity,
  isPlaybackStateIdentity,
  readPlaybackAttemptIdentity,
  readPlaybackStateIdentity,
  sameAttempt,
  sameRun,
  sameState,
  type PlaybackAttemptIdentity,
  type PlaybackRunIdentity,
  type PlaybackStateIdentity,
} from '../playback-identity.ts';

const QID = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const RUN: PlaybackRunIdentity = { queueItemId: QID, runId: 'run:alpha' };
const STATE: PlaybackStateIdentity = { ...RUN, revision: 1 };
const ATTEMPT: PlaybackAttemptIdentity = { ...STATE, rendezvousId: 'rendezvous:alpha' };

describe('playback identity', () => {
  it('creates flat frozen null-prototype JSON identities', () => {
    const run = createPlaybackRunIdentity(RUN);
    const state = createPlaybackStateIdentity(STATE);
    const attempt = readPlaybackAttemptIdentity(ATTEMPT);
    expect(attempt).not.toBeNull();

    for (const identity of [run, state, attempt!]) {
      expect(Object.getPrototypeOf(identity)).toBeNull();
      expect(Object.isFrozen(identity)).toBe(true);
      expect(JSON.parse(JSON.stringify(identity))).toEqual(identity);
    }
    expect(run).toEqual(RUN);
    expect(state).toEqual(STATE);
    expect(attempt).toEqual(ATTEMPT);
  });

  it('separates the stopped revision watermark from active state revisions', () => {
    expect(isPlaybackRevisionWatermark(0)).toBe(true);
    expect(isPlaybackRevision(0)).toBe(false);
    expect(isPlaybackRevision(-0)).toBe(false);
    expect(isPlaybackRevision(1)).toBe(true);
  });

  it('requires exact own enumerable data without invoking accessors', () => {
    let getterCalls = 0;
    const hostile = { ...ATTEMPT } as Record<PropertyKey, unknown>;
    Object.defineProperty(hostile, 'runId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return RUN.runId;
      },
    });
    expect(readPlaybackAttemptIdentity(hostile)).toBeNull();
    expect(getterCalls).toBe(0);

    expect(isPlaybackRunIdentity({ ...RUN, revision: 1 })).toBe(false);
    expect(isPlaybackStateIdentity({ ...STATE, rendezvousId: 'r' })).toBe(false);
    expect(isPlaybackStateIdentity({ ...STATE, [Symbol('extra')]: true })).toBe(false);
    expect(isPlaybackRunIdentity(Object.assign([], RUN))).toBe(false);
    expect(isPlaybackRunIdentity(Object.assign(Object.create({ inherited: true }), RUN))).toBe(
      false,
    );
  });

  it('uses the bounded trimmed opaque identifier contract without forcing UUID run IDs', () => {
    expect(isPlaybackRunIdentity({ queueItemId: 'legacy-queue', runId: 'run:opaque' })).toBe(true);
    for (const runId of ['', ' run', 'run ', 'run\u0000id', 'x'.repeat(257)]) {
      expect(isPlaybackRunIdentity({ queueItemId: QID, runId })).toBe(false);
    }
    expect(isPlaybackStateIdentity({ ...RUN, revision: 0 })).toBe(false);
    expect(readPlaybackAttemptIdentity({ ...STATE, rendezvousId: ' rendezvous' })).toBeNull();
  });

  it('projects identities from larger envelopes without dynamic reads or re-entrant state', () => {
    let accessorCalls = 0;
    const envelope = { ...ATTEMPT, kind: 'rendezvous-arm' } as Record<PropertyKey, unknown>;
    Object.defineProperty(envelope, 'futureField', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 'ignored';
      },
    });
    expect(readPlaybackAttemptIdentity(envelope)).toEqual(ATTEMPT);
    expect(accessorCalls).toBe(0);

    Object.defineProperty(envelope, 'runId', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return RUN.runId;
      },
    });
    expect(readPlaybackAttemptIdentity(envelope)).toBeNull();
    expect(accessorCalls).toBe(0);

    let getCalls = 0;
    let nestedRevision: number | undefined;
    let reentered = false;
    const proxied = new Proxy(
      { ...STATE, kind: 'play' },
      {
        get() {
          getCalls += 1;
          throw new Error('dynamic [[Get]] must not run');
        },
        getOwnPropertyDescriptor(target, property) {
          if (!reentered) {
            reentered = true;
            nestedRevision = readPlaybackStateIdentity({ ...STATE, revision: 2 })?.revision;
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    expect(readPlaybackStateIdentity(proxied)).toEqual(STATE);
    expect(nestedRevision).toBe(2);
    expect(getCalls).toBe(0);
  });

  it('compares run, state, and attempt at their exact identity layers', () => {
    expect(sameRun(STATE, { ...STATE, revision: 2 })).toBe(true);
    expect(sameState(STATE, { ...STATE })).toBe(true);
    expect(sameState(STATE, { ...STATE, revision: 2 })).toBe(false);
    expect(sameAttempt(ATTEMPT, { ...ATTEMPT })).toBe(true);
    expect(sameAttempt(ATTEMPT, { ...ATTEMPT, rendezvousId: 'rendezvous:other' })).toBe(false);
    expect(sameRun(null, RUN)).toBe(false);
  });

  it('compares hostile identities through descriptor-safe canonical projections', () => {
    let getCalls = 0;
    const proxied = new Proxy(ATTEMPT, {
      get() {
        getCalls += 1;
        throw new Error('dynamic [[Get]] must not run');
      },
    });
    expect(sameRun(proxied, ATTEMPT)).toBe(true);
    expect(sameState(proxied, ATTEMPT)).toBe(true);
    expect(sameAttempt(proxied, ATTEMPT)).toBe(true);
    expect(getCalls).toBe(0);

    const accessor = { ...ATTEMPT };
    Object.defineProperty(accessor, 'rendezvousId', {
      enumerable: true,
      get() {
        getCalls += 1;
        return ATTEMPT.rendezvousId;
      },
    });
    expect(sameAttempt(accessor, ATTEMPT)).toBe(false);
    expect(getCalls).toBe(0);
  });
});
