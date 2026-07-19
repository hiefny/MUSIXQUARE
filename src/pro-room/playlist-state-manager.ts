import type { UpdateProRoomCompactSnapshotInput, UpdateProRoomSnapshotInput } from './api.ts';
import {
  PRO_ROOM_MAX_PLAYLIST_ITEMS,
  type ProRoomPlaybackCheckpoint,
  type ProRoomPlaylistWireItem,
  type ProRoomSnapshot,
} from './contracts.ts';
import { createProRoomIdempotencyKey } from './idempotency.ts';
import type {
  ProRoomMediaProgress,
  ProRoomMediaUploadResult,
  UploadProRoomMediaInput,
} from './media-transfer.ts';
import { ProRoomPlaylistProjection } from './playlist-projection.ts';
import { applyProRoomSnapshotMonotonically } from './revision.ts';
import { isProRoomCode } from './room-code.ts';
import {
  isProRoomQueueItemId,
  parseProRoomPlaylistItem,
  parseProRoomSnapshot,
} from './snapshot.ts';

type QueueItemId = ProRoomPlaylistWireItem['queueItemId'];
type ProjectedPlaylist = ReturnType<ProRoomPlaylistProjection['project']>;

interface ProRoomPlaylistStateApi {
  getSnapshot(code: string, signal?: AbortSignal): Promise<ProRoomSnapshot>;
  updateSnapshot(input: UpdateProRoomSnapshotInput, signal?: AbortSignal): Promise<ProRoomSnapshot>;
  updateCompactSnapshot?(
    input: UpdateProRoomCompactSnapshotInput,
    signal?: AbortSignal,
  ): Promise<ProRoomSnapshot>;
}

interface ProRoomPlaylistMediaTransfer {
  upload(input: UploadProRoomMediaInput): Promise<ProRoomMediaUploadResult>;
  deleteAsset(input: { code: string; assetId: string }): Promise<unknown>;
}

export type {
  ProRoomPlaylistMediaTransfer as ProRoomPlaylistMediaTransferForTests,
  ProRoomPlaylistStateApi as ProRoomPlaylistStateApiForTests,
};

interface ProRoomMediaCleanupErrorEvent {
  reason: 'uploaded-orphan' | 'removed-unreferenced';
  assetId: string;
  error: unknown;
}

type ProRoomMediaCleanupErrorReporter = (
  event: ProRoomMediaCleanupErrorEvent,
) => void | Promise<void>;

interface ProRoomPlaylistProjectionEvent {
  snapshot: ProRoomSnapshot;
  playlist: ProjectedPlaylist;
}

type ProRoomPlaylistProjectionSink = (
  event: ProRoomPlaylistProjectionEvent,
) => void | Promise<void>;

export interface ProRoomFirstAppendSelectionRequest {
  roomCode: string;
  queueItemId: QueueItemId;
  coordinatorEpoch: number;
  basePlaybackRevision: number;
  youtubeVideoId: string | null;
  youtubeSubIndex: number | null;
}

interface ProRoomFirstAppendSelectionErrorEvent {
  request: ProRoomFirstAppendSelectionRequest;
  error: unknown;
}

interface ProRoomPlaylistStateManagerOptions {
  code: string;
  api: ProRoomPlaylistStateApi;
  mediaTransfer: ProRoomPlaylistMediaTransfer;
  sink: ProRoomPlaylistProjectionSink;
  projection?: ProRoomPlaylistProjection;
  reportMediaCleanupError?: ProRoomMediaCleanupErrorReporter;
  requestFirstAppendSelection?: (
    request: ProRoomFirstAppendSelectionRequest,
    signal?: AbortSignal,
  ) => void | Promise<void>;
  reportFirstAppendSelectionError?: (
    event: ProRoomFirstAppendSelectionErrorEvent,
  ) => void | Promise<void>;
  createIdempotencyKey?: () => string;
  createQueueItemId?: () => QueueItemId;
  now?: () => number;
}

interface AddProRoomYouTubeInput {
  queueItemId?: QueueItemId;
  name: string;
  videoId: string;
  playlistId?: string;
  videoIds?: readonly string[];
  title?: string;
  artist?: string;
  thumbnail?: string;
  signal?: AbortSignal;
}

interface UpdateProRoomPlaylistMetadataInput {
  name?: string;
  title?: string | null;
  artist?: string | null;
  thumbnail?: string | null;
}

interface UpdateProRoomYouTubeManifestInput {
  /** Identity fence captured before asynchronous playlist resolution. */
  playlistId: string;
  videoId: string;
  videoIds: readonly string[];
}

interface AddProRoomLocalFileInput {
  file: File;
  sha256?: string;
  title?: string;
  artist?: string;
  thumbnail?: string;
  onProgress?: ProRoomMediaProgress;
}

interface ProRoomPlaylistMutationOptions {
  baseRevision?: number;
  signal?: AbortSignal;
}

interface UpdateProRoomPlaybackInput {
  state: ProRoomPlaybackCheckpoint['state'];
  queueItemId: QueueItemId | null;
  positionSeconds: number;
  youtubeVideoId?: string | null;
  youtubeSubIndex?: number | null;
  updatedAtMs?: number;
  coordinatorEpoch?: number;
}

class ProRoomPlaylistStateError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = 'ProRoomPlaylistStateError';
    this.code = code;
  }
}

interface PlaylistMutation {
  playlist: ProRoomPlaylistWireItem[];
  currentQueueItemId: QueueItemId | null;
  playback: ProRoomPlaybackCheckpoint;
}

type PlaylistMutationAttempt =
  | { outcome: 'accepted'; snapshot: ProRoomSnapshot }
  | { outcome: 'conflict'; error: unknown };

type PlaylistIntent = (snapshot: ProRoomSnapshot, isRebase: boolean) => PlaylistMutation | null;

function cloneSnapshot(snapshot: ProRoomSnapshot): ProRoomSnapshot {
  const cloned = parseProRoomSnapshot(snapshot);
  if (!cloned) throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_SNAPSHOT_INVALID');
  return cloned;
}

function clonePlaylist(items: readonly ProRoomPlaylistWireItem[]): ProRoomPlaylistWireItem[] {
  return items.map((item) => {
    const cloned = parseProRoomPlaylistItem(item);
    if (!cloned) throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_ITEM_INVALID');
    return cloned;
  });
}

function clonePlayback(playback: ProRoomPlaybackCheckpoint): ProRoomPlaybackCheckpoint {
  return {
    coordinatorEpoch: playback.coordinatorEpoch,
    revision: playback.revision,
    state: playback.state,
    queueItemId: playback.queueItemId,
    positionSeconds: playback.positionSeconds,
    youtubeVideoId: playback.youtubeVideoId,
    youtubeSubIndex: playback.youtubeSubIndex,
    updatedAtMs: playback.updatedAtMs,
  };
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameMutation(snapshot: ProRoomSnapshot, mutation: PlaylistMutation): boolean {
  return (
    jsonEqual(snapshot.playlist, mutation.playlist) &&
    snapshot.currentQueueItemId === mutation.currentQueueItemId &&
    jsonEqual(snapshot.playback, mutation.playback)
  );
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_ABORTED');
  }
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRevisionConflict(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; status?: unknown };
  return candidate.status === 409 && candidate.code === 'REVISION_CONFLICT';
}

function isCompactMutationUnavailable(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; status?: unknown };
  return candidate.status === 404 && candidate.code === 'NOT_FOUND';
}

function defaultQueueItemId(): QueueItemId {
  if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') {
    throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_SECURE_RANDOM_UNAVAILABLE');
  }
  return globalThis.crypto.randomUUID();
}

function assertMetadata(
  metadata: Pick<ProRoomPlaylistWireItem, 'name' | 'title' | 'artist' | 'thumbnail'>,
): void {
  const values = [metadata.name, metadata.title, metadata.artist, metadata.thumbnail];
  for (const value of values) {
    if (
      value !== undefined &&
      (typeof value !== 'string' || value.length === 0 || value.length > 2048)
    ) {
      throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_METADATA_INVALID');
    }
  }
}

function canonicalItem(item: ProRoomPlaylistWireItem): ProRoomPlaylistWireItem {
  const parsed = parseProRoomPlaylistItem(item);
  if (!parsed) throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_ITEM_INVALID');
  return parsed;
}

function idlePlayback(
  playback: ProRoomPlaybackCheckpoint,
  updatedAtMs: number,
): ProRoomPlaybackCheckpoint {
  if (playback.revision >= Number.MAX_SAFE_INTEGER) {
    throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_PLAYBACK_REVISION_EXHAUSTED');
  }
  return {
    coordinatorEpoch: playback.coordinatorEpoch,
    revision: playback.revision + 1,
    state: 'idle',
    queueItemId: null,
    positionSeconds: 0,
    youtubeVideoId: null,
    youtubeSubIndex: null,
    updatedAtMs: Math.max(playback.updatedAtMs, updatedAtMs),
  };
}

/**
 * Isolated authoritative PRO-room playlist state manager.
 *
 * This class deliberately has no app bus or transport dependency. Integrators
 * inject the API and projected-playlist sink. Mutations are locally serialized
 * and use one bounded CAS refresh/rebase against the server authority.
 */
export class ProRoomPlaylistStateManager {
  readonly #code: string;
  readonly #api: ProRoomPlaylistStateApi;
  readonly #mediaTransfer: ProRoomPlaylistMediaTransfer;
  readonly #sink: ProRoomPlaylistProjectionSink;
  readonly #projection: ProRoomPlaylistProjection;
  readonly #reportMediaCleanupError?: ProRoomMediaCleanupErrorReporter;
  readonly #requestFirstAppendSelection?: ProRoomPlaylistStateManagerOptions['requestFirstAppendSelection'];
  readonly #reportFirstAppendSelectionError?: ProRoomPlaylistStateManagerOptions['reportFirstAppendSelectionError'];
  readonly #createIdempotencyKey: () => string;
  readonly #createQueueItemId: () => QueueItemId;
  readonly #now: () => number;
  readonly #issuedIdempotencyKeys = new Set<string>();
  #snapshot: ProRoomSnapshot | null = null;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(options: ProRoomPlaylistStateManagerOptions) {
    if (!isProRoomCode(options.code)) {
      throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_ROOM_CODE_INVALID');
    }
    this.#code = options.code;
    this.#api = options.api;
    this.#mediaTransfer = options.mediaTransfer;
    this.#sink = options.sink;
    this.#projection = options.projection ?? new ProRoomPlaylistProjection();
    this.#reportMediaCleanupError = options.reportMediaCleanupError;
    this.#requestFirstAppendSelection = options.requestFirstAppendSelection;
    this.#reportFirstAppendSelectionError = options.reportFirstAppendSelectionError;
    this.#createIdempotencyKey = options.createIdempotencyKey ?? createProRoomIdempotencyKey;
    this.#createQueueItemId = options.createQueueItemId ?? defaultQueueItemId;
    this.#now = options.now ?? Date.now;
  }

  get snapshot(): ProRoomSnapshot | null {
    return this.#snapshot ? cloneSnapshot(this.#snapshot) : null;
  }

  acceptSnapshot(snapshot: ProRoomSnapshot): Promise<ProRoomSnapshot> {
    return this.#enqueue(() => this.#accept(snapshot));
  }

  addYouTube(input: AddProRoomYouTubeInput): Promise<ProRoomSnapshot> {
    return this.#enqueue(async () => {
      assertNotAborted(input.signal);
      const queueItemId =
        input.queueItemId === undefined
          ? this.#nextQueueItemId()
          : this.#validateQueueItemId(input.queueItemId);
      assertMetadata(input);
      const item = canonicalItem({
        queueItemId,
        name: input.name,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.artist === undefined ? {} : { artist: input.artist }),
        ...(input.thumbnail === undefined ? {} : { thumbnail: input.thumbnail }),
        source: {
          kind: 'youtube',
          videoId: input.videoId,
          ...(input.playlistId === undefined ? {} : { playlistId: input.playlistId }),
          ...(input.videoIds === undefined ? {} : { videoIds: [...input.videoIds] }),
        },
      });
      return this.#appendCanonicalItem(item, input.signal);
    });
  }

  /**
   * Upgrade one legacy YouTube playlist source with its immutable manifest.
   * The source identity is rechecked after a CAS refresh so a late resolver
   * can never annotate a replaced/reordered queue occurrence.
   */
  updateYouTubeManifest(
    queueItemId: QueueItemId,
    input: UpdateProRoomYouTubeManifestInput,
    options: ProRoomPlaylistMutationOptions = {},
  ): Promise<ProRoomSnapshot> {
    return this.#enqueue(() => {
      this.#validateQueueItemId(queueItemId);
      const canonicalSource = canonicalItem({
        queueItemId,
        name: 'manifest-validation',
        source: {
          kind: 'youtube',
          playlistId: input.playlistId,
          videoId: input.videoId,
          videoIds: [...input.videoIds],
        },
      }).source;
      if (canonicalSource.kind !== 'youtube' || !canonicalSource.videoIds) {
        throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_YOUTUBE_MANIFEST_INVALID');
      }
      const canonicalVideoIds = [...canonicalSource.videoIds];

      return this.#mutate((snapshot) => {
        const index = snapshot.playlist.findIndex((item) => item.queueItemId === queueItemId);
        if (index === -1) return null;
        const current = snapshot.playlist[index]!;
        if (
          current.source.kind !== 'youtube' ||
          current.source.playlistId !== input.playlistId ||
          current.source.videoId !== input.videoId
        ) {
          return null;
        }
        // A manifest is immutable after the one legacy absent -> present
        // upgrade. Duplicate or conflicting late resolvers are both no-ops.
        if (current.source.videoIds) return null;

        const playlist = clonePlaylist(snapshot.playlist);
        playlist[index] = canonicalItem({
          ...current,
          source: {
            ...current.source,
            videoIds: canonicalVideoIds,
          },
        });
        return {
          playlist,
          currentQueueItemId: snapshot.currentQueueItemId,
          playback: clonePlayback(snapshot.playback),
        };
      }, options.signal);
    });
  }

  addLocalFiles(
    inputs: readonly AddProRoomLocalFileInput[],
    options: ProRoomPlaylistMutationOptions = {},
  ): Promise<ProRoomSnapshot> {
    return this.#enqueue(async () => {
      let accepted = this.#requireSnapshot();
      for (const input of inputs) {
        assertNotAborted(options.signal);
        assertMetadata({
          name: input.file.name,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.artist === undefined ? {} : { artist: input.artist }),
          ...(input.thumbnail === undefined ? {} : { thumbnail: input.thumbnail }),
        });
        this.#assertCapacity(accepted, 1);
        const queueItemId = this.#nextQueueItemId();
        const upload = await this.#mediaTransfer.upload({
          code: this.#code,
          file: input.file,
          ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
          ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        try {
          assertNotAborted(options.signal);
          const item = canonicalItem({
            queueItemId,
            name: input.file.name,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.artist === undefined ? {} : { artist: input.artist }),
            ...(input.thumbnail === undefined ? {} : { thumbnail: input.thumbnail }),
            source: upload.asset,
          });
          accepted = await this.#appendCanonicalItem(item, options.signal);
        } catch (error) {
          await this.#bestEffortDelete(upload.asset.assetId, 'uploaded-orphan');
          throw error;
        }
      }
      return cloneSnapshot(accepted);
    });
  }

  remove(
    queueItemId: QueueItemId,
    options: ProRoomPlaylistMutationOptions = {},
  ): Promise<ProRoomSnapshot> {
    return this.removeMany([queueItemId], options);
  }

  removeMany(
    queueItemIds: readonly QueueItemId[],
    options: ProRoomPlaylistMutationOptions = {},
  ): Promise<ProRoomSnapshot> {
    const requested = new Set(queueItemIds);
    return this.#enqueue(async () => {
      if ([...requested].some((queueItemId) => !isProRoomQueueItemId(queueItemId))) {
        throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_QUEUE_ITEM_ID_INVALID');
      }

      let removedAssetIds = new Set<string>();
      const accepted = await this.#mutate((snapshot) => {
        const removed = snapshot.playlist.filter((item) => requested.has(item.queueItemId));
        removedAssetIds = new Set(
          removed.flatMap((item) => (item.source.kind === 'pro-r2' ? [item.source.assetId] : [])),
        );
        if (removed.length === 0) return null;

        const nextPlaylist = snapshot.playlist.filter((item) => !requested.has(item.queueItemId));
        const removedCurrent =
          snapshot.currentQueueItemId !== null && requested.has(snapshot.currentQueueItemId);
        return {
          playlist: clonePlaylist(nextPlaylist),
          currentQueueItemId: removedCurrent ? null : snapshot.currentQueueItemId,
          playback: removedCurrent
            ? idlePlayback(snapshot.playback, this.#currentTimeMs())
            : clonePlayback(snapshot.playback),
        };
      }, options.signal);

      const survivingAssetIds = new Set(
        accepted.playlist.flatMap((item) =>
          item.source.kind === 'pro-r2' ? [item.source.assetId] : [],
        ),
      );
      for (const assetId of removedAssetIds) {
        if (!survivingAssetIds.has(assetId)) {
          await this.#bestEffortDelete(assetId, 'removed-unreferenced');
        }
      }
      return accepted;
    });
  }

  reorder(
    orderedQueueItemIds: readonly QueueItemId[],
    options: ProRoomPlaylistMutationOptions = {},
  ): Promise<ProRoomSnapshot> {
    const requested = [...orderedQueueItemIds];
    return this.#enqueue(async () => {
      if (
        requested.some((queueItemId) => !isProRoomQueueItemId(queueItemId)) ||
        new Set(requested).size !== requested.length ||
        (options.baseRevision !== undefined && !isSafeNonNegativeInteger(options.baseRevision))
      ) {
        throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_REORDER_INVALID');
      }

      assertNotAborted(options.signal);
      const local = this.#requireSnapshot();
      let refreshedPastBase = false;
      // The legacy queue revision is the room revision from the most recent
      // queue projection. Presence/checkpoint writes can legitimately move
      // the manager ahead without changing that projection, so only a manager
      // trailing the dragged view needs an eager refresh.
      if (options.baseRevision !== undefined && local.revision < options.baseRevision) {
        const refreshed = await this.#api.getSnapshot(this.#code, options.signal);
        const accepted = await this.#accept(refreshed);
        if (accepted.revision < options.baseRevision) {
          throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_CONFLICT_REFRESH_STALE');
        }
        refreshedPastBase = accepted.revision > options.baseRevision;
      }

      const requestedSet = new Set(requested);
      return this.#mutate((snapshot, isRebase) => {
        const currentIds = snapshot.playlist.map((item) => item.queueItemId);
        if (
          !isRebase &&
          !refreshedPastBase &&
          (currentIds.length !== requested.length ||
            currentIds.some((queueItemId) => !requestedSet.has(queueItemId)))
        ) {
          throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_REORDER_STALE');
        }

        const itemById = new Map(snapshot.playlist.map((item) => [item.queueItemId, item]));
        const nextPlaylist: ProRoomPlaylistWireItem[] = [];
        for (const queueItemId of requested) {
          const item = itemById.get(queueItemId);
          if (item) nextPlaylist.push(item);
        }
        for (const item of snapshot.playlist) {
          if (!requestedSet.has(item.queueItemId)) nextPlaylist.push(item);
        }
        return {
          playlist: clonePlaylist(nextPlaylist),
          currentQueueItemId: snapshot.currentQueueItemId,
          playback: clonePlayback(snapshot.playback),
        };
      }, options.signal);
    });
  }

  updateMetadata(
    queueItemId: QueueItemId,
    patch: UpdateProRoomPlaylistMetadataInput,
    options: ProRoomPlaylistMutationOptions = {},
  ): Promise<ProRoomSnapshot> {
    return this.#enqueue(() => {
      this.#validateQueueItemId(queueItemId);
      return this.#mutate((snapshot) => {
        const index = snapshot.playlist.findIndex((item) => item.queueItemId === queueItemId);
        if (index === -1) {
          throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_QUEUE_ITEM_NOT_FOUND');
        }
        const current = snapshot.playlist[index]!;
        const next: ProRoomPlaylistWireItem = {
          ...current,
          source: current.source,
          ...(patch.name === undefined ? {} : { name: patch.name }),
        };
        for (const field of ['title', 'artist', 'thumbnail'] as const) {
          const value = patch[field];
          if (value === undefined) continue;
          if (value === null) delete next[field];
          else next[field] = value;
        }
        const canonical = canonicalItem(next);
        if (jsonEqual(canonical, current)) return null;
        const playlist = clonePlaylist(snapshot.playlist);
        playlist[index] = canonical;
        return {
          playlist,
          currentQueueItemId: snapshot.currentQueueItemId,
          playback: clonePlayback(snapshot.playback),
        };
      }, options.signal);
    });
  }

  updatePlayback(
    input: UpdateProRoomPlaybackInput,
    options: ProRoomPlaylistMutationOptions = {},
  ): Promise<ProRoomSnapshot> {
    return this.#enqueue(() => {
      if (
        (input.state !== 'idle' && input.state !== 'playing' && input.state !== 'paused') ||
        !isFiniteNonNegative(input.positionSeconds) ||
        (input.updatedAtMs !== undefined && !isSafeNonNegativeInteger(input.updatedAtMs)) ||
        (input.coordinatorEpoch !== undefined &&
          !isSafeNonNegativeInteger(input.coordinatorEpoch)) ||
        (input.youtubeVideoId !== undefined &&
          input.youtubeVideoId !== null &&
          !/^[A-Za-z0-9_-]{11}$/.test(input.youtubeVideoId)) ||
        (input.youtubeSubIndex !== undefined &&
          input.youtubeSubIndex !== null &&
          !isSafeNonNegativeInteger(input.youtubeSubIndex))
      ) {
        throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_PLAYBACK_INVALID');
      }

      const positionSeconds = input.positionSeconds === 0 ? 0 : input.positionSeconds;
      if (input.state === 'idle') {
        if (input.queueItemId !== null || positionSeconds !== 0) {
          throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_PLAYBACK_IDLE_INVALID');
        }
      } else if (input.queueItemId === null || !isProRoomQueueItemId(input.queueItemId)) {
        throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_QUEUE_ITEM_ID_INVALID');
      }

      return this.#mutate((snapshot) => {
        const coordinatorEpoch = input.coordinatorEpoch ?? snapshot.presence.coordinatorEpoch;
        if (coordinatorEpoch !== snapshot.presence.coordinatorEpoch) {
          throw new ProRoomPlaylistStateError(
            'PRO_ROOM_PLAYLIST_PLAYBACK_COORDINATOR_EPOCH_MISMATCH',
          );
        }

        const currentQueueItemId = input.state === 'idle' ? null : input.queueItemId;
        const selectedItem =
          currentQueueItemId === null
            ? null
            : snapshot.playlist.find((item) => item.queueItemId === currentQueueItemId);
        if (currentQueueItemId !== null && !selectedItem) {
          throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_QUEUE_ITEM_NOT_FOUND');
        }

        let youtubeVideoId: string | null = null;
        let youtubeSubIndex: number | null = null;
        if (selectedItem?.source.kind === 'youtube') {
          youtubeVideoId =
            input.youtubeVideoId === undefined ? selectedItem.source.videoId : input.youtubeVideoId;
          youtubeSubIndex =
            input.youtubeSubIndex === undefined
              ? (selectedItem.source.videoIds?.indexOf(youtubeVideoId ?? '') ?? 0)
              : input.youtubeSubIndex;
          if (
            youtubeVideoId === null ||
            youtubeSubIndex === null ||
            !/^[A-Za-z0-9_-]{11}$/.test(youtubeVideoId) ||
            !isSafeNonNegativeInteger(youtubeSubIndex) ||
            (selectedItem.source.videoIds !== undefined &&
              selectedItem.source.videoIds[youtubeSubIndex] !== youtubeVideoId)
          ) {
            throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_PLAYBACK_YOUTUBE_INVALID');
          }
        } else if (input.youtubeVideoId != null || input.youtubeSubIndex != null) {
          throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_PLAYBACK_YOUTUBE_INVALID');
        }

        const semanticallyIdentical =
          snapshot.currentQueueItemId === currentQueueItemId &&
          snapshot.playback.coordinatorEpoch === coordinatorEpoch &&
          snapshot.playback.state === input.state &&
          snapshot.playback.queueItemId === currentQueueItemId &&
          snapshot.playback.positionSeconds === positionSeconds &&
          snapshot.playback.youtubeVideoId === youtubeVideoId &&
          snapshot.playback.youtubeSubIndex === youtubeSubIndex;
        if (semanticallyIdentical) return null;

        if (snapshot.playback.revision >= Number.MAX_SAFE_INTEGER) {
          throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_PLAYBACK_REVISION_EXHAUSTED');
        }
        const requestedUpdatedAtMs = input.updatedAtMs ?? this.#currentTimeMs();
        return {
          playlist: clonePlaylist(snapshot.playlist),
          currentQueueItemId,
          playback: {
            coordinatorEpoch,
            revision: snapshot.playback.revision + 1,
            state: input.state,
            queueItemId: currentQueueItemId,
            positionSeconds,
            youtubeVideoId,
            youtubeSubIndex,
            updatedAtMs: Math.max(snapshot.playback.updatedAtMs, requestedUpdatedAtMs),
          },
        };
      }, options.signal);
    });
  }

  async #appendCanonicalItem(
    item: ProRoomPlaylistWireItem,
    signal?: AbortSignal,
  ): Promise<ProRoomSnapshot> {
    let firstSelectionRequest: ProRoomFirstAppendSelectionRequest | null = null;
    const accepted = await this.#mutate((snapshot) => {
      // The intent may run again after a CAS refresh. Only the actor whose
      // rebased canonical view is still truly empty may request first-track
      // selection; a concurrent winner makes this null on the second pass.
      firstSelectionRequest = null;
      const existing = snapshot.playlist.find(
        (candidate) => candidate.queueItemId === item.queueItemId,
      );
      if (existing) {
        if (jsonEqual(existing, item)) return null;
        throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_QUEUE_ITEM_COLLISION');
      }
      this.#assertCapacity(snapshot, 1);
      const canSelectFirstItem =
        snapshot.playlist.length === 0 &&
        snapshot.currentQueueItemId === null &&
        snapshot.playback.state === 'idle';
      if (canSelectFirstItem) {
        firstSelectionRequest = {
          roomCode: snapshot.roomCode,
          queueItemId: item.queueItemId,
          coordinatorEpoch: snapshot.presence.coordinatorEpoch,
          basePlaybackRevision: snapshot.playback.revision,
          youtubeVideoId: item.source.kind === 'youtube' ? item.source.videoId : null,
          youtubeSubIndex:
            item.source.kind === 'youtube'
              ? (item.source.videoIds?.indexOf(item.source.videoId) ?? 0)
              : null,
        };
      }
      return {
        playlist: [...clonePlaylist(snapshot.playlist), canonicalItem(item)],
        // Queue mutations carry observations only. Selection/playback is
        // exclusively changed through the server playback command endpoint.
        currentQueueItemId: snapshot.currentQueueItemId,
        playback: clonePlayback(snapshot.playback),
      };
    }, signal);

    const request = firstSelectionRequest as ProRoomFirstAppendSelectionRequest | null;
    const firstItem = accepted.playlist[0];
    if (
      request &&
      this.#requestFirstAppendSelection &&
      firstItem?.queueItemId === item.queueItemId &&
      accepted.currentQueueItemId === null &&
      accepted.playback.state === 'idle' &&
      accepted.playback.queueItemId === null &&
      accepted.playback.revision === request.basePlaybackRevision &&
      accepted.presence.coordinatorEpoch === request.coordinatorEpoch
    ) {
      try {
        await this.#requestFirstAppendSelection(request, signal);
      } catch (error) {
        // The row (and, for files, its R2 asset reference) is already
        // canonical. A follow-up playback failure must never turn that
        // committed asset into an "uploaded orphan" cleanup candidate.
        try {
          await this.#reportFirstAppendSelectionError?.({ request, error });
        } catch {
          /* reporting is best effort */
        }
      }
    }
    return accepted;
  }

  async #mutate(intent: PlaylistIntent, signal?: AbortSignal): Promise<ProRoomSnapshot> {
    assertNotAborted(signal);
    const base = this.#requireSnapshot();
    const mutation = intent(base, false);
    if (!mutation || sameMutation(base, mutation)) return cloneSnapshot(base);

    const initialAttempt = await this.#attemptMutation(base, mutation, signal);
    if (initialAttempt.outcome === 'accepted') return initialAttempt.snapshot;

    assertNotAborted(signal);
    const refreshed = await this.#api.getSnapshot(this.#code, signal);
    const accepted = await this.#accept(refreshed);
    if (accepted.revision <= base.revision) {
      throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_CONFLICT_REFRESH_STALE');
    }
    const rebased = intent(accepted, true);
    if (!rebased || sameMutation(accepted, rebased)) return cloneSnapshot(accepted);
    const retry = await this.#attemptMutation(accepted, rebased, signal);
    if (retry.outcome === 'conflict') throw retry.error;
    return retry.snapshot;
  }

  async #attemptMutation(
    base: ProRoomSnapshot,
    mutation: PlaylistMutation,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationAttempt> {
    assertNotAborted(signal);
    if (mutation.playlist.length > PRO_ROOM_MAX_PLAYLIST_ITEMS) {
      throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_LIMIT_REACHED');
    }
    const idempotencyKey = this.#nextIdempotencyKey();
    let incoming: ProRoomSnapshot;
    try {
      if (this.#api.updateCompactSnapshot) {
        const baseById = new Map(base.playlist.map((item) => [item.queueItemId, item]));
        const baseOrder = base.playlist.map((item) => item.queueItemId);
        const nextOrder = mutation.playlist.map((item) => item.queueItemId);
        const compactInput: UpdateProRoomCompactSnapshotInput = {
          code: this.#code,
          baseRevision: base.revision,
          playlistOrder: jsonEqual(baseOrder, nextOrder) ? null : nextOrder,
          upserts: clonePlaylist(
            mutation.playlist.filter((item) => !jsonEqual(baseById.get(item.queueItemId), item)),
          ),
          currentQueueItemId: mutation.currentQueueItemId,
          playback: clonePlayback(mutation.playback),
          idempotencyKey,
        };
        try {
          incoming = await this.#api.updateCompactSnapshot(compactInput, signal);
        } catch (error) {
          // During a Worker-first rolling release the method is always
          // available. Retain one exact fallback for a cached new client that
          // briefly reaches the previous Worker version; no other failure may
          // be retried through the larger legacy request.
          if (!isCompactMutationUnavailable(error)) throw error;
          incoming = await this.#api.updateSnapshot(
            {
              code: this.#code,
              baseRevision: base.revision,
              playlist: clonePlaylist(mutation.playlist),
              currentQueueItemId: mutation.currentQueueItemId,
              playback: clonePlayback(mutation.playback),
              idempotencyKey,
            },
            signal,
          );
        }
      } else {
        const legacyInput: UpdateProRoomSnapshotInput = {
          code: this.#code,
          baseRevision: base.revision,
          playlist: clonePlaylist(mutation.playlist),
          currentQueueItemId: mutation.currentQueueItemId,
          playback: clonePlayback(mutation.playback),
          idempotencyKey,
        };
        incoming = await this.#api.updateSnapshot(legacyInput, signal);
      }
    } catch (error) {
      if (isRevisionConflict(error)) return { outcome: 'conflict', error };
      throw error;
    }
    return { outcome: 'accepted', snapshot: await this.#accept(incoming) };
  }

  async #accept(incoming: ProRoomSnapshot): Promise<ProRoomSnapshot> {
    const result = applyProRoomSnapshotMonotonically(this.#snapshot, incoming);
    if (
      result.outcome === 'invalid' ||
      result.outcome === 'stale' ||
      result.outcome === 'conflict'
    ) {
      throw new ProRoomPlaylistStateError(
        `PRO_ROOM_PLAYLIST_SNAPSHOT_${result.outcome.toUpperCase()}`,
      );
    }
    const accepted = result.snapshot;
    if (!accepted || accepted.roomCode !== this.#code) {
      throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_SNAPSHOT_MISMATCH');
    }
    if (result.outcome === 'duplicate') return cloneSnapshot(accepted);

    const projected = this.#projection.project(accepted.playlist);

    // Projection is part of accepting a snapshot, not a best-effort side
    // effect. Do not advance the manager clock until the sink has committed
    // the corresponding legacy view; otherwise a transient sink failure makes
    // the same authoritative snapshot look like a duplicate and it can never
    // be projected on retry.
    await this.#sink({ snapshot: cloneSnapshot(accepted), playlist: projected });
    this.#snapshot = accepted;
    return cloneSnapshot(accepted);
  }

  #requireSnapshot(): ProRoomSnapshot {
    if (!this.#snapshot) {
      throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_SESSION_INACTIVE');
    }
    return this.#snapshot;
  }

  #assertCapacity(snapshot: ProRoomSnapshot, additionalItems: number): void {
    if (snapshot.playlist.length + additionalItems > PRO_ROOM_MAX_PLAYLIST_ITEMS) {
      throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_LIMIT_REACHED');
    }
  }

  #nextQueueItemId(): QueueItemId {
    return this.#validateQueueItemId(this.#createQueueItemId());
  }

  #validateQueueItemId(queueItemId: QueueItemId): QueueItemId {
    if (!isProRoomQueueItemId(queueItemId)) {
      throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_QUEUE_ITEM_ID_INVALID');
    }
    return queueItemId;
  }

  #currentTimeMs(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_CLOCK_INVALID');
    }
    return now;
  }

  #nextIdempotencyKey(): string {
    const key = this.#createIdempotencyKey();
    if (typeof key !== 'string' || key.length === 0 || this.#issuedIdempotencyKeys.has(key)) {
      throw new ProRoomPlaylistStateError('PRO_ROOM_PLAYLIST_IDEMPOTENCY_KEY_REUSED');
    }
    this.#issuedIdempotencyKeys.add(key);
    return key;
  }

  async #bestEffortDelete(
    assetId: string,
    reason: ProRoomMediaCleanupErrorEvent['reason'],
  ): Promise<void> {
    try {
      await this.#mediaTransfer.deleteAsset({ code: this.#code, assetId });
    } catch (error) {
      try {
        await this.#reportMediaCleanupError?.({ reason, assetId, error });
      } catch {
        // Cleanup reporting is observational and must not replace the original
        // mutation result or failure.
      }
    }
  }

  #enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
