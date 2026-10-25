/**
 * The page's build number and the forced-update port (RO-22, forced update,
 * train 9.0.12).
 *
 * The build is the integer of the service-worker cache epoch (`v785` is 785)
 * that Vite defines as __MXQR_BUILD_CACHE_VERSION__ from
 * scripts/service-worker-asset.ts, so no copy of the epoch lives here. A build
 * without the define (unit tests) is 0. The page reports it when it enters a
 * room (the PRO API header, the Signaling auth frames), and the Workers refuse
 * a new entry below the App build floor.
 *
 * The port: a refusal reaches the update machine in sw-register.ts through
 * `requestForcedAppUpdate`, which shows the update dialog without Later. Like
 * the logo port there, it keeps the transport and PRO code from importing
 * sw-register.ts. Only sw-register.ts installs the handler.
 */

import { parseAppBuild } from '../../cloudflare/app-build-floor-contract.ts';

function readAppBuild(): number {
  const epoch =
    typeof __MXQR_BUILD_CACHE_VERSION__ === 'string' ? __MXQR_BUILD_CACHE_VERSION__ : '';
  const digits = /^v([1-9]\d{0,9})$/u.exec(epoch)?.[1];
  return (digits && parseAppBuild(digits)) || 0;
}

/** This page's build: the integer of its cache epoch, or 0 without one. */
export const APP_BUILD = readAppBuild();

interface ForcedAppUpdateRequest {
  /** The floor the refusal named (validated by the machine). */
  readonly minAppBuild: unknown;
  /** The refused session was in a room (an open host room, a live guest channel). */
  readonly admitted: boolean;
  /** The room code the refused entry was for, null when there was none. */
  readonly returnCode: string | null;
}

interface ForcedAppUpdateHandler {
  request(request: ForcedAppUpdateRequest): boolean;
  isPending(): boolean;
}

let handler: ForcedAppUpdateHandler | null = null;
const presentationListeners = new Set<() => void>();

function announcePresentation(): void {
  for (const listener of [...presentationListeners]) {
    try {
      listener();
    } catch {
      // One subscriber's failure must not keep another dialog on screen.
    }
  }
}

/**
 * The update machine's side of the port (sw-register.ts only). Returns the
 * call that tells the presentation subscribers the forced dialog is about to
 * take the screen.
 */
export function setForcedAppUpdateHandler(next: ForcedAppUpdateHandler): () => void {
  handler = next;
  return announcePresentation;
}

/**
 * Ask for the forced update after a refusal below the floor. True when the
 * forced dialog is open or queued, or an update reload is on its way; false
 * when this build is not below the floor, the loop guard holds or there is no
 * machine: the caller then shows its ordinary error.
 */
export function requestForcedAppUpdate(request: ForcedAppUpdateRequest): boolean {
  return handler?.request(request) ?? false;
}

/** Whether the forced dialog is open or queued, or its update reload is in flight. */
export function isForcedAppUpdatePending(): boolean {
  return handler?.isPending() ?? false;
}

/** Refusal errors the forced update took over (their answer was true). */
const takenRefusals = new WeakSet<object>();

/**
 * `requestForcedAppUpdate` for a refusal that is then reported as `error`
 * (the Signaling transport). A true answer is kept with the error, because it
 * can come with nothing pending yet (a navigation holds the page), and the UI
 * that later reads the error must still hide its generic text.
 */
export function requestForcedAppUpdateFor(error: object, request: ForcedAppUpdateRequest): boolean {
  const taken = requestForcedAppUpdate(request);
  if (taken) takenRefusals.add(error);
  return taken;
}

/**
 * Whether a failure belongs to the forced update: its refusal was taken over,
 * or the forced dialog is pending. The UI then shows no generic text.
 */
export function isHandledByForcedAppUpdate(error: unknown): boolean {
  return (
    (typeof error === 'object' && error !== null && takenRefusals.has(error)) ||
    isForcedAppUpdatePending()
  );
}

/**
 * Run `listener` each time the forced dialog is about to take the screen, so
 * the return-time dialogs below it (RO-51) step aside. Returns an unsubscribe.
 */
export function subscribeForcedAppUpdatePresentation(listener: () => void): () => void {
  presentationListeners.add(listener);
  return () => {
    presentationListeners.delete(listener);
  };
}
