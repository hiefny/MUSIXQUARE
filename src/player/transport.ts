/**
 * MUSIXQUARE — Playback Transport
 *
 * Manages: play/pause/stop/seek, native Web Audio API buffer lifecycle,
 * supported playback-mode routing, and track position calculation.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MANUAL_SYNC_OFFSET_LIMIT_SEC, MSG, PLAYBACK_STATE } from '../core/constants.ts';
import { clearManagedTimer, delay, getManagedTimer, setManagedTimer } from '../core/timers.ts';
import { IS_WINDOWS } from '../core/platform.ts';
import { getFilePlaybackDestination, initAudio } from '../audio/engine.ts';
import { isSystemAudioActive } from '../audio/system-capture.ts';
import {
  getPlaybackOwnership,
  getPlaybackModeActivity,
  isExternalOwner,
  isPlaybackPausedOrPendingFile,
  isPlaybackIdleCompat,
  isPlaybackIdleCompatModeActivity,
  isSystemAudioOwner,
  isYouTubeOwner,
  setPlaybackFilePaused,
  setPlaybackFilePlaying,
  setPlaybackIdle,
  isPlaybackPlayingFile,
  isPlaybackPlayingSystemAudio,
  setPlaybackTrackMeta,
} from './ownership.ts';
import {
  clearProRoomBoundedFilePlayback,
  commitProRoomBoundedFilePlayback,
  getProRoomBoundedFilePlaybackPosition,
  hasCurrentProRoomBoundedFilePlayback,
} from './pro-room-bounded-playback.ts';
import { broadcast, sendToHost } from '../network/peer.ts';
import { isGuestBlocked } from '../network/guards.ts';
import { getHostNow } from '../network/shared-clock.ts';
import { isFilePlaybackEngineV2Enabled } from './file-playback-engine-gate.ts';
import { getFilePlaybackProductRuntime } from './file-playback-product-runtime.ts';
import {
  getActiveFilePlaybackSnapshot,
  getManagedFilePlaybackPosition,
} from './file-playback-runtime.ts';
import { getCurrentQueueItemId, getQueueItemById, selectQueueItemById } from './queue-model.ts';
import { cancelProRoomPlaylistFileResolution } from '../pro-room/legacy-media-hooks.ts';
import {
  isProPlaybackAuthorityToken,
  routeProPlaybackCommand,
  type ProPlaybackCommitRequest,
} from '../pro-room/playback-authority-hooks.ts';
import { isProRoomTrackChangeIntentPending } from './track-change-intent.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import type { FilePlaybackPosition, FilePlaybackSourceSnapshot } from './file-playback-source.ts';
import type { FilePlaybackProductHostFailureObservation } from './file-playback-product-host-room.ts';
import {
  cancelV2HostMutation,
  enqueueV2HostMutation,
  isCurrentV2HostMutationIntent,
  type V2HostMutationIntent,
} from './v2-host-mutation-lane.ts';
import type {
  QueueItemId,
  V2HostSeekPendingEvent,
  V2HostSeekSettlementStatus,
  V2HostUiControlKind,
  V2HostUiControlPendingEvent,
  V2HostUiControlSettlementStatus,
} from '../types/index.ts';
import { legacyBoundedFileV1Product } from './legacy-bounded-file-v1-product.ts';
import type {
  LegacyBoundedFileV1CanonicalControl,
  LegacyBoundedFileV1CurrentSnapshot,
} from './legacy-bounded-file-v1-runtime.ts';

/** Lead time for a host command to reach guests before the shared start. */
const SCHEDULE_AHEAD_MS = 200;
/** Bounded host includes local scheduling and wire-delivery budget. */
const LEGACY_BOUNDED_V1_HOST_START_LEAD_MS = 400;
/** Guests preserve the shared deadline unless it is genuinely too late to arm. */
const LEGACY_BOUNDED_V1_GUEST_REARM_LEAD_MS = 75;
const FILE_PLAYBACK_ENGINE_V2_ENABLED = isFilePlaybackEngineV2Enabled();
const filePlaybackProductRuntime = getFilePlaybackProductRuntime();
let legacyBoundedV1NaturalEndFence: Readonly<{
  key: string;
  task: Promise<unknown>;
}> | null = null;
let legacyBoundedV1OwnerSwitchGeneration = 0;

interface LegacyBoundedV1ControlContext {
  readonly role: 'host' | 'guest';
  readonly current: Readonly<LegacyBoundedFileV1CurrentSnapshot>;
}

function readLegacyBoundedV1ControlContext(): LegacyBoundedV1ControlContext | null {
  if (isYouTubeOwner() || isSystemAudioOwner()) return null;
  const snapshot = legacyBoundedFileV1Product.snapshot();
  const current = snapshot.current;
  if (
    !snapshot.active ||
    (snapshot.role !== 'host' && snapshot.role !== 'guest') ||
    !current ||
    current.queueItemId !== getCurrentQueueItemId() ||
    (current.state !== 'preparing' && current.state !== 'ready')
  ) {
    return null;
  }
  return Object.freeze({ role: snapshot.role, current });
}

function clampLegacyBoundedV1Position(
  positionSeconds: number,
  current: Readonly<LegacyBoundedFileV1CurrentSnapshot>,
): number {
  const safe = Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0;
  return current.durationSeconds && current.durationSeconds > 0
    ? Math.min(safe, Math.max(0, current.durationSeconds - 0.001))
    : safe;
}

function projectLegacyBoundedV1Snapshot(
  snapshot: Readonly<LegacyBoundedFileV1CurrentSnapshot>,
): void {
  if (snapshot.queueItemId !== getCurrentQueueItemId()) return;
  setState('player.pausedAt', snapshot.positionSeconds);
  if (snapshot.phase === 'playing') {
    setPlaybackFilePlaying();
    transition({
      type: 'PLAY',
      time: snapshot.positionSeconds,
      queueItemId: snapshot.queueItemId,
      sameTrack: true,
    });
    bus.emit('visualizer:start');
    bus.emit('ui:loop-start');
    return;
  }
  if (snapshot.phase === 'paused' || snapshot.phase === 'stopped') {
    setPlaybackFilePaused();
    transition({
      type: 'PAUSE',
      time: snapshot.positionSeconds,
      queueItemId: snapshot.queueItemId,
      endOfPlaylist: false,
    });
    bus.emit('visualizer:hold-frame');
  }
}

function applyLegacyBoundedV1Control(
  control: Readonly<LegacyBoundedFileV1CanonicalControl>,
  options: Readonly<{
    allowBuffered?: boolean;
    hostUiKind?: V2HostUiControlKind;
    projectImmediately?: boolean;
    projectSettlement?: boolean;
  }> = {},
): Promise<boolean> {
  const task = legacyBoundedFileV1Product
    .applyControl(control)
    .then((outcome) => {
      if (outcome.status === 'buffered') return options.allowBuffered === true;
      if (outcome.status !== 'applied') return false;
      const current = legacyBoundedFileV1Product.snapshot().current;
      if (
        !current ||
        current.queueItemId !== control.queueItemId ||
        current.legacySessionId !== control.legacySessionId
      ) {
        return false;
      }
      if (options.projectSettlement !== false) {
        projectLegacyBoundedV1Snapshot(current);
      }
      return true;
    })
    .catch((error) => {
      log.warn('[Transport] Bounded V1 control failed locally:', error);
      return false;
    });

  if (options.projectImmediately) {
    const current = legacyBoundedFileV1Product.snapshot().current;
    if (
      current?.queueItemId === control.queueItemId &&
      current.legacySessionId === control.legacySessionId
    ) {
      projectLegacyBoundedV1Snapshot(current);
    }
  }
  if (options.hostUiKind) {
    trackV2HostUiControl(
      beginV2HostUiControl(options.hostUiKind, control.queueItemId),
      task,
    );
  }
  return task;
}

function exactLegacyBoundedV1Current(
  control: Readonly<LegacyBoundedFileV1CanonicalControl>,
): Readonly<LegacyBoundedFileV1CurrentSnapshot> | null {
  const current = legacyBoundedFileV1Product.snapshot().current;
  return current?.queueItemId === control.queueItemId &&
    current.legacySessionId === control.legacySessionId &&
    current.state === 'ready'
    ? current
    : null;
}

function exactLegacyBoundedV1Identity(
  control: Readonly<LegacyBoundedFileV1CanonicalControl>,
): Readonly<LegacyBoundedFileV1CurrentSnapshot> | null {
  const current = legacyBoundedFileV1Product.snapshot().current;
  return current?.queueItemId === control.queueItemId &&
    current.legacySessionId === control.legacySessionId
    ? current
    : null;
}

function compensateLegacyBoundedV1HostStartFailure(
  control: Readonly<LegacyBoundedFileV1CanonicalControl>,
): void {
  const position = Number.isFinite(control.positionSeconds)
    ? Math.max(0, control.positionSeconds)
    : 0;
  setState('player.pausedAt', position);
  setPlaybackFilePaused();
  transition({
    type: 'PAUSE',
    time: position,
    queueItemId: control.queueItemId,
    endOfPlaylist: false,
  });
  bus.emit('visualizer:hold-frame');
  broadcast({
    type: MSG.PAUSE,
    time: position,
    queueItemId: control.queueItemId,
    reason: 'transition',
  });
}

interface LegacyBoundedV1HostRendezvousRequest {
  readonly label: string;
  readonly queueItemId: QueueItemId;
  readonly legacySessionId: number;
  readonly positionSeconds: number;
  readonly requestedStartAtRoomTimeMs?: number;
  readonly includeTrackName?: boolean;
}

function enqueueLegacyBoundedV1HostRendezvous(
  request: Readonly<LegacyBoundedV1HostRendezvousRequest>,
): Promise<boolean> {
  return enqueueV2HostMutation(request.label, async (intent) => {
    const admitted = legacyBoundedFileV1Product.snapshot().current;
    if (
      !admitted ||
      admitted.queueItemId !== request.queueItemId ||
      admitted.legacySessionId !== request.legacySessionId ||
      admitted.state !== 'ready' ||
      getCurrentQueueItemId() !== request.queueItemId
    ) {
      return false;
    }
    const position = clampLegacyBoundedV1Position(request.positionSeconds, admitted);
    const requestedStart = Number(request.requestedStartAtRoomTimeMs);
    const startAt = Math.max(
      Number.isFinite(requestedStart) ? requestedStart : 0,
      getHostNow() + LEGACY_BOUNDED_V1_HOST_START_LEAD_MS,
    );
    const control: Readonly<LegacyBoundedFileV1CanonicalControl> = Object.freeze({
      kind: admitted.phase === 'playing' ? 'seek-playing' : 'play',
      queueItemId: request.queueItemId,
      legacySessionId: request.legacySessionId,
      positionSeconds: position,
      startAtRoomTimeMs: startAt,
    });
    const revoke = () => {
      legacyBoundedFileV1Product.cancelPendingHostControl(
        request.queueItemId,
        request.legacySessionId,
        position,
      );
    };
    intent.controller.signal.addEventListener('abort', revoke, { once: true });
    try {
      const scheduled = await legacyBoundedFileV1Product.scheduleHostControl(control);
      if (
        scheduled.status !== 'scheduled' ||
        !isCurrentV2HostMutationIntent(intent) ||
        !exactLegacyBoundedV1Current(control)
      ) {
        revoke();
        return false;
      }
      broadcast({
        type: MSG.PLAY,
        time: position,
        queueItemId: request.queueItemId,
        ...(request.includeTrackName
          ? {
              name:
                getState('files.current')?.queueItemId === request.queueItemId
                  ? getState('files.current')?.name
                  : undefined,
            }
          : {}),
        hostPlayAt: scheduled.startAtRoomTimeMs,
      });
      const started = await scheduled.settled;
      const current = exactLegacyBoundedV1Current(control);
      if (
        started.status === 'applied' &&
        current &&
        isCurrentV2HostMutationIntent(intent)
      ) {
        legacyBoundedV1NaturalEndFence = null;
        projectLegacyBoundedV1Snapshot(current);
        return true;
      }
      if (
        started.status === 'failed' &&
        isCurrentV2HostMutationIntent(intent) &&
        exactLegacyBoundedV1Identity(control) &&
        getCurrentQueueItemId() === control.queueItemId
      ) {
        const retired = await legacyBoundedFileV1Product.retireCurrent(
          control.queueItemId,
          control.legacySessionId,
        );
        if (
          retired &&
          isCurrentV2HostMutationIntent(intent) &&
          getCurrentQueueItemId() === control.queueItemId
        ) {
          compensateLegacyBoundedV1HostStartFailure(control);
        }
      }
      return false;
    } finally {
      intent.controller.signal.removeEventListener('abort', revoke);
    }
  }).then(
    (committed) => committed === true,
    (error) => {
      log.warn(`[Transport] ${request.label} lane failed:`, error);
      return false;
    },
  );
}

/**
 * Host PLAY/playing-seek has two authoritative boundaries. The shared PLAY is
 * published after native scheduling while hostPlayAt is still in the future;
 * local UI settles only after exact start evidence. A superseding intent
 * synchronously revokes the staged renderer through the bridge.
 */
export function requestLegacyBoundedV1HostPlay(
  positionSeconds: number,
  startAtRoomTimeMs?: number,
): boolean {
  const context = readLegacyBoundedV1ControlContext();
  if (!context || context.role !== 'host') return false;
  const queueItemId = context.current.queueItemId;
  const legacySessionId = context.current.legacySessionId;
  const requestedPosition = clampLegacyBoundedV1Position(positionSeconds, context.current);
  const requestedStart = Number(startAtRoomTimeMs);
  const settlement = enqueueLegacyBoundedV1HostRendezvous({
    label: 'bounded-v1-play',
    queueItemId,
    legacySessionId,
    positionSeconds: requestedPosition,
    requestedStartAtRoomTimeMs: requestedStart,
    includeTrackName: true,
  });
  trackV2HostUiControl(
    beginV2HostUiControl('play', queueItemId),
    settlement,
  );
  return true;
}

/**
 * PAUSE is deliberately stop-first rather than rendezvous-first. Calling the
 * product control synchronously revokes an armed PLAY before the immediate
 * network PAUSE is published; its physical settlement still drives UI status.
 */
export function requestLegacyBoundedV1HostPause(
  positionSeconds?: number,
  reason: 'pause' | 'seek' = 'pause',
): boolean {
  const context = readLegacyBoundedV1ControlContext();
  if (!context || context.role !== 'host') return false;
  const position = clampLegacyBoundedV1Position(
    positionSeconds ?? legacyBoundedFileV1Product.positionSeconds() ?? 0,
    context.current,
  );
  // Reuse the exact cancellation PAUSE when a PLAY/playing-seek is pending.
  // Starting a second PAUSE with a newer room-time key can otherwise revoke
  // the freshly staged paused successor and falsely enter renderer fallback.
  const pendingCancellation = legacyBoundedFileV1Product.cancelPendingHostControl(
    context.current.queueItemId,
    context.current.legacySessionId,
    position,
  );
  // PAUSE is the latest host intent even when a prior PLAY has not yet been
  // admitted to the shared mutation lane. Cancel that queued/active owner
  // before any stopped fast-path so it cannot revive playback afterward.
  cancelV2HostMutation('Bounded V1 host PLAY was superseded by PAUSE');
  if (pendingCancellation) {
    const current = legacyBoundedFileV1Product.snapshot().current;
    if (current) projectLegacyBoundedV1Snapshot(current);
    const task = pendingCancellation.then((outcome) => outcome.status === 'applied');
    trackV2HostUiControl(
      beginV2HostUiControl('pause', context.current.queueItemId),
      task,
    );
    broadcast({
      type: MSG.PAUSE,
      time: position,
      queueItemId: context.current.queueItemId,
      reason,
    });
    return true;
  }
  if (context.current.state === 'ready' && context.current.phase === 'stopped') {
    setState('player.pausedAt', position);
    return true;
  }
  const control: Readonly<LegacyBoundedFileV1CanonicalControl> = Object.freeze({
    kind: 'pause',
    queueItemId: context.current.queueItemId,
    legacySessionId: context.current.legacySessionId,
    positionSeconds: position,
    atRoomTimeMs: getHostNow(),
  });
  const task = applyLegacyBoundedV1Control(control, {
    hostUiKind: 'pause',
    projectImmediately: true,
  });
  broadcast({
    type: MSG.PAUSE,
    time: position,
    queueItemId: control.queueItemId,
    reason,
  });
  void task.then((applied) => {
    if (!applied) log.warn('[Transport] Bounded V1 host PAUSE did not settle locally');
  });
  return true;
}

function requestLegacyBoundedV1GuestPlay(
  positionSeconds: number,
  startAtRoomTimeMs?: number,
): boolean {
  const context = readLegacyBoundedV1ControlContext();
  if (!context || context.role !== 'guest') return false;
  const now = getHostNow();
  const requestedStart = Number(startAtRoomTimeMs);
  const hasSharedStart = Number.isFinite(requestedStart) && requestedStart > 0;
  // The native port intentionally rejects an already-expired rendezvous.
  // Move only the local arm into the future and advance its position by the
  // same amount so it joins the original host timeline instead of starting
  // late or disconnecting.
  const startAt = hasSharedStart
    ? Math.max(requestedStart, now + LEGACY_BOUNDED_V1_GUEST_REARM_LEAD_MS)
    : now + LEGACY_BOUNDED_V1_HOST_START_LEAD_MS;
  const catchUpSeconds = hasSharedStart ? Math.max(0, startAt - requestedStart) / 1000 : 0;
  const position = clampLegacyBoundedV1Position(
    positionSeconds + catchUpSeconds,
    context.current,
  );
  void applyLegacyBoundedV1Control(
    {
      kind: context.current.phase === 'playing' ? 'seek-playing' : 'play',
      queueItemId: context.current.queueItemId,
      legacySessionId: context.current.legacySessionId,
      positionSeconds: position,
      startAtRoomTimeMs: startAt,
    },
    { allowBuffered: true },
  );
  return true;
}

function requestLegacyBoundedV1Pause(positionSeconds?: number): boolean {
  const context = readLegacyBoundedV1ControlContext();
  if (!context) return false;
  if (context.role === 'host') {
    // Host call sites that need a room-wide PAUSE use the exported helper.
    // This local path exists for teardown/internal callers and avoids an
    // accidental duplicate broadcast.
    const position = clampLegacyBoundedV1Position(
      positionSeconds ?? legacyBoundedFileV1Product.positionSeconds() ?? 0,
      context.current,
    );
    void applyLegacyBoundedV1Control(
      {
        kind: 'pause',
        queueItemId: context.current.queueItemId,
        legacySessionId: context.current.legacySessionId,
        positionSeconds: position,
        atRoomTimeMs: getHostNow(),
      },
      { projectImmediately: true },
    );
    return true;
  }
  const position = clampLegacyBoundedV1Position(
    positionSeconds ?? legacyBoundedFileV1Product.positionSeconds() ?? 0,
    context.current,
  );
  if (context.current.state === 'ready' && context.current.phase === 'stopped') {
    setState('player.pausedAt', position);
    return true;
  }
  void applyLegacyBoundedV1Control(
    {
      kind: 'pause',
      queueItemId: context.current.queueItemId,
      legacySessionId: context.current.legacySessionId,
      positionSeconds: position,
      atRoomTimeMs: getHostNow(),
    },
    {
      allowBuffered: true,
      projectImmediately: true,
    },
  );
  return true;
}

function requestLegacyBoundedV1Stop(): Promise<boolean> | null {
  // STOP is also the cancellation boundary for an async YouTube/system-audio
  // owner switch. Even when the bounded renderer has already finished
  // retiring (and this function therefore finds no current), a later
  // continuation must not resurrect the incoming owner after the user stopped
  // playback or left/replaced the selection.
  legacyBoundedV1OwnerSwitchGeneration += 1;
  const context = readLegacyBoundedV1ControlContext();
  if (context?.role === 'host') {
    cancelV2HostMutation('Bounded V1 host mutation was superseded by STOP');
  }
  if (context?.current.state === 'ready') {
    return applyLegacyBoundedV1Control(
      {
        kind: 'stop',
        queueItemId: context.current.queueItemId,
        legacySessionId: context.current.legacySessionId,
        positionSeconds: 0,
        atRoomTimeMs: getHostNow(),
      },
      {
        // stopAllMediaLegacy owns the terminal IDLE/reset projection. A delayed
        // native retirement must not resurrect file-paused UI after teardown.
        projectSettlement: false,
      },
    );
  }

  // Cross-mode and terminal transitions can update selection/ownership before
  // teardown runs. Retire the exact product incarnation independently of the
  // newly selected queue item so an old current or preparing candidate cannot
  // overlap YouTube, a stable-V1 fallback, or the empty playlist.
  const snapshot = legacyBoundedFileV1Product.snapshot();
  const current = snapshot.current;
  if (
    !snapshot.active ||
    (snapshot.role !== 'host' && snapshot.role !== 'guest') ||
    !current
  ) {
    return null;
  }
  if (snapshot.role === 'host') {
    cancelV2HostMutation('Bounded V1 host incarnation was retired by teardown');
  }
  return legacyBoundedFileV1Product.retireCurrent(
    current.queueItemId,
    current.legacySessionId,
  );
}

/**
 * Exact physical-owner barrier for non-file modes. It does not publish a room
 * command or project UI; the incoming YouTube/system-audio owner performs its
 * ordinary stable-V1 transition only after this promise settles.
 */
export function requestLegacyBoundedV1OwnerSwitchRetirement(): Readonly<{
  readonly settled: Promise<boolean>;
  readonly isCurrent: () => boolean;
}> | null {
  const generation = ++legacyBoundedV1OwnerSwitchGeneration;
  const snapshot = legacyBoundedFileV1Product.snapshot();
  const current = snapshot.current;
  if (
    !snapshot.active ||
    (snapshot.role !== 'host' && snapshot.role !== 'guest') ||
    !current
  ) {
    return null;
  }
  if (snapshot.role === 'host') {
    cancelV2HostMutation('Bounded V1 host incarnation was retired by an owner switch');
  }
  return Object.freeze({
    settled: legacyBoundedFileV1Product.retireCurrent(
      current.queueItemId,
      current.legacySessionId,
    ),
    isCurrent: () => generation === legacyBoundedV1OwnerSwitchGeneration,
  });
}

/**
 * System-audio temporarily overlays the selected queue occurrence. Stop its
 * bounded renderer but retain the exact descriptor/source so a later host PLAY
 * can reopen the same occurrence without another FILE_PREPARE. A guest source
 * that is still preparing has no physical STOP settlement yet, so it must be
 * retired instead of treating a buffered control as released output.
 */
export function requestLegacyBoundedV1OwnerSwitchStop(): Readonly<{
  readonly settled: Promise<boolean>;
  readonly isCurrent: () => boolean;
}> | null {
  const generation = ++legacyBoundedV1OwnerSwitchGeneration;
  const snapshot = legacyBoundedFileV1Product.snapshot();
  const current = snapshot.current;
  if (
    !snapshot.active ||
    (snapshot.role !== 'host' && snapshot.role !== 'guest') ||
    !current
  ) {
    return null;
  }
  const settled =
    current.state === 'ready'
      ? applyLegacyBoundedV1Control(
          {
            kind: 'stop',
            queueItemId: current.queueItemId,
            legacySessionId: current.legacySessionId,
            positionSeconds: 0,
            atRoomTimeMs: getHostNow(),
          },
          {
            allowBuffered: true,
            projectSettlement: false,
          },
        )
      : legacyBoundedFileV1Product.retireCurrent(
          current.queueItemId,
          current.legacySessionId,
        );
  return Object.freeze({
    settled,
    isCurrent: () => generation === legacyBoundedV1OwnerSwitchGeneration,
  });
}

export function requestLegacyBoundedV1HostSeek(time: number): boolean {
  const context = readLegacyBoundedV1ControlContext();
  if (!context || context.role !== 'host') return false;
  const position = clampLegacyBoundedV1Position(time, context.current);
  const playing = context.current.phase === 'playing';
  if (playing) {
    const queueItemId = context.current.queueItemId;
    const legacySessionId = context.current.legacySessionId;
    void enqueueLegacyBoundedV1HostRendezvous({
      label: 'bounded-v1-seek-playing',
      queueItemId,
      legacySessionId,
      positionSeconds: position,
    });
  } else if (context.current.state === 'ready') {
    const control: Readonly<LegacyBoundedFileV1CanonicalControl> = Object.freeze({
      kind: context.current.phase === 'paused' ? 'seek-paused' : 'pause',
      queueItemId: context.current.queueItemId,
      legacySessionId: context.current.legacySessionId,
      positionSeconds: position,
      atRoomTimeMs: getHostNow(),
    });
    const task = applyLegacyBoundedV1Control(control, { projectImmediately: true });
    broadcast({
      type: MSG.PAUSE,
      time: position,
      queueItemId: context.current.queueItemId,
      reason: 'seek',
    });
    void task.then((applied) => {
      if (!applied) log.warn('[Transport] Bounded V1 paused seek did not settle locally');
    });
  } else {
    // PREPARE leaves an exact decoded candidate staged but not yet native
    // current. Keep the requested paused baseline in stable UI/control state;
    // the next PLAY commits that exact candidate at this position.
    setState('player.pausedAt', position);
    broadcast({
      type: MSG.PAUSE,
      time: position,
      queueItemId: context.current.queueItemId,
      reason: 'seek',
    });
  }
  return true;
}

/**
 * Re-arms the bounded host renderer after this browser's physical output was
 * suspended. Canonical playing truth gets one same-position room rendezvous;
 * merely recovering an AudioContext while paused never manufactures PLAY.
 */
export function requestLegacyBoundedV1HostOutputRejoin(
  reason: 'media-session-play' | 'audio-context-recovered',
): Promise<boolean> | null {
  const context = readLegacyBoundedV1ControlContext();
  if (!context || context.role !== 'host') return null;
  if (context.current.state !== 'ready') return Promise.resolve(false);
  if (context.current.phase !== 'playing' && reason === 'audio-context-recovered') {
    return Promise.resolve(true);
  }
  const position = clampLegacyBoundedV1Position(
    legacyBoundedFileV1Product.positionSeconds() ?? context.current.positionSeconds,
    context.current,
  );
  const settlement = enqueueLegacyBoundedV1HostRendezvous({
    label: 'bounded-v1-output-rejoin',
    queueItemId: context.current.queueItemId,
    legacySessionId: context.current.legacySessionId,
    positionSeconds: position,
  });
  if (reason === 'media-session-play') {
    trackV2HostUiControl(
      beginV2HostUiControl('play', context.current.queueItemId),
      settlement,
    );
  }
  return settlement;
}

export function applyLegacyBoundedV1GuestPlay(
  queueItemId: QueueItemId,
  positionSeconds: number,
  hostPlayAt?: number,
): boolean {
  const context = readLegacyBoundedV1ControlContext();
  if (
    !context ||
    context.role !== 'guest' ||
    context.current.queueItemId !== queueItemId
  ) {
    return false;
  }
  return requestLegacyBoundedV1GuestPlay(positionSeconds, hostPlayAt);
}

export function applyLegacyBoundedV1GuestPause(
  queueItemId: QueueItemId,
  positionSeconds: number,
): boolean {
  const context = readLegacyBoundedV1ControlContext();
  if (
    !context ||
    context.role !== 'guest' ||
    context.current.queueItemId !== queueItemId
  ) {
    return false;
  }
  return requestLegacyBoundedV1Pause(positionSeconds);
}

/** Calibrated output advance for Windows local-file playback. */
const WINDOWS_LOCAL_FILE_OUTPUT_ADVANCE_SEC = 0.02;

// The play lock is page-global, so every timer/finally that releases it must
// prove it still belongs to the invocation that claimed it. A load epoch
// cannot serve this purpose: stopAllMedia({silent:true}) deliberately does not
// advance that epoch, while it still tears down the play-lock tuple.
let playInvocationGeneration = 0;

// A play invocation owns the page-global lock until its async setup settles,
// but PAUSE must be able to revoke the pending node start without stealing
// that lock ownership (otherwise the invocation's finally cannot unlock it).
// Keep this semantic fence separate from playInvocationGeneration.
let playStartFence = 0;

/**
 * Latest deferred node-start intent.
 *
 * `playback.pendingPlayTime` remains the cross-module pipeline mailbox used by
 * decode/fetch completion. A play-lock deferral needs more information than
 * that legacy scalar: its authority predicate and absolute scheduling
 * deadline must survive the current lock owner.
 */
interface PendingPlayIntent {
  readonly offset: number;
  readonly scheduleDelay: number;
  readonly scheduleDeadlineMs?: number;
  readonly shouldApply?: () => boolean;
}

let pendingPlayIntent: PendingPlayIntent | null = null;

function queuePendingPlayIntent(intent: PendingPlayIntent): void {
  pendingPlayIntent = intent;
  setPendingPlayTime(intent.offset);
}

function clearPendingPlayIntent(): void {
  pendingPlayIntent = null;
  setPendingPlayTime(undefined);
}

function takePendingPlayIntent(): PendingPlayIntent | null {
  const intent = pendingPlayIntent;
  pendingPlayIntent = null;
  // A decode/preload completion may have published a newer scalar mailbox
  // while this lock owner was awaiting AudioContext setup. Only consume the
  // legacy mirror when this unlock actually owns a typed lock intent.
  if (intent) setPendingPlayTime(undefined);
  return intent;
}

function claimPlayInvocation(): number {
  playInvocationGeneration += 1;
  return playInvocationGeneration;
}

function invalidatePlayInvocation(): void {
  playInvocationGeneration += 1;
}

function isCurrentPlayInvocation(invocation: number): boolean {
  return invocation === playInvocationGeneration;
}

function revokeInFlightPlayStart(): void {
  playStartFence += 1;
}

function getPlatformLocalFileOutputOffset(): number {
  return IS_WINDOWS ? WINDOWS_LOCAL_FILE_OUTPUT_ADVANCE_SEC : 0;
}

function getEffectiveLocalFileOutputOffset(): number {
  return (getState('sync.localOffset') || 0) + getPlatformLocalFileOutputOffset();
}

export function isFilePipelineBusyForPlay(): boolean {
  const lifecycle = getState('playback.lifecycle');
  return (
    lifecycle === PLAYBACK_STATE.DOWNLOADING ||
    lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD ||
    lifecycle === PLAYBACK_STATE.DECODING
  );
}

import {
  getPlayerNode,
  setPlayerNode,
  getCurrentAudioBuffer,
  getCurrentLoadEpoch,
  isCurrentLoadEpoch,
  newLoadEpoch,
  incrementLoadSessionId,
  isPlayLocked,
  setPlayLocked,
  setPendingPlayTime,
  setPlayPreloadedInProgress,
  setCurrentAudioBuffer,
} from './_state.ts';

import { getAudioContext, getCurrentTime, ensureRunning } from '../audio/context.ts';
import { showToast } from '../ui/toast.ts';
import { transition } from './lifecycle.ts';

// ─── Format Helpers ────────────────────────────────────────────────

export function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return '0:00';
  const total = Math.max(0, Math.floor(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const ss = sec < 10 ? `0${sec}` : `${sec}`;
  // Hours segment only appears at ≥1h — keeps short tracks as "m:ss"
  // (the vast majority) and promotes long tracks (podcasts, DJ sets,
  // multi-hour YouTube livestreams) to "h:mm:ss" with a zero-padded
  // minutes field so the digit count is stable inside that hour.
  if (h > 0) {
    const mm = m < 10 ? `0${m}` : `${m}`;
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
}

// ─── Playback Mode Helpers ────────────────────────────────────────

function isCompatIdle(): boolean {
  return isPlaybackIdleCompat();
}

function isFileTransportInactive(): boolean {
  const playback = getPlaybackModeActivity();
  return isPlaybackIdleCompatModeActivity(playback) || isPlaybackPausedOrPendingFile(playback);
}

function isFilePlaybackPlaying(): boolean {
  return isPlaybackPlayingFile(getPlaybackModeActivity());
}

function isSystemAudioPlaying(): boolean {
  return isPlaybackPlayingSystemAudio(getPlaybackModeActivity());
}

type V2HostControlPhase = 'playing' | 'paused';

interface V2HostControlState {
  readonly room: Readonly<{
    readonly schemaVersion: 1;
    readonly roomGeneration: number;
    readonly applicationSessionId: string;
    readonly hostParticipantId: string;
  }>;
  readonly queueItemId: QueueItemId;
  readonly runId: string;
  readonly revision: number;
  readonly phase: V2HostControlPhase;
  readonly durationSeconds: number | null;
  readonly position: FilePlaybackPosition;
}

type V2HostSeekTargetResolver = (state: V2HostControlState) => number | null;
type V2HostControlIntent = V2HostMutationIntent;
type V2HostControlOperation = (intent: V2HostControlIntent) => Promise<void>;

type V2HostTransitionIdentity = Readonly<{
  room: V2HostControlState['room'];
  queueItemId: QueueItemId;
  runId: string;
  revision: number;
}>;

type V2HostFailureIdentity = V2HostTransitionIdentity &
  Readonly<{
    positionSeconds: number;
    durationSeconds: number | null;
    observation: FilePlaybackProductHostFailureObservation;
  }>;

type V2HostFailedPauseCheckpoint = Readonly<{
  failure: V2HostFailureIdentity;
  positionSeconds: number;
}>;

let lastV2HostEndedObservationKey: string | null = null;
let lastV2HostFailureObservationKey: string | null = null;
let explicitV2HostFailureHoldKey: string | null = null;
let v2HostFailedPauseCheckpoint: V2HostFailedPauseCheckpoint | null = null;
let pendingV2HostTogglePhase: V2HostControlPhase | null = null;
let pendingV2HostToggleSequence = 0;
let activeV2HostFailureRecovery: {
  key: string;
  requestedPositionSeconds: number;
  appliedPositionSeconds: number | null;
  task: Promise<boolean>;
} | null = null;
let v2HostSeekUiSequence = 0;
let activeV2HostSeekUiIntent: Readonly<V2HostSeekPendingEvent> | null = null;
const V2_HOST_UI_CONTROL_TIMEOUT_TIMER = 'v2-host-ui-control-timeout';
const V2_HOST_UI_CONTROL_FAIL_OPEN_MS = 15_000;
let v2HostUiControlSequence = 0;
let activeV2HostUiControl: Readonly<V2HostUiControlPendingEvent> | null = null;

function isV2HostFileControlContext(): boolean {
  if (
    !FILE_PLAYBACK_ENGINE_V2_ENABLED ||
    getRoomContext().kind !== 'standard' ||
    getState('network.appRole') !== 'host' ||
    getState('network.hostConn') ||
    getState('demo.active')
  ) {
    return false;
  }

  const hostParticipantId = getState('network.myId');
  if (!hostParticipantId) return false;

  try {
    const room = filePlaybackProductRuntime.hostRoomSnapshot();
    return isExactV2HostRoom(room) && room.hostParticipantId === hostParticipantId;
  } catch {
    // A missing, stale, or failed product runtime must not capture legacy,
    // PRO, guest, or teardown controls.
    return false;
  }
}

function isExactV2HostRoom(value: unknown): value is V2HostControlState['room'] {
  if (value === null || typeof value !== 'object' || !Object.isFrozen(value)) return false;
  const room = value as Partial<V2HostControlState['room']>;
  return (
    room.schemaVersion === 1 &&
    Number.isSafeInteger(room.roomGeneration) &&
    (room.roomGeneration ?? 0) > 0 &&
    typeof room.applicationSessionId === 'string' &&
    room.applicationSessionId.length > 0 &&
    typeof room.hostParticipantId === 'string' &&
    room.hostParticipantId.length > 0
  );
}

function sameV2HostRoom(
  left: V2HostControlState['room'],
  right: V2HostControlState['room'],
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.roomGeneration === right.roomGeneration &&
    left.applicationSessionId === right.applicationSessionId &&
    left.hostParticipantId === right.hostParticipantId
  );
}

function exactV2RendererIdentity(
  snapshot: FilePlaybackSourceSnapshot | null,
  queueItemId: QueueItemId,
): snapshot is FilePlaybackSourceSnapshot & {
  readonly phase: V2HostControlPhase;
  readonly run: NonNullable<FilePlaybackSourceSnapshot['run']>;
} {
  if (!snapshot || !Object.isFrozen(snapshot) || !Object.isFrozen(snapshot.run)) return false;
  return (
    (snapshot.phase === 'playing' || snapshot.phase === 'paused') &&
    snapshot.queueItemId === queueItemId &&
    snapshot.run !== null &&
    snapshot.run.queueItemId === queueItemId &&
    typeof snapshot.run.runId === 'string' &&
    snapshot.run.runId.length > 0 &&
    Number.isSafeInteger(snapshot.revision) &&
    snapshot.revision > 0 &&
    snapshot.run.revision === snapshot.revision
  );
}

function sameV2RendererState(
  left: FilePlaybackSourceSnapshot & {
    readonly phase: V2HostControlPhase;
    readonly run: NonNullable<FilePlaybackSourceSnapshot['run']>;
  },
  right: FilePlaybackSourceSnapshot & {
    readonly phase: V2HostControlPhase;
    readonly run: NonNullable<FilePlaybackSourceSnapshot['run']>;
  },
): boolean {
  return (
    left.queueItemId === right.queueItemId &&
    left.phase === right.phase &&
    left.revision === right.revision &&
    left.run.runId === right.run.runId &&
    left.run.revision === right.run.revision
  );
}

function exactV2Position(
  position: FilePlaybackPosition | null,
  snapshot: FilePlaybackSourceSnapshot & {
    readonly phase: V2HostControlPhase;
    readonly run: NonNullable<FilePlaybackSourceSnapshot['run']>;
  },
): position is FilePlaybackPosition & {
  readonly run: NonNullable<FilePlaybackPosition['run']>;
} {
  return !!(
    position &&
    Object.isFrozen(position) &&
    Object.isFrozen(position.run) &&
    position.run &&
    position.queueItemId === snapshot.queueItemId &&
    position.phase === snapshot.phase &&
    position.run.queueItemId === snapshot.queueItemId &&
    position.run.runId === snapshot.run.runId &&
    position.run.revision === snapshot.revision &&
    Number.isFinite(position.positionSeconds) &&
    position.positionSeconds >= 0
  );
}

function readExactV2HostControlState(): V2HostControlState | null {
  if (!isV2HostFileControlContext()) return null;
  try {
    const roomBefore = filePlaybackProductRuntime.hostRoomSnapshot();
    if (!isExactV2HostRoom(roomBefore)) return null;
    const queueItemId = getCurrentQueueItemId();
    const item = getQueueItemById(queueItemId);
    if (!queueItemId || !item || item.type === 'youtube') return null;
    const mode = getPlaybackModeActivity();
    const renderer = getActiveFilePlaybackSnapshot();
    if (!exactV2RendererIdentity(renderer, queueItemId)) return null;
    if (mode.mode !== 'file' || (mode.activity !== 'playing' && mode.activity !== 'paused')) {
      return null;
    }
    const position = getManagedFilePlaybackPosition(queueItemId);
    if (!exactV2Position(position, renderer)) return null;
    const rendererAfter = getActiveFilePlaybackSnapshot();
    const roomAfter = filePlaybackProductRuntime.hostRoomSnapshot();
    if (
      !exactV2RendererIdentity(rendererAfter, queueItemId) ||
      !sameV2RendererState(renderer, rendererAfter) ||
      !isExactV2HostRoom(roomAfter) ||
      !sameV2HostRoom(roomBefore, roomAfter)
    ) {
      return null;
    }
    const durationSeconds =
      typeof rendererAfter.durationSeconds === 'number' &&
      Number.isFinite(rendererAfter.durationSeconds) &&
      rendererAfter.durationSeconds > 0
        ? rendererAfter.durationSeconds
        : null;
    return Object.freeze({
      room: roomAfter,
      queueItemId,
      runId: rendererAfter.run.runId,
      revision: rendererAfter.revision,
      phase: rendererAfter.phase,
      durationSeconds,
      position,
    });
  } catch {
    return null;
  }
}

function sameV2HostFailureIdentity(
  left: V2HostFailureIdentity,
  right: V2HostFailureIdentity,
): boolean {
  return (
    sameV2HostRoom(left.room, right.room) &&
    left.queueItemId === right.queueItemId &&
    left.runId === right.runId &&
    left.revision === right.revision
  );
}

function readV2HostFailedPauseCheckpoint(): V2HostFailedPauseCheckpoint | null {
  const checkpoint = v2HostFailedPauseCheckpoint;
  if (!checkpoint) return null;
  if (!isV2HostFileControlContext()) {
    v2HostFailedPauseCheckpoint = null;
    return null;
  }
  try {
    const currentRoom = filePlaybackProductRuntime.hostRoomSnapshot();
    const queueItemId = getCurrentQueueItemId();
    const item = getQueueItemById(queueItemId);
    if (
      !isExactV2HostRoom(currentRoom) ||
      !sameV2HostRoom(currentRoom, checkpoint.failure.room) ||
      queueItemId !== checkpoint.failure.queueItemId ||
      !item ||
      item.type === 'youtube'
    ) {
      v2HostFailedPauseCheckpoint = null;
      return null;
    }

    const active = readExactV2HostControlState();
    if (active) {
      v2HostFailedPauseCheckpoint = null;
      return null;
    }
    const failure = readExactV2HostFailureIdentity();
    if (failure && !sameV2HostFailureIdentity(failure, checkpoint.failure)) {
      v2HostFailedPauseCheckpoint = null;
      return null;
    }
    return checkpoint;
  } catch {
    v2HostFailedPauseCheckpoint = null;
    return null;
  }
}

function rememberV2HostFailedPause(
  failure: V2HostFailureIdentity,
  positionSeconds = failure.positionSeconds,
): V2HostFailedPauseCheckpoint {
  const checkpoint = Object.freeze({
    failure,
    positionSeconds,
  });
  v2HostFailedPauseCheckpoint = checkpoint;
  return checkpoint;
}

function readExactV2HostFailureIdentity(): V2HostFailureIdentity | null {
  if (!isV2HostFileControlContext()) return null;
  try {
    const roomBefore = filePlaybackProductRuntime.hostRoomSnapshot();
    if (!isExactV2HostRoom(roomBefore)) return null;
    const queueItemId = getCurrentQueueItemId();
    const item = getQueueItemById(queueItemId);
    if (!queueItemId || !item || item.type === 'youtube') return null;
    const observation = filePlaybackProductRuntime.currentHostFailedRendererObservation();
    if (
      !observation ||
      !Object.isFrozen(observation) ||
      observation.phase !== 'failed' ||
      observation.queueItemId !== queueItemId ||
      !observation.run ||
      !Object.isFrozen(observation.run) ||
      observation.run.queueItemId !== queueItemId ||
      observation.run.revision !== observation.revision ||
      typeof observation.run.runId !== 'string' ||
      observation.run.runId.length === 0 ||
      !Number.isSafeInteger(observation.revision) ||
      observation.revision <= 0
    ) {
      return null;
    }
    const roomAfter = filePlaybackProductRuntime.hostRoomSnapshot();
    const observationAfter = filePlaybackProductRuntime.currentHostFailedRendererObservation();
    if (
      !isExactV2HostRoom(roomAfter) ||
      !sameV2HostRoom(roomBefore, roomAfter) ||
      !observationAfter ||
      observationAfter.queueItemId !== observation.queueItemId ||
      observationAfter.revision !== observation.revision ||
      observationAfter.run?.runId !== observation.run.runId
    ) {
      return null;
    }
    const durationSeconds =
      typeof observation.durationSeconds === 'number' &&
      Number.isFinite(observation.durationSeconds) &&
      observation.durationSeconds > 0
        ? observation.durationSeconds
        : null;
    const rawPosition =
      Number.isFinite(observation.positionSeconds) && observation.positionSeconds >= 0
        ? observation.positionSeconds
        : getState('player.pausedAt');
    const positionSeconds =
      clampV2HostSeekTarget(
        Number.isFinite(rawPosition) && rawPosition >= 0 ? rawPosition : 0,
        durationSeconds,
      ) ?? 0;
    return Object.freeze({
      room: roomAfter,
      queueItemId,
      runId: observation.run.runId,
      revision: observation.revision,
      positionSeconds,
      durationSeconds,
      observation,
    });
  } catch {
    return null;
  }
}

function clampV2HostSeekTarget(value: number, durationSeconds: number | null): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  if (durationSeconds === null) return value;
  return Math.min(value, Math.max(0, durationSeconds - 0.1));
}

function readV2HostSeekSettlementPosition(fallback: number): number {
  const exact = readExactV2HostControlState();
  const exactPosition = exact?.position.positionSeconds;
  if (typeof exactPosition === 'number' && Number.isFinite(exactPosition) && exactPosition >= 0) {
    return exactPosition;
  }
  const compatibilityPosition = getState('player.pausedAt');
  if (Number.isFinite(compatibilityPosition) && compatibilityPosition >= 0) {
    return compatibilityPosition;
  }
  return Number.isFinite(fallback) && fallback >= 0 ? fallback : 0;
}

function emitV2HostSeekSettled(
  intent: Readonly<V2HostSeekPendingEvent>,
  status: V2HostSeekSettlementStatus,
  positionSeconds: number,
): void {
  bus.emit(
    'player:v2-host-seek-settled',
    Object.freeze({
      token: intent.token,
      queueItemId: intent.queueItemId,
      status,
      positionSeconds,
    }),
  );
}

function beginV2HostSeekUiIntent(
  state: V2HostControlState,
  targetSeconds: number,
): Readonly<V2HostSeekPendingEvent> {
  const previous = activeV2HostSeekUiIntent;
  const intent = Object.freeze({
    token: ++v2HostSeekUiSequence,
    queueItemId: state.queueItemId,
    targetSeconds,
  });
  activeV2HostSeekUiIntent = intent;
  bus.emit('player:v2-host-seek-pending', intent);
  if (previous) {
    emitV2HostSeekSettled(
      previous,
      'superseded',
      readV2HostSeekSettlementPosition(previous.targetSeconds),
    );
  }
  return intent;
}

function refreshV2HostSeekUiTarget(
  intent: Readonly<V2HostSeekPendingEvent>,
  targetSeconds: number,
): Readonly<V2HostSeekPendingEvent> | null {
  if (activeV2HostSeekUiIntent?.token !== intent.token) return null;
  if (activeV2HostSeekUiIntent.targetSeconds === targetSeconds) return activeV2HostSeekUiIntent;
  const refreshed = Object.freeze({
    token: intent.token,
    queueItemId: intent.queueItemId,
    targetSeconds,
  });
  activeV2HostSeekUiIntent = refreshed;
  bus.emit('player:v2-host-seek-pending', refreshed);
  return refreshed;
}

function settleV2HostSeekUiIntent(
  intent: Readonly<V2HostSeekPendingEvent>,
  status: V2HostSeekSettlementStatus,
  positionSeconds = readV2HostSeekSettlementPosition(intent.targetSeconds),
): boolean {
  if (activeV2HostSeekUiIntent?.token !== intent.token) return false;
  activeV2HostSeekUiIntent = null;
  emitV2HostSeekSettled(intent, status, positionSeconds);
  return true;
}

function supersedeActiveV2HostSeekUiIntent(): void {
  const intent = activeV2HostSeekUiIntent;
  if (!intent) return;
  activeV2HostSeekUiIntent = null;
  emitV2HostSeekSettled(
    intent,
    'superseded',
    readV2HostSeekSettlementPosition(intent.targetSeconds),
  );
}

function sameV2HostSeekAdmission(
  admitted: V2HostControlState,
  current: V2HostControlState,
): boolean {
  return (
    sameV2HostRoom(admitted.room, current.room) &&
    admitted.queueItemId === current.queueItemId &&
    admitted.runId === current.runId
  );
}

function isExactCommittedV2HostSeek(
  value: unknown,
  before: V2HostControlState,
  target: number,
): boolean {
  if (value === null || typeof value !== 'object' || !Object.isFrozen(value)) return false;
  try {
    const commit = value as {
      readonly status?: unknown;
      readonly kind?: unknown;
      readonly roomGeneration?: unknown;
      readonly applicationSessionId?: unknown;
      readonly hostParticipantId?: unknown;
      readonly attempt?: {
        readonly queueItemId?: unknown;
        readonly runId?: unknown;
        readonly revision?: unknown;
      };
      readonly schedule?: { readonly positionSeconds?: unknown };
      readonly asset?: { readonly queueItemId?: unknown };
      readonly startEvidence?: unknown;
      readonly evidence?: {
        readonly kind?: unknown;
        readonly from?: {
          readonly queueItemId?: unknown;
          readonly runId?: unknown;
          readonly revision?: unknown;
        };
        readonly to?: {
          readonly queueItemId?: unknown;
          readonly runId?: unknown;
          readonly revision?: unknown;
        };
        readonly positionSeconds?: unknown;
      };
      readonly timeline?: {
        readonly phase?: unknown;
        readonly revision?: unknown;
        readonly positionSeconds?: unknown;
        readonly run?: { readonly queueItemId?: unknown; readonly runId?: unknown } | null;
      };
    };
    const timeline = commit.timeline;
    const run = timeline?.run;
    if (
      commit.status !== 'committed' ||
      commit.roomGeneration !== before.room.roomGeneration ||
      commit.applicationSessionId !== before.room.applicationSessionId ||
      commit.hostParticipantId !== before.room.hostParticipantId ||
      !Object.isFrozen(timeline) ||
      !Object.isFrozen(run) ||
      timeline?.phase !== before.phase ||
      timeline.positionSeconds !== target ||
      timeline.revision !== before.revision + 1 ||
      run?.queueItemId !== before.queueItemId ||
      run.runId !== before.runId
    ) {
      return false;
    }
    if (before.phase === 'playing') {
      return (
        Object.isFrozen(commit.asset) &&
        Object.isFrozen(commit.attempt) &&
        Object.isFrozen(commit.schedule) &&
        Object.isFrozen(commit.startEvidence) &&
        commit.asset?.queueItemId === before.queueItemId &&
        commit.attempt?.queueItemId === before.queueItemId &&
        commit.attempt.runId === before.runId &&
        commit.attempt.revision === timeline.revision &&
        commit.schedule?.positionSeconds === target
      );
    }
    const evidence = commit.evidence;
    return (
      commit.kind === 'seek' &&
      Object.isFrozen(evidence) &&
      Object.isFrozen(evidence?.from) &&
      Object.isFrozen(evidence?.to) &&
      evidence?.kind === 'seek-applied' &&
      evidence.from?.queueItemId === before.queueItemId &&
      evidence.from.runId === before.runId &&
      evidence.from.revision === before.revision &&
      evidence.to?.queueItemId === before.queueItemId &&
      evidence.to.runId === before.runId &&
      evidence.to.revision === before.revision + 1 &&
      evidence.positionSeconds === target
    );
  } catch {
    return false;
  }
}

function remainsExactV2HostSeekCommit(
  before: V2HostControlState,
  committed: unknown,
  target: number,
): boolean {
  if (!isExactCommittedV2HostSeek(committed, before, target)) return false;
  const after = readExactV2HostControlState();
  return !!(
    after &&
    sameV2HostRoom(after.room, before.room) &&
    after.queueItemId === before.queueItemId &&
    after.runId === before.runId &&
    after.revision === before.revision + 1 &&
    after.phase === before.phase &&
    getCurrentQueueItemId() === before.queueItemId &&
    getQueueItemById(before.queueItemId)
  );
}

function readExactV2HostAdvancedState(
  before: V2HostControlState,
  phase: V2HostControlPhase,
): V2HostControlState | null {
  const after = readExactV2HostControlState();
  return after &&
    sameV2HostRoom(after.room, before.room) &&
    after.queueItemId === before.queueItemId &&
    after.runId === before.runId &&
    after.revision === before.revision + 1 &&
    after.phase === phase &&
    getCurrentQueueItemId() === before.queueItemId &&
    getQueueItemById(before.queueItemId)
    ? after
    : null;
}

function exactV2HostPauseCommitPosition(value: unknown, before: V2HostControlState): number | null {
  if (value === null || typeof value !== 'object' || !Object.isFrozen(value)) return null;
  try {
    const commit = value as {
      readonly status?: unknown;
      readonly kind?: unknown;
      readonly roomGeneration?: unknown;
      readonly applicationSessionId?: unknown;
      readonly hostParticipantId?: unknown;
      readonly evidence?: {
        readonly kind?: unknown;
        readonly from?: {
          readonly queueItemId?: unknown;
          readonly runId?: unknown;
          readonly revision?: unknown;
        };
        readonly to?: {
          readonly queueItemId?: unknown;
          readonly runId?: unknown;
          readonly revision?: unknown;
        };
      };
      readonly timeline?: {
        readonly phase?: unknown;
        readonly revision?: unknown;
        readonly positionSeconds?: unknown;
        readonly run?: { readonly queueItemId?: unknown; readonly runId?: unknown } | null;
      };
    };
    const evidence = commit.evidence;
    const timeline = commit.timeline;
    const run = timeline?.run;
    if (
      commit.status !== 'committed' ||
      commit.kind !== 'pause' ||
      commit.roomGeneration !== before.room.roomGeneration ||
      commit.applicationSessionId !== before.room.applicationSessionId ||
      commit.hostParticipantId !== before.room.hostParticipantId ||
      !Object.isFrozen(evidence) ||
      !Object.isFrozen(evidence?.from) ||
      !Object.isFrozen(evidence?.to) ||
      evidence?.kind !== 'pause-applied' ||
      evidence.from?.queueItemId !== before.queueItemId ||
      evidence.from.runId !== before.runId ||
      evidence.from.revision !== before.revision ||
      evidence.to?.queueItemId !== before.queueItemId ||
      evidence.to.runId !== before.runId ||
      evidence.to.revision !== before.revision + 1 ||
      !Object.isFrozen(timeline) ||
      !Object.isFrozen(run) ||
      timeline?.phase !== 'paused' ||
      timeline.revision !== before.revision + 1 ||
      run?.queueItemId !== before.queueItemId ||
      run.runId !== before.runId ||
      typeof timeline.positionSeconds !== 'number' ||
      !Number.isFinite(timeline.positionSeconds) ||
      timeline.positionSeconds < 0
    ) {
      return null;
    }
    return timeline.positionSeconds;
  } catch {
    return null;
  }
}

function exactV2HostResumeCommitPosition(
  value: unknown,
  before: V2HostControlState,
): number | null {
  if (value === null || typeof value !== 'object' || !Object.isFrozen(value)) return null;
  try {
    const commit = value as {
      readonly status?: unknown;
      readonly roomGeneration?: unknown;
      readonly applicationSessionId?: unknown;
      readonly hostParticipantId?: unknown;
      readonly asset?: { readonly queueItemId?: unknown };
      readonly attempt?: {
        readonly queueItemId?: unknown;
        readonly runId?: unknown;
        readonly revision?: unknown;
      };
      readonly schedule?: { readonly positionSeconds?: unknown };
      readonly startEvidence?: unknown;
      readonly timeline?: {
        readonly phase?: unknown;
        readonly revision?: unknown;
        readonly positionSeconds?: unknown;
        readonly run?: { readonly queueItemId?: unknown; readonly runId?: unknown } | null;
      };
    };
    const timeline = commit.timeline;
    const run = timeline?.run;
    if (
      commit.status !== 'committed' ||
      commit.roomGeneration !== before.room.roomGeneration ||
      commit.applicationSessionId !== before.room.applicationSessionId ||
      commit.hostParticipantId !== before.room.hostParticipantId ||
      !Object.isFrozen(commit.asset) ||
      commit.asset?.queueItemId !== before.queueItemId ||
      !Object.isFrozen(commit.attempt) ||
      commit.attempt?.queueItemId !== before.queueItemId ||
      commit.attempt.runId !== before.runId ||
      commit.attempt.revision !== before.revision + 1 ||
      !Object.isFrozen(commit.schedule) ||
      typeof commit.schedule?.positionSeconds !== 'number' ||
      !Number.isFinite(commit.schedule.positionSeconds) ||
      commit.schedule.positionSeconds < 0 ||
      !Object.isFrozen(commit.startEvidence) ||
      !Object.isFrozen(timeline) ||
      !Object.isFrozen(run) ||
      timeline?.phase !== 'playing' ||
      timeline.revision !== before.revision + 1 ||
      typeof timeline.positionSeconds !== 'number' ||
      !Number.isFinite(timeline.positionSeconds) ||
      timeline.positionSeconds < 0 ||
      timeline.positionSeconds !== commit.schedule.positionSeconds ||
      run?.queueItemId !== before.queueItemId ||
      run.runId !== before.runId
    ) {
      return null;
    }
    return timeline.positionSeconds;
  } catch {
    return null;
  }
}

function sameV2HostTransitionIdentity(
  left: V2HostTransitionIdentity,
  right: V2HostTransitionIdentity,
): boolean {
  return (
    sameV2HostRoom(left.room, right.room) &&
    left.queueItemId === right.queueItemId &&
    left.runId === right.runId &&
    left.revision === right.revision
  );
}

function readExactV2HostTerminalIdentity(): V2HostTransitionIdentity | null {
  if (!isV2HostFileProductControlContext()) return null;
  try {
    const roomBefore = filePlaybackProductRuntime.hostRoomSnapshot();
    if (!isExactV2HostRoom(roomBefore)) return null;
    const queueItemId = getCurrentQueueItemId();
    const item = getQueueItemById(queueItemId);
    const mode = getPlaybackModeActivity();
    if (
      !queueItemId ||
      !item ||
      item.type === 'youtube' ||
      mode.mode !== 'file' ||
      mode.activity !== 'playing'
    ) {
      return null;
    }
    const observation = filePlaybackProductRuntime.currentHostTerminalRendererObservation();
    if (
      !observation ||
      !Object.isFrozen(observation) ||
      observation.phase !== 'ended' ||
      observation.queueItemId !== queueItemId ||
      !Object.isFrozen(observation.run) ||
      !observation.run ||
      observation.run.queueItemId !== queueItemId ||
      typeof observation.run.runId !== 'string' ||
      observation.run.runId.length === 0 ||
      !Number.isSafeInteger(observation.revision) ||
      observation.revision <= 0 ||
      observation.run.revision !== observation.revision
    ) {
      return null;
    }
    const observationAfter = filePlaybackProductRuntime.currentHostTerminalRendererObservation();
    const roomAfter = filePlaybackProductRuntime.hostRoomSnapshot();
    if (
      !observationAfter ||
      !Object.isFrozen(observationAfter) ||
      observationAfter.phase !== 'ended' ||
      observationAfter.queueItemId !== queueItemId ||
      !Object.isFrozen(observationAfter.run) ||
      !observationAfter.run ||
      observationAfter.run.queueItemId !== queueItemId ||
      observationAfter.run.runId !== observation.run.runId ||
      observationAfter.revision !== observation.revision ||
      observationAfter.run.revision !== observation.revision ||
      !isExactV2HostRoom(roomAfter) ||
      !sameV2HostRoom(roomBefore, roomAfter)
    ) {
      return null;
    }
    return Object.freeze({
      room: roomAfter,
      queueItemId,
      runId: observationAfter.run.runId,
      revision: observationAfter.revision,
    });
  } catch {
    return null;
  }
}

function exactV2HostStoppedCommit(
  value: unknown,
  before: V2HostTransitionIdentity,
  kind: 'stop' | 'ended',
): boolean {
  if (value === null || typeof value !== 'object' || !Object.isFrozen(value)) return false;
  try {
    const commit = value as {
      readonly status?: unknown;
      readonly kind?: unknown;
      readonly roomGeneration?: unknown;
      readonly applicationSessionId?: unknown;
      readonly hostParticipantId?: unknown;
      readonly evidence?: {
        readonly kind?: unknown;
        readonly observation?: unknown;
        readonly from?: {
          readonly queueItemId?: unknown;
          readonly runId?: unknown;
          readonly revision?: unknown;
        };
        readonly to?: {
          readonly queueItemId?: unknown;
          readonly runId?: unknown;
          readonly revision?: unknown;
        };
        readonly targetFrame?: unknown;
        readonly appliedFrame?: unknown;
        readonly observedAtRoomTimeMs?: unknown;
      };
      readonly timeline?: {
        readonly phase?: unknown;
        readonly revision?: unknown;
        readonly positionSeconds?: unknown;
        readonly run?: unknown;
      };
    };
    const evidence = commit.evidence;
    const timeline = commit.timeline;
    if (!evidence || !timeline) return false;
    if (
      commit.status !== 'committed' ||
      commit.kind !== kind ||
      commit.roomGeneration !== before.room.roomGeneration ||
      commit.applicationSessionId !== before.room.applicationSessionId ||
      commit.hostParticipantId !== before.room.hostParticipantId ||
      !Object.isFrozen(evidence) ||
      !Object.isFrozen(evidence?.from) ||
      !Object.isFrozen(evidence?.to) ||
      evidence.from?.queueItemId !== before.queueItemId ||
      evidence.from.runId !== before.runId ||
      evidence.from.revision !== before.revision ||
      evidence.to?.queueItemId !== before.queueItemId ||
      evidence.to.runId !== before.runId ||
      evidence.to.revision !== before.revision + 1 ||
      !Object.isFrozen(timeline) ||
      timeline?.phase !== 'stopped' ||
      timeline.revision !== before.revision + 1 ||
      timeline.run !== null ||
      timeline.positionSeconds !== 0
    ) {
      return false;
    }
    if (kind === 'stop') {
      if (evidence.kind === 'stop-applied') {
        if (
          evidence.observation !== 'webaudio-schedule-passed' ||
          !Number.isSafeInteger(evidence.targetFrame) ||
          !Number.isSafeInteger(evidence.appliedFrame) ||
          (evidence.targetFrame as number) < 0 ||
          (evidence.appliedFrame as number) < (evidence.targetFrame as number)
        ) {
          return false;
        }
      } else if (
        evidence.kind !== 'failed-stop-applied' ||
        evidence.observation !== 'source-failed-retired'
      ) {
        return false;
      }
    } else if (
      evidence.kind !== 'ended-renderer-retired' ||
      typeof evidence.observedAtRoomTimeMs !== 'number' ||
      !Number.isFinite(evidence.observedAtRoomTimeMs) ||
      evidence.observedAtRoomTimeMs < 0
    ) {
      return false;
    }

    const roomAfter = filePlaybackProductRuntime.hostRoomSnapshot();
    return !!(
      isExactV2HostRoom(roomAfter) &&
      sameV2HostRoom(roomAfter, before.room) &&
      filePlaybackProductRuntime.currentHostRendererSnapshot() === null &&
      filePlaybackProductRuntime.currentHostTerminalRendererObservation() === null &&
      getCurrentQueueItemId() === before.queueItemId &&
      getQueueItemById(before.queueItemId)
    );
  } catch {
    return false;
  }
}

type V2HostStopOptions = Readonly<{
  silent?: boolean;
  cancelInFlight?: boolean;
  clearBuffer?: boolean;
  preservePlaylistIntent?: boolean;
  /** Stop legacy owners without retiring a silent PRO cutover candidate. */
  preserveProBoundedCandidate?: boolean;
}>;

function publishV2HostStopped(options: V2HostStopOptions = {}): void {
  if (options.cancelInFlight) {
    newLoadEpoch();
    incrementLoadSessionId();
  }
  clearManagedTimer('preloadScheduleTimer');
  clearManagedTimer('autoPlayTimer');
  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');
  clearManagedTimer('playback-replay-defer');
  setPlaybackIdle();
  setState('player.pausedAt', 0);
  lastV2HostFailureObservationKey = null;
  explicitV2HostFailureHoldKey = null;
  v2HostFailedPauseCheckpoint = null;
  if (options.clearBuffer) setCurrentAudioBuffer(null);
  bus.emit('ui:seek-reset');
  bus.emit('visualizer:fade-out');
}

function publishV2HostPaused(
  positionSeconds: number,
  options: Readonly<{ holdVisualizer: boolean; showToast: boolean }>,
): void {
  explicitV2HostFailureHoldKey = null;
  v2HostFailedPauseCheckpoint = null;
  setState('player.pausedAt', positionSeconds);
  setPlaybackFilePaused();
  bus.emit('ui:play-btn-state', true);
  if (options.holdVisualizer) bus.emit('visualizer:hold-frame');
  if (options.showToast) showToast(t('common.pause'));
}

function publishV2HostPlaying(positionSeconds: number): void {
  explicitV2HostFailureHoldKey = null;
  v2HostFailedPauseCheckpoint = null;
  setState('player.pausedAt', positionSeconds);
  setPlaybackFilePlaying();
  bus.emit('ui:play-btn-state', true);
  bus.emit('visualizer:start');
  bus.emit('ui:loop-start');
}

function publishV2HostFailedPaused(failure: V2HostFailureIdentity, positionSeconds: number): void {
  supersedeActiveV2HostSeekUiIntent();
  setState('player.pausedAt', positionSeconds);
  setPlaybackFilePaused();
  bus.emit('ui:update-play-state', false);
  bus.emit('ui:play-btn-state', true);
  if (failure.durationSeconds !== null) {
    bus.emit('ui:duration-update', failure.durationSeconds);
  }
  bus.emit(
    'ui:time-update',
    fmtTime(positionSeconds),
    fmtTime(failure.durationSeconds ?? 0),
    positionSeconds,
    failure.durationSeconds ?? 0,
  );
  bus.emit('visualizer:hold-frame');
}

function emitV2HostUiControlSettlement(
  event: Readonly<V2HostUiControlPendingEvent>,
  status: V2HostUiControlSettlementStatus,
): void {
  bus.emit(
    'player:v2-host-ui-control-settled',
    Object.freeze({
      token: event.token,
      kind: event.kind,
      queueItemId: event.queueItemId,
      status,
    }),
  );
}

function settleV2HostUiControl(token: number, status: V2HostUiControlSettlementStatus): boolean {
  const event = activeV2HostUiControl;
  if (!event || event.token !== token) return false;
  activeV2HostUiControl = null;
  clearManagedTimer(V2_HOST_UI_CONTROL_TIMEOUT_TIMER);
  emitV2HostUiControlSettlement(event, status);
  return true;
}

function supersedeActiveV2HostUiControl(): void {
  const event = activeV2HostUiControl;
  if (!event) return;
  settleV2HostUiControl(event.token, 'superseded');
}

function beginV2HostUiControl(
  kind: V2HostUiControlKind,
  queueItemId: QueueItemId | null = getCurrentQueueItemId(),
): Readonly<V2HostUiControlPendingEvent> {
  supersedeActiveV2HostUiControl();
  const event = Object.freeze({
    token: ++v2HostUiControlSequence,
    kind,
    queueItemId,
  });
  activeV2HostUiControl = event;
  bus.emit('player:v2-host-ui-control-pending', event);
  setManagedTimer(
    V2_HOST_UI_CONTROL_TIMEOUT_TIMER,
    () => settleV2HostUiControl(event.token, 'failed'),
    V2_HOST_UI_CONTROL_FAIL_OPEN_MS,
  );
  return event;
}

function trackV2HostUiControl(
  event: Readonly<V2HostUiControlPendingEvent>,
  task: Promise<boolean>,
): void {
  void task.then(
    (committed) => settleV2HostUiControl(event.token, committed ? 'committed' : 'failed'),
    () => settleV2HostUiControl(event.token, 'failed'),
  );
}

function isCurrentV2HostControlIntent(intent: V2HostControlIntent): boolean {
  return isCurrentV2HostMutationIntent(intent);
}

function enqueueV2HostControl(label: string, operation: V2HostControlOperation): Promise<void> {
  // Every new mutation supersedes local feedback owned by an older request.
  // A control that needs feedback begins its replacement token synchronously
  // after this enqueue call, before the mutation can pass its first await.
  supersedeActiveV2HostUiControl();
  if (label !== 'seek') supersedeActiveV2HostSeekUiIntent();
  if (label !== 'toggle') {
    pendingV2HostTogglePhase = null;
    pendingV2HostToggleSequence += 1;
  }
  return enqueueV2HostMutation(label, operation).then(
    () => undefined,
    (error) => {
      log.warn(`[Transport] V2 host ${label} lane failed:`, error);
    },
  );
}

function v2HostFailureObservationKey(identity: V2HostFailureIdentity): string {
  return JSON.stringify([
    identity.room.roomGeneration,
    identity.room.applicationSessionId,
    identity.room.hostParticipantId,
    identity.queueItemId,
    identity.runId,
    identity.revision,
  ]);
}

async function recoverV2HostFailureWithinMutation(
  intent: V2HostControlIntent,
  observed: V2HostFailureIdentity,
  active: NonNullable<typeof activeV2HostFailureRecovery>,
): Promise<boolean> {
  const key = v2HostFailureObservationKey(observed);
  const before = readExactV2HostFailureIdentity();
  if (
    !before ||
    !sameV2HostFailureIdentity(before, observed) ||
    v2HostFailureObservationKey(before) !== key
  ) {
    return false;
  }

  const { recoverV2HostLocalFileOutputWithinMutation } = await import('./playlist.ts');
  if (!isCurrentV2HostControlIntent(intent)) return false;
  const recoveryTarget = active.requestedPositionSeconds;
  let recovered = await recoverV2HostLocalFileOutputWithinMutation(
    intent,
    observed.queueItemId,
    recoveryTarget,
  );
  const after = readExactV2HostControlState();
  recovered =
    recovered &&
    !!after &&
    after.queueItemId === observed.queueItemId &&
    after.phase === 'playing' &&
    sameV2HostRoom(after.room, observed.room) &&
    (after.runId !== observed.runId || after.revision !== observed.revision);
  if (!recovered || !after) return false;
  active.appliedPositionSeconds = after.position.positionSeconds;
  if (!isCurrentV2HostControlIntent(intent)) {
    // The replacement may have crossed commit-dominant before a newer
    // control superseded it. Playlist reconciliation already projected the
    // exact successor; report this request as unsatisfied so output-rejoin
    // callers do not clear their local pause before the successor control.
    return false;
  }

  // A seek can arrive while replacement preparation is already commit
  // dominant. Preserve that latest intent and correct the freshly committed
  // renderer before releasing this control lane instead of silently using
  // the older recovery position.
  while (
    isCurrentV2HostControlIntent(intent) &&
    Math.abs(active.requestedPositionSeconds - active.appliedPositionSeconds) > 1e-6
  ) {
    const current = readExactV2HostControlState();
    if (
      !current ||
      current.phase !== 'playing' ||
      current.queueItemId !== observed.queueItemId ||
      !sameV2HostRoom(current.room, observed.room)
    ) {
      return false;
    }
    const latestTarget =
      clampV2HostSeekTarget(active.requestedPositionSeconds, current.durationSeconds) ??
      current.position.positionSeconds;
    const commit = await filePlaybackProductRuntime.seekPlaying({
      positionSeconds: latestTarget,
      signal: intent.controller.signal,
    });
    if (!remainsExactV2HostSeekCommit(current, commit, latestTarget)) return false;
    active.appliedPositionSeconds = latestTarget;
    if (!isCurrentV2HostControlIntent(intent)) return false;
  }
  publishV2HostPlaying(active.appliedPositionSeconds);
  return true;
}

function beginV2HostFailureRecovery(
  observed: V2HostFailureIdentity,
  requestedPositionSeconds: number,
  options: Readonly<{ force: boolean }>,
): Promise<boolean> | null {
  const key = v2HostFailureObservationKey(observed);
  const target =
    clampV2HostSeekTarget(requestedPositionSeconds, observed.durationSeconds) ??
    observed.positionSeconds;
  if (activeV2HostFailureRecovery?.key === key) {
    activeV2HostFailureRecovery.requestedPositionSeconds = target;
    publishV2HostFailedPaused(observed, target);
    return activeV2HostFailureRecovery.task;
  }
  if (!options.force && lastV2HostFailureObservationKey === key) return null;

  lastV2HostFailureObservationKey = key;
  publishV2HostFailedPaused(observed, target);

  const active = {
    key,
    requestedPositionSeconds: target,
    appliedPositionSeconds: null as number | null,
    task: Promise.resolve(false),
  };
  activeV2HostFailureRecovery = active;
  let recovered = false;
  const settlement = enqueueV2HostControl('renderer recovery', async (intent) => {
    recovered = await recoverV2HostFailureWithinMutation(intent, observed, active);
  });
  const task = settlement.then(
    () => recovered,
    () => false,
  );
  active.task = task;
  void task.then((didRecover) => {
    if (activeV2HostFailureRecovery === active) activeV2HostFailureRecovery = null;
    if (didRecover && lastV2HostFailureObservationKey === key) {
      lastV2HostFailureObservationKey = null;
      return;
    }
    if (lastV2HostFailureObservationKey === key) {
      log.warn(
        '[Transport] V2 host renderer recovery failed closed; explicit Play can retry the exact track',
      );
    }
  });
  return task;
}

function requestV2HostFailedRendererRecovery(
  options: Readonly<{
    force: boolean;
    positionSeconds?: number;
  }>,
): boolean {
  const observed = readExactV2HostFailureIdentity();
  if (!observed) return false;
  const key = v2HostFailureObservationKey(observed);
  if (!options.force && explicitV2HostFailureHoldKey === key) {
    publishV2HostFailedPaused(observed, observed.positionSeconds);
    return true;
  }
  if (options.force) explicitV2HostFailureHoldKey = null;
  const positionSeconds =
    options.positionSeconds === undefined ? observed.positionSeconds : options.positionSeconds;
  void beginV2HostFailureRecovery(observed, positionSeconds, { force: options.force });
  return true;
}

function enqueueV2HostSeek(resolveTarget: V2HostSeekTargetResolver): Promise<boolean> {
  const admitted = readExactV2HostControlState();
  if (!admitted) return Promise.resolve(false);
  let admittedTarget: number | null;
  try {
    admittedTarget = resolveTarget(admitted);
  } catch (error) {
    log.warn('[Transport] V2 host seek admission failed:', error);
    return Promise.resolve(false);
  }
  if (admittedTarget === null || !Number.isFinite(admittedTarget) || admittedTarget < 0) {
    return Promise.resolve(false);
  }
  const uiIntent = beginV2HostSeekUiIntent(admitted, admittedTarget);
  let committed = false;

  const settlement = enqueueV2HostControl('seek', async (intent) => {
    const before = readExactV2HostControlState();
    if (!before || !sameV2HostSeekAdmission(admitted, before)) {
      settleV2HostSeekUiIntent(uiIntent, 'failed');
      return;
    }
    let target: number | null;
    try {
      target = resolveTarget(before);
    } catch (error) {
      if (isCurrentV2HostControlIntent(intent)) {
        log.warn('[Transport] V2 host seek target resolution failed:', error);
        settleV2HostSeekUiIntent(uiIntent, 'failed');
      }
      return;
    }
    if (target === null || !Number.isFinite(target) || target < 0) {
      settleV2HostSeekUiIntent(uiIntent, 'failed');
      return;
    }
    if (!refreshV2HostSeekUiTarget(uiIntent, target)) return;
    let commit: unknown;
    try {
      commit =
        before.phase === 'playing'
          ? await filePlaybackProductRuntime.seekPlaying({
              positionSeconds: target,
              signal: intent.controller.signal,
            })
          : await filePlaybackProductRuntime.seekPaused({
              positionSeconds: target,
              signal: intent.controller.signal,
            });
    } catch (error) {
      if (isCurrentV2HostControlIntent(intent)) {
        log.warn('[Transport] V2 host seek failed:', error);
        settleV2HostSeekUiIntent(uiIntent, 'failed', readV2HostSeekSettlementPosition(target));
      }
      return;
    }
    if (!remainsExactV2HostSeekCommit(before, commit, target)) {
      settleV2HostSeekUiIntent(
        uiIntent,
        isCurrentV2HostControlIntent(intent) ? 'failed' : 'superseded',
        readV2HostSeekSettlementPosition(target),
      );
      return;
    }
    const timeline = (commit as { readonly timeline: { readonly positionSeconds: number } })
      .timeline;
    setState('player.pausedAt', timeline.positionSeconds);
    if (before.phase === 'paused') {
      setPlaybackFilePaused();
      bus.emit('visualizer:hold-frame');
    } else {
      setPlaybackFilePlaying();
    }
    const stillCurrent = isCurrentV2HostControlIntent(intent);
    settleV2HostSeekUiIntent(
      uiIntent,
      stillCurrent ? 'committed' : 'superseded',
      timeline.positionSeconds,
    );
    committed = stillCurrent;
  });

  // The lane intentionally absorbs operation errors so later controls can
  // continue. Pair that behavior with a terminal UI result in case an
  // unexpected exception escaped one of the explicit seek branches above.
  return settlement.then(
    () => {
      settleV2HostSeekUiIntent(uiIntent, 'failed');
      return committed;
    },
    () => {
      settleV2HostSeekUiIntent(uiIntent, 'failed');
      return false;
    },
  );
}

async function applyV2HostPause(
  intent: V2HostControlIntent,
  before: V2HostControlState,
  options: Readonly<{ holdVisualizer: boolean; showToast: boolean }>,
): Promise<boolean> {
  if (before.phase !== 'playing') return false;
  const commit = await filePlaybackProductRuntime.pauseCurrent({
    signal: intent.controller.signal,
  });
  const positionSeconds = exactV2HostPauseCommitPosition(commit, before);
  const after = readExactV2HostAdvancedState(before, 'paused');
  if (positionSeconds === null || !after) return false;
  // The exact committed revision and the exact physical paused revision are
  // the phase authority. Their independently sampled positions may straddle
  // audio frames; a position skew must never leave the UI claiming "playing"
  // after the renderer has physically paused.
  publishV2HostPaused(positionSeconds, {
    holdVisualizer: options.holdVisualizer,
    showToast: options.showToast && isCurrentV2HostControlIntent(intent),
  });
  return true;
}

async function applyV2HostResume(
  intent: V2HostControlIntent,
  initial: V2HostControlState,
  requestedPositionSeconds?: number,
): Promise<boolean> {
  if (initial.phase !== 'paused') return false;
  let beforeResume = initial;
  if (requestedPositionSeconds !== undefined) {
    const target = clampV2HostSeekTarget(requestedPositionSeconds, initial.durationSeconds);
    if (target === null) return false;
    if (Math.abs(target - initial.position.positionSeconds) > 1e-6) {
      const seekCommit = await filePlaybackProductRuntime.seekPaused({
        positionSeconds: target,
        signal: intent.controller.signal,
      });
      if (!remainsExactV2HostSeekCommit(initial, seekCommit, target)) {
        return false;
      }
      const afterSeek = readExactV2HostAdvancedState(initial, 'paused');
      if (!afterSeek) return false;
      setState('player.pausedAt', target);
      setPlaybackFilePaused();
      bus.emit('visualizer:hold-frame');
      beforeResume = afterSeek;
      if (!isCurrentV2HostControlIntent(intent)) return false;
    }
  }

  const commit = await filePlaybackProductRuntime.resumeCurrent({
    signal: intent.controller.signal,
  });
  const committedPosition = exactV2HostResumeCommitPosition(commit, beforeResume);
  const after = readExactV2HostAdvancedState(beforeResume, 'playing');
  if (committedPosition === null || !after) return false;
  const stillCurrent = isCurrentV2HostControlIntent(intent);
  // A commit-dominant resume must still be projected so its queued successor
  // can reconcile from exact physical truth. It must not, however, report a
  // successful output rejoin after a newer PAUSE superseded the request.
  publishV2HostPlaying(committedPosition);
  return stillCurrent;
}

async function applyV2HostFailedPause(
  intent: V2HostControlIntent,
  failure: V2HostFailureIdentity,
  options: Readonly<{ showToast: boolean }>,
): Promise<boolean> {
  const remembered = readV2HostFailedPauseCheckpoint();
  const checkpoint =
    remembered && sameV2HostFailureIdentity(remembered.failure, failure)
      ? remembered
      : rememberV2HostFailedPause(failure);
  let commit: unknown;
  try {
    commit = await filePlaybackProductRuntime.stopCurrent({
      signal: intent.controller.signal,
    });
  } catch (error) {
    if (isCurrentV2HostControlIntent(intent)) {
      log.warn('[Transport] V2 failed-renderer pause stop failed:', error);
    }
    return false;
  }
  if (!exactV2HostStoppedCommit(commit, failure, 'stop')) return false;

  // A failed local renderer cannot produce a truthful PAUSE transition. Retire
  // its exact run through the controller's STOP boundary so healthy guests stop
  // as well. Preserve only a fenced local checkpoint so a later trusted PLAY
  // can create a fresh run at the user's position.
  publishV2HostStopped();
  v2HostFailedPauseCheckpoint = checkpoint;
  // STOP is the authoritative room phase, but the host's failed output remains
  // a resumable local pause affordance. Repaint the exact checkpoint in the
  // same task so the seekbar/duration never flash to 0 while healthy guests
  // have already received the canonical stop.
  publishV2HostFailedPaused(failure, checkpoint.positionSeconds);
  const stillCurrent = isCurrentV2HostControlIntent(intent);
  if (options.showToast && stillCurrent) showToast(t('common.pause'));
  return stillCurrent;
}

async function resumeV2HostFailedPauseWithinMutation(
  intent: V2HostControlIntent,
  checkpoint: V2HostFailedPauseCheckpoint,
): Promise<boolean> {
  const currentCheckpoint = readV2HostFailedPauseCheckpoint();
  if (currentCheckpoint !== checkpoint) return false;

  const currentFailure = readExactV2HostFailureIdentity();
  if (currentFailure) {
    const recovery = {
      key: v2HostFailureObservationKey(currentFailure),
      requestedPositionSeconds: checkpoint.positionSeconds,
      appliedPositionSeconds: null as number | null,
      task: Promise.resolve(false),
    };
    const recovered = await recoverV2HostFailureWithinMutation(intent, currentFailure, recovery);
    const after = readExactV2HostControlState();
    if (
      after?.phase === 'playing' &&
      after.queueItemId === checkpoint.failure.queueItemId &&
      sameV2HostRoom(after.room, checkpoint.failure.room)
    ) {
      v2HostFailedPauseCheckpoint = null;
    }
    return recovered;
  }

  const { recoverV2HostLocalFileOutputWithinMutation } = await import('./playlist.ts');
  if (!isCurrentV2HostControlIntent(intent)) return false;
  const recovered = await recoverV2HostLocalFileOutputWithinMutation(
    intent,
    checkpoint.failure.queueItemId,
    checkpoint.positionSeconds,
  );
  const after = readExactV2HostControlState();
  const physicallyRecovered =
    recovered &&
    !!after &&
    after.phase === 'playing' &&
    after.queueItemId === checkpoint.failure.queueItemId &&
    sameV2HostRoom(after.room, checkpoint.failure.room);
  if (!physicallyRecovered || !after) return false;
  v2HostFailedPauseCheckpoint = null;
  if (!isCurrentV2HostControlIntent(intent)) return false;
  publishV2HostPlaying(after.position.positionSeconds);
  return true;
}

function enqueueV2HostFailedPauseResume(): Promise<boolean> {
  let committed = false;
  const settlement = enqueueV2HostControl('failed pause resume', async (intent) => {
    const checkpoint = readV2HostFailedPauseCheckpoint();
    if (!checkpoint) return;
    committed = await resumeV2HostFailedPauseWithinMutation(intent, checkpoint);
  });
  return settlement.then(() => committed);
}

function enqueueV2HostPause(
  options: Readonly<{ holdVisualizer: boolean; showToast: boolean }>,
): Promise<boolean> {
  let committed = false;
  const settlement = enqueueV2HostControl('pause', async (intent) => {
    const before = readExactV2HostControlState();
    if (before?.phase === 'playing') {
      committed = await applyV2HostPause(intent, before, options);
      return;
    }
    if (before?.phase === 'paused') {
      publishV2HostPaused(before.position.positionSeconds, {
        holdVisualizer: options.holdVisualizer,
        showToast: false,
      });
      committed = isCurrentV2HostControlIntent(intent);
      return;
    }
    const failed = readExactV2HostFailureIdentity();
    if (!failed) return;
    const key = v2HostFailureObservationKey(failed);
    explicitV2HostFailureHoldKey = key;
    lastV2HostFailureObservationKey = key;
    const checkpoint = readV2HostFailedPauseCheckpoint();
    publishV2HostFailedPaused(
      failed,
      checkpoint && sameV2HostFailureIdentity(checkpoint.failure, failed)
        ? checkpoint.positionSeconds
        : failed.positionSeconds,
    );
    committed = await applyV2HostFailedPause(intent, failed, {
      showToast: options.showToast,
    });
  });
  return settlement.then(() => committed);
}

function enqueueV2HostResume(requestedPositionSeconds?: number): Promise<boolean> {
  let committed = false;
  const settlement = enqueueV2HostControl('resume', async (intent) => {
    const before = readExactV2HostControlState();
    if (!before) return;
    committed = await applyV2HostResume(intent, before, requestedPositionSeconds);
  });
  return settlement.then(() => committed);
}

function enqueueV2HostToggle(): void {
  const projected = readExactV2HostControlState();
  const failed = projected ? null : readExactV2HostFailureIdentity();
  const basePhase =
    pendingV2HostTogglePhase ??
    projected?.phase ??
    (failed
      ? explicitV2HostFailureHoldKey === v2HostFailureObservationKey(failed)
        ? 'paused'
        : 'playing'
      : null);
  if (!basePhase) return;
  const desiredPhase: V2HostControlPhase = basePhase === 'playing' ? 'paused' : 'playing';
  pendingV2HostTogglePhase = desiredPhase;
  const toggleSequence = ++pendingV2HostToggleSequence;

  let committed = false;
  const settlement = enqueueV2HostControl('toggle', async (intent) => {
    const before = readExactV2HostControlState();
    if (desiredPhase === 'paused') {
      if (before?.phase === 'playing') {
        committed = await applyV2HostPause(intent, before, {
          holdVisualizer: true,
          showToast: true,
        });
        return;
      }
      if (before?.phase === 'paused') {
        publishV2HostPaused(before.position.positionSeconds, {
          holdVisualizer: true,
          showToast: false,
        });
        committed = isCurrentV2HostControlIntent(intent);
        return;
      }
      const currentFailure = readExactV2HostFailureIdentity();
      if (!currentFailure) return;
      const key = v2HostFailureObservationKey(currentFailure);
      explicitV2HostFailureHoldKey = key;
      lastV2HostFailureObservationKey = key;
      publishV2HostFailedPaused(currentFailure, currentFailure.positionSeconds);
      committed = await applyV2HostFailedPause(intent, currentFailure, { showToast: true });
      return;
    }

    explicitV2HostFailureHoldKey = null;
    if (before?.phase === 'paused') {
      committed = await applyV2HostResume(intent, before);
      return;
    }
    if (before?.phase === 'playing') {
      publishV2HostPlaying(before.position.positionSeconds);
      committed = isCurrentV2HostControlIntent(intent);
      return;
    }
    const currentFailure = readExactV2HostFailureIdentity();
    if (!currentFailure) return;
    const key = v2HostFailureObservationKey(currentFailure);
    lastV2HostFailureObservationKey = key;
    const recovery = {
      key,
      requestedPositionSeconds: currentFailure.positionSeconds,
      appliedPositionSeconds: null as number | null,
      task: Promise.resolve(false),
    };
    committed = await recoverV2HostFailureWithinMutation(intent, currentFailure, recovery);
  });
  const uiControl = beginV2HostUiControl(
    desiredPhase === 'playing' ? 'play' : 'pause',
    projected?.queueItemId ?? failed?.queueItemId ?? getCurrentQueueItemId(),
  );
  trackV2HostUiControl(
    uiControl,
    settlement.then(() => committed),
  );
  void settlement.finally(() => {
    if (pendingV2HostToggleSequence === toggleSequence) pendingV2HostTogglePhase = null;
  });
}

async function enqueueV2HostStop(options: V2HostStopOptions): Promise<boolean> {
  let committed = false;
  await enqueueV2HostControl('stop', async (intent) => {
    const before = readExactV2HostControlState();
    const failed = before ? null : readExactV2HostFailureIdentity();
    const terminal = before || failed ? null : readExactV2HostTerminalIdentity();
    const identity = before ?? failed ?? terminal;
    if (!identity) return;
    let commit: unknown;
    try {
      commit =
        before || failed
          ? await filePlaybackProductRuntime.stopCurrent({
              signal: intent.controller.signal,
            })
          : await filePlaybackProductRuntime.settleEndedCurrent({
              signal: intent.controller.signal,
            });
    } catch (error) {
      if (isCurrentV2HostControlIntent(intent)) {
        log.warn('[Transport] V2 host stop failed:', error);
      }
      return;
    }
    if (!exactV2HostStoppedCommit(commit, identity, before || failed ? 'stop' : 'ended')) return;
    publishV2HostStopped(options);
    committed = isCurrentV2HostControlIntent(intent);
  });
  return committed;
}

function v2HostEndedObservationKey(identity: V2HostTransitionIdentity): string {
  return JSON.stringify([
    identity.room.roomGeneration,
    identity.room.applicationSessionId,
    identity.room.hostParticipantId,
    identity.queueItemId,
    identity.runId,
    identity.revision,
  ]);
}

function requestV2HostEndedSettlement(): boolean {
  if (!isV2HostFileProductControlContext()) return false;
  const observed = readExactV2HostTerminalIdentity();
  if (!observed) return true;
  const observationKey = v2HostEndedObservationKey(observed);
  if (lastV2HostEndedObservationKey === observationKey) return true;
  lastV2HostEndedObservationKey = observationKey;

  const settlement = enqueueV2HostControl('ended', async (intent) => {
    const before = readExactV2HostTerminalIdentity();
    if (
      !before ||
      !sameV2HostTransitionIdentity(before, observed) ||
      v2HostEndedObservationKey(before) !== observationKey
    ) {
      return;
    }
    let commit: unknown;
    try {
      commit = await filePlaybackProductRuntime.settleEndedCurrent({
        signal: intent.controller.signal,
      });
    } catch (error) {
      if (isCurrentV2HostControlIntent(intent)) {
        log.warn('[Transport] V2 host ended settlement failed:', error);
      }
      return;
    }
    if (!exactV2HostStoppedCommit(commit, before, 'ended')) return;
    publishV2HostStopped();
    if (isCurrentV2HostControlIntent(intent)) bus.emit('player:ended');
  });
  void settlement.then(() => {
    if (lastV2HostEndedObservationKey !== observationKey) return;
    const stillTerminal = readExactV2HostTerminalIdentity();
    if (
      stillTerminal &&
      sameV2HostTransitionIdentity(stillTerminal, observed) &&
      v2HostEndedObservationKey(stillTerminal) === observationKey
    ) {
      // A failed or pre-dispatch-superseded settlement may be retried by the
      // next safety poll. Successful settlement has no terminal observation.
      lastV2HostEndedObservationKey = null;
    }
  });
  return true;
}

function isV2HostFileProductControlContext(): boolean {
  return (
    readLegacyBoundedV1ControlContext() === null &&
    isV2HostFileControlContext() &&
    !isYouTubeOwner() &&
    !isSystemAudioOwner()
  );
}

interface V2HostFreshLocalFileSelection {
  readonly queueItemId: QueueItemId;
  readonly file: File;
}

/**
 * A canonical V2 STOP (and a pre-commit preparation failure) deliberately
 * leaves playlist selection intact while retiring every renderer. That is a
 * fresh-start state, not a resumable renderer and not legacy ownership.
 */
function readV2HostFreshLocalFileSelection(): V2HostFreshLocalFileSelection | null {
  if (!isV2HostFileProductControlContext()) return null;
  const playback = getPlaybackModeActivity();
  if (playback.mode !== null || playback.activity !== 'idle') return null;

  const queueItemId = getCurrentQueueItemId();
  const item = getQueueItemById(queueItemId);
  if (
    !queueItemId ||
    !item ||
    item.type === 'youtube' ||
    typeof File === 'undefined' ||
    !(item.file instanceof File)
  ) {
    return null;
  }

  try {
    if (
      filePlaybackProductRuntime.currentHostRendererSnapshot() !== null ||
      filePlaybackProductRuntime.currentHostFailedRendererObservation() !== null ||
      filePlaybackProductRuntime.currentHostTerminalRendererObservation() !== null
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return Object.freeze({ queueItemId, file: item.file });
}

/**
 * Enqueues one fresh product start through playlist's shared V2 mutation lane.
 * `null` means this state is not a stopped V2 local-file selection; otherwise
 * the returned task resolves only after exact playing truth is observable.
 */
function enqueueV2HostFreshSelectedFileStart(positionSeconds = 0): Promise<boolean> | null {
  const admitted = readV2HostFreshLocalFileSelection();
  if (!admitted) return null;
  const requestedPositionSeconds =
    Number.isFinite(positionSeconds) && positionSeconds >= 0 ? positionSeconds : 0;

  return import('./playlist.ts')
    .then(async ({ playTrack }) => {
      const current = readV2HostFreshLocalFileSelection();
      if (
        !current ||
        current.queueItemId !== admitted.queueItemId ||
        current.file !== admitted.file
      ) {
        return false;
      }
      await playTrack(admitted.queueItemId, undefined, {
        navigateToPlay: false,
        v2StartPositionSeconds: requestedPositionSeconds,
      });
      const playing = readExactV2HostControlState();
      return (
        playing?.phase === 'playing' &&
        playing.queueItemId === admitted.queueItemId &&
        getCurrentQueueItemId() === admitted.queueItemId
      );
    })
    .catch((error) => {
      log.warn('[Transport] V2 stopped local-file restart failed:', error);
      return false;
    });
}

/**
 * Claims one host-local V2 file seek without exposing the legacy transport.
 * `true` means the selected V2 boundary owns the request even when its exact
 * projection is unavailable and the request therefore fails closed.
 */
export function requestV2HostFileSeek(time: number): boolean {
  if (!isV2HostFileProductControlContext()) return false;
  const checkpoint = readV2HostFailedPauseCheckpoint();
  if (checkpoint) {
    const target = clampV2HostSeekTarget(time, checkpoint.failure.durationSeconds);
    if (target !== null) {
      rememberV2HostFailedPause(checkpoint.failure, target);
      publishV2HostFailedPaused(checkpoint.failure, target);
    }
    return true;
  }
  if (
    Number.isFinite(time) &&
    time >= 0 &&
    requestV2HostFailedRendererRecovery({ force: true, positionSeconds: time })
  ) {
    return true;
  }
  if (Number.isFinite(time) && time >= 0) {
    void enqueueV2HostSeek((state) => clampV2HostSeekTarget(time, state.durationSeconds));
  }
  return true;
}

export function requestV2HostFilePause(
  options: Readonly<{ holdVisualizer: boolean; showToast: boolean }>,
): boolean {
  if (!isV2HostFileProductControlContext()) return false;
  const failed = readExactV2HostFailureIdentity();
  if (failed) {
    bus.emit('playlist:cancel-v2-playback-intent');
    const key = v2HostFailureObservationKey(failed);
    lastV2HostFailureObservationKey = key;
    explicitV2HostFailureHoldKey = key;
    rememberV2HostFailedPause(failed);
    publishV2HostFailedPaused(failed, failed.positionSeconds);
    const task = enqueueV2HostPause({
      holdVisualizer: options.holdVisualizer,
      showToast: options.showToast,
    });
    trackV2HostUiControl(beginV2HostUiControl('pause', failed.queueItemId), task);
    return true;
  }
  const task = enqueueV2HostPause(options);
  trackV2HostUiControl(beginV2HostUiControl('pause'), task);
  return true;
}

export function requestV2HostFileResume(positionSeconds?: number): boolean {
  if (!isV2HostFileProductControlContext()) return false;
  const checkpoint = readV2HostFailedPauseCheckpoint();
  if (checkpoint) {
    const task = enqueueV2HostFailedPauseResume();
    trackV2HostUiControl(beginV2HostUiControl('play', checkpoint.failure.queueItemId), task);
    return true;
  }
  const failed = readExactV2HostFailureIdentity();
  if (failed) {
    explicitV2HostFailureHoldKey = null;
    const target = positionSeconds === undefined ? failed.positionSeconds : positionSeconds;
    const task =
      beginV2HostFailureRecovery(failed, target, { force: true }) ?? Promise.resolve(false);
    trackV2HostUiControl(beginV2HostUiControl('play', failed.queueItemId), task);
    return true;
  }
  if (!readExactV2HostControlState()) {
    const freshStart = enqueueV2HostFreshSelectedFileStart(positionSeconds);
    if (freshStart) {
      trackV2HostUiControl(beginV2HostUiControl('play'), freshStart);
      return true;
    }
  }
  // Once a standard V2 room owns file controls, an incoherent/missing
  // selection must remain fail-closed instead of exposing a compatibility
  // AudioBuffer. A valid stopped local-file selection was handled above.
  const task = enqueueV2HostResume(positionSeconds);
  trackV2HostUiControl(beginV2HostUiControl('play'), task);
  return true;
}

/**
 * Re-arms a standard-room host's exact V2 renderer after this browser's
 * AudioContext/output was interrupted. A playing renderer performs a
 * same-position cohort seek so host and guests rendezvous on one new physical
 * schedule; an explicit Media Session PLAY resumes canonical paused truth.
 * Merely recovering a context while the room is paused never starts playback.
 */
export function requestV2HostFileOutputRejoin(
  reason: 'media-session-play' | 'audio-context-recovered',
): Promise<boolean> | null {
  if (!isV2HostFileProductControlContext()) return null;
  if (readV2HostFailedPauseCheckpoint()) {
    if (reason === 'audio-context-recovered') return Promise.resolve(true);
    return enqueueV2HostFailedPauseResume();
  }
  const failed = readExactV2HostFailureIdentity();
  if (failed) {
    const key = v2HostFailureObservationKey(failed);
    if (reason === 'audio-context-recovered' && explicitV2HostFailureHoldKey === key) {
      // The user explicitly paused this exact failed incarnation. There is no
      // audible output to restore until a trusted PLAY clears the hold.
      return Promise.resolve(true);
    }
    explicitV2HostFailureHoldKey = null;
    return (
      beginV2HostFailureRecovery(failed, failed.positionSeconds, { force: true }) ??
      Promise.resolve(false)
    );
  }
  const state = readExactV2HostControlState();
  if (!state) return Promise.resolve(false);
  if (state.phase === 'playing') {
    return enqueueV2HostSeek((current) =>
      clampV2HostSeekTarget(current.position.positionSeconds, current.durationSeconds),
    );
  }
  if (reason === 'media-session-play') return enqueueV2HostResume();
  return Promise.resolve(true);
}

/**
 * Claims an exact host-local V2 stop. `null` leaves non-V2 owners on their
 * existing transport; a Promise means the V2 boundary owns the request and
 * resolves true only after its stopped room truth has been verified.
 */
export function requestV2HostFileStop(options: V2HostStopOptions = {}): Promise<boolean> | null {
  if (!isV2HostFileProductControlContext()) return null;
  if (!options.preservePlaylistIntent) {
    bus.emit('playlist:cancel-v2-playback-intent');
  }
  if (readV2HostFailedPauseCheckpoint() && !readExactV2HostFailureIdentity()) {
    publishV2HostStopped(options);
    return Promise.resolve(true);
  }
  const failed = readExactV2HostFailureIdentity();
  if (failed) {
    // STOP is terminal user intent. The failed current renderer still owns an
    // exact manager port and outer gate, so retire it directly; never rebuild
    // audible output merely to stop it again.
    lastV2HostFailureObservationKey = v2HostFailureObservationKey(failed);
    return enqueueV2HostStop(options);
  }
  const mode = getPlaybackModeActivity();
  if (
    mode.mode === null &&
    mode.activity === 'idle' &&
    isExactV2HostRoom(filePlaybackProductRuntime.hostRoomSnapshot()) &&
    filePlaybackProductRuntime.currentHostRendererSnapshot() === null &&
    filePlaybackProductRuntime.currentHostTerminalRendererObservation() === null
  ) {
    return Promise.resolve(true);
  }
  return enqueueV2HostStop(options);
}

function requestV2HostFileToggle(): boolean {
  if (!isV2HostFileProductControlContext()) return false;
  const checkpoint = readV2HostFailedPauseCheckpoint();
  if (checkpoint) {
    const task = enqueueV2HostFailedPauseResume();
    trackV2HostUiControl(beginV2HostUiControl('play', checkpoint.failure.queueItemId), task);
    return true;
  }
  const failed = readExactV2HostFailureIdentity();
  if (failed) {
    const key = v2HostFailureObservationKey(failed);
    if (explicitV2HostFailureHoldKey === key) {
      explicitV2HostFailureHoldKey = null;
      const task =
        beginV2HostFailureRecovery(failed, getState('player.pausedAt'), { force: true }) ??
        Promise.resolve(false);
      trackV2HostUiControl(beginV2HostUiControl('play', failed.queueItemId), task);
    } else {
      bus.emit('playlist:cancel-v2-playback-intent');
      lastV2HostFailureObservationKey = key;
      explicitV2HostFailureHoldKey = key;
      rememberV2HostFailedPause(failed);
      publishV2HostFailedPaused(failed, failed.positionSeconds);
      const task = enqueueV2HostPause({
        holdVisualizer: true,
        showToast: true,
      });
      trackV2HostUiControl(beginV2HostUiControl('pause', failed.queueItemId), task);
    }
    return true;
  }
  if (!readExactV2HostControlState()) {
    const freshStart = enqueueV2HostFreshSelectedFileStart();
    if (freshStart) {
      trackV2HostUiControl(beginV2HostUiControl('play'), freshStart);
      return true;
    }
  }
  // Preserve the product boundary for incoherent state. enqueueV2HostToggle
  // re-reads exact physical truth and deliberately does nothing if none exists.
  enqueueV2HostToggle();
  return true;
}

// ─── Track Position ────────────────────────────────────────────────

let _offsetResetQueued = false;

function readTrackPosition(repairOutOfRangeOffset: boolean): number {
  const ownership = getPlaybackOwnership();
  const pausedAt = getState('player.pausedAt') || 0;

  // System audio: no meaningful position (live stream)
  if (ownership.owner === 'system-audio') return 0;

  // YouTube mode: delegated via synchronous callback
  if (ownership.owner === 'youtube') {
    let ytPos = 0;
    bus.emit('youtube:get-position', (pos: number) => {
      ytPos = pos;
    });
    return ytPos;
  }

  const proBoundedPosition = getProRoomBoundedFilePlaybackPosition();
  if (proBoundedPosition) return proBoundedPosition.positionSeconds;

  const legacyBoundedSnapshot = legacyBoundedFileV1Product.snapshot().current;
  if (
    legacyBoundedSnapshot?.state === 'ready' &&
    legacyBoundedSnapshot.queueItemId === getCurrentQueueItemId()
  ) {
    if (legacyBoundedSnapshot.phase === 'stopped') return pausedAt;
    const legacyBoundedPosition = legacyBoundedFileV1Product.positionSeconds();
    if (legacyBoundedPosition !== null) return legacyBoundedPosition;
  }

  if (isV2HostFileControlContext()) {
    const exact = readExactV2HostControlState();
    if (exact) return exact.position.positionSeconds;
    return (
      readExactV2HostFailureIdentity()?.positionSeconds ??
      readV2HostFailedPauseCheckpoint()?.positionSeconds ??
      0
    );
  }

  // A V2 guest renders from its own FilePlaybackManager rather than the
  // legacy AudioBuffer clock. Project that exact native position while the
  // product room owns an exact current port; otherwise the legacy startedAt
  // anchor can alternately pull the seek bar backward and forward around sync
  // updates. Host, PRO, YouTube, and system-audio owners have already returned
  // above, and the projection itself fails closed outside an exact V2 room.
  const guestPosition = getManagedFilePlaybackPosition(getCurrentQueueItemId());
  if (guestPosition) return guestPosition.positionSeconds;

  if (isFileTransportInactive()) return pausedAt;

  const _currentAudioBuffer = getCurrentAudioBuffer();
  const duration =
    _currentAudioBuffer && Number.isFinite(_currentAudioBuffer.duration)
      ? _currentAudioBuffer.duration
      : 0;

  let pos = 0;
  const startedAt = getState('player.startedAt') || 0;
  const manualOffset = getState('sync.localOffset') || 0;
  const localOffset = getEffectiveLocalFileOutputOffset();

  const startedAtValid =
    typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt !== 0;
  if (startedAtValid && getCurrentTime() > 0) {
    // Recover an out-of-range manual offset asynchronously so this getter does
    // not write state during a read.
    // _offsetResetQueued prevents duplicate microtasks when getTrackPosition()
    // is called multiple times in the same frame (seek bar, sync, broadcast).
    if (repairOutOfRangeOffset && Math.abs(manualOffset) > 30 && !_offsetResetQueued) {
      _offsetResetQueued = true;
      log.warn(`[Sync] Offset divergence detected: local=${manualOffset.toFixed(3)}s — resetting`);
      queueMicrotask(() => {
        _offsetResetQueued = false;
        const lo = getState('sync.localOffset') || 0;
        setState('sync.localOffset', 0);
        // Recalculate startedAt to remove the encoded offset — prevents position
        // jump on next getTrackPosition() call after offset is zeroed.
        const sa = getState('player.startedAt');
        if (sa) setState('player.startedAt', sa - lo);
      });
      pos = getCurrentTime() - startedAt;
    } else {
      pos = getCurrentTime() - startedAt + localOffset;
    }
  }

  if (isNaN(pos)) pos = 0;
  // If audio is scheduled but hasn't started yet, return the target offset
  if (pos < 0) pos = getState('player.pausedAt') || 0;
  if (duration > 0 && pos > duration) pos = duration;

  return pos;
}

export function getTrackPosition(): number {
  return readTrackPosition(true);
}

/**
 * Read the current logical position without scheduling the transport's
 * out-of-range offset repair. Diagnostics use this so observation cannot
 * mutate or mask the state that caused a sync incident.
 */
export function peekTrackPosition(): number {
  return readTrackPosition(false);
}

// ─── Play State UI ─────────────────────────────────────────────────

export function updatePlayState(playing: boolean): void {
  bus.emit('ui:update-play-state', playing);
}

// ─── Stop Player Node ──────────────────────────────────────────────

/**
 * Stop and release the active source node.
 *
 * A retired AudioBufferSourceNode can keep its AudioBuffer and callback
 * closures reachable until the rendering engine releases it, notably on
 * WebKit. Disconnect and stop first, clear onended, and best-effort clear the
 * buffer reference. Engines that reject a post-start buffer assignment throw
 * InvalidStateError, which teardown intentionally ignores.
 */
export function stopPlayerNode(): void {
  const node = getPlayerNode();
  if (!node) return;
  try {
    node.disconnect();
  } catch (e) {
    log.debug('disconnect node:', e);
  }
  try {
    node.stop();
  } catch (e) {
    log.debug('stop node:', e);
  }
  try {
    node.onended = null;
  } catch {
    /* ignore */
  }
  try {
    node.buffer = null;
  } catch {
    /* InvalidStateError on spec-strict engines — ignore */
  }
  setPlayerNode(null);
}

// ─── Stop All Media ────────────────────────────────────────────────

function stopAllMediaLegacy(opts: V2HostStopOptions = {}): void {
  const queueItemId = getCurrentQueueItemId();
  const wasInYouTube = isYouTubeOwner();
  const wasPreparingFile = isFilePipelineBusyForPlay();
  if (!opts.preserveProBoundedCandidate) {
    void clearProRoomBoundedFilePlayback();
  }

  if (opts?.cancelInFlight) {
    newLoadEpoch();
    incrementLoadSessionId();
    cancelProRoomPlaylistFileResolution();
  }

  // Stop system audio if active (without recursive loop — cleanup only disconnects nodes)
  if (isSystemAudioActive()) {
    bus.emit('system-audio:force-stop');
  }

  // Stop YouTube. Propagate silent so stopYouTubeMode skips the
  // IDLE bounce when the caller is mid-transition to PLAYING_AUDIO (avoids
  // a brief body.mode-youtube → no-mode → mode-audio flash on YT→Local).
  bus.emit('youtube:stop-mode', { silent: !!opts?.silent });

  // Clear pending triggers.
  clearManagedTimer('preloadScheduleTimer');
  clearManagedTimer('autoPlayTimer');
  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');
  // A deferred same-file replay must not survive into a replacement buffer.
  clearManagedTimer('playback-replay-defer');
  // Reset the play lock, watchdog, deferred play, and preload-activation flag
  // as one teardown unit. _internalPlay and preload activation finishers are
  // idempotent if they later observe this reset.
  invalidatePlayInvocation();
  clearManagedTimer('navigator-lock-watchdog');
  clearManagedTimer('playback-unlock-delay');
  setPlayLocked(false);
  clearPendingPlayIntent();
  setPlayPreloadedInProgress(false);

  // silent=true usually suppresses the IDLE flash while another audio track
  // is taking over. YouTube is the exception: leaving playback mode at
  // YouTube blocks file lifecycle transitions and play(), so clear the mode
  // after stopYouTubeMode has had a chance to broadcast YOUTUBE_STOP.
  if (opts?.silent && wasInYouTube && isYouTubeOwner()) {
    setPlaybackIdle();
  }

  // cancelInFlight is an authoritative teardown, including the PRO R2 fetch
  // phase that precedes ordinary decode. A silent external-mode takeover must
  // release the file-only lifecycle as well as aborting its bytes.
  if (opts?.silent && opts.cancelInFlight && wasPreparingFile) {
    setPlaybackIdle();
  }

  // silent=true: suppress IDLE flash when play() will immediately follow (e.g. track change)
  if (!opts?.silent && !isCompatIdle()) {
    setPlaybackIdle();
  }

  // Stop player node
  stopPlayerNode();
  if (opts?.clearBuffer) setCurrentAudioBuffer(null);

  // Reset master clock
  setState('player.startedAt', 0);
  setState('player.pausedAt', 0);

  // Reset the seekbar even for silent transitions; the position loop does not
  // repaint while file playback is pending.
  bus.emit('ui:seek-reset');

  // A host mirrors the stop so guests do not continue the previous track while
  // a replacement is prepared. Guest-side callers never broadcast.
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    // silent=true is the track-change / preload-swap / system-audio-swap path
    // (a PLAY follows shortly). No silent flag means a deliberate terminal
    // stop (stopPlayback, error path, end-of-track-without-next).
    broadcast({
      type: MSG.PAUSE,
      time: 0,
      queueItemId,
      reason: opts?.silent ? 'transition' : 'stop',
    });
  }
  bus.emit('visualizer:fade-out');
}

export function stopAllMedia(opts: V2HostStopOptions = {}): void {
  const boundedStop = requestLegacyBoundedV1Stop();
  if (boundedStop) {
    stopAllMediaLegacy(opts);
    void boundedStop;
    return;
  }
  const v2Stop = requestV2HostFileStop(opts);
  if (v2Stop) {
    void v2Stop;
    return;
  }
  stopAllMediaLegacy(opts);
}

/**
 * Ordered variant for cross-mode transitions. Legacy teardown still executes
 * synchronously; V2 callers resume only after exact stopped room truth.
 */
export async function stopAllMediaAsync(options: V2HostStopOptions = {}): Promise<boolean> {
  const boundedStop = requestLegacyBoundedV1Stop();
  if (boundedStop) {
    stopAllMediaLegacy(options);
    return boundedStop;
  }
  const v2Stop = requestV2HostFileStop(options);
  if (v2Stop) return v2Stop;
  stopAllMediaLegacy(options);
  return true;
}

// ─── Seek ──────────────────────────────────────────────────────────

/**
 * Unified seek handler for every role and supported playback mode.
 */
export function seekTo(time: number): void {
  if (isGuestBlocked()) return;
  const hostConn = getState('network.hostConn');
  const canControlPlayback = hasRoomCapability('playback.control');
  const queueItemId = getCurrentQueueItemId();

  if (
    !isSystemAudioOwner() &&
    routeProPlaybackCommand(
      {
        kind: 'seek',
        queueItemId,
        positionSeconds: Number.isFinite(time) ? Math.max(0, time) : 0,
      },
      {
        wasPlaying: getState('playback.activity') === 'playing',
      },
    )
  ) {
    return;
  }

  // OP guest: request host to seek
  if (hostConn && canControlPlayback) {
    if (queueItemId) sendToHost({ type: MSG.REQUEST_SEEK, time, queueItemId });
    return;
  }

  // Cancel pending auto-play on manual interaction (Host only)
  if (!hostConn && getManagedTimer('autoPlayTimer')) {
    clearManagedTimer('autoPlayTimer');
    showToast(t('toast.auto_play_canceled'));
  }

  // YouTube mode
  if (isYouTubeOwner()) {
    bus.emit('youtube:seek-to', time);
    return;
  }

  // System audio: no seek (live stream)
  if (isSystemAudioOwner()) return;

  if (requestLegacyBoundedV1HostSeek(time)) return;
  if (requestV2HostFileSeek(time)) return;

  // A busy file pipeline still holds the previous track's buffer. Ignore seek;
  // decode completion owns playback for the newly selected track.
  if (isFilePipelineBusyForPlay()) {
    log.debug('[Seek] Ignoring seek while file pipeline is preparing');
    return;
  }

  // Host: playing → seek + broadcast
  if (isFilePlaybackPlaying()) {
    if (!queueItemId) return;
    const hostPlayAt = getHostNow() + SCHEDULE_AHEAD_MS;
    play(time, 0, undefined, undefined, hostPlayAt);
    broadcast({
      type: MSG.PLAY,
      time,
      queueItemId,
      hostPlayAt,
    });
  } else {
    // Paused: update position + broadcast
    setState('player.pausedAt', time);
    broadcast({ type: MSG.PAUSE, time, queueItemId, reason: 'seek' });
  }
}

// ─── Play ──────────────────────────────────────────────────────────

export async function play(
  offset: number,
  scheduleDelay = 0,
  scheduleDeadlineMs?: number,
  shouldApply?: () => boolean,
  boundedStartAtRoomTimeMs?: number,
): Promise<void> {
  if (shouldApply?.() === false) return;
  if (requestLegacyBoundedV1HostPlay(offset, boundedStartAtRoomTimeMs)) return;
  if (requestLegacyBoundedV1GuestPlay(offset, boundedStartAtRoomTimeMs)) return;
  if (requestV2HostFileResume(offset)) return;
  if (isPlayLocked()) {
    log.warn('[Play] Blocked: queuing play request');
    queuePendingPlayIntent({ offset, scheduleDelay, scheduleDeadlineMs, shouldApply });
    return;
  }
  // Source-level guard for callers that reach play during a file load. The
  // resident buffer belongs to the previous track, so queue the requested time
  // for the pipeline-completion path instead of starting stale audio.
  if (isFilePipelineBusyForPlay()) {
    log.warn('[Play] Deferred: file pipeline busy — queuing as pendingPlayTime');
    // Decode/fetch completion owns this legacy cross-module mailbox. It cannot
    // preserve callable authority predicates, so keep it separate from the
    // play-lock mailbox and let the pipeline's queue/session fences decide
    // whether it is still current.
    pendingPlayIntent = null;
    setPendingPlayTime(offset);
    return;
  }
  // A stale unlock callback should already be owner-gated, but clearing it at
  // claim time also keeps the named timer registry aligned with the lock.
  clearManagedTimer('playback-unlock-delay');
  const myPlayInvocation = claimPlayInvocation();
  const myPlayStartFence = playStartFence;
  setPlayLocked(true);

  const lockStartTime = Date.now();
  setManagedTimer(
    'navigator-lock-watchdog',
    () => {
      if (isCurrentPlayInvocation(myPlayInvocation) && isPlayLocked()) {
        log.warn(
          `[Play] Lock Timeout: Forcing unlock after 15s (locked at ${new Date(lockStartTime).toISOString()})`,
        );
        // Invalidate before releasing the tuple. The wedged invocation can
        // still resume later, but its finally must not touch a newer owner.
        invalidatePlayInvocation();
        // Reset the lock, deferred play, source node, load epoch, and semantic
        // playback state together. Clear pendingPlayTime before unlocking so
        // the queued-request consumer observes a consistent empty mailbox.
        setPlayLocked(false);
        clearPendingPlayIntent();
        stopPlayerNode();
        // Allocate a new load epoch so any in-flight _internalPlay aborts at
        // its next await checkpoint instead of overwriting the post-watchdog
        // IDLE state with PLAYING_AUDIO and starting a phantom
        // AudioBufferSourceNode.
        // Guest finalization intentionally ignores this epoch and checks its
        // own load/transfer session ownership instead.
        newLoadEpoch();
        // Reset playback to IDLE to prevent stuck "playing" UI.
        if (!isCompatIdle()) {
          setPlaybackIdle();
        }
      }
    },
    15000,
  );

  try {
    await _internalPlay(offset, scheduleDelay, scheduleDeadlineMs, shouldApply, myPlayStartFence);
  } finally {
    if (isCurrentPlayInvocation(myPlayInvocation)) {
      clearManagedTimer('navigator-lock-watchdog');
      setManagedTimer(
        'playback-unlock-delay',
        () => {
          if (!isCurrentPlayInvocation(myPlayInvocation)) return;
          invalidatePlayInvocation();
          setPlayLocked(false);
          // Consume queued play request (e.g. sync correction that arrived during lock)
          const pendingIntent = takePendingPlayIntent();
          if (pendingIntent) {
            if (pendingIntent.shouldApply?.() === false) {
              log.debug('[Play] Dropping superseded queued play request');
              return;
            }
            log.debug(`[Play] Consuming queued play request: ${pendingIntent.offset.toFixed(2)}s`);
            void play(
              pendingIntent.offset,
              pendingIntent.scheduleDelay,
              pendingIntent.scheduleDeadlineMs,
              pendingIntent.shouldApply,
            );
          }
        },
        10,
      );
    }
  }
}

async function _internalPlay(
  offset: number,
  scheduleDelay = 0,
  scheduleDeadlineMs?: number,
  shouldApply?: () => boolean,
  expectedPlayStartFence = playStartFence,
): Promise<void> {
  clearPendingPlayIntent();
  // Snapshot the load epoch at entry. If the play()-level watchdog fires
  // (or another path allocates a new epoch, e.g. track switch), every await
  // checkpoint below will see a superseded epoch and abort cleanly instead
  // of racing with the watchdog's stopPlayerNode + semantic IDLE write.
  const myLoadEpoch = getCurrentLoadEpoch();
  log.debug(`[Play] Stage 1: Validating state (offset: ${offset})`);

  if (isExternalOwner()) {
    log.warn('[Audio] Blocked play() call while an external playback mode is active');
    return;
  }

  log.debug('[Play] Stage 2: Resuming AudioContext');
  try {
    await ensureRunning();
  } catch (e) {
    log.warn('Resume failed:', e);
  }

  if (shouldApply?.() === false || expectedPlayStartFence !== playStartFence) return;

  if (!isCurrentLoadEpoch(myLoadEpoch)) {
    log.warn('[Play] Aborted — load epoch superseded during ensureRunning');
    return;
  }

  // ── Post-await mode re-check ──────────────────────────────────────
  // Another playback mode may have taken ownership during asynchronous audio
  // setup, so validate again before creating a file source node.
  if (isExternalOwner()) {
    log.warn('[Audio] Aborted play() - app switched to an external mode during async init');
    return;
  }

  const _currentAudioBuffer = getCurrentAudioBuffer();
  const hasBufferSource = !!_currentAudioBuffer;

  if (!hasBufferSource) {
    log.warn('[Play] No media source available');
    // Surface an empty playlist instead of silently ignoring Play.
    showToast(t('playlist.empty_hint'));
    return;
  }

  log.debug('[Play] Stage 3: Initializing audio engine');
  try {
    await initAudio();
  } catch (e) {
    log.error('[Audio] initAudio failed:', e);
    showToast(t('error.audio_engine_prepare'));
    return;
  }

  if (shouldApply?.() === false || expectedPlayStartFence !== playStartFence) return;

  if (!isCurrentLoadEpoch(myLoadEpoch)) {
    log.warn('[Play] Aborted — load epoch superseded during initAudio');
    return;
  }

  // Re-check after second async gap (initAudio)
  if (isExternalOwner()) {
    log.warn('[Audio] Aborted play() - app switched to an external mode during initAudio');
    return;
  }

  const ctx = getAudioContext();

  // 1. Get the current output sync offset (manual nudge + hidden platform compensation)
  const localOffset = getEffectiveLocalFileOutputOffset();

  // 2. Sanitize offset
  let safeOffset = Number(offset);
  if (!Number.isFinite(safeOffset) || safeOffset < 0) safeOffset = 0;
  const duration =
    _currentAudioBuffer && Number.isFinite(_currentAudioBuffer.duration)
      ? _currentAudioBuffer.duration
      : 0;
  if (duration > 0) {
    if (safeOffset > duration) safeOffset = duration;
    if (safeOffset === duration) safeOffset = Math.max(0, duration - 0.1);
  }

  // Authority commits carry an absolute participant-local deadline. Audio
  // setup above can itself await; recomputing the remaining lead here keeps
  // that setup latency from being added a second time. Existing callers keep
  // their established relative-delay behavior.
  const effectiveScheduleDelay = Number.isFinite(scheduleDeadlineMs)
    ? Math.max(0, (Number(scheduleDeadlineMs) - performance.now()) / 1000)
    : scheduleDelay;
  if (Number.isFinite(scheduleDeadlineMs)) {
    safeOffset += Math.max(0, performance.now() - Number(scheduleDeadlineMs)) / 1_000;
    if (duration > 0) safeOffset = Math.max(0, Math.min(duration - 0.001, safeOffset));
  }

  if (shouldApply?.() === false || expectedPlayStartFence !== playStartFence) return;

  // Buffer Mode playback
  if (_currentAudioBuffer) {
    stopPlayerNode();
    const newNode = ctx.createBufferSource();
    newNode.buffer = _currentAudioBuffer;
    setPlayerNode(newNode);

    const isSurroundMode = getState('audio.isSurroundMode');
    const surroundChannelIndex = getState('audio.surroundChannelIndex');

    if (isSurroundMode) {
      // The V2 audio graph owns a stable route, so the source node itself
      // never changes routing ownership when the selected channel changes.
      bus.emit('audio:connect-surround', surroundChannelIndex);
      log.debug(`[BufferMode] Playing in 7.1 Surround (Ch: ${surroundChannelIndex})`);
    } else {
      log.debug('[BufferMode] Playing in Stereo');
    }

    // Every backend connects exactly once to the stable route input. Surround
    // changes only rewire nodes downstream of that input, so toggling a role
    // never recreates or restarts this source.
    const destination = getFilePlaybackDestination();
    if (destination) newNode.connect(destination);

    // Use the onended slot because stopPlayerNode clears that exact callback.
    // addEventListener + `onended = null` would leave the closure (and its
    // captured load epoch) attached to retired WebKit source nodes.
    newNode.onended = () => {
      if (!isCurrentLoadEpoch(myLoadEpoch)) return;
      if (isFilePlaybackPlaying()) {
        handleEnded();
      }
    };

    // Determine the exact audio-context time to start
    const startWhen = effectiveScheduleDelay > 0 ? ctx.currentTime + effectiveScheduleDelay : 0;

    // Apply manual nudge to the audible start position
    const nudgeOffset = safeOffset + localOffset;
    let finalStartPos = nudgeOffset;
    if (duration > 0) {
      finalStartPos = Math.max(0, Math.min(duration - 0.001, nudgeOffset));
    }

    newNode.start(startWhen, finalStartPos);
  }

  // Update timing
  // startedAt = wall-clock time when playback would have started from 0:00
  //   = now - playbackPosition + syncCorrection
  const startedAt = getCurrentTime() + effectiveScheduleDelay - safeOffset + localOffset;
  setState('player.startedAt', startedAt);
  setState('player.pausedAt', safeOffset);
  log.debug(`[BufferMode] Started at ${safeOffset}s (startedAt: ${startedAt})`);

  setPlaybackFilePlaying();

  if (!getState('network.hostConn')) {
    transition({
      type: 'PLAY',
      time: safeOffset,
      queueItemId: getCurrentQueueItemId(),
      sameTrack: true,
    });
  }

  bus.emit('visualizer:start');
  bus.emit('ui:loop-start');
}

// ─── Pause ─────────────────────────────────────────────────────────

export function pause(
  forcedTime?: number,
  opts?: { holdVisualizer?: boolean; showToast?: boolean },
): void {
  // PAUSE is newer than any node start waiting behind the play lock. Revoke
  // the complete intent before checking concrete media ownership so a late
  // unlock cannot resurrect audio after an authoritative pause.
  clearPendingPlayIntent();
  revokeInFlightPlayStart();
  if (requestLegacyBoundedV1Pause(forcedTime)) return;
  if (
    requestV2HostFilePause({
      holdVisualizer: opts?.holdVisualizer ?? forcedTime === undefined,
      showToast: opts?.showToast ?? true,
    })
  ) {
    return;
  }
  if (isFileTransportInactive()) return;

  let pausePos: number;
  if (typeof forcedTime === 'number' && Number.isFinite(forcedTime) && forcedTime >= 0) {
    pausePos = forcedTime;
  } else {
    pausePos = getTrackPosition();
  }

  stopPlayerNode();

  if (opts?.holdVisualizer ?? forcedTime === undefined) {
    bus.emit('visualizer:hold-frame');
  }
  // Publish the exact pause position before the activity transition. Seekbar
  // observers run synchronously from that transition and must never repaint a
  // previous pause position for one frame.
  setState('player.pausedAt', pausePos);
  setPlaybackFilePaused();

  if (!getState('network.hostConn')) {
    transition({
      type: 'PAUSE',
      time: pausePos,
      queueItemId: getCurrentQueueItemId(),
      endOfPlaylist: false,
    });
  }

  if (opts?.showToast ?? true) {
    showToast(t('common.pause'));
  }
}

// ─── Handle Track Ended ────────────────────────────────────────────

let proAuthorityFileCommitGeneration = 0;

/** Apply a revision-validated PRO commit to the resident AudioBuffer. */
export async function applyProPlaybackFileCommit(
  request: Readonly<ProPlaybackCommitRequest>,
): Promise<boolean> {
  const targetItem = request.queueItemId ? getQueueItemById(request.queueItemId) : null;
  const hadBoundedCurrent = hasCurrentProRoomBoundedFilePlayback();
  const bounded = await commitProRoomBoundedFilePlayback(request);
  if (bounded) {
    if (bounded.status !== 'applied') return false;
    if (bounded.phase === 'idle') return true;
    if (
      !request.queueItemId ||
      !targetItem ||
      targetItem.type !== 'file' ||
      getQueueItemById(request.queueItemId) !== targetItem ||
      request.isCurrent?.() === false
    ) {
      // A newer authority may already own the adapter's candidate/current.
      // Broad teardown here would erase that successor. Endpoint/room
      // generations retire the exact stale renderer; this continuation only
      // withholds obsolete UI publication.
      return false;
    }

    // PREPARE kept the outgoing renderer/UI intact. Native bounded start
    // evidence is now established, so retire a legacy/YouTube predecessor and
    // publish the incoming identity as one synchronous UI transaction. The
    // manager itself already retired a previous bounded renderer atomically.
    if (!hadBoundedCurrent) {
      stopAllMediaLegacy({
        silent: true,
        cancelInFlight: true,
        clearBuffer: true,
        preserveProBoundedCandidate: true,
      });
    }
    selectQueueItemById(request.queueItemId);
    setPlaybackTrackMeta(targetItem);
    setCurrentAudioBuffer(null);
    setState('files.current', null);
    setState('player.startedAt', 0);
    setState('player.pausedAt', bounded.positionSeconds);
    transition({ type: 'PRODUCT_TIMELINE_RENDERED', phase: bounded.phase });
    // Bounded PRO playback also bypasses legacy decode, so its first exact
    // COMMIT must publish media readiness explicitly. Room capability remains
    // an independent gate in player-controls.
    bus.emit('ui:play-btn-state', true);
    bus.emit('ui:duration-update', bounded.durationSeconds ?? 0);
    bus.emit(
      'ui:time-update',
      fmtTime(bounded.positionSeconds),
      fmtTime(bounded.durationSeconds ?? 0),
      bounded.positionSeconds,
      bounded.durationSeconds ?? 0,
    );
    bus.emit('ui:update-play-state', bounded.phase === 'playing');
    if (bounded.phase === 'playing') {
      bus.emit('visualizer:start');
      bus.emit('ui:loop-start');
    } else {
      bus.emit('visualizer:hold-frame');
    }
    return true;
  }
  if (
    !isProPlaybackAuthorityToken(request.authority) ||
    request.state === 'idle' ||
    !request.queueItemId ||
    getState('room.context').kind !== 'pro' ||
    getCurrentQueueItemId() !== request.queueItemId ||
    getState('files.current')?.queueItemId !== request.queueItemId ||
    !getCurrentAudioBuffer()
  ) {
    return false;
  }
  const generation = ++proAuthorityFileCommitGeneration;
  const isCurrentAuthority = () =>
    generation === proAuthorityFileCommitGeneration && request.isCurrent?.() !== false;

  const positionSeconds = Number.isFinite(request.positionSeconds)
    ? Math.max(0, request.positionSeconds)
    : 0;
  const delayMs = Number.isFinite(request.scheduleDelayMs)
    ? Math.max(0, Math.min(30_000, request.scheduleDelayMs))
    : 0;

  if (request.state === 'playing') {
    const scheduleDeadlineMs = performance.now() + delayMs;
    await play(positionSeconds, delayMs / 1000, scheduleDeadlineMs, isCurrentAuthority);
    return (
      isCurrentAuthority() &&
      getCurrentQueueItemId() === request.queueItemId &&
      getState('playback.activity') === 'playing'
    );
  }

  // The scheduled pause may intentionally wait for its rendezvous instant,
  // but an older queued play must not become audible during that wait.
  clearPendingPlayIntent();

  if (delayMs > 0) await delay(delayMs);
  if (
    !isCurrentAuthority() ||
    getState('room.context').kind !== 'pro' ||
    getCurrentQueueItemId() !== request.queueItemId ||
    getState('files.current')?.queueItemId !== request.queueItemId
  ) {
    return false;
  }

  stopPlayerNode();
  setState('player.pausedAt', positionSeconds);
  setPlaybackFilePaused();
  transition({
    type: 'PAUSE',
    time: positionSeconds,
    queueItemId: request.queueItemId,
    endOfPlaylist: false,
  });
  const duration = getCurrentAudioBuffer()?.duration ?? 0;
  bus.emit(
    'ui:time-update',
    fmtTime(positionSeconds),
    fmtTime(duration),
    positionSeconds,
    duration,
  );
  bus.emit('ui:update-play-state', false);
  return true;
}

export function handleEnded(): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Guests don't handle track-end

  const bounded = readLegacyBoundedV1ControlContext();
  if (bounded?.role === 'host') {
    const duration = bounded.current.durationSeconds;
    const position = legacyBoundedFileV1Product.positionSeconds() ?? bounded.current.positionSeconds;
    if (
      bounded.current.phase === 'playing' &&
      duration !== null &&
      duration > 0.1 &&
      position >= duration - 0.05 &&
      !getState('player.isSeeking')
    ) {
      const queueItemId = bounded.current.queueItemId;
      const legacySessionId = bounded.current.legacySessionId;
      const generation = legacyBoundedFileV1Product.snapshot().generation;
      const key = `${generation}:${queueItemId}:${legacySessionId}`;
      if (legacyBoundedV1NaturalEndFence?.key === key) return;
      const task = legacyBoundedFileV1Product.settleHostNaturalEnd(
        queueItemId,
        legacySessionId,
      );
      legacyBoundedV1NaturalEndFence = Object.freeze({ key, task });
      void task
        .then((outcome) => {
          if (
            legacyBoundedV1NaturalEndFence?.key !== key ||
            legacyBoundedV1NaturalEndFence.task !== task
          ) {
            return;
          }
          if (outcome.status !== 'settled') {
            legacyBoundedV1NaturalEndFence = null;
            return;
          }
          const latest = legacyBoundedFileV1Product.snapshot().current;
          if (
            !latest ||
            latest.queueItemId !== queueItemId ||
            latest.legacySessionId !== legacySessionId ||
            latest.phase !== 'stopped'
          ) {
            return;
          }
          projectLegacyBoundedV1Snapshot(latest);
          setState('player.pausedAt', 0);
          bus.emit('ui:seek-reset');
          bus.emit('player:ended');
        })
        .catch((error) => {
          if (legacyBoundedV1NaturalEndFence?.task === task) {
            legacyBoundedV1NaturalEndFence = null;
          }
          log.warn('[Transport] Bounded V1 natural-end settlement failed:', error);
        });
    }
    return;
  }

  // A committed bounded renderer can fail after the room timeline has already
  // published playing truth (for example after an AudioContext/output loss).
  // Freeze the compatibility UI immediately and make one exact fresh-track
  // recovery attempt before the natural-end path sees an absent projection.
  if (requestV2HostFailedRendererRecovery({ force: false })) return;

  // The product source exposes an exact ended renderer observation while the
  // controller still owns the playing run. Settlement, stopped publication,
  // and playlist advance stay serialized with every other V2 host control.
  if (requestV2HostEndedSettlement()) return;

  const _currentAudioBuffer = getCurrentAudioBuffer();

  const hasBufferDuration = !!(
    _currentAudioBuffer &&
    Number.isFinite(_currentAudioBuffer.duration) &&
    _currentAudioBuffer.duration > 0.1
  );

  const duration = hasBufferDuration ? _currentAudioBuffer!.duration : 0;
  if (!duration || !Number.isFinite(duration) || duration <= 0.1) return;
  if (isFileTransportInactive()) return;
  if (isExternalOwner()) return;

  const curr = getTrackPosition();
  const isSeeking = getState('player.isSeeking');
  if (isSeeking) {
    log.debug('[handleEnded] Ignoring end signal while seeking');
    return;
  }

  if (curr >= duration - 0.05) {
    log.debug(`Track ended at ${curr.toFixed(2)}s / ${duration.toFixed(2)}s`);
    const queueItemId = getCurrentQueueItemId();
    if (
      queueItemId &&
      routeProPlaybackCommand({
        kind: 'ended',
        queueItemId,
        positionSeconds: curr,
        observedPositionSeconds: curr,
        durationSeconds: duration,
        mediaKind: 'file',
      })
    ) {
      return;
    }
    stopAllMedia();
    setState('player.pausedAt', 0);
    bus.emit('ui:seek-reset');

    // Auto-advance via playlist module
    bus.emit('player:ended');
  }
}

// ─── Toggle Play ───────────────────────────────────────────────────

export function togglePlay(): void {
  if (isGuestBlocked()) return;

  const wasPlaying = getState('playback.activity') === 'playing';

  if (
    !isSystemAudioOwner() &&
    routeProPlaybackCommand(
      {
        kind: wasPlaying ? 'pause' : 'play',
        queueItemId: getCurrentQueueItemId(),
        positionSeconds: getTrackPosition(),
      },
      { wasPlaying },
    )
  ) {
    return;
  }

  // A PRO member can request a persistent row while the coordinator is still
  // downloading it from R2. Until an authoritative selection/prepare arrives,
  // the local owner may still be the previous YouTube row; never let Play
  // toggle that stale owner during this request gap.
  if (isProRoomTrackChangeIntentPending()) {
    log.debug('[Play] Ignoring toggle while a PRO track change is pending');
    return;
  }

  const hostConn = getState('network.hostConn');
  const canControlPlayback = hasRoomCapability('playback.control');

  // YouTube mode
  if (isYouTubeOwner()) {
    bus.emit('youtube:toggle-play');
    return;
  }

  // System audio: ignore play/pause toggle (use "공유 중지" button instead)
  if (isSystemAudioOwner()) return;

  // During download/decode, the resident AudioBuffer may still belong to the
  // previous track. Ignore play until the file pipeline reaches a playable state.
  if (isFilePipelineBusyForPlay()) {
    log.debug('[Play] Ignoring toggle while file pipeline is preparing');
    return;
  }

  const isActuallyPlaying = isFilePlaybackPlaying();
  const pausedAt = getState('player.pausedAt') || 0;
  const currentQueueItemId = getCurrentQueueItemId();
  const playlistItems = getState('playlist.items') || [];

  // Deselected state (e.g. after end-of-playlist reset): no track is selected
  // but the playlist is non-empty. Pressing play should restart from track 0
  // rather than silently resuming the stale audio buffer with "미디어 없음"
  // still showing in the title.
  if (!isActuallyPlaying && !currentQueueItemId && playlistItems.length > 0) {
    const firstItem = playlistItems[0];
    const firstQueueItemId = firstItem?.queueItemId;
    if (!firstQueueItemId) return;
    if (!hostConn) {
      const start = import('./playlist.ts')
        .then(async (mod) => {
          await mod.playTrack(firstQueueItemId);
          const playing = readExactV2HostControlState();
          return (
            playing?.phase === 'playing' &&
            playing.queueItemId === firstQueueItemId &&
            getCurrentQueueItemId() === firstQueueItemId
          );
        })
        .catch((error) => {
          log.warn('[Play] Failed to restart the first playlist item:', error);
          return false;
        });
      if (
        firstItem?.type !== 'youtube' &&
        typeof File !== 'undefined' &&
        firstItem?.file instanceof File &&
        isV2HostFileProductControlContext()
      ) {
        trackV2HostUiControl(beginV2HostUiControl('play', firstQueueItemId), start);
      } else {
        void start;
      }
    } else if (canControlPlayback) {
      sendToHost({ type: MSG.REQUEST_TRACK_CHANGE, queueItemId: firstQueueItemId });
    }
    return;
  }

  if (requestV2HostFileToggle()) {
    if (getManagedTimer('autoPlayTimer')) {
      clearManagedTimer('autoPlayTimer');
      showToast(t('toast.auto_play_canceled'));
    }
    clearManagedTimer('ended-advance-retry');
    clearManagedTimer('ended-advance-next');
    return;
  }

  // A failed/purged file fetch must never broadcast PLAY for a queue ID whose
  // resident PCM is missing (the previous buffer may have belonged to another
  // row). On the coordinator, treat Play as an explicit retry of the selected
  // row; guests continue to request playback from their coordinator below.
  if (!hostConn && !isActuallyPlaying && currentQueueItemId) {
    const selectedItem = playlistItems.find((item) => item.queueItemId === currentQueueItemId);
    const resident = getState('files.current');
    const bounded = legacyBoundedFileV1Product.snapshot();
    const boundedOwnsSelectedLoad =
      bounded.role === 'host' &&
      bounded.current?.queueItemId === currentQueueItemId &&
      (bounded.current.state === 'preparing' || bounded.current.state === 'ready');
    if (
      selectedItem?.type === 'file' &&
      !boundedOwnsSelectedLoad &&
      (!getCurrentAudioBuffer() || resident?.queueItemId !== currentQueueItemId)
    ) {
      void import('./playlist.ts').then((mod) => mod.playTrack(currentQueueItemId));
      return;
    }
  }

  // A natural track end stops playback immediately, then playlist.ts advances
  // on a short managed timer. On slower devices a file can be appended and play
  // tapped while the selected queue ID and resident AudioBuffer still belong
  // to the ended occurrence. Honor the tap as "advance now" instead of replaying it.
  if (!hostConn && !isActuallyPlaying && getManagedTimer('ended-advance-next')) {
    void import('./playlist.ts').then((mod) => mod.playNextTrack());
    return;
  }

  // Cancel pending auto-play (with user feedback)
  if (!hostConn && getManagedTimer('autoPlayTimer')) {
    clearManagedTimer('autoPlayTimer');
    showToast(t('toast.auto_play_canceled'));
  }
  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');

  if (isActuallyPlaying) {
    if (!hostConn) {
      if (requestLegacyBoundedV1HostPause(undefined, 'pause')) return;
      pause();
      broadcast({
        type: MSG.PAUSE,
        time: getState('player.pausedAt'),
        queueItemId: currentQueueItemId,
        reason: 'pause',
      });
    } else if (canControlPlayback) {
      if (currentQueueItemId) {
        sendToHost({ type: MSG.REQUEST_PAUSE, queueItemId: currentQueueItemId });
      }
    }
  } else {
    if (!hostConn) {
      if (!currentQueueItemId) return;
      const hostPlayAt = getHostNow() + SCHEDULE_AHEAD_MS;
      if (requestLegacyBoundedV1HostPlay(pausedAt, hostPlayAt)) return;
      play(pausedAt, 0, undefined, undefined, hostPlayAt);
      broadcast({
        type: MSG.PLAY,
        time: pausedAt,
        queueItemId: currentQueueItemId,
        hostPlayAt,
      });
    } else if (canControlPlayback) {
      if (currentQueueItemId) {
        sendToHost({ type: MSG.REQUEST_PLAY, time: pausedAt, queueItemId: currentQueueItemId });
      }
    }
  }
}

// ─── Stop Playback ─────────────────────────────────────────────────

export function stopPlayback(): void {
  if (isGuestBlocked()) return;

  const hostConn = getState('network.hostConn');
  const canControlPlayback = hasRoomCapability('playback.control');
  if (hostConn && canControlPlayback) {
    const queueItemId = getCurrentQueueItemId();
    if (!queueItemId) return;
    try {
      hostConn.send({ type: MSG.REQUEST_SEEK, time: 0, queueItemId });
    } catch (e) {
      log.debug('[Transport] send REQUEST_SEEK:', e);
    }
    try {
      hostConn.send({ type: MSG.REQUEST_PAUSE, queueItemId });
    } catch (e) {
      log.debug('[Transport] send REQUEST_PAUSE:', e);
    }
    showToast(t('toast.stop_sent'));
    return;
  }

  const wasCompatIdle = isCompatIdle();

  if (!wasCompatIdle && isSystemAudioPlaying()) {
    bus.emit('system-audio:stop');
    return;
  }

  if (
    !wasCompatIdle &&
    routeProPlaybackCommand({
      kind: 'stop',
      queueItemId: getCurrentQueueItemId(),
      positionSeconds: 0,
    })
  ) {
    return;
  }

  const v2Stop = requestV2HostFileStop({ cancelInFlight: true });
  if (v2Stop) {
    void v2Stop.then((committed) => {
      if (committed && !wasCompatIdle) showToast(t('common.stop'));
    });
    return;
  }

  if (wasCompatIdle) return; // Nothing to stop

  if (isYouTubeOwner()) {
    // Broadcast before clearing local ownership; stopYouTubeMode cannot infer
    // the prior mode after setPlaybackIdle, and guests need the explicit stop.
    const queueItemId = getCurrentQueueItemId();
    if (!hostConn && queueItemId) broadcast({ type: MSG.YOUTUBE_STOP, queueItemId });
    // Set IDLE before stop-playback to prevent onYouTubePlayerStateChange ENDED
    // from triggering playlist:next-track (its guard checks YouTube playback mode).
    // Do NOT reorder the idle write after the emits — that re-opens the
    // stopVideo()→ENDED→next-track advance race this ordering suppresses.
    setPlaybackIdle();
    bus.emit('youtube:stop-playback');
    bus.emit('youtube:stop-mode');
    clearManagedTimer('autoPlayTimer');
    clearManagedTimer('ended-advance-retry');
    clearManagedTimer('ended-advance-next');
    setState('player.pausedAt', 0);
    return;
  }

  stopAllMedia({ cancelInFlight: true });
  bus.emit('ui:seek-reset');

  if (!hostConn) {
    broadcast({ type: MSG.PAUSE, time: 0, queueItemId: getCurrentQueueItemId(), reason: 'stop' });
  }
  showToast(t('common.stop'));
}

// ─── Skip Time ─────────────────────────────────────────────────────

export function skipTime(sec: number): void {
  if (isGuestBlocked()) return;

  const hostConn = getState('network.hostConn');
  const canControlPlayback = hasRoomCapability('playback.control');
  const queueItemId = getCurrentQueueItemId();
  if (hostConn && canControlPlayback) {
    if (queueItemId) sendToHost({ type: MSG.REQUEST_SKIP_TIME, sec, queueItemId });
    return;
  }

  // Cancel pending auto-play on manual interaction (Host only)
  if (!hostConn && getManagedTimer('autoPlayTimer')) {
    clearManagedTimer('autoPlayTimer');
    showToast(t('toast.auto_play_canceled'));
  }

  if (isCompatIdle()) return;
  if (isSystemAudioOwner()) return; // No skip on live stream
  const requestedSkipTarget = Math.max(0, getTrackPosition() + (Number.isFinite(sec) ? sec : 0));
  if (
    routeProPlaybackCommand(
      {
        kind: 'seek',
        queueItemId,
        positionSeconds: requestedSkipTarget,
      },
      {
        wasPlaying: getState('playback.activity') === 'playing',
      },
    )
  ) {
    return;
  }
  if (isYouTubeOwner()) {
    bus.emit('youtube:skip-time', sec);
    return;
  }

  if (requestLegacyBoundedV1HostSeek(requestedSkipTarget)) return;

  if (isV2HostFileControlContext()) {
    if (Number.isFinite(sec)) {
      const checkpoint = readV2HostFailedPauseCheckpoint();
      if (checkpoint) {
        requestV2HostFileSeek(checkpoint.positionSeconds + sec);
      } else {
        void enqueueV2HostSeek((state) =>
          clampV2HostSeekTarget(state.position.positionSeconds + sec, state.durationSeconds),
        );
      }
    }
    return;
  }

  // Ignore skip requests while the resident buffer belongs to a prior track.
  if (isFilePipelineBusyForPlay()) {
    log.debug('[Skip] Ignoring skip while file pipeline is preparing');
    return;
  }

  const _currentAudioBuffer = getCurrentAudioBuffer();
  const current = getTrackPosition();
  let target = current + sec;
  const rawBufDur = _currentAudioBuffer?.duration;
  const duration = rawBufDur != null && Number.isFinite(rawBufDur) && rawBufDur > 0 ? rawBufDur : 0;

  if (target < 0) target = 0;
  if (duration > 0 && target > duration) target = Math.max(0, duration - 0.1);

  const isPlaying = isFilePlaybackPlaying();

  if (isPlaying) {
    if (!queueItemId) return;
    const hostPlayAt = getHostNow() + SCHEDULE_AHEAD_MS;
    play(target, 0, undefined, undefined, hostPlayAt);
    broadcast({
      type: MSG.PLAY,
      time: target,
      queueItemId,
      hostPlayAt,
    });
  } else {
    setState('player.pausedAt', target);
    broadcast({ type: MSG.PAUSE, time: target, queueItemId, reason: 'seek' });
  }
}

// ─── Adjust Sync ───────────────────────────────────────────────────

/**
 * How long to wait after the last nudge click before re-playing the audio.
 *
 * Each nudge updates sync.localOffset immediately, then a short debounce
 * rebuilds the AudioBufferSourceNode once for the burst. Reading the track
 * position at timer fire avoids replaying a click-time position that became
 * stale while the play lock was held.
 */
const NUDGE_REPLAY_DEBOUNCE_MS = 60;

function clampManualSyncOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MANUAL_SYNC_OFFSET_LIMIT_SEC, Math.min(MANUAL_SYNC_OFFSET_LIMIT_SEC, value));
}

export function setLocalManualSyncOffset(nextOffset: number): number {
  const prevOffset = getState('sync.localOffset') || 0;
  const next = clampManualSyncOffset(nextOffset);
  if (next === prevOffset) return next;

  setState('sync.localOffset', next);

  // Keep the logical track position stable when changing only the manual
  // output offset. The fresh play() below will rebuild the audio node at the
  // new audible offset; this prevents the UI/sync position from jumping by
  // the same delta before that replay lands.
  if (!isFileTransportInactive()) {
    const startedAt = getState('player.startedAt');
    if (typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt !== 0) {
      setState('player.startedAt', startedAt + (next - prevOffset));
    }
  }

  return next;
}

export function adjustSync(val: number): void {
  if (isV2HostFileControlContext() && !isYouTubeOwner() && !isSystemAudioOwner()) {
    log.debug('[Sync] Local file nudge is unavailable on the V2 host transport');
    return;
  }
  const localOffset = getState('sync.localOffset') || 0;
  setLocalManualSyncOffset(localOffset + val);
  bus.emit('sync:display-update');

  if (isFileTransportInactive()) {
    // Paused: localOffset is stored and applied on next play(pausedAt) via
    // startedAt. Don't modify pausedAt — it would cancel out the offset.
    return;
  }

  // Debounce: coalesce bursts of rapid clicks into one re-play. getTrackPosition
  // is read inside the timer so it reflects the offset accumulated across the
  // entire burst, not just the first click.
  clearManagedTimer('sync-nudge-replay');
  setManagedTimer(
    'sync-nudge-replay',
    () => {
      // Re-check playback state at fire time — user may have paused during the burst.
      if (isFileTransportInactive()) return;
      play(getTrackPosition());
    },
    NUDGE_REPLAY_DEBOUNCE_MS,
  );
}
