interface BackButtonGuardControllerDeps {
  isSessionActive: () => boolean;
  pushGuard: () => void;
  requestLeaveConfirmation: () => Promise<boolean>;
  onLeaveConfirmed: () => void;
  onSeedError?: (error: unknown) => void;
  onConfirmationError?: (error: unknown) => void;
}

interface BackButtonGuardController {
  handleSessionStateChange: () => void;
  handlePopState: () => void;
}

/**
 * Own the small history-guard state machine without importing UI or network
 * modules. The bootstrap layer supplies the browser and dialog side effects.
 */
export function createBackButtonGuardController(
  deps: BackButtonGuardControllerDeps,
): BackButtonGuardController {
  let confirmInFlight = false;
  let guardActive = false;

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

  const handleSessionStateChange = (): void => {
    if (deps.isSessionActive() && !guardActive) seedGuard();
  };

  const handlePopState = (): void => {
    // Every same-document Back consumes the current guard entry.
    guardActive = false;
    if (!deps.isSessionActive()) return;

    // Keep an active session fenced even when another Back arrives while the
    // first leave confirmation is still open. Do not open a duplicate dialog.
    seedGuard();
    if (confirmInFlight) return;

    confirmInFlight = true;
    (async () => {
      try {
        if (await deps.requestLeaveConfirmation()) deps.onLeaveConfirmed();
      } catch (error) {
        reportConfirmationError(error);
      } finally {
        confirmInFlight = false;
      }
    })().catch(reportConfirmationError);
  };

  return { handleSessionStateChange, handlePopState };
}
