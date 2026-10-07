import { getState } from '../core/state.ts';
import type { QueueItemId } from '../types/index.ts';
import { updateSubItemIds } from '../youtube/_state.ts';
import { proYouTubeSubItemsKey } from '../youtube/queue-manifest.ts';
import type { ProRoomSnapshot } from './contracts.ts';

// Keep well below the manifest endpoint's per-IP minute budget so a room with
// legacy rows cannot starve an explicit user add. Remaining rows continue on
// a later room session.
const MAX_LAZY_YOUTUBE_MANIFEST_UPGRADES = 4;

export function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Cache canonical manifests by queue occurrence, never by external playlist ID. */
export function hydrateProRoomYouTubeManifests(snapshot: ProRoomSnapshot): void {
  for (const item of snapshot.playlist) {
    if (item.source.kind !== 'youtube' || !item.source.playlistId || !item.source.videoIds) {
      continue;
    }
    const key = proYouTubeSubItemsKey(item.queueItemId);
    const current = getState('youtube.subItemsMap')[key];
    if (
      current &&
      current.manifestComplete === true &&
      sameStringArray(current.ids, item.source.videoIds)
    ) {
      continue;
    }
    // updateSubItemIds clones the IDs and retains any richer titles already
    // fetched by this endpoint instead of replacing them with empty labels.
    updateSubItemIds(key, item.source.videoIds, {
      manifestComplete: true,
      titleSourceKey: item.source.playlistId,
    });
  }
}

interface LegacyYouTubeManifestCandidate {
  queueItemId: QueueItemId;
  playlistId: string;
  videoId: string;
}

export function claimLegacyYouTubeManifestCandidates(
  snapshot: ProRoomSnapshot,
  attempted: Set<QueueItemId>,
): LegacyYouTubeManifestCandidate[] {
  const candidates: LegacyYouTubeManifestCandidate[] = [];
  for (const item of snapshot.playlist) {
    if (attempted.size >= MAX_LAZY_YOUTUBE_MANIFEST_UPGRADES) break;
    if (
      item.source.kind !== 'youtube' ||
      !item.source.playlistId ||
      item.source.videoIds ||
      item.queueItemId === snapshot.currentQueueItemId ||
      attempted.has(item.queueItemId)
    ) {
      continue;
    }
    attempted.add(item.queueItemId);
    candidates.push({
      queueItemId: item.queueItemId,
      playlistId: item.source.playlistId,
      videoId: item.source.videoId,
    });
  }
  return candidates;
}
