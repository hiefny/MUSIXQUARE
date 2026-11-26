import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  STATUS_BROWSER_CHECK_MINUTES,
  STATUS_CHECK_INTERVAL_MINUTES,
  STATUS_COMPONENT_IDS,
  STATUS_PROBLEM_AFTER_FAILURES,
  STATUS_RECENT_SLOTS,
  STATUS_SERVER_CHECK_MINUTES,
  STATUS_STALE_AFTER_MINUTES,
  type StatusCheckRow,
  type StatusComponentId,
  type StatusPublicNote,
} from '../../../cloudflare/status-contract.ts';
import {
  buildStatusPayload,
  type StatusComponentPayload,
  type StatusPayload,
  type StatusPayloadInput,
} from '../../../cloudflare/status-payload.ts';

const MINUTE_MS = 60_000;
const INTERVAL_MS = STATUS_CHECK_INTERVAL_MINUTES * MINUTE_MS;
const STALE_MS = STATUS_STALE_AFTER_MINUTES * MINUTE_MS;
const BROWSER: readonly StatusComponentId[] = ['website', 'connection'];
// The slot string the page accepts (browser/classic-runtime/status-page.ts).
const PAGE_SLOTS_RE = /^[opmn]{1,96}$/u;

const at = (iso: string) => Date.parse(iso);

function check(
  component: StatusComponentId,
  slotIso: string | number,
  result: StatusCheckRow['result'],
  checkedAfterMs: number,
  reason = result === 'o' ? 'passing' : result === 'm' ? 'maintenance' : 'relay_failed',
): StatusCheckRow {
  const slotAt = typeof slotIso === 'number' ? slotIso : at(slotIso);
  const browser = BROWSER.includes(component);
  return {
    component,
    slotAt,
    result,
    reason,
    checkedAt: slotAt + checkedAfterMs,
    source: browser ? 'browser' : 'cron',
    runId: browser ? '4242' : null,
  };
}

/** Rows for a mark string (oldest first) whose last mark is in the slot lastIso; n writes no row. */
function history(
  component: StatusComponentId,
  lastIso: string,
  marks: string,
  checkedAfterMs: number,
): StatusCheckRow[] {
  const last = at(lastIso);
  return [...marks].flatMap((mark, index) =>
    mark === 'n'
      ? []
      : [
          check(
            component,
            last - (marks.length - 1 - index) * INTERVAL_MS,
            mark as StatusCheckRow['result'],
            checkedAfterMs,
          ),
        ],
  );
}

/** Replaces the row of a component's slot. */
function patch(rows: StatusCheckRow[], replacement: StatusCheckRow): StatusCheckRow[] {
  return rows.map((entry) =>
    entry.component === replacement.component && entry.slotAt === replacement.slotAt
      ? replacement
      : entry,
  );
}

function build(overrides: Partial<StatusPayloadInput> & { nowMs: number }): StatusPayload {
  return buildStatusPayload({
    rows: [],
    maintenance: { active: false, sinceMs: null },
    note: null,
    ...overrides,
  });
}

function component(payload: StatusPayload, id: StatusComponentId): StatusComponentPayload {
  const found = payload.components.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

const ISO_FIELDS = new Set([
  'generatedAt',
  'lastCheckedAt',
  'lastOkAt',
  'problemSince',
  'since',
  'lastAt',
  'postedAt',
  'expiresAt',
]);

/** A page fixture as the server writes it: UTC ISO strings with milliseconds. */
function serverForm(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((entry) => serverForm(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        name,
        name === 'timeZone' ? 'UTC' : serverForm(entry, name),
      ]),
    );
  }
  return ISO_FIELDS.has(key) && typeof value === 'string' ? new Date(value).toISOString() : value;
}

function fixture(name: string): Record<string, unknown> & { components: StatusComponentPayload[] } {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(`../../../e2e/fixtures/status/${name}.json`, import.meta.url), 'utf8'),
  );
  return serverForm(raw) as Record<string, unknown> & { components: StatusComponentPayload[] };
}

function noteFrom(expected: Record<string, unknown>): StatusPublicNote | null {
  return (expected.announcement as StatusPublicNote | null) ?? null;
}

describe('status payload builder', () => {
  it('reproduces the ok fixture', () => {
    const expected = fixture('ok');
    const rows = [
      ...history('website', '2026-11-26T05:37:00Z', 'o'.repeat(96), 41_000),
      ...history('rooms', '2026-11-26T05:45:00Z', 'o'.repeat(96), 6_000),
      ...history('connection', '2026-11-26T05:37:00Z', 'o'.repeat(96), 41_000),
      ...history('pro', '2026-11-26T05:45:00Z', 'o'.repeat(96), 6_000),
      // Older rows inside the 48-hour read do not change the last 24 hours.
      check('rooms', '2026-11-25T03:00:00Z', 'p', 6_000),
    ];
    expect(build({ nowMs: at('2026-11-26T05:48:20Z'), rows })).toEqual(expected);
  });

  it('reproduces the short-record fixture, leaving out marks before the first row', () => {
    const expected = fixture('short-record');
    const rows = [
      ...history('website', '2026-11-26T05:37:00Z', 'oooooo', 41_000),
      ...history('rooms', '2026-11-26T05:45:00Z', 'oooooo', 6_000),
      ...history('connection', '2026-11-26T05:37:00Z', 'oooooo', 41_000),
      ...history('pro', '2026-11-26T05:45:00Z', 'oooooo', 6_000),
    ];
    expect(build({ nowMs: at('2026-11-26T05:48:20Z'), rows })).toEqual(expected);
  });

  it('reproduces the problem fixture: two failures in a row, and one that is not', () => {
    const expected = fixture('problem');
    const rooms = expected.components.find((entry) => entry.id === 'rooms')!;
    let rows = [
      ...history('website', '2026-11-26T10:37:00Z', 'o'.repeat(96), 44_000),
      ...history('rooms', '2026-11-26T10:45:00Z', rooms.recent!.slots, 29_000),
      ...history('connection', '2026-11-26T10:37:00Z', 'o'.repeat(96), 44_000),
      ...history('pro', '2026-11-26T10:45:00Z', `${'o'.repeat(94)}pp`, 6_000),
    ];
    rows = patch(rows, check('pro', '2026-11-26T10:30:00Z', 'p', 31_000, 'pro_entry_unreachable'));
    rows = patch(rows, check('pro', '2026-11-26T10:45:00Z', 'p', 29_000, 'pro_entry_unreachable'));
    expect(build({ nowMs: at('2026-11-26T10:52:30Z'), rows, note: noteFrom(expected) })).toEqual(
      expected,
    );
  });

  it('reproduces the maintenance fixture: m rows show but never move lastCheckedAt', () => {
    const expected = fixture('maintenance');
    const rows = [
      ...history('website', '2026-11-26T05:52:00Z', `${'o'.repeat(95)}m`, 41_000),
      ...history('rooms', '2026-11-26T06:00:00Z', `${'o'.repeat(95)}m`, 6_000),
      ...history('connection', '2026-11-26T05:52:00Z', `${'o'.repeat(95)}m`, 41_000),
      ...history('pro', '2026-11-26T06:00:00Z', `${'o'.repeat(95)}m`, 6_000),
    ];
    expect(
      build({
        nowMs: at('2026-11-26T06:04:20Z'),
        rows,
        maintenance: { active: true, sinceMs: at('2026-11-26T05:52:03Z') },
        note: noteFrom(expected),
      }),
    ).toEqual(expected);
  });

  it('reproduces the unavailable-notice fixture when the ledger cannot be read', () => {
    const expected = fixture('unavailable-notice');
    expect(
      build({ nowMs: at('2026-11-26T05:48:20Z'), rows: null, note: noteFrom(expected) }),
    ).toEqual(expected);
  });

  it('builds the stale and some-stale shapes, showing a missed slot once the next one is due', () => {
    // The page fixtures also show the slot whose check is still due; the
    // server leaves it out until a row lands there or the next slot begins.
    const stale = fixture('stale');
    const staleRows = [
      ...history('website', '2026-11-26T12:22:00Z', 'o'.repeat(96), 41_000),
      ...history('rooms', '2026-11-26T12:30:00Z', 'o'.repeat(96), 5_000),
      ...history('connection', '2026-11-26T12:22:00Z', 'o'.repeat(96), 41_000),
      ...history('pro', '2026-11-26T12:30:00Z', 'o'.repeat(96), 5_000),
    ];
    const staleRecent = {
      website: { lastAt: '2026-11-26T12:52:00.000Z', slots: `${'o'.repeat(94)}nn` },
      rooms: { lastAt: '2026-11-26T13:00:00.000Z', slots: `${'o'.repeat(94)}nn` },
    };
    expect(build({ nowMs: at('2026-11-26T13:17:05Z'), rows: staleRows })).toEqual({
      ...stale,
      components: stale.components.map((entry) => ({
        ...entry,
        recent: BROWSER.includes(entry.id) ? staleRecent.website : staleRecent.rooms,
      })),
    });

    const someStale = fixture('some-stale');
    const someStaleRows = [
      ...history('website', '2026-11-26T06:37:00Z', 'o'.repeat(96), 30_000),
      ...history('rooms', '2026-11-26T07:15:00Z', 'o'.repeat(96), 7_000),
      ...history('connection', '2026-11-26T06:37:00Z', 'o'.repeat(96), 30_000),
      ...history('pro', '2026-11-26T07:15:00Z', 'o'.repeat(96), 7_000),
    ];
    expect(build({ nowMs: at('2026-11-26T07:20:00Z'), rows: someStaleRows })).toEqual({
      ...someStale,
      components: someStale.components.map((entry) =>
        BROWSER.includes(entry.id)
          ? {
              ...entry,
              recent: { lastAt: '2026-11-26T06:52:00.000Z', slots: `${'o'.repeat(95)}n` },
            }
          : entry,
      ),
    });
  });

  it('keeps a row ok after a single failure and shows one p cell', () => {
    const nowMs = at('2026-11-26T05:50:00Z');
    const rows = history('pro', '2026-11-26T05:45:00Z', `${'o'.repeat(10)}p`, 6_000);
    const pro = component(build({ nowMs, rows }), 'pro');
    expect(pro).toMatchObject({ state: 'ok', reason: 'passing', problemSince: null });
    expect(pro.lastCheckedAt).toBe('2026-11-26T05:45:06.000Z');
    expect(pro.lastOkAt).toBe('2026-11-26T05:30:06.000Z');
    expect(pro.recent?.slots).toBe(`${'o'.repeat(10)}p`);
  });

  it('reports a problem after two failures in a row, from the first of them', () => {
    expect(STATUS_PROBLEM_AFTER_FAILURES).toBe(2);
    const nowMs = at('2026-11-26T05:50:00Z');
    let rows = history('rooms', '2026-11-26T05:45:00Z', 'ooopopp', 6_000);
    rows = patch(rows, check('rooms', '2026-11-26T05:30:00Z', 'p', 9_000, 'host_timeout'));
    rows = patch(rows, check('rooms', '2026-11-26T05:45:00Z', 'p', 8_000, 'guest_refused'));
    const payload = build({ nowMs, rows });
    expect(component(payload, 'rooms')).toMatchObject({
      state: 'problem',
      reason: 'guest_refused',
      lastCheckedAt: '2026-11-26T05:45:08.000Z',
      lastOkAt: '2026-11-26T05:15:06.000Z',
      problemSince: '2026-11-26T05:30:09.000Z',
    });
    expect(payload.overall).toMatchObject({
      state: 'problem',
      reason: 'component_problem',
      since: '2026-11-26T05:30:09.000Z',
    });
  });

  it('counts failures separated by missed slots or maintenance marks as a run', () => {
    const nowMs = at('2026-11-26T05:50:00Z');
    for (const marks of ['oopnp', 'oopmp', 'oopnmnp']) {
      const rows = history('pro', '2026-11-26T05:45:00Z', marks, 6_000);
      const firstFailure = rows.find((entry) => entry.result === 'p')!;
      expect(component(build({ nowMs, rows }), 'pro'), marks).toMatchObject({
        state: 'problem',
        problemSince: new Date(firstFailure.checkedAt).toISOString(),
      });
    }
    // A pass between the failures ends the run.
    const rows = history('pro', '2026-11-26T05:45:00Z', 'ppop', 6_000);
    expect(component(build({ nowMs, rows }), 'pro').state).toBe('ok');
  });

  it('turns a row stale once its newest passed or failed check is older than 30 minutes', () => {
    const rows = history('rooms', '2026-11-26T05:00:00Z', 'oo', 6_000);
    const lastChecked = at('2026-11-26T05:00:06Z');
    expect(component(build({ nowMs: lastChecked + STALE_MS, rows }), 'rooms').state).toBe('ok');
    expect(component(build({ nowMs: lastChecked + STALE_MS + 1, rows }), 'rooms')).toMatchObject({
      state: 'stale',
      reason: 'not_checked_recently',
      lastCheckedAt: '2026-11-26T05:00:06.000Z',
    });
    // Stale wins over a problem it can no longer confirm.
    const failing = history('rooms', '2026-11-26T05:00:00Z', 'pp', 6_000);
    expect(
      component(build({ nowMs: lastChecked + STALE_MS + 1, rows: failing }), 'rooms'),
    ).toMatchObject({
      state: 'stale',
      problemSince: null,
    });
    // Rows that never passed or failed leave the row unchecked.
    const marked = history('rooms', '2026-11-26T05:00:00Z', 'mm', 6_000);
    expect(component(build({ nowMs: lastChecked, rows: marked }), 'rooms')).toMatchObject({
      state: 'stale',
      lastCheckedAt: null,
      lastOkAt: null,
      recent: { lastAt: '2026-11-26T05:00:00.000Z', slots: 'mm' },
    });
  });

  it('never moves lastCheckedAt or lastOkAt with maintenance marks', () => {
    const rows = history('website', '2026-11-26T05:52:00Z', 'oopmm', 30_000);
    const website = component(build({ nowMs: at('2026-11-26T05:52:15Z'), rows }), 'website');
    expect(website).toMatchObject({
      lastCheckedAt: '2026-11-26T05:22:30.000Z',
      lastOkAt: '2026-11-26T05:07:30.000Z',
      state: 'ok',
      recent: { lastAt: '2026-11-26T05:52:00.000Z', slots: 'oopmm' },
    });
    // Maintenance marks alone never keep a row checked.
    expect(component(build({ nowMs: at('2026-11-26T05:55:00Z'), rows }), 'website')).toMatchObject({
      lastCheckedAt: '2026-11-26T05:22:30.000Z',
      state: 'stale',
    });
  });

  it('lets active maintenance win, also over unavailable results', () => {
    const since = at('2026-11-26T05:40:00Z');
    const rows = history('pro', '2026-11-26T05:45:00Z', 'pp', 6_000);
    const payload = build({
      nowMs: at('2026-11-26T05:50:00Z'),
      rows,
      maintenance: { active: true, sinceMs: since },
    });
    expect(payload.maintenance).toEqual({ active: true, since: '2026-11-26T05:40:00.000Z' });
    expect(payload.overall).toEqual({
      state: 'maintenance',
      reason: 'maintenance',
      lastCheckedAt: '2026-11-26T05:45:06.000Z',
      since: '2026-11-26T05:40:00.000Z',
    });
    expect(
      payload.components.map((entry) => [entry.state, entry.reason, entry.problemSince]),
    ).toEqual(STATUS_COMPONENT_IDS.map(() => ['maintenance', 'maintenance', null]));

    const unavailable = build({
      nowMs: at('2026-11-26T05:50:00Z'),
      rows: null,
      maintenance: { active: true, sinceMs: since },
    });
    expect(unavailable.overall).toEqual({
      state: 'maintenance',
      reason: 'maintenance',
      lastCheckedAt: null,
      since: '2026-11-26T05:40:00.000Z',
    });
    expect(unavailable.components).toEqual(
      STATUS_COMPONENT_IDS.map((id) => ({
        id,
        state: 'maintenance',
        reason: 'maintenance',
        lastCheckedAt: null,
        lastOkAt: null,
        problemSince: null,
        recent: null,
      })),
    );

    // Inactive maintenance never shows a start time.
    expect(
      build({ nowMs: since, maintenance: { active: false, sinceMs: since } }).maintenance,
    ).toEqual({ active: false, since: null });
  });

  it('leaves out the newest slot while its check is pending and trims before the first row', () => {
    // 05:45:30: the 05:45 check may still be running, so 05:30 is the newest shown.
    const rows = [
      check('rooms', '2026-11-26T05:00:00Z', 'o', 6_000),
      check('rooms', '2026-11-26T05:30:00Z', 'o', 6_000),
    ];
    const pending = component(build({ nowMs: at('2026-11-26T05:45:30Z'), rows }), 'rooms');
    expect(pending.recent).toEqual({ lastAt: '2026-11-26T05:30:00.000Z', slots: 'ono' });

    const landed = component(
      build({
        nowMs: at('2026-11-26T05:45:30Z'),
        rows: [...rows, check('rooms', '2026-11-26T05:45:00Z', 'p', 20_000)],
      }),
      'rooms',
    );
    expect(landed.recent).toEqual({ lastAt: '2026-11-26T05:45:00.000Z', slots: 'onop' });

    // Once the next slot begins, the missed one shows as n.
    const missed = component(build({ nowMs: at('2026-11-26T06:00:00Z'), rows }), 'rooms');
    expect(missed.recent).toEqual({ lastAt: '2026-11-26T05:45:00.000Z', slots: 'onon' });

    // Rows older than the window keep all 96 marks.
    const old = component(
      build({
        nowMs: at('2026-11-26T05:45:30Z'),
        rows: [check('rooms', '2026-11-25T03:00:00Z', 'o', 6_000), ...rows],
      }),
      'rooms',
    );
    expect(old.recent?.slots).toBe(`${'n'.repeat(93)}ono`);
    expect(old.recent?.slots).toHaveLength(STATUS_RECENT_SLOTS);
  });

  it('has no recent marks for a component without rows, or with only a future slot', () => {
    const nowMs = at('2026-11-26T05:51:30Z');
    expect(component(build({ nowMs, rows: [] }), 'website')).toEqual({
      id: 'website',
      state: 'stale',
      reason: 'not_checked_recently',
      lastCheckedAt: null,
      lastOkAt: null,
      problemSince: null,
      recent: null,
    });
    // A report whose run started a little ahead of the Worker clock lands in
    // the 05:52 slot at 05:51; until 05:52 its slot is not shown yet.
    const ahead = [check('website', '2026-11-26T05:52:00Z', 'o', -MINUTE_MS)];
    expect(component(build({ nowMs, rows: ahead }), 'website')).toMatchObject({
      state: 'ok',
      lastCheckedAt: '2026-11-26T05:51:00.000Z',
      recent: null,
    });
  });

  it('ignores rows the contract refuses and keeps the newest of two rows for a slot', () => {
    const nowMs = at('2026-11-26T05:50:00Z');
    const rows = [
      check('rooms', '2026-11-26T05:30:00Z', 'o', 6_000),
      check('rooms', '2026-11-26T05:30:00Z', 'p', 3_000),
      check('rooms', '2026-11-26T05:45:00Z', 'p', 6_000),
      check('rooms', '2026-11-26T05:45:00Z', 'o', 9_000),
      // Off the server schedule, an unknown reason alphabet, an unknown component.
      check('rooms', '2026-11-26T05:46:00Z', 'p', 1_000),
      { ...check('rooms', '2026-11-26T05:15:00Z', 'p', 1_000), reason: 'Bad Reason' },
      { ...check('rooms', '2026-11-26T05:00:00Z', 'p', 1_000), component: 'signaling' },
    ] as StatusCheckRow[];
    const rooms = component(build({ nowMs, rows }), 'rooms');
    expect(rooms).toMatchObject({
      state: 'ok',
      lastCheckedAt: '2026-11-26T05:45:09.000Z',
      recent: { lastAt: '2026-11-26T05:45:00.000Z', slots: 'oo' },
    });
  });

  it('takes lastCheckedAt from the newest check time, not from the newest slot', () => {
    // A late run is recorded in the slot it started in, after the next run reported.
    const rows = [
      check('website', '2026-11-26T05:22:00Z', 'o', 18 * MINUTE_MS),
      check('website', '2026-11-26T05:37:00Z', 'p', 90_000),
    ];
    expect(component(build({ nowMs: at('2026-11-26T05:45:00Z'), rows }), 'website')).toEqual({
      id: 'website',
      state: 'ok',
      reason: 'passing',
      lastCheckedAt: '2026-11-26T05:40:00.000Z',
      lastOkAt: '2026-11-26T05:40:00.000Z',
      problemSince: null,
      recent: { lastAt: '2026-11-26T05:37:00.000Z', slots: 'op' },
    });
  });

  it('dates an overall problem from the earliest problem of several rows', () => {
    const rows = [
      ...history('rooms', '2026-11-26T05:45:00Z', 'oppp', 7_000),
      ...history('pro', '2026-11-26T05:45:00Z', 'oopp', 9_000),
      ...history('website', '2026-11-26T05:37:00Z', 'o', 30_000),
      ...history('connection', '2026-11-26T05:37:00Z', 'pp', 30_000),
    ];
    const payload = build({ nowMs: at('2026-11-26T05:50:00Z'), rows });
    expect(payload.components.map((entry) => [entry.id, entry.state, entry.problemSince])).toEqual([
      ['website', 'ok', null],
      ['rooms', 'problem', '2026-11-26T05:15:07.000Z'],
      ['connection', 'problem', '2026-11-26T05:22:30.000Z'],
      ['pro', 'problem', '2026-11-26T05:30:09.000Z'],
    ]);
    expect(payload.overall).toEqual({
      state: 'problem',
      reason: 'component_problem',
      lastCheckedAt: '2026-11-26T05:45:09.000Z',
      since: '2026-11-26T05:15:07.000Z',
    });
  });

  it('shows the status note only while it is published', () => {
    const nowMs = at('2026-11-26T05:50:00Z');
    const note: StatusPublicNote = {
      id: 'note-1',
      message: 'We are looking into slow joins.',
      postedAt: '2026-11-26T05:40:00.000Z',
      expiresAt: '2026-11-26T06:00:00.000Z',
    };
    expect(build({ nowMs, note: null }).announcement).toBeNull();
    expect(build({ nowMs, note }).announcement).toEqual(note);
    expect(build({ nowMs, note: { ...note, expiresAt: null } }).announcement).toEqual({
      ...note,
      expiresAt: null,
    });
    expect(build({ nowMs: at(note.expiresAt!) - 1, note }).announcement).toEqual(note);
    expect(build({ nowMs: at(note.expiresAt!), note }).announcement).toBeNull();
    expect(build({ nowMs: at(note.expiresAt!) + 1, note }).announcement).toBeNull();
    expect(build({ nowMs, note: { ...note, expiresAt: 'not a time' } }).announcement).toBeNull();
    expect(build({ nowMs, note: { ...note, message: '  ' } }).announcement).toBeNull();
    // The note does not depend on the ledger.
    expect(build({ nowMs, rows: null, note }).announcement).toEqual(note);
  });

  it('writes the contract policy and the page shape for every component in order', () => {
    const nowMs = at('2026-11-26T05:50:00Z');
    const rows = STATUS_COMPONENT_IDS.flatMap((id) =>
      history(
        id,
        BROWSER.includes(id) ? '2026-11-26T05:37:00Z' : '2026-11-26T05:45:00Z',
        'opmno',
        5_000,
      ),
    );
    const payload = build({ nowMs, rows });
    expect(payload.schemaVersion).toBe(1);
    expect(payload.generatedAt).toBe('2026-11-26T05:50:00.000Z');
    expect(payload.timeZone).toBe('UTC');
    expect(payload.policy).toEqual({
      checkIntervalMinutes: STATUS_CHECK_INTERVAL_MINUTES,
      problemAfterFailures: STATUS_PROBLEM_AFTER_FAILURES,
      staleAfterMinutes: STATUS_STALE_AFTER_MINUTES,
      recentSlots: STATUS_RECENT_SLOTS,
      schedule: {
        server: [...STATUS_SERVER_CHECK_MINUTES],
        browser: [...STATUS_BROWSER_CHECK_MINUTES],
      },
    });
    for (const fixtureName of ['ok', 'problem', 'maintenance', 'stale']) {
      expect(fixture(fixtureName).policy).toEqual(payload.policy);
    }
    expect(payload.components.map((entry) => entry.id)).toEqual([...STATUS_COMPONENT_IDS]);
    for (const entry of payload.components) {
      expect(entry.recent?.slots).toMatch(PAGE_SLOTS_RE);
      expect(entry.recent?.slots).toBe('opmno');
      for (const value of [entry.lastCheckedAt, entry.lastOkAt, entry.recent?.lastAt]) {
        expect(new Date(value!).toISOString()).toBe(value);
      }
    }
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    expect(() => build({ nowMs: Number.NaN })).toThrow(TypeError);
  });
});
