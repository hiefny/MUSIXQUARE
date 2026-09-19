import { getExistingAudioContext } from '../audio/context.ts';
import { createBusScope } from '../core/events.ts';
import {
  getLocalFilePendingStartDeadlineMs,
  isLocalFileStartPending,
} from '../player/transport.ts';

/** Projects an installed future source into the existing loading indicators. */
export function createFileStartLoadingController(onChange: (pending: boolean) => void): {
  destroy: () => void;
} {
  const scope = createBusScope();
  const abortController = new AbortController();
  let timer = 0;
  let context: AudioContext | null = null;
  let pending: boolean | undefined;
  let stalledAt: number | null = null;
  let destroyed = false;

  function cancelTimer(): void {
    if (timer) window.clearTimeout(timer);
    timer = 0;
  }

  function refresh(allowTimer = true): void {
    if (destroyed) return;
    cancelTimer();
    const currentContext = getExistingAudioContext();
    if (context !== currentContext) {
      context?.removeEventListener('statechange', onContextStateChange);
      context = currentContext;
      context?.addEventListener('statechange', onContextStateChange);
    }

    const nextPending = isLocalFileStartPending();
    if (pending !== nextPending) {
      pending = nextPending;
      onChange(nextPending);
    }
    if (!nextPending) {
      stalledAt = null;
      return;
    }
    if (!allowTimer || !context || context.state !== 'running') return;

    const scheduledContext = context;
    const audioTime = context.currentTime;
    const deadline = getLocalFilePendingStartDeadlineMs();
    const remainingMs = deadline === undefined ? 16 : deadline - performance.now();
    timer = window.setTimeout(
      () => {
        timer = 0;
        if (destroyed || context !== scheduledContext) return;
        const progressed = context.currentTime > audioTime;
        stalledAt = progressed ? null : audioTime;
        // A suspended or frozen Web Audio clock must not start a permanent
        // polling loop. State changes, or the ordinary progress event after the
        // clock recovers, re-arm this single deadline timer.
        refresh(progressed);
      },
      Math.max(16, Math.ceil(remainingMs)),
    );
  }

  function onContextStateChange(): void {
    stalledAt = null;
    refresh();
  }

  const refreshFromState = (): void => refresh();
  scope.on('state:player.startedAt', refreshFromState);
  scope.on('state:player.pausedAt', refreshFromState);
  scope.on('state:playback.mode', refreshFromState);
  scope.on('state:playback.activity', refreshFromState);
  scope.on('state:files.current', refreshFromState);
  scope.on('player:buffer-changed', refreshFromState);
  scope.on('audio:ready', refreshFromState);
  scope.on('ui:time-update', () => {
    if (stalledAt !== null && context && context.currentTime > stalledAt) refresh();
  });
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
