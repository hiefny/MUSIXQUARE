/** Ownership shared by native file output recovery and demo playback. */
import { getState } from '../core/state.ts';
import { getRoomContext } from '../rooms/authority.ts';
import type { QueueItemId, ResidentFile } from '../types/index.ts';
import { getCurrentAudioBuffer, getCurrentLoadEpoch } from './_state.ts';
import type { FilePlaybackResource } from './file-playback-resource.ts';

interface OutputIdentityBase {
  readonly roomKind: 'standard' | 'pro';
  readonly roomId: string | null;
  readonly roomEpoch: number;
  readonly buffer: FilePlaybackResource;
}

export type LocalFileOutputIdentity = OutputIdentityBase &
  (
    | {
        readonly kind: 'queue-file';
        readonly queueItemId: QueueItemId;
        readonly resident: ResidentFile | null;
      }
    | {
        readonly kind: 'demo';
        readonly queueItemId: null;
        readonly trackIndex: number;
        readonly loadEpoch: number;
      }
  );

export function captureLocalFileOutputIdentity(
  options: { requireResident?: boolean } = {},
): LocalFileOutputIdentity | null {
  const buffer = getCurrentAudioBuffer();
  if (!buffer) return null;
  const room = getRoomContext();
  const base = { roomKind: room.kind, roomId: room.roomId, roomEpoch: room.epoch, buffer };
  if (getState('demo.active')) {
    const trackIndex = getState('demo.currentTrackIndex');
    if (room.kind !== 'standard' || !Number.isInteger(trackIndex) || trackIndex < 0) return null;
    return {
      ...base,
      kind: 'demo',
      queueItemId: null,
      trackIndex,
      loadEpoch: getCurrentLoadEpoch(),
    };
  }
  const queueItemId = getState('playlist.currentQueueItemId');
  const resident = getState('files.current');
  if (
    !queueItemId ||
    (options.requireResident !== false && resident?.queueItemId !== queueItemId)
  ) {
    return null;
  }
  return { ...base, kind: 'queue-file', queueItemId, resident };
}

export function localFileOutputIdentitiesEqual(
  left: LocalFileOutputIdentity,
  right: LocalFileOutputIdentity,
): boolean {
  return (
    left.roomKind === right.roomKind &&
    left.roomId === right.roomId &&
    left.roomEpoch === right.roomEpoch &&
    left.buffer === right.buffer &&
    (left.kind === 'demo'
      ? right.kind === 'demo' &&
        left.trackIndex === right.trackIndex &&
        left.loadEpoch === right.loadEpoch
      : right.kind === 'queue-file' &&
        left.queueItemId === right.queueItemId &&
        left.resident === right.resident)
  );
}

export function isLocalFileOutputIdentityCurrent(identity: LocalFileOutputIdentity): boolean {
  const current = captureLocalFileOutputIdentity({ requireResident: false });
  return !!current && localFileOutputIdentitiesEqual(identity, current);
}
