import type { PlaylistItem, PlaylistRevision, QueueItemId } from '../types/index.ts';

export interface ProRoomLegacyMediaHooks {
  addFiles(files: readonly File[], rejectedCount: number): boolean;
  addYouTube(item: PlaylistItem, sourceUrl: string): boolean;
  updateTrackMetadata(
    queueItemId: QueueItemId,
    metadata: Pick<PlaylistItem, 'name' | 'title' | 'artist' | 'thumbnail'>,
  ): boolean;
  removeTracks(queueItemIds: readonly QueueItemId[]): boolean;
  reorderTrack(
    queueItemId: QueueItemId,
    beforeQueueItemId: QueueItemId | null,
    baseRevision: PlaylistRevision,
  ): boolean;
  resolveFile(queueItemId: QueueItemId): Promise<File | null> | null;
}

export interface ProRoomLegacyPlaybackRestore {
  queueItemId: QueueItemId;
  positionSeconds: number;
  state: 'playing' | 'paused';
}

type ProRoomLegacyPlaybackRestoreHandler = (
  checkpoint: ProRoomLegacyPlaybackRestore,
) => Promise<boolean>;

let activeHooks: ProRoomLegacyMediaHooks | null = null;
let activePlaybackRestoreHandler: ProRoomLegacyPlaybackRestoreHandler | null = null;

/**
 * Late-bound seam between the legacy player graph and the persistent PRO
 * runtime. Keeping the seam data-only avoids importing the networking graph
 * back into playlist/decode modules during application bootstrap.
 */
export function registerProRoomLegacyMediaHooks(hooks: ProRoomLegacyMediaHooks | null): void {
  activeHooks = hooks;
}

export function handleProRoomFiles(files: readonly File[], rejectedCount = 0): boolean {
  return activeHooks?.addFiles(files, rejectedCount) ?? false;
}

export function handleProRoomYouTube(item: PlaylistItem, sourceUrl: string): boolean {
  return activeHooks?.addYouTube(item, sourceUrl) ?? false;
}

export function handleProRoomTrackMetadata(
  queueItemId: QueueItemId,
  metadata: Pick<PlaylistItem, 'name' | 'title' | 'artist' | 'thumbnail'>,
): boolean {
  return activeHooks?.updateTrackMetadata(queueItemId, metadata) ?? false;
}

export function handleProRoomTrackRemoval(queueItemIds: readonly QueueItemId[]): boolean {
  return activeHooks?.removeTracks(queueItemIds) ?? false;
}

export function handleProRoomTrackReorder(
  queueItemId: QueueItemId,
  beforeQueueItemId: QueueItemId | null,
  baseRevision: PlaylistRevision,
): boolean {
  return activeHooks?.reorderTrack(queueItemId, beforeQueueItemId, baseRevision) ?? false;
}

export function resolveProRoomPlaylistFile(queueItemId: QueueItemId): Promise<File | null> | null {
  return activeHooks?.resolveFile(queueItemId) ?? null;
}

/**
 * Register the player-owned inverse bridge used by the PRO runtime to restore
 * a persistent file checkpoint without importing the player graph directly.
 */
export function registerProRoomLegacyPlaybackRestoreHandler(
  handler: ProRoomLegacyPlaybackRestoreHandler | null,
): void {
  activePlaybackRestoreHandler = handler;
}

export function restoreProRoomLegacyPlayback(
  checkpoint: ProRoomLegacyPlaybackRestore,
): Promise<boolean> {
  return activePlaybackRestoreHandler?.(checkpoint) ?? Promise.resolve(false);
}
