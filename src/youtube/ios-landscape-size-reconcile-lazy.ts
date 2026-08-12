import type { YouTubePlayerInstance } from './_state.ts';
import type {
  YouTubeLandscapeSizeReconciler,
  YouTubeLandscapeSizeReconcilerDependencies,
} from './ios-landscape-size-reconcile.ts';

type ReconcilerModule = typeof import('./ios-landscape-size-reconcile.ts');

interface LazyReconcilerDependencies {
  isIOS: () => boolean;
  load: () => Promise<ReconcilerModule>;
  reconcilerDependencies: YouTubeLandscapeSizeReconcilerDependencies;
}

interface LazyYouTubeLandscapeSizeReconciler {
  start(player: YouTubePlayerInstance, sessionId: number, container: HTMLElement): void;
  refresh(): void;
  refreshAfterFirstMediaState(player: YouTubePlayerInstance, sessionId: number): void;
  stop(): void;
}

type PendingStart = {
  player: YouTubePlayerInstance;
  sessionId: number;
  container: HTMLElement;
  generation: number;
  refreshPending: boolean;
  firstMediaStatePending: boolean;
};

/** Keep the iOS-only workaround out of the eager app chunk and fence every
 * operation that can arrive while its single dynamic import is pending. */
export function createLazyYouTubeLandscapeSizeReconciler(
  dependencies: LazyReconcilerDependencies,
): LazyYouTubeLandscapeSizeReconciler {
  let generation = 0;
  let pendingStart: PendingStart | null = null;
  let reconciler: YouTubeLandscapeSizeReconciler | null = null;
  let loadedModule: ReconcilerModule | null | undefined;
  let loadPromise: Promise<ReconcilerModule | null> | null = null;

  const loadOnce = (): Promise<ReconcilerModule | null> => {
    if (loadedModule !== undefined) return Promise.resolve(loadedModule);
    loadPromise ??= dependencies
      .load()
      .then((module) => {
        loadedModule = module;
        return module;
      })
      .catch(() => {
        // Cache failure as a graceful no-op. Retrying the same chunk URL in
        // this document cannot repair a failed deployment/network response.
        loadedModule = null;
        return null;
      });
    return loadPromise;
  };

  const activate = (request: PendingStart, module: ReconcilerModule): void => {
    if (pendingStart !== request || request.generation !== generation) return;
    reconciler ??= module.createYouTubeLandscapeSizeReconciler(dependencies.reconcilerDependencies);
    reconciler.start(request.player, request.sessionId, request.container);
    if (request.firstMediaStatePending) {
      reconciler.refreshAfterFirstMediaState(request.player, request.sessionId);
    } else if (request.refreshPending) {
      reconciler.refresh();
    }
  };

  const start = (
    player: YouTubePlayerInstance,
    sessionId: number,
    container: HTMLElement,
  ): void => {
    generation += 1;
    reconciler?.stop();
    pendingStart = null;
    if (!dependencies.isIOS()) return;

    const request: PendingStart = {
      player,
      sessionId,
      container,
      generation,
      refreshPending: false,
      firstMediaStatePending: false,
    };
    pendingStart = request;
    if (loadedModule) {
      activate(request, loadedModule);
      return;
    }
    void loadOnce().then((module) => {
      if (module) activate(request, module);
    });
  };

  const refresh = (): void => {
    if (!pendingStart) return;
    if (reconciler && loadedModule) {
      reconciler.refresh();
      return;
    }
    pendingStart.refreshPending = true;
  };

  const refreshAfterFirstMediaState = (player: YouTubePlayerInstance, sessionId: number): void => {
    const request = pendingStart;
    if (!request || request.player !== player || request.sessionId !== sessionId) return;
    if (reconciler && loadedModule) {
      reconciler.refreshAfterFirstMediaState(player, sessionId);
      return;
    }
    request.firstMediaStatePending = true;
  };

  const stop = (): void => {
    generation += 1;
    pendingStart = null;
    reconciler?.stop();
  };

  return { start, refresh, refreshAfterFirstMediaState, stop };
}
