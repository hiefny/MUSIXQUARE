/**
 * Participant-local playback recovery.
 *
 * This is deliberately a cross-domain event seam: callers report that the
 * physical output resumed, while this module chooses the room-specific local
 * alignment primitive. None of these branches publishes a room command.
 */

import { bus, createBusScope, type BusScope } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { getRoomContext } from '../rooms/authority.ts';
import { guestRendezvousSync } from '../youtube/sync.ts';
import { isLocalYouTubePaused, setLocalYouTubePaused } from '../youtube/_state.ts';
import { isLocalFilePaused, setLocalFilePaused } from './_state.ts';

const SUCCESS_COOLDOWN_MS = 400;
const RETRY_TIMER = 'local-output-rejoin-retry';
const REJOIN_RETRY_MS = [250, 750, 1_500, 3_000, 5_000] as const;

interface RejoinRequestPayload {
  reason: 'media-session-play' | 'audio-context-recovered';
  mode: 'file' | 'youtube';
}

interface RejoinIdentity {
  generation: number;
  roomKind: 'standard' | 'pro';
  roomId: string | null;
  roomEpoch: number;
  queueItemId: string | null;
}

interface RejoinRequest extends RejoinRequestPayload {
  identity: RejoinIdentity;
  retryAttempt: number;
}

interface RejoinResult {
  rejoined: boolean;
  retryAfterMs?: number;
}

let scope: BusScope | null = null;
let rejoinInFlight: Promise<boolean> | null = null;
let pendingRejoinRequest: RejoinRequest | null = null;
let scheduledRetryRequest: RejoinRequest | null = null;
let awaitingAuthoritativeResumeMode: 'file' | 'youtube' | null = null;
let lastSuccessfulRejoinAt = 0;
let rejoinGeneration = 0;

function captureRequest(payload: RejoinRequestPayload): RejoinRequest {
  const room = getRoomContext();
  return {
    ...payload,
    retryAttempt: 0,
    identity: {
      generation: rejoinGeneration,
      roomKind: room.kind,
      roomId: room.roomId,
      roomEpoch: room.epoch,
      queueItemId: getState('playlist.currentQueueItemId'),
    },
  };
}

function requestStillCurrent(request: RejoinRequest): boolean {
  if (!getState('setup.sessionStarted') || request.identity.generation !== rejoinGeneration) {
    return false;
  }
  if (getState('playback.mode') !== request.mode) return false;
  const room = getRoomContext();
  return (
    room.kind === request.identity.roomKind &&
    room.roomId === request.identity.roomId &&
    room.epoch === request.identity.roomEpoch &&
    getState('playlist.currentQueueItemId') === request.identity.queueItemId
  );
}

function requestStillOwnsReleasedOutput(request: RejoinRequest): boolean {
  if (!requestStillCurrent(request)) return false;
  return request.mode === 'file' ? !isLocalFilePaused() : !isLocalYouTubePaused();
}

function hasLocalRejoinIntent(request: RejoinRequest): boolean {
  const { mode } = request;
  if (!requestStillCurrent(request)) return false;
  // A trusted OS PLAY is also the fallback when the browser lost our local
  // pause bit. It may query authority while the semantic room state is paused;
  // the local-only reconciliation path cannot manufacture a room PLAY.
  if (request.reason === 'media-session-play') return true;
  if (getState('playback.activity') === 'playing') return true;
  if (awaitingAuthoritativeResumeMode === mode) return true;
  return mode === 'file' ? isLocalFilePaused() : isLocalYouTubePaused();
}

function setLocalPause(mode: 'file' | 'youtube', paused: boolean): void {
  if (mode === 'file') setLocalFilePaused(paused);
  else setLocalYouTubePaused(paused);
}

async function performLocalOutputRejoin(request: RejoinRequest): Promise<RejoinResult> {
  const { mode } = request;
  if (!hasLocalRejoinIntent(request)) {
    return { rejoined: false };
  }

  const context = getRoomContext();
  const wasLocallyPaused = mode === 'file' ? isLocalFilePaused() : isLocalYouTubePaused();

  if (context.kind === 'pro') {
    if (!context.roomId) return { rejoined: false };
    // Reconciliation may need to start media, so release the local pause gate
    // first. Restore it when the authoritative endpoint was not available;
    // the next user play action can then retry instead of playing old time.
    setLocalPause(mode, false);
    try {
      // Keep the ordinary initial bundle and player dependency graph free of
      // the PRO runtime. This matches the existing manual-sync boundary.
      const { requestActiveProRoomPlaybackReconciliation } = await import('../pro-room/runtime.ts');
      if (!requestStillOwnsReleasedOutput(request)) return { rejoined: false };
      const reconciled = await requestActiveProRoomPlaybackReconciliation({
        showLoading: false,
        liveness: {
          identity: request.identity,
          isCurrent: () => requestStillOwnsReleasedOutput(request),
        },
      });
      if (!requestStillOwnsReleasedOutput(request)) return { rejoined: false };
      if (!reconciled && wasLocallyPaused) setLocalPause(mode, true);
      return {
        rejoined: reconciled,
        ...(!reconciled && request.retryAttempt < REJOIN_RETRY_MS.length
          ? { retryAfterMs: REJOIN_RETRY_MS[request.retryAttempt] }
          : {}),
      };
    } catch (error) {
      // A late failure owns neither a successor queue occurrence nor a newer
      // local PAUSE. Restore only while this exact request still owns the
      // pause gate it released above.
      if (!requestStillOwnsReleasedOutput(request)) return { rejoined: false };
      if (wasLocallyPaused) setLocalPause(mode, true);
      throw error;
    }
  }

  const hostConnection = getState('network.hostConn');
  if (!hostConnection?.open) {
    // Stable standard-room hosts have no participant-local authority endpoint.
    return { rejoined: false };
  }

  setLocalPause(mode, false);
  if (mode === 'file') {
    if (wasLocallyPaused) awaitingAuthoritativeResumeMode = 'file';
    bus.emit('sync:force-resync');
    return { rejoined: true };
  }

  if (wasLocallyPaused) awaitingAuthoritativeResumeMode = 'youtube';
  let result: ReturnType<typeof guestRendezvousSync>;
  try {
    result = guestRendezvousSync({
      silent: true,
      suppressProgressToast: true,
      onComplete: () => {
        if (awaitingAuthoritativeResumeMode === 'youtube') {
          awaitingAuthoritativeResumeMode = null;
        }
      },
    });
  } catch (error) {
    awaitingAuthoritativeResumeMode = null;
    if (wasLocallyPaused) setLocalPause(mode, true);
    throw error;
  }
  if (result.status === 'started' || result.status === 'completed') {
    if (result.status === 'completed') awaitingAuthoritativeResumeMode = null;
    return { rejoined: true };
  }
  if (result.status === 'busy') {
    // Busy is not success: retain the desired local state and retry after the
    // rendezvous/cooldown owner releases it.
    awaitingAuthoritativeResumeMode = 'youtube';
    return { rejoined: false, retryAfterMs: result.retryAfterMs ?? 250 };
  }
  awaitingAuthoritativeResumeMode = null;
  if (wasLocallyPaused) setLocalPause(mode, true);
  return { rejoined: false };
}

function preferRequest(current: RejoinRequest | null, incoming: RejoinRequest): RejoinRequest {
  if (!current) return incoming;
  if (!requestStillCurrent(current)) return incoming;
  if (!requestStillCurrent(incoming)) return current;
  if (current.mode !== incoming.mode) {
    const activeMode = getState('playback.mode');
    if (incoming.mode === activeMode) return incoming;
    if (current.mode === activeMode) return current;
  }
  if (incoming.reason === 'media-session-play') return incoming;
  return current;
}

function scheduleRetry(request: RejoinRequest, delayMs: number): void {
  if (!requestStillCurrent(request)) return;
  const retryRequest = { ...request, retryAttempt: request.retryAttempt + 1 };
  scheduledRetryRequest = preferRequest(scheduledRetryRequest, retryRequest);
  setManagedTimer(
    RETRY_TIMER,
    () => {
      const retry = scheduledRetryRequest;
      scheduledRetryRequest = null;
      if (retry && requestStillCurrent(retry)) void requestLocalOutputRejoin(retry);
    },
    Math.max(10, delayMs),
  );
}

function requestLocalOutputRejoin(request: RejoinRequest): Promise<boolean> {
  if (!requestStillCurrent(request)) return Promise.resolve(false);
  if (rejoinInFlight) {
    pendingRejoinRequest = preferRequest(pendingRejoinRequest, request);
    return rejoinInFlight;
  }
  if (scheduledRetryRequest) {
    if (request.reason !== 'media-session-play') {
      scheduledRetryRequest = preferRequest(scheduledRetryRequest, request);
      return Promise.resolve(false);
    }
    request = preferRequest(scheduledRetryRequest, request);
    scheduledRetryRequest = null;
    clearManagedTimer(RETRY_TIMER);
  }
  if (
    request.reason !== 'media-session-play' &&
    Date.now() - lastSuccessfulRejoinAt < SUCCESS_COOLDOWN_MS
  ) {
    return Promise.resolve(false);
  }

  const operation = performLocalOutputRejoin(request)
    .then((result) => {
      if (!requestStillCurrent(request)) return false;
      if (result.rejoined) lastSuccessfulRejoinAt = Date.now();
      else if (result.retryAfterMs !== undefined) scheduleRetry(request, result.retryAfterMs);
      return result.rejoined;
    })
    .catch((error) => {
      log.warn('[Playback] Local output rejoin failed', error);
      if (
        requestStillCurrent(request) &&
        request.identity.roomKind === 'pro' &&
        request.retryAttempt < REJOIN_RETRY_MS.length
      ) {
        scheduleRetry(request, REJOIN_RETRY_MS[request.retryAttempt]!);
      }
      return false;
    })
    .finally(() => {
      if (rejoinInFlight !== operation) return;
      rejoinInFlight = null;
      const pending = pendingRejoinRequest;
      pendingRejoinRequest = null;
      if (!pending || !requestStillCurrent(pending)) return;
      if (scheduledRetryRequest && pending.reason !== 'media-session-play') {
        scheduledRetryRequest = preferRequest(scheduledRetryRequest, pending);
        return;
      }
      queueMicrotask(() => void requestLocalOutputRejoin(pending));
    });
  rejoinInFlight = operation;
  return operation;
}

export function initLocalOutputRejoin(): void {
  scope?.dispose();
  scope = createBusScope();
  rejoinGeneration += 1;
  rejoinInFlight = null;
  pendingRejoinRequest = null;
  scheduledRetryRequest = null;
  clearManagedTimer(RETRY_TIMER);
  awaitingAuthoritativeResumeMode = null;
  lastSuccessfulRejoinAt = 0;

  scope.on('playback:local-output-rejoin', (request) => {
    void requestLocalOutputRejoin(captureRequest(request));
  });
  scope.on('state:setup.sessionStarted', (started) => {
    if (!started) {
      rejoinGeneration += 1;
      rejoinInFlight = null;
      pendingRejoinRequest = null;
      scheduledRetryRequest = null;
      clearManagedTimer(RETRY_TIMER);
      awaitingAuthoritativeResumeMode = null;
      lastSuccessfulRejoinAt = 0;
    }
  });
  scope.on('state:playback.activity', (activity) => {
    if (activity === 'playing' || activity === 'idle') awaitingAuthoritativeResumeMode = null;
  });
  scope.on('state:playback.mode', (mode) => {
    if (mode !== awaitingAuthoritativeResumeMode) awaitingAuthoritativeResumeMode = null;
  });
}
