import {
  getFilePlaybackApplicationSessionManager,
  installFilePlaybackApplicationSessionHooks,
  type FilePlaybackApplicationSessionHooks,
} from '../network/file-playback-application-session.ts';
import type { DataConnection } from '../types/index.ts';
import { FilePlaybackApplicationController } from './file-playback-application-controller.ts';
import { isFilePlaybackEngineV2Enabled } from './file-playback-engine-gate.ts';
import { FilePlaybackProductBaselineIdIssuer } from './file-playback-product-baseline-session.ts';
import { getFilePlaybackRoomClock } from './file-playback-room-clock.ts';
import {
  createStoppedPlaybackTimeline,
  type PlaybackTimelineSnapshot,
} from './playback-timeline.ts';

const DEFAULT_ENABLED = isFilePlaybackEngineV2Enabled();

type RuntimeState = 'idle' | 'initializing' | 'ready' | 'failed';

export interface FilePlaybackProductRuntimeSessionAdapter {
  installHooks(hooks: Readonly<FilePlaybackApplicationSessionHooks>): void;
  beginHostRoom(hostParticipantId: string): void;
  endRoom(): void;
  handleWake(connection?: DataConnection): boolean;
  nowRoomTimeMs(): number;
  sendRequired(connection: DataConnection, frame: unknown): boolean;
  closeConnection(connection: DataConnection): void;
}

export interface FilePlaybackProductRuntimeControllerFactoryInput {
  readonly initialTimeline: PlaybackTimelineSnapshot;
  readonly sessions: FilePlaybackProductRuntimeSessionAdapter;
}

export interface FilePlaybackProductRuntimeOptions {
  /** Fixed for this facade's entire lifetime. It is never re-read at runtime. */
  readonly enabled?: boolean;
  readonly sessions?: FilePlaybackProductRuntimeSessionAdapter;
  readonly createController?: (
    input: Readonly<FilePlaybackProductRuntimeControllerFactoryInput>,
  ) => FilePlaybackApplicationController;
  readonly nowMonotonicMs?: () => number;
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
  #sessions: FilePlaybackProductRuntimeSessionAdapter | null = null;
  #controller: FilePlaybackApplicationController | null = null;
  #state: RuntimeState = 'idle';
  #failure: Error | null = null;
  #roomActive = false;

  constructor(options: FilePlaybackProductRuntimeOptions = {}) {
    if (
      typeof options !== 'object' ||
      options === null ||
      (options.enabled !== undefined && typeof options.enabled !== 'boolean') ||
      (options.createController !== undefined && typeof options.createController !== 'function') ||
      (options.nowMonotonicMs !== undefined && typeof options.nowMonotonicMs !== 'function')
    ) {
      throw new TypeError('File playback product runtime options are invalid');
    }
    if (options.sessions !== undefined) assertSessionAdapter(options.sessions);
    this.#enabled = options.enabled ?? DEFAULT_ENABLED;
    this.#providedSessions = options.sessions ?? null;
    this.#createController = options.createController ?? defaultControllerFactory;
    this.#nowMonotonicMs = options.nowMonotonicMs ?? defaultMonotonicNow;
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

  beginHostRoom(hostParticipantId: string): boolean {
    if (!this.#enabled) return false;
    const { controller, sessions } = this.#requireReady();
    this.#assertCanBeginRoom();
    if (typeof hostParticipantId !== 'string' || hostParticipantId.length === 0) {
      throw new TypeError('Host participant ID is invalid');
    }

    try {
      sessions.beginHostRoom(hostParticipantId);
      const anchor = requireAnchor(sessions.nowRoomTimeMs(), 'Host room playback anchor');
      controller.beginRoom(createStoppedPlaybackTimeline(anchor, 0));
      controller.claimRoomRole('host');
      this.#roomActive = true;
      return true;
    } catch (cause) {
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
    if (!this.#roomActive) return;

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
    }
    if (failed) throw failure;
  }

  handleWake(connection?: DataConnection): boolean {
    if (!this.#enabled || this.#state !== 'ready' || !this.#sessions) return false;
    return this.#sessions.handleWake(connection);
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
