interface BackButtonGuardControllerDeps {
  isSessionActive: () => boolean;
  hasOpenWindow: () => boolean;
  closeTopWindow: () => { handled: boolean; settled: Promise<void> };
  /** Only app-owned closing transitions; not the room's decorative entrance. */
  whenSurfaceSettled: () => Promise<void>;
  /** A completed join must show the room before taking its history snapshot. */
  isSurfaceReady: () => boolean;
  isDocumentVisible: () => boolean;
  isNavigationPending: () => boolean;
  currentHistoryPosition: () => 'base' | 'guard' | 'foreign';
  pushGuard: () => void;
  navigateBack: () => void;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
  requestLeaveConfirmation: () => Promise<boolean>;
  onLeaveConfirmed: () => void;
  onSeedError?: (error: unknown) => void;
  onConfirmationError?: (error: unknown) => void;
}

/** PRO presence re-entry may briefly project idle while the room remains active. */
export function isGuardedSession(state: {
  sessionStarted: boolean;
  role: string;
  roomId: string | null;
}): boolean {
  return state.sessionStarted && (state.role !== 'idle' || state.roomId !== null);
}

/**
 * One common rearm policy: apply the UI change, await its closing surface, then
 * allow two animation frames before restoring one owned history guard. A frame
 * is a rendering opportunity, not proof that Safari released its native swipe
 * snapshot. Never push in the popstate task, including re-entrant modal events.
 */
export function createBackButtonGuardController(deps: BackButtonGuardControllerDeps) {
  let confirmationPending = false;
  let handlingBack = false;
  let leaving = false;
  let suspended = false;
  let epoch = 0;
  let frame: number | null = null;
  let lastPosition = deps.currentHistoryPosition();

  const report = (observer: ((error: unknown) => void) | undefined, error: unknown): void => {
    try {
      observer?.(error);
    } catch {
      // Diagnostics cannot create an unhandled rejection or navigation loop.
    }
  };
  const cancelArm = (): void => {
    epoch += 1;
    if (frame !== null) deps.cancelFrame(frame);
    frame = null;
  };
  const needsGuard = (): boolean => deps.isSessionActive() || deps.hasOpenWindow();
  const canArm = (): boolean =>
    !suspended &&
    !leaving &&
    deps.isDocumentVisible() &&
    !deps.isNavigationPending() &&
    needsGuard();

  const arm = (settled: Promise<void> = Promise.resolve()): void => {
    cancelArm();
    if (!canArm()) return;
    if (deps.currentHistoryPosition() === 'guard') {
      lastPosition = 'guard';
      return;
    }
    const scheduledEpoch = epoch;
    const current = (): boolean => scheduledEpoch === epoch && canArm();
    void Promise.all([settled, deps.whenSurfaceSettled()])
      .then(() => {
        if (!current() || !deps.isSurfaceReady()) return;
        frame = deps.requestFrame(() => {
          frame = null;
          if (!current() || !deps.isSurfaceReady()) return;
          frame = deps.requestFrame(() => {
            frame = null;
            if (!current() || !deps.isSurfaceReady()) return;
            try {
              if (deps.currentHistoryPosition() !== 'guard') deps.pushGuard();
              lastPosition = deps.currentHistoryPosition();
            } catch (error) {
              report(deps.onSeedError, error);
            }
          });
        });
      })
      .catch((error: unknown) => report(deps.onSeedError, error));
  };

  const handleStateChange = (): void => {
    if (handlingBack) return;
    arm();
  };

  const confirmLeave = (): void => {
    confirmationPending = true;
    void (async () => {
      try {
        if (await deps.requestLeaveConfirmation()) {
          if (suspended || deps.isNavigationPending()) return;
          leaving = true;
          cancelArm();
          deps.onLeaveConfirmed();
        }
      } catch (error) {
        leaving = false;
        report(deps.onConfirmationError, error);
      } finally {
        confirmationPending = false;
        if (!leaving) arm();
      }
    })().catch((error: unknown) => report(deps.onConfirmationError, error));
  };

  const handlePopState = (): void => {
    const previous = lastPosition;
    const destination = deps.currentHistoryPosition();
    // An already-observed state must not cancel the only pending rearm.
    if (previous === destination) return;
    cancelArm();
    lastPosition = destination;
    if (suspended || leaving || deps.isNavigationPending()) return;
    // Forward and foreign/duplicate events must not close another window.
    if (previous !== 'guard' || destination !== 'base') return;

    handlingBack = true;
    try {
      const result = deps.closeTopWindow();
      if (result.handled) {
        arm(result.settled);
      } else if (deps.isSessionActive()) {
        if (!confirmationPending) confirmLeave();
        // The confirmation itself gets the same deferred guard. Back on it
        // means Stay, without escaping to the previous document.
        arm();
      } else {
        // A window closed by its own button left an unused guard behind.
        deps.navigateBack();
      }
    } finally {
      handlingBack = false;
    }
  };

  return {
    handleStateChange,
    handlePopState,
    suspend(): void {
      suspended = true;
      cancelArm();
    },
    resume(): void {
      suspended = false;
      lastPosition = deps.currentHistoryPosition();
      arm();
    },
    recoverNavigation(): void {
      leaving = false;
      lastPosition = deps.currentHistoryPosition();
      arm();
    },
  };
}
