/**
 * Playback ownership view and narrow write helpers.
 *
 * Playback state consumption contract:
 *
 *   isAppState<X>()  - strict appState comparison. Use when callers care
 *                      only about the discrete `appState` enum value at
 *                      decision time (click handlers, timers, protocol
 *                      payload choices).
 *   is<X>Owner()     - broad ownership semantic from getPlaybackOwnership().
 *                      Includes domain-specific signals (file lifecycle/
 *                      transfer activity for 'file'; placeholder/isReceiving
 *                      for 'system-audio'). Use for cross-mode safety gates.
 *   UI displays      - subscribe to `state:appState` and render from the
 *                      pushed value. Click handlers may still poll; labels,
 *                      icons, and badges should be reactive.
 *
 * The two coincide for YouTube (there is no pending state) but diverge for
 * file and system-audio. `owner` and `mode` may also intentionally diverge:
 * PAUSED has no active owner, but still derives `mode: 'file'` as the legacy
 * file-playback pause shadow. Pick the semantic that matches your check.
 *
 * Write helpers are intentionally small: they only encode ownership claims/
 * releases, and callers still perform media-engine setup/teardown themselves.
 */

import {
  APP_STATE,
  PLAYBACK_STATE,
  TRANSFER_STATE,
  type AppStateValue,
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
  appState: AppStateValue;
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
   * `pending: true` skips the appState change but still updates currentTrackMeta
   * (when provided). Used for the system-audio guest placeholder: the host has
   * signalled SYSTEM_AUDIO_START but the WebRTC stream hasn't fired yet, so
   * appState stays at its prior value while the placeholder meta marks the
   * pending ownership.
   */
  pending?: boolean;
}

export interface PlaybackReleaseOptions {
  currentTrackMeta?: TrackMeta | null;
  nextAppState?: AppStateValue;
  force?: boolean;
}

const OWNER_APP_STATE: Record<Exclude<PlaybackOwner, 'none'>, AppStateValue> = {
  file: APP_STATE.PLAYING_AUDIO,
  youtube: APP_STATE.PLAYING_YOUTUBE,
  'system-audio': APP_STATE.PLAYING_SYSTEM_AUDIO,
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

// Phase 5 migration boundary. No production callers yet by design; this
// adapter lets future refactors consume mode/activity before the global state
// tree is split. See docs/state-patterns.md.
function deriveModeActivity(ownership: {
  owner: PlaybackOwner;
  appState: AppStateValue;
  lifecycle: PlaybackStateValue;
  isReceivingSystemAudio: boolean;
  hasFilePipeline: boolean;
}): PlaybackModeActivity {
  if (ownership.owner === 'system-audio') {
    return {
      mode: 'system-audio',
      activity:
        ownership.appState === APP_STATE.PLAYING_SYSTEM_AUDIO || ownership.isReceivingSystemAudio
          ? 'playing'
          : 'pending',
    };
  }

  if (ownership.owner === 'youtube') {
    return { mode: 'youtube', activity: 'playing' };
  }

  // YouTube pause is represented by YouTube's own player state, not APP_STATE.PAUSED.
  // In this legacy appState model, PAUSED means the local-file pipeline is paused.
  if (ownership.appState === APP_STATE.PAUSED || ownership.lifecycle === PLAYBACK_STATE.PAUSED) {
    return { mode: 'file', activity: 'paused' };
  }

  if (ownership.owner === 'file') {
    if (
      ownership.appState === APP_STATE.PLAYING_AUDIO ||
      ownership.lifecycle === PLAYBACK_STATE.PLAYING
    ) {
      return { mode: 'file', activity: 'playing' };
    }

    if (ownership.hasFilePipeline) {
      return { mode: 'file', activity: 'pending' };
    }
  }

  return { mode: null, activity: 'idle' };
}

// Read: full ownership view

export function getPlaybackOwnership(): PlaybackOwnership {
  const appState = getState('appState');
  const lifecycle = getState('playback.lifecycle');
  const transferState = getState('transfer.state');
  const currentTrackMeta = getState('player.currentTrackMeta') as TrackMeta | null;
  const isReceivingSystemAudio = getState('systemAudio.isReceiving');
  const isSystemAudioPlaceholder = isSystemAudioPlaceholderMeta(currentTrackMeta);
  const filePipeline = hasFilePipeline(lifecycle, transferState);

  let owner: PlaybackOwner = 'none';
  if (
    appState === APP_STATE.PLAYING_SYSTEM_AUDIO ||
    isReceivingSystemAudio ||
    isSystemAudioPlaceholder
  ) {
    owner = 'system-audio';
  } else if (appState === APP_STATE.PLAYING_YOUTUBE) {
    owner = 'youtube';
  } else if (appState === APP_STATE.PLAYING_AUDIO || filePipeline) {
    owner = 'file';
  }

  const modeActivity = deriveModeActivity({
    owner,
    appState,
    lifecycle,
    isReceivingSystemAudio,
    hasFilePipeline: filePipeline,
  });

  return {
    owner,
    mode: modeActivity.mode,
    activity: modeActivity.activity,
    appState,
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

export function getPlaybackModeActivitySnapshot(): PlaybackModeActivity {
  return {
    mode: getState('playback.mode'),
    activity: getState('playback.activity'),
  };
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
  writePlaybackModeActivity({ mode: ownership.mode, activity: ownership.activity });
  assertPlaybackModeActivitySynced(ownership);
  return ownership;
}

// Shadow-slot bridge for Phase 5. Until readers move fully to mode/activity,
// legacy source events remain the canonical triggers for keeping the new slots fresh.
for (const event of [
  'state:appState',
  'state:playback.lifecycle',
  'state:transfer.state',
  'state:player.currentTrackMeta',
  'state:systemAudio.isReceiving',
] as const) {
  bus.on(event, () => {
    syncPlaybackModeActivityFromOwnership();
  });
}

// Read: appState-strict predicates

export function isAppStateIdle(): boolean {
  return getState('appState') === APP_STATE.IDLE;
}

export function isAppStatePaused(): boolean {
  return getState('appState') === APP_STATE.PAUSED;
}

export function isAppStatePlayingAudio(): boolean {
  return getState('appState') === APP_STATE.PLAYING_AUDIO;
}

export function isAppStatePlayingYouTube(): boolean {
  return getState('appState') === APP_STATE.PLAYING_YOUTUBE;
}

export function isAppStatePlayingSystemAudio(): boolean {
  return getState('appState') === APP_STATE.PLAYING_SYSTEM_AUDIO;
}

export function isAppStateIdleOrPaused(): boolean {
  const appState = getState('appState');
  return appState === APP_STATE.IDLE || appState === APP_STATE.PAUSED;
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

export function isPlaybackPlayingFile(): boolean {
  const playback = getPlaybackModeActivitySnapshot();
  return playback.mode === 'file' && playback.activity === 'playing';
}

export function isPlaybackPlayingYouTube(): boolean {
  const playback = getPlaybackModeActivitySnapshot();
  return playback.mode === 'youtube' && playback.activity === 'playing';
}

export function isPlaybackPlayingSystemAudio(): boolean {
  const playback = getPlaybackModeActivitySnapshot();
  return playback.mode === 'system-audio' && playback.activity === 'playing';
}

// Read: owner predicates (broad semantic)

export function isFileOwner(): boolean {
  return getPlaybackOwnership().owner === 'file';
}

export function isYouTubeOwner(): boolean {
  return getPlaybackOwnership().owner === 'youtube';
}

export function isSystemAudioOwner(): boolean {
  return getPlaybackOwnership().owner === 'system-audio';
}

export function isExternalOwner(): boolean {
  return getPlaybackOwnership().isExternalOwner;
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

export function claimPlaybackOwner(
  owner: Exclude<PlaybackOwner, 'none'>,
  options: PlaybackClaimOptions = {},
): PlaybackOwnership {
  if (!options.pending) {
    setState('appState', OWNER_APP_STATE[owner]);
  }
  if ('currentTrackMeta' in options) {
    setState('player.currentTrackMeta', options.currentTrackMeta ?? null);
  }
  return syncPlaybackModeActivityFromOwnership();
}

export function setPlaybackAppState(appState: AppStateValue): PlaybackOwnership {
  setState('appState', appState);
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
  setState('appState', options.nextAppState ?? APP_STATE.IDLE);
  return syncPlaybackModeActivityFromOwnership();
}
