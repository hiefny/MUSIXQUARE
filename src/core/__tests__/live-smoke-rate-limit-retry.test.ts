import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RATE_LIMIT_UNAVAILABLE,
  RATE_LIMIT_UNAVAILABLE_RETRY_DELAY_MS,
  RateLimitUnavailableError,
  UPGRADE_REJECTION_BODY_MAX_BYTES,
  UPGRADE_REJECTION_BODY_TIMEOUT_MS,
  createRateLimitUnavailableRetry,
  isRateLimitUnavailableResponse,
  readRateLimitUnavailableUpgrade,
} from '../../../scripts/live-smoke-rate-limit-retry.mts';

function upgradeResponse(statusCode: number, chunks: readonly string[]) {
  const stream = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  const resume = vi.spyOn(stream, 'resume');
  const destroy = vi.spyOn(stream, 'destroy');
  return { response: Object.assign(stream, { statusCode }), resume, destroy };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('live smoke RATE_LIMIT_UNAVAILABLE decision', () => {
  it('pins the code and a delay longer than the 2 s limiter read timeout', () => {
    expect(RATE_LIMIT_UNAVAILABLE).toBe('RATE_LIMIT_UNAVAILABLE');
    expect(RATE_LIMIT_UNAVAILABLE_RETRY_DELAY_MS).toBe(5_000);
  });

  it('matches only HTTP 503 with exactly that JSON error code', () => {
    expect(isRateLimitUnavailableResponse(503, { error: 'RATE_LIMIT_UNAVAILABLE' })).toBe(true);
    expect(
      isRateLimitUnavailableResponse(503, { error: 'RATE_LIMIT_UNAVAILABLE', detail: 'x' }),
    ).toBe(true);

    for (const status of [200, 401, 403, 404, 429, 500, 502, 504, '503', undefined]) {
      expect(isRateLimitUnavailableResponse(status, { error: 'RATE_LIMIT_UNAVAILABLE' })).toBe(
        false,
      );
    }
    for (const payload of [
      { error: 'SERVICE_MAINTENANCE' },
      { error: 'SERVICE_MAINTENANCE_STATUS_UNAVAILABLE' },
      { error: 'CAPABILITY_NOT_CONFIGURED' },
      { error: 'STANDARD_SIGNALING_BRIDGE_UNAVAILABLE' },
      { error: 'rate limit unavailable' },
      { error: 'rate_limit_unavailable' },
      { error: ' RATE_LIMIT_UNAVAILABLE' },
      { error: ['RATE_LIMIT_UNAVAILABLE'] },
      { code: 'RATE_LIMIT_UNAVAILABLE' },
      ['RATE_LIMIT_UNAVAILABLE'],
      'RATE_LIMIT_UNAVAILABLE',
      {},
      null,
      undefined,
    ]) {
      expect(isRateLimitUnavailableResponse(503, payload)).toBe(false);
    }
  });

  it('keeps the error name, so a final failure prints exactly the old line', () => {
    const error = new RateLimitUnavailableError('host WebSocket upgrade returned HTTP 503');
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe('Error: host WebSocket upgrade returned HTTP 503');
  });
});

describe('live smoke rate-limit retry budget', () => {
  it('prints the failure line unchanged, then the retry line, then waits once', async () => {
    const log = vi.fn();
    const wait = vi.fn(async () => {});
    const retry = createRateLimitUnavailableRetry({ log, wait });

    await expect(retry.claim('first failure line')).resolves.toBe(true);

    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]).toEqual(['first failure line']);
    expect(String(log.mock.calls[1]?.[0])).toContain('retried after RATE_LIMIT_UNAVAILABLE');
    expect(wait).toHaveBeenCalledExactlyOnceWith(RATE_LIMIT_UNAVAILABLE_RETRY_DELAY_MS);
  });

  it('allows one retry per run and stays silent once spent', async () => {
    const log = vi.fn();
    const wait = vi.fn(async () => {});
    const retry = createRateLimitUnavailableRetry({ log, wait });

    await retry.claim('first failure line');
    await expect(retry.claim('second failure line')).resolves.toBe(false);
    await expect(retry.claim('third failure line')).resolves.toBe(false);

    expect(log).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  it('waits the default delay before letting the request repeat', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const retry = createRateLimitUnavailableRetry();
    let claimed = false;
    const claiming = retry.claim('first failure line').then((value) => (claimed = value));

    await vi.advanceTimersByTimeAsync(RATE_LIMIT_UNAVAILABLE_RETRY_DELAY_MS - 1);
    expect(claimed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(claimed).toBe(true);
    await claiming;
  });
});

describe('rejected WebSocket upgrade classification', () => {
  it('recognises the signaling Worker 503 rate-limiter body', async () => {
    const { response, destroy } = upgradeResponse(503, ['{"error":"RATE_LIMIT_', 'UNAVAILABLE"}']);
    await expect(readRateLimitUnavailableUpgrade(response)).resolves.toBe(true);
    expect(destroy).toHaveBeenCalled();
  });

  it.each([
    ['another 503 code', '{"error":"SERVICE_MAINTENANCE"}'],
    ['an edge error page', '<html>503 Service Unavailable</html>'],
    ['an empty body', ''],
    ['a JSON body without an object', '"RATE_LIMIT_UNAVAILABLE"'],
  ])('keeps a 503 with %s final', async (_label, body) => {
    const { response } = upgradeResponse(503, body ? [body] : []);
    await expect(readRateLimitUnavailableUpgrade(response)).resolves.toBe(false);
  });

  it('stops reading an oversized 503 body', async () => {
    const padding = ' '.repeat(UPGRADE_REJECTION_BODY_MAX_BYTES);
    const { response, destroy } = upgradeResponse(503, [
      `{"error":"RATE_LIMIT_UNAVAILABLE"${padding}`,
      '}',
    ]);
    await expect(readRateLimitUnavailableUpgrade(response)).resolves.toBe(false);
    expect(destroy).toHaveBeenCalled();
  });

  it('gives up on a 503 body that never ends', async () => {
    vi.useFakeTimers();
    const stream = new Readable({ read() {} });
    const destroy = vi.spyOn(stream, 'destroy');
    const reading = readRateLimitUnavailableUpgrade(Object.assign(stream, { statusCode: 503 }));
    stream.push(Buffer.from('{"error":"RATE_LIMIT_UNAVAILABLE"}'));

    await vi.advanceTimersByTimeAsync(UPGRADE_REJECTION_BODY_TIMEOUT_MS);
    await expect(reading).resolves.toBe(false);
    expect(destroy).toHaveBeenCalled();
  });

  it('treats a body error as final', async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error('socket hang up'));
      },
    });
    await expect(
      readRateLimitUnavailableUpgrade(Object.assign(stream, { statusCode: 503 })),
    ).resolves.toBe(false);
  });

  it('only drains any other status, as before', async () => {
    for (const statusCode of [400, 401, 403, 404, 426, 429, 500, 502]) {
      const { response, resume } = upgradeResponse(statusCode, [
        '{"error":"RATE_LIMIT_UNAVAILABLE"}',
      ]);
      const on = vi.spyOn(response, 'on');
      await expect(readRateLimitUnavailableUpgrade(response)).resolves.toBe(false);
      expect(resume).toHaveBeenCalledOnce();
      expect(on).not.toHaveBeenCalled();
    }
  });
});
