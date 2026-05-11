import { beforeEach, describe, expect, it } from 'vitest';
import { APP_STATE, PLAYBACK_STATE, TRANSFER_STATE } from '../../core/constants.ts';
import { resetState, setState } from '../../core/state.ts';
import {
  canStartFilePlayback,
  getPlaybackOwnership,
  isFilePlaybackBlockedByExternalMode,
  isSystemAudioPlaceholderMeta,
  isSystemAudioSessionActive,
} from '../ownership.ts';

beforeEach(() => {
  resetState();
});

describe('playback ownership view', () => {
  it('defaults to no owner', () => {
    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'none',
      hasFilePipeline: false,
      isExternalOwner: false,
    });
  });

  it('treats YouTube as an external owner', () => {
    setState('appState', APP_STATE.PLAYING_YOUTUBE);

    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'youtube',
      isExternalOwner: true,
    });
    expect(isFilePlaybackBlockedByExternalMode()).toBe(true);
    expect(canStartFilePlayback()).toBe(false);
  });

  it('treats system audio app state as an external owner', () => {
    setState('appState', APP_STATE.PLAYING_SYSTEM_AUDIO);

    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'system-audio',
      isExternalOwner: true,
    });
    expect(isSystemAudioSessionActive()).toBe(true);
  });

  it('treats the guest system-audio placeholder as ownership', () => {
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'system-audio-receiving',
      systemAudioPlaceholder: true,
    });

    expect(isSystemAudioPlaceholderMeta(getPlaybackOwnership().currentTrackMeta)).toBe(true);
    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'system-audio',
      isSystemAudioPlaceholder: true,
      isExternalOwner: true,
    });
  });

  it('treats active file lifecycle or transfer work as file ownership', () => {
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'file',
      hasFilePipeline: true,
      isExternalOwner: false,
    });

    resetState();
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'file',
      hasFilePipeline: true,
      isExternalOwner: false,
    });
  });
});
