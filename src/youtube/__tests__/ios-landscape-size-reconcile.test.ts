/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { YouTubePlayerInstance } from '../_state.ts';
import { createYouTubeLandscapeSizeReconciler } from '../ios-landscape-size-reconcile.ts';

type ResizeObserverHarness = {
  callback: ResizeObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

function createHarness() {
  let ios = true;
  let landscape = true;
  let playbackActive = true;
  let sessionId = 7;
  let width = 640;
  let height = 360;
  let currentPlayer: YouTubePlayerInstance | null = null;
  let currentContainer: HTMLElement | null = null;
  let nextFrameId = 0;
  let nextSettledRefreshId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const settledRefreshes = new Map<number, () => void>();
  const observers: ResizeObserverHarness[] = [];
  const orientationUnsubscribes: Array<ReturnType<typeof vi.fn>> = [];
  const fullscreenUnsubscribes: Array<ReturnType<typeof vi.fn>> = [];
  let orientationCallback: (() => void) | null = null;
  let fullscreenCallback: (() => void) | null = null;
  const cancelSettledRefresh = vi.fn((handle: number) => {
    settledRefreshes.delete(handle);
  });

  const container = document.createElement('div');
  const iframe = document.createElement('iframe');
  iframe.setAttribute('width', '100%');
  iframe.setAttribute('height', '100%');
  container.appendChild(iframe);
  document.body.appendChild(container);
  vi.spyOn(container, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        width,
        height,
        toJSON: () => ({}),
      }) as DOMRect,
  );

  const playerSetSize = vi.fn((nextWidth: number, nextHeight: number) => {
    iframe.setAttribute('width', String(nextWidth));
    iframe.setAttribute('height', String(nextHeight));
  });
  const player = {
    setSize: playerSetSize,
    getIframe: vi.fn(() => iframe),
    playVideo: vi.fn(),
    pauseVideo: vi.fn(),
    seekTo: vi.fn(),
    setVolume: vi.fn(),
  } as unknown as YouTubePlayerInstance;
  currentPlayer = player;
  currentContainer = container;

  const dependencies = {
    isIOS: () => ios,
    isLandscape: () => landscape,
    isYouTubePlaybackActive: () => playbackActive,
    getCurrentPlayer: () => currentPlayer,
    getCurrentSessionId: () => sessionId,
    getCurrentContainer: () => currentContainer,
    requestFrame: (callback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
    createResizeObserver: (callback) => {
      const harness: ResizeObserverHarness = {
        callback,
        observe: vi.fn(),
        disconnect: vi.fn(),
      };
      observers.push(harness);
      return harness as unknown as ResizeObserver;
    },
    subscribeOrientationChange: (callback) => {
      orientationCallback = callback;
      const unsubscribe = vi.fn(() => {
        if (orientationCallback === callback) orientationCallback = null;
      });
      orientationUnsubscribes.push(unsubscribe);
      return unsubscribe;
    },
    subscribeFullscreenChange: (callback) => {
      fullscreenCallback = callback;
      const unsubscribe = vi.fn(() => {
        if (fullscreenCallback === callback) fullscreenCallback = null;
      });
      fullscreenUnsubscribes.push(unsubscribe);
      return unsubscribe;
    },
    scheduleSettledRefresh: (callback) => {
      const id = ++nextSettledRefreshId;
      settledRefreshes.set(id, callback);
      return id;
    },
    cancelSettledRefresh,
  } satisfies Parameters<typeof createYouTubeLandscapeSizeReconciler>[0];

  const runFrame = (): void => {
    const ready = [...frames.values()];
    frames.clear();
    for (const callback of ready) callback(performance.now());
  };

  const triggerResize = (): void => {
    const observer = observers.at(-1);
    observer?.callback([], observer as unknown as ResizeObserver);
  };

  const triggerOrientationChange = (): void => {
    orientationCallback?.();
  };

  const triggerFullscreenChange = (): void => {
    fullscreenCallback?.();
  };

  const runSettledRefreshes = (): void => {
    const ready = [...settledRefreshes.values()];
    settledRefreshes.clear();
    for (const callback of ready) callback();
  };

  return {
    container,
    iframe,
    player,
    playerSetSize,
    observers,
    orientationUnsubscribes,
    fullscreenUnsubscribes,
    frames,
    settledRefreshes,
    cancelSettledRefresh,
    dependencies,
    runFrame,
    triggerResize,
    triggerOrientationChange,
    triggerFullscreenChange,
    runSettledRefreshes,
    setIOS: (value: boolean) => {
      ios = value;
    },
    setLandscape: (value: boolean) => {
      landscape = value;
    },
    setPlaybackActive: (value: boolean) => {
      playbackActive = value;
    },
    setSessionId: (value: number) => {
      sessionId = value;
    },
    setCurrentPlayer: (value: YouTubePlayerInstance | null) => {
      currentPlayer = value;
    },
    setCurrentContainer: (value: HTMLElement | null) => {
      currentContainer = value;
    },
    setDimensions: (nextWidth: number, nextHeight: number) => {
      width = nextWidth;
      height = nextHeight;
    },
  };
}

describe('iOS landscape YouTube size reconciliation', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pulses the exact visible height and restores the responsive iframe contract', () => {
    const harness = createHarness();
    harness.iframe.style.width = '100%';
    harness.iframe.style.height = '100%';
    const reconciler = createYouTubeLandscapeSizeReconciler(harness.dependencies);

    reconciler.start(harness.player, 7, harness.container);
    harness.runFrame();

    expect(harness.playerSetSize).toHaveBeenCalledOnce();
    expect(harness.playerSetSize).toHaveBeenCalledWith(641, 360);
    expect(harness.iframe.getAttribute('width')).toBe('641');
    expect(harness.iframe.getAttribute('height')).toBe('360');

    harness.runFrame();

    expect(harness.iframe.getAttribute('width')).toBe('100%');
    expect(harness.iframe.getAttribute('height')).toBe('100%');
    expect(harness.iframe.style.width).toBe('100%');
    expect(harness.iframe.style.height).toBe('100%');
    expect(harness.player.playVideo).not.toHaveBeenCalled();
    expect(harness.player.pauseVideo).not.toHaveBeenCalled();
    expect(harness.player.seekTo).not.toHaveBeenCalled();
    expect(harness.player.setVolume).not.toHaveBeenCalled();
  });

  it('restores exact attrs and inline styles when setSize partially mutates then throws', () => {
    const harness = createHarness();
    harness.iframe.setAttribute('width', '100%');
    harness.iframe.setAttribute('height', '91%');
    harness.iframe.style.width = 'calc(100% - 2px)';
    harness.iframe.style.height = '77%';
    harness.playerSetSize.mockImplementation((width, height) => {
      harness.iframe.setAttribute('width', String(width));
      harness.iframe.setAttribute('height', String(height));
      harness.iframe.style.width = `${width}px`;
      harness.iframe.style.height = `${height}px`;
      throw new Error('player teardown');
    });
    const reconciler = createYouTubeLandscapeSizeReconciler(harness.dependencies);

    reconciler.start(harness.player, 7, harness.container);
    harness.runFrame();

    expect(harness.iframe.getAttribute('width')).toBe('100%');
    expect(harness.iframe.getAttribute('height')).toBe('91%');
    expect(harness.iframe.style.width).toBe('calc(100% - 2px)');
    expect(harness.iframe.style.height).toBe('77%');
    expect(harness.frames).toHaveLength(0);
    expect(harness.player.playVideo).not.toHaveBeenCalled();
    expect(harness.player.pauseVideo).not.toHaveBeenCalled();
    expect(harness.player.seekTo).not.toHaveBeenCalled();
    expect(harness.player.setVolume).not.toHaveBeenCalled();
  });

  it('coalesces repeated refresh and ResizeObserver requests into one pulse', () => {
    const harness = createHarness();
    const reconciler = createYouTubeLandscapeSizeReconciler(harness.dependencies);

    reconciler.start(harness.player, 7, harness.container);
    reconciler.refresh();
    reconciler.refresh();
    harness.triggerResize();

    expect(harness.frames).toHaveLength(1);
    harness.runFrame();
    expect(harness.playerSetSize).toHaveBeenCalledOnce();
    harness.runFrame();
    expect(harness.playerSetSize).toHaveBeenCalledOnce();
  });

  it('pulses on a same-size 180-degree orientation change and once more after settling', () => {
    const harness = createHarness();
    const reconciler = createYouTubeLandscapeSizeReconciler(harness.dependencies);
    reconciler.start(harness.player, 7, harness.container);
    harness.runFrame();
    harness.runFrame();
    harness.playerSetSize.mockClear();

    harness.triggerOrientationChange();
    harness.runFrame();
    harness.runFrame();
    expect(harness.playerSetSize).toHaveBeenCalledOnce();
    expect(harness.playerSetSize).toHaveBeenLastCalledWith(641, 360);

    harness.runSettledRefreshes();
    harness.runFrame();
    harness.runFrame();
    expect(harness.playerSetSize).toHaveBeenCalledTimes(2);
  });

  it('coalesces repeated orientation events onto one settled refresh', () => {
    const harness = createHarness();
    const reconciler = createYouTubeLandscapeSizeReconciler(harness.dependencies);
    reconciler.start(harness.player, 7, harness.container);
    harness.runFrame();
    harness.runFrame();
    harness.playerSetSize.mockClear();

    harness.triggerOrientationChange();
    harness.triggerOrientationChange();

    expect(harness.settledRefreshes).toHaveLength(1);
    expect(harness.cancelSettledRefresh).toHaveBeenCalledOnce();
    harness.runFrame();
    harness.runFrame();
    expect(harness.playerSetSize).toHaveBeenCalledOnce();

    harness.runSettledRefreshes();
    harness.runFrame();
    harness.runFrame();
    expect(harness.playerSetSize).toHaveBeenCalledTimes(2);
  });

  it('coalesces standard and WebKit fullscreen events with one settled refresh', () => {
    const harness = createHarness();
    const reconciler = createYouTubeLandscapeSizeReconciler(harness.dependencies);
    reconciler.start(harness.player, 7, harness.container);
    harness.runFrame();
    harness.runFrame();
    harness.playerSetSize.mockClear();

    // The production subscription routes both fullscreenchange spellings to
    // this callback; WebKit can dispatch both for the same top-layer change.
    harness.triggerFullscreenChange();
    harness.triggerFullscreenChange();

    expect(harness.settledRefreshes).toHaveLength(1);
    expect(harness.cancelSettledRefresh).toHaveBeenCalledOnce();
    harness.runFrame();
    harness.runFrame();
    expect(harness.playerSetSize).toHaveBeenCalledOnce();

    harness.runSettledRefreshes();
    harness.runFrame();
    harness.runFrame();
    expect(harness.playerSetSize).toHaveBeenCalledTimes(2);
  });

  it('adds only one post-ready pulse for the first accepted media state per session', () => {
    const harness = createHarness();
    const reconciler = createYouTubeLandscapeSizeReconciler(harness.dependencies);
    reconciler.start(harness.player, 7, harness.container);
    harness.runFrame();
    harness.runFrame();
    harness.playerSetSize.mockClear();

    reconciler.refreshAfterFirstMediaState(harness.player, 7);
    reconciler.refreshAfterFirstMediaState(harness.player, 7);
    reconciler.refreshAfterFirstMediaState(harness.player, 7);
    harness.runFrame();
    harness.runFrame();

    expect(harness.playerSetSize).toHaveBeenCalledOnce();
    expect(harness.frames).toHaveLength(0);
    reconciler.refreshAfterFirstMediaState(harness.player, 7);
    harness.runFrame();
    expect(harness.playerSetSize).toHaveBeenCalledOnce();
  });

  it('uses the queued ready frame as the post-media pulse when state arrives before it', () => {
    const harness = createHarness();
    const reconciler = createYouTubeLandscapeSizeReconciler(harness.dependencies);

    reconciler.start(harness.player, 7, harness.container);
    reconciler.refreshAfterFirstMediaState(harness.player, 7);
    harness.runFrame();
    harness.runFrame();

    expect(harness.playerSetSize).toHaveBeenCalledOnce();
    expect(harness.playerSetSize).toHaveBeenCalledWith(641, 360);
  });

  it('queues a post-media pulse when state arrives after phase A but before restore', () => {
    const harness = createHarness();
    const reconciler = createYouTubeLandscapeSizeReconciler(harness.dependencies);

    reconciler.start(harness.player, 7, harness.container);
    harness.runFrame();
    reconciler.refreshAfterFirstMediaState(harness.player, 7);
    harness.runFrame();
    harness.runFrame();
    harness.runFrame();

    expect(harness.playerSetSize).toHaveBeenCalledTimes(2);
    expect(harness.playerSetSize).toHaveBeenNthCalledWith(1, 641, 360);
    expect(harness.playerSetSize).toHaveBeenNthCalledWith(2, 641, 360);
  });

  it('skips a parked 1px iframe and pulses after ResizeObserver sees its visible restore', () => {
    const harness = createHarness();
    harness.setDimensions(1, 1);
    const reconciler = createYouTubeLandscapeSizeReconciler(harness.dependencies);

    reconciler.start(harness.player, 7, harness.container);
    harness.runFrame();
    expect(harness.playerSetSize).not.toHaveBeenCalled();

    harness.setDimensions(720, 405);
    harness.triggerResize();
    harness.runFrame();
    expect(harness.playerSetSize).toHaveBeenCalledWith(721, 405);
    harness.runFrame();
    expect(harness.iframe.getAttribute('width')).toBe('100%');
  });

  it('fences stale player, session, and container identities', () => {
    const harness = createHarness();
    const reconciler = createYouTubeLandscapeSizeReconciler(harness.dependencies);

    reconciler.start(harness.player, 7, harness.container);
    harness.setSessionId(8);
    harness.runFrame();
    expect(harness.playerSetSize).not.toHaveBeenCalled();

    harness.setSessionId(7);
    reconciler.refresh();
    harness.setCurrentPlayer({} as YouTubePlayerInstance);
    harness.runFrame();
    expect(harness.playerSetSize).not.toHaveBeenCalled();

    harness.setCurrentPlayer(harness.player);
    reconciler.refresh();
    harness.setCurrentContainer(document.createElement('div'));
    harness.runFrame();
    expect(harness.playerSetSize).not.toHaveBeenCalled();
  });

  it('does nothing outside iOS landscape active playback', () => {
    const nonIOS = createHarness();
    nonIOS.setIOS(false);
    const nonIOSReconciler = createYouTubeLandscapeSizeReconciler(nonIOS.dependencies);
    nonIOSReconciler.start(nonIOS.player, 7, nonIOS.container);
    nonIOS.runFrame();
    expect(nonIOS.observers).toHaveLength(0);
    expect(nonIOS.playerSetSize).not.toHaveBeenCalled();

    const portrait = createHarness();
    portrait.setLandscape(false);
    const portraitReconciler = createYouTubeLandscapeSizeReconciler(portrait.dependencies);
    portraitReconciler.start(portrait.player, 7, portrait.container);
    portrait.runFrame();
    expect(portrait.playerSetSize).not.toHaveBeenCalled();

    portrait.setLandscape(true);
    portrait.setPlaybackActive(false);
    portrait.triggerResize();
    portrait.runFrame();
    expect(portrait.playerSetSize).not.toHaveBeenCalled();
  });

  it('restores a pulsed iframe and disconnects pending work on stop/reset', () => {
    const harness = createHarness();
    const reconciler = createYouTubeLandscapeSizeReconciler(harness.dependencies);

    reconciler.start(harness.player, 7, harness.container);
    harness.runFrame();
    expect(harness.iframe.getAttribute('width')).toBe('641');

    reconciler.stop();

    expect(harness.iframe.getAttribute('width')).toBe('100%');
    expect(harness.iframe.getAttribute('height')).toBe('100%');
    expect(harness.observers[0]?.disconnect).toHaveBeenCalledOnce();
    expect(harness.frames).toHaveLength(0);

    harness.triggerOrientationChange();
    expect(harness.frames).toHaveLength(0);

    reconciler.start(harness.player, 7, harness.container);
    expect(harness.observers[0]?.disconnect).toHaveBeenCalledOnce();
    expect(harness.observers[1]?.observe).toHaveBeenCalledWith(harness.container);
  });

  it('removes the orientation listener and cancels its settled refresh on stop', () => {
    const harness = createHarness();
    const reconciler = createYouTubeLandscapeSizeReconciler(harness.dependencies);
    reconciler.start(harness.player, 7, harness.container);
    harness.runFrame();
    harness.runFrame();

    harness.triggerOrientationChange();
    expect(harness.settledRefreshes).toHaveLength(1);
    reconciler.stop();

    expect(harness.orientationUnsubscribes[0]).toHaveBeenCalledOnce();
    expect(harness.fullscreenUnsubscribes[0]).toHaveBeenCalledOnce();
    expect(harness.cancelSettledRefresh).toHaveBeenCalledOnce();
    expect(harness.settledRefreshes).toHaveLength(0);
    harness.runSettledRefreshes();
    harness.runFrame();
    expect(harness.frames).toHaveLength(0);
  });

  it('restores the same connected iframe when identity goes stale between pulse phases', () => {
    const harness = createHarness();
    const reconciler = createYouTubeLandscapeSizeReconciler(harness.dependencies);

    reconciler.start(harness.player, 7, harness.container);
    harness.runFrame();
    expect(harness.iframe.getAttribute('width')).toBe('641');

    harness.setCurrentPlayer({} as YouTubePlayerInstance);
    harness.setSessionId(8);
    harness.runFrame();

    expect(harness.iframe.getAttribute('width')).toBe('100%');
    expect(harness.iframe.getAttribute('height')).toBe('100%');
    expect(harness.playerSetSize).toHaveBeenCalledOnce();
  });
});
