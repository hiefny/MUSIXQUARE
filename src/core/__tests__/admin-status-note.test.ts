import { afterEach, describe, expect, it, vi } from 'vitest';

import appWorker from '../../../cloudflare/app-worker.ts';
import {
  ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME,
  ADMIN_ANNOUNCEMENT_STATE_PATH,
  ADMIN_ANNOUNCEMENT_STATUS_PATH,
  SERVICE_CONTROL_OBJECT_NAME,
  SERVICE_CONTROL_STATE_PATH,
  STATUS_NOTE_CONTROL_OBJECT_NAME,
  clearServiceMaintenanceCacheForTests,
} from '../../../cloudflare/service-maintenance.ts';
import { STATUS_PUBLIC_PATH } from '../../../cloudflare/status-contract.ts';
import { STATUS_NOTE_MESSAGE_MAX_LENGTH } from '../../../cloudflare/status-note-text.ts';
import { createAtomicRateControlBinding } from './service-control-rate-limit-fixture.ts';

// The admin route of the /status note (GET|HEAD|POST /api/admin/status-note)
// over the real MusixquareServiceControl class, and its projection into
// GET /api/status. The note is a third named object, apart from the in-room
// announcement.

const ORIGIN = 'https://musixquare.com';
const NOTE_PATH = '/api/admin/status-note';
const NOW = '2026-11-26T08:00:00.000Z';

afterEach(() => {
  clearServiceMaintenanceCacheForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function useDateClock(iso: string) {
  // Only Date is fake; the control reads keep their real deadlines.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

/** The real service-control objects by name, with every call recorded. */
function createControl(fail: (name: string) => boolean = () => false) {
  const real = createAtomicRateControlBinding();
  const calls: Array<{ name: string; method: string; path: string }> = [];
  return {
    calls,
    /** Calls that reached an announcement-shaped object (the note or the in-room one). */
    announcementCalls: (name: string) =>
      calls.filter(
        (call) =>
          call.name === name &&
          (call.path === ADMIN_ANNOUNCEMENT_STATE_PATH ||
            call.path === ADMIN_ANNOUNCEMENT_STATUS_PATH),
      ),
    binding: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        const stub = real.binding.get(id);
        return {
          fetch: async (request: Request) => {
            calls.push({ name: id, method: request.method, path: new URL(request.url).pathname });
            if (fail(id)) return Response.json({ error: 'UNAVAILABLE' }, { status: 500 });
            return stub.fetch(request);
          },
        };
      },
    },
  };
}

type Control = ReturnType<typeof createControl>;

function adminEnv(control: Control) {
  return {
    MXQR_ADMIN_PASSWORD: 'admin-password-strong',
    MXQR_ADMIN_SESSION_SECRET: 'test-admin-session-secret-at-least-32',
    MUSIXQUARE_SERVICE_CONTROL: control.binding,
  };
}

function adminHeaders(cookie: string, extra: Record<string, string> = {}) {
  return {
    Cookie: cookie,
    Origin: ORIGIN,
    'Content-Type': 'application/json',
    'X-MXQR-Admin-CSRF': '1',
    ...extra,
  };
}

async function login(env: Record<string, unknown>) {
  const response = await appWorker.fetch(
    new Request(`${ORIGIN}/api/admin/login`, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        'X-MXQR-Admin-CSRF': '1',
        'CF-Connecting-IP': '203.0.113.64',
      },
      body: JSON.stringify({ password: 'admin-password-strong' }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  return response.headers.get('Set-Cookie')?.split(';')[0] || '';
}

function requestId(serial: number) {
  return `123e4567-e89b-42d3-a456-${String(426614174000 + serial).padStart(12, '0')}`;
}

async function postNote(env: Record<string, unknown>, cookie: string, body: unknown) {
  return appWorker.fetch(
    new Request(`${ORIGIN}${NOTE_PATH}`, {
      method: 'POST',
      headers: adminHeaders(cookie),
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function readNote(env: Record<string, unknown>, cookie: string, method = 'GET') {
  return appWorker.fetch(
    new Request(`${ORIGIN}${NOTE_PATH}`, { method, headers: { Cookie: cookie } }),
    env,
  );
}

async function publicStatus(env: Record<string, unknown>) {
  const response = await appWorker.fetch(new Request(`${ORIGIN}${STATUS_PUBLIC_PATH}`), env);
  expect(response.status).toBe(200);
  return (await response.json()) as { announcement: unknown; overall: Record<string, unknown> };
}

interface NotePayload {
  ok?: boolean;
  error?: string;
  generatedAt?: string;
  revision?: number;
  active?: boolean;
  note?: {
    id: string;
    message: string;
    enabled: boolean;
    expiresAt: string | null;
    updatedAt: string;
  };
  history?: Array<{ id: string; message: string; action: string; expiresAt: string | null }>;
}

describe('App Worker status note admin route', () => {
  it('requires the admin session, the admin methods, JSON and the same-origin CSRF header', async () => {
    useDateClock(NOW);
    const control = createControl();
    const env = adminEnv(control);

    const unauthorized = await appWorker.fetch(new Request(`${ORIGIN}${NOTE_PATH}`), env);
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ error: 'UNAUTHORIZED' });
    const anonymousPost = await postNote(env, '', {
      message: 'Hello',
      expiresAt: null,
      expectedRevision: 0,
      requestId: requestId(1),
    });
    expect(anonymousPost.status).toBe(401);

    const cookie = await login(env);
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const response = await appWorker.fetch(
        new Request(`${ORIGIN}${NOTE_PATH}`, { method, headers: adminHeaders(cookie), body: '{}' }),
        env,
      );
      expect(response.status, method).toBe(405);
      expect(response.headers.get('Allow'), method).toBe('GET, HEAD, POST');
    }
    const body = JSON.stringify({
      message: 'Hello',
      expiresAt: null,
      expectedRevision: 0,
      requestId: requestId(2),
    });
    const plain = await appWorker.fetch(
      new Request(`${ORIGIN}${NOTE_PATH}`, {
        method: 'POST',
        headers: adminHeaders(cookie, { 'Content-Type': 'text/plain' }),
        body,
      }),
      env,
    );
    expect(plain.status).toBe(415);
    await expect(plain.json()).resolves.toEqual({ error: 'ADMIN_JSON_REQUIRED' });
    for (const headers of [
      { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      adminHeaders(cookie, { Origin: 'https://example.invalid' }),
    ]) {
      const forged = await appWorker.fetch(
        new Request(`${ORIGIN}${NOTE_PATH}`, { method: 'POST', headers, body }),
        env,
      );
      expect(forged.status).toBe(403);
      await expect(forged.json()).resolves.toEqual({ error: 'ADMIN_CSRF_REJECTED' });
    }
    expect(control.announcementCalls(STATUS_NOTE_CONTROL_OBJECT_NAME)).toEqual([]);
  });

  it('reads the note fresh from its own object, and answers HEAD without a body', async () => {
    useDateClock(NOW);
    const control = createControl();
    const env = adminEnv(control);
    const cookie = await login(env);

    const response = await readNote(env, cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toEqual({
      generatedAt: NOW,
      revision: 0,
      note: { id: '', message: '', enabled: false, expiresAt: null, updatedAt: '' },
      active: false,
      history: [],
    });
    const head = await readNote(env, cookie, 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    await readNote(env, cookie);
    // No isolate cache: every admin read reaches the note object.
    expect(control.announcementCalls(STATUS_NOTE_CONTROL_OBJECT_NAME)).toEqual(
      Array.from({ length: 3 }, () => ({
        name: STATUS_NOTE_CONTROL_OBJECT_NAME,
        method: 'GET',
        path: ADMIN_ANNOUNCEMENT_STATUS_PATH,
      })),
    );
    expect(control.announcementCalls(ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME)).toEqual([]);
  });

  it('accepts exactly the four-field body and refuses text outside the note rules', async () => {
    useDateClock(NOW);
    const control = createControl();
    const env = adminEnv(control);
    const cookie = await login(env);
    const valid = {
      message: 'Checks are paused',
      expiresAt: null,
      expectedRevision: 0,
      requestId: requestId(10),
    };

    const invalidBodies: unknown[] = [
      [],
      'Checks are paused',
      { message: valid.message, expiresAt: null, expectedRevision: 0 },
      // The in-room announcement's five-field body is not the note's.
      { ...valid, enabled: true },
      { ...valid, message: 42 },
      { ...valid, message: null },
      { ...valid, expectedRevision: -1 },
      { ...valid, expectedRevision: 1.5 },
      { ...valid, expectedRevision: '0' },
      { ...valid, requestId: valid.requestId.toUpperCase() },
      { ...valid, requestId: '123e4567-e89b-12d3-a456-426614174010' },
    ];
    for (const body of invalidBodies) {
      const response = await postNote(env, cookie, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
    }
    const malformed = await appWorker.fetch(
      new Request(`${ORIGIN}${NOTE_PATH}`, {
        method: 'POST',
        headers: adminHeaders(cookie),
        body: '{"message":',
      }),
      env,
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: 'Invalid JSON body' });

    const refusals: Array<[string, unknown, string]> = [
      [
        'too long',
        { ...valid, message: 'x'.repeat(STATUS_NOTE_MESSAGE_MAX_LENGTH + 1) },
        'STATUS_NOTE_TOO_LONG',
      ],
      [
        'a bell',
        { ...valid, message: `Checks ${String.fromCharCode(7)} paused` },
        'STATUS_NOTE_INVALID',
      ],
      [
        'a bidi override',
        { ...valid, message: `Checks ${String.fromCodePoint(0x202e)}paused` },
        'STATUS_NOTE_INVALID',
      ],
      [
        'a bidi isolate',
        { ...valid, message: `Checks ${String.fromCodePoint(0x2066)}paused` },
        'STATUS_NOTE_INVALID',
      ],
      [
        'a lone surrogate',
        { ...valid, message: `Checks ${String.fromCharCode(0xd800)}` },
        'STATUS_NOTE_INVALID',
      ],
      ['an expiry that is not a time', { ...valid, expiresAt: 'tomorrow' }, 'INVALID_EXPIRES_AT'],
      [
        'an expiry without a zone',
        { ...valid, expiresAt: '2026-11-26T09:00' },
        'INVALID_EXPIRES_AT',
      ],
      ['a past expiry', { ...valid, expiresAt: '2026-11-26T07:59:00.000Z' }, 'EXPIRES_AT_IN_PAST'],
    ];
    for (const [label, body, error] of refusals) {
      const response = await postNote(env, cookie, body);
      expect(response.status, label).toBe(400);
      await expect(response.json(), label).resolves.toEqual({ error });
    }
    // Refused text never reaches the object; only the past expiry, which the
    // object judges inside its write queue, does, and it writes nothing.
    expect(
      control
        .announcementCalls(STATUS_NOTE_CONTROL_OBJECT_NAME)
        .filter((call) => call.method === 'POST'),
    ).toHaveLength(1);
    const unchanged = (await (await readNote(env, cookie)).json()) as NotePayload;
    expect(unchanged.revision).toBe(0);

    // 280 code units fit, and whitespace runs collapse before the length counts.
    const longest = 'y'.repeat(STATUS_NOTE_MESSAGE_MAX_LENGTH);
    const fits = await postNote(env, cookie, {
      ...valid,
      message: `  ${longest}${String.fromCharCode(10)}  `,
    });
    expect(fits.status).toBe(200);
    await expect(fits.json()).resolves.toMatchObject({ revision: 1, note: { message: longest } });
    const collapsed = await postNote(env, cookie, {
      ...valid,
      message: ` Rooms${String.fromCharCode(9)}are   slow${String.fromCharCode(10, 10)} today `,
      expectedRevision: 1,
      requestId: requestId(11),
    });
    await expect(collapsed.json()).resolves.toMatchObject({
      revision: 2,
      note: { message: 'Rooms are slow today' },
    });
  });

  it('publishes, replays a retry, refuses a stale revision and removes the note', async () => {
    useDateClock(NOW);
    const control = createControl();
    const env = adminEnv(control);
    const cookie = await login(env);
    const publish = {
      message: 'Rooms may reconnect once tonight.',
      expiresAt: '2026-11-26T09:00:00.000Z',
      expectedRevision: 0,
      requestId: requestId(20),
    };

    const published = await postNote(env, cookie, publish);
    expect(published.status).toBe(200);
    const first = (await published.json()) as NotePayload;
    expect(first).toMatchObject({
      ok: true,
      generatedAt: NOW,
      revision: 1,
      active: true,
      note: {
        message: publish.message,
        enabled: true,
        expiresAt: publish.expiresAt,
        updatedAt: NOW,
      },
    });
    expect(first.note?.id).toMatch(/^[A-Za-z0-9._:-]{1,128}$/u);
    expect(first.history).toEqual([
      {
        id: first.note?.id,
        message: publish.message,
        enabled: true,
        expiresAt: publish.expiresAt,
        updatedAt: NOW,
        action: 'published',
      },
    ]);

    // The same request again (a retry after a lost answer) replays the first result.
    const replay = await postNote(env, cookie, publish);
    expect(replay.status).toBe(200);
    const replayed = (await replay.json()) as NotePayload;
    expect(replayed.revision).toBe(1);
    expect(replayed.note?.id).toBe(first.note?.id);
    expect(replayed.history).toHaveLength(1);

    // Another session's change, or a reused request id, gets the current note back.
    for (const [label, body] of [
      ['a stale revision', { ...publish, requestId: requestId(21) }],
      ['a reused request id', { ...publish, message: 'Another text', expectedRevision: 1 }],
    ] as const) {
      const conflict = await postNote(env, cookie, body);
      expect(conflict.status, label).toBe(409);
      await expect(conflict.json(), label).resolves.toMatchObject({
        error: 'STATUS_NOTE_CONFLICT',
        revision: 1,
        active: true,
        note: { id: first.note?.id, message: publish.message },
      });
    }

    // Remove sends an empty message; any expiry it carries is dropped.
    vi.setSystemTime(new Date('2026-11-26T08:10:00.000Z'));
    const removed = await postNote(env, cookie, {
      message: '   ',
      expiresAt: '2026-11-26T10:00:00.000Z',
      expectedRevision: 1,
      requestId: requestId(22),
    });
    expect(removed.status).toBe(200);
    const cleared = (await removed.json()) as NotePayload;
    expect(cleared).toMatchObject({
      ok: true,
      revision: 2,
      active: false,
      note: {
        message: '',
        enabled: false,
        expiresAt: null,
        updatedAt: '2026-11-26T08:10:00.000Z',
      },
    });
    expect(cleared.history?.map((entry) => entry.action)).toEqual(['cleared', 'published']);
    expect((await publicStatus(env)).announcement).toBeNull();
  });

  it('keeps the note and the in-room announcement apart in both directions', async () => {
    useDateClock(NOW);
    const control = createControl();
    const env = adminEnv(control);
    const cookie = await login(env);

    const announcement = await appWorker.fetch(
      new Request(`${ORIGIN}/api/admin/announcement`, {
        method: 'POST',
        headers: adminHeaders(cookie),
        body: JSON.stringify({
          message: 'In-room notice for listeners',
          enabled: true,
          expiresAt: null,
          expectedRevision: 0,
          requestId: requestId(30),
        }),
      }),
      env,
    );
    expect(announcement.status).toBe(200);
    expect((await publicStatus(env)).announcement).toBeNull();
    await expect((await readNote(env, cookie)).json()).resolves.toMatchObject({
      revision: 0,
      note: { message: '' },
    });

    const note = await postNote(env, cookie, {
      message: 'Status note for the public page',
      expiresAt: null,
      expectedRevision: 0,
      requestId: requestId(31),
    });
    expect(note.status).toBe(200);
    const current = await appWorker.fetch(new Request(`${ORIGIN}/api/announcement/current`), env);
    await expect(current.json()).resolves.toMatchObject({
      enabled: true,
      message: 'In-room notice for listeners',
      revision: 1,
    });
    await expect(publicStatus(env)).resolves.toMatchObject({
      announcement: { message: 'Status note for the public page' },
    });

    // Each write reached only its own object.
    const writes = (name: string) =>
      control.announcementCalls(name).filter((call) => call.method === 'POST');
    expect(writes(STATUS_NOTE_CONTROL_OBJECT_NAME)).toHaveLength(1);
    expect(writes(ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME)).toHaveLength(1);
    expect(writes(SERVICE_CONTROL_OBJECT_NAME)).toHaveLength(0);
  });

  it('stays readable and editable while maintenance is on', async () => {
    useDateClock(NOW);
    const control = createControl();
    const env = adminEnv(control);
    const cookie = await login(env);
    const enable = await control.binding.get(SERVICE_CONTROL_OBJECT_NAME).fetch(
      new Request(`https://service-control.internal${SERVICE_CONTROL_STATE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          expectedRevision: 0,
          requestId: requestId(40),
        }),
      }),
    );
    expect(enable.status).toBe(200);
    // The gate learns the state from a fresh admin read.
    const serviceStatus = await appWorker.fetch(
      new Request(`${ORIGIN}/api/admin/service-status`, { headers: { Cookie: cookie } }),
      env,
    );
    await expect(serviceStatus.json()).resolves.toMatchObject({ serviceStatus: { enabled: true } });
    const announcements = await appWorker.fetch(
      new Request(`${ORIGIN}/api/admin/announcement`, { headers: { Cookie: cookie } }),
      env,
    );
    expect(announcements.status).toBe(503);
    await expect(announcements.json()).resolves.toMatchObject({ error: 'SERVICE_MAINTENANCE' });

    expect((await readNote(env, cookie)).status).toBe(200);
    const published = await postNote(env, cookie, {
      message: 'Maintenance until 09:00 UTC.',
      expiresAt: '2026-11-26T09:00:00.000Z',
      expectedRevision: 0,
      requestId: requestId(41),
    });
    expect(published.status).toBe(200);
    await expect(publicStatus(env)).resolves.toMatchObject({
      overall: { state: 'maintenance' },
      announcement: { message: 'Maintenance until 09:00 UTC.' },
    });
  });

  it('projects only an active note into /api/status', async () => {
    useDateClock(NOW);
    const control = createControl();
    const env = adminEnv(control);
    const cookie = await login(env);
    expect((await publicStatus(env)).announcement).toBeNull();

    const published = (await (
      await postNote(env, cookie, {
        message: 'The PRO check is being fixed.',
        expiresAt: '2026-11-26T09:00:00.000Z',
        expectedRevision: 0,
        requestId: requestId(50),
      })
    ).json()) as NotePayload;
    expect((await publicStatus(env)).announcement).toEqual({
      id: published.note?.id,
      message: 'The PRO check is being fixed.',
      postedAt: NOW,
      expiresAt: '2026-11-26T09:00:00.000Z',
    });

    vi.setSystemTime(new Date('2026-11-26T09:00:00.000Z'));
    expect((await publicStatus(env)).announcement).toBeNull();
    await expect((await readNote(env, cookie)).json()).resolves.toMatchObject({
      revision: 1,
      active: false,
      note: { enabled: true },
    });
  });

  it('answers 503 when the note object cannot be read, while /api/status shows no note', async () => {
    useDateClock(NOW);
    const control = createControl((name) => name === STATUS_NOTE_CONTROL_OBJECT_NAME);
    const env = adminEnv(control);
    const cookie = await login(env);

    const read = await readNote(env, cookie);
    expect(read.status).toBe(503);
    await expect(read.json()).resolves.toEqual({ error: 'STATUS_NOTE_CONTROL_UNAVAILABLE' });
    const write = await postNote(env, cookie, {
      message: 'Hello',
      expiresAt: null,
      expectedRevision: 0,
      requestId: requestId(60),
    });
    expect(write.status).toBe(503);
    await expect(write.json()).resolves.toEqual({ error: 'STATUS_NOTE_CONTROL_UNAVAILABLE' });
    expect((await publicStatus(env)).announcement).toBeNull();

    const unbound = await appWorker.fetch(new Request(`${ORIGIN}${STATUS_PUBLIC_PATH}`), {
      ...env,
      MUSIXQUARE_SERVICE_CONTROL: undefined,
    });
    expect(unbound.status).toBe(200);
    await expect(unbound.json()).resolves.toMatchObject({ announcement: null });
  });
});
