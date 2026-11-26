import { describe, expect, it } from 'vitest';

import {
  STATUS_BROWSER_CHECK_MINUTES,
  STATUS_BROWSER_CLAIM_TIMEOUT_MS,
  STATUS_BROWSER_CRON,
  STATUS_BROWSER_JOB_TIMEOUT_MINUTES,
  STATUS_BROWSER_NAVIGATION_TIMEOUT_MS,
  STATUS_BROWSER_REPORT_ATTEMPTS,
  STATUS_BROWSER_STEP_TIMEOUT_MS,
  STATUS_CHECK_INTERVAL_MINUTES,
  STATUS_CHECK_RETRY_DELAY_MS,
  STATUS_CLAIM_AUDIENCE,
  STATUS_CLAIM_PATH,
  STATUS_COMPONENT_IDS,
  STATUS_COMPONENT_SCHEDULE,
  STATUS_EDGE_CACHE_KEY_PATH,
  STATUS_EDGE_CACHE_TTL_S,
  STATUS_MONITOR_WORKFLOW_REF,
  STATUS_OPS_RATE_LIMIT,
  STATUS_OPS_RATE_WINDOW_SECONDS,
  STATUS_PRO_PROBE_ROOM_CODE,
  STATUS_PROBE_CLAIM_INTERNAL_PATH,
  STATUS_PROBLEM_AFTER_FAILURES,
  STATUS_PUBLIC_PATH,
  STATUS_REASON_RE,
  STATUS_RECENT_SLOTS,
  STATUS_REPORT_AUDIENCE,
  STATUS_REPORT_BODY_MAX_BYTES,
  STATUS_REPORT_MAX_AGE_MS,
  STATUS_REPORT_MAX_FUTURE_SKEW_MS,
  STATUS_REPORT_PATH,
  STATUS_RESULT_RETENTION_MS,
  STATUS_ROOMS_CHECK_DEADLINE_MS,
  STATUS_ROOMS_CODE_ATTEMPTS,
  STATUS_ROOMS_FRAME_WAIT_MS,
  STATUS_ROOMS_POLL_WAIT_MS,
  STATUS_SCHEMA_VERSION,
  STATUS_SERVER_CHECK_MINUTES,
  STATUS_SERVER_CRON,
  STATUS_STALE_AFTER_MINUTES,
  isStatusComponentId,
  isStatusReason,
  statusSlotAt,
  type StatusSchedule,
} from '../../../cloudflare/status-contract.ts';

const MINUTE_MS = 60_000;
const INTERVAL_MS = STATUS_CHECK_INTERVAL_MINUTES * MINUTE_MS;
const SCHEDULE_MINUTES: Readonly<Record<StatusSchedule, readonly number[]>> = {
  server: STATUS_SERVER_CHECK_MINUTES,
  browser: STATUS_BROWSER_CHECK_MINUTES,
};
const SCHEDULES = Object.keys(SCHEDULE_MINUTES) as StatusSchedule[];

function utc(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`bad test time ${iso}`);
  return ms;
}

describe('status page contract', () => {
  it('pins the public, ops and internal paths and the monitor identity', () => {
    expect(STATUS_SCHEMA_VERSION).toBe(1);
    expect(STATUS_PUBLIC_PATH).toBe('/api/status');
    expect(STATUS_REPORT_PATH).toBe('/api/ops/status-report');
    expect(STATUS_CLAIM_PATH).toBe('/api/ops/status-claim');
    expect(STATUS_REPORT_AUDIENCE).toBe('https://musixquare.com/api/ops/status-report');
    expect(STATUS_CLAIM_AUDIENCE).toBe('https://musixquare.com/api/ops/status-claim');
    expect(STATUS_MONITOR_WORKFLOW_REF).toBe(
      'hiefny/MUSIXQUARE/.github/workflows/status-monitor.yml@refs/heads/main',
    );
    expect(STATUS_EDGE_CACHE_KEY_PATH).toBe('/.well-known/mxqr-cache/status/v1');
    expect(STATUS_PRO_PROBE_ROOM_CODE).toBe('000000');
    expect(STATUS_PROBE_CLAIM_INTERNAL_PATH).toBe('/internal/status-probe/v1/claim');
    // Public signaling hosts answer 404 for every /internal/ path, so only a
    // Durable Object binding can reach the claim.
    expect(STATUS_PROBE_CLAIM_INTERNAL_PATH.startsWith('/internal/')).toBe(true);
  });

  it('lists the four rows in page order, each checked on one schedule', () => {
    expect(STATUS_COMPONENT_IDS).toEqual(['website', 'rooms', 'connection', 'pro']);
    expect(STATUS_COMPONENT_SCHEDULE).toEqual({
      website: 'browser',
      rooms: 'server',
      connection: 'browser',
      pro: 'server',
    });
    expect(Object.keys(STATUS_COMPONENT_SCHEDULE)).toEqual([...STATUS_COMPONENT_IDS]);
    expect(Object.isFrozen(STATUS_COMPONENT_IDS)).toBe(true);
    expect(Object.isFrozen(STATUS_COMPONENT_SCHEDULE)).toBe(true);

    for (const id of STATUS_COMPONENT_IDS) expect(isStatusComponentId(id), id).toBe(true);
    for (const value of ['Website', 'room', 'website ', '', null, undefined, 0, ['pro'], {}]) {
      expect(isStatusComponentId(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('spaces both minute lists evenly by the interval across each hour', () => {
    expect(STATUS_CHECK_INTERVAL_MINUTES).toBe(15);
    expect(STATUS_SERVER_CHECK_MINUTES).toEqual([0, 15, 30, 45]);
    expect(STATUS_BROWSER_CHECK_MINUTES).toEqual([7, 22, 37, 52]);
    for (const schedule of SCHEDULES) {
      const minutes = SCHEDULE_MINUTES[schedule];
      const first = minutes[0] ?? Number.NaN;
      expect(Object.isFrozen(minutes), schedule).toBe(true);
      expect(minutes.length * STATUS_CHECK_INTERVAL_MINUTES, schedule).toBe(60);
      expect(first, schedule).toBeGreaterThanOrEqual(0);
      expect(first, schedule).toBeLessThan(STATUS_CHECK_INTERVAL_MINUTES);
      expect(minutes, schedule).toEqual(
        minutes.map((_, index) => first + index * STATUS_CHECK_INTERVAL_MINUTES),
      );
    }
    // The browser monitor never starts at a server check's minute.
    expect(
      SCHEDULE_MINUTES.browser.filter((minute) => SCHEDULE_MINUTES.server.includes(minute)),
    ).toEqual([]);
  });

  it('writes each cron string as its minute list joined with commas, every hour', () => {
    expect(STATUS_SERVER_CRON).toBe('0,15,30,45 * * * *');
    expect(STATUS_BROWSER_CRON).toBe('7,22,37,52 * * * *');
    expect(STATUS_SERVER_CRON).toBe(`${STATUS_SERVER_CHECK_MINUTES.join(',')} * * * *`);
    expect(STATUS_BROWSER_CRON).toBe(`${STATUS_BROWSER_CHECK_MINUTES.join(',')} * * * *`);
  });

  it('shows 96 slots of 15 minutes (24 hours) and retains enough rows to fill them', () => {
    expect(STATUS_RECENT_SLOTS).toBe(96);
    expect(STATUS_RECENT_SLOTS * STATUS_CHECK_INTERVAL_MINUTES * MINUTE_MS).toBe(
      24 * 60 * MINUTE_MS,
    );
    expect(STATUS_RESULT_RETENTION_MS).toBe(48 * 60 * MINUTE_MS);
    // The newest shown slot can be one interval behind the current one while
    // a check is still running, so a full row reaches back 97 intervals.
    expect(STATUS_RESULT_RETENTION_MS).toBeGreaterThanOrEqual(
      (STATUS_RECENT_SLOTS + 1) * INTERVAL_MS,
    );
  });

  it('shows a problem after two failures in a row and Not checked after 30 minutes', () => {
    expect(STATUS_PROBLEM_AFTER_FAILURES).toBe(2);
    expect(STATUS_STALE_AFTER_MINUTES).toBe(30);
    // A row whose checks arrive on time never reads as Not checked.
    expect(STATUS_STALE_AFTER_MINUTES).toBeGreaterThan(STATUS_CHECK_INTERVAL_MINUTES);
  });

  it('caches the public answer for less than one check interval', () => {
    expect(STATUS_EDGE_CACHE_TTL_S).toBe(30);
    expect(STATUS_EDGE_CACHE_TTL_S * 1_000).toBeLessThan(INTERVAL_MS);
  });

  it('bounds the report window, the report body and the ops rate', () => {
    expect(STATUS_REPORT_MAX_AGE_MS).toBe(20 * MINUTE_MS);
    expect(STATUS_REPORT_MAX_FUTURE_SKEW_MS).toBe(2 * MINUTE_MS);
    expect(STATUS_REPORT_BODY_MAX_BYTES).toBe(4_096);
    expect(STATUS_OPS_RATE_LIMIT).toBe(60);
    expect(STATUS_OPS_RATE_WINDOW_SECONDS).toBe(600);
    // A run that uses its whole job timeout still reports inside the window.
    expect(STATUS_BROWSER_JOB_TIMEOUT_MINUTES * MINUTE_MS).toBeLessThan(STATUS_REPORT_MAX_AGE_MS);
  });

  it('accepts reasons of 1 to 48 lowercase letters, digits or underscores', () => {
    const accepted = ['pro_http_503', 'passing', 'maintenance', 'host_timeout', 'a', '0'];
    for (const reason of [...accepted, 'a'.repeat(48)]) {
      expect(STATUS_REASON_RE.test(reason), reason).toBe(true);
      expect(isStatusReason(reason), reason).toBe(true);
    }
    const refused = [
      'Bad-Reason',
      'a'.repeat(49),
      '',
      'pro-http-503',
      'pro http 503',
      'PASSING',
      ' passing',
      'passing\n',
      `caf${String.fromCodePoint(0xe9)}`,
    ];
    for (const reason of refused) {
      expect(STATUS_REASON_RE.test(reason), JSON.stringify(reason)).toBe(false);
      expect(isStatusReason(reason), JSON.stringify(reason)).toBe(false);
    }
    // RegExp#test would read null as the text "null"; the guard checks the type first.
    for (const value of [null, undefined, 503, ['passing'], { reason: 'passing' }]) {
      expect(isStatusReason(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('fits the server check budgets inside one cron run', () => {
    expect(STATUS_ROOMS_CODE_ATTEMPTS).toBe(3);
    expect(STATUS_ROOMS_CHECK_DEADLINE_MS).toBe(60_000);
    expect(STATUS_ROOMS_FRAME_WAIT_MS).toBe(10_000);
    expect(STATUS_ROOMS_POLL_WAIT_MS).toBe(1_500);
    expect(STATUS_CHECK_RETRY_DELAY_MS).toBe(2_000);
    expect(STATUS_ROOMS_POLL_WAIT_MS).toBeLessThan(STATUS_ROOMS_FRAME_WAIT_MS);
    expect(STATUS_ROOMS_FRAME_WAIT_MS + STATUS_CHECK_RETRY_DELAY_MS).toBeLessThan(
      STATUS_ROOMS_CHECK_DEADLINE_MS,
    );
    // Far below Cloudflare's 15-minute wall-clock limit for a Cron Trigger
    // invocation, and over before the next server check is due.
    expect(STATUS_ROOMS_CHECK_DEADLINE_MS).toBeLessThan(INTERVAL_MS);
  });

  it('fits the browser monitor budgets inside one check interval', () => {
    expect(STATUS_BROWSER_NAVIGATION_TIMEOUT_MS).toBe(30_000);
    expect(STATUS_BROWSER_STEP_TIMEOUT_MS).toBe(25_000);
    expect(STATUS_BROWSER_CLAIM_TIMEOUT_MS).toBe(8_000);
    expect(STATUS_BROWSER_JOB_TIMEOUT_MINUTES).toBe(10);
    expect(STATUS_BROWSER_REPORT_ATTEMPTS).toBe(3);
    // A held host frame waits for its claim within one step.
    expect(STATUS_BROWSER_CLAIM_TIMEOUT_MS).toBeLessThan(STATUS_BROWSER_STEP_TIMEOUT_MS);
    expect(STATUS_BROWSER_JOB_TIMEOUT_MINUTES).toBeLessThan(STATUS_CHECK_INTERVAL_MINUTES);
  });
});

describe('statusSlotAt', () => {
  it('keeps a time at an exact boundary in its own slot', () => {
    expect(statusSlotAt(utc('2026-11-26T10:15:00.000Z'), 'server')).toBe(
      utc('2026-11-26T10:15:00.000Z'),
    );
    expect(statusSlotAt(utc('2026-11-26T10:22:00.000Z'), 'browser')).toBe(
      utc('2026-11-26T10:22:00.000Z'),
    );
  });

  it('puts a time 1 ms before a boundary in the slot before it', () => {
    expect(statusSlotAt(utc('2026-11-26T10:15:00.000Z') - 1, 'server')).toBe(
      utc('2026-11-26T10:00:00.000Z'),
    );
    expect(statusSlotAt(utc('2026-11-26T10:22:00.000Z') - 1, 'browser')).toBe(
      utc('2026-11-26T10:07:00.000Z'),
    );
  });

  it('offsets the browser schedule by its first minute', () => {
    // From 10:00 until 10:07 a browser time still belongs to the 09:52 slot.
    expect(statusSlotAt(utc('2026-11-26T10:00:00.000Z'), 'browser')).toBe(
      utc('2026-11-26T09:52:00.000Z'),
    );
    expect(statusSlotAt(utc('2026-11-26T10:06:59.999Z'), 'browser')).toBe(
      utc('2026-11-26T09:52:00.000Z'),
    );
    expect(statusSlotAt(utc('2026-11-26T10:07:00.000Z'), 'browser')).toBe(
      utc('2026-11-26T10:07:00.000Z'),
    );
    // A browser run that starts late is recorded in the slot it started in.
    expect(statusSlotAt(utc('2026-11-26T10:21:41.250Z'), 'browser')).toBe(
      utc('2026-11-26T10:07:00.000Z'),
    );
    // The same times on the server schedule.
    expect(statusSlotAt(utc('2026-11-26T10:06:59.999Z'), 'server')).toBe(
      utc('2026-11-26T10:00:00.000Z'),
    );
    expect(statusSlotAt(utc('2026-11-26T10:07:00.000Z'), 'server')).toBe(
      utc('2026-11-26T10:00:00.000Z'),
    );
  });

  it('crosses midnight UTC and the end of a year', () => {
    expect(statusSlotAt(utc('2026-11-27T00:00:00.000Z'), 'server')).toBe(
      utc('2026-11-27T00:00:00.000Z'),
    );
    expect(statusSlotAt(utc('2026-11-26T23:59:59.999Z'), 'server')).toBe(
      utc('2026-11-26T23:45:00.000Z'),
    );
    expect(statusSlotAt(utc('2026-11-27T00:06:59.999Z'), 'browser')).toBe(
      utc('2026-11-26T23:52:00.000Z'),
    );
    expect(statusSlotAt(utc('2026-11-27T00:07:00.000Z'), 'browser')).toBe(
      utc('2026-11-27T00:07:00.000Z'),
    );
    expect(statusSlotAt(utc('2027-01-01T00:03:00.000Z'), 'browser')).toBe(
      utc('2026-12-31T23:52:00.000Z'),
    );
  });

  it('maps every time of an hour to a listed minute at most one interval before it', () => {
    const hour = utc('2026-11-26T10:00:00.000Z');
    for (const schedule of SCHEDULES) {
      for (let nowMs = hour; nowMs < hour + 60 * MINUTE_MS; nowMs += 30_000) {
        const slot = statusSlotAt(nowMs, schedule);
        expect(slot).toBeLessThanOrEqual(nowMs);
        expect(nowMs - slot).toBeLessThan(INTERVAL_MS);
        expect(slot % MINUTE_MS).toBe(0);
        expect(SCHEDULE_MINUTES[schedule]).toContain(new Date(slot).getUTCMinutes());
        // A slot is its own slot, so `statusSlotAt(t, s) === t` checks alignment.
        expect(statusSlotAt(slot, schedule)).toBe(slot);
      }
    }
  });

  it('gives no slot for a time that is not finite', () => {
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const schedule of SCHEDULES) {
        const slot = statusSlotAt(nowMs, schedule);
        expect(slot).toBeNaN();
        expect(slot === nowMs).toBe(false);
      }
    }
  });
});
