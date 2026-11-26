import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  STATUS_BROWSER_CHECK_MINUTES,
  STATUS_BROWSER_CLAIM_TIMEOUT_MS,
  STATUS_BROWSER_CRON,
  STATUS_BROWSER_JOB_TIMEOUT_MINUTES,
  STATUS_CHECK_INTERVAL_MINUTES,
  STATUS_CLAIM_AUDIENCE,
  STATUS_COMPONENT_IDS,
  STATUS_COMPONENT_SCHEDULE,
  STATUS_PROBE_CLAIM_INTERNAL_PATH,
  STATUS_PROBLEM_AFTER_FAILURES,
  STATUS_PUBLIC_PATH,
  STATUS_RECENT_SLOTS,
  STATUS_REPORT_AUDIENCE,
  STATUS_ROOMS_CHECK_DEADLINE_MS,
  STATUS_ROOMS_POLL_WAIT_MS,
  STATUS_SCHEMA_VERSION,
  STATUS_SERVER_CHECK_MINUTES,
  STATUS_SERVER_CRON,
  STATUS_STALE_AFTER_MINUTES,
  statusSlotAt,
  type StatusCheckRow,
  type StatusComponentId,
  type StatusStoredResult,
} from '../../../cloudflare/status-contract.ts';
import {
  STATUS_OPS_BODY_VERSION,
  STATUS_REPORT_COMPONENTS,
  STATUS_REPORT_OUTCOMES,
} from '../../../cloudflare/status-ops.ts';
import { buildStatusPayload, type StatusPayload } from '../../../cloudflare/status-payload.ts';
import {
  MONITOR_MAINTENANCE,
  MONITOR_PASSING,
  STATUS_MONITOR_APP_ORIGIN,
  buildStatusReport,
  monitorFailure,
  monitorSkipped,
  requestStatusClaim,
  type OidcTokenSource,
  type StatusMonitorDeps,
} from '../../../scripts/lib/status-browser-monitor-lib.mts';

// cloudflare/status-contract.ts is the timing home of resource-ownership
// record RO-57 (the public status check ledger). The copies below cannot
// import it: a Wrangler and a workflow cron, a classic runtime script, static
// HTML, JSON fixtures, the dev server, the share card generator and the
// signaling Worker, which owns the probe claim. This suite pins each copy to
// the contract, the monitor's request bodies to the routes that read them,
// and the contract's budgets to the bounds that other homes keep.

const MINUTE_MS = 60_000;
const INTERVAL_MS = STATUS_CHECK_INTERVAL_MINUTES * MINUTE_MS;
const NOW = Date.parse('2026-11-26T06:31:00.000Z');
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five'] as const;
const FIXTURE_DIRECTORY = 'e2e/fixtures/status';
// A synthetic Standard room code.
const ROOM_ID = '123456';

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/gu, '\n');
}

/** The value text of the one single-line `const NAME = value;` in a source. */
function constantText(source: string, name: string): string {
  const matches = [
    ...source.matchAll(new RegExp(`^[ \\t]*const ${name}(?:: [^=]+)? = (.+);$`, 'gmu')),
  ];
  expect(
    matches.map((match) => match[1]),
    name,
  ).toHaveLength(1);
  return matches[0]?.[1] ?? '';
}

/** A numeric constant written as a literal or a product of literals (`30 * 60_000`). */
function numericConstant(source: string, name: string): number {
  const text = constantText(source, name);
  expect(text, name).toMatch(/^[\d_]+(?: \* [\d_]+)*$/u);
  return text
    .split(' * ')
    .reduce((product, factor) => product * Number(factor.replace(/_/gu, '')), 1);
}

function stringConstant(source: string, name: string): string {
  const text = constantText(source, name);
  expect(text, name).toMatch(/^'[^']*'$/u);
  return text.slice(1, -1);
}

function quotedStrings(text: string): string[] {
  return [...text.matchAll(/'([^']*)'/gu)].map((match) => match[1] ?? '');
}

const RESULT_REASONS = {
  o: 'passing',
  p: 'check_failed',
  m: 'maintenance',
} as const satisfies Record<StatusStoredResult, string>;

/** A valid ledger row `slotsAgo` slots before the newest slot of its row's schedule. */
function ledgerRow(
  component: StatusComponentId,
  slotsAgo: number,
  result: StatusStoredResult,
): StatusCheckRow {
  const schedule = STATUS_COMPONENT_SCHEDULE[component];
  const slotAt = statusSlotAt(NOW, schedule) - slotsAgo * INTERVAL_MS;
  return {
    component,
    slotAt,
    result,
    reason: RESULT_REASONS[result],
    checkedAt: slotAt + 30_000,
    source: schedule === 'server' ? 'cron' : 'browser',
    runId: schedule === 'server' ? null : '9000000001',
  };
}

/**
 * Two answers, the second during maintenance, that between them show every
 * state and every mark the API sends: rooms passing, pro failing twice in a
 * row, website never checked, and connection passing after a failure, a
 * maintenance mark and a missed slot.
 */
function builtPayloads(): StatusPayload[] {
  const rows = [
    ledgerRow('rooms', 0, 'o'),
    ledgerRow('pro', 1, 'p'),
    ledgerRow('pro', 0, 'p'),
    ledgerRow('connection', 4, 'o'),
    ledgerRow('connection', 2, 'm'),
    ledgerRow('connection', 1, 'p'),
    ledgerRow('connection', 0, 'o'),
  ];
  return [false, true].map((active) =>
    buildStatusPayload({
      nowMs: NOW,
      rows,
      maintenance: { active, sinceMs: active ? NOW - INTERVAL_MS : null },
      note: null,
    }),
  );
}

const CONTRACT_POLICY = {
  checkIntervalMinutes: STATUS_CHECK_INTERVAL_MINUTES,
  problemAfterFailures: STATUS_PROBLEM_AFTER_FAILURES,
  staleAfterMinutes: STATUS_STALE_AFTER_MINUTES,
  recentSlots: STATUS_RECENT_SLOTS,
  schedule: {
    server: [...STATUS_SERVER_CHECK_MINUTES],
    browser: [...STATUS_BROWSER_CHECK_MINUTES],
  },
};

describe('status policy parity (resource record RO-57)', () => {
  it('keeps the App cron trigger and the monitor workflow on the contract schedule', () => {
    const wrangler = read('cloudflare/wrangler.app.toml');
    const crons = /^\[triggers\]\n(?:#[^\n]*\n)*crons = \[([^\]\n]*)\]$/mu.exec(wrangler)?.[1];
    expect(crons).toBeDefined();
    const triggers = [...(crons ?? '').matchAll(/"([^"]*)"/gu)].map((match) => match[1]);
    expect(triggers.filter((cron) => cron === STATUS_SERVER_CRON)).toHaveLength(1);
    // scheduled() matches the imported string; no copy of it lives in the App.
    const app = read('cloudflare/app-worker.ts');
    expect(app).toContain('cron === STATUS_SERVER_CRON');
    expect(app).not.toContain(`'${STATUS_SERVER_CRON}'`);

    const workflow = read('.github/workflows/status-monitor.yml');
    expect([...workflow.matchAll(/^[ \t]*- cron: '([^']*)'$/gmu)].map((match) => match[1])).toEqual(
      [STATUS_BROWSER_CRON],
    );
    // The job's own timeout; each step's timeout sits deeper.
    expect(
      [...workflow.matchAll(/^ {4}timeout-minutes: (\d+)$/gmu)].map((match) => Number(match[1])),
    ).toEqual([STATUS_BROWSER_JOB_TIMEOUT_MINUTES]);
  });

  it('keeps the page runtime and the dev server fixture route on the contract and the API', () => {
    const page = read('browser/classic-runtime/status-page.ts');
    expect(stringConstant(page, 'STATUS_URL')).toBe(STATUS_PUBLIC_PATH);
    expect(/\brecord\.schemaVersion !== (\d+)\)/u.exec(page)?.[1]).toBe(
      String(STATUS_SCHEMA_VERSION),
    );
    expect(numericConstant(page, 'SHOWN_SLOTS')).toBe(STATUS_RECENT_SLOTS);
    expect(quotedStrings(constantText(page, 'COMPONENT_IDS'))).toEqual([...STATUS_COMPONENT_IDS]);

    // Every state and every mark the API sends is one the page accepts, and
    // the page accepts nothing else.
    const pageStates = quotedStrings(constantText(page, 'COMPONENT_STATES'));
    const slotsPattern = /^\/\^\[([a-z]+)\]\{1,(\d+)\}\$\/u$/u.exec(
      constantText(page, 'RECENT_SLOTS_RE'),
    );
    expect(slotsPattern).not.toBeNull();
    const pageMarks = [...(slotsPattern?.[1] ?? '')];
    expect(Number(slotsPattern?.[2])).toBe(STATUS_RECENT_SLOTS);
    const payloads = builtPayloads();
    const states = payloads.flatMap((payload) => [
      payload.overall.state,
      ...payload.components.map((component) => component.state),
    ]);
    expect([...new Set(states)].sort()).toEqual([...pageStates].sort());
    expect(pageStates).toHaveLength(new Set(pageStates).size);
    const slots = payloads.flatMap((payload) =>
      payload.components.map((component) => component.recent?.slots ?? ''),
    );
    expect([...new Set(slots.join(''))].sort()).toEqual([...pageMarks].sort());
    expect(pageMarks).toHaveLength(new Set(pageMarks).size);
    const pageSlots = new RegExp(`^[${pageMarks.join('')}]{1,${STATUS_RECENT_SLOTS}}$`, 'u');
    for (const marks of slots.filter((value) => value !== '')) {
      expect(marks).toMatch(pageSlots);
    }

    // The dev server answers the page's path from e2e/fixtures/status/.
    const vite = read('vite.config.ts');
    expect(/function devStatusFixtures\b[\s\S]*?\bpathname !== '([^']*)'/u.exec(vite)?.[1]).toBe(
      STATUS_PUBLIC_PATH,
    );
  });

  it('keeps the page copy and the share card on the contract policy', () => {
    const html = read('.workshop/status/status.html');
    expect([...html.matchAll(/\bdata-component="([^"]*)"/gu)].map((match) => match[1])).toEqual([
      ...STATUS_COMPONENT_IDS,
    ]);

    const text = html.replace(/\s+/gu, ' ');
    const hours = (STATUS_RECENT_SLOTS * STATUS_CHECK_INTERVAL_MINUTES) / 60;
    for (const phrase of [
      `every ${STATUS_CHECK_INTERVAL_MINUTES} minutes`,
      `last ${hours} hours`,
      `${NUMBER_WORDS[STATUS_PROBLEM_AFTER_FAILURES]} checks in a row`,
      `last ${STATUS_STALE_AFTER_MINUTES} minutes`,
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    // The descriptions repeat the interval; every mention says the same.
    const intervals = [...text.matchAll(/\bevery (\d+) minutes\b/giu)].map((match) =>
      Number(match[1]),
    );
    expect(intervals.length).toBeGreaterThan(1);
    expect(new Set(intervals)).toEqual(new Set([STATUS_CHECK_INTERVAL_MINUTES]));

    // The share card bakes the interval into public/og-status.png.
    const og = read('scripts/generate-static-og.mts');
    expect(
      /outFile: 'public\/og-status\.png',\s*props: \{[^}]*\btagline: '([^']*)'/u.exec(og)?.[1],
    ).toBe(`Checked every ${STATUS_CHECK_INTERVAL_MINUTES} minutes`);
  });

  it('keeps every page fixture on the contract policy and the API shape', () => {
    const [built] = builtPayloads();
    expect(built?.policy).toEqual(CONTRACT_POLICY);
    const componentKeys = Object.keys(built?.components[0] ?? {}).sort();
    expect(componentKeys.length).toBeGreaterThan(0);

    const names = readdirSync(FIXTURE_DIRECTORY)
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const fixture = JSON.parse(read(`${FIXTURE_DIRECTORY}/${name}`)) as {
        readonly schemaVersion?: unknown;
        readonly policy?: unknown;
        readonly components?: ReadonlyArray<Record<string, unknown>>;
      };
      expect(fixture.schemaVersion, name).toBe(STATUS_SCHEMA_VERSION);
      expect(fixture.policy, name).toEqual(CONTRACT_POLICY);
      expect(Object.keys(fixture).sort(), name).toEqual(Object.keys(built ?? {}).sort());
      expect(
        (fixture.components ?? []).map((component) => component.id),
        name,
      ).toEqual([...STATUS_COMPONENT_IDS]);
      for (const component of fixture.components ?? []) {
        expect(Object.keys(component).sort(), name).toEqual(componentKeys);
      }
    }
  });

  it("keeps signaling's claim route and status probe events on the contract and the admin metrics", () => {
    const signaling = read('cloudflare/signaling-worker.ts');
    expect(stringConstant(signaling, 'STATUS_PROBE_CLAIM_PATH')).toBe(
      STATUS_PROBE_CLAIM_INTERNAL_PATH,
    );
    expect(signaling).toContain('url.pathname === STATUS_PROBE_CLAIM_PATH');
    const probeEvents = [
      ...new Set([...signaling.matchAll(/'(status_probe_[a-z_]+)'/gu)].map((match) => match[1])),
    ].sort();
    expect(probeEvents).toEqual(['status_probe_guest_joined', 'status_probe_room_opened']);

    // The admin dashboard lists the events signaling records.
    const app = read('cloudflare/app-worker.ts');
    const metricEvents = /^const ADMIN_METRIC_EVENTS = \[\n([\s\S]*?)\n\];$/mu.exec(app)?.[1];
    expect(metricEvents).toBeDefined();
    const keys = [...(metricEvents ?? '').matchAll(/\bkey: '([a-z_]+)'/gu)].map(
      (match) => match[1],
    );
    expect(keys).toContain('room_opened');
    expect(keys.filter((key) => key?.startsWith('status_probe_')).sort()).toEqual(probeEvents);
  });

  it("keeps the browser monitor's report and claim bodies on the ops routes' wire contract", async () => {
    // The monitor runs in Node and does not import the Worker module that
    // owns the outcome names, the body version and the reported rows.
    const results = [
      MONITOR_PASSING,
      MONITOR_MAINTENANCE,
      monitorFailure('chat_to_guest_failed'),
      monitorSkipped('claim_unavailable'),
    ];
    expect(new Set(results.map((result) => result.outcome))).toEqual(
      new Set(STATUS_REPORT_OUTCOMES),
    );
    for (const outcome of STATUS_REPORT_OUTCOMES) {
      const body = buildStatusReport(NOW, { outcome, reason: 'passing' }, MONITOR_PASSING);
      expect(Object.keys(body)).toEqual(['v', 'startedAt', 'results']);
      expect(body.v).toBe(STATUS_OPS_BODY_VERSION);
      expect(Object.keys(body.results)).toEqual([...STATUS_REPORT_COMPONENTS]);
      expect(body.results.website.outcome).toBe(outcome);
    }

    const sent: unknown[] = [];
    const deps: StatusMonitorDeps = {
      fetch: async (_url, init) => {
        sent.push(JSON.parse(typeof init.body === 'string' ? init.body : 'null'));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      env: {},
      write: () => {},
      now: () => NOW,
      sleep: async () => {},
    };
    const tokens: OidcTokenSource = { get: async () => 'header.payload.signature' };
    await expect(
      requestStatusClaim(ROOM_ID, tokens, deps, new AbortController().signal),
    ).resolves.toBe('claimed');
    expect(sent).toEqual([{ v: STATUS_OPS_BODY_VERSION, roomId: ROOM_ID }]);

    // The monitor calls the origin its tokens are minted for.
    expect(new URL(STATUS_REPORT_AUDIENCE).origin).toBe(STATUS_MONITOR_APP_ORIGIN);
    expect(new URL(STATUS_CLAIM_AUDIENCE).origin).toBe(STATUS_MONITOR_APP_ORIGIN);
  });

  it('fits the rooms check inside the bridge bounds and the probe claim and flag lifetimes', () => {
    const signaling = read('cloudflare/signaling-worker.ts');
    const app = read('cloudflare/app-worker.ts');
    // A poll that waits its whole time is one signaling accepts, and it
    // answers inside the App's bound on a poll call.
    expect(STATUS_ROOMS_POLL_WAIT_MS).toBeLessThanOrEqual(
      numericConstant(signaling, 'STANDARD_HTTP_BRIDGE_MAX_WAIT_MS'),
    );
    expect(STATUS_ROOMS_POLL_WAIT_MS).toBeLessThan(
      numericConstant(app, 'STANDARD_SIGNALING_BRIDGE_POLL_TIMEOUT_MS'),
    );

    // A claim outlives the cron run that made it, and a browser claim's
    // answer followed by its host's authentication.
    const claimTtl = numericConstant(signaling, 'STATUS_PROBE_CLAIM_TTL_MS');
    expect(claimTtl).toBeGreaterThanOrEqual(STATUS_ROOMS_CHECK_DEADLINE_MS);
    expect(claimTtl).toBeGreaterThan(
      STATUS_BROWSER_CLAIM_TIMEOUT_MS + numericConstant(signaling, 'HOST_AUTH_TIMEOUT_MS'),
    );

    // The probe flag outlives every probe room's epoch: the longest monitor
    // job, or a cron run whose bridge sessions end only by their lease, and
    // then the host's reclaim grace.
    const flagTtl = numericConstant(signaling, 'STATUS_PROBE_ROOM_TTL_MS');
    const reclaimGrace = numericConstant(signaling, 'HOST_RECLAIM_GRACE_MS');
    expect(flagTtl).toBeGreaterThan(STATUS_BROWSER_JOB_TIMEOUT_MINUTES * MINUTE_MS + reclaimGrace);
    expect(flagTtl).toBeGreaterThan(
      STATUS_ROOMS_CHECK_DEADLINE_MS +
        numericConstant(signaling, 'STANDARD_HTTP_BRIDGE_LEASE_MS') +
        reclaimGrace,
    );
  });
});
