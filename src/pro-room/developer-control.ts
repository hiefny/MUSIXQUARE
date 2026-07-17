import type {
  DeveloperCommandFrame,
  DeveloperCommandResultCode,
} from '../network/transport/types.ts';
import type { ProRoomSnapshot } from './contracts.ts';

const DEFAULT_DEDUPE_CAPACITY = 128;

type ExecutableDeveloperCommandResult = Exclude<
  DeveloperCommandResultCode,
  'already_applied' | 'expired'
>;

interface DeveloperControlDependencies {
  now(): number;
  isActive(): boolean;
  isCoordinator(): boolean;
  snapshot(): ProRoomSnapshot | null;
  /** Pull at most once when a command frame is newer than local checkpoint state. */
  refreshSnapshot(): Promise<ProRoomSnapshot | null>;
  execute(
    command: DeveloperCommandFrame['command'],
    snapshot: ProRoomSnapshot,
  ): Promise<ExecutableDeveloperCommandResult>;
  acknowledge(frame: DeveloperCommandFrame, resultCode: DeveloperCommandResultCode): Promise<void>;
}

interface CompletedCommand {
  fingerprint: string;
  resultCode: DeveloperCommandResultCode;
  expiresAtMs: number;
}

function commandFingerprint(frame: DeveloperCommandFrame): string {
  return JSON.stringify([
    frame.version,
    frame.roomCode,
    frame.coordinatorEpoch,
    frame.expiresAtMs,
    frame.expected.queueItemId,
    frame.expected.playlistRevision,
    frame.expected.playbackRevision,
    frame.command,
  ]);
}

function isFrameCurrent(frame: DeveloperCommandFrame, snapshot: ProRoomSnapshot): boolean {
  if (frame.command.type === 'set_effects') {
    return (
      frame.roomCode === snapshot.roomCode &&
      frame.coordinatorEpoch === snapshot.presence.coordinatorEpoch &&
      frame.coordinatorEpoch === snapshot.playback.coordinatorEpoch
    );
  }
  return (
    frame.roomCode === snapshot.roomCode &&
    frame.coordinatorEpoch === snapshot.presence.coordinatorEpoch &&
    frame.coordinatorEpoch === snapshot.playback.coordinatorEpoch &&
    frame.expected.queueItemId === snapshot.currentQueueItemId &&
    frame.expected.queueItemId === snapshot.playback.queueItemId &&
    frame.expected.playlistRevision === snapshot.playlistRevision &&
    frame.expected.playbackRevision === snapshot.playback.revision
  );
}

function isSnapshotBehindFrame(frame: DeveloperCommandFrame, snapshot: ProRoomSnapshot): boolean {
  if (frame.roomCode !== snapshot.roomCode) return false;
  const presenceEpoch = snapshot.presence.coordinatorEpoch;
  const playbackEpoch = snapshot.playback.coordinatorEpoch;
  if (presenceEpoch > frame.coordinatorEpoch || playbackEpoch > frame.coordinatorEpoch) {
    return false;
  }
  if (frame.command.type === 'set_effects') {
    return presenceEpoch < frame.coordinatorEpoch || playbackEpoch < frame.coordinatorEpoch;
  }
  return (
    presenceEpoch < frame.coordinatorEpoch ||
    playbackEpoch < frame.coordinatorEpoch ||
    snapshot.playlistRevision < frame.expected.playlistRevision ||
    snapshot.playback.revision < frame.expected.playbackRevision
  );
}

/**
 * Serial, coordinator-only command executor. The server is allowed to retry a
 * delivery until it receives an ACK, so side effects are remembered in a
 * small RAM-only cache and never executed twice in one coordinator lifetime.
 */
export class DeveloperControlExecutor {
  readonly #completed = new Map<string, CompletedCommand>();
  readonly #dedupeCapacity: number;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly dependencies: DeveloperControlDependencies,
    options: { dedupeCapacity?: number } = {},
  ) {
    const requested = options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY;
    this.#dedupeCapacity = Number.isSafeInteger(requested) && requested > 0 ? requested : 1;
  }

  handle(frame: DeveloperCommandFrame): Promise<void> {
    const task = this.#tail.then(() => this.#handleSerial(frame));
    this.#tail = task.catch(() => undefined);
    return task;
  }

  reset(): void {
    this.#completed.clear();
  }

  private prune(now: number): void {
    for (const [commandId, completed] of this.#completed) {
      if (completed.expiresAtMs <= now) this.#completed.delete(commandId);
    }
    while (this.#completed.size >= this.#dedupeCapacity) {
      const oldest = this.#completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#completed.delete(oldest);
    }
  }

  private remember(
    frame: DeveloperCommandFrame,
    fingerprint: string,
    resultCode: DeveloperCommandResultCode,
  ): void {
    this.#completed.set(frame.commandId, {
      fingerprint,
      resultCode,
      expiresAtMs: frame.expiresAtMs,
    });
  }

  async #handleSerial(frame: DeveloperCommandFrame): Promise<void> {
    const now = this.dependencies.now();
    this.prune(now);
    const fingerprint = commandFingerprint(frame);
    const completed = this.#completed.get(frame.commandId);
    if (completed) {
      const resultCode: DeveloperCommandResultCode =
        completed.fingerprint !== fingerprint
          ? 'stale_queue'
          : completed.resultCode === 'applied' || completed.resultCode === 'already_applied'
            ? 'already_applied'
            : completed.resultCode;
      await this.dependencies.acknowledge(frame, resultCode);
      return;
    }

    let resultCode: DeveloperCommandResultCode;
    if (frame.expiresAtMs <= now) {
      resultCode = 'expired';
    } else {
      // The signaling socket can attach just before finalizeOpenedRoom marks
      // the runtime active, and an old coordinator socket can outlive an
      // authority handoff briefly. Neither transient is proof of a stale
      // command. Leave it unacknowledged so the server's bounded retry/epoch
      // fence decides, instead of terminally rejecting a valid command.
      if (!this.dependencies.isActive() || !this.dependencies.isCoordinator()) return;
      let snapshot = this.dependencies.snapshot();
      if (!snapshot) return;
      if (isSnapshotBehindFrame(frame, snapshot)) {
        // A checkpoint response and command dispatch can cross in flight. One
        // authoritative pull distinguishes that benign race from a real stale
        // command. A pull failure intentionally escapes without ACK/remember;
        // bounded server redelivery can retry without duplicating side effects.
        snapshot = await this.dependencies.refreshSnapshot();
        if (!snapshot) return;
      }
      if (frame.expiresAtMs <= this.dependencies.now()) {
        resultCode = 'expired';
        this.remember(frame, fingerprint, resultCode);
        await this.dependencies.acknowledge(frame, resultCode);
        return;
      }
      const command = frame.command;
      const targetExists =
        command.type !== 'play_item' ||
        snapshot.playlist.some((item) => item.queueItemId === command.queueItemId) === true;
      if (!isFrameCurrent(frame, snapshot) || !targetExists) {
        resultCode = 'stale_queue';
      } else {
        try {
          resultCode = await this.dependencies.execute(frame.command, snapshot);
        } catch {
          resultCode = 'execution_failed';
        }
      }
    }

    this.remember(frame, fingerprint, resultCode);
    await this.dependencies.acknowledge(frame, resultCode);
  }
}
