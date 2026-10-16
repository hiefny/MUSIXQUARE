interface BackButtonGuardControllerDeps {
  /** A room session is running, so a Back with no window asks before leaving. */
  isSessionActive: () => boolean;
  /** A window (dialog, sheet, or fullscreen layer) is open above the page. */
  hasOpenWindow: () => boolean;
  /** Offer Back to the topmost window. Returns whether a window used it. */
  closeTopWindow: () => boolean;
  /** A reset is already navigating this document away. */
  isNavigationPending: () => boolean;
  pushGuard: () => void;
  /** Continue a Back that only consumed the guard entry. */
  navigateBack: () => void;
  requestLeaveConfirmation: () => Promise<boolean>;
  onLeaveConfirmed: () => void;
  onSeedError?: (error: unknown) => void;
  onConfirmationError?: (error: unknown) => void;
}

interface BackButtonGuardController {
  /** Re-evaluate after a session or window change. */
  handleStateChange: () => void;
  handlePopState: () => void;
}

/**
 * Whether Back asks before leaving. A PRO room re-entering presence briefly
 * projects the idle role while its room context stays set; that is still the
 * same session, and a Back in that window must not leave silently.
 */
export function isGuardedSession(state: {
  sessionStarted: boolean;
  role: string;
  roomId: string | null;
}): boolean {
  return state.sessionStarted && (state.role !== 'idle' || state.roomId !== null);
}

/**
 * Own the small history-guard state machine without importing UI or network
 * modules. The bootstrap layer supplies the browser and dialog side effects.
 *
 * One guard entry sits above the page while a session runs or a window is
 * open. Back pops it: the topmost window closes first, then a session asks
 * before leaving, and otherwise the Back continues to the previous page.
 */
export function createBackButtonGuardController(
  deps: BackButtonGuardControllerDeps,
): BackButtonGuardController {
  let confirmInFlight = false;
  let guardActive = false;
  let handlingBack = false;
  let leaving = false;

  const reportConfirmationError = (error: unknown): void => {
    try {
      deps.onConfirmationError?.(error);
    } catch {
      // Error reporting is terminal and must never re-enter the callback or
      // create a second unhandled rejection when the observer itself fails.
    }
  };

  const seedGuard = (): void => {
    try {
      deps.pushGuard();
      guardActive = true;
    } catch (error) {
      deps.onSeedError?.(error);
    }
  };

  const needsGuard = (): boolean => deps.isSessionActive() || deps.hasOpenWindow();

  const handleStateChange = (): void => {
    // A Back being handled decides the guard once its window has closed.
    if (handlingBack || guardActive || deps.isNavigationPending()) return;
    if (needsGuard()) seedGuard();
  };

  const confirmLeave = (): void => {
    confirmInFlight = true;
    (async () => {
      try {
        if (await deps.requestLeaveConfirmation()) {
          leaving = true;
          deps.onLeaveConfirmed();
        }
      } catch (error) {
        reportConfirmationError(error);
      } finally {
        confirmInFlight = false;
      }
    })().catch(reportConfirmationError);
  };

  const handlePopState = (): void => {
    // Every same-document Back consumes the current guard entry.
    const consumedGuard = guardActive;
    guardActive = false;
    if (deps.isNavigationPending()) {
      // A confirmed leave pops this guard and the page entry together.
      // Re-seed so that count stays right; any other reset replaces the
      // current entry and needs no guard.
      if (leaving) seedGuard();
      return;
    }

    let windowUsedBack: boolean;
    handlingBack = true;
    try {
      windowUsedBack = deps.closeTopWindow();
    } finally {
      handlingBack = false;
    }
    if (windowUsedBack) {
      if (needsGuard()) seedGuard();
      return;
    }

    if (deps.isSessionActive()) {
      // Keep an active session fenced while its leave confirmation is open.
      seedGuard();
      if (!confirmInFlight) confirmLeave();
      return;
    }

    // Outside a room with no window: this Back belongs to the page. When it
    // only consumed a guard left by a window that closed another way, carry
    // it on to the previous page.
    if (consumedGuard) deps.navigateBack();
  };

  return { handleStateChange, handlePopState };
}
