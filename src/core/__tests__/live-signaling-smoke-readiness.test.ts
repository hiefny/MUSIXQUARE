import { describe, expect, it } from 'vitest';

import {
  STALE_VERSION_RETRY_DELAYS_MS,
  StaleSignalingVersionError,
  assertPeerOpenVersion,
  withStaleVersionRetry,
} from '../../../scripts/live-signaling-smoke.mjs';

const EXPECTED_VERSION = '11111111-1111-4111-8111-111111111111';
const STALE_VERSION = '22222222-2222-4222-8222-222222222222';

describe('live signaling smoke deployment readiness', () => {
  it('keeps the bounded backoff comfortably below 45 seconds', () => {
    expect(STALE_VERSION_RETRY_DELAYS_MS.reduce((total, value) => total + value, 0)).toBeLessThan(
      45_000,
    );
  });

  it('classifies only a host peer-open version mismatch as retryable staleness', () => {
    expect(() =>
      assertPeerOpenVersion(
        { workerVersionId: STALE_VERSION },
        EXPECTED_VERSION,
        'host peer-open',
        true,
      ),
    ).toThrow(StaleSignalingVersionError);
    expect(() => assertPeerOpenVersion({}, EXPECTED_VERSION, 'host peer-open', true)).toThrow(
      StaleSignalingVersionError,
    );

    let guestError: unknown;
    try {
      assertPeerOpenVersion(
        { workerVersionId: STALE_VERSION },
        EXPECTED_VERSION,
        'guest peer-open',
      );
    } catch (error) {
      guestError = error;
    }
    expect(guestError).toBeInstanceOf(Error);
    expect(guestError).not.toBeInstanceOf(StaleSignalingVersionError);
    expect(() =>
      assertPeerOpenVersion(
        { workerVersionId: EXPECTED_VERSION },
        EXPECTED_VERSION,
        'guest peer-open',
      ),
    ).not.toThrow();
  });

  it('retries stale host versions with a fresh operation invocation', async () => {
    const attempts: number[] = [];
    const waits: number[] = [];
    const result = await withStaleVersionRetry(
      async (attempt: number) => {
        attempts.push(attempt);
        if (attempt < 3) {
          throw new StaleSignalingVersionError(EXPECTED_VERSION, STALE_VERSION);
        }
        return 'ready';
      },
      {
        retryDelaysMs: [10, 20],
        wait: async (milliseconds: number) => {
          waits.push(milliseconds);
        },
        onRetry: () => {},
      },
    );

    expect(result).toBe('ready');
    expect(attempts).toEqual([1, 2, 3]);
    expect(waits).toEqual([10, 20]);
  });

  it('does not retry a protocol failure after readiness reaches the expected version', async () => {
    let attempts = 0;
    await expect(
      withStaleVersionRetry(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new StaleSignalingVersionError(EXPECTED_VERSION, STALE_VERSION);
          }
          throw new Error('guest reconnect protocol regression');
        },
        {
          retryDelaysMs: [0, 0, 0],
          wait: async () => {},
          onRetry: () => {},
        },
      ),
    ).rejects.toThrow('guest reconnect protocol regression');
    expect(attempts).toBe(2);
  });

  it('fails after the bounded stale-version retry budget is exhausted', async () => {
    let attempts = 0;
    await expect(
      withStaleVersionRetry(
        async () => {
          attempts += 1;
          throw new StaleSignalingVersionError(EXPECTED_VERSION, STALE_VERSION);
        },
        {
          retryDelaysMs: [0, 0],
          wait: async () => {},
          onRetry: () => {},
        },
      ),
    ).rejects.toBeInstanceOf(StaleSignalingVersionError);
    expect(attempts).toBe(3);
  });
});
