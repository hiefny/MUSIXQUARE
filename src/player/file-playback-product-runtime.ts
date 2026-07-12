import {
  getFilePlaybackApplicationSessionManager,
  installFilePlaybackApplicationSessionHooks,
  snapshotFilePlaybackHostApplicationSessionAuthority,
  type FilePlaybackApplicationSessionHooks,
  type FilePlaybackHostApplicationSessionAuthority,
} from '../network/file-playback-application-session.ts';
import { isFilePlaybackSessionId } from '../network/file-playback-session-handshake.ts';
import type { DataConnection } from '../types/index.ts';
import { FilePlaybackApplicationController } from './file-playback-application-controller.ts';
import { isFilePlaybackEngineV2Enabled } from './file-playback-engine-gate.ts';
import { FilePlaybackProductBaselineIdIssuer } from './file-playback-product-baseline-session.ts';
import {
  FilePlaybackProductHostRoom,
  type FilePlaybackProductHostCurrentOptions,
  type FilePlaybackProductHostFirstLocalFileCommit,
  type FilePlaybackProductHostLocalTrackCommit,
  type FilePlaybackProductHostRoomOptions,
  type FilePlaybackProductHostSeekOptions,
  type FilePlaybackProductHostTransitionCommit,
  type StartFilePlaybackProductHostFirstLocalFileOptions,
  type StartFilePlaybackProductHostLocalTrackOptions,
} from './file-playback-product-host-room.ts';
import { getFilePlaybackRoomClock } from './file-playback-room-clock.ts';
import type { FilePlaybackPosition, FilePlaybackSourceSnapshot } from './file-playback-source.ts';
import {
  createStoppedPlaybackTimeline,
  type PlaybackTimelineSnapshot,
} from './playback-timeline.ts';

const DEFAULT_ENABLED = isFilePlaybackEngineV2Enabled();

type RuntimeState = 'idle' | 'initializing' | 'ready' | 'failed';

export interface FilePlaybackProductRuntimeSessionAdapter {
  installHooks(hooks: Readonly<FilePlaybackApplicationSessionHooks>): void;
  beginHostRoom(hostParticipantId: string): Readonly<FilePlaybackHostApplicationSessionAuthority>;
  endRoom(): void;
  handleWake(connection?: DataConnection): boolean;
  nowRoomTimeMs(): number;
  sendRequired(connection: DataConnection, frame: unknown): boolean;
  closeConnection(connection: DataConnection): void;
}

/** Body-free identity and ABA fence for the exact active product host room. */
export interface FilePlaybackProductHostRoomSnapshot {
  readonly schemaVersion: 1;
  readonly roomGeneration: number;
  readonly applicationSessionId: string;
  readonly hostParticipantId: string;
}

export interface FilePlaybackProductRuntimeControllerFactoryInput {
  readonly initialTimeline: PlaybackTimelineSnapshot;
  readonly sessions: FilePlaybackProductRuntimeSessionAdapter;
}

/** Narrow room capability retained by the product runtime. */
export interface FilePlaybackProductRuntimeHostRoomPort {
  startFirstLocalFile(
    options: StartFilePlaybackProductHostFirstLocalFileOptions,
  ): Promise<Readonly<FilePlaybackProductHostFirstLocalFileCommit>>;
  startLocalTrack(
    options: StartFilePlaybackProductHostLocalTrackOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>>;
  pauseCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>>;
  seekPlaying(
    options: FilePlaybackProductHostSeekOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>>;
  seekPaused(
    options: FilePlaybackProductHostSeekOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>>;
  resumeCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>>;
  replayCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>>;
  stopCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>>;
  settleEndedCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>>;
  close(): Promise<void>;
  currentRendererSnapshot(): FilePlaybackSourceSnapshot | null;
  positionAt(localPerformanceTimeMs: number): FilePlaybackPosition | null;
}

export interface FilePlaybackProductRuntimeOptions {
  /** Fixed for this facade's entire lifetime. It is never re-read at runtime. */
  readonly enabled?: boolean;
  readonly sessions?: FilePlaybackProductRuntimeSessionAdapter;
  readonly createController?: (
    input: Readonly<FilePlaybackProductRuntimeControllerFactoryInput>,
  ) => FilePlaybackApplicationController;
  readonly nowMonotonicMs?: () => number;
  readonly createHostRoom?: (
    options: Readonly<FilePlaybackProductHostRoomOptions>,
  ) => FilePlaybackProductRuntimeHostRoomPort;
}

interface ActiveProductHostRoom {
  readonly token: object;
  readonly roomGeneration: number;
  readonly port: FilePlaybackProductRuntimeHostRoomPort;
}

function productionSessionAdapter(): FilePlaybackProductRuntimeSessionAdapter {
  const manager = () => getFilePlaybackApplicationSessionManager();
  return Object.freeze({
    installHooks: (hooks: Readonly<FilePlaybackApplicationSessionHooks>) => {
      installFilePlaybackApplicationSessionHooks(hooks);
    },
    beginHostRoom: (hostParticipantId: string) => manager().beginHostRoom(hostParticipantId),
    endRoom: () => manager().endRoom(),
    handleWake: (connection?: DataConnection) => manager().handleWake(connection),
    nowRoomTimeMs: () => getFilePlaybackRoomClock().nowRoomTimeMs(),
    sendRequired: (connection: DataConnection, frame: unknown) =>
      manager().sendRequired(connection, frame),
    closeConnection: (connection: DataConnection) => manager().closeConnection(connection, true),
  });
}

function defaultControllerFactory(
  input: Readonly<FilePlaybackProductRuntimeControllerFactoryInput>,
): FilePlaybackApplicationController {
  return new FilePlaybackApplicationController({
    initialTimeline: input.initialTimeline,
    idIssuer: new FilePlaybackProductBaselineIdIssuer(),
    sendRequired: (connection, frame) => input.sessions.sendRequired(connection, frame),
    closeConnection: (connection) => input.sessions.closeConnection(connection),
  });
}

function defaultMonotonicNow(): number {
  return globalThis.performance?.now?.() ?? 0;
}

function defaultHostRoomFactory(
  options: Readonly<FilePlaybackProductHostRoomOptions>,
): FilePlaybackProductRuntimeHostRoomPort {
  return new FilePlaybackProductHostRoom(options);
}

function assertSessionAdapter(value: FilePlaybackProductRuntimeSessionAdapter): void {
  if (
    !value ||
    typeof value.installHooks !== 'function' ||
    typeof value.beginHostRoom !== 'function' ||
    typeof value.endRoom !== 'function' ||
    typeof value.handleWake !== 'function' ||
    typeof value.nowRoomTimeMs !== 'function' ||
    typeof value.sendRequired !== 'function' ||
    typeof value.closeConnection !== 'function'
  ) {
    throw new TypeError('File playback product runtime session adapter is invalid');
  }
}

function assertHostRoomPort(
  value: FilePlaybackProductRuntimeHostRoomPort,
): asserts value is FilePlaybackProductRuntimeHostRoomPort {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.startFirstLocalFile !== 'function' ||
    typeof value.startLocalTrack !== 'function' ||
    typeof value.pauseCurrent !== 'function' ||
    typeof value.seekPlaying !== 'function' ||
    typeof value.seekPaused !== 'function' ||
    typeof value.resumeCurrent !== 'function' ||
    typeof value.replayCurrent !== 'function' ||
    typeof value.stopCurrent !== 'function' ||
    typeof value.settleEndedCurrent !== 'function' ||
    typeof value.close !== 'function' ||
    typeof value.currentRendererSnapshot !== 'function' ||
    typeof value.positionAt !== 'function'
  ) {
    throw new TypeError('File playback product host room factory is invalid');
  }
}

function requireAnchor(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative monotonic time`);
  }
  return value;
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error('File playback product runtime failed', { cause: value });
}

/**
 * Gate-aware owner of the product controller and application-session hooks.
 *
 * `beginHostRoom()` and `beginGuestRoom()` are document-room transitions, not
 * transport reconnect operations. Call either exactly once for each genuine
 * new room. In particular, replacing a host-to-guest PeerJS connection must
 * not begin a new host room or advance the controller room generation.
 *
 * Product bootstrap must call `initializeBeforeProtocol()` before protocol
 * listeners can accept a connection. A selected V2 runtime fails closed; it
 * never changes its fixed gate or silently falls back to the legacy engine.
 */
export class FilePlaybackProductRuntime {
  readonly #enabled: boolean;
  readonly #providedSessions: FilePlaybackProductRuntimeSessionAdapter | null;
  readonly #createController: (
    input: Readonly<FilePlaybackProductRuntimeControllerFactoryInput>,
  ) => FilePlaybackApplicationController;
  readonly #nowMonotonicMs: () => number;
  readonly #createHostRoom: (
    options: Readonly<FilePlaybackProductHostRoomOptions>,
  ) => FilePlaybackProductRuntimeHostRoomPort;
  #sessions: FilePlaybackProductRuntimeSessionAdapter | null = null;
  #controller: FilePlaybackApplicationController | null = null;
  #state: RuntimeState = 'idle';
  #failure: Error | null = null;
  #roomActive = false;
  #hostRoomSnapshot: Readonly<FilePlaybackProductHostRoomSnapshot> | null = null;
  #activeHostRoom: ActiveProductHostRoom | null = null;
  #hostRoomRetirement: Promise<void> = Promise.resolve();

  constructor(options: FilePlaybackProductRuntimeOptions = {}) {
    if (
      typeof options !== 'object' ||
      options === null ||
      (options.enabled !== undefined && typeof options.enabled !== 'boolean') ||
      (options.createController !== undefined && typeof options.createController !== 'function') ||
      (options.nowMonotonicMs !== undefined && typeof options.nowMonotonicMs !== 'function') ||
      (options.createHostRoom !== undefined && typeof options.createHostRoom !== 'function')
    ) {
      throw new TypeError('File playback product runtime options are invalid');
    }
    if (options.sessions !== undefined) assertSessionAdapter(options.sessions);
    this.#enabled = options.enabled ?? DEFAULT_ENABLED;
    this.#providedSessions = options.sessions ?? null;
    this.#createController = options.createController ?? defaultControllerFactory;
    this.#nowMonotonicMs = options.nowMonotonicMs ?? defaultMonotonicNow;
    this.#createHostRoom = options.createHostRoom ?? defaultHostRoomFactory;
  }

  enabled(): boolean {
    return this.#enabled;
  }

  /** Returns false only when the facade was permanently constructed gate-off. */
  initializeBeforeProtocol(): boolean {
    if (!this.#enabled) return false;
    if (this.#state === 'ready') return true;
    if (this.#state === 'failed') throw this.#failure;
    if (this.#state === 'initializing') {
      const error = new Error('File playback product runtime initialization re-entry');
      this.#state = 'failed';
      this.#failure = error;
      throw error;
    }

    this.#state = 'initializing';
    try {
      const sessions = this.#providedSessions ?? productionSessionAdapter();
      assertSessionAdapter(sessions);
      const controller = this.#createController(
        Object.freeze({
          initialTimeline: createStoppedPlaybackTimeline(
            requireAnchor(this.#nowMonotonicMs(), 'Initial playback anchor'),
            0,
          ),
          sessions,
        }),
      );
      if (!(controller instanceof FilePlaybackApplicationController)) {
        throw new TypeError('File playback product runtime controller factory is invalid');
      }
      sessions.installHooks(controller.applicationSessionHooks());
      this.#sessions = sessions;
      this.#controller = controller;
      this.#state = 'ready';
      return true;
    } catch (cause) {
      const error = asError(cause);
      this.#sessions = null;
      this.#controller = null;
      this.#roomActive = false;
      this.#hostRoomSnapshot = null;
      this.#activeHostRoom = null;
      this.#state = 'failed';
      this.#failure = error;
      throw error;
    }
  }

  /** Gate-off returns null; selected V2 must have initialized successfully. */
  controller(): FilePlaybackApplicationController | null {
    if (!this.#enabled) return null;
    return this.#requireReady().controller;
  }

  /** Gate-off, guest, ended, and failed room generations return null. */
  hostRoomSnapshot(): Readonly<FilePlaybackProductHostRoomSnapshot> | null {
    return this.#enabled ? this.#hostRoomSnapshot : null;
  }

  /** Compatibility alias retained while the first product callsite migrates. */
  async startHostFirstLocalFile(
    options: StartFilePlaybackProductHostFirstLocalFileOptions,
  ): Promise<Readonly<FilePlaybackProductHostFirstLocalFileCommit>> {
    return this.#dispatchExactHostRoom('first local file start', (port) =>
      port.startFirstLocalFile(options),
    );
  }

  startLocalTrack(
    options: StartFilePlaybackProductHostLocalTrackOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    return this.#dispatchExactHostRoom('local track start', (port) =>
      port.startLocalTrack(options),
    );
  }

  pauseCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>> {
    return this.#dispatchExactHostRoom('pause', (port) => port.pauseCurrent(options));
  }

  seekPlaying(
    options: FilePlaybackProductHostSeekOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    return this.#dispatchExactHostRoom('playing seek', (port) => port.seekPlaying(options));
  }

  seekPaused(
    options: FilePlaybackProductHostSeekOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>> {
    return this.#dispatchExactHostRoom('paused seek', (port) => port.seekPaused(options));
  }

  resumeCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    return this.#dispatchExactHostRoom('resume', (port) => port.resumeCurrent(options));
  }

  replayCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostLocalTrackCommit>> {
    return this.#dispatchExactHostRoom('replay', (port) => port.replayCurrent(options));
  }

  stopCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>> {
    return this.#dispatchExactHostRoom('stop', (port) => port.stopCurrent(options));
  }

  settleEndedCurrent(
    options: FilePlaybackProductHostCurrentOptions,
  ): Promise<Readonly<FilePlaybackProductHostTransitionCommit>> {
    return this.#dispatchExactHostRoom('ended settlement', (port) =>
      port.settleEndedCurrent(options),
    );
  }

  currentHostRendererSnapshot(): FilePlaybackSourceSnapshot | null {
    const active = this.#activeHostRoom;
    if (!this.#enabled || !active || !this.#ownsExactHostRoom(active)) return null;
    return active.port.currentRendererSnapshot();
  }

  hostPositionAt(localPerformanceTimeMs: number): FilePlaybackPosition | null {
    const active = this.#activeHostRoom;
    if (!this.#enabled || !active || !this.#ownsExactHostRoom(active)) return null;
    return active.port.positionAt(localPerformanceTimeMs);
  }

  beginHostRoom(hostParticipantId: string): boolean {
    if (!this.#enabled) return false;
    const { controller, sessions } = this.#requireReady();
    this.#assertCanBeginRoom();
    if (!isFilePlaybackSessionId(hostParticipantId)) {
      throw new TypeError('Host participant ID is invalid');
    }

    let candidate: FilePlaybackProductRuntimeHostRoomPort | null = null;
    try {
      const authority = snapshotFilePlaybackHostApplicationSessionAuthority(
        sessions.beginHostRoom(hostParticipantId),
      );
      if (!authority || authority.hostParticipantId !== hostParticipantId) {
        throw new TypeError('Host application-session authority is invalid');
      }
      const anchor = requireAnchor(sessions.nowRoomTimeMs(), 'Host room playback anchor');
      controller.beginRoom(createStoppedPlaybackTimeline(anchor, 0));
      const claimed = controller.claimRoomRole('host');
      if (
        claimed.roomRole !== 'host' ||
        !Number.isSafeInteger(claimed.roomGeneration) ||
        claimed.roomGeneration <= 0
      ) {
        throw new Error('Host controller room authority is invalid');
      }
      const hostRoomSnapshot = Object.freeze({
        schemaVersion: 1 as const,
        roomGeneration: claimed.roomGeneration,
        applicationSessionId: authority.applicationSessionId,
        hostParticipantId: authority.hostParticipantId,
      });
      const token = Object.freeze(Object.create(null) as object);
      let pendingFatal: Error | null = null;
      let published = false;
      candidate = this.#createHostRoom(
        Object.freeze({
          controller,
          hostRoomSnapshot,
          onFatalRoom: (value: Error) => {
            const error = asError(value);
            if (this.#activeHostRoom?.token === token) {
              this.#handleExactHostRoomFatal(token, error);
            } else if (!published) {
              pendingFatal = error;
            }
          },
        }),
      );
      assertHostRoomPort(candidate);
      if (pendingFatal) throw pendingFatal;
      this.#hostRoomSnapshot = hostRoomSnapshot;
      this.#activeHostRoom = Object.freeze({
        token,
        roomGeneration: claimed.roomGeneration,
        port: candidate,
      });
      published = true;
      this.#roomActive = true;
      return true;
    } catch (cause) {
      if (candidate) this.#retireHostRoomPort(candidate);
      this.#activeHostRoom = null;
      this.#hostRoomSnapshot = null;
      try {
        sessions.endRoom();
      } catch {
        // Preserve the original room-start failure while still attempting the
        // required fail-close cleanup.
      }
      try {
        controller.beginRoom(createStoppedPlaybackTimeline(0, 0));
      } catch {
        // A cleanup failure must not replace the initiating room-start error.
      }
      this.#roomActive = false;
      throw cause;
    }
  }

  beginGuestRoom(): boolean {
    if (!this.#enabled) return false;
    const { controller } = this.#requireReady();
    this.#assertCanBeginRoom();
    this.#hostRoomSnapshot = null;
    this.#activeHostRoom = null;
    // Before the guest application handshake there is no shared room clock.
    // Zero is the only safe stopped baseline anchor: an arbitrary local
    // performance timestamp could survive an equal-revision replay and then
    // reject the host's lower room-clock anchors.
    controller.beginRoom(createStoppedPlaybackTimeline(0, 0));
    controller.claimRoomRole('guest');
    this.#roomActive = true;
    return true;
  }

  endRoom(): void {
    if (!this.#enabled) return;
    const { controller, sessions } = this.#requireReady();
    if (!this.#roomActive) {
      const orphan = this.#activeHostRoom;
      this.#activeHostRoom = null;
      if (orphan) this.#retireHostRoomPort(orphan.port);
      this.#hostRoomSnapshot = null;
      return;
    }

    const activeHostRoom = this.#activeHostRoom;
    this.#activeHostRoom = null;
    if (activeHostRoom) this.#retireHostRoomPort(activeHostRoom.port);
    // Clear public host identity before any synchronous teardown callback can
    // observe a room whose manager authority is already being revoked.
    this.#hostRoomSnapshot = null;

    let failure: unknown;
    let failed = false;
    try {
      // Revocation hooks must observe the still-current controller generation.
      sessions.endRoom();
    } catch (cause) {
      failure = cause;
      failed = true;
    }
    try {
      controller.beginRoom(createStoppedPlaybackTimeline(0, 0));
    } catch (cause) {
      if (!failed) {
        failure = cause;
        failed = true;
      }
    } finally {
      this.#roomActive = false;
      this.#hostRoomSnapshot = null;
      this.#activeHostRoom = null;
    }
    if (failed) throw failure;
  }

  handleWake(connection?: DataConnection): boolean {
    if (!this.#enabled || this.#state !== 'ready' || !this.#sessions) return false;
    return this.#sessions.handleWake(connection);
  }

  /**
   * Dispatches one renderer operation only after the previous-room native
   * cleanup barrier and an exact ABA-resistant host-room ownership check.
   */
  async #dispatchExactHostRoom<T>(
    label: string,
    dispatch: (port: FilePlaybackProductRuntimeHostRoomPort) => Promise<T>,
  ): Promise<T> {
    if (!this.#enabled) throw new Error('File playback product runtime is disabled');
    this.#requireReady();
    const active = this.#activeHostRoom;
    if (!active) throw new Error('File playback product host room is unavailable');
    const retirement = this.#hostRoomRetirement;
    try {
      await retirement;
    } catch (cause) {
      if (this.#activeHostRoom === active) {
        try {
          this.endRoom();
        } catch {
          // The renderer cleanup failure remains the primary media failure.
        }
      }
      throw asError(cause);
    }
    if (this.#hostRoomRetirement !== retirement || !this.#ownsExactHostRoom(active)) {
      throw new Error(`File playback product host room changed before ${label}`);
    }
    return dispatch(active.port);
  }

  #ownsExactHostRoom(active: ActiveProductHostRoom): boolean {
    try {
      const hostRoom = this.#hostRoomSnapshot;
      const controller = this.#controller;
      if (
        !this.#roomActive ||
        this.#activeHostRoom !== active ||
        !hostRoom ||
        !controller ||
        hostRoom.roomGeneration !== active.roomGeneration
      ) {
        return false;
      }
      const snapshot = controller.snapshot();
      return (
        snapshot.roomGeneration === active.roomGeneration &&
        snapshot.roomRole === 'host' &&
        snapshot.timeline === controller.timelineSnapshot()
      );
    } catch {
      return false;
    }
  }

  #handleExactHostRoomFatal(token: object, _error: Error): void {
    if (this.#activeHostRoom?.token !== token) return;
    try {
      this.endRoom();
    } catch {
      // The room and controller are fenced even when teardown reports an error.
    }
  }

  #retireHostRoomPort(port: FilePlaybackProductRuntimeHostRoomPort): void {
    let cleanup: Promise<void>;
    try {
      cleanup = Promise.resolve(port.close());
    } catch (cause) {
      cleanup = Promise.reject(cause);
    }
    const previous = this.#hostRoomRetirement;
    const retirement = Promise.allSettled([previous, cleanup]).then((settlements) => {
      const failures = settlements
        .filter(
          (settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected',
        )
        .map((settlement) => settlement.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Multiple product host room cleanup operations failed');
      }
    });
    this.#hostRoomRetirement = retirement;
    void retirement.catch(() => undefined);
  }

  #assertCanBeginRoom(): void {
    if (this.#roomActive) {
      throw new Error('File playback product runtime already owns an active room');
    }
  }

  #requireReady(): {
    readonly controller: FilePlaybackApplicationController;
    readonly sessions: FilePlaybackProductRuntimeSessionAdapter;
  } {
    if (this.#state === 'failed') throw this.#failure;
    if (this.#state !== 'ready' || !this.#controller || !this.#sessions) {
      throw new Error('File playback product runtime was not initialized before protocol');
    }
    return { controller: this.#controller, sessions: this.#sessions };
  }
}

const filePlaybackProductRuntime = new FilePlaybackProductRuntime();

export function getFilePlaybackProductRuntime(): FilePlaybackProductRuntime {
  return filePlaybackProductRuntime;
}
