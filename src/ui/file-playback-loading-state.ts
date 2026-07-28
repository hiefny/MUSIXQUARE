/**
 * Participant-local projection of one V2 file-playback preparation.
 *
 * The engine remains authoritative. This module only owns delayed UI state:
 * a newer exact token supersedes the previous token, stale settlements are
 * ignored, and hard teardown clears everything synchronously.
 */

import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import type { V2FilePlaybackLoadingOwner, V2FilePlaybackLoadingToken } from '../types/index.ts';

export const FILE_PLAYBACK_LOADING_VISUAL_DELAY_MS = 150;
const FILE_PLAYBACK_LOADING_VISUAL_TIMER = 'file-playback-loading-visual-delay';

export type FilePlaybackLoadingOwner = V2FilePlaybackLoadingOwner;
export type FilePlaybackLoadingToken = V2FilePlaybackLoadingToken;

export interface FilePlaybackLoadingSnapshot {
  readonly active: boolean;
  readonly visible: boolean;
  readonly owner: FilePlaybackLoadingOwner | null;
  readonly token: FilePlaybackLoadingToken | null;
}

type FilePlaybackLoadingListener = (snapshot: Readonly<FilePlaybackLoadingSnapshot>) => void;

interface ActiveFilePlaybackLoading {
  readonly owner: FilePlaybackLoadingOwner;
  readonly token: FilePlaybackLoadingToken;
  readonly epoch: number;
  visible: boolean;
}

const listeners = new Set<FilePlaybackLoadingListener>();
const EMPTY_SNAPSHOT: Readonly<FilePlaybackLoadingSnapshot> = Object.freeze({
  active: false,
  visible: false,
  owner: null,
  token: null,
});

let active: ActiveFilePlaybackLoading | null = null;
let visualDelayScheduled = false;
let epoch = 0;

function snapshot(): Readonly<FilePlaybackLoadingSnapshot> {
  if (!active) return EMPTY_SNAPSHOT;
  return Object.freeze({
    active: true,
    visible: active.visible,
    owner: active.owner,
    token: active.token,
  });
}

function publish(): void {
  const next = snapshot();
  for (const listener of [...listeners]) listener(next);
}

function clearVisualDelayTimer(): void {
  if (!visualDelayScheduled) return;
  clearManagedTimer(FILE_PLAYBACK_LOADING_VISUAL_TIMER);
  visualDelayScheduled = false;
}

function isExact(
  candidate: ActiveFilePlaybackLoading | null,
  owner: FilePlaybackLoadingOwner,
  token: FilePlaybackLoadingToken,
): candidate is ActiveFilePlaybackLoading {
  return !!candidate && candidate.owner === owner && Object.is(candidate.token, token);
}

export function beginFilePlaybackLoading(
  owner: FilePlaybackLoadingOwner,
  token: FilePlaybackLoadingToken,
): void {
  if (typeof token !== 'string' && typeof token !== 'number') {
    throw new TypeError('File playback loading token must be a string or number');
  }
  if (typeof token === 'number' && !Number.isFinite(token)) {
    throw new TypeError('File playback loading token must be finite');
  }
  if (typeof token === 'string' && token.length === 0) {
    throw new TypeError('File playback loading token must not be empty');
  }
  if (isExact(active, owner, token)) return;

  clearVisualDelayTimer();
  epoch += 1;
  const admitted: ActiveFilePlaybackLoading = {
    owner,
    token,
    epoch,
    visible: false,
  };
  active = admitted;
  publish();

  visualDelayScheduled = true;
  setManagedTimer(
    FILE_PLAYBACK_LOADING_VISUAL_TIMER,
    () => {
      visualDelayScheduled = false;
      if (active !== admitted || active.epoch !== admitted.epoch || active.visible) return;
      active.visible = true;
      publish();
    },
    FILE_PLAYBACK_LOADING_VISUAL_DELAY_MS,
  );
}

export function settleFilePlaybackLoading(
  owner: FilePlaybackLoadingOwner,
  token: FilePlaybackLoadingToken,
): boolean {
  if (!isExact(active, owner, token)) return false;
  clearFilePlaybackLoading();
  return true;
}

/** Hard teardown for stop, room leave, re-initialization, and fatal recovery. */
export function clearFilePlaybackLoading(): void {
  clearVisualDelayTimer();
  if (!active) return;
  active = null;
  epoch += 1;
  publish();
}

export function getFilePlaybackLoadingSnapshot(): Readonly<FilePlaybackLoadingSnapshot> {
  return snapshot();
}

export function subscribeFilePlaybackLoading(listener: FilePlaybackLoadingListener): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => listeners.delete(listener);
}
