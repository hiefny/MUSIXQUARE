/**
 * @vitest-environment jsdom
 *
 * C6-2 owner-boundary characterization of the page navigation shell
 * (structural plan increment C6-2, Phase 0c, built just in time for Phase 2).
 *
 * Registry records (docs/design/resource-ownership-registry.md):
 * - RO-23 App-owned page navigation: the session reset, the document-reload
 *   queue and claim fence joined by scheduleDocumentReload, the unload
 *   exemption, and the back-forward cache retry in page-lifecycle.
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
 * Every test pins today's behaviour on main 51ab2be3 (9.0.3). A test name ends
 * with labels naming the increment that changes it, or that must keep it:
 * - "[flips: C6-n]": increment n is planned to change this; its new
 *   expectation is in the comment above the assertion it replaces.
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
 * Pins read the unload exemption at its boundary, a dispatched beforeunload
 * (`beforeunloadPrompts`), not page-lifecycle's internal flag, so C6-7's
 * claims keep every pin except the ones it flips.
 * Increments: C6-4 owner state and settle, C6-5 reload queue into the owner,
 * C6-6 one page-transition dispatch, C6-7 unload-exemption claims, C6-8
 * prepare/navigate split, C6-10 hard reset asks the update machine, C6-11
 * reset surface on top (with the fullscreen top-layer fix), C6-12 Back guard
 * re-arm, C6-13 duplicate latches deleted.
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
import { markIntentionalNav } from '../page-lifecycle.ts';
import {
  isSessionResetPending,
  restoreSessionReset,
  scheduleDocumentReload,
  scheduleSessionReset,
} from '../session-reset.ts';
import { navigateToAppHome } from '../navigation.ts';
import { LEAVE_FALLBACK_MS, NAVIGATION_COMMIT_TIMEOUT_MS } from '../navigation-contract.ts';
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
  it('settles at once through onRecovered and is never retried [keeps: C6-4, C6-5] [owner decision: reload busy rule]', async () => {
    const s = boot({ app: IN_ROOM });
    const leave = vi.fn();
    scheduleSessionReset(MSG_LEAVING, leave);
    let pendingWhenSettled: boolean | null = null;
    const onRecovered = vi.fn(() => {
      pendingWhenSettled = isSessionResetPending();
    });

    scheduleDocumentReload(MSG_REFRESHING, onRecovered);

    // The bridge reports the dropped reload as recovered synchronously, while
    // the winning reset still holds the page (session-reset.ts:342-345).
    expect(onRecovered).toHaveBeenCalledOnce();
    expect(pendingWhenSettled).toBe(true);
    expect(s.resetMessage()).toBe(MSG_LEAVING);

    await advance(PAINT_MS);
    expect(leave).toHaveBeenCalledOnce();
    expect(s.sinks.count('reload')).toBe(0);

    // The winning navigation is a no-op and recovers; nothing replays the reload.
    await advance(COMMIT_DEADLINE_MS);
    expect(isSessionResetPending()).toBe(false);
    await advance(10_000);
    expect(s.sinks.count('reload')).toBe(0);
    expect(isSessionResetPending()).toBe(false);
    expect(overlay().hidden).toBe(true);
    expect(onRecovered).toHaveBeenCalledOnce();
  });

  it('reports a lazy-feature recovery reload as returned at once and releases its prompt latch [keeps: C6-4, C6-5, C6-13] [owner decision: reload busy rule]', async () => {
    const s = boot({ app: IN_ROOM });
    scheduleSessionReset(MSG_LEAVING, vi.fn());

    s.requestLazyFeatureRecovery('connect');
    await advance(0);

    // app.ts:1081-1089: the same-document return path, a toast, not a loop.
    expect(s.lazyFeature.events).toEqual(['prompt', 'recovered:connect']);
    await advance(PAINT_MS + COMMIT_DEADLINE_MS);
    expect(s.sinks.count('reload')).toBe(0);

    // The latch is free again: a later failure prompts and now reloads.
    s.requestLazyFeatureRecovery('connect');
    await advance(PAINT_MS);
    expect(s.lazyFeature.events).toEqual(['prompt', 'recovered:connect', 'prompt']);
    expect(s.sinks.count('reload')).toBe(1);
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
    // document-reload.ts:61 flushes the queue inside recoverAttempt, before
    // the bridge's onRecovered (session-reset.ts:335-341).
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
    // Two entries wait in the queue at once (document-reload.ts:154).
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
  // Coupled to (h): flipping this order so the reset reports idle before the
  // window release lets the Back guard re-arm there, which flips (h) too.
  it('releases the windows while still pending, then reports idle with the exemption already cleared [keeps: C6-4] [owner decision / C6-12: keep or flip]', async () => {
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
    // per-attempt callbacks run. C6-4 kept this order. C6-12 (owner decision 5:
    // the guard re-arms after a recovered navigation) either flips it, so the
    // reset reports idle before the window release and the Back guard re-arms
    // there, or re-arms the guard from the pending-change event; either way it
    // flips pin (h).
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

describe('the explicit restore: an action that restores its own reset', () => {
  // The pro-room/runtime.ts:3000-3006 and :3026-3033 shape: the action checks
  // that the terminal recovery owner is still current and, when it is not,
  // calls restoreSessionReset() itself instead of navigating. C6-4 routed this
  // explicit restore through settle(); it stays the attempt's only settle, with
  // no navigating phase or second settle after the action returns. C6-8
  // replaces the shape with isCurrent(), where false at navigate restores the
  // page once.
  function scheduleOwnerCheckedReset(ownerIsCurrent: boolean, events: string[]): void {
    scheduleSessionReset(MSG_LEAVING, () => {
      if (!ownerIsCurrent) {
        restoreSessionReset();
        events.push('action returned');
        return;
      }
      navigateToAppHome();
    })?.onRecovered(() => events.push(`recovered: pending=${isSessionResetPending()}`));
  }

  it('settles once inside the action when the owner is stale, navigates nowhere, and accepts a later request [keeps: C6-4] [replaced by isCurrent: C6-8]', async () => {
    const s = boot({ app: IN_ROOM });
    const events: string[] = [];
    scheduleOwnerCheckedReset(false, events);
    expect(isSessionResetPending()).toBe(true);

    await advance(PAINT_MS);

    expect(events).toEqual(['recovered: pending=false', 'action returned']);
    expect(isSessionResetPending()).toBe(false);
    expect(overlay().hidden).toBe(true);
    expect(s.element('tab-play').inert).toBe(false);
    expect(s.beforeunloadPrompts()).toBe(true);

    // runOnce still arms the commit deadline after the action returns
    // (session-reset.ts:297-301); its _activeAttempt check makes it a no-op.
    await advance(COMMIT_DEADLINE_MS + 10_000);
    expect(events).toHaveLength(2);
    expect(isSessionResetPending()).toBe(false);
    expect(s.sinks.calls).toEqual([]);

    scheduleDocumentReload(MSG_REFRESHING);
    expect(isSessionResetPending()).toBe(true);
    await advance(PAINT_MS);
    expect(s.sinks.count('reload')).toBe(1);
  });

  it("does not let the stale attempt's commit deadline settle a reset accepted right after it [keeps: C6-4] [replaced by isCurrent: C6-8]", async () => {
    const s = boot({ app: IN_ROOM });
    scheduleOwnerCheckedReset(false, []);
    await advance(PAINT_MS);
    const successorRecovered = vi.fn();
    scheduleSessionReset('Successor', () => navigateToAppHome())?.onRecovered(successorRecovered);
    expect(isSessionResetPending()).toBe(true);

    // The stale deadline falls 2 s after the stale action; the successor's
    // falls one paint later.
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
    expect(events).toEqual([]);
  });

  // A variant of (h): Back absorbed while the reset is pending.
  it('leaves the Back guard unarmed when Back was absorbed before a stale owner restored the reset [flips: C6-12, owner reversal]', async () => {
    const s = boot({ app: IN_ROOM });
    await advance(GUARD_ARM_MS);
    expect(s.history.marker()).toBe('guard');
    scheduleOwnerCheckedReset(false, []);
    s.history.pressBack();
    expect(s.history.marker()).toBe('base');
    expect(s.leaveConfirmation.requests).toBe(0);

    await advance(PAINT_MS + GUARD_ARM_MS + 1_000);
    expect(isSessionResetPending()).toBe(false);
    // Flips in C6-12: the guard re-arms when the navigation settles, so the
    // marker is 'guard' and a second push is recorded.
    expect(s.history.marker()).toBe('base');
    expect(s.history.pushes).toHaveLength(1);
  });
});

describe('the failed exit: the navigation action throws', () => {
  const ACTION_FAILED = '[SessionReset] Hard-navigation action failed:';

  // A third branch of the reload busy rule, beside (a) and (b).
  // document-reload.ts:84-86 recovers the attempt and flushes the queue while
  // the reset still holds the page, so the queued reload meets the busy rule
  // (session-reset.ts:342-345) and is dropped as recovered; then the reset's
  // catch releases the page. C6-4 routed the throw through settle('failed').
  // With the critique's target order (commit the
  // state, flush the queue, then callbacks) the queued reload would run
  // instead: that is the owner's busy-rule decision, not a silent C6-5 change.
  it('releases the page at once and drops a reload queued behind it as recovered, before the failing caller hears [keeps: C6-4, C6-5] [owner decision: reload busy rule]', async () => {
    const s = boot({ app: IN_ROOM });
    const failure = new Error('reload rejected');
    s.sinks.reload.mockImplementationOnce(() => {
      throw failure;
    });
    const settled: string[] = [];
    scheduleDocumentReload('First', () =>
      settled.push(`first: pending=${isSessionResetPending()} prompts=${s.beforeunloadPrompts()}`),
    );
    scheduleDocumentReload('Second', () =>
      settled.push(`second: pending=${isSessionResetPending()}`),
    );

    await advance(PAINT_MS);

    expect(settled).toEqual(['second: pending=true', 'first: pending=false prompts=true']);
    expect(s.sinks.reload).toHaveBeenCalledOnce();
    expect(isSessionResetPending()).toBe(false);
    expect(overlay().hidden).toBe(true);
    expect(s.element('tab-play').inert).toBe(false);
    expect(s.beforeunloadPrompts()).toBe(true);
    expect(s.console.error).toHaveBeenCalledWith(ACTION_FAILED, failure);

    // Nothing replays the dropped reload, and the deadline never ran.
    await advance(COMMIT_DEADLINE_MS + 10_000);
    expect(s.sinks.reload).toHaveBeenCalledOnce();
    expect(settled).toHaveLength(2);
  });

  it('releases the page at once without a sink call when the claim preparation rejects a changed URL [keeps: C6-4, C6-5]', async () => {
    const s = boot({ app: IN_ROOM });
    takeClaim();
    // Something wrote a fragment after the claim was taken.
    window.history.replaceState(null, '', `${ROOM_PATH}?lang=ko#stray`);
    const recovered = vi.fn();
    scheduleDocumentReload(MSG_REFRESHING, recovered);

    await advance(PAINT_MS);

    // claim-fragment.ts:188-190 throws inside attempt.navigate, before the sink.
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
  it('restores the shell and makes exactly one fresh reload; a second return does not loop [keeps: C6-6] [flips: C6-7]', async () => {
    const s = boot({ app: IN_ROOM });
    scheduleDocumentReload(MSG_REFRESHING);
    await advance(PAINT_MS);
    expect(s.sinks.count('reload')).toBe(1);
    s.leaveDocument(true);

    document.body.classList.remove('fouc-loaded');
    s.returnFromBfcache('pageshow-first');

    // page-lifecycle.ts:166-207: reveal, restore the stale reset, mark the
    // exemption, then one fresh reload through the owner.
    expect(document.body.classList.contains('fouc-loaded')).toBe(true);
    expect(isSessionResetPending()).toBe(true);
    expect(s.resetMessage()).toBe(MSG_REFRESHING);
    // The pre-mark at page-lifecycle.ts:201, before the fresh reload's action.
    // Flips in C6-7: the pre-mark is deleted, so the page asks to confirm an
    // unload until the action starts (true here).
    expect(s.beforeunloadPrompts()).toBe(false);
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
  // iOS is a device check). The reset's capture-phase visibility listener
  // (session-reset.ts:279) restores first when visibility leads, and
  // page-lifecycle then sees no pending reset (page-lifecycle.ts:169-170).
  // A flip in C6-6 would come from one handler deciding on "pending at
  // return": the visible-first row outside a room would then reload too.
  // The departure itself settles nothing: pagehide commits the reset and the
  // visibilitychange(hidden) after it restores nothing.
  it.each([
    ['pageshow-first', 'outside a room', 1, OUTSIDE_ROOM, true],
    ['visible-first', 'outside a room', 0, OUTSIDE_ROOM, false],
    ['pageshow-first', 'in a room', 1, IN_ROOM, true],
    ['visible-first', 'in a room', 1, IN_ROOM, true],
  ] as const)(
    '%s return %s: %i fresh reload(s) [owner decision / C6-6: keep or flip]',
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

  // Listener phases: the reset's visibility listener is a capture listener on
  // document (session-reset.ts:279), the guard's is a bubble listener
  // (app.ts:984-987), and page-lifecycle's pageshow listener (app.ts:1305)
  // precedes the guard's resume (app.ts:983). With a window open outside a
  // room, a guard is needed, so the order decides whether one is armed.
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
    'a %s return of a pending reset with a window open arms the Back guard: %s, and still after the fresh reload recovers [owner decision / C6-6: keep or flip] [flips: C6-12 for the pageshow orders]',
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
      // The release notifies the guard while the reset still reports pending
      // (the settle-order pin), so nothing arms it.
      await advance(PAINT_MS + COMMIT_DEADLINE_MS + GUARD_ARM_MS);
      expect(isSessionResetPending()).toBe(false);
      // Flips in C6-12 for the pageshow orders: the guard re-arms when the
      // fresh reload settles, so the marker is 'guard' on every row.
      expect(s.history.marker()).toBe(armed ? 'guard' : 'base');
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

  it.each(['pageshow-first', 'visible-first', 'pageshow-only'] as const)(
    're-arms the Back guard in a room only on the second %s return, after the bounded reload stops [keeps: C6-6, C6-12]',
    async (order) => {
      const s = boot({ app: IN_ROOM });
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
      // For 'pageshow-only' only the pageshow resume can re-arm: it relies on
      // page-lifecycle's listener (app.ts:1305) running before the guard's
      // resume (app.ts:983), the init order the C6-6 dispatch must keep.
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
  it('marks the unload exemption before the reload is queued and keeps it while queued [flips: C6-7]', async () => {
    const s = boot({ app: IN_ROOM });
    window.history.replaceState(null, '', `${ROOM_PATH}#pro-claim=${CLAIM}`);
    takeProRoomClaimsFromFragment();
    expect(location.hash).toBe('');
    const fence = capturePendingClaimReloadGuard();
    await fence?.fenceOutcomeUnknownMutation();
    expect(s.beforeunloadPrompts()).toBe(true);

    s.leaveDocument(true);
    s.returnFromBfcache('pageshow-first');

    // page-lifecycle.ts:201 marks before deps.reload; document-reload.ts:67
    // queues it behind the deferred fence, so no overlay owns the page.
    expect(isSessionResetPending()).toBe(false);
    expect(overlay().hidden).toBe(true);
    // Flips in C6-7: the owner claims the exemption when the reload starts,
    // so closing the room tab while the reload is queued asks to confirm.
    expect(s.beforeunloadPrompts()).toBe(false);
    await advance(60_000);
    expect(s.beforeunloadPrompts()).toBe(false);
    expect(s.sinks.count('reload')).toBe(0);

    // The claim flow fails before its mutation: the queued reload runs and
    // restores the claim fragment only while the sink runs.
    fence?.restoreAfterLazyFeatureFailure();
    expect(isSessionResetPending()).toBe(true);
    await advance(PAINT_MS);
    expect(s.sinks.calls.at(-1)).toMatchObject({
      op: 'reload',
      hrefAtCall: `http://localhost:3000${ROOM_PATH}#pro-claim=${CLAIM}`,
    });
    await advance(COMMIT_DEADLINE_MS);
    expect(location.hash).toBe('');
    expect(s.beforeunloadPrompts()).toBe(true);
  });
});

describe('(e) the unload exemption is one shared flag', () => {
  it('lets an unrelated reset that recovers clear an exemption another writer set [flips: C6-7]', async () => {
    const s = boot({ app: IN_ROOM });
    // The same export account.ts:694 calls before a same-tab Google login.
    markIntentionalNav();
    expect(s.beforeunloadPrompts()).toBe(false);

    scheduleSessionReset(MSG_LEAVING, vi.fn());
    await advance(PAINT_MS + COMMIT_DEADLINE_MS);

    // session-reset.ts:231 clears the shared flag on every recovery.
    // Flips in C6-7: the login holds its own claim, so this stays false.
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

  it('gives up silently when a slow chunk load plus the activation wait passes the 2 s deadline [flips: C6-8]', async () => {
    const s = boot({ app: IN_ROOM });
    const sw = installServiceWorkerFake();
    s.addCleanup(() => sw.restore());

    s.logoHardReset({ importDelayMs: 600 });
    await advance(PAINT_MS + 600);
    expect(sw.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

    // The deadline started with the action (session-reset.ts:297-301), so it
    // includes the chunk load and the promotion wait.
    await advance(COMMIT_DEADLINE_MS - 600 - 1);
    expect(isSessionResetPending()).toBe(true);
    await advance(1);
    expect(isSessionResetPending()).toBe(false);
    expect(overlay().hidden).toBe(true);

    // The worker activates during the rest of the 1.5 s wait. The marker is
    // still written for this tab's next load (C6-10 ties it to the result),
    // but player-controls' own latch drops the navigation.
    sw.activate();
    await advance(HARD_RESET_ACTIVATION_MS);
    // Flips in C6-8: the deadline starts at navigate and a bounded prepare
    // navigates anyway, so the logo reaches home once.
    expect(s.sinks.count('replace')).toBe(0);
    expect(sessionStorage.getItem('mxqr-swu')).toBe('Update applied');
    expect(isSessionResetPending()).toBe(false);
  });

  // player-controls.test.ts:628 pins this latch with a mocked owner; C6-8
  // retires that test and its resetCurrent.
  it('posts no SKIP_WAITING and navigates nowhere when the chunk lands after the 2 s deadline [flips: C6-8]', async () => {
    const s = boot({ app: IN_ROOM });
    const sw = installServiceWorkerFake();
    s.addCleanup(() => sw.restore());
    const lateMs = 500;

    s.logoHardReset({ importDelayMs: COMMIT_DEADLINE_MS + lateMs });
    await advance(PAINT_MS + COMMIT_DEADLINE_MS);
    expect(isSessionResetPending()).toBe(false);
    expect(overlay().hidden).toBe(true);

    // The chunk lands after the recovery, and the latch skips both steps.
    await advance(lateMs + HARD_RESET_ACTIVATION_MS + 10_000);
    // Flips in C6-8: the deadline starts at navigate and the bounded prepare
    // navigates anyway, so the logo reaches home once. Whether a chunk that
    // lands after that posts SKIP_WAITING is C6-8's abort signal and C6-10's
    // single promotion (no duplicate SKIP_WAITING).
    expect(s.sinks.calls).toEqual([]);
    expect(sw.getRegistration).not.toHaveBeenCalled();
    expect(sw.waiting.postMessage).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('mxqr-swu')).toBeNull();
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
  it('keeps the reset surface exposed and focused, then hands top and focus to the window [flipped: 9.0.1 G4] [keeps: C6-11]', async () => {
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

  it('portals the window into a fullscreen player while the reset overlay stays outside the top layer [flips: C6-11 fullscreen top layer]', () => {
    const s = boot({ app: IN_ROOM });
    const wrapper = s.element('video-wrapper');
    const fullscreen = enterFullscreen(wrapper);
    s.addCleanup(() => fullscreen.restore());
    scheduleDocumentReload(MSG_REFRESHING);
    const dialog = s.element('dialog-overlay');

    s.openDialog();

    // dom.ts:444-466 moves the top dialog into the fullscreen element; the
    // reset overlay stays a body child, which the browser paints beneath the
    // fullscreen top layer whatever its z-index, and nothing exits fullscreen.
    // Flips in C6-11: the reset exits fullscreen or portals its overlay.
    expect(wrapper.contains(dialog)).toBe(true);
    expect(overlay().parentElement).toBe(document.body);
    expect(wrapper.contains(overlay())).toBe(false);
    expect(fullscreen.exitFullscreen).not.toHaveBeenCalled();
    expect(dialog.closest('[inert]')).not.toBeNull();
  });
});

describe('(h) Back taken while a reset is pending', () => {
  it('is absorbed, and nothing re-arms the guard after the deadline recovers, so the next Back leaves the room [flips: C6-12, owner reversal]', async () => {
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
    // The release handler notified the guard while the reset still reported
    // pending (see the settle-order pin), so its arm was refused, and no
    // per-attempt wiring re-arms it (app.ts:965-968 covers only the leave).
    // Flips in C6-12: the guard re-arms when the navigation settles.
    expect(s.history.marker()).toBe('base');
    expect(s.history.pushes).toHaveLength(1);

    s.history.pressBack();
    expect(s.history.departures).toEqual(['back']);
    expect(s.leaveConfirmation.requests).toBe(0);
  });

  it('leaves a window that opened during the reset unreachable by Back [flips: C6-12, owner reversal]', async () => {
    const s = boot({ app: IN_ROOM });
    await advance(GUARD_ARM_MS);
    scheduleDocumentReload(MSG_REFRESHING);
    await advance(PAINT_MS);
    s.history.pressBack();

    s.openDialog({ closeOnBack: true });
    await advance(COMMIT_DEADLINE_MS + GUARD_ARM_MS);
    expect(s.history.marker()).toBe('base');

    s.history.pressBack();
    expect(s.history.departures).toEqual(['back']);
    expect(s.element('dialog-overlay').classList.contains('show')).toBe(true);
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
  // claim-reload-recovery.test.ts pins the same three purposes on the
  // requestDocumentReload attempt API, which C6-5 rewrites.
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
    // A second claim link replaces the first (document-reload.ts:135-141).
    takeClaim('pro-recovery');

    // document-reload.ts:117 ignores a facade whose guard is no longer current.
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

    // document-reload.ts:123 rolls back the active attempt while the reset
    // still holds the page.
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
    // document-reload.ts:140.
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

  it('lets a leave navigation through a deferred fence, and drops the fenced reload as recovered if the fence opens during it [keeps: C6-5] [owner decision: reload busy rule]', async () => {
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
    expect(fencedRecovered).toHaveBeenCalledOnce();
    await advance(PAINT_MS + COMMIT_DEADLINE_MS + 10_000);
    expect(s.sinks.count('replace')).toBe(1);
    expect(s.sinks.count('reload')).toBe(0);
  });
});
