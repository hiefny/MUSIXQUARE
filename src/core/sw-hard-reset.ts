import type { HardResetClaim, HardResetClaimRequest } from '../sw-register.ts';
import { recordServiceWorkerUpdateCompletion } from './sw-update-completion.ts';

/**
 * HARD_RESET_CLAIM_EVENT in sw-register.ts: the update machine's port. This
 * lazy chunk keeps a copy so it does not import the eager module; the tests
 * pin both (src/core/__tests__/__helpers__/hard-reset-port.ts).
 */
const HARD_RESET_CLAIM_EVENT = 'mxqr:hard-reset-claim';

/**
 * A copy of STARTUP_PROMPT_QUIET_MS in sw-register.ts (the home, RO-22): a
 * SKIP_WAITING sent once no resource of the page finished for this long
 * activates at once (Chromium, measured 2026-10-17). The update machine
 * decides with this chunk's reading, so the check stays out of the eager
 * bundle (Phase 3 R2). sw-hard-reset.test.ts pins the copy to the home
 * (src/core/__tests__/__helpers__/hard-reset-port.ts).
 */
const STARTUP_PROMPT_QUIET_MS = 1_000;

/**
 * How long the hard reset waits for an activation it asked for. The navigation
 * owner's prepare window (NAVIGATION_PREPARE_TIMEOUT_MS, 2.5 s) leaves at
 * least 1 s beside it for loading this chunk, and its abort ends any wait;
 * navigation-contract.test.ts pins the two.
 */
const ACTIVATION_TIMEOUT_MS = 1_500;

/** How the hard reset's promotion ended (owner decision P3-11 A). */
type HardResetPromotion = 'activated' | 'timeout' | 'unavailable' | 'none';

/**
 * Wait until a controller other than `previousController` takes this page:
 * 'activated', or 'timeout' after `timeoutMs` (none: until the abort) or when
 * `signal` aborts.
 */
function waitForNewController(
  signal: AbortSignal,
  previousController: ServiceWorker,
  timeoutMs?: number,
): Promise<'activated' | 'timeout'> {
  const serviceWorkers = navigator.serviceWorker;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: 'activated' | 'timeout') => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      serviceWorkers.removeEventListener('controllerchange', handleControllerChange);
      signal.removeEventListener('abort', handleTimeout);
      resolve(result);
    };
    const handleControllerChange = () => {
      if (serviceWorkers.controller && serviceWorkers.controller !== previousController) {
        finish('activated');
      }
    };
    const handleTimeout = () => finish('timeout');
    const timeout = timeoutMs === undefined ? 0 : window.setTimeout(handleTimeout, timeoutMs);
    serviceWorkers.addEventListener('controllerchange', handleControllerChange);
    signal.addEventListener('abort', handleTimeout);
    if (signal.aborted) handleTimeout();
    // Close the tiny listener-install race if another tab activated the same
    // waiting generation while this reset was being prepared.
    handleControllerChange();
  });
}

/**
 * The promotion that does not go through the update machine: the hard reset's
 * own SKIP_WAITING, kept by owner decision P3-12 A (2026-10-24). It is the only
 * path where there is no machine (before the window load event, after a failed
 * registration); the port has then checked that the page's loads are quiet.
 * TEMPORARY: it also runs after the machine's own promotion timed out, until
 * two clean production update cycles have passed; a later Phase 3 release
 * removes that use.
 */
async function promoteWithoutTheUpdateMachine(signal: AbortSignal): Promise<HardResetPromotion> {
  const serviceWorkers = navigator.serviceWorker;
  const registration = await serviceWorkers.getRegistration('/');
  const waitingWorker = registration?.waiting;
  const previousController = serviceWorkers.controller;
  if (
    signal.aborted ||
    !previousController ||
    !waitingWorker ||
    waitingWorker.state !== 'installed'
  )
    return 'none';
  const activation = waitForNewController(signal, previousController, ACTIVATION_TIMEOUT_MS);
  try {
    if (serviceWorkers.controller === previousController) {
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    }
  } catch {
    return 'none';
  }
  return activation;
}

/**
 * No resource of the page finished within STARTUP_PROMPT_QUIET_MS. This chunk's own
 * load, just now for this tap, is not the page still loading (found by the
 * 2026-10-24 real-browser check). Without resource timing the page is quiet.
 */
function isPageQuiet(): boolean {
  let lastResponseEnd = -Infinity;
  try {
    for (const entry of performance.getEntriesByType('resource')) {
      if (entry.name === import.meta.url) continue;
      lastResponseEnd = Math.max(
        lastResponseEnd,
        (entry as PerformanceResourceTiming).responseEnd || 0,
      );
    }
  } catch {
    // Without resource timing nothing says the page is still loading.
  }
  return performance.now() - lastResponseEnd >= STARTUP_PROMPT_QUIET_MS;
}

/** Ask the update machine through its port; without an answer there is nothing to promote. */
function claimWaitingWorker(): HardResetClaim {
  const request: HardResetClaimRequest = { quiet: isPageQuiet() };
  navigator.serviceWorker.dispatchEvent(
    new CustomEvent<HardResetClaimRequest>(HARD_RESET_CLAIM_EVENT, { detail: request }),
  );
  return request.claim ?? 'none';
}

/**
 * The logo reset's prepare step (Phase 3 C6-10): ask the update machine,
 * through its port, to apply a waiting update before the page goes home, wait
 * for the activation, and leave "Update applied" for the next document only
 * when this document saw the new worker take control (owner decision P3-11 A).
 * An Apply already in flight is waited for until the prepare window closes,
 * so no second SKIP_WAITING follows it (P3-8 A). `signal` is the prepare
 * step's: once it aborts, nothing more is promoted or awaited.
 */
export default async function activatePendingServiceWorkerForHardReset(
  signal: AbortSignal,
): Promise<undefined> {
  const previousController =
    'serviceWorker' in navigator ? navigator.serviceWorker.controller : null;
  if (signal.aborted || !previousController) return undefined;
  const claim = claimWaitingWorker();
  let result: HardResetPromotion =
    claim === 'promoted' || claim === 'apply-in-flight'
      ? await waitForNewController(
          signal,
          previousController,
          claim === 'promoted' ? ACTIVATION_TIMEOUT_MS : undefined,
        )
      : claim;
  if (!signal.aborted && (result === 'unavailable' || result === 'timeout')) {
    result = await promoteWithoutTheUpdateMachine(signal);
  }
  if (result === 'activated') recordServiceWorkerUpdateCompletion();
  return undefined;
}
