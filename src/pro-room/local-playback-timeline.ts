/** Read-only server timeline used by participant-local YouTube compensation. */
import { getRoomContext } from '../rooms/authority.ts';
import type { ProRoomSnapshot } from './contracts.ts';

export interface ProRoomLocalPlaybackTimeline {
  readonly roomId: string;
  readonly roomEpoch: number;
  readonly queueItemId: string;
  readonly videoId: string;
  readonly subIndex: number;
  readonly playing: boolean;
  readonly positionSeconds: number;
  isCurrent(): boolean;
}

interface TimelinePorts {
  getSnapshot(): ProRoomSnapshot | null;
  getServerNow(): number;
  isClockCalibrated(): boolean;
  /** Captures the controller generation, playlist lease, and applied revision. */
  captureLiveness(revision: number): (() => boolean) | null;
}

let provider: TimelinePorts | null = null;
let generation = 0;

export function registerProRoomLocalPlaybackTimeline(ports: TimelinePorts): () => void {
  provider = ports;
  generation += 1;
  return () => {
    if (provider !== ports) return;
    provider = null;
    generation += 1;
  };
}

export function getProRoomLocalPlaybackTimelineGeneration(): number {
  return generation;
}

/** No room command, revision, or endpoint action is produced by this read. */
export function captureProRoomLocalPlaybackTimeline(): ProRoomLocalPlaybackTimeline | null {
  const source = provider;
  const snapshot = source?.getSnapshot();
  const context = getRoomContext();
  if (
    !source ||
    !snapshot ||
    context.kind !== 'pro' ||
    context.roomId !== snapshot.roomCode ||
    context.epoch !== snapshot.presence.coordinatorEpoch
  )
    return null;
  const playback = snapshot.playback;
  if (
    playback.state === 'idle' ||
    !playback.queueItemId ||
    !playback.youtubeVideoId ||
    !source.isClockCalibrated()
  )
    return null;
  const live = source.captureLiveness(playback.revision);
  if (!live?.()) return null;
  const capturedGeneration = generation;
  const playing = playback.state === 'playing';
  const serverNow = source.getServerNow();
  if (
    !Number.isFinite(serverNow) ||
    !Number.isFinite(playback.positionSeconds) ||
    !Number.isFinite(playback.updatedAtMs)
  )
    return null;
  return {
    roomId: snapshot.roomCode,
    roomEpoch: context.epoch,
    queueItemId: playback.queueItemId,
    videoId: playback.youtubeVideoId,
    subIndex: playback.youtubeSubIndex ?? -1,
    playing,
    positionSeconds:
      playback.positionSeconds +
      (playing ? Math.max(0, serverNow - playback.updatedAtMs) / 1000 : 0),
    isCurrent() {
      const room = getRoomContext();
      const current = source.getSnapshot();
      return (
        provider === source &&
        generation === capturedGeneration &&
        live() &&
        room.kind === 'pro' &&
        room.roomId === snapshot.roomCode &&
        room.epoch === context.epoch &&
        current?.playback.revision === playback.revision &&
        current.playback.coordinatorEpoch === playback.coordinatorEpoch
      );
    },
  };
}
