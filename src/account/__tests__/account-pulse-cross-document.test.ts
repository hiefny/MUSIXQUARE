/** @vitest-environment jsdom */
/**
 * RO-28 "Account session reads and refresh pulses" across documents
 * (docs/design/resource-ownership-registry.md; structural plan C8, Phase 0c,
 * ahead of Phase 2 Trains A and D).
 *
 * Every copy of the pulse runs for real in its own document on one fake
 * origin: app tabs run the real src/account/session.ts (bundled into JSDOM
 * windows), the OAuth completion page and the events page run their compiled
 * classic runtimes. Observations are the transport log of the fake, the
 * session reads each document makes, account snapshots and the events page
 * DOM. No copy is mocked.
 *
 * Comments marked "Known gap" pin today's behaviour, not the desired one, and
 * say which increment (if any) is planned to change it. The single-document
 * receivers (session.ts plus ui/account.ts in one tab) are pinned in
 * src/ui/__tests__/account-pulse-receivers.test.ts, and the wire format in
 * account-pulse-contract.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountPulseHarness,
  type EventsDocument,
  type SessionDocument,
} from './__helpers__/account-pulse-documents.ts';

const CHANNEL = 'mxqr-account-v1';
const STORAGE_KEY = 'mxqr-account-refresh';
const MINSU = { nickname: 'Minsu', profileComplete: true, statsScope: 'm'.repeat(43) };

let harness: AccountPulseHarness;

beforeEach(() => {
  harness = new AccountPulseHarness();
});

afterEach(() => {
  harness.dispose();
});

/** Session reads per document since `since` (a previous result of this function). */
function reads(
  names: readonly string[],
  since?: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(
    names.map((name) => [name, harness.server.sessionReads(name) - (since?.[name] ?? 0)]),
  );
}

async function startedTab(
  name: string,
  options?: Parameters<AccountPulseHarness['loadSessionDocument']>[1],
): Promise<SessionDocument> {
  const tab = await harness.loadSessionDocument(name, options);
  tab.session.startAccountSessionRefresh();
  await harness.origin.settle();
  return tab;
}

/** Two signed-in app tabs, then the events page. */
async function signedInOrigin(): Promise<{
  b: SessionDocument;
  c: SessionDocument;
  events: EventsDocument;
}> {
  harness.server.account = MINSU;
  const b = await startedTab('app-b');
  const c = await startedTab('app-c');
  const events = await harness.loadEventsDocument();
  expect(c.state.getAccountSnapshot().status).toBe('authenticated');
  expect(events.view()).toBe('redeem');
  return { b, c, events };
}

function postsFrom(doc: string) {
  return harness.origin.log.filter((entry) => entry.op === 'post' && entry.doc === doc);
}

function storageWritesFrom(doc: string) {
  return harness.origin.log.filter((entry) => entry.op === 'storage-write' && entry.doc === doc);
}

describe('a sign-out in one app tab', () => {
  it('wakes the other app tab once and the events page once per copy, never the writer', async () => {
    const { b, c, events } = await signedInOrigin();
    const before = reads(['app-b', 'app-c', 'events']);

    await b.session.signOutAccount();

    expect(postsFrom('app-b')).toEqual([
      { op: 'post', doc: 'app-b', channel: 'app-b#1', name: CHANNEL, to: ['app-c#1', 'events#1'] },
    ]);
    expect(storageWritesFrom('app-b')).toEqual([
      {
        op: 'storage-write',
        doc: 'app-b',
        key: STORAGE_KEY,
        changed: true,
        to: ['app-c', 'events'],
      },
    ]);
    await harness.origin.deliverAll();

    // app-c sees the same nonce on both transports and reads once.
    // Known gap: the events page has no nonce dedupe, so each copy costs a
    // read. Phase 2 Train D brings this copy into C8-I10's scope, but the C8
    // design keeps event.ts's own check (I4 step 4) and plans no dedupe here;
    // this line changes only if Train D adds one.
    expect(reads(['app-b', 'app-c', 'events'], before)).toEqual({
      'app-b': 0,
      'app-c': 1,
      events: 2,
    });
    expect(c.state.getAccountSnapshot().status).toBe('anonymous');
    expect(events.view()).toBe('login');
  });

  it('reaches a tab without BroadcastChannel through the storage event alone', async () => {
    harness.server.account = MINSU;
    const b = await startedTab('app-b');
    const legacy = await startedTab('app-legacy', { broadcastChannel: false });
    const before = reads(['app-legacy']);

    await b.session.signOutAccount();
    await harness.origin.deliverAll();

    expect(harness.origin.openChannels().map((open) => open.doc)).toEqual(['app-b']);
    expect(harness.origin.deliveries({ to: 'app-legacy' }).map((entry) => entry.transport)).toEqual(
      ['storage'],
    );
    expect(reads(['app-legacy'], before)).toEqual({ 'app-legacy': 1 });
    expect(legacy.state.getAccountSnapshot().status).toBe('anonymous');
  });

  it('still reaches other tabs by BroadcastChannel when the writer cannot store the pulse', async () => {
    harness.server.account = MINSU;
    const b = await startedTab('app-b', { storage: 'quota-exceeded' });
    const c = await startedTab('app-c');
    const events = await harness.loadEventsDocument();
    const before = reads(['app-c', 'events']);

    await b.session.signOutAccount();
    await harness.origin.deliverAll();

    expect(storageWritesFrom('app-b')).toEqual([]);
    // One copy each: the events page reads once here.
    expect(reads(['app-c', 'events'], before)).toEqual({ 'app-c': 1, events: 1 });
    expect(c.state.getAccountSnapshot().status).toBe('anonymous');
    expect(events.view()).toBe('login');
  });

  it.each(['storage', 'broadcast'] as const)(
    'reaches a backgrounded tab on resume with %s first and still reads once',
    async (first) => {
      const { b, c } = await signedInOrigin();
      const before = reads(['app-c']);
      c.doc.hold();

      await b.session.signOutAccount();
      await harness.origin.deliverAll();
      expect(harness.origin.pending({ to: 'app-c' }).map((task) => task.transport)).toEqual([
        'broadcast',
        'storage',
      ]);
      c.doc.release();
      harness.origin.deliverNext({ to: 'app-c', transport: first });
      await harness.origin.deliverAll();

      expect(reads(['app-c'], before)).toEqual({ 'app-c': 1 });
      expect(c.state.getAccountSnapshot().status).toBe('anonymous');
    },
  );
});

describe('an OAuth completion page', () => {
  it('announces one nonce on BroadcastChannel and storage and closes its channel at once', async () => {
    harness.server.account = null;
    const b = await startedTab('app-b');
    const events = await harness.loadEventsDocument();
    events.clickAccountAction();
    const popup = events.popups[0]!;
    // The events page severs the opener before the provider loads (event.ts openGoogleLogin).
    expect(popup.openerSevered).toBe(true);
    const before = reads(['app-b', 'events']);
    harness.server.account = MINSU;

    await popup.complete('success');

    const popupLog = harness.origin.log.filter(
      (entry) =>
        ('doc' in entry && entry.doc === popup.name) ||
        ('from' in entry && entry.from === popup.name),
    );
    expect(popupLog.map((entry) => entry.op)).toEqual(['open', 'post', 'close', 'storage-write']);
    const broadcast = harness.origin.pending({ transport: 'broadcast', from: popup.name });
    expect(broadcast.map((task) => task.target)).toEqual(['app-b#1', 'events#1']);
    const stored = harness.origin.storage.get(STORAGE_KEY)!;
    expect(JSON.parse(stored)).toEqual(broadcast[0]!.data);
    expect(Object.keys(broadcast[0]!.data as object)).toEqual([
      'type',
      'accountAuth',
      'id',
      'accountClient',
    ]);
    expect(broadcast[0]!.data).toEqual({
      type: 'refresh',
      accountAuth: 'success',
      id: expect.stringMatching(/^result:[0-9a-z]+:[0-9a-z]+$/),
      accountClient: popup.accountClient,
    });

    await harness.origin.deliverAll();

    // Known gap (events page, no nonce dedupe): two reads for one completion.
    expect(reads(['app-b', 'events'], before)).toEqual({ 'app-b': 1, events: 2 });
    expect(b.state.getAccountSnapshot().account?.nickname).toBe('Minsu');
    expect(events.view()).toBe('redeem');
    // A successful completion closes itself after 250 ms (account-complete.ts).
    await expect.poll(() => popup.closed).toBe(true);
  });

  it('collapses the opener, BroadcastChannel and storage copies into one read when the opener survives', async () => {
    // Both the app (ui/account.ts) and the events page sever the opener of
    // their own popup, so the window-message copy is dead for them. session.ts
    // and ui/account.ts still listen for it; C8-I10 keeps window message
    // events as a transport of the single receiver.
    harness.server.account = MINSU;
    const b = await startedTab('app-b');
    const before = reads(['app-b']);

    await harness.loadCompletionDocument(
      'opener-popup',
      `${harness.origin.origin}/account-complete.html?accountClient=foreign-client-0001&accountAuth=success`,
      b.doc,
    );

    expect(harness.origin.log).toContainEqual({
      op: 'window-post',
      from: 'opener-popup',
      to: 'app-b',
      targetOrigin: harness.origin.origin,
      accepted: true,
    });
    expect(harness.origin.pending({ to: 'app-b' }).map((task) => task.transport)).toEqual([
      'window-message',
      'broadcast',
      'storage',
    ]);
    await harness.origin.deliverAll();

    expect(reads(['app-b'], before)).toEqual({ 'app-b': 1 });
  });

  it.each([
    ['cancelled', '로그인이 취소됐어요.'],
    ['error', '로그인하지 못했어요. 다시 시도해 주세요.'],
  ] as const)(
    'shows the %s message only until its own refresh lands on the events page',
    async (outcome, message) => {
      harness.server.account = null;
      const b = await startedTab('app-b');
      const events = await harness.loadEventsDocument();
      events.clickAccountAction();
      const popup = events.popups[0]!;
      const before = reads(['app-b', 'events']);
      harness.server.hold();

      await popup.complete(outcome);
      harness.origin.deliverNext({ to: 'events', transport: 'broadcast' });
      expect(events.loginMessage()).toBe(message);

      harness.server.release();
      await harness.origin.deliverAll();

      // Known gap (events page): the refresh this message triggers re-renders
      // the signed-out view, and renderLogin() clears #login-message, so the
      // text is visible only while the session read is in flight. No planned
      // increment changes it (Train D's C8-I10 scope is the pulse transport).
      expect(events.loginMessage()).toBe('');
      expect(events.view()).toBe('login');
      // A non-success completion stays open for the user to read.
      expect(popup.closed).toBe(false);
      // Other tabs only reconcile; app-b reads once (same nonce on both copies).
      expect(reads(['app-b', 'events'], before)).toEqual({ 'app-b': 1, events: 2 });
      expect(b.state.getAccountSnapshot().status).toBe('anonymous');
    },
  );

  it('leaves a foreign tab’s cancelled result silent on the events page but still refreshes it', async () => {
    harness.server.account = null;
    await startedTab('app-b');
    const events = await harness.loadEventsDocument();
    const before = reads(['events']);

    await harness.loadCompletionDocument(
      'foreign-popup',
      `${harness.origin.origin}/account-complete.html?accountClient=foreign-client-0001&accountAuth=cancelled`,
      null,
    );
    harness.origin.deliverNext({ to: 'events', transport: 'broadcast' });
    expect(events.loginMessage()).toBe('');
    await harness.origin.deliverAll();

    expect(reads(['events'], before)).toEqual({ events: 2 });
  });

  it('still wakes every receiver when the completion carries no accountClient', async () => {
    harness.server.account = MINSU;
    const b = await startedTab('app-b');
    const events = await harness.loadEventsDocument();
    const before = reads(['app-b', 'events']);

    await harness.loadCompletionDocument(
      'bare-popup',
      `${harness.origin.origin}/account-complete.html?accountAuth=success`,
      null,
    );
    const [task] = harness.origin.pending({ to: 'app-b', transport: 'broadcast' });
    expect(task!.data).toMatchObject({ accountAuth: 'success', accountClient: null });
    await harness.origin.deliverAll();

    // session.ts treats it as an identified login result (accountClient is not
    // part of its contract); the events page refreshes on any pulse.
    expect(reads(['app-b', 'events'], before)).toEqual({ 'app-b': 1, events: 2 });
    expect(b.state.getAccountSnapshot().status).toBe('authenticated');
    expect(events.view()).toBe('redeem');
  });
});

describe('the events page as the third pulse copy', () => {
  it('stops receiving broadcasts after pagehide, also after a bfcache restore, but keeps the storage fallback', async () => {
    const { b, events } = await signedInOrigin();
    const before = reads(['events']);

    events.pagehide(true);
    events.pageshow(true);
    await b.session.signOutAccount();
    await harness.origin.deliverAll();

    expect(harness.origin.log).toContainEqual({
      op: 'close',
      doc: 'events',
      channel: 'events#1',
      name: CHANNEL,
    });
    expect(postsFrom('app-b')).toEqual([expect.objectContaining({ to: ['app-c#1'] })]);
    // Known gap (events page): pagehide closes the channel and nothing reopens
    // it when the page is restored from the back/forward cache, so only the
    // storage copy arrives afterwards (one read instead of two). No increment
    // reopens it today; the bfcache order belongs to the C6-2 harness.
    expect(harness.origin.deliveries({ to: 'events' }).map((entry) => entry.transport)).toEqual([
      'storage',
    ]);
    expect(reads(['events'], before)).toEqual({ events: 1 });
    expect(events.view()).toBe('login');
  });

  it('sends no pulse after its own nickname save, so app tabs keep the stale profile', async () => {
    harness.server.account = { nickname: '', profileComplete: false, statsScope: 'p'.repeat(43) };
    const b = await startedTab('app-b');
    const events = await harness.loadEventsDocument();
    const document = events.window.document;
    const dialog = document.getElementById('nickname-dialog') as HTMLDialogElement;
    await expect.poll(() => dialog.open).toBe(true);
    const before = reads(['app-b']);
    const logLength = harness.origin.log.length;

    (document.getElementById('nickname-input') as HTMLInputElement).value = 'Minsu';
    (document.getElementById('nickname-form') as HTMLFormElement).requestSubmit();
    await expect.poll(() => events.view()).toBe('redeem');
    await harness.origin.deliverAll();

    expect(harness.server.requests).toContainEqual({
      doc: 'events',
      method: 'PATCH',
      path: '/api/auth/profile',
    });
    // Known gap (events page): the profile change produces no BroadcastChannel
    // or storage pulse, so app tabs only see it on their own next session
    // read (focus after the 30 s debounce, or a later pulse). No increment
    // covers it.
    expect(harness.origin.log.slice(logLength).filter((entry) => entry.op !== 'deliver')).toEqual(
      [],
    );
    expect(reads(['app-b'], before)).toEqual({ 'app-b': 0 });
    expect(b.state.getAccountSnapshot().account).toEqual({ nickname: '', profileComplete: false });
  });
});
