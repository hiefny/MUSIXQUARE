import { isYouTubePrimeReadyForGesture, waitForYouTubePrimeReady } from '../youtube/player.ts';

/** Reserve the next real tap for a ready iframe; never replay it asynchronously. */
export function gateSetupYouTubeGesture(options: {
  startButton: HTMLButtonElement | null;
  scanButton: HTMLButtonElement | null;
  waitingLabel: string;
  signal?: AbortSignal;
}): { readonly pending: boolean; cancel: () => void } {
  const controller = new AbortController();
  const start = options.startButton;
  const scan = options.scanButton;
  const label = start?.textContent ?? '';
  let pending = !isYouTubePrimeReadyForGesture() && !options.signal?.aborted;
  const release = (): void => {
    if (!pending) return;
    pending = false;
    if (start?.isConnected) {
      start.disabled = false;
      start.textContent = label;
      start.removeAttribute('aria-busy');
    }
    if (scan?.isConnected) {
      scan.disabled = false;
      scan.setAttribute('aria-busy', 'false');
    }
  };
  const cancel = (): void => {
    release();
    controller.abort();
    options.signal?.removeEventListener('abort', cancel);
  };
  if (pending) {
    if (start) {
      start.disabled = true;
      start.textContent = options.waitingLabel;
      start.setAttribute('aria-busy', 'true');
    }
    if (scan) {
      scan.disabled = true;
      scan.setAttribute('aria-busy', 'true');
    }
    options.signal?.addEventListener('abort', cancel, { once: true });
    void waitForYouTubePrimeReady(controller.signal).then(cancel, cancel);
  }
  return {
    get pending() {
      return pending;
    },
    cancel,
  };
}
