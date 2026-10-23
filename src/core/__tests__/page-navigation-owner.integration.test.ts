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
 * with the increment that changes it, or that must keep it:
 * - "[flips: C6-n]": increment n is planned to change this; its new
 *   expectation is in the comment above the assertion it replaces.
 * - "[keeps: C6-n]": increment n moves this code and must keep the outcome.
 * - "[owner decision]": a decision the plan puts to the owner may change it.
 * Increments: C6-4 owner state and settle, C6-5 reload queue into the owner,
 * C6-6 one page-transition dispatch, C6-7 unload-exemption claims, C6-8
 * prepare/navigate split, C6-10 hard reset asks the update machine, C6-11
 * reset surface on top (with the fullscreen top-layer fix), C6-12 Back guard
 * re-arm.
 *
 * Not covered here: jsdom has no real back-forward cache, top layer, unload or
 * native timing. e2e/back-navigation.test.ts (Chromium launches with the
 * back-forward cache disabled, and the WebKit lane) is the browser evidence;
 * the real-bfcache paths have only these jsdom pins and device checks. The
 * update machine (sw-register.ts) is pinned against the real reset in
 * sw-register-recovery.integration.test.ts; account.ts's own anchor and
 * 10-minute TTL in account.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  capturePendingClaimReloadGuard,
  registerPendingClaimReloadPreparation,
} from '../document-reload.ts';
import { isIntentionalNav, markIntentionalNav } from '../page-lifecycle.ts';
import {
  isSessionResetPending,
  scheduleDocumentReload,
  scheduleSessionReset,
} from '../session-reset.ts';
import { navigateToAppHome } from '../navigation.ts';
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

/** NAVIGATION_COMMIT_TIMEOUT_MS (session-reset.ts); C6-1 exports it. */
const COMMIT_DEADLINE_MS = 2_000;
/** LEAVE_FALLBACK_MS (back-button-history.ts); C6-1 exports it. */
const LEAVE_FALLBACK_MS = 1_000;
/** ACTIVATION_TIMEOUT_MS (sw-hard-reset.ts). */
const HARD_RESET_ACTIVATION_MS = 1_500;
/** Two frames: the Back guard pushes after its surface settles. */
const GUARD_ARM_MS = 40;
/** A synthetic claim token in the shape credentials.ts accepts. */
const CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;

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
  it('runs after the first reload recovers, and the queue starts it before the first caller hears of the recovery [keeps: C6-5] [settle order: C6-4]', async () => {
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

  it('queues a reload asked for from a recovery callback behind the reload already queued (FIFO) [keeps: C6-5] [re-entrancy: C6-4]', async () => {
    const s = boot({ app: IN_ROOM });
    const order: string[] = [];
    s.sinks.reload.mockImplementation(() => order.push(s.resetMessage() ?? ''));
    scheduleDocumentReload('First', () => scheduleDocumentReload('Retry'));
    scheduleDocumentReload('Second');

    await advance(PAINT_MS + COMMIT_DEADLINE_MS);
    expect(s.resetMessage()).toBe('Second');
    await advance(PAINT_MS + COMMIT_DEADLINE_MS);
    expect(s.resetMessage()).toBe('Retry');
    await advance(PAINT_MS);

    expect(order).toEqual(['First', 'Second', 'Retry']);
  });

  it('starts a reload asked for from a recovery callback at once when nothing is queued (sw-register.ts:295-309 shape) [re-entrancy: C6-4]', async () => {
    const s = boot({ app: IN_ROOM });
    scheduleDocumentReload('Update', () => scheduleDocumentReload('Successor update'));

    await advance(PAINT_MS + COMMIT_DEADLINE_MS);
    expect(isSessionResetPending()).toBe(true);
    expect(s.resetMessage()).toBe('Successor update');
    await advance(PAINT_MS);
    expect(s.sinks.count('reload')).toBe(2);
  });

  it('accepts a direct reset asked for from its own recovery callback [re-entrancy: C6-4]', async () => {
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
  it('releases the windows while still pending, then reports idle with the exemption already cleared [settle order: C6-4]', async () => {
    const s = boot({ app: IN_ROOM });
    const seen: string[] = [];
    const snapshot = (where: string) =>
      `${where}: pending=${isSessionResetPending()} overlayHidden=${overlay().hidden} exempt=${isIntentionalNav()}`;
    const handle = scheduleSessionReset(MSG_LEAVING, vi.fn());
    await advance(PAINT_MS);
    expect(isIntentionalNav()).toBe(true);
    const unsubscribe = onOverlayStackChange(() => seen.push(snapshot('overlay stack')));
    s.addCleanup(unsubscribe);
    handle?.onRecovered(() => seen.push(snapshot('recovered')));

    await advance(COMMIT_DEADLINE_MS);

    // restoreSessionReset (session-reset.ts:211-243): focus, the release handler
    // (dom.ts re-derives the stack and notifies the Back guard), then the
    // overlay hides, the reset reports idle, the exemption clears, and only
    // then do per-attempt callbacks run. C6-4 has to define this order:
    // reporting idle before the window release would let the Back guard
    // re-arm there, which is C6-12's intended change to pin (h).
    expect(seen).toEqual([
      'overlay stack: pending=true overlayHidden=false exempt=true',
      'recovered: pending=false overlayHidden=true exempt=false',
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

  /** Today's rule, written out: pagehide commits; a return or the deadline restores. */
  function expectedRecovery(order: readonly SettleEvent[]): boolean {
    let committed = false;
    for (const event of order) {
      if (event === 'pagehide') committed = true;
      else if (event === 'deadline' && !committed) return true;
      else if ((event === 'pageshow' || event === 'visible') && committed) return true;
    }
    return false;
  }

  it.each(
    (['reset', 'reload'] as const).flatMap((kind) =>
      permutations(EVENTS).map((order) => [kind, order.join(' > '), order] as const),
    ),
  )(
    'after the %s action, %s settles at most once [keeps: C6-4 exactly-once settle]',
    async (kind, _name, order) => {
      const s = boot({ app: OUTSIDE_ROOM });
      const recovered = vi.fn();
      if (kind === 'reset') scheduleSessionReset(MSG_LEAVING, vi.fn())?.onRecovered(recovered);
      else scheduleDocumentReload(MSG_REFRESHING, recovered);
      await advance(PAINT_MS);
      expect(s.sinks.count('reload')).toBe(kind === 'reload' ? 1 : 0);

      for (const event of order) {
        // A non-persisted pageshow keeps page-lifecycle's bfcache branch out.
        if (event === 'pagehide') s.pagehide(false);
        else if (event === 'pageshow') s.pageshow(false);
        else if (event === 'visible') document.dispatchEvent(new Event('visibilitychange'));
        else await advance(COMMIT_DEADLINE_MS);
      }
      await advance(10_000);

      const recovers = expectedRecovery(order);
      expect(recovered).toHaveBeenCalledTimes(recovers ? 1 : 0);
      expect(isSessionResetPending()).toBe(!recovers);
    },
  );
});

describe('(c) a pending reset returned from the back-forward cache', () => {
  it('restores the shell and makes exactly one fresh reload; a second return does not loop [keeps: C6-6]', async () => {
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
    expect(isIntentionalNav()).toBe(true);
    await advance(PAINT_MS);
    expect(s.sinks.count('reload')).toBe(2);

    // The fresh reload also lands in the cache and the same document returns.
    s.leaveDocument(true);
    s.returnFromBfcache('pageshow-first');
    await advance(PAINT_MS + COMMIT_DEADLINE_MS);

    expect(s.sinks.count('reload')).toBe(2);
    expect(isSessionResetPending()).toBe(false);
    expect(overlay().hidden).toBe(true);
    expect(s.element('tab-play').inert).toBe(false);
    expect(isIntentionalNav()).toBe(false);
    expect(s.beforeunloadPrompts()).toBe(true);
    expect(s.lifecycleLog).toHaveBeenLastCalledWith(
      '[PageLifecycle] bfcache reload returned; keeping recovered shell visible',
    );
  });

  // Engines differ on whether visibilitychange(visible) or pageshow(persisted)
  // comes first on a cache restore. The reset's capture-phase visibility
  // listener (session-reset.ts:279) restores first when visibility leads, and
  // page-lifecycle then sees no pending reset (page-lifecycle.ts:169-170).
  it.each([
    ['pageshow-first', 'outside a room', OUTSIDE_ROOM, 1, true],
    ['visible-first', 'outside a room', OUTSIDE_ROOM, 0, false],
    ['pageshow-first', 'in a room', IN_ROOM, 1, true],
    ['visible-first', 'in a room', IN_ROOM, 1, true],
  ] as const)(
    '%s return %s: %i fresh reload(s) [keeps or decides: C6-6]',
    async (order, _where, app, freshReloads, pendingAfterReturn) => {
      const s = boot({ app });
      scheduleSessionReset(MSG_LEAVING, () => navigateToAppHome());
      await advance(PAINT_MS);
      expect(s.sinks.count('replace')).toBe(1);
      s.leaveDocument(true);

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
    'a %s return of a pending reset with a window open arms the Back guard: %s [keeps or decides: C6-6] [flips: C6-12 for pageshow]',
    async (order, armed) => {
      const s = await pendingResetWithWindowAndAbsorbedBack();
      s.leaveDocument(true);
      s.returnFromBfcache(order);
      await advance(GUARD_ARM_MS);

      expect(s.history.marker()).toBe(armed ? 'guard' : 'base');
      expect(isSessionResetPending()).toBe(!armed);
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
    're-arms the Back guard in a room only on the second %s return, after the bounded reload stops [keeps: C6-6] [flips: C6-12 for the first return]',
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
      // guard last resumes. Flips in C6-12: the guard re-arms when it settles.
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
    // pagehide cancelled the leave's 1 s fallback (back-button-history.ts:109).
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
});

describe('(g) a window that opens during a pending reset', () => {
  it('keeps the reset surface exposed and focused, then hands top and focus to the window [flipped: 9.0.1 G4] [keeps: C6-11]', async () => {
    const s = boot({ app: IN_ROOM });
    s.element('control').focus();
    scheduleDocumentReload(MSG_REFRESHING);
    const dialog = s.element('dialog-overlay');

    s.openDialog();

    // The design's pin (g) predates 9.0.1: dom.ts:629 no longer locks the
    // overlay, and only `inert` is claimed by the reset.
    expect(overlay().hasAttribute('inert')).toBe(false);
    expect(overlay().getAttribute('aria-hidden')).toBe('false');
    expect(document.activeElement).toBe(overlay());
    expect(dialog.inert).toBe(true);
    expect(dialog.getAttribute('aria-hidden')).toBe('false');

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
  function takeClaim(): void {
    window.history.replaceState({ test: true }, '', `${ROOM_PATH}?lang=ko#pro-claim=${CLAIM}`);
    takeProRoomClaimsFromFragment();
    expect(location.href).toBe(`http://localhost:3000${ROOM_PATH}?lang=ko`);
  }

  it('restores the fragment only while the reload sink runs and scrubs it after recovery, each attempt [keeps: C6-5]', async () => {
    const s = boot({ app: IN_ROOM });
    takeClaim();

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      scheduleDocumentReload(MSG_REFRESHING);
      expect(location.hash).toBe('');
      await advance(PAINT_MS);
      expect(s.sinks.calls.at(-1)?.hrefAtCall).toBe(
        `http://localhost:3000${ROOM_PATH}?lang=ko#pro-claim=${CLAIM}`,
      );
      await advance(COMMIT_DEADLINE_MS);
      expect(location.href).toBe(`http://localhost:3000${ROOM_PATH}?lang=ko`);
    }
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
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
    await advance(1);
    await fencing;
    expect(fenced).toBe(true);

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
