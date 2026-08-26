/**
 * Hidden, input-only developer gesture for the onboarding carousel.
 *
 * This module deliberately owns no diagnostics UI. The caller supplies the
 * callback so the gesture stays cheap, synchronous, and independent from the
 * debug-console feature graph.
 */

const REQUIRED_TAPS = 10;
const TAP_SEQUENCE_WINDOW_MS = 5_000;
const MAX_TAP_DURATION_MS = 800;
const MAX_TAP_MOVEMENT_PX = 14;
const POINTER_CLICK_DEDUPE_MS = 750;

interface ActivePointerTap {
  id: number;
  startX: number;
  startY: number;
  startedAt: number;
  moved: boolean;
}

interface OnboardingDebugGestureOptions {
  target: HTMLElement | null;
  signal: AbortSignal;
  onOpen: () => void;
  /** Monotonic clock injection for focused gesture tests. */
  now?: () => number;
}

// Setup can be initialized repeatedly as a user enters and leaves the welcome
// flow. Keep only one live listener set per carousel target, but do not lock the
// diagnostics surface after it has opened: a later ten-tap sequence must be
// able to capture another failure in the same PWA document.
const activeBindings = new WeakMap<HTMLElement, AbortSignal>();

/**
 * Bind a ten-tap developer gesture without consuming or cancelling normal
 * carousel input. Returns false when there is no live target to bind.
 */
export function bindOnboardingDebugGesture({
  target,
  signal,
  onOpen,
  now = () => performance.now(),
}: OnboardingDebugGestureOptions): boolean {
  if (!target || signal.aborted || activeBindings.has(target)) return false;

  activeBindings.set(target, signal);
  signal.addEventListener(
    'abort',
    () => {
      if (activeBindings.get(target) === signal) activeBindings.delete(target);
    },
    { once: true },
  );

  let tapCount = 0;
  let sequenceStartedAt: number | null = null;
  let activeTap: ActivePointerTap | null = null;
  const activePointerIds = new Set<number>();
  let multiPointerBlocked = false;
  let lastPointerUpAt = Number.NEGATIVE_INFINITY;

  const resetSequence = (): void => {
    tapCount = 0;
    sequenceStartedAt = null;
  };

  const registerTap = (at: number): void => {
    if (
      sequenceStartedAt === null ||
      at < sequenceStartedAt ||
      at - sequenceStartedAt > TAP_SEQUENCE_WINDOW_MS
    ) {
      sequenceStartedAt = at;
      tapCount = 1;
    } else {
      tapCount += 1;
    }

    if (tapCount < REQUIRED_TAPS) return;

    resetSequence();
    activeTap = null;
    activePointerIds.clear();
    onOpen();
  };

  const handlePointerDown = (event: PointerEvent): void => {
    activePointerIds.add(event.pointerId);
    const unsupportedButton = event.pointerType === 'mouse' && event.button !== 0;
    if (activePointerIds.size !== 1 || !event.isPrimary || unsupportedButton) {
      multiPointerBlocked = true;
      activeTap = null;
      resetSequence();
      return;
    }

    activeTap = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: now(),
      moved: false,
    };
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (!activeTap || event.pointerId !== activeTap.id || activeTap.moved) return;
    const movedX = event.clientX - activeTap.startX;
    const movedY = event.clientY - activeTap.startY;
    if (Math.hypot(movedX, movedY) <= MAX_TAP_MOVEMENT_PX) return;

    activeTap.moved = true;
    resetSequence();
  };

  const handlePointerUp = (event: PointerEvent): void => {
    const at = now();
    // A conforming pointer-generated click follows pointerup. Remember every
    // pointerup (including an invalid swipe) so that click cannot be counted as
    // a second tap or turn a rejected gesture into a valid one.
    lastPointerUpAt = at;

    const tap = activeTap?.id === event.pointerId ? activeTap : null;
    activePointerIds.delete(event.pointerId);
    activeTap = null;

    if (multiPointerBlocked) {
      resetSequence();
      if (activePointerIds.size === 0) multiPointerBlocked = false;
      return;
    }

    const duration = tap ? at - tap.startedAt : Number.POSITIVE_INFINITY;
    if (!tap || tap.moved || duration < 0 || duration > MAX_TAP_DURATION_MS) {
      resetSequence();
      return;
    }

    registerTap(at);
  };

  const cancelPointerGesture = (event: PointerEvent): void => {
    const ownedActiveTap = activeTap?.id === event.pointerId;
    const ownedPointer = activePointerIds.delete(event.pointerId);
    // Touch browsers may emit pointerleave after a completed pointerup. That
    // trailing lifecycle event belongs to no active gesture and must not erase
    // the tap that pointerup just accepted.
    if (!ownedActiveTap && !ownedPointer) return;

    if (ownedActiveTap) activeTap = null;
    if (activePointerIds.size === 0) multiPointerBlocked = false;
    resetSequence();
  };

  const handleClick = (event: MouseEvent): void => {
    const at = now();

    // Pointer-capable browsers emit click immediately after pointerup. Keep
    // click as the desktop/legacy/keyboard fallback, but do not double-count
    // that synthesized event. Keyboard activation has detail === 0.
    if (event.detail !== 0 && at - lastPointerUpAt <= POINTER_CLICK_DEDUPE_MS) return;
    registerTap(at);
  };

  const listenerOptions = { passive: true, signal } as const;
  target.addEventListener('pointerdown', handlePointerDown, listenerOptions);
  target.addEventListener('pointermove', handlePointerMove, listenerOptions);
  target.addEventListener('pointerup', handlePointerUp, listenerOptions);
  target.addEventListener('pointercancel', cancelPointerGesture, listenerOptions);
  target.addEventListener('pointerleave', cancelPointerGesture, listenerOptions);
  target.addEventListener('click', handleClick, listenerOptions);

  return true;
}
