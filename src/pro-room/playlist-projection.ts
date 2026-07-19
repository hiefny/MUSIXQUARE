import type {
  ProRoomMediaSource,
  ProRoomPlaylistWireItem,
  ProRoomR2Source,
  ProRoomYouTubeSource,
} from './contracts.ts';
import type { PlaylistItem, QueueItemId } from '../types/index.ts';

function cloneSource(source: ProRoomMediaSource): ProRoomMediaSource {
  return source.kind === 'youtube'
    ? {
        kind: 'youtube',
        videoId: source.videoId,
        ...(source.playlistId === undefined ? {} : { playlistId: source.playlistId }),
        ...(source.videoIds === undefined ? {} : { videoIds: [...source.videoIds] }),
      }
    : {
        kind: 'pro-r2',
        assetId: source.assetId,
        version: source.version,
        byteLength: source.byteLength,
        mime: source.mime,
        ...(source.sha256 === undefined ? {} : { sha256: source.sha256 }),
      };
}

function cloneMetadata(
  item: Pick<ProRoomPlaylistWireItem, 'name' | 'title' | 'artist' | 'thumbnail'>,
): Pick<PlaylistItem, 'name' | 'title' | 'artist' | 'thumbnail'> {
  return {
    name: item.name,
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(item.artist === undefined ? {} : { artist: item.artist }),
    ...(item.thumbnail === undefined ? {} : { thumbnail: item.thumbnail }),
  };
}

function sourceFromLegacyYouTube(
  item: PlaylistItem,
  previous?: ProRoomMediaSource,
): ProRoomYouTubeSource {
  if (item.type !== 'youtube' || !item.videoId) {
    throw new Error('PRO_ROOM_PLAYLIST_YOUTUBE_SOURCE_MISSING');
  }
  if (
    item.playlistId !== null &&
    item.playlistId !== undefined &&
    (typeof item.playlistId !== 'string' || item.playlistId.length === 0)
  ) {
    throw new Error('PRO_ROOM_PLAYLIST_YOUTUBE_SOURCE_INVALID');
  }
  return {
    kind: 'youtube',
    videoId: item.videoId,
    ...(typeof item.playlistId === 'string' ? { playlistId: item.playlistId } : {}),
    ...(previous?.kind === 'youtube' &&
    previous.videoId === item.videoId &&
    previous.playlistId === (item.playlistId ?? undefined) &&
    previous.videoIds
      ? { videoIds: [...previous.videoIds] }
      : {}),
  };
}

function assertUniqueQueueItems(items: readonly { queueItemId: QueueItemId }[]): void {
  const seen = new Set<QueueItemId>();
  for (const item of items) {
    if (seen.has(item.queueItemId)) {
      throw new Error('PRO_ROOM_PLAYLIST_DUPLICATE_QUEUE_ITEM');
    }
    seen.add(item.queueItemId);
  }
}

/**
 * Bidirectional projection between the persistent PRO playlist and the legacy
 * player model. The player only sees an unloaded file row for R2 media; a File
 * is attached later, after the bounded downloader has verified every byte.
 */
export class ProRoomPlaylistProjection {
  readonly #sources = new Map<QueueItemId, ProRoomMediaSource>();

  project(items: readonly ProRoomPlaylistWireItem[]): PlaylistItem[] {
    assertUniqueQueueItems(items);
    const nextSources = new Map<QueueItemId, ProRoomMediaSource>();
    const projected = items.map((item): PlaylistItem => {
      const source = cloneSource(item.source);
      nextSources.set(item.queueItemId, source);
      if (source.kind === 'youtube') {
        return {
          queueItemId: item.queueItemId,
          type: 'youtube',
          ...cloneMetadata(item),
          videoId: source.videoId,
          playlistId: source.playlistId ?? null,
        };
      }
      return {
        queueItemId: item.queueItemId,
        type: 'file',
        ...cloneMetadata(item),
        videoId: null,
        playlistId: null,
      };
    });

    this.#sources.clear();
    for (const [queueItemId, source] of nextSources) this.#sources.set(queueItemId, source);
    return projected;
  }

  toWire(items: readonly PlaylistItem[]): ProRoomPlaylistWireItem[] {
    assertUniqueQueueItems(items);
    const nextSources = new Map<QueueItemId, ProRoomMediaSource>();
    const wire = items.map((item): ProRoomPlaylistWireItem => {
      const source =
        item.type === 'youtube'
          ? sourceFromLegacyYouTube(item, this.#sources.get(item.queueItemId))
          : this.#requireR2Source(item.queueItemId);
      nextSources.set(item.queueItemId, cloneSource(source));
      return {
        queueItemId: item.queueItemId,
        ...cloneMetadata(item),
        source: cloneSource(source),
      };
    });

    this.#sources.clear();
    for (const [queueItemId, source] of nextSources) this.#sources.set(queueItemId, source);
    return wire;
  }

  bindR2Source(queueItemId: QueueItemId, source: ProRoomR2Source): void {
    this.#sources.set(queueItemId, cloneSource(source));
  }

  sourceFor(queueItemId: QueueItemId): ProRoomMediaSource | null {
    const source = this.#sources.get(queueItemId);
    return source ? cloneSource(source) : null;
  }

  remove(queueItemId: QueueItemId): void {
    this.#sources.delete(queueItemId);
  }

  clear(): void {
    this.#sources.clear();
  }

  #requireR2Source(queueItemId: QueueItemId): ProRoomR2Source {
    const source = this.#sources.get(queueItemId);
    if (!source || source.kind !== 'pro-r2') {
      throw new Error('PRO_ROOM_PLAYLIST_FILE_NOT_UPLOADED');
    }
    return source;
  }
}
