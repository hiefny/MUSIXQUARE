/**
 * Source parity for the copies inside __helpers__/page-navigation-harness.ts
 * (C6-2). The harness wires the real owners the way src/app.ts bootstrap does
 * and replays the logo action of src/ui/player-controls.ts, because neither
 * can run in isolation. The pins in page-navigation-owner.integration.test.ts
 * that C6-6, C6-8 and C6-12 flip or keep therefore run on those copies.
 *
 * The copied regions are pinned whole: initBackButtonGuard, the PageLifecycle
 * init block and the logo action must equal the text below, so an inserted,
 * removed or changed line fails, including the parts the harness replaces
 * (the leave dialog, core/log). The bootstrap init order is pinned as an
 * ordered subsequence only: other inits run between these three. When a pin
 * fails, update the harness copy in the same change, then the text here.
 * Whitespace and full-line comments are ignored.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSquashed(path: string): string {
  return readFileSync(resolve(path), 'utf8')
    .replace(/^\s*\/\/.*$/gmu, '')
    .replace(/\s+/gu, ' ');
}

const appSource = readSquashed('src/app.ts');
const playerControlsSource = readSquashed('src/ui/player-controls.ts');

/** Each snippet appears after the end of the previous one. */
function expectInOrder(source: string, snippets: readonly string[]): void {
  let from = 0;
  for (const snippet of snippets) {
    const index = source.indexOf(snippet, from);
    expect(index, `not found in order: ${snippet}`).toBeGreaterThanOrEqual(0);
    from = index + snippet.length;
  }
}

/** `head` and the block its last `{` opens, through the matching `}`. */
function block(source: string, head: string): string {
  const from = source.indexOf(head);
  expect(from, `not found: ${head}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = source.indexOf('{', from + head.length - 1); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return source.slice(from, index + 1);
  }
  throw new Error(`unclosed block: ${head}`);
}

/** The source from `start` up to, not including, the next `end`. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `not found: ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `not found after the start: ${end}`).toBeGreaterThanOrEqual(0);
  return source.slice(from, to).trim();
}

describe('app.ts wiring copied by the page navigation harness', () => {
  it('initialises OverlayObservers, then PageLifecycle, then BackButtonGuard [updated: C6-6]', () => {
    // Since C6-6 no outcome depends on this order: the navigation owner's
    // page-transition dispatch uses the capture phase (the harness pins both
    // orders with `initOrder`). The copy still boots in this order.
    expectInOrder(appSource, [
      "safeInit('OverlayObservers', initOverlayObservers);",
      "safeInit('PageLifecycle', () => {",
      "safeInit('BackButtonGuard', initBackButtonGuard);",
    ]);
  });

  it('wires PageLifecycle with the release handler first, then the navigation owner with its bfcache reload [updated: C6-6] [update with: C6-7]', () => {
    expect(block(appSource, "safeInit('PageLifecycle', () => {")).toBe(
      [
        "safeInit('PageLifecycle', () => {",
        'setSessionResetReleaseHandler(syncOverlayStateAfterExternalLock);',
        'const lifecycle = {',
        "getRole: () => getState('network.appRole'),",
        'leaveSession: () => leaveSession({ preserveAccountLoginReturn: true }), };',
        'initPageLifecycleHandlers(lifecycle);',
        'initPageNavigation({',
        'getRole: lifecycle.getRole,',
        "bfcacheReloadMessage: () => t('dialog.refreshing_session'),",
        'log, }); }',
      ].join(' '),
    );
  });

  it('wires the Back guard, its leave recovery and its listeners exactly as copied [keeps: C6-6] [update with: C6-12]', () => {
    expect(block(appSource, 'function initBackButtonGuard(): void {')).toBe(
      [
        'function initBackButtonGuard(): void {',
        'const backHistory = createBackButtonHistory({',
        "navigateHome: () => window.location.replace('/'),",
        "onNavigationError: (error) => log.warn('[App] Back navigation failed:', error), });",
        'const controller = createBackButtonGuardController({',
        'isSessionActive: () => isGuardedSession({',
        "sessionStarted: getState('setup.sessionStarted'),",
        "role: getState('network.appRole'),",
        'roomId: getRoomContext().roomId, }),',
        'hasOpenWindow, closeTopWindow: offerBackToTopWindow, whenSurfaceSettled: whenBackSurfaceSettled,',
        "isSurfaceReady: () => !getState('setup.sessionStarted') || !document.getElementById('setup-overlay')?.classList.contains('active'),",
        "isDocumentVisible: () => document.visibilityState === 'visible',",
        'isNavigationPending: isSessionResetPending,',
        'currentHistoryPosition: backHistory.current,',
        'pushGuard: backHistory.pushGuard,',
        'navigateBack: () => history.back(),',
        'requestFrame: (callback) => window.requestAnimationFrame(callback),',
        'cancelFrame: (id) => window.cancelAnimationFrame(id),',
        // The harness answers the leave dialog itself.
        'requestLeaveConfirmation: async () => { const result = await showDialog({',
        "title: t('dialog.return_home_title'), message: t('dialog.return_home_detail'),",
        "buttonText: t('common.leave'), secondaryText: t('common.stay'), defaultFocus: 'secondary', });",
        "return result.action === 'ok'; },",
        "onLeaveConfirmed: () => { const reset = scheduleSessionReset(t('dialog.leaving_session'), () => {",
        "try { leaveSession(); } catch (e) { log.warn('[App] leaveSession failed:', e); }",
        'backHistory.leave(); });',
        'reset?.onRecovered(() => { backHistory.cancelLeave(); controller.recoverNavigation(); }); },',
        "onSeedError: (error) => log.warn('[App] Back-button guard seed failed:', error),",
        "onConfirmationError: (error) => log.warn('[App] Back-button dialog failed:', error), });",
        "bus.on('state:network.appRole', controller.handleStateChange);",
        "bus.on('state:setup.sessionStarted', controller.handleStateChange);",
        "bus.on('state:room.context', controller.handleStateChange);",
        "bus.on('setup:app-entrance', controller.handleStateChange);",
        'onOverlayStackChange(controller.handleStateChange);',
        "window.addEventListener('popstate', controller.handlePopState);",
        "window.addEventListener('pagehide', controller.suspend);",
        "window.addEventListener('pageshow', controller.resume);",
        "document.addEventListener('visibilitychange', () => {",
        "if (document.visibilityState === 'hidden') controller.suspend(); else controller.resume(); });",
        'controller.handleStateChange(); }',
      ].join(' '),
    );
  });
});

describe('player-controls.ts logo action copied by the page navigation harness', () => {
  it('drops the navigation once the reset recovers, after the hard-reset chunk and its promotion [update with: C6-8, C6-10]', () => {
    expect(
      between(
        playerControlsSource,
        'let resetCurrent = true;',
        '} finally { _logoNavBusy = false; }',
      ),
    ).toBe(
      [
        'let resetCurrent = true;',
        'const navigateIfCurrent = () => { if (resetCurrent) navigateToAppHome(); };',
        "const resetHandle = scheduleSessionReset(t('dialog.leaving_session'), () => {",
        "void import('../core/sw-hard-reset.ts')",
        '.then((module) => { if (resetCurrent) return module.default(); })',
        '.then(navigateIfCurrent, navigateIfCurrent); });',
        'resetHandle?.onRecovered(() => { resetCurrent = false; });',
      ].join(' '),
    );
  });
});
