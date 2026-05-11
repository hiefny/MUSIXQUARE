/**
 * Playback ownership view and narrow write helpers.
 *
 * The read side centralizes the answer to "who owns playback right now?"
 * while the legacy state still lives across appState, currentTrackMeta,
 * playback.lifecycle, transfer.state, and media-specific slices. The write
 * helpers are intentionally small: they only encode ownership claims/releases,
 * and callers still perform media-engine setup/teardown themselves.
 */

import {
  APP_STATE,
  PLAYBACK_STATE,
  TRANSFER_STATE,
  type AppStateValue,
  type PlaybackStateValue,
  type TransferStateValue,
} from '../core/constants.ts';
import { getState, setState } from '../core/state.ts';
import type { TrackMeta } from '../types/index.ts';

export type PlaybackOwner = 'none' | 'file' | 'youtube' | 'system-audio';

export interface PlaybackOwnership {
  owner: PlaybackOwner;
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
}

export interface PlaybackReleaseOptions extends PlaybackClaimOptions {
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

  return {
    owner,
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

export function isSystemAudioSessionActive(): boolean {
  return getPlaybackOwnership().owner === 'system-audio';
}

export function isFilePlaybackBlockedByExternalMode(): boolean {
  return getPlaybackOwnership().isExternalOwner;
}

export function canStartFilePlayback(): boolean {
  return !isFilePlaybackBlockedByExternalMode();
}

export function setPlaybackTrackMeta(currentTrackMeta: TrackMeta | null): PlaybackOwnership {
  setState('player.currentTrackMeta', currentTrackMeta);
  return getPlaybackOwnership();
}

export function claimPlaybackOwner(
  owner: Exclude<PlaybackOwner, 'none'>,
  options: PlaybackClaimOptions = {},
): PlaybackOwnership {
  setState('appState', OWNER_APP_STATE[owner]);
  if ('currentTrackMeta' in options) {
    setState('player.currentTrackMeta', options.currentTrackMeta ?? null);
  }
  return getPlaybackOwnership();
}

export function setPlaybackAppState(appState: AppStateValue): PlaybackOwnership {
  switch (appState) {
    case APP_STATE.PLAYING_AUDIO:
      return claimPlaybackOwner('file');
    case APP_STATE.PLAYING_YOUTUBE:
      return claimPlaybackOwner('youtube');
    case APP_STATE.PLAYING_SYSTEM_AUDIO:
      return claimPlaybackOwner('system-audio');
    default:
      setState('appState', appState);
      return getPlaybackOwnership();
  }
}

export function claimPendingSystemAudioPlayback(
  currentTrackMeta = createSystemAudioTrackMeta('receiving'),
): PlaybackOwnership {
  return setPlaybackTrackMeta(currentTrackMeta);
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
  return getPlaybackOwnership();
}
