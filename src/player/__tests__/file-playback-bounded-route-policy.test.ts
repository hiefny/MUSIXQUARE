import { describe, expect, it, vi } from 'vitest';

import {
  FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY,
  FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
  snapshotFilePlaybackBoundedRoutePolicy,
} from '../file-playback-bounded-route-policy.ts';

describe('file playback bounded route policy', () => {
  it('exports exactly two stable frozen canonical policies', () => {
    expect(FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY).toEqual({ mode: 'current' });
    expect(FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY).toEqual({
      mode: 'universal-v1',
      aacBackendId: 'webcodecs',
      m4aBackendId: 'webcodecs',
    });
    expect(Object.isFrozen(FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY)).toBe(true);
    expect(Object.isFrozen(FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY)).toBe(true);
    expect(FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY).not.toBe(
      FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    );
  });

  it('defaults undefined and canonicalizes detached plain records by identity', () => {
    expect(snapshotFilePlaybackBoundedRoutePolicy()).toBe(
      FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY,
    );
    expect(snapshotFilePlaybackBoundedRoutePolicy(undefined)).toBe(
      FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY,
    );
    expect(snapshotFilePlaybackBoundedRoutePolicy({ mode: 'current' })).toBe(
      FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY,
    );
    expect(
      snapshotFilePlaybackBoundedRoutePolicy({
        mode: 'universal-v1',
        aacBackendId: 'webcodecs',
        m4aBackendId: 'webcodecs',
      }),
    ).toBe(FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY);

    const nullPrototype = Object.assign(Object.create(null), {
      mode: 'universal-v1',
      aacBackendId: 'webcodecs',
      m4aBackendId: 'webcodecs',
    });
    expect(snapshotFilePlaybackBoundedRoutePolicy(nullPrototype)).toBe(
      FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
    );
  });

  it.each([
    null,
    true,
    1,
    'current',
    [],
    new (class Policy {
      readonly mode = 'current';
    })(),
    Object.create({ mode: 'current' }),
  ])('rejects non-plain explicit policy input %#', (value) => {
    expect(() => snapshotFilePlaybackBoundedRoutePolicy(value)).toThrow(TypeError);
  });

  it.each([
    {},
    { mode: 'unknown' },
    { mode: 'current', extra: true },
    { mode: 'current', m4aBackendId: 'webcodecs' },
    { mode: 'universal-v1' },
    { mode: 'universal-v1', aacBackendId: 'webcodecs', m4aBackendId: 'symphonia-wasm' },
    { mode: 'universal-v1', aacBackendId: 'symphonia-wasm', m4aBackendId: 'webcodecs' },
    { mode: 'universal-v1', aacBackendId: 'webcodecs', m4aBackendId: undefined },
    {
      mode: 'universal-v1',
      aacBackendId: 'webcodecs',
      m4aBackendId: 'webcodecs',
      extra: true,
    },
  ])('rejects a noncanonical policy record %#', (value) => {
    expect(() => snapshotFilePlaybackBoundedRoutePolicy(value)).toThrow(TypeError);
  });

  it('rejects accessors, symbols, and non-enumerable fields without invoking values', () => {
    const modeGetter = vi.fn(() => 'current');
    const accessor = Object.defineProperty({}, 'mode', {
      enumerable: true,
      get: modeGetter,
    });
    expect(() => snapshotFilePlaybackBoundedRoutePolicy(accessor)).toThrow(TypeError);
    expect(modeGetter).not.toHaveBeenCalled();

    const hidden = Object.defineProperty({}, 'mode', {
      enumerable: false,
      value: 'current',
    });
    expect(() => snapshotFilePlaybackBoundedRoutePolicy(hidden)).toThrow(TypeError);

    const symbol = Symbol('unexpected');
    expect(() =>
      snapshotFilePlaybackBoundedRoutePolicy({ mode: 'current', [symbol]: true }),
    ).toThrow(TypeError);
  });

  it('converts hostile Proxy inspection failures into a bounded TypeError', () => {
    const sentinel = new Error('proxy ownKeys trap');
    const hostile = new Proxy(
      { mode: 'current' },
      {
        ownKeys() {
          throw sentinel;
        },
      },
    );

    let failure: unknown;
    try {
      snapshotFilePlaybackBoundedRoutePolicy(hostile);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error & { cause?: unknown }).cause).toBe(sentinel);
  });

  it('never returns caller storage and does not permit canonical policy mutation', () => {
    const input = { mode: 'current' as const };
    const result = snapshotFilePlaybackBoundedRoutePolicy(input);
    expect(result).not.toBe(input);
    input.mode = 'current';
    expect(result).toBe(FILE_PLAYBACK_CURRENT_BOUNDED_ROUTE_POLICY);
    expect(() => {
      (result as { mode: string }).mode = 'universal-v1';
    }).toThrow(TypeError);
    expect(result).toEqual({ mode: 'current' });
  });
});
