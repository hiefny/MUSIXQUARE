// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { compileClassicRuntimeForBrowserTest } from './classic-runtime-test-asset.ts';

const adminScript = compileClassicRuntimeForBrowserTest('admin.js');
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const FAR_EXPIRY = '2099-01-01T00:00:00.000Z';

// The Status page note panel the App Worker renders in the Maintenance view.
const STATUS_NOTE_PANEL = `
  <section class="panel status-note-panel" aria-labelledby="status-note-title" data-status-note-panel>
    <div class="panel-head"><h2 id="status-note-title">Status page note</h2></div>
    <p class="status-note-summary">Shown on musixquare.com/status. Write it in English. It is separate from the in-room announcement.</p>
    <form class="announcement-form" data-status-note-form>
      <label class="announcement-field">
        <span>Message</span>
        <textarea name="message" rows="3" maxlength="280" data-status-note-message></textarea>
      </label>
      <label class="announcement-field announcement-expires">
        <span>Expires (optional)</span>
        <input type="text" name="expiresAt" placeholder="YYYY-MM-DD HH:MM" data-status-note-expires>
      </label>
      <div class="announcement-actions">
        <button type="submit" data-status-note-publish>Publish</button>
        <button type="button" data-status-note-clear>Remove</button>
      </div>
      <p class="announcement-status" role="status" data-status-note-status></p>
      <p role="alert" data-status-note-error hidden></p>
    </form>
    <article class="announcement-preview" data-status-note-preview hidden></article>
    <section class="announcement-history" aria-label="Status page note history">
      <div class="announcement-history-head">
        <span>History</span><small data-status-note-history-status></small>
      </div>
      <div class="announcement-history-list" data-status-note-history-list></div>
    </section>
  </section>`;

function installDom({ notePanel = true }: { readonly notePanel?: boolean } = {}): void {
  document.body.innerHTML = `
    <main class="admin-shell" data-admin-configured="true">
      <section data-login-panel>
        <form data-login-form><input name="password"><button type="submit">Login</button></form>
        <p data-login-status></p>
      </section>
      <section data-dashboard hidden>
        <h1 data-dashboard-title>Analytics</h1><p data-updated-at></p>
        <button data-refresh>Refresh</button><button data-logout>Logout</button>
        <nav>
          <button data-admin-tab="operations">Analytics</button>
          <button data-admin-tab="maintenance" data-service-status-trigger>
            <span data-service-status-dot></span><span data-service-status-label></span>
          </button>
        </nav>
        <section data-admin-view="maintenance" hidden>
          <section data-service-status-panel>
            <h2 data-service-status-state></h2>
            <p data-service-status-description></p><p data-service-status-updated></p>
            <div class="service-status-actions">
              <button type="button" data-service-status-change>Change</button>
            </div>
            <div data-service-status-confirmation hidden>
              <p data-service-status-confirmation-copy></p>
              <button type="button" data-service-status-confirm>Confirm</button>
              <button type="button" data-service-status-cancel>Cancel</button>
            </div>
            <p role="alert" data-service-status-error hidden></p>
          </section>
          ${notePanel ? STATUS_NOTE_PANEL : ''}
          <section>
            <button data-service-history-refresh>Refresh</button>
            <p data-service-history-status></p><ol data-service-history-list></ol>
          </section>
        </section>
        <section data-admin-view="operations">
          <div data-metric-cards></div><div data-hourly-chart></div>
          <div data-daily-list></div><div data-monthly-chart></div><div data-signal-grid></div>
        </section>
      </section>
    </main>`;
}

interface NoteRecord {
  readonly id: string;
  readonly message: string;
  readonly enabled: boolean;
  readonly expiresAt: string | null;
  readonly updatedAt: string;
}

interface NoteServer {
  revision: number;
  note: NoteRecord;
  history: Array<NoteRecord & { readonly action: 'published' | 'cleared' }>;
}

// A stand-in for /api/admin/status-note: the revision fence and the payload
// shape of the App Worker route, without its storage.
function storeNote(server: NoteServer, message: string, expiresAt: string | null): void {
  server.revision += 1;
  const note = {
    id: `status-note-${server.revision}`,
    message,
    enabled: message !== '',
    expiresAt: message ? expiresAt : null,
    updatedAt: new Date().toISOString(),
  };
  server.note = note;
  server.history = [{ ...note, action: message ? 'published' : 'cleared' }, ...server.history];
}

function noteServer(message = '', expiresAt: string | null = null): NoteServer {
  const server: NoteServer = {
    revision: 0,
    note: { id: '', message: '', enabled: false, expiresAt: null, updatedAt: '' },
    history: [],
  };
  if (message) storeNote(server, message, expiresAt);
  return server;
}

function notePayload(server: NoteServer): Record<string, unknown> {
  const { note } = server;
  return {
    generatedAt: new Date().toISOString(),
    revision: server.revision,
    note,
    active: note.enabled && (note.expiresAt === null || Date.parse(note.expiresAt) > Date.now()),
    history: server.history,
  };
}

type Reply = Response | Promise<Response> | undefined | Promise<undefined>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function installFetch(options: {
  readonly server: NoteServer;
  readonly maintenance?: boolean;
  readonly read?: (count: number, signal: AbortSignal | null | undefined) => Reply;
  readonly write?: (body: Record<string, unknown>, count: number) => Reply;
}) {
  const { server } = options;
  const writes: Array<Record<string, unknown>> = [];
  const counts = { reads: 0 };
  let serviceStatus = {
    enabled: options.maintenance === true,
    revision: options.maintenance === true ? 1 : 0,
    updatedAt: null as string | null,
    activatedAt: null as string | null,
    settlesAt: null as string | null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), location.origin).pathname;
      const method = init?.method ?? 'GET';
      if (path === '/api/admin/session') return Response.json({ authenticated: true });
      if (path === '/api/admin/service-status') {
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { enabled: boolean };
          const changedAt = new Date().toISOString();
          serviceStatus = {
            enabled: body.enabled,
            revision: serviceStatus.revision + 1,
            updatedAt: changedAt,
            activatedAt: body.enabled ? changedAt : null,
            settlesAt: null,
          };
        }
        return Response.json({ serviceStatus });
      }
      if (path === '/api/admin/service-status/history') {
        return Response.json({ history: [], truncated: false });
      }
      if (path === '/api/admin/announcement') {
        return Response.json({
          revision: 0,
          announcement: { message: '', enabled: false },
          history: [],
        });
      }
      if (path === '/api/admin/status-note' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        writes.push(body);
        const reply = await options.write?.(body, writes.length);
        if (reply) return reply;
        if (body.expectedRevision !== server.revision) {
          return Response.json(
            { error: 'STATUS_NOTE_CONFLICT', ...notePayload(server) },
            { status: 409 },
          );
        }
        storeNote(server, String(body.message), body.expiresAt as string | null);
        return Response.json({ ok: true, ...notePayload(server) });
      }
      if (path === '/api/admin/status-note') {
        counts.reads += 1;
        const reply = await options.read?.(counts.reads, init?.signal);
        if (reply) return reply;
        return Response.json(notePayload(server));
      }
      return Response.json({ cards: [], summary: {}, rooms: [], campaigns: [], articles: [] });
    }),
  );
  return { writes, counts };
}

// Rejects like a real fetch once the client aborts the read.
function abortable(response: Promise<Response>, signal: AbortSignal | null | undefined) {
  return new Promise<Response>((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
      once: true,
    });
    response.then(resolve, reject);
  });
}

function query<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

const form = () => query<HTMLFormElement>('[data-status-note-form]');
const message = () => query<HTMLTextAreaElement>('[data-status-note-message]');
const expires = () => query<HTMLInputElement>('[data-status-note-expires]');
const publishButton = () => query<HTMLButtonElement>('[data-status-note-publish]');
const removeButton = () => query<HTMLButtonElement>('[data-status-note-clear]');
const errorEl = () => query<HTMLElement>('[data-status-note-error]');
const preview = () => query<HTMLElement>('[data-status-note-preview]');
const historyList = () => query<HTMLElement>('[data-status-note-history-list]');
const status = () => query<HTMLElement>('[data-status-note-status]').textContent ?? '';
const historyStatus = () => query<HTMLElement>('[data-status-note-history-status]').textContent;
const updatedAt = () => query<HTMLElement>('[data-updated-at]').textContent ?? '';

async function signIn(): Promise<void> {
  window.eval(adminScript);
  await vi.waitFor(() => {
    expect(query<HTMLElement>('[data-dashboard]').hidden).toBe(false);
    expect(query<HTMLElement>('[data-service-status-trigger]').dataset.state).toMatch(
      /^(?:operational|maintenance)$/u,
    );
  });
}

function openMaintenance(): void {
  query<HTMLButtonElement>('[data-admin-tab="maintenance"]').click();
}

function expectCleared(): void {
  expect(message().value).toBe('');
  expect(expires().value).toBe('');
  expect(status()).toBe('');
  expect(errorEl().hidden).toBe(true);
  expect(preview().hidden).toBe(true);
  expect(preview().childElementCount).toBe(0);
  expect(historyList().childElementCount).toBe(0);
  expect(historyStatus()).toBe('');
}

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('admin status page note', () => {
  it.each([
    ['service operational', false],
    ['maintenance on', true],
  ])('loads the note when the Maintenance tab opens: %s', async (_name, maintenance) => {
    installDom();
    const { counts } = installFetch({
      server: noteServer('Checks are delayed', FAR_EXPIRY),
      maintenance,
    });
    await signIn();
    expect(counts.reads).toBe(0);

    openMaintenance();

    await vi.waitFor(() => expect(message().value).toBe('Checks are delayed'));
    expect(counts.reads).toBe(1);
    expect(status()).toMatch(/^Shown on the status page - expires .+ - updated /u);
    expect(expires().value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u);
    expect(preview().hidden).toBe(false);
    expect(preview().querySelector('span')?.textContent).toBe('musixquare.com/status');
    expect(preview().querySelector('p')?.textContent).toBe('Checks are delayed');
    expect(historyStatus()).toBe('1 record');
    expect(historyList().querySelector('strong')?.textContent).toBe('Published');
    expect(errorEl().hidden).toBe(true);
  });

  it('keeps a note read running when maintenance starts, then publishes during maintenance', async () => {
    installDom();
    const server = noteServer('Checks are delayed');
    const firstRead = deferred<Response>();
    const { counts, writes } = installFetch({
      server,
      read: (count, signal) => (count === 1 ? abortable(firstRead.promise, signal) : undefined),
    });
    await signIn();
    openMaintenance();
    await vi.waitFor(() => expect(counts.reads).toBe(1));

    // Entering maintenance stops every dashboard read except the Maintenance view's.
    const change = query<HTMLButtonElement>('[data-service-status-change]');
    await vi.waitFor(() => expect(change.disabled).toBe(false));
    change.click();
    await vi.waitFor(() =>
      expect(query<HTMLElement>('[data-service-status-confirmation]').hidden).toBe(false),
    );
    query<HTMLButtonElement>('[data-service-status-confirm]').click();
    await vi.waitFor(() =>
      expect(query<HTMLElement>('[data-service-status-trigger]').dataset.state).toBe('maintenance'),
    );
    firstRead.resolve(Response.json(notePayload(server)));
    await vi.waitFor(() => expect(message().value).toBe('Checks are delayed'));
    expect(errorEl().hidden).toBe(true);

    message().value = 'Maintenance until 06:00 UTC';
    form().requestSubmit();
    await vi.waitFor(() => expect(historyStatus()).toBe('2 records'));
    expect(writes).toHaveLength(1);
    expect(status()).toMatch(/^Shown on the status page - updated /u);
    expect(preview().querySelector('p')?.textContent).toBe('Maintenance until 06:00 UTC');
  });

  it('publishes the exact body one request at a time and shows markup as text', async () => {
    installDom();
    const server = noteServer();
    const held = deferred<undefined>();
    const { counts, writes } = installFetch({ server, write: () => held.promise });
    await signIn();
    openMaintenance();
    await vi.waitFor(() => expect(status()).toBe('No note'));
    expect(historyStatus()).toBe('No records');
    expect(preview().hidden).toBe(true);

    const canonical = '<b>Rooms</b> are <img src=x onerror=alert(1)> slow';
    message().value = '  <b>Rooms</b>\n are   <img src=x onerror=alert(1)> slow  ';
    expires().value = '2099-01-02 03:04';
    form().requestSubmit();
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(status()).toBe('Publishing...');
    for (const control of [message(), expires(), publishButton(), removeButton()]) {
      expect(control.disabled).toBe(true);
    }
    expect(form().getAttribute('aria-busy')).toBe('true');

    // A second Publish, a Remove and a reload all wait for the change.
    form().requestSubmit();
    removeButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    openMaintenance();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes).toHaveLength(1);
    expect(counts.reads).toBe(1);

    expect(Object.keys(writes[0] ?? {})).toEqual([
      'message',
      'expiresAt',
      'expectedRevision',
      'requestId',
    ]);
    expect(writes[0]).toEqual({
      message: canonical,
      expiresAt: new Date(2099, 0, 2, 3, 4).toISOString(),
      expectedRevision: 0,
      requestId: expect.stringMatching(REQUEST_ID_RE),
    });

    held.resolve(undefined);
    await vi.waitFor(() => expect(status()).toMatch(/^Shown on the status page - expires /u));
    expect(message().value).toBe(canonical);
    expect(expires().value).toBe('2099-01-02 03:04');
    expect(message().disabled).toBe(false);
    expect(publishButton().disabled).toBe(false);
    expect(form().hasAttribute('aria-busy')).toBe(false);
    expect(preview().hidden).toBe(false);
    expect(preview().querySelector('p')?.textContent).toBe(canonical);
    expect(preview().querySelector('b, img, script')).toBeNull();
    expect(historyStatus()).toBe('1 record');
    expect(historyList().textContent).toContain(canonical);
    expect(historyList().querySelector('b, img, script')).toBeNull();
  });

  it('removes the note with an empty message and no expiry', async () => {
    installDom();
    const { writes } = installFetch({ server: noteServer('Checks are delayed', FAR_EXPIRY) });
    await signIn();
    openMaintenance();
    await vi.waitFor(() => expect(message().value).toBe('Checks are delayed'));
    expect(expires().value).not.toBe('');

    // Remove ignores an unsaved edit: it removes what the status page shows.
    message().value = 'An unsaved edit';
    removeButton().click();
    await vi.waitFor(() => expect(status()).toMatch(/^No note - updated /u));
    expect(writes).toEqual([
      {
        message: '',
        expiresAt: null,
        expectedRevision: 1,
        requestId: expect.stringMatching(REQUEST_ID_RE),
      },
    ]);
    expect(message().value).toBe('');
    expect(expires().value).toBe('');
    expect(preview().hidden).toBe(true);
    expect(historyStatus()).toBe('2 records');
    expect(historyList().querySelector('strong')?.textContent).toBe('Removed');

    removeButton().click();
    expect(errorEl().textContent).toBe('There is no note to remove.');
    expect(writes).toHaveLength(1);
  });

  it('checks the message and the expiry before it sends', async () => {
    installDom();
    const { writes } = installFetch({ server: noteServer() });
    await signIn();
    openMaintenance();
    await vi.waitFor(() => expect(status()).toBe('No note'));

    message().value = ' \n ';
    form().requestSubmit();
    expect(errorEl().textContent).toBe('Write a message to publish, or use Remove.');
    message().value = 'Checks are delayed';
    expires().value = 'next week';
    form().requestSubmit();
    expect(errorEl().textContent).toBe('Use YYYY-MM-DD HH:MM for Expires.');
    expires().value = '2001-01-01 00:00';
    form().requestSubmit();
    expect(errorEl().textContent).toBe('Expires must be in the future.');
    expect(errorEl().hidden).toBe(false);
    expect(writes).toEqual([]);
  });

  it.each([
    [
      'a 503',
      () => Response.json({ error: 'STATUS_NOTE_CONTROL_UNAVAILABLE' }, { status: 503 }),
      /keep the page open and retry the same change; retrying is safe\.$/u,
    ],
    [
      'a lost connection',
      () => Promise.reject(new TypeError('Failed to fetch')),
      /^Failed to fetch$/u,
    ],
  ])('retries a change after %s with the same requestId', async (_name, failure, text) => {
    installDom();
    const { writes } = installFetch({
      server: noteServer('Checks are delayed'),
      write: (_body, count) => (count === 1 ? failure() : undefined),
    });
    await signIn();
    openMaintenance();
    await vi.waitFor(() => expect(message().value).toBe('Checks are delayed'));

    message().value = 'Rooms are slow to open';
    form().requestSubmit();
    await vi.waitFor(() => expect(errorEl().hidden).toBe(false));
    expect(errorEl().textContent).toMatch(text);
    expect(message().value).toBe('Rooms are slow to open');
    expect(message().disabled).toBe(false);
    expect(status()).toMatch(/^Shown on the status page/u);

    form().requestSubmit();
    await vi.waitFor(() => expect(historyStatus()).toBe('2 records'));
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(errorEl().hidden).toBe(true);

    // A new change after a settled one gets a new key.
    message().value = 'Rooms open normally again';
    form().requestSubmit();
    await vi.waitFor(() => expect(historyStatus()).toBe('3 records'));
    expect(writes[2]?.requestId).not.toBe(writes[0]?.requestId);
  });

  it.each([
    ['STATUS_NOTE_TOO_LONG', 'Keep the note to 280 characters or fewer.'],
    ['STATUS_NOTE_INVALID', 'Use plain text without control or text-direction characters.'],
  ])('shows a refused %s and drops its replay key', async (code, text) => {
    installDom();
    const { writes } = installFetch({
      server: noteServer(),
      write: (_body, count) =>
        count === 1 ? Response.json({ error: code }, { status: 400 }) : undefined,
    });
    await signIn();
    openMaintenance();
    await vi.waitFor(() => expect(status()).toBe('No note'));

    message().value = 'Checks are delayed';
    form().requestSubmit();
    await vi.waitFor(() => expect(errorEl().textContent).toBe(text));
    expect(status()).toBe('No note');

    form().requestSubmit();
    await vi.waitFor(() => expect(historyStatus()).toBe('1 record'));
    expect(writes).toHaveLength(2);
    expect(writes[1]?.requestId).not.toBe(writes[0]?.requestId);
    expect({ ...writes[1], requestId: '' }).toEqual({ ...writes[0], requestId: '' });
  });

  it('shows the current note after a conflict and fences the next change on it', async () => {
    installDom();
    const server = noteServer('Saved note');
    const { writes } = installFetch({ server });
    await signIn();
    openMaintenance();
    await vi.waitFor(() => expect(message().value).toBe('Saved note'));

    storeNote(server, 'Changed in another session', null);
    message().value = 'My change';
    form().requestSubmit();
    await vi.waitFor(() => expect(message().value).toBe('Changed in another session'));
    expect(writes[0]).toMatchObject({ message: 'My change', expectedRevision: 1 });
    expect(errorEl().textContent).toBe(
      'The status page note changed in another session. The latest note has been loaded.',
    );
    expect(status()).toMatch(/^Shown on the status page - updated /u);
    expect(preview().querySelector('p')?.textContent).toBe('Changed in another session');
    expect(historyStatus()).toBe('2 records');

    message().value = 'My change';
    form().requestSubmit();
    await vi.waitFor(() => expect(historyStatus()).toBe('3 records'));
    expect(writes[1]).toMatchObject({ message: 'My change', expectedRevision: 2 });
    expect(writes[1]?.requestId).not.toBe(writes[0]?.requestId);
    expect(errorEl().hidden).toBe(true);
  });

  it('keeps a draft through incidental reloads and asks before Refresh discards it', async () => {
    installDom();
    const server = noteServer('Saved note');
    const { counts, writes } = installFetch({ server });
    await signIn();
    openMaintenance();
    await vi.waitFor(() => expect(message().value).toBe('Saved note'));

    message().value = 'Unsaved draft';
    expires().value = '2099-05-06 07:08';
    storeNote(server, 'Changed in another session', null);
    // The tab again and a Refresh whose discard is declined leave the draft.
    openMaintenance();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    query<HTMLButtonElement>('[data-refresh]').click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      'Discard your unsaved status page note and load the current note?',
    );
    await vi.waitFor(() => expect(updatedAt()).toMatch(/^Updated /u));
    expect(message().value).toBe('Unsaved draft');
    expect(expires().value).toBe('2099-05-06 07:08');
    expect(counts.reads).toBe(1);

    // With consent, Refresh replaces the draft with the current note.
    confirm.mockReturnValue(true);
    query<HTMLButtonElement>('[data-refresh]').click();
    await vi.waitFor(() => expect(message().value).toBe('Changed in another session'));
    expect(expires().value).toBe('');
    expect(counts.reads).toBe(2);
    expect(writes).toEqual([]);
  });

  it('keeps edits typed during a read together with their original fence', async () => {
    installDom();
    const server = noteServer('Saved note');
    const secondRead = deferred<Response>();
    const { counts, writes } = installFetch({
      server,
      read: (count) => (count === 2 ? secondRead.promise : undefined),
    });
    await signIn();
    openMaintenance();
    await vi.waitFor(() => expect(message().value).toBe('Saved note'));
    openMaintenance();
    await vi.waitFor(() => expect(counts.reads).toBe(2));

    message().value = 'Typed during the read';
    storeNote(server, 'Changed in another session', null);
    secondRead.resolve(Response.json(notePayload(server)));
    await vi.waitFor(() => expect(historyStatus()).toBe('2 records'));
    expect(message().value).toBe('Typed during the read');
    expect(preview().querySelector('p')?.textContent).toBe('Changed in another session');

    // The read did not move the draft's fence: publishing it meets the newer note.
    form().requestSubmit();
    await vi.waitFor(() => expect(message().value).toBe('Changed in another session'));
    expect(writes).toEqual([expect.objectContaining({ expectedRevision: 1 })]);
    expect(errorEl().textContent).toMatch(/changed in another session/u);
  });

  it('reports an unavailable note and refuses changes until a read succeeds', async () => {
    installDom();
    const { counts, writes } = installFetch({
      server: noteServer('Checks are delayed'),
      read: (count) =>
        count === 1
          ? Response.json({ error: 'STATUS_NOTE_CONTROL_UNAVAILABLE' }, { status: 503 })
          : undefined,
    });
    await signIn();
    openMaintenance();
    await vi.waitFor(() => expect(errorEl().hidden).toBe(false));
    expect(errorEl().textContent).toMatch(/^The status page note is temporarily unavailable\./u);
    expect(status()).toBe('');

    message().value = 'Checks are delayed';
    form().requestSubmit();
    expect(errorEl().textContent).toBe('Refresh to load the current note before changing it.');
    expect(writes).toEqual([]);

    // The unread draft has no base, so only a consented Refresh replaces it.
    openMaintenance();
    expect(counts.reads).toBe(1);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    query<HTMLButtonElement>('[data-refresh]').click();
    await vi.waitFor(() => expect(status()).toMatch(/^Shown on the status page/u));
    expect(counts.reads).toBe(2);
    expect(errorEl().hidden).toBe(true);
  });

  it('hides the preview when the note expires and keeps the draft', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    installDom();
    installFetch({ server: noteServer('Checks are delayed', new Date(NOW + 1_000).toISOString()) });
    await signIn();
    openMaintenance();
    await vi.waitFor(() => expect(status()).toMatch(/^Shown on the status page - expires /u));
    expect(preview().hidden).toBe(false);

    message().value = 'A follow-up draft';
    await vi.advanceTimersByTimeAsync(1_200);

    expect(status()).toMatch(/^Expired - expired .+ - updated /u);
    expect(preview().hidden).toBe(true);
    expect(message().value).toBe('A follow-up draft');
  });

  it('clears the note at logout and ignores a late read', async () => {
    installDom();
    const server = noteServer('Checks are delayed', FAR_EXPIRY);
    const lateRead = deferred<Response>();
    const { counts } = installFetch({
      server,
      read: (count) => (count === 2 ? lateRead.promise : undefined),
    });
    await signIn();
    openMaintenance();
    await vi.waitFor(() => expect(message().value).toBe('Checks are delayed'));
    message().value = 'Unsaved draft';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    query<HTMLButtonElement>('[data-refresh]').click();
    await vi.waitFor(() => expect(counts.reads).toBe(2));

    query<HTMLButtonElement>('[data-logout]').click();
    await vi.waitFor(() => expect(query<HTMLElement>('[data-dashboard]').hidden).toBe(true));
    expectCleared();

    lateRead.resolve(Response.json(notePayload(server)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expectCleared();
  });

  it('stays idle with an older admin shell that has no note panel', async () => {
    installDom({ notePanel: false });
    const { counts } = installFetch({ server: noteServer('Checks are delayed') });
    await signIn();
    openMaintenance();
    query<HTMLButtonElement>('[data-refresh]').click();
    await vi.waitFor(() => expect(updatedAt()).toMatch(/^Updated /u));
    expect(counts.reads).toBe(0);
  });
});
