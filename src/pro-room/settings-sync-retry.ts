import { ProRoomApiError } from './api.ts';

const SETTINGS_SYNC_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;
const SETTINGS_SYNC_RETRY_MAX_DELAY_MS = 5 * 60_000;

export interface SettingsSyncCheckpointToken {
  revision: number;
  fullPublishIntent: number;
}

/** Retry only failures that may succeed without changing room authority. */
export function isTransientSettingsSyncFailure(error: unknown): boolean {
  if (!(error instanceof ProRoomApiError)) return false;
  if (error.code === 'NETWORK_ERROR' || error.code === 'PRO_ROOM_REQUEST_TIMEOUT') return true;
  if (error.code === 'INVALID_RESPONSE' && error.status >= 200 && error.status < 300) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

/**
 * Tracks local intent independently from transport attempts. A response-loss
 * retry cannot consume either ordinary dirty state or an explicit full-state
 * takeover until a matching request is reconciled as successful.
 */
export class SettingsSyncCheckpointState {
  #dirty = false;
  #revision = 0;
  #retryAttempt = 0;
  #fullPublishIntentSequence = 0;
  #pendingFullPublishIntent = 0;

  get dirty(): boolean {
    return this.#dirty;
  }

  get revision(): number {
    return this.#revision;
  }

  get pendingFullPublishIntent(): number {
    return this.#pendingFullPublishIntent;
  }

  markDirty(): void {
    this.#dirty = true;
    this.#revision += 1;
    this.#retryAttempt = 0;
  }

  beginFullPublishIntent(): number {
    this.#fullPublishIntentSequence += 1;
    this.#pendingFullPublishIntent = this.#fullPublishIntentSequence;
    return this.#pendingFullPublishIntent;
  }

  begin(): SettingsSyncCheckpointToken | null {
    if (!this.#dirty) return null;
    return {
      revision: this.#revision,
      fullPublishIntent: this.#pendingFullPublishIntent,
    };
  }

  nextRetryDelay(token: SettingsSyncCheckpointToken, minimumDelayMs = 0): number | null {
    if (!this.#dirty || token.revision !== this.#revision) return null;
    const index = Math.min(this.#retryAttempt, SETTINGS_SYNC_RETRY_DELAYS_MS.length - 1);
    const backoff = SETTINGS_SYNC_RETRY_DELAYS_MS[index] ?? 10_000;
    this.#retryAttempt = Math.min(this.#retryAttempt + 1, SETTINGS_SYNC_RETRY_DELAYS_MS.length);
    return Math.min(
      SETTINGS_SYNC_RETRY_MAX_DELAY_MS,
      Math.max(backoff, Math.max(0, minimumDelayMs)),
    );
  }

  succeed(token: SettingsSyncCheckpointToken): void {
    if (
      token.fullPublishIntent !== 0 &&
      this.#pendingFullPublishIntent === token.fullPublishIntent
    ) {
      this.#pendingFullPublishIntent = 0;
    }
    this.#retryAttempt = 0;
    if (token.revision === this.#revision) this.#dirty = false;
  }

  clearFullPublishIntent(token: SettingsSyncCheckpointToken): void {
    if (
      token.fullPublishIntent !== 0 &&
      this.#pendingFullPublishIntent === token.fullPublishIntent
    ) {
      this.#pendingFullPublishIntent = 0;
    }
  }

  cancel(): void {
    this.#dirty = false;
    this.#revision += 1;
    this.#retryAttempt = 0;
    this.#pendingFullPublishIntent = 0;
  }
}
