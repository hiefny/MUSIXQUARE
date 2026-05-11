/**
 * Playback ownership view and narrow write helpers.
 *
 * Playback state consumption contract:
 *
 *   mode/activity    - primary playback contract. Use the playback mode and
 *                      activity helpers when callers ask what is active or
 *                      which playback surface owns the UI/engine.
 *   IDLE compat      - narrow compatibility predicate for callers that must
 *                      preserve the old enum's exact `IDLE` behavior.
 *   is<X>Owner()     - broad ownership semantic from getPlaybackOwnership().
 *                      Includes domain-specific signals (file lifecycle/
 *                      transfer activity for 'file'; placeholder/isReceiving
 *                      for 'system-audio'). Use for cross-mode safety gates.
 *   UI displays      - subscribe to `state:playback.mode` /
 *                      `state:playback.activity` and render from the pushed
 *                      value. Click handlers may still poll; labels, icons,
 *                      and badges should be reactive.
 *
 * The two coincide for YouTube (there is no pending state) but diverge for
 * file and system-audio. `owner` and `mode` may also intentionally diverge:
 * Paused local-file playback has no active owner, but still records
 * `mode: 'file'`. Pick the semantic that matches your check.
 *
 * Write helpers are intentionally small: they only encode ownership claims/
 * releases, and callers still perform media-engine setup/teardown themselves.
 */

import {
  PLAYBACK_STATE,
  TRANSFER_STATE,
  type PlaybackActivityValue,
  type PlaybackModeValue,
  type PlaybackStateValue,
  type TransferStateValue,
} from '../core/constants.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import type { TrackMeta } from '../types/index.ts';

export type PlaybackOwner = 'none' | 'file' | 'youtube' | 'system-audio';
export type PlaybackMode = PlaybackModeValue;
export type PlaybackActivity = PlaybackActivityValue;

export interface PlaybackModeActivity {
  mode: PlaybackMode;
  activity: PlaybackActivity;
}

export interface PlaybackOwnership {
  owner: PlaybackOwner;
  mode: PlaybackMode;
  activity: PlaybackActivity;
  lifecycle: PlaybackStateValue;
  transferState: TransferStateValue;
  currentTrackMeta: TrackMeta | null;
  isSystemAudioPlaceholder: boolean;
  isReceivingSystemAudio: boolean;
  hasFilePipeline: boolean;
  isExternalOwner: boolean;
}

export interface PlaybackClaimOptions {
  currentTrackMeta?: TrackMeta | null;
  /**
   * `pending: true` skips the direct mode/activity claim but still updates
   * currentTrackMeta (when provided). Used for the system-audio guest
   * placeholder: the host has signalled SYSTEM_AUDIO_START but the WebRTC
   * stream hasn't fired yet, so placeholder meta marks pending ownership until
   * the stream arrives.
   */
  pending?: boolean;
}

export interface PlaybackReleaseOptions {
  currentTrackMeta?: TrackMeta | null;
  force?: boolean;
}

export function isPlaybackModeValue(value: unknown): value is PlaybackModeValue {
  return value === null || value === 'file' || value === 'youtube' || value === 'system-audio';
}

export function isPlaybackActivityValue(value: unknown): value is PlaybackActivityValue {
  return value === 'idle' || value === 'paused' || value === 'playing' || value === 'pending';
}

const OWNER_MODE_ACTIVITY: Record<Exclude<PlaybackOwner, 'none'>, PlaybackModeActivity> = {
  file: { mode: 'file', activity: 'playing' },
  youtube: { mode: 'youtube', activity: 'playing' },
  'system-audio': { mode: 'system-audio', activity: 'playing' },
};

export function isSystemAudioPlaceholderMeta(meta: TrackMeta | null): boolean {
  return meta?.systemAudioPlaceholder === true;
}

function titleFromFileName(name: string): string {
  return name.replace(/\.[^/.]+$/, '') || name;
}

export function createFileTrackMeta(name: string, title = titleFromFileName(name)): TrackMeta {
  return {
    type: 'file',
    title,
    name,
    videoId: null,
    playlistId: null,
  };
}

export function createYouTubeTrackMeta({
  name = '',
  title = name,
  videoId = null,
  playlistId = null,
}: {
  name?: string;
  title?: string;
  videoId?: string | null;
  playlistId?: string | null;
}): TrackMeta {
  return {
    type: 'youtube',
    name,
    title,
    videoId,
    playlistId,
  };
}

export function createSystemAudioTrackMeta(
  mode: 'sharing' | 'receiving',
  title?: string,
): TrackMeta {
  if (mode === 'receiving') {
    return {
      type: 'file',
      name: 'system-audio-receiving',
      title: title || 'Receiving System Audio',
      systemAudioPlaceholder: true,
    };
  }

  return {
    type: 'file',
    name: 'system-audio',
    title: title || 'System Audio Sharing',
  };
}

function hasFilePipeline(lifecycle: PlaybackStateValue, transferState: TransferStateValue): boolean {
  return lifecycle !== PLAYBACK_STATE.IDLE || transferState !== TRANSFER_STATE.IDLE;
}

// Reconcile the primary mode/activity slots with derived ownership signals
// that still live outside the two-axis playback state.
function deriveModeActivityFromSources(sources: {
  mode: PlaybackMode;
  activity: PlaybackActivity;
  lifecycle: PlaybackStateValue;
  isReceivingSystemAudio: boolean;
  isSystemAudioPlaceholder: boolean;
  hasFilePipeline: boolean;
}): PlaybackModeActivity {
  if (
    sources.mode === 'system-audio' ||
    sources.isReceivingSystemAudio ||
    sources.isSystemAudioPlaceholder
  ) {
    return {
      mode: 'system-audio',
      activity:
        sources.activity === 'playing' || sources.isReceivingSystemAudio ? 'playing' : 'pending',
    };
  }

  if (sources.mode === 'youtube') {
    return {
      mode: 'youtube',
      activity:
        sources.activity === 'idle' || sources.activity === 'pending'
          ? 'playing'
          : sources.activity,
    };
  }

  if (sources.mode === 'file' || sources.hasFilePipeline) {
    if (
      sources.activity === 'playing' ||
      (sources.mode === 'file' && sources.lifecycle === PLAYBACK_STATE.PLAYING)
    ) {
      return OWNER_MODE_ACTIVITY.file;
    }

    if (sources.activity === 'paused' || sources.lifecycle === PLAYBACK_STATE.PAUSED) {
      return { mode: 'file', activity: 'paused' };
    }

    if (sources.activity === 'pending' || sources.hasFilePipeline) {
      return { mode: 'file', activity: 'pending' };
    }

    return { mode: 'file', activity: 'idle' };
  }

  return { mode: null, activity: 'idle' };
}

// Read: full ownership view

export function getPlaybackOwnership(): PlaybackOwnership {
  const storedMode = getState('playback.mode');
  const storedActivity = getState('playback.activity');
  const lifecycle = getState('playback.lifecycle');
  const transferState = getState('transfer.state');
  const currentTrackMeta = getState('player.currentTrackMeta') as TrackMeta | null;
  const isReceivingSystemAudio = getState('systemAudio.isReceiving');
  const isSystemAudioPlaceholder = isSystemAudioPlaceholderMeta(currentTrackMeta);
  const filePipeline = hasFilePipeline(lifecycle, transferState);

  const modeActivity = deriveModeActivityFromSources({
    mode: storedMode,
    activity: storedActivity,
    lifecycle,
    isReceivingSystemAudio,
    isSystemAudioPlaceholder,
    hasFilePipeline: filePipeline,
  });
  let owner: PlaybackOwner = 'none';
  if (modeActivity.mode === 'system-audio' && modeActivity.activity !== 'idle') {
    owner = 'system-audio';
  } else if (modeActivity.mode === 'youtube' && modeActivity.activity !== 'idle') {
    owner = 'youtube';
  } else if (
    modeActivity.mode === 'file' &&
    (modeActivity.activity === 'playing' || modeActivity.activity === 'pending')
  ) {
    owner = 'file';
  }

  return {
    owner,
    mode: modeActivity.mode,
    activity: modeActivity.activity,
    lifecycle,
    transferState,
    currentTrackMeta,
    isSystemAudioPlaceholder,
    isReceivingSystemAudio,
    hasFilePipeline: filePipeline,
    isExternalOwner: owner === 'youtube' || owner === 'system-audio',
  };
}

export function getPlaybackModeActivity(): PlaybackModeActivity {
  const ownership = getPlaybackOwnership();
  return {
    mode: ownership.mode,
    activity: ownership.activity,
  };
}

export function isPlaybackIdleCompatModeActivity(playback: PlaybackModeActivity): boolean {
  return (
    playback.activity === 'idle' ||
    playback.mode === null ||
    (playback.mode === 'system-audio' && playback.activity !== 'playing')
  );
}

export function isPlaybackIdleCompat(): boolean {
  return isPlaybackIdleCompatModeActivity(getPlaybackModeActivity());
}

export function getPlaybackModeActivitySnapshot(): PlaybackModeActivity {
  return {
    mode: getState('playback.mode'),
    activity: getState('playback.activity'),
  };
}

function getFreshPlaybackModeActivitySnapshot(): PlaybackModeActivity {
  const snapshot = getPlaybackModeActivitySnapshot();
  const ownership = getPlaybackOwnership();
  if (snapshot.mode === ownership.mode && snapshot.activity === ownership.activity) {
    return snapshot;
  }

  // Transitional safety for test/bootstrap paths that still mutate source
  // fields directly or clear the bus bridge before setting them.
  writePlaybackModeActivity({ mode: ownership.mode, activity: ownership.activity });
  assertPlaybackModeActivitySynced(ownership);
  return { mode: ownership.mode, activity: ownership.activity };
}

function writePlaybackModeActivity(modeActivity: PlaybackModeActivity): void {
  setState('playback.mode', modeActivity.mode);
  setState('playback.activity', modeActivity.activity);
}

function assertPlaybackModeActivitySynced(expected: PlaybackModeActivity): void {
  if (!import.meta.env?.DEV) return;

  const actualMode = getState('playback.mode');
  const actualActivity = getState('playback.activity');
  if (actualMode !== expected.mode || actualActivity !== expected.activity) {
    throw new Error(
      `Playback mode/activity drift: expected ${expected.mode ?? 'null'}/${expected.activity}, ` +
        `got ${actualMode ?? 'null'}/${actualActivity}`,
    );
  }
}

export function syncPlaybackModeActivityFromOwnership(): PlaybackOwnership {
  const ownership = getPlaybackOwnership();
  const modeActivity = { mode: ownership.mode, activity: ownership.activity };
  writePlaybackModeActivity(modeActivity);

  const syncedOwnership = getPlaybackOwnership();
  assertPlaybackModeActivitySynced(syncedOwnership);
  return syncedOwnership;
}

export function setPlaybackLifecycleState(lifecycle: PlaybackStateValue): PlaybackOwnership {
  setState('playback.lifecycle', lifecycle);
  return syncPlaybackModeActivityFromOwnership();
}

export function setPlaybackTransferState(transferState: TransferStateValue): PlaybackOwnership {
  setState('transfer.state', transferState);
  return syncPlaybackModeActivityFromOwnership();
}

export function setSystemAudioReceiving(isReceiving: boolean): PlaybackOwnership {
  setState('systemAudio.isReceiving', isReceiving);
  return syncPlaybackModeActivityFromOwnership();
}

// Domain source events keep mode/activity fresh when setup/test paths write
// lifecycle or metadata directly.
for (const event of [
  'state:playback.lifecycle',
  'state:transfer.state',
  'state:player.currentTrackMeta',
  'state:systemAudio.isReceiving',
] as const) {
  bus.on(event, () => {
    syncPlaybackModeActivityFromOwnership();
  });
}

// Read: mode/activity predicates (new decomposed playback contract)

export function isPlaybackModeFile(): boolean {
  return getState('playback.mode') === 'file';
}

export function isPlaybackModeYouTube(): boolean {
  return getState('playback.mode') === 'youtube';
}

export function isPlaybackModeSystemAudio(): boolean {
  return getState('playback.mode') === 'system-audio';
}

export function isPlaybackIdle(): boolean {
  return getState('playback.activity') === 'idle';
}

export function isPlaybackPaused(): boolean {
  return getState('playback.activity') === 'paused';
}

export function isPlaybackPending(): boolean {
  return getState('playback.activity') === 'pending';
}

export function isPlaybackPlaying(): boolean {
  return getState('playback.activity') === 'playing';
}

export function isPlaybackPlayingFile(
  playback: PlaybackModeActivity = getPlaybackModeActivitySnapshot(),
): boolean {
  return playback.mode === 'file' && playback.activity === 'playing';
}

export function isPlaybackPlayingYouTube(
  playback: PlaybackModeActivity = getPlaybackModeActivitySnapshot(),
): boolean {
  return playback.mode === 'youtube' && playback.activity === 'playing';
}

export function isPlaybackPlayingSystemAudio(
  playback: PlaybackModeActivity = getPlaybackModeActivitySnapshot(),
): boolean {
  return playback.mode === 'system-audio' && playback.activity === 'playing';
}

export function isPlaybackPendingFile(
  playback: PlaybackModeActivity = getPlaybackModeActivitySnapshot(),
): boolean {
  return playback.mode === 'file' && playback.activity === 'pending';
}

export function isPlaybackPausedOrPendingFile(
  playback: PlaybackModeActivity = getPlaybackModeActivitySnapshot(),
): boolean {
  return (
    playback.mode === 'file' &&
    (playback.activity === 'paused' || playback.activity === 'pending')
  );
}

export function isPlaybackNonIdleFile(
  playback: PlaybackModeActivity = getPlaybackModeActivitySnapshot(),
): boolean {
  return playback.mode === 'file' && playback.activity !== 'idle';
}

export function isPlaybackActiveYouTube(
  playback: PlaybackModeActivity = getPlaybackModeActivitySnapshot(),
): boolean {
  return playback.mode === 'youtube' && playback.activity !== 'idle';
}

// Read: owner predicates (broad semantic)

export function isFileOwner(): boolean {
  const playback = getFreshPlaybackModeActivitySnapshot();
  return (
    playback.mode === 'file' &&
    (playback.activity === 'playing' || playback.activity === 'pending')
  );
}

export function isYouTubeOwner(): boolean {
  return getFreshPlaybackModeActivitySnapshot().mode === 'youtube';
}

export function isSystemAudioOwner(): boolean {
  return getFreshPlaybackModeActivitySnapshot().mode === 'system-audio';
}

export function isExternalOwner(): boolean {
  const mode = getFreshPlaybackModeActivitySnapshot().mode;
  return mode === 'youtube' || mode === 'system-audio';
}

// Write: track metadata

export function setPlaybackTrackMeta(currentTrackMeta: TrackMeta | null): PlaybackOwnership {
  setState('player.currentTrackMeta', currentTrackMeta);
  return syncPlaybackModeActivityFromOwnership();
}

export function updatePlaybackTrackMeta(
  updater: (currentTrackMeta: TrackMeta | null) => TrackMeta | null,
): PlaybackOwnership {
  const currentTrackMeta = getState('player.currentTrackMeta') as TrackMeta | null;
  const nextTrackMeta = updater(currentTrackMeta);
  if (nextTrackMeta === currentTrackMeta) return syncPlaybackModeActivityFromOwnership();
  return setPlaybackTrackMeta(nextTrackMeta);
}

export function updatePlaybackTrackTitle(
  title: string,
  fallbackTrackMeta: TrackMeta | null = null,
): PlaybackOwnership {
  return updatePlaybackTrackMeta((currentTrackMeta) => {
    const trackMeta = currentTrackMeta ?? fallbackTrackMeta;
    if (!trackMeta || trackMeta.title === title) return trackMeta;
    return { ...trackMeta, title };
  });
}

// Write: ownership claim/release

function setPlaybackModeActivity(modeActivity: PlaybackModeActivity): PlaybackOwnership {
  writePlaybackModeActivity(modeActivity);
  return syncPlaybackModeActivityFromOwnership();
}

export function setPlaybackIdle(): PlaybackOwnership {
  return setPlaybackModeActivity({ mode: null, activity: 'idle' });
}

export function setPlaybackFilePlaying(): PlaybackOwnership {
  return setPlaybackModeActivity({ mode: 'file', activity: 'playing' });
}

export function setPlaybackFilePaused(): PlaybackOwnership {
  return setPlaybackModeActivity({ mode: 'file', activity: 'paused' });
}

export function setPlaybackYouTubePlaying(): PlaybackOwnership {
  return setPlaybackModeActivity({ mode: 'youtube', activity: 'playing' });
}

export function setPlaybackSystemAudioPlaying(): PlaybackOwnership {
  return setPlaybackModeActivity({ mode: 'system-audio', activity: 'playing' });
}

export function claimPlaybackOwner(
  owner: Exclude<PlaybackOwner, 'none'>,
  options: PlaybackClaimOptions = {},
): PlaybackOwnership {
  if (!options.pending) {
    writePlaybackModeActivity(OWNER_MODE_ACTIVITY[owner]);
  }
  if ('currentTrackMeta' in options) {
    setState('player.currentTrackMeta', options.currentTrackMeta ?? null);
  }
  return syncPlaybackModeActivityFromOwnership();
}

export function releasePlaybackOwner(
  owner: Exclude<PlaybackOwner, 'none'>,
  options: PlaybackReleaseOptions = {},
): PlaybackOwnership {
  const before = getPlaybackOwnership();
  if (before.owner !== owner && !options.force) return before;

  if ('currentTrackMeta' in options) {
    setState('player.currentTrackMeta', options.currentTrackMeta ?? null);
  }
  return setPlaybackModeActivity({ mode: null, activity: 'idle' });
}
