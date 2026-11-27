import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  STATUS_BROWSER_CHECK_MINUTES,
  STATUS_DISPATCH_TIMEOUT_MS,
} from '../../../cloudflare/status-contract.ts';
import {
  STATUS_DISPATCH_FAILURES,
  dispatchStatusMonitor,
  isStatusDispatchMinute,
  type StatusDispatchAnswer,
  type StatusDispatchDeps,
  type StatusDispatchRequest,
  type StatusDispatchWarnFields,
} from '../../../cloudflare/status-dispatch.ts';

/**
 * The App Worker's start of the status browser monitor
 * (cloudflare/status-dispatch.ts, registry record RO-57) against a fake
 * GitHub on fake timers. The token is a made-up value in no real token
 * format.
 */

const TOKEN = 'status-dispatch-test-token-7f3a9c';
const DISPATCH_URL =
  'https://api.github.com/repos/hiefny/MUSIXQUARE/actions/workflows/status-monitor.yml/dispatches';
const HOUR = Date.UTC(2026, 10, 27, 3);
const MINUTE_MS = 60_000;

type Timer = ReturnType<typeof setTimeout>;

interface Sent {
  readonly url: string;
  readonly init: StatusDispatchRequest;
}

/** Fake dependencies; `secret` stands for the env's token value, set or not (TOKEN by default). */
function harness(
  respond: (init: StatusDispatchRequest) => Promise<StatusDispatchAnswer>,
  secret: { readonly token: unknown } = { token: TOKEN },
) {
  const sent: Sent[] = [];
  const warnings: StatusDispatchWarnFields[] = [];
  const timers: Timer[] = [];
  const deps = {
    token: secret.token,
    fetch: vi.fn((url: string, init: StatusDispatchRequest) => {
      sent.push({ url, init });
      return respond(init);
    }),
    setTimer: vi.fn((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      timers.push(timer);
      return timer;
    }),
    clearTimer: vi.fn((timer: Timer) => clearTimeout(timer)),
    warn: vi.fn((fields: StatusDispatchWarnFields) => {
      warnings.push(fields);
    }),
  } satisfies StatusDispatchDeps<Timer>;
  return { deps, sent, warnings, timers };
}

/** A GitHub answer whose body records that the dispatch let it go. */
function answer(status: number, headers: Record<string, string> = {}) {
  const cancel = vi.fn(async (_reason?: unknown) => undefined);
  const value: StatusDispatchAnswer = { status, headers: new Headers(headers), body: { cancel } };
  return { value, cancel };
}

function expectTimerCleared(run: ReturnType<typeof harness>) {
  expect(run.deps.setTimer).toHaveBeenCalledTimes(1);
  expect(run.deps.setTimer).toHaveBeenCalledWith(expect.any(Function), STATUS_DISPATCH_TIMEOUT_MS);
  expect(run.deps.clearTimer).toHaveBeenCalledTimes(1);
  expect(run.deps.clearTimer).toHaveBeenCalledWith(run.timers[0]);
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isStatusDispatchMinute', () => {
  it('is true for the whole of each browser check minute, in UTC', () => {
    for (const minute of STATUS_BROWSER_CHECK_MINUTES) {
      const start = HOUR + minute * MINUTE_MS;
      expect(isStatusDispatchMinute(start), `:${minute}`).toBe(true);
      expect(isStatusDispatchMinute(start + MINUTE_MS - 1), `:${minute} end`).toBe(true);
      expect(isStatusDispatchMinute(start - 1), `before :${minute}`).toBe(false);
      expect(isStatusDispatchMinute(start + MINUTE_MS), `after :${minute}`).toBe(false);
    }
    // A cron's scheduledTime is an instant: 12:07 KST is 03:07 UTC.
    expect(isStatusDispatchMinute(Date.parse('2026-11-27T12:07:00+09:00'))).toBe(true);
    expect(isStatusDispatchMinute(Date.parse('2026-11-27T12:08:00+09:00'))).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an ISO string', '2026-11-27T03:07:00.000Z'],
    ['a Date', new Date(HOUR + 7 * MINUTE_MS)],
    ['a bigint', BigInt(HOUR + 7 * MINUTE_MS)],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a time past the Date range', 8.64e15 + 7 * MINUTE_MS],
  ])('is false for %s', (_label, scheduledTime) => {
    expect(isStatusDispatchMinute(scheduledTime)).toBe(false);
  });
});

describe('dispatchStatusMonitor', () => {
  it('asks GitHub once to start status-monitor.yml on main, with exactly this request', async () => {
    const run = harness(async () => answer(204).value);

    await expect(dispatchStatusMonitor(run.deps)).resolves.toEqual({
      outcome: 'dispatched',
      httpStatus: 204,
    });

    expect(run.sent).toHaveLength(1);
    const [{ url, init }] = run.sent as [Sent];
    expect(url).toBe(DISPATCH_URL);
    expect(Object.keys(init).sort()).toEqual(['body', 'headers', 'method', 'redirect', 'signal']);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'MUSIXQUARE-status-dispatcher',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    expect(init.body).toBe('{"ref":"main"}');
    // A redirect is not followed, so the token reaches api.github.com only.
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
    expect(run.warnings).toEqual([]);
    expectTimerCleared(run);
  });

  it('takes a 200 with the run details as dispatched and lets its body go unread', async () => {
    const response = Response.json(
      {
        workflow_run_id: 1,
        run_url: 'https://api.github.test/run',
        html_url: 'https://github.test/run',
      },
      { status: 200 },
    );
    const run = harness(async () => response);

    await expect(dispatchStatusMonitor(run.deps)).resolves.toEqual({
      outcome: 'dispatched',
      httpStatus: 200,
    });
    expect(run.warnings).toEqual([]);
    expect(response.bodyUsed).toBe(true);
    expectTimerCleared(run);
  });

  it.each([
    [401, {}, 'unauthorized'],
    [403, {}, 'forbidden'],
    [403, { 'x-ratelimit-remaining': '4999' }, 'forbidden'],
    [403, { 'x-ratelimit-remaining': '0' }, 'rate_limited'],
    [403, { 'retry-after': '60' }, 'rate_limited'],
    [404, {}, 'not_found'],
    [422, {}, 'unprocessable'],
    [429, {}, 'rate_limited'],
    [429, { 'retry-after': '30' }, 'rate_limited'],
    [500, {}, 'failed'],
    [502, {}, 'failed'],
    [503, { 'retry-after': '120' }, 'failed'],
    [599, {}, 'failed'],
    [201, {}, 'unexpected'],
    [202, {}, 'unexpected'],
    [301, { location: 'https://api.github.com/repositories/1/actions' }, 'unexpected'],
    [307, { location: 'https://example.test/elsewhere' }, 'unexpected'],
    [400, {}, 'unexpected'],
    [409, {}, 'unexpected'],
    [410, {}, 'unexpected'],
  ] as const)(
    'classifies HTTP %i %j as %s, warns once and sends nothing more',
    async (status, headers, outcome) => {
      const github = answer(status, headers);
      const run = harness(async () => github.value);

      await expect(dispatchStatusMonitor(run.deps)).resolves.toEqual({
        outcome,
        httpStatus: status,
      });

      // One request: a failure is never retried within one call.
      expect(run.deps.fetch).toHaveBeenCalledTimes(1);
      expect(run.warnings).toEqual([{ outcome, httpStatus: status }]);
      expect(github.cancel).toHaveBeenCalledTimes(1);
      expectTimerCleared(run);
    },
  );

  it('reaches every listed outcome, and the runbook explains each one', async () => {
    const reached = new Set<string>();
    const unconfigured = harness(async () => answer(204).value, { token: undefined });
    reached.add((await dispatchStatusMonitor(unconfigured.deps)).outcome);
    for (const status of [401, 403, 404, 422, 429, 503, 400]) {
      const run = harness(async () => answer(status).value);
      reached.add((await dispatchStatusMonitor(run.deps)).outcome);
    }
    expect([...reached].sort()).toEqual([...STATUS_DISPATCH_FAILURES].sort());
    expect(Object.isFrozen(STATUS_DISPATCH_FAILURES)).toBe(true);

    const runbook = readFileSync('cloudflare/admin-dashboard-ops.md', 'utf8').replace(
      /\r\n/gu,
      '\n',
    );
    const section = runbook.slice(
      runbook.indexOf('\n## Status page\n'),
      runbook.indexOf('\n## ', runbook.indexOf('\n## Status page\n') + 1),
    );
    expect(section).toContain("diagnostic: 'status_dispatch'");
    for (const outcome of STATUS_DISPATCH_FAILURES) {
      expect(section, outcome).toMatch(new RegExp(`^- \`${outcome}\``, 'mu'));
    }
  });

  it.each([0, 99, 600, 204.5, Number.NaN])(
    'calls an answer with the status %s unexpected and reports no status',
    async (status) => {
      const run = harness(async () => answer(status).value);

      await expect(dispatchStatusMonitor(run.deps)).resolves.toEqual({ outcome: 'unexpected' });
      expect(run.warnings).toEqual([{ outcome: 'unexpected' }]);
      expectTimerCleared(run);
    },
  );

  it('counts a request that fails or throws as failed, with no HTTP status', async () => {
    for (const fetch of [
      async () => Promise.reject(new TypeError('network connection lost')),
      () => {
        throw new TypeError('invalid request');
      },
    ]) {
      const run = harness(fetch);

      await expect(dispatchStatusMonitor(run.deps)).resolves.toEqual({ outcome: 'failed' });
      expect(run.deps.fetch).toHaveBeenCalledTimes(1);
      expect(run.warnings).toEqual([{ outcome: 'failed' }]);
      expectTimerCleared(run);
    }
  });

  it('gives up at STATUS_DISPATCH_TIMEOUT_MS, aborts the request and clears its timer', async () => {
    // GitHub never answers; like fetch, the request rejects once aborted.
    const run = harness(
      (init) =>
        new Promise<StatusDispatchAnswer>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    );
    let settled = false;
    const dispatch = dispatchStatusMonitor(run.deps).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(STATUS_DISPATCH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(run.sent[0]?.init.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(dispatch).resolves.toEqual({ outcome: 'failed' });
    expect(run.sent[0]?.init.signal.aborted).toBe(true);
    expect(run.deps.fetch).toHaveBeenCalledTimes(1);
    expect(run.warnings).toEqual([{ outcome: 'failed' }]);
    expectTimerCleared(run);
  });

  it('drops an answer that arrives after the bound unread', async () => {
    const late = answer(204);
    const run = harness(
      () =>
        new Promise<StatusDispatchAnswer>((resolve) => {
          setTimeout(() => resolve(late.value), STATUS_DISPATCH_TIMEOUT_MS + 5_000);
        }),
    );

    const dispatch = dispatchStatusMonitor(run.deps);
    await vi.advanceTimersByTimeAsync(STATUS_DISPATCH_TIMEOUT_MS);
    await expect(dispatch).resolves.toEqual({ outcome: 'failed' });
    expect(late.cancel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(late.cancel).toHaveBeenCalledTimes(1);
    expect(run.warnings).toEqual([{ outcome: 'failed' }]);
    expect(run.deps.clearTimer).toHaveBeenCalledWith(run.timers[0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['no token', undefined],
    ['null', null],
    ['an empty token', ''],
    ['only whitespace', ' \n\t '],
    ['a number', 42],
    ['an object', { token: TOKEN }],
    ['a token with a space inside', 'status dispatch'],
    ['a token with a line break inside', 'status\ndispatch'],
    ['a token that is not ASCII', `${TOKEN}é`],
    ['a token longer than 1024 characters', 'x'.repeat(1025)],
  ])('sends no request and arms no timer with %s', async (_label, token) => {
    const run = harness(async () => answer(204).value, { token });

    await expect(dispatchStatusMonitor(run.deps)).resolves.toEqual({ outcome: 'unconfigured' });
    expect(run.deps.fetch).not.toHaveBeenCalled();
    expect(run.deps.setTimer).not.toHaveBeenCalled();
    expect(run.warnings).toEqual([{ outcome: 'unconfigured' }]);
  });

  it('uses a token without the whitespace around it', async () => {
    const run = harness(async () => answer(204).value, { token: `  ${TOKEN}\n` });

    await expect(dispatchStatusMonitor(run.deps)).resolves.toMatchObject({
      outcome: 'dispatched',
    });
    expect(run.sent[0]?.init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('keeps its outcome when a body cannot be cancelled', async () => {
    for (const cancel of [
      vi.fn(async () => Promise.reject(new Error('stream already closed'))),
      vi.fn(() => {
        throw new TypeError('stream locked');
      }),
    ]) {
      const run = harness(async () => ({ status: 404, headers: new Headers(), body: { cancel } }));

      await expect(dispatchStatusMonitor(run.deps)).resolves.toEqual({
        outcome: 'not_found',
        httpStatus: 404,
      });
      expect(cancel).toHaveBeenCalledTimes(1);
    }
  });

  it('never rejects, and keeps its outcome when the warning sink or the timers throw', async () => {
    const warnThrows = harness(async () => answer(500).value);
    warnThrows.deps.warn.mockImplementation(() => {
      throw new Error('log sink down');
    });
    await expect(dispatchStatusMonitor(warnThrows.deps)).resolves.toEqual({
      outcome: 'failed',
      httpStatus: 500,
    });

    const clearThrows = harness(async () => answer(204).value);
    clearThrows.deps.clearTimer.mockImplementation(() => {
      throw new Error('timer table corrupt');
    });
    await expect(dispatchStatusMonitor(clearThrows.deps)).resolves.toEqual({
      outcome: 'dispatched',
      httpStatus: 204,
    });

    const setThrows = harness(async () => answer(204).value);
    setThrows.deps.setTimer.mockImplementation(() => {
      throw new Error('no timers left');
    });
    await expect(dispatchStatusMonitor(setThrows.deps)).resolves.toEqual({ outcome: 'failed' });
    expect(setThrows.deps.fetch).not.toHaveBeenCalled();
    expect(setThrows.warnings).toEqual([{ outcome: 'failed' }]);
  });

  it('never puts the token, a header or a body in a warning, and logs nothing itself', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const leaky = (status: number): StatusDispatchAnswer => ({
      status,
      headers: new Headers({ 'x-github-request-id': `request-${TOKEN}`, 'retry-after': '5' }),
      body: { cancel: async () => undefined },
    });
    const warnings: StatusDispatchWarnFields[] = [];
    for (const respond of [
      async () => leaky(401),
      async () => leaky(403),
      async () => leaky(502),
      async () => Promise.reject(new Error(`connect failed for Bearer ${TOKEN}`)),
    ]) {
      const run = harness(respond);
      await dispatchStatusMonitor(run.deps);
      warnings.push(...run.warnings);
    }
    const unconfigured = harness(async () => leaky(204), { token: `${TOKEN} with spaces` });
    await dispatchStatusMonitor(unconfigured.deps);
    warnings.push(...unconfigured.warnings);

    expect(warnings).toEqual([
      { outcome: 'unauthorized', httpStatus: 401 },
      { outcome: 'rate_limited', httpStatus: 403 },
      { outcome: 'failed', httpStatus: 502 },
      { outcome: 'failed' },
      { outcome: 'unconfigured' },
    ]);
    const printed = JSON.stringify(warnings);
    for (const secret of [TOKEN, 'Bearer', 'request-', 'connect failed']) {
      expect(printed).not.toContain(secret);
    }
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
