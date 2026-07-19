let leaveHandler: (() => void | Promise<void>) | null = null;
let hardCloseHandler: (() => boolean) | null = null;
let signalingReconnectHandler: (() => boolean | Promise<boolean>) | null = null;
let signalingEpochAdvanceHandler: (() => void | Promise<void>) | null = null;
let pageHideBound = false;
let confirmedUnloadHandled = false;

function bindConfirmedPageHide(): void {
  if (pageHideBound || typeof window === 'undefined') return;
  pageHideBound = true;
  // Capture runs before the app-wide pagehide listener that tears down peer
  // and player state. The keepalive request must be issued while the final
  // playback observation and authenticated room context are still intact.
  window.addEventListener(
    'pagehide',
    (event) => {
      if ((event as PageTransitionEvent).persisted || confirmedUnloadHandled) return;
      try {
        confirmedUnloadHandled = hardCloseHandler?.() === true;
      } catch {
        // Fall through to the ordinary leave hook during local teardown if a
        // request could not be started synchronously.
        confirmedUnloadHandled = false;
      }
    },
    { capture: true },
  );
}

/** Keep the network teardown layer independent from the PRO runtime graph. */
export function registerProRoomLeaveHandler(handler: (() => void | Promise<void>) | null): void {
  leaveHandler = handler;
}

/** Register the unload-only atomic checkpoint + presence close operation. */
export function registerProRoomHardCloseHandler(handler: (() => boolean) | null): void {
  hardCloseHandler = handler;
  confirmedUnloadHandled = false;
  if (handler) bindConfirmedPageHide();
}

export function requestProRoomLeave(): void {
  // A confirmed pagehide has already issued the only unload-safe server
  // mutation. Do not race it with the explicit multi-request leave sequence.
  if (confirmedUnloadHandled) return;
  if (!leaveHandler) return;
  void Promise.resolve(leaveHandler()).catch(() => undefined);
}

/** Keep the network retry loop independent from the authenticated runtime. */
export function registerProRoomSignalingReconnectHandler(
  handler: (() => boolean | Promise<boolean>) | null,
): void {
  signalingReconnectHandler = handler;
}

/** Return true only after a fresh one-use signaling ticket is installed. */
export async function requestProRoomSignalingReconnect(): Promise<boolean> {
  if (!signalingReconnectHandler) return false;
  try {
    return (await signalingReconnectHandler()) === true;
  } catch {
    return false;
  }
}

/** Reconcile the authoritative room incarnation after the server closes old sockets. */
export function registerProRoomSignalingEpochAdvanceHandler(
  handler: (() => void | Promise<void>) | null,
): void {
  signalingEpochAdvanceHandler = handler;
}

export function requestProRoomSignalingEpochAdvance(): void {
  if (!signalingEpochAdvanceHandler) return;
  void Promise.resolve(signalingEpochAdvanceHandler()).catch(() => undefined);
}
