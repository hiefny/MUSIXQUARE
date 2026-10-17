type BackButtonHistoryPosition = 'base' | 'guard' | 'foreign';

interface BackButtonHistoryDeps {
  navigateHome: () => void;
  history?: Pick<History, 'state' | 'replaceState' | 'pushState' | 'back'>;
  getCurrentUrl?: () => string;
  eventTarget?: EventTarget;
  onNavigationError?: (error: unknown) => void;
}

interface BackButtonHistory {
  current: () => BackButtonHistoryPosition;
  pushGuard: () => void;
  leave: () => void;
  cancelLeave: () => void;
  dispose: () => void;
}

const LEAVE_FALLBACK_MS = 1_000;

/**
 * Own only this document's two history markers. A previous document's marker
 * is foreign, even after a same-URL reload: it is not proof that its predecessor
 * is an entry this document may skip. No URLs or room credentials are retained.
 */
export function createBackButtonHistory({
  navigateHome,
  history = window.history,
  getCurrentUrl = () => window.location.href,
  eventTarget = window,
  onNavigationError,
}: BackButtonHistoryDeps): BackButtonHistory {
  const owner = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let disposed = false;
  let leaveAttempt: {
    phase: 'to-base' | 'beyond-base';
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  const current = (): BackButtonHistoryPosition => {
    const value: unknown = history.state;
    if (!value || typeof value !== 'object' || !('mxqrGuard' in value)) return 'foreign';
    const marker: unknown = value.mxqrGuard;
    if (!marker || typeof marker !== 'object' || !('owner' in marker) || marker.owner !== owner) {
      return 'foreign';
    }
    return 'kind' in marker && (marker.kind === 'base' || marker.kind === 'guard')
      ? marker.kind
      : 'foreign';
  };

  const markedState = (kind: 'base' | 'guard'): object => {
    const value: unknown = history.state;
    return {
      ...(value && typeof value === 'object' ? value : {}),
      mxqrGuard: { owner, kind },
    };
  };

  const cancelLeave = (): void => {
    if (leaveAttempt) clearTimeout(leaveAttempt.timer);
    leaveAttempt = null;
  };

  const reportNavigationError = (error: unknown): void => {
    try {
      onNavigationError?.(error);
    } catch {
      // An observer must not create a second failed navigation.
    }
  };

  const home = (): void => {
    cancelLeave();
    try {
      navigateHome();
    } catch (error) {
      // The session-reset coordinator still owns its bounded recovery if the
      // browser rejects this final navigation too.
      reportNavigationError(error);
    }
  };

  const back = (): void => {
    try {
      history.back();
    } catch (error) {
      reportNavigationError(error);
      home();
    }
  };

  const onPopState = (): void => {
    if (!leaveAttempt) return;
    const position = current();
    if (position === 'foreign') {
      // A same-document foreign entry is not a known predecessor to skip.
      // A real cross-document departure instead cancels us at pagehide.
      home();
    } else if (leaveAttempt.phase === 'to-base' && position === 'base') {
      leaveAttempt.phase = 'beyond-base';
      back();
    }
    // Forward, repeated events, or a still-pending first traversal cannot issue
    // another Back. One timeout covers the entire attempt, not each step.
  };

  eventTarget.addEventListener('popstate', onPopState);
  eventTarget.addEventListener('pagehide', cancelLeave);

  return {
    current,
    pushGuard() {
      if (disposed || leaveAttempt || current() === 'guard') return;
      if (current() === 'foreign') {
        history.replaceState(markedState('base'), '', getCurrentUrl());
      }
      // Read the current URL now, rather than capturing an earlier claim or
      // login fragment that another feature may already have scrubbed.
      history.pushState(markedState('guard'), '', getCurrentUrl());
    },
    leave() {
      if (disposed || leaveAttempt) return;
      const position = current();
      if (position === 'foreign') {
        home();
        return;
      }
      const attempt = {
        phase: position === 'guard' ? ('to-base' as const) : ('beyond-base' as const),
        // Native timer: leaveSession clears the managed timer registry before
        // this fallback can finish a rejected/no-op browser traversal.
        timer: globalThis.setTimeout(() => {
          if (leaveAttempt === attempt) home();
        }, LEAVE_FALLBACK_MS),
      };
      leaveAttempt = attempt;
      back();
    },
    cancelLeave,
    dispose() {
      disposed = true;
      cancelLeave();
      eventTarget.removeEventListener('popstate', onPopState);
      eventTarget.removeEventListener('pagehide', cancelLeave);
    },
  };
}
