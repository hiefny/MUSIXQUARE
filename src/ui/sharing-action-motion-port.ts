import { log } from '../core/log.ts';

type MotionFactory = typeof import('./sharing-action-motion.ts').createSharingActionMotion;

let factory: MotionFactory | null = null;
const bindings = new Set<() => void>();

/** Installed by the awaited room feature boundary, never by initial app load. */
export function registerSharingActionMotion(create: MotionFactory): void {
  factory = create;
  for (const initialize of bindings) initialize();
}

/** Retain this DOM generation and its latest state until room features arrive. */
export function bindSharingActionMotion(
  ...args: Parameters<MotionFactory>
): ReturnType<MotionFactory> {
  const signal = args[3];
  let sharing: boolean | undefined;
  let motion: ReturnType<MotionFactory> | null = null;

  function initialize(): void {
    if (signal.aborted || motion || !factory) return;
    try {
      motion = factory(...args);
      if (sharing !== undefined) motion.update(sharing);
    } catch (error) {
      // Presentation cannot reject room setup after its protocol listeners
      // are ready. The existing Media action remains available as a fallback.
      log.warn('[SharingAction] Optional motion initialization failed', error);
    }
  }

  if (!signal.aborted) {
    bindings.add(initialize);
    signal.addEventListener('abort', () => bindings.delete(initialize), { once: true });
    initialize();
  }

  return {
    update(next) {
      if (signal.aborted) return;
      sharing = next;
      motion?.update(next);
    },
  };
}
