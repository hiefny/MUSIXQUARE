/**
 * @vitest-environment jsdom
 *
 * C6-2 owner-boundary characterization of the page navigation shell
 * (structural plan increment C6-2, Phase 0c, built just in time for Phase 2).
 *
 * Registry records (docs/design/resource-ownership-registry.md):
 * - RO-23 App-owned page navigation: the session reset with its reload queue
 *   and page-transition dispatch (the back-forward cache retry, in
 *   page-lifecycle until C6-6), the PRO claim fence, and the unload exemption.
 * - RO-24 `inert` page lock and which surface is on top.
 * - RO-30 Back-button history entries (guard re-arm around a pending reset).
 * - RO-22 Waiting service worker activation, only as far as the logo hard
 *   reset's promotion runs inside the reset's commit deadline.
 * - RO-26 Top-document fullscreen state, only as the top layer over the reset.
 *
 * Real: the reset, document-reload, page-lifecycle, inert-ownership and
 * ui/dom.ts owners with the Back guard, its history helper, navigation.ts,
 * the reload-recovery latch, sw-hard-reset and the PRO claim fragment, wired
 * in app.ts order (see __helpers__/page-navigation-harness.ts). Replaced:
 * location sinks (recorded no-op navigations), frames (16 ms on the fake
 * clock), the Back guard's browser history, the service-worker container,
 * the fullscreen element, app state, i18n (keys), the dialog body
 * (dialog.ts's open/close writes only) and the leave confirmation (a fixed
 * answer).
 *
 * Every test pinned the behaviour of main 51ab2be3 (9.0.3) when it was added.
 * A test name ends with labels naming the increment that changes it, or that
 * must keep it:
 * - "[flips: C6-n]": increment n is planned to change this; its new
 *   expectation is in the comment above the assertion it replaces.
 * - "[flipped: C6-n, owner decision k]": increment n changed this pin as the
 *   owner decided (00-final-roadmap, "Owner decisions 2026-10-23: Phase 2");
 *   the comment says what it pinned before.
 * - "[keeps: C6-n]": increment n moves this code and must keep the outcome.
 * - "[owner decision: topic]": the plan puts this topic to the owner. Until
 *   the owner decides, the increments under "keeps" keep the outcome.
 * - "[owner decision / C6-n: keep or flip]": increment n must keep this or
 *   flip it, whichever the owner decides in its plan; the comment says what a
 *   flip would change.
 * - "[flipped: release]": a release already changed the design's original
 *   pin; the test records the current state so the old one is not restored.
 * - "[replaced by X: C6-n]": increment n replaces the requester shape the test
 *   drives with X; it rewrites the test on X and keeps the outcome.
 * - "[kept: C6-n]": increment n could have kept or flipped this and kept it
 *   (with the owner decision when one applies); the comment says why.
 * - "[added: C6-n]" (or "[<variant> added: C6-n]"): increment n added this pin
 *   or this variant of it, red before n and green after.
 * Pins read the unload exemption at its boundary, a dispatched beforeunload
 * (`beforeunloadPrompts`), not page-lifecycle's internal flag, so C6-7's
 * claims keep every pin except the ones it flips.
 * Increments: C6-4 owner state and settle, C6-5 reload queue into the owner,
 * C6-6 one page-transition dispatch, C6-7 unload-exemption claims, C6-8
 * prepare/navigate split, C6-10 hard reset asks the update machine, C6-11
 * reset surface on top (with the fullscreen top-layer fix), C6-12 Back guard
 * re-arm, C6-13 duplicate latches deleted, and the C6-5 follow-up (owner
 * decision 13) that drops a reload still queued when the page returns from
 * the back-forward cache.
 *
 * The app.ts wiring and the logo action run on copies inside the harness;
 * page-navigation-harness-parity.test.ts pins those copies to the source, so
 * an increment that changes the wiring (C6-6, C6-8, C6-12) updates the copy in
 * the same change.
 *
 * Not covered here: jsdom has no real back-forward cache, top layer, unload or
 * native timing. e2e/back-navigation.test.ts (Chromium launches with the
 * back-forward cache disabled, and the WebKit lane) is the browser evidence;
 * the real-bfcache paths have only these jsdom pins and device checks. The
 * update machine (sw-register.ts) is pinned against the real reset in
 * sw-register-recovery.integration.test.ts; account.ts's own anchor and
 * 10-minute TTL in account.test.ts. C6-3's return-to-room-start and home
 * intents (the /CODE `location.href` push, the mxqr_reconnect_target marker,
 * push versus replace) are pinned on this harness in navigation.test.ts, and
 * each call site's invalid-code fallback in the requester suites
 * (setup-network-error.test.ts, setup-guest-recovery.test.ts, the
 * sw-register.test.ts room cases); no test here drives the 'href' and
 * 'assign' sinks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  capturePendingClaimReloadGuard,
  registerPendingClaimReloadPreparation,
} from '../document-reload.ts';
import { claimUnloadExemption } from '../page-lifecycle.ts';
import {
  isSessionResetPending,
  scheduleDocumentReload,
  scheduleSessionReset,
} from '../session-reset.ts';
import { navigateToAppHome } from '../navigation.ts';
import {
  LEAVE_FALLBACK_MS,
  NAVIGATION_COMMIT_TIMEOUT_MS,
  NAVIGATION_PREPARE_TIMEOUT_MS,
} from '../navigation-contract.ts';
import { onOverlayStackChange } from '../../ui/dom.ts';
import { takeProRoomClaimsFromFragment } from '../../pro-room/claim-fragment.ts';
import {
  IN_ROOM,
  MSG_LEAVING,
  MSG_REFRESHING,
  OUTSIDE_ROOM,
  PAINT_MS,
  ROOM_PATH,
  TRAVERSAL_TASK_MS,
  bootPageNavigationShell,
  enterFullscreen,
  installServiceWorkerFake,
  setVisibility,
  type BootOptions,
  type PageNavigationShell,
} from './__helpers__/page-navigation-harness.ts';

/** The reset's commit deadline. */
const COMMIT_DEADLINE_MS = NAVIGATION_COMMIT_TIMEOUT_MS;
/** The prepare window of a request with a prepare step (C6-8). */
const PREPARE_DEADLINE_MS = NAVIGATION_PREPARE_TIMEOUT_MS;
/** ACTIVATION_TIMEOUT_MS (sw-hard-reset.ts, the lazy chunk keeps it unexported). */
const HARD_RESET_ACTIVATION_MS = 1_500;
/** Two frames: the Back guard pushes after its surface settles. */
const GUARD_ARM_MS = 40;
/** A synthetic claim token in the shape credentials.ts accepts. */
const CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;
/** The three PRO claim fragment keys (claim-fragment.ts:11-13). */
const CLAIM_KEYS = ['pro-claim', 'pro-recovery', 'pro-transfer'] as const;
type ClaimKey = (typeof CLAIM_KEYS)[number];

let shell: PageNavigationShell | null = null;

function boot(options: BootOptions = {}): PageNavigationShell {
  shell = bootPageNavigationShell(options);
  return shell;
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function overlay(): HTMLElement {
  return shell!.element('session-reset-overlay');
}

/** Take a claim the way setup-flow does: the fragment is scrubbed at once. */
function takeClaim(key: ClaimKey = 'pro-claim', path: string = ROOM_PATH): void {
  window.history.replaceState({ test: true }, '', `${path}?lang=ko#${key}=${CLAIM}`);
  takeProRoomClaimsFromFragment();
  expect(location.href).toBe(`http://localhost:3000${path}?lang=ko`);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  shell?.dispose();
  shell = null;
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('(a) a reload asked for while a direct reset is pending', () => {
  // Until C6-5 the bridge reported this reload as recovered at once, while the
  // winning reset still held the page, and nothing ever replayed it. Owner
  // decision 1 queues it: it runs if the winning navigation recovers.
  it('waits behind the reset and runs once that reset recovers [flipped: C6-5, owner decision 1]', async () => {
    const s = boot({ app: IN_ROOM });
    const leave = vi.fn();
    scheduleSessionReset(MSG_LEAVING, leave);
    const onRecovered = vi.fn();

    scheduleDocumentReload(MSG_REFRESHING, onRecovered);

    expect(onRecovered).not.toHaveBeenCalled();
    expect(s.resetMessage()).toBe(MSG_LEAVING);
    await advance(PAINT_MS);
    expect(leave).toHaveBeenCalledOnce();
    expect(s.sinks.count('reload')).toBe(0);

    // The winning navigation is a no-op and recovers; the queued reload starts.
    await advance(COMMIT_DEADLINE_MS);
    expect(isSessionResetPending()).toBe(true);
    expect(s.resetMessage()).toBe(MSG_REFRESHING);
    await advance(PAINT_MS);
    expect(s.sinks.count('reload')).toBe(1);
    expect(onRecovered).not.toHaveBeenCalled();

    // Its own no-op navigation recovers too; nothing runs it again.
    await advance(COMMIT_DEADLINE_MS);
    expect(onRecovered).toHaveBeenCalledOnce();
    expect(isSessionResetPending()).toBe(false);
    await advance(10_000);
    expect(s.sinks.count('reload')).toBe(1);
    expect(overlay().hidden).toBe(true);
  });

  it('never runs a reload queued behind a reset that commits [owner decision 1]', async () => {
    const s = boot({ app: IN_ROOM });
    scheduleSessionReset(MSG_LEAVING, () => navigateToAppHome());
    const onRecovered = vi.fn();
    scheduleDocumentReload(MSG_REFRESHING, onRecovered);

    await advance(PAINT_MS);
    s.leaveDocument(false);
    await advance(COMMIT_DEADLINE_MS + 10_000);

    expect(s.sinks.calls).toEqual([expect.objectContaining({ op: 'replace', url: '/' })]);
    expect(onRecovered).not.toHaveBeenCalled();
    expect(s.resetMessage()).toBe(MSG_LEAVING);
  });

  // Until C6-5 the recovery reload reported a same-document return at once
  // ('recovered:connect') and released the latch while the reset still held
  // the page.
  it('holds a lazy-feature recovery reload, and its prompt latch, until that reload returns [flipped: C6-5, owner decision 1] [keeps: C6-13]', async () => {
    const s = boot({ app: IN_ROOM });
    scheduleSessionReset(MSG_LEAVING, vi.fn());

    s.requestLazyFeatureRecovery('connect');
    await advance(0);
    expect(s.lazyFeature.events).toEqual(['prompt']);
    // A second failure while the reload waits joins the same latch.
    s.requestLazyFeatureRecovery('connect');
    await advance(0);
    expect(s.lazyFeature.events).toEqual(['prompt']);

    // The reset recovers, the queued reload runs, and its no-op returns:
    // app.ts:1081-1089's same-document path, a toast, not a loop.
    await advance(PAINT_MS + COMMIT_DEADLINE_MS + PAINT_MS);
    expect(s.sinks.count('reload')).toBe(1);
    await advance(COMMIT_DEADLINE_MS);
    expect(s.lazyFeature.events).toEqual(['prompt', 'recovered:connect']);

    // The latch is free again: a later failure prompts and reloads.
    s.requestLazyFeatureRecovery('connect');
    await advance(PAINT_MS);
    expect(s.lazyFeature.events).toEqual(['prompt', 'recovered:connect', 'prompt']);
    expect(s.sinks.count('reload')).toBe(2);
  });

  it('refuses a direct reset asked for while a reload is pending: first request wins [keeps: C6-4, C6-5]', async () => {
    const s = boot({ app: IN_ROOM });
    scheduleDocumentReload(MSG_REFRESHING);
    const action = vi.fn();

    expect(scheduleSessionReset(MSG_LEAVING, action)).toBeNull();
    await advance(PAINT_MS);
    expect(s.sinks.count('reload')).toBe(1);
    expect(action).not.toHaveBeenCalled();
    expect(s.resetMessage()).toBe(MSG_REFRESHING);
  });
});

describe('(b) a reload queued behind another reload', () => {
  // The critique's target settle order for C6-4 (commit the state, flush the
  // queue, then run per-attempt callbacks) keeps the queue start first.
  it('runs after the first reload recovers, and the queue starts it before the first caller hears of the recovery [keeps: C6-4, C6-5]', async () => {
    const s = boot({ app: IN_ROOM });
    const firstSettled: Array<{ pending: boolean; message: string | null }> = [];
    const secondRecovered = vi.fn();
    scheduleDocumentReload('First reload', () => {
      firstSettled.push({ pending: isSessionResetPending(), message: s.resetMessage() });
    });
    scheduleDocumentReload('Second reload', secondRecovered);

    await advance(PAINT_MS);
    expect(s.sinks.count('reload')).toBe(1);
    expect(s.resetMessage()).toBe('First reload');

    await advance(COMMIT_DEADLINE_MS);
    // settle() starts the next queued reload before the settled attempt's
    // callbacks run (until C6-5 document-reload's recoverAttempt did).
    expect(firstSettled).toEqual([{ pending: true, message: 'Second reload' }]);
    expect(isSessionResetPending()).toBe(true);

    await advance(PAINT_MS);
    expect(s.sinks.count('reload')).toBe(2);
    await advance(COMMIT_DEADLINE_MS);
    expect(secondRecovered).toHaveBeenCalledOnce();
    expect(isSessionResetPending()).toBe(false);
  });

  it('starts queued reloads in the order they were asked for (FIFO) [keeps: C6-5]', async () => {
    const s = boot({ app: IN_ROOM });
    const order: string[] = [];
    s.sinks.reload.mockImplementation(() => order.push(s.resetMessage() ?? ''));
    scheduleDocumentReload('First');
    // Two entries wait in the queue at once.
    scheduleDocumentReload('Second');
    scheduleDocumentReload('Third');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await advance(PAINT_MS + COMMIT_DEADLINE_MS);
    }

    expect(order).toEqual(['First', 'Second', 'Third']);
    expect(isSessionResetPending()).toBe(false);
  });

  it('queues a reload asked for from a recovery callback behind the queued reload that the flush has already started [keeps: C6-4, C6-5]', async () => {
    const s = boot({ app: IN_ROOM });
    const order: string[] = [];
    s.sinks.reload.mockImplementation(() => order.push(s.resetMessage() ?? ''));
    scheduleDocumentReload('First', () => scheduleDocumentReload('Retry'));
    scheduleDocumentReload('Second');

    await advance(PAINT_MS + COMMIT_DEADLINE_MS);
    // 'Second' started before 'First' reported its recovery, so 'Retry' waits
    // behind a running reload, not behind a queued one.
    expect(s.resetMessage()).toBe('Second');
    await advance(PAINT_MS + COMMIT_DEADLINE_MS);
    expect(s.resetMessage()).toBe('Retry');
    await advance(PAINT_MS);

    expect(order).toEqual(['First', 'Second', 'Retry']);
  });

  it('starts a reload asked for from a recovery callback at once when nothing is queued (sw-register.ts:295-309 shape) [keeps: C6-4]', async () => {
    const s = boot({ app: IN_ROOM });
    scheduleDocumentReload('Update', () => scheduleDocumentReload('Successor update'));

    await advance(PAINT_MS + COMMIT_DEADLINE_MS);
    expect(isSessionResetPending()).toBe(true);
    expect(s.resetMessage()).toBe('Successor update');
    await advance(PAINT_MS);
    expect(s.sinks.count('reload')).toBe(2);
  });

  // Owner decision 13 confirmed "same reason" as the same message text.
  it('lets a waiting request join one with the same message, so one reload answers both [owner decisions 1, 13]', async () => {
    const s = boot({ app: IN_ROOM });
    const order: string[] = [];
    s.sinks.reload.mockImplementation(() => order.push(s.resetMessage() ?? ''));
    scheduleSessionReset(MSG_LEAVING, vi.fn());
    const first = vi.fn();
    const other = vi.fn();
    const second = vi.fn();
    scheduleDocumentReload(MSG_REFRESHING, first);
    scheduleDocumentReload('Other reason', other);
    scheduleDocumentReload(MSG_REFRESHING, second);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await advance(PAINT_MS + COMMIT_DEADLINE_MS);
    }

    // The joined request keeps the first one's place in the queue.
    expect(order).toEqual([MSG_REFRESHING, 'Other reason']);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledOnce();
    expect(isSessionResetPending()).toBe(false);
  });

  it('queues a request behind the running reload of the same message instead of joining it [owner decisions 1, 13]', async () => {
    const s = boot({ app: IN_ROOM });
    const running = vi.fn();
    const next = vi.fn();
    scheduleDocumentReload(MSG_REFRESHING, running);
    await advance(PAINT_MS);
    expect(s.sinks.count('reload')).toBe(1);

    // The running reload is the winning navigation: a request that arrives
    // during it runs if it recovers.
    scheduleDocumentReload(MSG_REFRESHING, next);
    await advance(COMMIT_DEADLINE_MS);
    expect(running).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
    await advance(PAINT_MS);
    expect(s.sinks.count('reload')).toBe(2);
    await advance(COMMIT_DEADLINE_MS);
    expect(next).toHaveBeenCalledOnce();
  });

  it('accepts a direct reset asked for from its own recovery callback [keeps: C6-4]', async () => {
    const s = boot({ app: IN_ROOM });
    const retry = vi.fn();
    const handle = scheduleSessionReset(MSG_LEAVING, vi.fn());
    handle?.onRecovered(() => {
      expect(scheduleSessionReset('Retry', retry)).not.toBeNull();
    });

    await advance(PAINT_MS + COMMIT_DEADLINE_MS);
    expect(s.resetMessage()).toBe('Retry');
    await advance(PAINT_MS);
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe('settlement of one reset attempt', () => {
  // C6-12 kept this order and re-arms the Back guard from the owner's
  // pending-change event at the end of settle instead (pin (h)).
  it('releases the windows while still pending, then reports idle with the exemption already cleared [keeps: C6-4] [kept: C6-12]', async () => {
    const s = boot({ app: IN_ROOM });
    const seen: string[] = [];
    const snapshot = (where: string) =>
      `${where}: pending=${isSessionResetPending()} overlayHidden=${overlay().hidden} prompts=${s.beforeunloadPrompts()}`;
    const handle = scheduleSessionReset(MSG_LEAVING, vi.fn());
    await advance(PAINT_MS);
    expect(s.beforeunloadPrompts()).toBe(false);
    const unsubscribe = onOverlayStackChange(() => seen.push(snapshot('overlay stack')));
    s.addCleanup(unsubscribe);
    handle?.onRecovered(() => seen.push(snapshot('recovered')));

    await advance(COMMIT_DEADLINE_MS);

    // settle() in session-reset.ts: focus, the release handler (dom.ts
    // re-derives the stack and notifies the Back guard), then the overlay
    // hides, the reset reports idle, the exemption clears, and only then do
    // per-attempt callbacks run. C6-4 and C6-12 kept this order; C6-12 (owner
    // decision 5) re-arms the guard from onNavigationPendingChange, sent after
    // these callbacks, and that flipped pin (h).
    expect(seen).toEqual([
      'overlay stack: pending=true overlayHidden=false prompts=false',
      'recovered: pending=false overlayHidden=true prompts=true',
    ]);

    // A subscriber added after settlement hears of it at once.
    const late = vi.fn();
    handle?.onRecovered(late);
    expect(late).toHaveBeenCalledOnce();
  });

  const EVENTS = ['pagehide', 'pageshow', 'visible', 'deadline'] as const;
  type SettleEvent = (typeof EVENTS)[number];
  const permutations = (items: readonly SettleEvent[]): SettleEvent[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, index) =>
          permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
            item,
            ...rest,
          ]),
        );

  /**
   * Today's rule, written out: pagehide commits, and the departure's own
   * visibilitychange(hidden) restores nothing; a return or the deadline restores.
   */
  function expectedRecovery(order: readonly SettleEvent[]): boolean {
    let committed = false;
    for (const event of order) {
      if (event === 'pagehide') committed = true;
      else if (event === 'deadline' && !committed) return true;
      else if ((event === 'pageshow' || event === 'visible') && committed) return true;
    }
    return false;
  }

  // A partial pin of the C6-4 sequence test. It starts only after the action
  // has run and uses non-persisted page transitions; a pageshow after pagehide
  // that is not persisted does not reach a loaded document in a real engine.
  // 'pagehide' is a whole departure in the platform order (pagehide, then
  // visibilitychange(hidden)); 'visible' makes the document visible again.
  // C6-4's full sequence test (persisted pagehide and pageshow, the paint
  // frames and the 120 ms fallback before the action) is in
  // session-reset.test.ts "exactly-once typed settlement"; the explicit restore
  // from inside the action is pinned below as the runtime.ts shape.
  it.each(
    (['reset', 'reload'] as const).flatMap((kind) =>
      permutations(EVENTS).map((order) => [kind, order.join(' > '), order] as const),
    ),
  )(
    'after the %s action, %s settles at most once [keeps: C6-4, after the action only]',
    async (kind, _name, order) => {
      const s = boot({ app: OUTSIDE_ROOM });
      const recovered = vi.fn();
      if (kind === 'reset') scheduleSessionReset(MSG_LEAVING, vi.fn())?.onRecovered(recovered);
      else scheduleDocumentReload(MSG_REFRESHING, recovered);
      await advance(PAINT_MS);
      expect(s.sinks.count('reload')).toBe(kind === 'reload' ? 1 : 0);

      for (const event of order) {
        // A non-persisted pageshow keeps page-lifecycle's bfcache branch out.
        if (event === 'pagehide') s.leaveDocument(false);
        else if (event === 'pageshow') s.pageshow(false);
        else if (event === 'visible') setVisibility('visible');
        else await advance(COMMIT_DEADLINE_MS);
      }
      await advance(10_000);

      const recovers = expectedRecovery(order);
      expect(recovered).toHaveBeenCalledTimes(recovers ? 1 : 0);
      expect(isSessionResetPending()).toBe(!recovers);
    },
  );
});

describe('a request that is no longer current at navigate (isCurrent)', () => {
  // The pro-room/runtime.ts shape: the requester checks that its terminal
  // recovery owner is still current. Until C6-8 the action called
  // restoreSessionReset() itself instead of navigating; C6-8 replaced that with
  // isCurrent(), which the owner asks right before its final navigation call:
  // false restores the page once, with no navigating phase or commit deadline.
  // The outcomes below are the ones the explicit restore had.
  function scheduleOwnerCheckedReset(ownerIsCurrent: boolean, events: string[]): void {
    scheduleSessionReset(MSG_LEAVING, {
      isCurrent: () => {
        events.push(`isCurrent: pending=${isSessionResetPending()}`);
        return ownerIsCurrent;
      },
      navigate: () => navigateToAppHome(),
    })?.onRecovered(() => events.push(`recovered: pending=${isSessionResetPending()}`));
  }

  it('settles once at navigate when the owner is stale, navigates nowhere, and accepts a later request [keeps: C6-4] [replaced by isCurrent: C6-8]', async () => {
    const s = boot({ app: IN_ROOM });
    const events: string[] = [];
    scheduleOwnerCheckedReset(false, events);
    expect(isSessionResetPending()).toBe(true);

    await advance(PAINT_MS);

    expect(events).toEqual(['isCurrent: pending=true', 'recovered: pending=false']);
    expect(isSessionResetPending()).toBe(false);
    expect(overlay().hidden).toBe(true);
    expect(s.element('tab-play').inert).toBe(false);
    expect(s.beforeunloadPrompts()).toBe(true);

    // No commit deadline was armed for the stale request.
    await advance(COMMIT_DEADLINE_MS + 10_000);
    expect(events).toHaveLength(2);
    expect(isSessionResetPending()).toBe(false);
    expect(s.sinks.calls).toEqual([]);

    scheduleDocumentReload(MSG_REFRESHING);
    expect(isSessionResetPending()).toBe(true);
    await advance(PAINT_MS);
    expect(s.sinks.count('reload')).toBe(1);
  });

  it('does not let a deadline of the stale request settle a reset accepted right after it [keeps: C6-4] [replaced by isCurrent: C6-8]', async () => {
    const s = boot({ app: IN_ROOM });
    scheduleOwnerCheckedReset(false, []);
    await advance(PAINT_MS);
    const successorRecovered = vi.fn();
    scheduleSessionReset('Successor', () => navigateToAppHome())?.onRecovered(successorRecovered);
    expect(isSessionResetPending()).toBe(true);

    // A deadline of the stale request would fall 2 s after it; the
    // successor's falls one paint later.
    await advance(COMMIT_DEADLINE_MS + 1);
    expect(isSessionResetPending()).toBe(true);
    expect(successorRecovered).not.toHaveBeenCalled();
    expect(s.sinks.count('replace')).toBe(1);

    await advance(PAINT_MS);
    expect(successorRecovered).toHaveBeenCalledOnce();
    expect(isSessionResetPending()).toBe(false);
  });

  it('navigates home when the owner is still current and holds the page once the departure commits [keeps: C6-4] [replaced by isCurrent: C6-8]', async () => {
    const s = boot({ app: IN_ROOM });
    const events: string[] = [];
    scheduleOwnerCheckedReset(true, events);

    await advance(PAINT_MS);
    expect(s.sinks.calls).toEqual([expect.objectContaining({ op: 'replace', url: '/' })]);
    expect(isSessionResetPending()).toBe(true);
    expect(s.beforeunloadPrompts()).toBe(false);

    s.leaveDocument(false);
    await advance(COMMIT_DEADLINE_MS + 10_000);
    expect(isSessionResetPending()).toBe(true);
    expect(events).toEqual(['isCurrent: pending=true']);
  });

  // A variant of (h): Back absorbed while the reset is pending.
  it('re-arms the Back guard when a stale request restores the page after Back was absorbed [flipped: C6-12, owner decision 5]', async () => {
    const s = boot({ app: IN_ROOM });
    await advance(GUARD_ARM_MS);
    expect(s.history.marker()).toBe('guard');
    scheduleOwnerCheckedReset(false, []);
    s.history.pressBack();
    expect(s.history.marker()).toBe('base');
    expect(s.leaveConfirmation.requests).toBe(0);

    await advance(PAINT_MS + GUARD_ARM_MS + 1_000);
    expect(isSessionResetPending()).toBe(false);
    // Until C6-12 nothing re-armed the guard here ('base', one push).
    expect(s.history.marker()).toBe('guard');
    expect(s.history.pushes).toHaveLength(2);
  });
});

describe('the failed exit: the navigation action throws', () => {
  const ACTION_FAILED = '[SessionReset] Hard-navigation action failed:';

  // The third branch of the reload busy rule, beside (a) and (b). Until C6-5,
  // document-reload's catch recovered the throwing attempt and flushed its
  // queue while the reset still held the page, so the queued reload met the
  // busy rule and was dropped as recovered ('second: pending=true' first),
  // and nothing replayed it. Owner decision 1 queues it: settle('failed')
  // releases the page, starts the queued reload, then tells the failing caller.
  it('releases the failed reload and runs the reload queued behind it, before the failing caller hears [flipped: C6-5, owner decision 1] [keeps: C6-4]', async () => {
    const s = boot({ app: IN_ROOM });
    const failure = new Error('reload rejected');
    s.sinks.reload.mockImplementationOnce(() => {
      throw failure;
    });
    const settled: string[] = [];
    scheduleDocumentReload('First', () =>
      settled.push(
        `first: pending=${isSessionResetPending()} message=${s.resetMessage()} prompts=${s.beforeunloadPrompts()}`,
      ),
    );
    scheduleDocumentReload('Second', () =>
      settled.push(`second: pending=${isSessionResetPending()}`),
    );

    await advance(PAINT_MS);

    // The exemption the failed action took is cleared: the queued reload
    // takes its own when its action starts.
    expect(settled).toEqual(['first: pending=true message=Second prompts=true']);
    expect(s.sinks.reload).toHaveBeenCalledOnce();
    expect(s.console.error).toHaveBeenCalledWith(ACTION_FAILED, failure);

    await advance(PAINT_MS);
    expect(s.sinks.reload).toHaveBeenCalledTimes(2);
    await advance(COMMIT_DEADLINE_MS);
    expect(settled).toEqual([
      'first: pending=true message=Second prompts=true',
      'second: pending=false',
    ]);
    expect(overlay().hidden).toBe(true);
    expect(s.element('tab-play').inert).toBe(false);
    expect(s.beforeunloadPrompts()).toBe(true);
    await advance(10_000);
    expect(s.sinks.reload).toHaveBeenCalledTimes(2);
  });

  it('releases the page at once without a sink call when the claim preparation rejects a changed URL [keeps: C6-4, C6-5]', async () => {
    const s = boot({ app: IN_ROOM });
    takeClaim();
    // Something wrote a fragment after the claim was taken.
    window.history.replaceState(null, '', `${ROOM_PATH}?lang=ko#stray`);
    const recovered = vi.fn();
    scheduleDocumentReload(MSG_REFRESHING, recovered);

    await advance(PAINT_MS);

    // claim-fragment.ts:188-190 throws inside the reload action, before the sink.
    expect(s.sinks.reload).not.toHaveBeenCalled();
    expect(recovered).toHaveBeenCalledOnce();
    expect(isSessionResetPending()).toBe(false);
    expect(s.beforeunloadPrompts()).toBe(true);
    expect(location.hash).toBe('#stray');
    expect(s.console.error).toHaveBeenCalledWith(
      ACTION_FAILED,
      expect.objectContaining({ message: 'CLAIM_RELOAD_PREPARATION_REJECTED' }),
    );

    // The fence is back to 'safe': a reload from the clean URL restores it.
    window.history.replaceState(null, '', `${ROOM_PATH}?lang=ko`);
    scheduleDocumentReload(MSG_REFRESHING);
    await advance(PAINT_MS);
    expect(s.sinks.calls.at(-1)?.hrefAtCall).toBe(
      `http://localhost:3000${ROOM_PATH}?lang=ko#pro-claim=${CLAIM}`,
    );
  });

  it('settles a direct reset once when its action throws, with the exemption cleared [keeps: C6-4]', async () => {
    const s = boot({ app: IN_ROOM });
    const failure = new Error('leave failed');
    const promptsWhenSettled: boolean[] = [];
    scheduleSessionReset(MSG_LEAVING, () => {
      throw failure;
    })?.onRecovered(() => promptsWhenSettled.push(s.beforeunloadPrompts()));

    await advance(PAINT_MS);

    expect(promptsWhenSettled).toEqual([true]);
    expect(isSessionResetPending()).toBe(false);
    expect(overlay().hidden).toBe(true);
    expect(s.beforeunloadPrompts()).toBe(true);
    expect(s.console.error).toHaveBeenCalledWith(ACTION_FAILED, failure);

    // No listener or timer of the attempt is left to settle it again.
    s.pagehide(false);
    s.pageshow(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(COMMIT_DEADLINE_MS + 10_000);
    expect(promptsWhenSettled).toEqual([true]);
  });
});

describe('(c) a pending reset returned from the back-forward cache', () => {
  it('restores the shell and makes exactly one fresh reload; a second return does not loop [keeps: C6-6] [flipped: C6-7, owner decision 3]', async () => {
    const s = boot({ app: IN_ROOM });
    scheduleDocumentReload(MSG_REFRESHING);
    await advance(PAINT_MS);
    expect(s.sinks.count('reload')).toBe(1);
    s.leaveDocument(true);

    document.body.classList.remove('fouc-loaded');
    s.returnFromBfcache('pageshow-first');

    // The owner's pageshow dispatch (session-reset.ts, C6-6; page-lifecycle
    // until then): reveal, settle the stale reset, mark the exemption, then
    // one fresh reload through the owner.
    expect(document.body.classList.contains('fouc-loaded')).toBe(true);
    expect(isSessionResetPending()).toBe(true);
    expect(s.resetMessage()).toBe(MSG_REFRESHING);
    // Until C6-7 page-lifecycle pre-marked the exemption here, before the
    // fresh reload's action (false). The reload now claims it when its action
    // starts, so until then the page asks to confirm an unload.
    expect(s.beforeunloadPrompts()).toBe(true);
    await advance(PAINT_MS);
    expect(s.beforeunloadPrompts()).toBe(false);
    expect(s.sinks.count('reload')).toBe(2);

    // The fresh reload also lands in the cache and the same document returns.
    s.leaveDocument(true);
    s.returnFromBfcache('pageshow-first');
    await advance(PAINT_MS + COMMIT_DEADLINE_MS);

    expect(s.sinks.count('reload')).toBe(2);
    expect(isSessionResetPending()).toBe(false);
    expect(overlay().hidden).toBe(true);
    expect(s.element('tab-play').inert).toBe(false);
    expect(s.beforeunloadPrompts()).toBe(true);
    expect(s.lifecycleLog).toHaveBeenLastCalledWith(
      '[PageLifecycle] bfcache reload returned; keeping recovered shell visible',
    );
  });

  // The return order is not settled across engines and devices (see the
  // harness: current Chromium and WebKit sources lead with visibility; real
  // iOS is a device check). The owner's capture-phase visibility listener
  // restores first when visibility leads, and its pageshow then sees no
  // pending reset. C6-6 kept this: its one dispatch decides on the live state
  // at each event, as the two listeners did, not on "pending at return",
  // which would make the visible-first row outside a room reload too; owner
  // decision 13 keeps that row at 0 reloads.
  // The departure itself settles nothing: pagehide commits the reset and the
  // visibilitychange(hidden) after it restores nothing.
  it.each([
    ['pageshow-first', 'outside a room', 1, OUTSIDE_ROOM, true],
    ['visible-first', 'outside a room', 0, OUTSIDE_ROOM, false],
    ['pageshow-first', 'in a room', 1, IN_ROOM, true],
    ['visible-first', 'in a room', 1, IN_ROOM, true],
  ] as const)(
    '%s return %s: %i fresh reload(s) [kept: C6-6, owner decision 13]',
    async (order, _where, freshReloads, app, pendingAfterReturn) => {
      const s = boot({ app });
      scheduleSessionReset(MSG_LEAVING, () => navigateToAppHome());
      await advance(PAINT_MS);
      expect(s.sinks.count('replace')).toBe(1);
      s.leaveDocument(true);
      expect(isSessionResetPending()).toBe(true);
      expect(overlay().hidden).toBe(false);

      s.returnFromBfcache(order);

      expect(isSessionResetPending()).toBe(pendingAfterReturn);
      await advance(PAINT_MS);
      expect(s.sinks.count('reload')).toBe(freshReloads);
      expect(s.sinks.count('replace')).toBe(1);
    },
  );

  // A reload queued behind a navigation that commits never runs while the
  // document is gone (pin (a)), but the document can come back from the cache.
  // Until the C6-5 follow-up (owner decision 13), the persisted pageshow
  // settled the returned reset, that settle started the queued reload, and the
  // owner's bounded bfcache reload waited behind it: two reloads whenever the
  // first one did not commit. The persisted pageshow now drops every reload
  // still queued and leaves the one reload to the bfcache return path. Each
  // dropped caller hears once, as a request that is no longer current does
  // (its onRecovered, the 'recovered' outcome), after that path has taken the
  // page. On the visible-first order the visible return has already started
  // the queued reload, and the pageshow settles it as a returned reset: one
  // reload before and after.
  it.each(
    (['pageshow-first', 'pageshow-only', 'visible-first'] as const).flatMap((order) =>
      (
        [
          ['in a room', IN_ROOM],
          ['outside a room', OUTSIDE_ROOM],
        ] as const
      ).map(([where, app]) => [order, where, app] as const),
    ),
  )(
    'drops a reload still queued behind a committed reset on a %s return %s: one fresh reload, and the queued caller settles once [pageshow orders added: C6-5 follow-up, owner decision 13]',
    async (order, _where, app) => {
      const s = boot({ app });
      const reloads: Array<string | null> = [];
      s.sinks.reload.mockImplementation(() => reloads.push(s.resetMessage()));
      scheduleSessionReset(MSG_LEAVING, () => navigateToAppHome());
      const queued = vi.fn();
      scheduleDocumentReload('Queued reload', queued);
      await advance(PAINT_MS);
      expect(s.sinks.count('replace')).toBe(1);
      s.leaveDocument(true);
      expect(queued).not.toHaveBeenCalled();

      s.returnFromBfcache(order);
      // Every reload that starts here is a no-op that recovers at its deadline.
      await advance(2 * (PAINT_MS + COMMIT_DEADLINE_MS) + 10_000);

      // Before the follow-up the pageshow orders made ['Queued reload', MSG_REFRESHING].
      expect(reloads).toEqual([MSG_REFRESHING]);
      expect(queued).toHaveBeenCalledOnce();
      expect(queued).toHaveBeenCalledWith();
      expect(isSessionResetPending()).toBe(false);
      expect(overlay().hidden).toBe(true);
      expect(s.sinks.count('replace')).toBe(1);
    },
  );

  it('drops every reload still queued at a pageshow-first return, answering each caller once in queue order once the fresh reload holds the page [added: C6-5 follow-up, owner decision 13]', async () => {
    const s = boot({ app: IN_ROOM });
    const events: string[] = [];
    const caller = (name: string) => () =>
      events.push(`${name}: pending=${isSessionResetPending()} message=${s.resetMessage()}`);
    scheduleSessionReset(MSG_LEAVING, () => navigateToAppHome());
    scheduleDocumentReload(MSG_REFRESHING, caller('first'));
    scheduleDocumentReload('Other reason', caller('other'));
    // Joins the first request and keeps its place in the queue.
    scheduleDocumentReload(MSG_REFRESHING, caller('joined'));
    await advance(PAINT_MS);
    s.leaveDocument(true);

    s.returnFromBfcache('pageshow-first');
    const atReturn = [...events];
    await advance(3 * (PAINT_MS + COMMIT_DEADLINE_MS) + 10_000);

    // Before the follow-up: three reloads (the two queued ones, then the fresh one).
    expect(s.sinks.count('reload')).toBe(1);
    expect(atReturn).toEqual([
      `first: pending=true message=${MSG_REFRESHING}`,
      `joined: pending=true message=${MSG_REFRESHING}`,
      `other: pending=true message=${MSG_REFRESHING}`,
    ]);
    expect(events).toEqual(atReturn);
    expect(isSessionResetPending()).toBe(false);
    // Two queued requests: the joined one and 'Other reason'.
    expect(s.lifecycleLog).toHaveBeenCalledWith(
      '[PageLifecycle] Dropped queued reloads on bfcache return:',
      2,
    );
  });

  it('lets a dropped caller that asks again wait behind the fresh reload, which then commits [added: C6-5 follow-up, owner decision 13]', async () => {
    const s = boot({ app: IN_ROOM });
    const reloads: Array<string | null> = [];
    s.sinks.reload.mockImplementation(() => reloads.push(s.resetMessage()));
    scheduleSessionReset(MSG_LEAVING, () => navigateToAppHome());
    scheduleDocumentReload('Queued reload', () => scheduleDocumentReload('Retry'));
    await advance(PAINT_MS);
    s.leaveDocument(true);

    s.returnFromBfcache('pageshow-first');
    await advance(PAINT_MS);
    // The fresh reload commits; the retry asked for behind it never runs.
    s.leaveDocument(false);
    await advance(2 * (PAINT_MS + COMMIT_DEADLINE_MS) + 10_000);

    // Before the follow-up the queued reload ran instead: ['Queued reload'].
    expect(reloads).toEqual([MSG_REFRESHING]);
    expect(isSessionResetPending()).toBe(true);
    expect(s.resetMessage()).toBe(MSG_REFRESHING);
  });

  it('drops a lazy-feature recovery reload still queued at a pageshow-first return and frees its prompt latch once: one reload [added: C6-5 follow-up, owner decision 13]', async () => {
    const s = boot({ app: IN_ROOM });
    scheduleSessionReset(MSG_LEAVING, () => navigateToAppHome());
    s.requestLazyFeatureRecovery('connect');
    await advance(0);
    expect(s.lazyFeature.events).toEqual(['prompt']);
    await advance(PAINT_MS);
    expect(s.sinks.count('replace')).toBe(1);
    s.leaveDocument(true);

    s.returnFromBfcache('pageshow-first');
    const atReturn = {
      events: [...s.lazyFeature.events],
      pending: isSessionResetPending(),
      message: s.resetMessage(),
    };
    await advance(2 * (PAINT_MS + COMMIT_DEADLINE_MS) + 10_000);

    // Before the follow-up: two reloads, and the latch heard only after the first.
    expect(s.sinks.count('reload')).toBe(1);
    expect(atReturn).toEqual({
      events: ['prompt', 'recovered:connect'],
      pending: true,
      message: MSG_REFRESHING,
    });
    expect(s.lazyFeature.events).toEqual(['prompt', 'recovered:connect']);

    // The latch is free again: a later failure prompts and reloads.
    s.requestLazyFeatureRecovery('connect');
    await advance(PAINT_MS);
    expect(s.lazyFeature.events).toEqual(['prompt', 'recovered:connect', 'prompt']);
    expect(s.sinks.count('reload')).toBe(2);
  });

  // Owner decision 13 drops a reload still queued at a back-forward cache
  // return whatever that return then decides, so a reload held by a deferred
  // PRO claim fence is dropped too. In a room the fresh reload takes its place
  // behind the fence; outside a room with nothing pending the return reloads
  // nothing, and the dropped caller has heard once and can ask again.
  it.each([
    ['in a room', [MSG_REFRESHING], IN_ROOM],
    ['outside a room', [], OUTSIDE_ROOM],
  ] as const)(
    'drops a reload held by a deferred PRO claim fence at a pageshow-first return %s, then reloads %j once the fence opens [added: C6-5 follow-up, owner decision 13]',
    async (_where, expectedReloads, app) => {
      const s = boot({ app });
      const reloads: Array<string | null> = [];
      s.sinks.reload.mockImplementation(() => reloads.push(s.resetMessage()));
      takeClaim();
      const fence = capturePendingClaimReloadGuard();
      await fence?.fenceOutcomeUnknownMutation();
      const queued = vi.fn();
      scheduleDocumentReload('Queued reload', queued);
      expect(isSessionResetPending()).toBe(false);

      s.leaveDocument(true);
      s.returnFromBfcache('pageshow-first');
      fence?.restoreAfterLazyFeatureFailure();
      await advance(2 * (PAINT_MS + COMMIT_DEADLINE_MS) + 10_000);

      // Before the follow-up: ['Queued reload', MSG_REFRESHING] in a room and
      // ['Queued reload'] outside it.
      expect(reloads).toEqual(expectedReloads);
      expect(queued).toHaveBeenCalledOnce();
      expect(isSessionResetPending()).toBe(false);
    },
  );

  // Listener phases: the owner's pagehide, pageshow and visibility listeners
  // are capture listeners (session-reset.ts, C6-6), the guard's are bubble
  // listeners (app.ts:982-987), so the owner always runs first. With a window
  // open outside a room, a guard is needed, so the order decides whether one
  // is armed.
  async function pendingResetWithWindowAndAbsorbedBack(): Promise<PageNavigationShell> {
    const s = boot({ app: OUTSIDE_ROOM });
    s.openDialog({ closeOnBack: true });
    await advance(GUARD_ARM_MS);
    expect(s.history.marker()).toBe('guard');

    scheduleSessionReset(MSG_LEAVING, () => navigateToAppHome());
    await advance(PAINT_MS);
    // Absorbed while the reset is pending; the window stays open.
    s.history.pressBack();
    expect(s.history.marker()).toBe('base');
    expect(s.element('dialog-overlay').classList.contains('show')).toBe(true);
    return s;
  }

  it.each([
    ['visible-first', true],
    ['pageshow-first', false],
    ['pageshow-only', false],
  ] as const)(
    'a %s return of a pending reset with a window open arms the Back guard: %s, and once the fresh reload recovers on every order [kept: C6-6] [flipped: C6-12 for the pageshow orders, owner decision 5]',
    async (order, armed) => {
      const s = await pendingResetWithWindowAndAbsorbedBack();
      s.leaveDocument(true);
      s.returnFromBfcache(order);
      await advance(GUARD_ARM_MS);

      // On the pageshow orders page-lifecycle's fresh reload is pending when
      // the guard resumes; this holds before and after C6-12.
      expect(s.history.marker()).toBe(armed ? 'guard' : 'base');
      expect(isSessionResetPending()).toBe(!armed);
      expect(s.sinks.count('reload')).toBe(armed ? 0 : 1);

      // The fresh reload's no-op navigation recovers at its commit deadline.
      // Until C6-12 the release notified the guard while the reset still
      // reported pending (the settle-order pin), so nothing armed it on the
      // pageshow orders ('base'). The pending-change event now re-arms it.
      await advance(PAINT_MS + COMMIT_DEADLINE_MS + GUARD_ARM_MS);
      expect(isSessionResetPending()).toBe(false);
      expect(s.history.marker()).toBe('guard');
    },
  );

  it('restores a reset in the capture phase when iOS only foregrounds the old document, before the guard resumes, so the guard re-arms [keeps: C6-6]', async () => {
    const s = await pendingResetWithWindowAndAbsorbedBack();
    s.leaveDocument(false);
    // No pageshow follows. A bubble-phase reset listener would run after the
    // guard's resume (registered at boot) and leave the guard unarmed.
    setVisibility('visible');
    await advance(GUARD_ARM_MS);

    expect(isSessionResetPending()).toBe(false);
    expect(s.history.marker()).toBe('guard');
    expect(s.sinks.count('reload')).toBe(0);
  });

  // Until C6-6 the 'pageshow-only' rows relied on page-lifecycle's bubble
  // pageshow listener being registered before the guard's resume (the
  // app.ts init order); with the guard booted first the guard resumed while
  // the returned reset was still pending and stayed unarmed. The owner's
  // capture-phase dispatch gives the same outcome in both init orders.
  it.each(
    (['app', 'guard-first'] as const).flatMap((initOrder) =>
      (['pageshow-first', 'visible-first', 'pageshow-only'] as const).map(
        (order) => [initOrder, order] as const,
      ),
    ),
  )(
    'with the %s init order, re-arms the Back guard in a room only on the second %s return, after the bounded reload stops [keeps: C6-6, C6-12] [guard-first added: C6-6]',
    async (initOrder, order) => {
      const s = boot({ app: IN_ROOM, initOrder });
      await advance(GUARD_ARM_MS);
      expect(s.history.marker()).toBe('guard');

      scheduleDocumentReload(MSG_REFRESHING);
      await advance(PAINT_MS);
      // Back taken while the reload is pending is absorbed (back-button-guard.ts:128).
      s.history.pressBack();
      expect(s.history.marker()).toBe('base');
      expect(s.leaveConfirmation.requests).toBe(0);

      s.leaveDocument(true);
      s.returnFromBfcache(order);
      await advance(GUARD_ARM_MS);
      // Every order ends with page-lifecycle's fresh reload pending when the
      // guard last resumes, so it stays unarmed after C6-12 too. Here the
      // fresh reload never settles in this document (the next pagehide
      // commits it); C6-12's re-arm on settle is pinned in the window-open
      // rows above and in (h).
      expect(isSessionResetPending()).toBe(true);
      expect(s.history.marker()).toBe('base');
      expect(s.history.pushes).toHaveLength(1);

      s.leaveDocument(true);
      s.returnFromBfcache(order);
      await advance(GUARD_ARM_MS);
      // For 'pageshow-only' only the pageshow resume can re-arm: the owner's
      // capture-phase pageshow settles the returned reset before the guard's
      // bubble-phase resume, in either init order.
      expect(isSessionResetPending()).toBe(false);
      expect(s.history.marker()).toBe('guard');
      expect(s.history.pushes).toHaveLength(2);
      expect(s.sinks.count('reload')).toBe(2);

      s.history.pressBack();
      await advance(0);
      expect(s.leaveConfirmation.requests).toBe(1);
    },
  );

  it('returns a confirmed Back leave with one fresh reload of the idle page [keeps: C6-6]', async () => {
    const s = boot({ app: IN_ROOM });
    await advance(GUARD_ARM_MS);

    s.history.pressBack();
    await advance(0);
    expect(s.leaveConfirmation.requests).toBe(1);
    expect(s.resetMessage()).toBe(MSG_LEAVING);
    await advance(PAINT_MS);
    expect(s.leaveSession).toHaveBeenCalledOnce();
    await advance(TRAVERSAL_TASK_MS);
    // The leave traverses past this document's base entry.
    expect(s.history.departures).toEqual(['back']);

    s.leaveDocument(true);
    s.returnFromBfcache('pageshow-first');

    expect(s.app.role).toBe('idle');
    expect(isSessionResetPending()).toBe(true);
    expect(s.resetMessage()).toBe(MSG_REFRESHING);
    await advance(PAINT_MS + LEAVE_FALLBACK_MS);
    expect(s.sinks.count('reload')).toBe(1);
    // The leave's 1 s fallback never runs: the reset's onRecovered wiring (the
    // app.ts:965-968 copy, backHistory.cancelLeave()) cancelled it when
    // page-lifecycle restored the pending reset on return. The leave's own
    // pagehide cancel (back-button-history.ts:109) also ran, but this pin
    // cannot tell the two apart; back-button-history.test.ts pins it ("does
    // not resume a leave after bfcache pagehide and pageshow").
    expect(s.sinks.count('replace')).toBe(0);
  });
});

describe('(d) a back-forward cache reload held by a deferred PRO claim fence', () => {
  it('asks to confirm an unload while the reload waits behind the fence, and claims the exemption only when it runs [flipped: C6-7, owner decision 3]', async () => {
    const s = boot({ app: IN_ROOM });
    window.history.replaceState(null, '', `${ROOM_PATH}#pro-claim=${CLAIM}`);
    takeProRoomClaimsFromFragment();
    expect(location.hash).toBe('');
    const fence = capturePendingClaimReloadGuard();
    await fence?.fenceOutcomeUnknownMutation();
    expect(s.beforeunloadPrompts()).toBe(true);

    s.leaveDocument(true);
    s.returnFromBfcache('pageshow-first');

    // The owner queues the reload behind the deferred fence, so no overlay
    // owns the page. Until C6-7 page-lifecycle pre-marked the shared flag
    // before queueing it (false here, and for as long as it waited): closing
    // the room tab then left without asking. The reload now claims the
    // exemption when it starts.
    expect(isSessionResetPending()).toBe(false);
    expect(overlay().hidden).toBe(true);
    expect(s.beforeunloadPrompts()).toBe(true);
    await advance(60_000);
    expect(s.beforeunloadPrompts()).toBe(true);
    expect(s.sinks.count('reload')).toBe(0);

    // The claim flow fails before its mutation: the queued reload runs and
    // restores the claim fragment only while the sink runs.
    fence?.restoreAfterLazyFeatureFailure();
    expect(isSessionResetPending()).toBe(true);
    expect(s.beforeunloadPrompts()).toBe(true);
    await advance(PAINT_MS);
    expect(s.sinks.calls.at(-1)).toMatchObject({
      op: 'reload',
      hrefAtCall: `http://localhost:3000${ROOM_PATH}#pro-claim=${CLAIM}`,
    });
    expect(s.beforeunloadPrompts()).toBe(false);
    await advance(COMMIT_DEADLINE_MS);
    expect(location.hash).toBe('');
    expect(s.beforeunloadPrompts()).toBe(true);
  });
});

describe('(e) the unload exemption is a set of claims, one per writer', () => {
  it('keeps an exemption another writer holds when an unrelated reset recovers [flipped: C6-7, owner decision 3]', async () => {
    const s = boot({ app: IN_ROOM });
    // The claim account.ts takes before a same-tab Google login.
    const releaseLogin = claimUnloadExemption('account-login');
    expect(s.beforeunloadPrompts()).toBe(false);

    scheduleSessionReset(MSG_LEAVING, vi.fn());
    await advance(PAINT_MS + COMMIT_DEADLINE_MS);

    // Until C6-7 every recovery cleared the one shared flag (true here), so
    // closing the tab during a slow login navigation asked to confirm. The
    // reset now releases only its own claim.
    expect(isSessionResetPending()).toBe(false);
    expect(s.beforeunloadPrompts()).toBe(false);
    releaseLogin();
    expect(s.beforeunloadPrompts()).toBe(true);
  });

  it('marks the reset exemption at action start, not when the reset is scheduled [keeps: C6-7]', async () => {
    const s = boot({ app: IN_ROOM });
    scheduleSessionReset(MSG_LEAVING, vi.fn());
    expect(s.beforeunloadPrompts()).toBe(true);
    await advance(PAINT_MS);
    expect(s.beforeunloadPrompts()).toBe(false);
  });
});

describe('(f) the logo hard reset inside the commit deadline', () => {
  it('navigates home after an observed activation and records the completion marker [keeps: C6-8, C6-10]', async () => {
    const s = boot({ app: IN_ROOM });
    const sw = installServiceWorkerFake();
    s.addCleanup(() => sw.restore());

    s.logoHardReset();
    await advance(PAINT_MS);
    expect(sw.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    await advance(300);
    sw.activate();
    await advance(0);

    expect(s.sinks.calls).toEqual([expect.objectContaining({ op: 'replace', url: '/' })]);
    expect(sessionStorage.getItem('mxqr-swu')).toBe('Update applied');
    s.pagehide(false);
    await advance(COMMIT_DEADLINE_MS);
    expect(isSessionResetPending()).toBe(true);
  });

  it('navigates home after the bounded 1.5 s wait when activation stalls [keeps: C6-8]', async () => {
    const s = boot({ app: IN_ROOM });
    const sw = installServiceWorkerFake();
    s.addCleanup(() => sw.restore());

    s.logoHardReset();
    await advance(PAINT_MS + HARD_RESET_ACTIVATION_MS - 1);
    expect(s.sinks.count('replace')).toBe(0);
    await advance(1);
    expect(s.sinks.count('replace')).toBe(1);
    expect(isSessionResetPending()).toBe(true);
    expect(sessionStorage.getItem('mxqr-swu')).toBeNull();
  });

  // Until C6-8 the 2 s commit deadline started with the action, so it also
  // counted the chunk load and the promotion wait: here it fired at
  // PAINT + 2000, the page came back interactive, the logo's own latch
  // dropped the navigation, and the logo never reached home. Owner decision 2
  // starts the deadline at the final navigation call; the bounded prepare
  // window navigates home either way.
  it('reaches home once when a slow chunk load plus the activation wait passes 2 s [flipped: C6-8, owner decision 2]', async () => {
    const s = boot({ app: IN_ROOM });
    const sw = installServiceWorkerFake();
    s.addCleanup(() => sw.restore());

    s.logoHardReset({ importDelayMs: 600 });
    await advance(PAINT_MS + 600);
    expect(sw.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

    // Past the old deadline the page is still held, preparing.
    await advance(COMMIT_DEADLINE_MS - 600);
    expect(isSessionResetPending()).toBe(true);
    expect(overlay().hidden).toBe(false);
    expect(s.sinks.count('replace')).toBe(0);

    // The worker activates during the rest of the 1.5 s wait: the marker is
    // written and the logo navigates home.
    sw.activate();
    await advance(0);
    expect(s.sinks.calls).toEqual([expect.objectContaining({ op: 'replace', url: '/' })]);
    expect(sessionStorage.getItem('mxqr-swu')).toBe('Update applied');
    s.leaveDocument(false);
    await advance(COMMIT_DEADLINE_MS + 10_000);
    expect(isSessionResetPending()).toBe(true);
    expect(s.sinks.count('replace')).toBe(1);
  });

  it('reaches home after the chunk load and the bounded 1.5 s wait when activation stalls past 2 s [added: C6-8, owner decision 2]', async () => {
    const s = boot({ app: IN_ROOM });
    const sw = installServiceWorkerFake();
    s.addCleanup(() => sw.restore());

    s.logoHardReset({ importDelayMs: 600 });
    await advance(PAINT_MS + 600 + HARD_RESET_ACTIVATION_MS - 1);
    expect(s.sinks.count('replace')).toBe(0);
    await advance(1);
    expect(s.sinks.count('replace')).toBe(1);
    expect(isSessionResetPending()).toBe(true);
    expect(sessionStorage.getItem('mxqr-swu')).toBeNull();
  });

  // player-controls.test.ts:628 pinned the latch this replaced with a mocked
  // owner; C6-8 retired that test and the logo's resetCurrent.
  // Owner decision 13 keeps the prepare window at 2.5 s.
  it('navigates home at the prepare deadline when the chunk lands later, which then posts no SKIP_WAITING [flipped: C6-8, owner decisions 2, 13]', async () => {
    const s = boot({ app: IN_ROOM });
    const sw = installServiceWorkerFake();
    s.addCleanup(() => sw.restore());
    const lateMs = 500;

    s.logoHardReset({ importDelayMs: PREPARE_DEADLINE_MS + lateMs });
    await advance(PAINT_MS + PREPARE_DEADLINE_MS - 1);
    expect(isSessionResetPending()).toBe(true);
    expect(s.sinks.count('replace')).toBe(0);
    await advance(1);
    // Until C6-8 the deadline recovered the page at PAINT + 2000 and the
    // logo's latch skipped both steps: it navigated nowhere.
    expect(s.sinks.calls).toEqual([expect.objectContaining({ op: 'replace', url: '/' })]);
    expect(isSessionResetPending()).toBe(true);

    // The chunk lands after the prepare window closed: its aborted signal
    // keeps it from promoting the worker under the departing page.
    await advance(lateMs + HARD_RESET_ACTIVATION_MS + 10_000);
    expect(sw.getRegistration).not.toHaveBeenCalled();
    expect(sw.waiting.postMessage).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('mxqr-swu')).toBeNull();
    // This replace was a no-op, so the commit deadline recovered the page.
    expect(isSessionResetPending()).toBe(false);
    expect(s.sinks.count('replace')).toBe(1);
  });

  it('drops the hard reset and the navigation when the page returns from the cache during the chunk load [keeps: C6-8]', async () => {
    const s = boot({ app: IN_ROOM });
    const sw = installServiceWorkerFake();
    s.addCleanup(() => sw.restore());
    const importDelayMs = 600;

    s.logoHardReset({ importDelayMs });
    await advance(PAINT_MS);
    // Another navigation wins during the chunk load and the page returns.
    s.leaveDocument(true);
    s.returnFromBfcache('pageshow-first');
    // page-lifecycle restored the logo's reset, which recovers the logo
    // action, and now owns one fresh reload.
    expect(s.resetMessage()).toBe(MSG_REFRESHING);

    // The chunk lands while that fresh reload is pending; the stale logo
    // action neither promotes the worker nor navigates under it.
    await advance(importDelayMs);
    expect(isSessionResetPending()).toBe(true);
    expect(s.sinks.calls).toEqual([expect.objectContaining({ op: 'reload' })]);
    await advance(HARD_RESET_ACTIVATION_MS + COMMIT_DEADLINE_MS);
    expect(sw.getRegistration).not.toHaveBeenCalled();
    expect(sw.waiting.postMessage).not.toHaveBeenCalled();
    expect(s.sinks.count('replace')).toBe(0);
    expect(s.sinks.count('reload')).toBe(1);
    expect(sessionStorage.getItem('mxqr-swu')).toBeNull();
  });
});

describe('(g) a window that opens during a pending reset', () => {
  it('keeps the reset surface exposed and focused, then hands top and focus to the window [flipped: 9.0.1 G4] [kept: C6-11, owner decision 4]', async () => {
    const s = boot({ app: IN_ROOM });
    s.element('control').focus();
    scheduleDocumentReload(MSG_REFRESHING);
    const dialog = s.element('dialog-overlay');
    // The reset claims `inert` only (session-reset.ts:154): the shell gets no
    // aria-hidden from it, which the pre-G4 claim wrote.
    expect(s.element('tab-play').inert).toBe(true);
    expect(s.element('tab-play').hasAttribute('aria-hidden')).toBe(false);

    s.openDialog();

    // The design's pin (g) predates 9.0.1: dom.ts:629 no longer locks the
    // overlay, and only `inert` is claimed by the reset.
    expect(overlay().hasAttribute('inert')).toBe(false);
    expect(overlay().getAttribute('aria-hidden')).toBe('false');
    expect(document.activeElement).toBe(overlay());
    expect(dialog.inert).toBe(true);

    await advance(PAINT_MS + COMMIT_DEADLINE_MS);
    expect(dialog.inert).toBe(false);
    expect(s.element('tab-play').inert).toBe(true);
    expect(document.activeElement?.id).toBe('btn-dialog-ok');
  });

  // Until C6-11 the reset overlay stayed a body child, which the browser
  // paints beneath the fullscreen top layer whatever its z-index, while
  // dom.ts moved the dialog into the fullscreen element: the dialog showed
  // above an invisible reset screen, with the rest of the page inert. Owner
  // decision 4 keeps the reset screen on top; the reset moves its surface
  // into the fullscreen element and exits nothing (confirmed by owner
  // decision 13).
  it('keeps the reset surface on top of a fullscreen player, with the window underneath and inert, and moves it back on recovery [flipped: C6-11, owner decisions 4, 13]', async () => {
    const s = boot({ app: IN_ROOM });
    const wrapper = s.element('video-wrapper');
    const fullscreen = enterFullscreen(wrapper);
    s.addCleanup(() => fullscreen.restore());
    s.element('video-control').focus();
    scheduleDocumentReload(MSG_REFRESHING);
    const dialog = s.element('dialog-overlay');

    expect(overlay().parentElement).toBe(wrapper);
    expect(overlay().closest('[inert]')).toBeNull();
    // Locked around the surface: the fullscreen player's other controls and
    // every element outside the player's path.
    expect(s.element('video-control').inert).toBe(true);
    expect(s.element('control').inert).toBe(true);
    expect(s.element('main-header').inert).toBe(true);
    expect(s.element('tab-play').inert).not.toBe(true);

    s.openDialog();

    // dom.ts portals the dialog into the fullscreen element too, after the
    // surface, whose z-index is the maximum; the dialog stays inert under it.
    expect(wrapper.contains(dialog)).toBe(true);
    expect(dialog.closest('[inert]')).not.toBeNull();
    expect(overlay().closest('[inert]')).toBeNull();
    expect(overlay().getAttribute('aria-hidden')).toBe('false');
    expect(document.activeElement).toBe(overlay());
    expect(fullscreen.exitFullscreen).not.toHaveBeenCalled();

    // The reload's no-op recovers: the surface goes home hidden and the
    // dialog becomes the top window, inside the fullscreen player.
    await advance(PAINT_MS + COMMIT_DEADLINE_MS);
    expect(overlay().parentElement).toBe(document.body);
    expect(overlay().hidden).toBe(true);
    expect(dialog.inert).toBe(false);
    expect(wrapper.contains(dialog)).toBe(true);
    expect(document.activeElement?.id).toBe('btn-dialog-ok');
  });

  it('moves the reset surface back to the page and locks the player when fullscreen ends under a pending reset [added: C6-11]', () => {
    const s = boot({ app: IN_ROOM });
    const wrapper = s.element('video-wrapper');
    const fullscreen = enterFullscreen(wrapper);
    scheduleDocumentReload(MSG_REFRESHING);
    expect(overlay().parentElement).toBe(wrapper);

    // The browser or the user (Escape) ends fullscreen while the page is held.
    fullscreen.restore();
    document.dispatchEvent(new Event('fullscreenchange'));

    expect(overlay().parentElement).toBe(document.body);
    expect(overlay().closest('[inert]')).toBeNull();
    expect(s.element('tab-play').inert).toBe(true);
    expect(s.element('main-header').inert).toBe(true);
    expect(document.activeElement).toBe(overlay());
    expect(isSessionResetPending()).toBe(true);
  });
});

describe('(h) Back taken while a reset is pending', () => {
  // Until C6-12 (owner decision 5, reversing the 2026-10-17 text that only a
  // confirmed leave re-pushes the guard) nothing re-armed the guard after a
  // recovered navigation: the next Back left a live room without the in-app
  // confirmation, and a window that opened during the reset was unreachable.
  it('is absorbed, and the guard re-arms when the deadline recovers, so the next Back asks to leave [flipped: C6-12, owner decision 5]', async () => {
    const s = boot({ app: IN_ROOM });
    await advance(GUARD_ARM_MS);
    scheduleDocumentReload(MSG_REFRESHING);
    await advance(PAINT_MS);

    s.history.pressBack();
    expect(s.leaveConfirmation.requests).toBe(0);
    expect(s.history.marker()).toBe('base');

    await advance(COMMIT_DEADLINE_MS);
    expect(isSessionResetPending()).toBe(false);
    await advance(1_000);
    // The release handler still notifies the guard while the reset reports
    // pending (the settle-order pin); the owner's pending-change event after
    // settle re-arms it.
    expect(s.history.marker()).toBe('guard');
    expect(s.history.pushes).toHaveLength(2);

    s.history.pressBack();
    await advance(0);
    expect(s.history.departures).toEqual([]);
    expect(s.leaveConfirmation.requests).toBe(1);
  });

  it('lets Back reach a window that opened during the reset once the guard re-arms [flipped: C6-12, owner decision 5]', async () => {
    const s = boot({ app: IN_ROOM });
    await advance(GUARD_ARM_MS);
    scheduleDocumentReload(MSG_REFRESHING);
    await advance(PAINT_MS);
    s.history.pressBack();

    s.openDialog({ closeOnBack: true });
    await advance(COMMIT_DEADLINE_MS + GUARD_ARM_MS);
    expect(s.history.marker()).toBe('guard');

    s.history.pressBack();
    await advance(0);
    expect(s.history.departures).toEqual([]);
    expect(s.element('dialog-overlay').classList.contains('show')).toBe(false);
  });

  it('does not re-arm while a reload queued behind the recovered one holds the page [added: C6-12]', async () => {
    const s = boot({ app: IN_ROOM });
    await advance(GUARD_ARM_MS);
    scheduleDocumentReload('First reload');
    await advance(PAINT_MS);
    s.history.pressBack();
    scheduleDocumentReload('Second reload');

    // The first reload recovers and settle starts the queued one at once: the
    // page never reports idle in between, so the guard stays unarmed.
    await advance(COMMIT_DEADLINE_MS + GUARD_ARM_MS);
    expect(isSessionResetPending()).toBe(true);
    expect(s.resetMessage()).toBe('Second reload');
    expect(s.history.marker()).toBe('base');

    await advance(PAINT_MS + COMMIT_DEADLINE_MS + GUARD_ARM_MS);
    expect(isSessionResetPending()).toBe(false);
    expect(s.history.marker()).toBe('guard');
    expect(s.history.pushes).toHaveLength(2);
  });

  it('re-arms after a stalled confirmed leave through its own recovery wiring when a window still needs Back [keeps: C6-12]', async () => {
    // No previous document: the leave's traversal is a no-op at the stack edge.
    const s = boot({ app: IN_ROOM, previousDocument: false });
    await advance(GUARD_ARM_MS);

    s.history.pressBack();
    await advance(0);
    expect(s.resetMessage()).toBe(MSG_LEAVING);
    await advance(PAINT_MS);
    expect(s.leaveSession).toHaveBeenCalledOnce();
    s.openDialog({ closeOnBack: true });

    await advance(LEAVE_FALLBACK_MS);
    // back-button-history.ts:133-135: the 1 s fallback navigates home, a no-op here.
    expect(s.sinks.calls).toEqual([expect.objectContaining({ op: 'replace', url: '/' })]);
    await advance(COMMIT_DEADLINE_MS - LEAVE_FALLBACK_MS);
    expect(isSessionResetPending()).toBe(false);

    await advance(GUARD_ARM_MS);
    expect(s.history.marker()).toBe('guard');
    s.history.pressBack();
    await advance(0);
    expect(s.element('dialog-overlay').classList.contains('show')).toBe(false);
    expect(s.history.departures).toEqual([]);
  });
});

describe('the PRO claim fence at the scheduleDocumentReload boundary', () => {
  // C6-5 moved the reload queue into the owner; document-reload.ts keeps only
  // this fence. claim-reload-recovery.test.ts pins the same three purposes.
  it.each(CLAIM_KEYS)(
    'restores the %s fragment only while the reload sink runs and scrubs it after recovery, each attempt [keeps: C6-5]',
    async (key) => {
      const s = boot({ app: IN_ROOM });
      takeClaim(key);

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        scheduleDocumentReload(MSG_REFRESHING);
        expect(location.hash).toBe('');
        await advance(PAINT_MS);
        expect(s.sinks.calls.at(-1)?.hrefAtCall).toBe(
          `http://localhost:3000${ROOM_PATH}?lang=ko#${key}=${CLAIM}`,
        );
        await advance(COMMIT_DEADLINE_MS);
        expect(location.href).toBe(`http://localhost:3000${ROOM_PATH}?lang=ko`);
      }
      expect(sessionStorage.length).toBe(0);
      expect(localStorage.length).toBe(0);
    },
  );

  it('restores a trailing-slash room path canonically for the sink and puts the slash back on recovery [keeps: C6-5]', async () => {
    const s = boot({ app: IN_ROOM });
    takeClaim('pro-claim', `${ROOM_PATH}/`);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      scheduleDocumentReload(MSG_REFRESHING);
      await advance(PAINT_MS);
      // claim-fragment.ts:182 restores /CODE without the slash.
      expect(s.sinks.calls.at(-1)?.hrefAtCall).toBe(
        `http://localhost:3000${ROOM_PATH}?lang=ko#pro-claim=${CLAIM}`,
      );
      await advance(COMMIT_DEADLINE_MS);
      expect(location.href).toBe(`http://localhost:3000${ROOM_PATH}/?lang=ko`);
    }
  });

  it('does not let a stale fence facade release its successor [keeps: C6-5]', async () => {
    const s = boot({ app: IN_ROOM });
    takeClaim('pro-claim');
    const stale = capturePendingClaimReloadGuard();
    // A second claim link replaces the first.
    takeClaim('pro-recovery');

    // The fence ignores a facade whose guard is no longer current.
    stale?.release();
    scheduleDocumentReload(MSG_REFRESHING);
    await advance(PAINT_MS);

    expect(s.sinks.calls.at(-1)?.hrefAtCall).toBe(
      `http://localhost:3000${ROOM_PATH}?lang=ko#pro-recovery=${CLAIM}`,
    );
    await advance(COMMIT_DEADLINE_MS);
    expect(location.hash).toBe('');
  });

  it('scrubs at once when the claim flow releases during an in-flight reload, and runs a queued reload only after recovery [keeps: C6-5]', async () => {
    const s = boot({ app: IN_ROOM });
    takeClaim();
    scheduleDocumentReload(MSG_REFRESHING);
    await advance(PAINT_MS);
    expect(location.hash).toBe(`#pro-claim=${CLAIM}`);
    scheduleDocumentReload('Queued reload');

    capturePendingClaimReloadGuard()?.release();

    // The fence rolls back the in-flight reload's claim while the reset still
    // holds the page.
    expect(location.hash).toBe('');
    expect(isSessionResetPending()).toBe(true);
    expect(s.resetMessage()).toBe(MSG_REFRESHING);

    await advance(COMMIT_DEADLINE_MS);
    expect(s.resetMessage()).toBe('Queued reload');
    await advance(PAINT_MS);
    expect(s.sinks.calls.at(-1)?.hrefAtCall).toBe(`http://localhost:3000${ROOM_PATH}?lang=ko`);
  });

  it('rolls back a predecessor claim at once when a successor registers during the reload [keeps: C6-5]', async () => {
    const s = boot({ app: IN_ROOM });
    const ops: string[] = [];
    registerPendingClaimReloadPreparation(() => {
      ops.push('prepare predecessor');
      return () => ops.push('rollback predecessor');
    });
    scheduleDocumentReload(MSG_REFRESHING);
    await advance(PAINT_MS);

    registerPendingClaimReloadPreparation(() => {
      ops.push('prepare successor');
      return () => ops.push('rollback successor');
    });
    // The fence rolls the in-flight reload's predecessor claim back at once.
    expect(ops).toEqual(['prepare predecessor', 'rollback predecessor']);

    await advance(COMMIT_DEADLINE_MS);
    scheduleDocumentReload(MSG_REFRESHING);
    await advance(PAINT_MS + COMMIT_DEADLINE_MS);
    expect(ops).toEqual([
      'prepare predecessor',
      'rollback predecessor',
      'prepare successor',
      'rollback successor',
    ]);
    expect(s.sinks.count('reload')).toBe(2);
  });

  it('holds an outcome-unknown mutation until the in-flight reload recovers, then queues reloads without an overlay [keeps: C6-5]', async () => {
    const s = boot({ app: IN_ROOM });
    takeClaim();
    scheduleDocumentReload(MSG_REFRESHING);
    await advance(PAINT_MS);
    const fence = capturePendingClaimReloadGuard();
    expect(fence).not.toBeNull();
    let fenced = false;
    const fencing = fence!.fenceOutcomeUnknownMutation().then(() => {
      fenced = true;
    });

    await advance(COMMIT_DEADLINE_MS - 1);
    expect(fenced).toBe(false);
    // Asserted after the clock moves, before any await: a fence that never
    // opens fails here instead of timing the test out.
    await advance(1);
    expect(fenced).toBe(true);
    await fencing;

    scheduleDocumentReload('Fenced reload');
    expect(isSessionResetPending()).toBe(false);
    await advance(10_000);
    expect(s.sinks.count('reload')).toBe(1);
  });

  // Until C6-5 the fenced reload, released while the leave held the page, met
  // the busy rule and was dropped as recovered at once (no reload ever ran).
  it('lets a leave navigation through a deferred fence, and runs the fenced reload if that leave recovers [keeps: C6-5] [flipped: C6-5, owner decision 1]', async () => {
    const s = boot({ app: IN_ROOM });
    takeClaim();
    const fence = capturePendingClaimReloadGuard();
    await fence?.fenceOutcomeUnknownMutation();
    const fencedRecovered = vi.fn();
    scheduleDocumentReload(MSG_REFRESHING, fencedRecovered);
    expect(isSessionResetPending()).toBe(false);

    // A leave (scheduleSessionReset) never enters the fence.
    scheduleSessionReset(MSG_LEAVING, () => navigateToAppHome());
    expect(isSessionResetPending()).toBe(true);

    fence?.restoreAfterLazyFeatureFailure();
    expect(fencedRecovered).not.toHaveBeenCalled();
    expect(s.resetMessage()).toBe(MSG_LEAVING);
    await advance(PAINT_MS + COMMIT_DEADLINE_MS);
    expect(s.sinks.count('replace')).toBe(1);
    expect(s.resetMessage()).toBe(MSG_REFRESHING);

    await advance(PAINT_MS);
    // The claim is restored only while the reload sink runs.
    expect(s.sinks.calls.at(-1)).toMatchObject({
      op: 'reload',
      hrefAtCall: `http://localhost:3000${ROOM_PATH}?lang=ko#pro-claim=${CLAIM}`,
    });
    await advance(COMMIT_DEADLINE_MS);
    expect(fencedRecovered).toHaveBeenCalledOnce();
    expect(location.hash).toBe('');
    await advance(10_000);
    expect(s.sinks.count('reload')).toBe(1);
  });
});
