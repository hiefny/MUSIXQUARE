/**
 * Source parity for the copies inside __helpers__/page-navigation-harness.ts
 * (C6-2). The harness wires the real owners the way src/app.ts bootstrap does
 * and replays the logo action of src/ui/player-controls.ts, because neither
 * can run in isolation. The pins in page-navigation-owner.integration.test.ts
 * that C6-6, C6-8 and C6-12 flip or keep therefore run on those copies.
 *
 * Each test here fails when the production lines the harness copies change.
 * Update the harness copy in the same change, then the expected text below.
 * Whitespace and full-line comments are ignored; order matters.
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

describe('app.ts wiring copied by the page navigation harness', () => {
  it('initialises OverlayObservers, then PageLifecycle, then BackButtonGuard [update with: C6-6]', () => {
    // Listener order within a phase follows this init order: page-lifecycle's
    // pageshow runs before the guard's resume.
    expectInOrder(appSource, [
      "safeInit('OverlayObservers', initOverlayObservers);",
      "safeInit('PageLifecycle', () => {",
      "safeInit('BackButtonGuard', initBackButtonGuard);",
    ]);
  });

  it('wires PageLifecycle with the release handler first and the reset as its bfcache reload [update with: C6-6, C6-7]', () => {
    expectInOrder(appSource, [
      "safeInit('PageLifecycle', () => {",
      'setSessionResetReleaseHandler(syncOverlayStateAfterExternalLock);',
      'initPageLifecycleHandlers({',
      "reload: () => scheduleDocumentReload(t('dialog.refreshing_session')),",
      'hasPendingReset: isSessionResetPending,',
      'restorePendingReset: restoreSessionReset,',
      "safeInit('BackButtonGuard', initBackButtonGuard);",
    ]);
  });

  it('wires the Back guard, its leave recovery and its listeners in this order [update with: C6-6, C6-12]', () => {
    expectInOrder(appSource, [
      'function initBackButtonGuard(): void {',
      "navigateHome: () => window.location.replace('/'),",
      'hasOpenWindow, closeTopWindow: offerBackToTopWindow, whenSurfaceSettled: whenBackSurfaceSettled,',
      "isSurfaceReady: () => !getState('setup.sessionStarted') || !document.getElementById('setup-overlay')?.classList.contains('active'),",
      "isDocumentVisible: () => document.visibilityState === 'visible', isNavigationPending: isSessionResetPending,",
      'currentHistoryPosition: backHistory.current, pushGuard: backHistory.pushGuard, navigateBack: () => history.back(),',
      "onLeaveConfirmed: () => { const reset = scheduleSessionReset(t('dialog.leaving_session'), () => { try { leaveSession(); }",
      'backHistory.leave(); });',
      'reset?.onRecovered(() => { backHistory.cancelLeave(); controller.recoverNavigation(); });',
      "bus.on('state:network.appRole', controller.handleStateChange);",
      "bus.on('state:setup.sessionStarted', controller.handleStateChange);",
      "bus.on('state:room.context', controller.handleStateChange);",
      'onOverlayStackChange(controller.handleStateChange);',
      "window.addEventListener('popstate', controller.handlePopState);",
      "window.addEventListener('pagehide', controller.suspend);",
      "window.addEventListener('pageshow', controller.resume);",
      "document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') controller.suspend(); else controller.resume(); });",
      'controller.handleStateChange(); }',
    ]);
  });
});

describe('player-controls.ts logo action copied by the page navigation harness', () => {
  it('drops the navigation once the reset recovers, after the hard-reset chunk and its promotion [update with: C6-8, C6-10]', () => {
    expectInOrder(playerControlsSource, [
      'let resetCurrent = true;',
      'const navigateIfCurrent = () => { if (resetCurrent) navigateToAppHome(); };',
      "const resetHandle = scheduleSessionReset(t('dialog.leaving_session'), () => {",
      "void import('../core/sw-hard-reset.ts') .then((module) => { if (resetCurrent) return module.default(); }) .then(navigateIfCurrent, navigateIfCurrent); });",
      'resetHandle?.onRecovered(() => { resetCurrent = false; });',
    ]);
  });
});
