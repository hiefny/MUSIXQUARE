export interface ScreensaverEntry {
  readonly container: HTMLElement;
  readonly closed: boolean;
  onExit(listener: () => void): () => void;
  release(): void;
}

let currentEntry: ScreensaverEntry | null = null;

/** Keep the gesture-bound fullscreen request ahead of the lazy renderer import. */
export function beginScreensaverEntry(): ScreensaverEntry | null {
  if (currentEntry) return null;
  const previousFullscreen = document.fullscreenElement;
  const target = document.documentElement;
  const listeners = new Set<() => void>();
  let closed = false;
  let settled = true;
  let exiting = false;
  let sawFullscreen = Boolean(previousFullscreen);
  let requested = false;
  const unlock = (): void => {
    if (closed && settled && !exiting && currentEntry === entry) currentEntry = null;
  };
  const restore = (): void => {
    if (!requested || previousFullscreen || document.fullscreenElement !== target || exiting) {
      unlock();
      return;
    }
    exiting = true;
    try {
      Promise.resolve(document.exitFullscreen?.())
        .catch(() => {})
        .finally(() => {
          exiting = false;
          unlock();
        });
    } catch {
      exiting = false;
      unlock();
    }
  };
  const release = (): void => {
    if (closed) return;
    closed = true;
    listeners.clear();
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    restore();
  };
  const onFullscreenChange = (): void => {
    const expected = previousFullscreen || (requested ? target : null);
    if (expected && document.fullscreenElement === expected) {
      sawFullscreen = true;
    } else if (sawFullscreen) {
      const callbacks = [...listeners];
      release();
      for (const listener of callbacks) listener();
    }
  };
  const entry: ScreensaverEntry = {
    container:
      previousFullscreen instanceof HTMLElement && previousFullscreen !== document.documentElement
        ? previousFullscreen
        : document.body,
    get closed() {
      return closed;
    },
    onExit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    release,
  };
  currentEntry = entry;
  document.addEventListener('fullscreenchange', onFullscreenChange);
  if (!previousFullscreen && typeof target.requestFullscreen === 'function') {
    requested = true;
    settled = false;
    try {
      Promise.resolve(target.requestFullscreen())
        .then(() => {
          if (document.fullscreenElement === target) sawFullscreen = true;
        })
        .catch(() => {})
        .finally(() => {
          settled = true;
          if (closed) restore();
        });
    } catch {
      settled = true;
      requested = false;
    }
  }
  return entry;
}
