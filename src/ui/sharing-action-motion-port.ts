import { log } from '../core/log.ts';

type MotionFactory = typeof import('./sharing-action-motion.ts').createSharingActionMotion;

let factory: MotionFactory | null = null;
const bindings = new Set<() => void>();

/** Installed by the awaited room feature boundary, never by initial app load. */
export function registerSharingActionMotion(create: MotionFactory): void {
  factory = create;
  for (const initialize of bindings) initialize();
}

/** Own the action state synchronously; room-loaded motion is only decoration. */
export function bindSharingActionControls(
  ...args: Parameters<MotionFactory>
): ReturnType<MotionFactory> {
  const [container, syncButton, mediaButton, signal] = args;
  let sharing: boolean | undefined;
  let motion: ReturnType<MotionFactory> | null = null;
  let motionAbort: AbortController | null = null;
  let motionFailed = false;
  const initialDisabled = syncButton.disabled;
  const initialInert = syncButton.hasAttribute('inert');
  const initialAriaHidden = syncButton.getAttribute('aria-hidden');
  const initialSharing = container.getAttribute('data-sharing');

  function restoreSync(): void {
    syncButton.disabled = initialDisabled;
    syncButton.toggleAttribute('inert', initialInert);
    if (initialAriaHidden === null) syncButton.removeAttribute('aria-hidden');
    else syncButton.setAttribute('aria-hidden', initialAriaHidden);
  }

  function failMotion(error: unknown): void {
    motionFailed = true;
    motion = null;
    motionAbort?.abort();
    motionAbort = null;
    delete container.dataset.motionReady;
    log.warn('[SharingAction] Optional motion failed', error);
  }

  function initialize(): void {
    if (signal.aborted || motion || motionFailed || !factory) return;
    try {
      motionAbort = new AbortController();
      motion = factory(container, syncButton, mediaButton, motionAbort.signal);
      if (sharing !== undefined) motion.update(sharing);
      container.dataset.motionReady = 'true';
    } catch (error) {
      failMotion(error);
    }
  }

  if (!signal.aborted) {
    delete container.dataset.motionReady;
    bindings.add(initialize);
    signal.addEventListener(
      'abort',
      () => {
        bindings.delete(initialize);
        motionAbort?.abort();
        motion = null;
        delete container.dataset.motionReady;
        restoreSync();
        if (initialSharing === null) container.removeAttribute('data-sharing');
        else container.setAttribute('data-sharing', initialSharing);
      },
      { once: true },
    );
    initialize();
  }

  return {
    update(next) {
      if (signal.aborted) return;
      // Motion reads the previous geometry/hover before CSS sees the new state.
      // Its failure must not prevent committing the visible or accessible state.
      try {
        motion?.update(next);
      } catch (error) {
        failMotion(error);
      }
      if (next) {
        if (document.activeElement === syncButton) mediaButton.focus({ preventScroll: true });
        syncButton.disabled = true;
        syncButton.setAttribute('inert', '');
        syncButton.setAttribute('aria-hidden', 'true');
      } else {
        restoreSync();
      }
      sharing = next;
      container.dataset.sharing = String(next);
    },
  };
}
