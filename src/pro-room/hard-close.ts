import type { ProRoomPlaybackCheckpoint, ProRoomSnapshot } from './contracts.ts';
import type { QueueItemId } from '../types/index.ts';

const PLAYBACK_MAX_POSITION_SECONDS = 7 * 24 * 60 * 60;
const YOUTUBE_SUB_INDEX_MAX = 100_000;
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

interface ProRoomPlaybackObservation {
  state: ProRoomPlaybackCheckpoint['state'];
  queueItemId: QueueItemId | null;
  positionSeconds: number;
  youtubeVideoId: string | null;
  youtubeSubIndex: number | null;
  updatedAtMs: number;
}

interface ProRoomUnloadCheckpoint {
  currentQueueItemId: QueueItemId | null;
  playback: ProRoomPlaybackCheckpoint | null;
}

function semanticallyEqual(
  left: ProRoomPlaybackCheckpoint,
  right: ProRoomPlaybackCheckpoint,
): boolean {
  return (
    left.coordinatorEpoch === right.coordinatorEpoch &&
    left.state === right.state &&
    left.queueItemId === right.queueItemId &&
    left.positionSeconds === right.positionSeconds &&
    left.youtubeVideoId === right.youtubeVideoId &&
    left.youtubeSubIndex === right.youtubeSubIndex
  );
}

function noCheckpoint(): ProRoomUnloadCheckpoint {
  return { currentQueueItemId: null, playback: null };
}

/**
 * Bound how long explicit leave waits before falling back to the ordinary
 * presence endpoint. The original request is deliberately not aborted: a
 * browser keepalive fetch may still reach the Durable Object after the local
 * deadline and both close operations are idempotent.
 */
export async function waitForProRoomPresenceClose(
  request: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('PRO_ROOM_PRESENCE_CLOSE_TIMEOUT_INVALID');
  }
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    await Promise.race([
      request,
      new Promise<void>((_resolve, reject) => {
        timeout = globalThis.setTimeout(
          () => reject(new Error('PRO_ROOM_PRESENCE_CLOSE_TIMEOUT')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
  }
}

/**
 * Convert the local player observation into the same strict checkpoint shape
 * accepted by the persistent room service. Invalid/transitional UI state is
 * intentionally degraded to a presence-only close rather than risking a bad
 * unload mutation.
 */
export function buildProRoomUnloadCheckpoint(
  snapshot: ProRoomSnapshot,
  observation: ProRoomPlaybackObservation,
): ProRoomUnloadCheckpoint {
  const isCoordinator =
    snapshot.viewer !== null &&
    snapshot.viewer.participantId === snapshot.presence.coordinatorParticipantId;
  if (!isCoordinator) return noCheckpoint();
  if (
    !Number.isFinite(observation.positionSeconds) ||
    observation.positionSeconds < 0 ||
    observation.positionSeconds > PLAYBACK_MAX_POSITION_SECONDS ||
    !Number.isSafeInteger(observation.updatedAtMs) ||
    observation.updatedAtMs < 0
  ) {
    return noCheckpoint();
  }

  const currentQueueItemId = observation.state === 'idle' ? null : observation.queueItemId;
  if (observation.state === 'idle') {
    if (
      observation.queueItemId !== null ||
      observation.positionSeconds !== 0 ||
      observation.youtubeVideoId !== null ||
      observation.youtubeSubIndex !== null
    ) {
      return noCheckpoint();
    }
  } else if (
    (observation.state !== 'playing' && observation.state !== 'paused') ||
    currentQueueItemId === null
  ) {
    return noCheckpoint();
  }

  const selectedItem =
    currentQueueItemId === null
      ? null
      : snapshot.playlist.find((item) => item.queueItemId === currentQueueItemId);
  if (currentQueueItemId !== null && !selectedItem) return noCheckpoint();
  if (selectedItem?.source.kind === 'youtube') {
    if (
      observation.youtubeVideoId === null ||
      !YOUTUBE_VIDEO_ID_RE.test(observation.youtubeVideoId) ||
      observation.youtubeSubIndex === null ||
      !Number.isSafeInteger(observation.youtubeSubIndex) ||
      observation.youtubeSubIndex < 0 ||
      observation.youtubeSubIndex > YOUTUBE_SUB_INDEX_MAX
    ) {
      return noCheckpoint();
    }
  } else if (observation.youtubeVideoId !== null || observation.youtubeSubIndex !== null) {
    return noCheckpoint();
  }

  const candidate: ProRoomPlaybackCheckpoint = {
    coordinatorEpoch: snapshot.presence.coordinatorEpoch,
    revision: snapshot.playback.revision,
    state: observation.state,
    queueItemId: currentQueueItemId,
    positionSeconds: observation.positionSeconds === 0 ? 0 : observation.positionSeconds,
    youtubeVideoId: observation.youtubeVideoId,
    youtubeSubIndex: observation.youtubeSubIndex,
    updatedAtMs: observation.updatedAtMs,
  };
  if (
    snapshot.currentQueueItemId !== currentQueueItemId ||
    !semanticallyEqual(candidate, snapshot.playback)
  ) {
    if (snapshot.playback.revision >= Number.MAX_SAFE_INTEGER) return noCheckpoint();
    candidate.revision = snapshot.playback.revision + 1;
  } else {
    // An unchanged paused/idle checkpoint must preserve the server timestamp;
    // otherwise a no-op unload could look like an unversioned state change.
    candidate.updatedAtMs = snapshot.playback.updatedAtMs;
  }

  return { currentQueueItemId, playback: candidate };
}
