/** @vitest-environment jsdom */
/**
 * RO-28 account pulse wire contract (docs/design/resource-ownership-registry.md;
 * structural plan C8, Phase 0c: the cross-document contract test that RO-28
 * lists as missing, and the tests-first tables of C8-I1 and C8-I4).
 *
 * Four copies share the pulse today and two of them cannot import src: the
 * classic runtimes are compiled one file at a time
 * (scripts/classic-runtime-assets.ts).
 * - Producer: browser/classic-runtime/account-complete.ts.
 * - App tab: src/account/session.ts (producer of mutation pulses and receiver)
 *   and src/ui/account.ts (a second receiver in the same document).
 * - Events page: browser/classic-runtime/events/event.ts (third receiver).
 *
 * Boundary: every copy runs for real in its own document on one fake origin.
 * The Vitest document ("app-a") runs session.ts and ui/account.ts with only the
 * toast and activity-stats modules mocked (as in ui/__tests__/account.test.ts);
 * "app-b" runs a bundle of session.ts; the events page and the completion page
 * run their compiled classic runtimes. Observations: the transport log, session
 * reads per document, the account UI's toasts.
 *
 * Comments marked "Known gap" or naming an increment pin today's behaviour and
 * say which planned increment changes the pinned line.
 */
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { clearIntentionalNav } from '../../core/page-lifecycle.ts';
import { resetState } from '../../core/state.ts';
import { __resetAccountUiForTests, initAccount, openAccountDialog } from '../../ui/account.ts';
import { showToast } from '../../ui/toast.ts';
import { __resetAccountSessionForTests, signOutAccount } from '../session.ts';
import { __resetAccountStateForTests, getAccountSnapshot } from '../state.ts';
import {
  AccountPulseHarness,
  mountAccountDialog,
  type FakeLoginPopup,
  type SourceDrift,
} from './__helpers__/account-pulse-documents.ts';
import type { FakeDocumentOptions } from './__helpers__/fake-broadcast-channel.ts';

vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn() }));
vi.mock('../activity-stats.ts', () => ({
  flushAccountActivityStatsForRead: vi.fn().mockResolvedValue({ status: 'idle' }),
}));

const CHANNEL = 'mxqr-account-v1';
const STORAGE_KEY = 'mxqr-account-refresh';
const MINSU = { nickname: 'Minsu', profileComplete: true, statsScope: 'm'.repeat(43) };
const TOASTS = {
  welcome: 'Welcome back\nMinsu',
  cancelled: 'Sign-in was cancelled',
  failed: 'Could not sign in\nPlease try again',
} as const;
type UiReaction = keyof typeof TOASTS | null;

let harness: AccountPulseHarness;

beforeEach(() => {
  __resetAccountSessionForTests();
  __resetAccountUiForTests();
  __resetAccountStateForTests();
  resetState();
  bus.clear();
  vi.mocked(showToast).mockClear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' })),
  );
  document.documentElement.lang = 'en-US';
  sessionStorage.clear();
  clearIntentionalNav();
  window.history.replaceState({}, '', '/');
  harness = new AccountPulseHarness();
});

afterEach(() => {
  __resetAccountSessionForTests();
  __resetAccountUiForTests();
  __resetAccountStateForTests();
  resetState();
  harness.dispose();
  vi.unstubAllGlobals();
});

function reads(
  names: readonly string[],
  since?: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(
    names.map((name) => [name, harness.server.sessionReads(name) - (since?.[name] ?? 0)]),
  );
}

function uiReaction(): UiReaction {
  const calls = vi.mocked(showToast).mock.calls.map(([message]) => message);
  const kinds = (Object.keys(TOASTS) as Array<keyof typeof TOASTS>).filter((kind) =>
    calls.includes(TOASTS[kind]),
  );
  expect(calls).toHaveLength(kinds.length);
  if (kinds.length > 1) throw new Error(`several account toasts: ${calls.join(' | ')}`);
  return kinds[0] ?? null;
}

/**
 * app-a: the Vitest document after initAccount() with the ordinary Account
 * Center login popup open, so its accountClient is known.
 */
async function appTabWithOpenLogin(options: FakeDocumentOptions = {}): Promise<FakeLoginPopup> {
  const appA = harness.attachTestDocument('app-a', options);
  const popups = harness.interceptPopups(window, appA);
  await mountAccountDialog();
  initAccount();
  await harness.origin.settle();
  openAccountDialog();
  document.getElementById('btn-account-google')!.click();
  expect(popups).toHaveLength(1);
  return popups[0]!;
}

/** app-a with an open login, app-b (bundled session.ts) and the events page, all signed out. */
async function signedOutOrigin(options: FakeDocumentOptions = {}) {
  harness.server.account = null;
  const popup = await appTabWithOpenLogin(options);
  const appB = await harness.loadSessionDocument('app-b', options);
  appB.session.startAccountSessionRefresh();
  const events = await harness.loadEventsDocument('events', options);
  await harness.origin.settle();
  expect(reads(['app-a', 'app-b', 'events'])).toEqual({ 'app-a': 1, 'app-b': 1, events: 1 });
  return { popup, appB, events };
}

// ─── C8-I1: one channel name and one storage key in four copies ─────

const RUNTIME_ROOTS = ['src', 'browser', 'cloudflare', 'public'];
const TEXT_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs', '.html', '.json']);

async function runtimeFilesContaining(literal: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const root = process.cwd();
  const files: string[] = [];
  for (const top of RUNTIME_ROOTS) {
    for (const entry of await readdir(join(root, top), { recursive: true, withFileTypes: true })) {
      // Type declarations (the generated Worker types are 0.6 MB each) hold
      // no runtime copy.
      if (entry.name.endsWith('.d.ts')) continue;
      if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) {
        files.push(join(entry.parentPath, entry.name));
      }
    }
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name) === '.html') files.push(join(root, entry.name));
  }
  // The literal as a whole string in any quote style, never as a prefix of another key.
  const quoted = new RegExp(`(['"\`])${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g');
  for (const file of files) {
    const path = relative(root, file).split('\\').join('/');
    if (path.split('/').includes('__tests__')) continue;
    const occurrences = (await readFile(file, 'utf8')).match(quoted)?.length ?? 0;
    if (occurrences > 0) counts[path] = occurrences;
  }
  return counts;
}

// The scan reads about 500 files; a cold first run in a fresh worktree, next to
// suites that spawn esbuild, can outlast the default 15 s.
const LITERAL_SCAN_TIMEOUT_MS = 60_000;

describe('C8-I1 wire literals', () => {
  it(
    'spells the channel name and the storage key once in each of the four runtime copies',
    async () => {
      // C8-I1 (Phase 0d) moves the two src/ copies into
      // src/account/account-sync-protocol.ts; that PR updates both tables: the
      // protocol module appears and session.ts and ui/account.ts leave. The two
      // classic runtimes keep their literals, pinned behaviourally below.
      const copies = {
        'browser/classic-runtime/account-complete.ts': 1,
        'browser/classic-runtime/events/event.ts': 1,
        'src/account/session.ts': 1,
        'src/ui/account.ts': 1,
      };
      expect(await runtimeFilesContaining(CHANNEL)).toEqual(copies);
      expect(await runtimeFilesContaining(STORAGE_KEY)).toEqual(copies);
    },
    LITERAL_SCAN_TIMEOUT_MS,
  );
});

// ─── Wire format of both producers ──────────────────────────────────

/** The keys of a pulse, sorted: toEqual alone ignores keys whose value is undefined. */
function fieldSet(pulse: unknown): string[] {
  return Object.keys(pulse as object).sort();
}

describe('pulse wire format', () => {
  it.each(['success', 'cancelled', 'error'] as const)(
    'the completion page sends one %s message, byte-identical on every transport',
    async (outcome) => {
      const appB = await harness.loadSessionDocument('app-b');
      appB.session.startAccountSessionRefresh();
      await harness.origin.settle();
      await harness.loadCompletionDocument(
        'popup',
        `${harness.origin.origin}/account-complete.html?accountClient=client-under-test-01&accountAuth=${outcome}`,
        appB.doc,
      );

      const [windowMessage, broadcast] = [
        harness.origin.pending({ transport: 'window-message' })[0]!.data,
        harness.origin.pending({ transport: 'broadcast' })[0]!.data,
      ];
      const stored = harness.origin.storage.get(STORAGE_KEY)!;
      // The field set is the contract, not the key order: every receiver
      // parses the JSON and reads fields, none compares raw strings.
      expect(fieldSet(broadcast)).toEqual(['accountAuth', 'accountClient', 'id', 'type']);
      expect(broadcast).toEqual({
        type: 'refresh',
        accountAuth: outcome,
        id: expect.stringMatching(/^result:[0-9a-z]+:[0-9a-z]+$/),
        accountClient: 'client-under-test-01',
      });
      expect(windowMessage).toEqual(broadcast);
      expect(stored).toBe(JSON.stringify(broadcast));
      // Receivers accept ids of 8..160 characters.
      const id = (broadcast as { id: string }).id;
      expect(id.length).toBeGreaterThanOrEqual(8);
      expect(id.length).toBeLessThanOrEqual(160);
    },
  );

  it.each([
    ['signOutAccount', (session: typeof import('../session.ts')) => session.signOutAccount()],
    [
      'saveAccountNickname',
      (session: typeof import('../session.ts')) => session.saveAccountNickname('Minsu2'),
    ],
    ['removeAccount', (session: typeof import('../session.ts')) => session.removeAccount()],
  ] as const)('%s sends the same JSON pulse on BroadcastChannel and storage', async (_, mutate) => {
    harness.server.account = MINSU;
    const appB = await harness.loadSessionDocument('app-b');
    const listener = harness.loadSenderDocument('listener');
    const received: unknown[] = [];
    new listener.BroadcastChannel!(CHANNEL).addEventListener('message', (event) =>
      received.push((event as MessageEvent).data),
    );
    appB.session.startAccountSessionRefresh();
    await harness.origin.settle();

    await mutate(appB.session);
    await harness.origin.deliverAll();

    expect(received).toHaveLength(1);
    expect(fieldSet(received[0])).toEqual(['id', 'type']);
    expect(received[0]).toEqual({
      type: 'refresh',
      id: expect.stringMatching(/^refresh:[0-9a-z]+:[0-9a-z]+$/),
    });
    const id = (received[0] as { id: string }).id;
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(id.length).toBeLessThanOrEqual(160);
    // C8-I1 fixes the stale comment in ui/account.ts (handleAccountResultStorage:
    // "Ordinary account refresh pulses are intentionally not JSON"): they are
    // JSON. Only older clients wrote an opaque token (see the storage table).
    expect(harness.origin.storage.get(STORAGE_KEY)).toBe(JSON.stringify(received[0]));
  });
});

// ─── C8-I4: what each receiver accepts ──────────────────────────────

type Expected = {
  /** Session reads in app-a (session.ts and ui/account.ts). */
  readonly appA: number;
  /** ui/account.ts toast in app-a. */
  readonly ui: UiReaction;
  /** Session reads in app-b (session.ts only). */
  readonly appB: number;
  /** Campaign session reads on the events page. */
  readonly events: number;
};

const ID = 'result:contract-0001';
const success = (own: string, extra: Record<string, unknown> = {}) => ({
  type: 'refresh',
  accountAuth: 'success',
  id: ID,
  accountClient: own,
  ...extra,
});
const NONE: Expected = { appA: 0, ui: null, appB: 0, events: 0 };
const EVERY_SESSION_READS: Omit<Expected, 'ui'> = { appA: 1, appB: 1, events: 1 };

const ANOTHER_TAB = 'another-tab-client-0001';

/**
 * One row per payload a receiver can meet on BroadcastChannel. "own" is
 * app-a's accountClient. The rows pin what each receiver does, not each
 * parser's projection: one copy of a pulse costs one read whatever session.ts
 * projects, so its id bounds need two copies (the two-copy table below) and
 * its loginSuccess flag needs a read in flight (the projection table below;
 * session.test.ts "shares an identified result read when the session listener
 * receives it before the UI" pins the same flag inside one document).
 */
const BROADCAST_ROWS: ReadonlyArray<
  readonly [label: string, payload: (own: string) => unknown, expected: Expected]
> = [
  ['success for this tab', (own) => success(own), { ...EVERY_SESSION_READS, ui: 'welcome' }],
  ['success for another tab', () => success(ANOTHER_TAB), { ...EVERY_SESSION_READS, ui: null }],
  [
    'cancellation for another tab',
    () => success(ANOTHER_TAB, { accountAuth: 'cancelled' }),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  [
    'cancellation for this tab',
    (own) => success(own, { accountAuth: 'cancelled' }),
    { ...EVERY_SESSION_READS, ui: 'cancelled' },
  ],
  [
    'error for this tab',
    (own) => success(own, { accountAuth: 'error' }),
    { ...EVERY_SESSION_READS, ui: 'failed' },
  ],
  [
    'a session mutation pulse',
    () => ({ type: 'refresh', id: 'refresh:contract-0001' }),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  // ui/account.ts rejects an out-of-range id; session.ts and the events page
  // still refresh (session.ts as an unidentified pulse, pinned by the
  // two-copy table below).
  [
    'an id of 7 characters',
    (own) => success(own, { id: 'r'.repeat(7) }),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  [
    'an id of 8 characters',
    (own) => success(own, { id: 'r'.repeat(8) }),
    { ...EVERY_SESSION_READS, ui: 'welcome' },
  ],
  [
    'an id of 160 characters',
    (own) => success(own, { id: 'r'.repeat(160) }),
    { ...EVERY_SESSION_READS, ui: 'welcome' },
  ],
  [
    'an id of 161 characters',
    (own) => success(own, { id: 'r'.repeat(161) }),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  ['a numeric id', (own) => success(own, { id: 12_345_678 }), { ...EVERY_SESSION_READS, ui: null }],
  [
    'an unknown accountAuth',
    (own) => success(own, { accountAuth: 'pending' }),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  [
    'no accountClient',
    (own) => {
      const { accountClient: _dropped, ...rest } = success(own);
      return rest;
    },
    { ...EVERY_SESSION_READS, ui: null },
  ],
  // ui/account.ts accepts accountClient of 8..160 characters only, so a
  // shorter, longer or non-string client is never this tab's. session.ts and
  // the events page do not read the field and still refresh: an I4 parser
  // that rejected these whole messages would stop their reconciliation.
  [
    'an accountClient of 7 characters',
    () => success('c'.repeat(7)),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  [
    'an accountClient of 161 characters',
    () => success('c'.repeat(161)),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  [
    'a numeric accountClient',
    () => success('', { accountClient: 12_345_678 }),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  ['another message type', (own) => success(own, { type: 'refreshed' }), NONE],
  ['a bare string', () => 'refresh', NONE],
  ['an array', () => [{ type: 'refresh', id: ID }], NONE],
  ['null', () => null, NONE],
];

describe('C8-I4 receiver acceptance on BroadcastChannel', () => {
  it.each(BROADCAST_ROWS)('%s', async (_, payload, expected) => {
    const { popup } = await signedOutOrigin();
    harness.server.account = MINSU;
    const sender = harness.loadSenderDocument('sender');
    const before = reads(['app-a', 'app-b', 'events']);

    new sender.BroadcastChannel!(CHANNEL).postMessage(payload(popup.accountClient!));
    await harness.origin.deliverAll();

    const delta = reads(['app-a', 'app-b', 'events'], before);
    expect({
      appA: delta['app-a'],
      ui: uiReaction(),
      appB: delta['app-b'],
      events: delta.events,
    }).toEqual(expected);
  });
});

/**
 * One row per value a receiver can meet in the storage event for the pulse key.
 * C8-I4 step 3 rewrites ui/account.ts's storage handler and C8-I10 deletes it,
 * so its accountClient filter is pinned here as on BroadcastChannel: a result
 * for another tab never reaches this tab's UI (welcome, toast or a pending
 * protected login, see account-pulse-receivers.test.ts).
 */
const STORAGE_ROWS: ReadonlyArray<
  readonly [label: string, write: (storage: Storage, own: string) => void, expected: Expected]
> = [
  [
    'the completion JSON for this tab',
    (storage, own) => storage.setItem(STORAGE_KEY, JSON.stringify(success(own))),
    { ...EVERY_SESSION_READS, ui: 'welcome' },
  ],
  [
    'the completion JSON for another tab',
    (storage) => storage.setItem(STORAGE_KEY, JSON.stringify(success(ANOTHER_TAB))),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  [
    'a cancellation JSON for another tab',
    (storage) =>
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify(success(ANOTHER_TAB, { accountAuth: 'cancelled' })),
      ),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  [
    'a completion JSON with an accountClient of 7 characters',
    (storage) => storage.setItem(STORAGE_KEY, JSON.stringify(success('c'.repeat(7)))),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  [
    'a completion JSON with an accountClient of 161 characters',
    (storage) => storage.setItem(STORAGE_KEY, JSON.stringify(success('c'.repeat(161)))),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  [
    'a completion JSON with a numeric accountClient',
    (storage) =>
      storage.setItem(STORAGE_KEY, JSON.stringify(success('', { accountClient: 12_345_678 }))),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  [
    'a session mutation JSON',
    (storage) =>
      storage.setItem(STORAGE_KEY, JSON.stringify({ type: 'refresh', id: 'refresh:c-0001' })),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  // Older clients stored an opaque token (session.ts refreshAfterStoragePulse).
  [
    'a legacy opaque token',
    (storage) => storage.setItem(STORAGE_KEY, 'legacy-opaque-token-0001'),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  // Divergence: session.ts refreshes on any value it cannot read as a pulse,
  // the events page ignores JSON that is not a pulse. C8-I4 keeps the session
  // parser's tolerance and leaves the events page's inline check (its step 4),
  // so both rows stay.
  [
    'JSON that is not a pulse',
    (storage) => storage.setItem(STORAGE_KEY, '{"type":"other"}'),
    { appA: 1, ui: null, appB: 1, events: 0 },
  ],
  [
    'a JSON number',
    (storage) => storage.setItem(STORAGE_KEY, '42'),
    { appA: 1, ui: null, appB: 1, events: 0 },
  ],
  [
    'removal of the key',
    (storage) => storage.removeItem(STORAGE_KEY),
    { ...EVERY_SESSION_READS, ui: null },
  ],
  ['clear() of the whole area', (storage) => storage.clear(), NONE],
  [
    'another key',
    (storage) => storage.setItem('mxqr-account-other', JSON.stringify({ type: 'refresh' })),
    NONE,
  ],
];

describe('C8-I4 receiver acceptance on the storage event', () => {
  it.each(STORAGE_ROWS)('%s', async (_, write, expected) => {
    harness.origin.seedStorage(STORAGE_KEY, 'left-by-an-earlier-session');
    const { popup } = await signedOutOrigin();
    harness.server.account = MINSU;
    const sender = harness.loadSenderDocument('sender');
    const before = reads(['app-a', 'app-b', 'events']);

    write(sender.localStorage, popup.accountClient!);
    await harness.origin.deliverAll();

    const delta = reads(['app-a', 'app-b', 'events'], before);
    expect({
      appA: delta['app-a'],
      ui: uiReaction(),
      appB: delta['app-b'],
      events: delta.events,
    }).toEqual(expected);
  });
});

/**
 * session.ts's id bounds (8..160). One copy of a success pulse costs one read
 * whether session.ts keeps its id or drops it to null, so these rows send the
 * same pulse on BroadcastChannel and storage: an id in range is one shared
 * login-result read in app-b, an id out of range two unidentified refreshes.
 * The events page keeps no id and reads once per copy whatever the id; that
 * Known gap is pinned in account-pulse-cross-document.test.ts (it changes only
 * if Phase 2 Train D adds a dedupe), so these rows leave the events page out.
 */
const TWO_COPY_ID_ROWS: ReadonlyArray<
  readonly [length: number, expected: Omit<Expected, 'events'>]
> = [
  [7, { appA: 2, ui: null, appB: 2 }],
  [8, { appA: 1, ui: 'welcome', appB: 1 }],
  [160, { appA: 1, ui: 'welcome', appB: 1 }],
  [161, { appA: 2, ui: null, appB: 2 }],
];

describe('C8-I4 session id bounds over two copies', () => {
  it.each(TWO_COPY_ID_ROWS)('an id of %i characters', async (length, expected) => {
    const { popup } = await signedOutOrigin();
    harness.server.account = MINSU;
    const sender = harness.loadSenderDocument('sender');
    const before = reads(['app-a', 'app-b']);
    const pulse = success(popup.accountClient!, { id: 'r'.repeat(length) });

    new sender.BroadcastChannel!(CHANNEL).postMessage(pulse);
    sender.localStorage.setItem(STORAGE_KEY, JSON.stringify(pulse));
    await harness.origin.deliverAll();

    const delta = reads(['app-a', 'app-b'], before);
    expect({ appA: delta['app-a'], ui: uiReaction(), appB: delta['app-b'] }).toEqual(expected);
  });
});

/**
 * session.ts's loginSuccess projection (accountAuth === 'success'), visible
 * only while an external read is in flight: an identified success starts its
 * own login-result read at once (reconcileAccountLoginResult), any other
 * identified pulse fences the running read and queues one follow-up. app-b
 * runs session.ts alone, so no UI receiver shares the read.
 */
const PROJECTION_ROWS: ReadonlyArray<
  readonly [
    label: string,
    fields: Record<string, unknown>,
    reads: { readonly whileHeld: number; readonly total: number },
  ]
> = [
  ['an identified success', { accountAuth: 'success' }, { whileHeld: 2, total: 2 }],
  ['an identified cancellation', { accountAuth: 'cancelled' }, { whileHeld: 1, total: 2 }],
  ['an identified mutation pulse', {}, { whileHeld: 1, total: 2 }],
];

describe('C8-I4 session login-result projection', () => {
  it.each(PROJECTION_ROWS)('%s behind an external read in flight', async (_, fields, expected) => {
    harness.server.account = null;
    const appB = await harness.loadSessionDocument('app-b');
    appB.session.startAccountSessionRefresh();
    await harness.origin.settle();
    const channel = new (harness.loadSenderDocument('sender').BroadcastChannel!)(CHANNEL);
    const before = reads(['app-b']);
    harness.server.hold();

    channel.postMessage({ type: 'refresh', id: 'refresh:in-flight-0001' });
    await harness.origin.deliverAll();
    channel.postMessage({ type: 'refresh', id: 'result:behind-0002', ...fields });
    await harness.origin.deliverAll();
    const whileHeld = reads(['app-b'], before)['app-b'];
    harness.server.release();
    await harness.origin.settle(10);

    expect({ whileHeld, total: reads(['app-b'], before)['app-b'] }).toEqual(expected);
  });
});

describe('C8-I4 receiver acceptance on window messages', () => {
  it.each([
    ['a same-origin document', 'sender', 'own', { ...EVERY_SESSION_READS, ui: 'welcome' }],
    // The account UI filters this transport by accountClient too.
    [
      'a same-origin document, for another tab',
      'sender',
      'another',
      { ...EVERY_SESSION_READS, ui: null },
    ],
    ['another origin', 'foreign', 'own', NONE],
  ] as const)('handles the completion message from %s', async (_, from, client, expected) => {
    const { popup, appB, events } = await signedOutOrigin();
    harness.server.account = MINSU;
    const sender =
      from === 'sender'
        ? harness.loadSenderDocument('sender')
        : harness.loadForeignDocument('foreign');
    const before = reads(['app-a', 'app-b', 'events']);
    const message = success(client === 'own' ? popup.accountClient! : ANOTHER_TAB);

    for (const target of [harness.origin.document('app-a'), appB.doc, events.doc]) {
      sender.windowProxy(target).postMessage(message, '*');
    }
    await harness.origin.deliverAll();

    const delta = reads(['app-a', 'app-b', 'events'], before);
    expect({
      appA: delta['app-a'],
      ui: uiReaction(),
      appB: delta['app-b'],
      events: delta.events,
    }).toEqual(expected);
  });
});

// ─── The cross-document contract ────────────────────────────────────

type Transport = 'broadcast' | 'storage';

interface Drifts {
  readonly appB?: SourceDrift;
  readonly completion?: SourceDrift;
  readonly events?: SourceDrift;
}

/**
 * Run three real flows with only one transport available on the whole origin
 * and report what every copy did:
 * 1. app-a's login popup completes (the completion page produces);
 * 2. app-b signs out (bundled session.ts produces);
 * 3. app-a signs out (session.ts in the Vitest document produces).
 *
 * Mixed versions (Phase 2): tabs opened before a deploy keep the old
 * session.ts beside new tabs and the events page, on the same channel and key.
 * `appBSources` runs app-b from other sources for that. Label: an increment
 * that changes session.ts (C8-I1, C8-I4, C8-I10) commits the pre-change file
 * and points frozenAppTabSources() at it, so the frozen-sources rows below run
 * an old app-b beside the new app-a.
 */
async function contractMatrix(
  transport: Transport,
  drifts: Drifts = {},
  appBSources?: Readonly<Record<string, string>>,
) {
  const only: FakeDocumentOptions =
    transport === 'broadcast' ? { storage: 'blocked' } : { broadcastChannel: false };
  harness.server.account = null;
  const popup = await appTabWithOpenLogin(only);
  const appB = await harness.loadSessionDocument('app-b', {
    ...only,
    drift: drifts.appB,
    sources: appBSources,
  });
  appB.session.startAccountSessionRefresh();
  await harness.loadEventsDocument('events', { ...only, drift: drifts.events });
  await harness.origin.settle();
  const names = ['app-a', 'app-b', 'events'] as const;

  harness.server.account = MINSU;
  let before = reads(names);
  await popup.complete('success', { ...only, drift: drifts.completion });
  await harness.origin.deliverAll();
  const completion = reads(names, before);
  const completionUi = uiReaction();
  const appAAfterLogin = getAccountSnapshot().status;

  before = reads(names);
  await appB.session.signOutAccount();
  await harness.origin.deliverAll();
  const appBSignOut = reads(names, before);
  const appAAfterAppBSignOut = getAccountSnapshot().status;

  harness.server.account = MINSU;
  before = reads(names);
  await signOutAccount();
  await harness.origin.deliverAll();
  const appASignOut = reads(names, before);

  return {
    'completion -> app-a ui': completionUi,
    'completion -> app-a reads': completion['app-a'],
    'completion -> app-a status': appAAfterLogin,
    'completion -> app-b reads': completion['app-b'],
    'completion -> events reads': completion.events,
    'app-b sign-out -> app-a reads': appBSignOut['app-a'],
    'app-b sign-out -> app-a status': appAAfterAppBSignOut,
    'app-b sign-out -> app-b reads': appBSignOut['app-b'],
    'app-b sign-out -> events reads': appBSignOut.events,
    'app-a sign-out -> app-a reads': appASignOut['app-a'],
    'app-a sign-out -> app-b reads': appASignOut['app-b'],
    'app-a sign-out -> events reads': appASignOut.events,
  };
}

type Matrix = Awaited<ReturnType<typeof contractMatrix>>;

/** Every copy reacts once to every producer, on either transport alone. */
const CONTRACT: Matrix = {
  'completion -> app-a ui': 'welcome',
  'completion -> app-a reads': 1,
  'completion -> app-a status': 'authenticated',
  'completion -> app-b reads': 1,
  'completion -> events reads': 1,
  'app-b sign-out -> app-a reads': 1,
  'app-b sign-out -> app-a status': 'anonymous',
  'app-b sign-out -> app-b reads': 0,
  'app-b sign-out -> events reads': 1,
  'app-a sign-out -> app-a reads': 0,
  'app-a sign-out -> app-b reads': 1,
  'app-a sign-out -> events reads': 1,
};

function changedCells(actual: Matrix): string[] {
  return (Object.keys(CONTRACT) as Array<keyof Matrix>).filter(
    (cell) => actual[cell] !== CONTRACT[cell],
  );
}

const FROZEN_MARKER = '__mxqrPulseFrozenAppTab';

/**
 * The sources of an old app tab. Until the first increment that changes
 * session.ts, the old copy is today's file; that increment replaces the read
 * below with its committed pre-change copy. The marker proves app-b runs these
 * sources rather than the live module graph.
 */
async function frozenAppTabSources(): Promise<Record<string, string>> {
  const path = 'src/account/session.ts';
  const source = await readFile(join(process.cwd(), path), 'utf8');
  return {
    [path]: `${source}\n(globalThis as Record<string, unknown>).${FROZEN_MARKER} = true;\n`,
  };
}

describe('cross-document pulse contract', () => {
  it.each(['broadcast', 'storage'] as const)(
    'every copy answers every producer over %s alone',
    async (transport) => {
      expect(await contractMatrix(transport)).toEqual(CONTRACT);
    },
  );

  it.each(['broadcast', 'storage'] as const)(
    'app-b on frozen session.ts sources (the old tab of a mixed rollout) still meets the contract over %s alone',
    async (transport) => {
      const matrix = await contractMatrix(transport, {}, await frozenAppTabSources());

      const appB = harness.origin.document('app-b').window as unknown as Record<string, unknown>;
      expect(appB[FROZEN_MARKER]).toBe(true);
      expect(matrix).toEqual(CONTRACT);
    },
  );

  // Mutation checks: they prove the contract above is coupled to each copy's
  // literals (structural plan §4: coupling, not safety). Each row drifts one
  // literal in one copy and names exactly the cells that must break.
  it.each([
    [
      'the events page channel name',
      'broadcast',
      { events: { find: CHANNEL, replace: 'mxqr-account-v0' } },
      [
        'completion -> events reads',
        'app-b sign-out -> events reads',
        'app-a sign-out -> events reads',
      ],
    ],
    [
      'the events page storage key',
      'storage',
      { events: { find: STORAGE_KEY, replace: 'mxqr-account-refresh-v0' } },
      [
        'completion -> events reads',
        'app-b sign-out -> events reads',
        'app-a sign-out -> events reads',
      ],
    ],
    [
      'the events page message type',
      'broadcast',
      { events: { find: '"refresh"', replace: '"refreshed"' } },
      [
        'completion -> events reads',
        'app-b sign-out -> events reads',
        'app-a sign-out -> events reads',
      ],
    ],
    [
      'the completion page channel name',
      'broadcast',
      { completion: { find: CHANNEL, replace: 'mxqr-account-v0' } },
      [
        'completion -> app-a ui',
        'completion -> app-a reads',
        'completion -> app-a status',
        'completion -> app-b reads',
        'completion -> events reads',
      ],
    ],
    [
      'the completion page storage key',
      'storage',
      { completion: { find: STORAGE_KEY, replace: 'mxqr-account-refresh-v0' } },
      [
        'completion -> app-a ui',
        'completion -> app-a reads',
        'completion -> app-a status',
        'completion -> app-b reads',
        'completion -> events reads',
      ],
    ],
    [
      'the completion page outcome field',
      'broadcast',
      { completion: { find: 'accountAuth', replace: 'accountResult' } },
      ['completion -> app-a ui'],
    ],
    [
      'the app session channel name (app-b)',
      'broadcast',
      { appB: { find: CHANNEL, replace: 'mxqr-account-v0' } },
      [
        'completion -> app-b reads',
        'app-b sign-out -> app-a reads',
        'app-b sign-out -> app-a status',
        'app-b sign-out -> events reads',
        'app-a sign-out -> app-b reads',
      ],
    ],
    [
      'the app session storage key (app-b)',
      'storage',
      { appB: { find: STORAGE_KEY, replace: 'mxqr-account-refresh-v0' } },
      [
        'completion -> app-b reads',
        'app-b sign-out -> app-a reads',
        'app-b sign-out -> app-a status',
        'app-b sign-out -> events reads',
        'app-a sign-out -> app-b reads',
      ],
    ],
  ] as const)('notices drift in %s', async (_, transport, drifts, broken) => {
    expect(changedCells(await contractMatrix(transport, drifts))).toEqual(broken);
  });
});
