/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS,
  APP_BUILD_FLOOR_READ_TIMEOUT_MS,
  createAppBuildFloorCheckGate,
  createServiceWorkerGenerationResolver,
  createServiceWorkerUpdateLedger,
  readEffectiveAppBuildFloor,
} from '../../sw-update-coordination.ts';
import {
  APP_BUILD_FLOOR_CLIENT_PATH,
  APP_BUILD_MAX,
} from '../../../cloudflare/app-build-floor-contract.ts';

function generation(cacheVersion: string | null, promptIdentity = cacheVersion || 'unknown:sw') {
  return { cacheVersion, promptIdentity };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('service-worker update coordination', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('cools down one exact generation briefly after a failed presentation', () => {
    const ledger = createServiceWorkerUpdateLedger();
    const v494 = generation('v494');
    const now = 1_000_000;

    ledger.rememberPresentationFailure(v494, now);

    expect(createServiceWorkerUpdateLedger().isDismissed(v494, now + 4 * 60 * 1000)).toBe(true);
    expect(createServiceWorkerUpdateLedger().isDismissed(generation('v495'), now + 1)).toBe(false);
    expect(createServiceWorkerUpdateLedger().isDismissed(v494, now + 5 * 60 * 1000)).toBe(false);
  });

  it('drops a stored record that outlasts the presentation-failure cooldown', () => {
    const key = 'mxqr-sw-update-dismissal-v1';
    const now = 2_000_000;
    // A record that ends more than the cooldown from now: the clock jumped
    // back after it was written, or it is a 24-hour Later stored before
    // 8.11.11 (Later is now kept by the page only, so the next open asks again).
    localStorage.setItem(
      key,
      JSON.stringify({ identity: 'v494', expiresAt: now + 24 * 60 * 60 * 1000 }),
    );

    expect(createServiceWorkerUpdateLedger().isDismissed(generation('v494'), now)).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();

    const ledger = createServiceWorkerUpdateLedger();
    ledger.rememberPresentationFailure(generation('v494'), now);
    expect(ledger.isDismissed(generation('v494'), now - 60 * 60 * 1000)).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('gives one client the prompt lease while allowing a newer generation to supersede it', () => {
    const first = createServiceWorkerUpdateLedger();
    const second = createServiceWorkerUpdateLedger();
    const now = 3_000_000;

    expect(first.claimPrompt(generation('v494'), now)).toBe(true);
    expect(second.claimPrompt(generation('v494'), now + 1)).toBe(false);
    expect(second.claimPrompt(generation('v495'), now + 2)).toBe(true);
  });

  it('deduplicates explicit update checks origin-wide for one hour', () => {
    const first = createServiceWorkerUpdateLedger();
    const second = createServiceWorkerUpdateLedger();
    const now = 4_000_000;

    expect(first.claimUpdateCheck(now)).toBe(true);
    expect(second.claimUpdateCheck(now + 1)).toBe(false);
    expect(second.claimUpdateCheck(now + 60 * 60 * 1000)).toBe(true);
  });

  it('holds one native prompt lock across documents even when storage is unavailable', async () => {
    const held = new Set<string>();
    const request = vi.fn(
      async (
        name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<void> | void,
      ) => {
        if (held.has(name)) return callback(null);
        held.add(name);
        try {
          await callback({ name });
        } finally {
          held.delete(name);
        }
      },
    );
    vi.stubGlobal('navigator', { locks: { request } });
    vi.stubGlobal('localStorage', undefined);
    const first = createServiceWorkerUpdateLedger();
    const second = createServiceWorkerUpdateLedger();
    const current = generation('v494');
    expect(await first.acquirePrompt(current, vi.fn())).toBe(true);
    expect(await second.acquirePrompt(current, vi.fn())).toBe(false);
    expect(held.size).toBe(1);
    first.releasePrompt(current);
    await Promise.resolve();
    expect(await second.acquirePrompt(current, vi.fn())).toBe(true);
    second.releasePrompt(current);
  });

  it('keeps updates available if Web Locks rejects and storage writes are denied', async () => {
    vi.stubGlobal('navigator', {
      locks: { request: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('denied');
      },
    });
    const ledger = createServiceWorkerUpdateLedger();
    const current = generation('v494');
    expect(await ledger.acquirePrompt(current, vi.fn())).toBe(true);
    ledger.releasePrompt(current);
  });

  it('rejects a legacy race loser before presentation and leaves the winning lease intact', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {});
    const ledger = createServiceWorkerUpdateLedger();
    const current = generation('v494');
    const lost = vi.fn();
    const acquisition = ledger.acquirePrompt(current, lost);
    await vi.advanceTimersByTimeAsync(0);
    const key = 'mxqr-sw-update-prompt-lease-v1';
    const competing = JSON.stringify({
      identity: 'v494',
      owner: 'other-client',
      expiresAt: Date.now() + 300000,
    });
    localStorage.setItem(key, competing);
    window.dispatchEvent(new StorageEvent('storage', { key }));
    await vi.advanceTimersByTimeAsync(50);
    expect(await acquisition).toBe(false);
    expect(lost).toHaveBeenCalledOnce();
    expect(localStorage.getItem(key)).toBe(competing);
    expect(ledger.isDismissed(current)).toBe(false);
  });

  it('notifies late legacy ownership loss without suppressing the winner or another generation', async () => {
    vi.stubGlobal('navigator', {});
    const ledger = createServiceWorkerUpdateLedger();
    const current = generation('v494');
    const lost = vi.fn();
    expect(await ledger.acquirePrompt(current, lost)).toBe(true);
    const key = 'mxqr-sw-update-prompt-lease-v1';
    localStorage.setItem(
      key,
      JSON.stringify({ identity: 'v495', owner: 'new-generation', expiresAt: Date.now() + 300000 }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(lost).not.toHaveBeenCalled();
    const competing = JSON.stringify({
      identity: 'v494',
      owner: 'same-generation-winner',
      expiresAt: Date.now() + 300000,
    });
    localStorage.setItem(key, competing);
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(lost).toHaveBeenCalledOnce();
    ledger.releasePrompt(current);
    expect(localStorage.getItem(key)).toBe(competing);
    expect(ledger.isDismissed(current)).toBe(false);
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(lost).toHaveBeenCalledOnce();
  });

  it('resolves an exact cache generation through the waiting worker protocol', async () => {
    const resolver = createServiceWorkerGenerationResolver();
    const worker = {
      scriptURL: 'https://musixquare.com/service-worker.js',
      postMessage: vi.fn((message: { requestId: string }) => {
        resolver.consumeMessage({
          type: 'MXQR_SW_GENERATION_RESPONSE',
          requestId: message.requestId,
          cacheVersion: 'v494',
        });
      }),
    } as unknown as ServiceWorker;

    await expect(resolver.resolve(worker)).resolves.toEqual({
      cacheVersion: 'v494',
      promptIdentity: 'v494',
    });
  });

  it('falls back to a short-lived stable-script identity when an old worker cannot reply', async () => {
    vi.useFakeTimers();
    const resolver = createServiceWorkerGenerationResolver();
    const worker = {
      scriptURL: 'https://musixquare.com/service-worker.js',
      postMessage: vi.fn(),
    } as unknown as ServiceWorker;

    const pending = resolver.resolve(worker);
    await vi.advanceTimersByTimeAsync(750);

    await expect(pending).resolves.toEqual({
      cacheVersion: null,
      promptIdentity: 'unknown:https://musixquare.com/service-worker.js',
    });
  });
});

/**
 * The App build floor read and its gate (forced update Inc 7, the start and
 * resume check, RO-22): the page reads the effective floor from the App
 * Worker when it starts and when it returns to the foreground. A read that a
 * server answered, or that hit its deadline, is spent; one the page abandoned
 * or that got no response is released.
 */
describe('the App build floor read (forced update, start and resume check)', () => {
  /** A read with its own page abort, as the check makes it. */
  function startRead(): {
    abort: AbortController;
    result: ReturnType<typeof readEffectiveAppBuildFloor>;
  } {
    const abort = new AbortController();
    return {
      abort,
      result: readEffectiveAppBuildFloor(abort.signal, APP_BUILD_FLOOR_READ_TIMEOUT_MS),
    };
  }

  function stubFetch(answer: () => Promise<Response>): ReturnType<typeof vi.fn> {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        answer().then(resolve, reject);
      });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  const json = (body: string, status = 200, contentType = 'application/json') =>
    new Response(body, { status, headers: { 'Content-Type': contentType } });

  it('R1 returns the floor of a well-formed answer, and 0 for no floor', async () => {
    stubFetch(async () => json('{"effectiveMinAppBuild":786}'));
    await expect(startRead().result).resolves.toEqual({ floor: 786, spent: true });
    stubFetch(async () => json('{"effectiveMinAppBuild":0}'));
    await expect(startRead().result).resolves.toEqual({ floor: 0, spent: true });
  });

  it.each([
    ['a missing key', '{}'],
    ['another key', '{"minAppBuild":786}'],
    ['a negative floor', '{"effectiveMinAppBuild":-1}'],
    ['a float', '{"effectiveMinAppBuild":785.5}'],
    ['a string', '{"effectiveMinAppBuild":"786"}'],
    ['a floor above APP_BUILD_MAX', `{"effectiveMinAppBuild":${APP_BUILD_MAX + 1}}`],
    ['null', '{"effectiveMinAppBuild":null}'],
    ['a bare number', '786'],
    ['a JSON null', 'null'],
    ['an array', '[786]'],
    ['an empty body', ''],
  ])('R1 a 200 with %s gives no floor, and the read is spent', async (_name, body) => {
    stubFetch(async () => json(body));
    await expect(startRead().result).resolves.toEqual({ floor: null, spent: true });
  });

  it('R1 an HTML 200 (a static or SPA fallback) gives no floor, and the read is spent', async () => {
    stubFetch(async () => json('<!doctype html><html><body>App</body></html>', 200, 'text/html'));
    await expect(startRead().result).resolves.toEqual({ floor: null, spent: true });
  });

  it('R1 a body over 256 bytes gives no floor, also without a Content-Length', async () => {
    const padded = JSON.stringify({ effectiveMinAppBuild: 786, pad: 'x'.repeat(256) });
    stubFetch(async () => json(padded));
    await expect(startRead().result).resolves.toEqual({ floor: null, spent: true });

    const encoder = new TextEncoder();
    stubFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(padded.slice(0, 200)));
              controller.enqueue(encoder.encode(padded.slice(200)));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    await expect(startRead().result).resolves.toEqual({ floor: null, spent: true });
  });

  it.each([404, 500, 503])(
    'R2 a %i gives no floor, its body is cancelled, and the read is spent',
    async (status) => {
      const cancel = vi.fn();
      stubFetch(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                /* never sends a byte */
              },
              cancel,
            }),
            { status },
          ),
      );
      await expect(startRead().result).resolves.toEqual({ floor: null, spent: true });
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    },
  );

  it('R3 a fetch rejection with no response (offline, connection lost) gives no floor and releases the read', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(startRead().result).resolves.toEqual({ floor: null, spent: false });
  });

  it('R4 no answer: no floor at exactly the read deadline, and the read is spent; the request asks past every cache, without credentials', async () => {
    vi.useFakeTimers();
    const fetch = stubFetch(() => new Promise<Response>(() => undefined));
    const { result } = startRead();
    let settled: unknown = 'pending';
    result.then(
      (value) => {
        settled = value;
      },
      (error: unknown) => {
        settled = error;
      },
    );

    await vi.advanceTimersByTimeAsync(APP_BUILD_FLOOR_READ_TIMEOUT_MS - 1);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ floor: null, spent: true });

    expect(fetch).toHaveBeenCalledOnce();
    const [input, init] = fetch.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(String(input)).toBe(APP_BUILD_FLOOR_CLIENT_PATH);
    expect(init).toMatchObject({
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("R5 the page's own abort (it went hidden) releases the read, before or during the body", async () => {
    stubFetch(() => new Promise<Response>(() => undefined));
    const waiting = startRead();
    waiting.abort.abort();
    await expect(waiting.result).resolves.toEqual({ floor: null, spent: false });

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      readEffectiveAppBuildFloor(aborted.signal, APP_BUILD_FLOOR_READ_TIMEOUT_MS),
    ).resolves.toEqual({ floor: null, spent: false });

    stubFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              /* the body never finishes */
            },
          }),
          { status: 200 },
        ),
    );
    const reading = startRead();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    reading.abort.abort();
    await expect(reading.result).resolves.toEqual({ floor: null, spent: false });
  });

  it('R5 an answer of any status or body and the deadline are spent; an abandoned read and no response are released', async () => {
    const spentBy = async (answer: () => Promise<Response>) => {
      stubFetch(answer);
      return (await startRead().result).spent;
    };
    expect(await spentBy(async () => json('{"effectiveMinAppBuild":786}'))).toBe(true);
    expect(await spentBy(async () => json('not json'))).toBe(true);
    expect(await spentBy(async () => json('{}', 503))).toBe(true);
    expect(await spentBy(() => Promise.reject(new TypeError('network')))).toBe(false);
  });

  it("G1 the gate's first claim is true; a spent read closes the window, which reopens at its end", () => {
    const gate = createAppBuildFloorCheckGate(APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS);
    const start = 1_000_000;
    expect(gate.claim(start)).toBe(true);
    gate.settle(true);
    expect(gate.claim(start + 1)).toBe(false);
    expect(gate.claim(start + APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(gate.claim(start + APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS)).toBe(true);
  });

  it('G2 a claim while a read is in flight is false, even after the window; settling frees it', () => {
    const gate = createAppBuildFloorCheckGate(APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS);
    const start = 2_000_000;
    expect(gate.claim(start)).toBe(true);
    expect(gate.claim(start + 1)).toBe(false);
    expect(gate.claim(start + 10 * APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS)).toBe(false);
    gate.settle(true);
    expect(gate.claim(start + 10 * APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS)).toBe(true);
  });

  it('G3 a released read lets one more start into the same window: two starts per window', () => {
    const gate = createAppBuildFloorCheckGate(APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS);
    const start = 3_000_000;
    expect(gate.claim(start)).toBe(true);
    gate.settle(false);
    expect(gate.claim(start + 1_000)).toBe(true);
    gate.settle(false);
    expect(gate.claim(start + 2_000)).toBe(false);
    expect(gate.claim(start + APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS - 1)).toBe(false);
    // The window opened at the first claim; the next one starts at its end.
    expect(gate.claim(start + APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS)).toBe(true);
    gate.settle(false);
    expect(gate.claim(start + APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS + 1)).toBe(true);
    gate.settle(true);
    expect(gate.claim(start + APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS + 2)).toBe(false);
  });

  it('G3 a clock that steps back opens a new window instead of closing the gate until it catches up', () => {
    const gate = createAppBuildFloorCheckGate(APP_BUILD_FLOOR_CHECK_MIN_INTERVAL_MS);
    const start = 4_000_000;
    expect(gate.claim(start)).toBe(true);
    gate.settle(true);
    expect(gate.claim(start - 3_600_000)).toBe(true);
  });
});
