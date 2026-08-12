import type { YouTubePlayerInstance } from './_state.ts';

const MIN_VISIBLE_PLAYER_EDGE_PX = 200;

type FrameRequest = (callback: FrameRequestCallback) => number;
type FrameCancel = (handle: number) => void;

export interface YouTubeLandscapeSizeReconcilerDependencies {
  isIOS: () => boolean;
  isLandscape: () => boolean;
  isYouTubePlaybackActive: () => boolean;
  getCurrentPlayer: () => YouTubePlayerInstance | null;
  getCurrentSessionId: () => number;
  getCurrentContainer: () => HTMLElement | null;
  requestFrame: FrameRequest;
  cancelFrame: FrameCancel;
  createResizeObserver: (callback: ResizeObserverCallback) => ResizeObserver | null;
  subscribeOrientationChange: (callback: () => void) => () => void;
  subscribeFullscreenChange: (callback: () => void) => () => void;
  scheduleSettledRefresh: (callback: () => void, delayMs: number) => number;
  cancelSettledRefresh: (handle: number) => void;
}

export interface YouTubeLandscapeSizeReconciler {
  start(player: YouTubePlayerInstance, sessionId: number, container: HTMLElement): void;
  refresh(): void;
  refreshAfterFirstMediaState(player: YouTubePlayerInstance, sessionId: number): void;
  stop(): void;
}

type Owner = {
  player: YouTubePlayerInstance;
  sessionId: number;
  container: HTMLElement;
  generation: number;
};

type MeasuredSize = {
  width: number;
  height: number;
};

type IframeSizeSnapshot = {
  iframe: HTMLIFrameElement;
  widthAttribute: string | null;
  heightAttribute: string | null;
  inlineWidth: string;
  inlineHeight: string;
};

/**
 * Reconcile an iOS WebKit video compositor that can retain a stale landscape
 * safe-area offset inside an otherwise correctly-positioned YouTube iframe.
 *
 * The public IFrame API is the only cross-origin surface available to the
 * host page. A one-CSS-pixel width pulse makes WebKit rebuild the native video
 * layer; the exact container size is restored on the following animation
 * frame. No playback, seek, volume, or iframe-positioning API is touched.
 */
export function createYouTubeLandscapeSizeReconciler(
  dependencies: YouTubeLandscapeSizeReconcilerDependencies,
): YouTubeLandscapeSizeReconciler {
  let owner: Owner | null = null;
  let observer: ResizeObserver | null = null;
  let measureFrame: number | null = null;
  let restoreFrame: number | null = null;
  let pendingIframeRestore: IframeSizeSnapshot | null = null;
  let rerunAfterRestore = false;
  let firstMediaStateSeen = false;
  let unsubscribeOrientationChange: (() => void) | null = null;
  let unsubscribeFullscreenChange: (() => void) | null = null;
  let settledTransitionRefresh: number | null = null;
  let generation = 0;

  const restoreIframeSize = (snapshot: IframeSizeSnapshot | null): void => {
    if (!snapshot || !snapshot.iframe.isConnected) return;
    if (snapshot.widthAttribute === null) snapshot.iframe.removeAttribute('width');
    else snapshot.iframe.setAttribute('width', snapshot.widthAttribute);
    if (snapshot.heightAttribute === null) snapshot.iframe.removeAttribute('height');
    else snapshot.iframe.setAttribute('height', snapshot.heightAttribute);
    snapshot.iframe.style.width = snapshot.inlineWidth;
    snapshot.iframe.style.height = snapshot.inlineHeight;
  };

  const cancelScheduledFrames = (): void => {
    if (measureFrame !== null) dependencies.cancelFrame(measureFrame);
    if (restoreFrame !== null) dependencies.cancelFrame(restoreFrame);
    measureFrame = null;
    restoreFrame = null;
    rerunAfterRestore = false;
  };

  const stop = (): void => {
    generation += 1;
    if (settledTransitionRefresh !== null) {
      dependencies.cancelSettledRefresh(settledTransitionRefresh);
      settledTransitionRefresh = null;
    }
    unsubscribeOrientationChange?.();
    unsubscribeOrientationChange = null;
    unsubscribeFullscreenChange?.();
    unsubscribeFullscreenChange = null;
    firstMediaStateSeen = false;
    restoreIframeSize(pendingIframeRestore);
    pendingIframeRestore = null;
    cancelScheduledFrames();
    observer?.disconnect();
    observer = null;
    owner = null;
  };

  const isOwnerCurrent = (candidate: Owner): boolean =>
    owner === candidate &&
    candidate.generation === generation &&
    dependencies.getCurrentPlayer() === candidate.player &&
    dependencies.getCurrentSessionId() === candidate.sessionId &&
    dependencies.getCurrentContainer() === candidate.container &&
    candidate.container.isConnected;

  const readVisibleLandscapeSize = (candidate: Owner): MeasuredSize | null => {
    if (
      !isOwnerCurrent(candidate) ||
      !dependencies.isIOS() ||
      !dependencies.isLandscape() ||
      !dependencies.isYouTubePlaybackActive()
    ) {
      return null;
    }

    const rect = candidate.container.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < MIN_VISIBLE_PLAYER_EDGE_PX ||
      height < MIN_VISIBLE_PLAYER_EDGE_PX
    ) {
      return null;
    }
    return { width, height };
  };

  const snapshotCurrentIframeSize = (candidate: Owner): IframeSizeSnapshot | null => {
    let iframe: HTMLIFrameElement | null = null;
    try {
      iframe = candidate.player.getIframe?.() ?? null;
    } catch {
      // A facade can briefly reject API reads while its iframe is settling.
    }
    iframe ??= candidate.container.querySelector('iframe');
    if (!iframe || !iframe.isConnected || !candidate.container.contains(iframe)) return null;
    return {
      iframe,
      widthAttribute: iframe.getAttribute('width'),
      heightAttribute: iframe.getAttribute('height'),
      inlineWidth: iframe.style.width,
      inlineHeight: iframe.style.height,
    };
  };

  const schedule = (): void => {
    if (!owner || measureFrame !== null) return;
    if (restoreFrame !== null) {
      rerunAfterRestore = true;
      return;
    }

    measureFrame = dependencies.requestFrame(() => {
      measureFrame = null;
      const candidate = owner;
      if (!candidate || typeof candidate.player.setSize !== 'function') return;
      const size = readVisibleLandscapeSize(candidate);
      if (!size) return;
      const iframeSize = snapshotCurrentIframeSize(candidate);
      if (!iframeSize) return;
      pendingIframeRestore = iframeSize;

      try {
        // The extra pixel is clipped by the existing video wrapper and lasts
        // for at most one frame. It invalidates only the native video layer;
        // the iframe's position and YouTube's DOM overlays stay untouched.
        candidate.player.setSize(size.width + 1, size.height);
      } catch {
        restoreIframeSize(pendingIframeRestore);
        pendingIframeRestore = null;
        return;
      }

      restoreFrame = dependencies.requestFrame(() => {
        restoreFrame = null;
        const restore = pendingIframeRestore;
        pendingIframeRestore = null;
        // setSize writes numeric iframe dimensions. Restore the exact prior
        // responsive contract (normally width/height="100%") directly;
        // another numeric setSize(W,H) would leave future rotations stale.
        restoreIframeSize(restore);
        const currentSize = readVisibleLandscapeSize(candidate);
        if (
          isOwnerCurrent(candidate) &&
          (currentSize?.width !== size.width || currentSize.height !== size.height)
        ) {
          rerunAfterRestore = true;
        }

        if (rerunAfterRestore) {
          rerunAfterRestore = false;
          schedule();
        }
      });
    });
  };

  const start = (
    player: YouTubePlayerInstance,
    sessionId: number,
    container: HTMLElement,
  ): void => {
    stop();
    if (!dependencies.isIOS() || typeof player.setSize !== 'function') return;

    owner = { player, sessionId, container, generation };
    firstMediaStateSeen = false;
    observer = dependencies.createResizeObserver(schedule);
    observer?.observe(container);
    const handleViewportTransition = (): void => {
      schedule();
      if (settledTransitionRefresh !== null) {
        dependencies.cancelSettledRefresh(settledTransitionRefresh);
      }
      settledTransitionRefresh = dependencies.scheduleSettledRefresh(() => {
        settledTransitionRefresh = null;
        schedule();
      }, 500);
    };
    unsubscribeOrientationChange =
      dependencies.subscribeOrientationChange(handleViewportTransition);
    unsubscribeFullscreenChange = dependencies.subscribeFullscreenChange(handleViewportTransition);
    schedule();
  };

  const refreshAfterFirstMediaState = (player: YouTubePlayerInstance, sessionId: number): void => {
    const candidate = owner;
    if (
      firstMediaStateSeen ||
      !candidate ||
      candidate.player !== player ||
      candidate.sessionId !== sessionId ||
      !isOwnerCurrent(candidate)
    ) {
      return;
    }
    firstMediaStateSeen = true;
    schedule();
  };

  return {
    start,
    refresh: schedule,
    refreshAfterFirstMediaState,
    stop,
  };
}
