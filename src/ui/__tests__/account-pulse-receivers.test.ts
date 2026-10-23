/** @vitest-environment jsdom */
/**
 * RO-28: the two pulse receivers inside one app tab (src/account/session.ts and
 * src/ui/account.ts), characterized before C8-I10 makes session.ts the single
 * receiver (structural plan C8, Phase 2 Train D; I10 "testsFirst" (a)-(e) and
 * the critique's popup-only and backgrounded-opener cases).
 *
 * Boundary: the Vitest document is app tab "app-a" on the fake origin of
 * src/account/__tests__/__helpers__/fake-broadcast-channel.ts, running the real
 * session.ts and ui/account.ts with only the toast and activity-stats modules
 * mocked (as in account.test.ts). The OAuth completion page is the compiled
 * classic runtime in its own document, opened through the popup handle that
 * ui/account.ts receives from window.open. Observations: session reads, the
 * transport log, toasts, and the outcome of the protected login attempt.
 *
 * C8-I10 is labelled behaviour "none", so every read count, toast and outcome
 * here must survive it. Lines that I10 does change (the second channel in this
 * document) say so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountPulseHarness,
  mountAccountDialog,
  type FakeLoginPopup,
} from '../../account/__tests__/__helpers__/account-pulse-documents.ts';
import type { FakeDocument } from '../../account/__tests__/__helpers__/fake-broadcast-channel.ts';
import {
  __resetAccountSessionForTests,
  requestAccountLoginPopup,
  signOutAccount,
  type AccountLoginPopupOutcome,
} from '../../account/session.ts';
import { __resetAccountStateForTests, getAccountSnapshot } from '../../account/state.ts';
import { bus } from '../../core/events.ts';
import { clearIntentionalNav } from '../../core/page-lifecycle.ts';
import { resetState } from '../../core/state.ts';
import { __resetAccountUiForTests, initAccount, openAccountDialog } from '../account.ts';
import { showToast } from '../toast.ts';

vi.mock('../toast.ts', () => ({ showToast: vi.fn() }));
vi.mock('../../account/activity-stats.ts', () => ({
  flushAccountActivityStatsForRead: vi.fn().mockResolvedValue({ status: 'idle' }),
}));

const CHANNEL = 'mxqr-account-v1';
const MINSU = { nickname: 'Minsu', profileComplete: true, statsScope: 'm'.repeat(43) };
const WELCOME = 'Welcome back\nMinsu';

let harness: AccountPulseHarness;
let appA: FakeDocument;
let popups: FakeLoginPopup[];

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
  appA = harness.attachTestDocument('app-a');
  popups = harness.interceptPopups(window, appA);
});

afterEach(() => {
  __resetAccountSessionForTests();
  __resetAccountUiForTests();
  __resetAccountStateForTests();
  resetState();
  harness.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function appReads(): number {
  return harness.server.sessionReads('app-a');
}

function toasts(): unknown[] {
  return vi.mocked(showToast).mock.calls.map(([message]) => message);
}

/** initAccount() signed out: the startup read has landed. */
async function initSignedOut(): Promise<void> {
  harness.server.account = null;
  await mountAccountDialog();
  initAccount();
  await harness.origin.settle();
  expect(getAccountSnapshot().status).toBe('anonymous');
  expect(appReads()).toBe(1);
}

/** The Account Center's Google button: an ordinary popup login. */
function openAccountCenterLogin(): FakeLoginPopup {
  openAccountDialog();
  document.getElementById('btn-account-google')!.click();
  return popups.at(-1)!;
}

/** A protected attempt (PRO claims and similar flows) through the session bridge. */
function openProtectedLogin(): {
  popup: FakeLoginPopup;
  outcome: Promise<AccountLoginPopupOutcome>;
} {
  const outcome = requestAccountLoginPopup();
  return { popup: popups.at(-1)!, outcome };
}

describe('receivers in one app tab today', () => {
  it('(a) a protected login delivered only by BroadcastChannel costs one read and resolves authenticated', async () => {
    await initSignedOut();
    const { popup, outcome } = openProtectedLogin();
    expect(popup.openerSevered).toBe(true);
    harness.server.account = MINSU;

    await popup.complete('success', { storage: 'blocked' });
    expect(harness.origin.pending({ to: 'app-a' }).map((task) => task.target)).toEqual([
      'app-a#1',
      'app-a#2',
    ]);
    await harness.origin.deliverAll();

    await expect(outcome).resolves.toBe('authenticated');
    expect(appReads()).toBe(2);
    expect(toasts()).toEqual([WELCOME]);
    // Two channel objects in this document get the pulse, the account UI's
    // first (created by initAccount before startAccountSessionRefresh).
    // C8-I10 deletes the UI's channel: one delivery, with the UI subscribers
    // still served before session.ts reconciles.
    expect(harness.origin.openChannels(CHANNEL)).toEqual([
      { id: 'app-a#1', doc: 'app-a', name: CHANNEL },
      { id: 'app-a#2', doc: 'app-a', name: CHANNEL },
    ]);
    expect(harness.origin.deliveries({ to: 'app-a' }).map((entry) => entry.target)).toEqual([
      'app-a#1',
      'app-a#2',
    ]);
  });

  it('(b) the same result on window message, BroadcastChannel and storage still costs one read and one welcome', async () => {
    await initSignedOut();
    const popup = openAccountCenterLogin();
    harness.server.account = MINSU;

    // ui/account.ts severs the opener, so its own popup never posts a window
    // message. Load the completion with the opener intact to reach the
    // listeners both receivers still keep for that transport.
    await harness.loadCompletionDocument('opener-popup', popup.completionUrl('success'), appA);
    // C8-I10 deletes the account UI's second same-name channel: one
    // 'broadcast' delivery instead of two.
    expect(harness.origin.pending({ to: 'app-a' }).map((task) => task.transport)).toEqual([
      'window-message',
      'broadcast',
      'broadcast',
      'storage',
    ]);
    await harness.origin.deliverAll();

    expect(appReads()).toBe(2);
    expect(toasts()).toEqual([WELCOME]);
    expect(getAccountSnapshot().account?.nickname).toBe('Minsu');
  });

  it('(c) a cancelled protected login settles once, costs one read and leaves no monitor behind', async () => {
    vi.useFakeTimers();
    await initSignedOut();
    const { popup, outcome } = openProtectedLogin();

    await popup.complete('cancelled');
    await harness.origin.deliverAll();

    await expect(outcome).resolves.toBe('cancelled');
    // The UI settles the attempt; session.ts treats the identified pulse as a
    // generic refresh (one read; the storage copy is deduplicated by nonce).
    expect(appReads()).toBe(2);
    expect(toasts()).toEqual([]);
    // The completion page stays open for a non-success result. Closing it
    // later costs nothing: the UI stopped its 250 ms close monitor.
    expect(popup.closed).toBe(false);
    popup.closeWindow();
    await vi.advanceTimersByTimeAsync(1_000);
    await harness.origin.settle();
    expect(appReads()).toBe(2);
  });

  it('(d) this tab’s own sign-out pulse reaches its UI channel but no UI handling and no read', async () => {
    harness.server.account = MINSU;
    await mountAccountDialog();
    initAccount();
    await harness.origin.settle();
    expect(getAccountSnapshot().status).toBe('authenticated');
    const appB = await harness.loadSessionDocument('app-b');
    appB.session.startAccountSessionRefresh();
    await harness.origin.settle();

    await signOutAccount();
    expect(harness.origin.log).toContainEqual({
      op: 'post',
      doc: 'app-a',
      channel: 'app-a#2',
      name: CHANNEL,
      to: ['app-a#1', 'app-b#1'],
    });
    await harness.origin.deliverAll();

    // C8-I10 removes the app-a#1 delivery (one channel per tab, and
    // BroadcastChannel never delivers to the sender). Today the UI parser
    // drops it: a mutation pulse has no accountAuth or accountClient.
    expect(harness.origin.deliveries({ to: 'app-a' }).map((entry) => entry.target)).toEqual([
      'app-a#1',
    ]);
    expect(toasts()).toEqual([]);
    expect(appReads()).toBe(1);
    expect(harness.server.sessionReads('app-b')).toBe(2);
    expect(appB.state.getAccountSnapshot().status).toBe('anonymous');
  });

  it('(e) a same-tab OAuth return reads once, welcomes once and tells no other tab', async () => {
    harness.server.account = null;
    const appB = await harness.loadSessionDocument('app-b');
    appB.session.startAccountSessionRefresh();
    await harness.origin.settle();
    // The OAuth round trip replaced this document and set the cookie.
    harness.server.account = MINSU;
    window.history.replaceState({}, '', '/?accountAuth=success');
    sessionStorage.setItem(
      'mxqr-account-welcome-intent-v1',
      JSON.stringify({ createdAt: Date.now() }),
    );

    await mountAccountDialog();
    initAccount();
    await harness.origin.deliverAll();

    expect(window.location.search).toBe('');
    expect(appReads()).toBe(1);
    expect(toasts()).toEqual([WELCOME]);
    // Known gap: the same-tab return (taken when the popup cannot open, which
    // installed PWAs rely on) posts no pulse, so other tabs learn about the
    // login only from their own next read (focus after the 30 s debounce).
    // No planned increment changes it.
    expect(
      harness.origin.log.filter((entry) => entry.op === 'post' || entry.op === 'storage-write'),
    ).toEqual([]);
    expect(appB.state.getAccountSnapshot().status).toBe('anonymous');
  });

  it('binds the session receiver lazily in a popup-only context and adds no lifecycle reads', async () => {
    // Critique of C8-I10: a subscribe that binds the session lifecycle from
    // requestAccountLoginPopupOnly must not add reads to contexts that only
    // use the popup. Today the UI receiver alone is bound until the first
    // login result reconciles the session, so while the popup is open the
    // foreground, online and pageshow events (past the 30 s debounce) read
    // nothing. This must survive C8-I10.
    vi.useFakeTimers({ toFake: ['Date'] });
    const { popup, outcome } = openProtectedLogin();
    harness.server.account = MINSU;
    vi.setSystemTime(Date.now() + 30_001);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
    await harness.origin.settle();
    expect(appReads()).toBe(0);
    // C8-I10: app-a#1 becomes session.ts's pulse channel, and the second list
    // below flips to ['app-a#1'] (the login result opens no second channel).
    expect(harness.origin.openChannels(CHANNEL).map((open) => open.id)).toEqual(['app-a#1']);

    await popup.complete('success');
    harness.origin.deliverNext({ to: 'app-a', transport: 'broadcast' });
    expect(harness.origin.openChannels(CHANNEL).map((open) => open.id)).toEqual([
      'app-a#1',
      'app-a#2',
    ]);
    await harness.origin.deliverAll();

    await expect(outcome).resolves.toBe('authenticated');
    expect(appReads()).toBe(1);
    window.dispatchEvent(new Event('focus'));
    await harness.origin.settle();
    expect(appReads()).toBe(1);
    vi.setSystemTime(Date.now() + 30_001);
    window.dispatchEvent(new Event('focus'));
    await harness.origin.settle();
    expect(appReads()).toBe(2);
  });
});

/**
 * Critique of C8-I10: on Android Chrome the opener tab is in the background
 * while the user signs in, so its BroadcastChannel and storage deliveries, the
 * 250 ms close monitor and the focus/visibility events all run together on
 * resume, in an engine-dependent order. Every order must end with one welcome
 * and no cancellation. The read counts differ by order and are pinned.
 */
type ResumeStep = 'broadcast' | 'storage' | 'monitor' | 'focus';

const RESUME_ORDERS: ReadonlyArray<readonly [order: readonly ResumeStep[], reads: number]> = [
  [['broadcast', 'storage', 'monitor', 'focus'], 1],
  [['storage', 'broadcast', 'monitor', 'focus'], 1],
  [['monitor', 'broadcast', 'storage', 'focus'], 2],
  [['focus', 'monitor', 'storage', 'broadcast'], 3],
  [['focus', 'broadcast', 'monitor', 'storage'], 2],
  [['monitor', 'focus', 'storage', 'broadcast'], 2],
];

async function resumeStep(step: ResumeStep): Promise<void> {
  if (step === 'broadcast' || step === 'storage') {
    await harness.origin.deliverAll({ to: 'app-a', transport: step });
    return;
  }
  if (step === 'monitor') await vi.advanceTimersByTimeAsync(250);
  else {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  }
  await harness.origin.settle();
}

describe('a login completed while this tab was in the background', () => {
  it.each(RESUME_ORDERS)(
    'Account Center popup, resumed in the order %j: one welcome, %i extra read(s)',
    async (order, reads) => {
      vi.useFakeTimers();
      await initSignedOut();
      const popup = openAccountCenterLogin();
      await vi.advanceTimersByTimeAsync(40_000);
      appA.hold();
      harness.server.account = MINSU;

      await popup.complete('success');
      // The completion page closed itself while this tab was frozen.
      popup.closeWindow();
      appA.release();
      for (const step of order) await resumeStep(step);
      await harness.origin.deliverAll();
      await vi.advanceTimersByTimeAsync(1_000);
      await harness.origin.settle();

      expect(toasts()).toEqual([WELCOME]);
      expect(getAccountSnapshot().account?.nickname).toBe('Minsu');
      expect(appReads() - 1).toBe(reads);
    },
  );

  it.each(RESUME_ORDERS)(
    'protected login, resumed in the order %j: authenticated, never cancelled',
    async (order) => {
      vi.useFakeTimers();
      await initSignedOut();
      const { popup, outcome } = openProtectedLogin();
      await vi.advanceTimersByTimeAsync(40_000);
      appA.hold();
      harness.server.account = MINSU;

      await popup.complete('success');
      popup.closeWindow();
      appA.release();
      for (const step of order) await resumeStep(step);
      await harness.origin.deliverAll();
      await vi.advanceTimersByTimeAsync(1_000);
      await harness.origin.settle();

      await expect(outcome).resolves.toBe('authenticated');
      expect(toasts().filter((message) => message !== WELCOME)).toEqual([]);
    },
  );
});
