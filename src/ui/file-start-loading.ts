import { getExistingAudioContext } from '../audio/context.ts';
import { createBusScope } from '../core/events.ts';
import {
  getLocalFilePendingStartDeadlineMs,
  isLocalFileStartPending,
} from '../player/transport.ts';

const MIN_CHECK_DELAY_MS = 16;
const INITIAL_STALLED_CHECK_DELAY_MS = 100;
const MAX_STALLED_CHECK_DELAY_MS = 1_000;

/** Projects an installed future source into the existing loading indicators. */
export function createFileStartLoadingController(onChange: (pending: boolean) => void): {
  destroy: () => void;
} {
  const scope = createBusScope();
  const abortController = new AbortController();
  let timer = 0;
  let context: AudioContext | null = null;
  let pending: boolean | undefined;
  let stalledCheckDelayMs = 0;
  let destroyed = false;

  function cancelTimer(): void {
    if (timer) window.clearTimeout(timer);
    timer = 0;
  }

  function refresh(): void {
    if (destroyed) return;
    cancelTimer();
    const currentContext = getExistingAudioContext();
    if (context !== currentContext) {
      context?.removeEventListener('statechange', onContextStateChange);
      context = currentContext;
      context?.addEventListener('statechange', onContextStateChange);
      stalledCheckDelayMs = 0;
    }

    const nextPending = isLocalFileStartPending();
    if (pending !== nextPending) {
      pending = nextPending;
      onChange(nextPending);
    }
    if (!nextPending) {
      stalledCheckDelayMs = 0;
      return;
    }
    if (destroyed || !context || context.state !== 'running') return;

    const scheduledContext = context;
    const audioTime = context.currentTime;
    const deadline = getLocalFilePendingStartDeadlineMs();
    const remainingMs = deadline === undefined ? MIN_CHECK_DELAY_MS : deadline - performance.now();
    timer = window.setTimeout(
      () => {
        timer = 0;
        if (destroyed || context !== scheduledContext) return;
        const progressed = context.currentTime > audioTime;
        // A running context can expose the same clock value across short
        // samples on Android, then advance without a statechange. Keep checking
        // until the source starts; back off a frozen clock instead of either
        // spinning every frame or leaving the loading controls stuck forever.
        stalledCheckDelayMs = progressed
          ? 0
          : Math.min(
              MAX_STALLED_CHECK_DELAY_MS,
              Math.max(INITIAL_STALLED_CHECK_DELAY_MS, stalledCheckDelayMs * 2),
            );
        refresh();
      },
      Math.max(MIN_CHECK_DELAY_MS, stalledCheckDelayMs, Math.ceil(remainingMs)),
    );
  }

  function onContextStateChange(): void {
    stalledCheckDelayMs = 0;
    refresh();
  }

  const refreshFromState = (): void => {
    stalledCheckDelayMs = 0;
    refresh();
  };
  scope.on('state:player.startedAt', refreshFromState);
  scope.on('state:player.pausedAt', refreshFromState);
  scope.on('state:playback.mode', refreshFromState);
  scope.on('state:playback.activity', refreshFromState);
  scope.on('state:files.current', refreshFromState);
  scope.on('player:buffer-changed', refreshFromState);
  scope.on('audio:ready', refreshFromState);
  document.addEventListener('visibilitychange', refreshFromState, {
    signal: abortController.signal,
  });
  refresh();

  return {
    destroy() {
      destroyed = true;
      cancelTimer();
      scope.dispose();
      abortController.abort();
      context?.removeEventListener('statechange', onContextStateChange);
      context = null;
    },
  };
}
