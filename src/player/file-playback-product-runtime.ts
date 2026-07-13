import {
  getFilePlaybackApplicationSessionManager,
  installFilePlaybackApplicationSessionHooks,
  snapshotFilePlaybackHostApplicationSessionAuthority,
  type FilePlaybackApplicationSessionHooks,
  type FilePlaybackHostApplicationSessionAuthority,
} from '../network/file-playback-application-session.ts';
import { getPrimedFilePlaybackProductAudio } from '../audio/file-playback-audio-readiness.ts';
import { isFilePlaybackSessionId } from '../network/file-playback-session-handshake.ts';
import type { DataConnection } from '../types/index.ts';
import {
  FilePlaybackApplicationController,
  type FilePlaybackApplicationControllerConnectionSnapshot,
  type FilePlaybackApplicationTimelineAdoptedEvent,
  type FilePlaybackApplicationTimelineUpdatedEvent,
} from './file-playback-application-controller.ts';
import { FilePlaybackAssetRegistry } from './file-playback-asset-registry.ts';
import { FilePlaybackManager } from './file-playback-manager.ts';
import { isFilePlaybackEngineV2Enabled } from './file-playback-engine-gate.ts';
import type {
  HostPeerPlaybackPublication,
  HostPeerRangeSource,
  HostRemoteRecoveryCommit,
  RecoverHostRemoteParticipantOptions,
  ResolveHostPeerRangeSourceOptions,
} from './file-playback-host-first-file-engine.ts';
import { FilePlaybackProductBaselineIdIssuer } from './file-playback-product-baseline-session.ts';
import {
  createFilePlaybackProductGuestMediaOwner,
  type FilePlaybackProductGuestMediaOwnerOptions,
} from './file-playback-product-guest-media-owner.ts';
import {
  FilePlaybackProductHostMediaOwner,
  type FilePlaybackProductHostHealthSystemMessage,
  type FilePlaybackProductHostMediaOwnerOptions,
} from './file-playback-product-host-media-owner.ts';
import {
  FilePlaybackProductHostRoom,
  type FilePlaybackProductHostCurrentOptions,
  type FilePlaybackProductHostFirstLocalFileCommit,
  type FilePlaybackProductHostLocalTrackCommit,
  type FilePlaybackProductHostRoomOptions,
  type FilePlaybackProductHostSeekOptions,
  type FilePlaybackProductHostTransitionCommit,
  type FilePlaybackProductHostTerminalObservation,
  type StartFilePlaybackProductHostFirstLocalFileOptions,
  type StartFilePlaybackProductHostLocalTrackOptions,
} from './file-playback-product-host-room.ts';
import { getFilePlaybackRoomClock } from './file-playback-room-clock.ts';
import { FilePlaybackR2WholeBlobPublisher } from './file-playback-r2-whole-blob-publisher.ts';
import {
  FilePlaybackProductSessionRouter,
  type FilePlaybackProductSessionRouterConnectionContext,
  type FilePlaybackProductSessionRouterGuestMediaOwnerPort,
  type FilePlaybackProductSessionRouterHostMediaOwnerPort,
  type FilePlaybackProductSessionRouterOptions,
  type FilePlaybackProductSessionRouterSnapshot,
} from './file-playback-product-session-router.ts';
import type { FilePlaybackPosition, FilePlaybackSourceSnapshot } from './file-playback-source.ts';
import { decodeOrdinaryAudio } from './ordinary-audio-decoder.ts';
import type { FilePlaybackWireLease } from './file-playback-wire-binding.ts';
import type {
  FilePlaybackWireMessageForKind,
  FilePlaybackWirePayloadByKind,
} from './file-playback-wire-sender.ts';
import {
  createStoppedPlaybackTimeline,
  type PlaybackTimelineSnapshot,
} from './playback-timeline.ts';

const DEFAULT_ENABLED = isFilePlaybackEngineV2Enabled();
// Peer-range streaming never materializes the full encoded FLAC in RAM. Keep
// its offer policy independent from the temporary 200 MiB whole-Blob R2 cap.
const FILE_PLAYBACK_PRODUCT_MAX_PEER_ENCODED_BYTES = 5 * 1024 * 1024 * 1024;

type RuntimeState = 'idle' | 'initializing' | 'ready' | 'failed';

export interface FilePlaybackProductRuntimeSessionAdapter {
  installHooks(hooks: Readonly<FilePlaybackApplicationSessionHooks>): void;
  beginHostRoom(hostParticipantId: string): Readonly<FilePlaybackHostApplicationSessionAuthority>;
  endRoom(): void;
  handleWake(connection?: DataConnection): boolean;
  nowRoomTimeMs(): number;
  sendRequired(connection: DataConnection, frame: unknown): boolean;
  sendWire<const Kind extends keyof FilePlaybackWirePayloadByKind>(
    connection: DataConnection,
    lease: FilePlaybackWireLease,
    payload: FilePlaybackWirePayloadByKind[Kind],
  ): FilePlaybackWireMessageForKind<Kind> | null;
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
  readonly onHostReady: (
    snapshot: Readonly<FilePlaybackApplicationControllerConnectionSnapshot>,
  ) => void;
  readonly onTimelineAdopted: (
    event: Readonly<FilePlaybackApplicationTimelineAdoptedEvent>,
  ) => void;
  readonly onTimelineUpdated: (
    event: Readonly<FilePlaybackApplicationTimelineUpdatedEvent>,
  ) => void;
}

interface FilePlaybackProductRuntimeSessionRouterPort {
  applicationSessionHooks(): Readonly<FilePlaybackApplicationSessionHooks>;
  notifyHostReady(snapshot: Readonly<FilePlaybackApplicationControllerConnectionSnapshot>): boolean;
  notifyTimelineAdopted(event: Readonly<FilePlaybackApplicationTimelineAdoptedEvent>): boolean;
  notifyTimelineUpdated(event: Readonly<FilePlaybackApplicationTimelineUpdatedEvent>): boolean;
  snapshot(): Readonly<FilePlaybackProductSessionRouterSnapshot>;
  close(): void;
}

interface FilePlaybackProductRuntimeMediaFactoriesForTests {
  readonly createSessionRouter?: (
    options: Readonly<FilePlaybackProductSessionRouterOptions>,
  ) => FilePlaybackProductRuntimeSessionRouterPort;
  readonly createHostPublisher?: (roomToken: object) => FilePlaybackR2WholeBlobPublisher;
  readonly createGuestRegistry?: (
    roomToken: object,
    onFatalRoom: (token: object, error: Error) => void,
  ) => FilePlaybackAssetRegistry;
  readonly createGuestManager?: () => FilePlaybackManager;
  readonly createHostMediaOwner?: (
    options: Readonly<FilePlaybackProductHostMediaOwnerOptions>,
  ) => FilePlaybackProductSessionRouterHostMediaOwnerPort;
  readonly createGuestMediaOwner?: (
    options: Readonly<FilePlaybackProductGuestMediaOwnerOptions>,
  ) => FilePlaybackProductSessionRouterGuestMediaOwnerPort;
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
  currentPeerPublication(): Readonly<HostPeerPlaybackPublication> | null;
  resolveCurrentPeerRangeSource(
    options: ResolveHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource>;
  recoverRemoteParticipant(
    options: RecoverHostRemoteParticipantOptions,
  ): Promise<Readonly<HostRemoteRecoveryCommit>>;
  close(): Promise<void>;
  currentRendererSnapshot(): FilePlaybackSourceSnapshot | null;
  currentTerminalRendererObservation(): FilePlaybackProductHostTerminalObservation | null;
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
  readonly onHealthSystemMessage?: (
    message: Readonly<FilePlaybackProductHostHealthSystemMessage>,
  ) => void;
  readonly mediaFactoriesForTests?: Readonly<FilePlaybackProductRuntimeMediaFactoriesForTests>;
}

interface ActiveProductHostRoom {
  readonly token: object;
  readonly roomGeneration: number;
  readonly port: FilePlaybackProductRuntimeHostRoomPort;
  readonly publisher: FilePlaybackR2WholeBlobPublisher;
}

interface ActiveProductGuestRoom {
  readonly token: object;
  readonly roomGeneration: number;
  readonly roomToken: object;
  readonly registry: FilePlaybackAssetRegistry;
  readonly manager: FilePlaybackManager;
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
    sendWire: <const Kind extends keyof FilePlaybackWirePayloadByKind>(
      connection: DataConnection,
      lease: FilePlaybackWireLease,
      payload: FilePlaybackWirePayloadByKind[Kind],
    ): FilePlaybackWireMessageForKind<Kind> | null =>
      manager().sendWire(connection, lease, payload),
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
    onHostReady: input.onHostReady,
    onTimelineAdopted: input.onTimelineAdopted,
    onTimelineUpdated: input.onTimelineUpdated,
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

function defaultSessionRouterFactory(
  options: Readonly<FilePlaybackProductSessionRouterOptions>,
): FilePlaybackProductRuntimeSessionRouterPort {
  return new FilePlaybackProductSessionRouter(options);
}

function defaultHostPublisherFactory(roomToken: object): FilePlaybackR2WholeBlobPublisher {
  return new FilePlaybackR2WholeBlobPublisher({ roomToken });
}

function defaultGuestRegistryFactory(
  roomToken: object,
  onFatalRoom: (token: object, error: Error) => void,
): FilePlaybackAssetRegistry {
  return new FilePlaybackAssetRegistry({ liveRoomToken: roomToken, onFatalRoom });
}

function defaultGuestManagerFactory(): FilePlaybackManager {
  return new FilePlaybackManager();
}

function defaultHostMediaOwnerFactory(
  options: Readonly<FilePlaybackProductHostMediaOwnerOptions>,
): FilePlaybackProductSessionRouterHostMediaOwnerPort {
  return new FilePlaybackProductHostMediaOwner(options).port();
}

function defaultGuestMediaOwnerFactory(
  options: Readonly<FilePlaybackProductGuestMediaOwnerOptions>,
): FilePlaybackProductSessionRouterGuestMediaOwnerPort {
  return createFilePlaybackProductGuestMediaOwner(options);
}

function defaultHealthSystemMessage(
  _message: Readonly<FilePlaybackProductHostHealthSystemMessage>,
) {
  // Product chat presentation is deliberately injected by app bootstrap.
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
    typeof value.sendWire !== 'function' ||
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
    typeof value.currentPeerPublication !== 'function' ||
    typeof value.resolveCurrentPeerRangeSource !== 'function' ||
    typeof value.recoverRemoteParticipant !== 'function' ||
    typeof value.close !== 'function' ||
    typeof value.currentRendererSnapshot !== 'function' ||
    typeof value.currentTerminalRendererObservation !== 'function' ||
    typeof value.positionAt !== 'function'
  ) {
    throw new TypeError('File playback product host room factory is invalid');
  }
}

function assertSessionRouterPort(
  value: FilePlaybackProductRuntimeSessionRouterPort,
): asserts value is FilePlaybackProductRuntimeSessionRouterPort {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.applicationSessionHooks !== 'function' ||
    typeof value.notifyHostReady !== 'function' ||
    typeof value.notifyTimelineAdopted !== 'function' ||
    typeof value.notifyTimelineUpdated !== 'function' ||
    typeof value.snapshot !== 'function' ||
    typeof value.close !== 'function'
  ) {
    throw new TypeError('File playback product session router factory is invalid');
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
  readonly #createSessionRouter: (
    options: Readonly<FilePlaybackProductSessionRouterOptions>,
  ) => FilePlaybackProductRuntimeSessionRouterPort;
  readonly #createHostPublisher: (roomToken: object) => FilePlaybackR2WholeBlobPublisher;
  readonly #createGuestRegistry: (
    roomToken: object,
    onFatalRoom: (token: object, error: Error) => void,
  ) => FilePlaybackAssetRegistry;
  readonly #createGuestManager: () => FilePlaybackManager;
  readonly #createHostMediaOwner: (
    options: Readonly<FilePlaybackProductHostMediaOwnerOptions>,
  ) => FilePlaybackProductSessionRouterHostMediaOwnerPort;
  readonly #createGuestMediaOwner: (
    options: Readonly<FilePlaybackProductGuestMediaOwnerOptions>,
  ) => FilePlaybackProductSessionRouterGuestMediaOwnerPort;
  readonly #onHealthSystemMessage: (
    message: Readonly<FilePlaybackProductHostHealthSystemMessage>,
  ) => void;
  #sessions: FilePlaybackProductRuntimeSessionAdapter | null = null;
  #controller: FilePlaybackApplicationController | null = null;
  #router: FilePlaybackProductRuntimeSessionRouterPort | null = null;
  #state: RuntimeState = 'idle';
  #failure: Error | null = null;
  #roomActive = false;
  #hostRoomSnapshot: Readonly<FilePlaybackProductHostRoomSnapshot> | null = null;
  #activeHostRoom: ActiveProductHostRoom | null = null;
  #activeGuestRoom: ActiveProductGuestRoom | null = null;
  readonly #connectionContexts = new Set<
    Readonly<FilePlaybackProductSessionRouterConnectionContext>
  >();
  #hostRoomRetirement: Promise<void> = Promise.resolve();

  constructor(options: FilePlaybackProductRuntimeOptions = {}) {
    if (
      typeof options !== 'object' ||
      options === null ||
      (options.enabled !== undefined && typeof options.enabled !== 'boolean') ||
      (options.createController !== undefined && typeof options.createController !== 'function') ||
      (options.nowMonotonicMs !== undefined && typeof options.nowMonotonicMs !== 'function') ||
      (options.createHostRoom !== undefined && typeof options.createHostRoom !== 'function') ||
      (options.onHealthSystemMessage !== undefined &&
        typeof options.onHealthSystemMessage !== 'function') ||
      (options.mediaFactoriesForTests !== undefined &&
        (options.mediaFactoriesForTests === null ||
          typeof options.mediaFactoriesForTests !== 'object' ||
          Array.isArray(options.mediaFactoriesForTests)))
    ) {
      throw new TypeError('File playback product runtime options are invalid');
    }
    const media = options.mediaFactoriesForTests ?? {};
    if (
      Object.values(media).some((factory) => factory !== undefined && typeof factory !== 'function')
    ) {
      throw new TypeError('File playback product runtime media factories are invalid');
    }
    if (options.sessions !== undefined) assertSessionAdapter(options.sessions);
    this.#enabled = options.enabled ?? DEFAULT_ENABLED;
    this.#providedSessions = options.sessions ?? null;
    this.#createController = options.createController ?? defaultControllerFactory;
    this.#nowMonotonicMs = options.nowMonotonicMs ?? defaultMonotonicNow;
    this.#createHostRoom = options.createHostRoom ?? defaultHostRoomFactory;
    this.#createSessionRouter = media.createSessionRouter ?? defaultSessionRouterFactory;
    this.#createHostPublisher = media.createHostPublisher ?? defaultHostPublisherFactory;
    this.#createGuestRegistry = media.createGuestRegistry ?? defaultGuestRegistryFactory;
    this.#createGuestManager = media.createGuestManager ?? defaultGuestManagerFactory;
    this.#createHostMediaOwner = media.createHostMediaOwner ?? defaultHostMediaOwnerFactory;
    this.#createGuestMediaOwner = media.createGuestMediaOwner ?? defaultGuestMediaOwnerFactory;
    this.#onHealthSystemMessage = options.onHealthSystemMessage ?? defaultHealthSystemMessage;
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
          onHostReady: (snapshot: Readonly<FilePlaybackApplicationControllerConnectionSnapshot>) =>
            this.#queueHostReadyNotification(snapshot),
          onTimelineAdopted: (event: Readonly<FilePlaybackApplicationTimelineAdoptedEvent>) =>
            this.#queueTimelineAdoptedNotification(event),
          onTimelineUpdated: (event: Readonly<FilePlaybackApplicationTimelineUpdatedEvent>) =>
            this.#queueTimelineUpdatedNotification(event),
        }),
      );
      if (!(controller instanceof FilePlaybackApplicationController)) {
        throw new TypeError('File playback product runtime controller factory is invalid');
      }
      this.#sessions = sessions;
      this.#controller = controller;
      this.#installFreshRouter(controller, sessions);
      this.#state = 'ready';
      return true;
    } catch (cause) {
      const error = asError(cause);
      try {
        this.#router?.close();
      } catch {
        // Initialization failure remains primary.
      }
      this.#router = null;
      this.#sessions = null;
      this.#controller = null;
      this.#roomActive = false;
      this.#hostRoomSnapshot = null;
      this.#activeHostRoom = null;
      this.#activeGuestRoom = null;
      this.#connectionContexts.clear();
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

  currentHostPeerPublication(): Readonly<HostPeerPlaybackPublication> | null {
    const active = this.#activeHostRoom;
    if (!this.#enabled || !active || !this.#ownsExactHostRoom(active)) return null;
    try {
      const publication = active.port.currentPeerPublication();
      return publication && this.#ownsExactHostRoom(active) ? publication : null;
    } catch {
      return null;
    }
  }

  resolveCurrentHostPeerRangeSource(
    options: ResolveHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource> {
    return this.#dispatchExactHostRoom('peer-range source resolution', (port) =>
      port.resolveCurrentPeerRangeSource(options),
    );
  }

  recoverHostRemoteParticipant(
    options: RecoverHostRemoteParticipantOptions,
  ): Promise<Readonly<HostRemoteRecoveryCommit>> {
    return this.#dispatchExactHostRoom('remote participant recovery', (port) =>
      port.recoverRemoteParticipant(options),
    );
  }

  currentHostRendererSnapshot(): FilePlaybackSourceSnapshot | null {
    const active = this.#activeHostRoom;
    if (!this.#enabled || !active || !this.#ownsExactHostRoom(active)) return null;
    return active.port.currentRendererSnapshot();
  }

  currentHostTerminalRendererObservation(): FilePlaybackProductHostTerminalObservation | null {
    const active = this.#activeHostRoom;
    if (!this.#enabled || !active || !this.#ownsExactHostRoom(active)) return null;
    try {
      const observation = active.port.currentTerminalRendererObservation();
      return observation &&
        this.#ownsExactHostRoom(active) &&
        this.#matchesCurrentHostTerminalObservation(observation) &&
        this.#ownsExactHostRoom(active)
        ? observation
        : null;
    } catch {
      return null;
    }
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
    this.#ensureRouter(controller, sessions);
    if (!isFilePlaybackSessionId(hostParticipantId)) {
      throw new TypeError('Host participant ID is invalid');
    }

    let candidate: FilePlaybackProductRuntimeHostRoomPort | null = null;
    let publisher: FilePlaybackR2WholeBlobPublisher | null = null;
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
      publisher = this.#createHostPublisher(token);
      if (
        !(publisher instanceof FilePlaybackR2WholeBlobPublisher) ||
        typeof publisher.close !== 'function'
      ) {
        throw new TypeError('File playback product host publisher factory is invalid');
      }
      this.#hostRoomSnapshot = hostRoomSnapshot;
      this.#activeHostRoom = Object.freeze({
        token,
        roomGeneration: claimed.roomGeneration,
        port: candidate,
        publisher,
      });
      this.#activeGuestRoom = null;
      published = true;
      this.#roomActive = true;
      return true;
    } catch (cause) {
      if (publisher) void publisher.close().catch(() => undefined);
      if (candidate) this.#retireHostRoomPort(candidate);
      this.#activeHostRoom = null;
      this.#activeGuestRoom = null;
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
    const { controller, sessions } = this.#requireReady();
    this.#assertCanBeginRoom();
    this.#ensureRouter(controller, sessions);
    this.#hostRoomSnapshot = null;
    this.#activeHostRoom = null;
    let registry: FilePlaybackAssetRegistry | null = null;
    let manager: FilePlaybackManager | null = null;
    const token = Object.freeze(Object.create(null) as object);
    const roomToken = Object.freeze(Object.create(null) as object);
    try {
      // Before the guest application handshake there is no shared room clock.
      // Zero is the only safe stopped baseline anchor: an arbitrary local
      // performance timestamp could survive an equal-revision replay and then
      // reject the host's lower room-clock anchors.
      controller.beginRoom(createStoppedPlaybackTimeline(0, 0));
      const claimed = controller.claimRoomRole('guest');
      if (
        claimed.roomRole !== 'guest' ||
        !Number.isSafeInteger(claimed.roomGeneration) ||
        claimed.roomGeneration <= 0
      ) {
        throw new Error('Guest controller room authority is invalid');
      }
      registry = this.#createGuestRegistry(roomToken, (fatalToken, error) => {
        if (fatalToken !== roomToken) return;
        queueMicrotask(() => this.#handleExactGuestRoomFatal(token, asError(error)));
      });
      manager = this.#createGuestManager();
      if (
        !(registry instanceof FilePlaybackAssetRegistry) ||
        !(manager instanceof FilePlaybackManager)
      ) {
        throw new TypeError('File playback product guest room factory is invalid');
      }
      this.#activeGuestRoom = Object.freeze({
        token,
        roomGeneration: claimed.roomGeneration,
        roomToken,
        registry,
        manager,
      });
      this.#roomActive = true;
      return true;
    } catch (cause) {
      if (manager) void manager.clear().catch(() => undefined);
      if (registry) void registry.close(roomToken).catch(() => undefined);
      this.#activeGuestRoom = null;
      try {
        controller.beginRoom(createStoppedPlaybackTimeline(0, 0));
      } catch {
        // Preserve the initiating guest-room failure.
      }
      this.#roomActive = false;
      throw cause;
    }
  }

  endRoom(): void {
    if (!this.#enabled) return;
    const { controller, sessions } = this.#requireReady();
    if (!this.#roomActive) {
      const orphan = this.#activeHostRoom;
      this.#activeHostRoom = null;
      if (orphan) {
        this.#retireHostRoomPort(orphan.port);
        void orphan.publisher.close().catch(() => undefined);
      }
      const guestOrphan = this.#activeGuestRoom;
      this.#activeGuestRoom = null;
      if (guestOrphan) this.#retireGuestRoom(guestOrphan);
      this.#hostRoomSnapshot = null;
      return;
    }

    const activeHostRoom = this.#activeHostRoom;
    this.#activeHostRoom = null;
    if (activeHostRoom) {
      this.#retireHostRoomPort(activeHostRoom.port);
    }
    const activeGuestRoom = this.#activeGuestRoom;
    this.#activeGuestRoom = null;
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
    // The application-session manager owns a document-lifetime, one-shot hook
    // installation. Its synchronous revoke callbacks empty this router's room
    // records; the router itself must survive for the next room generation.
    this.#connectionContexts.clear();
    if (activeHostRoom) void activeHostRoom.publisher.close().catch(() => undefined);
    if (activeGuestRoom) this.#retireGuestRoom(activeGuestRoom);
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
      this.#activeGuestRoom = null;
    }
    if (failed) throw failure;
  }

  handleWake(connection?: DataConnection): boolean {
    if (!this.#enabled || this.#state !== 'ready' || !this.#sessions) return false;
    return this.#sessions.handleWake(connection);
  }

  #installFreshRouter(
    controller: FilePlaybackApplicationController,
    sessions: FilePlaybackProductRuntimeSessionAdapter,
  ): void {
    if (this.#router) throw new Error('File playback product session router already exists');
    const hooks = controller.applicationSessionHooks();
    const controllerPort = Object.freeze({
      onLifecycleEvent: (event: Parameters<NonNullable<typeof hooks.onLifecycleEvent>>[0]) =>
        hooks.onLifecycleEvent?.(event),
      adoptAuxiliaryMessage: (
        event: Parameters<NonNullable<typeof hooks.adoptAuxiliaryMessage>>[0],
        acknowledge: () => void,
      ) => hooks.adoptAuxiliaryMessage?.(event, acknowledge),
    });
    const routerOptions: Readonly<FilePlaybackProductSessionRouterOptions> = Object.freeze({
      controller: controllerPort,
      createHostMediaOwner: (
        context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
      ) => this.#createExactHostMediaOwner(context),
      createGuestMediaOwner: (
        context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
      ) => this.#createExactGuestMediaOwner(context),
    });
    const router = this.#createSessionRouter(routerOptions);
    assertSessionRouterPort(router);
    this.#router = router;
    try {
      sessions.installHooks(router.applicationSessionHooks());
    } catch (cause) {
      this.#router = null;
      try {
        router.close();
      } catch {
        // Hook installation failure remains primary.
      }
      throw cause;
    }
  }

  #ensureRouter(
    controller: FilePlaybackApplicationController,
    sessions: FilePlaybackProductRuntimeSessionAdapter,
  ): void {
    if (this.#router) return;
    this.#installFreshRouter(controller, sessions);
  }

  #createExactHostMediaOwner(
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  ): FilePlaybackProductSessionRouterHostMediaOwnerPort {
    const active = this.#activeHostRoom;
    const sessions = this.#sessions;
    if (!active || !sessions || !this.#ownsExactHostRoom(active)) {
      throw new Error('File playback product host media room is unavailable');
    }
    this.#connectionContexts.add(context);
    try {
      const ownerOptions: Readonly<FilePlaybackProductHostMediaOwnerOptions> = Object.freeze({
        context,
        hostRoom: active.port,
        publisher: active.publisher,
        sendRequired: (connection: DataConnection, frame: unknown) =>
          sessions.sendRequired(connection, frame),
        sendWire: <Kind extends keyof FilePlaybackWirePayloadByKind>(
          connection: DataConnection,
          lease: FilePlaybackWireLease,
          payload: FilePlaybackWirePayloadByKind[Kind],
        ) => sessions.sendWire(connection, lease, payload),
        closeConnection: (connection: DataConnection) => sessions.closeConnection(connection),
        onHealthSystemMessage: (message: Readonly<FilePlaybackProductHostHealthSystemMessage>) =>
          this.#onHealthSystemMessage(message),
      });
      const owner = this.#createHostMediaOwner(ownerOptions);
      return Object.freeze({
        ...(owner.onHostReady
          ? {
              onHostReady: (
                snapshot: Readonly<FilePlaybackApplicationControllerConnectionSnapshot>,
              ) => owner.onHostReady?.(snapshot),
            }
          : {}),
        adoptWireMessage: (...args: Parameters<typeof owner.adoptWireMessage>) =>
          owner.adoptWireMessage(...args),
        adoptPeerRangeControl: (...args: Parameters<typeof owner.adoptPeerRangeControl>) =>
          owner.adoptPeerRangeControl(...args),
        revoke: (revokeContext: Readonly<FilePlaybackProductSessionRouterConnectionContext>) => {
          try {
            owner.revoke(revokeContext);
          } finally {
            this.#connectionContexts.delete(context);
          }
        },
      });
    } catch (cause) {
      this.#connectionContexts.delete(context);
      throw cause;
    }
  }

  #createExactGuestMediaOwner(
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  ): FilePlaybackProductSessionRouterGuestMediaOwnerPort {
    const active = this.#activeGuestRoom;
    const sessions = this.#sessions;
    if (!active || !sessions || !this.#ownsExactGuestRoom(active)) {
      throw new Error('File playback product guest media room is unavailable');
    }
    this.#connectionContexts.add(context);
    try {
      const ownerOptions: Readonly<FilePlaybackProductGuestMediaOwnerOptions> = Object.freeze({
        context,
        roomToken: active.roomToken,
        registry: active.registry,
        manager: active.manager,
        getAudioGraph: getPrimedFilePlaybackProductAudio,
        maxEncodedSize: FILE_PLAYBACK_PRODUCT_MAX_PEER_ENCODED_BYTES,
        decodeOrdinaryAudio,
        sendRequired: (
          ownerContext: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
          frame: unknown,
        ) =>
          this.#connectionContexts.has(ownerContext) &&
          ownerContext === context &&
          sessions.sendRequired(context.connection, frame),
        canSendPeerControl: (
          ownerContext: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
          frame: Parameters<FilePlaybackProductGuestMediaOwnerOptions['canSendPeerControl']>[1],
        ) =>
          this.#connectionContexts.has(ownerContext) &&
          ownerContext === context &&
          sessions.sendRequired(context.connection, frame),
        onFatalConnection: (
          ownerContext: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
        ) => {
          if (!this.#connectionContexts.has(ownerContext) || ownerContext !== context) return;
          try {
            sessions.closeConnection(context.connection);
          } catch {
            // The exact connection is already terminal.
          }
        },
      });
      const owner = this.#createGuestMediaOwner(ownerOptions);
      return Object.freeze({
        ...(owner.onTimelineAdopted
          ? {
              onTimelineAdopted: (event: Readonly<FilePlaybackApplicationTimelineAdoptedEvent>) =>
                owner.onTimelineAdopted?.(event),
            }
          : {}),
        ...(owner.onTimelineUpdated
          ? {
              onTimelineUpdated: (event: Readonly<FilePlaybackApplicationTimelineUpdatedEvent>) =>
                owner.onTimelineUpdated?.(event),
            }
          : {}),
        adoptAuxiliaryMessage: (...args: Parameters<typeof owner.adoptAuxiliaryMessage>) =>
          owner.adoptAuxiliaryMessage(...args),
        adoptWireMessage: (...args: Parameters<typeof owner.adoptWireMessage>) =>
          owner.adoptWireMessage(...args),
        adoptPeerRangeBulk: (...args: Parameters<typeof owner.adoptPeerRangeBulk>) =>
          owner.adoptPeerRangeBulk(...args),
        revoke: (revokeContext: Readonly<FilePlaybackProductSessionRouterConnectionContext>) => {
          try {
            owner.revoke(revokeContext);
          } finally {
            this.#connectionContexts.delete(context);
          }
        },
      });
    } catch (cause) {
      this.#connectionContexts.delete(context);
      throw cause;
    }
  }

  #queueHostReadyNotification(
    snapshot: Readonly<FilePlaybackApplicationControllerConnectionSnapshot>,
  ): void {
    const router = this.#router;
    if (!router) return;
    queueMicrotask(() => {
      if (
        this.#router !== router ||
        this.#controller?.snapshot().roomGeneration !== snapshot.roomGeneration
      ) {
        return;
      }
      const connection = this.#notificationConnection(snapshot.sessionId, snapshot.connectionId);
      try {
        router.notifyHostReady(snapshot);
      } catch {
        this.#closeNotificationConnection(connection);
      }
    });
  }

  #queueTimelineAdoptedNotification(
    event: Readonly<FilePlaybackApplicationTimelineAdoptedEvent>,
  ): void {
    const router = this.#router;
    if (!router) return;
    queueMicrotask(() => {
      if (
        this.#router !== router ||
        this.#controller?.snapshot().roomGeneration !== event.roomGeneration
      ) {
        return;
      }
      const connection = this.#notificationConnection(event.sessionId, event.connectionId);
      try {
        router.notifyTimelineAdopted(event);
      } catch {
        this.#closeNotificationConnection(connection);
      }
    });
  }

  #queueTimelineUpdatedNotification(
    event: Readonly<FilePlaybackApplicationTimelineUpdatedEvent>,
  ): void {
    const router = this.#router;
    const localRoomGeneration = this.#controller?.snapshot().roomGeneration;
    if (!router || localRoomGeneration === undefined) return;
    // The controller callback runs inside its adoption mutation. Defer router
    // delivery so an exact guest owner can start its own physical transition
    // without re-entering controller or router authority.
    queueMicrotask(() => {
      if (
        this.#router !== router ||
        this.#controller?.snapshot().roomGeneration !== localRoomGeneration
      ) {
        return;
      }
      const connection = this.#notificationConnection(event.sessionId, event.connectionId);
      try {
        router.notifyTimelineUpdated(event);
      } catch {
        this.#closeNotificationConnection(connection);
      }
    });
  }

  #notificationConnection(sessionId: string, connectionId: string): DataConnection | null {
    const matches = [...this.#connectionContexts].filter(
      (context) => context.sessionId === sessionId && context.connectionId === connectionId,
    );
    return matches.length === 1 ? matches[0]!.connection : null;
  }

  #closeNotificationConnection(connection: DataConnection | null): void {
    const sessions = this.#sessions;
    if (!sessions || !connection) return;
    try {
      sessions.closeConnection(connection);
    } catch {
      // The exact failed connection is already terminal.
    }
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

  #ownsExactGuestRoom(active: ActiveProductGuestRoom): boolean {
    try {
      const controller = this.#controller;
      if (!this.#roomActive || this.#activeGuestRoom !== active || !controller) return false;
      const snapshot = controller.snapshot();
      return snapshot.roomGeneration === active.roomGeneration && snapshot.roomRole === 'guest';
    } catch {
      return false;
    }
  }

  #matchesCurrentHostTerminalObservation(
    observation: FilePlaybackProductHostTerminalObservation,
  ): boolean {
    try {
      const controller = this.#controller;
      if (!controller) return false;
      const timeline = controller.timelineSnapshot();
      return (
        timeline.phase === 'playing' &&
        timeline.run !== null &&
        observation.phase === 'ended' &&
        observation.run !== null &&
        observation.queueItemId === timeline.run.queueItemId &&
        observation.run.queueItemId === timeline.run.queueItemId &&
        observation.run.runId === timeline.run.runId &&
        observation.revision === timeline.revision &&
        observation.run.revision === timeline.revision
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

  #handleExactGuestRoomFatal(token: object, _error: Error): void {
    if (this.#activeGuestRoom?.token !== token) return;
    try {
      this.endRoom();
    } catch {
      // The room, router, registry, and controller are fenced on every path.
    }
  }

  #retireGuestRoom(room: ActiveProductGuestRoom): void {
    const cleanup = Promise.allSettled([
      room.manager.clear(),
      room.registry.close(room.roomToken),
    ]).then(() => undefined);
    void cleanup.catch(() => undefined);
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
