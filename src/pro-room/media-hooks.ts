import type { PlaylistItem, PlaylistRevision, QueueItemId } from '../types/index.ts';

export interface ProRoomMediaHooks {
  addFiles(files: readonly File[], rejectedCount: number): boolean;
  addYouTube(item: PlaylistItem, sourceUrl: string, videoIds?: readonly string[]): boolean;
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
  /**
   * Warm one immutable PRO asset into this participant's RAM cache without
   * entering the foreground playback lifecycle or opening the global loader.
   * A later resolveFile() for the same queue occurrence adopts this exact
   * promise instead of restarting the R2 request.
   */
  preloadFile?(queueItemId: QueueItemId): Promise<File | null> | null;
  /** Verify that completed preload metadata still has resident cache bytes. */
  hasPreloadedFile?(queueItemId: QueueItemId): boolean;
  /** Cancel the background lane, optionally only when it owns this target. */
  cancelPreload?(queueItemId?: QueueItemId): void;
  handlesPersistentFile?(queueItemId: QueueItemId): boolean;
  cancelFileResolution?(): void;
}

const proRoomMediaHookSessionBrand: unique symbol = Symbol('pro-room-media-hook-session');
const proRoomMediaHookRenewalBrand: unique symbol = Symbol('pro-room-media-hook-renewal');

/**
 * Opaque ownership lease for one installed PRO media-hook generation.
 *
 * Async player work captures this lease before it starts. Replacing or
 * removing the runtime hooks aborts the lease, and completion helpers validate
 * the exact captured generation before invoking its hook.
 */
export interface ProRoomMediaHookSession {
  readonly signal: AbortSignal;
  readonly [proRoomMediaHookSessionBrand]: true;
}

interface ActiveProRoomMediaHookSession extends ProRoomMediaHookSession {
  readonly generation: number;
  readonly controller: AbortController;
  readonly hooks: ProRoomMediaHooks;
}

/**
 * Exact authority-transition handle returned when an installed hook session
 * is invalidated. Only the latest handle may reactivate the preserved hook
 * implementation after its matching canonical account snapshot commits.
 */
interface ProRoomMediaHookRenewal {
  readonly generation: number;
  readonly [proRoomMediaHookRenewalBrand]: true;
}

type ProRoomDirectFileHandler = (
  file: File,
  queueItemId: QueueItemId,
  sessionId: number,
) => Promise<void>;

let proRoomMediaHookGeneration = 0;
let activeMediaHookSession: ActiveProRoomMediaHookSession | null = null;
let registeredMediaHooks: ProRoomMediaHooks | null = null;
let pendingMediaHookRenewal: ProRoomMediaHookRenewal | null = null;
let activeDirectFileHandler: ProRoomDirectFileHandler | null = null;

function abortActiveMediaHookSession(): void {
  const session = activeMediaHookSession;
  activeMediaHookSession = null;
  session?.controller.abort();
}

function installRegisteredMediaHookSession(): ActiveProRoomMediaHookSession | null {
  const hooks = registeredMediaHooks;
  if (!hooks) return null;
  const controller = new AbortController();
  const session: ActiveProRoomMediaHookSession = {
    [proRoomMediaHookSessionBrand]: true,
    generation: ++proRoomMediaHookGeneration,
    controller,
    signal: controller.signal,
    hooks,
  };
  activeMediaHookSession = session;
  return session;
}

/**
 * Late-bound seam between the player graph and the persistent PRO
 * runtime. Keeping the seam data-only avoids importing the networking graph
 * back into playlist/decode modules during application bootstrap.
 */
export function registerProRoomMediaHooks(hooks: ProRoomMediaHooks | null): void {
  // Clear preserved ownership before abort listeners run. A completion from
  // the retired runtime must not renew either the old implementation or a
  // replacement that has not been installed yet.
  registeredMediaHooks = null;
  pendingMediaHookRenewal = null;
  abortActiveMediaHookSession();
  registeredMediaHooks = hooks;
  installRegisteredMediaHookSession();
}

/**
 * Revoke the current account-bound hook generation without destroying the
 * room runtime's hook implementation. Capture and every global handler fail
 * closed until the exact returned transition is renewed.
 */
export function invalidateProRoomMediaHookSession(): ProRoomMediaHookRenewal | null {
  pendingMediaHookRenewal = null;
  abortActiveMediaHookSession();
  if (!registeredMediaHooks) return null;
  const renewal: ProRoomMediaHookRenewal = {
    [proRoomMediaHookRenewalBrand]: true,
    generation: ++proRoomMediaHookGeneration,
  };
  pendingMediaHookRenewal = renewal;
  return renewal;
}

/**
 * Install a fresh opaque hook generation after the matching authoritative
 * account snapshot commits. Stale/superseded transitions cannot renew the
 * preserved implementation or disturb a newer active session.
 */
export function renewProRoomMediaHookSession(renewal: ProRoomMediaHookRenewal | null): boolean {
  if (!renewal || pendingMediaHookRenewal !== renewal || !registeredMediaHooks) return false;
  pendingMediaHookRenewal = null;
  return installRegisteredMediaHookSession() !== null;
}

/** Capture the exact currently installed hook generation for async work. */
export function captureProRoomMediaHookSession(): ProRoomMediaHookSession | null {
  return activeMediaHookSession;
}

/** True only while this exact hook generation remains installed. */
export function isProRoomMediaHookSessionCurrent(session: ProRoomMediaHookSession): boolean {
  const active = activeMediaHookSession;
  const captured = session as ActiveProRoomMediaHookSession;
  return !!(
    active &&
    active === captured &&
    active.generation === captured.generation &&
    !captured.signal.aborted
  );
}

export function handleProRoomFiles(files: readonly File[], rejectedCount = 0): boolean {
  return activeMediaHookSession?.hooks.addFiles(files, rejectedCount) ?? false;
}

/**
 * Invoke only the hook captured by this exact session. A stale completion must
 * never fall through to the newly installed global hook.
 */
export function handleProRoomYouTubeForSession(
  session: ProRoomMediaHookSession,
  item: PlaylistItem,
  sourceUrl: string,
  videoIds?: readonly string[],
): boolean {
  if (!isProRoomMediaHookSessionCurrent(session)) return false;
  return (session as ActiveProRoomMediaHookSession).hooks.addYouTube(item, sourceUrl, videoIds);
}

export function handleProRoomTrackMetadata(
  queueItemId: QueueItemId,
  metadata: Pick<PlaylistItem, 'name' | 'title' | 'artist' | 'thumbnail'>,
): boolean {
  return activeMediaHookSession?.hooks.updateTrackMetadata(queueItemId, metadata) ?? false;
}

/** Session-owned counterpart for metadata work spawned by an async add. */
export function handleProRoomTrackMetadataForSession(
  session: ProRoomMediaHookSession,
  queueItemId: QueueItemId,
  metadata: Pick<PlaylistItem, 'name' | 'title' | 'artist' | 'thumbnail'>,
): boolean {
  if (!isProRoomMediaHookSessionCurrent(session)) return false;
  return (session as ActiveProRoomMediaHookSession).hooks.updateTrackMetadata(
    queueItemId,
    metadata,
  );
}

export function handleProRoomTrackRemoval(queueItemIds: readonly QueueItemId[]): boolean {
  return activeMediaHookSession?.hooks.removeTracks(queueItemIds) ?? false;
}

export function handleProRoomTrackReorder(
  queueItemId: QueueItemId,
  beforeQueueItemId: QueueItemId | null,
  baseRevision: PlaylistRevision,
): boolean {
  return (
    activeMediaHookSession?.hooks.reorderTrack(queueItemId, beforeQueueItemId, baseRevision) ??
    false
  );
}

export function resolveProRoomPlaylistFile(queueItemId: QueueItemId): Promise<File | null> | null {
  return activeMediaHookSession?.hooks.resolveFile(queueItemId) ?? null;
}

export function preloadProRoomPlaylistFile(queueItemId: QueueItemId): Promise<File | null> | null {
  return activeMediaHookSession?.hooks.preloadFile?.(queueItemId) ?? null;
}

export function hasProRoomPlaylistFilePreload(queueItemId: QueueItemId): boolean {
  return activeMediaHookSession?.hooks.hasPreloadedFile?.(queueItemId) ?? false;
}

export function cancelProRoomPlaylistFilePreload(queueItemId?: QueueItemId): void {
  activeMediaHookSession?.hooks.cancelPreload?.(queueItemId);
}

/**
 * True only while the active room owns this queue occurrence as persistent
 * PRO media. Callers use this as a routing decision; the runtime still
 * resolves and validates the canonical R2 source before returning any bytes.
 */
export function isProRoomPersistentPlaylistFile(queueItemId: QueueItemId): boolean {
  return activeMediaHookSession?.hooks.handlesPersistentFile?.(queueItemId) ?? false;
}

export function cancelProRoomPlaylistFileResolution(): void {
  activeMediaHookSession?.hooks.cancelFileResolution?.();
}

export function registerProRoomDirectFileHandler(handler: ProRoomDirectFileHandler | null): void {
  activeDirectFileHandler = handler;
}

export function finalizeProRoomDirectFile(
  file: File,
  queueItemId: QueueItemId,
  sessionId: number,
): Promise<void> {
  return activeDirectFileHandler?.(file, queueItemId, sessionId) ?? Promise.resolve();
}
