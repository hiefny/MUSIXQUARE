import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import type {
  ProPlaybackUiControlKind,
  ProPlaybackUiControlPendingEvent,
  ProPlaybackUiControlSettlementStatus,
  QueueItemId,
} from '../types/index.ts';

/**
 * Coordinator-free PRO playback seam.
 *
 * User/media observations travel out through one command handler. Canonical
 * server frames travel back through an explicitly branded authority token.
 * The token is passed down the exact call stack that applies a frame; there is
 * deliberately no page-global "applying server state" boolean. A slow R2
 * decode therefore cannot accidentally authorize a concurrent user click.
 */

export type ProPlaybackMediaKind = 'file' | 'youtube';
export type ProPlaybackCanonicalState = 'idle' | 'paused' | 'playing';

interface ProPlaybackIntentBase {
  roomId: string;
  roomEpoch: number;
  queueItemId: QueueItemId | null;
  positionSeconds: number;
  /** Participant-local UI correlation only; omitted from every Worker command. */
  clientUiControlToken?: number;
}

export type ProPlaybackUserIntent =
  | (ProPlaybackIntentBase & {
      kind: 'select';
      queueItemId: QueueItemId;
      youtubeSubIndex: number | null;
      youtubeVideoId: string | null;
    })
  | (ProPlaybackIntentBase & { kind: 'play' | 'pause' | 'stop' | 'seek' })
  | (ProPlaybackIntentBase & { kind: 'next' | 'previous' })
  | (ProPlaybackIntentBase & {
      /**
       * The YouTube iframe observed that the current persisted playlist item
       * is crossing into its next sub-video. Unlike a user-initiated `next`,
       * this observation must remain fenced to the exact locally committed
       * playback revision so several browsers cannot advance the manifest
       * more than once.
       */
      kind: 'advance-sub-video';
      queueItemId: QueueItemId;
      observedPlaybackRevision: number;
    })
  | (ProPlaybackIntentBase & {
      kind: 'ended' | 'unavailable';
      queueItemId: QueueItemId;
      mediaKind: ProPlaybackMediaKind;
      /**
       * Exact canonical revision whose resident media emitted this
       * observation.  It is stamped synchronously by
       * routeProPlaybackCommand(), before the runtime command queue can move
       * on to a newer selection/seek/pause revision.
       */
      observedPlaybackRevision: number;
      observedPositionSeconds: number;
      durationSeconds: number | null;
      youtubeSubIndex?: number | null;
      youtubeVideoId?: string | null;
    });

export type ProPlaybackCommandHandler = (
  intent: Readonly<ProPlaybackUserIntent>,
) => void | Promise<void>;

let commandHandler: ProPlaybackCommandHandler | null = null;

export function registerProPlaybackCommandHandler(
  handler: ProPlaybackCommandHandler | null,
): () => void {
  commandHandler = handler;
  return () => {
    if (commandHandler === handler) commandHandler = null;
  };
}

type RoutedIntentOf<T> = T extends ProPlaybackUserIntent
  ? Omit<T, 'roomId' | 'roomEpoch' | 'observedPlaybackRevision' | 'clientUiControlToken'>
  : never;
type RoutedIntent = RoutedIntentOf<ProPlaybackUserIntent>;
type RoutedUiIntent = RoutedIntent & { kind: ProPlaybackUiControlKind };

interface ProPlaybackUiProjection {
  readonly wasPlaying: boolean;
}

const UI_CONTROL_TIMEOUT_TIMER = 'pro-playback-ui-control-timeout';
const UI_CONTROL_FAIL_OPEN_MS = 15_000;
let uiControlSequence = 0;
let activeUiControl: Readonly<ProPlaybackUiControlPendingEvent> | null = null;

function emitUiControlSettlement(
  event: Readonly<ProPlaybackUiControlPendingEvent>,
  status: ProPlaybackUiControlSettlementStatus,
  positionSeconds?: number,
): void {
  bus.emit('pro-playback:ui-control-settled', {
    token: event.token,
    kind: event.kind,
    queueItemId: event.queueItemId,
    status,
    ...(Number.isFinite(positionSeconds) ? { positionSeconds } : {}),
  });
}

function beginUiControl(
  intent: RoutedUiIntent,
  projection: Readonly<ProPlaybackUiProjection>,
): Readonly<ProPlaybackUiControlPendingEvent> {
  const previous = activeUiControl;
  if (previous) emitUiControlSettlement(previous, 'superseded');

  const event = Object.freeze({
    token: ++uiControlSequence,
    kind: intent.kind,
    queueItemId: intent.queueItemId,
    targetSeconds: Number.isFinite(intent.positionSeconds)
      ? Math.max(0, intent.positionSeconds)
      : 0,
    wasPlaying: projection.wasPlaying,
  });
  activeUiControl = event;
  clearManagedTimer(UI_CONTROL_TIMEOUT_TIMER);
  bus.emit('pro-playback:ui-control-pending', event);
  setManagedTimer(
    UI_CONTROL_TIMEOUT_TIMER,
    () => settleProPlaybackUiControl(event.token, 'failed'),
    UI_CONTROL_FAIL_OPEN_MS,
  );
  return event;
}

/**
 * Confirm that a queued local control is still the active projection and give
 * its actual network/media stage a fresh fail-open window. A superseded or
 * already-expired command must never be submitted later from the serial tail.
 */
export function refreshProPlaybackUiControlTimeout(token: number): boolean {
  const event = activeUiControl;
  if (!event || event.token !== token) return false;
  clearManagedTimer(UI_CONTROL_TIMEOUT_TIMER);
  setManagedTimer(
    UI_CONTROL_TIMEOUT_TIMER,
    () => settleProPlaybackUiControl(event.token, 'failed'),
    UI_CONTROL_FAIL_OPEN_MS,
  );
  return true;
}

export function settleProPlaybackUiControl(
  token: number,
  status: ProPlaybackUiControlSettlementStatus,
  positionSeconds?: number,
): boolean {
  const event = activeUiControl;
  if (!event || event.token !== token) return false;
  activeUiControl = null;
  clearManagedTimer(UI_CONTROL_TIMEOUT_TIMER);
  emitUiControlSettlement(event, status, positionSeconds);
  return true;
}

/**
 * Route an action whenever a coordinator-free PRO context is active.
 *
 * A PRO context without its command sink is an entry/recovery transition, not
 * permission to fall back to the legacy local-host path. Consume the action in
 * that short window so only a server-accepted command can move canonical
 * playback. Returning false is reserved for ordinary rooms.
 */
export function routeProPlaybackCommand(
  intent: RoutedIntent,
  uiProjection?: Readonly<ProPlaybackUiProjection>,
): boolean {
  const context = getState('room.context');
  const handler = commandHandler;
  if (context.kind !== 'pro' || !context.roomId) return false;
  if (!handler) {
    log.warn('[PRO Playback] Ignored action while the server command channel is not ready');
    return true;
  }

  const uiControl =
    uiProjection && (intent.kind === 'play' || intent.kind === 'pause' || intent.kind === 'seek')
      ? beginUiControl(intent as RoutedUiIntent, uiProjection)
      : null;

  const command = {
    ...intent,
    roomId: context.roomId,
    roomEpoch: context.epoch,
    ...(uiControl ? { clientUiControlToken: uiControl.token } : {}),
    ...(intent.kind === 'ended' ||
    intent.kind === 'unavailable' ||
    intent.kind === 'advance-sub-video'
      ? { observedPlaybackRevision: highestCommittedPlaybackRevision }
      : {}),
  } as ProPlaybackUserIntent;
  try {
    void Promise.resolve(handler(command)).catch((error) => {
      log.warn('[PRO Playback] Server command rejected', error);
      if (uiControl) settleProPlaybackUiControl(uiControl.token, 'failed');
    });
  } catch (error) {
    log.warn('[PRO Playback] Server command handler threw', error);
    if (uiControl) settleProPlaybackUiControl(uiControl.token, 'failed');
  }
  return true;
}

const authorityBrand: unique symbol = Symbol('musixquare.pro-playback-authority');

export interface ProPlaybackAuthorityStamp {
  roomId: string;
  roomEpoch: number;
  /** Revision the server compared atomically before accepting this command. */
  basePlaybackRevision: number;
  /** Null only for a direct (non-PREPARE) commit. */
  transitionId: string | null;
}

/** Opaque proof that a call originates from a validated server frame. */
export interface ProPlaybackAuthorityToken extends Readonly<ProPlaybackAuthorityStamp> {
  readonly [authorityBrand]: true;
}

function requireSafeCounter(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

export function createProPlaybackAuthorityToken(
  stamp: ProPlaybackAuthorityStamp,
): ProPlaybackAuthorityToken {
  const roomId = stamp.roomId.trim();
  const transitionId = stamp.transitionId === null ? null : stamp.transitionId.trim();
  if (!roomId || transitionId === '') throw new TypeError('roomId is required');
  requireSafeCounter(stamp.roomEpoch, 'roomEpoch');
  requireSafeCounter(stamp.basePlaybackRevision, 'basePlaybackRevision');
  return Object.freeze({
    roomId,
    roomEpoch: stamp.roomEpoch,
    basePlaybackRevision: stamp.basePlaybackRevision,
    transitionId,
    [authorityBrand]: true as const,
  });
}

export function isProPlaybackAuthorityToken(value: unknown): value is ProPlaybackAuthorityToken {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<ProPlaybackAuthorityToken>)[authorityBrand] === true
  );
}

/** Stable participant-local key for one exact server authority frame. */
export function getProPlaybackAuthorityKey(authority: ProPlaybackAuthorityToken): string {
  if (!isProPlaybackAuthorityToken(authority)) {
    throw new TypeError('A server authority token is required');
  }
  return JSON.stringify([
    authority.roomId,
    authority.roomEpoch,
    authority.basePlaybackRevision,
    authority.transitionId,
  ]);
}

export interface ProPlaybackPrepareRequest {
  authority: ProPlaybackAuthorityToken;
  queueItemId: QueueItemId;
  positionSeconds: number;
  youtubeSubIndex?: number | null;
  youtubeVideoId?: string | null;
  /** Participant-local fence injected by the authority layer for async media waits. */
  isCurrent?: () => boolean;
}

/**
 * Participant-side scheduling policy for one canonical PRO playback commit.
 *
 * `zero-start` may use the measured platform audio-output lead. Ordinary
 * controls already target a running timeline and must follow the server clock
 * without that one-time compensation.
 */
export type ProPlaybackTimingMode = 'zero-start' | 'scheduled-control';

export type ProPlaybackPrepareFailureReason =
  | 'inactive-room'
  | 'stale-authority'
  | 'missing-endpoint'
  | 'missing-track'
  | 'identity-mismatch'
  | 'media-unavailable'
  | 'decode-failed'
  | 'player-unavailable'
  | 'audio-locked'
  | 'timeout'
  | 'superseded'
  | 'unknown';

export type ProPlaybackPrepareResult =
  | {
      status: 'ready';
      authority: ProPlaybackAuthorityToken;
      queueItemId: QueueItemId;
      mediaKind: ProPlaybackMediaKind;
      durationSeconds: number | null;
      youtubeSubIndex: number | null;
      youtubeVideoId: string | null;
    }
  | {
      status: 'failed' | 'superseded';
      authority: ProPlaybackAuthorityToken;
      queueItemId: QueueItemId;
      reason: ProPlaybackPrepareFailureReason;
    };

export interface ProPlaybackCommitRequest {
  authority: ProPlaybackAuthorityToken;
  /** Canonical revision carried by the COMMIT playback snapshot. */
  committedPlaybackRevision: number;
  queueItemId: QueueItemId | null;
  state: ProPlaybackCanonicalState;
  positionSeconds: number;
  /** Delay from receipt to the locally compensated execution instant. */
  scheduleDelayMs: number;
  timingMode: ProPlaybackTimingMode;
  youtubeSubIndex?: number | null;
  youtubeVideoId?: string | null;
  /** Participant-local fence for a newer canonical COMMIT or room teardown. */
  isCurrent?: () => boolean;
}

export interface ProPlaybackCommitResult {
  status: 'applied' | 'failed' | 'superseded';
  authority: ProPlaybackAuthorityToken;
  reason?: ProPlaybackPrepareFailureReason;
}

export interface ProPlaybackMediaEndpoint {
  prepare(request: Readonly<ProPlaybackPrepareRequest>): Promise<ProPlaybackPrepareResult>;
  commit(request: Readonly<ProPlaybackCommitRequest>): Promise<ProPlaybackCommitResult>;
  /** Abort participant-local work for one server-cancelled transition. */
  cancel?(authority: ProPlaybackAuthorityToken): void;
}

let mediaEndpoint: ProPlaybackMediaEndpoint | null = null;
let prepareGeneration = 0;
let activePreparation: {
  generation: number;
  authority: ProPlaybackAuthorityToken;
  promise: Promise<ProPlaybackPrepareResult>;
} | null = null;
let highestSeen: ProPlaybackAuthorityToken | null = null;
let latestApplied: ProPlaybackAuthorityToken | null = null;
let highestCommittedPlaybackRevision = 0;

export function registerProPlaybackMediaEndpoint(
  endpoint: ProPlaybackMediaEndpoint | null,
): () => void {
  mediaEndpoint = endpoint;
  return () => {
    if (mediaEndpoint === endpoint) mediaEndpoint = null;
  };
}

function sameAuthority(left: ProPlaybackAuthorityToken, right: ProPlaybackAuthorityToken): boolean {
  return (
    left.roomId === right.roomId &&
    left.roomEpoch === right.roomEpoch &&
    left.basePlaybackRevision === right.basePlaybackRevision &&
    left.transitionId === right.transitionId
  );
}

function compareAuthority(
  left: ProPlaybackAuthorityToken,
  right: ProPlaybackAuthorityToken,
): number {
  if (left.roomId !== right.roomId) return 1;
  if (left.roomEpoch !== right.roomEpoch) return left.roomEpoch - right.roomEpoch;
  return left.basePlaybackRevision - right.basePlaybackRevision;
}

function isOlderAuthority(
  authority: ProPlaybackAuthorityToken,
  reference: ProPlaybackAuthorityToken | null,
): boolean {
  return !!reference && compareAuthority(authority, reference) < 0;
}

function activeAuthorityRoomMatches(authority: ProPlaybackAuthorityToken): boolean {
  const context = getState('room.context');
  return (
    context.kind === 'pro' &&
    context.roomId === authority.roomId &&
    context.epoch === authority.roomEpoch
  );
}

function failedPrepare(
  request: Readonly<ProPlaybackPrepareRequest>,
  reason: ProPlaybackPrepareFailureReason,
  status: 'failed' | 'superseded' = 'failed',
): ProPlaybackPrepareResult {
  return { status, authority: request.authority, queueItemId: request.queueItemId, reason };
}

export async function prepareProPlaybackAuthority(
  request: Readonly<ProPlaybackPrepareRequest>,
): Promise<ProPlaybackPrepareResult> {
  if (!isProPlaybackAuthorityToken(request.authority)) {
    throw new TypeError('A server authority token is required');
  }
  if (request.authority.transitionId === null) {
    return failedPrepare(request, 'stale-authority');
  }
  if (!activeAuthorityRoomMatches(request.authority)) {
    return failedPrepare(request, 'inactive-room');
  }
  if (request.authority.basePlaybackRevision < highestCommittedPlaybackRevision) {
    return failedPrepare(request, 'stale-authority', 'superseded');
  }
  if (isOlderAuthority(request.authority, highestSeen)) {
    return failedPrepare(request, 'stale-authority', 'superseded');
  }
  const endpoint = mediaEndpoint;
  if (!endpoint) return failedPrepare(request, 'missing-endpoint');

  if (activePreparation && sameAuthority(activePreparation.authority, request.authority)) {
    return activePreparation.promise;
  }

  const generation = ++prepareGeneration;
  const endpointRequest: Readonly<ProPlaybackPrepareRequest> = {
    ...request,
    isCurrent: () =>
      generation === prepareGeneration &&
      activeAuthorityRoomMatches(request.authority) &&
      !isOlderAuthority(request.authority, highestSeen),
  };
  const promise = endpoint.prepare(endpointRequest);
  activePreparation = { generation, authority: request.authority, promise };
  highestSeen = request.authority;
  const result = await promise;
  if (
    generation !== prepareGeneration ||
    !activePreparation ||
    activePreparation.generation !== generation ||
    !sameAuthority(activePreparation.authority, request.authority)
  ) {
    return failedPrepare(request, 'superseded', 'superseded');
  }
  if (isOlderAuthority(request.authority, highestSeen)) {
    return failedPrepare(request, 'stale-authority', 'superseded');
  }
  return result;
}

/**
 * Cancel the active participant preparation without disturbing an already
 * applied revision. Server CANCEL frames pass their exact token; teardown may
 * omit it to release whichever preparation the departing room owns.
 */
export function cancelProPlaybackPreparation(authority?: ProPlaybackAuthorityToken): boolean {
  const pending = activePreparation;
  if (!pending) return false;
  if (
    authority &&
    (!isProPlaybackAuthorityToken(authority) ||
      !activeAuthorityRoomMatches(authority) ||
      !sameAuthority(pending.authority, authority))
  ) {
    return false;
  }

  prepareGeneration += 1;
  activePreparation = null;
  mediaEndpoint?.cancel?.(pending.authority);
  return true;
}

export async function commitProPlaybackAuthority(
  request: Readonly<ProPlaybackCommitRequest>,
): Promise<ProPlaybackCommitResult> {
  if (!isProPlaybackAuthorityToken(request.authority)) {
    throw new TypeError('A server authority token is required');
  }
  requireSafeCounter(request.committedPlaybackRevision, 'committedPlaybackRevision');
  if (request.committedPlaybackRevision !== request.authority.basePlaybackRevision + 1) {
    return { status: 'failed', authority: request.authority, reason: 'stale-authority' };
  }
  if (!activeAuthorityRoomMatches(request.authority)) {
    return { status: 'failed', authority: request.authority, reason: 'inactive-room' };
  }
  if (latestApplied && sameAuthority(request.authority, latestApplied)) {
    return { status: 'applied', authority: request.authority };
  }
  if (request.committedPlaybackRevision <= highestCommittedPlaybackRevision) {
    return { status: 'superseded', authority: request.authority, reason: 'stale-authority' };
  }
  if (isOlderAuthority(request.authority, highestSeen)) {
    return { status: 'superseded', authority: request.authority, reason: 'stale-authority' };
  }
  const endpoint = mediaEndpoint;
  if (!endpoint) {
    return { status: 'failed', authority: request.authority, reason: 'missing-endpoint' };
  }
  if (request.isCurrent?.() === false) {
    return { status: 'superseded', authority: request.authority, reason: 'superseded' };
  }

  const pending = activePreparation;
  if (request.authority.transitionId !== null) {
    if (!pending || !sameAuthority(pending.authority, request.authority)) {
      return { status: 'superseded', authority: request.authority, reason: 'stale-authority' };
    }
    const prepared = await pending.promise;
    if (request.isCurrent?.() === false) {
      return { status: 'superseded', authority: request.authority, reason: 'superseded' };
    }
    if (prepared.status !== 'ready') {
      return {
        status: prepared.status === 'superseded' ? 'superseded' : 'failed',
        authority: request.authority,
        reason: prepared.reason,
      };
    }
    if (
      pending.generation !== prepareGeneration ||
      !activePreparation ||
      activePreparation.generation !== pending.generation ||
      !sameAuthority(activePreparation.authority, request.authority)
    ) {
      return { status: 'superseded', authority: request.authority, reason: 'superseded' };
    }
  } else if (pending && compareAuthority(pending.authority, request.authority) <= 0) {
    // A direct commit (pause/seek/etc.) is itself canonical and supersedes any
    // uncommitted media preparation at the same or an older base revision.
    prepareGeneration += 1;
    activePreparation = null;
    endpoint.cancel?.(pending.authority);
  }

  highestSeen = request.authority;
  const result = await endpoint.commit(request);
  if (request.isCurrent?.() === false) {
    return { status: 'superseded', authority: request.authority, reason: 'superseded' };
  }
  if (result.status === 'applied') {
    latestApplied = request.authority;
    highestCommittedPlaybackRevision = request.committedPlaybackRevision;
    if (activePreparation && sameAuthority(activePreparation.authority, request.authority)) {
      activePreparation = null;
    }
  }
  return result;
}

/**
 * Re-apply the exact currently committed checkpoint to one participant.
 *
 * Mobile browsers may suspend an iframe while the server timeline continues.
 * The canonical revision is therefore still current even though the local
 * media endpoint is stale.  This seam deliberately accepts only that exact
 * high-water revision and never advances any authority bookkeeping; it cannot
 * resurrect an older checkpoint or manufacture a new room command.
 */
export async function reconcileCurrentProPlaybackAuthority(
  request: Readonly<ProPlaybackCommitRequest>,
): Promise<ProPlaybackCommitResult> {
  if (!isProPlaybackAuthorityToken(request.authority)) {
    throw new TypeError('A server authority token is required');
  }
  requireSafeCounter(request.committedPlaybackRevision, 'committedPlaybackRevision');
  if (
    request.authority.transitionId !== null ||
    request.committedPlaybackRevision !== request.authority.basePlaybackRevision + 1 ||
    request.committedPlaybackRevision !== highestCommittedPlaybackRevision
  ) {
    return { status: 'superseded', authority: request.authority, reason: 'stale-authority' };
  }
  if (!activeAuthorityRoomMatches(request.authority)) {
    return { status: 'failed', authority: request.authority, reason: 'inactive-room' };
  }
  if (request.isCurrent?.() === false) {
    return { status: 'superseded', authority: request.authority, reason: 'superseded' };
  }
  // A server PREPARE/COMMIT owns the endpoint until it settles. Foreground
  // recovery must never cancel or overtake that newer canonical transition.
  if (activePreparation) {
    return { status: 'superseded', authority: request.authority, reason: 'superseded' };
  }
  const endpoint = mediaEndpoint;
  if (!endpoint) {
    return { status: 'failed', authority: request.authority, reason: 'missing-endpoint' };
  }

  const result = await endpoint.commit(request);
  if (request.isCurrent?.() === false) {
    return { status: 'superseded', authority: request.authority, reason: 'superseded' };
  }
  return result;
}

/** Reset revision and preparation ownership on PRO leave/rejoin. */
export function resetProPlaybackAuthorityHooks(): void {
  const pending = activePreparation;
  prepareGeneration += 1;
  activePreparation = null;
  // Room teardown must release participant-local media work as well as the
  // authority bookkeeping. In particular, YouTube PREPARE owns hard-mute,
  // warm-up, seek, and scheduled-release timers that could otherwise outlive
  // the PRO room and mutate the iframe after the user has left.
  if (pending) mediaEndpoint?.cancel?.(pending.authority);
  highestSeen = null;
  latestApplied = null;
  highestCommittedPlaybackRevision = 0;
  const pendingUiControl = activeUiControl;
  if (pendingUiControl) {
    activeUiControl = null;
    clearManagedTimer(UI_CONTROL_TIMEOUT_TIMER);
    emitUiControlSettlement(pendingUiControl, 'failed');
  }
}
