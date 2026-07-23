export type ChatDrawerDetent = 'half' | 'full';
type ChatDrawerReleaseTarget = ChatDrawerDetent | 'closed';

const CHAT_DRAWER_EXPAND_THRESHOLD = 72;
const CHAT_DRAWER_COLLAPSE_THRESHOLD = 72;
const CHAT_DRAWER_DISMISS_THRESHOLD = 100;
const CHAT_DRAWER_FULL_DISMISS_MIN = 220;
const CHAT_DRAWER_FULL_DISMISS_RATIO = 0.35;

const CHAT_DRAWER_DESKTOP_MIN_WIDTH = 1280;
const CHAT_DRAWER_MIN_HALF_HEIGHT = 300;
const CHAT_DRAWER_MIN_COLLAPSIBLE_PORTRAIT_HEIGHT = 640;
const CHAT_DRAWER_STAGE_CLEARANCE = 12;
const CHAT_DRAWER_FALLBACK_HALF_MIN_VIEWPORT_HEIGHT = 720;

export interface ChatDrawerViewportContext {
  viewportWidth: number;
  viewportHeight: number;
  isPortrait: boolean;
  stageBottom: number | null;
}

/**
 * Whether a bottom-anchored 50% sheet leaves enough useful room above it.
 *
 * Portrait keeps the established half-height entry point. Landscape requires
 * the half sheet to clear the visible media stage, so foldables can use the
 * intermediate detent without covering the YouTube frame while short phones
 * retain the existing full-height drawer.
 */
export function canUseChatDrawerHalfDetent(context: ChatDrawerViewportContext): boolean {
  const { viewportWidth, viewportHeight, isPortrait, stageBottom } = context;
  if (viewportWidth >= CHAT_DRAWER_DESKTOP_MIN_WIDTH || viewportHeight <= 0) return false;
  if (isPortrait) return true;

  const halfHeight = viewportHeight * 0.5;
  if (halfHeight < CHAT_DRAWER_MIN_HALF_HEIGHT) return false;

  const halfTop = viewportHeight - halfHeight;
  if (stageBottom !== null && stageBottom > 0) {
    return halfTop >= stageBottom + CHAT_DRAWER_STAGE_CLEARANCE;
  }

  return viewportHeight >= CHAT_DRAWER_FALLBACK_HALF_MIN_VIEWPORT_HEIGHT;
}

export function canExpandChatDrawer(context: ChatDrawerViewportContext): boolean {
  return canUseChatDrawerHalfDetent(context);
}

/**
 * Short portrait screens may still expand from the familiar half-height entry
 * point, but collapsing full back to half would leave too little useful room.
 * On those screens a downward full-sheet gesture closes it directly.
 */
export function canCollapseChatDrawerFullToHalf(context: ChatDrawerViewportContext): boolean {
  if (!canUseChatDrawerHalfDetent(context)) return false;
  if (!context.isPortrait) return true;
  return context.viewportHeight >= CHAT_DRAWER_MIN_COLLAPSIBLE_PORTRAIT_HEIGHT;
}

export function getInitialChatDrawerDetent(context: ChatDrawerViewportContext): ChatDrawerDetent {
  return canUseChatDrawerHalfDetent(context) ? 'half' : 'full';
}

export function getChatDrawerFullDismissThreshold(viewportHeight: number): number {
  return Math.max(CHAT_DRAWER_FULL_DISMISS_MIN, viewportHeight * CHAT_DRAWER_FULL_DISMISS_RATIO);
}

interface ChatDrawerReleaseContext {
  startDetent: ChatDrawerDetent;
  deltaY: number;
  canExpand: boolean;
  canCollapseFullToHalf: boolean;
  fullDismissThreshold?: number;
  cancelled?: boolean;
}

/**
 * Ordinary drags cross one detent. A deliberately long full-height drag may
 * skip the intermediate detent when the caller supplies a full-dismiss
 * threshold, matching familiar mobile-sheet behavior without making a small
 * downward gesture destructive.
 */
export function resolveChatDrawerRelease(
  context: ChatDrawerReleaseContext,
): ChatDrawerReleaseTarget {
  const {
    startDetent,
    deltaY,
    canExpand,
    canCollapseFullToHalf,
    fullDismissThreshold = Number.POSITIVE_INFINITY,
    cancelled = false,
  } = context;
  if (cancelled) return startDetent;

  if (startDetent === 'half') {
    if (deltaY <= -CHAT_DRAWER_EXPAND_THRESHOLD && canExpand) return 'full';
    if (deltaY >= CHAT_DRAWER_DISMISS_THRESHOLD) return 'closed';
    return 'half';
  }

  if (deltaY < CHAT_DRAWER_COLLAPSE_THRESHOLD) return 'full';
  if (canCollapseFullToHalf) {
    return deltaY >= fullDismissThreshold ? 'closed' : 'half';
  }
  return deltaY >= CHAT_DRAWER_DISMISS_THRESHOLD ? 'closed' : 'full';
}
